// stdlib-dists.js — every function of @stdlib/stats/base/dists (stdlib 0.4.1, Apache-2.0) that takes
// numbers and returns one, or a list of them: 429 packages, bundled from their CommonJS sources by
// scripts/stdlib-probe.mjs (`bench-all stats/base/dists stdlib-dists`): the packages' own code with the
// module seams gone, nothing rewritten. Each function is swept over a domain where
// it is finite (the probe's `domain`: of reals, or of integers for a function of
// counts), the arguments after the first held; a list is stored as its sum.
// Left out (a sweep would dwarf the namespace, or jz does not compile it yet):
//   dists/studentized-range/cdf: 4.4 ms a call in Node
//   dists/studentized-range/quantile: 50.6 ms a call in Node
// Copyright (c) The Stdlib Authors. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0); the notices of the bundled files
// are retained by reference to the package.
import { mix, medianUs, printResult } from '../_lib/benchlib.js'

function isnan(x) {
  return x !== x;
}
var main_default = isnan;

var lib_default = main_default;

var sqrt = Math.sqrt;
var main_default2 = sqrt;

var lib_default2 = main_default2;

var FOURTH_PI = 0.7853981633974483;
var lib_default3 = FOURTH_PI;

function evalrational(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.16666666666666713;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -8.198089802484825 + x * (19.562619833175948 + x * (-16.262479672107002 + x * (5.444622390564711 + x * (-0.6019598008014124 + x * 0.004253011369004428))));
    s2 = -49.18853881490881 + x * (139.51056146574857 + x * (-147.1791292232726 + x * (70.49610280856842 + x * (-14.740913729888538 + x * 1))));
  } else {
    x = 1 / x;
    s1 = 0.004253011369004428 + x * (-0.6019598008014124 + x * (5.444622390564711 + x * (-16.262479672107002 + x * (19.562619833175948 + x * -8.198089802484825))));
    s2 = 1 + x * (-14.740913729888538 + x * (70.49610280856842 + x * (-147.1791292232726 + x * (139.51056146574857 + x * -49.18853881490881))));
  }
  return s1 / s2;
}
var rational_pq_default = evalrational;

function evalrational2(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.08333333333333809;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 28.536655482610616 + x * (-25.56901049652825 + x * (6.968710824104713 + x * (-0.5634242780008963 + x * 0.002967721961301243)));
    s2 = 342.43986579130785 + x * (-383.8770957603691 + x * (147.0656354026815 + x * (-21.947795316429207 + x * 1)));
  } else {
    x = 1 / x;
    s1 = 0.002967721961301243 + x * (-0.5634242780008963 + x * (6.968710824104713 + x * (-25.56901049652825 + x * 28.536655482610616)));
    s2 = 1 + x * (-21.947795316429207 + x * (147.0656354026815 + x * (-383.8770957603691 + x * 342.43986579130785)));
  }
  return s1 / s2;
}
var rational_rs_default = evalrational2;

var MOREBITS = 6123233995736766e-32;
function asin(x) {
  var sgn;
  var zz;
  var a;
  var p101;
  var z;
  if (lib_default(x)) {
    return NaN;
  }
  if (x > 0) {
    a = x;
  } else {
    sgn = true;
    a = -x;
  }
  if (a > 1) {
    return NaN;
  }
  if (a > 0.625) {
    zz = 1 - a;
    p101 = zz * rational_rs_default(zz);
    zz = lib_default2(zz + zz);
    z = lib_default3 - zz;
    zz = zz * p101 - MOREBITS;
    z -= zz;
    z += lib_default3;
  } else {
    if (a < 1e-8) {
      return x;
    }
    zz = a * a;
    z = zz * rational_pq_default(zz);
    z = a * z + a;
  }
  return sgn ? -z : z;
}
var main_default3 = asin;

var lib_default4 = main_default3;

var PI = 3.141592653589793;
var lib_default5 = PI;

var TWO_OVER_PI = 2 / lib_default5;
function cdf(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (x < a) {
    return 0;
  }
  if (x >= b) {
    return 1;
  }
  return TWO_OVER_PI * lib_default4(lib_default2((x - a) / (b - a)));
}
var main_default4 = cdf;

function wrap(value) {
  return constantFunction;
  function constantFunction() {
    return value;
  }
}
var main_default5 = wrap;

var lib_default6 = main_default5;

var TWO_OVER_PI2 = 2 / lib_default5;
function factory(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < a) {
      return 0;
    }
    if (x >= b) {
      return 1;
    }
    return TWO_OVER_PI2 * lib_default4(lib_default2((x - a) / (b - a)));
  }
}
var factory_default = factory;

main_default4.factory = factory_default;
var lib_default7 = main_default4;

var is_little_endian_default = true;

var HIGH;
if (is_little_endian_default === true) {
  HIGH = 1;
} else {
  HIGH = 0;
}
var high_default = HIGH;

var FLOAT64_VIEW = new Float64Array(1);
var UINT32_VIEW = new Uint32Array(FLOAT64_VIEW.buffer);
function getHighWord(x) {
  FLOAT64_VIEW[0] = x;
  return UINT32_VIEW[high_default];
}
var main_default6 = getHighWord;

var lib_default8 = main_default6;

var HIGH2;
if (is_little_endian_default === true) {
  HIGH2 = 1;
} else {
  HIGH2 = 0;
}
var high_default2 = HIGH2;

var FLOAT64_VIEW2 = new Float64Array(1);
var UINT32_VIEW2 = new Uint32Array(FLOAT64_VIEW2.buffer);
function setHighWord(x, high) {
  FLOAT64_VIEW2[0] = x;
  UINT32_VIEW2[high_default2] = high >>> 0;
  return FLOAT64_VIEW2[0];
}
var main_default7 = setHighWord;

var lib_default9 = main_default7;

var FLOAT64_EXPONENT_BIAS = 1023 | 0;
var lib_default10 = FLOAT64_EXPONENT_BIAS;

var FLOAT64_NINF = Number.NEGATIVE_INFINITY;
var lib_default11 = FLOAT64_NINF;

function evalpoly(x) {
  if (x === 0) {
    return 0.3999999999940942;
  }
  return 0.3999999999940942 + x * (0.22222198432149784 + x * 0.15313837699209373);
}
var polyval_p_default = evalpoly;

function evalpoly2(x) {
  if (x === 0) {
    return 0.6666666666666735;
  }
  return 0.6666666666666735 + x * (0.2857142874366239 + x * (0.1818357216161805 + x * 0.14798198605116586));
}
var polyval_q_default = evalpoly2;

var LN2_HI = 0.6931471803691238;
var LN2_LO = 19082149292705877e-26;
var TWO54 = 18014398509481984;
var ONE_THIRD = 0.3333333333333333;
var HIGH_SIGNIFICAND_MASK = 1048575 | 0;
var HIGH_MAX_NORMAL_EXP = 2146435072 | 0;
var HIGH_MIN_NORMAL_EXP = 1048576 | 0;
var HIGH_BIASED_EXP_0 = 1072693248 | 0;
function ln(x) {
  var hfsq;
  var hx;
  var t2;
  var t1;
  var k;
  var R;
  var f2;
  var i;
  var j;
  var s;
  var w;
  var z;
  if (x === 0) {
    return lib_default11;
  }
  if (lib_default(x) || x < 0) {
    return NaN;
  }
  hx = lib_default8(x);
  k = 0 | 0;
  if (hx < HIGH_MIN_NORMAL_EXP) {
    k -= 54 | 0;
    x *= TWO54;
    hx = lib_default8(x);
  }
  if (hx >= HIGH_MAX_NORMAL_EXP) {
    return x + x;
  }
  k += (hx >> 20) - lib_default10 | 0;
  hx &= HIGH_SIGNIFICAND_MASK;
  i = hx + 614244 & 1048576 | 0;
  x = lib_default9(x, hx | i ^ HIGH_BIASED_EXP_0);
  k += i >> 20 | 0;
  f2 = x - 1;
  if ((HIGH_SIGNIFICAND_MASK & 2 + hx) < 3) {
    if (f2 === 0) {
      if (k === 0) {
        return 0;
      }
      return k * LN2_HI + k * LN2_LO;
    }
    R = f2 * f2 * (0.5 - ONE_THIRD * f2);
    if (k === 0) {
      return f2 - R;
    }
    return k * LN2_HI - (R - k * LN2_LO - f2);
  }
  s = f2 / (2 + f2);
  z = s * s;
  i = hx - 398458 | 0;
  w = z * z;
  j = 440401 - hx | 0;
  t1 = w * polyval_p_default(w);
  t2 = z * polyval_q_default(w);
  i |= j;
  R = t2 + t1;
  if (i > 0) {
    hfsq = 0.5 * f2 * f2;
    if (k === 0) {
      return f2 - (hfsq - s * (hfsq + R));
    }
    return k * LN2_HI - (hfsq - (s * (hfsq + R) + k * LN2_LO) - f2);
  }
  if (k === 0) {
    return f2 - s * (f2 - R);
  }
  return k * LN2_HI - (s * (f2 - R) - k * LN2_LO - f2);
}
var main_default8 = ln;

var lib_default12 = main_default8;

var LN_FOURTH_PI = lib_default12(lib_default3);
function entropy(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  return LN_FOURTH_PI + lib_default12(b - a);
}
var main_default9 = entropy;

var lib_default13 = main_default9;

function kurtosis(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  return -1.5;
}
var main_default10 = kurtosis;

var lib_default14 = main_default10;

var LN_PI = 1.1447298858494002;
var lib_default15 = LN_PI;

var LN2 = 0.6931471805599453;
var lib_default16 = LN2;

function logcdf(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (x < a) {
    return lib_default11;
  }
  if (x >= b) {
    return 0;
  }
  return lib_default16 - lib_default15 + lib_default12(lib_default4(lib_default2((x - a) / (b - a))));
}
var main_default11 = logcdf;

function factory2(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < a) {
      return lib_default11;
    }
    if (x >= b) {
      return 0;
    }
    return lib_default16 - lib_default15 + lib_default12(lib_default4(lib_default2((x - a) / (b - a))));
  }
}
var factory_default2 = factory2;

main_default11.factory = factory_default2;
var lib_default17 = main_default11;

function logpdf(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (x < a || x > b) {
    return lib_default11;
  }
  return -(lib_default15 + lib_default12((x - a) * (b - x)) / 2);
}
var main_default12 = logpdf;

function factory3(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < a || x > b) {
      return lib_default11;
    }
    return -(lib_default15 + lib_default12((x - a) * (b - x)) / 2);
  }
}
var factory_default3 = factory3;

main_default12.factory = factory_default3;
var lib_default18 = main_default12;

function mean(a, b) {
  if (a >= b) {
    return NaN;
  }
  return 0.5 * (a + b);
}
var main_default13 = mean;

var lib_default19 = main_default13;

function median(a, b) {
  if (a >= b) {
    return NaN;
  }
  return 0.5 * (a + b);
}
var main_default14 = median;

var lib_default20 = main_default14;

function mode(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  return a;
}
var main_default15 = mode;

var lib_default21 = main_default15;

function pdf(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (x < a || x > b) {
    return 0;
  }
  return 1 / (lib_default5 * lib_default2((x - a) * (b - x)));
}
var main_default16 = pdf;

function factory4(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < a || x > b) {
      return 0;
    }
    return 1 / (lib_default5 * lib_default2((x - a) * (b - x)));
  }
}
var factory_default4 = factory4;

main_default16.factory = factory_default4;
var lib_default22 = main_default16;

var floor = Math.floor;
var main_default17 = floor;

var lib_default23 = main_default17;

function isInteger(x) {
  return lib_default23(x) === x;
}
var main_default18 = isInteger;

var lib_default24 = main_default18;

function isEven(x) {
  return lib_default24(x / 2);
}
var main_default19 = isEven;

var lib_default25 = main_default19;

function isOdd(x) {
  if (x > 0) {
    return lib_default25(x - 1);
  }
  return lib_default25(x + 1);
}
var main_default20 = isOdd;

var lib_default26 = main_default20;

var FLOAT64_PINF = Number.POSITIVE_INFINITY;
var lib_default27 = FLOAT64_PINF;

function isInfinite(x) {
  return x === lib_default27 || x === lib_default11;
}
var main_default21 = isInfinite;

var lib_default28 = main_default21;

function abs(x) {
  return Math.abs(x);
}
var main_default22 = abs;

var lib_default29 = main_default22;

var indices;
var HIGH3;
var LOW;
if (is_little_endian_default === true) {
  HIGH3 = 1;
  LOW = 0;
} else {
  HIGH3 = 0;
  LOW = 1;
}
indices = {
  "HIGH": HIGH3,
  "LOW": LOW
};
var indices_default = indices;

var FLOAT64_VIEW3 = new Float64Array(1);
var UINT32_VIEW3 = new Uint32Array(FLOAT64_VIEW3.buffer);
var HIGH4 = indices_default.HIGH;
var LOW2 = indices_default.LOW;
function toWords(x, out, stride, offset) {
  FLOAT64_VIEW3[0] = x;
  out[offset] = UINT32_VIEW3[HIGH4];
  out[offset + stride] = UINT32_VIEW3[LOW2];
  return out;
}
var assign_default = toWords;

function toWords2(x) {
  return assign_default(x, [0 >>> 0, 0 >>> 0], 1, 0);
}
var main_default23 = toWords2;

main_default23.assign = assign_default;
var lib_default30 = main_default23;

var LOW3;
if (is_little_endian_default === true) {
  LOW3 = 0;
} else {
  LOW3 = 1;
}
var low_default = LOW3;

var FLOAT64_VIEW4 = new Float64Array(1);
var UINT32_VIEW4 = new Uint32Array(FLOAT64_VIEW4.buffer);
function setLowWord(x, low) {
  FLOAT64_VIEW4[0] = x;
  UINT32_VIEW4[low_default] = low >>> 0;
  return FLOAT64_VIEW4[0];
}
var main_default24 = setLowWord;

var lib_default31 = main_default24;

function uint32ToInt32(x) {
  return x | 0;
}
var main_default25 = uint32ToInt32;

var lib_default32 = main_default25;

var FLOAT64_HIGH_WORD_ABS_MASK = 2147483647 >>> 0;
var lib_default33 = FLOAT64_HIGH_WORD_ABS_MASK;

var FLOAT64_HIGH_WORD_SIGN_MASK = 2147483648 >>> 0;
var lib_default34 = FLOAT64_HIGH_WORD_SIGN_MASK;

var indices2;
var HIGH5;
var LOW4;
if (is_little_endian_default === true) {
  HIGH5 = 1;
  LOW4 = 0;
} else {
  HIGH5 = 0;
  LOW4 = 1;
}
indices2 = {
  "HIGH": HIGH5,
  "LOW": LOW4
};
var indices_default2 = indices2;

var FLOAT64_VIEW5 = new Float64Array(1);
var UINT32_VIEW5 = new Uint32Array(FLOAT64_VIEW5.buffer);
var HIGH6 = indices_default2.HIGH;
var LOW5 = indices_default2.LOW;
function fromWords(high, low) {
  UINT32_VIEW5[HIGH6] = high;
  UINT32_VIEW5[LOW5] = low;
  return FLOAT64_VIEW5[0];
}
var main_default26 = fromWords;

var lib_default35 = main_default26;

var WORDS = [0, 0];
function copysign(x, y) {
  var hx;
  var hy;
  lib_default30.assign(x, WORDS, 1, 0);
  hx = WORDS[0];
  hx &= lib_default33;
  hy = lib_default8(y);
  hy &= lib_default34;
  hx |= hy;
  return lib_default35(hx, WORDS[1]);
}
var main_default27 = copysign;

var lib_default36 = main_default27;

function pow(x, y) {
  if (y === lib_default11) {
    return lib_default27;
  }
  if (y === lib_default27) {
    return 0;
  }
  if (y > 0) {
    if (lib_default26(y)) {
      return x;
    }
    return 0;
  }
  if (lib_default26(y)) {
    return lib_default36(lib_default27, x);
  }
  return lib_default27;
}
var x_is_zero_default = pow;

var HIGH_MAX_NEAR_UNITY = 1072693247 | 0;
var HUGE = 1e300;
var TINY = 1e-300;
function pow2(x, y) {
  var ahx;
  var hx;
  hx = lib_default8(x);
  ahx = hx & lib_default33;
  if (ahx <= HIGH_MAX_NEAR_UNITY) {
    if (y < 0) {
      return HUGE * HUGE;
    }
    return TINY * TINY;
  }
  if (y > 0) {
    return HUGE * HUGE;
  }
  return TINY * TINY;
}
var y_is_huge_default = pow2;

function pow3(x, y) {
  if (x === -1) {
    return (x - x) / (x - x);
  }
  if (x === 1) {
    return 1;
  }
  if (lib_default29(x) < 1 === (y === lib_default27)) {
    return 0;
  }
  return lib_default27;
}
var y_is_infinite_default = pow3;

var FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS = 20 | 0;
var lib_default37 = FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS;

function evalpoly3(x) {
  if (x === 0) {
    return 0.5999999999999946;
  }
  return 0.5999999999999946 + x * (0.4285714285785502 + x * (0.33333332981837743 + x * (0.272728123808534 + x * (0.23066074577556175 + x * 0.20697501780033842))));
}
var polyval_l_default = evalpoly3;

var HIGH_SIGNIFICAND_MASK2 = 1048575 | 0;
var HIGH_MIN_NORMAL_EXP2 = 1048576 | 0;
var HIGH_BIASED_EXP_02 = 1072693248 | 0;
var HIGH_BIASED_EXP_NEG_512 = 536870912 | 0;
var HIGH_SIGNIFICAND_HALF = 524288 | 0;
var TWO53 = 9007199254740992;
var CP = 0.9617966939259756;
var CP_HI = 0.9617967009544373;
var CP_LO = -7028461650952758e-24;
var BP = [
  1,
  1.5
];
var DP_HI = [
  0,
  0.5849624872207642
  // 0x3FE2B803, 0x40000000
];
var DP_LO = [
  0,
  1350039202129749e-23
  // 0x3E4CFDEB, 0x43CFD006
];
function log2ax(out, ax, ahx) {
  var tmp;
  var ss;
  var s2;
  var hs;
  var ls;
  var ht;
  var lt;
  var bp;
  var dp;
  var hp;
  var lp;
  var hz;
  var lz;
  var t1;
  var t2;
  var t;
  var r;
  var u;
  var v;
  var n;
  var j;
  var k;
  n = 0 | 0;
  if (ahx < HIGH_MIN_NORMAL_EXP2) {
    ax *= TWO53;
    n -= 53 | 0;
    ahx = lib_default8(ax);
  }
  n += (ahx >> lib_default37) - lib_default10 | 0;
  j = ahx & HIGH_SIGNIFICAND_MASK2 | 0;
  ahx = j | HIGH_BIASED_EXP_02 | 0;
  if (j <= 235662) {
    k = 0;
  } else if (j < 767610) {
    k = 1;
  } else {
    k = 0;
    n += 1 | 0;
    ahx -= HIGH_MIN_NORMAL_EXP2;
  }
  ax = lib_default9(ax, ahx);
  bp = BP[k];
  u = ax - bp;
  v = 1 / (ax + bp);
  ss = u * v;
  hs = lib_default31(ss, 0);
  tmp = (ahx >> 1 | HIGH_BIASED_EXP_NEG_512) + HIGH_SIGNIFICAND_HALF;
  tmp += k << 18;
  ht = lib_default9(0, tmp);
  lt = ax - (ht - bp);
  ls = v * (u - hs * ht - hs * lt);
  s2 = ss * ss;
  r = s2 * s2 * polyval_l_default(s2);
  r += ls * (hs + ss);
  s2 = hs * hs;
  ht = 3 + s2 + r;
  ht = lib_default31(ht, 0);
  lt = r - (ht - 3 - s2);
  u = hs * ht;
  v = ls * ht + lt * ss;
  hp = u + v;
  hp = lib_default31(hp, 0);
  lp = v - (hp - u);
  hz = CP_HI * hp;
  lz = CP_LO * hp + lp * CP + DP_LO[k];
  dp = DP_HI[k];
  t = n;
  t1 = hz + lz + dp + t;
  t1 = lib_default31(t1, 0);
  t2 = lz - (t1 - t - dp - hz);
  out[0] = t1;
  out[1] = t2;
  return out;
}
var log2ax_default = log2ax;

function evalpoly4(x) {
  if (x === 0) {
    return 0.5;
  }
  return 0.5 + x * (-0.3333333333333333 + x * 0.25);
}
var polyval_w_default = evalpoly4;

var INV_LN2 = 1.4426950408889634;
var INV_LN2_HI = 1.4426950216293335;
var INV_LN2_LO = 19259629911266175e-24;
function logx(out, ax) {
  var t2;
  var t1;
  var t;
  var w;
  var u;
  var v;
  t = ax - 1;
  w = t * t * polyval_w_default(t);
  u = INV_LN2_HI * t;
  v = t * INV_LN2_LO - w * INV_LN2;
  t1 = u + v;
  t1 = lib_default31(t1, 0);
  t2 = v - (t1 - u);
  out[0] = t1;
  out[1] = t2;
  return out;
}
var logx_default = logx;

var FLOAT64_MAX_BASE2_EXPONENT = 1023 | 0;
var lib_default38 = FLOAT64_MAX_BASE2_EXPONENT;

var FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL = -1023 | 0;
var lib_default39 = FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL;

var FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL = -1074 | 0;
var lib_default40 = FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL;

var FLOAT64_HIGH_WORD_EXPONENT_MASK = 2146435072;
var lib_default41 = FLOAT64_HIGH_WORD_EXPONENT_MASK;

function exponent(x) {
  var high = lib_default8(x);
  high = (high & lib_default41) >>> 20;
  return high - lib_default10 | 0;
}
var main_default28 = exponent;

var lib_default42 = main_default28;

var FLOAT64_SMALLEST_NORMAL = 22250738585072014e-324;
var lib_default43 = FLOAT64_SMALLEST_NORMAL;

var SCALAR = 4503599627370496;
function normalize(x, out, stride, offset) {
  if (lib_default(x) || lib_default28(x)) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  if (x !== 0 && lib_default29(x) < lib_default43) {
    out[offset] = x * SCALAR;
    out[offset + stride] = -52;
    return out;
  }
  out[offset] = x;
  out[offset + stride] = 0;
  return out;
}
var assign_default2 = normalize;

function normalize2(x) {
  return assign_default2(x, [0, 0], 1, 0);
}
var main_default29 = normalize2;

main_default29.assign = assign_default2;
var lib_default44 = main_default29;

var normalize3 = lib_default44.assign;
var TWO52_INV = 2220446049250313e-31;
var CLEAR_EXP_MASK = 2148532223 >>> 0;
var FRAC = [0, 0];
var WORDS2 = [0, 0];
function ldexp(frac, exp2) {
  var high;
  var m;
  if (exp2 === 0 || frac === 0 || // handles +-0
  lib_default(frac) || lib_default28(frac)) {
    return frac;
  }
  normalize3(frac, FRAC, 1, 0);
  frac = FRAC[0];
  exp2 += FRAC[1];
  exp2 += lib_default42(frac);
  if (exp2 < lib_default40) {
    return lib_default36(0, frac);
  }
  if (exp2 > lib_default38) {
    if (frac < 0) {
      return lib_default11;
    }
    return lib_default27;
  }
  if (exp2 <= lib_default39) {
    exp2 += 52;
    m = TWO52_INV;
  } else {
    m = 1;
  }
  lib_default30.assign(frac, WORDS2, 1, 0);
  high = WORDS2[0];
  high &= CLEAR_EXP_MASK;
  high |= exp2 + lib_default10 << 20;
  return m * lib_default35(high, WORDS2[1]);
}
var main_default30 = ldexp;

var lib_default45 = main_default30;

var FLOAT64_HIGH_WORD_SIGNIFICAND_MASK = 1048575;
var lib_default46 = FLOAT64_HIGH_WORD_SIGNIFICAND_MASK;

function evalpoly5(x) {
  if (x === 0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6613756321437934e-20 + x * (-16533902205465252e-22 + x * 41381367970572385e-24)));
}
var polyval_p_default2 = evalpoly5;

var HIGH_MIN_NORMAL_EXP3 = 1048576 | 0;
var HIGH_BIASED_EXP_NEG_1 = 1071644672 | 0;
var LN2_HI2 = 0.6931471824645996;
var LN2_LO2 = -1904654299957768e-24;
function pow22(j, hp, lp) {
  var tmp;
  var t1;
  var t;
  var r;
  var u;
  var v;
  var w;
  var z;
  var n;
  var i;
  var k;
  i = j & lib_default33 | 0;
  k = (i >> lib_default37) - lib_default10 | 0;
  n = 0;
  if (i > HIGH_BIASED_EXP_NEG_1) {
    n = j + (HIGH_MIN_NORMAL_EXP3 >> k + 1) >>> 0;
    k = ((n & lib_default33) >> lib_default37) - lib_default10 | 0;
    tmp = (n & ~(lib_default46 >> k)) >>> 0;
    t = lib_default9(0, tmp);
    n = (n & lib_default46 | HIGH_MIN_NORMAL_EXP3) >> lib_default37 - k >>> 0;
    if (j < 0) {
      n = -n;
    }
    hp -= t;
  }
  t = lp + hp;
  t = lib_default31(t, 0);
  u = t * LN2_HI2;
  v = (lp - (t - hp)) * lib_default16 + t * LN2_LO2;
  z = u + v;
  w = v - (z - u);
  t = z * z;
  t1 = z - t * polyval_p_default2(t);
  r = z * t1 / (t1 - 2) - (w + z * w);
  z = 1 - (r - z);
  j = lib_default8(z);
  j = lib_default32(j);
  j += n << lib_default37 >>> 0;
  if (j >> lib_default37 <= 0) {
    z = lib_default45(z, n);
  } else {
    z = lib_default9(z, j);
  }
  return z;
}
var pow2_default = pow22;

var HIGH_MAX_NEAR_UNITY2 = 1072693247 | 0;
var HIGH_BIASED_EXP_31 = 1105199104 | 0;
var HIGH_BIASED_EXP_64 = 1139802112 | 0;
var HIGH_BIASED_EXP_10 = 1083179008 | 0;
var HIGH_BIASED_EXP_03 = 1072693248 | 0;
var HIGH_1075 = 1083231232 | 0;
var HIGH_NEG_1075 = 3230714880 >>> 0;
var HIGH_NUM_NONSIGN_BITS = 31 | 0;
var HUGE2 = 1e300;
var TINY2 = 1e-300;
var OVT = 8008566259537294e-32;
var WORDS3 = [0 | 0, 0 | 0];
var LOG_WORKSPACE = [0, 0];
function pow4(x, y) {
  var ahx;
  var ahy;
  var ax;
  var hx;
  var lx;
  var hy;
  var ly;
  var sx;
  var sy;
  var y1;
  var hp;
  var lp;
  var t;
  var z;
  var j;
  var i;
  if (lib_default(x) || lib_default(y)) {
    return NaN;
  }
  lib_default30.assign(y, WORDS3, 1, 0);
  hy = WORDS3[0];
  ly = WORDS3[1];
  if (ly === 0) {
    if (y === 0) {
      return 1;
    }
    if (y === 1) {
      return x;
    }
    if (y === -1) {
      return 1 / x;
    }
    if (y === 0.5) {
      return lib_default2(x);
    }
    if (y === -0.5) {
      return 1 / lib_default2(x);
    }
    if (y === 2) {
      return x * x;
    }
    if (y === 3) {
      return x * x * x;
    }
    if (y === 4) {
      x *= x;
      return x * x;
    }
    if (lib_default28(y)) {
      return y_is_infinite_default(x, y);
    }
  }
  lib_default30.assign(x, WORDS3, 1, 0);
  hx = WORDS3[0];
  lx = WORDS3[1];
  if (lx === 0) {
    if (hx === 0) {
      return x_is_zero_default(x, y);
    }
    if (x === 1) {
      return 1;
    }
    if (x === -1 && lib_default26(y)) {
      return -1;
    }
    if (lib_default28(x)) {
      if (x === lib_default11) {
        return pow4(-0, -y);
      }
      if (y < 0) {
        return 0;
      }
      return lib_default27;
    }
  }
  if (x < 0 && lib_default24(y) === false) {
    return (x - x) / (x - x);
  }
  ax = lib_default29(x);
  ahx = hx & lib_default33 | 0;
  ahy = hy & lib_default33 | 0;
  sx = hx >>> HIGH_NUM_NONSIGN_BITS | 0;
  sy = hy >>> HIGH_NUM_NONSIGN_BITS | 0;
  if (sx && lib_default26(y)) {
    sx = -1;
  } else {
    sx = 1;
  }
  if (ahy > HIGH_BIASED_EXP_31) {
    if (ahy > HIGH_BIASED_EXP_64) {
      return y_is_huge_default(x, y);
    }
    if (ahx < HIGH_MAX_NEAR_UNITY2) {
      if (sy === 1) {
        return sx * HUGE2 * HUGE2;
      }
      return sx * TINY2 * TINY2;
    }
    if (ahx > HIGH_BIASED_EXP_03) {
      if (sy === 0) {
        return sx * HUGE2 * HUGE2;
      }
      return sx * TINY2 * TINY2;
    }
    t = logx_default(LOG_WORKSPACE, ax);
  } else {
    t = log2ax_default(LOG_WORKSPACE, ax, ahx);
  }
  y1 = lib_default31(y, 0);
  lp = (y - y1) * t[0] + y * t[1];
  hp = y1 * t[0];
  z = lp + hp;
  lib_default30.assign(z, WORDS3, 1, 0);
  j = lib_default32(WORDS3[0]);
  i = lib_default32(WORDS3[1]);
  if (j >= HIGH_BIASED_EXP_10) {
    if ((j - HIGH_BIASED_EXP_10 | i) !== 0) {
      return sx * HUGE2 * HUGE2;
    }
    if (lp + OVT > z - hp) {
      return sx * HUGE2 * HUGE2;
    }
  } else if ((j & lib_default33) >= HIGH_1075) {
    if ((j - HIGH_NEG_1075 | i) !== 0) {
      return sx * TINY2 * TINY2;
    }
    if (lp <= z - hp) {
      return sx * TINY2 * TINY2;
    }
  }
  z = pow2_default(j, hp, lp);
  return sx * z;
}
var main_default31 = pow4;

var lib_default47 = main_default31;

function evalpoly6(x) {
  if (x === 0) {
    return 0.0416666666666666;
  }
  return 0.0416666666666666 + x * (-0.001388888888887411 + x * 2480158728947673e-20);
}
var polyval_c13_default = evalpoly6;

function evalpoly7(x) {
  if (x === 0) {
    return -27557314351390663e-23;
  }
  return -27557314351390663e-23 + x * (2087572321298175e-24 + x * -11359647557788195e-27);
}
var polyval_c46_default = evalpoly7;

function kernelCos(x, y) {
  var hz;
  var r;
  var w;
  var z;
  z = x * x;
  w = z * z;
  r = z * polyval_c13_default(z);
  r += w * w * polyval_c46_default(z);
  hz = 0.5 * z;
  w = 1 - hz;
  return w + (1 - w - hz + (z * r - x * y));
}
var main_default32 = kernelCos;

var lib_default48 = main_default32;

var S1 = -0.16666666666666632;
var S2 = 0.00833333333332249;
var S3 = -1984126982985795e-19;
var S4 = 27557313707070068e-22;
var S5 = -25050760253406863e-24;
var S6 = 158969099521155e-24;
function kernelSin(x, y) {
  var r;
  var v;
  var w;
  var z;
  z = x * x;
  w = z * z;
  r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  v = z * x;
  if (y === 0) {
    return x + v * (S1 + z * r);
  }
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}
var main_default33 = kernelSin;

var lib_default49 = main_default33;

var LOW6;
if (is_little_endian_default === true) {
  LOW6 = 0;
} else {
  LOW6 = 1;
}
var low_default2 = LOW6;

var FLOAT64_VIEW6 = new Float64Array(1);
var UINT32_VIEW6 = new Uint32Array(FLOAT64_VIEW6.buffer);
function getLowWord(x) {
  FLOAT64_VIEW6[0] = x;
  return UINT32_VIEW6[low_default2];
}
var main_default34 = getLowWord;

var lib_default50 = main_default34;

function filled(value, len) {
  var arr;
  var i;
  arr = [];
  for (i = 0; i < len; i++) {
    arr.push(value);
  }
  return arr;
}
var main_default35 = filled;

var lib_default51 = main_default35;

function zeros(len) {
  return lib_default51(0, len);
}
var main_default36 = zeros;

var lib_default52 = main_default36;

var IPIO2 = [
  10680707,
  7228996,
  1387004,
  2578385,
  16069853,
  12639074,
  9804092,
  4427841,
  16666979,
  11263675,
  12935607,
  2387514,
  4345298,
  14681673,
  3074569,
  13734428,
  16653803,
  1880361,
  10960616,
  8533493,
  3062596,
  8710556,
  7349940,
  6258241,
  3772886,
  3769171,
  3798172,
  8675211,
  12450088,
  3874808,
  9961438,
  366607,
  15675153,
  9132554,
  7151469,
  3571407,
  2607881,
  12013382,
  4155038,
  6285869,
  7677882,
  13102053,
  15825725,
  473591,
  9065106,
  15363067,
  6271263,
  9264392,
  5636912,
  4652155,
  7056368,
  13614112,
  10155062,
  1944035,
  9527646,
  15080200,
  6658437,
  6231200,
  6832269,
  16767104,
  5075751,
  3212806,
  1398474,
  7579849,
  6349435,
  12618859
];
var PIO2 = [
  1.570796251296997,
  // 0x3FF921FB, 0x40000000
  7549789415861596e-23,
  // 0x3E74442D, 0x00000000
  5390302529957765e-30,
  // 0x3CF84698, 0x80000000
  3282003415807913e-37,
  // 0x3B78CC51, 0x60000000
  1270655753080676e-44,
  // 0x39F01B83, 0x80000000
  12293330898111133e-52,
  // 0x387A2520, 0x40000000
  27337005381646456e-60,
  // 0x36E38222, 0x80000000
  21674168387780482e-67
  // 0x3569F31D, 0x00000000
];
var TWO24 = 16777216;
var TWON24 = 5960464477539063e-23;
var F = lib_default52(20);
var Q = lib_default52(20);
var FQ = lib_default52(20);
var IQ = lib_default52(20);
function compute(x, y, jz, q, q0, jk, jv, jx, f2) {
  var carry;
  var fw;
  var ih;
  var jp;
  var i;
  var k;
  var n;
  var j;
  var z;
  jp = jk;
  z = q[jz];
  j = jz;
  for (i = 0; j > 0; i++) {
    fw = TWON24 * z | 0;
    IQ[i] = z - TWO24 * fw | 0;
    z = q[j - 1] + fw;
    j -= 1;
  }
  z = lib_default45(z, q0);
  z -= 8 * lib_default23(z * 0.125);
  n = z | 0;
  z -= n;
  ih = 0;
  if (q0 > 0) {
    i = IQ[jz - 1] >> 24 - q0;
    n += i;
    IQ[jz - 1] -= i << 24 - q0;
    ih = IQ[jz - 1] >> 23 - q0;
  } else if (q0 === 0) {
    ih = IQ[jz - 1] >> 23;
  } else if (z >= 0.5) {
    ih = 2;
  }
  if (ih > 0) {
    n += 1;
    carry = 0;
    for (i = 0; i < jz; i++) {
      j = IQ[i];
      if (carry === 0) {
        if (j !== 0) {
          carry = 1;
          IQ[i] = 16777216 - j;
        }
      } else {
        IQ[i] = 16777215 - j;
      }
    }
    if (q0 > 0) {
      switch (q0) {
        // eslint-disable-line default-case
        case 1:
          IQ[jz - 1] &= 8388607;
          break;
        case 2:
          IQ[jz - 1] &= 4194303;
          break;
      }
    }
    if (ih === 2) {
      z = 1 - z;
      if (carry !== 0) {
        z -= lib_default45(1, q0);
      }
    }
  }
  if (z === 0) {
    j = 0;
    for (i = jz - 1; i >= jk; i--) {
      j |= IQ[i];
    }
    if (j === 0) {
      for (k = 1; IQ[jk - k] === 0; k++) {
      }
      for (i = jz + 1; i <= jz + k; i++) {
        f2[jx + i] = IPIO2[jv + i];
        fw = 0;
        for (j = 0; j <= jx; j++) {
          fw += x[j] * f2[jx + (i - j)];
        }
        q[i] = fw;
      }
      jz += k;
      return compute(x, y, jz, q, q0, jk, jv, jx, f2);
    }
    jz -= 1;
    q0 -= 24;
    while (IQ[jz] === 0) {
      jz -= 1;
      q0 -= 24;
    }
  } else {
    z = lib_default45(z, -q0);
    if (z >= TWO24) {
      fw = TWON24 * z | 0;
      IQ[jz] = z - TWO24 * fw | 0;
      jz += 1;
      q0 += 24;
      IQ[jz] = fw;
    } else {
      IQ[jz] = z | 0;
    }
  }
  fw = lib_default45(1, q0);
  for (i = jz; i >= 0; i--) {
    q[i] = fw * IQ[i];
    fw *= TWON24;
  }
  for (i = jz; i >= 0; i--) {
    fw = 0;
    for (k = 0; k <= jp && k <= jz - i; k++) {
      fw += PIO2[k] * q[i + k];
    }
    FQ[jz - i] = fw;
  }
  fw = 0;
  for (i = jz; i >= 0; i--) {
    fw += FQ[i];
  }
  if (ih === 0) {
    y[0] = fw;
  } else {
    y[0] = -fw;
  }
  fw = FQ[0] - fw;
  for (i = 1; i <= jz; i++) {
    fw += FQ[i];
  }
  if (ih === 0) {
    y[1] = fw;
  } else {
    y[1] = -fw;
  }
  return n & 7;
}
function kernelRempio2(x, y, e0, nx) {
  var fw;
  var jk;
  var jv;
  var jx;
  var jz;
  var q0;
  var i;
  var j;
  var m;
  jk = 4;
  jx = nx - 1;
  jv = (e0 - 3) / 24 | 0;
  if (jv < 0) {
    jv = 0;
  }
  q0 = e0 - 24 * (jv + 1);
  j = jv - jx;
  m = jx + jk;
  for (i = 0; i <= m; i++) {
    if (j < 0) {
      F[i] = 0;
    } else {
      F[i] = IPIO2[j];
    }
    j += 1;
  }
  for (i = 0; i <= jk; i++) {
    fw = 0;
    for (j = 0; j <= jx; j++) {
      fw += x[j] * F[jx + (i - j)];
    }
    Q[i] = fw;
  }
  jz = jk;
  return compute(x, y, jz, Q, q0, jk, jv, jx, F);
}
var kernel_rempio2_default = kernelRempio2;

var round = Math.round;
var main_default37 = round;

var lib_default53 = main_default37;

var INVPIO2 = 0.6366197723675814;
var PIO2_1 = 1.5707963267341256;
var PIO2_1T = 6077100506506192e-26;
var PIO2_2 = 6077100506303966e-26;
var PIO2_2T = 20222662487959506e-37;
var PIO2_3 = 20222662487111665e-37;
var PIO2_3T = 84784276603689e-45;
var EXPONENT_MASK = 2047 | 0;
function rempio2Medium(x, ix, y) {
  var high;
  var n;
  var t;
  var r;
  var w;
  var i;
  var j;
  n = lib_default53(x * INVPIO2);
  r = x - n * PIO2_1;
  w = n * PIO2_1T;
  j = ix >> 20 | 0;
  y[0] = r - w;
  high = lib_default8(y[0]);
  i = j - (high >> 20 & EXPONENT_MASK);
  if (i > 16) {
    t = r;
    w = n * PIO2_2;
    r = t - w;
    w = n * PIO2_2T - (t - r - w);
    y[0] = r - w;
    high = lib_default8(y[0]);
    i = j - (high >> 20 & EXPONENT_MASK);
    if (i > 49) {
      t = r;
      w = n * PIO2_3;
      r = t - w;
      w = n * PIO2_3T - (t - r - w);
      y[0] = r - w;
    }
  }
  y[1] = r - y[0] - w;
  return n;
}
var rempio2_medium_default = rempio2Medium;

var ZERO = 0;
var TWO242 = 16777216;
var PIO2_12 = 1.5707963267341256;
var PIO2_1T2 = 6077100506506192e-26;
var TWO_PIO2_1T = 2 * PIO2_1T2;
var THREE_PIO2_1T = 3 * PIO2_1T2;
var FOUR_PIO2_1T = 4 * PIO2_1T2;
var PI_HIGH_WORD_SIGNIFICAND = 598523 | 0;
var PIO4_HIGH_WORD = 1072243195 | 0;
var THREE_PIO4_HIGH_WORD = 1073928572 | 0;
var FIVE_PIO4_HIGH_WORD = 1074752122 | 0;
var THREE_PIO2_HIGH_WORD = 1074977148 | 0;
var SEVEN_PIO4_HIGH_WORD = 1075183036 | 0;
var TWO_PI_HIGH_WORD = 1075388923 | 0;
var NINE_PIO4_HIGH_WORD = 1075594811 | 0;
var MEDIUM = 1094263291 | 0;
var TX = [0, 0, 0];
var TY = [0, 0];
function rempio2(x, y) {
  var low;
  var e0;
  var hx;
  var ix;
  var nx;
  var i;
  var n;
  var z;
  hx = lib_default8(x) | 0;
  ix = hx & lib_default33 | 0;
  if (ix <= PIO4_HIGH_WORD) {
    y[0] = x;
    y[1] = 0;
    return 0;
  }
  if (ix <= FIVE_PIO4_HIGH_WORD) {
    if ((ix & lib_default46) === PI_HIGH_WORD_SIGNIFICAND) {
      return rempio2_medium_default(x, ix, y);
    }
    if (ix <= THREE_PIO4_HIGH_WORD) {
      if (hx > 0) {
        z = x - PIO2_12;
        y[0] = z - PIO2_1T2;
        y[1] = z - y[0] - PIO2_1T2;
        return 1;
      }
      z = x + PIO2_12;
      y[0] = z + PIO2_1T2;
      y[1] = z - y[0] + PIO2_1T2;
      return -1;
    }
    if (hx > 0) {
      z = x - 2 * PIO2_12;
      y[0] = z - TWO_PIO2_1T;
      y[1] = z - y[0] - TWO_PIO2_1T;
      return 2;
    }
    z = x + 2 * PIO2_12;
    y[0] = z + TWO_PIO2_1T;
    y[1] = z - y[0] + TWO_PIO2_1T;
    return -2;
  }
  if (ix <= NINE_PIO4_HIGH_WORD) {
    if (ix <= SEVEN_PIO4_HIGH_WORD) {
      if (ix === THREE_PIO2_HIGH_WORD) {
        return rempio2_medium_default(x, ix, y);
      }
      if (hx > 0) {
        z = x - 3 * PIO2_12;
        y[0] = z - THREE_PIO2_1T;
        y[1] = z - y[0] - THREE_PIO2_1T;
        return 3;
      }
      z = x + 3 * PIO2_12;
      y[0] = z + THREE_PIO2_1T;
      y[1] = z - y[0] + THREE_PIO2_1T;
      return -3;
    }
    if (ix === TWO_PI_HIGH_WORD) {
      return rempio2_medium_default(x, ix, y);
    }
    if (hx > 0) {
      z = x - 4 * PIO2_12;
      y[0] = z - FOUR_PIO2_1T;
      y[1] = z - y[0] - FOUR_PIO2_1T;
      return 4;
    }
    z = x + 4 * PIO2_12;
    y[0] = z + FOUR_PIO2_1T;
    y[1] = z - y[0] + FOUR_PIO2_1T;
    return -4;
  }
  if (ix < MEDIUM) {
    return rempio2_medium_default(x, ix, y);
  }
  if (ix >= lib_default41) {
    y[0] = NaN;
    y[1] = NaN;
    return 0;
  }
  low = lib_default50(x);
  e0 = (ix >> 20) - 1046;
  z = lib_default35(ix - (e0 << 20 | 0), low);
  for (i = 0; i < 2; i++) {
    TX[i] = z | 0;
    z = (z - TX[i]) * TWO242;
  }
  TX[2] = z;
  nx = 3;
  while (TX[nx - 1] === ZERO) {
    nx -= 1;
  }
  n = kernel_rempio2_default(TX, TY, e0, nx, 1);
  if (hx < 0) {
    y[0] = -TY[0];
    y[1] = -TY[1];
    return -n;
  }
  y[0] = TY[0];
  y[1] = TY[1];
  return n;
}
var main_default38 = rempio2;

var lib_default54 = main_default38;

var PIO4_HIGH_WORD2 = 1072243195 | 0;
var SMALL_HIGH_WORD = 1045430272 | 0;
var Y = [0, 0];
function sin(x) {
  var ix;
  var n;
  ix = lib_default8(x);
  ix &= lib_default33;
  if (ix <= PIO4_HIGH_WORD2) {
    if (ix < SMALL_HIGH_WORD) {
      return x;
    }
    return lib_default49(x, 0);
  }
  if (ix >= lib_default41) {
    return NaN;
  }
  n = lib_default54(x, Y);
  switch (n & 3) {
    case 0:
      return lib_default49(Y[0], Y[1]);
    case 1:
      return lib_default48(Y[0], Y[1]);
    case 2:
      return -lib_default49(Y[0], Y[1]);
    default:
      return -lib_default48(Y[0], Y[1]);
  }
}
var main_default39 = sin;

var lib_default55 = main_default39;

var HALF_PI = 1.5707963267948966;
var lib_default56 = HALF_PI;

function quantile(p101, a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return a + lib_default47(lib_default55(lib_default56 * p101), 2) * (b - a);
}
var main_default40 = quantile;

function factory5(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return a + lib_default47(lib_default55(lib_default56 * p101), 2) * (b - a);
  }
}
var factory_default5 = factory5;

main_default40.factory = factory_default5;
var lib_default57 = main_default40;

function skewness(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  return 0;
}
var main_default41 = skewness;

var lib_default58 = main_default41;

var SQRT1OVER8 = 0.35355339059327373;
function stdev(a, b) {
  if (a >= b) {
    return NaN;
  }
  return SQRT1OVER8 * (b - a);
}
var main_default42 = stdev;

var lib_default59 = main_default42;

function variance(a, b) {
  if (a >= b) {
    return NaN;
  }
  return 0.125 * lib_default47(b - a, 2);
}
var main_default43 = variance;

var lib_default60 = main_default43;

function cdf2(x, p101) {
  if (lib_default(x) || lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return 1 - p101;
}
var main_default44 = cdf2;

function factory6(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    if (x >= 1) {
      return 1;
    }
    return 1 - p101;
  }
}
var factory_default6 = factory6;

main_default44.factory = factory_default6;
var lib_default61 = main_default44;

function entropy2(p101) {
  var q;
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (p101 === 0 || p101 === 1) {
    return 0;
  }
  q = 1 - p101;
  return -q * lib_default12(q) - p101 * lib_default12(p101);
}
var main_default45 = entropy2;

var lib_default62 = main_default45;

function kurtosis2(p101) {
  var pq;
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  pq = p101 * (1 - p101);
  return 1 / pq - 6;
}
var main_default46 = kurtosis2;

var lib_default63 = main_default46;

function mean2(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return p101;
}
var main_default47 = mean2;

var lib_default64 = main_default47;

function median2(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return p101 <= 0.5 ? 0 : 1;
}
var main_default48 = median2;

var lib_default65 = main_default48;

var ceil = Math.ceil;
var main_default49 = ceil;

var lib_default66 = main_default49;

function trunc(x) {
  if (x < 0) {
    return lib_default66(x);
  }
  return lib_default23(x);
}
var main_default50 = trunc;

var lib_default67 = main_default50;

function evalpoly8(x) {
  if (x === 0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6613756321437934e-20 + x * (-16533902205465252e-22 + x * 41381367970572385e-24)));
}
var polyval_p_default3 = evalpoly8;

function expmulti(hi, lo, k) {
  var r;
  var t;
  var c2;
  var y;
  r = hi - lo;
  t = r * r;
  c2 = r - t * polyval_p_default3(t);
  y = 1 - (lo - r * c2 / (2 - c2) - hi);
  return lib_default45(y, k);
}
var expmulti_default = expmulti;

var LN2_HI3 = 0.6931471803691238;
var LN2_LO3 = 19082149292705877e-26;
var LOG2_E = 1.4426950408889634;
var OVERFLOW = 709.782712893384;
var UNDERFLOW = -745.1332191019411;
var NEARZERO = 1 / (1 << 28);
var NEG_NEARZERO = -NEARZERO;
function exp(x) {
  var hi;
  var lo;
  var k;
  if (lib_default(x) || x === lib_default27) {
    return x;
  }
  if (x === lib_default11) {
    return 0;
  }
  if (x > OVERFLOW) {
    return lib_default27;
  }
  if (x < UNDERFLOW) {
    return 0;
  }
  if (x > NEG_NEARZERO && x < NEARZERO) {
    return 1 + x;
  }
  if (x < 0) {
    k = lib_default67(LOG2_E * x - 0.5);
  } else {
    k = lib_default67(LOG2_E * x + 0.5);
  }
  hi = x - k * LN2_HI3;
  lo = k * LN2_LO3;
  return expmulti_default(hi, lo, k);
}
var main_default51 = exp;

var lib_default68 = main_default51;

function mgf(t, p101) {
  if (lib_default(t) || lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return 1 - p101 + p101 * lib_default68(t);
}
var main_default52 = mgf;

function factory7(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (lib_default(t)) {
      return NaN;
    }
    return 1 - p101 + p101 * lib_default68(t);
  }
}
var factory_default7 = factory7;

main_default52.factory = factory_default7;
var lib_default69 = main_default52;

function mode2(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return p101 <= 0.5 ? 0 : 1;
}
var main_default53 = mode2;

var lib_default70 = main_default53;

function pmf(x, p101) {
  if (lib_default(x) || lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (x === 0) {
    return 1 - p101;
  }
  if (x === 1) {
    return p101;
  }
  return 0;
}
var main_default54 = pmf;

function factory8(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return pmf8;
  function pmf8(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x === 0) {
      return 1 - p101;
    }
    if (x === 1) {
      return p101;
    }
    return 0;
  }
}
var factory_default8 = factory8;

main_default54.factory = factory_default8;
var lib_default71 = main_default54;

function quantile2(r, p101) {
  if (lib_default(p101) || lib_default(r) || p101 < 0 || p101 > 1 || r < 0 || r > 1) {
    return NaN;
  }
  if (r <= 1 - p101) {
    return 0;
  }
  return 1;
}
var main_default55 = quantile2;

function factory9(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(r) {
    if (lib_default(r) || r < 0 || r > 1) {
      return NaN;
    }
    if (r <= 1 - p101) {
      return 0;
    }
    return 1;
  }
}
var factory_default9 = factory9;

main_default55.factory = factory_default9;
var lib_default72 = main_default55;

function skewness2(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (p101 === 0) {
    return lib_default27;
  }
  if (p101 === 1) {
    return lib_default11;
  }
  return (1 - 2 * p101) / lib_default2(p101 * (1 - p101));
}
var main_default56 = skewness2;

var lib_default73 = main_default56;

function variance2(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return p101 * (1 - p101);
}
var main_default57 = variance2;

var lib_default74 = main_default57;

function stdev2(p101) {
  return lib_default2(lib_default74(p101));
}
var main_default58 = stdev2;

var lib_default75 = main_default58;

var HALF_LN2 = 0.34657359027997264;
var lib_default76 = HALF_LN2;

function evalpoly9(x) {
  if (x === 0) {
    return -0.03333333333333313;
  }
  return -0.03333333333333313 + x * (0.0015873015872548146 + x * (-793650757867488e-19 + x * (4008217827329362e-21 + x * -20109921818362437e-23)));
}
var polyval_q_default2 = evalpoly9;

var OVERFLOW_THRESHOLD = 709.782712893384;
var LN2_HI4 = 0.6931471803691238;
var LN2_LO4 = 19082149292705877e-26;
var LN2_INV = 1.4426950408889634;
var LN2x56 = 38.816242111356935;
var LN2_HALFX3 = 1.0397207708399179;
function expm1(x) {
  var halfX;
  var twopk;
  var sign;
  var hi;
  var lo;
  var hx;
  var r1;
  var y;
  var z;
  var c2;
  var t;
  var e;
  var k;
  if (x === lib_default27 || lib_default(x)) {
    return x;
  }
  if (x === lib_default11) {
    return -1;
  }
  if (x === 0) {
    return x;
  }
  if (x < 0) {
    sign = true;
    y = -x;
  } else {
    sign = false;
    y = x;
  }
  if (y >= LN2x56) {
    if (sign) {
      return -1;
    }
    if (y >= OVERFLOW_THRESHOLD) {
      return lib_default27;
    }
  }
  hx = lib_default8(y) | 0;
  if (y > lib_default76) {
    if (y < LN2_HALFX3) {
      if (sign) {
        hi = x + LN2_HI4;
        lo = -LN2_LO4;
        k = -1;
      } else {
        hi = x - LN2_HI4;
        lo = LN2_LO4;
        k = 1;
      }
    } else {
      if (sign) {
        k = LN2_INV * x - 0.5;
      } else {
        k = LN2_INV * x + 0.5;
      }
      k |= 0;
      t = k;
      hi = x - t * LN2_HI4;
      lo = t * LN2_LO4;
    }
    x = hi - lo;
    c2 = hi - x - lo;
  } else if (hx < 1016070144) {
    return x;
  } else {
    k = 0;
  }
  halfX = 0.5 * x;
  z = x * halfX;
  r1 = 1 + z * polyval_q_default2(z);
  t = 3 - r1 * halfX;
  e = z * ((r1 - t) / (6 - x * t));
  if (k === 0) {
    return x - (x * e - z);
  }
  twopk = lib_default35(lib_default10 + k << 20, 0);
  e = x * (e - c2) - c2;
  e -= z;
  if (k === -1) {
    return 0.5 * (x - e) - 0.5;
  }
  if (k === 1) {
    if (x < -0.25) {
      return -2 * (e - (x + 0.5));
    }
    return 1 + 2 * (x - e);
  }
  if (k <= -2 || k > 56) {
    y = 1 - (e - x);
    if (k === 1024) {
      hi = lib_default8(y) + (k << 20) | 0;
      y = lib_default9(y, hi);
    } else {
      y *= twopk;
    }
    return y - 1;
  }
  t = 1;
  if (k < 20) {
    hi = 1072693248 - (2097152 >> k) | 0;
    t = lib_default9(t, hi);
    y = t - (e - x);
  } else {
    hi = lib_default10 - k << 20 | 0;
    t = lib_default9(t, hi);
    y = x - (e + t);
    y += 1;
  }
  y *= twopk;
  return y;
}
var main_default59 = expm1;

var lib_default77 = main_default59;

function evalpoly10(x) {
  if (x === 0) {
    return 0.6666666666666735;
  }
  return 0.6666666666666735 + x * (0.3999999999940942 + x * (0.2857142874366239 + x * (0.22222198432149784 + x * (0.1818357216161805 + x * (0.15313837699209373 + x * 0.14798198605116586)))));
}
var polyval_lp_default = evalpoly10;

var LN2_HI5 = 0.6931471803691238;
var LN2_LO5 = 19082149292705877e-26;
var SQRT2M1 = 0.41421356237309503;
var SQRT2HALFM1 = -0.2928932188134525;
var SMALL = 1862645149230957e-24;
var TINY3 = 5551115123125783e-32;
var TWO532 = 9007199254740992;
var TWO_THIRDS = 0.6666666666666666;
function log1p(x) {
  var hfsq;
  var hu;
  var y;
  var f2;
  var c2;
  var s;
  var z;
  var R;
  var u;
  var k;
  if (x < -1 || lib_default(x)) {
    return NaN;
  }
  if (x === -1) {
    return lib_default11;
  }
  if (x === lib_default27) {
    return x;
  }
  if (x === 0) {
    return x;
  }
  if (x < 0) {
    y = -x;
  } else {
    y = x;
  }
  k = 1;
  if (y < SQRT2M1) {
    if (y < SMALL) {
      if (y < TINY3) {
        return x;
      }
      return x - x * x * 0.5;
    }
    if (x > SQRT2HALFM1) {
      k = 0;
      f2 = x;
      hu = 1;
    }
  }
  if (k !== 0) {
    if (y < TWO532) {
      u = 1 + x;
      hu = lib_default8(u);
      k = (hu >> 20) - lib_default10;
      if (k > 0) {
        c2 = 1 - (u - x);
      } else {
        c2 = x - (u - 1);
      }
      c2 /= u;
    } else {
      u = x;
      hu = lib_default8(u);
      k = (hu >> 20) - lib_default10;
      c2 = 0;
    }
    hu &= 1048575;
    if (hu < 434334) {
      u = lib_default9(u, hu | 1072693248);
    } else {
      k += 1;
      u = lib_default9(u, hu | 1071644672);
      hu = 1048576 - hu >> 2;
    }
    f2 = u - 1;
  }
  hfsq = 0.5 * f2 * f2;
  if (hu === 0) {
    if (f2 === 0) {
      c2 += k * LN2_LO5;
      return k * LN2_HI5 + c2;
    }
    R = hfsq * (1 - TWO_THIRDS * f2);
    return k * LN2_HI5 - (R - (k * LN2_LO5 + c2) - f2);
  }
  s = f2 / (2 + f2);
  z = s * s;
  R = z * polyval_lp_default(z);
  if (k === 0) {
    return f2 - (hfsq - s * (hfsq + R));
  }
  return k * LN2_HI5 - (hfsq - (s * (hfsq + R) + (k * LN2_LO5 + c2)) - f2);
}
var main_default60 = log1p;

var lib_default78 = main_default60;

var E = 2.718281828459045;
var lib_default79 = E;

var FLOAT64_EPSILON = 2220446049250313e-31;
var lib_default80 = FLOAT64_EPSILON;

function evalrational3(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return Infinity;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 709811.662581658 + x * (679979.8474157227 + x * (293136.7857211597 + x * (74887.54032914672 + x * (12555.290582413863 + x * (1443.4299244417066 + x * (115.24194596137347 + x * (6.309239205732627 + x * (0.22668404630224365 + x * (0.004826466289237662 + x * 4624429436045379e-20)))))))));
    s2 = 0 + x * (362880 + x * (1026576 + x * (1172700 + x * (723680 + x * (269325 + x * (63273 + x * (9450 + x * (870 + x * (45 + x * 1)))))))));
  } else {
    x = 1 / x;
    s1 = 4624429436045379e-20 + x * (0.004826466289237662 + x * (0.22668404630224365 + x * (6.309239205732627 + x * (115.24194596137347 + x * (1443.4299244417066 + x * (12555.290582413863 + x * (74887.54032914672 + x * (293136.7857211597 + x * (679979.8474157227 + x * 709811.662581658)))))))));
    s2 = 1 + x * (45 + x * (870 + x * (9450 + x * (63273 + x * (269325 + x * (723680 + x * (1172700 + x * (1026576 + x * (362880 + x * 0)))))))));
  }
  return s1 / s2;
}
var lanczos_sum_expg_scaled_default = evalrational3;

var lanczosSumExpGScaled = lanczos_sum_expg_scaled_default;
var G = 10.900511;
function beta(a, b) {
  var ambh;
  var agh;
  var bgh;
  var cgh;
  var res;
  var tmp;
  var c2;
  if (lib_default(a) || lib_default(b)) {
    return NaN;
  }
  if (a < 0 || b < 0) {
    return NaN;
  }
  if (b === 1) {
    return 1 / a;
  }
  if (a === 1) {
    return 1 / b;
  }
  c2 = a + b;
  if (c2 < lib_default80) {
    res = c2 / a;
    res /= b;
    return res;
  }
  if (c2 === a && b < lib_default80) {
    return 1 / b;
  }
  if (c2 === b && a < lib_default80) {
    return 1 / a;
  }
  if (a < b) {
    tmp = b;
    b = a;
    a = tmp;
  }
  agh = a + G - 0.5;
  bgh = b + G - 0.5;
  cgh = c2 + G - 0.5;
  res = lanczosSumExpGScaled(a) * (lanczosSumExpGScaled(b) / lanczosSumExpGScaled(c2));
  ambh = a - 0.5 - b;
  if (lib_default29(b * ambh) < cgh * 100 && a > 100) {
    res *= lib_default68(ambh * lib_default78(-b / cgh));
  } else {
    res *= lib_default47(agh / cgh, ambh);
  }
  if (cgh > 1e10) {
    res *= lib_default47(agh / cgh * (bgh / cgh), b);
  } else {
    res *= lib_default47(agh * bgh / (cgh * cgh), b);
  }
  res *= lib_default2(lib_default79 / bgh);
  return res;
}
var main_default61 = beta;

var lib_default81 = main_default61;

function isPositiveZero(x) {
  return x === 0 && 1 / x === lib_default27;
}
var main_default62 = isPositiveZero;

var lib_default82 = main_default62;

function max(x, y) {
  if (lib_default(x) || lib_default(y)) {
    return NaN;
  }
  if (x === lib_default27 || y === lib_default27) {
    return lib_default27;
  }
  if (x === y && x === 0) {
    if (lib_default82(x)) {
      return x;
    }
    return y;
  }
  if (x > y) {
    return x;
  }
  return y;
}
var main_default63 = max;

var lib_default83 = main_default63;

function isNegativeZero(x) {
  return x === 0 && 1 / x === lib_default11;
}
var main_default64 = isNegativeZero;

var lib_default84 = main_default64;

function min(x, y) {
  if (lib_default(x) || lib_default(y)) {
    return NaN;
  }
  if (x === lib_default11 || y === lib_default11) {
    return lib_default11;
  }
  if (x === y && x === 0) {
    if (lib_default84(x)) {
      return x;
    }
    return y;
  }
  if (x < y) {
    return x;
  }
  return y;
}
var main_default65 = min;

var lib_default85 = main_default65;

var FLOAT64_MAX = 17976931348623157e292;
var lib_default86 = FLOAT64_MAX;

var INT32_MAX = 2147483647 | 0;
var lib_default87 = INT32_MAX;

var SQRT_TWO_PI = 2.5066282746310007;
var lib_default88 = SQRT_TWO_PI;

function evalpoly11(x) {
  if (x === 0) {
    return 0.08333333333334822;
  }
  return 0.08333333333334822 + x * (0.0034722222160545866 + x * (-0.0026813261780578124 + x * (-22954996161337813e-20 + x * 7873113957930937e-19)));
}
var polyval_s_default = evalpoly11;

var MAX_STIRLING = 143.01608;
function gamma(x) {
  var w;
  var y;
  var v;
  w = 1 / x;
  w = 1 + w * polyval_s_default(w);
  y = lib_default68(x);
  if (x > MAX_STIRLING) {
    v = lib_default47(x, 0.5 * x - 0.25);
    y = v * (v / y);
  } else {
    y = lib_default47(x, x - 0.5) / y;
  }
  return lib_default88 * y * w;
}
var stirling_approximation_default = gamma;

var EULERGAMMA = 0.5772156649015329;
var lib_default89 = EULERGAMMA;

function gamma2(x, z) {
  return z / ((1 + lib_default89 * x) * x);
}
var small_approximation_default = gamma2;

function evalrational4(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 1;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 1 + x * (0.4942148268014971 + x * (0.20744822764843598 + x * (0.04763678004571372 + x * (0.010421379756176158 + x * (0.0011913514700658638 + x * (16011952247675185e-20 + x * 0))))));
    s2 = 1 + x * (0.0714304917030273 + x * (-0.23459179571824335 + x * (0.035823639860549865 + x * (0.011813978522206043 + x * (-0.004456419138517973 + x * (5396055804933034e-19 + x * -23158187332412014e-21))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (16011952247675185e-20 + x * (0.0011913514700658638 + x * (0.010421379756176158 + x * (0.04763678004571372 + x * (0.20744822764843598 + x * (0.4942148268014971 + x * 1))))));
    s2 = -23158187332412014e-21 + x * (5396055804933034e-19 + x * (-0.004456419138517973 + x * (0.011813978522206043 + x * (0.035823639860549865 + x * (-0.23459179571824335 + x * (0.0714304917030273 + x * 1))))));
  }
  return s1 / s2;
}
var rational_pq_default2 = evalrational4;

function gamma3(x) {
  var sign;
  var q;
  var p101;
  var z;
  if (lib_default24(x) && x < 0 || x === lib_default11 || lib_default(x)) {
    return NaN;
  }
  if (x === 0) {
    if (lib_default84(x)) {
      return lib_default11;
    }
    return lib_default27;
  }
  if (x > 171.61447887182297) {
    return lib_default27;
  }
  if (x < -170.5674972726612) {
    return 0;
  }
  q = lib_default29(x);
  if (q > 33) {
    if (x >= 0) {
      return stirling_approximation_default(x);
    }
    p101 = lib_default23(q);
    if ((p101 & 1) === 0) {
      sign = -1;
    } else {
      sign = 1;
    }
    z = q - p101;
    if (z > 0.5) {
      p101 += 1;
      z = q - p101;
    }
    z = q * lib_default55(lib_default5 * z);
    return sign * lib_default5 / (lib_default29(z) * stirling_approximation_default(q));
  }
  z = 1;
  while (x >= 3) {
    x -= 1;
    z *= x;
  }
  while (x < 0) {
    if (x > -1e-9) {
      return small_approximation_default(x, z);
    }
    z /= x;
    x += 1;
  }
  while (x < 2) {
    if (x < 1e-9) {
      return small_approximation_default(x, z);
    }
    z /= x;
    x += 1;
  }
  if (x === 2) {
    return z;
  }
  x -= 2;
  return z * rational_pq_default2(x);
}
var main_default66 = gamma3;

var lib_default90 = main_default66;

var FLOAT64_MAX_NTH_FACTORIAL = 170 | 0;
var lib_default91 = FLOAT64_MAX_NTH_FACTORIAL;

var factorials_default = [
  1,
  1,
  2,
  6,
  24,
  120,
  720,
  5040,
  40320,
  362880,
  3628800,
  39916800,
  479001600,
  6227020800,
  87178291200,
  1307674368e3,
  20922789888e3,
  355687428096e3,
  6402373705728e3,
  121645100408832e3,
  243290200817664e4,
  5109094217170944e4,
  11240007277776077e5,
  2585201673888498e7,
  6204484017332394e8,
  15511210043330986e9,
  40329146112660565e10,
  10888869450418352e12,
  30488834461171387e13,
  8841761993739702e15,
  26525285981219107e16,
  8222838654177922e18,
  2631308369336935e20,
  8683317618811886e21,
  29523279903960416e22,
  10333147966386145e24,
  37199332678990125e25,
  13763753091226346e27,
  5230226174666011e29,
  20397882081197444e30,
  8159152832478977e32,
  3345252661316381e34,
  140500611775288e37,
  6041526306337383e37,
  2658271574788449e39,
  11962222086548019e40,
  5502622159812089e42,
  25862324151116818e43,
  12413915592536073e45,
  6082818640342675e47,
  30414093201713376e48,
  15511187532873822e50,
  8065817517094388e52,
  42748832840600255e53,
  2308436973392414e56,
  12696403353658276e57,
  7109985878048635e59,
  40526919504877214e60,
  23505613312828785e62,
  13868311854568984e64,
  832098711274139e67,
  5075802138772248e68,
  3146997326038794e70,
  198260831540444e73,
  12688693218588417e73,
  8247650592082472e75,
  5443449390774431e77,
  3647111091818868e79,
  24800355424368305e80,
  1711224524281413e83,
  11978571669969892e84,
  8504785885678623e86,
  61234458376886085e87,
  44701154615126844e89,
  3307885441519386e92,
  248091408113954e95,
  18854947016660504e95,
  14518309202828587e97,
  11324281178206297e99,
  8946182130782976e101,
  7156945704626381e103,
  5797126020747368e105,
  4753643337012842e107,
  3945523969720659e109,
  3314240134565353e111,
  281710411438055e114,
  24227095383672734e114,
  2107757298379528e117,
  18548264225739844e118,
  1650795516090846e121,
  14857159644817615e122,
  1352001527678403e125,
  12438414054641308e126,
  11567725070816416e128,
  1087366156656743e131,
  1032997848823906e133,
  9916779348709496e134,
  9619275968248212e136,
  9426890448883248e138,
  9332621544394415e140,
  9332621544394415e142,
  942594775983836e145,
  9614466715035127e146,
  990290071648618e149,
  10299016745145628e150,
  1081396758240291e153,
  11462805637347084e154,
  1226520203196138e157,
  1324641819451829e159,
  14438595832024937e160,
  1588245541522743e163,
  17629525510902446e164,
  1974506857221074e167,
  22311927486598138e168,
  25435597334721877e170,
  2925093693493016e173,
  3393108684451898e175,
  3969937160808721e177,
  4684525849754291e179,
  5574585761207606e181,
  6689502913449127e183,
  8094298525273444e185,
  9875044200833601e187,
  1214630436702533e190,
  1506141741511141e192,
  1882677176888926e194,
  2372173242880047e196,
  30126600184576594e197,
  3856204823625804e200,
  4974504222477287e202,
  6466855489220474e204,
  847158069087882e207,
  11182486511960043e208,
  14872707060906857e210,
  19929427461615188e212,
  26904727073180504e214,
  3659042881952549e217,
  5012888748274992e219,
  6917786472619489e221,
  9615723196941089e223,
  13462012475717526e225,
  1898143759076171e228,
  2695364137888163e230,
  3854370717180073e232,
  55502938327393044e233,
  8047926057471992e236,
  11749972043909107e238,
  1727245890454639e241,
  25563239178728654e242,
  380892263763057e246,
  5713383956445855e247,
  862720977423324e250,
  13113358856834524e251,
  20063439050956823e253,
  30897696138473508e255,
  4789142901463394e258,
  7471062926282894e260,
  11729568794264145e262,
  1853271869493735e265,
  29467022724950384e266,
  47147236359920616e268,
  7590705053947219e271,
  12296942187394494e273,
  20044015765453026e275,
  3287218585534296e278,
  5423910666131589e280,
  9003691705778438e282,
  1503616514864999e285,
  25260757449731984e286,
  4269068009004705e289,
  7257415615307999e291
];

function factorial(x) {
  if (lib_default(x)) {
    return NaN;
  }
  if (lib_default24(x)) {
    if (x < 0) {
      return NaN;
    }
    if (x <= lib_default91) {
      return factorials_default[x];
    }
    return lib_default27;
  }
  return lib_default90(x + 1);
}
var main_default67 = factorial;

var lib_default92 = main_default67;

function evalrational5(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return Infinity;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 3847467039331777e-5 + x * (3685766504351951e-5 + x * (1588920245372942e-5 + x * (4059208354298835e-6 + x * (6805476611834733e-7 + x * (7823975500312005e-8 + x * (6246580776401795e-9 + x * (341986.3488721347 + x * (12287.194511824551 + x * (261.61404416416684 + x * 2.5066282746310007)))))))));
    s2 = 0 + x * (362880 + x * (1026576 + x * (1172700 + x * (723680 + x * (269325 + x * (63273 + x * (9450 + x * (870 + x * (45 + x * 1)))))))));
  } else {
    x = 1 / x;
    s1 = 2.5066282746310007 + x * (261.61404416416684 + x * (12287.194511824551 + x * (341986.3488721347 + x * (6246580776401795e-9 + x * (7823975500312005e-8 + x * (6805476611834733e-7 + x * (4059208354298835e-6 + x * (1588920245372942e-5 + x * (3685766504351951e-5 + x * 3847467039331777e-5)))))))));
    s2 = 1 + x * (45 + x * (870 + x * (9450 + x * (63273 + x * (269325 + x * (723680 + x * (1172700 + x * (1026576 + x * (362880 + x * 0)))))))));
  }
  return s1 / s2;
}
var rational_pq_default3 = evalrational5;

var main_default68 = rational_pq_default3;

var lib_default93 = main_default68;

var FLOAT64_GAMMA_LANCZOS_G = 10.900511;
var lib_default94 = FLOAT64_GAMMA_LANCZOS_G;

var FACTORIAL_169 = 4269068009004705e289;
function gammaDeltaRatioLanczos(z, delta) {
  var result;
  var ratio;
  var zgh;
  if (z < lib_default80) {
    if (delta >= lib_default91) {
      ratio = gammaDeltaRatioLanczos(delta, lib_default91 - delta);
      ratio *= z;
      ratio *= FACTORIAL_169;
      return 1 / ratio;
    }
    return 1 / (z * lib_default90(z + delta));
  }
  zgh = z + lib_default94 - 0.5;
  if (z + delta === z) {
    if (lib_default29(delta / zgh) < lib_default80) {
      result = lib_default68(-delta);
    } else {
      result = 1;
    }
  } else {
    if (lib_default29(delta) < 10) {
      result = lib_default68((0.5 - z) * lib_default78(delta / zgh));
    } else {
      result = lib_default47(zgh / (zgh + delta), z - 0.5);
    }
    result *= lib_default93(z) / lib_default93(z + delta);
  }
  result *= lib_default47(lib_default79 / (zgh + delta), delta);
  return result;
}
var gamma_delta_ratio_lanczos_default = gammaDeltaRatioLanczos;

function gammaDeltaRatio(z, delta) {
  var result;
  var idelta;
  var iz;
  if (z <= 0 || z + delta <= 0) {
    return lib_default90(z) / lib_default90(z + delta);
  }
  idelta = lib_default23(delta);
  if (idelta === delta) {
    iz = lib_default23(z);
    if (iz === z) {
      if (z <= lib_default91 && z + delta <= lib_default91) {
        return lib_default92(iz - 1) / lib_default92(idelta + iz - 1);
      }
    }
    if (lib_default29(delta) < 20) {
      if (delta === 0) {
        return 1;
      }
      if (delta < 0) {
        z -= 1;
        result = z;
        delta += 1;
        while (delta !== 0) {
          z -= 1;
          result *= z;
          delta += 1;
        }
        return result;
      }
      result = 1 / z;
      delta -= 1;
      while (delta !== 0) {
        z += 1;
        result /= z;
        delta -= 1;
      }
      return result;
    }
  }
  return gamma_delta_ratio_lanczos_default(z, delta);
}
var main_default69 = gammaDeltaRatio;

var lib_default95 = main_default69;

var buffer = [0, 0];
var HIGH_WORD_PIO4 = 1072243195 | 0;
var HIGH_WORD_TWO_NEG_27 = 1044381696 | 0;
function cos(x) {
  var ix;
  var n;
  ix = lib_default8(x);
  ix &= lib_default33;
  if (ix <= HIGH_WORD_PIO4) {
    if (ix < HIGH_WORD_TWO_NEG_27) {
      return 1;
    }
    return lib_default48(x, 0);
  }
  if (ix >= lib_default41) {
    return NaN;
  }
  n = lib_default54(x, buffer);
  switch (n & 3) {
    case 0:
      return lib_default48(buffer[0], buffer[1]);
    case 1:
      return -lib_default49(buffer[0], buffer[1]);
    case 2:
      return -lib_default48(buffer[0], buffer[1]);
    default:
      return lib_default49(buffer[0], buffer[1]);
  }
}
var main_default70 = cos;

var lib_default96 = main_default70;

function sinpi(x) {
  var ar;
  var r;
  if (lib_default(x)) {
    return NaN;
  }
  if (lib_default28(x)) {
    return NaN;
  }
  r = x % 2;
  ar = lib_default29(r);
  if (ar === 0 || ar === 1) {
    return lib_default36(0, r);
  }
  if (ar < 0.25) {
    return lib_default55(lib_default5 * r);
  }
  if (ar < 0.75) {
    ar = 0.5 - ar;
    return lib_default36(lib_default96(lib_default5 * ar), r);
  }
  if (ar < 1.25) {
    r = lib_default36(1, r) - r;
    return lib_default55(lib_default5 * r);
  }
  if (ar < 1.75) {
    ar -= 1.5;
    return -lib_default36(lib_default96(lib_default5 * ar), r);
  }
  r -= lib_default36(2, r);
  return lib_default55(lib_default5 * r);
}
var main_default71 = sinpi;

var lib_default97 = main_default71;

function evalpoly12(x) {
  if (x === 0) {
    return 0.06735230105312927;
  }
  return 0.06735230105312927 + x * (0.007385550860814029 + x * (0.0011927076318336207 + x * (22086279071390839e-20 + x * 25214456545125733e-21)));
}
var polyval_a1_default = evalpoly12;

function evalpoly13(x) {
  if (x === 0) {
    return 0.020580808432516733;
  }
  return 0.020580808432516733 + x * (0.0028905138367341563 + x * (5100697921535113e-19 + x * (10801156724758394e-20 + x * 44864094961891516e-21)));
}
var polyval_a2_default = evalpoly13;

function evalpoly14(x) {
  if (x === 0) {
    return 1.3920053346762105;
  }
  return 1.3920053346762105 + x * (0.7219355475671381 + x * (0.17193386563280308 + x * (0.01864591917156529 + x * (7779424963818936e-19 + x * 7326684307446256e-21))));
}
var polyval_r_default = evalpoly14;

function evalpoly15(x) {
  if (x === 0) {
    return 0.21498241596060885;
  }
  return 0.21498241596060885 + x * (0.325778796408931 + x * (0.14635047265246445 + x * (0.02664227030336386 + x * (0.0018402845140733772 + x * 3194753265841009e-20))));
}
var polyval_s_default2 = evalpoly15;

function evalpoly16(x) {
  if (x === 0) {
    return -0.032788541075985965;
  }
  return -0.032788541075985965 + x * (0.006100538702462913 + x * (-0.0014034646998923284 + x * 31563207090362595e-20));
}
var polyval_t1_default = evalpoly16;

function evalpoly17(x) {
  if (x === 0) {
    return 0.01797067508118204;
  }
  return 0.01797067508118204 + x * (-0.0036845201678113826 + x * (881081882437654e-18 + x * -31275416837512086e-20));
}
var polyval_t2_default = evalpoly17;

function evalpoly18(x) {
  if (x === 0) {
    return -0.010314224129834144;
  }
  return -0.010314224129834144 + x * (0.0022596478090061247 + x * (-5385953053567405e-19 + x * 3355291926355191e-19));
}
var polyval_t3_default = evalpoly18;

function evalpoly19(x) {
  if (x === 0) {
    return 0.6328270640250934;
  }
  return 0.6328270640250934 + x * (1.4549225013723477 + x * (0.9777175279633727 + x * (0.22896372806469245 + x * 0.013381091853678766)));
}
var polyval_u_default = evalpoly19;

function evalpoly20(x) {
  if (x === 0) {
    return 2.4559779371304113;
  }
  return 2.4559779371304113 + x * (2.128489763798934 + x * (0.7692851504566728 + x * (0.10422264559336913 + x * 0.003217092422824239)));
}
var polyval_v_default = evalpoly20;

function evalpoly21(x) {
  if (x === 0) {
    return 0.08333333333333297;
  }
  return 0.08333333333333297 + x * (-0.0027777777772877554 + x * (7936505586430196e-19 + x * (-59518755745034e-17 + x * (8363399189962821e-19 + x * -0.0016309293409657527))));
}
var polyval_w_default2 = evalpoly21;

var A1C = 0.07721566490153287;
var A2C = 0.3224670334241136;
var RC = 1;
var SC = -0.07721566490153287;
var T1C = 0.48383612272381005;
var T2C = -0.1475877229945939;
var T3C = 0.06462494023913339;
var UC = -0.07721566490153287;
var VC = 1;
var WC = 0.4189385332046727;
var YMIN = 1.4616321449683622;
var TWO52 = 4503599627370496;
var TWO56 = 72057594037927940;
var TINY4 = 13877787807814457e-33;
var TC = 1.4616321449683622;
var TF = -0.12148629053584961;
var TT = -3638676997039505e-33;
function gammaln(x) {
  var isNegative;
  var nadj;
  var flg;
  var p310;
  var p210;
  var p110;
  var p101;
  var q;
  var t;
  var w;
  var y;
  var z;
  var r;
  if (lib_default(x) || lib_default28(x)) {
    return x;
  }
  if (x === 0) {
    return lib_default27;
  }
  if (x < 0) {
    isNegative = true;
    x = -x;
  } else {
    isNegative = false;
  }
  if (x < TINY4) {
    return -lib_default12(x);
  }
  if (isNegative) {
    if (x >= TWO52) {
      return lib_default27;
    }
    t = lib_default97(x);
    if (t === 0) {
      return lib_default27;
    }
    nadj = lib_default12(lib_default5 / lib_default29(t * x));
  }
  if (x === 1 || x === 2) {
    return 0;
  }
  if (x < 2) {
    if (x <= 0.9) {
      r = -lib_default12(x);
      if (x >= YMIN - 1 + 0.27) {
        y = 1 - x;
        flg = 0;
      } else if (x >= YMIN - 1 - 0.27) {
        y = x - (TC - 1);
        flg = 1;
      } else {
        y = x;
        flg = 2;
      }
    } else {
      r = 0;
      if (x >= YMIN + 0.27) {
        y = 2 - x;
        flg = 0;
      } else if (x >= YMIN - 0.27) {
        y = x - TC;
        flg = 1;
      } else {
        y = x - 1;
        flg = 2;
      }
    }
    switch (flg) {
      // eslint-disable-line default-case
      case 0:
        z = y * y;
        p110 = A1C + z * polyval_a1_default(z);
        p210 = z * (A2C + z * polyval_a2_default(z));
        p101 = y * p110 + p210;
        r += p101 - 0.5 * y;
        break;
      case 1:
        z = y * y;
        w = z * y;
        p110 = T1C + w * polyval_t1_default(w);
        p210 = T2C + w * polyval_t2_default(w);
        p310 = T3C + w * polyval_t3_default(w);
        p101 = z * p110 - (TT - w * (p210 + y * p310));
        r += TF + p101;
        break;
      case 2:
        p110 = y * (UC + y * polyval_u_default(y));
        p210 = VC + y * polyval_v_default(y);
        r += -0.5 * y + p110 / p210;
        break;
    }
  } else if (x < 8) {
    flg = lib_default67(x);
    y = x - flg;
    p101 = y * (SC + y * polyval_s_default2(y));
    q = RC + y * polyval_r_default(y);
    r = 0.5 * y + p101 / q;
    z = 1;
    switch (flg) {
      // eslint-disable-line default-case
      case 7:
        z *= y + 6;
      case 6:
        z *= y + 5;
      case 5:
        z *= y + 4;
      case 4:
        z *= y + 3;
      case 3:
        z *= y + 2;
        r += lib_default12(z);
    }
  } else if (x < TWO56) {
    t = lib_default12(x);
    z = 1 / x;
    y = z * z;
    w = WC + z * polyval_w_default2(y);
    r = (x - 0.5) * (t - 1) + w;
  } else {
    r = x * (lib_default12(x) - 1);
  }
  if (isNegative) {
    r = nadj - r;
  }
  return r;
}
var main_default72 = gammaln;

var lib_default98 = main_default72;

var FLOAT64_MAX_LN = 709.782712893384;
var lib_default99 = FLOAT64_MAX_LN;

var FLOAT64_SQRT_EPSILON = 14901161193847656e-24;
var lib_default100 = FLOAT64_SQRT_EPSILON;

var has_generator_support_default = () => true;

var MAX_TERMS = 1e6;
function sumSeries(generator, options) {
  var isgenerator;
  var tolerance;
  var nextTerm;
  var counter;
  var result;
  var opts2;
  opts2 = {};
  if (arguments.length > 1) {
    opts2 = options;
  }
  tolerance = opts2.tolerance || lib_default80;
  counter = opts2.maxTerms || MAX_TERMS;
  result = opts2.initialValue || 0;
  isgenerator = typeof generator.next === "function";
  if (isgenerator === true) {
    for (nextTerm of generator) {
      result += nextTerm;
      if (lib_default29(tolerance * result) >= lib_default29(nextTerm) || --counter === 0) {
        break;
      }
    }
  } else {
    do {
      nextTerm = generator();
      result += nextTerm;
    } while (lib_default29(tolerance * result) < lib_default29(nextTerm) && --counter);
  }
  return result;
}
var generators_default = sumSeries;

var MAX_TERMS2 = 1e6;
function sumSeries2(generator, options) {
  var tolerance;
  var nextTerm;
  var counter;
  var result;
  var opts2;
  opts2 = {};
  if (arguments.length > 1) {
    opts2 = options;
  }
  tolerance = opts2.tolerance || lib_default80;
  counter = opts2.maxTerms || MAX_TERMS2;
  result = opts2.initialValue || 0;
  do {
    nextTerm = generator();
    result += nextTerm;
  } while (lib_default29(tolerance * result) < lib_default29(nextTerm) && --counter);
  return result;
}
var basic_default = sumSeries2;

var sumSeries3;
if (has_generator_support_default()) {
  sumSeries3 = generators_default;
} else {
  sumSeries3 = basic_default;
}
var lib_default101 = sumSeries3;

function tgammaILargeXSeries(a1, x1) {
  var result = 1;
  var a = a1;
  var x = x1;
  return next;
  function next() {
    var r = result;
    result *= a / x;
    a -= 1;
    return r;
  }
}
var tgamma_i_large_x_series_default = tgammaILargeXSeries;

function tgammaILargeX(a, x) {
  var result;
  var s;
  s = tgamma_i_large_x_series_default(a, x);
  result = lib_default101(s);
  return result;
}
var tgamma_i_large_x_default = tgammaILargeX;

function finiteGammaQ(a, x) {
  var term;
  var sum2;
  var e;
  var n;
  e = lib_default68(-x);
  sum2 = e;
  if (sum2 !== 0) {
    term = sum2;
    for (n = 1; n < a; ++n) {
      term /= n;
      term *= x;
      sum2 += term;
    }
  }
  return sum2;
}
var finite_gamma_q_default = finiteGammaQ;

function evalpoly22(x) {
  if (x === 0) {
    return -0.3250421072470015;
  }
  return -0.3250421072470015 + x * (-0.02848174957559851 + x * (-0.005770270296489442 + x * -23763016656650163e-21));
}
var polyval_pp_default = evalpoly22;

function evalpoly23(x) {
  if (x === 0) {
    return 0.39791722395915535;
  }
  return 0.39791722395915535 + x * (0.0650222499887673 + x * (0.005081306281875766 + x * (13249473800432164e-20 + x * -3960228278775368e-21)));
}
var polyval_qq_default = evalpoly23;

function evalpoly24(x) {
  if (x === 0) {
    return 0.41485611868374833;
  }
  return 0.41485611868374833 + x * (-0.3722078760357013 + x * (0.31834661990116175 + x * (-0.11089469428239668 + x * (0.035478304325618236 + x * -0.002166375594868791))));
}
var polyval_pa_default = evalpoly24;

function evalpoly25(x) {
  if (x === 0) {
    return 0.10642088040084423;
  }
  return 0.10642088040084423 + x * (0.540397917702171 + x * (0.07182865441419627 + x * (0.12617121980876164 + x * (0.01363708391202905 + x * 0.011984499846799107))));
}
var polyval_qa_default = evalpoly25;

function evalpoly26(x) {
  if (x === 0) {
    return -0.6938585727071818;
  }
  return -0.6938585727071818 + x * (-10.558626225323291 + x * (-62.375332450326006 + x * (-162.39666946257347 + x * (-184.60509290671104 + x * (-81.2874355063066 + x * -9.814329344169145)))));
}
var polyval_ra_default = evalpoly26;

function evalpoly27(x) {
  if (x === 0) {
    return 19.651271667439257;
  }
  return 19.651271667439257 + x * (137.65775414351904 + x * (434.56587747522923 + x * (645.3872717332679 + x * (429.00814002756783 + x * (108.63500554177944 + x * (6.570249770319282 + x * -0.0604244152148581))))));
}
var polyval_sa_default = evalpoly27;

function evalpoly28(x) {
  if (x === 0) {
    return -0.799283237680523;
  }
  return -0.799283237680523 + x * (-17.757954917754752 + x * (-160.63638485582192 + x * (-637.5664433683896 + x * (-1025.0951316110772 + x * -483.5191916086514))));
}
var polyval_rb_default = evalpoly28;

function evalpoly29(x) {
  if (x === 0) {
    return 30.33806074348246;
  }
  return 30.33806074348246 + x * (325.7925129965739 + x * (1536.729586084437 + x * (3199.8582195085955 + x * (2553.0504064331644 + x * (474.52854120695537 + x * -22.44095244658582)))));
}
var polyval_sb_default = evalpoly29;

var TINY5 = 1e-300;
var SMALL2 = 13877787807814457e-33;
var ERX = 0.8450629115104675;
var PPC = 0.12837916709551256;
var QQC = 1;
var PAC = -0.0023621185607526594;
var QAC = 1;
var RAC = -0.009864944034847148;
var SAC = 1;
var RBC = -0.0098649429247001;
var SBC = 1;
function erfc(x) {
  var sign;
  var ax;
  var z;
  var r;
  var s;
  var y;
  var p101;
  var q;
  if (lib_default(x)) {
    return NaN;
  }
  if (x === lib_default27) {
    return 0;
  }
  if (x === lib_default11) {
    return 2;
  }
  if (x === 0) {
    return 1;
  }
  if (x < 0) {
    sign = true;
    ax = -x;
  } else {
    sign = false;
    ax = x;
  }
  if (ax < 0.84375) {
    if (ax < SMALL2) {
      return 1 - x;
    }
    z = x * x;
    r = PPC + z * polyval_pp_default(z);
    s = QQC + z * polyval_qq_default(z);
    y = r / s;
    if (x < 0.25) {
      return 1 - (x + x * y);
    }
    r = x * y;
    r += x - 0.5;
    return 0.5 - r;
  }
  if (ax < 1.25) {
    s = ax - 1;
    p101 = PAC + s * polyval_pa_default(s);
    q = QAC + s * polyval_qa_default(s);
    if (sign) {
      return 1 + ERX + p101 / q;
    }
    return 1 - ERX - p101 / q;
  }
  if (ax < 28) {
    s = 1 / (ax * ax);
    if (ax < 2.857142857142857) {
      r = RAC + s * polyval_ra_default(s);
      s = SAC + s * polyval_sa_default(s);
    } else {
      if (x < -6) {
        return 2 - TINY5;
      }
      r = RBC + s * polyval_rb_default(s);
      s = SBC + s * polyval_sb_default(s);
    }
    z = lib_default31(ax, 0);
    r = lib_default68(-(z * z) - 0.5625) * lib_default68((z - ax) * (z + ax) + r / s);
    if (sign) {
      return 2 - r / ax;
    }
    return r / ax;
  }
  if (sign) {
    return 2 - TINY5;
  }
  return TINY5 * TINY5;
}
var main_default73 = erfc;

var lib_default102 = main_default73;

function finiteHalfGammaQ(a, x) {
  var half;
  var term;
  var sum2;
  var e;
  var n;
  e = lib_default102(lib_default2(x));
  if (e !== 0 && a > 1) {
    term = lib_default68(-x) / lib_default2(lib_default5 * x);
    term *= x;
    half = 0.5;
    term /= half;
    sum2 = term;
    for (n = 2; n < a; ++n) {
      term /= n - half;
      term *= x;
      sum2 += term;
    }
    e += sum2;
  }
  return e;
}
var finite_half_gamma_q_default = finiteHalfGammaQ;

var FLOAT64_MIN_LN = -708.3964185322641;
var lib_default103 = FLOAT64_MIN_LN;

function fullIGammaPrefix(a, z) {
  var prefix;
  var alz;
  alz = a * lib_default12(z);
  if (z >= 1) {
    if (alz < lib_default99 && -z > lib_default103) {
      prefix = lib_default47(z, a) * lib_default68(-z);
    } else if (a >= 1) {
      prefix = lib_default47(z / lib_default68(z / a), a);
    } else {
      prefix = lib_default68(alz - z);
    }
  } else {
    if (alz > lib_default103) {
      prefix = lib_default47(z, a) * lib_default68(-z);
    } else if (z / a < lib_default99) {
      prefix = lib_default47(z / lib_default68(z / a), a);
    } else {
      prefix = lib_default68(alz - z);
    }
  }
  return prefix;
}
var full_igamma_prefix_default = fullIGammaPrefix;

function evalpoly30(c2, x) {
  var p101;
  var i;
  i = c2.length;
  if (i < 2 || x === 0) {
    if (i === 0) {
      return 0;
    }
    return c2[0];
  }
  i -= 1;
  p101 = c2[i] * x + c2[i - 1];
  i -= 2;
  while (i >= 0) {
    p101 = p101 * x + c2[i];
    i -= 1;
  }
  return p101;
}
var main_default74 = evalpoly30;

var Fcn = Function;
var main_default75 = Fcn;

var lib_default104 = main_default75;

function factory10(c2) {
  var f2;
  var n;
  var m;
  var i;
  if (c2.length > 500) {
    return polyval;
  }
  f2 = "return function evalpoly(x){";
  n = c2.length;
  if (n === 0) {
    f2 += "return 0.0;";
  } else if (n === 1) {
    f2 += "return " + c2[0] + ";";
  } else {
    f2 += "if(x===0.0){return " + c2[0] + ";}";
    f2 += "return " + c2[0];
    m = n - 1;
    for (i = 1; i < n; i++) {
      f2 += "+x*";
      if (i < m) {
        f2 += "(";
      }
      f2 += c2[i];
    }
    for (i = 0; i < m - 1; i++) {
      f2 += ")";
    }
    f2 += ";";
  }
  f2 += "}";
  f2 += "//# sourceURL=evalpoly.factory.js";
  return new lib_default104(f2)();
  function polyval(x) {
    return main_default74(c2, x);
  }
}
var factory_default10 = factory10;

main_default74.factory = factory_default10;
var lib_default105 = main_default74;

function log1pSeries(x) {
  var mMult = -x;
  var mProd = -1;
  var k = 0;
  return next;
  function next() {
    mProd *= mMult;
    k += 1;
    return mProd / k;
  }
}
var log1p_series_default = log1pSeries;

function log1pmx(x) {
  var opts2;
  var ax;
  if (x <= -1) {
    return NaN;
  }
  ax = lib_default29(x);
  if (ax > 0.95) {
    return lib_default12(1 + x) - x;
  }
  if (ax < lib_default80) {
    return -x * x / 2;
  }
  opts2 = {
    "initialValue": -x
  };
  return lib_default101(log1p_series_default(x), opts2);
}
var main_default76 = log1pmx;

var lib_default106 = main_default76;

var TWO_PI = 6.283185307179586;
var lib_default107 = TWO_PI;

function evalpoly31(x) {
  if (x === 0) {
    return -0.3333333333333333;
  }
  return -0.3333333333333333 + x * (0.08333333333333333 + x * (-0.014814814814814815 + x * (0.0011574074074074073 + x * (3527336860670194e-19 + x * (-1787551440329218e-19 + x * (3919263178522438e-20 + x * (-21854485106799924e-22 + x * (-185406221071516e-20 + x * (8296711340953087e-22 + x * (-17665952736826078e-23 + x * (6707853543401498e-24 + x * (10261809784240309e-24 + x * (-4382036018453353e-24 + x * 914769958223679e-24)))))))))))));
}
var polyval_c0_default = evalpoly31;

function evalpoly32(x) {
  if (x === 0) {
    return -0.001851851851851852;
  }
  return -0.001851851851851852 + x * (-0.003472222222222222 + x * (0.0026455026455026454 + x * (-9902263374485596e-19 + x * (20576131687242798e-20 + x * (-4018775720164609e-22 + x * (-18098550334489977e-21 + x * (764916091608111e-20 + x * (-16120900894563446e-22 + x * (4647127802807434e-24 + x * (1378633446915721e-22 + x * (-5752545603517705e-23 + x * 11951628599778148e-24)))))))))));
}
var polyval_c1_default = evalpoly32;

function evalpoly33(x) {
  if (x === 0) {
    return 0.004133597883597883;
  }
  return 0.004133597883597883 + x * (-0.0026813271604938273 + x * (7716049382716049e-19 + x * (20093878600823047e-22 + x * (-10736653226365161e-20 + x * (52923448829120125e-21 + x * (-12760635188618728e-21 + x * (3423578734096138e-23 + x * (13721957309062932e-22 + x * (-6298992138380055e-22 + x * 14280614206064242e-23)))))))));
}
var polyval_c2_default = evalpoly33;

function evalpoly34(x) {
  if (x === 0) {
    return 6494341563786008e-19;
  }
  return 6494341563786008e-19 + x * (22947209362139917e-20 + x * (-4691894943952557e-19 + x * (26772063206283885e-20 + x * (-7561801671883977e-20 + x * (-2396505113867297e-22 + x * (11082654115347302e-21 + x * (-56749528269915965e-22 + x * 14230900732435883e-22)))))));
}
var polyval_c3_default = evalpoly34;

function evalpoly35(x) {
  if (x === 0) {
    return -8618882909167117e-19;
  }
  return -8618882909167117e-19 + x * (7840392217200666e-19 + x * (-2990724803031902e-19 + x * (-14638452578843418e-22 + x * (6641498215465122e-20 + x * (-3968365047179435e-20 + x * 11375726970678419e-21)))));
}
var polyval_c4_default = evalpoly35;

function evalpoly36(x) {
  if (x === 0) {
    return -33679855336635813e-20;
  }
  return -33679855336635813e-20 + x * (-6972813758365858e-20 + x * (2772753244959392e-19 + x * (-19932570516188847e-20 + x * (6797780477937208e-20 + x * (1419062920643967e-22 + x * (-13594048189768693e-21 + x * (8018470256334202e-21 + x * -2291481176508095e-21)))))));
}
var polyval_c5_default = evalpoly36;

function evalpoly37(x) {
  if (x === 0) {
    return 5313079364639922e-19;
  }
  return 5313079364639922e-19 + x * (-5921664373536939e-19 + x * (2708782096718045e-19 + x * (7902353232660328e-22 + x * (-8153969367561969e-20 + x * (561168275310625e-19 + x * -18329116582843375e-21)))));
}
var polyval_c6_default = evalpoly37;

function evalpoly38(x) {
  if (x === 0) {
    return 34436760689237765e-20;
  }
  return 34436760689237765e-20 + x * (5171790908260592e-20 + x * (-33493161081142234e-20 + x * (2812695154763237e-19 + x * -10976582244684731e-20)));
}
var polyval_c7_default = evalpoly38;

function evalpoly39(x) {
  if (x === 0) {
    return -6526239185953094e-19;
  }
  return -6526239185953094e-19 + x * (8394987206720873e-19 + x * -438297098541721e-18);
}
var polyval_c8_default = evalpoly39;

var workspace = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
function igammaTemmeLarge(a, x) {
  var result;
  var sigma;
  var phi;
  var y;
  var z;
  sigma = (x - a) / a;
  phi = -lib_default106(sigma);
  y = a * phi;
  z = lib_default2(2 * phi);
  if (x < a) {
    z = -z;
  }
  workspace[0] = polyval_c0_default(z);
  workspace[1] = polyval_c1_default(z);
  workspace[2] = polyval_c2_default(z);
  workspace[3] = polyval_c3_default(z);
  workspace[4] = polyval_c4_default(z);
  workspace[5] = polyval_c5_default(z);
  workspace[6] = polyval_c6_default(z);
  workspace[7] = polyval_c7_default(z);
  workspace[8] = polyval_c8_default(z);
  workspace[9] = -5967612901927463e-19;
  result = lib_default105(workspace, 1 / a);
  result *= lib_default68(-y) / lib_default2(lib_default107 * a);
  if (x < a) {
    result = -result;
  }
  result += lib_default102(lib_default2(y)) / 2;
  return result;
}
var igamma_temme_large_default = igammaTemmeLarge;

function lowerIncompleteGammaSeries(a1, z1) {
  var result = 1;
  var a = a1;
  var z = z1;
  return next;
  function next() {
    var r = result;
    a += 1;
    result *= z / a;
    return r;
  }
}
var lower_incomplete_gamma_series_default = lowerIncompleteGammaSeries;

function lowerGammaSeries(a, z, initialValue) {
  var result;
  var s;
  initialValue = initialValue || 0;
  s = lower_incomplete_gamma_series_default(a, z);
  result = lib_default101(s, {
    "initialValue": initialValue
  });
  return result;
}
var lower_gamma_series_default = lowerGammaSeries;

function evalrational6(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return Infinity;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 709811.662581658 + x * (679979.8474157227 + x * (293136.7857211597 + x * (74887.54032914672 + x * (12555.290582413863 + x * (1443.4299244417066 + x * (115.24194596137347 + x * (6.309239205732627 + x * (0.22668404630224365 + x * (0.004826466289237662 + x * 4624429436045379e-20)))))))));
    s2 = 0 + x * (362880 + x * (1026576 + x * (1172700 + x * (723680 + x * (269325 + x * (63273 + x * (9450 + x * (870 + x * (45 + x * 1)))))))));
  } else {
    x = 1 / x;
    s1 = 4624429436045379e-20 + x * (0.004826466289237662 + x * (0.22668404630224365 + x * (6.309239205732627 + x * (115.24194596137347 + x * (1443.4299244417066 + x * (12555.290582413863 + x * (74887.54032914672 + x * (293136.7857211597 + x * (679979.8474157227 + x * 709811.662581658)))))))));
    s2 = 1 + x * (45 + x * (870 + x * (9450 + x * (63273 + x * (269325 + x * (723680 + x * (1172700 + x * (1026576 + x * (362880 + x * 0)))))))));
  }
  return s1 / s2;
}
var rational_pq_default4 = evalrational6;

var main_default77 = rational_pq_default4;

var lib_default108 = main_default77;

function regularisedGammaPrefix(a, z) {
  var prefix;
  var amza;
  var agh;
  var alz;
  var amz;
  var sq;
  var d2;
  agh = a + lib_default94 - 0.5;
  d2 = (z - a - lib_default94 + 0.5) / agh;
  if (a < 1) {
    if (z <= lib_default103 || a < 1 / lib_default86) {
      return lib_default68(a * lib_default12(z) - z - lib_default98(a));
    }
    return lib_default47(z, a) * lib_default68(-z) / lib_default90(a);
  }
  if (lib_default29(d2 * d2 * a) <= 100 && a > 150) {
    prefix = a * lib_default106(d2) + z * (0.5 - lib_default94) / agh;
    prefix = lib_default68(prefix);
  } else {
    alz = a * lib_default12(z / agh);
    amz = a - z;
    if (lib_default85(alz, amz) <= lib_default103 || lib_default83(alz, amz) >= lib_default99) {
      amza = amz / a;
      if (lib_default85(alz, amz) / 2 > lib_default103 && lib_default83(alz, amz) / 2 < lib_default99) {
        sq = lib_default47(z / agh, a / 2) * lib_default68(amz / 2);
        prefix = sq * sq;
      } else if (lib_default85(alz, amz) / 4 > lib_default103 && lib_default83(alz, amz) / 4 < lib_default99 && z > a) {
        sq = lib_default47(z / agh, a / 4) * lib_default68(amz / 4);
        prefix = sq * sq;
        prefix *= prefix;
      } else if (amza > lib_default103 && amza < lib_default99) {
        prefix = lib_default47(z * lib_default68(amza) / agh, a);
      } else {
        prefix = lib_default68(alz + amz);
      }
    } else {
      prefix = lib_default47(z / agh, a) * lib_default68(amz);
    }
  }
  prefix *= lib_default2(agh / lib_default79) / lib_default108(a);
  return prefix;
}
var regularised_gamma_prefix_default = regularisedGammaPrefix;

function powm1(b, x) {
  var result;
  var y;
  if (lib_default(b) || lib_default(x)) {
    return NaN;
  }
  if (x === 0) {
    return 0;
  }
  if (b === 0) {
    return -1;
  }
  if (b < 0 && x % 2 === 0) {
    b = -b;
  }
  if (b > 0) {
    if (lib_default29(x * (b - 1)) < 0.5 || lib_default29(x) < 0.2) {
      y = lib_default12(b) * x;
      if (y < 0.5) {
        return lib_default77(y);
      }
    }
  } else if (lib_default67(x) !== x) {
    return NaN;
  }
  result = lib_default47(b, x) - 1;
  if (lib_default28(result) || lib_default(result)) {
    return NaN;
  }
  return result;
}
var main_default78 = powm1;

var lib_default109 = main_default78;

function evalrational7(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.01803556856784494;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.01803556856784494 + x * (0.02512664961998968 + x * (0.049410315156753225 + x * (0.0172491608709614 + x * (-2594535632054381e-19 + x * (-5410098692152044e-19 + x * (-3245886498259485e-20 + x * 0))))));
    s2 = 1 + x * (1.962029871977952 + x * (1.4801966942423133 + x * (0.5413914320717209 + x * (0.09885042511280101 + x * (0.008213096746488934 + x * (22493629192211576e-20 + x * -22335276320861708e-23))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (-3245886498259485e-20 + x * (-5410098692152044e-19 + x * (-2594535632054381e-19 + x * (0.0172491608709614 + x * (0.049410315156753225 + x * (0.02512664961998968 + x * -0.01803556856784494))))));
    s2 = -22335276320861708e-23 + x * (22493629192211576e-20 + x * (0.008213096746488934 + x * (0.09885042511280101 + x * (0.5413914320717209 + x * (1.4801966942423133 + x * (1.962029871977952 + x * 1))))));
  }
  return s1 / s2;
}
var rational_p1q1_default = evalrational7;

function evalrational8(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.04906224540690395;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 0.04906224540690395 + x * (-0.09691175301595212 + x * (-0.4149833583594954 + x * (-0.4065671242119384 + x * (-0.1584135863906922 + x * (-0.024014982064857155 + x * -0.0010034668769627955)))));
    s2 = 1 + x * (3.0234982984646304 + x * (3.4873958536072385 + x * (1.9141558827442668 + x * (0.5071377386143635 + x * (0.05770397226904519 + x * 0.001957681026011072)))));
  } else {
    x = 1 / x;
    s1 = -0.0010034668769627955 + x * (-0.024014982064857155 + x * (-0.1584135863906922 + x * (-0.4065671242119384 + x * (-0.4149833583594954 + x * (-0.09691175301595212 + x * 0.04906224540690395)))));
    s2 = 0.001957681026011072 + x * (0.05770397226904519 + x * (0.5071377386143635 + x * (1.9141558827442668 + x * (3.4873958536072385 + x * (3.0234982984646304 + x * 1)))));
  }
  return s1 / s2;
}
var rational_p2q2_default = evalrational8;

function evalrational9(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.029232972183027003;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.029232972183027003 + x * (0.14421626775719232 + x * (-0.14244039073863127 + x * (0.05428096940550536 + x * (-0.008505359768683364 + x * (4311713426792973e-19 + x * 0)))));
    s2 = 1 + x * (-1.5016935605448505 + x * (0.846973248876495 + x * (-0.22009515181499575 + x * (0.02558279715597587 + x * (-0.0010066679553914337 + x * -8271935218912905e-22)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (4311713426792973e-19 + x * (-0.008505359768683364 + x * (0.05428096940550536 + x * (-0.14244039073863127 + x * (0.14421626775719232 + x * -0.029232972183027003)))));
    s2 = -8271935218912905e-22 + x * (-0.0010066679553914337 + x * (0.02558279715597587 + x * (-0.22009515181499575 + x * (0.846973248876495 + x * (-1.5016935605448505 + x * 1)))));
  }
  return s1 / s2;
}
var rational_p3q3_default = evalrational9;

var Y1 = 0.15896368026733398;
var Y2 = 0.5281534194946289;
var Y3 = 0.45201730728149414;
function lgammaSmallImp(z, zm1, zm2) {
  var prefix;
  var result;
  var r;
  var R;
  if (z < lib_default80) {
    return -lib_default12(z);
  }
  if (zm1 === 0 || zm2 === 0) {
    return 0;
  }
  result = 0;
  if (z > 2) {
    if (z >= 3) {
      do {
        z -= 1;
        zm2 -= 1;
        result += lib_default12(z);
      } while (z >= 3);
      zm2 = z - 2;
    }
    r = zm2 * (z + 1);
    R = rational_p1q1_default(zm2);
    result += r * Y1 + r * R;
    return result;
  }
  if (z < 1) {
    result += -lib_default12(z);
    zm2 = zm1;
    zm1 = z;
    z += 1;
  }
  if (z <= 1.5) {
    r = rational_p2q2_default(zm1);
    prefix = zm1 * zm2;
    result += prefix * Y2 + prefix * r;
    return result;
  }
  r = zm2 * zm1;
  R = rational_p3q3_default(-zm2);
  result += r * Y3 + r * R;
  return result;
}
var lgamma_small_imp_default = lgammaSmallImp;

function gamma1pm1(x) {
  if (lib_default(x)) {
    return NaN;
  }
  if (x < 0) {
    if (x < -0.5) {
      return lib_default90(1 + x) - 1;
    }
    return lib_default77(-lib_default78(x) + lgamma_small_imp_default(x + 2, x + 1, x));
  }
  if (x < 2) {
    return lib_default77(lgamma_small_imp_default(x + 1, x, x - 1));
  }
  return lib_default90(1 + x) - 1;
}
var main_default79 = gamma1pm1;

var lib_default110 = main_default79;

function smallGamma2Series(a, x) {
  var result;
  var apn;
  var n;
  var r;
  result = -x;
  x = -x;
  apn = a + 1;
  n = 1;
  return next;
  function next() {
    r = result / apn;
    result *= x;
    n += 1;
    result /= n;
    apn += 1;
    return r;
  }
}
var small_gamma2_series_default = smallGamma2Series;

function tgammaSmallUpperPart(a, x, invert) {
  var initialValue;
  var result;
  var pgam;
  var p101;
  var s;
  result = lib_default110(a);
  pgam = (result + 1) / a;
  p101 = lib_default109(x, a);
  result -= p101;
  result /= a;
  s = small_gamma2_series_default(a, x);
  p101 += 1;
  initialValue = invert ? pgam : 0;
  result = -p101 * lib_default101(s, {
    "initialValue": (initialValue - result) / p101
  });
  if (invert) {
    result = -result;
  }
  return [result, pgam];
}
var tgamma_small_upper_part_default = tgammaSmallUpperPart;

var FLOAT32_SMALLEST_NORMAL = 11754943508222875e-54;
var lib_default111 = FLOAT32_SMALLEST_NORMAL;

var MAX_ITER = 1e6;
function continuedFractionA(gen, factor, maxIter) {
  var isgenerator;
  var delta;
  var a0;
  var f2;
  var C4;
  var D;
  var v;
  isgenerator = typeof gen.next === "function";
  v = isgenerator ? gen.next().value : gen();
  f2 = v[1];
  a0 = v[0];
  if (f2 === 0) {
    f2 = lib_default111;
  }
  C4 = f2;
  D = 0;
  if (isgenerator === true) {
    do {
      v = gen.next().value;
      if (v) {
        D = v[1] + v[0] * D;
        if (D === 0) {
          D = lib_default111;
        }
        C4 = v[1] + v[0] / C4;
        if (C4 === 0) {
          C4 = lib_default111;
        }
        D = 1 / D;
        delta = C4 * D;
        f2 *= delta;
      }
    } while (lib_default29(delta - 1) > factor && --maxIter);
  } else {
    do {
      v = gen();
      if (v) {
        D = v[1] + v[0] * D;
        if (D === 0) {
          D = lib_default111;
        }
        C4 = v[1] + v[0] / C4;
        if (C4 === 0) {
          C4 = lib_default111;
        }
        D = 1 / D;
        delta = C4 * D;
        f2 *= delta;
      }
    } while (v && lib_default29(delta - 1) > factor && --maxIter);
  }
  return a0 / f2;
}
function continuedFractionB(gen, factor, maxIter) {
  var isgenerator;
  var delta;
  var f2;
  var C4;
  var D;
  var v;
  isgenerator = typeof gen.next === "function";
  v = isgenerator ? gen.next().value : gen();
  f2 = v[1];
  if (f2 === 0) {
    f2 = lib_default111;
  }
  C4 = f2;
  D = 0;
  if (isgenerator === true) {
    do {
      v = gen.next().value;
      if (v) {
        D = v[1] + v[0] * D;
        if (D === 0) {
          D = lib_default111;
        }
        C4 = v[1] + v[0] / C4;
        if (C4 === 0) {
          C4 = lib_default111;
        }
        D = 1 / D;
        delta = C4 * D;
        f2 *= delta;
      }
    } while (v && lib_default29(delta - 1) > factor && --maxIter);
  } else {
    do {
      v = gen();
      if (v) {
        D = v[1] + v[0] * D;
        if (D === 0) {
          D = lib_default111;
        }
        C4 = v[1] + v[0] / C4;
        if (C4 === 0) {
          C4 = lib_default111;
        }
        D = 1 / D;
        delta = C4 * D;
        f2 *= delta;
      }
    } while (v && lib_default29(delta - 1) > factor && --maxIter);
  }
  return f2;
}
function continuedFraction(generator, options) {
  var maxIter;
  var opts2;
  var eps;
  opts2 = {};
  if (arguments.length > 1) {
    opts2 = options;
  }
  maxIter = opts2.maxIter || MAX_ITER;
  eps = opts2.tolerance || lib_default80;
  if (opts2.keep) {
    return continuedFractionB(generator, eps, maxIter);
  }
  return continuedFractionA(generator, eps, maxIter);
}
var generators_default2 = continuedFraction;

var MAX_ITER2 = 1e6;
function continuedFractionA2(gen, factor, maxIter) {
  var delta;
  var a0;
  var C4;
  var D;
  var f2;
  var v;
  v = gen();
  f2 = v[1];
  a0 = v[0];
  if (f2 === 0) {
    f2 = lib_default111;
  }
  C4 = f2;
  D = 0;
  do {
    v = gen();
    if (v) {
      D = v[1] + v[0] * D;
      if (D === 0) {
        D = lib_default111;
      }
      C4 = v[1] + v[0] / C4;
      if (C4 === 0) {
        C4 = lib_default111;
      }
      D = 1 / D;
      delta = C4 * D;
      f2 *= delta;
    }
  } while (v && lib_default29(delta - 1) > factor && --maxIter);
  return a0 / f2;
}
function continuedFractionB2(gen, factor, maxIter) {
  var delta;
  var C4;
  var D;
  var f2;
  var v;
  v = gen();
  f2 = v[1];
  if (f2 === 0) {
    f2 = lib_default111;
  }
  C4 = f2;
  D = 0;
  do {
    v = gen();
    if (v) {
      D = v[1] + v[0] * D;
      if (D === 0) {
        D = lib_default111;
      }
      C4 = v[1] + v[0] / C4;
      if (C4 === 0) {
        C4 = lib_default111;
      }
      D = 1 / D;
      delta = C4 * D;
      f2 *= delta;
    }
  } while (v && lib_default29(delta - 1) > factor && --maxIter);
  return f2;
}
function continuedFraction2(generator, options) {
  var maxIter;
  var opts2;
  var eps;
  opts2 = {};
  if (arguments.length > 1) {
    opts2 = options;
  }
  eps = opts2.tolerance || lib_default80;
  maxIter = opts2.maxIter || MAX_ITER2;
  if (opts2.keep) {
    return continuedFractionB2(generator, eps, maxIter);
  }
  return continuedFractionA2(generator, eps, maxIter);
}
var basic_default2 = continuedFraction2;

var continuedFraction3;
if (has_generator_support_default()) {
  continuedFraction3 = generators_default2;
} else {
  continuedFraction3 = basic_default2;
}
var lib_default112 = continuedFraction3;

function upperIncompleteGammaFract(a1, z1) {
  var z = z1 - a1 + 1;
  var a = a1;
  var k = 0;
  return next;
  function next() {
    k += 1;
    z += 2;
    return [
      k * (a - k),
      z
    ];
  }
}
var upper_incomplete_gamma_fract_default = upperIncompleteGammaFract;

function upperGammaFraction(a, z) {
  var f2 = upper_incomplete_gamma_fract_default(a, z);
  return 1 / (z - a + 1 + lib_default112(f2));
}
var upper_gamma_fraction_default = upperGammaFraction;

function igammaFinal(x, a, regularized, upper) {
  var optimisedInvert;
  var evalMethod;
  var isHalfInt;
  var initValue;
  var useTemme;
  var isSmallA;
  var result;
  var invert;
  var isInt;
  var sigma;
  var res;
  var gam;
  var fa;
  var g;
  result = 0;
  invert = upper;
  isSmallA = a < 30 && a <= x + 1 && x < lib_default99;
  if (isSmallA) {
    fa = lib_default23(a);
    isInt = fa === a;
    isHalfInt = isInt ? false : lib_default29(fa - a) === 0.5;
  } else {
    isInt = false;
    isHalfInt = false;
  }
  if (isInt && x > 0.6) {
    invert = !invert;
    evalMethod = 0;
  } else if (isHalfInt && x > 0.2) {
    invert = !invert;
    evalMethod = 1;
  } else if (x < lib_default100 && a > 1) {
    evalMethod = 6;
  } else if (x > 1e3 && (a < x || lib_default29(a - 50) / x < 1)) {
    invert = !invert;
    evalMethod = 7;
  } else if (x < 0.5) {
    if (-0.4 / lib_default12(x) < a) {
      evalMethod = 2;
    } else {
      evalMethod = 3;
    }
  } else if (x < 1.1) {
    if (x * 0.75 < a) {
      evalMethod = 2;
    } else {
      evalMethod = 3;
    }
  } else {
    useTemme = false;
    if (regularized && a > 20) {
      sigma = lib_default29((x - a) / a);
      if (a > 200) {
        if (20 / a > sigma * sigma) {
          useTemme = true;
        }
      } else if (sigma < 0.4) {
        useTemme = true;
      }
    }
    if (useTemme) {
      evalMethod = 5;
    } else if (x - 1 / (3 * x) < a) {
      evalMethod = 2;
    } else {
      evalMethod = 4;
      invert = !invert;
    }
  }
  switch (evalMethod) {
    case 0:
      result = finite_gamma_q_default(a, x);
      if (regularized === false) {
        result *= lib_default90(a);
      }
      break;
    case 1:
      result = finite_half_gamma_q_default(a, x);
      if (regularized === false) {
        result *= lib_default90(a);
      }
      break;
    case 2:
      result = regularized ? regularised_gamma_prefix_default(a, x) : full_igamma_prefix_default(a, x);
      if (result !== 0) {
        initValue = 0;
        optimisedInvert = false;
        if (invert) {
          initValue = regularized ? 1 : lib_default90(a);
          if (regularized || result >= 1 || lib_default86 * result > initValue) {
            initValue /= result;
            if (regularized || a < 1 || lib_default86 / a > initValue) {
              initValue *= -a;
              optimisedInvert = true;
            } else {
              initValue = 0;
            }
          } else {
            initValue = 0;
          }
        }
        result *= lower_gamma_series_default(a, x, initValue) / a;
        if (optimisedInvert) {
          invert = false;
          result = -result;
        }
      }
      break;
    case 3:
      invert = !invert;
      res = tgamma_small_upper_part_default(a, x, invert);
      result = res[0];
      g = res[1];
      invert = false;
      if (regularized) {
        result /= g;
      }
      break;
    case 4:
      result = regularized ? regularised_gamma_prefix_default(a, x) : full_igamma_prefix_default(a, x);
      if (result !== 0) {
        result *= upper_gamma_fraction_default(a, x);
      }
      break;
    case 5:
      result = igamma_temme_large_default(a, x);
      if (x >= a) {
        invert = !invert;
      }
      break;
    case 6:
      result = regularized ? lib_default47(x, a) / lib_default90(a + 1) : lib_default47(x, a) / a;
      result *= 1 - a * x / (a + 1);
      break;
    case 7:
      result = regularized ? regularised_gamma_prefix_default(a, x) : full_igamma_prefix_default(a, x);
      result /= x;
      if (result !== 0) {
        result *= tgamma_i_large_x_default(a, x);
      }
      break;
  }
  if (regularized && result > 1) {
    result = 1;
  }
  if (invert) {
    gam = regularized ? 1 : lib_default90(a);
    result = gam - result;
  }
  return result;
}
var igamma_final_default = igammaFinal;

function gammainc(x, a, regularized, upper) {
  var normalized;
  var initValue;
  var invert;
  var result;
  if (x < 0 || a <= 0) {
    return NaN;
  }
  normalized = regularized === void 0 ? true : regularized;
  invert = upper;
  if (a >= lib_default91 && !normalized) {
    if (invert && a * 4 < x) {
      result = a * lib_default12(x) - x;
      result += lib_default12(upper_gamma_fraction_default(a, x));
    } else if (!invert && a > 4 * x) {
      result = a * lib_default12(x) - x;
      initValue = 0;
      result += lib_default12(lower_gamma_series_default(a, x, initValue) / a);
    } else {
      result = igamma_final_default(x, a, true, invert);
      if (result === 0) {
        if (invert) {
          result = 1 + 1 / (12 * a) + 1 / (288 * a * a);
          result = lib_default12(result) - a + (a - 0.5) * lib_default12(a);
          result += lib_default12(lib_default88);
        } else {
          result = a * lib_default12(x) - x;
          initValue = 0;
          result += lib_default12(lower_gamma_series_default(a, x, initValue) / a);
        }
      } else {
        result = lib_default12(result) + lib_default98(a);
      }
    }
    if (result > lib_default99) {
      return lib_default27;
    }
    return lib_default68(result);
  }
  return igamma_final_default(x, a, normalized, invert);
}
var main_default80 = gammainc;

var lib_default113 = main_default80;

function fullIGammaPrefix2(a, z) {
  var prefix;
  var alz;
  alz = a * lib_default12(z);
  if (z >= 1) {
    if (alz < lib_default99 && -z > lib_default103) {
      prefix = lib_default47(z, a) * lib_default68(-z);
    } else if (a >= 1) {
      prefix = lib_default47(z / lib_default68(z / a), a);
    } else {
      prefix = lib_default68(alz - z);
    }
  } else if (alz > lib_default103) {
    prefix = lib_default47(z, a) * lib_default68(-z);
  } else if (z / a < lib_default99) {
    prefix = lib_default47(z / lib_default68(z / a), a);
  } else {
    prefix = lib_default68(alz - z);
  }
  return prefix;
}
var full_igamma_prefix_default2 = fullIGammaPrefix2;

function regularizedGammaPrefix(a, z) {
  var prefix;
  var amza;
  var agh;
  var alz;
  var amz;
  var sq;
  var d2;
  agh = a + lib_default94 - 0.5;
  d2 = (z - a - lib_default94 + 0.5) / agh;
  if (a < 1) {
    if (z <= lib_default103) {
      return lib_default68(a * lib_default12(z) - z - lib_default98(a));
    }
    return lib_default47(z, a) * lib_default68(-z) / lib_default90(a);
  }
  if (lib_default29(d2 * d2 * a) <= 100 && a > 150) {
    prefix = a * (lib_default78(d2) - d2) + z * (0.5 - lib_default94) / agh;
    prefix = lib_default68(prefix);
  } else {
    alz = a * lib_default12(z / agh);
    amz = a - z;
    if (lib_default85(alz, amz) <= lib_default103 || lib_default83(alz, amz) >= lib_default99) {
      amza = amz / a;
      if (lib_default85(alz, amz) / 2 > lib_default103 && lib_default83(alz, amz) / 2 < lib_default99) {
        sq = lib_default47(z / agh, a / 2) * lib_default68(amz / 2);
        prefix = sq * sq;
      } else if (lib_default85(alz, amz) / 4 > lib_default103 && lib_default83(alz, amz) / 4 < lib_default99 && z > a) {
        sq = lib_default47(z / agh, a / 4) * lib_default68(amz / 4);
        prefix = sq * sq;
        prefix *= prefix;
      } else if (amza > lib_default103 && amza < lib_default99) {
        prefix = lib_default47(z * lib_default68(amza) / agh, a);
      } else {
        prefix = lib_default68(alz + amz);
      }
    } else {
      prefix = lib_default47(z / agh, a) * lib_default68(amz);
    }
  }
  prefix *= lib_default2(agh / lib_default79) / lib_default108(a);
  return prefix;
}
var regularized_gamma_prefix_default = regularizedGammaPrefix;

var p = new Array(30);
function betaSmallBLargeASeries(a, b, x, y, s0, mult, normalized) {
  var prefix;
  var tmp1;
  var tnp1;
  var sum2;
  var b2n;
  var bm1;
  var lx2;
  var lxp;
  var mbn;
  var lx;
  var t4;
  var h;
  var j;
  var m;
  var n;
  var r;
  var t;
  var u;
  bm1 = b - 1;
  t = a + bm1 / 2;
  if (y < 0.35) {
    lx = lib_default78(-y);
  } else {
    lx = lib_default12(x);
  }
  u = -t * lx;
  h = regularized_gamma_prefix_default(b, u);
  if (h <= lib_default43) {
    return s0;
  }
  if (normalized) {
    prefix = h / lib_default95(a, b);
    prefix /= lib_default47(t, b);
  } else {
    prefix = full_igamma_prefix_default2(b, u) / lib_default47(t, b);
  }
  prefix *= mult;
  p[0] = 1;
  j = lib_default113(u, b, true, true);
  j /= h;
  sum2 = s0 + prefix * j;
  tnp1 = 1;
  lx2 = lx / 2;
  lx2 *= lx2;
  lxp = 1;
  t4 = 4 * t * t;
  b2n = b;
  for (n = 1; n < p.length; ++n) {
    tnp1 += 2;
    p[n] = 0;
    mbn = b - n;
    tmp1 = 3;
    for (m = 1; m < n; ++m) {
      mbn = m * b - n;
      p[n] += mbn * p[n - m] / lib_default92(tmp1);
      tmp1 += 2;
    }
    p[n] /= n;
    p[n] += bm1 / lib_default92(tnp1);
    j = (b2n * (b2n + 1) * j + (u + b2n + 1) * lxp) / t4;
    lxp *= lx2;
    b2n += 2;
    r = prefix * p[n] * j;
    sum2 += r;
    if (r > 1) {
      if (lib_default29(r) < lib_default29(lib_default80 * sum2)) {
        break;
      }
    } else if (lib_default29(r / lib_default80) < lib_default29(sum2)) {
      break;
    }
  }
  return sum2;
}
var beta_small_b_large_a_series_default = betaSmallBLargeASeries;

function risingFactorialRatio(a, b, k) {
  var result;
  var i;
  if (k === 0) {
    return 1;
  }
  result = 1;
  for (i = 0; i < k; i++) {
    result *= (a + i) / (b + i);
  }
  return result;
}
var rising_factorial_ratio_default = risingFactorialRatio;

function maxabs(x, y) {
  return lib_default83(lib_default29(x), lib_default29(y));
}
var main_default81 = maxabs;

var lib_default114 = main_default81;

function minabs(x, y) {
  return lib_default85(lib_default29(x), lib_default29(y));
}
var main_default82 = minabs;

var lib_default115 = main_default82;

function ibetaPowerTerms(a, b, x, y, normalized) {
  var result;
  var smallA;
  var ratio;
  var agh;
  var bgh;
  var cgh;
  var l1;
  var l2;
  var l3;
  var p110;
  var b1;
  var b2;
  var c2;
  var l;
  if (!normalized) {
    return lib_default47(x, a) * lib_default47(y, b);
  }
  c2 = a + b;
  agh = a + lib_default94 - 0.5;
  bgh = b + lib_default94 - 0.5;
  cgh = c2 + lib_default94 - 0.5;
  result = lib_default108(c2);
  result /= lib_default108(a) * lib_default108(b);
  result *= lib_default2(bgh / lib_default79);
  result *= lib_default2(agh / cgh);
  l1 = (x * b - y * agh) / agh;
  l2 = (y * a - x * bgh) / bgh;
  if (lib_default115(l1, l2) < 0.2) {
    if (l1 * l2 > 0 || lib_default85(a, b) < 1) {
      if (lib_default29(l1) < 0.1) {
        result *= lib_default68(a * lib_default78(l1));
      } else {
        result *= lib_default47(x * cgh / agh, a);
      }
      if (lib_default29(l2) < 0.1) {
        result *= lib_default68(b * lib_default78(l2));
      } else {
        result *= lib_default47(y * cgh / bgh, b);
      }
    } else if (lib_default114(l1, l2) < 0.5) {
      smallA = a < b;
      ratio = b / a;
      if (smallA && ratio * l2 < 0.1 || !smallA && l1 / ratio > 0.1) {
        l3 = lib_default77(ratio * lib_default78(l2));
        l3 = l1 + l3 + l3 * l1;
        l3 = a * lib_default78(l3);
        result *= lib_default68(l3);
      } else {
        l3 = lib_default77(lib_default78(l1) / ratio);
        l3 = l2 + l3 + l3 * l2;
        l3 = b * lib_default78(l3);
        result *= lib_default68(l3);
      }
    } else if (lib_default29(l1) < lib_default29(l2)) {
      l = a * lib_default78(l1) + b * lib_default12(y * cgh / bgh);
      if (l <= lib_default103 || l >= lib_default99) {
        l += lib_default12(result);
        if (l >= lib_default99) {
          return NaN;
        }
        result = lib_default68(l);
      } else {
        result *= lib_default68(l);
      }
    } else {
      l = b * lib_default78(l2) + a * lib_default12(x * cgh / agh);
      if (l <= lib_default103 || l >= lib_default99) {
        l += lib_default12(result);
        if (l >= lib_default99) {
          return NaN;
        }
        result = lib_default68(l);
      } else {
        result *= lib_default68(l);
      }
    }
  } else {
    b1 = x * cgh / agh;
    b2 = y * cgh / bgh;
    l1 = a * lib_default12(b1);
    l2 = b * lib_default12(b2);
    if (l1 >= lib_default99 || l1 <= lib_default103 || l2 >= lib_default99 || l2 <= lib_default103) {
      if (a < b) {
        p110 = lib_default47(b2, b / a);
        l3 = a * (lib_default12(b1) + lib_default12(p110));
        if (l3 < lib_default99 && l3 > lib_default103) {
          result *= lib_default47(p110 * b1, a);
        } else {
          l2 += l1 + lib_default12(result);
          if (l2 >= lib_default99) {
            return NaN;
          }
          result = lib_default68(l2);
        }
      } else {
        p110 = lib_default47(b1, a / b);
        l3 = (lib_default12(p110) + lib_default12(b2)) * b;
        if (l3 < lib_default99 && l3 > lib_default103) {
          result *= lib_default47(p110 * b2, b);
        } else {
          l2 += l1 + lib_default12(result);
          if (l2 >= lib_default99) {
            return NaN;
          }
          result = lib_default68(l2);
        }
      }
    } else {
      result *= lib_default47(b1, a) * lib_default47(b2, b);
    }
  }
  return result;
}
var ibeta_power_terms_default = ibetaPowerTerms;

var OPTS = {
  "keep": true,
  "maxIter": 1e3
};
function ibetaFraction2t(a, b, x, y) {
  var m = 0;
  return next;
  function next() {
    var denom;
    var aN;
    var bN;
    aN = (a + m - 1) * (a + b + m - 1) * m * (b - m) * x * x;
    denom = a + 2 * m - 1;
    aN /= denom * denom;
    bN = m;
    bN += m * (b - m) * x / (a + 2 * m - 1);
    bN += (a + m) * (a * y - b * x + 1 + m * (2 - x)) / (a + 2 * m + 1);
    m += 1;
    return [aN, bN];
  }
}
function ibetaFraction2(a, b, x, y, normalized, out) {
  var result;
  var fract;
  var f2;
  result = ibeta_power_terms_default(a, b, x, y, normalized);
  if (out) {
    out[1] = result;
  }
  if (result === 0) {
    return result;
  }
  f2 = ibetaFraction2t(a, b, x, y);
  fract = lib_default112(f2, OPTS);
  return result / fract;
}
var ibeta_fraction2_default = ibetaFraction2;

var FLOAT64_MAX_SAFE_INTEGER = 9007199254740991;
var lib_default116 = FLOAT64_MAX_SAFE_INTEGER;

function gcd(a, b) {
  var k = 0;
  var t;
  if (a === 0) {
    return b;
  }
  if (b === 0) {
    return a;
  }
  while ((a & 1) === 0 && (b & 1) === 0) {
    a >>>= 1;
    b >>>= 1;
    k += 1;
  }
  while ((a & 1) === 0) {
    a >>>= 1;
  }
  while (b) {
    while ((b & 1) === 0) {
      b >>>= 1;
    }
    if (a > b) {
      t = b;
      b = a;
      a = t;
    }
    b -= a;
  }
  return a << k;
}
var bitwise_binary_gcd_default = gcd;

function gcd2(a, b) {
  var k = 1;
  var t;
  if (a === 0) {
    return b;
  }
  if (b === 0) {
    return a;
  }
  while (a % 2 === 0 && b % 2 === 0) {
    a /= 2;
    b /= 2;
    k *= 2;
  }
  while (a % 2 === 0) {
    a /= 2;
  }
  while (b) {
    while (b % 2 === 0) {
      b /= 2;
    }
    if (a > b) {
      t = b;
      b = a;
      a = t;
    }
    b -= a;
  }
  return k * a;
}
var binary_gcd_default = gcd2;

function gcd3(a, b) {
  if (lib_default(a) || lib_default(b)) {
    return NaN;
  }
  if (a === lib_default27 || b === lib_default27 || a === lib_default11 || b === lib_default11) {
    return NaN;
  }
  if (!(lib_default24(a) && lib_default24(b))) {
    return NaN;
  }
  if (a < 0) {
    a = -a;
  }
  if (b < 0) {
    b = -b;
  }
  if (a <= lib_default87 && b <= lib_default87) {
    return bitwise_binary_gcd_default(a, b);
  }
  return binary_gcd_default(a, b);
}
var main_default83 = gcd3;

var lib_default117 = main_default83;

function binomcoef(n, k) {
  var res;
  var sgn;
  var b;
  var c2;
  var d2;
  var g;
  var s;
  if (lib_default(n) || lib_default(k)) {
    return NaN;
  }
  if (!lib_default24(n) || !lib_default24(k)) {
    return NaN;
  }
  if (k < 0) {
    return 0;
  }
  sgn = 1;
  if (n < 0) {
    n = -n + k - 1;
    if (lib_default26(k)) {
      sgn *= -1;
    }
  }
  if (k > n) {
    return 0;
  }
  if (k === 0 || k === n) {
    return sgn;
  }
  if (k === 1 || k === n - 1) {
    return sgn * n;
  }
  if (n - k < k) {
    k = n - k;
  }
  s = lib_default23(lib_default116 / n);
  res = 1;
  for (d2 = 1; d2 <= k; d2++) {
    if (res > s) {
      break;
    }
    res *= n;
    res /= d2;
    n -= 1;
  }
  if (d2 > k) {
    return sgn * res;
  }
  b = binomcoef(n, k - d2 + 1);
  if (b === lib_default27) {
    return sgn * b;
  }
  c2 = binomcoef(k, k - d2 + 1);
  g = lib_default117(b, c2);
  b /= g;
  c2 /= g;
  res /= c2;
  return sgn * res * b;
}
var main_default84 = binomcoef;

var lib_default118 = main_default84;

function binomialCCDF(n, k, x, y) {
  var startTerm;
  var result;
  var start;
  var term;
  var i;
  result = lib_default47(x, n);
  if (result > lib_default43) {
    term = result;
    for (i = lib_default23(n - 1); i > k; i--) {
      term *= (i + 1) * y / ((n - i) * x);
      result += term;
    }
  } else {
    start = lib_default23(n * x);
    if (start <= k + 1) {
      start = lib_default23(k + 2);
    }
    result = lib_default47(x, start) * lib_default47(y, n - start);
    result *= lib_default118(lib_default23(n), lib_default23(start));
    if (result === 0) {
      for (i = start - 1; i > k; i--) {
        result += lib_default47(x, i) * lib_default47(y, n - i);
        result *= lib_default118(lib_default23(n), lib_default23(i));
      }
    } else {
      term = result;
      startTerm = result;
      for (i = start - 1; i > k; i--) {
        term *= (i + 1) * y / ((n - i) * x);
        result += term;
      }
      term = startTerm;
      for (i = start + 1; i <= n; i++) {
        term *= (n - i + 1) * x / (i * y);
        result += term;
      }
    }
  }
  return result;
}
var binomial_ccdf_default = binomialCCDF;

function ibetaAStep(a, b, x, y, k, normalized, out) {
  var prefix;
  var term;
  var sum2;
  var i;
  prefix = ibeta_power_terms_default(a, b, x, y, normalized);
  if (out) {
    out[1] = prefix;
  }
  prefix /= a;
  if (prefix === 0) {
    return prefix;
  }
  sum2 = 1;
  term = 1;
  for (i = 0; i < k - 1; ++i) {
    term *= (a + b + i) * x / (a + i + 1);
    sum2 += term;
  }
  prefix *= sum2;
  return prefix;
}
var ibeta_a_step_default = ibetaAStep;

var opts = {
  "maxTerms": 100
};
function ibetaSeriesT(a, b, x, result) {
  var poch = 1 - b;
  var n = 1;
  return next;
  function next() {
    var r = result / a;
    a += 1;
    result *= poch * x / n;
    n += 1;
    poch += 1;
    return r;
  }
}
function ibetaSeries(a, b, x, s0, normalized, out, y) {
  var result;
  var agh;
  var bgh;
  var cgh;
  var l1;
  var l2;
  var c2;
  var s;
  if (normalized) {
    c2 = a + b;
    agh = a + lib_default94 - 0.5;
    bgh = b + lib_default94 - 0.5;
    cgh = c2 + lib_default94 - 0.5;
    result = lib_default108(c2) / (lib_default108(a) * lib_default108(b));
    l1 = lib_default12(cgh / bgh) * (b - 0.5);
    l2 = lib_default12(x * cgh / agh) * a;
    if (l1 > lib_default103 && l1 < lib_default99 && l2 > lib_default103 && l2 < lib_default99) {
      if (a * b < bgh * 10) {
        result *= lib_default68((b - 0.5) * lib_default78(a / bgh));
      } else {
        result *= lib_default47(cgh / bgh, b - 0.5);
      }
      result *= lib_default47(x * cgh / agh, a);
      result *= lib_default2(agh / lib_default79);
      if (out) {
        out[1] = result * lib_default47(y, b);
      }
    } else {
      result = lib_default12(result) + l1 + l2 + (lib_default12(agh) - 1) / 2;
      if (out) {
        out[1] = lib_default68(result + b * lib_default12(y));
      }
      result = lib_default68(result);
    }
  } else {
    result = lib_default47(x, a);
  }
  if (result < lib_default43) {
    return s0;
  }
  s = ibetaSeriesT(a, b, x, result);
  opts.initialValue = s0;
  return lib_default101(s, opts);
}
var ibeta_series_default = ibetaSeries;

var ONE_OVER_PI = 1 / lib_default5;
function ibetaImp(x, a, b, regularized, upper, out, stride, offset) {
  var lambda;
  var prefix;
  var fract;
  var bbar;
  var div;
  var tmp;
  var i0;
  var i1;
  var k;
  var n;
  var p101;
  var y;
  y = 1 - x;
  i0 = offset;
  i1 = offset + stride;
  out[i1] = -1;
  if (lib_default(x) || x < 0 || x > 1) {
    out[i0] = NaN;
    out[i1] = NaN;
    return out;
  }
  if (regularized) {
    if (a < 0 || b < 0) {
      out[i0] = NaN;
      out[i1] = NaN;
      return out;
    }
    if (a === 0) {
      if (b === 0) {
        out[i0] = NaN;
        out[i1] = NaN;
        return out;
      }
      if (b > 0) {
        out[i0] = upper ? 0 : 1;
        return out;
      }
    } else if (b === 0) {
      if (a > 0) {
        out[i0] = upper ? 1 : 0;
        return out;
      }
    }
  } else if (a <= 0 || b <= 0) {
    out[i0] = NaN;
    out[i1] = NaN;
    return out;
  }
  if (x === 0) {
    if (a === 1) {
      out[i1] = 1;
    } else {
      out[i1] = a < 1 ? lib_default86 / 2 : lib_default43 * 2;
    }
    if (upper) {
      out[i0] = regularized ? 1 : lib_default81(a, b);
      return out;
    }
    out[i0] = 0;
    return out;
  }
  if (x === 1) {
    if (b === 1) {
      out[i1] = 1;
    } else {
      out[i1] = b < 1 ? lib_default86 / 2 : lib_default43 * 2;
    }
    if (upper) {
      out[i0] = 0;
    } else {
      out[i0] = regularized ? 1 : lib_default81(a, b);
    }
    return out;
  }
  if (a === 0.5 && b === 0.5) {
    out[i1] = ONE_OVER_PI * lib_default2(y * x);
    p101 = upper ? lib_default4(lib_default2(y)) : lib_default4(lib_default2(x));
    p101 /= lib_default56;
    if (!regularized) {
      p101 *= lib_default5;
    }
    out[i0] = p101;
    return out;
  }
  if (a === 1) {
    tmp = b;
    b = a;
    a = tmp;
    tmp = y;
    y = x;
    x = tmp;
    upper = !upper;
  }
  if (b === 1) {
    if (a === 1) {
      out[i0] = upper ? y : x;
      out[i1] = 1;
      return out;
    }
    out[i1] = a * lib_default47(x, a - 1);
    if (y < 0.5) {
      p101 = upper ? -lib_default77(a * lib_default78(-y)) : lib_default68(a * lib_default78(-y));
    } else {
      p101 = upper ? -(lib_default47(x, a) - 1) : lib_default47(x, a);
    }
    if (!regularized) {
      p101 /= a;
    }
    out[i0] = p101;
    return out;
  }
  if (lib_default85(a, b) <= 1) {
    if (x > 0.5) {
      tmp = b;
      b = a;
      a = tmp;
      tmp = y;
      y = x;
      x = tmp;
      upper = !upper;
    }
    if (lib_default83(a, b) <= 1) {
      if (a >= lib_default85(0.2, b) || lib_default47(x, a) <= 0.9) {
        if (upper) {
          fract = -(regularized ? 1 : lib_default81(a, b));
          upper = false;
          fract = -ibeta_series_default(a, b, x, fract, regularized, out, y);
        } else {
          fract = ibeta_series_default(a, b, x, 0, regularized, out, y);
        }
      } else {
        tmp = b;
        b = a;
        a = tmp;
        tmp = y;
        y = x;
        x = tmp;
        upper = !upper;
        if (y >= 0.3) {
          if (upper) {
            fract = -(regularized ? 1 : lib_default81(a, b));
            upper = false;
            fract = -ibeta_series_default(a, b, x, fract, regularized, out, y);
          } else {
            fract = ibeta_series_default(a, b, x, 0, regularized, out, y);
          }
        } else {
          if (regularized) {
            prefix = 1;
          } else {
            prefix = rising_factorial_ratio_default(a + b, a, 20);
          }
          fract = ibeta_a_step_default(a, b, x, y, 20, regularized, out);
          if (upper) {
            fract -= regularized ? 1 : lib_default81(a, b);
            upper = false;
            fract = -beta_small_b_large_a_series_default(a + 20, b, x, y, fract, prefix, regularized);
          } else {
            fract = beta_small_b_large_a_series_default(a + 20, b, x, y, fract, prefix, regularized);
          }
        }
      }
    } else if (b <= 1 || x < 0.1 && lib_default47(b * x, a) <= 0.7) {
      if (upper) {
        fract = -(regularized ? 1 : lib_default81(a, b));
        upper = false;
        fract = -ibeta_series_default(a, b, x, fract, regularized, out, y);
      } else {
        fract = ibeta_series_default(a, b, x, 0, regularized, out, y);
      }
    } else {
      tmp = b;
      b = a;
      a = tmp;
      tmp = y;
      y = x;
      x = tmp;
      upper = !upper;
      if (y >= 0.3) {
        if (upper) {
          fract = -(regularized ? 1 : lib_default81(a, b));
          upper = false;
          fract = -ibeta_series_default(a, b, x, fract, regularized, out, y);
        } else {
          fract = ibeta_series_default(a, b, x, 0, regularized, out, y);
        }
      } else if (a >= 15) {
        if (upper) {
          fract = -(regularized ? 1 : lib_default81(a, b));
          upper = false;
          fract = -beta_small_b_large_a_series_default(a, b, x, y, fract, 1, regularized);
        } else {
          fract = beta_small_b_large_a_series_default(a, b, x, y, 0, 1, regularized);
        }
      } else {
        if (regularized) {
          prefix = 1;
        } else {
          prefix = rising_factorial_ratio_default(a + b, a, 20);
        }
        fract = ibeta_a_step_default(a, b, x, y, 20, regularized, out);
        if (upper) {
          fract -= regularized ? 1 : lib_default81(a, b);
          upper = false;
          fract = -beta_small_b_large_a_series_default(a + 20, b, x, y, fract, prefix, regularized);
        } else {
          fract = beta_small_b_large_a_series_default(a + 20, b, x, y, fract, prefix, regularized);
        }
      }
    }
  } else {
    if (a < b) {
      lambda = a - (a + b) * x;
    } else {
      lambda = (a + b) * y - b;
    }
    if (lambda < 0) {
      tmp = b;
      b = a;
      a = tmp;
      tmp = y;
      y = x;
      x = tmp;
      upper = !upper;
    }
    if (b < 40) {
      if (lib_default23(a) === a && lib_default23(b) === b && a < lib_default87 - 100) {
        k = a - 1;
        n = b + k;
        fract = binomial_ccdf_default(n, k, x, y);
        if (!regularized) {
          fract *= lib_default81(a, b);
        }
      } else if (b * x <= 0.7) {
        if (upper) {
          fract = -(regularized ? 1 : lib_default81(a, b));
          upper = false;
          fract = -ibeta_series_default(a, b, x, fract, regularized, out, y);
        } else {
          fract = ibeta_series_default(a, b, x, 0, regularized, out, y);
        }
      } else if (a > 15) {
        n = lib_default23(b);
        if (n === b) {
          n -= 1;
        }
        bbar = b - n;
        if (regularized) {
          prefix = 1;
        } else {
          prefix = rising_factorial_ratio_default(a + bbar, bbar, n);
        }
        fract = ibeta_a_step_default(bbar, a, y, x, n, regularized);
        fract = beta_small_b_large_a_series_default(a, bbar, x, y, fract, 1, regularized);
        fract /= prefix;
      } else if (regularized) {
        n = lib_default23(b);
        bbar = b - n;
        if (bbar <= 0) {
          n -= 1;
          bbar += 1;
        }
        fract = ibeta_a_step_default(bbar, a, y, x, n, regularized);
        fract += ibeta_a_step_default(a, bbar, x, y, 20, regularized);
        if (upper) {
          fract -= 1;
        }
        fract = beta_small_b_large_a_series_default(a + 20, bbar, x, y, fract, 1, regularized);
        if (upper) {
          fract = -fract;
          upper = false;
        }
      } else {
        fract = ibeta_fraction2_default(a, b, x, y, regularized, out);
      }
    } else {
      fract = ibeta_fraction2_default(a, b, x, y, regularized, out);
    }
  }
  if (out[i1] < 0) {
    out[i1] = ibeta_power_terms_default(a, b, x, y, true);
  }
  div = y * x;
  if (out[i1] !== 0) {
    if (lib_default86 * div < out[i1]) {
      out[i1] = lib_default86 / 2;
    } else {
      out[i1] /= div;
    }
  }
  out[i0] = upper ? (regularized ? 1 : lib_default81(a, b)) - fract : fract;
  return out;
}
var assign_default3 = ibetaImp;

function kernelBetainc(x, a, b, regularized, upper) {
  return assign_default3(x, a, b, regularized, upper, [0, 0], 1, 0);
}
var main_default85 = kernelBetainc;

main_default85.assign = assign_default3;
var lib_default119 = main_default85;

var kernelBetainc2 = lib_default119.assign;
function betainc(x, a, b, regularized, upper) {
  var out = [0, 0];
  regularized = regularized === false ? false : true;
  upper = upper === true ? true : false;
  kernelBetainc2(x, a, b, regularized, upper, out, 1, 0);
  return out[0];
}
var main_default86 = betainc;

var lib_default120 = main_default86;

function cdf3(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return lib_default120(x, alpha, beta2);
}
var main_default87 = cdf3;

function factory11(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return 0;
    }
    if (x >= 1) {
      return 1;
    }
    return lib_default120(x, alpha, beta2);
  }
}
var factory_default11 = factory11;

main_default87.factory = factory_default11;
var lib_default121 = main_default87;

function evalpoly40(x) {
  if (x === 0) {
    return 0.13333333333320124;
  }
  return 0.13333333333320124 + x * (0.021869488294859542 + x * (0.0035920791075913124 + x * (5880412408202641e-19 + x * (7817944429395571e-20 + x * -18558637485527546e-21))));
}
var polyval_t_odd_default = evalpoly40;

function evalpoly41(x) {
  if (x === 0) {
    return 0.05396825397622605;
  }
  return 0.05396825397622605 + x * (0.0088632398235993 + x * (0.0014562094543252903 + x * (2464631348184699e-19 + x * (7140724913826082e-20 + x * 2590730518636337e-20))));
}
var polyval_t_even_default = evalpoly41;

var PIO4 = 0.7853981633974483;
var PIO4LO = 3061616997868383e-32;
var T0 = 0.3333333333333341;
var HIGH_WORD_ABS_MASK = 2147483647 | 0;
function kernelTan(x, y, k) {
  var hx;
  var ix;
  var a;
  var r;
  var s;
  var t;
  var v;
  var w;
  var z;
  hx = lib_default8(x);
  ix = hx & HIGH_WORD_ABS_MASK | 0;
  if (ix >= 1072010280) {
    if (x < 0) {
      x = -x;
      y = -y;
    }
    z = PIO4 - x;
    w = PIO4LO - y;
    x = z + w;
    y = 0;
  }
  z = x * x;
  w = z * z;
  r = polyval_t_odd_default(w);
  v = z * polyval_t_even_default(w);
  s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T0 * s;
  w = x + r;
  if (ix >= 1072010280) {
    v = k;
    return (1 - (hx >> 30 & 2)) * (v - 2 * (x - (w * w / (w + v) - r)));
  }
  if (k === 1) {
    return w;
  }
  z = lib_default31(w, 0);
  v = r - (z - x);
  a = -1 / w;
  t = lib_default31(a, 0);
  s = 1 + t * z;
  return t + a * (s + t * v);
}
var main_default88 = kernelTan;

var lib_default122 = main_default88;

var buffer2 = [0, 0];
var HIGH_WORD_PIO42 = 1072243195 | 0;
var HIGH_WORD_TWO_NEG_272 = 1044381696 | 0;
function tan(x) {
  var ix;
  var n;
  ix = lib_default8(x);
  ix &= lib_default33;
  if (ix <= HIGH_WORD_PIO42) {
    if (ix < HIGH_WORD_TWO_NEG_272) {
      return x;
    }
    return lib_default122(x, 0, 1);
  }
  if (ix >= lib_default41) {
    return NaN;
  }
  n = lib_default54(x, buffer2);
  return lib_default122(buffer2[0], buffer2[1], 1 - ((n & 1) << 1));
}
var main_default89 = tan;

var lib_default123 = main_default89;

function evalpoly42(x) {
  if (x === 0) {
    return 0.08333333333333333;
  }
  return 0.08333333333333333 + x * (-0.008333333333333333 + x * (0.003968253968253968 + x * (-0.004166666666666667 + x * (0.007575757575757576 + x * (-0.021092796092796094 + x * (0.08333333333333333 + x * -0.4432598039215686))))));
}
var polyval_p_default4 = evalpoly42;

function digamma(x) {
  var y;
  var z;
  x -= 1;
  y = lib_default12(x) + 1 / (2 * x);
  z = 1 / (x * x);
  return y - z * polyval_p_default4(z);
}
var asymptotic_expansion_default = digamma;

function evalrational10(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.25479851061131553;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 0.25479851061131553 + x * (-0.3255503118680449 + x * (-0.6503185377089651 + x * (-0.28919126444774784 + x * (-0.04525132144873906 + x * (-0.002071332116774595 + x * 0)))));
    s2 = 1 + x * (2.076711702373047 + x * (1.4606242909763516 + x * (0.43593529692665967 + x * (0.054151797245674226 + x * (0.0021284987017821146 + x * -5578984132167551e-22)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (-0.002071332116774595 + x * (-0.04525132144873906 + x * (-0.28919126444774784 + x * (-0.6503185377089651 + x * (-0.3255503118680449 + x * 0.25479851061131553)))));
    s2 = -5578984132167551e-22 + x * (0.0021284987017821146 + x * (0.054151797245674226 + x * (0.43593529692665967 + x * (1.4606242909763516 + x * (2.076711702373047 + x * 1)))));
  }
  return s1 / s2;
}
var rational_pq_default5 = evalrational10;

var root1 = 1569415565 / 1073741824;
var root2 = 381566830 / 1073741824 / 1073741824;
var root3 = 9016312093258695e-35;
var Y4 = 0.9955816268920898;
function digamma2(x) {
  var g;
  var r;
  g = x - root1;
  g -= root2;
  g -= root3;
  r = rational_pq_default5(x - 1);
  return g * Y4 + g * r;
}
var rational_approximation_default = digamma2;

var MIN_SAFE_ASYMPTOTIC = 10;
function digamma3(x) {
  var rem;
  var tmp;
  if (lib_default(x) || x === 0) {
    return NaN;
  }
  if (x <= -1) {
    x = 1 - x;
    rem = x - lib_default23(x);
    if (rem > 0.5) {
      rem -= 1;
    }
    if (rem === 0) {
      return NaN;
    }
    tmp = lib_default5 / lib_default123(lib_default5 * rem);
  } else {
    tmp = 0;
  }
  if (x >= MIN_SAFE_ASYMPTOTIC) {
    tmp += asymptotic_expansion_default(x);
    return tmp;
  }
  while (x > 2) {
    x -= 1;
    tmp += 1 / x;
  }
  while (x < 1) {
    tmp -= 1 / x;
    x += 1;
  }
  tmp += rational_approximation_default(x);
  return tmp;
}
var main_default90 = digamma3;

var lib_default124 = main_default90;

var LN_SQRT_TWO_PI = 0.9189385332046728;
var lib_default125 = LN_SQRT_TWO_PI;

var ALGMCS = [
  1276642195630063e-46,
  -3401102254316749e-45,
  1025680058010471e-43,
  -35475981581010704e-43,
  14292273559424982e-41,
  -6831888753985767e-39,
  39628370610464347e-38,
  -2868042435334643e-35,
  2683181998482699e-33,
  -3399615005417722e-31,
  6221098041892606e-29,
  -1809129475572494e-26,
  981082564692473e-23,
  -1384948176067564e-20,
  0.16663894804518634
];
var LEN = ALGMCS.length;
function dcseval(x) {
  var twox;
  var b2;
  var b1;
  var b0;
  var i;
  if (x < -1.1 || x > 1.1) {
    return NaN;
  }
  b1 = 0;
  b0 = 0;
  twox = 2 * x;
  for (i = 0; i < LEN; i++) {
    b2 = b1;
    b1 = b0;
    b0 = twox * b1 - b2 + ALGMCS[i];
  }
  return (b0 - b2) * 0.5;
}
var dceval_default = dcseval;

var XBIG = 9490626562425156e-8;
var XMAX = 3745194030963158e291;
function gammaCorrection(x) {
  if (x < 10) {
    return NaN;
  }
  if (x >= XMAX) {
    return 0;
  }
  if (x < XBIG) {
    return dceval_default(2 * lib_default47(10 / x, 2) - 1) / x;
  }
  return 1 / (x * 12);
}
var gamma_correction_default = gammaCorrection;

function betaln(a, b) {
  var corr;
  var p101;
  var q;
  p101 = lib_default85(a, b);
  q = lib_default83(a, b);
  if (p101 < 0) {
    return NaN;
  }
  if (p101 === 0) {
    return lib_default27;
  }
  if (q === lib_default27) {
    return lib_default11;
  }
  if (p101 >= 10) {
    corr = gamma_correction_default(p101) + gamma_correction_default(q) - gamma_correction_default(p101 + q);
    return -0.5 * lib_default12(q) + lib_default125 + corr + (p101 - 0.5) * lib_default12(p101 / (p101 + q)) + q * lib_default78(-p101 / (p101 + q));
  }
  if (q >= 10) {
    corr = gamma_correction_default(q) - gamma_correction_default(p101 + q);
    return lib_default98(p101) + corr + p101 - p101 * lib_default12(p101 + q) + (q - 0.5) * lib_default78(-p101 / (p101 + q));
  }
  return lib_default12(lib_default90(p101) * (lib_default90(q) / lib_default90(p101 + q)));
}
var main_default91 = betaln;

var lib_default126 = main_default91;

function entropy3(alpha, beta2) {
  var out;
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  out = lib_default126(alpha, beta2);
  out -= (alpha - 1) * lib_default124(alpha);
  out -= (beta2 - 1) * lib_default124(beta2);
  out += (alpha + beta2 - 2) * lib_default124(alpha + beta2);
  return out;
}
var main_default92 = entropy3;

var lib_default127 = main_default92;

function kurtosis3(alpha, beta2) {
  var axb;
  var amb;
  var apb;
  var out;
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  axb = alpha * beta2;
  amb = alpha - beta2;
  apb = alpha + beta2;
  out = amb * amb * (apb + 1);
  out -= axb * (apb + 2);
  out *= 6;
  out /= axb * (apb + 2) * (apb + 3);
  return out;
}
var main_default93 = kurtosis3;

var lib_default128 = main_default93;

function logcdf2(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return lib_default11;
  }
  if (x >= 1) {
    return 0;
  }
  return lib_default12(lib_default120(x, alpha, beta2));
}
var main_default94 = logcdf2;

function factory12(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return lib_default11;
    }
    if (x >= 1) {
      return 0;
    }
    return lib_default12(lib_default120(x, alpha, beta2));
  }
}
var factory_default12 = factory12;

main_default94.factory = factory_default12;
var lib_default129 = main_default94;

function logpdf2(x, alpha, beta2) {
  var out;
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x < 0 || x > 1) {
    return lib_default11;
  }
  if (x === 0) {
    if (alpha < 1) {
      return lib_default27;
    }
    if (alpha > 1) {
      return lib_default11;
    }
    return lib_default12(beta2);
  }
  if (x === 1) {
    if (beta2 < 1) {
      return lib_default27;
    }
    if (beta2 > 1) {
      return lib_default11;
    }
    return lib_default12(alpha);
  }
  out = (alpha - 1) * lib_default12(x);
  out += (beta2 - 1) * lib_default78(-x);
  out -= lib_default126(alpha, beta2);
  return out;
}
var main_default95 = logpdf2;

function factory13(alpha, beta2) {
  var betalnAB;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  betalnAB = lib_default126(alpha, beta2);
  return logpdf27;
  function logpdf27(x) {
    var out;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0 || x > 1) {
      return lib_default11;
    }
    if (x === 0) {
      if (alpha < 1) {
        return lib_default27;
      }
      if (alpha > 1) {
        return lib_default11;
      }
      return lib_default12(beta2);
    }
    if (x === 1) {
      if (beta2 < 1) {
        return lib_default27;
      }
      if (beta2 > 1) {
        return lib_default11;
      }
      return lib_default12(alpha);
    }
    out = -betalnAB;
    out += (alpha - 1) * lib_default12(x) + (beta2 - 1) * lib_default78(-x);
    return out;
  }
}
var factory_default13 = factory13;

main_default95.factory = factory_default13;
var lib_default130 = main_default95;

function mean3(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return alpha / (alpha + beta2);
}
var main_default96 = mean3;

var lib_default131 = main_default96;

function evalrational11(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -5087819496582806e-19;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -5087819496582806e-19 + x * (-0.008368748197417368 + x * (0.03348066254097446 + x * (-0.012692614766297404 + x * (-0.03656379714117627 + x * (0.02198786811111689 + x * (0.008226878746769157 + x * (-0.005387729650712429 + x * (0 + x * 0))))))));
    s2 = 1 + x * (-0.9700050433032906 + x * (-1.5657455823417585 + x * (1.5622155839842302 + x * (0.662328840472003 + x * (-0.7122890234154284 + x * (-0.05273963823400997 + x * (0.07952836873415717 + x * (-0.0023339375937419 + x * 8862163904564247e-19))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0 + x * (-0.005387729650712429 + x * (0.008226878746769157 + x * (0.02198786811111689 + x * (-0.03656379714117627 + x * (-0.012692614766297404 + x * (0.03348066254097446 + x * (-0.008368748197417368 + x * -5087819496582806e-19))))))));
    s2 = 8862163904564247e-19 + x * (-0.0023339375937419 + x * (0.07952836873415717 + x * (-0.05273963823400997 + x * (-0.7122890234154284 + x * (0.662328840472003 + x * (1.5622155839842302 + x * (-1.5657455823417585 + x * (-0.9700050433032906 + x * 1))))))));
  }
  return s1 / s2;
}
var rational_p1q1_default2 = evalrational11;

function evalrational12(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.20243350835593876;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.20243350835593876 + x * (0.10526468069939171 + x * (8.3705032834312 + x * (17.644729840837403 + x * (-18.851064805871424 + x * (-44.6382324441787 + x * (17.445385985570866 + x * (21.12946554483405 + x * -3.6719225470772936)))))));
    s2 = 1 + x * (6.242641248542475 + x * (3.971343795334387 + x * (-28.66081804998 + x * (-20.14326346804852 + x * (48.560921310873994 + x * (10.826866735546016 + x * (-22.643693341313973 + x * 1.7211476576120028)))))));
  } else {
    x = 1 / x;
    s1 = -3.6719225470772936 + x * (21.12946554483405 + x * (17.445385985570866 + x * (-44.6382324441787 + x * (-18.851064805871424 + x * (17.644729840837403 + x * (8.3705032834312 + x * (0.10526468069939171 + x * -0.20243350835593876)))))));
    s2 = 1.7211476576120028 + x * (-22.643693341313973 + x * (10.826866735546016 + x * (48.560921310873994 + x * (-20.14326346804852 + x * (-28.66081804998 + x * (3.971343795334387 + x * (6.242641248542475 + x * 1)))))));
  }
  return s1 / s2;
}
var rational_p2q2_default2 = evalrational12;

function evalrational13(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.1311027816799519;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.1311027816799519 + x * (-0.16379404719331705 + x * (0.11703015634199525 + x * (0.38707973897260434 + x * (0.3377855389120359 + x * (0.14286953440815717 + x * (0.029015791000532906 + x * (0.0021455899538880526 + x * (-6794655751811263e-22 + x * (28522533178221704e-24 + x * -681149956853777e-24)))))))));
    s2 = 1 + x * (3.4662540724256723 + x * (5.381683457070069 + x * (4.778465929458438 + x * (2.5930192162362027 + x * (0.848854343457902 + x * (0.15226433829533179 + x * (0.011059242293464892 + x * (0 + x * (0 + x * 0)))))))));
  } else {
    x = 1 / x;
    s1 = -681149956853777e-24 + x * (28522533178221704e-24 + x * (-6794655751811263e-22 + x * (0.0021455899538880526 + x * (0.029015791000532906 + x * (0.14286953440815717 + x * (0.3377855389120359 + x * (0.38707973897260434 + x * (0.11703015634199525 + x * (-0.16379404719331705 + x * -0.1311027816799519)))))))));
    s2 = 0 + x * (0 + x * (0 + x * (0.011059242293464892 + x * (0.15226433829533179 + x * (0.848854343457902 + x * (2.5930192162362027 + x * (4.778465929458438 + x * (5.381683457070069 + x * (3.4662540724256723 + x * 1)))))))));
  }
  return s1 / s2;
}
var rational_p3q3_default2 = evalrational13;

function evalrational14(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.0350353787183178;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.0350353787183178 + x * (-0.0022242652921344794 + x * (0.018557330651423107 + x * (0.009508047013259196 + x * (0.0018712349281955923 + x * (15754461742496055e-20 + x * (460469890584318e-20 + x * (-2304047769118826e-25 + x * 26633922742578204e-28)))))));
    s2 = 1 + x * (1.3653349817554064 + x * (0.7620591645536234 + x * (0.22009110576413124 + x * (0.03415891436709477 + x * (0.00263861676657016 + x * (7646752923027944e-20 + x * (0 + x * 0)))))));
  } else {
    x = 1 / x;
    s1 = 26633922742578204e-28 + x * (-2304047769118826e-25 + x * (460469890584318e-20 + x * (15754461742496055e-20 + x * (0.0018712349281955923 + x * (0.009508047013259196 + x * (0.018557330651423107 + x * (-0.0022242652921344794 + x * -0.0350353787183178)))))));
    s2 = 0 + x * (0 + x * (7646752923027944e-20 + x * (0.00263861676657016 + x * (0.03415891436709477 + x * (0.22009110576413124 + x * (0.7620591645536234 + x * (1.3653349817554064 + x * 1)))))));
  }
  return s1 / s2;
}
var rational_p4q4_default = evalrational14;

function evalrational15(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.016743100507663373;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.016743100507663373 + x * (-0.0011295143874558028 + x * (0.001056288621524929 + x * (20938631748758808e-20 + x * (14962478375834237e-21 + x * (44969678992770644e-23 + x * (4625961635228786e-24 + x * (-2811287356288318e-29 + x * 9905570997331033e-32)))))));
    s2 = 1 + x * (0.5914293448864175 + x * (0.1381518657490833 + x * (0.016074608709367652 + x * (9640118070051656e-19 + x * (27533547476472603e-21 + x * (282243172016108e-21 + x * (0 + x * 0)))))));
  } else {
    x = 1 / x;
    s1 = 9905570997331033e-32 + x * (-2811287356288318e-29 + x * (4625961635228786e-24 + x * (44969678992770644e-23 + x * (14962478375834237e-21 + x * (20938631748758808e-20 + x * (0.001056288621524929 + x * (-0.0011295143874558028 + x * -0.016743100507663373)))))));
    s2 = 0 + x * (0 + x * (282243172016108e-21 + x * (27533547476472603e-21 + x * (9640118070051656e-19 + x * (0.016074608709367652 + x * (0.1381518657490833 + x * (0.5914293448864175 + x * 1)))))));
  }
  return s1 / s2;
}
var rational_p5q5_default = evalrational15;

var Y12 = 0.08913147449493408;
var Y22 = 2.249481201171875;
var Y32 = 0.807220458984375;
var Y42 = 0.9399557113647461;
var Y5 = 0.9836282730102539;
function erfcinv(x) {
  var sign;
  var qs;
  var q;
  var g;
  var r;
  if (lib_default(x)) {
    return NaN;
  }
  if (x === 0) {
    return lib_default27;
  }
  if (x === 2) {
    return lib_default11;
  }
  if (x === 1) {
    return 0;
  }
  if (x > 2 || x < 0) {
    return NaN;
  }
  if (x > 1) {
    sign = -1;
    q = 2 - x;
  } else {
    sign = 1;
    q = x;
  }
  x = 1 - q;
  if (x <= 0.5) {
    g = x * (x + 10);
    r = rational_p1q1_default2(x);
    return sign * (g * Y12 + g * r);
  }
  if (q >= 0.25) {
    g = lib_default2(-2 * lib_default12(q));
    q -= 0.25;
    r = rational_p2q2_default2(q);
    return sign * (g / (Y22 + r));
  }
  q = lib_default2(-lib_default12(q));
  if (q < 3) {
    qs = q - 1.125;
    r = rational_p3q3_default2(qs);
    return sign * (Y32 * q + r * q);
  }
  if (q < 6) {
    qs = q - 3;
    r = rational_p4q4_default(qs);
    return sign * (Y42 * q + r * q);
  }
  qs = q - 6;
  r = rational_p5q5_default(qs);
  return sign * (Y5 * q + r * q);
}
var main_default97 = erfcinv;

var lib_default132 = main_default97;

var MOREBITS2 = 6123233995736766e-32;
function acos(x) {
  var z;
  if (lib_default(x)) {
    return NaN;
  }
  if (x < -1 || x > 1) {
    return NaN;
  }
  if (x > 0.5) {
    return 2 * lib_default4(lib_default2(0.5 - 0.5 * x));
  }
  z = lib_default3 - lib_default4(x);
  z += MOREBITS2;
  z += lib_default3;
  return z;
}
var main_default98 = acos;

var lib_default133 = main_default98;

var SQRT2 = 1.4142135623730951;
var lib_default134 = SQRT2;

function evalpoly43(x) {
  if (x === 0) {
    return 0.16666666666666666;
  }
  return 0.16666666666666666 + x * 0.16666666666666666;
}
var polyval_co14_default = evalpoly43;

function evalpoly44(x) {
  if (x === 0) {
    return 0.058333333333333334;
  }
  return 0.058333333333333334 + x * (0.06666666666666667 + x * 0.008333333333333333);
}
var polyval_co15_default = evalpoly44;

function evalpoly45(x) {
  if (x === 0) {
    return 0.0251984126984127;
  }
  return 0.0251984126984127 + x * (0.026785714285714284 + x * (0.0017857142857142857 + x * 1984126984126984e-19));
}
var polyval_co16_default = evalpoly45;

function evalpoly46(x) {
  if (x === 0) {
    return 0.012039792768959435;
  }
  return 0.012039792768959435 + x * (0.010559964726631394 + x * (-0.0011078042328042327 + x * (3747795414462081e-19 + x * 27557319223985893e-22)));
}
var polyval_co17_default = evalpoly46;

function evalpoly47(x) {
  if (x === 0) {
    return 0.003837005972422639;
  }
  return 0.003837005972422639 + x * (0.00610392115600449 + x * (-0.0016095979637646305 + x * (5945867404200738e-19 + x * (-6270542728876062e-20 + x * 2505210838544172e-23))));
}
var polyval_co18_default = evalpoly47;

function evalpoly48(x) {
  if (x === 0) {
    return 0.0032177478835464946;
  }
  return 0.0032177478835464946 + x * (0.0010898206731540065 + x * (-0.0012579159844784845 + x * (6908420797309686e-19 + x * (-16376804137220805e-20 + x * (154012654012654e-19 + x * 16059043836821613e-26)))));
}
var polyval_co19_default = evalpoly48;

function evalpoly49(x) {
  if (x === 0) {
    return 0.001743826229834001;
  }
  return 0.001743826229834001 + x * (3353097688001788e-20 + x * (-7624513544032393e-19 + x * (6451304695145635e-19 + x * (-249472580470431e-18 + x * (49255746366361444e-21 + x * (-39851014346715405e-22 + x * 7647163731819816e-28))))));
}
var polyval_co20_default = evalpoly49;

function evalpoly50(x) {
  if (x === 0) {
    return 9647274732138864e-19;
  }
  return 9647274732138864e-19 + x * (-3110108632631878e-19 + x * (-36307660358786886e-20 + x * (5140660578834113e-19 + x * (-29133414466938067e-20 + x * (9086710793521991e-20 + x * (-15303004486655377e-21 + x * (10914179173496788e-22 + x * 28114572543455206e-31)))))));
}
var polyval_co21_default = evalpoly50;

function evalpoly51(x) {
  if (x === 0) {
    return 5422926281312969e-19;
  }
  return 5422926281312969e-19 + x * (-3694266780000966e-19 + x * (-10230378073700413e-20 + x * (35764655430568635e-20 + x * (-28690924218514614e-20 + x * (12645437628698076e-20 + x * (-33202652391372056e-21 + x * (4890304529197534e-21 + x * (-3123956959982987e-22 + x * 822063524662433e-32))))))));
}
var polyval_co22_default = evalpoly51;

var c0 = 0;
var c = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
function inverseStudentsTBodySeries(df, u) {
  var idf;
  var v;
  v = lib_default95(df / 2, 0.5) * lib_default2(df * lib_default5) * (u - 0.5);
  idf = 1 / df;
  c[1] = polyval_co14_default(idf);
  c[2] = polyval_co15_default(idf);
  c[3] = polyval_co16_default(idf);
  c[4] = polyval_co17_default(idf);
  c[5] = polyval_co18_default(idf);
  c[6] = polyval_co19_default(idf);
  c[7] = polyval_co20_default(idf);
  c[8] = polyval_co21_default(idf);
  c[9] = polyval_co22_default(idf);
  return c0 + v * lib_default105(c, v * v);
}
var inverse_students_t_body_series_default = inverseStudentsTBodySeries;

var d = [0, 0, 0, 0, 0, 0, 0];
function inverseStudentsTTailSeries(df, v) {
  var result;
  var power;
  var div;
  var np2;
  var np4;
  var np6;
  var rn;
  var w;
  w = lib_default95(df / 2, 0.5) * lib_default2(df * lib_default5) * v;
  np2 = df + 2;
  np4 = df + 4;
  np6 = df + 6;
  d[0] = 1;
  d[1] = -(df + 1) / (2 * np2);
  np2 *= df + 2;
  d[2] = -df * (df + 1) * (df + 3) / (8 * np2 * np4);
  np2 *= df + 2;
  d[3] = -df * (df + 1) * (df + 5) * ((3 * df + 7) * df - 2) / (48 * np2 * np4 * np6);
  np2 *= df + 2;
  np4 *= df + 4;
  d[4] = -df * (df + 1) * (df + 7) * (((((15 * df + 154) * df + 465) * df + 286) * df - 336) * df + 64) / (384 * np2 * np4 * np6 * (df + 8));
  np2 *= df + 2;
  d[5] = -df * (df + 1) * (df + 3) * (df + 9) * ((((((35 * df + 452) * df + 1573) * df + 600) * df - 2020) * df + 928) * df - 128) / (1280 * np2 * np4 * np6 * (df + 8) * (df + 10));
  np2 *= df + 2;
  np4 *= df + 4;
  np6 *= df + 6;
  d[6] = -df * (df + 1) * (df + 11) * (((((((((((945 * df + 31506) * df + 425858) * df + 2980236) * df + 11266745) * df + 20675018) * df + 7747124) * df - 22574632) * df - 8565600) * df + 18108416) * df - 7099392) * df + 884736) / (46080 * np2 * np4 * np6 * (df + 8) * (df + 10) * (df + 12));
  rn = lib_default2(df);
  div = lib_default47(rn * w, 1 / df);
  power = div * div;
  result = lib_default105(d, power);
  result *= rn;
  result /= div;
  return -result;
}
var inverse_students_t_tail_series_default = inverseStudentsTTailSeries;

function inverseStudentsTHill(ndf, u) {
  var a;
  var b;
  var c2;
  var d2;
  var q;
  var x;
  var y;
  if (ndf > 1e20) {
    return -lib_default132(2 * u) * lib_default134;
  }
  a = 1 / (ndf - 0.5);
  b = 48 / (a * a);
  c2 = ((20700 * a / b - 98) * a - 16) * a + 96.36;
  d2 = ((94.5 / (b + c2) - 3) / b + 1) * lib_default2(a * lib_default56) * ndf;
  y = lib_default47(d2 * 2 * u, 2 / ndf);
  if (y > 0.05 + a) {
    x = -lib_default132(2 * u) * lib_default134;
    y = x * x;
    if (ndf < 5) {
      c2 += 0.3 * (ndf - 4.5) * (x + 0.6);
    }
    c2 += (((0.05 * d2 * x - 5) * x - 7) * x - 2) * x + b;
    y = (((((0.4 * y + 6.3) * y + 36) * y + 94.5) / c2 - y - 3) / b + 1) * x;
    y = lib_default77(a * y * y);
  } else {
    y = ((1 / (((ndf + 6) / (ndf * y) - 0.089 * d2 - 0.822) * (ndf + 2) * 3) + 0.5 / (ndf + 4)) * y - 1) * (ndf + 1) / (ndf + 2) + 1 / y;
  }
  q = lib_default2(ndf * y);
  return -q;
}
var inverse_students_t_hill_default = inverseStudentsTHill;

var DF_THRESHOLD = 268435456;
var ONE_THIRD2 = 1 / 3;
var EXP = 2 * 53 / 3;
var C = 0.8549879733383485;
function inverseStudentsT(df, u, v) {
  var crossover;
  var tolerance;
  var rootAlpha;
  var invert;
  var result;
  var alpha;
  var tmp;
  var p02;
  var p210;
  var p410;
  var p510;
  var p101;
  var r;
  var x;
  var a;
  var b;
  result = 0;
  if (u > v) {
    tmp = v;
    v = u;
    u = tmp;
    invert = true;
  } else {
    invert = false;
  }
  if (lib_default23(df) === df && df < 20) {
    tolerance = lib_default45(1, EXP);
    switch (lib_default23(df)) {
      case 1:
        if (u === 0.5) {
          result = 0;
        } else {
          result = -lib_default96(lib_default5 * u) / lib_default55(lib_default5 * u);
        }
        break;
      case 2:
        result = (2 * u - 1) / lib_default2(2 * u * v);
        break;
      case 4:
        alpha = 4 * u * v;
        rootAlpha = lib_default2(alpha);
        r = 4 * lib_default96(lib_default133(rootAlpha) / 3) / rootAlpha;
        x = lib_default2(r - 4);
        result = u - 0.5 < 0 ? -x : x;
        break;
      case 6:
        if (u < 1e-150) {
          return (invert ? -1 : 1) * inverse_students_t_hill_default(df, u);
        }
        a = 4 * (u - u * u);
        b = lib_default47(a, ONE_THIRD2);
        p101 = 6 * (1 + C * (1 / b - 1));
        do {
          p210 = p101 * p101;
          p410 = p210 * p210;
          p510 = p101 * p410;
          p02 = p101;
          p101 = 2 * (8 * a * p510 - 270 * p210 + 2187) / (5 * (4 * a * p410 - 216 * p101 - 243));
        } while (lib_default29((p101 - p02) / p101) > tolerance);
        p101 = lib_default2(p101 - df);
        result = u - 0.5 < 0 ? -p101 : p101;
        break;
      default:
        if (df > DF_THRESHOLD) {
          result = lib_default132(2 * u) * lib_default134;
        } else if (df < 3) {
          crossover = 0.2742 - df * 0.0242143;
          if (u > crossover) {
            result = inverse_students_t_body_series_default(df, u);
          } else {
            result = inverse_students_t_tail_series_default(df, u);
          }
        } else {
          crossover = lib_default45(1, lib_default53(df / -0.654));
          if (u > crossover) {
            result = inverse_students_t_hill_default(df, u);
          } else {
            result = inverse_students_t_tail_series_default(df, u);
          }
        }
    }
  } else if (df > DF_THRESHOLD) {
    result = -lib_default132(2 * u) * lib_default134;
  } else if (df < 3) {
    crossover = 0.2742 - df * 0.0242143;
    if (u > crossover) {
      result = inverse_students_t_body_series_default(df, u);
    } else {
      result = inverse_students_t_tail_series_default(df, u);
    }
  } else {
    crossover = lib_default45(1, lib_default53(df / -0.654));
    if (u > crossover) {
      result = inverse_students_t_hill_default(df, u);
    } else {
      result = inverse_students_t_tail_series_default(df, u);
    }
  }
  return invert ? -result : result;
}
var inverse_students_t_default = inverseStudentsT;

function findIBetaInvFromTDist(a, p101, py) {
  var df;
  var u;
  var v;
  var t;
  u = p101 / 2;
  v = 1 - u;
  df = a * 2;
  t = inverse_students_t_default(df, u, v);
  if (py) {
    py.value = t * t / (df + t * t);
  }
  return df / (df + t * t);
}
var find_ibeta_inv_from_t_dist_default = findIBetaInvFromTDist;

var workspace2 = [0, 0, 0, 0, 0, 0, 0];
var terms = [0, 0, 0, 0];
function temme1(a, b, z) {
  var eta0;
  var eta2;
  var eta;
  var B2;
  var B3;
  var B;
  var c2;
  eta0 = lib_default132(2 * z);
  eta0 /= -lib_default2(a / 2);
  terms[0] = eta0;
  B = b - a;
  B2 = B * B;
  B3 = B2 * B;
  workspace2[0] = -B * lib_default134 / 2;
  workspace2[1] = (1 - 2 * B) / 8;
  workspace2[2] = -(B * lib_default134 / 48);
  workspace2[3] = -1 / 192;
  workspace2[4] = -B * lib_default134 / 3840;
  workspace2[5] = 0;
  workspace2[6] = 0;
  terms[1] = lib_default105(workspace2, eta0);
  workspace2[0] = B * lib_default134 * (3 * B - 2) / 12;
  workspace2[1] = (20 * B2 - 12 * B + 1) / 128;
  workspace2[2] = B * lib_default134 * (20 * B - 1) / 960;
  workspace2[3] = (16 * B2 + 30 * B - 15) / 4608;
  workspace2[4] = B * lib_default134 * (21 * B + 32) / 53760;
  workspace2[5] = (-(32 * B2) + 63) / 368640;
  workspace2[6] = -B * lib_default134 * (120 * B + 17) / 25804480;
  terms[2] = lib_default105(workspace2, eta0);
  workspace2[0] = B * lib_default134 * (-75 * B2 + 80 * B - 16) / 480;
  workspace2[1] = (-1080 * B3 + 868 * B2 - 90 * B - 45) / 9216;
  workspace2[2] = B * lib_default134 * (-1190 * B2 + 84 * B + 373) / 53760;
  workspace2[3] = (-2240 * B3 - 2508 * B2 + 2100 * B - 165) / 368640;
  workspace2[4] = 0;
  workspace2[5] = 0;
  workspace2[6] = 0;
  terms[3] = lib_default105(workspace2, eta0);
  eta = lib_default105(terms, 1 / a);
  eta2 = eta * eta;
  c2 = -lib_default68(-eta2 / 2);
  if (eta2 === 0) {
    return 0.5;
  }
  return (1 + eta * lib_default2((1 + c2) / eta2)) / 2;
}
var temme1_default = temme1;

var BIG = lib_default86 / 4;
function temmeRootFinder(t, a) {
  return roots;
  function roots(x) {
    var f1;
    var f2;
    var y;
    y = 1 - x;
    if (y === 0) {
      return [-BIG, -BIG];
    }
    if (x === 0) {
      return [-BIG, -BIG];
    }
    f2 = lib_default12(x) + a * lib_default12(y) + t;
    f1 = 1 / x - a / y;
    return [f2, f1];
  }
}
var root_finder_default = temmeRootFinder;

function signum(x) {
  if (x === 0 || lib_default(x)) {
    return x;
  }
  return x < 0 ? -1 : 1;
}
var main_default99 = signum;

var lib_default135 = main_default99;

function newtonRaphsonIterate(fun, guess, min2, max2, digits, maxIter) {
  var f0last;
  var delta1;
  var delta2;
  var factor;
  var result;
  var count;
  var delta;
  var res;
  var f0;
  var f1;
  f0 = 0;
  f0last = 0;
  result = guess;
  factor = lib_default45(1, 1 - digits);
  delta = lib_default86;
  delta1 = lib_default86;
  delta2 = lib_default86;
  count = maxIter;
  do {
    f0last = f0;
    delta2 = delta1;
    delta1 = delta;
    res = fun(result);
    f0 = res[0];
    f1 = res[1];
    count -= 1;
    if (f0 === 0) {
      break;
    }
    if (f1 === 0) {
      if (f0last === 0) {
        if (result === min2) {
          guess = max2;
        } else {
          guess = min2;
        }
        f0last = fun(guess);
        delta = guess - result;
      }
      if (lib_default135(f0last) * lib_default135(f0) < 0) {
        if (delta < 0) {
          delta = (result - min2) / 2;
        } else {
          delta = (result - max2) / 2;
        }
      } else if (delta < 0) {
        delta = (result - max2) / 2;
      } else {
        delta = (result - min2) / 2;
      }
    } else {
      delta = f0 / f1;
    }
    if (lib_default29(delta * 2) > lib_default29(delta2)) {
      delta = delta > 0 ? (result - min2) / 2 : (result - max2) / 2;
    }
    guess = result;
    result -= delta;
    if (result <= min2) {
      delta = 0.5 * (guess - min2);
      result = guess - delta;
      if (result === min2 || result === max2) {
        break;
      }
    } else if (result >= max2) {
      delta = 0.5 * (guess - max2);
      result = guess - delta;
      if (result === min2 || result === max2) {
        break;
      }
    }
    if (delta > 0) {
      max2 = guess;
    } else {
      min2 = guess;
    }
  } while (count && lib_default29(result * factor) < lib_default29(delta));
  return result;
}
var newton_raphson_default = newtonRaphsonIterate;

function evalpoly52(x) {
  if (x === 0) {
    return -1;
  }
  return -1 + x * (-5 + x * 5);
}
var polyval_co1_default = evalpoly52;

function evalpoly53(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (21 + x * (-69 + x * 46));
}
var polyval_co2_default = evalpoly53;

function evalpoly54(x) {
  if (x === 0) {
    return 7;
  }
  return 7 + x * (-2 + x * (33 + x * (-62 + x * 31)));
}
var polyval_co3_default = evalpoly54;

function evalpoly55(x) {
  if (x === 0) {
    return 25;
  }
  return 25 + x * (-52 + x * (-17 + x * (88 + x * (-115 + x * 46))));
}
var polyval_co4_default = evalpoly55;

function evalpoly56(x) {
  if (x === 0) {
    return 7;
  }
  return 7 + x * (12 + x * (-78 + x * 52));
}
var polyval_co5_default = evalpoly56;

function evalpoly57(x) {
  if (x === 0) {
    return -7;
  }
  return -7 + x * (2 + x * (183 + x * (-370 + x * 185)));
}
var polyval_co6_default = evalpoly57;

function evalpoly58(x) {
  if (x === 0) {
    return -533;
  }
  return -533 + x * (776 + x * (-1835 + x * (10240 + x * (-13525 + x * 5410))));
}
var polyval_co7_default = evalpoly58;

function evalpoly59(x) {
  if (x === 0) {
    return -1579;
  }
  return -1579 + x * (3747 + x * (-3372 + x * (-15821 + x * (45588 + x * (-45213 + x * 15071)))));
}
var polyval_co8_default = evalpoly59;

function evalpoly60(x) {
  if (x === 0) {
    return 449;
  }
  return 449 + x * (-1259 + x * (-769 + x * (6686 + x * (-9260 + x * 3704))));
}
var polyval_co9_default = evalpoly60;

function evalpoly61(x) {
  if (x === 0) {
    return 63149;
  }
  return 63149 + x * (-151557 + x * (140052 + x * (-727469 + x * (2239932 + x * (-2251437 + x * 750479)))));
}
var polyval_co10_default = evalpoly61;

function evalpoly62(x) {
  if (x === 0) {
    return 29233;
  }
  return 29233 + x * (-78755 + x * (105222 + x * (146879 + x * (-1602610 + x * (3195183 + x * (-2554139 + x * 729754))))));
}
var polyval_co11_default = evalpoly62;

function evalpoly63(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (-13 + x * 13);
}
var polyval_co12_default = evalpoly63;

function evalpoly64(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (21 + x * (-69 + x * 46));
}
var polyval_co13_default = evalpoly64;

var workspace3 = [0, 0, 0, 0, 0, 0];
var terms2 = [0, 0, 0, 0];
function temme2(z, r, theta) {
  var upper;
  var lower;
  var alpha;
  var roots;
  var eta0;
  var eta;
  var sc7;
  var sc6;
  var sc5;
  var sc4;
  var sc3;
  var sc2;
  var sc;
  var lu;
  var s2;
  var c2;
  var c3;
  var s;
  var u;
  var x;
  eta0 = lib_default132(2 * z) / -lib_default2(r / 2);
  s = lib_default55(theta);
  c3 = lib_default96(theta);
  terms2[0] = eta0;
  s2 = s * s;
  c2 = c3 * c3;
  sc = s * c3;
  sc2 = sc * sc;
  sc3 = sc2 * sc;
  sc4 = sc2 * sc2;
  sc5 = sc2 * sc3;
  sc6 = sc3 * sc3;
  sc7 = sc4 * sc3;
  workspace3[0] = (2 * s2 - 1) / (3 * sc);
  workspace3[1] = -polyval_co1_default(s2) / (36 * sc2);
  workspace3[2] = polyval_co2_default(s2) / (1620 * sc3);
  workspace3[3] = polyval_co3_default(s2) / (6480 * sc4);
  workspace3[4] = polyval_co4_default(s2) / (90720 * sc5);
  workspace3[5] = 0;
  terms2[1] = lib_default105(workspace3, eta0);
  workspace3[0] = -polyval_co5_default(s2) / (405 * sc3);
  workspace3[1] = polyval_co6_default(s2) / (2592 * sc4);
  workspace3[2] = -polyval_co7_default(s2) / (204120 * sc5);
  workspace3[3] = -polyval_co8_default(s2) / (2099520 * sc6);
  workspace3[4] = 0;
  workspace3[5] = 0;
  terms2[2] = lib_default105(workspace3, eta0);
  workspace3[0] = polyval_co9_default(s2) / (102060 * sc5);
  workspace3[1] = -polyval_co10_default(s2) / (20995200 * sc6);
  workspace3[2] = polyval_co11_default(s2) / (36741600 * sc7);
  workspace3[3] = 0;
  workspace3[4] = 0;
  workspace3[5] = 0;
  terms2[3] = lib_default105(workspace3, eta0);
  eta = lib_default105(terms2, 1 / r);
  alpha = c3 / s;
  alpha *= alpha;
  lu = -(eta * eta) / (2 * s2) + lib_default12(s2) + c2 * lib_default12(c2) / s2;
  if (lib_default29(eta) < 0.7) {
    workspace3[0] = s2;
    workspace3[1] = sc;
    workspace3[2] = (1 - 2 * s2) / 3;
    workspace3[3] = polyval_co12_default(s2) / (36 * sc);
    workspace3[4] = polyval_co13_default(s2) / (270 * sc2);
    workspace3[5] = 0;
    x = lib_default105(workspace3, eta);
  } else {
    u = lib_default68(lu);
    workspace3[0] = u;
    workspace3[1] = alpha;
    workspace3[2] = 0;
    workspace3[3] = 3 * alpha * (3 * alpha + 1) / 6;
    workspace3[4] = 4 * alpha * (4 * alpha + 1) * (4 * alpha + 2) / 24;
    workspace3[5] = 5 * alpha * (5 * alpha + 1) * (5 * alpha + 2) * (5 * alpha + 3) / 120;
    x = lib_default105(workspace3, u);
    if ((x - s2) * eta < 0) {
      x = 1 - x;
    }
  }
  if (eta < 0) {
    lower = 0;
    upper = s2;
  } else {
    lower = s2;
    upper = 1;
  }
  if (x < lower || x > upper) {
    x = (lower + upper) / 2;
  }
  roots = root_finder_default(-lu, alpha);
  x = newton_raphson_default(roots, x, lower, upper, 32, 100);
  return x;
}
var temme2_default = temme2;

var alias_debug_default = (name) => (a, b, c2, d2, e) => {
};

var FLOAT32_MAX = 34028234663852886e22;
var lib_default136 = FLOAT32_MAX;

var debug = alias_debug_default("gammaincinv:higher_newton");
function higherNewton(x0, a, m, p101, q, lgama, invfp, pcase) {
  var dlnr;
  var xini;
  var ck0;
  var ck1;
  var ck2;
  var a2;
  var x2;
  var px;
  var qx;
  var xr;
  var t;
  var n;
  var r;
  var x;
  x = x0;
  t = 1;
  n = 1;
  a2 = a * a;
  xini = x0;
  do {
    x = x0;
    x2 = x * x;
    if (m === 0) {
      dlnr = (1 - a) * lib_default12(x) + x + lgama;
      if (dlnr > lib_default12(lib_default136)) {
        debug("Warning: overflow problems in one or more steps of the computation. The initial approximation to the root is returned.");
        return xini;
      }
      r = lib_default68(dlnr);
    } else {
      r = -invfp * x;
    }
    if (pcase) {
      px = lib_default113(x, a, true, false);
      ck0 = -r * (px - p101);
    } else {
      qx = lib_default113(x, a, true, true);
      ck0 = r * (qx - q);
    }
    r = ck0;
    if (p101 > 1e-120 || n > 1) {
      ck1 = 0.5 * (x - a + 1) / x;
      ck2 = (2 * x2 - 4 * x * a + 4 * x + 2 * a2 - 3 * a + 1) / x2;
      ck2 /= 6;
      x0 = x + r * (1 + r * (ck1 + r * ck2));
    } else {
      x0 = x + r;
    }
    t = lib_default29(x / x0 - 1);
    n += 1;
    x = x0;
    if (x < 0) {
      x = xini;
      n = 100;
    }
  } while (t > 2e-14 && n < 35);
  if (t > 2e-14 || n > 99) {
    debug("Warning: the number of iterations in the Newton method reached the upper limit N=35. The last value obtained for the root is given as output.");
  }
  xr = x || 0;
  return xr;
}
var higher_newton_default = higherNewton;

function evalpoly65(x) {
  if (x === 0) {
    return 0;
  }
  return 0 + x * (1 + x * (1 + x * (1.5 + x * (2.6666666666666665 + x * (5.208333333333333 + x * 10.8)))));
}
var polyval_ak1_default = evalpoly65;

function evalpoly66(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (1 + x * (0.3333333333333333 + x * (0.027777777777777776 + x * (-0.003703703703703704 + x * (2314814814814815e-19 + x * 5878894767783657e-20)))));
}
var polyval_ak2_default = evalpoly66;

var THRESHOLD = 1e-8;
var ONEO12 = 0.08333333333333333;
var ONEO120 = 0.008333333333333333;
var AK = [1, 0, 0, 0, 0, 0];
function lambdaeta(eta) {
  var L2;
  var L3;
  var L4;
  var L5;
  var la;
  var L;
  var q;
  var r;
  var s;
  s = eta * eta * 0.5;
  if (eta === 0) {
    la = 0;
  } else if (eta < -1) {
    r = lib_default68(-1 - s);
    la = polyval_ak1_default(r);
  } else if (eta < 1) {
    r = eta;
    la = polyval_ak2_default(r);
  } else {
    r = 11 + s;
    L = lib_default12(r);
    la = r + L;
    r = 1 / r;
    L2 = L * L;
    L3 = L2 * L;
    L4 = L3 * L;
    L5 = L4 * L;
    AK[1] = (2 - L) * 0.5;
    AK[2] = (-9 * L + 6 + 2 * L2) / 6;
    AK[3] = -(3 * L3 + 36 * L - 22 * L2 - 12) * ONEO12;
    AK[4] = (60 + 350 * L2 - 300 * L - 125 * L3 + 12 * L4) / 60;
    AK[5] = -(-120 - 274 * L4 + 900 * L - 1700 * L2 + 1125 * L3 + 20 * L5) * ONEO120;
    la += L * r * lib_default105(AK, r);
  }
  r = 1;
  if (eta > -3.5 && eta < -0.03 || eta > 0.03 && eta < 40) {
    r = 1;
    q = la;
    do {
      la = q * (s + lib_default12(q)) / (q - 1);
      r = lib_default29(q / la - 1);
      q = la;
    } while (r > THRESHOLD);
  }
  return la;
}
var lambdaeta_default = lambdaeta;

var A = [
  1.9963790515900766,
  -0.0017971032528832887,
  13129285796384672e-21,
  -2340875228178749e-22,
  72291210671127e-22,
  -3280997607821e-22,
  19875070901e-21,
  -1509214183e-21,
  1375340084e-22,
  -145728923e-22,
  17532367e-22,
  -2351465e-22,
  346551e-22,
  -55471e-22,
  9548e-22,
  -1748e-22,
  332e-22,
  -58e-22
];
function chepolsum(n, t) {
  var tt;
  var u0;
  var u1;
  var u2;
  var k;
  u0 = 0;
  u1 = 0;
  tt = t + t;
  k = n;
  do {
    u2 = u1;
    u1 = u0;
    u0 = tt * u1 - u2 + A[k];
    k -= 1;
  } while (k >= 0);
  return (u0 - u2) / 2;
}
var chepolsum_default = chepolsum;

function evalpoly67(x) {
  if (x === 0) {
    return 0.025721014990011306;
  }
  return 0.025721014990011306 + x * (0.08247596616699963 + x * (-0.0025328157302663564 + x * (6099292666946337e-19 + x * (-33543297638406e-17 + x * 250505279903e-15))));
}
var polyval_c_default = evalpoly67;

function evalpoly68(x) {
  if (x === 0) {
    return 0.08333333333333333;
  }
  return 0.08333333333333333 + x * (-0.002777777777777778 + x * (7936507936507937e-19 + x * -5952380952380953e-19));
}
var polyval_d_default = evalpoly68;

var C6 = 0.30865217988013566;
function stirling(x) {
  var z;
  if (x < lib_default111) {
    return lib_default136;
  }
  if (x < 1) {
    return lib_default98(x + 1) - (x + 0.5) * lib_default12(x) + x - lib_default125;
  }
  if (x < 2) {
    return lib_default98(x) - (x - 0.5) * lib_default12(x) + x - lib_default125;
  }
  if (x < 3) {
    return lib_default98(x - 1) - (x - 0.5) * lib_default12(x) + x - lib_default125 + lib_default12(x - 1);
  }
  if (x < 12) {
    z = 18 / (x * x) - 1;
    return chepolsum_default(17, z) / (12 * x);
  }
  z = 1 / (x * x);
  if (x < 1e3) {
    return polyval_c_default(z) / (C6 + z) / x;
  }
  return polyval_d_default(z) / x;
}
var stirling_default = stirling;

function gamstar(x) {
  if (x >= 3) {
    return lib_default68(stirling_default(x));
  }
  if (x > 0) {
    return lib_default90(x) / (lib_default68(-x + (x - 0.5) * lib_default12(x)) * lib_default88);
  }
  return lib_default136;
}
var gamstar_default = gamstar;

function evalrational16(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.3333333333438;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.3333333333438 + x * (-0.2070740359969 + x * (-0.05041806657154 + x * (-0.004923635739372 + x * -4293658292782e-17)));
    s2 = 1 + x * (0.7045554412463 + x * (0.2118190062224 + x * (0.03048648397436 + x * 0.001605037988091)));
  } else {
    x = 1 / x;
    s1 = -4293658292782e-17 + x * (-0.004923635739372 + x * (-0.05041806657154 + x * (-0.2070740359969 + x * -0.3333333333438)));
    s2 = 0.001605037988091 + x * (0.03048648397436 + x * (0.2118190062224 + x * (0.7045554412463 + x * 1)));
  }
  return s1 / s2;
}
var rational_ak0bk0_default = evalrational16;

function eps1(eta) {
  var la;
  if (lib_default29(eta) < 1) {
    return rational_ak0bk0_default(eta);
  }
  la = lambdaeta_default(eta);
  return lib_default12(eta / (la - 1)) / eta;
}
var eps1_default = eps1;

function evalrational17(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.0172847633523;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.0172847633523 + x * (-0.0159372646475 + x * (-0.00464910887221 + x * (-60683488776e-14 + x * -614830384279e-17)));
    s2 = 1 + x * (0.764050615669 + x * (0.297143406325 + x * (0.0579490176079 + x * 0.00574558524851)));
  } else {
    x = 1 / x;
    s1 = -614830384279e-17 + x * (-60683488776e-14 + x * (-0.00464910887221 + x * (-0.0159372646475 + x * -0.0172847633523)));
    s2 = 0.00574558524851 + x * (0.0579490176079 + x * (0.297143406325 + x * (0.764050615669 + x * 1)));
  }
  return s1 / s2;
}
var rational_ak1bk1_default = evalrational17;

function evalrational18(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.0172839517431;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.0172839517431 + x * (-0.0146362417966 + x * (-0.00357406772616 + x * (-391032032692e-15 + x * 249634036069e-17)));
    s2 = 1 + x * (0.690560400696 + x * (0.249962384741 + x * (0.0443843438769 + x * 0.00424073217211)));
  } else {
    x = 1 / x;
    s1 = 249634036069e-17 + x * (-391032032692e-15 + x * (-0.00357406772616 + x * (-0.0146362417966 + x * -0.0172839517431)));
    s2 = 0.00424073217211 + x * (0.0443843438769 + x * (0.249962384741 + x * (0.690560400696 + x * 1)));
  }
  return s1 / s2;
}
var rational_ak2bk2_default = evalrational18;

function evalrational19(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.99994466948;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 0.99994466948 + x * (104.649839762 + x * (857.204033806 + x * (731.901559577 + x * 45.5174411671)));
    s2 = 1 + x * (104.526456943 + x * (823.313447808 + x * (3119.93802124 + x * 3970.03311219)));
  } else {
    x = 1 / x;
    s1 = 45.5174411671 + x * (731.901559577 + x * (857.204033806 + x * (104.649839762 + x * 0.99994466948)));
    s2 = 3970.03311219 + x * (3119.93802124 + x * (823.313447808 + x * (104.526456943 + x * 1)));
  }
  return s1 / s2;
}
var rational_ak3bk3_default = evalrational19;

function eps2(eta) {
  var lnmeta;
  var x;
  if (eta < -5) {
    x = eta * eta;
    lnmeta = lib_default12(-eta);
    return (12 - x - 6 * (lnmeta * lnmeta)) / (12 * x * eta);
  }
  if (eta < -2) {
    return rational_ak1bk1_default(eta);
  }
  if (eta < 2) {
    return rational_ak2bk2_default(eta);
  }
  if (eta < 1e3) {
    x = 1 / eta;
    return rational_ak3bk3_default(eta) / (-12 * eta);
  }
  return -1 / (12 * eta);
}
var eps2_default = eps2;

function evalrational20(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.0495346498136;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 0.0495346498136 + x * (0.0299521337141 + x * (0.00688296911516 + x * (512634846317e-15 + x * -201411722031e-16)));
    s2 = 1 + x * (0.759803615283 + x * (0.261547111595 + x * (0.0464854522477 + x * 0.00403751193496)));
  } else {
    x = 1 / x;
    s1 = -201411722031e-16 + x * (512634846317e-15 + x * (0.00688296911516 + x * (0.0299521337141 + x * 0.0495346498136)));
    s2 = 0.00403751193496 + x * (0.0464854522477 + x * (0.261547111595 + x * (0.759803615283 + x * 1)));
  }
  return s1 / s2;
}
var rational_ak4bk4_default = evalrational20;

function evalrational21(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.00452313583942;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 0.00452313583942 + x * (0.00120744920113 + x * (-789724156582e-16 + x * (-504476066942e-16 + x * -535770949796e-17)));
    s2 = 1 + x * (0.912203410349 + x * (0.405368773071 + x * (0.0901638932349 + x * 0.00948935714996)));
  } else {
    x = 1 / x;
    s1 = -535770949796e-17 + x * (-504476066942e-16 + x * (-789724156582e-16 + x * (0.00120744920113 + x * 0.00452313583942)));
    s2 = 0.00948935714996 + x * (0.0901638932349 + x * (0.405368773071 + x * (0.912203410349 + x * 1)));
  }
  return s1 / s2;
}
var rational_ak5bk5_default = evalrational21;

function evalrational22(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.00439937562904;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 0.00439937562904 + x * (487225670639e-15 + x * (-128470657374e-15 + x * (529110969589e-17 + x * 15716677175e-17)));
    s2 = 1 + x * (0.794435257415 + x * (0.333094721709 + x * (0.0703527806143 + x * 0.00806110846078)));
  } else {
    x = 1 / x;
    s1 = 15716677175e-17 + x * (529110969589e-17 + x * (-128470657374e-15 + x * (487225670639e-15 + x * 0.00439937562904)));
    s2 = 0.00806110846078 + x * (0.0703527806143 + x * (0.333094721709 + x * (0.794435257415 + x * 1)));
  }
  return s1 / s2;
}
var rational_ak6bk6_default = evalrational22;

function evalrational23(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.0011481191232;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.0011481191232 + x * (-0.112850923276 + x * (1.51623048511 + x * (-0.218472031183 + x * 0.0730002451555)));
    s2 = 1 + x * (14.2482206905 + x * (69.7360396285 + x * (218.938950816 + x * 277.067027185)));
  } else {
    x = 1 / x;
    s1 = 0.0730002451555 + x * (-0.218472031183 + x * (1.51623048511 + x * (-0.112850923276 + x * -0.0011481191232)));
    s2 = 277.067027185 + x * (218.938950816 + x * (69.7360396285 + x * (14.2482206905 + x * 1)));
  }
  return s1 / s2;
}
var rational_ak7bk7_default = evalrational23;

function evalrational24(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -145727889667e-15;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -145727889667e-15 + x * (-0.290806748131 + x * (-13.308504545 + x * (199.722374056 + x * -11.4311378756)));
    s2 = 1 + x * (139.612587808 + x * (2189.01116348 + x * (7115.24019009 + x * 45574.6081453)));
  } else {
    x = 1 / x;
    s1 = -11.4311378756 + x * (199.722374056 + x * (-13.308504545 + x * (-0.290806748131 + x * -145727889667e-15)));
    s2 = 45574.6081453 + x * (7115.24019009 + x * (2189.01116348 + x * (139.612587808 + x * 1)));
  }
  return s1 / s2;
}
var rational_ak8bk8_default = evalrational24;

function eps3(eta) {
  var x;
  var y;
  if (eta < -8) {
    x = eta * eta;
    y = lib_default12(-eta) / eta;
    return (-30 + eta * y * (6 * x * y * y - 12 + x)) / (12 * eta * x * x);
  }
  if (eta < -4) {
    return rational_ak4bk4_default(eta) / (eta * eta);
  }
  if (eta < -2) {
    return rational_ak5bk5_default(eta);
  }
  if (eta < 2) {
    return rational_ak6bk6_default(eta);
  }
  if (eta < 10) {
    x = 1 / eta;
    return rational_ak7bk7_default(x) / (eta * eta);
  }
  if (eta < 100) {
    x = 1 / eta;
    return rational_ak8bk8_default(x) / (eta * eta);
  }
  return -lib_default12(eta) / (12 * eta * eta * eta);
}
var eps3_default = eps3;

var debug2 = alias_debug_default("gammaincinv:compute");
var HALF = 0.5;
var ONEO3 = 0.3333333333333333;
var ONEO4 = 0.25;
var ONEO5 = 0.2;
var ONEO6 = 0.16666666666666666;
var ONEO122 = 0.08333333333333333;
var ONEO24 = 0.041666666666666664;
var CK = [0, 0, 0, 0, 0];
function compute2(a, p101, q) {
  var ap1inv;
  var invfp;
  var lgama;
  var pcase;
  var porq;
  var ainv;
  var logr;
  var ap22;
  var ap14;
  var ap13;
  var ap12;
  var vgam;
  var vmin;
  var xini;
  var ap1;
  var ap2;
  var ap3;
  var eta;
  var p610;
  var p510;
  var x0;
  var a2;
  var L2;
  var L3;
  var L4;
  var b2;
  var b3;
  var p310;
  var a4;
  var fp;
  var p410;
  var p210;
  var a3;
  var xr;
  var ck;
  var b;
  var L;
  var i;
  var k;
  var m;
  var r;
  var s;
  var t;
  var y;
  if (p101 < HALF) {
    pcase = true;
    porq = p101;
    s = -1;
  } else {
    pcase = false;
    porq = q;
    s = 1;
  }
  k = 0;
  if (lib_default29(a - 1) < 1e-4) {
    m = 0;
    if (pcase) {
      if (p101 < 1e-3) {
        p210 = p101 * p101;
        p310 = p210 * p101;
        p410 = p310 * p101;
        p510 = p410 * p101;
        p610 = p510 * p101;
        x0 = p101 + p210 * HALF + p310 * ONEO3 + p410 * ONEO4 + p510 * ONEO5 + p610 * ONEO6;
      } else {
        x0 = -lib_default12(1 - p101);
      }
    } else {
      x0 = -lib_default12(q);
    }
    if (a === 1) {
      k = 2;
      xr = x0;
    } else {
      lgama = lib_default98(a);
      k = 1;
    }
  }
  if (q < 1e-30 && a < HALF) {
    m = 0;
    x0 = -lib_default12(q * lib_default90(a)) + (a - 1) * lib_default12(-lib_default12(q * lib_default90(a)));
    k = 1;
    lgama = lib_default98(a);
  }
  if (a > 1 && a < 500 && p101 < 1e-80) {
    m = 0;
    ainv = 1 / a;
    ap1inv = 1 / (a + 1);
    x0 = (lib_default98(a + 1) + lib_default12(p101)) * ainv;
    x0 = lib_default68(x0);
    xini = x0;
    for (i = 0; i < 10; i++) {
      x0 = xini * lib_default68(x0 * ainv) * lib_default47(1 - x0 * ap1inv, ainv);
    }
    k = 1;
    lgama = lib_default98(a);
  }
  logr = 1 / a * (lib_default12(p101) + lib_default98(a + 1));
  if (logr < lib_default12(ONEO5 * (1 + a)) && k === 0) {
    r = lib_default68(logr);
    m = 0;
    a2 = a * a;
    a3 = a2 * a;
    a4 = a3 * a;
    ap1 = a + 1;
    ap12 = ap1 * ap1;
    ap13 = ap1 * ap12;
    ap14 = ap12 * ap12;
    ap2 = a + 2;
    ap22 = ap2 * ap2;
    ap3 = a + 3;
    CK[0] = 1;
    CK[1] = 1 / ap1;
    CK[2] = HALF * (3 * a + 5) / (ap12 * ap2);
    CK[3] = ONEO3 * (31 + 8 * a2 + 33 * a) / (ap13 * ap2 * ap3);
    CK[4] = ONEO24 * (2888 + 1179 * a3 + 125 * a4 + 3971 * a2 + 5661 * a) / (ap14 * ap22 * ap3 * (a + 4));
    x0 = r * lib_default105(CK, r);
    lgama = lib_default98(a);
    k = 1;
  }
  if (a < 10 && k === 0) {
    vgam = lib_default2(a) / (gamstar_default(a) * lib_default88);
    vmin = lib_default85(0.02, vgam);
    if (q < vmin) {
      m = 0;
      b = 1 - a;
      b2 = b * b;
      b3 = b2 * b;
      eta = lib_default2(-2 / a * lib_default12(q / vgam));
      x0 = a * lambdaeta_default(eta);
      L = lib_default12(x0);
      if (x0 > 5) {
        L2 = L * L;
        L3 = L2 * L;
        L4 = L3 * L;
        r = 1 / x0;
        CK[0] = L - 1;
        CK[1] = (3 * b - 2 * b * L + L2 - 2 * L + 2) * HALF;
        CK[2] = (24 * b * L - 11 * b2 - 24 * b - 6 * L2 + 12 * L - 12 - 9 * b * L2 + 6 * b2 * L + 2 * L3) * ONEO6;
        CK[3] = (-12 * b3 * L + 8.04 * b * L2 - 114 * b2 * L + (72 + 36 * L2) + (3 * L4 - 72 * L + 162) * (b - 168 * b * L) - (12 * L3 + 25 * b3) - (22 * b * L3 + 36 * b2 * L2 + 120 * b2)) * ONEO122;
        CK[4] = 0;
        x0 = x0 - L + b * r * lib_default105(CK, r);
      } else {
        r = 1 / x0;
        L2 = L * L;
        ck = L - 1;
        t = L - b * r * ck;
        if (t < x0) {
          x0 -= t;
        }
      }
      lgama = lib_default98(a);
      k = 1;
    }
  }
  if (lib_default29(porq - HALF) < 1e-5 && k === 0) {
    m = 0;
    ainv = 1 / a;
    x0 = a - ONEO3 + (0.019753086419753086 + 0.007211444248481286 * ainv) * ainv;
    lgama = lib_default98(a);
    k = 1;
  }
  if (a < 1 && k === 0) {
    m = 0;
    if (pcase) {
      x0 = lib_default68(1 / a * (lib_default12(porq) + lib_default98(a + 1)));
    } else {
      x0 = lib_default68(1 / a * (lib_default12(1 - porq) + lib_default98(a + 1)));
    }
    lgama = lib_default98(a);
    k = 1;
  }
  if (k === 0) {
    m = 1;
    ainv = 1 / a;
    r = lib_default132(2 * porq);
    eta = s * r / lib_default2(a * HALF);
    if (r < lib_default136) {
      eta += (eps1_default(eta) + (eps2_default(eta) + eps3_default(eta) * ainv) * ainv) * ainv;
      x0 = a * lambdaeta_default(eta);
      y = eta;
      fp = -lib_default2(a / lib_default107) * lib_default68(-HALF * a * y * y) / gamstar_default(a);
      invfp = 1 / fp;
    } else {
      debug2("Warning: Overflow problems in one or more steps of the computation.");
      return NaN;
    }
  }
  if (k < 2) {
    xr = higher_newton_default(x0, a, m, p101, q, lgama, invfp, pcase);
  }
  return xr;
}
var compute_default = compute2;

function gammaincinv(p101, a, upper) {
  if (lib_default(p101) || lib_default(a)) {
    return NaN;
  }
  if (a < lib_default111) {
    return NaN;
  }
  if (p101 > 1 || p101 < 0) {
    return NaN;
  }
  if (upper === true) {
    if (p101 === 0) {
      return lib_default27;
    }
    if (p101 === 1) {
      return 0;
    }
    return compute_default(a, 1 - p101, p101);
  }
  if (p101 === 0) {
    return 0;
  }
  if (p101 === 1) {
    return lib_default27;
  }
  return compute_default(a, p101, 1 - p101);
}
var main_default100 = gammaincinv;

var lib_default137 = main_default100;

var FLOAT64_SMALLEST_SUBNORMAL = 5e-324;
var lib_default138 = FLOAT64_SMALLEST_SUBNORMAL;

function temme3(a, b, p101, q) {
  var cross;
  var roots;
  var lower;
  var upper;
  var eta0;
  var eta;
  var w10;
  var w12;
  var w13;
  var w14;
  var e1;
  var e2;
  var e3;
  var mu;
  var d2;
  var d3;
  var d4;
  var w2;
  var w3;
  var w4;
  var w5;
  var w6;
  var w7;
  var w8;
  var w9;
  var w1;
  var d5;
  var w;
  var u;
  var x;
  if (p101 < q) {
    eta0 = lib_default137(p101, b, true);
  } else {
    eta0 = lib_default137(q, b, false);
  }
  eta0 /= a;
  mu = b / a;
  w = lib_default2(1 + mu);
  w2 = w * w;
  w3 = w2 * w;
  w4 = w2 * w2;
  w5 = w3 * w2;
  w6 = w3 * w3;
  w7 = w4 * w3;
  w8 = w4 * w4;
  w9 = w5 * w4;
  w10 = w5 * w5;
  d5 = eta0 - mu;
  d2 = d5 * d5;
  d3 = d2 * d5;
  d4 = d2 * d2;
  w1 = w + 1;
  w12 = w1 * w1;
  w13 = w1 * w12;
  w14 = w12 * w12;
  e1 = (w + 2) * (w - 1) / (3 * w);
  e1 += (w3 + 9 * w2 + 21 * w + 5) * d5 / (36 * w2 * w1);
  e1 -= (w4 - 13 * w3 + 69 * w2 + 167 * w + 46) * d2 / (1620 * w12 * w3);
  e1 -= (7 * w5 + 21 * w4 + 70 * w3 + 26 * w2 - 93 * w - 31) * d3 / (6480 * w13 * w4);
  e1 -= (75 * w6 + 202 * w5 + 188 * w4 - 888 * w3 - 1345 * w2 + 118 * w + 138) * d4 / (272160 * w14 * w5);
  e2 = (28 * w4 + 131 * w3 + 402 * w2 + 581 * w + 208) * (w - 1) / (1620 * w1 * w3);
  e2 -= (35 * w6 - 154 * w5 - 623 * w4 - 1636 * w3 - 3983 * w2 - 3514 * w - 925) * d5 / (12960 * w12 * w4);
  e2 -= (2132 * w7 + 7915 * w6 + 16821 * w5 + 35066 * w4 + 87490 * w3 + 141183 * w2 + 95993 * w + 21640) * d2 / (816480 * w5 * w13);
  e2 -= (11053 * w8 + 53308 * w7 + 117010 * w6 + 163924 * w5 + 116188 * w4 - 258428 * w3 - 677042 * w2 - 481940 * w - 105497) * d3 / (14696640 * w14 * w6);
  e3 = -((3592 * w7 + 8375 * w6 - 1323 * w5 - 29198 * w4 - 89578 * w3 - 154413 * w2 - 116063 * w - 29632) * (w - 1)) / (816480 * w5 * w12);
  e3 -= (442043 * w9 + 2054169 * w8 + 3803094 * w7 + 3470754 * w6 + 2141568 * w5 - 2393568 * w4 - 19904934 * w3 - 34714674 * w2 - 23128299 * w - 5253353) * d5 / (146966400 * w6 * w13);
  e3 -= (116932 * w10 + 819281 * w9 + 2378172 * w8 + 4341330 * w7 + 6806004 * w6 + 10622748 * w5 + 18739500 * w4 + 30651894 * w3 + 30869976 * w2 + 15431867 * w + 2919016) * d2 / (146966400 * w14 * w7);
  eta = eta0 + e1 / a + e2 / (a * a) + e3 / (a * a * a);
  if (eta <= 0) {
    eta = lib_default138;
  }
  u = eta - mu * lib_default12(eta) + (1 + mu) * lib_default12(1 + mu) - mu;
  cross = 1 / (1 + mu);
  lower = eta < mu ? cross : 0;
  upper = eta < mu ? 1 : cross;
  x = (lower + upper) / 2;
  roots = root_finder_default(u, mu);
  return newton_raphson_default(roots, x, lower, upper, 32, 100);
}
var temme3_default = temme3;

function halleyIterate(fun, guess, minimum, maximum, digits, maxIter) {
  var convergence;
  var outOfBounds;
  var delta1;
  var delta2;
  var factor;
  var result;
  var f0Last;
  var count;
  var delta;
  var denom;
  var diff;
  var num;
  var res;
  var f0;
  var f1;
  var f2;
  f0 = 0;
  outOfBounds = false;
  result = guess;
  factor = lib_default45(1, 1 - digits);
  delta = lib_default83(1e7 * guess, 1e7);
  f0Last = 0;
  delta1 = delta;
  delta2 = delta;
  count = maxIter;
  do {
    f0Last = f0;
    delta2 = delta1;
    delta1 = delta;
    res = fun(result);
    f0 = res[0];
    f1 = res[1];
    f2 = res[2];
    count -= 1;
    if (f0 === 0) {
      break;
    }
    if (f1 === 0) {
      if (f0Last === 0) {
        if (result === minimum) {
          guess = maximum;
        } else {
          guess = minimum;
        }
        f0Last = fun(guess);
        delta = guess - result;
      }
      if (lib_default135(f0Last) * lib_default135(f0) < 0) {
        if (delta < 0) {
          delta = (result - minimum) / 2;
        } else {
          delta = (result - maximum) / 2;
        }
      } else if (delta < 0) {
        delta = (result - maximum) / 2;
      } else {
        delta = (result - minimum) / 2;
      }
    } else if (f2 === 0) {
      delta = f0 / f1;
    } else {
      denom = 2 * f0;
      num = 2 * f1 - f0 * (f2 / f1);
      if (lib_default29(num) < 1 && lib_default29(denom) >= lib_default29(num) * lib_default86) {
        delta = f0 / f1;
      } else {
        delta = denom / num;
      }
      if (delta * f1 / f0 < 0) {
        delta = f0 / f1;
        if (lib_default29(delta) > 2 * lib_default29(guess)) {
          delta = (delta < 0 ? -1 : 1) * 2 * lib_default29(guess);
        }
      }
    }
    convergence = lib_default29(delta / delta2);
    if (convergence > 0.8 && convergence < 2) {
      delta = delta > 0 ? (result - minimum) / 2 : (result - maximum) / 2;
      if (lib_default29(delta) > result) {
        delta = lib_default135(delta) * result;
      }
      delta2 = delta * 3;
    }
    guess = result;
    result -= delta;
    if (result < minimum) {
      if (lib_default29(minimum) < 1 && lib_default29(result) > 1 && lib_default86 / lib_default29(result) < lib_default29(minimum)) {
        diff = 1e3;
      } else {
        diff = result / minimum;
      }
      if (lib_default29(diff) < 1) {
        diff = 1 / diff;
      }
      if (!outOfBounds && diff > 0 && diff < 3) {
        delta = 0.99 * (guess - minimum);
        result = guess - delta;
        outOfBounds = true;
      } else {
        delta = (guess - minimum) / 2;
        result = guess - delta;
        if (result === minimum || result === maximum) {
          break;
        }
      }
    } else if (result > maximum) {
      if (lib_default29(maximum) < 1 && lib_default29(result) > 1 && lib_default86 / lib_default29(result) < lib_default29(maximum)) {
        diff = 1e3;
      } else {
        diff = result / maximum;
      }
      if (lib_default29(diff) < 1) {
        diff = 1 / diff;
      }
      if (!outOfBounds && diff > 0 && diff < 3) {
        delta = 0.99 * (guess - maximum);
        result = guess - delta;
        outOfBounds = true;
      } else {
        delta = (guess - maximum) / 2;
        result = guess - delta;
        if (result === minimum || result === maximum) {
          break;
        }
      }
    }
    if (delta > 0) {
      maximum = guess;
    } else {
      minimum = guess;
    }
  } while (count && lib_default29(result * factor) < lib_default29(delta));
  return result;
}
var halley_iterate_default = halleyIterate;

var kernelBetainc3 = lib_default119.assign;
function ibetaRoots(a, b, target, invert) {
  return roots;
  function roots(x) {
    var buf;
    var f1;
    var f2;
    var f3;
    var y;
    y = 1 - x;
    buf = [0, 0];
    kernelBetainc3(x, a, b, true, invert, buf, 1, 0);
    f3 = buf[0] - target;
    f1 = buf[1];
    if (invert) {
      f1 = -f1;
    }
    if (y === 0) {
      y = lib_default43 * 64;
    }
    if (x === 0) {
      x = lib_default43 * 64;
    }
    f2 = f1 * (-(y * a) + (b - 2) * x + 1);
    if (lib_default29(f2) < y * x * lib_default86) {
      f2 /= y * x;
    }
    if (invert) {
      f2 = -f2;
    }
    if (f1 === 0) {
      f1 = (invert ? -1 : 1) * lib_default43 * 64;
    }
    return [f3, f1, f2];
  }
}
var ibeta_roots_default = ibetaRoots;

var DIGITS = 32;
var MAX_ITERATIONS = 1e3;
var terms3 = [0, 0, 0, 0, 0];
function ibetaInvImp(a, b, p101, q) {
  var digits;
  var invert;
  var lambda;
  var lower;
  var theta;
  var upper;
  var roots;
  var maxv;
  var minv;
  var bet;
  var ppa;
  var tmp;
  var xs2;
  var ap1;
  var bm1;
  var fs;
  var lx;
  var ps;
  var xg;
  var xs;
  var yp;
  var a2;
  var a3;
  var b2;
  var r;
  var l;
  var u;
  var x;
  var y;
  invert = false;
  if (q === 0) {
    return [1, 0];
  }
  if (p101 === 0) {
    return [0, 1];
  }
  if (a === 1) {
    if (b === 1) {
      return [p101, 1 - p101];
    }
    tmp = b;
    b = a;
    a = tmp;
    tmp = q;
    q = p101;
    p101 = tmp;
    invert = true;
  }
  x = 0;
  lower = 0;
  upper = 1;
  if (a === 0.5) {
    if (b === 0.5) {
      x = lib_default55(p101 * lib_default56);
      x *= x;
      y = lib_default55(q * lib_default56);
      y *= y;
      return [x, y];
    }
    if (b > 0.5) {
      tmp = b;
      b = a;
      a = tmp;
      tmp = q;
      q = p101;
      p101 = tmp;
      invert = !invert;
    }
  }
  if (b === 0.5 && a >= 0.5 && p101 !== 1) {
    yp = {};
    x = find_ibeta_inv_from_t_dist_default(a, p101, yp);
    y = yp.value;
  } else if (b === 1) {
    if (p101 < q) {
      if (a > 1) {
        x = lib_default47(p101, 1 / a);
        y = -lib_default77(lib_default12(p101) / a);
      } else {
        x = lib_default47(p101, 1 / a);
        y = 1 - x;
      }
    } else {
      x = lib_default68(lib_default78(-q) / a);
      y = -lib_default77(lib_default78(-q) / a);
    }
    if (invert) {
      tmp = y;
      y = x;
      x = tmp;
    }
    return [x, y];
  } else if (a + b > 5) {
    if (p101 > 0.5) {
      tmp = b;
      b = a;
      a = tmp;
      tmp = q;
      q = p101;
      p101 = tmp;
      invert = !invert;
    }
    minv = lib_default85(a, b);
    maxv = lib_default83(a, b);
    if (lib_default2(minv) > maxv - minv && minv > 5) {
      x = temme1_default(a, b, p101);
      y = 1 - x;
    } else {
      r = a + b;
      theta = lib_default4(lib_default2(a / r));
      lambda = minv / r;
      if (lambda >= 0.2 && lambda <= 0.8 && r >= 10) {
        ppa = lib_default47(p101, 1 / a);
        if (ppa < 25e-4 && a + b < 200) {
          x = ppa * lib_default47(a * lib_default81(a, b), 1 / a);
        } else {
          x = temme2_default(p101, r, theta);
        }
        y = 1 - x;
      } else {
        if (a < b) {
          tmp = b;
          b = a;
          a = tmp;
          tmp = q;
          q = p101;
          p101 = tmp;
          invert = !invert;
        }
        bet = 0;
        if (b < 2) {
          bet = lib_default81(a, b);
        }
        if (bet === 0) {
          y = 1;
        } else {
          y = lib_default47(b * q * bet, 1 / b);
          x = 1 - y;
        }
      }
      if (y > 1e-5) {
        x = temme3_default(a, b, p101, q);
        y = 1 - x;
      }
    }
  } else if (a < 1 && b < 1) {
    xs = (1 - a) / (2 - a - b);
    fs = lib_default120(xs, a, b) - p101;
    if (lib_default29(fs) / p101 < lib_default80 * 3) {
      if (invert) {
        return [1 - xs, xs];
      }
      return [xs, 1 - xs];
    }
    if (fs < 0) {
      tmp = b;
      b = a;
      a = tmp;
      tmp = q;
      q = p101;
      p101 = tmp;
      invert = !invert;
      xs = 1 - xs;
    }
    xg = lib_default47(a * p101 * lib_default81(a, b), 1 / a);
    x = xg / (1 + xg);
    y = 1 / (1 + xg);
    if (x > xs) {
      x = xs;
    }
    upper = xs;
  } else if (a > 1 && b > 1) {
    xs = (a - 1) / (a + b - 2);
    xs2 = (b - 1) / (a + b - 2);
    ps = lib_default120(xs, a, b) - p101;
    if (ps < 0) {
      tmp = b;
      b = a;
      a = tmp;
      tmp = q;
      q = p101;
      p101 = tmp;
      tmp = xs2;
      xs2 = xs;
      xs = tmp;
      invert = !invert;
    }
    lx = lib_default12(p101 * a * lib_default81(a, b)) / a;
    x = lib_default68(lx);
    y = x < 0.9 ? 1 - x : -lib_default77(lx);
    if (b < a && x < 0.2) {
      ap1 = a - 1;
      bm1 = b - 1;
      a2 = a * a;
      a3 = a * a2;
      b2 = b * b;
      terms3[0] = 0;
      terms3[1] = 1;
      terms3[2] = bm1 / ap1;
      ap1 *= ap1;
      terms3[3] = bm1 * (3 * a * b + 5 * b + a2 - a - 4) / (2 * (a + 2) * ap1);
      ap1 *= a + 1;
      terms3[4] = bm1 * (33 * a * b2 + 31 * b2 + 8 * a2 * b2 - 30 * a * b - 47 * b + 11 * a2 * b + 6 * a3 * b + 18 + 4 * a - a3 + a2 * a2 - 10 * a2);
      terms3[4] /= 3 * (a + 3) * (a + 2) * ap1;
      x = lib_default105(terms3, x);
    }
    if (x > xs) {
      x = xs;
    }
    upper = xs;
  } else {
    if (b < a) {
      tmp = b;
      b = a;
      a = tmp;
      tmp = q;
      q = p101;
      p101 = tmp;
      invert = !invert;
    }
    if (lib_default47(p101, 1 / a) < 0.5) {
      x = lib_default47(p101 * a * lib_default81(a, b), 1 / a);
      if (x === 0) {
        x = lib_default43;
      }
      y = 1 - x;
    } else {
      y = lib_default47(1 - lib_default47(p101, b * lib_default81(a, b)), 1 / b);
      if (y === 0) {
        y = lib_default43;
      }
      x = 1 - y;
    }
  }
  if (x > 0.5) {
    tmp = b;
    b = a;
    a = tmp;
    tmp = q;
    q = p101;
    p101 = tmp;
    tmp = y;
    y = x;
    x = tmp;
    invert = !invert;
    l = 1 - upper;
    u = 1 - lower;
    lower = l;
    upper = u;
  }
  if (lower === 0) {
    if (invert) {
      lower = lib_default80;
      if (x < lower) {
        x = lower;
      }
    } else {
      lower = lib_default43;
    }
    if (x < lower) {
      x = lower;
    }
  }
  digits = DIGITS;
  if (x < 1e-50 && (a < 1 || b < 1)) {
    digits *= 3;
    digits /= 2;
  }
  roots = ibeta_roots_default(a, b, p101 < q ? p101 : q, p101 >= q);
  x = halley_iterate_default(roots, x, lower, upper, digits, MAX_ITERATIONS);
  if (x === lower) {
    x = 0;
  }
  if (invert) {
    return [1 - x, x];
  }
  return [x, 1 - x];
}
var main_default101 = ibetaInvImp;

var lib_default139 = main_default101;

function betaincinv(p101, a, b, upper) {
  if (lib_default(p101) || lib_default(a) || lib_default(b)) {
    return NaN;
  }
  if (a <= 0 || b <= 0) {
    return NaN;
  }
  if (p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (upper) {
    return lib_default139(a, b, 1 - p101, p101)[0];
  }
  return lib_default139(a, b, p101, 1 - p101)[0];
}
var main_default102 = betaincinv;

var lib_default140 = main_default102;

function median3(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return lib_default140(0.5, alpha, beta2);
}
var main_default103 = median3;

var lib_default141 = main_default103;

function mgf2(t, alpha, beta2) {
  var summand;
  var denom;
  var sum2;
  var c2;
  var k;
  denom = lib_default81(alpha, beta2);
  sum2 = 1;
  c2 = 1;
  k = 1;
  do {
    c2 *= t / k;
    summand = lib_default81(alpha + k, beta2) / denom * c2;
    sum2 += summand;
    k += 1;
  } while (lib_default29(summand / sum2) >= lib_default80);
  return sum2;
}
var mgf_default = mgf2;

function mgf3(t, alpha, beta2) {
  if (lib_default(t) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return mgf_default(t, alpha, beta2);
}
var main_default104 = mgf3;

function factory14(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (lib_default(t)) {
      return NaN;
    }
    return mgf_default(t, alpha, beta2);
  }
}
var factory_default14 = factory14;

main_default104.factory = factory_default14;
var lib_default142 = main_default104;

function mode3(alpha, beta2) {
  if (alpha <= 1 || beta2 <= 1) {
    return NaN;
  }
  return (alpha - 1) / (alpha + beta2 - 2);
}
var main_default105 = mode3;

var lib_default143 = main_default105;

function pdf2(x, alpha, beta2) {
  var out;
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x < 0 || x > 1) {
    return 0;
  }
  if (x === 0) {
    if (alpha < 1) {
      return lib_default27;
    }
    if (alpha > 1) {
      return 0;
    }
    return beta2;
  }
  if (x === 1) {
    if (beta2 < 1) {
      return lib_default27;
    }
    if (beta2 > 1) {
      return 0;
    }
    return alpha;
  }
  out = (alpha - 1) * lib_default12(x);
  out += (beta2 - 1) * lib_default78(-x);
  out -= lib_default126(alpha, beta2);
  return lib_default68(out);
}
var main_default106 = pdf2;

function factory15(alpha, beta2) {
  var betalnAB;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  betalnAB = lib_default126(alpha, beta2);
  return pdf30;
  function pdf30(x) {
    var out;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0 || x > 1) {
      return 0;
    }
    if (x === 0) {
      if (alpha < 1) {
        return lib_default27;
      }
      if (alpha > 1) {
        return 0;
      }
      return beta2;
    }
    if (x === 1) {
      if (beta2 < 1) {
        return lib_default27;
      }
      if (beta2 > 1) {
        return 0;
      }
      return alpha;
    }
    out = -betalnAB;
    out += (alpha - 1) * lib_default12(x);
    out += (beta2 - 1) * lib_default78(-x);
    return lib_default68(out);
  }
}
var factory_default15 = factory15;

main_default106.factory = factory_default15;
var lib_default144 = main_default106;

function quantile3(p101, alpha, beta2) {
  if (lib_default(p101) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return lib_default140(p101, alpha, beta2);
}
var main_default107 = quantile3;

function factory16(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return lib_default140(p101, alpha, beta2);
  }
}
var factory_default16 = factory16;

main_default107.factory = factory_default16;
var lib_default145 = main_default107;

function skewness3(alpha, beta2) {
  var out;
  var ab;
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  ab = alpha + beta2;
  out = 2 * (beta2 - alpha) * lib_default2(ab + 1);
  out /= (ab + 2) * lib_default2(alpha * beta2);
  return out;
}
var main_default108 = skewness3;

var lib_default146 = main_default108;

function stdev3(alpha, beta2) {
  var apb;
  var out;
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  apb = alpha + beta2;
  out = lib_default2(alpha * beta2 / (apb + 1));
  out /= apb;
  return out;
}
var main_default109 = stdev3;

var lib_default147 = main_default109;

function variance3(alpha, beta2) {
  var apb;
  var out;
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  apb = alpha + beta2;
  out = alpha * beta2;
  out /= apb * apb * (apb + 1);
  return out;
}
var main_default110 = variance3;

var lib_default148 = main_default110;

function cdf4(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return 0;
  }
  if (x === lib_default27) {
    return 1;
  }
  return lib_default121(x / (1 + x), alpha, beta2);
}
var main_default111 = cdf4;

var betaFactory = lib_default121.factory;
function factory17(alpha, beta2) {
  var betaCDF;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  betaCDF = betaFactory(alpha, beta2);
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return 0;
    }
    if (x === lib_default27) {
      return 1;
    }
    return betaCDF(x / (1 + x));
  }
}
var factory_default17 = factory17;

main_default111.factory = factory_default17;
var lib_default149 = main_default111;

function logcdf3(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return lib_default11;
  }
  if (x === lib_default27) {
    return 0;
  }
  return lib_default129(x / (1 + x), alpha, beta2);
}
var main_default112 = logcdf3;

var betaFactory2 = lib_default129.factory;
function factory18(alpha, beta2) {
  var betaLogCDF;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  betaLogCDF = betaFactory2(alpha, beta2);
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return lib_default11;
    }
    if (x === lib_default27) {
      return 0;
    }
    return betaLogCDF(x / (1 + x));
  }
}
var factory_default18 = factory18;

main_default112.factory = factory_default18;
var lib_default150 = main_default112;

function logpdf3(x, alpha, beta2) {
  var out;
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return lib_default11;
  }
  out = (alpha - 1) * lib_default12(x);
  out -= (alpha + beta2) * lib_default78(x);
  out -= lib_default126(alpha, beta2);
  return out;
}
var main_default113 = logpdf3;

function factory19(alpha, beta2) {
  var betalnAB;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  betalnAB = lib_default126(alpha, beta2);
  return logpdf27;
  function logpdf27(x) {
    var out;
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return lib_default11;
    }
    out = (alpha - 1) * lib_default12(x);
    out -= (alpha + beta2) * lib_default78(x);
    out -= betalnAB;
    return out;
  }
}
var factory_default19 = factory19;

main_default113.factory = factory_default19;
var lib_default151 = main_default113;

function mean4(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 1) {
    return NaN;
  }
  return alpha / (beta2 - 1);
}
var main_default114 = mean4;

var lib_default152 = main_default114;

function mode4(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (alpha < 1) {
    return 0;
  }
  return (alpha - 1) / (beta2 + 1);
}
var main_default115 = mode4;

var lib_default153 = main_default115;

function pdf3(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return lib_default68(lib_default151(x, alpha, beta2));
}
var main_default116 = pdf3;

var logpdfFactory = lib_default151.factory;
function factory20(alpha, beta2) {
  var logpdf27;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  logpdf27 = logpdfFactory(alpha, beta2);
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return lib_default68(logpdf27(x));
  }
}
var factory_default20 = factory20;

main_default116.factory = factory_default20;
var lib_default154 = main_default116;

function quantile4(p101, alpha, beta2) {
  var x;
  if (lib_default(p101) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  x = lib_default140(p101, alpha, beta2);
  return x / (1 - x);
}
var main_default117 = quantile4;

function factory21(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    var x;
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    x = lib_default140(p101, alpha, beta2);
    return x / (1 - x);
  }
}
var factory_default21 = factory21;

main_default117.factory = factory_default21;
var lib_default155 = main_default117;

function variance4(alpha, beta2) {
  var bm1;
  if (lib_default(alpha) || alpha <= 0 || lib_default(beta2) || beta2 <= 2) {
    return NaN;
  }
  bm1 = beta2 - 1;
  return alpha * (alpha + bm1) / ((bm1 - 1) * bm1 * bm1);
}
var main_default118 = variance4;

var lib_default156 = main_default118;

function stdev4(alpha, beta2) {
  return lib_default2(lib_default156(alpha, beta2));
}
var main_default119 = stdev4;

var lib_default157 = main_default119;

function cdf5(x, c2) {
  if (lib_default(c2) || lib_default(x) || c2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return lib_default78(c2 * x) / lib_default78(c2);
}
var main_default120 = cdf5;

function factory22(c2) {
  if (lib_default(c2) || c2 <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return 0;
    }
    if (x >= 1) {
      return 1;
    }
    return lib_default78(c2 * x) / lib_default78(c2);
  }
}
var factory_default22 = factory22;

main_default120.factory = factory_default22;
var lib_default158 = main_default120;

function entropy4(c2) {
  var k;
  if (lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  k = lib_default12(1 + c2);
  return k / 2 - lib_default12(c2 / k);
}
var main_default121 = entropy4;

var lib_default159 = main_default121;

function mean5(c2) {
  var k;
  if (lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  k = lib_default12(1 + c2);
  return (c2 - k) / (c2 * k);
}
var main_default122 = mean5;

var lib_default160 = main_default122;

function median4(c2) {
  if (lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  return (lib_default2(1 + c2) - 1) / c2;
}
var main_default123 = median4;

var lib_default161 = main_default123;

function mode5(c2) {
  if (lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  return 0;
}
var main_default124 = mode5;

var lib_default162 = main_default124;

function pdf4(x, c2) {
  var k;
  if (lib_default(c2) || lib_default(x) || c2 <= 0) {
    return NaN;
  }
  if (x < 0 || x > 1) {
    return 0;
  }
  k = lib_default78(c2);
  return c2 / ((1 + c2 * x) * k);
}
var main_default125 = pdf4;

function factory23(c2) {
  var k;
  if (lib_default(c2) || c2 <= 0) {
    return lib_default6(NaN);
  }
  k = lib_default78(c2);
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0 || x > 1) {
      return 0;
    }
    return c2 / ((1 + c2 * x) * k);
  }
}
var factory_default23 = factory23;

main_default125.factory = factory_default23;
var lib_default163 = main_default125;

function quantile5(p101, c2) {
  if (lib_default(c2) || lib_default(p101) || c2 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return lib_default77(p101 * lib_default78(c2)) / c2;
}
var main_default126 = quantile5;

function factory24(c2) {
  if (lib_default(c2) || c2 <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return lib_default77(p101 * lib_default78(c2)) / c2;
  }
}
var factory_default24 = factory24;

main_default126.factory = factory_default24;
var lib_default164 = main_default126;

function skewness4(c2) {
  var ans;
  var t1;
  var t2;
  var t3;
  var p101;
  if (lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  p101 = lib_default12(1 + c2);
  t1 = 12 * (c2 * c2);
  t2 = 9 * c2 * p101 * (c2 + 2);
  t3 = 2 * (p101 * p101) * (c2 * (c2 + 3) + 3);
  ans = lib_default134 * (t1 - t2 + t3);
  t1 = c2 * (c2 * (p101 - 2) + 2 * p101);
  t2 = 3 * c2 * (p101 - 2) + 6 * p101;
  ans /= lib_default2(t1) * t2;
  return ans;
}
var main_default127 = skewness4;

var lib_default165 = main_default127;

function variance5(c2) {
  var k;
  if (lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  k = lib_default12(1 + c2);
  return ((2 + c2) * k - 2 * c2) / (2 * c2 * k * k);
}
var main_default128 = variance5;

var lib_default166 = main_default128;

function stdev5(c2) {
  return lib_default2(lib_default166(c2));
}
var main_default129 = stdev5;

var lib_default167 = main_default129;

function signbit(x) {
  var high = lib_default8(x);
  return high >>> 31 ? true : false;
}
var main_default130 = signbit;

var lib_default168 = main_default130;

function evalpoly69(x) {
  if (x === 0) {
    return -64.85021904942025;
  }
  return -64.85021904942025 + x * (-122.88666844901361 + x * (-75.00855792314705 + x * (-16.157537187333652 + x * -0.8750608600031904)));
}
var polyval_p_default5 = evalpoly69;

function evalpoly70(x) {
  if (x === 0) {
    return 194.5506571482614;
  }
  return 194.5506571482614 + x * (485.3903996359137 + x * (432.88106049129027 + x * (165.02700983169885 + x * (24.858464901423062 + x * 1))));
}
var polyval_q_default3 = evalpoly70;

var MOREBITS3 = 6123233995736766e-32;
var T3P8 = 2.414213562373095;
function atan(x) {
  var flg;
  var sgn;
  var y;
  var z;
  if (lib_default(x) || x === 0) {
    return x;
  }
  if (x === lib_default27) {
    return lib_default56;
  }
  if (x === lib_default11) {
    return -lib_default56;
  }
  if (x < 0) {
    sgn = true;
    x = -x;
  }
  flg = 0;
  if (x > T3P8) {
    y = lib_default56;
    flg = 1;
    x = -(1 / x);
  } else if (x <= 0.66) {
    y = 0;
  } else {
    y = lib_default3;
    flg = 2;
    x = (x - 1) / (x + 1);
  }
  z = x * x;
  z = z * polyval_p_default5(z) / polyval_q_default3(z);
  z = x * z + x;
  if (flg === 2) {
    z += 0.5 * MOREBITS3;
  } else if (flg === 1) {
    z += MOREBITS3;
  }
  y += z;
  return sgn ? -y : y;
}
var main_default131 = atan;

var lib_default169 = main_default131;

function atan2(y, x) {
  var q;
  if (lib_default(x) || lib_default(y)) {
    return NaN;
  }
  if (lib_default28(x)) {
    if (x === lib_default27) {
      if (lib_default28(y)) {
        return lib_default36(lib_default5 / 4, y);
      }
      return lib_default36(0, y);
    }
    if (lib_default28(y)) {
      return lib_default36(3 * lib_default5 / 4, y);
    }
    return lib_default36(lib_default5, y);
  }
  if (lib_default28(y)) {
    return lib_default36(lib_default5 / 2, y);
  }
  if (y === 0) {
    if (x >= 0 && !lib_default168(x)) {
      return lib_default36(0, y);
    }
    return lib_default36(lib_default5, y);
  }
  if (x === 0) {
    return lib_default36(lib_default5 / 2, y);
  }
  q = lib_default169(y / x);
  if (x < 0) {
    if (q <= 0) {
      return q + lib_default5;
    }
    return q - lib_default5;
  }
  return q;
}
var main_default132 = atan2;

var lib_default170 = main_default132;

var ONE_OVER_PI2 = 0.3183098861837907;
function cdf6(x, x0, gamma4) {
  if (lib_default(x) || lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return NaN;
  }
  return ONE_OVER_PI2 * lib_default170(x - x0, gamma4) + 0.5;
}
var main_default133 = cdf6;

var ONE_OVER_PI3 = 0.3183098861837907;
function factory25(x0, gamma4) {
  if (lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return ONE_OVER_PI3 * lib_default170(x - x0, gamma4) + 0.5;
  }
}
var factory_default25 = factory25;

main_default133.factory = factory_default25;
var lib_default171 = main_default133;

var LN_FOUR_PI = 2.5310242469692907;
function entropy5(x0, gamma4) {
  if (lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return NaN;
  }
  return lib_default12(gamma4) + LN_FOUR_PI;
}
var main_default134 = entropy5;

var lib_default172 = main_default134;

var ONE_OVER_PI4 = 0.3183098861837907;
function logcdf4(x, x0, gamma4) {
  if (lib_default(x) || lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return NaN;
  }
  return lib_default12(ONE_OVER_PI4 * lib_default170(x - x0, gamma4) + 0.5);
}
var main_default135 = logcdf4;

var ONE_OVER_PI5 = 0.3183098861837907;
function factory26(x0, gamma4) {
  if (lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return lib_default12(ONE_OVER_PI5 * lib_default170(x - x0, gamma4) + 0.5);
  }
}
var factory_default26 = factory26;

main_default135.factory = factory_default26;
var lib_default173 = main_default135;

function logpdf4(x, x0, gamma4) {
  if (lib_default(x) || lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return NaN;
  }
  return -(lib_default15 + lib_default12(gamma4) + lib_default78(lib_default47((x - x0) / gamma4, 2)));
}
var main_default136 = logpdf4;

function factory27(x0, gamma4) {
  if (lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return lib_default6(NaN);
  }
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return -(lib_default15 + lib_default12(gamma4) + lib_default78(lib_default47((x - x0) / gamma4, 2)));
  }
}
var factory_default27 = factory27;

main_default136.factory = factory_default27;
var lib_default174 = main_default136;

function median5(x0, gamma4) {
  if (lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return NaN;
  }
  return x0;
}
var main_default137 = median5;

var lib_default175 = main_default137;

function mode6(x0, gamma4) {
  if (lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return NaN;
  }
  return x0;
}
var main_default138 = mode6;

var lib_default176 = main_default138;

function pdf5(x, x0, gamma4) {
  var denom;
  if (lib_default(x) || lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return NaN;
  }
  denom = lib_default5 * gamma4 * (1 + lib_default47((x - x0) / gamma4, 2));
  return 1 / denom;
}
var main_default139 = pdf5;

function factory28(x0, gamma4) {
  var gpi;
  if (lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return lib_default6(NaN);
  }
  gpi = gamma4 * lib_default5;
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return 1 / (gpi * (1 + lib_default47((x - x0) / gamma4, 2)));
  }
}
var factory_default28 = factory28;

main_default139.factory = factory_default28;
var lib_default177 = main_default139;

function quantile6(p101, x0, gamma4) {
  if (lib_default(p101) || lib_default(x0) || lib_default(gamma4) || gamma4 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return x0 + gamma4 * lib_default123(lib_default5 * (p101 - 0.5));
}
var main_default140 = quantile6;

function factory29(x0, gamma4) {
  if (lib_default(x0) || lib_default(gamma4) || gamma4 <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return x0 + gamma4 * lib_default123(lib_default5 * (p101 - 0.5));
  }
}
var factory_default29 = factory29;

main_default140.factory = factory_default29;
var lib_default178 = main_default140;

function cdf7(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0) {
    return NaN;
  }
  if (alpha === 0) {
    return x < 0 ? 0 : 1;
  }
  if (x <= 0) {
    return 0;
  }
  if (x === lib_default27) {
    return 1;
  }
  return lib_default113(x * beta2, alpha);
}
var main_default141 = cdf7;

function cdf8(x, mu) {
  if (lib_default(x) || lib_default(mu)) {
    return NaN;
  }
  return x < mu ? 0 : 1;
}
var main_default142 = cdf8;

function factory30(mu) {
  if (lib_default(mu)) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return x < mu ? 0 : 1;
  }
}
var factory_default30 = factory30;

main_default142.factory = factory_default30;
var lib_default179 = main_default142;

var degenerate = lib_default179.factory;
function factory31(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  if (alpha === 0) {
    return degenerate(0);
  }
  return cdf35;
  function cdf35(x) {
    if (x <= 0) {
      return 0;
    }
    if (x === lib_default27) {
      return 1;
    }
    return lib_default113(x * beta2, alpha);
  }
}
var factory_default31 = factory31;

main_default141.factory = factory_default31;
var lib_default180 = main_default141;

function cdf9(x, k) {
  if (lib_default(x) || lib_default(k) || k < 0) {
    return NaN;
  }
  if (k === 0) {
    return x < 0 ? 0 : 1;
  }
  if (x <= 0) {
    return 0;
  }
  return lib_default180(x * x, k / 2, 0.5);
}
var main_default143 = cdf9;

var degenerate2 = lib_default179.factory;
var gammaFactory = lib_default180.factory;
function factory32(k) {
  var gamma4;
  if (k === 0) {
    return degenerate2(0);
  }
  gamma4 = gammaFactory(k / 2, 0.5);
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    return gamma4(x * x);
  }
}
var factory_default32 = factory32;

main_default143.factory = factory_default32;
var lib_default181 = main_default143;

function entropy6(k) {
  var kh;
  if (lib_default(k) || k <= 0) {
    return NaN;
  }
  kh = k / 2;
  return lib_default98(kh) + 0.5 * (k - lib_default16 - (k - 1) * lib_default124(kh));
}
var main_default144 = entropy6;

var lib_default182 = main_default144;

function mean6(k) {
  if (lib_default(k) || k < 0) {
    return NaN;
  }
  return lib_default134 * lib_default90((k + 1) / 2) / lib_default90(k / 2);
}
var main_default145 = mean6;

var lib_default183 = main_default145;

function variance6(k) {
  var mu;
  if (lib_default(k) || k < 0) {
    return NaN;
  }
  mu = lib_default183(k);
  return k - mu * mu;
}
var main_default146 = variance6;

var lib_default184 = main_default146;

function skewness5(k) {
  var sigma3;
  var sigma2;
  var sigma;
  var mu;
  if (lib_default(k) || k <= 0) {
    return NaN;
  }
  mu = lib_default183(k);
  sigma = lib_default2(lib_default184(k));
  sigma2 = sigma * sigma;
  sigma3 = sigma2 * sigma;
  return mu / sigma3 * (1 - 2 * sigma2);
}
var main_default147 = skewness5;

var lib_default185 = main_default147;

function kurtosis4(k) {
  var sigma2;
  var sigma;
  var g1;
  var mu;
  if (lib_default(k) || k <= 0) {
    return NaN;
  }
  sigma2 = lib_default184(k);
  sigma = lib_default2(sigma2);
  mu = lib_default183(k);
  g1 = lib_default185(k);
  return 2 / sigma2 * (1 - mu * sigma * g1 - sigma2);
}
var main_default148 = kurtosis4;

var lib_default186 = main_default148;

function logpdf5(x, k) {
  var out;
  var kh;
  if (lib_default(x) || lib_default(k) || k < 0) {
    return NaN;
  }
  if (k === 0) {
    return x === 0 ? lib_default27 : lib_default11;
  }
  if (x < 0 || x === lib_default27) {
    return lib_default11;
  }
  kh = k / 2;
  out = (1 - kh) * lib_default16 + (k - 1) * lib_default12(x) - x * x / 2;
  out -= lib_default98(kh);
  return out;
}
var main_default149 = logpdf5;

function logpdf6(x, mu) {
  if (lib_default(x) || lib_default(mu)) {
    return NaN;
  }
  return x === mu ? lib_default27 : lib_default11;
}
var main_default150 = logpdf6;

function factory33(mu) {
  if (lib_default(mu)) {
    return lib_default6(NaN);
  }
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return x === mu ? lib_default27 : lib_default11;
  }
}
var factory_default33 = factory33;

main_default150.factory = factory_default33;
var lib_default187 = main_default150;

var degenerate3 = lib_default187.factory;
function factory34(k) {
  var km1;
  var kh;
  if (lib_default(k) || k < 0) {
    return lib_default6(NaN);
  }
  if (k === 0) {
    return degenerate3(0);
  }
  kh = k / 2;
  km1 = k - 1;
  return logpdf27;
  function logpdf27(x) {
    var out;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0 || x === lib_default27) {
      return lib_default11;
    }
    out = (1 - kh) * lib_default16 + km1 * lib_default12(x) - x * x / 2;
    out -= lib_default98(kh);
    return out;
  }
}
var factory_default34 = factory34;

main_default149.factory = factory_default34;
var lib_default188 = main_default149;

function mode7(k) {
  if (lib_default(k) || k < 1) {
    return NaN;
  }
  return lib_default2(k - 1);
}
var main_default151 = mode7;

var lib_default189 = main_default151;

function pdf6(x, k) {
  var out;
  var kh;
  if (lib_default(x) || lib_default(k) || k < 0) {
    return NaN;
  }
  if (k === 0) {
    return x === 0 ? lib_default27 : 0;
  }
  if (x < 0) {
    return 0;
  }
  kh = k / 2;
  out = lib_default47(2, 1 - kh) * lib_default47(x, k - 1) * lib_default68(-(x * x) / 2);
  out /= lib_default90(kh);
  return out;
}
var main_default152 = pdf6;

function pdf7(x, mu) {
  if (lib_default(x) || lib_default(mu)) {
    return NaN;
  }
  return x === mu ? lib_default27 : 0;
}
var main_default153 = pdf7;

function factory35(mu) {
  if (lib_default(mu)) {
    return lib_default6(NaN);
  }
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return x === mu ? lib_default27 : 0;
  }
}
var factory_default35 = factory35;

main_default153.factory = factory_default35;
var lib_default190 = main_default153;

var degenerate4 = lib_default190.factory;
function factory36(k) {
  var km1;
  var kh;
  if (lib_default(k) || k < 0) {
    return lib_default6(NaN);
  }
  if (k === 0) {
    return degenerate4(0);
  }
  kh = k / 2;
  km1 = k - 1;
  return pdf30;
  function pdf30(x) {
    var out;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    out = lib_default47(2, 1 - kh) * lib_default47(x, km1) * lib_default68(-(x * x) / 2);
    out /= lib_default90(kh);
    return out;
  }
}
var factory_default36 = factory36;

main_default152.factory = factory_default36;
var lib_default191 = main_default152;

function quantile7(p101, alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || lib_default(p101) || alpha < 0 || beta2 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (alpha === 0) {
    return 0;
  }
  return 1 / beta2 * lib_default137(p101, alpha);
}
var main_default154 = quantile7;

function quantile8(p101, mu) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return mu;
}
var main_default155 = quantile8;

function factory37(mu) {
  if (lib_default(mu)) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return mu;
  }
}
var factory_default37 = factory37;

main_default155.factory = factory_default37;
var lib_default192 = main_default155;

var degenerate5 = lib_default192.factory;
function factory38(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  if (alpha === 0) {
    return degenerate5(0);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return 1 / beta2 * lib_default137(p101, alpha);
  }
}
var factory_default38 = factory38;

main_default154.factory = factory_default38;
var lib_default193 = main_default154;

function quantile9(p101, k) {
  return lib_default2(lib_default193(p101, k / 2, 0.5));
}
var main_default156 = quantile9;

var gammaFactory2 = lib_default193.factory;
function factory39(k) {
  var gamma4 = gammaFactory2(k / 2, 0.5);
  return quantile35;
  function quantile35(p101) {
    return lib_default2(gamma4(p101));
  }
}
var factory_default39 = factory39;

main_default156.factory = factory_default39;
var lib_default194 = main_default156;

function stdev6(k) {
  return lib_default2(lib_default184(k));
}
var main_default157 = stdev6;

var lib_default195 = main_default157;

function cdf10(x, k) {
  return lib_default180(x, k / 2, 0.5);
}
var main_default158 = cdf10;

var gammaFactory3 = lib_default180.factory;
function factory40(k) {
  return gammaFactory3(k / 2, 0.5);
}
var factory_default40 = factory40;

main_default158.factory = factory_default40;
var lib_default196 = main_default158;

function entropy7(k) {
  var kh;
  if (lib_default(k) || k <= 0) {
    return NaN;
  }
  kh = k / 2;
  return kh + lib_default12(2 * lib_default90(kh)) + (1 - kh) * lib_default124(kh);
}
var main_default159 = entropy7;

var lib_default197 = main_default159;

function kurtosis5(k) {
  if (lib_default(k) || k <= 0) {
    return NaN;
  }
  return 12 / k;
}
var main_default160 = kurtosis5;

var lib_default198 = main_default160;

function regularisedGammaPrefix2(a, z) {
  var prefix;
  var amza;
  var agh;
  var alz;
  var amz;
  var sq;
  var d2;
  agh = a + lib_default94 - 0.5;
  d2 = (z - a - lib_default94 + 0.5) / agh;
  if (a < 1) {
    if (z <= lib_default103) {
      return lib_default68(a * lib_default12(z) - z - lib_default98(a));
    }
    return lib_default47(z, a) * lib_default68(-z) / lib_default90(a);
  }
  if (lib_default29(d2 * d2 * a) <= 100 && a > 150) {
    prefix = a * (lib_default78(d2) - d2) + z * (0.5 - lib_default94) / agh;
    prefix = lib_default68(prefix);
  } else {
    alz = a * lib_default12(z / agh);
    amz = a - z;
    if (lib_default85(alz, amz) <= lib_default103 || lib_default83(alz, amz) >= lib_default99) {
      amza = amz / a;
      if (lib_default85(alz, amz) / 2 > lib_default103 && lib_default83(alz, amz) / 2 < lib_default99) {
        sq = lib_default47(z / agh, a / 2) * lib_default68(amz / 2);
        prefix = sq * sq;
      } else if (lib_default85(alz, amz) / 4 > lib_default103 && lib_default83(alz, amz) / 4 < lib_default99 && z > a) {
        sq = lib_default47(z / agh, a / 4) * lib_default68(amz / 4);
        prefix = sq * sq;
        prefix *= prefix;
      } else if (amza > lib_default103 && amza < lib_default99) {
        prefix = lib_default47(z * lib_default68(amza) / agh, a);
      } else {
        prefix = lib_default68(alz + amz);
      }
    } else {
      prefix = lib_default47(z / agh, a) * lib_default68(amz);
    }
  }
  prefix *= lib_default2(agh / lib_default79) / lib_default108(a);
  return prefix;
}
var regularised_gamma_prefix_default2 = regularisedGammaPrefix2;

function gammaPDerivative(a, x) {
  var f1;
  if (a <= 0) {
    return NaN;
  }
  if (x < 0) {
    return NaN;
  }
  if (x === 0) {
    if (a > 1) {
      return 0;
    }
    return a === 1 ? 1 : lib_default27;
  }
  f1 = regularised_gamma_prefix_default2(a, x);
  if (x < 1 && lib_default86 * x < f1) {
    return lib_default27;
  }
  if (f1 === 0) {
    f1 = a * lib_default12(x) - x - lib_default98(a) - lib_default12(x);
    f1 = lib_default68(f1);
  } else {
    f1 /= x;
  }
  return f1;
}
var gamma_p_derivative_default = gammaPDerivative;

function logpdf7(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0) {
    return NaN;
  }
  if (x < 0 || x === lib_default27) {
    return lib_default11;
  }
  if (alpha === 0) {
    return x === 0 ? lib_default27 : lib_default11;
  }
  return lib_default12(gamma_p_derivative_default(alpha, x * beta2)) + lib_default12(beta2);
}
var main_default161 = logpdf7;

var degenerate6 = lib_default187.factory;
function factory41(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  if (alpha === 0) {
    return degenerate6(0);
  }
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0 || x === lib_default27) {
      return lib_default11;
    }
    return lib_default12(gamma_p_derivative_default(alpha, x * beta2)) + lib_default12(beta2);
  }
}
var factory_default41 = factory41;

main_default161.factory = factory_default41;
var lib_default199 = main_default161;

function logpdf8(x, k) {
  return lib_default199(x, k / 2, 0.5);
}
var main_default162 = logpdf8;

var gammaFactory4 = lib_default199.factory;
function factory42(k) {
  return gammaFactory4(k / 2, 0.5);
}
var factory_default42 = factory42;

main_default162.factory = factory_default42;
var lib_default200 = main_default162;

function mean7(k) {
  if (lib_default(k) || k < 0) {
    return NaN;
  }
  return k;
}
var main_default163 = mean7;

var lib_default201 = main_default163;

function quantile10(p101, k) {
  return lib_default193(p101, k / 2, 0.5);
}
var main_default164 = quantile10;

var gammaFactory5 = lib_default193.factory;
function factory43(k) {
  return gammaFactory5(k / 2, 0.5);
}
var factory_default43 = factory43;

main_default164.factory = factory_default43;
var lib_default202 = main_default164;

function median6(k) {
  return lib_default202(0.5, k);
}
var main_default165 = median6;

var lib_default203 = main_default165;

function mgf4(t, k) {
  if (lib_default(t) || lib_default(k) || k < 0 || t >= 0.5) {
    return NaN;
  }
  return lib_default47(1 - 2 * t, -k / 2);
}
var main_default166 = mgf4;

function factory44(k) {
  if (lib_default(k) || k < 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (lib_default(t) || t >= 0.5) {
      return NaN;
    }
    return lib_default47(1 - 2 * t, -k / 2);
  }
}
var factory_default44 = factory44;

main_default166.factory = factory_default44;
var lib_default204 = main_default166;

function mode8(k) {
  if (lib_default(k) || k < 0) {
    return NaN;
  }
  return lib_default83(k - 2, 0);
}
var main_default167 = mode8;

var lib_default205 = main_default167;

function regularisedGammaPrefix3(a, z) {
  var prefix;
  var amza;
  var agh;
  var alz;
  var amz;
  var sq;
  var d2;
  agh = a + lib_default94 - 0.5;
  d2 = (z - a - lib_default94 + 0.5) / agh;
  if (a < 1) {
    if (z <= lib_default103) {
      return lib_default68(a * lib_default12(z) - z - lib_default98(a));
    }
    return lib_default47(z, a) * lib_default68(-z) / lib_default90(a);
  }
  if (lib_default29(d2 * d2 * a) <= 100 && a > 150) {
    prefix = a * (lib_default78(d2) - d2) + z * (0.5 - lib_default94) / agh;
    prefix = lib_default68(prefix);
  } else {
    alz = a * lib_default12(z / agh);
    amz = a - z;
    if (lib_default85(alz, amz) <= lib_default103 || lib_default83(alz, amz) >= lib_default99) {
      amza = amz / a;
      if (lib_default85(alz, amz) / 2 > lib_default103 && lib_default83(alz, amz) / 2 < lib_default99) {
        sq = lib_default47(z / agh, a / 2) * lib_default68(amz / 2);
        prefix = sq * sq;
      } else if (lib_default85(alz, amz) / 4 > lib_default103 && lib_default83(alz, amz) / 4 < lib_default99 && z > a) {
        sq = lib_default47(z / agh, a / 4) * lib_default68(amz / 4);
        prefix = sq * sq;
        prefix *= prefix;
      } else if (amza > lib_default103 && amza < lib_default99) {
        prefix = lib_default47(z * lib_default68(amza) / agh, a);
      } else {
        prefix = lib_default68(alz + amz);
      }
    } else {
      prefix = lib_default47(z / agh, a) * lib_default68(amz);
    }
  }
  prefix *= lib_default2(agh / lib_default79) / lib_default108(a);
  return prefix;
}
var regularised_gamma_prefix_default3 = regularisedGammaPrefix3;

function gammaPDerivative2(a, x) {
  var f1;
  if (a <= 0) {
    return NaN;
  }
  if (x < 0) {
    return NaN;
  }
  if (x === 0) {
    if (a > 1) {
      return 0;
    }
    return a === 1 ? 1 : lib_default27;
  }
  f1 = regularised_gamma_prefix_default3(a, x);
  if (x < 1 && lib_default86 * x < f1) {
    return lib_default27;
  }
  if (f1 === 0) {
    f1 = a * lib_default12(x) - x - lib_default98(a) - lib_default12(x);
    f1 = lib_default68(f1);
  } else {
    f1 /= x;
  }
  return f1;
}
var gamma_p_derivative_default2 = gammaPDerivative2;

function pdf8(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0) {
    return NaN;
  }
  if (x < 0 || x === lib_default27) {
    return 0;
  }
  if (alpha === 0) {
    return x === 0 ? lib_default27 : 0;
  }
  return gamma_p_derivative_default2(alpha, x * beta2) * beta2;
}
var main_default168 = pdf8;

var degenerate7 = lib_default190.factory;
function factory45(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  if (alpha === 0) {
    return degenerate7(0);
  }
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0 || x === lib_default27) {
      return 0;
    }
    return gamma_p_derivative_default2(alpha, x * beta2) * beta2;
  }
}
var factory_default45 = factory45;

main_default168.factory = factory_default45;
var lib_default206 = main_default168;

function pdf9(x, k) {
  return lib_default206(x, k / 2, 0.5);
}
var main_default169 = pdf9;

var gammaFactory6 = lib_default206.factory;
function factory46(k) {
  return gammaFactory6(k / 2, 0.5);
}
var factory_default46 = factory46;

main_default169.factory = factory_default46;
var lib_default207 = main_default169;

function skewness6(k) {
  if (lib_default(k) || k <= 0) {
    return NaN;
  }
  return lib_default2(8 / k);
}
var main_default170 = skewness6;

var lib_default208 = main_default170;

function variance7(k) {
  if (lib_default(k) || k < 0) {
    return NaN;
  }
  return 2 * k;
}
var main_default171 = variance7;

var lib_default209 = main_default171;

function stdev7(k) {
  return lib_default2(lib_default209(k));
}
var main_default172 = stdev7;

var lib_default210 = main_default172;

function cdf11(x, mu, s) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(s) || s < 0) {
    return NaN;
  }
  if (s === 0) {
    return x < mu ? 0 : 1;
  }
  if (x < mu - s) {
    return 0;
  }
  if (x > mu + s) {
    return 1;
  }
  z = (x - mu) / s;
  return (1 + z + lib_default97(z) / lib_default5) / 2;
}
var main_default173 = cdf11;

var degenerate8 = lib_default179.factory;
function factory47(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate8(mu);
  }
  return cdf35;
  function cdf35(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < mu - s) {
      return 0;
    }
    if (x > mu + s) {
      return 1;
    }
    z = (x - mu) / s;
    return (1 + z + lib_default97(z) / lib_default5) / 2;
  }
}
var factory_default47 = factory47;

main_default173.factory = factory_default47;
var lib_default211 = main_default173;

var COSINE_EXCESS_KURTOSIS = -0.5937628755982794;
function kurtosis6(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return COSINE_EXCESS_KURTOSIS;
}
var main_default174 = kurtosis6;

var lib_default212 = main_default174;

function logcdf5(x, mu, s) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(s) || s < 0) {
    return NaN;
  }
  if (s === 0) {
    return x < mu ? lib_default11 : 0;
  }
  if (x < mu - s) {
    return lib_default11;
  }
  if (x > mu + s) {
    return 0;
  }
  z = (x - mu) / s;
  return lib_default12((1 + z + lib_default97(z) / lib_default5) / 2);
}
var main_default175 = logcdf5;

function logcdf6(x, mu) {
  if (lib_default(x) || lib_default(mu)) {
    return NaN;
  }
  return x < mu ? lib_default11 : 0;
}
var main_default176 = logcdf6;

function factory48(mu) {
  if (lib_default(mu)) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return x < mu ? lib_default11 : 0;
  }
}
var factory_default48 = factory48;

main_default176.factory = factory_default48;
var lib_default213 = main_default176;

var degenerate9 = lib_default213.factory;
function factory49(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate9(mu);
  }
  return logcdf24;
  function logcdf24(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < mu - s) {
      return lib_default11;
    }
    if (x > mu + s) {
      return 0;
    }
    z = (x - mu) / s;
    return lib_default12((1 + z + lib_default97(z) / lib_default5) / 2);
  }
}
var factory_default49 = factory49;

main_default175.factory = factory_default49;
var lib_default214 = main_default175;

var MAX_INTEGER_P1 = lib_default116 + 1;
function cospi(x) {
  var ax;
  var ix;
  var rx;
  var y;
  if (lib_default(x)) {
    return NaN;
  }
  if (lib_default28(x)) {
    return NaN;
  }
  ax = lib_default29(x);
  if (ax > MAX_INTEGER_P1) {
    return 1;
  }
  ix = lib_default23(ax);
  rx = ax - ix;
  if (rx === 0.5) {
    return 0;
  }
  if (rx < 0.25) {
    y = lib_default96(lib_default5 * rx);
  } else if (rx < 0.75) {
    rx = 0.5 - rx;
    y = lib_default55(lib_default5 * rx);
  } else {
    rx = 1 - rx;
    y = -lib_default96(lib_default5 * rx);
  }
  return ix % 2 === 1 ? -y : y;
}
var main_default177 = cospi;

var lib_default215 = main_default177;

function logpdf9(x, mu, s) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(s) || s < 0) {
    return NaN;
  }
  if (s === 0) {
    return x === mu ? lib_default27 : lib_default11;
  }
  if (x < mu - s || x > mu + s) {
    return lib_default11;
  }
  z = (x - mu) / s;
  return lib_default12(1 + lib_default215(z)) - lib_default12(2 * s);
}
var main_default178 = logpdf9;

var degenerate10 = lib_default187.factory;
function factory50(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate10(mu);
  }
  return logpdf27;
  function logpdf27(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < mu - s || x > mu + s) {
      return lib_default11;
    }
    z = (x - mu) / s;
    return lib_default12(1 + lib_default215(z)) - lib_default12(2 * s);
  }
}
var factory_default50 = factory50;

main_default178.factory = factory_default50;
var lib_default216 = main_default178;

function mean8(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return mu;
}
var main_default179 = mean8;

var lib_default217 = main_default179;

function median7(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return mu;
}
var main_default180 = median7;

var lib_default218 = main_default180;

function evalrational25(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.16666666666666666;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -351754.9648081514 + x * (-11561.443576500522 + x * (-163.72585752598383 + x * -0.789474443963537));
    s2 = -2.1105297888489086e6 + x * (36157.827983443196 + x * (-277.7110814206028 + x * 1));
  } else {
    x = 1 / x;
    s1 = -0.789474443963537 + x * (-163.72585752598383 + x * (-11561.443576500522 + x * -351754.9648081514));
    s2 = 1 + x * (-277.7110814206028 + x * (36157.827983443196 + x * -2.1105297888489086e6));
  }
  return s1 / s2;
}
var rational_pq_default6 = evalrational25;

var MAXLOG = 709.782712893384;
var MINLOG = -708.3964185322641;
var POS_OVERFLOW = MAXLOG + lib_default16;
var NEG_OVERFLOW = MINLOG - lib_default16;
var LARGE = MAXLOG - lib_default16;
function sinh(x) {
  var a;
  if (x === 0) {
    return x;
  }
  if (x > POS_OVERFLOW || x < NEG_OVERFLOW) {
    return x > 0 ? lib_default27 : lib_default11;
  }
  a = lib_default29(x);
  if (a > 1) {
    if (a >= LARGE) {
      a = lib_default68(0.5 * a);
      a *= 0.5 * a;
      if (x < 0) {
        a = -a;
      }
      return a;
    }
    a = lib_default68(a);
    a = 0.5 * a - 0.5 / a;
    if (x < 0) {
      a = -a;
    }
    return a;
  }
  a *= a;
  return x + x * a * rational_pq_default6(a);
}
var main_default181 = sinh;

var lib_default219 = main_default181;

var PI_SQUARED = 9.869604401089358;
var lib_default220 = PI_SQUARED;

function mgf5(t, mu, s) {
  var out;
  var st;
  if (lib_default(t) || lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  st = s * t;
  out = lib_default220 * lib_default219(st);
  out /= st * (lib_default220 + st * st);
  out *= lib_default68(mu * t);
  return out;
}
var main_default182 = mgf5;

function factory51(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    var out;
    var st;
    if (lib_default(t)) {
      return NaN;
    }
    st = s * t;
    out = lib_default220 * lib_default219(st);
    out /= st * (lib_default220 + st * st);
    out *= lib_default68(mu * t);
    return out;
  }
}
var factory_default51 = factory51;

main_default182.factory = factory_default51;
var lib_default221 = main_default182;

function mode9(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return mu;
}
var main_default183 = mode9;

var lib_default222 = main_default183;

function pdf10(x, mu, s) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(s) || s < 0) {
    return NaN;
  }
  if (s === 0) {
    return x === mu ? lib_default27 : 0;
  }
  if (x < mu - s || x > mu + s) {
    return 0;
  }
  z = (x - mu) / s;
  return (1 + lib_default215(z)) / (2 * s);
}
var main_default184 = pdf10;

var degenerate11 = lib_default190.factory;
function factory52(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate11(mu);
  }
  return pdf30;
  function pdf30(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < mu - s || x > mu + s) {
      return 0;
    }
    z = (x - mu) / s;
    return (1 + lib_default215(z)) / (2 * s);
  }
}
var factory_default52 = factory52;

main_default184.factory = factory_default52;
var lib_default223 = main_default184;

var MAX_ITERATIONS2 = 1e4;
var TOLERANCE = 1e-12;
function bisect(p101, mu, s) {
  var a;
  var b;
  var c2;
  var m;
  var n;
  n = 1;
  a = mu - s;
  b = mu + s;
  while (n < MAX_ITERATIONS2) {
    m = (a + b) / 2;
    if (b - a < TOLERANCE) {
      return m;
    }
    c2 = lib_default211(m, mu, s);
    if (p101 > c2) {
      a = m;
    } else {
      b = m;
    }
    n += 1;
  }
  return m;
}
var bisect_default = bisect;

function quantile11(p101, mu, s) {
  if (lib_default(mu) || lib_default(s) || lib_default(p101) || s < 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (s === 0) {
    return mu;
  }
  return bisect_default(p101, mu, s);
}
var main_default185 = quantile11;

var degenerate12 = lib_default192.factory;
function factory53(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate12(mu);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return bisect_default(p101, mu, s);
  }
}
var factory_default53 = factory53;

main_default185.factory = factory_default53;
var lib_default224 = main_default185;

function skewness7(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return 0;
}
var main_default186 = skewness7;

var lib_default225 = main_default186;

var STDEV_CONST = 0.36151205519132795;
function stdev8(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return s * STDEV_CONST;
}
var main_default187 = stdev8;

var lib_default226 = main_default187;

var SCALAR2 = 0.13069096604865776;
function variance8(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return s * s * SCALAR2;
}
var main_default188 = variance8;

var lib_default227 = main_default188;

function entropy8(mu) {
  if (lib_default(mu)) {
    return NaN;
  }
  return 0;
}
var main_default189 = entropy8;

var lib_default228 = main_default189;

function mean9(mu) {
  return mu;
}
var main_default190 = mean9;

var lib_default229 = main_default190;

function median8(mu) {
  return mu;
}
var main_default191 = median8;

var lib_default230 = main_default191;

function mgf6(t, mu) {
  if (lib_default(t) || lib_default(mu)) {
    return NaN;
  }
  return lib_default68(mu * t);
}
var main_default192 = mgf6;

function factory54(mu) {
  if (lib_default(mu)) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (lib_default(t)) {
      return NaN;
    }
    return lib_default68(mu * t);
  }
}
var factory_default54 = factory54;

main_default192.factory = factory_default54;
var lib_default231 = main_default192;

function mode10(mu) {
  return mu;
}
var main_default193 = mode10;

var lib_default232 = main_default193;

function pmf2(x, mu) {
  if (lib_default(x) || lib_default(mu)) {
    return NaN;
  }
  return x === mu ? 1 : 0;
}
var main_default194 = pmf2;

function factory55(mu) {
  if (lib_default(mu)) {
    return lib_default6(NaN);
  }
  return pmf8;
  function pmf8(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return x === mu ? 1 : 0;
  }
}
var factory_default55 = factory55;

main_default194.factory = factory_default55;
var lib_default233 = main_default194;

function stdev9(mu) {
  if (lib_default(mu)) {
    return NaN;
  }
  return 0;
}
var main_default195 = stdev9;

var lib_default234 = main_default195;

function variance9(mu) {
  if (lib_default(mu)) {
    return NaN;
  }
  return 0;
}
var main_default196 = variance9;

var lib_default235 = main_default196;

function entropy9(a, b) {
  if (!lib_default24(a) || !lib_default24(b) || a > b) {
    return NaN;
  }
  return lib_default12(b - a + 1);
}
var main_default197 = entropy9;

var lib_default236 = main_default197;

function kurtosis7(a, b) {
  var n2;
  if (!lib_default24(a) || !lib_default24(b) || a > b) {
    return NaN;
  }
  n2 = lib_default47(b - a + 1, 2);
  return -1.2 * (n2 + 1) / (n2 - 1);
}
var main_default198 = kurtosis7;

var lib_default237 = main_default198;

function mean10(a, b) {
  if (!lib_default24(a) || !lib_default24(b) || a > b) {
    return NaN;
  }
  return a / 2 + b / 2;
}
var main_default199 = mean10;

var lib_default238 = main_default199;

function median9(a, b) {
  if (!lib_default24(a) || !lib_default24(b) || a > b) {
    return NaN;
  }
  return a / 2 + b / 2;
}
var main_default200 = median9;

var lib_default239 = main_default200;

function skewness8(a, b) {
  if (!lib_default24(a) || !lib_default24(b) || a > b) {
    return NaN;
  }
  return 0;
}
var main_default201 = skewness8;

var lib_default240 = main_default201;

var SQRT1O12 = lib_default2(1 / 12);
function stdev10(a, b) {
  if (!lib_default24(a) || !lib_default24(b) || a > b) {
    return NaN;
  }
  return SQRT1O12 * lib_default2(lib_default47(b - a + 1, 2) - 1);
}
var main_default202 = stdev10;

var lib_default241 = main_default202;

function variance10(a, b) {
  if (!lib_default24(a) || !lib_default24(b) || a > b) {
    return NaN;
  }
  return (lib_default47(b - a + 1, 2) - 1) / 12;
}
var main_default203 = variance10;

var lib_default242 = main_default203;

function isNonNegativeInteger(x) {
  return lib_default23(x) === x && x >= 0;
}
var main_default204 = isNonNegativeInteger;

var lib_default243 = main_default204;

function cdf12(x, k, lambda) {
  if (!lib_default243(k)) {
    return NaN;
  }
  return lib_default180(x, k, lambda);
}
var main_default205 = cdf12;

var factoryGamma = lib_default180.factory;
function factory56(k, lambda) {
  if (!lib_default243(k)) {
    return lib_default6(NaN);
  }
  return factoryGamma(k, lambda);
}
var factory_default56 = factory56;

main_default205.factory = factory_default56;
var lib_default244 = main_default205;

function isPositiveInteger(x) {
  return lib_default23(x) === x && x > 0;
}
var main_default206 = isPositiveInteger;

var lib_default245 = main_default206;

function entropy10(k, lambda) {
  if (!lib_default245(k) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return (1 - k) * lib_default124(k) + lib_default12(lib_default90(k) / lambda) + k;
}
var main_default207 = entropy10;

var lib_default246 = main_default207;

function kurtosis8(k, lambda) {
  if (!lib_default245(k) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return 6 / k;
}
var main_default208 = kurtosis8;

var lib_default247 = main_default208;

function logpdf10(x, k, lambda) {
  if (!lib_default243(k)) {
    return NaN;
  }
  return lib_default199(x, k, lambda);
}
var main_default209 = logpdf10;

var factoryGamma2 = lib_default199.factory;
function factory57(k, lambda) {
  if (!lib_default243(k)) {
    return lib_default6(NaN);
  }
  return factoryGamma2(k, lambda);
}
var factory_default57 = factory57;

main_default209.factory = factory_default57;
var lib_default248 = main_default209;

function mean11(k, lambda) {
  if (!lib_default245(k) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return k / lambda;
}
var main_default210 = mean11;

var lib_default249 = main_default210;

function mgf7(t, k, lambda) {
  if (lib_default(t) || !lib_default243(k) || lib_default(lambda) || lambda < 0 || t >= lambda) {
    return NaN;
  }
  return lib_default47(1 - t / lambda, -k);
}
var main_default211 = mgf7;

function factory58(k, lambda) {
  if (!lib_default243(k) || lib_default(lambda) || lambda < 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (lib_default(t) || t >= lambda) {
      return NaN;
    }
    return lib_default47(1 - t / lambda, -k);
  }
}
var factory_default58 = factory58;

main_default211.factory = factory_default58;
var lib_default250 = main_default211;

function mode11(k, lambda) {
  if (!lib_default245(k) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return (k - 1) / lambda;
}
var main_default212 = mode11;

var lib_default251 = main_default212;

function pdf11(x, k, lambda) {
  if (!lib_default243(k)) {
    return NaN;
  }
  return lib_default206(x, k, lambda);
}
var main_default213 = pdf11;

var factoryGamma3 = lib_default206.factory;
function factory59(k, lambda) {
  if (!lib_default243(k)) {
    return lib_default6(NaN);
  }
  return factoryGamma3(k, lambda);
}
var factory_default59 = factory59;

main_default213.factory = factory_default59;
var lib_default252 = main_default213;

function quantile12(p101, k, lambda) {
  if (!lib_default243(k)) {
    return NaN;
  }
  return lib_default193(p101, k, lambda);
}
var main_default214 = quantile12;

var factoryGamma4 = lib_default193.factory;
function factory60(k, lambda) {
  if (!lib_default243(k)) {
    return lib_default6(NaN);
  }
  return factoryGamma4(k, lambda);
}
var factory_default60 = factory60;

main_default214.factory = factory_default60;
var lib_default253 = main_default214;

function skewness9(k, lambda) {
  if (!lib_default245(k) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return 2 / lib_default2(k);
}
var main_default215 = skewness9;

var lib_default254 = main_default215;

function stdev11(k, lambda) {
  if (!lib_default245(k) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return lib_default2(k) / lambda;
}
var main_default216 = stdev11;

var lib_default255 = main_default216;

function variance11(k, lambda) {
  if (!lib_default245(k) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return k / (lambda * lambda);
}
var main_default217 = variance11;

var lib_default256 = main_default217;

function cdf13(x, lambda) {
  if (lib_default(lambda) || lambda < 0 || lambda === lib_default27) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  return 1 - lib_default68(-lambda * x);
}
var main_default218 = cdf13;

function factory61(lambda) {
  if (lib_default(lambda) || lambda < 0 || lambda === lib_default27) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (x < 0) {
      return 0;
    }
    return 1 - lib_default68(-lambda * x);
  }
}
var factory_default61 = factory61;

main_default218.factory = factory_default61;
var lib_default257 = main_default218;

function entropy11(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return 1 - lib_default12(lambda);
}
var main_default219 = entropy11;

var lib_default258 = main_default219;

function kurtosis9(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return 6;
}
var main_default220 = kurtosis9;

var lib_default259 = main_default220;

function logcdf7(x, lambda) {
  if (lib_default(lambda) || lambda < 0 || lambda === lib_default27) {
    return NaN;
  }
  if (x < 0) {
    return lib_default11;
  }
  return lib_default78(-lib_default68(-lambda * x));
}
var main_default221 = logcdf7;

function factory62(lambda) {
  if (lib_default(lambda) || lambda < 0 || lambda === lib_default27) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (x < 0) {
      return lib_default11;
    }
    return lib_default78(-lib_default68(-lambda * x));
  }
}
var factory_default62 = factory62;

main_default221.factory = factory_default62;
var lib_default260 = main_default221;

function logpdf11(x, lambda) {
  if (lib_default(x) || lib_default(lambda) || lambda < 0 || lambda === lib_default27) {
    return NaN;
  }
  if (x < 0) {
    return lib_default11;
  }
  return -x * lambda + lib_default12(lambda);
}
var main_default222 = logpdf11;

function factory63(lambda) {
  if (lib_default(lambda) || lambda < 0 || lambda === lib_default27) {
    return lib_default6(NaN);
  }
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return lib_default11;
    }
    return -(x * lambda) + lib_default12(lambda);
  }
}
var factory_default63 = factory63;

main_default222.factory = factory_default63;
var lib_default261 = main_default222;

function mean12(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return 1 / lambda;
}
var main_default223 = mean12;

var lib_default262 = main_default223;

function median10(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return 1 / lambda * lib_default16;
}
var main_default224 = median10;

var lib_default263 = main_default224;

function mgf8(t, lambda) {
  if (lib_default(t) || lib_default(lambda) || lambda <= 0 || lambda === lib_default27 || t >= lambda) {
    return NaN;
  }
  return lambda / (lambda - t);
}
var main_default225 = mgf8;

function factory64(lambda) {
  if (lib_default(lambda) || lambda <= 0 || lambda === lib_default27) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (lib_default(t) || t >= lambda) {
      return NaN;
    }
    return lambda / (lambda - t);
  }
}
var factory_default64 = factory64;

main_default225.factory = factory_default64;
var lib_default264 = main_default225;

function mode12(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return 0;
}
var main_default226 = mode12;

var lib_default265 = main_default226;

function pdf12(x, lambda) {
  var scale;
  if (lib_default(x) || lib_default(lambda) || lambda < 0 || lambda === lib_default27) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  scale = 1 / lambda;
  return lib_default68(-x / scale) / scale;
}
var main_default227 = pdf12;

function factory65(lambda) {
  var scale;
  if (lib_default(lambda) || lambda < 0 || lambda === lib_default27) {
    return lib_default6(NaN);
  }
  scale = 1 / lambda;
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    return lib_default68(-x / scale) / scale;
  }
}
var factory_default65 = factory65;

main_default227.factory = factory_default65;
var lib_default266 = main_default227;

function quantile13(p101, lambda) {
  if (lib_default(lambda) || lambda < 0 || lambda === lib_default27 || lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return -lib_default12(1 - p101) / lambda;
}
var main_default228 = quantile13;

function factory66(lambda) {
  if (lambda < 0 || lambda === lib_default27 || lib_default(lambda)) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return -lib_default12(1 - p101) / lambda;
  }
}
var factory_default66 = factory66;

main_default228.factory = factory_default66;
var lib_default267 = main_default228;

function skewness10(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return 2;
}
var main_default229 = skewness10;

var lib_default268 = main_default229;

function stdev12(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return 1 / lambda;
}
var main_default230 = stdev12;

var lib_default269 = main_default230;

function variance12(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return 1 / (lambda * lambda);
}
var main_default231 = variance12;

var lib_default270 = main_default231;

function cdf14(x, d1, d2) {
  if (lib_default(x) || lib_default(d1) || lib_default(d2) || d1 <= 0 || d2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return 0;
  }
  if (x === lib_default27) {
    return 1;
  }
  if (d1 * x > d2) {
    return lib_default120(d1 * x / (d2 + d1 * x), d1 / 2, d2 / 2, true, false);
  }
  return lib_default120(d2 / (d2 + d1 * x), d2 / 2, d1 / 2, true, true);
}
var main_default232 = cdf14;

function factory67(d1, d2) {
  if (lib_default(d1) || lib_default(d2) || d1 <= 0 || d2 <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return 0;
    }
    if (x === lib_default27) {
      return 1;
    }
    if (d1 * x > d2) {
      return lib_default120(d1 * x / (d2 + d1 * x), d1 / 2, d2 / 2, true, false);
    }
    return lib_default120(d2 / (d2 + d1 * x), d2 / 2, d1 / 2, true, true);
  }
}
var factory_default67 = factory67;

main_default232.factory = factory_default67;
var lib_default271 = main_default232;

function entropy12(d1, d2) {
  var half;
  var hd1;
  var hd2;
  var out;
  if (lib_default(d1) || lib_default(d2) || d1 <= 0 || d2 <= 0) {
    return NaN;
  }
  half = (d1 + d2) / 2;
  hd1 = d1 / 2;
  hd2 = d2 / 2;
  out = lib_default12(d2 / d1) + lib_default98(hd1) + lib_default98(hd2) - lib_default98(half);
  out += (1 - hd1) * lib_default124(hd1);
  out += (-1 - hd2) * lib_default124(hd2);
  out += half * lib_default124(half);
  return out;
}
var main_default233 = entropy12;

var lib_default272 = main_default233;

function mean13(d1, d2) {
  if (lib_default(d1) || lib_default(d2) || d1 <= 0 || d2 <= 2) {
    return NaN;
  }
  return d2 / (d2 - 2);
}
var main_default234 = mean13;

var lib_default273 = main_default234;

function mode13(d1, d2) {
  if (d1 <= 2 || d2 <= 0) {
    return NaN;
  }
  return (d1 - 2) / d1 * (d2 / (d2 + 2));
}
var main_default235 = mode13;

var lib_default274 = main_default235;

function ibetaPowerTerms2(a, b, x, y, normalized) {
  var result;
  var smallA;
  var ratio;
  var agh;
  var bgh;
  var cgh;
  var l1;
  var l2;
  var l3;
  var p110;
  var b1;
  var b2;
  var c2;
  var l;
  if (!normalized) {
    return lib_default47(x, a) * lib_default47(y, b);
  }
  c2 = a + b;
  agh = a + lib_default94 - 0.5;
  bgh = b + lib_default94 - 0.5;
  cgh = c2 + lib_default94 - 0.5;
  result = lib_default108(c2);
  result /= lib_default108(a) * lib_default108(b);
  result *= lib_default2(bgh / lib_default79);
  result *= lib_default2(agh / cgh);
  l1 = (x * b - y * agh) / agh;
  l2 = (y * a - x * bgh) / bgh;
  if (lib_default85(lib_default29(l1), lib_default29(l2)) < 0.2) {
    if (l1 * l2 > 0 || lib_default85(a, b) < 1) {
      if (lib_default29(l1) < 0.1) {
        result *= lib_default68(a * lib_default78(l1));
      } else {
        result *= lib_default47(x * cgh / agh, a);
      }
      if (lib_default29(l2) < 0.1) {
        result *= lib_default68(b * lib_default78(l2));
      } else {
        result *= lib_default47(y * cgh / bgh, b);
      }
    } else if (lib_default83(lib_default29(l1), lib_default29(l2)) < 0.5) {
      smallA = a < b;
      ratio = b / a;
      if (smallA && ratio * l2 < 0.1 || !smallA && l1 / ratio > 0.1) {
        l3 = lib_default77(ratio * lib_default78(l2));
        l3 = l1 + l3 + l3 * l1;
        l3 = a * lib_default78(l3);
        result *= lib_default68(l3);
      } else {
        l3 = lib_default77(lib_default78(l1) / ratio);
        l3 = l2 + l3 + l3 * l2;
        l3 = b * lib_default78(l3);
        result *= lib_default68(l3);
      }
    } else if (lib_default29(l1) < lib_default29(l2)) {
      l = a * lib_default78(l1) + b * lib_default12(y * cgh / bgh);
      if (l <= lib_default103 || l >= lib_default99) {
        l += lib_default12(result);
        if (l >= lib_default99) {
          return NaN;
        }
        result = lib_default68(l);
      } else {
        result *= lib_default68(l);
      }
    } else {
      l = b * lib_default78(l2) + a * lib_default12(x * cgh / agh);
      if (l <= lib_default103 || l >= lib_default99) {
        l += lib_default12(result);
        if (l >= lib_default99) {
          return NaN;
        }
        result = lib_default68(l);
      } else {
        result *= lib_default68(l);
      }
    }
  } else {
    b1 = x * cgh / agh;
    b2 = y * cgh / bgh;
    l1 = a * lib_default12(b1);
    l2 = b * lib_default12(b2);
    if (l1 >= lib_default99 || l1 <= lib_default103 || l2 >= lib_default99 || l2 <= lib_default103) {
      if (a < b) {
        p110 = lib_default47(b2, b / a);
        l3 = a * (lib_default12(b1) + lib_default12(p110));
        if (l3 < lib_default99 && l3 > lib_default103) {
          result *= lib_default47(p110 * b1, a);
        } else {
          l2 += l1 + lib_default12(result);
          if (l2 >= lib_default99) {
            return NaN;
          }
          result = lib_default68(l2);
        }
      } else {
        p110 = lib_default47(b1, a / b);
        l3 = (lib_default12(p110) + lib_default12(b2)) * b;
        if (l3 < lib_default99 && l3 > lib_default103) {
          result *= lib_default47(p110 * b2, b);
        } else {
          l2 += l1 + lib_default12(result);
          if (l2 >= lib_default99) {
            return NaN;
          }
          result = lib_default68(l2);
        }
      }
    } else {
      result *= lib_default47(b1, a) * lib_default47(b2, b);
    }
  }
  return result;
}
var ibeta_power_terms_default2 = ibetaPowerTerms2;

function ibetaDerivative(x, a, b) {
  var f1;
  var y;
  f1 = ibeta_power_terms_default2(a, b, x, 1 - x, true);
  y = (1 - x) * x;
  f1 /= y;
  return f1;
}
var ibeta_derivative_default = ibetaDerivative;

function pdf13(x, d1, d2) {
  var v1x;
  var y;
  var z;
  if (lib_default(x) || lib_default(d1) || lib_default(d2) || d1 <= 0 || d2 <= 0) {
    return NaN;
  }
  if (x < 0 || x === lib_default27) {
    return 0;
  }
  if (x === 0) {
    if (d1 < 2) {
      return lib_default27;
    }
    if (d1 === 2) {
      return 1;
    }
    return 0;
  }
  v1x = d1 * x;
  if (v1x > d2) {
    y = d2 * d1 / ((d2 + v1x) * (d2 + v1x));
    return y * ibeta_derivative_default(d2 / (d2 + v1x), d2 / 2, d1 / 2);
  }
  z = d2 + v1x;
  y = (z * d1 - x * d1 * d1) / (z * z);
  return y * ibeta_derivative_default(v1x / (d2 + v1x), d1 / 2, d2 / 2);
}
var main_default236 = pdf13;

function factory68(d1, d2) {
  var zeroVal;
  var d1by2;
  var d2by2;
  var d1d2;
  if (lib_default(d1) || lib_default(d2) || d1 <= 0 || d2 <= 0) {
    return lib_default6(NaN);
  }
  d1d2 = d1 * d2;
  d1by2 = d1 / 2;
  d2by2 = d2 / 2;
  zeroVal = 0;
  if (d1 < 2) {
    zeroVal = lib_default27;
  } else if (d1 === 2) {
    zeroVal = 1;
  }
  return pdf30;
  function pdf30(x) {
    var v1x;
    var y;
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0 || x === lib_default27) {
      return 0;
    }
    if (x === 0) {
      return zeroVal;
    }
    v1x = d1 * x;
    if (v1x > d2) {
      y = d1d2 / ((d2 + v1x) * (d2 + v1x));
      return y * ibeta_derivative_default(d2 / (d2 + v1x), d2by2, d1by2);
    }
    z = d2 + v1x;
    y = (z * d1 - x * d1 * d1) / (z * z);
    return y * ibeta_derivative_default(d1 * x / (d2 + v1x), d1by2, d2by2);
  }
}
var factory_default68 = factory68;

main_default236.factory = factory_default68;
var lib_default275 = main_default236;

function quantile14(p101, d1, d2) {
  var xs;
  if (lib_default(p101) || lib_default(d1) || lib_default(d2) || d1 <= 0 || d2 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  xs = lib_default139(d1 / 2, d2 / 2, p101, 1 - p101);
  return d2 * xs[0] / (d1 * xs[1]);
}
var main_default237 = quantile14;

function factory69(d1, d2) {
  if (lib_default(d1) || lib_default(d2) || d1 <= 0 || d2 <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    var xs;
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    xs = lib_default139(d1 / 2, d2 / 2, p101, 1 - p101);
    return d2 * xs[0] / (d1 * xs[1]);
  }
}
var factory_default69 = factory69;

main_default237.factory = factory_default69;
var lib_default276 = main_default237;

function cdf15(x, alpha, s, m) {
  var z;
  if (lib_default(x) || lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  if (x <= m) {
    return 0;
  }
  z = (x - m) / s;
  return lib_default68(-lib_default47(z, -alpha));
}
var main_default238 = cdf15;

function factory70(alpha, s, m) {
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= m) {
      return 0;
    }
    z = (x - m) / s;
    return lib_default68(-lib_default47(z, -alpha));
  }
}
var factory_default70 = factory70;

main_default238.factory = factory_default70;
var lib_default277 = main_default238;

function entropy13(alpha, s, m) {
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  return 1 + lib_default89 / alpha + lib_default89 + lib_default12(s / alpha);
}
var main_default239 = entropy13;

var lib_default278 = main_default239;

function kurtosis10(alpha, s, m) {
  var out;
  var g1;
  var g2;
  var g3;
  var g4;
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  if (alpha <= 4) {
    return lib_default27;
  }
  g1 = lib_default90(1 - 1 / alpha);
  g2 = lib_default90(1 - 2 / alpha);
  g3 = lib_default90(1 - 3 / alpha);
  g4 = lib_default90(1 - 4 / alpha);
  out = (g4 - 4 * g3 * g1 + 3 * g2 * g2) / lib_default47(g2 - g1 * g1, 2);
  out -= 6;
  return out;
}
var main_default240 = kurtosis10;

var lib_default279 = main_default240;

function logcdf8(x, alpha, s, m) {
  var z;
  if (lib_default(x) || lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  if (x <= m) {
    return lib_default11;
  }
  z = (x - m) / s;
  return -lib_default47(z, -alpha);
}
var main_default241 = logcdf8;

function factory71(alpha, s, m) {
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= m) {
      return lib_default11;
    }
    z = (x - m) / s;
    return -lib_default47(z, -alpha);
  }
}
var factory_default71 = factory71;

main_default241.factory = factory_default71;
var lib_default280 = main_default241;

function logpdf12(x, alpha, s, m) {
  var z;
  if (lib_default(x) || lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  if (x <= m) {
    return lib_default11;
  }
  z = (x - m) / s;
  return lib_default12(alpha / s) - (1 + alpha) * lib_default12(z) - lib_default47(z, -alpha);
}
var main_default242 = logpdf12;

function factory72(alpha, s, m) {
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return lib_default6(NaN);
  }
  return logpdf27;
  function logpdf27(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= m) {
      return lib_default11;
    }
    z = (x - m) / s;
    return lib_default12(alpha / s) - (1 + alpha) * lib_default12(z) - lib_default47(z, -alpha);
  }
}
var factory_default72 = factory72;

main_default242.factory = factory_default72;
var lib_default281 = main_default242;

function mean14(alpha, s, m) {
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  if (alpha <= 1) {
    return lib_default27;
  }
  return m + s * lib_default90(1 - 1 / alpha);
}
var main_default243 = mean14;

var lib_default282 = main_default243;

function median11(alpha, s, m) {
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  return m + s * lib_default47(lib_default16, -1 / alpha);
}
var main_default244 = median11;

var lib_default283 = main_default244;

function mode14(alpha, s, m) {
  var ainv;
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  ainv = 1 / alpha;
  return m + s * lib_default47(1 + ainv, -ainv);
}
var main_default245 = mode14;

var lib_default284 = main_default245;

function pdf14(x, alpha, s, m) {
  if (lib_default(x) || lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  return lib_default68(lib_default281(x, alpha, s, m));
}
var main_default246 = pdf14;

var ldfrechet = lib_default281.factory;
function factory73(alpha, s, m) {
  var logpdf27;
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return lib_default6(NaN);
  }
  logpdf27 = ldfrechet(alpha, s, m);
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return lib_default68(logpdf27(x, alpha, s, m));
  }
}
var factory_default73 = factory73;

main_default246.factory = factory_default73;
var lib_default285 = main_default246;

function quantile15(p101, alpha, s, m) {
  if (lib_default(p101) || lib_default(alpha) || lib_default(s) || lib_default(m) || p101 < 0 || p101 > 1 || alpha <= 0 || s <= 0) {
    return NaN;
  }
  return m + s * lib_default47(-lib_default12(p101), -1 / alpha);
}
var main_default247 = quantile15;

function factory74(alpha, s, m) {
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return m + s * lib_default47(-lib_default12(p101), -1 / alpha);
  }
}
var factory_default74 = factory74;

main_default247.factory = factory_default74;
var lib_default286 = main_default247;

function skewness11(alpha, s, m) {
  var g1s;
  var g1;
  var g2;
  var g3;
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  if (alpha <= 3) {
    return lib_default27;
  }
  g1 = lib_default90(1 - 1 / alpha);
  g1s = g1 * g1;
  g2 = lib_default90(1 - 2 / alpha);
  g3 = lib_default90(1 - 3 / alpha);
  return (g3 - 3 * g2 * g1 + 2 * g1s * g1) / lib_default47(g2 - g1s, 1.5);
}
var main_default248 = skewness11;

var lib_default287 = main_default248;

function stdev13(alpha, s, m) {
  var g1;
  var g2;
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  if (alpha <= 2) {
    return lib_default27;
  }
  g1 = lib_default90(1 - 1 / alpha);
  g2 = lib_default90(1 - 2 / alpha);
  return s * lib_default2(g2 - g1 * g1);
}
var main_default249 = stdev13;

var lib_default288 = main_default249;

function variance13(alpha, s, m) {
  var g1;
  var g2;
  if (lib_default(alpha) || lib_default(s) || lib_default(m) || alpha <= 0 || s <= 0) {
    return NaN;
  }
  if (alpha <= 2) {
    return lib_default27;
  }
  g1 = lib_default90(1 - 1 / alpha);
  g2 = lib_default90(1 - 2 / alpha);
  return s * s * (g2 - g1 * g1);
}
var main_default250 = variance13;

var lib_default289 = main_default250;

function entropy14(alpha, beta2) {
  var out;
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  out = alpha - lib_default12(beta2);
  out += lib_default98(alpha);
  out += (1 - alpha) * lib_default124(alpha);
  return out;
}
var main_default251 = entropy14;

var lib_default290 = main_default251;

function kurtosis11(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return 6 / alpha;
}
var main_default252 = kurtosis11;

var lib_default291 = main_default252;

function logcdf9(x, alpha, beta2) {
  return lib_default12(lib_default180(x, alpha, beta2));
}
var main_default253 = logcdf9;

var degenerate13 = lib_default213.factory;
function factory75(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  if (alpha === 0) {
    return degenerate13(0);
  }
  return logcdf24;
  function logcdf24(x) {
    if (x <= 0) {
      return lib_default11;
    }
    if (x === lib_default27) {
      return 0;
    }
    return lib_default12(lib_default113(x * beta2, alpha));
  }
}
var factory_default75 = factory75;

main_default253.factory = factory_default75;
var lib_default292 = main_default253;

function mean15(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return alpha / beta2;
}
var main_default254 = mean15;

var lib_default293 = main_default254;

function mgf9(t, alpha, beta2) {
  var base;
  if (lib_default(t) || lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0 || t >= beta2) {
    return NaN;
  }
  base = 1 - t / beta2;
  return lib_default47(base, -alpha);
}
var main_default255 = mgf9;

function factory76(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha < 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    var base;
    if (t >= beta2) {
      return NaN;
    }
    base = 1 - t / beta2;
    return lib_default47(base, -alpha);
  }
}
var factory_default76 = factory76;

main_default255.factory = factory_default76;
var lib_default294 = main_default255;

function mode15(alpha, beta2) {
  if (alpha < 1 || beta2 <= 0) {
    return NaN;
  }
  return (alpha - 1) / beta2;
}
var main_default256 = mode15;

var lib_default295 = main_default256;

function skewness12(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return 2 / lib_default2(alpha);
}
var main_default257 = skewness12;

var lib_default296 = main_default257;

function stdev14(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return lib_default2(alpha) / beta2;
}
var main_default258 = stdev14;

var lib_default297 = main_default258;

function variance14(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return alpha / (beta2 * beta2);
}
var main_default259 = variance14;

var lib_default298 = main_default259;

function cdf16(x, p101) {
  if (lib_default(x) || lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  if (x === lib_default27) {
    return 1;
  }
  x = lib_default23(x);
  return 1 - lib_default47(1 - p101, x + 1);
}
var main_default260 = cdf16;

function factory77(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    if (x === lib_default27) {
      return 1;
    }
    x = lib_default23(x);
    return 1 - lib_default47(1 - p101, x + 1);
  }
}
var factory_default77 = factory77;

main_default260.factory = factory_default77;
var lib_default299 = main_default260;

function entropy15(p101) {
  var q;
  if (lib_default(p101) || p101 <= 0 || p101 >= 1) {
    return NaN;
  }
  q = 1 - p101;
  return (-(p101 * lib_default12(p101)) - q * lib_default12(q)) / p101;
}
var main_default261 = entropy15;

var lib_default300 = main_default261;

function kurtosis12(p101) {
  if (lib_default(p101) || p101 <= 0 || p101 >= 1) {
    return NaN;
  }
  return 6 + p101 * p101 / (1 - p101);
}
var main_default262 = kurtosis12;

var lib_default301 = main_default262;

function logcdf10(x, p101) {
  if (lib_default(x) || lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (x < 0) {
    return lib_default11;
  }
  if (x === lib_default27) {
    return 0;
  }
  x = lib_default23(x);
  return lib_default78(-lib_default47(1 - p101, x + 1));
}
var main_default263 = logcdf10;

function factory78(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return lib_default11;
    }
    if (x === lib_default27) {
      return 0;
    }
    x = lib_default23(x);
    return lib_default78(-lib_default47(1 - p101, x + 1));
  }
}
var factory_default78 = factory78;

main_default263.factory = factory_default78;
var lib_default302 = main_default263;

function mean16(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return (1 - p101) / p101;
}
var main_default264 = mean16;

var lib_default303 = main_default264;

function evalpoly71(x) {
  if (x === 0) {
    return 0.3999999999940942;
  }
  return 0.3999999999940942 + x * (0.22222198432149784 + x * 0.15313837699209373);
}
var polyval_p_default6 = evalpoly71;

function evalpoly72(x) {
  if (x === 0) {
    return 0.6666666666666735;
  }
  return 0.6666666666666735 + x * (0.2857142874366239 + x * (0.1818357216161805 + x * 0.14798198605116586));
}
var polyval_q_default4 = evalpoly72;

function kernelLog1p(f2) {
  var hfsq;
  var t1;
  var t2;
  var s;
  var z;
  var R;
  var w;
  s = f2 / (2 + f2);
  z = s * s;
  w = z * z;
  t1 = w * polyval_p_default6(w);
  t2 = z * polyval_q_default4(w);
  R = t2 + t1;
  hfsq = 0.5 * f2 * f2;
  return s * (hfsq + R);
}
var main_default265 = kernelLog1p;

var lib_default304 = main_default265;

var TWO542 = 18014398509481984;
var IVLN2HI = 1.4426950407214463;
var IVLN2LO = 16751713164886512e-26;
var HIGH_MAX_NORMAL_EXP2 = 2146435072 | 0;
var HIGH_MIN_NORMAL_EXP4 = 1048576 | 0;
var HIGH_BIASED_EXP_04 = 1072693248 | 0;
var WORDS4 = [0 | 0, 0 | 0];
function log2(x) {
  var valHi;
  var valLo;
  var hfsq;
  var hx;
  var lx;
  var hi;
  var lo;
  var f2;
  var R;
  var w;
  var y;
  var i;
  var k;
  if (lib_default(x) || x < 0) {
    return NaN;
  }
  lib_default30.assign(x, WORDS4, 1, 0);
  hx = WORDS4[0] | 0;
  lx = WORDS4[1];
  k = 0 | 0;
  if (hx < HIGH_MIN_NORMAL_EXP4) {
    if ((hx & lib_default33 | lx) === 0) {
      return lib_default11;
    }
    k -= 54 | 0;
    x *= TWO542;
    hx = lib_default8(x) | 0;
  }
  if (hx >= HIGH_MAX_NORMAL_EXP2) {
    return x + x;
  }
  if (hx === HIGH_BIASED_EXP_04 && lx === 0) {
    return 0;
  }
  k += (hx >> 20) - lib_default10 | 0;
  hx &= lib_default46;
  i = hx + 614244 & HIGH_MIN_NORMAL_EXP4 | 0;
  x = lib_default9(x, hx | i ^ HIGH_BIASED_EXP_04);
  k += i >> 20 | 0;
  y = k;
  f2 = x - 1;
  hfsq = 0.5 * f2 * f2;
  R = lib_default304(f2);
  hi = f2 - hfsq;
  hi = lib_default31(hi, 0);
  lo = f2 - hi - hfsq + R;
  valHi = hi * IVLN2HI;
  valLo = (lo + hi) * IVLN2LO + lo * IVLN2HI;
  w = y + valHi;
  valLo += y - w + valHi;
  valHi = w;
  return valLo + valHi;
}
var main_default266 = log2;

var lib_default305 = main_default266;

function median12(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return lib_default66(-1 / lib_default305(1 - p101)) - 1;
}
var main_default267 = median12;

var lib_default306 = main_default267;

function isProbability(x) {
  return x >= 0 && x <= 1;
}
var main_default268 = isProbability;

var lib_default307 = main_default268;

function mgf10(t, p101) {
  var et;
  var q;
  if (lib_default(t) || !lib_default307(p101)) {
    return NaN;
  }
  q = 1 - p101;
  if (t >= -lib_default12(q)) {
    return NaN;
  }
  et = lib_default68(t);
  return p101 * et / (1 - q * et);
}
var main_default269 = mgf10;

function factory79(p101) {
  if (!lib_default307(p101)) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    var et;
    var q;
    if (lib_default(t)) {
      return NaN;
    }
    q = 1 - p101;
    if (t >= -lib_default12(q)) {
      return NaN;
    }
    et = lib_default68(t);
    return p101 * et / (1 - q * et);
  }
}
var factory_default79 = factory79;

main_default269.factory = factory_default79;
var lib_default308 = main_default269;

function mode16(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return 0;
}
var main_default270 = mode16;

var lib_default309 = main_default270;

function pmf3(x, p101) {
  var q;
  if (lib_default(x) || lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (lib_default243(x)) {
    q = 1 - p101;
    return p101 * lib_default47(q, x);
  }
  return 0;
}
var main_default271 = pmf3;

function factory80(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return pmf8;
  function pmf8(x) {
    var q;
    if (lib_default(x)) {
      return NaN;
    }
    if (lib_default243(x)) {
      q = 1 - p101;
      return p101 * lib_default47(q, x);
    }
    return 0;
  }
}
var factory_default80 = factory80;

main_default271.factory = factory_default80;
var lib_default310 = main_default271;

function quantile16(r, p101) {
  if (lib_default(p101) || lib_default(r) || p101 < 0 || p101 > 1 || r < 0 || r > 1) {
    return NaN;
  }
  if (r === 1) {
    return lib_default27;
  }
  return lib_default83(0, lib_default66(lib_default12(1 - r) / lib_default78(-p101) - (1 + 1e-12)));
}
var main_default272 = quantile16;

function factory81(p101) {
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(r) {
    if (lib_default(r) || r < 0 || r > 1) {
      return NaN;
    }
    if (r === 1) {
      return lib_default27;
    }
    return lib_default83(0, lib_default66(lib_default12(1 - r) / lib_default78(-p101) - (1 + 1e-12)));
  }
}
var factory_default81 = factory81;

main_default272.factory = factory_default81;
var lib_default311 = main_default272;

function skewness13(p101) {
  if (lib_default(p101) || p101 <= 0 || p101 >= 1) {
    return NaN;
  }
  return (2 - p101) / lib_default2(1 - p101);
}
var main_default273 = skewness13;

var lib_default312 = main_default273;

function stdev15(p101) {
  if (lib_default(p101) || p101 <= 0 || p101 >= 1) {
    return NaN;
  }
  return lib_default2(1 - p101) / p101;
}
var main_default274 = stdev15;

var lib_default313 = main_default274;

function variance15(p101) {
  if (lib_default(p101) || p101 <= 0 || p101 >= 1) {
    return NaN;
  }
  return (1 - p101) / (p101 * p101);
}
var main_default275 = variance15;

var lib_default314 = main_default275;

function cdf17(x, mu, beta2) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  z = (x - mu) / beta2;
  return lib_default68(-lib_default68(-z));
}
var main_default276 = cdf17;

function factory82(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    z = (x - mu) / beta2;
    return lib_default68(-lib_default68(-z));
  }
}
var factory_default82 = factory82;

main_default276.factory = factory_default82;
var lib_default315 = main_default276;

function entropy16(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return lib_default12(beta2) + lib_default89 + 1;
}
var main_default277 = entropy16;

var lib_default316 = main_default277;

function kurtosis13(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return 2.4;
}
var main_default278 = kurtosis13;

var lib_default317 = main_default278;

function logcdf11(x, mu, beta2) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  z = (x - mu) / beta2;
  return -lib_default68(-z);
}
var main_default279 = logcdf11;

function factory83(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    z = (x - mu) / beta2;
    return -lib_default68(-z);
  }
}
var factory_default83 = factory83;

main_default279.factory = factory_default83;
var lib_default318 = main_default279;

function logpdf13(x, mu, beta2) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  if (x === lib_default11) {
    return 0;
  }
  z = (x - mu) / beta2;
  return -z - lib_default68(-z) - lib_default12(beta2);
}
var main_default280 = logpdf13;

function factory84(mu, beta2) {
  var lbeta;
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return lib_default6(NaN);
  }
  lbeta = lib_default12(beta2);
  return logpdf27;
  function logpdf27(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x === lib_default11) {
      return 0;
    }
    z = (x - mu) / beta2;
    return -z - lib_default68(-z) - lbeta;
  }
}
var factory_default84 = factory84;

main_default280.factory = factory_default84;
var lib_default319 = main_default280;

function mean17(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return mu + beta2 * lib_default89;
}
var main_default281 = mean17;

var lib_default320 = main_default281;

var LLN2 = lib_default12(lib_default16);
function median13(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return mu - beta2 * LLN2;
}
var main_default282 = median13;

var lib_default321 = main_default282;

function mgf11(t, mu, beta2) {
  if (lib_default(t) || lib_default(mu) || lib_default(beta2) || beta2 <= 0 || t >= 1 / beta2) {
    return NaN;
  }
  return lib_default90(1 - beta2 * t) * lib_default68(mu * t);
}
var main_default283 = mgf11;

function factory85(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (t >= 1 / beta2) {
      return NaN;
    }
    return lib_default90(1 - beta2 * t) * lib_default68(mu * t);
  }
}
var factory_default85 = factory85;

main_default283.factory = factory_default85;
var lib_default322 = main_default283;

function mode17(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return mu;
}
var main_default284 = mode17;

var lib_default323 = main_default284;

function pdf15(x, mu, beta2) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  if (x === lib_default11) {
    return 0;
  }
  z = (x - mu) / beta2;
  return 1 / beta2 * lib_default68(-z - lib_default68(-z));
}
var main_default285 = pdf15;

function factory86(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return pdf30;
  function pdf30(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x === lib_default11) {
      return 0;
    }
    z = (x - mu) / beta2;
    return 1 / beta2 * lib_default68(-z - lib_default68(-z));
  }
}
var factory_default86 = factory86;

main_default285.factory = factory_default86;
var lib_default324 = main_default285;

function quantile17(p101, mu, beta2) {
  if (lib_default(p101) || lib_default(mu) || lib_default(beta2) || beta2 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return mu - beta2 * lib_default12(-lib_default12(p101));
}
var main_default286 = quantile17;

function factory87(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return mu - beta2 * lib_default12(-lib_default12(p101));
  }
}
var factory_default87 = factory87;

main_default286.factory = factory_default87;
var lib_default325 = main_default286;

var SKEWNESS = 1.1395470994046488;
function skewness14(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return SKEWNESS;
}
var main_default287 = skewness14;

var lib_default326 = main_default287;

var PI_OVER_SQRT6 = 1.282549830161864;
function stdev16(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return PI_OVER_SQRT6 * beta2;
}
var main_default288 = stdev16;

var lib_default327 = main_default288;

function variance16(mu, beta2) {
  if (lib_default(mu) || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return lib_default220 / 6 * beta2 * beta2;
}
var main_default289 = variance16;

var lib_default328 = main_default289;

var SCALAR3 = 0.7257913526447274;
function entropy17(sigma) {
  if (lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return lib_default12(sigma) + SCALAR3;
}
var main_default290 = entropy17;

var lib_default329 = main_default290;

var KURTOSIS = 0.8691773036059736;
function kurtosis14(sigma) {
  if (lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return KURTOSIS;
}
var main_default291 = kurtosis14;

var lib_default330 = main_default291;

var C2 = 0.5 * (lib_default16 - lib_default15);
function logpdf14(x, sigma) {
  if (lib_default(x) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  if (x < 0) {
    return lib_default11;
  }
  return C2 - lib_default12(sigma) - x * x / (2 * (sigma * sigma));
}
var main_default292 = logpdf14;

var C3 = 0.5 * (lib_default16 - lib_default15);
function factory88(sigma) {
  var lsigma;
  var sigma2;
  if (lib_default(sigma) || sigma <= 0) {
    return lib_default6(NaN);
  }
  lsigma = lib_default12(sigma);
  sigma2 = sigma * sigma;
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return lib_default11;
    }
    return C3 - lsigma - x * x / (2 * sigma2);
  }
}
var factory_default88 = factory88;

main_default292.factory = factory_default88;
var lib_default331 = main_default292;

var SQRT_TWO_OVER_PI = lib_default2(2 / lib_default5);
function mean18(sigma) {
  if (lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return sigma * SQRT_TWO_OVER_PI;
}
var main_default293 = mean18;

var lib_default332 = main_default293;

function mode18(sigma) {
  if (lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return 0;
}
var main_default294 = mode18;

var lib_default333 = main_default294;

var SQRT1M2PI = lib_default2(1 - 2 / lib_default5);
function stdev17(sigma) {
  if (lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return sigma * SQRT1M2PI;
}
var main_default295 = stdev17;

var lib_default334 = main_default295;

function isNegativeInteger(x) {
  return lib_default23(x) === x && x < 0;
}
var main_default296 = isNegativeInteger;

var lib_default335 = main_default296;

function factorialln(x) {
  if (lib_default335(x)) {
    return NaN;
  }
  return lib_default98(x + 1);
}
var main_default297 = factorialln;

var lib_default336 = main_default297;

function pmf4(x, N, K, n) {
  var ldenom;
  var lnum;
  var lpmf;
  var maxs;
  var mins;
  if (lib_default(x) || lib_default(N) || lib_default(K) || lib_default(n) || !lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return NaN;
  }
  mins = lib_default83(0, n + K - N);
  maxs = lib_default85(K, n);
  if (lib_default243(x) && mins <= x && x <= maxs) {
    lnum = lib_default336(n) + lib_default336(K) + lib_default336(N - n) + lib_default336(N - K);
    ldenom = lib_default336(N) + lib_default336(x) + lib_default336(n - x);
    ldenom += lib_default336(K - x) + lib_default336(N - K + x - n);
    lpmf = lnum - ldenom;
    return lib_default68(lpmf);
  }
  return 0;
}
var main_default298 = pmf4;

function factory89(N, K, n) {
  var maxs;
  var mins;
  if (lib_default(N) || lib_default(K) || lib_default(n) || !lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return lib_default6(NaN);
  }
  mins = lib_default83(0, n + K - N);
  maxs = lib_default85(K, n);
  return pmf8;
  function pmf8(x) {
    var ldenom;
    var lnum;
    var lpmf;
    if (lib_default(x)) {
      return NaN;
    }
    if (lib_default243(x) && mins <= x && x <= maxs) {
      lnum = lib_default336(n) + lib_default336(K) + lib_default336(N - n) + lib_default336(N - K);
      ldenom = lib_default336(N) + lib_default336(x) + lib_default336(n - x);
      ldenom += lib_default336(K - x) + lib_default336(N - K + x - n);
      lpmf = lnum - ldenom;
      return lib_default68(lpmf);
    }
    return 0;
  }
}
var factory_default89 = factory89;

main_default298.factory = factory_default89;
var lib_default337 = main_default298;

function sum(arr) {
  var len;
  var s;
  var i;
  len = arr.length;
  s = 0;
  for (i = 0; i < len; i++) {
    s += arr[i];
  }
  return s;
}
var sum_default = sum;

function cdf18(x, N, K, n) {
  var denom;
  var probs;
  var num;
  var ret;
  var i;
  if (lib_default(x) || lib_default(N) || lib_default(K) || lib_default(n) || !lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return NaN;
  }
  x = lib_default67(x);
  if (x < lib_default83(0, n + K - N)) {
    return 0;
  }
  if (x >= lib_default85(n, K)) {
    return 1;
  }
  probs = new Float64Array(x + 1);
  probs[x] = lib_default337(x, N, K, n);
  for (i = x - 1; i >= 0; i--) {
    num = (i + 1) * (N - K - (n - i - 1));
    denom = (K - i) * (n - i);
    probs[i] = num / denom * probs[i + 1];
  }
  ret = sum_default(probs);
  return lib_default85(ret, 1);
}
var main_default299 = cdf18;

function factory90(N, K, n) {
  if (lib_default(N) || lib_default(K) || lib_default(n) || !lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    var denom;
    var probs;
    var num;
    var ret;
    var i;
    if (lib_default(x)) {
      return NaN;
    }
    x = lib_default67(x);
    if (x < lib_default83(0, n + K - N)) {
      return 0;
    }
    if (x >= lib_default85(n, K)) {
      return 1;
    }
    probs = new Float64Array(x + 1);
    probs[x] = lib_default337(x, N, K, n);
    for (i = x - 1; i >= 0; i--) {
      num = (i + 1) * (N - K - (n - i - 1));
      denom = (K - i) * (n - i);
      probs[i] = num / denom * probs[i + 1];
    }
    ret = sum_default(probs);
    return lib_default85(ret, 1);
  }
}
var factory_default90 = factory90;

main_default299.factory = factory_default90;
var lib_default338 = main_default299;

function kurtosis15(N, K, n) {
  var p101;
  var q;
  if (!lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return NaN;
  }
  p101 = (N - 1) * (N * N) * (N * (N + 1) - 6 * K * (N - K) - 6 * n * (N - n));
  p101 += 6 * n * K * (N - K) * (N - n) * (5 * N - 6);
  q = n * K * (N - K) * (N - n) * (N - 2) * (N - 3);
  return p101 / q;
}
var main_default300 = kurtosis15;

var lib_default339 = main_default300;

function mean19(N, K, n) {
  if (!lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return NaN;
  }
  return n * (K / N);
}
var main_default301 = mean19;

var lib_default340 = main_default301;

function mode19(N, K, n) {
  if (!lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return NaN;
  }
  return lib_default23((n + 1) * (K + 1) / (N + 2));
}
var main_default302 = mode19;

var lib_default341 = main_default302;

function quantile18(p101, N, K, n) {
  var prob;
  var x;
  if (lib_default(p101) || lib_default(N) || lib_default(K) || lib_default(n) || !lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (p101 === 0) {
    return lib_default83(0, n + K - N);
  }
  if (p101 === 1) {
    return lib_default85(n, K);
  }
  x = lib_default83(0, n + K - N);
  while (true) {
    prob = lib_default338(x, N, K, n);
    if (prob > p101) {
      break;
    }
    x += 1;
  }
  return x;
}
var main_default303 = quantile18;

function factory91(N, K, n) {
  if (lib_default(N) || lib_default(K) || lib_default(n) || !lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    var prob;
    var x;
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    if (p101 === 0) {
      return lib_default83(0, n + K - N);
    }
    if (p101 === 1) {
      return lib_default85(n, K);
    }
    x = lib_default83(0, n + K - N);
    while (true) {
      prob = lib_default338(x, N, K, n);
      if (prob > p101) {
        break;
      }
      x += 1;
    }
    return x;
  }
}
var factory_default91 = factory91;

main_default303.factory = factory_default91;
var lib_default342 = main_default303;

function skewness15(N, K, n) {
  var p101;
  var q;
  if (!lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return NaN;
  }
  p101 = (N - 2 * K) * lib_default2(N - 1) * (N - 2 * n);
  q = lib_default2(n * K * (N - K) * (N - n)) * (N - 2);
  return p101 / q;
}
var main_default304 = skewness15;

var lib_default343 = main_default304;

function variance17(N, K, n) {
  if (!lib_default243(N) || !lib_default243(K) || !lib_default243(n) || N === lib_default27 || K === lib_default27 || K > N || n > N) {
    return NaN;
  }
  return n * (K / N) * ((N - K) / N) * ((N - n) / (N - 1));
}
var main_default305 = variance17;

var lib_default344 = main_default305;

function stdev18(N, K, n) {
  return lib_default2(lib_default344(N, K, n));
}
var main_default306 = stdev18;

var lib_default345 = main_default306;

function cdf19(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return 0;
  }
  return lib_default113(beta2 / x, alpha, true, true);
}
var main_default307 = cdf19;

function factory92(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return 0;
    }
    return lib_default113(beta2 / x, alpha, true, true);
  }
}
var factory_default92 = factory92;

main_default307.factory = factory_default92;
var lib_default346 = main_default307;

function entropy18(alpha, beta2) {
  var out;
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  out = alpha + lib_default12(beta2 * lib_default90(alpha));
  out -= (1 + alpha) * lib_default124(alpha);
  return out;
}
var main_default308 = entropy18;

var lib_default347 = main_default308;

function kurtosis16(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 4 || beta2 <= 0) {
    return NaN;
  }
  return (30 * alpha - 66) / ((alpha - 3) * (alpha - 4));
}
var main_default309 = kurtosis16;

var lib_default348 = main_default309;

function logpdf15(x, alpha, beta2) {
  var out;
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return lib_default11;
  }
  out = alpha * lib_default12(beta2) - lib_default98(alpha);
  out -= (alpha + 1) * lib_default12(x);
  out -= beta2 / x;
  return out;
}
var main_default310 = logpdf15;

function factory93(alpha, beta2) {
  var firstTerm;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  firstTerm = alpha * lib_default12(beta2) - lib_default98(alpha);
  return logpdf27;
  function logpdf27(x) {
    var out;
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return lib_default11;
    }
    out = firstTerm - (alpha + 1) * lib_default12(x) - beta2 / x;
    return out;
  }
}
var factory_default93 = factory93;

main_default310.factory = factory_default93;
var lib_default349 = main_default310;

function mean20(alpha, beta2) {
  if (alpha <= 1 || beta2 <= 0) {
    return NaN;
  }
  return beta2 / (alpha - 1);
}
var main_default311 = mean20;

var lib_default350 = main_default311;

function mode20(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return beta2 / (alpha + 1);
}
var main_default312 = mode20;

var lib_default351 = main_default312;

function pdf16(x, alpha, beta2) {
  var lnl;
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return 0;
  }
  lnl = alpha * lib_default12(beta2) - lib_default98(alpha);
  lnl -= (alpha + 1) * lib_default12(x);
  lnl -= beta2 / x;
  return lib_default68(lnl);
}
var main_default313 = pdf16;

function factory94(alpha, beta2) {
  var firstTerm;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  firstTerm = alpha * lib_default12(beta2) - lib_default98(alpha);
  return pdf30;
  function pdf30(x) {
    var lnl;
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return 0;
    }
    lnl = firstTerm - (alpha + 1) * lib_default12(x) - beta2 / x;
    return lib_default68(lnl);
  }
}
var factory_default94 = factory94;

main_default313.factory = factory_default94;
var lib_default352 = main_default313;

function quantile19(p101, alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || lib_default(p101) || alpha <= 0 || beta2 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return beta2 / lib_default137(p101, alpha, true);
}
var main_default314 = quantile19;

function factory95(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return beta2 / lib_default137(p101, alpha, true);
  }
}
var factory_default95 = factory95;

main_default314.factory = factory_default95;
var lib_default353 = main_default314;

function skewness16(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 3 || beta2 <= 0) {
    return NaN;
  }
  return 4 * lib_default2(alpha - 2) / (alpha - 3);
}
var main_default315 = skewness16;

var lib_default354 = main_default315;

function stdev19(alpha, beta2) {
  if (alpha <= 2 || beta2 <= 0) {
    return NaN;
  }
  return beta2 / ((alpha - 1) * lib_default2(alpha - 2));
}
var main_default316 = stdev19;

var lib_default355 = main_default316;

function variance18(alpha, beta2) {
  if (alpha <= 2 || beta2 <= 0) {
    return NaN;
  }
  return beta2 * beta2 / (lib_default47(alpha - 1, 2) * (alpha - 2));
}
var main_default317 = variance18;

var lib_default356 = main_default317;

function cdf20(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a <= 0 || b <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return 1 - lib_default47(1 - lib_default47(x, a), b);
}
var main_default318 = cdf20;

function factory96(a, b) {
  if (lib_default(a) || lib_default(b) || a <= 0 || b <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return 0;
    }
    if (x >= 1) {
      return 1;
    }
    return 1 - lib_default47(1 - lib_default47(x, a), b);
  }
}
var factory_default96 = factory96;

main_default318.factory = factory_default96;
var lib_default357 = main_default318;

function kurtosis17(a, b) {
  var sigma2;
  var out;
  var mu2;
  var m1;
  var m2;
  var m3;
  var m4;
  if (lib_default(a) || a <= 0 || lib_default(b) || b <= 0) {
    return NaN;
  }
  m1 = b * lib_default81(1 + 1 / a, b);
  m2 = b * lib_default81(1 + 2 / a, b);
  m3 = b * lib_default81(1 + 3 / a, b);
  m4 = b * lib_default81(1 + 4 / a, b);
  sigma2 = m2 - m1 * m1;
  mu2 = m1 * m1;
  out = m4 - 4 * m3 * m1 + 6 * m2 * mu2 - 3 * mu2 * mu2;
  out /= sigma2 * sigma2;
  return out;
}
var main_default319 = kurtosis17;

var lib_default358 = main_default319;

function logcdf12(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a <= 0 || b <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return lib_default11;
  }
  if (x >= 1) {
    return 0;
  }
  return lib_default12(1 - lib_default47(1 - lib_default47(x, a), b));
}
var main_default320 = logcdf12;

function factory97(a, b) {
  if (lib_default(a) || lib_default(b) || a <= 0 || b <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return lib_default11;
    }
    if (x >= 1) {
      return 0;
    }
    return lib_default12(1 - lib_default47(1 - lib_default47(x, a), b));
  }
}
var factory_default97 = factory97;

main_default320.factory = factory_default97;
var lib_default359 = main_default320;

function logpdf16(x, a, b) {
  var out;
  if (lib_default(x) || lib_default(a) || lib_default(b) || a <= 0 || b <= 0) {
    return NaN;
  }
  if (x <= 0 || x >= 1) {
    return lib_default11;
  }
  out = lib_default12(a * b);
  out += (a - 1) * lib_default12(x);
  out += (b - 1) * lib_default12(1 - lib_default47(x, a));
  return out;
}
var main_default321 = logpdf16;

function factory98(a, b) {
  if (lib_default(a) || lib_default(b) || a <= 0 || b <= 0) {
    return lib_default6(NaN);
  }
  return logpdf27;
  function logpdf27(x) {
    var out;
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0 || x >= 1) {
      return lib_default11;
    }
    out = lib_default12(a * b);
    out += (a - 1) * lib_default12(x);
    out += (b - 1) * lib_default12(1 - lib_default47(x, a));
    return out;
  }
}
var factory_default98 = factory98;

main_default321.factory = factory_default98;
var lib_default360 = main_default321;

function mean21(a, b) {
  if (lib_default(a) || a <= 0 || lib_default(b) || b <= 0) {
    return NaN;
  }
  return b * lib_default81(1 + 1 / a, b);
}
var main_default322 = mean21;

var lib_default361 = main_default322;

function median14(a, b) {
  if (lib_default(a) || a <= 0 || lib_default(b) || b <= 0) {
    return NaN;
  }
  return lib_default47(1 - lib_default47(2, -1 / b), 1 / a);
}
var main_default323 = median14;

var lib_default362 = main_default323;

function mode21(a, b) {
  if (lib_default(a) || a < 1 || lib_default(b) || b < 1 || a === 1 && b === 1) {
    return NaN;
  }
  return lib_default47((a - 1) / (a * b - 1), 1 / a);
}
var main_default324 = mode21;

var lib_default363 = main_default324;

function pdf17(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a <= 0 || b <= 0) {
    return NaN;
  }
  if (x <= 0 || x >= 1) {
    return 0;
  }
  return a * b * lib_default47(x, a - 1) * lib_default47(1 - lib_default47(x, a), b - 1);
}
var main_default325 = pdf17;

function factory99(a, b) {
  if (lib_default(a) || lib_default(b) || a <= 0 || b <= 0) {
    return lib_default6(NaN);
  }
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0 || x >= 1) {
      return 0;
    }
    return a * b * lib_default47(x, a - 1) * lib_default47(1 - lib_default47(x, a), b - 1);
  }
}
var factory_default99 = factory99;

main_default325.factory = factory_default99;
var lib_default364 = main_default325;

function quantile20(p101, a, b) {
  if (lib_default(p101) || lib_default(a) || lib_default(b) || a <= 0 || b <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return lib_default47(1 - lib_default47(1 - p101, 1 / b), 1 / a);
}
var main_default326 = quantile20;

function factory100(a, b) {
  if (lib_default(a) || lib_default(b) || a <= 0 || b <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return lib_default47(1 - lib_default47(1 - p101, 1 / b), 1 / a);
  }
}
var factory_default100 = factory100;

main_default326.factory = factory_default100;
var lib_default365 = main_default326;

function skewness17(a, b) {
  var sigma2;
  var m1;
  var m2;
  var m3;
  if (lib_default(a) || a <= 0 || lib_default(b) || b <= 0) {
    return NaN;
  }
  m1 = b * lib_default81(1 + 1 / a, b);
  m2 = b * lib_default81(1 + 2 / a, b);
  m3 = b * lib_default81(1 + 3 / a, b);
  sigma2 = m2 - m1 * m1;
  return (m3 - 3 * m1 * sigma2 - m1 * m1 * m1) / lib_default47(sigma2, 1.5);
}
var main_default327 = skewness17;

var lib_default366 = main_default327;

function variance19(a, b) {
  var m1;
  var m2;
  if (lib_default(a) || a <= 0 || lib_default(b) || b <= 0) {
    return NaN;
  }
  m1 = b * lib_default81(1 + 1 / a, b);
  m2 = b * lib_default81(1 + 2 / a, b);
  return m2 - m1 * m1;
}
var main_default328 = variance19;

var lib_default367 = main_default328;

function stdev20(a, b) {
  return lib_default2(lib_default367(a, b));
}
var main_default329 = stdev20;

var lib_default368 = main_default329;

function cdf21(x, mu, b) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  z = (x - mu) / b;
  if (x < mu) {
    return 0.5 * lib_default68(z);
  }
  return 1 - 0.5 * lib_default68(-z);
}
var main_default330 = cdf21;

function factory101(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    z = (x - mu) / b;
    if (x < mu) {
      return 0.5 * lib_default68(z);
    }
    return 1 - 0.5 * lib_default68(-z);
  }
}
var factory_default101 = factory101;

main_default330.factory = factory_default101;
var lib_default369 = main_default330;

function entropy19(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  return lib_default12(2 * b * lib_default79);
}
var main_default331 = entropy19;

var lib_default370 = main_default331;

function kurtosis18(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  return 3;
}
var main_default332 = kurtosis18;

var lib_default371 = main_default332;

var LN_HALF = -0.6931471805599453;
var lib_default372 = LN_HALF;

function logcdf13(x, mu, b) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  z = (x - mu) / b;
  if (x < mu) {
    return lib_default372 + z;
  }
  return lib_default372 + lib_default78(-lib_default77(-z));
}
var main_default333 = logcdf13;

function factory102(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    z = (x - mu) / b;
    if (x < mu) {
      return lib_default372 + z;
    }
    return lib_default372 + lib_default78(-lib_default77(-z));
  }
}
var factory_default102 = factory102;

main_default333.factory = factory_default102;
var lib_default373 = main_default333;

function logpdf17(x, mu, b) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  z = (x - mu) / b;
  return -(lib_default29(z) + lib_default12(2 * b));
}
var main_default334 = logpdf17;

function factory103(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return lib_default6(NaN);
  }
  return logpdf27;
  function logpdf27(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    z = (x - mu) / b;
    return -(lib_default29(z) + lib_default12(2 * b));
  }
}
var factory_default103 = factory103;

main_default334.factory = factory_default103;
var lib_default374 = main_default334;

function mean22(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  return mu;
}
var main_default335 = mean22;

var lib_default375 = main_default335;

function median15(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  return mu;
}
var main_default336 = median15;

var lib_default376 = main_default336;

function mgf12(t, mu, b) {
  var bt;
  if (lib_default(t) || lib_default(mu) || lib_default(b) || b <= 0 || lib_default29(t) >= 1 / b) {
    return NaN;
  }
  bt = b * t;
  return lib_default68(mu * t) / (1 - lib_default47(bt, 2));
}
var main_default337 = mgf12;

function factory104(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    var bt;
    if (lib_default29(t) >= 1 / b) {
      return NaN;
    }
    bt = b * t;
    return lib_default68(mu * t) / (1 - lib_default47(bt, 2));
  }
}
var factory_default104 = factory104;

main_default337.factory = factory_default104;
var lib_default377 = main_default337;

function mode22(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  return mu;
}
var main_default338 = mode22;

var lib_default378 = main_default338;

function pdf18(x, mu, b) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  z = (x - mu) / b;
  return 0.5 * lib_default68(-lib_default29(z)) / b;
}
var main_default339 = pdf18;

function factory105(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return lib_default6(NaN);
  }
  return pdf30;
  function pdf30(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    z = (x - mu) / b;
    return 0.5 * lib_default68(-lib_default29(z)) / b;
  }
}
var factory_default105 = factory105;

main_default339.factory = factory_default105;
var lib_default379 = main_default339;

function quantile21(p101, mu, b) {
  if (lib_default(mu) || lib_default(b) || lib_default(p101) || b <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return mu - b * lib_default135(p101 - 0.5) * lib_default12(1 - 2 * lib_default29(p101 - 0.5));
}
var main_default340 = quantile21;

function factory106(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return mu - b * lib_default135(p101 - 0.5) * lib_default12(1 - 2 * lib_default29(p101 - 0.5));
  }
}
var factory_default106 = factory106;

main_default340.factory = factory_default106;
var lib_default380 = main_default340;

function skewness18(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  return 0;
}
var main_default341 = skewness18;

var lib_default381 = main_default341;

function stdev21(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  return lib_default134 * b;
}
var main_default342 = stdev21;

var lib_default382 = main_default342;

function variance20(mu, b) {
  if (lib_default(mu) || lib_default(b) || b <= 0) {
    return NaN;
  }
  return 2 * b * b;
}
var main_default343 = variance20;

var lib_default383 = main_default343;

function cdf22(x, mu, c2) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  if (x < mu) {
    return 0;
  }
  z = lib_default2(c2 / (2 * (x - mu)));
  return lib_default102(z);
}
var main_default344 = cdf22;

function factory107(mu, c2) {
  if (lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < mu) {
      return 0;
    }
    z = lib_default2(c2 / (2 * (x - mu)));
    return lib_default102(z);
  }
}
var factory_default107 = factory107;

main_default344.factory = factory_default107;
var lib_default384 = main_default344;

var ONE_PLUS_THREE_GAMMA = 1 + 3 * lib_default89;
var PI_TIMES_SIXTEEN = 16 * lib_default5;
function entropy20(mu, c2) {
  if (lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  return (ONE_PLUS_THREE_GAMMA + lib_default12(c2 * c2 * PI_TIMES_SIXTEEN)) / 2;
}
var main_default345 = entropy20;

var lib_default385 = main_default345;

function logcdf14(x, mu, c2) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  if (x < mu) {
    return lib_default11;
  }
  z = lib_default2(c2 / (2 * (x - mu)));
  return lib_default12(lib_default102(z));
}
var main_default346 = logcdf14;

function factory108(mu, c2) {
  if (lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < mu) {
      return lib_default11;
    }
    z = lib_default2(c2 / (2 * (x - mu)));
    return lib_default12(lib_default102(z));
  }
}
var factory_default108 = factory108;

main_default346.factory = factory_default108;
var lib_default386 = main_default346;

var LN_TWO_PI = 1.8378770664093456;
var lib_default387 = LN_TWO_PI;

function logpdf18(x, mu, c2) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  if (x <= mu) {
    return lib_default11;
  }
  z = x - mu;
  return 0.5 * (lib_default12(c2) - lib_default387 - c2 / z - 3 * lib_default12(z));
}
var main_default347 = logpdf18;

function factory109(mu, c2) {
  if (lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return lib_default6(NaN);
  }
  return logpdf27;
  function logpdf27(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= mu) {
      return lib_default11;
    }
    z = x - mu;
    return 0.5 * (lib_default12(c2) - lib_default387 - c2 / z - 3 * lib_default12(z));
  }
}
var factory_default109 = factory109;

main_default347.factory = factory_default109;
var lib_default388 = main_default347;

var DENOM = 2 * lib_default47(lib_default132(0.5), 2);
function median16(mu, c2) {
  if (lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  return mu + c2 / DENOM;
}
var main_default348 = median16;

var lib_default389 = main_default348;

function mode23(mu, c2) {
  if (lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  return mu + c2 / 3;
}
var main_default349 = mode23;

var lib_default390 = main_default349;

function pdf19(x, mu, c2) {
  if (lib_default(x) || lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return NaN;
  }
  if (x <= mu) {
    return 0;
  }
  return lib_default2(c2 / lib_default107) * lib_default68(-c2 / (2 * (x - mu))) / lib_default47(x - mu, 1.5);
}
var main_default350 = pdf19;

function factory110(mu, c2) {
  if (lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return lib_default6(NaN);
  }
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= mu) {
      return 0;
    }
    return lib_default2(c2 / lib_default107) * lib_default68(-c2 / (2 * (x - mu))) / lib_default47(x - mu, 1.5);
  }
}
var factory_default110 = factory110;

main_default350.factory = factory_default110;
var lib_default391 = main_default350;

function quantile22(p101, mu, c2) {
  var fval;
  if (lib_default(mu) || lib_default(c2) || lib_default(p101) || c2 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  fval = lib_default132(p101);
  return mu + c2 / (2 * fval * fval);
}
var main_default351 = quantile22;

function factory111(mu, c2) {
  if (lib_default(mu) || lib_default(c2) || c2 <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    var fval;
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    fval = lib_default132(p101);
    return mu + c2 / (2 * fval * fval);
  }
}
var factory_default111 = factory111;

main_default351.factory = factory_default111;
var lib_default392 = main_default351;

function cdf23(x, mu, s) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(s) || s < 0) {
    return NaN;
  }
  if (s === 0) {
    return x < mu ? 0 : 1;
  }
  z = (x - mu) / s;
  return 1 / (1 + lib_default68(-z));
}
var main_default352 = cdf23;

var degenerate14 = lib_default179.factory;
function factory112(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate14(mu);
  }
  return cdf35;
  function cdf35(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    z = (x - mu) / s;
    return 1 / (1 + lib_default68(-z));
  }
}
var factory_default112 = factory112;

main_default352.factory = factory_default112;
var lib_default393 = main_default352;

function entropy21(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return lib_default12(s) + 2;
}
var main_default353 = entropy21;

var lib_default394 = main_default353;

function kurtosis19(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return 1.2;
}
var main_default354 = kurtosis19;

var lib_default395 = main_default354;

function log1pexp(x) {
  if (x <= 18) {
    return lib_default78(lib_default68(x));
  }
  if (x > 33.3) {
    return x;
  }
  return x + lib_default68(-x);
}
var log1pexp_default = log1pexp;

function logcdf15(x, mu, s) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(s) || s < 0) {
    return NaN;
  }
  if (s === 0) {
    return x < mu ? lib_default11 : 0;
  }
  z = (x - mu) / s;
  return -log1pexp_default(-z);
}
var main_default355 = logcdf15;

var degenerate15 = lib_default213.factory;
function factory113(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate15(mu);
  }
  return logcdf24;
  function logcdf24(x) {
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    z = (x - mu) / s;
    return -log1pexp_default(-z);
  }
}
var factory_default113 = factory113;

main_default355.factory = factory_default113;
var lib_default396 = main_default355;

function logpdf19(x, mu, s) {
  var az;
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(s) || s < 0) {
    return NaN;
  }
  if (x === lib_default11) {
    return lib_default11;
  }
  if (s === 0) {
    return x === mu ? lib_default27 : lib_default11;
  }
  z = (x - mu) / s;
  az = -lib_default29(z);
  return az - 2 * lib_default78(lib_default68(az)) - lib_default12(s);
}
var main_default356 = logpdf19;

var degenerate16 = lib_default187.factory;
function factory114(mu, s) {
  var ls;
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate16(mu);
  }
  ls = lib_default12(s);
  return logpdf27;
  function logpdf27(x) {
    var az;
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x === lib_default11) {
      return lib_default11;
    }
    z = (x - mu) / s;
    az = -lib_default29(z);
    return az - 2 * lib_default78(lib_default68(az)) - ls;
  }
}
var factory_default114 = factory114;

main_default356.factory = factory_default114;
var lib_default397 = main_default356;

function mean23(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return mu;
}
var main_default357 = mean23;

var lib_default398 = main_default357;

function median17(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return mu;
}
var main_default358 = median17;

var lib_default399 = main_default358;

function sinc(x) {
  if (lib_default(x)) {
    return NaN;
  }
  if (lib_default28(x)) {
    return 0;
  }
  if (x === 0) {
    return 1;
  }
  return lib_default97(x) / (lib_default5 * x);
}
var main_default359 = sinc;

var lib_default400 = main_default359;

function mgf13(t, mu, s) {
  var st;
  st = s * t;
  if (lib_default(st) || lib_default(mu) || s < 0 || lib_default29(st) > 1) {
    return NaN;
  }
  return lib_default68(mu * t) / lib_default400(st);
}
var main_default360 = mgf13;

var degenerate17 = lib_default231.factory;
function factory115(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate17(mu);
  }
  return mgf21;
  function mgf21(t) {
    var st = s * t;
    if (lib_default29(st) > 1) {
      return NaN;
    }
    return lib_default68(mu * t) / lib_default400(st);
  }
}
var factory_default115 = factory115;

main_default360.factory = factory_default115;
var lib_default401 = main_default360;

function mode24(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return mu;
}
var main_default361 = mode24;

var lib_default402 = main_default361;

function pdf20(x, mu, s) {
  var ez;
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(s) || s < 0) {
    return NaN;
  }
  if (x === lib_default11) {
    return 0;
  }
  if (s === 0) {
    return x === mu ? lib_default27 : 0;
  }
  z = lib_default29((x - mu) / s);
  ez = lib_default68(-z);
  return ez / (s * lib_default47(1 + ez, 2));
}
var main_default362 = pdf20;

var degenerate18 = lib_default190.factory;
function factory116(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate18(mu);
  }
  return pdf30;
  function pdf30(x) {
    var ez;
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x === lib_default11) {
      return 0;
    }
    z = lib_default29((x - mu) / s);
    ez = lib_default68(-z);
    return ez / (s * lib_default47(1 + ez, 2));
  }
}
var factory_default116 = factory116;

main_default362.factory = factory_default116;
var lib_default403 = main_default362;

function quantile23(p101, mu, s) {
  if (lib_default(mu) || lib_default(s) || lib_default(p101) || s < 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (s === 0) {
    return mu;
  }
  return mu + s * lib_default12(p101 / (1 - p101));
}
var main_default363 = quantile23;

var degenerate19 = lib_default192.factory;
function factory117(mu, s) {
  if (lib_default(mu) || lib_default(s) || s < 0) {
    return lib_default6(NaN);
  }
  if (s === 0) {
    return degenerate19(mu);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return mu + s * lib_default12(p101 / (1 - p101));
  }
}
var factory_default117 = factory117;

main_default363.factory = factory_default117;
var lib_default404 = main_default363;

function skewness19(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return 0;
}
var main_default364 = skewness19;

var lib_default405 = main_default364;

var PI_OVER_SQRT_THREE = 1.8137993642342178;
function stdev22(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return s * PI_OVER_SQRT_THREE;
}
var main_default365 = stdev22;

var lib_default406 = main_default365;

function variance21(mu, s) {
  if (lib_default(mu) || lib_default(s) || s <= 0) {
    return NaN;
  }
  return s * s * lib_default220 / 3;
}
var main_default366 = variance21;

var lib_default407 = main_default366;

function cdf24(x, mu, sigma) {
  var denom;
  var xc;
  if (lib_default(x) || lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  if (sigma === 0) {
    return x < mu ? 0 : 1;
  }
  denom = sigma * lib_default2(2);
  xc = x - mu;
  return 0.5 * lib_default102(-xc / denom);
}
var main_default367 = cdf24;

var degenerate20 = lib_default179.factory;
function factory118(mu, sigma) {
  var denom;
  if (lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate20(mu);
  }
  denom = sigma * lib_default2(2);
  return cdf35;
  function cdf35(x) {
    var xc;
    if (lib_default(x)) {
      return NaN;
    }
    xc = x - mu;
    return 0.5 * lib_default102(-xc / denom);
  }
}
var factory_default118 = factory118;

main_default367.factory = factory_default118;
var lib_default408 = main_default367;

function cdf25(x, mu, sigma) {
  if (lib_default(x) || lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return 0;
  }
  return lib_default408(lib_default12(x), mu, sigma);
}
var main_default368 = cdf25;

function factory119(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return 0;
    }
    return lib_default408(lib_default12(x), mu, sigma);
  }
}
var factory_default119 = factory119;

main_default368.factory = factory_default119;
var lib_default409 = main_default368;

function entropy22(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return lib_default12(sigma * lib_default68(mu + 0.5) * lib_default88);
}
var main_default369 = entropy22;

var lib_default410 = main_default369;

function kurtosis20(mu, sigma) {
  var out;
  var s2;
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  s2 = sigma * sigma;
  out = lib_default68(4 * s2);
  out += 2 * lib_default68(3 * s2);
  out += 3 * lib_default68(2 * s2);
  out -= 6;
  return out;
}
var main_default370 = kurtosis20;

var lib_default411 = main_default370;

function abs2(x) {
  return x * x;
}
var main_default371 = abs2;

var lib_default412 = main_default371;

var table = [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15, p16, p17, p18, p19, p20, p21, p22, p23, p24, p25, p26, p27, p28, p29, p30, p31, p32, p33, p34, p35, p36, p37, p38, p39, p40, p41, p42, p43, p44, p45, p46, p47, p48, p49, p50, p51, p52, p53, p54, p55, p56, p57, p58, p59, p60, p61, p62, p63, p64, p65, p66, p67, p68, p69, p70, p71, p72, p73, p74, p75, p76, p77, p78, p79, p80, p81, p82, p83, p84, p85, p86, p87, p88, p89, p90, p91, p92, p93, p94, p95, p96, p97, p98, p99, p100];
function p0(t) {
  return 7087803245410644e-19 + (712340910470263e-18 + (35779077297597742e-22 + (17403143962587938e-24 + (8171066004730779e-26 + (3688502236043496e-28 + 15917038551111112e-31 * t) * t) * t) * t) * t) * t;
}
function p1(t) {
  return 0.0021479143208285143 + (7268640236737999e-19 + (36843175430938994e-22 + (180718412721492e-22 + (8549644929604033e-26 + (3885203751853429e-28 + 16868473576888889e-31 * t) * t) * t) * t) * t) * t;
}
function p2(t) {
  return 0.0036165255935630175 + (7418209232355551e-19 + (3794831995752824e-21 + (18771627021793087e-24 + (8948471512241509e-26 + (4093585851777244e-28 + 1787206146488889e-30 * t) * t) * t) * t) * t) * t;
}
function p3(t) {
  return 0.005115498386003198 + (7572284073479166e-19 + (390964257267357e-20 + (1950416870430047e-23 + (93687503063179e-24 + (43143925959079665e-29 + 18939926435555556e-31 * t) * t) * t) * t) * t) * t;
}
function p4(t) {
  return 0.006645751317267305 + (7731040605444745e-19 + (4028951058939944e-21 + (20271233238288382e-24 + (981176313217091e-25 + (4548420740601775e-28 + 2007635221333333e-30 * t) * t) * t) * t) * t) * t;
}
function p5(t) {
  return 0.008208238997024121 + (7894662961188171e-19 + (4152970155262265e-21 + (21074693344544657e-24 + (10278874108587318e-26 + (4796520139061334e-28 + 21285907413333335e-31 * t) * t) * t) * t) * t) * t;
}
function p6(t) {
  return 0.009803953727535219 + (8063344010834284e-19 + (4281924132973699e-21 + (21916534346907168e-24 + (10771535136565471e-26 + (5059597262369282e-28 + 22573462684444446e-31 * t) * t) * t) * t) * t) * t;
}
function p7(t) {
  return 0.011433927298290302 + (8237285838319657e-19 + (4416049531176544e-21 + (22798861426211987e-24 + (1129129174587924e-25 + (5338618936581688e-28 + 23944209546666666e-31 * t) * t) * t) * t) * t) * t;
}
function p8(t) {
  return 0.013099232878814654 + (8416700246790696e-19 + (4555595898845751e-21 + (23723907357214174e-24 + (11839789326602696e-26 + (5634616306755024e-28 + 25403679644444446e-31 * t) * t) * t) * t) * t) * t;
}
function p9(t) {
  return 0.014800987015587536 + (8601809294634594e-19 + (4700826584881687e-21 + (24694040760197315e-24 + (12418779768752298e-26 + (5948689037032026e-28 + 2695776456888889e-30 * t) * t) * t) * t) * t) * t;
}
function p10(t) {
  return 0.01654035173939407 + (8792845864124146e-19 + (4852019579300175e-21 + (2571177490088171e-23 + (13030128534230821e-26 + (6282009758687478e-28 + 28612737351111112e-31 * t) * t) * t) * t) * t) * t;
}
function p11(t) {
  return 0.018318536789842393 + (8990054264789172e-19 + (5009468408955337e-21 + (2677977707421807e-23 + (13675822186304616e-26 + (6635828774535271e-28 + 30375273884444443e-31 * t) * t) * t) * t) * t) * t;
}
function p12(t) {
  return 0.020136801964214277 + (9193690873767368e-19 + (51734830914104276e-22 + (27900878609710433e-24 + (1435797640280904e-25 + (7011479031104373e-28 + 32252476e-22 * t) * t) * t) * t) * t) * t;
}
function p13(t) {
  return 0.021996459598282742 + (9404024815536678e-19 + (5344391150804117e-21 + (29078085538049375e-24 + (1507884450032973e-25 + (741038136474992e-27 + 3425189232e-24 * t) * t) * t) * t) * t) * t;
}
function p14(t) {
  return 0.02389887718722632 + (9621338683590018e-19 + (55225386998049015e-22 + (30314589961047687e-24 + (15840826497296334e-26 + (7834050047241445e-28 + 36381553564444445e-31 * t) * t) * t) * t) * t) * t;
}
function p15(t) {
  return 0.025845480155298518 + (9845929306782012e-19 + (5708291592005185e-21 + (3161378216916483e-23 + (1664647874552963e-25 + (828409859287854e-27 + 3864997576888889e-30 * t) * t) * t) * t) * t) * t;
}
function p16(t) {
  return 0.027837754783474698 + (0.0010078108563256892 + (59020366493792216e-22 + (3297926355324652e-23 + (17498524159268457e-26 + (8762245912484253e-28 + 4106620648888889e-30 * t) * t) * t) * t) * t) * t;
}
function p17(t) {
  return 0.029877251304899308 + (0.001031820424505735 + (6104182969716206e-21 + (3441486035954272e-23 + (1839986307293409e-25 + (9270322736636504e-28 + 43639844053333335e-31 * t) * t) * t) * t) * t) * t;
}
function p18(t) {
  return 0.03196558717859645 + (0.0010566560976716574 + (6315163319241458e-21 + (3592463833952192e-23 + (19353584758781173e-26 + (9810278385988926e-28 + 46381060817777776e-31 * t) * t) * t) * t) * t) * t;
}
function p19(t) {
  return 0.03410445055258834 + (0.0010823541191350532 + (6535435615955393e-21 + (37512918348533524e-24 + (20362979635817883e-26 + (10384187833037281e-28 + 4930062526222222e-30 * t) * t) * t) * t) * t) * t;
}
function p20(t) {
  return 0.036295603928292425 + (0.0011089526167995269 + (6765484509551836e-21 + (3918429294991359e-23 + (21431552202133775e-26 + (10994259106646732e-28 + 5240994910222222e-30 * t) * t) * t) * t) * t) * t;
}
function p21(t) {
  return 0.03854088803884051 + (0.001136491713417542 + (7005823064124631e-21 + (40943644083718584e-24 + (22563034723692883e-26 + (11642841011361993e-28 + 5572109287111111e-30 * t) * t) * t) * t) * t) * t;
}
function p22(t) {
  return 0.04084222595478596 + (0.0011650136437945675 + (72569945502343e-19 + (4279616186185504e-23 + (23761401711005023e-26 + (12332431172381557e-28 + 5924680236444444e-30 * t) * t) * t) * t) * t) * t;
}
function p23(t) {
  return 0.04320162743154022 + (0.0011945628793917271 + (751957435328492e-20 + (4474736455396099e-23 + (2503088521647295e-25 + (13065684400300477e-28 + 6300053285333334e-30 * t) * t) * t) * t) * t) * t;
}
function p24(t) {
  return 0.04562119351381047 + (0.001225186260806753 + (7794172005555192e-21 + (4680311983095446e-23 + (26375990983978426e-26 + (1384542137097712e-27 + 66996477404444446e-31 * t) * t) * t) * t) * t) * t;
}
function p25(t) {
  return 0.048103121413299865 + (0.0012569331386432195 + (8081433349636768e-21 + (4896966733568202e-23 + (27801515481905746e-26 + (14674637611609885e-28 + 7124958935111111e-30 * t) * t) * t) * t) * t) * t;
}
function p26(t) {
  return 0.05064970967698334 + (0.0012898555233099055 + (838204284145688e-20 + (5125364265255184e-23 + (29312563849675507e-26 + (15556512782814827e-28 + 7577560782222223e-30 * t) * t) * t) * t) * t) * t;
}
function p27(t) {
  return 0.053263363664388864 + (0.0013240082443256975 + (8696726001500767e-21 + (536621027503968e-22 + (309145687866348e-24 + (16494420240828494e-28 + 8059107964444444e-30 * t) * t) * t) * t) * t) * t;
}
function p28(t) {
  return 0.05594660135350001 + (0.001359449119740819 + (9026252023301638e-21 + (56202552975056696e-24 + (3261331041050314e-25 + (17491936862246368e-28 + 8571338168888888e-30 * t) * t) * t) * t) * t) * t;
}
function p29(t) {
  return 0.058702059496154084 + (0.0013962391363223647 + (9371436548731279e-21 + (58882975670265285e-24 + (34414937110591756e-26 + (1855285310975186e-27 + 911607367111111e-29 * t) * t) * t) * t) * t) * t;
}
function p30(t) {
  return 0.061532500145144775 + (0.0014344426411912014 + (9733144620101681e-21 + (6171186050734718e-23 + (363259874182953e-24 + (19681183310134517e-28 + 969522384e-23 * t) * t) * t) * t) * t) * t;
}
function p31(t) {
  return 0.06444081757665329 + (0.0014741275456383132 + (10112293819576438e-21 + (6469823660593325e-23 + (38353412915303665e-26 + (2088117611438512e-27 + 1031078448e-23 * t) * t) * t) * t) * t) * t;
}
function p32(t) {
  return 0.06743004563313039 + (0.001515365541891654 + (10509857606888329e-21 + (6785170652936334e-23 + (4050460219481114e-25 + (22157325110542536e-28 + 10964842115555555e-30 * t) * t) * t) * t) * t) * t;
}
function p33(t) {
  return 0.07050336551333886 + (0.001558232333649571 + (1092686886686523e-20 + (7118248223961351e-23 + (42787405890153386e-26 + (2351437952227442e-27 + 11659571751111111e-30 * t) * t) * t) * t) * t) * t;
}
function p34(t) {
  return 0.0736641140379446 + (0.001602807881243882 + (11364423678778208e-21 + (7470142309742318e-23 + (4521016277747649e-25 + (2495735500408857e-27 + 12397238257777777e-30 * t) * t) * t) * t) * t) * t;
}
function p35(t) {
  return 0.07691579242081956 + (0.0016491766623447889 + (11823685320041301e-21 + (7842007599378154e-23 + (4778172695691648e-25 + (26491544403815725e-28 + 13180196462222222e-30 * t) * t) * t) * t) * t) * t;
}
function p36(t) {
  return 0.08026207557809462 + (0.0016974279491709504 + (12305888517309891e-21 + (8235071769897904e-23 + (5051149610985711e-25 + (281225284976269e-26 + 14010889635555555e-30 * t) * t) * t) * t) * t) * t;
}
function p37(t) {
  return 0.08370682200898036 + (0.0017476561032212657 + (12812343958540764e-21 + (8650639951503644e-23 + (5340944082386946e-25 + (29856186620887555e-28 + 1489185159111111e-29 * t) * t) * t) * t) * t) * t;
}
function p38(t) {
  return 0.08725408428446171 + (0.0017999608886001962 + (13344443080089493e-21 + (90900994316429e-21 + (5648613497261646e-25 + (3169870708003396e-27 + 15825697795555556e-30 * t) * t) * t) * t) * t) * t;
}
function p39(t) {
  return 0.09090812018217274 + (0.00185444780506577 + (1390366314342612e-20 + (9554924606254991e-23 + (5975278712524205e-25 + (336565973660991e-26 + 16815130613333334e-30 * t) * t) * t) * t) * t) * t;
}
function p40(t) {
  return 0.09467340450807549 + (0.0019112284419887304 + (14491572616545005e-21 + (10046682186333614e-23 + (63221272959791e-23 + (3573669397558913e-27 + 1786293159111111e-29 * t) * t) * t) * t) * t) * t;
}
function p41(t) {
  return 0.09855464164800445 + (0.0019704208544725622 + (15109836875625445e-21 + (10567036667675984e-23 + (6690416864001935e-25 + (3794617185082434e-27 + 1897195904e-23 * t) * t) * t) * t) * t) * t;
}
function p42(t) {
  return 0.1025567788947009 + (0.0020321499629472857 + (1576022424296218e-20 + (11117756071353507e-23 + (7081478511009766e-25 + (4029255327663256e-27 + 20145143075555556e-30 * t) * t) * t) * t) * t) * t;
}
function p43(t) {
  return 0.10668502059865094 + (0.002096547977614873 + (16444612377624982e-21 + (11700717962026153e-23 + (7496720325093842e-25 + (42783716186085925e-28 + 2138547936e-23 * t) * t) * t) * t) * t) * t;
}
function p44(t) {
  return 0.11094484319386444 + (0.002163754849190817 + (17164995035719656e-21 + (12317915750735938e-23 + (7937630983149963e-25 + (4542790176310636e-27 + 22696025653333333e-30 * t) * t) * t) * t) * t) * t;
}
function p45(t) {
  return 0.11534201115268805 + (0.002233918747454642 + (17923489217504226e-21 + (12971465288245997e-23 + (8405783418038907e-25 + (48233721206418025e-28 + 24079890062222222e-30 * t) * t) * t) * t) * t) * t;
}
function p46(t) {
  return 0.11988259392684095 + (0.002307196569191869 + (18722342718958937e-21 + (13663611754337958e-23 + (8902838548849328e-25 + (5121016156922585e-27 + 2554022711111111e-29 * t) * t) * t) * t) * t) * t;
}
function p47(t) {
  return 0.12457298393509812 + (0.0023837544771809576 + (1956394210571161e-20 + (1439673684773947e-22 + (9430549064645925e-25 + (5436659058313422e-27 + 2708022592e-23 * t) * t) * t) * t) * t) * t;
}
function p48(t) {
  return 0.12941991566142438 + (0.002463768471950886 + (2045082112747588e-20 + (15173366280523906e-23 + (9990763250638903e-25 + (5771276031135163e-27 + 28703099555555555e-30 * t) * t) * t) * t) * t) * t;
}
function p49(t) {
  return 0.13443048593088697 + (0.0025474249981080823 + (21385669591362916e-21 + (15996177579900442e-23 + (10585428844575133e-25 + (6125880953678788e-27 + 3041208014222222e-29 * t) * t) * t) * t) * t) * t;
}
function p50(t) {
  return 0.13961217543434562 + (0.0026349215871051762 + (22371342712572568e-21 + (16868008199296823e-23 + (11216596910444997e-25 + (6501526475309089e-27 + 3221039450666667e-29 * t) * t) * t) * t) * t) * t;
}
function p51(t) {
  return 0.144972871576738 + (0.002726467538398244 + (2341087096105095e-20 + (17791863939526378e-23 + (11886425714330958e-25 + (68993039665054284e-28 + 34101266222222225e-30 * t) * t) * t) * t) * t) * t;
}
function p52(t) {
  return 0.15052089272774619 + (0.0028222846410136237 + (24507470422713398e-21 + (18770927679626137e-23 + (1259718458758337e-24 + (7320343304922983e-27 + 36087889048888887e-30 * t) * t) * t) * t) * t) * t;
}
function p53(t) {
  return 0.1562650139577461 + (0.0029226079376196627 + (2566455369376845e-20 + (19808568415654462e-23 + (13351257759815557e-25 + (7765812489104676e-27 + 3817342003555556e-29 * t) * t) * t) * t) * t) * t;
}
function p54(t) {
  return 0.16221449434620738 + (0.0030276865332726477 + (26885741326534563e-21 + (20908350604346383e-23 + (1415114814424073e-24 + (8236917066597432e-27 + 4036095745777778e-29 * t) * t) * t) * t) * t) * t;
}
function p55(t) {
  return 0.1683791059541213 + (0.0031377844510793083 + (28174873844911173e-21 + (22074043807045782e-23 + (1499948105599609e-24 + (8734899366193081e-27 + 4265352897777778e-29 * t) * t) * t) * t) * t) * t;
}
function p56(t) {
  return 0.1747691645565937 + (0.0032531815370903066 + (29536024347344365e-21 + (23309632627767074e-23 + (15899007843582445e-25 + (9261037523542736e-27 + 45054073102222224e-30 * t) * t) * t) * t) * t) * t;
}
function p57(t) {
  return 0.18139556223643702 + (0.0033741744168097 + (309735117147095e-19 + (2461932693759229e-22 + (16852609412267751e-25 + (981664429428549e-26 + 4756541809777778e-29 * t) * t) * t) * t) * t) * t;
}
function p58(t) {
  return 0.18826980194443665 + (0.0035010775057740316 + (3249191444001427e-20 + (2600757237588632e-22 + (17863299617388377e-25 + (10403065638343878e-27 + 5019026583111111e-29 * t) * t) * t) * t) * t) * t;
}
function p59(t) {
  return 0.19540403413693969 + (0.0036342240767211326 + (34096085096200906e-21 + (27479061117017636e-23 + (18934228504790033e-25 + (11021679075323599e-27 + 5293117173333333e-29 * t) * t) * t) * t) * t) * t;
}
function p60(t) {
  return 0.20281109560651886 + (0.00377396738593236 + (3579116545759241e-20 + (29038742889416174e-23 + (20068685374849e-22 + (11673891799578381e-27 + 55790523093333335e-30 * t) * t) * t) * t) * t) * t;
}
function p61(t) {
  return 0.21050455062669335 + (0.003920681861392565 + (37582602289680105e-21 + (30691836231886877e-23 + (21270101645763676e-25 + (12361138551062899e-27 + 5877052016e-23 * t) * t) * t) * t) * t) * t;
}
function p62(t) {
  return 0.21849873453703333 + (0.004074764355468959 + (3947616382098671e-20 + (3244383997013992e-22 + (2254205349151868e-24 + (13084879235290859e-27 + 6187315326222222e-29 * t) * t) * t) * t) * t) * t;
}
function p63(t) {
  return 0.2268087999004323 + (0.004236635464862852 + (41477956909656896e-21 + (3430054489450281e-22 + (23888264229264067e-25 + (13846596292818514e-27 + 6510018375111112e-29 * t) * t) * t) * t) * t) * t;
}
function p64(t) {
  return 0.23545076536988704 + (0.004406740920636517 + (435944449162247e-19 + (36268045617760415e-23 + (253126064308532e-23 + (14647791812837902e-27 + 6845312263111111e-29 * t) * t) * t) * t) * t) * t;
}
function p65(t) {
  return 0.24444156740777434 + (0.004585553051160578 + (45832466292683086e-21 + (3835275259003303e-22 + (26819103733055602e-25 + (15489984390884758e-27 + 7193320636444444e-29 * t) * t) * t) * t) * t) * t;
}
function p66(t) {
  return 0.25379911500634267 + (0.004773572320865003 + (48199253896534185e-21 + (40561404245564733e-23 + (28411932320871164e-25 + (1637470573645832e-26 + 7554137982222222e-29 * t) * t) * t) * t) * t) * t;
}
function p67(t) {
  return 0.26354234756393613 + (0.0049713289477083785 + (5070245503693037e-20 + (42901079254268185e-23 + (3009542205890048e-24 + (1730349702534734e-26 + 7927827336888888e-29 * t) * t) * t) * t) * t) * t;
}
function p68(t) {
  return 0.27369129607732345 + (0.005179384602305264 + (533501522583266e-19 + (4537920884886502e-22 + (3187405724581438e-24 + (1827790501024511e-26 + 8314418236444444e-29 * t) * t) * t) * t) * t) * t;
}
function p69(t) {
  return 0.28426714781640317 + (0.005398334191669514 + (5615088486525581e-20 + (4800358919649474e-22 + (33752476967570798e-25 + (19299477888083468e-27 + 8713904913777777e-29 * t) * t) * t) * t) * t) * t;
}
function p70(t) {
  return 0.2952923146534852 + (0.0056288077305420795 + (5911367118991331e-20 + (5078239378174484e-22 + (35735475025851714e-25 + (2036976093701707e-26 + 9126244261333333e-29 * t) * t) * t) * t) * t) * t;
}
function p71(t) {
  return 0.3067905052252884 + (0.00587147230327454 + (6224803160219768e-20 + (5372418576620094e-22 + (3782799941896024e-24 + (2149029193044454e-26 + 9551353918222223e-29 * t) * t) * t) * t) * t) * t;
}
function p72(t) {
  return 0.3187868011117332 + (0.00612703411923391 + (6556401225970764e-20 + (5683793028783774e-22 + (4003515135339238e-24 + (22662596341239295e-27 + 9989110976e-23 * t) * t) * t) * t) * t) * t;
}
function p73(t) {
  return 0.33130773722152623 + (0.006396240664679808 + (690722095929424e-19 + (6013300666188594e-22 + (4236218376588347e-24 + (23888182347073697e-27 + 10439349811555555e-29 * t) * t) * t) * t) * t) * t;
}
function p74(t) {
  return 0.34438138658041334 + (0.0066798829540414 + (7278379551860356e-20 + (636192204432288e-21 + (4481449933651445e-24 + (25168535651285476e-27 + 10901861383111111e-29 * t) * t) * t) * t) * t) * t;
}
function p75(t) {
  return 0.35803744972380175 + (0.006978797883488269 + (7671054337145482e-20 + (6730681530891739e-22 + (4739764797584523e-24 + (2650511414114305e-26 + 11376390933333332e-29 * t) * t) * t) * t) * t) * t;
}
function p76(t) {
  return 0.37230734890119727 + (0.007293870689646138 + (8086485454267072e-20 + (7120648471806269e-22 + (50117323769745884e-25 + (27899342394100073e-27 + 11862637614222222e-29 * t) * t) * t) * t) * t) * t;
}
function p77(t) {
  return 0.3872243273055545 + (0.00762603751625498 + (8525978581000461e-20 + (7532938330517133e-22 + (5297936136838812e-24 + (2935260605416409e-26 + 12360253370666666e-29 * t) * t) * t) * t) * t) * t;
}
function p78(t) {
  return 0.4028235535461694 + (0.007976288091502973 + (8990907734243825e-20 + (7968713796195619e-22 + (55989731807360405e-25 + (30866246101464866e-27 + 12868841946666668e-29 * t) * t) * t) * t) * t) * t;
}
function p79(t) {
  return 0.4191422315891379 + (0.008345668518695046 + (9482718135925016e-20 + (8429185856178314e-22 + (5915453775108349e-24 + (3244155303434747e-26 + 1338795794311111e-28 * t) * t) * t) * t) * t) * t;
}
function p80(t) {
  return 0.43621971639463786 + (0.00873528418282895 + (100029291420668e-18 + (8915614828021988e-22 + (624800081507886e-23 + (3407976098345888e-26 + 13917107176888888e-29 * t) * t) * t) * t) * t) * t;
}
function p81(t) {
  return 0.4540976354853433 + (0.009146302775554824 + (10553137232446167e-20 + (9429311346463863e-22 + (6597249231221996e-24 + (35782041795476564e-27 + 14455745872e-23 * t) * t) * t) * t) * t) * t;
}
function p82(t) {
  return 0.4728200166851233 + (0.009579957440886046 + (11135019058000067e-20 + (9971637300550903e-22 + (6963845336995697e-24 + (37549499088161346e-27 + 1500328071288889e-28 * t) * t) * t) * t) * t) * t;
}
function p83(t) {
  return 0.4924334222717984 + (0.010037550043909497 + (11750334542845235e-20 + (10544006716188967e-22 + (7348446116824222e-24 + (3938316232643575e-26 + 15559069118222223e-29 * t) * t) * t) * t) * t) * t;
}
function p84(t) {
  return 0.5129870897920926 + (0.010520454564612427 + (12400930037494997e-20 + (11147886579371265e-22 + (775171845505687e-23 + (41283980931872625e-27 + 1612241968e-22 * t) * t) * t) * t) * t) * t;
}
function p85(t) {
  return 0.5345330797910137 + (0.011030120618800727 + (1308874151957227e-19 + (11784797595374515e-22 + (8174338306304482e-24 + (43252818449517084e-27 + 1669259264e-22 * t) * t) * t) * t) * t) * t;
}
function p86(t) {
  return 0.557126430711693 + (0.011568077107929736 + (13815797838036652e-20 + (12456314879260905e-22 + (8616989807896932e-24 + (4529044681153965e-26 + 17268801084444443e-29 * t) * t) * t) * t) * t) * t;
}
function p87(t) {
  return 0.5808253212251933 + (0.012135935999503878 + (1458422399666584e-19 + (1316406857309571e-21 + (9080364335510602e-24 + (4739754071312462e-26 + 1785021160888889e-28 * t) * t) * t) * t) * t) * t;
}
function p88(t) {
  return 0.6056912402529337 + (0.01273539623952555 + (15396244472258864e-20 + (13909744385382817e-22 + (9565159503230623e-24 + (4957467212766904e-26 + 18435945564444444e-29 * t) * t) * t) * t) * t) * t;
}
function p89(t) {
  return 0.6317891649471572 + (0.013368247798287032 + (16254186562762076e-20 + (14695084048334055e-22 + (10072078109604152e-24 + (5182230499568071e-26 + 19025081422222223e-29 * t) * t) * t) * t) * t) * t;
}
function p90(t) {
  return 0.6591877468972532 + (0.014036375850601992 + (17160483760259707e-20 + (15521885688723188e-22 + (1060182703153528e-23 + (5414079010583752e-26 + 19616655146666667e-29 * t) * t) * t) * t) * t) * t;
}
function p91(t) {
  return 0.6879595068317443 + (0.014741765091365868 + (18117679143520433e-20 + (16392004108230584e-22 + (11155116068018043e-24 + (5653036019492569e-26 + 20209663662222222e-29 * t) * t) * t) * t) * t) * t;
}
function p92(t) {
  return 0.7181810380872997 + (0.015486504187117112 + (19128428784550924e-20 + (17307350969359975e-22 + (11732656736113608e-24 + (5899112528756384e-26 + 20803065333333334e-29 * t) * t) * t) * t) * t) * t;
}
function p93(t) {
  return 0.7499332191172625 + (0.016272790364044783 + (20195505163377912e-20 + (18269894883203348e-22 + (12335161021630225e-24 + (6152306831216908e-26 + 21395783431111112e-29 * t) * t) * t) * t) * t) * t;
}
function p94(t) {
  return 0.7833014353128349 + (0.01710293413265243 + (21321800585063328e-20 + (19281661395543912e-22 + (12963340087354342e-24 + (6412604099806635e-26 + 21986708942222223e-29 * t) * t) * t) * t) * t) * t;
}
function p95(t) {
  return 0.8183758104102381 + (0.017979364149044223 + (2251033059275313e-19 + (20344732868018175e-22 + (1361790294183995e-23 + (6679976008397248e-26 + 2257470126222222e-28 * t) * t) * t) * t) * t) * t;
}
function p96(t) {
  return 0.8552514477568512 + (0.01890463221254756 + (23764237370371255e-20 + (2146124825130639e-21 + (14299555071870523e-24 + (6954380386469418e-26 + 23158593688888887e-29 * t) * t) * t) * t) * t) * t;
}
function p97(t) {
  return 0.8940286817084994 + (0.0198814183991272 + (25086793128395994e-20 + (22633402747585233e-22 + (1500899704211653e-23 + (7235760907504394e-26 + 23737194737777777e-29 * t) * t) * t) * t) * t) * t;
}
function p98(t) {
  return 0.9348133394287079 + (0.02091253632978037 + (2648140346599848e-19 + (23863447359754924e-22 + (15746923065472183e-24 + (7524046814172015e-26 + 24309291271111114e-29 * t) * t) * t) * t) * t) * t;
}
function p99(t) {
  return 0.9777170133588503 + (0.02200093857283048 + (2795161070268238e-19 + (25153688325245316e-22 + (1651401954782282e-23 + (7819152682936823e-26 + 24873652355555557e-29 * t) * t) * t) * t) * t) * t;
}
function p100() {
  return 1;
}
function erfcxY100(y100) {
  var t = lib_default23(y100);
  var f2 = table[t];
  return f2(2 * y100 - (2 * t + 1));
}
var erfcx_y100_default = erfcxY100;

var INV_SQRT_PI = 0.5641895835477563;
function erfcx(x) {
  var x2;
  if (lib_default(x)) {
    return x;
  }
  if (x >= 0) {
    if (x > 50) {
      if (x > 5e7) {
        return INV_SQRT_PI / x;
      }
      x2 = x * x;
      return INV_SQRT_PI * (x2 * (x2 + 4.5) + 2) / (x * (x2 * (x2 + 5) + 3.75));
    }
    return erfcx_y100_default(400 / (4 + x));
  }
  if (x < -26.7) {
    return lib_default27;
  }
  x2 = x * x;
  if (x < -6.1) {
    return 2 * lib_default68(x2);
  }
  return 2 * lib_default68(x2) - erfcx_y100_default(400 / (4 - x));
}
var main_default372 = erfcx;

var lib_default413 = main_default372;

var INV_SQRT_TWO = 0.7071067811865475;
function logcdf16(x, mu, sigma) {
  var z;
  if (lib_default(x) || lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  if (sigma === 0) {
    return x < mu ? lib_default11 : 0;
  }
  z = (x - mu) / sigma;
  if (z < -1) {
    return lib_default12(lib_default413(-z * INV_SQRT_TWO) / 2) - lib_default412(z) / 2;
  }
  return lib_default78(-lib_default102(z * INV_SQRT_TWO) / 2);
}
var main_default373 = logcdf16;

var degenerate21 = lib_default213.factory;
var INV_SQRT_TWO2 = 0.7071067811865475;
function factory120(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate21(mu);
  }
  return logcdf24;
  function logcdf24(x) {
    var z = (x - mu) / sigma;
    if (z < -1) {
      return lib_default12(lib_default413(-z * INV_SQRT_TWO2) / 2) - lib_default412(z) / 2;
    }
    return lib_default78(-lib_default102(z * INV_SQRT_TWO2) / 2);
  }
}
var factory_default120 = factory120;

main_default373.factory = factory_default120;
var lib_default414 = main_default373;

function logcdf17(x, mu, sigma) {
  var lx = x <= 0 ? lib_default11 : lib_default12(x);
  return lib_default414(lx, mu, sigma);
}
var main_default374 = logcdf17;

var degenerate22 = lib_default213.factory;
function factory121(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate22(mu);
  }
  return logcdf24;
  function logcdf24(x) {
    var lx = x <= 0 ? lib_default11 : lib_default12(x);
    return lib_default414(lx, mu, sigma);
  }
}
var factory_default121 = factory121;

main_default374.factory = factory_default121;
var lib_default415 = main_default374;

function logpdf20(x, mu, sigma) {
  var s2;
  var A2;
  var B;
  if (lib_default(x) || lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return lib_default11;
  }
  s2 = lib_default47(sigma, 2);
  A2 = -0.5 * lib_default12(2 * s2 * lib_default5);
  B = -1 / (2 * s2);
  return A2 - lib_default12(x) + B * lib_default47(lib_default12(x) - mu, 2);
}
var main_default375 = logpdf20;

function factory122(mu, sigma) {
  var s2;
  var A2;
  var B;
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return lib_default6(NaN);
  }
  s2 = lib_default47(sigma, 2);
  A2 = -0.5 * lib_default12(2 * s2 * lib_default5);
  B = -1 / (2 * s2);
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return lib_default11;
    }
    return A2 - lib_default12(x) + B * lib_default47(lib_default12(x) - mu, 2);
  }
}
var factory_default122 = factory122;

main_default375.factory = factory_default122;
var lib_default416 = main_default375;

function mean24(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return lib_default68(mu + sigma * sigma / 2);
}
var main_default376 = mean24;

var lib_default417 = main_default376;

function median18(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return lib_default68(mu);
}
var main_default377 = median18;

var lib_default418 = main_default377;

function mode25(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return lib_default68(mu - sigma * sigma);
}
var main_default378 = mode25;

var lib_default419 = main_default378;

function pdf21(x, mu, sigma) {
  var s2;
  var A2;
  var B;
  if (lib_default(x) || lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  if (x <= 0) {
    return 0;
  }
  s2 = lib_default47(sigma, 2);
  A2 = 1 / lib_default2(2 * s2 * lib_default5);
  B = -1 / (2 * s2);
  return 1 / x * A2 * lib_default68(B * lib_default47(lib_default12(x) - mu, 2));
}
var main_default379 = pdf21;

function factory123(mu, sigma) {
  var s2;
  var A2;
  var B;
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return lib_default6(NaN);
  }
  s2 = lib_default47(sigma, 2);
  A2 = 1 / lib_default2(2 * s2 * lib_default5);
  B = -1 / (2 * s2);
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0) {
      return 0;
    }
    return 1 / x * A2 * lib_default68(B * lib_default47(lib_default12(x) - mu, 2));
  }
}
var factory_default123 = factory123;

main_default379.factory = factory_default123;
var lib_default420 = main_default379;

function evalrational26(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -5087819496582806e-19;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -5087819496582806e-19 + x * (-0.008368748197417368 + x * (0.03348066254097446 + x * (-0.012692614766297404 + x * (-0.03656379714117627 + x * (0.02198786811111689 + x * (0.008226878746769157 + x * (-0.005387729650712429 + x * (0 + x * 0))))))));
    s2 = 1 + x * (-0.9700050433032906 + x * (-1.5657455823417585 + x * (1.5622155839842302 + x * (0.662328840472003 + x * (-0.7122890234154284 + x * (-0.05273963823400997 + x * (0.07952836873415717 + x * (-0.0023339375937419 + x * 8862163904564247e-19))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0 + x * (-0.005387729650712429 + x * (0.008226878746769157 + x * (0.02198786811111689 + x * (-0.03656379714117627 + x * (-0.012692614766297404 + x * (0.03348066254097446 + x * (-0.008368748197417368 + x * -5087819496582806e-19))))))));
    s2 = 8862163904564247e-19 + x * (-0.0023339375937419 + x * (0.07952836873415717 + x * (-0.05273963823400997 + x * (-0.7122890234154284 + x * (0.662328840472003 + x * (1.5622155839842302 + x * (-1.5657455823417585 + x * (-0.9700050433032906 + x * 1))))))));
  }
  return s1 / s2;
}
var rational_p1q1_default3 = evalrational26;

function evalrational27(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.20243350835593876;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.20243350835593876 + x * (0.10526468069939171 + x * (8.3705032834312 + x * (17.644729840837403 + x * (-18.851064805871424 + x * (-44.6382324441787 + x * (17.445385985570866 + x * (21.12946554483405 + x * -3.6719225470772936)))))));
    s2 = 1 + x * (6.242641248542475 + x * (3.971343795334387 + x * (-28.66081804998 + x * (-20.14326346804852 + x * (48.560921310873994 + x * (10.826866735546016 + x * (-22.643693341313973 + x * 1.7211476576120028)))))));
  } else {
    x = 1 / x;
    s1 = -3.6719225470772936 + x * (21.12946554483405 + x * (17.445385985570866 + x * (-44.6382324441787 + x * (-18.851064805871424 + x * (17.644729840837403 + x * (8.3705032834312 + x * (0.10526468069939171 + x * -0.20243350835593876)))))));
    s2 = 1.7211476576120028 + x * (-22.643693341313973 + x * (10.826866735546016 + x * (48.560921310873994 + x * (-20.14326346804852 + x * (-28.66081804998 + x * (3.971343795334387 + x * (6.242641248542475 + x * 1)))))));
  }
  return s1 / s2;
}
var rational_p2q2_default3 = evalrational27;

function evalrational28(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.1311027816799519;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.1311027816799519 + x * (-0.16379404719331705 + x * (0.11703015634199525 + x * (0.38707973897260434 + x * (0.3377855389120359 + x * (0.14286953440815717 + x * (0.029015791000532906 + x * (0.0021455899538880526 + x * (-6794655751811263e-22 + x * (28522533178221704e-24 + x * -681149956853777e-24)))))))));
    s2 = 1 + x * (3.4662540724256723 + x * (5.381683457070069 + x * (4.778465929458438 + x * (2.5930192162362027 + x * (0.848854343457902 + x * (0.15226433829533179 + x * (0.011059242293464892 + x * (0 + x * (0 + x * 0)))))))));
  } else {
    x = 1 / x;
    s1 = -681149956853777e-24 + x * (28522533178221704e-24 + x * (-6794655751811263e-22 + x * (0.0021455899538880526 + x * (0.029015791000532906 + x * (0.14286953440815717 + x * (0.3377855389120359 + x * (0.38707973897260434 + x * (0.11703015634199525 + x * (-0.16379404719331705 + x * -0.1311027816799519)))))))));
    s2 = 0 + x * (0 + x * (0 + x * (0.011059242293464892 + x * (0.15226433829533179 + x * (0.848854343457902 + x * (2.5930192162362027 + x * (4.778465929458438 + x * (5.381683457070069 + x * (3.4662540724256723 + x * 1)))))))));
  }
  return s1 / s2;
}
var rational_p3q3_default3 = evalrational28;

function evalrational29(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.0350353787183178;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.0350353787183178 + x * (-0.0022242652921344794 + x * (0.018557330651423107 + x * (0.009508047013259196 + x * (0.0018712349281955923 + x * (15754461742496055e-20 + x * (460469890584318e-20 + x * (-2304047769118826e-25 + x * 26633922742578204e-28)))))));
    s2 = 1 + x * (1.3653349817554064 + x * (0.7620591645536234 + x * (0.22009110576413124 + x * (0.03415891436709477 + x * (0.00263861676657016 + x * (7646752923027944e-20 + x * (0 + x * 0)))))));
  } else {
    x = 1 / x;
    s1 = 26633922742578204e-28 + x * (-2304047769118826e-25 + x * (460469890584318e-20 + x * (15754461742496055e-20 + x * (0.0018712349281955923 + x * (0.009508047013259196 + x * (0.018557330651423107 + x * (-0.0022242652921344794 + x * -0.0350353787183178)))))));
    s2 = 0 + x * (0 + x * (7646752923027944e-20 + x * (0.00263861676657016 + x * (0.03415891436709477 + x * (0.22009110576413124 + x * (0.7620591645536234 + x * (1.3653349817554064 + x * 1)))))));
  }
  return s1 / s2;
}
var rational_p4q4_default2 = evalrational29;

function evalrational30(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.016743100507663373;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.016743100507663373 + x * (-0.0011295143874558028 + x * (0.001056288621524929 + x * (20938631748758808e-20 + x * (14962478375834237e-21 + x * (44969678992770644e-23 + x * (4625961635228786e-24 + x * (-2811287356288318e-29 + x * 9905570997331033e-32)))))));
    s2 = 1 + x * (0.5914293448864175 + x * (0.1381518657490833 + x * (0.016074608709367652 + x * (9640118070051656e-19 + x * (27533547476472603e-21 + x * (282243172016108e-21 + x * (0 + x * 0)))))));
  } else {
    x = 1 / x;
    s1 = 9905570997331033e-32 + x * (-2811287356288318e-29 + x * (4625961635228786e-24 + x * (44969678992770644e-23 + x * (14962478375834237e-21 + x * (20938631748758808e-20 + x * (0.001056288621524929 + x * (-0.0011295143874558028 + x * -0.016743100507663373)))))));
    s2 = 0 + x * (0 + x * (282243172016108e-21 + x * (27533547476472603e-21 + x * (9640118070051656e-19 + x * (0.016074608709367652 + x * (0.1381518657490833 + x * (0.5914293448864175 + x * 1)))))));
  }
  return s1 / s2;
}
var rational_p5q5_default2 = evalrational30;

var Y13 = 0.08913147449493408;
var Y23 = 2.249481201171875;
var Y33 = 0.807220458984375;
var Y43 = 0.9399557113647461;
var Y52 = 0.9836282730102539;
function erfinv(x) {
  var sign;
  var ax;
  var qs;
  var q;
  var g;
  var r;
  if (lib_default(x)) {
    return NaN;
  }
  if (x === 1) {
    return lib_default27;
  }
  if (x === -1) {
    return lib_default11;
  }
  if (x === 0) {
    return x;
  }
  if (x > 1 || x < -1) {
    return NaN;
  }
  if (x < 0) {
    sign = -1;
    ax = -x;
  } else {
    sign = 1;
    ax = x;
  }
  q = 1 - ax;
  if (ax <= 0.5) {
    g = ax * (ax + 10);
    r = rational_p1q1_default3(ax);
    return sign * (g * Y13 + g * r);
  }
  if (q >= 0.25) {
    g = lib_default2(-2 * lib_default12(q));
    q -= 0.25;
    r = rational_p2q2_default3(q);
    return sign * (g / (Y23 + r));
  }
  q = lib_default2(-lib_default12(q));
  if (q < 3) {
    qs = q - 1.125;
    r = rational_p3q3_default3(qs);
    return sign * (Y33 * q + r * q);
  }
  if (q < 6) {
    qs = q - 3;
    r = rational_p4q4_default2(qs);
    return sign * (Y43 * q + r * q);
  }
  qs = q - 6;
  r = rational_p5q5_default2(qs);
  return sign * (Y52 * q + r * q);
}
var main_default380 = erfinv;

var lib_default421 = main_default380;

function quantile24(p101, mu, sigma) {
  var A2;
  var B;
  if (lib_default(mu) || lib_default(sigma) || lib_default(p101) || sigma < 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (sigma === 0) {
    return mu;
  }
  A2 = mu;
  B = sigma * lib_default2(2);
  return A2 + B * lib_default421(2 * p101 - 1);
}
var main_default381 = quantile24;

var degenerate23 = lib_default192.factory;
function factory124(mu, sigma) {
  var A2;
  var B;
  if (lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    degenerate23(mu);
  }
  A2 = mu;
  B = sigma * lib_default2(2);
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return A2 + B * lib_default421(2 * p101 - 1);
  }
}
var factory_default124 = factory124;

main_default381.factory = factory_default124;
var lib_default422 = main_default381;

function quantile25(p101, mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || lib_default(p101) || sigma <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return lib_default68(mu + sigma * lib_default422(p101, 0, 1));
}
var main_default382 = quantile25;

function factory125(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return lib_default68(mu + sigma * lib_default422(p101, 0, 1));
  }
}
var factory_default125 = factory125;

main_default382.factory = factory_default125;
var lib_default423 = main_default382;

function skewness20(mu, sigma) {
  var es2;
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  es2 = lib_default68(sigma * sigma);
  return (es2 + 2) * lib_default2(es2 - 1);
}
var main_default383 = skewness20;

var lib_default424 = main_default383;

function variance22(mu, sigma) {
  var s2;
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  s2 = sigma * sigma;
  return (lib_default68(s2) - 1) * lib_default68(2 * mu + s2);
}
var main_default384 = variance22;

var lib_default425 = main_default384;

function stdev23(mu, sigma) {
  return lib_default2(lib_default425(mu, sigma));
}
var main_default385 = stdev23;

var lib_default426 = main_default385;

function cdf26(x, r, p101) {
  var xint;
  if (lib_default(x) || lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  if (x === lib_default27) {
    return 1;
  }
  xint = lib_default23(x + 1e-7);
  return lib_default120(p101, r, xint + 1);
}
var main_default386 = cdf26;

function factory126(r, p101) {
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    var xint;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    if (x === lib_default27) {
      return 1;
    }
    xint = lib_default23(x + 1e-7);
    return lib_default120(p101, r, xint + 1);
  }
}
var factory_default126 = factory126;

main_default386.factory = factory_default126;
var lib_default427 = main_default386;

function kurtosis21(r, p101) {
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return 6 / r + p101 * p101 / ((1 - p101) * r);
}
var main_default387 = kurtosis21;

var lib_default428 = main_default387;

function mean25(r, p101) {
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return (1 - p101) * r / p101;
}
var main_default388 = mean25;

var lib_default429 = main_default388;

function mgf14(t, r, p101) {
  if (lib_default(t) || lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1 || t >= -lib_default12(p101)) {
    return NaN;
  }
  return lib_default47((1 - p101) * lib_default68(t) / (1 - p101 * lib_default68(t)), r);
}
var main_default389 = mgf14;

function factory127(r, p101) {
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (t >= -lib_default12(p101)) {
      return NaN;
    }
    return lib_default47((1 - p101) * lib_default68(t) / (1 - p101 * lib_default68(t)), r);
  }
}
var factory_default127 = factory127;

main_default389.factory = factory_default127;
var lib_default430 = main_default389;

function mode26(r, p101) {
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return lib_default23((1 - p101) * (r - 1) / p101);
}
var main_default390 = mode26;

var lib_default431 = main_default390;

function ibetaPowerTerms3(a, b, x, y, normalized) {
  var result;
  var smallA;
  var ratio;
  var agh;
  var bgh;
  var cgh;
  var l1;
  var l2;
  var l3;
  var p110;
  var b1;
  var b2;
  var c2;
  var l;
  if (!normalized) {
    return lib_default47(x, a) * lib_default47(y, b);
  }
  c2 = a + b;
  agh = a + lib_default94 - 0.5;
  bgh = b + lib_default94 - 0.5;
  cgh = c2 + lib_default94 - 0.5;
  result = lib_default108(c2);
  result /= lib_default108(a) * lib_default108(b);
  result *= lib_default2(bgh / lib_default79);
  result *= lib_default2(agh / cgh);
  l1 = (x * b - y * agh) / agh;
  l2 = (y * a - x * bgh) / bgh;
  if (lib_default85(lib_default29(l1), lib_default29(l2)) < 0.2) {
    if (l1 * l2 > 0 || lib_default85(a, b) < 1) {
      if (lib_default29(l1) < 0.1) {
        result *= lib_default68(a * lib_default78(l1));
      } else {
        result *= lib_default47(x * cgh / agh, a);
      }
      if (lib_default29(l2) < 0.1) {
        result *= lib_default68(b * lib_default78(l2));
      } else {
        result *= lib_default47(y * cgh / bgh, b);
      }
    } else if (lib_default83(lib_default29(l1), lib_default29(l2)) < 0.5) {
      smallA = a < b;
      ratio = b / a;
      if (smallA && ratio * l2 < 0.1 || !smallA && l1 / ratio > 0.1) {
        l3 = lib_default77(ratio * lib_default78(l2));
        l3 = l1 + l3 + l3 * l1;
        l3 = a * lib_default78(l3);
        result *= lib_default68(l3);
      } else {
        l3 = lib_default77(lib_default78(l1) / ratio);
        l3 = l2 + l3 + l3 * l2;
        l3 = b * lib_default78(l3);
        result *= lib_default68(l3);
      }
    } else if (lib_default29(l1) < lib_default29(l2)) {
      l = a * lib_default78(l1) + b * lib_default12(y * cgh / bgh);
      if (l <= lib_default103 || l >= lib_default99) {
        l += lib_default12(result);
        if (l >= lib_default99) {
          return NaN;
        }
        result = lib_default68(l);
      } else {
        result *= lib_default68(l);
      }
    } else {
      l = b * lib_default78(l2) + a * lib_default12(x * cgh / agh);
      if (l <= lib_default103 || l >= lib_default99) {
        l += lib_default12(result);
        if (l >= lib_default99) {
          return NaN;
        }
        result = lib_default68(l);
      } else {
        result *= lib_default68(l);
      }
    }
  } else {
    b1 = x * cgh / agh;
    b2 = y * cgh / bgh;
    l1 = a * lib_default12(b1);
    l2 = b * lib_default12(b2);
    if (l1 >= lib_default99 || l1 <= lib_default103 || l2 >= lib_default99 || l2 <= lib_default103) {
      if (a < b) {
        p110 = lib_default47(b2, b / a);
        l3 = a * (lib_default12(b1) + lib_default12(p110));
        if (l3 < lib_default99 && l3 > lib_default103) {
          result *= lib_default47(p110 * b1, a);
        } else {
          l2 += l1 + lib_default12(result);
          if (l2 >= lib_default99) {
            return NaN;
          }
          result = lib_default68(l2);
        }
      } else {
        p110 = lib_default47(b1, a / b);
        l3 = (lib_default12(p110) + lib_default12(b2)) * b;
        if (l3 < lib_default99 && l3 > lib_default103) {
          result *= lib_default47(p110 * b2, b);
        } else {
          l2 += l1 + lib_default12(result);
          if (l2 >= lib_default99) {
            return NaN;
          }
          result = lib_default68(l2);
        }
      }
    } else {
      result *= lib_default47(b1, a) * lib_default47(b2, b);
    }
  }
  return result;
}
var ibeta_power_terms_default3 = ibetaPowerTerms3;

function ibetaDerivative2(x, a, b) {
  var f1;
  var y;
  if (x === 1) {
    return 0;
  }
  f1 = ibeta_power_terms_default3(a, b, x, 1 - x, true);
  y = (1 - x) * x;
  f1 /= y;
  return f1;
}
var ibeta_derivative_default2 = ibetaDerivative2;

function pmf5(x, r, p101) {
  if (lib_default(x) || lib_default(r) || lib_default(p101) || r <= 0 || p101 <= 0 || p101 > 1) {
    return NaN;
  }
  if (!lib_default243(x) || p101 === 0) {
    return 0;
  }
  return p101 / (r + x) * ibeta_derivative_default2(p101, r, x + 1);
}
var main_default391 = pmf5;

function factory128(r, p101) {
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 <= 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  return pmf8;
  function pmf8(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (!lib_default243(x)) {
      return 0;
    }
    return p101 / (r + x) * ibeta_derivative_default2(p101, r, x + 1);
  }
}
var factory_default128 = factory128;

main_default391.factory = factory_default128;
var lib_default432 = main_default391;

var methods;
function searchLeft(x, k, r, p101) {
  while (true) {
    if (x === 0 || lib_default427(x - 1, r, p101) < k) {
      return x;
    }
    x -= 1;
  }
}
function searchRight(x, k, r, p101) {
  while (true) {
    x += 1;
    if (lib_default427(x, r, p101) >= k) {
      return x;
    }
  }
}
methods = {
  "left": searchLeft,
  "right": searchRight
};
var search_default = methods;

function quantile26(k, r, p101) {
  var sigmaInv;
  var guess;
  var sigma;
  var corr;
  var mu;
  var x2;
  var x;
  var q;
  if (lib_default(r) || lib_default(p101) || lib_default(k) || r <= 0 || p101 < 0 || p101 > 1 || k < 0 || k > 1) {
    return NaN;
  }
  if (k === 0) {
    return 0;
  }
  if (k === 1) {
    return lib_default27;
  }
  q = 1 - p101;
  mu = r * q / p101;
  sigma = lib_default2(r * q) / p101;
  sigmaInv = 1 / sigma;
  if (k < 0.5) {
    x = -lib_default132(2 * k) * lib_default134;
  } else {
    x = lib_default132(2 * (1 - k)) * lib_default134;
  }
  x2 = x * x;
  corr = x + sigmaInv * (x2 - 1) / 6;
  guess = lib_default53(mu + sigma * corr);
  return lib_default427(guess, r, p101) >= k ? search_default.left(guess, k, r, p101) : search_default.right(guess, k, r, p101);
}
var main_default392 = quantile26;

function factory129(r, p101) {
  var sigmaInv;
  var sigma;
  var mu;
  var q;
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return lib_default6(NaN);
  }
  q = 1 - p101;
  mu = r * q / p101;
  sigma = lib_default2(r * q) / p101;
  sigmaInv = (2 / p101 - 1) / sigma;
  return quantile35;
  function quantile35(k) {
    var guess;
    var corr;
    var x2;
    var x;
    if (lib_default(k) || k < 0 || k > 1) {
      return NaN;
    }
    if (k === 0) {
      return 0;
    }
    if (k === 1) {
      return lib_default27;
    }
    if (k < 0.5) {
      x = -lib_default132(2 * k) * lib_default134;
    } else {
      x = lib_default132(2 * (1 - k)) * lib_default134;
    }
    x2 = x * x;
    corr = x + sigmaInv * (x2 - 1) / 6;
    guess = lib_default53(mu + sigma * corr);
    return lib_default427(guess, r, p101) >= k ? search_default.left(guess, k, r, p101) : search_default.right(guess, k, r, p101);
  }
}
var factory_default129 = factory129;

main_default392.factory = factory_default129;
var lib_default433 = main_default392;

function skewness21(r, p101) {
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return (2 - p101) / lib_default2((1 - p101) * r);
}
var main_default393 = skewness21;

var lib_default434 = main_default393;

function stdev24(r, p101) {
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return lib_default2((1 - p101) * r) / p101;
}
var main_default394 = stdev24;

var lib_default435 = main_default394;

function variance23(r, p101) {
  if (lib_default(r) || lib_default(p101) || r <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return (1 - p101) * r / (p101 * p101);
}
var main_default395 = variance23;

var lib_default436 = main_default395;

function entropy23(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return 0.5 * lib_default12(lib_default107 * lib_default79 * sigma * sigma);
}
var main_default396 = entropy23;

var lib_default437 = main_default396;

function kurtosis22(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return 0;
}
var main_default397 = kurtosis22;

var lib_default438 = main_default397;

function logpdf21(x, mu, sigma) {
  var s2;
  var A2;
  var B;
  if (lib_default(x) || lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  if (sigma === 0) {
    return x === mu ? lib_default27 : lib_default11;
  }
  s2 = lib_default47(sigma, 2);
  A2 = -0.5 * (2 * lib_default12(sigma) + lib_default387);
  B = -1 / (2 * s2);
  return A2 + B * lib_default47(x - mu, 2);
}
var main_default398 = logpdf21;

var degenerate24 = lib_default187.factory;
function factory130(mu, sigma) {
  var s2;
  var A2;
  var B;
  if (lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate24(mu);
  }
  s2 = lib_default47(sigma, 2);
  A2 = -0.5 * (2 * lib_default12(sigma) + lib_default387);
  B = -1 / (2 * s2);
  return logpdf27;
  function logpdf27(x) {
    return A2 + B * lib_default47(x - mu, 2);
  }
}
var factory_default130 = factory130;

main_default398.factory = factory_default130;
var lib_default439 = main_default398;

function mean26(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return mu;
}
var main_default399 = mean26;

var lib_default440 = main_default399;

function median19(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return mu;
}
var main_default400 = median19;

var lib_default441 = main_default400;

function mgf15(t, mu, sigma) {
  if (lib_default(t) || lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return lib_default68(mu * t + 0.5 * lib_default47(sigma * t, 2));
}
var main_default401 = mgf15;

function factory131(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (lib_default(t)) {
      return NaN;
    }
    return lib_default68(mu * t + 0.5 * lib_default47(sigma * t, 2));
  }
}
var factory_default131 = factory131;

main_default401.factory = factory_default131;
var lib_default442 = main_default401;

function mode27(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return mu;
}
var main_default402 = mode27;

var lib_default443 = main_default402;

function pdf22(x, mu, sigma) {
  var s2;
  var A2;
  var B;
  if (lib_default(x) || lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  if (sigma === 0) {
    return x === mu ? lib_default27 : 0;
  }
  s2 = lib_default47(sigma, 2);
  A2 = 1 / lib_default2(s2 * lib_default107);
  B = -1 / (2 * s2);
  return A2 * lib_default68(B * lib_default47(x - mu, 2));
}
var main_default403 = pdf22;

var degenerate25 = lib_default190.factory;
function factory132(mu, sigma) {
  var s2;
  var A2;
  var B;
  if (lib_default(mu) || lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate25(mu);
  }
  s2 = lib_default47(sigma, 2);
  A2 = 1 / lib_default2(s2 * lib_default107);
  B = -1 / (2 * s2);
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return A2 * lib_default68(B * lib_default47(x - mu, 2));
  }
}
var factory_default132 = factory132;

main_default403.factory = factory_default132;
var lib_default444 = main_default403;

function skewness22(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return 0;
}
var main_default404 = skewness22;

var lib_default445 = main_default404;

function stdev25(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return sigma;
}
var main_default405 = stdev25;

var lib_default446 = main_default405;

function variance24(mu, sigma) {
  if (lib_default(mu) || lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return sigma * sigma;
}
var main_default406 = variance24;

var lib_default447 = main_default406;

function cdf27(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x < beta2) {
    return 0;
  }
  return 1 - lib_default47(beta2 / x, alpha);
}
var main_default407 = cdf27;

function factory133(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < beta2) {
      return 0;
    }
    return 1 - lib_default47(beta2 / x, alpha);
  }
}
var factory_default133 = factory133;

main_default407.factory = factory_default133;
var lib_default448 = main_default407;

function entropy24(alpha, beta2) {
  if (lib_default(alpha) || alpha <= 0 || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return lib_default12(beta2 / alpha * lib_default68(1 + 1 / alpha));
}
var main_default408 = entropy24;

var lib_default449 = main_default408;

function kurtosis23(alpha, beta2) {
  var out;
  if (lib_default(alpha) || alpha <= 4 || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  out = 6 * (lib_default47(alpha, 3) + lib_default47(alpha, 2) - 6 * alpha - 2);
  out /= alpha * (alpha - 3) * (alpha - 4);
  return out;
}
var main_default409 = kurtosis23;

var lib_default450 = main_default409;

function logcdf18(x, alpha, beta2) {
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x < beta2) {
    return lib_default11;
  }
  return lib_default78(-lib_default47(beta2 / x, alpha));
}
var main_default410 = logcdf18;

function factory134(alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < beta2) {
      return lib_default11;
    }
    return lib_default78(-lib_default47(beta2 / x, alpha));
  }
}
var factory_default134 = factory134;

main_default410.factory = factory_default134;
var lib_default451 = main_default410;

function logpdf22(x, alpha, beta2) {
  var denom;
  var num;
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x >= beta2) {
    num = lib_default12(alpha) + alpha * lib_default12(beta2);
    denom = (alpha + 1) * lib_default12(x);
    return num - denom;
  }
  return lib_default11;
}
var main_default411 = logpdf22;

function factory135(alpha, beta2) {
  var num;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  num = lib_default12(alpha) + alpha * lib_default12(beta2);
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x >= beta2) {
      return num - (alpha + 1) * lib_default12(x);
    }
    return lib_default11;
  }
}
var factory_default135 = factory135;

main_default411.factory = factory_default135;
var lib_default452 = main_default411;

function mean27(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (alpha <= 1) {
    return lib_default27;
  }
  return alpha * beta2 / (alpha - 1);
}
var main_default412 = mean27;

var lib_default453 = main_default412;

function median20(alpha, beta2) {
  if (alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  return beta2 * lib_default47(2, 1 / alpha);
}
var main_default413 = median20;

var lib_default454 = main_default413;

function mode28(alpha, beta2) {
  if (lib_default(alpha) || alpha <= 0 || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return beta2;
}
var main_default414 = mode28;

var lib_default455 = main_default414;

function pdf23(x, alpha, beta2) {
  var denom;
  var num;
  if (lib_default(x) || lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return NaN;
  }
  if (x >= beta2) {
    num = alpha * lib_default47(beta2, alpha);
    denom = lib_default47(x, alpha + 1);
    return num / denom;
  }
  return 0;
}
var main_default415 = pdf23;

function factory136(alpha, beta2) {
  var num;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  num = alpha * lib_default47(beta2, alpha);
  return pdf30;
  function pdf30(x) {
    var denom;
    if (lib_default(x)) {
      return NaN;
    }
    if (x >= beta2) {
      denom = lib_default47(x, alpha + 1);
      return num / denom;
    }
    return 0;
  }
}
var factory_default136 = factory136;

main_default415.factory = factory_default136;
var lib_default456 = main_default415;

function quantile27(p101, alpha, beta2) {
  if (lib_default(alpha) || lib_default(beta2) || lib_default(p101) || alpha <= 0 || beta2 <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return beta2 / lib_default47(1 - p101, 1 / alpha);
}
var main_default416 = quantile27;

function factory137(alpha, beta2) {
  var alphaInv;
  if (lib_default(alpha) || lib_default(beta2) || alpha <= 0 || beta2 <= 0) {
    return lib_default6(NaN);
  }
  alphaInv = 1 / alpha;
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return beta2 / lib_default47(1 - p101, alphaInv);
  }
}
var factory_default137 = factory137;

main_default416.factory = factory_default137;
var lib_default457 = main_default416;

function skewness23(alpha, beta2) {
  if (lib_default(alpha) || alpha <= 3 || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  return 2 * (1 + alpha) / (alpha - 3) * lib_default2((alpha - 2) / alpha);
}
var main_default417 = skewness23;

var lib_default458 = main_default417;

function variance25(alpha, beta2) {
  if (lib_default(alpha) || alpha <= 0 || lib_default(beta2) || beta2 <= 0) {
    return NaN;
  }
  if (alpha < 2) {
    return lib_default27;
  }
  return beta2 * beta2 * alpha / (lib_default47(alpha - 1, 2) * (alpha - 2));
}
var main_default418 = variance25;

var lib_default459 = main_default418;

function stdev26(alpha, beta2) {
  return lib_default2(lib_default459(alpha, beta2));
}
var main_default419 = stdev26;

var lib_default460 = main_default419;

function cdf28(x, lambda) {
  if (lib_default(x) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  if (x === lib_default27) {
    return 1;
  }
  return -lib_default77(-lambda * (lib_default23(x) + 1));
}
var main_default420 = cdf28;

function factory138(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    if (x === lib_default27) {
      return 1;
    }
    return -lib_default77(-lambda * (lib_default23(x) + 1));
  }
}
var factory_default138 = factory138;

main_default420.factory = factory_default138;
var lib_default461 = main_default420;

function entropy25(lambda) {
  var c2;
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  c2 = -lib_default77(-lambda);
  return lambda * lib_default68(-lambda) / c2 - lib_default12(c2);
}
var main_default421 = entropy25;

var lib_default462 = main_default421;

function cosh(x) {
  if (lib_default(x)) {
    return x;
  }
  if (x < 0) {
    x = -x;
  }
  if (x > 21) {
    return lib_default68(x) / 2;
  }
  return (lib_default68(x) + lib_default68(-x)) / 2;
}
var main_default422 = cosh;

var lib_default463 = main_default422;

function kurtosis24(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return 4 + 2 * lib_default463(lambda);
}
var main_default423 = kurtosis24;

var lib_default464 = main_default423;

function logcdf19(x, lambda) {
  if (lib_default(x) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  if (x < 0) {
    return lib_default11;
  }
  if (x === lib_default27) {
    return 0;
  }
  return lib_default12(-lib_default77(-lambda * (lib_default23(x) + 1)));
}
var main_default424 = logcdf19;

function factory139(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return lib_default11;
    }
    if (x === lib_default27) {
      return 0;
    }
    return lib_default12(-lib_default77(-lambda * (lib_default23(x) + 1)));
  }
}
var factory_default139 = factory139;

main_default424.factory = factory_default139;
var lib_default465 = main_default424;

function logpmf(x, lambda) {
  if (lib_default(x) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  if (lib_default243(x)) {
    return lib_default12(-lib_default77(-lambda)) - lambda * x;
  }
  return lib_default11;
}
var main_default425 = logpmf;

function factory140(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return lib_default6(NaN);
  }
  return logpmf4;
  function logpmf4(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (lib_default243(x)) {
      return lib_default12(-lib_default77(-lambda)) - lambda * x;
    }
    return lib_default11;
  }
}
var factory_default140 = factory140;

main_default425.factory = factory_default140;
var lib_default466 = main_default425;

function mean28(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return 1 / lib_default77(lambda);
}
var main_default426 = mean28;

var lib_default467 = main_default426;

function median21(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return lib_default66(-lib_default12(0.5) / lambda) - 1;
}
var main_default427 = median21;

var lib_default468 = main_default427;

function mgf16(t, lambda) {
  if (lib_default(t) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return lib_default77(-lambda) / lib_default77(t - lambda);
}
var main_default428 = mgf16;

function factory141(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    if (lib_default(t)) {
      return NaN;
    }
    return lib_default77(-lambda) / lib_default77(t - lambda);
  }
}
var factory_default141 = factory141;

main_default428.factory = factory_default141;
var lib_default469 = main_default428;

function mode29(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return 0;
}
var main_default429 = mode29;

var lib_default470 = main_default429;

function pmf6(x, lambda) {
  if (lib_default(x) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  if (lib_default243(x)) {
    return -lib_default77(-lambda) * lib_default68(-lambda * x);
  }
  return 0;
}
var main_default430 = pmf6;

function factory142(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return lib_default6(NaN);
  }
  return pmf8;
  function pmf8(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (lib_default243(x)) {
      return -lib_default77(-lambda) * lib_default68(-lambda * x);
    }
    return 0;
  }
}
var factory_default142 = factory142;

main_default430.factory = factory_default142;
var lib_default471 = main_default430;

function quantile28(p101, lambda) {
  if (lib_default(lambda) || lib_default(p101) || lambda <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (p101 === 1) {
    return lib_default27;
  }
  return lib_default66(-lib_default12(1 - p101) / lambda) - 1;
}
var main_default431 = quantile28;

function factory143(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    if (p101 === 1) {
      return lib_default27;
    }
    return lib_default66(-lib_default12(1 - p101) / lambda) - 1;
  }
}
var factory_default143 = factory143;

main_default431.factory = factory_default143;
var lib_default472 = main_default431;

function skewness24(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return 2 * lib_default463(lambda / 2);
}
var main_default432 = skewness24;

var lib_default473 = main_default432;

function stdev27(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return lib_default2(lib_default68(-lambda)) / lib_default29(lib_default77(-lambda));
}
var main_default433 = stdev27;

var lib_default474 = main_default433;

function variance26(lambda) {
  var temp;
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  temp = lib_default77(-lambda);
  return lib_default68(-lambda) / (temp * temp);
}
var main_default434 = variance26;

var lib_default475 = main_default434;

function cdf29(x, lambda) {
  if (lib_default(x) || lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  if (lambda === 0 || x === lib_default27) {
    return 1;
  }
  return lib_default113(lambda, lib_default23(x) + 1, true, true);
}
var main_default435 = cdf29;

var degenerate26 = lib_default179.factory;
function factory144(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return lib_default6(NaN);
  }
  if (lambda === 0) {
    return degenerate26(0);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    if (x === lib_default27) {
      return 1;
    }
    return lib_default113(lambda, lib_default23(x) + 1, true, true);
  }
}
var factory_default144 = factory144;

main_default435.factory = factory_default144;
var lib_default476 = main_default435;

function seriesClosure(lambda) {
  var lk;
  var k;
  k = 1;
  lk = lambda;
  return seriesElement;
  function seriesElement() {
    k += 1;
    lk *= lambda;
    return lk * lib_default336(k) / lib_default92(k);
  }
}
function entropy26(lambda) {
  var gen;
  var out;
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  if (lambda === 0) {
    return 0;
  }
  gen = seriesClosure(lambda);
  out = lambda * (1 - lib_default12(lambda));
  out += lib_default68(-lambda) * lib_default101(gen);
  return out;
}
var main_default436 = entropy26;

var lib_default477 = main_default436;

function kurtosis25(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return 1 / lambda;
}
var main_default437 = kurtosis25;

var lib_default478 = main_default437;

function logpmf2(x, lambda) {
  if (lib_default(x) || lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  if (lambda === 0) {
    return x === 0 ? 0 : lib_default11;
  }
  if (lib_default243(x) && x !== lib_default27) {
    return x * lib_default12(lambda) - lambda - lib_default336(x);
  }
  return lib_default11;
}
var main_default438 = logpmf2;

function logpmf3(x, mu) {
  if (lib_default(x) || lib_default(mu)) {
    return NaN;
  }
  return x === mu ? 0 : lib_default11;
}
var main_default439 = logpmf3;

function factory145(mu) {
  if (lib_default(mu)) {
    return lib_default6(NaN);
  }
  return logpmf4;
  function logpmf4(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return x === mu ? 0 : lib_default11;
  }
}
var factory_default145 = factory145;

main_default439.factory = factory_default145;
var lib_default479 = main_default439;

var degenerate27 = lib_default479.factory;
function factory146(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return lib_default6(NaN);
  }
  if (lambda === 0) {
    return degenerate27(0);
  }
  return logpmf4;
  function logpmf4(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (lib_default243(x) && x !== lib_default27) {
      return x * lib_default12(lambda) - lambda - lib_default336(x);
    }
    return lib_default11;
  }
}
var factory_default146 = factory146;

main_default438.factory = factory_default146;
var lib_default480 = main_default438;

function mean29(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return lambda;
}
var main_default440 = mean29;

var lib_default481 = main_default440;

function median22(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  if (lambda === 0) {
    return 0;
  }
  return lib_default23(lambda + 1 / 3 - 0.02 / lambda);
}
var main_default441 = median22;

var lib_default482 = main_default441;

function mgf17(t, lambda) {
  if (lib_default(t) || lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return lib_default68(lambda * (lib_default68(t) - 1));
}
var main_default442 = mgf17;

function factory147(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    return lib_default68(lambda * (lib_default68(t) - 1));
  }
}
var factory_default147 = factory147;

main_default442.factory = factory_default147;
var lib_default483 = main_default442;

function mode30(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return lib_default23(lambda);
}
var main_default443 = mode30;

var lib_default484 = main_default443;

function pmf7(x, lambda) {
  var lnl;
  if (lib_default(x) || lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  if (lambda === 0) {
    return x === 0 ? 1 : 0;
  }
  if (lib_default243(x) && x !== lib_default27) {
    lnl = x * lib_default12(lambda) - lambda - lib_default336(x);
    return lib_default68(lnl);
  }
  return 0;
}
var main_default444 = pmf7;

var degenerate28 = lib_default233.factory;
function factory148(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return lib_default6(NaN);
  }
  if (lambda === 0) {
    return degenerate28(0);
  }
  return pmf8;
  function pmf8(x) {
    var lnl;
    if (lib_default(x)) {
      return NaN;
    }
    if (lib_default243(x) && x !== lib_default27) {
      lnl = x * lib_default12(lambda) - lambda - lib_default336(x);
      return lib_default68(lnl);
    }
    return 0;
  }
}
var factory_default148 = factory148;

main_default444.factory = factory_default148;
var lib_default485 = main_default444;

var methods2;
function searchLeft2(x, p101, lambda) {
  while (true) {
    if (x === 0 || lib_default476(x - 1, lambda) < p101) {
      return x;
    }
    x -= 1;
  }
}
function searchRight2(x, p101, lambda) {
  while (true) {
    x += 1;
    if (lib_default476(x, lambda) >= p101) {
      return x;
    }
  }
}
methods2 = {
  "left": searchLeft2,
  "right": searchRight2
};
var search_default2 = methods2;

function quantile29(p101, lambda) {
  var sigmaInv;
  var guess;
  var sigma;
  var corr;
  var x2;
  var x;
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (lambda === 0) {
    return 0;
  }
  if (p101 === 0) {
    return 0;
  }
  if (p101 === 1) {
    return lib_default27;
  }
  sigma = lib_default2(lambda);
  sigmaInv = 1 / sigma;
  if (p101 < 0.5) {
    x = -lib_default132(2 * p101) * lib_default134;
  } else {
    x = lib_default132(2 * (1 - p101)) * lib_default134;
  }
  x2 = x * x;
  corr = x + sigmaInv * (x2 - 1) / 6;
  guess = lib_default53(lambda + sigma * corr);
  return lib_default476(guess, lambda) >= p101 ? search_default2.left(guess, p101, lambda) : search_default2.right(guess, p101, lambda);
}
var main_default445 = quantile29;

var degenerate29 = lib_default192.factory;
function factory149(lambda) {
  var sigmaInv;
  var sigma;
  if (lib_default(lambda) || lambda < 0) {
    return lib_default6(NaN);
  }
  if (lambda === 0) {
    return degenerate29(0);
  }
  sigma = lib_default2(lambda);
  sigmaInv = 1 / sigma;
  return quantile35;
  function quantile35(p101) {
    var guess;
    var corr;
    var x2;
    var x;
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    if (p101 === 0) {
      return 0;
    }
    if (p101 === 1) {
      return lib_default27;
    }
    if (p101 < 0.5) {
      x = -lib_default132(2 * p101) * lib_default134;
    } else {
      x = lib_default132(2 * (1 - p101)) * lib_default134;
    }
    x2 = x * x;
    corr = x + sigmaInv * (x2 - 1) / 6;
    guess = lib_default53(lambda + sigma * corr);
    return lib_default476(guess, lambda) >= p101 ? search_default2.left(guess, p101, lambda) : search_default2.right(guess, p101, lambda);
  }
}
var factory_default149 = factory149;

main_default445.factory = factory_default149;
var lib_default486 = main_default445;

function skewness25(lambda) {
  if (lib_default(lambda) || lambda <= 0) {
    return NaN;
  }
  return 1 / lib_default2(lambda);
}
var main_default446 = skewness25;

var lib_default487 = main_default446;

function variance27(lambda) {
  if (lib_default(lambda) || lambda < 0) {
    return NaN;
  }
  return lambda;
}
var main_default447 = variance27;

var lib_default488 = main_default447;

function stdev28(lambda) {
  return lib_default2(lib_default488(lambda));
}
var main_default448 = stdev28;

var lib_default489 = main_default448;

function cdf30(x, sigma) {
  var s2;
  if (lib_default(x) || lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  if (sigma === 0) {
    return x < 0 ? 0 : 1;
  }
  if (x < 0) {
    return 0;
  }
  s2 = lib_default47(sigma, 2);
  return 1 - lib_default68(-lib_default47(x, 2) / (2 * s2));
}
var main_default449 = cdf30;

var degenerate30 = lib_default179.factory;
function factory150(sigma) {
  var s2;
  if (lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate30(0);
  }
  s2 = lib_default47(sigma, 2);
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    return 1 - lib_default68(-lib_default47(x, 2) / (2 * s2));
  }
}
var factory_default150 = factory150;

main_default449.factory = factory_default150;
var lib_default490 = main_default449;

function entropy27(sigma) {
  if (lib_default(sigma) || sigma <= 0) {
    return NaN;
  }
  return 1 + lib_default12(sigma / lib_default134) + 0.5 * lib_default89;
}
var main_default450 = entropy27;

var lib_default491 = main_default450;

var KURTOSIS2 = -(6 * lib_default5 * lib_default5 - 24 * lib_default5 + 16) / ((4 - lib_default5) * (4 - lib_default5));
function kurtosis26(sigma) {
  if (lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  return KURTOSIS2;
}
var main_default451 = kurtosis26;

var lib_default492 = main_default451;

function logcdf20(x, sigma) {
  var s2;
  var p101;
  if (lib_default(x) || lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  if (sigma === 0) {
    return x < 0 ? lib_default11 : 0;
  }
  if (x < 0) {
    return lib_default11;
  }
  s2 = lib_default47(sigma, 2);
  p101 = -lib_default47(x, 2) / (2 * s2);
  return p101 < lib_default372 ? lib_default78(-lib_default68(p101)) : lib_default12(-lib_default77(p101));
}
var main_default452 = logcdf20;

var degenerate31 = lib_default213.factory;
function factory151(sigma) {
  var s2;
  if (lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate31(0);
  }
  s2 = lib_default47(sigma, 2);
  return logcdf24;
  function logcdf24(x) {
    var p101;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return lib_default11;
    }
    p101 = -lib_default47(x, 2) / (2 * s2);
    return p101 < lib_default372 ? lib_default78(-lib_default68(p101)) : lib_default12(-lib_default77(p101));
  }
}
var factory_default151 = factory151;

main_default452.factory = factory_default151;
var lib_default493 = main_default452;

function logpdf23(x, sigma) {
  var s2i;
  var s2;
  if (lib_default(x) || lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  if (sigma === 0) {
    return x === 0 ? lib_default27 : lib_default11;
  }
  if (x < 0 || x === lib_default27) {
    return lib_default11;
  }
  s2 = lib_default47(sigma, 2);
  s2i = 1 / s2;
  return lib_default12(s2i * x) - lib_default47(x, 2) / (2 * s2);
}
var main_default453 = logpdf23;

var degenerate32 = lib_default187.factory;
function factory152(sigma) {
  var s2i;
  var s2;
  if (lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate32(0);
  }
  s2 = lib_default47(sigma, 2);
  s2i = 1 / s2;
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0 || x === lib_default27) {
      return lib_default11;
    }
    return lib_default12(s2i * x) - lib_default47(x, 2) / (2 * s2);
  }
}
var factory_default152 = factory152;

main_default453.factory = factory_default152;
var lib_default494 = main_default453;

var SQRT_HALF_PI = 1.2533141373155003;
var lib_default495 = SQRT_HALF_PI;

function mean30(sigma) {
  if (lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  return sigma * lib_default495;
}
var main_default454 = mean30;

var lib_default496 = main_default454;

var SQRT2LN2 = 1.1774100225154747;
function median23(sigma) {
  if (lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  return sigma * SQRT2LN2;
}
var main_default455 = median23;

var lib_default497 = main_default455;

function evalpoly73(x) {
  if (x === 0) {
    return -0.3250421072470015;
  }
  return -0.3250421072470015 + x * (-0.02848174957559851 + x * (-0.005770270296489442 + x * -23763016656650163e-21));
}
var polyval_pp_default2 = evalpoly73;

function evalpoly74(x) {
  if (x === 0) {
    return 0.39791722395915535;
  }
  return 0.39791722395915535 + x * (0.0650222499887673 + x * (0.005081306281875766 + x * (13249473800432164e-20 + x * -3960228278775368e-21)));
}
var polyval_qq_default2 = evalpoly74;

function evalpoly75(x) {
  if (x === 0) {
    return 0.41485611868374833;
  }
  return 0.41485611868374833 + x * (-0.3722078760357013 + x * (0.31834661990116175 + x * (-0.11089469428239668 + x * (0.035478304325618236 + x * -0.002166375594868791))));
}
var polyval_pa_default2 = evalpoly75;

function evalpoly76(x) {
  if (x === 0) {
    return 0.10642088040084423;
  }
  return 0.10642088040084423 + x * (0.540397917702171 + x * (0.07182865441419627 + x * (0.12617121980876164 + x * (0.01363708391202905 + x * 0.011984499846799107))));
}
var polyval_qa_default2 = evalpoly76;

function evalpoly77(x) {
  if (x === 0) {
    return -0.6938585727071818;
  }
  return -0.6938585727071818 + x * (-10.558626225323291 + x * (-62.375332450326006 + x * (-162.39666946257347 + x * (-184.60509290671104 + x * (-81.2874355063066 + x * -9.814329344169145)))));
}
var polyval_ra_default2 = evalpoly77;

function evalpoly78(x) {
  if (x === 0) {
    return 19.651271667439257;
  }
  return 19.651271667439257 + x * (137.65775414351904 + x * (434.56587747522923 + x * (645.3872717332679 + x * (429.00814002756783 + x * (108.63500554177944 + x * (6.570249770319282 + x * -0.0604244152148581))))));
}
var polyval_sa_default2 = evalpoly78;

function evalpoly79(x) {
  if (x === 0) {
    return -0.799283237680523;
  }
  return -0.799283237680523 + x * (-17.757954917754752 + x * (-160.63638485582192 + x * (-637.5664433683896 + x * (-1025.0951316110772 + x * -483.5191916086514))));
}
var polyval_rb_default2 = evalpoly79;

function evalpoly80(x) {
  if (x === 0) {
    return 30.33806074348246;
  }
  return 30.33806074348246 + x * (325.7925129965739 + x * (1536.729586084437 + x * (3199.8582195085955 + x * (2553.0504064331644 + x * (474.52854120695537 + x * -22.44095244658582)))));
}
var polyval_sb_default2 = evalpoly80;

var TINY6 = 1e-300;
var VERY_TINY = 2848094538889218e-321;
var SMALL3 = 3725290298461914e-24;
var ERX2 = 0.8450629115104675;
var EFX = 0.1283791670955126;
var EFX8 = 1.0270333367641007;
var PPC2 = 0.12837916709551256;
var QQC2 = 1;
var PAC2 = -0.0023621185607526594;
var QAC2 = 1;
var RAC2 = -0.009864944034847148;
var SAC2 = 1;
var RBC2 = -0.0098649429247001;
var SBC2 = 1;
function erf(x) {
  var sign;
  var ax;
  var z;
  var r;
  var s;
  var y;
  var p101;
  var q;
  if (lib_default(x)) {
    return NaN;
  }
  if (x === lib_default27) {
    return 1;
  }
  if (x === lib_default11) {
    return -1;
  }
  if (x === 0) {
    return x;
  }
  if (x < 0) {
    sign = true;
    ax = -x;
  } else {
    sign = false;
    ax = x;
  }
  if (ax < 0.84375) {
    if (ax < SMALL3) {
      if (ax < VERY_TINY) {
        return 0.125 * (8 * x + EFX8 * x);
      }
      return x + EFX * x;
    }
    z = x * x;
    r = PPC2 + z * polyval_pp_default2(z);
    s = QQC2 + z * polyval_qq_default2(z);
    y = r / s;
    return x + x * y;
  }
  if (ax < 1.25) {
    s = ax - 1;
    p101 = PAC2 + s * polyval_pa_default2(s);
    q = QAC2 + s * polyval_qa_default2(s);
    if (sign) {
      return -ERX2 - p101 / q;
    }
    return ERX2 + p101 / q;
  }
  if (ax >= 6) {
    if (sign) {
      return TINY6 - 1;
    }
    return 1 - TINY6;
  }
  s = 1 / (ax * ax);
  if (ax < 2.857142857142857) {
    r = RAC2 + s * polyval_ra_default2(s);
    s = SAC2 + s * polyval_sa_default2(s);
  } else {
    r = RBC2 + s * polyval_rb_default2(s);
    s = SBC2 + s * polyval_sb_default2(s);
  }
  z = lib_default31(ax, 0);
  r = lib_default68(-(z * z) - 0.5625) * lib_default68((z - ax) * (z + ax) + r / s);
  if (sign) {
    return r / ax - 1;
  }
  return 1 - r / ax;
}
var main_default456 = erf;

var lib_default498 = main_default456;

function mgf18(t, sigma) {
  var sigmat;
  var out;
  if (lib_default(t) || lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  sigmat = t * sigma;
  out = 1 + sigmat * lib_default68(sigmat * sigmat / 2);
  out *= lib_default495 * (lib_default498(sigmat / lib_default134) + 1);
  return out;
}
var main_default457 = mgf18;

function factory153(sigma) {
  if (lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    var sigmat;
    var ret;
    if (lib_default(t)) {
      return NaN;
    }
    sigmat = t * sigma;
    ret = 1 + sigmat * lib_default68(sigmat * sigmat / 2);
    ret *= lib_default495 * (lib_default498(sigmat / lib_default134) + 1);
    return ret;
  }
}
var factory_default153 = factory153;

main_default457.factory = factory_default153;
var lib_default499 = main_default457;

function mode31(sigma) {
  if (lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  return sigma;
}
var main_default458 = mode31;

var lib_default500 = main_default458;

function pdf24(x, sigma) {
  var s2i;
  var s2;
  if (lib_default(x) || lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  if (sigma === 0) {
    return x === 0 ? lib_default27 : 0;
  }
  if (x < 0 || x === lib_default27) {
    return 0;
  }
  s2 = lib_default47(sigma, 2);
  s2i = 1 / s2;
  return s2i * x * lib_default68(-lib_default47(x, 2) / (2 * s2));
}
var main_default459 = pdf24;

var degenerate33 = lib_default190.factory;
function factory154(sigma) {
  var s2i;
  var s2;
  if (lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate33(0);
  }
  s2 = lib_default47(sigma, 2);
  s2i = 1 / s2;
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0 || x === lib_default27) {
      return 0;
    }
    return s2i * x * lib_default68(-lib_default47(x, 2) / (2 * s2));
  }
}
var factory_default154 = factory154;

main_default459.factory = factory_default154;
var lib_default501 = main_default459;

function quantile30(p101, sigma) {
  var s2;
  if (lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (sigma === 0) {
    return 0;
  }
  s2 = sigma * sigma;
  return lib_default2(-2 * s2 * lib_default78(-p101));
}
var main_default460 = quantile30;

var degenerate34 = lib_default192.factory;
function factory155(sigma) {
  var s2;
  if (lib_default(sigma) || sigma < 0) {
    return lib_default6(NaN);
  }
  if (sigma === 0) {
    return degenerate34(0);
  }
  s2 = sigma * sigma;
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return lib_default2(-2 * s2 * lib_default78(-p101));
  }
}
var factory_default155 = factory155;

main_default460.factory = factory_default155;
var lib_default502 = main_default460;

var SQRT_PI = 1.772453850905516;
var lib_default503 = SQRT_PI;

var SKEWNESS2 = 2 * lib_default503 * (lib_default5 - 3) / lib_default47(4 - lib_default5, 1.5);
function skewness26(sigma) {
  if (lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  return SKEWNESS2;
}
var main_default461 = skewness26;

var lib_default504 = main_default461;

var SQRT4MPI = lib_default2(4 - lib_default5);
function stdev29(sigma) {
  if (lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  return SQRT4MPI * sigma / lib_default134;
}
var main_default462 = stdev29;

var lib_default505 = main_default462;

function variance28(sigma) {
  if (lib_default(sigma) || sigma < 0) {
    return NaN;
  }
  return (4 - lib_default5) * sigma * sigma / 2;
}
var main_default463 = variance28;

var lib_default506 = main_default463;

function isfinite(x) {
  return x === x && x > lib_default11 && x < lib_default27;
}
var main_default464 = isfinite;

var lib_default507 = main_default464;

var RE = /./;
var re_default = RE;

function isNumber(value) {
  return typeof value === "number";
}
var is_number_default = isNumber;

function startsWithMinus(str) {
  return str[0] === "-";
}
function zeros2(n) {
  var out = "";
  var i;
  for (i = 0; i < n; i++) {
    out += "0";
  }
  return out;
}
function zeroPad(str, width, right) {
  var negative = false;
  var pad = width - str.length;
  if (pad < 0) {
    return str;
  }
  if (startsWithMinus(str)) {
    negative = true;
    str = str.substr(1);
  }
  str = right ? str + zeros2(pad) : zeros2(pad) + str;
  if (negative) {
    str = "-" + str;
  }
  return str;
}
var zero_pad_default = zeroPad;

var lowercase = String.prototype.toLowerCase;
var uppercase = String.prototype.toUpperCase;
function formatInteger(token) {
  var base;
  var out;
  var i;
  switch (token.specifier) {
    case "b":
      base = 2;
      break;
    case "o":
      base = 8;
      break;
    case "x":
    case "X":
      base = 16;
      break;
    case "d":
    case "i":
    case "u":
    default:
      base = 10;
      break;
  }
  out = token.arg;
  i = parseInt(out, 10);
  if (!isFinite(i)) {
    if (!is_number_default(out)) {
      throw new Error("invalid integer. Value: " + out);
    }
    i = 0;
  }
  if (i < 0 && (token.specifier === "u" || base !== 10)) {
    i = 4294967295 + i + 1;
  }
  if (i < 0) {
    out = (-i).toString(base);
    if (token.precision) {
      out = zero_pad_default(out, token.precision, token.padRight);
    }
    out = "-" + out;
  } else {
    out = i.toString(base);
    if (!i && !token.precision) {
      out = "";
    } else if (token.precision) {
      out = zero_pad_default(out, token.precision, token.padRight);
    }
    if (token.sign) {
      out = token.sign + out;
    }
  }
  if (base === 16) {
    if (token.alternate) {
      out = "0x" + out;
    }
    out = token.specifier === uppercase.call(token.specifier) ? uppercase.call(out) : lowercase.call(out);
  }
  if (base === 8) {
    if (token.alternate && out.charAt(0) !== "0") {
      out = "0" + out;
    }
  }
  return out;
}
var format_integer_default = formatInteger;

function isString(value) {
  return typeof value === "string";
}
var is_string_default = isString;

var abs3 = Math.abs;
var lowercase2 = String.prototype.toLowerCase;
var uppercase2 = String.prototype.toUpperCase;
var replace = String.prototype.replace;
var RE_EXP_POS_DIGITS = /e\+(\d)$/;
var RE_EXP_NEG_DIGITS = /e-(\d)$/;
var RE_ONLY_DIGITS = /^(\d+)$/;
var RE_DIGITS_BEFORE_EXP = /^(\d+)e/;
var RE_TRAILING_PERIOD_ZERO = /\.0$/;
var RE_PERIOD_ZERO_EXP = /\.0*e/;
var RE_ZERO_BEFORE_EXP = /(\..*[^0])0*e/;
function formatDouble(f2, token) {
  var digits;
  var out;
  switch (token.specifier) {
    case "e":
    case "E":
      out = f2.toExponential(token.precision);
      break;
    case "f":
    case "F":
      out = f2.toFixed(token.precision);
      break;
    case "g":
    case "G":
      if (abs3(f2) < 1e-4) {
        digits = token.precision;
        if (digits > 0) {
          digits -= 1;
        }
        out = f2.toExponential(digits);
      } else {
        out = f2.toPrecision(token.precision);
      }
      if (!token.alternate) {
        out = replace.call(out, RE_ZERO_BEFORE_EXP, "$1e");
        out = replace.call(out, RE_PERIOD_ZERO_EXP, "e");
        out = replace.call(out, RE_TRAILING_PERIOD_ZERO, "");
      }
      break;
    default:
      throw new Error("invalid double notation. Value: " + token.specifier);
  }
  out = replace.call(out, RE_EXP_POS_DIGITS, "e+0$1");
  out = replace.call(out, RE_EXP_NEG_DIGITS, "e-0$1");
  if (token.alternate) {
    out = replace.call(out, RE_ONLY_DIGITS, "$1.");
    out = replace.call(out, RE_DIGITS_BEFORE_EXP, "$1.e");
  }
  if (f2 >= 0 && token.sign) {
    out = token.sign + out;
  }
  out = token.specifier === uppercase2.call(token.specifier) ? uppercase2.call(out) : lowercase2.call(out);
  return out;
}
var format_double_default = formatDouble;

function spaces(n) {
  var out = "";
  var i;
  for (i = 0; i < n; i++) {
    out += " ";
  }
  return out;
}
function spacePad(str, width, right) {
  var pad = width - str.length;
  if (pad < 0) {
    return str;
  }
  str = right ? str + spaces(pad) : spaces(pad) + str;
  return str;
}
var space_pad_default = spacePad;

var fromCharCode = String.fromCharCode;
var isArray = Array.isArray;
function isnan2(value) {
  return value !== value;
}
function initialize(token) {
  var out = {};
  out.specifier = token.specifier;
  out.precision = token.precision === void 0 ? 1 : token.precision;
  out.width = token.width;
  out.flags = token.flags || "";
  out.mapping = token.mapping;
  return out;
}
function formatInterpolate(tokens) {
  var hasPeriod;
  var flags;
  var token;
  var flag;
  var num;
  var out;
  var pos;
  var f2;
  var i;
  var j;
  if (!isArray(tokens)) {
    throw new TypeError("invalid argument. First argument must be an array. Value: `" + tokens + "`.");
  }
  out = "";
  pos = 1;
  for (i = 0; i < tokens.length; i++) {
    token = tokens[i];
    if (is_string_default(token)) {
      out += token;
    } else {
      hasPeriod = token.precision !== void 0;
      token = initialize(token);
      if (!token.specifier) {
        throw new TypeError("invalid argument. Token is missing `specifier` property. Index: `" + i + "`. Value: `" + token + "`.");
      }
      if (token.mapping) {
        pos = token.mapping;
      }
      flags = token.flags;
      for (j = 0; j < flags.length; j++) {
        flag = flags.charAt(j);
        switch (flag) {
          case " ":
            token.sign = " ";
            break;
          case "+":
            token.sign = "+";
            break;
          case "-":
            token.padRight = true;
            token.padZeros = false;
            break;
          case "0":
            token.padZeros = flags.indexOf("-") < 0;
            break;
          case "#":
            token.alternate = true;
            break;
          default:
            throw new Error("invalid flag: " + flag);
        }
      }
      if (token.width === "*") {
        token.width = parseInt(arguments[pos], 10);
        pos += 1;
        if (isnan2(token.width)) {
          throw new TypeError("the argument for * width at position " + pos + " is not a number. Value: `" + token.width + "`.");
        }
        if (token.width < 0) {
          token.padRight = true;
          token.width = -token.width;
        }
      }
      if (hasPeriod) {
        if (token.precision === "*") {
          token.precision = parseInt(arguments[pos], 10);
          pos += 1;
          if (isnan2(token.precision)) {
            throw new TypeError("the argument for * precision at position " + pos + " is not a number. Value: `" + token.precision + "`.");
          }
          if (token.precision < 0) {
            token.precision = 1;
            hasPeriod = false;
          }
        }
      }
      token.arg = arguments[pos];
      switch (token.specifier) {
        case "b":
        case "o":
        case "x":
        case "X":
        case "d":
        case "i":
        case "u":
          if (hasPeriod) {
            token.padZeros = false;
          }
          token.arg = format_integer_default(token);
          break;
        case "s":
          token.maxWidth = hasPeriod ? token.precision : -1;
          token.arg = String(token.arg);
          break;
        case "c":
          if (!isnan2(token.arg)) {
            num = parseInt(token.arg, 10);
            if (num < 0 || num > 127) {
              throw new Error("invalid character code. Value: " + token.arg);
            }
            token.arg = isnan2(num) ? String(token.arg) : fromCharCode(num);
          }
          break;
        case "e":
        case "E":
        case "f":
        case "F":
        case "g":
        case "G":
          if (!hasPeriod) {
            token.precision = 6;
          }
          f2 = parseFloat(token.arg);
          if (!isFinite(f2)) {
            if (!is_number_default(token.arg)) {
              throw new Error("invalid floating-point number. Value: " + out);
            }
            f2 = token.arg;
            token.padZeros = false;
          }
          token.arg = format_double_default(f2, token);
          break;
        default:
          throw new Error("invalid specifier: " + token.specifier);
      }
      if (token.maxWidth >= 0 && token.arg.length > token.maxWidth) {
        token.arg = token.arg.substring(0, token.maxWidth);
      }
      if (token.padZeros) {
        token.arg = zero_pad_default(token.arg, token.width || token.precision, token.padRight);
      } else if (token.width) {
        token.arg = space_pad_default(token.arg, token.width, token.padRight);
      }
      out += token.arg || "";
      pos += 1;
    }
  }
  return out;
}
var main_default465 = formatInterpolate;

var lib_default508 = main_default465;

var RE2 = /%(?:([1-9]\d*)\$)?([0 +\-#]*)(\*|\d+)?(?:(\.)(\*|\d+)?)?[hlL]?([%A-Za-z])/g;
function parse(match) {
  var token = {
    "mapping": match[1] ? parseInt(match[1], 10) : void 0,
    "flags": match[2],
    "width": match[3],
    "precision": match[5],
    "specifier": match[6]
  };
  if (match[4] === "." && match[5] === void 0) {
    token.precision = "1";
  }
  return token;
}
function formatTokenize(str) {
  var content;
  var tokens;
  var match;
  var prev;
  tokens = [];
  prev = 0;
  match = RE2.exec(str);
  while (match) {
    content = str.slice(prev, RE2.lastIndex - match[0].length);
    if (content.length) {
      tokens.push(content);
    }
    if (match[6] === "%") {
      tokens.push("%");
    } else {
      tokens.push(parse(match));
    }
    prev = RE2.lastIndex;
    match = RE2.exec(str);
  }
  content = str.slice(prev);
  if (content.length) {
    tokens.push(content);
  }
  return tokens;
}
var main_default466 = formatTokenize;

var lib_default509 = main_default466;

function isString2(value) {
  return typeof value === "string";
}
var is_string_default2 = isString2;

function format(str) {
  var args;
  var i;
  if (!is_string_default2(str)) {
    throw new TypeError(format("invalid argument. First argument must be a string. Value: `%s`.", str));
  }
  args = [lib_default509(str)];
  for (i = 1; i < arguments.length; i++) {
    args.push(arguments[i]);
  }
  return lib_default508.apply(null, args);
}
var main_default467 = format;

var lib_default510 = main_default467;

function getGlobal() {
  return new Function("return this;")();
}
var codegen_default = getGlobal;

var obj = typeof self === "object" ? self : null;
var self_default = obj;

var obj2 = typeof window === "object" ? window : null;
var window_default = obj2;

var obj3 = typeof global === "object" ? global : null;
var global_default = obj3;

var obj4 = typeof globalThis === "object" ? globalThis : null;
var global_this_default = obj4;

function isBoolean(value) {
  return typeof value === "boolean";
}
var primitive_default = isBoolean;

var has_tostringtag_support_default = () => true;

var toStr = Object.prototype.toString;
var tostring_default = toStr;

function nativeClass(v) {
  return tostring_default.call(v);
}
var main_default468 = nativeClass;

var has = Object.prototype.hasOwnProperty;
function hasOwnProp(value, property) {
  if (value === void 0 || value === null) {
    return false;
  }
  return has.call(value, property);
}
var main_default469 = hasOwnProp;

var lib_default511 = main_default469;

var Sym = typeof Symbol === "function" ? Symbol : void 0;
var main_default470 = Sym;

var lib_default512 = main_default470;

var toStrTag = typeof lib_default512 === "function" ? lib_default512.toStringTag : "";
var tostringtag_default = toStrTag;

function nativeClass2(v) {
  var isOwn;
  var tag;
  var out;
  if (v === null || v === void 0) {
    return tostring_default.call(v);
  }
  tag = v[tostringtag_default];
  isOwn = lib_default511(v, tostringtag_default);
  try {
    v[tostringtag_default] = void 0;
  } catch (err) {
    return tostring_default.call(v);
  }
  out = tostring_default.call(v);
  if (isOwn) {
    v[tostringtag_default] = tag;
  } else {
    delete v[tostringtag_default];
  }
  return out;
}
var polyfill_default = nativeClass2;

var main;
if (has_tostringtag_support_default()) {
  main = polyfill_default;
} else {
  main = main_default468;
}
var lib_default513 = main;

var Bool = Boolean;
var main_default471 = Bool;

var lib_default514 = main_default471;

var toString = Boolean.prototype.toString;
var tostring_default2 = toString;

var toString2 = tostring_default2;
function test(value) {
  try {
    toString2.call(value);
    return true;
  } catch (err) {
    return false;
  }
}
var try2serialize_default = test;

var FLG = has_tostringtag_support_default();
function isBoolean2(value) {
  if (typeof value === "object") {
    if (value instanceof lib_default514) {
      return true;
    }
    if (FLG) {
      return try2serialize_default(value);
    }
    return lib_default513(value) === "[object Boolean]";
  }
  return false;
}
var object_default = isBoolean2;

function isBoolean3(value) {
  return primitive_default(value) || object_default(value);
}
var main_default472 = isBoolean3;

main_default472.isPrimitive = primitive_default;
main_default472.isObject = object_default;
var lib_default515 = main_default472;

var isBoolean4 = lib_default515.isPrimitive;
function getGlobal2(codegen) {
  if (arguments.length) {
    if (!isBoolean4(codegen)) {
      throw new TypeError(lib_default510("invalid argument. Must provide a boolean. Value: `%s`.", codegen));
    }
    if (codegen) {
      return codegen_default();
    }
  }
  if (global_this_default) {
    return global_this_default;
  }
  if (self_default) {
    return self_default;
  }
  if (window_default) {
    return window_default;
  }
  if (global_default) {
    return global_default;
  }
  throw new Error("unexpected error. Unable to resolve global object.");
}
var main_default473 = getGlobal2;

var lib_default516 = main_default473;

var root = lib_default516();
var nodeList = root.document && root.document.childNodes;
var nodelist_default = nodeList;

var typedarray = Int8Array;
var typedarray_default = typedarray;

function check() {
  if (typeof re_default === "function" || typeof typedarray_default === "object" || typeof nodelist_default === "function") {
    return true;
  }
  return false;
}
var check_default = check;

var f;
function isArray2(value) {
  return lib_default513(value) === "[object Array]";
}
if (Array.isArray) {
  f = Array.isArray;
} else {
  f = isArray2;
}
var main_default474 = f;

var lib_default517 = main_default474;

function arrayfcn(predicate) {
  if (typeof predicate !== "function") {
    throw new TypeError(lib_default510("invalid argument. Must provide a function. Value: `%s`.", predicate));
  }
  return every;
  function every(value) {
    var len;
    var i;
    if (!lib_default517(value)) {
      return false;
    }
    len = value.length;
    if (len === 0) {
      return false;
    }
    for (i = 0; i < len; i++) {
      if (predicate(value[i]) === false) {
        return false;
      }
    }
    return true;
  }
}
var main_default475 = arrayfcn;

var lib_default518 = main_default475;

function isObjectLike(value) {
  return value !== null && typeof value === "object";
}
var main_default476 = isObjectLike;

var isObjectLikeArray = lib_default518(main_default476);
main_default476.isObjectLikeArray = isObjectLikeArray;
var lib_default519 = main_default476;

function isBuffer(value) {
  return lib_default519(value) && (value._isBuffer || // for envs missing Object.prototype.constructor (e.g., Safari 5-7)
  value.constructor && typeof value.constructor.isBuffer === "function" && value.constructor.isBuffer(value));
}
var main_default477 = isBuffer;

var lib_default520 = main_default477;

function reFunctionName() {
  return /^\s*function\s*([^(]*)/i;
}
var main_default478 = reFunctionName;

var RE_FUNCTION_NAME = main_default478();
var regexp_default = RE_FUNCTION_NAME;

main_default478.REGEXP = regexp_default;
var lib_default521 = main_default478;

var RE3 = lib_default521.REGEXP;
function constructorName(v) {
  var match;
  var name;
  var ctor;
  name = lib_default513(v).slice(8, -1);
  if ((name === "Object" || name === "Error") && v.constructor) {
    ctor = v.constructor;
    if (typeof ctor.name === "string") {
      return ctor.name;
    }
    match = RE3.exec(ctor.toString());
    if (match) {
      return match[1];
    }
  }
  if (lib_default520(v)) {
    return "Buffer";
  }
  return name;
}
var main_default479 = constructorName;

var lib_default522 = main_default479;

function typeOf(v) {
  var type;
  if (v === null) {
    return "null";
  }
  type = typeof v;
  if (type === "object") {
    return lib_default522(v).toLowerCase();
  }
  return type;
}
var main_default480 = typeOf;

function typeOf2(v) {
  return lib_default522(v).toLowerCase();
}
var polyfill_default2 = typeOf2;

var main2 = check_default() ? polyfill_default2 : main_default480;
var lib_default523 = main2;

function isFunction(value) {
  return lib_default523(value) === "function";
}
var main_default481 = isFunction;

var lib_default524 = main_default481;

function identity(x) {
  return x;
}
var main_default482 = identity;

var lib_default525 = main_default482;

function memoize(fcn, hashFunction) {
  var toKey;
  var cache;
  if (!lib_default524(fcn)) {
    throw new TypeError(lib_default510("invalid argument. First argument must be a function. Value: `%s`.", fcn));
  }
  if (arguments.length < 2) {
    toKey = lib_default525;
  } else {
    toKey = hashFunction;
    if (!lib_default524(toKey)) {
      throw new TypeError(lib_default510("invalid argument. Hash function argument must be a function. Value: `%s`.", toKey));
    }
  }
  cache = {};
  memoized4.cache = cache;
  return memoized4;
  function memoized4() {
    var args;
    var out;
    var key;
    var i;
    args = [];
    for (i = 0; i < arguments.length; i++) {
      args.push(arguments[i]);
    }
    key = toKey(args).toString();
    if (lib_default511(cache, key)) {
      return cache[key];
    }
    out = fcn.apply(null, args);
    cache[key] = out;
    return out;
  }
}
var main_default483 = memoize;

var lib_default526 = main_default483;

var memoized;
function weights(x, n) {
  var mlim;
  if (n === 0) {
    return x === 0 ? 1 : 0;
  }
  mlim = n * (n + 1) / 2;
  if (x < 0 || x > mlim) {
    return 0;
  }
  if (x > mlim / 2) {
    x = mlim - x;
  }
  return memoized(x - n, n - 1) + memoized(x, n - 1);
}
memoized = lib_default526(weights);
var weights_default = memoized;

function cdf31(x, n) {
  var mlim;
  var pui;
  var i;
  var p101;
  if (lib_default(x) || !lib_default245(n) || !lib_default507(n)) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  x = lib_default53(x);
  mlim = n * (n + 1) / 2;
  if (x >= mlim) {
    return 1;
  }
  pui = lib_default68(-n * lib_default16);
  p101 = 0;
  for (i = 0; i <= x; i++) {
    p101 += weights_default(i, n) * pui;
  }
  return p101;
}
var main_default484 = cdf31;

function factory156(n) {
  var mlim;
  var pui;
  if (!lib_default245(n) || !lib_default507(n)) {
    return lib_default6(NaN);
  }
  pui = lib_default68(-n * lib_default16);
  mlim = n * (n + 1) / 2;
  return cdf35;
  function cdf35(x) {
    var i;
    var p101;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    x = lib_default53(x);
    if (x >= mlim) {
      return 1;
    }
    p101 = 0;
    for (i = 0; i <= x; i++) {
      p101 += weights_default(i, n) * pui;
    }
    return p101;
  }
}
var factory_default156 = factory156;

main_default484.factory = factory_default156;
var lib_default527 = main_default484;

var memoized2;
function weights2(x, n) {
  var mlim;
  if (n === 0) {
    return x === 0 ? 1 : 0;
  }
  mlim = n * (n + 1) / 2;
  if (x < 0 || x > mlim) {
    return 0;
  }
  if (x > mlim / 2) {
    x = mlim - x;
  }
  return memoized2(x - n, n - 1) + memoized2(x, n - 1);
}
memoized2 = lib_default526(weights2);
var weights_default2 = memoized2;

function pdf25(x, n) {
  var mlim;
  if (lib_default(x) || !lib_default245(n) || !lib_default507(n)) {
    return NaN;
  }
  if (!lib_default24(x)) {
    return 0;
  }
  mlim = n * (n + 1) / 2;
  if (x < 0 || x > mlim) {
    return 0;
  }
  return lib_default68(lib_default12(weights_default2(x, n)) - n * lib_default16);
}
var main_default485 = pdf25;

function factory157(n) {
  var mlim;
  if (!lib_default245(n) || !lib_default507(n)) {
    return lib_default6(NaN);
  }
  mlim = n * (n + 1) / 2;
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (!lib_default24(x)) {
      return 0;
    }
    if (x < 0 || x > mlim) {
      return 0;
    }
    return lib_default68(lib_default12(weights_default2(x, n)) - n * lib_default16);
  }
}
var factory_default157 = factory157;

main_default485.factory = factory_default157;
var lib_default528 = main_default485;

var memoized3;
function weights3(x, n) {
  var mlim;
  if (n === 0) {
    return x === 0 ? 1 : 0;
  }
  mlim = n * (n + 1) / 2;
  if (x < 0 || x > mlim) {
    return 0;
  }
  if (x > mlim / 2) {
    x = mlim - x;
  }
  return memoized3(x - n, n - 1) + memoized3(x, n - 1);
}
memoized3 = lib_default526(weights3);
var weights_default3 = memoized3;

function quantile31(p101, n) {
  var pui;
  var q;
  var r;
  if (lib_default(n) || !lib_default245(n) || !lib_default507(n)) {
    return NaN;
  }
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (p101 === 0) {
    return 0;
  }
  if (p101 === 1) {
    return n * (n + 1) / 2;
  }
  pui = lib_default68(-n * lib_default16);
  r = 0;
  q = -1;
  while (r < p101) {
    q += 1;
    r += pui * weights_default3(q, n);
  }
  return q;
}
var main_default486 = quantile31;

function factory158(n) {
  var pui;
  if (lib_default(n) || !lib_default245(n) || !lib_default507(n)) {
    return lib_default6(NaN);
  }
  pui = lib_default68(-n * lib_default16);
  return quantile35;
  function quantile35(p101) {
    var r;
    var q;
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    if (p101 === 0) {
      return 0;
    }
    if (p101 === 1) {
      return n * (n + 1) / 2;
    }
    r = 0;
    q = -1;
    while (r < p101) {
      q += 1;
      r += pui * weights_default3(q, n);
    }
    return q;
  }
}
var factory_default158 = factory158;

main_default486.factory = factory_default158;
var lib_default529 = main_default486;

function cdf32(x, v) {
  var x2;
  var p101;
  var z;
  if (lib_default(x) || lib_default(v) || v <= 0) {
    return NaN;
  }
  if (x === 0) {
    return 0.5;
  }
  x2 = lib_default47(x, 2);
  if (v > 2 * x2) {
    z = x2 / (v + x2);
    p101 = lib_default120(z, 0.5, v / 2, true, true) / 2;
  } else {
    z = v / (v + x2);
    p101 = lib_default120(z, v / 2, 0.5, true, false) / 2;
  }
  return x > 0 ? 1 - p101 : p101;
}
var main_default487 = cdf32;

function factory159(v) {
  if (lib_default(v) || v <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    var x2;
    var p101;
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x === 0) {
      return 0.5;
    }
    x2 = lib_default47(x, 2);
    if (v > 2 * x2) {
      z = x2 / (v + x2);
      p101 = lib_default120(z, 0.5, v / 2, true, true) / 2;
    } else {
      z = v / (v + x2);
      p101 = lib_default120(z, v / 2, 0.5, true, false) / 2;
    }
    return x > 0 ? 1 - p101 : p101;
  }
}
var factory_default159 = factory159;

main_default487.factory = factory_default159;
var lib_default530 = main_default487;

function entropy28(v) {
  var out;
  var vh;
  if (lib_default(v) || v <= 0) {
    return NaN;
  }
  vh = v / 2;
  out = (v + 1) / 2;
  out *= lib_default124((1 + v) / 2) - lib_default124(vh);
  out += lib_default12(lib_default2(v) * lib_default81(vh, 0.5));
  return out;
}
var main_default488 = entropy28;

var lib_default531 = main_default488;

function kurtosis27(v) {
  if (lib_default(v) || v <= 2) {
    return NaN;
  }
  if (v <= 4) {
    return lib_default27;
  }
  return 6 / (v - 4);
}
var main_default489 = kurtosis27;

var lib_default532 = main_default489;

function logcdf21(x, v) {
  var x2;
  var p101;
  var z;
  if (lib_default(x) || lib_default(v) || v <= 0) {
    return NaN;
  }
  if (x === 0) {
    return lib_default372;
  }
  x2 = lib_default47(x, 2);
  if (v > 2 * x2) {
    z = x2 / (v + x2);
    p101 = lib_default120(z, 0.5, v / 2, true, true) / 2;
  } else {
    z = v / (v + x2);
    p101 = lib_default120(z, v / 2, 0.5, true, false) / 2;
  }
  return x > 0 ? lib_default78(-p101) : lib_default12(p101);
}
var main_default490 = logcdf21;

function factory160(v) {
  if (lib_default(v) || v <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    var x2;
    var p101;
    var z;
    if (lib_default(x)) {
      return NaN;
    }
    if (x === 0) {
      return lib_default372;
    }
    x2 = lib_default47(x, 2);
    if (v > 2 * x2) {
      z = x2 / (v + x2);
      p101 = lib_default120(z, 0.5, v / 2, true, true) / 2;
    } else {
      z = v / (v + x2);
      p101 = lib_default120(z, v / 2, 0.5, true, false) / 2;
    }
    return x > 0 ? lib_default78(-p101) : lib_default12(p101);
  }
}
var factory_default160 = factory160;

main_default490.factory = factory_default160;
var lib_default533 = main_default490;

function logpdf24(x, v) {
  var betaTerm;
  if (lib_default(x) || lib_default(v) || v <= 0) {
    return NaN;
  }
  betaTerm = lib_default12(lib_default2(v)) + lib_default126(v / 2, 0.5);
  return (1 + v) / 2 * lib_default12(v / (v + lib_default47(x, 2))) - betaTerm;
}
var main_default491 = logpdf24;

function factory161(v) {
  var exponent2;
  var betaTerm;
  if (lib_default(v) || v <= 0) {
    return lib_default6(NaN);
  }
  betaTerm = lib_default12(lib_default2(v)) + lib_default126(v / 2, 0.5);
  exponent2 = (1 + v) / 2;
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return exponent2 * lib_default12(v / (v + lib_default47(x, 2))) - betaTerm;
  }
}
var factory_default161 = factory161;

main_default491.factory = factory_default161;
var lib_default534 = main_default491;

function mean31(v) {
  if (lib_default(v) || v <= 1) {
    return NaN;
  }
  return 0;
}
var main_default492 = mean31;

var lib_default535 = main_default492;

function median24(v) {
  if (lib_default(v) || v < 0) {
    return NaN;
  }
  return 0;
}
var main_default493 = median24;

var lib_default536 = main_default493;

function mode32(v) {
  if (lib_default(v) || v < 0) {
    return NaN;
  }
  return 0;
}
var main_default494 = mode32;

var lib_default537 = main_default494;

function pdf26(x, v) {
  var betaTerm;
  if (lib_default(x) || lib_default(v) || v <= 0) {
    return NaN;
  }
  betaTerm = lib_default2(v) * lib_default81(v / 2, 0.5);
  return lib_default47(v / (v + lib_default47(x, 2)), (1 + v) / 2) / betaTerm;
}
var main_default495 = pdf26;

function factory162(v) {
  var exponent2;
  var betaTerm;
  if (lib_default(v) || v <= 0) {
    return lib_default6(NaN);
  }
  betaTerm = lib_default2(v) * lib_default81(v / 2, 0.5);
  exponent2 = (1 + v) / 2;
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    return lib_default47(v / (v + lib_default47(x, 2)), exponent2) / betaTerm;
  }
}
var factory_default162 = factory162;

main_default495.factory = factory_default162;
var lib_default538 = main_default495;

function quantile32(p101, v) {
  var prob;
  var xs;
  if (lib_default(v) || lib_default(p101) || v <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  prob = p101 > 0.5 ? 1 - p101 : p101;
  xs = lib_default139(v / 2, 0.5, 2 * prob, 1 - 2 * prob);
  return lib_default135(p101 - 0.5) * lib_default2(v * xs[1] / xs[0]);
}
var main_default496 = quantile32;

function factory163(v) {
  if (lib_default(v) || v <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    var prob;
    var xs;
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    prob = p101 > 0.5 ? 1 - p101 : p101;
    xs = lib_default139(v / 2, 0.5, 2 * prob, 1 - 2 * prob);
    return lib_default135(p101 - 0.5) * lib_default2(v * xs[1] / xs[0]);
  }
}
var factory_default163 = factory163;

main_default496.factory = factory_default163;
var lib_default539 = main_default496;

function skewness27(v) {
  if (lib_default(v) || v <= 3) {
    return NaN;
  }
  return 0;
}
var main_default497 = skewness27;

var lib_default540 = main_default497;

function variance29(v) {
  if (lib_default(v) || v <= 1) {
    return NaN;
  }
  if (v <= 2) {
    return lib_default27;
  }
  return v / (v - 2);
}
var main_default498 = variance29;

var lib_default541 = main_default498;

function stdev30(v) {
  return lib_default2(lib_default541(v));
}
var main_default499 = stdev30;

var lib_default542 = main_default499;

function entropy29(a, b, c2) {
  if (lib_default(a) || lib_default(b) || lib_default(c2) || !(a <= c2 && c2 <= b)) {
    return NaN;
  }
  return 0.5 + lib_default12(0.5 * (b - a));
}
var main_default500 = entropy29;

var lib_default543 = main_default500;

function kurtosis28(a, b, c2) {
  if (lib_default(a) || lib_default(b) || lib_default(c2) || !(a <= c2 && c2 <= b)) {
    return NaN;
  }
  return -0.6;
}
var main_default501 = kurtosis28;

var lib_default544 = main_default501;

function mean32(a, b, c2) {
  if (lib_default(a) || lib_default(b) || lib_default(c2) || !(a <= c2 && c2 <= b)) {
    return NaN;
  }
  return (a + b + c2) / 3;
}
var main_default502 = mean32;

var lib_default545 = main_default502;

function median25(a, b, c2) {
  if (lib_default(a) || lib_default(b) || lib_default(c2) || !(a <= c2 && c2 <= b)) {
    return NaN;
  }
  if (c2 >= (a + b) / 2) {
    return a + lib_default2(0.5 * (b - a) * (c2 - a));
  }
  return b - lib_default2(0.5 * (b - a) * (b - c2));
}
var main_default503 = median25;

var lib_default546 = main_default503;

function mode33(a, b, c2) {
  if (lib_default(a) || lib_default(b) || lib_default(c2) || !(a <= c2 && c2 <= b)) {
    return NaN;
  }
  return c2;
}
var main_default504 = mode33;

var lib_default547 = main_default504;

function skewness28(a, b, c2) {
  var out;
  if (lib_default(a) || lib_default(b) || lib_default(c2) || !(a <= c2 && c2 <= b)) {
    return NaN;
  }
  out = lib_default134 * (a + b - 2 * c2) * (2 * a - b - c2) * (a - 2 * b + c2);
  out /= 5 * lib_default47(a * a + b * b + c2 * c2 - a * b - a * c2 - b * c2, 1.5);
  return out;
}
var main_default505 = skewness28;

var lib_default548 = main_default505;

function variance30(a, b, c2) {
  if (lib_default(a) || lib_default(b) || lib_default(c2) || !(a <= c2 && c2 <= b)) {
    return NaN;
  }
  return (a * a + b * b + c2 * c2 - a * b - a * c2 - b * c2) / 18;
}
var main_default506 = variance30;

var lib_default549 = main_default506;

function stdev31(a, b, c2) {
  return lib_default2(lib_default549(a, b, c2));
}
var main_default507 = stdev31;

var lib_default550 = main_default507;

function cdf33(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (x < a) {
    return 0;
  }
  if (x >= b) {
    return 1;
  }
  return (x - a) / (b - a);
}
var main_default508 = cdf33;

function factory164(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < a) {
      return 0;
    }
    if (x >= b) {
      return 1;
    }
    return (x - a) / (b - a);
  }
}
var factory_default164 = factory164;

main_default508.factory = factory_default164;
var lib_default551 = main_default508;

function entropy30(a, b) {
  if (a >= b) {
    return NaN;
  }
  return lib_default12(b - a);
}
var main_default509 = entropy30;

var lib_default552 = main_default509;

function kurtosis29(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  return -1.2;
}
var main_default510 = kurtosis29;

var lib_default553 = main_default510;

function logcdf22(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (x < a) {
    return lib_default11;
  }
  if (x >= b) {
    return 0;
  }
  return lib_default12((x - a) / (b - a));
}
var main_default511 = logcdf22;

function factory165(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < a) {
      return lib_default11;
    }
    if (x >= b) {
      return 0;
    }
    return lib_default12((x - a) / (b - a));
  }
}
var factory_default165 = factory165;

main_default511.factory = factory_default165;
var lib_default554 = main_default511;

function logpdf25(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (x < a || x > b) {
    return lib_default11;
  }
  return -lib_default12(b - a);
}
var main_default512 = logpdf25;

function factory166(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return logpdf27;
  function logpdf27(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < a || x > b) {
      return lib_default11;
    }
    return -lib_default12(b - a);
  }
}
var factory_default166 = factory166;

main_default512.factory = factory_default166;
var lib_default555 = main_default512;

function mean33(a, b) {
  if (a >= b) {
    return NaN;
  }
  return 0.5 * (a + b);
}
var main_default513 = mean33;

var lib_default556 = main_default513;

function median26(a, b) {
  if (a >= b) {
    return NaN;
  }
  return 0.5 * (a + b);
}
var main_default514 = median26;

var lib_default557 = main_default514;

function mgf19(t, a, b) {
  var ret;
  if (lib_default(t) || lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (t === 0) {
    return 1;
  }
  ret = lib_default68(t * b) - lib_default68(t * a);
  ret /= t * (b - a);
  return ret;
}
var main_default515 = mgf19;

function factory167(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    var ret;
    if (lib_default(t)) {
      return NaN;
    }
    if (t === 0) {
      return 1;
    }
    ret = lib_default68(t * b) - lib_default68(t * a);
    ret /= t * (b - a);
    return ret;
  }
}
var factory_default167 = factory167;

main_default515.factory = factory_default167;
var lib_default558 = main_default515;

function pdf27(x, a, b) {
  if (lib_default(x) || lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (x < a || x > b) {
    return 0;
  }
  return 1 / (b - a);
}
var main_default516 = pdf27;

function factory168(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return pdf30;
  function pdf30(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < a || x > b) {
      return 0;
    }
    return 1 / (b - a);
  }
}
var factory_default168 = factory168;

main_default516.factory = factory_default168;
var lib_default559 = main_default516;

function quantile33(p101, a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  if (lib_default(p101) || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return a + p101 * (b - a);
}
var main_default517 = quantile33;

function factory169(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return a + p101 * (b - a);
  }
}
var factory_default169 = factory169;

main_default517.factory = factory_default169;
var lib_default560 = main_default517;

function skewness29(a, b) {
  if (lib_default(a) || lib_default(b) || a >= b) {
    return NaN;
  }
  return 0;
}
var main_default518 = skewness29;

var lib_default561 = main_default518;

var SQRT1O122 = 0.28867513459481287;
function stdev32(a, b) {
  if (a >= b) {
    return NaN;
  }
  return SQRT1O122 * (b - a);
}
var main_default519 = stdev32;

var lib_default562 = main_default519;

function variance31(a, b) {
  if (a >= b) {
    return NaN;
  }
  return 1 / 12 * lib_default47(b - a, 2);
}
var main_default520 = variance31;

var lib_default563 = main_default520;

function kurtosis30(mu, lambda) {
  if (lib_default(mu) || lib_default(lambda) || mu <= 0 || lambda <= 0) {
    return NaN;
  }
  return 15 * mu / lambda;
}
var main_default521 = kurtosis30;

var lib_default564 = main_default521;

function mean34(mu, lambda) {
  if (lib_default(mu) || lib_default(lambda) || lambda <= 0 || mu <= 0) {
    return NaN;
  }
  return mu;
}
var main_default522 = mean34;

var lib_default565 = main_default522;

function mode34(mu, lambda) {
  var r;
  var v;
  if (lib_default(mu) || lib_default(lambda) || mu <= 0 || lambda <= 0) {
    return NaN;
  }
  r = mu / lambda;
  v = 1.5 * r;
  return mu * (lib_default2(1 + v * v) - v);
}
var main_default523 = mode34;

var lib_default566 = main_default523;

function pdf28(x, mu, lambda) {
  var A2;
  var B;
  var v;
  if (lib_default(x) || lib_default(mu) || lib_default(lambda) || mu <= 0 || lambda < 0) {
    return NaN;
  }
  if (lambda === 0) {
    return x === mu ? lib_default27 : 0;
  }
  if (x <= 0 || !isFinite(x)) {
    return 0;
  }
  A2 = lib_default2(lambda / lib_default107);
  B = -lambda / (2 * mu * mu);
  v = x - mu;
  return A2 / (x * lib_default2(x)) * lib_default68(B * v * v / x);
}
var main_default524 = pdf28;

var degenerate35 = lib_default190.factory;
function factory170(mu, lambda) {
  var A2;
  var B;
  if (lib_default(mu) || lib_default(lambda) || mu <= 0 || lambda < 0) {
    return lib_default6(NaN);
  }
  if (lambda === 0) {
    return degenerate35(mu);
  }
  A2 = lib_default2(lambda / lib_default107);
  B = -lambda / (2 * mu * mu);
  return pdf30;
  function pdf30(x) {
    var v;
    if (lib_default(x)) {
      return NaN;
    }
    if (x <= 0 || !isFinite(x)) {
      return 0;
    }
    v = x - mu;
    return A2 / (x * lib_default2(x)) * lib_default68(B * v * v / x);
  }
}
var factory_default170 = factory170;

main_default524.factory = factory_default170;
var lib_default567 = main_default524;

function skewness30(mu, lambda) {
  if (lib_default(mu) || lib_default(lambda) || mu <= 0 || lambda <= 0) {
    return NaN;
  }
  return 3 * lib_default2(mu / lambda);
}
var main_default525 = skewness30;

var lib_default568 = main_default525;

function variance32(mu, lambda) {
  if (lib_default(mu) || lib_default(lambda) || mu <= 0 || lambda <= 0) {
    return NaN;
  }
  return mu * mu * mu / lambda;
}
var main_default526 = variance32;

var lib_default569 = main_default526;

function cdf34(x, k, lambda) {
  if (lib_default(x) || lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  return -lib_default77(-lib_default47(x / lambda, k));
}
var main_default527 = cdf34;

function factory171(k, lambda) {
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return lib_default6(NaN);
  }
  return cdf35;
  function cdf35(x) {
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return 0;
    }
    return -lib_default77(-lib_default47(x / lambda, k));
  }
}
var factory_default171 = factory171;

main_default527.factory = factory_default171;
var lib_default570 = main_default527;

function entropy31(k, lambda) {
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  return lib_default89 * (1 - 1 / k) + lib_default12(lambda / k) + 1;
}
var main_default528 = entropy31;

var lib_default571 = main_default528;

function kurtosis31(k, lambda) {
  var out;
  var g4;
  var g3;
  var g2;
  var g1;
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  g1 = lib_default90(1 + 1 / k);
  g2 = lib_default90(1 + 2 / k);
  g3 = lib_default90(1 + 3 / k);
  g4 = lib_default90(1 + 4 / k);
  out = -6 * lib_default47(g1, 4) + 12 * g1 * g1 * g2 - 3 * g2 * g2 - 4 * g1 * g3 + g4;
  out /= lib_default47(g2 - g1 * g1, 2);
  return out;
}
var main_default529 = kurtosis31;

var lib_default572 = main_default529;

function logcdf23(x, k, lambda) {
  var p101;
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  if (x < 0) {
    return lib_default11;
  }
  p101 = -lib_default47(x / lambda, k);
  return p101 < lib_default372 ? lib_default78(-lib_default68(p101)) : lib_default12(-lib_default77(p101));
}
var main_default530 = logcdf23;

function factory172(k, lambda) {
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return lib_default6(NaN);
  }
  return logcdf24;
  function logcdf24(x) {
    var p101;
    if (lib_default(x)) {
      return NaN;
    }
    if (x < 0) {
      return lib_default11;
    }
    p101 = -lib_default47(x / lambda, k);
    return p101 < lib_default372 ? lib_default78(-lib_default68(p101)) : lib_default12(-lib_default77(p101));
  }
}
var factory_default172 = factory172;

main_default530.factory = factory_default172;
var lib_default573 = main_default530;

function logpdf26(x, k, lambda) {
  var xol;
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  if (x < 0) {
    return lib_default11;
  }
  if (x === lib_default27 || x === lib_default11) {
    return lib_default11;
  }
  if (x === 0) {
    return k === 1 ? lib_default12(k / lambda) : lib_default11;
  }
  xol = x / lambda;
  return lib_default12(k / lambda) + (k - 1) * lib_default12(xol) - lib_default47(xol, k);
}
var main_default531 = logpdf26;

function factory173(k, lambda) {
  var lnkl;
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return lib_default6(NaN);
  }
  lnkl = lib_default12(k / lambda);
  return logpdf27;
  function logpdf27(x) {
    var xol;
    if (x < 0) {
      return lib_default11;
    }
    if (x === lib_default27 || x === lib_default11) {
      return lib_default11;
    }
    if (x === 0) {
      return k === 1 ? lib_default12(k / lambda) : lib_default11;
    }
    xol = x / lambda;
    return lnkl + (k - 1) * lib_default12(xol) - lib_default47(xol, k);
  }
}
var factory_default173 = factory173;

main_default531.factory = factory_default173;
var lib_default574 = main_default531;

function mean35(k, lambda) {
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  return lambda * lib_default90(1 + 1 / k);
}
var main_default532 = mean35;

var lib_default575 = main_default532;

function median27(k, lambda) {
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  return lambda * lib_default47(lib_default16, 1 / k);
}
var main_default533 = median27;

var lib_default576 = main_default533;

function mgf20(t, k, lambda) {
  var summand;
  var sum2;
  var c2;
  var n;
  if (lib_default(t) || lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  sum2 = 1;
  c2 = 1;
  n = 0;
  do {
    n += 1;
    c2 *= t * lambda / n;
    if (c2 === 0) {
      summand = 0;
    } else {
      summand = c2 * lib_default90(1 + n / k);
    }
    sum2 += summand;
  } while (summand / sum2 > lib_default80);
  return sum2;
}
var main_default534 = mgf20;

function factory174(k, lambda) {
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return lib_default6(NaN);
  }
  return mgf21;
  function mgf21(t) {
    var summand;
    var sum2;
    var c2;
    var n;
    if (lib_default(t)) {
      return NaN;
    }
    sum2 = 1;
    c2 = 1;
    n = 0;
    do {
      n += 1;
      c2 *= t * lambda / n;
      if (c2 === 0) {
        summand = 0;
      } else {
        summand = c2 * lib_default90(1 + n / k);
      }
      sum2 += summand;
    } while (summand / sum2 > lib_default80);
    return sum2;
  }
}
var factory_default174 = factory174;

main_default534.factory = factory_default174;
var lib_default577 = main_default534;

function mode35(k, lambda) {
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  if (k <= 1) {
    return 0;
  }
  return lambda * lib_default47((k - 1) / k, 1 / k);
}
var main_default535 = mode35;

var lib_default578 = main_default535;

function pdf29(x, k, lambda) {
  var xol;
  var z;
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  if (x < 0) {
    return 0;
  }
  if (x === lib_default27 || x === lib_default11) {
    return 0;
  }
  if (x === 0) {
    return k === 1 ? k / lambda : 0;
  }
  xol = x / lambda;
  z = lib_default47(xol, k - 1);
  return k / lambda * z * lib_default68(-lib_default47(xol, k));
}
var main_default536 = pdf29;

function factory175(k, lambda) {
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return lib_default6(NaN);
  }
  return pdf30;
  function pdf30(x) {
    var xol;
    var z;
    if (x < 0) {
      return 0;
    }
    if (x === lib_default27 || x === lib_default11) {
      return 0;
    }
    if (x === 0) {
      return k === 1 ? k / lambda : 0;
    }
    xol = x / lambda;
    z = lib_default47(xol, k - 1);
    return k / lambda * z * lib_default68(-lib_default47(xol, k));
  }
}
var factory_default175 = factory175;

main_default536.factory = factory_default175;
var lib_default579 = main_default536;

function quantile34(p101, k, lambda) {
  if (lib_default(k) || lib_default(lambda) || lib_default(p101) || k <= 0 || lambda <= 0 || p101 < 0 || p101 > 1) {
    return NaN;
  }
  return lambda * lib_default47(-lib_default12(1 - p101), 1 / k);
}
var main_default537 = quantile34;

function factory176(k, lambda) {
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return lib_default6(NaN);
  }
  return quantile35;
  function quantile35(p101) {
    if (lib_default(p101) || p101 < 0 || p101 > 1) {
      return NaN;
    }
    return lambda * lib_default47(-lib_default12(1 - p101), 1 / k);
  }
}
var factory_default176 = factory176;

main_default537.factory = factory_default176;
var lib_default580 = main_default537;

function variance33(k, lambda) {
  var mu;
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  mu = lib_default575(k, lambda);
  return lambda * lambda * lib_default90(1 + 2 / k) - mu * mu;
}
var main_default538 = variance33;

var lib_default581 = main_default538;

function skewness31(k, lambda) {
  var sigma2;
  var sigma;
  var out;
  var mu;
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  mu = lib_default575(k, lambda);
  sigma2 = lib_default581(k, lambda);
  sigma = lib_default2(sigma2);
  out = lib_default90(1 + 3 / k) * lib_default47(lambda, 3);
  out -= 3 * mu * sigma2 + lib_default47(mu, 3);
  out /= lib_default47(sigma, 3);
  return out;
}
var main_default539 = skewness31;

var lib_default582 = main_default539;

function stdev33(k, lambda) {
  var g1k;
  if (lib_default(k) || lib_default(lambda) || k <= 0 || lambda <= 0) {
    return NaN;
  }
  g1k = lib_default90(1 + 1 / k);
  return lambda * lib_default2(lib_default90(1 + 2 / k) - g1k * g1k);
}
var main_default540 = stdev33;

var lib_default583 = main_default540;

const N_FN = 429
const N_EVAL = 1 << 12
const N_RUNS = 21
const N_WARMUP = 5

// dists/arcsine/cdf
const k0 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default7(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/arcsine/entropy
const k1 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default13(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/arcsine/kurtosis
const k2 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default14(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/arcsine/logcdf
const k3 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default17(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/arcsine/logpdf
const k4 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default18(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/arcsine/mean
const k5 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default19(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/arcsine/median
const k6 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default20(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/arcsine/mode
const k7 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default21(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/arcsine/pdf
const k8 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default22(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/arcsine/quantile
const k9 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default57(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/arcsine/skewness
const k10 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default58(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/arcsine/stdev
const k11 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default59(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/arcsine/variance
const k12 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default60(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/bernoulli/cdf
const k13 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default61(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/bernoulli/entropy
const k14 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default62(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bernoulli/kurtosis
const k15 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default63(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bernoulli/mean
const k16 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default64(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bernoulli/median
const k17 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default65(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bernoulli/mgf
const k18 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default69(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/bernoulli/mode
const k19 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default70(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bernoulli/pmf
const k20 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default71(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/bernoulli/quantile
const k21 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default72(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/bernoulli/skewness
const k22 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default73(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bernoulli/stdev
const k23 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default75(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bernoulli/variance
const k24 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default74(0.05 + u[i] * (0.95 - 0.05)) }
// dists/beta/cdf
const k25 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default121(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/beta/entropy
const k26 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default127(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/beta/kurtosis
const k27 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default128(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/beta/logcdf
const k28 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default129(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/beta/logpdf
const k29 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default130(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/beta/mean
const k30 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default131(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/beta/median
const k31 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default141(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/beta/mgf
const k32 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default142(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/beta/mode
const k33 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default143(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/beta/pdf
const k34 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default144(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/beta/quantile
const k35 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default145(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/beta/skewness
const k36 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default146(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/beta/stdev
const k37 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default147(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/beta/variance
const k38 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default148(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/betaprime/cdf
const k39 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default149(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/betaprime/logcdf
const k40 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default150(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/betaprime/logpdf
const k41 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default151(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/betaprime/mean
const k42 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default152(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/betaprime/mode
const k43 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default153(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/betaprime/pdf
const k44 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default154(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/betaprime/quantile
const k45 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default155(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/betaprime/stdev
const k46 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default157(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/betaprime/variance
const k47 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default156(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/bradford/cdf
const k48 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default158(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/bradford/entropy
const k49 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default159(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bradford/mean
const k50 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default160(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bradford/median
const k51 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default161(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bradford/mode
const k52 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default162(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bradford/pdf
const k53 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default163(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/bradford/quantile
const k54 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default164(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/bradford/skewness
const k55 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default165(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bradford/stdev
const k56 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default167(0.05 + u[i] * (0.95 - 0.05)) }
// dists/bradford/variance
const k57 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default166(0.05 + u[i] * (0.95 - 0.05)) }
// dists/cauchy/cdf
const k58 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default171(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/cauchy/entropy
const k59 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default172(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/cauchy/logcdf
const k60 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default173(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/cauchy/logpdf
const k61 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default174(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/cauchy/median
const k62 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default175(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/cauchy/mode
const k63 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default176(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/cauchy/pdf
const k64 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default177(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/cauchy/quantile
const k65 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default178(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/chi/cdf
const k66 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default181(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/chi/entropy
const k67 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default182(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chi/kurtosis
const k68 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default186(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chi/logpdf
const k69 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default188(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/chi/mean
const k70 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default183(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chi/mode
const k71 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default189(1.5 + u[i] * (20 - 1.5)) }
// dists/chi/pdf
const k72 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default191(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/chi/quantile
const k73 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default194(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/chi/skewness
const k74 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default185(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chi/stdev
const k75 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default195(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chi/variance
const k76 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default184(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chisquare/cdf
const k77 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default196(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/chisquare/entropy
const k78 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default197(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chisquare/kurtosis
const k79 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default198(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chisquare/logpdf
const k80 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default200(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/chisquare/mean
const k81 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default201(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chisquare/median
const k82 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default203(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chisquare/mgf
const k83 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default204(Math.floor(-40 + u[i] * (0 - -40 + 1)), 3) }
// dists/chisquare/mode
const k84 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default205(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chisquare/pdf
const k85 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default207(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/chisquare/quantile
const k86 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default202(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/chisquare/skewness
const k87 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default208(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chisquare/stdev
const k88 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default210(0.05 + u[i] * (0.95 - 0.05)) }
// dists/chisquare/variance
const k89 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default209(0.05 + u[i] * (0.95 - 0.05)) }
// dists/cosine/cdf
const k90 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default211(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/cosine/kurtosis
const k91 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default212(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/cosine/logcdf
const k92 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default214(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/cosine/logpdf
const k93 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default216(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/cosine/mean
const k94 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default217(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/cosine/median
const k95 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default218(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/cosine/mgf
const k96 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default221(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/cosine/mode
const k97 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default222(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/cosine/pdf
const k98 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default223(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/cosine/quantile
const k99 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default224(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/cosine/skewness
const k100 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default225(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/cosine/stdev
const k101 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default226(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/cosine/variance
const k102 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default227(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/degenerate/cdf
const k103 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default179(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/degenerate/entropy
const k104 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default228(0.05 + u[i] * (0.95 - 0.05)) }
// dists/degenerate/logcdf
const k105 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default213(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/degenerate/mean
const k106 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default229(0.05 + u[i] * (0.95 - 0.05)) }
// dists/degenerate/median
const k107 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default230(0.05 + u[i] * (0.95 - 0.05)) }
// dists/degenerate/mgf
const k108 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default231(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/degenerate/mode
const k109 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default232(0.05 + u[i] * (0.95 - 0.05)) }
// dists/degenerate/pdf
const k110 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default190(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/degenerate/pmf
const k111 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default233(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/degenerate/quantile
const k112 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default192(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/degenerate/stdev
const k113 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default234(0.05 + u[i] * (0.95 - 0.05)) }
// dists/degenerate/variance
const k114 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default235(0.05 + u[i] * (0.95 - 0.05)) }
// dists/discrete-uniform/entropy
const k115 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default236(Math.floor(-40 + u[i] * (0 - -40 + 1)), 3) }
// dists/discrete-uniform/kurtosis
const k116 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default237(Math.floor(-40 + u[i] * (0 - -40 + 1)), 3) }
// dists/discrete-uniform/mean
const k117 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default238(Math.floor(-40 + u[i] * (0 - -40 + 1)), 3) }
// dists/discrete-uniform/median
const k118 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default239(Math.floor(-40 + u[i] * (0 - -40 + 1)), 3) }
// dists/discrete-uniform/skewness
const k119 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default240(Math.floor(-40 + u[i] * (0 - -40 + 1)), 3) }
// dists/discrete-uniform/stdev
const k120 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default241(Math.floor(-40 + u[i] * (0 - -40 + 1)), 3) }
// dists/discrete-uniform/variance
const k121 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default242(Math.floor(-40 + u[i] * (0 - -40 + 1)), 3) }
// dists/erlang/cdf
const k122 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default244(0.05 + u[i] * (0.95 - 0.05), 3, 2) }
// dists/erlang/entropy
const k123 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default246(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// dists/erlang/kurtosis
const k124 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default247(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// dists/erlang/logpdf
const k125 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default248(0.05 + u[i] * (0.95 - 0.05), 3, 2) }
// dists/erlang/mean
const k126 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default249(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// dists/erlang/mgf
const k127 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default250(0.05 + u[i] * (0.95 - 0.05), 3, 2) }
// dists/erlang/mode
const k128 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default251(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// dists/erlang/pdf
const k129 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default252(0.05 + u[i] * (0.95 - 0.05), 3, 2) }
// dists/erlang/quantile
const k130 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default253(0.05 + u[i] * (0.95 - 0.05), 3, 2) }
// dists/erlang/skewness
const k131 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default254(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// dists/erlang/stdev
const k132 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default255(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// dists/erlang/variance
const k133 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default256(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// dists/exponential/cdf
const k134 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default257(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/exponential/entropy
const k135 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default258(0.05 + u[i] * (0.95 - 0.05)) }
// dists/exponential/kurtosis
const k136 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default259(0.05 + u[i] * (0.95 - 0.05)) }
// dists/exponential/logcdf
const k137 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default260(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/exponential/logpdf
const k138 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default261(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/exponential/mean
const k139 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default262(0.05 + u[i] * (0.95 - 0.05)) }
// dists/exponential/median
const k140 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default263(0.05 + u[i] * (0.95 - 0.05)) }
// dists/exponential/mgf
const k141 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default264(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/exponential/mode
const k142 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default265(0.05 + u[i] * (0.95 - 0.05)) }
// dists/exponential/pdf
const k143 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default266(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/exponential/quantile
const k144 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default267(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/exponential/skewness
const k145 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default268(0.05 + u[i] * (0.95 - 0.05)) }
// dists/exponential/stdev
const k146 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default269(0.05 + u[i] * (0.95 - 0.05)) }
// dists/exponential/variance
const k147 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default270(0.05 + u[i] * (0.95 - 0.05)) }
// dists/f/cdf
const k148 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default271(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/f/entropy
const k149 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default272(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/f/mean
const k150 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default273(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/f/mode
const k151 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default274(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/f/pdf
const k152 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default275(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/f/quantile
const k153 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default276(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/frechet/cdf
const k154 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default277(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5, 0.5) }
// dists/frechet/entropy
const k155 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default278(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/frechet/kurtosis
const k156 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default279(1 + u[i] * (100 - 1), 2.5, 1.5) }
// dists/frechet/logcdf
const k157 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default280(1.5 + u[i] * (20 - 1.5), 2.5, 1.5, 0.5) }
// dists/frechet/logpdf
const k158 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default281(1.5 + u[i] * (20 - 1.5), 2.5, 1.5, 0.5) }
// dists/frechet/mean
const k159 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default282(1.5 + u[i] * (20 - 1.5), 2.5, 1.5) }
// dists/frechet/median
const k160 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default283(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/frechet/mode
const k161 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default284(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/frechet/pdf
const k162 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default285(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5, 0.5) }
// dists/frechet/quantile
const k163 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default286(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5, 0.5) }
// dists/frechet/skewness
const k164 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default287(1.5 + u[i] * (20 - 1.5), 2.5, 1.5) }
// dists/frechet/stdev
const k165 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default288(1.5 + u[i] * (20 - 1.5), 2.5, 1.5) }
// dists/frechet/variance
const k166 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default289(1.5 + u[i] * (20 - 1.5), 2.5, 1.5) }
// dists/gamma/cdf
const k167 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default180(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gamma/entropy
const k168 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default290(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gamma/kurtosis
const k169 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default291(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gamma/logcdf
const k170 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default292(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gamma/logpdf
const k171 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default199(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gamma/mean
const k172 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default293(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gamma/mgf
const k173 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default294(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gamma/mode
const k174 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default295(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/gamma/pdf
const k175 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default206(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gamma/quantile
const k176 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default193(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gamma/skewness
const k177 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default296(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gamma/stdev
const k178 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default297(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gamma/variance
const k179 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default298(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/geometric/cdf
const k180 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default299(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/geometric/entropy
const k181 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default300(0.05 + u[i] * (0.95 - 0.05)) }
// dists/geometric/kurtosis
const k182 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default301(0.05 + u[i] * (0.95 - 0.05)) }
// dists/geometric/logcdf
const k183 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default302(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/geometric/mean
const k184 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default303(0.05 + u[i] * (0.95 - 0.05)) }
// dists/geometric/median
const k185 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default306(0.05 + u[i] * (0.95 - 0.05)) }
// dists/geometric/mgf
const k186 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default308(-0.9 + u[i] * (0.9 - -0.9), 0.5) }
// dists/geometric/mode
const k187 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default309(0.05 + u[i] * (0.95 - 0.05)) }
// dists/geometric/pmf
const k188 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default310(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/geometric/quantile
const k189 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default311(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/geometric/skewness
const k190 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default312(0.05 + u[i] * (0.95 - 0.05)) }
// dists/geometric/stdev
const k191 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default313(0.05 + u[i] * (0.95 - 0.05)) }
// dists/geometric/variance
const k192 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default314(0.05 + u[i] * (0.95 - 0.05)) }
// dists/gumbel/cdf
const k193 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default315(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gumbel/entropy
const k194 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default316(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gumbel/kurtosis
const k195 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default317(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gumbel/logcdf
const k196 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default318(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gumbel/logpdf
const k197 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default319(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gumbel/mean
const k198 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default320(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gumbel/median
const k199 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default321(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gumbel/mgf
const k200 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default322(0.05 + u[i] * (0.95 - 0.05), 0.5, 0.25) }
// dists/gumbel/mode
const k201 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default323(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gumbel/pdf
const k202 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default324(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gumbel/quantile
const k203 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default325(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/gumbel/skewness
const k204 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default326(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gumbel/stdev
const k205 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default327(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/gumbel/variance
const k206 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default328(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/halfnormal/entropy
const k207 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default329(0.05 + u[i] * (0.95 - 0.05)) }
// dists/halfnormal/kurtosis
const k208 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default330(0.05 + u[i] * (0.95 - 0.05)) }
// dists/halfnormal/logpdf
const k209 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default331(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/halfnormal/mean
const k210 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default332(0.05 + u[i] * (0.95 - 0.05)) }
// dists/halfnormal/mode
const k211 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default333(0.05 + u[i] * (0.95 - 0.05)) }
// dists/halfnormal/stdev
const k212 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default334(0.05 + u[i] * (0.95 - 0.05)) }
// dists/hypergeometric/cdf
const k213 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default338(0.05 + u[i] * (0.95 - 0.05), 20, 10, 5) }
// dists/hypergeometric/kurtosis
const k214 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default339(Math.floor(0 + u[i] * (40 - 0 + 1)), 3, 2) }
// dists/hypergeometric/mean
const k215 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default340(Math.floor(0 + u[i] * (40 - 0 + 1)), 3, 2) }
// dists/hypergeometric/mode
const k216 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default341(Math.floor(0 + u[i] * (40 - 0 + 1)), 3, 2) }
// dists/hypergeometric/pmf
const k217 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default337(0.05 + u[i] * (0.95 - 0.05), 20, 10, 5) }
// dists/hypergeometric/quantile
const k218 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default342(0.05 + u[i] * (0.95 - 0.05), 20, 10, 5) }
// dists/hypergeometric/skewness
const k219 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default343(Math.floor(0 + u[i] * (40 - 0 + 1)), 3, 2) }
// dists/hypergeometric/stdev
const k220 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default345(Math.floor(0 + u[i] * (40 - 0 + 1)), 3, 2) }
// dists/hypergeometric/variance
const k221 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default344(Math.floor(0 + u[i] * (40 - 0 + 1)), 3, 2) }
// dists/invgamma/cdf
const k222 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default346(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/invgamma/entropy
const k223 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default347(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/invgamma/kurtosis
const k224 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default348(1 + u[i] * (100 - 1), 2.5) }
// dists/invgamma/logpdf
const k225 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default349(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/invgamma/mean
const k226 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default350(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/invgamma/mode
const k227 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default351(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/invgamma/pdf
const k228 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default352(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/invgamma/quantile
const k229 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default353(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/invgamma/skewness
const k230 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default354(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/invgamma/stdev
const k231 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default355(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/invgamma/variance
const k232 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default356(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/kumaraswamy/cdf
const k233 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default357(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/kumaraswamy/kurtosis
const k234 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default358(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/kumaraswamy/logcdf
const k235 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default359(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/kumaraswamy/logpdf
const k236 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default360(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/kumaraswamy/mean
const k237 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default361(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/kumaraswamy/median
const k238 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default362(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/kumaraswamy/mode
const k239 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default363(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/kumaraswamy/pdf
const k240 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default364(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/kumaraswamy/quantile
const k241 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default365(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/kumaraswamy/skewness
const k242 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default366(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/kumaraswamy/stdev
const k243 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default368(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/kumaraswamy/variance
const k244 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default367(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/laplace/cdf
const k245 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default369(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/laplace/entropy
const k246 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default370(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/laplace/kurtosis
const k247 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default371(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/laplace/logcdf
const k248 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default373(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/laplace/logpdf
const k249 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default374(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/laplace/mean
const k250 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default375(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/laplace/median
const k251 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default376(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/laplace/mgf
const k252 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default377(0.05 + u[i] * (0.95 - 0.05), 0.5, 0.25) }
// dists/laplace/mode
const k253 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default378(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/laplace/pdf
const k254 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default379(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/laplace/quantile
const k255 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default380(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/laplace/skewness
const k256 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default381(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/laplace/stdev
const k257 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default382(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/laplace/variance
const k258 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default383(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/levy/cdf
const k259 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default384(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/levy/entropy
const k260 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default385(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/levy/logcdf
const k261 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default386(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/levy/logpdf
const k262 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default388(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/levy/median
const k263 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default389(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/levy/mode
const k264 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default390(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/levy/pdf
const k265 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default391(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/levy/quantile
const k266 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default392(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/logistic/cdf
const k267 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default393(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/logistic/entropy
const k268 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default394(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/logistic/kurtosis
const k269 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default395(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/logistic/logcdf
const k270 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default396(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/logistic/logpdf
const k271 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default397(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/logistic/mean
const k272 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default398(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/logistic/median
const k273 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default399(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/logistic/mgf
const k274 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default401(0.05 + u[i] * (0.95 - 0.05), 0.5, 0.25) }
// dists/logistic/mode
const k275 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default402(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/logistic/pdf
const k276 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default403(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/logistic/quantile
const k277 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default404(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/logistic/skewness
const k278 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default405(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/logistic/stdev
const k279 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default406(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/logistic/variance
const k280 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default407(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/lognormal/cdf
const k281 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default409(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/lognormal/entropy
const k282 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default410(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/lognormal/kurtosis
const k283 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default411(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/lognormal/logcdf
const k284 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default415(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/lognormal/logpdf
const k285 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default416(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/lognormal/mean
const k286 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default417(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/lognormal/median
const k287 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default418(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/lognormal/mode
const k288 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default419(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/lognormal/pdf
const k289 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default420(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/lognormal/quantile
const k290 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default423(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/lognormal/skewness
const k291 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default424(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/lognormal/stdev
const k292 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default426(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/lognormal/variance
const k293 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default425(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/negative-binomial/cdf
const k294 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default427(0.05 + u[i] * (0.95 - 0.05), 0.5, 0.25) }
// dists/negative-binomial/kurtosis
const k295 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default428(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/negative-binomial/mean
const k296 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default429(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/negative-binomial/mgf
const k297 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default430(0.05 + u[i] * (0.95 - 0.05), 0.5, 0.25) }
// dists/negative-binomial/mode
const k298 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default431(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/negative-binomial/pmf
const k299 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default432(0.05 + u[i] * (0.95 - 0.05), 0.5, 0.25) }
// dists/negative-binomial/quantile
const k300 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default433(0.05 + u[i] * (0.95 - 0.05), 0.5, 0.25) }
// dists/negative-binomial/skewness
const k301 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default434(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/negative-binomial/stdev
const k302 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default435(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/negative-binomial/variance
const k303 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default436(0.05 + u[i] * (0.95 - 0.05), 0.5) }
// dists/normal/cdf
const k304 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default408(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/normal/entropy
const k305 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default437(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/normal/kurtosis
const k306 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default438(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/normal/logcdf
const k307 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default414(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/normal/logpdf
const k308 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default439(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/normal/mean
const k309 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default440(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/normal/median
const k310 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default441(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/normal/mgf
const k311 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default442(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/normal/mode
const k312 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default443(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/normal/pdf
const k313 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default444(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/normal/quantile
const k314 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default422(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/normal/skewness
const k315 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default445(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/normal/stdev
const k316 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default446(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/normal/variance
const k317 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default447(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/pareto-type1/cdf
const k318 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default448(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/pareto-type1/entropy
const k319 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default449(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/pareto-type1/kurtosis
const k320 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default450(1 + u[i] * (100 - 1), 2.5) }
// dists/pareto-type1/logcdf
const k321 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default451(1.5 + u[i] * (20 - 1.5), 2.5, 1.5) }
// dists/pareto-type1/logpdf
const k322 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default452(1.5 + u[i] * (20 - 1.5), 2.5, 1.5) }
// dists/pareto-type1/mean
const k323 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default453(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/pareto-type1/median
const k324 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default454(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/pareto-type1/mode
const k325 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default455(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/pareto-type1/pdf
const k326 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default456(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/pareto-type1/quantile
const k327 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default457(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/pareto-type1/skewness
const k328 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default458(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/pareto-type1/stdev
const k329 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default460(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/pareto-type1/variance
const k330 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default459(1.5 + u[i] * (20 - 1.5), 2.5) }
// dists/planck/cdf
const k331 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default461(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/planck/entropy
const k332 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default462(0.05 + u[i] * (0.95 - 0.05)) }
// dists/planck/kurtosis
const k333 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default464(0.05 + u[i] * (0.95 - 0.05)) }
// dists/planck/logcdf
const k334 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default465(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/planck/logpmf
const k335 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default466(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// dists/planck/mean
const k336 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default467(0.05 + u[i] * (0.95 - 0.05)) }
// dists/planck/median
const k337 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default468(0.05 + u[i] * (0.95 - 0.05)) }
// dists/planck/mgf
const k338 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default469(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/planck/mode
const k339 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default470(0.05 + u[i] * (0.95 - 0.05)) }
// dists/planck/pmf
const k340 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default471(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/planck/quantile
const k341 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default472(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/planck/skewness
const k342 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default473(0.05 + u[i] * (0.95 - 0.05)) }
// dists/planck/stdev
const k343 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default474(0.05 + u[i] * (0.95 - 0.05)) }
// dists/planck/variance
const k344 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default475(0.05 + u[i] * (0.95 - 0.05)) }
// dists/poisson/cdf
const k345 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default476(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/poisson/entropy
const k346 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default477(0.05 + u[i] * (0.95 - 0.05)) }
// dists/poisson/kurtosis
const k347 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default478(0.05 + u[i] * (0.95 - 0.05)) }
// dists/poisson/logpmf
const k348 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default480(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// dists/poisson/mean
const k349 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default481(0.05 + u[i] * (0.95 - 0.05)) }
// dists/poisson/median
const k350 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default482(0.05 + u[i] * (0.95 - 0.05)) }
// dists/poisson/mgf
const k351 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default483(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/poisson/mode
const k352 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default484(0.05 + u[i] * (0.95 - 0.05)) }
// dists/poisson/pmf
const k353 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default485(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/poisson/quantile
const k354 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default486(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/poisson/skewness
const k355 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default487(0.05 + u[i] * (0.95 - 0.05)) }
// dists/poisson/stdev
const k356 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default489(0.05 + u[i] * (0.95 - 0.05)) }
// dists/poisson/variance
const k357 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default488(0.05 + u[i] * (0.95 - 0.05)) }
// dists/rayleigh/cdf
const k358 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default490(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/rayleigh/entropy
const k359 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default491(0.05 + u[i] * (0.95 - 0.05)) }
// dists/rayleigh/kurtosis
const k360 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default492(0.05 + u[i] * (0.95 - 0.05)) }
// dists/rayleigh/logcdf
const k361 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default493(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/rayleigh/logpdf
const k362 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default494(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/rayleigh/mean
const k363 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default496(0.05 + u[i] * (0.95 - 0.05)) }
// dists/rayleigh/median
const k364 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default497(0.05 + u[i] * (0.95 - 0.05)) }
// dists/rayleigh/mgf
const k365 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default499(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/rayleigh/mode
const k366 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default500(0.05 + u[i] * (0.95 - 0.05)) }
// dists/rayleigh/pdf
const k367 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default501(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/rayleigh/quantile
const k368 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default502(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/rayleigh/skewness
const k369 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default504(0.05 + u[i] * (0.95 - 0.05)) }
// dists/rayleigh/stdev
const k370 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default505(0.05 + u[i] * (0.95 - 0.05)) }
// dists/rayleigh/variance
const k371 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default506(0.05 + u[i] * (0.95 - 0.05)) }
// dists/signrank/cdf
const k372 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default527(0.05 + u[i] * (0.95 - 0.05), 3) }
// dists/signrank/pdf
const k373 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default528(0.05 + u[i] * (0.95 - 0.05), 3) }
// dists/signrank/quantile
const k374 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default529(0.05 + u[i] * (0.95 - 0.05), 3) }
// dists/t/cdf
const k375 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default530(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/t/entropy
const k376 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default531(0.05 + u[i] * (0.95 - 0.05)) }
// dists/t/kurtosis
const k377 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default532(1 + u[i] * (100 - 1)) }
// dists/t/logcdf
const k378 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default533(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/t/logpdf
const k379 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default534(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/t/mean
const k380 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default535(1.5 + u[i] * (20 - 1.5)) }
// dists/t/median
const k381 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default536(0.05 + u[i] * (0.95 - 0.05)) }
// dists/t/mode
const k382 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default537(0.05 + u[i] * (0.95 - 0.05)) }
// dists/t/pdf
const k383 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default538(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/t/quantile
const k384 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default539(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/t/skewness
const k385 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default540(1.5 + u[i] * (20 - 1.5)) }
// dists/t/stdev
const k386 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default542(1.5 + u[i] * (20 - 1.5)) }
// dists/t/variance
const k387 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default541(1.5 + u[i] * (20 - 1.5)) }
// dists/triangular/entropy
const k388 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default543(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/triangular/kurtosis
const k389 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default544(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/triangular/mean
const k390 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default545(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/triangular/median
const k391 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default546(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/triangular/mode
const k392 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default547(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/triangular/skewness
const k393 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default548(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/triangular/stdev
const k394 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default550(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/triangular/variance
const k395 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default549(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/uniform/cdf
const k396 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default551(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/uniform/entropy
const k397 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default552(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/uniform/kurtosis
const k398 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default553(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/uniform/logcdf
const k399 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default554(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/uniform/logpdf
const k400 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default555(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/uniform/mean
const k401 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default556(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/uniform/median
const k402 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default557(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/uniform/mgf
const k403 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default558(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/uniform/pdf
const k404 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default559(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/uniform/quantile
const k405 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default560(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// dists/uniform/skewness
const k406 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default561(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/uniform/stdev
const k407 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default562(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/uniform/variance
const k408 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default563(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/wald/kurtosis
const k409 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default564(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/wald/mean
const k410 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default565(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/wald/mode
const k411 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default566(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/wald/pdf
const k412 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default567(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/wald/skewness
const k413 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default568(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/wald/variance
const k414 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default569(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/weibull/cdf
const k415 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default570(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/weibull/entropy
const k416 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default571(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/weibull/kurtosis
const k417 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default572(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/weibull/logcdf
const k418 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default573(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/weibull/logpdf
const k419 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default574(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/weibull/mean
const k420 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default575(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/weibull/median
const k421 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default576(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/weibull/mgf
const k422 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default577(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/weibull/mode
const k423 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default578(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/weibull/pdf
const k424 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default579(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/weibull/quantile
const k425 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default580(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// dists/weibull/skewness
const k426 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default582(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/weibull/stdev
const k427 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default583(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// dists/weibull/variance
const k428 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default581(0.05 + u[i] * (0.95 - 0.05), 2.5) }

const sweep = (u, out) => {
  k0(u, out, 0 * N_EVAL)
  k1(u, out, 1 * N_EVAL)
  k2(u, out, 2 * N_EVAL)
  k3(u, out, 3 * N_EVAL)
  k4(u, out, 4 * N_EVAL)
  k5(u, out, 5 * N_EVAL)
  k6(u, out, 6 * N_EVAL)
  k7(u, out, 7 * N_EVAL)
  k8(u, out, 8 * N_EVAL)
  k9(u, out, 9 * N_EVAL)
  k10(u, out, 10 * N_EVAL)
  k11(u, out, 11 * N_EVAL)
  k12(u, out, 12 * N_EVAL)
  k13(u, out, 13 * N_EVAL)
  k14(u, out, 14 * N_EVAL)
  k15(u, out, 15 * N_EVAL)
  k16(u, out, 16 * N_EVAL)
  k17(u, out, 17 * N_EVAL)
  k18(u, out, 18 * N_EVAL)
  k19(u, out, 19 * N_EVAL)
  k20(u, out, 20 * N_EVAL)
  k21(u, out, 21 * N_EVAL)
  k22(u, out, 22 * N_EVAL)
  k23(u, out, 23 * N_EVAL)
  k24(u, out, 24 * N_EVAL)
  k25(u, out, 25 * N_EVAL)
  k26(u, out, 26 * N_EVAL)
  k27(u, out, 27 * N_EVAL)
  k28(u, out, 28 * N_EVAL)
  k29(u, out, 29 * N_EVAL)
  k30(u, out, 30 * N_EVAL)
  k31(u, out, 31 * N_EVAL)
  k32(u, out, 32 * N_EVAL)
  k33(u, out, 33 * N_EVAL)
  k34(u, out, 34 * N_EVAL)
  k35(u, out, 35 * N_EVAL)
  k36(u, out, 36 * N_EVAL)
  k37(u, out, 37 * N_EVAL)
  k38(u, out, 38 * N_EVAL)
  k39(u, out, 39 * N_EVAL)
  k40(u, out, 40 * N_EVAL)
  k41(u, out, 41 * N_EVAL)
  k42(u, out, 42 * N_EVAL)
  k43(u, out, 43 * N_EVAL)
  k44(u, out, 44 * N_EVAL)
  k45(u, out, 45 * N_EVAL)
  k46(u, out, 46 * N_EVAL)
  k47(u, out, 47 * N_EVAL)
  k48(u, out, 48 * N_EVAL)
  k49(u, out, 49 * N_EVAL)
  k50(u, out, 50 * N_EVAL)
  k51(u, out, 51 * N_EVAL)
  k52(u, out, 52 * N_EVAL)
  k53(u, out, 53 * N_EVAL)
  k54(u, out, 54 * N_EVAL)
  k55(u, out, 55 * N_EVAL)
  k56(u, out, 56 * N_EVAL)
  k57(u, out, 57 * N_EVAL)
  k58(u, out, 58 * N_EVAL)
  k59(u, out, 59 * N_EVAL)
  k60(u, out, 60 * N_EVAL)
  k61(u, out, 61 * N_EVAL)
  k62(u, out, 62 * N_EVAL)
  k63(u, out, 63 * N_EVAL)
  k64(u, out, 64 * N_EVAL)
  k65(u, out, 65 * N_EVAL)
  k66(u, out, 66 * N_EVAL)
  k67(u, out, 67 * N_EVAL)
  k68(u, out, 68 * N_EVAL)
  k69(u, out, 69 * N_EVAL)
  k70(u, out, 70 * N_EVAL)
  k71(u, out, 71 * N_EVAL)
  k72(u, out, 72 * N_EVAL)
  k73(u, out, 73 * N_EVAL)
  k74(u, out, 74 * N_EVAL)
  k75(u, out, 75 * N_EVAL)
  k76(u, out, 76 * N_EVAL)
  k77(u, out, 77 * N_EVAL)
  k78(u, out, 78 * N_EVAL)
  k79(u, out, 79 * N_EVAL)
  k80(u, out, 80 * N_EVAL)
  k81(u, out, 81 * N_EVAL)
  k82(u, out, 82 * N_EVAL)
  k83(u, out, 83 * N_EVAL)
  k84(u, out, 84 * N_EVAL)
  k85(u, out, 85 * N_EVAL)
  k86(u, out, 86 * N_EVAL)
  k87(u, out, 87 * N_EVAL)
  k88(u, out, 88 * N_EVAL)
  k89(u, out, 89 * N_EVAL)
  k90(u, out, 90 * N_EVAL)
  k91(u, out, 91 * N_EVAL)
  k92(u, out, 92 * N_EVAL)
  k93(u, out, 93 * N_EVAL)
  k94(u, out, 94 * N_EVAL)
  k95(u, out, 95 * N_EVAL)
  k96(u, out, 96 * N_EVAL)
  k97(u, out, 97 * N_EVAL)
  k98(u, out, 98 * N_EVAL)
  k99(u, out, 99 * N_EVAL)
  k100(u, out, 100 * N_EVAL)
  k101(u, out, 101 * N_EVAL)
  k102(u, out, 102 * N_EVAL)
  k103(u, out, 103 * N_EVAL)
  k104(u, out, 104 * N_EVAL)
  k105(u, out, 105 * N_EVAL)
  k106(u, out, 106 * N_EVAL)
  k107(u, out, 107 * N_EVAL)
  k108(u, out, 108 * N_EVAL)
  k109(u, out, 109 * N_EVAL)
  k110(u, out, 110 * N_EVAL)
  k111(u, out, 111 * N_EVAL)
  k112(u, out, 112 * N_EVAL)
  k113(u, out, 113 * N_EVAL)
  k114(u, out, 114 * N_EVAL)
  k115(u, out, 115 * N_EVAL)
  k116(u, out, 116 * N_EVAL)
  k117(u, out, 117 * N_EVAL)
  k118(u, out, 118 * N_EVAL)
  k119(u, out, 119 * N_EVAL)
  k120(u, out, 120 * N_EVAL)
  k121(u, out, 121 * N_EVAL)
  k122(u, out, 122 * N_EVAL)
  k123(u, out, 123 * N_EVAL)
  k124(u, out, 124 * N_EVAL)
  k125(u, out, 125 * N_EVAL)
  k126(u, out, 126 * N_EVAL)
  k127(u, out, 127 * N_EVAL)
  k128(u, out, 128 * N_EVAL)
  k129(u, out, 129 * N_EVAL)
  k130(u, out, 130 * N_EVAL)
  k131(u, out, 131 * N_EVAL)
  k132(u, out, 132 * N_EVAL)
  k133(u, out, 133 * N_EVAL)
  k134(u, out, 134 * N_EVAL)
  k135(u, out, 135 * N_EVAL)
  k136(u, out, 136 * N_EVAL)
  k137(u, out, 137 * N_EVAL)
  k138(u, out, 138 * N_EVAL)
  k139(u, out, 139 * N_EVAL)
  k140(u, out, 140 * N_EVAL)
  k141(u, out, 141 * N_EVAL)
  k142(u, out, 142 * N_EVAL)
  k143(u, out, 143 * N_EVAL)
  k144(u, out, 144 * N_EVAL)
  k145(u, out, 145 * N_EVAL)
  k146(u, out, 146 * N_EVAL)
  k147(u, out, 147 * N_EVAL)
  k148(u, out, 148 * N_EVAL)
  k149(u, out, 149 * N_EVAL)
  k150(u, out, 150 * N_EVAL)
  k151(u, out, 151 * N_EVAL)
  k152(u, out, 152 * N_EVAL)
  k153(u, out, 153 * N_EVAL)
  k154(u, out, 154 * N_EVAL)
  k155(u, out, 155 * N_EVAL)
  k156(u, out, 156 * N_EVAL)
  k157(u, out, 157 * N_EVAL)
  k158(u, out, 158 * N_EVAL)
  k159(u, out, 159 * N_EVAL)
  k160(u, out, 160 * N_EVAL)
  k161(u, out, 161 * N_EVAL)
  k162(u, out, 162 * N_EVAL)
  k163(u, out, 163 * N_EVAL)
  k164(u, out, 164 * N_EVAL)
  k165(u, out, 165 * N_EVAL)
  k166(u, out, 166 * N_EVAL)
  k167(u, out, 167 * N_EVAL)
  k168(u, out, 168 * N_EVAL)
  k169(u, out, 169 * N_EVAL)
  k170(u, out, 170 * N_EVAL)
  k171(u, out, 171 * N_EVAL)
  k172(u, out, 172 * N_EVAL)
  k173(u, out, 173 * N_EVAL)
  k174(u, out, 174 * N_EVAL)
  k175(u, out, 175 * N_EVAL)
  k176(u, out, 176 * N_EVAL)
  k177(u, out, 177 * N_EVAL)
  k178(u, out, 178 * N_EVAL)
  k179(u, out, 179 * N_EVAL)
  k180(u, out, 180 * N_EVAL)
  k181(u, out, 181 * N_EVAL)
  k182(u, out, 182 * N_EVAL)
  k183(u, out, 183 * N_EVAL)
  k184(u, out, 184 * N_EVAL)
  k185(u, out, 185 * N_EVAL)
  k186(u, out, 186 * N_EVAL)
  k187(u, out, 187 * N_EVAL)
  k188(u, out, 188 * N_EVAL)
  k189(u, out, 189 * N_EVAL)
  k190(u, out, 190 * N_EVAL)
  k191(u, out, 191 * N_EVAL)
  k192(u, out, 192 * N_EVAL)
  k193(u, out, 193 * N_EVAL)
  k194(u, out, 194 * N_EVAL)
  k195(u, out, 195 * N_EVAL)
  k196(u, out, 196 * N_EVAL)
  k197(u, out, 197 * N_EVAL)
  k198(u, out, 198 * N_EVAL)
  k199(u, out, 199 * N_EVAL)
  k200(u, out, 200 * N_EVAL)
  k201(u, out, 201 * N_EVAL)
  k202(u, out, 202 * N_EVAL)
  k203(u, out, 203 * N_EVAL)
  k204(u, out, 204 * N_EVAL)
  k205(u, out, 205 * N_EVAL)
  k206(u, out, 206 * N_EVAL)
  k207(u, out, 207 * N_EVAL)
  k208(u, out, 208 * N_EVAL)
  k209(u, out, 209 * N_EVAL)
  k210(u, out, 210 * N_EVAL)
  k211(u, out, 211 * N_EVAL)
  k212(u, out, 212 * N_EVAL)
  k213(u, out, 213 * N_EVAL)
  k214(u, out, 214 * N_EVAL)
  k215(u, out, 215 * N_EVAL)
  k216(u, out, 216 * N_EVAL)
  k217(u, out, 217 * N_EVAL)
  k218(u, out, 218 * N_EVAL)
  k219(u, out, 219 * N_EVAL)
  k220(u, out, 220 * N_EVAL)
  k221(u, out, 221 * N_EVAL)
  k222(u, out, 222 * N_EVAL)
  k223(u, out, 223 * N_EVAL)
  k224(u, out, 224 * N_EVAL)
  k225(u, out, 225 * N_EVAL)
  k226(u, out, 226 * N_EVAL)
  k227(u, out, 227 * N_EVAL)
  k228(u, out, 228 * N_EVAL)
  k229(u, out, 229 * N_EVAL)
  k230(u, out, 230 * N_EVAL)
  k231(u, out, 231 * N_EVAL)
  k232(u, out, 232 * N_EVAL)
  k233(u, out, 233 * N_EVAL)
  k234(u, out, 234 * N_EVAL)
  k235(u, out, 235 * N_EVAL)
  k236(u, out, 236 * N_EVAL)
  k237(u, out, 237 * N_EVAL)
  k238(u, out, 238 * N_EVAL)
  k239(u, out, 239 * N_EVAL)
  k240(u, out, 240 * N_EVAL)
  k241(u, out, 241 * N_EVAL)
  k242(u, out, 242 * N_EVAL)
  k243(u, out, 243 * N_EVAL)
  k244(u, out, 244 * N_EVAL)
  k245(u, out, 245 * N_EVAL)
  k246(u, out, 246 * N_EVAL)
  k247(u, out, 247 * N_EVAL)
  k248(u, out, 248 * N_EVAL)
  k249(u, out, 249 * N_EVAL)
  k250(u, out, 250 * N_EVAL)
  k251(u, out, 251 * N_EVAL)
  k252(u, out, 252 * N_EVAL)
  k253(u, out, 253 * N_EVAL)
  k254(u, out, 254 * N_EVAL)
  k255(u, out, 255 * N_EVAL)
  k256(u, out, 256 * N_EVAL)
  k257(u, out, 257 * N_EVAL)
  k258(u, out, 258 * N_EVAL)
  k259(u, out, 259 * N_EVAL)
  k260(u, out, 260 * N_EVAL)
  k261(u, out, 261 * N_EVAL)
  k262(u, out, 262 * N_EVAL)
  k263(u, out, 263 * N_EVAL)
  k264(u, out, 264 * N_EVAL)
  k265(u, out, 265 * N_EVAL)
  k266(u, out, 266 * N_EVAL)
  k267(u, out, 267 * N_EVAL)
  k268(u, out, 268 * N_EVAL)
  k269(u, out, 269 * N_EVAL)
  k270(u, out, 270 * N_EVAL)
  k271(u, out, 271 * N_EVAL)
  k272(u, out, 272 * N_EVAL)
  k273(u, out, 273 * N_EVAL)
  k274(u, out, 274 * N_EVAL)
  k275(u, out, 275 * N_EVAL)
  k276(u, out, 276 * N_EVAL)
  k277(u, out, 277 * N_EVAL)
  k278(u, out, 278 * N_EVAL)
  k279(u, out, 279 * N_EVAL)
  k280(u, out, 280 * N_EVAL)
  k281(u, out, 281 * N_EVAL)
  k282(u, out, 282 * N_EVAL)
  k283(u, out, 283 * N_EVAL)
  k284(u, out, 284 * N_EVAL)
  k285(u, out, 285 * N_EVAL)
  k286(u, out, 286 * N_EVAL)
  k287(u, out, 287 * N_EVAL)
  k288(u, out, 288 * N_EVAL)
  k289(u, out, 289 * N_EVAL)
  k290(u, out, 290 * N_EVAL)
  k291(u, out, 291 * N_EVAL)
  k292(u, out, 292 * N_EVAL)
  k293(u, out, 293 * N_EVAL)
  k294(u, out, 294 * N_EVAL)
  k295(u, out, 295 * N_EVAL)
  k296(u, out, 296 * N_EVAL)
  k297(u, out, 297 * N_EVAL)
  k298(u, out, 298 * N_EVAL)
  k299(u, out, 299 * N_EVAL)
  k300(u, out, 300 * N_EVAL)
  k301(u, out, 301 * N_EVAL)
  k302(u, out, 302 * N_EVAL)
  k303(u, out, 303 * N_EVAL)
  k304(u, out, 304 * N_EVAL)
  k305(u, out, 305 * N_EVAL)
  k306(u, out, 306 * N_EVAL)
  k307(u, out, 307 * N_EVAL)
  k308(u, out, 308 * N_EVAL)
  k309(u, out, 309 * N_EVAL)
  k310(u, out, 310 * N_EVAL)
  k311(u, out, 311 * N_EVAL)
  k312(u, out, 312 * N_EVAL)
  k313(u, out, 313 * N_EVAL)
  k314(u, out, 314 * N_EVAL)
  k315(u, out, 315 * N_EVAL)
  k316(u, out, 316 * N_EVAL)
  k317(u, out, 317 * N_EVAL)
  k318(u, out, 318 * N_EVAL)
  k319(u, out, 319 * N_EVAL)
  k320(u, out, 320 * N_EVAL)
  k321(u, out, 321 * N_EVAL)
  k322(u, out, 322 * N_EVAL)
  k323(u, out, 323 * N_EVAL)
  k324(u, out, 324 * N_EVAL)
  k325(u, out, 325 * N_EVAL)
  k326(u, out, 326 * N_EVAL)
  k327(u, out, 327 * N_EVAL)
  k328(u, out, 328 * N_EVAL)
  k329(u, out, 329 * N_EVAL)
  k330(u, out, 330 * N_EVAL)
  k331(u, out, 331 * N_EVAL)
  k332(u, out, 332 * N_EVAL)
  k333(u, out, 333 * N_EVAL)
  k334(u, out, 334 * N_EVAL)
  k335(u, out, 335 * N_EVAL)
  k336(u, out, 336 * N_EVAL)
  k337(u, out, 337 * N_EVAL)
  k338(u, out, 338 * N_EVAL)
  k339(u, out, 339 * N_EVAL)
  k340(u, out, 340 * N_EVAL)
  k341(u, out, 341 * N_EVAL)
  k342(u, out, 342 * N_EVAL)
  k343(u, out, 343 * N_EVAL)
  k344(u, out, 344 * N_EVAL)
  k345(u, out, 345 * N_EVAL)
  k346(u, out, 346 * N_EVAL)
  k347(u, out, 347 * N_EVAL)
  k348(u, out, 348 * N_EVAL)
  k349(u, out, 349 * N_EVAL)
  k350(u, out, 350 * N_EVAL)
  k351(u, out, 351 * N_EVAL)
  k352(u, out, 352 * N_EVAL)
  k353(u, out, 353 * N_EVAL)
  k354(u, out, 354 * N_EVAL)
  k355(u, out, 355 * N_EVAL)
  k356(u, out, 356 * N_EVAL)
  k357(u, out, 357 * N_EVAL)
  k358(u, out, 358 * N_EVAL)
  k359(u, out, 359 * N_EVAL)
  k360(u, out, 360 * N_EVAL)
  k361(u, out, 361 * N_EVAL)
  k362(u, out, 362 * N_EVAL)
  k363(u, out, 363 * N_EVAL)
  k364(u, out, 364 * N_EVAL)
  k365(u, out, 365 * N_EVAL)
  k366(u, out, 366 * N_EVAL)
  k367(u, out, 367 * N_EVAL)
  k368(u, out, 368 * N_EVAL)
  k369(u, out, 369 * N_EVAL)
  k370(u, out, 370 * N_EVAL)
  k371(u, out, 371 * N_EVAL)
  k372(u, out, 372 * N_EVAL)
  k373(u, out, 373 * N_EVAL)
  k374(u, out, 374 * N_EVAL)
  k375(u, out, 375 * N_EVAL)
  k376(u, out, 376 * N_EVAL)
  k377(u, out, 377 * N_EVAL)
  k378(u, out, 378 * N_EVAL)
  k379(u, out, 379 * N_EVAL)
  k380(u, out, 380 * N_EVAL)
  k381(u, out, 381 * N_EVAL)
  k382(u, out, 382 * N_EVAL)
  k383(u, out, 383 * N_EVAL)
  k384(u, out, 384 * N_EVAL)
  k385(u, out, 385 * N_EVAL)
  k386(u, out, 386 * N_EVAL)
  k387(u, out, 387 * N_EVAL)
  k388(u, out, 388 * N_EVAL)
  k389(u, out, 389 * N_EVAL)
  k390(u, out, 390 * N_EVAL)
  k391(u, out, 391 * N_EVAL)
  k392(u, out, 392 * N_EVAL)
  k393(u, out, 393 * N_EVAL)
  k394(u, out, 394 * N_EVAL)
  k395(u, out, 395 * N_EVAL)
  k396(u, out, 396 * N_EVAL)
  k397(u, out, 397 * N_EVAL)
  k398(u, out, 398 * N_EVAL)
  k399(u, out, 399 * N_EVAL)
  k400(u, out, 400 * N_EVAL)
  k401(u, out, 401 * N_EVAL)
  k402(u, out, 402 * N_EVAL)
  k403(u, out, 403 * N_EVAL)
  k404(u, out, 404 * N_EVAL)
  k405(u, out, 405 * N_EVAL)
  k406(u, out, 406 * N_EVAL)
  k407(u, out, 407 * N_EVAL)
  k408(u, out, 408 * N_EVAL)
  k409(u, out, 409 * N_EVAL)
  k410(u, out, 410 * N_EVAL)
  k411(u, out, 411 * N_EVAL)
  k412(u, out, 412 * N_EVAL)
  k413(u, out, 413 * N_EVAL)
  k414(u, out, 414 * N_EVAL)
  k415(u, out, 415 * N_EVAL)
  k416(u, out, 416 * N_EVAL)
  k417(u, out, 417 * N_EVAL)
  k418(u, out, 418 * N_EVAL)
  k419(u, out, 419 * N_EVAL)
  k420(u, out, 420 * N_EVAL)
  k421(u, out, 421 * N_EVAL)
  k422(u, out, 422 * N_EVAL)
  k423(u, out, 423 * N_EVAL)
  k424(u, out, 424 * N_EVAL)
  k425(u, out, 425 * N_EVAL)
  k426(u, out, 426 * N_EVAL)
  k427(u, out, 427 * N_EVAL)
  k428(u, out, 428 * N_EVAL)
}

// XorShift32, uniform in [0, 1): deterministic per target.
const uniform = (n, seed) => {
  const out = new Float64Array(n)
  let s = seed | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = (s >>> 0) / 4294967296
  }
  return out
}

// every word of every result
const checksum = (out) => {
  const w = new Uint32Array(out.buffer, out.byteOffset, out.length * 2)
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < w.length; i++) h = mix(h, w[i])
  return h >>> 0
}

const run = () => {
  const u = uniform(N_EVAL, 0x1234abcd)
  const out = new Float64Array(N_FN * N_EVAL)
  for (let i = 0; i < N_WARMUP; i++) sweep(u, out)
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    sweep(u, out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(out), N_FN * N_EVAL, 1, N_RUNS)
}

export { run as main }
