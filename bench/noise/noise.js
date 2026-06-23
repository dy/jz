// noise.js — 2-D Perlin gradient noise summed over several octaves (fractal
// Brownian motion), the canonical procedural-generation kernel (terrain heights,
// textures, clouds, displacement). A permutation-table hash feeds gradient dot
// products blended by a quintic smoothstep — integer table lookups interleaved
// with loop-carried f64 interpolation, an ALU/memory mix distinct from the
// suite's other loops.
//
// Transcendental-free (+,-,*; no trig/pow), and the sample coordinates stay
// non-negative so Math.floor never straddles zero, so the field is bit-identical
// across engines and native targets. Go's arm64 auto-FMA of the lerp chains gives
// the documented `fma` parity class, like fft/synth.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array/Int32Array,
// Math.floor, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in samples/µs, FNV-1a checksum over
// the generated field.

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const W = 256
const H = 256
const OCT = 5                // fBm octaves
const N_RUNS = 21
const N_WARMUP = 5

// Permutation table (512 = 256 doubled), built by a deterministic XorShift
// Fisher–Yates shuffle of 0..255 → identical integer sequence per target.
const buildPerm = (perm) => {
  for (let i = 0; i < 256; i++) perm[i] = i
  let s = 0x1234abcd | 0
  for (let i = 255; i > 0; i--) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const j = (s >>> 0) % (i + 1)
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t
  }
  for (let i = 0; i < 256; i++) perm[256 + i] = perm[i]
}

const fade = (t) => t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
const lerp = (a, b, t) => a + t * (b - a)

// 2-D gradient: low 2 bits of the hash select one of four diagonal gradients.
const grad = (hash, x, y) => {
  const h = hash & 3
  const u = (h & 1) === 0 ? x : -x
  const v = (h & 2) === 0 ? y : -y
  return u + v
}

const perlin = (perm, x, y) => {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const X = (xi | 0) & 255
  const Y = (yi | 0) & 255
  const u = fade(xf)
  const v = fade(yf)
  const aa = perm[perm[X] + Y]
  const ab = perm[perm[X] + Y + 1]
  const ba = perm[perm[X + 1] + Y]
  const bb = perm[perm[X + 1] + Y + 1]
  const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1.0, yf), u)
  const x2 = lerp(grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u)
  return lerp(x1, x2, v)
}

const fbm = (perm, x, y) => {
  let sum = 0.0, amp = 0.5, freq = 1.0
  for (let o = 0; o < OCT; o++) {
    sum = sum + amp * perlin(perm, x * freq, y * freq)
    freq = freq * 2.0
    amp = amp * 0.5
  }
  return sum
}

const render = (perm, field) => {
  for (let py = 0; py < H; py++) {
    const y = py * 0.03125          // /32 → smooth coordinate
    for (let px = 0; px < W; px++) {
      const x = px * 0.03125
      field[py * W + px] = fbm(perm, x, y)
    }
  }
}

export let main = () => {
  const perm = new Int32Array(512)
  buildPerm(perm)
  const field = new Float64Array(W * H)
  for (let i = 0; i < N_WARMUP; i++) render(perm, field)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    render(perm, field)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(field), W * H, OCT, N_RUNS)
}
