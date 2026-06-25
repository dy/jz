// hashjoin.js — probe-dominated relational hash join (build a hash table on a
// small "build" relation, then stream a large "probe" relation through it and sum
// matched payloads). The kernel at the heart of every database and dataframe
// engine (SQL joins, group-by, dedup) — and the distilled boss of JZ's single
// hardest codegen shape: the open-addressing probe `while (keys[h] !== EMPTY) {
// if (keys[h] === k) … }` reads the SAME slot twice per step (the guard then the
// match test). A register allocator (clang, Binaryen) keeps that load in a
// register; the cost of NOT eliminating it falls entirely on the dependent,
// cache-missing probe chain that dominates this kernel — so it is exactly where a
// safe compiler bleeds most against native.
//
// Optimizing it (eliminate the redundant probe load across the loop-guard→body
// edge, and prove h = … & MASK in-bounds so the slot read needs no check) makes
// JZ beat the field on the gather shape nothing in its class wins safely: AS-safe
// pays per-access checks, a JIT can't prove it from plain JS, native is unsafe.
//
// Pure 32-bit integer — the matched-payload sum is bit-identical across every
// engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Int32Array, Math.imul, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in probes/µs, FNV-1a checksum over
// the per-pass match sums.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const CAP = 1 << 14          // slot count (power of two) → mask = CAP-1
const MASK = CAP - 1
const BUILD = CAP >> 1       // 8192 build rows → load factor 0.5
const PROBE = 1 << 16        // 65536 probe rows — probe-dominated (8× build)
const EMPTY = -1             // sentinel; keys forced non-negative so never collide
const N_ITERS = 24           // build+probe passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic positive keys — XorShift32 masked to 31 bits, identical per target.
const fill = (out, n, seed) => {
  let s = seed | 0
  for (let i = 0; i < n; i++) {
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

// Idiomatic probe: the SAME slot keys[h] is read by the guard and the match test.
const probe = (keys, vals, k) => {
  let h = hash(k)
  while (keys[h] !== EMPTY) {
    if (keys[h] === k) return vals[h]
    h = (h + 1) & MASK
  }
  return 0
}

const runKernel = (keys, vals, build, probes) => {
  let h = 0x811c9dc5 | 0
  for (let it = 0; it < N_ITERS; it++) {
    for (let i = 0; i < CAP; i++) keys[i] = EMPTY            // clear table
    for (let i = 0; i < BUILD; i++) insert(keys, vals, build[i], (build[i] + it) | 0)
    let sum = 0
    for (let i = 0; i < PROBE; i++) sum = (sum + probe(keys, vals, probes[i])) | 0
    h = mix(h, sum)
  }
  return h >>> 0
}

export let main = () => {
  const keys = new Int32Array(CAP)
  const vals = new Int32Array(CAP)
  const build = new Int32Array(BUILD)
  const probes = new Int32Array(PROBE)
  fill(build, BUILD, 0x1234abcd)
  // Half the probes are real build keys (hits with full probe chains), half are a
  // disjoint stream (mostly misses that walk to an EMPTY slot) — a realistic ~50%
  // join selectivity that keeps the probe-chain branch unpredictable.
  fill(probes, PROBE, 0x9e3779b9)
  for (let i = 0; i < PROBE; i += 2) probes[i] = build[(i >>> 1) & (BUILD - 1)]

  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(keys, vals, build, probes)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(keys, vals, build, probes)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, PROBE * N_ITERS, 2, N_RUNS)
}
