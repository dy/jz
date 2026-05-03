// biquad.js — direct-form-1 biquad filter cascade on Float64Array.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly
// by the JS engines (V8, QuickJS). Stays inside the lowest common subset:
//   - const/let + arrow functions only (no class, no async, no regex)
//   - Float64Array + Uint32Array (typed arrays)
//   - Math.imul for portable 32-bit checksum
//   - No DataView, no BigInt (jawsm/porffor support varies)
//
// Algorithm: per sample, 8-stage cascade of direct-form-1 biquads.
//   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
// Each stage's output feeds the next. State + coeffs live in flat Float64Arrays
// (jz's TYPED narrowing + .map-receiver unbox land here).
//
// Reports: median ms across N_RUNS, throughput in Msamp/s, output checksum
// (FNV-1a over a sparse stride of the result so the optimizer can't elide it).

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

// Stable lowpass-ish coeffs varied per stage so optimizer can't fold the cascade.
// Layout: [b0, b1, b2, a1, a2] × N_STAGES.
const mkCoeffs = (n) => {
  const out = new Float64Array(n * 5)
  for (let i = 0; i < n; i++) {
    out[i * 5 + 0] = 0.10 + i * 0.001
    out[i * 5 + 1] = 0.20 - i * 0.0005
    out[i * 5 + 2] = 0.10
    out[i * 5 + 3] = -1.50 + i * 0.01
    out[i * 5 + 4] = 0.60 - i * 0.005
  }
  return out
}

// Hot path. Scalar — vectorization left to the engine.
const processCascade = (x, coeffs, state, nStages, out) => {
  const n = x.length
  for (let i = 0; i < n; i++) {
    let v = x[i]
    for (let s = 0; s < nStages; s++) {
      const c = s * 5
      const sb = s * 4
      const b0 = coeffs[c + 0]
      const b1 = coeffs[c + 1]
      const b2 = coeffs[c + 2]
      const a1 = coeffs[c + 3]
      const a2 = coeffs[c + 4]
      const x1 = state[sb + 0]
      const x2 = state[sb + 1]
      const y1 = state[sb + 2]
      const y2 = state[sb + 3]
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      state[sb + 0] = v
      state[sb + 1] = x1
      state[sb + 2] = y
      state[sb + 3] = y1
      v = y
    }
    out[i] = v
  }
}

const run = () => {
  const x = mkInput(N_SAMPLES)
  const coeffs = mkCoeffs(N_STAGES)
  const state = new Float64Array(N_STAGES * 4)
  const out = new Float64Array(N_SAMPLES)

  const stateLen = N_STAGES * 4

  for (let i = 0; i < N_WARMUP; i++) {
    for (let j = 0; j < stateLen; j++) state[j] = 0
    processCascade(x, coeffs, state, N_STAGES, out)
  }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    for (let j = 0; j < stateLen; j++) state[j] = 0
    const t0 = performance.now()
    processCascade(x, coeffs, state, N_STAGES, out)
    samples[i] = performance.now() - t0
  }

  printResult(medianUs(samples), checksumF64(out), N_SAMPLES, N_STAGES, N_RUNS)
}

export let main = () => {
  run()
}
