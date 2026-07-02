// wordcount.c — token-frequency counting into a string-keyed hash map, over a
// skewed synthetic word stream. The canonical associative text kernel (word
// counts, tag/label histograms, group-by aggregation). C's idiomatic answer is
// an open-addressing table hashing the key bytes (FNV-1a) with strcmp probes —
// the static reference for what the dynamic-keyed JS object costs. Counts are
// exact integers, so the probed totals are bit-identical across every engine
// and native target.
//
// Reports: median ms across N_RUNS, throughput in tokens/µs, FNV-1a checksum
// over the probed counts.
#include "../_lib/bench.h"
#include <string.h>

#define NWORDS   512             // distinct words in the vocabulary
#define N        (1 << 14)       // tokens per pass
#define NPROBES  64              // fixed lookups folded into the checksum
#define N_ITERS  16              // passes per kernel run
#define N_RUNS   21
#define N_WARMUP 5
#define CAP      2048            // hash slots (power of two)
#define MASK     (CAP - 1)

static char     words[NWORDS][9];
static int32_t  toks[N];
static char     probes[NPROBES][9];
static const char* slot_key[CAP];
static int32_t  slot_cnt[CAP];
static double   samples[N_RUNS];

// Deterministic vocabulary — 512 words of 3–8 lowercase chars from XorShift32,
// identical per target.
static void build_words(void) {
  int32_t s = (int32_t)0x1234abcd;
  for (int i = 0; i < NWORDS; i++) {
    s ^= s << 13;
    s ^= (int32_t)((uint32_t)s >> 17);
    s ^= s << 5;
    int len = 3 + (int)(((uint32_t)s >> 8) % 6u);
    int32_t x = s;
    for (int j = 0; j < len; j++) {
      x = (int32_t)((uint32_t)x * 0x9e3779b1u + (uint32_t)j);
      words[i][j] = (char)(97 + (int)(((uint32_t)x >> 16) % 26u));
    }
    words[i][len] = 0;
  }
}

// Skewed token stream — half the traffic hits 16 hot words (Zipf-ish),
// the rest spreads over the whole vocabulary.
static void fill_tokens(void) {
  int32_t s = (int32_t)0x2545f491;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= (int32_t)((uint32_t)s >> 17);
    s ^= s << 5;
    toks[i] = (s & 8) == 0 ? (int32_t)(((uint32_t)s >> 4) & 15u) : (int32_t)(((uint32_t)s >> 4) & (NWORDS - 1));
  }
}

static uint32_t str_hash(const char* w) {
  uint32_t h = 0x811c9dc5u;
  for (; *w; w++) h = (h ^ (uint32_t)(uint8_t)*w) * 0x01000193u;
  return h;
}

static void bump(const char* w) {
  uint32_t h = str_hash(w) & MASK;
  while (slot_key[h]) {
    if (strcmp(slot_key[h], w) == 0) { slot_cnt[h]++; return; }
    h = (h + 1) & MASK;
  }
  slot_key[h] = w;
  slot_cnt[h] = 1;
}

static int32_t get(const char* w) {
  uint32_t h = str_hash(w) & MASK;
  while (slot_key[h]) {
    if (strcmp(slot_key[h], w) == 0) return slot_cnt[h];
    h = (h + 1) & MASK;
  }
  return 0;
}

static uint32_t run_kernel(void) {
  uint32_t h = 0x811c9dc5u;
  for (int it = 0; it < N_ITERS; it++) {
    memset(slot_key, 0, sizeof(slot_key));           // fresh map per pass
    for (int i = 0; i < N; i++) bump(words[toks[i]]);
    for (int j = 0; j < NPROBES; j++) h = mix_u32(h, (uint32_t)get(probes[j]));
  }
  return h;
}

int main(void) {
  build_words();
  fill_tokens();
  // Probe every 8th word plus 8 absent keys — a missing count reads 0.
  for (int j = 0; j < NPROBES - 8; j++) strcpy(probes[j], words[(j * 8) & (NWORDS - 1)]);
  for (int j = 0; j < 8; j++) { probes[NPROBES - 8 + j][0] = 'z'; probes[NPROBES - 8 + j][1] = 'z'; probes[NPROBES - 8 + j][2] = (char)('0' + j); probes[NPROBES - 8 + j][3] = 0; }

  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel();
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel();
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS, NWORDS, N_RUNS);
}
