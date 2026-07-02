// wordcount.js — token-frequency counting into a plain object with dynamic
// string keys, over a skewed synthetic word stream. The canonical associative
// text kernel (word counts, tag/label histograms, group-by aggregation): in a
// JS engine an object growing hundreds of computed string keys falls to
// dictionary mode — inline caches abandon it, the classic keyed-store deopt —
// while an AOT compiler must make string hashing, equality, and dynamic
// property storage cheap. Counts are exact integers, so the probed totals are
// bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly
// by the JS engines. Subset: const/let + arrows, object literals, computed
// string keys, String.fromCharCode, Math.imul, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in tokens/µs, FNV-1a checksum
// over the probed counts.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const NWORDS = 512           // distinct words in the vocabulary
const N = 1 << 14            // tokens per pass
const NPROBES = 64           // fixed lookups folded into the checksum
const N_ITERS = 16           // passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic vocabulary — 512 words of 3–8 lowercase chars from XorShift32,
// identical per target.
const buildWords = () => {
  const words = []
  let s = 0x1234abcd | 0
  for (let i = 0; i < NWORDS; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const len = 3 + ((s >>> 8) % 6)
    let w = ''
    let x = s | 0
    for (let j = 0; j < len; j++) {
      x = Math.imul(x, 0x9e3779b1) + j | 0
      w += String.fromCharCode(97 + ((x >>> 16) % 26))
    }
    words.push(w)
  }
  return words
}

// Skewed token stream — half the traffic hits 16 hot words (Zipf-ish),
// the rest spreads over the whole vocabulary.
const fillTokens = (toks) => {
  let s = 0x2545f491 | 0
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    toks[i] = (s & 8) === 0 ? (s >>> 4) & 15 : (s >>> 4) & (NWORDS - 1)
  }
}

const runKernel = (words, toks, probes) => {
  let h = 0x811c9dc5 | 0
  for (let it = 0; it < N_ITERS; it++) {
    const counts = {}
    for (let i = 0; i < N; i++) {
      const w = words[toks[i]]
      counts[w] = (counts[w] | 0) + 1
    }
    for (let j = 0; j < probes.length; j++) h = mix(h, counts[probes[j]] | 0)
  }
  return h >>> 0
}

export let main = () => {
  const words = buildWords()
  const toks = new Int32Array(N)
  fillTokens(toks)
  // Probe every 8th word plus 8 absent keys — a missing count reads 0.
  const probes = []
  for (let j = 0; j < NPROBES - 8; j++) probes.push(words[(j * 8) & (NWORDS - 1)])
  for (let j = 0; j < 8; j++) probes.push('zz' + j)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(words, toks, probes)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(words, toks, probes)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, N * N_ITERS, NWORDS, N_RUNS)
}
