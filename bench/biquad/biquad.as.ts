// biquad.as.ts — AssemblyScript translation of bench/biquad/biquad.js.
//
// Compile with:
//   asc biquad.as.ts -O3 --runtime stub --noAssert -o biquad.wasm
//
// Bit-exact with V8/jz/wasm reference (checksum 1646038335) — AS lowers
// `a*b + c` to f64.mul + f64.add (no FMA) like every wasm target.
//
// Two host imports (env.perfNow, env.logLine) keep the runner trivial.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N_SAMPLES: i32 = 480000
const N_STAGES: i32 = 8
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function mkInput(out: Float64Array): void {
  let s: u32 = 0x1234abcd
  for (let i = 0, n = out.length; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = (<f64>s / 4294967296.0) * 2.0 - 1.0
  }
}

function mkCoeffs(out: Float64Array): void {
  for (let i = 0; i < N_STAGES; i++) {
    out[i * 5 + 0] = 0.10 + <f64>i * 0.001
    out[i * 5 + 1] = 0.20 - <f64>i * 0.0005
    out[i * 5 + 2] = 0.10
    out[i * 5 + 3] = -1.50 + <f64>i * 0.01
    out[i * 5 + 4] = 0.60 - <f64>i * 0.005
  }
}

function processCascade(x: Float64Array, coeffs: Float64Array, state: Float64Array, out: Float64Array): void {
  const n = x.length
  for (let i = 0; i < n; i++) {
    let v = unchecked(x[i])
    for (let s = 0; s < N_STAGES; s++) {
      const c = s * 5
      const sb = s * 4
      const b0 = unchecked(coeffs[c + 0])
      const b1 = unchecked(coeffs[c + 1])
      const b2 = unchecked(coeffs[c + 2])
      const a1 = unchecked(coeffs[c + 3])
      const a2 = unchecked(coeffs[c + 4])
      const x1 = unchecked(state[sb + 0])
      const x2 = unchecked(state[sb + 1])
      const y1 = unchecked(state[sb + 2])
      const y2 = unchecked(state[sb + 3])
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      unchecked(state[sb + 0] = v)
      unchecked(state[sb + 1] = x1)
      unchecked(state[sb + 2] = y)
      unchecked(state[sb + 3] = y1)
      v = y
    }
    unchecked(out[i] = v)
  }
}

function checksum(out: Float64Array): u32 {
  // FNV-1a over a strided u32 view of the f64 output's bit pattern.
  let h: u32 = 0x811c9dc5
  const stride: i32 = 4096
  const total: i32 = out.length * 2
  const base: usize = changetype<usize>(out.buffer)
  for (let i = 0; i < total; i += stride) {
    const w = load<u32>(base + (<usize>i << 2))
    h = (h ^ w) * 0x01000193
  }
  return h
}

export function main(): void {
  const x = new Float64Array(N_SAMPLES)
  const coeffs = new Float64Array(N_STAGES * 5)
  const state = new Float64Array(N_STAGES * 4)
  const out = new Float64Array(N_SAMPLES)
  mkInput(x)
  mkCoeffs(coeffs)

  const stateLen = N_STAGES * 4
  for (let i = 0; i < N_WARMUP; i++) {
    for (let j = 0; j < stateLen; j++) unchecked(state[j] = 0.0)
    processCascade(x, coeffs, state, out)
  }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    for (let j = 0; j < stateLen; j++) unchecked(state[j] = 0.0)
    const t0 = perfNow()
    processCascade(x, coeffs, state, out)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksum(out)

  // Insertion sort for median.
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
  const medianUs = <i32>(medianMs * 1000.0)
  logLine(medianUs, cs, N_SAMPLES, N_STAGES, N_RUNS)
}
