// shapes.as.ts — AssemblyScript translation of bench/shapes/shapes.js.
//
// A per-variant measure summed over records of 8 heterogeneous shapes, in
// data-shuffled order. The canonical shape-polymorphism kernel (JSON rows,
// AST nodes, ECS entities, event streams). AssemblyScript's idiomatic answer
// to heterogeneous records is a kind-tagged flat class + branch (its classes
// are fixed-layout structs) — the static reference for what the dynamic-shape
// JS source costs. Pure 32-bit integer fields, so the sum is bit-identical
// across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in records/µs, FNV-1a checksum
// over the per-pass sums.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 14            // records
const NSHAPES: i32 = 8            // distinct record shapes
const N_ITERS: i32 = 48           // record-stream passes per kernel run
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// Kind-tagged record; payload fields map positionally per variant:
//   0 point  a=x  b=y            1 circle a=r
//   2 rect   a=w  b=h            3 line   a=x0 b=y0 c=x1 d=y1
//   4 tri    a b c               5 prism  a=w  b=h  c=d
//   6 arc    a=r  b=s            7 poly   a=n  b=s
class Rec {
  constructor(
    public k: i32 = 0,
    public a: i32 = 0,
    public b: i32 = 0,
    public c: i32 = 0,
    public d: i32 = 0,
  ) {}
}

// Deterministic heterogeneous record stream — XorShift32 picks each record's
// variant and integer fields (masked small, so every product stays exact i32).
function initRows(): StaticArray<Rec> {
  const rows = new StaticArray<Rec>(N)
  let s: i32 = 0x1234abcd
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    const k: i32 = s & (NSHAPES - 1)
    const a: i32 = (s >>> 3) & 1023
    const b: i32 = (s >>> 13) & 1023
    const c: i32 = (s >>> 23) & 511
    let r: Rec
    if (k == 0) r = new Rec(k, a, b)
    else if (k == 1) r = new Rec(k, a)
    else if (k == 2) r = new Rec(k, a, b)
    else if (k == 3) r = new Rec(k, a, b, c, (a ^ b) & 511)
    else if (k == 4) r = new Rec(k, a, b, c)
    else if (k == 5) r = new Rec(k, a, b, c)
    else if (k == 6) r = new Rec(k, a, b)
    else r = new Rec(k, c, b)
    unchecked(rows[i] = r)
  }
  return rows
}

// One measure per variant — mirrors shapes.js measure() exactly.
function measure(o: Rec): i32 {
  const k = o.k
  if (k == 0) return o.a + o.b
  else if (k == 1) return o.a * (o.a * 3)
  else if (k == 2) return o.a * o.b
  else if (k == 3) {
    const dx = o.c - o.a, dy = o.d - o.b
    return (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy)
  }
  else if (k == 4) return o.a + o.b + o.c
  else if (k == 5) return o.a * o.b - o.c
  else if (k == 6) return o.a * o.b + o.a
  return o.a * (o.b * o.b)
}

// mix: FNV-1a style, matches benchlib.js mix(h, x) = Math.imul(h ^ (x | 0), 0x01000193)
@inline
function mix(h: i32, x: i32): i32 {
  return (h ^ x) * 0x01000193
}

function runKernel(rows: StaticArray<Rec>): u32 {
  let h: i32 = <i32>0x811c9dc5
  for (let it: i32 = 0; it < N_ITERS; it++) {
    let sum: i32 = it
    for (let i = 0; i < N; i++) sum = sum + measure(unchecked(rows[i]))
    h = mix(h, sum)
  }
  return <u32>h
}

export function main(): void {
  const rows = initRows()
  let cs: u32 = 0
  for (let i: i32 = 0; i < N_WARMUP; i++) cs = runKernel(rows)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(rows)
    unchecked(samples[i] = perfNow() - t0)
  }

  const sorted = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i: i32 = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, NSHAPES, N_RUNS)
}
