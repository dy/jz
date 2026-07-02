# JZ benchmark suite

Cross-target workload suite for JZ codegen quality. Each benchmark is a case
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
| [`dotprod`](dotprod/dotprod.js) | multiply-accumulate reduction; JZ reassociates to 4 SIMD accumulators, beating strict-fp serial native |
| [`bytebeat`](bytebeat/bytebeat.js) | classic integer "bytebeat" one-line-song synthesis to 8-bit PCM; pure i32, bit-exact everywhere |
| [`fft`](fft/fft.js) | radix-2 Cooley–Tukey FFT over a transcendental-free twiddle table; the canonical numeric/audio kernel |
| [`synth`](synth/synth.js) | minisynth audio pipeline — polynomial oscillator + ADSR + biquad per sample; loop-carried f64 |
| [`blur`](blur/blur.js) | separable box blur on an RGBA8 image; integer stencil with edge clamp, the canonical image pipeline |
| [`conv2d`](conv2d/conv2d.js) | int8 quantized conv layer (Cin→Cout, 3×3, i32 MAC + ReLU requant); the spatial-convolution counterpart to dense `matmul`, the edge-ML inference kernel |
| [`qoi`](qoi/qoi.js) | QOI lossless image codec encode + decode round-trip; loop-carried run/index/diff/luma ops that no target can vectorize — pure scalar-codegen race |
| [`hash`](hash/hash.js) | MurmurHash3 x86_32 over a byte buffer; table-free multiply/rotate/xor mixing, a different ALU profile from `crc32` |
| [`lz`](lz/lz.js) | LZSS compress + inflate round-trip; greedy sliding-window longest-match search — the match finder that dominates every LZ-family codec |
| [`base64`](base64/base64.js) | Base64 encode + decode round-trip; table-driven 3→4 byte packing, the canonical codec / serialization kernel |
| [`wav`](wav/wav.js) | PCM-16 WAV encoder; per-sample clamp + int16 quantization behind a RIFF/WAVE header, the audio serialization kernel |
| [`raytrace`](raytrace/raytrace.js) | minimal sphere ray tracer — primary ray + closest-hit + Lambert/ambient shading to an f64 framebuffer; the canonical 3-D render kernel, a branchy loop-carried scalar `sqrt` pipeline no target vectorizes |
| [`noise`](noise/noise.js) | 2-D Perlin gradient noise summed over 5 fBm octaves; the canonical procedural-generation kernel — integer permutation-table hashing interleaved with f64 smoothstep interpolation |
| [`radixsort`](radixsort/radixsort.js) | LSD radix sort (4 × 8-bit counting passes) over u32 keys; histogram → prefix-sum → scatter with buffer ping-pong, the gather/scatter integer-sort counterpart to compare-swap `sort` |
| [`levenshtein`](levenshtein/levenshtein.js) | Levenshtein edit-distance rolling-row dynamic program; the canonical sequence-alignment / fuzzy-match kernel — a branch- and min-reduction-heavy DP with a diagonal data dependency no target vectorizes |
| [`nqueens`](nqueens/nqueens.js) | bitmask N-Queens solution counter (board sizes drawn from a runtime array so the recursion can't be constant-folded); deep backtracking recursion + per-node bitmask branch — the call/recursion-codegen probe |
| [`dict`](dict/dict.js) | open-addressing hash table (build + probe) with linear probing; multiply-shift hash scatter + dependent-load gather + unpredictable probe-chain branches — the associative-container kernel |
| [`sieve`](sieve/sieve.js) | Sieve of Eratosthenes over a byte array; pure strided scatter (j = i², i²+i, …) guarded by an outer branch — a non-contiguous write pattern |
| [`vm`](vm/vm.js) | tiny bytecode interpreter — a fetch-decode-dispatch loop (if/else opcode chain + indirect code-array loads) running an integer recurrence; the canonical VM/regex-engine inner loop |
| [`spmv`](spmv/spmv.js) | sparse matrix×vector in CSR form; the MAC inner loop gathers `x[col[k]]` through a column-index array — the data-dependent gather dense codegen handles worst (exact-integer f64, bit-identical everywhere) |
| [`hashjoin`](hashjoin/hashjoin.js) | probe-dominated relational hash join (build small, stream a large probe side, sum matched payloads) — the database/dataframe kernel and JZ's boss case: `probe()` returns a typed-array element through a param JZ can't yet prove is i32, so `sum + probe()` lowers to a polymorphic number-or-string add per probe — then the only case JZ trailed V8; proving the return i32 measured 8.7 → 5.2 ms, jz now beats V8 1.3× |
| [`dispatch`](dispatch/dispatch.js) | data-driven dispatch through a table of 8 first-class functions — one call site fans out per an unpredictable opcode stream; the megamorphic call-site / virtual-dispatch kernel (strategy tables, event pipelines, effect chains), the classic call-IC deopt shape |
| [`shapes`](shapes/shapes.js) | per-variant measure summed over records of 8 heterogeneous object shapes — every access site sees 8 hidden classes; the megamorphic property-load / hidden-class kernel (JSON rows, AST nodes, ECS entities), the classic load-IC deopt shape — and JZ's widest gap (the schema union falls to dynamic-property probes) |
| [`strbuild`](strbuild/strbuild.js) | per-record string formatting (`id,name,value\n` per row: int→string + concat + char fold) — the serializer/logger inner loop, the string-allocation deopt shape (a giant `+=` accumulator is deliberately avoided: eager no-GC strings make it quadratic in allocation — jz exhausts memory on it) |
| [`wordcount`](wordcount/wordcount.js) | token-frequency counting into a plain object with 512 computed string keys over a skewed stream — the group-by/histogram kernel; a JIT drops the object to dictionary mode (the keyed-store deopt), while jz's string-keyed hash store + interning carry it |
| [`immutable`](immutable/immutable.js) | integer particle step in the immutable-update idiom — every step replaces each record with a fresh `{x,y,vx,vy}` (React/Redux-style state); value-semantics natives get it free, a JIT leans on young-gen GC + escape analysis, jz pays a bump allocation per object — the escape-analysis/SROA probe |
| [`colorconv`](colorconv/colorconv.js) | sRGB → Oklab over an image buffer — EOTF pow → 3×3 → cbrt → 3×3; lab probe for pow/cbrt intrinsic quality |
| [`colorlch`](colorlch/colorlch.js) | sRGB → OkLCh fused in one loop (pow → 3×3 → cbrt → 3×3 → sqrt + atan2); lab probe — the fused body must never lose to the split loops |
| [`colorlog`](colorlog/colorlog.js) | ARRI LogC4 → XYZ — runtime-base exp2 decode + 3×3; lab probe for runtime-exponent pow/exp2 |
| [`colorpq`](colorpq/colorpq.js) | sRGB → JzAzBz — 3×3 → ST 2084 PQ (≈12 signed-pow) → 3×3; lab probe for signed pow with non-constant exponent |
| [`watr`](watr/watr.js) | watr's WAT-to-wasm compiler on a small WAT corpus; compares jz-compiled compiler code with raw V8 |
| [`jessie`](jessie/jessie.js) | the subscript/jessie JS parser over a realistic source corpus; branch-, allocation- and recursion-heavy front-end work |
| [`jz`](jz/jz.js) | the JZ compiler itself (scripts/self.js pipeline) compiling three small programs at L2 — the self-host row runs jz.wasm compiling JavaScript; output bytes are checksummed so the parity gate doubles as a determinism proof |

The **`lab` rows** — the self-referential `watr`/`jessie`/`jz` (JZ or its deps
compiling code) and the JS-only intrinsic probes `colorconv`/`colorlch`/
`colorlog`/`colorpq` (pow/cbrt/exp2/atan2 gap trackers with no cross-language
ports; their transcendental checksums legitimately diverge per libm) — answer
jz-internal questions, not the cross-language kernel comparison. They sit out
every aggregate (the geomean SVG, the page strip and geomeans, the aggregate
table below) but stay visible on the bench page under the `lab` chip and
runnable via `--cases=…`; the self-host rows stay gated in `test/bench.js`.

Native rows for `json` are fixed-source references, not semantic equivalents
of JavaScript `JSON.parse`: C/Rust/Zig hand-parse the known schema from a
compile-time string, and Zig may constant-fold the whole parse+walk under
ReleaseFast; Go uses `encoding/json` but still unmarshals the same compile-time
string. The JZ row parses a `let` source at runtime so `JSON.parse` is not
compile-time folded, while the compiler can still specialize the stable literal
shape. External unknown-shape JSON still uses the generic runtime parser.

Native-language rows are intentionally per case. NumPy rows are used only
where a vectorized array implementation is a meaningful Python convention.

Pure interpreters (CPython, QuickJS, Hermes) stay out of the **headline**
geomean: it measures compiled-code quality, and an interpreter row inflates JZ's
lead for free without answering a question a user actually has. Javy
(embedded-QuickJS) is wired as a **fenced reference** — it appears per case as a
hatched row so the cost of the "ship a JS interpreter in wasm" approach is
visible, but it is excluded from `SVG_TARGETS` so it never moves the headline
number. The headline field is wasm-vs-wasm, apples-to-apples: JZ against the
other languages compiled to the same target — WebAssembly run in V8 — i.e. Rust,
Go, C, and Zig (`wasm32-wasi`), AssemblyScript, Porffor, and MoonBit (the last on
moonrun, MoonBit's V8 wasm runner), plus the JS JITs it replaces
(V8/Bun/Deno/SpiderMonkey/GraalJS). Native C/Rust/Zig/Go and NumPy's
vectorized C are the corpus reference band — the aggregate "what you give up by
not rewriting", with native C the speed-of-light ceiling.

**Coverage is reported, not hidden.** A target that is present but cannot compile
or run a case (Porffor OOMs on most typed-array kernels; TinyGo's stdlib subset
rejects some `.go`) records a `{ status: 'fail', reason }` entry in
`results.json`, and the page renders it as a muted row with the reason — and as a
`ran / attempted` count on the headline row. The geomean still averages only the
cases a target completed correctly (you cannot ratio a run that never produced a
number), but the gap is no longer invisible.

The **per-case** view splits into two **same-class lanes**, so every bar in a
card is a fair peer:

- **WASM** — JZ vs Rust/Go/C/Zig→wasm, AssemblyScript, Porffor, and raw JS, all
  run in this V8.
- **Native** — JZ lowered to a native binary (`jz-w2c`: JZ wasm → `wasm2c` →
  `clang -O3`) against the native toolchains (C/Rust/Go/Zig). This is the *fair*
  native comparison — native-vs-native, not jz-wasm against a native binary — and
  it's the axis for optimizing JZ's compile-to-native path. The lane hides where
  no `jz-w2c` build is available (it needs wabt's wasm2c runtime + SIMDe headers).

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
| `rust` | Rust `rustc -C opt-level=3 -C target-cpu=native` — native baseline; the headline rival is `rust-wasm` |
| `go` | Go native compiler — native baseline; the headline rival is `go-wasm` |
| `zig` | Zig `build-exe -O ReleaseFast` — native baseline |
| `numpy` | vectorized NumPy, when a matching `.npy.py` exists |
| `v8` | raw JavaScript on Node/V8 |
| `deno` | raw JavaScript on Deno/V8 |
| `bun` | raw JavaScript on Bun/JavaScriptCore |
| `jsc` | raw JavaScript on the standalone JavaScriptCore shell — Safari's engine (`jsc`; install via `jsvu --engines=javascriptcore`, or set `JSC_BIN`) |
| `spidermonkey` | raw JavaScript on SpiderMonkey shell (`spidermonkey`, `sm`, `js128`, `js115`, `js102`, or `js`) |
| `shermes` | Static Hermes — JS AOT-compiled to a native binary (`shermes -O`), when installed |
| `graaljs` | raw JavaScript on GraalJS |
| `jz` | JZ output with host imports for timing/logging (measures wasm size without WASI console/perf bloat) |
| `as` | AssemblyScript `asc -O3 --runtime stub`, when a matching `.as.ts` exists |
| `rust-wasm` | Rust → `wasm32-wasip1` (`rustc --target wasm32-wasip1 -C opt-level=3`), run in node's V8 — the apples-to-apples Rust rival |
| `go-wasm` | Go → `wasm32-wasip1` (`GOOS=wasip1 GOARCH=wasm go build`), run in node's V8 |
| `c-wasm` | C → `wasm32-wasi` via clang/LLVM (`zig cc -target wasm32-wasi -O3` — zig supplies the wasi-libc that plain clang lacks; no emcc/wasi-sdk install), run in node's V8 |
| `jz-wasmtime` | JZ output on wasmtime |
| `jz-w2c` | JZ wasm translated by wabt `wasm2c`, then clang `-O3` |
| `wat` | hand-written WAT baseline when a case provides `run-wat.mjs` |
| `porf` | Porffor (`porf run`) when installed |
| `jawsm` | jawsm (JS → WasmGC) when installed |
| `javy` | Javy (`javy build` — JS in embedded QuickJS) when installed — fenced interpreter reference, never in the headline geomean |
| `tinygo` | TinyGo → `wasm32-wasip1` (`tinygo build -target=wasip1 -opt=2`) — the Go corpus through LLVM, leaner wasm than `go-wasm`; run in node's V8 |
| `moonbit` | MoonBit → `wasm` (`moon build --target wasm --release`), run on `moonrun` (MoonBit's V8 wasm runner, which supplies the monotonic clock) — a wasm-first-language rival, when `moon`/`moonrun` are installed |

The `size` column reports the artifact size each target measures: the
compiled native binary for `nat`/`rust`/`go`/`zig`, the produced
`.wasm` for `jz`/`as`/`rust-wasm`/`go-wasm`/`c-wasm`/hand-WAT/jawsm/`jz-w2c` (the C-translated
executable), or the source file for raw-JS interpreters where there is no
compile step. For source files with imports, raw-JS size is only the entry file;
JZ size is the bundled wasm artifact.

Note the preset trade: these speed tables build JZ at the default
(`optimize: 2`, speed-leaning — loop unroll + SIMD lift), while the dedicated
size comparison (`npm run bench:size`) builds with `optimize: 'size'` —
typically ~2× smaller on the same kernel (biquad: 3.5 kB default vs 1.6 kB
size-tuned). Pick the preset for what you ship; the two tables are not the
same artifact.

Runtime command overrides:

`watr` is intentionally compiled by JZ with a size-oriented pass config
(`watr:false`, `smallConstForUnroll:false`): on a large compiler bundle, the
default WAT-level optimizer and small-loop unroll grow code more than they help.
This keeps the target measuring the best current JZ artifact for that workload.

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

Snapshots from `node bench/bench.mjs --targets=v8,jz,as` (the WASM lane).
Where JZ lands relative to **V8 raw JS** (`v8/node`) and **AssemblyScript**
(`as`) is the headline comparison; the hand-WAT row is the wasm-in-V8 floor.
The fair native comparison lives in the page's separate **Native lane** (`jz-w2c`
vs the native toolchains), not in these wasm snapshots — a native binary against
wasm-in-V8 would be a wrong-class single-case compare.

### biquad — f64 typed-array DSP cascade

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **4.68 ms** | **1.94×** | **1.7 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 6.59 ms | 1.38× | 1.8 kB | ok |
| V8 (node) raw JS | 9.09 ms | 1.00× | 3.2 kB | ok |
| hand-WAT → V8 wasm | 6.49 ms | 1.90× | 767 B | ok |

JZ beats V8 raw JS by 2.1× and AS by 1.4×. The typed-array scalarization,
offset-fusion, and base-hoisting pipeline delivers dense-f64 loop codegen
that matches the hand-WAT floor.

### mat4 — fixed-size Float64Array multiply

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.77 ms** | **11.15×** | **1.5 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 6.72 ms | 1.28× | 1.4 kB | ok |
| V8 (node) raw JS | 8.60 ms | 1.00× | 1.2 kB | ok |
| hand-WAT → V8 wasm | 8.12 ms | 1.47× | 414 B | ok |

JZ is 5.9× faster than V8 raw JS and 4.6× faster than AS. The scalarized
SIMD hot path (unrolled 4×4 multiply) is the win; V8's JIT doesn't vectorize
this from JS source.

### poly — bimorphic typed-array reduce

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.13 ms** | **12.30×** | **1.0 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 0.79 ms | 2.06× | 1.3 kB | ok |
| V8 (node) raw JS | 1.64 ms | 1.00× | 1014 B | ok |

JZ is 12.9× faster than V8 raw JS and 5.9× faster than AS. The bimorphic
`sum` (called with both `Float64Array` and `Int32Array`) stays on typed
paths without falling back to generic dispatch.

### bitwise — i32 narrowing chains (`Math.imul`, shifts, FNV-1a)

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.99 ms** | **3.81×** | **1.0 kB** | **ok** |
| V8 (node) raw JS | 3.77 ms | 1.00× | 1005 B | ok |
| AssemblyScript (asc -O3 --runtime stub) | 9.11 ms | 0.41× | 1.3 kB | ok |
| hand-WAT → V8 wasm | 3.49 ms | 1.08× | 355 B | ok |

JZ is 4.0× faster than V8 raw JS and 8.8× faster than AS. The i32 hot path
(`Math.imul`, `|0`, `>>>0`) now lowers to raw `i32` ops without NaN-box
overhead on every operation.

### tokenizer — string scan with `charCodeAt` and integer accumulation

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.06 ms** | **2.16×** | **2.0 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 0.06 ms | 2.13× | 1.5 kB | ok |
| V8 (node) raw JS | 0.14 ms | 1.00× | 2.0 kB | ok |

JZ is 2.4× faster than V8 raw JS and now edges out AS by ~1.2× on this
`charCodeAt`-heavy scan. Both are well ahead of V8.

### callback — `Array.map` closure + i32 fold

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.27 ms** | **2.25×** | **1.4 kB** | **ok** |
| V8 (node) raw JS | 0.60 ms | 1.00× | 1.3 kB | ok |
| AssemblyScript (asc -O3 --runtime stub) | 0.80 ms | 0.76× | 1.8 kB | ok |

JZ is 2.3× faster than V8 raw JS and 2.9× faster than AS. Closure +
`Array.map` lowers to a preallocated typed loop with no per-iteration alloc.
V8's JIT does not inline the closure across the `map` boundary.

### aos — array-of-object rows to typed arrays

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.67 ms** | **2.00×** | **1.7 kB** | **ok** |
| V8 (node) raw JS | 1.34 ms | 1.00× | 1.1 kB | ok |
| AssemblyScript (asc -O3 --runtime stub) | 1.40 ms | 0.96× | 1.9 kB | ok |

JZ is 1.9× faster than V8 raw JS and 2.0× faster than AS. Schema-slot
reads are direct field offsets; the gap is small because the workload is
memory-bound.

### mandelbrot — 256×256 escape-time iteration

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| AssemblyScript (asc -O3 --runtime stub) | 8.85 ms | 1.11× | 1.3 kB | ok |
| **JZ → V8 wasm** | **8.45 ms** | **1.16×** | **1.1 kB** | **ok** |
| V8 (node) raw JS | 9.83 ms | 1.00× | 1.8 kB | ok |

JZ is 1.1× faster than V8 raw JS and ties AS. The dense f64 hot loop with
conditional break compacts to 1.0 kB — the smallest wasm in the suite.

### json — runtime `JSON.parse` plus stable-shape walk

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.22 ms** | **1.22×** | **9.7 kB** | **ok** |
| V8 (node) raw JS | 0.27 ms | 1.00× | 1.2 kB | ok |

JZ is 1.3× faster than V8 raw JS. The runtime parser is specialized to the
inferred JSON shape; AS is skipped because it cannot parse JSON at runtime.

### sort — in-place heapsort over typed array

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **5.41 ms** | **1.64×** | **1.6 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 7.93 ms | 1.12× | 1.8 kB | ok |
| V8 (node) raw JS | 8.87 ms | 1.00× | 1.6 kB | ok |

JZ is 1.6× faster than V8 raw JS and 1.4× faster than AS. Call-heavy
nested loops with typed-array index propagation stay on the i32 path.

### crc32 — table-driven CRC-32 over byte buffer

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **8.62 ms** | **1.12×** | **1.0 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 8.74 ms | 1.10× | 1.3 kB | ok |
| V8 (node) raw JS | 9.62 ms | 1.00× | 1.8 kB | ok |

JZ is 1.2× faster than V8 raw JS and ties AS. Integer narrowing and
typed-array parameter propagation keep the LUT lookup on raw i32.

### Audio + image showcase (cross-language, bit-exact)

Four standard kernels added to make the audio story concrete. All are written so
the output is **bit-identical** across every engine and native target — integer
math (bytebeat, blur) or transcendental-free f64 (fft, synth: in-source Taylor
polynomials, not `Math.sin`, which differs per libm). Go's arm64 auto-FMA gives
the documented `fma` parity class on the f64 cases.

| case | JZ | vs V8 | vs AS | vs fastest native | JZ wasm |
| --- | ---: | ---: | ---: | --- | ---: |
| **synth** — osc + ADSR + biquad | **2.32 ms** | **1.33×** | **1.07×** | **beats all** (Rust 0.89×) | 2.0 kB |
| **fft** — radix-2 Cooley–Tukey | **1.14 ms** | **1.27×** | **1.13×** | **ties** (Rust 1.07×) | 2.3 kB |
| **blur** — RGBA box blur | **0.90 ms** | **9.4×** | **5.8×** | trails (native SIMDs the stencil, 1.5×) | 3.4 kB |
| **bytebeat** — integer one-liner | **0.67 ms** | **3.7×** | **5.4×** | trails (native vectorizes, 1.3×) | 1.5 kB |

The headline: JZ beats the JS field (V8, AssemblyScript) on **every** audio/image
case, **ties native on FFT**, and is the **fastest of all targets on the synth
pipeline** — its per-sample loop is loop-carried (oscillator phase + biquad
feedback), so native can't auto-vectorize it either, and JZ's tight scalar f64
codegen with no NaN-box overhead wins outright. The two stateless integer kernels
(bytebeat, blur) are where `clang`/`zig`/`rustc` auto-vectorize an
embarrassingly-parallel loop JZ emits as scalar — native is the floor there, but
JZ still beats the JS field by 3.7–9.4× there. (Numbers: darwin/arm64, Apple M4 Max; the live snapshot
is [results.json](results.json).)

### General-codegen kernels — 3-D render, procedural, sort, sequence DP

Four kernels added to probe JZ's **general** scalar/branch/gather-scatter codegen,
beyond the SIMD-friendly reductions and stencils above — the cases a graphics,
procedural, data, or text workload actually hits. All bit-identical across targets
(`raytrace`/`noise` are transcendental-free f64, so Go's arm64 auto-FMA is the
documented `fma` class; `radixsort`/`levenshtein` are pure integer, exact
everywhere).

| case | JZ | vs V8 | vs AS | vs fastest native | JZ wasm |
| --- | ---: | ---: | ---: | --- | ---: |
| **radixsort** — LSD u32 sort | **2.75 ms** | **1.21×** | **1.19×** | trails (clang 1.5×) | 1.6 kB |
| **noise** — Perlin fBm (5 oct) | **6.59 ms** | **1.36×** | 0.23× | trails (Rust 5.2×) | 8.0 kB |
| **raytrace** — sphere render | **2.00 ms** | **1.07×** | 0.89× | trails (Rust 1.9×) | 4.8 kB |
| **levenshtein** — edit-distance DP | ~6 ms | ~1.0× | 0.35× | trails (clang ~3×) | 7.5 kB |

These are the honest mixed bag — and the point. JZ beats raw V8 on three of four
(and the smallest wasm of the whole field on `radixsort`, 1.6 kB), but it only
beats AssemblyScript on `radixsort`; it **trails AS** on `noise` (~4.3×) and
`levenshtein` (~2.5–2.9×), and only **ties V8** on `levenshtein` (the median
straddles 1.0× run-to-run). The two AS gaps localize the next codegen work:
`noise`'s nested permutation-table indirection (`perm[perm[X]+Y]`) and
`levenshtein`'s branchy `min`-reduction DP over a rolling typed-array row are
exactly the scalar/gather shapes JZ does not yet lower as tightly as AS's
`asc -O3`. They sit out the curated regression gate (`test/bench.js`) — like
`heat`/`matmul`/`nbody`/`particle`/`lorenz` — until JZ closes the gap and they
ratchet in as wins.

### Control-flow & gather/scatter kernels — recursion, hashing, sieve, VM, sparse

A second probe set, aimed squarely at the patterns the first batch flagged —
recursion, branchy probe chains, scatter, and indirect gather — to map where JZ's
general (non-SIMD) codegen actually stands. All bit-identical across every target
(`spmv` is f64 over exact small integers, so even Go-native FMA agrees; `nqueens`
draws its board sizes from a runtime array so clang/rustc can't fold the recursion
to a constant).

| case | JZ | vs V8 | vs AS | vs native C | what it probes |
| --- | ---: | ---: | ---: | ---: | --- |
| **vm** — bytecode dispatch | **7.30 ms** | **1.55×** | **2.20×** | **1.13×** | if/else opcode dispatch + indirect fetch |
| **spmv** — sparse A·x (CSR) | **2.67 ms** | **1.78×** | **1.25×** | 0.90× | indirect gather `x[col[k]]` |
| **sieve** — Eratosthenes | **7.18 ms** | **1.53×** | **1.30×** | 0.80× | strided scatter + outer branch |
| **nqueens** — backtracking | **6.05 ms** | **1.29×** | 0.93× | 0.78× | deep recursion + bitmask branch |
| **dict** — hash table | 4.11 ms | 0.78× | 0.81× | 0.39× | hash scatter + probe-chain gather |

The split is sharp and informative. **JZ is excellent at dense dispatch and
in-cache gather**: it wins `vm` against the *entire* field — including native
`clang -O3` (the if/else interpreter loop lowers to tight branches with no
NaN-box overhead, where AS pays per-access bounds checks), and wins `spmv`/`sieve`
over the JS field while sitting near native. But it **loses `dict` to both V8
(1.28×) and AS (1.24×)** — open-addressing's hash-scatter + dependent-load probe
chain is the same gather/branch shape as `noise` and `levenshtein`, and the
clearest, most reproducible deficiency the suite has surfaced. `nqueens` is a
near-tie with AS on recursion. Together the nine new cases triangulate it: JZ's
gap to the AS/native frontier is concentrated in **scatter-heavy hashing and
dependent-gather / branchy-DP** kernels, not in dense scalar or dispatch loops.
Like the batch above, these stay bench-only (out of `test/bench.js`) until the gap
closes.

### Deopt kernels — dispatch, shapes, strings, maps, allocation

Five cases aimed square at the *deoptimization* shapes — the dynamic patterns
that make a JIT bail out of optimized code, and that an AOT compiler must
instead resolve statically. All are bit-identical across every target and
data-shuffled, so no branch predictor, inline cache, or devirtualizer can
settle on a fast path. Together they cover the dynamic-JS surface jz commits to
compile well: **calls** (`dispatch` — one call site fans out to a table of 8
first-class functions, the megamorphic call-IC shape), **hidden classes**
(`shapes` — records of 8 heterogeneous object shapes at one access site, the
megamorphic load-IC shape), **string churn** (`strbuild` — per-record
int→string + concat, the serializer inner loop), **keyed maps** (`wordcount` —
counting into a plain object with 512 computed string keys, the
dictionary-mode keyed-store deopt), and **allocation** (`immutable` — a fresh
`{x,y,vx,vy}` per particle per step, the React/Redux-style immutable update).
The static rivals write what a static language writes: fn-pointer tables,
tagged unions, stack-buffer formatting, string hash maps, value-type structs.

| case | JZ | vs V8 | vs AS | vs native C | what it probes |
| --- | ---: | ---: | ---: | ---: | --- |
| **dispatch** — fn-table dispatch | **10.4 ms** | 0.84× | **1.23×** | 0.46× | `call_indirect` vs megamorphic call IC |
| **strbuild** — per-record formatting | 1.83 ms | 0.92× | 0.83× | 0.83× | int→string + concat temporaries |
| **wordcount** — string-keyed counting | 8.80 ms | 0.30× | 0.93× | 0.28× | dynamic keys vs dictionary-mode IC |
| **immutable** — fresh-object step | 1.32 ms | 0.33× | 0.52× | 0.06× | escape analysis / allocation churn |
| **shapes** — 8-shape record scan | 18.1 ms | 0.19× | 0.06× | 0.09× | schema-union access vs megamorphic load IC |

The probes split jz's dynamic story cleanly. On `dispatch` **jz leads the
systems-language wasm field** — AS 1.23×, Rust/C/Zig/Go→wasm 1.05–1.2× — its
data-selected `call_indirect` is already tighter than what the systems
languages ship through the same table (only MoonBit's moonrun row edges it);
the remaining field is JIT call machinery — V8 0.84×, and JavaScriptCore's
call ICs win the case outright at ~2.3 ms — with bounded-table devirt (guarded
direct calls over the 8 known closures) the lever to close it. `strbuild` is
near-parity with V8 but rust-wasm leads 1.3× (and zig-wasm's stack-buffer
formatting 4.5×) — per-temporary `__str_concat` allocation and generic
`__itoa` are the levers. (The giant `out +=` accumulator variant is
deliberately excluded: eager no-GC strings make it quadratic in allocation —
jz exhausts memory on it. A real landmine for jz users, documented in the
case header.) `wordcount` ties AS's Map while V8's dictionary mode runs 3.3×
ahead and a plain C strcmp table 10× — per-op string hashing is the gap,
interning the lever. `immutable` trails every rival — jz bump-allocates each
escaping object with no scalar replacement and no reclamation, where V8's
young-gen GC recycles and value-semantics natives never allocate at all.
`shapes` stays **the widest gap in the suite, by design**: the 8-schema union
defeats schema-slot inference, so every field read lowers through the
`__dyn_get` dynamic-property probe — ~5× behind V8's megamorphic IC and ~16×
behind AS's kind-tagged flat struct (which ties native C); the general fix is
shape-set devirt — a bounded schema union lowering to a tag-switch over direct
slot loads, the static mirror of a polymorphic IC. `dispatch` passes the
fastest-wasm gate; `shapes`, `wordcount`, `immutable`, and `strbuild` are
pinned red in `WASM_TODO` — the deopt work list, loudest first.

### watr — WAT-to-wasm compiler on small corpus

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| V8 (node) raw JS | 0.97 ms | 1.00× | 2.6 kB | ok |
| **JZ → V8 wasm** | **0.96 ms** | **1.00×** | **244.3 kB** | **DIFF** |

JZ is 1.07× slower than V8 raw JS on this large compiler bundle. The size
(144 kB) is the full jz-compiled watr parser + encoder + optimizer; V8's JIT
has the advantage of profile-guided tiering on a long-running compiler.

### Where the gaps live

Aggregate geomean (JZ / target):

| target | speed | size |
| --- | ---: | ---: |
| V8 (node) | **0.53×** | — |
| AssemblyScript | **0.58×** | **1.06×** |

JZ wins or ties V8 on every dense kernel case; the open V8 losses are the
self-host lab rows (`watr`, `jessie`) and the deliberate deopt probes above
(`dispatch`, `shapes`, `wordcount`, `immutable`, `strbuild` — the dynamic-JS
work list). AS is beaten on speed across the shared cases except the tracked
gather/probe gaps (`dict`, `noise`, `levenshtein`) and the deopt probes
(`shapes`, `immutable`, `strbuild`; `wordcount` is a tie). On size JZ matches
AS (geomean ~1.0×) — JZ wins on speed and holds size parity.

Against the systems languages compiled to the same target — **WebAssembly, run in
V8** — JZ is **1.6× faster than C, 1.7× than Rust, and 3.4× than Go** (geomean,
deopt probes included). That apples-to-apples wasm field is the headline chart
above. Native `clang -O3` — the lone non-wasm reference row, the speed-of-light
ceiling, never a per-case beat-claim — now leads the corpus geomean 1.2×: the
deopt probes are exactly where native value semantics and mature runtimes pull
ahead, and closing them is the current work list.

Case-by-case summary:

* **biquad, mat4, poly, bitwise, callback: large wins.** JZ beats V8 by
  2.0–12.9× and AS by 1.4–9.1×. Typed-array scalarization, i32 narrowing,
  and closure lowering are the drivers.
* **tokenizer, aos, mandelbrot, sort, crc32: modest wins.** JZ beats V8 by
  1.1–2.4× and ties or beats AS. These are memory-bound or branch-heavy
  workloads where codegen quality matters less than data layout.
* **json: solid win.** JZ beats V8 by 1.3× on runtime JSON parsing; AS
  cannot run this case.
* **alpha: the native floor.** JZ beats V8 2.0× and every wasm rival (Rust/C/Go
  → wasm), but trails the native-C reference ~14× (374 µs vs 26 µs) — alpha's hot
  path is an unsigned i32 multiply. JZ already lifts it to 128-bit SIMD (an i16x8
  widening byte-map); native C pulls ahead on width alone — 256-bit AVX2 with a
  fused byte multiply-add, run as native code with no per-load bounds checks. The
  residual is the wasm-v128-vs-AVX2 ceiling, not a missing pass. A known gap we
  publish rather than hide.
* **watr: near parity.** JZ is 1.07× slower than V8 on a 144 kB compiler
  bundle. It is one of two self-host rows (with jessie) where V8's
  profile-guided JIT tiers beat JZ's AOT wasm.
