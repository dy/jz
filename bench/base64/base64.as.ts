// base64.as.ts — AssemblyScript translation of bench/base64/base64.js.
//
// Base64 encode + decode round-trip. Table-driven, pure-integer, Uint8Array.
// Checksum is bit-identical to V8 and jz.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 24576
const ENC_LEN: i32 = (N / 3) * 4
const N_ITERS: i32 = 64
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function buildEnc(enc: Uint8Array): void {
  let i = 0
  for (let c = 65; c <= 90; c++)  { unchecked(enc[i] = <u8>c); i++ }  // A-Z
  for (let c = 97; c <= 122; c++) { unchecked(enc[i] = <u8>c); i++ }  // a-z
  for (let c = 48; c <= 57; c++)  { unchecked(enc[i] = <u8>c); i++ }  // 0-9
  unchecked(enc[i] = 43); i++  // +
  unchecked(enc[i] = 47)        // /
}

function buildDec(enc: Uint8Array, dec: Uint8Array): void {
  for (let i = 0; i < 256; i++) unchecked(dec[i] = 0)
  for (let i = 0; i < 64; i++) unchecked(dec[unchecked(enc[i])] = <u8>i)
}

function initBuf(buf: Uint8Array): void {
  let x: i32 = 0x12345678
  for (let i = 0; i < N; i++) {
    x = x * 1103515245 + 12345
    unchecked(buf[i] = <u8>((<u32>x >>> 16) & 0xff))
  }
}

function checksumU8(out: Uint8Array): u32 {
  let h: u32 = 0x811c9dc5
  const len = out.length
  for (let i = 0; i < len; i++) h = (h ^ <u32>unchecked(out[i])) * 0x01000193
  return h
}

function encode(src: Uint8Array, enc: Uint8Array, out: Uint8Array): void {
  let op = 0
  for (let i = 0; i + 3 <= N; i += 3) {
    const a = <u32>unchecked(src[i])
    const b = <u32>unchecked(src[i + 1])
    const c = <u32>unchecked(src[i + 2])
    unchecked(out[op]     = unchecked(enc[a >>> 2]))
    unchecked(out[op + 1] = unchecked(enc[((a & 3) << 4) | (b >>> 4)]))
    unchecked(out[op + 2] = unchecked(enc[((b & 15) << 2) | (c >>> 6)]))
    unchecked(out[op + 3] = unchecked(enc[c & 63]))
    op += 4
  }
}

function decode(src: Uint8Array, dec: Uint8Array, out: Uint8Array): void {
  let op = 0
  for (let i = 0; i + 4 <= ENC_LEN; i += 4) {
    const a = <u32>unchecked(dec[unchecked(src[i])])
    const b = <u32>unchecked(dec[unchecked(src[i + 1])])
    const c = <u32>unchecked(dec[unchecked(src[i + 2])])
    const d = <u32>unchecked(dec[unchecked(src[i + 3])])
    unchecked(out[op]     = <u8>(((a << 2) | (b >>> 4)) & 0xff))
    unchecked(out[op + 1] = <u8>((((b & 15) << 4) | (c >>> 2)) & 0xff))
    unchecked(out[op + 2] = <u8>((((c & 3) << 6) | d) & 0xff))
    op += 3
  }
}

function runKernel(src: Uint8Array, enc: Uint8Array, dec: Uint8Array, b64: Uint8Array, back: Uint8Array): u32 {
  let h: u32 = 0
  for (let it = 0; it < N_ITERS; it++) {
    encode(src, enc, b64)
    decode(b64, dec, back)
    let ok: u32 = 1
    for (let i = 0; i < N; i++) if (unchecked(back[i]) !== unchecked(src[i])) ok = 0
    const csB64 = checksumU8(b64)
    h = (h ^ csB64) * 0x01000193
    h = (h ^ ok) * 0x01000193
    const j = it % N
    unchecked(src[j] = <u8>((unchecked(src[j]) + 1) & 0xff))
  }
  return h
}

export function main(): void {
  const src  = new Uint8Array(N)
  const enc  = new Uint8Array(64)
  const dec  = new Uint8Array(256)
  const b64  = new Uint8Array(ENC_LEN)
  const back = new Uint8Array(N)
  buildEnc(enc)
  buildDec(enc, dec)
  initBuf(src)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(src, enc, dec, b64, back)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(src, enc, dec, b64, back)
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
