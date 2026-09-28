import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'
import { triangulatePolygon2 } from '../_lib/pmath/geometry/polygon2-triangulate.js'
import { decomposePolygon2Quick } from '../_lib/pmath/geometry/polygon2-decompose.js'

// Ear-clipping triangulation and convex decomposition of 2-D polygons held as
// flat plain arrays (pmndrs/math): index arrays built per call, out-buffers
// written past their length, polygon copies pushed element by element. The
// runtime-built-array kernel: nothing here is a typed array.
const N_ITERS = 40
const N_RUNS = 21
const N_WARMUP = 5

const comb = [0, 0, 6, 0, 6, 3, 5, 3, 5, 1, 4, 1, 4, 3, 3, 3, 3, 1, 2, 1, 2, 3, 1, 3, 1, 1, 0, 1]
const combN = comb.length / 2

const convex = []
const CONVEX_N = 32
for (let i = 0; i < CONVEX_N; i++) {
  const a = (i / CONVEX_N) * Math.PI * 2
  convex.push(Math.cos(a) * 5, Math.sin(a) * 5)
}

const gear = []
const SPIKES = 12
for (let i = 0; i < SPIKES * 2; i++) {
  const a = (i / (SPIKES * 2)) * Math.PI * 2
  const r = i % 2 === 0 ? 5 : 2.5
  gear.push(Math.cos(a) * r, Math.sin(a) * r)
}

const out = []

const run = (acc, iters) => {
  let tris = 0, parts = 0
  for (let i = 0; i < iters; i++) {
    tris += triangulatePolygon2(out, comb, combN)
    tris += triangulatePolygon2(out, convex, CONVEX_N)
    parts += decomposePolygon2Quick(gear, SPIKES * 2).length
  }
  acc[0] = tris
  acc[1] = parts
  for (let k = 0; k < 3 * (CONVEX_N - 2); k++) acc[2 + k] = out[k]
}

export let main = () => {
  const acc = new Float64Array(2 + 3 * (CONVEX_N - 2))
  for (let i = 0; i < N_WARMUP; i++) run(acc, N_ITERS)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    run(acc, N_ITERS)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(acc), N_ITERS * 3, 3, N_RUNS)
}
