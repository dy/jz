# Feature-reach census — which "complexity engines" does the real corpus actually exercise?

Measurement only. Zero compiler-source changes (the one temporary trace patch used to
identify vectorizer recognizers lived in a disposable worktree, never committed — see
§Method/vectorizer below). No removal recommendations — data only.

Scope: every program under `bench/` and `examples/` (excluding `test/**`, the self-host
kernel build `bench/jz/jz.js` = `scripts/self.js` subject, and `test262`), plus the three
named real-input compile subjects (jessie, watr-graph, jzify-entry). 130 programs total,
all compiled successfully at `-O3` (`optimize:'speed'`, matching `bench/bench.mjs`'s own
`compileJzHost`/`examples/build.mjs`'s `OPT` — the real-usage optimize tier, and a superset
of the default level-2 pass set: nothing gated ON at level 2 is gated OFF at level 3).

## Corpus (130 programs)

| group | count | source |
|---|---|---|
| `bench/*/*.js` | 59 | every `bench/<name>/<name>.js` (dir-name-matches-file pattern), **excluding** `bench/jz/jz.js` (self-host kernel subject) |
| `examples/*/*.js` | 68 | every `examples/<name>/<name>.js` demo entry |
| `examples/raymarcher/raymarcher.simd.js` | 1 | explicit hand-SIMD variant, distinct entry from `raymarcher.js` |
| `examples/jukebox` (beat 0) | 1 | `floatbeats.js` exports `moduleSrc(body)`, not a directly-compilable file — generated one concrete beat source (`FLOATBEATS[0]`) and compiled that |
| `.work/jzify-entry.mjs` | 1 | jzify-entry real-input subject (imports `jzify/index.js`, 71-module graph) |

Two bench entries double as the task's named real-input subjects and are tagged inline in
the matrix rather than compiled twice: `bench/jessie/jessie.js` (jessie parser, resolves
`node_modules/subscript/feature/jessie.js` — a 2.5 MB WAT / 30-module graph) and
`bench/watr/watr.js` (watr-graph, resolves `node_modules/watr/src/compile.js` — an 11.5 MB
WAT / 6-module graph). `jzify-entry` has no bench counterpart so it's its own `real-input`
row (24 MB WAT, 71 modules). All three use `resolveModuleGraph` exactly as
`.work/research.md`'s own kernel-memory-curve entry names them (`§CompileSession`-adjacent
record, 2026-08-12): "jessie = `bench/jessie/jessie.js`, watr = `bench/watr/watr.js`,
jzify-entry = `.work/jzify-entry.mjs`" — `bench/jz/jz.js` (jz×jz self-host) is the fourth
point in that same record and is the excluded self-host kernel subject here.

Every corpus file compiled cleanly (130/130 `-O3 --resolve` builds succeeded, 0 failures).

## Method

**Build**: worktree at `/private/tmp/…/scratchpad/reach-census`, `git worktree add` off
main tip `7b07a810`, `node_modules` symlink-farmed to the main checkout's packages (same
pattern as the repo's other live worktrees) — `node_modules/watr` hash-verified
byte-identical before and after (37 files, `shasum` diff clean).

**Compile**: `node cli.js <entry> --wat -O3 --resolve -o <out>.wat` per program (real CLI,
not a hand-rolled `compile()` call — module-graph resolution, jzify-default-on, and the
optimize-preset resolution all go through the same path a user invocation does).

**Engine reach (rows 1-8, 10)** — grepped directly off the emitted WAT text for each
engine's runtime intrinsic calls or NaN-box sentinel constants (the layout's own
`layout.js`/`src/ir.js` name these; values below are copied from a live `node -e` read of
those modules on this tree, not hand-computed):

