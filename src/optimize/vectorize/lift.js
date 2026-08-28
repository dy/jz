import { registerResetHook } from '../../ctx.js'
import { nodeEqual as exprEq } from '../../ast.js'
import { hasBranchOrReturn, hasSideEffect, isI32Const, matchMirrorAddr } from './addr-model.js'
import { aosAddrPair, aosGather, aosStore, getOrAllocLanedLocal } from './aos.js'
import { matchCanonBlock, matchCanonSelect } from './idioms.js'
import { inlinePureCallExpr } from './inline-pure.js'
import { F64_TO_F32X4, INT_WIDEN_F32, LANE_COMPARE, LANE_INFO, LANE_PURE, LOAD_OPS, PPC_CALL2, STORE_OPS } from './lane-tables.js'
import { isArr } from './node-utils.js'

function liftCanon(coreV, C, ctx, info) {
  const laneNe = ctx.laneType === 'f32' ? 'f32x4.ne' : 'f64x2.ne'
  // The f32-via-f64 canon carries an f64 NaN const — splat it as f32 (demote is
  // exact for the canonical NaN, and the lane value coreV is already f32x4).
  const cF = ctx.laneType === 'f32' && isArr(C) && C[0] === 'f64.const' ? ['f32.const', C[1]] : C
  const splatC = [info.splat, cF]
  if (isArr(coreV) && coreV[0] === 'local.get') {
    return ['v128.bitselect', splatC, coreV, [laneNe, coreV, coreV]]
  }
  const tmp = `$__canon${ctx.freshIdRef.next++}`
  ctx.extraLocals.push(['local', tmp, 'v128'])
  const g = ['local.get', tmp]
  return ['block', ['result', 'v128'],
    ['local.set', tmp, coreV],
    ['v128.bitselect', splatC, g, [laneNe, g, g]]]
}

// --why-not-simd diagnostics. `vecState.whyNotActive` is armed only for the duration of a
// vectorizeLaneLocal call made with the flag on (cleared on exit — never leaks into
// codegen, which never reads it). `vecState.whyNotReason` captures the FIRST (deepest) lift
// bail for the block currently under the recognizer chain; the walk reads it after.
export const vecState = { whyNotActive: false, whyNotReason: null, relaxF32: false, crPow: false }
// Precision-relaxed f32 SIMD. jz computes Float32Array arithmetic in f64
// (`f32.demote_f64 (f64.mul (f64.promote_f32 …) …)`); lifting that chain to
// `f32x4.mul` over `v128.load` changes the intermediate from f64 to f32 — a
// sub-ulp difference at f32 precision (inaudible for audio/DSP, the canonical
// f32-SIMD trade every audio engine makes), but NOT bit-exact, so it is gated
// on the same `relaxedSimd` opt-in that enables relaxed-FMA. The promote/demote
// *strip* for a pure f32 copy (no arithmetic) round-trips losslessly and stays
// on unconditionally. Armed for the duration of a vectorizeLaneLocal call.

// optimize.crPow, armed the same way — the const-exponent pow arm picks its lowering
// from it (lift ctx objects don't carry the optimize config; module flag is the pattern).

// Reset choreography: the arm/disarm pair around each vectorizeLaneLocal call (below)
// is a manual per-call-site contract,
// not exception-safe — a thrown error mid-walk skips the disarm lines and leaves
// these flags armed for the rest of the warm process. Registering a session-
// boundary reset means that leak can never survive past the NEXT compile's
// reset()/beginSession(), even though within-compile correctness still relies on
// the call-site arm/disarm (unchanged here).
const resetVectorizeState = () => { vecState.whyNotActive = false; vecState.whyNotReason = null; vecState.relaxF32 = false; vecState.crPow = false }
registerResetHook(resetVectorizeState)

// Mark a lift bail and record its reason. First-write-wins: the innermost failing op
// sets ctx.failReason; outer frames see ctx.fail already set and return without
// overwriting, so the reason names the actual blocking op, not a wrapper.
export const liftFail = (ctx, reason) => {
  ctx.fail = true
  if (ctx.failReason == null) ctx.failReason = reason
  if (vecState.whyNotActive && vecState.whyNotReason == null) vecState.whyNotReason = reason
  return null
}

/** Lift a statement. Returns lifted stmt, or null to skip, or ['__seq__', ...] for multiple. */
// Conditional lane-local assignment in a stencil/map body — the sibling of the
// if-STORE path below, but the destination is a 'lane' LOCAL, not memory:
//   if (C) L = A   [else L = B | else <nested if assigning L>]
// the saturation / clamp shape (waves' amplitude clamp `if(nb>CAP)nb=CAP; else
// if(nb<-CAP)nb=-CAP`). Built as ONE nested `v128.bitselect` EXPRESSION so every
// mask reads the PRE-assignment lane value (no intermediate stores ⇒ order-free,
// and bit-exact with the scalar select chain — a comparison mask is all-ones /
// all-zeros per lane, so bitselect is an exact lane select), then a single
// `local.set` of the laned local. Returns the lifted node, or null when `stmt` is
// not a lane-assignment if (so the if-STORE path can try). Sets ctx.fail only once
// committed (a lane-if shape that cannot be lifted).
function tryLiftLaneIf(stmt, ctx) {
  const armBody = (arm) => {
    let body = arm.slice(1)
    if (body.length === 1 && isArr(body[0]) && body[0][0] === 'block') {
      const b = body[0]; let i = 1
      if (typeof b[i] === 'string' && b[i].startsWith('$')) i++
      if (isArr(b[i]) && b[i][0] === 'result') i++
      body = b.slice(i)
    }
    return body
  }
  // The lane being assigned: the innermost then-arm's single local.set target.
  const laneOf = (node) => {
    if (!isArr(node)) return null
    if (node[0] === 'local.set' && typeof node[1] === 'string' && ctx.localKind.get(node[1]) === 'lane') return node[1]
    if (node[0] === 'if' && isArr(node[2]) && node[2][0] === 'then') {
      const body = armBody(node[2])
      if (body.length === 1) return laneOf(body[0])
    }
    return null
  }
  const lane = laneOf(stmt)
  if (!lane) return null
  // Recurse the if-chain into nested bitselects; each `local.set L = V` is a leaf value.
  const buildVal = (node) => {
    if (isArr(node) && node[0] === 'local.set' && node[1] === lane) return liftExprV(node[2], ctx)
    if (isArr(node) && node[0] === 'if' && isArr(node[2]) && node[2][0] === 'then') {
      const thenBody = armBody(node[2])
      if (thenBody.length !== 1) return liftFail(ctx, 'lane-if: non-single then arm')
      let cond = node[1]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      const cmp = isArr(cond) && cond.length === 3 ? LANE_COMPARE[ctx.laneType]?.[cond[0]] : null
      if (!cmp) return liftFail(ctx, 'lane-if: condition is not a lane comparison')
      const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null
      const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null
      const thenVal = buildVal(thenBody[0]); if (ctx.fail) return null
      const elseArm = (isArr(node[3]) && node[3][0] === 'else') ? armBody(node[3]) : null
      let elseVal
      if (elseArm) {
        if (elseArm.length !== 1) return liftFail(ctx, 'lane-if: non-single else arm')
        elseVal = buildVal(elseArm[0]); if (ctx.fail) return null
      } else {
        elseVal = ['local.get', getOrAllocLanedLocal(lane, ctx.newLanedLocals)]   // no else ⇒ keep current
      }
      return ['v128.bitselect', thenVal, elseVal, [cmp, ca, cb]]
    }
    return liftFail(ctx, 'lane-if: unrecognized arm shape')
  }
  const val = buildVal(stmt)
  if (ctx.fail || val == null) return null
  return ['local.set', getOrAllocLanedLocal(lane, ctx.newLanedLocals), val]
}

