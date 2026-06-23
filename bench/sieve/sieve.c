// sieve.c — Sieve of Eratosthenes over a byte array up to LIMIT. The canonical
// number-theory / enumeration kernel: for each prime, a strided inner loop writes
// a composite flag at i², i²+i, i²+2i, … The access pattern is pure strided
// scatter guarded by an outer branch (skip already-composite i), a memory profile
// distinct from the suite's dense contiguous loops. Pure integer, so the sieved
// bitmap is bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in numbers/µs, FNV-1a checksum over
// the composite bitmap.
#include "../_lib/bench.h"
#include <stdlib.h>

#define LIMIT    (1 << 20)
#define N_ITERS  6
#define N_RUNS   21
#define N_WARMUP 5

static void sieve(uint8_t* comp) {
  for (int i = 0; i < LIMIT; i++) comp[i] = 0;
  comp[0] = 1;
  comp[1] = 1;
  for (int i = 2; (long)i * i < LIMIT; i++) {
    if (comp[i] == 0) {
      for (int j = i * i; j < LIMIT; j += i) comp[j] = 1;
    }
  }
}

static void run_kernel(uint8_t* comp) {
  for (int it = 0; it < N_ITERS; it++) sieve(comp);
}

int main(void) {
  uint8_t* comp = malloc(LIMIT);
  double samples[N_RUNS];

  for (int i = 0; i < N_WARMUP; i++) run_kernel(comp);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run_kernel(comp);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_u8(comp, LIMIT), LIMIT * N_ITERS, 1, N_RUNS);
  free(comp);
  return 0;
}