| engine | detection method |
|---|---|
| NaN-boxed universal carrier | `nan:0x7FF8` (any NaN-box sentinel: null/undef/bool/atom tags) OR `f64.reinterpret_i64`/`i64.reinterpret_f64` (the box/unbox roundtrip every heap-typed read pays) |
| HASH / dynamic-property fallback | `$__hash_new`, `$__dyn_get`, `$__dyn_set`, `$__hash_get`, `$__hash_set` calls |
| External-method / unknown-receiver dispatch | `$__ext_call` calls (the host round-trip `module/…`'s `emit.js` line ~4067 warns `deopt-method` before emitting) |
| Closure environments (heap) | **both** `call_indirect` present **and** a `$__env` param/local present — `call_indirect` alone is ambiguous (devirtualized switch/jump-table dispatch can also lower through it); requiring `$__env` too confirms the heap-closure-env ABI specifically, not just an indirect call |
| Presence/nullability machinery | `i64.const 0x7FF8000100000000` (`NULL_NAN`) / `0x7FF8000200000000` (`UNDEF_NAN`) as an **i64.const operand** (the `coerceNullishToNum`/`censusMaybeUndefined` runtime check shape, `src/ir.js:1254`) — distinct from the far more common `f64.const nan:0x7FF8…` **literal** form, which just means "this expression's static value is null/undefined" and says nothing about runtime coercion machinery firing. Reported both ways (see §5 below) |
| BigInt (3 paths: raw i64 / boxed / runtime-discriminated) | **source-level**, not WAT-level: grepped every corpus `.js`/`.mjs` file (and the three real-input source graphs — subscript's jessie parser, `node_modules/watr/src`, `jzify/*.js`) for `\d+n\b` / `BigInt(` literal syntax. Zero hits anywhere. WAT-level i64-arithmetic grepping was tried first and rejected — `i64.add`/`i64.mul` etc. appear in **every** program for pointer arithmetic, string byte-offsets, hashing, none of it BigInt — a useless fingerprint, noted honestly rather than reported as a false 130/130 |
| Map/Set | `$__map_*` / `$__set_*` calls (`__map_new`, `__map_get`, `__map_set`, `__map_has`, `__map_delete`, `__set_add`, `__set_has`, `__set_delete`, …, `module/collection.js`) |
| Regex, async, generators | **source-level**: grepped every corpus file for regex literals (`/…/`, `RegExp(`, `.test(`, `.matchAll(`), `async function`/`async (`, `function*`/`yield`. Zero real hits — the few substring matches that appeared (`jzdemo.js`'s `async`, jessie/jzify's `"Unterminated regex"` / `"lowerAsync"`/`"function*"` **string literals**) are the demo harness (not itself a jz compile input — see below) and jzify's/jessie's own **string DATA** (error messages, its own async/generator-**lowering** algorithm's internal names) baked into the compiled data segment, not actual regex/async/generator **syntax** reaching jz's front end. Confirmed by inspecting the match context directly in the emitted WAT/data segment |
| Carrier-box (BOOL∪NUMBER ambiguous merges) / boxed-Boolean | `i64.const 0x7FF8000500000000` (`TRUE_NAN`) / `0x7FF8000400000000` (`FALSE_NAN`) — `boolBoxIR`'s sentinels (`src/ir.js:666-667`), called specifically at proven-ambiguous BOOL/NUMBER merge points (ternary arms, carrier joins — `src/compile/emit.js` boolBoxIR call sites) |

`examples/lib/jzdemo.js` is the **browser** demo harness (imported natively via
`<script type=module>` in each `index.html`, instantiates the compiled `.wasm`) — it is
never itself compiled by jz and is correctly excluded from the corpus.

**Vectorizer recognizers (row 9)** — no existing trace/report flag covers *which*
recognizer matched (the shipped `--why-not-simd` only reports non-matches, with a reason
string, never which pass consumed a match). Checked first per the task's instruction
before inventing anything: `cli.js --why-not-simd`, `JZ_DEBUG_INVARIANTS` (shadow-asserts
an unrelated BodyModel proof), no per-recognizer success trace exists anywhere in the tree.
Added one, **in the disposable worktree only, never committed, discarded with
`git worktree remove --force` at the end of this session**: a ~20-line diagnostic patch to
`src/optimize/vectorize.js`'s `vectorizeLaneLocal` — the first-match `??` chain
(`tryDivergentEscapeVectorize ?? tryMemCopyFill ?? …`) became a named loop that
`console.error`s `TRACE_SIMD\t<recognizerName>\t<fnName>` under `JZ_TRACE_SIMD=1`, and the
three pre-pass calls (`hoistReductionInvariantsIn`, `vectorizeStraightLineF64DotPairsIn`,
`slpStorePairsIn`) got the same treatment via a before/after `newLocalDeclsAll.length`
check. Purely additive (no control-flow change — same functions, same call order, same
arguments), verified with `node -c` and cross-checked against `--why-not-simd`'s own
existing behavior before trusting it. The instrumented file never left the worktree; `main`
and the real checkout were never touched.

## §9 — Vectorizer recognizers: every entry in `src/optimize/vectorize.js`'s first-match chain

Enumerated directly from `vectorizeLaneLocal` (`src/optimize/vectorize.js:7173-7188` for the
block-loop chain, `:7103-7107` for the three straight-line pre-pass lifts). Order is
load-bearing (first match wins) — listed in dispatch order:

| # | recognizer | shape it lifts | reach (N/130) | programs |
|---|---|---|---|---|
| 1 | `tryDivergentEscapeVectorize` | per-lane divergent escape-time loop (mandelbrot/julia-style: each lane exits independently, masked lockstep) | 5 | `bench/mandelbrot`, `examples/burningship`, `examples/julia`, `examples/mandelbrot`, `examples/newton` |
| 2 | `tryMemCopyFill` | memcpy/fill-shaped loop | 28 | `bench/{base64,biquad,delayline,radixsort,sdf,sieve,slices,trace,vm}`, `examples/{attractors,bifurcation,buddhabrot,dla,fern,lbm,lsystem,magnet,marble,pathtracer,pendulum,percolation,plume,rule30,sand,spectra,watercolor,waves,wireworld}` |
| 3 | `tryVectorize` | main straight-line elementwise loop (incl. AoS→SoA de-interleave) | 54 | half the corpus — see full list in `/tmp/jz-census-wat/recognizer-hits.json` (this session's scratch data; not committed) — includes `bench/{bezfit,bitwise,colorconv,colorlch,colorlog,colorpq,dict,fft,fftplan,hashjoin,nbody,particle,provenance,qoi,radixsort,sort,spmv}` and 37 `examples/*`, plus `realinput/jzify_entry` |
| 4 | `tryReduceVectorize` | single/multi-accumulator reduction | 4 | `bench/dotprod`, `bench/matmul`, `bench/poly`, `examples/buddhabrot` |
| 5 | `tryMapReduceVectorize` | fused map+reduce loop | 2 | `bench/nbody`, `examples/metaballs` |
| 6 | `tryStencil` | neighbour-load stencil (`a[i±δ]`) | 8 | `bench/heat`, `bench/sdf`, `examples/{diffusion,ocean,schrodinger,slime,watercolor,waves}` |
| 7 | `tryRampMap` | byte-map ramp + widening loads | 6 | `bench/alpha`, `bench/noise`, `examples/{boids,epicycles,nbody,wireworld}` |
| 8 | `tryBlurMultiPixel` | multi-pixel box-filter blur | **1** | `bench/blur` — **single-specimen** |
| 9 | `tryChannelReduce` | RGBA channel-reduction accumulation | **1** | `bench/blur` — **single-specimen** |
| 10 | `tryByteScan` | memchr-shaped byte scan (16-wide `i8x16` scan) | **0** | none — confirmed a real zero, not an instrumentation gap: a synthetic repro (`findByte` over a `Uint8Array`, exact shape from the docstring) fired the trace correctly |
| 11 | `tryPerPixelColor` | per-pixel outer color computation | 3 | `examples/{chladni,domain-color,plasma}` |
| 12 | `tryOuterStrip` | outer-loop strip-mine over inner reduction (f64x2) | **1** | `examples/interference` — **single-specimen** |
| 13 | `tryIteratedReduce` | outer-family iterated reduction | **1** | `examples/lyapunov` — **single-specimen** |
| 14 | `tryConvColumn` | convolution column (NN-inference conv2d shape) | **1** | `bench/conv2d` — **single-specimen** |
| 15 | `tryToneMap` | tone-map reduction | 4 | `examples/{attractors,boids,fern,nbody}` |
| 16 | `tryButterfly` | FFT-like butterfly | 2 | `bench/fft`, `bench/provenance` |
| 17 | `hoistReductionInvariantsIn` (pre-pass, `relaxedFma`-gated) | hoists loop-invariant partial products out of unrolled dot reductions (mat4 prologue trick) | **1** | `bench/mat4` — **single-specimen** |
| 18 | `vectorizeStraightLineF64DotPairsIn` (pre-pass) | straight-line unrolled f64 dot-pair packing (`DOT_UNROLL=4`) | **0** | none in the corpus. Two synthetic repro attempts (literal-arg `dot4`, and array-indexed `dot4` inside a runtime loop matching `DOT_UNROLL`) both failed to trigger it too — `tryByteScan`'s synthetic control confirms the trace mechanism itself works, so this is very likely a real zero, but the exact triggering precondition (beyond "4-term unrolled straight-line dot") wasn't independently pinned down. Honest `unknown(precondition)` rather than a confident zero |
| 19 | `slpStorePairsIn` (pre-pass, SLP store-pair packing) | superword-level adjacent-store packing | 3 | `examples/lenia`, `examples/penrose`, `realinput/jzify_entry` |

**Single-specimen recognizers (hit by exactly one corpus program):** `tryBlurMultiPixel`
(`bench/blur`), `tryChannelReduce` (`bench/blur` — same program, both fire on the h/v blur
passes), `tryOuterStrip` (`examples/interference`), `tryIteratedReduce`
(`examples/lyapunov`), `tryConvColumn` (`bench/conv2d`), `hoistReductionInvariantsIn`
(`bench/mat4`). Six of nineteen recognizers have exactly one specimen backing them in this
130-program corpus; two (`tryByteScan`, `vectorizeStraightLineF64DotPairsIn`) have zero.

## §1-8, §10 — Engine reach matrix (all 130 programs)

`Y` = fingerprint present, `.` = absent. "presence(any)" = the literal-sentinel form
(ubiquitous, see caveat below); "presence(precise)" = the `i64.eq`-gated runtime coercion
form (the actual machinery).

| program | group | NaN-box | hash/dyn | ext-dispatch | closure-env | presence(any) | presence(precise) | Map/Set | boxed-bool |
|---|---|---|---|---|---|---|---|---|---|
| bench__alpha | bench | Y | . | . | . | Y | Y | . | Y |
| bench__aos | bench | Y | . | . | . | Y | Y | . | Y |
| bench__base64 | bench | Y | . | . | . | Y | Y | . | . |
| bench__bezfit | bench | Y | . | . | . | Y | Y | . | . |
| bench__biquad | bench | Y | . | . | . | Y | . | . | . |
| bench__bitwise | bench | Y | . | . | . | Y | Y | . | Y |
| bench__blur | bench | Y | . | . | . | Y | Y | . | Y |
| bench__bytebeat | bench | Y | . | . | . | Y | Y | . | Y |
| bench__callback | bench | Y | . | . | . | Y | . | . | . |
| bench__colorconv | bench | Y | . | . | . | Y | . | . | . |
| bench__colorlch | bench | Y | . | . | . | Y | . | . | . |
| bench__colorlog | bench | Y | . | . | . | Y | . | . | . |
| bench__colorpq | bench | Y | . | . | . | Y | . | . | . |
| bench__conv2d | bench | Y | . | . | . | Y | . | . | . |
| bench__crc32 | bench | Y | . | . | . | Y | . | . | . |
| bench__delayline | bench | Y | . | . | . | Y | . | . | . |
| bench__deltae | bench | Y | . | . | . | Y | . | . | . |
| bench__dict | bench | Y | . | . | . | Y | . | . | . |
| bench__dispatch | bench | Y | . | . | Y | Y | . | . | . |
| bench__dotprod | bench | Y | . | . | . | Y | . | . | . |
| bench__fft | bench | Y | . | . | . | Y | . | . | . |
| bench__fftplan | bench | Y | Y | . | . | Y | Y | Y | Y |
| bench__glyfparse | bench | Y | . | . | . | Y | Y | . | . |
| bench__hash | bench | Y | . | . | . | Y | . | . | . |
| bench__hashjoin | bench | Y | . | . | . | Y | . | . | . |
| bench__heat | bench | Y | . | . | . | Y | . | . | . |
| bench__immutable | bench | Y | . | . | . | Y | . | . | . |
| bench__jessie | bench | Y | Y | . | Y | Y | Y | Y | Y |
| bench__json | bench | Y | . | . | . | Y | . | . | Y |
| bench__levenshtein | bench | Y | . | . | . | Y | . | . | . |
| bench__lorenz | bench | Y | . | . | . | Y | . | . | . |
| bench__lz | bench | Y | . | . | . | Y | Y | . | . |
| bench__mandelbrot | bench | Y | . | . | . | Y | Y | . | Y |
| bench__mat4 | bench | Y | . | . | . | Y | . | . | . |
| bench__matmul | bench | Y | . | . | . | Y | . | . | . |
| bench__nbody | bench | Y | . | . | . | Y | Y | . | Y |
| bench__noise | bench | Y | . | . | . | Y | . | . | . |
| bench__nqueens | bench | Y | . | . | . | Y | . | . | . |
| bench__particle | bench | Y | . | . | . | Y | Y | . | Y |
| bench__poly | bench | Y | . | . | . | Y | . | . | . |
| bench__provenance | bench | Y | Y | . | . | Y | Y | Y | Y |
| bench__qoi | bench | Y | . | . | . | Y | . | . | . |
| bench__radixsort | bench | Y | . | . | . | Y | Y | . | Y |
| bench__raytrace | bench | Y | . | . | . | Y | . | . | . |
| bench__resample | bench | Y | . | . | . | Y | . | . | . |
| bench__sdf | bench | Y | . | . | . | Y | . | . | . |
| bench__shapes | bench | Y | . | . | . | Y | . | . | . |
| bench__sieve | bench | Y | . | . | . | Y | Y | . | Y |
| bench__slices | bench | Y | . | . | . | Y | . | . | . |
| bench__sort | bench | Y | . | . | . | Y | . | . | . |
| bench__spmv | bench | Y | . | . | . | Y | . | . | . |
| bench__strbuild | bench | Y | . | . | . | Y | . | . | . |
| bench__synth | bench | Y | . | . | . | Y | . | . | . |
| bench__tokenizer | bench | Y | . | . | . | Y | Y | . | Y |
| bench__trace | bench | Y | . | . | . | Y | . | . | . |
| bench__vm | bench | Y | . | . | . | Y | . | . | . |
| bench__watr | bench | Y | Y | Y | Y | Y | Y | Y | Y |
| bench__wav | bench | Y | . | . | . | Y | Y | . | . |
| bench__wordcount | bench | Y | . | . | . | Y | Y | . | . |
| examples__apollonian | examples | Y | . | . | . | Y | Y | . | Y |
| examples__attractors | examples | Y | . | . | . | Y | Y | . | Y |
| examples__bifurcation | examples | Y | . | . | . | Y | Y | . | Y |
| examples__blackhole | examples | Y | . | . | . | Y | Y | . | Y |
| examples__boids | examples | Y | . | . | . | Y | Y | . | Y |
| examples__buddhabrot | examples | Y | . | . | . | Y | Y | . | Y |
| examples__burningship | examples | Y | . | . | . | Y | Y | . | Y |
| examples__bz | examples | Y | . | . | . | Y | Y | . | Y |
| examples__chladni | examples | Y | . | . | . | Y | Y | . | Y |
| examples__cloth | examples | Y | . | . | . | Y | Y | . | Y |
| examples__cradle | examples | Y | . | . | . | Y | Y | . | Y |
| examples__diffusion | examples | Y | . | . | . | Y | Y | . | Y |
| examples__dithering | examples | Y | . | . | . | Y | Y | . | Y |
| examples__dla | examples | Y | . | . | . | Y | Y | . | Y |
| examples__domain-color | examples | Y | . | . | . | Y | Y | . | Y |
| examples__dwa | examples | Y | . | . | . | Y | Y | . | Y |
| examples__epicycles | examples | Y | . | . | . | Y | Y | . | Y |
| examples__erosion | examples | Y | . | . | . | Y | Y | . | Y |
| examples__fern | examples | Y | . | . | . | Y | Y | . | Y |
| examples__fireflies | examples | Y | . | . | . | Y | Y | . | Y |
| examples__game-of-life | examples | Y | . | . | Y | Y | Y | . | Y |
| examples__gauss-primes | examples | Y | . | . | . | Y | Y | . | Y |
| examples__harmonograph | examples | Y | . | . | . | Y | Y | . | Y |
| examples__hydrogen | examples | Y | . | . | . | Y | Y | . | Y |
| examples__hyperbolic | examples | Y | . | . | . | Y | Y | . | Y |
| examples__interference | examples | Y | . | . | . | Y | Y | . | Y |
| examples__ising | examples | Y | . | . | . | Y | Y | . | Y |
| examples__jukebox_beat0 | examples | Y | . | . | . | Y | Y | . | Y |
| examples__julia | examples | Y | . | . | . | Y | Y | . | Y |
| examples__lbm | examples | Y | . | . | . | Y | Y | . | Y |
| examples__lenia | examples | Y | . | . | . | Y | Y | . | Y |
| examples__lorenz | examples | Y | . | . | . | Y | Y | . | Y |
| examples__lsystem | examples | Y | . | . | . | Y | Y | . | Y |
| examples__lyapunov | examples | Y | . | . | . | Y | Y | . | Y |
| examples__magnet | examples | Y | . | . | . | Y | Y | . | Y |
| examples__mandelbrot | examples | Y | . | . | . | Y | Y | . | Y |
| examples__marble | examples | Y | . | . | . | Y | Y | . | Y |
| examples__maze | examples | Y | . | . | . | Y | Y | . | Y |
| examples__metaballs | examples | Y | . | . | . | Y | Y | . | Y |
| examples__nbody | examples | Y | . | . | . | Y | Y | . | Y |
| examples__newton | examples | Y | . | . | . | Y | Y | . | Y |
| examples__ocean | examples | Y | . | . | . | Y | Y | . | Y |
| examples__pascal-sierpinski | examples | Y | . | . | . | Y | Y | . | Y |
| examples__pathtracer | examples | Y | . | . | . | Y | Y | . | Y |
| examples__pendulum | examples | Y | . | . | . | Y | Y | . | Y |
| examples__penrose | examples | Y | . | . | . | Y | Y | . | Y |
| examples__percolation | examples | Y | . | . | . | Y | Y | . | Y |
| examples__phyllotaxis | examples | Y | . | . | . | Y | Y | . | Y |
| examples__plasma | examples | Y | . | . | . | Y | Y | . | Y |
| examples__plume | examples | Y | . | . | . | Y | Y | . | Y |
| examples__raymarcher | examples | Y | . | . | . | Y | Y | . | Y |
| examples__raymarcher_simd | examples | Y | . | . | . | Y | Y | . | Y |
| examples__raytrace | examples | Y | . | . | . | Y | Y | . | Y |
| examples__rfft | examples | Y | . | . | . | Y | Y | . | Y |
| examples__rule30 | examples | Y | . | . | . | Y | Y | . | Y |
| examples__sand | examples | Y | . | . | . | Y | Y | . | Y |
| examples__sandpile | examples | Y | . | . | . | Y | Y | . | Y |
| examples__schrodinger | examples | Y | . | . | . | Y | Y | . | Y |
| examples__slime | examples | Y | . | . | . | Y | Y | . | Y |
| examples__spectra | examples | Y | . | . | . | Y | Y | . | Y |
| examples__sph | examples | Y | . | . | . | Y | Y | . | Y |
| examples__swarm | examples | Y | . | . | . | Y | Y | . | Y |
| examples__times-table | examples | Y | . | . | . | Y | Y | . | Y |
| examples__truchet | examples | Y | . | . | . | Y | Y | . | Y |
| examples__ulam | examples | Y | . | . | . | Y | Y | . | Y |
| examples__voronoi | examples | Y | . | . | . | Y | Y | . | Y |
| examples__watercolor | examples | Y | . | . | . | Y | Y | . | Y |
| examples__waves | examples | Y | . | . | . | Y | Y | . | Y |
| examples__wireworld | examples | Y | . | . | . | Y | Y | . | Y |
| examples__zzfx | examples | Y | . | . | . | Y | Y | . | Y |
| realinput__jzify_entry | real-input | Y | Y | Y | Y | Y | Y | Y | Y |

**BigInt (all 3 paths) and Regex/async/generators**: not shown as matrix columns —
established at the source level (see method table above) as **0/130 reach**, uniformly,
for every path/sub-feature. No corpus program contains BigInt literal syntax, a regex
literal, `async function`, or `function*`/`yield` anywhere. The WAT-emission
false-positives investigated and ruled out (jessie/jzify-entry's own string DATA
containing the words "regex"/"async"/"function*" as part of jzify's async/generator
**lowering algorithm's own internal names and error messages** — jzify transforms *other*
programs' async/generator syntax; it doesn't itself contain any) are documented in the
method table.

## Caveats — where the signal is honestly ambiguous

- **`presence(any)` is a poor per-program discriminator (130/130).** The literal
  `f64.const nan:0x7FF8…` / `f64.reinterpret_i64` forms fire the instant a program does
  *anything* generic — even a two-line `add(a,b){return a+b}; console.log(add(1,2))`
  program hits `nanBoxedCarrier` once (the generic `console.log`/print path must handle
  every value kind). Reported as a column anyway per the task's "every cell" instruction,
  but the honest read is "NaN-boxed carrier is foundational infrastructure, reached by
  construction the moment any generic I/O happens" rather than a per-program signal.
- **`presence(precise)` has a ~4-occurrence boilerplate floor in `examples/`.** 49/70
  examples show *exactly* 4 occurrences of the `i64.eq`-gated coercion form; 21/70 show
  more (5-89), and `bench/` (no shared demo-export shape) shows 38/59 at **zero** — the
  clean control case. The flat "4" in `examples/` is consistent with a fixed
  per-exported-function boundary coercion (the demo harness's shared `resize`/`step`
  export ABI shape), not per-program business logic; the >4 tail (`bench/{fftplan,jessie,
  provenance,watr}`, `realinput/jzify_entry`, and ~20 `examples/*` — dict/hash-shaped
  programs) is where the maybeUndefined/presence machinery is genuinely exercised by
  program logic. Both numbers are reported (see matrix) rather than collapsed to one.
- **`vectorizeStraightLineF64DotPairsIn`**: reported `unknown(precondition)` rather than a
  flat zero — see §9 row 18. Two targeted synthetic repro attempts didn't trigger it
  (unlike `tryByteScan`'s synthetic, which did, on the first try), so the negative in the
  corpus is very likely real, but this session didn't nail down the exact shape needed to
  independently confirm the mechanism can fire at all outside the trace's own dispatch
  point.
- **Map/Set**: only 5/130 (`bench/fftplan`, `bench/jessie`, `bench/provenance`,
  `bench/watr`, `realinput/jzify_entry`) — all `new Map()`, zero `new Set()` anywhere in
  the corpus (source-level grep confirms: no `new Set(` in any corpus file). The 5 WAT-hit
  programs' `$__map_*`/`$__set_*` calls are Map-only; the Set intrinsics
  (`__set_add`/`__set_has`/…) exist in `module/collection.js` but are **not reached by any
  corpus program**, source or emission.
- **Closure heap-env**: required *both* `call_indirect` and `$__env` (see method table) —
  without the `$__env` co-requirement, `call_indirect` alone over-counts (jump-table
  dispatch can lower through it without any closure). All 5 hits (`bench/dispatch`,
  `bench/jessie`, `bench/watr`, `examples/game-of-life`, `realinput/jzify_entry`) verified
  to carry both.

## Verdict

| engine | reach | reached ONLY by tests/self-host? |
|---|---|---|
| NaN-boxed universal carrier | 130/130 (foundational — see caveat) | no |
| HASH / `__dyn_get`/`__dyn_set` fallback | 5/130 (`bench/fftplan`, `bench/jessie`, `bench/provenance`, `bench/watr`, `realinput/jzify_entry`) | no |
| External-method/unknown-receiver dispatch (`__ext_call`) | 2/130 (`bench/watr`, `realinput/jzify_entry`) | no |
| Closure environments (heap, `call_indirect`+`$__env`) | 5/130 (`bench/dispatch`, `bench/jessie`, `bench/watr`, `examples/game-of-life`, `realinput/jzify_entry`) | no |
| Presence/nullability machinery (precise form) | 92/130 (49/70 `examples` at boilerplate floor only; 38/59 `bench` at true zero) | no |
| BigInt — raw i64 | 0/130 | n/a — unreached anywhere in the repo's real-input corpus |
| BigInt — boxed | 0/130 | n/a |
| BigInt — runtime-discriminated carrier | 0/130 | n/a |
| Map/Set (Map only; Set unreached) | 5/130 (same 5 as HASH row) | no |
| Regex | 0/130 | n/a — unreached anywhere in the corpus |
| Async | 0/130 | n/a |
| Generators | 0/130 | n/a |
| Carrier-box (BOOL∪NUMBER) / boxed-Boolean | 87/130 | no |
| Vectorizer — 19 recognizers total (16 chain + 3 pre-pass) | 17/19 recognizers reached by ≥1 program; 6 of those 17 are single-specimen; 2 (`tryByteScan`, `vectorizeStraightLineF64DotPairsIn`) reached by 0/130 | no |

"reached ONLY by tests/self-host: yes/no" is **no** across every engine that is reached at
all — every engine this census found live in the corpus is exercised by at least one
non-test, non-self-host program. BigInt/regex/async/generators aren't "test/self-host
only" either — they're reached by **nothing** in this corpus, test or otherwise (this
census didn't touch `test/**`, so it makes no claim about whether `test/**` alone
exercises them — only that the excluded-from-here corpus doesn't).

## Cleanup

Worktree `/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/reach-census` removed (`git worktree remove --force`) after this
census was written — the `JZ_TRACE_SIMD` instrumentation patch to `src/optimize/vectorize.js`
was never committed anywhere and no longer exists on disk. `node_modules/watr` in the main
checkout was never touched (worktree only ever read through the symlink).
