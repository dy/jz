#include "../_lib/bench.h"

#define N        16384
#define N_ITERS  700
#define N_RUNS   21
#define N_WARMUP 5

static const uint32_t C1 = 0xcc9e2d51u;
static const uint32_t C2 = 0x1b873593u;

static uint8_t  buf[N];
static double   samples[N_RUNS];

static void init_buf(void) {
  int32_t x = 0x12345678;
  for (int i = 0; i < N; i++) {
    x = (int32_t)((int32_t)(x * (int32_t)1103515245) + 12345);
    buf[i] = (uint8_t)(((uint32_t)x >> 16) & 0xffu);
  }
}

static uint32_t murmur3(const uint8_t* buf, int n, uint32_t seed) {
  int32_t h = (int32_t)seed;
  for (int i = 0; i + 4 <= n; i += 4) {
    int32_t k = (int32_t)((uint32_t)buf[i]
                        | ((uint32_t)buf[i+1] << 8)
                        | ((uint32_t)buf[i+2] << 16)
                        | ((uint32_t)buf[i+3] << 24));
    k = (int32_t)((uint32_t)k * C1);
    k = (int32_t)(((uint32_t)k << 15) | ((uint32_t)k >> 17));
    k = (int32_t)((uint32_t)k * C2);
    h ^= k;
    h = (int32_t)(((uint32_t)h << 13) | ((uint32_t)h >> 19));
    h = (int32_t)((uint32_t)(int32_t)((uint32_t)h * 5u) + 0xe6546b64u);
  }
  h ^= n;
  uint32_t uh = (uint32_t)h;
  uh ^= uh >> 16;
  uh = (uint32_t)(uh * 0x85ebca6bu);
  uh ^= uh >> 13;
  uh = (uint32_t)(uh * 0xc2b2ae35u);
  uh ^= uh >> 16;
  return uh;
}

static uint32_t run_kernel(void) {
  uint32_t h = 0;
  for (int it = 0; it < N_ITERS; it++) {
    uint32_t mr = murmur3(buf, N, 0x9747b28cu);
    h = mix_u32(h, (uint32_t)(int32_t)mr);
    int j = it % N;
    buf[j] = (uint8_t)((buf[j] + 1u) & 0xffu);
  }
  return h;
}

int main(void) {
  init_buf();
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel();
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel();
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS, 1, N_RUNS);
}
