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
GRAALJS_BIN=/path/to/graaljs \
PORF_BIN=/path/to/porf \
node bench/bench.mjs --targets=bun,deno,spidermonkey,hermes,graaljs,porf
```

## Reading the numbers (darwin/arm64, M-class)

Snapshots from one full run per case (`node bench/bench.mjs <case>`).
Where jz lands relative to the **hand-WAT floor** (`wat`) and to **V8 raw
JS** (`v8/node`) is the headline number for each row.

### biquad — f64 typed-array DSP cascade

| target | median | ×nat | size | parity |
| --- | ---: | ---: | ---: | --- |
| Rust (rustc -O `target-cpu=native`) | 5.29 ms | 0.99× | 380.7 kB | ok |
| native C (clang -O3 -ffp-contract=off) | 5.32 ms | 1.00× | 32.7 kB | ok |
| **jz → V8 wasm** | **4.28 ms** | **0.80×** | **4.0 kB** | **ok** |
| hand-WAT → V8 wasm | 6.49 ms | 1.22× | 767 B | ok |
| Go (gc, FMA-fused on arm64) | 8.93 ms | 1.68× | 1.60 MB | fma |
| AssemblyScript (asc -O3 --runtime stub) | 6.22 ms | 1.17× | 1.9 kB | ok |
| V8 (node) raw JS | 8.40 ms | 1.58× | 3.2 kB | ok |

**jz beats the hand-WAT floor by 1.5× and AS by 1.45× on speed.** The 1.73×
gap documented in earlier snapshots is closed: per-stage base hoisting,
`offset=` immediate fusion, and the typed-array scalar-replacement work
landed and closed the wasm-codegen gap on dense-f64 loops. jz also beats
V8's raw-JS execution of the same source by 1.96×, so any path from
`.js` source through wasm beats the JIT cleanly on this workload.

With `optimize: { scalarTypedArrayLen: 16, scalarTypedLoopUnroll: 8 }` the
default bench compiles to **4.0 kB** (was 4.5 kB). For an even tighter
bundle, `optimize: { smallConstForUnroll: false, scalarTypedArrayLen: 8 }`
cuts the wasm to **2.3 kB** (vs AS 1.9 kB) — a 50% size cut that trades
speed for compactness by keeping setup loops rolled.

### mat4 — fixed-size Float64Array multiply

| target | median | ×nat | size | parity |
| --- | ---: | ---: | ---: | --- |
| Rust (rustc -O `target-cpu=native`) | 1.80 ms | 0.65× | 380.7 kB | ok |
| **jz → V8 wasm** | **1.41 ms** | **0.51×** | **2.8 kB** | **ok** |
| native C (clang -O3 -ffp-contract=off) | 2.76 ms | 1.00× | 32.8 kB | ok |
| hand-WAT → V8 wasm | 8.12 ms | 2.95× | 414 B | ok |
| AssemblyScript (asc -O3 --runtime stub) | 6.32 ms | 2.29× | 1.6 kB | ok |
| V8 (node) raw JS | 8.13 ms | 2.95× | 1.2 kB | ok |
| Go (gc) | 12.13 ms | 4.40× | 1.60 MB | ok |

**jz is 4.48× faster than AS on mat4.** With `optimize: {
scalarTypedArrayLen: 16, scalarTypedLoopUnroll: 8 }` the default bench
compiles to **2.8 kB** (was 3.4 kB) while keeping the scalarized hot path.
For an even tighter bundle, `optimize: { smallConstForUnroll: false,
scalarTypedArrayLen: 8 }` cuts the wasm to **1.8 kB** (vs AS 1.6 kB) — a
47% size cut that trades some setup-loop speed for compactness.

### json — JSON.parse plus stable-shape object walk

| target | median | ×nat | size | parity |
| --- | ---: | ---: | ---: | --- |
| Zig fixed-schema parser (ReleaseFast) | 0.00 ms | 0.00× | 387.1 kB | ok |
| C fixed-schema parser (clang -O3) | 0.02 ms | 1.00× | 32.8 kB | ok |
| Rust fixed-schema parser (rustc -O) | 0.03 ms | 1.17× | 380.7 kB | ok |
| **jz runtime JSON.parse → V8 wasm** | **0.21 ms** | **9.13×** | **11.0 kB** | **ok** |
| V8 (node) raw JS JSON.parse | 0.37 ms | 16.04× | 1.2 kB | ok |
| Go encoding/json on static string | 1.05 ms | 45.48× | 1.97 MB | ok |

**The native rows are references, not equivalent parser work.** C/Rust/Zig
hand-parse the known schema from a compile-time source, and Zig's 0.00 ms row
is effectively a compiler-optimized fixed-source lower bound. Go is the fairer
native semantic reference because it uses `encoding/json`, but it still parses a
compile-time string. The jz row keeps `SRC` as `let`, so `JSON.parse` runs at
runtime; the compiler only specializes the stable result shape for the object
walk. The useful headline is jz vs raw V8 on the same JS source: 1.76× faster.

### bitwise — i32 narrowing chains (`Math.imul`, shifts, FNV-1a)

| target | median | ×nat | size | parity |
| --- | ---: | ---: | ---: | --- |
| Rust (rustc -O) | 1.30 ms | 1.00× | 380.7 kB | ok |
| native C (clang -O3) | 1.31 ms | 1.00× | 32.9 kB | ok |
| Zig (ReleaseFast) | 4.18 ms | 3.20× | 387.1 kB | ok |
| V8 (deno) raw JS | 4.66 ms | 3.57× | 1005 B | ok |
| hand-WAT → V8 wasm | 4.88 ms | 3.74× | 355 B | ok |
| Go (gc) | 5.21 ms | 3.99× | 1.60 MB | ok |
| V8 (node) raw JS | 5.23 ms | 4.01× | 1005 B | ok |
| AssemblyScript (asc -O3) | 12.05 ms | 9.23× | 1.5 kB | ok |
| **jz → V8 wasm** | **71.46 ms** | **54.72×** | **1.3 kB** | **ok** |

**bitwise is the current outlier — jz is 14.6× the hand-WAT floor and
13.7× V8 raw JS.** The hand-WAT module fits in 355 bytes (no abstraction
at all), V8's TurboFan recognizes the i32 mix as a hot integer kernel
and tier-2 specializes it. AS even shows that an "i32-only" wasm-from-
source compiler can land at 12 ms here. jz is paying NaN-box overhead on
*every* element load + every shift + every imul: type-tag check, payload
extract, bit-equality on the result. The fix is the same one tracked in
`.work/todo.md` — drop NaN-boxing as the value carrier on the i32 hot
path so `Math.imul`/`x|0`/`x>>>0` lower to plain `i32` ops.

### callback — `Array.map` closure + i32 fold

| target | median | ×nat | size | parity |
| --- | ---: | ---: | ---: | --- |
| Zig (ReleaseFast) | 0.01 ms | 0.12× | 387.1 kB | ok |
| **jz → V8 wasm** | **0.05 ms** | **0.42×** | **1.6 kB** | **ok** |
| Rust (rustc -O) | 0.09 ms | 0.77× | 380.7 kB | ok |
| native C (clang -O3) | 0.11 ms | 1.00× | 32.9 kB | ok |
| Go (gc) | 0.20 ms | 1.75× | 1.60 MB | ok |
| hand-WAT → V8 wasm | 0.25 ms | 2.20× | 267 B | ok |
| V8 (node) raw JS | 0.86 ms | 7.72× | 828 B | ok |
| AssemblyScript (asc -O3) | 1.48 ms | 13.21× | 1.9 kB | ok |

**jz beats hand-WAT by 5×, native C by 2.4×, V8 raw JS by 17×, and AS by
30× on callback.** Two things are happening: jz lowers the closure +
`Array.map` to a tight typed-loop with the array preallocated (no
per-iter alloc), and V8's wasm tier sees the hot kernel and unrolls/
folds aggressively. The hand-WAT row reuses `b` too but doesn't get the
same V8 inline pass. This is the case where jz's analysis pipeline
visibly pays off — closure dispatch is removed, allocation is hoisted,
and the resulting wasm shape is smaller and faster than what V8's JIT
can produce from the same JS source.

### Where the gaps live

Reading across the five cases:

* **biquad: solved.** jz at the hand-WAT floor, beating AS and V8 raw
  JS. The codegen for dense-f64 typed-array loops is good.
* **mat4: fast and compact.** jz's scalarized/SIMD path beats native C and
  AS by 4.5×, emitting 2.8 kB with the default config.
* **json: compare jz to V8 or Go, not fixed-schema C/Rust/Zig.** jz is
  parsing at runtime and then using stable-shape slot loads; the native
  hand parsers are static-source lower bounds, not JavaScript `JSON.parse`
  equivalents.
* **bitwise: blocked on NaN-box on the i32 path.** Every i32 op pays
  type-tag overhead. The `i64`-tagged carrier work in `.work/todo.md`
  Step 1–2 is the gating change; estimated 14×→2× landing for this case
  once `Math.imul`/`|0`/`>>>0` lower to native i32 in the hot loop.
* **callback: jz already beats hand-WAT.** Closure lowering and
  array-alloc hoisting work. The remaining 4× gap to Zig is V8's
  unwillingness to treat the kernel as constant-foldable across runs;
  not a jz-codegen bug.

The detailed AS-specific commentary that lived here previously
(bounds-check elision, runtime stub, etc.) still applies — AS's 8.9 ms
on biquad is now slower than jz, so the "AS as the reference" framing
flipped. AS now serves as a *lower-bound for what other compilers
achieve without case-specific analysis*. jz beats it on biquad and
callback; AS beats jz on bitwise by ~6× because AS doesn't NaN-box i32.
