// mapstr.c – sessionizing a request log with string-keyed maps: per event,
// count the route, find or open the user's session, drop the event while the
// user is rate-limited, ban users that exceed a burst, and every 512 events
// close the sessions idle for a window.
//
// C has no standard map, so the program carries the one a C programmer writes
// for it: open addressing with linear probing over a power-of-two slot array
// that doubles rather than fill past half, FNV-1a over the key bytes, each slot
// caching its key's hash and length so a probe compares bytes only on a hash
// match. A deletion leaves a tombstone, so the sweep deletes sessions in place
// while it walks the slots and nothing moves under it; an insert takes the
// first tombstone on its path, and once live and dead slots would pass half
// the table is rebuilt without its tombstones, at double the size when live
// keys fill a quarter. One table type serves the three maps, its value a
// union: a count (route hits), the event a ban lasts until (bans), or the
// session record itself (sessions). A key is the event's own string, which
// outlives every map, so the slot points at it, as a JS Map holds a
// reference; each lookup hashes and compares the text, the strings being
// equal in content to earlier ones but never the same object. Each JS read
// and write of one entry (get then set; has, get then delete) is one probe
// that finds or adds the slot. The event strings are built once, outside the
// timed region; each run allocates its three tables and the next run frees
// them.
//
// Reports: median ms across N_RUNS, throughput in events/µs, FNV-1a checksum
// over closed-session statistics and the final maps. Map folds are sums, so
// slot order changes nothing.
#include "../_lib/bench.h"
#include <stdlib.h>

#define N        (1 << 15)  // events per pass
#define NUSERS   4096
#define NROUTES  96
#define WINDOW   2048       // a session idle this many events closes
#define SWEEP    512        // events between sweeps
#define BURST    48         // hits within one session that earn a ban
#define PENALTY  1024       // events a ban lasts
#define N_RUNS   21
#define N_WARMUP 5

static const char* const RESOURCES[] = {"users", "orders", "items", "carts", "search", "auth", "images", "reviews",
  "stock", "prices", "tags", "stats"};
#define NRESOURCES 12

typedef struct { int32_t hits, bytes, first, last; } Session;

static const char DELETED[] = "";  // the key of a tombstone; an empty slot's key is NULL

typedef struct {
  const char* key;
  uint32_t hash, len;
  union { int32_t n; Session s; } v;
} Slot;

typedef struct { Slot* slots; uint32_t cap, len, dead; } StrMap;

typedef struct {
  StrMap route_hits, sessions, banned;
  int32_t dropped, closed, closed_bytes, longest;
} Result;

static char* users[N];
static char* routes[N];
static int32_t bytes[N];
static double samples[N_RUNS];

static uint32_t str_hash(const char* k, uint32_t* len) {
  uint32_t h = 0x811c9dc5u;
  const char* p = k;
  for (; *p; p++) h = (h ^ (uint8_t)*p) * 0x01000193u;
  *len = (uint32_t)(p - k);
  return h;
}

static int live(const Slot* s) { return s->key != NULL && s->key != DELETED; }

static void sm_init(StrMap* m) {
  m->cap = 16;
  m->len = m->dead = 0;
  m->slots = calloc(m->cap, sizeof(Slot));
}

static void sm_free(StrMap* m) { free(m->slots); }

// The slot holding k, or else the slot an insert of k takes: the first
// tombstone on its probe path, or the empty slot that ends the path.
static Slot* sm_slot(const StrMap* m, const char* k, uint32_t h, uint32_t len) {
  uint32_t mask = m->cap - 1;
  Slot* tomb = NULL;
  for (uint32_t i = h & mask;; i = (i + 1) & mask) {
    Slot* s = &m->slots[i];
    if (s->key == NULL) return tomb ? tomb : s;
    if (s->key == DELETED) { if (!tomb) tomb = s; }
    else if (s->hash == h && s->len == len && memcmp(s->key, k, len) == 0) return s;
  }
}

static void sm_rebuild(StrMap* m, uint32_t cap) {
  Slot* old = m->slots;
  uint32_t old_cap = m->cap;
  m->slots = calloc(cap, sizeof(Slot));
  m->cap = cap;
  m->dead = 0;
  for (uint32_t i = 0; i < old_cap; i++) {
    if (!live(&old[i])) continue;
    uint32_t j = old[i].hash & (cap - 1);
    while (m->slots[j].key != NULL) j = (j + 1) & (cap - 1);
    m->slots[j] = old[i];
  }
  free(old);
}

static Slot* sm_get(const StrMap* m, const char* k) {
  uint32_t len, h = str_hash(k, &len);
  Slot* s = sm_slot(m, k, h, len);
  return live(s) ? s : NULL;
}

