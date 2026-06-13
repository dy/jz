// dotprod.c — multiply-accumulate (dot-product) reductions: the fundamental
// DSP/numeric kernel (correlation, energy, projection, FIR tap-sum). The
// accumulator `s += a[i]*b[i]` is a latency-bound dependency chain — exactly
// where multi-accumulator vectorization (independent partial sums combined at
// the end) earns its keep.
#include "../_lib/bench.h"
#include <stdlib.h>

#define N 8192
#define N_ITERS 200
#define N_RUNS 21
#define N_WARMUP 5

static double dot(const double* a, const double* b) {
  double s = 0;
  for (int i = 0; i < N; i++) s += a[i] * b[i];
  return s;
}

static void init(double* a, double* b) {
  for (int i = 0; i < N; i++) {
    a[i] = (double)((i % 13) - 6);
    b[i] = (double)(((i * 7) % 11) - 5);
  }
}

static uint32_t run_kernel(const double* a, const double* b) {
  uint32_t h = 0x811c9dc5u;
  for (int i = 0; i < N_ITERS; i++) {
    h = mix_u32(h, (uint32_t)(int32_t)dot(a, b));
  }
  return h;
}

int main(void) {
  double* a = malloc(sizeof(double) * N);
  double* b = malloc(sizeof(double) * N);
  double samples[N_RUNS];
  init(a, b);
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(a, b);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(a, b);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS, 2, N_RUNS);
  free(a);
  free(b);
}
