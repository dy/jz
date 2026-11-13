Scout report (Sonnet 5.5, 2026-11-13), tree `557fbd525`, read-only. Leads, not facts: V = the
scout read the line or ran the command, I = inferred. The integrator compiled five of the
reduced programs of `counter-census.md` on the same tree and saw the same f64 locals; nothing
else here is re-derived. `SCRATCH/counter-widths/` in the text is session scratch (the reduced
programs, the tree of `e88a8e907`, the instrumentation patch, the raw rows): not in the repo.

# rfft.md: `transform`, local by local

Model: claude-sonnet-5-5. Source: `examples/rfft/rfft.js` (copied to `SCRATCH/counter-widths/rfft.js`). Trees: now = worktree of `main` 557fbd525 (instrumented, behaviour unchanged unless a global is set), old = `git archive e88a8e907` in `SCRATCH/counter-widths/old`. V = I ran it or read the line; I = inferred.

Counts reproduced (V, `fn.mjs rfft-*.wat transform counts`): `$transform` has 163 `trunc_sat` and 51 `f64.lt` at speed now (158 and 21 at level 2); 8 and 0 at e88a8e907 at both levels.

## How the types were read

The wasm type of each local is `ctx.func.locals` at the end of `analyzeFuncForEmit` (a hook at `analyze-for-emit.js` after `inheritPtrAliases`, `final.mjs`), after `versionIntegralLoops` has rewritten the body. Source name `x` appears as `x~f4_<k>` (block renaming; `~` is U+E000) and, where a loop was copied, as `x~f4_<k>~int<j>` in the copy. The reasons are events from instrumentation of `widenLocalTypes` and the walk (`probe.mjs`; patch in `instrumentation.patch`).

The post-plan source of `transform` (V, `rfft-plan-ast-speed.txt`): only two loops were versioned.

1. the bit-reversal loop: `if (typeof N === 'number' && N >= -2147483648 && N <= 2147483647) { let Nbound = ceil(N) >> 0, i$ = 0; while (i$ < Nbound) {...} } else { while (i < N) {...} }`, once per call;
2. the `j < count` loop of the twiddle stages, with its two inner `while` loops inside the copy: `if (typeof count === 'number' && count >= -2147483648 && count <= 2147483647) { let countbound = ceil(count) >> 0, j$ = 0; while (j$ < countbound) {... ix, id, i0 loops (still f64) ...} } else {...}`.

No `while (ix < N)`, `while (i0 < N)` loop is versioned. The reason, per loop (V, `probe2.mjs rfft.js speed transform`): the planner computes `maxAdvanceBudget(body, counter)` for a `while (c < B)` (`integral-loops.js:852`) and it is `null` for every `i0` loop (`i0 += id`, `id` a name with no hull) and every `ix` loop (`ix = 2 * (id - 1)` is not an advance); with no `counterBound`, `names` stays empty because every candidate is `already()` (`:718`: every write of it is an integer of such names, so it is integer-valued, if unbounded) and the loop exits at `S1961 nothing to version`; the three `ix` loops that contain an `i0` loop exit earlier at `S1093 nested loop, no counter bound, no own trip`.

## Table: wasm type of every integer local (V)

Level 2 and speed give the same types for every local below (`tab.mjs`; the listing is in `fin-{old,now}-{2,speed}.json`).

