// Bench pin tests — the competitive-regression gate.
//
// Project invariant (see docs/CONTRIBUTING.md): on the bench corpus, jz wasm is
//   • at least as fast as V8, AssemblyScript and Porffor (speed-tuned build),
//   • within the native-parity band of `clang -O3` (geomean jz/C ≈ parity), and
//   • at least as small as AssemblyScript (-Oz) and Porffor (size-tuned build).
// Plus a self-check: `wasm-opt -Oz` should not be able to meaningfully shrink
// jz's own output (any slack it finds is a codegen-size bug).
//
// This file pins what we currently achieve. A failing assertion = regression.
// `todo` entries are aspirational targets — printed for visibility, not asserted —
// and should be promoted to `win`/`tie` the moment they're reached (ratchet).
//
// Standalone runner: `npm run test:bench`. Skipped from `npm test` because
// it spawns the bench harness (~15-30 s) and needs optional toolchains
// (`asc`, `porf`, `wasm-opt`); CI installs all three (see .github/workflows/bench.yml).
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'tst'
import { ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { FLOATBEATS, moduleSrc } from '../examples/jukebox/floatbeats.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BENCH = join(ROOT, 'bench/bench.mjs')
const SIZE_SCRIPT = join(ROOT, 'scripts/bench-size.mjs')
const FUZZBENCH = join(ROOT, 'scripts/fuzz-bench.mjs')

const have = cmd => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0
const ascAvailable = have('asc')
const porfAvailable = have('porf')
const wasmOptAvailable = have('wasm-opt')
const natAvailable = have('clang')

// ── Speed pins ──────────────────────────────────────────────────────────────
//  win  — jz median strictly < target median (small headroom for noise)
//  tie  — jz median within 5% of target
//  near — jz median within 10% of target
//  todo — not yet won; printed, unasserted (next optimization candidate)
//  diff — not comparable (different checksum, e.g. tokenizer AS uses unicode tables)
//  na   — target unavailable / unable to run this case
const SPEED = {
  callback:       { v8: 'win',  as: 'win',  porf: 'todo' },
  mat4:           { v8: 'win',  as: 'win',  porf: 'todo' },
  poly:           { v8: 'win',  as: 'tie',  porf: 'todo' },
  // dot-product / multiply-accumulate reduction. JZ vectorizes it to 4 independent
  // SIMD accumulators (a fixed deterministic reassociation), beating the strict-fp
  // serial sum V8/AS/native run — by a wide margin (jz/v8 ~0.07×, jz/as ~0.03×).
  dotprod:        { v8: 'win',  as: 'win',  porf: 'todo' },
  biquad:         { v8: 'win',  as: 'win',  porf: 'todo' },
  mandelbrot:     { v8: 'tie',  as: 'tie',  porf: 'todo' },
  bitwise:        { v8: 'win',  as: 'win',  porf: 'todo' },
  tokenizer:      { v8: 'win',  as: 'diff', porf: 'todo' },
  aos:            { v8: 'win',  as: 'win',  porf: 'todo' },
  json:           { v8: 'win',  as: 'na',   porf: 'todo' },
  // in-place heapsort over a Float64Array. The sift-down loop is deliberately
  // inline in the source so the case measures typed-array loop codegen, not
  // JS engine call overhead.
  sort:           { v8: 'win',  as: 'todo', porf: 'todo' },
  // CRC-32 table hash — pure-integer kernel over a Uint8Array with an Int32Array
  // LUT, hot inner call `crc32(buf, table)`. jz beats V8 and matches `asc -O3`.
  crc32:          { v8: 'win',  as: 'tie',  porf: 'todo' },
  // ── audio + image showcase cases (cross-language, bit-exact) ──
  // bytebeat: pure-i32 one-line synthesis; jz beats the JS field, native
  // auto-vectorizes the stateless formula (so it's not in NATIVE — honest).
  bytebeat:       { v8: 'win',  as: 'win',  porf: 'na'   },
  // fft: radix-2 Cooley–Tukey; jz beats V8/AS and ties native (Rust/Zig).
  fft:            { v8: 'win',  as: 'tie',  porf: 'na'   },
  // synth: poly-sin osc + ADSR + biquad; jz is fastest of ALL targets here,
  // including native (the loop is loop-carried, so native can't vectorize either).
  synth:          { v8: 'win',  as: 'tie',  porf: 'na'   },
  // blur: separable RGBA box blur; jz beats the JS field, native SIMDs the stencil.
  blur:           { v8: 'win',  as: 'win',  porf: 'na'   },
  // ── codec / compression / hashing / ML showcase cases (cross-language, bit-exact) ──
  // hash: MurmurHash3 x86_32 — table-free multiply/rotate/xor; jz ties V8 and sits
  // at native-C parity (the integer mixing chain is jz's home turf). vs AS it's a
  // parity-class race whose median straddles 1.0× run-to-run → `near` to stay non-flaky.
  hash:           { v8: 'tie',  as: 'near', porf: 'todo' },
  // base64: 3→4 byte codec, encode+decode round-trip; pure integer shifts/masks.
  base64:         { v8: 'win',  as: 'win',  porf: 'todo' },
  // wav: PCM-16 encoder — per-sample clamp+quantize+pack; one f64 multiply (no FMA).
  // jz ~ties AS (medians straddle 1.0–1.05×) → `near` to stay non-flaky.
  wav:            { v8: 'win',  as: 'near', porf: 'todo' },
  // conv2d: int8 quantized NN conv (i32 MAC + ReLU requant); jz beats the wasm
  // field, native auto-vectorizes int8 (so it's not in NATIVE — honest).
  conv2d:         { v8: 'win',  as: 'win',  porf: 'todo' },
  // lz: LZSS greedy match finder + inflate round-trip; branchy byte twiddling.
  lz:             { v8: 'win',  as: 'tie',  porf: 'todo' },
  // qoi: QOI image codec encode+decode; loop-carried run/index/diff/luma — no
  // target can vectorize it, so it's a pure scalar-codegen race. jz lands within
  // ~5% of AS (medians straddle 1.0–1.05× run-to-run), pinned `near` to stay non-flaky.
  qoi:            { v8: 'win',  as: 'near', porf: 'todo' },
  // watr is the one large real-program case (jz compiling the watr WAT encoder —
  // string-tokenizing + byte-array emission). jz's linear-memory strings
  // structurally trail V8's native strings + JIT here, so it lands ~1.12-1.20× of
  // V8 — and the 5-run median itself floats across that band run-to-run, so even
  // `near` (1.10×) flaked. `trail` is the honest non-flaky ceiling; it still gates
  // a real regression (a jump past 1.25× fails), and watr stays in the geomean
  // (the aggregate guarantee, where jz wins decisively). The loop-bound hoist
  // already cut watr's absolute time (1.46→1.08ms); the residual gap is the string
  // substrate, not a single hotspot.
  watr:           { v8: 'trail', as: 'na',  porf: 'na'   },
}
const SPEED_TOL = { win: 1.0, tie: 1.05, near: 1.10, trail: 1.25 }
// Per-case competitive gates are tripwires; the geomean caps below are the real
// guarantee (they average out per-run jitter). A sub-millisecond microbench on a
// shared 2-core CI runner picks up enough scheduling jitter to flip a 1.0×/1.05×
// per-case gate even when jz wins comfortably in isolation (json/fft read ~0.8×
// locally yet have tripped at 1.02×/1.08× on a loaded runner). So relax the
// per-case tripwire by a jitter margin on CI — same rationale as the floatbeat
// backstop (2.0× on CI vs 1.05× local) and native-C parity being informational on
// CI. The geomean caps stay tight on CI and catch any genuine regression.
const CI_SPEED_JITTER = process.env.CI ? 1.10 : 1.0
// Aggregate speed ceiling: jz must not be slower than the field on average.
// (1.0 = parity; tighten as we win more.) Over cases with matching checksums.
const SPEED_GEOMEAN_MAX = { v8: 1.0, as: 1.0, porf: 1.10 }

// ── Native-C parity pins (jz wasm vs `clang -O3`) ────────────────────────────
// The headline guarantee: jz emits native-grade code. Measured geomean jz/C ≈
// 0.98× on the bench corpus — jz beats clang -O3 on poly/mat4/tokenizer/sort and
// ties mandelbrot/aos. `near` = jz trails native and the gap is structural, not
// a codegen regression: biquad is wasm-v1 ISA-bound (no scalar `fma` — hand-WAT
// ties it too), json is string-carrier bound. Tolerances are wider than the V8
// pins: `clang` runs in a separate process, so its medians carry more harness
// noise (aos/callback/json/crc32 are stabilised via the recheck loop below).
// aos is a `tie`, not a `win`: clang -O3 holds a ~6-7% edge on the AoS kernel —
// the jz hot loop is byte-identical to when this gate was first pinned, so the
// honest claim is parity (jz/C ≈ 1.06), not a win.
const NATIVE = {
  callback: 'tie',  mat4: 'win',     poly: 'win',  biquad: 'near',
  mandelbrot: 'tie', bitwise: 'tie', tokenizer: 'win', aos: 'tie',
  json: 'near',     sort: 'win',     crc32: 'tie', watr: 'na',
  // hash ties native C (pure-integer mix). base64/wav/lz trail clang -O3's mature
  // byte-twiddling backend, conv2d's int8 MAC is native-SIMD'd, and qoi trails by a
  // codegen margin — none claim native parity, so they sit out the NATIVE geomean.
  hash: 'tie', base64: 'na', wav: 'na', conv2d: 'na', lz: 'na', qoi: 'na',
  // jz beats `clang -O3 -ffp-contract=off` ~10× here: the multi-accumulator SIMD
  // reassociation extracts ILP the strict-fp serial sum can't. A genuine win (not
  // host-noise) — the margin dwarfs cross-substrate variance.
  dotprod: 'win',
}
const NATIVE_TOL = { win: 1.05, tie: 1.20, near: 1.50 }
// Aggregate guarantee: jz geomean stays within the native-parity band of C.
const NATIVE_GEOMEAN_MAX = 1.05

// ── Size pins (jz `optimize:'size'` vs AS `-Oz --converge` and Porffor) ─────
//  win — jz strictly smaller    tie — within 5%    todo — not yet (unasserted)
// jz now runs ~1% larger than `asc -Oz` (geomean) on the kernels; only `biquad`,
// `mat4`, `tokenizer` still trail (~1.1–1.2×). wasm-opt finds ~25-30% slack —
// single-use runtime-helper inlining + merging `$f$exp` wrappers is the next lever.
// porf bundles a JS runtime, so jz is ~20× smaller there; that pin is a backstop.
const SIZE = {
  callback:       { as: 'win',  porf: 'win' },
  mat4:           { as: 'todo', porf: 'win' },
  poly:           { as: 'win',  porf: 'win' },
  biquad:         { as: 'todo', porf: 'win' },
  mandelbrot:     { as: 'win',  porf: 'win' },
  bitwise:        { as: 'win',  porf: 'win' },
  tokenizer:      { as: 'todo', porf: 'win' },
  aos:            { as: 'win',  porf: 'win' },
  json:           { as: 'na',   porf: 'win' },
  sort:           { as: 'tie',  porf: 'win' },
  crc32:          { as: 'win',  porf: 'win' },
  dotprod:        { as: 'win',  porf: 'win' },
  // Integer kernels: jz wasm is smaller than AS. Transcendental-heavy pipelines
  // (synth's poly-sin, fft's twiddles) emit more wasm than AS's lean output —
  // tracked as `todo` (printed, unasserted), not a size-parity claim.
  bytebeat:       { as: 'win',  porf: 'win' },
  fft:            { as: 'todo', porf: 'win' },
  synth:          { as: 'todo', porf: 'win' },
  // blur is a SPEED kernel — its win is throughput (vectorized: ~9× V8, ~5× AS),
  // not size. The size-preset build is scalar (vectorizer off) and jz's RGBA-stencil
  // scaffolding lowers ~1.35× AS's lean -Oz output (wasm-opt finds <10% slack, so it's
  // jz's codegen shape, not bloat). Honest `todo` like synth/fft, not a size-win claim.
  blur:           { as: 'todo', porf: 'win' },
  // Integer codec/hash/ML kernels: jz size-preset wasm is smaller than AS -Oz.
  hash:           { as: 'win',  porf: 'win' },
  base64:         { as: 'win',  porf: 'win' },
  wav:            { as: 'win',  porf: 'win' },
  conv2d:         { as: 'win',  porf: 'win' },
  // lz/qoi carry larger match-finder / codec state machines than AS's lean -Oz
  // output — honest `todo` (printed, unasserted), not a size-parity claim.
  lz:             { as: 'todo', porf: 'win' },
  qoi:            { as: 'todo', porf: 'win' },
  watr:           { as: 'na',   porf: 'na'  },
}
const SIZE_TOL = { win: 1.0, tie: 1.05 }
const SIZE_GEOMEAN_MAX = { as: 1.05, porf: 0.40 }  // jz/target geomean ceiling; ratchet `as` toward 1.0 (currently ~1.01×)
// `wasm-opt -Oz` slack budget: jz_opt / jz_raw must stay ≥ this (wasm-opt may
// remove ≤ (1-x) of jz output). Aspirational target: 0.95+. Current baseline
// with margin — shrink the budget as codegen tightens.
const WASMOPT_SLACK_MIN = 0.70

// Absolute byte backstop — catches gross codegen bloat independent of competitors.
// (Sizes here are the default-optimize bench.mjs build, not `optimize:'size'`.)
// `watr` pin is calibrated against the current watr lib version pinned in package.json:
// it sat ~205 kB at watr 4.6.10; the STR_INTERN_BIT machinery (per-string
// cached-hash headers + the literal-eq inline at every tag-compare site) costs
// ~26 kB at level 'speed' and is what flipped the watr CASE to beating V8 —
// deliberate speed-for-bytes, 'size' preset keeps it all off. When jz codegen
// tightens, ratchet this down rather than letting it drift up silently.
// bytebeat: the 16-wide ramp-map SIMD store (5c00cab) traded ~240 B for a ~1.4×
// throughput win that put it ahead of native clang/rustc -O3 — deliberate
// speed-for-bytes, like the watr STR_INTERN pin above. The vectorized output is
// wasm-opt-tight (passes the slack gate), so this is genuine SIMD code, not bloat.
// blur: the channel-reduce vectorizer (default-on at speed) SIMDs the RGBA box-filter
// accumulation — ~84 f64x2/i32x4 ops that buy ~9× V8 / ~5× AS throughput. The
// default-optimize build measured here is now the vectorized one (was ~2300 B scalar
// when blur landed); same deliberate speed-for-bytes trade as bytebeat. Ratchet down
// as codegen tightens.
// conv2d: the int8-MAC vectorizer (i8x16/i16x8 widening multiply → i32x4 accumulate,
// ~409 SIMD ops) buys a measured 5× speedup (0.91 ms vec vs 4.51 ms scalar, bit-exact)
// and is what puts jz ~10× ahead of V8. The vectorized build is wasm-opt-tight (slack
// 0.73 ≥ 0.70 — wasm-opt -Oz only reaches 3864 B), so this is genuine SIMD, not bloat;
// the old 3600 B budget was set for the ~2640 B scalar build and never updated when the
// SIMD landed. Same deliberate speed-for-bytes trade as bytebeat/blur. Ratchet down as
// codegen tightens.
const SIZE_BUDGET = {
  callback: 1850, mat4: 3400, poly: 1750, biquad: 4550, mandelbrot: 1500,
  bitwise: 1700, tokenizer: 2400, aos: 2500, json: 12500, sort: 2200, crc32: 1750,
  dotprod: 1450, bytebeat: 1600, fft: 3000, synth: 9000, blur: 3600, watr: 245000,
  hash: 1500, base64: 2300, wav: 2050, conv2d: 5600, lz: 9200, qoi: 10500,
}

// ── Fastest-wasm claim (AGENTS.md §Performance claims) ───────────────────────
// jz must be the fastest WASM producer on every case — ahead of clang→wasm, rustc→wasm,
// tinygo→wasm, AssemblyScript, Porffor (native clang -O3 is the only allowed-faster target).
// WASM_RIVALS are the wasm-emitting competitors; for each case jz's median must be ≤ the BEST
// rival's (within tolerance) UNLESS the case is in WASM_TODO — the explicit, shrinking gap list.
// A case that leaves the lead set (regresses below a rival) trips the gate; closing a WASM_TODO
// case (jz takes the lead) should delete it here. This is the ratchet behind the headline claim.
const wasmRivalAvail = { 'c-wasm': natAvailable, 'rust-wasm': have('rustc'), 'go-wasm': have('tinygo'), as: ascAvailable, porf: porfAvailable }
const WASM_RIVALS = ['c-wasm', 'rust-wasm', 'go-wasm', 'as', 'porf'].filter(t => wasmRivalAvail[t])
// Cases where a wasm rival is currently faster than jz — the gap to close (general techniques,
// not per-bench tweaks; see AGENTS.md). Each notes who leads and why; delete on overtake.
// Root causes below are MEASURED, not assumed — each was verified against the emitted WAT, and the
// once-obvious fixes (param-distinctness for mat4, etc.) were ruled out by experiment. These are the
// genuinely-hard tail; each needs a new vectorizer pass or has no jz-side fix. Don't re-chase the
// disproven hypotheses.
const WASM_TODO = {
  // noise: WON (84af634). The "tighter scalar shape" the disproven-SLP note called for turned out
  // to be branchless if→select on the gradient sign-flips `(h&1)===0 ? x : -x` — 3245→1299µs, now
  // the fastest wasm (0.90× rust). (SLP stays disproven: the 4 corners need different per-lane
  // inputs, hand-vectorized perlin measured 65% SLOWER. Don't re-chase the quad-grad SLP.)
  fft:      'FMA-parity floor, ~1.05× behind rust-wasm: jz keeps the butterfly NON-fused (mul then add) so its checksum stays bit-identical to JS/V8 (the differential contract), while rust-wasm auto-FMAs the mul-add for the ~5%. Closing it needs either butterfly f64x2 vectorization (same-twiddle b-operands across a stage) or accepting an FMA parity class for fft — the latter breaks valid-jz=valid-JS, so NOT a free win.',
  raytrace: 'residual SCALAR-codegen-quality gap (1.24× rust, was 1.83×). Alias-analysis LICM (477624a) already hoisted the 32 read-only sphere loads out of the pixel loop — raytrace now BEATS c-wasm. The remaining gap is rust`s tight 0-SIMD scalar (86 f64.mul/46 add/10 sqrt; clang does NOT autovectorize the sphere loop). The |center|² arithmetic-hoist would buy ~14% (ceiling ~1.08× rust, measured) but is blocked by unroll SCRATCH-SHARING ($ox set 8× across the unrolled spheres → multi-def, not hoistable by assignment-motion); it needs scalar-renaming of unrolled scratch AND still wouldn`t beat rust. Earlier-disproven: SLP (rust is 0-SIMD), unroll-bloat (staying-a-loop measured SLOWER 3.19 vs 3.03 ms). The floor is LLVM scalar instruction-selection/regalloc, which V8`s wasm tier caps anyway.',
  nqueens:  'NO jz codegen fix: solve() is already optimal i32 (clean tail recursion, 0 f64, tight bitmask loop). Gap is LLVM/rustc interprocedural recursion opts (tail-duplication/inlining) jz does not do.',
  mat4:     'fundamental SCALAR-codegen-quality gap. MEASURED: jz`s f64x2-vectorized form (48 splats + 24 relaxed_madd) is FASTER than its own scalar (34 vs 44 ms in-harness) — so disabling vectorization REGRESSES it, and "keep vectors end-to-end" is the wrong lever. The rival proves it: rust-wasm`s winning mat4 is 0-SIMD tight scalar (70 f64.mul / 83 add) that beats jz`s vectorized form. wasm-opt -O3 only buys jz ~2% (34.5 vs 35.3 ms), so the slack is already gone — the residual is LLVM`s scalar instruction-selection/regalloc vs jz→V8, which no jz vectorizer or peephole closes.',
  qoi:      'loop-carried run/index/diff state — scalar codegen race, clang/rustc lead ~1.1× (within CI jitter band).',
  dict:     'open-addressing linear-probe hash table — AS leads ~1.09×. NOT a narrowing leak: the hot insert/probe/lookup loop is verified clean i32 (0 trunc_sat / 0 f64.convert / 0 reinterpret in $runKernel; the 2 f64.const-nan are discarded void-insert returns, the module f64 is all in benchlib). Same scalar-codegen-race class as qoi — the probe loop`s branch/bounds quality, no jz-side narrowing fix.',
}
const WASM_LEAD_TOL = 1.05  // jz median ≤ best-rival × this counts as "leads" (microbench jitter band)

// ── Run the speed harness ───────────────────────────────────────────────────
// Full corpus (no --cases): the fastest-wasm claim is gated on EVERY case, not a curated
// subset. The per-target v8/as/porf SPEED table + its geomean stay scoped to their own keys.
const speedTargets = ['v8', 'jz', ...(natAvailable ? ['nat'] : []), ...WASM_RIVALS]
console.log(`bench: speed — full corpus × {${speedTargets.join(',')}}…`)
const speedOut = execFileSync('node', [BENCH, `--targets=${speedTargets.join(',')}`], { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })

const SIZE_UNIT = { B: 1, kB: 1024, MB: 1024 * 1024 }
const TARGET_BY_NAME = {
  'jz → V8 wasm': 'jz', 'V8 (node)': 'v8',
  'AssemblyScript (asc -O3)': 'as', 'Porffor': 'porf',
}
function parseBenchOutput(text) {
  const parsed = {}
  let cur = null
  for (const line of text.split('\n')) {
    const header = line.match(/^# .* \(([^)]+)\)$/)
    if (header) { cur = header[1]; parsed[cur] = {}; continue }
    if (!cur) continue
    const run = line.match(/^\[run\]\s+(\w[\w-]*)\s+.*…\s*(\d+) µs\s+cs=(-?\d+)/)
    if (run) { parsed[cur][run[1]] = { medianUs: +run[2], checksum: (+run[3]) >>> 0 }; continue }
    const row = line.match(/^ {2}(jz → V8 wasm|V8 \(node\)|AssemblyScript \(asc -O3\)|Porffor)\s+[\d.]+ ms.*?\s(\d+(?:\.\d+)?) (B|kB|MB)\s+(\w+)\s*$/)
    if (row) {
      const tid = TARGET_BY_NAME[row[1]]
      const r = parsed[cur][tid]
      if (r) { r.sizeBytes = Math.round(+row[2] * SIZE_UNIT[row[3]]); r.parity = row[4] }
    }
  }
  return parsed
}
const runs = parseBenchOutput(speedOut)
// Cases that actually ran (full corpus minus whatever the harness skipped). The fastest-wasm
// gate iterates these; the curated v8/as/porf SPEED table iterates its own keys (∩ runs).
const speedCases = Object.keys(runs)

// These cases' medians are noisy run-to-run — take the median of a few extra
// samples so the gate reflects steady-state, not whichever scheduler hiccup
// happened to land on the single bench.mjs invocation above.
const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const recheckTargets = `v8,jz${natAvailable ? ',nat' : ''}`
for (const id of ['watr', 'sort', 'crc32', 'callback', 'json', 'aos', 'hash', 'base64']) {
  if (!speedCases.includes(id) || !runs[id]?.v8 || !runs[id]?.jz) continue
  const s = { v8: [runs[id].v8.medianUs], jz: [runs[id].jz.medianUs] }
  if (runs[id].nat) s.nat = [runs[id].nat.medianUs]
  for (let i = 1; i < 5; i++) {
    const x = parseBenchOutput(execFileSync('node', [BENCH, `--cases=${id}`, `--targets=${recheckTargets}`], { encoding: 'utf8', cwd: ROOT }))
    if (x[id]?.v8?.medianUs) s.v8.push(x[id].v8.medianUs)
    if (x[id]?.jz?.medianUs) s.jz.push(x[id].jz.medianUs)
    if (s.nat && x[id]?.nat?.medianUs) s.nat.push(x[id].nat.medianUs)
  }
  runs[id].v8.medianUs = median(s.v8); runs[id].jz.medianUs = median(s.jz)
  if (s.nat) runs[id].nat.medianUs = median(s.nat)
}

// ── Run the size harness ────────────────────────────────────────────────────
console.log('bench: size — compiling jz/AS/porf + wasm-opt self-check…')
const sizeOut = execFileSync('node', [SIZE_SCRIPT, '--json'], { encoding: 'utf8', cwd: ROOT })
const sizes = {}  // id → { jz, jzOpt, as, porf }
for (const line of sizeOut.split('\n')) {
  const m = line.match(/^SIZE (\S+) jz=(\d*) jz_wasmopt=(\d*) as=(\d*) porf=(\d*)/)
  if (m) sizes[m[1]] = { jz: +m[2] || null, jzOpt: +m[3] || null, as: +m[4] || null, porf: +m[5] || null }
}

// ── Snapshot table ──────────────────────────────────────────────────────────
const fmtMs = us => us == null ? '   —  ' : (us / 1000).toFixed(2).padStart(6)
const fmtKb = b => b == null ? '   —  ' : b < 1024 ? `${b} B`.padStart(7) : `${(b / 1024).toFixed(1)} kB`.padStart(7)
const mark = { win: '✓', tie: '≈', near: '~', todo: '✗', diff: '?', na: ' ' }
const ratioCell = (claim, num, den) => num != null && den != null ? `${mark[claim]} ${(num / den).toFixed(2)}×` : `${mark[claim]}  —`

console.log('\nbench snapshot (speed = median ms, size = wasm bytes; "×" = jz/target):')
console.log(`  ${'case'.padEnd(13)}  ${'jz_ms'.padStart(6)}  spd.v8       spd.C        spd.as       spd.porf     ${'jz_sz'.padStart(7)}  sz.AS        sz.porf      slack`)
console.log(`  ${'-'.repeat(13)}  ${'-'.repeat(6)}  -----------  -----------  -----------  -----------  ${'-'.repeat(7)}  -----------  -----------  ------`)
for (const id of Object.keys(SPEED)) {   // curated v8/as/porf/native/size table (the fastest-wasm gate covers the full corpus below)
  const r = runs[id] || {}, sz = sizes[id] || {}
  const slack = sz.jz && sz.jzOpt ? `${((sz.jzOpt / sz.jz) * 100).toFixed(0)}%` : '  — '
  console.log(`  ${id.padEnd(13)}  ${fmtMs(r.jz?.medianUs)}  ` +
    `${ratioCell(SPEED[id].v8, r.jz?.medianUs, r.v8?.medianUs).padEnd(11)}  ` +
    `${ratioCell(NATIVE[id], r.jz?.medianUs, r.nat?.medianUs).padEnd(11)}  ` +
    `${ratioCell(SPEED[id].as, r.jz?.medianUs, r.as?.medianUs).padEnd(11)}  ` +
    `${ratioCell(SPEED[id].porf, r.jz?.medianUs, r.porf?.medianUs).padEnd(11)}  ` +
    `${fmtKb(sz.jz)}  ` +
    `${ratioCell(SIZE[id].as, sz.jz, sz.as).padEnd(11)}  ` +
    `${ratioCell(SIZE[id].porf, sz.jz, sz.porf).padEnd(11)}  ${slack.padStart(5)}`)
}

const geomean = xs => xs.length ? Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length) : null
const geoSpeed = tid => geomean(Object.keys(SPEED)
  .map(id => runs[id]).filter(r => r?.jz && r?.[tid] && r.jz.checksum === r[tid].checksum)
  .map(r => r.jz.medianUs / r[tid].medianUs))
// Native-parity geomean is scoped to the cases that CLAIM parity (NATIVE keys).
// bytebeat/blur are embarrassingly-parallel kernels native auto-vectorizes — jz
// beats the JS field on them but doesn't claim native parity there, so they're
// out of the guarantee (still shown per-case in the table and on the page).
const geoNative = () => geomean(Object.keys(NATIVE)
  .filter(id => NATIVE_TOL[NATIVE[id]] && runs[id]?.jz && runs[id]?.nat && runs[id].jz.checksum === runs[id].nat.checksum)
  .map(id => runs[id].jz.medianUs / runs[id].nat.medianUs))
// Size-parity geomean is scoped to the cases that CLAIM it (SIZE win/tie). jz's
// transcendental pipelines (synth, fft) emit more wasm than AS's lean output —
// `todo`, not a parity claim — so they're out of the guarantee but printed.
const geoSize = tid => geomean(Object.keys(SIZE)
  .filter(id => SIZE_TOL[SIZE[id][tid]] && sizes[id]?.jz && sizes[id]?.[tid])
  .map(id => sizes[id].jz / sizes[id][tid]))
const geoSlack = geomean(Object.values(sizes).filter(s => s.jz && s.jzOpt).map(s => s.jzOpt / s.jz))
const gV8 = geoSpeed('v8'), gNatT = geoNative(), gAsT = geoSpeed('as'), gPorfT = geoSpeed('porf')
const gAsS = geoSize('as'), gPorfS = geoSize('porf')
console.log(`\n  geomean speed jz/target:  v8 ${gV8?.toFixed(3) ?? '—'}×   C ${gNatT?.toFixed(3) ?? '—'}×   as ${gAsT?.toFixed(3) ?? '—'}×   porf ${gPorfT?.toFixed(3) ?? '—'}×`)
console.log(`  geomean size  jz/target:  as ${gAsS?.toFixed(3) ?? '—'}×   porf ${gPorfS?.toFixed(3) ?? '—'}×   wasm-opt slack ${geoSlack?.toFixed(3) ?? '—'}×`)
console.log()

// ── Assertions: speed ───────────────────────────────────────────────────────
for (const [id, claims] of Object.entries(SPEED)) {
  for (const tid of ['v8', 'as', 'porf']) {
    const claim = claims[tid]
    if (!SPEED_TOL[claim]) continue
    if (tid === 'as' && !ascAvailable) continue
    if (tid === 'porf' && !porfAvailable) continue
    test(`bench: speed ${id} jz ${claim} vs ${tid}`, () => {
      const r = runs[id]
      ok(r?.jz && r?.[tid], `missing data: jz=${!!r?.jz} ${tid}=${!!r?.[tid]}`)
      ok(r.jz.checksum === r[tid].checksum, `${id}: checksum mismatch jz=${r.jz.checksum} ${tid}=${r[tid].checksum} — pin should be 'diff'`)
      const ratio = r.jz.medianUs / r[tid].medianUs
      const limit = SPEED_TOL[claim] * CI_SPEED_JITTER
      ok(ratio <= limit, `${id}: jz ${(r.jz.medianUs / 1000).toFixed(2)}ms / ${tid} ${(r[tid].medianUs / 1000).toFixed(2)}ms = ${ratio.toFixed(3)}× > ${claim} limit ${limit.toFixed(3)}×`)
    })
  }
}
for (const tid of ['v8', 'as', 'porf']) {
  if (tid === 'as' && !ascAvailable) continue
  if (tid === 'porf' && !porfAvailable) continue
  const g = geoSpeed(tid)
  if (g == null) continue
  test(`bench: speed geomean jz/${tid} ≤ ${SPEED_GEOMEAN_MAX[tid]}×`, () => {
    ok(g <= SPEED_GEOMEAN_MAX[tid], `geomean jz/${tid} = ${g.toFixed(3)}× > ${SPEED_GEOMEAN_MAX[tid]}×`)
  })
}

// ── Assertions: jz is the fastest WASM, per case (the headline claim) ────────
// THE bar (AGENTS.md §Performance claims): on EVERY case jz must lead every available wasm
// rival (within microbench jitter). No allowlist — a rival faster anywhere FAILS the gate.
// WASM_TODO doesn't excuse a case; it only annotates the failure with the general technique
// that closes it, so a red gate reads as a work list. Delete a WASM_TODO entry once it leads.
{
  const bestRival = (id) => {
    let best = null, who = null
    for (const t of WASM_RIVALS) {
      const r = runs[id]?.[t]
      if (!r || r.checksum !== runs[id]?.jz?.checksum) continue   // unavailable / different checksum → not comparable
      if (best == null || r.medianUs < best) { best = r.medianUs; who = t }
    }
    return best == null ? null : { us: best, who }
  }
  for (const id of speedCases) {
    const jz = runs[id]?.jz; if (!jz) continue
    const br = bestRival(id); if (br == null) continue   // no comparable wasm rival ran (e.g. self-host rows)
    test(`bench: fastest-wasm ${id} (jz ≤ every wasm rival)`, () => {
      const ratio = jz.medianUs / br.us
      const limit = WASM_LEAD_TOL * CI_SPEED_JITTER
      const why = WASM_TODO[id] ? ` [known gap → ${WASM_TODO[id]}]` : ''
      ok(ratio <= limit, `${id}: jz ${(jz.medianUs / 1000).toFixed(2)}ms TRAILS ${br.who} ${(br.us / 1000).toFixed(2)}ms = ${ratio.toFixed(3)}× > ${limit.toFixed(3)}× — not the fastest wasm.${why}`)
    })
  }
}

// ── Native-C parity (the headline guarantee) ────────────────────────────────
// jz wasm vs `clang -O3` is a CROSS-SUBSTRATE comparison: jz runs as wasm in
// V8, clang emits a native binary. Their *ratio* is a property of the host —
// V8's wasm tier-up, the CPU's auto-vectorisation width — not of jz's codegen.
// The V8/AS/Porffor pins above stay portable because every payload there runs
// as wasm/JS in the same process on the same machine; the native ratio does
// not. On dev hardware jz holds parity (geomean jz/C ≈ 0.96×); the identical
// jz output reads 1.1–1.3× on a shared CI runner purely from the runner. So
// the native ratios are PRINTED everywhere (snapshot table + geomean line
// above) but ASSERTED only off-CI, where the measurement is trustworthy — a
// native regression still shows in the snapshot and fails local test:bench.
// Per-case `near` entries (biquad, json) genuinely trail clang -O3 — they are
// regression backstops, not parity claims; the geomean is the guarantee.
const gNat = natAvailable ? geoNative() : null
if (natAvailable && process.env.CI)
  console.log(`  native-C parity: informational on CI (cross-substrate ratio is host-bound) — geomean jz/C ${gNat?.toFixed(3) ?? '—'}×\n`)
if (natAvailable && !process.env.CI) {
  for (const [id, claim] of Object.entries(NATIVE)) {
    if (!NATIVE_TOL[claim]) continue
    test(`bench: native ${id} jz ${claim} vs C`, () => {
      const r = runs[id]
      ok(r?.jz && r?.nat, `missing data: jz=${!!r?.jz} nat=${!!r?.nat}`)
      ok(r.jz.checksum === r.nat.checksum, `${id}: checksum mismatch jz=${r.jz.checksum} nat=${r.nat.checksum}`)
      const ratio = r.jz.medianUs / r.nat.medianUs
      ok(ratio <= NATIVE_TOL[claim], `${id}: jz ${(r.jz.medianUs / 1000).toFixed(2)}ms / C ${(r.nat.medianUs / 1000).toFixed(2)}ms = ${ratio.toFixed(3)}× > ${claim} limit ${NATIVE_TOL[claim]}×`)
    })
  }
  if (gNat != null) test(`bench: native geomean jz/C ≤ ${NATIVE_GEOMEAN_MAX}× (native-parity guarantee)`, () => {
    ok(gNat <= NATIVE_GEOMEAN_MAX, `geomean jz/C = ${gNat.toFixed(3)}× > ${NATIVE_GEOMEAN_MAX}× — jz no longer at native parity`)
  })
}

// ── Assertions: size ────────────────────────────────────────────────────────
for (const [id, claims] of Object.entries(SIZE)) {
  for (const tid of ['as', 'porf']) {
    const claim = claims[tid]
    if (!SIZE_TOL[claim]) continue
    if (tid === 'as' && !ascAvailable) continue
    if (tid === 'porf' && !porfAvailable) continue
    test(`bench: size ${id} jz ${claim} vs ${tid}`, () => {
      const s = sizes[id]
      ok(s?.jz && s?.[tid], `missing size: jz=${s?.jz} ${tid}=${s?.[tid]}`)
      const ratio = s.jz / s[tid]
      ok(ratio <= SIZE_TOL[claim], `${id}: jz ${s.jz} B / ${tid} ${s[tid]} B = ${ratio.toFixed(3)}× > ${claim} limit ${SIZE_TOL[claim]}×`)
    })
  }
}
for (const tid of ['as', 'porf']) {
  if (tid === 'as' && !ascAvailable) continue
  if (tid === 'porf' && !porfAvailable) continue
  const g = geoSize(tid)
  if (g == null) continue
  test(`bench: size geomean jz/${tid} ≤ ${SIZE_GEOMEAN_MAX[tid]}×`, () => {
    ok(g <= SIZE_GEOMEAN_MAX[tid], `geomean size jz/${tid} = ${g.toFixed(3)}× > ${SIZE_GEOMEAN_MAX[tid]}×`)
  })
}

// ── Assertions: wasm-opt self-check (codegen size slack) ────────────────────
if (wasmOptAvailable) {
  for (const id of Object.keys(SIZE)) {
    test(`bench: ${id} wasm-opt slack ≥ ${WASMOPT_SLACK_MIN}× (jz codegen not bloated)`, () => {
      const s = sizes[id]
      ok(s?.jz && s?.jzOpt, `missing wasm-opt size for ${id}`)
      const slack = s.jzOpt / s.jz
      ok(slack >= WASMOPT_SLACK_MIN, `${id}: wasm-opt -Oz cut jz output ${s.jz} B → ${s.jzOpt} B (${slack.toFixed(3)}× < ${WASMOPT_SLACK_MIN}×) — codegen leaving too much on the table`)
    })
  }
}

// ── Assertions: absolute byte backstop ──────────────────────────────────────
for (const [id, budget] of Object.entries(SIZE_BUDGET)) {
  test(`bench: ${id} jz wasm size ≤ ${budget} B (backstop)`, () => {
    const r = runs[id]
    ok(r?.jz?.sizeBytes != null, `missing size for ${id}`)
    ok(r.jz.sizeBytes <= budget, `${id}: jz wasm ${r.jz.sizeBytes} B exceeds budget ${budget} B (+${r.jz.sizeBytes - budget})`)
  })
}

// ── Size-optimized compile spot-checks (cheap, no external toolchain) ────────
const benchlibHostSource = () => {
  const src = readFileSync(join(ROOT, 'bench/_lib/benchlib.js'), 'utf8')
  return src.replace(`export let printResult = (medianUs, checksum, samples, stages, runs) => {
  console.log(\`median_us=\${medianUs} checksum=\${checksum} samples=\${samples} stages=\${stages} runs=\${runs}\`)
}`, `export let printResult = (medianUs, checksum, samples, stages, runs) => {
  env.logResult(medianUs, checksum, samples, stages, runs)
}`)
}
const sizeCompile = id => compile(readFileSync(join(ROOT, `bench/${id}/${id}.js`), 'utf8'), {
  modules: { '../_lib/benchlib.js': benchlibHostSource() },
  imports: { env: { logResult: { params: 5 } }, performance: { now: { params: 0, returns: 'number' } } },
  optimize: { smallConstForUnroll: false, scalarTypedArrayLen: 8 },
  alloc: false,
}).length
test('bench: mat4 size-optimized compile ≤ 2500 B', () => { const b = sizeCompile('mat4'); ok(b <= 2500, `mat4 size-optimized compile: ${b} B exceeds 2500 B`) })
test('bench: biquad size-optimized compile ≤ 3000 B', () => { const b = sizeCompile('biquad'); ok(b <= 3000, `biquad size-optimized compile: ${b} B exceeds 3000 B`) })

// ── Perf-fuzz: jz on-par-or-faster than V8 across RANDOM int/float/mixed programs ──
// Guards the "jz only wins on a cherry-picked corpus / via unsound i32 narrowing"
// failure mode. scripts/fuzz-bench.mjs synthesizes hot accumulation loops across
// the int→float→mixed spectrum, drops any miscompile (correctness sanity per
// program), and self-gates the per-category MEDIAN jz/V8 ratio (exits non-zero
// past 1.15×). Needs only jz — no external toolchain — so it always runs here.
// CI-sized (~7 s); `npm run bench:fuzz` runs the heavier local thesis-check.
test('bench: perf-fuzz median jz/v8 ≤ 1.15× per category (broad speed win)', () => {
  let out
  try { out = execFileSync('node', [FUZZBENCH, '--count=30', '--n=150000', '--iters=12'], { encoding: 'utf8', cwd: ROOT }) }
  catch (e) { ok(false, `perf-fuzz regression (gate exit ${e.status}):\n${e.stdout || ''}${e.stderr || ''}`); return }
  ok(/^PASS:/m.test(out), `perf-fuzz did not report PASS:\n${out}`)
})

// ── Examples corpus gate: every demo's per-frame hot path, jz vs V8 ─────────
// The kernel corpus missed the module-global-state shape (rfft 0.13×,
// diffusion 0.19×, game-of-life 0.41× — all invisible while the
// kernels stayed green) until hoistGlobalPtrOffset landed. examples/bench.mjs
// runs the SAME demo source as jz wasm vs V8 ESM and self-gates: geomean > 1
// AND every non-`opt` example ≥ 0.9× — it exits non-zero otherwise, so a
// regression in any demo (the public face of jz) trips CI, not a user.
test('bench: examples corpus — jz beats V8 per frame (geomean > 1, winners ≥ 0.9×)', () => {
  let out
  try { out = execFileSync('node', [join(ROOT, 'examples/bench.mjs')], { encoding: 'utf8', cwd: ROOT }) }
  catch (e) { ok(false, `examples perf regression (gate exit ${e.status}):\n${e.stdout || ''}${e.stderr || ''}`); return }
  ok(/✓ jz faster overall/.test(out), `examples bench did not report pass:\n${out}`)
})

// ── Floatbeat perf gate ──────────────────────────────────────────────────────
// The numeric kernel corpus never exercises closures + arrays + per-sample dispatch
// the way the jukebox floatbeats do, so a codegen regression there is invisible to it
// — e.g. the dcbb433 `__ptr_offset` cliff cost aos 4× and any object/array-read beat
// shares that pattern. Pin it: each jz-compiled floatbeat must stay at least as fast as
// V8's JS run of the same `(t)=>sample` source, measured at the player's chunk (sr/2),
// so a future slowdown trips here even while the kernel corpus stays green.
const fbMed = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const fbClamp = s => s < -1 ? -1 : s > 1 ? 1 : s
const fbTime = fn => { const ts = []; for (let k = 0; k < 13; k++) { const t = performance.now(); fn(); if (k >= 4) ts.push(performance.now() - t) } return fbMed(ts) }
const fbRatios = []
console.log('\nbench: floatbeats (jz wasm fill vs V8 JS, at jukebox chunk = sr/2):')
for (const tn of FLOATBEATS) {
  const N = Math.round(tn.sr * 0.5)
  let exports, memory
  try { ({ exports, memory } = instantiate(compile(moduleSrc(tn.body), { optimize: 3 }))) } catch { continue }
  const beat = new Function('t', 'return (' + tn.body + ')(t)')
  const jsOut = new Float64Array(N)
  const jz = fbTime(() => { const out = memory.Float64Array(new Float64Array(N)); exports.fill(out, N, 0); memory.reset() })
  const js = fbTime(() => { for (let j = 0; j < N; j++) jsOut[j] = fbClamp(beat(j)) })
  const ratio = jz / js
  fbRatios.push({ name: tn.name, ratio })
  console.log(`  ${tn.name.padEnd(24)} jz ${(jz * 1000).toFixed(0).padStart(6)}µs  v8 ${(js * 1000).toFixed(0).padStart(6)}µs  ${ratio.toFixed(2)}×`)
}
const fbGeo = fbRatios.length ? Math.exp(fbRatios.reduce((a, b) => a + Math.log(b.ratio), 0) / fbRatios.length) : null
console.log(`  geomean jz/v8 ${fbGeo?.toFixed(3) ?? '—'}×\n`)
// Aggregate guarantee: jz wins the floatbeat corpus decisively. narrowLoopBound
// (f64 loop bound → i32, unlocks SIMD on the per-sample fill loop) moved the
// corpus from ~0.6× to ~0.5× geomean / 0.21–0.78× per beat — the 0.85 ceiling
// locks that in: losing the bound-narrowing (or the vectorizer behind it)
// regresses the geomean past it even while the kernel corpus stays green.
test('bench: floatbeat geomean jz/v8 ≤ 0.85× (jz wins the jukebox corpus, SIMD fill pinned)', () => {
  ok(fbGeo != null && fbGeo <= 0.85,
    `floatbeat geomean jz/v8 = ${fbGeo?.toFixed(3)}× > 0.85× — slow beats: ${fbRatios.filter(r => r.ratio > 1).map(r => `${r.name} ${r.ratio.toFixed(2)}×`).join(', ') || 'none'}`)
})
// Per-beat backstop: catch a single beat regressing grossly (an __ptr_offset-style 4× cliff)
// that the corpus geomean would absorb. The jz/V8 per-beat ratio is host-bound on shared CI
// runners — a transcendental/allocation-heavy beat (Celesta: 9 sin + 5 exp + 4 const arrays
// per sample) runs ~1.4× there but <0.8× locally on the *identical* wasm — the same reason
// native-C parity is informational on CI. So the backstop is a gross-regression net on CI
// (2×, shared-runner noise; ratchet down as the slowest beats gain margin) and ~parity
// (1.05×) off-CI where hardware is stable — every beat runs ≤ 0.93× locally, so any beat
// merely TYING V8 on a dev machine now fails; the geomean ≤ 0.85× above is the per-corpus
// guarantee on every runner. End state: ≤ 1.0 per beat, everywhere — the faster-than-JS
// guarantee is per-program, not on-average; each compiler win should tighten these.
const fbBackstop = process.env.CI ? 2.0 : 1.05
for (const { name, ratio } of fbRatios) {
  test(`bench: floatbeat "${name}" jz ≤ ${fbBackstop}× V8 (no gross regression)`, () => {
    ok(ratio <= fbBackstop, `floatbeat ${name}: jz ${ratio.toFixed(2)}× V8 > ${fbBackstop}× — gross codegen regression`)
  })
}
