# jz benchmark suite

Cross-target workload suite for jz codegen quality. Each benchmark is a case
folder under `bench/`:

```txt
bench/<case>/<case>.js      JavaScript source used by V8, jz, etc.
bench/<case>/<case>.c       optional native C baseline
bench/<case>/<case>.rs      optional Rust baseline
bench/<case>/<case>.go      optional Go baseline
bench/<case>/<case>.zig     optional Zig baseline
bench/<case>/<case>.as.ts   optional AssemblyScript baseline
bench/<case>/<case>.npy.py  optional NumPy baseline
bench/<case>/<case>.wat     optional hand-written WAT baseline
```

Every case prints the same line:

```txt
median_us=<int> checksum=<u32> samples=<int> stages=<int> runs=<int>
```

The orchestrator runs selected cases against selected targets and flags checksum
drift as `DIFF`.

## Run

```sh
npm run bench
node bench/bench.mjs --targets=nat,rust,go,numpy,v8,jz
node bench/bench.mjs --targets=jz --cases=biquad,mat4,poly,bitwise
node bench/bench.mjs --targets=v8,deno,bun,spidermonkey,graaljs
node bench/bench.mjs --cases=biquad,fft,synth,bytebeat,blur
node bench/bench.mjs biquad
node bench/bench.mjs mat4 --targets=nat,v8,jz
```

## Cases

| id | purpose |
| --- | --- |
| [`biquad`](biquad/biquad.js) | DSP filter cascade; dense f64 typed-array loop and offset-fusion baseline |
| [`mat4`](mat4/mat4.js) | fixed-size typed-array loops; exposes loop unrolling and offset fusion gaps |
| [`poly`](poly/poly.js) | same `sum` called with `Float64Array` and `Int32Array`; exposes bimorphic typed-array dispatch |
| [`bitwise`](bitwise/bitwise.js) | long `i32` narrowing chains with `Math.imul`, shifts, and unsigned conversion |
| [`tokenizer`](tokenizer/tokenizer.js) | string-heavy scan with `charCodeAt`, branches, and integer token accumulation |
| [`callback`](callback/callback.js) | `Array.map` callback path; exposes closure/call-indirect and array allocation cost |
| [`aos`](aos/aos.js) | array-of-object rows copied into typed arrays; exposes schema-slot read cost |
| [`mandelbrot`](mandelbrot/mandelbrot.js) | 256×256 escape-time iteration; dense f64 hot loop with conditional break and i32 counter |
| [`json`](json/json.js) | runtime `JSON.parse` of one module-local source plus heterogeneous object/array walk with a stable inferred JSON shape |
| [`sort`](sort/sort.js) | in-place heapsort over a typed array; exposes call-heavy nested loops and typed-array index propagation |
| [`crc32`](crc32/crc32.js) | table-driven CRC-32 over a mutable byte buffer; exposes integer narrowing and typed-array parameter propagation |
| [`dotprod`](dotprod/dotprod.js) | multiply-accumulate reduction; jz reassociates to 4 SIMD accumulators, beating strict-fp serial native |
| [`bytebeat`](bytebeat/bytebeat.js) | classic integer "bytebeat" one-line-song synthesis to 8-bit PCM; pure i32, bit-exact everywhere |
| [`fft`](fft/fft.js) | radix-2 Cooley–Tukey FFT over a transcendental-free twiddle table; the canonical numeric/audio kernel |
| [`synth`](synth/synth.js) | minisynth audio pipeline — polynomial oscillator + ADSR + biquad per sample; loop-carried f64 |
| [`blur`](blur/blur.js) | separable box blur on an RGBA8 image; integer stencil with edge clamp, the canonical image pipeline |
| [`watr`](watr/watr.js) | watr's WAT-to-wasm compiler on a small WAT corpus; compares jz-compiled compiler code with raw V8 |
| [`jessie`](jessie/jessie.js) | the subscript/jessie JS parser over a realistic source corpus; branch-, allocation- and recursion-heavy front-end work |
| [`jz`](jz/jz.js) | the jz compiler itself (scripts/self.js pipeline) compiling three small programs at L2 — the self-host row runs jz.wasm compiling JavaScript; output bytes are checksummed so the parity gate doubles as a determinism proof |

