// dotprod.js — multiply-accumulate (dot-product) reductions: the fundamental
// DSP/numeric kernel (correlation, energy, projection, FIR tap-sum). The
// accumulator `s += a[i]*b[i]` is a latency-bound dependency chain — exactly
// where multi-accumulator vectorization (independent partial sums combined at
// the end) earns its keep.
import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 8192
const N_ITERS = 200
const N_RUNS = 21
const N_WARMUP = 5

const dot = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const init = (a, b) => {
  // Small integers ⇒ the sum of products is exact in f64 regardless of summation
  // order, so vectorized / reassociated / scalar all agree — the checksum is
  // cross-target stable (the whole point of integer-valued reduction data).
  for (let i = 0; i < N; i++) {
    a[i] = (i % 13) - 6
    b[i] = ((i * 7) % 11) - 5
  }
}

const runKernel = (a, b) => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < N_ITERS; i++) h = mix(h, dot(a, b) | 0)
  return h >>> 0
}

export let main = () => {
  const a = new Float64Array(N)
  const b = new Float64Array(N)
  init(a, b)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(a, b)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(a, b)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, 2, N_RUNS)
}
