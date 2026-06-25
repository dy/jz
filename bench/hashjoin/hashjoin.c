// hashjoin.c — probe-dominated relational hash join (build a hash table on a small
// "build" relation, then stream a large "probe" relation through it and sum matched
// payloads). The kernel at the heart of every database and dataframe engine. The
// open-addressing probe reads the same slot twice per step (guard then match test);
// a register allocator keeps that load in a register. Pure 32-bit integer — the
// matched-payload sum is bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in probes/µs, FNV-1a checksum over
// the per-pass match sums.
#include "../_lib/bench.h"

#define CAP      (1 << 14)       // slot count (power of two)
#define MASK     (CAP - 1)
#define BUILD    (CAP >> 1)      // 8192 build rows → load factor 0.5
#define PROBE    (1 << 16)       // 65536 probe rows — probe-dominated
#define EMPTY    (-1)            // sentinel; keys forced non-negative so never collide
#define N_ITERS  24              // build+probe passes per kernel run
#define N_RUNS   21
#define N_WARMUP 5

static int32_t keys[CAP];
static int32_t vals[CAP];
static int32_t build[BUILD];
static int32_t probes[PROBE];
static double  samples[N_RUNS];

// Deterministic positive keys — XorShift32 masked to 31 bits, identical per target.
static void fill(int32_t* out, int n, int32_t seed) {
  int32_t s = seed;
  for (int i = 0; i < n; i++) {
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

static int32_t probe_key(const int32_t* ks, const int32_t* vs, int32_t k) {
  int32_t h = hash_key(k);
  while (ks[h] != EMPTY) {
    if (ks[h] == k) return vs[h];
    h = (h + 1) & MASK;
  }
  return 0;
}

static uint32_t run_kernel(int32_t* ks, int32_t* vs, const int32_t* bd, const int32_t* pr) {
  uint32_t h = 0x811c9dc5u;
  for (int it = 0; it < N_ITERS; it++) {
    for (int i = 0; i < CAP; i++) ks[i] = EMPTY;
    for (int i = 0; i < BUILD; i++) insert(ks, vs, bd[i], (int32_t)((uint32_t)(bd[i] + it)));
    int32_t sum = 0;
    for (int i = 0; i < PROBE; i++) sum = (int32_t)((uint32_t)sum + (uint32_t)probe_key(ks, vs, pr[i]));
    h = mix_u32(h, (uint32_t)sum);
  }
  return h;
}

int main(void) {
  fill(build, BUILD, (int32_t)0x1234abcd);
  fill(probes, PROBE, (int32_t)0x9e3779b9);
  for (int i = 0; i < PROBE; i += 2) probes[i] = build[(i >> 1) & (BUILD - 1)];

  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(keys, vals, build, probes);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(keys, vals, build, probes);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, PROBE * N_ITERS, 2, N_RUNS);
}
