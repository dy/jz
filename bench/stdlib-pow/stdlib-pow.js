// stdlib-pow.js — @stdlib/math/base/special/pow from stdlib 0.4.1 (Apache-2.0), bundled from its CommonJS
// sources by scripts/stdlib-probe.mjs (`bench @stdlib/math/base/special/pow stdlib-pow binary 0 100 -50 50`):
// the package's own code with the module seams gone, nothing rewritten. The
// sweep follows its benchmark/benchmark.js: inputs uniform in [0, 100] and [-50, 50].
// Copyright (c) The Stdlib Authors. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0); the notices of the bundled files
// are retained by reference to the package.
import { checksumF64, medianUs, printResult } from '../_lib/benchlib.js'

function isnan(x) {
  return x !== x;
}
var main_default = isnan;

var lib_default = main_default;

var floor = Math.floor;
var main_default2 = floor;

var lib_default2 = main_default2;

function isInteger(x) {
  return lib_default2(x) === x;
}
var main_default3 = isInteger;

var lib_default3 = main_default3;

function isEven(x) {
  return lib_default3(x / 2);
}
var main_default4 = isEven;

var lib_default4 = main_default4;

function isOdd(x) {
  if (x > 0) {
    return lib_default4(x - 1);
  }
  return lib_default4(x + 1);
}
var main_default5 = isOdd;

var lib_default5 = main_default5;

var FLOAT64_PINF = Number.POSITIVE_INFINITY;
var lib_default6 = FLOAT64_PINF;

var FLOAT64_NINF = Number.NEGATIVE_INFINITY;
var lib_default7 = FLOAT64_NINF;

function isInfinite(x) {
  return x === lib_default6 || x === lib_default7;
}
var main_default6 = isInfinite;

var lib_default8 = main_default6;

var sqrt = Math.sqrt;
var main_default7 = sqrt;

var lib_default9 = main_default7;

function abs(x) {
  return Math.abs(x);
}
var main_default8 = abs;

var lib_default10 = main_default8;

var is_little_endian_default = true;

var indices;
var HIGH;
var LOW;
if (is_little_endian_default === true) {
  HIGH = 1;
  LOW = 0;
} else {
  HIGH = 0;
  LOW = 1;
}
indices = {
  "HIGH": HIGH,
  "LOW": LOW
};
var indices_default = indices;

var FLOAT64_VIEW = new Float64Array(1);
var UINT32_VIEW = new Uint32Array(FLOAT64_VIEW.buffer);
var HIGH2 = indices_default.HIGH;
var LOW2 = indices_default.LOW;
function toWords(x, out, stride, offset) {
  FLOAT64_VIEW[0] = x;
  out[offset] = UINT32_VIEW[HIGH2];
  out[offset + stride] = UINT32_VIEW[LOW2];
  return out;
}
var assign_default = toWords;

function toWords2(x) {
  return assign_default(x, [0 >>> 0, 0 >>> 0], 1, 0);
}
var main_default9 = toWords2;

main_default9.assign = assign_default;
var lib_default11 = main_default9;

var LOW3;
if (is_little_endian_default === true) {
  LOW3 = 0;
} else {
  LOW3 = 1;
}
var low_default = LOW3;

var FLOAT64_VIEW2 = new Float64Array(1);
var UINT32_VIEW2 = new Uint32Array(FLOAT64_VIEW2.buffer);
function setLowWord(x, low) {
  FLOAT64_VIEW2[0] = x;
  UINT32_VIEW2[low_default] = low >>> 0;
  return FLOAT64_VIEW2[0];
}
var main_default10 = setLowWord;

var lib_default12 = main_default10;

function uint32ToInt32(x) {
  return x | 0;
}
var main_default11 = uint32ToInt32;

var lib_default13 = main_default11;

var FLOAT64_HIGH_WORD_ABS_MASK = 2147483647 >>> 0;
var lib_default14 = FLOAT64_HIGH_WORD_ABS_MASK;

var FLOAT64_HIGH_WORD_SIGN_MASK = 2147483648 >>> 0;
var lib_default15 = FLOAT64_HIGH_WORD_SIGN_MASK;

var HIGH3;
if (is_little_endian_default === true) {
  HIGH3 = 1;
} else {
  HIGH3 = 0;
}
var high_default = HIGH3;

var FLOAT64_VIEW3 = new Float64Array(1);
var UINT32_VIEW3 = new Uint32Array(FLOAT64_VIEW3.buffer);
function getHighWord(x) {
  FLOAT64_VIEW3[0] = x;
  return UINT32_VIEW3[high_default];
}
var main_default12 = getHighWord;

var lib_default16 = main_default12;

