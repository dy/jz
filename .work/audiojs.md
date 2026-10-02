# audiojs on jz

What jz does with real audiojs code today, what that says about which part of audiojs to
compile, and the shapes jz has to handle before it pays off.

Current correctness follow-up (September 29): the v1 candidate runs 125 of 136
atoms unchanged; 11 manifests reject for missing factory IDs, event transport or
multichannel layouts.
Across 256 streaming blocks or four whole renders, 104 are bit-exact and 21 differ
only within rounding (lowest 165.3 dB SNR). There are no compile/run failures among
those 125. Four earlier growth readings were bounded buffer expansions; dewind,
dewow and stretch-sms still retain memory in that snapshot. A subsequent array-growth
analysis candidate removes dewow's repeated retention and is under verification.
See [the v1 ledger](v1.md) for candidate-specific evidence and open gates. Timing was
disabled: the historical speed findings below have not been superseded by a claim.

Measured 2026-09-27 on jz 0ea57ea1, the audio and @audio checkouts of that day (audio
4218b89 to f08852a, they moved while this ran), Node 25.9.0, Apple M4 Max. Host `js`,
SIMD on, at jz's default optimize level and at `speed`. compile-vst builds with
`host: 'native'` and no SIMD, so the vectorized controls below do not carry over to that
lane. Everything here reruns from [bench/_audiojs](../bench/_audiojs/README.md).

The machine ran other jobs during every run (load average 25 to 270 on 14 cores). Times
are minimums of interleaved runs; speeds are medians over the runs with their range.
Counts, wrong results and rejections do not depend on load. Re-measure on a quiet machine
before quoting a speed outside this file.

Speed is V8 time over jz time: above 1× jz is faster.

Fixes for W1–W5, W8–W10 and S7 are on branch `audiojs-fixes` (2c3dc5de..a2e6c691, six
commits, in the worktree `scratchpad/wt` of this session); the findings below say where
each landed and what it measured after. The verdict and the tables keep the numbers of
0ea57ea1. Verified on the branch: `npm test` 4936 of 4957 with four failures outside the
change (`web-smoke` wants `assets/grid-life.js`, absent at 2c3dc5de; a 5 s `fetch`
timeout that passes alone; two kernel tests whose 20-minute private build was killed at
load 65–73, where a fresh self-compile build takes 76 minutes on the branch and on the
base alike); `npm run test:self` 79 of 79. The self-compiled compiler is 20,221,812 B
against the base's 20,176,180 B.

The same atom sweep on the branch (`atoms.mjs`, run while the test suite loaded the
machine, so the speeds are noisy; the counts are not): 119 of 136 atoms run (117 before;
`declip` times out in its JavaScript reference as before), 97 bit-exact and 19 within
rounding; 3 differ (before: 6 wrong audio, 2 trapping or
throwing): `cymbal` (W7, 46 dB below the peak), `stretch-psola` (3.8 dB) and `tune-snap`
(4.5 dB, it calls psola), the last two a further fault in the unreduced package behind
W10's entry, open. 27 atoms faster than V8 (13 before); geomean 0.54× (0.51×), streaming
0.56× (0.48×), whole-render 0.50×. The five that do not compile are L1 (`stretch-hybrid`)
and L5 (`synth-fm` ×3, `synth-noise`). `kernels.mjs` on the branch agrees with JavaScript
on every kernel as before; its speeds, taken under the same load, are not worth quoting
beside the table below.

## Verdict

**jz does not speed up audiojs today.** Of 16 measurements on 11 kernels taken from the
packages, linear resample is level with V8 (1.00×, median of five runs), comb tempo is a
little behind (0.84×), fourteen are behind (0.01–0.93×); the `speed` level moves none of
them. Of 136 atoms, 117 compile and run through the entry
`@audio/compile-vst` generates, at a geomean of 0.51× of V8 (0.48× at the speed level).
Thirteen are faster compiled than under V8. Six produce different audio than JavaScript,
two more trap or throw. Eight process without allocating.

