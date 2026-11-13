Scout report (Sonnet 5.5, 2026-11-13), tree `cdc3b0711` (the tree 6a landed from), read-only.
Leads, not facts: V = the scout read the line or measured it, I = inferred. Not re-derived by
the integrator. The scripts, patches and raw rows the text names (`probe.mjs`,
`instrumentation.patch`, `census-*.jsonl` and the rest) were session scratch and are not in the
repo.

# Part C: which refusals matter in real code

Scout: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Tree `land-e` `cdc3b0711` + uncommitted instrumentation of `src/optimize/vectorize/index.js` (`instrumentation.patch`; the final copy also has `__decKeep`, one line). V = measured (command or file in this directory); I = inferred.

## Method

- Every `(block (loop))` the vectorizer visits writes one row (`globalThis.__loopRec`): the first condition of `matchBlockLoop` that refuses it (a replica, `scaffoldWhy`, that throws on any disagreement with the real matcher: none did, in 20,735 rows and the probes), what each of the 13 chain recognizers reported through `whyNotSimd`'s `vecState.whyNotReason` (reset before each call), `legal()` written out in its own order to name the part that refuses, the taker, the lowering link's fields, and the loop's facts (loads, stores, nested loop, call, branch out, global write, bound shape, carried locals). Loops the walk never offers (a loop with no block around it) and skips (the emitter's `cold` twins) get their own row from a scan at entry.
- Where no recognizer reports a reason (it declines before any `liftFail`), the row gets a **derived ladder**: L1 no memory access, L2 nested loop, L3 branch or return out of the body, L4 a call not in `SAFE_OFFSET_CALLS`, L5 global write, L6 bound written in the body, L7 a local read before written (loop-carried), L8 bound an expression, L9 none of these. This is my classification, not a recognizer's: it names the first property of the loop in that order, not the check that refused it. L9 loops are then broken down by the decline site of the family's general recognizer (`tryGeneralMap` if the loop stores, `tryGeneralReduce` if not), found by an ESM load hook (`dec-hook.mjs`) that logs `file:line` of every `return null` (and, for the L9 re-run, `return false`) of `vectorize/*.js`. The hook rewrites source text at load; nothing in the worktree changes.
- **Same bytes**: 423 units compiled in a fresh node process each at `'speed'` (`child.mjs`, `run.mjs` copied from the earlier census, `--jobs 2`, `bench/jz` skipped), once on a pristine `git archive` of `cdc3b0711` and once on the instrumented worktree with the hook on: **423 of 423 sha1 of the wasm equal** (V, `census-base.jsonl` against `census-instr.jsonl`, `census-sum.mjs` first lines; no unit errored).
- Scope: 20,735 loop rows. Left out of the tables: **3,532 cold twins** (skipped by the walk by design) and **11,448 rows of runtime-helper loops** (functions named `$__*`: `__gc_*`, `__ftoa_*`, `__to_num`, … linked into most units: 421 distinct loops, 140 of them refused at "exit test not an `i32.eqz`", 96 at "last statement is not a step", 22 with a scaffold, 5 lifted in 2 `$__start` functions) so that one runtime loop is not counted 400 times. What is left, **5,753 loops of user code**, is 5,719 visited blocks and 34 bare loops. 188 units are `bench/*` and `example/*` (the real code); 235 are the generated spellings (`spell/*`, `kernel/*`: 450 loops, 84 lifted), which are not real code and are tabled apart.

## Headline (user code, 423 units, 'speed'; `heads.mjs`)