var indices2;
var HIGH4;
var LOW4;
if (is_little_endian_default === true) {
  HIGH4 = 1;
  LOW4 = 0;
} else {
  HIGH4 = 0;
  LOW4 = 1;
}
indices2 = {
  "HIGH": HIGH4,
  "LOW": LOW4
};
var indices_default2 = indices2;

var FLOAT64_VIEW4 = new Float64Array(1);
var UINT32_VIEW4 = new Uint32Array(FLOAT64_VIEW4.buffer);
var HIGH5 = indices_default2.HIGH;
var LOW5 = indices_default2.LOW;
function fromWords(high, low) {
  UINT32_VIEW4[HIGH5] = high;
  UINT32_VIEW4[LOW5] = low;
  return FLOAT64_VIEW4[0];
}
var main_default13 = fromWords;

var lib_default17 = main_default13;

var WORDS = [0, 0];
function copysign(x, y) {
  var hx;
  var hy;
  lib_default11.assign(x, WORDS, 1, 0);
  hx = WORDS[0];
  hx &= lib_default14;
  hy = lib_default16(y);
  hy &= lib_default15;
  hx |= hy;
  return lib_default17(hx, WORDS[1]);
}
var main_default14 = copysign;

var lib_default18 = main_default14;

function pow(x, y) {
  if (y === lib_default7) {
    return lib_default6;
  }
  if (y === lib_default6) {
    return 0;
  }
  if (y > 0) {
    if (lib_default5(y)) {
      return x;
    }
    return 0;
  }
  if (lib_default5(y)) {
    return lib_default18(lib_default6, x);
  }
  return lib_default6;
}
var x_is_zero_default = pow;

var HIGH_MAX_NEAR_UNITY = 1072693247 | 0;
var HUGE = 1e300;
var TINY = 1e-300;
function pow2(x, y) {
  var ahx;
  var hx;
  hx = lib_default16(x);
  ahx = hx & lib_default14;
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
  if (lib_default10(x) < 1 === (y === lib_default6)) {
    return 0;
  }
  return lib_default6;
}
var y_is_infinite_default = pow3;

var HIGH6;
if (is_little_endian_default === true) {
  HIGH6 = 1;
} else {
  HIGH6 = 0;
}
var high_default2 = HIGH6;

var FLOAT64_VIEW5 = new Float64Array(1);
var UINT32_VIEW5 = new Uint32Array(FLOAT64_VIEW5.buffer);
function setHighWord(x, high) {
  FLOAT64_VIEW5[0] = x;
  UINT32_VIEW5[high_default2] = high >>> 0;
  return FLOAT64_VIEW5[0];
}
var main_default15 = setHighWord;

var lib_default19 = main_default15;

var FLOAT64_EXPONENT_BIAS = 1023 | 0;
var lib_default20 = FLOAT64_EXPONENT_BIAS;

var FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS = 20 | 0;
var lib_default21 = FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS;

function evalpoly(x) {
  if (x === 0) {
    return 0.5999999999999946;
  }
  return 0.5999999999999946 + x * (0.4285714285785502 + x * (0.33333332981837743 + x * (0.272728123808534 + x * (0.23066074577556175 + x * 0.20697501780033842))));
}
var polyval_l_default = evalpoly;

var HIGH_SIGNIFICAND_MASK = 1048575 | 0;
var HIGH_MIN_NORMAL_EXP = 1048576 | 0;
var HIGH_BIASED_EXP_0 = 1072693248 | 0;
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
  if (ahx < HIGH_MIN_NORMAL_EXP) {
    ax *= TWO53;
    n -= 53 | 0;
    ahx = lib_default16(ax);
  }
  n += (ahx >> lib_default21) - lib_default20 | 0;
  j = ahx & HIGH_SIGNIFICAND_MASK | 0;
  ahx = j | HIGH_BIASED_EXP_0 | 0;
  if (j <= 235662) {
    k = 0;
  } else if (j < 767610) {
    k = 1;
  } else {
    k = 0;
    n += 1 | 0;
    ahx -= HIGH_MIN_NORMAL_EXP;
  }
  ax = lib_default19(ax, ahx);
  bp = BP[k];
  u = ax - bp;
  v = 1 / (ax + bp);
  ss = u * v;
  hs = lib_default12(ss, 0);
  tmp = (ahx >> 1 | HIGH_BIASED_EXP_NEG_512) + HIGH_SIGNIFICAND_HALF;
  tmp += k << 18;
  ht = lib_default19(0, tmp);
  lt = ax - (ht - bp);
  ls = v * (u - hs * ht - hs * lt);
  s2 = ss * ss;
  r = s2 * s2 * polyval_l_default(s2);
  r += ls * (hs + ss);
  s2 = hs * hs;
  ht = 3 + s2 + r;
  ht = lib_default12(ht, 0);
  lt = r - (ht - 3 - s2);
  u = hs * ht;
  v = ls * ht + lt * ss;
  hp = u + v;
  hp = lib_default12(hp, 0);
  lp = v - (hp - u);
  hz = CP_HI * hp;
  lz = CP_LO * hp + lp * CP + DP_LO[k];
  dp = DP_HI[k];
  t = n;
  t1 = hz + lz + dp + t;
  t1 = lib_default12(t1, 0);
  t2 = lz - (t1 - t - dp - hz);
  out[0] = t1;
  out[1] = t2;
  return out;
}
var log2ax_default = log2ax;

