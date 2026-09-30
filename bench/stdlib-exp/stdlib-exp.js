// stdlib-exp.js — @stdlib/math/base/special/exp from stdlib 0.4.1 (Apache-2.0), bundled from its CommonJS
// sources by scripts/stdlib-probe.mjs (`bench @stdlib/math/base/special/exp stdlib-exp unary -50 50`):
// the package's own code with the module seams gone, nothing rewritten. The
// sweep follows its benchmark/benchmark.js: inputs uniform in [-50, 50].
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

var ceil = Math.ceil;
var main_default3 = ceil;

var lib_default3 = main_default3;

function trunc(x) {
  if (x < 0) {
    return lib_default3(x);
  }
  return lib_default2(x);
}
var main_default4 = trunc;

var lib_default4 = main_default4;

var FLOAT64_NINF = Number.NEGATIVE_INFINITY;
var lib_default5 = FLOAT64_NINF;

var FLOAT64_PINF = Number.POSITIVE_INFINITY;
var lib_default6 = FLOAT64_PINF;

var FLOAT64_EXPONENT_BIAS = 1023 | 0;
var lib_default7 = FLOAT64_EXPONENT_BIAS;

var FLOAT64_MAX_BASE2_EXPONENT = 1023 | 0;
var lib_default8 = FLOAT64_MAX_BASE2_EXPONENT;

var FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL = -1023 | 0;
var lib_default9 = FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL;

var FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL = -1074 | 0;
var lib_default10 = FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL;

function isInfinite(x) {
  return x === lib_default6 || x === lib_default5;
}
var main_default5 = isInfinite;

var lib_default11 = main_default5;

var FLOAT64_HIGH_WORD_SIGN_MASK = 2147483648 >>> 0;
var lib_default12 = FLOAT64_HIGH_WORD_SIGN_MASK;

var FLOAT64_HIGH_WORD_ABS_MASK = 2147483647 >>> 0;
var lib_default13 = FLOAT64_HIGH_WORD_ABS_MASK;

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
var main_default6 = toWords2;

main_default6.assign = assign_default;
var lib_default14 = main_default6;

var HIGH3;
if (is_little_endian_default === true) {
  HIGH3 = 1;
} else {
  HIGH3 = 0;
}
var high_default = HIGH3;

var FLOAT64_VIEW2 = new Float64Array(1);
var UINT32_VIEW2 = new Uint32Array(FLOAT64_VIEW2.buffer);
function getHighWord(x) {
  FLOAT64_VIEW2[0] = x;
  return UINT32_VIEW2[high_default];
}
var main_default7 = getHighWord;

var lib_default15 = main_default7;

var indices2;
var HIGH4;
var LOW3;
if (is_little_endian_default === true) {
  HIGH4 = 1;
  LOW3 = 0;
} else {
  HIGH4 = 0;
  LOW3 = 1;
}
indices2 = {
  "HIGH": HIGH4,
  "LOW": LOW3
};
var indices_default2 = indices2;

var FLOAT64_VIEW3 = new Float64Array(1);
var UINT32_VIEW3 = new Uint32Array(FLOAT64_VIEW3.buffer);
var HIGH5 = indices_default2.HIGH;
var LOW4 = indices_default2.LOW;
function fromWords(high, low) {
  UINT32_VIEW3[HIGH5] = high;
  UINT32_VIEW3[LOW4] = low;
  return FLOAT64_VIEW3[0];
}
var main_default8 = fromWords;

var lib_default16 = main_default8;

var WORDS = [0, 0];
function copysign(x, y) {
  var hx;
  var hy;
  lib_default14.assign(x, WORDS, 1, 0);
  hx = WORDS[0];
  hx &= lib_default13;
  hy = lib_default15(y);
  hy &= lib_default12;
  hx |= hy;
  return lib_default16(hx, WORDS[1]);
}
var main_default9 = copysign;

var lib_default17 = main_default9;