export function liftStmt(stmt, ctx) {
  if (!isArr(stmt)) {
    // Bare strings like "drop" — produced by stack-form WAT. We unwrap value-blocks
    // separately so an isolated "drop" should not appear here, but tolerate it.
    if (stmt === 'drop') return null
    return liftFail(ctx, 'non-array statement')
  }
  const op = stmt[0]

  if (op === 'local.set' && typeof stmt[1] === 'string' && stmt.length === 3) {
    const name = stmt[1]
    const kind = ctx.localKind.get(name)
    if (kind === 'addr') {
      // Address-only local: lift the value as-is (it's i32 arithmetic on ind).
      return ['local.set', name, stmt[2]]
    }
    // 'lane', or an UNCLASSIFIED local — which can only be one introduced by an inlined pure
    // callee (classification covers every original body local; a pure helper's temps are fresh
    // per-iteration lane values, never loop-carried). Both lift as lane data.
    if (kind === 'lane' || kind === undefined) {
      const laneName = getOrAllocLanedLocal(name, ctx.newLanedLocals)
      const v = liftExprV(stmt[2], ctx)
      if (ctx.fail) return null
      return ['local.set', laneName, v]
    }
    return liftFail(ctx, `local.set ${name}: loop-carried or unclassified local`)
  }

  if (STORE_OPS[op]) {
    const sty = STORE_OPS[op]
    // AoS de-interleave scatter: `(f64.store [offset=X] A V)` → tee the f64x2 V once, then
    // write lane 0 at X (pixel i) and lane 1 at X + P*elemSize (pixel i+1) — the exact two
    // scalar stores. Handles the folded `offset=` memarg form (channels d[j+1], d[j+2]).
    if (ctx.aosPixelStride > 1) {
      if (sty !== ctx.laneType) return liftFail(ctx, 'AoS narrowing store unsupported')
      let baseOff = 0, addr, val
      if (typeof stmt[1] === 'string' && stmt[1].startsWith('offset=')) { baseOff = parseInt(stmt[1].slice(7)) || 0; addr = stmt[2]; val = stmt[3] }
      else { addr = stmt[1]; val = stmt[2] }
      const v = liftExprV(val, ctx)
      if (ctx.fail) return null
      const delta = ctx.aosPixelStride * LANE_INFO.f64.stride
      const { a0, a1 } = aosAddrPair(addr, ctx)
      const vt = `$__aosv${ctx.freshIdRef.next++}`
      ctx.extraLocals.push(['local', vt, 'v128'])
      return ['__seq__',
        ['local.set', vt, v],
        aosStore(baseOff, a0, ['f64x2.extract_lane', 0, ['local.get', vt]]),
        aosStore(baseOff + delta, a1, ['f64x2.extract_lane', 1, ['local.get', vt]])]
    }
    const addr = stmt[1]  // we leave addresses as-is (scalar i32 expressions)
    // Handle memarg if present (last positional after addr/val): unlikely in
    // pre-watr IR for this shape; bail if more than 3 children.
    if (stmt.length !== 3) return liftFail(ctx, `${op} with memarg`)
    // Mirror store `a[INV − iv] = lane` (f64, 2 lanes): the vector's lanes
    // (iv, iv+1) mirror to (INV−iv, INV−iv−1) — one v128 store at INV−iv−1
    // with the f64 lanes SWAPPED. The scalar remainder keeps the plain form.
    if (ctx.laneType === 'f64' && sty === 'f64') {
      const mm = matchMirrorAddr(addr, ctx.incVar)
      if (mm) {
        const v = liftExprV(stmt[2], ctx)
        if (ctx.fail) return null
        const vt = `$__mirv${ctx.freshIdRef.next++}`
        ctx.extraLocals.push(['local', vt, 'v128'])
        const mAddr = ['i32.add', mm.base,
          ['i32.shl', ['i32.sub', ['i32.sub', mm.invExpr, ['local.get', ctx.incVar]], ['i32.const', 1]],
            ['i32.const', mm.strideLog2]]]
        return ['__seq__',
          ['local.set', vt, v],
          ['v128.store', mAddr,
            ['i8x16.shuffle', '8', '9', '10', '11', '12', '13', '14', '15', '0', '1', '2', '3', '4', '5', '6', '7',
              ['local.get', vt], ['local.get', vt]]]]
      }
    }
    // Narrowing store: a narrower element written from a wider float lane (`o[i] =
    // narrow(f(x))` — codec encode / downsample). The scalar store value carries a
    // conversion (f32.demote_f64, or the float→int ToInt32 idiom); peel it, lift the
    // inner float expr, and let narrowStore apply the SIMD narrow + low-byte store.
    if (sty !== ctx.laneType) {
      // Integer narrowing (`o[i] = (f(x)) | 0` into Int32Array/…) lowers via the saturating
      // i32x4.trunc_sat_f64x2_s_zero, which clamps +Inf / |x|≥2³¹ to INT_MAX where scalar
      // ToInt32 wraps mod 2³² — bit-exact for in-range finite values (every pixel/coordinate/
      // typical-DSP value), divergent only at that edge, so it rides relaxedSimd. Float demote
      // (f64→f32) is bit-exact (round-to-nearest both ways) and stays ungated.
      if (sty !== 'f32' && !vecState.relaxF32) return liftFail(ctx, `narrowing ${ctx.laneType}->${sty} store saturates out-of-range (needs relaxedSimd)`)
      const inner = peelNarrowConv(stmt[2], sty)
      if (!inner) return liftFail(ctx, `narrowing store ${ctx.laneType}->${sty}: unrecognized conversion`)
      const innerV = liftExprV(inner, ctx)
      if (ctx.fail) return null
      const ns = narrowStore(addr, innerV, ctx.laneType, sty, ctx)
      return ns || liftFail(ctx, `no narrowing ${ctx.laneType}->${sty}`)
    }
    const val = liftExprV(stmt[2], ctx)
    if (ctx.fail) return null
    return ['v128.store', addr, val]
  }

  // (block (result T) STMTS... TAIL_EXPR) followed by sibling "drop" — we get
  // the block alone here; the "drop" is a separate sibling and is returned as
  // null by the next call. Strip the wrapper, lift the inner stmts; the
  // dropped-tail expr is discarded.
  if (op === 'block') {
    // Block may be: ['block', LABEL?, RESULT?, ...stmts]
    let i = 1
    if (typeof stmt[i] === 'string' && stmt[i].startsWith('$')) i++
    const hasResult = isArr(stmt[i]) && stmt[i][0] === 'result'
    if (hasResult) i++
    const inner = stmt.slice(i)
    const stmts = hasResult ? inner.slice(0, inner.length - 1) : inner
    const out = ['__seq__']
    for (const s of stmts) {
      const lifted = liftStmt(s, ctx)
      if (ctx.fail) return null
      if (lifted == null) continue
      if (Array.isArray(lifted) && lifted[0] === '__seq__') out.push(...lifted.slice(1))
      else out.push(lifted)
    }
    return out
  }

  // Standalone conditional store: `if (COND) { …inter; store(addr,A) } [else { …inter; store(addr,B) }]`.
  // Both arms end in a store to the SAME address; a missing else keeps the current value. Speculatively
  // lift both arms (intermediate sets become lane locals; masked lanes are discarded — lane-pure ops
  // are trap-free) and emit ONE store of `bitselect(A, B, mask(COND))`. Unlocks per-pixel conditional
  // maps like lorenz's i32x4 trail fade (`if (p & 0xffffff) px[i] = fade(p)`).
  if (op === 'if' && isArr(stmt[2]) && stmt[2][0] === 'then') {
    // First: conditional lane-LOCAL assignment (clamp/saturation) → bitselect into the laned local.
    const laneLifted = tryLiftLaneIf(stmt, ctx)
    if (ctx.fail) return null
    if (laneLifted) return laneLifted
    const armOf = (arm) => {
      let body = arm.slice(1)
      if (body.length === 1 && isArr(body[0]) && body[0][0] === 'block') {   // unwrap a single block arm
        const b = body[0]; let i = 1
        if (typeof b[i] === 'string' && b[i].startsWith('$')) i++
        if (isArr(b[i]) && b[i][0] === 'result') i++
        body = b.slice(i)
      }
      const last = body[body.length - 1]
      if (!isArr(last) || !STORE_OPS[last[0]] || last.length !== 3) return null
      return { inter: body.slice(0, -1), addr: last[1], val: last[2], store: last[0] }
    }
    const thenA = armOf(stmt[2]), elseA = (isArr(stmt[3]) && stmt[3][0] === 'else') ? armOf(stmt[3]) : null
    if (!thenA || (isArr(stmt[3]) && !elseA)) return liftFail(ctx, 'if-store: arm is not a conditional store')
    if (elseA && (JSON.stringify(thenA.addr) !== JSON.stringify(elseA.addr) || thenA.store !== elseA.store)) return liftFail(ctx, 'if-store: arms store differently')
    // Speculation safety: an arm's `inter` statements (everything before its own tail store)
    // are lifted via the ORDINARY `liftStmt` dispatch below (`liftInter`) — which, for a bare
    // store, hits the UNCONDITIONAL `STORE_OPS` branch above (line ~3319), not this masked one.
    // A second store hiding in `inter` (`if (c) { out2[i]=f(x); out[i]=g(x) }`) would therefore
    // execute on EVERY lane regardless of `c` — silently wrong. `hasSideEffect` (store/call/
    // global.set) is the same predicate `matchBlockLoop`'s own preamble-clone gate already uses
    // for the identical "would this run unconditionally when it shouldn't" question; fail closed
    // (decline the whole if-store lift, not just the offending statement) rather than risk it.
    if (thenA.inter.some(hasSideEffect) || (elseA && elseA.inter.some(hasSideEffect)))
      return liftFail(ctx, 'if-store: arm has a side-effecting intermediate statement (would run unconditionally)')
    // mask from COND: a lane comparison, or (i32) a truthy test `lift(cond) != 0`.
    let cond = stmt[1]
    if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
    const cmp = isArr(cond) && cond.length === 3 ? LANE_COMPARE[ctx.laneType]?.[cond[0]] : null
    let mask
    if (cmp) { const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null; const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null; mask = [cmp, ca, cb] }
    else if (ctx.laneType === 'i32') { const lc = liftExprV(cond, ctx); if (ctx.fail) return null; mask = ['i32x4.ne', lc, ['i32x4.splat', ['i32.const', 0]]] }
    else return liftFail(ctx, 'if-store: non-comparison condition')
    // Mask FIRST (matches liftExprV's own `if`-ternary convention above): `mask` may embed a
    // `local.tee` (COND reads a shared address CSE'd with an arm's own load — e.g. a stencil's
    // condition-on-loaded-value `if (a[i] > 0) out[i] = a[i-1] ^ a[i+1]`, where `a[i]`'s address
    // tee lives inside COND and is READ by the arm via a plain `local.get` of that same name).
    // Emitting the mask's `local.set` statement BEFORE the arms' intermediates run guarantees the
    // tee has already fired by the time anything downstream reads it — matching scalar order
    // (COND evaluates before either arm, always). Pushing it LAST (the previous shape) let an
    // arm's OWN intermediate `local.set` (lifted via `liftInter`, which runs before this push)
    // read the address local's STALE prior-iteration value — a real miscompile for exactly the
    // shared-tee shape above.
    const mtmp = `$__mask${ctx.freshIdRef.next++}`
    ctx.extraLocals.push(['local', mtmp, 'v128'])
    const out = ['__seq__', ['local.set', mtmp, mask]]
    const liftInter = (arm) => { for (const s of arm.inter) { const l = liftStmt(s, ctx); if (ctx.fail) return false; if (l != null) { if (Array.isArray(l) && l[0] === '__seq__') out.push(...l.slice(1)); else out.push(l) } } return true }
    if (!liftInter(thenA)) return null
    if (elseA && !liftInter(elseA)) return null
    const thenVal = liftExprV(thenA.val, ctx); if (ctx.fail) return null
    const elseVal = elseA ? liftExprV(elseA.val, ctx) : ['v128.load', thenA.addr]   // no else ⇒ keep current value
    if (ctx.fail) return null
    out.push(['v128.store', thenA.addr, ['v128.bitselect', thenVal, elseVal, ['local.get', mtmp]]])
    return out
  }

  // Standalone expression-as-statement (e.g. a load that gets dropped) — bail.
  return liftFail(ctx, `standalone ${op} statement`)
}

