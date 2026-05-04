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
node bench/bench.mjs --cases=biquad,mat4,tokenizer,json
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
| [`json`](json/json.js) | `JSON.parse` plus heterogeneous object/array walk; JS-only by design |
| [`watr`](watr/watr.js) | watr's WAT-to-wasm compiler on a small WAT corpus; compares jz-compiled compiler code with raw V8 |

`json` has no C row because a hand-written C parser would not be the same
implementation contract as JavaScript `JSON.parse`.

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

## Reading the numbers (biquad on darwin/arm64, M-class)

Snapshot from one full run (`node bench/bench.mjs biquad`):

| target | median | ×nat | size | parity |
| --- | ---: | ---: | ---: | --- |
| native C (clang -O3 -ffp-contract=off) | 5.38 ms | 1.00× | 32.8 kB | ok |
| Rust (rustc -O `target-cpu=native`) | 5.66 ms | 1.05× | 471.9 kB | ok |
| hand-WAT → V8 wasm | 6.54 ms | 1.22× | 767 B | ok |
| AssemblyScript (asc -O3 --runtime stub) | 9.01 ms | 1.68× | 1.9 kB | ok |
| Go (gc, FMA-fused on arm64) | 10.46 ms | 1.94× | 2.39 MB | fma |
| jz → V8 wasm | 11.29 ms | 2.10× | 2.3 kB | ok |
| jz → wasm2c → clang -O3 | 12.12 ms | 2.25× | 68.4 kB | ok |
| V8 (node) raw JS | 12.27 ms | 2.28× | 3.2 kB | ok |
| V8 (deno) raw JS | 12.61 ms | 2.34× | 3.2 kB | ok |
| jz → wasmtime | 14.75 ms | 2.74× | 7.9 kB | ok |

Where the time goes:

* **Rust ≈ C.** The two native-code rows match within noise: same algorithm,
  same `-ffp-contract=off`, same NEON scheduler underneath. Rust's larger
  binary is just the static stdlib it links by default.
* **hand-WAT (6.5 ms) is the wasm floor on V8.** Direct-form-1 cascade
  written by hand uses one base pointer per array + `f64.load offset=`
  immediates and avoids every helper call. This is the target jz aims at.
* **AssemblyScript (9.0 ms) is the high-quality wasm-from-source floor.**
  AS pre-narrows everything (`Float64Array` is monomorphic, `unchecked()`
  elides bounds checks, no NaN-boxed values), so its inner loop is roughly
  the hand-WAT shape minus a few peephole tricks. ~39 % slower than
  hand-WAT, ~20 % faster than jz.
* **jz (11.3 ms) currently sits between AS and raw V8 JS.** It now beats
  V8's raw-JS execution of the same source, but is 1.25× slower than AS
  and 1.74× slower than hand-WAT. The jz-w2c row (jz wasm → clang) is in
  the same range, which says the bottleneck is the *shape* of the wasm jz
  emits, not V8's wasm tier — the same shape stays slow even after clang
  sees it.
* **V8 raw JS (12.3 ms) is the JIT ceiling on the JS source.** TurboFan
  reaches roughly hand-WAT × 1.9 here. jz crosses below that line.
* **wasmtime (14.8 ms) is single-tier.** No TurboFan-equivalent; this
  measures Cranelift one-pass codegen on jz's wasm.

### Optimization order — what closes the gap to hand-WAT

The 1.73× gap between jz (11.3 ms) and hand-WAT (6.5 ms) is the same shape
on V8 *and* on clang (jz-w2c is 12.1 ms), so the wins below target the
wasm jz emits, not the consumer. Listed by expected impact:

1. **Per-stage base hoisting + `offset=` immediate fusion** (≈11.3→9 ms,
   matches AS). Recognize that `arr[expr+0..K]` reads share a base
   `arr + expr*shift`, lift the base into a local once, emit
   `f64.load offset=8/16/24/32 (base)` instead of recomputing the index per
   read. This is exactly what hand-WAT does and roughly what AS does. It is
   the single biggest known win — closes most of the wasm-codegen gap.
2. **Scalar-replacement of repeated typed-array reads** (small follow-up).
   When the same `arr[const]` appears twice in a basic block with no
   intervening write, hoist to a local. Today CSE may handle this only when
   the index expression is identical at the IR level.
3. **Aggressive inlining for monomorphic single-caller hot funcs** (≈9→7
   ms, narrows the gap to hand-WAT). `processCascade` is currently not
   inlined because of size; lift the threshold when the callee is
   non-exported, called from ≤2 sites, and call-site values include
   constants the loop bounds depend on.
4. **Constant-arg propagation + small-trip-count unroll**. With (3),
   `nStages = 8` becomes a literal in the inner body; unrolling that loop
   produces straight-line code that V8/clang vectorize trivially.
5. **i32 narrowing for module-const integer args (revisit nStages)**.
   Tried this round; clang loved it (jz-w2c stayed fast), V8's TurboFan
   wasm tier regressed. Re-attempt coupled with (3) so the param disappears.

The four remaining items in `.work/todo.md` (LICM verify, bounds-check
elision hints, symmetric widen-pass, general `offset=` fusion) are smaller
and become free once (1) lands. The conceptual shifts (unified Type record,
unbox-by-default ABI, TCO) are out of scope for biquad parity but stand on
their own merits — biquad is one workload and these affect every loop in
the suite.

### Where AS already lands and why it stops at 8.9 ms

AS reaches 8.9 ms with a 1.9 kB wasm — three useful data points for jz:

* **Bounds checks matter.** Removing `unchecked()` from the AS source
  raises its row to ~10 ms in spot checks. This says jz's typed-array
  bounds-checking should be elided in the loop, not just minimized.
* **No-runtime is feasible** even with `Float64Array`. AS's `--runtime
  stub` produces 1.9 kB; jz's is 8.1 kB. Most of jz's overhead is dead-code
  segment for unused stdlib pieces (`__to_num`, `__str_idx`, etc.) the
  biquad doesn't use.
* **AS still doesn't reach hand-WAT (6.5 ms).** A careful wasm-from-source
  compiler pays ~1.4× for not knowing the loop trip count statically.
  Items (3) and (4) above are exactly what closes that final third.
