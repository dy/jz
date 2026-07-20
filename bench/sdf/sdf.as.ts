// sdf.as.ts — AssemblyScript translation of bench/sdf/sdf.js.
//
// Exact Euclidean distance transform (Felzenszwalb–Huttenlocher) of a glyph-like
// bitmap: the modern text-rendering pipeline's core (SDF atlases) and a staple of
// generative graphics. Two separable passes of the lower-envelope-of-parabolas algorithm:
// per row then per column, each maintaining a hull of parabola vertices in small scratch
// arrays with a data-dependent while-pop — the anti-vectorizer profile: short dependent
// loops, divisions, scratch reuse. All operations (+ − × ÷) are exactly rounded, so the
// squared-distance field is bit-identical across languages.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const W: i32 = 384
const H: i32 = 384
const INF: f64 = 1e20
const N_ITERS: i32 = 4
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function checksumF64(a: Float64Array): u32 {
  let h: u32 = 0x811c9dc5
  const u32len = a.length * 2
  const base = a.dataStart
  for (let i = 0; i < u32len; i += 256) h = (h ^ load<u32>(base + (<usize>i << 2))) * 0x01000193
  return h
}

let rngS: u32 = 0
function rnd(): u32 {
  rngS ^= rngS << 13
  rngS ^= rngS >>> 17
  rngS ^= rngS << 5
  return rngS
}

function buildBitmap(bmp: Uint8Array): void {
  rngS = 0x77aa123
  for (let i: i32 = 0; i < W * H; i++) unchecked(bmp[i] = 0)
  for (let c: i32 = 0; c < 30; c++) {
    const cx: i32 = 20 + <i32>(rnd() % <u32>(W - 40))
    const cy: i32 = 20 + <i32>(rnd() % <u32>(H - 40))
    const r: i32 = 6 + <i32>(rnd() % 25)
    const r2: i32 = r * r
    const fill: u8 = (c % 4 === 3) ? 0 : 1
    for (let y: i32 = cy - r; y <= cy + r; y++) {
      const dy: i32 = y - cy
      for (let x: i32 = cx - r; x <= cx + r; x++) {
        const dx: i32 = x - cx
        if (dx * dx + dy * dy <= r2) unchecked(bmp[y * W + x] = fill)
      }
    }
  }
}

// 1-D squared-distance transform of f[0..n) into d[0..n), scratch v (hull vertex
// positions, Int32) and z (hull boundaries, Float64 of length n+1)
function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: i32): void {
  let k: i32 = 0
  unchecked(v[0] = 0)
  unchecked(z[0] = -INF)
  unchecked(z[1] = INF)
  for (let q: i32 = 1; q < n; q++) {
    let sMid: f64 = unchecked(((f[q] + <f64>(q * q)) - (f[v[k]] + <f64>(v[k] * v[k]))) / (2.0 * <f64>q - 2.0 * <f64>v[k]))
    while (sMid <= unchecked(z[k])) {
      k--
      sMid = unchecked(((f[q] + <f64>(q * q)) - (f[v[k]] + <f64>(v[k] * v[k]))) / (2.0 * <f64>q - 2.0 * <f64>v[k]))
    }
    k++
    unchecked(v[k] = q)
    unchecked(z[k] = sMid)
    unchecked(z[k + 1] = INF)
  }
  k = 0
  for (let q: i32 = 0; q < n; q++) {
    while (unchecked(z[k + 1]) < <f64>q) k++
    const dq: i32 = q - unchecked(v[k])
    unchecked(d[q] = <f64>(dq * dq) + f[v[k]])
  }
}

function transform(bmp: Uint8Array, dist: Float64Array, rowf: Float64Array, rowd: Float64Array, v: Int32Array, z: Float64Array): void {
  // seed: 0 on ink, INF on paper
  for (let i: i32 = 0; i < W * H; i++) unchecked(dist[i] = bmp[i] === 1 ? 0.0 : INF)
  // columns
  for (let x: i32 = 0; x < W; x++) {
    for (let y: i32 = 0; y < H; y++) unchecked(rowf[y] = dist[y * W + x])
    edt1d(rowf, rowd, v, z, H)
    for (let y: i32 = 0; y < H; y++) unchecked(dist[y * W + x] = rowd[y])
  }
  // rows
  for (let y: i32 = 0; y < H; y++) {
    const off: i32 = y * W
    for (let x: i32 = 0; x < W; x++) unchecked(rowf[x] = dist[off + x])
    edt1d(rowf, rowd, v, z, W)
    for (let x: i32 = 0; x < W; x++) unchecked(dist[off + x] = rowd[x])
  }
}

function runKernel(bmp: Uint8Array, dist: Float64Array, rowf: Float64Array, rowd: Float64Array, v: Int32Array, z: Float64Array): void {
  for (let it: i32 = 0; it < N_ITERS; it++) transform(bmp, dist, rowf, rowd, v, z)
}

export function main(): void {
  const bmp = new Uint8Array(W * H)
  const dist = new Float64Array(W * H)
  const maxWH: i32 = W > H ? W : H
  const rowf = new Float64Array(maxWH)
  const rowd = new Float64Array(maxWH)
  const v = new Int32Array(maxWH)
  const z = new Float64Array(maxWH + 1)
  buildBitmap(bmp)

  for (let i = 0; i < N_WARMUP; i++) runKernel(bmp, dist, rowf, rowd, v, z)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    runKernel(bmp, dist, rowf, rowd, v, z)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumF64(dist)

  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i = 1; i < N_RUNS; i++) {
    const mv = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > mv) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = mv)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, W * H * N_ITERS, 2, N_RUNS)
}
