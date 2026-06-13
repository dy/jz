// dotprod.as.ts — AssemblyScript translation of bench/dotprod/dotprod.js.
//
// Dot-product (multiply-accumulate) reduction over two f64 arrays.
// Small-integer data keeps the sum exact in f64 regardless of order,
// so the checksum is cross-target stable.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 8192
const N_ITERS: i32 = 200
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function dot(a: Float64Array, b: Float64Array): f64 {
  let s: f64 = 0
  const n = a.length
  for (let i = 0; i < n; i++) s += unchecked(a[i]) * unchecked(b[i])
  return s
}

function init(a: Float64Array, b: Float64Array): void {
  for (let i = 0; i < N; i++) {
    unchecked(a[i] = <f64>((i % 13) - 6))
    unchecked(b[i] = <f64>(((i * 7) % 11) - 5))
  }
}

function runKernel(a: Float64Array, b: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  for (let i = 0; i < N_ITERS; i++) {
    h = (h ^ <u32>(<i32>dot(a, b))) * 0x01000193
  }
  return h
}

export function main(): void {
  const a = new Float64Array(N)
  const b = new Float64Array(N)
  init(a, b)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(a, b)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(a, b)
    unchecked(samples[i] = perfNow() - t0)
  }

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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, 2, N_RUNS)
}
