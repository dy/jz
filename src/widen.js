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
 * `+`/`-`'s TWO-TIER EXCEPTION: exprType's `+`/`-` case takes a `strict` parameter
 * (default false) that `*`/`%` don't need. Magnitude-blind ("both operands i32 ⇒
 * i32", no bound on the SUM) is the DEFAULT and is itself sound for the overwhelming
 * majority of exprType's callers — local/param STORAGE-type decisions, where a value
 * merely typed i32 is safe regardless of magnitude because every READ of that storage
 * re-applies the same ToInt32 the WRITE did (ir.js writeVar/asParamType route i32
 * targets through `toI32`, not `asI32`, so this is enforced, not just assumed — see
 * ir.js's own docstring on that distinction). Only the few callers deciding whether a
 * value may escape BARE (no further ToInt32 sink — narrowI32Results' return-tail
 * classification, tryI32Arith's own admission) pass `strict=true`, which layers the
 * SAME magnitude-bound check `*` always applies. Mirroring `*`'s always-strict rule
 * onto `+`/`-` unconditionally is NOT an option: it costs perf-ratchet benchmarks on
 * the hottest, most common accumulation shapes this compiler exists to make fast
 * (`s=s+f(...)`, `arr[i]+1`); `*`'s equivalent loss doesn't apply because
 * multiplicative accumulation is comparatively rare. See emit.js `tryI32Arith`.
 *
 * `*` RULE: JS `*` is an f64 multiply; `i32.mul` reproduces it faithfully as a PLAIN
 * NUMBER only when the EXACT product provably fits signed i32 (±(2^31−1)) — not
 * merely "f64-exact" (≤2^53). `i32.mul` always truncates mod 2^32 first, so a product
 * small enough to represent exactly in f64 can still overflow i32 and wrap to the
 * wrong value the instant a consumer widens the i32 result straight to f64 (no
 * further ToInt32 sink to absorb the wrap). The bound must be checked on BOTH
 * operands' magnitude, not one side's f64-exactness against the other's full i32
 * range: emit.js `mulFitsI32` (`opBound(a) * opBound(b) ≤ 2^31−1`) and type.js's
 * mirrored `*` case (`intExprRange` on both operands, same product ceiling) each
 * derive their own operand bound (IR `maskBound` / AST `intExprRange`) and check
 * their PRODUCT — no shared constant. `mulBoundedFaithful` (typed-array-element
 * magnitude products) and `mulRangeFitsI32` (AST range-hull products) apply the same
 * both-sides-bounded rule.
 *
 * `+`/`-`'s OWN bare fast path (emit.js `isI32Num(va)&&isI32Num(vb)` → native
 * `i32.add`/`i32.sub`, UNCONDITIONALLY) and `compoundAssign`'s `*=`/`+=`/`-=` fast
 * path need the SAME magnitude gate as `*`: two full-range i32 operands CAN sum past
 * ±2^31, so `addFitsI32 = opBound(a)+opBound(b) ≤ 2^31−1` (emit.js, reuses `opBound`
 * — triangle inequality covers both `+` and `-` with one predicate) gates the
 * primary fast path; `compoundAssign` is gated identically, dispatched on `arithOp`.
 * See the two-tier exprType exception above for why the type.js mirror needs a
 * `strict` parameter instead of `*`'s unconditional rule.
 *
 * A var keeps i32 STORAGE-TYPE only if every later value-position read is
 * index-positioned, ToInt32-rooted, a tracked edge's own affine RHS, statically
 * in-range, or governed by SOME comparison anywhere (the SAME "sound for n≤2^31"
 * tolerance loop counters already have) — otherwise a bare escape downstream can
 * observe the wrapped i32 instead of the true magnitude-blind sum. This governs
 * `collectI32SafeIndexVars`'s back-propagation and widenLocalTypes'
 * `intCertainMap`-based `keepI32` exemption alike; both consult
 * `collectBareEscapes` (src/compile/analyze-scans.js) to decide.
 */