// `f64.add(f64.convert_i32_{s,u}(A), f64.convert_i32_{s,u}(B))` — ES semantics for two i32-domain
// operands computed via jz's f64 fallback (opBound couldn't prove the native i32.add/sub path
// statically). The f64 op is always exact for this shape (both ±2³¹ operands and their sum/diff
// fit the 53-bit mantissa), so it lifts straight to i32x4.add/sub on the raw i32 operands — no
// i32.mul equivalent exists (its exact product can exceed the mantissa). Returns the lifted v128
// node or null (does NOT set ctx.fail — a non-matching shape is a normal decline, not an error).
function liftAddSubOfConverts(v, ctx) {
  if (!isArr(v) || (v[0] !== 'f64.add' && v[0] !== 'f64.sub') || v.length !== 3) return null
  const unconv = (n) => isArr(n) && (n[0] === 'f64.convert_i32_s' || n[0] === 'f64.convert_i32_u') && n.length === 2 ? n[1] : null
  const a = unconv(v[1]), b = unconv(v[2])
  if (!a || !b) return null
  const av = liftExprV(a, ctx); if (ctx.fail) return null
  const bv = liftExprV(b, ctx); if (ctx.fail) return null
  return [v[0] === 'f64.add' ? 'i32x4.add' : 'i32x4.sub', av, bv]
}

