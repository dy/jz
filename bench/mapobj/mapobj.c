// mapobj.c – a build tool's pass over a module graph with pointer-keyed maps:
// in-degree and reverse edges, Kahn's topological order with each module's
// depth (the longest dependency chain under it), then a deep copy of the graph
// through a memo map that keeps shared dependencies shared and a set that
// counts the distinct copies. Names repeat, so only identity keys the tables.
//
// Layout: a module is a struct holding pointers to its dependencies; the
// originals sit in one array built once, and each copy is malloc'd with its
// own dependency array. Every side table is keyed by module address, as Go's
// map[*Module]T is and as an object key is in JavaScript. C has no standard
// map, so the program carries the one a C programmer writes for it: open
// addressing with linear probing over a power-of-two array of (pointer, value)
// slots that doubles rather than fill past half, the slot chosen by a
// multiplicative (Fibonacci) hash of the address bits, NULL marking an empty
// slot; nothing is deleted. One table type serves the five tables, its value
// a union: a count (in-degree, depth), a copy's address (memo), the index of
// the module's list of users in a growable array of lists (reverse edges), or
// nothing (the set of copies). The lists, the topological order and the copy
// stack are growable pointer buffers that keep insertion order. Each JS read
// and write of one entry (has then set, get then set) is one probe that finds
// or adds the slot. Each plan frees the copies, the lists and every table but
// the returned order and depth map, which the next run frees.
//
// Reports: median ms across N_RUNS, throughput in modules/µs, FNV-1a checksum
// over the order, depths and copy counts. The order is FIFO in module order
// and the lists in insertion order, so the order and depths are fixed; the
// rest are sums.
#include "../_lib/bench.h"
#include <stdlib.h>

#define N        4096  // modules
#define ENTRIES  64    // entry points copied from the end of the order
#define N_RUNS   21
#define N_WARMUP 5

static const char* const NAMES[] = {"react", "lodash", "util", "core", "events", "buffer", "path", "stream", "zlib", "url"};
#define NNAMES 10

typedef struct Module Module;
struct Module {
  int32_t id;
  const char* name;
  int32_t size;
  int32_t ndeps;
  Module** deps;
};

typedef struct { const Module* key; union { int32_t n; Module* mod; } v; } Slot;
typedef struct { Slot* slots; uint32_t cap, len; int shift; } PtrMap;

typedef struct { Module** items; int32_t len, cap; } List;
typedef struct { List* at; int32_t len, cap; } Lists;

typedef struct {
  List order;
  PtrMap depth;
  int32_t copies, distinct, bytes;
} Result;

static Module modules[N];
static double samples[N_RUNS];

static void pm_init(PtrMap* m) {
  m->cap = 16;
  m->shift = 64 - 4;
  m->len = 0;
  m->slots = calloc(m->cap, sizeof(Slot));
}

static void pm_free(PtrMap* m) { free(m->slots); }

static uint32_t pm_hash(const PtrMap* m, const Module* k) {
  return (uint32_t)(((uint64_t)(uintptr_t)k * 0x9e3779b97f4a7c15u) >> m->shift);
}

// The slot holding k, or else the empty slot that ends its probe path.
static Slot* pm_slot(const PtrMap* m, const Module* k) {
  uint32_t mask = m->cap - 1;
  uint32_t i = pm_hash(m, k);
  while (m->slots[i].key != NULL && m->slots[i].key != k) i = (i + 1) & mask;
  return &m->slots[i];
}

static void pm_grow(PtrMap* m) {
  Slot* old = m->slots;
  uint32_t old_cap = m->cap;
  m->cap *= 2;
  m->shift--;
  m->slots = calloc(m->cap, sizeof(Slot));
  for (uint32_t i = 0; i < old_cap; i++) if (old[i].key != NULL) *pm_slot(m, old[i].key) = old[i];
  free(old);
}

static Slot* pm_get(const PtrMap* m, const Module* k) {
  Slot* s = pm_slot(m, k);
  return s->key == NULL ? NULL : s;
}

// Finds k's slot or adds one for it; *added says which, and the caller sets a
// new slot's value.
static Slot* pm_put(PtrMap* m, const Module* k, int* added) {
  Slot* s = pm_slot(m, k);
  *added = s->key == NULL;
  if (!*added) return s;
  if ((m->len + 1) * 2 > m->cap) {
    pm_grow(m);
    s = pm_slot(m, k);
  }
  s->key = k;
  m->len++;
  return s;
}

static void list_push(List* l, Module* x) {
  if (l->len == l->cap) {
    l->cap = l->cap ? l->cap * 2 : 4;
    l->items = realloc(l->items, (size_t)l->cap * sizeof(Module*));
  }
  l->items[l->len++] = x;
}

static uint32_t seed = 0x9e3779b9u;

static uint32_t next(void) {
  seed ^= seed << 13;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  return seed;
}

static void build_graph(void) {
  for (int i = 0; i < N; i++) {
    Module* m = &modules[i];
    m->ndeps = i == 0 ? 0 : (int32_t)(next() % 5);
    m->deps = malloc((size_t)m->ndeps * sizeof(Module*));
    for (int k = 0; k < m->ndeps; k++) m->deps[k] = &modules[next() % (uint32_t)i];
    m->id = i;
    m->name = NAMES[next() % NNAMES];
    m->size = 100 + (int32_t)(next() % 9900);
  }
}

