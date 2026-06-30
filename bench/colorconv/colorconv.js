// colorconv.js — sRGB → Oklab over an image-sized buffer (RGB interleaved Float64Array).
//
// The hot path of perceptual color work (gradients, image filters, gamut work):
// per pixel = sRGB EOTF (Math.pow) → 3×3 matrix → Math.cbrt → 3×3 matrix.
//
// Why it's a good jz target: the matrix MAD chains already beat V8, but the loop is
// dominated by Math.cbrt and Math.pow. On V8, Math.cbrt is a fast intrinsic; a naive
// wasm cbrt is ~3-4× slower, which flips the whole conversion from a win to a loss.
// So this case stresses exactly the transcendental codegen (fast/vectorized cbrt and
// constant-exponent pow) that decides whether jz wins real color pipelines.
//
// Lowest common subset: const/let + arrows, Float64Array, Math.imul checksum.

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_PIXELS = 1000000
const N_RUNS = 21
const N_WARMUP = 5

// deterministic sRGB input in [0,1) via XorShift32
const mkInput = (n) => {
  const out = new Float64Array(n * 3)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n * 3; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = (s >>> 0) / 4294967296
  }
  return out
}

// sRGB electro-optical transfer function (gamma → linear)
const lin = (c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

// Björnsson Oklab matrices (linear sRGB → LMS → Oklab)
const srgbToOklab = (src, dst, n) => {
  for (let i = 0; i < n; i++) {
    const r = lin(src[3 * i]), g = lin(src[3 * i + 1]), b = lin(src[3 * i + 2])
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    dst[3 * i]     = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    dst[3 * i + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    dst[3 * i + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  }
}

const run = () => {
  const src = mkInput(N_PIXELS)
  const dst = new Float64Array(N_PIXELS * 3)

  for (let i = 0; i < N_WARMUP; i++) srgbToOklab(src, dst, N_PIXELS)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    srgbToOklab(src, dst, N_PIXELS)
    samples[i] = performance.now() - t0
  }

  printResult(medianUs(samples), checksumF64(dst), N_PIXELS, 1, N_RUNS)
}

export let main = () => {
  run()
}
