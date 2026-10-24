// sosfilter.js — second-order-section cascade in a DSP library's idiom
// (digital-filter's `filter(data, params)`): coefficients as an array of
// `{b0, b1, b2, a1, a2}` records from a design function, the filter state as
// an array of `[z1, z2]` pairs kept in the caller's params bag and created on
// the first call, the signal a Float64Array filtered in place. Direct Form II
// Transposed per section. What the kernel class pins: records read through an
// array element, small arrays as state, a bag property that is absent on the
// first call, all in the per-sample loop.
//
// Reports: median ms across N_RUNS, output checksum (FNV-1a over a sparse
// stride of the result so the optimizer can't elide it).

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_SAMPLES = 480000  // 10 s @ 48 kHz mono
const N_STAGES = 8
const N_RUNS = 21
const N_WARMUP = 5

// XorShift32: deterministic per-target. Output is in [-1, 1).
const mkInput = (n) => {
  const out = new Float64Array(n)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = ((s >>> 0) / 4294967296) * 2 - 1
  }
  return out
}

// A design function's output: stable lowpass-ish sections varied per stage.
const norm = (b0, b1, b2, a0, a1, a2) => ({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 })
const design = (n) => {
  const sos = []
  for (let i = 0; i < n; i++) sos.push(norm(0.10 + i * 0.001, 0.20 - i * 0.0005, 0.10, 1.0, -1.50 + i * 0.01, 0.60 - i * 0.005))
  return sos
}

// The library's filter: state lives in the params bag between calls.
const filter = (data, params) => {
  let coefs = params.coefs
  if (!Array.isArray(coefs)) coefs = [coefs]
  const n = coefs.length
  if (!params.state) {
    params.state = new Array(n)
    for (let i = 0; i < n; i++) params.state[i] = [0, 0]
  }
  const state = params.state
  const c0 = coefs[0], s0 = state[0]
  const b0_0 = c0.b0, b1_0 = c0.b1, b2_0 = c0.b2, a1_0 = c0.a1, a2_0 = c0.a2
  let z0_0 = s0[0], z1_0 = s0[1]
  const c1 = coefs[1], s1 = state[1]
  const b0_1 = c1.b0, b1_1 = c1.b1, b2_1 = c1.b2, a1_1 = c1.a1, a2_1 = c1.a2
  let z0_1 = s1[0], z1_1 = s1[1]
  const c2 = coefs[2], s2 = state[2]
  const b0_2 = c2.b0, b1_2 = c2.b1, b2_2 = c2.b2, a1_2 = c2.a1, a2_2 = c2.a2
  let z0_2 = s2[0], z1_2 = s2[1]
  const c3 = coefs[3], s3 = state[3]
  const b0_3 = c3.b0, b1_3 = c3.b1, b2_3 = c3.b2, a1_3 = c3.a1, a2_3 = c3.a2
  let z0_3 = s3[0], z1_3 = s3[1]
  const c4 = coefs[4], s4 = state[4]
  const b0_4 = c4.b0, b1_4 = c4.b1, b2_4 = c4.b2, a1_4 = c4.a1, a2_4 = c4.a2
  let z0_4 = s4[0], z1_4 = s4[1]
  const c5 = coefs[5], s5 = state[5]
  const b0_5 = c5.b0, b1_5 = c5.b1, b2_5 = c5.b2, a1_5 = c5.a1, a2_5 = c5.a2
  let z0_5 = s5[0], z1_5 = s5[1]
  const c6 = coefs[6], s6 = state[6]
  const b0_6 = c6.b0, b1_6 = c6.b1, b2_6 = c6.b2, a1_6 = c6.a1, a2_6 = c6.a2
  let z0_6 = s6[0], z1_6 = s6[1]
  const c7 = coefs[7], s7 = state[7]
  const b0_7 = c7.b0, b1_7 = c7.b1, b2_7 = c7.b2, a1_7 = c7.a1, a2_7 = c7.a2
  let z0_7 = s7[0], z1_7 = s7[1]
  for (let i = 0, l = data.length; i < l; i++) {
    const x0 = data[i]
    const y0 = b0_0 * x0 + z0_0
    const y1 = b0_1 * y0 + z0_1
    const y2 = b0_2 * y1 + z0_2
    const y3 = b0_3 * y2 + z0_3
    const y4 = b0_4 * y3 + z0_4
    const y5 = b0_5 * y4 + z0_5
    const y6 = b0_6 * y5 + z0_6
    const y7 = b0_7 * y6 + z0_7
    data[i] = y7
    z0_0 = b1_0 * x0 - a1_0 * y0 + z1_0
    z1_0 = b2_0 * x0 - a2_0 * y0
    z0_1 = b1_1 * y0 - a1_1 * y1 + z1_1
    z1_1 = b2_1 * y0 - a2_1 * y1
    z0_2 = b1_2 * y1 - a1_2 * y2 + z1_2
    z1_2 = b2_2 * y1 - a2_2 * y2
    z0_3 = b1_3 * y2 - a1_3 * y3 + z1_3
    z1_3 = b2_3 * y2 - a2_3 * y3
    z0_4 = b1_4 * y3 - a1_4 * y4 + z1_4
    z1_4 = b2_4 * y3 - a2_4 * y4
    z0_5 = b1_5 * y4 - a1_5 * y5 + z1_5
    z1_5 = b2_5 * y4 - a2_5 * y5
    z0_6 = b1_6 * y5 - a1_6 * y6 + z1_6
    z1_6 = b2_6 * y5 - a2_6 * y6
    z0_7 = b1_7 * y6 - a1_7 * y7 + z1_7
    z1_7 = b2_7 * y6 - a2_7 * y7
  }
  s0[0] = z0_0; s0[1] = z1_0
  s1[0] = z0_1; s1[1] = z1_1
  s2[0] = z0_2; s2[1] = z1_2
  s3[0] = z0_3; s3[1] = z1_3
  s4[0] = z0_4; s4[1] = z1_4
  s5[0] = z0_5; s5[1] = z1_5
  s6[0] = z0_6; s6[1] = z1_6
  s7[0] = z0_7; s7[1] = z1_7
  return data
}

const run = () => {
  const x = mkInput(N_SAMPLES)
  const data = new Float64Array(N_SAMPLES)
  const params = { coefs: design(N_STAGES) }

  for (let i = 0; i < N_WARMUP; i++) {
    data.set(x); params.state = null
    filter(data, params)
  }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    data.set(x); params.state = null
    const t0 = performance.now()
    filter(data, params)
    samples[i] = performance.now() - t0
  }

  printResult(medianUs(samples), checksumF64(data), N_SAMPLES, N_STAGES, N_RUNS)
}

export let main = () => {
  run()
}
