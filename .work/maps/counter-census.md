Scout report (Sonnet 5.5, 2026-11-13), tree `557fbd525`, read-only. Leads, not facts: V = the
scout read the line or ran the command, I = inferred. The integrator compiled five of the
reduced programs of `counter-census.md` on the same tree and saw the same f64 locals; nothing
else here is re-derived. `SCRATCH/counter-widths/` in the text is session scratch (the reduced
programs, the tree of `e88a8e907`, the instrumentation patch, the raw rows): not in the repo.

# census.md: the 252 loops whose counter is an f64 when the vectorizer runs, classified

Model: claude-sonnet-5-5. Tree: `main` 557fbd525 (identical `src/` to cdc3b0711, the census tree) plus uncommitted instrumentation (`instrumentation.patch`). V = measured or read, I = inferred.

## What the 252 are, and that I reproduced them

The census row "NO SCAFFOLD S9 f64 counter step" (`.work/maps/loop-census.md`) is the vectorizer's `scaffoldWhy` (`SCRATCH/loop-facts/instrumentation.patch`): a `(block (loop ...))` whose last statement before the back edge is `local.set X (f64.add|f64.sub ...)`, `X` any local. The loops of that row with a load or a store in them are 252 of 390 such loops of user code (V: `census-instr.jsonl`, `census/units9.mjs`: 59 units, 390 loops, 252 with memory).

I re-ran those 59 units at `speed` on this tree with the same instrumentation of `src/optimize/vectorize/index.js` plus my analysis hooks (`census/child9.mjs`, `census/run9.mjs`, one fresh node process per unit, 3 jobs): the same 390 and 252 rows, the same per-unit counts (V: webaudio 40, dwa 19, stdlib-special 14, lsystem 13, stdlib-dists 12, maze 10, wireworld 10, ...: 54 units hold the 252; none of them is a `spell/` or `kernel/` unit: 132 loops in `example/*`, 120 in `bench/*`). Raw rows: `census/rows9.jsonl`; per-row class: `census/classes.json`.

"Counter" below means the local `X` the last statement steps. It is in the loop's exit test for 229 of 252 (V) and is stepped by a constant for 219 (210 by 1, 9 by another constant). 41 of the 252 are counters of an integral copy (`...int<k>` locals): a copy of some loop was emitted and its counter is still f64.

Each row carries what `widenLocalTypes` and the walk decided about that local (events `walk-f64`, `cmp-widen`, `value-widen`, `decision`, from the last analysis of the body that emit used) and what `versionIntegralLoops` did with loops whose test names the counter (`ver-wrapped`, `ver-exit` with its site, `while-bound`). The class is the first refusal in that order: walk, comparison widening, typed read, decision (hull open / past a word / not integral), then the loop's shape.

## The classes (smallest set I can make true; V counts)