| | all | bench + example | spell + kernel |
|---|---:|---:|---:|
| loops | 5,753 | 5,303 | 450 |
| scaffold matched | 4,401 | 3,955 | 446 |
| lifted | 585 | 501 | 84 |
| scaffold matched, not lifted | 3,818 | 3,456 | 362 |
| of those with a recorded reason (recognizer's) | 713 | 678 | 35 |
| of those on the derived ladder L1-L8 | 2,592 | 2,265 | 327 |
| of those L9 | 513 | 513 | 0 |
| no scaffold | 1,318 | 1,314 | 4 |
| no block around the loop | 34 | 34 | 0 |
| loops with a load or store in them | 5,159 | 4,869 | 290 |

- **3,105 of the 3,818 matched-not-lifted loops (81%) carry no recognizer reason** (the earlier census: 3,178 of 3,895, 82%: the same finding on a corpus without the runtime helpers); this census says what they are in place of a reason (ladder and L9 sites, below).
- **The legality (`legal()`) refused no lift in the 423 units** (V: `rec.legal` set on 0 rows). Every loss in this census is before it.
- The earlier census counted 589 lifted; this one 590 (585 user + 5 in `$__start`). Not reconciled to the loop.
- The earlier census "never counted loops with NO scaffold": 1,318 + 34 here, and 11,448 rows more in runtime helpers.

## Table 1: loops whose subtree has a load or a store (all 423 units; first 40 rows)

Refusal = the first thing that refused the loop. "with link (hull)" = loops carrying a lowering link (and of them, a `hull`). "Units" = units holding at least one such loop.


loops: 5159

| refusal | loops | units | with link (hull) | top three units (loops) |
|---|---:|---:|---:|---|
| SCAFFOLD OK, L4 call in the body | 1241 | 127 | 727(611) | bench/watr (289), bench/stdlib-dists (216), bench/stdlib-special (181) |
| SCAFFOLD OK, L2 nested loop in the body | 604 | 186 | 600(366) | bench/webaudio (31), bench/decode-wav (15), example/dithering/dithering (15) |
| SCAFFOLD OK, L9 GeneralMap map.js:552 | 486 | 58 | 192(62) | bench/watr (122), bench/webaudio (52), example/wireworld/wireworld (30) |
| SCAFFOLD OK, L7 loop-carried local | 325 | 152 | 324(258) | bench/webaudio (12), bench/pcmconvert (9), bench/stdlib-special (8) |
| NO SCAFFOLD S9 f64 counter step | 252 | 54 | 252(21) | bench/webaudio (40), example/dwa/dwa (19), bench/stdlib-special (14) |
| RECOGNIZER tryVectorize: call: no lane-pure SIMD mapping for fN | 244 | 11 | 5(5) | bench/webaudio (68), bench/threeanim (41), bench/threecull (40) |
| LIFTED tryVectorize | 234 | 104 | 223(151) | bench/webaudio (36), bench/jzczhz (8), example/fireflies/fireflies (6) |
| LIFTED tryStencil | 181 | 11 | 181(165) | bench/stdlib-dists (116), bench/stdlib-special (43), example/watercolor/watercolor (5) |
| NO SCAFFOLD S9 last statement is not a counter step (any op) | 152 | 36 | 132(0) | bench/webaudio (37), bench/watr (23), bench/jessie (12) |
| NO SCAFFOLD S10 no exit test at the top (first statement is not a br_if) | 150 | 27 | 150(133) | bench/webaudio (49), bench/stdlib-dists (33), bench/stdlib-special (16) |
| NO SCAFFOLD S9 descending step (i32.sub) | 138 | 110 | 133(20) | bench/stdlib-special (6), bench/watr (6), bench/decode-alac (5) |
| NO SCAFFOLD S9 last statement sets a local to a non-step (any op) | 129 | 30 | 127(1) | bench/webaudio (21), bench/stdlib-special (19), bench/stdlib-dists (10) |
| SCAFFOLD OK, L3 branch or return out of the body | 113 | 21 | 43(12) | bench/webaudio (48), bench/watr (17), bench/jessie (7) |
| NO SCAFFOLD S11 exit test not an i32.eqz (any op) | 89 | 8 | 0(0) | bench/watr (33), bench/webaudio (32), bench/decode-wav (8) |
| RECOGNIZER tryStencil: predicated if: if is not a lane mask | 74 | 2 | 74(74) | bench/stdlib-dists (58), bench/stdlib-special (16) |
| NO SCAFFOLD S9 step by a constant != 1 (unit step only) | 68 | 55 | 68(59) | bench/stdlib-ddot (7), bench/decode-alac (3), bench/webaudio (2) |
| RECOGNIZER tryVectorize: fN.convert_iN_s: no lane-pure SIMD mapping for fN | 52 | 43 | 52(46) | bench/webaudio (9), example/jukebox/beat-6 (2), example/cradle/cradle (1) |
| LIFTED tryMemCopyFill | 52 | 36 | 52(19) | bench/radixsort (4), example/dithering/dithering (3), example/watercolor/watercolor (3) |
| LIFTED tryReduce | 50 | 42 | 48(43) | bench/stdlib-ddot (6), bench/webaudio (2), bench/stdlib-dists (2) |
| RECOGNIZER tryVectorize: conditional without lane-typed result | 48 | 9 | 1(1) | bench/threecull (8), bench/threegeom (8), bench/threescene (8) |
| RECOGNIZER tryVectorize: fN.reinterpret_iN: no lane-pure SIMD mapping for fN | 28 | 25 | 28(28) | bench/pcmconvert (4), bench/fabrik (1), bench/threescene (1) |
| RECOGNIZER tryStencil: fN.promote_fN: no lane-pure SIMD mapping for fN | 26 | 1 | 26(26) | bench/stdlib-special (26) |
| RECOGNIZER tryVectorize: select condition iN.eq not a lane comparison | 26 | 3 | 0(0) | bench/pcmconvert (14), bench/decode-wav (10), bench/stdlib-dists (2) |
| RECOGNIZER tryVectorize: fN.lt: not a lane-vectorizable comparison | 25 | 8 | 0(0) | bench/threecull (4), bench/threegeom (4), bench/threescene (4) |
| S0 loop has no block around it | 23 | 2 | 0(0) | bench/webaudio (22), bench/tokenizer (1) |
| RECOGNIZER tryVectorize: narrowing store fN->iN: unrecognized conversion | 23 | 8 | 3(0) | bench/threecull (4), bench/threegeom (4), bench/threescene (4) |
| NO SCAFFOLD S12 exit comparison i32.le_s (only lt_s/lt_u) | 20 | 8 | 20(11) | bench/blur (8), example/epicycles/epicycles (3), bench/stdlib-special (2) |
| SCAFFOLD OK, L9 GeneralMap map.js:553 | 19 | 7 | 19(6) | bench/webaudio (6), example/schrodinger/schrodinger (4), example/bz/bz (3) |
| RECOGNIZER tryStencil: if-store: arm is not a conditional store | 17 | 2 | 17(17) | bench/stdlib-special (15), bench/stdlib-dists (2) |
| RECOGNIZER tryVectorize: if-store: arm is not a conditional store | 16 | 10 | 11(4) | bench/webaudio (4), bench/decode-wav (3), example/waves/waves (2) |
| LIFTED tryGeneralMap | 14 | 7 | 14(12) | bench/decode-wav (7), example/waves/waves (2), bench/webaudio (1) |
| RECOGNIZER tryVectorize: call: no lane-pure SIMD mapping for iN | 13 | 7 | 1(0) | bench/decode-wav (2), bench/threecull (2), bench/threegeom (2) |
| NO SCAFFOLD S3 non-local.set before the loop (any op) | 12 | 4 | 0(0) | bench/mapstr (4), bench/setops (4), bench/webaudio (2) |
| RECOGNIZER tryVectorize: iN.trunc_sat_fN_u: no lane-pure SIMD mapping for iN | 12 | 6 | 0(0) | bench/decode-wav (2), bench/threecull (2), bench/threegeom (2) |
| LIFTED tryRampMap | 10 | 9 | 10(5) | example/wireworld/wireworld (2), example/nbody/nbody (1), example/epicycles/epicycles (1) |
| NO SCAFFOLD S9 step by a non-constant | 10 | 8 | 10(2) | bench/provenance (2), bench/fft (2), example/ocean/ocean (1) |
| RECOGNIZER tryStencil: predicated if: iN.eq is not a lane mask | 9 | 1 | 9(9) | bench/stdlib-special (9) |
| LIFTED tryOuterStripRest | 9 | 9 | 9(1) | example/cradle/cradle (1), example/erosion/erosion (1), example/plasma/plasma (1) |
| RECOGNIZER tryVectorize: standalone drop statement | 8 | 8 | 8(6) | bench/webaudio (1), example/magnet/magnet (1), example/sph/sph (1) |
| LIFTED tryChannelReduce | 8 | 1 | 8(4) | bench/blur (8) |


(The full table is `census-all.md`, with the unrestricted one and an appendix that does not group the S9/S10/S11 variants.)

## Table 2: the same, bench + example only (first 25 rows)


loops: 4869

| refusal | loops | units | with link (hull) | top three units (loops) |
|---|---:|---:|---:|---|
| SCAFFOLD OK, L4 call in the body | 1221 | 107 | 707(597) | bench/watr (289), bench/stdlib-dists (216), bench/stdlib-special (181) |
| SCAFFOLD OK, L2 nested loop in the body | 564 | 166 | 560(338) | bench/webaudio (31), bench/decode-wav (15), example/dithering/dithering (15) |
| SCAFFOLD OK, L9 GeneralMap map.js:552 | 486 | 58 | 192(62) | bench/watr (122), bench/webaudio (52), example/wireworld/wireworld (30) |
| NO SCAFFOLD S9 f64 counter step | 252 | 54 | 252(21) | bench/webaudio (40), example/dwa/dwa (19), bench/stdlib-special (14) |
| RECOGNIZER tryVectorize: call: no lane-pure SIMD mapping for fN | 244 | 11 | 5(5) | bench/webaudio (68), bench/threeanim (41), bench/threecull (40) |
| SCAFFOLD OK, L7 loop-carried local | 218 | 105 | 217(181) | bench/webaudio (12), bench/pcmconvert (9), bench/stdlib-special (8) |
| LIFTED tryVectorize | 185 | 75 | 174(117) | bench/webaudio (36), bench/jzczhz (8), example/fireflies/fireflies (6) |
| LIFTED tryStencil | 181 | 11 | 181(165) | bench/stdlib-dists (116), bench/stdlib-special (43), example/watercolor/watercolor (5) |
| NO SCAFFOLD S9 last statement is not a counter step (any op) | 152 | 36 | 132(0) | bench/webaudio (37), bench/watr (23), bench/jessie (12) |
| NO SCAFFOLD S10 no exit test at the top (first statement is not a br_if) | 150 | 27 | 150(133) | bench/webaudio (49), bench/stdlib-dists (33), bench/stdlib-special (16) |
| NO SCAFFOLD S9 descending step (i32.sub) | 136 | 108 | 131(18) | bench/stdlib-special (6), bench/watr (6), bench/decode-alac (5) |
| NO SCAFFOLD S9 last statement sets a local to a non-step (any op) | 129 | 30 | 127(1) | bench/webaudio (21), bench/stdlib-special (19), bench/stdlib-dists (10) |
| SCAFFOLD OK, L3 branch or return out of the body | 113 | 21 | 43(12) | bench/webaudio (48), bench/watr (17), bench/jessie (7) |
| NO SCAFFOLD S11 exit test not an i32.eqz (any op) | 89 | 8 | 0(0) | bench/watr (33), bench/webaudio (32), bench/decode-wav (8) |
| RECOGNIZER tryStencil: predicated if: if is not a lane mask | 74 | 2 | 74(74) | bench/stdlib-dists (58), bench/stdlib-special (16) |
| NO SCAFFOLD S9 step by a constant != 1 (unit step only) | 66 | 53 | 66(58) | bench/stdlib-ddot (7), bench/decode-alac (3), bench/webaudio (2) |
| LIFTED tryMemCopyFill | 52 | 36 | 52(19) | bench/radixsort (4), example/dithering/dithering (3), example/watercolor/watercolor (3) |
| RECOGNIZER tryVectorize: conditional without lane-typed result | 48 | 9 | 1(1) | bench/threecull (8), bench/threegeom (8), bench/threescene (8) |
| RECOGNIZER tryVectorize: fN.reinterpret_iN: no lane-pure SIMD mapping for fN | 28 | 25 | 28(28) | bench/pcmconvert (4), bench/fabrik (1), bench/threescene (1) |
| RECOGNIZER tryStencil: fN.promote_fN: no lane-pure SIMD mapping for fN | 26 | 1 | 26(26) | bench/stdlib-special (26) |
| RECOGNIZER tryVectorize: select condition iN.eq not a lane comparison | 26 | 3 | 0(0) | bench/pcmconvert (14), bench/decode-wav (10), bench/stdlib-dists (2) |
| RECOGNIZER tryVectorize: fN.lt: not a lane-vectorizable comparison | 25 | 8 | 0(0) | bench/threecull (4), bench/threegeom (4), bench/threescene (4) |
| S0 loop has no block around it | 23 | 2 | 0(0) | bench/webaudio (22), bench/tokenizer (1) |
| RECOGNIZER tryVectorize: narrowing store fN->iN: unrecognized conversion | 23 | 8 | 3(0) | bench/threecull (4), bench/threegeom (4), bench/threescene (4) |
| NO SCAFFOLD S12 exit comparison i32.le_s (only lt_s/lt_u) | 20 | 8 | 20(11) | bench/blur (8), example/epicycles/epicycles (3), bench/stdlib-special (2) |


## Table 3: all loops, memory or not (all 423 units; first 30 rows)


loops: 5753

| refusal | loops | units | with link (hull) | top three units (loops) |
|---|---:|---:|---:|---|
| SCAFFOLD OK, L4 call in the body | 1241 | 127 | 727(611) | bench/watr (289), bench/stdlib-dists (216), bench/stdlib-special (181) |
| SCAFFOLD OK, L2 nested loop in the body | 604 | 186 | 600(366) | bench/webaudio (31), bench/decode-wav (15), example/dithering/dithering (15) |
| SCAFFOLD OK, L9 GeneralMap map.js:552 | 486 | 58 | 192(62) | bench/watr (122), bench/webaudio (52), example/wireworld/wireworld (30) |
| NO SCAFFOLD S9 f64 counter step | 390 | 59 | 390(21) | bench/stdlib-special (64), bench/webaudio (45), bench/stdlib-dists (43) |
| SCAFFOLD OK, L7 loop-carried local | 325 | 152 | 324(258) | bench/webaudio (12), bench/pcmconvert (9), bench/stdlib-special (8) |
| SCAFFOLD OK, L1 no memory access in the loop | 305 | 165 | 285(199) | bench/webaudio (47), bench/stdlib-special (16), bench/watr (13) |
| RECOGNIZER tryVectorize: call: no lane-pure SIMD mapping for fN | 244 | 11 | 5(5) | bench/webaudio (68), bench/threeanim (41), bench/threecull (40) |
| LIFTED tryVectorize | 234 | 104 | 223(151) | bench/webaudio (36), bench/jzczhz (8), example/fireflies/fireflies (6) |
| NO SCAFFOLD S9 last statement sets a local to a non-step (any op) | 206 | 43 | 176(1) | bench/stdlib-special (40), bench/webaudio (24), bench/stdlib-dists (17) |
| NO SCAFFOLD S9 last statement is not a counter step (any op) | 183 | 40 | 151(0) | bench/webaudio (48), bench/watr (27), bench/jessie (14) |
| LIFTED tryStencil | 181 | 11 | 181(165) | bench/stdlib-dists (116), bench/stdlib-special (43), example/watercolor/watercolor (5) |
| NO SCAFFOLD S10 no exit test at the top (first statement is not a br_if) | 161 | 27 | 161(144) | bench/webaudio (51), bench/stdlib-dists (34), bench/stdlib-special (17) |
| NO SCAFFOLD S9 descending step (i32.sub) | 142 | 111 | 137(22) | bench/stdlib-special (9), bench/watr (6), bench/decode-alac (5) |
| SCAFFOLD OK, L3 branch or return out of the body | 113 | 21 | 43(12) | bench/webaudio (48), bench/watr (17), bench/jessie (7) |
| NO SCAFFOLD S11 exit test not an i32.eqz (any op) | 89 | 8 | 0(0) | bench/watr (33), bench/webaudio (32), bench/decode-wav (8) |
| RECOGNIZER tryStencil: predicated if: if is not a lane mask | 74 | 2 | 74(74) | bench/stdlib-dists (58), bench/stdlib-special (16) |
| NO SCAFFOLD S9 step by a constant != 1 (unit step only) | 69 | 55 | 69(60) | bench/stdlib-ddot (7), bench/decode-alac (3), bench/webaudio (2) |
| RECOGNIZER tryVectorize: fN.convert_iN_s: no lane-pure SIMD mapping for fN | 52 | 43 | 52(46) | bench/webaudio (9), example/jukebox/beat-6 (2), example/cradle/cradle (1) |
| LIFTED tryMemCopyFill | 52 | 36 | 52(19) | bench/radixsort (4), example/dithering/dithering (3), example/watercolor/watercolor (3) |
| LIFTED tryReduce | 50 | 42 | 48(43) | bench/stdlib-ddot (6), bench/webaudio (2), bench/stdlib-dists (2) |
| RECOGNIZER tryVectorize: conditional without lane-typed result | 48 | 9 | 1(1) | bench/threecull (8), bench/threegeom (8), bench/threescene (8) |
| S0 loop has no block around it | 34 | 2 | 0(0) | bench/webaudio (32), bench/tokenizer (2) |
| RECOGNIZER tryVectorize: fN.reinterpret_iN: no lane-pure SIMD mapping for fN | 28 | 25 | 28(28) | bench/pcmconvert (4), bench/fabrik (1), bench/threescene (1) |
| RECOGNIZER tryStencil: fN.promote_fN: no lane-pure SIMD mapping for fN | 26 | 1 | 26(26) | bench/stdlib-special (26) |
| RECOGNIZER tryVectorize: select condition iN.eq not a lane comparison | 26 | 3 | 0(0) | bench/pcmconvert (14), bench/decode-wav (10), bench/stdlib-dists (2) |
| RECOGNIZER tryVectorize: fN.lt: not a lane-vectorizable comparison | 25 | 8 | 0(0) | bench/threecull (4), bench/threegeom (4), bench/threescene (4) |
| RECOGNIZER tryVectorize: narrowing store fN->iN: unrecognized conversion | 23 | 8 | 3(0) | bench/threecull (4), bench/threegeom (4), bench/threescene (4) |
| NO SCAFFOLD S12 exit comparison i32.le_s (only lt_s/lt_u) | 22 | 8 | 22(11) | bench/blur (8), example/lenia/lenia (4), example/epicycles/epicycles (3) |
| SCAFFOLD OK, L9 GeneralMap map.js:553 | 19 | 7 | 19(6) | bench/webaudio (6), example/schrodinger/schrodinger (4), example/bz/bz (3) |
| RECOGNIZER tryStencil: if-store: arm is not a conditional store | 17 | 2 | 17(17) | bench/stdlib-special (15), bench/stdlib-dists (2) |


## The memory loops by class (`groups.mjs`)

A = a scaffold refusal an emitter fact could undo (the form of the counter, step or exit); B = other scaffold refusals; C = scaffold matched, not a candidate by shape (derived ladder); R = a recognizer's recorded reason; D = L9.

```
all memory loops: 5159
   585  11.3% 0 lifted
   252   4.9% A1 counter is f64
   138   2.7% A2 descending step
    68   1.3% A3 step by a constant != 1
    20   0.4% A4 exit is <= / >= / >
     8   0.2% A6 step by a non-constant
   150   2.9% B1 no top exit test (first statement is not a br_if)
    89   1.7% B2 exit test not an eqz of a compare (bottom/other test)
   281   5.4% B3 the statement before the back edge is no counter step
    13   0.3% B4 other scaffold refusal (S12)
    12   0.2% B4 other scaffold refusal (S3)
     7   0.1% B4 other scaffold refusal (S4)
   604  11.7% C L2 nested loop in the body
   113   2.2% C L3 branch or return out of the body
  1241  24.1% C L4 call in the body
     3   0.1% C L5 global write in the body
   325   6.3% C L7 loop-carried local
     1   0.0% C L8 bound is an expression
   513   9.9% D L9 scaffold, no reason (address form, op mapping or dependence)
    23   0.4% F no block around the loop
   713  13.8% R recognizer reason recorded

real memory loops: 4869
   501  10.3% 0 lifted
   252   5.2% A1 counter is f64
   136   2.8% A2 descending step
    66   1.4% A3 step by a constant != 1
    20   0.4% A4 exit is <= / >= / >
     8   0.2% A6 step by a non-constant
   150   3.1% B1 no top exit test (first statement is not a br_if)
    89   1.8% B2 exit test not an eqz of a compare (bottom/other test)
   281   5.8% B3 the statement before the back edge is no counter step
    13   0.3% B4 other scaffold refusal (S12)
    12   0.2% B4 other scaffold refusal (S3)
     7   0.1% B4 other scaffold refusal (S4)
   564  11.6% C L2 nested loop in the body
   113   2.3% C L3 branch or return out of the body
  1221  25.1% C L4 call in the body
     3   0.1% C L5 global write in the body
   218   4.5% C L7 loop-carried local
     1   0.0% C L8 bound is an expression
   513  10.5% D L9 scaffold, no reason (address form, op mapping or dependence)
    23   0.5% F no block around the loop
   678  13.9% R recognizer reason recorded
```


Reading it:
- **A is 486 of 5,159 memory loops (9.4%), 10.6% of the 4,574 refused**: f64 counter 252, descending 138, step by a constant other than 1 68, exit `<=`/`>=`/`>` 20, step by a non-constant 8. `i + K < n` (S13) occurs in **0** loops of the corpus. Those 486 loops are what 6b's facts can reach at most: whether a recognizer takes each once the scaffold passes is not measured (the t3 re-spellings of part B say yes for the kernels in the brief, no more).
- **A1 (f64 counter, 252 loops, 54 units)**: every one has a link, but only 21 have a `hull`: the fact missing is that the counter is a word, not a spelling of the exit. The vectorizer sees `f64.lt`/`f64.add` because `narrowInts` runs after it (`pass-table.js`).
- **A2 (descending, 138 loops in 110 units)**: the same loops as the spelling gate's `reverse i--`; 133 have a link, 20 a hull.
- **B3 (281)**: the statement before the back edge is not `i = i + c`. The ops it sets a local from are `i32.load`, `local.get`, `i32.and`, `f64.mul`, `call`, … (V, the unmerged table), so these are cursor or pointer walks, not counted loops (I). **B1 (150, 49 in `bench/webaudio`, 33 in `bench/stdlib-dists`)**: the first statement is an `if`: in the one loop I dumped (`bench/stdlib-dists $formatInterpolate`) it is the per-iteration arena-release test inserted before the exit test (`control-flow.js` `iterationRelease`): an allocating loop (I for the rest). **B2 (89, 8 units)**: a bottom or non-`eqz` test (`i32.ge_u`, …).
- **C (2,287 = 44%)**: a call in the body (1,241), a nested loop (604), a branch out (113), a carried local (325). None is a scaffold form; no emitter fact about the counter changes them. The 325 carried locals are mostly reductions the recognizers refuse for their element or accumulator type or a gather (row 10, 14 of part B). Which calls the 1,241 make was not measured.
- **R (713)**: 244 are `tryVectorize: call: no lane-pure SIMD mapping for fN` (a math call in the lane expression: `sin`, `exp`, … in `bench/webaudio`, `threeanim`, `threecull`), 74 `tryStencil: predicated if: if is not a lane mask`, 52 `fN.convert_iN_s: no lane-pure mapping`, 48 `conditional without lane-typed result` (row 9 of part B), then a tail of operator mappings. Lowering gaps (6c), not facts.
- **D (513, L9) by decline site**: see below. 298 of them (14 units) are loops that change element width between a load and a store.

### L9 loops by decline site

The 513 loops with a matched scaffold, no recorded reason and nothing on the ladder (L1-L8), re-run with `return false` sites logged too (`dec-hook2.mjs`, last 16 sites kept, `census-l9b.jsonl`, 63 units). Every one of these loops has a store; the decline is of `tryGeneralMap` (file `map.js` unless noted), leaf = the innermost recorded site:

| loops | units | decline | meaning (V = I read the line) |
|---:|---:|---|---|
| 298 | 14 | `map.js:538`, then `:552` | a store whose element type differs from the first access's lane type: loops that change width (bytes to words, f32 to f64, i32 to f64). `map.js:538` `else if (st !== laneType) return false` |
| 103 | 36 | `map.js:529` via `gatherOf` (`:475`, `:500`, `:508`) | a load whose address is neither affine in the counter nor a gather the matcher knows |
| 53 | 17 | `map.js:540` (`matchAddr(n[1])` null) | a store whose address is not affine in the counter (a scatter, a fixed slot, a pointer walk) |
| 19 | 14 | `map.js:525` | two different load lane types in one loop |
| 16-19 | 8 | `map.js:553` | no store, or no load, among the sites |
| 8 | 2 | `map.js:552`, no leaf recorded | the scan declines at a node with no `return false` of its own |
| 4 | 2 | `map.js:603` | a carried or live-out local (the recognizer's own, coarser test) |
| 3 | 2 | `map.js:561` | `aliasGuards` null: a same-base distance that is not invariant, or `version` off |


## Bare loops (no block around them)


- then / last br: 22
- else / last br: 12


(V: a `loop` whose parent is an `if` arm, 34 of 5,753. I: a loop emitted inside a conditional arm with no brk block of its own.)

## Lowering-link coverage of the visited `(block (loop))` nodes


all: 4240/5719; scaffold matched: 3090/4401; lifted: 572/585; no scaffold: 1150/1318
link present: 4240; iv null: 444; hull: 2440; step 1: 2377; step>1: 63; counters>0: 2; guard set: 3695; boundConst: 1948
scaffold matched: 4401; of them link present: 3090; with hull: 2178


bench+example only:

all: 3792/5269; scaffold matched: 2646/3955; lifted: 490/501; no scaffold: 1146/1314
link present: 3792; iv null: 444; hull: 2107; step 1: 2045; step>1: 62; counters>0: 2; guard set: 3249; boundConst: 1863
scaffold matched: 3955; of them link present: 2646; with hull: 1848


## What this says for 6b (I unless marked)

1. The scaffold forms the brief names are **rare in real code except the counter's own type**: f64 counters 252, descending 138, stride 68, `<=` 20, `i + K < n` 0. The largest scaffold group is the f64 counter, and what it lacks is a word counter, not a different exit spelling. 6b as "facts from the emitter" reaches about a tenth of the refused memory loops at most.
2. Of the loops that already have a scaffold, **the recognizers' own limits** decide: calls, nested loops, carried locals, width-changing stores, non-affine addresses. 6c's lowerings by cost, not 6b's facts, address that mass.
3. The link is present on 74% of the visited loops; a vectorizer that reads facts from it needs the other 26% (loops built by `walk`, the stdlib, cold twins, passes) to carry one too, or to fail open to the WAT matcher as today.
4. `plan.counters` is nearly dead (2 loops): the facts for `i++, k++` are not in the link.
5. The legality refused nothing here; the corpus does not exercise it.
