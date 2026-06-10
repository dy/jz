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
bench/<case>/<case>.py      optional scalar CPython baseline
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
node bench/bench.mjs --targets=v8,deno,bun,spidermonkey,hermes,graaljs,qjs
node bench/bench.mjs --cases=biquad,mat4,tokenizer,json,sort,crc32
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
| [`watr`](watr/watr.js) | watr's WAT-to-wasm compiler on a small WAT corpus; compares jz-compiled compiler code with raw V8 |

Native rows for `json` are fixed-source references, not semantic equivalents
of JavaScript `JSON.parse`: C/Rust/Zig hand-parse the known schema from a
compile-time string, and Zig may constant-fold the whole parse+walk under
ReleaseFast; Go uses `encoding/json` but still unmarshals the same compile-time
string. The jz row parses a `let` source at runtime so `JSON.parse` is not
compile-time folded, while the compiler can still specialize the stable literal
shape. External unknown-shape JSON still uses the generic runtime parser.

Native-language rows are intentionally per case. NumPy rows are used only
where a vectorized array implementation is a meaningful Python convention;
scalar CPython is kept to the tokenizer row to avoid turning the suite into
a Python loop-overhead benchmark.

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
| `python` | scalar CPython, when a matching `.py` exists |
| `numpy` | vectorized NumPy, when a matching `.npy.py` exists |
| `v8` | raw JavaScript on Node/V8 |
| `deno` | raw JavaScript on Deno/V8 |
| `bun` | raw JavaScript on Bun/JavaScriptCore |
| `spidermonkey` | raw JavaScript on SpiderMonkey shell (`spidermonkey`, `sm`, `js128`, `js115`, `js102`, or `js`) |
| `hermes` | raw JavaScript on Hermes |
| `shermes` | Static Hermes — JS AOT-compiled to a native binary (`shermes -O`), when installed |
| `graaljs` | raw JavaScript on GraalJS |
| `jz` | jz output with host imports for timing/logging (measures wasm size without WASI console/perf bloat) |
| `as` | AssemblyScript `asc -O3 --runtime stub`, when a matching `.as.ts` exists |
| `jz-wasmtime` | jz output on wasmtime |
| `jz-w2c` | jz wasm translated by wabt `wasm2c`, then clang `-O3` |
| `wat` | hand-written WAT baseline when a case provides `run-wat.mjs` |
| `qjs` | QuickJS when installed |
| `porf` | Porffor (`porf run`) when installed |
| `jawsm` | jawsm when installed |

The `size` column reports the artifact size each target measures: the
compiled native binary for `nat`/`rust`/`go`/`zig`, the produced
`.wasm` for `jz`/`as`/hand-WAT/jawsm/`jz-w2c` (the C-translated
executable), or the source file for raw-JS interpreters where there is no
compile step. For source files with imports, raw-JS size is only the entry file;
jz size is the bundled wasm artifact.

Runtime command overrides:

`watr` is intentionally compiled by jz with a size-oriented pass config
(`watr:false`, `smallConstForUnroll:false`): on a large compiler bundle, the
default WAT-level optimizer and small-loop unroll grow code more than they help.
This keeps the target measuring the best current jz artifact for that workload.

```sh
BUN_BIN=/path/to/bun \
DENO_BIN=/path/to/deno \
SPIDERMONKEY_BIN=/path/to/js \
HERMES_BIN=/path/to/hermes \
SHERMES_BIN=/path/to/shermes \
GRAALJS_BIN=/path/to/graaljs \
PORF_BIN=/path/to/porf \
node bench/bench.mjs --targets=bun,deno,spidermonkey,hermes,shermes,graaljs,porf
```

## Reading the numbers (darwin/arm64, M-class)

Snapshots from `node bench/bench.mjs --targets=v8,jz,as`.
Where jz lands relative to **V8 raw JS** (`v8/node`) and **AssemblyScript**
(`as`) is the headline comparison. Native and hand-WAT rows are shown where
available from earlier runs.

