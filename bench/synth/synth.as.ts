// synth.as.ts — AssemblyScript translation of bench/synth/synth.js.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const SR: f64 = 44100.0
const N_NOTES: i32 = 64
const NOTE_LEN: i32 = 8192
const N: i32 = N_NOTES * NOTE_LEN
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

const ATTACK: f64 = 400.0
const DECAY: f64 = 1600.0
const RELEASE: f64 = 2400.0
const NOTE_LEN_F: f64 = 8192.0
const SUSTAIN: f64 = 0.6

const B0: f64 = 0.0675, B1: f64 = 0.135, B2: f64 = 0.0675, A1: f64 = -1.143, A2: f64 = 0.412

// @ts-ignore: decorator
@inline
function noteFreq(i: i32): f64 {
  switch (i) {
    case 0: return 261.63
    case 1: return 293.66
    case 2: return 329.63
    case 3: return 349.23
    case 4: return 392.0
    case 5: return 440.0
    case 6: return 493.88
    default: return 523.25
  }
}

// @ts-ignore: decorator
@inline
function sinTau(ph: f64): f64 {
  const q = ph * 4.0
  const m = Math.floor(q + 0.5)
  const phi = (q - m) * 1.5707963267948966
  const p2 = phi * phi
  const sp = phi * (1.0 + p2 * (-0.16666666666666666 + p2 * (0.008333333333333333 + p2 * (-0.0001984126984126984 + p2 * (2.7557319223985893e-06 + p2 * -2.505210838544172e-08)))))
  const cp = 1.0 + p2 * (-0.5 + p2 * (0.041666666666666664 + p2 * (-0.001388888888888889 + p2 * (2.48015873015873e-05 + p2 * -2.7557319223985894e-07))))
  const r = (<i32>m) & 3
  return r === 0 ? sp : r === 1 ? cp : r === 2 ? -sp : -cp
}

function render(out: Float64Array): void {
  let x1: f64 = 0, x2: f64 = 0, y1: f64 = 0, y2: f64 = 0
  for (let note = 0; note < N_NOTES; note++) {
    const freq = noteFreq((note * 3 + 1) & 7) * (((note >> 2) & 1) ? 2.0 : 1.0)
    const dph = freq / SR
    let ph: f64 = 0
    const off = note * NOTE_LEN
    for (let t = 0; t < NOTE_LEN; t++) {
      const tf = <f64>t
      const env = tf < ATTACK ? tf / ATTACK
        : tf < ATTACK + DECAY ? 1.0 - (1.0 - SUSTAIN) * (tf - ATTACK) / DECAY
        : tf < NOTE_LEN_F - RELEASE ? SUSTAIN
        : (NOTE_LEN_F - tf) / RELEASE * SUSTAIN
      const s = sinTau(ph) * env
      ph += dph
      if (ph >= 1.0) ph -= 1.0
      const y = B0 * s + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2
      x2 = x1; x1 = s; y2 = y1; y1 = y
      unchecked(out[off + t] = y)
    }
  }
}

function checksumF64(out: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = out.length
  for (let i = 0; i < n; i += 128) {
    const bits = reinterpret<u64>(unchecked(out[i]))
    h = (h ^ <u32>bits) * 0x01000193
  }
  return h
}

export function main(): void {
  const out = new Float64Array(N)
  for (let i = 0; i < N_WARMUP; i++) render(out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    render(out)
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
  logLine(<i32>(medianMs * 1000.0), cs, N, N_NOTES, N_RUNS)
}
