/**
 * Numeric widening thresholds — the SINGLE SOURCE for "when does an i32 arithmetic
 * op stay i32 vs widen to f64", shared by the two phases that must agree:
 *   • emit.js  DECIDES  — emits `i32.mul`/`i32.add` or widens to `f64.mul`/`f64.add`
 *   • type.js  MIRRORS  — exprType predicts the same i32/f64 so locals are typed right
 *
 * SOUNDNESS INVARIANT (one-way, unforgiving): exprType's i32 verdict must be a SUBSET
 * of emit's — exprType may answer i32 only where emit DEFINITELY produces i32. If type
 * says i32 but emit yields f64, the result is `trunc_sat`-narrowed back to i32 → silent
 * miscompile. The two predicates can't share a function (emit reads IR values via
 * isLit/maskBound, type reads AST via staticValue), but they MUST share this threshold,
 * or a future edit to one silently drifts the other out of the safe subset.
 *
 * @module widen
 */

// JS `*` is an f64 multiply; `i32.mul` agrees only while the exact product stays
// f64-exact (|product| ≤ 2^53). Against the full i32 range (2^31) of one operand, the
// other must be bounded |v| ≤ 2^22 for the product to hold within 2^53 — so a literal
// or provably-masked operand of that magnitude keeps the multiply on `i32.mul`.
export const FITS_I32_MAX = 0x400000  // 2^22
