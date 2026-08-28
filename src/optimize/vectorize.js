
/**
 * Lane-local SIMD-128 vectorizer.
 *
 *   Recognizes inner loops of shape:
 *     for (let i = 0; i < N; i++) arr[i] = f(arr[i], …)
 *   where every body op is "lane-pure" — its k-th lane output depends only
 *   on k-th lane inputs. Lifts the body to SIMD-128, prefixed before the
 *   original (now tail) loop. Original loop runs the remainder.
 *
 * Design:
 *   • Lane-purity is a structural property, not a benchmark match. The op
 *     whitelist is the single source of truth (one entry per (lane-type, op)).
 *   • Lift is mechanical. The recognizer either matches the structure — in
 *     which case lifting is unambiguous — or skips. No bench-specific
 *     heuristics.
 *   • Tail loop is the original WAT, untouched. If anything regresses the
 *     SIMD recognizer just doesn't match, never miscompiles.
 *
 * Match conditions:
 *   1. (block $brk (loop $L (br_if $brk !cond) BODY (i = i+1) (br $L)))
 *   2. cond is `(i32.lt_s i BOUND)` or `i32.lt_u`; BOUND is loop-invariant.
 *   3. All loads/stores in BODY use address `(add base (shl i K))` where
 *      base is loop-invariant and K matches the elem stride. Optional
 *      enclosing `local.tee` is allowed (and reused).
 *   4. All loads share the same opcode → defines lane type.
 *   5. All other ops in BODY are in the lane-pure whitelist for that type.
 *   6. Each non-induction local in BODY is either purely loop-invariant
 *      (only read) or purely lane-local (first action is a write). Never
 *      both — that's a loop-carried scalar (reduction / stencil) → bail.
 *
 * Lift produces, before the original block:
 *     (local.set $__simd_bound{N} (i32.and BOUND (i32.const ~(LANES-1))))
 *     (block $__simd_brk{N}
 *       (loop $__simd_loop{N}
 *         (br_if $__simd_brk{N} (i32.eqz (i32.lt_s i $__simd_bound{N})))
 *         <body lifted op-by-op; lane-local locals routed to v128 shadows>
 *         (local.set $i (i32.add i (i32.const LANES)))
 *         (br $__simd_loop{N})))
 *
 * The original block runs immediately after with i pre-advanced; its own
 * `i < BOUND` guard handles the tail.
 */




import { findBodyStart, dollar } from '../ir.js'
import { warn, ctx, DBG_INVARIANTS } from '../ctx.js'
import { cloneNode, walkAst } from '../ast.js'
import { constNum, firstAccess, hasGlobalSet, isI32Const, isLocalGet } from './vectorize/addr-model.js'
import { tryChannelReduce } from './vectorize/blur-channel.js'
import { tryDivergentEscapeVectorize } from './vectorize/divergent-escape.js'
import { hoistReductionInvariantsIn, slpPairsIn } from './vectorize/dot-slp.js'
import { LANE_COMPARE, LANE_PURE, LOAD_OPS, PPC_CALL2, STORE_OPS } from './vectorize/lane-tables.js'
import { liftFail, vecState } from './vectorize/lift.js'
import { tryGeneralMap, tryVectorize } from './vectorize/map.js'
import { tryMemCopyFill } from './vectorize/memcpy.js'
import { forEachLocalDef, isArr } from './vectorize/node-utils.js'
import { matchOuterPixelLoop } from './vectorize/outer-scaffold.js'
import { tryOuterStripRest } from './vectorize/outer-strip.js'
import { tryRampMap } from './vectorize/ramp.js'
import { tryGeneralReduce, tryReduce } from './vectorize/reduce.js'
import { canonicalizeIfBr, foldVecIdentities, matchBlockLoop, normalizeTransparentBlocks } from './vectorize/scaffold.js'
import { tryGeneralStencil, tryStencil } from './vectorize/stencil.js'
import { tryStrengthReduceIV } from './vectorize/strength-reduce.js'
export { inlinePureCallExpr, inlinePureFnsInFn } from './vectorize/inline-pure.js'
export { SIMD_PINNED } from './vectorize/lane-tables.js'

const _toneStripTee = (n) => isArr(n) && n[0] === 'local.tee' && n.length === 3 ? n[2] : n

// `(i32.wrap_i64 (i64.trunc_sat_f64_{s,u} X))` or `(i32.trunc_sat_f64_{s,u} X)` — the
// f64→i32 `|0` bridge. Returns { inner, signed } (tee on X stripped) or null.
function matchTruncF64(expr) {
  if (!isArr(expr)) return null
  if (expr[0] === 'i32.wrap_i64' && isArr(expr[1])) {
    const t = expr[1]
    if (t[0] === 'i64.trunc_sat_f64_s') return { inner: _toneStripTee(t[1]), signed: true }
    if (t[0] === 'i64.trunc_sat_f64_u') return { inner: _toneStripTee(t[1]), signed: false }
  }
  if (expr[0] === 'i32.trunc_sat_f64_s') return { inner: _toneStripTee(expr[1]), signed: true }
  if (expr[0] === 'i32.trunc_sat_f64_u') return { inner: _toneStripTee(expr[1]), signed: false }
  return null
}

// The `|0` of a known-finite f64: `(select (trunc X) (i32.const 0) (f64.ne X' ±Inf))`.
// Since the tonemap clamps L into [0,255] before the trunc, the `≠Inf` guard is always
// true, so this lowers to a plain `trunc_sat` — returns the inner f64 to truncate.
function matchInfCanonTone(sel) {
  if (!isArr(sel) || sel[0] !== 'select' || sel.length !== 4) return null
  if (!(isI32Const(sel[2]) && constNum(sel[2]) === 0)) return null
  const c = sel[3]
  if (!(isArr(c) && c[0] === 'f64.ne' && isArr(c[2]) && c[2][0] === 'f64.const' && /inf/i.test(String(c[2][1])))) return null
  const tr = matchTruncF64(sel[1])
  return tr ? tr.inner : null
}

// Loads tryToneMap accepts as the f64-island input. `i32.load` is the original (stride-4, no
// widening). Narrow typed-array reads (Uint8/Int8/Uint16/Int16) are widened to the low two i32x4
// lanes before the f64x2.convert — exactly the F/B/T `dist` term over an 8-bit/16-bit buffer.
// `shift` = the address stride exponent (0/1/2). `over` = extra ELEMENTS the widening load reads
// past its lane pair (u8 reads 4 bytes via load32_zero for 2 lanes) — the SIMD bound is shrunk by
// it so the read never runs off the array; the scalar tail finishes the remainder. The widen step
// signedness matches the load op, so the i32x4 lanes hold the exact scalar value.
const TONE_LOAD = {
  'i32.load':     { shift: 2, widen: null, over: 0 },
  'i32.load8_u':  { shift: 0, widen: ['v128.load32_zero', ['i16x8.extend_low_i8x16_u', 'i32x4.extend_low_i16x8_u']], over: 2 },
  'i32.load8_s':  { shift: 0, widen: ['v128.load32_zero', ['i16x8.extend_low_i8x16_s', 'i32x4.extend_low_i16x8_s']], over: 2 },
  'i32.load16_u': { shift: 1, widen: ['v128.load32_zero', ['i32x4.extend_low_i16x8_u']], over: 0 },
  'i32.load16_s': { shift: 1, widen: ['v128.load32_zero', ['i32x4.extend_low_i16x8_s']], over: 0 },
}

