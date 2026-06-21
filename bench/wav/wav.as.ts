// wav.as.ts — AssemblyScript translation of bench/wav/wav.js.
//
// PCM-16 WAV encoder: quantize a float sample buffer to signed 16-bit
// little-endian and pack behind a 44-byte RIFF/WAVE header. Checksum is
// FNV-1a over the whole encoded byte stream (header + samples).

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 131072
const SR: i32 = 44100
const HDR: i32 = 44
const BYTES: i32 = HDR + N * 2
const N_ITERS: i32 = 16
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function mkSamples(s: Float64Array): void {
  let x: i32 = 0x1234abcd
  for (let i = 0; i < N; i++) {
    x ^= x << 13
    x ^= <i32>(<u32>x >>> 17)
    x ^= x << 5
    unchecked(s[i] = ((<f64>(<u32>x) / 4294967296.0) * 2.0 - 1.0) * 1.2)
  }
}

function writeU32(b: Uint8Array, off: i32, v: u32): void {
  unchecked(b[off]     = <u8>(v & 0xff))
  unchecked(b[off + 1] = <u8>((v >>> 8)  & 0xff))
  unchecked(b[off + 2] = <u8>((v >>> 16) & 0xff))
  unchecked(b[off + 3] = <u8>((v >>> 24) & 0xff))
}

function writeU16(b: Uint8Array, off: i32, v: u32): void {
  unchecked(b[off]     = <u8>(v & 0xff))
  unchecked(b[off + 1] = <u8>((v >>> 8) & 0xff))
}

function encode(s: Float64Array, count: i32, out: Uint8Array): void {
  const dataBytes: u32 = <u32>(count * 2)
  unchecked(out[0] = 82); unchecked(out[1] = 73); unchecked(out[2] = 70); unchecked(out[3] = 70)
  writeU32(out, 4, 36 + dataBytes)
  unchecked(out[8] = 87); unchecked(out[9] = 65); unchecked(out[10] = 86); unchecked(out[11] = 69)
  unchecked(out[12] = 102); unchecked(out[13] = 109); unchecked(out[14] = 116); unchecked(out[15] = 32)
  writeU32(out, 16, 16)
  writeU16(out, 20, 1)
  writeU16(out, 22, 1)
  writeU32(out, 24, <u32>SR)
  writeU32(out, 28, <u32>(SR * 2))
  writeU16(out, 32, 2)
  writeU16(out, 34, 16)
  unchecked(out[36] = 100); unchecked(out[37] = 97); unchecked(out[38] = 116); unchecked(out[39] = 97)
  writeU32(out, 40, dataBytes)
  let op: i32 = HDR
  for (let i = 0; i < count; i++) {
    let v: f64 = unchecked(s[i]) * 32767.0
    if (v > 32767.0) v = 32767.0
    else if (v < -32768.0) v = -32768.0
    const u: u32 = <u32>(<i32>v & 0xffff)
    unchecked(out[op]     = <u8>(u & 0xff))
    unchecked(out[op + 1] = <u8>((u >>> 8) & 0xff))
    op += 2
  }
}

function checksumU8(out: Uint8Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = out.length
  for (let i = 0; i < n; i++) h = (h ^ <u32>unchecked(out[i])) * 0x01000193
  return h
}

function runKernel(s: Float64Array, out: Uint8Array): u32 {
  let h: u32 = 0
  for (let it = 0; it < N_ITERS; it++) {
    encode(s, N, out)
    h = (h ^ checksumU8(out)) * 0x01000193
    const j: i32 = it % N
    unchecked(s[j] = -unchecked(s[j]))
  }
  return h
}

export function main(): void {
  const s = new Float64Array(N)
  const out = new Uint8Array(BYTES)
  mkSamples(s)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(s, out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(s, out)
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
