// setops.c – near-duplicate detection over tokenized documents with sets:
// each document becomes a set of its words minus the stop words, every word
// joins a vocabulary union, and each document is compared with the eight that
// follow it (intersection by probing the larger set with the smaller one's
// words, union by inclusion-exclusion, Jaccard in thousandths); duplicates pay
// for a set difference both ways (copy a set, delete the other's words).
//
// C has no standard set, so the program carries the one a C programmer writes
// for it: open addressing with linear probing over a power-of-two slot array
// that doubles rather than fill past half, FNV-1a over the key bytes, each slot
// caching its key's hash and length so a probe compares bytes only on a hash
// match. A deletion leaves a tombstone, an insert takes the first tombstone on
// its path, and once live and dead slots would pass half the table is rebuilt
// without its tombstones, at double the size when live keys fill a quarter. A
// copy is a memcpy of the slot array, as Rust's HashSet clone copies its table. The words are fixed char arrays built
// once and the documents arrays of pointers to them, as the JS arrays hold the
// word strings; a set's slot points at the word it holds, and every lookup
// hashes and compares the text, as a JS Set compares strings by content.
// Each comparison allocates its sets and frees them before it returns.
//
// Reports: median ms across N_RUNS, throughput in documents/µs, FNV-1a
// checksum over the vocabulary size, scores and differences. No fold depends
// on slot order.
#include "../_lib/bench.h"
#include <stdlib.h>

#define NWORDS   1024
#define NSTOP    32   // the most common words are stop words
#define NDOCS    256
#define WINDOW   8    // documents compared after each one
#define N_RUNS   21
#define N_WARMUP 5

static const char DELETED[] = "";  // the key of a tombstone; an empty slot's key is NULL

typedef struct { const char* key; uint32_t hash, len; } Slot;
typedef struct { Slot* slots; uint32_t cap, len, dead; } StrSet;

typedef struct { const char** w; int len; } Doc;

typedef struct { int32_t vocab, score, dupes, diff; } Result;

static char words[NWORDS][16];
static Doc docs[NDOCS];
static double samples[N_RUNS];

static uint32_t seed = 0x6d2b79f5u;

static uint32_t next(void) {
  seed ^= seed << 13;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  return seed;
}

static uint32_t str_hash(const char* k, uint32_t* len) {
  uint32_t h = 0x811c9dc5u;
  const char* p = k;
  for (; *p; p++) h = (h ^ (uint8_t)*p) * 0x01000193u;
  *len = (uint32_t)(p - k);
  return h;
}

static int live(const Slot* s) { return s->key != NULL && s->key != DELETED; }

static void ss_init(StrSet* s) {
  s->cap = 16;
  s->len = s->dead = 0;
  s->slots = calloc(s->cap, sizeof(Slot));
}

static void ss_copy(StrSet* dst, const StrSet* src) {
  *dst = *src;
  dst->slots = malloc(src->cap * sizeof(Slot));
  memcpy(dst->slots, src->slots, src->cap * sizeof(Slot));
}

static void ss_free(StrSet* s) { free(s->slots); }

// The slot holding k, or else the slot an insert of k takes: the first
// tombstone on its probe path, or the empty slot that ends the path.
static Slot* ss_slot(const StrSet* s, const char* k, uint32_t h, uint32_t len) {
  uint32_t mask = s->cap - 1;
  Slot* tomb = NULL;
  for (uint32_t i = h & mask;; i = (i + 1) & mask) {
    Slot* e = &s->slots[i];
    if (e->key == NULL) return tomb ? tomb : e;
    if (e->key == DELETED) { if (!tomb) tomb = e; }
    else if (e->hash == h && e->len == len && memcmp(e->key, k, len) == 0) return e;
  }
}

static void ss_rebuild(StrSet* s, uint32_t cap) {
  Slot* old = s->slots;
  uint32_t old_cap = s->cap;
  s->slots = calloc(cap, sizeof(Slot));
  s->cap = cap;
  s->dead = 0;
  for (uint32_t i = 0; i < old_cap; i++) {
    if (!live(&old[i])) continue;
    uint32_t j = old[i].hash & (cap - 1);
    while (s->slots[j].key != NULL) j = (j + 1) & (cap - 1);
    s->slots[j] = old[i];
  }
  free(old);
}

static int ss_has(const StrSet* s, const char* k) {
  uint32_t len, h = str_hash(k, &len);
  return live(ss_slot(s, k, h, len));
}

static void ss_add(StrSet* s, const char* k) {
  uint32_t len, h = str_hash(k, &len);
  Slot* e = ss_slot(s, k, h, len);
  if (live(e)) return;
  if (e->key == NULL && (s->len + s->dead + 1) * 2 > s->cap) {
    ss_rebuild(s, (s->len + 1) * 4 > s->cap ? s->cap * 2 : s->cap);
    e = ss_slot(s, k, h, len);
  }
  if (e->key == DELETED) s->dead--;
  e->key = k;
  e->hash = h;
  e->len = len;
  s->len++;
}