// `base + (i << shift)` (shift 0 ⇒ bare `base + i`) with `base` a loop-invariant array pointer.
// The address shape for a load/store at its element stride: the u32 store uses shift 2 (stride-4 ⇒
// load64_zero/i64.store cover exactly 2 consecutive u32); a narrow load uses its own stride (0/1).
function matchToneAddrShift(addr, ind, shift) {
  if (!isArr(addr) || addr[0] !== 'i32.add' || addr.length !== 3) return null
  const pair = (baseN, offN) => {
    if (!isArr(baseN) || (baseN[0] !== 'local.get' && baseN[0] !== 'global.get')) return null
    if (baseN[0] === 'local.get' && baseN[1] === ind) return null
    if (shift === 0) return isLocalGet(offN, ind) ? baseN : null
    if (isArr(offN) && offN[0] === 'i32.shl' && offN.length === 3 && isLocalGet(offN[1], ind) && constNum(offN[2]) === shift) return baseN
    return null
  }
  return pair(addr[1], addr[2]) || pair(addr[2], addr[1])
}

const _toneUnwrapArm = (arm) => {  // arm = ['then'|'else', ...stmts]; unwrap a single nested block
  let body = arm.slice(1)
  if (body.length === 1 && isArr(body[0]) && body[0][0] === 'block') {
    const b = body[0]; let i = 1
    if (typeof b[i] === 'string' && b[i].startsWith('$')) i++
    if (isArr(b[i]) && b[i][0] === 'result') i++
    body = b.slice(i)
  }
  return body
}

const _toneAppears = (n, name) => {
  let found = false
  walkAst(n, { enter: x => {
    if (found) return false
    if ((x[0] === 'local.get' || x[0] === 'local.set' || x[0] === 'local.tee') && x[1] === name) { found = true; return false }
  } })
  return found
}

// First WRITE of `name`: returns { stmtIdx, nested } (nested = inside an `if`) or null.
function _toneFirstWrite(body, name) {
  for (let i = 0; i < body.length; i++) {
    let found = false, nested = false
    const w = (n, depth) => {
      if (found || !isArr(n)) return
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name) { found = true; nested = depth > 0; return }
      const d = depth + (n[0] === 'if' ? 1 : 0)
      for (let j = 1; j < n.length; j++) w(n[j], d)
    }
    w(body[i], 0)
    if (found) return { stmtIdx: i, nested }
  }
  return null
}

