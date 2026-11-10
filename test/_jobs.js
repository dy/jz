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
