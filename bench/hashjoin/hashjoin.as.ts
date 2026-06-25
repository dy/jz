// hashjoin.as.ts — AssemblyScript translation of bench/hashjoin/hashjoin.js.
//
// Probe-dominated relational hash join (build a hash table on a small "build"
// relation, then stream a large "probe" relation through it and sum matched
// payloads). The kernel at the heart of every database and dataframe engine. Pure
// 32-bit integer — the matched-payload sum is bit-identical across every engine and
// native target.
//
// Reports: median ms across N_RUNS, throughput in probes/µs, FNV-1a checksum over
// the per-pass match sums.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const CAP: i32 = 1 << 14          // slot count (power of two) → mask = CAP-1
const MASK: i32 = CAP - 1
const BUILD: i32 = CAP >> 1       // 8192 build rows → load factor 0.5
const PROBE: i32 = 1 << 16        // 65536 probe rows — probe-dominated
const EMPTY: i32 = -1             // sentinel; keys forced non-negative so never collide
const N_ITERS: i32 = 24           // build+probe passes per kernel run
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// Deterministic positive keys — XorShift32 masked to 31 bits, identical per target.
function fill(out: Int32Array, n: i32, seed: i32): void {
  let s: i32 = seed
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    unchecked(out[i] = <i32>(<u32>s & 0x7fffffff))
  }
}

function hash(k: i32): i32 {
  return <i32>(<u32>(k * 0x9e3779b1) & <u32>MASK)
}

function insert(keys: Int32Array, vals: Int32Array, k: i32, v: i32): void {
  let h = hash(k)
  while (unchecked(keys[h]) !== EMPTY) {
    if (unchecked(keys[h]) === k) { unchecked(vals[h] = v); return }
    h = (h + 1) & MASK
  }
  unchecked(keys[h] = k)
  unchecked(vals[h] = v)
}

function probe(keys: Int32Array, vals: Int32Array, k: i32): i32 {
  let h = hash(k)
  while (unchecked(keys[h]) !== EMPTY) {
    if (unchecked(keys[h]) === k) return unchecked(vals[h])
    h = (h + 1) & MASK
  }
  return 0
}

function runKernel(keys: Int32Array, vals: Int32Array, build: Int32Array, probes: Int32Array): u32 {
  let h: i32 = <i32>0x811c9dc5
  for (let it = 0; it < N_ITERS; it++) {
    for (let i = 0; i < CAP; i++) unchecked(keys[i] = EMPTY)
    for (let i = 0; i < BUILD; i++) insert(keys, vals, unchecked(build[i]), (unchecked(build[i]) + it))
    let sum: i32 = 0
    for (let i = 0; i < PROBE; i++) sum = (sum + probe(keys, vals, unchecked(probes[i])))
    h = (h ^ sum) * 0x01000193
  }
  return <u32>h
}

export function main(): void {
  const keys = new Int32Array(CAP)
  const vals = new Int32Array(CAP)
  const build = new Int32Array(BUILD)
  const probes = new Int32Array(PROBE)
  fill(build, BUILD, 0x1234abcd)
  fill(probes, PROBE, <i32>0x9e3779b9)
  for (let i = 0; i < PROBE; i += 2) unchecked(probes[i] = build[(i >> 1) & (BUILD - 1)])

  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(keys, vals, build, probes)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(keys, vals, build, probes)
    unchecked(samples[i] = perfNow() - t0)
  }

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
  logLine(<i32>(medianMs * 1000.0), cs, PROBE * N_ITERS, 2, N_RUNS)
}