// Mixed-lane log-tonemap: i32 dens[i] → f64 log → i32 pack → px[i]. See the block comment above.
function tryToneMap(bl, fnLocals, freshIdRef, enabled) {
  if (!enabled || !bl) return null
  const { incVar, bound, boundLocal, body, preamble, hasGlobalSet: blHasGlobalSet, writes: blWrites, referenced: blReferenced } = bl
  if (!boundLocal && !isI32Const(bound)) return null   // bound must be loop-invariant

  // Shape gate: exactly one i32.store + ≥1 i32.load, all at `base+(i<<2)`, plus the f64
  // island signature (`f64.convert_i32_*`). Any other-width load/store declines. The
  // f64-convert requirement is what distinguishes this from a plain i32 map (tryVectorize,
  // which runs earlier and already owns those).
  let hasConvert = false, storeCount = 0, loadCount = 0, overread = 0, ok = true
  const inspect = n => {
    if (!ok || !isArr(n)) return false
    const o = n[0]
    if (o === 'f64.convert_i32_s' || o === 'f64.convert_i32_u') hasConvert = true
    if (o === 'i32.store') {
      storeCount++
      if (!matchToneAddrShift(n[1], incVar, 2)) ok = false
      if (ok) walkAst(n[2], { enter: inspect })
      return false
    }
    const ld = TONE_LOAD[o]
    if (ld && n.length === 2) {   // i32 (stride-4) or a narrow typed-array read at its own stride
      loadCount++
      if (!matchToneAddrShift(n[1], incVar, ld.shift)) { ok = false; return false }
      if (ld.over > overread) overread = ld.over
      return false
    }
    if (LOAD_OPS[o] || STORE_OPS[o]) { ok = false; return false }  // any other-width memop → not this shape
  }
  for (const s of body) { walkAst(s, { enter: inspect }); if (!ok) break }
  // 1 store (unconditional, attractors) or 2 (the then/else arms of a conditional store,
  // bifurcation/fern — both write the same pixel and collapse to one masked store).
  if (!ok || !hasConvert || storeCount < 1 || storeCount > 2 || loadCount < 1) return null
  if (blHasGlobalSet) return null

  // Classify locals (mirrors tryVectorize): written ⇒ lane (first access must be a write,
  // else loop-carried), unwritten ⇒ invariant. writes/referenced: plan-level census (bl).
  const writes = blWrites
  if (boundLocal && writes.has(boundLocal)) return null
  const referenced = blReferenced
  const localKind = new Map()
  for (const name of referenced) {
    if (name === incVar) continue
    if (writes.has(name)) {
      let firstKind = null
      for (const s of body) { const k = firstAccess(s, name); if (k) { firstKind = k; break } }
      if (firstKind === 'read') return null   // loop-carried
      localKind.set(name, 'lane')
    } else localKind.set(name, 'invariant')
  }

  // Liveness gate: a lane local first ASSIGNED inside an `if` is set speculatively
  // (unconditionally) — sound only if it never leaks past that statement (else a false
  // lane would read a value scalar never produced). Bail otherwise.
  for (const [name, kind] of localKind) {
    if (kind !== 'lane') continue
    const fw = _toneFirstWrite(body, name)
    if (fw && fw.nested) {
      for (let i = 0; i < body.length; i++) if (i !== fw.stmtIdx && _toneAppears(body[i], name)) return null
    }
  }

  const newLanedLocals = new Map()       // origName → laneName (bare string; see getOrAllocLanedLocal)
  // SAME field set + ORDER as the ctx in tryVectorize / tryReduce / tryRampMap. The
  // self-compile kernel infers ONE struct layout per shared callee, and `liftFail` is shared with
  // liftExprV — so every ctx reaching it MUST have the identical shape, or the inferred layout is
  // wrong for some and field reads corrupt (a narrower ctx shape here previously broke the ENTIRE
  // self-compile vectorizer this way). tryToneMap itself only reads fail/failReason/extraLocals, but
  // the unused fields must still be present, in order.
  const ctx = { laneType: 'f64', incVar, rampVar: null, rampTemp: null, widenLoads: false, localKind, fnLocals: null, newLanedLocals, extraLocals: [], freshIdRef, fail: false, failReason: null }
  const toneSetBefore = new Set()         // lane locals already assigned (conditional-merge gate)
  const laned = (name) => { let ln = newLanedLocals.get(name); if (!ln) { ln = `${name}__v`; newLanedLocals.set(name, ln) } return ln }
  const freshMask = () => { const mt = `$__mask${freshIdRef.next++}`; ctx.extraLocals.push(['local', mt, 'v128']); return mt }

  // The ctx-using lifters are NESTED function declarations that CAPTURE the state above (like
  // scanForLoadsStores) — taking `ctx` as a param instead would make jz's self-compile inference
  // mistype the recursive lifter's `ctx` (the recursive call site can't agree on i32, so it
  // stays boxed f64 and its callers emit a bad i64.reinterpret_f64). Capturing sidesteps that.

  // Result lane width of a value expr ('i32' | 'f64' | 'x') — keeps a conditional's mask the
  // SAME width as the data it selects (a mismatch bails).
  function toneWidth(e) {
    if (!isArr(e)) return 'x'
    const o = e[0]
    if (o === 'f64.const' || o === 'f64.convert_i32_s' || o === 'f64.convert_i32_u' || o === 'call') return 'f64'
    if (o === 'i32.const' || o === 'i32.wrap_i64' || o === 'i32.trunc_sat_f64_s' || o === 'i32.trunc_sat_f64_u') return 'i32'
    if (o === 'local.get') return fnLocals.get(e[1]) === 'f64' ? 'f64' : 'i32'
    if (o === 'select') return toneWidth(e[1])
    if (o === 'if') return isArr(e[1]) && e[1][1] === 'f64' ? 'f64' : 'i32'
    if (o.startsWith('f64.')) return 'f64'
    if (o.startsWith('i32.')) return 'i32'
    return 'x'
  }

  // Lift one value expression to v128. Result lane type comes from the op (f64.* → f64x2,
  // i32.* → i32x4; convert/trunc bridge between them). Bit-exact per lane.
  function liftV(expr) {
    if (!isArr(expr)) return liftFail(ctx, 'tonemap: non-expression operand')
    const op = expr[0]
    if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && expr.length === 2) {
      const inner = expr[1]
      if (isArr(inner) && (inner[0] === 'global.get' || inner[0] === 'i32.const' ||
          (inner[0] === 'local.get' && localKind.get(inner[1]) === 'invariant')))
        return ['f64x2.splat', expr]   // loop-invariant convert: scalar-then-splat, bit-exact
      const a = liftV(inner); if (ctx.fail) return null
      return [op === 'f64.convert_i32_s' ? 'f64x2.convert_low_i32x4_s' : 'f64x2.convert_low_i32x4_u', a]
    }
    const tr = matchTruncF64(expr)   // f64 → i32 `|0` bridge
    if (tr) { const a = liftV(tr.inner); if (ctx.fail) return null; return [tr.signed ? 'i32x4.trunc_sat_f64x2_s_zero' : 'i32x4.trunc_sat_f64x2_u_zero', a] }
    if (TONE_LOAD[op] && expr.length === 2) {   // i32 → load64_zero (low 2 lanes); narrow → widen to i32x4 low lanes
      const w = TONE_LOAD[op].widen
      if (!w) return ['v128.load64_zero', expr[1]]   // address kept scalar
      let v = [w[0], expr[1]]
      for (let i = 0; i < w[1].length; i++) v = [w[1][i], v]
      return v
    }
    if (op === 'i32.const') return ['i32x4.splat', expr]
    if (op === 'f64.const') return ['f64x2.splat', expr]
    if (op === 'local.get' && typeof expr[1] === 'string') {
      const name = expr[1], kind = localKind.get(name)
      if (kind === 'lane') return ['local.get', laned(name)]
      if (kind === 'invariant') return [fnLocals.get(name) === 'f64' ? 'f64x2.splat' : 'i32x4.splat', expr]
      return liftFail(ctx, `tonemap: ${name} address/induction var used as lane data`)
    }
    if (op === 'local.tee' && typeof expr[1] === 'string' && expr.length === 3) {
      // `let v = X` reused in the same statement folds to `(local.tee $v X)`; lift it to set the
      // lane local AND yield it (bit-exact — the scalar tee sets $v and returns the same value).
      const name = expr[1]
      if (localKind.get(name) !== 'lane') return liftFail(ctx, `tonemap: tee of non-lane ${name}`)
      const v = liftV(expr[2]); if (ctx.fail) return null
      toneSetBefore.add(name)
      return ['local.tee', laned(name), v]
    }
    if (op === 'call' && PPC_CALL2[expr[1]]) {   // transcendental → its 2-wide mirror
      const args = []
      for (let i = 2; i < expr.length; i++) { const a = liftV(expr[i]); if (ctx.fail) return null; args.push(a) }
      return ['call', PPC_CALL2[expr[1]], ...args]
    }
    if (op === 'select' && expr.length === 4) {
      const inf = matchInfCanonTone(expr)
      if (inf) { const a = liftV(inf); if (ctx.fail) return null; return ['i32x4.trunc_sat_f64x2_s_zero', a] }
      return liftSel(expr[1], expr[2], expr[3])
    }
    if (op === 'if' && isArr(expr[1]) && expr[1][0] === 'result' && isArr(expr[3]) && expr[3][0] === 'then' && isArr(expr[4]) && expr[4][0] === 'else')
      return liftSel(expr[3][1], expr[4][1], expr[2])
    const insl = op.startsWith('f64.') ? 'f64' : (op.startsWith('i32.') ? 'i32' : 'x')
    const entry = LANE_PURE[insl]?.get(op)
    if (entry) {
      const a = liftV(expr[1]); if (ctx.fail) return null
      if (entry.shamtScalar) {
        const b = expr[2]
        if (!isI32Const(b) && !(isArr(b) && b[0] === 'local.get' && localKind.get(b[1]) === 'invariant'))
          return liftFail(ctx, `tonemap: ${op}: shift amount not constant/invariant`)
        return [entry.simd, a, b]
      }
      if (expr.length === 2) return [entry.simd, a]
      const b = liftV(expr[2]); if (ctx.fail) return null
      return [entry.simd, a, b]
    }
    return liftFail(ctx, `tonemap: ${op}: no lane mapping`)
  }

  // Lane-comparison mask, required to match the selected data width (a LOCAL `c` — never
  // reassign the param). Returns the mask expr or null on bail.
  function liftMask(cond, dataTy) {
    let c = cond
    if (isArr(c) && c[0] === 'i32.ne' && isI32Const(c[2]) && c[2][1] === 0) c = c[1]
    if (!isArr(c) || c.length !== 3) return liftFail(ctx, 'tonemap: condition is not a comparison')
    const condTy = c[0].startsWith('f64.') ? 'f64' : (c[0].startsWith('i32.') ? 'i32' : 'x')
    if (condTy !== dataTy) return liftFail(ctx, `tonemap: mask width ${condTy} ≠ data width ${dataTy}`)
    const cmp = LANE_COMPARE[condTy]?.[c[0]]
    if (!cmp) return liftFail(ctx, `tonemap: ${c[0]}: not a lane comparison`)
    const ca = liftV(c[1]); if (ctx.fail) return null
    const cb = liftV(c[2]); if (ctx.fail) return null
    return [cmp, ca, cb]
  }

  // `cond ? a : b` → bitselect(a, b, mask(cond)); mask in the branch's lane width.
  function liftSel(a, b, cond) {
    const m = liftMask(cond, toneWidth(a)); if (ctx.fail) return null
    const av = liftV(a); if (ctx.fail) return null
    const bv = liftV(b); if (ctx.fail) return null
    const mt = freshMask()
    return ['block', ['result', 'v128'], ['local.set', mt, m], ['v128.bitselect', av, bv, ['local.get', mt]]]
  }

  // Lift one statement, pushing v128 stmts into `out`. Sets ctx.fail on any bail.
  function liftS(stmt, out) {
    if (!isArr(stmt)) { liftFail(ctx, 'tonemap: non-array statement'); return }
    const op = stmt[0]
    if (op === 'block') {
      let i = 1
      if (typeof stmt[i] === 'string' && stmt[i].startsWith('$')) i++
      if (isArr(stmt[i]) && stmt[i][0] === 'result') i++
      for (const s of stmt.slice(i)) { liftS(s, out); if (ctx.fail) return }
      return
    }
    if (op === 'local.set' && typeof stmt[1] === 'string' && stmt.length === 3) {
      const name = stmt[1]
      if (localKind.get(name) !== 'lane') { liftFail(ctx, `tonemap: set of non-lane ${name}`); return }
      const v = liftV(stmt[2]); if (ctx.fail) return
      out.push(['local.set', laned(name), v]); toneSetBefore.add(name); return
    }
    if (STORE_OPS[op]) {   // i32.store ADDR VAL → masked i64.store of the low 2 lanes (2 pixels)
      if (op !== 'i32.store' || stmt.length !== 3) { liftFail(ctx, `tonemap: unsupported store ${op}`); return }
      const v = liftV(stmt[2]); if (ctx.fail) return
      out.push(['i64.store', stmt[1], ['i64x2.extract_lane', 0, v]]); return
    }
    if (op === 'if' && isArr(stmt[2]) && stmt[2][0] === 'then') {
      const hasElse = isArr(stmt[3]) && stmt[3][0] === 'else'
      const thenStmts = _toneUnwrapArm(stmt[2])
      const elseStmts = hasElse ? _toneUnwrapArm(stmt[3]) : null
      const thenLast = thenStmts[thenStmts.length - 1]
      const elseLast = elseStmts && elseStmts[elseStmts.length - 1]
      const thenStore = isArr(thenLast) && STORE_OPS[thenLast[0]] && thenLast.length === 3
      const elseStore = elseLast && isArr(elseLast) && STORE_OPS[elseLast[0]] && elseLast.length === 3
      // (a) Conditional STORE — both arms (or then-only) end in a store to the same address.
      if (thenStore && (elseStore || !hasElse)) {
        if (elseStore && JSON.stringify(thenLast[1]) !== JSON.stringify(elseLast[1])) { liftFail(ctx, 'tonemap: arms store to different addresses'); return }
        for (const s of thenStmts.slice(0, -1)) { liftS(s, out); if (ctx.fail) return }
        if (hasElse) for (const s of elseStmts.slice(0, -1)) { liftS(s, out); if (ctx.fail) return }
        const thenVal = liftV(thenLast[2]); if (ctx.fail) return
        const elseVal = elseStore ? liftV(elseLast[2]) : ['v128.load64_zero', thenLast[1]]
        if (ctx.fail) return
        const m = liftMask(stmt[1], 'i32'); if (ctx.fail) return
        const mt = freshMask()
        out.push(['local.set', mt, m],
          ['i64.store', thenLast[1], ['i64x2.extract_lane', 0, ['v128.bitselect', thenVal, elseVal, ['local.get', mt]]]])
        return
      }
      // (b) Conditional VALUE update — `if (cond) { L = …; … }` (no else) updating lane locals.
      if (!hasElse) {
        for (const s of thenStmts) {
          if (!(isArr(s) && s[0] === 'local.set' && typeof s[1] === 'string' && s.length === 3 && localKind.get(s[1]) === 'lane')) {
            liftFail(ctx, 'tonemap: no-else arm is not a lane update'); return
          }
          const name = s[1], ty = fnLocals.get(name) === 'f64' ? 'f64' : 'i32'
          const xv = liftV(s[2]); if (ctx.fail) return
          const ln = laned(name)
          if (toneSetBefore.has(name)) {
            const m = liftMask(stmt[1], ty); if (ctx.fail) return   // conditional merge
            const mt = freshMask()
            out.push(['local.set', mt, m], ['local.set', ln, ['v128.bitselect', xv, ['local.get', ln], ['local.get', mt]]])
          } else {
            out.push(['local.set', ln, xv]); toneSetBefore.add(name)   // first, unconditional (liveness-gated)
          }
        }
        return
      }
      liftFail(ctx, 'tonemap: unsupported if shape'); return
    }
    liftFail(ctx, `tonemap: unsupported statement ${op}`)
  }

  const lifted = []
  for (const s of body) { liftS(s, lifted); if (ctx.fail) return null }
  if (!lifted.length) return null

  // 2-wide SIMD wrapper (LANES=2, the f64x2 island's width). Scalar tail = original block.
  const LANES = 2
  const id = freshIdRef.next++
  const simdBoundName = `$__simd_bound${id}`, simdBrk = `$__simd_brk${id}`, simdLoop = `$__simd_loop${id}`
  const boundExpr = boundLocal ? ['local.get', boundLocal] : bound
  const simdBlock = ['block', simdBrk,
    ['loop', simdLoop,
      ['br_if', simdBrk, ['i32.eqz', ['i32.lt_s', ['local.get', incVar], ['local.get', simdBoundName]]]],
      ...lifted,
      ['local.set', incVar, ['i32.add', ['local.get', incVar], ['i32.const', LANES]]],
      ['br', simdLoop]]]
  // A widening narrow load reads more elements than its lane pair (u8: 4 bytes for 2 lanes), so shrink
  // the SIMD bound by that over-read — the widest load stays in-bounds and the scalar tail finishes the
  // remainder. (A negative bound from a tiny array just leaves the whole loop scalar — safe.)
  const boundExprAdj = overread > 0 ? ['i32.sub', boundExpr, ['i32.const', overread]] : boundExpr
  const boundSetup = ['local.set', simdBoundName, ['i32.and', boundExprAdj, ['i32.const', -LANES]]]
  const wrapper = ['block', ...preamble.map(cloneNode), boundSetup, simdBlock, bl.blockNode]
  const newLocalDecls = [
    ['local', simdBoundName, 'i32'],
    ...[...newLanedLocals.values()].map(laneName => ['local', laneName, 'v128']),
    ...ctx.extraLocals,
  ]
  return { wrapper, newLocalDecls }
}

