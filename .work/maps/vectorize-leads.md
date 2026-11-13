Scout report (Sonnet 5.5, 2026-11-12), tree `d50ccbfbf`, read-only. Leads, not facts: V = the
scout read the line or measured it, I = inferred. The nine programs of `vectorize-leads.md` were
run again by the integrator on `d50ccbfbf` and on the published `v1.0.2`: all nine differ from
Node on both. The scripts the text names (`leads-minimal.mjs`, `ablate.mjs`, the raw rows and
tables) were session scratch and are not in the repo.

# D. Soundness leads

Nothing was fixed. Every program below is plain JS (typed arrays at module level, one export `f`); each was compiled at levels 2, 3 and `'speed'` with `jz(src, { optimize })` and compared with `oracle(src).f()` (Node), `test/util.js`. Scripts: `leads-minimal.mjs` (the nine failures, whole programs), `leads-mod.mjs` and `leads.mjs` (every lead tried), outputs `leads-minimal-run.txt`, `leads-mod-run1.txt`, `leads-run1.txt`. For each failure I also ran jz with the vectorizer off (`optimize: { level, vectorizeLaneLocal: false, slp: false }`: correct in all nine) and with only the suspected recognizer skipped (`JZ_VEC_SKIP`, `lead-confirm-all.mjs`: correct in each case run, listed below).

Why module-level arrays: jz refuses a call that stores into an argument and reads it back through a Uint8/Int32 view (`f() stores into argument 1 and reads it back, so it takes a Float64Array, a Float32Array or an Array`), and function-argument arrays have an unknown element kind so most loops compile scalar; the first batch (`leads.mjs`, arguments) therefore mostly says "scalar". It still found W1 (answer wrong from arguments at all three levels).

## Nine programs whose answer differs from Node's (all levels 2, 3, 'speed'; vectorizer off: correct)

Format: program; node answer; jz answer (identical at the three levels); recognizer; lines; confirmation.

### W1. tryReduce -> tryReduceBitExact keeps a lane local only as a vector temp (reduce.js:512-611; no `outsideReads` in that function)
```js
const a = new Float64Array(64)
export let f = () => {
  for (let i = 0; i < 64; i++) a[i] = ((i * 7) % 13) - 5.75
  let s = 0, d = 0
  for (let i = 0; i < 64; i++) { d = a[i] * 2; s = s + d * d }
  return s + d
}
```
node 3668.5; jz 3656 (`d` read after the loop is its pre-loop value 0: the difference is 12.5 = d). The loop has two `local.set` statements, `s = s + EXPR`, no store: BitExact's shape (reduce.js:517-525); the lane local `d` lives only in a v128 temp (reduce.js:553-570); the 64-trip loop runs no scalar tail, so the scalar `d` is never written. `grep outsideReads reduce.js`: lines 45, 57, 104, 122 only (load-cache and select-assign temps). Confirmed: `JZ_VEC_SKIP=tryReduce` makes it correct. From arguments (`leads.mjs` A1) also wrong.

### W2. tryRampMap accepts two trailing `i += 1` (ramp.js:62; scaffold.js:248-267 `multiInc`)
```js
const a = new Uint8Array(64)
export let f = () => {
  for (let i = 0; i < 64; i++) { a[i] = i & 127; i++ }
  let h = 0
  for (let i = 0; i < 64; i++) h = (h * 31 + a[i]) % 1000003
  return h
}
```
node 990681; jz 396383. The body's `i++` and the loop's own step form the run `[{i,1},{i,1}]` (matchIncN, scaffold.js:252-258); ramp.js:62 only checks each increment names the IV; ramp.js:336-337 then emits both `i += LANES`. Confirmed: skip `tryRampMap` fixes. (Agent lead L-R3 i.)

### W3. tryRampMap: a conditional store in the body is never checked (ramp.js:52-55 scans top-level stores; lift.js:494-545 lifts an if-store as a 16-byte `v128.store`)
```js
const a = new Uint8Array(64), b = new Uint8Array(64)
export let f = () => {
  for (let i = 0; i < 64; i++) { a[i] = i & 127; if ((i & 1) === 0) b[i] = 7 }
  let h = 0
  for (let i = 0; i < 64; i++) h = (h * 31 + b[i]) % 1000003
  return h
}
```
node 685120; jz 730146. Confirmed: skip `tryRampMap` fixes. (Agent lead L-R1.)

### W4. tryRampMap: `byteValueRange` admits a shift by 16 (ramp.js:160 `s > 16`; ramp.js:207 emits `i16x8.shr_u` with count 16, taken mod 16 = 0)
```js
const a = new Uint8Array(64), b = new Uint8Array(64)
export let f = () => {
  for (let i = 0; i < 64; i++) a[i] = (i * 37 + 11) & 127
  for (let i = 0; i < 64; i++) b[i] = (a[i] * a[i]) >> 16
  let h = 0
  for (let i = 0; i < 64; i++) h = (h * 31 + b[i]) % 1000003
  return h
}
```
node 0 (every product < 2^16); jz 889065. Confirmed: skip `tryRampMap` fixes. Fix would be `s > 15` (agent lead L-R5). The shift by 8 control (`M-R5b-shr8`) is correct.

