// crc32.as.ts — AssemblyScript translation of bench/crc32/crc32.js.
//
// CRC-32 (IEEE, reflected), table-driven. AS gives the kernel an explicitly
// monomorphic shape: `Uint8Array` data, an `Int32Array` LUT, `u32` arithmetic —
// exactly what jz must infer from the dynamically-typed source. Pure-integer, so
// the checksum is bit-identical to V8 and to jz.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 16384
const N_ITERS: i32 = 220
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function buildTable(table: Int32Array): void {
  for (let n = 0; n < 256; n++) {
    let c: u32 = <u32>n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    unchecked(table[n] = <i32>c)
  }
}

function initBuf(buf: Uint8Array): void {
  let x: i32 = 0x12345678
  for (let i = 0; i < N; i++) {
    x = x * 1103515245 + 12345
    unchecked(buf[i] = <u8>((<u32>x >>> 16) & 0xff))
  }
}

function crc32(buf: Uint8Array, table: Int32Array): u32 {
  let c: u32 = 0xffffffff
  for (let i = 0; i < N; i++)
    c = (<u32>unchecked(table[(c ^ <u32>unchecked(buf[i])) & 0xff])) ^ (c >>> 8)
  return c ^ 0xffffffff
}

function runKernel(buf: Uint8Array, table: Int32Array): u32 {
  let h: u32 = 0
  for (let it = 0; it < N_ITERS; it++) {
    h = (h ^ crc32(buf, table)) * 0x01000193
    const j = it % N
    unchecked(buf[j] = <u8>(unchecked(buf[j]) + 1))
  }
  return h
}

export function main(): void {
  const buf = new Uint8Array(N)
  const table = new Int32Array(256)
  buildTable(table)
  initBuf(buf)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(buf, table)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(buf, table)
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
