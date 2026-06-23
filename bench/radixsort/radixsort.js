// radixsort.js — least-significant-digit radix sort (4 × 8-bit counting passes)
// over a u32 key array. The canonical non-comparison integer sort (databases,
// GPU/CPU key sorting, particle binning): histogram → prefix-sum → scatter,
// ping-ponging between two buffers. Its gather/scatter memory pattern is distinct
// from the suite's compare-swap heapsort, and it is pure 32-bit integer
// throughout, so the sorted output is bit-identical across every engine and
// native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint32Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in keys/µs, FNV-1a checksum over
// the sorted key array.

import { medianUs, checksumU32, printResult } from '../_lib/benchlib.js'

const N = 1 << 14        // 16384 keys
const RADIX = 256        // 8-bit digit
const PASSES = 4         // 32-bit keys / 8-bit digits
const N_ITERS = 40       // sorts per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic u32 keys — XorShift32, identical per target.
const fill = (out) => {
  let s = 0x1234abcd | 0
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = s >>> 0
  }
}

// LSD radix sort: 4 stable counting-sort passes over 8-bit digits, ping-ponging
// a → b. PASSES is even, so the sorted result lands back in `a`.
const radixSort = (src, tmp, count) => {
  let a = src, b = tmp
  for (let shift = 0; shift < 32; shift += 8) {
    for (let i = 0; i < RADIX; i++) count[i] = 0
    for (let i = 0; i < N; i++) count[(a[i] >>> shift) & 0xff]++
    let sum = 0
    for (let i = 0; i < RADIX; i++) { const c = count[i]; count[i] = sum; sum += c }
    for (let i = 0; i < N; i++) {
      const d = (a[i] >>> shift) & 0xff
      b[count[d]] = a[i]
      count[d]++
    }
    const t = a; a = b; b = t
  }
}

const runKernel = (a, base, tmp, count) => {
  for (let it = 0; it < N_ITERS; it++) {
    for (let i = 0; i < N; i++) a[i] = (base[i] + it) >>> 0
    radixSort(a, tmp, count)
  }
}

export let main = () => {
  const base = new Uint32Array(N)
  const a = new Uint32Array(N)
  const tmp = new Uint32Array(N)
  const count = new Int32Array(RADIX)
  fill(base)
  for (let i = 0; i < N_WARMUP; i++) runKernel(a, base, tmp, count)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(a, base, tmp, count)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumU32(a), N * N_ITERS, PASSES, N_RUNS)
}