### W5. tryToneMap: an intermediate store in a conditional arm is lifted unmasked (tone-map.js:480-488 `arm()`, 457-461)
```js
const d = new Int32Array(64), a = new Int32Array(64), b = new Int32Array(64)
export let f = () => {
  for (let i = 0; i < 64; i++) d[i] = (i * 37 + 11) & 127
  for (let i = 0; i < 64; i++) { const v = d[i]; if (v > 60) { b[i] = 7; a[i] = (Math.log(v * 1.5 + 1) * 20) | 0 } }
  let h = 0
  for (let i = 0; i < 64; i++) h = (h * 31 + a[i] + b[i]) % 1000003
  return h
}
```
node 45901; jz 849478. Confirmed: skip `tryToneMap` fixes. (Agent lead L-T1.) Note: the why-not reporter says for the same shape under `tryVectorize`: "if-store: arm has a side-effecting intermediate statement (would run unconditionally)" (lift.js): the shared lifter has the guard that tone-map's private lift lacks.

### W6. tryDivergentEscapeVectorize: a scalar the epilogue writes and the inner loop reads is splatted once per pair (divergent-escape.js:182-190; no write test for a local c-var, only `global.get` gets `writesName`, :192)
```js
const out = new Float64Array(64)
export let f = () => {
  let k = 0.5
  for (let x = 0; x < 64; x++) {
    let zx = 0, it = 0
    while (it < 50) { zx = zx * zx + k; if (zx > 4) break; it++ }
    out[x] = it
    k = k + 0.001 * it
  }
  return k
}
```
node 0.7350000000000002; jz 0.7360000000000002 (a different per-pixel `k` sequence). Confirmed: skip `tryDivergentEscapeVectorize` fixes. (Agent lead DE-2.)

### W7. tryVectorize mirror store: no same-base dependence test (map.js:178-186, no distance check; alias.js:285 skips same-base pairs in gateStrips)
```js
const a = new Float64Array(64)
export let f = () => {
  for (let i = 0; i < 64; i++) a[i] = ((i * 7) % 13) - 5.75
  for (let i = 1; i < 63; i++) a[63 - i] = a[i]
  let h = 0
  for (let i = 0; i < 64; i++) h = (h * 31 + a[i]) % 1000003
  return h
}
```
node -578412; jz -588998. An in-place reversal whose strip (31, 32) reads both elements before storing swapped lanes (the scalar loop copies a[31] to both). With start 0 (`a[63 - i] = a[i]`, `i < 64`) the strips happen to be aligned with the middle and the answer is right (`M-MIR1`, `M-MIR5` ok): the bug is alignment-dependent. Confirmed: skip `tryVectorize` fixes.

### W8, W9. tryVectorize AoS: a store one pixel ahead of its load (map.js:96 `allowAos`, 221-223 stride gate; lift.js:403-415 stores with memarg on the AoS path only; a non-AoS store with memarg is refused at lift.js:419)
```js
const a = new Float64Array(64)
export let f = () => {
  for (let i = 0; i < 64; i++) a[i] = ((i * 7) % 13) - 5.75
  for (let i = 0; i < 31; i++) a[2 * i + 2] = a[2 * i] + 1      // W9: a[4 * i + 4] = a[4 * i] + 1, i < 15
  let h = 0
  for (let i = 0; i < 64; i++) h = (h * 31 + a[i]) % 1000003
  return h
}
```
W8: node -109982, jz -921852. W9 (stride 4): node -902396, jz -265753. Store at pixel i+1's element, load at pixel i: a cross-iteration RAW the strip (pixels i, i+1 loaded first) breaks. Same program at memarg offset 3 (`a[2*i+3] = a[2*i] + 1`, `M-AOS4`) and the one-pixel-ahead load (`a[2*i] = a[2*i+2] + 1`, `M-AOS6`) are correct. Stride 3 is not lifted (`M-AOS2`, scalar). Confirmed (W8, minimal and module form): skip `tryVectorize` fixes.

## What the nine have in common (V)

- W7, W8, W9: no recognizer-level distance test in `tryVectorize` (map.js 71-447 never compares two sites' indices), and gateStrips by design skips same-base pairs (alias.js:285). The only same-base guard is accidental: `lift.js:419` refuses a store with a memarg on the plain path. The AoS path (lift.js:397-415) and the mirror path (map.js:178, lift.js:421+) have none. aliasGuards (alias.js:73) exists but only tryGeneralMap and tryGeneralStencil call it.
- W1: a recognizer that lifts per-iteration locals without `laneAccess(..., outsideReads)` (the others consult it; tryReduceBitExact, tryDivergentEscapeVectorize, tryChannelReduce, outer-strip and conv-column, per-pixel-color, tryPrefilter never do).
- W2, W3, W4, W5, W6: shape matchers that accept more than they lift (a repeated step, a store reached only through `liftStmt`, a shift count at the lane width, a store inside an arm, a c-var the epilogue writes).

## Dependence strength by recognizer (V, from map.md section 2 and Part B)

Weaker than another recognizer on the same situation: tryVectorize, tryRampMap, tryToneMap, tryChannelReduce 4px, tryOuterStripRest family, tryDivergentEscapeVectorize prove nothing between two sites of the same base beyond "same address form, same `i`" (and gateStrips skips same base); tryStencil refuses any other element of a written base (stencil.js:252-258); tryGeneralMap/tryGeneralStencil run `aliasGuards` (constant distance, run-time test). Same loop, different strength: `a[i + 1] = a[i]` is (i) declined by tryVectorize through lift.js:419, (ii) taken by tryMemCopyFill behind an overlap test (memcpy.js:185-192), (iii) would be declined by tryGeneralMap through aliasGuards (alias.js:83: constant distance 1 is neither 0 nor >= lanes). `a[2*i+2] = a[2*i]` (W8) is lifted wrongly by tryVectorize's AoS path, which has no distance test at all (I: tryGeneralMap's affine form needs IV coefficient 1, so it would not take that shape either; not run).

