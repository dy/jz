import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N = 16384
const N_ITERS = 64
const N_RUNS = 21
const N_WARMUP = 5

const initRows = () => {
  const rows = []
  for (let i = 0; i < N; i++) rows.push({ x: i * 0.5, y: i + 1, z: (i & 7) - 3 })
  return rows
}

const runKernel = (rows, xs, ys, zs) => {
  for (let r = 0; r < N_ITERS; r++) {
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i]
      xs[i] = p.x + p.y * 0.25 + r
      ys[i] = p.y - p.z * 0.5
      zs[i] = p.z + p.x * 0.125
    }
  }
}

export let main = () => {
  const rows = initRows()
  const xs = new Float64Array(N)
  const ys = new Float64Array(N)
  const zs = new Float64Array(N)
  for (let i = 0; i < N_WARMUP; i++) runKernel(rows, xs, ys, zs)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(rows, xs, ys, zs)
    samples[i] = performance.now() - t0
  }
  const cs = (checksumF64(xs) ^ checksumF64(ys) ^ checksumF64(zs)) >>> 0
  printResult(medianUs(samples), cs, N * N_ITERS, 3, N_RUNS)
}
