// mapint.c – graph analytics over sparse integer ids with integer-keyed
// maps: adjacency lists keyed by 30-bit node id, the degree histogram, and a
// breadth-first search per source with its distance map, from four sources.
//
// C has no standard map, so the program carries the one a C programmer writes
// for it: open addressing with linear probing over a power-of-two array of
// (key, value) int32 pairs that doubles rather than fill past half, the slot
// chosen by a multiplicative (Fibonacci) hash, the product's top bits. No key
// is negative (ids are 30-bit, the degree map's keys list lengths), so -1
// marks an empty slot; nothing is deleted. One table type serves the three
// maps. The adjacency map's value is the index of the node's list in a
// growable array of lists, each list (and the search queue) a growable int32
// buffer that keeps insertion order, so a search visits neighbors in the JS's
// order and the distances agree. Each JS
// read and write of one entry (has then set, get then set) is one probe that
// finds or adds the slot. Each analysis allocates its maps and lists and frees
// all but the returned degree map, which the next run frees.
//
// Reports: median ms across N_RUNS, throughput in edges/µs, FNV-1a checksum
// over the degree histogram and the searches. Map folds are sums, so slot
// order changes nothing.
#include "../_lib/bench.h"
#include <stdlib.h>

#define NODES    (1 << 12)
#define EDGES    (3 * NODES)
#define SOURCES  4
#define N_RUNS   21
#define N_WARMUP 5
#define EMPTY    (-1)

typedef struct { int32_t key, val; } Slot;
typedef struct { Slot* slots; uint32_t cap, len; int shift; } IntMap;

typedef struct { int32_t* items; int32_t len, cap; } List;
typedef struct { List* at; int32_t len, cap; } Lists;

typedef struct {
  int32_t nodes;
  IntMap degrees;
  uint32_t searches[2 * SOURCES];
} Result;

static int32_t src[EDGES], dst[EDGES];
static double samples[N_RUNS];

static void im_init(IntMap* m) {
  m->cap = 16;
  m->shift = 32 - 4;
  m->len = 0;
  m->slots = malloc(m->cap * sizeof(Slot));
  for (uint32_t i = 0; i < m->cap; i++) m->slots[i].key = EMPTY;
}

static void im_free(IntMap* m) { free(m->slots); }

static uint32_t im_hash(const IntMap* m, int32_t k) { return ((uint32_t)k * 0x9e3779b1u) >> m->shift; }

// The slot holding k, or else the empty slot that ends its probe path.
static Slot* im_slot(const IntMap* m, int32_t k) {
  uint32_t mask = m->cap - 1;
  uint32_t i = im_hash(m, k);
  while (m->slots[i].key != EMPTY && m->slots[i].key != k) i = (i + 1) & mask;
  return &m->slots[i];
}

static void im_grow(IntMap* m) {
  Slot* old = m->slots;
  uint32_t old_cap = m->cap;
  m->cap *= 2;
  m->shift--;
  m->slots = malloc(m->cap * sizeof(Slot));
  for (uint32_t i = 0; i < m->cap; i++) m->slots[i].key = EMPTY;
  for (uint32_t i = 0; i < old_cap; i++) if (old[i].key != EMPTY) *im_slot(m, old[i].key) = old[i];
  free(old);
}

static Slot* im_get(const IntMap* m, int32_t k) {
  Slot* s = im_slot(m, k);
  return s->key == EMPTY ? NULL : s;
}

// Finds k's slot or adds one for it; *added says which, and the caller sets a
// new slot's value.
static Slot* im_put(IntMap* m, int32_t k, int* added) {
  Slot* s = im_slot(m, k);
  *added = s->key == EMPTY;
  if (!*added) return s;
  if ((m->len + 1) * 2 > m->cap) {
    im_grow(m);
    s = im_slot(m, k);
  }
  s->key = k;
  m->len++;
  return s;
}

static void list_push(List* l, int32_t x) {
  if (l->len == l->cap) {
    l->cap = l->cap ? l->cap * 2 : 4;
    l->items = realloc(l->items, (size_t)l->cap * sizeof(int32_t));
  }
  l->items[l->len++] = x;
}

