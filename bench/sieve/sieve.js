// sieve.js — Sieve of Eratosthenes over a byte array up to LIMIT. The canonical
// number-theory / enumeration kernel: for each prime, a strided inner loop writes
// a composite flag at i², i²+i, i²+2i, … The access pattern is pure strided
// scatter guarded by an outer branch (skip already-composite i), a memory profile
// distinct from the suite's dense contiguous loops. Pure integer, so the sieved
// bitmap is bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in numbers/µs, FNV-1a checksum over
// the composite bitmap.

import { medianUs, checksumU8, printResult } from '../_lib/benchlib.js'

const LIMIT = 1 << 20        // sieve [0, ~1M)
const N_ITERS = 6            // sieves per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Mark composites: comp[k] = 1 if k is composite, 0 if prime (0 and 1 forced
// composite). The i*i start skips multiples already crossed by smaller primes.
const sieve = (comp) => {
  for (let i = 0; i < LIMIT; i++) comp[i] = 0
  comp[0] = 1
  comp[1] = 1
  for (let i = 2; i * i < LIMIT; i++) {
    if (comp[i] === 0) {
      for (let j = i * i; j < LIMIT; j += i) comp[j] = 1
    }
  }
}

const runKernel = (comp) => {
  for (let it = 0; it < N_ITERS; it++) sieve(comp)
}

export let main = () => {
  const comp = new Uint8Array(LIMIT)
  for (let i = 0; i < N_WARMUP; i++) runKernel(comp)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    runKernel(comp)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumU8(comp), LIMIT * N_ITERS, 1, N_RUNS)
}
