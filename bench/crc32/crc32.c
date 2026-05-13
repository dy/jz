#include "../_lib/bench.h"

#define N 16384
#define N_ITERS 220
#define N_RUNS 21
#define N_WARMUP 5

static uint8_t buf[N];
static uint32_t table[256];
static double samples[N_RUNS];

static void build_table(void) {
  for (uint32_t n = 0; n < 256; n++) {
    uint32_t c = n;
    for (int k = 0; k < 8; k++) c = (c & 1u) ? (0xedb88320u ^ (c >> 1)) : (c >> 1);
    table[n] = c;
  }
}

static void init_buf(void) {
  uint32_t x = 0x12345678u;
  for (int i = 0; i < N; i++) {
    x = x * 1103515245u + 12345u;
    buf[i] = (uint8_t)((x >> 16) & 0xffu);
  }
}

static uint32_t crc32_kernel(void) {
  uint32_t c = 0xffffffffu;
  for (int i = 0; i < N; i++) c = table[(c ^ buf[i]) & 0xffu] ^ (c >> 8);
  return c ^ 0xffffffffu;
}

static uint32_t run_kernel(void) {
  uint32_t h = 0;
  for (int it = 0; it < N_ITERS; it++) {
    h = mix_u32(h, crc32_kernel());
    int j = it % N;
    buf[j] = (uint8_t)((buf[j] + 1u) & 0xffu);
  }
  return h;
}

int main(void) {
  build_table();
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
