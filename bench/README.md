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
bench/<case>/<case>.tov     optional Tov baseline
bench/<case>/<case>.goose   optional Goose baseline
bench/<case>/<case>.bend    optional Bend baseline
bench/<case>/<case>.npy.py  optional NumPy baseline
bench/<case>/<case>.wat     optional hand-written WAT baseline
```

The `stdlib-*` cases are a library's own code: `@stdlib/stdlib`'s packages
bundled from their CommonJS sources by `scripts/stdlib-probe.mjs bench <spec>
<case> <kind> <lo> <hi> [lo2 hi2]` (esbuild, scope-hoisted, unminified), the
sweep after the package's own `benchmark/benchmark.js`. `stdlib-special` is a
whole namespace (`bench-all math/base/special stdlib-special`): every package
whose function takes numbers and returns one or a list of them, each swept
over a domain where it is finite, the checksum over every word of every
result. `stdlib-dists` is `stats/base/dists` the same way. A
package jz does not compile yet is named in the case's header (`PENDING` in the
probe), never dropped in silence. Regenerate them there,
never edit them; they take the jzify lowering (`LOWERED_CASES`, `_lib/graph.js`).

Every case prints the same line:

```txt
median_us=<int> checksum=<u32> samples=<int> stages=<int> runs=<int>
```

The orchestrator runs selected cases against selected targets and flags checksum
drift as `DIFF`.

New cases remain `unclassified` until an independently verified checksum is
pinned in `REFERENCE_CHECKSUMS` in `bench.mjs`. A new measurement never replaces
an existing reference checksum. Entity's initial oracle is 1275530752, verified
against native C, Node, JZ, Go-Wasm and Porffor.
Failed measurements retain their reference; an older snapshot that lost it
falls back to the canonical checksum before classifying a recovered result.
The self-compile case (`jz`) is the exception: it checksums the bytes the
compiler under test emits, so its answer moves with every codegen change. Its
oracle is that compiler's source run on the harness's Node, once per run and
apart from the rows it scores (`SOURCE_ORACLE`).

`FMA_CHECKSUMS` accepts independently verified alternate checksums when a backend
fuses floating-point operations. Resample has distinct native Go and Porffor
variants; disabling only FMA restores the strict reference in each control build
(`go build -gcflags=-d=fmahash=n` and `CC='cc -ffp-contract=off' porf native`).
Production benchmark flags remain unchanged.
The same Go control restores the strict checksums for `gainclass` (1297017192),
`slices` (3020911897) and `delayline` (1887209008); their native Go alternates
are 359062747, 3246044915 and 2056124083 respectively. Their Go-Wasm,
TinyGo and Zig-Wasm ports agree exactly with JavaScript.

A case whose `**`, `Math.pow` or `Math.hypot` results differ in their last bits
per engine checks its output with `checksumF64Near` (`_lib/benchlib.js`): each
value hashed at single precision, a relative tolerance of 2^-24. Engines a few
ulp apart agree; a wrong result does not. color-space's kernels are checked so
(munsell, hsl, hwb, jzazbz, jzczhz, cam16, hct, a98rgb, ipt: V8, Deno, bun and
JZ agree on each, where munsell's exact bits gave three checksums), and so are
the three.js cases, whose rotations go through `Math.sin`, `cos` and `acos`
(V8, Deno, bun, jsc and JZ agree on each).

The library cases have C and Rust ports, which the `nat`, `natgcc`, `c-wasm`, `rust`
and `rust-wasm` lanes take: the nine color-space kernels, the four three.js and four
pmndrs/math cases, @stdlib's exp, erf, pow, gamma and ddot, fftplan, provenance and
gainclass. Each ports the library code its case calls as written: a JS function
becomes a C function or a Rust `fn` of its name, an object a struct, a method a
function taking the receiver by pointer (C) or an `impl` method (Rust), an array of
objects an array of structs, a growing array a growable buffer (`realloc` with a
capacity, `Vec`), a Float32Array a `float` array read into double and stored back
rounded. They add no hint the JavaScript lacks: no `restrict`, intrinsics or
attributes in C, no `unsafe`, unchecked indexing or `#[inline]` in Rust.

- color-space: an edge returns its three results as a struct by value (C) or a
  `[f64; 3]` (Rust), one in-place pass per edge as the JS's `convert` makes; munsell
  decodes its renotation table from the JS's own strings before the timed region.
- three.js 0.186.1: a class is a struct (`Matrix4`'s `elements` a `double[16]`,
  column-major), and its module scratch objects (`_v1`, `_m1`, ...) are file-scope
  statics in C and locals or struct fields in Rust.
- pmndrs/math: plain-array vectors and quaternions are fixed arrays (`double[4]`,
  `[f64; 4]`); polytri grows its index arrays, polygons and out-buffers element by
  element as the JS does, and C frees per call what the JS drops.
- @stdlib: each function the case reaches, under stdlib's own C names in C, its
  float64 word accessors `memcpy` (C) and `to_bits`/`from_bits` (Rust), every branch
  kept, the ones the sweep never takes too (gamma's reflection brings in sin and its
  argument reduction). The results are hashed exactly, and the ports agree with the
  JavaScript bit for bit, every word of every result, beyond the sweep's inputs as
  well. ddot is the strided ndarray kernel with stdlib's five-way unroll.
