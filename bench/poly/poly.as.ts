// poly.as.ts — AssemblyScript translation of bench/poly/poly.js.
//
// AS is statically typed; the JS `sum(arr)` polymorphic over Float64Array
// + Int32Array becomes two specialized functions. This is exactly the
// monomorphic shape jz needs to converge to internally.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 8192
const N_ITERS: i32 = 80
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function sumF64(a: Float64Array): f64 {
  let s: f64 = 0
  const n = a.length
  for (let i = 0; i < n; i++) s += unchecked(a[i])
  return s
}

function sumI32(a: Int32Array): f64 {
  let s: f64 = 0
  const n = a.length
  for (let i = 0; i < n; i++) s += <f64>unchecked(a[i])
  return s
}

function init(f64: Float64Array, i32: Int32Array): void {
  for (let i = 0; i < N; i++) {
    unchecked(f64[i] = <f64>(i % 251) * 0.25)
    unchecked(i32[i] = (i * 17) & 1023)
  }
}

function runKernel(f64: Float64Array, i32: Int32Array): u32 {
  let h: u32 = 0x811c9dc5
  for (let i = 0; i < N_ITERS; i++) {
    const a = sumF64(f64)
    const b = sumI32(i32)
    h = (h ^ <u32>(<i32>a)) * 0x01000193
    h = (h ^ <u32>(<i32>b)) * 0x01000193
  }
  return h
}

export function main(): void {
  const f64 = new Float64Array(N)
  const i32 = new Int32Array(N)
  init(f64, i32)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(f64, i32)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(f64, i32)
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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS * 2, 2, N_RUNS)
}