**The loss is not in the loops.** The same loops written against arrays the module owns
run 1.1–4.3× faster than V8 in jz. The real code differs in how values reach the loop:
typed arrays handed in by the host, channels kept in arrays, state kept on parameter
objects, bulk copies, async factories. Each is a shape in [Slow](#slow) with its smallest
kernel and its control.

**What to compile, in order:**

1. **The DSP substrate, unchanged**: `fourier-transform` (FFT and STFT),
   `@audio/spectral-pvoc`, `@audio/biquad` with the weighting filters, the envelope
   follower, `@audio/resample-sinc`, `digital-filter`, windows. The stretch and pitch
   rows spend 77–80% of their samples in DSP kernels and the analysis rows 32–54%. Of 136
   atoms 56 import at least one of these packages: biquad 25, the FFT 17, the envelope
   follower 12, the sinc resampler 9, `digital-filter` 8.
2. **Atoms through `@audio/compile`**: the product lane (worklet, VST). Its value is no
   collector pauses, no warm-up and a native plugin, so wrong output and allocation in
   `process` rank above speed there. Thirteen atoms are faster compiled today and agree
   with JavaScript: the saturators, the tube amp, the soft clipper, the oscillator, the
   envelope.
3. **Not the engine.** Importing one file of `audio/fn` pulls in 87 modules: embedded C
   codecs, microphone backends, Node streams. The first compile stops at a parser gap in
   `parse-duration`. And 17–37% of every row but stretch and pitch is Node, the collector
   and waiting, which compilation does not touch.
4. **Codecs last, and not the WAV pair for speed.** Most compressed codecs are already C
   compiled to wasm (52% of the MP3 row runs inside one). The WAV decoder is a copy-class
   loop that V8 runs at 1.2 ns per sample alone (62 ms for the fixture) and that takes
   16% of its row inside the engine; with types proven jz runs that loop 1.5× faster than
   V8, no more. Keep the WAV pair as a compile specimen: it found one wrong result and
   three rejections. The codecs with work in them are the compressed ones written in
   JavaScript (`encode-alac`, `decode-tta`, `encode-qoa`): ALAC and TTA compile unchanged
   and agree byte for byte, behind V8 today.

Most of this is slower compiled than under V8 until the shapes below are handled, and
some of it is wrong: the order is what to aim the compiler at, not what to ship.

**The gap to ffmpeg is mostly not code generation.** jz leads V8 by 1.4–2.0× on its own
audio specimens (`fft`, `wav`, `biquad` in `bench/results.json`). At 1.5× on every kernel
the rows gain 1.2–1.4×:

| Row | audio now | kernels 1.5× faster | kernels free | best native |
|---|---|---|---|---|
| WAV decode | 967 ms | 820 ms | 520 ms | 35 ms Pedalboard, 73 ms ffmpeg |
| LUFS | 973 ms | 830 ms | 545 ms | 337 ms ffmpeg |
| Time stretch | 8.74 s | 6.4 s | 1.8 s | 5.54 s SoX, 6.98 s librosa, 640 ms ffmpeg `atempo` |
| Pitch shift | 15.2 s | 11.0 s | 2.7 s | 5.74 s SoX, 6.62 s librosa |

Stretch lands between SoX and librosa. WAV decode stays 7× behind ffmpeg with kernels
that cost nothing: see [audio side](#audio-side).

## Where audio's time goes

CPU samples per row of `audio/bench/bench.js` (600 s stereo fixture), one profile each,
taken under load: shares are good to about ±5 points. Row times and native times are
audio's own, measured 2026-07 on a quiet machine (`audio/docs/comparison.md`).

| Row | audio | best native | pure-JS kernels | C codec in wasm | page copies | engine | Node, collector, waiting |
|---|---|---|---|---|---|---|---|
| WAV decode | 967 ms | 35 ms (27×) | 46% | | 10% | 8% | 35% |
| MP3 decode | 1.57 s | 274 ms (5.7×) | 12% | 52% | 6% | 10% | 20% |
| Peak normalize | 1.89 s | 462 ms (4.1×) | 35% | | 18% | 19% | 28% |
| LUFS | 973 ms | 337 ms (2.9×) | 44% | | 9% | 15% | 32% |
| Resample | 2.00 s | 270 ms (7.4×) | 42% | | 8% | 12% | 37% |
| Time stretch | 8.74 s | 640 ms (13.7×) | 79% | | 9% | 6% | 6% |
| Pitch shift | 15.2 s | 794 ms (19×) | 82% | | 6% | 5% | 8% |
| FFT spectrum | 1.22 s | 452 ms (2.7×) | 42% | | 19% | 15% | 23% |
| MFCC | 1.29 s | 610 ms (2.1×) | 48% | | 19% | 16% | 17% |
| Beat tracking | 1.11 s | 1.16 s (1.0×) | 62% | | 3% | 9% | 26% |

Hot functions behind the kernel column. Outside stretch and pitch: `msPair` (K-weighting)
6–16%, `core` (block stats) 6–20%, `decodeRaw` (WAV) 4–14%. In stretch and pitch:
`transform`, `inverseTransform`, `emit`, `analyzeFrame` (FFT and STFT) 47–49%,
`lockAdvance`, `lockMap`, `peakMask` (phase vocoder) 21–23%. `combTempo` is 34% of beat
tracking, `i16` (WAV encode) 1–5% of the rows that write a file.

## What jz does with the real code

### Kernels

`node bench/_audiojs/kernels.mjs`. Package sources unchanged; each kernel gets an entry
that fixes what the host calls, and the same file is the JavaScript baseline. V8, jz at
its default level and jz at `speed` are timed interleaved in one process. Best time of
each over five runs; speed as the median of the runs, with the range.

| Kernel | V8 | jz | speed | range | jz at `speed` | speed | range | Agreement | wasm |
|---|---|---|---|---|---|---|---|---|---|
| K-weighting mean square, module-owned blocks | 1.08 ms | 1.16 ms | 0.93× | 0.87–0.94 | 1.16 ms | 0.93× | 0.90–0.94 | bit-exact | 43 / 50 KB |
| K-weighting, blocks passed by the host | 1.05 ms | 2.94 ms | 0.34× | 0.27–0.36 | 3.08 ms | 0.31× | 0.21–0.34 | bit-exact | 44 / 50 KB |
| Block stats `core` | 1.26 ms | 1.57 ms | 0.83× | 0.80–0.94 | 1.61 ms | 0.80× | 0.78–0.93 | bit-exact | 15 / 16 KB |
| WAV decode, 16-bit stereo, 10 s | 791 µs | 4.59 ms | 0.19× | 0.17–0.23 | 4.48 ms | 0.18× | 0.17–0.23 | bit-exact | 66 / 79 KB |
| WAV encode 16-bit | 809 µs | 6.64 ms | 0.12× | 0.10–0.14 | 5.59 ms | 0.13× | 0.04–0.14 | bit-exact | 83 / 110 KB |
| WAV encode 24-bit | 1.17 ms | 101.9 ms | 0.01× | 0.01–0.02 | 46.6 ms | 0.01× | 0.01–0.04 | bit-exact | 83 / 110 KB |
| WAV encode float | 539 µs | 17.2 ms | 0.03× | 0.02–0.05 | 18.1 ms | 0.03× | 0.02–0.05 | bit-exact | 83 / 110 KB |
| ALAC encode, 16-bit stereo, 2 s | 16.5 ms | 50.6 ms | 0.28× | 0.13–0.68 | 61.8 ms | 0.27× | 0.16–0.42 | same bytes | 55 / 67 KB |
| TTA decode, 16-bit stereo fixture | 31.8 ms | 135 ms | 0.13× | 0.12–0.30 | 132 ms | 0.19× | 0.11–0.34 | bit-exact | 46 / 55 KB |
| FFT 2048 magnitude | 738 µs | 921 µs | 0.82× | 0.70–0.92 | 893 µs | 0.83× | 0.80–0.92 | 334 dB | 32 / 36 KB |
| FFT 2048 forward + inverse | 1.59 ms | 2.66 ms | 0.60× | 0.49–0.72 | 2.71 ms | 0.59× | 0.57–0.63 | 307 dB | 32 / 36 KB |
| Phase-locked vocoder stretch, 2 s | 12.6 ms | 42.4 ms | 0.24× | 0.08–0.30 | 39.8 ms | 0.27× | 0.15–0.46 | 169 dB | 71 / 88 KB |
| Comb tempo, 10 s | 32.6 ms | 38.6 ms | 0.84× | 0.49–1.16 | 48.9 ms | 0.93× | 0.57–1.48 | same bpm | 34 / 38 KB |
| Linear resample, 1 s | 132 µs | 131 µs | 1.00× | 0.89–1.23 | 124 µs | 1.06× | 1.06–1.30 | bit-exact | 21 / 23 KB |
| Mel spectrum, 64×1024 | 645 µs | 2.98 ms | 0.19× | 0.19–0.22 | 2.75 ms | 0.20× | 0.19–0.23 | bit-exact | 59 / 71 KB |
| MFCC, 64×1024 | 705 µs | 3.65 ms | 0.18× | 0.16–0.20 | 3.90 ms | 0.19× | 0.17–0.20 | bit-exact | 59 / 71 KB |

Agreement in dB is the error level below the signal peak. The WAV pair runs from a copy
with four workarounds applied (W1, L1, L2, L3); the unchanged packages do not compile.
The WAV decode loop alone, on input made in the module, runs 1.45–1.64× (S5, second
control). Long kernels are the noisy ones: the range is what the load did to them.

### Atoms

`node bench/_audiojs/atoms.mjs`. Every atom through the entry `buildShim` writes for it:
module-owned buffers, `setup`, `start`, `process`. Two sweeps at the default level and
one at `speed`. Counts are the same in all three but for one atom that ran past the time
limit once; speeds at the default level are the geometric mean of its two sweeps per
atom.

| | Atoms |
|---|---|
| Atoms with a manifest | 136 (86 streaming, 50 whole-render) |
| No entry: unnamed export 3, events 4, ambisonic or 6-channel bus 4 | 11 |
| The JavaScript reference itself does not finish in 240 s (`declip` at the swept parameters) | 1 |
| Do not compile (L1, L5) | 5 |
| Trap or throw at run (`stretch-psola`, `stretch-sms`) | 2 |
| Run | 117 |
| Output bit-exact with JavaScript | 95 |
| Output within rounding (error below −100 dB) | 16 |
| Output differs | 6 |
| Process without allocating | 8 |
| Import host functions (`__ext_prop`, `__ext_set`, `__ext_enum`, `__ext_call`) | 76 |
| Faster than V8 in both default sweeps | 13 |
| Below half of V8 | 46 to 49 |

Speed at the default level: geomean 0.51× (0.52× and 0.50× in the two sweeps), median
0.6×, from 0.04× (`decrackle`) to 2.6× (`osc`). Streaming atoms 0.47×, whole-render
0.61×. At `speed`: geomean 0.48×; atom by atom the level changes the speed by 0.96× at
the geomean. An atom's speed differs by 1.15× between two sweeps at the median, up to 5×
for the longest kernels. Module size: median 30 KB at the default level (12 to 102 KB),
35 KB at `speed`. Compile time: median 7 to 20 s, up to 100 s, under load.

| Family | Atoms | Speed (geomean) | Slowest | Fastest |
|---|---|---|---|---|
| saturate | 5 | 1.77× | multisat 1.31× | tape 2.13× |
| amp | 2 | 1.31× | cabinet 0.82× | amp 2.09× |
| synth | 11 | 0.83× | modal 0.35× | osc 2.60× |
| dynamics | 16 | 0.76× | compand 0.22× | softclip 1.76× |
| weighting | 7 | 0.63× | riaa 0.53× | itu468 0.69× |
| denoise | 11 | 0.49× | decrackle 0.04× | omlsa 1.16× |
| eq | 4 | 0.48× | dyneq 0.28× | baxandall 0.67× |
| spatial | 7 | 0.47× | panner 0.19× | microshift 1.23× |
| stretch | 5 | 0.41× | stretchTransient 0.21× | stretchWsola 1.01× |
| reverb | 6 | 0.40× | plate 0.19× | spring 0.66× |
| filter | 13 | 0.36× | spectralTilt 0.07× | diode 1.02× |
| effect | 25 | 0.34× | sbr 0.06× | ringmod 0.84× |
| tune | 1 | 0.29× | | |
| shift | 3 | 0.27× | formantShift 0.15× | paulstretch 0.41× |

Faster compiled in both default sweeps, and in agreement with JavaScript: `osc` 2.60×,
`tape` 2.13×, `amp` 2.09×, `transistor` 1.99×, `tube` 1.77×, `waveshaper` 1.76×,
`softclip` 1.76×, `adsr` 1.62×, `multisat` 1.31×, `risset` 1.30×, `gate` 1.30×, `chirp`
1.28×, `microshift` 1.23×. They do heavy math per sample (saturation curves, oscillators,
envelopes): what jz loses around the loop is a small part of them. Whole-render atoms ran
with every number parameter halfway from its default to its maximum, since their defaults
are often the identity.

## Findings

Every finding has its smallest kernel in `bench/_audiojs/shapes.mjs`, which prints the
JavaScript value beside the jz value, or both times. All of them hold at the default
level and at `speed`.

### Wrong

The compiled program returns another value than JavaScript, or traps.
`node bench/_audiojs/shapes.mjs wrong`. The last column: whether it also happens with
`optimize: false`.

| | Shape | JavaScript | jz | Breaks | Unoptimized |
|---|---|---|---|---|---|
| W1 | A binding holds a view of a host-passed typed array and, on another path, a fresh one: `let src = b.subarray(44); if (…) src = new Uint8Array(8)`. `src.byteOffset`, and the view a constructor builds from `src.buffer, src.byteOffset` | 44 | 0 | `@audio/decode-wav` `samples()`: 16-bit, 32-bit and float PCM decode to garbage | yes |
| W2 | Optional output: `let out = output \|\| internal` over typed arrays | writes `output` | traps out of bounds; with two element kinds the writes are lost | `fourier-transform` `rfft(x, out)`; the idiom is everywhere in audiojs. `output ? output : internal` works | yes |
| W3 | `.length` of a typed array chosen by a conditional over two parameters | 4 | missing | `@audio/spatial-haas`: the loop bounded by it never runs, no delay is applied | yes |
| W4 | `o + ((t = e) >= D ? t - D : t)`: the arms read `t` from before the test assigned it | index from the new `t` | index from the old `t` | `@audio/noise-estimate` `minStats` and through it `denoise-spectral`, `denoise-wiener` | yes |
| W5 | An array stored in a property added after the object was made (`if (!st.history) st.history = []`), then grown by `push` | grows | the kernel traps; the atom returns wrong audio | `@audio/denoise-dereverb` | yes |
| W6 | Sum of squares `q += x[i] * x[i]` | left to right | two lanes, last digits differ | anything that tests energy bit-exactly | no |
| W7 | `Math` functions against V8's: `Math.sin(Math.PI)` | 1.2246467991473532e-16 | 0 | tables and coefficients differ in the last bits; `synth-drum` cymbal, a square wave from `Math.sign(Math.sin(…))`, differs on 1167 of 96000 samples | yes |
| W8 | A typed array binding reassigned to a longer array (`let buf = new Float64Array(0)`, grown on demand): its length read in a callee | 8 | 0, the first length | `stretch-sms` (the FFT is handed a frame of length 0 and throws); the idiom names 21 scratch arrays in `spectral-pvoc`, `stretch-hybrid`, `stretch-psola`, `stretch-sms` | yes, for a module-level binding |
| W9 | A parameter reassigned to a typed array on one path, tested on all: `if (data instanceof Float64Array) data = Float32Array.from(data)`, then `data instanceof Float32Array` | true for a Float32Array only | always true | the entry of the 9 `stretch-*` kernels: called with options it returns the batch result's kind where a stream writer is due | yes |
| W10 | An entry that returns a channel array, a stream writer or a Float32Array, over a core that returns a record from several sites; and, alone, a record whose field is a typed array at one return site and undefined at another | a Float32Array; undefined | a number; a Float32Array | `stretch-psola` (the atom traps) and `tune-snap`, which calls it and returns the dry signal. The entry is reduced to 49 lines in `repro/entry-return.js`, not to one shape | the entry no, the record yes |

Fixed on branch `audiojs-fixes`, each pinned by a test:

- W2: `||` and `&&` joined an unboxed typed-array pointer (an i32 parameter) with
  another value through one i32 `if`, and the single widening after the join read the
  pointer's offset as a number. The join now boxes each arm by its own kind unless both
  are one pointer kind (`src/compile/emit/shared.js` `i32JoinRep`). `test/pointer-join.js`.
- W3: a local declared from `cond ? left : right` over two unboxed pointer parameters was
  narrowed to an integer i32: `exprType` read the parameters' i32 storage as an integer
  (`src/type/expr-type.js`). The kernel also failed with a number test at `optimize: 0`;
  inlining hid it at the default level. `test/pointer-join.js`.
- W4: the conditional became a wasm `select`, which evaluates both arms before its test.
  The gate now refuses a test that writes a local or global an arm reads
  (`src/compile/emit/shared.js` `selectOK`). `test/select-order.js`.
- W1, W9: the typed tracker recorded the first constructor a binding was assigned and
  only a different constructor invalidated it, so a parameter no caller typed or a host
  view took the constructor of a later conditional assignment. A binding now keeps its
  constructor only if every definition in the body agrees, a parameter's entry value
  included (`src/compile/analyze/trackers.js` `dropDisagreeingTypedDefs`); the audiojs
  entry (options in, a stream writer out) and decode-wav's `samples()` agree with
  JavaScript. `test/typed-rebound.js`.
- W5: an object that gains a property after its creation (`let st = {}` at module scope,
  `if (!st.history) st.history = []` in a function) allocated the property's slot
  zero-filled, so before the assignment the property read as the number 0, a test for it
  compiled to a nullish test never fired, and the push went through 0 as a pointer. The
  slots a binding gains hold the undefined sentinel now (`module/object.js`, the auto-box
  preambles in `src/wat/assemble/start-fn.js` and `src/compile/emit/dispatch.js`).
  `test/late-field.js`. Still open in the same class: `st.history === undefined` folds to
  false before the assignment (the summary does not mark a merged slot the literal
  leaves unnamed as absent); a captured primitive with properties (`let n = 5; add = ()
  => n.tag = …`) fails at every level, on main too.
- W10, the record: the summary marks an uninitialized `let out` returned in `{ out }` as
  absent, and the parameter fed from that field kept a typed constructor and an unboxed
  pointer ABI, an i32 offset with no room for `undefined`; `instanceof` then folded. A
  parameter that may be undefined keeps its boxed carrier (`src/compile/narrow/param-abi.js`)
  and `instanceof` on a value that may be missing stays a runtime test
  (`src/compile/emit/instanceof.js`). `test/typed-rebound.js`.
- W10, the entry: once the record was right, the 49-line entry still returned a number
  from `optimize` 1 up. A specialization variant (`psolaBatchCore$spec`, minted for the
  typed argument) copied its origin's result type, `i32`, without the fact that made it a
  pointer (`sig.ptrKind`), so the clone returned the record's box truncated to 0 and the
  caller read slot 0 of address 0, the string table. A variant now carries its origin's
  result ABI (`src/compile/variant.js`). The reduced entry is `test/variant-result.js`.
- W8, two faults with one face. A module binding: the declaration's literal length was
  dropped for rewritten bindings only after the plan had narrowed it into every callee's
  parameter facts; the drop now precedes narrowing (`src/compile/plan/index.js`). A
  local binding, from `optimize` 1 up: the scalarizer mirrored the array in slots beside
  the memory and kept the first length across the reassignment; a rebound binding is no
  longer scalarized or mirrored (`src/compile/plan/literals.js`). `test/typed-rebound.js`.

W1, W8, W9 and W10 are one family: a binding, a parameter or a record field that receives
a fresh typed array on one path is typed as that array on every path, so what the other
path brought in (a view, a longer array, an options object, nothing) is read as if it
were the fresh one.

W6 follows a documented rule (CONTRIBUTING: reordered float reductions from optimize 2
up); README's list of differences from JavaScript does not mention it. Plain sums and dot
products keep JavaScript's order.

W7, 20000 arguments each: share of bit-identical results and the relative error at the
largest distance.

| | identical | error | | identical | error |
|---|---|---|---|---|---|
| `sin` | 6% | 1.2e-11 | `atan` | 0% | 5.9e-10 |
| `cos` | 8% | 1.2e-11 | `atan2` | 0% | 5.9e-10 |
| `tan` | 44% | 1.1e-15 | `asin` | 0.1% | 2.6e-10 |
| `exp`, `log`, `pow`, `tanh`… | 54–99.7% | ≤ 5e-16 | `acos` | 0.5% | 1.3e-10 |
| `sqrt`, `cbrt` | 100% | 0 | | | |

`sin` and `cos` lose it near their zeros: the double nearest to kπ is reduced as if it
were kπ, so the sine comes out 0 where V8 returns the residual. `atan`, `atan2`, `asin`,
`acos` carry about 30 bits. Inaudible in a filter or a table, and the reason 16 atoms
agree within rounding instead of bit-exactly: a JavaScript-against-wasm test of anything
built on these needs a tolerance. Audible where a sign is taken from it (the cymbal).
V8's functions are portable C in plain double arithmetic, so a bit-exact match is within
reach: the same operations in the same order.

### Rejected

Valid JavaScript that does not compile. `node bench/_audiojs/shapes.mjs reject`.

| | Shape | Met in |
|---|---|---|
| L1 | Typed-array constructor as a value: `samples(raw, bits === 64 ? Float64Array : Float32Array, n)`, then `new T(…)` | `@audio/decode-wav`, `stretch-hybrid` |
| L2 | `import()` of a literal specifier inside a function | `@audio/encode-wav` loads `./meta.js` on demand |
| L3 | A binding that is Boolean or Number: `let rf64 = fixed && riff > 0xFFFFFFFF && junk` | `@audio/encode-wav` header. Smaller hand-written forms compile; the reduced encoder is `repro/bool-or-number.js` |
| L4 | Property named with a non-ASCII letter: `unit.µs` | `parse-duration`, reached from the engine |
| L5 | Rest of a destructured options parameter: `(freq, { duration = 4, ...opts } = {})` | `synth-fm` (3 atoms), `synth-noise` |
| L6 | The reported location is unrelated to the fault: decode-wav faults on line 151 and reports 181:43; the reduced L3 reports 39:5643 on a one-character line | every rejection above |

### Slow

The loop runs, agrees with JavaScript, and loses to V8.
`node bench/_audiojs/shapes.mjs slow`, 65536 samples, µs.

| | Shape | V8 | jz | jz speed | Control in jz |
|---|---|---|---|---|---|
| S1 | Typed array passed by the host, read in a loop | 71 | 185 | 0.38–0.55× | module-owned array 2.1–2.7× |
| S2 | One kernel, a second caller passing host arrays | 128 | 1149 | 0.09–0.11× | the same kernel with one caller 0.97–1.48× |
| S3 | A recursion seeded from state kept on the parameter object: `let s = params.state ??= new Float64Array(2), z = s[0]` | 164 | 435 | 0.29–0.42× | the state in a module-level array or a closure 0.97–1.02× (a serial recursion: level with V8 is its ceiling) |
| S4 | Scratch buffer memoized in an object by size: `scratch[n] ??= new Float32Array(n)` | 50 | 49 | 1.0–1.3× | memoized in a Map 2.3–3.1× |
| S5 | Interleave and quantize (WAV encode loop), channels passed by the host | 202 | 757 | 0.23–0.36× | module-owned channels 1.0–1.3×; the WAV decode loop on input made in the module 1.45–1.64× |
| S6 | The atom contract: gain through the generated entry | 105 | 556 | 0.16–0.20× | the same gain on owned arrays 2.3–2.9× |
| S7 | Bulk methods: `Y.set(X)` | 8 | 179 | 0.04× | the copy as a loop 3.9–4.3× |
| | `X.copyWithin(0, 512, N)` | 8 | 214 | 0.04× | |
| | `Y.fill(0, 100, N)` | 3 | 103 | 0.02× | |
| | `new Float32Array(X)` | 8 | 182 | 0.04–0.13× | `X.slice(0, N)` 1.3–2.8× |
| S8 | Kernel reached from closures made by an async factory | 363 | 10039 | 0.03–0.04× | the same encoder from a plain factory 0.29–0.32× |

What each one asks of the compiler, as a class:

- **S7, any typed-array bulk method.** `set`, `copyWithin`, `fill` and the copying
  constructor are element loops at 1.6–3.3 ns per element; the compiled modules hold no
  `memory.copy` for them, while `slice` has one. Same kind on both sides is a block copy,
  a fill is a block fill. 99 of 117 manifests call `set` in `process`: 72 copy input to
  output (`out[c].set(inp[c])`) before they process in place, 27 copy a result out. One
  copy per channel and block is 0.13 ms per pass in jz against 0.006 ms in V8. That is
  over half of the jz time of 6 atoms (`gain` 85%, `midside`, `widener`, `panner`,
  `spectralTilt`, `haas`) and over a quarter of 14; at V8's cost the streaming geomean of
  the first sweep would read about 0.60× instead of 0.48×. `spectralTilt`, the slowest
  streaming atom at 0.07×, does nothing else at its default slope. The FIFOs and delay
  lines inside the kernels use the same methods and are not counted in that. S6 is S7:
  with the one call replaced by a loop the contract form runs 4.0×, helper call, channel
  arrays, closure and parameter bag included.
  Fixed on branch `audiojs-fixes` (`module/typedarray.js`, `test/typed-copy.js`): a source
  of the same byte layout (the same kind, or two integer kinds of one width) is one
  `memory.copy`, in `set`, the constructor and `copyWithin`; a fill whose element is one
  byte repeated (0, -1, any byte array) is one `memory.fill`; a source of another static
  kind converts through inline loads; a receiver or source of unknown kind decides on its
  aux byte at run time, so `out[c].set(inp[c])` copies too. `set` now throws the RangeError
  of an offset outside the receiver, where it wrote past the array. After: `Y.set(X)` 0.93×,
  through channel arrays 0.94×, `copyWithin` 0.98×, `fill(0)` 0.97×, `new Float32Array(X)`
  3.2×, `set` from an Int16Array 0.84× (scalar conversion loop; V8 vectorizes it).
- **S1 and S5, any loop over a typed array whose kind is known only at run time.** The
  kind is tested on every access. Test it once ahead of the loop and run the typed loop.
  This is every codec and every host that passes its own buffers.
- **S2, any kernel with callers of different knowledge.** The kernel is compiled once for
  the join of its callers, so one untyped caller costs the typed ones 10×. With S1 done
  the join is cheap; otherwise a copy per caller kind.
- **S8, any closure made inside an async function.** Every value it passes on is dynamic,
  index arithmetic included: the compiled `i24` loop calls `__add_slow`,
  `__str_concat_fresh`, `__is_str_key` and `__dyn_set` per sample. 11 of the 13 @audio
  encoders are async factories, the 7 written in JavaScript among them, for one
  interface with the wasm ones.
- **S3 and S4, any typed array read back from an object.** State on the parameter object
  and buffers memoized by size are how audiojs kernels keep state. The array's kind is
  lost on the way back, and a value seeded from it (`z = s[0]`) carries the doubt through
  every iteration. Declaring the field in the literal, with the array or with null,
  changes nothing (0.32–0.42×); a scalar read from the same object costs nothing. A
  module-level array and a closure keep the kind (0.97–1.02×). A Map holding the array
  itself does not (0.41×); a Map holding a record with the array in a field does (S4's
  control).

Kernels behind V8 whose cause is not one shape. Pin the kernel itself:

| | Kernel | Seen in the compiled loop |
|---|---|---|
| S9 | `fourier-transform` FFT | all 16 accesses of a butterfly keep their bounds test, the length reloaded from memory. Moving the tables from the plan object to module-level bindings changes nothing (0.79× and 0.41×). jz's own `fft` and `fftplan` lead V8 1.4–1.6× |
| S10 | Mel spectrum and MFCC | calls per iteration: `__typed_idx`, `__dyn_get_t`, `__hash_get_local`, `__str_hash`, `__to_num`. Window, scratch and filterbank all come from memos (S4) |
| S11 | Block stats `core` | every use of `mn`, `mx`, `v` re-tests the missing-value sentinel; the counter runs in f64 behind an overflow guard |
| S12 | Phase-vocoder stretch | STFT driven through a per-frame callback; S9 and S7 inside |
| S13 | K-weighting on owned blocks | two nullish tests and an f64 bound per iteration; a serial recursion, so level with V8 is the ceiling |

### Boundary and memory

- **B1. Closures inside a returned object reach the host as numbers.** `{ encode, flush,
  free }` and `{ decode, flush, free }` are the contract of every @audio codec and
  stream. They cannot be driven from the host: the lab keeps the instance inside the
  module behind flat exports.
- **B2. `process` allocates in 109 of 117 atoms.** Median 4.2 KB over 48 blocks, up to
  3.9 MB. compile-vst's realtime gate requires none. Clean today: `compressor`, `ducker`,
  `expander`, `transientShaper`, `unlimit`, `gain`, `freeverb`, `osc`. Not split here
  into what the source allocates and what the compiler adds.
- **B3. Nothing is released between calls, and `memory.reset()` releases too much.** An
  export that takes or returns heap values is not rewound. `reset()` returns to the state
  after instantiation: buffers the host allocated read 0 afterwards and state a kernel
  made on its first call is gone (reading it throws). A streaming codec therefore either
  grows (encode-wav: 84–168 MB after about 200 blocks) or loses its state. It needs a
  release scoped to the call that keeps what the call was given and what it stored.
- **B4. Size.** 12–102 KB per atom, 43 KB for the K-weighting loop alone. The dynamic
  fallbacks bring their runtime: property hash, strings, number formatting, the iterator
  protocol (from `let [c, d] = design(params)._sos`), the async runtime.

## Order of work

Ranked by what each unblocks for audiojs.

1. **W1–W5, W8–W10.** Wrong audio in 6 atoms, two more that trap or throw, garbage from
   the WAV decoder, a trap in the FFT's optional output. A compiled atom that is quietly
   wrong costs more than a slow one. W1, W8, W9 and W10 look like one fault.
   All fixed on `audiojs-fixes`; every kernel of `shapes.mjs wrong` agrees with
   JavaScript there but W6 and W7.
2. **S7, bulk methods.** One class; 99 manifests and every FIFO and delay line.
   Fixed on `audiojs-fixes`.
3. **S1, S2, S5, host-passed arrays.** Every codec; the 10× cliff of S2.
4. **S8, async factories.** Every encoder written in JavaScript.
5. **S3, S4, state on objects.** The kernels' own state idiom; S10 with it.
6. **S9, S12, the FFT and STFT.** The stretch and pitch rows.
7. **B2, B3.** Allocation-free `process`, a scoped release: the VST gate and streaming.
8. **L1–L6.** Six rejections, five atoms and both WAV codecs behind them.
9. **W6, W7.** List both in README's differences, or match V8's math.

Pin each as its kernel from `shapes.mjs`, and the eleven kernels of `kernels.mjs` as they
are: they are the programs the corpus lacks. `fft`, `fftplan`, `wav` and `biquad` in
`bench/` lead V8; the packages they were modelled on do not.

## audio side

Outside jz, found on the way, and part of the distance to ffmpeg.

- **Decode pays for the stat index.** K-weighting and block stats are 30% of the WAV
  decode row, page copies 10%. A caller that only wants PCM pays for both.
- **The numeric cores in `audio/fn` cannot be compiled where they are.** `core`,
  `melSpectrum`, `mfcc` and `resample` sit in files that import the engine to register
  themselves. In a leaf package each compiles as is.
- **Stretch and pitch are compared with another algorithm.** ffmpeg's `atempo` and
  `asetrate` are cheaper methods than a phase vocoder. Against SoX and librosa the rows
  are 1.3–2.6× behind.
- **compile-vst declines 11 atoms**: unnamed exports (the three biquad filters), events,
  buses beyond stereo.

## Status, 2026-09-29, night: branch `perf-rb6`, in the v1 candidate, not on main

`perf-rb6` holds this work, the delay, math and spectral branches and the fixes since:
the gated snapshot `perf-rb6-gated-00b49c81` (212 commits over main 86a47904) and six
fixes the gate found, each its own commit (head 901ef271, worktree `wt-rb6` of session
a577ecf5). The main checkout holds the v1 work uncommitted, so the branch lands through
the coordinator's consolidated candidate 36 ([the v1 ledger](v1.md)), which holds main
8a84ee53 and 901ef271. Main merged with 901ef271 conflicts in one import line; its full
gate (matrix, self, test262, three, extended) fails only where main 8a84ee53 fails alone
or where the mutant harness misreads its child. Results, known failures and the conflict
inventory: `handover/README.md` in session a577ecf5's scratchpad.

watr: three fixes wait in the 5.11.9 candidate (3e58675, 78c363c, c00f788: a block's
type index encoded as s33), packed and tested, not published. jz passes its tests against
it; on the published 5.11.8, `typed decode: a missing receiver throws where the access
runs` fails at `size`.

### Speed

Atom sweeps, V8 time over jz time, on this machine under load (14 to 17 on 14 cores):
directions, not measurements. An atom whose block takes a few microseconds moves by 20%
between runs of 20 repetitions; at 200 to 300 it settles (midside 1.26 to 1.31, panner
1.02 to 1.08, dcblocker 0.87 to 0.94).

| sweep | atoms run | below 1 | geomean |
|---|---|---|---|
| 2026-09-28, before this work (f2bf5740 era) | 124 | 60 | 0.97 |
| 2026-09-29, `perf-rb6` on 1bda9575 | 124 | 44 | 1.20 |
| 2026-09-29, with the day's fixes, on e4f01c09 | 125 | 37 | 1.22 |
| 2026-09-29, rebased on 797ec1ec | 123 | 30 | 1.24 |
| 2026-09-29, rebased on 86a47904 (eb4424bd) | 125 | 26 | 1.29 |

Each a general rule with its test:

- **A member no object ever holds** (`opts.release ?? 300` per sample) reads undefined
  with no lookup. opto 0.73 to 1.17.
- **Object.assign writes its target's keys and reads none**, so a record it fills has
  declared slots; JSON.stringify writes plain units and integer digits straight into its
  buffer. graphic EQ 0.64 to 1.00.
- **An integer below 2^53 prints its digits without Ryū**, a short one packed into the
  pointer. `String(16000)` 51 to 10 ns.
- **A function given a named function or a string literal** runs as a copy calling it
  by name or reading the literal; a key a loop reads of an object the function made is
  read once. sfx 0.41 to 0.85.
- **A loop over a name of several kinds** runs as a copy per typed array constructor its
  values name, up to three (a Float32Array one caller passes, a Float64Array another),
  followed through a closure's argument to its factory's callers and through a call of
  one of several functions (`colors[params.color](…)`); a class test proves the element
  kind of a number array of either kind. plate 0.75 to 1.20, fdn 0.81 to 1.83, dewow
  0.37 to 0.86, noise 0.79 to 1.09.
- **The summary looks again after the inliner spliced**, so the loop passes see a
  factory's callback copied into the function that called the factory.
- **A kernel splices into a callback at a call in the callback's own loop** (a filter
  per channel, a heap push per bin); a call outside its loops keeps the function, where
  a spliced loop ran at half speed. dcblocker's module 17.6 KB to 9.0 KB.
- **A ring counter** `j = (j + 1) % K` is an int32 bounded by K; a slot stepped by `++`
  stays integral in the census.
- **Fields and constant elements a loop keeps** live in locals for the loop, unless a
  typed array of the program may view the element's buffer.
- **An integer remainder by a runtime divisor** divides by the quotient's truncation
  where the dividend is below 2^53. stutter 0.82 to 0.91.
- **A member tested against null** (`params.x1 != null ? params.x1 : 0`) reads as
  present in the arm. dcblocker 0.36 to 0.94.
- **A counter plus a loop constant against a length** (`i + k < n`) is the counter
  against their difference, and a sum over `a[i] * b[i + 3]` runs in lanes.
- **A counter bounded by a float of unknown integrality** gets an int32 loop copy.
  stretch-psola 0.76 to 1.67.
- **A Number key hashes inline** where a Set or Map is probed: a Set.has loop over
  small integers 0.56 to 0.69 of V8.
- **A namespace holds its module's exports alone**: a key read off it named the
  module's internal functions too, which made each a value (the noise module drops
  3.9 KB).
