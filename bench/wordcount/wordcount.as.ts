// wordcount.as.ts — AssemblyScript translation of bench/wordcount/wordcount.js.
//
// Token-frequency counting into a string-keyed map, over a skewed synthetic
// word stream. The canonical associative text kernel (word counts, tag/label
// histograms, group-by aggregation). AssemblyScript's idiomatic answer is
// Map<string, i32> — the static reference for what the dynamic-keyed JS
// object costs. Counts are exact integers, so the probed totals are
// bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in tokens/µs, FNV-1a checksum
// over the probed counts.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const NWORDS: i32 = 512           // distinct words in the vocabulary
const N: i32 = 1 << 14            // tokens per pass
const NPROBES: i32 = 64           // fixed lookups folded into the checksum
const N_ITERS: i32 = 16           // passes per kernel run
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// mix: FNV-1a style, matches benchlib.js mix(h, x) = Math.imul(h ^ (x | 0), 0x01000193)
@inline
function mix(h: i32, x: i32): i32 {
  return (h ^ x) * 0x01000193
}

// Deterministic vocabulary — 512 words of 3–8 lowercase chars from XorShift32,
// identical per target.
function buildWords(): StaticArray<string> {
  const words = new StaticArray<string>(NWORDS)
  let s: i32 = 0x1234abcd
  for (let i = 0; i < NWORDS; i++) {
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    const len: i32 = 3 + <i32>((<u32>s >>> 8) % 6)
    let w = ''
    let x: i32 = s
    for (let j = 0; j < len; j++) {
      x = x * 0x9e3779b1 + j
      w += String.fromCharCode(97 + <i32>((<u32>x >>> 16) % 26))
    }
    unchecked(words[i] = w)
  }
  return words
}

// Skewed token stream — half the traffic hits 16 hot words (Zipf-ish),
// the rest spreads over the whole vocabulary.
function fillTokens(toks: Int32Array): void {
  let s: i32 = 0x2545f491
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    unchecked(toks[i] = (s & 8) == 0 ? <i32>((<u32>s >>> 4) & 15) : <i32>((<u32>s >>> 4) & (NWORDS - 1)))
  }
}

function runKernel(words: StaticArray<string>, toks: Int32Array, probes: StaticArray<string>): u32 {
  let h: i32 = <i32>0x811c9dc5
  for (let it: i32 = 0; it < N_ITERS; it++) {
    const counts = new Map<string, i32>()
    for (let i = 0; i < N; i++) {
      const w = unchecked(words[unchecked(toks[i])])
      counts.set(w, (counts.has(w) ? counts.get(w) : 0) + 1)
    }
    for (let j = 0; j < NPROBES; j++) {
      const p = unchecked(probes[j])
      h = mix(h, counts.has(p) ? counts.get(p) : 0)
    }
  }
  return <u32>h
}

export function main(): void {
  const words = buildWords()
  const toks = new Int32Array(N)
  fillTokens(toks)
  // Probe every 8th word plus 8 absent keys — a missing count reads 0.
  const probes = new StaticArray<string>(NPROBES)
  for (let j = 0; j < NPROBES - 8; j++) unchecked(probes[j] = words[(j * 8) & (NWORDS - 1)])
  for (let j = 0; j < 8; j++) unchecked(probes[NPROBES - 8 + j] = 'zz' + j.toString())
  let cs: u32 = 0
  for (let i: i32 = 0; i < N_WARMUP; i++) cs = runKernel(words, toks, probes)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(words, toks, probes)
    unchecked(samples[i] = perfNow() - t0)
  }

  const sorted = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i: i32 = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, NWORDS, N_RUNS)
}
