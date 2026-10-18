// jzczhz.js — rgb → jzczhz over a batch of colors: color-space's WASM kernel, verbatim.
//
// The edges are wasm/batch.js's from color-space (github.com/colorjs/color-space), copied
// unchanged with every top-level declaration they reach; the chain rgb_lrgb → lrgb_xyz → xyz_jzazbz → polar_fwd is the
// one color-space/wasm composes for rgb → jzczhz, one in-place pass over the buffer per edge,
// as its _n batch loops do. Built by jz 0.9.2 it runs 1.41× color-space's JS batch API
// (100k px, 2026-10-18, Node 22 / Apple M4 Max), against 2.5–6.0× on its best targets.
//
// Hot shapes: Jzazbz, then the polar step (Math.hypot, Math.atan2, degree wrap); each edge returns a small [a, b, c] array destructured at once.
//
// The source is a fixed specimen: it stays as the library ships it.

import { checksumF64Near, medianUs, printResult } from '../_lib/benchlib.js'

const N_COLORS = 120000
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

// ---- generic cartesian <-> cylindrical (serves every LCh-family space) ----

const polar_fwd = (l, a, b) => {
  const c = Math.sqrt(a * a + b * b)
  const hr = Math.atan2(b, a) * 180 / Math.PI
  return [l, c, c < 1e-8 ? 0 : (hr < 0 ? hr + 360 : hr)]
}

// ---- xyz <-> jzazbz (HDR; modified ST 2084 PQ, p = 1.7·m2) ----
const Yw_jz = 203, b_param = 1.15, g_param = 0.66, d = -0.56, d0 = 1.6295499532821566e-11

const n_val = 2610 / 16384, ninv = 16384 / 2610, c1 = 3424 / 4096, c2 = 2413 / 128, c3 = 2392 / 128

const p = 1.7 * 2523 / 32, pinv = 32 / (1.7 * 2523)

const xc00 = 0.41478972, xc01 = 0.579999, xc02 = 0.0146480, xc10 = -0.2015100, xc11 = 1.120649, xc12 = 0.0531008, xc20 = -0.0166008, xc21 = 0.264800, xc22 = 0.6684799

const ci00 = 0.5, ci01 = 0.5, ci02 = 0, ci10 = 3.524000, ci11 = -4.066708, ci12 = 0.542708, ci20 = 0.199076, ci21 = 1.096799, ci22 = -1.295875

const xyz_jzazbz = (X, Y, Z) => {
  const Xa = X / 100 * Yw_jz, Ya = Y / 100 * Yw_jz, Za = Z / 100 * Yw_jz
  const Xm = b_param * Xa - (b_param - 1) * Za, Ym = g_param * Ya - (g_param - 1) * Xa
  const L = xc00 * Xm + xc01 * Ym + xc02 * Za, M = xc10 * Xm + xc11 * Ym + xc12 * Za, S = xc20 * Xm + xc21 * Ym + xc22 * Za
  const PL = spow((c1 + c2 * spow(L / 10000, n_val)) / (1 + c3 * spow(L / 10000, n_val)), p)
  const PM = spow((c1 + c2 * spow(M / 10000, n_val)) / (1 + c3 * spow(M / 10000, n_val)), p)
  const PS = spow((c1 + c2 * spow(S / 10000, n_val)) / (1 + c3 * spow(S / 10000, n_val)), p)
  const Iz = ci00 * PL + ci01 * PM + ci02 * PS
  return [((1 + d) * Iz) / (1 + d * Iz) - d0, ci10 * PL + ci11 * PM + ci12 * PS, ci20 * PL + ci21 * PM + ci22 * PS]
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
    for (let i = 0; i < n; i++) { const j = 3 * i; const [a, b, c] = xyz_jzazbz(buf[j], buf[j + 1], buf[j + 2]); buf[j] = a; buf[j + 1] = b; buf[j + 2] = c }
    for (let i = 0; i < n; i++) { const j = 3 * i; const [a, b, c] = polar_fwd(buf[j], buf[j + 1], buf[j + 2]); buf[j] = a; buf[j + 1] = b; buf[j + 2] = c }
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
