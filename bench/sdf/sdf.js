// sdf.js — exact Euclidean distance transform (Felzenszwalb–Huttenlocher) of a glyph-like
// bitmap: the modern text-rendering pipeline's core (SDF atlases) and a staple of
// generative graphics. Two separable passes of the lower-envelope-of-parabolas algorithm:
// per row then per column, each maintaining a hull of parabola vertices in small scratch
// arrays with a data-dependent while-pop — the anti-vectorizer profile: short dependent
// loops, divisions, scratch reuse. All operations (+ − × ÷) are exactly rounded, so the
// squared-distance field is bit-identical across languages.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over the d² field (f64 bits).

import { medianUs, checksumF64, printResult } from '../_lib/benchlib.js'

const W = 384, H = 384
const INF = 1e20
const N_ITERS = 4
const N_RUNS = 21
const N_WARMUP = 5

const buildBitmap = (bmp) => {
  let s = 0x77aa123 | 0
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  for (let i = 0; i < W * H; i++) bmp[i] = 0
  for (let c = 0; c < 30; c++) {
    const cx = 20 + (rnd() % (W - 40))
    const cy = 20 + (rnd() % (H - 40))
    const r = 6 + (rnd() % 25)
    const r2 = r * r
    const fill = c % 4 === 3 ? 0 : 1
    for (let y = cy - r; y <= cy + r; y++) {
      const dy = y - cy
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx
        if (dx * dx + dy * dy <= r2) bmp[y * W + x] = fill
      }
    }
  }
}

// 1-D squared-distance transform of f[0..n) into d[0..n), scratch v (hull vertex
// positions, Int32) and z (hull boundaries, Float64 of length n+1)
const edt1d = (f, d, v, z, n) => {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let sMid = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k])
    while (sMid <= z[k]) {
      k--
      sMid = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k])
    }
    k++
    v[k] = q
    z[k] = sMid
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

const transform = (bmp, dist, rowf, rowd, v, z) => {
  // seed: 0 on ink, INF on paper
  for (let i = 0; i < W * H; i++) dist[i] = bmp[i] === 1 ? 0.0 : INF
  // columns
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) rowf[y] = dist[y * W + x]
    edt1d(rowf, rowd, v, z, H)
    for (let y = 0; y < H; y++) dist[y * W + x] = rowd[y]
  }
  // rows
  for (let y = 0; y < H; y++) {
    const off = y * W
    for (let x = 0; x < W; x++) rowf[x] = dist[off + x]
    edt1d(rowf, rowd, v, z, W)
    for (let x = 0; x < W; x++) dist[off + x] = rowd[x]
  }
}

const runKernel = (bmp, dist, rowf, rowd, v, z) => {
  for (let it = 0; it < N_ITERS; it++) transform(bmp, dist, rowf, rowd, v, z)
}

export let main = () => {
  const bmp = new Uint8Array(W * H)
  const dist = new Float64Array(W * H)
  const rowf = new Float64Array(W > H ? W : H)
  const rowd = new Float64Array(W > H ? W : H)
  const v = new Int32Array(W > H ? W : H)
  const z = new Float64Array((W > H ? W : H) + 1)
  buildBitmap(bmp)

  for (let i = 0; i < N_WARMUP; i++) runKernel(bmp, dist, rowf, rowd, v, z)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(bmp, dist, rowf, rowd, v, z)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(dist), W * H * N_ITERS, 2, N_RUNS)
}
