// stdlib-gamma.js — @stdlib/math/base/special/gamma from stdlib 0.4.1 (Apache-2.0), bundled from its CommonJS
// sources by scripts/stdlib-probe.mjs (`bench @stdlib/math/base/special/gamma stdlib-gamma unary 0 171`):
// the package's own code with the module seams gone, nothing rewritten. The
// sweep follows its benchmark/benchmark.js: inputs uniform in [0, 171].
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

var FLOAT64_NINF = Number.NEGATIVE_INFINITY;
var lib_default4 = FLOAT64_NINF;

function isNegativeZero(x) {
  return x === 0 && 1 / x === lib_default4;
}
var main_default4 = isNegativeZero;

var lib_default5 = main_default4;

function abs(x) {
  return Math.abs(x);
}
var main_default5 = abs;

var lib_default6 = main_default5;

var FLOAT64_HIGH_WORD_ABS_MASK = 2147483647 >>> 0;
var lib_default7 = FLOAT64_HIGH_WORD_ABS_MASK;

var FLOAT64_HIGH_WORD_EXPONENT_MASK = 2146435072;
var lib_default8 = FLOAT64_HIGH_WORD_EXPONENT_MASK;

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

var lib_default9 = main_default6;

function evalpoly(x) {
  if (x === 0) {
    return 0.0416666666666666;
  }
  return 0.0416666666666666 + x * (-0.001388888888887411 + x * 2480158728947673e-20);
}
var polyval_c13_default = evalpoly;

function evalpoly2(x) {
  if (x === 0) {
    return -27557314351390663e-23;
  }
  return -27557314351390663e-23 + x * (2087572321298175e-24 + x * -11359647557788195e-27);
}
var polyval_c46_default = evalpoly2;

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
var main_default7 = kernelCos;

var lib_default10 = main_default7;

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
var main_default8 = kernelSin;

var lib_default11 = main_default8;

var FLOAT64_HIGH_WORD_SIGNIFICAND_MASK = 1048575;
var lib_default12 = FLOAT64_HIGH_WORD_SIGNIFICAND_MASK;

var LOW;
if (is_little_endian_default === true) {
  LOW = 0;
} else {
  LOW = 1;
}
var low_default = LOW;

var FLOAT64_VIEW2 = new Float64Array(1);
var UINT32_VIEW2 = new Uint32Array(FLOAT64_VIEW2.buffer);
function getLowWord(x) {
  FLOAT64_VIEW2[0] = x;
  return UINT32_VIEW2[low_default];
}
var main_default9 = getLowWord;

var lib_default13 = main_default9;

var indices;
var HIGH2;
var LOW2;
if (is_little_endian_default === true) {
  HIGH2 = 1;
  LOW2 = 0;
} else {
  HIGH2 = 0;
  LOW2 = 1;
}
indices = {
  "HIGH": HIGH2,
  "LOW": LOW2
};
var indices_default = indices;

var FLOAT64_VIEW3 = new Float64Array(1);
var UINT32_VIEW3 = new Uint32Array(FLOAT64_VIEW3.buffer);
var HIGH3 = indices_default.HIGH;
var LOW3 = indices_default.LOW;
function fromWords(high, low) {
  UINT32_VIEW3[HIGH3] = high;
  UINT32_VIEW3[LOW3] = low;
  return FLOAT64_VIEW3[0];
}
var main_default10 = fromWords;

var lib_default14 = main_default10;

var FLOAT64_PINF = Number.POSITIVE_INFINITY;
var lib_default15 = FLOAT64_PINF;

var FLOAT64_EXPONENT_BIAS = 1023 | 0;
var lib_default16 = FLOAT64_EXPONENT_BIAS;

var FLOAT64_MAX_BASE2_EXPONENT = 1023 | 0;
var lib_default17 = FLOAT64_MAX_BASE2_EXPONENT;

var FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL = -1023 | 0;
var lib_default18 = FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL;

var FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL = -1074 | 0;
var lib_default19 = FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL;

function isInfinite(x) {
  return x === lib_default15 || x === lib_default4;
}
var main_default11 = isInfinite;

var lib_default20 = main_default11;

var FLOAT64_HIGH_WORD_SIGN_MASK = 2147483648 >>> 0;
var lib_default21 = FLOAT64_HIGH_WORD_SIGN_MASK;

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
function toWords(x, out, stride, offset) {
  FLOAT64_VIEW4[0] = x;
  out[offset] = UINT32_VIEW4[HIGH5];
  out[offset + stride] = UINT32_VIEW4[LOW5];
  return out;
}
var assign_default = toWords;

function toWords2(x) {
  return assign_default(x, [0 >>> 0, 0 >>> 0], 1, 0);
}
var main_default12 = toWords2;

main_default12.assign = assign_default;
var lib_default22 = main_default12;

var WORDS = [0, 0];
function copysign(x, y) {
  var hx;
  var hy;
  lib_default22.assign(x, WORDS, 1, 0);
  hx = WORDS[0];
  hx &= lib_default7;
  hy = lib_default9(y);
  hy &= lib_default21;
  hx |= hy;
  return lib_default14(hx, WORDS[1]);
}
var main_default13 = copysign;

var lib_default23 = main_default13;

function exponent(x) {
  var high = lib_default9(x);
  high = (high & lib_default8) >>> 20;
  return high - lib_default16 | 0;
}
var main_default14 = exponent;

var lib_default24 = main_default14;

var FLOAT64_SMALLEST_NORMAL = 22250738585072014e-324;
var lib_default25 = FLOAT64_SMALLEST_NORMAL;

