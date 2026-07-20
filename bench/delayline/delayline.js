// delayline.js — modulated feedback comb (flanger/chorus core) through a power-of-two
// ring buffer: the delay-line pattern under every reverb, echo and physical model. Per
// sample: an integer-LFO (triangle from a wrapping phase accumulator) sets a fractional
// delay; two taps are read at (head − d) & MASK and linearly interpolated; the feedback
// sum is written back at head & MASK. The profile: wrap-masked indexing the compiler
// must strength-reduce, a genuine loop-carried feedback (unsoftenable — it IS the
// filter), and integer→float fraction splits. The LFO fraction is q16 (÷65536), so
// every operation is exactly rounded and output is bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over the wet output (f64 bits).

import { medianUs, checksumF64, printResult } from '../_lib/benchlib.js'

const N = 1 << 17            // samples per pass
const RB = 1 << 14           // ring size
const MASK = RB - 1
const DMIN = 96              // delay range, samples
const DSPAN = 2000
const N_ITERS = 4
const N_RUNS = 21
const N_WARMUP = 5

const buildInput = (input) => {
  let s = 0x3c91e57 | 0
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  for (let i = 0; i < N; i++) input[i] = (rnd() / 4294967296.0) * 2.0 - 1.0
}

const runPass = (input, out, ring, fb, lfoStep) => {
  for (let i = 0; i < RB; i++) ring[i] = 0.0
  let head = 0
  let lfo = 0
  for (let i = 0; i < N; i++) {
    lfo = (lfo + lfoStep) & 0xffffffff
    const raw = lfo & 0x1ffff                        // 17-bit phase
    const tri = raw < 0x10000 ? raw : 0x20000 - raw  // triangle 0..0x10000
    const dq = DMIN * 65536 + tri * DSPAN            // delay in q16 samples
    const dInt = (dq / 65536) | 0
    const dFrac = (dq - dInt * 65536) / 65536.0      // exact: ÷2^16
    const i0 = (head - dInt) & MASK
    const i1 = (head - dInt - 1) & MASK
    const tap = ring[i0] + (ring[i1] - ring[i0]) * dFrac
    const y = input[i] + tap * fb
    ring[head & MASK] = y
    head = (head + 1) | 0
    out[i] = y
  }
}

const runKernel = (input, out, ring) => {
  for (let it = 0; it < N_ITERS; it++) runPass(input, out, ring, 0.6 + it * 0.05, 977 + it * 131)
}

export let main = () => {
  const input = new Float64Array(N)
  const out = new Float64Array(N)
  const ring = new Float64Array(RB)
  buildInput(input)

  for (let i = 0; i < N_WARMUP; i++) runKernel(input, out, ring)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(input, out, ring)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), N * N_ITERS, N_ITERS, N_RUNS)
}