// Finds k's slot or adds one for it; *added says which, and the caller sets a
// new slot's value.
static Slot* sm_put(StrMap* m, const char* k, int* added) {
  uint32_t len, h = str_hash(k, &len);
  Slot* s = sm_slot(m, k, h, len);
  *added = !live(s);
  if (!*added) return s;
  if (s->key == NULL && (m->len + m->dead + 1) * 2 > m->cap) {
    sm_rebuild(m, (m->len + 1) * 4 > m->cap ? m->cap * 2 : m->cap);
    s = sm_slot(m, k, h, len);
  }
  if (s->key == DELETED) m->dead--;
  s->key = k;
  s->hash = h;
  s->len = len;
  m->len++;
  return s;
}

static void sm_delete(StrMap* m, Slot* s) {
  s->key = DELETED;
  m->len--;
  m->dead++;
}

static char* copy_str(const char* buf, int n) {
  char* s = malloc((size_t)n + 1);
  memcpy(s, buf, (size_t)n + 1);
  return s;
}

static void build_events(void) {
  char buf[64];
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    uint32_t u = (s & 1) == 0 ? (s >> 1) & 63 : (s >> 1) & (NUSERS - 1);
    uint32_t r = (s >> 13) % NROUTES;
    users[i] = copy_str(buf, snprintf(buf, sizeof buf, "user%u", u));
    routes[i] = copy_str(buf, snprintf(buf, sizeof buf, "/api/v%u/%s/%u", 1 + r % 3, RESOURCES[r % NRESOURCES], r >> 2));
    bytes[i] = 200 + (int32_t)((s >> 20) & 4095);
  }
}

static Result run(void) {
  Result res = {0};
  sm_init(&res.route_hits);
  sm_init(&res.sessions);
  sm_init(&res.banned);
  int added;
  for (int32_t i = 0; i < N; i++) {
    Slot* rh = sm_put(&res.route_hits, routes[i], &added);
    if (added) rh->v.n = 0;
    rh->v.n++;
    const char* u = users[i];
    Slot* b = sm_get(&res.banned, u);
    if (b) {
      if (b->v.n > i) { res.dropped++; continue; }
      sm_delete(&res.banned, b);
    }
    Slot* ss = sm_put(&res.sessions, u, &added);
    Session* s = &ss->v.s;
    if (added) *s = (Session){0, 0, i, i};
    s->hits++;
    s->bytes += bytes[i];
    s->last = i;
    if (s->hits % BURST == 0) sm_put(&res.banned, u, &added)->v.n = i + PENALTY;
    if (i % SWEEP == SWEEP - 1) {
      for (uint32_t j = 0; j < res.sessions.cap; j++) {
        Slot* e = &res.sessions.slots[j];
        if (!live(e) || i - e->v.s.last <= WINDOW) continue;
        res.closed++;
        res.closed_bytes = (int32_t)((uint32_t)res.closed_bytes + (uint32_t)e->v.s.bytes);
        if (e->v.s.last - e->v.s.first > res.longest) res.longest = e->v.s.last - e->v.s.first;
        sm_delete(&res.sessions, e);
      }
    }
  }
  return res;
}

static void free_result(Result* r) {
  sm_free(&r->route_hits);
  sm_free(&r->sessions);
  sm_free(&r->banned);
}

static uint32_t hash_str(const char* k) {
  uint32_t len;
  return str_hash(k, &len);  // ASCII keys: the bytes are the UTF-16 code units
}

static uint32_t checksum(const Result* r) {
  uint32_t h = mix_u32(mix_u32(mix_u32(mix_u32(0x811c9dc5u, (uint32_t)r->dropped), (uint32_t)r->closed),
    (uint32_t)r->closed_bytes), (uint32_t)r->longest);
  uint32_t acc = 0;
  for (uint32_t i = 0; i < r->route_hits.cap; i++) {
    const Slot* e = &r->route_hits.slots[i];
    if (live(e)) acc += mix_u32(hash_str(e->key), (uint32_t)e->v.n);
  }
  h = mix_u32(mix_u32(h, r->route_hits.len), acc);
  acc = 0;
  for (uint32_t i = 0; i < r->sessions.cap; i++) {
    const Slot* e = &r->sessions.slots[i];
    if (live(e)) acc += mix_u32(mix_u32(hash_str(e->key), (uint32_t)e->v.s.hits), (uint32_t)e->v.s.bytes);
  }
  h = mix_u32(mix_u32(h, r->sessions.len), acc);
  acc = 0;
  for (uint32_t i = 0; i < r->banned.cap; i++) {
    const Slot* e = &r->banned.slots[i];
    if (live(e)) acc += mix_u32(hash_str(e->key), (uint32_t)e->v.n);
  }
  return mix_u32(mix_u32(h, r->banned.len), acc);
}

int main(void) {
  build_events();
  Result r = run();
  for (int i = 1; i < N_WARMUP; i++) { free_result(&r); r = run(); }

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    Result fresh = run();
    free_result(&r);  // the previous run's maps, as a GC would reclaim them
    r = fresh;
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum(&r), N, 3, N_RUNS);
  free_result(&r);
  for (int i = 0; i < N; i++) { free(users[i]); free(routes[i]); }
  return 0;
}
