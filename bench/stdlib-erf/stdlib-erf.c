// stdlib-erf.c – the error function swept over 2^20 arguments through
// @stdlib/math/base/special/erf from stdlib 0.4.1 (Apache-2.0; Copyright (c)
// The Stdlib Authors), FreeBSD msun's s_erf.c by way of stdlib's JavaScript.
//
// Ported as written from the bundle stdlib-erf.js holds: every function erf
// reaches is a C function under the name stdlib's own C gives it (the package
// entry points stdlib_base_*, the private generated evaluators polyval_*, exp's
// private expmulti), with the constants, the Horner evaluators and every branch
// unchanged. erf's tail for |x| >= 1.25 calls exp, so exp's whole chain (ldexp,
// normalize, exponent, copysign) is here, though this sweep never reaches it;
// exp's bounds OVERFLOW and UNDERFLOW are EXP_OVERFLOW and EXP_UNDERFLOW, as in
// stdlib's C, since math.h defines the shorter names. The float64 word
// accessors, which the JavaScript performs through a Float64Array and a
// Uint32Array over one buffer, are memcpy between double and uint64_t; the
// two-element arrays the JavaScript fills (toWords, normalize) are
// out-parameters. floor and ceil (stdlib's floor and ceil are Math.floor and
// Math.ceil, which its trunc calls) and fabs (its abs) are the only libm calls.
//
// The sweep follows the package's benchmark: 4096 arguments uniform in
// [-1, 1] (XorShift32 from 0x1234abcd), 2^20 evaluations per run cycling
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

// @stdlib/number/float64/base/set-low-word
static double stdlib_base_float64_set_low_word(double x, uint32_t low) {
  uint64_t w;
  memcpy(&w, &x, sizeof w);
  w = (w & 0xffffffff00000000u) | low;
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

// @stdlib/math/base/special/erf: lib/polyval_*.js
static double polyval_pp(double x) {
  if (x == 0.0) {
    return -0.3250421072470015;
  }
  return -0.3250421072470015 + x * (-0.02848174957559851 + x * (-0.005770270296489442 + x * -2.3763016656650163e-5));
}

static double polyval_qq(double x) {
  if (x == 0.0) {
    return 0.39791722395915535;
  }
  return 0.39791722395915535 + x * (0.0650222499887673 + x * (0.005081306281875766 + x * (1.3249473800432164e-4 + x * -3.960228278775368e-6)));
}

static double polyval_pa(double x) {
  if (x == 0.0) {
    return 0.41485611868374833;
  }
  return 0.41485611868374833 + x * (-0.3722078760357013 + x * (0.31834661990116175 + x * (-0.11089469428239668 + x * (0.035478304325618236 + x * -0.002166375594868791))));
}

static double polyval_qa(double x) {
  if (x == 0.0) {
    return 0.10642088040084423;
  }
  return 0.10642088040084423 + x * (0.540397917702171 + x * (0.07182865441419627 + x * (0.12617121980876164 + x * (0.01363708391202905 + x * 0.011984499846799107))));
}

static double polyval_ra(double x) {
  if (x == 0.0) {
    return -0.6938585727071818;
  }
  return -0.6938585727071818 + x * (-10.558626225323291 + x * (-62.375332450326006 + x * (-162.39666946257347 + x * (-184.60509290671104 + x * (-81.2874355063066 + x * -9.814329344169145)))));
}

static double polyval_sa(double x) {
  if (x == 0.0) {
    return 19.651271667439257;
  }
  return 19.651271667439257 + x * (137.65775414351904 + x * (434.56587747522923 + x * (645.3872717332679 + x * (429.00814002756783 + x * (108.63500554177944 + x * (6.570249770319282 + x * -0.0604244152148581))))));
}

static double polyval_rb(double x) {
  if (x == 0.0) {
    return -0.799283237680523;
  }
  return -0.799283237680523 + x * (-17.757954917754752 + x * (-160.63638485582192 + x * (-637.5664433683896 + x * (-1025.0951316110772 + x * -483.5191916086514))));
}

static double polyval_sb(double x) {
  if (x == 0.0) {
    return 30.33806074348246;
  }
  return 30.33806074348246 + x * (325.7925129965739 + x * (1536.729586084437 + x * (3199.8582195085955 + x * (2553.0504064331644 + x * (474.52854120695537 + x * -22.44095244658582)))));
}

// @stdlib/math/base/special/erf
static const double TINY = 1e-300;
static const double VERY_TINY = 2.848094538889218e-306;
static const double SMALL = 3.725290298461914e-9;
static const double ERX = 0.8450629115104675;
static const double EFX = 0.1283791670955126;
static const double EFX8 = 1.0270333367641007;
static const double PPC = 0.12837916709551256;
static const double QQC = 1.0;
static const double PAC = -0.0023621185607526594;
static const double QAC = 1.0;
static const double RAC = -0.009864944034847148;
static const double SAC = 1.0;
static const double RBC = -0.0098649429247001;
static const double SBC = 1.0;

static double stdlib_base_erf(double x) {
  bool sign;
  double ax;
  double z;
  double r;
  double s;
  double y;
  double p;
  double q;
  if (stdlib_base_is_nan(x)) {
    return NAN;
  }
  if (x == FLOAT64_PINF) {
    return 1.0;
  }
  if (x == FLOAT64_NINF) {
    return -1.0;
  }
  if (x == 0.0) {
    return x;
  }
  if (x < 0.0) {
    sign = true;
    ax = -x;
  } else {
    sign = false;
    ax = x;
  }
  if (ax < 0.84375) {
    if (ax < SMALL) {
      if (ax < VERY_TINY) {
        return 0.125 * (8.0 * x + EFX8 * x);
      }
      return x + EFX * x;
    }
    z = x * x;
    r = PPC + z * polyval_pp(z);
    s = QQC + z * polyval_qq(z);
    y = r / s;
    return x + x * y;
  }
  if (ax < 1.25) {
    s = ax - 1.0;
    p = PAC + s * polyval_pa(s);
    q = QAC + s * polyval_qa(s);
    if (sign) {
      return -ERX - p / q;
    }
    return ERX + p / q;
  }
  if (ax >= 6.0) {
    if (sign) {
      return TINY - 1.0;
    }
    return 1.0 - TINY;
  }
  s = 1.0 / (ax * ax);
  if (ax < 2.857142857142857) {
    r = RAC + s * polyval_ra(s);
    s = SAC + s * polyval_sa(s);
  } else {
    r = RBC + s * polyval_rb(s);
    s = SBC + s * polyval_sb(s);
  }
  z = stdlib_base_float64_set_low_word(ax, 0);
  r = stdlib_base_exp(-(z * z) - 0.5625) * stdlib_base_exp((z - ax) * (z + ax) + r / s);
  if (sign) {
    return r / ax - 1.0;
  }
  return 1.0 - r / ax;
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
  for (int i = 0; i < N_EVAL; i++) out[i] = stdlib_base_erf(x[i & (N_IN - 1)]);
}

int main(void) {
  double *x = malloc(sizeof(double) * N_IN);
  double *out = malloc(sizeof(double) * N_EVAL);
  double samples[N_RUNS];

  uniform(x, N_IN, -1.0, 1.0, 0x1234abcdu);

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
