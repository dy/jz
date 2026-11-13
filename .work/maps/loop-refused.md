Scout report (Sonnet 5.5, 2026-11-13), tree `cdc3b0711` (the tree 6a landed from), read-only.
Leads, not facts: V = the scout read the line or measured it, I = inferred. Not re-derived by
the integrator. The scripts, patches and raw rows the text names (`probe.mjs`,
`instrumentation.patch`, `census-*.jsonl` and the rest) were session scratch and are not in the
repo.

# Part B: why each loop gets no lift

Scout: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Tree: `land-e` `cdc3b0711` + uncommitted instrumentation (`instrumentation.patch`). V = I ran it or read the line; I = inferred.

## Method

- `probe.mjs` (this directory) builds each program as `const a = new T(64), b = new T(64), c = new T(64)` + `export let k = …`, compiles it with `compile(src, { optimize })` from `test/util.js` at level **2** and **'speed'**, and dumps, for every non-cold `(block (loop))` of `$k`, the IR the vectorizer saw, its lowering link, the first scaffold condition that refuses it (`S0..S14`, a replica of `matchBlockLoop` held equal to it: it throws "INCONSISTENT" on any disagreement and none occurred), every recognizer's recorded why-not reason, and, through an ESM load hook (`dec-hook.mjs`: every `return null` of a `vectorize/*.js` file logs `file:line`), the last decline sites of each recognizer.
- **Two settings of `n`**, because it decides the first refusal for half the rows. **B** (the primary): `n = a.length - 3` inside `k` (the emitter knows it is the integer 61). **A**: `n` is the exported parameter (a Number). Under A, `for (let i = 0; i + 1 < n; i++)`, `i >= 0` descending, `i += 2`, `i <= n` and `i !== n` keep an **f64 counter** (no int32 copy of the loop is emitted), so the first refusal is `S9 f64 counter step` before any shape question; `narrowInts` (which would make it an i32) runs after `vectorizeLaneLocal` (`pass-table.js`). The int-copy-plus-`cold`-twin arrangement (`versionIntegralLoops`, `plan/integral-loops.js`) is present for `i < n`, not for the others.
- **Against Node**: every program was run through `oracle` and `jz` for n ∈ {0,1,2,3,5,8,17,33,63} (A) / the fixed n (B) at both levels, after `init()` filled the arrays with small exact values: **no difference in any of the 25 rows × types × both settings × both levels** (`probe.out`, `probeB.out`: 0 "WRONG"). With **inexact** float data the sum and dot reductions of rows 10 and 12 differ from Node in the last bits at levels 2, 3 and speed (see the top of the report; `t4.mjs`).
- `t3.mjs` tests the premise "this fact would admit the loop": each refused row re-spelled the way the scaffold reads it, in B, at speed.
- Scaffold lines: `scaffold.js:302-303` (step must be `matchIncN` with c = 1, `addr-model.js:23-30`), `:310` (no step), `:312-313` (exit must be `matchExitBrIf`, `addr-model.js:55-63`: `br_if $blk (i32.eqz (i32.lt_s|lt_u (local.get i) BOUND))`), `:314` (counter equality).

## Summary table (B, speed; level 2 equal unless noted)

