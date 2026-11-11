/**
 * WASM local typing + typed-array metadata + integer proofs.
 *
 * - exprType: i32 vs f64 for locals/params
 * - typedElemCtor: direct typed-array construction (composite provenance lives
 *   in typed-provenance.js; the pure PTR.TYPED aux codec lives in layout.js)
 * - scanBoundedLoops / inBoundsCharCodeAt: charCodeAt i32 contract proof
 * - loop unroll helpers: smallConstForTripCount, cloneWithSubst, …
 * - intCertainMaps: integer-shaped binding analysis
 *
 * ── NUMERIC WIDENING INVARIANT (shared contract with emit.js) ──
 * "When does i32 arithmetic stay i32 vs widen to f64" is decided in TWO places
 * that must agree: emit.js DECIDES (emits `i32.mul`/`i32.add` or widens),
 * exprType here MIRRORS (predicts the same i32/f64 so locals are typed right).
 * They cannot share one function (emit reads IR values via isLit/maskBound,
 * type reads AST via staticValue/intExprRange) but they MUST share these rules
 * — edit one side only with the other open beside it:
 *
 * 1. SOUNDNESS DIRECTION (one-way, unforgiving): exprType's i32 verdict must
 *    be a SUBSET of emit's — answer i32 only where emit DEFINITELY produces
 *    i32. If type says i32 but emit yields f64, the value is trunc_sat-
 *    narrowed back → silent miscompile.
 * 2. `*` RULE: i32.mul is faithful only when the EXACT product provably fits
 *    signed i32 — a magnitude bound on BOTH operands, product ≤ 2^31−1
 *    (emit.js `mulFitsI32` via opBound; here via intExprRange). f64-exactness
 *    (≤2^53) is NOT sufficient: an f64-exact product can still wrap i32.mul.
 * 3. `+`/`-` TWO-TIER: the magnitude-blind "both operands i32 ⇒ i32" answer is
 *    a local's PROVISIONAL carrier only, never its storage: a word read back
 *    is not the sum JS holds. Callers that need the value itself (emission's
 *    i32.add, a result, an argument) pass `strict=true`, which adds `*`'s
 *    magnitude bound (emit.js `addFitsI32`: opBound(a)+opBound(b) ≤ 2^31−1;
 *    the triangle inequality covers `-`).
 * 4. STORAGE RULE: a local is a word where the interval proof finds every
 *    number it holds over its lifetime one, or where it holds integers and
 *    every read re-applies ToInt32 (`collectBareEscapes`, analyze-scans.js,
 *    the authority the local and the module-global decisions consult); a
 *    Number otherwise (compile/analyze/body-facts.js widenLocalTypes).
 *
 * Stable barrel — every name below lived directly in this file before the
 * `type/` split (`.work/archive/type-split.md`); every consumer import is unchanged.
 * The real implementations live in `type/*.js`, grouped by family:
 * `canonical-bounds.js` (charCodeAt/array-idx canonical single-loop proof),
 * `interval-proof.js` (the interval abstract interpreter), `loop-unroll.js`
 * (AST shape predicates + trip-count arithmetic), `clone.js` (AST clone +
 * proof carry-over), `loop-versioning.js` / `loop-versioning-nest.js`
 * (single-loop and nest-level typed-array versioning), `expr-type.js`
 * (`exprType`), `int-certain.js` (the integer-certainty fixpoint lattice).
 *
 * @module type
 */
export { typedElemCtor } from './typed-provenance.js'
export {
  idxKey, isUnitIncrement, scanBoundedLoops, inBoundsCharCodeAt,
  scanBoundedArrIdx, inBoundsArrIdx,
} from './type/canonical-bounds.js'
export {
  MAX_SMALL_FOR_UNROLL, MAX_NESTED_FOR_UNROLL, containsNestedClosure, containsNestedLoop,
  nestedSmallLoopBudget, containsDeclOf, containsKnownTypedArrayIndex, sumsTypedElements, smallConstForTripCount,
  isTerminator,
} from './type/loop-unroll.js'
export { intLevelMap, intCertainMaps, intLevelChecker } from './type/int-certain.js'
export { exprType, wholeKey, wholeOrMissKey } from './type/expr-type.js'
export { cloneWithSubst } from './type/clone.js'
export {
  typedStaticLen, typedIdxProven, typedIdxWhole, SLOT_OPS, isCondExpr,
} from './type/loop-versioning.js'
export { versionableTypedNest } from './type/loop-versioning-nest.js'
