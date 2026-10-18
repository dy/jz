// ipt.js — rgb → ipt over a batch of colors: color-space's WASM kernel, verbatim.
//
// The edges are wasm/batch.js's from color-space (github.com/colorjs/color-space), copied
// unchanged with every top-level declaration they reach; the chain rgb_lrgb → lrgb_xyz → xyz_ipt is the
// one color-space/wasm composes for rgb → ipt, one in-place pass over the buffer per edge,
// as its _n batch loops do. Built by jz 0.9.2 it runs 2.15× color-space's JS batch API
// (100k px, 2026-10-18, Node 22 / Apple M4 Max), against 2.5–6.0× on its best targets.
//
// Hot shapes: IPT: 3×3 matrix, sign-extended ** 0.43 per cone, 3×3 matrix; each edge returns a small [a, b, c] array destructured at once.
//
// The source is a fixed specimen: it stays as the library ships it.

import { checksumF64Near, medianUs, printResult } from '../_lib/benchlib.js'

const N_COLORS = 250000
const N_RUNS = 11
const N_WARMUP = 2

// sign-extended power (shared by jzazbz, ipt, a98rgb, cam16); out-of-gamut safe
const spow = (a, e) => { const s = a < 0 ? -1 : 1, av = a < 0 ? -a : a; return s * av ** e }

const sgn = (v) => v < 0 ? -1 : 1

// sRGB / IEC 61966-2-1 (also Display P3)
const srgbDec = (v) => { const a = Math.abs(v); return sgn(v) * (a > 0.04045 ? ((a + 0.055) / 1.055) ** 2.4 : a / 12.92) }

// ---- rgb / lrgb / xyz / oklab / oklrab (hub: lrgb, xyz) ----

const rgb_lrgb = (r, g, b) => [srgbDec(r / 255), srgbDec(g / 255), srgbDec(b / 255)]

const lrgb_xyz = (r, g, b) => [
  100 * (0.41239079926595 * r + 0.35758433938387 * g + 0.18048078840183 * b),
  100 * (0.21263900587151 * r + 0.71516867876775 * g + 0.072192315360733 * b),
  100 * (0.019330818715591 * r + 0.11919477979462 * g + 0.95053215224966 * b)
]

// ---- xyz <-> ipt (Ebner & Fairchild 1998) ----
const M1_00 = 0.4002, M1_01 = 0.7075, M1_02 = -0.0807, M1_10 = -0.228, M1_11 = 1.15, M1_12 = 0.0612, M1_20 = 0, M1_21 = 0, M1_22 = 0.9184

const M2_00 = 0.4, M2_01 = 0.4, M2_02 = 0.2, M2_10 = 4.455, M2_11 = -4.851, M2_12 = 0.396, M2_20 = 0.8056, M2_21 = 0.3572, M2_22 = -1.1628

const xyz_ipt = (X, Y, Z) => {
  const xn = X / 100, yn = Y / 100, zn = Z / 100
  const lp = spow(M1_00 * xn + M1_01 * yn + M1_02 * zn, 0.43), mp = spow(M1_10 * xn + M1_11 * yn + M1_12 * zn, 0.43), sp = spow(M1_20 * xn + M1_21 * yn + M1_22 * zn, 0.43)
  return [M2_00 * lp + M2_01 * mp + M2_02 * sp, M2_10 * lp + M2_11 * mp + M2_12 * sp, M2_20 * lp + M2_21 * mp + M2_22 * sp]
}

// deterministic sRGB 0-255 (XorShift32), as the batch API takes it
const mkInput = (n) => {
  const out = new Float64Array(n * 3)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n * 3; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = 255 * ((s >>> 0) / 4294967296)
  }
  return out
}

const convert = (src, buf, n) => {
  buf.set(src)
    for (let i = 0; i < n; i++) { const j = 3 * i; const [a, b, c] = rgb_lrgb(buf[j], buf[j + 1], buf[j + 2]); buf[j] = a; buf[j + 1] = b; buf[j + 2] = c }
    for (let i = 0; i < n; i++) { const j = 3 * i; const [a, b, c] = lrgb_xyz(buf[j], buf[j + 1], buf[j + 2]); buf[j] = a; buf[j + 1] = b; buf[j + 2] = c }
    for (let i = 0; i < n; i++) { const j = 3 * i; const [a, b, c] = xyz_ipt(buf[j], buf[j + 1], buf[j + 2]); buf[j] = a; buf[j + 1] = b; buf[j + 2] = c }
}

const run = () => {
  const src = mkInput(N_COLORS)
  const dst = new Float64Array(N_COLORS * 3)

  for (let i = 0; i < N_WARMUP; i++) convert(src, dst, N_COLORS)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    convert(src, dst, N_COLORS)
    samples[i] = performance.now() - t0
  }

  printResult(medianUs(samples), checksumF64Near(dst), N_COLORS, 1, N_RUNS)
}

export let main = () => {
  run()
}
