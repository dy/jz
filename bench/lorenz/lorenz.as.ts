// lorenz.as.ts — AssemblyScript translation of bench/lorenz/lorenz.js.
//
// Lorenz attractor RK4 integration. Pure f64 +/-/* (no transcendentals) —
// bit-identical across every engine and native target.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N_SAMPLES: i32 = 1 << 16
const SUBSTEPS: i32 = 16
const DT: f64 = 0.002
const SIGMA: f64 = 10.0
const RHO: f64 = 28.0
const BETA: f64 = 8.0 / 3.0
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function checksumF64(a: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const u32len = a.length * 2
  const base = a.dataStart
  for (let i = 0; i < u32len; i += 256) h = (h ^ load<u32>(base + (<usize>i << 2))) * 0x01000193
  return h
}

function integrate(xs: Float64Array): void {
  const H: f64 = DT * 0.5
  const S: f64 = DT / 6.0
  let x: f64 = 0.1, y: f64 = 0.0, z: f64 = 0.0
  for (let s = 0; s < N_SAMPLES; s++) {
    for (let i = 0; i < SUBSTEPS; i++) {
      const k1x = SIGMA * (y - x)
      const k1y = x * (RHO - z) - y
      const k1z = x * y - BETA * z
      const ax = x + k1x * H, ay = y + k1y * H, az = z + k1z * H
      const k2x = SIGMA * (ay - ax)
      const k2y = ax * (RHO - az) - ay
      const k2z = ax * ay - BETA * az
      const bx = x + k2x * H, by = y + k2y * H, bz = z + k2z * H
      const k3x = SIGMA * (by - bx)
      const k3y = bx * (RHO - bz) - by
      const k3z = bx * by - BETA * bz
      const cx = x + k3x * DT, cy = y + k3y * DT, cz = z + k3z * DT
      const k4x = SIGMA * (cy - cx)
      const k4y = cx * (RHO - cz) - cy
      const k4z = cx * cy - BETA * cz
      x = x + S * (k1x + 2.0 * k2x + 2.0 * k3x + k4x)
      y = y + S * (k1y + 2.0 * k2y + 2.0 * k3y + k4y)
      z = z + S * (k1z + 2.0 * k2z + 2.0 * k3z + k4z)
    }
    unchecked(xs[s] = x + y + z)
  }
}

export function main(): void {
  const xs = new Float64Array(N_SAMPLES)
  for (let i = 0; i < N_WARMUP; i++) integrate(xs)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    integrate(xs)
    unchecked(samples[i] = perfNow() - t0)
  }

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
  const cs = checksumF64(xs)
  logLine(<i32>(medianMs * 1000.0), cs, N_SAMPLES * SUBSTEPS, SUBSTEPS, N_RUNS)
}
