/**
 * Numeric widening invariant — the SINGLE SOURCE for "when does an i32 arithmetic
 * op stay i32 vs widen to f64", shared by the two phases that must agree:
 *   • emit.js  DECIDES  — emits `i32.mul`/`i32.add` or widens to `f64.mul`/`f64.add`
 *   • type.js  MIRRORS  — exprType predicts the same i32/f64 so locals are typed right
 *
 * SOUNDNESS INVARIANT (one-way, unforgiving): exprType's i32 verdict must be a SUBSET
 * of emit's — exprType may answer i32 only where emit DEFINITELY produces i32. If type
 * says i32 but emit yields f64, the result is `trunc_sat`-narrowed back to i32 → silent
 * miscompile. The two predicates can't share a function (emit reads IR values via
 * isLit/maskBound, type reads AST via staticValue/intExprRange), but they MUST share
 * this rule, or a future edit to one silently drifts the other out of the safe subset.
 *
 * `*` RULE (fixed 2026-08-02, P0-2 ledger — was the FITS_I32_MAX=2^22 "one operand
 * small, other side left fully unbounded" heuristic below): JS `*` is an f64 multiply;
 * `i32.mul` reproduces it faithfully as a PLAIN NUMBER only when the EXACT product
 * provably fits signed i32 (±(2^31−1)) — not merely "f64-exact" (≤2^53). `i32.mul`
 * always truncates mod 2^32 first; a product that's small enough to represent exactly
 * in f64 (|product| ≤ 2^53) can still overflow i32 (2^31) and wrap to the wrong value
 * the instant a consumer widens the i32 result straight to f64 (no further ToInt32
 * sink to absorb the wrap — verified live: `4194304 * (x|0)` returned bare, and
 * `(x|0) * (y&63)` returned bare, both wrapped to the wrong NUMBER at HEAD). The old
 * FITS_I32_MAX=2^22 constant tested the WRONG bound (f64-exactness of one side against
 * the other's full i32 range, product ≤ 2^53) for this use — see emit.js `mulFitsI32`
 * (now `opBound(a) * opBound(b) ≤ 2^31−1`, a magnitude bound on BOTH operands) and
 * type.js's mirrored `*` case (now `intExprRange` on both operands, same product
 * ceiling). No shared constant remains for this rule — each side derives its own
 * operand bound (IR `maskBound` / AST `intExprRange`) and checks their PRODUCT.
 * `mulBoundedFaithful` (typed-array-element magnitude products) and
 * `mulRangeFitsI32` (AST range-hull products) were already sound — both always
 * required a bound on BOTH sides; only this single-sided heuristic was the bug.
 *
 * SIBLING FINDING, NOT FIXED HERE (P0-2 ledger, .work/todo.md): `+`/`-`'s OWN
 * bare fast path (emit.js `isI32Num(va)&&isI32Num(vb)` → native `i32.add`/
 * `i32.sub`) and `compoundAssign`'s `*=`/`+=`/`-=` fast path have NO magnitude
 * gate at all — not even this module's old, unsound one. Two full-range i32
 * operands CAN sum past ±2^31 (confirmed live: `(a|0)+(b|0)` for a=b=2^31−1
 * returns -2, not the true 4294967294) and a compound `*=` inherits the exact
 * same risk as the bare `*` this file fixes. Out of THIS fix's scope (separate
 * mechanisms, need their own repro/gate cycle) — flagged, not patched.
 */