function evalpoly2(x) {
  if (x === 0) {
    return 0.5;
  }
  return 0.5 + x * (-0.3333333333333333 + x * 0.25);
}
var polyval_w_default = evalpoly2;

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
  t1 = lib_default12(t1, 0);
  t2 = v - (t1 - u);
  out[0] = t1;
  out[1] = t2;
  return out;
}
var logx_default = logx;

var FLOAT64_MAX_BASE2_EXPONENT = 1023 | 0;
var lib_default22 = FLOAT64_MAX_BASE2_EXPONENT;

var FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL = -1023 | 0;
var lib_default23 = FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL;

var FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL = -1074 | 0;
var lib_default24 = FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL;

var FLOAT64_HIGH_WORD_EXPONENT_MASK = 2146435072;
var lib_default25 = FLOAT64_HIGH_WORD_EXPONENT_MASK;

function exponent(x) {
  var high = lib_default16(x);
  high = (high & lib_default25) >>> 20;
  return high - lib_default20 | 0;
}
var main_default16 = exponent;

var lib_default26 = main_default16;

var FLOAT64_SMALLEST_NORMAL = 22250738585072014e-324;
var lib_default27 = FLOAT64_SMALLEST_NORMAL;

var SCALAR = 4503599627370496;
function normalize(x, out, stride, offset) {
  if (lib_default(x) || lib_default8(x)) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  if (x !== 0 && lib_default10(x) < lib_default27) {
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
var main_default17 = normalize2;

main_default17.assign = assign_default2;
var lib_default28 = main_default17;

var normalize3 = lib_default28.assign;
var TWO52_INV = 2220446049250313e-31;
var CLEAR_EXP_MASK = 2148532223 >>> 0;
var FRAC = [0, 0];
var WORDS2 = [0, 0];
function ldexp(frac, exp) {
  var high;
  var m;
  if (exp === 0 || frac === 0 || // handles +-0
  lib_default(frac) || lib_default8(frac)) {
    return frac;
  }
  normalize3(frac, FRAC, 1, 0);
  frac = FRAC[0];
  exp += FRAC[1];
  exp += lib_default26(frac);
  if (exp < lib_default24) {
    return lib_default18(0, frac);
  }
  if (exp > lib_default22) {
    if (frac < 0) {
      return lib_default7;
    }
    return lib_default6;
  }
  if (exp <= lib_default23) {
    exp += 52;
    m = TWO52_INV;
  } else {
    m = 1;
  }
  lib_default11.assign(frac, WORDS2, 1, 0);
  high = WORDS2[0];
  high &= CLEAR_EXP_MASK;
  high |= exp + lib_default20 << 20;
  return m * lib_default17(high, WORDS2[1]);
}
var main_default18 = ldexp;

var lib_default29 = main_default18;

var LN2 = 0.6931471805599453;
var lib_default30 = LN2;

var FLOAT64_HIGH_WORD_SIGNIFICAND_MASK = 1048575;
var lib_default31 = FLOAT64_HIGH_WORD_SIGNIFICAND_MASK;

function evalpoly3(x) {
  if (x === 0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6613756321437934e-20 + x * (-16533902205465252e-22 + x * 41381367970572385e-24)));
}
var polyval_p_default = evalpoly3;

var HIGH_MIN_NORMAL_EXP2 = 1048576 | 0;
var HIGH_BIASED_EXP_NEG_1 = 1071644672 | 0;
var LN2_HI = 0.6931471824645996;
var LN2_LO = -1904654299957768e-24;
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
  i = j & lib_default14 | 0;
  k = (i >> lib_default21) - lib_default20 | 0;
  n = 0;
  if (i > HIGH_BIASED_EXP_NEG_1) {
    n = j + (HIGH_MIN_NORMAL_EXP2 >> k + 1) >>> 0;
    k = ((n & lib_default14) >> lib_default21) - lib_default20 | 0;
    tmp = (n & ~(lib_default31 >> k)) >>> 0;
    t = lib_default19(0, tmp);
    n = (n & lib_default31 | HIGH_MIN_NORMAL_EXP2) >> lib_default21 - k >>> 0;
    if (j < 0) {
      n = -n;
    }
    hp -= t;
  }
  t = lp + hp;
  t = lib_default12(t, 0);
  u = t * LN2_HI;
  v = (lp - (t - hp)) * lib_default30 + t * LN2_LO;
  z = u + v;
  w = v - (z - u);
  t = z * z;
  t1 = z - t * polyval_p_default(t);
  r = z * t1 / (t1 - 2) - (w + z * w);
  z = 1 - (r - z);
  j = lib_default16(z);
  j = lib_default13(j);
  j += n << lib_default21 >>> 0;
  if (j >> lib_default21 <= 0) {
    z = lib_default29(z, n);
  } else {
    z = lib_default19(z, j);
  }
  return z;
}
var pow2_default = pow22;

