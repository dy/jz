// sieve.as.ts — AssemblyScript translation of bench/sieve/sieve.js.
//
// Sieve of Eratosthenes over a byte array up to LIMIT. The canonical
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

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const LIMIT: i32 = 1 << 20   // sieve [0, ~1M)
const N_ITERS: i32 = 6        // sieves per kernel run
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function sieve(comp: Uint8Array): void {
  for (let i = 0; i < LIMIT; i++) unchecked(comp[i] = 0)
  unchecked(comp[0] = 1)
  unchecked(comp[1] = 1)
  for (let i = 2; i * i < LIMIT; i++) {
    if (unchecked(comp[i]) === 0) {
      for (let j = i * i; j < LIMIT; j += i) unchecked(comp[j] = 1)
    }
  }
}

function runKernel(comp: Uint8Array): void {
  for (let it = 0; it < N_ITERS; it++) sieve(comp)
}

function checksumU8(out: Uint8Array): u32 {
  let h: u32 = 0x811c9dc5
  const n = out.length
  for (let i = 0; i < n; i++) h = (h ^ <u32>unchecked(out[i])) * 0x01000193
  return h
}

export function main(): void {
  const comp = new Uint8Array(LIMIT)
  for (let i = 0; i < N_WARMUP; i++) runKernel(comp)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    runKernel(comp)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumU8(comp)

  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, LIMIT * N_ITERS, 1, N_RUNS)
}