| row | first refusal | the fact that would admit it |
|---|---|---|
| 1 `i + 1 < n` | `scaffold.js:312-313` ← `addr-model.js:61` (exit lhs is `i32.add`) | exit as written `(i + K) < bound`: K is `nameShift`, dropped at emit (spelled `i < n - 1`: lifted, V) |
| 2 `i - 1, i, i + 1` | same | same |
| 3 descending | `scaffold.js:302-303` (`i32.sub`) | step sign, exit `>=`, start: the link has hull and magnitude, not the sign (spelled ascending: lifted, V) |
| 4 `i += 2` | `scaffold.js:302-303` (c = 2) | none missing in the link (`step: 2`, hull [0,60]); lowering for a strided lane |
| 5 counter read after | A and B: `S9 f64 counter step` (`scaffold.js:302`) | the counter is a word in [0, n]: no entry value (`for (;…)` has no init: `hull: null`); `while` spelling lifts (V) |
| 6 `t` read after | `map.js:254-256` (`liveout`, not a constant flag) | none from the emitter: land the last lane (the legality allows `landed`, `legality.js:86`); spelled with no live-out: lifted (V) |
| 7a `a[0] + i` | `lift.js:1043` (f64), `lift.js:764` (i32), `map.js:216` (u8) | the counter as data: start, step (an induction vector `i + lane·step`) |
| 7b `a[i] * b[0]` | `map.js:216` (`b[0]` is no lane address) | **none: a true dependence** (iteration 0 stores `b[0]`, every later one reads it) |
| 8a `Math.min` | f64: lifted. i32/u8: `reduce.js:319`→`:337` | none from the emitter: widening `f64.convert_i32` lanes (i32 element, f64 accumulator) |
| 8b `if (a[i] < m)` | f64 level 2: `reduce.js:165` (`relaxF32` off); speed lifted. i32/u8: as 8a | f64: the relaxation is the tier; ints as 8a |
| 9 `a > 0 ? a : -a` | `lift.js:910` ("conditional without lane-typed result") | the arms are int32 values stored through a wrapping store: i32 arithmetic is exact mod 2³² (a range/integrality fact, `irange` is dropped before the vectorizer) |
| 10a `s += a[i]` | i32: `reduce.js:319`→`:337`; i16, u8, f64: lifted | i32: the f64 accumulator over an i32 element (lowering); no emitter fact |
| 10b `s += a[i] * c[i]` | i32/i16/u8: `reduce.js:319`→`:337`; f64 lifted | a lowering (widening multiply-add); sum below 2⁵³ needs the element ranges |
| 11a `i <= n` | B: `scaffold.js:312-313` ← `addr-model.js:60` (`i32.le_s`); A: lifted | the exit comparison as written, with the bound's range (`i <= B` is `i < B + 1` when `guardRange` hi < 2³¹ − 1) |
| 11b `i !== n` | A and B: `S9 f64 counter step` | `i` is an integer and starts at or below the bound, so `!==` is `<`: the emitter has the start literal and `boundConst`, but `iv` is null for `!==` |
| 12 `i++, k++` | speed: `scaffold.js:302-303` (the loop arrives unrolled by two); level 2: lifted | none: a defect of the unroller's predicate (`loop-recurrence.js:295`, below) |
| 13 Uint8Clamped | B: lifted (`tryRampMap`); A: `lift.js:1043` (`f64.add` over i8 lanes) | A: the sum of two bytes is an integer in [0, 510]: an integer-range fact; B emits i32 arithmetic |
| 14 spmv | bench form: scaffold matches; `reduce.js:337`/`:748` (the load `x[colIdx[k]]` is no lane address); my module form: `S9 f64 counter step` | none: a reduction over a gather needs a gather lowering and a cost call, not a fact |
| 15a `a[n - i] = a[i]` | f64: lifted. i32/u8: `map.js:216` (mirror store is f64 only, `map.js:178`) | none: lowering (lane reverse) for narrower lanes |
| 15b `b[n - 1 - i] = a[i]` | f64: `addr-model.js:250-251` (`INV` is `n - 1`, an expression; `matchMirrorAddr` takes a local or a constant). i32/u8: `map.js:178` | "this subtree is loop-invariant" (`n - 1`) for f64 |
| 16a `while … i++` | lifted | |
| 16b `do … while (++i < n)` | `scaffold.js:302-310` (the last statement is the flag `if`; no `br_if` at the top either) | trip count and a counted form of the flag loop (`normalize.js:26-29`); I |
| 17a `for…of` | lifted | |
| 17b `forEach` | lifted | |
| 17c `map` | not a loop at the vectorizer: `$k` calls `__simd_map_7_add_1` (`module/typedarray.js:3083`, `analyzeSimd`), the emitter's own SIMD helper | |

## Rows

### 1. `for (let i = 0; i + 1 < n; i++) b[i] = a[i + 1] + a[i]`
- **B, f64/i32/u8, both levels** (V): no scaffold. IR (f64): `(br_if $brk0 (i32.eqz (i32.lt_s (i32.add (local.get $if2_2) (i32.const 1)) (local.get $nf2_1))))`; link `{"iv":"if2_2","hull":{"lo":0,"hi":59},"test":{"lo":0,"hi":60},"step":1,"counters":0,"guard":null,…}` (`iv` is `i`: `guardCounterName` reads through `+ const`; `guard` is null because the left side is not a bare name). First refusal: `scaffold.js:312-313`, `matchExitBrIf` → `addr-model.js:61` (`isLocalGet(cmp[1])`). `matchOuterPixelLoop` also null, so no recognizer runs.
- **A** (V): `S9 f64 counter step`: IR `(f64.lt (f64.add (local.get $if2_1) (f64.const 1)) (local.get $nf2_0))`, step `f64.add`; link `iv` set, `hull: null` (the bound is an unconstrained Number). `scaffold.js:302-303`.
- Fact: the loop is `i < n − K` with K = 1 (`nameShift`, `static.js:495`, computed in `forCounterBoundsIn` and dropped) and the counter integral. V: spelled `i < n - 1` it is lifted at speed (f64 `tryStencil`, i32/u8 `tryGeneralStencil`, `t3.mjs`).

