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
 * `+`/`-`'s TWO-TIER EXCEPTION (2026-08-02, P0-2 sibling fix): exprType's `+`/`-` case
 * takes a `strict` parameter (default false) that `*`/`%` don't need. Magnitude-blind
 * ("both operands i32 ⇒ i32", no bound on the SUM) is the DEFAULT and is itself sound
 * for the overwhelming majority of exprType's callers — local/param STORAGE-type
 * decisions, where a value merely typed i32 is safe regardless of magnitude because
 * every READ of that storage re-applies the same ToInt32 the WRITE did (ir.js
 * writeVar/asParamType now route i32 targets through `toI32`, not `asI32`, so this
 * is enforced, not just claimed — see ir.js's own docstring on that swap). Only the
 * few callers deciding whether a value may escape BARE (no further ToInt32 sink —
 * narrowI32Results' return-tail classification, tryI32Arith's own admission) pass
 * `strict=true`, which layers the SAME magnitude-bound check `*` always applies.
 * Mirroring `*`'s always-strict rule onto `+`/`-` UNCONDITIONALLY (the naive fix)
 * costs 8/10 perf-ratchet benchmarks (`s=s+f(...)`, `arr[i]+1` — the hottest, most
 * common shapes this compiler exists to make fast); `*`'s equivalent loss never
 * showed up because multiplicative accumulation is comparatively rare. See
 * emit.js `tryI32Arith` and .work/todo.md's own P0-2 sibling entry for the full
 * bisection that found this.
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
 * SIBLING FIXED (2026-08-02, same day as the `*` fix above, .work/todo.md):
 * `+`/`-`'s OWN bare fast path (emit.js `isI32Num(va)&&isI32Num(vb)` → native
 * `i32.add`/`i32.sub`, UNCONDITIONALLY) and `compoundAssign`'s `*=`/`+=`/`-=`
 * fast path had NO magnitude gate at all — not even this module's old, unsound
 * one. Two full-range i32 operands CAN sum past ±2^31 (confirmed live before
 * the fix: `(a|0)+(b|0)` for a=b=2^31−1 returned -2, not the true 4294967294).
 * FIX: `addFitsI32 = opBound(a)+opBound(b) ≤ 2^31−1` (emit.js, reuses `opBound`
 * verbatim — triangle inequality covers both `+` and `-` with one predicate)
 * gates the primary fast path; `compoundAssign` gated identically, dispatched
 * on `arithOp`. See the two-tier exprType exception above for why the type.js
 * mirror needed a `strict` parameter instead of `*`'s unconditional rule, and
 * ir.js's `asI32`→`toI32` note for the companion fix that made it ratchet-
 * neutral. KNOWN GAP (not closed by this fix, separate root cause): a compound
 * assign on a local back-propagated to i32 storage via an array-index feeder
 * (`collectI32SafeIndexVars`, src/compile/analyze-scans.js) still wraps when
 * read bare elsewhere — that storage-type decision, not this predicate, is
 * the actual cause; see .work/todo.md's KNOWN GAP #1.
 */
