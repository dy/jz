// stdlib-exp.c – e^x swept over 2^20 arguments through @stdlib/math/base/special/exp
// from stdlib 0.4.1 (Apache-2.0; Copyright (c) The Stdlib Authors), FreeBSD
// msun's e_exp.c by way of Go's math package and stdlib's JavaScript.
//
// Ported as written from the bundle stdlib-exp.js holds: every function exp
// reaches is a C function under the name stdlib's own C gives it (the package
// entry points stdlib_base_*, the private expmulti and polyval_p), with the
// constants, the generated Horner evaluator and every branch unchanged (the
// bounds OVERFLOW and UNDERFLOW are EXP_OVERFLOW and EXP_UNDERFLOW, as in
// stdlib's C, since math.h defines the shorter names). The float64 word
// accessors, which the JavaScript performs through a Float64Array and a
// Uint32Array over one buffer, are memcpy between double and uint64_t; the
// two-element arrays the JavaScript fills (toWords, normalize) are
// out-parameters. floor and ceil (stdlib's floor and ceil are Math.floor and
// Math.ceil, which its trunc calls) and fabs (its abs) are the only libm calls.
//
// The sweep follows the package's benchmark: 4096 arguments uniform in
// [-50, 50] (XorShift32 from 0x1234abcd), 2^20 evaluations per run cycling
// through them, 5 warmup runs, the median of 21 timed. Checksum: benchlib
// checksumF64 over the 2^20 results.
#include "../_lib/bench.h"
#include <math.h>
#include <stdbool.h>
#include <stdlib.h>

#define N_IN     4096
#define N_EVAL   (1 << 20)
#define N_RUNS   21
#define N_WARMUP 5

// @stdlib/constants/float64/*
static const double   FLOAT64_PINF = INFINITY;
static const double   FLOAT64_NINF = -INFINITY;
static const double   FLOAT64_SMALLEST_NORMAL = 2.2250738585072014e-308;
static const int32_t  FLOAT64_EXPONENT_BIAS = 1023;
static const int32_t  FLOAT64_MAX_BASE2_EXPONENT = 1023;
static const int32_t  FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL = -1023;
static const int32_t  FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL = -1074;
static const uint32_t FLOAT64_HIGH_WORD_SIGN_MASK = 0x80000000u;
static const uint32_t FLOAT64_HIGH_WORD_ABS_MASK = 0x7fffffffu;
static const uint32_t FLOAT64_HIGH_WORD_EXPONENT_MASK = 0x7ff00000u;

// @stdlib/math/base/assert/is-nan
static bool stdlib_base_is_nan(double x) {
  return x != x;
}

// @stdlib/math/base/assert/is-infinite
static bool stdlib_base_is_infinite(double x) {
  return x == FLOAT64_PINF || x == FLOAT64_NINF;
}

// @stdlib/math/base/special/abs
static double stdlib_base_abs(double x) {
  return fabs(x);
}

// @stdlib/math/base/special/trunc
static double stdlib_base_trunc(double x) {
  if (x < 0.0) {
    return ceil(x);
  }
  return floor(x);
}

// @stdlib/number/float64/base/to-words
static void stdlib_base_float64_to_words(double x, uint32_t *high, uint32_t *low) {
  uint64_t w;
  memcpy(&w, &x, sizeof w);
  *high = (uint32_t)(w >> 32);
  *low = (uint32_t)w;
}

// @stdlib/number/float64/base/get-high-word
static uint32_t stdlib_base_float64_get_high_word(double x) {
  uint64_t w;
  memcpy(&w, &x, sizeof w);
  return (uint32_t)(w >> 32);
}

// @stdlib/number/float64/base/from-words
static double stdlib_base_float64_from_words(uint32_t high, uint32_t low) {
  uint64_t w = ((uint64_t)high << 32) | low;
  double x;
  memcpy(&x, &w, sizeof x);
  return x;
}

// @stdlib/math/base/special/copysign
static double stdlib_base_copysign(double x, double y) {
  uint32_t hx;
  uint32_t lx;
  uint32_t hy;
  stdlib_base_float64_to_words(x, &hx, &lx);
  hx &= FLOAT64_HIGH_WORD_ABS_MASK;
  hy = stdlib_base_float64_get_high_word(y);
  hy &= FLOAT64_HIGH_WORD_SIGN_MASK;
  hx |= hy;
  return stdlib_base_float64_from_words(hx, lx);
}

// @stdlib/number/float64/base/exponent
static int32_t stdlib_base_float64_exponent(double x) {
  uint32_t high = stdlib_base_float64_get_high_word(x);
  high = (high & FLOAT64_HIGH_WORD_EXPONENT_MASK) >> 20;
  return (int32_t)high - FLOAT64_EXPONENT_BIAS;
}