// ---- Radix-2 butterfly 2-wide lift (tryButterfly) ----
//
// The Cooley-Tukey inner loop — the one shape the generic lane lift can never take:
// a DUAL-IV scaffold (`j++` carries the exit test, `k += STEP` walks the twiddle
// table) with an in-place complex-rotation update over four disjoint streams
// (re/im × a/b, b = a + HALF, twiddles wre/wim read-only). Lanes j and j+1:
//   - every a/b access is an ADJACENT pair → one v128.load / v128.store,
//   - the twiddle pair is strided by STEP → two scalar f64.loads + lane combine
//     (same load count as two scalar iterations),
//   - the +/−/× rotation lanes with NO reassociation and NO fusion — each lane
//     computes the exact scalar sequence, so the result is bit-identical and the
//     cross-engine checksum contract holds.
// LEGALITY. The strip body runs only while j+1 < half, so b = a + half ≥ a + 2:
// {a,a+1} and {b,b+1} never overlap — the b-pair stores cannot clobber lane 1's
// a-pair loads, and the single im[a] pair load legitimately serves both the
// im[b] store and the im[a] writeback (im[a] ∉ {im[b−1], im[b]}). re/im/wre/wim
// are distinct base locals under the vectorizer's standing distinct-base
// non-aliasing model. HALF/STEP and the four bases must not be written in the
// loop (checked); j/k are exactly reproduced for the scalar tail (each strip
// iteration consumes two scalar iterations), and the tail IS the original loop,
// so an odd half (or half < 2) falls through untouched.
function tryButterfly(blockNode, fnLocals, freshIdRef) {
  if (!isArr(blockNode) || blockNode[0] !== 'block' || typeof blockNode[1] !== 'string') return null
  const brk = blockNode[1]
  if (blockNode.length !== 3 || !isArr(blockNode[2]) || blockNode[2][0] !== 'loop') return null
  const loop = blockNode[2]
  const lbl = loop[1]
  if (typeof lbl !== 'string') return null
  // scaffold: (loop $L (br_if $brk (i32.eqz (i32.lt_s J HALF))) BODY×17 INC 'drop' (br $L))
  const exit = loop[2]
  if (!isArr(exit) || exit[0] !== 'br_if' || exit[1] !== brk) return null
  const ez = exit[2]
  if (!isArr(ez) || ez[0] !== 'i32.eqz' || !isArr(ez[1]) || ez[1][0] !== 'i32.lt_s') return null
  const [, jGet, halfGet] = ez[1]
  if (!isLocalGet(jGet) || !isLocalGet(halfGet)) return null
  const J = jGet[1], HALF = halfGet[1]
  const end = loop.length - 1
  if (!isArr(loop[end]) || loop[end][0] !== 'br' || loop[end][1] !== lbl) return null
  if (loop[end - 1] !== 'drop') return null
  // inc: (block (result i32) (drop (i32.sub (local.tee J (i32.add J 1)) 1)) (local.tee K (i32.add K STEP)))
  const inc = loop[end - 2]
  if (!isArr(inc) || inc[0] !== 'block' || !isArr(inc[1]) || inc[1][0] !== 'result' || inc.length !== 4) return null
  const jInc = inc[2], kInc = inc[3]
  if (!isArr(jInc) || jInc[0] !== 'drop' || !isArr(jInc[1]) || jInc[1][0] !== 'i32.sub') return null
  const jTee = jInc[1][1]
  if (!isArr(jTee) || jTee[0] !== 'local.tee' || jTee[1] !== J || !isArr(jTee[2]) || jTee[2][0] !== 'i32.add'
      || !isLocalGet(jTee[2][1], J) || constNum(jTee[2][2]) !== 1) return null
  if (!isArr(kInc) || kInc[0] !== 'local.tee' || !isArr(kInc[2]) || kInc[2][0] !== 'i32.add') return null
  const K = kInc[1]
  if (typeof K !== 'string' || !isLocalGet(kInc[2][1], K) || !isLocalGet(kInc[2][2])) return null
  const STEP = kInc[2][2][1]
  const body = loop.slice(3, end - 2)
  if (body.length !== 17) return null

  // unification environment over the exact emit shapes
  const U = {}
  const bind = (name, v) => U[name] === undefined ? (U[name] = v, true) : U[name] === v
  const idx8 = (n, base, iv) => isArr(n) && n[0] === 'i32.add'
    && isLocalGet(n[1]) && bind(base, n[1][1])
    && isArr(n[2]) && n[2][0] === 'i32.shl' && isLocalGet(n[2][1]) && bind(iv, n[2][1][1])
    && constNum(n[2][2]) === 3
  const setF64Load = (st, name, base, iv, ab) => {
    if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3 || !isArr(st[2]) || st[2][0] !== 'f64.load') return false
    let addr = st[2][1]
    if (ab != null) {
      if (!isArr(addr) || addr[0] !== 'local.tee') return false
      if (!bind(ab, addr[1])) return false
      addr = addr[2]
    }
    if (!idx8(addr, base, iv)) return false
    return bind(name, st[1])
  }
  const g = (n, name) => isLocalGet(n) && U[name] !== undefined && n[1] === U[name]
  const mulPair = (n, x, y) => isArr(n) && n[0] === 'f64.mul' && g(n[1], x) && g(n[2], y)
  const setArith = (st, name, op, mk) => {
    if (!isArr(st) || st[0] !== 'local.set' || st.length !== 3 || !isArr(st[2]) || st[2][0] !== op) return false
    if (!mk(st[2])) return false
    return bind(name, st[1])
  }
  // flat pair: (local.set T (op LHS VAL)) ; (f64.store (local.get AB) (local.get T))
  const storePair = (setSt, stoSt, op, lhs, val2, ab) => {
    if (!isArr(setSt) || setSt[0] !== 'local.set' || !isArr(setSt[2]) || setSt[2][0] !== op) return false
    const e = setSt[2]
    if (!lhs(e[1]) || !g(e[2], val2)) return false
    if (!isArr(stoSt) || stoSt[0] !== 'f64.store' || !g(stoSt[1], ab) || !isLocalGet(stoSt[2], setSt[1])) return false
    return true
  }

  if (!setF64Load(body[0], 'WR', 'WRE', 'K0', null) || U.K0 !== K) return null
  if (!setF64Load(body[1], 'WI', 'WIM', 'K1', null) || U.K1 !== K) return null
  {  // a = I + j (either order), I ≠ J
    const st = body[2]
    if (!isArr(st) || st[0] !== 'local.set' || !isArr(st[2]) || st[2][0] !== 'i32.add') return null
    const [, l, r] = st[2]
    if (isLocalGet(l) && isLocalGet(r, J) && l[1] !== J) U.I = l[1]
    else if (isLocalGet(r) && isLocalGet(l, J) && r[1] !== J) U.I = r[1]
    else return null
    U.A = st[1]
  }
  {  // b = a + half (either order)
    const st = body[3]
    if (!isArr(st) || st[0] !== 'local.set' || !isArr(st[2]) || st[2][0] !== 'i32.add') return null
    const [, l, r] = st[2]
    if (!((isLocalGet(l, U.A) && isLocalGet(r, HALF)) || (isLocalGet(r, U.A) && isLocalGet(l, HALF)))) return null
    U.B = st[1]
  }
  if (!setF64Load(body[4], 'XR', 'RE', 'B0', 'AB4') || U.B0 !== U.B) return null
  if (!setF64Load(body[5], 'XI', 'IM', 'B1', 'AB5') || U.B1 !== U.B) return null
  if (!setArith(body[6], 'TR', 'f64.sub', e => mulPair(e[1], 'WR', 'XR') && mulPair(e[2], 'WI', 'XI'))) return null
  if (!setArith(body[7], 'TI', 'f64.add', e => mulPair(e[1], 'WR', 'XI') && mulPair(e[2], 'WI', 'XR'))) return null
  if (!setF64Load(body[8], 'C0', 'RE', 'A0', 'AB6') || U.A0 !== U.A) return null
  const c0lhs = (n) => g(n, 'C0')
  const ab7teeLhs = (n) => {  // (f64.load (local.tee AB7 (im + a<<3)))
    if (!isArr(n) || n[0] !== 'f64.load' || !isArr(n[1]) || n[1][0] !== 'local.tee') return false
    if (!bind('AB7', n[1][1])) return false
    return idx8(n[1][2], 'IM', 'A2') && U.A2 === U.A
  }
  const ab7getLhs = (n) => isArr(n) && n[0] === 'f64.load' && g(n[1], 'AB7')
  if (!storePair(body[9], body[10], 'f64.sub', c0lhs, 'TR', 'AB4')) return null
  if (!storePair(body[11], body[12], 'f64.sub', ab7teeLhs, 'TI', 'AB5')) return null
  if (!storePair(body[13], body[14], 'f64.add', c0lhs, 'TR', 'AB6')) return null
  if (!storePair(body[15], body[16], 'f64.add', ab7getLhs, 'TI', 'AB7')) return null
  // loop-invariance: the four bases, HALF/STEP and the outer offset I are never written in the body
  const invariants = new Set([U.RE, U.IM, U.WRE, U.WIM, HALF, STEP, U.I].filter(x => typeof x === 'string'))
  if (invariants.size !== 7) return null
  let clobbered = false
  const wscan = n => {
    if (clobbered) return false
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && invariants.has(n[1])) { clobbered = true; return false }
  }
  for (const st of body) walkAst(st, { enter: wscan })
  if (clobbered) return null
  if (new Set([U.RE, U.IM, U.WRE, U.WIM]).size !== 4) return null

  const id = freshIdRef.next++
  const nm = (t) => `$__bf${id}_${t}`
  const L = (x) => ['local.get', x]
  const addr = (base, iv) => ['i32.add', L(base), ['i32.shl', L(iv), ['i32.const', 3]]]
  const twiddle = (base) => ['f64x2.replace_lane', 1,
    ['f64x2.splat', ['f64.load', addr(base, K)]],
    ['f64.load', ['i32.add', L(base), ['i32.shl', ['i32.add', L(K), L(STEP)], ['i32.const', 3]]]]]
  const wrv = nm('wrv'), wiv = nm('wiv'), xrv = nm('xrv'), xiv = nm('xiv')
  const trv = nm('trv'), tiv = nm('tiv'), c0v = nm('c0v'), iav = nm('iav')
  const av = nm('a'), bv = nm('b'), vl = nm('L'), strip = nm('go')
  const newLocalDecls = [
    ['local', wrv, 'v128'], ['local', wiv, 'v128'], ['local', xrv, 'v128'], ['local', xiv, 'v128'],
    ['local', trv, 'v128'], ['local', tiv, 'v128'], ['local', c0v, 'v128'], ['local', iav, 'v128'],
    ['local', av, 'i32'], ['local', bv, 'i32'],
  ]
  const stripGuard = () => ['i32.lt_s', ['i32.add', L(J), ['i32.const', 1]], L(HALF)]
  const vbody = [
    ['local.set', wrv, twiddle(U.WRE)],
    ['local.set', wiv, twiddle(U.WIM)],
    ['local.set', av, ['i32.add', L(U.I), L(J)]],
    ['local.set', bv, ['i32.add', L(av), L(HALF)]],
    ['local.set', xrv, ['v128.load', addr(U.RE, bv)]],
    ['local.set', xiv, ['v128.load', addr(U.IM, bv)]],
    ['local.set', trv, ['f64x2.sub', ['f64x2.mul', L(wrv), L(xrv)], ['f64x2.mul', L(wiv), L(xiv)]]],
    ['local.set', tiv, ['f64x2.add', ['f64x2.mul', L(wrv), L(xiv)], ['f64x2.mul', L(wiv), L(xrv)]]],
    ['local.set', c0v, ['v128.load', addr(U.RE, av)]],
    ['v128.store', addr(U.RE, bv), ['f64x2.sub', L(c0v), L(trv)]],
    ['local.set', iav, ['v128.load', addr(U.IM, av)]],
    ['v128.store', addr(U.IM, bv), ['f64x2.sub', L(iav), L(tiv)]],
    ['v128.store', addr(U.RE, av), ['f64x2.add', L(c0v), L(trv)]],
    ['v128.store', addr(U.IM, av), ['f64x2.add', L(iav), L(tiv)]],
    ['local.set', J, ['i32.add', L(J), ['i32.const', 2]]],
    ['local.set', K, ['i32.add', L(K), ['i32.add', L(STEP), L(STEP)]]],
    ['br_if', vl, stripGuard()],
  ]
  const wrapper = ['block',
    ['block', strip,
      ['br_if', strip, ['i32.eqz', stripGuard()]],
      ['loop', vl, ...vbody]],
    blockNode]  // the ORIGINAL loop is the scalar tail: 0..1 leftover iterations, or everything when half < 2
  return { wrapper, newLocalDecls }
}