## Leads tried and not reproduced (answer correct, or the shape never reached the recognizer)

Status words: ok = answer equals Node, the recognizer saw the loop; scalar = no SIMD in the function, the shape did not reach the recognizer (compile with the census rows: `lead-why.mjs`); declined = a check fired.

| lead | program | result |
|---|---|---|
| A2 `a[i+1] = a[i]` (map.js no test) | `leads-mod` M-A2 | ok: tryMemCopyFill took it behind its overlap guard; tryVectorize would have declined at lift.js:419 |
| A3 prefix sum `a[i] = a[i-1] + a[i]` | M-A3 | scalar: `i - 1` is not a lane address, no recognizer |
| A7, A8 int32/u8 `a[i+1] = a[i] + 1` | M-A7, M-A8 | ok: why-not `i32.store with memarg` / `i32.store8 with memarg` (lift.js:419) |
| A9 `a[i] = a[i+1] * 2` (WAR) | M-A9 | ok, lifted by tryVectorize (legal) |
| A4, A5 two parameters one array | `leads.mjs` A4, A5 | ok at the three levels (SIMD): the run-time `P != Q` / `apart` test (alias.js:289-292, 322-325) |
| A6 `a[i] = a[0] * 3 + i*0.5` (hoisted splat vs store) | M-A6 | scalar |
| MC1 `a[i+3] = a[i]` | M-MC1 | ok: memcpy overlap guard |
| GM2 `a[i] = a[2*i] + 1`, ST1 in-place stencil | M-GM2, M-ST1 | scalar, ok |
| ST3 stencil on distinct arrays; ST2 same array through two parameters | M-ST3, `leads.mjs` ST2 | ok (SIMD), run-time test |
| MIR1, MIR2, MIR3, MIR5 mirror stores | M-MIR* | ok (strips aligned with the overlap, I); MIR4 is W7 |
| AOS2 (stride 3), AOS3 (channel copy), AOS4, AOS6 | M-AOS* | scalar / ok |
| OS1 store before inner loop, OS3 triangular bound, OS4 same-array | M-OS1, M-OS3, M-OS4 | ok: `tryReduce` takes the inner loop first, the outer recognizers then see a wrapper and bail (post-order, index.js:211-216) |
| OS2 `s -= b[i]` (outer-strip treats it as `+=`, outer-strip.js:153-157) | M-OS2 | ok: the lift is made and then rejected by gateStrips (row `gated=tryOuterStripRest`); the answer is right because the lift is dropped, not because the lift is right: the `-=` mapping is not exercised |
| DE1 f64 pixel IV | `leads.mjs` DE1 | scalar / pair-iterations took it (`pair=true`), ok |
| DE3 carried local read after loop | M-DE3 | ok at all levels (divergent-escape took the loop, row `taker=tryDivergentEscapeVectorize`); why the answer is right here was not traced |
| CH1 in-place blur, CH2 destination stride | `leads.mjs` CH1, CH2 | scalar: the blur-channel matcher was not reached by these emissions (I); not shown either way |
| PPC1 lane local assigned twice | M-PPC1 | ok |
| PF1 prefilter on `lt_u` | M-PF1 | ok: tryRampMap took the loop, prefilter not reached |
| CR9 exit bound reads the cursor | M-CR9, M-CR9b | scalar: no scaffold |
| D2 slp store pair aliased | M-D2 | scalar |
| L-D1..L-D7 (dot-slp -0, slpReadsSlot with different base/index, dot operands), L-T2..L-T6, L-R2, L-R3 ii, L-R4, OS5-6 (conv-column u8*u8 overflow, stride), CH3-CH7, L1 L3 L4 L5 L7 L11 L12 of group 3 | not tested | need mat4-shaped / unrolled / hand-emitted IR shapes; I did not find the source that reaches them. They remain leads in `map-parts/*.md` |

## Not tested, stated plainly

The reproduced set is what I found by running my own dependence-shaped programs and the agents' strongest leads; about thirty agent leads (last row of the table) were not exercised. A lead marked ok/scalar above proves only that this program did not reach the recognizer or reached a check; it does not prove the recognizer sound.