- **A helper whose expression reads its lone parameter first** splices with a call for
  its argument (`lin2db(env(x))`); `pow_b` answers 1 for a zero exponent first.
- **The three agent branches**, merged: delay (for-of presence, inline remainder, field
  CSE, loop unswitching; schroeder 0.49 to 0.88, tapestop 0.44 to 2.3), math (kernel
  constants from memory, folded constant-base logs, reciprocal negative powers, small
  trig arguments without reduction; leveler 0.66 to 1.13), spectral (summary walk ends
  at a leaving statement, typeof-guarded Number copies, fixed-length list counters,
  present-storage loop copies).

### Correctness found on the way

- A Float64Array element held in a local for a loop went stale where a typed array of
  another kind wrote its buffer.
- A literal Object.assign writes shared one static instance across evaluations (main
  too).
- The slot integer census missed stores in closures (main too).
- A loop copy wrote back after the loop only: `continue out` left past the write-back.
- A Number copy of a loop doing BigInt arithmetic read the BigInt's bits wrong in its
  dead arm. Written by hand, `let m = n; n = m` in a `typeof n === 'bigint'` arm reads
  them wrong on main too (0x12C & 0x7F answered 64).
- An export whose loop got an int32 copy failed to compile: the copy's `typeof` guard
  counted as the program testing a host BigInt.