| class | loops | what is missing | per-bound or per-cause breakdown |
|---|---:|---|---|
| 1 bound without a range | 117 | the counter steps by a constant against a Number the proof has no range for: hull `[start, +inf)` (open above, 99 loops: its decision is `int`, not a word, blamed) or no integrality proof at the comparison (18) | bound is a local that is a parameter or derived Number 54, a field/`.length`/call result of an unknown receiver 34, a module binding 24, a constant 4 (counter start unknown), a word local 1 |
| 2 hull a step or a sum past the word | 45 | the hull is finite but ends past 2^31: `i <= n` over a full word, hull `[0, 2^31]` or `[-2^31, 2^31]` (32 of the 45 test with `f64.le`, 5 `f64.ge`, 5 `f64.lt`, 3 other); a difference or sum of two words (`[-4294967295, 4294967295]` 6, `[-3221225471, 3221225470]` 1, ...) | bound is a local 27, a word local converted 13, an expression 2 |
| 3 starts from, or is updated by, an f64-typed expression | 49 | the counter's declaration copies an f64 local (`let i0 = ix`, 15), is an f64-typed expression (`y0 + 2`, `-r`, 25), or is updated by a compound step whose operand is f64 (`+=`, 9) | rfft's `i0`..`i8`, dwa `-ri`, magnet, sand, sdf, trace |
| 4 stepped, never tested | 16 | a side counter (`bits++` in `while (t > 1) { t >>= 1; bits++ }`): hull `[0, +inf)`; nothing in the loop bounds its trips | 8 of the 16 are copy locals |
| 5 not integral | 6 | the counter may hold a fraction or NaN (`t += 0.5`): no integrality proof | |
| 6 step is a name | 4 | `i += step` with `step` unknown | |
| 7 closure body | 14 | the analysis of a closure body is not in my probe (no `analyzeFuncForEmit` event); IR shape alone: step const 1 for 12, bound a local | watr 7, async 2, decode-alac 2, decode-qoa, decode-dsd, decode-tta 1 each |
| 8 f64 from birth | 1 | no event (a declaration that is f64 by its initializer's kind) | |

Class 1 is `A` (99) plus `D` (18) in `census/classes.mjs`; I merged them because the cause is the bound. In D (18) the counter was an i32 after the walk and Pass A widened it because the other side of the test is an f64 and `keepI32` is false (no integrality proof for it): 3 are recurrence-unroll copies (`rc` names), 2 are copies of the integral pass, the rest are source locals with a parameter or derived bound (maze `x`, `y`, rfft `i0` of the first pass, stdlib `k`, webaudio `i`). I did not reduce D to a source of its own. Class 3 is `C`.

Per unit (V, `census/units-table.md`, columns are the class numbers; last column is the emulated result below):

| unit | loops | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | turned into words by a bound guard (emulated) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bench/webaudio | 40 | 28 |  | 5 | 3 |  | 4 |  |  | 30 |
| example/dwa/dwa | 19 | 8 |  | 6 |  | 5 |  |  |  | 5 |
| bench/stdlib-special | 14 | 6 | 4 | 1 | 2 | 1 |  |  |  | 6 |
| example/lsystem/lsystem | 13 | 13 |  |  |  |  |  |  |  | 13 |
| bench/stdlib-dists | 12 | 3 | 3 | 4 | 1 |  |  |  | 1 | 4 |
| example/maze/maze | 10 | 6 | 4 |  |  |  |  |  |  | 8 |
| example/wireworld/wireworld | 10 | 1 | 2 | 4 | 3 |  |  |  |  | 2 |
| bench/watr | 8 |  | 1 |  |  |  |  | 7 |  | 2 |
| bench/decode-wav | 7 |  |  | 7 |  |  |  |  |  | 0 |
| bench/stdlib-gamma | 7 | 3 | 3 |  | 1 |  |  |  |  | 4 |
| example/lenia/lenia | 7 |  | 7 |  |  |  |  |  |  | 7 |
| example/rfft/rfft | 7 | 1 |  | 3 | 3 |  |  |  |  | 0 |
| example/epicycles/epicycles | 6 |  | 6 |  |  |  |  |  |  | 6 |
| example/schrodinger/schrodinger | 6 |  | 6 |  |  |  |  |  |  | 0 |
| bench/decode-qoa | 5 |  | 2 |  | 2 |  |  | 1 |  | 0 |
| bench/threegeom | 5 | 5 |  |  |  |  |  |  |  | 4 |
| example/magnet/magnet | 5 | 2 |  | 3 |  |  |  |  |  | 2 |
| bench/threecull | 4 | 4 |  |  |  |  |  |  |  | 4 |
| example/pascal-sierpinski/pascal-sierpinski | 4 | 1 | 3 |  |  |  |  |  |  | 3 |
| bench/decode-alac | 3 |  | 1 |  |  |  |  | 2 |  | 2 |
| bench/sdf | 3 |  |  | 3 |  |  |  |  |  | 0 |
| bench/trace | 3 |  |  | 3 |  |  |  |  |  | 0 |
| example/sand/sand | 3 |  |  | 3 |  |  |  |  |  | 0 |
| bench/async | 2 |  |  |  |  |  |  | 2 |  | 0 |
| bench/decode-dsd | 2 |  |  | 1 |  |  |  | 1 |  | 0 |
| bench/decode-tta | 2 |  | 1 |  |  |  |  | 1 |  | 1 |
| bench/movavg | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/apollonian/apollonian | 2 | 1 |  | 1 |  |  |  |  |  | 1 |
| example/blackhole/blackhole | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/cloth/cloth | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/dithering/dithering | 2 |  |  | 2 |  |  |  |  |  | 0 |
| example/gauss-primes/gauss-primes | 2 | 1 |  | 1 |  |  |  |  |  | 0 |
| example/jukebox/beat-0 | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/jukebox/beat-1 | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/jukebox/beat-2 | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/jukebox/beat-8 | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/pathtracer/pathtracer | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/raymarcher/raymarcher | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/raymarcher/raymarcher.simd | 2 | 2 |  |  |  |  |  |  |  | 1 |
| example/raytrace/raytrace | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/spectra/spectra | 2 | 2 |  |  |  |  |  |  |  | 2 |
| example/times-table/times-table | 2 | 1 | 1 |  |  |  |  |  |  | 2 |
| example/ulam/ulam | 2 | 1 |  | 1 |  |  |  |  |  | 0 |
| bench/polytri | 1 |  |  | 1 |  |  |  |  |  | 1 |
| example/boids/boids | 1 | 1 |  |  |  |  |  |  |  | 1 |
| example/cradle/cradle | 1 | 1 |  |  |  |  |  |  |  | 1 |
| example/field-lines/field-lines | 1 |  |  |  | 1 |  |  |  |  | 0 |
| example/fireflies/fireflies | 1 | 1 |  |  |  |  |  |  |  | 1 |
| example/harmonograph/harmonograph | 1 |  | 1 |  |  |  |  |  |  | 1 |
| example/metaballs/metaballs | 1 | 1 |  |  |  |  |  |  |  | 1 |
| example/nbody/nbody | 1 | 1 |  |  |  |  |  |  |  | 1 |
| example/pendulum/pendulum | 1 | 1 |  |  |  |  |  |  |  | 1 |
| example/swarm/swarm | 1 | 1 |  |  |  |  |  |  |  | 1 |
| example/truchet/truchet | 1 | 1 |  |  |  |  |  |  |  | 1 |
| total (54 units) | 252 | 117 | 45 | 49 | 16 | 6 | 4 | 14 | 1 | 139 |

## Smallest sources, types at level 2 and at speed, copy and refusal (V, `repros/*.js`, `repro.mjs`, `s9.mjs`)

The types are the analysis types (`ctx.func.locals`) of the exported `f`. "S9" means the vectorizer's row for the loop is `S9 f64 counter step` (`s9.mjs`).

Control: a parameter bound with the counter written in the head is already handled (`repros/a-param-for.js`):

```js
const a = new Float64Array(64)
export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s }
```
`i` is f64 (cold fallback), `i$` is i32 in the guarded copy, `nbound` i32; the loop is matched and lifted at level 2 and speed. Not in the census.

Class 1, bound is a field of an unknown receiver (`repros/a3-field-bound.js`):

```js
const o = { n: 0 }, a = new Float64Array(64)
export let set = (n) => { o.n = n }
export let f = () => { let s = 0; for (let i = 0; i < o.n; i++) s += a[i]; return s }
```
`i` f64 at level 2 and speed, no copy (`S1961 nothing to version`: the bound read is hoisted to a local that is not a stable Number term), S9. For a bound `b.length | 0` (an unknown receiver's `.length`) there is no problem: `prepare/handlers.js:1464` makes it a word and `i` is i32 (`repros/a-length-unknown.js`).

Class 1, module binding, with a user call that may write it (`repros/a6-module-user-call.js`):

```js
let N = 0; const a = new Float64Array(64)
const g = (x) => { let y = x; for (let k = 0; k < 3; k++) y = y * 1.5 + N; return y }
export let set = (n) => { N = n }
export let f = () => { let s = 0; for (let i = 0; i < N; i++) s += g(a[i]); return s }
```
Level 2: `i` f64, no copy (`S1961`: `quietNames()` is null because the loop calls user code), S9. At speed the call is inlined and the loop versions and lifts: the census (speed) has module-binding rows only where the function is too large or nested (S1093, S650, S668 below).

Class 2, `<=` over a word (`repros/b-inclusive-word.js`):

```js
const a = new Float64Array(64)
export let f = (x) => { const n = x | 0; let s = 0; for (let i = 0; i <= n; i++) s += a[i & 63]; return s }
```
`n` i32, `i` f64 at both levels (hull `[0, 2^31]`), no copy (`n` is `int32Held`, so there is nothing for the guard to test), S9.

Class 3, starts from a Number (`repros/c-start-from-param.js`):

```js
const a = new Float64Array(64)
export let f = (x, n) => { let s = 0, i = x; while (i < n) { s += a[i]; i += 2 } return s }
```
The loop is versioned (`i$` and `n` guarded) but the copy's counter `i$` stays f64 (its start `x` is a Number): the copy's loop is S9 at level 2 and speed. rfft's `i0 = ix` is the same with an f64 neighbour.

Class 4, side counter (`repros/f-side-counter.js`):

```js
const a = new Float64Array(64)
export let f = (n) => { let t = n, bits = 0; while (t > 1) { t >>= 1; bits++ } return a[bits] }
```
`t` and `bits` f64 at both levels, no planner entry for `bits` (not in a test), `S1961` for the loop; S9 on `bits`.

Class 5, fractional (`repros/e-fractional.js`): `for (let t = 0; t < n; t += 0.5) s += t`: `t` f64, S1961, S9.

Class 6, step by a name (`repros/g-step-name.js`): `for (let i = 0; i < n; i += step) s += a[i]` with `(n, step)` parameters: `i` f64, S1961, S9.

rfft's own shape (`repros/rfft-shape.js`):

```js
let N = 0; const x = new Float64Array(64)
export let set = (n) => { N = n }
export let f = () => { let ix = 0, id = 4
  while (ix < N) { let i0 = ix; while (i0 < N) { x[i0 + 1] = x[i0] + 1; i0 += id }; ix = 2 * (id - 1); id *= 4 }
  return x[0] }
```
`ix`, `id`, `i0` f64 at both levels; inner loop S9 (class 3 and 6 together: starts from an f64 neighbour, steps by a name), outer loop `S9 last statement sets a local to a non-step (f64.mul)`; the planner exits at `S1961` (inner) and `S1093` (outer).

Class 7 and 8: not reduced.

## Was an integer copy emitted, and if not, which check refused (V; `census/plan-table.mjs`)

For each row, the planner's outcome for the loops whose test names the counter (`versionBody`'s exits and `ver-wrapped`). "inside or beside a copy" = a loop of the nest was versioned; "copy local" = the counter is itself a copy's name; "no entry" = no loop whose test names the counter reached `versionBody` (loops made after the planning sweep by `unrollRecurrences` and unswitching, inlined copies, closures, side counters that no test names).

| class | loops | inside or beside a copy | copy locals | no entry | refused at (loops) |
|---|---:|---:|---:|---:|---|
| 1 | 117 | 7 | 9 | 19 | S1961 nothing to version 36 (+5 with S1093), S1952 13, S668 size 13, S1093 12, S650 growth 8, others 4 |
| 2 | 45 | 11 | 19 | 19 | S1093 8, S1961 6, S650 1 |
| 3 | 49 | 8 | 2 | 6 | S1961 20, S1093 9, S668 2, S650 2, S1952 2 |
| 4 | 16 | 0 | 8 | 16 | (the planner has no entry for a counter no test names) |
| 5 | 6 | 0 | 1 | 1 | S1952 3, S1093 2 |
| 6 | 4 | 0 | 2 | 2 | S1961 1, S1093 1 |
| 7 | 14 | 0 | 0 | 14 | (closure bodies) |
| 8 | 1 | 0 | 0 | 1 | |

The checks, in `plan/integral-loops.js` (HEAD lines):
- `S1961 nothing to version` (`:1961`): no `counterBound`, no name to alias (every candidate is `already()`: integral by its writes, or an `int32Held` word), no cursors. For a `while`, `counterBound` needs `maxAdvanceBudget > 0` (`:852`), which is null for a step by a name or a non-step write; for a `for`, the conditions at `:796-826` (counter in the head, a stable bound that is not `int32Held`, the counter hull within the word).
- `S1093 nested loop, no counter bound, no own trip` (`:1093`) and `S1952` (`:1952`): a loop that contains a loop gets a copy only for its own counter bound or trips.
- `S668 size` (`:668`): the loop is past `MAX_SIZE = 800` nodes (the nest as written, an inner version counted as written).
- `S650 growth budget` (`:650`): the function has grown past `SOURCE_FULL` (`src/growth.js`), unless the loop is a kernel loop.
- `S653 cold`: the loop is the as-written fallback of another version.

## How many of the 252 a guard on the bound alone would turn into words

An emulation, not a guard (V for the run, I for the reading). In my tree two flags change only the loop-test refinement: `src/type/interval-proof.js` `refineRaw` (`:520-523`, read inside `applyCond` only), and `src/static.js` `forCounterBoundsIn` (`:679`): with `globalThis.__bnd` set, the bound of every `<`, `<=`, `>`, `>=` loop test is intersected with `[-2^31 + 1, 2^31 - 2]` (a bound with no known value gets that range). That is what a run-time guard `N >= -2^31 + 1 && N <= 2^31 - 2` on the bound would let the proof assume. Nothing else changes (the counter's start, step and body are the proof's). I re-ran the 59 units (`JZ_BND=1`, `census/rows9-bnd.jsonl`):

- 252 baseline rows; 115 rows remain with an S9 f64 step; matched to baseline rows by (unit, function, counter name): 113 remain, 139 no longer have an f64 step, 2 new rows appear.
- By class: class 1: 102 of 117 become words; class 2: 28 of 45; class 3: 2 of 49; class 4: 0 of 16; class 5: 0 of 6; class 6: 2 of 4; class 7: 5 of 14; class 8: 0 of 1. (Of class 1's 117: 95 of the 99 `A`, 7 of the 18 `D`.)

So 139 of 252 (55%) turn into words under a bound guard alone and 113 do not: 47 of the 49 of class 3 (counter starts from or is updated by an f64 expression), 15 of class 1, 17 of class 2 (final step past the word by a sum), the 16 side counters, 9 closure bodies, the 6 non-integral, 2 steps by a name, and the 1 of class 8.

Caveats: (1) the emulation does not check that the real guard could be formed: it needs the bound to be a Number read once before the loop that the loop does not write and no call changes (`stableBound`, `quietNames()`), which `S1961`/`stableBound` refuse for some of these (for example loops that call user code); 139 is an upper bound on what a real guard reaches. (2) "No longer an S9 row" means the counter step is i32; the vectorizer may refuse the loop for another reason (S10 to S14, the ladder L1..L9 of the earlier census): not measured. (3) The emulation treats every loop test, including word bounds, as bounded by 2^31 - 2, which closes the `<=` over a word (28 of class 2) but needs the guard `n <= 2^31 - 2` there, not the word type.
