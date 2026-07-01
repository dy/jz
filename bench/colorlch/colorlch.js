// colorlch.js — sRGB → OkLCh over an image-sized buffer, FUSED in one loop: per
// pixel = sRGB EOTF (pow) → 3×3 → cbrt → 3×3 → sqrt + atan2 (cartesian→polar).
//
// Why it's a jz target: this FUSED single loop is ~parity with V8 (jz 82ms vs V8
// 83ms, 1.01×), but the SAME conversion split into two passes (a cbrt loop, then an
// atan2 loop) runs 1.6× faster in jz — jz vectorizes/schedules cbrt and atan2 well
// apart but not mixed in one body (register pressure on the fused loop). Fusion does
// strictly LESS memory traffic, so it must never be slower than splitting. Target:
// schedule the mixed-transcendental body so fused ≥ split — then natural single-pass
// color code wins without hand-splitting it.
import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_PIXELS = 1000000
const N_RUNS = 21
const N_WARMUP = 5

const mkInput = (n) => {
  const out = new Float64Array(n * 3)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n * 3; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; out[i] = (s >>> 0) / 4294967296 }
  return out
}

const lin = (c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

const srgbToOklch = (src, dst, n) => {
  for (let i = 0; i < n; i++) {
    const r = lin(src[3 * i]), g = lin(src[3 * i + 1]), b = lin(src[3 * i + 2])
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    const okl = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    const c = Math.sqrt(a * a + bb * bb)
    let h = Math.atan2(bb, a) * 180 / Math.PI
    if (h < 0) h += 360
    dst[3 * i] = okl; dst[3 * i + 1] = c; dst[3 * i + 2] = h
  }
}

const run = () => {
  const src = mkInput(N_PIXELS)
  const dst = new Float64Array(N_PIXELS * 3)
  for (let i = 0; i < N_WARMUP; i++) srgbToOklch(src, dst, N_PIXELS)
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) { const t0 = performance.now(); srgbToOklch(src, dst, N_PIXELS); samples[i] = performance.now() - t0 }
  printResult(medianUs(samples), checksumF64(dst), N_PIXELS, 1, N_RUNS)
}

export let main = () => { run() }
