// nqueens.as.ts — AssemblyScript translation of bench/nqueens/nqueens.js.
//
// Bitmask N-Queens solver, counting all solutions for a range of board sizes.
// The canonical backtracking / constraint-search kernel (the shape behind SAT
// solvers, puzzle search, combinatorial enumeration): deep recursion with a
// per-node branch over the available-columns bitmask, no array state. It
// stresses call/recursion codegen and branch prediction — a profile the
// suite's flat loops do not. Pure 32-bit integer, so the solution counts are
// bit-identical across every engine and native target.
//
// Board sizes are drawn from a runtime XorShift32 array — this runtime
// dependency defeats clang/zig constant-folding (literal sizes fold the whole
// recursion to 0 µs), so every engine actually runs the search.
//
// Reports: median µs across N_RUNS, throughput in solutions/µs, FNV-1a
// checksum over the per-query solution counts.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const NMIN: i32 = 8
const NSPAN: i32 = 4   // board sizes drawn from [NMIN, NMIN+NSPAN) = [8, 12)
const NQ: i32 = 20     // independent count queries per kernel run
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// Deterministic per-query board sizes — XorShift32, identical per target.
function fillSizes(out: Int32Array): void {
  let s: i32 = 0x1234abcd
  for (let q: i32 = 0; q < NQ; q++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(out[q] = NMIN + <i32>((<u32>s) % <u32>NSPAN))
  }
}

// Count placements that complete the board. `cols/d1/d2` are occupied-column
// and the two diagonal masks; `avail` isolates the legal squares of the
// current row, `b = avail & -avail` walks them lowest-bit first.
function solve(all: i32, cols: i32, d1: i32, d2: i32): i32 {
  if (cols === all) return 1
  let cnt: i32 = 0
  let avail: i32 = all & ~(cols | d1 | d2)
  while (avail !== 0) {
    const b: i32 = avail & (-avail)
    avail = avail - b
    cnt = cnt + solve(all, cols | b, (d1 | b) << 1, (d2 | b) >> 1)
  }
  return cnt
}

function countN(n: i32): i32 {
  return solve((1 << n) - 1, 0, 0, 0)
}

function mix(h: i32, x: i32): i32 {
  return <i32>Math.imul(h ^ x, 0x01000193)
}

function runKernel(sizes: Int32Array): u32 {
  let h: i32 = 0x811c9dc5
  for (let q: i32 = 0; q < NQ; q++) h = mix(h, countN(unchecked(sizes[q])) | 0)
  return <u32>h
}

export function main(): void {
  const sizes = new Int32Array(NQ)
  fillSizes(sizes)
  let total: i32 = 0
  for (let q: i32 = 0; q < NQ; q++) total = total + countN(unchecked(sizes[q]))

  let cs: u32 = 0
  for (let i: i32 = 0; i < N_WARMUP; i++) cs = runKernel(sizes)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(sizes)
    unchecked(samples[i] = perfNow() - t0)
  }

  const sorted = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i: i32 = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j: i32 = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, total, NMIN + NSPAN - 1, N_RUNS)
}
