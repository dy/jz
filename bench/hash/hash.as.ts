// hash.as.ts — AssemblyScript translation of bench/hash/hash.js.
//
// MurmurHash3 x86_32, body-only (N is a multiple of 4, no tail bytes).
// Pure 32-bit integer: bit-exact to V8 and jz.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 16384
const N_ITERS: i32 = 700
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

const C1: u32 = 0xcc9e2d51
const C2: u32 = 0x1b873593

function initBuf(buf: Uint8Array): void {
  let x: i32 = 0x12345678
  for (let i = 0; i < N; i++) {
    x = x * 1103515245 + 12345
    unchecked(buf[i] = <u8>((<u32>x >>> 16) & 0xff))
  }
}

function murmur3(buf: Uint8Array, seed: u32): u32 {
  let h: i32 = <i32>seed
  for (let i = 0; i + 4 <= N; i += 4) {
    let k: i32 = <i32>(<u32>unchecked(buf[i])
      | (<u32>unchecked(buf[i + 1]) << 8)
      | (<u32>unchecked(buf[i + 2]) << 16)
      | (<u32>unchecked(buf[i + 3]) << 24))
    k = <i32>(<u32>k * C1)
    k = <i32>((<u32>k << 15) | (<u32>k >>> 17))
    k = <i32>(<u32>k * C2)
    h ^= k
    h = <i32>((<u32>h << 13) | (<u32>h >>> 19))
    h = <i32>(<u32>h * 5 + 0xe6546b64)
  }
  h ^= N
  let uh: u32 = <u32>h
  uh ^= uh >>> 16
  uh = uh * 0x85ebca6b
  uh ^= uh >>> 13
  uh = uh * 0xc2b2ae35
  uh ^= uh >>> 16
  return uh
}

function runKernel(buf: Uint8Array): u32 {
  let h: u32 = 0
  for (let it = 0; it < N_ITERS; it++) {
    const mr: u32 = murmur3(buf, 0x9747b28c)
    h = (h ^ mr) * 0x01000193
    const j = it % N
    unchecked(buf[j] = <u8>(unchecked(buf[j]) + 1))
  }
  return h
}

export function main(): void {
  const buf = new Uint8Array(N)
  initBuf(buf)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(buf)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(buf)
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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, 1, N_RUNS)
}
