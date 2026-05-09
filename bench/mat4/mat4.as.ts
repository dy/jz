// mat4.as.ts — AssemblyScript translation of bench/mat4/mat4.js.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N_ITERS: i32 = 200000
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function init(a: Float64Array, b: Float64Array): void {
  for (let i = 0; i < 16; i++) {
    unchecked(a[i] = <f64>(i + 1) * 0.125)
    unchecked(b[i] = <f64>(16 - i) * 0.0625)
  }
}

function multiplyMany(a: Float64Array, b: Float64Array, out: Float64Array, iters: i32): void {
  for (let n = 0; n < iters; n++) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let s: f64 = 0
        for (let k = 0; k < 4; k++) s += unchecked(a[r * 4 + k]) * unchecked(b[k * 4 + c])
        unchecked(out[r * 4 + c] = s + <f64>n * 0.0000001)
      }
    }
    const t = unchecked(a[0])
    unchecked(a[0] = out[15])
    unchecked(a[5] = t + out[10] * 0.000001)
    unchecked(b[0] += out[0] * 0.00000000001)
    unchecked(b[5] -= out[5] * 0.00000000001)
  }
}

function checksum(out: Float64Array): u32 {
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
  const a = new Float64Array(16)
  const b = new Float64Array(16)
  const out = new Float64Array(16)
  init(a, b)
  for (let i = 0; i < N_WARMUP; i++) multiplyMany(a, b, out, N_ITERS)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    init(a, b)
    const t0 = perfNow()
    multiplyMany(a, b, out, N_ITERS)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksum(out)
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
  logLine(<i32>(medianMs * 1000.0), cs, N_ITERS * 16, 4, N_RUNS)
}
