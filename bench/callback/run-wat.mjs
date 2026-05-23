#!/usr/bin/env node
import { runWatBench } from '../_lib/run-wat.mjs'

const N = 4096
const N_ITERS = 64
const A_PTR = 0x0000_0000
const B_PTR = 0x0000_4000

let cs = 0
await runWatBench({
  name: 'callback',
  setup: (exp) => exp.init(A_PTR, N),
  run: (exp) => { cs = exp.kernel(A_PTR, B_PTR, N, N_ITERS, 2) >>> 0 },
  checksum: () => cs,
  samples: N * N_ITERS,
  stages: 2,
})
