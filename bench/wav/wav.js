// wav.js — PCM-16 WAV encoder: quantize a float sample buffer to signed 16-bit
// little-endian and pack it behind a 44-byte RIFF/WAVE header. The canonical audio
// serialization / codec kernel (what every recorder and exporter ends with).
//
// The hot path is per-sample: clamp to [-1, 1], scale to int16, truncate toward
// zero, emit two little-endian bytes. Quantization uses a single f64 multiply (no
// a*b+c, so no FMA divergence) and integer truncation (`| 0`), which is bit-exact
// across every engine and native target. Checksum is FNV-1a over the whole encoded
// WAV byte stream — header + samples — so a packing bug changes the result.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, Float64Array + Uint8Array, no class/async/regex.

import { medianUs, mix, checksumU8, printResult } from '../_lib/benchlib.js'

const N = 131072       // mono samples
const SR = 44100       // sample rate
const HDR = 44         // RIFF/WAVE/fmt /data header bytes
const BYTES = HDR + N * 2
const N_ITERS = 16     // encode passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic pseudo-signal in ~[-1.2, 1.2) — XorShift32 floats, slightly
// over-unity so ~17% of samples exercise the clamp rails.
const mkSamples = (s) => {
  let x = 0x1234abcd | 0
  for (let i = 0; i < N; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    s[i] = (((x >>> 0) / 4294967296) * 2 - 1) * 1.2
  }
}

const writeU32 = (b, off, v) => {
  b[off] = v & 0xff
  b[off + 1] = (v >>> 8) & 0xff
  b[off + 2] = (v >>> 16) & 0xff
  b[off + 3] = (v >>> 24) & 0xff
}
const writeU16 = (b, off, v) => {
  b[off] = v & 0xff
  b[off + 1] = (v >>> 8) & 0xff
}

const encode = (samples, n, out) => {
  const dataBytes = n * 2
  out[0] = 82; out[1] = 73; out[2] = 70; out[3] = 70       // "RIFF"
  writeU32(out, 4, 36 + dataBytes)
  out[8] = 87; out[9] = 65; out[10] = 86; out[11] = 69     // "WAVE"
  out[12] = 102; out[13] = 109; out[14] = 116; out[15] = 32 // "fmt "
  writeU32(out, 16, 16)        // fmt chunk size
  writeU16(out, 20, 1)         // PCM
  writeU16(out, 22, 1)         // mono
  writeU32(out, 24, SR)
  writeU32(out, 28, SR * 2)    // byte rate (sr * blockAlign)
  writeU16(out, 32, 2)         // block align
  writeU16(out, 34, 16)        // bits per sample
  out[36] = 100; out[37] = 97; out[38] = 116; out[39] = 97 // "data"
  writeU32(out, 40, dataBytes)
  let op = HDR
  for (let i = 0; i < n; i++) {
    let v = samples[i] * 32767.0
    if (v > 32767.0) v = 32767.0
    else if (v < -32768.0) v = -32768.0
    const u = (v | 0) & 0xffff   // truncate toward zero, keep low 16 bits
    out[op] = u & 0xff
    out[op + 1] = (u >>> 8) & 0xff
    op += 2
  }
  return op
}

const runKernel = (samples, out) => {
  let h = 0
  for (let it = 0; it < N_ITERS; it++) {
    encode(samples, N, out)
    h = mix(h, checksumU8(out))
    const j = it % N
    samples[j] = -samples[j]   // perturb so the encode can't be hoisted out of the loop
  }
  return h >>> 0
}

export let main = () => {
  const samples = new Float64Array(N)
  const out = new Uint8Array(BYTES)
  mkSamples(samples)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(samples, out)

  const s = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(samples, out)
    s[i] = performance.now() - t0
  }
  printResult(medianUs(s), cs, N * N_ITERS, 1, N_RUNS)
}
