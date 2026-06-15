// synth.js — a minisynth audio pipeline: per-sample polynomial oscillator →
// ADSR envelope → biquad lowpass, rendering a short note sequence to a Float64Array.
// The shape of ZzFX-class one-call synths, but transcendental-free so the rendered
// buffer is bit-identical across every engine and native target.
//
// The per-sample loop is loop-carried (phase accumulator + biquad feedback), so it
// can't vectorize anywhere — it measures pure scalar f64 throughput on a realistic
// audio pipeline, the workload where jz's tight codegen + no NaN-box beats V8's JIT
// on plain JS (cf. the floatbeat corpus) while holding native parity.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, no class/async/regex.
// FMA note: the biquad's a*b±c fuses on Go/arm64 → its checksum is the documented
// `fma` parity class, same as the biquad and fft cases.
//
// Reports: median ms, throughput in samples/µs, FNV-1a checksum over the output.

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const SR = 44100
const N_NOTES = 64
const NOTE_LEN = 8192
const N = N_NOTES * NOTE_LEN     // 524288 samples (~11.9 s @ 44.1 kHz)
const N_RUNS = 21
const N_WARMUP = 5

// ADSR segment lengths (samples) and sustain level — linear segments.
const ATTACK = 400
const DECAY = 1600
const RELEASE = 2400
const SUSTAIN = 0.6

// Fixed stable lowpass biquad (direct form 1), coefficients as literals so no
// transcendental coefficient design is needed — bit-identical everywhere.
const B0 = 0.0675, B1 = 0.135, B2 = 0.0675, A1 = -1.143, A2 = 0.412

// C-major-ish note table (Hz) — literals, identical across targets.
const FREQS = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25]

// sin(2π·ph) for cycle-phase ph in [0,1), transcendental-free: octant reduction
// to [-π/4, π/4] + Taylor sin/cos polynomials (Horner). Same f64 ops everywhere.
const sinTau = (ph) => {
  const q = ph * 4
  const m = Math.floor(q + 0.5)
  const phi = (q - m) * 1.5707963267948966
  const p2 = phi * phi
  const sp = phi * (1 + p2 * (-0.16666666666666666 + p2 * (0.008333333333333333 + p2 * (-0.0001984126984126984 + p2 * (2.7557319223985893e-06 + p2 * -2.505210838544172e-08)))))
  const cp = 1 + p2 * (-0.5 + p2 * (0.041666666666666664 + p2 * (-0.001388888888888889 + p2 * (2.48015873015873e-05 + p2 * -2.7557319223985894e-07))))
  const r = (m & 3)
  return r === 0 ? sp : r === 1 ? cp : r === 2 ? -sp : -cp
}

const render = (out) => {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0      // biquad state, carried across notes
  for (let note = 0; note < N_NOTES; note++) {
    const freq = FREQS[(note * 3 + 1) & 7] * (((note >> 2) & 1) ? 2 : 1)
    const dph = freq / SR
    let ph = 0
    const off = note * NOTE_LEN
    for (let t = 0; t < NOTE_LEN; t++) {
      const env = t < ATTACK ? t / ATTACK
        : t < ATTACK + DECAY ? 1 - (1 - SUSTAIN) * (t - ATTACK) / DECAY
        : t < NOTE_LEN - RELEASE ? SUSTAIN
        : (NOTE_LEN - t) / RELEASE * SUSTAIN
      const s = sinTau(ph) * env
      ph += dph
      if (ph >= 1) ph -= 1
      const y = B0 * s + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2
      x2 = x1; x1 = s; y2 = y1; y1 = y
      out[off + t] = y
    }
  }
}

export let main = () => {
  const out = new Float64Array(N)
  for (let i = 0; i < N_WARMUP; i++) render(out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    render(out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), N, N_NOTES, N_RUNS)
}
