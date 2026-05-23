#!/usr/bin/env node
import { runWatBench } from '../_lib/run-wat.mjs'

const N_SAMPLES = 480000
const N_STAGES = 8
const X_PTR = 0x0000_0000
const COEFFS_PTR = 0x0040_0000
const STATE_PTR = 0x0040_1000
const OUT_PTR = 0x0040_2000

await runWatBench({
  name: 'biquad',
  setup: (exp) => {
    exp.mkInput(X_PTR, N_SAMPLES)
    exp.mkCoeffs(COEFFS_PTR, N_STAGES)
  },
  beforeRun: (exp) => exp.zero(STATE_PTR, N_STAGES * 4),
  run: (exp) => exp.processCascade(X_PTR, COEFFS_PTR, STATE_PTR, N_STAGES, OUT_PTR, N_SAMPLES),
  checksum: (exp) => exp.checksum(OUT_PTR, N_SAMPLES),
  samples: N_SAMPLES,
  stages: N_STAGES,
})
