// dispatch.c — data-driven dispatch through a table of first-class functions:
// an unpredictable opcode stream picks one of 8 tiny integer operators at a
// single call site. The canonical dynamic-dispatch kernel (virtual/interface
// calls, strategy tables, event pipelines, effect chains): every step is an
// indirect call through a data-selected function pointer. Pure 32-bit integer,
// so the fold result is bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in calls/µs, FNV-1a checksum
// over the per-pass fold results.
#include "../_lib/bench.h"

#define N        (1 << 14)       // opcode stream length
#define NOPS     8               // distinct operators in the table
#define N_ITERS  48              // stream passes per kernel run
#define N_RUNS   21
#define N_WARMUP 5

static int32_t code[N];
static int32_t ks[N];
static double  samples[N_RUNS];

// The operator table — 8 functions with one shared signature, selected per
// element by data. Semantics mirror dispatch.js exactly (JS i32 ops).
static int32_t op_add(int32_t x, int32_t k)  { return (int32_t)((uint32_t)x + (uint32_t)k); }
static int32_t op_xor(int32_t x, int32_t k)  { return x ^ k; }
static int32_t op_mul(int32_t x, int32_t k)  { return (int32_t)((uint32_t)x * (uint32_t)(k | 1)); }
static int32_t op_rsub(int32_t x, int32_t k) { return (int32_t)((uint32_t)k - (uint32_t)x); }
static int32_t op_shr(int32_t x, int32_t k)  { return x ^ (int32_t)((uint32_t)x >> 7) ^ k; }
static int32_t op_m31(int32_t x, int32_t k)  { return (int32_t)(((uint32_t)x << 5) - (uint32_t)x + (uint32_t)k); }
static int32_t op_rot(int32_t x, int32_t k)  { return (int32_t)((((uint32_t)x << 13) | ((uint32_t)x >> 19)) ^ (uint32_t)k); }
static int32_t op_and(int32_t x, int32_t k)  { return (x & k) ^ (int32_t)((uint32_t)x >> 11); }

typedef int32_t (*op_fn)(int32_t, int32_t);
static op_fn const OPS[NOPS] = { op_add, op_xor, op_mul, op_rsub, op_shr, op_m31, op_rot, op_and };

// Deterministic unpredictable opcode/operand stream — XorShift32, identical
// per target; low 3 bits pick the operator, the rest is the operand.
static void fill(int32_t* c, int32_t* k) {
  int32_t s = (int32_t)0x1234abcd;
  for (int i = 0; i < N; i++) {
    s ^= s << 13;
    s ^= (int32_t)((uint32_t)s >> 17);
    s ^= s << 5;
    c[i] = s & (NOPS - 1);
    k[i] = s >> 3;
  }
}

static uint32_t run_kernel(const int32_t* c, const int32_t* k) {
  uint32_t h = 0x811c9dc5u;
  for (int it = 0; it < N_ITERS; it++) {
    int32_t x = (int32_t)(0x2545f491u + (uint32_t)it);
    for (int i = 0; i < N; i++) x = OPS[c[i]](x, k[i]);
    h = mix_u32(h, (uint32_t)x);
  }
  return h;
}

int main(void) {
  fill(code, ks);
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(code, ks);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(code, ks);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, N * N_ITERS, NOPS, N_RUNS);
}