var SCALAR = 4503599627370496;
function normalize(x, out, stride, offset) {
  if (lib_default(x) || lib_default20(x)) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  if (x !== 0 && lib_default6(x) < lib_default25) {
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
var main_default15 = normalize2;

main_default15.assign = assign_default2;
var lib_default26 = main_default15;

var normalize3 = lib_default26.assign;
var TWO52_INV = 2220446049250313e-31;
var CLEAR_EXP_MASK = 2148532223 >>> 0;
var FRAC = [0, 0];
var WORDS2 = [0, 0];
function ldexp(frac, exp2) {
  var high;
  var m;
  if (exp2 === 0 || frac === 0 || // handles +-0
  lib_default(frac) || lib_default20(frac)) {
    return frac;
  }
  normalize3(frac, FRAC, 1, 0);
  frac = FRAC[0];
  exp2 += FRAC[1];
  exp2 += lib_default24(frac);
  if (exp2 < lib_default19) {
    return lib_default23(0, frac);
  }
  if (exp2 > lib_default17) {
    if (frac < 0) {
      return lib_default4;
    }
    return lib_default15;
  }
  if (exp2 <= lib_default18) {
    exp2 += 52;
    m = TWO52_INV;
  } else {
    m = 1;
  }
  lib_default22.assign(frac, WORDS2, 1, 0);
  high = WORDS2[0];
  high &= CLEAR_EXP_MASK;
  high |= exp2 + lib_default16 << 20;
  return m * lib_default14(high, WORDS2[1]);
}
var main_default16 = ldexp;

var lib_default27 = main_default16;

function filled(value, len) {
  var arr;
  var i;
  arr = [];
  for (i = 0; i < len; i++) {
    arr.push(value);
  }
  return arr;
}
var main_default17 = filled;

var lib_default28 = main_default17;

function zeros(len) {
  return lib_default28(0, len);
}
var main_default18 = zeros;

var lib_default29 = main_default18;

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
var F = lib_default29(20);
var Q = lib_default29(20);
var FQ = lib_default29(20);
var IQ = lib_default29(20);
function compute(x, y, jz, q, q0, jk, jv, jx, f) {
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
  z = lib_default27(z, q0);
  z -= 8 * lib_default2(z * 0.125);
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
        z -= lib_default27(1, q0);
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
        f[jx + i] = IPIO2[jv + i];
        fw = 0;
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
    while (IQ[jz] === 0) {
      jz -= 1;
      q0 -= 24;
    }
  } else {
    z = lib_default27(z, -q0);
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
  fw = lib_default27(1, q0);
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
var main_default19 = round;

var lib_default30 = main_default19;

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
  n = lib_default30(x * INVPIO2);
  r = x - n * PIO2_1;
  w = n * PIO2_1T;
  j = ix >> 20 | 0;
  y[0] = r - w;
  high = lib_default9(y[0]);
  i = j - (high >> 20 & EXPONENT_MASK);
  if (i > 16) {
    t = r;
    w = n * PIO2_2;
    r = t - w;
    w = n * PIO2_2T - (t - r - w);
    y[0] = r - w;
    high = lib_default9(y[0]);
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
  hx = lib_default9(x) | 0;
  ix = hx & lib_default7 | 0;
  if (ix <= PIO4_HIGH_WORD) {
    y[0] = x;
    y[1] = 0;
    return 0;
  }
  if (ix <= FIVE_PIO4_HIGH_WORD) {
    if ((ix & lib_default12) === PI_HIGH_WORD_SIGNIFICAND) {
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
  if (ix >= lib_default8) {
    y[0] = NaN;
    y[1] = NaN;
    return 0;
  }
  low = lib_default13(x);
  e0 = (ix >> 20) - 1046;
  z = lib_default14(ix - (e0 << 20 | 0), low);
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
var main_default20 = rempio2;

var lib_default31 = main_default20;

var PIO4_HIGH_WORD2 = 1072243195 | 0;
var SMALL_HIGH_WORD = 1045430272 | 0;
var Y = [0, 0];
function sin(x) {
  var ix;
  var n;
  ix = lib_default9(x);
  ix &= lib_default7;
  if (ix <= PIO4_HIGH_WORD2) {
    if (ix < SMALL_HIGH_WORD) {
      return x;
    }
    return lib_default11(x, 0);
  }
  if (ix >= lib_default8) {
    return NaN;
  }
  n = lib_default31(x, Y);
  switch (n & 3) {
    case 0:
      return lib_default11(Y[0], Y[1]);
    case 1:
      return lib_default10(Y[0], Y[1]);
    case 2:
      return -lib_default11(Y[0], Y[1]);
    default:
      return -lib_default10(Y[0], Y[1]);
  }
}
var main_default21 = sin;

var lib_default32 = main_default21;

var PI = 3.141592653589793;
var lib_default33 = PI;

var SQRT_TWO_PI = 2.5066282746310007;
var lib_default34 = SQRT_TWO_PI;

function isEven(x) {
  return lib_default3(x / 2);
}
var main_default22 = isEven;

var lib_default35 = main_default22;

function isOdd(x) {
  if (x > 0) {
    return lib_default35(x - 1);
  }
  return lib_default35(x + 1);
}
var main_default23 = isOdd;

var lib_default36 = main_default23;

var sqrt = Math.sqrt;
var main_default24 = sqrt;

var lib_default37 = main_default24;

var LOW6;
if (is_little_endian_default === true) {
  LOW6 = 0;
} else {
  LOW6 = 1;
}
var low_default2 = LOW6;

var FLOAT64_VIEW5 = new Float64Array(1);
var UINT32_VIEW5 = new Uint32Array(FLOAT64_VIEW5.buffer);
function setLowWord(x, low) {
  FLOAT64_VIEW5[0] = x;
  UINT32_VIEW5[low_default2] = low >>> 0;
  return FLOAT64_VIEW5[0];
}
var main_default25 = setLowWord;

var lib_default38 = main_default25;

function uint32ToInt32(x) {
  return x | 0;
}
var main_default26 = uint32ToInt32;

var lib_default39 = main_default26;

function pow(x, y) {
  if (y === lib_default4) {
    return lib_default15;
  }
  if (y === lib_default15) {
    return 0;
  }
  if (y > 0) {
    if (lib_default36(y)) {
      return x;
    }
    return 0;
  }
  if (lib_default36(y)) {
    return lib_default23(lib_default15, x);
  }
  return lib_default15;
}
var x_is_zero_default = pow;

var HIGH_MAX_NEAR_UNITY = 1072693247 | 0;
var HUGE = 1e300;
var TINY = 1e-300;
function pow2(x, y) {
  var ahx;
  var hx;
  hx = lib_default9(x);
  ahx = hx & lib_default7;
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
  if (lib_default6(x) < 1 === (y === lib_default15)) {
    return 0;
  }
  return lib_default15;
}
var y_is_infinite_default = pow3;

var HIGH6;
if (is_little_endian_default === true) {
  HIGH6 = 1;
} else {
  HIGH6 = 0;
}
var high_default2 = HIGH6;

var FLOAT64_VIEW6 = new Float64Array(1);
var UINT32_VIEW6 = new Uint32Array(FLOAT64_VIEW6.buffer);
function setHighWord(x, high) {
  FLOAT64_VIEW6[0] = x;
  UINT32_VIEW6[high_default2] = high >>> 0;
  return FLOAT64_VIEW6[0];
}
var main_default27 = setHighWord;

var lib_default40 = main_default27;

var FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS = 20 | 0;
var lib_default41 = FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS;

function evalpoly3(x) {
  if (x === 0) {
    return 0.5999999999999946;
  }
  return 0.5999999999999946 + x * (0.4285714285785502 + x * (0.33333332981837743 + x * (0.272728123808534 + x * (0.23066074577556175 + x * 0.20697501780033842))));
}
var polyval_l_default = evalpoly3;

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
    ahx = lib_default9(ax);
  }
  n += (ahx >> lib_default41) - lib_default16 | 0;
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
  ax = lib_default40(ax, ahx);
  bp = BP[k];
  u = ax - bp;
  v = 1 / (ax + bp);
  ss = u * v;
  hs = lib_default38(ss, 0);
  tmp = (ahx >> 1 | HIGH_BIASED_EXP_NEG_512) + HIGH_SIGNIFICAND_HALF;
  tmp += k << 18;
  ht = lib_default40(0, tmp);
  lt = ax - (ht - bp);
  ls = v * (u - hs * ht - hs * lt);
  s2 = ss * ss;
  r = s2 * s2 * polyval_l_default(s2);
  r += ls * (hs + ss);
  s2 = hs * hs;
  ht = 3 + s2 + r;
  ht = lib_default38(ht, 0);
  lt = r - (ht - 3 - s2);
  u = hs * ht;
  v = ls * ht + lt * ss;
  hp = u + v;
  hp = lib_default38(hp, 0);
  lp = v - (hp - u);
  hz = CP_HI * hp;
  lz = CP_LO * hp + lp * CP + DP_LO[k];
  dp = DP_HI[k];
  t = n;
  t1 = hz + lz + dp + t;
  t1 = lib_default38(t1, 0);
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
  t1 = lib_default38(t1, 0);
  t2 = v - (t1 - u);
  out[0] = t1;
  out[1] = t2;
  return out;
}
var logx_default = logx;

var LN2 = 0.6931471805599453;
var lib_default42 = LN2;

function evalpoly5(x) {
  if (x === 0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6613756321437934e-20 + x * (-16533902205465252e-22 + x * 41381367970572385e-24)));
}
var polyval_p_default = evalpoly5;

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
  i = j & lib_default7 | 0;
  k = (i >> lib_default41) - lib_default16 | 0;
  n = 0;
  if (i > HIGH_BIASED_EXP_NEG_1) {
    n = j + (HIGH_MIN_NORMAL_EXP2 >> k + 1) >>> 0;
    k = ((n & lib_default7) >> lib_default41) - lib_default16 | 0;
    tmp = (n & ~(lib_default12 >> k)) >>> 0;
    t = lib_default40(0, tmp);
    n = (n & lib_default12 | HIGH_MIN_NORMAL_EXP2) >> lib_default41 - k >>> 0;
    if (j < 0) {
      n = -n;
    }
    hp -= t;
  }
  t = lp + hp;
  t = lib_default38(t, 0);
  u = t * LN2_HI;
  v = (lp - (t - hp)) * lib_default42 + t * LN2_LO;
  z = u + v;
  w = v - (z - u);
  t = z * z;
  t1 = z - t * polyval_p_default(t);
  r = z * t1 / (t1 - 2) - (w + z * w);
  z = 1 - (r - z);
  j = lib_default9(z);
  j = lib_default39(j);
  j += n << lib_default41 >>> 0;
  if (j >> lib_default41 <= 0) {
    z = lib_default27(z, n);
  } else {
    z = lib_default40(z, j);
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
  lib_default22.assign(y, WORDS3, 1, 0);
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
      return lib_default37(x);
    }
    if (y === -0.5) {
      return 1 / lib_default37(x);
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
    if (lib_default20(y)) {
      return y_is_infinite_default(x, y);
    }
  }
  lib_default22.assign(x, WORDS3, 1, 0);
  hx = WORDS3[0];
  lx = WORDS3[1];
  if (lx === 0) {
    if (hx === 0) {
      return x_is_zero_default(x, y);
    }
    if (x === 1) {
      return 1;
    }
    if (x === -1 && lib_default36(y)) {
      return -1;
    }
    if (lib_default20(x)) {
      if (x === lib_default4) {
        return pow4(-0, -y);
      }
      if (y < 0) {
        return 0;
      }
      return lib_default15;
    }
  }
  if (x < 0 && lib_default3(y) === false) {
    return (x - x) / (x - x);
  }
  ax = lib_default6(x);
  ahx = hx & lib_default7 | 0;
  ahy = hy & lib_default7 | 0;
  sx = hx >>> HIGH_NUM_NONSIGN_BITS | 0;
  sy = hy >>> HIGH_NUM_NONSIGN_BITS | 0;
  if (sx && lib_default36(y)) {
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
  y1 = lib_default38(y, 0);
  lp = (y - y1) * t[0] + y * t[1];
  hp = y1 * t[0];
  z = lp + hp;
  lib_default22.assign(z, WORDS3, 1, 0);
  j = lib_default39(WORDS3[0]);
  i = lib_default39(WORDS3[1]);
  if (j >= HIGH_BIASED_EXP_10) {
    if ((j - HIGH_BIASED_EXP_10 | i) !== 0) {
      return sx * HUGE2 * HUGE2;
    }
    if (lp + OVT > z - hp) {
      return sx * HUGE2 * HUGE2;
    }
  } else if ((j & lib_default7) >= HIGH_1075) {
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
var main_default28 = pow4;

var lib_default43 = main_default28;

var ceil = Math.ceil;
var main_default29 = ceil;

var lib_default44 = main_default29;

function trunc(x) {
  if (x < 0) {
    return lib_default44(x);
  }
  return lib_default2(x);
}
var main_default30 = trunc;

var lib_default45 = main_default30;

function evalpoly6(x) {
  if (x === 0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6613756321437934e-20 + x * (-16533902205465252e-22 + x * 41381367970572385e-24)));
}
var polyval_p_default2 = evalpoly6;

function expmulti(hi, lo, k) {
  var r;
  var t;
  var c;
  var y;
  r = hi - lo;
  t = r * r;
  c = r - t * polyval_p_default2(t);
  y = 1 - (lo - r * c / (2 - c) - hi);
  return lib_default27(y, k);
}
var expmulti_default = expmulti;

var LN2_HI2 = 0.6931471803691238;
var LN2_LO2 = 19082149292705877e-26;
var LOG2_E = 1.4426950408889634;
var OVERFLOW = 709.782712893384;
var UNDERFLOW = -745.1332191019411;
var NEARZERO = 1 / (1 << 28);
var NEG_NEARZERO = -NEARZERO;
function exp(x) {
  var hi;
  var lo;
  var k;
  if (lib_default(x) || x === lib_default15) {
    return x;
  }
  if (x === lib_default4) {
    return 0;
  }
  if (x > OVERFLOW) {
    return lib_default15;
  }
  if (x < UNDERFLOW) {
    return 0;
  }
  if (x > NEG_NEARZERO && x < NEARZERO) {
    return 1 + x;
  }
  if (x < 0) {
    k = lib_default45(LOG2_E * x - 0.5);
  } else {
    k = lib_default45(LOG2_E * x + 0.5);
  }
  hi = x - k * LN2_HI2;
  lo = k * LN2_LO2;
  return expmulti_default(hi, lo, k);
}
var main_default31 = exp;

var lib_default46 = main_default31;

function evalpoly7(x) {
  if (x === 0) {
    return 0.08333333333334822;
  }
  return 0.08333333333334822 + x * (0.0034722222160545866 + x * (-0.0026813261780578124 + x * (-22954996161337813e-20 + x * 7873113957930937e-19)));
}
var polyval_s_default = evalpoly7;

var MAX_STIRLING = 143.01608;
function gamma(x) {
  var w;
  var y;
  var v;
  w = 1 / x;
  w = 1 + w * polyval_s_default(w);
  y = lib_default46(x);
  if (x > MAX_STIRLING) {
    v = lib_default43(x, 0.5 * x - 0.25);
    y = v * (v / y);
  } else {
    y = lib_default43(x, x - 0.5) / y;
  }
  return lib_default34 * y * w;
}
var stirling_approximation_default = gamma;

var EULERGAMMA = 0.5772156649015329;
var lib_default47 = EULERGAMMA;

function gamma2(x, z) {
  return z / ((1 + lib_default47 * x) * x);
}
var small_approximation_default = gamma2;

function evalrational(x) {
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
var rational_pq_default = evalrational;

function gamma3(x) {
  var sign;
  var q;
  var p;
  var z;
  if (lib_default3(x) && x < 0 || x === lib_default4 || lib_default(x)) {
    return NaN;
  }
  if (x === 0) {
    if (lib_default5(x)) {
      return lib_default4;
    }
    return lib_default15;
  }
  if (x > 171.61447887182297) {
    return lib_default15;
  }
  if (x < -170.5674972726612) {
    return 0;
  }
  q = lib_default6(x);
  if (q > 33) {
    if (x >= 0) {
      return stirling_approximation_default(x);
    }
    p = lib_default2(q);
    if ((p & 1) === 0) {
      sign = -1;
    } else {
      sign = 1;
    }
    z = q - p;
    if (z > 0.5) {
      p += 1;
      z = q - p;
    }
    z = q * lib_default32(lib_default33 * z);
    return sign * lib_default33 / (lib_default6(z) * stirling_approximation_default(q));
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
  return z * rational_pq_default(x);
}
var main_default32 = gamma3;

var lib_default48 = main_default32;

// ../../../../driver.js
var driver_default = lib_default48;

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
  const x = uniform(N_IN, 0, 171, 0x1234abcd)
  const out = new Float64Array(N_EVAL)
  const sweep = () => { for (let i = 0; i < N_EVAL; i++) out[i] = fn(x[i & (N_IN - 1)]) }
  for (let i = 0; i < N_WARMUP; i++) sweep()
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    sweep()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksumF64(out), N_EVAL, 1, N_RUNS)
}

export { run as main }
