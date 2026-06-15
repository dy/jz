#include "../_lib/bench.h"
#include <stdlib.h>

#define W 512
#define H 512
#define R 4
#define WIN (2 * R + 1)
#define N (W * H * 4)
#define N_RUNS 21
#define N_WARMUP 5

static void mk_image(uint8_t* out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = (uint8_t)(s & 255u);
  }
}

static void hblur(const uint8_t* src, uint8_t* dst, int w, int h, int r) {
  int win = 2 * r + 1;
  for (int y = 0; y < h; y++) {
    int row = y * w;
    for (int x = 0; x < w; x++) {
      int sr = 0, sg = 0, sb = 0, sa = 0;
      for (int k = -r; k <= r; k++) {
        int xi = x + k;
        if (xi < 0) xi = 0;
        else if (xi >= w) xi = w - 1;
        int p = (row + xi) << 2;
        sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; sa += src[p + 3];
      }
      int o = (row + x) << 2;
      dst[o] = (uint8_t)(sr / win);
      dst[o + 1] = (uint8_t)(sg / win);
      dst[o + 2] = (uint8_t)(sb / win);
      dst[o + 3] = (uint8_t)(sa / win);
    }
  }
}

static void vblur(const uint8_t* src, uint8_t* dst, int w, int h, int r) {
  int win = 2 * r + 1;
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      int sr = 0, sg = 0, sb = 0, sa = 0;
      for (int k = -r; k <= r; k++) {
        int yi = y + k;
        if (yi < 0) yi = 0;
        else if (yi >= h) yi = h - 1;
        int p = (yi * w + x) << 2;
        sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; sa += src[p + 3];
      }
      int o = (y * w + x) << 2;
      dst[o] = (uint8_t)(sr / win);
      dst[o + 1] = (uint8_t)(sg / win);
      dst[o + 2] = (uint8_t)(sb / win);
      dst[o + 3] = (uint8_t)(sa / win);
    }
  }
}

int main(void) {
  uint8_t* img = malloc(N);
  uint8_t* tmp = malloc(N);
  uint8_t* out = malloc(N);
  double samples[N_RUNS];
  mk_image(img, N);
  for (int i = 0; i < N_WARMUP; i++) { hblur(img, tmp, W, H, R); vblur(tmp, out, W, H, R); }
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    hblur(img, tmp, W, H, R);
    vblur(tmp, out, W, H, R);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_u8(out, N), W * H, WIN, N_RUNS);
  free(img); free(tmp); free(out);
}
