// stdlib-gamma.c – the gamma function swept over 2^20 arguments through
// @stdlib/math/base/special/gamma from stdlib 0.4.1 (Apache-2.0; Copyright (c)
// The Stdlib Authors), Cephes' gamma by way of stdlib's JavaScript.
//
// Ported as written from the bundle stdlib-gamma.js holds: every function gamma
// reaches is a C function under the name stdlib's own C gives it (the package
// entry points stdlib_base_*; the private modules of gamma, pow, exp, rempio2
// and kernel-rempio2 under their module names), with the constants, the
// generated evaluators and every branch unchanged. That is gamma's Stirling
// series, which calls exp and pow, its recurrence and rational approximation,
// and its reflection for x < -33, which calls sin and through it rempio2 and
// kernel-rempio2 (Payne-Hanek); this sweep reaches neither the reflection nor
// sin's argument reduction, but the JavaScript carries them, and so does the
// port. Where two packages each define a private name, it takes its package
// as a prefix (exp_polyval_p, pow_polyval_p, EXP_LN2_HI, POW_LN2_HI, ...);
// constants that two modules define with one value are defined once. pow's
// HUGE and TINY and exp's OVERFLOW and UNDERFLOW are HUGE_VALUE, TINY_VALUE,
// EXP_OVERFLOW and EXP_UNDERFLOW, as in stdlib's C, since math.h defines the
// shorter names.
//
// The float64 word accessors, which the JavaScript performs through a
// Float64Array and a Uint32Array over one buffer, are memcpy between double
// and uint64_t; the two-element arrays the JavaScript fills (toWords, log2ax,
// logx, normalize, rempio2's y) are out-parameters, and the work arrays it
// keeps at module level (kernel-rempio2's F, Q, FQ, IQ, rempio2's TX, TY,
// sin's Y) are local arrays of the function that fills them. Words are
// uint32_t and the JavaScript's `| 0` values int32_t; where the JavaScript
// adds, subtracts or shifts words past 32 bits and reads the result back
// through ToInt32 or ToUint32, the C wraps in uint32_t. round is JavaScript's
// Math.round, written as stdlib's C writes it (libm round breaks ties away from
// zero). sqrt, floor and ceil (stdlib's are Math.sqrt, Math.floor, Math.ceil)
// and fabs (its abs) are the only libm calls.
//
// The sweep follows the package's benchmark: 4096 arguments uniform in
// [0, 171] (XorShift32 from 0x1234abcd), 2^20 evaluations per run cycling
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
static const double   LN2 = 0.6931471805599453;
static const double   PI = 3.141592653589793;
static const double   SQRT_TWO_PI = 2.5066282746310007;
static const double   EULERGAMMA = 0.5772156649015329;
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

