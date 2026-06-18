// heat.js — 2-D heat diffusion: an explicit-Euler 5-point Laplacian stencil, the
// canonical PDE / scientific-computing kernel (also how a relaxation blur or fluid
// solver steps). Each interior cell relaxes toward its 4 neighbours, updated from a
// SECOND buffer (dst≠src) with a fixed border and no wraparound — the clean
// neighbour-load shape (a[i±1], a[i±W]) jz lifts to f64x2 SIMD. Pure f64 +/−/× with
// a power-of-two coefficient, no transcendentals — so the field is bit-identical
// across every engine and native target (Go's arm64 auto-FMA on `c + K*lap` gives
// the documented `fma` parity class).
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in cell-updates/µs, FNV-1a checksum
// over the final field.
import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const W = 258            // 256×256 interior + a 1-cell fixed (Dirichlet) border
const H = 258
const K = 0.125          // diffusion coefficient (≤¼ → stable); 1/8 is exact in f64
const STEPS = 100        // even → after the ping-pong the field lands back in `a`
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic integer field 0..255 (XorShift32), identical per target.
const seed = (a) => {
  let s = 0x1234abcd | 0
  for (let i = 0; i < a.length; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    a[i] = (s >>> 0) & 255
  }
}

// One diffusion sweep over the interior: dst = src + K·(∇²src). Reads only src,
// writes only dst (distinct buffers, no wrap) → each output cell is independent,
// the lane-local stencil map. Border cells are never written (stay fixed).
const step = (src, dst, w, h) => {
  for (let y = 1; y < h - 1; y++) {
    const row = y * w
    for (let x = 1; x < w - 1; x++) {
      const c = row + x
      dst[c] = src[c] + K * (src[c - 1] + src[c + 1] + src[c - w] + src[c + w] - 4 * src[c])
    }
  }
}

// Ping-pong without reference-swapping (jz-friendly): a→b then b→a, STEPS even.
const run = (a, b) => {
  for (let s = 0; s < STEPS; s += 2) { step(a, b, W, H); step(b, a, W, H) }
}

export let main = () => {
  const a = new Float64Array(W * H)
  const b = new Float64Array(W * H)
  for (let i = 0; i < N_WARMUP; i++) { seed(a); seed(b); run(a, b) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    seed(a); seed(b)          // borders identical in both buffers; re-seed per run
    const t0 = performance.now()
    run(a, b)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(a), (W - 2) * (H - 2) * STEPS, 6, N_RUNS)
}
