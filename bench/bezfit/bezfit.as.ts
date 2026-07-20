// bezfit.as.ts — AssemblyScript translation of bench/bezfit/bezfit.js.
//
// Least-squares cubic Bézier fitting over digitized point runs: the heart of
// bitmap→vector conversion and font autotracing (Schneider's algorithm, as in potrace /
// FontForge). Per run: chord-length parameterize, estimate end tangents, solve the 2×2
// normal equations for the two inner control points (Bernstein-basis integrals), then one
// Newton–Raphson reparameterization pass and a second solve. Small hot loops over short
// runs, mixed dot products and per-point polynomial evaluation, division and sqrt only —
// every operation exactly rounded, so control points are bit-identical across languages.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const RUNS: i32 = 256        // digitized strokes
const K: i32 = 48            // points per stroke
const N_ITERS: i32 = 6
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function checksumF64(a: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const u32len = a.length * 2
  const base = a.dataStart
  for (let i = 0; i < u32len; i += 256) h = (h ^ load<u32>(base + (<usize>i << 2))) * 0x01000193
  return h
}

let rngS: u32 = 0
function rnd(): u32 {
  rngS ^= rngS << 13
  rngS ^= rngS >>> 17
  rngS ^= rngS << 5
  return rngS
}

// deterministic wobbly strokes: cubic polynomial paths + small xorshift jitter
function buildRuns(pts: Float64Array): void {
  rngS = 0x9b3f017
  for (let r: i32 = 0; r < RUNS; r++) {
    const ax: f64 = <f64>(rnd() % 1000) * 0.1
    const ay: f64 = <f64>(rnd() % 1000) * 0.1
    const bx: f64 = (<f64>(rnd() % 2000) - 1000.0) * 0.05
    const by: f64 = (<f64>(rnd() % 2000) - 1000.0) * 0.05
    const cx: f64 = (<f64>(rnd() % 2000) - 1000.0) * 0.003
    const cy: f64 = (<f64>(rnd() % 2000) - 1000.0) * 0.003
    for (let i: i32 = 0; i < K; i++) {
      const t: f64 = <f64>i / <f64>(K - 1)
      const j: f64 = (<f64>(rnd() % 100) - 50.0) * 0.002
      unchecked(pts[(r * K + i) * 2] = ax + bx * t * 10.0 + cx * t * t * 100.0 + j)
      unchecked(pts[(r * K + i) * 2 + 1] = ay + by * t * 10.0 + cy * t * t * t * 100.0 - j)
    }
  }
}

// Bernstein basis
function b0(t: f64): f64 { const u = 1.0 - t; return u * u * u }
function b1(t: f64): f64 { const u = 1.0 - t; return 3.0 * t * u * u }
function b2(t: f64): f64 { const u = 1.0 - t; return 3.0 * t * t * u }
function b3(t: f64): f64 { return t * t * t }

// fit one run [o, o+K) given parameter values u[]; writes 8 control values into ctrl at co
function fitOnce(pts: Float64Array, o: i32, u: Float64Array, ctrl: Float64Array, co: i32): void {
  const x0: f64 = unchecked(pts[o * 2]), y0: f64 = unchecked(pts[o * 2 + 1])
  const x3: f64 = unchecked(pts[(o + K - 1) * 2]), y3: f64 = unchecked(pts[(o + K - 1) * 2 + 1])
  // end tangents from first/last chords, normalized
  let t1x: f64 = unchecked(pts[(o + 1) * 2]) - x0
  let t1y: f64 = unchecked(pts[(o + 1) * 2 + 1]) - y0
  let l: f64 = Math.sqrt(t1x * t1x + t1y * t1y)
  if (l < 1e-12) l = 1.0
  t1x /= l; t1y /= l
  let t2x: f64 = unchecked(pts[(o + K - 2) * 2]) - x3
  let t2y: f64 = unchecked(pts[(o + K - 2) * 2 + 1]) - y3
  l = Math.sqrt(t2x * t2x + t2y * t2y)
  if (l < 1e-12) l = 1.0
  t2x /= l; t2y /= l
  // normal equations for alpha1, alpha2 (Schneider): A_i = tangent · basis
  let c00: f64 = 0.0, c01: f64 = 0.0, c11: f64 = 0.0, xr1: f64 = 0.0, xr2: f64 = 0.0
  for (let i: i32 = 0; i < K; i++) {
    const t: f64 = unchecked(u[i])
    const a1x: f64 = t1x * b1(t), a1y: f64 = t1y * b1(t)
    const a2x: f64 = t2x * b2(t), a2y: f64 = t2y * b2(t)
    const sx: f64 = unchecked(pts[(o + i) * 2]) - (x0 * (b0(t) + b1(t)) + x3 * (b2(t) + b3(t)))
    const sy: f64 = unchecked(pts[(o + i) * 2 + 1]) - (y0 * (b0(t) + b1(t)) + y3 * (b2(t) + b3(t)))
    c00 += a1x * a1x + a1y * a1y
    c01 += a1x * a2x + a1y * a2y
    c11 += a2x * a2x + a2y * a2y
    xr1 += a1x * sx + a1y * sy
    xr2 += a2x * sx + a2y * sy
  }
  let det: f64 = c00 * c11 - c01 * c01
  if (det < 1e-12 && det > -1e-12) det = 1e-12
  const alpha1: f64 = (xr1 * c11 - xr2 * c01) / det
  const alpha2: f64 = (xr2 * c00 - xr1 * c01) / det
  unchecked(ctrl[co] = x0); unchecked(ctrl[co + 1] = y0)
  unchecked(ctrl[co + 2] = x0 + t1x * alpha1); unchecked(ctrl[co + 3] = y0 + t1y * alpha1)
  unchecked(ctrl[co + 4] = x3 + t2x * alpha2); unchecked(ctrl[co + 5] = y3 + t2y * alpha2)
  unchecked(ctrl[co + 6] = x3); unchecked(ctrl[co + 7] = y3)
}