var HIGH_MAX_NEAR_UNITY2 = 1072693247 | 0;
var HIGH_BIASED_EXP_31 = 1105199104 | 0;
var HIGH_BIASED_EXP_64 = 1139802112 | 0;
var HIGH_BIASED_EXP_10 = 1083179008 | 0;
var HIGH_BIASED_EXP_02 = 1072693248 | 0;
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
  lib_default11.assign(y, WORDS3, 1, 0);
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
      return lib_default9(x);
    }
    if (y === -0.5) {
      return 1 / lib_default9(x);
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
    if (lib_default8(y)) {
      return y_is_infinite_default(x, y);
    }
  }
  lib_default11.assign(x, WORDS3, 1, 0);
  hx = WORDS3[0];
  lx = WORDS3[1];
  if (lx === 0) {
    if (hx === 0) {
      return x_is_zero_default(x, y);
    }
    if (x === 1) {
      return 1;
    }
    if (x === -1 && lib_default5(y)) {
      return -1;
    }
    if (lib_default8(x)) {
      if (x === lib_default7) {
        return pow4(-0, -y);
      }
      if (y < 0) {
        return 0;
      }
      return lib_default6;
    }
  }
  if (x < 0 && lib_default3(y) === false) {
    return (x - x) / (x - x);
  }
  ax = lib_default10(x);
  ahx = hx & lib_default14 | 0;
  ahy = hy & lib_default14 | 0;
  sx = hx >>> HIGH_NUM_NONSIGN_BITS | 0;
  sy = hy >>> HIGH_NUM_NONSIGN_BITS | 0;
  if (sx && lib_default5(y)) {
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
    if (ahx > HIGH_BIASED_EXP_02) {
      if (sy === 0) {
        return sx * HUGE2 * HUGE2;
      }
      return sx * TINY2 * TINY2;
    }
    t = logx_default(LOG_WORKSPACE, ax);
  } else {
    t = log2ax_default(LOG_WORKSPACE, ax, ahx);
  }
  y1 = lib_default12(y, 0);
  lp = (y - y1) * t[0] + y * t[1];
  hp = y1 * t[0];
  z = lp + hp;
  lib_default11.assign(z, WORDS3, 1, 0);
  j = lib_default13(WORDS3[0]);
  i = lib_default13(WORDS3[1]);
  if (j >= HIGH_BIASED_EXP_10) {
    if ((j - HIGH_BIASED_EXP_10 | i) !== 0) {
      return sx * HUGE2 * HUGE2;
    }
    if (lp + OVT > z - hp) {
      return sx * HUGE2 * HUGE2;
    }
  } else if ((j & lib_default14) >= HIGH_1075) {
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
var main_default19 = pow4;

var lib_default32 = main_default19;

// ../../../../driver.js
var driver_default = lib_default32;

const fn = driver_default
const N_IN = 4096
const N_EVAL = 1 << 20
const N_RUNS = 21
const N_WARMUP = 5

// XorShift32, uniform in [lo, hi): deterministic per target.
const uniform = (n, lo, hi, seed) => {
  const out = new Float64Array(n)
  let s = seed | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = lo + ((s >>> 0) / 4294967296) * (hi - lo)
  }
  return out
}

const run = () => {
  const x = uniform(N_IN, 0, 100, 0x1234abcd), y = uniform(N_IN, -50, 50, 0x9e3779b9)
  const out = new Float64Array(N_EVAL)
  const sweep = () => { for (let i = 0; i < N_EVAL; i++) out[i] = fn(x[i & (N_IN - 1)], y[i & (N_IN - 1)]) }
  for (let i = 0; i < N_WARMUP; i++) sweep()
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    sweep()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), N_EVAL, 1, N_RUNS)
}

export let main = () => {
  run()
}
