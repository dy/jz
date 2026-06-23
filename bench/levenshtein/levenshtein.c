// levenshtein.c — Levenshtein edit distance via the rolling-row dynamic program.
// The canonical sequence-alignment / fuzzy-match kernel (spell-check, diff,
// bioinformatics, search): a 2-D DP whose every cell is min(delete, insert,
// substitute) over integers, with a diagonal data dependency that no target can
// vectorize — a branch- and min-reduction-heavy access pattern distinct from the
// suite's other loops. Pure 32-bit integer, so the distance is bit-identical
// across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in DP-cells/µs, FNV-1a checksum
// over the per-iteration distances.
#include "../_lib/bench.h"
#include <stdlib.h>

#define LA 512
#define LB 512
#define ALPHA 8
#define N_ITERS 8
#define N_RUNS 21
#define N_WARMUP 5

static void fill(uint8_t* out, int n, uint32_t seed) {
  uint32_t s = seed;
  for (int i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = (uint8_t)(s % ALPHA);
  }
}

static int levenshtein(const uint8_t* a, const uint8_t* b, int32_t* prev) {
  for (int j = 0; j <= LB; j++) prev[j] = j;
  for (int i = 1; i <= LA; i++) {
    int32_t diag = prev[0];
    prev[0] = i;
    uint8_t ai = a[i - 1];
    for (int j = 1; j <= LB; j++) {
      int32_t up = prev[j];
      int32_t sub = diag + (ai == b[j - 1] ? 0 : 1);
      int32_t m = up + 1;
      int32_t ins = prev[j - 1] + 1;
      if (ins < m) m = ins;
      if (sub < m) m = sub;
      diag = up;
      prev[j] = m;
    }
  }
  return prev[LB];
}

static uint32_t run_kernel(uint8_t* a, const uint8_t* b, int32_t* prev) {
  uint32_t h = 0x811c9dc5u;
  for (int it = 0; it < N_ITERS; it++) {
    int j = it % LA;
    a[j] = (uint8_t)((a[j] + 1) % ALPHA);
    h = mix_u32(h, (uint32_t)levenshtein(a, b, prev));
  }
  return h;
}

int main(void) {
  uint8_t* a = malloc(sizeof(uint8_t) * LA);
  uint8_t* b = malloc(sizeof(uint8_t) * LB);
  int32_t* prev = malloc(sizeof(int32_t) * (LB + 1));
  fill(a, LA, 0x1234abcdu);
  fill(b, LB, 0x9e3779b9u);
  double samples[N_RUNS];
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(a, b, prev);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(a, b, prev);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, LA * LB * N_ITERS, 2, N_RUNS);
  free(a);
  free(b);
  free(prev);
}