### 2. `for (let i = 1; i + 1 < n; i++) b[i] = a[i - 1] + a[i] * 2 + a[i + 1]`
- Same as row 1 (V, same codes; hull [1, 59]). Spelled `i < n - 1`: lifted (V, same takers). Same fact.

### 3. `for (let i = n - 1; i >= 0; i--) b[i] = a[i] + 1`
- **B** (V): `S9 descending step (i32.sub)`, `scaffold.js:302-303` (`matchIncN` wants `i32.add`; `:310` returns null). The exit is `(i32.eqz (i32.ge_s i (i32.const 0)))` (would fail `addr-model.js:60`). Link `{"iv":"if2_2","hull":{"lo":0,"hi":60},"test":{"lo":-1,"hi":60},"step":1,"guard":null}`: the hull is the iteration set, `step` is `1` for a descending loop (magnitude).
- **A**: `S9 f64 counter step`.
- Fact: direction (−1), the exit `>=` bound 0, the start `n − 1`: all computed (`increasing`, `static.js:642`; `cond[0]`; `counterInit`) and not kept except the hull. V: the ascending spelling `for (i = 0; i < n; i++)` is lifted by `tryVectorize` (distinct arrays: the iteration order is unobservable). In place, a descending loop is a different dependence than an ascending one; the legality (6a) is what decides it.

### 4. `for (let i = 0; i < n; i += 2) b[i] = a[i] * 3`
- **B** (V): `S9 step by a constant 2 (unit step only)`, `scaffold.js:302-303` (`inc1?.c === 1`). Link: `{"iv":"if2_2","hull":{"lo":0,"hi":60},"test":{"lo":0,"hi":62},"step":2,"guardRange":[61,61],"boundConst":61}`: **every fact is in the link**, including the step.
- **A**: `S9 f64 counter step`.
- Fact: `step: 2` is there. What is missing is a lowering for a counter stride: the recognizers' AoS pixel stride (`map.js` `allowAos`) is about interleaved lanes, not about `i += 2` over a plain array. The counted-loop canonicalizer (`plan/counted-loops.js`) rewrites cursors beside a counter, not a stepped counter used as the index.

### 5. `let i = 0; for (; i < n; i++) b[i] = a[i] + 3; return i`
- **A and B** (V): `S9 f64 counter step`. IR: `(f64.lt (local.get $if2_2) (f64.convert_i32_s (local.get $nf2_1)))`, `i = i + 1.0`, loads through `(i64.trunc_sat_f64_s i)`. Link: `{"iv":"if2_2","hull":null,"step":null,"boundConst":61}`: the head has no `init`, so `counterInit` (`static.js:527`) is null and `forCounterBoundsIn` returns null (`static.js:644`).
- V (`t3.mjs`): `let i = 0; while (i < n) { b[i] = a[i] + 3; i++ } return i` is lifted at speed (`tryVectorize`; the lift lands the counter) and so is `for (let i = 0; i < n; i++)` without the `return`. So the blocker is the f64 type of the counter, i.e. no entry value in the head.
- Fact (I): the counter is a word in [0, n]; the emitter proves it for the `while` form (a body step under its own guard) and not for a `for` whose head has no declaration.

