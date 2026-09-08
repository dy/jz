// entity.js — in-place entity update, the game-object / ECS step over an array
// of same-shape records. N entities, each a plain {x, y, vx, vy} object built
// once and mutated in place every frame under constant gravity — the array-of-
// structs twin of `particle`, which keeps the same state in four typed columns
// (same seed, same integrator, same checksum). Pure f64 add/mul, so the
// trajectory is bit-identical across every engine and native target (Go's
// arm64 auto-FMA gives the documented `fma` parity class).
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, object literals; Float64Array only
// to checksum the final positions. No class/async/regex.
//
// The step is a per-record read-modify-write through the element pointer: a JIT
// keeps the fields unboxed in place; jz packs the records inline at a fixed
// stride, and the store side must reach a field as directly as the read side.
// Reports: median ms, throughput in entity-updates/µs, FNV-1a checksum over the
// final positions.

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N = 1 << 16        // 65,536 entities
const STEPS = 256        // frames integrated per run
const DT = 0.015625      // 1/64 s — exact in f64, keeps the cascade bit-stable
const G = -9.8           // gravity (units/s²)
const N_RUNS = 21
const N_WARMUP = 5

const mkEntities = (n) => {
  const ps = []
  for (let i = 0; i < n; i++) ps.push({ x: 0, y: 0, vx: 0, vy: 0 })
  return ps
}

// Deterministic initial state — XorShift32 mapped to [-1, 1), written in place.
const seedState = (ps) => {
  let s = 0x1234abcd | 0
  const r = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return ((s >>> 0) / 4294967296) * 2 - 1
  }
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]
    p.x = r(); p.y = r(); p.vx = r(); p.vy = r()
  }
}

// One integration frame: semi-implicit Euler, each entity updated in place.
const step = (ps) => {
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]
    const nvy = p.vy + G * DT
    p.x = p.x + p.vx * DT
    p.y = p.y + nvy * DT
    p.vy = nvy
  }
}

const run = (ps) => {
  for (let f = 0; f < STEPS; f++) step(ps)
}

export let main = () => {
  const ps = mkEntities(N)

  for (let i = 0; i < N_WARMUP; i++) { seedState(ps); run(ps) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    seedState(ps)
    const t0 = performance.now()
    run(ps)
    samples[i] = performance.now() - t0
  }

  const px = new Float64Array(N), py = new Float64Array(N)
  for (let i = 0; i < N; i++) { px[i] = ps[i].x; py[i] = ps[i].y }
  printResult(medianUs(samples), (checksumF64(py) ^ checksumF64(px)) >>> 0, N * STEPS, STEPS, N_RUNS)
}