var FLOAT64_HIGH_WORD_EXPONENT_MASK = 2146435072;
var lib_default18 = FLOAT64_HIGH_WORD_EXPONENT_MASK;

function exponent(x) {
  var high = lib_default15(x);
  high = (high & lib_default18) >>> 20;
  return high - lib_default7 | 0;
}
var main_default10 = exponent;

var lib_default19 = main_default10;

var FLOAT64_SMALLEST_NORMAL = 22250738585072014e-324;
var lib_default20 = FLOAT64_SMALLEST_NORMAL;

function abs(x) {
  return Math.abs(x);
}
var main_default11 = abs;

var lib_default21 = main_default11;

var SCALAR = 4503599627370496;
function normalize(x, out, stride, offset) {
  if (lib_default(x) || lib_default11(x)) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  if (x !== 0 && lib_default21(x) < lib_default20) {
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
var main_default12 = normalize2;

main_default12.assign = assign_default2;
var lib_default22 = main_default12;

var normalize3 = lib_default22.assign;
var TWO52_INV = 2220446049250313e-31;
var CLEAR_EXP_MASK = 2148532223 >>> 0;
var FRAC = [0, 0];
var WORDS2 = [0, 0];
function ldexp(frac, exp2) {
  var high;
  var m;
  if (exp2 === 0 || frac === 0 || // handles +-0
  lib_default(frac) || lib_default11(frac)) {
    return frac;
  }
  normalize3(frac, FRAC, 1, 0);
  frac = FRAC[0];
  exp2 += FRAC[1];
  exp2 += lib_default19(frac);
  if (exp2 < lib_default10) {
    return lib_default17(0, frac);
  }
  if (exp2 > lib_default8) {
    if (frac < 0) {
      return lib_default5;
    }
    return lib_default6;
  }
  if (exp2 <= lib_default9) {
    exp2 += 52;
    m = TWO52_INV;
  } else {
    m = 1;
  }
  lib_default14.assign(frac, WORDS2, 1, 0);
  high = WORDS2[0];
  high &= CLEAR_EXP_MASK;
  high |= exp2 + lib_default7 << 20;
  return m * lib_default16(high, WORDS2[1]);
}
var main_default13 = ldexp;

var lib_default23 = main_default13;

function evalpoly(x) {
  if (x === 0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6613756321437934e-20 + x * (-16533902205465252e-22 + x * 41381367970572385e-24)));
}
var polyval_p_default = evalpoly;

function expmulti(hi, lo, k) {
  var r;
  var t;
  var c;
  var y;
  r = hi - lo;
  t = r * r;
  c = r - t * polyval_p_default(t);
  y = 1 - (lo - r * c / (2 - c) - hi);
  return lib_default23(y, k);
}
var expmulti_default = expmulti;

var LN2_HI = 0.6931471803691238;
var LN2_LO = 19082149292705877e-26;
var LOG2_E = 1.4426950408889634;
var OVERFLOW = 709.782712893384;
var UNDERFLOW = -745.1332191019411;
var NEARZERO = 1 / (1 << 28);
var NEG_NEARZERO = -NEARZERO;
function exp(x) {
  var hi;
  var lo;
  var k;
  if (lib_default(x) || x === lib_default6) {
    return x;
  }
  if (x === lib_default5) {
    return 0;
  }
  if (x > OVERFLOW) {
    return lib_default6;
  }
  if (x < UNDERFLOW) {
    return 0;
  }
  if (x > NEG_NEARZERO && x < NEARZERO) {
    return 1 + x;
  }
  if (x < 0) {
    k = lib_default4(LOG2_E * x - 0.5);
  } else {
    k = lib_default4(LOG2_E * x + 0.5);
  }
  hi = x - k * LN2_HI;
  lo = k * LN2_LO;
  return expmulti_default(hi, lo, k);
}
var main_default14 = exp;

var lib_default24 = main_default14;

// ../../../../driver.js
var driver_default = lib_default24;

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
  const x = uniform(N_IN, -50, 50, 0x1234abcd)
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
