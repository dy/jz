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
  for (let i = 0, l = data.length; i < l; i++) {
    let x = data[i]
    for (let j = 0; j < n; j++) {
      const c = coefs[j], s = state[j]
      const y = c.b0 * x + s[0]
      s[0] = c.b1 * x - c.a1 * y + s[1]
      s[1] = c.b2 * x - c.a2 * y
      x = y
    }
    data[i] = x
  }
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