### biquad — f64 typed-array DSP cascade

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **6.50 ms** | **1.90×** | **3.4 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 9.03 ms | 1.38× | 1.9 kB | ok |
| V8 (node) raw JS | 12.35 ms | 1.00× | 3.2 kB | ok |
| native C (clang -O3) | 5.32 ms | 2.32× | 32.7 kB | ok |
| hand-WAT → V8 wasm | 6.49 ms | 1.90× | 767 B | ok |

jz beats V8 raw JS by 1.9× and AS by 1.4×. The typed-array scalarization,
offset-fusion, and base-hoisting pipeline delivers dense-f64 loop codegen
that matches the hand-WAT floor.

### mat4 — fixed-size Float64Array multiply

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **2.74 ms** | **4.37×** | **3.3 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 9.32 ms | 1.28× | 1.6 kB | ok |
| V8 (node) raw JS | 11.96 ms | 1.00× | 1.2 kB | ok |
| native C (clang -O3) | 2.76 ms | 4.33× | 32.8 kB | ok |
| hand-WAT → V8 wasm | 8.12 ms | 1.47× | 414 B | ok |

jz is 4.4× faster than V8 raw JS and 3.4× faster than AS. The scalarized
SIMD hot path (unrolled 4×4 multiply) is the win; V8's JIT doesn't vectorize
this from JS source.

### poly — bimorphic typed-array reduce

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **0.37 ms** | **6.22×** | **1.2 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 1.15 ms | 2.02× | 1.3 kB | ok |
| V8 (node) raw JS | 2.32 ms | 1.00× | 1014 B | ok |

jz is 6.2× faster than V8 raw JS and 3.1× faster than AS. The bimorphic
`sum` (called with both `Float64Array` and `Int32Array`) stays on typed
paths without falling back to generic dispatch.

### bitwise — i32 narrowing chains (`Math.imul`, shifts, FNV-1a)

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **1.40 ms** | **3.81×** | **1.2 kB** | **ok** |
| V8 (node) raw JS | 5.32 ms | 1.00× | 1005 B | ok |
| AssemblyScript (asc -O3 --runtime stub) | 12.13 ms | 0.44× | 1.5 kB | ok |
| native C (clang -O3) | 1.31 ms | 4.06× | 32.9 kB | ok |
| hand-WAT → V8 wasm | 4.88 ms | 1.09× | 355 B | ok |

jz is 3.8× faster than V8 raw JS and 8.7× faster than AS. The i32 hot path
(`Math.imul`, `|0`, `>>>0`) now lowers to raw `i32` ops without NaN-box
overhead on every operation.

### tokenizer — string scan with `charCodeAt` and integer accumulation

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| AssemblyScript (asc -O3 --runtime stub) | 0.08 ms | 2.63× | 1.6 kB | ok |
| **jz → V8 wasm** | **0.10 ms** | **2.03×** | **1.7 kB** | **ok** |
| V8 (node) raw JS | 0.21 ms | 1.00× | 2.0 kB | ok |

jz is 2.0× faster than V8 raw JS. AS wins here by 1.3× because its
`String#charCodeAt` is a direct memory load without NaN-box decode, while
jz still boxes the string pointer. The gap is narrow (0.02 ms) and both
are well ahead of V8.

### callback — `Array.map` closure + i32 fold

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **0.03 ms** | **27.56×** | **1.4 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 1.49 ms | 0.59× | 1.9 kB | ok |
| V8 (node) raw JS | 0.88 ms | 1.00× | 828 B | ok |

jz is 27.6× faster than V8 raw JS and 49.7× faster than AS. Closure +
`Array.map` lowers to a preallocated typed loop with no per-iteration alloc.
V8's JIT does not inline the closure across the `map` boundary.

### aos — array-of-object rows to typed arrays

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **1.62 ms** | **1.12×** | **1.8 kB** | **ok** |
| V8 (node) raw JS | 1.82 ms | 1.00× | 1.1 kB | ok |
| AssemblyScript (asc -O3 --runtime stub) | 1.91 ms | 0.95× | 2.2 kB | ok |

