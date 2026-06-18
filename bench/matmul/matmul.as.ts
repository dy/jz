// matmul.as.ts — AssemblyScript translation of bench/matmul/matmul.js.
//
// Dense matrix multiply C = A·Bᵀ. Small-integer data keeps every product-sum
// exact in f64, so the result is bit-identical across every engine and target.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 256
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function checksumF64(a: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const u32len = a.length * 2
  const base = a.dataStart
  for (let i = 0; i < u32len; i += 256) h = (h ^ load<u32>(base + (<usize>i << 2))) * 0x01000193
  return h
}

function init(A: Float64Array, Bt: Float64Array): void {
  for (let i = 0; i < N * N; i++) {
    unchecked(A[i] = <f64>((i % 13) - 6))
    unchecked(Bt[i] = <f64>(((i * 7) % 11) - 5))
  }
}

function matmul(A: Float64Array, Bt: Float64Array, C: Float64Array): void {
  for (let i = 0; i < N; i++) {
    const ai = i * N
    for (let j = 0; j < N; j++) {
      const bj = j * N
      let s: f64 = 0
      for (let k = 0; k < N; k++) s += unchecked(A[ai + k]) * unchecked(Bt[bj + k])
      unchecked(C[ai + j] = s)
    }
  }
}

export function main(): void {
  const A = new Float64Array(N * N)
  const Bt = new Float64Array(N * N)
  const C = new Float64Array(N * N)
  init(A, Bt)
  for (let i = 0; i < N_WARMUP; i++) matmul(A, Bt, C)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    matmul(A, Bt, C)
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
  const cs = checksumF64(C)
  logLine(<i32>(medianMs * 1000.0), cs, N * N * N, 2, N_RUNS)
}
