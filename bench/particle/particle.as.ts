// particle.as.ts — AssemblyScript translation of bench/particle/particle.js.
//
// Fixed-timestep particle integrator. Pure f64 add/mul — no transcendentals —
// bit-identical across every engine and native target.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 16
const STEPS: i32 = 256
const DT: f64 = 0.015625
const G: f64 = -9.8
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function checksumF64(a: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const u32len = a.length * 2
  const base = a.dataStart
  for (let i = 0; i < u32len; i += 256) h = (h ^ load<u32>(base + (<usize>i << 2))) * 0x01000193
  return h
}

function seedState(px: Float64Array, py: Float64Array, vx: Float64Array, vy: Float64Array, n: i32): void {
  let s: u32 = 0x1234abcd
  for (let i = 0; i < n; i++) {
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    unchecked(px[i] = (<f64>(s) / 4294967296.0) * 2.0 - 1.0)
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    unchecked(py[i] = (<f64>(s) / 4294967296.0) * 2.0 - 1.0)
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    unchecked(vx[i] = (<f64>(s) / 4294967296.0) * 2.0 - 1.0)
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    unchecked(vy[i] = (<f64>(s) / 4294967296.0) * 2.0 - 1.0)
  }
}

function stepSim(px: Float64Array, py: Float64Array, vx: Float64Array, vy: Float64Array, n: i32): void {
  for (let i = 0; i < n; i++) {
    const nvy = unchecked(vy[i]) + G * DT
    unchecked(px[i] = px[i] + vx[i] * DT)
    unchecked(py[i] = py[i] + nvy * DT)
    unchecked(vy[i] = nvy)
  }
}

function run(px: Float64Array, py: Float64Array, vx: Float64Array, vy: Float64Array): void {
  for (let f = 0; f < STEPS; f++) stepSim(px, py, vx, vy, N)
}

export function main(): void {
  const px = new Float64Array(N), py = new Float64Array(N)
  const vx = new Float64Array(N), vy = new Float64Array(N)

  for (let i = 0; i < N_WARMUP; i++) { seedState(px, py, vx, vy, N); run(px, py, vx, vy) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    seedState(px, py, vx, vy, N)
    const t0 = perfNow()
    run(px, py, vx, vy)
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
  const cs = (checksumF64(py) ^ checksumF64(px))
  logLine(<i32>(medianMs * 1000.0), cs, N * STEPS, STEPS, N_RUNS)
}
