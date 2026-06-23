// noise.as.ts — AssemblyScript translation of bench/noise/noise.js.
//
// 2-D Perlin gradient noise summed over several octaves (fractal
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

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const W: i32 = 256
const H: i32 = 256
const OCT: i32 = 5
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function buildPerm(perm: Int32Array): void {
  for (let i = 0; i < 256; i++) unchecked(perm[i] = i)
  let s: i32 = 0x1234abcd
  for (let i = 255; i > 0; i--) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const j: i32 = (<u32>s) % <u32>(i + 1)
    const t: i32 = unchecked(perm[i]); unchecked(perm[i] = perm[j]); unchecked(perm[j] = t)
  }
  for (let i = 0; i < 256; i++) unchecked(perm[256 + i] = perm[i])
}

// @ts-ignore: decorator
@inline
function fade(t: f64): f64 {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

// @ts-ignore: decorator
@inline
function lerp(a: f64, b: f64, t: f64): f64 {
  return a + t * (b - a)
}

// @ts-ignore: decorator
@inline
function grad(hash: i32, x: f64, y: f64): f64 {
  const h: i32 = hash & 3
  const u: f64 = (h & 1) === 0 ? x : -x
  const v: f64 = (h & 2) === 0 ? y : -y
  return u + v
}

function perlin(perm: Int32Array, x: f64, y: f64): f64 {
  const xi: i32 = <i32>Math.floor(x)
  const yi: i32 = <i32>Math.floor(y)
  const xf: f64 = x - <f64>xi
  const yf: f64 = y - <f64>yi
  const X: i32 = xi & 255
  const Y: i32 = yi & 255
  const u: f64 = fade(xf)
  const v: f64 = fade(yf)
  const aa: i32 = unchecked(perm[unchecked(perm[X]) + Y])
  const ab: i32 = unchecked(perm[unchecked(perm[X]) + Y + 1])
  const ba: i32 = unchecked(perm[unchecked(perm[X + 1]) + Y])
  const bb: i32 = unchecked(perm[unchecked(perm[X + 1]) + Y + 1])
  const x1: f64 = lerp(grad(aa, xf, yf), grad(ba, xf - 1.0, yf), u)
  const x2: f64 = lerp(grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u)
  return lerp(x1, x2, v)
}

function fbm(perm: Int32Array, x: f64, y: f64): f64 {
  let sum: f64 = 0.0, amp: f64 = 0.5, freq: f64 = 1.0
  for (let o = 0; o < OCT; o++) {
    sum = sum + amp * perlin(perm, x * freq, y * freq)
    freq = freq * 2.0
    amp = amp * 0.5
  }
  return sum
}

function render(perm: Int32Array, field: Float64Array): void {
  for (let py = 0; py < H; py++) {
    const y: f64 = <f64>py * 0.03125
    for (let px = 0; px < W; px++) {
      const x: f64 = <f64>px * 0.03125
      unchecked(field[py * W + px] = fbm(perm, x, y))
    }
  }
}

function checksumF64(out: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const n: i32 = out.length
  for (let i = 0; i < n; i += 128) {
    const bits = reinterpret<u64>(unchecked(out[i]))
    h = (h ^ <u32>bits) * 0x01000193
  }
  return h
}

export function main(): void {
  const perm = new Int32Array(512)
  buildPerm(perm)
  const field = new Float64Array(W * H)
  for (let i = 0; i < N_WARMUP; i++) render(perm, field)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    render(perm, field)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumF64(field)
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
  logLine(<i32>(medianMs * 1000.0), cs, W * H, OCT, N_RUNS)
}
