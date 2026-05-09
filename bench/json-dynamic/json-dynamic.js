import { medianUs, mix, printResult } from '../_lib/benchlib.js'

// Dynamic-selection JSON parse + walk. The concrete source is selected at
// runtime, but all module-level literal candidates share one JSON shape.
const SOURCES = [
  '{"items":[{"id":1,"kind":2,"value":10},{"id":2,"kind":3,"value":20},{"id":3,"kind":5,"value":30}],"meta":{"scale":7,"bias":11}}',
  '{"items":[{"id":4,"kind":1,"value":8},{"id":5,"kind":2,"value":13},{"id":6,"kind":3,"value":21}],"meta":{"scale":5,"bias":17}}',
]
const N_ITERS = 512
const N_RUNS = 21
const N_WARMUP = 5

const walk = () => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < N_ITERS; i++) {
    const o = JSON.parse(SOURCES[i & 1])
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