/** Lift a value expression into v128 context. */
export function liftExprV(expr, ctx) {
  if (!isArr(expr)) return liftFail(ctx, 'non-expression operand')
  const op = expr[0]
  const info = LANE_INFO[ctx.laneType]

  // Widening byte-map: a narrow UNSIGNED load feeding i32-lane arithmetic. Load
  // the 4 elements as a partial vector and zero-extend to i32x4. Only the
  // widening recognizer sets ctx.widenLoads; tryVectorize ties the lane type to
  // the load width and never reaches here with a narrow load under i32 lanes.
  if (ctx.widenLoads && ctx.laneType === 'i32') {
    if (op === 'i32.load8_u')
      return ['i32x4.extend_low_i16x8_u', ['i16x8.extend_low_i8x16_u', ['v128.load32_zero', expr[1]]]]
    if (op === 'i32.load16_u')
      return ['i32x4.extend_low_i16x8_u', ['v128.load64_zero', expr[1]]]
  }

  // Widening f32→f64 load: a Float32Array read promoted to f64 (`f64.promote_f32(f32.load …)`,
  // e.g. schrodinger's f32 potential `V[idx]` inside an f64 stencil). Load the 2 f32 lanes
  // (load64_zero = 8 bytes = V[idx],V[idx+1]) and promote to f64x2 — the consecutive pair the
  // two f64 lanes need. Only in f64-lane context; bit-exact (same promote the scalar does).
  if (op === 'f64.promote_f32' && ctx.laneType === 'f64' && isArr(expr[1]) && expr[1][0] === 'f32.load') {
    const ld = expr[1]
    const addr = typeof ld[1] === 'string' && ld[1].startsWith('offset=') ? ['v128.load64_zero', ld[1], ld[2]] : ['v128.load64_zero', ld[1]]
    return ['f64x2.promote_low_f32x4', addr]
  }

  // f32-lane: jz computes Float32Array arithmetic in f64, wrapping the f32 load in
  // `f64.promote_f32` and the result in `f32.demote_f64`. The promote/demote are
  // lane-space identities — strip them (a promote-of-load + demote round-trips
  // losslessly: a pure `b[i]=a[i]` copy vectorizes bit-exactly, always). The f64
  // arithmetic op and any f64 constant map to their f32x4 forms only under
  // relaxedSimd, since computing in f32 (vs f64-then-demote) drops sub-ulp precision.
  if (ctx.laneType === 'f32') {
    if (op === 'f64.promote_f32') return liftExprV(expr[1], ctx)
    if (op === 'f32.demote_f64') return liftExprV(expr[1], ctx)
    // int→f32 widening load: `f64.convert_i32_{s,u}(<intload>(addr))` → load 4 ints,
    // widen to i32x4, f32x4.convert. i8/i16 are exact in f32; i32 rounds (gated).
    if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && isArr(expr[1]) && INT_WIDEN_F32[expr[1][0]]) {
      const ld = expr[1], w = INT_WIDEN_F32[ld[0]]
      if (w.lossy && !vecState.relaxF32) return liftFail(ctx, `${ld[0]}→f32 SIMD rounds (i32 exceeds f32 mantissa) — needs relaxedSimd`)
      const addr = typeof ld[1] === 'string' && ld[1].startsWith('offset=') ? [w.load, ld[1], ld[2]] : [w.load, ld[1]]
      let v = addr
      for (const step of w.steps) v = [step, v]
      return [w.cvt === 'u' ? 'f32x4.convert_i32x4_u' : 'f32x4.convert_i32x4_s', v]
    }
    if (op === 'f64.const') {
      if (!vecState.relaxF32) return liftFail(ctx, 'f64 constant in f32 lane needs relaxedSimd (f32 round of the constant)')
      return ['f32x4.splat', ['f32.const', expr[1]]]
    }
    const f32op = F64_TO_F32X4[op]
    if (f32op) {
      if (!vecState.relaxF32) return liftFail(ctx, `${op}: f32 SIMD computes in f32 not f64 (sub-ulp) — needs relaxedSimd`)
      const a = liftExprV(expr[1], ctx); if (ctx.fail) return null
      if (expr.length === 2) return [f32op, a]                 // unary: neg / abs / sqrt
      const b = liftExprV(expr[2], ctx); if (ctx.fail) return null
      return [f32op, a, b]
    }
  }

  // Loads → v128.load (preserving address, including any local.tee).
  if (LOAD_OPS[op]) {
    if (LOAD_OPS[op] !== ctx.laneType) return liftFail(ctx, `${op}: load type ≠ lane type ${ctx.laneType}`)
    // AoS de-interleave: consecutive elements are DIFFERENT channels, so a plain v128.load
    // would mix channels — gather the same channel of pixels i, i+1 into the f64x2 instead.
    if (ctx.aosPixelStride > 1) return aosGather(expr, ctx)
    // memarg form `(T.load offset=N addr)` — the stencil neighbour `a[i+1]` jz folds
    // onto `a[i]`'s address tee. `v128.load offset=N` reads the N-byte-shifted vector,
    // i.e. the (a[i+1], a[i+2]) pair — exactly the δ-shifted lane data. Preserve it.
    if (typeof expr[1] === 'string' && expr[1].startsWith('offset=')) return ['v128.load', expr[1], expr[2]]
    return ['v128.load', expr[1]]
  }

  // Constants → splat.
  if (op === info.constOp) {
    return [info.splat, expr]
  }

  // local.get
  if (op === 'local.get' && typeof expr[1] === 'string') {
    const name = expr[1]
    // Induction variable used AS DATA (ramp-map) → splat to a ramp vector
    // [i, i+1, … i+LANES-1]. Only set by tryRampMap (i32 lanes); other
    // recognizers leave ctx.rampVar undefined, so the IV stays address-only.
    if (name === ctx.rampVar) {
      // The ramp [i, i+1, i+2, i+3] is materialized once per iteration into
      // ctx.rampTemp (set at the top of the lifted body); every use reads it.
      return ['local.get', ctx.rampTemp]
    }
    const kind = ctx.localKind.get(name)
    if (kind === 'lane') {
      const laneName = getOrAllocLanedLocal(name, ctx.newLanedLocals)
      return ['local.get', laneName]
    }
    if (kind === 'invariant') {
      // An invariant whose wasm type ≠ the lane element type needs a scalar
      // convert before the splat. The common case: an f64 multiplier/gain splat
      // into an f32 lane (`out[i] = in[i] * k`). Demoting k to f32 is the same
      // precision relaxation as the f32 arithmetic itself, so gate it on relaxedSimd.
      if (ctx.laneType === 'f32' && ctx.fnLocals?.get(name) === 'f64') {
        if (!vecState.relaxF32) return liftFail(ctx, `${name}: f64 invariant in f32 lane needs relaxedSimd`)
        return [info.splat, ['f32.demote_f64', ['local.get', name]]]
      }
      return [info.splat, ['local.get', name]]
    }
    if (kind === 'addr' || name === ctx.incVar) {
      return liftFail(ctx, `${name}: address/induction var used as lane data`)
    }
    // Unclassified (undefined) & not the IV/addr: a local introduced by an inlined pure callee —
    // read its lane shadow (the matching lane-set default above allocated it).
    return ['local.get', getOrAllocLanedLocal(name, ctx.newLanedLocals)]
  }

  // `(local.tee $x V)` in value position — a CSE temp inside a value expression (e.g. the base
  // teed for reuse in an inlined `x**(k/5)` fifthroot / a repeated subexpression). Lift V into the
  // lane shadow of $x and tee it: later `(local.get $x)` reads resolve to the same shadow.
  if (op === 'local.tee' && typeof expr[1] === 'string' && expr.length === 3) {
    const name = expr[1]
    const kind = ctx.localKind.get(name)
    if (kind === 'lane' || kind === undefined) {
      const v = liftExprV(expr[2], ctx); if (ctx.fail) return null
      return ['local.tee', getOrAllocLanedLocal(name, ctx.newLanedLocals), v]
    }
    return liftFail(ctx, `local.tee ${name}: non-lane local in value position`)
  }

  // Loop-invariant global (e.g. a hoistConstantPool'd const, or any global the
  // loop never writes) → splat. The recognizer bails when the body contains a
  // global.set, so every global.get reaching here is invariant across lanes.
  if (op === 'global.get' && typeof expr[1] === 'string') {
    return [info.splat, expr]
  }

  // `f64(invariant i32)` — e.g. `x[i] / N` with N an i32 global/invariant: the convert is a
  // loop-invariant scalar, so compute once and splat (== scalar-then-splat, bit-exact). Unblocks
  // pure-f64 maps that scale/divide by an integer count (rfft cepstrum `cep[i] = x[i] / N`).
  if ((op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u') && expr.length === 2) {
    const inner = expr[1]
    const inv = isArr(inner) && (inner[0] === 'global.get' || (inner[0] === 'local.get' && ctx.localKind.get(inner[1]) === 'invariant'))
    if (inv) return [info.splat, expr]
    // Sign / small-int ternary `cond ? A : B` (A,B integer literals) lowered to
    // `(f64.convert_i32_s (select (i32.const A) (i32.const B) COND))` — e.g. `a<0 ? -1 : 1`.
    // Convert the literals to f64 and bitselect by COND's lane mask (the f64-lane ternary).
    if (ctx.laneType === 'f64' && isArr(inner) && inner[0] === 'select' && inner.length === 4 &&
        isI32Const(inner[1]) && isI32Const(inner[2])) {
      let cond = inner[3]
      if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]
      const cmpS = isArr(cond) && cond.length === 3 ? LANE_COMPARE.f64?.[cond[0]] : null
      if (cmpS) {
        const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null
        const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null
        const mtmp = `$__mask${ctx.freshIdRef.next++}`
        ctx.extraLocals.push(['local', mtmp, 'v128'])
        return ['block', ['result', 'v128'],
          ['local.set', mtmp, [cmpS, ca, cb]],
          ['v128.bitselect', ['f64x2.splat', ['f64.const', inner[1][1]]], ['f64x2.splat', ['f64.const', inner[2][1]]], ['local.get', mtmp]]]
      }
    }
  }

  // i32 lane, ToIntN-store value expression: `a[i]+b[i]`/`a[i]-b[i]` on two FULL-RANGE i32
  // array elements can't prove i32.add/sub's fast path statically (opBound's magnitude-blind
  // default), so jz computes the op in f64 — exact, since both ±2³¹ operands and their sum/
  // diff always fit the 53-bit mantissa — and ToInt32-wraps the result back via wrapIntIR/
  // toI32's canon select. That wrap is mod-2³², EXACTLY i32.add/i32.sub's own wraparound
  // semantics (deliberately NOT extended to i32.mul: its exact 62-bit product can exceed the
  // f64 mantissa, so a rounded f64.mul then ToInt32 is NOT always the same value as i32.mul).
  // liftAddSubOfConverts recognizes the bare shape directly (the CSE'd-lane-local case is
  // pre-inlined into it by tryVectorize's body2 rewrite, above); the `select` case additionally
  // peels wrapIntIR/toI32's canon (peelNarrowConv, shared with the narrowing-store path below)
  // when the add/sub is still wrapped in it. Either way, skip the f64 round-trip entirely.
  if (ctx.laneType === 'i32') {
    const av = liftAddSubOfConverts(expr, ctx)
    if (av) return av
    if (op === 'select') {
      const peeled = peelNarrowConv(expr, 'i32')
      const pv = peeled && liftAddSubOfConverts(peeled, ctx)
      if (pv) return pv
    }
  }

  // NaN-canonicalization wrapper (float lanes only; integer lanes never carry
  // it). Both the flattened `select` form and the un-flattened `block` form
  // lift to a per-lane v128.bitselect — canonical value in NaN lanes, X
  // elsewhere — exactly reproducing the scalar canonicalization lane-by-lane.
  if (op === 'select') {
    // NaN-canonicalization idiom `(select C X (T.ne X X))` — FLOAT lanes only (an
    // integer lane never carries it, since no i32 value is NaN).
    if (ctx.laneType === 'f64' || ctx.laneType === 'f32') {
      const m = matchCanonSelect(expr, ctx.laneType)
      if (m) {
        const coreV = liftExprV(m.val, ctx)
        return ctx.fail ? null : liftCanon(coreV, m.C, ctx, info)
      }
    }
    // General `select(X, Y, COND)` (wasm: X if COND else Y) — jz lowers a value
    // ternary `COND ? X : Y` to this when both arms are cheap/pure. Lift to
    // v128.bitselect(X, Y, mask) like the `if` form below — valid for EVERY lane type
    // (i32 included: COND maps via LANE_COMPARE[laneType], NaN is irrelevant). Both
    // arms are lane-pure (recursion forbids stores/sets) and trap-free, so evaluating
    // both then selecting is sound. f32 lane promotes operands → f64.* compare → f32x4.
    if (expr.length === 4) {
      const cond = expr[3]
      const cmpOp = isArr(cond) && ctx.laneType === 'f32' && typeof cond[0] === 'string' && cond[0].startsWith('f64.') ? 'f32.' + cond[0].slice(4) : (isArr(cond) ? cond[0] : null)
      const cmpSimd = cmpOp && cond.length === 3 ? LANE_COMPARE[ctx.laneType]?.[cmpOp] : null
      if (!cmpSimd) return liftFail(ctx, `select condition ${isArr(cond) ? cond[0] : '?'} not a lane comparison`)
      const x = liftExprV(expr[1], ctx); if (ctx.fail) return null
      const y = liftExprV(expr[2], ctx); if (ctx.fail) return null
      const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null
      const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null
      const mtmp = `$__mask${ctx.freshIdRef.next++}`
      ctx.extraLocals.push(['local', mtmp, 'v128'])
      return ['block', ['result', 'v128'],
        ['local.set', mtmp, [cmpSimd, ca, cb]],
        ['v128.bitselect', x, y, ['local.get', mtmp]]]
    }
    return liftFail(ctx, 'non-canonical select (not a NaN-canon idiom)')
  }
  if ((ctx.laneType === 'f64' || ctx.laneType === 'f32') && op === 'block') {
    const m = matchCanonBlock(expr, ctx.laneType)
    if (m) { const coreV = liftExprV(m.core, ctx); return ctx.fail ? null : liftCanon(coreV, m.C, ctx, info) }
    // General value-block (a let-binding): `(block [label] (result T) …laneSets… TAILVALUE)`.
    // jz emits these for an inlined value function (e.g. `av ** e` → an exp∘log block). Lift the
    // intermediate lane-local sets, then the tail value. Sound ONLY when the block is straight-line
    // (no br/br_if/br_table/return targeting it — an early-exit can't be flattened) — bail otherwise.
    let bi = 1
    if (typeof expr[bi] === 'string') bi++
    if (isArr(expr[bi]) && expr[bi][0] === 'result') bi++
    const parts = expr.slice(bi)
    if (parts.length === 0 || parts.some(hasBranchOrReturn)) return liftFail(ctx, 'non-canonical value-block')
    const out = ['block', ['result', 'v128']]
    for (let k = 0; k < parts.length - 1; k++) {
      const l = liftStmt(parts[k], ctx); if (ctx.fail) return null
      if (l != null) { if (Array.isArray(l) && l[0] === '__seq__') out.push(...l.slice(1)); else out.push(l) }
    }
    const tail = liftExprV(parts[parts.length - 1], ctx); if (ctx.fail) return null
    out.push(tail)
    return out
  }

  // Conditional select — jz lowers `cond ? X : Y` to (if (result LT) COND (then X)
  // (else Y)). Lift to v128.bitselect(X, Y, mask), where mask is COND as an
  // all-ones/all-zeros lane comparison. Both branches are lane-pure (recursion
  // forbids stores/sets) and trap-free (no liftable op traps — int div/rem aren't
  // lane-pure), so speculatively evaluating both is safe; bitselect keeps the
  // chosen lane. The mask is hoisted to a temp and computed FIRST: bitselect
  // evaluates X,Y before its 3rd operand, but any address `local.tee` lives in
  // COND and must run before the branches read it (matching scalar order).
  if (op === 'if') {
    // jz lowers `cond ? X : Y` to (if (result T) COND (then X)(else Y)). In an f32
    // lane it computes in f64 (promote/demote around the store), so the `if` carries
    // `(result f64)` and COND is an `f64.*` compare — accept both, mapping to f32x4.
    // The branch values are f32-mapped by recursion; gated by relaxedSimd via those.
    const resTy = isArr(expr[1]) && expr[1][0] === 'result' ? expr[1][1] : null
    if (resTy !== ctx.laneType && !(ctx.laneType === 'f32' && resTy === 'f64')) return liftFail(ctx, 'conditional without lane-typed result')
    const thenN = expr[3], elseN = expr[4]
    // A branch is `(then …preludeSets… TAILVALUE)` — usually just the tail (length 2), but jz's
    // NaN-canonicalization of a negation tees the value first (`(then (set $t (neg a)) (canon $t))`),
    // so accept intermediate lane-local sets before the tail. Both branches evaluate speculatively
    // (lane-pure ⇒ trap-free); each tail is snapshotted into its own temp BEFORE the other branch's
    // prelude runs, so a shared prelude local can't clobber the already-computed value.
    if (!isArr(thenN) || thenN[0] !== 'then' || thenN.length < 2) return liftFail(ctx, 'malformed conditional then-branch')
    if (!isArr(elseN) || elseN[0] !== 'else' || elseN.length < 2) return liftFail(ctx, 'malformed conditional else-branch')
    let cond = expr[2]
    if (isArr(cond) && cond[0] === 'i32.ne' && isI32Const(cond[2]) && cond[2][1] === 0) cond = cond[1]  // strip `!= 0`
    // f32 lane: operands were promoted, so the compare is `f64.*` — use its f32x4 form
    // (operands are exact f32→f64 promotions, so the lane comparison is unchanged).
    const cmpOp = isArr(cond) && ctx.laneType === 'f32' && typeof cond[0] === 'string' && cond[0].startsWith('f64.') ? 'f32.' + cond[0].slice(4) : (isArr(cond) ? cond[0] : null)
    const cmpSimd = cmpOp && cond.length === 3 ? LANE_COMPARE[ctx.laneType]?.[cmpOp] : null
    if (!cmpSimd) return liftFail(ctx, `${isArr(cond) ? cond[0] : 'condition'}: not a lane-vectorizable comparison`)
    const ca = liftExprV(cond[1], ctx); if (ctx.fail) return null
    const cb = liftExprV(cond[2], ctx); if (ctx.fail) return null
    // Lift a branch: its prelude sets, then its tail value snapshotted into `outTmp`.
    const liftArm = (arm, outTmp) => {
      const out = []
      for (let i = 1; i < arm.length - 1; i++) {
        const l = liftStmt(arm[i], ctx); if (ctx.fail) return null
        if (l != null) { if (Array.isArray(l) && l[0] === '__seq__') out.push(...l.slice(1)); else out.push(l) }
      }
      const v = liftExprV(arm[arm.length - 1], ctx); if (ctx.fail) return null
      out.push(['local.set', outTmp, v])
      return out
    }
    const id = ctx.freshIdRef.next++
    const tv = `$__then${id}`, ev = `$__else${id}`, mtmp = `$__mask${id}`
    ctx.extraLocals.push(['local', tv, 'v128'], ['local', ev, 'v128'], ['local', mtmp, 'v128'])
    // Mask FIRST: COND may carry an address `local.tee` the branch values read, so it must run
    // before them (matching scalar order — COND evaluates before the taken branch).
    const maskSet = ['local.set', mtmp, [cmpSimd, ca, cb]]
    const thenSeq = liftArm(thenN, tv); if (ctx.fail) return null
    const elseSeq = liftArm(elseN, ev); if (ctx.fail) return null
    return ['block', ['result', 'v128'],
      maskSet, ...thenSeq, ...elseSeq,
      ['v128.bitselect', ['local.get', tv], ['local.get', ev], ['local.get', mtmp]]]
  }

  // Lane-pure op?
  const table = LANE_PURE[ctx.laneType]
  const entry = table?.get(op)
  if (entry) {
    const a = liftExprV(expr[1], ctx)
    if (ctx.fail) return null
    if (entry.shamtScalar) {
      // Second operand stays scalar i32 — must be const or invariant local.
      const b = expr[2]
      if (!isI32Const(b) && !(isArr(b) && b[0] === 'local.get' && ctx.localKind.get(b[1]) === 'invariant')) {
        return liftFail(ctx, `${op}: shift amount not a constant or loop-invariant`)
      }
      return [entry.simd, a, b]
    }
    if (expr.length === 2) {  // unary (neg, abs, sqrt)
      return [entry.simd, a]
    }
    const b = liftExprV(expr[2], ctx)
    if (ctx.fail) return null
    return [entry.simd, a, b]
  }

  // Transcendental call → its bit-exact f64x2 mirror (pow/exp/log/exp2/sin/cos/atan2/hypot).
  // f64 lane only (the *2/_v helpers are f64x2). SIMD_PINNED keeps the scalar target alive
  // through watr's single-caller inlining so the `call` node still exists at lift time.
  // `$__to_num` is a numeric coercion jz wraps around a helper param it couldn't prove is f64
  // (e.g. `decode(src[j])`), boxing it via `i64.reinterpret_f64` first. In the lane every value
  // is already a genuine finite f64, so `__to_num(reinterpret_i64(x)) == x` — lift straight
  // through, peeling the box round-trip.
  if (op === 'call' && expr[1] === '$__to_num' && expr.length === 3) {
    let arg = expr[2]
    if (isArr(arg) && arg[0] === 'i64.reinterpret_f64' && arg.length === 2) arg = arg[1]
    return liftExprV(arg, ctx)
  }

  // `$math.pow(x, c)` with a CONSTANT non-integer exponent, found only during vectorization
  // (`ctx.constLocals`) — e.g. spow's `av ** nv` after pure-function inlining substitutes the
  // literal (module/math.js's own `emitPow` const-exponent fold never reaches here: its constant
  // exponent is known at EMIT time, so it already lowers straight to the scalar const-exponent
  // path, picked up by the generic PPC_CALL2 lift below). `optimize.crPow` picks the lowering,
  // mirroring emitPow's own default/crPow split (see the authoritative comment above emitPow):
  //   OFF (DEFAULT): truly-2-wide `exp_v(c · log_v(x))` — bit-identical to the scalar `$math.pow`
  //     for EVERY x when c is non-integer (verified: negative base → NaN and x=0 → 0/∞ both carry
  //     through log/exp identically; only the integer fast path differs, and it is excluded).
  //   ON: the truly-2-wide correctly-rounded `$math.pow_fold_v` (module/math.js) — the SIMD twin
  //     of the scalar `$math.pow_fold` (c needs no pre-split; the shared kernel twoProd-splits
  //     both multiply operands internally — see its own comment). Bit-identical to the scalar
  //     `$math.pow_fold` for every x — same function, called on both lanes.
  if (op === 'call' && ctx.laneType === 'f64' && expr[1] === '$math.pow' && expr.length === 4) {
    const ex = expr[3]
    let c = null
    if (isArr(ex) && ex[0] === 'f64.const') c = +ex[1]
    else if (isArr(ex) && ex[0] === 'local.get' && ctx.constLocals && ctx.constLocals.has(ex[1])) c = ctx.constLocals.get(ex[1])
    if (c != null && Number.isFinite(c) && !Number.isInteger(c)) {
      const base = liftExprV(expr[2], ctx); if (ctx.fail) return null
      if (vecState.crPow) {
        return ['call', '$math.pow_fold_v', base, ['f64x2.splat', ['f64.const', c]]]
      }
      return ['call', '$math.exp_v', ['f64x2.mul', ['f64x2.splat', ex], ['call', '$math.log_v', base]]]
    }
  }

  if (op === 'call' && ctx.laneType === 'f64' && PPC_CALL2[expr[1]]) {
    const args = []
    for (let i = 2; i < expr.length; i++) { const a = liftExprV(expr[i], ctx); if (ctx.fail) return null; args.push(a) }
    return ['call', PPC_CALL2[expr[1]], ...args]
  }

  // Pure user-function call → inline its body as a value-expr and lift that (handles the callee's
  // ternaries/compares/pow via the arms above). Depth-guarded against pure→pure recursion.
  if (op === 'call' && ctx.laneType === 'f64' && ctx.pureFuncMap && ctx.pureFuncMap.has(expr[1]) && ctx.inlineDepth < 8) {
    const inlined = inlinePureCallExpr(expr, ctx.pureFuncMap, ctx.freshIdRef)
    if (inlined != null) {
      ctx.inlineDepth++
      const v = liftExprV(inlined, ctx)
      ctx.inlineDepth--
      return v
    }
  }

  return liftFail(ctx, `${op}: no lane-pure SIMD mapping for ${ctx.laneType}`)
}

