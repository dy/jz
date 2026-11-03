// stdlib-pow.c – x^y swept over 2^20 argument pairs through @stdlib/math/base/special/pow
// from stdlib 0.4.1 (Apache-2.0; Copyright (c) The Stdlib Authors), FreeBSD
// msun's pow by way of stdlib's JavaScript.
//
// Ported as written from the bundle stdlib-pow.js holds: every function pow
// reaches is a C function under the name stdlib's own C gives it (the package
// entry points stdlib_base_*; pow's private modules x_is_zero, y_is_huge,
// y_is_infinite, log2ax, logx, pow2 and the generated polyval_l, polyval_w,
// polyval_p), with the constants, the Horner evaluators and every branch
// unchanged. Constants that two of pow's modules each define with one value
// are defined once; HUGE and TINY are HUGE_VALUE and TINY_VALUE, as in
// stdlib's C, since math.h defines HUGE. The float64 word accessors, which the
// JavaScript performs through a Float64Array and a Uint32Array over one
// buffer, are memcpy between double and uint64_t; the two-element arrays the
// JavaScript fills (toWords, log2ax, logx, normalize) are out-parameters.
// Words are uint32_t and the JavaScript's `| 0` values int32_t; where the
// JavaScript adds or subtracts words past 32 bits and reads the result back
// through ToInt32 or ToUint32 (pow2's high word, the underflow test), the C
// wraps in uint32_t. sqrt (stdlib's sqrt is Math.sqrt), floor (its floor, which
// is_integer calls) and fabs (its abs) are the only libm calls.
//
// The sweep follows the package's benchmark: 4096 bases uniform in [0, 100]
// (XorShift32 from 0x1234abcd) paired with 4096 exponents uniform in [-50, 50]
// (from 0x9e3779b9), 2^20 evaluations per run cycling through the pairs, 5
// warmup runs, the median of 21 timed. Checksum: benchlib checksumF64 over the
// 2^20 results.
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
static const double   LN2 = 0.6931471805599453;
static const int32_t  FLOAT64_EXPONENT_BIAS = 1023;
static const int32_t  FLOAT64_MAX_BASE2_EXPONENT = 1023;
static const int32_t  FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL = -1023;
static const int32_t  FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL = -1074;
static const int32_t  FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS = 20;
static const uint32_t FLOAT64_HIGH_WORD_SIGN_MASK = 0x80000000u;
static const uint32_t FLOAT64_HIGH_WORD_ABS_MASK = 0x7fffffffu;
static const uint32_t FLOAT64_HIGH_WORD_EXPONENT_MASK = 0x7ff00000u;
static const uint32_t FLOAT64_HIGH_WORD_SIGNIFICAND_MASK = 0x000fffffu;

// @stdlib/math/base/assert/is-nan
static bool stdlib_base_is_nan(double x) {
  return x != x;
}

// @stdlib/math/base/assert/is-integer
static bool stdlib_base_is_integer(double x) {
  return floor(x) == x;
}

// @stdlib/math/base/assert/is-even
static bool stdlib_base_is_even(double x) {
  return stdlib_base_is_integer(x / 2.0);
}

// @stdlib/math/base/assert/is-odd
static bool stdlib_base_is_odd(double x) {
  if (x > 0.0) {
    return stdlib_base_is_even(x - 1.0);
  }
  return stdlib_base_is_even(x + 1.0);
}

// @stdlib/math/base/assert/is-infinite
static bool stdlib_base_is_infinite(double x) {
  return x == FLOAT64_PINF || x == FLOAT64_NINF;
}

