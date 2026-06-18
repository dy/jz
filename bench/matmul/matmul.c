// matmul.c — dense matrix multiply C = A·Bᵀ, the kernel every linear-algebra and
// neural-net library lives on. B is stored transposed (Bt[j][k] = B[k][j]) so the
// inner k-loop reads row i of A and row j of Bᵀ contiguously — each output C[i][j]
// is a dot product. Small-integer data keeps every product-sum exact in f64,
// so the result is bit-identical across every engine and native target.
#include "../_lib/bench.h"
#include <stdlib.h>

#define N 256
#define N_RUNS 21
#define N_WARMUP 5

static void init(double* A, double* Bt) {
  for (int i = 0; i < N * N; i++) {
    A[i]  = (double)((i % 13) - 6);
    Bt[i] = (double)(((i * 7) % 11) - 5);
  }
}

static void matmul(const double* A, const double* Bt, double* C) {
  for (int i = 0; i < N; i++) {
    const int ai = i * N;
    for (int j = 0; j < N; j++) {
      const int bj = j * N;
      double s = 0;
      for (int k = 0; k < N; k++) s += A[ai + k] * Bt[bj + k];
      C[ai + j] = s;
    }
  }
}

int main(void) {
  double* A  = malloc(sizeof(double) * N * N);
  double* Bt = malloc(sizeof(double) * N * N);
  double* C  = malloc(sizeof(double) * N * N);
  double samples[N_RUNS];

  init(A, Bt);
  for (int i = 0; i < N_WARMUP; i++) matmul(A, Bt, C);

  uint32_t cs = 0;
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    matmul(A, Bt, C);
    samples[i] = now_ms() - t0;
  }
  cs = checksum_f64(C, N * N);
  print_result(median_us(samples, N_RUNS), cs, N * N * N, 2, N_RUNS);

  free(A);
  free(Bt);
  free(C);
}
