// bitwise.as.ts — AssemblyScript translation of bench/bitwise/bitwise.js.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 65536
const N_ROUNDS: i32 = 128
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function init(state: Int32Array): void {
  let s: u32 = 0x1234abcd
  const n = state.length
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(state[i] = <i32>s)
  }
}

function runKernel(state: Int32Array): void {
  const n = state.length
  for (let r = 0; r < N_ROUNDS; r++) {
    for (let i = 0; i < n; i++) {
      let x: i32 = unchecked(state[i])
      x ^= x << 7
      x ^= x >>> 9
      x = (x * 1103515245) + 12345
      unchecked(state[i] = x ^ (x >>> 16))
    }
  }
}

function checksumU32(out: Int32Array): u32 {
  let h: u32 = 0x811c9dc5
  const stride: i32 = 128
  const n = out.length
  for (let i = 0; i < n; i += stride) h = (h ^ <u32>unchecked(out[i])) * 0x01000193
  return h
}

export function main(): void {
  const state = new Int32Array(N)
  init(state)
  for (let i = 0; i < N_WARMUP; i++) { init(state); runKernel(state) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    init(state)
    const t0 = perfNow()
    runKernel(state)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumU32(state)
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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ROUNDS, 3, N_RUNS)
}
