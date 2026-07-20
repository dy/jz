// delayline.as.ts — AssemblyScript translation of bench/delayline/delayline.js.
//
// modulated feedback comb (flanger/chorus core) through a power-of-two
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

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 17       // samples per pass
const RB: i32 = 1 << 14      // ring size
const MASK: u32 = <u32>(RB - 1)
const DMIN: u32 = 96         // delay range, samples
const DSPAN: u32 = 2000
const N_ITERS: i32 = 4
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function buildInput(input: Float64Array): void {
  let s: u32 = 0x3c91e57
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(input[i] = (<f64>s / 4294967296.0) * 2.0 - 1.0)
  }
}

function runPass(input: Float64Array, out: Float64Array, ring: Float64Array, fb: f64, lfoStep: u32): void {
  for (let i = 0; i < RB; i++) unchecked(ring[i] = 0.0)
  let head: u32 = 0
  let lfo: u32 = 0
  for (let i = 0; i < N; i++) {
    lfo = (lfo + lfoStep) & 0xffffffff
    const raw: u32 = lfo & 0x1ffff                              // 17-bit phase
    const tri: u32 = raw < 0x10000 ? raw : 0x20000 - raw         // triangle 0..0x10000
    const dq: u32 = DMIN * 65536 + tri * DSPAN                   // delay in q16 samples
    const dInt: u32 = dq / 65536
    const dFrac: f64 = <f64>(dq - dInt * 65536) / 65536.0        // exact: ÷2^16
    const i0: u32 = (head - dInt) & MASK
    const i1: u32 = (head - dInt - 1) & MASK
    const r0 = unchecked(ring[i0])
    const r1 = unchecked(ring[i1])
    const tap: f64 = r0 + (r1 - r0) * dFrac
    const y: f64 = unchecked(input[i]) + tap * fb
    unchecked(ring[head & MASK] = y)
    head = head + 1
    unchecked(out[i] = y)
  }
}

function runKernel(input: Float64Array, out: Float64Array, ring: Float64Array): void {
  for (let it = 0; it < N_ITERS; it++) runPass(input, out, ring, 0.6 + <f64>it * 0.05, <u32>(977 + it * 131))
}

function checksumF64(out: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const stride: i32 = 256
  const total: i32 = out.length * 2
  const base: usize = changetype<usize>(out.buffer)
  for (let i = 0; i < total; i += stride) {
    const w = load<u32>(base + (<usize>i << 2))
    h = (h ^ w) * 0x01000193
  }
  return h
}

export function main(): void {
  const input = new Float64Array(N)
  const out = new Float64Array(N)
  const ring = new Float64Array(RB)
  buildInput(input)

  for (let i = 0; i < N_WARMUP; i++) runKernel(input, out, ring)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    runKernel(input, out, ring)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumF64(out)

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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, N_ITERS, N_RUNS)
}
