// blur.js — separable box blur on an RGBA8 image (horizontal pass then vertical),
// the canonical image-pipeline kernel. Pure integer accumulation with edge clamp
// and integer divide → the rendered image is bit-identical across every engine and
// native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in pixels/µs, FNV-1a checksum over
// the blurred output buffer.

import { checksumU8, medianUs, printResult } from '../_lib/benchlib.js'

const W = 512
const H = 512
const R = 4                 // blur radius → 9-tap window per axis
const WIN = 2 * R + 1
const N = W * H * 4
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic RGBA noise — XorShift32 bytes, identical per target.
const mkImage = (n) => {
  const out = new Uint8Array(n)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = (s >>> 0) & 255
  }
  return out
}

// Horizontal box blur: each output pixel = mean of [x-R, x+R], edge-clamped.
const hblur = (src, dst, w, h, r) => {
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0
      for (let k = -r; k <= r; k++) {
        let xi = x + k
        if (xi < 0) xi = 0
        else if (xi >= w) xi = w - 1
        const p = (row + xi) << 2
        sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; sa += src[p + 3]
      }
      const o = (row + x) << 2
      dst[o] = (sr / win) | 0
      dst[o + 1] = (sg / win) | 0
      dst[o + 2] = (sb / win) | 0
      dst[o + 3] = (sa / win) | 0
    }
  }
}

// Vertical box blur: each output pixel = mean of [y-R, y+R], edge-clamped.
const vblur = (src, dst, w, h, r) => {
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0
      for (let k = -r; k <= r; k++) {
        let yi = y + k
        if (yi < 0) yi = 0
        else if (yi >= h) yi = h - 1
        const p = (yi * w + x) << 2
        sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; sa += src[p + 3]
      }
      const o = (y * w + x) << 2
      dst[o] = (sr / win) | 0
      dst[o + 1] = (sg / win) | 0
      dst[o + 2] = (sb / win) | 0
      dst[o + 3] = (sa / win) | 0
    }
  }
}

export let main = () => {
  const img = mkImage(N)
  const tmp = new Uint8Array(N)
  const out = new Uint8Array(N)
  for (let i = 0; i < N_WARMUP; i++) { hblur(img, tmp, W, H, R); vblur(tmp, out, W, H, R) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    hblur(img, tmp, W, H, R)
    vblur(tmp, out, W, H, R)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumU8(out), W * H, WIN, N_RUNS)
}