// a node number to its id: a bijective scramble of 30 bits
static int32_t id_of(uint32_t n) {
  uint32_t x = ((n + 1) * 0x2c1b3c6du) & 0x3fffffffu;
  x ^= x >> 15;
  return (int32_t)((x * 0x297a2d39u) & 0x3fffffffu);
}

static void build_edges(void) {
  uint32_t s = 0x2545f491u;
  for (int i = 0; i < EDGES; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    uint32_t a = (s >> 2) & (NODES - 1);
    uint32_t b = (s & 1) == 0 ? (s >> 16) & 1023 : (s >> 16) & (NODES - 1);
    src[i] = id_of(a);
    dst[i] = id_of(b == a ? (a + 1) & (NODES - 1) : b);
  }
}

// The list of node id, opened at the end of the lists on the id's first edge.
static List* adj_list(IntMap* adj, Lists* ls, int32_t id) {
  int added;
  Slot* s = im_put(adj, id, &added);
  if (added) {
    if (ls->len == ls->cap) {
      ls->cap = ls->cap ? ls->cap * 2 : 16;
      ls->at = realloc(ls->at, (size_t)ls->cap * sizeof(List));
    }
    ls->at[ls->len] = (List){NULL, 0, 0};
    s->val = ls->len++;
  }
  return &ls->at[s->val];
}

static Result analyze(const int32_t* sa, const int32_t* da, int n) {
  Result r = {0};
  IntMap adj;
  im_init(&adj);
  Lists lists = {NULL, 0, 0};
  for (int i = 0; i < n; i++) {
    int32_t a = sa[i], b = da[i];
    list_push(adj_list(&adj, &lists, a), b);
    list_push(adj_list(&adj, &lists, b), a);
  }
  int added;
  im_init(&r.degrees);
  for (uint32_t i = 0; i < adj.cap; i++) {
    if (adj.slots[i].key == EMPTY) continue;
    Slot* d = im_put(&r.degrees, lists.at[adj.slots[i].val].len, &added);
    if (added) d->val = 0;
    d->val++;
  }
  List queue = {NULL, 0, 0};
  for (int k = 0; k < SOURCES; k++) {
    int32_t root = sa[(k * 6151) % n];
    IntMap dist;
    im_init(&dist);
    im_put(&dist, root, &added)->val = 0;
    queue.len = 0;
    list_push(&queue, root);
    uint32_t sum = 0;
    for (int32_t head = 0; head < queue.len; head++) {
      int32_t v = queue.items[head];
      int32_t d = im_get(&dist, v)->val + 1;
      const List* l = &lists.at[im_get(&adj, v)->val];
      for (int32_t j = 0; j < l->len; j++) {
        int32_t w = l->items[j];
        Slot* s = im_put(&dist, w, &added);
        if (added) { s->val = d; sum += (uint32_t)d; list_push(&queue, w); }
      }
    }
    r.searches[2 * k] = dist.len;
    r.searches[2 * k + 1] = sum;
    im_free(&dist);
  }
  r.nodes = (int32_t)adj.len;
  free(queue.items);
  for (int32_t i = 0; i < lists.len; i++) free(lists.at[i].items);
  free(lists.at);
  im_free(&adj);
  return r;
}

static uint32_t checksum(const Result* r) {
  uint32_t h = mix_u32(0x811c9dc5u, (uint32_t)r->nodes);
  uint32_t acc = 0;
  for (uint32_t i = 0; i < r->degrees.cap; i++) {
    const Slot* s = &r->degrees.slots[i];
    if (s->key != EMPTY) acc += mix_u32((uint32_t)s->key, (uint32_t)s->val);
  }
  h = mix_u32(mix_u32(h, r->degrees.len), acc);
  for (int i = 0; i < 2 * SOURCES; i++) h = mix_u32(h, r->searches[i]);
  return h;
}

int main(void) {
  build_edges();
  Result r = analyze(src, dst, EDGES);
  for (int i = 1; i < N_WARMUP; i++) { im_free(&r.degrees); r = analyze(src, dst, EDGES); }

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    Result fresh = analyze(src, dst, EDGES);
    im_free(&r.degrees);  // the previous run's map, as a GC would reclaim it
    r = fresh;
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum(&r), EDGES, 3, N_RUNS);
  im_free(&r.degrees);
  return 0;
}
