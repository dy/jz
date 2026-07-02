// shapes.c — a per-variant measure summed over records of 8 heterogeneous
// shapes, in data-shuffled order. The canonical shape-polymorphism kernel
// (JSON rows, AST nodes, ECS entities, event streams). C's idiomatic answer
// to heterogeneous records is a kind-tagged flat record + branch — the static
// reference for what the dynamic-shape JS source costs. Pure 32-bit integer
// fields, so the sum is bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in records/µs, FNV-1a checksum
// over the per-pass sums.
#include "../_lib/bench.h"

#define N        (1 << 14)       // records
#define NSHAPES  8               // distinct record shapes
#define N_ITERS  48              // record-stream passes per kernel run
#define N_RUNS   21
#define N_WARMUP 5

// Kind-tagged record; payload fields map positionally per variant:
//   0 point  a=x  b=y            1 circle a=r
//   2 rect   a=w  b=h            3 line   a=x0 b=y0 c=x1 d=y1
//   4 tri    a b c               5 prism  a=w  b=h  c=d
//   6 arc    a=r  b=s            7 poly   a=n  b=s
typedef struct { int32_t k, a, b, c, d; } Rec;

static Rec    rows[N];
static double samples[N_RUNS];

// Deterministic heterogeneous record stream — XorShift32 picks each record's
// variant and integer fields (masked small, so every product stays exact i32).
static void init_rows(void) {
  int32_t s = (int32_t)0x1234abcd;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= (int32_t)((uint32_t)s >> 17);
    s ^= s << 5;
    uint32_t u = (uint32_t)s;
    int32_t k = s & (NSHAPES - 1);
    int32_t a = (int32_t)((u >> 3) & 1023), b = (int32_t)((u >> 13) & 1023), c = (int32_t)((u >> 23) & 511);
    Rec r = { k, 0, 0, 0, 0 };
    if (k == 0)      { r.a = a; r.b = b; }
    else if (k == 1) { r.a = a; }
    else if (k == 2) { r.a = a; r.b = b; }
    else if (k == 3) { r.a = a; r.b = b; r.c = c; r.d = (a ^ b) & 511; }
    else if (k == 4) { r.a = a; r.b = b; r.c = c; }
    else if (k == 5) { r.a = a; r.b = b; r.c = c; }
    else if (k == 6) { r.a = a; r.b = b; }
    else             { r.a = c; r.b = b; }
    rows[i] = r;
  }
}

// One measure per variant — mirrors shapes.js measure() exactly.
static int32_t measure(const Rec* o) {
  int32_t k = o->k;
  if (k == 0) return o->a + o->b;
  else if (k == 1) return o->a * (o->a * 3);
  else if (k == 2) return o->a * o->b;
  else if (k == 3) {
    int32_t dx = o->c - o->a, dy = o->d - o->b;
    return (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
  }
  else if (k == 4) return o->a + o->b + o->c;
  else if (k == 5) return o->a * o->b - o->c;
  else if (k == 6) return o->a * o->b + o->a;
  return o->a * (o->b * o->b);
}

static uint32_t run_kernel(void) {
  uint32_t h = 0x811c9dc5u;
  for (int it = 0; it < N_ITERS; it++) {
    int32_t sum = it;
    for (int i = 0; i < N; i++) sum = (int32_t)((uint32_t)sum + (uint32_t)measure(&rows[i]));
    h = mix_u32(h, (uint32_t)sum);
  }
  return h;
}

int main(void) {
  init_rows();
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel();
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel();
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS, NSHAPES, N_RUNS);
}
