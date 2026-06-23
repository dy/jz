// levenshtein.js — Levenshtein edit distance via the rolling-row dynamic program.
// The canonical sequence-alignment / fuzzy-match kernel (spell-check, diff,
// bioinformatics, search): a 2-D DP whose every cell is min(delete, insert,
// substitute) over integers, with a diagonal data dependency that no target can
// vectorize — a branch- and min-reduction-heavy access pattern distinct from the
// suite's other loops. Pure 32-bit integer, so the distance is bit-identical
// across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in DP-cells/µs, FNV-1a checksum
// over the per-iteration distances.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const LA = 512           // length of string A
const LB = 512           // length of string B
const ALPHA = 8          // small alphabet → realistic match/mismatch mix
const N_ITERS = 8        // distance evaluations per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic strings over a small alphabet — XorShift32, identical per target.
const fill = (out, n, seed) => {
  let s = seed | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = (s >>> 0) % ALPHA
  }
}

// Edit distance with a single rolling row of size LB+1. `diag` carries the
// upper-left cell (dp[i-1][j-1]) across the inner loop so no second row is needed.
const levenshtein = (a, b, prev) => {
  for (let j = 0; j <= LB; j++) prev[j] = j
  for (let i = 1; i <= LA; i++) {
    let diag = prev[0]
    prev[0] = i
    const ai = a[i - 1]
    for (let j = 1; j <= LB; j++) {
      const up = prev[j]
      const sub = diag + (ai === b[j - 1] ? 0 : 1)
      let m = up + 1
      const ins = prev[j - 1] + 1
      if (ins < m) m = ins
      if (sub < m) m = sub
      diag = up
      prev[j] = m
    }
  }
  return prev[LB]
}

const runKernel = (a, b, prev) => {
  let h = 0x811c9dc5 | 0
  for (let it = 0; it < N_ITERS; it++) {
    const j = it % LA
    a[j] = (a[j] + 1) % ALPHA          // perturb so the distance changes and the call can't be hoisted
    h = mix(h, levenshtein(a, b, prev) | 0)
  }
  return h >>> 0
}

export let main = () => {
  const a = new Uint8Array(LA)
  const b = new Uint8Array(LB)
  const prev = new Int32Array(LB + 1)
  fill(a, LA, 0x1234abcd | 0)
  fill(b, LB, 0x9e3779b9 | 0)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(a, b, prev)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(a, b, prev)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, LA * LB * N_ITERS, 2, N_RUNS)
}
