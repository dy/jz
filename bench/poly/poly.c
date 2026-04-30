#include "../_lib/bench.h"
#include <stdlib.h>

#define N 8192
#define N_ITERS 80
#define N_RUNS 21
#define N_WARMUP 5

static double sum_f64(const double* xs) {
  double s = 0;
  for (int i = 0; i < N; i++) s += xs[i];
  return s;
}

static int sum_i32(const int32_t* xs) {
  int s = 0;
  for (int i = 0; i < N; i++) s += xs[i];
  return s;
}

static void init(double* f64, int32_t* i32) {
  for (int i = 0; i < N; i++) {
    f64[i] = (double)(i % 251) * 0.25;
    i32[i] = (i * 17) & 1023;
  }
}

static uint32_t run_kernel(const double* f64, const int32_t* i32) {
  uint32_t h = 0x811c9dc5u;
  for (int i = 0; i < N_ITERS; i++) {
    h = mix_u32(h, (uint32_t)(int)sum_f64(f64));
    h = mix_u32(h, (uint32_t)sum_i32(i32));
  }
  return h;
}

int main(void) {
  double* f64 = malloc(sizeof(double) * N);
  int32_t* i32 = malloc(sizeof(int32_t) * N);
  double samples[N_RUNS];
  init(f64, i32);
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(f64, i32);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(f64, i32);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS * 2, 2, N_RUNS);
  free(f64);
  free(i32);
}