static Module* copy_of(PtrMap* memo, const Module* m) {
  int added;
  Slot* s = pm_put(memo, m, &added);
  if (!added) return s->v.mod;
  Module* c = malloc(sizeof(Module));
  c->id = m->id;
  c->name = m->name;
  c->size = m->size;
  c->ndeps = m->ndeps;
  c->deps = malloc((size_t)m->ndeps * sizeof(Module*));
  s->v.mod = c;
  for (int k = 0; k < m->ndeps; k++) c->deps[k] = copy_of(memo, m->deps[k]);
  return c;
}

// The list of d's users, opened at the end of the lists on d's first user.
static List* users_list(PtrMap* users, Lists* ls, const Module* d) {
  int added;
  Slot* s = pm_put(users, d, &added);
  if (added) {
    if (ls->len == ls->cap) {
      ls->cap = ls->cap ? ls->cap * 2 : 16;
      ls->at = realloc(ls->at, (size_t)ls->cap * sizeof(List));
    }
    ls->at[ls->len] = (List){NULL, 0, 0};
    s->v.n = ls->len++;
  }
  return &ls->at[s->v.n];
}

static Result plan(Module* mods, int n) {
  int added;
  PtrMap indeg, users;
  pm_init(&indeg);
  pm_init(&users);
  Lists lists = {NULL, 0, 0};
  for (int i = 0; i < n; i++) {
    Module* m = &mods[i];
    Slot* s = pm_put(&indeg, m, &added);
    if (added) s->v.n = 0;
    for (int k = 0; k < m->ndeps; k++) {
      Module* d = m->deps[k];
      pm_get(&indeg, m)->v.n++;
      list_push(users_list(&users, &lists, d), m);
    }
  }
  Result r = {0};
  pm_init(&r.depth);
  for (int i = 0; i < n; i++) {
    if (pm_get(&indeg, &mods[i])->v.n != 0) continue;
    list_push(&r.order, &mods[i]);
    pm_put(&r.depth, &mods[i], &added)->v.n = 0;
  }
  for (int32_t head = 0; head < r.order.len; head++) {
    Module* m = r.order.items[head];
    Slot* us = pm_get(&users, m);
    if (us == NULL) continue;
    const List* u = &lists.at[us->v.n];
    int32_t d = pm_get(&r.depth, m)->v.n + 1;
    for (int32_t k = 0; k < u->len; k++) {
      Module* v = u->items[k];
      Slot* dv = pm_put(&r.depth, v, &added);
      if (added || dv->v.n < d) dv->v.n = d;
      int32_t left = --pm_get(&indeg, v)->v.n;
      if (left == 0) list_push(&r.order, v);
    }
  }
  PtrMap memo, seen;
  pm_init(&memo);
  pm_init(&seen);
  List stack = {NULL, 0, 0};
  for (int32_t e = r.order.len - ENTRIES; e < r.order.len; e++) {
    list_push(&stack, copy_of(&memo, r.order.items[e]));
    while (stack.len > 0) {
      Module* c = stack.items[--stack.len];
      pm_put(&seen, c, &added);
      if (!added) continue;
      r.bytes += c->size;
      for (int32_t k = 0; k < c->ndeps; k++) list_push(&stack, c->deps[k]);
    }
  }
  r.copies = (int32_t)memo.len;
  r.distinct = (int32_t)seen.len;
  for (uint32_t i = 0; i < memo.cap; i++) {
    if (memo.slots[i].key == NULL) continue;
    free(memo.slots[i].v.mod->deps);
    free(memo.slots[i].v.mod);
  }
  free(stack.items);
  pm_free(&seen);
  pm_free(&memo);
  for (int32_t i = 0; i < lists.len; i++) free(lists.at[i].items);
  free(lists.at);
  pm_free(&users);
  pm_free(&indeg);
  return r;
}

static void free_result(Result* r) {
  free(r->order.items);
  pm_free(&r->depth);
}

static uint32_t checksum(const Result* r) {
  uint32_t h = 0x811c9dc5u;
  for (int32_t i = 0; i < r->order.len; i++) {
    const Module* m = r->order.items[i];
    h = mix_u32(mix_u32(h, (uint32_t)m->id), (uint32_t)pm_get(&r->depth, m)->v.n);
  }
  return mix_u32(mix_u32(mix_u32(h, (uint32_t)r->copies), (uint32_t)r->distinct), (uint32_t)r->bytes);
}

int main(void) {
  build_graph();
  Result r = plan(modules, N);
  for (int i = 1; i < N_WARMUP; i++) { free_result(&r); r = plan(modules, N); }

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    Result fresh = plan(modules, N);
    free_result(&r);  // the previous run's order and depth map, as a GC would reclaim them
    r = fresh;
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum(&r), N, 3, N_RUNS);
  free_result(&r);
  for (int i = 0; i < N; i++) free(modules[i].deps);
  return 0;
}
