// pcmconvert.js — PCM format conversion in a library's idiom (pcm-convert):
// sample ranges as `{min, max}` records from a dtype table, the destination
// constructor chosen from that table at run time, a float32 interleaved stereo
// signal mapped to int16 (scaled, rounded, clipped) and the int16 stream
// deinterleaved to float64 planar in one pass (`i % seg`, `~~(i / seg)`).
// What the kernel class pins: typed arrays of a width the program picks from a
// table, range records read in the per-sample loop, integer division and
// modulus by a runtime segment length.
//
// Reports: median ms across N_RUNS, output checksum (FNV-1a over a sparse
// stride of the planar float64 result).

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_FRAMES = 240000  // 5 s @ 48 kHz stereo
const N_CH = 2
const N_RUNS = 21
const N_WARMUP = 5

const DTYPE = {
  float32: { C: Float32Array, min: -1, max: 1 },
  float64: { C: Float64Array, min: -1, max: 1 },
  uint8: { C: Uint8Array, min: 0, max: 255 },
  int16: { C: Int16Array, min: -32768, max: 32767 },
  int32: { C: Int32Array, min: -2147483648, max: 2147483647 },
}
const range = (d) => DTYPE[d] || { min: -1, max: 1 }
// an integer range against a float one spans 2^bits (max - min + 1); otherwise max - min
const span = (r, other) => r.max > 1 && other.max === 1 && other.min === -1 ? r.max - r.min + 1 : r.max - r.min

// XorShift32 into float32, interleaved: deterministic per-target, in [-1, 1).
const mkInput = (n) => {
  const out = new Float32Array(n)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = ((s >>> 0) / 4294967296) * 2 - 1
  }
  return out
}

// samples of dtype `from` to dtype `to`, the same layout
const mapRange = (samples, from, to) => {
  const fromR = range(from), toR = range(to), len = samples.length
  const Ctor = DTYPE[to].C
  const out = new Ctor(len)
  const fromSpan = span(fromR, toR), toSpan = span(toR, fromR)
  const roundInt = fromR.min === -1 && fromR.max === 1 && toR.max > 1
  for (let i = 0; i < len; i++) {
    let v = ((samples[i] - fromR.min) / fromSpan) * toSpan + toR.min
    if (roundInt) v = Math.round(v)
    out[i] = v < toR.min ? toR.min : v > toR.max ? toR.max : v
  }
  return out
}

// interleaved samples of dtype `from` to planar of dtype `to`
const deinterleave = (samples, from, to, ch) => {
  const fromR = range(from), toR = range(to), len = samples.length, seg = Math.floor(len / ch)
  const out = new (DTYPE[to].C)(len)
  const fromSpan = span(fromR, toR), toSpan = span(toR, fromR)
  const roundInt = fromR.min === -1 && fromR.max === 1 && toR.max > 1
  for (let i = 0; i < len; i++) {
    const si = (i % seg) * ch + ~~(i / seg)
    let v = samples[si]
    v = ((v - fromR.min) / fromSpan) * toSpan + toR.min
    if (roundInt) v = Math.round(v)
    if (v < toR.min) v = toR.min
    else if (v > toR.max) v = toR.max
    out[i] = v
  }
  return out
}

const run = () => {
  const x = mkInput(N_FRAMES * N_CH)
  let out
  for (let i = 0; i < N_WARMUP; i++) out = deinterleave(mapRange(x, 'float32', 'int16'), 'int16', 'float64', N_CH)
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    out = deinterleave(mapRange(x, 'float32', 'int16'), 'int16', 'float64', N_CH)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), N_FRAMES, N_CH, N_RUNS)
}

export let main = () => {
  run()
}
