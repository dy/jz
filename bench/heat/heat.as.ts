// heat.as.ts — AssemblyScript translation of bench/heat/heat.js.
//
// 2-D heat diffusion: explicit-Euler 5-point Laplacian stencil. Pure f64 with
// a power-of-two coefficient — bit-identical across every engine and target.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const W: i32 = 258
const H: i32 = 258
const K: f64 = 0.125
const STEPS: i32 = 100
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function checksumF64(a: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const u32len = a.length * 2
  const base = a.dataStart
  for (let i = 0; i < u32len; i += 256) h = (h ^ load<u32>(base + (<usize>i << 2))) * 0x01000193
  return h
}

function seed(a: Float64Array): void {
  let s: u32 = 0x1234abcd
  for (let i = 0; i < a.length; i++) {
    s = s ^ (s << 13)
    s = s ^ (s >>> 17)
    s = s ^ (s << 5)
    unchecked(a[i] = <f64>(s & 255))
  }
}

function step(src: Float64Array, dst: Float64Array, w: i32, h: i32): void {
  for (let y = 1; y < h - 1; y++) {
    const row = y * w
    for (let x = 1; x < w - 1; x++) {
      const c = row + x
      unchecked(dst[c] = src[c] + K * (src[c - 1] + src[c + 1] + src[c - w] + src[c + w] - 4.0 * src[c]))
    }
  }
}

function run(a: Float64Array, b: Float64Array): void {
  for (let s = 0; s < STEPS; s += 2) { step(a, b, W, H); step(b, a, W, H) }
}

export function main(): void {
  const a = new Float64Array(W * H)
  const b = new Float64Array(W * H)
  for (let i = 0; i < N_WARMUP; i++) { seed(a); seed(b); run(a, b) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    seed(a); seed(b)
    const t0 = perfNow()
    run(a, b)
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
  const cs = checksumF64(a)
  logLine(<i32>(medianMs * 1000.0), cs, (W - 2) * (H - 2) * STEPS, 6, N_RUNS)
}