jz is 1.1× faster than V8 raw JS and 1.2× faster than AS. Schema-slot
reads are direct field offsets; the gap is small because the workload is
memory-bound.

### mandelbrot — 256×256 escape-time iteration

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| AssemblyScript (asc -O3 --runtime stub) | 12.42 ms | 1.11× | 1.3 kB | ok |
| **jz → V8 wasm** | **12.55 ms** | **1.10×** | **1.0 kB** | **ok** |
| V8 (node) raw JS | 13.80 ms | 1.00× | 1.8 kB | ok |

jz is 1.1× faster than V8 raw JS and ties AS. The dense f64 hot loop with
conditional break compacts to 1.0 kB — the smallest wasm in the suite.

### json — runtime `JSON.parse` plus stable-shape walk

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **0.23 ms** | **1.65×** | **7.7 kB** | **ok** |
| V8 (node) raw JS | 0.38 ms | 1.00× | 1.2 kB | ok |

jz is 1.7× faster than V8 raw JS. The runtime parser is specialized to the
inferred JSON shape; AS is skipped because it cannot parse JSON at runtime.

### sort — in-place heapsort over typed array

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **5.96 ms** | **1.87×** | **1.6 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 10.22 ms | 1.09× | 1.9 kB | ok |
| V8 (node) raw JS | 11.13 ms | 1.00× | 1.6 kB | ok |

jz is 1.9× faster than V8 raw JS and 1.7× faster than AS. Call-heavy
nested loops with typed-array index propagation stay on the i32 path.

### crc32 — table-driven CRC-32 over byte buffer

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **jz → V8 wasm** | **12.12 ms** | **1.11×** | **1.2 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 12.19 ms | 1.10× | 1.4 kB | ok |
| V8 (node) raw JS | 13.43 ms | 1.00× | 1.8 kB | ok |

jz is 1.1× faster than V8 raw JS and ties AS. Integer narrowing and
typed-array parameter propagation keep the LUT lookup on raw i32.

### watr — WAT-to-wasm compiler on small corpus

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| V8 (node) raw JS | 1.45 ms | 1.00× | 2.6 kB | ok |
| **jz → V8 wasm** | **1.56 ms** | **1.07×** | **144.4 kB** | **ok** |

jz is 1.07× slower than V8 raw JS on this large compiler bundle. The size
(144 kB) is the full jz-compiled watr parser + encoder + optimizer; V8's JIT
has the advantage of profile-guided tiering on a long-running compiler.

### Where the gaps live

Aggregate geomean (jz / target):

| target | speed | size |
| --- | ---: | ---: |
| V8 (node) | **0.41×** | — |
| AssemblyScript | **0.40×** | **0.85×** |
| Porffor | **0.32×** | **0.04×** |
| wasm-opt slack | — | **0.91×** |

jz wins or ties V8 on every case except `watr` (1.07×). AS is beaten on
all cases except `tokenizer` (AS 0.08 ms vs jz 0.10 ms). The size geomean
is 0.85× AS — jz output is smaller on average despite beating AS on speed.

Case-by-case summary:

* **biquad, mat4, poly, bitwise, callback: large wins.** jz beats V8 by
  1.9–27.6× and AS by 1.4–49.7×. Typed-array scalarization, i32 narrowing,
  and closure lowering are the drivers.
* **tokenizer, aos, mandelbrot, sort, crc32: modest wins.** jz beats V8 by
  1.1–2.0× and ties or beats AS. These are memory-bound or branch-heavy
  workloads where codegen quality matters less than data layout.
* **json: solid win.** jz beats V8 by 1.7× on runtime JSON parsing; AS
  cannot run this case.
* **watr: near parity.** jz is 1.07× slower than V8 on a 144 kB compiler
  bundle. This is the only case where V8's profile-guided JIT tiers beat
  jz's AOT wasm.
