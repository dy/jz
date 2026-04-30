// callback.as.ts — AssemblyScript translation of bench/callback/callback.js.
//
// AS does not implement closures (`AS100: Not implemented: Closures`), so
// `a.map(x => x*scale + i)` cannot be expressed faithfully. This file
// therefore inlines the map as an explicit loop. As a result the AS row is
// a *closure-free reference*, not a true callback equivalent — it tells us
// the cost a wasm-from-source compiler that punts on closures gets to skip.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 4096
const N_ITERS: i32 = 128
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function init(): Array<f64> {
  const a = new Array<f64>(N)
  for (let i = 0; i < N; i++) unchecked(a[i] = <f64>(i % 97) - 48.0)
  return a
}

function runKernel(a: Array<f64>, scale: f64): u32 {
  let h: u32 = 0x811c9dc5
  const n = a.length
  const b = new Array<f64>(n)
  for (let i = 0; i < N_ITERS; i++) {
    const iLocal: f64 = <f64>i
    for (let k = 0; k < n; k++) unchecked(b[k] = a[k] * scale + iLocal)
    for (let j = 0; j < n; j += 64) h = (h ^ <u32>(<i32>unchecked(b[j]))) * 0x01000193
  }
  return h
}

export function main(): void {
  const a = init()
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(a, 2.0)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(a, 2.0)
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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, 1, N_RUNS)
}
