// dict.js — open-addressing hash table (build + probe) with linear probing. The
// canonical associative-container kernel (symbol tables, dedup, joins, counting):
// a multiply-shift hash scatters keys across a power-of-two slot array, and every
// insert/lookup walks a probe chain of branchy comparisons. It stresses
// scatter writes, dependent-load gather, and unpredictable branches — the
// hash-table shape no other case in the suite covers. Pure 32-bit integer, so the
// looked-up values are bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Int32Array, Math.imul, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in ops/µs, FNV-1a checksum over
// the probe results.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const CAP = 1 << 14          // slot count (power of two) → mask = CAP-1
const MASK = CAP - 1
const NKEYS = CAP >> 1       // 8192 keys → load factor 0.5
const EMPTY = -1             // sentinel; keys are forced non-negative so never collide
const N_ITERS = 60           // build+probe passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic positive keys — XorShift32 masked to 31 bits, identical per target.
const fill = (out) => {
  let s = 0x1234abcd | 0
  for (let i = 0; i < NKEYS; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = (s >>> 0) & 0x7fffffff
  }
}

const hash = (k) => (Math.imul(k, 0x9e3779b1) >>> 0) & MASK

const insert = (keys, vals, k, v) => {
  let h = hash(k)
  while (keys[h] !== EMPTY) {
    if (keys[h] === k) { vals[h] = v; return }
    h = (h + 1) & MASK
  }
  keys[h] = k
  vals[h] = v
}

const lookup = (keys, vals, k) => {
  let h = hash(k)
  while (keys[h] !== EMPTY) {
    if (keys[h] === k) return vals[h]
    h = (h + 1) & MASK
  }
  return -1
}

const runKernel = (keys, vals, src) => {
  let h = 0x811c9dc5 | 0
  for (let it = 0; it < N_ITERS; it++) {
    for (let i = 0; i < CAP; i++) keys[i] = EMPTY       // clear table
    for (let i = 0; i < NKEYS; i++) insert(keys, vals, src[i], (src[i] + it) | 0)
    for (let i = 0; i < NKEYS; i++) {
      const v = lookup(keys, vals, src[(i * 7) & (NKEYS - 1)])
      h = mix(h, v | 0)
    }
  }
  return h >>> 0
}

export let main = () => {
  const keys = new Int32Array(CAP)
  const vals = new Int32Array(CAP)
  const src = new Int32Array(NKEYS)
  fill(src)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(keys, vals, src)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(keys, vals, src)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, NKEYS * N_ITERS, 2, N_RUNS)
}
