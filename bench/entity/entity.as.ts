// entity.as.ts — AssemblyScript translation of bench/entity/entity.js.
//
// In-place entity update over an array of same-shape records: one class
// instance per entity, four f64 fields mutated in place each frame. Pure f64
// add/mul — bit-identical across every engine and native target.

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

class Entity {
  x: f64 = 0
  y: f64 = 0
  vx: f64 = 0
  vy: f64 = 0
}

function checksumF64(a: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const u32len = a.length * 2
  const base = a.dataStart
  for (let i = 0; i < u32len; i += 256) h = (h ^ load<u32>(base + (<usize>i << 2))) * 0x01000193
  return h
}

function mkEntities(n: i32): Array<Entity> {
  const ps = new Array<Entity>(n)
  for (let i = 0; i < n; i++) unchecked(ps[i] = new Entity())
  return ps
}

function seedState(ps: Array<Entity>): void {
  let s: u32 = 0x1234abcd
  for (let i = 0; i < ps.length; i++) {
    const p = unchecked(ps[i])
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    p.x = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    p.y = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    p.vx = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
    s = s ^ (s << 13); s = s ^ (s >>> 17); s = s ^ (s << 5)
    p.vy = (<f64>(s) / 4294967296.0) * 2.0 - 1.0
  }
}

function stepSim(ps: Array<Entity>): void {
  for (let i = 0; i < ps.length; i++) {
    const p = unchecked(ps[i])
    const nvy = p.vy + G * DT
    p.x = p.x + p.vx * DT
    p.y = p.y + nvy * DT
    p.vy = nvy
  }
}

function run(ps: Array<Entity>): void {
  for (let f = 0; f < STEPS; f++) stepSim(ps)
}

export function main(): void {
  const ps = mkEntities(N)

  for (let i = 0; i < N_WARMUP; i++) { seedState(ps); run(ps) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    seedState(ps)
    const t0 = perfNow()
    run(ps)
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
  const px = new Float64Array(N), py = new Float64Array(N)
  for (let i = 0; i < N; i++) { const p = unchecked(ps[i]); unchecked(px[i] = p.x); unchecked(py[i] = p.y) }
  const cs = (checksumF64(py) ^ checksumF64(px))
  logLine(<i32>(medianMs * 1000.0), cs, N * STEPS, STEPS, N_RUNS)
}
