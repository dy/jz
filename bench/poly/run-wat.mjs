#!/usr/bin/env node
import { runWatBench } from '../_lib/run-wat.mjs'

const N = 8192
const N_ITERS = 80
const F64_PTR = 0x0000_0000
const I32_PTR = 0x0001_0000

let cs = 0
await runWatBench({
  name: 'poly',
  setup: (exp) => exp.init(F64_PTR, I32_PTR, N),
  run: (exp) => { cs = exp.runKernel(F64_PTR, I32_PTR, N, N_ITERS) >>> 0 },
  checksum: () => cs,
  samples: N * N_ITERS * 2,
  stages: 2,
})
