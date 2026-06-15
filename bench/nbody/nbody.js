// nbody.js — direct-summation N-body gravitational simulation, the canonical
// scientific-computing kernel. O(N²) pairwise softened-gravity accelerations per
// step, struct-of-arrays layout, leapfrog-style update. The force law uses
// `Math.sqrt` (IEEE-754 correctly-rounded → identical on every engine and native
// target), so the trajectory is bit-identical everywhere (Go's arm64 auto-FMA on
// the `a += b*c` accumulations gives the documented `fma` parity class).
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, no class/async/regex.
//
// The inner force loop is a per-body f64 reduction over all others — dense
// transcendental-free numerics, the shape jz's scalar f64 codegen runs without
// NaN-box overhead. Reports: median ms, throughput in interactions/µs, FNV-1a
// checksum over the final positions.

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N = 1024           // bodies
const STEPS = 8          // integration steps per run
const DT = 0.01
const EPS2 = 0.05        // softening², avoids the i==j singularity (self-force = 0)
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic initial state — XorShift32 in [-1, 1); masses in [0.5, 2.5).
const seedState = (px, py, pz, vx, vy, vz, m, n) => {
  let s = 0x1234abcd | 0
  const r = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1 }
  for (let i = 0; i < n; i++) {
    px[i] = r(); py[i] = r(); pz[i] = r()
    vx[i] = r() * 0.1; vy[i] = r() * 0.1; vz[i] = r() * 0.1
    m[i] = r() + 1.5
  }
}

// One step: accumulate softened-gravity acceleration on every body from every
// other, kick the velocities, then drift the positions. The j-loop is the O(N²)
// hot path — a dense f64 reduction with one sqrt + reciprocal per interaction.
const step = (px, py, pz, vx, vy, vz, m, n) => {
  for (let i = 0; i < n; i++) {
    const xi = px[i], yi = py[i], zi = pz[i]
    let ax = 0, ay = 0, az = 0
    for (let j = 0; j < n; j++) {
      const dx = px[j] - xi, dy = py[j] - yi, dz = pz[j] - zi
      const r2 = dx * dx + dy * dy + dz * dz + EPS2
      const inv = 1 / (r2 * Math.sqrt(r2))   // r2^-1.5
      const f = m[j] * inv
      ax += dx * f; ay += dy * f; az += dz * f
    }
    vx[i] += ax * DT; vy[i] += ay * DT; vz[i] += az * DT
  }
  for (let i = 0; i < n; i++) { px[i] += vx[i] * DT; py[i] += vy[i] * DT; pz[i] += vz[i] * DT }
}

export let main = () => {
  // Separate Float64Array locals (not an object of arrays) so the type flows
  // into `step` and the element accesses stay direct f64 loads, not dynamic
  // typed-index dispatch.
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N)
  const vx = new Float64Array(N), vy = new Float64Array(N), vz = new Float64Array(N)
  const m = new Float64Array(N)
  const init = () => seedState(px, py, pz, vx, vy, vz, m, N)
  const runAll = () => { for (let s = 0; s < STEPS; s++) step(px, py, pz, vx, vy, vz, m, N) }

  for (let i = 0; i < N_WARMUP; i++) { init(); runAll() }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    init()
    const t0 = performance.now()
    runAll()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), (checksumF64(px) ^ checksumF64(vx)) >>> 0, N * N * STEPS, STEPS, N_RUNS)
}
