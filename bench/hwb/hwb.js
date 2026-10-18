// hwb.js — rgb → hwb over a batch of colors: color-space's WASM kernel, verbatim.
//
// The edges are wasm/batch.js's from color-space (github.com/colorjs/color-space), copied
// unchanged with every top-level declaration they reach; the chain rgb_hwb is the
// one color-space/wasm composes for rgb → hwb, one in-place pass over the buffer per edge,
// as its _n batch loops do. Built by jz 0.9.2 it runs 2.03× color-space's JS batch API
// (100k px, 2026-10-18, Node 22 / Apple M4 Max), against 2.5–6.0× on its best targets.
//
// Hot shapes: one edge: max/min and the hue sector, as HSL; each edge returns a small [a, b, c] array destructured at once.
//
// The source is a fixed specimen: it stays as the library ships it.

import { checksumF64Near, medianUs, printResult } from '../_lib/benchlib.js'

const N_COLORS = 1500000
const N_RUNS = 11
const N_WARMUP = 2

// hue of an rgb triple (0-1), shared by rgb→hsl and rgb→hsv
const rgbHue = (r, g, b, min, max, delta) => {
  let h = 0
  if (max === min) h = 0
  else if (r === max) h = (g - b) / delta
  else if (g === max) h = 2 + (b - r) / delta
  else if (b === max) h = 4 + (r - g) / delta
  h = Math.min(h / 6, 1)
  return h < 0 ? h + 1 : h
}

// rgb→hsl's hue in degrees, for rgb→hwb: a scalar rather than rgb_hsl's first lane, since
// jz 0.9.2 boxes a partly destructured export on the heap per call (pinned by test/wasm-batch.js)
const rgbHueDeg = (r0, g0, b0) => {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255, min = Math.min(r, g, b), max = Math.max(r, g, b)
  return rgbHue(r, g, b, min, max, max - min) * 360
}

const rgb_hwb = (r0, g0, b0) => {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255
  return [rgbHueDeg(r * 255, g * 255, b * 255), Math.min(r, Math.min(g, b)) * 100, (1 - Math.max(r, Math.max(g, b))) * 100]
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
    for (let i = 0; i < n; i++) { const j = 3 * i; const [a, b, c] = rgb_hwb(buf[j], buf[j + 1], buf[j + 2]); buf[j] = a; buf[j + 1] = b; buf[j + 2] = c }
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
