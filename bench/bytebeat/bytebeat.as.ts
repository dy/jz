// bytebeat.as.ts — AssemblyScript translation of bench/bytebeat/bytebeat.js.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 21
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// @ts-ignore: decorator
@inline
function sample(t: u32): u32 {
  const v1 = (t * 5 & t >> 7) | (t * 3 & t >> 10)
  const v2 = t * (((t >> 12) | (t >> 8)) & (63 & (t >> 4)))
  return (v1 + v2) & 255
}

function render(buf: Uint8Array, n: i32): void {
  for (let t = 0; t < n; t++) unchecked(buf[t] = <u8>sample(<u32>t))
}

function checksumU8(out: Uint8Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = out.length
  for (let i = 0; i < n; i++) h = (h ^ <u32>unchecked(out[i])) * 0x01000193
  return h
}

export function main(): void {
  const buf = new Uint8Array(N)
  for (let i = 0; i < N_WARMUP; i++) render(buf, N)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    render(buf, N)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumU8(buf)
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
  logLine(<i32>(medianMs * 1000.0), cs, N, 1, N_RUNS)
}