// ---- Cost model (.work/vectorizer-generality-design.md's final follow-up seam, Part 2): a
// profitability gate for the GENERAL base layers ONLY (tryGeneralMap/
// tryGeneralStencil/tryGeneralReduce below) — every idiom FUSER above (tryDivergentEscapeVectorize,
// tryBlurMultiPixel, tryButterfly, …) keeps its own separately-tuned, always-fire behavior
// unchanged; this gate never runs for them. Today the three general recognizers vectorize
// UNCONDITIONALLY the instant their affine/dependence proof succeeds — sound, but blind to
// whether the SIMD prologue/epilogue/blend overhead is actually worth paying for a given body.
//
// Estimate, not a simulator: `scalarCost` = weighted op count of ONE original scalar iteration
// (`body`, pre-lift); `vectorCost` = weighted op count of ONE vector step (`lifted`, the SAME
// tree the codegen below emits, processing `lanes` elements) + a fixed prologue overhead + a
// per-guard overhead when runtime alias-versioning (layer 3) adds a disjointness check. Decline
// (the caller returns null, exactly like any other precondition failure in this file) when
// `vectorCost / lanes >= scalarCost` — vectorizing would cost at least as much per element as
// just running the scalar loop.
//
// Weights: `load`/`store` = 1, the baseline unit. Arithmetic/compare/convert-class ops (add,
// sub, mul, and, or, xor, shift, eq/lt/gt/…, min, max, neg, abs, sqrt, floor/ceil/trunc/nearest,
// convert/extend/narrow/wrap/promote/demote, splat) = 1 — same instruction-count class as a
// load. `div`/`rem` (float only — integer div/rem are never LANE_PURE, see that table's own
// header; a speculated arm containing one fails to lift and declines the WHOLE loop, never
// reaching this cost check) = 8 — division has no fast SIMD form on wasm (no reciprocal-estimate
// instruction in the MVP+SIMD feature set). `bitselect` (blend, the if-conversion codegen
// above) = 5.
//
// Calibration: these weights are an ESTIMATE, not a measured multiplier. A wall-clock microbench
// (`d = mask ? a : b` vs `d = a + b` vs `d = a / b`, SIMD_OPT, both a 2e7-element streaming pass
// and a 2e5-element pass repeated 200× to stay cache-resident) showed NO measurable difference
// between add/blend/div on V8 — all three are memory-bandwidth-bound, not compute-bound, at any
// array size tried. That is itself useful signal (real streaming SIMD kernels are memory-bound,
// so op-mix rarely changes wall-clock much), but it means no microbench can supply a blend/div
// MULTIPLIER directly. The weights actually used are a conservative PRIOR instead (in the spirit
// of LLVM's TargetTransformInfo select/div cost classes — blend ~2-5x, div severalx-to-double-digit
// x, target-dependent), gate-calibrated against corpus behavior: `div`=8 is the illustrative
// starting value (never empirically contradicted — no corpus loop has a speculated arm with float
// division to test against either way); `bitselect`=5 and `COST_OVERHEAD_PROLOGUE`/
// `COST_OVERHEAD_PER_GUARD` = 1/1 are chosen so the model does not decline a real, corpus-shaped
// case (`test/simd.js`'s alias-versioned f64 same-array runtime-offset map — an ordinary affine
// MAP with one alias-versioning guard, NO if-conversion, at f64's 2-lane width, where guard/
// prologue overhead alone would otherwise punish a perfectly profitable plain map) while still
// declining the synthetic decline case below (§SIMD cost model tests). Governing rule: if the
// model would decline a real corpus case, the model is wrong — recalibrate the weights, never
// special-case the site. Weight is shifted FROM the lane-count-sensitive per-loop overhead (which
// penalizes every general-layer recognizer, if-converted or not, hardest at f64/i64's 2 lanes)
// TOWARD the blend-specific weight (which only penalizes if-conversion codegen). A full corpus
// sweep against the test suite is the decisive calibration signal — not either number in isolation.

