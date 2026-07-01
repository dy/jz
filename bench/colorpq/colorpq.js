// colorpq.js — sRGB → JzAzBz over an image buffer: per pixel = 3×3 matrix →
// modified ST 2084 PQ (≈12 signed-power `spow` calls: sign-branch + a**e with a
// non-constant exponent) → 3×3 matrix.
//
// Why it's a jz target: in color-space the rgb→jzazbz batch path runs ~0.64× vs V8
// (SLOWER) — the only thing between it and the cube-root paths (which win 1.4–1.7×)
// is the PQ block. `spow(a,e) = sign(a)*|a|**e` does a sign branch then a**e; jz's
// pow with a runtime exponent (and the branch blocking vectorization) trails V8's
// Math.pow here. Target: fast runtime-exponent pow + branchless signed-pow so the
// PQ-heavy HDR conversions stop losing.
import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_PIXELS = 1000000
const N_RUNS = 21
const N_WARMUP = 5

const mkInput = (n) => {
  const out = new Float64Array(n * 3)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n * 3; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; out[i] = (s >>> 0) / 4294967296 * 100 }
  return out
}

const spow = (a, e) => { const s = a < 0 ? -1 : 1, av = a < 0 ? -a : a; return s * av ** e }

// JzAzBz (Safdar 2017): XYZ (0-100) → Jz,az,bz. PQ exponent p = 1.7·m2.
const Yw = 203, b1 = 1.15, g1 = 0.66, d = -0.56, d0 = 1.6295499532821566e-11
const nv = 2610 / 16384, c1 = 3424 / 4096, c2 = 2413 / 128, c3 = 2392 / 128, p = 1.7 * 2523 / 32
const xyzToJzazbz = (src, dst, n) => {
  for (let i = 0; i < n; i++) {
    const j = 3 * i
    const Xa = src[j] / 100 * Yw, Ya = src[j + 1] / 100 * Yw, Za = src[j + 2] / 100 * Yw
    const Xm = b1 * Xa - (b1 - 1) * Za, Ym = g1 * Ya - (g1 - 1) * Xa
    const L = 0.41478972 * Xm + 0.579999 * Ym + 0.014648 * Za
    const M = -0.20151 * Xm + 1.120649 * Ym + 0.0531008 * Za
    const S = -0.0166008 * Xm + 0.2648 * Ym + 0.6684799 * Za
    const PL = spow((c1 + c2 * spow(L / 10000, nv)) / (1 + c3 * spow(L / 10000, nv)), p)
    const PM = spow((c1 + c2 * spow(M / 10000, nv)) / (1 + c3 * spow(M / 10000, nv)), p)
    const PS = spow((c1 + c2 * spow(S / 10000, nv)) / (1 + c3 * spow(S / 10000, nv)), p)
    const Iz = 0.5 * PL + 0.5 * PM
    dst[j] = (1 + d) * Iz / (1 + d * Iz) - d0
    dst[j + 1] = 3.524 * PL - 4.066708 * PM + 0.542708 * PS
    dst[j + 2] = 0.199076 * PL + 1.096799 * PM - 1.295875 * PS
  }
}

const run = () => {
  const src = mkInput(N_PIXELS), dst = new Float64Array(N_PIXELS * 3)
  for (let i = 0; i < N_WARMUP; i++) xyzToJzazbz(src, dst, N_PIXELS)
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) { const t0 = performance.now(); xyzToJzazbz(src, dst, N_PIXELS); samples[i] = performance.now() - t0 }
  printResult(medianUs(samples), checksumF64(dst), N_PIXELS, 1, N_RUNS)
}
export let main = () => { run() }
