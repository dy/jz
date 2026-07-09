// provenance.js — typed-array kind loss through non-local provenance, isolated.
// One butterfly kernel (the shape jz vectorizes 1.4× past V8 in `fft`), run over
// bit-identical twiddle tables that differ ONLY in how they reach the kernel:
//   ret    — arrays returned directly from a maker function
//   field  — arrays read from an object a maker returned
//   map    — arrays read from an object cached in a module Map
//   memo   — arrays read from a mutable module-global last-plan memo
// jz's typed-array kind inference is RHS-syntactic (`new.<Ctor>`, src/type.js):
// none of these edges carries the `new`, so element access in the hot loop lowers
// to the dynamic path — measured 2–10× behind the caller-built baseline per edge
// (2026-07), worst on multi-array indexed kernels where vectorization is lost.
// `fftplan` is the composite real-world idiom; THIS case gives the fix per-edge
// coverage so a partial inference (say, return values but not Map fields) shows
// as a partial drop. Fix the inference, not the input — this specimen is fixed.
//
// Bit-exactness: tables are unit-magnitude cos/sin built by complex recurrence
// from an in-source Taylor base angle (same f64 sequence everywhere); butterflies
// are +/−/×. Checksum folds one output sample per edge per frame (values bounded:
// each frame refills the signal, transforms once).

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 2048
const LOG2N = 11
const FRAMES = 24          // transforms per edge per timed sample
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

// Fill wre/wim with W_k = exp(-i·2πk/N) for k in [0, N/2) — recurrence, no libm.
const fillTw = (wre, wim, n) => {
  const dt = -6.283185307179586 / n
  const c1 = cosPoly(dt), s1 = sinPoly(dt)
  let cr = 1, ci = 0
  const half = n >> 1
  for (let k = 0; k < half; k++) {
    wre[k] = cr
    wim[k] = ci
    const nr = cr * c1 - ci * s1
    const ni = cr * s1 + ci * c1
    cr = nr
    ci = ni
  }
}

// --- the four provenance edges (identical table content) --------------------
const mkTwRe = (n) => {
  const wre = new Float64Array(n >> 1), wim = new Float64Array(n >> 1)
  fillTw(wre, wim, n)
  return wre
}
const mkTwIm = (n) => {
  const wre = new Float64Array(n >> 1), wim = new Float64Array(n >> 1)
  fillTw(wre, wim, n)
  return wim
}
const mkTwPair = (n) => {
  const wre = new Float64Array(n >> 1), wim = new Float64Array(n >> 1)
  fillTw(wre, wim, n)
  return { wre, wim }
}
const cache = new Map()
const getCached = (n) => {
  let p = cache.get(n)
  if (p === undefined) {
    p = mkTwPair(n)
    cache.set(n, p)
  }
  return p
}
let lastN = 0, lastPlan = null
const getMemo = (n) => {
  if (n === lastN) return lastPlan
  lastPlan = mkTwPair(n)
  lastN = n
  return lastPlan
}

// --- hot kernel: same butterflies as the `fft` case -------------------------
const transform = (re, im, wre, wim, n) => {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const t2 = im[i]; im[i] = im[j]; im[j] = t2
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = (n / len) | 0
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = wre[k], wi = wim[k]
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
  }
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

  // edge 1: direct returns
  const wreRet = mkTwRe(N)
  const wimRet = mkTwIm(N)
  // edge 2: returned-object fields
  const pair = mkTwPair(N)
  const wreField = pair.wre, wimField = pair.wim
  // edge 3: Map-cached plan fields
  const cached = getCached(N)
  const wreMap = cached.wre, wimMap = cached.wim
  // edge 4: module-global memo fields
  const memo = getMemo(N)
  const wreMemo = memo.wre, wimMemo = memo.wim

  const edge = (wre, wim, h) => {
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < N; i++) { re[i] = sig[i]; im[i] = 0 }
      transform(re, im, wre, wim, N)
      h = mix(h, (re[7] * 1048576) | 0)
    }
    return h
  }
  const runAll = () => {
    let h = 0x811c9dc5 | 0
    h = edge(wreRet, wimRet, h)
    h = edge(wreField, wimField, h)
    h = edge(wreMap, wimMap, h)
    h = edge(wreMemo, wimMemo, h)
    return h >>> 0
  }

  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runAll()

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runAll()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, 4 * FRAMES * ((N * LOG2N) >> 1), 4, N_RUNS)
}
