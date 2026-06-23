// spmv.c — sparse matrix × dense vector in CSR form (y = A·x). The canonical
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
#include "../_lib/bench.h"
#include <stdlib.h>

#define ROWS    4096
#define NPR     16
#define NNZ     (ROWS * NPR)
#define N_ITERS 80
#define N_RUNS  21
#define N_WARMUP 5

static void build(int32_t* rowPtr, int32_t* colIdx, double* values, double* x) {
  uint32_t s = 0x1234abcdu;
  /* next() — XorShift32, returns s >>> 0 (unsigned) */
#define NEXT() (s ^= s << 13, s ^= s >> 17, s ^= s << 5, s)
  for (int r = 0; r <= ROWS; r++) rowPtr[r] = r * NPR;
  for (int k = 0; k < NNZ; k++) {
    colIdx[k] = (int32_t)(NEXT() % ROWS);
    values[k] = (double)((int32_t)(NEXT() % 9) - 4);
  }
  for (int i = 0; i < ROWS; i++) x[i] = (double)((int32_t)(NEXT() % 7) - 3);
#undef NEXT
}

static void spmv(const int32_t* rowPtr, const int32_t* colIdx,
                 const double* values, const double* x, double* y) {
  for (int r = 0; r < ROWS; r++) {
    double sum = 0.0;
    int end = rowPtr[r + 1];
    for (int k = rowPtr[r]; k < end; k++) sum += values[k] * x[colIdx[k]];
    y[r] = sum;
  }
}

static void run_kernel(int32_t* rowPtr, int32_t* colIdx,
                       double* values, double* x, double* y) {
  for (int it = 0; it < N_ITERS; it++) {
    spmv(rowPtr, colIdx, values, x, y);
    for (int i = 0; i < ROWS; i++) x[i] = x[i] + 1.0;
  }
}

int main(void) {
  int32_t* rowPtr = malloc(sizeof(int32_t) * (ROWS + 1));
  int32_t* colIdx = malloc(sizeof(int32_t) * NNZ);
  double*  values = malloc(sizeof(double)  * NNZ);
  double*  x      = malloc(sizeof(double)  * ROWS);
  double*  y      = malloc(sizeof(double)  * ROWS);
  double   samples[N_RUNS];

  build(rowPtr, colIdx, values, x);
  for (int i = 0; i < N_WARMUP; i++) {
    build(rowPtr, colIdx, values, x);
    run_kernel(rowPtr, colIdx, values, x, y);
  }

  uint32_t cs = 0;
  for (int i = 0; i < N_RUNS; i++) {
    build(rowPtr, colIdx, values, x);
    double t0 = now_ms();
    run_kernel(rowPtr, colIdx, values, x, y);
    samples[i] = now_ms() - t0;
  }
  cs = checksum_f64(y, ROWS);
  print_result(median_us(samples, N_RUNS), cs, NNZ * N_ITERS, 2, N_RUNS);

  free(rowPtr); free(colIdx); free(values); free(x); free(y);
}
