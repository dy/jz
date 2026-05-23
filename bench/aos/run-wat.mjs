#!/usr/bin/env node
import { runWatBench } from '../_lib/run-wat.mjs'

const N = 16384
const N_ITERS = 64
const RX_PTR = 0x0000_0000
const RY_PTR = 0x0002_0000
const RZ_PTR = 0x0004_0000
const XS_PTR = 0x0006_0000
const YS_PTR = 0x0008_0000
const ZS_PTR = 0x000a_0000

await runWatBench({
  name: 'aos',
  setup: (exp) => exp.initRows(RX_PTR, RY_PTR, RZ_PTR, N),
  run: (exp) => exp.runKernel(RX_PTR, RY_PTR, RZ_PTR, XS_PTR, YS_PTR, ZS_PTR, N, N_ITERS),
  checksum: (exp) => exp.checksum(XS_PTR, YS_PTR, ZS_PTR, N),
  samples: N * N_ITERS,
  stages: 3,
})