- A closure returned by a module with no heap read as NaN through main's fast crossing.
- A namespace read by key answered the module's internal functions.
- The branch's statement-separation check never ran over main's statement-list reader:
  `export let a = () => {}export let b = 2` compiled and `a = b` LF `++c` read as
  `a = b++; c` (main's parse-list test pinned that; it now pins Node's reading).
- A failing assertion with a BigInt value ended the tap run.
- watr: macro expansion ran an argument's effects after the body's own reads
  (`late(bump())` read `k` before bump set it); `sinkSets` moved a set past a call that
  throws to the function's own handler.

### Open

Timed again at 300 repetitions on `perf-rb6` 293db798 (2026-09-30, load 7 to 19): 125
atoms run, 26 below 1 in the sweep, geomean 1.28; the ones below 1 at 300 repetitions:

- **sfx 0.73 to 0.93** (the JavaScript side moves most): 293db798 splices `step`, `ramp`
  and their callers' calls into the band-limited sums (jz 0.188 to 0.177 ms). Left: the
  per-sample call into the wave dispatcher's copy, and `lookup`'s reads of `H`, a table
  `tables()` fills lazily, each testing `H` for undefined (it sits in a `?:` arm, where
  the statement splicer does not reach).
- **stretchPghi 0.95**: heapPush's `size` crosses each call as a double; the callback
  splice removes the calls but the heap keeps its double index.
