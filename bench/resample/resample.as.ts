// resample.as.ts — AssemblyScript translation of bench/resample/resample.js.
//
// fractional-rate audio resampling with 4-point Hermite (Catmull–Rom)
// interpolation: the workhorse of samplers, time-stretchers and every audio graph that
// meets two clocks. Per output sample: truncate the running phase to an integer tap,
// gather four neighbours at a COMPUTED index, evaluate the cubic, advance phase by an
// irrational-ish step. Two stages (upsample then downsample) exercise both directions.
// The profile: float-derived gather indices + a fractional accumulator — the pattern
// that decides whether a compiler keeps typed loads on the fast path when the index
// comes from float math. Pure + − × ÷, so output is bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over both stage outputs (f64 bits).

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 16                          // input samples
const STEP_UP: f64 = 0.7317314443021356         // rate < 1: output longer (upsample)
const STEP_DN: f64 = 1.3186248722190522         // rate > 1: output shorter (downsample)
const M_UP: i32 = 89000                         // fixed output counts (fit within phase range)
const M_DN: i32 = 49000
const N_ITERS: i32 = 5
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function buildInput(input: Float64Array): void {
  let s: u32 = 0x6d2f4b1
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(input[i] = (<f64>s / 4294967296.0) * 2.0 - 1.0)
  }
}

// 4-point, 3rd-order Hermite (Catmull–Rom): y(f) around x1 with neighbours x0..x3
function resamplePass(input: Float64Array, out: Float64Array, m: i32, step: f64): void {
  let phase: f64 = 1.0
  for (let k = 0; k < m; k++) {
    const idx = <i32>phase                     // exact truncation — phase stays well below 2^31
    const f = phase - <f64>idx
    const x0 = unchecked(input[idx - 1])
    const x1 = unchecked(input[idx])
    const x2 = unchecked(input[idx + 1])
    const x3 = unchecked(input[idx + 2])
    const c0 = x1
    const c1 = 0.5 * (x2 - x0)
    const c2 = x0 - 2.5 * x1 + 2.0 * x2 - 0.5 * x3
    const c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2)
    unchecked(out[k] = ((c3 * f + c2) * f + c1) * f + c0)
    phase += step
  }
}

function runKernel(input: Float64Array, up: Float64Array, dn: Float64Array): void {
  for (let it = 0; it < N_ITERS; it++) {
    resamplePass(input, up, M_UP, STEP_UP)
    resamplePass(up, dn, M_DN, STEP_DN)
  }
}

function checksumF64(out: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const stride: i32 = 256
  const total: i32 = out.length * 2
  const base: usize = changetype<usize>(out.buffer)
  for (let i = 0; i < total; i += stride) {
    const w = load<u32>(base + (<usize>i << 2))
    h = (h ^ w) * 0x01000193
  }
  return h
}

export function main(): void {
  const input = new Float64Array(N)
  const up = new Float64Array(M_UP)
  const dn = new Float64Array(M_DN)
  buildInput(input)

  for (let i = 0; i < N_WARMUP; i++) runKernel(input, up, dn)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    runKernel(input, up, dn)
    unchecked(samples[i] = perfNow() - t0)
  }

  let h = checksumF64(up)
  h = h ^ checksumF64(dn)

  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), h, (M_UP + M_DN) * N_ITERS, 2, N_RUNS)
}
