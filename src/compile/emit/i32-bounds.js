/**
 * i32-overflow-safety proofs for +/-/* (opBound, mulFitsI32/mulBoundedFaithful/mulRangeFitsI32, addFitsI32/addBoundedFaithful/addRangeFitsI32, subRangeFitsI32, addLiteralFitsI32/subLiteralFitsI32) plus the loop-guard-hull channel (loopGuardHi/boundedHi/boundedLo) - shared by Assignment's compoundAssign, Arithmetic's +/-/*, and control-flow's 'for' (via loopGuardHi).
 *
 * @module compile/emit/i32-bounds
 */

import { ctx } from '../../ctx.js'
import { isLit, litVal, maskBound } from '../../ir.js'
import { repOf } from '../../reps.js'
import { constIntExpr, intExprRange } from '../../static.js'


// JS `*` is an f64 multiply; `i32.mul` yields only the exact product mod 2^32.
// Those agree under a ToInt32/ToUint32 sink — but as a PLAIN NUMBER (no further
// truncating consumer), `i32.mul` is faithful only when the exact product itself
// providably fits signed i32 (±(2^31−1)); a wrapped-but-f64-exact product (the OLD
// rule this replaced: one operand ≤ 2^22, the OTHER left fully unbounded) is
// NOT the same thing — `i32.mul` truncates mod 2^32 regardless of how small the
// exact product would stay in f64, so an unguarded operand can carry the true
// product past ±2^31 and the wrap corrupts any consumer that widens the i32
// result straight to f64 (P0-2 ledger: `4194304 * (x|0)` returned bare, or
// `(x|0) * (y&63)` returned bare — both wrap to a wrong NUMBER at HEAD).
// BOTH operands need a real magnitude bound — a literal's own |value|, or a
// masked/narrowed expression's `maskBound` (ir.js; already used for the masked-
// scale case) — and it's the PRODUCT of those bounds, not either alone, that
// must clear the i32 ceiling. `maskBound` defaults to the full i32 magnitude
// (2**31) for anything it can't prove tighter, so an unguarded operand costs
// the full range in the product check, exactly as it should.
const opBound = (v) => isLit(v) ? Math.abs(litVal(v)) : maskBound(v)
export const mulFitsI32 = (va, vb) => opBound(va) * opBound(vb) <= 0x7fffffff

// Max |value| of an i32-typed operand from a narrowing typed-array load width — the
// element-read twin of maskBound's `x & 0xff` case (load8_u and `x & 0xff` carry the
// SAME [0,255] range). Infinity when the magnitude is unbounded. Signed loads reach
// −2^(w−1), so the magnitude bound is 2^(w−1).
const I32_LOAD_MAG = { 'i32.load8_s': 128, 'i32.load8_u': 255, 'i32.load16_s': 32768, 'i32.load16_u': 65535 }
export const i32Mag = (v) =>
  !Array.isArray(v) ? Infinity :
  v[0] in I32_LOAD_MAG ? I32_LOAD_MAG[v[0]] :
  (v[0] === 'i32.const' && typeof v[1] === 'number') ? Math.abs(v[1]) :
  (v[0] === 'i32.and' || v[0] === 'i32.shr_u') ? maskBound(v) :
  Infinity
// `int8[i]*int8[j]` and friends: a product of two range-bounded integer typed-array
// elements whose magnitudes multiply to ≤ 2^31−1 is FAITHFUL as i32.mul — the exact
// product fits signed i32, so i32.mul == the true value in EVERY consumer context
// (i32 sink AND f64 value), independent of the widen pass. Covers i8/u8/i16 pairs and
// i16×u16 (32768·65535 < 2^31); correctly EXCLUDES u16×u16 (65535² > 2^31). JS `*` of
// two such reads — the int-conv / correlation / quantised-MAC kernel shape — then rides
// the i32 ABI (one op, no f64 round-trip) on V8 / JSC / wasmtime alike, and the i32
// product is lane-vectorizable where the f64 form was not.
export const mulBoundedFaithful = (va, vb) => i32Mag(va) * i32Mag(vb) <= 0x7fffffff
// AST-level range twin (intExprRange resolves const names + ranged decl reps):
// the EXACT product interval must fit signed i32 — then i32.mul is faithful in
// every consumer context, same contract as mulBoundedFaithful. Keeps exprType's
// range-proven i32 verdict (type.js `*`) in lock-step at the emit site.
export const mulRangeFitsI32 = (aAst, bAst) => {
  const ra = intExprRange(aAst), rb = intExprRange(bAst)
  if (!ra || !rb) return false
  const p = [ra[0] * rb[0], ra[0] * rb[1], ra[1] * rb[0], ra[1] * rb[1]]
  return Math.min(...p) >= -0x80000000 && Math.max(...p) <= 0x7fffffff
}
export const addFitsI32 = (va, vb) => opBound(va) + opBound(vb) <= 0x7fffffff
export const addBoundedFaithful = (va, vb) => i32Mag(va) + i32Mag(vb) <= 0x7fffffff
export const addRangeFitsI32 = (aAst, bAst) => {
  const ra = intExprRange(aAst), rb = intExprRange(bAst)
  return !!ra && !!rb && ra[0] + rb[0] >= -0x80000000 && ra[1] + rb[1] <= 0x7fffffff
}
export const subRangeFitsI32 = (aAst, bAst) => {
  const ra = intExprRange(aAst), rb = intExprRange(bAst)
  return !!ra && !!rb && ra[0] - rb[1] >= -0x80000000 && ra[1] - rb[0] <= 0x7fffffff
}