| local (versions) | e88a8e907, level 2 and speed | today, level 2 and speed |
|---|---|---|
| `i` (bit reversal) | i32 | f64; copy `i$` i32 |
| `ix` | i32 | f64 |
| `id` | i32 | f64 |
| `i0` (4 loops) | i32 | f64 (all, the copy's too) |
| `i1`, `i2`, `i3`, `i4` (incl. the `+= n8` splits) | i32 | f64 |
| `i5`, `i6`, `i7`, `i8` | i32 | f64 |
| `n2`, `n4`, `n8`, `nn` | i32 | i32 |
| `si` | i32 | f64 |
| `j` | i32 | f64; copy `j$` i32 |
| `off`, `count` | f64 | f64 (`count$bound` i32 in the copy) |
| `ti` | i32 | i32 |

## The first refusal and the fact it lacked, per local

All hulls are those the interval proof publishes (`numbersOf(name)`, `body-facts.js:753`); `int` is "an integer of any magnitude" (`num-range.js`), `esc` is membership in `collectBareEscapes` (`analyze-scans.js:1244`).

| local | first check that refuses (V event) | the fact it lacked |
|---|---|---|
| `id` | the walk: the compound `id *= 4` (`body-facts.js:545-548`): `exprType(id * 4)` is f64 because the `*` case needs a closed range for `id` (`expr-type.js:225-232`, `mulRangeFitsI32`). Also the later `id = n2 << 1`, `id << 2` are words by themselves, but one f64 write is enough. | a range for `id`. It is a geometric sequence (4, 16, 64, ...) stepped while `ix < N` with `ix = 2 * (id - 1)`: bounded only through that relation (`id < 2N + 4` at the head, so `id <= 8N + 16`; measured below). |
| `ix` | the walk: `ix = 2 * (id - 1)` (`:529-541`): `*` of an `id` with no range. | the same range of `id`; then a range for `(id << 1) - n2` (the stage loops), a difference of two words, in (-2^32, 2^32): never a word by the table. |
| `i0` (first pass, `i0f4_6`) | Pass A: `i0 < N` is `cmp-widen` (`body-facts.js:762`): `i0` was i32 at the walk (declared from `ix` before `ix` became f64), `keepI32(i0)` is false because its hull is open. | the bound `N` has no range (below) and the step `+= id` has none. |
| `i0` (the other three) | the walk: `let i0 = ix` copies an f64 local (`processDecl`, `walk-f64(decl: ix)`). | `ix` a word, and a hull for `i0 += id` (it overshoots N by up to `id`). |
| `i1`..`i8` | the walk: `let i1 = i0 (+ j + 1)`, `i2 = i1 + n4`, ... : `exprType` of `+`/`-` is f64 when an operand is f64 (`expr-type.js:199-200`); each copies f64 from `i0`. | `i0` a word, then a sum of up to four terms each below 2^30. |
| `n2` | none: word. Decision (`:822`): hull `[-2^31, 2^31-1]`, `nrWord`, from `<<` (`num-range.js:131`). | nothing lacking. |
| `n4`, `n8` | none: hulls `[0, 2^30-1]` and `[0, 2^29-1]` from `>>> 2`, `>>> 3`. | nothing lacking. |
| `nn` | none: hull `[0, 2^31-1]` from `>>> 1`. | nothing lacking. |
| `si` | the decision `:822`: hull `[0, +inf)`, `int`, `esc` (index `stageOff[si]` and `si++`). | a trip count: `si++` runs once per trip of `while ((nn = nn >>> 1))`; `nn` is a uint32 halved each trip, so at most 31 trips, `si` in `[0, 31]`. No guard needed: no input makes it false. |
| `j` (original) | the decision `:822`: hull `[0, +inf)`, `int`, `esc` (`j < count`, `j++`, in `(off + j) << 2`). | a range for `count`; but `count` is f64 (next row). |
| `j$` (copy) | none: the planner's `counterBound` (`countbound` word, `j$` range `[0, 2^31-1]`). | nothing lacking. |
| `off`, `count` | the walk: `off = stageOff[si]` reads an `Int32Array` element that may be missing (`undefined`): `walk-f64(decl: [] stageOff si)` and `value-widen`. Same at e88a8e907. | that the read is present: `si < stageOff.length`; `stageOff.length` is `bits` from `init`, not related to `si` anywhere the compiler sees. |
| `ti` | none: word (`(off + j) << 2`), `safeIdx`. | nothing lacking. |

Two things that look like causes and are not (V, counterfactuals, `rfft-bounded.js`, `fin-bounded*.json`):

- Bounding `N`. With `N = n & 134217727` in `init`, `N` becomes `(mut i32)` (`rfft-bounded-speed.wat:97`). Still `i`, `ix`, `id`, `i0..i8`, `si` are f64 and `trunc_sat` is 160, because `refineRaw` reads the bound from `env.get(r)` only (`src/type/interval-proof.js:520`), never from `valueOf(r)`, which is where a module word or a parameter's entry value live (`:306`). With that bounded `N` and the one-token change `valueOf(r)` in place of `env.get(r)` (global flag `__vb`, counterfactual, `fin-bounded-vb-speed.json`) the original `i` becomes i32 (the planner still makes its copy) and nothing else changes: `ix`, `id`, `i0`..`i8`, `si` stay f64. With the unbounded `N` (`(mut f64)`) the same change changes nothing (`fin-now-vb-speed.json`).
- The index sums. `id`/`ix` are what no bound on `N` reaches.

## What the values really are (V, `track.mjs`, `track-all.mjs`)

Instrumented copy of `transform` (`rfft-track.mjs`) records the least and the most of every local in one `rfft()` call.

| local | most / N, N = 2^k, k = 4..22 | most / N over every integer N in [2, 3000] |
|---|---|---|
| `i` | 1.000 | 1.000 |
| `ix` | 3.75 to 4.000 | 4.997 (N = 1537) |
| `id` | 8.000 | 10.660 (N = 1537, id = 16384) |
| `i0` | 2.75 to 3.000 | 3.664 (N = 1537) |
| `i1`..`i8` | up to 1.000 | up to 1.499 (`i8`, N = 2049) |
| `n2` | 1.000 | 1.000 |
| `n4`, `n8`, `nn` | 0.25, 0.125, 0.5 | the same |
| `si` | 21 at N = 2^22 | 0.25 N at N = 4 (its value is at most `log2 N - 1`) |
| `j`, `count`, `off` | 0.125 | 0.125 |
| `ti` | 0.999 to 1.000 | 0.979 |

Least values are 0 or a small positive number everywhere (no negative index in a valid run). The factor above 8 for `id` and above 4 for `ix` is real: a stage loop whose test is `ix < N` with `ix = (id << 1) - n2 = 3 n2` runs one more time when `N` is just above `3 n2` (N = 1537, n2 = 512: `id = 4096` then `16384`). So every local of `transform` stays below `10.67 N` for N in [2, 3000]; the bound is not proved, only measured (I for N above 3000, extrapolating the construction).

With `N <= 2^27` all of them are below `10.67 * 2^27 = 1.43e9 < 2^31`. With `N = 2^28` the measured `id` (8N, power of two) is 2^31: out of the word. (V for the powers of two, I for the constant 10.67.)

## The adversarial half: inputs for which an i32 differs from Node

"Holding as i32" is tested against what e88a8e907 did (it held all of them as i32, and held the module `N` as `(mut i32)`), since it is the only compiler available that does so. Every row below was run against Node as the oracle.

### Inputs of the real module (`init(n)`, then `rfft()`; `exp/run1.mjs`, `drive1.mjs`, budget 15 s per run)

`init` writes `N = n` before it allocates; a failed allocation (a RangeError in Node, `RuntimeError: unreachable` in jz) leaves `N` set and the arrays of the previous `init` in place. So `N` need not equal any array length.

| input | Node | now | e88a8e907 |
|---|---|---|---|
| `init(8)`, `init(8.5)`, `rfft()` | `spectrum()[1]` NaN | NaN, equal | `0`: differs. Cause: `N` is an i32 global there, `N = 8.5` stores 8, so the loops never visit `i = 8` (one past `x`'s end) and read no `undefined` (V). Not an index-local effect. |
| `init(8)`, `init(-4)` (throws after `N = -4`), `rfft()` | equal at every level | equal | equal (2^31 steps of the `while (--k)` loop: 3.2 s Node, 6 s jz) |
| `init(8)`, `init(NaN)`, `rfft()` | not finished in 15 s | not finished | finished in 11.7 to 13.7 s (V). Cause: `half = NaN >>> 1 = 0`, `k = half`, `while (--k)` never reaches 0 in f64 (I: k only falls) but wraps to 0 after 2^32 steps in i32. A counter of `rfft()`, not of `transform`. |
| `init(8)`, then `init(1e300)`, `init(Infinity)` or `init(4294967295)`, `rfft()` | not finished in 15 s | not finished | finished in 6 to 14 s |

The last two rows do not tell a transform local from `rfft`'s; the reduced programs do.

### Reduced programs of `transform`'s shape (small arrays, any `n`)

`exp/reduced.mjs` holds four programs; each is the loop nest with its arrays cut to `Float64Array(8)` (index feeders kept, so e88a8e907 promotes the locals). Run through `jz` at levels 2 and speed in both trees and in Node; "finished" is within the budget.

- `geo`: `let ix = 0, id = 4, outer = 0; while (ix < n) { x[id] = x[ix] + 1; ix = 2 * (id - 1); id *= 4; outer++ }`. All five engines agree for `n <= 2147483646`. For `n = 2147483647`, `4294967295`, `1e12`: Node and now finish with `[16, 8589934590, 17179869184]` (and `[20, ...]` for 1e12); e88a8e907 does not finish in 25 s: `id` reaches 2^32, wraps to 0 in i32, `ix = 2 * (0 - 1)` stays below `n`. Applies to `id` and `ix` of the first pass. The threshold is `n >= 2^31 - 1` (the last body run has `id = 2^30`, `ix = 2^31 - 2`).
- `first`: the first-pass nest with `i0` (`while (i0 < N) { inner++; last = i0; x[i0 + 1] = x[i0] + 1; i0 += id }` inside `while (ix < N)`). Equal in all five engines for `n` up to 1610612734 (also at 2^29, 805306368, 2^30). At `n = 1610612735` (3 * 2^29 - 1) Node and now finish (15 outer trips, 536870912 inner trips, last `i0` 1610612734); e88a8e907 does not finish in 20 s: the last body run has `i0 = 1610612734 < n`, `id = 2^30`, and `i0 += id` is 2684354558, which wraps negative in an i32 and stays below `n`. So `i0` diverges at `n >= 3 * 2^29 - 1`, below the word's top, because it ends one `id` past `n` (`exp/first.out`, `exp/first2.out`, and the run at 1610612734/1610612735).
- `stage`: the stage loop with `id = n2 << 1`, `ix = (id << 1) - n2`, `id = id << 2`. Equal for `n = 1000` and `268435456 (2^28)`. At `n = 536870912 (2^29)`: Node and now do not finish in 40 s (JS: `id << 1` wraps to -2^31, `ix = -2^31 - 2^29 < n` stays true, `id << 2` reaches 0, `i0 += 0`), e88a8e907 finishes in 0.4 s (`ix` wrapped to a positive value). Applies to `ix` of the stage loops: `(id << 1) - n2` is a difference of two words, not a word. The threshold is the stage `n2 = 2^29`.
- `bitrev`: `let i = 0; while (i < n) { x[i] = 1; i++ }`. Equal for `n <= 2147483647`; at `n = 2147483648` Node and now return 2147483648 in 1 to 3 s, e88a8e907 returns 2147483647 (its counter stops at the i32 limit). Applies to `i`.

### Per local

| local | an input where i32 differs from Node | the smallest `n` (V from the reduced runs, I for the rest) |
|---|---|---|
| `i` | yes: `N >= 2^31` | 2^31 |
| `ix`, `id` (first pass) | yes: `id *= 4` wraps | `N >= 2^31 - 1` |
| `ix`, `id` (stage loops) | `id` is a word by `<<` (exact in i32); `ix = (id << 1) - n2` is not | `n2 = 2^29`, i.e. `N >= 2^29` |
| `i0` | yes: it ends one `id` past `N` | first pass: `N >= 3 * 2^29 - 1 = 1610612735` (V: equal at 1610612734); the stage loops: not found below the stage `ix` threshold, I |
| `i1`..`i8` | yes, later than `i0` | `N` of order `2^31 / 1.5` (measured `i8 <= 1.5 N`); `i0` fails first |
| `n2`, `n4`, `n8`, `nn` | no: every write is `<<` or `>>>` (a word by JS semantics) or the literal 2/0/N>>>1 | none |
| `si` | no: at most 31 (nn halves from a uint32) | none |
| `j` | no, if `count` is a word or NaN: `j < count`, `count` an `Int32Array` element (`j` reaches `count <= 2^31 - 1`) or `undefined` (`j < undefined` is false) | none (I: depends on the bound being an Int32Array element) |
| `off`, `count` | yes if held as i32: a missing element (`si >= stageOff.length`, reachable after a failed `init`) is `undefined`; as a word it reads 0, and `ti = (undefined + j) << 2` is `(NaN) << 2 = 0` where `(0 + j) << 2` is `4 j` | any `N` that makes `si` exceed `stageOff.length`; I (not run) |
| `ti` | no: `<<` result | none |

Array contents never matter for any index local (indices do not depend on data).

### The run-time test

One test at `transform`'s entry that excludes every input of the table above for the index locals: `N >= 0 && N <= 134217727` (a Number; NaN, a negative, a huge or infinite `N` fail it; a non-integer such as 8.5 passes and is harmless: the loops compare `i < 8.5` as `i < 9`). Under it every `id`, `ix`, `i0`..`i8` is below `10.67 * 2^27 < 2^31` (measured above, for N <= 3000 and the powers of two; not proved).

Under that test, which locals stay unprovable by interval arithmetic and why:

- `id`, `ix`: they grow geometrically (`id *= 4`, `id << 2`) and are bounded only through the loop test of a different variable (`ix < N` with `ix = 2 * (id - 1)` or `(id << 1) - n2`). The proof widens `id` to the word's end and then to infinity; no interval rule closes it. A relation (`ix` determined by `id` at the head) or a trip count of the outer loop (at most `log4(2N) + 2` trips in the first pass) would. Verified: with `N` an i32 global and the `valueOf` change, `id` and `ix` are still f64.
- `i0` and `i1`..`i8`: they add `id`, `n4`, `j`, 1: the sum of four terms. They need `id` and `ix` first; given `id <= 8N + 16` and `i0 < N + id` the sums are `<= 12 N` (measured 3.7 N), words under `N <= 2^27`.
- `off`, `count`: presence, not width (`si` against `stageOff.length`).
- Everything else (`n2`, `n4`, `n8`, `nn`, `ti`) is a word already; `si` needs the 31-trip fact; `i` and `j` need `N`/`count` words (the planner's guard does it once per call for these two).

## Unverified here

- That `i0` and `i1`..`i8` as i32 diverge at exactly the thresholds I give: only `first` (i0, at N = 1610612735), `geo`, `stage`, `bitrev` were run. The thresholds for `i1`..`i8` are inferred from the measured ratios.
- That `off`/`count` held as i32 differ: argued from the semantics of a missing element, not run.
- Any `n` near 2^31 on the unreduced module: `init` cannot allocate it in jz (`unreachable`); in Node it may or may not allocate, and `rfft()` would run for minutes.
