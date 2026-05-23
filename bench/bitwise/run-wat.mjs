#!/usr/bin/env node
import { runWatBench } from '../_lib/run-wat.mjs'

const N = 65536
const N_ROUNDS = 128
const STATE_PTR = 0

await runWatBench({
  name: 'bitwise',
  setup: (exp) => exp.init(STATE_PTR, N),
  beforeRun: (exp) => exp.init(STATE_PTR, N),
  run: (exp) => exp.kernel(STATE_PTR, N, N_ROUNDS),
  checksum: (exp) => exp.checksum(STATE_PTR, N),
  samples: N * N_ROUNDS,
  stages: 3,
})
