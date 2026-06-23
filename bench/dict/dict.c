// dict.c — open-addressing hash table (build + probe) with linear probing. The
// canonical associative-container kernel (symbol tables, dedup, joins, counting):
// a multiply-shift hash scatters keys across a power-of-two slot array, and every
// insert/lookup walks a probe chain of branchy comparisons. It stresses
// scatter writes, dependent-load gather, and unpredictable branches — the
// hash-table shape no other case in the suite covers. Pure 32-bit integer, so the
// looked-up values are bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Int32Array, Math.imul, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in ops/µs, FNV-1a checksum over
// the probe results.
#include "../_lib/bench.h"
#include <stdlib.h>

#define CAP      (1 << 14)       // slot count (power of two)
#define MASK     (CAP - 1)
#define NKEYS    (CAP >> 1)      // 8192 keys → load factor 0.5
#define EMPTY    (-1)            // sentinel; keys are forced non-negative so never collide
#define N_ITERS  60              // build+probe passes per kernel run
#define N_RUNS   21
#define N_WARMUP 5

static int32_t  keys[CAP];
static int32_t  vals[CAP];
static int32_t  src[NKEYS];
static double   samples[N_RUNS];

// Deterministic positive keys — XorShift32 masked to 31 bits, identical per target.
static void fill(int32_t* out) {
  int32_t s = (int32_t)0x1234abcd;
  for (int i = 0; i < NKEYS; i++) {
    s ^= s << 13;
    s ^= (int32_t)((uint32_t)s >> 17);
    s ^= s << 5;
    out[i] = (int32_t)((uint32_t)s & 0x7fffffffu);
  }
}

static int32_t hash_key(int32_t k) {
  return (int32_t)(((uint32_t)(int32_t)((uint32_t)k * 0x9e3779b1u)) & (uint32_t)MASK);
}

static void insert(int32_t* ks, int32_t* vs, int32_t k, int32_t v) {
  int32_t h = hash_key(k);
  while (ks[h] != EMPTY) {
    if (ks[h] == k) { vs[h] = v; return; }
    h = (h + 1) & MASK;
  }
  ks[h] = k;
  vs[h] = v;
}

static int32_t lookup(const int32_t* ks, const int32_t* vs, int32_t k) {
  int32_t h = hash_key(k);
  while (ks[h] != EMPTY) {
    if (ks[h] == k) return vs[h];
    h = (h + 1) & MASK;
  }
  return -1;
}

static uint32_t run_kernel(int32_t* ks, int32_t* vs, const int32_t* sr) {
  uint32_t h = 0x811c9dc5u;
  for (int it = 0; it < N_ITERS; it++) {
    for (int i = 0; i < CAP; i++) ks[i] = EMPTY;
    for (int i = 0; i < NKEYS; i++) insert(ks, vs, sr[i], (int32_t)((uint32_t)(sr[i] + it)));
    for (int i = 0; i < NKEYS; i++) {
      int32_t v = lookup(ks, vs, sr[(i * 7) & (NKEYS - 1)]);
      h = mix_u32(h, (uint32_t)v);
    }
  }
  return h;
}

int main(void) {
  fill(src);
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(keys, vals, src);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(keys, vals, src);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, NKEYS * N_ITERS, 2, N_RUNS);
}
