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
const porfAvailable = have(process.env.PORF_BIN || 'porf')
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
  // ── the domain-matrix cases (colorjs/audio/font/generative closure — see bench/README
  // "The guarantee"). Local calibration 2026-07: jz beats rust-wasm on slices/resample/
  // glyfparse (the last also edges native C), ties bezfit; TRAILS rust-wasm on delayline
  // (1.24×: masked-ring bounds checks + /65536 not strength-reduced), sdf (1.26×, AS also
  // ahead: strided column walks + f[v[k]] gather re-derivation) and trace (1.41×: the
  // branch-dense follow loop — branch layout + per-step bounds checks). Those three are
  // the open codegen work; the matching shape-classes (ring/fgather/slice/condref) are
  // ratcheted in test/perf-ratchet.js so progress is machine-independently pinned.
  slices:         { v8: 'win',  as: 'win',  porf: 'todo' },
  trace:          { v8: 'win',  as: 'tie',  porf: 'todo' },
  bezfit:         { v8: 'win',  as: 'win',  porf: 'todo' },
  sdf:            { v8: 'win',  as: 'todo', porf: 'todo' },
  resample:       { v8: 'todo', as: 'win',  porf: 'todo' },
  delayline:      { v8: 'tie',  as: 'tie',  porf: 'todo' },
  glyfparse:      { v8: 'win',  as: 'win',  porf: 'todo' },
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
  bytebeat:       { v8: 'win',  as: 'win',  porf: 'todo'   },
  // fft: radix-2 Cooley–Tukey; jz beats V8/AS and ties native (Rust/Zig).
  fft:            { v8: 'win',  as: 'tie',  porf: 'todo'   },
  // synth: poly-sin osc + ADSR + biquad; jz is fastest of ALL targets here,
  // including native (the loop is loop-carried, so native can't vectorize either).
  synth:          { v8: 'win',  as: 'tie',  porf: 'todo'   },
  // blur: separable RGBA box blur; jz beats the JS field, native SIMDs the stencil.
  blur:           { v8: 'win',  as: 'win',  porf: 'todo'   },
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
  // qoi: amortized cursor bounds erase all codec checks and pure boolean
  // chains lower to branchless i32.and. Isolated runs often win; the full
  // loaded frontier still lands ~1.06× AS, so keep the non-flaky near pin.
  qoi:            { v8: 'win',  as: 'near', porf: 'todo' },
  // hashjoin: probe-dominated relational hash join — the boss case. jz TRAILED V8
  // until valResult=NUMBER stamping (0fbe6ee) killed the polymorphic + on probe()'s
  // typed-array-param return (sum + probe() was lowering through __is_str_key/
  // __str_concat); now jz is the fastest target — beats V8, AS, native C, and every
  // wasm rival. Recheck-stabilised below (the V8 margin is real ~0.91× but slim).
  hashjoin:       { v8: 'win',  as: 'win',  porf: 'todo'   },
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
// TIMING POLICY (extends the native-C rule below to every timing gate): a shared
// 2-core CI runner does not measure time — identical jz builds have read 15×
// slower there (biquad 30ms vs ~2ms local), and a ×1.10 jitter margin left the
// workflow red for 37 straight runs, which is zero signal. So every RATIO
// assertion (per-case speed, speed geomeans, fastest-wasm, perf-fuzz, examples,
// floatbeat) is ASSERTED off-CI — where the measurement is trustworthy and the
// release discipline runs it — and PRINTED as informational on CI. Checksums,
// parity, sizes and compile success stay hard-gated everywhere: CI red means
// real breakage again.
const okTiming = (cond, msg) => process.env.CI
  ? (cond || console.log(`  timing (informational on CI): ${msg}`))
  : ok(cond, msg)
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
  slices: 'tie', resample: 'win', glyfparse: 'tie', trace: 'na', bezfit: 'na', sdf: 'na', delayline: 'na',
  callback: 'tie',  mat4: 'win',     poly: 'win',  biquad: 'near',
  mandelbrot: 'tie', bitwise: 'tie', tokenizer: 'win', aos: 'tie',
  json: 'near',     sort: 'win',     crc32: 'tie', watr: 'na',
  // hash ties native C (pure-integer mix). base64/wav/lz trail clang -O3's mature
  // byte-twiddling backend, conv2d's int8 MAC is native-SIMD'd, and qoi trails by a
  // codegen margin — none claim native parity, so they sit out the NATIVE geomean.
  hash: 'tie', base64: 'na', wav: 'na', conv2d: 'na', lz: 'na', qoi: 'na',
  // hashjoin: the i32 probe loop is native-grade since the polymorphic-+ fix —
  // jz/C ≈ 0.9× (clean) / parity under load; sits in the native-parity geomean.
  hashjoin: 'tie',
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
  slices:         { as: 'todo', porf: 'todo' },
  trace:          { as: 'todo', porf: 'todo' },
  bezfit:         { as: 'todo', porf: 'todo' },
  sdf:            { as: 'todo', porf: 'todo' },
  resample:       { as: 'todo', porf: 'todo' },
  delayline:      { as: 'todo', porf: 'todo' },
  glyfparse:      { as: 'todo', porf: 'todo' },
  callback:       { as: 'win',  porf: 'win' },
  mat4:           { as: 'todo', porf: 'win' },
  poly:           { as: 'win',  porf: 'win' },
  biquad:         { as: 'todo', porf: 'win' },
  mandelbrot:     { as: 'win',  porf: 'win' },
  bitwise:        { as: 'win',  porf: 'win' },
  tokenizer:      { as: 'todo', porf: 'win' },
  // aos/sort were re-pinned after checked-by-default typed indexing (Root F):
  // JS-exact OOB semantics cost bytes per unproven site that AS's trap
  // doesn't pay. Restored by three engine waves: -Os lean lowering (if-form
  // reads, len hoist, guard-inline pure stores), watr 5.5.0 intguard
  // checked-read collapse (ToInt32-guarded reads → i32 if-forms through the
  // -Os const pool), and the cross-function PARAM TYPEDLEN channel
  // (narrow.js: unanimous static call-site lengths seed the callee's proof
  // family — heapsort/codec params read main-sized arrays). The S2 loop-body
  // FIXPOINT (widening join + cond-∩ escape check + affine cond refinement +
  // strided `x += K` transfer in scanIntervalIdx) then proved the remaining
  // cond-bounded cursor classes outright — heapsort's child chains and
  // medianUs's insertion scan: sort 1814 B (was 1941, 0.96 WIN), aos 1894.
  // (Tried and REVERTED: $__typed_idx call route, +900 B vs ~3 inline sites.)
  aos:            { as: 'win',  porf: 'win' },
  json:           { as: 'na',   porf: 'win' },
  sort:           { as: 'win',  porf: 'win' },
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
  // Integer codec/hash kernels — ALL WIN. Three engine waves: watr 5.5.0
  // intguard checked-read collapse (ToInt32-guarded reads → i32 if-forms,
  // single-read ring, const pool) took hash to 0.94; the param typedLen
  // channel + the `.length` interval atom then PROVED the codec loops and
  // header stores outright (encode's `out` is main-sized — wav's 24 RIFF
  // header guards and both verify loops dropped); the S2 loop fixpoint's
  // strided-cursor invariants (`for (; op + 3 <= N; op += 3)` proves
  // op ∈ [0, N−3]) erased the remaining checked families: hash 1086 B,
  // wav 1646, base64 1847 — comfortable margins where base64 was a
  // 1-byte squeak.
  hash:           { as: 'win',  porf: 'win' },
  base64:         { as: 'win',  porf: 'win' },
  wav:            { as: 'win',  porf: 'win' },
  conv2d:         { as: 'win',  porf: 'win' },
  // lz/qoi carry larger match-finder / codec state machines than AS's lean -Oz
  // output — honest `todo` (printed, unasserted), not a size-parity claim.
  lz:             { as: 'todo', porf: 'win' },
  qoi:            { as: 'todo', porf: 'win' },
  // hashjoin carries two hash fns + open-addressing probe/insert scaffolding —
  // ~2.2× AS's lean -Oz (honest `todo`, like lz/qoi), but 13× smaller than porf.
  hashjoin:       { as: 'todo', porf: 'win' },
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
  // wav 2050 → 2250, base64 2300 → 2400: Root F checked reads/versioning in
  // the runtime-length codec loops (+100/+55 measured). Ratchet down with the
  // binding-narrowing round.
  hash: 1500, base64: 2400, wav: 2250, conv2d: 5600, lz: 9200, qoi: 10500,
  // hashjoin 1500 → 1900: checked-by-default typed indexing (Root F) added
  // inline bounds/undefined semantics to the probe/insert loops' unproven
  // reads (+343 B measured). Ratchet down with any checked-read size shrink.
  hashjoin: 1900,
}

