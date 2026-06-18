// heat.c — 2-D heat diffusion: an explicit-Euler 5-point Laplacian stencil, the
// canonical PDE / scientific-computing kernel. Each interior cell relaxes toward
// its 4 neighbours, updated from a second buffer (dst≠src) with a fixed border
// and no wraparound. Pure f64 +/-/* with a power-of-two coefficient — field is
// bit-identical across every engine and native target.
#include "../_lib/bench.h"
#include <stdlib.h>

#define W 258
#define H 258
#define STEPS 100
#define N_RUNS 21
#define N_WARMUP 5

static const double K = 0.125;

static void seed(double* a, int len) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < len; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    a[i] = (double)(s & 255u);
  }
}

static void step(const double* src, double* dst, int w, int h) {
  for (int y = 1; y < h - 1; y++) {
    const int row = y * w;
    for (int x = 1; x < w - 1; x++) {
      const int c = row + x;
      dst[c] = src[c] + K * (src[c - 1] + src[c + 1] + src[c - w] + src[c + w] - 4.0 * src[c]);
    }
  }
}

static void run(double* a, double* b) {
  for (int s = 0; s < STEPS; s += 2) {
    step(a, b, W, H);
    step(b, a, W, H);
  }
}

int main(void) {
  double* a = malloc(sizeof(double) * W * H);
  double* b = malloc(sizeof(double) * W * H);
  double samples[N_RUNS];

  for (int i = 0; i < N_WARMUP; i++) { seed(a, W * H); seed(b, W * H); run(a, b); }

  uint32_t cs = 0;
  for (int i = 0; i < N_RUNS; i++) {
    seed(a, W * H);
    seed(b, W * H);
    double t0 = now_ms();
    run(a, b);
    samples[i] = now_ms() - t0;
  }
  cs = checksum_f64(a, W * H);
  print_result(median_us(samples, N_RUNS), cs, (W - 2) * (H - 2) * STEPS, 6, N_RUNS);

  free(a);
  free(b);
}
