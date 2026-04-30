import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const SRC = '{"items":[{"id":1,"kind":2,"value":10},{"id":2,"kind":3,"value":20},{"id":3,"kind":5,"value":30}],"meta":{"scale":7,"bias":11}}'
const N_ITERS = 512
const N_RUNS = 21
const N_WARMUP = 5

const walk = () => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < N_ITERS; i++) {
    const o = JSON.parse(SRC)
    const items = o.items
    let s = o.meta.bias
    for (let j = 0; j < items.length; j++) {
      const it = items[j]
      s += it.id * o.meta.scale + it.kind + it.value
    }
    h = mix(h, s)
  }
  return h >>> 0
}

export let main = () => {
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = walk()

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = walk()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N_ITERS, 4, N_RUNS)
}
