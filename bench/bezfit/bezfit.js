// bezfit.js — least-squares cubic Bézier fitting over digitized point runs: the heart of
// bitmap→vector conversion and font autotracing (Schneider's algorithm, as in potrace /
// FontForge). Per run: chord-length parameterize, estimate end tangents, solve the 2×2
// normal equations for the two inner control points (Bernstein-basis integrals), then one
// Newton–Raphson reparameterization pass and a second solve. Small hot loops over short
// runs, mixed dot products and per-point polynomial evaluation, division and sqrt only —
// every operation exactly rounded, so control points are bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over fitted control points (f64 bits).

import { medianUs, checksumF64, printResult } from '../_lib/benchlib.js'

const RUNS = 256             // digitized strokes
const K = 48                 // points per stroke
const N_ITERS = 6
const N_RUNS = 21
const N_WARMUP = 5

// deterministic wobbly strokes: cubic polynomial paths + small xorshift jitter
const buildRuns = (pts) => {
  let s = 0x9b3f017 | 0
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  for (let r = 0; r < RUNS; r++) {
    const ax = (rnd() % 1000) * 0.1, ay = (rnd() % 1000) * 0.1
    const bx = ((rnd() % 2000) - 1000) * 0.05, by = ((rnd() % 2000) - 1000) * 0.05
    const cx = ((rnd() % 2000) - 1000) * 0.003, cy = ((rnd() % 2000) - 1000) * 0.003
    for (let i = 0; i < K; i++) {
      const t = i / (K - 1)
      const j = ((rnd() % 100) - 50) * 0.002
      pts[(r * K + i) * 2] = ax + bx * t * 10.0 + cx * t * t * 100.0 + j
      pts[(r * K + i) * 2 + 1] = ay + by * t * 10.0 + cy * t * t * t * 100.0 - j
    }
  }
}

// Bernstein basis
const b0 = (t) => { const u = 1.0 - t; return u * u * u }
const b1 = (t) => { const u = 1.0 - t; return 3.0 * t * u * u }
const b2 = (t) => { const u = 1.0 - t; return 3.0 * t * t * u }
const b3 = (t) => t * t * t

// fit one run [o, o+K) given parameter values u[]; writes 8 control values into ctrl at co
const fitOnce = (pts, o, u, ctrl, co) => {
  const x0 = pts[o * 2], y0 = pts[o * 2 + 1]
  const x3 = pts[(o + K - 1) * 2], y3 = pts[(o + K - 1) * 2 + 1]
  // end tangents from first/last chords, normalized
  let t1x = pts[(o + 1) * 2] - x0, t1y = pts[(o + 1) * 2 + 1] - y0
  let l = Math.sqrt(t1x * t1x + t1y * t1y); if (l < 1e-12) l = 1.0
  t1x /= l; t1y /= l
  let t2x = pts[(o + K - 2) * 2] - x3, t2y = pts[(o + K - 2) * 2 + 1] - y3
  l = Math.sqrt(t2x * t2x + t2y * t2y); if (l < 1e-12) l = 1.0
  t2x /= l; t2y /= l
  // normal equations for alpha1, alpha2 (Schneider): A_i = tangent · basis
  let c00 = 0.0, c01 = 0.0, c11 = 0.0, xr1 = 0.0, xr2 = 0.0
  for (let i = 0; i < K; i++) {
    const t = u[i]
    const a1x = t1x * b1(t), a1y = t1y * b1(t)
    const a2x = t2x * b2(t), a2y = t2y * b2(t)
    const sx = pts[(o + i) * 2] - (x0 * (b0(t) + b1(t)) + x3 * (b2(t) + b3(t)))
    const sy = pts[(o + i) * 2 + 1] - (y0 * (b0(t) + b1(t)) + y3 * (b2(t) + b3(t)))
    c00 += a1x * a1x + a1y * a1y
    c01 += a1x * a2x + a1y * a2y
    c11 += a2x * a2x + a2y * a2y
    xr1 += a1x * sx + a1y * sy
    xr2 += a2x * sx + a2y * sy
  }
  let det = c00 * c11 - c01 * c01
  if (det < 1e-12 && det > -1e-12) det = 1e-12
  const alpha1 = (xr1 * c11 - xr2 * c01) / det
  const alpha2 = (xr2 * c00 - xr1 * c01) / det
  ctrl[co] = x0; ctrl[co + 1] = y0
  ctrl[co + 2] = x0 + t1x * alpha1; ctrl[co + 3] = y0 + t1y * alpha1
  ctrl[co + 4] = x3 + t2x * alpha2; ctrl[co + 5] = y3 + t2y * alpha2
  ctrl[co + 6] = x3; ctrl[co + 7] = y3
}

