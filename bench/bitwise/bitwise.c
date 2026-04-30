#include "../_lib/bench.h"
#include <stdlib.h>

#define N 65536
#define N_ROUNDS 128
#define N_RUNS 21
#define N_WARMUP 5

static void init(uint32_t* state) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    state[i] = s;
  }
}

static void run_kernel(uint32_t* state) {
  for (int r = 0; r < N_ROUNDS; r++) {
    for (int i = 0; i < N; i++) {
      uint32_t x = state[i];
      x ^= x << 7;
      x ^= x >> 9;
      x = x * 1103515245u + 12345u;
      state[i] = x ^ (x >> 16);
    }
  }
}

int main(void) {
  uint32_t* state = malloc(sizeof(uint32_t) * N);
  double samples[N_RUNS];
  init(state);
  for (int i = 0; i < N_WARMUP; i++) { init(state); run_kernel(state); }
  for (int i = 0; i < N_RUNS; i++) {
    init(state);
    double t0 = now_ms();
    run_kernel(state);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_u32(state, N), N * N_ROUNDS, 3, N_RUNS);
  free(state);
}