// one Newton–Raphson step per point: move u_i toward the curve's closest approach
function reparam(pts: Float64Array, o: i32, u: Float64Array, ctrl: Float64Array, co: i32): void {
  const p0x: f64 = unchecked(ctrl[co]), p0y: f64 = unchecked(ctrl[co + 1])
  const p1x: f64 = unchecked(ctrl[co + 2]), p1y: f64 = unchecked(ctrl[co + 3])
  const p2x: f64 = unchecked(ctrl[co + 4]), p2y: f64 = unchecked(ctrl[co + 5])
  const p3x: f64 = unchecked(ctrl[co + 6]), p3y: f64 = unchecked(ctrl[co + 7])
  for (let i: i32 = 1; i < K - 1; i++) {
    const t: f64 = unchecked(u[i])
    const qx: f64 = p0x * b0(t) + p1x * b1(t) + p2x * b2(t) + p3x * b3(t)
    const qy: f64 = p0y * b0(t) + p1y * b1(t) + p2y * b2(t) + p3y * b3(t)
    const un: f64 = 1.0 - t
    const d1x: f64 = 3.0 * (un * un * (p1x - p0x) + 2.0 * un * t * (p2x - p1x) + t * t * (p3x - p2x))
    const d1y: f64 = 3.0 * (un * un * (p1y - p0y) + 2.0 * un * t * (p2y - p1y) + t * t * (p3y - p2y))
    const d2x: f64 = 6.0 * (un * (p2x - 2.0 * p1x + p0x) + t * (p3x - 2.0 * p2x + p1x))
    const d2y: f64 = 6.0 * (un * (p2y - 2.0 * p1y + p0y) + t * (p3y - 2.0 * p2y + p1y))
    const dx: f64 = qx - unchecked(pts[(o + i) * 2])
    const dy: f64 = qy - unchecked(pts[(o + i) * 2 + 1])
    const num: f64 = dx * d1x + dy * d1y
    const den: f64 = d1x * d1x + d1y * d1y + dx * d2x + dy * d2y
    if (den > 1e-12 || den < -1e-12) {
      let nu: f64 = t - num / den
      if (nu < 0.0) nu = 0.0
      if (nu > 1.0) nu = 1.0
      unchecked(u[i] = nu)
    }
  }
}

function runKernel(pts: Float64Array, u: Float64Array, ctrl: Float64Array): void {
  for (let it: i32 = 0; it < N_ITERS; it++) {
    for (let r: i32 = 0; r < RUNS; r++) {
      const o: i32 = r * K
      // chord-length parameterization
      unchecked(u[0] = 0.0)
      for (let i: i32 = 1; i < K; i++) {
        const dx: f64 = unchecked(pts[(o + i) * 2]) - unchecked(pts[(o + i - 1) * 2])
        const dy: f64 = unchecked(pts[(o + i) * 2 + 1]) - unchecked(pts[(o + i - 1) * 2 + 1])
        unchecked(u[i] = u[i - 1] + Math.sqrt(dx * dx + dy * dy))
      }
      const inv: f64 = 1.0 / unchecked(u[K - 1])
      for (let i: i32 = 1; i < K; i++) unchecked(u[i] = u[i] * inv)
      const co: i32 = r * 8
      fitOnce(pts, o, u, ctrl, co)
      reparam(pts, o, u, ctrl, co)
      fitOnce(pts, o, u, ctrl, co)
    }
  }
}

export function main(): void {
  const pts = new Float64Array(RUNS * K * 2)
  const u = new Float64Array(K)
  const ctrl = new Float64Array(RUNS * 8)
  buildRuns(pts)

  for (let i = 0; i < N_WARMUP; i++) runKernel(pts, u, ctrl)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    runKernel(pts, u, ctrl)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumF64(ctrl)

  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, RUNS * K * N_ITERS, 3, N_RUNS)
}
