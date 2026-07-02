// dispatch.js — data-driven dispatch through a table of first-class functions:
// an unpredictable opcode stream picks one of 8 tiny integer operators at a
// single call site. The canonical dynamic-dispatch kernel (virtual/interface
// calls, strategy tables, event pipelines, effect chains): past 4 targets a
// JIT's call inline-cache goes megamorphic — the classic deopt shape — while
// an AOT compiler must make the indirect call itself cheap. Pure 32-bit
// integer, so the fold result is bit-identical across every engine and native
// target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly
// by the JS engines. Subset: const/let + arrows, Int32Array, Math.imul, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in calls/µs, FNV-1a checksum
// over the per-pass fold results.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 1 << 14            // opcode stream length
const NOPS = 8               // distinct operators in the table
const N_ITERS = 48           // stream passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// The operator table — 8 first-class functions with one shared signature.
// One data-indexed call site fans out to all of them.
const ops = [
  (x, k) => (x + k) | 0,
  (x, k) => x ^ k,
  (x, k) => Math.imul(x, k | 1),
  (x, k) => (k - x) | 0,
  (x, k) => x ^ (x >>> 7) ^ k,
  (x, k) => ((x << 5) - x + k) | 0,
  (x, k) => ((x << 13) | (x >>> 19)) ^ k,
  (x, k) => (x & k) ^ (x >>> 11),
]

// Deterministic unpredictable opcode/operand stream — XorShift32, identical
// per target; low 3 bits pick the operator, the rest is the operand.
const fill = (code, ks) => {
  let s = 0x1234abcd | 0
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    code[i] = s & (NOPS - 1)
    ks[i] = s >> 3
  }
}

const runKernel = (code, ks) => {
  let h = 0x811c9dc5 | 0
  for (let it = 0; it < N_ITERS; it++) {
    let x = (0x2545f491 + it) | 0
    for (let i = 0; i < N; i++) x = ops[code[i]](x, ks[i])
    h = mix(h, x)
  }
  return h >>> 0
}

export let main = () => {
  const code = new Int32Array(N)
  const ks = new Int32Array(N)
  fill(code, ks)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(code, ks)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(code, ks)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, NOPS, N_RUNS)
}
