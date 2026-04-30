import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 4096
const N_ITERS = 128
const N_RUNS = 21
const N_WARMUP = 5

const init = () => {
  const a = []
  for (let i = 0; i < N; i++) a.push((i % 97) - 48)
  return a
}

const runKernel = (a, scale) => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < N_ITERS; i++) {
    const b = a.map(x => x * scale + i)
    for (let j = 0; j < b.length; j += 64) h = mix(h, b[j] | 0)
  }
  return h >>> 0
}

export let main = () => {
  const a = init()
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(a, 2)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(a, 2)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, 1, N_RUNS)
}
