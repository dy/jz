// dispatch.as.ts — AssemblyScript translation of bench/dispatch/dispatch.js.
//
// Data-driven dispatch through a table of first-class functions: an
// unpredictable opcode stream picks one of 8 tiny integer operators at a
// single call site. The canonical dynamic-dispatch kernel (virtual/interface
// calls, strategy tables, event pipelines, effect chains): every step is an
// indirect call through a data-selected function reference. Pure 32-bit
// integer, so the fold result is bit-identical across every engine and native
// target.
//
// Reports: median ms across N_RUNS, throughput in calls/µs, FNV-1a checksum
// over the per-pass fold results.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 14            // opcode stream length
const NOPS: i32 = 8               // distinct operators in the table
const N_ITERS: i32 = 48           // stream passes per kernel run
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// The operator table — 8 functions with one shared signature, selected per
// element by data. Semantics mirror dispatch.js exactly (JS i32 ops).
type OpFn = (x: i32, k: i32) => i32
function opAdd(x: i32, k: i32): i32 { return x + k }
function opXor(x: i32, k: i32): i32 { return x ^ k }
function opMul(x: i32, k: i32): i32 { return x * (k | 1) }
function opRsub(x: i32, k: i32): i32 { return k - x }
function opShr(x: i32, k: i32): i32 { return x ^ (x >>> 7) ^ k }
function opM31(x: i32, k: i32): i32 { return (x << 5) - x + k }
function opRot(x: i32, k: i32): i32 { return ((x << 13) | (x >>> 19)) ^ k }
function opAnd(x: i32, k: i32): i32 { return (x & k) ^ (x >>> 11) }

const OPS: StaticArray<OpFn> = [opAdd, opXor, opMul, opRsub, opShr, opM31, opRot, opAnd]

// Deterministic unpredictable opcode/operand stream — XorShift32, identical
// per target; low 3 bits pick the operator, the rest is the operand.
function fill(code: Int32Array, ks: Int32Array): void {
  let s: i32 = 0x1234abcd
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    unchecked(code[i] = s & (NOPS - 1))
    unchecked(ks[i] = s >> 3)
  }
}

// mix: FNV-1a style, matches benchlib.js mix(h, x) = Math.imul(h ^ (x | 0), 0x01000193)
@inline
function mix(h: i32, x: i32): i32 {
  return (h ^ x) * 0x01000193
}

function runKernel(code: Int32Array, ks: Int32Array): u32 {
  let h: i32 = <i32>0x811c9dc5
  for (let it: i32 = 0; it < N_ITERS; it++) {
    let x: i32 = <i32>(0x2545f491 + <u32>it)
    for (let i = 0; i < N; i++) {
      x = unchecked(OPS[unchecked(code[i])])(x, unchecked(ks[i]))
    }
    h = mix(h, x)
  }
  return <u32>h
}

export function main(): void {
  const code = new Int32Array(N)
  const ks = new Int32Array(N)
  fill(code, ks)
  let cs: u32 = 0
  for (let i: i32 = 0; i < N_WARMUP; i++) cs = runKernel(code, ks)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(code, ks)
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
  logLine(<i32>(medianMs * 1000.0), cs, N * N_ITERS, NOPS, N_RUNS)
}
