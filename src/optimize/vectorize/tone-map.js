import { cloneNode, walkAst } from '../../ast.js'
import { constNum, firstAccess, hasGlobalSet, isI32Const, isLocalGet } from './addr-model.js'
import { LANE_COMPARE, LANE_PURE, LOAD_OPS, PPC_CALL2, STORE_OPS } from './lane-tables.js'
import { liftFail } from './lift.js'
import { isArr } from './node-utils.js'

// ---- Mixed-lane tone-map (tryToneMap, experimental) ------------------------
//
// Vectorizes the log-tonemap TAIL shared by fern / bifurcation / attractors:
//   while (i<n){ let v=dens[i]; if(v>0){ g = trunc(min(log(v+1)*S, 255)) }
//                px[i] = (255<<24)|(g<<16)|(g<<8)|g }
// A flat 1-D loop that loads an i32 density, lifts it to f64 for a log, truncates
// back to i32, packs an ARGB word, and stores it — i32 lanes wrapping an f64 ISLAND.
// The single-lane-type lift can't carry an f64 intermediate inside an i32 store
// (tryVectorize bails on `f64.mul: no lane-pure SIMD mapping for i32`), so this is a
// dedicated 2-wide (f64x2) hybrid: load 2 u32 (`v128.load64_zero` → i32x4 low lanes),
// `f64x2.convert_low_i32x4_s` into the island, `$math.log_v` + f64x2 arith + clamp,
// `i32x4.trunc_sat_f64x2_s_zero` back out, the i32 pack, then a masked
// `i64.store` of `i64x2.extract_lane 0` (the low 2 lanes = 2 pixels). 2 pixels/iter.
//
// BIT-EXACT by construction: each lane runs the scalar op (log_v is the per-lane
// extract/repack mirror; the clamp keeps L finite & in [0,255] so `trunc_sat == |0`,
// the ±Inf canon is a no-op and is dropped; the pack is element-wise). The conditional
// masks are emitted in the SAME lane width as the data they select (`v>0` is i32 and
// gates i32 stores/values; the `L>255` clamp is f64 and gates f64) — a width mismatch
// bails. No cross-lane reordering, so no ulp drift. Speculatively-evaluated arms are
// trap-free (log/convert/mul/min/trunc never trap; there is no div/rem). Gated until
// proven across the corpus, then promoted like the stencil/outer-strip wins.
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
export function tryToneMap(bl, fnLocals, freshIdRef, enabled) {
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
