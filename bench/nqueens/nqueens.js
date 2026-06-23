// nqueens.js — bitmask N-Queens solver, counting all solutions for a range of
// board sizes. The canonical backtracking / constraint-search kernel (the shape
// behind SAT solvers, puzzle search, combinatorial enumeration): deep recursion
// with a per-node branch over the available-columns bitmask, no array state. It
// stresses call/recursion codegen and branch prediction — a profile the suite's
// flat loops do not. Pure 32-bit integer, so the solution counts are
// bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, recursion, bitwise ops, no
// class/async/regex.
//
// The board sizes are drawn from a runtime XorShift32 array rather than a literal
// loop bound: with literal sizes the whole recursion is a compile-time constant
// that clang/zig fold away (0 µs), making the native lane meaningless. Sourcing
// the size from runtime data is bit-identical across targets but forces every
// engine to actually run the search.
//
// Reports: median ms across N_RUNS, throughput in solutions/µs, FNV-1a checksum
// over the per-query solution counts.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const NMIN = 8
const NSPAN = 4              // board sizes drawn from [NMIN, NMIN+NSPAN) = [8, 12)
const NQ = 20               // independent count queries per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Deterministic per-query board sizes — XorShift32, identical per target.
const fillSizes = (out) => {
  let s = 0x1234abcd | 0
  for (let q = 0; q < NQ; q++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[q] = NMIN + (s >>> 0) % NSPAN
  }
}

// Count placements that complete the board. `cols/d1/d2` are occupied-column and
// the two diagonal masks; `avail` isolates the legal squares of the current row,
// `b = avail & -avail` walks them lowest-bit first.
const solve = (all, cols, d1, d2) => {
  if (cols === all) return 1
  let cnt = 0
  let avail = all & ~(cols | d1 | d2)
  while (avail !== 0) {
    const b = avail & (-avail)
    avail = avail - b
    cnt = cnt + solve(all, cols | b, (d1 | b) << 1, (d2 | b) >> 1)
  }
  return cnt
}

const countN = (n) => solve((1 << n) - 1, 0, 0, 0)

const runKernel = (sizes) => {
  let h = 0x811c9dc5 | 0
  for (let q = 0; q < NQ; q++) h = mix(h, countN(sizes[q]) | 0)
  return h >>> 0
}

export let main = () => {
  const sizes = new Int32Array(NQ)
  fillSizes(sizes)
  let total = 0
  for (let q = 0; q < NQ; q++) total = total + countN(sizes[q])

  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(sizes)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(sizes)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, total, NMIN + NSPAN - 1, N_RUNS)
}