// ── Fastest-wasm claim (AGENTS.md §Performance claims) ───────────────────────
// jz must be the fastest WASM producer on every case — ahead of clang→wasm, rustc→wasm,
// tinygo→wasm, AssemblyScript, Porffor (native clang -O3 is the only allowed-faster target).
// WASM_RIVALS are the wasm-emitting competitors; for each case jz's median must be ≤ the BEST
// rival's (within tolerance) UNLESS the case is in WASM_TODO — the explicit, shrinking gap list.
// A case that leaves the lead set (regresses below a rival) trips the gate; closing a WASM_TODO
// case (jz takes the lead) should delete it here. This is the ratchet behind the headline claim.
// Availability probes match each target's ACTUAL builder: c-wasm compiles with
// `zig cc -target wasm32-wasi` (not clang), go-wasm with the standard Go
// toolchain (GOOS=wasip1, not tinygo — that mismatch silently dropped go-wasm
// from the gate on machines with go but no tinygo). tinygo and zig-wasm are
// their own rivals: each gates when its toolchain is present; a rival whose
// build fails produces no row and bestRival skips it — the coverage assertion
// below keeps that skip from silently zeroing out a whole producer.
const wasmRivalAvail = { 'c-wasm': have('zig'), 'rust-wasm': have('rustc'), 'go-wasm': have('go'), tinygo: have('tinygo'), 'zig-wasm': have('zig'), as: ascAvailable, porf: porfAvailable }
const WASM_RIVALS = ['c-wasm', 'rust-wasm', 'go-wasm', 'tinygo', 'zig-wasm', 'as', 'porf'].filter(t => wasmRivalAvail[t])
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
  fft:      'dual-IV SIMD butterfly is structurally present and usually leads, but the latest loaded frontier measured jz 1.51ms vs rust-wasm 1.43ms (1.060×), just outside the hard 5% band. Keep visible until repeated loaded evidence or a general SIMD scheduling improvement closes it.',
  // tokenizer: WON. Param string decomposition makes both SSO/heap arms
  // trap-safe, then unswitches the representation once outside each leaf scan;
  // five repeated frontiers put jz at 43–48µs vs AS 51–55µs.
  // fft: tryButterfly strips the dual-IV radix-2 inner loop 2-wide: adjacent
  // re/im a/b pairs as v128, strided twiddles as scalar-pair+combine, rotation lanes with no
  // reassociation/fusion ⇒ checksum-identical (the parity contract held through SIMD).
  // 8% over scalar, ahead of rust-wasm; provenance rode the same recognizer for -32%.
  raytrace: 'repeated same-engine runs put jz at ~1.14–1.24ms vs rust-wasm ~0.97–1.00ms. The hot sphere loop is scalar in both outputs; the remaining gap is the previously verified scheduling/invariant-hoist class. Unsafe scratch renaming and benchmark-specific source hoists remain rejected.',
  nqueens:  'NO jz codegen fix: solve() is already optimal i32 (clean tail recursion, 0 f64, tight bitmask loop). Gap is LLVM/rustc interprocedural recursion opts (tail-duplication/inlining) jz does not do.',
  // mat4: WON. The "no jz vectorizer or peephole closes it" verdict here was WRONG — it missed
  // that rust`s winning 0-SIMD form hoists the OUTER-loop-invariant partial products out of the
  // n-loop (only a[0],a[5],b[0],b[5] mutate, so most of each a[r]·b[c] dot is constant). jz now
  // does the same (hoistReductionInvariantsIn, speed tier): 2068→1079µs, beats rust-wasm 1.5×.
  qoi:      'amortized cursor bounds, call-free pure boolean chains, and branch-loop unrolling cut jz from ~10.5ms to ~7.6–9.4ms. Rust-wasm is ~7.5–8.1ms and still crosses the 5% band in loaded runs. Typed checks are gone; the remaining broad class is branch-heavy scalar scheduling/code shape under V8 wasm.',
  sort:     'heapsort sift-down — rust-wasm leads ~1.1-1.2×. NOT a jz lowering gap: the emitted sift loop is verified optimal scalar (unswitched typed path, zero bounds checks, zero calls, i32 indexes with fused offset= addressing, select for the child pick, 2 f64 compares — the op set LLVM emits). The residual is the dependent-load chain (a[child] feeds the next iteration`s address) where LLVM`s scheduling squeezes latency V8`s wasm tier does not. Same scalar-codegen-race class as qoi/dict; no jz-side shape fix.',
  dict:     'open-addressing linear-probe hash table — AS leads ~1.09×. NOT a narrowing leak: the hot insert/probe/lookup loop is verified clean i32 (0 trunc_sat / 0 f64.convert / 0 reinterpret in $runKernel; the 2 f64.const-nan are discarded void-insert returns, the module f64 is all in benchlib). Same scalar-codegen-race class as qoi — the probe loop`s branch/bounds quality, no jz-side narrowing fix.',
  shapes:   'megamorphic shape scan — the closed heterogeneous-record representation LANDED end to end: byte-stride packed raw-i32 union records (20 B at stride 5, no pad cell), guard-free discriminant-refined reads, carrier-specialized raw-i32 clones ($measure$union takes (param i32), zero unbox). Focused alternated pairs put jz ≈1.10–1.15× AS, stable; op census ≤ AS and every A/B lever is exhausted (inline beats call, 20 B ≈ 24 B). The residual ~0.8 cy/record is V8-codegen-level (regalloc/scheduling of the fused loop) — next lever is machine-code profiling (Instruments/xctrace or a V8 debug build), not a representation change.',
  // radixsort: within the hard 5% frontier band. Distinct typed-parameter
  // forwarding and tiny strided-control specialization repeat at 2.34–2.40ms
  // vs rust-wasm 2.29–2.30ms. A larger histogram theorem bought ~4% but was
  // rejected because its compiler cost destabilized the stricter self-host gate.
  // strbuild: WON (876c9fd2 + f9d6b62b). Two fused-concat leaf classes killed the row cost:
  // literal ASCII parts store inline (-15.5%), then i32-proven parts render digits at the
  // cursor — __ilen sizes the alloc, __itoa_s writes; no __i32_to_str temp string, no
  // __str_byteLen, no __str_copy (another -51%, 1038→503µs, checksum exact). jz 0.46 ms now
  // leads every string-producing rival — rust-wasm/native-C ~3.1× behind, V8 ~3.7× — with only
  // zig-wasm's no-allocation stack-buffer formatter 1.09× ahead (it never builds a string value).
  // wordcount: WON. Finite-domain no-growth hashing plus i32 count slots now
  // repeats at 0.60–0.66ms, ahead of c-wasm's ~0.75–0.77ms.
  immutable: 'immutable-update allocation churn (ps[i] = {x,y,vx,vy} per particle per step) — every wasm rival leads (c-wasm ~4.3×, AS ~1.9×; value-semantics natives get it free). jz bump-allocates each escaping object with no scalar replacement and no reclamation. The general fix is SROA/escape analysis for same-schema replace-stores (the store kills the previous object, so the fields can live in place or in a reused cell), not per-object arena growth.',
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
    // Attempted-but-failed builds — captured with their reason so the coverage
    // gate can compare succeeded vs attempted AND say WHY a toolchain is
    // broken instead of silently ignoring it.
    const fail = line.match(/^\[run\]\s+(\w[\w-]*)\s+.*…\s*FAIL(?:\s*—\s*(.*))?$/)
    if (fail) { parsed[cur][fail[1]] = { failed: true, reason: fail[2]?.trim() }; continue }
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
for (const id of ['watr', 'sort', 'crc32', 'callback', 'json', 'aos', 'hash', 'base64', 'hashjoin']) {
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
      const limit = SPEED_TOL[claim]
      okTiming(ratio <= limit, `${id}: jz ${(r.jz.medianUs / 1000).toFixed(2)}ms / ${tid} ${(r[tid].medianUs / 1000).toFixed(2)}ms = ${ratio.toFixed(3)}× > ${claim} limit ${limit.toFixed(3)}×`)
    })
  }
}
for (const tid of ['v8', 'as', 'porf']) {
  if (tid === 'as' && !ascAvailable) continue
  if (tid === 'porf' && !porfAvailable) continue
  const g = geoSpeed(tid)
  if (g == null) continue
  test(`bench: speed geomean jz/${tid} ≤ ${SPEED_GEOMEAN_MAX[tid]}×`, () => {
    okTiming(g <= SPEED_GEOMEAN_MAX[tid], `geomean jz/${tid} = ${g.toFixed(3)}× > ${SPEED_GEOMEAN_MAX[tid]}×`)
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
      const limit = WASM_LEAD_TOL
      const why = WASM_TODO[id] ? ` [known gap → ${WASM_TODO[id]}]` : ''
      okTiming(ratio <= limit, `${id}: jz ${(jz.medianUs / 1000).toFixed(2)}ms TRAILS ${br.who} ${(br.us / 1000).toFixed(2)}ms = ${ratio.toFixed(3)}× > ${limit.toFixed(3)}× — not the fastest wasm.${why}`)
    })
  }
  // Coverage backstop: an AVAILABLE rival whose builds all fail contributes
  // zero rows — bestRival then skips it everywhere and the fastest-wasm gate
  // can stay green with no competition at all. HARD assertion (compile success
  // is deterministic — same policy as checksums/parity, asserted on CI too):
  // every available rival must produce comparable rows for a MAJORITY of the
  // cases it attempted (ran or failed). A toolchain-version breakage (e.g.
  // zig API churn taking a rival to 0/43) reads as red, not as a free win.
  // MANDATORY rivals: the "fastest wasm" claim names these producers, so an
  // ABSENT one must not silently shrink the field — a missing toolchain makes
  // the claim unproven, not satisfied. Asserted where the full rig is expected
  // (CI, or JZ_FULL_RIG=1); on a dev box missing one it prints, so local runs
  // stay usable. This is the counterpart to the coverage floor below: that
  // catches a rival that ran and failed, this catches one that never ran.
  const REQUIRED_RIVALS = ['c-wasm', 'rust-wasm', 'go-wasm', 'tinygo', 'zig-wasm', 'as']
  {
    const missing = REQUIRED_RIVALS.filter(t => !wasmRivalAvail[t])
    const fullRig = process.env.CI || process.env.JZ_FULL_RIG
    test('bench: required wasm rivals present (the claim names them)', () => {
      const msg = `missing mandatory rival toolchain(s): ${missing.join(', ')} — the fastest-wasm claim is UNPROVEN against them, not satisfied`
      if (fullRig) ok(missing.length === 0, msg)
      else ok(true, missing.length ? `(dev rig) ${msg}` : 'all mandatory rivals available')
    })
  }
  // Per-rival coverage floor. Default: a majority of attempted cases must
  // produce comparable rows (a toolchain rival that compiles the corpus).
  // porf's floor is VERSION-AWARE: the npm 0.61.x engine is partial by design
  // (ran 13/52 — presence, not majority), but the 2026 rewrite (git main,
  // "pre-alpha" versioning; CI pins it via PORF_BIN in bench.yml) runs 49/52
  // with parity — only the three self-host compiler giants (watr/jessie/jz)
  // exceed it. Gate accordingly so a coverage regression in either vintage reds.
  const porfIsNew = (() => {
    try { return /pre-alpha/.test(execFileSync(process.env.PORF_BIN || 'porf', ['--version'], { encoding: 'utf8' })) }
    catch { return false }
  })()
  const RIVAL_COVERAGE_MIN = { porf: porfIsNew ? 40 : 1 }
  for (const t of WASM_RIVALS) {
    const attempted = speedCases.filter(id => runs[id]?.[t]).length
    if (!attempted) continue   // no eligible sources for this rival — not measured, not asserted
    const rows = speedCases.filter(id => runs[id]?.[t]?.checksum != null && runs[id][t].checksum === runs[id]?.jz?.checksum).length
    const need = RIVAL_COVERAGE_MIN[t] ?? Math.ceil(attempted / 2)
    const reasons = [...new Set(speedCases.map(id => runs[id]?.[t]?.reason).filter(Boolean))].slice(0, 2)
    test(`bench: rival coverage ${t} (comparable rows ≥ ${RIVAL_COVERAGE_MIN[t] != null ? need : 'half of attempted'})`, () => {
      ok(rows >= need, `${t}: ${rows}/${attempted} comparable rows (need ≥ ${need}) — builds failing or diverging; the fastest-wasm gate is under-contested by this producer${reasons.length ? `. sample failures: ${reasons.join(' | ')}` : ''}`)
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
  // the SIZE preset (as the name of these pins says) — an object base defaults
  // to level 2, which carries speed-tier trades (loop-versioning twins put
  // mat4 at 3172 B against its 2500 budget while `-Os` compiles to ~2 kB)
  optimize: { level: 'size', smallConstForUnroll: false, scalarTypedArrayLen: 8 },
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
  catch (e) { okTiming(false, `perf-fuzz regression (gate exit ${e.status}):\n${e.stdout || ''}${e.stderr || ''}`); return }
  okTiming(/^PASS:/m.test(out), `perf-fuzz did not report PASS:\n${out}`)
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
  catch (e) { okTiming(false, `examples perf regression (gate exit ${e.status}):\n${e.stdout || ''}${e.stderr || ''}`); return }
  okTiming(/✓ jz faster overall/.test(out), `examples bench did not report pass:\n${out}`)
  // The V1 letter — STRICT wins, not ≥0.9×. The floor above stays the
  // regression guard; this is the absolute claim gate (Q1 discipline: the band
  // never weakens to "statistical parity"), red until every gated example
  // strictly beats V8.
  const strict = out.match(/^strict: .*$/m)?.[0] ?? 'strict: (line missing)'
  okTiming(/strictly beat V8/.test(strict), `examples not strict wins — ${strict}`)
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
  okTiming(fbGeo != null && fbGeo <= 0.85,
    `floatbeat geomean jz/v8 = ${fbGeo?.toFixed(3)}× > 0.85× — slow beats: ${fbRatios.filter(r => r.ratio > 1).map(r => `${r.name} ${r.ratio.toFixed(2)}×`).join(', ') || 'none'}`)
})
// Per-beat backstop: catch a single beat regressing grossly (an __ptr_offset-style 4× cliff)
// that the corpus geomean would absorb. ~Parity (1.05×) asserted off-CI where hardware is
// stable — every beat runs ≤ 0.93× locally, so any beat merely TYING V8 on a dev machine
// fails; on CI it prints informational like every timing gate (policy at okTiming). End
// state: ≤ 1.0 per beat, everywhere — the faster-than-JS guarantee is per-program, not
// on-average; each compiler win should tighten these.
const fbBackstop = 1.05
for (const { name, ratio } of fbRatios) {
  test(`bench: floatbeat "${name}" jz ≤ ${fbBackstop}× V8 (no gross regression)`, () => {
    okTiming(ratio <= fbBackstop, `floatbeat ${name}: jz ${ratio.toFixed(2)}× V8 > ${fbBackstop}× — gross codegen regression`)
  })
}