// ---- Induction-variable strength reduction --------------------------------

// Match `(i32.add (local.get $base) (i32.shl (local.get $ind) (i32.const K)))` in either
// operand order, or `(i32.add (local.get $base) (local.get $ind))` (K=0). Returns
// {base, k} — the address of element $ind in array $base, byte stride 1<<k — or null.
// Thin wrapper over matchLaneAddr (tee/CSE/AoS-free); both operand orders + bare-local base are this fn's own residual.

export function peelNarrowConv(val, sty) {
  if (!isArr(val)) return null
  if (sty === 'f32') return val[0] === 'f32.demote_f64' ? val[1] : null
  // int element (i8/i16/i32): peel ToInt32 (`x | 0`). jz's general lowering is an
  // Infinity-guarded saturating trunc:
  //   (select (i32.wrap_i64 (i64.trunc_sat_f64_s X)) (i32.const 0) (f64.ne X' Inf))
  // where X is `(local.tee $inf <f64 expr>)` and X' the matching get. Peel to the inner f64.
  // (The SIMD narrow i32x4.trunc_sat_f64x2_s_zero saturates +Inf / |x|≥2³¹ to INT_MAX where
  // ToInt32 wraps mod 2³² — caller gates the int narrowing on relaxedSimd for that edge.)
  if (val[0] === 'select' && val.length === 4 && isI32Const(val[2]) && val[2][1] === 0 &&
      isArr(val[1]) && val[1][0] === 'i32.wrap_i64' && isArr(val[1][1]) && val[1][1][0] === 'i64.trunc_sat_f64_s') {
    let inner = val[1][1][1]   // the f64 operand of the trunc, captured in a `(local.tee $inf …)`
    if (isArr(inner) && inner[0] === 'local.tee' && inner.length === 3) inner = inner[2]   // peel to the tee's VALUE
    return inner
  }
  // wrapIntIR (module/typedarray.js) — the unified ES ToIntN store idiom (same
  // outer shape as toI32's guarded select, sign-branched inner):
  //   (select (i32.wrap_i64 (select (sat_s X) (sat_u X) (lt X 0))) (i32.const 0) (ne X Inf))
  // narrowStore's f32→i8/i16 pack re-establishes the +Inf→0 lane semantics.
  if (val[0] === 'select' && val.length === 4 && isI32Const(val[2]) && val[2][1] === 0 &&
      isArr(val[1]) && val[1][0] === 'i32.wrap_i64' && isArr(val[1][1]) && val[1][1][0] === 'select') {
    const sel = val[1][1]
    const s = isArr(sel[1]) && sel[1][0] === 'i64.trunc_sat_f64_s' ? sel[1][1] : null
    const u = isArr(sel[2]) && sel[2][0] === 'i64.trunc_sat_f64_u' ? sel[2][1] : null
    if (s && u && exprEq(s, u)) return s
  }
  if (val[0] === 'i32.trunc_sat_f64_s' || val[0] === 'i32.trunc_sat_f64_u') return val[1]
  // Bare wrap-through-i64 (asI32's boundary coercion — ES ToInt32 wrap, no guard).
  if (val[0] === 'i32.wrap_i64' && isArr(val[1]) && val[1][0] === 'i64.trunc_sat_f64_s') return val[1][1]
  return null
}

