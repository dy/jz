#include "../_lib/bench.h"
#include <stdlib.h>

#define N 16384
#define N_ITERS 64
#define N_RUNS 21
#define N_WARMUP 5

typedef struct {
  double x;
  double y;
  double z;
} Row;

static void init_rows(Row* rows) {
  for (int i = 0; i < N; i++) {
    rows[i].x = (double)i * 0.5;
    rows[i].y = (double)i + 1.0;
    rows[i].z = (double)((i & 7) - 3);
  }
}

static void run_kernel(const Row* rows, double* xs, double* ys, double* zs) {
  for (int r = 0; r < N_ITERS; r++) {
    for (int i = 0; i < N; i++) {
      Row p = rows[i];
      xs[i] = p.x + p.y * 0.25 + r;
      ys[i] = p.y - p.z * 0.5;
      zs[i] = p.z + p.x * 0.125;
    }
  }
}

int main(void) {
  Row* rows = malloc(sizeof(Row) * N);
  double* xs = malloc(sizeof(double) * N);
  double* ys = malloc(sizeof(double) * N);
  double* zs = malloc(sizeof(double) * N);
  double samples[N_RUNS];
  init_rows(rows);
  for (int i = 0; i < N_WARMUP; i++) run_kernel(rows, xs, ys, zs);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run_kernel(rows, xs, ys, zs);
    samples[i] = now_ms() - t0;
  }
  uint32_t cs = checksum_f64(xs, N) ^ checksum_f64(ys, N) ^ checksum_f64(zs, N);
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS, 3, N_RUNS);
  free(rows);
  free(xs);
  free(ys);
  free(zs);
}