- **dewow 0.88, schroeder 0.89, stutter 0.89, freeverb 0.92, rotary 0.93, modal 0.92,
  dcblocker 0.94, deplosive 0.94.** freeverb's and rotary's ring slot (`if (++c.i >=
  c.buf.length) c.i = 0`) stays a double: the loop runs in two copies, one for a present
  `st` and one for the rest, and in the second `c` comes from `st.combs` of a nullish
  `st`, which the slot census cannot name, so `++c.i` poisons every slot called `i` and
  `c.buf[c.i] = …` every slot of every record. That second copy throws at `st.combs`
  before any store; the census does not know it. stutter spends a quarter of its time in
  `$math.pow` (`(1 - decay) ** rep`, an integral `rep`): an entry skipping the special-case
  ladder for an integral exponent was slower, since the default `decay` makes the base 1,
  which the ladder answers at once.
- **spectralTilt 0.34 to 0.5**: at slope 0 a block is a copy and a return. The export's
  crossing (`interop.js` `crossing`: the BigInt test, `begin`, `try`, `end`) is 100 ns of
  a 200 ns call, the rest the call itself.
- **fm** differs from V8 (3.5 dB) with feedback on: the operator feeds its sine back, a
  chaotic map; jz's and V8's `sin` differ in the last digits (W7's accepted bound) and
  the outputs part at sample 52. With feedback 0 it is bit-exact.
- **On main, not from this work**: `summary codegen: a method called through an array
  of instances` (6088 B against a 3372 B class), `summary shapes: bounded joins keep
  BigInt fields readable` (an O2 miscompile: `pick(k).value` returns the raw bits),
  buddhabrot's f64x2.pmax lift; `grouped expressions` arity at O2, which `perf-rb6`
  passes. The v1 candidate 36 passes the first two.
