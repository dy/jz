// spmv.js — sparse matrix × dense vector in CSR form (y = A·x). The canonical
// sparse-linear-algebra kernel (iterative solvers, PageRank, GNN message passing,
// FEM): the inner loop is a multiply-accumulate whose vector operand is an
// INDIRECT gather x[col[k]] through a column-index array. That data-dependent
// gather — distinct from the suite's contiguous reductions — is the access
// pattern dense codegen handles worst.
//
// Values and x are small integers, so each product and the row sum are exact in
// f64 regardless of summation order or FMA fusion — the result vector is
// bit-identical across every engine and native target (no fma parity class here).
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in nonzeros/µs, FNV-1a checksum
// over the result vector.

import { medianUs, checksumF64, printResult } from '../_lib/benchlib.js'

const ROWS = 4096
const NPR = 16               // nonzeros per row
const NNZ = ROWS * NPR
const N_ITERS = 80           // SpMV passes per kernel run
const N_RUNS = 21
const N_WARMUP = 5

// Build a deterministic CSR matrix (fixed nonzeros/row) + dense x, all from a
// XorShift32 stream so every target gets the identical structure and integer
// values. rowPtr is the regular [0, NPR, 2·NPR, …] partition.
const build = (rowPtr, colIdx, values, x) => {
  let s = 0x1234abcd | 0
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0 }
  for (let r = 0; r <= ROWS; r++) rowPtr[r] = r * NPR
  for (let k = 0; k < NNZ; k++) {
    colIdx[k] = next() % ROWS
    values[k] = (next() % 9) - 4          // small int in [-4, 4]
  }
  for (let i = 0; i < ROWS; i++) x[i] = (next() % 7) - 3   // small int in [-3, 3]
}

const spmv = (rowPtr, colIdx, values, x, y) => {
  for (let r = 0; r < ROWS; r++) {
    let sum = 0
    const end = rowPtr[r + 1]
    for (let k = rowPtr[r]; k < end; k++) sum += values[k] * x[colIdx[k]]
    y[r] = sum
  }
}

const runKernel = (rowPtr, colIdx, values, x, y) => {
  for (let it = 0; it < N_ITERS; it++) {
    spmv(rowPtr, colIdx, values, x, y)
    for (let i = 0; i < ROWS; i++) x[i] = x[i] + 1   // bounded integer drift → each pass distinct, all products stay exact
  }
}

export let main = () => {
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
    const t0 = performance.now()
    runKernel(rowPtr, colIdx, values, x, y)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(y), NNZ * N_ITERS, 2, N_RUNS)
}