// @stdlib/math/base/assert/is-negative-zero
static bool stdlib_base_is_negative_zero(double x) {
  return x == 0.0 && 1.0 / x == FLOAT64_NINF;
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

// @stdlib/math/base/special/round: Math.round, as stdlib's C writes it
static double stdlib_base_round(double x) {
  if (stdlib_base_is_nan(x)) {
    return NAN;
  }
  if (stdlib_base_is_negative_zero(x) || (x >= -0.5 && x < 0.0)) {
    return -0.0;
  }
  if (x > 0.0 && x < 0.5) {
    return 0.0;
  }
  if (x >= 4503599627370496.0 || x <= -4503599627370496.0) {
    return x;
  }
  return floor(x + 0.5);
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

// @stdlib/number/float64/base/get-low-word
static uint32_t stdlib_base_float64_get_low_word(double x) {
  uint64_t w;
  memcpy(&w, &x, sizeof w);
  return (uint32_t)w;
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

// @stdlib/math/base/special/kernel-cos: lib/polyval_c13.js, lib/polyval_c46.js
static double polyval_c13(double x) {
  if (x == 0.0) {
    return 0.0416666666666666;
  }
  return 0.0416666666666666 + x * (-0.001388888888887411 + x * 2.480158728947673e-5);
}

static double polyval_c46(double x) {
  if (x == 0.0) {
    return -2.7557314351390663e-7;
  }
  return -2.7557314351390663e-7 + x * (2.087572321298175e-9 + x * -1.1359647557788195e-11);
}

// @stdlib/math/base/special/kernel-cos
static double stdlib_base_kernel_cos(double x, double y) {
  double hz;
  double r;
  double w;
  double z;
  z = x * x;
  w = z * z;
  r = z * polyval_c13(z);
  r += w * w * polyval_c46(z);
  hz = 0.5 * z;
  w = 1.0 - hz;
  return w + (1.0 - w - hz + (z * r - x * y));
}

// @stdlib/math/base/special/kernel-sin
static const double S1 = -0.16666666666666632;
static const double S2 = 0.00833333333332249;
static const double S3 = -1.984126982985795e-4;
static const double S4 = 2.7557313707070068e-6;
static const double S5 = -2.5050760253406863e-8;
static const double S6 = 1.58969099521155e-10;

static double stdlib_base_kernel_sin(double x, double y) {
  double r;
  double v;
  double w;
  double z;
  z = x * x;
  w = z * z;
  r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  v = z * x;
  if (y == 0.0) {
    return x + v * (S1 + z * r);
  }
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

// @stdlib/math/base/special/kernel-rempio2
static const int32_t IPIO2[66] = {
  10680707,  7228996,  1387004,  2578385, 16069853, 12639074,
   9804092,  4427841, 16666979, 11263675, 12935607,  2387514,
   4345298, 14681673,  3074569, 13734428, 16653803,  1880361,
  10960616,  8533493,  3062596,  8710556,  7349940,  6258241,
   3772886,  3769171,  3798172,  8675211, 12450088,  3874808,
   9961438,   366607, 15675153,  9132554,  7151469,  3571407,
   2607881, 12013382,  4155038,  6285869,  7677882, 13102053,
  15825725,   473591,  9065106, 15363067,  6271263,  9264392,
   5636912,  4652155,  7056368, 13614112, 10155062,  1944035,
   9527646, 15080200,  6658437,  6231200,  6832269, 16767104,
   5075751,  3212806,  1398474,  7579849,  6349435, 12618859
};
static const double PIO2[8] = {
  1.570796251296997,
  7.549789415861596e-8,
  5.390302529957765e-15,
  3.282003415807913e-22,
  1.270655753080676e-29,
  1.2293330898111133e-36,
  2.7337005381646456e-44,
  2.1674168387780482e-51
};
static const double TWO24 = 16777216.0;
static const double TWON24 = 5.960464477539063e-8;

static int32_t compute(const double *x, double *y, int32_t jz, double *q, int32_t q0, int32_t jk, int32_t jv, int32_t jx, double *f) {
  int32_t iq[20];
  double fq[20];
  int32_t carry;
  double fw;
  int32_t ih;
  int32_t jp;
  int32_t i;
  int32_t k;
  int32_t n;
  int32_t j;
  double z;
  jp = jk;
  z = q[jz];
  j = jz;
  for (i = 0; j > 0; i++) {
    fw = (int32_t)(TWON24 * z);
    iq[i] = (int32_t)(z - TWO24 * fw);
    z = q[j - 1] + fw;
    j -= 1;
  }
  z = stdlib_base_ldexp(z, q0);
  z -= 8.0 * floor(z * 0.125);
  n = (int32_t)z;
  z -= n;
  ih = 0;
  if (q0 > 0) {
    i = iq[jz - 1] >> (24 - q0);
    n += i;
    iq[jz - 1] -= i << (24 - q0);
    ih = iq[jz - 1] >> (23 - q0);
  } else if (q0 == 0) {
    ih = iq[jz - 1] >> 23;
  } else if (z >= 0.5) {
    ih = 2;
  }
  if (ih > 0) {
    n += 1;
    carry = 0;
    for (i = 0; i < jz; i++) {
      j = iq[i];
      if (carry == 0) {
        if (j != 0) {
          carry = 1;
          iq[i] = 16777216 - j;
        }
      } else {
        iq[i] = 16777215 - j;
      }
    }
    if (q0 > 0) {
      switch (q0) {
        case 1:
          iq[jz - 1] &= 8388607;
          break;
        case 2:
          iq[jz - 1] &= 4194303;
          break;
      }
    }
    if (ih == 2) {
      z = 1.0 - z;
      if (carry != 0) {
        z -= stdlib_base_ldexp(1.0, q0);
      }
    }
  }
  if (z == 0.0) {
    j = 0;
    for (i = jz - 1; i >= jk; i--) {
      j |= iq[i];
    }
    if (j == 0) {
      for (k = 1; iq[jk - k] == 0; k++) {
      }
      for (i = jz + 1; i <= jz + k; i++) {
        f[jx + i] = IPIO2[jv + i];
        fw = 0.0;
        for (j = 0; j <= jx; j++) {
          fw += x[j] * f[jx + (i - j)];
        }
        q[i] = fw;
      }
      jz += k;
      return compute(x, y, jz, q, q0, jk, jv, jx, f);
    }
    jz -= 1;
    q0 -= 24;
    while (iq[jz] == 0) {
      jz -= 1;
      q0 -= 24;
    }
  } else {
    z = stdlib_base_ldexp(z, -q0);
    if (z >= TWO24) {
      fw = (int32_t)(TWON24 * z);
      iq[jz] = (int32_t)(z - TWO24 * fw);
      jz += 1;
      q0 += 24;
      iq[jz] = (int32_t)fw;
    } else {
      iq[jz] = (int32_t)z;
    }
  }
  fw = stdlib_base_ldexp(1.0, q0);
  for (i = jz; i >= 0; i--) {
    q[i] = fw * iq[i];
    fw *= TWON24;
  }
  for (i = jz; i >= 0; i--) {
    fw = 0.0;
    for (k = 0; k <= jp && k <= jz - i; k++) {
      fw += PIO2[k] * q[i + k];
    }
    fq[jz - i] = fw;
  }
  fw = 0.0;
  for (i = jz; i >= 0; i--) {
    fw += fq[i];
  }
  if (ih == 0) {
    y[0] = fw;
  } else {
    y[0] = -fw;
  }
  fw = fq[0] - fw;
  for (i = 1; i <= jz; i++) {
    fw += fq[i];
  }
  if (ih == 0) {
    y[1] = fw;
  } else {
    y[1] = -fw;
  }
  return n & 7;
}

static int32_t stdlib_base_kernel_rempio2(const double *x, double *y, int32_t e0, int32_t nx) {
  double f[20];
  double q[20];
  double fw;
  int32_t jk;
  int32_t jv;
  int32_t jx;
  int32_t jz;
  int32_t q0;
  int32_t i;
  int32_t j;
  int32_t m;
  jk = 4;
  jx = nx - 1;
  jv = (e0 - 3) / 24;
  if (jv < 0) {
    jv = 0;
  }
  q0 = e0 - 24 * (jv + 1);
  j = jv - jx;
  m = jx + jk;
  for (i = 0; i <= m; i++) {
    if (j < 0) {
      f[i] = 0.0;
    } else {
      f[i] = IPIO2[j];
    }
    j += 1;
  }
  for (i = 0; i <= jk; i++) {
    fw = 0.0;
    for (j = 0; j <= jx; j++) {
      fw += x[j] * f[jx + (i - j)];
    }
    q[i] = fw;
  }
  jz = jk;
  return compute(x, y, jz, q, q0, jk, jv, jx, f);
}

// @stdlib/math/base/special/rempio2: lib/rempio2_medium.js
static const double  INVPIO2 = 0.6366197723675814;
static const double  PIO2_1 = 1.5707963267341256;
static const double  PIO2_1T = 6.077100506506192e-11;
static const double  PIO2_2 = 6.077100506303966e-11;
static const double  PIO2_2T = 2.0222662487959506e-21;
static const double  PIO2_3 = 2.0222662487111665e-21;
static const double  PIO2_3T = 8.4784276603689e-32;
static const int32_t EXPONENT_MASK = 0x7ff;

static int32_t rempio2_medium(double x, int32_t ix, double *y) {
  uint32_t high;
  double n;
  double t;
  double r;
  double w;
  int32_t i;
  int32_t j;
  n = stdlib_base_round(x * INVPIO2);
  r = x - n * PIO2_1;
  w = n * PIO2_1T;
  j = ix >> 20;
  y[0] = r - w;
  high = stdlib_base_float64_get_high_word(y[0]);
  i = j - (int32_t)((high >> 20) & (uint32_t)EXPONENT_MASK);
  if (i > 16) {
    t = r;
    w = n * PIO2_2;
    r = t - w;
    w = n * PIO2_2T - (t - r - w);
    y[0] = r - w;
    high = stdlib_base_float64_get_high_word(y[0]);
    i = j - (int32_t)((high >> 20) & (uint32_t)EXPONENT_MASK);
    if (i > 49) {
      t = r;
      w = n * PIO2_3;
      r = t - w;
      w = n * PIO2_3T - (t - r - w);
      y[0] = r - w;
    }
  }
  y[1] = r - y[0] - w;
  return (int32_t)n;
}

// @stdlib/math/base/special/rempio2
static const double  ZERO = 0.0;
static const double  TWO_PIO2_1T = 2.0 * 6.077100506506192e-11;
static const double  THREE_PIO2_1T = 3.0 * 6.077100506506192e-11;
static const double  FOUR_PIO2_1T = 4.0 * 6.077100506506192e-11;
static const int32_t PI_HIGH_WORD_SIGNIFICAND = 0x921fb;
static const int32_t PIO4_HIGH_WORD = 0x3fe921fb;
static const int32_t THREE_PIO4_HIGH_WORD = 0x4002d97c;
static const int32_t FIVE_PIO4_HIGH_WORD = 0x400f6a7a;
static const int32_t THREE_PIO2_HIGH_WORD = 0x4012d97c;
static const int32_t SEVEN_PIO4_HIGH_WORD = 0x4015fdbc;
static const int32_t TWO_PI_HIGH_WORD = 0x401921fb;
static const int32_t NINE_PIO4_HIGH_WORD = 0x401c463b;
static const int32_t MEDIUM = 0x413921fb;

static int32_t stdlib_base_rempio2(double x, double *y) {
  double tx[3];
  double ty[2];
  uint32_t low;
  int32_t e0;
  int32_t hx;
  int32_t ix;
  int32_t nx;
  int32_t i;
  int32_t n;
  double z;
  hx = (int32_t)stdlib_base_float64_get_high_word(x);
  ix = (int32_t)((uint32_t)hx & FLOAT64_HIGH_WORD_ABS_MASK);
  if (ix <= PIO4_HIGH_WORD) {
    y[0] = x;
    y[1] = 0.0;
    return 0;
  }
  if (ix <= FIVE_PIO4_HIGH_WORD) {
    if ((ix & (int32_t)FLOAT64_HIGH_WORD_SIGNIFICAND_MASK) == PI_HIGH_WORD_SIGNIFICAND) {
      return rempio2_medium(x, ix, y);
    }
    if (ix <= THREE_PIO4_HIGH_WORD) {
      if (hx > 0) {
        z = x - PIO2_1;
        y[0] = z - PIO2_1T;
        y[1] = z - y[0] - PIO2_1T;
        return 1;
      }
      z = x + PIO2_1;
      y[0] = z + PIO2_1T;
      y[1] = z - y[0] + PIO2_1T;
      return -1;
    }
    if (hx > 0) {
      z = x - 2.0 * PIO2_1;
      y[0] = z - TWO_PIO2_1T;
      y[1] = z - y[0] - TWO_PIO2_1T;
      return 2;
    }
    z = x + 2.0 * PIO2_1;
    y[0] = z + TWO_PIO2_1T;
    y[1] = z - y[0] + TWO_PIO2_1T;
    return -2;
  }
  if (ix <= NINE_PIO4_HIGH_WORD) {
    if (ix <= SEVEN_PIO4_HIGH_WORD) {
      if (ix == THREE_PIO2_HIGH_WORD) {
        return rempio2_medium(x, ix, y);
      }
      if (hx > 0) {
        z = x - 3.0 * PIO2_1;
        y[0] = z - THREE_PIO2_1T;
        y[1] = z - y[0] - THREE_PIO2_1T;
        return 3;
      }
      z = x + 3.0 * PIO2_1;
      y[0] = z + THREE_PIO2_1T;
      y[1] = z - y[0] + THREE_PIO2_1T;
      return -3;
    }
    if (ix == TWO_PI_HIGH_WORD) {
      return rempio2_medium(x, ix, y);
    }
    if (hx > 0) {
      z = x - 4.0 * PIO2_1;
      y[0] = z - FOUR_PIO2_1T;
      y[1] = z - y[0] - FOUR_PIO2_1T;
      return 4;
    }
    z = x + 4.0 * PIO2_1;
    y[0] = z + FOUR_PIO2_1T;
    y[1] = z - y[0] + FOUR_PIO2_1T;
    return -4;
  }
  if (ix < MEDIUM) {
    return rempio2_medium(x, ix, y);
  }
  if (ix >= (int32_t)FLOAT64_HIGH_WORD_EXPONENT_MASK) {
    y[0] = NAN;
    y[1] = NAN;
    return 0;
  }
  low = stdlib_base_float64_get_low_word(x);
  e0 = (ix >> 20) - 1046;
  z = stdlib_base_float64_from_words((uint32_t)ix - ((uint32_t)e0 << 20), low);
  for (i = 0; i < 2; i++) {
    tx[i] = (int32_t)z;
    z = (z - tx[i]) * TWO24;
  }
  tx[2] = z;
  nx = 3;
  while (tx[nx - 1] == ZERO) {
    nx -= 1;
  }
  n = stdlib_base_kernel_rempio2(tx, ty, e0, nx);
  if (hx < 0) {
    y[0] = -ty[0];
    y[1] = -ty[1];
    return -n;
  }
  y[0] = ty[0];
  y[1] = ty[1];
  return n;
}

// @stdlib/math/base/special/sin
static const int32_t SMALL_HIGH_WORD = 0x3e500000;

static double stdlib_base_sin(double x) {
  double y[2];
  int32_t ix;
  int32_t n;
  ix = (int32_t)stdlib_base_float64_get_high_word(x);
  ix &= (int32_t)FLOAT64_HIGH_WORD_ABS_MASK;
  if (ix <= PIO4_HIGH_WORD) {
    if (ix < SMALL_HIGH_WORD) {
      return x;
    }
    return stdlib_base_kernel_sin(x, 0.0);
  }
  if (ix >= (int32_t)FLOAT64_HIGH_WORD_EXPONENT_MASK) {
    return NAN;
  }
  n = stdlib_base_rempio2(x, y);
  switch (n & 3) {
    case 0:
      return stdlib_base_kernel_sin(y[0], y[1]);
    case 1:
      return stdlib_base_kernel_cos(y[0], y[1]);
    case 2:
      return -stdlib_base_kernel_sin(y[0], y[1]);
    default:
      return -stdlib_base_kernel_cos(y[0], y[1]);
  }
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
static double pow_polyval_p(double x) {
  if (x == 0.0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6.613756321437934e-5 + x * (-1.6533902205465252e-6 + x * 4.1381367970572385e-8)));
}

// @stdlib/math/base/special/pow: lib/pow2.js
static const int32_t HIGH_BIASED_EXP_NEG_1 = 0x3fe00000;
static const double  POW_LN2_HI = 0.6931471824645996;
static const double  POW_LN2_LO = -1.904654299957768e-9;

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
  u = t * POW_LN2_HI;
  v = (lp - (t - hp)) * LN2 + t * POW_LN2_LO;
  z = u + v;
  w = v - (z - u);
  t = z * z;
  t1 = z - t * pow_polyval_p(t);
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

// @stdlib/math/base/special/exp: lib/polyval_p.js
static double exp_polyval_p(double x) {
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
  c = r - t * exp_polyval_p(t);
  y = 1.0 - (lo - r * c / (2.0 - c) - hi);
  return stdlib_base_ldexp(y, k);
}

// @stdlib/math/base/special/exp
static const double EXP_LN2_HI = 0.6931471803691238;
static const double EXP_LN2_LO = 1.9082149292705877e-10;
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
  hi = x - k * EXP_LN2_HI;
  lo = k * EXP_LN2_LO;
  return expmulti(hi, lo, (int32_t)k);
}

// @stdlib/math/base/special/gamma: lib/polyval_s.js
static double polyval_s(double x) {
  if (x == 0.0) {
    return 0.08333333333334822;
  }
  return 0.08333333333334822 + x * (0.0034722222160545866 + x * (-0.0026813261780578124 + x * (-2.2954996161337813e-4 + x * 7.873113957930937e-4)));
}

// @stdlib/math/base/special/gamma: lib/stirling_approximation.js
static const double MAX_STIRLING = 143.01608;

static double stirling_approximation(double x) {
  double w;
  double y;
  double v;
  w = 1.0 / x;
  w = 1.0 + w * polyval_s(w);
  y = stdlib_base_exp(x);
  if (x > MAX_STIRLING) {
    v = stdlib_base_pow(x, 0.5 * x - 0.25);
    y = v * (v / y);
  } else {
    y = stdlib_base_pow(x, x - 0.5) / y;
  }
  return SQRT_TWO_PI * y * w;
}

// @stdlib/math/base/special/gamma: lib/small_approximation.js
static double small_approximation(double x, double z) {
  return z / ((1.0 + EULERGAMMA * x) * x);
}

// @stdlib/math/base/special/gamma: lib/rational_pq.js
static double rational_pq(double x) {
  double ax;
  double s1;
  double s2;
  if (x == 0.0) {
    return 1.0;
  }
  if (x < 0.0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1.0) {
    s1 = 1.0 + x * (0.4942148268014971 + x * (0.20744822764843598 + x * (0.04763678004571372 + x * (0.010421379756176158 + x * (0.0011913514700658638 + x * (1.6011952247675185e-4 + x * 0.0))))));
    s2 = 1.0 + x * (0.0714304917030273 + x * (-0.23459179571824335 + x * (0.035823639860549865 + x * (0.011813978522206043 + x * (-0.004456419138517973 + x * (5.396055804933034e-4 + x * -2.3158187332412014e-5))))));
  } else {
    x = 1.0 / x;
    s1 = 0.0 + x * (1.6011952247675185e-4 + x * (0.0011913514700658638 + x * (0.010421379756176158 + x * (0.04763678004571372 + x * (0.20744822764843598 + x * (0.4942148268014971 + x * 1.0))))));
    s2 = -2.3158187332412014e-5 + x * (5.396055804933034e-4 + x * (-0.004456419138517973 + x * (0.011813978522206043 + x * (0.035823639860549865 + x * (-0.23459179571824335 + x * (0.0714304917030273 + x * 1.0))))));
  }
  return s1 / s2;
}

// @stdlib/math/base/special/gamma
static double stdlib_base_gamma(double x) {
  int32_t sign;
  double q;
  double p;
  double z;
  if ((stdlib_base_is_integer(x) && x < 0.0) || x == FLOAT64_NINF || stdlib_base_is_nan(x)) {
    return NAN;
  }
  if (x == 0.0) {
    if (stdlib_base_is_negative_zero(x)) {
      return FLOAT64_NINF;
    }
    return FLOAT64_PINF;
  }
  if (x > 171.61447887182297) {
    return FLOAT64_PINF;
  }
  if (x < -170.5674972726612) {
    return 0.0;
  }
  q = stdlib_base_abs(x);
  if (q > 33.0) {
    if (x >= 0.0) {
      return stirling_approximation(x);
    }
    p = floor(q);
    if (((int32_t)p & 1) == 0) {
      sign = -1;
    } else {
      sign = 1;
    }
    z = q - p;
    if (z > 0.5) {
      p += 1.0;
      z = q - p;
    }
    z = q * stdlib_base_sin(PI * z);
    return sign * PI / (stdlib_base_abs(z) * stirling_approximation(q));
  }
  z = 1.0;
  while (x >= 3.0) {
    x -= 1.0;
    z *= x;
  }
  while (x < 0.0) {
    if (x > -1e-9) {
      return small_approximation(x, z);
    }
    z /= x;
    x += 1.0;
  }
  while (x < 2.0) {
    if (x < 1e-9) {
      return small_approximation(x, z);
    }
    z /= x;
    x += 1.0;
  }
  if (x == 2.0) {
    return z;
  }
  x -= 2.0;
  return z * rational_pq(x);
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
  for (int i = 0; i < N_EVAL; i++) out[i] = stdlib_base_gamma(x[i & (N_IN - 1)]);
}

int main(void) {
  double *x = malloc(sizeof(double) * N_IN);
  double *out = malloc(sizeof(double) * N_EVAL);
  double samples[N_RUNS];

  uniform(x, N_IN, 0.0, 171.0, 0x1234abcdu);

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
