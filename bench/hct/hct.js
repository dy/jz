// hct.js — rgb → hct over a batch of colors: color-space's WASM kernel, verbatim.
//
// The edges are wasm/batch.js's from color-space (github.com/colorjs/color-space), copied
// unchanged with every top-level declaration they reach; the chain rgb_lrgb → lrgb_xyz → xyz_hct is the
// one color-space/wasm composes for rgb → hct, one in-place pass over the buffer per edge,
// as its _n batch loops do. Built by jz 0.9.2 it runs 2.08× color-space's JS batch API
// (100k px, 2026-10-18, Node 22 / Apple M4 Max), against 2.5–6.0× on its best targets.
//
// Hot shapes: HCT: CAM16 hue/chroma plus CIELAB L* (cbrt); each edge returns a small [a, b, c] array destructured at once.
//
// The source is a fixed specimen: it stays as the library ships it.

import { checksumF64Near, medianUs, printResult } from '../_lib/benchlib.js'

const N_COLORS = 75000
const N_RUNS = 11
const N_WARMUP = 2

// CIE 1976 companding (shared by lab/luv/hct)
const eps = 216 / 24389, eps3 = 24 / 116, kappa = 24389 / 27

const labF = (t) => t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116

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

const HCT = { fl: 0.3884814537800353, flRoot: 0.7894826179304937, n: 0.18418651851244416, z: 1.909169568483652, nbb: 1.0169191804458755, ncb: 1.0169191804458755, c: 0.69, nc: 1, aW: 29.980990887425254, dR: 1.0211931250282207, dG: 0.98629630699647, dB: 0.9338046211456175, dRi: 0.9792467022066614, dGi: 1.0138940933939633, dBi: 1.0708878253067244, ak: 0.8834525670408592, aki: 1.1319226830134397, uk: 666201.197723509 }

const tau = 2 * Math.PI

const copySign = (a, b) => Math.sign(b) * Math.abs(a)

const zdiv = (a, b) => b === 0 ? 0 : a / b

const hue360 = (h) => { const r = h % 360; return r < 0 ? r + 360 : r }

const camAdapt = (c, fl) => { const x = spow(fl * Math.abs(c) * 0.01, 0.42); return (400 * copySign(x, c)) / (x + 27.13) }

// XYZ (0-100) → [J, C, h°] under viewing conditions E (toCam16)
const toCam16 = (x, y, z, E) => {
  const ra = camAdapt((0.401288 * x + 0.650173 * y - 0.051461 * z) * E.dR, E.fl)
  const ga = camAdapt((-0.250268 * x + 1.204414 * y + 0.045854 * z) * E.dG, E.fl)
  const ba = camAdapt((-0.002079 * x + 0.048952 * y + 0.953127 * z) * E.dB, E.fl)
  const a = ra + (-12 * ga + ba) / 11, b = (ra + ga - 2 * ba) / 9
  const hRad = ((Math.atan2(b, a) % tau) + tau) % tau
  const et = 0.25 * (Math.cos(hRad + 2) + 3.8)
  const t = (5e4 / 13) * E.nc * E.ncb * zdiv(et * Math.sqrt(a * a + b * b), ra + ga + 1.05 * ba + 0.305)
  const alpha = spow(t, 0.9) * E.ak
  const A = E.nbb * (2 * ra + ga + 0.05 * ba)
  const Jroot = spow(A / E.aW, 0.5 * E.c * E.z)
  return [100 * spow(Jroot, 2), alpha * Jroot, hue360(hRad * (180 / Math.PI))]
}

// HCT: CAM16 hue and chroma, CIELAB L* as tone; the inverse Newton-solves J for the tone
const xyz_hct = (x, y, z) => {
  const t = 116 * labF(y / 100) - 16
  if (t === 0) return [0, 0, 0]
  const [J, C, h] = toCam16(x, y, z, HCT)
  return [hue360(h), C, t]
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
    for (let i = 0; i < n; i++) { const j = 3 * i; const [a, b, c] = xyz_hct(buf[j], buf[j + 1], buf[j + 2]); buf[j] = a; buf[j + 1] = b; buf[j + 2] = c }
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
