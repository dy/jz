// movavg.js — moving average in a DSP library's idiom (digital-filter's
// `movingAverage(data, params)`): a boxcar FIR as a running sum over a ring of
// history kept in the caller's params bag, created on the first call from a
// window size (`new Array(n).fill(0)`), its write index and running sum
// persisted back into the bag, the sum refreshed once per lap to bound drift.
// What the kernel class pins: a bag property that is a number or an array, a
// write index that is absent before the first call, a modulus by a runtime
// length, a generic array as sample history.
//
// Reports: median ms across N_RUNS, output checksum (FNV-1a over a sparse
// stride of the result so the optimizer can't elide it).

import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

const N_SAMPLES = 480000  // 10 s @ 48 kHz mono
const N_WINDOW = 16
const N_RUNS = 21
const N_WARMUP = 5

// XorShift32: deterministic per-target. Output is in [-1, 1).
const mkInput = (n) => {
  const out = new Float64Array(n)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = ((s >>> 0) / 4294967296) * 2 - 1
  }
  return out
}

const movingAverage = (data, params) => {
  let ptr = params.ptr
  let mem = params.memory
  if (ptr == null) {
    if (!mem) mem = 8
    if (typeof mem === 'number') mem = new Array(mem).fill(0)
    ptr = params.ptr = 0
    params.memory = mem
  }
  const m = mem.length
  let sum = params._sum
  if (sum == null) {
    sum = 0
    for (let j = 0; j < m; j++) sum += mem[j]
  }
  for (let i = 0, l = data.length; i < l; i++) {
    sum += data[i] - mem[ptr]
    mem[ptr] = data[i]
    ptr = (ptr + 1) % m
    data[i] = sum / m
    if (ptr === 0) {
      sum = 0
      for (let j = 0; j < m; j++) sum += mem[j]
    }
  }
  params.ptr = ptr
  params._sum = sum
  return data
}

const run = () => {
  const x = mkInput(N_SAMPLES)
  const data = new Float64Array(N_SAMPLES)
  let params

  for (let i = 0; i < N_WARMUP; i++) {
    data.set(x); params = { memory: N_WINDOW }
    movingAverage(data, params)
  }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    data.set(x); params = { memory: N_WINDOW }
    const t0 = performance.now()
    movingAverage(data, params)
    samples[i] = performance.now() - t0
  }

  printResult(medianUs(samples), checksumF64(data), N_SAMPLES, N_WINDOW, N_RUNS)
}

export let main = () => {
  run()
}
