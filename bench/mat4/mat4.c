#include "../_lib/bench.h"

#define N_ITERS 200000
#define N_RUNS 21
#define N_WARMUP 5

static void init(double* a, double* b) {
  for (int i = 0; i < 16; i++) {
    a[i] = (double)(i + 1) * 0.125;
    b[i] = (double)(16 - i) * 0.0625;
  }
}

static void multiply_many(double* a, const double* b, double* out, int iters) {
  for (int n = 0; n < iters; n++) {
    for (int r = 0; r < 4; r++) {
      for (int c = 0; c < 4; c++) {
        double s = 0;
        for (int k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
        out[r * 4 + c] = s + (double)n * 0.0000001;
      }
    }
    double t = a[0];
    a[0] = out[15];
    a[5] = t + out[10] * 0.000001;
  }
}

int main(void) {
  double a[16], b[16], out[16], samples[N_RUNS];
  init(a, b);
  for (int i = 0; i < N_WARMUP; i++) multiply_many(a, b, out, N_ITERS);
  for (int i = 0; i < N_RUNS; i++) {
    init(a, b);
    double t0 = now_ms();
    multiply_many(a, b, out, N_ITERS);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64(out, 16), N_ITERS * 16, 4, N_RUNS);
}
