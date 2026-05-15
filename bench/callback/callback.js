import { medianUs, mix, printResult } from '../_lib/benchlib.js'

// callback bench — measures `array.map(closure)` followed by a dense consumer
// over every mapped element. Earlier revisions had the consumer skip 63/64
// outputs, which let any compiler that can fuse map with its consumer
// dead-store-eliminate ~63/64 of the closure work (jz did, AS didn't). The
// dense consumer keeps every closure output observed so the spread reflects
// codegen quality (inlining + fusion + vectorization), not which compiler
// happens to elide unused stores.

const N = 4096
const N_ITERS = 64
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
    for (let j = 0; j < b.length; j++) h = mix(h, b[j] | 0)
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
  printResult(medianUs(samples), cs, N * N_ITERS, 2, N_RUNS)
}
