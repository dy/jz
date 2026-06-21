#include "../_lib/bench.h"

#define N        4096
#define WINDOW   1024
#define MIN_MATCH 3
#define MAX_MATCH 18
#define CAP      (N * 2 + 64)
#define N_ITERS  5
#define N_RUNS   21
#define N_WARMUP 5

static uint8_t src[N];
static uint8_t comp[CAP];
static uint8_t dec[N];
static double  samples[N_RUNS];

static void init_buf(void) {
  int32_t x = 0x12345678;
  for (int i = 0; i < N; i++) {
    x = (int32_t)((int32_t)(x * 1103515245) + 12345);
    if (i > 64 && ((x & 0x70) == 0)) src[i] = src[i - 1 - ((uint32_t)x >> 8 & 63)];
    else src[i] = (uint8_t)(((uint32_t)x >> 16) & 0xff);
  }
}

static int compress(const uint8_t* s, int n, uint8_t* out) {
  int op = 0, ip = 0;
  while (ip < n) {
    int ctrl_pos = op++;
    uint8_t ctrl = 0;
    for (int b = 0; b < 8 && ip < n; b++) {
      int start = ip - WINDOW;
      if (start < 0) start = 0;
      int max_len = n - ip;
      if (max_len > MAX_MATCH) max_len = MAX_MATCH;
      int best_len = 0, best_dist = 0;
      for (int j = ip - 1; j >= start; j--) {
        int len = 0;
        while (len < max_len && s[j + len] == s[ip + len]) len++;
        if (len > best_len) {
          best_len = len;
          best_dist = ip - j;
          if (len >= max_len) break;
        }
      }
      if (best_len >= MIN_MATCH) {
        ctrl |= (uint8_t)(1 << b);
        uint32_t code = (uint32_t)((best_dist - 1) << 4) | (uint32_t)(best_len - MIN_MATCH);
        out[op]     = (uint8_t)((code >> 8) & 0xff);
        out[op + 1] = (uint8_t)(code & 0xff);
        op += 2;
        ip += best_len;
      } else {
        out[op++] = s[ip++];
      }
    }
    out[ctrl_pos] = ctrl;
  }
  return op;
}

static int inflate(const uint8_t* inp, int clen, uint8_t* dst) {
  int ip = 0, op = 0;
  while (ip < clen) {
    uint8_t ctrl = inp[ip++];
    for (int b = 0; b < 8 && ip < clen; b++) {
      if (ctrl & (1 << b)) {
        uint32_t code = ((uint32_t)inp[ip] << 8) | inp[ip + 1];
        ip += 2;
        int dist = (int)(code >> 4) + 1;
        int len  = (int)(code & 0x0f) + MIN_MATCH;
        for (int k = 0; k < len; k++) { dst[op] = dst[op - dist]; op++; }
      } else {
        dst[op++] = inp[ip++];
      }
    }
  }
  return op;
}

static uint32_t run_kernel(void) {
  uint32_t h = 0;
  for (int it = 0; it < N_ITERS; it++) {
    int clen = compress(src, N, comp);
    int dlen = inflate(comp, clen, dec);
    int ok = (dlen == N) ? 1 : 0;
    for (int i = 0; i < N; i++) if (dec[i] != src[i]) ok = 0;
    h = mix_u32(h, (uint32_t)clen);
    for (int i = 0; i < clen; i++) h = mix_u32(h, comp[i]);
    h = mix_u32(h, (uint32_t)ok);
    int j = it % N;
    src[j] = (uint8_t)((src[j] + 1) & 0xff);
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