### 6. `let t = 0; for (let i = 0; i < n; i++) { t = a[i] * 2; b[i] = t + 1 } return t`
- **B, all types, both levels** (V): scaffold matches; no recorded reason. `tryVectorize` returns null at `map.js:254-256`: `laneAccess` is `liveout` (`t` is written before it is read in an iteration, and read after the loop) and `constantFlagStore` is false. `tryGeneralMap` at `map.js:603` (`access === 'read' || 'liveout'`), `tryGeneralStencil` `stencil.js:435`, `tryToneMap` `tone-map.js:183`: the same test. The legality would accept it (`legality.js:86`, `liveout` with `landed`); the recognizers' own decline is earlier and coarser (`index.js` header: "the recognizers' own declines read the coarser scan").
- V: spelled `{ const t = a[i] * 2; b[i] = t + 1 }` it is lifted.
- Fact: none from the emitter. The liveness is the vectorizer's own (`liveOutOf`); the missing piece is landing the last lane of `t`.

### 7. `b[i] = a[0] + i` and `b[i] = a[i] * b[0]`
- **7a** (V, B): f64: `tryVectorize` fails with "`f64.convert_i32_s`: no lane-pure SIMD mapping for f64" (`lift.js:1043`, via `map.js:387`: the counter converted to f64 as data). i32: "`$tw1`: address/induction var used as lane data" (`lift.js:764`). u8: `map.js:216` returns null with no reason. `tryRampMap`, which exists for counter-as-data (`i & 127`), fails earlier on f64 and i32: `ramp.js:33` calls `matchBlockLoop(blockNode, { multiInc: true })` without `allowPreamble`, and the block carries LICM's `(local.set $__li0 …)`, so `scaffold.js:235` returns null (V: `RampMap@scaffold.js:235>ramp.js:33`). For u8 it reaches `ramp.js:114` (`loadsOk`).
- Fact: the counter as an induction value, `splat(i) + [0, 1, …]·step`: counter, start and step: the 6b facts, plus for f64 a convert lowering.
- **7b** (V): `tryVectorize` `map.js:216` (`scanForLoadsStores` has no form for a load at a constant index of an array the loop stores). **This is a true dependence**: iteration 0 stores `b[0] = a[0] * b[0]` and every later iteration reads the new `b[0]`. No fact admits it; a correct legality must refuse it (it does: no lift, and the answer equals Node's).

### 8. `m = Math.min(m, a[i])` and `if (a[i] < m) m = a[i]`
- **8a f64** (V): lifted, both levels (`tryReduce`, `f64x2.min`: v128 ops 6 at level 2, 109 at speed). **8a i32/u8** (V): no lift. `tryReduce` returns null at `reduce.js:337`: `scanExpr` refuses the load because the element is i32 and the lane is f64 (`reduce.js:319` `ltw !== laneType`: only f32 under f64 is allowed to widen); the accumulator `m` is f64 (it starts at `Infinity`). The widening min/max exists for u8…i16 loads (`MINMAX_CVT`, `reduce.js:~280-295`), not i32. `tryGeneralReduce` `reduce.js:748` (same scan).
- **8b f64** (V): level 2: `tryReduce` returns null at `reduce.js:165` (`if (!vecState.relaxF32) return null`: the only divergence of `pmin`-over-lanes from the scalar is the sign of a zero result, so it rides the relaxed tier); speed: lifted. **8b i32/u8**: as 8a.
- Fact: i32/u8: none from the emitter (a widening lowering: i32 → f64 min). f64: the relaxation is the tier.

### 9. `b[i] = a[i] > 0 ? a[i] : -a[i]` over Int32Array, Int16Array, Uint8Array
- V (B and A, both levels): scaffold matches; no lift. Reason recorded: `lift.js:910` "conditional without lane-typed result" from `tryVectorize`, `tryGeneralMap`, `tryGeneralStencil` (and `tryRampMap` for u8; `tryToneMap` for i32: "tonemap: block: no lane mapping"). IR (i32): `(if (result f64) (i32.gt_s (i32.load …) 0) (then (f64.convert_i32_s (i32.load …))) (else … (f64.neg …) with a NaN canon select))`, stored as `(i32.wrap_i64 (i64.trunc_sat_f64_s tw3))` under a `f64.lt (f64.abs tw3) 9.2e18` test: the arithmetic is f64 (`-INT_MIN` is not an int32), the store wraps.
- Fact (I): the stored value is `ToInt32` of an integer-valued double in [−2³¹+1, 2³¹]; `i32x4.abs`/`neg` over the wrapped integer give the same bits. That is an integrality + range fact on the arms (the emitter's `intExprRange`) and a statement that the only consumer wraps. The `irange` mark carrying ranges is dropped by 8 passes before the vectorizer.

### 10. `s += a[i]` and `s += a[i] * c[i]` over Int32Array, Int16Array, Uint8Array (and Float64Array)
- **Int32 and Int16/Uint8 for the product** (V): scaffold matches; `tryReduce` returns null at `reduce.js:337` (the i32 load under the f64 lane, `:319`); `tryReduceBitExact` `reduce.js:516`; `tryGeneralReduce` `reduce.js:748`. `s` is an f64 (a Number sum). **Int16 and Uint8 `s += a[i]`** (V): lifted by the widening sum (`reduce.js:271-277`, i32 accumulator fed by one narrow load), both levels.
- **Float64Array, level 2 vs speed** (V): both lift with `tryReduce`. Level 2: one `f64x2` accumulator (sum: 6 v128 ops; dot: 8). Speed: `reduceUnroll` four accumulators (`reduce.js:396`; sum 21, dot 29). **Both answer differently from Node in the last bits on inexact data** (top of the report): the sum is reassociated in both tiers, and `reduce.js:163` calls it "the ULP reassociation the sum reductions already accept".
- Fact: for i32: none from the emitter (lowering). Whether a Number sum of ints may be reordered exactly depends on the element ranges (|sum| < 2⁵³: u8 products × 2³² elements fit, i32 does not in general); the accumulator range is not in the link.

### 11. `for (let i = 0; i <= n; i++)` and `for (let i = 0; i !== n; i++)` (`b[i] = a[i] + 1`)
- **11a, B** (V): `S12 exit comparison i32.le_s`: `scaffold.js:312-313` ← `addr-model.js:60`. Link `{"iv":"if2_2","hull":{"lo":0,"hi":61},"test":{"lo":0,"hi":62},"guard":"if2_2","guardRange":[61,61],"boundConst":61}`. **11a, A** (V): lifted by `tryVectorize` (both levels): the emitter's int copy (`versionIntegralLoops`, `plan/integral-loops.js:2132`) snaps the bound into a fresh local (`$nf2_0bound10`) and the exit is `(i32.lt_s i $nf2_0bound10)`, so `<=` reaches the scaffold as `lt_s` (V: IR). In B the bound is already an i32, no int copy is made, and `i32.le_s` stays.
- Fact: the exit comparison as written, with `guardRange` hi below 2³¹ − 1: then `i <= B` is `i < B + 1`. V: spelled `i < n + 1`: lifted.
- **11b** (V, A and B): `S9 f64 counter step`; link all null (`iv: null`: `!==` is not a relational op, `guardCounterName`, `static.js:514`); IR `(f64.ne i (f64.convert_i32_s n))`, `i = i + 1.0`. `normalize.js:23-25` rewrites `i !== B` to `i < B` only for a counter declared from an integer literal against a constant B visible at normalize time; here B is `a.length - 3`, a constant only at emit (`boundConst` 61, `intExprRange`).
- Fact: start ≤ bound and `i` an integer, hence `!==` ≡ `<`; the emitter knows the start literal and the bound's range, but records neither for a `!==` guard. V: spelled `i < n`: lifted.

### 12. `for (let i = 0, k = 0; i < n; i++, k++) s += a[i] * b[k]`
- **Level 2, f64** (V): lifted: `canonicalizeCounters` (`counter-run.js`) rewrites `k` over `i`, `tryReduce` takes the rewritten loop (`index.js` retry). **Level 2, i32**: as row 10b (`reduce.js:337`).
- **Speed** (V): no scaffold. The loop reaches the vectorizer unrolled by two: bound `i < n - 1` (`(i32.sub n 1)`), two copies of the body with `f64.load offset=8` for `a[i + 1]`, `k = k + 1` between them, `i = i + 2`. The link of the new loop is `{"hull":null,"guardRange":[60,60],"boundConst":60}` (the unrolled `while`'s own). First refusal `scaffold.js:302-303` (c = 2).
- **The pass** (V: flag test `t2.mjs`: `unrollScalarChain: false` gives `LIFT tryReduce`; `unrollRecurrence: false` and `carryKeys: false` do not change it): **`unrollScalarChains`**, `src/compile/loop-recurrence.js:333` (the function `tryUnrollScalarChain`, `:253`), called from `src/compile/analyze-for-emit.js:110` under `_o.unrollScalarChain === true`; the flag is on in `L3_PRESET` (`config.js:66`, which `'speed'` is, `config.js:199`) and off in `L2_PRESET` (`:67`). It runs on the AST before emit.
- **Its predicate** (V: read, and `JZ_DBG_USC` printout `carried [ 'sf2_2int6', 'kf2_4int8' ] stepped [] chained true`): `for` with a unit step (`:261`), a head `let` counter from a literal ≥ 0 (`:264-267`), `<`/`<=` against a name or literal (`:268-270`), no calls, nested loops or `break` (`:271`), no stores (`:275-277`), then `carried` = outer names the body assigns (`:283-288`), `if (!carried.size) return null` (`:289`), `stepped` = carried names whose every write is a constant step (`:295-301`), and the chain test (`:306-310`): **some element read whose index mentions a carried name not in `stepped`**. For `s += a[i] * b[k]` the carried names are `s` and `k` (`k++` is a body statement after normalization). `stepOf` (`:295-296`) accepts `x += K`, `x -= K`, `x = x ± K` and **not `['++', k]`**, the form `src/normalize.js:13-17` rewrites every unit step into; so `k` is not "stepped", `b[k]` mentions a carried name, `chained` is true, and the loop is unrolled by two. All three spellings (`k++`, `k += 1`, `k = k + 1`) and `k++` as a body statement are unrolled (V, `t3.mjs`).
- **Why the one-counter spelling is not**: `s += a[i] * b[i]` carries only `s`, which no element index mentions: `chained` false, `:311` returns null (`JZ_DBG_USC`: `no-chain, carried: [ 'sf2_2' ]`).
- Fact: none from the emitter; a defect of the unroller's recognizer (it believes `k` is a chain). A step recognizer that reads the normalized form (`++k`) makes the two spellings equal.

### 13. `b[i] = a[i] + c[i]` into a Uint8ClampedArray
- **B** (V, both levels): lifted by `tryRampMap`, v128 ops 18. IR the vectorizer sees: `tw1 = i32.add (i32.load8_u a+i) (i32.load8_u c+i)`; `i32.store8 b+i (select 0 (select 255 (local.tee $clamp2 tw1) (i32.gt_s $clamp2 255)) (i32.lt_s $clamp2 0))`: the clamp's temporary is a `local.tee` whose value the two comparisons re-read, written before read in an iteration; `laneAccess` is `write`.
- **A** (V, both levels): no lift. IR: `tw4 = f64.add (f64.convert_i32_u (i32.load8_u …)) (f64.convert_i32_u (i32.load8_u …))`, stored as `i32.store8 (i32.trunc_sat_f64_u (f64.nearest (f64.min (f64.max tw4 0) 255)))`. Reasons: `tryVectorize` "`f64.add`: no lane-pure SIMD mapping for i8" (`lift.js:1043`); `tryRampMap` "`i32.trunc_sat_f64_u`: no lane-pure SIMD mapping" ; `tryGeneralMap`, `tryGeneralStencil` as `tryVectorize`.
- Fact: the sum of two bytes is an integer in [0, 510], so the f64 add, `nearest` and the f64 clamp are integer arithmetic; in B the emitter wrote it as i32 (the counter hull gave unchecked loads), in A it stays f64 and `narrowInts` is after the vectorizer. An integer-range fact on the sum, which the emitter holds (`intExprRange`) and drops as `irange`.

### 14. spmv (`bench/spmv/spmv.js`)
- **The bench's own unit** (V, census rows of `bench/spmv` at speed): the inner loop `for (let k = rowPtr[r]; k < end; k++) sum += values[k] * x[colIdx[k]]` (`$spmv $brk1`) **has a scaffold** (unit step, `lt_s` exit, bound the local `end`), link `{"iv":"kf3_8","hull":{"lo":0,"hi":65535},"step":1,"boundConst":null}` (the hull is the typed length), and is refused by the reduction recognizers on the gather: `tryReduce` `reduce.js:337` (`scanExpr` finds a load whose address is no lane address: `matchLaneAddr` null, `addr-model.js:228,283`), `tryGeneralReduce` `reduce.js:748` (`matchStrideAddr` null, `addr-model.js:375`), `tryGeneralMap` `map.js:508` (no gather form for an index read from an array), `tryGatherMap` `gather-map.js:18`. No reason recorded. The outer loop (`$brk0`): scaffold matches, nested loop (L2). The accumulation `sum += …` is the carried local (L7).
- **My module-level form** (V): the inner loop is `S9 f64 counter step`: `us25_kf2_4int18` is an **f64** local (`f64.convert_i32_s (i32.load …)`), the test `f64.lt`, the step `f64.add 1.0`, reads through `i64.trunc_sat_f64_s`; it is the `then` arm of a versioned guard (`|end| <= 2^31`, `end - 1 < len(values)`, `k == floor(k)`, `|k| <= 2^31`, `k >= 0` …) with `hull: null`. The bench form has typed-array parameters and a constant `ROWS`, which gives the int32 copy; mine (`r < n`, `n` a Number) does not. Do not read the module form as the bench.
- Fact: for the bench form no emitter fact admits it: it is a reduction over an indirect load (`x[colIdx[k]]`, a bounds-checked gather: `i32.lt_u idx len` selects NaN), which needs a gather lowering (per-lane scalar loads packed into a vector: wasm SIMD has no gather) and a cost judgement (`cost-model.js`); the dense recognizers decline it by design. The facts it already has (counter, hull, bound local, step 1) are in the link and the scaffold.

### 15. `a[n - i] = a[i]` (i from 1), `b[n - 1 - i] = a[i]`
- **15a f64, B** (V): lifted, both levels (`tryVectorize`, mirror site `map.js:178`, `matchMirrorAddr` `addr-model.js:239`; the strip opens behind the legality's overlap test, 6a). **15a i32/u8** (V): `tryVectorize` `map.js:216` (`sty === 'f64'` at `map.js:178`: the mirror site class is f64 only); `tryGeneralMap` `map.js:552`; `tryMemCopyFill` `memcpy.js:147`.
- **15b f64, B** (V): `tryVectorize` `map.js:216` ← `addr-model.js:250-251`: `INV` must be `(local.get $x)` or a constant, and here it is `(i32.sub (local.get $nf2_1) (i32.const 1))`. **15b i32/u8**: `map.js:178`.
- Fact: 15b: "`n - 1` is loop-invariant" (the vectorizer derives invariance from `bl.writes`, `scaffold.js:177`; `stencil.js:13-19` `boundPureInv` is the matcher for a pure invariant expression and `matchMirrorAddr` does not use it). 15a ints: a lowering (lane reverse for i32x4, i8x16), no emitter fact.

### 16. `while (i < n) { b[i] = a[i] + 1; i++ }` and `do { … } while (++i < n)`
- **while** (V): lifted at both levels (`tryVectorize`); link `{"iv":"if2_2int6",…,"boundConst":61}`.
- **do-while** (V, A and B): no scaffold. `normalize.js:26-29` lowers it to a flag loop (`let F = true; while (F || ++i < n)`); IR top exit `(br_if $brk0 (i32.eqz (if (result i32) (flag-test of $do0) (then (i32.const 1)) (else (f64.lt (local.tee $if2_2 (f64.add (local.get $if2_2) (f64.const 1))) (f64.convert_i32_s n))))))`, the step inside the test, the counter f64; link all null. `scaffold.js:310` (`S9 last statement is not a counter step (if)`; `matchIncN` on the trailing statement) and `addr-model.js:58` (the test is an `if`, not `i32.eqz`).
- Fact (I): trip count `max(1, n − i0)`: a counted loop whose first iteration is unconditional; the flag loop is the lowering `normalize.js` chose because the test has a side effect.

### 17. `for (const x of a) s += x`, `a.forEach((x, i) => { b[i] = x + 1 })`, `a.map(x => x + 1)` (Float64Array)
- **for…of** (V): lifted by `tryReduce` (v128 ops 6 / 21); the loop is an AST `for` and has a link (`"iv":"i0","hull":{"lo":0,"hi":63},"boundConst":64`).
- **forEach** (V): lifted by `tryVectorize`; the loop is built by `walk` (`ir/arrays.js:61`) and has **no link** (`link=none`). It lifts because the scaffold the emitter writes is the canonical one.
- **map** (V): at the vectorizer `$k` has no loop; it calls `$__simd_map_7_add_1`, the emitter's own SIMD helper (`module/typedarray.js:3057-3090`, `analyzeSimd` pattern then `genSimdMap`); the helper's two loops are `NOLINK`, scaffold `S9 step by a constant 2/…`. A callback `analyzeSimd` does not know goes to the scalar typed loop (I, not run).
