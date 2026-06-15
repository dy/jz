// particle.js — fixed-timestep particle integrator, the hot loop at the heart of
// every game's particle system / physics step. N independent particles in a
// struct-of-arrays layout (px, py, vx, vy) advanced under constant gravity for
// many frames. Pure f64 add/mul — no transcendentals — so the trajectory is
// bit-identical across every engine and native target (Go's arm64 auto-FMA gives
// the documented `fma` parity class on the `a + b*c` integration steps).
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, no class/async/regex.
//
// The per-frame update is an embarrassingly-parallel map over the particle
// arrays — each lane is one particle — so jz lifts it to f64x2 SIMD, the same
// vectorization clang/zig apply. Reports: median ms, throughput in particle-
// updates/µs, FNV-1a checksum over the final positions.

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N = 1 << 16        // 65,536 particles
const STEPS = 256        // frames integrated per run
const DT = 0.015625      // 1/64 s — exact in f64, keeps the cascade bit-stable
const G = -9.8           // gravity (units/s²)
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic initial state — XorShift32 mapped to [-1, 1).
const seedState = (px, py, vx, vy, n) => {
  let s = 0x1234abcd | 0
  const r = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    return ((s >>> 0) / 4294967296) * 2 - 1
  }
  for (let i = 0; i < n; i++) { px[i] = r(); py[i] = r(); vx[i] = r(); vy[i] = r() }
}

// One integration frame: semi-implicit Euler. nvy is a per-particle local so no
// array element is read after it is written — the loop stays a clean lane-local
// map (jz lifts it to f64x2; clang/zig vectorize the same shape).
const step = (px, py, vx, vy, n) => {
  for (let i = 0; i < n; i++) {
    const nvy = vy[i] + G * DT
    px[i] = px[i] + vx[i] * DT
    py[i] = py[i] + nvy * DT
    vy[i] = nvy
  }
}

const run = (px, py, vx, vy) => {
  for (let f = 0; f < STEPS; f++) step(px, py, vx, vy, N)
}

export let main = () => {
  const px = new Float64Array(N), py = new Float64Array(N)
  const vx = new Float64Array(N), vy = new Float64Array(N)

  for (let i = 0; i < N_WARMUP; i++) { seedState(px, py, vx, vy, N); run(px, py, vx, vy) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    seedState(px, py, vx, vy, N)
    const t0 = performance.now()
    run(px, py, vx, vy)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), (checksumF64(py) ^ checksumF64(px)) >>> 0, N * STEPS, STEPS, N_RUNS)
}