// one Newton–Raphson step per point: move u_i toward the curve's closest approach
const reparam = (pts, o, u, ctrl, co) => {
  const p0x = ctrl[co], p0y = ctrl[co + 1], p1x = ctrl[co + 2], p1y = ctrl[co + 3]
  const p2x = ctrl[co + 4], p2y = ctrl[co + 5], p3x = ctrl[co + 6], p3y = ctrl[co + 7]
  for (let i = 1; i < K - 1; i++) {
    const t = u[i]
    const qx = p0x * b0(t) + p1x * b1(t) + p2x * b2(t) + p3x * b3(t)
    const qy = p0y * b0(t) + p1y * b1(t) + p2y * b2(t) + p3y * b3(t)
    const un = 1.0 - t
    const d1x = 3.0 * (un * un * (p1x - p0x) + 2.0 * un * t * (p2x - p1x) + t * t * (p3x - p2x))
    const d1y = 3.0 * (un * un * (p1y - p0y) + 2.0 * un * t * (p2y - p1y) + t * t * (p3y - p2y))
    const d2x = 6.0 * (un * (p2x - 2.0 * p1x + p0x) + t * (p3x - 2.0 * p2x + p1x))
    const d2y = 6.0 * (un * (p2y - 2.0 * p1y + p0y) + t * (p3y - 2.0 * p2y + p1y))
    const dx = qx - pts[(o + i) * 2], dy = qy - pts[(o + i) * 2 + 1]
    const num = dx * d1x + dy * d1y
    const den = d1x * d1x + d1y * d1y + dx * d2x + dy * d2y
    if (den > 1e-12 || den < -1e-12) {
      let nu = t - num / den
      if (nu < 0.0) nu = 0.0
      if (nu > 1.0) nu = 1.0
      u[i] = nu
    }
  }
}

const runKernel = (pts, u, ctrl) => {
  for (let it = 0; it < N_ITERS; it++) {
    for (let r = 0; r < RUNS; r++) {
      const o = r * K
      // chord-length parameterization
      u[0] = 0.0
      for (let i = 1; i < K; i++) {
        const dx = pts[(o + i) * 2] - pts[(o + i - 1) * 2]
        const dy = pts[(o + i) * 2 + 1] - pts[(o + i - 1) * 2 + 1]
        u[i] = u[i - 1] + Math.sqrt(dx * dx + dy * dy)
      }
      const inv = 1.0 / u[K - 1]
      for (let i = 1; i < K; i++) u[i] *= inv
      const co = r * 8
      fitOnce(pts, o, u, ctrl, co)
      reparam(pts, o, u, ctrl, co)
      fitOnce(pts, o, u, ctrl, co)
    }
  }
}

export let main = () => {
  const pts = new Float64Array(RUNS * K * 2)
  const u = new Float64Array(K)
  const ctrl = new Float64Array(RUNS * 8)
  buildRuns(pts)

  for (let i = 0; i < N_WARMUP; i++) runKernel(pts, u, ctrl)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(pts, u, ctrl)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(ctrl), RUNS * K * N_ITERS, 3, N_RUNS)
}
