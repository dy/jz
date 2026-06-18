// nbody.as.ts — AssemblyScript translation of bench/nbody/nbody.js.
//
// Direct-summation N-body gravitational simulation. The force law uses sqrt
// (IEEE-754 correctly-rounded) — bit-identical across every engine and target.
//
// Builds at -O3 on AssemblyScript >= 0.28. asc 0.27.1 bundles an old binaryen
// (111.0.0-nightly.20230202) that crashes ("memory access out of bounds") in the
// optimizer at -O3 on this file; it is fixed on current asc/binaryen — upgrade asc.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1024
const STEPS: i32 = 8
const DT: f64 = 0.01
const EPS2: f64 = 0.05
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function checksumF64(a: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const u32len = a.length * 2
  const base = a.dataStart
  for (let i = 0; i < u32len; i += 256) h = (h ^ load<u32>(base + (<usize>i << 2))) * 0x01000193
  return h
}

function seedState(
  px: Float64Array, py: Float64Array, pz: Float64Array,
  vx: Float64Array, vy: Float64Array, vz: Float64Array,
  m: Float64Array, n: i32
): void {
  let s: u32 = 0x1234abcd
  for (let i = 0; i < n; i++) {
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    const r0 = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    const r1 = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    const r2 = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    const r3 = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    const r4 = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    const r5 = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    const r6 = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    unchecked(px[i] = r0)
    unchecked(py[i] = r1)
    unchecked(pz[i] = r2)
    unchecked(vx[i] = r3 * 0.1)
    unchecked(vy[i] = r4 * 0.1)
    unchecked(vz[i] = r5 * 0.1)
    unchecked(m[i] = r6 + 1.5)
  }
}

// Kick: accumulate softened-gravity acceleration on every body, advance velocity.
function kick(
  px: Float64Array, py: Float64Array, pz: Float64Array,
  vx: Float64Array, vy: Float64Array, vz: Float64Array,
  m: Float64Array, n: i32
): void {
  for (let i = 0; i < n; i++) {
    const xi = unchecked(px[i]), yi = unchecked(py[i]), zi = unchecked(pz[i])
    let ax: f64 = 0, ay: f64 = 0, az: f64 = 0
    for (let j = 0; j < n; j++) {
      const dx = unchecked(px[j]) - xi
      const dy = unchecked(py[j]) - yi
      const dz = unchecked(pz[j]) - zi
      const r2 = dx * dx + dy * dy + dz * dz + EPS2
      const inv = 1.0 / (r2 * Math.sqrt(r2))
      const f = unchecked(m[j]) * inv
      ax += dx * f; ay += dy * f; az += dz * f
    }
    unchecked(vx[i] = vx[i] + ax * DT)
    unchecked(vy[i] = vy[i] + ay * DT)
    unchecked(vz[i] = vz[i] + az * DT)
  }
}

// Drift: advance positions by the updated velocities.
function drift(
  px: Float64Array, py: Float64Array, pz: Float64Array,
  vx: Float64Array, vy: Float64Array, vz: Float64Array, n: i32
): void {
  for (let i = 0; i < n; i++) {
    unchecked(px[i] = px[i] + vx[i] * DT)
    unchecked(py[i] = py[i] + vy[i] * DT)
    unchecked(pz[i] = pz[i] + vz[i] * DT)
  }
}

function stepSim(
  px: Float64Array, py: Float64Array, pz: Float64Array,
  vx: Float64Array, vy: Float64Array, vz: Float64Array,
  m: Float64Array, n: i32
): void {
  kick(px, py, pz, vx, vy, vz, m, n)
  drift(px, py, pz, vx, vy, vz, n)
}

export function main(): void {
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N)
  const vx = new Float64Array(N), vy = new Float64Array(N), vz = new Float64Array(N)
  const m = new Float64Array(N)

  for (let i = 0; i < N_WARMUP; i++) {
    seedState(px, py, pz, vx, vy, vz, m, N)
    for (let s = 0; s < STEPS; s++) stepSim(px, py, pz, vx, vy, vz, m, N)
  }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    seedState(px, py, pz, vx, vy, vz, m, N)
    const t0 = perfNow()
    for (let s = 0; s < STEPS; s++) stepSim(px, py, pz, vx, vy, vz, m, N)
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
  const cs = (checksumF64(px) ^ checksumF64(vx))
  logLine(<i32>(medianMs * 1000.0), cs, N * N * STEPS, STEPS, N_RUNS)
}
