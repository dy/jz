// upfirdn.js — rational resampling in a DSP library's idiom (digital-filter's
// `resample(data, p, q)` over `upfirdn`): the ratio reduced by a gcd so the
// factors are numbers a division made, the anti-alias taps scaled by the
// upsample factor, every output sample gathering the input samples that sit
// on the upsampled grid (`srcIdx % up === 0`, `srcIdx / up`). What the kernel
// class pins: integer parameters the program computes by division, a modulus
// and a division by them in the inner loop, a gather by the quotient.
//
// Reports: median ms across N_RUNS, output checksum (FNV-1a over a sparse
// stride of the result so the optimizer can't elide it).

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_SAMPLES = 96000  // 2 s @ 48 kHz mono
const UP = 6, DOWN = 4   // 48 kHz → 72 kHz once reduced to 3/2
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

// Lowpass taps shaped like a windowed sinc without a transcendental (every
// target computes the same doubles): a symmetric triangle of alternating sign.
const taps = (n) => {
  const h = new Float64Array(n), c = (n - 1) / 2
  let sum = 0
  for (let k = 0; k < n; k++) { const d = k - c; h[k] = (1 - Math.abs(d) / (c + 1)) * (d === 0 ? 1 : (k & 1 ? -0.25 : 0.5) / (1 + Math.abs(d))); sum += h[k] }
  for (let k = 0; k < n; k++) h[k] /= sum
  return h
}

const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t } return a }

const upfirdn = (data, h, up, down) => {
  if (!up) up = 1
  if (!down) down = 1
  const xLen = data.length, hLen = h.length
  const outLen = Math.floor(((xLen - 1) * up + hLen + down - 1) / down)
  const out = new Float64Array(outLen)
  for (let n = 0; n < outLen; n++) {
    let sum = 0
    const upIdx = n * down
    for (let k = 0; k < hLen; k++) {
      const srcIdx = upIdx - k
      if (srcIdx >= 0 && srcIdx % up === 0) {
        const xi = srcIdx / up
        if (xi < xLen) sum += h[k] * data[xi]
      }
    }
    out[n] = sum
  }
  return out
}

const resample = (data, p, q, opts) => {
  if (!opts) opts = {}
  const g = gcd(p, q)
  p = p / g
  q = q / g
  if (p === 1 && q === 1) return new Float64Array(data)
  let numtaps = opts.numtaps || (10 * Math.max(p, q) + 1)
  if (numtaps % 2 === 0) numtaps++
  let h = taps(numtaps)
  for (let i = 0; i < h.length; i++) h[i] *= p
  let delay = (numtaps - 1) / 2
  const prePad = (q - delay % q) % q
  if (prePad) {
    const hp = new Float64Array(prePad + h.length)
    hp.set(h, prePad)
    h = hp
    delay += prePad
  }
  const out = upfirdn(data, h, p, q)
  const expected = Math.ceil(data.length * p / q)
  const startIdx = delay / q
  const result = new Float64Array(expected)
  for (let i = 0; i < expected; i++) {
    const idx = startIdx + i
    result[i] = idx < out.length ? out[idx] : 0
  }
  return result
}

const run = () => {
  const x = mkInput(N_SAMPLES)
  let out
  for (let i = 0; i < N_WARMUP; i++) out = resample(x, UP, DOWN)
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    out = resample(x, UP, DOWN)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), out.length, UP, N_RUNS)
}

export let main = () => {
  run()
}