function assertLoopPlanAgrees(node, bl) {
  const link = ctx.plans.loweringLinks.get(node)
  if (!link) return
  const { plan, lowering } = link
  if (lowering.ivName != null && dollar(lowering.ivName) !== bl.incVar)
    throw new Error(`LoopPlan #${plan.id} IV diverges from WAT: HIR ivName=${lowering.ivName} (${dollar(lowering.ivName)}), WAT incVar=${bl.incVar}`)
  if (plan.boundConst != null && isI32Const(bl.bound) && constNum(bl.bound) !== plan.boundConst)
    throw new Error(`LoopPlan #${plan.id} bound diverges from WAT: HIR boundConst=${plan.boundConst}, WAT bound=${constNum(bl.bound)}`)
}

// ---- Pass entry ------------------------------------------------------------

/**
 * Walk a function looking for vectorizable (block (loop)) pairs, in-place.
 * Adds new locals to the function header.
 */
// opts gates the recognizer set + lift variants (all default-safe so a bare
// `vectorizeLaneLocal(fn)` is the conservative scalar-preserving pass):
//   multiAcc, relaxedFma, blurMP, whyNot, stencil, outerStrip, pureFuncMap, toneMap.
export function vectorizeLaneLocal(fn, opts = {}) {
  const { multiAcc = false, relaxedFma = false, blurMP = true, whyNot = false,
    stencil = false, outerStrip = false, pureFuncMap = null, toneMap = false, slp = false, crPow = false,
    aliasVersion = true } = opts
  if (!isArr(fn) || fn[0] !== 'func') return
  const bodyStart = findBodyStart(fn)
  if (bodyStart < 0) return
  const fnName = typeof fn[1] === 'string' ? fn[1] : '(anon)'
  let whyNotN = 0

  // Normalize jz's per-statement `block` grouping into flat statement lists ONCE, up front —
  // the recognizers below (both the scaffold consumers and the raw-node matchers like ramp-map,
  // stencil, per-pixel) were tuned on watr's flattened shape. Pre-watr, jz wraps each source
  // statement group in a transparent block; without this every loop body would arrive as a
  // single opaque `block` node and no lift would fire. Walking `fn` itself also flattens a
  // top-level body block (decls never match — they aren't blocks).
  normalizeTransparentBlocks(fn)
  // Canonicalize the raw arithmetic identities watr would fold (chiefly `i<<0` byte addresses),
  // so the address/value matchers read dataflow, not jz's un-folded emission.
  for (let i = bodyStart; i < fn.length; i++) fn[i] = foldVecIdentities(fn[i])
  // Canonicalize the `if COND (then (br L))` break idiom to `br_if L COND` (watr's brif shape),
  // so the loop-scan recognizers see the branch form they were tuned against.
  canonicalizeIfBr(fn)

  // Build local-name → wasm-type map.
  const fnLocals = new Map()
  for (let i = 2; i < bodyStart; i++) {
    const d = fn[i]
    if (isArr(d) && d[0] === 'local' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    } else if (isArr(d) && d[0] === 'param' && typeof d[1] === 'string' && typeof d[2] === 'string') {
      fnLocals.set(d[1], d[2])
    }
  }

  // Loop-invariant constant locals — hoistConstantPool's `$…_pg` pool (`set $L (f64.const C)`,
  // written exactly once). name → numeric value, used to resolve a constant `pow` exponent that
  // reached the loop as a pooled local rather than a literal.
  const constLocals = new Map()
  {
    const setCount = new Map()
    forEachLocalDef(fn.slice(bodyStart), (name, rhs, node) => {
      if (node.length !== 3) return
      setCount.set(name, (setCount.get(name) || 0) + 1)
      if (isArr(rhs) && rhs[0] === 'f64.const') constLocals.set(name, +rhs[1])
    })
    for (const [k, c] of setCount) if (c !== 1) constLocals.delete(k)   // multiply-written → not invariant
  }

  const freshIdRef = { next: 0 }
  const newLocalDeclsAll = []
  // Whether a REAL SIMD lift happened (as opposed to the scalar tryStrengthReduceIV
  // fallback below, which also populates newLocalDeclsAll with plain i32 locals) —
  // the caller pins the function's $name/$name$exp boundary wrapper on this, so a
  // false positive here would needlessly block watr's inlineOnce on a non-SIMD fn.
  let simdFired = false

  // Hoist loop-invariant partial products out of unrolled dot reductions (rust/LLVM's
  // mat4 prologue trick). Reassociates the float sum, so tied to the relaxedFma tier;
  // runs BEFORE the dot-pair vectorizer so a hoisted dot drops below DOT_UNROLL steps
  // and stays scalar (faster here than the pack/extract SIMD form — see the lab).
  if (relaxedFma) hoistReductionInvariantsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll)
  // Unified SLP packer (dot-sequence tier, then element-store tier) — see slpPairsIn.
  slpPairsIn(fn, fnLocals, freshIdRef, newLocalDeclsAll, relaxedFma, slp)
  if (newLocalDeclsAll.length) simdFired = true

  // Walk body recursively. Process inner-most matches first (post-order)
  // so we don't try to vectorize an outer loop whose inner is the lane-local one.
  function walk(parent, idx) {
    const node = parent[idx]
    if (!isArr(node)) return
    for (let i = 0; i < node.length; i++) {
      if (isArr(node[i])) walk(node, i)
    }
    if (node[0] === 'block') {
      if (vecState.whyNotActive) vecState.whyNotReason = null
      // Recognition layer: match the canonical (block (loop)) scaffold ONCE; the
      // inner-scaffold lifters (memcpy/map/reduce) consume the descriptor instead of
      // each re-matching. The outer-pixel + special-shape recognizers (outer-strip
      // family, ramp-map, channel-reduce) do their own matching on the raw node.
      // Order is preserved exactly — it is load-bearing (first match wins).
      // allowInlinedLi: accept an inlined LICM preamble (`$__inl*___li*`) too — jz's
      // LICM hoists ToInt32/casts of loop-invariant params just before the loop (e.g.
      // `a[i] & m` with a runtime `m`), and after inlining the snap is renamed off the
      // bare `$__li*` form. The preamble is pure & loop-invariant by construction
      // (hasSideEffect-guarded) and cloned ahead of the SIMD block, so this only widens
      // which loops the recognizers see, never changes a lifted result.
      const bl = matchBlockLoop(node, { allowPreamble: true, allowInlinedLi: true })
      // HIR provenance link shadow-assert (.work/research.md §BodyModel slice 4) — see
      // assertLoopPlanAgrees's own doc. `bl`-scoped only (the IV/bound facts it exists to
      // cross-check); a null `bl` has nothing to compare. Runs BEFORE the consultation below
      // so it still checks the fresh WAT derivation, unmodified by the override.
      if (DBG_INVARIANTS && bl) assertLoopPlanAgrees(node, bl)
      // FIRST REAL CONSUMPTION (.work/research.md §BodyModel): the shadow-assert above runs
      // across the full battery with zero divergences, so wherever the link resolves an IV
      // name, it is PROVEN to equal `bl.incVar`'s WAT-derived one. Roles invert: the plan
      // becomes the primary source for the name every bl-based
      // recognizer below reads (tryMemCopyFill/tryVectorize/tryReduce/
      // tryStencil/tryToneMap/tryStrengthReduceIV — all share
      // this one `bl`), and `matchInc1`'s WAT walk above becomes the fail-open FALLBACK (link
      // miss keeps its structurally-derived name) plus, under JZ_DEBUG_INVARIANTS, the shadow
      // (assertLoopPlanAgrees, run just above, already fills that role — nothing left to add).
      // Bound/hull are NOT flipped here: assertLoopPlanAgrees only proves `plan.boundConst`
      // against `bl.bound` in the branch where `bl.bound` is ALREADY an `i32.const` node — i.e.
      // exactly the case where the WAT derivation is already the concrete number in one read: a
      // non-const (boundLocal) bound is never compared, so consulting the plan there would be
      // unproven. Narrowed to the proven subset (banked finding, .work/research.md §BodyModel).
      if (bl) {
        const link = ctx.plans.loweringLinks.get(node)
        if (link && link.lowering.ivName != null) bl.incVar = dollar(link.lowering.ivName)
      }
      // LoopPlan classification (stage-3 slice 1): the OUTER-pixel scaffold is
      // matched ONCE here — the five outer-family recognizers consume this
      // descriptor (with its inner-loop census) instead of each re-matching.
      // `bl` (inner scaffold) + `op` (outer scaffold) together are the loop's
      // plan; a recognizer whose scaffold is null skips without walking.
      const op = matchOuterPixelLoop(node)
      // Loose-envelope variant of the same scaffold (any non-loop content
      // tolerated) — shared by blur-multi-pixel + channel-reduce, both LATE
      // in the `??` chain below. Lazy + memoized: most blocks either aren't
      // loop scaffolds at all or already match one of the earlier `bl`-based
      // recognizers, so the chain short-circuits before ever reaching the
      // two consumers — computing this third matcher pass upfront would be
      // pure waste on that (common) path. `getBlLoose()` runs the actual
      // `matchBlockLoop` at most once, on first read.
      let blLoose, blLooseComputed = false
      const getBlLoose = () => blLooseComputed ? blLoose
        : (blLooseComputed = true, blLoose = matchBlockLoop(node, { envelope: 'loose' }))
      let r = tryDivergentEscapeVectorize(node, fnLocals, freshIdRef, op)
        ?? tryMemCopyFill(bl, fnLocals, freshIdRef)
        ?? tryVectorize(bl, fnLocals, freshIdRef, pureFuncMap, constLocals)
        ?? tryReduce(bl, fnLocals, freshIdRef, multiAcc)
        ?? tryStencil(node, fnLocals, freshIdRef, stencil, bl)
        ?? tryRampMap(node, fnLocals, freshIdRef)
        ?? tryChannelReduce(node, fnLocals, freshIdRef, getBlLoose(), blurMP)
        ?? tryOuterStripRest(node, fnLocals, freshIdRef, pureFuncMap, outerStrip, op)
        ?? tryToneMap(bl, fnLocals, freshIdRef, toneMap)
        ?? tryButterfly(node, fnLocals, freshIdRef)
        ?? tryGeneralMap(node, fnLocals, freshIdRef, bl, { aliasVersion })
        ?? tryGeneralStencil(node, fnLocals, freshIdRef, stencil, bl, { aliasVersion })
        ?? tryGeneralReduce(bl, fnLocals, freshIdRef, multiAcc)
      // --why-not-simd: a canonical loop-shaped candidate that no SIMD pass took.
      // Reported BEFORE the scalar strength-reduce fallback (which fires on most
      // affine loops and would otherwise mask "didn't vectorize"). Diagnostic only.
      // Reuses `op` (already matched above) instead of re-running matchOuterPixelLoop.
      if (!r && vecState.whyNotActive && (bl || op)) {
        whyNotN++
        warn('simd-why-not',
          `${fnName}: loop #${whyNotN} not vectorized — ${vecState.whyNotReason || 'no SIMD-liftable shape (loop-carried dependency, non-affine address, or unsupported control flow)'}`,
          { fn: `${fnName}#${whyNotN}` })
      }
      if (r) simdFired = true   // one of the real SIMD recognizers above matched
      if (r) {
        // Mark the consumed subtree: the wrapper REUSES these nodes (scalar tail, and the
        // lane splats alias the original load nodes), so a deferred strength-reduce must
        // never rewrite inside them — it would mutate the lifted lanes through the alias.
        walkAst(node, { enter: n => { srConsumed.add(n) } })
        parent[idx] = r.wrapper
        newLocalDeclsAll.push(...r.newLocalDecls)
      } else if (bl) {
        // Scalar IV strength-reduction is a non-SIMD fallback — DEFERRED to after the
        // whole walk. Applied eagerly here (post-order = innermost first) it rewrites an
        // inner reduction loop into its wrapper before the ENCLOSING loop's outer
        // recognizers (outer-strip / iterated-reduce / conv-column / tone-map) ever run,
        // and they bail on the non-canonical inner shape — metaballs' pixel loop lost its
        // whole f64x2 outer-strip to an eager strength-reduce of the blob loop.
        deferredSR.push([node, parent, idx, bl])
      }
    }
  }
  const deferredSR = [], srConsumed = new Set()
  vecState.whyNotActive = whyNot
  vecState.relaxF32 = relaxedFma
  vecState.crPow = crPow
  for (let i = bodyStart; i < fn.length; i++) walk(fn, i)
  vecState.whyNotActive = false
  vecState.relaxF32 = false
  vecState.crPow = false
  // Apply the deferred scalar fallback innermost-first (push order), skipping candidates
  // inside any SIMD-consumed subtree (see the mark above), plus a same-slot check for
  // wrappers that replaced the candidate node itself.
  for (const [node, parent, idx, bl] of deferredSR) {
    if (srConsumed.has(node) || parent[idx] !== node) continue
    const r = tryStrengthReduceIV(bl, fnLocals, freshIdRef)
    if (r) { parent[idx] = r.wrapper; newLocalDeclsAll.push(...r.newLocalDecls) }
  }

  if (newLocalDeclsAll.length) {
    // Sibling loops (and the straight-line dot pass) can each lift the SAME source
    // local to an identically-named `$name__v` v128 scratch. Post-order vectorizes
    // innermost-first and an outer loop bails once its inner became a wrapper block,
    // so no two NESTED loops ever share a lift — every collision is between
    // SEQUENTIAL loops, where one shared scratch is correct (each writes its lanes
    // before reading). Declaring a local twice is invalid wasm ("duplicate local"),
    // so keep one decl per name (all dups are the identical `['local', name, 'v128']`).
    fn.splice(bodyStart, 0, ...new Map(newLocalDeclsAll.map(d => [d[1], d])).values())
  }
  return simdFired
}
