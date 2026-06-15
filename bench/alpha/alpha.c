/* alpha.c — alpha compositing (constant-opacity blend) of two RGBA8 images.
 * Bit-identical to alpha.js: same XorShift32 seeds, same fixed-point blend
 * out = (src*A + dst*(255-A) + 127) >> 8, same FNV-1a-over-bytes checksum. */
#include "../_lib/bench.h"
#include <stdlib.h>

#define W 512
#define H 512
#define N (W * H * 4)
#define A 160
#define IA (255 - A)
#define N_RUNS 21
#define N_WARMUP 5

static void mk_image(uint8_t* out, int n, uint32_t seed) {
  uint32_t s = seed;
  for (int i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    out[i] = (uint8_t)(s & 255u);
  }
}

static void blend(const uint8_t* src, const uint8_t* dst, uint8_t* out, int n) {
  for (int i = 0; i < n; i++)
    out[i] = (uint8_t)((src[i] * A + dst[i] * IA + 127) >> 8);
}

int main(void) {
  uint8_t* src = malloc(N);
  uint8_t* dst = malloc(N);
  uint8_t* out = malloc(N);
  double samples[N_RUNS];
  mk_image(src, N, 0x1234abcdu);
  mk_image(dst, N, 0x7e1f93b5u);
  for (int i = 0; i < N_WARMUP; i++) blend(src, dst, out, N);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    blend(src, dst, out, N);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_u8(out, N), N, 1, N_RUNS);
  free(src); free(dst); free(out);
  return 0;
}
