// spmv.as.ts — AssemblyScript translation of bench/spmv/spmv.js.
//
// Sparse matrix × dense vector in CSR form (y = A·x). The canonical
// sparse-linear-algebra kernel (iterative solvers, PageRank, GNN message passing,
// FEM): the inner loop is a multiply-accumulate whose vector operand is an
// INDIRECT gather x[col[k]] through a column-index array. That data-dependent
// gather — distinct from the suite's contiguous reductions — is the access
// pattern dense codegen handles worst.
//
// Values and x are small integers, so each product and the row sum are exact in
// f64 regardless of summation order or FMA fusion — the result vector is
// bit-identical across every engine and native target (no fma parity class here).

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const ROWS: i32 = 4096
const NPR: i32 = 16
const NNZ: i32 = ROWS * NPR
const N_ITERS: i32 = 80
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

function checksumF64(out: Float64Array): u32 {
  const u = Uint32Array.wrap(out.buffer, out.byteOffset, out.length * 2)
  let h: u32 = 0x811c9dc5
  const n = u.length
  for (let i = 0; i < n; i += 256) h = (h ^ <u32>unchecked(u[i])) * 0x01000193
  return h
}

function build(rowPtr: Int32Array, colIdx: Int32Array, values: Float64Array, x: Float64Array): void {
  let s: i32 = 0x1234abcd
  // XorShift32 — operates on the bit pattern; shifts must stay i32 for wrapping
  // then cast unsigned for the >>> 0 (unsigned right shift in JS)
  for (let r: i32 = 0; r <= ROWS; r++) unchecked(rowPtr[r] = r * NPR)
  for (let k: i32 = 0; k < NNZ; k++) {
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    unchecked(colIdx[k] = <i32>(<u32>s % <u32>ROWS))
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    unchecked(values[k] = <f64>(<i32>(<u32>s % 9) - 4))
  }
  for (let i: i32 = 0; i < ROWS; i++) {
    s ^= s << 13
    s ^= <i32>(<u32>s >>> 17)
    s ^= s << 5
    unchecked(x[i] = <f64>(<i32>(<u32>s % 7) - 3))
  }
}

function spmv(rowPtr: Int32Array, colIdx: Int32Array, values: Float64Array, x: Float64Array, y: Float64Array): void {
  for (let r: i32 = 0; r < ROWS; r++) {
    let sum: f64 = 0
    const end = unchecked(rowPtr[r + 1])
    const rStart = unchecked(rowPtr[r])
    for (let k: i32 = rStart; k < end; k++) sum += unchecked(values[k]) * unchecked(x[unchecked(colIdx[k])])
    unchecked(y[r] = sum)
  }
}

function runKernel(rowPtr: Int32Array, colIdx: Int32Array, values: Float64Array, x: Float64Array, y: Float64Array): void {
  for (let it: i32 = 0; it < N_ITERS; it++) {
    spmv(rowPtr, colIdx, values, x, y)
    for (let i: i32 = 0; i < ROWS; i++) unchecked(x[i] = x[i] + 1)
  }
}

export function main(): void {
  const rowPtr = new Int32Array(ROWS + 1)
  const colIdx = new Int32Array(NNZ)
  const values = new Float64Array(NNZ)
  const x = new Float64Array(ROWS)
  const y = new Float64Array(ROWS)
  build(rowPtr, colIdx, values, x)
  for (let i = 0; i < N_WARMUP; i++) { build(rowPtr, colIdx, values, x); runKernel(rowPtr, colIdx, values, x, y) }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    build(rowPtr, colIdx, values, x)
    const t0 = perfNow()
    runKernel(rowPtr, colIdx, values, x, y)
    unchecked(samples[i] = perfNow() - t0)
  }

  const cs = checksumF64(y)
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
  logLine(<i32>(medianMs * 1000.0), cs, NNZ * N_ITERS, 2, N_RUNS)
}