// @stdlib/math/base/special/abs
static double stdlib_base_abs(double x) {
  return fabs(x);
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

// @stdlib/number/float64/base/set-low-word
static double stdlib_base_float64_set_low_word(double x, uint32_t low) {
  uint64_t w;
  memcpy(&w, &x, sizeof w);
  w = (w & 0xffffffff00000000u) | low;
  memcpy(&x, &w, sizeof x);
  return x;
}

// @stdlib/number/float64/base/set-high-word
static double stdlib_base_float64_set_high_word(double x, uint32_t high) {
  uint64_t w;
  memcpy(&w, &x, sizeof w);
  w = (w & 0x00000000ffffffffu) | ((uint64_t)high << 32);
  memcpy(&x, &w, sizeof x);
  return x;
}

// @stdlib/number/uint32/base/to-int32
static int32_t stdlib_base_uint32_to_int32(uint32_t x) {
  return (int32_t)x;
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

// @stdlib/math/base/special/pow: lib/x_is_zero.js
static double x_is_zero(double x, double y) {
  if (y == FLOAT64_NINF) {
    return FLOAT64_PINF;
  }
  if (y == FLOAT64_PINF) {
    return 0.0;
  }
  if (y > 0.0) {
    if (stdlib_base_is_odd(y)) {
      return x;
    }
    return 0.0;
  }
  if (stdlib_base_is_odd(y)) {
    return stdlib_base_copysign(FLOAT64_PINF, x);
  }
  return FLOAT64_PINF;
}

// @stdlib/math/base/special/pow: lib/y_is_huge.js
static const int32_t HIGH_MAX_NEAR_UNITY = 0x3fefffff;
static const double  HUGE_VALUE = 1e300;
static const double  TINY_VALUE = 1e-300;

static double y_is_huge(double x, double y) {
  int32_t ahx;
  uint32_t hx;
  hx = stdlib_base_float64_get_high_word(x);
  ahx = (int32_t)(hx & FLOAT64_HIGH_WORD_ABS_MASK);
  if (ahx <= HIGH_MAX_NEAR_UNITY) {
    if (y < 0.0) {
      return HUGE_VALUE * HUGE_VALUE;
    }
    return TINY_VALUE * TINY_VALUE;
  }
  if (y > 0.0) {
    return HUGE_VALUE * HUGE_VALUE;
  }
  return TINY_VALUE * TINY_VALUE;
}

// @stdlib/math/base/special/pow: lib/y_is_infinite.js
static double y_is_infinite(double x, double y) {
  if (x == -1.0) {
    return (x - x) / (x - x);
  }
  if (x == 1.0) {
    return 1.0;
  }
  if ((stdlib_base_abs(x) < 1.0) == (y == FLOAT64_PINF)) {
    return 0.0;
  }
  return FLOAT64_PINF;
}

// @stdlib/math/base/special/pow: lib/polyval_l.js
static double polyval_l(double x) {
  if (x == 0.0) {
    return 0.5999999999999946;
  }
  return 0.5999999999999946 + x * (0.4285714285785502 + x * (0.33333332981837743 + x * (0.272728123808534 + x * (0.23066074577556175 + x * 0.20697501780033842))));
}

// @stdlib/math/base/special/pow: lib/log2ax.js
static const int32_t HIGH_SIGNIFICAND_MASK = 0x000fffff;
static const int32_t HIGH_MIN_NORMAL_EXP = 0x00100000;
static const int32_t HIGH_BIASED_EXP_0 = 0x3ff00000;
static const int32_t HIGH_BIASED_EXP_NEG_512 = 0x20000000;
static const int32_t HIGH_SIGNIFICAND_HALF = 0x00080000;
static const double  TWO53 = 9007199254740992.0;
static const double  CP = 0.9617966939259756;
static const double  CP_HI = 0.9617967009544373;
static const double  CP_LO = -7.028461650952758e-9;
static const double  BP[2] = { 1.0, 1.5 };
static const double  DP_HI[2] = { 0.0, 0.5849624872207642 };
static const double  DP_LO[2] = { 0.0, 1.350039202129749e-8 };

static void log2ax(double *o1, double *o2, double ax, int32_t ahx) {
  int32_t tmp;
  double ss;
  double s2;
  double hs;
  double ls;
  double ht;
  double lt;
  double bp;
  double dp;
  double hp;
  double lp;
  double hz;
  double lz;
  double t1;
  double t2;
  double t;
  double r;
  double u;
  double v;
  int32_t n;
  int32_t j;
  int32_t k;
  n = 0;
  if (ahx < HIGH_MIN_NORMAL_EXP) {
    ax *= TWO53;
    n -= 53;
    ahx = (int32_t)stdlib_base_float64_get_high_word(ax);
  }
  n += (ahx >> FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS) - FLOAT64_EXPONENT_BIAS;
  j = ahx & HIGH_SIGNIFICAND_MASK;
  ahx = j | HIGH_BIASED_EXP_0;
  if (j <= 235662) {
    k = 0;
  } else if (j < 767610) {
    k = 1;
  } else {
    k = 0;
    n += 1;
    ahx -= HIGH_MIN_NORMAL_EXP;
  }
  ax = stdlib_base_float64_set_high_word(ax, (uint32_t)ahx);
  bp = BP[k];
  u = ax - bp;
  v = 1.0 / (ax + bp);
  ss = u * v;
  hs = stdlib_base_float64_set_low_word(ss, 0);
  tmp = ((ahx >> 1) | HIGH_BIASED_EXP_NEG_512) + HIGH_SIGNIFICAND_HALF;
  tmp += k << 18;
  ht = stdlib_base_float64_set_high_word(0.0, (uint32_t)tmp);
  lt = ax - (ht - bp);
  ls = v * (u - hs * ht - hs * lt);
  s2 = ss * ss;
  r = s2 * s2 * polyval_l(s2);
  r += ls * (hs + ss);
  s2 = hs * hs;
  ht = 3.0 + s2 + r;
  ht = stdlib_base_float64_set_low_word(ht, 0);
  lt = r - (ht - 3.0 - s2);
  u = hs * ht;
  v = ls * ht + lt * ss;
  hp = u + v;
  hp = stdlib_base_float64_set_low_word(hp, 0);
  lp = v - (hp - u);
  hz = CP_HI * hp;
  lz = CP_LO * hp + lp * CP + DP_LO[k];
  dp = DP_HI[k];
  t = n;
  t1 = hz + lz + dp + t;
  t1 = stdlib_base_float64_set_low_word(t1, 0);
  t2 = lz - (t1 - t - dp - hz);
  *o1 = t1;
  *o2 = t2;
}

// @stdlib/math/base/special/pow: lib/polyval_w.js
static double polyval_w(double x) {
  if (x == 0.0) {
    return 0.5;
  }
  return 0.5 + x * (-0.3333333333333333 + x * 0.25);
}

// @stdlib/math/base/special/pow: lib/logx.js
static const double INV_LN2 = 1.4426950408889634;
static const double INV_LN2_HI = 1.4426950216293335;
static const double INV_LN2_LO = 1.9259629911266175e-8;

static void logx(double *o1, double *o2, double ax) {
  double t2;
  double t1;
  double t;
  double w;
  double u;
  double v;
  t = ax - 1.0;
  w = t * t * polyval_w(t);
  u = INV_LN2_HI * t;
  v = t * INV_LN2_LO - w * INV_LN2;
  t1 = u + v;
  t1 = stdlib_base_float64_set_low_word(t1, 0);
  t2 = v - (t1 - u);
  *o1 = t1;
  *o2 = t2;
}

// @stdlib/math/base/special/pow: lib/polyval_p.js
static double polyval_p(double x) {
  if (x == 0.0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6.613756321437934e-5 + x * (-1.6533902205465252e-6 + x * 4.1381367970572385e-8)));
}

// @stdlib/math/base/special/pow: lib/pow2.js
static const int32_t HIGH_BIASED_EXP_NEG_1 = 0x3fe00000;
static const double  LN2_HI = 0.6931471824645996;
static const double  LN2_LO = -1.904654299957768e-9;

static double pow2(int32_t j, double hp, double lp) {
  uint32_t tmp;
  double t1;
  double t;
  double r;
  double u;
  double v;
  double w;
  double z;
  int32_t n;
  int32_t i;
  int32_t k;
  i = (int32_t)((uint32_t)j & FLOAT64_HIGH_WORD_ABS_MASK);
  k = (i >> FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS) - FLOAT64_EXPONENT_BIAS;
  n = 0;
  if (i > HIGH_BIASED_EXP_NEG_1) {
    n = (int32_t)((uint32_t)j + (uint32_t)(HIGH_MIN_NORMAL_EXP >> (k + 1)));
    k = (int32_t)(((uint32_t)n & FLOAT64_HIGH_WORD_ABS_MASK) >> FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS) - FLOAT64_EXPONENT_BIAS;
    tmp = (uint32_t)n & ~(FLOAT64_HIGH_WORD_SIGNIFICAND_MASK >> k);
    t = stdlib_base_float64_set_high_word(0.0, tmp);
    n = (int32_t)((((uint32_t)n & FLOAT64_HIGH_WORD_SIGNIFICAND_MASK) | (uint32_t)HIGH_MIN_NORMAL_EXP) >> (FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS - k));
    if (j < 0) {
      n = -n;
    }
    hp -= t;
  }
  t = lp + hp;
  t = stdlib_base_float64_set_low_word(t, 0);
  u = t * LN2_HI;
  v = (lp - (t - hp)) * LN2 + t * LN2_LO;
  z = u + v;
  w = v - (z - u);
  t = z * z;
  t1 = z - t * polyval_p(t);
  r = z * t1 / (t1 - 2.0) - (w + z * w);
  z = 1.0 - (r - z);
  j = stdlib_base_uint32_to_int32(stdlib_base_float64_get_high_word(z));
  j = (int32_t)((uint32_t)j + ((uint32_t)n << FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS));
  if ((j >> FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS) <= 0) {
    z = stdlib_base_ldexp(z, n);
  } else {
    z = stdlib_base_float64_set_high_word(z, (uint32_t)j);
  }
  return z;
}

// @stdlib/math/base/special/pow
static const int32_t  HIGH_BIASED_EXP_31 = 0x41e00000;
static const int32_t  HIGH_BIASED_EXP_64 = 0x43f00000;
static const int32_t  HIGH_BIASED_EXP_10 = 0x40900000;
static const int32_t  HIGH_1075 = 0x4090cc00;
static const uint32_t HIGH_NEG_1075 = 0xc090cc00u;
static const int32_t  HIGH_NUM_NONSIGN_BITS = 31;
static const double   OVT = 8.008566259537294e-17;

static double stdlib_base_pow(double x, double y) {
  uint32_t hx;
  uint32_t lx;
  uint32_t hy;
  uint32_t ly;
  uint32_t hz;
  uint32_t lz;
  int32_t ahx;
  int32_t ahy;
  int32_t sx;
  int32_t sy;
  double ax;
  double y1;
  double hp;
  double lp;
  double t1;
  double t2;
  double z;
  int32_t j;
  int32_t i;
  if (stdlib_base_is_nan(x) || stdlib_base_is_nan(y)) {
    return NAN;
  }
  stdlib_base_float64_to_words(y, &hy, &ly);
  if (ly == 0) {
    if (y == 0.0) {
      return 1.0;
    }
    if (y == 1.0) {
      return x;
    }
    if (y == -1.0) {
      return 1.0 / x;
    }
    if (y == 0.5) {
      return sqrt(x);
    }
    if (y == -0.5) {
      return 1.0 / sqrt(x);
    }
    if (y == 2.0) {
      return x * x;
    }
    if (y == 3.0) {
      return x * x * x;
    }
    if (y == 4.0) {
      x *= x;
      return x * x;
    }
    if (stdlib_base_is_infinite(y)) {
      return y_is_infinite(x, y);
    }
  }
  stdlib_base_float64_to_words(x, &hx, &lx);
  if (lx == 0) {
    if (hx == 0) {
      return x_is_zero(x, y);
    }
    if (x == 1.0) {
      return 1.0;
    }
    if (x == -1.0 && stdlib_base_is_odd(y)) {
      return -1.0;
    }
    if (stdlib_base_is_infinite(x)) {
      if (x == FLOAT64_NINF) {
        return stdlib_base_pow(-0.0, -y);
      }
      if (y < 0.0) {
        return 0.0;
      }
      return FLOAT64_PINF;
    }
  }
  if (x < 0.0 && stdlib_base_is_integer(y) == false) {
    return (x - x) / (x - x);
  }
  ax = stdlib_base_abs(x);
  ahx = (int32_t)(hx & FLOAT64_HIGH_WORD_ABS_MASK);
  ahy = (int32_t)(hy & FLOAT64_HIGH_WORD_ABS_MASK);
  sx = (int32_t)(hx >> HIGH_NUM_NONSIGN_BITS);
  sy = (int32_t)(hy >> HIGH_NUM_NONSIGN_BITS);
  if (sx && stdlib_base_is_odd(y)) {
    sx = -1;
  } else {
    sx = 1;
  }
  if (ahy > HIGH_BIASED_EXP_31) {
    if (ahy > HIGH_BIASED_EXP_64) {
      return y_is_huge(x, y);
    }
    if (ahx < HIGH_MAX_NEAR_UNITY) {
      if (sy == 1) {
        return sx * HUGE_VALUE * HUGE_VALUE;
      }
      return sx * TINY_VALUE * TINY_VALUE;
    }
    if (ahx > HIGH_BIASED_EXP_0) {
      if (sy == 0) {
        return sx * HUGE_VALUE * HUGE_VALUE;
      }
      return sx * TINY_VALUE * TINY_VALUE;
    }
    logx(&t1, &t2, ax);
  } else {
    log2ax(&t1, &t2, ax, ahx);
  }
  y1 = stdlib_base_float64_set_low_word(y, 0);
  lp = (y - y1) * t1 + y * t2;
  hp = y1 * t1;
  z = lp + hp;
  stdlib_base_float64_to_words(z, &hz, &lz);
  j = stdlib_base_uint32_to_int32(hz);
  i = stdlib_base_uint32_to_int32(lz);
  if (j >= HIGH_BIASED_EXP_10) {
    if (((j - HIGH_BIASED_EXP_10) | i) != 0) {
      return sx * HUGE_VALUE * HUGE_VALUE;
    }
    if (lp + OVT > z - hp) {
      return sx * HUGE_VALUE * HUGE_VALUE;
    }
  } else if ((int32_t)((uint32_t)j & FLOAT64_HIGH_WORD_ABS_MASK) >= HIGH_1075) {
    if ((((uint32_t)j - HIGH_NEG_1075) | (uint32_t)i) != 0) {
      return sx * TINY_VALUE * TINY_VALUE;
    }
    if (lp <= z - hp) {
      return sx * TINY_VALUE * TINY_VALUE;
    }
  }
  z = pow2(j, hp, lp);
  return sx * z;
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

static void sweep(const double *x, const double *y, double *out) {
  for (int i = 0; i < N_EVAL; i++) out[i] = stdlib_base_pow(x[i & (N_IN - 1)], y[i & (N_IN - 1)]);
}

int main(void) {
  double *x = malloc(sizeof(double) * N_IN);
  double *y = malloc(sizeof(double) * N_IN);
  double *out = malloc(sizeof(double) * N_EVAL);
  double samples[N_RUNS];

  uniform(x, N_IN, 0.0, 100.0, 0x1234abcdu);
  uniform(y, N_IN, -50.0, 50.0, 0x9e3779b9u);

  for (int i = 0; i < N_WARMUP; i++) sweep(x, y, out);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    sweep(x, y, out);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64(out, N_EVAL), N_EVAL, 1, N_RUNS);
  free(x);
  free(y);
  free(out);
}
