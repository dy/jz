import { availableParallelism, freemem } from 'node:os'
import { positiveInteger } from '../scripts/test-tasks.mjs'

const gib = 1024 ** 3

// CPU count alone is not a memory budget: each worker loads a compiler and owns
// Wasm instances. Conservative automatic cap; an explicit override is honored.
export function testJobs(requested, count, cores = availableParallelism(), memory = process.availableMemory?.() ?? freemem()) {
  const jobs = requested != null ? positiveInteger(requested, 'test262 jobs')
    : Math.max(1, Math.min(2, cores, Math.floor((memory - gib) / gib)))
  return Math.min(jobs, Math.max(1, count))
}

// An ordered file list as at most `n` runs of near-equal weight, every file in
// exactly one. A run is contiguous: neighbours stay in one process, where
// compiler state one file leaves behind still meets the next file's compiles.
export function shards(files, weight, n) {
  const total = files.reduce((sum, f) => sum + weight(f), 0), out = []
  let run = [], seen = 0
  for (const f of files) {
    run.push(f)
    seen += weight(f)
    if (out.length < n - 1 && seen * n >= total * (out.length + 1)) { out.push(run); run = [] }
  }
  if (run.length) out.push(run)
  return out
}

// The runs a split suite starts, dearest first: three to a process, so the light ones
// started last level the finish (scripts/test-tasks.mjs runTasks gives each next run
// to the first process free).
export const plan = (files, weight, jobs) => shards(files, weight, jobs * 3)
  .map(run => ({ files: run, weight: run.reduce((sum, f) => sum + weight(f), 0) }))
  .sort((a, b) => b.weight - a.weight)

// A file list as n slices for n machines, every file in exactly one: the dearest file
// first goes to the slice lightest so far (bench/shards.mjs packs its cases the same
// way), and a slice lists its files in the list's order. Same inputs, same slices.
export function slices(files, weight, n) {
  positiveInteger(n, 'slices')
  const order = new Map(files.map((f, i) => [f, i]))
  const out = Array.from({ length: n }, () => ({ files: [], weight: 0 }))
  for (const f of files.toSorted((a, b) => weight(b) - weight(a) || order.get(a) - order.get(b))) {
    const s = out.reduce((min, s) => s.weight < min.weight ? s : min)
    s.files.push(f)
    s.weight += weight(f)
  }
  for (const s of out) s.files.sort((a, b) => order.get(a) - order.get(b))
  return out
}

// Measured seconds per file as a weight: a file the table has not timed weighs as
// the dearest timed file of the list, so a new file is never planned as cheap.
export function measured(files, seconds) {
  const dearest = Math.max(1, ...files.map(f => seconds[f]).filter(s => s > 0))
  return f => seconds[f] > 0 ? seconds[f] : dearest
}

// Measured seconds per file as a weight, and a file the table has not timed weighs its
// guess (its bytes, say) at the seconds a unit of guess costs the timed files of the
// list. With none of them timed, the guess alone.
export function estimated(files, seconds, guess) {
  const timed = files.filter(f => Object.hasOwn(seconds, f))
  const rate = timed.reduce((sum, f) => sum + seconds[f], 0) / timed.reduce((sum, f) => sum + guess(f), 0) || 1
  return f => Object.hasOwn(seconds, f) ? seconds[f] : guess(f) * rate
}
