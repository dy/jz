// matmul.js — dense matrix multiply C = A·Bᵀ, the kernel every linear-algebra and
// neural-net library lives on. B is stored transposed (Bt[j][k] = B[k][j]) so the
// inner k-loop reads row i of A and row j of Bᵀ contiguously — each output C[i][j]
// is a dot product, which jz lifts to multi-accumulator f64x2 SIMD (the dotprod
// shape, in a 2-D loop). Small-integer data keeps every product-sum exact in f64,
// so the result is bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in MACs/µs, FNV-1a checksum over the
// product matrix.
import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N = 256
const N_RUNS = 21
const N_WARMUP = 5

// Small-integer A and Bᵀ — products land in [-30,30], a length-N sum stays well
// under 2⁵³, so C is exact in f64 regardless of accumulation / vectorization order.
const init = (A, Bt) => {
  for (let i = 0; i < N * N; i++) {
    A[i] = (i % 13) - 6
    Bt[i] = ((i * 7) % 11) - 5
  }
}

// C = A·Bᵀ. Inner loop is a contiguous dot over row i of A and row j of Bᵀ.
const matmul = (A, Bt, C) => {
  for (let i = 0; i < N; i++) {
    const ai = i * N
    for (let j = 0; j < N; j++) {
      const bj = j * N
      let s = 0
      for (let k = 0; k < N; k++) s += A[ai + k] * Bt[bj + k]
      C[ai + j] = s
    }
  }
}

export let main = () => {
  const A = new Float64Array(N * N)
  const Bt = new Float64Array(N * N)
  const C = new Float64Array(N * N)
  init(A, Bt)
  for (let i = 0; i < N_WARMUP; i++) matmul(A, Bt, C)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    matmul(A, Bt, C)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(C), N * N * N, 2, N_RUNS)
}
