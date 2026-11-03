// setops.as.ts – AssemblyScript translation of bench/setops/setops.js.
//
// Near-duplicate detection over tokenized documents with sets: each document
// becomes a Set of its words minus the stop words, every word joins a
// vocabulary union, and each document is compared with the eight that follow
// it (intersection by probing, union by inclusion-exclusion, Jaccard in
// thousandths); duplicates pay for a set difference both ways (copy, delete).
// AssemblyScript's idiomatic answer is Set<string>; it has no live iterator,
// so a walk reads a snapshot of the values (`values()`). No fold depends on
// the order.
//
// Reports: median ms across N_RUNS, throughput in documents/µs, FNV-1a
// checksum over the vocabulary size, scores and differences.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const NWORDS: u32 = 1024
const NSTOP: i32 = 32             // the most common words are stop words
const NDOCS: i32 = 256
const WINDOW: i32 = 8             // documents compared after each one
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

@inline
function mix(h: i32, x: i32): i32 {
  return (h ^ x) * 0x01000193
}

let seed: u32 = 0x6d2b79f5
function next(): u32 {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed
}

// a word index skewed toward common words: the minimum of two uniform draws
function pick(): i32 {
  const a = next() % NWORDS, b = next() % NWORDS
  return <i32>(a < b ? a : b)
}

function buildWords(): Array<string> {
  const words = new Array<string>()
  for (let i: i32 = 0; i < <i32>NWORDS; i++) {
    const len = 3 + <i32>(next() % 7)
    let w = ''
    for (let j = 0; j < len; j++) w += String.fromCharCode(97 + <i32>(next() % 26))
    words.push(w + i.toString())
  }
  return words
}

function buildDocs(words: Array<string>): Array<Array<string>> {
  const docs = new Array<Array<string>>()
  for (let d = 0; d < NDOCS; d++) {
    const doc = new Array<string>()
    if (d % 8 == 7) {
      const prev = docs[d - 1]
      for (let k = 0; k < prev.length; k++) doc.push(next() % 10 == 0 ? words[pick()] : prev[k])
    } else {
      const len = 24 + <i32>(next() % 73)
      for (let k = 0; k < len; k++) doc.push(words[pick()])
    }
    docs.push(doc)
  }
  return docs
}

class Result {
  vocab: i32 = 0
  score: i32 = 0
  dupes: i32 = 0
  diff: i32 = 0
}

function compare(docs: Array<Array<string>>, stopWords: Array<string>): Result {
  const stop = new Set<string>()
  for (let k = 0; k < stopWords.length; k++) stop.add(unchecked(stopWords[k]))
  const vocab = new Set<string>()
  const sets = new Array<Set<string>>()
  for (let d = 0; d < docs.length; d++) {
    const doc = unchecked(docs[d])
    const s = new Set<string>()
    for (let k = 0; k < doc.length; k++) if (!stop.has(unchecked(doc[k]))) s.add(unchecked(doc[k]))
    const ws = s.values()
    for (let k = 0; k < ws.length; k++) vocab.add(unchecked(ws[k]))
    sets.push(s)
  }
  const r = new Result()
  r.vocab = vocab.size
  for (let i = 0; i < sets.length; i++) {
    const a = unchecked(sets[i])
    for (let j = i + 1; j <= i + WINDOW && j < sets.length; j++) {
      const b = unchecked(sets[j])
      const small = a.size < b.size ? a : b, large = small === a ? b : a
      let inter: i32 = 0
      const ws = small.values()
      for (let k = 0; k < ws.length; k++) if (large.has(unchecked(ws[k]))) inter++
      const union = a.size + b.size - inter
      const jac = union == 0 ? 0 : inter * 1000 / union
      r.score += jac
      if (jac >= 600) {
        r.dupes++
        const av = a.values(), bv = b.values()
        const onlyA = new Set<string>()
        for (let k = 0; k < av.length; k++) onlyA.add(unchecked(av[k]))
        for (let k = 0; k < bv.length; k++) onlyA.delete(unchecked(bv[k]))
        const onlyB = new Set<string>()
        for (let k = 0; k < bv.length; k++) onlyB.add(unchecked(bv[k]))
        for (let k = 0; k < av.length; k++) onlyB.delete(unchecked(av[k]))
        r.diff += onlyA.size + onlyB.size
      }
    }
  }
  return r
}

export function main(): void {
  const words = buildWords()
  const docs = buildDocs(words)
  const stopWords = words.slice(0, NSTOP)
  let r = compare(docs, stopWords)
  for (let i: i32 = 1; i < N_WARMUP; i++) r = compare(docs, stopWords)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    r = compare(docs, stopWords)
    unchecked(samples[i] = perfNow() - t0)
  }

  for (let i: i32 = 1; i < N_RUNS; i++) {
    const v = unchecked(samples[i])
    let j = i - 1
    while (j >= 0 && unchecked(samples[j]) > v) {
      unchecked(samples[j + 1] = samples[j])
      j--
    }
    unchecked(samples[j + 1] = v)
  }
  const cs = <u32>mix(mix(mix(mix(<i32>0x811c9dc5, r.vocab), r.score), r.dupes), r.diff)
  logLine(<i32>(unchecked(samples[(N_RUNS - 1) >> 1]) * 1000.0), cs, NDOCS, 3, N_RUNS)
}
