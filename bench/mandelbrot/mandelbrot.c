#include "../_lib/bench.h"
#include <stdlib.h>

#define W 256
#define H 256
#define MAX_ITER 256
#define N_RUNS 21
#define N_WARMUP 5

#define X0 -2.0
#define X1 0.5
#define Y0 -1.25
#define Y1 1.25

static void render(uint32_t* out) {
  double dx = (X1 - X0) / (double)W;
  double dy = (Y1 - Y0) / (double)H;
  for (int py = 0; py < H; py++) {
    double cy = Y0 + (double)py * dy;
    for (int px = 0; px < W; px++) {
      double cx = X0 + (double)px * dx;
      double zx = 0, zy = 0;
      int i = 0;
      while (i < MAX_ITER) {
        double x2 = zx * zx;
        double y2 = zy * zy;
        if (x2 + y2 > 4.0) break;
        zy = 2.0 * zx * zy + cy;
        zx = x2 - y2 + cx;
        i++;
      }
      out[py * W + px] = (uint32_t)i;
    }
  }
}

int main(void) {
  uint32_t* out = malloc(sizeof(uint32_t) * W * H);
  double samples[N_RUNS];
  for (int i = 0; i < N_WARMUP; i++) render(out);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    render(out);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_u32(out, W * H), W * H, MAX_ITER, N_RUNS);
  free(out);
}
