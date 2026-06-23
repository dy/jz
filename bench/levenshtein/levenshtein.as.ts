// levenshtein.as.ts — AssemblyScript translation of bench/levenshtein/levenshtein.js.
// Levenshtein edit distance via the rolling-row dynamic program.
// The canonical sequence-alignment / fuzzy-match kernel (spell-check, diff,
// bioinformatics, search): a 2-D DP whose every cell is min(delete, insert,
// substitute) over integers, with a diagonal data dependency that no target can
// vectorize — a branch- and min-reduction-heavy access pattern distinct from the
// suite's other loops. Pure 32-bit integer, so the distance is bit-identical
// across every engine and native target.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const LA: i32 = 512
const LB: i32 = 512
const ALPHA: i32 = 8
const N_ITERS: i32 = 8
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function fill(out: Uint8Array, n: i32, seed: i32): void {
  let s: i32 = seed
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    unchecked(out[i] = <u8>(<u32>s % <u32>ALPHA))
  }
}

function levenshtein(a: Uint8Array, b: Uint8Array, prev: Int32Array): i32 {
  for (let j = 0; j <= LB; j++) unchecked(prev[j] = j)
  for (let i = 1; i <= LA; i++) {
    let diag: i32 = unchecked(prev[0])
    unchecked(prev[0] = i)
    const ai: u8 = unchecked(a[i - 1])
    for (let j = 1; j <= LB; j++) {
      const up: i32 = unchecked(prev[j])
      const sub: i32 = diag + (ai === unchecked(b[j - 1]) ? 0 : 1)
      let m: i32 = up + 1
      const ins: i32 = unchecked(prev[j - 1]) + 1
      if (ins < m) m = ins
      if (sub < m) m = sub
      diag = up
      unchecked(prev[j] = m)
    }
  }
  return unchecked(prev[LB])
}

function mix(h: i32, x: i32): i32 {
  return <i32>Math.imul(h ^ x, 0x01000193)
}

function runKernel(a: Uint8Array, b: Uint8Array, prev: Int32Array): u32 {
  let h: i32 = 0x811c9dc5
  for (let it = 0; it < N_ITERS; it++) {
    const j: i32 = it % LA
    unchecked(a[j] = <u8>((<u32>unchecked(a[j]) + 1) % <u32>ALPHA))
    h = mix(h, levenshtein(a, b, prev))
  }
  return <u32>h
}

export function main(): void {
  const a = new Uint8Array(LA)
  const b = new Uint8Array(LB)
  const prev = new Int32Array(LB + 1)
  fill(a, LA, 0x1234abcd)
  fill(b, LB, 0x9e3779b9)
  let cs: u32 = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(a, b, prev)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(a, b, prev)
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
  logLine(<i32>(medianMs * 1000.0), cs, LA * LB * N_ITERS, 2, N_RUNS)
}
