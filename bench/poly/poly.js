import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 8192
const N_ITERS = 80
const N_RUNS = 21
const N_WARMUP = 5

const sum = (arr) => {
  let s = 0
  for (let i = 0; i < arr.length; i++) s += arr[i]
  return s
}

const init = (f64, i32) => {
  for (let i = 0; i < N; i++) {
    f64[i] = (i % 251) * 0.25
    i32[i] = (i * 17) & 1023
  }
}

const runKernel = (f64, i32) => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < N_ITERS; i++) {
    const a = sum(f64)
    const b = sum(i32)
    h = mix(h, a | 0)
    h = mix(h, b | 0)
  }
  return h >>> 0
}

export let main = () => {
  const f64 = new Float64Array(N)
  const i32 = new Int32Array(N)
  init(f64, i32)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(f64, i32)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(f64, i32)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS * 2, 2, N_RUNS)
}
