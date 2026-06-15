// lorenz.js — the Lorenz attractor, the iconic chaotic dynamical system (the
// "butterfly"). A loop-carried RK4 integration of the 3 ODEs — each step depends
// on the last, so it can't be auto-vectorized; native AOT and jz alike run it as
// a tight scalar f64 recurrence, and jz's no-NaN-box codegen makes it the kind of
// kernel where it matches or beats the native field. Pure f64 +/−/× (no
// transcendentals) → bit-identical across every engine and native target (Go's
// arm64 auto-FMA gives the documented `fma` parity class).
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, no class/async/regex.
//
// Reports: median ms, throughput in steps/µs, FNV-1a checksum over the sampled
// trajectory.

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_SAMPLES = 1 << 16    // 65,536 points recorded along the trajectory
const SUBSTEPS = 16          // integration steps between recorded samples
const DT = 0.002
const SIGMA = 10.0, RHO = 28.0, BETA = 8.0 / 3.0
const N_RUNS = 21
const N_WARMUP = 5

// Classical RK4 over the 3 Lorenz ODEs, with the four stage derivatives held in
// scalar locals (no scratch arrays — those would force dynamic typed-array
// dispatch). Loop-carried: the next state depends entirely on this one.
const integrate = (xs) => {
  const H = DT * 0.5, S = DT / 6
  let x = 0.1, y = 0.0, z = 0.0
  for (let s = 0; s < N_SAMPLES; s++) {
    for (let i = 0; i < SUBSTEPS; i++) {
      const k1x = SIGMA * (y - x),    k1y = x * (RHO - z) - y,    k1z = x * y - BETA * z
      const ax = x + k1x * H, ay = y + k1y * H, az = z + k1z * H
      const k2x = SIGMA * (ay - ax),  k2y = ax * (RHO - az) - ay, k2z = ax * ay - BETA * az
      const bx = x + k2x * H, by = y + k2y * H, bz = z + k2z * H
      const k3x = SIGMA * (by - bx),  k3y = bx * (RHO - bz) - by, k3z = bx * by - BETA * bz
      const cx = x + k3x * DT, cy = y + k3y * DT, cz = z + k3z * DT
      const k4x = SIGMA * (cy - cx),  k4y = cx * (RHO - cz) - cy, k4z = cx * cy - BETA * cz
      x = x + S * (k1x + 2 * k2x + 2 * k3x + k4x)
      y = y + S * (k1y + 2 * k2y + 2 * k3y + k4y)
      z = z + S * (k1z + 2 * k2z + 2 * k3z + k4z)
    }
    xs[s] = x + y + z
  }
}

export let main = () => {
  const xs = new Float64Array(N_SAMPLES)

  for (let i = 0; i < N_WARMUP; i++) integrate(xs)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    integrate(xs)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(xs), N_SAMPLES * SUBSTEPS, SUBSTEPS, N_RUNS)
}
