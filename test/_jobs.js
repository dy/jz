import { availableParallelism, freemem } from 'node:os'

// CPU count alone is not a memory budget: each worker loads a compiler and owns
// Wasm instances. Conservative automatic cap; an explicit override is honored.
export function testJobs(requested, count, cores = availableParallelism(), memory = process.availableMemory?.() ?? freemem()) {
  let jobs
  if (requested != null) {
    jobs = Number(requested)
    if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('test262 jobs must be a positive integer')
  } else {
    const gib = 1024 ** 3
    jobs = Math.max(1, Math.min(2, cores, Math.floor((memory - gib) / gib)))
  }
  return Math.min(jobs, Math.max(1, count))
}
