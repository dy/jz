import { medianUs, checksumF64, printResult } from '../_lib/benchlib.js'

const N = 8192
const N_ITERS = 24
const N_RUNS = 21
const N_WARMUP = 5

const fill = (a) => {
  let s = 0x9e3779b9 | 0
  for (let i = 0; i < a.length; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    a[i] = (s >>> 0) / 4294967296
  }
}

// In-place heapsort — no recursion, no scratch buffer (AS-portable, jz-subset clean).
const siftDown = (a, root, end) => {
  let i = root
  let child = 2 * i + 1
  while (child < end) {
    if (child + 1 < end && a[child] < a[child + 1]) child++
    if (a[i] >= a[child]) return
    const t = a[i]; a[i] = a[child]; a[child] = t
    i = child
    child = 2 * i + 1
  }
}

const heapsort = (a) => {
  const n = a.length
  for (let i = (n >> 1) - 1; i >= 0; i--) siftDown(a, i, n)
  for (let end = n - 1; end > 0; end--) {
    const t = a[0]; a[0] = a[end]; a[end] = t
    siftDown(a, 0, end)
  }
}

const runKernel = (a, src) => {
  for (let it = 0; it < N_ITERS; it++) {
    for (let i = 0; i < a.length; i++) a[i] = src[i] + it
    heapsort(a)
  }
}

export let main = () => {
  const src = new Float64Array(N)
  const a = new Float64Array(N)
  fill(src)
  for (let i = 0; i < N_WARMUP; i++) runKernel(a, src)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(a, src)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(a), N * N_ITERS, 2, N_RUNS)
}
