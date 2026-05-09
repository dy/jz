// mandelbrot.js — Mandelbrot escape-time iteration over a complex grid.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly
// by JS engines. Lowest-common JS subset:
//   - const/let + arrow functions
//   - Uint32Array (typed array)
//   - Math.imul for portable 32-bit checksum
//   - No regex, class, async, BigInt
//
// Algorithm: per pixel, iterate z := z² + c with z₀ = 0 until |z|² > 4 or
// max-iter cap. Records iteration count per pixel. Hot loop is the inner
// while: 4 fmuls + 1 fadd + 1 fsub + 1 cmp.
//
// Reports: median ms across N_RUNS, output checksum (FNV-1a stride-128 over
// the iteration-count buffer so the optimizer can't elide it).

import { checksumU32, medianUs, printResult } from '../_lib/benchlib.js'

const W = 256
const H = 256
const MAX_ITER = 256
const N_RUNS = 21
const N_WARMUP = 5

// Plotting region covering the full set + escape annulus.
const X0 = -2.0
const X1 = 0.5
const Y0 = -1.25
const Y1 = 1.25

const render = (out) => {
  const dx = (X1 - X0) / W
  const dy = (Y1 - Y0) / H
  for (let py = 0; py < H; py++) {
    const cy = Y0 + py * dy
    for (let px = 0; px < W; px++) {
      const cx = X0 + px * dx
      let zx = 0, zy = 0, i = 0
      while (i < MAX_ITER) {
        const x2 = zx * zx, y2 = zy * zy
        if (x2 + y2 > 4.0) break
        zy = 2 * zx * zy + cy
        zx = x2 - y2 + cx
        i++
      }
      out[py * W + px] = i
    }
  }
}

const run = () => {
  const out = new Uint32Array(W * H)

  for (let i = 0; i < N_WARMUP; i++) render(out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    render(out)
    samples[i] = performance.now() - t0
  }

  printResult(medianUs(samples), checksumU32(out), W * H, MAX_ITER, N_RUNS)
}

export let main = () => {
  run()
}
