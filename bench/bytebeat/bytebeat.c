#include "../_lib/bench.h"
#include <stdlib.h>

#define N (1 << 21)
#define N_RUNS 21
#define N_WARMUP 5

static uint32_t sample(uint32_t t) {
  uint32_t v1 = (t * 5u & t >> 7) | (t * 3u & t >> 10);
  uint32_t v2 = t * (((t >> 12) | (t >> 8)) & (63u & (t >> 4)));
  return (v1 + v2) & 255u;
}

static void render(uint8_t* buf, int n) {
  for (int t = 0; t < n; t++) buf[t] = (uint8_t)sample((uint32_t)t);
}

int main(void) {
  uint8_t* buf = malloc(N);
  double samples[N_RUNS];
  for (int i = 0; i < N_WARMUP; i++) render(buf, N);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    render(buf, N);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_u8(buf, N), N, 1, N_RUNS);
  free(buf);
}