static void ss_delete(StrSet* s, const char* k) {
  uint32_t len, h = str_hash(k, &len);
  Slot* e = ss_slot(s, k, h, len);
  if (!live(e)) return;
  e->key = DELETED;
  s->len--;
  s->dead++;
}

static void build_words(void) {
  for (int i = 0; i < NWORDS; i++) {
    int len = 3 + (int)(next() % 7);
    for (int j = 0; j < len; j++) words[i][j] = (char)(97 + next() % 26);
    snprintf(words[i] + len, sizeof words[i] - (size_t)len, "%d", i);
  }
}

// a word index skewed toward common words: the minimum of two uniform draws
static int pick(void) {
  uint32_t a = next() % NWORDS, b = next() % NWORDS;
  return (int)(a < b ? a : b);
}

static void build_docs(void) {
  for (int d = 0; d < NDOCS; d++) {
    Doc* doc = &docs[d];
    if (d % 8 == 7) {
      const Doc* prev = &docs[d - 1];
      doc->len = prev->len;
      doc->w = malloc((size_t)doc->len * sizeof(const char*));
      for (int k = 0; k < prev->len; k++) doc->w[k] = next() % 10 == 0 ? words[pick()] : prev->w[k];
    } else {
      doc->len = 24 + (int)(next() % 73);
      doc->w = malloc((size_t)doc->len * sizeof(const char*));
      for (int k = 0; k < doc->len; k++) doc->w[k] = words[pick()];
    }
  }
}

static Result compare(const Doc* ds, int n, const char* const* stop_words, int nstop) {
  StrSet stop, vocab;
  ss_init(&stop);
  for (int i = 0; i < nstop; i++) ss_add(&stop, stop_words[i]);
  ss_init(&vocab);
  StrSet* sets = malloc((size_t)n * sizeof(StrSet));
  for (int d = 0; d < n; d++) {
    StrSet* s = &sets[d];
    ss_init(s);
    for (int k = 0; k < ds[d].len; k++) if (!ss_has(&stop, ds[d].w[k])) ss_add(s, ds[d].w[k]);
    for (uint32_t i = 0; i < s->cap; i++) if (live(&s->slots[i])) ss_add(&vocab, s->slots[i].key);
  }
  Result r = {(int32_t)vocab.len, 0, 0, 0};
  for (int i = 0; i < n; i++) {
    const StrSet* a = &sets[i];
    for (int j = i + 1; j <= i + WINDOW && j < n; j++) {
      const StrSet* b = &sets[j];
      const StrSet* small = a->len < b->len ? a : b;
      const StrSet* large = small == a ? b : a;
      int32_t inter = 0;
      for (uint32_t k = 0; k < small->cap; k++) if (live(&small->slots[k]) && ss_has(large, small->slots[k].key)) inter++;
      int32_t uni = (int32_t)a->len + (int32_t)b->len - inter;
      int32_t jac = uni == 0 ? 0 : inter * 1000 / uni;
      r.score += jac;
      if (jac >= 600) {
        r.dupes++;
        StrSet only_a, only_b;
        ss_copy(&only_a, a);
        for (uint32_t k = 0; k < b->cap; k++) if (live(&b->slots[k])) ss_delete(&only_a, b->slots[k].key);
        ss_copy(&only_b, b);
        for (uint32_t k = 0; k < a->cap; k++) if (live(&a->slots[k])) ss_delete(&only_b, a->slots[k].key);
        r.diff += (int32_t)(only_a.len + only_b.len);
        ss_free(&only_a);
        ss_free(&only_b);
      }
    }
  }
  for (int d = 0; d < n; d++) ss_free(&sets[d]);
  free(sets);
  ss_free(&vocab);
  ss_free(&stop);
  return r;
}

int main(void) {
  build_words();
  build_docs();
  const char* stop_words[NSTOP];
  for (int i = 0; i < NSTOP; i++) stop_words[i] = words[i];
  Result r = {0, 0, 0, 0};
  for (int i = 0; i < N_WARMUP; i++) r = compare(docs, NDOCS, stop_words, NSTOP);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    r = compare(docs, NDOCS, stop_words, NSTOP);
    samples[i] = now_ms() - t0;
  }
  uint32_t cs = mix_u32(mix_u32(mix_u32(mix_u32(0x811c9dc5u, (uint32_t)r.vocab), (uint32_t)r.score),
    (uint32_t)r.dupes), (uint32_t)r.diff);
  print_result(median_us(samples, N_RUNS), cs, NDOCS, 3, N_RUNS);
  for (int d = 0; d < NDOCS; d++) free(docs[d].w);
  return 0;
}
