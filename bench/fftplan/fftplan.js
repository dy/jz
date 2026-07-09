// fftplan.js — cached-plan FFT: many small transforms through a plan object.
// The shape every JS DSP library actually ships (fourier-transform, fft.js, pffft
// ports): twiddle/permutation tables built once, stashed in a Map-backed plan
// cache, and read by a hot kernel that receives them as returned-object fields /
// function parameters. `fft` covers the raw butterfly codegen; THIS case covers
// the provenance: arrays whose identity flows out of a callee (return value,
// object field, Map.get) currently lose their concrete element type in jz and
// every access on them lowers to a dynamic path — measured ~6× behind V8 and
// ~10× behind jz's own locally-provable `fft` per butterfly (2026-07), while the
// bit-identical kernel with caller-built tables beats V8. Audio-realistic grain:
// N=2048, forward+inverse per frame (the phase-vocoder round-trip). The fix is
// engine inference (return/field type propagation), not input tuning — this
// specimen stays idiomatic.
//
// Bit-exactness: twiddles are transcendental-free — a base table over 2π k/N is
// built from an in-source Taylor sin/cos of the tiny base angle plus a complex
// recurrence (same f64 sequence everywhere), and each stage's packed table is a
// stride subsample of it. Butterflies are +/−/× only.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over the final frame's real
// part (with a per-frame accumulator folded into re[0] so no frame is dead).

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N = 2048              // transform size — audio frame (pvoc hop grain)
const LOG2N = 11
const FRAMES = 64           // fwd+inv round-trips per timed sample
const N_RUNS = 21
const N_WARMUP = 5

// --- transcendental-free trig for the base angle (see fft case) -------------
const sinPoly = (x) => {
  const x2 = x * x
  return x * (1 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))))
}
const cosPoly = (x) => {
  const x2 = x * x
  return 1 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))))
}

// --- the plan: tables built once, returned as an object, cached in a Map ----
// (the provenance under test — do not hoist the arrays to the caller)
const cache = new Map()
let lastN = 0, lastPlan = null

const makePlan = (n) => {
  const bits = 31 - Math.clz32(n)
  const perm = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    let rev = 0, v = i
    for (let j = 0; j < bits; j++) { rev = (rev << 1) | (v & 1); v >>= 1 }
    perm[i] = rev
  }
  // base table: cos/sin of 2π k/n for k in [0, n/2) via recurrence from 2π/n
  const half = n >> 1
  const baseC = new Float64Array(half)
  const baseS = new Float64Array(half)
  const dt = 6.283185307179586 / n
  const c1 = cosPoly(dt), s1 = sinPoly(dt)
  let cr = 1, ci = 0
  for (let k = 0; k < half; k++) {
    baseC[k] = cr
    baseS[k] = ci
    const nr = cr * c1 - ci * s1
    const ni = cr * s1 + ci * c1
    cr = nr
    ci = ni
  }
  // packed per-stage tables (fourier-transform layout): stage len keeps its
  // half twiddles at [ti, ti+half); entry j is the base entry j·(n/len)
  const twRe = new Float64Array(n)
  const twFwd = new Float64Array(n)
  const twInv = new Float64Array(n)
  let ti = 0
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1
    const stride = (n / len) | 0
    for (let j = 0; j < h; j++) {
      const c = baseC[j * stride], s = baseS[j * stride]
      twRe[ti] = c
      twFwd[ti] = -s
      twInv[ti] = s
      ti++
    }
  }
  return { perm, twRe, twFwd, twInv }
}

const getPlan = (n) => {
  if (n === lastN) return lastPlan
  let p = cache.get(n)
  if (p === undefined) {
    p = makePlan(n)
    cache.set(n, p)
  }
  lastN = n
  lastPlan = p
  return p
}

// --- hot kernel: tables arrive as parameters with plan provenance -----------
const transform = (re, im, perm, twRe, twIm, n) => {
  for (let i = 0; i < n; i++) {
    const j = perm[i]
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const t2 = im[i]; im[i] = im[j]; im[j] = t2
    }
  }
  let ti = 0
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const wr = twRe[ti + j], wi = twIm[ti + j]
        const a = i + j, b = a + half
        const xr = re[b], xi = im[b]
        const tr = wr * xr - wi * xi
        const t2 = wr * xi + wi * xr
        re[b] = re[a] - tr
        im[b] = im[a] - t2
        re[a] = re[a] + tr
        im[a] = im[a] + t2
      }
    }
    ti += half
  }
}

const cfft = (re, im, n) => {
  const plan = getPlan(n)
  transform(re, im, plan.perm, plan.twRe, plan.twFwd, n)
}
const cifft = (re, im, n) => {
  const plan = getPlan(n)
  transform(re, im, plan.perm, plan.twRe, plan.twInv, n)
  const inv = 1 / n
  for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv }
}

// Deterministic real input in [-1, 1) — XorShift32, bit-identical per target.
const mkSignal = (n) => {
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

export let main = () => {
  const sig = mkSignal(N)
  const re = new Float64Array(N)
  const im = new Float64Array(N)

  const frames = () => {
    let acc = 0
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < N; i++) { re[i] = sig[i]; im[i] = 0 }
      cfft(re, im, N)
      cifft(re, im, N)
      acc += re[f & (N - 1)]
    }
    return acc
  }

  for (let i = 0; i < N_WARMUP; i++) frames()

  const samples = new Float64Array(N_RUNS)
  let acc = 0
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    acc = frames()
    samples[i] = performance.now() - t0
  }
  re[0] = acc  // fold the per-frame accumulator in — no frame is dead code
  printResult(medianUs(samples), checksumF64(re), FRAMES * 2 * ((N * LOG2N) >> 1), LOG2N, N_RUNS)
}