// @stdlib/number/float64/base/normalize
static const double SCALAR = 4503599627370496.0;

static void stdlib_base_float64_normalize(double x, double *y, int32_t *exp) {
  if (stdlib_base_is_nan(x) || stdlib_base_is_infinite(x)) {
    *y = x;
    *exp = 0;
    return;
  }
  if (x != 0.0 && stdlib_base_abs(x) < FLOAT64_SMALLEST_NORMAL) {
    *y = x * SCALAR;
    *exp = -52;
    return;
  }
  *y = x;
  *exp = 0;
}

// @stdlib/math/base/special/ldexp
static const double   TWO52_INV = 2.220446049250313e-16;
static const uint32_t CLEAR_EXP_MASK = 0x800fffffu;

static double stdlib_base_ldexp(double frac, int32_t exp) {
  uint32_t high;
  uint32_t low;
  int32_t e;
  double m;
  if (exp == 0 || frac == 0.0 || stdlib_base_is_nan(frac) || stdlib_base_is_infinite(frac)) {
    return frac;
  }
  stdlib_base_float64_normalize(frac, &frac, &e);
  exp += e;
  exp += stdlib_base_float64_exponent(frac);
  if (exp < FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL) {
    return stdlib_base_copysign(0.0, frac);
  }
  if (exp > FLOAT64_MAX_BASE2_EXPONENT) {
    if (frac < 0.0) {
      return FLOAT64_NINF;
    }
    return FLOAT64_PINF;
  }
  if (exp <= FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL) {
    exp += 52;
    m = TWO52_INV;
  } else {
    m = 1.0;
  }
  stdlib_base_float64_to_words(frac, &high, &low);
  high &= CLEAR_EXP_MASK;
  high |= (uint32_t)(exp + FLOAT64_EXPONENT_BIAS) << 20;
  return m * stdlib_base_float64_from_words(high, low);
}

// @stdlib/math/base/special/exp: lib/polyval_p.js
static double polyval_p(double x) {
  if (x == 0.0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6.613756321437934e-05 + x * (-1.6533902205465252e-06 + x * 4.1381367970572385e-08)));
}

// @stdlib/math/base/special/exp: lib/expmulti.js
static double expmulti(double hi, double lo, int32_t k) {
  double r;
  double t;
  double c;
  double y;
  r = hi - lo;
  t = r * r;
  c = r - t * polyval_p(t);
  y = 1.0 - (lo - r * c / (2.0 - c) - hi);
  return stdlib_base_ldexp(y, k);
}

// @stdlib/math/base/special/exp
static const double LN2_HI = 0.6931471803691238;
static const double LN2_LO = 1.9082149292705877e-10;
static const double LOG2_E = 1.4426950408889634;
static const double EXP_OVERFLOW = 709.782712893384;
static const double EXP_UNDERFLOW = -745.1332191019411;
static const double NEARZERO = 1.0 / (1 << 28);
static const double NEG_NEARZERO = -(1.0 / (1 << 28));

static double stdlib_base_exp(double x) {
  double hi;
  double lo;
  double k;
  if (stdlib_base_is_nan(x) || x == FLOAT64_PINF) {
    return x;
  }
  if (x == FLOAT64_NINF) {
    return 0.0;
  }
  if (x > EXP_OVERFLOW) {
    return FLOAT64_PINF;
  }
  if (x < EXP_UNDERFLOW) {
    return 0.0;
  }
  if (x > NEG_NEARZERO && x < NEARZERO) {
    return 1.0 + x;
  }
  if (x < 0.0) {
    k = stdlib_base_trunc(LOG2_E * x - 0.5);
  } else {
    k = stdlib_base_trunc(LOG2_E * x + 0.5);
  }
  hi = x - k * LN2_HI;
  lo = k * LN2_LO;
  return expmulti(hi, lo, (int32_t)k);
}

// XorShift32, uniform in [lo, hi): deterministic per target.
static void uniform(double *out, int n, double lo, double hi, uint32_t seed) {
  uint32_t s = seed;
  for (int i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    out[i] = lo + ((double)s / 4294967296.0) * (hi - lo);
  }
}

static void sweep(const double *x, double *out) {
  for (int i = 0; i < N_EVAL; i++) out[i] = stdlib_base_exp(x[i & (N_IN - 1)]);
}

int main(void) {
  double *x = malloc(sizeof(double) * N_IN);
  double *out = malloc(sizeof(double) * N_EVAL);
  double samples[N_RUNS];

  uniform(x, N_IN, -50.0, 50.0, 0x1234abcdu);

  for (int i = 0; i < N_WARMUP; i++) sweep(x, out);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    sweep(x, out);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64(out, N_EVAL), N_EVAL, 1, N_RUNS);
  free(x);
  free(out);
}
