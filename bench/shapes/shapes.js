// shapes.js — a per-variant measure summed over records of 8 heterogeneous
// object shapes, in data-shuffled order. The canonical shape-polymorphism
// kernel (JSON rows, AST nodes, ECS entities, event streams): every property
// access sees 8 hidden classes, so a JIT's load inline-cache goes megamorphic
// — the classic deopt shape — while an AOT compiler must resolve the same
// access across a union of static schemas. Pure 32-bit integer fields, so the
// sum is bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly
// by the JS engines. Subset: const/let + arrows, object literals, Math.imul,
// no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in records/µs, FNV-1a checksum
// over the per-pass sums.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 1 << 14            // records
const NSHAPES = 8            // distinct record shapes
const N_ITERS = 48           // record-stream passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic heterogeneous record stream — XorShift32 picks each record's
// variant and integer fields (masked small, so every product stays exact i32).
const initRows = () => {
  const rows = []
  let s = 0x1234abcd | 0
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const k = s & (NSHAPES - 1)
    const a = (s >>> 3) & 1023, b = (s >>> 13) & 1023, c = (s >>> 23) & 511
    if (k === 0) rows.push({ k: k, x: a, y: b })
    else if (k === 1) rows.push({ k: k, r: a })
    else if (k === 2) rows.push({ k: k, w: a, h: b })
    else if (k === 3) rows.push({ k: k, x0: a, y0: b, x1: c, y1: (a ^ b) & 511 })
    else if (k === 4) rows.push({ k: k, a: a, b: b, c: c })
    else if (k === 5) rows.push({ k: k, w: a, h: b, d: c })
    else if (k === 6) rows.push({ k: k, r: a, s: b })
    else rows.push({ k: k, n: c, s: b })
  }
  return rows
}

// One measure per variant — every access site here sees all 8 shapes.
const measure = (o) => {
  const k = o.k
  if (k === 0) return (o.x + o.y) | 0
  else if (k === 1) return Math.imul(o.r, Math.imul(o.r, 3))
  else if (k === 2) return Math.imul(o.w, o.h)
  else if (k === 3) {
    const dx = (o.x1 - o.x0) | 0, dy = (o.y1 - o.y0) | 0
    return ((dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy)) | 0
  }
  else if (k === 4) return (o.a + o.b + o.c) | 0
  else if (k === 5) return (Math.imul(o.w, o.h) - o.d) | 0
  else if (k === 6) return (Math.imul(o.r, o.s) + o.r) | 0
  return Math.imul(o.n, Math.imul(o.s, o.s))
}

const runKernel = (rows) => {
  let h = 0x811c9dc5 | 0
  for (let it = 0; it < N_ITERS; it++) {
    let sum = it | 0
    for (let i = 0; i < rows.length; i++) sum = (sum + measure(rows[i])) | 0
    h = mix(h, sum)
  }
  return h >>> 0
}

export let main = () => {
  const rows = initRows()
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(rows)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(rows)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, NSHAPES, N_RUNS)
}
