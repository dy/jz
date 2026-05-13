#include "../_lib/bench.h"

#define N 8192
#define N_ITERS 24
#define N_RUNS 21
#define N_WARMUP 5

static double src[N];
static double a[N];
static double samples[N_RUNS];

static void fill(double *xs) {
  uint32_t s = 0x9e3779b9u;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    xs[i] = (double)s / 4294967296.0;
  }
}

static void heapsort(double *xs) {
  for (int root = (N >> 1) - 1; root >= 0; root--) {
    int i = root;
    int child = 2 * i + 1;
    while (child < N) {
      if (child + 1 < N && xs[child] < xs[child + 1]) child++;
      if (xs[i] >= xs[child]) break;
      double t = xs[i]; xs[i] = xs[child]; xs[child] = t;
      i = child;
      child = 2 * i + 1;
    }
  }
  for (int end = N - 1; end > 0; end--) {
    double t = xs[0]; xs[0] = xs[end]; xs[end] = t;
    int i = 0;
    int child = 1;
    while (child < end) {
      if (child + 1 < end && xs[child] < xs[child + 1]) child++;
      if (xs[i] >= xs[child]) break;
      double u = xs[i]; xs[i] = xs[child]; xs[child] = u;
      i = child;
      child = 2 * i + 1;
    }
  }
}

static void run_kernel(void) {
  for (int it = 0; it < N_ITERS; it++) {
    double f = (double)it;
    for (int i = 0; i < N; i++) a[i] = src[i] + f;
    heapsort(a);
  }
}

int main(void) {
  fill(src);
  for (int i = 0; i < N_WARMUP; i++) run_kernel();
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run_kernel();
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64(a, N), N * N_ITERS, 2, N_RUNS);
}
