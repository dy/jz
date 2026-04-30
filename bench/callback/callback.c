#include "../_lib/bench.h"
#include <stdlib.h>

#define N 4096
#define N_ITERS 128
#define N_RUNS 21
#define N_WARMUP 5

static void init(double* a) {
  for (int i = 0; i < N; i++) a[i] = (double)((i % 97) - 48);
}

static uint32_t run_kernel(const double* a, double* b, double scale) {
  uint32_t h = 0x811c9dc5u;
  for (int i = 0; i < N_ITERS; i++) {
    for (int j = 0; j < N; j++) b[j] = a[j] * scale + i;
    for (int j = 0; j < N; j += 64) h = mix_u32(h, (uint32_t)(int)b[j]);
  }
  return h;
}

int main(void) {
  double* a = malloc(sizeof(double) * N);
  double* b = malloc(sizeof(double) * N);
  double samples[N_RUNS];
  init(a);
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(a, b, 2);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(a, b, 2);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS, 1, N_RUNS);
  free(a);
  free(b);
}