// Loop-guard hull channel (sibling to the loop-analysis hull channel's
// forCounterRange): `while (name < bound)` / `for (…; name < bound; …)` proves
// an upper bound for `name` for the DURATION the guard has just passed and
// `name` hasn't been written since — unlike forCounterRange's whole-body
// induction hull (sound only for a monotone counter with a known init/step),
// this needs NEITHER: it's a per-EMISSION-POSITION fact, torn down the moment
// (in emission order — which matches evaluation order for straight-line code
// and both arms of a branch) a write to `name` is emitted (see writeVar's
// invalidation, ir.js). A comparison textually inside the loop body BEFORE
// any write to `name` (heapify's `if (child + 1 < n && …) child++` — the
// guard's own condition, read before its consequent's `child++` runs) sees
// the fact; anything after the first write does not. Keyed by NAME (not AST
// position) — nesting is handled by ordinary save/restore, same discipline as
// withRefinements, just on a dedicated map so it never interacts with the
// scope-lifetime `ctx.func.refinements` channel (whose own reassignment
// refusal this deliberately bypasses, being sound for a different reason).
export const loopGuardHi = () => (ctx.types.loopGuardHi ??= new Map())

/** Bare-name (or AST) upper bound ONLY — tolerates an unknown/unbounded lower
 *  side, unlike intExprRange's two-sided contract. Sound to use standalone
 *  (not as an intExprRange replacement) exactly where the caller only needs
 *  the upper side — see addLiteralFitsI32's doc for why that's enough for a
 *  known-sign literal addend. */
function boundedHi(n) {
  if (typeof n !== 'string') { const r = intExprRange(n); return r ? r[1] : null }
  const rf = ctx.func?.refinements?.get(n)
  const rep = repOf(n)?.range
  let hi = rep ? rep[1] : Infinity
  if (rf?.rhi != null && rf.rhi < hi) hi = rf.rhi
  const gh = ctx.types.loopGuardHi?.get(n)
  if (gh != null && gh < hi) hi = gh
  return Number.isFinite(hi) ? hi : null
}
/** Symmetric lower-bound-only resolver (subtraction's mirror of boundedHi) — no
 *  loop-guard-hull consumer today (sort's surgery site is `+`), kept parallel
 *  for the `x - k` shape a `while(name > bound)`-style guard would feed. */
function boundedLo(n) {
  if (typeof n !== 'string') { const r = intExprRange(n); return r ? r[0] : null }
  const rf = ctx.func?.refinements?.get(n)
  const rep = repOf(n)?.range
  let lo = rep ? rep[0] : -Infinity
  if (rf?.rlo != null && rf.rlo > lo) lo = rf.rlo
  const gl = ctx.types.loopGuardLo?.get(n)
  if (gl != null && gl > lo) lo = gl
  return Number.isFinite(lo) ? lo : null
}
// `X + k` (k a compile-time integer constant) can ONLY overflow i32 at the
// extreme the addend pushes TOWARD: a positive k risks the TOP edge
// (I32_MAX), a negative k risks the BOTTOM edge (I32_MIN) — the OTHER edge
// moves AWAY from, so it needs no bound at all. This is why a ONE-SIDED
// resolver (boundedHi/boundedLo) suffices here where addRangeFitsI32 needs a
// full closed hull on BOTH operands: X's un-provable far side is provably
// irrelevant for THIS specific shape, not assumed away.
export const addLiteralFitsI32 = (aAst, bAst) => {
  const k = constIntExpr(bAst)
  if (k == null || !Number.isInteger(k)) return false
  if (k >= 0) { const hi = boundedHi(aAst); return hi != null && hi + k <= 0x7fffffff }
  const lo = boundedLo(aAst); return lo != null && lo + k >= -0x80000000
}
export const subLiteralFitsI32 = (aAst, bAst) => {
  const k = constIntExpr(bAst)
  if (k == null || !Number.isInteger(k)) return false
  if (k >= 0) { const lo = boundedLo(aAst); return lo != null && lo - k >= -0x80000000 }
  const hi = boundedHi(aAst); return hi != null && hi - k <= 0x7fffffff
}
