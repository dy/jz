// quatmul.c – quaternion products, inverses and normalizations over two arrays
// of quaternions, the fixed-size linear-algebra kernel.
//
// Ports pmndrs/math (MIT, Copyright (c) 2026 Isaac Mason, bench/_lib/pmath/LICENSE)
// as written: random/mulberry32.js (create, next, sample), core/quat.js (create,
// multiply, invert) and core/vec4.js normalize, which quat.js exports as
// quat.normalize. A quaternion, a four-element plain array in the JS, is a
// fixed double[4] (the `quat` typedef); an array of them is one malloc'd block
// of quats. The functions keep their out-parameter (the `return out` meant for
// chaining is dropped) and read their inputs into locals before writing, so
// out may be an input. Only square roots and divisions: every target answers
// the same bits.
//
// Reports: median ms across N_RUNS, throughput in quaternion products/µs,
// FNV-1a checksum (checksum_f64) of the six results: its stride of 128 values
// hashes the low word of the first, the normalized products' running sum.
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define N        4096
#define N_RUNS   21
#define N_WARMUP 5

typedef double quat[4];
typedef double vec4[4];

// pmndrs/math random/mulberry32
typedef struct { uint32_t a; } Mulberry32;

static Mulberry32 mulberry32_create(uint32_t seed) {
  Mulberry32 state = { seed };
  return state;
}

static uint32_t mulberry32_next(Mulberry32 *state) {
  state->a = state->a + 0x6d2b79f5u;
  uint32_t t = state->a;
  t = (t ^ t >> 15) * (t | 1u);
  t ^= t + (t ^ t >> 7) * (t | 61u);
  return t ^ t >> 14;
}

static double mulberry32_sample(Mulberry32 *state) {
  return mulberry32_next(state) / 4294967296.0;
}

// pmndrs/math core/vec4
static void vec4_normalize(vec4 out, const vec4 a) {
  double x = a[0];
  double y = a[1];
  double z = a[2];
  double w = a[3];
  double len = x * x + y * y + z * z + w * w;
  if (len > 0) {
    len = 1 / sqrt(len);
  }
  out[0] = x * len;
  out[1] = y * len;
  out[2] = z * len;
  out[3] = w * len;
}

// pmndrs/math core/quat
static void quat_create(quat out) {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
}

static void quat_multiply(quat out, const quat a, const quat b) {
  double ax = a[0];
  double ay = a[1];
  double az = a[2];
  double aw = a[3];
  double bx = b[0];
  double by = b[1];
  double bz = b[2];
  double bw = b[3];
  out[0] = ax * bw + aw * bx + ay * bz - az * by;
  out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
}

static void quat_invert(quat out, const quat a) {
  double a0 = a[0];
  double a1 = a[1];
  double a2 = a[2];
  double a3 = a[3];
  double dot = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
  if (dot == 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return;
  }
  double inv_dot = 1.0 / dot;
  out[0] = -a0 * inv_dot;
  out[1] = -a1 * inv_dot;
  out[2] = -a2 * inv_dot;
  out[3] = a3 * inv_dot;
}

// quat.normalize is vec4.normalize
#define quat_normalize vec4_normalize

static quat *make_quats(uint32_t seed) {
  Mulberry32 rand = mulberry32_create(seed);
  quat *quats = malloc(N * sizeof(quat));
  for (int i = 0; i < N; i++) {
    double *q = quats[i];
    q[0] = mulberry32_sample(&rand) - 0.5;
    q[1] = mulberry32_sample(&rand) - 0.5;
    q[2] = mulberry32_sample(&rand) - 0.5;
    q[3] = mulberry32_sample(&rand) + 0.5;
    quat_normalize(q, q);
  }
  return quats;
}

static quat *a, *b;
static quat out, inv;

static void run(double *acc) {
  double sm = 0, si = 0;
  for (int i = 0; i < N; i++) {
    quat_multiply(out, a[i], b[i]);
    quat_normalize(out, out);
    sm += out[0] + out[3];
    quat_invert(inv, a[i]);
    quat_multiply(out, inv, b[i]);
    si += out[1] + out[2];
  }
  acc[0] = sm;
  acc[1] = si;
  acc[2] = out[0];
  acc[3] = out[1];
  acc[4] = out[2];
  acc[5] = out[3];
}

int main(void) {
  a = make_quats(1);
  b = make_quats(2);
  quat_create(out);
  quat_create(inv);

  double acc[6] = { 0 };
  for (int i = 0; i < N_WARMUP; i++) run(acc);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    run(acc);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum_f64(acc, 6), N * 2, 2, N_RUNS);
  free(a);
  free(b);
}
