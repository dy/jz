// colorlog.js — ARRI LogC4 → XYZ over an image buffer: log-curve decode
// (Math.pow(2, runtime exponent) + branch) → 3×3 matrix. Camera-log color path.
//
// Why it's a jz target: jz runs this ~1.35× SLOWER than V8 (jz 29.9ms vs V8 22.1ms,
// 1M px). The decode is Math.pow(2, runtime exponent) — a runtime-base exp2 (encode is
// log2/log10). That runtime-base exp2/log2 is where jz's codegen trails V8's intrinsics,
// same class as colorpq. Target: fast pow/exp2/log2 so log-format color conversion wins.
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

const la = 2231.8263090676883, lb = 0.9071358748778103, lc = 0.09286412512218964, ls = 0.1135972086105891, lt = -0.01805699611991131
const decode = (v) => v >= 0 ? (Math.pow(2, 14 * (v - lc) / lb + 6) - 64) / la : v * ls + lt
const logc4ToXyz = (src, dst, n) => {
  for (let i = 0; i < n; i++) {
    const j = 3 * i
    const r = decode(src[j]), g = decode(src[j + 1]), b = decode(src[j + 2])
    dst[j] = (0.704858320407232 * r + 0.129760295170463 * g + 0.115837311473977 * b) * 100
    dst[j + 1] = (0.254524176404027 * r + 0.781477732712002 * g - 0.036001909116029 * b) * 100
    dst[j + 2] = 1.089057750759878 * b * 100
  }
}

const run = () => {
  const src = mkInput(N_PIXELS), dst = new Float64Array(N_PIXELS * 3)
  for (let i = 0; i < N_WARMUP; i++) logc4ToXyz(src, dst, N_PIXELS)
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) { const t0 = performance.now(); logc4ToXyz(src, dst, N_PIXELS); samples[i] = performance.now() - t0 }
  printResult(medianUs(samples), checksumF64(dst), N_PIXELS, 1, N_RUNS)
}
export let main = () => { run() }