// i8x16.shuffle masks that pack a 4×i32 vector down to the low bytes of each lane
// (truncating-wrap = scalar store{8,16}), tail zero-filled: _I16 keeps the low 2
// bytes of each lane (→ 8 bytes / i64.store), _I8 the low byte (→ 4 bytes / i32.store).
const PACK_I32_TO_I16 = [0, 1, 4, 5, 8, 9, 12, 13, 0, 0, 0, 0, 0, 0, 0, 0]
const PACK_I32_TO_I8 = [0, 4, 8, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

function narrowStore(addr, val, laneType, sty, ctx) {
  const tmp = `$__nv${ctx.freshIdRef.next++}`
  ctx.extraLocals.push(['local', tmp, 'v128'])
  const g = ['local.get', tmp]
  const sh = (idx) => ['i8x16.shuffle', ...idx.map(String), g, g]
  const sets = []
  let pre, lane8, store
  if (laneType === 'f64' && sty === 'f32') { pre = ['f32x4.demote_f64x2_zero', val]; lane8 = g; store = 'i64.store' }
  else if (laneType === 'f64' && sty === 'i32') { pre = ['i32x4.trunc_sat_f64x2_s_zero', val]; lane8 = g; store = 'i64.store' }
  else if (laneType === 'f32' && (sty === 'i16' || sty === 'i8')) {
    // Scalar integer stores are wrapIntIR ToIntN: a +Inf lane stores 0 where the
    // saturated lane packs to -1 (INT32_MAX's low bytes). andnot the lanes equal
    // to +∞ (0x7F800000 as f32 bits) so the low-byte pack stays bit-identical to
    // the scalar loop at EVERY input, not just finite ones. -Inf (INT32_MIN, low
    // bytes 0) and NaN (trunc_sat → 0) lanes already agree.
    const vt = `$__nvi${ctx.freshIdRef.next++}`
    ctx.extraLocals.push(['local', vt, 'v128'])
    const vg = ['local.get', vt]
    sets.push(['local.set', vt, val])
    pre = ['v128.andnot', ['i32x4.trunc_sat_f32x4_s', vg],
      ['f32x4.eq', vg,
        ['v128.const', 'i32x4', '2139095040', '2139095040', '2139095040', '2139095040']]]
    lane8 = sh(sty === 'i16' ? PACK_I32_TO_I16 : PACK_I32_TO_I8)
    store = sty === 'i16' ? 'i64.store' : 'i32.store'
  }
  else return null
  // 8-byte stores extract an i64 lane; the 4-byte i8 pack extracts an i32 lane.
  const packed = store === 'i64.store' ? ['i64x2.extract_lane', 0, lane8] : ['i32x4.extract_lane', 0, lane8]
  return ['block', ...sets, ['local.set', tmp, pre], [store, addr, packed]]
}