- fftplan's plan cache is a list searched by size in C and a `HashMap<usize,
  Rc<Plan>>` in Rust, each behind the JS's last-plan memo; provenance keeps its four
  provenances of one table four distinct paths.

The C ports of the `checksumF64Near` cases use `checksum_f64_near` (`_lib/bench.h`).
The native C lanes link `-lm`: on Linux libm is a library of its own, and without it
raytrace's `sqrt` and upfirdn's `fmod` failed to link there.

A local measurement of the ports (2026-11-03, Apple M4 Max, load average 13 to 27
from other work; `node bench/bench.mjs --cases=… --targets=jz,nat,c-wasm,rust,rust-wasm
--paired=2`) is not reference evidence. `JZ ÷ fastest wasm` is the median of the paired
rounds' ratios of JZ's time to the faster wasm port's (above 1, a port leads).

| case | JZ | C → wasm | Rust → wasm | JZ ÷ fastest wasm | native C | native Rust |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `hsl` | 6.15 ms | 25.1 ms | 40.9 ms | 0.24 | 6.53 ms | 4.76 ms |
| `hwb` | 6.60 ms | 23.2 ms | 25.6 ms | 0.29 | 6.06 ms | 5.77 ms |
| `a98rgb` | 12.4 ms | 22.9 ms | 22.8 ms | 0.63 | 14.8 ms | 13.8 ms |
| `ipt` | 13.5 ms | 18.5 ms | 18.5 ms | 0.76 | 12.3 ms | 11.3 ms |
| `jzazbz` | 11.0 ms | 22.8 ms | 20.5 ms | 0.55 | 13.0 ms | 13.2 ms |
| `jzczhz` | 9.85 ms | 20.8 ms | 19.5 ms | 0.51 | 13.7 ms | 13.6 ms |
| `cam16` | 7.85 ms | 15.4 ms | 13.9 ms | 0.59 | 11.8 ms | 11.8 ms |
| `hct` | 12.8 ms | 17.5 ms | 14.8 ms | 0.89 | 12.1 ms | 12.2 ms |
| `munsell` | 16.3 ms | 11.5 ms | 11.6 ms | 1.48 | 2.28 ms | 9.65 ms |
| `threeanim` | 14.3 ms | 16.7 ms | 12.9 ms | 1.11 | 10.4 ms | 10.0 ms |
| `threescene` | 3.77 ms | 2.29 ms | 2.40 ms | 1.65 | 1.75 ms | 1.87 ms |
| `threecull` | 5.41 ms | 4.95 ms | 5.38 ms | 1.13 | 4.79 ms | 5.30 ms |
| `threegeom` | 4.20 ms | 3.02 ms | 3.17 ms | 1.42 | 2.77 ms | 2.79 ms |
| `quatmul` | 44 µs | 27 µs | 33 µs | 1.63 | 26 µs | 15 µs |
| `worley` | 731 µs | 615 µs | 491 µs | 1.51 | 420 µs | 405 µs |
| `polytri` | 1.11 ms | 509 µs | 562 µs | 2.23 | 483 µs | 467 µs |
| `fabrik` | 108 µs | 32 µs | 30 µs | 3.72 | 24 µs | 23 µs |
| `stdlib-exp` | 7.20 ms | 7.20 ms | 7.73 ms | 1.03 | 6.57 ms | 5.13 ms |
| `stdlib-erf` | 4.89 ms | 4.21 ms | 4.30 ms | 1.18 | 2.53 ms | 2.91 ms |
| `stdlib-pow` | 33.9 ms | 25.4 ms | 25.2 ms | 1.41 | 23.3 ms | 22.8 ms |
| `stdlib-gamma` | 52.6 ms | 40.0 ms | 40.7 ms | 1.32 | 37.2 ms | 36.6 ms |
| `stdlib-ddot` | 519 µs | 3.35 ms | 1.45 ms | 0.36 | 752 µs | 620 µs |
| `fftplan` | 1.41 ms | 1.91 ms | 2.30 ms | 0.74 | 1.31 ms | 1.34 ms |
| `provenance` | 1.29 ms | 1.54 ms | 2.06 ms | 0.85 | 1.12 ms | 1.36 ms |
| `gainclass` | 88 µs | 116 µs | 676 µs | 0.76 | 81 µs | 85 µs |

JZ leads both wasm ports on eight of the nine color-space kernels, stdlib-ddot,
fftplan, provenance and gainclass, ties stdlib-exp, and trails on munsell, the three.js
and pmndrs/math cases and @stdlib's erf, pow and gamma. These are gaps to close, not
claims: the wasm class's gates (`test/bench.js`, `test/bench-claims.js`) report each one
red until JZ leads (`test/bench-claims.js` holds polytri, fabrik and stdlib-exp as
`PENDING_CASES`). Two port rows run V8's baseline code for their timed loop, since V8
replaces a wasm function's code only between calls: in direct runs, Rust → wasm on hsl
takes 25.3 ms under `--no-liftoff` against 42.0 ms by default, and C → wasm on
stdlib-ddot 0.89 ms against 3.12 ms. The lanes run V8's defaults for every producer,
JZ included. C → wasm on hsl is as slow under `--no-liftoff` (26.6 ms against 25.1 ms),
so its gap to native C has another cause.

## Run

### CI

Push and pull-request runs of the `bench` workflow are gates: checksums, sizes and
compilation, with timing informational. They publish nothing.

Scheduled and dispatched runs measure every lane of every case. No GitHub-hosted
job can do that within its 6-hour limit, so the corpus is split by case across
jobs (`bench/shards.mjs plan`), sized from each case's wall time in the last
sharded run of the same kind (`cases[].wallMs`; [shard-costs.json](shard-costs.json)
seeds a case none has timed) to about two hours a job. A case runs whole on one
machine, so every ratio within a case is same-machine; the publish job merges the
shards (`bench/shards.mjs merge`) into one dataset that records each case's machine
(`cases[id].host`) and each job's machine, date and state (`meta.shards`), with
`meta.host` only when a single CPU model measured everything. The merge refuses a
missing or repeated case and any shard whose commit, toolchain versions or memory
method differ from the others'; the plan pins every floating toolchain build the
merge compares (Node, Deno, Bun, the JavaScriptCore build, AssemblyScript), so a
shard measured again hours later still merges.

The self-compile case `jz` runs on a runner of its own (`ALONE`): it builds the
compiler twice in an 8 GB heap and hands its 6.9 MB bundle to every compiler of
JavaScript, and a runner lost there once took fifteen other cases' evidence with it
(run 41508597936). A compiler of the case's own JavaScript (Static Hermes, Porffor,
Perry, scriptc, TypeScriptCompiler, js2wasm, the two componentizers) builds within a
time limit that ends its whole process group (`JZ_BENCH_BUILD_LIMIT_S`, 600 s unless
the lane sets its own). A shard runs its bench in a memory cgroup of its own, 3 GiB
short of the machine's memory and outside the runner's systemd service, whose
default `OOMPolicy=stop` ends the service, the runner with it, once the OOM killer
takes any process of it: run 41656880970 lost the self-compile shard so twice, 44 s
into Perry's build, which holds 13 GB of the runner's 16. A lane that outgrows the
cgroup is killed there and is a failed row (`out of memory: killed by the kernel
after … at the … GiB limit`), not a lost runner. Swap is off, so a lane at the limit
fails rather than thrashes, and the bench runs in a session of its own. Its
`memory.log` keeps the machine's memory, disk and largest processes every 30 s,
and the cgroup's limit, peak and OOM kills.

A shard job that fails anyway costs the run its publication, never the other
shards' evidence: `bench-retry.yml` reruns the run's failed jobs once by itself, and
`gh run rerun <run> --failed` does it by hand. The rerun measures the failed shards
again on fresh runners and the publish job merges them with the shards that
succeeded, read from the run's artifacts across attempts.

- The weekly schedule (or a dispatch with `reference=false`) times every lane once
  and commits `bench/results-ci.json`, the [CI runner view](https://jz.js.org/bench/?machine=ci).
- A dispatch with `reference=true` runs the claim lanes (`bench/shards.mjs`
  `CLAIM_LANES`: jz, the wasm producers, Porffor, the V8 and JSC engines, jz-w2c) in
  six alternating paired rounds and every other lane once, then applies the strict
  speed, size, coverage, freshness, native-lowering and allocation-heavy RSS gates.
  When every claim holds, it commits `bench/results.json` with the chart
  (`bench/bench.svg`) and this file's tables redrawn from it. When one fails, the
  run fails with the failing claims and commits nothing.
- A dispatch with `cases=…` is a probe: measured, merged, uploaded as `probe.json`,
  never published.

Every measurement run uploads its evidence (`reference-<commit>`, `ci-<commit>` or
`probe-<commit>`, plus each job's `bench-shard-<n>` dataset and log), whether or not
it published. `scripts/bench-publish.mjs` commits from the latest main and says in
the job summary what it did: published, unchanged, or not published because main
already holds a later commit's evidence. A completed measurement is not a passing
release verdict.

```sh
gh workflow run bench.yml -f reference=true      # release evidence → bench/results.json
gh workflow run bench.yml -f reference=false     # CI runner view → bench/results-ci.json
gh workflow run bench.yml -f cases=vm,crc32      # probe, paired, never published
```

To check the downloaded artifact locally:

```sh
JZ_BENCH_RESULTS=/path/to/reference.json npm run test:claims
```

The source checkout and installed dependencies must match the measured commit.
RSS uses the same snapshot; `JZ_MEMORY_RESULTS` can name a separate complete run.
Ordinary push/PR benchmark runs keep their informational timing policy.

```sh
npm run bench
node bench/bench.mjs --targets=nat,rust,go,numpy,v8,jz
node bench/bench.mjs --targets=jz --cases=biquad,mat4,poly,bitwise
node bench/bench.mjs --targets=v8,deno,bun,spidermonkey,graaljs
node bench/bench.mjs --cases=biquad,fft,synth,bytebeat,blur
node bench/bench.mjs biquad
node bench/bench.mjs mat4 --targets=nat,v8,jz
```

### Refreshing `results.json`

`--json[=path]` (default `bench/results.json`) rewrites the WHOLE file — fine
for a full corpus run, a hazard for a targeted one: a `--cases=`/`--targets=`
run against an existing file silently drops every row it didn't just measure.

For a targeted refresh, use `--merge`: only the selected `(case,target)` rows
are updated in place, every other row is byte-preserved, and each touched row
gains `measuredAt: <short-sha>` provenance. Mixing vintages this way sets
`meta.partial: true`. Claims freshness is checked from every JZ row's
`measuredAt`, not the merge write's `meta.commit`; a rival-only refresh cannot
launder carried JZ timings into apparently fresh evidence.

A partial refresh trusts the untouched rival rows without re-measuring them —
`--verify-anchors[=N]` (default 3) is the check that trust is still earned: it
re-measures a small fixed set of rival rows and compares fresh vs stored
`medianUs`. Within 10% → `meta.anchors.pass: true`, the stored evidence is
still machine-state-valid. Past that → nonzero exit and a drift report: time
for a full recontest, not a partial one. `test/bench-claims.js` requires
`meta.anchors.pass` whenever `meta.partial` is set — a partial dataset
without a passing anchor check doesn't ship.

The writer enforces this structurally, not just at read time (audit-#13
hygiene item 2a): a `--merge` that would leave `meta.partial: true` with no
anchors verdict backing it — no `--verify-anchors` this run, and no carried
prior `pass: true` from the file being merged into — REFUSES the write
outright (nonzero exit, file untouched), same as the shrink-guard above. A
`--verify-anchors` DRIFT counts as "no verdict backing it" too: a confirmed-
bad machine state means even the row this run just measured is unconfirmed,
not only the untouched rival rows. `--allow-unanchored` is the explicit
escape hatch for a deliberate unverified write.

Every `--json`/`--merge` write also captures `meta.machineState`
(`swapUsedMB`/`uptimeDays`/`load1`/`powermode`, best-effort per-platform) —
the WARM/MEMORY-FLOOR campaign (`.work/archive/todo.md` "WARM + MEMORY-FLOOR"
status) found heavy swap alone explains multi-percent timing drift with zero
code change; `test/bench-claims.js`'s VALIDITY gate checks it against a sane
bound.

```sh
# fast refresh: jz + jz-w2c only, full corpus, ~10-15 min instead of hours
node bench/bench.mjs --targets=jz,jz-w2c --json --merge --verify-anchors
```

A claim is decided per case by the best rival of each class, so a verdict needs
only the lanes that could lead. `--contenders[=N]` (default 2) measures, per
case, jz plus the N fastest rivals of each claim class by the stored evidence
(wasm producers, V8-family engines, bun/jsc; `bench/claims.mjs contenders`) and
Porffor; the rest keep their stored rows under `--merge`, or are simply absent
from a fresh `--json` file. A case with no stored evidence measures every
selected lane, so a new case is ranked in full once. The gate then counts
coverage by claim class rather than by lane (`meta.contenders`). This is the
protocol to run by hand, a third of a full run; CI's reference measures every lane
instead (see CI above):

```sh
# release verdict: jz + the two nearest rivals per class, paired, ~1/3 of a full run
node bench/bench.mjs --contenders --paired=6 --json=/tmp/reference.json
JZ_BENCH_RESULTS=/tmp/reference.json node test/bench-claims.js
```

Rival prep artifacts are cached only while the case source, generated flat
input, `bench.mjs`, and `bench/_lib/` are unchanged. Porffor also stamps its
exact git HEAD; dirty checkouts bypass the cache. `JZ_BENCH_REBUILD=1` forces
all prep steps to run.

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
| [`stringify`](stringify/stringify.js) | `JSON.stringify` of 1024 order records (nested objects and arrays, strings with escapes and non-ASCII text, integers past 2^32, decimal fractions, exponent-notation rates), one NDJSON line each and a pretty-printed dump of every 16th: the writer side of every server and logger |
| [`jsontransform`](jsontransform/jsontransform.js) | an API gateway's round trip: `JSON.parse` of a 1024-order document built at run time, a total, filter and tag count over the generic objects, `JSON.stringify` of the response |
| [`jsonroundtrip`](jsonroundtrip/jsonroundtrip.js) | [Perry](https://github.com/PerryTS/perry/tree/main/benchmarks/suite)'s JSON round trip: `JSON.parse` of a 1 MB array of 10,000 records (an integer id, a name, a float value, two tags, a nested `{x, y}`) and `JSON.stringify` of the parsed value, nothing between; the text comes back byte for byte, its 9,999 floats written back in Number::toString's shortest digits |
| [`sort`](sort/sort.js) | in-place heapsort over a typed array; exposes call-heavy nested loops and typed-array index propagation |
| [`crc32`](crc32/crc32.js) | table-driven CRC-32 over a mutable byte buffer; exposes integer narrowing and typed-array parameter propagation |
| [`dotprod`](dotprod/dotprod.js) | multiply-accumulate reduction; JZ reassociates to 4 SIMD accumulators, beating strict-fp serial native |
| [`bytebeat`](bytebeat/bytebeat.js) | classic integer "bytebeat" one-line-song synthesis to 8-bit PCM; pure i32, bit-exact everywhere |
| [`fft`](fft/fft.js) | radix-2 Cooley–Tukey FFT over a transcendental-free twiddle table; the canonical numeric/audio kernel |
| [`fftplan`](fftplan/fftplan.js) | the same butterflies through a Map-cached plan object — how every JS DSP lib ships FFT; exposes typed-array kind loss through return values / object fields / params (dynamic element access in the hot loop) |
| [`provenance`](provenance/provenance.js) | one butterfly kernel over bit-identical tables that differ only in provenance — direct return, returned-object field, Map-cached field, module-global memo; per-edge coverage for the `fftplan` kind-loss class |
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
| [`mapstr`](mapstr/mapstr.js) | sessionizing a request log with string-keyed `Map`s: route counts, sessions opened and swept closed, rate-limit bans checked and lifted (`get`, `set`, `has`, `delete`, deletion while iterating) on keys that arrive as fresh strings |
| [`mapint`](mapint/mapint.js) | graph search over sparse 30-bit ids with integer-keyed `Map`s: adjacency lists, a degree histogram, breadth-first distance maps from four sources |
| [`mapobj`](mapobj/mapobj.js) | a bundler's pass over a module graph with object-keyed `Map`s: in-degrees, reverse edges, topological order and depths, a deep copy through a memo `Map` that keeps shared modules shared and a `Set` of distinct copies |
| [`setops`](setops/setops.js) | near-duplicate documents with `Set`s: stop words removed by membership, a vocabulary union, Jaccard similarity from probed intersections, set differences by copy and delete |
| [`arraynumeric`](arraynumeric/arraynumeric.js) | [Perry](https://github.com/PerryTS/perry/tree/main/benchmarks/suite)'s numeric array: 250,000 integers pushed into a plain array, then 25 passes of `arr[i] = arr[i] + 1`; an array that stays numeric, whose elements a compiler can hold unboxed: the positive control of `arraydowngrade` |
| [`arraydowngrade`](arraydowngrade/arraydowngrade.js) | [Perry](https://github.com/PerryTS/perry/tree/main/benchmarks/suite)'s array downgrade: the `arraynumeric` array with an object and a string stored mid-array, then the same passes over its numeric slots on both sides of them; a JIT drops the array to generic elements, a static compiler sees one array of mixed values, and every `+` stays JS's `+` |
| [`immutable`](immutable/immutable.js) | integer particle step in the immutable-update idiom — every step replaces each record with a fresh `{x,y,vx,vy}` (React/Redux-style state); value-semantics natives get it free, a JIT leans on young-gen GC + escape analysis, jz pays a bump allocation per object — the escape-analysis/SROA probe |
| [`async`](async/async.js) | async request handlers: each awaits a user lookup (an inactive user throws into the handler's `catch`), the user's orders, a price per line and a coupon; batches served with `Promise.all`, a tail served one `await` at a time. Every stage settles at once, so the time is the promise machinery |
| [`colorconv`](colorconv/colorconv.js) | sRGB → Oklab over an image buffer — EOTF pow → 3×3 → cbrt → 3×3; probe for pow/cbrt intrinsic quality |
| [`colorlch`](colorlch/colorlch.js) | sRGB → OkLCh fused in one loop (pow → 3×3 → cbrt → 3×3 → sqrt + atan2); the fused body must never lose to the split loops |
| [`colorlog`](colorlog/colorlog.js) | ARRI LogC4 → XYZ — runtime-base exp2 decode + 3×3; probe for runtime-exponent pow/exp2 |
| [`colorpq`](colorpq/colorpq.js) | sRGB → JzAzBz — 3×3 → ST 2084 PQ (≈12 signed-pow) → 3×3; probe for signed pow with non-constant exponent |
| [`watr`](watr/watr.js) | watr's WAT-to-wasm compiler on a small WAT corpus; compares jz-compiled compiler code with raw V8 |
| [`jessie`](jessie/jessie.js) | the subscript/jessie JS parser over a realistic source corpus; branch-, allocation- and recursion-heavy front-end work |
| [`jz`](jz/jz.js) | the JZ compiler itself (scripts/self.js pipeline) compiling three small programs at L2 — the self-compile row runs jz.wasm compiling JavaScript; output bytes are checksummed so the parity gate doubles as a determinism proof |
| [`webaudio`](webaudio/webaudio.js) | one second of stereo audio rendered offline through the [web-audio-api](https://github.com/audiojs/web-audio-api) engine (the whole library, ~120 modules: nodes, AudioParam automation, oscillator wavetables, biquad DSP) — a sawtooth with an LFO on its frequency → lowpass → ramped gain → panner; the library jz is developed against, so its render is the flagship's speed against V8 in the table. The checksum is the output as 16-bit PCM: a host whose `Math.sin`/`cos`/`exp` are off by more than an ulp does not match it |
| [`slices`](slices/slices.js) | block processing over runtime sub-views of one arena (`a[off+i]`, off from a schedule) — the audio-bus / font-table access class; guards base hoisting |
| [`trace`](trace/trace.js) | square-tracing contour following over a bitmap — bitmap→vector stage one; data-dependent state machine, unpredictable branches, 2-D indexing |
| [`bezfit`](bezfit/bezfit.js) | least-squares cubic Bézier fitting (Schneider) with one Newton reparameterization — font autotracing's core; small hot loops, ÷ and √ only |
| [`sdf`](sdf/sdf.js) | exact Euclidean distance transform (Felzenszwalb) of a glyph-like bitmap — SDF text pipeline; parabola-hull scratch loops with data-dependent pops |
| [`resample`](resample/resample.js) | fractional-rate audio resampling, 4-point Hermite — float-derived gather indices + fractional phase accumulator |
| [`delayline`](delayline/delayline.js) | modulated feedback comb through a power-of-two ring — wrap-masked indexing, genuine loop-carried feedback, q16 fraction splits |
| [`glyfparse`](glyfparse/glyfparse.js) | TrueType `glyf`-style flag/coordinate decoding — variable-length byte grammar, bit tests, running accumulators |
| [`deltae`](deltae/deltae.js) | CIEDE2000 over Lab pairs — branchy transcendental colorimetry (per-libm checksums, like the other colorjs probes) |
| [`polytri`](polytri/polytri.js) | ear-clipping triangulation + convex decomposition of flat plain-array polygons ([pmndrs/math](_lib/pmath/README.md), unmodified) — index arrays built per call, out-buffers written past their length, polygon copies pushed element by element: the runtime-built-array kernel |
| [`worley`](worley/worley.js) | Worley (cellular) noise field, 2-D + 3-D (pmndrs/math) — `perm[Math.floor(x) + g & 255]` byte-table gathers through a `{ perm }` record, 9 + 27 feature distances per sample, a running minimum: the hash-noise kernel |
| [`fabrik`](fabrik/fabrik.js) | FABRIK inverse kinematics, ten bones (pmndrs/math) — forward/backward passes over an array of bone objects holding `start`/`end` arrays and a `joint` record, directions normalized into module scratch arrays, the best solution saved and restored: the object-graph kernel |
| [`quatmul`](quatmul/quatmul.js) | quaternion products, inverses and normalizations over arrays of four-element plain arrays (pmndrs/math) — one out-parameter, pointer chasing between the elements: the fixed-size linear-algebra kernel |
| [`threescene`](threescene/threescene.js) | Object3D.updateMatrixWorld over ten thousand chained nodes ([three.js](https://threejs.org)'s math classes, unmodified, from `node_modules`) – `Matrix4.compose` from a Vector3, a Quaternion and a Vector3 held in arrays of class instances, `multiplyMatrices` by the parent's world matrix, `elements` arrays of sixteen: the scene-graph kernel |
| [`threeanim`](threeanim/threeanim.js) | QuaternionLinearInterpolant's slerp of ten thousand bones (three.js) – the static `Quaternion.slerpFlat` over flat Float32Array keyframe buffers at an offset, an acos and three sines per bone: the animation-mixer kernel |
| [`threecull`](threecull/threecull.js) | WebGLRenderer.projectObject's frustum test of ten thousand bounding spheres as the camera orbits, and Mesh.raycast against twenty thousand triangles (three.js) – `lookAt`, `invert`, a Frustum's planes, `intersectsSphere`, `intersectTriangle` through Vector3 scratch: the culling and picking kernel |
| [`threegeom`](threegeom/threegeom.js) | BufferAttribute.applyMatrix4, computeBoundingBox/Sphere and computeVertexNormals over Float32Array position buffers (three.js) – each vertex read into a module-level Vector3, chained methods, written back: the buffer-geometry kernel |

Every case enters every aggregate: the geomean chart, the page's geomeans and
coverage, the aggregate table below and the landing's figures. That includes the
compiler workloads (`watr`, `jessie`, the `jz` self-compile) and the colorjs
intrinsic probes (`colorconv`, `colorlch`, `colorlog`, `colorpq`, `deltae`), which
were once set apart as `lab` rows. A row counts where its checksum is accepted:
the probes hash their exact transcendental bits, which differ by libm. In the CI
dataset no lane matches their stored checksums; in the reference dataset JZ matches
three of them and the JS engines the other two. They add few pairs to any ratio until
they are checked at single precision as the color-space cases are (`checksumF64Near`)
and their references re-pinned. The claims gate still passes over all eight when it
requires a correct JZ timing per case (`PARITY_EXEMPT` in `claims.mjs`).

The bench page plays every case in the visitor's browser but the self-compile, whose
wasm is the compiler itself (`NO_WEB` in `assets/headline.js`). A case with a module
graph (`WEB_BUNDLED`: watr, jessie, webaudio, the pmndrs/math and three.js cases)
plays its JS row from `bench/web/<case>.js`, its source bundled to one module by
`--emit-web` (the site serves no `node_modules`, and one rule covers every graph); its
wasm is built from the same graph, webaudio's host adapters stubbed as in its
standalone build.

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
number. QuickJS-NG's WASI build (`qjs-wasi`), componentize-qjs and
ComponentizeJS (StarlingMonkey) are fenced the same way. The Wasm field compares JZ with Rust, Go, C, Zig, AssemblyScript, and
MoonBit on the same target, plus the JS JITs JZ replaces. Porffor has no Wasm
target in its current alpha line; its native artifact is a separate hard speed
and size floor. Native C is the speed-of-light reference.

Coverage includes failures. A present target that cannot compile or run a case
records `{ status: 'fail', reason }` in `results.json`. The page shows a muted
row with the reason and includes the attempt in its coverage count. Geomeans use
only cases that completed with an accepted checksum.

The corpus groups competitors by runtime, with sortable speed, memory and size
columns. Missing measurements remain visible as dashes.

The per-case view is one speed-sorted list. Substrate glyphs distinguish
Wasm, JavaScript, and native rows. Wrong or unclassified results keep their
measurements but receive no relative bar.

JZ compiles and self-compiles through **watr**; WABT is not a package or compiler
dependency. The native comparison uses WABT's `wasm2c`: `jz-w2c` lowers JZ Wasm
to C, then runs `clang -O3`. CI installs WABT to check that comparison.
The `jz-w2c` build uses `--no-tail-call` because wasm2c rejects `return_call` combined with
multi-value results. `jz-wasmtime` keeps tail calls. A second translator,
`jz-w2c2`, remains a CI smoke check rather than a published row because w2c2
supports neither SIMD nor multi-value returns. Both translators check recursive
and string kernels; WABT additionally checks the multi-value tokenizer kernel.
`jz-w2c` builds through `scripts/native/compile.mjs`, the generic native path,
which accepts source and installed WABT layouts; the w2c2 adapter reads w2c2's
generated header to match its symbol naming. CI pins the tested w2c2 revision.
A case whose host build replaces modules (webaudio's device and codec adapters,
its worklet stub; `OWN_GRAPH` in `_lib/graph.js`) builds its standalone wasm
from that same graph (`compileJzWasi`), each adapter a module that throws,
rather than through the CLI, which would compile the real adapters.

### Parity classes

The `parity` column is `ok` when the run's checksum matches the case reference,
`DIFF` when it diverges in a way that suggests a bug, and `fma` when the
checksum matches the documented FMA-fusion alternate for that case.
Native backends can fuse `a*b + c`, which changes bit-level rounding on
recurrence-style loops such as `biquad` and `synth`. The `fma` label is accepted
only when the checksum matches the pinned alternate for that case.

## The guarantee

The suite's claim is precise and falsifiable: **for every kernel class arising in
JZ's target domains, jz emits the fastest wasm in the field** — per case, against
every rival compiled to the same substrate (C/Rust/Go/Zig → wasm32-wasi and
AssemblyScript, all run in V8), enforced by `test/bench.js`. Porffor's native
artifact is a separate per-case and geomean speed-and-size floor. The `-Os`
build carries the size claim. JZ holds a par-or-smaller geomean band (≤1.05× vs
AssemblyScript) because AS's bench ports assume unchecked array access
(`unchecked()` throughout) while jz pays real guards for JS's out-of-bounds
read/write semantics. Native C stays a labeled ceiling, never a beat-claim.

Per case the gate distinguishes three verdicts, printed with every run:
**strict** (ratio < 1.00 — jz genuinely fastest), **band** (≤ 1.05 — inside
microbench jitter, tolerated but never called a lead), **red** (> 1.05 — a
rival leads; fails the gate). A "band" row is a statistical tie, not a win.

### Named exceptions

One table, `CLAIM_EXCEPTIONS` in `bench/claims.mjs`, names every case a
claim class (`wasm`, `v8`, `jsc`) holds to a band instead of leadership. Each
entry carries the case, the class, the band (jz over the class's fastest
rival, by the reference medians), the measured cause in one line and where it
was measured. Measurement earns an entry, never a deadline: the case's code
shown optimal against that class, or the same code leading on some CPUs and
trailing on others. An excepted case leaves its class's strict and band tests
and answers to its band in `test/bench-claims.js`; past the band the gate
fails. Every exception is a tripwire, not a claim, and goes the commit jz leads
on every runner. The table today: `vm` against the wasm class at 1.12×
(identical `run_kernel` code: 0.75× on an EPYC 9V74, 0.76× on an Apple M4,
1.07× on an EPYC 7763, 1.10× on an EPYC 9V45), and `vm`, `dict` and `crc32`
against bun/JSC at 1.5×. Any other gap stays red until fixed, unless the owner
accepts it for a release as an `open` entry, a target with its cause named. The
open entries today are the dynamic programs, where the JIT speculates on the
shapes and kinds each site has seen and jz's wasm carries only what it proves:
`watr` at 1.45×, `jessie` at 1.2× and the `jz` self-compile case at 1.35×,
each against bun/JSC. The V8 family excepts nothing: `watr` and the `jz`
self-compile case trail it, named in `CLAIM_UNMET` with what is measured of
the gap and listed by the gate as todo until jz leads. `watr`'s timed run lasts
about 3 ms on CI, so V8 runs most of it as baseline code before its optimizing
compile lands; optimized, jz runs 0.59× V8's time.
The class `rss` holds `webaudio`'s peak RSS to 1.15× V8's: V8's compiled code
for the speed build's 1.19 MB of wasm outweighs jz's 4.5 MB heap. The class
`size` holds `arraydowngrade`'s size build to 5× AssemblyScript's (4.93× measured
against `asc -Oz` here, 4.83× against CI's): the AS port is a closed tagged union
that appends the literal `'[object Object]1'` and reads NaN where JS concatenates,
so it carries none of the number formatting and string-to-number conversion jz keeps
until it proves which slots hold the object and the string.

Performance evidence describes the machines recorded in its metadata: `meta.host`
for a one-machine run, each case's `host` for a sharded CI run. The weekly CI run
publishes its measurements as `bench/results-ci.json`, visible in the
[CI runner view](https://jz.js.org/bench/?machine=ci). Gate runs' timing checks are
informational; checksums, sizes, coverage and compilation are hard gates. A
benchmark run that publishes triggers a Pages deployment of that snapshot.

A manual `reference=true` run applies the strict release claims on CI as well,
and commits its dataset, machine metadata included, only when every claim passes
for the measured compiler. A failed run remains a list of gaps to fix; neither the
host change nor the artifact upload waives a cap.

The scope of "every kernel class" is this matrix — each cell names the case that
pins it. A domain need that has no case is a hole in the guarantee, and the fix
is a new case, not a smaller claim:

| kernel class | color science | audio DSP | font / vectorization | generative graphics |
| --- | --- | --- | --- | --- |
| dense float pipelines | `colorconv` `colorlog` `colorpq` | `biquad` `synth` | — | `alpha` `blur` |
| transforms / spectra | — | `fft` `fftplan` | — | `heat` |
| runtime sub-views (base hoisting) | — | `slices` (busses) | `slices` (tables) | — |
| gather by computed index | — | `resample` | — | `noise` |
| ring / wrap indexing | — | `delayline` | — | — |
| loop-carried feedback | — | `biquad` `delayline` | — | `lorenz` |
| state machines / tracing | — | — | `trace` | `mandelbrot` (escape) |
| small-system solves / fitting | — | — | `bezfit` | `raytrace` |
| envelope / hull scratch loops | — | — | `sdf` | — |
| byte grammars / parsing | — | `wav` | `glyfparse` | `qoi` |
| branchy transcendental scalar | `deltae` `colorlch` | — | — | — |
| sort / partition / histogram | — | — | — | `radixsort` `sort` |
| hashing / dictionaries | — | — | `wordcount` (shaping caches) | `dict` `hashjoin` |
| interpreter dispatch | — | `bytebeat` | `vm` (hinting VMs) | `dispatch` |
| matrix / geometry batches | `colorconv` (3×3) | — | `mat4` (transforms) | `matmul` `nbody` `particle` |
| library idioms: state bags, record arrays, ratio parameters, dtype tables | — | `sosfilter` `movavg` `upfirdn` `pcmconvert` | — | — |
| codecs: a library's decoders, bundled unchanged (`scripts/decode-cases.mjs`) | — | `decode-wav` `decode-qoa` `decode-tta` `decode-alac` `decode-dsd` | — | — |

Beyond named cases, the **shape-class fuzzers** guard whole families the cases
sample: `scripts/perf-corpus.mjs` generates seeded programs per class — including
the deopt classes found in production kernels (`slice` runtime-base views, `ring`
wrap-masked taps, `condref` conditional array-ref selection, `fgather`
float-computed gathers) — and `test/perf-ratchet.js` ratchets their loop-body op
counts so a fast path that stops firing reds CI machine-independently, while
`scripts/fuzz-bench.mjs` times the scalar classes against V8.

## Targets

| id | what it measures |
| --- | --- |
| `nat` | clang `-O3` native C baseline, when a matching C workload exists |
| `natgcc` | gcc `-O3`, when real gcc is installed |
| `rust` | Rust `rustc -C opt-level=3 -C target-cpu=native` — native baseline; the headline rival is `rust-wasm` |
| `go` | Go native compiler — native baseline; the headline rival is `go-wasm` |
| `zig` | Zig `build-exe -O ReleaseFast -lc` — native baseline. Zig 0.16, like 0.17, turns off LLVM's loop vectorizer (zig `032319c942`, for [llvm/llvm-project#186922](https://github.com/llvm/llvm-project/issues/186922); on again in zig's master), so its loops stay scalar where clang's vectorize: alpha takes 763 µs on CI's EPYC 9V74 against C's 130, and the same port's IR optimized by clang `-O3` 59. `zig-wasm` is built the same way, with wasm SIMD on (`-mcpu=generic+simd128`), as jz's own output has it; with the loop vectorizer off, Zig's SIMD comes from its library code and its explicit vectors |
| `numpy` | vectorized NumPy, when a matching `.npy.py` exists |
| `v8` | raw JavaScript on Node/V8 |
| `deno` | raw JavaScript on Deno/V8 |
| `bun` | raw JavaScript on Bun/JavaScriptCore |
| `jsc` | raw JavaScript on the standalone JavaScriptCore shell — Safari's engine (`jsc`; install via `jsvu --engines=javascriptcore`, or set `JSC_BIN`) |
| `spidermonkey` | raw JavaScript on SpiderMonkey shell (`spidermonkey`, `sm`, `js128`, `js115`, `js102`, or `js`) |
| `shermes` | Static Hermes `static_h` `c37388f`: JS compiled through C to a native executable linked with the Hermes VM and GC (`shermes -O <case>-flat.js`). The VM is a shared library, which the size column adds. Hermes has no `performance`, so the shim falls back to `Date.now` (millisecond steps, as Javy). Set `SHERMES_BIN` to override. |
| `graaljs` | raw JavaScript on GraalJS |
| `jz` | JZ output with host imports for timing/logging (measures wasm size without WASI console/perf bloat) |
| `as` | AssemblyScript `asc -O3 --runtime stub`, when a matching `.as.ts` exists |
| `rust-wasm` | Rust → `wasm32-wasip1` with wasm SIMD on, as jz's own output has it (`rustc --target wasm32-wasip1 -C opt-level=3 -C target-feature=+simd128`), run in node's V8 — the apples-to-apples Rust rival |
| `go-wasm` | Go → `wasm32-wasip1` (`GOOS=wasip1 GOARCH=wasm go build`), run in node's V8 |
| `c-wasm` | C → `wasm32-wasi` via clang/LLVM with wasm SIMD on, as jz's own output has it (`zig cc -target wasm32-wasi -msimd128 -O3` — zig supplies the wasi-libc that plain clang lacks; no emcc/wasi-sdk install), run in node's V8 |
| `jz-wasmtime` | JZ output on wasmtime |
| `jz-w2c` | JZ Wasm translated by wabt `wasm2c`, then clang `-O3`; built with `--no-tail-call` as described above |
| `jz-w2c2` | JZ wasm translated by `w2c2` (turbolent/w2c2), then clang `-O3` — a second translator on the same wasm input, CI-smoke only; unsupported SIMD and multi-value cases record build failures. Set `W2C2_DIR`/`W2C2_BIN` if not built at `../w2c2` next to this repo |
| `wat` | hand-written WAT baseline when a case provides `run-wat.mjs` |
| `porf-native` | Porffor's release binary (`curl -fsSL https://porffor.dev/install.sh \| sh`, alpha 19 (`0c135ce`, 2026-10-21); a git checkout of the same line or `PORF_BIN` otherwise), compiled through its C backend: `porf native <case>-porf-flat.js -o <bin>`. The lane measures the standalone native artifact. Its flat source uses Porffor's high-resolution `performance`; the generic shell shim would be shadowed by alpha 3's global-var lowering and fall back to millisecond `Date.now`. The engine-style `porf <file>` mode includes compilation in the measurement and produces no artifact, so it has no lane. |
| `scriptc` | [scriptc](https://github.com/vercel-labs/scriptc) 0.4.6: JS/TS compiled through the TypeScript checker and LLVM to a native executable with its static runtime, no embedded engine. `scriptc build <case>-native-flat.js -o <bin>` uses default release optimization and native `performance.now()`. No annotations are added, so untyped values compile to its dynamic tier (native code that checks types at run time). Set `SCRIPTC_BIN` to override. |
| `tslang` | [TypeScriptCompiler](https://github.com/ASDAlexander77/TypeScriptCompiler) pre-alpha113: LLVM/MLIR native output with its default library and Boehm GC. The unchanged flattened JS is saved as `.ts`; a C `clock_gettime(CLOCK_MONOTONIC)` binding supplies `performance.now()`. `tslang --emit=exe --opt --opt_level=3 --relocation-model=pic --obj=tslang-clock.o <case>.ts -o <bin>`. Set `TSLANG_BIN` to override. |
| `perry` | [Perry](https://perryts.com/): JS/TS compiled through LLVM to a native executable with its runtime and GC. `perry compile <case>-native-flat.js -o <bin> --fp-contract off`, then run the binary. Uses the unchanged JS kernels, native `performance.now()`, default optimization and host CPU tuning; no type annotations, fast-math, or V8 fallback. Set `PERRY_BIN` to override. |
| `jawsm` | jawsm (JS → WasmGC) when installed |
| `javy` | Javy (`javy compile`, JS in embedded QuickJS) when installed; fenced interpreter reference, never in the headline geomean |
| `qjs-wasi` | [QuickJS-NG](https://github.com/quickjs-ng/quickjs) 0.17.0's WASI build (the release's `qjs-wasi.wasm`), run under node's WASI with the case's directory preopened: the interpreter reads `<case>-flat.js` at run time. The size column is the engine module. Set `QJS_WASI` to the `.wasm`. Fenced like Javy |
| `componentize-qjs` | [componentize-qjs](https://github.com/andreiltd/componentize-qjs) 0.5.0: QuickJS embedded in a WebAssembly component, initialized by Wizer at build time, run by `wasmtime run`. The flat script stores its entry instead of calling it (Wizer would run the benchmark at build time) and exports it as `wasi:cli/run` (`_lib/bench.wit`); this QuickJS has no `console` or `performance`, so `_lib/qjs-host.js` binds them to WASI stdout and the monotonic clock. `--sync` embeds the runtime without component-model async. Fenced like Javy |
| `componentize-js` | [ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS) 0.23.0 through `jco componentize` (jco 1.40.0): StarlingMonkey (SpiderMonkey) embedded in a component, the same deferred entry and world, its own console and clocks; `--disable http fetch-event` drops the `wasi:http` imports a command never uses. Default build: `--aot` (weval) ran mandelbrot slower here, 735 ms against 351 ms. Fenced like Javy |
| `js2wasm` | [js2wasm](https://github.com/loopdive/js2) 0.71.0 (`@loopdive/js2`): JS compiled ahead of time to WasmGC, no engine inside. `js2wasm <case>-flat.js --target node` (wasm-opt where binaryen ^132 is installed), run in node through its generated imports helper, which supplies `console` and `performance`. Set `JS2WASM_BIN` to override |
| `tinygo` | TinyGo → `wasm32-wasip1` (`tinygo build -target=wasip1 -opt=2`) — the Go corpus through LLVM, leaner wasm than `go-wasm`; run in node's V8 |
| `moonbit` | MoonBit → `wasm` (`moon build --target wasm --release`), run on `moonrun` (MoonBit's V8 wasm runner, which supplies the monotonic clock) — a wasm-first-language rival, when `moon`/`moonrun` are installed |
| `tov` | [Tov](https://github.com/richiemcilroy/Tov): a TypeScript-shaped language compiled through C to a native binary. `tov build <case>.tov -o <bin>` at its default (`-O3`, checked integer overflow), when a matching `.tov` port exists. A ported language like `rust` or `as`, not a JS host: it rejects the unchanged corpus (untyped parameters, no typed arrays, no `Math.imul`). Set `TOV_BIN` to override. |
| `goose` | [Goose](https://github.com/aardappel/goose), Wouter van Oortmerssen's memory-safe systems language with no heap, compiled to one C file and built natively. `goose build <case>.goose -o <bin>` at its release defaults (`-O2` inlining; the emitted C compiled at `-O2` by the first C compiler it finds, which the run records), when a matching `.goose` port exists. A ported language like `tov` or `rust`. Set `GOOSE_BIN` to override. |
| `bend` | [Bend](https://github.com/bendlang/bend) 2, Victor Taelin and the Higher Order Company's typed, pure, affine language with proofs, compiled to one C file and built natively. `bend <case>.bend -o <bin>` at its release default (the emitted C compiled by `clang -std=c11 -O3`, with the first clang 14 or newer it finds, which the run records), run as `<bin> +RTS --threads 1 --gpu off -RTS`: one core and no GPU, the flags of Bend's own SEQ-CPU measurements. When a matching `.bend` port exists. A ported language like `goose`. Set `BEND_BIN` to override. |

The wasm rivals run with wasm SIMD wherever their toolchain can use it, as jz's own output does: C, Rust and Zig build with `simd128` on (2026-11-03; before, they built for the default target, which has none, so their loops ran scalar beside jz's vectors). Go's `GOARCH=wasm` has no SIMD support, and AssemblyScript emits SIMD only for explicit `v128` code, which the ports do not write, so their rows are unchanged; TinyGo keeps its default target.

Install Tov with `curl -fsSL https://tov.sh/install.sh | sh` (needs Rust and a C
compiler). It builds from a git checkout at `~/.tov/src` (`TOV_DIR`), whose
commit the run records beside `tov version`: the version string stays `0.0.1`
while the compiler changes daily. Ports share `_lib/bench.tov`. Tov traps on integer
overflow, so JS's 32-bit arithmetic (FNV mix, XorShift32, `Math.imul`) runs on
u32 values in 64-bit `int`, masked. Tov has no f64 bit cast, so the f64 checksum
reads each low word by exact power-of-two scaling.

Install Goose from its [v2026.3 release](https://github.com/aardappel/goose/releases/tag/v2026.3)
(CI checks the Linux archive's SHA-256) and put `goose` on PATH or set
`GOOSE_BIN`; `goose build` needs a C compiler. `goose version` names only its
runtime's hash, so the run records the release tag from the directory the
archive unpacks to and the C compiler `goose toolchain` reports: `goose
v2026.3, runtime 4d3da949e563, C compiler clang 21.0.0` on an Apple M4 Max. The
harness keeps Goose's intermediates in the bench build directory (`GOOSE_HOME`)
and adds no flags. Goose's emitted C turns floating-point contraction off
itself (`#pragma clang fp contract(off)` and the GCC equivalent), so its float
cases give the strict checksums, with no FMA variants.

The 83 ports share `_lib/bench.goose` and were written for this benchmark from
each case's JavaScript, and from its C and Rust ports where it has them: the
same algorithm, input generation, iteration counts and checksum, in the layouts
Goose code reaches for. Buffers are grow-only arrays (`T[>..]`), lookup tables
and small matrices fixed arrays (`u32[256]`, `f64[16]`), records inline structs;
`shapes` stores its record stream as a variable-mode enum (each record the size
of its own variant) and measures it through case functions, `wordcount` counts
in the standard library's `dictionary` keyed by views of inline `u8[..8]`
words, `strbuild` formats each row as a fresh `str(…)`, `json` parses with the
standard library's JSON parser, and `callback` and `poly` call its `map` and
generic `sum`. The `Map` and `Set` cases are `dictionary` too: `mapstr` keys
its three maps by views of each event's own inline strings, `mapint` keeps each
adjacency list in a run of a slice pool (`reusable[]`) that `realloc_slice`
doubles when it fills, and `setops` holds its 256 document sets in one
dictionary keyed by (document, word), each document's members listed beside
it, since a Goose array cannot hold a resizable value. `stringify` and
`jsontransform` write through the json module's writer member by member, as
it has its callers do, and `jsontransform` parses into its document tree.
That writer finds Number::toString's shortest digits but lays them out as
serde_json does (`1.0`, `1.05e-6`, `1e21`), so `_lib/ecmajson.goose` lays
them out as JSON.stringify does (`1`, `0.00000105`, `1e+21`). `jsonroundtrip`
parses into the document tree and writes it back by walking it, each number
through a buffer of its own: `format_number_js` shrinks the buffer it rewrites,
and a walk holding a reference into the tree may only grow `out`. `arraynumeric`
grows an `f64` array; `arraydowngrade` holds an enum of a number, the object and a
string view in fixed mode (each slot the size of the largest variant), indexed
and replaced slot by slot. The library
cases (the color-space kernels, pmndrs/math's,
three.js's, @stdlib's ddot) port the library code they call as written, a JS
object becoming an inline struct and a method a function; libm functions
Goose's `math` module does not bind (`cbrt`, `hypot`) come through `extern fn`.
Like the Rust ports they add no bounds-check hints (no `assert` of lengths, no
`checkfree`): the compiler removes what it proves. They cover every case with C
and Rust ports but `dispatch`, the C-only library idioms (sosfilter, movavg,
upfirdn, pcmconvert); among the cases with C and Rust ports they leave out only
`dispatch`, `mapobj` and @stdlib's exp, erf, pow and gamma (below).

Eighteen cases have no port:

- `dispatch` calls through a table of first-class functions, and Goose has no
  function values at run time, only an enum's tag to dispatch on.
- `mapobj` keys its side tables by object identity. A `dictionary` compares
  keys with `==`, which on a reference compares the targets, and Goose has no
  operator overloading; a module's identity is its slot in a pool, so the
  tables would be integer-keyed maps (mapint's workload) or arrays beside the
  pool, as Rust holds a graph by index.
- `async` awaits promises, and Goose has no async functions, promises or event
  loop: its concurrency is threads that share nothing.
- @stdlib's exp, erf, pow, gamma, special functions and distributions build
  float64 values from their 32-bit words (`fromWords`, `setHighWord`) on their
  hot paths. Goose has no bit cast from integer to float: `as` converts the
  value, `bytes_of` is a read-only view, and the one way back from bytes,
  `from_bytes`, verifies a serialized image into an array, per value; the
  other way is C of its own through `extern fn`. The last two are
  20,000-line namespace bundles besides.
- The lab probes colorconv, colorlch, colorlog, colorpq and deltae check the
  exact bits of transcendental results, which follow one engine family's math
  library; no native lane has a port of them.
- jessie, jz and watr (parsers and compilers bundled from npm packages) and
  webaudio (the whole web-audio-api library) are programs of thousands of
  lines, not kernels.

Goose is a native contender like scriptc and Perry: it enters no
claim, and the chart leaves it out as it leaves out the other native ports
(native Rust, Zig and Go, and Tov), while the bench page shows it per case and
in the corpus.

Install Bend from its [v2.0.39 release](https://github.com/bendlang/bend/releases/tag/v2.0.39)
(CI checks the Linux archive's SHA-256, which GitHub publishes beside it) and
put `bend/bin/bend` on PATH or set `BEND_BIN`. It reads its Base library from
the archive's `bend2/`, so it runs where it unpacks, and its builds need clang
14 or newer. The run records `bend version` and the clang Bend's compiler picks
(`$CC`, then `clang`, then the newest `clang-N`): `bend 2.0.39, C compiler clang
19.1.6` on an Apple M4 Max. The harness adds no build flags. A Bend program runs
in parallel only where it says so, with a parallel call (`a b = f(x) g(y)`) or a
GPU call (`f!(x)`). The ports make neither, and each binary still runs with
`--threads 1`, which also puts the runtime's work loop on its sequential path,
and `--gpu off`: the comparison is single-threaded, like every other lane's.

The 29 ports share `_lib/bench.bend` and were written for this benchmark from
each case's JavaScript and its C port where it has one: the same algorithm,
input generation, iteration counts and checksum, in the shapes of Bend's own benchmarks
(`bench/runtime` in its repository). A loop is a recursive def counting down a
`Nat`, its index a `U32` beside it. Bend checks that recursion ends, so a loop
whose bound is a test (`j < LIMIT`, a probe that stops at an empty slot, an
interpreter's `pc < NINSTR`) also carries a `Nat` fuel no smaller than its trip
count beside the test's `Bool`. A `match` reads only a parameter or a pattern's
variable, so a branch is a def taking its caller's `Bool`; an array read hands
the array back beside its word, so a loop step is a chain of stage defs, each
read's pair the next stage's parameter, the arrays riding in a record. Buffers
are `Array<U32>`, a byte or an int32 in each word (the native runtime stores an
array as a flat block). `immutable` rebuilds a list of `P` records every step,
`shapes` matches a datatype of 8 constructors kept in an `Array<Shape>`,
`wordcount` counts in Base's string-keyed `Map`, a bitwise trie over each key
whose operations take nearly all of the case's time, and `strbuild` formats
each row as a fresh `String` with `++` and `U32.show`. `qoi` keeps a pixel as
a `Px` record and its colour index as four arrays in one record; `hashjoin`
probes as `dict` does, one read of `keys[h]` answering whether the slot is
empty and whether it holds the key; `trace` and `glyfparse` turn each `&&` of a
test into a chain of defs, so a read happens only where the JS's `&&` reaches
it. `json` parses the text, a `String` read char by char, into a value tree
whose objects are Base's `Map` and arrays `List`s; Bend allows no mutual
recursion, so the parser is one def taking the mode it is in (a value, the
next element or member, a closed array or object). With no f64 its numbers
are int32 digit runs, which every number in that text is. `mapstr` keeps its
route counts, sessions and bans in Base's `Map`, its sweep walking
`Map.to_list`; a Bend value has no identity, so a session is a record set back
whole after each event, and the fresh session a miss opens is the default
`Map.get` answers, built on every event. `setops` keeps each document's words
in a Base `Set`: a set is a persistent value, so `new Set(a)` shares it and
each delete rebuilds the path it changes, and `Set.size` walks the set, read
once for each of the two sets a comparison takes. A Bend array has a fixed
power-of-two slot count and no push, so `arraynumeric` and `arraydowngrade` make
one of 2^18 slots each run and store their 250,000 values in order where the JS
pushes them; `arraydowngrade`'s is an `Array<Value>` of a datatype of three
constructors (a number, the object as a record, a `String`), read with
`Array.get` and written with `Array.set`. Their numbers are integers below 2^23,
which U32 holds as the JS's doubles do. Bend has no signed
integer: an int32 is a `U32` in two's complement whose sign tests read bit 31.
`immutable` bounces with the one unsigned test `nx > LIM`, `blur` clamps by
comparing `x + k` with the radius, `qoi` tests `-2 <= vr <= 1` as the one
unsigned `vr + 2 <= 3`, `conv2d`, `strbuild`, `qoi` and `glyfparse` shift
arithmetically by filling the sign, and `conv2d` wraps its perturbed byte as
Int8Array does. The clock is the helper module's own effect, `now_us`
(`_lib/bend-clock.c`, with a `.js` twin so `bend <case>.bend` runs a port
without a build), since Base's `IO.now` counts whole milliseconds. The ports
cover integer (bitwise, crc32, sieve, nqueens, radixsort, hash, vm, dict,
levenshtein, hashjoin), image (alpha, blur, conv2d, qoi, trace), audio
(bytebeat), text, codecs and parsers (base64, tokenizer, strbuild, wordcount,
lz, json, glyfparse), maps and sets (mapstr, setops), records (immutable,
shapes) and plain arrays (arraynumeric, arraydowngrade).

Bend has no 64-bit float (its numbers are `Nat`, `U32` and `F32`), so no f64
case has a port: in `F32` a kernel computes a narrower result than the case's,
or, where small integers keep it exact (dotprod, poly), moves half the bytes of
their Float64Arrays. The array cases hold small integers in a plain array, whose
element representation each engine chooses for itself, so U32 changes neither
their values nor what they measure.
`callback` and `dispatch` have none either: a Bend closure is affine, called at
most once, and a template argument is fixed at compile time, so neither
`a.map(x => x * scale + i)` over every element nor a table of operators called
through one site has a Bend form; a def taking `scale` and `i`, or a match on
the opcode, would be the hand-fused loop or the switch, not the call the case
measures. Base's only map is keyed by `String`, so `mapint`, whose maps are
keyed by 30-bit ids and hold growing adjacency lists, has no port: a key
formatted by `U32.show` would measure string building, and a table of the
port's own would not be Base's. `mapobj` keys its maps by object identity,
which a Bend value does not have (equality is structural), and its deep copy
through a memo map would copy nothing. The JSON cases (`stringify`,
`jsontransform`, `jsonroundtrip`) format and parse f64 numbers. `async` has no port either,
though Bend's IO runs computations on one event loop (`IO.fork`, `IO.join`,
channels) and a port of it reproduces the checksum: IO is
continuation-passing, so an await on a stage that answers at once is a
closure call that never reaches the loop, a batch's forked handlers run whole
one after another instead of interleaving at each await, and a throw is a
`Result`. Its read-only tables need a container of the port's own besides,
since an `Array` has one owner and forked computations cannot share it. Such a
port measures closures and a tree walk, not suspension and a job queue. Bend
is a native contender like Goose: it
enters no claim, and the chart leaves it out as it leaves out the other native
ports, while the bench page shows it per case and in the corpus.

Install the pinned Perry compiler with `npm install -g @perryts/perry@0.5.1520`,
then run `node bench/bench.mjs --targets=perry`. CI uses the same package.
The native lane uses the package's prebuilt runtime libraries; a source checkout
can produce smaller feature-pruned runtime builds. Compile attempts have a
120-second limit, executions a 60-second limit. Bounded executions run directly
so timeout signals reach the binary; their RSS is unmeasured. Each invocation
calls Perry again (its own object cache remains enabled), while paired rounds
reuse the binary. Perry's browser/WASM backend is a separate target and is not
measured by this native lane.

Install the pinned scriptc release with `npm install -g scriptc@0.4.6` (Node 24+;
prebuilt for macOS arm64 and Linux x64), then run
`node bench/bench.mjs --targets=scriptc`. CI uses the same package. Source main
`a37abcc` (2026-10-30), built the way the previous installer built `6d1907a`,
gave the same results case for case; its `SCRIPTC_INFER_JS=1`, inference for a
program's own JavaScript (unreleased, added the day after 0.4.6), typed three
declarations of alpha and changed no timing. `--optimization speed` ran alpha,
mandelbrot and bitwise within 2% of the default release build.

Static Hermes has no release: `node scripts/install-shermes.mjs <dir>` builds
the pinned `static_h` revision of facebook/hermes (cmake and a C++17 compiler)
and writes `<dir>/shermes`, a launcher that names that revision; CI caches the
build. shermes runs the C compiler CMake found when it was built, which on
macOS needs the SDK the harness passes as `SDKROOT`.

The engine-in-wasm lanes: download QuickJS-NG's
[`qjs-wasi.wasm`](https://github.com/quickjs-ng/quickjs/releases/tag/v0.17.0)
and set `QJS_WASI` to it; `npm install @bytecodealliance/jco@1.40.0
@bytecodealliance/componentize-js@0.23.0 componentize-qjs@0.5.0` supplies `jco`
and `componentize-qjs`, whose components run on `wasmtime` (`WASMTIME_BIN`; the
lanes need a current release: wasmtime 25 ran QuickJS's mandelbrot 5–8× slower
than 50 does). js2wasm is `npm install @loopdive/js2@0.71.0 binaryen`.
CI installs all of them. Not wired:

- Static Hermes to WASI, tmikov's `shermes-wasm` branch: no release. A fork
  publishes a prebuilt SDK under a moving `sdk-latest` tag, and the lane would
  also need wasi-sdk.
- guest271314/quickjs-ng-wasi-wasm, QuickJS-NG with the script embedded at
  build time through wasi-sdk (550 KiB): a build script, no release; the
  upstream `qjs-wasi.wasm` reads the script at run time instead.
- js2wasm source main (`a514946`, 2026-10-30): its JS-host output prints no
  string literal (`console.log("top", 1 + 2)` prints `3`), so the result line
  comes out empty; the lane takes the 0.71.0 release.
- `componentize-js`'s own CLI (0.23.0): with `@bytecodealliance/preview2-shim`
  0.31, which it resolves, its WIT reader gets no preopened directory and
  cannot read `--wit`; `jco componentize` drives the same package.

For TypeScriptCompiler, extract the
[pre-alpha113 Ubuntu 24.04 x64 release](https://github.com/ASDAlexander77/TypeScriptCompiler/releases/tag/v0.0-pre-alpha113),
set `TSLANG_BIN` to its `tslang` executable, and set `GC_LIB_PATH`,
`TSLANG_LIB_PATH`, and `DEFAULT_LIB_PATH` to the extracted directory.
Install `clang` and `libcurl4-openssl-dev`, then run
`node bench/bench.mjs --targets=tslang`. CI pins both compilers and the tslang
archive's SHA-256. The release has no macOS/arm64 binary.
Both lanes bound compilation to 120 seconds and execution to 60 seconds,
rebuild on each invocation, and reuse artifacts within paired rounds.
Rebuilds discard the previous artifact; a successful exit without output is a failure.
Rejected programs and wrong checksums remain visible; they supply no timing ratios.
scriptc takes its types from the TypeScript checker alone, so the corpus's
unannotated parameters are `any`. Through `6d1907a` (0.1.7) the static build
rejected operations on them at run time (`the '|' operator on 'any'-typed
values runs in the embedded dynamic engine, which this build does not
include`, the stored rows' commonest failure); 0.3 removed that engine and
compiles them to its dynamic tier instead. That tier is the cost the lane
measures. The benchmark keeps the original JavaScript and adds no annotations.
Use `--json=<file> --no-web` to record competitor results without rebuilding JZ's
browser artifacts. Add `--merge` to preserve unmeasured target rows in that file.

The 2026-09-30 refresh ran both current compilers on the 63 reference cases:

| compiler | accepted results | checksum mismatches | other failures | timeouts |
| --- | ---: | ---: | ---: | ---: |
| scriptc `6d1907a` | 10 | 3 | 45 | 5 |
| Porffor alpha 13 | 46 (3 documented FMA variants) | 13 | 4 | 0 |

Each failure retains its diagnostic. The other competitors' stored rows are
unchanged; all three timing anchors passed within the 10% drift limit. These
remain partial, mixed-vintage measurements on a host with high swap use,
recorded in `meta.machineState`. The chart labels each native lane's comparable
coverage; wrong checksums and failures never enter its geomean. `results.json`
keeps these alpha 13 rows until a reference run measures the alpha 19 pin; the
2026-11-02 run below measures both releases.

A 2026-10-30 local run on the same machine measured the lanes added or changed
since on all 91 cases, JZ at `135e1bd`. It is not reference evidence and
`results.json` keeps its rows: the load average was 16–18 from other work, and
three case subsets ran in parallel, each pairing JZ with every lane in one
process. Time and size are geometric means of lane ÷ JZ over the non-lab cases
both answer correctly (count in brackets), against JZ's size build; no lane is
faster than JZ on any case.

| lane | agree | wrong | failed | timed out | time ÷ JZ | size ÷ JZ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| scriptc 0.4.6 | 72 | 3 | 12 | 4 | 96× (70) | 215× |
| Static Hermes `c37388f` | 86 | 3 | 2 | 0 | 27× (80) | 1573× |
| js2wasm 0.71.0 | 14 | 55 | 19 | 3 | 211× (14) | 7.5× |
| QuickJS-NG 0.17.0 WASI | 86 | 5 | 0 | 0 | 117× (83) | 462× |
| componentize-qjs 0.5.0 | 85 | 5 | 1 | 0 | 107× (83) | 488× |
| ComponentizeJS 0.23.0 | 85 | 5 | 0 | 1 | 164× (82) | 3812× |

Every lane's wrong answers but js2wasm's are the color probes and deltae, which
JZ misses too (no lane reproduces their stored checksums). Two Static Hermes
rows time as 0 at its millisecond clock and leave its geomean. The rest, case
by case:

- scriptc: the TypeScript checker rejects the JavaScript of webaudio
  (`Symbol.dispose ||=`, a read-only property), threescene, threeanim and
  threegeom (three.js's JSDoc `Array<number,number,number,?string>`), upfirdn
  (`out` used before assigned), jessie and jz (`This condition will always
  return true`); stdlib-dists and watr reach operations with no lowering yet
  (`Boolean.prototype.toString`, `new BigInt64Array`, SC2020); movavg and
  threecull fail its run-time type checks (`expected number at $.memory, got
  array`), fabrik a read of a `var` above its declaration; particle,
  stdlib-special, stdlib-gamma and stdlib-pow pass the 60-second limit. scriptc
  limitations all, none the harness's.
- Static Hermes: webaudio's dynamic `import()` does not compile (`Invalid
  expression encountered`); in the jz case the compiled compiler's parser stops
  at `Unclosed (`, quoting its input as `for (let i̭ = 0` (a combining mark
  after `i` the case's source does not hold; Node, QuickJS and SpiderMonkey
  reproduce the oracle).
- js2wasm: five different kernels, mandelbrot and bitwise among them, return
  one wrong checksum (1299645893); alone, the checksum's FNV step
  (`Math.imul(h ^ (a[i] | 0), 0x01000193) | 0` in an arrow function) compiles
  to invalid wasm, an `i32.mul` over a TypeError. The TypeScript checker
  rejects watr, jessie, jz, webaudio, stdlib-dists and the three.js cases;
  glyfparse and vm emit invalid wasm; stdlib-exp and dispatch dereference null,
  stdlib-gamma, stdlib-pow, stdlib-ddot and sosfilter end in an uncaught wasm
  exception, fabrik calls a non-function and munsell throws a ReferenceError;
  particle, sieve and stdlib-special's compile pass their limits.
- componentize-qjs: jessie's recursive descent exhausts wasmtime's default wasm
  stack (`call stack exhausted`).
- ComponentizeJS: stdlib-dists passes the 300-second run limit.

The engines-in-wasm lanes run the self-compile case too: QuickJS-NG 2.91 s,
componentize-qjs 2.48 s, ComponentizeJS 4.83 s, each with the oracle's checksum
(JZ's own row there, which takes over an hour to build, was not rerun).

A 2026-11-02 local run on the same machine measured Porffor alpha 19 (`0c135ce`,
the pin) beside JZ at `839dad3` on the 90 cases but `jz`, then alpha 13
(`547c781`) alone on the same cases. It is not reference evidence: the load
average was 23–30 from other work with 25–27 GB of swap in use, and each lane
ran once. Columns as in the 2026-10-30 table; alpha 13's run had no JZ row of
its own to time against.

| Porffor | agree | wrong | failed | timed out | time ÷ JZ | size ÷ JZ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| alpha 13 `547c781` | 53 (3 FMA variants) | 18 | 18 | 1 | – | 68× |
| alpha 19 `0c135ce` | 64 (3 FMA variants) | 18 | 8 | 0 | 21.8× (63) | 118× |

Alpha 19 newly answers jessie (5.7× JZ's time), radixsort, threecull, movavg and
seven of the nine color-space kernels (hsl, hwb, jzczhz, cam16, hct, a98rgb,
ipt), where alpha 13 crashed, returned a wrong checksum, or on movavg passed the
300-second limit. Its accepted FMA variants are fft, biquad and gainclass (all
in `FMA_CHECKSUMS`, gainclass's as native Go's); resample and synth left theirs.
Eleven of its 18 wrong answers are fused multiply-add alone: built with
`CC='cc -ffp-contract=off'`, lorenz, resample, synth, slices, nbody, raytrace,
fftplan, sosfilter, jzazbz, worley and fabrik return the strict reference, and
none of those alternates is in `FMA_CHECKSUMS`. threescene and threegeom stay
wrong with FMA off; deltae and the four color probes are the cases JZ misses
too. stdlib-special, stdlib-dists, stdlib-exp, stdlib-gamma and stdlib-erf still
do not build: the generated C redefines `floorf` and `ceilf` and passes an `int`
where a `jsval` is expected, which clang rejects. watr ends in a bare
`Uncaught TypeError` (alpha 13: `Bad export name at 5:9`); webaudio
(`Cannot get property of null`) and threeanim (three.js's `.setFromEuler()
encountered an unknown order: undefined`, then a signal) fail as under alpha 13.

On the 51 cases both releases answer correctly, alpha 19 takes 1.04× alpha 13's
time (geomean; both binaries built per case and run alternately, four runs
each): more than 10% faster on 10 cases (bezfit 3.3×, mandelbrot 2.3×,
quatmul 2.0×, json 1.7×, polytri 1.7×), within 10% on 15, slower on 26 (blur
1.84×, alpha 1.79×, bitwise 1.61×). Its binaries are 2.0× alpha 13's (geomean
over the 71 cases both build). JZ is faster and smaller than alpha 19 on every
case both answer correctly; the closest, paired over six rounds, is hct (1.88×
JZ's time). Of the FMA-only rows, synth (1.26×) and fabrik (2.2×) pair
closest, and on lorenz alpha 19 is faster than JZ: paired at a load average of
13, 11.6 ms against JZ's 15.0 ms with its FMA checksum, and 14.9 ms against
15.1 ms built with FMA off, where it returns the strict reference. The row does
not compare here while its checksum is unclassified. On CI's x64 runners clang
emits no FMA and the row compares: alpha 13 took 1.05× JZ's time in the
2026-11-03 CI run (`results-ci.json`), and with FMA off alpha 19 runs lorenz at
alpha 13's speed (14.8 ms each, run alternately).

TypeScriptCompiler pre-alpha113 builds none of the 91 cases on CI's Ubuntu 24.04
x64 runner (probe run 41666196044, 2026-11-03). Its default library gives
`TypedArray<T>` one constructor, from an array: `new Float64Array([3, 1, 2])` and
`new Array<number>(21)` compile, `new Float64Array(21)` does not (`cast from array
type 'si32' to array type '!ts.array<f64>' is not supported`), and every case
allocates its timing samples that way. That is the first error in 20 cases, the
same 20 that pre-alpha87, whose `TypedArray<T>` had the same one constructor,
compiled and that then crashed with SIGSEGV. The first error elsewhere: no
`buffer` or `byteOffset` on a typed array, which the shared `checksumF64` reads
(26 cases); `set` with an array (9); an error inside the library's own `fill` (5);
properties of untyped parameters, typed `any` (8); a class member three.js
declares (4); `JSON`, `atob` and a compiler crash on the self-compile case (3);
and other unsupported forms (16). The lane stays wired, so each CI run records the
current errors.

TypeScriptCompiler pre-alpha87 also produced no usable results on the 74 discovered
cases. Its compiler and monotonic-clock installation smoke passed; corpus failures
include unsupported array conversions, unresolved types, and runtime crashes.
This compatibility run used Ubuntu 24.04 x64 under Rosetta on the Apple M4 Max.
Its [separate dataset](results-linux.json) is displayed under
[Linux validation](https://jz.js.org/bench/?machine=linux); no emulated timings
are mixed into the reference or CI machine's ratios. Reproduce on Linux with:

```sh
JZ_BENCH_HOST_NOTE='describe the validation host' \
node bench/bench.mjs --targets=tslang --json=bench/results-linux.json --no-web
```

The 2026-09-24 Perry 0.5.1520 refresh attempted all 63 discovered cases on an
Apple M4 Max. All three timing anchors passed (1.026×, 1.070×, 1.029× their stored
times); existing target rows were preserved. Perry passed 55 checksums. Across
the 53 accepted non-lab cases with JZ evidence, its geometric mean time was
61.71× JZ's, with no per-case wins. Executables were 14.24–14.32 MiB, including
the prebuilt runtime. RSS was not measured. The timing comparison is provisional:
the host reported 14,738.81 MB of swap use (above the claims gate's 4,096 MB
limit), and the preserved JZ baselines predate current compiler changes. Passing
anchors does not override either validity check; a release claim needs a fresh
comparison on a host within the gate's memory limit.

`deltae`, `colorconv`, and `colorlch` returned different checksums; `watr` crashed
with SIGSEGV; `jessie` exceeded the execution limit; `jz` exceeded the compilation
limit; `webaudio` reported a `BaseAudioContext` type error. The new `entity` case
ran but has no stored oracle yet, so it remains unclassified. These rows are
retained in `results.json` and excluded from performance aggregates. These
measurements describe the unchanged, unannotated JS corpus and this release's
native output, not Perry's performance on typed or rewritten programs.

The `size` column reports the artifact size each target measures: the
compiled native binary for `nat`/`rust`/`go`/`zig`, the produced
`.wasm` for `jz`/`as`/`rust-wasm`/`go-wasm`/`c-wasm`/hand-WAT/jawsm/`jz-w2c` (the C-translated
executable), or the source file for raw-JS interpreters where there is no
compile step. For source files with imports, raw-JS size is only the entry file;
JZ size is the bundled wasm artifact.

A binary or module counts as a release ships it, without debug info or symbol
names ([`_lib/release-bytes.js`](_lib/release-bytes.js)): a native binary or
shared library as `strip(1)` leaves it, and a wasm module, or each core module of
a component, without its `name`, `.debug_*`, `producers` and `target_features`
sections, as `rustc -C strip=symbols`, `zig cc -s` and wasm-ld's `--strip-all`
leave it (byte for byte on alpha's rust-wasm and c-wasm). Other custom sections
stay: JZ's interop reads its `jz:*` ones. The harness strips a copy, so each row
times the binary its toolchain built. `results.json` and `results-ci.json` as
committed on 2026-11-03 count the files as built, where three wasm rivals were
mostly DWARF; on CI's runner (probe run 41679169594), alpha's c-wasm is 955,519
bytes as built and 24,162 stripped, zig-wasm 978,968 and 47,429, rust-wasm
2,192,980 and 63,421, the native zig binary 3,672,600 and 509,880, and
QuickJS-NG's released `qjs-wasi.wasm` 1,569,050 and 1,177,993. Builds that already
strip: `nat` (`strip`), `rust` (`-C link-arg=-s`), `go` and `go-wasm`
(`-ldflags=-s -w`) and Perry; JZ, AssemblyScript, js2wasm, MoonBit and hand-WAT
emit no debug sections. TinyGo's `-no-debug` keeps a name section, and Porffor,
scriptc, Static Hermes (with its VM libraries), Goose, Bend and `jz-w2c` keep
symbol tables.

Note the preset trade: these speed tables build JZ at the default
(`optimize: 2`, speed-leaning — loop unroll + SIMD lift), while the dedicated
size comparison (`npm run bench:size`) builds with `optimize: 'size'` —
typically ~2× smaller on the same kernel (biquad: 3.5 kB default vs 1.6 kB
size-tuned). Pick the preset for what you ship; the two tables are not the
same artifact.

The `mem` column (`memKb` in `results.json`) is the peak resident set of the
whole per-case process — engine + module + data — read from the child's rusage
by wrapping every measured run in `time(1)` (`/usr/bin/time -l` on darwin, GNU
`-v` on linux; no wrapper on the host → the field stays null and the page shows
an unmeasured value). One number per lane run, the footprint a deploy
actually pays: node-hosted rows carry the engine baseline (so same-host rows
differ by their heap alone), native rows just the binary, `porf` compiles
in-process each run (its deployment shape). Under `--paired` the recorded
value is the cross-round median of each forward/reverse pair's mean. Both
positions must carry a valid RSS reading in every counted round. The release
gate compares Jessie, watr and Web Audio against V8 per case; a win in one
cannot hide a loss in another.

**Where jz lands vs MoonBit** (`moonbit`/`moonrun` — a wasm-first-language
rival with a real GC, the fairest no-engine-baseline memory comparison since
both run as standalone wasm binaries rather than hosted in node/V8):
the historical [memory snapshot](memcheck-results.csv) is stale. Its latest
recorded comparison is 1/43 cases at or below moonrun's peak RSS, after an
earlier 40/43 result. That regression remains unverified on the current tree;
the earlier result is not a current memory claim. The CI release artifact's
Node-hosted JZ/V8 comparison does not establish MoonBit parity.

Runtime command overrides:

All JZ timings, including `watr`, use the speed tier. The size column uses a
separate size-tier build from the same source and host imports.

```sh
BUN_BIN=/path/to/bun \
DENO_BIN=/path/to/deno \
SPIDERMONKEY_BIN=/path/to/js \
SHERMES_BIN=/path/to/shermes \
GRAALJS_BIN=/path/to/graaljs \
PORF_BIN=/path/to/porf \
SCRIPTC_BIN=/path/to/scriptc \
PERRY_BIN=/path/to/perry \
JS2WASM_BIN=/path/to/js2wasm \
QJS_WASI=/path/to/qjs-wasi.wasm \
CQJS_BIN=/path/to/componentize-qjs \
JCO_BIN=/path/to/jco \
WASMTIME_BIN=/path/to/wasmtime \
node bench/bench.mjs --targets=bun,deno,spidermonkey,shermes,graaljs,porf-native,scriptc,perry,js2wasm,qjs-wasi,componentize-qjs,componentize-js
```

## Reading the numbers (darwin/arm64, M-class)

Snapshots from `node bench/bench.mjs --targets=v8,jz,as` show the Wasm rows.
JZ against **V8 raw JS** (`v8/node`) and **AssemblyScript** (`as`) is the
headline comparison; a successful hand-WAT row supplies the wasm-in-V8 floor.
A `fail` row records the latest attempt and retains no stale timing. The page
also shows `jz-w2c` and the native toolchains as native rows. Compare those rows
with each other, not with wasm-in-V8.

### biquad — f64 typed-array DSP cascade

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **4.59 ms** | **2.04×** | **1.4 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 6.30 ms | 1.49× | 1.8 kB | ok |
| V8 (node) raw JS | 9.38 ms | 1.00× | 3.2 kB | ok |
| hand-WAT → V8 wasm | – | – | – | fail |

JZ beats V8 raw JS by 2.0× and AS by 1.4×. Typed-array scalarization,
offset fusion, and base hoisting produce the dense f64 loop.

### mat4 — fixed-size Float64Array multiply

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.74 ms** | **11.44×** | **1.2 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 6.53 ms | 1.30× | 1.4 kB | ok |
| V8 (node) raw JS | 8.50 ms | 1.00× | 1.2 kB | ok |
| hand-WAT → V8 wasm | – | – | – | fail |

JZ is 10.9× faster than V8 raw JS and 8.6× faster than AS. The scalarized
SIMD hot path (unrolled 4×4 multiply) is the win; V8's JIT doesn't vectorize
this from JS source.

### poly — bimorphic typed-array reduce

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.12 ms** | **13.90×** | **985 B** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 0.74 ms | 2.28× | 1.3 kB | ok |
| V8 (node) raw JS | 1.70 ms | 1.00× | 1014 B | ok |

JZ is 12.2× faster than V8 raw JS and 6.0× faster than AS. The bimorphic
`sum` (called with both `Float64Array` and `Int32Array`) stays on typed
paths without falling back to generic dispatch.

### bitwise — i32 narrowing chains (`Math.imul`, shifts, FNV-1a)

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.92 ms** | **4.15×** | **943 B** | **ok** |
| V8 (node) raw JS | 3.83 ms | 1.00× | 1005 B | ok |
| AssemblyScript (asc -O3 --runtime stub) | 8.96 ms | 0.43× | 1.3 kB | ok |
| hand-WAT → V8 wasm | 3.51 ms | 1.09× | 355 B | ok |

JZ is 4.0× faster than V8 raw JS and 9.6× faster than AS. The i32 hot path
(`Math.imul`, `|0`, `>>>0`) now lowers to raw `i32` ops without NaN-box
overhead on every operation.

### tokenizer — string scan with `charCodeAt` and integer accumulation

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.04 ms** | **3.05×** | **1.4 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 0.05 ms | 2.42× | 1.5 kB | ok |
| V8 (node) raw JS | 0.13 ms | 1.00× | 2.0 kB | ok |

JZ is 2.8× faster than V8 raw JS and 1.3× faster than AS on this
`charCodeAt`-heavy scan. Both are well ahead of V8.

### callback — `Array.map` closure + i32 fold

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.24 ms** | **2.63×** | **1.2 kB** | **ok** |
| V8 (node) raw JS | 0.62 ms | 1.00× | 1.3 kB | ok |
| AssemblyScript (asc -O3 --runtime stub) | 0.77 ms | 0.81× | 1.8 kB | ok |

JZ is 1.8× faster than V8 raw JS and 2.3× faster than AS. Closure +
`Array.map` lowers to a preallocated typed loop with no per-iteration alloc.
V8's JIT does not inline the closure across the `map` boundary.

### aos — array-of-object rows to typed arrays

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.66 ms** | **1.93×** | **1.6 kB** | **ok** |
| V8 (node) raw JS | 1.28 ms | 1.00× | 1.1 kB | ok |
| AssemblyScript (asc -O3 --runtime stub) | 1.32 ms | 0.96× | 1.9 kB | ok |

JZ is 1.9× faster than V8 raw JS and 2.0× faster than AS. Schema-slot
reads are direct field offsets; the gap is small because the workload is
memory-bound.

### mandelbrot — 256×256 escape-time iteration

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| AssemblyScript (asc -O3 --runtime stub) | 7.83 ms | 1.18× | 1.3 kB | ok |
| **JZ → V8 wasm** | **4.37 ms** | **2.12×** | **964 B** | **ok** |
| V8 (node) raw JS | 9.27 ms | 1.00× | 1.8 kB | ok |

JZ is 1.9× faster than V8 raw JS and 1.7× faster than AS. The dense f64 hot
loop uses a direct conditional-break path.

### json — runtime `JSON.parse` plus stable-shape walk

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **0.13 ms** | **2.04×** | **7.6 kB** | **ok** |
| V8 (node) raw JS | 0.27 ms | 1.00× | 1.2 kB | ok |

JZ is 2.0× faster than V8 raw JS. The runtime parser is specialized to the
inferred JSON shape; AS is skipped because it cannot parse JSON at runtime.

### sort — in-place heapsort over typed array

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **4.59 ms** | **1.50×** | **1.3 kB** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 7.61 ms | 0.91× | 1.8 kB | ok |
| V8 (node) raw JS | 6.90 ms | 1.00× | 1.6 kB | ok |

JZ is 1.1× faster than V8 raw JS and 1.2× faster than AS. Call-heavy
nested loops with typed-array index propagation stay on the i32 path.

### crc32 — table-driven CRC-32 over byte buffer

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| **JZ → V8 wasm** | **7.60 ms** | **1.26×** | **964 B** | **ok** |
| AssemblyScript (asc -O3 --runtime stub) | 8.41 ms | 1.14× | 1.3 kB | ok |
| V8 (node) raw JS | 9.57 ms | 1.00× | 1.8 kB | ok |

JZ is 1.1× faster than V8 raw JS and ties AS. Integer narrowing and
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

**JZ is excellent at dense dispatch and
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

On `dispatch` **jz leads the
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

### JSON, Map/Set and async – the server and tooling surface

Seven cases measure what servers, tools and data pipelines spend their time in:
`stringify` and `jsontransform` (JSON writing, and a parse, reshape and write round
trip of text that arrives at run time), `mapstr`, `mapint` and `mapobj` (`Map`s keyed
by string, by integer and by object identity), `setops` (`Set` membership and
algebra) and `async` (async functions and promises). Each is one program with one
checksum. The JSON pair folds every UTF-16 code unit of its output, which ECMAScript
fixes exactly (Number::toString's shortest digits, JSON's escapes); the `Map` and
`Set` cases fold a map's entries as sums, so a port's iteration order changes
nothing; `async` folds the responses in request order, which `Promise.all` keeps.

Ports where the language has the structure in its standard library: Go for the six
synchronous cases (`encoding/json` over tagged structs, which formats floats as
ECMAScript does and escapes the same characters, the data holding none of the `<`,
`>`, `&`, U+2028 and U+2029 that only Go escapes; `map[string]T`, `map[int32]T`,
`map[*Module]T`, `map[string]struct{}`), which the go, go-wasm and tinygo lanes
take; AssemblyScript for the four `Map` and `Set` cases; Goose for the JSON pair (its
`json` module) and `mapstr`, `mapint` and `setops` (its `dictionary`); Bend for `mapstr`
and `setops` (Base's `Map` and `Set`), the two native lanes described under Targets
with the cases they leave out; Rust and C for all six,
which the rust, rust-wasm, nat and c-wasm lanes take. Rust's maps are `HashMap` and
`HashSet`. It holds `mapobj`'s graph as an arena, a `Vec<Module>` whose dependencies
are `ModuleId` indices, the way Rust holds a graph without shared ownership; the side
tables stay `HashMap<ModuleId, T>` keyed by that index, not `Vec`s indexed by it,
which would turn the maps into arrays. C has no standard map, so its ports write the
tables a C programmer would: open addressing with linear probing over a power-of-two
array kept at most half full, FNV-1a over a string key's bytes with the hash kept in
its slot, a Fibonacci hash of an integer key or of a module's address, and tombstones
where `mapstr` deletes sessions while it sweeps them.

Neither C nor Rust has JSON in its standard library, and the ports take no crates, so
both write it by hand: a streaming writer with ECMAScript's escapes and
Number::toString's shortest, closest digits, and for `jsontransform` a
recursive-descent parser into a generic tree (C: a tagged union in a per-run arena,
objects as members in insertion order; Rust: serde_json's `Value` shape,
`Obj(Vec<(String, Value)>)`). C finds the digits with `snprintf` and `strtod`, the
first of 15, 16 and 17 that reads back, from one digit below `DBL_MIN` and trying the
next decimal up at a power of two; Rust takes `{:e}`'s digits and breaks a tie between
two shortest candidates to even, as V8 does. Both match Node's `JSON.stringify` on
654,093 doubles and write each case's text byte for byte as Node does. The digit
search is about 80% of native C's time on `stringify` (3.2 of 4.0 ms), so the C rows
there measure libc's float formatting as much as the writer; a formatter of the Ryu
or Grisu kind would take several hundred lines more. Zig has both (`std.json`,
`std.HashMap`) and no port yet. `async` has no C or Rust port: neither standard
library has a promise runtime (Rust's `async` needs an executor from a crate), and an
event loop written for the port would be a different program.

`async` times itself inside an async function. Every stage settles at once, so each
sample spans awaits that settle as microtasks: the engine drains its job queue inside
the timed region and the result line prints when the last job ends. A JS engine needs
nothing new from the harness (Node, Deno and Bun keep the process alive until the
queue is empty, a shell runs its queue after the script), and the bench page's
runners await `main`. Three lanes cannot run it, each for a cause outside the harness:

- jz's WASI build (`jz-wasmtime`, `jz-w2c`, `jz-w2c2`): its microtask queue drains
  only at a JS host's export boundary, where interop calls `__jz_mt_drain`. A WASI
  command drains it neither after `_start` nor after an invoked export, so `main`'s
  promise never settles and nothing prints: `Promise.resolve(1).then(f)` never calls
  `f` under `--host wasi`. A compiler gap.
- componentize-qjs 0.5.0: QuickJS runs pending jobs only when its embedder asks, and
  neither its sync nor its async runtime asks after the exported `run` returns,
  whether `run` returns the promise or not.
- Javy 3.0.1 (a local lane): its CLI is built without the `experimental_event_loop`
  feature and traps on the pending jobs.

A first local measurement (2026-11-03, Apple M4 Max, node 25.9, deno 2.6.7, bun 1.3.14;
`node bench/bench.mjs --cases=… --targets=jz,v8,deno,bun,jsc,as,rust-wasm,go-wasm,tinygo
--paired=4 --paired-targets=jz,v8,deno,bun`) is not reference evidence: the load
average stood at 33 to 37 from other work. Columns are JZ's time over each engine's,
the median of the paired rounds (above 1, JZ is slower); `fastest port` is the
fastest wasm port's time.

| case | JZ | ÷ Node | ÷ Deno | ÷ Bun | JSC | fastest port |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `stringify` | 16.81 ms (DIFF) | 7.23 | 7.57 | 10.75 | 1.50 ms | Go → wasm 28.13 ms |
| `jsontransform` | 3.64 ms | 1.07 | 1.35 | 1.89 | 1.53 ms | Go → wasm 57.83 ms |
| `mapstr` | 18.39 ms | 1.97 | 3.38 | 2.81 | 5.30 ms | Rust → wasm 5.54 ms |
| `mapint` | 14.14 ms | 1.49 | 1.71 | 2.27 | 3.57 ms | Rust → wasm 7.88 ms |
| `mapobj` | 5.01 ms | 1.60 | 1.61 | 2.47 | 1.50 ms | AssemblyScript 1.54 ms |
| `setops` | 11.01 ms | 1.95 | 2.88 | 4.38 | 2.11 ms | Rust → wasm 7.71 ms |
| `async` | 11.70 ms | 6.30 | 6.21 | 10.76 | 1.54 ms | – |

JZ leads no case here; these are open gaps, not claims. `stringify`'s JZ row is
wrong as well as slow: the host build (`alloc: false`, optimize 2 and up) reads past
the end of a string from a module-level string table in `JSON.stringify`, so lines
run on into the static data after it; its WASI builds answer correctly (jz → wasm2c
5.40 ms). `async` stays 4.5 to 10 times Node's time whichever part is removed (the
rejections, the per-line awaits, `Promise.all`), so the cost is in every await: the
compiler reports the promise record's layout lost (joined with an unknown value), so
the runtime reads its fields by name, and nothing an await allocates is reclaimed
within the call (420 MB peak RSS against Node's 58.5 MB). `mapstr` reads its session
records' fields by name where they come out of `Map.get` and a `Map`'s entries.

The C and Rust ports, measured later the same day on the same machine (load average 18
to 27; `--targets=jz,nat,c-wasm,rust,rust-wasm --paired=2`), the existing Rust ports of
`mapstr`, `mapint` and `setops` among them. JZ leads both wasm ports on `jsontransform`
and trails them on every `Map` and `Set` case; its `stringify` row is wrong (above), so
it has no ratio:

| case | JZ | C → wasm | Rust → wasm | JZ ÷ fastest wasm | native C | native Rust |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `mapstr` | 7.18 ms | 3.88 ms | 2.80 ms | 2.63 | 2.75 ms | 2.24 ms |
| `mapint` | 5.21 ms | 2.11 ms | 3.21 ms | 2.64 | 1.88 ms | 2.73 ms |
| `setops` | 4.97 ms | 4.31 ms | 4.22 ms | 1.33 | 3.58 ms | 3.40 ms |
| `mapobj` | 2.13 ms | 687 µs | 1.05 ms | 3.42 | 516 µs | 905 µs |
| `stringify` | 5.47 ms (wrong) | 14.2 ms | 2.72 ms | – | 4.35 ms | 1.62 ms |
| `jsontransform` | 1.98 ms | 5.12 ms | 2.12 ms | 0.94 | 1.11 ms | 2.22 ms |

### Perry's suite: a JSON round trip and an array's element kinds

Three cases come from [Perry's benchmark suite](https://github.com/PerryTS/perry/tree/main/benchmarks/suite)
(PerryTS/perry, MIT), which Perry's author suggested as ground the corpus lacked:
`jsonroundtrip` is its `bench_json_roundtrip.ts`, `arraynumeric`
`bench_numeric_array_numeric.ts` and `arraydowngrade` `bench_numeric_array_downgrade.ts`.
Each keeps Perry's algorithm, sizes and data as written. The harness's timing replaces
Perry's `Date.now()` around one run (the array cases) or 50 round trips
(`jsonroundtrip`): the median of 21 samples after 3 warm-ups (5 for `jsonroundtrip`),
each sample one run of an array case or one round trip. The checksums fold more than Perry's: `jsonroundtrip` folds
Perry's sum (each run's parsed length and text length), then every UTF-16 code unit of
the last run's text; the array cases fold every timed run's result, then every slot of
one more run's array (a number as itself, the object by its field, the string by its
length). For that extra run the mutation takes the array its run builds as a
parameter, where Perry's one function builds and mutates; both stay in the timed
region. `jsontransform` parses, reshapes and writes; `jsonroundtrip` is the plain round
trip of a generic value with no logic between, its writer bound by Number::toString on
the 9,999 floats `i * 3.14159`, of up to 17 digits each.

Ports, each reproducing its case's checksum natively and as wasm:

- C (`nat`, `c-wasm`): `jsonroundtrip` takes `jsontransform.c`'s parser and writer
  unchanged (a C port is one file, so the helpers are copied, not shared); the array
  cases are growable buffers that `realloc` doubles, `arraydowngrade`'s of a tagged
  union (a double, an object pointer, a string) whose add tests the tag and adds to a
  number in place, concatenating a string or the object's string form as JS's `+` would.
- Rust (`rust`, `rust-wasm`): `jsontransform.rs`'s parser and writer; a `Vec<f64>`; a
  `Vec` of an enum `Num(f64)`, `Obj(Box<Obj>)`, `Str(String)`.
- Go (`go`, `go-wasm`, `tinygo`): `encoding/json` over tagged structs, as
  `jsontransform.go` has it (a `[]any` of `map[string]any` would write each object's
  keys sorted); a `[]float64`; a `[]any` of `float64`, `*Obj` and `string` with a type
  switch, where storing a `float64` in an interface boxes it, so every sum allocates.
- AssemblyScript (`as`): the array cases, an `Array<f64>` and an `Array` of a
  kind-tagged flat class (`shapes.as.ts`'s idiom). The stub runtime frees nothing, so
  each sum goes into its slot's own cell: a fresh cell for every sum would allocate
  6.25 million cells a run. No `jsonroundtrip`: AssemblyScript has no JSON in its
  standard library, as for the JSON pair.
- Goose ports all three and Bend the array cases (native contenders, described under
  Targets); Bend has no `jsonroundtrip`, whose numbers are f64.
- Zig, MoonBit and Tov have none.

A local measurement (2026-11-03, Apple M4 Max, load average 10 to 14 from other work;
node 25.9, deno 2.6.7, bun 1.3.14, jsvu's jsc shell, Porffor alpha 19;
`node bench/bench.mjs --cases=jsonroundtrip,arraydowngrade,arraynumeric
--targets=jz,v8,deno,bun,jz-wasmtime,jz-w2c,nat,c-wasm,rust,rust-wasm,go,go-wasm,as,goose,bend
--paired=4`, then `--targets=jz,v8,jsc,porf-native --paired=4`) is not reference
evidence. Every lane answered its case's reference checksum. Columns are JZ's time
over each lane's, the median of the paired rounds (below 1, JZ leads). The TinyGo lane
did not run: TinyGo 0.34 here takes Go 1.19 to 1.23, and Go is 1.26.

| case | JZ | ÷ Node | ÷ Deno | ÷ Bun | ÷ JSC | ÷ C → wasm | ÷ Rust → wasm | ÷ AS | ÷ Go → wasm | ÷ Porffor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `jsonroundtrip` | 3.21 ms | 0.67 | 0.79 | 0.86 | 1.08 | 0.12 | 0.35 | – | 0.06 | 0.14 |
| `arraynumeric` | 2.26 ms | 0.64 | 0.75 | 0.85 | 0.88 | 1.11 | 0.58 | 0.29 | 0.32 | 0.07 |
| `arraydowngrade` | 20.8 ms | 5.43 | 6.49 | 6.06 | 6.12 | 1.53 | 3.77 | 2.27 | 0.06 | 0.70 |

JZ's builds at each optimize level and for WASI, each over Node's time in the same
4 paired rounds (the host builds through `compileJzAt`, the WASI builds through the CLI
and run under node's WASI), with the wasmtime and wasm2c rows of the run above and the
bytes of each build:

| case | -O2 (default) | -O3 (speed) | -Os (size) | WASI -O2 | WASI -O3 | wasmtime | wasm2c |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `jsonroundtrip` | 0.56, 35.9 kB | 0.54, 41.2 kB | 0.72, 24.0 kB | 0.66 | 0.68 | 4.52 ms | 3.42 ms |
| `arraynumeric` | 0.48, 8.9 kB | 0.57, 7.1 kB | 2.18, 1.8 kB | 0.48 | 0.45 | 2.68 ms | 1.21 ms |
| `arraydowngrade` | 6.96, 28.0 kB | 5.23, 30.5 kB | 9.78, 14.7 kB | 6.42 | 4.67 | 20.2 ms | 13.7 ms |

`jsonroundtrip` leads every V8-family engine, Bun, every wasm port and Porffor, and
trails the jsc shell by 8%; Goose's native build, whose json module finds the digits
with Ryu's digit loop, is the fastest row (1.81 ms). Perry's notes put perry-wit at 1.62×
Node's time on this program, measured on its own machine and harness, not this one.
JZ's WASI builds peak at 196 MB (wasm2c) and 209 MB (wasmtime) against the host
build's 76 MB. `arraynumeric` leads every engine and every wasm port but C → wasm
(1.11×): JZ holds the array unboxed and presized, and its increment stores each sum
through a NaN-canonicalizing select, where clang's loop loads, adds and stores; its
size build runs 2.2× Node's time. `arraydowngrade` is the gap: `arr[i] + 1` over slots
the compiler sees as number, object or string is the dynamic add, in a loop that may
allocate (a string slot would concatenate), so each element also pays the in-loop
collector's heap and iterator tests, a forwarding check of the array's header, a
bounds and a hole test, where every engine speculates on the small integers it has
seen. `--why` adds that the mutation keeps its memory (`kept on a call that runs an
escape: grows arr`): a store `arr[i] =` under a constant bound, not `arr.length`, may
lengthen the array. Go's boxed `[]any` makes its row the slowest, 332 ms a run on wasm.
All three are listed in `PENDING_CASES` (`test/bench-claims.js`) until JZ leads.

### watr — WAT-to-wasm compiler on small corpus

| target | median | ×v8 | size | parity |
| --- | ---: | ---: | ---: | --- |
| V8 (node) raw JS | 0.86 ms | 1.00× | 2.6 kB | ok |
| **JZ → V8 wasm** | **1.14 ms** | **0.76×** | **301.5 kB** | **ok** |

JZ is 1.30× slower than V8 raw JS on this large compiler bundle. The 284 kB
artifact contains the jz-compiled watr parser, encoder, and optimizer; V8's JIT
has the advantage of profile-guided tiering on a long-running compiler.

### Compiler-workload native coverage: JS→native compilers and the no-EH build variant

The compiler workloads (`jz`, `watr`, `jessie`) run through the same native
lanes as the smaller kernels. scriptc 0.4.6's type checker rejects the `jz` and
`jessie` bundles, and `watr` stops at `new BigInt64Array` (2026-10-30 run
above). Porffor alpha 19 compiles them; `jessie` now runs with the oracle's
checksum at 5.7× JZ's time, and the others fail at runtime (2026-11-02 run
above):

| case | Porffor alpha 19 runtime error |
| --- | --- |
| `jz` | not rerun; alpha 13: `Cannot mix BigInts and non-BigInts in numeric expressions` |
| `watr` | `Uncaught TypeError`, no message (alpha 13: `Bad export name at 5:9`) |
| `webaudio` | `Cannot get property of null` |

`results.json` keeps alpha 13's diagnostics until a reference run measures the
pin; failures do not enter speed ratios. Static Hermes runs `watr` and `jessie`
(1.91× and 9.84× JZ's time in the 2026-10-30 run) and fails `jz` and
`webaudio`, as listed there.

**No-EH build variant for the native compiler rows (`jz-w2c2`).** These cases'
compiled wasm carries a wasm-exceptions tag section (jz lowers `try`/`catch`/
bare `throw` through it), which `w2c2` does not translate. `wasm2c` does:
`scripts/native/compile.mjs` passes `--enable-exceptions` to a WABT that takes
it (1.0.42 enables it by default), so `jz-w2c` runs `jessie` and `watr`, and
leaves out only `jz`, whose graph the CLI cannot build. The `NEEDS_EH` gate
keeps `jessie`/`jz`/`watr` from `jz-w2c2` and from a wasmtime without the
exceptions proposal. `pruneUnusedThrowRuntime`
(`src/compile/index.js`) already lowers every throw to `unreachable` and
drops the tag when NO catch is reachable anywhere — but it only fires when
`userThrows` is false, and `userThrows` goes true the moment source has ANY
bare `throw` statement, even one with zero reachable `try`/`catch` (a
parser's `throw SyntaxError(...)` on malformed input, never caught by
design). An opt-in switch, `optimize: { exceptions: false }`, generalizes the
SAME lowering to fire whenever `userThrows` is the only reason it was
gated — it is not a new mechanism, just a wider gate on the existing one,
and it keeps the existing safety net (a real `try_table`/`catch`/`catch_all`
anywhere in the compiled IR — INCLUDING a bare `try { } finally { }` with no
catch clause at all, since jz's own `finally` codegen still needs an
internal catch-and-rethrow to run cleanup — unconditionally blocks it, flag
or not).

Verified empirically per case (both a static reachability check and a live
V8-Inspector exception-pause probe counting throws actually taken on each
case's real bench workload — 0/9 for `jz`, 0 for `watr`, 0 for `jessie`; the
static check is what actually decides validity, since "never taken on this
corpus" and "structurally cannot be taken" are different guarantees):

| case | verdict |
| --- | --- |
| `watr` | **wired.** Its jz-w2c-reachable graph (`watr-compile.js` → `node_modules/watr/src/{compile,encode,const,parse,util}.js`) has zero `try`/`catch`/`finally` anywhere. `--no-eh-abort` drops the tag cleanly; `jz-w2c` now runs it — `766 µs`, checksum `3419154861`, matches the reference (parity `ok`). |
| `jessie` | **not valid — stays gated.** subscript's switch-statement PARSE feature (`node_modules/subscript/feature/switch.js`, reachable from `parse`) wraps its body in a bare `try { … } finally { inSwitch-- }` — zero `catch` clauses, invisible to a source grep for `catch`, but jz's `finally` codegen still needs an internal try_table/catch(-rethrow) for the cleanup path, so the safety net correctly refuses to prune it. A genuine fix needs an EH-to-branch lowering (Emscripten-style setjmp/longjmp, or a result-code ABI threaded through every call inside a `try`) — a real compilation strategy, scoped here as a design note, not implemented. |
| `jz` | **not valid — stays gated**, for two independent reasons: (1) the self-compiled compiler's own source has genuine `try`/`catch` used as live fallback logic in hot compiler internals (`src/kind.js`'s `try { JSON.parse(src) } catch { return null }`, plus `src/compile/{narrow,emit,flow-types,analyze}.js`, `src/prepare/pre-eval.js`) — real, input-shape-dependent code, not just corpus-empirical zero; (2) independently, `jz-w2c`'s plain-CLI shell-out can't even reach codegen for this case today (needs `--resolve` for `self.js`'s bare `watr`/`watr/print` imports, and even then hits an unrelated `--host wasi` incompatibility — a `WebAssembly.*` reference inside the self-compile graph needs the `js`-host's env import). Same design-note scope as `jessie`. |

### jz×jz: the self-compile-squared row

The `jz` CASE under the `jz` TARGET is jz compiling itself (`bench/jz/jz.js`
→ `scripts/self.js`, the whole compiler) into a wasm module that, once run,
itself compiles 3 more programs 45 times over. Its prep runs in isolated
child processes, one per artifact (`bench/_lib/compile-jz-self.mjs`: the
speed build the row times, the size build the size column reads), each
under `--max-old-space-size=8192` with `memory: 65536` pages (the full wasm32
4 GiB address space) and 90 minutes of its own (`compileJzSelf` in
`bench/_lib/compile.js`), so a bad day here, an OOM or a genuine hang,
surfaces as one `{ status: 'fail', reason }` row instead of taking the whole
bench run down. The two builds once shared one process and one hour, which
they outgrew on the reference runner as the compiler grew: about 59 minutes
at a841739a, past the hour at 2c8f08ac and 825566d4 (EPYC 7763). The speed
build is about 72% of the work.

### Where the gaps live

Aggregate geomean (JZ / target):

| target | speed | size |
| --- | ---: | ---: |
| V8 (node) | **0.44×** | – |
| AssemblyScript | **0.45×** | **0.84×** |

JZ wins or ties V8 on every dense kernel case; the open V8 losses are the
self-compile rows (`watr`, `jessie`) and the deliberate deopt probes above
(`dispatch`, `shapes`, `wordcount`, `immutable`, `strbuild` — the dynamic-JS
work list). AS is beaten on speed across the shared cases except the tracked
gather/probe gaps (`dict`, `noise`, `levenshtein`) and the deopt probes
(`shapes`, `immutable`, `strbuild`; `wordcount` is a tie). On size JZ stays
within the 1.05× AS geomean release band. AS's bench ports wrap every array
access in
`unchecked()` (its baseline assumes zero bounds checking), while jz pays
real guards for JS's out-of-bounds read/write semantics.

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
  bundle. It is one of two self-compile rows (with jessie) where V8's
  profile-guided JIT tiers beat JZ's AOT wasm.
