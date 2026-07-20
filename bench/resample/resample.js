// resample.js — fractional-rate audio resampling with 4-point Hermite (Catmull–Rom)
// interpolation: the workhorse of samplers, time-stretchers and every audio graph that
// meets two clocks. Per output sample: truncate the running phase to an integer tap,
// gather four neighbours at a COMPUTED index, evaluate the cubic, advance phase by an
// irrational-ish step. Two stages (upsample then downsample) exercise both directions.
// The profile: float-derived gather indices + a fractional accumulator — the pattern
// that decides whether a compiler keeps typed loads on the fast path when the index
// comes from float math. Pure + − × ÷, so output is bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over both stage outputs (f64 bits).

import { medianUs, checksumF64, printResult } from '../_lib/benchlib.js'

const N = 1 << 16            // input samples
const STEP_UP = 0.7317314443021356      // rate < 1: output longer (upsample)
const STEP_DN = 1.3186248722190522      // rate > 1: output shorter (downsample)
const M_UP = 89000           // fixed output counts (fit within phase range)
const M_DN = 49000
const N_ITERS = 5
const N_RUNS = 21
const N_WARMUP = 5

const buildInput = (input) => {
  let s = 0x6d2f4b1 | 0
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  for (let i = 0; i < N; i++) input[i] = (rnd() / 4294967296.0) * 2.0 - 1.0
}

// 4-point, 3rd-order Hermite (Catmull–Rom): y(f) around x1 with neighbours x0..x3
const resamplePass = (input, out, m, step) => {
  let phase = 1.0
  for (let k = 0; k < m; k++) {
    const idx = phase | 0                     // exact truncation — phase stays well below 2^31
    const f = phase - idx
    const x0 = input[idx - 1]
    const x1 = input[idx]
    const x2 = input[idx + 1]
    const x3 = input[idx + 2]
    const c0 = x1
    const c1 = 0.5 * (x2 - x0)
    const c2 = x0 - 2.5 * x1 + 2.0 * x2 - 0.5 * x3
    const c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2)
    out[k] = ((c3 * f + c2) * f + c1) * f + c0
    phase += step
  }
}

const runKernel = (input, up, dn) => {
  for (let it = 0; it < N_ITERS; it++) {
    resamplePass(input, up, M_UP, STEP_UP)
    resamplePass(up, dn, M_DN, STEP_DN)
  }
}

export let main = () => {
  const input = new Float64Array(N)
  const up = new Float64Array(M_UP)
  const dn = new Float64Array(M_DN)
  buildInput(input)

  for (let i = 0; i < N_WARMUP; i++) runKernel(input, up, dn)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(input, up, dn)
    samples[i] = performance.now() - t0
  }
  let h = checksumF64(up)
  h = (h ^ checksumF64(dn)) >>> 0
  printResult(medianUs(samples), h, (M_UP + M_DN) * N_ITERS, 2, N_RUNS)
}
