// a98rgb.js — rgb → a98rgb over a batch of colors: color-space's WASM kernel, verbatim.
//
// The edges are wasm/batch.js's from color-space (github.com/colorjs/color-space), copied
// unchanged with every top-level declaration they reach; the chain rgb_lrgb → lrgb_xyz → xyz_a98rgb is the
// one color-space/wasm composes for rgb → a98rgb, one in-place pass over the buffer per edge,
// as its _n batch loops do. Built by jz 0.9.2 it runs 2.08× color-space's JS batch API
// (100k px, 2026-10-18, Node 22 / Apple M4 Max), against 2.5–6.0× on its best targets.
//
// Hot shapes: two transfer curves (** 2.4 in, sign-extended spow ** 256/563 out) around two 3×3 matrices; each edge returns a small [a, b, c] array destructured at once.
//
// The source is a fixed specimen: it stays as the library ships it.

import { checksumF64Near, medianUs, printResult } from '../_lib/benchlib.js'

const N_COLORS = 300000
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

const xyz_a98rgblinear = (x0, y0, z0) => {
  const x = x0 / 100, y = y0 / 100, z = z0 / 100
  return [
    2.0415879038107465 * x - 0.5650069742788597 * y - 0.34473135077832956 * z,
    -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z,
    0.013444280632031149 * x - 0.11836239223101837 * y + 1.0151749943912054 * z
  ]
}

const xyz_a98rgb = (x, y, z) => { const [r, g, b] = xyz_a98rgblinear(x, y, z); return [spow(r, 256 / 563), spow(g, 256 / 563), spow(b, 256 / 563)] }

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
    for (let i = 0; i < n; i++) { const j = 3 * i; const [a, b, c] = xyz_a98rgb(buf[j], buf[j + 1], buf[j + 2]); buf[j] = a; buf[j + 1] = b; buf[j + 2] = c }
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