The `watr`, `jessie`, and `jz` rows are self-referential — jz (or its deps)
compiling code. They stay runnable (`--cases=watr,jessie,jz`) and gated in
`test/bench.js`, but are hidden from the bench page and the headline geomean SVG:
they answer a different question (compiler throughput on itself) from the
cross-language kernel comparison the page is about.

Native rows for `json` are fixed-source references, not semantic equivalents
of JavaScript `JSON.parse`: C/Rust/Zig hand-parse the known schema from a
compile-time string, and Zig may constant-fold the whole parse+walk under
ReleaseFast; Go uses `encoding/json` but still unmarshals the same compile-time
string. The jz row parses a `let` source at runtime so `JSON.parse` is not
compile-time folded, while the compiler can still specialize the stable literal
shape. External unknown-shape JSON still uses the generic runtime parser.

Native-language rows are intentionally per case. NumPy rows are used only
where a vectorized array implementation is a meaningful Python convention.

Pure interpreters (CPython, QuickJS, Hermes, Javy's embedded-QuickJS) are not
benchmarked: this suite measures compiled-code quality, and an interpreter row
inflates jz's lead for free without answering a question a user actually has.
The fair field is the JIT engines (V8/Bun/Deno/SpiderMonkey/GraalJS), the other
JS→wasm compilers (AssemblyScript, Porffor, jawsm), and the native AOT
baselines (C/Rust/Zig/Go, NumPy's vectorized C).

### Parity classes

The `parity` column is `ok` when the run's checksum matches the most common
checksum across all targets, `DIFF` when it diverges in a way that suggests
a bug, and `fma` when the divergence is the documented FMA-fusion class.
The Go arm64 backend auto-fuses `a*b + c` to `FMADDD` (mandatory in ARMv8,
no compiler flag to disable it), which alters bit-level rounding on
recurrence-style loops like `biquad`. Result is still IEEE-754
correctly-rounded; cascade is the same algorithm.

## Targets

| id | what it measures |
| --- | --- |
| `nat` | clang `-O3` native C baseline, when a matching C workload exists |
| `natgcc` | gcc `-O3`, when real gcc is installed |
| `rust` | Rust `rustc -C opt-level=3 -C target-cpu=native`, when a matching `.rs` exists |
| `go` | Go native compiler, when a matching `.go` exists |
| `zig` | Zig `build-exe -O ReleaseFast`, when a matching `.zig` exists |
| `numpy` | vectorized NumPy, when a matching `.npy.py` exists |
| `v8` | raw JavaScript on Node/V8 |
| `deno` | raw JavaScript on Deno/V8 |
| `bun` | raw JavaScript on Bun/JavaScriptCore |
| `spidermonkey` | raw JavaScript on SpiderMonkey shell (`spidermonkey`, `sm`, `js128`, `js115`, `js102`, or `js`) |
| `shermes` | Static Hermes — JS AOT-compiled to a native binary (`shermes -O`), when installed |
| `graaljs` | raw JavaScript on GraalJS |
| `jz` | jz output with host imports for timing/logging (measures wasm size without WASI console/perf bloat) |
| `as` | AssemblyScript `asc -O3 --runtime stub`, when a matching `.as.ts` exists |
| `jz-wasmtime` | jz output on wasmtime |
| `jz-w2c` | jz wasm translated by wabt `wasm2c`, then clang `-O3` |
| `wat` | hand-written WAT baseline when a case provides `run-wat.mjs` |
| `porf` | Porffor (`porf run`) when installed |
| `jawsm` | jawsm when installed |

The `size` column reports the artifact size each target measures: the
compiled native binary for `nat`/`rust`/`go`/`zig`, the produced
`.wasm` for `jz`/`as`/hand-WAT/jawsm/`jz-w2c` (the C-translated
executable), or the source file for raw-JS interpreters where there is no
compile step. For source files with imports, raw-JS size is only the entry file;
jz size is the bundled wasm artifact.

Note the preset trade: these speed tables build jz at the default
(`optimize: 2`, speed-leaning — loop unroll + SIMD lift), while the dedicated
size comparison (`npm run bench:size`) builds with `optimize: 'size'` —
typically ~2× smaller on the same kernel (biquad: 3.5 kB default vs 1.6 kB
size-tuned). Pick the preset for what you ship; the two tables are not the
same artifact.

Runtime command overrides:

`watr` is intentionally compiled by jz with a size-oriented pass config
(`watr:false`, `smallConstForUnroll:false`): on a large compiler bundle, the
default WAT-level optimizer and small-loop unroll grow code more than they help.
This keeps the target measuring the best current jz artifact for that workload.

```sh
BUN_BIN=/path/to/bun \
DENO_BIN=/path/to/deno \
SPIDERMONKEY_BIN=/path/to/js \
SHERMES_BIN=/path/to/shermes \
GRAALJS_BIN=/path/to/graaljs \
PORF_BIN=/path/to/porf \
node bench/bench.mjs --targets=bun,deno,spidermonkey,shermes,graaljs,porf
```

## Reading the numbers (darwin/arm64, M-class)

Snapshots from `node bench/bench.mjs --targets=v8,jz,as`.
Where jz lands relative to **V8 raw JS** (`v8/node`) and **AssemblyScript**
(`as`) is the headline comparison. Native and hand-WAT rows are shown where
available from earlier runs.

### biquad — f64 typed-array DSP cascade

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **4.69 ms** | **2.06×** | **3.4 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 6.63 ms | 1.45× | 1.9 kB | ok |
| V8 (node) raw JS | 9.64 ms | 1.00× | 3.2 kB | ok |
| native C (clang -O3) | 3.87 ms | 2.49× | 32.7 kB | ok |
| hand-WAT → V8 wasm | 6.49 ms | 1.90× | 767 B | ok |

jz beats V8 raw JS by 2.1× and AS by 1.4×. The typed-array scalarization,
offset-fusion, and base-hoisting pipeline delivers dense-f64 loop codegen
that matches the hand-WAT floor.

### mat4 — fixed-size Float64Array multiply

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **1.47 ms** | **5.85×** | **3.1 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 6.79 ms | 1.27× | 1.6 kB | ok |
| V8 (node) raw JS | 8.62 ms | 1.00× | 1.2 kB | ok |
| native C (clang -O3) | 1.96 ms | 4.40× | 32.8 kB | ok |
| hand-WAT → V8 wasm | 8.12 ms | 1.47× | 414 B | ok |

jz is 5.9× faster than V8 raw JS and 4.6× faster than AS. The scalarized
SIMD hot path (unrolled 4×4 multiply) is the win; V8's JIT doesn't vectorize
this from JS source.

### poly — bimorphic typed-array reduce

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **0.13 ms** | **12.89×** | **1.4 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 0.77 ms | 2.14× | 1.3 kB | ok |
| V8 (node) raw JS | 1.65 ms | 1.00× | 1014 B | ok |

jz is 12.9× faster than V8 raw JS and 5.9× faster than AS. The bimorphic
`sum` (called with both `Float64Array` and `Int32Array`) stays on typed
paths without falling back to generic dispatch.

### bitwise — i32 narrowing chains (`Math.imul`, shifts, FNV-1a)

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **1.01 ms** | **3.97×** | **1.2 kB** | **ok** |
| V8 (node) raw JS | 3.99 ms | 1.00× | 1005 B | ok |
| AssemblyScript (asc -O3 --runtime stub) | 8.86 ms | 0.45× | 1.5 kB | ok |
| native C (clang -O3) | 0.92 ms | 4.33× | 32.9 kB | ok |
| hand-WAT → V8 wasm | 3.59 ms | 1.11× | 355 B | ok |

jz is 4.0× faster than V8 raw JS and 8.8× faster than AS. The i32 hot path
(`Math.imul`, `|0`, `>>>0`) now lowers to raw `i32` ops without NaN-box
overhead on every operation.

### tokenizer — string scan with `charCodeAt` and integer accumulation

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **0.05 ms** | **2.42×** | **2.2 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 0.06 ms | 2.03× | 1.6 kB | ok |
| V8 (node) raw JS | 0.13 ms | 1.00× | 2.0 kB | ok |

jz is 2.4× faster than V8 raw JS and now edges out AS by ~1.2× on this
`charCodeAt`-heavy scan. Both are well ahead of V8.

### callback — `Array.map` closure + i32 fold

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **0.27 ms** | **2.26×** | **1.4 kB** | **ok** |
| V8 (node) raw JS | 0.61 ms | 1.00× | 1.3 kB | ok |
| AssemblyScript (asc -O3 --runtime stub) | 0.79 ms | 0.77× | 1.9 kB | ok |

jz is 2.3× faster than V8 raw JS and 2.9× faster than AS. Closure +
`Array.map` lowers to a preallocated typed loop with no per-iteration alloc.
V8's JIT does not inline the closure across the `map` boundary.

### aos — array-of-object rows to typed arrays

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **0.68 ms** | **1.89×** | **1.8 kB** | **ok** |
| V8 (node) raw JS | 1.29 ms | 1.00× | 1.1 kB | ok |
| AssemblyScript (asc -O3 --runtime stub) | 1.34 ms | 0.96× | 2.2 kB | ok |

jz is 1.9× faster than V8 raw JS and 2.0× faster than AS. Schema-slot
reads are direct field offsets; the gap is small because the workload is
memory-bound.

### mandelbrot — 256×256 escape-time iteration

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| AssemblyScript (asc -O3 --runtime stub) | 8.22 ms | 1.13× | 1.3 kB | ok |
| **jz → V8 wasm** | **8.33 ms** | **1.11×** | **1.4 kB** | **ok** |
| V8 (node) raw JS | 9.26 ms | 1.00× | 1.8 kB | ok |

jz is 1.1× faster than V8 raw JS and ties AS. The dense f64 hot loop with
conditional break compacts to 1.0 kB — the smallest wasm in the suite.

### json — runtime `JSON.parse` plus stable-shape walk

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **0.21 ms** | **1.28×** | **9.9 kB** | **ok** |
| V8 (node) raw JS | 0.27 ms | 1.00× | 1.2 kB | ok |

jz is 1.3× faster than V8 raw JS. The runtime parser is specialized to the
inferred JSON shape; AS is skipped because it cannot parse JSON at runtime.

### sort — in-place heapsort over typed array

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **5.15 ms** | **1.62×** | **1.8 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 7.45 ms | 1.12× | 1.9 kB | ok |
| V8 (node) raw JS | 8.34 ms | 1.00× | 1.6 kB | ok |

jz is 1.6× faster than V8 raw JS and 1.4× faster than AS. Call-heavy
nested loops with typed-array index propagation stay on the i32 path.

### crc32 — table-driven CRC-32 over byte buffer

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **8.40 ms** | **1.18×** | **1.5 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 8.66 ms | 1.15× | 1.4 kB | ok |
| V8 (node) raw JS | 9.95 ms | 1.00× | 1.8 kB | ok |

jz is 1.2× faster than V8 raw JS and ties AS. Integer narrowing and
typed-array parameter propagation keep the LUT lookup on raw i32.

### Audio + image showcase (cross-language, bit-exact)

Four standard kernels added to make the audio story concrete. All are written so
the output is **bit-identical** across every engine and native target — integer
math (bytebeat, blur) or transcendental-free f64 (fft, synth: in-source Taylor
polynomials, not `Math.sin`, which differs per libm). Go's arm64 auto-FMA gives
the documented `fma` parity class on the f64 cases.

| case | jz | vs V8 | vs AS | vs fastest native | jz wasm |
| --- | ---: | ---: | ---: | --- | ---: |
| **synth** — osc + ADSR + biquad | **2.32 ms** | **1.33×** | **1.07×** | **beats all** (Rust 0.89×) | 2.0 kB |
| **fft** — radix-2 Cooley–Tukey | **1.14 ms** | **1.27×** | **1.13×** | **ties** (Rust 1.07×) | 2.3 kB |
| **blur** — RGBA box blur | **0.90 ms** | **9.4×** | **5.8×** | trails (native SIMDs the stencil, 1.5×) | 3.4 kB |
| **bytebeat** — integer one-liner | **0.67 ms** | **3.7×** | **5.4×** | trails (native vectorizes, 1.3×) | 1.5 kB |

The headline: jz beats the JS field (V8, AssemblyScript) on **every** audio/image
case, **ties native on FFT**, and is the **fastest of all targets on the synth
pipeline** — its per-sample loop is loop-carried (oscillator phase + biquad
feedback), so native can't auto-vectorize it either, and jz's tight scalar f64
codegen with no NaN-box overhead wins outright. The two stateless integer kernels
(bytebeat, blur) are where `clang`/`zig`/`rustc` auto-vectorize an
embarrassingly-parallel loop jz emits as scalar — native is the floor there, but
jz still beats the JS field by 3.7–9.4× there. (Numbers: darwin/arm64, Apple M4 Max; the live snapshot
is [results.json](results.json).)

### watr — WAT-to-wasm compiler on small corpus

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| V8 (node) raw JS | 1.03 ms | 1.00× | 2.6 kB | ok |
| **jz → V8 wasm** | **1.10 ms** | **0.94×** | **238.5 kB** | **ok** |

jz is 1.07× slower than V8 raw JS on this large compiler bundle. The size
(144 kB) is the full jz-compiled watr parser + encoder + optimizer; V8's JIT
has the advantage of profile-guided tiering on a long-running compiler.

### Where the gaps live

Aggregate geomean (jz / target):

| target | speed | size |
| --- | ---: | ---: |
| V8 (node) | **0.44×** | — |
| AssemblyScript | **0.39×** | **1.15×** |

jz wins or ties V8 on every kernel case; the only V8 losses are the
self-hosting rows `watr` (1.07×) and `jessie` (1.28×). AS is beaten on
speed across the shared cases. On size jz is ~1.1× AS (geomean 1.16×,
median 1.10×) — jz wins on speed, AS on bytes.

Case-by-case summary:

* **biquad, mat4, poly, bitwise, callback: large wins.** jz beats V8 by
  2.0–12.9× and AS by 1.4–9.1×. Typed-array scalarization, i32 narrowing,
  and closure lowering are the drivers.
* **tokenizer, aos, mandelbrot, sort, crc32: modest wins.** jz beats V8 by
  1.1–2.4× and ties or beats AS. These are memory-bound or branch-heavy
  workloads where codegen quality matters less than data layout.
* **json: solid win.** jz beats V8 by 1.3× on runtime JSON parsing; AS
  cannot run this case.
* **alpha: the native floor.** jz beats V8 2.0× but trails native Rust ~13×
  (358 µs vs 27 µs) — alpha's hot path is an unsigned i32 multiply. jz already
  lifts it to 128-bit SIMD (an i16x8 widening byte-map); native pulls ahead on
  width alone — 256-bit AVX2 with a fused byte multiply-add, run as native code
  with no per-load bounds checks. The residual is the v128-vs-AVX2 ceiling, not
  a missing pass. A known gap we publish rather than hide.
* **watr: near parity.** jz is 1.07× slower than V8 on a 144 kB compiler
  bundle. It is one of two self-host rows (with jessie) where V8's
  profile-guided JIT tiers beat jz's AOT wasm.
