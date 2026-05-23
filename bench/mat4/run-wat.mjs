#!/usr/bin/env node
import { runWatBench } from '../_lib/run-wat.mjs'

const N_ITERS = 200000
const A_PTR = 0
const B_PTR = 128
const OUT_PTR = 256

const initMem = (memory) => {
  const f64 = new Float64Array(memory.buffer)
  for (let i = 0; i < 16; i++) {
    f64[A_PTR / 8 + i] = (i + 1) * 0.125
    f64[B_PTR / 8 + i] = (16 - i) * 0.0625
  }
}

await runWatBench({
  name: 'mat4',
  setup: (_exp, inst) => initMem(inst.exports.memory),
  beforeRun: (_exp, inst) => initMem(inst.exports.memory),
  run: (exp) => exp.multiplyMany(A_PTR, B_PTR, OUT_PTR, N_ITERS),
  checksum: (exp) => exp.checksum(OUT_PTR),
  samples: N_ITERS * 16,
  stages: 4,
})
