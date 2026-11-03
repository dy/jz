// setops.js – near-duplicate detection over tokenized documents with Sets:
// each document becomes a Set of its words minus a stop-word Set (has, add),
// every word joins a vocabulary union, and each document is compared with the
// eight that follow it: intersection by probing the larger Set with the
// smaller one's words, union size by inclusion-exclusion, Jaccard similarity in
// thousandths; pairs scoring 600 or more count as duplicates and pay for a set
// difference both ways (copy a Set, delete the other's words). The shape of
// dedup, tag filtering, permission checks and diffing in every application.
//
// The corpus is built once from XorShift32, identical per target: a vocabulary
// of 1024 words, 256 documents of 24 to 96 tokens skewed toward common words,
// every eighth document an edited copy of the one before it. Scores and sizes
// are integers (the Jaccard quotient truncated), so every engine and port
// agrees bit for bit; no fold depends on a Set's iteration order.
//
// Reports: median ms across N_RUNS, throughput in documents/µs, FNV-1a
// checksum over the vocabulary size, scores and differences.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const NWORDS = 1024
const NSTOP = 32             // the most common words are stop words
const NDOCS = 256
const WINDOW = 8             // documents compared after each one
const N_RUNS = 21
const N_WARMUP = 5

let seed = 0x6d2b79f5 | 0
const next = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed >>> 0
}

const buildWords = () => {
  const words = []
  for (let i = 0; i < NWORDS; i++) {
    const len = 3 + next() % 7
    let w = ''
    for (let j = 0; j < len; j++) w += String.fromCharCode(97 + next() % 26)
    words.push(w + i)
  }
  return words
}

// a word index skewed toward common words: the minimum of two uniform draws
const pick = () => {
  const a = next() % NWORDS, b = next() % NWORDS
  return a < b ? a : b
}

const buildDocs = (words) => {
  const docs = []
  for (let d = 0; d < NDOCS; d++) {
    const doc = []
    if (d % 8 === 7) {
      const prev = docs[d - 1]
      for (let k = 0; k < prev.length; k++) doc.push(next() % 10 === 0 ? words[pick()] : prev[k])
    } else {
      const len = 24 + next() % 73
      for (let k = 0; k < len; k++) doc.push(words[pick()])
    }
    docs.push(doc)
  }
  return docs
}

const compare = (docs, stopWords) => {
  const stop = new Set(stopWords)
  const vocab = new Set()
  const sets = []
  for (let d = 0; d < docs.length; d++) {
    const doc = docs[d]
    const s = new Set()
    for (let k = 0; k < doc.length; k++) if (!stop.has(doc[k])) s.add(doc[k])
    for (const w of s) vocab.add(w)
    sets.push(s)
  }
  let score = 0, dupes = 0, diff = 0
  for (let i = 0; i < sets.length; i++) {
    const a = sets[i]
    for (let j = i + 1; j <= i + WINDOW && j < sets.length; j++) {
      const b = sets[j]
      const small = a.size < b.size ? a : b, large = small === a ? b : a
      let inter = 0
      for (const w of small) if (large.has(w)) inter++
      const union = a.size + b.size - inter
      const jac = union === 0 ? 0 : (inter * 1000 / union) | 0
      score += jac
      if (jac >= 600) {
        dupes++
        const onlyA = new Set(a)
        for (const w of b) onlyA.delete(w)
        const onlyB = new Set(b)
        for (const w of a) onlyB.delete(w)
        diff += onlyA.size + onlyB.size
      }
    }
  }
  return { vocab: vocab.size, score, dupes, diff }
}

export let main = () => {
  const words = buildWords()
  const docs = buildDocs(words)
  const stopWords = words.slice(0, NSTOP)
  let r = null
  for (let i = 0; i < N_WARMUP; i++) r = compare(docs, stopWords)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    r = compare(docs, stopWords)
    samples[i] = performance.now() - t0
  }
  const cs = mix(mix(mix(mix(0x811c9dc5 | 0, r.vocab), r.score), r.dupes), r.diff) >>> 0
  printResult(medianUs(samples), cs, NDOCS, 3, N_RUNS)
}
