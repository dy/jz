// alpha.as.ts — AssemblyScript translation of bench/alpha/alpha.js.
//
// Alpha compositing (constant-opacity "over" blend) of two RGBA8 images.
// Pure-integer fixed-point blend — bit-identical across every engine and target.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const W: i32 = 512
const H: i32 = 512
const N: i32 = W * H * 4
const A: i32 = 160
const IA: i32 = 255 - A
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function checksumU8(a: Uint8Array): u32 {
  let h: u32 = 0x811c9dc5
  for (let i = 0; i < a.length; i++) h = (h ^ <u32>unchecked(a[i])) * 0x01000193
  return h
}

function mkImage(n: i32, seedVal: u32): Uint8Array {
  const out = new Uint8Array(n)
  let s: u32 = seedVal
  for (let i = 0; i < n; i++) {
    s = s ^ (s << 13)
    s = s ^ (s >>> 17)
    s = s ^ (s << 5)
    unchecked(out[i] = <u8>(s & 255))
  }
  return out
}

function blend(src: Uint8Array, dst: Uint8Array, out: Uint8Array, n: i32): void {
  for (let i = 0; i < n; i++) {
    unchecked(out[i] = <u8>(((<i32>src[i] * A) + (<i32>dst[i] * IA) + 127) >> 8))
  }
}

export function main(): void {
  const src = mkImage(N, 0x1234abcd)
  const dst = mkImage(N, 0x7e1f93b5)
  const out = new Uint8Array(N)
  for (let i = 0; i < N_WARMUP; i++) blend(src, dst, out, N)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    blend(src, dst, out, N)
    unchecked(samples[i] = perfNow() - t0)
  }

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
  const cs = checksumU8(out)
  logLine(<i32>(medianMs * 1000.0), cs, N, 1, N_RUNS)
}
