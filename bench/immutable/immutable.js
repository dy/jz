// immutable.js — a particle step in the immutable-update idiom: every step
// replaces each record with a FRESH object (`ps[i] = { x, y, vx, vy }`)
// instead of mutating in place. The canonical functional-state kernel
// (React/Redux reducers, persistent game state, event-sourced models): a JS
// engine feeds the allocation churn to its young-generation GC — the pattern
// deopts into allocation pressure — a static language gets it free through
// value semantics, and an AOT compiler must either scalar-replace the escaping
// object or eat the allocations. Pure integer bounce physics, so positions are
// bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly
// by the JS engines. Subset: const/let + arrows, object literals, Math.imul,
// no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in particle-steps/µs, FNV-1a
// checksum over the per-pass position folds.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 4096               // particles
const STEPS = 32             // steps per pass (one fresh object per particle per step)
const LIM = 1023             // box bound
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic initial state — XorShift32 positions in [0, LIM], velocities
// in [-8, 8] forced nonzero, identical per target.
const initParticles = () => {
  const ps = []
  let s = 0x1234abcd | 0
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const vx = ((s >>> 4) & 15) - 8, vy = ((s >>> 8) & 15) - 8
    ps.push({
      x: (s >>> 12) & LIM,
      y: (s >>> 20) & LIM,
      vx: (vx === 0 ? 1 : vx) | 0,
      vy: (vy === 0 ? 1 : vy) | 0,
    })
  }
  return ps
}

const runKernel = (ps) => {
  let h = 0x811c9dc5 | 0
  for (let it = 0; it < STEPS; it++) {
    let sum = it | 0
    for (let i = 0; i < N; i++) {
      const p = ps[i]
      const nx = (p.x + p.vx) | 0, ny = (p.y + p.vy) | 0
      const hitX = nx < 0 || nx > LIM, hitY = ny < 0 || ny > LIM
      const x = hitX ? p.x : nx, y = hitY ? p.y : ny
      const vx = hitX ? -p.vx | 0 : p.vx, vy = hitY ? -p.vy | 0 : p.vy
      ps[i] = { x: x, y: y, vx: vx, vy: vy }
      sum = (sum + x + Math.imul(y, 31)) | 0
    }
    h = mix(h, sum)
  }
  return h >>> 0
}

export let main = () => {
  let cs = 0
  // Fresh particle set per run — the kernel mutates the array, so timing runs
  // must not compound each other's motion.
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(initParticles())

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const ps = initParticles()
    const t0 = performance.now()
    cs = runKernel(ps)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * STEPS, 1, N_RUNS)
}
