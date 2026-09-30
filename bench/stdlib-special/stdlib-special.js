// stdlib-special.js — every function of @stdlib/math/base/special (stdlib 0.4.1, Apache-2.0) that takes
// numbers and returns one, or a list of them: 339 packages, bundled from their CommonJS sources by
// scripts/stdlib-probe.mjs (`bench-all math/base/special stdlib-special`): the packages' own code with the
// module seams gone, nothing rewritten. Each function is swept over a domain where
// it is finite (the probe's `domain`: of reals, or of integers for a function of
// counts), the arguments after the first held; a list is stored as its sum.
// Copyright (c) The Stdlib Authors. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0); the notices of the bundled files
// are retained by reference to the package.
import { mix, medianUs, printResult } from '../_lib/benchlib.js'

function abs(x) {
  return Math.abs(x);
}
var main_default = abs;

var lib_default = main_default;

function abs2(x) {
  return x * x;
}
var main_default2 = abs2;

var lib_default2 = main_default2;

var fround = typeof Math.fround === "function" ? Math.fround : null;
var main_default3 = fround;

var FLOAT32_VIEW = new Float32Array(1);
function float64ToFloat32(x) {
  FLOAT32_VIEW[0] = x;
  return FLOAT32_VIEW[0];
}
var polyfill_default = float64ToFloat32;

var float64ToFloat322;
if (typeof main_default3 === "function") {
  float64ToFloat322 = main_default3;
} else {
  float64ToFloat322 = polyfill_default;
}
var lib_default3 = float64ToFloat322;

function abs2f(x) {
  return lib_default3(lib_default3(x) * lib_default3(x));
}
var main_default4 = abs2f;

var lib_default4 = main_default4;

function absf(x) {
  return Math.abs(x);
}
var main_default5 = absf;

var lib_default5 = main_default5;

function isnanf(x) {
  return x !== x;
}
var main_default6 = isnanf;

var lib_default6 = main_default6;

var FLOAT32_VIEW2 = new Float32Array(1);
var UINT32_VIEW = new Uint32Array(FLOAT32_VIEW2.buffer);
var v;
var FLOAT32_PINF = 2139095040;
UINT32_VIEW[0] = FLOAT32_PINF;
v = FLOAT32_VIEW2[0];
var lib_default7 = v;

var FLOAT32_VIEW3 = new Float32Array(1);
var UINT32_VIEW2 = new Uint32Array(FLOAT32_VIEW3.buffer);
var v2;
var FLOAT32_NINF = 4286578688;
UINT32_VIEW2[0] = FLOAT32_NINF;
v2 = FLOAT32_VIEW3[0];
var lib_default8 = v2;

function isInfinitef(x) {
  return x === lib_default7 || x === lib_default8;
}
var main_default7 = isInfinitef;

var lib_default9 = main_default7;

var FLOAT32_VIEW4 = new Float32Array(1);
var UINT32_VIEW3 = new Uint32Array(FLOAT32_VIEW4.buffer);
function toWordf(x) {
  FLOAT32_VIEW4[0] = x;
  return UINT32_VIEW3[0];
}
var main_default8 = toWordf;

var lib_default10 = main_default8;

var UINT32_VIEW4 = new Uint32Array(1);
var FLOAT32_VIEW5 = new Float32Array(UINT32_VIEW4.buffer);
function fromWordf(word) {
  UINT32_VIEW4[0] = word;
  return FLOAT32_VIEW5[0];
}
var main_default9 = fromWordf;

var lib_default11 = main_default9;

var FLOAT32_EXPONENT_MASK = 2139095040;
var lib_default12 = FLOAT32_EXPONENT_MASK;

var FLOAT32_EXPONENT_BIAS = 127 | 0;
var lib_default13 = FLOAT32_EXPONENT_BIAS;

var FLOAT32_SIGNIFICAND_MASK = 8388607;
var lib_default14 = FLOAT32_SIGNIFICAND_MASK;

function evalpoly(x) {
  if (x === 0) {
    return 0.40000972152;
  }
  return 0.40000972152 + x * 0.24279078841;
}
var polyval_p_default = evalpoly;

function evalpoly2(x) {
  if (x === 0) {
    return 0.66666662693;
  }
  return 0.66666662693 + x * 0.28498786688;
}
var polyval_q_default = evalpoly2;

var LN2_HI = 0.69313812256;
var LN2_LO = 90580006145e-16;
var TWO25 = 33554432;
var ONE_THIRD = 0.3333333333333333;
function lnf(x) {
  var hfsq;
  var ix;
  var t2;
  var t1;
  var k;
  var R;
  var f;
  var i;
  var j;
  var s;
  var w;
  var z;
  if (x === 0) {
    return lib_default8;
  }
  if (lib_default6(x) || x < 0) {
    return NaN;
  }
  x = lib_default3(x);
  ix = lib_default10(x);
  k = 0;
  if (ix < 8388608) {
    k -= 25;
    x = lib_default3(x * TWO25);
    ix = lib_default10(x);
  }
  if (ix >= lib_default12) {
    return lib_default3(x + x);
  }
  k = lib_default3(k + lib_default3((ix >> 23) - lib_default13));
  ix &= lib_default14;
  i = ix + (614244 << 3) & 8388608;
  x = lib_default11(ix | i ^ 1065353216);
  k = lib_default3(k + (i >> 23));
  f = lib_default3(x - 1);
  if ((lib_default14 & lib_default3(32768 + ix)) < 49152) {
    if (f === 0) {
      if (k === 0) {
        return 0;
      }
      return lib_default3(lib_default3(k * LN2_HI) + lib_default3(k * LN2_LO));
    }
    R = lib_default3(lib_default3(f * f) * lib_default3(0.5 - lib_default3(ONE_THIRD * f)));
    if (k === 0) {
      return lib_default3(f - R);
    }
    return lib_default3(lib_default3(k * LN2_HI) - lib_default3(lib_default3(R - lib_default3(k * LN2_LO)) - f));
  }
  s = lib_default3(f / lib_default3(2 + f));
  z = lib_default3(s * s);
  i = ix - (398458 << 3);
  w = lib_default3(z * z);
  j = (440401 << 3) - ix;
  t1 = lib_default3(w * lib_default3(polyval_p_default(w)));
  t2 = lib_default3(z * lib_default3(polyval_q_default(w)));
  i |= j;
  R = lib_default3(t2 + t1);
  if (i > 0) {
    hfsq = lib_default3(0.5 * lib_default3(f * f));
    if (k === 0) {
      return lib_default3(f - lib_default3(hfsq - lib_default3(s * lib_default3(hfsq + R))));
    }
    return lib_default3(lib_default3(k * LN2_HI) - lib_default3(lib_default3(hfsq - lib_default3(s * lib_default3(hfsq + R) + lib_default3(k * LN2_LO))) - f));
  }
  if (k === 0) {
    return lib_default3(f - lib_default3(s * lib_default3(f - R)));
  }
  return lib_default3(lib_default3(k * LN2_HI) - lib_default3(lib_default3(lib_default3(s * lib_default3(f - R)) - lib_default3(k * LN2_LO)) - f));
}
var main_default10 = lnf;

var lib_default15 = main_default10;

var floorf = Math.floor;
var main_default11 = floorf;

var lib_default16 = main_default11;

var ceilf = Math.ceil;
var main_default12 = ceilf;

var lib_default17 = main_default12;

function truncf(x) {
  if (x < 0) {
    return lib_default17(x);
  }
  return lib_default16(x);
}
var main_default13 = truncf;

var lib_default18 = main_default13;

function evalpoly3(x) {
  if (x === 0) {
    return -0.001388676377460993;
  }
  return -0.001388676377460993 + x * 2439044879627741e-20;
}
var polyval_c23_default = evalpoly3;

var C0 = -0.499999997251031;
var C1 = 0.04166662332373906;
function kernelCosf(x) {
  var r;
  var w;
  var z;
  z = x * x;
  w = z * z;
  r = polyval_c23_default(z);
  return lib_default3(1 + z * C0 + w * C1 + w * z * r);
}
var main_default14 = kernelCosf;

var lib_default19 = main_default14;

function evalpoly4(x) {
  if (x === 0) {
    return -0.16666666641626524;
  }
  return -0.16666666641626524 + x * 0.008333329385889463;
}
var polyval_s12_default = evalpoly4;

function evalpoly5(x) {
  if (x === 0) {
    return -19839334836096632e-20;
  }
  return -19839334836096632e-20 + x * 2718311493989822e-21;
}
var polyval_s34_default = evalpoly5;

function kernelSinf(x) {
  var r;
  var s;
  var w;
  var z;
  z = x * x;
  w = z * z;
  r = polyval_s34_default(z);
  s = z * x;
  return lib_default3(x + s * polyval_s12_default(z) + s * w * r);
}
var main_default15 = kernelSinf;

var lib_default20 = main_default15;

var FLOAT32_SIGN_MASK = 2147483648 >>> 0;
var lib_default21 = FLOAT32_SIGN_MASK;

var FLOAT32_ABS_MASK = 2147483647 >>> 0;
var lib_default22 = FLOAT32_ABS_MASK;

function copysignf(x, y) {
  var wx;
  var wy;
  x = lib_default3(x);
  y = lib_default3(y);
  wx = lib_default10(x);
  wx &= lib_default22;
  wy = lib_default10(y);
  wy &= lib_default21;
  wx |= wy;
  return lib_default11(wx);
}
var main_default16 = copysignf;

var lib_default23 = main_default16;

function float32ToUint32(x) {
  return x >>> 0;
}
var main_default17 = float32ToUint32;

var lib_default24 = main_default17;

var FLOAT32_NUM_SIGNIFICAND_BITS = 23 | 0;
var lib_default25 = FLOAT32_NUM_SIGNIFICAND_BITS;

var PI = 3.141592653589793;
var lib_default26 = PI;

var ONE_WORD = 1065353216 >>> 0;
var HALF_WORD = 1056964608 >>> 0;
var QUARTER_WORD = 1048576e3 >>> 0;
var THREE_QUARTER_WORD = 1061158912 >>> 0;
var SMALL_WORD = 947912704 >>> 0;
var LARGE_WORD = 1258291200 >>> 0;
var PI_HIGH = lib_default3(3.14160156);
var PI_LOW = lib_default3(-890890988e-14);
var HIGH_16_MASK = 4294901760 >>> 0;
var FLOAT32_EXPONENT_FIELD_MASK = 255 >>> 0;
var TWO_23 = lib_default3(8388608);
var TWO_N23 = lib_default3(11920928955078125e-23);
var ZERO = lib_default3(0);
var HALF = lib_default3(0.5);
var ONE = lib_default3(1);
function sinpif(x) {
  var hx;
  var ix;
  var hi;
  var lo;
  var j02;
  var ax;
  var s;
  x = lib_default3(x);
  hx = lib_default10(lib_default3(x));
  ix = (hx & lib_default22) >>> 0;
  ax = lib_default11(ix);
  if (ix < ONE_WORD) {
    if (ix < QUARTER_WORD) {
      if (ix < SMALL_WORD) {
        if (x === 0) {
          return x;
        }
        hi = lib_default11(hx & HIGH_16_MASK);
        hi = lib_default3(hi * TWO_23);
        lo = lib_default3(lib_default3(x * TWO_23) - hi);
        s = lib_default3(lib_default3(lib_default3(PI_LOW + PI_HIGH) * lo) + lib_default3(PI_LOW * hi) + lib_default3(PI_HIGH * hi));
        return lib_default3(s * TWO_N23);
      }
      s = lib_default20(lib_default26 * ax);
      return hx & lib_default21 ? -s : s;
    }
    if (ix < HALF_WORD) {
      s = lib_default19(lib_default26 * lib_default3(HALF - ax));
    } else if (ix < THREE_QUARTER_WORD) {
      s = lib_default19(lib_default26 * lib_default3(ax - HALF));
    } else {
      s = lib_default20(lib_default26 * lib_default3(ONE - ax));
    }
    return hx & lib_default21 ? -s : s;
  }
  if (ix < LARGE_WORD) {
    j02 = (ix >> lib_default25 & FLOAT32_EXPONENT_FIELD_MASK) - lib_default13;
    ix &= ~(lib_default14 >> j02);
    x = lib_default11(ix);
    ax = lib_default3(ax - x);
    ix = lib_default10(ax);
    if (ix === 0) {
      s = ZERO;
    } else {
      if (ix < HALF_WORD) {
        if (ix < QUARTER_WORD) {
          s = lib_default20(lib_default26 * ax);
        } else {
          s = lib_default19(lib_default26 * lib_default3(HALF - ax));
        }
      } else if (ix < THREE_QUARTER_WORD) {
        s = lib_default19(lib_default26 * lib_default3(ax - HALF));
      } else {
        s = lib_default20(lib_default26 * lib_default3(ONE - ax));
      }
      j02 = lib_default24(x);
      s = j02 & 1 ? -s : s;
    }
    return hx & lib_default21 ? -s : s;
  }
  if (ix >= lib_default12) {
    return NaN;
  }
  return lib_default23(ZERO, x);
}
var main_default18 = sinpif;

var lib_default27 = main_default18;

var FLOAT32_PI = lib_default3(3.141592653589793);
var lib_default28 = FLOAT32_PI;

function evalpoly6(x) {
  if (x === 0) {
    return 0.07721566408872604;
  }
  return lib_default3(0.07721566408872604 + lib_default3(x * lib_default3(0.06734848022460938 + lib_default3(x * 0.006982756312936544))));
}
var polyval_a0_default = evalpoly6;

function evalpoly7(x) {
  if (x === 0) {
    return 0.3224671185016632;
  }
  return lib_default3(0.3224671185016632 + lib_default3(x * lib_default3(0.020639566704630852 + lib_default3(x * 0.004117684438824654))));
}
var polyval_a1_default = evalpoly7;

function evalpoly8(x) {
  if (x === 0) {
    return 0.679650068283081;
  }
  return lib_default3(0.679650068283081 + lib_default3(x * lib_default3(0.11605872958898544 + lib_default3(x * 0.003756736870855093))));
}
var polyval_r_default = evalpoly8;

function evalpoly9(x) {
  if (x === 0) {
    return -0.07721566408872604;
  }
  return lib_default3(-0.07721566408872604 + lib_default3(x * lib_default3(0.26998740434646606 + lib_default3(x * lib_default3(0.14285100996494293 + lib_default3(x * 0.011938951909542084))))));
}
var polyval_s_default = evalpoly9;

function evalpoly10(x) {
  if (x === 0) {
    return 0.48383641242980957;
  }
  return lib_default3(0.48383641242980957 + lib_default3(x * lib_default3(-0.14758621156215668 + lib_default3(x * lib_default3(0.06460130959749222 + lib_default3(x * lib_default3(-0.03284503519535065 + lib_default3(x * lib_default3(0.01864837482571602 + lib_default3(x * -0.009892062284052372))))))))));
}
var polyval_t2_default = evalpoly10;

function evalpoly11(x) {
  if (x === 0) {
    return -0.07721566408872604;
  }
  return lib_default3(-0.07721566408872604 + lib_default3(x * lib_default3(0.7367897033691406 + lib_default3(x * 0.4956490397453308))));
}
var polyval_u_default = evalpoly11;

function evalpoly12(x) {
  if (x === 0) {
    return 1.1095842123031616;
  }
  return lib_default3(1.1095842123031616 + lib_default3(x * lib_default3(0.21059811115264893 + lib_default3(x * -0.01029954943805933))));
}
var polyval_v_default = evalpoly12;

function evalpoly13(x) {
  if (x === 0) {
    return 0.08333324640989304;
  }
  return lib_default3(0.08333324640989304 + lib_default3(x * -0.0027612908743321896));
}
var polyval_w_default = evalpoly13;

var ZERO2 = lib_default3(0);
var HALF2 = lib_default3(0.5);
var ONE2 = lib_default3(1);
var TWO = lib_default3(2);
var THREE = lib_default3(3);
var FOUR = lib_default3(4);
var FIVE = lib_default3(5);
var SIX = lib_default3(6);
var EIGHT = lib_default3(8);
var T0C = lib_default3(-29406446e-18);
var T1C = lib_default3(-235939837e-16);
var W0C = lib_default3(0.418938547);
var TWO23 = lib_default3(8388608);
var TWO27 = lib_default3(134217728);
var TINY = lib_default3(7450580596923828e-24);
var YMIN = lib_default3(1.46163213);
var TF = lib_default3(-0.121486291);
function absgammalnf(x) {
  var isNegative;
  var nadj;
  var flg;
  var p210;
  var p110;
  var p101;
  var q;
  var t;
  var w;
  var y;
  var z;
  var r;
  x = lib_default3(x);
  if (lib_default6(x) || lib_default9(x)) {
    return x;
  }
  if (x === ZERO2) {
    return lib_default7;
  }
  if (x < ZERO2) {
    isNegative = true;
    x = lib_default3(-x);
  } else {
    isNegative = false;
  }
  if (x < TINY) {
    return -lib_default15(x);
  }
  if (isNegative) {
    if (x >= TWO23) {
      return lib_default7;
    }
    t = lib_default27(x);
    if (t === ZERO2) {
      return lib_default7;
    }
    nadj = lib_default15(lib_default3(lib_default28 / lib_default5(lib_default3(t * x))));
  }
  if (x === ONE2 || x === TWO) {
    return ZERO2;
  }
  if (x < TWO) {
    if (x <= lib_default3(0.9)) {
      r = -lib_default15(x);
      if (x >= lib_default3(lib_default3(YMIN - ONE2) + lib_default3(0.27))) {
        y = lib_default3(ONE2 - x);
        flg = 0;
      } else if (x >= lib_default3(lib_default3(YMIN - ONE2) - lib_default3(0.23))) {
        y = lib_default3(x - lib_default3(YMIN - ONE2));
        flg = 1;
      } else {
        y = x;
        flg = 2;
      }
    } else {
      r = ZERO2;
      if (x >= lib_default3(YMIN + lib_default3(0.27))) {
        y = lib_default3(TWO - x);
        flg = 0;
      } else if (x >= lib_default3(YMIN - lib_default3(0.23))) {
        y = lib_default3(x - YMIN);
        flg = 1;
      } else {
        y = lib_default3(x - ONE2);
        flg = 2;
      }
    }
    switch (flg) {
      // eslint-disable-line default-case
      case 0:
        z = lib_default3(y * y);
        p110 = polyval_a0_default(z);
        p210 = lib_default3(z * polyval_a1_default(z));
        p101 = lib_default3(lib_default3(y * p110) + p210);
        r = lib_default3(r + lib_default3(p101 - lib_default3(HALF2 * y)));
        break;
      case 1:
        z = lib_default3(y * y);
        p101 = lib_default3(lib_default3(T0C + lib_default3(y * T1C)) + lib_default3(z * polyval_t2_default(y)));
        r = lib_default3(r + lib_default3(TF + p101));
        break;
      case 2:
        p110 = lib_default3(y * polyval_u_default(y));
        p210 = lib_default3(ONE2 + lib_default3(y * polyval_v_default(y)));
        r = lib_default3(r + lib_default3(lib_default3(p110 / p210) - lib_default3(HALF2 * y)));
        break;
    }
  } else if (x < EIGHT) {
    flg = lib_default18(x);
    y = lib_default3(x - flg);
    p101 = lib_default3(y * polyval_s_default(y));
    q = lib_default3(ONE2 + lib_default3(y * polyval_r_default(y)));
    r = lib_default3(lib_default3(HALF2 * y) + lib_default3(p101 / q));
    z = ONE2;
    switch (flg) {
      // eslint-disable-line default-case
      case 7:
        z = lib_default3(z * lib_default3(y + SIX));
      case 6:
        z = lib_default3(z * lib_default3(y + FIVE));
      case 5:
        z = lib_default3(z * lib_default3(y + FOUR));
      case 4:
        z = lib_default3(z * lib_default3(y + THREE));
      case 3:
        z = lib_default3(z * lib_default3(y + TWO));
        r = lib_default3(r + lib_default15(z));
    }
  } else if (x < TWO27) {
    t = lib_default15(x);
    z = lib_default3(ONE2 / x);
    y = lib_default3(z * z);
    w = lib_default3(W0C + lib_default3(z * polyval_w_default(y)));
    r = lib_default3(lib_default3(lib_default3(x - HALF2) * lib_default3(t - ONE2)) + w);
  } else {
    r = lib_default3(x * lib_default3(lib_default15(x) - ONE2));
  }
  if (isNegative) {
    r = lib_default3(nadj - r);
  }
  return r;
}
var main_default19 = absgammalnf;

var lib_default29 = main_default19;

function isnan(x) {
  return x !== x;
}
var main_default20 = isnan;

var lib_default30 = main_default20;

var sqrt = Math.sqrt;
var main_default21 = sqrt;

var lib_default31 = main_default21;

var FOURTH_PI = 0.7853981633974483;
var lib_default32 = FOURTH_PI;

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
  if (lib_default30(x)) {
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
    zz = lib_default31(zz + zz);
    z = lib_default32 - zz;
    zz = zz * p101 - MOREBITS;
    z -= zz;
    z += lib_default32;
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
var main_default22 = asin;

var lib_default33 = main_default22;

var MOREBITS2 = 6123233995736766e-32;
function acos(x) {
  var z;
  if (lib_default30(x)) {
    return NaN;
  }
  if (x < -1 || x > 1) {
    return NaN;
  }
  if (x > 0.5) {
    return 2 * lib_default33(lib_default31(0.5 - 0.5 * x));
  }
  z = lib_default32 - lib_default33(x);
  z += MOREBITS2;
  z += lib_default32;
  return z;
}
var main_default23 = acos;

var lib_default34 = main_default23;

var CONST_180_DIV_PI = 57.29577951308232;
function rad2deg(x) {
  return x * CONST_180_DIV_PI;
}
var main_default24 = rad2deg;

var lib_default35 = main_default24;

function acosd(x) {
  var rad = lib_default34(x);
  return lib_default35(rad);
}
var main_default25 = acosd;

var lib_default36 = main_default25;

var CONST_180_DIV_PI2 = lib_default3(57.29577951308232);
function rad2degf(x) {
  return lib_default3(lib_default3(x) * CONST_180_DIV_PI2);
}
var main_default26 = rad2degf;

var lib_default37 = main_default26;

function sqrtf(x) {
  return lib_default3(lib_default31(lib_default3(x)));
}
var main_default27 = sqrtf;

var lib_default38 = main_default27;

function evalpoly14(x) {
  if (x === 0) {
    return 0.16666586697101593;
  }
  return lib_default3(0.16666586697101593 + lib_default3(x * lib_default3(-0.04274342209100723 + lib_default3(x * -0.008656363002955914))));
}
var poly_p_default = evalpoly14;

var ALMOST_PI = 3.1415925026;
var PIO2_HI = 1.5707962513;
var PIO2_LO = 75497894159e-18;
var MASK_LO = 4294963200 | 0;
var SMALL = 14901161193847656e-24;
var QS1 = -0.7066296339;
var PIO2 = lib_default3(PIO2_HI + PIO2_LO);
function acosf(x) {
  var idf;
  var df;
  var ax;
  var z;
  var p101;
  var q;
  var r;
  var s;
  var c2;
  var w;
  if (lib_default6(x)) {
    return NaN;
  }
  x = lib_default3(x);
  if (x < -1 || x > 1) {
    return NaN;
  }
  if (x === 1) {
    return 0;
  }
  if (x === -1) {
    return lib_default28;
  }
  ax = lib_default5(x);
  if (ax < 0.5) {
    if (ax <= SMALL) {
      return PIO2;
    }
    z = lib_default3(x * x);
    p101 = lib_default3(z * poly_p_default(z));
    q = lib_default3(1 + lib_default3(z * QS1));
    r = lib_default3(p101 / q);
    return lib_default3(PIO2_HI - lib_default3(x - lib_default3(PIO2_LO - lib_default3(x * r))));
  }
  if (x < -0.5) {
    z = lib_default3(0.5 * lib_default3(1 + x));
    p101 = lib_default3(z * poly_p_default(z));
    q = lib_default3(1 + lib_default3(z * QS1));
    s = lib_default38(z);
    r = lib_default3(p101 / q);
    w = lib_default3(lib_default3(r * s) - PIO2_LO);
    return lib_default3(ALMOST_PI - lib_default3(2 * lib_default3(s + w)));
  }
  z = lib_default3(0.5 * lib_default3(1 - x));
  s = lib_default38(z);
  idf = lib_default10(s);
  df = lib_default11(idf & MASK_LO);
  c2 = lib_default3(lib_default3(z - lib_default3(df * df)) / lib_default3(s + df));
  p101 = lib_default3(z * poly_p_default(z));
  q = lib_default3(1 + lib_default3(z * QS1));
  r = lib_default3(p101 / q);
  w = lib_default3(lib_default3(r * s) + c2);
  return lib_default3(2 * lib_default3(df + w));
}
var main_default28 = acosf;

var lib_default39 = main_default28;

function acosdf(x) {
  return lib_default37(lib_default39(x));
}
var main_default29 = acosdf;

var lib_default40 = main_default29;

var is_little_endian_default = true;

var HIGH;
if (is_little_endian_default === true) {
  HIGH = 1;
} else {
  HIGH = 0;
}
var high_default = HIGH;

var FLOAT64_VIEW = new Float64Array(1);
var UINT32_VIEW5 = new Uint32Array(FLOAT64_VIEW.buffer);
function getHighWord(x) {
  FLOAT64_VIEW[0] = x;
  return UINT32_VIEW5[high_default];
}
var main_default30 = getHighWord;

var lib_default41 = main_default30;

var HIGH2;
if (is_little_endian_default === true) {
  HIGH2 = 1;
} else {
  HIGH2 = 0;
}
var high_default2 = HIGH2;

var FLOAT64_VIEW2 = new Float64Array(1);
var UINT32_VIEW6 = new Uint32Array(FLOAT64_VIEW2.buffer);
function setHighWord(x, high) {
  FLOAT64_VIEW2[0] = x;
  UINT32_VIEW6[high_default2] = high >>> 0;
  return FLOAT64_VIEW2[0];
}
var main_default31 = setHighWord;

var lib_default42 = main_default31;

var FLOAT64_PINF = Number.POSITIVE_INFINITY;
var lib_default43 = FLOAT64_PINF;

var FLOAT64_NINF = Number.NEGATIVE_INFINITY;
var lib_default44 = FLOAT64_NINF;

var FLOAT64_EXPONENT_BIAS = 1023 | 0;
var lib_default45 = FLOAT64_EXPONENT_BIAS;

function evalpoly15(x) {
  if (x === 0) {
    return 0.6666666666666735;
  }
  return 0.6666666666666735 + x * (0.3999999999940942 + x * (0.2857142874366239 + x * (0.22222198432149784 + x * (0.1818357216161805 + x * (0.15313837699209373 + x * 0.14798198605116586)))));
}
var polyval_lp_default = evalpoly15;

var LN2_HI2 = 0.6931471803691238;
var LN2_LO2 = 19082149292705877e-26;
var SQRT2M1 = 0.41421356237309503;
var SQRT2HALFM1 = -0.2928932188134525;
var SMALL2 = 1862645149230957e-24;
var TINY2 = 5551115123125783e-32;
var TWO53 = 9007199254740992;
var TWO_THIRDS = 0.6666666666666666;
function log1p(x) {
  var hfsq;
  var hu;
  var y;
  var f;
  var c2;
  var s;
  var z;
  var R;
  var u;
  var k;
  if (x < -1 || lib_default30(x)) {
    return NaN;
  }
  if (x === -1) {
    return lib_default44;
  }
  if (x === lib_default43) {
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
    if (y < SMALL2) {
      if (y < TINY2) {
        return x;
      }
      return x - x * x * 0.5;
    }
    if (x > SQRT2HALFM1) {
      k = 0;
      f = x;
      hu = 1;
    }
  }
  if (k !== 0) {
    if (y < TWO53) {
      u = 1 + x;
      hu = lib_default41(u);
      k = (hu >> 20) - lib_default45;
      if (k > 0) {
        c2 = 1 - (u - x);
      } else {
        c2 = x - (u - 1);
      }
      c2 /= u;
    } else {
      u = x;
      hu = lib_default41(u);
      k = (hu >> 20) - lib_default45;
      c2 = 0;
    }
    hu &= 1048575;
    if (hu < 434334) {
      u = lib_default42(u, hu | 1072693248);
    } else {
      k += 1;
      u = lib_default42(u, hu | 1071644672);
      hu = 1048576 - hu >> 2;
    }
    f = u - 1;
  }
  hfsq = 0.5 * f * f;
  if (hu === 0) {
    if (f === 0) {
      c2 += k * LN2_LO2;
      return k * LN2_HI2 + c2;
    }
    R = hfsq * (1 - TWO_THIRDS * f);
    return k * LN2_HI2 - (R - (k * LN2_LO2 + c2) - f);
  }
  s = f / (2 + f);
  z = s * s;
  R = z * polyval_lp_default(z);
  if (k === 0) {
    return f - (hfsq - s * (hfsq + R));
  }
  return k * LN2_HI2 - (hfsq - (s * (hfsq + R) + (k * LN2_LO2 + c2)) - f);
}
var main_default32 = log1p;

var lib_default46 = main_default32;

var LN2 = 0.6931471805599453;
var lib_default47 = LN2;

function evalpoly16(x) {
  if (x === 0) {
    return 0.3999999999940942;
  }
  return 0.3999999999940942 + x * (0.22222198432149784 + x * 0.15313837699209373);
}
var polyval_p_default2 = evalpoly16;

function evalpoly17(x) {
  if (x === 0) {
    return 0.6666666666666735;
  }
  return 0.6666666666666735 + x * (0.2857142874366239 + x * (0.1818357216161805 + x * 0.14798198605116586));
}
var polyval_q_default2 = evalpoly17;

var LN2_HI3 = 0.6931471803691238;
var LN2_LO3 = 19082149292705877e-26;
var TWO54 = 18014398509481984;
var ONE_THIRD2 = 0.3333333333333333;
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
  var f;
  var i;
  var j;
  var s;
  var w;
  var z;
  if (x === 0) {
    return lib_default44;
  }
  if (lib_default30(x) || x < 0) {
    return NaN;
  }
  hx = lib_default41(x);
  k = 0 | 0;
  if (hx < HIGH_MIN_NORMAL_EXP) {
    k -= 54 | 0;
    x *= TWO54;
    hx = lib_default41(x);
  }
  if (hx >= HIGH_MAX_NORMAL_EXP) {
    return x + x;
  }
  k += (hx >> 20) - lib_default45 | 0;
  hx &= HIGH_SIGNIFICAND_MASK;
  i = hx + 614244 & 1048576 | 0;
  x = lib_default42(x, hx | i ^ HIGH_BIASED_EXP_0);
  k += i >> 20 | 0;
  f = x - 1;
  if ((HIGH_SIGNIFICAND_MASK & 2 + hx) < 3) {
    if (f === 0) {
      if (k === 0) {
        return 0;
      }
      return k * LN2_HI3 + k * LN2_LO3;
    }
    R = f * f * (0.5 - ONE_THIRD2 * f);
    if (k === 0) {
      return f - R;
    }
    return k * LN2_HI3 - (R - k * LN2_LO3 - f);
  }
  s = f / (2 + f);
  z = s * s;
  i = hx - 398458 | 0;
  w = z * z;
  j = 440401 - hx | 0;
  t1 = w * polyval_p_default2(w);
  t2 = z * polyval_q_default2(w);
  i |= j;
  R = t2 + t1;
  if (i > 0) {
    hfsq = 0.5 * f * f;
    if (k === 0) {
      return f - (hfsq - s * (hfsq + R));
    }
    return k * LN2_HI3 - (hfsq - (s * (hfsq + R) + k * LN2_LO3) - f);
  }
  if (k === 0) {
    return f - s * (f - R);
  }
  return k * LN2_HI3 - (s * (f - R) - k * LN2_LO3 - f);
}
var main_default33 = ln;

var lib_default48 = main_default33;

var HUGE = 1 << 28;
function acosh(x) {
  var t;
  if (lib_default30(x) || x < 1) {
    return NaN;
  }
  if (x === 1) {
    return 0;
  }
  if (x >= HUGE) {
    return lib_default48(x) + lib_default47;
  }
  if (x > 2) {
    return lib_default48(2 * x - 1 / (x + lib_default31(x * x - 1)));
  }
  t = x - 1;
  return lib_default46(t + lib_default31(2 * t + t * t));
}
var main_default34 = acosh;

var lib_default49 = main_default34;

var FLOAT32_PRECISION = 24 | 0;
var lib_default50 = FLOAT32_PRECISION;

function evalpoly18(x) {
  if (x === 0) {
    return 0.6666666865348816;
  }
  return lib_default3(0.6666666865348816 + lib_default3(x * lib_default3(0.4000000059604645 + lib_default3(x * lib_default3(0.2857142984867096 + lib_default3(x * lib_default3(0.2222219854593277 + lib_default3(x * lib_default3(0.18183572590351105 + lib_default3(x * lib_default3(0.15313838422298431 + lib_default3(x * 0.14798198640346527))))))))))));
}
var polyval_lp_default2 = evalpoly18;

var LN2_HI4 = lib_default3(0.69313812256);
var LN2_LO4 = lib_default3(90580006145e-16);
var TWO252 = lib_default3(33554432);
var TWO_THIRDS2 = lib_default3(0.6666666666666666);
var TWO532 = 1509949440 | 0;
var TWO_NEG_15 = 939524096 | 0;
var TWO_NEG_24 = 864026624 | 0;
var ONE_WORD2 = 1065353216 | 0;
var HALF_WORD2 = 1056964608 | 0;
var SQRT2M12 = 1054086096 | 0;
var SQRT2HALFM12 = 3197498905 | 0;
var TINY3 = 8388608 | 0;
var NEG_ONE = lib_default3(-1);
var ZERO3 = lib_default3(0);
var HALF3 = lib_default3(0.5);
var ONE3 = lib_default3(1);
var TWO2 = lib_default3(2);
function log1pf(x) {
  var hfsq;
  var hx;
  var ax;
  var hu;
  var f;
  var c2;
  var s;
  var z;
  var R;
  var u;
  var k;
  x = lib_default3(x);
  hx = lib_default10(x) | 0;
  ax = hx & lib_default22 | 0;
  k = 1;
  if (hx < SQRT2M12) {
    if (ax >= ONE_WORD2) {
      if (x === NEG_ONE) {
        return lib_default8;
      }
      return NaN;
    }
    if (ax < TWO_NEG_15) {
      if (lib_default3(TWO252 + x) > ZERO3 && ax < TWO_NEG_24) {
        return x;
      }
      return lib_default3(x - lib_default3(x * lib_default3(x * HALF3)));
    }
    if (hx > 0 || hx <= SQRT2HALFM12) {
      k = 0;
      f = x;
      hu = 1;
    }
  }
  if (hx >= lib_default12) {
    return lib_default3(x + x);
  }
  if (k !== 0) {
    if (hx < TWO532) {
      u = lib_default3(ONE3 + x);
      hu = lib_default10(u) | 0;
      k = (hu >> lib_default50 - 1) - lib_default13;
      c2 = k > 0 ? lib_default3(ONE3 - lib_default3(u - x)) : lib_default3(x - lib_default3(u - ONE3));
      c2 = lib_default3(c2 / u);
    } else {
      u = x;
      hu = lib_default10(u) | 0;
      k = (hu >> lib_default50 - 1) - lib_default13;
      c2 = 0;
    }
    hu &= lib_default14;
    if (hu < 3474676) {
      u = lib_default11(hu | ONE_WORD2);
    } else {
      k += 1;
      u = lib_default11(hu | HALF_WORD2);
      hu = TINY3 - hu >> 2;
    }
    f = lib_default3(u - ONE3);
  }
  hfsq = lib_default3(HALF3 * lib_default3(f * f));
  if (hu === 0) {
    if (f === ZERO3) {
      if (k === 0) {
        return ZERO3;
      }
      c2 = lib_default3(c2 + lib_default3(k * LN2_LO4));
      return lib_default3(lib_default3(k * LN2_HI4) + c2);
    }
    R = lib_default3(hfsq * lib_default3(ONE3 - lib_default3(TWO_THIRDS2 * f)));
    if (k === 0) {
      return lib_default3(f - R);
    }
    return lib_default3(lib_default3(k * LN2_HI4) - lib_default3(lib_default3(R - lib_default3(lib_default3(k * LN2_LO4) + c2)) - f));
  }
  s = lib_default3(f / lib_default3(TWO2 + f));
  z = lib_default3(s * s);
  R = lib_default3(z * polyval_lp_default2(z));
  if (k === 0) {
    return lib_default3(f - lib_default3(hfsq - lib_default3(s * lib_default3(hfsq + R))));
  }
  return lib_default3(lib_default3(k * LN2_HI4) - lib_default3(lib_default3(hfsq - lib_default3(lib_default3(s * lib_default3(hfsq + R)) + lib_default3(lib_default3(k * LN2_LO4) + c2))) - f));
}
var main_default35 = log1pf;

var lib_default51 = main_default35;

var FLOAT32_LN2 = 0.6931471824645996;
var lib_default52 = FLOAT32_LN2;

var HUGE2 = lib_default3(1 << 28);
var ZERO4 = lib_default3(0);
var ONE4 = lib_default3(1);
var TWO3 = lib_default3(2);
function acoshf(x) {
  var t;
  var s;
  x = lib_default3(x);
  if (lib_default6(x) || x < ONE4) {
    return NaN;
  }
  if (x === ONE4) {
    return ZERO4;
  }
  if (x >= HUGE2) {
    return lib_default3(lib_default15(x) + lib_default52);
  }
  if (x > TWO3) {
    t = lib_default3(x * x);
    s = lib_default3(t - ONE4);
    return lib_default15(lib_default3(lib_default3(TWO3 * x) - lib_default3(ONE4 / lib_default3(x + lib_default38(s)))));
  }
  t = lib_default3(x - ONE4);
  return lib_default51(lib_default3(t + lib_default38(lib_default3(lib_default3(TWO3 * t) + lib_default3(t * t)))));
}
var main_default36 = acoshf;

var lib_default53 = main_default36;

var HALF_PI = 1.5707963267948966;
var lib_default54 = HALF_PI;

function evalpoly19(x) {
  if (x === 0) {
    return -64.85021904942025;
  }
  return -64.85021904942025 + x * (-122.88666844901361 + x * (-75.00855792314705 + x * (-16.157537187333652 + x * -0.8750608600031904)));
}
var polyval_p_default3 = evalpoly19;

function evalpoly20(x) {
  if (x === 0) {
    return 194.5506571482614;
  }
  return 194.5506571482614 + x * (485.3903996359137 + x * (432.88106049129027 + x * (165.02700983169885 + x * (24.858464901423062 + x * 1))));
}
var polyval_q_default3 = evalpoly20;

var MOREBITS3 = 6123233995736766e-32;
var T3P8 = 2.414213562373095;
function atan(x) {
  var flg;
  var sgn;
  var y;
  var z;
  if (lib_default30(x) || x === 0) {
    return x;
  }
  if (x === lib_default43) {
    return lib_default54;
  }
  if (x === lib_default44) {
    return -lib_default54;
  }
  if (x < 0) {
    sgn = true;
    x = -x;
  }
  flg = 0;
  if (x > T3P8) {
    y = lib_default54;
    flg = 1;
    x = -(1 / x);
  } else if (x <= 0.66) {
    y = 0;
  } else {
    y = lib_default32;
    flg = 2;
    x = (x - 1) / (x + 1);
  }
  z = x * x;
  z = z * polyval_p_default3(z) / polyval_q_default3(z);
  z = x * z + x;
  if (flg === 2) {
    z += 0.5 * MOREBITS3;
  } else if (flg === 1) {
    z += MOREBITS3;
  }
  y += z;
  return sgn ? -y : y;
}
var main_default37 = atan;

var lib_default55 = main_default37;

function acot(x) {
  return lib_default55(1 / x);
}
var main_default38 = acot;

var lib_default56 = main_default38;

function acotd(x) {
  var rad = lib_default56(x);
  return lib_default35(rad);
}
var main_default39 = acotd;

var lib_default57 = main_default39;

var FLOAT32_HALF_PI = lib_default3(1.5707963267948966);
var lib_default58 = FLOAT32_HALF_PI;

var FLOAT32_FOURTH_PI = lib_default3(0.7853981633974483);
var lib_default59 = FLOAT32_FOURTH_PI;

function evalpoly21(x) {
  if (x === 0) {
    return -0.3333294987678528;
  }
  return lib_default3(-0.3333294987678528 + lib_default3(x * lib_default3(0.19977711141109467 + lib_default3(x * lib_default3(-0.13877685368061066 + lib_default3(x * 0.08053744584321976))))));
}
var poly_p_default2 = evalpoly21;

function atanf(x) {
  var sgn;
  var y;
  var z;
  if (lib_default6(x) || x === 0) {
    return x;
  }
  x = lib_default3(x);
  if (x < 0) {
    sgn = -1;
    x = -x;
  } else {
    sgn = 1;
  }
  if (x > 2.414213562373095) {
    y = lib_default58;
    x = -lib_default3(1 / x);
  } else if (x > 0.414213562373095) {
    y = lib_default59;
    x = lib_default3(lib_default3(x - 1) / lib_default3(x + 1));
  } else {
    y = 0;
  }
  z = lib_default3(x * x);
  y = lib_default3(y + lib_default3(lib_default3(poly_p_default2(z)) * lib_default3(z * x) + x));
  if (sgn < 0) {
    y = -y;
  }
  return y;
}
var main_default40 = atanf;

var lib_default60 = main_default40;

function acotf(x) {
  return lib_default60(lib_default3(1 / lib_default3(x)));
}
var main_default41 = acotf;

var lib_default61 = main_default41;

function acotdf(x) {
  return lib_default37(lib_default61(lib_default3(x)));
}
var main_default42 = acotdf;

var lib_default62 = main_default42;

var NEAR_ZERO = 1 / (1 << 28);
function atanh(x) {
  var sgn;
  var t;
  if (lib_default30(x) || x < -1 || x > 1) {
    return NaN;
  }
  if (x === 1) {
    return lib_default43;
  }
  if (x === -1) {
    return lib_default44;
  }
  if (x < 0) {
    sgn = true;
    x = -x;
  }
  if (x < NEAR_ZERO) {
    return sgn ? -x : x;
  }
  if (x < 0.5) {
    t = x + x;
    t = 0.5 * lib_default46(t + t * x / (1 - x));
  } else {
    t = 0.5 * lib_default46((x + x) / (1 - x));
  }
  return sgn ? -t : t;
}
var main_default43 = atanh;

var lib_default63 = main_default43;

function acoth(x) {
  return lib_default63(1 / x);
}
var main_default44 = acoth;

var lib_default64 = main_default44;

var ZERO5 = lib_default3(0);
var ONE5 = lib_default3(1);
var HALF4 = lib_default3(0.5);
var NEG_ONE2 = lib_default3(-1);
var NEAR_ZERO2 = lib_default3(lib_default3(1) / (1 << 28));
function atanhf(x) {
  var sgn;
  var t;
  x = lib_default3(x);
  if (lib_default6(x) || x < NEG_ONE2 || x > ONE5) {
    return NaN;
  }
  if (x === ONE5) {
    return lib_default7;
  }
  if (x === NEG_ONE2) {
    return lib_default8;
  }
  if (x < ZERO5) {
    sgn = true;
    x = lib_default3(-x);
  }
  if (x < NEAR_ZERO2) {
    return sgn ? lib_default3(-x) : x;
  }
  if (x < HALF4) {
    t = lib_default3(x + x);
    t = lib_default3(HALF4 * lib_default51(lib_default3(t + lib_default3(t * lib_default3(x / lib_default3(ONE5 - x))))));
  } else {
    t = lib_default3(HALF4 * lib_default51(lib_default3(lib_default3(x + x) / lib_default3(ONE5 - x))));
  }
  return sgn ? lib_default3(-t) : t;
}
var main_default45 = atanhf;

var lib_default65 = main_default45;

var ONE6 = lib_default3(1);
function acothf(x) {
  return lib_default65(lib_default3(ONE6 / lib_default3(x)));
}
var main_default46 = acothf;

var lib_default66 = main_default46;

function acovercos(x) {
  return lib_default33(x - 1);
}
var main_default47 = acovercos;

var lib_default67 = main_default47;

function evalpoly22(x) {
  if (x === 0) {
    return 0.16666752099990845;
  }
  return lib_default3(0.16666752099990845 + lib_default3(x * lib_default3(0.07495300471782684 + lib_default3(x * lib_default3(0.04547002539038658 + lib_default3(x * lib_default3(0.024181311950087547 + lib_default3(x * 0.04216320067644119))))))));
}
var poly_p_default3 = evalpoly22;

function asinf(x) {
  var flag;
  var sgn;
  var ax;
  var z;
  if (lib_default6(x)) {
    return NaN;
  }
  x = lib_default3(x);
  if (x > 0) {
    sgn = 1;
    ax = x;
  } else {
    sgn = -1;
    ax = -x;
  }
  if (ax > 1) {
    return NaN;
  }
  if (ax < 1e-4) {
    return x;
  }
  if (ax > 0.5) {
    z = lib_default3(0.5 * lib_default3(1 - ax));
    ax = lib_default38(z);
    flag = 1;
  } else {
    z = lib_default3(ax * ax);
    flag = 0;
  }
  z = lib_default3(lib_default3(lib_default3(poly_p_default3(z) * z) * ax) + ax);
  if (flag !== 0) {
    z = lib_default3(z + z);
    z = lib_default3(lib_default58 - z);
  }
  if (sgn < 0) {
    z = -z;
  }
  return z;
}
var main_default48 = asinf;

var lib_default68 = main_default48;

function acovercosf(x) {
  return lib_default68(lib_default3(lib_default3(x) - 1));
}
var main_default49 = acovercosf;

var lib_default69 = main_default49;

function acoversin(x) {
  return lib_default33(1 - x);
}
var main_default50 = acoversin;

var lib_default70 = main_default50;

function acoversinf(x) {
  return lib_default68(lib_default3(1 - lib_default3(x)));
}
var main_default51 = acoversinf;

var lib_default71 = main_default51;

function acsc(x) {
  return lib_default33(1 / x);
}
var main_default52 = acsc;

var lib_default72 = main_default52;

function acscd(x) {
  var rad = lib_default72(x);
  return lib_default35(rad);
}
var main_default53 = acscd;

var lib_default73 = main_default53;

function acscf(x) {
  return lib_default68(lib_default3(1 / lib_default3(x)));
}
var main_default54 = acscf;

var lib_default74 = main_default54;

function acscdf(x) {
  return lib_default37(lib_default74(lib_default3(x)));
}
var main_default55 = acscdf;

var lib_default75 = main_default55;

function isInfinite(x) {
  return x === lib_default43 || x === lib_default44;
}
var main_default56 = isInfinite;

var lib_default76 = main_default56;

var NEAR_ZERO3 = 1 / (1 << 28);
var HUGE3 = 1 << 28;
function asinh(x) {
  var sgn;
  var xx;
  var t;
  if (lib_default30(x) || lib_default76(x)) {
    return x;
  }
  if (x < 0) {
    x = -x;
    sgn = true;
  }
  if (x < NEAR_ZERO3) {
    t = x;
  } else if (x > HUGE3) {
    t = lib_default48(x) + lib_default47;
  } else if (x > 2) {
    t = lib_default48(2 * x + 1 / (lib_default31(x * x + 1) + x));
  } else {
    xx = x * x;
    t = lib_default46(x + xx / (1 + lib_default31(1 + xx)));
  }
  return sgn ? -t : t;
}
var main_default57 = asinh;

var lib_default77 = main_default57;

function acsch(x) {
  return lib_default77(1 / x);
}
var main_default58 = acsch;

var lib_default78 = main_default58;

function ahavercos(x) {
  return 2 * lib_default34(lib_default31(x));
}
var main_default59 = ahavercos;

var lib_default79 = main_default59;

function ahavercosf(x) {
  return lib_default3(2 * lib_default39(lib_default38(x)));
}
var main_default60 = ahavercosf;

var lib_default80 = main_default60;

function ahaversin(x) {
  return 2 * lib_default33(lib_default31(x));
}
var main_default61 = ahaversin;

var lib_default81 = main_default61;

function ahaversinf(x) {
  return lib_default3(2 * lib_default68(lib_default38(x)));
}
var main_default62 = ahaversinf;

var lib_default82 = main_default62;

function asec(x) {
  return lib_default34(1 / x);
}
var main_default63 = asec;

var lib_default83 = main_default63;

function asecd(x) {
  var rad = lib_default83(x);
  return lib_default35(rad);
}
var main_default64 = asecd;

var lib_default84 = main_default64;

function asecf(x) {
  return lib_default39(lib_default3(1 / lib_default3(x)));
}
var main_default65 = asecf;

var lib_default85 = main_default65;

function asecdf(x) {
  return lib_default37(lib_default85(lib_default3(x)));
}
var main_default66 = asecdf;

var lib_default86 = main_default66;

function asech(x) {
  return lib_default49(1 / x);
}
var main_default67 = asech;

var lib_default87 = main_default67;

function asind(x) {
  return lib_default35(lib_default33(x));
}
var main_default68 = asind;

var lib_default88 = main_default68;

function asindf(x) {
  return lib_default37(lib_default68(lib_default3(x)));
}
var main_default69 = asindf;

var lib_default89 = main_default69;

var ZERO6 = lib_default3(0);
var ONE7 = lib_default3(1);
var TWO4 = lib_default3(2);
var HUGE4 = lib_default3(1 << 28);
var NEAR_ZERO4 = lib_default3(ONE7 / HUGE4);
function asinhf(x) {
  var sgn;
  var xx;
  var s;
  var t;
  x = lib_default3(x);
  if (lib_default6(x) || lib_default9(x)) {
    return x;
  }
  if (x < ZERO6) {
    x = lib_default3(-x);
    sgn = true;
  }
  if (x < NEAR_ZERO4) {
    t = x;
  } else if (x > HUGE4) {
    t = lib_default3(lib_default15(x) + lib_default52);
  } else if (x > TWO4) {
    xx = lib_default3(x * x);
    s = lib_default38(lib_default3(xx + ONE7));
    t = lib_default15(lib_default3(lib_default3(TWO4 * x) + lib_default3(ONE7 / lib_default3(s + x))));
  } else {
    xx = lib_default3(x * x);
    s = lib_default38(lib_default3(ONE7 + xx));
    t = lib_default51(lib_default3(lib_default3(x) + lib_default3(xx / lib_default3(ONE7 + s))));
  }
  return sgn ? -t : t;
}
var main_default70 = asinhf;

var lib_default90 = main_default70;

var FLOAT64_HIGH_WORD_SIGN_MASK = 2147483648 >>> 0;
var lib_default91 = FLOAT64_HIGH_WORD_SIGN_MASK;

var FLOAT64_HIGH_WORD_ABS_MASK = 2147483647 >>> 0;
var lib_default92 = FLOAT64_HIGH_WORD_ABS_MASK;

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
var UINT32_VIEW7 = new Uint32Array(FLOAT64_VIEW3.buffer);
var HIGH4 = indices_default.HIGH;
var LOW2 = indices_default.LOW;
function toWords(x, out, stride, offset) {
  FLOAT64_VIEW3[0] = x;
  out[offset] = UINT32_VIEW7[HIGH4];
  out[offset + stride] = UINT32_VIEW7[LOW2];
  return out;
}
var assign_default = toWords;

function toWords2(x) {
  return assign_default(x, [0 >>> 0, 0 >>> 0], 1, 0);
}
var main_default71 = toWords2;

main_default71.assign = assign_default;
var lib_default93 = main_default71;

var indices2;
var HIGH5;
var LOW3;
if (is_little_endian_default === true) {
  HIGH5 = 1;
  LOW3 = 0;
} else {
  HIGH5 = 0;
  LOW3 = 1;
}
indices2 = {
  "HIGH": HIGH5,
  "LOW": LOW3
};
var indices_default2 = indices2;

var FLOAT64_VIEW4 = new Float64Array(1);
var UINT32_VIEW8 = new Uint32Array(FLOAT64_VIEW4.buffer);
var HIGH6 = indices_default2.HIGH;
var LOW4 = indices_default2.LOW;
function fromWords(high, low) {
  UINT32_VIEW8[HIGH6] = high;
  UINT32_VIEW8[LOW4] = low;
  return FLOAT64_VIEW4[0];
}
var main_default72 = fromWords;

var lib_default94 = main_default72;

var WORDS = [0, 0];
function copysign(x, y) {
  var hx;
  var hy;
  lib_default93.assign(x, WORDS, 1, 0);
  hx = WORDS[0];
  hx &= lib_default92;
  hy = lib_default41(y);
  hy &= lib_default91;
  hx |= hy;
  return lib_default94(hx, WORDS[1]);
}
var main_default73 = copysign;

var lib_default95 = main_default73;

function signbit(x) {
  var high = lib_default41(x);
  return high >>> 31 ? true : false;
}
var main_default74 = signbit;

var lib_default96 = main_default74;

function atan2(y, x) {
  var q;
  if (lib_default30(x) || lib_default30(y)) {
    return NaN;
  }
  if (lib_default76(x)) {
    if (x === lib_default43) {
      if (lib_default76(y)) {
        return lib_default95(lib_default26 / 4, y);
      }
      return lib_default95(0, y);
    }
    if (lib_default76(y)) {
      return lib_default95(3 * lib_default26 / 4, y);
    }
    return lib_default95(lib_default26, y);
  }
  if (lib_default76(y)) {
    return lib_default95(lib_default26 / 2, y);
  }
  if (y === 0) {
    if (x >= 0 && !lib_default96(x)) {
      return lib_default95(0, y);
    }
    return lib_default95(lib_default26, y);
  }
  if (x === 0) {
    return lib_default95(lib_default26 / 2, y);
  }
  q = lib_default55(y / x);
  if (x < 0) {
    if (q <= 0) {
      return q + lib_default26;
    }
    return q - lib_default26;
  }
  return q;
}
var main_default75 = atan2;

var lib_default97 = main_default75;

function atan2d(y, x) {
  return lib_default35(lib_default97(y, x));
}
var main_default76 = atan2d;

var lib_default98 = main_default76;

function signbitf(x) {
  var w = lib_default10(x);
  return w >>> 31 ? true : false;
}
var main_default77 = signbitf;

var lib_default99 = main_default77;

var ZERO7 = lib_default3(0);
var TWO5 = lib_default3(2);
var THREE2 = lib_default3(3);
var FOUR2 = lib_default3(4);
function atan2f(y, x) {
  var q;
  x = lib_default3(x);
  y = lib_default3(y);
  if (lib_default6(x) || lib_default6(y)) {
    return NaN;
  }
  if (lib_default9(x)) {
    if (x === lib_default7) {
      if (lib_default9(y)) {
        return lib_default23(lib_default3(lib_default28 / FOUR2), y);
      }
      return lib_default23(ZERO7, y);
    }
    if (lib_default9(y)) {
      return lib_default23(lib_default3(lib_default3(THREE2 * lib_default28) / FOUR2), y);
    }
    return lib_default23(lib_default28, y);
  }
  if (lib_default9(y)) {
    return lib_default23(lib_default3(lib_default28 / TWO5), y);
  }
  if (y === 0) {
    if (x >= 0 && !lib_default99(x)) {
      return lib_default23(ZERO7, y);
    }
    return lib_default23(lib_default28, y);
  }
  if (x === 0) {
    return lib_default23(lib_default3(lib_default28 / TWO5), y);
  }
  q = lib_default60(lib_default3(y / x));
  if (x < 0) {
    if (q <= 0) {
      return lib_default3(q + lib_default28);
    }
    return lib_default3(q - lib_default28);
  }
  return q;
}
var main_default78 = atan2f;

var lib_default100 = main_default78;

function atand(x) {
  var rad = lib_default55(x);
  return lib_default35(rad);
}
var main_default79 = atand;

var lib_default101 = main_default79;

function atandf(x) {
  return lib_default37(lib_default60(lib_default3(x)));
}
var main_default80 = atandf;

var lib_default102 = main_default80;

function aversin(x) {
  return lib_default34(1 - x);
}
var main_default81 = aversin;

var lib_default103 = main_default81;

function aversinf(x) {
  return lib_default39(lib_default3(1 - lib_default3(x)));
}
var main_default82 = aversinf;

var lib_default104 = main_default82;

var floor = Math.floor;
var main_default83 = floor;

var lib_default105 = main_default83;

function isNonNegativeInteger(x) {
  return lib_default105(x) === x && x >= 0;
}
var main_default84 = isNonNegativeInteger;

var lib_default106 = main_default84;

function isInteger(x) {
  return lib_default105(x) === x;
}
var main_default85 = isInteger;

var lib_default107 = main_default85;

function isEven(x) {
  return lib_default107(x / 2);
}
var main_default86 = isEven;

var lib_default108 = main_default86;

function isOdd(x) {
  if (x > 0) {
    return lib_default108(x - 1);
  }
  return lib_default108(x + 1);
}
var main_default87 = isOdd;

var lib_default109 = main_default87;

var bernoulli_default = [
  1,
  0.16666666666666666,
  -0.03333333333333333,
  0.023809523809523808,
  -0.03333333333333333,
  0.07575757575757576,
  -0.2531135531135531,
  1.1666666666666667,
  -7.092156862745098,
  54.971177944862156,
  -529.1242424242424,
  6192.123188405797,
  -86580.25311355312,
  1.4255171666666667e6,
  -27298231067816094e-9,
  6015808739006424e-7,
  -15116315767092157e-6,
  4296146430611667e-4,
  -13711655205088332e-3,
  4883323189735932e-1,
  -19296579341940068,
  841693047573682600,
  -40338071854059454e3,
  21150748638081993e5,
  -12086626522296526e7,
  7500866746076964e9,
  -5038778101481069e11,
  36528776484818122e12,
  -2849876930245088e15,
  23865427499683627e16,
  -21399949257225335e18,
  20500975723478097e20,
  -2093800591134638e23,
  22752696488463515e24,
  -26257710286239577e26,
  3212508210271803e29,
  -4159827816679471e31,
  5692069548203528e33,
  -8218362941978458e35,
  12502904327166994e37,
  -2001558323324837e40,
  33674982915364376e41,
  -5947097050313545e44,
  11011910323627977e46,
  -21355259545253502e48,
  43328896986641194e50,
  -9188552824166933e53,
  20346896776329074e55,
  -4700383395803573e58,
  1131804344548425e61,
  -28382249570693707e62,
  7406424897967885e65,
  -20096454802756605e67,
  5665717005080594e70,
  -16584511154136216e72,
  5036885995049238e75,
  -15861468237658186e77,
  51756743617545625e79,
  -17488921840217116e82,
  6116051999495218e85,
  -22122776912707833e87,
  8272277679877097e90,
  -3195892511141571e93,
  12750082223387793e95,
  -5250092308677413e98,
  22301817894241627e100,
  -976845219309552e104,
  4409836197845295e106,
  -2050857088646409e109,
  9821443327979128e111,
  -4841260079820888e114,
  24553088801480982e116,
  -12806926804084748e119,
  6867616710466858e122,
  -37846468581969106e124,
  2142610125066529e128,
  -12456727137183695e130,
  7434578755100016e133,
  -45535795304641704e135,
  2861211281685887e139,
  -1843772355203387e142,
  12181154536221047e144,
  -8248218718531412e147,
  5722587793783294e150,
  -40668530525059105e152,
  29596092064642052e155,
  -22049522565189457e158,
  168125970728896e163,
  -13116736213556958e164,
  10467894009478039e167,
  -8543289357883371e170,
  7128782132248655e173,
  -608029314555359e177,
  5299677642484992e179,
  -4719425916874586e182,
  4292841379140298e185,
  -39876744968232205e187,
  3781978041935888e191,
  -3661423368368119e194,
  3617609027237286e197,
  -3647077264519136e200,
  3750875543645441e203,
  -3934586729643903e206,
  4208821114819008e209,
  -4590229622061792e212,
  5103172577262957e215,
  -5782276230365695e218,
  6676248216783588e221,
  -7853530764445042e224,
  9410689406705872e227,
  -11484933873465185e230,
  14272958742848785e233,
  -1805955958690931e237,
  23261535307660807e239,
  -30495751715499594e242,
  4068580607643398e246,
  -5523103132197436e249,
  76277279396434395e251,
  -10715571119697886e255,
  15310200895969188e258,
  -22244891682179836e261,
  3286267919069014e265,
  -4935592895596035e268,
  7534957120083251e271,
  -11691485154584178e274,
  1843526146783894e278,
  -2953682617296808e281,
  4807932127750157e284,
  -7950212504588525e287,
  13352784187354634e290
];

var MAX_BERNOULLI = 258 | 0;
function bernoulli(n) {
  if (lib_default30(n) || !lib_default106(n)) {
    return NaN;
  }
  if (n === 1) {
    return 0.5;
  }
  if (lib_default109(n)) {
    return 0;
  }
  if (n > MAX_BERNOULLI) {
    return lib_default109(n / 2) ? lib_default43 : lib_default44;
  }
  return bernoulli_default[n / 2];
}
var main_default88 = bernoulli;

var lib_default110 = main_default88;

function isNonNegativeIntegerf(x) {
  return lib_default16(x) === x && x >= 0;
}
var main_default89 = isNonNegativeIntegerf;

var lib_default111 = main_default89;

function isIntegerf(x) {
  x = lib_default3(x);
  return lib_default16(x) === x;
}
var main_default90 = isIntegerf;

var lib_default112 = main_default90;

function isEvenf(x) {
  return lib_default112(lib_default3(lib_default3(x) / 2));
}
var main_default91 = isEvenf;

var lib_default113 = main_default91;

function isOddf(x) {
  x = lib_default3(x);
  if (x > 0) {
    return lib_default113(lib_default3(x - 1));
  }
  return lib_default113(lib_default3(x + 1));
}
var main_default92 = isOddf;

var lib_default114 = main_default92;

var bernoullif_default = [
  1,
  0.1666666716337204,
  -0.03333333507180214,
  0.02380952425301075,
  -0.03333333507180214,
  0.07575757801532745,
  -0.2531135678291321,
  1.1666666269302368,
  -7.092156887054443,
  54.97117614746094,
  -529.124267578125,
  6192.123046875,
  -86580.25,
  1425517125e-3,
  -27298232,
  601580864,
  -15116315648,
  429614628864,
  -13711654780928,
  488332312182784,
  -19296579391324160,
  841693056053805e3,
  -40338073359287845e3,
  21150748918604188e5,
  -12086626472668042e7,
  7500866956719485e9,
  -5038777949942763e11,
  3652877742276384e13,
  -2849876996904201e15,
  2386542781638813e17,
  -21399950070596233e18,
  2050097633557977e21,
  -20938006042234345e22
];

var MAX_BERNOULLI2 = 64 | 0;
function bernoullif(n) {
  if (lib_default6(n) || !lib_default111(n)) {
    return NaN;
  }
  if (n === 1) {
    return 0.5;
  }
  if (lib_default114(n)) {
    return 0;
  }
  if (n > MAX_BERNOULLI2) {
    return lib_default114(n / 2) ? lib_default7 : lib_default8;
  }
  return lib_default3(bernoullif_default[n / 2]);
}
var main_default93 = bernoullif;

var lib_default115 = main_default93;

function evalrational3(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.17291506903064494;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -4129866850099087e-4 + x * (2728250787860594e-5 + x * (-6214070042354012e-7 + x * (663029979048338e-8 + x * (-36629.81465510709 + x * (103.44222815443189 + x * -0.12117036164593528)))));
    s2 = 2388378799633229e-3 + x * (2632819830085965e-5 + x * (13985097372263435e-8 + x * (456126.9622421994 + x * (936.1402239233771 + x * (1 + x * 0)))));
  } else {
    x = 1 / x;
    s1 = -0.12117036164593528 + x * (103.44222815443189 + x * (-36629.81465510709 + x * (663029979048338e-8 + x * (-6214070042354012e-7 + x * (2728250787860594e-5 + x * -4129866850099087e-4)))));
    s2 = 0 + x * (1 + x * (936.1402239233771 + x * (456126.9622421994 + x * (13985097372263435e-8 + x * (2632819830085965e-5 + x * 2388378799633229e-3)))));
  }
  return s1 / s2;
}
var rational_p1q1_default = evalrational3;

function evalrational4(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.005119512965174424;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -1831.9397969392085 + x * (-12254.07816137899 + x * (-7287.970246446462 + x * (10341.910641583727 + x * (11725.046279757104 + x * (4417.670702532509 + x * (743.2119668062425 + x * 48.5917033559165))))));
    s2 = -357834.78026152303 + x * (245991.0226258631 + x * (-84055.06259116957 + x * (18680.99000835919 + x * (-2945.876654550934 + x * (333.07310774649073 + x * (-25.258076240801554 + x * 1))))));
  } else {
    x = 1 / x;
    s1 = 48.5917033559165 + x * (743.2119668062425 + x * (4417.670702532509 + x * (11725.046279757104 + x * (10341.910641583727 + x * (-7287.970246446462 + x * (-12254.07816137899 + x * -1831.9397969392085))))));
    s2 = 1 + x * (-25.258076240801554 + x * (333.07310774649073 + x * (-2945.876654550934 + x * (18680.99000835919 + x * (-84055.06259116957 + x * (245991.0226258631 + x * -357834.78026152303))))));
  }
  return s1 / s2;
}
var rational_p2q2_default = evalrational4;

function evalrational5(x) {
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
    s1 = 22779.090197304686 + x * (41345.38663958076 + x * (21170.523380864943 + x * (3480.648644324927 + x * (153.76201909008356 + x * 0.8896154842421046))));
    s2 = 22779.090197304686 + x * (41370.41249551042 + x * (21215.350561880117 + x * (3502.8735138235606 + x * (157.11159858080893 + x * 1))));
  } else {
    x = 1 / x;
    s1 = 0.8896154842421046 + x * (153.76201909008356 + x * (3480.648644324927 + x * (21170.523380864943 + x * (41345.38663958076 + x * 22779.090197304686))));
    s2 = 1 + x * (157.11159858080893 + x * (3502.8735138235606 + x * (21215.350561880117 + x * (41370.41249551042 + x * 22779.090197304686))));
  }
  return s1 / s2;
}
var rational_pcqc_default = evalrational5;

function evalrational6(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.015625;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -89.22660020080009 + x * (-185.91953644342993 + x * (-111.83429920482737 + x * (-22.300261666214197 + x * (-1.244102674583564 + x * -0.008803330304868075))));
    s2 = 5710.502412851206 + x * (11951.131543434614 + x * (7264.278016921102 + x * (1488.7231232283757 + x * (90.59376959499312 + x * 1))));
  } else {
    x = 1 / x;
    s1 = -0.008803330304868075 + x * (-1.244102674583564 + x * (-22.300261666214197 + x * (-111.83429920482737 + x * (-185.91953644342993 + x * -89.22660020080009))));
    s2 = 1 + x * (90.59376959499312 + x * (1488.7231232283757 + x * (7264.278016921102 + x * (11951.131543434614 + x * 5710.502412851206))));
  }
  return s1 / s2;
}
var rational_psqs_default = evalrational6;

var FLOAT64_HIGH_WORD_EXPONENT_MASK = 2146435072;
var lib_default116 = FLOAT64_HIGH_WORD_EXPONENT_MASK;

var FLOAT64_HIGH_WORD_SIGNIFICAND_MASK = 1048575;
var lib_default117 = FLOAT64_HIGH_WORD_SIGNIFICAND_MASK;

var LOW5;
if (is_little_endian_default === true) {
  LOW5 = 0;
} else {
  LOW5 = 1;
}
var low_default = LOW5;

var FLOAT64_VIEW5 = new Float64Array(1);
var UINT32_VIEW9 = new Uint32Array(FLOAT64_VIEW5.buffer);
function getLowWord(x) {
  FLOAT64_VIEW5[0] = x;
  return UINT32_VIEW9[low_default];
}
var main_default94 = getLowWord;

var lib_default118 = main_default94;

var FLOAT64_MAX_BASE2_EXPONENT = 1023 | 0;
var lib_default119 = FLOAT64_MAX_BASE2_EXPONENT;

var FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL = -1023 | 0;
var lib_default120 = FLOAT64_MAX_BASE2_EXPONENT_SUBNORMAL;

var FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL = -1074 | 0;
var lib_default121 = FLOAT64_MIN_BASE2_EXPONENT_SUBNORMAL;

function exponent(x) {
  var high = lib_default41(x);
  high = (high & lib_default116) >>> 20;
  return high - lib_default45 | 0;
}
var main_default95 = exponent;

var lib_default122 = main_default95;

var FLOAT64_SMALLEST_NORMAL = 22250738585072014e-324;
var lib_default123 = FLOAT64_SMALLEST_NORMAL;

var SCALAR = 4503599627370496;
function normalize(x, out, stride, offset) {
  if (lib_default30(x) || lib_default76(x)) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  if (x !== 0 && lib_default(x) < lib_default123) {
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
var main_default96 = normalize2;

main_default96.assign = assign_default2;
var lib_default124 = main_default96;

var normalize3 = lib_default124.assign;
var TWO52_INV = 2220446049250313e-31;
var CLEAR_EXP_MASK = 2148532223 >>> 0;
var FRAC = [0, 0];
var WORDS2 = [0, 0];
function ldexp(frac, exp3) {
  var high;
  var m;
  if (exp3 === 0 || frac === 0 || // handles +-0
  lib_default30(frac) || lib_default76(frac)) {
    return frac;
  }
  normalize3(frac, FRAC, 1, 0);
  frac = FRAC[0];
  exp3 += FRAC[1];
  exp3 += lib_default122(frac);
  if (exp3 < lib_default121) {
    return lib_default95(0, frac);
  }
  if (exp3 > lib_default119) {
    if (frac < 0) {
      return lib_default44;
    }
    return lib_default43;
  }
  if (exp3 <= lib_default120) {
    exp3 += 52;
    m = TWO52_INV;
  } else {
    m = 1;
  }
  lib_default93.assign(frac, WORDS2, 1, 0);
  high = WORDS2[0];
  high &= CLEAR_EXP_MASK;
  high |= exp3 + lib_default45 << 20;
  return m * lib_default94(high, WORDS2[1]);
}
var main_default97 = ldexp;

var lib_default125 = main_default97;

function filled(value, len) {
  var arr;
  var i;
  arr = [];
  for (i = 0; i < len; i++) {
    arr.push(value);
  }
  return arr;
}
var main_default98 = filled;

var lib_default126 = main_default98;

function zeros(len) {
  return lib_default126(0, len);
}
var main_default99 = zeros;

var lib_default127 = main_default99;

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
var PIO22 = [
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
var F = lib_default127(20);
var Q = lib_default127(20);
var FQ = lib_default127(20);
var IQ = lib_default127(20);
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
  z = lib_default125(z, q0);
  z -= 8 * lib_default105(z * 0.125);
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
        z -= lib_default125(1, q0);
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
    z = lib_default125(z, -q0);
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
  fw = lib_default125(1, q0);
  for (i = jz; i >= 0; i--) {
    q[i] = fw * IQ[i];
    fw *= TWON24;
  }
  for (i = jz; i >= 0; i--) {
    fw = 0;
    for (k = 0; k <= jp && k <= jz - i; k++) {
      fw += PIO22[k] * q[i + k];
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
var main_default100 = round;

var lib_default128 = main_default100;

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
  n = lib_default128(x * INVPIO2);
  r = x - n * PIO2_1;
  w = n * PIO2_1T;
  j = ix >> 20 | 0;
  y[0] = r - w;
  high = lib_default41(y[0]);
  i = j - (high >> 20 & EXPONENT_MASK);
  if (i > 16) {
    t = r;
    w = n * PIO2_2;
    r = t - w;
    w = n * PIO2_2T - (t - r - w);
    y[0] = r - w;
    high = lib_default41(y[0]);
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

var ZERO8 = 0;
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
  hx = lib_default41(x) | 0;
  ix = hx & lib_default92 | 0;
  if (ix <= PIO4_HIGH_WORD) {
    y[0] = x;
    y[1] = 0;
    return 0;
  }
  if (ix <= FIVE_PIO4_HIGH_WORD) {
    if ((ix & lib_default117) === PI_HIGH_WORD_SIGNIFICAND) {
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
  if (ix >= lib_default116) {
    y[0] = NaN;
    y[1] = NaN;
    return 0;
  }
  low = lib_default118(x);
  e0 = (ix >> 20) - 1046;
  z = lib_default94(ix - (e0 << 20 | 0), low);
  for (i = 0; i < 2; i++) {
    TX[i] = z | 0;
    z = (z - TX[i]) * TWO242;
  }
  TX[2] = z;
  nx = 3;
  while (TX[nx - 1] === ZERO8) {
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
var main_default101 = rempio2;

var lib_default129 = main_default101;

var S1 = -0.16666666666666632;
var S2 = 0.00833333333332249;
var S3 = -1984126982985795e-19;
var S4 = 27557313707070068e-22;
var S5 = -25050760253406863e-24;
var S6 = 158969099521155e-24;
var C12 = 0.0416666666666666;
var C2 = -0.001388888888887411;
var C3 = 2480158728947673e-20;
var C4 = -27557314351390663e-23;
var C5 = 2087572321298175e-24;
var C6 = -11359647557788195e-27;
function kernelSincos(x, y, out, stride, offset) {
  var hz;
  var r;
  var v3;
  var w;
  var z;
  z = x * x;
  w = z * z;
  r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  v3 = z * x;
  if (y === 0) {
    out[offset] = x + v3 * (S1 + z * r);
  } else {
    out[offset] = x - (z * (0.5 * y - v3 * r) - y - v3 * S1);
  }
  r = z * (C12 + z * (C2 + z * C3));
  r += w * w * (C4 + z * (C5 + z * C6));
  hz = 0.5 * z;
  w = 1 - hz;
  out[offset + stride] = w + (1 - w - hz + (z * r - x * y));
  return out;
}
var kernel_sincos_default = kernelSincos;

var PIO4_HIGH_WORD2 = 1072243195 | 0;
var SMALL_HIGH_WORD = 1044381696 | 0;
var Y = [0, 0];
function sincos(x, out, stride, offset) {
  var tmp7;
  var ix;
  var n;
  ix = lib_default41(x);
  ix &= lib_default92;
  if (ix <= PIO4_HIGH_WORD2) {
    if (ix < SMALL_HIGH_WORD) {
      if ((x | 0) === 0) {
        out[offset] = x;
        out[offset + stride] = 0;
      }
    }
    return kernel_sincos_default(x, 0, out, stride, offset);
  }
  if (ix >= lib_default116) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  n = lib_default129(x, Y);
  kernel_sincos_default(Y[0], Y[1], out, stride, offset);
  switch (n & 3) {
    case 1:
      tmp7 = out[offset + stride];
      out[offset + stride] = -out[offset];
      out[offset] = tmp7;
      return out;
    case 2:
      out[offset] *= -1;
      out[offset + stride] *= -1;
      return out;
    case 3:
      tmp7 = -out[offset + stride];
      out[offset + stride] = out[offset];
      out[offset] = tmp7;
      return out;
    default:
      return out;
  }
}
var assign_default3 = sincos;

function sincos2(x) {
  return assign_default3(x, [0, 0], 1, 0);
}
var main_default102 = sincos2;

main_default102.assign = assign_default3;
var lib_default130 = main_default102;

var sincos3 = lib_default130.assign;
var ONE_DIV_SQRT_PI = 0.5641895835477563;
var x1 = 2.404825557695773;
var x2 = 5.520078110286311;
var x11 = 616;
var x12 = -0.0014244423042272315;
var x21 = 1413;
var x22 = 5468602863106496e-19;
var sc = [0, 0];
function j0(x) {
  var rc;
  var rs;
  var y2;
  var r;
  var y;
  var f;
  if (x < 0) {
    x = -x;
  }
  if (x === lib_default43) {
    return 0;
  }
  if (x === 0) {
    return 1;
  }
  if (x <= 4) {
    y = x * x;
    r = rational_p1q1_default(y);
    f = (x + x1) * (x - x11 / 256 - x12);
    return f * r;
  }
  if (x <= 8) {
    y = 1 - x * x / 64;
    r = rational_p2q2_default(y);
    f = (x + x2) * (x - x21 / 256 - x22);
    return f * r;
  }
  y = 8 / x;
  y2 = y * y;
  rc = rational_pcqc_default(y2);
  rs = rational_psqs_default(y2);
  f = ONE_DIV_SQRT_PI / lib_default31(x);
  sincos3(x, sc, 1, 0);
  return f * (rc * (sc[1] + sc[0]) - y * rs * (sc[0] - sc[1]));
}
var main_default103 = j0;

var lib_default131 = main_default103;

var SQRT_PI = 1.772453850905516;
var lib_default132 = SQRT_PI;

function evalrational7(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.03405537391318949;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -14258509801366644e-5 + x * (667810412614924e-5 + x * (-11548696764841276e-8 + x * (980629.0409895825 + x * (-4461.579298277507 + x * (10.650724020080236 + x * -0.010767857011487301)))));
    s2 = 41868604460820176e-4 + x * (4209190228258013e-5 + x * (20228375140097034e-8 + x * (591176.1449417479 + x * (1074.227223951738 + x * (1 + x * 0)))));
  } else {
    x = 1 / x;
    s1 = -0.010767857011487301 + x * (10.650724020080236 + x * (-4461.579298277507 + x * (980629.0409895825 + x * (-11548696764841276e-8 + x * (667810412614924e-5 + x * -14258509801366644e-5)))));
    s2 = 0 + x * (1 + x * (1074.227223951738 + x * (591176.1449417479 + x * (20228375140097034e-8 + x * (4209190228258013e-5 + x * 41868604460820176e-4)))));
  }
  return s1 / s2;
}
var rational_p1q1_default2 = evalrational7;

function evalrational8(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.010158790774176108;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -17527881995806512 + x * (16608531731299018e-1 + x * (-36658018905416664e-3 + x * (3558066567091062e-4 + x * (-18113931269860668e-7 + x * (5079326614801118e-9 + x * (-7502.334222078161 + x * 4.6179191852758255))))));
    s2 = 1725390588844768e3 + x * (17128800897135812 + x * (8489934616548142e-2 + x * (27622777286244086e-5 + x * (6487250289959639e-7 + x * (1.1267125065029138e6 + x * (1388.6978985861358 + x * 1))))));
  } else {
    x = 1 / x;
    s1 = 4.6179191852758255 + x * (-7502.334222078161 + x * (5079326614801118e-9 + x * (-18113931269860668e-7 + x * (3558066567091062e-4 + x * (-36658018905416664e-3 + x * (16608531731299018e-1 + x * -17527881995806512))))));
    s2 = 1 + x * (1388.6978985861358 + x * (1.1267125065029138e6 + x * (6487250289959639e-7 + x * (27622777286244086e-5 + x * (8489934616548142e-2 + x * (17128800897135812 + x * 1725390588844768e3))))));
  }
  return s1 / s2;
}
var rational_p2q2_default2 = evalrational8;

function evalrational9(x) {
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
    s1 = -4435757816794128e-9 + x * (-9942246505077641e-9 + x * (-6603373248364939e-9 + x * (-1.5235293511811374e6 + x * (-109824.05543459347 + x * (-1611.6166443246102 + x * 0)))));
    s2 = -4435757816794128e-9 + x * (-9934124389934586e-9 + x * (-6.5853394797230875e6 + x * (-1.5118095066341609e6 + x * (-107263.8599110382 + x * (-1455.0094401904962 + x * 1)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (-1611.6166443246102 + x * (-109824.05543459347 + x * (-1.5235293511811374e6 + x * (-6603373248364939e-9 + x * (-9942246505077641e-9 + x * -4435757816794128e-9)))));
    s2 = 1 + x * (-1455.0094401904962 + x * (-107263.8599110382 + x * (-1.5118095066341609e6 + x * (-6.5853394797230875e6 + x * (-9934124389934586e-9 + x * -4435757816794128e-9)))));
  }
  return s1 / s2;
}
var rational_pcqc_default2 = evalrational9;

function evalrational10(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.046875;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 33220.913409857225 + x * (85145.1606753357 + x * (66178.83658127084 + x * (18494.262873223866 + x * (1706.375429020768 + x * (35.26513384663603 + x * 0)))));
    s2 = 708712.8194102874 + x * (1.8194580422439973e6 + x * (1419460669603721e-9 + x * (400294.43582266977 + x * (37890.2297457722 + x * (863.8367769604992 + x * 1)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (35.26513384663603 + x * (1706.375429020768 + x * (18494.262873223866 + x * (66178.83658127084 + x * (85145.1606753357 + x * 33220.913409857225)))));
    s2 = 1 + x * (863.8367769604992 + x * (37890.2297457722 + x * (400294.43582266977 + x * (1419460669603721e-9 + x * (1.8194580422439973e6 + x * 708712.8194102874)))));
  }
  return s1 / s2;
}
var rational_psqs_default2 = evalrational10;

var sincos4 = lib_default130.assign;
var x13 = 3.8317059702075125;
var x23 = 7.015586669815619;
var x112 = 981;
var x122 = -3252797924876844e-19;
var x212 = 1796;
var x222 = -38330184381246464e-21;
var sc2 = [0, 0];
function j1(x) {
  var value;
  var rc;
  var rs;
  var y2;
  var r;
  var y;
  var f;
  var w;
  w = lib_default(x);
  if (x === 0) {
    return 0;
  }
  if (w === lib_default43) {
    return 0;
  }
  if (w <= 4) {
    y = x * x;
    r = rational_p1q1_default2(y);
    f = w * (w + x13) * (w - x112 / 256 - x122);
    value = f * r;
  } else if (w <= 8) {
    y = x * x;
    r = rational_p2q2_default2(y);
    f = w * (w + x23) * (w - x212 / 256 - x222);
    value = f * r;
  } else {
    y = 8 / w;
    y2 = y * y;
    rc = rational_pcqc_default2(y2);
    rs = rational_psqs_default2(y2);
    f = 1 / (lib_default31(w) * lib_default132);
    sincos4(w, sc2, 1, 0);
    value = f * (rc * (sc2[0] - sc2[1]) + y * rs * (sc2[0] + sc2[1]));
  }
  if (x < 0) {
    value *= -1;
  }
  return value;
}
var main_default104 = j1;

var lib_default133 = main_default104;

function evalrational11(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.18214429522164177;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 10723538782003177e-5 + x * (-837162554512605e-5 + x * (2042227435737662e-7 + x * (-212875484744018e-8 + x * (10102.532948020907 + x * -18.402381979244993))));
    s2 = 5887386573899703e-4 + x * (8161718777729036e-6 + x * (55662956624278255e-9 + x * (238893.93209447255 + x * (664.7598668924019 + x * 1))));
  } else {
    x = 1 / x;
    s1 = -18.402381979244993 + x * (10102.532948020907 + x * (-212875484744018e-8 + x * (2042227435737662e-7 + x * (-837162554512605e-5 + x * 10723538782003177e-5))));
    s2 = 1 + x * (664.7598668924019 + x * (238893.93209447255 + x * (55662956624278255e-9 + x * (8161718777729036e-6 + x * 5887386573899703e-4))));
  }
  return s1 / s2;
}
var rational_p1q1_default3 = evalrational11;

function evalrational12(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.051200622130023854;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -2221397696756619e-2 + x * (-5510743520672264e-4 + x * (4360009863860306e-5 + x * (-6959043939461962e-7 + x * (4690528861167863e-9 + x * (-14566.865832663636 + x * 17.427031242901595)))));
    s2 = 4338614658070726e-1 + x * (5426682441941234e-3 + x * (3401510384997124e-5 + x * (1396020277098683e-7 + x * (406699.82352539554 + x * (830.3085761207029 + x * 1)))));
  } else {
    x = 1 / x;
    s1 = 17.427031242901595 + x * (-14566.865832663636 + x * (4690528861167863e-9 + x * (-6959043939461962e-7 + x * (4360009863860306e-5 + x * (-5510743520672264e-4 + x * -2221397696756619e-2)))));
    s2 = 1 + x * (830.3085761207029 + x * (406699.82352539554 + x * (1396020277098683e-7 + x * (3401510384997124e-5 + x * (5426682441941234e-3 + x * 4338614658070726e-1)))));
  }
  return s1 / s2;
}
var rational_p2q2_default3 = evalrational12;

function evalrational13(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.023356489432789604;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -8072872690515021 + x * (6701664186917324e-1 + x * (-12829912364088687e-5 + x * (-19363051266772083e-5 + x * (21958827170518103e-7 + x * (-10085539923498211e-9 + x * (21363.5341693139 + x * -17.439661319197498))))));
    s2 = 345637246288464600 + x * (3927242556964031 + x * (225983779240429e-1 + x * (8692612110420982e-5 + x * (24727219475672302e-8 + x * (539247.3920976806 + x * (879.0336216812844 + x * 1))))));
  } else {
    x = 1 / x;
    s1 = -17.439661319197498 + x * (21363.5341693139 + x * (-10085539923498211e-9 + x * (21958827170518103e-7 + x * (-19363051266772083e-5 + x * (-12829912364088687e-5 + x * (6701664186917324e-1 + x * -8072872690515021))))));
    s2 = 1 + x * (879.0336216812844 + x * (539247.3920976806 + x * (24727219475672302e-8 + x * (8692612110420982e-5 + x * (225983779240429e-1 + x * (3927242556964031 + x * 345637246288464600))))));
  }
  return s1 / s2;
}
var rational_p3q3_default = evalrational13;

function evalrational14(x) {
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
    s1 = 22779.090197304686 + x * (41345.38663958076 + x * (21170.523380864943 + x * (3480.648644324927 + x * (153.76201909008356 + x * 0.8896154842421046))));
    s2 = 22779.090197304686 + x * (41370.41249551042 + x * (21215.350561880117 + x * (3502.8735138235606 + x * (157.11159858080893 + x * 1))));
  } else {
    x = 1 / x;
    s1 = 0.8896154842421046 + x * (153.76201909008356 + x * (3480.648644324927 + x * (21170.523380864943 + x * (41345.38663958076 + x * 22779.090197304686))));
    s2 = 1 + x * (157.11159858080893 + x * (3502.8735138235606 + x * (21215.350561880117 + x * (41370.41249551042 + x * 22779.090197304686))));
  }
  return s1 / s2;
}
var rational_pcqc_default3 = evalrational14;

function evalrational15(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.015625;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -89.22660020080009 + x * (-185.91953644342993 + x * (-111.83429920482737 + x * (-22.300261666214197 + x * (-1.244102674583564 + x * -0.008803330304868075))));
    s2 = 5710.502412851206 + x * (11951.131543434614 + x * (7264.278016921102 + x * (1488.7231232283757 + x * (90.59376959499312 + x * 1))));
  } else {
    x = 1 / x;
    s1 = -0.008803330304868075 + x * (-1.244102674583564 + x * (-22.300261666214197 + x * (-111.83429920482737 + x * (-185.91953644342993 + x * -89.22660020080009))));
    s2 = 1 + x * (90.59376959499312 + x * (1488.7231232283757 + x * (7264.278016921102 + x * (11951.131543434614 + x * 5710.502412851206))));
  }
  return s1 / s2;
}
var rational_psqs_default3 = evalrational15;

var sincos5 = lib_default130.assign;
var ONE_DIV_SQRT_PI2 = 1 / lib_default132;
var TWO_DIV_PI = 2 / lib_default26;
var x14 = 0.8935769662791675;
var x24 = 3.957678419314858;
var x3 = 7.086051060301773;
var x113 = 228;
var x123 = 0.0029519662791675214;
var x213 = 1013;
var x223 = 6471693148578684e-19;
var x31 = 1814;
var x32 = 11356030177269763e-20;
var sc3 = [0, 0];
function y0(x) {
  var rc;
  var rs;
  var y2;
  var r;
  var y;
  var z;
  var f;
  if (x < 0) {
    return NaN;
  }
  if (x === 0) {
    return lib_default44;
  }
  if (x === lib_default43) {
    return 0;
  }
  if (x <= 3) {
    y = x * x;
    z = lib_default48(x / x14) * lib_default131(x) * TWO_DIV_PI;
    r = rational_p1q1_default3(y);
    f = (x + x14) * (x - x113 / 256 - x123);
    return z + f * r;
  }
  if (x <= 5.5) {
    y = x * x;
    z = lib_default48(x / x24) * lib_default131(x) * TWO_DIV_PI;
    r = rational_p2q2_default3(y);
    f = (x + x24) * (x - x213 / 256 - x223);
    return z + f * r;
  }
  if (x <= 8) {
    y = x * x;
    z = lib_default48(x / x3) * lib_default131(x) * TWO_DIV_PI;
    r = rational_p3q3_default(y);
    f = (x + x3) * (x - x31 / 256 - x32);
    return z + f * r;
  }
  y = 8 / x;
  y2 = y * y;
  rc = rational_pcqc_default3(y2);
  rs = rational_psqs_default3(y2);
  f = ONE_DIV_SQRT_PI2 / lib_default31(x);
  sincos5(x, sc3, 1, 0);
  return f * (rc * (sc3[0] - sc3[1]) + y * rs * (sc3[1] + sc3[0]));
}
var main_default105 = y0;

var lib_default134 = main_default105;

function evalrational16(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.13187550549740895;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 4053572661257955e-2 + x * (5470861171652543e-3 + x * (-375959744978196e-3 + x * (7214454821450256e-6 + x * (-591574799974084e-7 + x * (221579.5322228026 + x * -317.1442466004613)))));
    s2 = 3073787392107929e-1 + x * (4127228620040646e-3 + x * (27800352738690586e-6 + x * (12250435122182964e-8 + x * (381364.70753052575 + x * (820.7990816839387 + x * 1)))));
  } else {
    x = 1 / x;
    s1 = -317.1442466004613 + x * (221579.5322228026 + x * (-591574799974084e-7 + x * (7214454821450256e-6 + x * (-375959744978196e-3 + x * (5470861171652543e-3 + x * 4053572661257955e-2)))));
    s2 = 1 + x * (820.7990816839387 + x * (381364.70753052575 + x * (12250435122182964e-8 + x * (27800352738690586e-6 + x * (4127228620040646e-3 + x * 3073787392107929e-1)))));
  }
  return s1 / s2;
}
var rational_p1q1_default4 = evalrational16;

function evalrational17(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.021593919914419626;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 11514276357909012e3 + x * (-5680809457472421e3 + x * (-23638408497043136 + x * (40686275289804745e-1 + x * (-59530713129741984e-3 + x * (3745367396243849e-4 + x * (-11957961912070618e-7 + x * (1.9153806858264203e6 + x * -1233.7180442012952)))))));
    s2 = 5332184431331618e5 + x * (5696819882285718e3 + x * (30837179548112880 + x * (1118701006585697e-1 + x * (30221766852960406e-5 + x * (6355031808708892e-7 + x * (1.0453748201934079e6 + x * (1285.516484932161 + x * 1)))))));
  } else {
    x = 1 / x;
    s1 = -1233.7180442012952 + x * (1.9153806858264203e6 + x * (-11957961912070618e-7 + x * (3745367396243849e-4 + x * (-59530713129741984e-3 + x * (40686275289804745e-1 + x * (-23638408497043136 + x * (-5680809457472421e3 + x * 11514276357909012e3)))))));
    s2 = 1 + x * (1285.516484932161 + x * (1.0453748201934079e6 + x * (6355031808708892e-7 + x * (30221766852960406e-5 + x * (1118701006585697e-1 + x * (30837179548112880 + x * (5696819882285718e3 + x * 5332184431331618e5)))))));
  }
  return s1 / s2;
}
var rational_p2q2_default4 = evalrational17;

function evalrational18(x) {
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
    s1 = -4435757816794128e-9 + x * (-9942246505077641e-9 + x * (-6603373248364939e-9 + x * (-1.5235293511811374e6 + x * (-109824.05543459347 + x * (-1611.6166443246102 + x * 0)))));
    s2 = -4435757816794128e-9 + x * (-9934124389934586e-9 + x * (-6.5853394797230875e6 + x * (-1.5118095066341609e6 + x * (-107263.8599110382 + x * (-1455.0094401904962 + x * 1)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (-1611.6166443246102 + x * (-109824.05543459347 + x * (-1.5235293511811374e6 + x * (-6603373248364939e-9 + x * (-9942246505077641e-9 + x * -4435757816794128e-9)))));
    s2 = 1 + x * (-1455.0094401904962 + x * (-107263.8599110382 + x * (-1.5118095066341609e6 + x * (-6.5853394797230875e6 + x * (-9934124389934586e-9 + x * -4435757816794128e-9)))));
  }
  return s1 / s2;
}
var rational_pcqc_default4 = evalrational18;

function evalrational19(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.046875;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 33220.913409857225 + x * (85145.1606753357 + x * (66178.83658127084 + x * (18494.262873223866 + x * (1706.375429020768 + x * (35.26513384663603 + x * 0)))));
    s2 = 708712.8194102874 + x * (1.8194580422439973e6 + x * (1419460669603721e-9 + x * (400294.43582266977 + x * (37890.2297457722 + x * (863.8367769604992 + x * 1)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (35.26513384663603 + x * (1706.375429020768 + x * (18494.262873223866 + x * (66178.83658127084 + x * (85145.1606753357 + x * 33220.913409857225)))));
    s2 = 1 + x * (863.8367769604992 + x * (37890.2297457722 + x * (400294.43582266977 + x * (1419460669603721e-9 + x * (1.8194580422439973e6 + x * 708712.8194102874)))));
  }
  return s1 / s2;
}
var rational_psqs_default4 = evalrational19;

var sincos6 = lib_default130.assign;
var ONE_DIV_SQRT_PI3 = 1 / lib_default132;
var TWO_DIV_PI2 = 2 / lib_default26;
var x15 = 2.197141326031017;
var x25 = 5.429681040794135;
var x114 = 562;
var x124 = 0.001828826031017035;
var x214 = 1390;
var x224 = -6459205864867228e-21;
var sc4 = [0, 0];
function y1(x) {
  var rc;
  var rs;
  var y2;
  var r;
  var y;
  var z;
  var f;
  if (x < 0) {
    return NaN;
  }
  if (x === 0) {
    return lib_default44;
  }
  if (x === lib_default43) {
    return 0;
  }
  if (x <= 4) {
    y = x * x;
    z = lib_default48(x / x15) * lib_default133(x) * TWO_DIV_PI2;
    r = rational_p1q1_default4(y);
    f = (x + x15) * (x - x114 / 256 - x124) / x;
    return z + f * r;
  }
  if (x <= 8) {
    y = x * x;
    z = lib_default48(x / x25) * lib_default133(x) * TWO_DIV_PI2;
    r = rational_p2q2_default4(y);
    f = (x + x25) * (x - x214 / 256 - x224) / x;
    return z + f * r;
  }
  y = 8 / x;
  y2 = y * y;
  rc = rational_pcqc_default4(y2);
  rs = rational_psqs_default4(y2);
  f = ONE_DIV_SQRT_PI3 / lib_default31(x);
  sincos6(x, sc4, 1, 0);
  return f * (y * rs * (sc4[0] - sc4[1]) - rc * (sc4[0] + sc4[1]));
}
var main_default106 = y1;

var lib_default135 = main_default106;

var ceil = Math.ceil;
var main_default107 = ceil;

var lib_default136 = main_default107;

function trunc(x) {
  if (x < 0) {
    return lib_default136(x);
  }
  return lib_default105(x);
}
var main_default108 = trunc;

var lib_default137 = main_default108;

function evalpoly23(x) {
  if (x === 0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6613756321437934e-20 + x * (-16533902205465252e-22 + x * 41381367970572385e-24)));
}
var polyval_p_default4 = evalpoly23;

function expmulti(hi, lo, k) {
  var r;
  var t;
  var c2;
  var y;
  r = hi - lo;
  t = r * r;
  c2 = r - t * polyval_p_default4(t);
  y = 1 - (lo - r * c2 / (2 - c2) - hi);
  return lib_default125(y, k);
}
var expmulti_default = expmulti;

var LN2_HI5 = 0.6931471803691238;
var LN2_LO5 = 19082149292705877e-26;
var LOG2_E = 1.4426950408889634;
var OVERFLOW = 709.782712893384;
var UNDERFLOW = -745.1332191019411;
var NEARZERO = 1 / (1 << 28);
var NEG_NEARZERO = -NEARZERO;
function exp(x) {
  var hi;
  var lo;
  var k;
  if (lib_default30(x) || x === lib_default43) {
    return x;
  }
  if (x === lib_default44) {
    return 0;
  }
  if (x > OVERFLOW) {
    return lib_default43;
  }
  if (x < UNDERFLOW) {
    return 0;
  }
  if (x > NEG_NEARZERO && x < NEARZERO) {
    return 1 + x;
  }
  if (x < 0) {
    k = lib_default137(LOG2_E * x - 0.5);
  } else {
    k = lib_default137(LOG2_E * x + 0.5);
  }
  hi = x - k * LN2_HI5;
  lo = k * LN2_LO5;
  return expmulti_default(hi, lo, k);
}
var main_default109 = exp;

var lib_default138 = main_default109;

var LOW6;
if (is_little_endian_default === true) {
  LOW6 = 0;
} else {
  LOW6 = 1;
}
var low_default2 = LOW6;

var FLOAT64_VIEW6 = new Float64Array(1);
var UINT32_VIEW10 = new Uint32Array(FLOAT64_VIEW6.buffer);
function setLowWord(x, low) {
  FLOAT64_VIEW6[0] = x;
  UINT32_VIEW10[low_default2] = low >>> 0;
  return FLOAT64_VIEW6[0];
}
var main_default110 = setLowWord;

var lib_default139 = main_default110;

function uint32ToInt32(x) {
  return x | 0;
}
var main_default111 = uint32ToInt32;

var lib_default140 = main_default111;

function pow(x, y) {
  if (y === lib_default44) {
    return lib_default43;
  }
  if (y === lib_default43) {
    return 0;
  }
  if (y > 0) {
    if (lib_default109(y)) {
      return x;
    }
    return 0;
  }
  if (lib_default109(y)) {
    return lib_default95(lib_default43, x);
  }
  return lib_default43;
}
var x_is_zero_default = pow;

var HIGH_MAX_NEAR_UNITY = 1072693247 | 0;
var HUGE5 = 1e300;
var TINY4 = 1e-300;
function pow2(x, y) {
  var ahx;
  var hx;
  hx = lib_default41(x);
  ahx = hx & lib_default92;
  if (ahx <= HIGH_MAX_NEAR_UNITY) {
    if (y < 0) {
      return HUGE5 * HUGE5;
    }
    return TINY4 * TINY4;
  }
  if (y > 0) {
    return HUGE5 * HUGE5;
  }
  return TINY4 * TINY4;
}
var y_is_huge_default = pow2;

function pow3(x, y) {
  if (x === -1) {
    return (x - x) / (x - x);
  }
  if (x === 1) {
    return 1;
  }
  if (lib_default(x) < 1 === (y === lib_default43)) {
    return 0;
  }
  return lib_default43;
}
var y_is_infinite_default = pow3;

var FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS = 20 | 0;
var lib_default141 = FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS;

function evalpoly24(x) {
  if (x === 0) {
    return 0.5999999999999946;
  }
  return 0.5999999999999946 + x * (0.4285714285785502 + x * (0.33333332981837743 + x * (0.272728123808534 + x * (0.23066074577556175 + x * 0.20697501780033842))));
}
var polyval_l_default = evalpoly24;

var HIGH_SIGNIFICAND_MASK2 = 1048575 | 0;
var HIGH_MIN_NORMAL_EXP2 = 1048576 | 0;
var HIGH_BIASED_EXP_02 = 1072693248 | 0;
var HIGH_BIASED_EXP_NEG_512 = 536870912 | 0;
var HIGH_SIGNIFICAND_HALF = 524288 | 0;
var TWO533 = 9007199254740992;
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
  var tmp7;
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
  var v3;
  var n;
  var j;
  var k;
  n = 0 | 0;
  if (ahx < HIGH_MIN_NORMAL_EXP2) {
    ax *= TWO533;
    n -= 53 | 0;
    ahx = lib_default41(ax);
  }
  n += (ahx >> lib_default141) - lib_default45 | 0;
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
  ax = lib_default42(ax, ahx);
  bp = BP[k];
  u = ax - bp;
  v3 = 1 / (ax + bp);
  ss = u * v3;
  hs = lib_default139(ss, 0);
  tmp7 = (ahx >> 1 | HIGH_BIASED_EXP_NEG_512) + HIGH_SIGNIFICAND_HALF;
  tmp7 += k << 18;
  ht = lib_default42(0, tmp7);
  lt = ax - (ht - bp);
  ls = v3 * (u - hs * ht - hs * lt);
  s2 = ss * ss;
  r = s2 * s2 * polyval_l_default(s2);
  r += ls * (hs + ss);
  s2 = hs * hs;
  ht = 3 + s2 + r;
  ht = lib_default139(ht, 0);
  lt = r - (ht - 3 - s2);
  u = hs * ht;
  v3 = ls * ht + lt * ss;
  hp = u + v3;
  hp = lib_default139(hp, 0);
  lp = v3 - (hp - u);
  hz = CP_HI * hp;
  lz = CP_LO * hp + lp * CP + DP_LO[k];
  dp = DP_HI[k];
  t = n;
  t1 = hz + lz + dp + t;
  t1 = lib_default139(t1, 0);
  t2 = lz - (t1 - t - dp - hz);
  out[0] = t1;
  out[1] = t2;
  return out;
}
var log2ax_default = log2ax;

function evalpoly25(x) {
  if (x === 0) {
    return 0.5;
  }
  return 0.5 + x * (-0.3333333333333333 + x * 0.25);
}
var polyval_w_default2 = evalpoly25;

var INV_LN2 = 1.4426950408889634;
var INV_LN2_HI = 1.4426950216293335;
var INV_LN2_LO = 19259629911266175e-24;
function logx(out, ax) {
  var t2;
  var t1;
  var t;
  var w;
  var u;
  var v3;
  t = ax - 1;
  w = t * t * polyval_w_default2(t);
  u = INV_LN2_HI * t;
  v3 = t * INV_LN2_LO - w * INV_LN2;
  t1 = u + v3;
  t1 = lib_default139(t1, 0);
  t2 = v3 - (t1 - u);
  out[0] = t1;
  out[1] = t2;
  return out;
}
var logx_default = logx;

function evalpoly26(x) {
  if (x === 0) {
    return 0.16666666666666602;
  }
  return 0.16666666666666602 + x * (-0.0027777777777015593 + x * (6613756321437934e-20 + x * (-16533902205465252e-22 + x * 41381367970572385e-24)));
}
var polyval_p_default5 = evalpoly26;

var HIGH_MIN_NORMAL_EXP3 = 1048576 | 0;
var HIGH_BIASED_EXP_NEG_1 = 1071644672 | 0;
var LN2_HI6 = 0.6931471824645996;
var LN2_LO6 = -1904654299957768e-24;
function pow22(j, hp, lp) {
  var tmp7;
  var t1;
  var t;
  var r;
  var u;
  var v3;
  var w;
  var z;
  var n;
  var i;
  var k;
  i = j & lib_default92 | 0;
  k = (i >> lib_default141) - lib_default45 | 0;
  n = 0;
  if (i > HIGH_BIASED_EXP_NEG_1) {
    n = j + (HIGH_MIN_NORMAL_EXP3 >> k + 1) >>> 0;
    k = ((n & lib_default92) >> lib_default141) - lib_default45 | 0;
    tmp7 = (n & ~(lib_default117 >> k)) >>> 0;
    t = lib_default42(0, tmp7);
    n = (n & lib_default117 | HIGH_MIN_NORMAL_EXP3) >> lib_default141 - k >>> 0;
    if (j < 0) {
      n = -n;
    }
    hp -= t;
  }
  t = lp + hp;
  t = lib_default139(t, 0);
  u = t * LN2_HI6;
  v3 = (lp - (t - hp)) * lib_default47 + t * LN2_LO6;
  z = u + v3;
  w = v3 - (z - u);
  t = z * z;
  t1 = z - t * polyval_p_default5(t);
  r = z * t1 / (t1 - 2) - (w + z * w);
  z = 1 - (r - z);
  j = lib_default41(z);
  j = lib_default140(j);
  j += n << lib_default141 >>> 0;
  if (j >> lib_default141 <= 0) {
    z = lib_default125(z, n);
  } else {
    z = lib_default42(z, j);
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
var HUGE6 = 1e300;
var TINY5 = 1e-300;
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
  var y12;
  var hp;
  var lp;
  var t;
  var z;
  var j;
  var i;
  if (lib_default30(x) || lib_default30(y)) {
    return NaN;
  }
  lib_default93.assign(y, WORDS3, 1, 0);
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
      return lib_default31(x);
    }
    if (y === -0.5) {
      return 1 / lib_default31(x);
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
    if (lib_default76(y)) {
      return y_is_infinite_default(x, y);
    }
  }
  lib_default93.assign(x, WORDS3, 1, 0);
  hx = WORDS3[0];
  lx = WORDS3[1];
  if (lx === 0) {
    if (hx === 0) {
      return x_is_zero_default(x, y);
    }
    if (x === 1) {
      return 1;
    }
    if (x === -1 && lib_default109(y)) {
      return -1;
    }
    if (lib_default76(x)) {
      if (x === lib_default44) {
        return pow4(-0, -y);
      }
      if (y < 0) {
        return 0;
      }
      return lib_default43;
    }
  }
  if (x < 0 && lib_default107(y) === false) {
    return (x - x) / (x - x);
  }
  ax = lib_default(x);
  ahx = hx & lib_default92 | 0;
  ahy = hy & lib_default92 | 0;
  sx = hx >>> HIGH_NUM_NONSIGN_BITS | 0;
  sy = hy >>> HIGH_NUM_NONSIGN_BITS | 0;
  if (sx && lib_default109(y)) {
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
        return sx * HUGE6 * HUGE6;
      }
      return sx * TINY5 * TINY5;
    }
    if (ahx > HIGH_BIASED_EXP_03) {
      if (sy === 0) {
        return sx * HUGE6 * HUGE6;
      }
      return sx * TINY5 * TINY5;
    }
    t = logx_default(LOG_WORKSPACE, ax);
  } else {
    t = log2ax_default(LOG_WORKSPACE, ax, ahx);
  }
  y12 = lib_default139(y, 0);
  lp = (y - y12) * t[0] + y * t[1];
  hp = y12 * t[0];
  z = lp + hp;
  lib_default93.assign(z, WORDS3, 1, 0);
  j = lib_default140(WORDS3[0]);
  i = lib_default140(WORDS3[1]);
  if (j >= HIGH_BIASED_EXP_10) {
    if ((j - HIGH_BIASED_EXP_10 | i) !== 0) {
      return sx * HUGE6 * HUGE6;
    }
    if (lp + OVT > z - hp) {
      return sx * HUGE6 * HUGE6;
    }
  } else if ((j & lib_default92) >= HIGH_1075) {
    if ((j - HIGH_NEG_1075 | i) !== 0) {
      return sx * TINY5 * TINY5;
    }
    if (lp <= z - hp) {
      return sx * TINY5 * TINY5;
    }
  }
  z = pow2_default(j, hp, lp);
  return sx * z;
}
var main_default112 = pow4;

var lib_default142 = main_default112;

var E = 2.718281828459045;
var lib_default143 = E;

var FLOAT64_EPSILON = 2220446049250313e-31;
var lib_default144 = FLOAT64_EPSILON;

function evalrational20(x) {
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
var lanczos_sum_expg_scaled_default = evalrational20;

var lanczosSumExpGScaled = lanczos_sum_expg_scaled_default;
var G = 10.900511;
function beta(a, b) {
  var ambh;
  var agh;
  var bgh;
  var cgh;
  var res;
  var tmp7;
  var c2;
  if (lib_default30(a) || lib_default30(b)) {
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
  if (c2 < lib_default144) {
    res = c2 / a;
    res /= b;
    return res;
  }
  if (c2 === a && b < lib_default144) {
    return 1 / b;
  }
  if (c2 === b && a < lib_default144) {
    return 1 / a;
  }
  if (a < b) {
    tmp7 = b;
    b = a;
    a = tmp7;
  }
  agh = a + G - 0.5;
  bgh = b + G - 0.5;
  cgh = c2 + G - 0.5;
  res = lanczosSumExpGScaled(a) * (lanczosSumExpGScaled(b) / lanczosSumExpGScaled(c2));
  ambh = a - 0.5 - b;
  if (lib_default(b * ambh) < cgh * 100 && a > 100) {
    res *= lib_default138(ambh * lib_default46(-b / cgh));
  } else {
    res *= lib_default142(agh / cgh, ambh);
  }
  if (cgh > 1e10) {
    res *= lib_default142(agh / cgh * (bgh / cgh), b);
  } else {
    res *= lib_default142(agh * bgh / (cgh * cgh), b);
  }
  res *= lib_default31(lib_default143 / bgh);
  return res;
}
var main_default113 = beta;

var lib_default145 = main_default113;

var HALF_LN2 = 0.34657359027997264;
var lib_default146 = HALF_LN2;

function evalpoly27(x) {
  if (x === 0) {
    return -0.03333333333333313;
  }
  return -0.03333333333333313 + x * (0.0015873015872548146 + x * (-793650757867488e-19 + x * (4008217827329362e-21 + x * -20109921818362437e-23)));
}
var polyval_q_default4 = evalpoly27;

var OVERFLOW_THRESHOLD = 709.782712893384;
var LN2_HI7 = 0.6931471803691238;
var LN2_LO7 = 19082149292705877e-26;
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
  if (x === lib_default43 || lib_default30(x)) {
    return x;
  }
  if (x === lib_default44) {
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
      return lib_default43;
    }
  }
  hx = lib_default41(y) | 0;
  if (y > lib_default146) {
    if (y < LN2_HALFX3) {
      if (sign) {
        hi = x + LN2_HI7;
        lo = -LN2_LO7;
        k = -1;
      } else {
        hi = x - LN2_HI7;
        lo = LN2_LO7;
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
      hi = x - t * LN2_HI7;
      lo = t * LN2_LO7;
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
  r1 = 1 + z * polyval_q_default4(z);
  t = 3 - r1 * halfX;
  e = z * ((r1 - t) / (6 - x * t));
  if (k === 0) {
    return x - (x * e - z);
  }
  twopk = lib_default94(lib_default45 + k << 20, 0);
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
      hi = lib_default41(y) + (k << 20) | 0;
      y = lib_default42(y, hi);
    } else {
      y *= twopk;
    }
    return y - 1;
  }
  t = 1;
  if (k < 20) {
    hi = 1072693248 - (2097152 >> k) | 0;
    t = lib_default42(t, hi);
    y = t - (e - x);
  } else {
    hi = lib_default45 - k << 20 | 0;
    t = lib_default42(t, hi);
    y = x - (e + t);
    y += 1;
  }
  y *= twopk;
  return y;
}
var main_default114 = expm1;

var lib_default147 = main_default114;

function isPositiveZero(x) {
  return x === 0 && 1 / x === lib_default43;
}
var main_default115 = isPositiveZero;

var lib_default148 = main_default115;

function max(x, y) {
  if (lib_default30(x) || lib_default30(y)) {
    return NaN;
  }
  if (x === lib_default43 || y === lib_default43) {
    return lib_default43;
  }
  if (x === y && x === 0) {
    if (lib_default148(x)) {
      return x;
    }
    return y;
  }
  if (x > y) {
    return x;
  }
  return y;
}
var main_default116 = max;

var lib_default149 = main_default116;

function isNegativeZero(x) {
  return x === 0 && 1 / x === lib_default44;
}
var main_default117 = isNegativeZero;

var lib_default150 = main_default117;

function min(x, y) {
  if (lib_default30(x) || lib_default30(y)) {
    return NaN;
  }
  if (x === lib_default44 || y === lib_default44) {
    return lib_default44;
  }
  if (x === y && x === 0) {
    if (lib_default150(x)) {
      return x;
    }
    return y;
  }
  if (x < y) {
    return x;
  }
  return y;
}
var main_default118 = min;

var lib_default151 = main_default118;

var FLOAT64_MAX = 17976931348623157e292;
var lib_default152 = FLOAT64_MAX;

var INT32_MAX = 2147483647 | 0;
var lib_default153 = INT32_MAX;

function evalpoly28(x) {
  if (x === 0) {
    return 0.0416666666666666;
  }
  return 0.0416666666666666 + x * (-0.001388888888887411 + x * 2480158728947673e-20);
}
var polyval_c13_default = evalpoly28;

function evalpoly29(x) {
  if (x === 0) {
    return -27557314351390663e-23;
  }
  return -27557314351390663e-23 + x * (2087572321298175e-24 + x * -11359647557788195e-27);
}
var polyval_c46_default = evalpoly29;

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
var main_default119 = kernelCos;

var lib_default154 = main_default119;

var S12 = -0.16666666666666632;
var S22 = 0.00833333333332249;
var S32 = -1984126982985795e-19;
var S42 = 27557313707070068e-22;
var S52 = -25050760253406863e-24;
var S62 = 158969099521155e-24;
function kernelSin(x, y) {
  var r;
  var v3;
  var w;
  var z;
  z = x * x;
  w = z * z;
  r = S22 + z * (S32 + z * S42) + z * w * (S52 + z * S62);
  v3 = z * x;
  if (y === 0) {
    return x + v3 * (S12 + z * r);
  }
  return x - (z * (0.5 * y - v3 * r) - y - v3 * S12);
}
var main_default120 = kernelSin;

var lib_default155 = main_default120;

var PIO4_HIGH_WORD3 = 1072243195 | 0;
var SMALL_HIGH_WORD2 = 1045430272 | 0;
var Y2 = [0, 0];
function sin(x) {
  var ix;
  var n;
  ix = lib_default41(x);
  ix &= lib_default92;
  if (ix <= PIO4_HIGH_WORD3) {
    if (ix < SMALL_HIGH_WORD2) {
      return x;
    }
    return lib_default155(x, 0);
  }
  if (ix >= lib_default116) {
    return NaN;
  }
  n = lib_default129(x, Y2);
  switch (n & 3) {
    case 0:
      return lib_default155(Y2[0], Y2[1]);
    case 1:
      return lib_default154(Y2[0], Y2[1]);
    case 2:
      return -lib_default155(Y2[0], Y2[1]);
    default:
      return -lib_default154(Y2[0], Y2[1]);
  }
}
var main_default121 = sin;

var lib_default156 = main_default121;

var SQRT_TWO_PI = 2.5066282746310007;
var lib_default157 = SQRT_TWO_PI;

function evalpoly30(x) {
  if (x === 0) {
    return 0.08333333333334822;
  }
  return 0.08333333333334822 + x * (0.0034722222160545866 + x * (-0.0026813261780578124 + x * (-22954996161337813e-20 + x * 7873113957930937e-19)));
}
var polyval_s_default2 = evalpoly30;

var MAX_STIRLING = 143.01608;
function gamma(x) {
  var w;
  var y;
  var v3;
  w = 1 / x;
  w = 1 + w * polyval_s_default2(w);
  y = lib_default138(x);
  if (x > MAX_STIRLING) {
    v3 = lib_default142(x, 0.5 * x - 0.25);
    y = v3 * (v3 / y);
  } else {
    y = lib_default142(x, x - 0.5) / y;
  }
  return lib_default157 * y * w;
}
var stirling_approximation_default = gamma;

var EULERGAMMA = 0.5772156649015329;
var lib_default158 = EULERGAMMA;

function gamma2(x, z) {
  return z / ((1 + lib_default158 * x) * x);
}
var small_approximation_default = gamma2;

function evalrational21(x) {
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
var rational_pq_default2 = evalrational21;

function gamma3(x) {
  var sign;
  var q;
  var p101;
  var z;
  if (lib_default107(x) && x < 0 || x === lib_default44 || lib_default30(x)) {
    return NaN;
  }
  if (x === 0) {
    if (lib_default150(x)) {
      return lib_default44;
    }
    return lib_default43;
  }
  if (x > 171.61447887182297) {
    return lib_default43;
  }
  if (x < -170.5674972726612) {
    return 0;
  }
  q = lib_default(x);
  if (q > 33) {
    if (x >= 0) {
      return stirling_approximation_default(x);
    }
    p101 = lib_default105(q);
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
    z = q * lib_default156(lib_default26 * z);
    return sign * lib_default26 / (lib_default(z) * stirling_approximation_default(q));
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
var main_default122 = gamma3;

var lib_default159 = main_default122;

var FLOAT64_MAX_NTH_FACTORIAL = 170 | 0;
var lib_default160 = FLOAT64_MAX_NTH_FACTORIAL;

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
  if (lib_default30(x)) {
    return NaN;
  }
  if (lib_default107(x)) {
    if (x < 0) {
      return NaN;
    }
    if (x <= lib_default160) {
      return factorials_default[x];
    }
    return lib_default43;
  }
  return lib_default159(x + 1);
}
var main_default123 = factorial;

var lib_default161 = main_default123;

function evalrational22(x) {
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
var rational_pq_default3 = evalrational22;

var main_default124 = rational_pq_default3;

var lib_default162 = main_default124;

var FLOAT64_GAMMA_LANCZOS_G = 10.900511;
var lib_default163 = FLOAT64_GAMMA_LANCZOS_G;

var FACTORIAL_169 = 4269068009004705e289;
function gammaDeltaRatioLanczos(z, delta) {
  var result;
  var ratio;
  var zgh;
  if (z < lib_default144) {
    if (delta >= lib_default160) {
      ratio = gammaDeltaRatioLanczos(delta, lib_default160 - delta);
      ratio *= z;
      ratio *= FACTORIAL_169;
      return 1 / ratio;
    }
    return 1 / (z * lib_default159(z + delta));
  }
  zgh = z + lib_default163 - 0.5;
  if (z + delta === z) {
    if (lib_default(delta / zgh) < lib_default144) {
      result = lib_default138(-delta);
    } else {
      result = 1;
    }
  } else {
    if (lib_default(delta) < 10) {
      result = lib_default138((0.5 - z) * lib_default46(delta / zgh));
    } else {
      result = lib_default142(zgh / (zgh + delta), z - 0.5);
    }
    result *= lib_default162(z) / lib_default162(z + delta);
  }
  result *= lib_default142(lib_default143 / (zgh + delta), delta);
  return result;
}
var gamma_delta_ratio_lanczos_default = gammaDeltaRatioLanczos;

function gammaDeltaRatio(z, delta) {
  var result;
  var idelta;
  var iz;
  if (z <= 0 || z + delta <= 0) {
    return lib_default159(z) / lib_default159(z + delta);
  }
  idelta = lib_default105(delta);
  if (idelta === delta) {
    iz = lib_default105(z);
    if (iz === z) {
      if (z <= lib_default160 && z + delta <= lib_default160) {
        return lib_default161(iz - 1) / lib_default161(idelta + iz - 1);
      }
    }
    if (lib_default(delta) < 20) {
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
var main_default125 = gammaDeltaRatio;

var lib_default164 = main_default125;

var buffer = [0, 0];
var HIGH_WORD_PIO4 = 1072243195 | 0;
var HIGH_WORD_TWO_NEG_27 = 1044381696 | 0;
function cos(x) {
  var ix;
  var n;
  ix = lib_default41(x);
  ix &= lib_default92;
  if (ix <= HIGH_WORD_PIO4) {
    if (ix < HIGH_WORD_TWO_NEG_27) {
      return 1;
    }
    return lib_default154(x, 0);
  }
  if (ix >= lib_default116) {
    return NaN;
  }
  n = lib_default129(x, buffer);
  switch (n & 3) {
    case 0:
      return lib_default154(buffer[0], buffer[1]);
    case 1:
      return -lib_default155(buffer[0], buffer[1]);
    case 2:
      return -lib_default154(buffer[0], buffer[1]);
    default:
      return lib_default155(buffer[0], buffer[1]);
  }
}
var main_default126 = cos;

var lib_default165 = main_default126;

function sinpi(x) {
  var ar;
  var r;
  if (lib_default30(x)) {
    return NaN;
  }
  if (lib_default76(x)) {
    return NaN;
  }
  r = x % 2;
  ar = lib_default(r);
  if (ar === 0 || ar === 1) {
    return lib_default95(0, r);
  }
  if (ar < 0.25) {
    return lib_default156(lib_default26 * r);
  }
  if (ar < 0.75) {
    ar = 0.5 - ar;
    return lib_default95(lib_default165(lib_default26 * ar), r);
  }
  if (ar < 1.25) {
    r = lib_default95(1, r) - r;
    return lib_default156(lib_default26 * r);
  }
  if (ar < 1.75) {
    ar -= 1.5;
    return -lib_default95(lib_default165(lib_default26 * ar), r);
  }
  r -= lib_default95(2, r);
  return lib_default156(lib_default26 * r);
}
var main_default127 = sinpi;

var lib_default166 = main_default127;

function evalpoly31(x) {
  if (x === 0) {
    return 0.06735230105312927;
  }
  return 0.06735230105312927 + x * (0.007385550860814029 + x * (0.0011927076318336207 + x * (22086279071390839e-20 + x * 25214456545125733e-21)));
}
var polyval_a1_default2 = evalpoly31;

function evalpoly32(x) {
  if (x === 0) {
    return 0.020580808432516733;
  }
  return 0.020580808432516733 + x * (0.0028905138367341563 + x * (5100697921535113e-19 + x * (10801156724758394e-20 + x * 44864094961891516e-21)));
}
var polyval_a2_default = evalpoly32;

function evalpoly33(x) {
  if (x === 0) {
    return 1.3920053346762105;
  }
  return 1.3920053346762105 + x * (0.7219355475671381 + x * (0.17193386563280308 + x * (0.01864591917156529 + x * (7779424963818936e-19 + x * 7326684307446256e-21))));
}
var polyval_r_default2 = evalpoly33;

function evalpoly34(x) {
  if (x === 0) {
    return 0.21498241596060885;
  }
  return 0.21498241596060885 + x * (0.325778796408931 + x * (0.14635047265246445 + x * (0.02664227030336386 + x * (0.0018402845140733772 + x * 3194753265841009e-20))));
}
var polyval_s_default3 = evalpoly34;

function evalpoly35(x) {
  if (x === 0) {
    return -0.032788541075985965;
  }
  return -0.032788541075985965 + x * (0.006100538702462913 + x * (-0.0014034646998923284 + x * 31563207090362595e-20));
}
var polyval_t1_default = evalpoly35;

function evalpoly36(x) {
  if (x === 0) {
    return 0.01797067508118204;
  }
  return 0.01797067508118204 + x * (-0.0036845201678113826 + x * (881081882437654e-18 + x * -31275416837512086e-20));
}
var polyval_t2_default2 = evalpoly36;

function evalpoly37(x) {
  if (x === 0) {
    return -0.010314224129834144;
  }
  return -0.010314224129834144 + x * (0.0022596478090061247 + x * (-5385953053567405e-19 + x * 3355291926355191e-19));
}
var polyval_t3_default = evalpoly37;

function evalpoly38(x) {
  if (x === 0) {
    return 0.6328270640250934;
  }
  return 0.6328270640250934 + x * (1.4549225013723477 + x * (0.9777175279633727 + x * (0.22896372806469245 + x * 0.013381091853678766)));
}
var polyval_u_default2 = evalpoly38;

function evalpoly39(x) {
  if (x === 0) {
    return 2.4559779371304113;
  }
  return 2.4559779371304113 + x * (2.128489763798934 + x * (0.7692851504566728 + x * (0.10422264559336913 + x * 0.003217092422824239)));
}
var polyval_v_default2 = evalpoly39;

function evalpoly40(x) {
  if (x === 0) {
    return 0.08333333333333297;
  }
  return 0.08333333333333297 + x * (-0.0027777777772877554 + x * (7936505586430196e-19 + x * (-59518755745034e-17 + x * (8363399189962821e-19 + x * -0.0016309293409657527))));
}
var polyval_w_default3 = evalpoly40;

var A1C = 0.07721566490153287;
var A2C = 0.3224670334241136;
var RC = 1;
var SC = -0.07721566490153287;
var T1C2 = 0.48383612272381005;
var T2C = -0.1475877229945939;
var T3C = 0.06462494023913339;
var UC = -0.07721566490153287;
var VC = 1;
var WC = 0.4189385332046727;
var YMIN2 = 1.4616321449683622;
var TWO52 = 4503599627370496;
var TWO56 = 72057594037927940;
var TINY6 = 13877787807814457e-33;
var TC = 1.4616321449683622;
var TF2 = -0.12148629053584961;
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
  if (lib_default30(x) || lib_default76(x)) {
    return x;
  }
  if (x === 0) {
    return lib_default43;
  }
  if (x < 0) {
    isNegative = true;
    x = -x;
  } else {
    isNegative = false;
  }
  if (x < TINY6) {
    return -lib_default48(x);
  }
  if (isNegative) {
    if (x >= TWO52) {
      return lib_default43;
    }
    t = lib_default166(x);
    if (t === 0) {
      return lib_default43;
    }
    nadj = lib_default48(lib_default26 / lib_default(t * x));
  }
  if (x === 1 || x === 2) {
    return 0;
  }
  if (x < 2) {
    if (x <= 0.9) {
      r = -lib_default48(x);
      if (x >= YMIN2 - 1 + 0.27) {
        y = 1 - x;
        flg = 0;
      } else if (x >= YMIN2 - 1 - 0.27) {
        y = x - (TC - 1);
        flg = 1;
      } else {
        y = x;
        flg = 2;
      }
    } else {
      r = 0;
      if (x >= YMIN2 + 0.27) {
        y = 2 - x;
        flg = 0;
      } else if (x >= YMIN2 - 0.27) {
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
        p110 = A1C + z * polyval_a1_default2(z);
        p210 = z * (A2C + z * polyval_a2_default(z));
        p101 = y * p110 + p210;
        r += p101 - 0.5 * y;
        break;
      case 1:
        z = y * y;
        w = z * y;
        p110 = T1C2 + w * polyval_t1_default(w);
        p210 = T2C + w * polyval_t2_default2(w);
        p310 = T3C + w * polyval_t3_default(w);
        p101 = z * p110 - (TT - w * (p210 + y * p310));
        r += TF2 + p101;
        break;
      case 2:
        p110 = y * (UC + y * polyval_u_default2(y));
        p210 = VC + y * polyval_v_default2(y);
        r += -0.5 * y + p110 / p210;
        break;
    }
  } else if (x < 8) {
    flg = lib_default137(x);
    y = x - flg;
    p101 = y * (SC + y * polyval_s_default3(y));
    q = RC + y * polyval_r_default2(y);
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
        r += lib_default48(z);
    }
  } else if (x < TWO56) {
    t = lib_default48(x);
    z = 1 / x;
    y = z * z;
    w = WC + z * polyval_w_default3(y);
    r = (x - 0.5) * (t - 1) + w;
  } else {
    r = x * (lib_default48(x) - 1);
  }
  if (isNegative) {
    r = nadj - r;
  }
  return r;
}
var main_default128 = gammaln;

var lib_default167 = main_default128;

var FLOAT64_MAX_LN = 709.782712893384;
var lib_default168 = FLOAT64_MAX_LN;

var FLOAT64_SQRT_EPSILON = 14901161193847656e-24;
var lib_default169 = FLOAT64_SQRT_EPSILON;

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
  tolerance = opts2.tolerance || lib_default144;
  counter = opts2.maxTerms || MAX_TERMS;
  result = opts2.initialValue || 0;
  isgenerator = typeof generator.next === "function";
  if (isgenerator === true) {
    for (nextTerm of generator) {
      result += nextTerm;
      if (lib_default(tolerance * result) >= lib_default(nextTerm) || --counter === 0) {
        break;
      }
    }
  } else {
    do {
      nextTerm = generator();
      result += nextTerm;
    } while (lib_default(tolerance * result) < lib_default(nextTerm) && --counter);
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
  tolerance = opts2.tolerance || lib_default144;
  counter = opts2.maxTerms || MAX_TERMS2;
  result = opts2.initialValue || 0;
  do {
    nextTerm = generator();
    result += nextTerm;
  } while (lib_default(tolerance * result) < lib_default(nextTerm) && --counter);
  return result;
}
var basic_default = sumSeries2;

var sumSeries3;
if (has_generator_support_default()) {
  sumSeries3 = generators_default;
} else {
  sumSeries3 = basic_default;
}
var lib_default170 = sumSeries3;

function tgammaILargeXSeries(a1, x16) {
  var result = 1;
  var a = a1;
  var x = x16;
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
  result = lib_default170(s);
  return result;
}
var tgamma_i_large_x_default = tgammaILargeX;

function finiteGammaQ(a, x) {
  var term;
  var sum;
  var e;
  var n;
  e = lib_default138(-x);
  sum = e;
  if (sum !== 0) {
    term = sum;
    for (n = 1; n < a; ++n) {
      term /= n;
      term *= x;
      sum += term;
    }
  }
  return sum;
}
var finite_gamma_q_default = finiteGammaQ;

function evalpoly41(x) {
  if (x === 0) {
    return -0.3250421072470015;
  }
  return -0.3250421072470015 + x * (-0.02848174957559851 + x * (-0.005770270296489442 + x * -23763016656650163e-21));
}
var polyval_pp_default = evalpoly41;

function evalpoly42(x) {
  if (x === 0) {
    return 0.39791722395915535;
  }
  return 0.39791722395915535 + x * (0.0650222499887673 + x * (0.005081306281875766 + x * (13249473800432164e-20 + x * -3960228278775368e-21)));
}
var polyval_qq_default = evalpoly42;

function evalpoly43(x) {
  if (x === 0) {
    return 0.41485611868374833;
  }
  return 0.41485611868374833 + x * (-0.3722078760357013 + x * (0.31834661990116175 + x * (-0.11089469428239668 + x * (0.035478304325618236 + x * -0.002166375594868791))));
}
var polyval_pa_default = evalpoly43;

function evalpoly44(x) {
  if (x === 0) {
    return 0.10642088040084423;
  }
  return 0.10642088040084423 + x * (0.540397917702171 + x * (0.07182865441419627 + x * (0.12617121980876164 + x * (0.01363708391202905 + x * 0.011984499846799107))));
}
var polyval_qa_default = evalpoly44;

function evalpoly45(x) {
  if (x === 0) {
    return -0.6938585727071818;
  }
  return -0.6938585727071818 + x * (-10.558626225323291 + x * (-62.375332450326006 + x * (-162.39666946257347 + x * (-184.60509290671104 + x * (-81.2874355063066 + x * -9.814329344169145)))));
}
var polyval_ra_default = evalpoly45;

function evalpoly46(x) {
  if (x === 0) {
    return 19.651271667439257;
  }
  return 19.651271667439257 + x * (137.65775414351904 + x * (434.56587747522923 + x * (645.3872717332679 + x * (429.00814002756783 + x * (108.63500554177944 + x * (6.570249770319282 + x * -0.0604244152148581))))));
}
var polyval_sa_default = evalpoly46;

function evalpoly47(x) {
  if (x === 0) {
    return -0.799283237680523;
  }
  return -0.799283237680523 + x * (-17.757954917754752 + x * (-160.63638485582192 + x * (-637.5664433683896 + x * (-1025.0951316110772 + x * -483.5191916086514))));
}
var polyval_rb_default = evalpoly47;

function evalpoly48(x) {
  if (x === 0) {
    return 30.33806074348246;
  }
  return 30.33806074348246 + x * (325.7925129965739 + x * (1536.729586084437 + x * (3199.8582195085955 + x * (2553.0504064331644 + x * (474.52854120695537 + x * -22.44095244658582)))));
}
var polyval_sb_default = evalpoly48;

var TINY7 = 1e-300;
var SMALL3 = 13877787807814457e-33;
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
  if (lib_default30(x)) {
    return NaN;
  }
  if (x === lib_default43) {
    return 0;
  }
  if (x === lib_default44) {
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
    if (ax < SMALL3) {
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
        return 2 - TINY7;
      }
      r = RBC + s * polyval_rb_default(s);
      s = SBC + s * polyval_sb_default(s);
    }
    z = lib_default139(ax, 0);
    r = lib_default138(-(z * z) - 0.5625) * lib_default138((z - ax) * (z + ax) + r / s);
    if (sign) {
      return 2 - r / ax;
    }
    return r / ax;
  }
  if (sign) {
    return 2 - TINY7;
  }
  return TINY7 * TINY7;
}
var main_default129 = erfc;

var lib_default171 = main_default129;

function finiteHalfGammaQ(a, x) {
  var half;
  var term;
  var sum;
  var e;
  var n;
  e = lib_default171(lib_default31(x));
  if (e !== 0 && a > 1) {
    term = lib_default138(-x) / lib_default31(lib_default26 * x);
    term *= x;
    half = 0.5;
    term /= half;
    sum = term;
    for (n = 2; n < a; ++n) {
      term /= n - half;
      term *= x;
      sum += term;
    }
    e += sum;
  }
  return e;
}
var finite_half_gamma_q_default = finiteHalfGammaQ;

var FLOAT64_MIN_LN = -708.3964185322641;
var lib_default172 = FLOAT64_MIN_LN;

function fullIGammaPrefix(a, z) {
  var prefix;
  var alz;
  alz = a * lib_default48(z);
  if (z >= 1) {
    if (alz < lib_default168 && -z > lib_default172) {
      prefix = lib_default142(z, a) * lib_default138(-z);
    } else if (a >= 1) {
      prefix = lib_default142(z / lib_default138(z / a), a);
    } else {
      prefix = lib_default138(alz - z);
    }
  } else {
    if (alz > lib_default172) {
      prefix = lib_default142(z, a) * lib_default138(-z);
    } else if (z / a < lib_default168) {
      prefix = lib_default142(z / lib_default138(z / a), a);
    } else {
      prefix = lib_default138(alz - z);
    }
  }
  return prefix;
}
var full_igamma_prefix_default = fullIGammaPrefix;

function evalpoly49(c2, x) {
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
var main_default130 = evalpoly49;

var Fcn = Function;
var main_default131 = Fcn;

var lib_default173 = main_default131;

function factory(c2) {
  var f;
  var n;
  var m;
  var i;
  if (c2.length > 500) {
    return polyval;
  }
  f = "return function evalpoly(x){";
  n = c2.length;
  if (n === 0) {
    f += "return 0.0;";
  } else if (n === 1) {
    f += "return " + c2[0] + ";";
  } else {
    f += "if(x===0.0){return " + c2[0] + ";}";
    f += "return " + c2[0];
    m = n - 1;
    for (i = 1; i < n; i++) {
      f += "+x*";
      if (i < m) {
        f += "(";
      }
      f += c2[i];
    }
    for (i = 0; i < m - 1; i++) {
      f += ")";
    }
    f += ";";
  }
  f += "}";
  f += "//# sourceURL=evalpoly.factory.js";
  return new lib_default173(f)();
  function polyval(x) {
    return main_default130(c2, x);
  }
}
var factory_default = factory;

main_default130.factory = factory_default;
var lib_default174 = main_default130;

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
  ax = lib_default(x);
  if (ax > 0.95) {
    return lib_default48(1 + x) - x;
  }
  if (ax < lib_default144) {
    return -x * x / 2;
  }
  opts2 = {
    "initialValue": -x
  };
  return lib_default170(log1p_series_default(x), opts2);
}
var main_default132 = log1pmx;

var lib_default175 = main_default132;

var TWO_PI = 6.283185307179586;
var lib_default176 = TWO_PI;

function evalpoly50(x) {
  if (x === 0) {
    return -0.3333333333333333;
  }
  return -0.3333333333333333 + x * (0.08333333333333333 + x * (-0.014814814814814815 + x * (0.0011574074074074073 + x * (3527336860670194e-19 + x * (-1787551440329218e-19 + x * (3919263178522438e-20 + x * (-21854485106799924e-22 + x * (-185406221071516e-20 + x * (8296711340953087e-22 + x * (-17665952736826078e-23 + x * (6707853543401498e-24 + x * (10261809784240309e-24 + x * (-4382036018453353e-24 + x * 914769958223679e-24)))))))))))));
}
var polyval_c0_default = evalpoly50;

function evalpoly51(x) {
  if (x === 0) {
    return -0.001851851851851852;
  }
  return -0.001851851851851852 + x * (-0.003472222222222222 + x * (0.0026455026455026454 + x * (-9902263374485596e-19 + x * (20576131687242798e-20 + x * (-4018775720164609e-22 + x * (-18098550334489977e-21 + x * (764916091608111e-20 + x * (-16120900894563446e-22 + x * (4647127802807434e-24 + x * (1378633446915721e-22 + x * (-5752545603517705e-23 + x * 11951628599778148e-24)))))))))));
}
var polyval_c1_default = evalpoly51;

function evalpoly52(x) {
  if (x === 0) {
    return 0.004133597883597883;
  }
  return 0.004133597883597883 + x * (-0.0026813271604938273 + x * (7716049382716049e-19 + x * (20093878600823047e-22 + x * (-10736653226365161e-20 + x * (52923448829120125e-21 + x * (-12760635188618728e-21 + x * (3423578734096138e-23 + x * (13721957309062932e-22 + x * (-6298992138380055e-22 + x * 14280614206064242e-23)))))))));
}
var polyval_c2_default = evalpoly52;

function evalpoly53(x) {
  if (x === 0) {
    return 6494341563786008e-19;
  }
  return 6494341563786008e-19 + x * (22947209362139917e-20 + x * (-4691894943952557e-19 + x * (26772063206283885e-20 + x * (-7561801671883977e-20 + x * (-2396505113867297e-22 + x * (11082654115347302e-21 + x * (-56749528269915965e-22 + x * 14230900732435883e-22)))))));
}
var polyval_c3_default = evalpoly53;

function evalpoly54(x) {
  if (x === 0) {
    return -8618882909167117e-19;
  }
  return -8618882909167117e-19 + x * (7840392217200666e-19 + x * (-2990724803031902e-19 + x * (-14638452578843418e-22 + x * (6641498215465122e-20 + x * (-3968365047179435e-20 + x * 11375726970678419e-21)))));
}
var polyval_c4_default = evalpoly54;

function evalpoly55(x) {
  if (x === 0) {
    return -33679855336635813e-20;
  }
  return -33679855336635813e-20 + x * (-6972813758365858e-20 + x * (2772753244959392e-19 + x * (-19932570516188847e-20 + x * (6797780477937208e-20 + x * (1419062920643967e-22 + x * (-13594048189768693e-21 + x * (8018470256334202e-21 + x * -2291481176508095e-21)))))));
}
var polyval_c5_default = evalpoly55;

function evalpoly56(x) {
  if (x === 0) {
    return 5313079364639922e-19;
  }
  return 5313079364639922e-19 + x * (-5921664373536939e-19 + x * (2708782096718045e-19 + x * (7902353232660328e-22 + x * (-8153969367561969e-20 + x * (561168275310625e-19 + x * -18329116582843375e-21)))));
}
var polyval_c6_default = evalpoly56;

function evalpoly57(x) {
  if (x === 0) {
    return 34436760689237765e-20;
  }
  return 34436760689237765e-20 + x * (5171790908260592e-20 + x * (-33493161081142234e-20 + x * (2812695154763237e-19 + x * -10976582244684731e-20)));
}
var polyval_c7_default = evalpoly57;

function evalpoly58(x) {
  if (x === 0) {
    return -6526239185953094e-19;
  }
  return -6526239185953094e-19 + x * (8394987206720873e-19 + x * -438297098541721e-18);
}
var polyval_c8_default = evalpoly58;

var workspace = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
function igammaTemmeLarge(a, x) {
  var result;
  var sigma;
  var phi;
  var y;
  var z;
  sigma = (x - a) / a;
  phi = -lib_default175(sigma);
  y = a * phi;
  z = lib_default31(2 * phi);
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
  result = lib_default174(workspace, 1 / a);
  result *= lib_default138(-y) / lib_default31(lib_default176 * a);
  if (x < a) {
    result = -result;
  }
  result += lib_default171(lib_default31(y)) / 2;
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
  result = lib_default170(s, {
    "initialValue": initialValue
  });
  return result;
}
var lower_gamma_series_default = lowerGammaSeries;

function evalrational23(x) {
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
var rational_pq_default4 = evalrational23;

var main_default133 = rational_pq_default4;

var lib_default177 = main_default133;

function regularisedGammaPrefix(a, z) {
  var prefix;
  var amza;
  var agh;
  var alz;
  var amz;
  var sq;
  var d2;
  agh = a + lib_default163 - 0.5;
  d2 = (z - a - lib_default163 + 0.5) / agh;
  if (a < 1) {
    if (z <= lib_default172 || a < 1 / lib_default152) {
      return lib_default138(a * lib_default48(z) - z - lib_default167(a));
    }
    return lib_default142(z, a) * lib_default138(-z) / lib_default159(a);
  }
  if (lib_default(d2 * d2 * a) <= 100 && a > 150) {
    prefix = a * lib_default175(d2) + z * (0.5 - lib_default163) / agh;
    prefix = lib_default138(prefix);
  } else {
    alz = a * lib_default48(z / agh);
    amz = a - z;
    if (lib_default151(alz, amz) <= lib_default172 || lib_default149(alz, amz) >= lib_default168) {
      amza = amz / a;
      if (lib_default151(alz, amz) / 2 > lib_default172 && lib_default149(alz, amz) / 2 < lib_default168) {
        sq = lib_default142(z / agh, a / 2) * lib_default138(amz / 2);
        prefix = sq * sq;
      } else if (lib_default151(alz, amz) / 4 > lib_default172 && lib_default149(alz, amz) / 4 < lib_default168 && z > a) {
        sq = lib_default142(z / agh, a / 4) * lib_default138(amz / 4);
        prefix = sq * sq;
        prefix *= prefix;
      } else if (amza > lib_default172 && amza < lib_default168) {
        prefix = lib_default142(z * lib_default138(amza) / agh, a);
      } else {
        prefix = lib_default138(alz + amz);
      }
    } else {
      prefix = lib_default142(z / agh, a) * lib_default138(amz);
    }
  }
  prefix *= lib_default31(agh / lib_default143) / lib_default177(a);
  return prefix;
}
var regularised_gamma_prefix_default = regularisedGammaPrefix;

function powm1(b, x) {
  var result;
  var y;
  if (lib_default30(b) || lib_default30(x)) {
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
    if (lib_default(x * (b - 1)) < 0.5 || lib_default(x) < 0.2) {
      y = lib_default48(b) * x;
      if (y < 0.5) {
        return lib_default147(y);
      }
    }
  } else if (lib_default137(x) !== x) {
    return NaN;
  }
  result = lib_default142(b, x) - 1;
  if (lib_default76(result) || lib_default30(result)) {
    return NaN;
  }
  return result;
}
var main_default134 = powm1;

var lib_default178 = main_default134;

function evalrational24(x) {
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
var rational_p1q1_default5 = evalrational24;

function evalrational25(x) {
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
var rational_p2q2_default5 = evalrational25;

function evalrational26(x) {
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
var rational_p3q3_default2 = evalrational26;

var Y1 = 0.15896368026733398;
var Y22 = 0.5281534194946289;
var Y3 = 0.45201730728149414;
function lgammaSmallImp(z, zm1, zm2) {
  var prefix;
  var result;
  var r;
  var R;
  if (z < lib_default144) {
    return -lib_default48(z);
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
        result += lib_default48(z);
      } while (z >= 3);
      zm2 = z - 2;
    }
    r = zm2 * (z + 1);
    R = rational_p1q1_default5(zm2);
    result += r * Y1 + r * R;
    return result;
  }
  if (z < 1) {
    result += -lib_default48(z);
    zm2 = zm1;
    zm1 = z;
    z += 1;
  }
  if (z <= 1.5) {
    r = rational_p2q2_default5(zm1);
    prefix = zm1 * zm2;
    result += prefix * Y22 + prefix * r;
    return result;
  }
  r = zm2 * zm1;
  R = rational_p3q3_default2(-zm2);
  result += r * Y3 + r * R;
  return result;
}
var lgamma_small_imp_default = lgammaSmallImp;

function gamma1pm1(x) {
  if (lib_default30(x)) {
    return NaN;
  }
  if (x < 0) {
    if (x < -0.5) {
      return lib_default159(1 + x) - 1;
    }
    return lib_default147(-lib_default46(x) + lgamma_small_imp_default(x + 2, x + 1, x));
  }
  if (x < 2) {
    return lib_default147(lgamma_small_imp_default(x + 1, x, x - 1));
  }
  return lib_default159(1 + x) - 1;
}
var main_default135 = gamma1pm1;

var lib_default179 = main_default135;

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
  result = lib_default179(a);
  pgam = (result + 1) / a;
  p101 = lib_default178(x, a);
  result -= p101;
  result /= a;
  s = small_gamma2_series_default(a, x);
  p101 += 1;
  initialValue = invert ? pgam : 0;
  result = -p101 * lib_default170(s, {
    "initialValue": (initialValue - result) / p101
  });
  if (invert) {
    result = -result;
  }
  return [result, pgam];
}
var tgamma_small_upper_part_default = tgammaSmallUpperPart;

var FLOAT32_SMALLEST_NORMAL = 11754943508222875e-54;
var lib_default180 = FLOAT32_SMALLEST_NORMAL;

var MAX_ITER = 1e6;
function continuedFractionA(gen, factor, maxIter) {
  var isgenerator;
  var delta;
  var a0;
  var f;
  var C7;
  var D;
  var v3;
  isgenerator = typeof gen.next === "function";
  v3 = isgenerator ? gen.next().value : gen();
  f = v3[1];
  a0 = v3[0];
  if (f === 0) {
    f = lib_default180;
  }
  C7 = f;
  D = 0;
  if (isgenerator === true) {
    do {
      v3 = gen.next().value;
      if (v3) {
        D = v3[1] + v3[0] * D;
        if (D === 0) {
          D = lib_default180;
        }
        C7 = v3[1] + v3[0] / C7;
        if (C7 === 0) {
          C7 = lib_default180;
        }
        D = 1 / D;
        delta = C7 * D;
        f *= delta;
      }
    } while (lib_default(delta - 1) > factor && --maxIter);
  } else {
    do {
      v3 = gen();
      if (v3) {
        D = v3[1] + v3[0] * D;
        if (D === 0) {
          D = lib_default180;
        }
        C7 = v3[1] + v3[0] / C7;
        if (C7 === 0) {
          C7 = lib_default180;
        }
        D = 1 / D;
        delta = C7 * D;
        f *= delta;
      }
    } while (v3 && lib_default(delta - 1) > factor && --maxIter);
  }
  return a0 / f;
}
function continuedFractionB(gen, factor, maxIter) {
  var isgenerator;
  var delta;
  var f;
  var C7;
  var D;
  var v3;
  isgenerator = typeof gen.next === "function";
  v3 = isgenerator ? gen.next().value : gen();
  f = v3[1];
  if (f === 0) {
    f = lib_default180;
  }
  C7 = f;
  D = 0;
  if (isgenerator === true) {
    do {
      v3 = gen.next().value;
      if (v3) {
        D = v3[1] + v3[0] * D;
        if (D === 0) {
          D = lib_default180;
        }
        C7 = v3[1] + v3[0] / C7;
        if (C7 === 0) {
          C7 = lib_default180;
        }
        D = 1 / D;
        delta = C7 * D;
        f *= delta;
      }
    } while (v3 && lib_default(delta - 1) > factor && --maxIter);
  } else {
    do {
      v3 = gen();
      if (v3) {
        D = v3[1] + v3[0] * D;
        if (D === 0) {
          D = lib_default180;
        }
        C7 = v3[1] + v3[0] / C7;
        if (C7 === 0) {
          C7 = lib_default180;
        }
        D = 1 / D;
        delta = C7 * D;
        f *= delta;
      }
    } while (v3 && lib_default(delta - 1) > factor && --maxIter);
  }
  return f;
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
  eps = opts2.tolerance || lib_default144;
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
  var C7;
  var D;
  var f;
  var v3;
  v3 = gen();
  f = v3[1];
  a0 = v3[0];
  if (f === 0) {
    f = lib_default180;
  }
  C7 = f;
  D = 0;
  do {
    v3 = gen();
    if (v3) {
      D = v3[1] + v3[0] * D;
      if (D === 0) {
        D = lib_default180;
      }
      C7 = v3[1] + v3[0] / C7;
      if (C7 === 0) {
        C7 = lib_default180;
      }
      D = 1 / D;
      delta = C7 * D;
      f *= delta;
    }
  } while (v3 && lib_default(delta - 1) > factor && --maxIter);
  return a0 / f;
}
function continuedFractionB2(gen, factor, maxIter) {
  var delta;
  var C7;
  var D;
  var f;
  var v3;
  v3 = gen();
  f = v3[1];
  if (f === 0) {
    f = lib_default180;
  }
  C7 = f;
  D = 0;
  do {
    v3 = gen();
    if (v3) {
      D = v3[1] + v3[0] * D;
      if (D === 0) {
        D = lib_default180;
      }
      C7 = v3[1] + v3[0] / C7;
      if (C7 === 0) {
        C7 = lib_default180;
      }
      D = 1 / D;
      delta = C7 * D;
      f *= delta;
    }
  } while (v3 && lib_default(delta - 1) > factor && --maxIter);
  return f;
}
function continuedFraction2(generator, options) {
  var maxIter;
  var opts2;
  var eps;
  opts2 = {};
  if (arguments.length > 1) {
    opts2 = options;
  }
  eps = opts2.tolerance || lib_default144;
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
var lib_default181 = continuedFraction3;

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
  var f = upper_incomplete_gamma_fract_default(a, z);
  return 1 / (z - a + 1 + lib_default181(f));
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
  isSmallA = a < 30 && a <= x + 1 && x < lib_default168;
  if (isSmallA) {
    fa = lib_default105(a);
    isInt = fa === a;
    isHalfInt = isInt ? false : lib_default(fa - a) === 0.5;
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
  } else if (x < lib_default169 && a > 1) {
    evalMethod = 6;
  } else if (x > 1e3 && (a < x || lib_default(a - 50) / x < 1)) {
    invert = !invert;
    evalMethod = 7;
  } else if (x < 0.5) {
    if (-0.4 / lib_default48(x) < a) {
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
      sigma = lib_default((x - a) / a);
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
        result *= lib_default159(a);
      }
      break;
    case 1:
      result = finite_half_gamma_q_default(a, x);
      if (regularized === false) {
        result *= lib_default159(a);
      }
      break;
    case 2:
      result = regularized ? regularised_gamma_prefix_default(a, x) : full_igamma_prefix_default(a, x);
      if (result !== 0) {
        initValue = 0;
        optimisedInvert = false;
        if (invert) {
          initValue = regularized ? 1 : lib_default159(a);
          if (regularized || result >= 1 || lib_default152 * result > initValue) {
            initValue /= result;
            if (regularized || a < 1 || lib_default152 / a > initValue) {
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
      result = regularized ? lib_default142(x, a) / lib_default159(a + 1) : lib_default142(x, a) / a;
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
    gam = regularized ? 1 : lib_default159(a);
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
  if (a >= lib_default160 && !normalized) {
    if (invert && a * 4 < x) {
      result = a * lib_default48(x) - x;
      result += lib_default48(upper_gamma_fraction_default(a, x));
    } else if (!invert && a > 4 * x) {
      result = a * lib_default48(x) - x;
      initValue = 0;
      result += lib_default48(lower_gamma_series_default(a, x, initValue) / a);
    } else {
      result = igamma_final_default(x, a, true, invert);
      if (result === 0) {
        if (invert) {
          result = 1 + 1 / (12 * a) + 1 / (288 * a * a);
          result = lib_default48(result) - a + (a - 0.5) * lib_default48(a);
          result += lib_default48(lib_default157);
        } else {
          result = a * lib_default48(x) - x;
          initValue = 0;
          result += lib_default48(lower_gamma_series_default(a, x, initValue) / a);
        }
      } else {
        result = lib_default48(result) + lib_default167(a);
      }
    }
    if (result > lib_default168) {
      return lib_default43;
    }
    return lib_default138(result);
  }
  return igamma_final_default(x, a, normalized, invert);
}
var main_default136 = gammainc;

var lib_default182 = main_default136;

function fullIGammaPrefix2(a, z) {
  var prefix;
  var alz;
  alz = a * lib_default48(z);
  if (z >= 1) {
    if (alz < lib_default168 && -z > lib_default172) {
      prefix = lib_default142(z, a) * lib_default138(-z);
    } else if (a >= 1) {
      prefix = lib_default142(z / lib_default138(z / a), a);
    } else {
      prefix = lib_default138(alz - z);
    }
  } else if (alz > lib_default172) {
    prefix = lib_default142(z, a) * lib_default138(-z);
  } else if (z / a < lib_default168) {
    prefix = lib_default142(z / lib_default138(z / a), a);
  } else {
    prefix = lib_default138(alz - z);
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
  agh = a + lib_default163 - 0.5;
  d2 = (z - a - lib_default163 + 0.5) / agh;
  if (a < 1) {
    if (z <= lib_default172) {
      return lib_default138(a * lib_default48(z) - z - lib_default167(a));
    }
    return lib_default142(z, a) * lib_default138(-z) / lib_default159(a);
  }
  if (lib_default(d2 * d2 * a) <= 100 && a > 150) {
    prefix = a * (lib_default46(d2) - d2) + z * (0.5 - lib_default163) / agh;
    prefix = lib_default138(prefix);
  } else {
    alz = a * lib_default48(z / agh);
    amz = a - z;
    if (lib_default151(alz, amz) <= lib_default172 || lib_default149(alz, amz) >= lib_default168) {
      amza = amz / a;
      if (lib_default151(alz, amz) / 2 > lib_default172 && lib_default149(alz, amz) / 2 < lib_default168) {
        sq = lib_default142(z / agh, a / 2) * lib_default138(amz / 2);
        prefix = sq * sq;
      } else if (lib_default151(alz, amz) / 4 > lib_default172 && lib_default149(alz, amz) / 4 < lib_default168 && z > a) {
        sq = lib_default142(z / agh, a / 4) * lib_default138(amz / 4);
        prefix = sq * sq;
        prefix *= prefix;
      } else if (amza > lib_default172 && amza < lib_default168) {
        prefix = lib_default142(z * lib_default138(amza) / agh, a);
      } else {
        prefix = lib_default138(alz + amz);
      }
    } else {
      prefix = lib_default142(z / agh, a) * lib_default138(amz);
    }
  }
  prefix *= lib_default31(agh / lib_default143) / lib_default177(a);
  return prefix;
}
var regularized_gamma_prefix_default = regularizedGammaPrefix;

var p = new Array(30);
function betaSmallBLargeASeries(a, b, x, y, s0, mult, normalized) {
  var prefix;
  var tmp1;
  var tnp1;
  var sum;
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
    lx = lib_default46(-y);
  } else {
    lx = lib_default48(x);
  }
  u = -t * lx;
  h = regularized_gamma_prefix_default(b, u);
  if (h <= lib_default123) {
    return s0;
  }
  if (normalized) {
    prefix = h / lib_default164(a, b);
    prefix /= lib_default142(t, b);
  } else {
    prefix = full_igamma_prefix_default2(b, u) / lib_default142(t, b);
  }
  prefix *= mult;
  p[0] = 1;
  j = lib_default182(u, b, true, true);
  j /= h;
  sum = s0 + prefix * j;
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
      p[n] += mbn * p[n - m] / lib_default161(tmp1);
      tmp1 += 2;
    }
    p[n] /= n;
    p[n] += bm1 / lib_default161(tnp1);
    j = (b2n * (b2n + 1) * j + (u + b2n + 1) * lxp) / t4;
    lxp *= lx2;
    b2n += 2;
    r = prefix * p[n] * j;
    sum += r;
    if (r > 1) {
      if (lib_default(r) < lib_default(lib_default144 * sum)) {
        break;
      }
    } else if (lib_default(r / lib_default144) < lib_default(sum)) {
      break;
    }
  }
  return sum;
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
  return lib_default149(lib_default(x), lib_default(y));
}
var main_default137 = maxabs;

var lib_default183 = main_default137;

function minabs(x, y) {
  return lib_default151(lib_default(x), lib_default(y));
}
var main_default138 = minabs;

var lib_default184 = main_default138;

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
    return lib_default142(x, a) * lib_default142(y, b);
  }
  c2 = a + b;
  agh = a + lib_default163 - 0.5;
  bgh = b + lib_default163 - 0.5;
  cgh = c2 + lib_default163 - 0.5;
  result = lib_default177(c2);
  result /= lib_default177(a) * lib_default177(b);
  result *= lib_default31(bgh / lib_default143);
  result *= lib_default31(agh / cgh);
  l1 = (x * b - y * agh) / agh;
  l2 = (y * a - x * bgh) / bgh;
  if (lib_default184(l1, l2) < 0.2) {
    if (l1 * l2 > 0 || lib_default151(a, b) < 1) {
      if (lib_default(l1) < 0.1) {
        result *= lib_default138(a * lib_default46(l1));
      } else {
        result *= lib_default142(x * cgh / agh, a);
      }
      if (lib_default(l2) < 0.1) {
        result *= lib_default138(b * lib_default46(l2));
      } else {
        result *= lib_default142(y * cgh / bgh, b);
      }
    } else if (lib_default183(l1, l2) < 0.5) {
      smallA = a < b;
      ratio = b / a;
      if (smallA && ratio * l2 < 0.1 || !smallA && l1 / ratio > 0.1) {
        l3 = lib_default147(ratio * lib_default46(l2));
        l3 = l1 + l3 + l3 * l1;
        l3 = a * lib_default46(l3);
        result *= lib_default138(l3);
      } else {
        l3 = lib_default147(lib_default46(l1) / ratio);
        l3 = l2 + l3 + l3 * l2;
        l3 = b * lib_default46(l3);
        result *= lib_default138(l3);
      }
    } else if (lib_default(l1) < lib_default(l2)) {
      l = a * lib_default46(l1) + b * lib_default48(y * cgh / bgh);
      if (l <= lib_default172 || l >= lib_default168) {
        l += lib_default48(result);
        if (l >= lib_default168) {
          return NaN;
        }
        result = lib_default138(l);
      } else {
        result *= lib_default138(l);
      }
    } else {
      l = b * lib_default46(l2) + a * lib_default48(x * cgh / agh);
      if (l <= lib_default172 || l >= lib_default168) {
        l += lib_default48(result);
        if (l >= lib_default168) {
          return NaN;
        }
        result = lib_default138(l);
      } else {
        result *= lib_default138(l);
      }
    }
  } else {
    b1 = x * cgh / agh;
    b2 = y * cgh / bgh;
    l1 = a * lib_default48(b1);
    l2 = b * lib_default48(b2);
    if (l1 >= lib_default168 || l1 <= lib_default172 || l2 >= lib_default168 || l2 <= lib_default172) {
      if (a < b) {
        p110 = lib_default142(b2, b / a);
        l3 = a * (lib_default48(b1) + lib_default48(p110));
        if (l3 < lib_default168 && l3 > lib_default172) {
          result *= lib_default142(p110 * b1, a);
        } else {
          l2 += l1 + lib_default48(result);
          if (l2 >= lib_default168) {
            return NaN;
          }
          result = lib_default138(l2);
        }
      } else {
        p110 = lib_default142(b1, a / b);
        l3 = (lib_default48(p110) + lib_default48(b2)) * b;
        if (l3 < lib_default168 && l3 > lib_default172) {
          result *= lib_default142(p110 * b2, b);
        } else {
          l2 += l1 + lib_default48(result);
          if (l2 >= lib_default168) {
            return NaN;
          }
          result = lib_default138(l2);
        }
      }
    } else {
      result *= lib_default142(b1, a) * lib_default142(b2, b);
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
  var f;
  result = ibeta_power_terms_default(a, b, x, y, normalized);
  if (out) {
    out[1] = result;
  }
  if (result === 0) {
    return result;
  }
  f = ibetaFraction2t(a, b, x, y);
  fract = lib_default181(f, OPTS);
  return result / fract;
}
var ibeta_fraction2_default = ibetaFraction2;

var FLOAT64_MAX_SAFE_INTEGER = 9007199254740991;
var lib_default185 = FLOAT64_MAX_SAFE_INTEGER;

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
  if (lib_default30(a) || lib_default30(b)) {
    return NaN;
  }
  if (a === lib_default43 || b === lib_default43 || a === lib_default44 || b === lib_default44) {
    return NaN;
  }
  if (!(lib_default107(a) && lib_default107(b))) {
    return NaN;
  }
  if (a < 0) {
    a = -a;
  }
  if (b < 0) {
    b = -b;
  }
  if (a <= lib_default153 && b <= lib_default153) {
    return bitwise_binary_gcd_default(a, b);
  }
  return binary_gcd_default(a, b);
}
var main_default139 = gcd3;

var lib_default186 = main_default139;

function binomcoef(n, k) {
  var res;
  var sgn;
  var b;
  var c2;
  var d2;
  var g;
  var s;
  if (lib_default30(n) || lib_default30(k)) {
    return NaN;
  }
  if (!lib_default107(n) || !lib_default107(k)) {
    return NaN;
  }
  if (k < 0) {
    return 0;
  }
  sgn = 1;
  if (n < 0) {
    n = -n + k - 1;
    if (lib_default109(k)) {
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
  s = lib_default105(lib_default185 / n);
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
  if (b === lib_default43) {
    return sgn * b;
  }
  c2 = binomcoef(k, k - d2 + 1);
  g = lib_default186(b, c2);
  b /= g;
  c2 /= g;
  res /= c2;
  return sgn * res * b;
}
var main_default140 = binomcoef;

var lib_default187 = main_default140;

function binomialCCDF(n, k, x, y) {
  var startTerm;
  var result;
  var start;
  var term;
  var i;
  result = lib_default142(x, n);
  if (result > lib_default123) {
    term = result;
    for (i = lib_default105(n - 1); i > k; i--) {
      term *= (i + 1) * y / ((n - i) * x);
      result += term;
    }
  } else {
    start = lib_default105(n * x);
    if (start <= k + 1) {
      start = lib_default105(k + 2);
    }
    result = lib_default142(x, start) * lib_default142(y, n - start);
    result *= lib_default187(lib_default105(n), lib_default105(start));
    if (result === 0) {
      for (i = start - 1; i > k; i--) {
        result += lib_default142(x, i) * lib_default142(y, n - i);
        result *= lib_default187(lib_default105(n), lib_default105(i));
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
  var sum;
  var i;
  prefix = ibeta_power_terms_default(a, b, x, y, normalized);
  if (out) {
    out[1] = prefix;
  }
  prefix /= a;
  if (prefix === 0) {
    return prefix;
  }
  sum = 1;
  term = 1;
  for (i = 0; i < k - 1; ++i) {
    term *= (a + b + i) * x / (a + i + 1);
    sum += term;
  }
  prefix *= sum;
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
    agh = a + lib_default163 - 0.5;
    bgh = b + lib_default163 - 0.5;
    cgh = c2 + lib_default163 - 0.5;
    result = lib_default177(c2) / (lib_default177(a) * lib_default177(b));
    l1 = lib_default48(cgh / bgh) * (b - 0.5);
    l2 = lib_default48(x * cgh / agh) * a;
    if (l1 > lib_default172 && l1 < lib_default168 && l2 > lib_default172 && l2 < lib_default168) {
      if (a * b < bgh * 10) {
        result *= lib_default138((b - 0.5) * lib_default46(a / bgh));
      } else {
        result *= lib_default142(cgh / bgh, b - 0.5);
      }
      result *= lib_default142(x * cgh / agh, a);
      result *= lib_default31(agh / lib_default143);
      if (out) {
        out[1] = result * lib_default142(y, b);
      }
    } else {
      result = lib_default48(result) + l1 + l2 + (lib_default48(agh) - 1) / 2;
      if (out) {
        out[1] = lib_default138(result + b * lib_default48(y));
      }
      result = lib_default138(result);
    }
  } else {
    result = lib_default142(x, a);
  }
  if (result < lib_default123) {
    return s0;
  }
  s = ibetaSeriesT(a, b, x, result);
  opts.initialValue = s0;
  return lib_default170(s, opts);
}
var ibeta_series_default = ibetaSeries;

var ONE_OVER_PI = 1 / lib_default26;
function ibetaImp(x, a, b, regularized, upper, out, stride, offset) {
  var lambda;
  var prefix;
  var fract;
  var bbar;
  var div;
  var tmp7;
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
  if (lib_default30(x) || x < 0 || x > 1) {
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
      out[i1] = a < 1 ? lib_default152 / 2 : lib_default123 * 2;
    }
    if (upper) {
      out[i0] = regularized ? 1 : lib_default145(a, b);
      return out;
    }
    out[i0] = 0;
    return out;
  }
  if (x === 1) {
    if (b === 1) {
      out[i1] = 1;
    } else {
      out[i1] = b < 1 ? lib_default152 / 2 : lib_default123 * 2;
    }
    if (upper) {
      out[i0] = 0;
    } else {
      out[i0] = regularized ? 1 : lib_default145(a, b);
    }
    return out;
  }
  if (a === 0.5 && b === 0.5) {
    out[i1] = ONE_OVER_PI * lib_default31(y * x);
    p101 = upper ? lib_default33(lib_default31(y)) : lib_default33(lib_default31(x));
    p101 /= lib_default54;
    if (!regularized) {
      p101 *= lib_default26;
    }
    out[i0] = p101;
    return out;
  }
  if (a === 1) {
    tmp7 = b;
    b = a;
    a = tmp7;
    tmp7 = y;
    y = x;
    x = tmp7;
    upper = !upper;
  }
  if (b === 1) {
    if (a === 1) {
      out[i0] = upper ? y : x;
      out[i1] = 1;
      return out;
    }
    out[i1] = a * lib_default142(x, a - 1);
    if (y < 0.5) {
      p101 = upper ? -lib_default147(a * lib_default46(-y)) : lib_default138(a * lib_default46(-y));
    } else {
      p101 = upper ? -(lib_default142(x, a) - 1) : lib_default142(x, a);
    }
    if (!regularized) {
      p101 /= a;
    }
    out[i0] = p101;
    return out;
  }
  if (lib_default151(a, b) <= 1) {
    if (x > 0.5) {
      tmp7 = b;
      b = a;
      a = tmp7;
      tmp7 = y;
      y = x;
      x = tmp7;
      upper = !upper;
    }
    if (lib_default149(a, b) <= 1) {
      if (a >= lib_default151(0.2, b) || lib_default142(x, a) <= 0.9) {
        if (upper) {
          fract = -(regularized ? 1 : lib_default145(a, b));
          upper = false;
          fract = -ibeta_series_default(a, b, x, fract, regularized, out, y);
        } else {
          fract = ibeta_series_default(a, b, x, 0, regularized, out, y);
        }
      } else {
        tmp7 = b;
        b = a;
        a = tmp7;
        tmp7 = y;
        y = x;
        x = tmp7;
        upper = !upper;
        if (y >= 0.3) {
          if (upper) {
            fract = -(regularized ? 1 : lib_default145(a, b));
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
            fract -= regularized ? 1 : lib_default145(a, b);
            upper = false;
            fract = -beta_small_b_large_a_series_default(a + 20, b, x, y, fract, prefix, regularized);
          } else {
            fract = beta_small_b_large_a_series_default(a + 20, b, x, y, fract, prefix, regularized);
          }
        }
      }
    } else if (b <= 1 || x < 0.1 && lib_default142(b * x, a) <= 0.7) {
      if (upper) {
        fract = -(regularized ? 1 : lib_default145(a, b));
        upper = false;
        fract = -ibeta_series_default(a, b, x, fract, regularized, out, y);
      } else {
        fract = ibeta_series_default(a, b, x, 0, regularized, out, y);
      }
    } else {
      tmp7 = b;
      b = a;
      a = tmp7;
      tmp7 = y;
      y = x;
      x = tmp7;
      upper = !upper;
      if (y >= 0.3) {
        if (upper) {
          fract = -(regularized ? 1 : lib_default145(a, b));
          upper = false;
          fract = -ibeta_series_default(a, b, x, fract, regularized, out, y);
        } else {
          fract = ibeta_series_default(a, b, x, 0, regularized, out, y);
        }
      } else if (a >= 15) {
        if (upper) {
          fract = -(regularized ? 1 : lib_default145(a, b));
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
          fract -= regularized ? 1 : lib_default145(a, b);
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
      tmp7 = b;
      b = a;
      a = tmp7;
      tmp7 = y;
      y = x;
      x = tmp7;
      upper = !upper;
    }
    if (b < 40) {
      if (lib_default105(a) === a && lib_default105(b) === b && a < lib_default153 - 100) {
        k = a - 1;
        n = b + k;
        fract = binomial_ccdf_default(n, k, x, y);
        if (!regularized) {
          fract *= lib_default145(a, b);
        }
      } else if (b * x <= 0.7) {
        if (upper) {
          fract = -(regularized ? 1 : lib_default145(a, b));
          upper = false;
          fract = -ibeta_series_default(a, b, x, fract, regularized, out, y);
        } else {
          fract = ibeta_series_default(a, b, x, 0, regularized, out, y);
        }
      } else if (a > 15) {
        n = lib_default105(b);
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
        n = lib_default105(b);
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
    if (lib_default152 * div < out[i1]) {
      out[i1] = lib_default152 / 2;
    } else {
      out[i1] /= div;
    }
  }
  out[i0] = upper ? (regularized ? 1 : lib_default145(a, b)) - fract : fract;
  return out;
}
var assign_default4 = ibetaImp;

function kernelBetainc(x, a, b, regularized, upper) {
  return assign_default4(x, a, b, regularized, upper, [0, 0], 1, 0);
}
var main_default141 = kernelBetainc;

main_default141.assign = assign_default4;
var lib_default188 = main_default141;

var kernelBetainc2 = lib_default188.assign;
function betainc(x, a, b, regularized, upper) {
  var out = [0, 0];
  regularized = regularized === false ? false : true;
  upper = upper === true ? true : false;
  kernelBetainc2(x, a, b, regularized, upper, out, 1, 0);
  return out[0];
}
var main_default142 = betainc;

var lib_default189 = main_default142;

function evalrational27(x) {
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
var rational_p1q1_default6 = evalrational27;

function evalrational28(x) {
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
var rational_p2q2_default6 = evalrational28;

function evalrational29(x) {
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
var rational_p3q3_default3 = evalrational29;

function evalrational30(x) {
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
var rational_p4q4_default = evalrational30;

function evalrational31(x) {
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
var rational_p5q5_default = evalrational31;

var Y12 = 0.08913147449493408;
var Y23 = 2.249481201171875;
var Y32 = 0.807220458984375;
var Y4 = 0.9399557113647461;
var Y5 = 0.9836282730102539;
function erfcinv(x) {
  var sign;
  var qs;
  var q;
  var g;
  var r;
  if (lib_default30(x)) {
    return NaN;
  }
  if (x === 0) {
    return lib_default43;
  }
  if (x === 2) {
    return lib_default44;
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
    r = rational_p1q1_default6(x);
    return sign * (g * Y12 + g * r);
  }
  if (q >= 0.25) {
    g = lib_default31(-2 * lib_default48(q));
    q -= 0.25;
    r = rational_p2q2_default6(q);
    return sign * (g / (Y23 + r));
  }
  q = lib_default31(-lib_default48(q));
  if (q < 3) {
    qs = q - 1.125;
    r = rational_p3q3_default3(qs);
    return sign * (Y32 * q + r * q);
  }
  if (q < 6) {
    qs = q - 3;
    r = rational_p4q4_default(qs);
    return sign * (Y4 * q + r * q);
  }
  qs = q - 6;
  r = rational_p5q5_default(qs);
  return sign * (Y5 * q + r * q);
}
var main_default143 = erfcinv;

var lib_default190 = main_default143;

var SQRT2 = 1.4142135623730951;
var lib_default191 = SQRT2;

function evalpoly59(x) {
  if (x === 0) {
    return 0.16666666666666666;
  }
  return 0.16666666666666666 + x * 0.16666666666666666;
}
var polyval_co14_default = evalpoly59;

function evalpoly60(x) {
  if (x === 0) {
    return 0.058333333333333334;
  }
  return 0.058333333333333334 + x * (0.06666666666666667 + x * 0.008333333333333333);
}
var polyval_co15_default = evalpoly60;

function evalpoly61(x) {
  if (x === 0) {
    return 0.0251984126984127;
  }
  return 0.0251984126984127 + x * (0.026785714285714284 + x * (0.0017857142857142857 + x * 1984126984126984e-19));
}
var polyval_co16_default = evalpoly61;

function evalpoly62(x) {
  if (x === 0) {
    return 0.012039792768959435;
  }
  return 0.012039792768959435 + x * (0.010559964726631394 + x * (-0.0011078042328042327 + x * (3747795414462081e-19 + x * 27557319223985893e-22)));
}
var polyval_co17_default = evalpoly62;

function evalpoly63(x) {
  if (x === 0) {
    return 0.003837005972422639;
  }
  return 0.003837005972422639 + x * (0.00610392115600449 + x * (-0.0016095979637646305 + x * (5945867404200738e-19 + x * (-6270542728876062e-20 + x * 2505210838544172e-23))));
}
var polyval_co18_default = evalpoly63;

function evalpoly64(x) {
  if (x === 0) {
    return 0.0032177478835464946;
  }
  return 0.0032177478835464946 + x * (0.0010898206731540065 + x * (-0.0012579159844784845 + x * (6908420797309686e-19 + x * (-16376804137220805e-20 + x * (154012654012654e-19 + x * 16059043836821613e-26)))));
}
var polyval_co19_default = evalpoly64;

function evalpoly65(x) {
  if (x === 0) {
    return 0.001743826229834001;
  }
  return 0.001743826229834001 + x * (3353097688001788e-20 + x * (-7624513544032393e-19 + x * (6451304695145635e-19 + x * (-249472580470431e-18 + x * (49255746366361444e-21 + x * (-39851014346715405e-22 + x * 7647163731819816e-28))))));
}
var polyval_co20_default = evalpoly65;

function evalpoly66(x) {
  if (x === 0) {
    return 9647274732138864e-19;
  }
  return 9647274732138864e-19 + x * (-3110108632631878e-19 + x * (-36307660358786886e-20 + x * (5140660578834113e-19 + x * (-29133414466938067e-20 + x * (9086710793521991e-20 + x * (-15303004486655377e-21 + x * (10914179173496788e-22 + x * 28114572543455206e-31)))))));
}
var polyval_co21_default = evalpoly66;

function evalpoly67(x) {
  if (x === 0) {
    return 5422926281312969e-19;
  }
  return 5422926281312969e-19 + x * (-3694266780000966e-19 + x * (-10230378073700413e-20 + x * (35764655430568635e-20 + x * (-28690924218514614e-20 + x * (12645437628698076e-20 + x * (-33202652391372056e-21 + x * (4890304529197534e-21 + x * (-3123956959982987e-22 + x * 822063524662433e-32))))))));
}
var polyval_co22_default = evalpoly67;

var c0 = 0;
var c = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
function inverseStudentsTBodySeries(df, u) {
  var idf;
  var v3;
  v3 = lib_default164(df / 2, 0.5) * lib_default31(df * lib_default26) * (u - 0.5);
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
  return c0 + v3 * lib_default174(c, v3 * v3);
}
var inverse_students_t_body_series_default = inverseStudentsTBodySeries;

var d = [0, 0, 0, 0, 0, 0, 0];
function inverseStudentsTTailSeries(df, v3) {
  var result;
  var power;
  var div;
  var np2;
  var np4;
  var np6;
  var rn;
  var w;
  w = lib_default164(df / 2, 0.5) * lib_default31(df * lib_default26) * v3;
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
  rn = lib_default31(df);
  div = lib_default142(rn * w, 1 / df);
  power = div * div;
  result = lib_default174(d, power);
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
    return -lib_default190(2 * u) * lib_default191;
  }
  a = 1 / (ndf - 0.5);
  b = 48 / (a * a);
  c2 = ((20700 * a / b - 98) * a - 16) * a + 96.36;
  d2 = ((94.5 / (b + c2) - 3) / b + 1) * lib_default31(a * lib_default54) * ndf;
  y = lib_default142(d2 * 2 * u, 2 / ndf);
  if (y > 0.05 + a) {
    x = -lib_default190(2 * u) * lib_default191;
    y = x * x;
    if (ndf < 5) {
      c2 += 0.3 * (ndf - 4.5) * (x + 0.6);
    }
    c2 += (((0.05 * d2 * x - 5) * x - 7) * x - 2) * x + b;
    y = (((((0.4 * y + 6.3) * y + 36) * y + 94.5) / c2 - y - 3) / b + 1) * x;
    y = lib_default147(a * y * y);
  } else {
    y = ((1 / (((ndf + 6) / (ndf * y) - 0.089 * d2 - 0.822) * (ndf + 2) * 3) + 0.5 / (ndf + 4)) * y - 1) * (ndf + 1) / (ndf + 2) + 1 / y;
  }
  q = lib_default31(ndf * y);
  return -q;
}
var inverse_students_t_hill_default = inverseStudentsTHill;

var DF_THRESHOLD = 268435456;
var ONE_THIRD3 = 1 / 3;
var EXP = 2 * 53 / 3;
var C = 0.8549879733383485;
function inverseStudentsT(df, u, v3) {
  var crossover;
  var tolerance;
  var rootAlpha;
  var invert;
  var result;
  var alpha;
  var tmp7;
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
  if (u > v3) {
    tmp7 = v3;
    v3 = u;
    u = tmp7;
    invert = true;
  } else {
    invert = false;
  }
  if (lib_default105(df) === df && df < 20) {
    tolerance = lib_default125(1, EXP);
    switch (lib_default105(df)) {
      case 1:
        if (u === 0.5) {
          result = 0;
        } else {
          result = -lib_default165(lib_default26 * u) / lib_default156(lib_default26 * u);
        }
        break;
      case 2:
        result = (2 * u - 1) / lib_default31(2 * u * v3);
        break;
      case 4:
        alpha = 4 * u * v3;
        rootAlpha = lib_default31(alpha);
        r = 4 * lib_default165(lib_default34(rootAlpha) / 3) / rootAlpha;
        x = lib_default31(r - 4);
        result = u - 0.5 < 0 ? -x : x;
        break;
      case 6:
        if (u < 1e-150) {
          return (invert ? -1 : 1) * inverse_students_t_hill_default(df, u);
        }
        a = 4 * (u - u * u);
        b = lib_default142(a, ONE_THIRD3);
        p101 = 6 * (1 + C * (1 / b - 1));
        do {
          p210 = p101 * p101;
          p410 = p210 * p210;
          p510 = p101 * p410;
          p02 = p101;
          p101 = 2 * (8 * a * p510 - 270 * p210 + 2187) / (5 * (4 * a * p410 - 216 * p101 - 243));
        } while (lib_default((p101 - p02) / p101) > tolerance);
        p101 = lib_default31(p101 - df);
        result = u - 0.5 < 0 ? -p101 : p101;
        break;
      default:
        if (df > DF_THRESHOLD) {
          result = lib_default190(2 * u) * lib_default191;
        } else if (df < 3) {
          crossover = 0.2742 - df * 0.0242143;
          if (u > crossover) {
            result = inverse_students_t_body_series_default(df, u);
          } else {
            result = inverse_students_t_tail_series_default(df, u);
          }
        } else {
          crossover = lib_default125(1, lib_default128(df / -0.654));
          if (u > crossover) {
            result = inverse_students_t_hill_default(df, u);
          } else {
            result = inverse_students_t_tail_series_default(df, u);
          }
        }
    }
  } else if (df > DF_THRESHOLD) {
    result = -lib_default190(2 * u) * lib_default191;
  } else if (df < 3) {
    crossover = 0.2742 - df * 0.0242143;
    if (u > crossover) {
      result = inverse_students_t_body_series_default(df, u);
    } else {
      result = inverse_students_t_tail_series_default(df, u);
    }
  } else {
    crossover = lib_default125(1, lib_default128(df / -0.654));
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
  var v3;
  var t;
  u = p101 / 2;
  v3 = 1 - u;
  df = a * 2;
  t = inverse_students_t_default(df, u, v3);
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
  var eta3;
  var B23;
  var B32;
  var B;
  var c2;
  eta0 = lib_default190(2 * z);
  eta0 /= -lib_default31(a / 2);
  terms[0] = eta0;
  B = b - a;
  B23 = B * B;
  B32 = B23 * B;
  workspace2[0] = -B * lib_default191 / 2;
  workspace2[1] = (1 - 2 * B) / 8;
  workspace2[2] = -(B * lib_default191 / 48);
  workspace2[3] = -1 / 192;
  workspace2[4] = -B * lib_default191 / 3840;
  workspace2[5] = 0;
  workspace2[6] = 0;
  terms[1] = lib_default174(workspace2, eta0);
  workspace2[0] = B * lib_default191 * (3 * B - 2) / 12;
  workspace2[1] = (20 * B23 - 12 * B + 1) / 128;
  workspace2[2] = B * lib_default191 * (20 * B - 1) / 960;
  workspace2[3] = (16 * B23 + 30 * B - 15) / 4608;
  workspace2[4] = B * lib_default191 * (21 * B + 32) / 53760;
  workspace2[5] = (-(32 * B23) + 63) / 368640;
  workspace2[6] = -B * lib_default191 * (120 * B + 17) / 25804480;
  terms[2] = lib_default174(workspace2, eta0);
  workspace2[0] = B * lib_default191 * (-75 * B23 + 80 * B - 16) / 480;
  workspace2[1] = (-1080 * B32 + 868 * B23 - 90 * B - 45) / 9216;
  workspace2[2] = B * lib_default191 * (-1190 * B23 + 84 * B + 373) / 53760;
  workspace2[3] = (-2240 * B32 - 2508 * B23 + 2100 * B - 165) / 368640;
  workspace2[4] = 0;
  workspace2[5] = 0;
  workspace2[6] = 0;
  terms[3] = lib_default174(workspace2, eta0);
  eta3 = lib_default174(terms, 1 / a);
  eta2 = eta3 * eta3;
  c2 = -lib_default138(-eta2 / 2);
  if (eta2 === 0) {
    return 0.5;
  }
  return (1 + eta3 * lib_default31((1 + c2) / eta2)) / 2;
}
var temme1_default = temme1;

var BIG = lib_default152 / 4;
function temmeRootFinder(t, a) {
  return roots;
  function roots(x) {
    var f1;
    var f;
    var y;
    y = 1 - x;
    if (y === 0) {
      return [-BIG, -BIG];
    }
    if (x === 0) {
      return [-BIG, -BIG];
    }
    f = lib_default48(x) + a * lib_default48(y) + t;
    f1 = 1 / x - a / y;
    return [f, f1];
  }
}
var root_finder_default = temmeRootFinder;

function signum(x) {
  if (x === 0 || lib_default30(x)) {
    return x;
  }
  return x < 0 ? -1 : 1;
}
var main_default144 = signum;

var lib_default192 = main_default144;

function newtonRaphsonIterate(fun, guess, min3, max3, digits, maxIter) {
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
  factor = lib_default125(1, 1 - digits);
  delta = lib_default152;
  delta1 = lib_default152;
  delta2 = lib_default152;
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
        if (result === min3) {
          guess = max3;
        } else {
          guess = min3;
        }
        f0last = fun(guess);
        delta = guess - result;
      }
      if (lib_default192(f0last) * lib_default192(f0) < 0) {
        if (delta < 0) {
          delta = (result - min3) / 2;
        } else {
          delta = (result - max3) / 2;
        }
      } else if (delta < 0) {
        delta = (result - max3) / 2;
      } else {
        delta = (result - min3) / 2;
      }
    } else {
      delta = f0 / f1;
    }
    if (lib_default(delta * 2) > lib_default(delta2)) {
      delta = delta > 0 ? (result - min3) / 2 : (result - max3) / 2;
    }
    guess = result;
    result -= delta;
    if (result <= min3) {
      delta = 0.5 * (guess - min3);
      result = guess - delta;
      if (result === min3 || result === max3) {
        break;
      }
    } else if (result >= max3) {
      delta = 0.5 * (guess - max3);
      result = guess - delta;
      if (result === min3 || result === max3) {
        break;
      }
    }
    if (delta > 0) {
      max3 = guess;
    } else {
      min3 = guess;
    }
  } while (count && lib_default(result * factor) < lib_default(delta));
  return result;
}
var newton_raphson_default = newtonRaphsonIterate;

function evalpoly68(x) {
  if (x === 0) {
    return -1;
  }
  return -1 + x * (-5 + x * 5);
}
var polyval_co1_default = evalpoly68;

function evalpoly69(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (21 + x * (-69 + x * 46));
}
var polyval_co2_default = evalpoly69;

function evalpoly70(x) {
  if (x === 0) {
    return 7;
  }
  return 7 + x * (-2 + x * (33 + x * (-62 + x * 31)));
}
var polyval_co3_default = evalpoly70;

function evalpoly71(x) {
  if (x === 0) {
    return 25;
  }
  return 25 + x * (-52 + x * (-17 + x * (88 + x * (-115 + x * 46))));
}
var polyval_co4_default = evalpoly71;

function evalpoly72(x) {
  if (x === 0) {
    return 7;
  }
  return 7 + x * (12 + x * (-78 + x * 52));
}
var polyval_co5_default = evalpoly72;

function evalpoly73(x) {
  if (x === 0) {
    return -7;
  }
  return -7 + x * (2 + x * (183 + x * (-370 + x * 185)));
}
var polyval_co6_default = evalpoly73;

function evalpoly74(x) {
  if (x === 0) {
    return -533;
  }
  return -533 + x * (776 + x * (-1835 + x * (10240 + x * (-13525 + x * 5410))));
}
var polyval_co7_default = evalpoly74;

function evalpoly75(x) {
  if (x === 0) {
    return -1579;
  }
  return -1579 + x * (3747 + x * (-3372 + x * (-15821 + x * (45588 + x * (-45213 + x * 15071)))));
}
var polyval_co8_default = evalpoly75;

function evalpoly76(x) {
  if (x === 0) {
    return 449;
  }
  return 449 + x * (-1259 + x * (-769 + x * (6686 + x * (-9260 + x * 3704))));
}
var polyval_co9_default = evalpoly76;

function evalpoly77(x) {
  if (x === 0) {
    return 63149;
  }
  return 63149 + x * (-151557 + x * (140052 + x * (-727469 + x * (2239932 + x * (-2251437 + x * 750479)))));
}
var polyval_co10_default = evalpoly77;

function evalpoly78(x) {
  if (x === 0) {
    return 29233;
  }
  return 29233 + x * (-78755 + x * (105222 + x * (146879 + x * (-1602610 + x * (3195183 + x * (-2554139 + x * 729754))))));
}
var polyval_co11_default = evalpoly78;

function evalpoly79(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (-13 + x * 13);
}
var polyval_co12_default = evalpoly79;

function evalpoly80(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (21 + x * (-69 + x * 46));
}
var polyval_co13_default = evalpoly80;

var workspace3 = [0, 0, 0, 0, 0, 0];
var terms2 = [0, 0, 0, 0];
function temme2(z, r, theta) {
  var upper;
  var lower;
  var alpha;
  var roots;
  var eta0;
  var eta2;
  var sc72;
  var sc62;
  var sc52;
  var sc42;
  var sc32;
  var sc22;
  var sc8;
  var lu;
  var s2;
  var c2;
  var c3;
  var s;
  var u;
  var x;
  eta0 = lib_default190(2 * z) / -lib_default31(r / 2);
  s = lib_default156(theta);
  c3 = lib_default165(theta);
  terms2[0] = eta0;
  s2 = s * s;
  c2 = c3 * c3;
  sc8 = s * c3;
  sc22 = sc8 * sc8;
  sc32 = sc22 * sc8;
  sc42 = sc22 * sc22;
  sc52 = sc22 * sc32;
  sc62 = sc32 * sc32;
  sc72 = sc42 * sc32;
  workspace3[0] = (2 * s2 - 1) / (3 * sc8);
  workspace3[1] = -polyval_co1_default(s2) / (36 * sc22);
  workspace3[2] = polyval_co2_default(s2) / (1620 * sc32);
  workspace3[3] = polyval_co3_default(s2) / (6480 * sc42);
  workspace3[4] = polyval_co4_default(s2) / (90720 * sc52);
  workspace3[5] = 0;
  terms2[1] = lib_default174(workspace3, eta0);
  workspace3[0] = -polyval_co5_default(s2) / (405 * sc32);
  workspace3[1] = polyval_co6_default(s2) / (2592 * sc42);
  workspace3[2] = -polyval_co7_default(s2) / (204120 * sc52);
  workspace3[3] = -polyval_co8_default(s2) / (2099520 * sc62);
  workspace3[4] = 0;
  workspace3[5] = 0;
  terms2[2] = lib_default174(workspace3, eta0);
  workspace3[0] = polyval_co9_default(s2) / (102060 * sc52);
  workspace3[1] = -polyval_co10_default(s2) / (20995200 * sc62);
  workspace3[2] = polyval_co11_default(s2) / (36741600 * sc72);
  workspace3[3] = 0;
  workspace3[4] = 0;
  workspace3[5] = 0;
  terms2[3] = lib_default174(workspace3, eta0);
  eta2 = lib_default174(terms2, 1 / r);
  alpha = c3 / s;
  alpha *= alpha;
  lu = -(eta2 * eta2) / (2 * s2) + lib_default48(s2) + c2 * lib_default48(c2) / s2;
  if (lib_default(eta2) < 0.7) {
    workspace3[0] = s2;
    workspace3[1] = sc8;
    workspace3[2] = (1 - 2 * s2) / 3;
    workspace3[3] = polyval_co12_default(s2) / (36 * sc8);
    workspace3[4] = polyval_co13_default(s2) / (270 * sc22);
    workspace3[5] = 0;
    x = lib_default174(workspace3, eta2);
  } else {
    u = lib_default138(lu);
    workspace3[0] = u;
    workspace3[1] = alpha;
    workspace3[2] = 0;
    workspace3[3] = 3 * alpha * (3 * alpha + 1) / 6;
    workspace3[4] = 4 * alpha * (4 * alpha + 1) * (4 * alpha + 2) / 24;
    workspace3[5] = 5 * alpha * (5 * alpha + 1) * (5 * alpha + 2) * (5 * alpha + 3) / 120;
    x = lib_default174(workspace3, u);
    if ((x - s2) * eta2 < 0) {
      x = 1 - x;
    }
  }
  if (eta2 < 0) {
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
var lib_default193 = FLOAT32_MAX;

var debug = alias_debug_default("gammaincinv:higher_newton");
function higherNewton(x0, a, m, p101, q, lgama, invfp, pcase) {
  var dlnr;
  var xini;
  var ck0;
  var ck1;
  var ck2;
  var a2;
  var x26;
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
    x26 = x * x;
    if (m === 0) {
      dlnr = (1 - a) * lib_default48(x) + x + lgama;
      if (dlnr > lib_default48(lib_default193)) {
        debug("Warning: overflow problems in one or more steps of the computation. The initial approximation to the root is returned.");
        return xini;
      }
      r = lib_default138(dlnr);
    } else {
      r = -invfp * x;
    }
    if (pcase) {
      px = lib_default182(x, a, true, false);
      ck0 = -r * (px - p101);
    } else {
      qx = lib_default182(x, a, true, true);
      ck0 = r * (qx - q);
    }
    r = ck0;
    if (p101 > 1e-120 || n > 1) {
      ck1 = 0.5 * (x - a + 1) / x;
      ck2 = (2 * x26 - 4 * x * a + 4 * x + 2 * a2 - 3 * a + 1) / x26;
      ck2 /= 6;
      x0 = x + r * (1 + r * (ck1 + r * ck2));
    } else {
      x0 = x + r;
    }
    t = lib_default(x / x0 - 1);
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

function evalpoly81(x) {
  if (x === 0) {
    return 0;
  }
  return 0 + x * (1 + x * (1 + x * (1.5 + x * (2.6666666666666665 + x * (5.208333333333333 + x * 10.8)))));
}
var polyval_ak1_default = evalpoly81;

function evalpoly82(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (1 + x * (0.3333333333333333 + x * (0.027777777777777776 + x * (-0.003703703703703704 + x * (2314814814814815e-19 + x * 5878894767783657e-20)))));
}
var polyval_ak2_default = evalpoly82;

var THRESHOLD = 1e-8;
var ONEO12 = 0.08333333333333333;
var ONEO120 = 0.008333333333333333;
var AK = [1, 0, 0, 0, 0, 0];
function lambdaeta(eta2) {
  var L2;
  var L3;
  var L4;
  var L5;
  var la;
  var L;
  var q;
  var r;
  var s;
  s = eta2 * eta2 * 0.5;
  if (eta2 === 0) {
    la = 0;
  } else if (eta2 < -1) {
    r = lib_default138(-1 - s);
    la = polyval_ak1_default(r);
  } else if (eta2 < 1) {
    r = eta2;
    la = polyval_ak2_default(r);
  } else {
    r = 11 + s;
    L = lib_default48(r);
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
    la += L * r * lib_default174(AK, r);
  }
  r = 1;
  if (eta2 > -3.5 && eta2 < -0.03 || eta2 > 0.03 && eta2 < 40) {
    r = 1;
    q = la;
    do {
      la = q * (s + lib_default48(q)) / (q - 1);
      r = lib_default(q / la - 1);
      q = la;
    } while (r > THRESHOLD);
  }
  return la;
}
var lambdaeta_default = lambdaeta;

var LN_SQRT_TWO_PI = 0.9189385332046728;
var lib_default194 = LN_SQRT_TWO_PI;

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

function evalpoly83(x) {
  if (x === 0) {
    return 0.025721014990011306;
  }
  return 0.025721014990011306 + x * (0.08247596616699963 + x * (-0.0025328157302663564 + x * (6099292666946337e-19 + x * (-33543297638406e-17 + x * 250505279903e-15))));
}
var polyval_c_default = evalpoly83;

function evalpoly84(x) {
  if (x === 0) {
    return 0.08333333333333333;
  }
  return 0.08333333333333333 + x * (-0.002777777777777778 + x * (7936507936507937e-19 + x * -5952380952380953e-19));
}
var polyval_d_default = evalpoly84;

var C62 = 0.30865217988013566;
function stirling(x) {
  var z;
  if (x < lib_default180) {
    return lib_default193;
  }
  if (x < 1) {
    return lib_default167(x + 1) - (x + 0.5) * lib_default48(x) + x - lib_default194;
  }
  if (x < 2) {
    return lib_default167(x) - (x - 0.5) * lib_default48(x) + x - lib_default194;
  }
  if (x < 3) {
    return lib_default167(x - 1) - (x - 0.5) * lib_default48(x) + x - lib_default194 + lib_default48(x - 1);
  }
  if (x < 12) {
    z = 18 / (x * x) - 1;
    return chepolsum_default(17, z) / (12 * x);
  }
  z = 1 / (x * x);
  if (x < 1e3) {
    return polyval_c_default(z) / (C62 + z) / x;
  }
  return polyval_d_default(z) / x;
}
var stirling_default = stirling;

function gamstar(x) {
  if (x >= 3) {
    return lib_default138(stirling_default(x));
  }
  if (x > 0) {
    return lib_default159(x) / (lib_default138(-x + (x - 0.5) * lib_default48(x)) * lib_default157);
  }
  return lib_default193;
}
var gamstar_default = gamstar;

function evalrational32(x) {
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
var rational_ak0bk0_default = evalrational32;

function eps1(eta2) {
  var la;
  if (lib_default(eta2) < 1) {
    return rational_ak0bk0_default(eta2);
  }
  la = lambdaeta_default(eta2);
  return lib_default48(eta2 / (la - 1)) / eta2;
}
var eps1_default = eps1;

function evalrational33(x) {
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
var rational_ak1bk1_default = evalrational33;

function evalrational34(x) {
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
var rational_ak2bk2_default = evalrational34;

function evalrational35(x) {
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
var rational_ak3bk3_default = evalrational35;

function eps2(eta2) {
  var lnmeta;
  var x;
  if (eta2 < -5) {
    x = eta2 * eta2;
    lnmeta = lib_default48(-eta2);
    return (12 - x - 6 * (lnmeta * lnmeta)) / (12 * x * eta2);
  }
  if (eta2 < -2) {
    return rational_ak1bk1_default(eta2);
  }
  if (eta2 < 2) {
    return rational_ak2bk2_default(eta2);
  }
  if (eta2 < 1e3) {
    x = 1 / eta2;
    return rational_ak3bk3_default(eta2) / (-12 * eta2);
  }
  return -1 / (12 * eta2);
}
var eps2_default = eps2;

function evalrational36(x) {
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
var rational_ak4bk4_default = evalrational36;

function evalrational37(x) {
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
var rational_ak5bk5_default = evalrational37;

function evalrational38(x) {
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
var rational_ak6bk6_default = evalrational38;

function evalrational39(x) {
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
var rational_ak7bk7_default = evalrational39;

function evalrational40(x) {
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
var rational_ak8bk8_default = evalrational40;

function eps3(eta2) {
  var x;
  var y;
  if (eta2 < -8) {
    x = eta2 * eta2;
    y = lib_default48(-eta2) / eta2;
    return (-30 + eta2 * y * (6 * x * y * y - 12 + x)) / (12 * eta2 * x * x);
  }
  if (eta2 < -4) {
    return rational_ak4bk4_default(eta2) / (eta2 * eta2);
  }
  if (eta2 < -2) {
    return rational_ak5bk5_default(eta2);
  }
  if (eta2 < 2) {
    return rational_ak6bk6_default(eta2);
  }
  if (eta2 < 10) {
    x = 1 / eta2;
    return rational_ak7bk7_default(x) / (eta2 * eta2);
  }
  if (eta2 < 100) {
    x = 1 / eta2;
    return rational_ak8bk8_default(x) / (eta2 * eta2);
  }
  return -lib_default48(eta2) / (12 * eta2 * eta2 * eta2);
}
var eps3_default = eps3;

var debug2 = alias_debug_default("gammaincinv:compute");
var HALF5 = 0.5;
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
  var eta2;
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
  if (p101 < HALF5) {
    pcase = true;
    porq = p101;
    s = -1;
  } else {
    pcase = false;
    porq = q;
    s = 1;
  }
  k = 0;
  if (lib_default(a - 1) < 1e-4) {
    m = 0;
    if (pcase) {
      if (p101 < 1e-3) {
        p210 = p101 * p101;
        p310 = p210 * p101;
        p410 = p310 * p101;
        p510 = p410 * p101;
        p610 = p510 * p101;
        x0 = p101 + p210 * HALF5 + p310 * ONEO3 + p410 * ONEO4 + p510 * ONEO5 + p610 * ONEO6;
      } else {
        x0 = -lib_default48(1 - p101);
      }
    } else {
      x0 = -lib_default48(q);
    }
    if (a === 1) {
      k = 2;
      xr = x0;
    } else {
      lgama = lib_default167(a);
      k = 1;
    }
  }
  if (q < 1e-30 && a < HALF5) {
    m = 0;
    x0 = -lib_default48(q * lib_default159(a)) + (a - 1) * lib_default48(-lib_default48(q * lib_default159(a)));
    k = 1;
    lgama = lib_default167(a);
  }
  if (a > 1 && a < 500 && p101 < 1e-80) {
    m = 0;
    ainv = 1 / a;
    ap1inv = 1 / (a + 1);
    x0 = (lib_default167(a + 1) + lib_default48(p101)) * ainv;
    x0 = lib_default138(x0);
    xini = x0;
    for (i = 0; i < 10; i++) {
      x0 = xini * lib_default138(x0 * ainv) * lib_default142(1 - x0 * ap1inv, ainv);
    }
    k = 1;
    lgama = lib_default167(a);
  }
  logr = 1 / a * (lib_default48(p101) + lib_default167(a + 1));
  if (logr < lib_default48(ONEO5 * (1 + a)) && k === 0) {
    r = lib_default138(logr);
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
    CK[2] = HALF5 * (3 * a + 5) / (ap12 * ap2);
    CK[3] = ONEO3 * (31 + 8 * a2 + 33 * a) / (ap13 * ap2 * ap3);
    CK[4] = ONEO24 * (2888 + 1179 * a3 + 125 * a4 + 3971 * a2 + 5661 * a) / (ap14 * ap22 * ap3 * (a + 4));
    x0 = r * lib_default174(CK, r);
    lgama = lib_default167(a);
    k = 1;
  }
  if (a < 10 && k === 0) {
    vgam = lib_default31(a) / (gamstar_default(a) * lib_default157);
    vmin = lib_default151(0.02, vgam);
    if (q < vmin) {
      m = 0;
      b = 1 - a;
      b2 = b * b;
      b3 = b2 * b;
      eta2 = lib_default31(-2 / a * lib_default48(q / vgam));
      x0 = a * lambdaeta_default(eta2);
      L = lib_default48(x0);
      if (x0 > 5) {
        L2 = L * L;
        L3 = L2 * L;
        L4 = L3 * L;
        r = 1 / x0;
        CK[0] = L - 1;
        CK[1] = (3 * b - 2 * b * L + L2 - 2 * L + 2) * HALF5;
        CK[2] = (24 * b * L - 11 * b2 - 24 * b - 6 * L2 + 12 * L - 12 - 9 * b * L2 + 6 * b2 * L + 2 * L3) * ONEO6;
        CK[3] = (-12 * b3 * L + 8.04 * b * L2 - 114 * b2 * L + (72 + 36 * L2) + (3 * L4 - 72 * L + 162) * (b - 168 * b * L) - (12 * L3 + 25 * b3) - (22 * b * L3 + 36 * b2 * L2 + 120 * b2)) * ONEO122;
        CK[4] = 0;
        x0 = x0 - L + b * r * lib_default174(CK, r);
      } else {
        r = 1 / x0;
        L2 = L * L;
        ck = L - 1;
        t = L - b * r * ck;
        if (t < x0) {
          x0 -= t;
        }
      }
      lgama = lib_default167(a);
      k = 1;
    }
  }
  if (lib_default(porq - HALF5) < 1e-5 && k === 0) {
    m = 0;
    ainv = 1 / a;
    x0 = a - ONEO3 + (0.019753086419753086 + 0.007211444248481286 * ainv) * ainv;
    lgama = lib_default167(a);
    k = 1;
  }
  if (a < 1 && k === 0) {
    m = 0;
    if (pcase) {
      x0 = lib_default138(1 / a * (lib_default48(porq) + lib_default167(a + 1)));
    } else {
      x0 = lib_default138(1 / a * (lib_default48(1 - porq) + lib_default167(a + 1)));
    }
    lgama = lib_default167(a);
    k = 1;
  }
  if (k === 0) {
    m = 1;
    ainv = 1 / a;
    r = lib_default190(2 * porq);
    eta2 = s * r / lib_default31(a * HALF5);
    if (r < lib_default193) {
      eta2 += (eps1_default(eta2) + (eps2_default(eta2) + eps3_default(eta2) * ainv) * ainv) * ainv;
      x0 = a * lambdaeta_default(eta2);
      y = eta2;
      fp = -lib_default31(a / lib_default176) * lib_default138(-HALF5 * a * y * y) / gamstar_default(a);
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
  if (lib_default30(p101) || lib_default30(a)) {
    return NaN;
  }
  if (a < lib_default180) {
    return NaN;
  }
  if (p101 > 1 || p101 < 0) {
    return NaN;
  }
  if (upper === true) {
    if (p101 === 0) {
      return lib_default43;
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
    return lib_default43;
  }
  return compute_default(a, p101, 1 - p101);
}
var main_default145 = gammaincinv;

var lib_default195 = main_default145;

var FLOAT64_SMALLEST_SUBNORMAL = 5e-324;
var lib_default196 = FLOAT64_SMALLEST_SUBNORMAL;

function temme3(a, b, p101, q) {
  var cross;
  var roots;
  var lower;
  var upper;
  var eta0;
  var eta2;
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
    eta0 = lib_default195(p101, b, true);
  } else {
    eta0 = lib_default195(q, b, false);
  }
  eta0 /= a;
  mu = b / a;
  w = lib_default31(1 + mu);
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
  eta2 = eta0 + e1 / a + e2 / (a * a) + e3 / (a * a * a);
  if (eta2 <= 0) {
    eta2 = lib_default196;
  }
  u = eta2 - mu * lib_default48(eta2) + (1 + mu) * lib_default48(1 + mu) - mu;
  cross = 1 / (1 + mu);
  lower = eta2 < mu ? cross : 0;
  upper = eta2 < mu ? 1 : cross;
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
  factor = lib_default125(1, 1 - digits);
  delta = lib_default149(1e7 * guess, 1e7);
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
      if (lib_default192(f0Last) * lib_default192(f0) < 0) {
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
      if (lib_default(num) < 1 && lib_default(denom) >= lib_default(num) * lib_default152) {
        delta = f0 / f1;
      } else {
        delta = denom / num;
      }
      if (delta * f1 / f0 < 0) {
        delta = f0 / f1;
        if (lib_default(delta) > 2 * lib_default(guess)) {
          delta = (delta < 0 ? -1 : 1) * 2 * lib_default(guess);
        }
      }
    }
    convergence = lib_default(delta / delta2);
    if (convergence > 0.8 && convergence < 2) {
      delta = delta > 0 ? (result - minimum) / 2 : (result - maximum) / 2;
      if (lib_default(delta) > result) {
        delta = lib_default192(delta) * result;
      }
      delta2 = delta * 3;
    }
    guess = result;
    result -= delta;
    if (result < minimum) {
      if (lib_default(minimum) < 1 && lib_default(result) > 1 && lib_default152 / lib_default(result) < lib_default(minimum)) {
        diff = 1e3;
      } else {
        diff = result / minimum;
      }
      if (lib_default(diff) < 1) {
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
      if (lib_default(maximum) < 1 && lib_default(result) > 1 && lib_default152 / lib_default(result) < lib_default(maximum)) {
        diff = 1e3;
      } else {
        diff = result / maximum;
      }
      if (lib_default(diff) < 1) {
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
  } while (count && lib_default(result * factor) < lib_default(delta));
  return result;
}
var halley_iterate_default = halleyIterate;

var kernelBetainc3 = lib_default188.assign;
function ibetaRoots(a, b, target, invert) {
  return roots;
  function roots(x) {
    var buf;
    var f1;
    var f2;
    var f;
    var y;
    y = 1 - x;
    buf = [0, 0];
    kernelBetainc3(x, a, b, true, invert, buf, 1, 0);
    f = buf[0] - target;
    f1 = buf[1];
    if (invert) {
      f1 = -f1;
    }
    if (y === 0) {
      y = lib_default123 * 64;
    }
    if (x === 0) {
      x = lib_default123 * 64;
    }
    f2 = f1 * (-(y * a) + (b - 2) * x + 1);
    if (lib_default(f2) < y * x * lib_default152) {
      f2 /= y * x;
    }
    if (invert) {
      f2 = -f2;
    }
    if (f1 === 0) {
      f1 = (invert ? -1 : 1) * lib_default123 * 64;
    }
    return [f, f1, f2];
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
  var tmp7;
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
    tmp7 = b;
    b = a;
    a = tmp7;
    tmp7 = q;
    q = p101;
    p101 = tmp7;
    invert = true;
  }
  x = 0;
  lower = 0;
  upper = 1;
  if (a === 0.5) {
    if (b === 0.5) {
      x = lib_default156(p101 * lib_default54);
      x *= x;
      y = lib_default156(q * lib_default54);
      y *= y;
      return [x, y];
    }
    if (b > 0.5) {
      tmp7 = b;
      b = a;
      a = tmp7;
      tmp7 = q;
      q = p101;
      p101 = tmp7;
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
        x = lib_default142(p101, 1 / a);
        y = -lib_default147(lib_default48(p101) / a);
      } else {
        x = lib_default142(p101, 1 / a);
        y = 1 - x;
      }
    } else {
      x = lib_default138(lib_default46(-q) / a);
      y = -lib_default147(lib_default46(-q) / a);
    }
    if (invert) {
      tmp7 = y;
      y = x;
      x = tmp7;
    }
    return [x, y];
  } else if (a + b > 5) {
    if (p101 > 0.5) {
      tmp7 = b;
      b = a;
      a = tmp7;
      tmp7 = q;
      q = p101;
      p101 = tmp7;
      invert = !invert;
    }
    minv = lib_default151(a, b);
    maxv = lib_default149(a, b);
    if (lib_default31(minv) > maxv - minv && minv > 5) {
      x = temme1_default(a, b, p101);
      y = 1 - x;
    } else {
      r = a + b;
      theta = lib_default33(lib_default31(a / r));
      lambda = minv / r;
      if (lambda >= 0.2 && lambda <= 0.8 && r >= 10) {
        ppa = lib_default142(p101, 1 / a);
        if (ppa < 25e-4 && a + b < 200) {
          x = ppa * lib_default142(a * lib_default145(a, b), 1 / a);
        } else {
          x = temme2_default(p101, r, theta);
        }
        y = 1 - x;
      } else {
        if (a < b) {
          tmp7 = b;
          b = a;
          a = tmp7;
          tmp7 = q;
          q = p101;
          p101 = tmp7;
          invert = !invert;
        }
        bet = 0;
        if (b < 2) {
          bet = lib_default145(a, b);
        }
        if (bet === 0) {
          y = 1;
        } else {
          y = lib_default142(b * q * bet, 1 / b);
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
    fs = lib_default189(xs, a, b) - p101;
    if (lib_default(fs) / p101 < lib_default144 * 3) {
      if (invert) {
        return [1 - xs, xs];
      }
      return [xs, 1 - xs];
    }
    if (fs < 0) {
      tmp7 = b;
      b = a;
      a = tmp7;
      tmp7 = q;
      q = p101;
      p101 = tmp7;
      invert = !invert;
      xs = 1 - xs;
    }
    xg = lib_default142(a * p101 * lib_default145(a, b), 1 / a);
    x = xg / (1 + xg);
    y = 1 / (1 + xg);
    if (x > xs) {
      x = xs;
    }
    upper = xs;
  } else if (a > 1 && b > 1) {
    xs = (a - 1) / (a + b - 2);
    xs2 = (b - 1) / (a + b - 2);
    ps = lib_default189(xs, a, b) - p101;
    if (ps < 0) {
      tmp7 = b;
      b = a;
      a = tmp7;
      tmp7 = q;
      q = p101;
      p101 = tmp7;
      tmp7 = xs2;
      xs2 = xs;
      xs = tmp7;
      invert = !invert;
    }
    lx = lib_default48(p101 * a * lib_default145(a, b)) / a;
    x = lib_default138(lx);
    y = x < 0.9 ? 1 - x : -lib_default147(lx);
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
      x = lib_default174(terms3, x);
    }
    if (x > xs) {
      x = xs;
    }
    upper = xs;
  } else {
    if (b < a) {
      tmp7 = b;
      b = a;
      a = tmp7;
      tmp7 = q;
      q = p101;
      p101 = tmp7;
      invert = !invert;
    }
    if (lib_default142(p101, 1 / a) < 0.5) {
      x = lib_default142(p101 * a * lib_default145(a, b), 1 / a);
      if (x === 0) {
        x = lib_default123;
      }
      y = 1 - x;
    } else {
      y = lib_default142(1 - lib_default142(p101, b * lib_default145(a, b)), 1 / b);
      if (y === 0) {
        y = lib_default123;
      }
      x = 1 - y;
    }
  }
  if (x > 0.5) {
    tmp7 = b;
    b = a;
    a = tmp7;
    tmp7 = q;
    q = p101;
    p101 = tmp7;
    tmp7 = y;
    y = x;
    x = tmp7;
    invert = !invert;
    l = 1 - upper;
    u = 1 - lower;
    lower = l;
    upper = u;
  }
  if (lower === 0) {
    if (invert) {
      lower = lib_default144;
      if (x < lower) {
        x = lower;
      }
    } else {
      lower = lib_default123;
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
var main_default146 = ibetaInvImp;

var lib_default197 = main_default146;

function betaincinv(p101, a, b, upper) {
  if (lib_default30(p101) || lib_default30(a) || lib_default30(b)) {
    return NaN;
  }
  if (a <= 0 || b <= 0) {
    return NaN;
  }
  if (p101 < 0 || p101 > 1) {
    return NaN;
  }
  if (upper) {
    return lib_default197(a, b, 1 - p101, p101)[0];
  }
  return lib_default197(a, b, p101, 1 - p101)[0];
}
var main_default147 = betaincinv;

var lib_default198 = main_default147;

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
    return dceval_default(2 * lib_default142(10 / x, 2) - 1) / x;
  }
  return 1 / (x * 12);
}
var gamma_correction_default = gammaCorrection;

function betaln(a, b) {
  var corr;
  var p101;
  var q;
  p101 = lib_default151(a, b);
  q = lib_default149(a, b);
  if (p101 < 0) {
    return NaN;
  }
  if (p101 === 0) {
    return lib_default43;
  }
  if (q === lib_default43) {
    return lib_default44;
  }
  if (p101 >= 10) {
    corr = gamma_correction_default(p101) + gamma_correction_default(q) - gamma_correction_default(p101 + q);
    return -0.5 * lib_default48(q) + lib_default194 + corr + (p101 - 0.5) * lib_default48(p101 / (p101 + q)) + q * lib_default46(-p101 / (p101 + q));
  }
  if (q >= 10) {
    corr = gamma_correction_default(q) - gamma_correction_default(p101 + q);
    return lib_default167(p101) + corr + p101 - p101 * lib_default48(p101 + q) + (q - 0.5) * lib_default46(-p101 / (p101 + q));
  }
  return lib_default48(lib_default159(p101) * (lib_default159(q) / lib_default159(p101 + q)));
}
var main_default148 = betaln;

var lib_default199 = main_default148;

var MAX_INTEGER_P1 = lib_default185 + 1;
function cospi(x) {
  var ax;
  var ix;
  var rx;
  var y;
  if (lib_default30(x)) {
    return NaN;
  }
  if (lib_default76(x)) {
    return NaN;
  }
  ax = lib_default(x);
  if (ax > MAX_INTEGER_P1) {
    return 1;
  }
  ix = lib_default105(ax);
  rx = ax - ix;
  if (rx === 0.5) {
    return 0;
  }
  if (rx < 0.25) {
    y = lib_default165(lib_default26 * rx);
  } else if (rx < 0.75) {
    rx = 0.5 - rx;
    y = lib_default156(lib_default26 * rx);
  } else {
    rx = 1 - rx;
    y = -lib_default165(lib_default26 * rx);
  }
  return ix % 2 === 1 ? -y : y;
}
var main_default149 = cospi;

var lib_default200 = main_default149;

var PHI = 1.618033988749895;
var lib_default201 = PHI;

var SQRT_5 = 2.23606797749979;
function binet(x) {
  var a;
  var b;
  if (lib_default30(x) || x === lib_default43 || x === lib_default44) {
    return NaN;
  }
  a = lib_default142(lib_default201, x);
  b = lib_default200(x) / a;
  return (a - b) / SQRT_5;
}
var main_default150 = binet;

var lib_default202 = main_default150;

var FLOAT32_MAX_SAFE_INTEGER = 16777215;
var lib_default203 = FLOAT32_MAX_SAFE_INTEGER;

function gcdf(a, b) {
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
var bitwise_binary_gcd_default2 = gcdf;

function gcdf2(a, b) {
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
var binary_gcd_default2 = gcdf2;

function gcdf3(a, b) {
  if (lib_default6(a) || lib_default6(b)) {
    return NaN;
  }
  if (a === lib_default7 || b === lib_default7 || a === lib_default8 || b === lib_default8) {
    return NaN;
  }
  if (!(lib_default112(a) && lib_default112(b))) {
    return NaN;
  }
  if (a < 0) {
    a = -a;
  }
  if (b < 0) {
    b = -b;
  }
  if (a <= lib_default153 && b <= lib_default153) {
    return bitwise_binary_gcd_default2(a, b);
  }
  return binary_gcd_default2(a, b);
}
var main_default151 = gcdf3;

var lib_default204 = main_default151;

function binomcoeff(n, k) {
  var res;
  var sgn;
  var b;
  var c2;
  var d2;
  var g;
  var s;
  if (lib_default6(n) || lib_default6(k)) {
    return NaN;
  }
  if (!lib_default112(n) || !lib_default112(k)) {
    return NaN;
  }
  if (k < 0) {
    return 0;
  }
  sgn = lib_default3(1);
  if (n < 0) {
    n = -n + k - 1;
    if (lib_default114(k)) {
      sgn = lib_default3(sgn * -1);
    }
  }
  if (k > n) {
    return 0;
  }
  if (k === 0 || k === n) {
    return sgn;
  }
  if (k === 1 || k === n - 1) {
    return lib_default3(sgn * n);
  }
  if (n - k < k) {
    k = n - k;
  }
  s = lib_default16(lib_default203 / n);
  res = lib_default3(1);
  for (d2 = 1; d2 <= k; d2++) {
    if (res > s) {
      break;
    }
    res = lib_default3(res * n);
    res = lib_default3(res / d2);
    n -= 1;
  }
  if (d2 > k) {
    return lib_default3(sgn * res);
  }
  b = binomcoeff(n, k - d2 + 1);
  if (b === lib_default7) {
    return lib_default3(sgn * lib_default3(b));
  }
  c2 = binomcoeff(k, k - d2 + 1);
  g = lib_default204(b, c2);
  b = lib_default3(b / g);
  c2 = lib_default3(c2 / g);
  res = lib_default3(res / c2);
  return lib_default3(sgn * res * b);
}
var main_default152 = binomcoeff;

var lib_default205 = main_default152;

function binomcoefln(n, k) {
  if (lib_default30(n) || lib_default30(k)) {
    return NaN;
  }
  if (!lib_default107(n) || !lib_default107(k)) {
    return NaN;
  }
  if (n < 0) {
    return binomcoefln(-n + k - 1, k);
  }
  if (k < 0) {
    return lib_default44;
  }
  if (k === 0) {
    return 0;
  }
  if (k === 1) {
    return lib_default48(lib_default(n));
  }
  if (n < k) {
    return lib_default44;
  }
  if (n - k < 2) {
    return binomcoefln(n, n - k);
  }
  return -lib_default48(n + 1) - lib_default199(n - k + 1, k + 1);
}
var main_default153 = binomcoefln;

var lib_default206 = main_default153;

function boxcox(x, lambda) {
  if (lib_default30(x) || lib_default30(lambda)) {
    return NaN;
  }
  if (lib_default148(x) && lambda < 0) {
    return lib_default44;
  }
  if (lib_default(lambda) < 1e-19) {
    return lib_default48(x);
  }
  return lib_default147(lambda * lib_default48(x)) / lambda;
}
var main_default154 = boxcox;

var lib_default207 = main_default154;

function boxcox1p(x, lambda) {
  var lgx;
  if (lib_default30(x) || lib_default30(lambda) || x < -1) {
    return NaN;
  }
  if (x === -1 && lambda < 0) {
    return lib_default44;
  }
  lgx = lib_default46(x);
  if (lib_default(lambda) < 1e-19 || lib_default(lgx) < 1e-289 && lib_default(lambda) < 1e273) {
    return lgx;
  }
  return lib_default147(lambda * lgx) / lambda;
}
var main_default155 = boxcox1p;

var lib_default208 = main_default155;

function boxcox1pinv(y, lambda) {
  var ly;
  if (lib_default30(y) || lib_default30(lambda)) {
    return NaN;
  }
  if (lambda === 0) {
    return lib_default147(y);
  }
  ly = lambda * y;
  if (lib_default(ly) < 1e-154) {
    return y;
  }
  return lib_default147(lib_default46(ly) / lambda);
}
var main_default156 = boxcox1pinv;

var lib_default209 = main_default156;

function boxcoxinv(y, lambda) {
  if (lib_default30(y) || lib_default30(lambda)) {
    return NaN;
  }
  if (lambda === 0) {
    return lib_default138(y);
  }
  return lib_default138(lib_default46(lambda * y) / lambda);
}
var main_default157 = boxcoxinv;

var lib_default210 = main_default157;

function evalpoly85(x) {
  if (x === 0) {
    return 1.87595182427177;
  }
  return 1.87595182427177 + x * (-1.8849797954337717 + x * (1.6214297201053545 + x * (-0.758397934778766 + x * 0.14599619288661245)));
}
var polyval_p_default6 = evalpoly85;

var HIGH_WORD_MASK = 4294967295 >>> 0;
var LOW_WORD_MASK = 3221225472 >>> 0;
var TWO_54 = 18014398509481984;
var TWO_31 = 2147483648 >>> 0;
var ONE8 = 1 >>> 0;
var B1 = 715094163 >>> 0;
var B2 = 696219795 >>> 0;
var FLOAT64_SMALLEST_NORMAL_HIGH_WORD = lib_default41(lib_default123);
var WORDS4 = [0 >>> 0, 0 >>> 0];
function cbrt(x) {
  var sgn;
  var hx;
  var hw;
  var r;
  var s;
  var t;
  var w;
  if (x === 0 || // handles +-0
  lib_default30(x) || lib_default76(x)) {
    return x;
  }
  hx = lib_default41(x) >>> 0;
  sgn = (hx & lib_default91) >>> 0;
  hx &= lib_default92;
  if (hx < FLOAT64_SMALLEST_NORMAL_HIGH_WORD) {
    t = TWO_54 * x;
    hw = (lib_default41(t) & lib_default92) >>> 0;
    hw = (hw / 3 >>> 0) + B2 >>> 0;
    t = lib_default94(sgn | hw, 0);
  } else {
    t = 0;
    hw = (hx / 3 >>> 0) + B1 >>> 0;
    t = lib_default42(t, sgn | hw);
  }
  r = t * t * (t / x);
  t *= polyval_p_default6(r);
  lib_default93.assign(t, WORDS4, 1, 0);
  if (WORDS4[1] & TWO_31) {
    WORDS4[0] += ONE8;
    WORDS4[1] &= ~TWO_31;
  } else {
    WORDS4[1] |= TWO_31;
  }
  t = lib_default94(WORDS4[0] & HIGH_WORD_MASK, WORDS4[1] & LOW_WORD_MASK);
  s = t * t;
  r = x / s;
  w = t + t;
  r = (r - t) / (w + r);
  t += t * r;
  return t;
}
var main_default158 = cbrt;

var lib_default211 = main_default158;

function cbrtf(x) {
  return lib_default3(lib_default211(lib_default3(x)));
}
var main_default159 = cbrtf;

var lib_default212 = main_default159;

function evalpoly86(x) {
  if (x === 0) {
    return 0.3999999999940942;
  }
  return 0.3999999999940942 + x * (0.22222198432149784 + x * 0.15313837699209373);
}
var polyval_p_default7 = evalpoly86;

function evalpoly87(x) {
  if (x === 0) {
    return 0.6666666666666735;
  }
  return 0.6666666666666735 + x * (0.2857142874366239 + x * (0.1818357216161805 + x * 0.14798198605116586));
}
var polyval_q_default5 = evalpoly87;

function kernelLog1p(f) {
  var hfsq;
  var t1;
  var t2;
  var s;
  var z;
  var R;
  var w;
  s = f / (2 + f);
  z = s * s;
  w = z * z;
  t1 = w * polyval_p_default7(w);
  t2 = z * polyval_q_default5(w);
  R = t2 + t1;
  hfsq = 0.5 * f * f;
  return s * (hfsq + R);
}
var main_default160 = kernelLog1p;

var lib_default213 = main_default160;

var TWO542 = 18014398509481984;
var IVLN10HI = 0.4342944818781689;
var IVLN10LO = 25082946711645275e-27;
var LOG10_2HI = 0.30102999566361177;
var LOG10_2LO = 3694239077158931e-28;
var HIGH_MAX_NORMAL_EXP2 = 2146435072 | 0;
var HIGH_MIN_NORMAL_EXP4 = 1048576 | 0;
var HIGH_BIASED_EXP_04 = 1072693248 | 0;
var WORDS5 = [0 | 0, 0 | 0];
function log10(x) {
  var valHi;
  var valLo;
  var hfsq;
  var hi;
  var lo;
  var hx;
  var lx;
  var y2;
  var f;
  var R;
  var w;
  var y;
  var i;
  var k;
  if (lib_default30(x) || x < 0) {
    return NaN;
  }
  lib_default93.assign(x, WORDS5, 1, 0);
  hx = WORDS5[0] | 0;
  lx = WORDS5[1];
  k = 0 | 0;
  if (hx < HIGH_MIN_NORMAL_EXP4) {
    if ((hx & lib_default92 | lx) === 0) {
      return lib_default44;
    }
    k -= 54 | 0;
    x *= TWO542;
    hx = lib_default41(x) | 0;
  }
  if (hx >= HIGH_MAX_NORMAL_EXP2) {
    return x + x;
  }
  if (hx === HIGH_BIASED_EXP_04 && lx === 0) {
    return 0;
  }
  k += (hx >> 20) - lib_default45 | 0;
  hx &= lib_default117;
  i = hx + 614244 & HIGH_MIN_NORMAL_EXP4 | 0;
  x = lib_default42(x, hx | i ^ HIGH_BIASED_EXP_04);
  k += i >> 20 | 0;
  y = k;
  f = x - 1;
  hfsq = 0.5 * f * f;
  R = lib_default213(f);
  hi = f - hfsq;
  hi = lib_default139(hi, 0);
  lo = f - hi - hfsq + R;
  valHi = hi * IVLN10HI;
  y2 = y * LOG10_2HI;
  valLo = y * LOG10_2LO + (lo + hi) * IVLN10LO + lo * IVLN10HI;
  w = y2 + valHi;
  valLo += y2 - w + valHi;
  valHi = w;
  return valLo + valHi;
}
var main_default161 = log10;

var lib_default214 = main_default161;

var FLOAT64_MAX_BASE10_EXPONENT = 308 | 0;
var lib_default215 = FLOAT64_MAX_BASE10_EXPONENT;

var FLOAT64_MIN_BASE10_EXPONENT_SUBNORMAL = -324 | 0;
var lib_default216 = FLOAT64_MIN_BASE10_EXPONENT_SUBNORMAL;

function ceil10(x) {
  var sign;
  var p101;
  if (lib_default30(x) || lib_default76(x) || x === 0) {
    return x;
  }
  if (x < 0) {
    x = -x;
    sign = -1;
  } else {
    sign = 1;
  }
  p101 = lib_default214(x);
  if (sign === -1) {
    p101 = lib_default105(p101);
  } else {
    p101 = lib_default136(p101);
  }
  if (p101 <= lib_default216) {
    return sign * 0;
  }
  if (p101 > lib_default215) {
    return lib_default43;
  }
  return sign * lib_default142(10, p101);
}
var main_default162 = ceil10;

var lib_default217 = main_default162;

var TWO543 = 18014398509481984;
var IVLN2HI = 1.4426950407214463;
var IVLN2LO = 16751713164886512e-26;
var HIGH_MAX_NORMAL_EXP3 = 2146435072 | 0;
var HIGH_MIN_NORMAL_EXP5 = 1048576 | 0;
var HIGH_BIASED_EXP_05 = 1072693248 | 0;
var WORDS6 = [0 | 0, 0 | 0];
function log2(x) {
  var valHi;
  var valLo;
  var hfsq;
  var hx;
  var lx;
  var hi;
  var lo;
  var f;
  var R;
  var w;
  var y;
  var i;
  var k;
  if (lib_default30(x) || x < 0) {
    return NaN;
  }
  lib_default93.assign(x, WORDS6, 1, 0);
  hx = WORDS6[0] | 0;
  lx = WORDS6[1];
  k = 0 | 0;
  if (hx < HIGH_MIN_NORMAL_EXP5) {
    if ((hx & lib_default92 | lx) === 0) {
      return lib_default44;
    }
    k -= 54 | 0;
    x *= TWO543;
    hx = lib_default41(x) | 0;
  }
  if (hx >= HIGH_MAX_NORMAL_EXP3) {
    return x + x;
  }
  if (hx === HIGH_BIASED_EXP_05 && lx === 0) {
    return 0;
  }
  k += (hx >> 20) - lib_default45 | 0;
  hx &= lib_default117;
  i = hx + 614244 & HIGH_MIN_NORMAL_EXP5 | 0;
  x = lib_default42(x, hx | i ^ HIGH_BIASED_EXP_05);
  k += i >> 20 | 0;
  y = k;
  f = x - 1;
  hfsq = 0.5 * f * f;
  R = lib_default213(f);
  hi = f - hfsq;
  hi = lib_default139(hi, 0);
  lo = f - hi - hfsq + R;
  valHi = hi * IVLN2HI;
  valLo = (lo + hi) * IVLN2LO + lo * IVLN2HI;
  w = y + valHi;
  valLo += y - w + valHi;
  valHi = w;
  return valLo + valHi;
}
var main_default163 = log2;

var lib_default218 = main_default163;

function ceil2(x) {
  var sign;
  var p101;
  if (lib_default30(x) || lib_default76(x) || x === 0) {
    return x;
  }
  if (x < 0) {
    x = -x;
    sign = -1;
  } else {
    sign = 1;
  }
  p101 = lib_default218(x);
  if (p101 === lib_default121) {
    return x;
  }
  if (sign === -1) {
    p101 = lib_default105(p101);
  } else {
    p101 = lib_default136(p101);
  }
  if (p101 > lib_default119) {
    return lib_default43;
  }
  return sign * lib_default142(2, p101);
}
var main_default164 = ceil2;

var lib_default219 = main_default164;

var FLOAT64_MIN_BASE10_EXPONENT = -308 | 0;
var lib_default220 = FLOAT64_MIN_BASE10_EXPONENT;

var MAX_INT = lib_default185 + 1;
var HUGE7 = 1e308;
function ceiln(x, n) {
  var s;
  var y;
  if (lib_default30(x) || lib_default30(n) || lib_default76(n)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0 || n < lib_default216 || lib_default(x) > MAX_INT && n <= 0) {
    return x;
  }
  if (n > lib_default215) {
    if (x <= 0) {
      return -0;
    }
    return lib_default43;
  }
  if (n < lib_default220) {
    s = lib_default142(10, -(n + lib_default215));
    y = x * HUGE7 * s;
    if (lib_default76(y)) {
      return x;
    }
    return lib_default136(y) / HUGE7 / s;
  }
  s = lib_default142(10, -n);
  y = x * s;
  if (lib_default76(y)) {
    return x;
  }
  return lib_default136(y) / s;
}
var main_default165 = ceiln;

var lib_default221 = main_default165;

function ceilb(x, n, b) {
  var y;
  var s;
  if (lib_default30(x) || lib_default30(n) || lib_default30(b) || b <= 0 || lib_default76(n) || lib_default76(b)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0) {
    return x;
  }
  if (b === 10) {
    return lib_default221(x, n);
  }
  if (n === 0 || b === 1) {
    return lib_default136(x);
  }
  s = lib_default142(b, -n);
  if (lib_default76(s)) {
    return x;
  }
  y = lib_default136(x * s) / s;
  if (lib_default76(y)) {
    return x;
  }
  return y;
}
var main_default166 = ceilb;

var lib_default222 = main_default166;

function ceilsd(x, n, b) {
  var exp3;
  var s;
  var y;
  if (lib_default30(x) || lib_default30(n) || n < 1 || lib_default76(n) || lib_default30(b) || b <= 0 || lib_default76(b)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0) {
    return x;
  }
  if (b === 10) {
    exp3 = lib_default214(lib_default(x));
  } else if (b === 2) {
    exp3 = lib_default122(lib_default(x));
  } else {
    exp3 = lib_default48(lib_default(x)) / lib_default48(b);
  }
  exp3 = lib_default105(exp3 - n + 1);
  s = lib_default142(b, lib_default(exp3));
  if (lib_default76(s)) {
    return x;
  }
  if (exp3 < 0) {
    y = lib_default136(x * s) / s;
  } else {
    y = lib_default136(x / s) * s;
  }
  if (lib_default76(y)) {
    return x;
  }
  return y;
}
var main_default167 = ceilsd;

var lib_default223 = main_default167;

function clamp(v3, min3, max3) {
  if (lib_default30(v3) || lib_default30(min3) || lib_default30(max3)) {
    return NaN;
  }
  if (v3 < min3) {
    return min3;
  }
  if (v3 > max3) {
    return max3;
  }
  if (min3 === 0 && lib_default150(v3)) {
    return min3;
  }
  if (v3 === 0 && lib_default150(max3)) {
    return max3;
  }
  return v3;
}
var main_default168 = clamp;

var lib_default224 = main_default168;

function isNegativeZerof(x) {
  return x === 0 && 1 / x === lib_default8;
}
var main_default169 = isNegativeZerof;

var lib_default225 = main_default169;

function clampf(v3, min3, max3) {
  if (lib_default6(v3) || lib_default6(min3) || lib_default6(max3)) {
    return NaN;
  }
  if (v3 < min3) {
    return min3;
  }
  if (v3 > max3) {
    return max3;
  }
  if (min3 === 0 && lib_default225(v3)) {
    return min3;
  }
  if (v3 === 0 && lib_default225(max3)) {
    return max3;
  }
  return v3;
}
var main_default170 = clampf;

var lib_default226 = main_default170;

var PI_DIV_180 = 0.017453292519943295;
function deg2rad(x) {
  return x * PI_DIV_180;
}
var main_default171 = deg2rad;

var lib_default227 = main_default171;

function fmod(x, y) {
  return x % y;
}
var main_default172 = fmod;

var lib_default228 = main_default172;

function cosd(x) {
  var rx;
  if (lib_default76(x) || lib_default30(x)) {
    return NaN;
  }
  rx = lib_default(lib_default228(x, 360));
  if (rx <= 45) {
    return lib_default154(lib_default227(rx), 0);
  }
  if (rx < 135) {
    return lib_default155(lib_default227(90 - rx), 0);
  }
  if (rx <= 225) {
    return -lib_default154(lib_default227(180 - rx), 0);
  }
  if (rx < 315) {
    return lib_default155(lib_default227(rx - 270), 0);
  }
  return lib_default154(lib_default227(360 - rx), 0);
}
var main_default173 = cosd;

var lib_default229 = main_default173;

var PI_DIV_1802 = lib_default3(0.017453292519943295);
function deg2radf(x) {
  return lib_default3(lib_default3(x) * PI_DIV_1802);
}
var main_default174 = deg2radf;

var lib_default230 = main_default174;

function fmodf(x, y) {
  return lib_default3(lib_default3(x) % lib_default3(y));
}
var main_default175 = fmodf;

var lib_default231 = main_default175;

var DEG_45 = lib_default3(45);
var DEG_90 = lib_default3(90);
var DEG_135 = lib_default3(135);
var DEG_180 = lib_default3(180);
var DEG_225 = lib_default3(225);
var DEG_270 = lib_default3(270);
var DEG_315 = lib_default3(315);
var DEG_360 = lib_default3(360);
function cosdf(x) {
  var rx;
  x = lib_default3(x);
  if (lib_default9(x) || lib_default6(x)) {
    return NaN;
  }
  rx = lib_default5(lib_default231(x, DEG_360));
  if (rx <= DEG_45) {
    return lib_default19(lib_default230(rx));
  }
  if (rx < DEG_135) {
    return lib_default20(lib_default230(lib_default3(DEG_90 - rx)));
  }
  if (rx <= DEG_225) {
    return -lib_default19(lib_default230(lib_default3(DEG_180 - rx)));
  }
  if (rx < DEG_315) {
    return lib_default20(lib_default230(lib_default3(rx - DEG_270)));
  }
  return lib_default19(lib_default230(lib_default3(DEG_360 - rx)));
}
var main_default176 = cosdf;

var lib_default232 = main_default176;

function roundf(x) {
  if (lib_default6(x)) {
    return NaN;
  }
  if (lib_default225(x) || x >= -0.5 && x < 0) {
    return -0;
  }
  if (x > 0 && x < 0.5) {
    return 0;
  }
  if (x >= 8388608 || x <= -8388608) {
    return x;
  }
  return lib_default16(lib_default3(x + 0.5));
}
var main_default177 = roundf;

var lib_default233 = main_default177;

var IPIO22 = [
  10680707,
  7228996,
  1387004,
  2578385,
  16069853,
  12639074,
  9804092,
  4427841,
  16666979
];
var PIO23 = [
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
var TWO243 = 16777216;
var TWON242 = 5960464477539063e-23;
var F2 = lib_default127(20);
var Q2 = lib_default127(20);
var FQ2 = lib_default127(20);
var IQ2 = lib_default127(20);
function compute3(x, y, jz, q, q0, jk, jv, jx, f) {
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
    fw = TWON242 * z | 0;
    IQ2[i] = z - TWO243 * fw | 0;
    z = q[j - 1] + fw;
    j -= 1;
  }
  z = lib_default125(z, q0);
  z -= 8 * lib_default105(z * 0.125);
  n = z | 0;
  z -= n;
  ih = 0;
  if (q0 > 0) {
    i = IQ2[jz - 1] >> 24 - q0;
    n += i;
    IQ2[jz - 1] -= i << 24 - q0;
    ih = IQ2[jz - 1] >> 23 - q0;
  } else if (q0 === 0) {
    ih = IQ2[jz - 1] >> 23;
  } else if (z >= 0.5) {
    ih = 2;
  }
  if (ih > 0) {
    n += 1;
    carry = 0;
    for (i = 0; i < jz; i++) {
      j = IQ2[i];
      if (carry === 0) {
        if (j !== 0) {
          carry = 1;
          IQ2[i] = 16777216 - j;
        }
      } else {
        IQ2[i] = 16777215 - j;
      }
    }
    if (q0 > 0) {
      switch (q0) {
        // eslint-disable-line default-case
        case 1:
          IQ2[jz - 1] &= 8388607;
          break;
        case 2:
          IQ2[jz - 1] &= 4194303;
          break;
      }
    }
    if (ih === 2) {
      z = 1 - z;
      if (carry !== 0) {
        z -= lib_default125(1, q0);
      }
    }
  }
  if (z === 0) {
    j = 0;
    for (i = jz - 1; i >= jk; i--) {
      j |= IQ2[i];
    }
    if (j === 0) {
      for (k = 1; IQ2[jk - k] === 0; k++) {
      }
      for (i = jz + 1; i <= jz + k; i++) {
        f[jx + i] = IPIO22[jv + i];
        fw = 0;
        for (j = 0; j <= jx; j++) {
          fw += x[j] * f[jx + (i - j)];
        }
        q[i] = fw;
      }
      jz += k;
      return compute3(x, y, jz, q, q0, jk, jv, jx, f);
    }
    jz -= 1;
    q0 -= 24;
    while (IQ2[jz] === 0) {
      jz -= 1;
      q0 -= 24;
    }
  } else {
    z = lib_default125(z, -q0);
    if (z >= TWO243) {
      fw = TWON242 * z | 0;
      IQ2[jz] = z - TWO243 * fw | 0;
      jz += 1;
      q0 += 24;
      IQ2[jz] = fw;
    } else {
      IQ2[jz] = z | 0;
    }
  }
  fw = lib_default125(1, q0);
  for (i = jz; i >= 0; i--) {
    q[i] = fw * IQ2[i];
    fw *= TWON242;
  }
  for (i = jz; i >= 0; i--) {
    fw = 0;
    for (k = 0; k <= jp && k <= jz - i; k++) {
      fw += PIO23[k] * q[i + k];
    }
    FQ2[jz - i] = fw;
  }
  fw = 0;
  for (i = jz; i >= 0; i--) {
    fw += FQ2[i];
  }
  if (ih === 0) {
    y[0] = fw;
  } else {
    y[0] = -fw;
  }
  return n & 7;
}
function kernelRempio2f(x, y, e0, nx) {
  var fw;
  var jk;
  var jv;
  var jx;
  var jz;
  var q0;
  var i;
  var j;
  var m;
  jk = 3;
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
      F2[i] = 0;
    } else {
      F2[i] = IPIO22[j];
    }
    j += 1;
  }
  for (i = 0; i <= jk; i++) {
    fw = 0;
    for (j = 0; j <= jx; j++) {
      fw += x[j] * F2[jx + (i - j)];
    }
    Q2[i] = fw;
  }
  jz = jk;
  return compute3(x, y, jz, Q2, q0, jk, jv, jx, F2);
}
var kernel_rempio2f_default = kernelRempio2f;

var INVPIO22 = 0.6366197723675814;
var PIO2_13 = 1.5707963109016418;
var PIO2_1T3 = 15893254773528196e-24;
var MEDIUM2 = 1305022427 | 0;
var TX2 = [0];
var TY2 = [0];
function rempio2f(x, y) {
  var e0;
  var hx;
  var ix;
  var n;
  var r;
  var w;
  var z;
  x = lib_default3(x);
  hx = lib_default10(x) | 0;
  ix = hx & lib_default22 | 0;
  if (ix < MEDIUM2) {
    n = lib_default233(lib_default3(x * INVPIO22));
    r = x - n * PIO2_13;
    w = n * PIO2_1T3;
    y[0] = r - w;
    return n;
  }
  if (ix >= lib_default12) {
    y[0] = NaN;
    return 0;
  }
  e0 = (ix >> 23) - 150;
  z = lib_default11(ix - (e0 << 23 | 0));
  TX2[0] = z;
  n = kernel_rempio2f_default(TX2, TY2, e0, 1);
  if (hx < 0) {
    y[0] = -TY2[0];
    return -n;
  }
  y[0] = TY2[0];
  return n;
}
var main_default178 = rempio2f;

var lib_default234 = main_default178;

var PIO4_WORD = 1061752794 | 0;
var THREE_PIO4_WORD = 1075235811 | 0;
var FIVE_PIO4_WORD = 1081824209 | 0;
var SEVEN_PIO4_WORD = 1085271519 | 0;
var NINE_PIO4_WORD = 1088565717 | 0;
var SMALL_WORD2 = 964689920 | 0;
var PIO24 = lib_default54;
var PI2 = 2 * lib_default54;
var THREE_PIO2 = 3 * lib_default54;
var TWO_PI2 = 4 * lib_default54;
var Y6 = [0];
function cosf(x) {
  var hx;
  var ix;
  var n;
  hx = lib_default10(lib_default3(x)) | 0;
  ix = hx & lib_default22 | 0;
  if (ix <= PIO4_WORD) {
    if (ix < SMALL_WORD2) {
      return lib_default3(1);
    }
    return lib_default19(x);
  }
  if (ix <= FIVE_PIO4_WORD) {
    if (ix > THREE_PIO4_WORD) {
      if (hx > 0) {
        return lib_default3(-lib_default19(x - PI2));
      }
      return lib_default3(-lib_default19(x + PI2));
    }
    if (hx > 0) {
      return lib_default3(lib_default20(PIO24 - x));
    }
    return lib_default3(lib_default20(PIO24 + x));
  }
  if (ix <= NINE_PIO4_WORD) {
    if (ix > SEVEN_PIO4_WORD) {
      if (hx > 0) {
        return lib_default3(lib_default19(x - TWO_PI2));
      }
      return lib_default3(lib_default19(x + TWO_PI2));
    }
    if (hx > 0) {
      return lib_default3(lib_default20(x - THREE_PIO2));
    }
    return lib_default3(-lib_default20(x + THREE_PIO2));
  }
  if (ix >= lib_default12) {
    return NaN;
  }
  n = lib_default234(lib_default3(x), Y6);
  switch (n & 3) {
    case 0:
      return lib_default3(lib_default19(Y6[0]));
    case 1:
      return lib_default3(-lib_default20(Y6[0]));
    case 2:
      return lib_default3(-lib_default19(Y6[0]));
    default:
      return lib_default3(lib_default20(Y6[0]));
  }
}
var main_default179 = cosf;

var lib_default235 = main_default179;

function cosh(x) {
  if (lib_default30(x)) {
    return x;
  }
  if (x < 0) {
    x = -x;
  }
  if (x > 21) {
    return lib_default138(x) / 2;
  }
  return (lib_default138(x) + lib_default138(-x)) / 2;
}
var main_default180 = cosh;

var lib_default236 = main_default180;

var FLOAT32_MAX_LN = 88.72283935546875;
var lib_default237 = FLOAT32_MAX_LN;

var ZERO9 = lib_default3(0);
var ONE9 = lib_default3(1);
var TWO6 = lib_default3(2);
function coshf(x) {
  var z;
  if (lib_default6(x)) {
    return x;
  }
  if (x < ZERO9) {
    x = -x;
  }
  if (lib_default9(x) || x > lib_default237) {
    return lib_default7;
  }
  z = lib_default3(lib_default138(lib_default3(x)));
  z = lib_default3(z + ONE9 / z);
  return lib_default3(z / TWO6);
}
var main_default181 = coshf;

var lib_default238 = main_default181;

function evalpoly88(x) {
  if (x === 0) {
    return 0.041666666666666664;
  }
  return 0.041666666666666664 + x * (-0.0013888888888888872 + x * (2480158730157055e-20 + x * (-2755731921499979e-22 + x * (2087675428708152e-24 + x * (-1147028484342536e-26 + x * 4737750796424621e-29)))));
}
var polyval_p_default8 = evalpoly88;

var PIO4 = 0.7853981633974483;
function cosm1(x) {
  var x26;
  if (x < -PIO4 || x > PIO4) {
    return lib_default165(x) - 1;
  }
  x26 = x * x;
  return -0.5 * x26 + x26 * x26 * polyval_p_default8(x26);
}
var main_default182 = cosm1;

var lib_default239 = main_default182;

function cosm1f(x) {
  return lib_default3(lib_default239(lib_default3(x)));
}
var main_default183 = cosm1f;

var lib_default240 = main_default183;

var ONE_WORD3 = 1065353216 >>> 0;
var HALF_WORD3 = 1056964608 >>> 0;
var QUARTER_WORD2 = 1048576e3 >>> 0;
var THREE_QUARTER_WORD2 = 1061158912 >>> 0;
var SMALL_WORD3 = 947912704 >>> 0;
var TWO_23_WORD = 1258291200 >>> 0;
var TWO_24_WORD = 1266679808 >>> 0;
var FLOAT32_EXPONENT_FIELD_MASK2 = 255 >>> 0;
var NEG_ONE3 = lib_default3(-1);
var ZERO10 = lib_default3(0);
var HALF6 = lib_default3(0.5);
var ONE10 = lib_default3(1);
function cospif(x) {
  var hx;
  var ix;
  var j02;
  var ax;
  var c2;
  x = lib_default3(x);
  hx = lib_default10(lib_default3(x));
  ix = (hx & lib_default22) >>> 0;
  ax = lib_default11(ix);
  if (ix < ONE_WORD3) {
    if (ix < QUARTER_WORD2) {
      if (ix < SMALL_WORD3) {
        if (x === 0) {
          return ONE10;
        }
      }
      return lib_default19(lib_default26 * lib_default3(ax));
    }
    if (ix < HALF_WORD3) {
      c2 = lib_default20(lib_default26 * lib_default3(HALF6 - ax));
    } else if (ix < THREE_QUARTER_WORD2) {
      if (ix === HALF_WORD3) {
        return ZERO10;
      }
      c2 = lib_default3(-lib_default20(lib_default26 * lib_default3(ax - HALF6)));
    } else {
      c2 = lib_default3(-lib_default19(lib_default26 * lib_default3(ONE10 - ax)));
    }
    return c2;
  }
  if (ix < TWO_23_WORD) {
    j02 = (ix >> lib_default25 & FLOAT32_EXPONENT_FIELD_MASK2) - lib_default13;
    ix &= ~(lib_default14 >> j02);
    x = lib_default11(ix);
    ax = lib_default3(ax - x);
    ix = lib_default10(ax);
    if (ix < HALF_WORD3) {
      if (ix < QUARTER_WORD2) {
        c2 = ix === 0 ? ONE10 : lib_default19(lib_default26 * lib_default3(ax));
      } else {
        c2 = lib_default20(lib_default26 * lib_default3(HALF6 - ax));
      }
    } else if (ix < THREE_QUARTER_WORD2) {
      if (ix === HALF_WORD3) {
        return ZERO10;
      }
      c2 = lib_default3(-lib_default20(lib_default26 * lib_default3(ax - HALF6)));
    } else {
      c2 = lib_default3(-lib_default19(lib_default26 * lib_default3(ONE10 - ax)));
    }
    j02 = lib_default24(x);
    return j02 & 1 ? -c2 : c2;
  }
  if (ix >= lib_default12) {
    return NaN;
  }
  if (ix < TWO_24_WORD) {
    return ix & 1 ? NEG_ONE3 : ONE10;
  }
  return ONE10;
}
var main_default184 = cospif;

var lib_default241 = main_default184;

function evalpoly89(x) {
  if (x === 0) {
    return 0.13333333333320124;
  }
  return 0.13333333333320124 + x * (0.021869488294859542 + x * (0.0035920791075913124 + x * (5880412408202641e-19 + x * (7817944429395571e-20 + x * -18558637485527546e-21))));
}
var polyval_t_odd_default = evalpoly89;

function evalpoly90(x) {
  if (x === 0) {
    return 0.05396825397622605;
  }
  return 0.05396825397622605 + x * (0.0088632398235993 + x * (0.0014562094543252903 + x * (2464631348184699e-19 + x * (7140724913826082e-20 + x * 2590730518636337e-20))));
}
var polyval_t_even_default = evalpoly90;

var PIO42 = 0.7853981633974483;
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
  var v3;
  var w;
  var z;
  hx = lib_default41(x);
  ix = hx & HIGH_WORD_ABS_MASK | 0;
  if (ix >= 1072010280) {
    if (x < 0) {
      x = -x;
      y = -y;
    }
    z = PIO42 - x;
    w = PIO4LO - y;
    x = z + w;
    y = 0;
  }
  z = x * x;
  w = z * z;
  r = polyval_t_odd_default(w);
  v3 = z * polyval_t_even_default(w);
  s = z * x;
  r = y + z * (s * (r + v3) + y);
  r += T0 * s;
  w = x + r;
  if (ix >= 1072010280) {
    v3 = k;
    return (1 - (hx >> 30 & 2)) * (v3 - 2 * (x - (w * w / (w + v3) - r)));
  }
  if (k === 1) {
    return w;
  }
  z = lib_default139(w, 0);
  v3 = r - (z - x);
  a = -1 / w;
  t = lib_default139(a, 0);
  s = 1 + t * z;
  return t + a * (s + t * v3);
}
var main_default185 = kernelTan;

var lib_default242 = main_default185;

var buffer2 = [0, 0];
var HIGH_WORD_PIO42 = 1072243195 | 0;
var HIGH_WORD_TWO_NEG_272 = 1044381696 | 0;
function tan(x) {
  var ix;
  var n;
  ix = lib_default41(x);
  ix &= lib_default92;
  if (ix <= HIGH_WORD_PIO42) {
    if (ix < HIGH_WORD_TWO_NEG_272) {
      return x;
    }
    return lib_default242(x, 0, 1);
  }
  if (ix >= lib_default116) {
    return NaN;
  }
  n = lib_default129(x, buffer2);
  return lib_default242(buffer2[0], buffer2[1], 1 - ((n & 1) << 1));
}
var main_default186 = tan;

var lib_default243 = main_default186;

function cot(x) {
  return 1 / lib_default243(x);
}
var main_default187 = cot;

var lib_default244 = main_default187;

function sind(x) {
  var arx;
  var rx;
  if (lib_default76(x) || lib_default30(x)) {
    return NaN;
  }
  rx = lib_default228(x, 360);
  arx = lib_default(rx);
  if (rx === 0) {
    return rx;
  }
  if (arx < 45) {
    return lib_default155(lib_default227(rx), 0);
  }
  if (arx <= 135) {
    return lib_default192(rx) * lib_default154(lib_default227(90 - arx), 0);
  }
  if (arx === 180) {
    return lib_default192(rx) * 0;
  }
  if (arx < 225) {
    return lib_default155(lib_default227((180 - arx) * lib_default192(rx)), 0);
  }
  if (arx <= 315) {
    return -lib_default192(rx) * lib_default154(lib_default227(270 - arx), 0);
  }
  return lib_default155(lib_default227(rx - 360 * lib_default192(rx)), 0);
}
var main_default188 = sind;

var lib_default245 = main_default188;

function cotd(x) {
  return lib_default229(x) / lib_default245(x);
}
var main_default189 = cotd;

var lib_default246 = main_default189;

function signumf(x) {
  if (x === 0 || lib_default6(x)) {
    return x;
  }
  return x < 0 ? -1 : 1;
}
var main_default190 = signumf;

var lib_default247 = main_default190;

var ZERO11 = lib_default3(0);
var DEG_452 = lib_default3(45);
var DEG_902 = lib_default3(90);
var DEG_1352 = lib_default3(135);
var DEG_1802 = lib_default3(180);
var DEG_2252 = lib_default3(225);
var DEG_2702 = lib_default3(270);
var DEG_3152 = lib_default3(315);
var DEG_3602 = lib_default3(360);
function sindf(x) {
  var arx;
  var rx;
  x = lib_default3(x);
  if (lib_default9(x) || lib_default6(x)) {
    return NaN;
  }
  rx = lib_default231(x, DEG_3602);
  arx = lib_default5(rx);
  if (rx === ZERO11) {
    return rx;
  }
  if (arx < DEG_452) {
    return lib_default20(lib_default230(rx));
  }
  if (arx <= DEG_1352) {
    return lib_default3(lib_default247(rx) * lib_default19(lib_default230(lib_default3(DEG_902 - arx))));
  }
  if (arx === DEG_1802) {
    return lib_default3(lib_default247(rx) * ZERO11);
  }
  if (arx < DEG_2252) {
    return lib_default20(lib_default230(lib_default3(lib_default3(DEG_1802 - arx) * lib_default247(rx))));
  }
  if (arx <= DEG_3152) {
    return lib_default3(-lib_default247(rx) * lib_default19(lib_default230(lib_default3(DEG_2702 - arx))));
  }
  return lib_default20(lib_default230(lib_default3(rx - lib_default3(DEG_3602 * lib_default247(rx)))));
}
var main_default191 = sindf;

var lib_default248 = main_default191;

function cotdf(x) {
  x = lib_default3(x);
  return lib_default3(lib_default232(x) / lib_default248(x));
}
var main_default192 = cotdf;

var lib_default249 = main_default192;

var T = [
  0.3333313950307914,
  // 0x15554d3418c99f.0p-54
  0.13339200271297674,
  // 0x1112fd38999f72.0p-55
  0.05338123784456704,
  // 0x1b54c91d865afe.0p-57
  0.024528318116654728,
  // 0x191df3908c33ce.0p-58
  0.002974357433599673,
  // 0x185dadfcecf44e.0p-61
  0.009465647849436732
  // 0x1362b9bf971bcd.0p-59
];
function kernelTanf(x, iy) {
  var z;
  var r;
  var w;
  var s;
  var t;
  var u;
  z = x * x;
  r = T[4] + z * T[5];
  t = T[2] + z * T[3];
  w = z * z;
  s = z * x;
  u = T[0] + z * T[1];
  r = x + s * u + s * w * (t + w * r);
  if (iy === 1) {
    return lib_default3(r);
  }
  return lib_default3(lib_default3(-1) / lib_default3(r));
}
var main_default193 = kernelTanf;

var lib_default250 = main_default193;

var PIO4_WORD2 = 1061752794 | 0;
var THREE_PIO4_WORD2 = 1075235811 | 0;
var FIVE_PIO4_WORD2 = 1081824209 | 0;
var SEVEN_PIO4_WORD2 = 1085271519 | 0;
var NINE_PIO4_WORD2 = 1088565717 | 0;
var SMALL_WORD4 = 964689920 | 0;
var PIO25 = lib_default54;
var PI3 = 2 * lib_default54;
var THREE_PIO22 = 3 * lib_default54;
var TWO_PI3 = 4 * lib_default54;
var Y7 = [0];
function tanf(x) {
  var hx;
  var ix;
  var n;
  hx = lib_default10(lib_default3(x)) | 0;
  ix = hx & lib_default22 | 0;
  if (ix <= PIO4_WORD2) {
    if (ix < SMALL_WORD4) {
      return lib_default3(x);
    }
    return lib_default3(lib_default250(x, 1));
  }
  if (ix <= FIVE_PIO4_WORD2) {
    if (ix <= THREE_PIO4_WORD2) {
      if (hx > 0) {
        return lib_default3(lib_default250(x - PIO25, -1));
      }
      return lib_default3(lib_default250(x + PIO25, -1));
    }
    if (hx > 0) {
      return lib_default3(lib_default250(x - PI3, 1));
    }
    return lib_default3(lib_default250(x + PI3, 1));
  }
  if (ix <= NINE_PIO4_WORD2) {
    if (ix <= SEVEN_PIO4_WORD2) {
      if (hx > 0) {
        return lib_default3(lib_default250(x - THREE_PIO22, -1));
      }
      return lib_default3(lib_default250(x + THREE_PIO22, -1));
    }
    if (hx > 0) {
      return lib_default3(lib_default250(x - TWO_PI3, 1));
    }
    return lib_default3(lib_default250(x + TWO_PI3, 1));
  }
  if (ix >= lib_default12) {
    return NaN;
  }
  n = lib_default234(lib_default3(x), Y7);
  return lib_default3(lib_default250(Y7[0], 1 - ((n & 1) << 1)));
}
var main_default194 = tanf;

var lib_default251 = main_default194;

var ONE11 = lib_default3(1);
function cotf(x) {
  return lib_default3(ONE11 / lib_default251(lib_default3(x)));
}
var main_default195 = cotf;

var lib_default252 = main_default195;

function evalrational41(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.3333333333333332;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -1614.6876844170845 + x * (-99.28772310019185 + x * (-0.9643991794250523 + x * 0));
    s2 = 4844.063053251255 + x * (2235.4883906010045 + x * (112.81167849163293 + x * 1));
  } else {
    x = 1 / x;
    s1 = 0 + x * (-0.9643991794250523 + x * (-99.28772310019185 + x * -1614.6876844170845));
    s2 = 1 + x * (112.81167849163293 + x * (2235.4883906010045 + x * 4844.063053251255));
  }
  return s1 / s2;
}
var rational_pq_default5 = evalrational41;

var MAXLOG = 88.02969193111305;
function tanh(x) {
  var s;
  var z;
  z = lib_default(x);
  if (z > 0.5 * MAXLOG) {
    return x < 0 ? -1 : 1;
  }
  if (z >= 0.625) {
    s = lib_default138(2 * z);
    z = 1 - 2 / (s + 1);
    if (x < 0) {
      z = -z;
    }
  } else {
    if (x === 0) {
      return x;
    }
    s = x * x;
    z = x + x * s * rational_pq_default5(s);
  }
  return z;
}
var main_default196 = tanh;

var lib_default253 = main_default196;

function coth(x) {
  return 1 / lib_default253(x);
}
var main_default197 = coth;

var lib_default254 = main_default197;

function covercos(x) {
  return 1 + lib_default156(x);
}
var main_default198 = covercos;

var lib_default255 = main_default198;

var PIO4_WORD3 = 1061752794 | 0;
var THREE_PIO4_WORD3 = 1075235811 | 0;
var FIVE_PIO4_WORD3 = 1081824209 | 0;
var SEVEN_PIO4_WORD3 = 1085271519 | 0;
var NINE_PIO4_WORD3 = 1088565717 | 0;
var SMALL_WORD5 = 964689920 | 0;
var PIO26 = lib_default54;
var PI4 = 2 * lib_default54;
var THREE_PIO23 = 3 * lib_default54;
var TWO_PI4 = 4 * lib_default54;
var Y8 = [0];
function sinf(x) {
  var hx;
  var ix;
  var n;
  hx = lib_default10(lib_default3(x)) | 0;
  ix = hx & lib_default22 | 0;
  if (ix <= PIO4_WORD3) {
    if (ix < SMALL_WORD5) {
      return lib_default3(x);
    }
    return lib_default20(x);
  }
  if (ix <= FIVE_PIO4_WORD3) {
    if (ix <= THREE_PIO4_WORD3) {
      if (hx > 0) {
        return lib_default3(lib_default19(x - PIO26));
      }
      return lib_default3(-lib_default19(x + PIO26));
    }
    if (hx > 0) {
      return lib_default3(lib_default20(PI4 - x));
    }
    return lib_default3(-lib_default20(PI4 + x));
  }
  if (ix <= NINE_PIO4_WORD3) {
    if (ix <= SEVEN_PIO4_WORD3) {
      if (hx > 0) {
        return lib_default3(-lib_default19(x - THREE_PIO23));
      }
      return lib_default3(lib_default19(x + THREE_PIO23));
    }
    if (hx > 0) {
      return lib_default3(lib_default20(x - TWO_PI4));
    }
    return lib_default3(lib_default20(x + TWO_PI4));
  }
  if (ix >= lib_default12) {
    return NaN;
  }
  n = lib_default234(lib_default3(x), Y8);
  switch (n & 3) {
    case 0:
      return lib_default3(lib_default20(Y8[0]));
    case 1:
      return lib_default3(lib_default19(Y8[0]));
    case 2:
      return lib_default3(-lib_default20(Y8[0]));
    default:
      return lib_default3(-lib_default19(Y8[0]));
  }
}
var main_default199 = sinf;

var lib_default256 = main_default199;

function covercosf(x) {
  return lib_default3(lib_default3(1) + lib_default256(lib_default3(x)));
}
var main_default200 = covercosf;

var lib_default257 = main_default200;

function coversin(x) {
  return 1 - lib_default156(x);
}
var main_default201 = coversin;

var lib_default258 = main_default201;

function coversinf(x) {
  return lib_default3(lib_default3(1) - lib_default256(lib_default3(x)));
}
var main_default202 = coversinf;

var lib_default259 = main_default202;

function csc(x) {
  return 1 / lib_default156(x);
}
var main_default203 = csc;

var lib_default260 = main_default203;

function cscd(x) {
  return 1 / lib_default245(x);
}
var main_default204 = cscd;

var lib_default261 = main_default204;

function cscdf(x) {
  return lib_default3(lib_default3(1) / lib_default248(lib_default3(x)));
}
var main_default205 = cscdf;

var lib_default262 = main_default205;

function cscf(x) {
  return lib_default3(lib_default3(1) / lib_default256(lib_default3(x)));
}
var main_default206 = cscf;

var lib_default263 = main_default206;

function evalrational42(x) {
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
var rational_pq_default6 = evalrational42;

var MAXLOG2 = 709.782712893384;
var MINLOG = -708.3964185322641;
var POS_OVERFLOW = MAXLOG2 + lib_default47;
var NEG_OVERFLOW = MINLOG - lib_default47;
var LARGE = MAXLOG2 - lib_default47;
function sinh(x) {
  var a;
  if (x === 0) {
    return x;
  }
  if (x > POS_OVERFLOW || x < NEG_OVERFLOW) {
    return x > 0 ? lib_default43 : lib_default44;
  }
  a = lib_default(x);
  if (a > 1) {
    if (a >= LARGE) {
      a = lib_default138(0.5 * a);
      a *= 0.5 * a;
      if (x < 0) {
        a = -a;
      }
      return a;
    }
    a = lib_default138(a);
    a = 0.5 * a - 0.5 / a;
    if (x < 0) {
      a = -a;
    }
    return a;
  }
  a *= a;
  return x + x * a * rational_pq_default6(a);
}
var main_default207 = sinh;

var lib_default264 = main_default207;

function csch(x) {
  return 1 / lib_default264(x);
}
var main_default208 = csch;

var lib_default265 = main_default208;

function evalpoly91(x) {
  if (x === 0) {
    return 0.08333333333333333;
  }
  return 0.08333333333333333 + x * (-0.008333333333333333 + x * (0.003968253968253968 + x * (-0.004166666666666667 + x * (0.007575757575757576 + x * (-0.021092796092796094 + x * (0.08333333333333333 + x * -0.4432598039215686))))));
}
var polyval_p_default9 = evalpoly91;

function digamma(x) {
  var y;
  var z;
  x -= 1;
  y = lib_default48(x) + 1 / (2 * x);
  z = 1 / (x * x);
  return y - z * polyval_p_default9(z);
}
var asymptotic_expansion_default = digamma;

function evalrational43(x) {
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
var rational_pq_default7 = evalrational43;

var root1 = 1569415565 / 1073741824;
var root2 = 381566830 / 1073741824 / 1073741824;
var root3 = 9016312093258695e-35;
var Y9 = 0.9955816268920898;
function digamma2(x) {
  var g;
  var r;
  g = x - root1;
  g -= root2;
  g -= root3;
  r = rational_pq_default7(x - 1);
  return g * Y9 + g * r;
}
var rational_approximation_default = digamma2;

var MIN_SAFE_ASYMPTOTIC = 10;
function digamma3(x) {
  var rem;
  var tmp7;
  if (lib_default30(x) || x === 0) {
    return NaN;
  }
  if (x <= -1) {
    x = 1 - x;
    rem = x - lib_default105(x);
    if (rem > 0.5) {
      rem -= 1;
    }
    if (rem === 0) {
      return NaN;
    }
    tmp7 = lib_default26 / lib_default243(lib_default26 * rem);
  } else {
    tmp7 = 0;
  }
  if (x >= MIN_SAFE_ASYMPTOTIC) {
    tmp7 += asymptotic_expansion_default(x);
    return tmp7;
  }
  while (x > 2) {
    x -= 1;
    tmp7 += 1 / x;
  }
  while (x < 1) {
    tmp7 -= 1 / x;
    x += 1;
  }
  tmp7 += rational_approximation_default(x);
  return tmp7;
}
var main_default209 = digamma3;

var lib_default266 = main_default209;

function diracDelta(x) {
  if (lib_default30(x)) {
    return NaN;
  }
  if (x === 0) {
    return lib_default43;
  }
  return 0;
}
var main_default210 = diracDelta;

var lib_default267 = main_default210;

function diracDeltaf(x) {
  if (lib_default6(x)) {
    return NaN;
  }
  if (x === 0) {
    return lib_default7;
  }
  return 0;
}
var main_default211 = diracDeltaf;

var lib_default268 = main_default211;

var odd_positive_integers_default = [
  1.2020569031595942,
  1.03692775514337,
  1.008349277381923,
  1.0020083928260821,
  1.0004941886041194,
  1.0001227133475785,
  1.000030588236307,
  1.0000076371976379,
  1.0000019082127165,
  1.0000004769329869,
  1.000000119219926,
  1.0000000298035034,
  1.0000000074507118,
  1.0000000018626598,
  1.0000000004656628,
  1.0000000001164155,
  1.0000000000291038,
  1.000000000007276,
  1.000000000001819,
  1.0000000000004547,
  1.0000000000001137,
  1.0000000000000284,
  1.000000000000007,
  1.0000000000000018,
  1.0000000000000004,
  1.0000000000000002,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1
];

var even_nonnegative_integers_default = [
  -0.5,
  1.6449340668482264,
  1.0823232337111381,
  1.0173430619844492,
  1.0040773561979444,
  1.000994575127818,
  1.000246086553308,
  1.0000612481350588,
  1.0000152822594086,
  1.000003817293265,
  1.0000009539620338,
  1.0000002384505027,
  1.000000059608189,
  1.0000000149015549,
  1.000000003725334,
  1.0000000009313275,
  1.000000000232831,
  1.0000000000582077,
  1.000000000014552,
  1.000000000003638,
  1.0000000000009095,
  1.0000000000002274,
  1.0000000000000568,
  1.0000000000000142,
  1.0000000000000036,
  1.0000000000000009,
  1.0000000000000002,
  1
];

var bernoulli_default2 = [
  1,
  0.16666666666666666,
  -0.03333333333333333,
  0.023809523809523808,
  -0.03333333333333333,
  0.07575757575757576,
  -0.2531135531135531,
  1.1666666666666667,
  -7.092156862745098,
  54.971177944862156,
  -529.1242424242424,
  6192.123188405797,
  -86580.25311355312,
  1.4255171666666667e6,
  -27298231067816094e-9,
  6015808739006424e-7,
  -15116315767092157e-6,
  4296146430611667e-4,
  -13711655205088332e-3,
  4883323189735932e-1,
  -19296579341940068,
  841693047573682600,
  -40338071854059454e3,
  21150748638081993e5,
  -12086626522296526e7,
  7500866746076964e9,
  -5038778101481069e11,
  36528776484818122e12,
  -2849876930245088e15,
  23865427499683627e16,
  -21399949257225335e18,
  20500975723478097e20,
  -2093800591134638e23,
  22752696488463515e24,
  -26257710286239577e26,
  3212508210271803e29,
  -4159827816679471e31,
  5692069548203528e33,
  -8218362941978458e35,
  12502904327166994e37,
  -2001558323324837e40,
  33674982915364376e41,
  -5947097050313545e44,
  11011910323627977e46,
  -21355259545253502e48,
  43328896986641194e50,
  -9188552824166933e53,
  20346896776329074e55,
  -4700383395803573e58,
  1131804344548425e61,
  -28382249570693707e62,
  7406424897967885e65,
  -20096454802756605e67,
  5665717005080594e70,
  -16584511154136216e72,
  5036885995049238e75,
  -15861468237658186e77,
  51756743617545625e79,
  -17488921840217116e82,
  6116051999495218e85,
  -22122776912707833e87,
  8272277679877097e90,
  -3195892511141571e93,
  12750082223387793e95,
  -5250092308677413e98,
  22301817894241627e100,
  -976845219309552e104,
  4409836197845295e106,
  -2050857088646409e109,
  9821443327979128e111,
  -4841260079820888e114,
  24553088801480982e116,
  -12806926804084748e119,
  6867616710466858e122,
  -37846468581969106e124,
  2142610125066529e128,
  -12456727137183695e130,
  7434578755100016e133,
  -45535795304641704e135,
  2861211281685887e139,
  -1843772355203387e142,
  12181154536221047e144,
  -8248218718531412e147,
  5722587793783294e150,
  -40668530525059105e152,
  29596092064642052e155,
  -22049522565189457e158,
  168125970728896e163,
  -13116736213556958e164,
  10467894009478039e167,
  -8543289357883371e170,
  7128782132248655e173,
  -608029314555359e177,
  5299677642484992e179,
  -4719425916874586e182,
  4292841379140298e185,
  -39876744968232205e187,
  3781978041935888e191,
  -3661423368368119e194,
  3617609027237286e197,
  -3647077264519136e200,
  3750875543645441e203,
  -3934586729643903e206,
  4208821114819008e209,
  -4590229622061792e212,
  5103172577262957e215,
  -5782276230365695e218,
  6676248216783588e221,
  -7853530764445042e224,
  9410689406705872e227,
  -11484933873465185e230,
  14272958742848785e233,
  -1805955958690931e237,
  23261535307660807e239,
  -30495751715499594e242,
  4068580607643398e246,
  -5523103132197436e249,
  76277279396434395e251,
  -10715571119697886e255,
  15310200895969188e258,
  -22244891682179836e261,
  3286267919069014e265,
  -4935592895596035e268,
  7534957120083251e271,
  -11691485154584178e274,
  1843526146783894e278,
  -2953682617296808e281,
  4807932127750157e284,
  -7950212504588525e287,
  13352784187354634e290
];

function evalrational44(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.2433929443359375;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 0.2433929443359375 + x * (-0.4909247051635357 + x * (0.055761621477604675 + x * (-0.003209124988790859 + x * (4515345286457964e-19 + x * -9332412703570615e-21))));
    s2 = 1 + x * (-0.27996033431034445 + x * (0.04196762233099861 + x * (-0.00413421406552171 + x * (24978985622317937e-20 + x * -10185578841856403e-21))));
  } else {
    x = 1 / x;
    s1 = -9332412703570615e-21 + x * (4515345286457964e-19 + x * (-0.003209124988790859 + x * (0.055761621477604675 + x * (-0.4909247051635357 + x * 0.2433929443359375))));
    s2 = -10185578841856403e-21 + x * (24978985622317937e-20 + x * (-0.00413421406552171 + x * (0.04196762233099861 + x * (-0.27996033431034445 + x * 1))));
  }
  return s1 / s2;
}
var rational_p1q1_default7 = evalrational44;

function evalrational45(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.5772156649015329;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 0.5772156649015329 + x * (0.24321064694010716 + x * (0.04173646739882165 + x * (0.003902520870728433 + x * (2496063671518772e-19 + x * 1101084409767329e-20))));
    s2 = 1 + x * (0.29520127712663174 + x * (0.043460910607305496 + x * (0.004349305820858264 + x * (2557842261404885e-19 + x * 10991819782396113e-21))));
  } else {
    x = 1 / x;
    s1 = 1101084409767329e-20 + x * (2496063671518772e-19 + x * (0.003902520870728433 + x * (0.04173646739882165 + x * (0.24321064694010716 + x * 0.5772156649015329))));
    s2 = 10991819782396113e-21 + x * (2557842261404885e-19 + x * (0.004349305820858264 + x * (0.043460910607305496 + x * (0.29520127712663174 + x * 1))));
  }
  return s1 / s2;
}
var rational_p2q2_default7 = evalrational45;

function evalrational46(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.053725830002359504;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.053725830002359504 + x * (0.04451634732923656 + x * (0.012867767353451996 + x * (9754177045739176e-19 + x * (7698751015736541e-20 + x * (3280325100003831e-21 + x * 0)))));
    s2 = 1 + x * (0.3338319455303405 + x * (0.048779843129140764 + x * (0.0047903970857355845 + x * (27077670395633634e-20 + x * (10695186753205734e-21 + x * 23627662397497864e-24)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (3280325100003831e-21 + x * (7698751015736541e-20 + x * (9754177045739176e-19 + x * (0.012867767353451996 + x * (0.04451634732923656 + x * -0.053725830002359504)))));
    s2 = 23627662397497864e-24 + x * (10695186753205734e-21 + x * (27077670395633634e-20 + x * (0.0047903970857355845 + x * (0.048779843129140764 + x * (0.3338319455303405 + x * 1)))));
  }
  return s1 / s2;
}
var rational_p3q3_default4 = evalrational46;

function evalrational47(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -2.497101906022594;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -2.497101906022594 + x * (-2.600133018094757 + x * (-0.9392604353771099 + x * (-0.13844861799574154 + x * (-0.007017212405498024 + x * (-22925731059489392e-21 + x * (0 + x * (0 + x * 0)))))));
    s2 = 1 + x * (0.7060390259377451 + x * (0.15739599649558628 + x * (0.010611795097684508 + x * (-36910273311764616e-21 + x * (49340956392759e-19 + x * (-23405548702528722e-23 + x * (7188337293654598e-24 + x * -11292001134749475e-26)))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0 + x * (0 + x * (-22925731059489392e-21 + x * (-0.007017212405498024 + x * (-0.13844861799574154 + x * (-0.9392604353771099 + x * (-2.600133018094757 + x * -2.497101906022594)))))));
    s2 = -11292001134749475e-26 + x * (7188337293654598e-24 + x * (-23405548702528722e-23 + x * (49340956392759e-19 + x * (-36910273311764616e-21 + x * (0.010611795097684508 + x * (0.15739599649558628 + x * (0.7060390259377451 + x * 1)))))));
  }
  return s1 / s2;
}
var rational_p4q4_default2 = evalrational47;

function evalrational48(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -4.785580284951356;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -4.785580284951356 + x * (-1.8919736488197254 + x * (-0.21140713487441282 + x * (-1892047582600767e-19 + x * (0.0011514092388917874 + x * (6399492042131645e-20 + x * (1393489324453249e-21 + x * (0 + x * 0)))))));
    s2 = 1 + x * (0.24434533737818856 + x * (0.008733707544922887 + x * (-0.0011759276533443448 + x * (-7437436828999331e-20 + x * (-21750464515767985e-22 + x * (4710012640030765e-24 + x * (-8333784406253855e-26 + x * 6998415452048457e-28)))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0 + x * (1393489324453249e-21 + x * (6399492042131645e-20 + x * (0.0011514092388917874 + x * (-1892047582600767e-19 + x * (-0.21140713487441282 + x * (-1.8919736488197254 + x * -4.785580284951356)))))));
    s2 = 6998415452048457e-28 + x * (-8333784406253855e-26 + x * (4710012640030765e-24 + x * (-21750464515767985e-22 + x * (-7437436828999331e-20 + x * (-0.0011759276533443448 + x * (0.008733707544922887 + x * (0.24434533737818856 + x * 1)))))));
  }
  return s1 / s2;
}
var rational_p5q5_default2 = evalrational48;

function evalrational49(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -10.39489505733089;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -10.39489505733089 + x * (-2.858272196711067 + x * (-0.34772826653924577 + x * (-0.025115606465534634 + x * (-0.001194591734169687 + x * (-3825293235079675e-20 + x * (-7855236337967234e-22 + x * -8214657090954655e-24))))));
    s2 = 1 + x * (0.2081963335726719 + x * (0.019568765731720502 + x * (0.0011107963810248593 + x * (40850774626603926e-21 + x * (9555611230656935e-22 + x * (1185071534740229e-23 + x * 2226094836273526e-30))))));
  } else {
    x = 1 / x;
    s1 = -8214657090954655e-24 + x * (-7855236337967234e-22 + x * (-3825293235079675e-20 + x * (-0.001194591734169687 + x * (-0.025115606465534634 + x * (-0.34772826653924577 + x * (-2.858272196711067 + x * -10.39489505733089))))));
    s2 = 2226094836273526e-30 + x * (1185071534740229e-23 + x * (9555611230656935e-22 + x * (40850774626603926e-21 + x * (0.0011107963810248593 + x * (0.019568765731720502 + x * (0.2081963335726719 + x * 1))))));
  }
  return s1 / s2;
}
var rational_p6q6_default = evalrational49;

var MAX_BERNOULLI_2N = 129;
var MAX_LN = lib_default105(lib_default168);
var Y13 = 1.2433929443359375;
var Y33 = 0.6986598968505859;
function zeta(s) {
  var tmp7;
  var sc8;
  var as;
  var is;
  var r;
  var n;
  if (lib_default30(s)) {
    return NaN;
  }
  if (s === 1) {
    return NaN;
  }
  if (s >= 56) {
    return 1;
  }
  if (lib_default107(s)) {
    is = s | 0;
    if (is === s) {
      if (is < 0) {
        as = -is | 0;
        if ((as & 1) === 0) {
          return 0;
        }
        n = (as + 1) / 2 | 0;
        if (n <= MAX_BERNOULLI_2N) {
          return -bernoulli_default2[n] / (as + 1);
        }
      } else if ((is & 1) === 0) {
        return even_nonnegative_integers_default[is / 2];
      } else {
        return odd_positive_integers_default[(is - 3) / 2];
      }
    }
  }
  if (lib_default(s) < lib_default169) {
    return -0.5 - lib_default194 * s;
  }
  sc8 = 1 - s;
  if (s < 0) {
    if (lib_default105(s / 2) === s / 2) {
      return 0;
    }
    tmp7 = s;
    s = sc8;
    sc8 = tmp7;
    if (s > lib_default160) {
      tmp7 = lib_default166(0.5 * sc8) * 2 * zeta(s);
      r = lib_default167(s);
      r -= s * lib_default48(lib_default176);
      if (r > MAX_LN) {
        return tmp7 < 0 ? lib_default44 : lib_default43;
      }
      return tmp7 * lib_default138(r);
    }
    return lib_default166(0.5 * sc8) * 2 * lib_default142(lib_default176, -s) * lib_default159(s) * zeta(s);
  }
  if (s < 1) {
    tmp7 = rational_p1q1_default7(sc8);
    tmp7 -= Y13;
    tmp7 += sc8;
    tmp7 /= sc8;
    return tmp7;
  }
  if (s <= 2) {
    sc8 = -sc8;
    tmp7 = 1 / sc8;
    return tmp7 + rational_p2q2_default7(sc8);
  }
  if (s <= 4) {
    tmp7 = Y33 + 1 / -sc8;
    return tmp7 + rational_p3q3_default4(s - 2);
  }
  if (s <= 7) {
    tmp7 = rational_p4q4_default2(s - 4);
    return 1 + lib_default138(tmp7);
  }
  if (s < 15) {
    tmp7 = rational_p5q5_default2(s - 7);
    return 1 + lib_default138(tmp7);
  }
  if (s < 36) {
    tmp7 = rational_p6q6_default(s - 15);
    return 1 + lib_default138(tmp7);
  }
  return 1 + lib_default142(2, -s);
}
var main_default212 = zeta;

var lib_default269 = main_default212;

function eta(s) {
  if (lib_default30(s)) {
    return NaN;
  }
  if (s === 1) {
    return lib_default47;
  }
  return -lib_default178(2, 1 - s) * lib_default269(s);
}
var main_default213 = eta;

var lib_default270 = main_default213;

function evalpoly92(x) {
  if (x === 0) {
    return 1.5910034537907922;
  }
  return 1.5910034537907922 + x * (0.41600074399178694 + x * (0.24579151426410342 + x * (0.17948148291490615 + x * (0.14455605708755515 + x * (0.12320099331242772 + x * (0.10893881157429353 + x * (0.09885340987159291 + x * (0.09143962920174975 + x * (0.0858425915954139 + x * 0.08154111871830322)))))))));
}
var poly_p1_default = evalpoly92;

function evalpoly93(x) {
  if (x === 0) {
    return 1.63525673226458;
  }
  return 1.63525673226458 + x * (0.4711906261487323 + x * (0.3097284108314996 + x * (0.2522083117731357 + x * (0.22672562321968465 + x * (0.21577444672958598 + x * (0.21310877187734892 + x * (0.21602912460518828 + x * (0.2232558316330579 + x * (0.23418050129420992 + x * (0.24855768297226408 + x * 0.26636380989261754))))))))));
}
var poly_p2_default = evalpoly93;

function evalpoly94(x) {
  if (x === 0) {
    return 1.685750354812596;
  }
  return 1.685750354812596 + x * (0.5417318486132803 + x * (0.40152443839069024 + x * (0.3696424734208891 + x * (0.37606071535458363 + x * (0.4052358870851259 + x * (0.45329438175399905 + x * (0.5205189476511842 + x * (0.609426039204995 + x * (0.7242635222829089 + x * (0.8710138477098124 + x * 1.057652872753547))))))))));
}
var poly_p3_default = evalpoly94;

function evalpoly95(x) {
  if (x === 0) {
    return 1.7443505972256133;
  }
  return 1.7443505972256133 + x * (0.6348642753719353 + x * (0.5398425641644455 + x * (0.5718927051937874 + x * (0.6702951362654062 + x * (0.8325865900109772 + x * (1.0738574482479333 + x * (1.4220914606754977 + x * (1.9203871834023047 + x * (2.6325525483316543 + x * (3.6521097473190394 + x * (5.115867135558866 + x * 7.224080007363877)))))))))));
}
var poly_p4_default = evalpoly95;

function evalpoly96(x) {
  if (x === 0) {
    return 1.8138839368169826;
  }
  return 1.8138839368169826 + x * (0.7631632457005573 + x * (0.7619286053215958 + x * (0.9510746536684279 + x * (1.315180671703161 + x * (1.9285606934774109 + x * (2.9375093425313787 + x * (4.594894405442878 + x * (7.33007122188172 + x * (11.871512597425301 + x * (19.45851374822938 + x * (32.20638657246427 + x * (53.73749198700555 + x * 90.27388602941))))))))))));
}
var poly_p5_default = evalpoly96;

function evalpoly97(x) {
  if (x === 0) {
    return 1.8989249102715535;
  }
  return 1.8989249102715535 + x * (0.9505217946182445 + x * (1.1510775899590158 + x * (1.7502391069863006 + x * (2.952676812636875 + x * (5.285800396121451 + x * (9.83248571665998 + x * (18.787148683275596 + x * (36.61468615273698 + x * (72.45292395127771 + x * (145.1079577347069 + x * (293.4786396308497 + x * (598.385181505501 + x * (1228.4200130758634 + x * 2536.5297553827645)))))))))))));
}
var poly_p6_default = evalpoly97;

function evalpoly98(x) {
  if (x === 0) {
    return 2.0075983984243764;
  }
  return 2.0075983984243764 + x * (1.2484572312123474 + x * (1.9262346570764797 + x * (3.7512896400875877 + x * (8.119944554932045 + x * (18.665721308735552 + x * (44.603924842914374 + x * (109.50920543094983 + x * (274.2779548232414 + x * (697.5598008606327 + x * (1795.7160145002472 + x * (4668.38171679039 + x * (12235.762468136643 + x * (32290.17809718321 + x * (85713.07608195965 + x * (228672.1890493117 + x * 612757.2711915852)))))))))))))));
}
var poly_p7_default = evalpoly98;

function evalpoly99(x) {
  if (x === 0) {
    return 2.1565156474996434;
  }
  return 2.1565156474996434 + x * (1.7918056418494632 + x * (3.8267512874657132 + x * (10.386724683637972 + x * (31.403314054680703 + x * (100.92370394986955 + x * (337.3268282632273 + x * (1158.7079305678278 + x * (4060.9907421936323 + x * (14454.001840343448 + x * (52076.661075994045 + x * (189493.65914621568 + x * (695184.5762413896 + x * (2567994048255285e-9 + x * (9541921966748387e-9 + x * (3563492744218076e-8 + x * (13366929846120408e-8 + x * (50335218668662846e-8 + x * (190197572953866e-5 + x * 7208915015330104e-6))))))))))))))))));
}
var poly_p8_default = evalpoly99;

function evalpoly100(x) {
  if (x === 0) {
    return 2.3181226217125106;
  }
  return 2.3181226217125106 + x * (2.6169201502912327 + x * (7.897935075731356 + x * (30.502397154466724 + x * (131.48693655235286 + x * (602.9847637356492 + x * (2877.024617809973 + x * (14110.519919151804 + x * (70621.4408815654 + x * (358977.266582531 + x * (1.8472382637239718e6 + x * (9600515416049214e-9 + x * (5030767708502367e-8 + x * (2654441886527128e-7 + x * (14088623250287027e-7 + x * 7515687935373775e-6))))))))))))));
}
var poly_p9_default = evalpoly100;

function evalpoly101(x) {
  if (x === 0) {
    return 2.473596173751344;
  }
  return 2.473596173751344 + x * (3.727624244118099 + x * (15.607393035549306 + x * (84.12850842805888 + x * (506.98181970406137 + x * (3252.2770581451236 + x * (21713.242419574344 + x * (149037.04518909327 + x * (1.0439993310899908e6 + x * (7427974817042039e-9 + x * (5350383967558661e-8 + x * (38924988699487084e-8 + x * (28552883511008105e-7 + x * (2109007703876684e-5 + x * (1566998339477902e-4 + x * (117022224242244e-2 + x * (87779483236689375e-4 + x * (6610124275248495e-2 + x * (4994880537133888e-1 + x * 37859743397240296))))))))))))))))));
}
var poly_p10_default = evalpoly101;

function evalpoly102(x) {
  if (x === 0) {
    return 0;
  }
  return 0 + x * (0.0625 + x * (0.03125 + x * (0.0205078125 + x * (0.01513671875 + x * (0.011934280395507812 + x * (0.009816169738769531 + x * (0.008315593004226685 + x * (0.007199153304100037 + x * (0.00633745662344154 + x * (0.00565311038371874 + x * (0.005097046040418718 + x * (0.004636680381850056 + x * (0.004249547423822886 + x * 0.003919665602267974)))))))))))));
}
var poly_p11_default = evalpoly102;

function evalpoly103(x) {
  if (x === 0) {
    return 1.5910034537907922;
  }
  return 1.5910034537907922 + x * (0.41600074399178694 + x * (0.24579151426410342 + x * (0.17948148291490615 + x * (0.14455605708755515 + x * (0.12320099331242772 + x * (0.10893881157429353 + x * (0.09885340987159291 + x * (0.09143962920174975 + x * (0.0858425915954139 + x * 0.08154111871830322)))))))));
}
var poly_p12_default = evalpoly103;

var ONE_DIV_PI = 0.3183098861837907;
function ellipk(m) {
  var FLG2;
  var kdm;
  var td;
  var qd;
  var t;
  var x;
  x = m;
  if (m < 0) {
    x = m / (m - 1);
    FLG2 = true;
  }
  if (x === 0) {
    return lib_default54;
  }
  if (x === 1) {
    return lib_default43;
  }
  if (x > 1) {
    return NaN;
  }
  if (x < 0.1) {
    t = poly_p1_default(x - 0.05);
  } else if (x < 0.2) {
    t = poly_p2_default(x - 0.15);
  } else if (x < 0.3) {
    t = poly_p3_default(x - 0.25);
  } else if (x < 0.4) {
    t = poly_p4_default(x - 0.35);
  } else if (x < 0.5) {
    t = poly_p5_default(x - 0.45);
  } else if (x < 0.6) {
    t = poly_p6_default(x - 0.55);
  } else if (x < 0.7) {
    t = poly_p7_default(x - 0.65);
  } else if (x < 0.8) {
    t = poly_p8_default(x - 0.75);
  } else if (x < 0.85) {
    t = poly_p9_default(x - 0.825);
  } else if (x < 0.9) {
    t = poly_p10_default(x - 0.875);
  } else {
    td = 1 - x;
    qd = poly_p11_default(td);
    kdm = poly_p12_default(td - 0.05);
    t = -lib_default48(qd) * (kdm * ONE_DIV_PI);
  }
  if (FLG2) {
    return t / lib_default31(1 - m);
  }
  return t;
}
var main_default214 = ellipk;

var lib_default271 = main_default214;

function evalpoly104(x) {
  if (x === 0) {
    return 1.5509733517804722;
  }
  return 1.5509733517804722 + x * (-0.4003010201031985 + x * (-0.07849861944294194 + x * (-0.034318853117591995 + x * (-0.0197180433173655 + x * (-0.01305950773199331 + x * (-0.009442372874146548 + x * (-0.007246728512402157 + x * (-0.00580742401295609 + x * -0.004809187786009338))))))));
}
var poly_p1_default2 = evalpoly104;

function evalpoly105(x) {
  if (x === 0) {
    return 1.5101218320928198;
  }
  return 1.5101218320928198 + x * (-0.41711633390586755 + x * (-0.09012382040477457 + x * (-0.04372994401908431 + x * (-0.027965493064761784 + x * (-0.020644781177568104 + x * (-0.016650786739707237 + x * (-0.01426196082884252 + x * (-0.012759847429264804 + x * (-0.011799303775587354 + x * -0.011197445703074968)))))))));
}
var poly_p2_default2 = evalpoly105;

function evalpoly106(x) {
  if (x === 0) {
    return 1.4674622093394272;
  }
  return 1.4674622093394272 + x * (-0.43657629094633776 + x * (-0.10515555766694255 + x * (-0.05737184359324173 + x * (-0.04139162772734022 + x * (-0.03452772850528084 + x * (-0.031495443512532785 + x * (-0.030527000890325277 + x * (-0.0309169840192389 + x * (-0.03237139531475812 + x * -0.03478996038640416)))))))));
}
var poly_p3_default2 = evalpoly106;

function evalpoly107(x) {
  if (x === 0) {
    return 1.4226911334908792;
  }
  return 1.4226911334908792 + x * (-0.4595135196210487 + x * (-0.12525053982206188 + x * (-0.07813854509440948 + x * (-0.06471427847205 + x * (-0.06208433913173031 + x * (-0.06519703281557247 + x * (-0.07279389536257878 + x * (-0.084959075171781 + x * (-0.102539850131046 + x * (-0.12705358515769605 + x * -0.1607911206912746))))))))));
}
var poly_p4_default2 = evalpoly107;

function evalpoly108(x) {
  if (x === 0) {
    return 1.3754019718711163;
  }
  return 1.3754019718711163 + x * (-0.4872021832731848 + x * (-0.15331170134854022 + x * (-0.11184944491702783 + x * (-0.10884095252313576 + x * (-0.12295422312026907 + x * (-0.15221716396203505 + x * (-0.20049532364269734 + x * (-0.27617433306775174 + x * (-0.39351311430437586 + x * (-0.5757544060278792 + x * (-0.8605232357272398 + x * -1.3088332057585401)))))))))));
}
var poly_p5_default2 = evalpoly108;

function evalpoly109(x) {
  if (x === 0) {
    return 1.3250244979582302;
  }
  return 1.3250244979582302 + x * (-0.5217276475575667 + x * (-0.19490643048212622 + x * (-0.17162372682201127 + x * (-0.20275465292641914 + x * (-0.27879895311853475 + x * (-0.42069845728100574 + x * (-0.675948400853106 + x * (-1.1363431218392293 + x * (-1.9767211439543984 + x * (-3.5316967730957227 + x * (-6.446753640156048 + x * -11.97703130208884)))))))))));
}
var poly_p6_default2 = evalpoly109;

function evalpoly110(x) {
  if (x === 0) {
    return 1.2707074796501499;
  }
  return 1.2707074796501499 + x * (-0.5668391682878666 + x * (-0.2621607934324926 + x * (-0.2922441735330774 + x * (-0.4403978408504232 + x * (-0.7749476413813975 + x * (-1.498870837987561 + x * (-3.089708310445187 + x * (-6.6675959033810015 + x * (-14.89436036517319 + x * (-34.18120574251449 + x * (-80.15895841905397 + x * (-191.34894807629848 + x * (-463.5938853480342 + x * -1137.38082216936)))))))))))));
}
var poly_p7_default2 = evalpoly110;

function evalpoly111(x) {
  if (x === 0) {
    return 1.2110560275684594;
  }
  return 1.2110560275684594 + x * (-0.6303064132874558 + x * (-0.38716640952066916 + x * (-0.5922782353119346 + x * (-1.23755558451305 + x * (-3.0320566617452474 + x * (-8.18168822157359 + x * (-23.55507217389693 + x * (-71.04099935893065 + x * (-221.879685319235 + x * (-712.1364793277636 + x * (-2336.1253314403966 + x * (-7801.945954775964 + x * (-26448.19586059192 + x * (-90799.48341621365 + x * (-315126.04064491636 + x * -1.1040113443115912e6)))))))))))))));
}
var poly_p8_default2 = evalpoly111;

function evalpoly112(x) {
  if (x === 0) {
    return 1.1613071521962828;
  }
  return 1.1613071521962828 + x * (-0.7011002845552895 + x * (-0.5805514744654373 + x * (-1.2436930610777865 + x * (-3.679383613496635 + x * (-12.815909243378957 + x * (-49.25672530759985 + x * (-202.18187354340904 + x * (-869.8602699308701 + x * (-3877.0058473132895 + x * (-17761.7071017094 + x * (-83182.69029154233 + x * (-396650.4505013548 + x * -1.9200334136826345e6))))))))))));
}
var poly_p9_default2 = evalpoly112;

function evalpoly113(x) {
  if (x === 0) {
    return 1.1246173251197522;
  }
  return 1.1246173251197522 + x * (-0.7708450563609095 + x * (-0.8447940536449113 + x * (-2.4900973094503946 + x * (-10.239717411543843 + x * (-49.7490054655148 + x * (-267.09866751957054 + x * (-1532.66588382523 + x * (-9222.313478526092 + x * (-57502.51612140314 + x * (-368596.11674161063 + x * (-2.4156110887010912e6 + x * (-16120097815816568e-9 + x * (-10920993852030899e-8 + x * (-7493807581942496e-7 + x * (-5198725846725541e-6 + x * -364092568881214e-4)))))))))))))));
}
var poly_p10_default2 = evalpoly113;

function evalpoly114(x) {
  if (x === 0) {
    return 1.5910034537907922;
  }
  return 1.5910034537907922 + x * (0.41600074399178694 + x * (0.24579151426410342 + x * (0.17948148291490615 + x * (0.14455605708755515 + x * (0.12320099331242772 + x * (0.10893881157429353 + x * (0.09885340987159291 + x * (0.09143962920174975 + x * (0.0858425915954139 + x * 0.08154111871830322)))))))));
}
var poly_p11_default2 = evalpoly114;

function evalpoly115(x) {
  if (x === 0) {
    return 1.5509733517804722;
  }
  return 1.5509733517804722 + x * (-0.4003010201031985 + x * (-0.07849861944294194 + x * (-0.034318853117591995 + x * (-0.0197180433173655 + x * (-0.01305950773199331 + x * (-0.009442372874146548 + x * (-0.007246728512402157 + x * (-0.00580742401295609 + x * -0.004809187786009338))))))));
}
var poly_p12_default2 = evalpoly115;

function ellipe(m) {
  var FLG2;
  var kdm;
  var edm;
  var td;
  var km;
  var t;
  var x;
  x = m;
  if (m < 0) {
    x = m / (m - 1);
    FLG2 = true;
  }
  if (x === 0) {
    return lib_default54;
  }
  if (x === 1) {
    return 1;
  }
  if (x > 1) {
    return NaN;
  }
  if (x < 0.1) {
    t = poly_p1_default2(x - 0.05);
  } else if (x < 0.2) {
    t = poly_p2_default2(x - 0.15);
  } else if (x < 0.3) {
    t = poly_p3_default2(x - 0.25);
  } else if (x < 0.4) {
    t = poly_p4_default2(x - 0.35);
  } else if (x < 0.5) {
    t = poly_p5_default2(x - 0.45);
  } else if (x < 0.6) {
    t = poly_p6_default2(x - 0.55);
  } else if (x < 0.7) {
    t = poly_p7_default2(x - 0.65);
  } else if (x < 0.8) {
    t = poly_p8_default2(x - 0.75);
  } else if (x < 0.85) {
    t = poly_p9_default2(x - 0.825);
  } else if (x < 0.9) {
    t = poly_p10_default2(x - 0.875);
  } else {
    td = 0.95 - x;
    kdm = poly_p11_default2(td);
    edm = poly_p12_default2(td);
    km = lib_default271(x);
    t = (lib_default54 + km * (kdm - edm)) / kdm;
  }
  if (FLG2) {
    return t * lib_default31(1 - m);
  }
  return t;
}
var main_default215 = ellipe;

var lib_default272 = main_default215;

var sincos7 = lib_default130.assign;
var debug3 = alias_debug_default("ellipj:assign");
var tmp4 = [0, 0, 0, 0];
var tmp2 = [0, 0];
var ca = [0, 0, 0, 0, 0, 0, 0, 0, 0];
function assign(u, m, out, stride, offset) {
  var dnDenom;
  var NANFLG;
  var uK2cen;
  var k1inv;
  var sechu;
  var sinhu;
  var tanhu;
  var phi0;
  var phi1;
  var atmp;
  var FLG2;
  var gdu;
  var uK2;
  var uK4;
  var mu;
  var K2;
  var K4;
  var u0;
  var sn2;
  var cn2;
  var dn2;
  var am2;
  var k;
  var s;
  var c2;
  var f;
  var a;
  var b;
  var N;
  if (m < 0) {
    mu = -m / (1 - m);
    k1inv = lib_default31(1 - m);
    assign(u * k1inv, mu, tmp4, 1, 0);
    sn2 = tmp4[0] / tmp4[2] / k1inv;
    cn2 = tmp4[1] / tmp4[2];
    dn2 = 1 / tmp4[2];
    am2 = NaN;
  } else if (m > 1) {
    k = lib_default31(m);
    assign(u * k, 1 / m, tmp4, 1, 0);
    sn2 = tmp4[0] / k;
    cn2 = tmp4[2];
    dn2 = tmp4[1];
    am2 = NaN;
  } else if (m === 0) {
    sincos7(u, tmp2, 1, 0);
    sn2 = tmp2[0];
    cn2 = tmp2[1];
    dn2 = 1;
    am2 = u;
  } else if (m === 1) {
    sn2 = lib_default253(u);
    cn2 = 1 / lib_default236(u);
    dn2 = cn2;
    am2 = lib_default55(lib_default264(u));
  } else if (m < lib_default169) {
    K4 = 4 * lib_default271(m);
    u0 = (u % K4 + K4) % K4;
    sincos7(u0, tmp2, 1, 0);
    s = tmp2[0];
    c2 = tmp2[1];
    f = 0.25 * m * (u0 - s * c2);
    sn2 = s - f * c2;
    cn2 = c2 + f * s;
    dn2 = 1 - 0.5 * m * s * s;
    am2 = u - 0.25 * m * (u - s * c2);
  } else if (m > 1 - lib_default169) {
    K2 = lib_default271(m) * 2;
    uK2cen = u / K2 + 0.5;
    uK2 = K2 * (uK2cen % 1 - 0.5);
    uK4 = uK2cen % 4;
    FLG2 = uK4 >= 1 && uK4 < 2;
    sinhu = lib_default264(uK2);
    sechu = 1 / lib_default236(uK2);
    tanhu = lib_default253(uK2);
    gdu = lib_default105(uK2cen) * lib_default26 + lib_default55(sinhu);
    a = 0.25 * (1 - m);
    b = a * (sinhu - uK2 * sechu);
    sn2 = tanhu + b * sechu;
    cn2 = sechu - b * tanhu;
    dn2 = sechu + a * (sinhu + uK2 * sechu) * tanhu;
    am2 = gdu + b;
    if (FLG2) {
      sn2 = -sn2;
      cn2 = -cn2;
    }
  } else {
    a = 1;
    b = lib_default31(1 - m);
    N = -1;
    NANFLG = false;
    do {
      N += 1;
      if (N > 8) {
        NANFLG = true;
        sn2 = NaN;
        cn2 = NaN;
        dn2 = NaN;
        am2 = NaN;
        debug3("Warning: Overflow encountered in iteration. Returning NaN for all output values.");
        break;
      }
      atmp = (a + b) * 0.5;
      c2 = (a - b) * 0.5;
      b = lib_default31(a * b);
      a = atmp;
      ca[N] = c2 / a;
    } while (ca[N] >= lib_default144);
    if (!NANFLG) {
      phi1 = (1 << N) * (u * a);
      while (N > 1) {
        N -= 1;
        phi1 = 0.5 * (phi1 + lib_default33(ca[N] * lib_default156(phi1)));
      }
      phi0 = 0.5 * (phi1 + lib_default33(ca[0] * lib_default156(phi1)));
      am2 = phi0;
      sincos7(am2, tmp2, 1, 0);
      sn2 = tmp2[0];
      cn2 = tmp2[1];
      dnDenom = lib_default165(phi1 - phi0);
      if (lib_default(dnDenom) < 0.1) {
        dn2 = lib_default31(1 - m * sn2 * sn2);
      } else {
        dn2 = cn2 / dnDenom;
      }
    }
  }
  out[offset] = sn2;
  out[offset + stride] = cn2;
  out[offset + stride * 2] = dn2;
  out[offset + stride * 3] = am2;
  return out;
}
var assign_default5 = assign;

function ellipj(u, m) {
  return assign_default5(u, m, [0, 0, 0, 0], 1, 0);
}
var main_default216 = ellipj;

var tmp = [0, 0, 0, 0];
function sn(u, m) {
  assign_default5(u, m, tmp, 1, 0);
  return tmp[0];
}
var sn_default = sn;

var tmp3 = [0, 0, 0, 0];
function cn(u, m) {
  assign_default5(u, m, tmp3, 1, 0);
  return tmp3[1];
}
var cn_default = cn;

var tmp5 = [0, 0, 0, 0];
function dn(u, m) {
  assign_default5(u, m, tmp5, 1, 0);
  return tmp5[2];
}
var dn_default = dn;

var tmp6 = [0, 0, 0, 0];
function am(u, m) {
  assign_default5(u, m, tmp6, 1, 0);
  return tmp6[3];
}
var am_default = am;

main_default216.assign = assign_default5;
main_default216.sn = sn_default;
main_default216.cn = cn_default;
main_default216.dn = dn_default;
main_default216.am = am_default;
var lib_default273 = main_default216;

function evalpoly116(x) {
  if (x === 0) {
    return -0.3250421072470015;
  }
  return -0.3250421072470015 + x * (-0.02848174957559851 + x * (-0.005770270296489442 + x * -23763016656650163e-21));
}
var polyval_pp_default2 = evalpoly116;

function evalpoly117(x) {
  if (x === 0) {
    return 0.39791722395915535;
  }
  return 0.39791722395915535 + x * (0.0650222499887673 + x * (0.005081306281875766 + x * (13249473800432164e-20 + x * -3960228278775368e-21)));
}
var polyval_qq_default2 = evalpoly117;

function evalpoly118(x) {
  if (x === 0) {
    return 0.41485611868374833;
  }
  return 0.41485611868374833 + x * (-0.3722078760357013 + x * (0.31834661990116175 + x * (-0.11089469428239668 + x * (0.035478304325618236 + x * -0.002166375594868791))));
}
var polyval_pa_default2 = evalpoly118;

function evalpoly119(x) {
  if (x === 0) {
    return 0.10642088040084423;
  }
  return 0.10642088040084423 + x * (0.540397917702171 + x * (0.07182865441419627 + x * (0.12617121980876164 + x * (0.01363708391202905 + x * 0.011984499846799107))));
}
var polyval_qa_default2 = evalpoly119;

function evalpoly120(x) {
  if (x === 0) {
    return -0.6938585727071818;
  }
  return -0.6938585727071818 + x * (-10.558626225323291 + x * (-62.375332450326006 + x * (-162.39666946257347 + x * (-184.60509290671104 + x * (-81.2874355063066 + x * -9.814329344169145)))));
}
var polyval_ra_default2 = evalpoly120;

function evalpoly121(x) {
  if (x === 0) {
    return 19.651271667439257;
  }
  return 19.651271667439257 + x * (137.65775414351904 + x * (434.56587747522923 + x * (645.3872717332679 + x * (429.00814002756783 + x * (108.63500554177944 + x * (6.570249770319282 + x * -0.0604244152148581))))));
}
var polyval_sa_default2 = evalpoly121;

function evalpoly122(x) {
  if (x === 0) {
    return -0.799283237680523;
  }
  return -0.799283237680523 + x * (-17.757954917754752 + x * (-160.63638485582192 + x * (-637.5664433683896 + x * (-1025.0951316110772 + x * -483.5191916086514))));
}
var polyval_rb_default2 = evalpoly122;

function evalpoly123(x) {
  if (x === 0) {
    return 30.33806074348246;
  }
  return 30.33806074348246 + x * (325.7925129965739 + x * (1536.729586084437 + x * (3199.8582195085955 + x * (2553.0504064331644 + x * (474.52854120695537 + x * -22.44095244658582)))));
}
var polyval_sb_default2 = evalpoly123;

var TINY8 = 1e-300;
var VERY_TINY = 2848094538889218e-321;
var SMALL4 = 3725290298461914e-24;
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
  if (lib_default30(x)) {
    return NaN;
  }
  if (x === lib_default43) {
    return 1;
  }
  if (x === lib_default44) {
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
    if (ax < SMALL4) {
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
      return TINY8 - 1;
    }
    return 1 - TINY8;
  }
  s = 1 / (ax * ax);
  if (ax < 2.857142857142857) {
    r = RAC2 + s * polyval_ra_default2(s);
    s = SAC2 + s * polyval_sa_default2(s);
  } else {
    r = RBC2 + s * polyval_rb_default2(s);
    s = SBC2 + s * polyval_sb_default2(s);
  }
  z = lib_default139(ax, 0);
  r = lib_default138(-(z * z) - 0.5625) * lib_default138((z - ax) * (z + ax) + r / s);
  if (sign) {
    return r / ax - 1;
  }
  return 1 - r / ax;
}
var main_default217 = erf;

var lib_default274 = main_default217;

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
  var t = lib_default105(y100);
  var f = table[t];
  return f(2 * y100 - (2 * t + 1));
}
var erfcx_y100_default = erfcxY100;

var INV_SQRT_PI = 0.5641895835477563;
function erfcx(x) {
  var x26;
  if (lib_default30(x)) {
    return x;
  }
  if (x >= 0) {
    if (x > 50) {
      if (x > 5e7) {
        return INV_SQRT_PI / x;
      }
      x26 = x * x;
      return INV_SQRT_PI * (x26 * (x26 + 4.5) + 2) / (x * (x26 * (x26 + 5) + 3.75));
    }
    return erfcx_y100_default(400 / (4 + x));
  }
  if (x < -26.7) {
    return lib_default43;
  }
  x26 = x * x;
  if (x < -6.1) {
    return 2 * lib_default138(x26);
  }
  return 2 * lib_default138(x26) - erfcx_y100_default(400 / (4 - x));
}
var main_default218 = erfcx;

var lib_default275 = main_default218;

function evalrational50(x) {
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
var rational_p1q1_default8 = evalrational50;

function evalrational51(x) {
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
var rational_p2q2_default8 = evalrational51;

function evalrational52(x) {
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
var rational_p3q3_default5 = evalrational52;

function evalrational53(x) {
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
var rational_p4q4_default3 = evalrational53;

function evalrational54(x) {
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
var rational_p5q5_default3 = evalrational54;

var Y14 = 0.08913147449493408;
var Y24 = 2.249481201171875;
var Y34 = 0.807220458984375;
var Y42 = 0.9399557113647461;
var Y52 = 0.9836282730102539;
function erfinv(x) {
  var sign;
  var ax;
  var qs;
  var q;
  var g;
  var r;
  if (lib_default30(x)) {
    return NaN;
  }
  if (x === 1) {
    return lib_default43;
  }
  if (x === -1) {
    return lib_default44;
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
    r = rational_p1q1_default8(ax);
    return sign * (g * Y14 + g * r);
  }
  if (q >= 0.25) {
    g = lib_default31(-2 * lib_default48(q));
    q -= 0.25;
    r = rational_p2q2_default8(q);
    return sign * (g / (Y24 + r));
  }
  q = lib_default31(-lib_default48(q));
  if (q < 3) {
    qs = q - 1.125;
    r = rational_p3q3_default5(qs);
    return sign * (Y34 * q + r * q);
  }
  if (q < 6) {
    qs = q - 3;
    r = rational_p4q4_default3(qs);
    return sign * (Y42 * q + r * q);
  }
  qs = q - 6;
  r = rational_p5q5_default3(qs);
  return sign * (Y52 * q + r * q);
}
var main_default219 = erfinv;

var lib_default276 = main_default219;

function evalpoly124(x) {
  if (x === 0) {
    return 2394.2374120738828;
  }
  return 2394.2374120738828 + x * (406.7172899368727 + x * (11.745273255434405 + x * 0.040996251979858706));
}
var polyval_p_default10 = evalpoly124;

function evalpoly125(x) {
  if (x === 0) {
    return 2079.608192860019;
  }
  return 2079.608192860019 + x * (1272.0927117834513 + x * (85.09361608493066 + x * 1));
}
var polyval_q_default6 = evalpoly125;

var LOG210 = 3.321928094887362;
var LG102A = 0.301025390625;
var LG102B = 4605038981195214e-21;
function exp10(x) {
  var px;
  var xx;
  var n;
  if (lib_default30(x)) {
    return x;
  }
  if (x > lib_default215) {
    return lib_default43;
  }
  if (x < lib_default220) {
    return 0;
  }
  px = lib_default105(LOG210 * x + 0.5);
  n = px;
  x -= px * LG102A;
  x -= px * LG102B;
  xx = x * x;
  px = x * polyval_p_default10(xx);
  x = px / (polyval_q_default6(xx) - px);
  x = 1 + lib_default125(x, 1);
  return lib_default125(x, n);
}
var main_default220 = exp10;

var lib_default277 = main_default220;

function evalpoly126(x) {
  if (x === 0) {
    return 1513.906801156151;
  }
  return 1513.906801156151 + x * (20.202065669316532 + x * 0.023093347705734523);
}
var polyval_p_default11 = evalpoly126;

function evalpoly127(x) {
  if (x === 0) {
    return 4368.211668792106;
  }
  return 4368.211668792106 + x * (233.1842117223149 + x * 1);
}
var polyval_q_default7 = evalpoly127;

var FLOAT64_MIN_BASE2_EXPONENT = -1022 | 0;
var lib_default278 = FLOAT64_MIN_BASE2_EXPONENT;

var FLOAT64_MAX_BASE2_EXPONENT2 = lib_default119;
var FLOAT64_MIN_BASE2_EXPONENT2 = lib_default278;
function exp2(x) {
  var px;
  var xx;
  var n;
  if (lib_default30(x)) {
    return x;
  }
  if (x > FLOAT64_MAX_BASE2_EXPONENT2) {
    return lib_default43;
  }
  if (x < FLOAT64_MIN_BASE2_EXPONENT2) {
    return 0;
  }
  n = lib_default128(x);
  x -= n;
  xx = x * x;
  px = x * polyval_p_default11(xx);
  x = px / (polyval_q_default7(xx) - px);
  x = 1 + lib_default125(x, 1);
  return lib_default125(x, n);
}
var main_default221 = exp2;

var lib_default279 = main_default221;

function expit(x) {
  if (lib_default30(x)) {
    return x;
  }
  return 1 / (1 + lib_default138(-x));
}
var main_default222 = expit;

var lib_default280 = main_default222;

var HUGE_VALUE = 709.782712893384;
var OVERFLOW_THRESHOLD2 = 716.3568913878179;
function expm1rel(x) {
  var tmp7;
  if (lib_default(x) <= lib_default144) {
    return 1;
  }
  if (x < HUGE_VALUE) {
    return lib_default147(x) / x;
  }
  if (x >= OVERFLOW_THRESHOLD2) {
    return lib_default43;
  }
  tmp7 = lib_default147(x / 2);
  return tmp7 / x * (tmp7 + 2);
}
var main_default223 = expm1rel;

var lib_default281 = main_default223;

var FLOAT64_MAX_NTH_DOUBLE_FACTORIAL = 300 | 0;
var lib_default282 = FLOAT64_MAX_NTH_DOUBLE_FACTORIAL;

var FLOAT64_MAX_NTH_DOUBLE_FACTORIAL2 = lib_default282;
function factorial2(n) {
  var last;
  var out;
  var v3;
  var i;
  if (lib_default30(n) || !lib_default106(n)) {
    return NaN;
  }
  if (n > FLOAT64_MAX_NTH_DOUBLE_FACTORIAL2) {
    return lib_default43;
  }
  v3 = n | 0;
  if (v3 === 0 | 0 || v3 === 1 | 0) {
    return 1 | 0;
  }
  if (lib_default108(v3)) {
    last = 2 | 0;
  } else {
    last = 3 | 0;
  }
  out = 1;
  for (i = v3 | 0; i >= last; i -= 2 | 0) {
    out *= i | 0;
  }
  return out;
}
var main_default224 = factorial2;

var lib_default283 = main_default224;

var FLOAT32_MAX_NTH_DOUBLE_FACTORIAL = 56 | 0;
var lib_default284 = FLOAT32_MAX_NTH_DOUBLE_FACTORIAL;

var FLOAT32_MAX_NTH_DOUBLE_FACTORIAL2 = lib_default284;
function factorial2f(n) {
  var last;
  var out;
  var v3;
  var i;
  if (lib_default6(n) || !lib_default111(n)) {
    return NaN;
  }
  if (n > FLOAT32_MAX_NTH_DOUBLE_FACTORIAL2) {
    return lib_default7;
  }
  v3 = n | 0;
  if (v3 === 0 | 0 || v3 === 1 | 0) {
    return 1 | 0;
  }
  if (lib_default113(v3)) {
    last = 2 | 0;
  } else {
    last = 3 | 0;
  }
  out = lib_default3(1);
  for (i = v3 | 0; i >= last; i -= 2 | 0) {
    out = lib_default3(out * i);
  }
  return out;
}
var main_default225 = factorial2f;

var lib_default285 = main_default225;

function isNegativeInteger(x) {
  return lib_default105(x) === x && x < 0;
}
var main_default226 = isNegativeInteger;

var lib_default286 = main_default226;

function factorialln(x) {
  if (lib_default286(x)) {
    return NaN;
  }
  return lib_default167(x + 1);
}
var main_default227 = factorialln;

var lib_default287 = main_default227;

function isNegativeIntegerf(x) {
  return lib_default16(x) === x && x < 0;
}
var main_default228 = isNegativeIntegerf;

var lib_default288 = main_default228;

var ONE12 = lib_default3(1);
function factoriallnf(x) {
  x = lib_default3(x);
  if (lib_default288(x)) {
    return NaN;
  }
  return lib_default29(lib_default3(x + ONE12));
}
var main_default229 = factoriallnf;

var lib_default289 = main_default229;

function risingFactorial(x, n) {
  var result;
  var inv2;
  if (lib_default30(x) || !lib_default107(n)) {
    return NaN;
  }
  if (x < 0) {
    if (n < 0) {
      x += n;
      n = -n;
      inv2 = true;
    }
    result = (n & 1 ? -1 : 1) * fallingFactorial(-x, n);
    if (inv2) {
      result = 1 / result;
    }
    return result;
  }
  if (n === 0) {
    return 1;
  }
  if (x === 0) {
    if (n < 0) {
      return -lib_default164(x + 1, -n);
    }
    return 0;
  }
  if (x < 1 && x + n < 0) {
    result = lib_default164(1 - x, -n);
    return n & 1 ? -result : result;
  }
  return 1 / lib_default164(x, n);
}
function fallingFactorial(x, n) {
  var result;
  var xp1;
  var n2;
  var t1;
  var t2;
  if (lib_default30(x) || !lib_default106(n)) {
    return NaN;
  }
  if (x === 0) {
    return 0;
  }
  if (x < 0) {
    return (n & 1 ? -1 : 1) * risingFactorial(-x, n);
  }
  if (n === 0) {
    return 1;
  }
  if (x < 0.5) {
    if (n > lib_default160 - 2) {
      t1 = x * fallingFactorial(x - 1, lib_default160 - 2);
      t2 = fallingFactorial(x - lib_default160 + 1, n - lib_default160 + 1);
      if (lib_default152 / lib_default(t1) < lib_default(t2)) {
        return lib_default43;
      }
      return t1 * t2;
    }
    return x * fallingFactorial(x - 1, n - 1);
  }
  if (x <= n - 1) {
    xp1 = x + 1;
    n2 = lib_default(lib_default105(xp1));
    if (n2 === xp1) {
      return 0;
    }
    result = lib_default164(xp1, -n2);
    x -= n2;
    result *= x;
    n2 += 1;
    if (n2 < n) {
      result *= fallingFactorial(x - 1, n - n2);
    }
    return result;
  }
  return lib_default164(x + 1, -n);
}
var main_default230 = fallingFactorial;

var lib_default290 = main_default230;

function abs3(x) {
  if (x < 0) {
    return -x;
  }
  return x;
}
var main_default231 = abs3;

var lib_default291 = main_default231;

var ZERO12 = lib_default3(0);
function absf2(x) {
  x = lib_default3(x);
  if (x < ZERO12) {
    return lib_default3(-x);
  }
  return x;
}
var main_default232 = absf2;

var lib_default292 = main_default232;

function acosh2(x) {
  if (x < 1) {
    return NaN;
  }
  if (lib_default30(x) || lib_default76(x)) {
    return x;
  }
  return lib_default48(x + lib_default31(x + 1) * lib_default31(x - 1));
}
var main_default233 = acosh2;

var lib_default293 = main_default233;

var ALPHA = 0.96043387010342;
var BETA = 0.397824734759316;
function hypot(x, y) {
  x = lib_default291(x);
  y = lib_default291(y);
  if (x > y) {
    return ALPHA * x + BETA * y;
  }
  return ALPHA * y + BETA * x;
}
var main_default234 = hypot;

function hypot2(x, y) {
  if (x > y) {
    return x + (y >>> 1);
  }
  return (x >>> 1) + y;
}
var hypot1a_default = hypot2;

function labs(x) {
  var mask;
  var y;
  y = x | 0;
  mask = y >> 31 | 0;
  return (y ^ mask) - mask | 0;
}
var main_default235 = labs;

var lib_default294 = main_default235;

function hypot3(x, y) {
  x = lib_default294(x);
  y = lib_default294(y);
  if (x > y) {
    return x + (y >>> 1);
  }
  return (x >>> 1) + y;
}
var hypot1b_default = hypot3;

function hypot4(x, y) {
  if (x > y) {
    return x + (y >>> 2);
  }
  return (x >>> 2) + y;
}
var hypot2a_default = hypot4;

function hypot5(x, y) {
  x = lib_default294(x);
  y = lib_default294(y);
  if (x > y) {
    return x + (y >>> 2);
  }
  return (x >>> 2) + y;
}
var hypot2b_default = hypot5;

function wrap(alpha, beta2) {
  return hypot8;
  function hypot8(x, y) {
    if (x > y) {
      return alpha * x + beta2 * y;
    }
    return beta2 * x + alpha * y;
  }
}
var closure1a_default = wrap;

function wrap2(alpha, beta2) {
  return hypot8;
  function hypot8(x, y) {
    x = lib_default291(x);
    y = lib_default291(y);
    if (x > y) {
      return alpha * x + beta2 * y;
    }
    return beta2 * x + alpha * y;
  }
}
var closure1b_default = wrap2;

function factory2(alpha, beta2, nonnegative, ints) {
  if (ints) {
    if (alpha === 1 && beta2 === 0.5) {
      if (nonnegative) {
        return hypot1a_default;
      }
      return hypot1b_default;
    }
    if (alpha === 1 && beta2 === 0.25) {
      if (nonnegative) {
        return hypot2a_default;
      }
      return hypot2b_default;
    }
  }
  if (nonnegative) {
    return closure1a_default(alpha, beta2);
  }
  return closure1b_default(alpha, beta2);
}
var factory_default2 = factory2;

main_default234.factory = factory_default2;
var lib_default295 = main_default234;

function asinh2(x) {
  if (x === 0 || // +-0.0
  lib_default30(x) || lib_default76(x)) {
    return x;
  }
  if (x > 0) {
    return lib_default48(x + lib_default31(x * x + 1));
  }
  return -lib_default48(-x + lib_default31(x * x + 1));
}
var main_default236 = asinh2;

var lib_default296 = main_default236;

function atanh2(x) {
  if (x === 0) {
    return x;
  }
  if (lib_default30(x) || lib_default76(x)) {
    return NaN;
  }
  return 0.5 * lib_default48((1 + x) / (1 - x));
}
var main_default237 = atanh2;

var lib_default297 = main_default237;

var ZERO13 = lib_default3(0);
var ONE13 = lib_default3(1);
var HALF7 = lib_default3(0.5);
function atanhf2(x) {
  x = lib_default3(x);
  if (x === ZERO13) {
    return x;
  }
  if (lib_default6(x) || lib_default9(x)) {
    return NaN;
  }
  return lib_default3(HALF7 * lib_default15(lib_default3(lib_default3(ONE13 + x) / lib_default3(ONE13 - x))));
}
var main_default238 = atanhf2;

var lib_default298 = main_default238;

function hypot6(x, y) {
  return lib_default31(x * x + y * y);
}
var main_default239 = hypot6;

var lib_default299 = main_default239;

function hypotf(x, y) {
  x = lib_default3(x);
  y = lib_default3(y);
  return lib_default38(lib_default3(lib_default3(x * x) + lib_default3(y * y)));
}
var main_default240 = hypotf;

var lib_default300 = main_default240;

function max2(x, y) {
  if (x > y) {
    return x;
  }
  return y;
}
var main_default241 = max2;

var lib_default301 = main_default241;

function maxf(x, y) {
  x = lib_default3(x);
  y = lib_default3(y);
  if (x > y) {
    return x;
  }
  return y;
}
var main_default242 = maxf;

var lib_default302 = main_default242;

function min2(x, y) {
  if (x < y) {
    return x;
  }
  return y;
}
var main_default243 = min2;

var lib_default303 = main_default243;

function minf(x, y) {
  x = lib_default3(x);
  y = lib_default3(y);
  if (x < y) {
    return x;
  }
  return y;
}
var main_default244 = minf;

var lib_default304 = main_default244;

var ZERO14 = 0 | 0;
var ONE14 = 1 | 0;
function pow5(x, y) {
  var v3;
  if (lib_default30(x)) {
    return NaN;
  }
  if (y < ZERO14) {
    y = -y;
    if (x === 0) {
      x = 1 / x;
      if ((y & ONE14) === ONE14) {
        return x;
      }
      return lib_default43;
    }
    x = 1 / x;
  } else if (y === ZERO14) {
    return 1;
  }
  v3 = 1;
  while (y !== ZERO14) {
    if ((y & ONE14) === ONE14) {
      v3 *= x;
    }
    x *= x;
    y >>= ONE14;
  }
  return v3;
}
var main_default245 = pow5;

var lib_default305 = main_default245;

var B4 = 4294901760 >>> 0;
var B3 = 65280 >>> 0;
var B22 = 240 >>> 0;
var B12 = 12 >>> 0;
var B0 = 2 >>> 0;
var S43 = 16 >>> 0;
var S33 = 8 >>> 0;
var S23 = 4 >>> 0;
var S13 = 2 >>> 0;
var S0 = 1 >>> 0;
function log22(x) {
  var out = 0 >>> 0;
  var y = x >>> 0;
  if (y & B4) {
    y >>>= S43;
    out |= S43;
  }
  if (y & B3) {
    y >>>= S33;
    out |= S33;
  }
  if (y & B22) {
    y >>>= S23;
    out |= S23;
  }
  if (y & B12) {
    y >>>= S13;
    out |= S13;
  }
  if (y & B0) {
    y >>>= S0;
    out |= S0;
  }
  return out;
}
var main_default246 = log22;

var lib_default306 = main_default246;

var BIT = 1073741824 >>> 0;
function sqrt2(x) {
  var root;
  var bit;
  var sum;
  var y;
  y = x >>> 0;
  root = 0 >>> 0;
  bit = BIT;
  while (bit > y) {
    bit >>>= 2;
  }
  while (bit !== 0) {
    sum = root + bit >>> 0;
    root >>>= 1;
    if (x >= sum) {
      x -= sum;
      root += bit;
    }
    bit >>>= 2;
  }
  return root >>> 0;
}
var main_default247 = sqrt2;

var lib_default307 = main_default247;

var FLOAT64_MAX_SAFE_NTH_FIBONACCI = 78 | 0;
var lib_default308 = FLOAT64_MAX_SAFE_NTH_FIBONACCI;

var fibonacci_default = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765, 10946, 17711, 28657, 46368, 75025, 121393, 196418, 317811, 514229, 832040, 1346269, 2178309, 3524578, 5702887, 9227465, 14930352, 24157817, 39088169, 63245986, 102334155, 165580141, 267914296, 433494437, 701408733, 1134903170, 1836311903, 2971215073, 4807526976, 7778742049, 12586269025, 20365011074, 32951280099, 53316291173, 86267571272, 139583862445, 225851433717, 365435296162, 591286729879, 956722026041, 1548008755920, 2504730781961, 4052739537881, 6557470319842, 10610209857723, 17167680177565, 27777890035288, 44945570212853, 72723460248141, 117669030460994, 190392490709135, 308061521170129, 498454011879264, 806515533049393, 1304969544928657, 2111485077978050, 3416454622906707, 5527939700884757, 8944394323791464];

function fibonacci(n) {
  if (lib_default30(n) || !lib_default106(n) || n > lib_default308) {
    return NaN;
  }
  return fibonacci_default[n];
}
var main_default248 = fibonacci;

var lib_default309 = main_default248;

var SQRT_52 = 2.23606797749979;
var LN_PHI = lib_default48(lib_default201);
function fibonacciIndex(F3) {
  var x;
  if (lib_default30(F3) || lib_default107(F3) === false || F3 <= 1 || F3 === lib_default43) {
    return NaN;
  }
  x = F3 * SQRT_52 + 0.5;
  return lib_default128(lib_default48(x) / LN_PHI);
}
var main_default249 = fibonacciIndex;

var lib_default310 = main_default249;

var FLOAT32_PHI = lib_default3(1.618033988749895);
var lib_default311 = FLOAT32_PHI;

var ONE_HALF = lib_default3(0.5);
var SQRT_53 = lib_default3(2.23606797749979);
var LN_PHI2 = lib_default15(lib_default311);
function fibonacciIndexf(F3) {
  var x;
  if (lib_default6(F3) || lib_default112(F3) === false || F3 <= 1 || F3 === lib_default7) {
    return NaN;
  }
  x = lib_default3(lib_default3(F3 * SQRT_53) + ONE_HALF);
  return lib_default233(lib_default3(lib_default15(x) / LN_PHI2));
}
var main_default250 = fibonacciIndexf;

var lib_default312 = main_default250;

var FLOAT32_MAX_SAFE_NTH_FIBONACCI = 36 | 0;
var lib_default313 = FLOAT32_MAX_SAFE_NTH_FIBONACCI;

var fibonacci_default2 = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181, 6765, 10946, 17711, 28657, 46368, 75025, 121393, 196418, 317811, 514229, 832040, 1346269, 2178309, 3524578, 5702887, 9227465, 14930352];

function fibonaccif(n) {
  if (lib_default6(n) || !lib_default111(n) || n > lib_default313) {
    return NaN;
  }
  return fibonacci_default2[n];
}
var main_default251 = fibonaccif;

var lib_default314 = main_default251;

var WORDS7 = [0 >>> 0, 0 >>> 0];
function flipsign(x, y) {
  var hx;
  var hy;
  lib_default93.assign(x, WORDS7, 1, 0);
  hx = WORDS7[0];
  hy = lib_default41(y);
  hy &= lib_default91;
  hx ^= hy;
  return lib_default94(hx, WORDS7[1]);
}
var main_default252 = flipsign;

var lib_default315 = main_default252;

function flipsignf(x, y) {
  var wx;
  var wy;
  x = lib_default3(x);
  y = lib_default3(y);
  wx = lib_default10(x);
  wy = lib_default10(y);
  wy &= lib_default21;
  wx ^= wy;
  return lib_default11(wx);
}
var main_default253 = flipsignf;

var lib_default316 = main_default253;

function floor10(x) {
  var sign;
  var p101;
  if (lib_default30(x) || lib_default76(x) || x === 0) {
    return x;
  }
  if (x < 0) {
    x = -x;
    sign = -1;
  } else {
    sign = 1;
  }
  p101 = lib_default214(x);
  if (sign === 1) {
    p101 = lib_default105(p101);
  } else {
    p101 = lib_default136(p101);
  }
  if (p101 <= lib_default216) {
    return sign * 0;
  }
  if (p101 > lib_default215) {
    return lib_default44;
  }
  return sign * lib_default142(10, p101);
}
var main_default254 = floor10;

var lib_default317 = main_default254;

function floor2(x) {
  var sign;
  var p101;
  if (lib_default30(x) || lib_default76(x) || x === 0) {
    return x;
  }
  if (x < 0) {
    x = -x;
    sign = -1;
  } else {
    sign = 1;
  }
  p101 = lib_default218(x);
  if (p101 === lib_default121) {
    return x;
  }
  if (sign === 1) {
    p101 = lib_default105(p101);
  } else {
    p101 = lib_default136(p101);
  }
  if (p101 > lib_default119) {
    return lib_default44;
  }
  return sign * lib_default142(2, p101);
}
var main_default255 = floor2;

var lib_default318 = main_default255;

var ZERO15 = lib_default3(0);
function powf(x, y) {
  if (y === lib_default8) {
    return lib_default7;
  }
  if (y === lib_default7) {
    return ZERO15;
  }
  if (y > ZERO15) {
    if (lib_default114(y)) {
      return x;
    }
    return ZERO15;
  }
  if (lib_default114(y)) {
    return lib_default23(lib_default7, x);
  }
  return lib_default7;
}
var x_is_zerof_default = powf;

var NEG_ONE4 = lib_default3(-1);
var ZERO16 = lib_default3(0);
var ONE15 = lib_default3(1);
function powf2(x, y) {
  if (x === NEG_ONE4) {
    return ONE15;
  }
  if (x === ONE15) {
    return ONE15;
  }
  if (lib_default5(x) < ONE15 === (y === lib_default7)) {
    return ZERO16;
  }
  return lib_default7;
}
var y_is_infinitef_default = powf2;

function evalpoly128(x) {
  if (x === 0) {
    return 0.6000000238418579;
  }
  return lib_default3(0.6000000238418579 + lib_default3(x * lib_default3(0.4285714328289032 + lib_default3(x * lib_default3(0.3333333432674408 + lib_default3(x * lib_default3(0.2727281153202057 + lib_default3(x * lib_default3(0.23066075146198273 + lib_default3(x * 0.20697501301765442))))))))));
}
var polyval_l_default2 = evalpoly128;

var MIN_NORM_WORD = 8388608 | 0;
var ONE_WORD4 = 1065353216 | 0;
var TRUNC_MASK = 4294963200 | 0;
var SIGNIFICAND_HALF_WORD = 536870912 | 0;
var EXP_CORRECTION_WORD = 4194304 | 0;
var TWO244 = lib_default3(16777216);
var CP2 = lib_default3(0.96179670095);
var CP_HI2 = lib_default3(0.9619140625);
var CP_LO2 = lib_default3(-11736857402e-14);
var BP2 = [
  lib_default3(1),
  lib_default3(1.5)
];
var DP_HI2 = [
  lib_default3(0),
  lib_default3(0.584960938)
  // 0x3f15c000
];
var DP_LO2 = [
  lib_default3(0),
  lib_default3(156322085e-14)
  // 0x35d1cfdc
];
var ONE16 = lib_default3(1);
var THREE3 = lib_default3(3);
function log2axf(out, ax, ahx) {
  var tmp7;
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
  var v3;
  var n;
  var j;
  var k;
  n = 0 | 0;
  if (ahx < MIN_NORM_WORD) {
    ax = lib_default3(ax * TWO244);
    n -= 24 | 0;
    ahx = lib_default10(ax) | 0;
  }
  n += (ahx >> lib_default25) - lib_default13 | 0;
  j = ahx & lib_default14 | 0;
  ahx = j | ONE_WORD4 | 0;
  if (j <= 1885297) {
    k = 0;
  } else if (j < 6140887) {
    k = 1;
  } else {
    k = 0;
    n += 1 | 0;
    ahx -= MIN_NORM_WORD;
  }
  ax = lib_default11(ahx);
  bp = BP2[k];
  u = lib_default3(ax - bp);
  v3 = lib_default3(ONE16 / lib_default3(ax + bp));
  ss = lib_default3(u * v3);
  tmp7 = lib_default10(ss) | 0;
  hs = lib_default11(tmp7 & TRUNC_MASK);
  tmp7 = ahx >> 1 & TRUNC_MASK | SIGNIFICAND_HALF_WORD;
  tmp7 += EXP_CORRECTION_WORD;
  tmp7 += k << 21;
  ht = lib_default11(tmp7);
  lt = lib_default3(ax - lib_default3(ht - bp));
  ls = lib_default3(v3 * lib_default3(lib_default3(u - lib_default3(hs * ht)) - lib_default3(hs * lt)));
  s2 = lib_default3(ss * ss);
  r = lib_default3(lib_default3(s2 * s2) * polyval_l_default2(s2));
  r = lib_default3(r + lib_default3(ls * lib_default3(hs + ss)));
  s2 = lib_default3(hs * hs);
  ht = lib_default3(lib_default3(THREE3 + s2) + r);
  tmp7 = lib_default10(ht) | 0;
  ht = lib_default11(tmp7 & TRUNC_MASK);
  lt = lib_default3(r - lib_default3(lib_default3(ht - THREE3) - s2));
  u = lib_default3(hs * ht);
  v3 = lib_default3(lib_default3(ls * ht) + lib_default3(lt * ss));
  hp = lib_default3(u + v3);
  tmp7 = lib_default10(hp) | 0;
  hp = lib_default11(tmp7 & TRUNC_MASK);
  lp = lib_default3(v3 - lib_default3(hp - u));
  hz = lib_default3(CP_HI2 * hp);
  lz = lib_default3(lib_default3(lib_default3(CP_LO2 * hp) + lib_default3(lp * CP2)) + DP_LO2[k]);
  dp = DP_HI2[k];
  t = lib_default3(n);
  t1 = lib_default3(lib_default3(lib_default3(hz + lz) + dp) + t);
  tmp7 = lib_default10(t1) | 0;
  t1 = lib_default11(tmp7 & TRUNC_MASK);
  t2 = lib_default3(lz - lib_default3(lib_default3(lib_default3(t1 - t) - dp) - hz));
  out[0] = t1;
  out[1] = t2;
  return out;
}
var log2axf_default = log2axf;

function evalpoly129(x) {
  if (x === 0) {
    return 0.5;
  }
  return lib_default3(0.5 + lib_default3(x * lib_default3(-0.3333333432674408 + lib_default3(x * 0.25))));
}
var polyval_w_default4 = evalpoly129;

var TRUNC_MASK2 = 4294963200 | 0;
var INV_LN22 = lib_default3(1.4426950216);
var INV_LN2_HI2 = lib_default3(1.4426879883);
var INV_LN2_LO2 = lib_default3(70526075433e-16);
var ONE17 = lib_default3(1);
function logxf(out, ax) {
  var tmp7;
  var t2;
  var t1;
  var t;
  var w;
  var u;
  var v3;
  t = lib_default3(ax - ONE17);
  w = lib_default3(lib_default3(t * t) * polyval_w_default4(t));
  u = lib_default3(INV_LN2_HI2 * t);
  v3 = lib_default3(lib_default3(t * INV_LN2_LO2) - lib_default3(w * INV_LN22));
  t1 = lib_default3(u + v3);
  tmp7 = lib_default10(t1) | 0;
  t1 = lib_default11(tmp7 & TRUNC_MASK2);
  t2 = lib_default3(v3 - lib_default3(t1 - u));
  out[0] = t1;
  out[1] = t2;
  return out;
}
var logxf_default = logxf;

var TWO253 = 33554432;
var TWOM25 = 29802322387695312e-24;
var FLOAT32_SIGNIFICAND_MASK_WITH_SIGN = 2155872255;
var ALL_ONES = 255;
function ldexpf(frac, exp3) {
  var ix;
  var k;
  frac = lib_default3(frac);
  ix = lib_default10(frac);
  k = (ix & lib_default12) >> lib_default50 - 1;
  if (k === 0) {
    if ((ix & lib_default22) === 0) {
      return frac;
    }
    frac = lib_default3(frac * TWO253);
    ix = lib_default10(frac);
    k = ((ix & lib_default12) >> lib_default50 - 1) - 25;
    if (exp3 < -5e4) {
      return 0;
    }
  }
  if (k === ALL_ONES) {
    return lib_default3(frac + frac);
  }
  k = k + exp3 | 0;
  if (k > ALL_ONES - 1) {
    return lib_default23(lib_default7, frac);
  }
  if (k > 0) {
    frac = lib_default11(ix & FLOAT32_SIGNIFICAND_MASK_WITH_SIGN | k << lib_default50 - 1);
    return frac;
  }
  if (k <= -25) {
    if (exp3 > 5e4) {
      return lib_default23(lib_default7, frac);
    }
    return lib_default23(0, frac);
  }
  k += 25;
  frac = lib_default11(ix & FLOAT32_SIGNIFICAND_MASK_WITH_SIGN | k << lib_default50 - 1);
  return lib_default3(frac * TWOM25);
}
var main_default256 = ldexpf;

var lib_default319 = main_default256;

function evalpoly130(x) {
  if (x === 0) {
    return 0.1666666716337204;
  }
  return lib_default3(0.1666666716337204 + lib_default3(x * lib_default3(-0.0027777778450399637 + lib_default3(x * lib_default3(661375597701408e-19 + lib_default3(x * lib_default3(-16533901998627698e-22 + lib_default3(x * 4138136944220605e-23))))))));
}
var polyval_p_default12 = evalpoly130;

var MIN_NORM_WORD2 = 8388608 | 0;
var HALF_WORD4 = 1056964608 | 0;
var TRUNC_MASK_15 = 4294934528 | 0;
var LN2_HI8 = lib_default3(0.693145752);
var LN2_LO8 = lib_default3(142860654e-14);
var ONE18 = lib_default3(1);
var TWO7 = lib_default3(2);
function pow2f(j, hp, lp) {
  var tmp7;
  var t1;
  var t;
  var r;
  var u;
  var v3;
  var w;
  var z;
  var n;
  var i;
  var k;
  i = j & lib_default22 | 0;
  k = (i >> lib_default25) - lib_default13 | 0;
  n = 0;
  if (i > HALF_WORD4) {
    n = j + (MIN_NORM_WORD2 >> k + 1) | 0;
    k = ((n & lib_default22) >> lib_default25) - lib_default13 | 0;
    tmp7 = n & ~(lib_default14 >> k) | 0;
    t = lib_default11(tmp7);
    n = (n & lib_default14 | MIN_NORM_WORD2) >> lib_default25 - k | 0;
    if (j < 0) {
      n = -n;
    }
    hp = lib_default3(hp - t);
  }
  t = lib_default3(lp + hp);
  tmp7 = lib_default10(t) | 0;
  t = lib_default11(tmp7 & TRUNC_MASK_15);
  u = lib_default3(t * LN2_HI8);
  v3 = lib_default3(lib_default3(lib_default3(lp - lib_default3(t - hp)) * lib_default52) + lib_default3(t * LN2_LO8));
  z = lib_default3(u + v3);
  w = lib_default3(v3 - lib_default3(z - u));
  t = lib_default3(z * z);
  t1 = lib_default3(z - lib_default3(t * polyval_p_default12(t)));
  r = lib_default3(lib_default3(lib_default3(z * t1) / lib_default3(t1 - TWO7)) - lib_default3(w + lib_default3(z * w)));
  z = lib_default3(ONE18 - lib_default3(r - z));
  j = lib_default10(z) | 0;
  j += n >>> 0 << lib_default25 | 0;
  if (j >> lib_default25 <= 0) {
    z = lib_default319(z, n);
  } else {
    z = lib_default11(j);
  }
  return z;
}
var pow2f_default = pow2f;

var ZERO17 = lib_default3(0);
var HALF8 = lib_default3(0.5);
var ONE19 = lib_default3(1);
var TWO8 = lib_default3(2);
var THREE4 = lib_default3(3);
var NEG_ZERO = lib_default3(-0);
var NEG_HALF = lib_default3(-0.5);
var NEG_ONE5 = lib_default3(-1);
var HUGE8 = lib_default3(1e30);
var TINY9 = lib_default3(1e-30);
var OVT2 = lib_default3(42995665694e-18);
var Y_LARGE_WORD = 1291845632 | 0;
var X_BELOW_ONE_WORD = 1065353206 | 0;
var X_ABOVE_ONE_WORD = 1065353223 | 0;
var TRUNC_MASK_12 = 4294963200 | 0;
var Z_OVF_WORD = 1124073472 | 0;
var Z_UNF_WORD = 1125515264 | 0;
var Z_NEG_UNF_WORD = 3272998912 | 0;
var LOG_WORKSPACE2 = [0, 0];
function powf3(x, y) {
  var tmp7;
  var ahx;
  var ahy;
  var ax;
  var hx;
  var hy;
  var sn2;
  var y12;
  var hp;
  var lp;
  var t;
  var z;
  var j;
  x = lib_default3(x);
  y = lib_default3(y);
  if (y === ZERO17) {
    return ONE19;
  }
  if (x === ONE19) {
    return ONE19;
  }
  if (lib_default6(x) || lib_default6(y)) {
    return NaN;
  }
  if (y === ONE19) {
    return x;
  }
  if (y === NEG_ONE5) {
    return lib_default3(ONE19 / x);
  }
  if (y === HALF8) {
    return lib_default38(x);
  }
  if (y === NEG_HALF) {
    return lib_default3(ONE19 / lib_default38(x));
  }
  if (y === TWO8) {
    return lib_default3(x * x);
  }
  if (y === THREE4) {
    return lib_default3(lib_default3(x * x) * x);
  }
  if (lib_default9(y)) {
    return y_is_infinitef_default(x, y);
  }
  if (x === ZERO17) {
    return x_is_zerof_default(x, y);
  }
  if (x === NEG_ONE5) {
    if (lib_default112(y)) {
      return lib_default114(y) ? NEG_ONE5 : ONE19;
    }
  }
  if (lib_default9(x)) {
    if (x === lib_default8) {
      return powf3(NEG_ZERO, lib_default3(-y));
    }
    if (y < ZERO17) {
      return ZERO17;
    }
    return lib_default7;
  }
  if (x < ZERO17 && lib_default112(y) === false) {
    return NaN;
  }
  ax = lib_default5(x);
  hx = lib_default10(x) | 0;
  hy = lib_default10(y) | 0;
  ahx = hx & lib_default22 | 0;
  ahy = hy & lib_default22 | 0;
  if (x < ZERO17 && lib_default114(y)) {
    sn2 = NEG_ONE5;
  } else {
    sn2 = ONE19;
  }
  if (ahy > Y_LARGE_WORD) {
    if (ahx < X_BELOW_ONE_WORD) {
      if (y < ZERO17) {
        return lib_default3(lib_default3(sn2 * HUGE8) * HUGE8);
      }
      return lib_default3(lib_default3(sn2 * TINY9) * TINY9);
    }
    if (ahx > X_ABOVE_ONE_WORD) {
      if (y > ZERO17) {
        return lib_default3(lib_default3(sn2 * HUGE8) * HUGE8);
      }
      return lib_default3(lib_default3(sn2 * TINY9) * TINY9);
    }
    t = logxf_default(LOG_WORKSPACE2, ax);
  } else {
    t = log2axf_default(LOG_WORKSPACE2, ax, ahx);
  }
  tmp7 = lib_default10(y) | 0;
  y12 = lib_default11(tmp7 & TRUNC_MASK_12);
  lp = lib_default3(lib_default3(lib_default3(y - y12) * t[0]) + lib_default3(y * t[1]));
  hp = lib_default3(y12 * t[0]);
  z = lib_default3(lp + hp);
  j = lib_default10(z) | 0;
  if (j > Z_OVF_WORD) {
    return lib_default3(lib_default3(sn2 * HUGE8) * HUGE8);
  }
  if (j === Z_OVF_WORD) {
    if (lib_default3(lp + OVT2) > lib_default3(z - hp)) {
      return lib_default3(lib_default3(sn2 * HUGE8) * HUGE8);
    }
  }
  if ((j & lib_default22) > Z_UNF_WORD) {
    return lib_default3(lib_default3(sn2 * TINY9) * TINY9);
  }
  if (j === Z_NEG_UNF_WORD) {
    if (lp <= lib_default3(z - hp)) {
      return lib_default3(lib_default3(sn2 * TINY9) * TINY9);
    }
  }
  z = pow2f_default(j, hp, lp);
  return lib_default3(sn2 * z);
}
var main_default257 = powf3;

var lib_default320 = main_default257;

var FLOAT32_MAX_BASE2_EXPONENT = 127 | 0;
var lib_default321 = FLOAT32_MAX_BASE2_EXPONENT;

var FLOAT32_MIN_BASE2_EXPONENT_SUBNORMAL = -149 | 0;
var lib_default322 = FLOAT32_MIN_BASE2_EXPONENT_SUBNORMAL;

var ZERO18 = lib_default3(0);
var TWO9 = lib_default3(2);
var ONE20 = lib_default3(1);
function floor2f(x) {
  var sign;
  var p101;
  x = lib_default3(x);
  if (lib_default6(x) || lib_default9(x) || x === ZERO18) {
    return x;
  }
  if (x < ZERO18) {
    x = -x;
    sign = -ONE20;
  } else {
    sign = ONE20;
  }
  p101 = lib_default3(lib_default218(x));
  if (p101 === lib_default322) {
    return lib_default3(sign * x);
  }
  if (sign === ONE20) {
    p101 = lib_default16(p101);
  } else {
    p101 = lib_default17(p101);
  }
  if (p101 > lib_default321) {
    return lib_default8;
  }
  return lib_default3(sign * lib_default320(TWO9, p101));
}
var main_default258 = floor2f;

var lib_default323 = main_default258;

var MAX_INT2 = lib_default185 + 1;
var HUGE9 = 1e308;
function floorn(x, n) {
  var s;
  var y;
  if (lib_default30(x) || lib_default30(n) || lib_default76(n)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0 || n < lib_default216 || lib_default(x) > MAX_INT2 && n <= 0) {
    return x;
  }
  if (n > lib_default215) {
    if (x >= 0) {
      return 0;
    }
    return lib_default44;
  }
  if (n < lib_default220) {
    s = lib_default142(10, -(n + lib_default215));
    y = x * HUGE9 * s;
    if (lib_default76(y)) {
      return x;
    }
    return lib_default105(y) / HUGE9 / s;
  }
  s = lib_default142(10, -n);
  y = x * s;
  if (lib_default76(y)) {
    return x;
  }
  return lib_default105(y) / s;
}
var main_default259 = floorn;

var lib_default324 = main_default259;

function floorb(x, n, b) {
  var y;
  var s;
  if (lib_default30(x) || lib_default30(n) || lib_default30(b) || b <= 0 || lib_default76(n) || lib_default76(b)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0) {
    return x;
  }
  if (b === 10) {
    return lib_default324(x, n);
  }
  if (n === 0 || b === 1) {
    return lib_default105(x);
  }
  s = lib_default142(b, -n);
  if (lib_default76(s)) {
    return x;
  }
  y = lib_default105(x * s) / s;
  if (lib_default76(y)) {
    return x;
  }
  return y;
}
var main_default260 = floorb;

var lib_default325 = main_default260;

var FLOAT32_MAX_BASE10_EXPONENT = 38 | 0;
var lib_default326 = FLOAT32_MAX_BASE10_EXPONENT;

var FLOAT32_MIN_BASE10_EXPONENT = -37 | 0;
var lib_default327 = FLOAT32_MIN_BASE10_EXPONENT;

var FLOAT32_MIN_BASE10_EXPONENT_SUBNORMAL = -45 | 0;
var lib_default328 = FLOAT32_MIN_BASE10_EXPONENT_SUBNORMAL;

var MAX_INT3 = lib_default203 + 1;
var HUGE10 = lib_default3(1e38);
var ZERO19 = lib_default3(0);
function floornf(x, n) {
  var s;
  var y;
  x = lib_default3(x);
  if (lib_default6(x) || lib_default6(n) || lib_default9(n)) {
    return NaN;
  }
  if (lib_default9(x) || x === ZERO19 || n < lib_default328 || lib_default5(x) > MAX_INT3 && n <= 0) {
    return x;
  }
  if (n > lib_default326) {
    if (x >= ZERO19) {
      return ZERO19;
    }
    return lib_default8;
  }
  if (n < lib_default327) {
    s = lib_default320(lib_default3(10), -(n + lib_default326));
    y = lib_default3(lib_default3(x * HUGE10) * s);
    if (lib_default9(y)) {
      return x;
    }
    return lib_default3(lib_default3(lib_default16(y) / HUGE10) / s);
  }
  s = lib_default320(lib_default3(10), -n);
  y = lib_default3(x * s);
  if (lib_default9(y)) {
    return x;
  }
  return lib_default3(lib_default16(y) / s);
}
var main_default261 = floornf;

var lib_default329 = main_default261;

function floorsd(x, n, b) {
  var exp3;
  var s;
  var y;
  if (lib_default30(x) || lib_default30(n) || n < 1 || lib_default76(n) || lib_default30(b) || b <= 0 || lib_default76(b)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0) {
    return x;
  }
  if (b === 10) {
    exp3 = lib_default214(lib_default(x));
  } else if (b === 2) {
    exp3 = lib_default122(lib_default(x));
  } else {
    exp3 = lib_default48(lib_default(x)) / lib_default48(b);
  }
  exp3 = lib_default105(exp3 - n + 1);
  s = lib_default142(b, lib_default(exp3));
  if (lib_default76(s)) {
    return x;
  }
  if (exp3 < 0) {
    y = lib_default105(x * s) / s;
  } else {
    y = lib_default105(x / s) * s;
  }
  if (lib_default76(y)) {
    return x;
  }
  return y;
}
var main_default262 = floorsd;

var lib_default330 = main_default262;

function evalrational55(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.5235987755982989;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 3180162978765678e-4 + x * (-4429795180596978e-5 + x * (25489088057337637e-7 + x * (-6297414862058625e-8 + x * (708840.0452577386 + x * (-2991.8191940101983 + x * 0)))));
    s2 = 6073663894900846e-4 + x * (22441179564534092e-6 + x * (4193202458981112e-7 + x * (5173438887700964e-9 + x * (45584.78108065326 + x * (281.3762688899943 + x * 1)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (-2991.8191940101983 + x * (708840.0452577386 + x * (-6297414862058625e-8 + x * (25489088057337637e-7 + x * (-4429795180596978e-5 + x * 3180162978765678e-4)))));
    s2 = 1 + x * (281.3762688899943 + x * (45584.78108065326 + x * (5173438887700964e-9 + x * (4193202458981112e-7 + x * (22441179564534092e-6 + x * 6073663894900846e-4)))));
  }
  return s1 / s2;
}
var rational_psqs_default5 = evalrational55;

function evalrational56(x) {
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
    s1 = 1 + x * (-0.20552590095501388 + x * (0.018884331939670384 + x * (-6451914356839651e-19 + x * (9504280628298596e-21 + x * (-49884311457357354e-24 + x * 0)))));
    s2 = 1 + x * (0.04121420907221998 + x * (8680295429417843e-19 + x * (12226278902417902e-21 + x * (12500186247959882e-23 + x * (9154392157746574e-25 + x * 399982968972496e-26)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (-49884311457357354e-24 + x * (9504280628298596e-21 + x * (-6451914356839651e-19 + x * (0.018884331939670384 + x * (-0.20552590095501388 + x * 1)))));
    s2 = 399982968972496e-26 + x * (9154392157746574e-25 + x * (12500186247959882e-23 + x * (12226278902417902e-21 + x * (8680295429417843e-19 + x * (0.04121420907221998 + x * 1)))));
  }
  return s1 / s2;
}
var rational_pcqc_default5 = evalrational56;

function evalrational57(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 2.999999999999634;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 3763297112699879e-35 + x * (13428327623306275e-32 + x * (17201074326816183e-29 + x * (10230451416490724e-26 + x * (3055689837902576e-23 + x * (46361374928786735e-22 + x * (345017939782574e-18 + x * (0.011522095507358577 + x * (0.1434079197807589 + x * (0.4215435550436775 + x * 0)))))))));
    s2 = 12544323709001127e-36 + x * (45200143407412973e-33 + x * (5887545336215784e-29 + x * (36014002958937136e-27 + x * (11269922476399903e-24 + x * (18462756734893055e-22 + x * (15593440916415301e-20 + x * (0.0064405152650885865 + x * (0.11688892585919138 + x * (0.7515863983533789 + x * 1)))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0.4215435550436775 + x * (0.1434079197807589 + x * (0.011522095507358577 + x * (345017939782574e-18 + x * (46361374928786735e-22 + x * (3055689837902576e-23 + x * (10230451416490724e-26 + x * (17201074326816183e-29 + x * (13428327623306275e-32 + x * 3763297112699879e-35)))))))));
    s2 = 1 + x * (0.7515863983533789 + x * (0.11688892585919138 + x * (0.0064405152650885865 + x * (15593440916415301e-20 + x * (18462756734893055e-22 + x * (11269922476399903e-24 + x * (36014002958937136e-27 + x * (5887545336215784e-29 + x * (45200143407412973e-33 + x * 12544323709001127e-36)))))))));
  }
  return s1 / s2;
}
var rational_pfqf_default = evalrational57;

function evalrational58(x) {
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
    s1 = 18695871016278324e-38 + x * (8363544356306774e-34 + x * (1375554606332618e-30 + x * (10826804113902088e-28 + x * (44534441586175015e-26 + x * (9828524436884223e-23 + x * (11513882611188428e-21 + x * (6840793809153931e-19 + x * (0.018764858409257526 + x * (0.1971028335255234 + x * (0.5044420736433832 + x * 0))))))))));
    s2 = 18695871016278324e-38 + x * (8391588162831187e-34 + x * (13879653125957886e-31 + x * (11027321506624028e-28 + x * (46068072814652043e-26 + x * (10431458965757199e-23 + x * (12754507566772912e-21 + x * (8146791071843061e-19 + x * (0.02536037414203388 + x * (0.33774898912002 + x * (1.4749575992512833 + x * 1))))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0.5044420736433832 + x * (0.1971028335255234 + x * (0.018764858409257526 + x * (6840793809153931e-19 + x * (11513882611188428e-21 + x * (9828524436884223e-23 + x * (44534441586175015e-26 + x * (10826804113902088e-28 + x * (1375554606332618e-30 + x * (8363544356306774e-34 + x * 18695871016278324e-38))))))))));
    s2 = 1 + x * (1.4749575992512833 + x * (0.33774898912002 + x * (0.02536037414203388 + x * (8146791071843061e-19 + x * (12754507566772912e-21 + x * (10431458965757199e-23 + x * (46068072814652043e-26 + x * (11027321506624028e-28 + x * (13879653125957886e-31 + x * (8391588162831187e-34 + x * 18695871016278324e-38))))))))));
  }
  return s1 / s2;
}
var rational_pgqg_default = evalrational58;

var sincos8 = lib_default130.assign;
var sc5 = [0, 0];
function fresnel(x, out, stride, offset) {
  var x26;
  var xa;
  var f;
  var g;
  var t;
  var u;
  xa = lib_default(x);
  x26 = xa * xa;
  if (x26 < 2.5625) {
    t = x26 * x26;
    out[offset] = xa * x26 * rational_psqs_default5(t);
    out[offset + stride] = xa * rational_pcqc_default5(t);
  } else if (xa > 36974) {
    out[offset + stride] = 0.5;
    out[offset] = 0.5;
  } else {
    x26 = xa * xa;
    t = lib_default26 * x26;
    u = 1 / (t * t);
    t = 1 / t;
    f = 1 - u * rational_pfqf_default(u);
    g = t * rational_pgqg_default(u);
    t = lib_default54 * x26;
    sincos8(t, sc5, 1, 0);
    t = lib_default26 * xa;
    out[offset + stride] = 0.5 + (f * sc5[0] - g * sc5[1]) / t;
    out[offset] = 0.5 - (f * sc5[1] + g * sc5[0]) / t;
  }
  if (x < 0) {
    out[offset + stride] = -out[offset + stride];
    out[offset] = -out[offset];
  }
  return out;
}
var assign_default6 = fresnel;

function fresnel2(x) {
  return assign_default6(x, [0, 0], 1, 0);
}
var main_default263 = fresnel2;

main_default263.assign = assign_default6;
var lib_default331 = main_default263;

function evalrational59(x) {
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
    s1 = 1 + x * (-0.20552590095501388 + x * (0.018884331939670384 + x * (-6451914356839651e-19 + x * (9504280628298596e-21 + x * (-49884311457357354e-24 + x * 0)))));
    s2 = 1 + x * (0.04121420907221998 + x * (8680295429417843e-19 + x * (12226278902417902e-21 + x * (12500186247959882e-23 + x * (9154392157746574e-25 + x * 399982968972496e-26)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (-49884311457357354e-24 + x * (9504280628298596e-21 + x * (-6451914356839651e-19 + x * (0.018884331939670384 + x * (-0.20552590095501388 + x * 1)))));
    s2 = 399982968972496e-26 + x * (9154392157746574e-25 + x * (12500186247959882e-23 + x * (12226278902417902e-21 + x * (8680295429417843e-19 + x * (0.04121420907221998 + x * 1)))));
  }
  return s1 / s2;
}
var rational_pcqc_default6 = evalrational59;

function evalrational60(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 2.999999999999634;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 3763297112699879e-35 + x * (13428327623306275e-32 + x * (17201074326816183e-29 + x * (10230451416490724e-26 + x * (3055689837902576e-23 + x * (46361374928786735e-22 + x * (345017939782574e-18 + x * (0.011522095507358577 + x * (0.1434079197807589 + x * (0.4215435550436775 + x * 0)))))))));
    s2 = 12544323709001127e-36 + x * (45200143407412973e-33 + x * (5887545336215784e-29 + x * (36014002958937136e-27 + x * (11269922476399903e-24 + x * (18462756734893055e-22 + x * (15593440916415301e-20 + x * (0.0064405152650885865 + x * (0.11688892585919138 + x * (0.7515863983533789 + x * 1)))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0.4215435550436775 + x * (0.1434079197807589 + x * (0.011522095507358577 + x * (345017939782574e-18 + x * (46361374928786735e-22 + x * (3055689837902576e-23 + x * (10230451416490724e-26 + x * (17201074326816183e-29 + x * (13428327623306275e-32 + x * 3763297112699879e-35)))))))));
    s2 = 1 + x * (0.7515863983533789 + x * (0.11688892585919138 + x * (0.0064405152650885865 + x * (15593440916415301e-20 + x * (18462756734893055e-22 + x * (11269922476399903e-24 + x * (36014002958937136e-27 + x * (5887545336215784e-29 + x * (45200143407412973e-33 + x * 12544323709001127e-36)))))))));
  }
  return s1 / s2;
}
var rational_pfqf_default2 = evalrational60;

function evalrational61(x) {
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
    s1 = 18695871016278324e-38 + x * (8363544356306774e-34 + x * (1375554606332618e-30 + x * (10826804113902088e-28 + x * (44534441586175015e-26 + x * (9828524436884223e-23 + x * (11513882611188428e-21 + x * (6840793809153931e-19 + x * (0.018764858409257526 + x * (0.1971028335255234 + x * (0.5044420736433832 + x * 0))))))))));
    s2 = 18695871016278324e-38 + x * (8391588162831187e-34 + x * (13879653125957886e-31 + x * (11027321506624028e-28 + x * (46068072814652043e-26 + x * (10431458965757199e-23 + x * (12754507566772912e-21 + x * (8146791071843061e-19 + x * (0.02536037414203388 + x * (0.33774898912002 + x * (1.4749575992512833 + x * 1))))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0.5044420736433832 + x * (0.1971028335255234 + x * (0.018764858409257526 + x * (6840793809153931e-19 + x * (11513882611188428e-21 + x * (9828524436884223e-23 + x * (44534441586175015e-26 + x * (10826804113902088e-28 + x * (1375554606332618e-30 + x * (8363544356306774e-34 + x * 18695871016278324e-38))))))))));
    s2 = 1 + x * (1.4749575992512833 + x * (0.33774898912002 + x * (0.02536037414203388 + x * (8146791071843061e-19 + x * (12754507566772912e-21 + x * (10431458965757199e-23 + x * (46068072814652043e-26 + x * (11027321506624028e-28 + x * (13879653125957886e-31 + x * (8391588162831187e-34 + x * 18695871016278324e-38))))))))));
  }
  return s1 / s2;
}
var rational_pgqg_default2 = evalrational61;

var sincos9 = lib_default130.assign;
var sc6 = [0, 0];
function fresnelc(x) {
  var x26;
  var xa;
  var C7;
  var f;
  var g;
  var t;
  var u;
  xa = lib_default(x);
  x26 = xa * xa;
  if (x26 < 2.5625) {
    t = x26 * x26;
    C7 = xa * rational_pcqc_default6(t);
  } else if (xa > 36974) {
    C7 = 0.5;
  } else {
    x26 = xa * xa;
    t = lib_default26 * x26;
    u = 1 / (t * t);
    t = 1 / t;
    f = 1 - u * rational_pfqf_default2(u);
    g = t * rational_pgqg_default2(u);
    t = lib_default54 * x26;
    sincos9(t, sc6, 1, 0);
    t = lib_default26 * xa;
    C7 = 0.5 + (f * sc6[0] - g * sc6[1]) / t;
  }
  if (x < 0) {
    C7 = -C7;
  }
  return C7;
}
var main_default264 = fresnelc;

var lib_default332 = main_default264;

function evalrational62(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0.5235987755982989;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 3180162978765678e-4 + x * (-4429795180596978e-5 + x * (25489088057337637e-7 + x * (-6297414862058625e-8 + x * (708840.0452577386 + x * (-2991.8191940101983 + x * 0)))));
    s2 = 6073663894900846e-4 + x * (22441179564534092e-6 + x * (4193202458981112e-7 + x * (5173438887700964e-9 + x * (45584.78108065326 + x * (281.3762688899943 + x * 1)))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (-2991.8191940101983 + x * (708840.0452577386 + x * (-6297414862058625e-8 + x * (25489088057337637e-7 + x * (-4429795180596978e-5 + x * 3180162978765678e-4)))));
    s2 = 1 + x * (281.3762688899943 + x * (45584.78108065326 + x * (5173438887700964e-9 + x * (4193202458981112e-7 + x * (22441179564534092e-6 + x * 6073663894900846e-4)))));
  }
  return s1 / s2;
}
var rational_psqs_default6 = evalrational62;

function evalrational63(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 2.999999999999634;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 3763297112699879e-35 + x * (13428327623306275e-32 + x * (17201074326816183e-29 + x * (10230451416490724e-26 + x * (3055689837902576e-23 + x * (46361374928786735e-22 + x * (345017939782574e-18 + x * (0.011522095507358577 + x * (0.1434079197807589 + x * (0.4215435550436775 + x * 0)))))))));
    s2 = 12544323709001127e-36 + x * (45200143407412973e-33 + x * (5887545336215784e-29 + x * (36014002958937136e-27 + x * (11269922476399903e-24 + x * (18462756734893055e-22 + x * (15593440916415301e-20 + x * (0.0064405152650885865 + x * (0.11688892585919138 + x * (0.7515863983533789 + x * 1)))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0.4215435550436775 + x * (0.1434079197807589 + x * (0.011522095507358577 + x * (345017939782574e-18 + x * (46361374928786735e-22 + x * (3055689837902576e-23 + x * (10230451416490724e-26 + x * (17201074326816183e-29 + x * (13428327623306275e-32 + x * 3763297112699879e-35)))))))));
    s2 = 1 + x * (0.7515863983533789 + x * (0.11688892585919138 + x * (0.0064405152650885865 + x * (15593440916415301e-20 + x * (18462756734893055e-22 + x * (11269922476399903e-24 + x * (36014002958937136e-27 + x * (5887545336215784e-29 + x * (45200143407412973e-33 + x * 12544323709001127e-36)))))))));
  }
  return s1 / s2;
}
var rational_pfqf_default3 = evalrational63;

function evalrational64(x) {
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
    s1 = 18695871016278324e-38 + x * (8363544356306774e-34 + x * (1375554606332618e-30 + x * (10826804113902088e-28 + x * (44534441586175015e-26 + x * (9828524436884223e-23 + x * (11513882611188428e-21 + x * (6840793809153931e-19 + x * (0.018764858409257526 + x * (0.1971028335255234 + x * (0.5044420736433832 + x * 0))))))))));
    s2 = 18695871016278324e-38 + x * (8391588162831187e-34 + x * (13879653125957886e-31 + x * (11027321506624028e-28 + x * (46068072814652043e-26 + x * (10431458965757199e-23 + x * (12754507566772912e-21 + x * (8146791071843061e-19 + x * (0.02536037414203388 + x * (0.33774898912002 + x * (1.4749575992512833 + x * 1))))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0.5044420736433832 + x * (0.1971028335255234 + x * (0.018764858409257526 + x * (6840793809153931e-19 + x * (11513882611188428e-21 + x * (9828524436884223e-23 + x * (44534441586175015e-26 + x * (10826804113902088e-28 + x * (1375554606332618e-30 + x * (8363544356306774e-34 + x * 18695871016278324e-38))))))))));
    s2 = 1 + x * (1.4749575992512833 + x * (0.33774898912002 + x * (0.02536037414203388 + x * (8146791071843061e-19 + x * (12754507566772912e-21 + x * (10431458965757199e-23 + x * (46068072814652043e-26 + x * (11027321506624028e-28 + x * (13879653125957886e-31 + x * (8391588162831187e-34 + x * 18695871016278324e-38))))))))));
  }
  return s1 / s2;
}
var rational_pgqg_default3 = evalrational64;

var sincos10 = lib_default130.assign;
var sc7 = [0, 0];
function fresnels(x) {
  var x26;
  var xa;
  var S;
  var f;
  var g;
  var t;
  var u;
  xa = lib_default(x);
  x26 = xa * xa;
  if (x26 < 2.5625) {
    t = x26 * x26;
    S = xa * x26 * rational_psqs_default6(t);
  } else if (xa > 36974) {
    S = 0.5;
  } else {
    x26 = xa * xa;
    t = lib_default26 * x26;
    u = 1 / (t * t);
    t = 1 / t;
    f = 1 - u * rational_pfqf_default3(u);
    g = t * rational_pgqg_default3(u);
    t = lib_default54 * x26;
    sincos10(t, sc7, 1, 0);
    t = lib_default26 * xa;
    S = 0.5 - (f * sc7[1] + g * sc7[0]) / t;
  }
  if (x < 0) {
    S = -S;
  }
  return S;
}
var main_default265 = fresnels;

var lib_default333 = main_default265;

var normalize4 = lib_default124.assign;
var CLEAR_EXP_MASK2 = 2148532223 >>> 0;
var SET_EXP_MASK = 1071644672 | 0;
var X = [0, 0];
var WORDS8 = [0, 0];
function frexp(x, out, stride, offset) {
  var high;
  var exp3;
  if (x === 0 || // handles -0
  lib_default30(x) || lib_default76(x)) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  normalize4(x, X, 1, 0);
  exp3 = lib_default122(X[0]) + X[1] + 1;
  lib_default93.assign(X[0], WORDS8, 1, 0);
  high = WORDS8[0];
  high &= CLEAR_EXP_MASK2;
  high |= SET_EXP_MASK;
  x = lib_default94(high, WORDS8[1]);
  out[offset] = x;
  out[offset + stride] = exp3;
  return out;
}
var assign_default7 = frexp;

function frexp2(x) {
  return assign_default7(x, [0, 0], 1, 0);
}
var main_default266 = frexp2;

main_default266.assign = assign_default7;
var lib_default334 = main_default266;

var EXP_MASK = 2139095040;
function exponentf(x) {
  var w = lib_default10(x);
  w = (w & EXP_MASK) >>> 23;
  return w - lib_default13;
}
var main_default267 = exponentf;

var lib_default335 = main_default267;

var SCALAR2 = 8388608;
function normalizef(x, out, stride, offset) {
  if (x !== x || x === lib_default7 || x === lib_default8) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  if (x !== 0 && lib_default5(x) < lib_default180) {
    x = lib_default3(x * SCALAR2);
    out[offset] = x;
    out[offset + stride] = -23;
    return out;
  }
  out[offset] = x;
  out[offset + stride] = 0;
  return out;
}
var assign_default8 = normalizef;

function normalizef2(x) {
  return assign_default8(x, [0, 0], 1, 0);
}
var main_default268 = normalizef2;

main_default268.assign = assign_default8;
var lib_default336 = main_default268;

var normalize5 = lib_default336.assign;
var CLEAR_EXP_MASK3 = 2155872255 >>> 0;
var SET_EXP_MASK2 = 1056964608 | 0;
var X2 = [0, 0];
function frexpf(x, out, stride, offset) {
  var word;
  var exp3;
  x = lib_default3(x);
  if (x === 0 || // handles -0
  lib_default6(x) || lib_default9(x)) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  normalize5(x, X2, 1, 0);
  exp3 = lib_default335(X2[0]) + X2[1] + 1;
  word = lib_default10(X2[0]);
  word &= CLEAR_EXP_MASK3;
  word |= SET_EXP_MASK2;
  x = lib_default11(word);
  out[offset] = x;
  out[offset + stride] = exp3;
  return out;
}
var assign_default9 = frexpf;

function frexpf2(x) {
  return assign_default9(x, [0, 0], 1, 0);
}
var main_default269 = frexpf2;

main_default269.assign = assign_default9;
var lib_default337 = main_default269;

function evalrational65(x) {
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
    s1 = lib_default3(14.026143074035645 + lib_default3(x * lib_default3(43.7473258972168 + lib_default3(x * lib_default3(50.59547424316406 + lib_default3(x * lib_default3(26.90456771850586 + lib_default3(x * lib_default3(6.595765590667725 + lib_default3(x * 0.6007853746414185))))))))));
    s2 = lib_default3(0 + lib_default3(x * lib_default3(24 + lib_default3(x * lib_default3(50 + lib_default3(x * lib_default3(35 + lib_default3(x * lib_default3(10 + lib_default3(x * 1))))))))));
  } else {
    x = lib_default3(1 / x);
    s1 = lib_default3(0.6007853746414185 + lib_default3(x * lib_default3(6.595765590667725 + lib_default3(x * lib_default3(26.90456771850586 + lib_default3(x * lib_default3(50.59547424316406 + lib_default3(x * lib_default3(43.7473258972168 + lib_default3(x * 14.026143074035645))))))))));
    s2 = lib_default3(1 + lib_default3(x * lib_default3(10 + lib_default3(x * lib_default3(35 + lib_default3(x * lib_default3(50 + lib_default3(x * lib_default3(24 + lib_default3(x * 0))))))))));
  }
  return lib_default3(s1 / s2);
}
var rational_pq_default8 = evalrational65;

function gammaLanczosSumExpGScaledf(x) {
  return rational_pq_default8(lib_default3(x));
}
var main_default270 = gammaLanczosSumExpGScaledf;

var lib_default338 = main_default270;

function gammasgn(x) {
  var fx;
  if (lib_default30(x)) {
    return x;
  }
  if (x > 0) {
    return 1;
  }
  fx = lib_default105(x);
  if (x === fx) {
    return 0;
  }
  fx /= 2;
  if (fx === lib_default105(fx)) {
    return 1;
  }
  return -1;
}
var main_default271 = gammasgn;

var lib_default339 = main_default271;

function gammasgnf(x) {
  var fx;
  if (lib_default6(x)) {
    return NaN;
  }
  if (x > 0) {
    return 1;
  }
  fx = lib_default16(x);
  if (x === fx) {
    return 0;
  }
  fx = lib_default3(fx / 2);
  if (fx === lib_default16(fx)) {
    return 1;
  }
  return -1;
}
var main_default272 = gammasgnf;

var lib_default340 = main_default272;

function hacovercos(x) {
  return (1 + lib_default156(x)) / 2;
}
var main_default273 = hacovercos;

var lib_default341 = main_default273;

var ONE21 = lib_default3(1);
var TWO10 = lib_default3(2);
function hacovercosf(x) {
  return lib_default3(lib_default3(ONE21 + lib_default256(x)) / TWO10);
}
var main_default274 = hacovercosf;

var lib_default342 = main_default274;

function hacoversin(x) {
  return (1 - lib_default156(x)) / 2;
}
var main_default275 = hacoversin;

var lib_default343 = main_default275;

var ONE22 = lib_default3(1);
var TWO11 = lib_default3(2);
function hacoversinf(x) {
  return lib_default3(lib_default3(ONE22 - lib_default256(x)) / TWO11);
}
var main_default276 = hacoversinf;

var lib_default344 = main_default276;

function havercos(x) {
  return (1 + lib_default165(x)) / 2;
}
var main_default277 = havercos;

var lib_default345 = main_default277;

var ONE23 = lib_default3(1);
var TWO12 = lib_default3(2);
function havercosf(x) {
  return lib_default3(lib_default3(ONE23 + lib_default235(x)) / TWO12);
}
var main_default278 = havercosf;

var lib_default346 = main_default278;

function haversin(x) {
  return (1 - lib_default165(x)) / 2;
}
var main_default279 = haversin;

var lib_default347 = main_default279;

var ONE24 = lib_default3(1);
var TWO13 = lib_default3(2);
function haversinf(x) {
  return lib_default3(lib_default3(ONE24 - lib_default235(x)) / TWO13);
}
var main_default280 = haversinf;

var lib_default348 = main_default280;

function heaviside(x, continuity) {
  if (lib_default30(x)) {
    return NaN;
  }
  if (x > 0) {
    return 1;
  }
  if (x === 0) {
    if (continuity === "half-maximum") {
      return 0.5;
    }
    if (continuity === "left-continuous") {
      return 0;
    }
    if (continuity === "right-continuous") {
      return 1;
    }
    return NaN;
  }
  return 0;
}
var main_default281 = heaviside;

var lib_default349 = main_default281;

function heavisidef(x, continuity) {
  if (lib_default6(x)) {
    return NaN;
  }
  if (x > 0) {
    return 1;
  }
  if (x === 0) {
    if (continuity === "half-maximum") {
      return 0.5;
    }
    if (continuity === "left-continuous") {
      return 0;
    }
    if (continuity === "right-continuous") {
      return 1;
    }
    return NaN;
  }
  return 0;
}
var main_default282 = heavisidef;

var lib_default350 = main_default282;

function isNumber(value) {
  return typeof value === "number";
}
var primitive_default = isNumber;

var has_tostringtag_support_default = () => true;

var toStr = Object.prototype.toString;
var tostring_default = toStr;

function nativeClass(v3) {
  return tostring_default.call(v3);
}
var main_default283 = nativeClass;

var has = Object.prototype.hasOwnProperty;
function hasOwnProp(value, property) {
  if (value === void 0 || value === null) {
    return false;
  }
  return has.call(value, property);
}
var main_default284 = hasOwnProp;

var lib_default351 = main_default284;

var Sym = typeof Symbol === "function" ? Symbol : void 0;
var main_default285 = Sym;

var lib_default352 = main_default285;

var toStrTag = typeof lib_default352 === "function" ? lib_default352.toStringTag : "";
var tostringtag_default = toStrTag;

function nativeClass2(v3) {
  var isOwn;
  var tag;
  var out;
  if (v3 === null || v3 === void 0) {
    return tostring_default.call(v3);
  }
  tag = v3[tostringtag_default];
  isOwn = lib_default351(v3, tostringtag_default);
  try {
    v3[tostringtag_default] = void 0;
  } catch (err) {
    return tostring_default.call(v3);
  }
  out = tostring_default.call(v3);
  if (isOwn) {
    v3[tostringtag_default] = tag;
  } else {
    delete v3[tostringtag_default];
  }
  return out;
}
var polyfill_default2 = nativeClass2;

var main;
if (has_tostringtag_support_default()) {
  main = polyfill_default2;
} else {
  main = main_default283;
}
var lib_default353 = main;

var toString = Number.prototype.toString;
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
function isNumber2(value) {
  if (typeof value === "object") {
    if (value instanceof Number) {
      return true;
    }
    if (FLG) {
      return try2serialize_default(value);
    }
    return lib_default353(value) === "[object Number]";
  }
  return false;
}
var object_default = isNumber2;

function isNumber3(value) {
  return primitive_default(value) || object_default(value);
}
var main_default286 = isNumber3;

main_default286.isPrimitive = primitive_default;
main_default286.isObject = object_default;
var lib_default354 = main_default286;

var isNumber4 = lib_default354.isPrimitive;
function isnan2(value) {
  return isNumber4(value) && lib_default30(value);
}
var primitive_default2 = isnan2;

var isNumber5 = lib_default354.isObject;
function isnan3(value) {
  return isNumber5(value) && lib_default30(value.valueOf());
}
var object_default2 = isnan3;

function isnan4(value) {
  return primitive_default2(value) || object_default2(value);
}
var main_default287 = isnan4;

main_default287.isPrimitive = primitive_default2;
main_default287.isObject = object_default2;
var lib_default355 = main_default287;

var config_default = {
  "MACHEP": 11102230246251565e-32,
  "EPS": 1e-13,
  "ETHRESH": 1e-12,
  "MAX_ITERATIONS": 1e4
};

var EPS = config_default.EPS;
function isNonPositiveInteger(x) {
  var diff;
  var ix;
  ix = lib_default128(x);
  diff = lib_default(x - ix);
  return ix <= 0 && diff < EPS;
}
var isnonpositiveinteger_default = isNonPositiveInteger;

function hyp2f1NegCEqualBC(a, b, x) {
  var collectorMax;
  var collector;
  var sum;
  var k;
  collectorMax = 1;
  collector = 1;
  sum = 1;
  if (lib_default(b) >= 1e5) {
    return NaN;
  }
  for (k = 1; k <= -b; k++) {
    collector *= (a + k - 1) * x / k;
    collectorMax = lib_default149(lib_default(collector), collectorMax);
    sum += collector;
  }
  if (1e-16 * (1 + collectorMax / lib_default(sum)) > 1e-7) {
    return NaN;
  }
  return sum;
}
var hyp2f1negcequalbc_default = hyp2f1NegCEqualBC;

var EPS2 = config_default.EPS;
function isInteger2(x) {
  var diff;
  var ix;
  ix = lib_default128(x);
  diff = lib_default(x - ix);
  return diff < EPS2;
}
var isinteger_default = isInteger2;

var MACHEP = config_default.MACHEP;
var EPS3 = config_default.EPS;
var MAX_ITERATIONS2 = config_default.MAX_ITERATIONS;
function hyp2f1ra(a, b, c2, x, loss) {
  var f2Val;
  var f1Val;
  var f0Val;
  var err;
  var da;
  var f1;
  var f0;
  var t;
  var n;
  loss = 0;
  err = 0;
  if (c2 < 0 && a <= c2 || c2 >= 0 && a >= c2) {
    da = lib_default128(a - c2);
  } else {
    da = lib_default128(a);
  }
  t = a - da;
  if (lib_default(da) > MAX_ITERATIONS2) {
    loss = 1;
    return {
      "value": NaN,
      "error": loss
    };
  }
  if (da < 0) {
    f2Val = 0;
    f1 = hys2f1(t, b, c2, x, err);
    loss += f1.error;
    err = f1.error;
    f0 = hys2f1(t - 1, b, c2, x, err);
    loss += f0.error;
    t -= 1;
    f1Val = f1.value;
    f0Val = f0.value;
    for (n = 1; n < -da; n++) {
      f2Val = f1Val;
      f1Val = f0Val;
      f0Val = -((2 * t - c2 - t * x + b * x) * f1Val + t * (x - 1) * f2Val) / (c2 - t);
      t -= 1;
    }
  } else {
    f2Val = 0;
    f1 = hys2f1(t, b, c2, x, err);
    loss += f1.error;
    err = f1.error;
    f0 = hys2f1(t + 1, b, c2, x, err);
    loss += f0.error;
    t += 1;
    f1Val = f1.value;
    f0Val = f0.value;
    for (n = 1; n < da; n++) {
      f2Val = f1Val;
      f1Val = f0Val;
      f0Val = -((2 * t - c2 - t * x + b * x) * f1Val + (c2 - t) * f2Val) / (t * (x - 1));
      t += 1;
    }
  }
  return {
    "value": f0Val,
    "error": loss
  };
}
function hys2f1(a, b, c2, x, loss) {
  var intFlag;
  var umax;
  var f;
  var g;
  var h;
  var k;
  var m;
  var s;
  var u;
  var i;
  intFlag = 0;
  if (lib_default(b) > lib_default(a)) {
    f = b;
    b = a;
    a = f;
  }
  if (isnonpositiveinteger_default(b) && lib_default(b) < lib_default(a)) {
    f = b;
    b = a;
    a = f;
    intFlag = 1;
  }
  if ((lib_default(a) > lib_default(c2) + 1 || intFlag) && lib_default(c2 - a) > 2 && lib_default(a) > 2) {
    return hyp2f1ra(a, b, c2, x, loss);
  }
  i = 0;
  umax = 0;
  f = a;
  g = b;
  h = c2;
  s = 1;
  u = 1;
  k = 0;
  do {
    if (lib_default(h) < EPS3) {
      loss = 1;
      return {
        "value": lib_default43,
        "error": loss
      };
    }
    m = k + 1;
    u *= (f + k) * (g + k) * x / ((h + k) * m);
    s += u;
    k = lib_default(u);
    if (k > umax) {
      umax = k;
    }
    k = m;
    i += 1;
    if (i > MAX_ITERATIONS2) {
      loss = 1;
      return {
        "value": s,
        "error": loss
      };
    }
  } while (s === 0 || lib_default(u / s) > MACHEP);
  loss = MACHEP * umax / lib_default(s) + MACHEP * i;
  return {
    "value": s,
    "error": loss
  };
}
var hys2f1_default = hys2f1;

var MACHEP2 = config_default.MACHEP;
var EPS4 = config_default.EPS;
var ETHRESH = config_default.ETHRESH;
var MAX_ITERATIONS3 = config_default.MAX_ITERATIONS;
function hyt2f1(a, b, c2, x, loss) {
  var negIntA;
  var negIntB;
  var qVal;
  var rVal;
  var sign;
  var err1;
  var err;
  var val;
  var aid;
  var ax;
  var id;
  var d1;
  var d2;
  var y12;
  var i;
  var p101;
  var q;
  var r;
  var t;
  var y;
  var w;
  var d3;
  var e;
  var s;
  negIntA = isnonpositiveinteger_default(a);
  negIntB = isnonpositiveinteger_default(b);
  err = 0;
  err1 = 0;
  s = 1 - x;
  if (x < -0.5 && !(negIntA || negIntB)) {
    if (b > a) {
      y = hys2f1_default(a, c2 - b, c2, -x / s, err);
      val = lib_default142(s, -a) * y.value;
    } else {
      y = hys2f1_default(c2 - a, b, c2, -x / s, err);
      val = lib_default142(s, -b) * y.value;
    }
    loss = y.error;
    return {
      "value": val,
      "error": loss
    };
  }
  d3 = c2 - a - b;
  id = lib_default128(d3);
  if (x > 0.85 && !negIntA && !negIntB) {
    if (isinteger_default(d3) === false) {
      y = hys2f1_default(a, b, c2, x, err);
      if (y.error < ETHRESH) {
        return y;
      }
      err = y.error;
      q = hys2f1_default(a, b, 1 - d3, s, err);
      qVal = q.value;
      err = q.error;
      sign = 1;
      w = lib_default167(d3);
      sign *= lib_default339(d3);
      w -= lib_default167(c2 - a);
      sign *= lib_default339(c2 - a);
      w -= lib_default167(c2 - b);
      sign *= lib_default339(c2 - b);
      qVal *= sign * lib_default138(w);
      r = hys2f1_default(c2 - a, c2 - b, d3 + 1, s, err1);
      err1 = r.error;
      rVal = lib_default142(s, d3) * r.value;
      sign = 1;
      w = lib_default167(-d3);
      sign *= lib_default339(-d3);
      w -= lib_default167(a);
      sign *= lib_default339(a);
      w -= lib_default167(b);
      sign *= lib_default339(b);
      rVal *= sign * lib_default138(w);
      y = qVal + rVal;
      err += err1 + MACHEP2 * lib_default149(lib_default(qVal), lib_default(rVal)) / y;
      y *= lib_default159(c2);
    } else {
      if (id >= 0) {
        e = d3;
        d1 = d3;
        d2 = 0;
        aid = id;
      } else {
        e = -d3;
        d1 = 0;
        d2 = d3;
        aid = -id;
      }
      ax = lib_default48(s);
      y = lib_default266(1) + lib_default266(1 + e) - lib_default266(a + d1) - lib_default266(b + d1) - ax;
      y /= lib_default159(e + 1);
      p101 = (a + d1) * (b + d1) * s / lib_default159(e + 2);
      t = 1;
      do {
        r = lib_default266(1 + t) + lib_default266(1 + t + e) - lib_default266(a + t + d1) - lib_default266(b + t + d1) - ax;
        q = p101 * r;
        y += q;
        p101 *= s * (a + t + d1) / (t + 1);
        p101 *= (b + t + d1) / (t + 1 + e);
        t += 1;
        if (t > MAX_ITERATIONS3) {
          loss = 1;
          return {
            "value": NaN,
            "error": loss
          };
        }
      } while (y === 0 || lib_default(q / y) > EPS4);
      if (id === 0) {
        y *= lib_default159(c2) / (lib_default159(a) * lib_default159(b));
        return {
          "value": y,
          "error": err
        };
      }
      y12 = 1;
      if (aid !== 1) {
        t = 0;
        p101 = 1;
        for (i = 1; i < aid; i++) {
          r = 1 - e + t;
          p101 *= s * (a + t + d2) * (b + t + d2) / r;
          t += 1;
          p101 /= t;
          y12 += p101;
        }
      }
      p101 = lib_default159(c2);
      y12 *= lib_default159(e) * p101 / (lib_default159(a + d1) * lib_default159(b + d1));
      y *= p101 / (lib_default159(a + d2) * lib_default159(b + d2));
      if (aid % 2 !== 0) {
        y = -y;
      }
      q = lib_default142(s, id);
      if (id > 0) {
        y *= q;
      } else {
        y12 *= q;
      }
      y += y12;
    }
    return {
      "value": y,
      "error": err
    };
  }
  y = hys2f1_default(a, b, c2, x, err);
  return y;
}
var hyt2f1_default = hyt2f1;

var ETHRESH2 = config_default.ETHRESH;
function hyp2f1(a, b, c2, x) {
  var negIntCaOrCb;
  var negIntC;
  var negIntB;
  var negIntA;
  var isIntD;
  var aid;
  var err;
  var ax;
  var d2;
  var d1;
  var id;
  var ic;
  var ia;
  var ib;
  var t1;
  var y12;
  var y2;
  var q;
  var r;
  var p101;
  var e;
  var s;
  var d3;
  var y;
  var i;
  err = 0;
  s = 1 - x;
  d3 = c2 - a - b;
  ax = lib_default(x);
  ia = lib_default128(a);
  ib = lib_default128(b);
  id = lib_default128(d3);
  ic = lib_default128(c2);
  negIntA = isnonpositiveinteger_default(a);
  negIntB = isnonpositiveinteger_default(b);
  negIntC = isnonpositiveinteger_default(c2);
  isIntD = isinteger_default(d3);
  t1 = lib_default(b - a);
  if (lib_default355(a) || lib_default355(b) || lib_default355(c2) || lib_default355(x)) {
    return NaN;
  }
  if (x === 0) {
    return 1;
  }
  if ((a === 0 || b === 0) && c2 !== 0) {
    return 1;
  }
  if (d3 <= -1 && !(!isIntD && s < 0) && !(negIntA || negIntB)) {
    return lib_default142(s, d3) * hyp2f1(c2 - a, c2 - b, c2, x);
  }
  if (d3 <= 0 && x === 1 && !(negIntA || negIntB)) {
    return lib_default43;
  }
  if (ax < 1 || x === -1) {
    if (b === c2) {
      if (negIntB) {
        return hyp2f1negcequalbc_default(a, b, x);
      }
      return lib_default142(s, -a);
    }
    if (a === c2) {
      return lib_default142(s, -b);
    }
  }
  if (negIntC) {
    if (negIntA && ia > ic) {
      y = hyt2f1_default(a, b, c2, x, err);
      return y.value;
    }
    if (negIntB && ib > ic) {
      y = hyt2f1_default(a, b, c2, x, err);
      return y.value;
    }
    return lib_default43;
  }
  if (negIntA || negIntB) {
    y = hyt2f1_default(a, b, c2, x, err);
    return y.value;
  }
  if (x < -2 && !isinteger_default(t1)) {
    p101 = hyp2f1(a, 1 - c2 + a, 1 - b + a, 1 / x);
    q = hyp2f1(b, 1 - c2 + b, 1 - a + b, 1 / x);
    p101 *= lib_default142(-x, -a);
    q *= lib_default142(-x, -b);
    t1 = lib_default159(c2);
    s = t1 * lib_default159(b - a) / (lib_default159(b) * lib_default159(c2 - a));
    y = t1 * lib_default159(a - b) / (lib_default159(a) * lib_default159(c2 - b));
    return s * p101 + y * q;
  }
  if (x < -1) {
    if (lib_default(a) < lib_default(b)) {
      return lib_default142(s, -a) * hyp2f1(a, c2 - b, c2, x / (x - 1));
    }
    return lib_default142(s, -b) * hyp2f1(b, c2 - a, c2, x / (x - 1));
  }
  if (ax > 1) {
    return lib_default43;
  }
  p101 = c2 - a;
  r = c2 - b;
  negIntCaOrCb = isnonpositiveinteger_default(p101) || isnonpositiveinteger_default(r);
  if (ax === 1) {
    if (x > 0) {
      if (negIntCaOrCb) {
        if (d3 >= 0) {
          y = hys2f1_default(c2 - a, c2 - b, c2, x, err);
          return lib_default142(s, d3) * y.value;
        }
        return lib_default43;
      }
      if (d3 <= 0) {
        return lib_default43;
      }
      return lib_default159(c2) * lib_default159(d3) / (lib_default159(p101) * lib_default159(r));
    }
    if (d3 <= -1) {
      return lib_default43;
    }
  }
  if (d3 < 0) {
    y = hyt2f1_default(a, b, c2, x, err);
    if (y.error < ETHRESH2) {
      return y.value;
    }
    y = y.value;
    err = 0;
    aid = 2 - id;
    e = c2 + aid;
    d2 = hyp2f1(a, b, e, x);
    d1 = hyp2f1(a, b, e + 1, x);
    q = a + b + 1;
    for (i = 0; i < aid; i++) {
      r = e - 1;
      y12 = (e - a) * (e - b) * x;
      y2 = r - (2 * e - q) * x;
      y2 *= e;
      y = (y2 * d2 + y12 * d1) / (e * r * s);
      e = r;
      d1 = d2;
      d2 = y;
    }
    return y;
  }
  if (negIntCaOrCb) {
    y = hys2f1_default(c2 - a, c2 - b, c2, x, err);
    return lib_default142(s, d3) * y.value;
  }
  y = hyt2f1_default(a, b, c2, x, err);
  return y.value;
}
var main_default288 = hyp2f1;

var lib_default356 = main_default288;

function hypot7(x, y) {
  var tmp7;
  if (lib_default76(x) || lib_default76(y)) {
    return lib_default43;
  }
  if (lib_default30(x) || lib_default30(y)) {
    return NaN;
  }
  if (x < 0) {
    x = -x;
  }
  if (y < 0) {
    y = -y;
  }
  if (x < y) {
    tmp7 = y;
    y = x;
    x = tmp7;
  }
  if (x === 0) {
    return 0;
  }
  y /= x;
  return x * lib_default31(1 + y * y);
}
var main_default289 = hypot7;

var lib_default357 = main_default289;

function hypotf2(x, y) {
  var tmp7;
  if (lib_default9(x) || lib_default9(y)) {
    return lib_default7;
  }
  if (lib_default6(x) || lib_default6(y)) {
    return NaN;
  }
  x = lib_default3(x);
  y = lib_default3(y);
  if (x < 0) {
    x = -x;
  }
  if (y < 0) {
    y = -y;
  }
  if (x < y) {
    tmp7 = y;
    y = x;
    x = tmp7;
  }
  if (x === 0) {
    return 0;
  }
  y = lib_default3(y / x);
  return lib_default3(x * lib_default38(lib_default3(1 + lib_default3(y * y))));
}
var main_default290 = hypotf2;

var lib_default358 = main_default290;

function inv(x) {
  return 1 / x;
}
var main_default291 = inv;

var lib_default359 = main_default291;

function invf(x) {
  return lib_default3(1 / lib_default3(x));
}
var main_default292 = invf;

var lib_default360 = main_default292;

function evalpoly131(x) {
  if (x === 0) {
    return 0.40000972151756287;
  }
  return lib_default3(0.40000972151756287 + lib_default3(x * 0.24279078841209412));
}
var polyval_p_default13 = evalpoly131;

function evalpoly132(x) {
  if (x === 0) {
    return 0.6666666269302368;
  }
  return lib_default3(0.6666666269302368 + lib_default3(x * 0.2849878668785095));
}
var polyval_q_default8 = evalpoly132;

var HALF9 = lib_default3(0.5);
var TWO14 = lib_default3(2);
function kernelLog1pf(f) {
  var hfsq;
  var t1;
  var t2;
  var s;
  var z;
  var R;
  var w;
  f = lib_default3(f);
  s = lib_default3(f / lib_default3(TWO14 + f));
  z = lib_default3(s * s);
  w = lib_default3(z * z);
  t1 = lib_default3(w * polyval_p_default13(w));
  t2 = lib_default3(z * polyval_q_default8(w));
  R = lib_default3(t2 + t1);
  hfsq = lib_default3(HALF9 * lib_default3(f * f));
  return lib_default3(s * lib_default3(hfsq + R));
}
var main_default293 = kernelLog1pf;

var lib_default361 = main_default293;

function evalpoly133(x) {
  if (x === 0) {
    return -0.16666666641626524;
  }
  return -0.16666666641626524 + x * 0.008333329385889463;
}
var polyval_s12_default2 = evalpoly133;

function evalpoly134(x) {
  if (x === 0) {
    return -19839334836096632e-20;
  }
  return -19839334836096632e-20 + x * 2718311493989822e-21;
}
var polyval_s34_default2 = evalpoly134;

function evalpoly135(x) {
  if (x === 0) {
    return -0.001388676377460993;
  }
  return -0.001388676377460993 + x * 2439044879627741e-20;
}
var polyval_c23_default2 = evalpoly135;

var C02 = -0.499999997251031;
var C13 = 0.04166662332373906;
function kernelSincosf(x, out, stride, offset) {
  var r;
  var s;
  var w;
  var z;
  z = x * x;
  w = z * z;
  r = polyval_s34_default2(z);
  s = z * x;
  out[offset] = lib_default3(x + s * polyval_s12_default2(z) + s * w * r);
  r = polyval_c23_default2(z);
  out[offset + stride] = lib_default3(1 + z * C02 + w * C13 + w * z * r);
  return out;
}
var assign_default10 = kernelSincosf;

function kernelSincosf2(x) {
  return assign_default10(x, [0, 0], 1, 0);
}
var main_default294 = kernelSincosf2;

main_default294.assign = assign_default10;
var lib_default362 = main_default294;

function kroneckerDelta(i, j) {
  if (lib_default30(i) || lib_default30(j)) {
    return NaN;
  }
  if (i === j) {
    return 1;
  }
  return 0;
}
var main_default295 = kroneckerDelta;

var lib_default363 = main_default295;

function kroneckerDeltaf(i, j) {
  if (lib_default6(i) || lib_default6(j)) {
    return NaN;
  }
  if (i === j) {
    return 1;
  }
  return 0;
}
var main_default296 = kroneckerDeltaf;

var lib_default364 = main_default296;

function lcm(a, b) {
  var d2;
  if (a === 0 || b === 0) {
    return 0;
  }
  if (a < 0) {
    a = -a;
  }
  if (b < 0) {
    b = -b;
  }
  d2 = lib_default186(a, b);
  if (lib_default30(d2)) {
    return d2;
  }
  return a / d2 * b;
}
var main_default297 = lcm;

var lib_default365 = main_default297;

function lcmf(a, b) {
  var d2;
  if (a === 0 || b === 0) {
    return 0;
  }
  if (a < 0) {
    a = -a;
  }
  if (b < 0) {
    b = -b;
  }
  d2 = lib_default204(a, b);
  if (lib_default6(d2)) {
    return d2;
  }
  return a / d2 * b;
}
var main_default298 = lcmf;

var lib_default366 = main_default298;

function log(x, b) {
  return lib_default48(x) / lib_default48(b);
}
var main_default299 = log;

var lib_default367 = main_default299;

function log1mexp(x) {
  var ax;
  if (lib_default30(x)) {
    return NaN;
  }
  if (x === 0) {
    return lib_default44;
  }
  ax = lib_default(x);
  if (0 < ax && ax <= lib_default47) {
    return lib_default48(-lib_default147(-ax));
  }
  return lib_default46(-lib_default138(-ax));
}
var main_default300 = log1mexp;

var lib_default368 = main_default300;

function log1pexp(x) {
  if (lib_default30(x)) {
    return NaN;
  }
  if (x <= -37) {
    return lib_default138(x);
  }
  if (x <= 18) {
    return lib_default46(lib_default138(x));
  }
  if (x <= 33.3) {
    return x + lib_default138(-x);
  }
  return x;
}
var main_default301 = log1pexp;

var lib_default369 = main_default301;

function logaddexp(x, y) {
  var d2;
  if (lib_default30(x) || lib_default30(y)) {
    return NaN;
  }
  if (x === y) {
    return x + lib_default47;
  }
  d2 = x - y;
  if (d2 > 0) {
    return x + lib_default46(lib_default138(-d2));
  }
  return y + lib_default46(lib_default138(d2));
}
var main_default302 = logaddexp;

var lib_default370 = main_default302;

function logf(x, b) {
  return lib_default3(lib_default15(lib_default3(x)) / lib_default15(lib_default3(b)));
}
var main_default303 = logf;

var lib_default371 = main_default303;

function isProbability(x) {
  return x >= 0 && x <= 1;
}
var main_default304 = isProbability;

var lib_default372 = main_default304;

function logit(p101) {
  if (lib_default30(p101)) {
    return p101;
  }
  if (!lib_default372(p101)) {
    return NaN;
  }
  if (p101 === 0) {
    return lib_default44;
  }
  if (p101 === 1) {
    return lib_default43;
  }
  return lib_default48(p101 / (1 - p101));
}
var main_default305 = logit;

var lib_default373 = main_default305;

function isProbabilityf(x) {
  return x >= 0 && x <= 1;
}
var main_default306 = isProbabilityf;

var lib_default374 = main_default306;

function logitf(p101) {
  if (lib_default6(p101)) {
    return p101;
  }
  if (!lib_default374(p101)) {
    return NaN;
  }
  if (p101 === 0) {
    return lib_default8;
  }
  if (p101 === 1) {
    return lib_default7;
  }
  return lib_default15(lib_default3(p101 / lib_default3(1 - p101)));
}
var main_default307 = logitf;

var lib_default375 = main_default307;

var FLOAT64_MAX_SAFE_NTH_LUCAS = 76 | 0;
var lib_default376 = FLOAT64_MAX_SAFE_NTH_LUCAS;

var lucas_default = [2, 1, 3, 4, 7, 11, 18, 29, 47, 76, 123, 199, 322, 521, 843, 1364, 2207, 3571, 5778, 9349, 15127, 24476, 39603, 64079, 103682, 167761, 271443, 439204, 710647, 1149851, 1860498, 3010349, 4870847, 7881196, 12752043, 20633239, 33385282, 54018521, 87403803, 141422324, 228826127, 370248451, 599074578, 969323029, 1568397607, 2537720636, 4106118243, 6643838879, 10749957122, 17393796001, 28143753123, 45537549124, 73681302247, 119218851371, 192900153618, 312119004989, 505019158607, 817138163596, 1322157322203, 2139295485799, 3461452808002, 5600748293801, 9062201101803, 14662949395604, 23725150497407, 38388099893011, 62113250390418, 100501350283429, 162614600673847, 263115950957276, 425730551631123, 688846502588399, 1114577054219522, 1803423556807921, 2918000611027443, 4721424167835364, 7639424778862807];

function lucas(n) {
  if (lib_default30(n) || !lib_default106(n) || n > lib_default376) {
    return NaN;
  }
  return lucas_default[n];
}
var main_default308 = lucas;

var lib_default377 = main_default308;

var FLOAT32_MAX_SAFE_NTH_LUCAS = 34 | 0;
var lib_default378 = FLOAT32_MAX_SAFE_NTH_LUCAS;

var lucas_default2 = [2, 1, 3, 4, 7, 11, 18, 29, 47, 76, 123, 199, 322, 521, 843, 1364, 2207, 3571, 5778, 9349, 15127, 24476, 39603, 64079, 103682, 167761, 271443, 439204, 710647, 1149851, 1860498, 3010349, 4870847, 7881196, 12752043];

function lucasf(n) {
  if (lib_default6(n) || !lib_default111(n) || n > lib_default378) {
    return NaN;
  }
  return lucas_default2[n];
}
var main_default309 = lucasf;

var lib_default379 = main_default309;

function isPositiveZerof(x) {
  return x === 0 && 1 / x === lib_default7;
}
var main_default310 = isPositiveZerof;

var lib_default380 = main_default310;

function maxf2(x, y) {
  if (lib_default6(x) || lib_default6(y)) {
    return NaN;
  }
  if (x === lib_default7 || y === lib_default7) {
    return lib_default7;
  }
  if (x === y && x === 0) {
    if (lib_default380(x)) {
      return x;
    }
    return y;
  }
  if (x > y) {
    return x;
  }
  return y;
}
var main_default311 = maxf2;

var lib_default381 = main_default311;

function maxabsf(x, y) {
  return lib_default381(lib_default5(lib_default3(x)), lib_default5(lib_default3(y)));
}
var main_default312 = maxabsf;

var lib_default382 = main_default312;

function maxn(x, y) {
  var len;
  var m;
  var v3;
  var i;
  len = arguments.length;
  if (len === 2) {
    if (lib_default30(x) || lib_default30(y)) {
      return NaN;
    }
    if (x === lib_default43 || y === lib_default43) {
      return lib_default43;
    }
    if (x === y && x === 0) {
      if (lib_default148(x)) {
        return x;
      }
      return y;
    }
    if (x > y) {
      return x;
    }
    return y;
  }
  m = lib_default44;
  for (i = 0; i < len; i++) {
    v3 = arguments[i];
    if (lib_default30(v3) || v3 === lib_default43) {
      return v3;
    }
    if (v3 > m) {
      m = v3;
    } else if (v3 === m && v3 === 0 && lib_default148(v3)) {
      m = v3;
    }
  }
  return m;
}
var main_default313 = maxn;

var lib_default383 = main_default313;

function maxabsn(x, y) {
  var nargs;
  var args;
  var i;
  nargs = arguments.length;
  if (nargs === 0) {
    return lib_default43;
  }
  if (nargs === 2) {
    return lib_default383(lib_default(x), lib_default(y));
  }
  args = [];
  for (i = 0; i < nargs; i++) {
    args.push(lib_default(arguments[i]));
  }
  return lib_default383.apply(null, args);
}
var main_default314 = maxabsn;

var lib_default384 = main_default314;

function minf2(x, y) {
  if (lib_default6(x) || lib_default6(y)) {
    return NaN;
  }
  if (x === lib_default8 || y === lib_default8) {
    return lib_default8;
  }
  if (x === y && x === 0) {
    if (lib_default225(x)) {
      return x;
    }
    return y;
  }
  if (x < y) {
    return x;
  }
  return y;
}
var main_default315 = minf2;

var lib_default385 = main_default315;

function minabsf(x, y) {
  return lib_default385(lib_default5(lib_default3(x)), lib_default5(lib_default3(y)));
}
var main_default316 = minabsf;

var lib_default386 = main_default316;

function minn(x, y) {
  var len;
  var m;
  var v3;
  var i;
  len = arguments.length;
  if (len === 2) {
    if (lib_default30(x) || lib_default30(y)) {
      return NaN;
    }
    if (x === lib_default44 || y === lib_default44) {
      return lib_default44;
    }
    if (x === y && x === 0) {
      if (lib_default150(x)) {
        return x;
      }
      return y;
    }
    if (x < y) {
      return x;
    }
    return y;
  }
  m = lib_default43;
  for (i = 0; i < len; i++) {
    v3 = arguments[i];
    if (lib_default30(v3) || v3 === lib_default44) {
      return v3;
    }
    if (v3 < m) {
      m = v3;
    } else if (v3 === m && v3 === 0 && lib_default150(v3)) {
      m = v3;
    }
  }
  return m;
}
var main_default317 = minn;

var lib_default387 = main_default317;

function minabsn(x, y) {
  var nargs;
  var args;
  var i;
  nargs = arguments.length;
  if (nargs === 0) {
    return lib_default43;
  }
  if (nargs === 2) {
    return lib_default387(lib_default(x), lib_default(y));
  }
  args = [];
  for (i = 0; i < nargs; i++) {
    args.push(lib_default(arguments[i]));
  }
  return lib_default387.apply(null, args);
}
var main_default318 = minabsn;

var lib_default388 = main_default318;

function minmax(x, y, out, stride, offset) {
  if (lib_default30(x) || lib_default30(y)) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  if (x === y && x === 0) {
    if (lib_default150(x)) {
      out[offset] = x;
      out[offset + stride] = y;
      return out;
    }
    out[offset] = y;
    out[offset + stride] = x;
    return out;
  }
  if (x < y) {
    out[offset] = x;
    out[offset + stride] = y;
    return out;
  }
  out[offset] = y;
  out[offset + stride] = x;
  return out;
}
var assign_default11 = minmax;

function minmax2(x, y) {
  return assign_default11(x, y, [0, 0], 1, 0);
}
var main_default319 = minmax2;

main_default319.assign = assign_default11;
var lib_default389 = main_default319;

function minmaxabs(x, y, out, stride, offset) {
  var ax;
  var ay;
  if (lib_default30(x) || lib_default30(y)) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  ax = lib_default(x);
  ay = lib_default(y);
  if (ax < ay) {
    out[offset] = ax;
    out[offset + stride] = ay;
    return out;
  }
  out[offset] = ay;
  out[offset + stride] = ax;
  return out;
}
var assign_default12 = minmaxabs;

function minmaxabs2(x, y) {
  return assign_default12(x, y, [0, 0], 1, 0);
}
var main_default320 = minmaxabs2;

main_default320.assign = assign_default12;
var lib_default390 = main_default320;

function minmaxabsf(x, y, out, stride, offset) {
  var ax;
  var ay;
  if (lib_default6(x) || lib_default6(y)) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  ax = lib_default5(x);
  ay = lib_default5(y);
  if (ax < ay) {
    out[offset] = ax;
    out[offset + stride] = ay;
    return out;
  }
  out[offset] = ay;
  out[offset + stride] = ax;
  return out;
}
var assign_default13 = minmaxabsf;

function minmaxabsf2(x, y) {
  return assign_default13(x, y, [0, 0], 1, 0);
}
var main_default321 = minmaxabsf2;

main_default321.assign = assign_default13;
var lib_default391 = main_default321;

function minmaxf(x, y, out, stride, offset) {
  if (lib_default6(x) || lib_default6(y)) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  if (x === y && x === 0) {
    if (lib_default225(x)) {
      out[offset] = x;
      out[offset + stride] = y;
      return out;
    }
    out[offset] = y;
    out[offset + stride] = x;
    return out;
  }
  if (x < y) {
    out[offset] = x;
    out[offset + stride] = y;
    return out;
  }
  out[offset] = y;
  out[offset + stride] = x;
  return out;
}
var assign_default14 = minmaxf;

function minmaxf2(x, y) {
  return assign_default14(x, y, [0, 0], 1, 0);
}
var main_default322 = minmaxf2;

main_default322.assign = assign_default14;
var lib_default392 = main_default322;

var FLOAT64_HIGH_WORD_EXPONENT_MASK2 = lib_default116;
var FLOAT64_HIGH_WORD_SIGNIFICAND_MASK2 = lib_default117;
var FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS2 = lib_default141;
var ALL_ONES2 = 4294967295 >>> 0;
var WORDS9 = [0 | 0, 0 | 0];
function modf(x, out, stride, offset) {
  var high;
  var low;
  var exp3;
  var i;
  if (x < 1) {
    if (x < 0) {
      modf(-x, out, stride, offset);
      out[offset] *= -1;
      out[offset + stride] *= -1;
      return out;
    }
    if (x === 0) {
      out[offset] = x;
      out[offset + stride] = x;
      return out;
    }
    out[offset] = 0;
    out[offset + stride] = x;
    return out;
  }
  if (lib_default30(x)) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  if (x === lib_default43) {
    out[offset] = lib_default43;
    out[offset + stride] = 0;
    return out;
  }
  lib_default93.assign(x, WORDS9, 1, 0);
  high = WORDS9[0];
  low = WORDS9[1];
  exp3 = (high & FLOAT64_HIGH_WORD_EXPONENT_MASK2) >> FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS2 | 0;
  exp3 -= lib_default45 | 0;
  if (exp3 < FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS2) {
    i = FLOAT64_HIGH_WORD_SIGNIFICAND_MASK2 >> exp3 | 0;
    if ((high & i | low) === 0) {
      out[offset] = x;
      out[offset + stride] = 0;
      return out;
    }
    high &= ~i;
    i = lib_default94(high, 0);
    out[offset] = i;
    out[offset + stride] = x - i;
    return out;
  }
  if (exp3 > 51) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  i = ALL_ONES2 >>> exp3 - FLOAT64_NUM_HIGH_WORD_SIGNIFICAND_BITS2;
  if ((low & i) === 0) {
    out[offset] = x;
    out[offset + stride] = 0;
    return out;
  }
  low &= ~i;
  i = lib_default94(high, low);
  out[offset] = i;
  out[offset + stride] = x - i;
  return out;
}
var assign_default15 = modf;

function modf2(x) {
  return assign_default15(x, [0, 0], 1, 0);
}
var main_default323 = modf2;

main_default323.assign = assign_default15;
var lib_default393 = main_default323;

var FLOAT32_NUM_SIGNIFICAND_BITS2 = lib_default25;
var FLOAT32_HIGH_WORD_EXPONENT_MASK = lib_default12;
var FLOAT32_HIGH_WORD_SIGNIFICAND_MASK = lib_default14;
var ZERO20 = lib_default3(0);
var NEG_ONE6 = lib_default3(-1);
function modff(x, out, stride, offset) {
  var word;
  var exp3;
  var i;
  x = lib_default3(x);
  if (x < 1) {
    if (x < 0) {
      modff(-x, out, stride, offset);
      out[offset] = lib_default3(out[offset] * NEG_ONE6);
      out[offset + stride] = lib_default3(out[offset + stride] * NEG_ONE6);
      return out;
    }
    if (x === 0) {
      out[offset] = x;
      out[offset + stride] = x;
      return out;
    }
    out[offset] = ZERO20;
    out[offset + stride] = x;
    return out;
  }
  if (lib_default6(x)) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  if (x === lib_default7) {
    out[offset] = lib_default7;
    out[offset + stride] = ZERO20;
    return out;
  }
  word = lib_default10(x);
  exp3 = (word & FLOAT32_HIGH_WORD_EXPONENT_MASK) >> FLOAT32_NUM_SIGNIFICAND_BITS2 | 0;
  exp3 -= lib_default13 | 0;
  if (exp3 < FLOAT32_NUM_SIGNIFICAND_BITS2) {
    i = FLOAT32_HIGH_WORD_SIGNIFICAND_MASK >> exp3 | 0;
    if ((word & i) === 0) {
      out[offset] = x;
      out[offset + stride] = ZERO20;
      return out;
    }
    word &= ~i;
    i = lib_default11(word);
    out[offset] = i;
    out[offset + stride] = lib_default3(x - i);
    return out;
  }
  out[offset] = x;
  out[offset + stride] = ZERO20;
  return out;
}
var assign_default16 = modff;

function modff2(x) {
  return assign_default16(x, [0, 0], 1, 0);
}
var main_default324 = modff2;

main_default324.assign = assign_default16;
var lib_default394 = main_default324;

function nanmax(x, y) {
  if (lib_default30(x)) {
    return lib_default30(y) ? NaN : y;
  }
  return lib_default30(y) ? x : lib_default149(x, y);
}
var main_default325 = nanmax;

var lib_default395 = main_default325;

function nanmaxf(x, y) {
  if (lib_default6(x)) {
    return lib_default6(y) ? NaN : y;
  }
  return lib_default6(y) ? x : lib_default381(x, y);
}
var main_default326 = nanmaxf;

var lib_default396 = main_default326;

function nanmin(x, y) {
  if (lib_default30(x)) {
    return lib_default30(y) ? NaN : y;
  }
  return lib_default30(y) ? x : lib_default151(x, y);
}
var main_default327 = nanmin;

var lib_default397 = main_default327;

function nanminf(x, y) {
  if (lib_default6(x)) {
    return lib_default6(y) ? NaN : y;
  }
  return lib_default6(y) ? x : lib_default385(x, y);
}
var main_default328 = nanminf;

var lib_default398 = main_default328;

var negafibonacci_default = [0, 1, -1, 2, -3, 5, -8, 13, -21, 34, -55, 89, -144, 233, -377, 610, -987, 1597, -2584, 4181, -6765, 10946, -17711, 28657, -46368, 75025, -121393, 196418, -317811, 514229, -832040, 1346269, -2178309, 3524578, -5702887, 9227465, -14930352, 24157817, -39088169, 63245986, -102334155, 165580141, -267914296, 433494437, -701408733, 1134903170, -1836311903, 2971215073, -4807526976, 7778742049, -12586269025, 20365011074, -32951280099, 53316291173, -86267571272, 139583862445, -225851433717, 365435296162, -591286729879, 956722026041, -1548008755920, 2504730781961, -4052739537881, 6557470319842, -10610209857723, 17167680177565, -27777890035288, 44945570212853, -72723460248141, 117669030460994, -190392490709135, 308061521170129, -498454011879264, 806515533049393, -1304969544928657, 2111485077978050, -3416454622906707, 5527939700884757, -8944394323791464];

function negafibonacci(n) {
  var an;
  if (lib_default30(n) || lib_default107(n) === false || n > 0) {
    return NaN;
  }
  an = lib_default(n);
  if (an > lib_default308) {
    return NaN;
  }
  return negafibonacci_default[an];
}
var main_default329 = negafibonacci;

var lib_default399 = main_default329;

var negafibonaccif_default = [0, 1, -1, 2, -3, 5, -8, 13, -21, 34, -55, 89, -144, 233, -377, 610, -987, 1597, -2584, 4181, -6765, 10946, -17711, 28657, -46368, 75025, -121393, 196418, -317811, 514229, -832040, 1346269, -2178309, 3524578, -5702887, 9227465, -14930352];

function negafibonaccif(n) {
  var an;
  if (lib_default6(n) || lib_default112(n) === false || n > 0) {
    return NaN;
  }
  an = lib_default5(n);
  if (an > lib_default313) {
    return NaN;
  }
  return negafibonaccif_default[an];
}
var main_default330 = negafibonaccif;

var lib_default400 = main_default330;

var negalucas_default = [2, -1, 3, -4, 7, -11, 18, -29, 47, -76, 123, -199, 322, -521, 843, -1364, 2207, -3571, 5778, -9349, 15127, -24476, 39603, -64079, 103682, -167761, 271443, -439204, 710647, -1149851, 1860498, -3010349, 4870847, -7881196, 12752043, -20633239, 33385282, -54018521, 87403803, -141422324, 228826127, -370248451, 599074578, -969323029, 1568397607, -2537720636, 4106118243, -6643838879, 10749957122, -17393796001, 28143753123, -45537549124, 73681302247, -119218851371, 192900153618, -312119004989, 505019158607, -817138163596, 1322157322203, -2139295485799, 3461452808002, -5600748293801, 9062201101803, -14662949395604, 23725150497407, -38388099893011, 62113250390418, -100501350283429, 162614600673847, -263115950957276, 425730551631123, -688846502588399, 1114577054219522, -1803423556807921, 2918000611027443, -4721424167835364, 7639424778862807];

function negalucas(n) {
  var an;
  if (lib_default30(n) || lib_default107(n) === false || n > 0) {
    return NaN;
  }
  an = lib_default(n);
  if (an > lib_default376) {
    return NaN;
  }
  return negalucas_default[an];
}
var main_default331 = negalucas;

var lib_default401 = main_default331;

var SQRT_54 = 2.23606797749979;
var LN_PHI3 = lib_default48(lib_default201);
function nonfibonacci(n) {
  var a;
  var b;
  if (lib_default30(n) || lib_default107(n) === false || n < 1 || n === lib_default43) {
    return NaN;
  }
  n += 1;
  a = lib_default48(n * SQRT_54) / LN_PHI3;
  b = lib_default48(SQRT_54 * (n + a) - 5 + 3 / n) / LN_PHI3;
  return lib_default105(n + b - 2);
}
var main_default332 = nonfibonacci;

var lib_default402 = main_default332;

var SQRT_55 = 2.23606797749979;
var LN_PHI4 = lib_default15(lib_default311);
function nonfibonaccif(n) {
  var a;
  var b;
  if (lib_default6(n) || lib_default112(n) === false || n < 1 || n === lib_default7) {
    return NaN;
  }
  n += 1;
  a = lib_default15(n * SQRT_55) / LN_PHI4;
  b = lib_default15(SQRT_55 * (n + a) - 5 + 3 / n) / LN_PHI4;
  return lib_default16(n + b - 2);
}
var main_default333 = nonfibonaccif;

var lib_default403 = main_default333;

function pdiff(x, y) {
  if (lib_default30(x) || lib_default30(y)) {
    return NaN;
  }
  if (x > y) {
    return x - y;
  }
  return 0;
}
var main_default334 = pdiff;

var lib_default404 = main_default334;

function pdifff(x, y) {
  if (lib_default6(x) || lib_default6(y)) {
    return NaN;
  }
  if (x > y) {
    return lib_default3(lib_default3(x) - lib_default3(y));
  }
  return 0;
}
var main_default335 = pdifff;

var lib_default405 = main_default335;

var PI_SQUARED = 9.869604401089358;
var lib_default406 = PI_SQUARED;

function evalrational66(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -0.9999999999999991;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -0.9999999999999991 + x * (-4.712373111208652 + x * (-7.94125711970499 + x * (-5.746577466976647 + x * (-0.4042133494563989 + x * (2.4787778117864288 + x * (2.0771415170245513 + x * (0.8588778991623601 + x * (0.20499222604410033 + x * (0.027210314034819473 + x * 0.001576484902087695)))))))));
    s2 = 1 + x * (4.712373111208634 + x * (9.586191186553398 + x * (11.094006726982938 + x * (8.090754247493278 + x * (3.877058901598914 + x * (1.2275867870191448 + x * (0.249092040606385 + x * (0.02957504139006556 + x * (0.0015764849020049815 + x * 16126405034405948e-31)))))))));
  } else {
    x = 1 / x;
    s1 = 0.001576484902087695 + x * (0.027210314034819473 + x * (0.20499222604410033 + x * (0.8588778991623601 + x * (2.0771415170245513 + x * (2.4787778117864288 + x * (-0.4042133494563989 + x * (-5.746577466976647 + x * (-7.94125711970499 + x * (-4.712373111208652 + x * -0.9999999999999991)))))))));
    s2 = 16126405034405948e-31 + x * (0.0015764849020049815 + x * (0.02957504139006556 + x * (0.249092040606385 + x * (1.2275867870191448 + x * (3.877058901598914 + x * (8.090754247493278 + x * (11.094006726982938 + x * (9.586191186553398 + x * (4.712373111208634 + x * 1)))))))));
  }
  return s1 / s2;
}
var rational_p12q12_default = evalrational66;

function evalrational67(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -2.5584373473990794;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -2.5584373473990794 + x * (-12.283020824054201 + x * (-23.9195022162768 + x * (-24.925643150482347 + x * (-14.797912276547878 + x * (-4.466544539286106 + x * (-0.01914390334056497 + x * (0.5154120525543513 + x * (0.1953783487860643 + x * (0.03347612826241743 + x * (0.0023736652059422065 + x * 0))))))))));
    s2 = 1 + x * (4.800985584544199 + x * (9.992207278431701 + x * (11.889614616763133 + x * (8.966132566838091 + x * (4.4725413614962415 + x * (1.4860098202819654 + x * (0.31957073576676426 + x * (0.040735834578768094 + x * (0.0023736652059327163 + x * (23955488790352614e-32 + x * -29474924474061867e-34))))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (0.0023736652059422065 + x * (0.03347612826241743 + x * (0.1953783487860643 + x * (0.5154120525543513 + x * (-0.01914390334056497 + x * (-4.466544539286106 + x * (-14.797912276547878 + x * (-24.925643150482347 + x * (-23.9195022162768 + x * (-12.283020824054201 + x * -2.5584373473990794))))))))));
    s2 = -29474924474061867e-34 + x * (23955488790352614e-32 + x * (0.0023736652059327163 + x * (0.040735834578768094 + x * (0.31957073576676426 + x * (1.4860098202819654 + x * (4.4725413614962415 + x * (8.966132566838091 + x * (11.889614616763133 + x * (9.992207278431701 + x * (4.800985584544199 + x * 1))))))))));
  }
  return s1 / s2;
}
var rational_p24q24_default = evalrational67;

function evalrational68(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 16662611269702147e-33;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 16662611269702147e-33 + x * (0.4999999999999977 + x * (6.402709450190538 + x * (41.38333741550006 + x * (166.8033418545628 + x * (453.39964786925367 + x * (851.153712317697 + x * (1097.7065756728507 + x * (938.4312324784553 + x * (487.26800160465194 + x * 119.95344524233573)))))))));
    s2 = 1 + x * (12.472085567047449 + x * (78.60931297532986 + x * (307.47024605031834 + x * (805.1406861011516 + x * (1439.1201976029215 + x * (1735.6105285756048 + x * (1348.3250071285634 + x * (607.2259858605709 + x * (119.95231785727705 + x * 14016591835503607e-20)))))))));
  } else {
    x = 1 / x;
    s1 = 119.95344524233573 + x * (487.26800160465194 + x * (938.4312324784553 + x * (1097.7065756728507 + x * (851.153712317697 + x * (453.39964786925367 + x * (166.8033418545628 + x * (41.38333741550006 + x * (6.402709450190538 + x * (0.4999999999999977 + x * 16662611269702147e-33)))))))));
    s2 = 14016591835503607e-20 + x * (119.95231785727705 + x * (607.2259858605709 + x * (1348.3250071285634 + x * (1735.6105285756048 + x * (1439.1201976029215 + x * (805.1406861011516 + x * (307.47024605031834 + x * (78.60931297532986 + x * (12.472085567047449 + x * 1)))))))));
  }
  return s1 / s2;
}
var rational_p48q48_default = evalrational68;

function evalrational69(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -1848283152741466e-35;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = -1848283152741466e-35 + x * (0.5 + x * (3.0253386524731334 + x * (13.599592751745737 + x * (35.31322242830879 + x * (67.16394245507142 + x * (83.5767733658514 + x * (71.07349121223571 + x * (35.86215156147256 + x * 8.721522316399835))))))));
    s2 = 1 + x * (5.717343971612935 + x * (25.29340417962044 + x * (62.26197679674682 + x * (113.955048909239 + x * (130.80713832893898 + x * (102.42314690233765 + x * (44.04247728052452 + x * (8.89898032477904 + x * -0.029662733687204))))))));
  } else {
    x = 1 / x;
    s1 = 8.721522316399835 + x * (35.86215156147256 + x * (71.07349121223571 + x * (83.5767733658514 + x * (67.16394245507142 + x * (35.31322242830879 + x * (13.599592751745737 + x * (3.0253386524731334 + x * (0.5 + x * -1848283152741466e-35))))))));
    s2 = -0.029662733687204 + x * (8.89898032477904 + x * (44.04247728052452 + x * (102.42314690233765 + x * (130.80713832893898 + x * (113.955048909239 + x * (62.26197679674682 + x * (25.29340417962044 + x * (5.717343971612935 + x * 1))))))));
  }
  return s1 / s2;
}
var rational_p816q816_default = evalrational69;

function evalrational70(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 0;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = 0 + x * (0.5 + x * (0.34562566988545623 + x * (9.628954993608422 + x * (3.5936085382439025 + x * (49.45959911843888 + x * (7.775192373218939 + x * (74.4536074488178 + x * (2.7520934039706906 + x * (23.92923597114717 + x * 0)))))))));
    s2 = 1 + x * (0.3579180064375791 + x * (19.138603985070986 + x * (0.8743490814641436 + x * (98.65160974348555 + x * (-16.10519728333829 + x * (154.31686021625373 + x * (-40.2026880424379 + x * (60.167913667426475 + x * (-13.341484462225642 + x * 2.537956362006499)))))))));
  } else {
    x = 1 / x;
    s1 = 0 + x * (23.92923597114717 + x * (2.7520934039706906 + x * (74.4536074488178 + x * (7.775192373218939 + x * (49.45959911843888 + x * (3.5936085382439025 + x * (9.628954993608422 + x * (0.34562566988545623 + x * (0.5 + x * 0)))))))));
    s2 = 2.537956362006499 + x * (-13.341484462225642 + x * (60.167913667426475 + x * (-40.2026880424379 + x * (154.31686021625373 + x * (-16.10519728333829 + x * (98.65160974348555 + x * (0.8743490814641436 + x * (19.138603985070986 + x * (0.3579180064375791 + x * 1)))))))));
  }
  return s1 / s2;
}
var rational_p16infq16inf_default = evalrational70;

var YOFFSET24 = 3.5584373474121094;
function trigamma(x) {
  var result;
  var s;
  var y;
  var z;
  result = 0;
  if (x <= 0) {
    if (lib_default105(x) === x) {
      return NaN;
    }
    s = lib_default166(x);
    z = 1 - x;
    return -trigamma(z) + lib_default406 / (s * s);
  }
  if (x < 1) {
    result = 1 / (x * x);
    x += 1;
  }
  if (x <= 2) {
    result += (2 + rational_p12q12_default(x)) / (x * x);
  } else if (x <= 4) {
    result += (YOFFSET24 + rational_p24q24_default(x)) / (x * x);
  } else if (x <= 8) {
    y = 1 / x;
    result += (1 + rational_p48q48_default(y)) / x;
  } else if (x <= 16) {
    y = 1 / x;
    result += (1 + rational_p816q816_default(y)) / x;
  } else {
    y = 1 / x;
    result += (1 + rational_p16infq16inf_default(y)) / x;
  }
  return result;
}
var main_default336 = trigamma;

var lib_default407 = main_default336;

var debug4 = alias_debug_default("polygamma");
var MAX_SERIES_ITERATIONS = 1e6;
var MAX_FACTORIAL = 172;
function atinfinityplus(n, x) {
  var partTerm;
  var xsquared;
  var term;
  var sum;
  var nlx;
  var k2;
  var k;
  if (n + x === x) {
    if (n === 1) {
      return 1 / x;
    }
    nlx = n * lib_default48(x);
    if (nlx < lib_default168 && n < MAX_FACTORIAL) {
      return (n & 1 ? 1 : -1) * lib_default161(n - 1) * lib_default142(x, -n);
    }
    return (n & 1 ? 1 : -1) * lib_default138(lib_default167(n) - n * lib_default48(x));
  }
  xsquared = x * x;
  if (n > MAX_FACTORIAL && n * n > lib_default168) {
    partTerm = 0;
  } else {
    partTerm = lib_default161(n - 1) * lib_default142(x, -n - 1);
  }
  if (partTerm === 0) {
    partTerm = lib_default167(n) - (n + 1) * lib_default48(x);
    sum = lib_default138(partTerm + lib_default48(n + 2 * x) - lib_default47);
    partTerm += lib_default48(n * (n + 1)) - lib_default47 - lib_default48(x);
    partTerm = lib_default138(partTerm);
  } else {
    sum = partTerm * (n + 2 * x) / 2;
    partTerm *= n * (n + 1) / 2;
    partTerm /= x;
  }
  if (sum === 0) {
    return sum;
  }
  for (k = 1; ; ) {
    term = partTerm * lib_default110(k * 2);
    sum += term;
    if (lib_default(term / sum) < lib_default144) {
      break;
    }
    k += 1;
    k2 = 2 * k;
    partTerm *= (n + k2 - 2) * (n - 1 + k2);
    partTerm /= (k2 - 1) * k2;
    partTerm /= xsquared;
    if (k > MAX_SERIES_ITERATIONS) {
      debug4("Series did not converge, closest value was: %d.", sum);
      return NaN;
    }
  }
  if (n - 1 & 1) {
    sum = -sum;
  }
  return sum;
}
var atinfinityplus_default = atinfinityplus;

var debug5 = alias_debug_default("polygamma");
var MAX_SERIES_ITERATIONS2 = 1e6;
var DIGITS_BASE10 = 19;
function attransitionplus(n, x) {
  var minusMminus1;
  var lnterm;
  var zpows;
  var iter;
  var sum0;
  var d4d;
  var N;
  var m;
  var k;
  var z;
  d4d = 0.4 * DIGITS_BASE10;
  N = d4d + 4 * n;
  m = n;
  iter = N - lib_default137(x);
  if (iter > MAX_SERIES_ITERATIONS2) {
    debug5("Exceeded maximum series evaluations when evaluated at n = %d and x = %d", n, x);
    return NaN;
  }
  minusMminus1 = -m - 1;
  z = x;
  sum0 = 0;
  zpows = 0;
  if (lib_default48(z + iter) * minusMminus1 > -lib_default168) {
    for (k = 1; k <= iter; k++) {
      zpows = lib_default142(z, minusMminus1);
      sum0 += zpows;
      z += 1;
    }
    sum0 *= lib_default161(n);
  } else {
    for (k = 1; k <= iter; k++) {
      lnterm = lib_default48(z) * minusMminus1 + lib_default167(n + 1);
      sum0 += lib_default138(lnterm);
      z += 1;
    }
  }
  if (n - 1 & 1) {
    sum0 = -sum0;
  }
  return sum0 + atinfinityplus_default(n, z);
}
var attransitionplus_default = attransitionplus;

var LN_PI = 1.1447298858494002;
var lib_default408 = LN_PI;

function evalpoly136(x) {
  if (x === 0) {
    return -2;
  }
  return -2 + x * -4;
}
var polyval_p3_default = evalpoly136;

function evalpoly137(x) {
  if (x === 0) {
    return 16;
  }
  return 16 + x * 8;
}
var polyval_p4_default = evalpoly137;

function evalpoly138(x) {
  if (x === 0) {
    return -16;
  }
  return -16 + x * (-88 + x * -16);
}
var polyval_p5_default = evalpoly138;

function evalpoly139(x) {
  if (x === 0) {
    return 272;
  }
  return 272 + x * (416 + x * 32);
}
var polyval_p6_default = evalpoly139;

function evalpoly140(x) {
  if (x === 0) {
    return -272;
  }
  return -272 + x * (-2880 + x * (-1824 + x * -64));
}
var polyval_p7_default = evalpoly140;

function evalpoly141(x) {
  if (x === 0) {
    return 7936;
  }
  return 7936 + x * (24576 + x * (7680 + x * 128));
}
var polyval_p8_default = evalpoly141;

function evalpoly142(x) {
  if (x === 0) {
    return -7936;
  }
  return -7936 + x * (-137216 + x * (-185856 + x * (-31616 + x * -256)));
}
var polyval_p9_default = evalpoly142;

function evalpoly143(x) {
  if (x === 0) {
    return 353792;
  }
  return 353792 + x * (1841152 + x * (1304832 + x * (128512 + x * 512)));
}
var polyval_p10_default = evalpoly143;

function evalpoly144(x) {
  if (x === 0) {
    return -353792;
  }
  return -353792 + x * (-9061376 + x * (-21253376 + x * (-8728576 + x * (-518656 + x * -1024))));
}
var polyval_p11_default = evalpoly144;

function evalpoly145(x) {
  if (x === 0) {
    return 22368256;
  }
  return 22368256 + x * (175627264 + x * (222398464 + x * (56520704 + x * (2084864 + x * 2048))));
}
var polyval_p12_default = evalpoly145;

var debug6 = alias_debug_default("polygamma");
var MAX_SERIES_ITERATIONS3 = 1e6;
var PI22 = 9.869604401089358;
var PI32 = 31.00627668029982;
var PI42 = 97.40909103400244;
var PI5 = 306.01968478528147;
var PI6 = 961.3891935753045;
var PI7 = 3020.2932277767923;
var PI8 = 9488.531016070574;
var PI9 = 29809.09933344621;
var PI10 = 93648.04747608303;
var PI11 = 294204.0179738906;
var PI12 = 924269.1815233742;
var table2 = [
  [-1]
];
function calculateDerivatives(n) {
  var noffset;
  var offset;
  var ncols;
  var mcols;
  var mo;
  var so;
  var co;
  var i;
  var j;
  var k;
  for (i = table2.length - 1; i < n - 1; i++) {
    offset = i & 1 | 0;
    so = i + 2 | 0;
    mo = so - 1 | 0;
    ncols = (mo - offset) / 2 | 0;
    noffset = offset ? 0 : 1;
    mcols = (mo + 1 - noffset) / 2 | 0;
    table2.push(lib_default127(mcols + 1));
    for (j = 0; j <= ncols; j++) {
      co = 2 * j + offset | 0;
      k = (co + 1) / 2 | 0;
      table2[i + 1][k] += (co - so) * table2[i][j] / (so - 1);
      if (co) {
        k = (co - 1) / 2 | 0;
        table2[i + 1][k] += -co * table2[i][j] / (so - 1);
      }
    }
  }
}
function polycotpi(n, x, xc) {
  var powTerms;
  var idx;
  var out;
  var sum;
  var c2;
  var s;
  s = lib_default(x) < lib_default(xc) ? lib_default166(x) : lib_default166(xc);
  c2 = lib_default200(x);
  switch (n) {
    // eslint-disable-line default-case
    case 1:
      return -lib_default26 / (s * s);
    case 2:
      return 2 * PI22 * c2 / lib_default142(s, 3);
    case 3:
      return PI32 * polyval_p3_default(c2 * c2) / lib_default142(s, 4);
    case 4:
      return PI42 * c2 * polyval_p4_default(c2 * c2) / lib_default142(s, 5);
    case 5:
      return PI5 * polyval_p5_default(c2 * c2) / lib_default142(s, 6);
    case 6:
      return PI6 * c2 * polyval_p6_default(c2 * c2) / lib_default142(s, 7);
    case 7:
      return PI7 * polyval_p7_default(c2 * c2) / lib_default142(s, 8);
    case 8:
      return PI8 * c2 * polyval_p8_default(c2 * c2) / lib_default142(s, 9);
    case 9:
      return PI9 * polyval_p9_default(c2 * c2) / lib_default142(s, 10);
    case 10:
      return PI10 * c2 * polyval_p10_default(c2 * c2) / lib_default142(s, 11);
    case 11:
      return PI11 * polyval_p11_default(c2 * c2) / lib_default142(s, 12);
    case 12:
      return PI12 * c2 * polyval_p12_default(c2 * c2) / lib_default142(s, 13);
  }
  if (n / 2 > MAX_SERIES_ITERATIONS3) {
    debug6("The value of `n` is so large that we're unable to compute the result in reasonable time.");
    return NaN;
  }
  idx = n - 1;
  if (idx >= table2.length) {
    calculateDerivatives(n);
  }
  sum = lib_default174(table2[idx], c2 * c2);
  if (idx & 1) {
    sum *= c2;
  }
  if (sum === 0) {
    return sum;
  }
  powTerms = n * lib_default408;
  if (s === 0) {
    return sum >= 0 ? lib_default43 : lib_default44;
  }
  powTerms -= lib_default48(lib_default(s)) * (n + 1);
  powTerms += lib_default167(n) + lib_default48(lib_default(sum));
  if (powTerms > lib_default168) {
    return sum >= 0 ? lib_default43 : lib_default44;
  }
  out = lib_default138(powTerms) * lib_default192(sum);
  if (s < 0 && n + 1 & 1) {
    out *= -1;
  }
  return out;
}
var polycotpi_default = polycotpi;

var debug7 = alias_debug_default("polygamma");
var MAX_SERIES_ITERATIONS4 = 1e6;
function nearzero(n, x) {
  var factorialPart;
  var prefix;
  var scale;
  var term;
  var sum;
  var AX;
  var k;
  scale = lib_default161(n);
  factorialPart = 1;
  prefix = lib_default142(x, n + 1);
  if (prefix === 0) {
    return lib_default43;
  }
  prefix = 1 / prefix;
  if (prefix > 2 / lib_default144) {
    if (n & 1) {
      return AX / prefix < scale ? lib_default43 : prefix * scale;
    }
    return AX / prefix < scale ? lib_default44 : -prefix * scale;
  }
  sum = prefix;
  for (k = 0; ; ) {
    term = factorialPart * lib_default269(k + n + 1);
    sum += term;
    if (lib_default(term) < lib_default(sum * lib_default144)) {
      break;
    }
    k += 1;
    factorialPart *= -x * (n + k) / k;
    if (k > MAX_SERIES_ITERATIONS4) {
      debug7("Series did not converge, best value is %d.", sum);
      return NaN;
    }
  }
  if (lib_default152 / scale < sum) {
    return lib_default43;
  }
  sum *= scale;
  return n & 1 ? sum : -sum;
}
var nearzero_default = nearzero;

var debug8 = alias_debug_default("polygamma");
var DIGITS_BASE102 = 19;
function polygamma(n, x) {
  var xSmallLimit;
  var result;
  var z;
  if (!lib_default106(n)) {
    return NaN;
  }
  if (n === 0) {
    return lib_default266(x);
  }
  if (n === 1) {
    return lib_default407(x);
  }
  if (x < 0) {
    if (lib_default105(x) === x) {
      if (lib_default137(x) & 1) {
        return lib_default43;
      }
      debug8("Evaluation at negative integer: %d.", x);
      return NaN;
    }
    z = 1 - x;
    result = polygamma(n, z) + lib_default26 * polycotpi_default(n, z, x);
    return n & 1 ? -result : result;
  }
  xSmallLimit = lib_default151(5 / n, 0.25);
  if (x < xSmallLimit) {
    return nearzero_default(n, x);
  }
  if (x > 0.4 * DIGITS_BASE102 + 4 * n) {
    return atinfinityplus_default(n, x);
  }
  if (x === 1) {
    return (n & 1 ? 1 : -1) * lib_default161(n) * lib_default269(n + 1);
  }
  if (x === 0.5) {
    result = (n & 1 ? 1 : -1) * lib_default161(n) * lib_default269(n + 1);
    if (lib_default(result) >= lib_default125(lib_default152, -n - 1)) {
      return lib_default192(result) === 1 ? lib_default43 : lib_default44;
    }
    result *= lib_default125(1, n + 1) - 1;
    return result;
  }
  return attransitionplus_default(n, x);
}
var main_default337 = polygamma;

var lib_default409 = main_default337;

function ramp(x) {
  if (lib_default30(x)) {
    return NaN;
  }
  if (x > 0) {
    return x;
  }
  return 0;
}
var main_default338 = ramp;

var lib_default410 = main_default338;

function rampf(x) {
  if (lib_default6(x)) {
    return NaN;
  }
  if (x > 0) {
    return x;
  }
  return 0;
}
var main_default339 = rampf;

var lib_default411 = main_default339;

function rcbrt(x) {
  return 1 / lib_default211(x);
}
var main_default340 = rcbrt;

var lib_default412 = main_default340;

function rcbrtf(x) {
  return lib_default3(1 / lib_default211(lib_default3(x)));
}
var main_default341 = rcbrtf;

var lib_default413 = main_default341;

function risingFactorial2(x, n) {
  var result;
  var inv2;
  if (lib_default30(x) || !lib_default107(n)) {
    return NaN;
  }
  if (x < 0) {
    if (n < 0) {
      x += n;
      n = -n;
      inv2 = true;
    }
    result = (n & 1 ? -1 : 1) * lib_default290(-x, n);
    if (inv2) {
      result = 1 / result;
    }
    return result;
  }
  if (n === 0) {
    return 1;
  }
  if (x === 0) {
    if (n < 0) {
      return -lib_default164(x + 1, -n);
    }
    return 0;
  }
  if (x < 1 && x + n < 0) {
    result = lib_default164(1 - x, -n);
    return n & 1 ? -result : result;
  }
  return 1 / lib_default164(x, n);
}
var main_default342 = risingFactorial2;

var lib_default414 = main_default342;

function roundNearestEven(x) {
  var frac;
  var int;
  if (lib_default30(x) || lib_default76(x) || x === 0) {
    return x;
  }
  int = lib_default105(x);
  frac = x - int;
  if (frac > 0.5) {
    return int + 1;
  }
  if (frac < 0.5) {
    return int;
  }
  return int % 2 === 0 ? int : int + 1;
}
var main_default343 = roundNearestEven;

var lib_default415 = main_default343;

var HUGE11 = 1e308;
var TINY10 = 1e-323;
function round10(x) {
  var sign;
  var half;
  var p110;
  var p210;
  var y12;
  var y2;
  var p101;
  if (lib_default30(x) || lib_default76(x) || x === 0) {
    return x;
  }
  if (x < 0) {
    x = -x;
    sign = -1;
  } else {
    sign = 1;
  }
  p101 = lib_default214(x);
  p110 = lib_default105(p101);
  p210 = lib_default136(p101);
  if (p110 === lib_default216) {
    return sign * TINY10;
  }
  if (p110 === lib_default215) {
    return sign * HUGE11;
  }
  y12 = lib_default142(10, p110);
  y2 = lib_default142(10, p210);
  half = (y2 - y12) / 2;
  if (y12 + half > x) {
    return sign * y12;
  }
  return sign * y2;
}
var main_default344 = round10;

var lib_default416 = main_default344;

var HUGE12 = lib_default142(2, lib_default119);
var HALF_HUGE = HUGE12 / 2;
function round2(x) {
  var sign;
  var half;
  var p110;
  var p210;
  var y12;
  var y2;
  var p101;
  if (lib_default30(x) || lib_default76(x) || x === 0) {
    return x;
  }
  if (x < 0) {
    x = -x;
    sign = -1;
  } else {
    sign = 1;
  }
  p101 = lib_default218(x);
  if (p101 === lib_default121) {
    return x;
  }
  p110 = lib_default105(p101);
  p210 = lib_default136(p101);
  if (p110 === lib_default119) {
    if (x - HUGE12 >= HALF_HUGE) {
      return sign * lib_default43;
    }
    return sign * HUGE12;
  }
  y12 = lib_default142(2, p110);
  y2 = lib_default142(2, p210);
  half = (y2 - y12) / 2;
  if (y12 + half > x) {
    return sign * y12;
  }
  return sign * y2;
}
var main_default345 = round2;

var lib_default417 = main_default345;

var MAX_INT4 = lib_default185 + 1;
var HUGE13 = 1e308;
function roundn(x, n) {
  var s;
  var y;
  if (lib_default30(x) || lib_default30(n) || lib_default76(n)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0 || n < lib_default216 || lib_default(x) > MAX_INT4 && n <= 0) {
    return x;
  }
  if (n > lib_default215) {
    return 0 * x;
  }
  if (n < lib_default220) {
    s = lib_default142(10, -(n + lib_default215));
    y = x * HUGE13 * s;
    if (lib_default76(y)) {
      return x;
    }
    return lib_default128(y) / HUGE13 / s;
  }
  s = lib_default142(10, -n);
  y = x * s;
  if (lib_default76(y)) {
    return x;
  }
  return lib_default128(y) / s;
}
var main_default346 = roundn;

var lib_default418 = main_default346;

function roundb(x, n, b) {
  var y;
  var s;
  if (lib_default30(x) || lib_default30(n) || lib_default30(b) || b <= 0 || lib_default76(n) || lib_default76(b)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0) {
    return x;
  }
  if (b === 10) {
    return lib_default418(x, n);
  }
  if (n === 0 || b === 1) {
    return lib_default128(x);
  }
  s = lib_default142(b, -n);
  if (lib_default76(s)) {
    return x;
  }
  y = lib_default128(x * s) / s;
  if (lib_default76(y)) {
    return x;
  }
  return y;
}
var main_default347 = roundb;

var lib_default419 = main_default347;

var MAX_INT5 = lib_default203 + 1;
var HUGE14 = lib_default3(1e38);
var ZERO21 = lib_default3(0);
var TEN = lib_default3(10);
function roundnf(x, n) {
  var s;
  var y;
  x = lib_default3(x);
  if (lib_default6(x) || lib_default6(n) || lib_default9(n)) {
    return NaN;
  }
  if (lib_default9(x) || x === ZERO21 || n < lib_default328 || lib_default5(x) > MAX_INT5 && n <= 0) {
    return x;
  }
  if (n > lib_default326) {
    return lib_default3(ZERO21 * x);
  }
  if (n < lib_default327) {
    s = lib_default320(TEN, -(n + lib_default326));
    y = lib_default3(lib_default3(x * HUGE14) * s);
    if (lib_default9(y)) {
      return x;
    }
    return lib_default3(lib_default3(lib_default233(y) / HUGE14) / s);
  }
  s = lib_default320(TEN, -n);
  y = lib_default3(x * s);
  if (lib_default9(y)) {
    return x;
  }
  return lib_default3(lib_default233(y) / s);
}
var main_default348 = roundnf;

var lib_default420 = main_default348;

function roundsd(x, n, b) {
  var base;
  var exp3;
  var s;
  var y;
  if (lib_default30(x) || lib_default30(n) || n < 1 || lib_default76(n)) {
    return NaN;
  }
  if (arguments.length > 2) {
    if (lib_default30(b) || b <= 0 || lib_default76(b)) {
      return NaN;
    }
    base = b;
  } else {
    base = 10;
  }
  if (lib_default76(x) || x === 0) {
    return x;
  }
  if (base === 10) {
    exp3 = lib_default214(lib_default(x));
  } else if (base === 2) {
    exp3 = lib_default122(lib_default(x));
  } else {
    exp3 = lib_default48(lib_default(x)) / lib_default48(base);
  }
  exp3 = lib_default105(exp3 - n + 1);
  s = lib_default142(base, lib_default(exp3));
  if (lib_default76(s)) {
    return x;
  }
  if (exp3 < 0) {
    y = lib_default128(x * s) / s;
  } else {
    y = lib_default128(x / s) * s;
  }
  if (lib_default76(y)) {
    return x;
  }
  return y;
}
var main_default349 = roundsd;

var lib_default421 = main_default349;

function rsqrt(x) {
  return 1 / lib_default31(x);
}
var main_default350 = rsqrt;

var lib_default422 = main_default350;

function rsqrtf(x) {
  return lib_default3(1 / lib_default31(lib_default3(x)));
}
var main_default351 = rsqrtf;

var lib_default423 = main_default351;

function sec(x) {
  return 1 / lib_default165(x);
}
var main_default352 = sec;

var lib_default424 = main_default352;

function secd(x) {
  return 1 / lib_default229(x);
}
var main_default353 = secd;

var lib_default425 = main_default353;

function secdf(x) {
  return lib_default3(lib_default3(1) / lib_default232(lib_default3(x)));
}
var main_default354 = secdf;

var lib_default426 = main_default354;

var ONE25 = lib_default3(1);
function secf(x) {
  return lib_default3(ONE25 / lib_default235(lib_default3(x)));
}
var main_default355 = secf;

var lib_default427 = main_default355;

function sech(x) {
  return 1 / lib_default236(x);
}
var main_default356 = sech;

var lib_default428 = main_default356;

function evalpoly146(x) {
  if (x === 0) {
    return 5489002234213736e-22;
  }
  return 5489002234213736e-22 + x * (10893658065032867e-20 + x * (0.006810201324725182 + x * (0.16700661183132304 + x * (1.6208328770153833 + x * (5.4593771716181285 + x * 4.236128628922166)))));
}
var polyval_fn4_default = evalpoly146;

function evalpoly147(x) {
  if (x === 0) {
    return 5489002527562557e-22;
  }
  return 5489002527562557e-22 + x * (11003435715391573e-20 + x * (0.007017106683227897 + x * (0.1787920529631499 + x * (1.867922579501842 + x * (7.308288225055645 + x * (8.16496634205391 + x * 1))))));
}
var polyval_fd4_default = evalpoly147;

function evalpoly148(x) {
  if (x === 0) {
    return 970507110881952e-28;
  }
  return 970507110881952e-28 + x * (941779576128513e-25 + x * (3200927900910049e-23 + x * (48621543082645475e-22 + x * (34955644244785906e-20 + x * (0.01160642294081244 + x * (0.16030015822231947 + x * (0.7137152741001467 + x * 0.4558808734704653)))))));
}
var polyval_fn8_default = evalpoly148;

function evalpoly149(x) {
  if (x === 0) {
    return 970507110881952e-28;
  }
  return 970507110881952e-28 + x * (9437205903502767e-26 + x * (321956939101046e-22 + x * (4924350643178815e-21 + x * (35869648188185157e-20 + x * (0.012225359477197129 + x * (0.17868554533207454 + x * (0.9174636118736841 + x * 1)))))));
}
var polyval_fd8_default = evalpoly149;

function evalpoly150(x) {
  if (x === 0) {
    return 7825790407440903e-24;
  }
  return 7825790407440903e-24 + x * (19796387414096365e-22 + x * (16199979459893403e-20 + x * (0.005388686814621773 + x * (0.07485277376284691 + x * (0.3971802963923375 + x * (0.6113791099522193 + x * 0.08710016989731142))))));
}
var polyval_gn4_default = evalpoly150;

function evalpoly151(x) {
  if (x === 0) {
    return 7825792189335346e-24;
  }
  return 7825792189335346e-24 + x * (20265918208634397e-22 + x * (1732210814741771e-19 + x * (0.006223963454417684 + x * (0.09887717612776888 + x * (0.666296701268988 + x * (1.6440220241335535 + x * 1))))));
}
var polyval_gd4_default = evalpoly151;

function evalpoly152(x) {
  if (x === 0) {
    return 31404009894636335e-31;
  }
  return 31404009894636335e-31 + x * (3859459254302766e-27 + x * (17040445278204452e-25 + x * (3471311670841167e-22 + x * (34894116550227946e-21 + x * (0.001717182390523479 + x * (0.03848787676499743 + x * (0.33041097930563207 + x * 0.6973599534432762)))))));
}
var polyval_gn8_default = evalpoly152;

function evalpoly153(x) {
  if (x === 0) {
    return 31404009894636335e-31;
  }
  return 31404009894636335e-31 + x * (3878301660239547e-27 + x * (17269374896631615e-25 + x * (35704322344374083e-23 + x * (3684755044425611e-20 + x * (0.0019028442667439953 + x * (0.04679131942596258 + x * (0.48785225869530496 + x * (1.6854889881101165 + x * 1))))))));
}
var polyval_gd8_default = evalpoly153;

function evalpoly154(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (-0.04134703162294066 + x * (9769454381704354e-19 + x * (-9757593038436328e-21 + x * (4625917144270128e-23 + x * -8391678279103039e-26))));
}
var polyval_sn_default = evalpoly154;

function evalpoly155(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (0.01420852393261499 + x * (9964121220438756e-20 + x * (4418278428012189e-22 + x * (1279978911799433e-24 + x * 20326926619595193e-28))));
}
var polyval_sd_default = evalpoly155;

function evalpoly156(x) {
  if (x === 0) {
    return -1;
  }
  return -1 + x * (0.028915965260755523 + x * (-4740072068734079e-19 + x * (3593250514199931e-21 + x * (-13524950491579076e-24 + x * 20252400238910228e-27))));
}
var polyval_cn_default = evalpoly156;

function evalpoly157(x) {
  if (x === 0) {
    return 4;
  }
  return 4 + x * (0.051002805623644606 + x * (31744202477503275e-20 + x * (12321035568588342e-22 + x * (3067809975818878e-24 + x * 4077460400618806e-27))));
}
var polyval_cd_default = evalpoly157;

function sici(x, out, stride, offset) {
  var sgn;
  var si;
  var ci;
  var c2;
  var f;
  var g;
  var s;
  var z;
  if (lib_default30(x)) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  if (x < 0) {
    sgn = -1;
    x = -x;
  } else {
    sgn = 0;
  }
  if (x === 0) {
    out[offset] = 0;
    out[offset + stride] = lib_default44;
    return out;
  }
  if (x > 1e9) {
    if (lib_default76(x)) {
      if (sgn === -1) {
        si = -lib_default54;
        ci = NaN;
      } else {
        si = lib_default54;
        ci = 0;
      }
      out[offset] = si;
      out[offset + stride] = ci;
      return out;
    }
    si = lib_default54 - lib_default165(x) / x;
    ci = lib_default156(x) / x;
  }
  if (x > 4) {
    s = lib_default156(x);
    c2 = lib_default165(x);
    z = 1 / (x * x);
    if (x < 8) {
      f = polyval_fn4_default(z) / (x * polyval_fd4_default(z));
      g = z * polyval_gn4_default(z) / polyval_gd4_default(z);
    } else {
      f = polyval_fn8_default(z) / (x * polyval_fd8_default(z));
      g = z * polyval_gn8_default(z) / polyval_gd8_default(z);
    }
    si = lib_default54 - f * c2 - g * s;
    if (sgn) {
      si = -si;
    }
    ci = f * s - g * c2;
    out[offset] = si;
    out[offset + stride] = ci;
    return out;
  }
  z = x * x;
  s = x * polyval_sn_default(z) / polyval_sd_default(z);
  c2 = z * polyval_cn_default(z) / polyval_cd_default(z);
  if (sgn) {
    s = -s;
  }
  si = s;
  ci = lib_default158 + lib_default48(x) + c2;
  out[offset] = si;
  out[offset + stride] = ci;
  return out;
}
var assign_default17 = sici;

function sici2(x) {
  return assign_default17(x, [0, 0], 1, 0);
}
var main_default357 = sici2;

main_default357.assign = assign_default17;
var lib_default429 = main_default357;

function sinc(x) {
  if (lib_default30(x)) {
    return NaN;
  }
  if (lib_default76(x)) {
    return 0;
  }
  if (x === 0) {
    return 1;
  }
  return lib_default166(x) / (lib_default26 * x);
}
var main_default358 = sinc;

var lib_default430 = main_default358;

var ONE26 = lib_default3(1);
var ZERO22 = lib_default3(0);
function sincf(x) {
  x = lib_default3(x);
  if (lib_default6(x)) {
    return NaN;
  }
  if (lib_default9(x)) {
    return ZERO22;
  }
  if (x === ZERO22) {
    return ONE26;
  }
  return lib_default3(lib_default27(x) / lib_default3(lib_default28 * x));
}
var main_default359 = sincf;

var lib_default431 = main_default359;

function sincosd(x, out, stride, offset) {
  out[offset] = lib_default245(x);
  out[offset + stride] = lib_default229(x);
  return out;
}
var assign_default18 = sincosd;

function sincosd2(x) {
  return assign_default18(x, [0, 0], 1, 0);
}
var main_default360 = sincosd2;

main_default360.assign = assign_default18;
var lib_default432 = main_default360;

function sincosdf(x, out, stride, offset) {
  out[offset] = lib_default248(x);
  out[offset + stride] = lib_default232(x);
  return out;
}
var assign_default19 = sincosdf;

function sincosdf2(x) {
  return assign_default19(x, [0, 0], 1, 0);
}
var main_default361 = sincosdf2;

main_default361.assign = assign_default19;
var lib_default433 = main_default361;

var kernelSincosf3 = lib_default362.assign;
var PIO4_WORD4 = 1061752794 | 0;
var THREE_PIO4_WORD4 = 1075235811 | 0;
var FIVE_PIO4_WORD4 = 1081824209 | 0;
var SEVEN_PIO4_WORD4 = 1085271519 | 0;
var NINE_PIO4_WORD4 = 1088565717 | 0;
var SMALL_WORD6 = 964689920 | 0;
var PIO27 = lib_default54;
var PI13 = 2 * lib_default54;
var THREE_PIO24 = 3 * lib_default54;
var TWO_PI5 = 4 * lib_default54;
var Y10 = [0];
function sincosf(x, out, stride, offset) {
  var tmp7;
  var hx;
  var ix;
  var n;
  hx = lib_default10(lib_default3(x)) | 0;
  ix = hx & lib_default22 | 0;
  if (ix <= PIO4_WORD4) {
    if (ix < SMALL_WORD6) {
      if ((x | 0) === 0) {
        out[offset] = lib_default3(x);
        out[offset + stride] = lib_default3(1);
        return out;
      }
    }
    return kernelSincosf3(x, out, stride, offset);
  }
  if (ix <= FIVE_PIO4_WORD4) {
    if (ix <= THREE_PIO4_WORD4) {
      if (hx > 0) {
        kernelSincosf3(x - PIO27, out, stride, offset);
        tmp7 = lib_default3(-out[offset]);
        out[offset] = out[offset + stride];
        out[offset + stride] = tmp7;
      } else {
        kernelSincosf3(x + PIO27, out, stride, offset);
        tmp7 = lib_default3(-out[offset + stride]);
        out[offset + stride] = out[offset];
        out[offset] = tmp7;
      }
    } else {
      if (hx > 0) {
        kernelSincosf3(x - PI13, out, stride, offset);
      } else {
        kernelSincosf3(x + PI13, out, stride, offset);
      }
      out[offset] = lib_default3(-out[offset]);
      out[offset + stride] = lib_default3(-out[offset + stride]);
    }
    return out;
  }
  if (ix <= NINE_PIO4_WORD4) {
    if (ix <= SEVEN_PIO4_WORD4) {
      if (hx > 0) {
        kernelSincosf3(x - THREE_PIO24, out, stride, offset);
        tmp7 = lib_default3(-out[offset + stride]);
        out[offset + stride] = out[offset];
        out[offset] = tmp7;
      } else {
        kernelSincosf3(x + THREE_PIO24, out, stride, offset);
        tmp7 = lib_default3(-out[offset]);
        out[offset] = out[offset + stride];
        out[offset + stride] = tmp7;
      }
    } else if (hx > 0) {
      kernelSincosf3(x - TWO_PI5, out, stride, offset);
    } else {
      kernelSincosf3(x + TWO_PI5, out, stride, offset);
    }
    return out;
  }
  if (ix >= lib_default12) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  n = lib_default234(lib_default3(x), Y10);
  kernelSincosf3(Y10[0], out, stride, offset);
  switch (n & 3) {
    case 0:
      return out;
    case 1:
      tmp7 = out[offset + stride];
      out[offset + stride] = lib_default3(-out[offset]);
      out[offset] = tmp7;
      return out;
    case 2:
      out[offset] = lib_default3(-out[offset]);
      out[offset + stride] = lib_default3(-out[offset + stride]);
      return out;
    default:
      tmp7 = lib_default3(-out[offset + stride]);
      out[offset + stride] = out[offset];
      out[offset] = tmp7;
      return out;
  }
}
var assign_default20 = sincosf;

function sincosf2(x) {
  return assign_default20(x, [0, 0], 1, 0);
}
var main_default362 = sincosf2;

main_default362.assign = assign_default20;
var lib_default434 = main_default362;

var sincos11 = lib_default130.assign;
function sincospi(x, out, stride, offset) {
  var tmp7;
  var ix;
  var ar;
  var r;
  if (lib_default30(x) || lib_default76(x)) {
    out[offset] = NaN;
    out[offset + stride] = NaN;
    return out;
  }
  r = x % 2;
  ar = lib_default(r);
  if (ar === 0 || ar === 1) {
    ix = lib_default105(ar);
    out[offset] = lib_default95(0, r);
    out[offset + stride] = ix % 2 === 1 ? -1 : 1;
    return out;
  }
  if (ar < 0.25) {
    return sincos11(lib_default26 * r, out, stride, offset);
  }
  if (ar < 0.75) {
    ar = 0.5 - ar;
    sincos11(lib_default26 * ar, out, stride, offset);
    tmp7 = out[offset];
    out[offset] = lib_default95(out[offset + stride], r);
    out[offset + stride] = tmp7;
    return out;
  }
  if (ar < 1.25) {
    r = lib_default95(1, r) - r;
    sincos11(lib_default26 * r, out, stride, offset);
    out[offset + stride] *= -1;
    return out;
  }
  if (ar < 1.75) {
    ar -= 1.5;
    sincos11(lib_default26 * ar, out, stride, offset);
    tmp7 = out[offset];
    out[offset] = -lib_default95(out[offset + stride], r);
    out[offset + stride] = tmp7;
    return out;
  }
  r -= lib_default95(2, r);
  return sincos11(lib_default26 * r, out, stride, offset);
}
var assign_default21 = sincospi;

function sincospi2(x) {
  return assign_default21(x, [0, 0], 1, 0);
}
var main_default363 = sincospi2;

main_default363.assign = assign_default21;
var lib_default435 = main_default363;

function evalpoly158(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (3.297713409852251 + x * (4.256971560081218 + x * (2.7114985119655346 + x * (0.8796913117545303 + x * (0.13384763957830903 + x * (0.007315890452380947 + x * 46512858607399003e-21))))));
}
var polyval_a_default = evalpoly158;

function evalpoly159(x) {
  if (x === 0) {
    return 1;
  }
  return 1 + x * (3.547713409852251 + x * (5.03278880143317 + x * (3.6380053334513707 + x * (1.4117259775183106 + x * (0.2829748606025681 + x * (0.02540437639325444 + x * 6909904889125533e-19))))));
}
var polyval_b_default = evalpoly159;

var PI2O6 = lib_default406 / 6;
function spence(x) {
  var flg;
  var w;
  var y;
  var z;
  if (lib_default30(x) || x < 0) {
    return NaN;
  }
  if (x === 1) {
    return 0;
  }
  if (x === 0) {
    return PI2O6;
  }
  flg = 0;
  if (x > 2) {
    x = 1 / x;
    flg |= 2;
  }
  if (x > 1.5) {
    w = 1 / x - 1;
    flg |= 2;
  } else if (x < 0.5) {
    w = -x;
    flg |= 1;
  } else {
    w = x - 1;
  }
  y = -w * polyval_a_default(w) / polyval_b_default(w);
  if (flg & 1) {
    y = PI2O6 - lib_default48(x) * lib_default48(1 - x) - y;
  }
  if (flg & 2) {
    z = lib_default48(x);
    y = -(0.5 * z * z) - y;
  }
  return y;
}
var main_default364 = spence;

var lib_default436 = main_default364;

function evalpoly160(x) {
  if (x === 0) {
    return 1;
  }
  return lib_default3(1 + lib_default3(x * lib_default3(3.2977135181427 + lib_default3(x * lib_default3(4.25697135925293 + lib_default3(x * lib_default3(2.711498498916626 + lib_default3(x * lib_default3(0.8796913027763367 + lib_default3(x * lib_default3(0.13384763896465302 + lib_default3(x * lib_default3(0.007315890397876501 + lib_default3(x * 4651285780710168e-20))))))))))))));
}
var polyval_a_default2 = evalpoly160;

function evalpoly161(x) {
  if (x === 0) {
    return 1;
  }
  return lib_default3(1 + lib_default3(x * lib_default3(3.5477135181427 + lib_default3(x * lib_default3(5.0327887535095215 + lib_default3(x * lib_default3(3.638005256652832 + lib_default3(x * lib_default3(1.4117259979248047 + lib_default3(x * lib_default3(0.28297486901283264 + lib_default3(x * lib_default3(0.025404376909136772 + lib_default3(x * 6909904768690467e-19))))))))))))));
}
var polyval_b_default2 = evalpoly161;

var PI2O62 = lib_default3(1.6449340668482264);
var ZERO23 = lib_default3(0);
var HALF10 = lib_default3(0.5);
var ONE27 = lib_default3(1);
function spencef(x) {
  var flg;
  var w;
  var y;
  var z;
  x = lib_default3(x);
  if (lib_default6(x) || x < 0) {
    return NaN;
  }
  if (x === 1) {
    return ZERO23;
  }
  if (x === 0) {
    return PI2O62;
  }
  flg = 0;
  if (x > 2) {
    x = lib_default3(ONE27 / x);
    flg |= 2;
  }
  if (x > 1.5) {
    w = lib_default3(lib_default3(ONE27 / x) - ONE27);
    flg |= 2;
  } else if (x < 0.5) {
    w = lib_default3(-x);
    flg |= 1;
  } else {
    w = lib_default3(x - ONE27);
  }
  y = lib_default3(-w * lib_default3(polyval_a_default2(w) / polyval_b_default2(w)));
  if (flg & 1) {
    y = lib_default3(lib_default3(PI2O62 - lib_default3(lib_default15(x) * lib_default15(ONE27 - x))) - y);
  }
  if (flg & 2) {
    z = lib_default15(x);
    y = lib_default3(-lib_default3(lib_default3(HALF10 * lib_default3(z * z)) + y));
  }
  return y;
}
var main_default365 = spencef;

var lib_default437 = main_default365;

function sqrt1pm1(x) {
  if (lib_default30(x)) {
    return NaN;
  }
  if (lib_default(x) > 0.75) {
    return lib_default31(1 + x) - 1;
  }
  return lib_default147(lib_default46(x) / 2);
}
var main_default366 = sqrt1pm1;

var lib_default438 = main_default366;

function sqrtpi(x) {
  return lib_default31(x * lib_default26);
}
var main_default367 = sqrtpi;

var lib_default439 = main_default367;

function sqrtpif(x) {
  return lib_default38(lib_default3(lib_default3(x) * lib_default28));
}
var main_default368 = sqrtpif;

var lib_default440 = main_default368;

function tand(x) {
  return lib_default245(x) / lib_default229(x);
}
var main_default369 = tand;

var lib_default441 = main_default369;

function tandf(x) {
  x = lib_default3(x);
  return lib_default248(x) / lib_default232(x);
}
var main_default370 = tandf;

var lib_default442 = main_default370;

var tribonacci_default = [0, 0, 1, 1, 2, 4, 7, 13, 24, 44, 81, 149, 274, 504, 927, 1705, 3136, 5768, 10609, 19513, 35890, 66012, 121415, 223317, 410744, 755476, 1389537, 2555757, 4700770, 8646064, 15902591, 29249425, 53798080, 98950096, 181997601, 334745777, 615693474, 1132436852, 2082876103, 3831006429, 7046319384, 12960201916, 23837527729, 43844049029, 80641778674, 148323355432, 272809183135, 501774317241, 922906855808, 1697490356184, 3122171529233, 5742568741225, 10562230626642, 19426970897100, 35731770264967, 65720971788709, 120879712950776, 222332455004452, 408933139743937, 752145307699165, 1383410902447554, 2544489349890656, 4680045560037375, 8607945812375585];

var FLOAT64_MAX_SAFE_NTH_TRIBONACCI = 63 | 0;
var lib_default443 = FLOAT64_MAX_SAFE_NTH_TRIBONACCI;

var FLOAT64_MAX_SAFE_NTH_TRIBONACCI2 = lib_default443;
function tribonacci(n) {
  if (lib_default30(n) || !lib_default106(n) || n > FLOAT64_MAX_SAFE_NTH_TRIBONACCI2) {
    return NaN;
  }
  return tribonacci_default[n];
}
var main_default371 = tribonacci;

var lib_default444 = main_default371;

var tribonaccif_default = [0, 0, 1, 1, 2, 4, 7, 13, 24, 44, 81, 149, 274, 504, 927, 1705, 3136, 5768, 10609, 19513, 35890, 66012, 121415, 223317, 410744, 755476, 1389537, 2555757, 4700770, 8646064, 15902591];

var FLOAT32_MAX_SAFE_NTH_TRIBONACCI = 30 | 0;
var lib_default445 = FLOAT32_MAX_SAFE_NTH_TRIBONACCI;

var FLOAT32_MAX_SAFE_NTH_TRIBONACCI2 = lib_default445;
function tribonaccif(n) {
  if (lib_default6(n) || !lib_default111(n) || n > FLOAT32_MAX_SAFE_NTH_TRIBONACCI2) {
    return NaN;
  }
  return tribonaccif_default[n];
}
var main_default372 = tribonaccif;

var lib_default446 = main_default372;

var FLOAT32_PI_SQUARED = lib_default3(9.869604401089358);
var lib_default447 = FLOAT32_PI_SQUARED;

function evalrational71(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -1.109328031539917;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = lib_default3(-1.109328031539917 + lib_default3(x * lib_default3(-3.8310675621032715 + lib_default3(x * lib_default3(-3.370384931564331 + lib_default3(x * lib_default3(0.2808057367801666 + lib_default3(x * lib_default3(1.6638069152832031 + lib_default3(x * 0.6446838974952698))))))))));
    s2 = lib_default3(1 + lib_default3(x * lib_default3(3.4535388946533203 + lib_default3(x * lib_default3(4.52089262008667 + lib_default3(x * lib_default3(2.7012734413146973 + lib_default3(x * lib_default3(0.6446880102157593 + lib_default3(x * -2031451629136427e-22))))))))));
  } else {
    x = lib_default3(1 / x);
    s1 = lib_default3(0.6446838974952698 + lib_default3(x * lib_default3(1.6638069152832031 + lib_default3(x * lib_default3(0.2808057367801666 + lib_default3(x * lib_default3(-3.370384931564331 + lib_default3(x * lib_default3(-3.8310675621032715 + lib_default3(x * -1.109328031539917))))))))));
    s2 = lib_default3(-2031451629136427e-22 + lib_default3(x * lib_default3(0.6446880102157593 + lib_default3(x * lib_default3(2.7012734413146973 + lib_default3(x * lib_default3(4.52089262008667 + lib_default3(x * lib_default3(3.4535388946533203 + lib_default3(x * 1))))))))));
  }
  return lib_default3(s1 / s2);
}
var rational_p12q12_default2 = evalrational71;

function evalrational72(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return -13803835408054965e-24;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = lib_default3(-13803835408054965e-24 + lib_default3(x * lib_default3(0.5000004768371582 + lib_default3(x * lib_default3(1.6077979803085327 + lib_default3(x * lib_default3(2.5645434856414795 + lib_default3(x * lib_default3(2.0534873008728027 + lib_default3(x * 0.7456697821617126))))))))));
    s2 = lib_default3(1 + lib_default3(x * lib_default3(2.8822786808013916 + lib_default3(x * lib_default3(4.168166160583496 + lib_default3(x * lib_default3(2.7853527069091797 + lib_default3(x * lib_default3(0.7496767044067383 + lib_default3(x * -5706911324523389e-19))))))))));
  } else {
    x = lib_default3(1 / x);
    s1 = lib_default3(0.7456697821617126 + lib_default3(x * lib_default3(2.0534873008728027 + lib_default3(x * lib_default3(2.5645434856414795 + lib_default3(x * lib_default3(1.6077979803085327 + lib_default3(x * lib_default3(0.5000004768371582 + lib_default3(x * -13803835408054965e-24))))))))));
    s2 = lib_default3(-5706911324523389e-19 + lib_default3(x * lib_default3(0.7496767044067383 + lib_default3(x * lib_default3(2.7853527069091797 + lib_default3(x * lib_default3(4.168166160583496 + lib_default3(x * lib_default3(2.8822786808013916 + lib_default3(x * 1))))))))));
  }
  return lib_default3(s1 / s2);
}
var rational_p24q24_default2 = evalrational72;

function evalrational73(x) {
  var ax;
  var s1;
  var s2;
  if (x === 0) {
    return 68947580279632365e-34;
  }
  if (x < 0) {
    ax = -x;
  } else {
    ax = x;
  }
  if (ax <= 1) {
    s1 = lib_default3(68947580279632365e-34 + lib_default3(x * lib_default3(0.5 + lib_default3(x * lib_default3(1.0177274942398071 + lib_default3(x * lib_default3(2.498208522796631 + lib_default3(x * lib_default3(2.192122220993042 + lib_default3(x * lib_default3(1.5897035598754883 + lib_default3(x * 0.40154388546943665))))))))))));
    s2 = lib_default3(1 + lib_default3(x * lib_default3(1.7021214962005615 + lib_default3(x * lib_default3(4.429043292999268 + lib_default3(x * lib_default3(2.9745631217956543 + lib_default3(x * lib_default3(2.301361560821533 + lib_default3(x * lib_default3(0.2836039960384369 + lib_default3(x * 0.022892987355589867))))))))))));
  } else {
    x = lib_default3(1 / x);
    s1 = lib_default3(0.40154388546943665 + lib_default3(x * lib_default3(1.5897035598754883 + lib_default3(x * lib_default3(2.192122220993042 + lib_default3(x * lib_default3(2.498208522796631 + lib_default3(x * lib_default3(1.0177274942398071 + lib_default3(x * lib_default3(0.5 + lib_default3(x * 68947580279632365e-34))))))))))));
    s2 = lib_default3(0.022892987355589867 + lib_default3(x * lib_default3(0.2836039960384369 + lib_default3(x * lib_default3(2.301361560821533 + lib_default3(x * lib_default3(2.9745631217956543 + lib_default3(x * lib_default3(4.429043292999268 + lib_default3(x * lib_default3(1.7021214962005615 + lib_default3(x * 1))))))))))));
  }
  return lib_default3(s1 / s2);
}
var rational_p4infq4inf_default = evalrational73;

var YOFFSET12 = lib_default3(2.109325408935547);
var ZERO24 = lib_default3(0);
var ONE28 = lib_default3(1);
var TWO15 = lib_default3(2);
var FOUR3 = lib_default3(4);
function trigammaf(x) {
  var result;
  var s;
  var y;
  var z;
  x = lib_default3(x);
  result = ZERO24;
  if (x <= ZERO24) {
    if (lib_default16(x) === x) {
      return NaN;
    }
    z = lib_default3(ONE28 - x);
    if (z < ONE28) {
      result = lib_default3(ONE28 / lib_default3(z * z));
      z = lib_default3(ONE28 + z);
    }
    s = lib_default5(x) < lib_default5(z) ? lib_default27(x) : lib_default27(z);
    return lib_default3(lib_default3(result - trigammaf(z)) + lib_default3(lib_default447 / lib_default3(s * s)));
  }
  if (x < ONE28) {
    result = lib_default3(ONE28 / lib_default3(x * x));
    x = lib_default3(x + ONE28);
  }
  if (x <= TWO15) {
    result = lib_default3(result + lib_default3(lib_default3(YOFFSET12 + rational_p12q12_default2(x)) / lib_default3(x * x)));
  } else if (x <= FOUR3) {
    y = lib_default3(ONE28 / x);
    result = lib_default3(result + lib_default3(lib_default3(ONE28 + rational_p24q24_default2(y)) / x));
  } else {
    y = lib_default3(ONE28 / x);
    result = lib_default3(result + lib_default3(lib_default3(ONE28 + rational_p4infq4inf_default(y)) / x));
  }
  return result;
}
var main_default373 = trigammaf;

var lib_default448 = main_default373;

function trunc10(x) {
  var sign;
  if (lib_default30(x) || lib_default76(x) || x === 0) {
    return x;
  }
  if (x < 0) {
    x = -x;
    sign = -1;
  } else {
    sign = 1;
  }
  return sign * lib_default142(10, lib_default105(lib_default214(x)));
}
var main_default374 = trunc10;

var lib_default449 = main_default374;

function trunc2(x) {
  var sign;
  if (lib_default30(x) || lib_default76(x) || x === 0) {
    return x;
  }
  if (x < 0) {
    x = -x;
    sign = -1;
  } else {
    sign = 1;
  }
  return sign * lib_default142(2, lib_default105(lib_default218(x)));
}
var main_default375 = trunc2;

var lib_default450 = main_default375;

var MAX_INT6 = lib_default185 + 1;
var HUGE15 = 1e308;
function truncn(x, n) {
  var s;
  var y;
  if (lib_default30(x) || lib_default30(n) || lib_default76(n)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0 || n < lib_default216 || lib_default(x) > MAX_INT6 && n <= 0) {
    return x;
  }
  if (n > lib_default215) {
    return 0 * x;
  }
  if (n < lib_default220) {
    s = lib_default142(10, -(n + lib_default215));
    y = x * HUGE15 * s;
    if (lib_default76(y)) {
      return x;
    }
    return lib_default137(y) / HUGE15 / s;
  }
  s = lib_default142(10, -n);
  y = x * s;
  if (lib_default76(y)) {
    return x;
  }
  return lib_default137(y) / s;
}
var main_default376 = truncn;

var lib_default451 = main_default376;

function truncb(x, n, b) {
  var y;
  var s;
  if (lib_default30(x) || lib_default30(n) || lib_default30(b) || b <= 0 || lib_default76(n) || lib_default76(b)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0) {
    return x;
  }
  if (b === 10) {
    return lib_default451(x, n);
  }
  if (n === 0 || b === 1) {
    return lib_default137(x);
  }
  s = lib_default142(b, -n);
  if (lib_default76(s)) {
    return x;
  }
  y = lib_default137(x * s) / s;
  if (lib_default76(y)) {
    return x;
  }
  return y;
}
var main_default377 = truncb;

var lib_default452 = main_default377;

function truncsd(x, n, b) {
  var exp3;
  var s;
  var y;
  if (lib_default30(x) || lib_default30(n) || n < 1 || lib_default76(n) || lib_default30(b) || b <= 0 || lib_default76(b)) {
    return NaN;
  }
  if (lib_default76(x) || x === 0) {
    return x;
  }
  if (b === 10) {
    exp3 = lib_default214(lib_default(x));
  } else if (b === 2) {
    exp3 = lib_default122(lib_default(x));
  } else {
    exp3 = lib_default48(lib_default(x)) / lib_default48(b);
  }
  exp3 = lib_default105(exp3 - n + 1);
  s = lib_default142(b, lib_default(exp3));
  if (lib_default76(s)) {
    return x;
  }
  if (exp3 < 0) {
    y = lib_default137(x * s) / s;
  } else {
    y = lib_default137(x / s) * s;
  }
  if (lib_default76(y)) {
    return x;
  }
  return y;
}
var main_default378 = truncsd;

var lib_default453 = main_default378;

function vercos(x) {
  return 1 + lib_default165(x);
}
var main_default379 = vercos;

var lib_default454 = main_default379;

var ONE29 = lib_default3(1);
function vercosf(x) {
  return lib_default3(ONE29 + lib_default235(x));
}
var main_default380 = vercosf;

var lib_default455 = main_default380;

function versin(x) {
  return 1 - lib_default165(x);
}
var main_default381 = versin;

var lib_default456 = main_default381;

var ONE30 = lib_default3(1);
function versinf(x) {
  return lib_default3(ONE30 - lib_default235(x));
}
var main_default382 = versinf;

var lib_default457 = main_default382;

function wrap3(v3, min3, max3) {
  var delta;
  if (lib_default30(v3) || lib_default30(min3) || lib_default30(max3) || max3 <= min3) {
    return NaN;
  }
  if (v3 === 0) {
    v3 = 0;
  }
  if (min3 === 0) {
    min3 = 0;
  }
  if (max3 === 0) {
    max3 = 0;
  }
  if (min3 <= v3 && v3 < max3) {
    return v3;
  }
  delta = max3 - min3;
  if (v3 < min3) {
    v3 += delta * (lib_default137((min3 - v3) / delta) + 1);
  }
  return min3 + (v3 - min3) % delta;
}
var main_default383 = wrap3;

var lib_default458 = main_default383;

var ZERO25 = lib_default3(0);
var ONE31 = lib_default3(1);
function wrapf(v3, min3, max3) {
  var delta;
  v3 = lib_default3(v3);
  min3 = lib_default3(min3);
  max3 = lib_default3(max3);
  if (lib_default6(v3) || lib_default6(min3) || lib_default6(max3) || max3 <= min3) {
    return NaN;
  }
  if (v3 === 0) {
    v3 = ZERO25;
  }
  if (min3 === 0) {
    min3 = ZERO25;
  }
  if (max3 === 0) {
    max3 = ZERO25;
  }
  if (min3 <= v3 && v3 < max3) {
    return v3;
  }
  delta = lib_default3(max3 - min3);
  if (v3 < min3) {
    v3 = lib_default3(v3 + lib_default3(delta * lib_default3(lib_default18(lib_default3(lib_default3(min3 - v3) / delta)) + ONE31)));
  }
  return lib_default3(min3 + lib_default3(lib_default3(v3 - min3) % delta));
}
var main_default384 = wrapf;

var lib_default459 = main_default384;

function xlog1py(x, y) {
  if (x === 0 && !lib_default30(y)) {
    return 0;
  }
  return x * lib_default46(y);
}
var main_default385 = xlog1py;

var lib_default460 = main_default385;

function xlogy(x, y) {
  if (x === 0 && !lib_default30(y)) {
    return 0;
  }
  return x * lib_default48(y);
}
var main_default386 = xlogy;

var lib_default461 = main_default386;

function xlogyf(x, y) {
  if (x === 0 && !lib_default6(y)) {
    return 0;
  }
  return lib_default3(lib_default3(x) * lib_default15(lib_default3(y)));
}
var main_default387 = xlogyf;

var lib_default462 = main_default387;

const N_FN = 339
const N_EVAL = 1 << 12
const N_RUNS = 21
const N_WARMUP = 5

// special/abs
const k0 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default(0.05 + u[i] * (0.95 - 0.05)) }
// special/abs2
const k1 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default2(0.05 + u[i] * (0.95 - 0.05)) }
// special/abs2f
const k2 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default4(0.05 + u[i] * (0.95 - 0.05)) }
// special/absf
const k3 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default5(0.05 + u[i] * (0.95 - 0.05)) }
// special/absgammalnf
const k4 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default29(0.05 + u[i] * (0.95 - 0.05)) }
// special/acos
const k5 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default34(0.05 + u[i] * (0.95 - 0.05)) }
// special/acosd
const k6 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default36(0.05 + u[i] * (0.95 - 0.05)) }
// special/acosdf
const k7 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default40(0.05 + u[i] * (0.95 - 0.05)) }
// special/acosf
const k8 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default39(0.05 + u[i] * (0.95 - 0.05)) }
// special/acosh
const k9 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default49(1.5 + u[i] * (20 - 1.5)) }
// special/acoshf
const k10 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default53(1.5 + u[i] * (20 - 1.5)) }
// special/acot
const k11 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default56(0.05 + u[i] * (0.95 - 0.05)) }
// special/acotd
const k12 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default57(0.05 + u[i] * (0.95 - 0.05)) }
// special/acotdf
const k13 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default62(0.05 + u[i] * (0.95 - 0.05)) }
// special/acotf
const k14 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default61(0.05 + u[i] * (0.95 - 0.05)) }
// special/acoth
const k15 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default64(1.5 + u[i] * (20 - 1.5)) }
// special/acothf
const k16 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default66(1.5 + u[i] * (20 - 1.5)) }
// special/acovercos
const k17 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default67(0.05 + u[i] * (0.95 - 0.05)) }
// special/acovercosf
const k18 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default69(0.05 + u[i] * (0.95 - 0.05)) }
// special/acoversin
const k19 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default70(0.05 + u[i] * (0.95 - 0.05)) }
// special/acoversinf
const k20 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default71(0.05 + u[i] * (0.95 - 0.05)) }
// special/acsc
const k21 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default72(1.5 + u[i] * (20 - 1.5)) }
// special/acscd
const k22 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default73(1.5 + u[i] * (20 - 1.5)) }
// special/acscdf
const k23 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default75(1.5 + u[i] * (20 - 1.5)) }
// special/acscf
const k24 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default74(1.5 + u[i] * (20 - 1.5)) }
// special/acsch
const k25 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default78(0.05 + u[i] * (0.95 - 0.05)) }
// special/ahavercos
const k26 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default79(0.05 + u[i] * (0.95 - 0.05)) }
// special/ahavercosf
const k27 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default80(0.05 + u[i] * (0.95 - 0.05)) }
// special/ahaversin
const k28 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default81(0.05 + u[i] * (0.95 - 0.05)) }
// special/ahaversinf
const k29 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default82(0.05 + u[i] * (0.95 - 0.05)) }
// special/asec
const k30 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default83(1.5 + u[i] * (20 - 1.5)) }
// special/asecd
const k31 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default84(1.5 + u[i] * (20 - 1.5)) }
// special/asecdf
const k32 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default86(1.5 + u[i] * (20 - 1.5)) }
// special/asecf
const k33 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default85(1.5 + u[i] * (20 - 1.5)) }
// special/asech
const k34 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default87(0.05 + u[i] * (0.95 - 0.05)) }
// special/asin
const k35 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default33(0.05 + u[i] * (0.95 - 0.05)) }
// special/asind
const k36 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default88(0.05 + u[i] * (0.95 - 0.05)) }
// special/asindf
const k37 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default89(0.05 + u[i] * (0.95 - 0.05)) }
// special/asinf
const k38 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default68(0.05 + u[i] * (0.95 - 0.05)) }
// special/asinh
const k39 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default77(0.05 + u[i] * (0.95 - 0.05)) }
// special/asinhf
const k40 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default90(0.05 + u[i] * (0.95 - 0.05)) }
// special/atan
const k41 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default55(0.05 + u[i] * (0.95 - 0.05)) }
// special/atan2
const k42 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default97(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/atan2d
const k43 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default98(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/atan2f
const k44 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default100(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/atand
const k45 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default101(0.05 + u[i] * (0.95 - 0.05)) }
// special/atandf
const k46 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default102(0.05 + u[i] * (0.95 - 0.05)) }
// special/atanf
const k47 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default60(0.05 + u[i] * (0.95 - 0.05)) }
// special/atanh
const k48 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default63(0.05 + u[i] * (0.95 - 0.05)) }
// special/atanhf
const k49 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default65(0.05 + u[i] * (0.95 - 0.05)) }
// special/aversin
const k50 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default103(0.05 + u[i] * (0.95 - 0.05)) }
// special/aversinf
const k51 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default104(0.05 + u[i] * (0.95 - 0.05)) }
// special/bernoulli
const k52 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default110(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/bernoullif
const k53 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default115(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/besselj0
const k54 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default131(0.05 + u[i] * (0.95 - 0.05)) }
// special/besselj1
const k55 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default133(0.05 + u[i] * (0.95 - 0.05)) }
// special/bessely0
const k56 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default134(0.05 + u[i] * (0.95 - 0.05)) }
// special/bessely1
const k57 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default135(0.05 + u[i] * (0.95 - 0.05)) }
// special/beta
const k58 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default145(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/betainc
const k59 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default189(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5, 0.5, 2) }
// special/betaincinv
const k60 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default198(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5, 0.5) }
// special/betaln
const k61 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default199(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/binet
const k62 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default202(0.05 + u[i] * (0.95 - 0.05)) }
// special/binomcoef
const k63 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default187(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// special/binomcoeff
const k64 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default205(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// special/binomcoefln
const k65 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default206(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// special/boxcox
const k66 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default207(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/boxcox1p
const k67 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default208(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/boxcox1pinv
const k68 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default209(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/boxcoxinv
const k69 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default210(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/cbrt
const k70 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default211(0.05 + u[i] * (0.95 - 0.05)) }
// special/cbrtf
const k71 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default212(0.05 + u[i] * (0.95 - 0.05)) }
// special/ceil
const k72 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default136(0.05 + u[i] * (0.95 - 0.05)) }
// special/ceil10
const k73 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default217(0.05 + u[i] * (0.95 - 0.05)) }
// special/ceil2
const k74 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default219(0.05 + u[i] * (0.95 - 0.05)) }
// special/ceilb
const k75 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default222(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/ceilf
const k76 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default17(0.05 + u[i] * (0.95 - 0.05)) }
// special/ceiln
const k77 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default221(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/ceilsd
const k78 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default223(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/clamp
const k79 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default224(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/clampf
const k80 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default226(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/copysign
const k81 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default95(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/copysignf
const k82 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default23(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/cos
const k83 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default165(0.05 + u[i] * (0.95 - 0.05)) }
// special/cosd
const k84 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default229(0.05 + u[i] * (0.95 - 0.05)) }
// special/cosdf
const k85 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default232(0.05 + u[i] * (0.95 - 0.05)) }
// special/cosf
const k86 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default235(0.05 + u[i] * (0.95 - 0.05)) }
// special/cosh
const k87 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default236(0.05 + u[i] * (0.95 - 0.05)) }
// special/coshf
const k88 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default238(0.05 + u[i] * (0.95 - 0.05)) }
// special/cosm1
const k89 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default239(0.05 + u[i] * (0.95 - 0.05)) }
// special/cosm1f
const k90 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default240(0.05 + u[i] * (0.95 - 0.05)) }
// special/cospi
const k91 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default200(0.05 + u[i] * (0.95 - 0.05)) }
// special/cospif
const k92 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default241(0.05 + u[i] * (0.95 - 0.05)) }
// special/cot
const k93 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default244(0.05 + u[i] * (0.95 - 0.05)) }
// special/cotd
const k94 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default246(0.05 + u[i] * (0.95 - 0.05)) }
// special/cotdf
const k95 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default249(0.05 + u[i] * (0.95 - 0.05)) }
// special/cotf
const k96 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default252(0.05 + u[i] * (0.95 - 0.05)) }
// special/coth
const k97 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default254(0.05 + u[i] * (0.95 - 0.05)) }
// special/covercos
const k98 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default255(0.05 + u[i] * (0.95 - 0.05)) }
// special/covercosf
const k99 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default257(0.05 + u[i] * (0.95 - 0.05)) }
// special/coversin
const k100 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default258(0.05 + u[i] * (0.95 - 0.05)) }
// special/coversinf
const k101 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default259(0.05 + u[i] * (0.95 - 0.05)) }
// special/csc
const k102 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default260(0.05 + u[i] * (0.95 - 0.05)) }
// special/cscd
const k103 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default261(0.05 + u[i] * (0.95 - 0.05)) }
// special/cscdf
const k104 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default262(0.05 + u[i] * (0.95 - 0.05)) }
// special/cscf
const k105 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default263(0.05 + u[i] * (0.95 - 0.05)) }
// special/csch
const k106 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default265(0.05 + u[i] * (0.95 - 0.05)) }
// special/deg2rad
const k107 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default227(0.05 + u[i] * (0.95 - 0.05)) }
// special/deg2radf
const k108 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default230(0.05 + u[i] * (0.95 - 0.05)) }
// special/digamma
const k109 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default266(0.05 + u[i] * (0.95 - 0.05)) }
// special/dirac-delta
const k110 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default267(0.05 + u[i] * (0.95 - 0.05)) }
// special/dirac-deltaf
const k111 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default268(0.05 + u[i] * (0.95 - 0.05)) }
// special/dirichlet-eta
const k112 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default270(0.05 + u[i] * (0.95 - 0.05)) }
// special/ellipe
const k113 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default272(0.05 + u[i] * (0.95 - 0.05)) }
// special/ellipj
const k114 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default273(0.05 + u[i] * (0.95 - 0.05), 0.5); out[at + i] = r[0] + r[1] + r[2] + r[3] } }
// special/ellipk
const k115 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default271(0.05 + u[i] * (0.95 - 0.05)) }
// special/erf
const k116 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default274(0.05 + u[i] * (0.95 - 0.05)) }
// special/erfc
const k117 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default171(0.05 + u[i] * (0.95 - 0.05)) }
// special/erfcinv
const k118 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default190(0.05 + u[i] * (0.95 - 0.05)) }
// special/erfcx
const k119 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default275(0.05 + u[i] * (0.95 - 0.05)) }
// special/erfinv
const k120 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default276(0.05 + u[i] * (0.95 - 0.05)) }
// special/exp
const k121 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default138(0.05 + u[i] * (0.95 - 0.05)) }
// special/exp10
const k122 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default277(0.05 + u[i] * (0.95 - 0.05)) }
// special/exp2
const k123 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default279(0.05 + u[i] * (0.95 - 0.05)) }
// special/expit
const k124 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default280(0.05 + u[i] * (0.95 - 0.05)) }
// special/expm1
const k125 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default147(0.05 + u[i] * (0.95 - 0.05)) }
// special/expm1rel
const k126 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default281(0.05 + u[i] * (0.95 - 0.05)) }
// special/factorial
const k127 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default161(0.05 + u[i] * (0.95 - 0.05)) }
// special/factorial2
const k128 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default283(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/factorial2f
const k129 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default285(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/factorialln
const k130 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default287(0.05 + u[i] * (0.95 - 0.05)) }
// special/factoriallnf
const k131 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default289(0.05 + u[i] * (0.95 - 0.05)) }
// special/falling-factorial
const k132 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default290(0.05 + u[i] * (0.95 - 0.05), 3) }
// special/fast/abs
const k133 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default291(0.05 + u[i] * (0.95 - 0.05)) }
// special/fast/absf
const k134 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default292(0.05 + u[i] * (0.95 - 0.05)) }
// special/fast/acosh
const k135 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default293(1.5 + u[i] * (20 - 1.5)) }
// special/fast/alpha-max-plus-beta-min
const k136 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default295(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fast/asinh
const k137 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default296(0.05 + u[i] * (0.95 - 0.05)) }
// special/fast/atanh
const k138 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default297(0.05 + u[i] * (0.95 - 0.05)) }
// special/fast/atanhf
const k139 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default298(0.05 + u[i] * (0.95 - 0.05)) }
// special/fast/hypot
const k140 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default299(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fast/hypotf
const k141 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default300(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fast/max
const k142 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default301(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fast/maxf
const k143 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default302(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fast/min
const k144 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default303(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fast/minf
const k145 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default304(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fast/pow-int
const k146 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default305(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fast/uint32-log2
const k147 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default306(0.05 + u[i] * (0.95 - 0.05)) }
// special/fast/uint32-sqrt
const k148 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default307(0.05 + u[i] * (0.95 - 0.05)) }
// special/fibonacci
const k149 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default309(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/fibonacci-index
const k150 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default310(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/fibonacci-indexf
const k151 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default312(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/fibonaccif
const k152 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default314(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/flipsign
const k153 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default315(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/flipsignf
const k154 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default316(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/floor
const k155 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default105(0.05 + u[i] * (0.95 - 0.05)) }
// special/floor10
const k156 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default317(0.05 + u[i] * (0.95 - 0.05)) }
// special/floor2
const k157 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default318(0.05 + u[i] * (0.95 - 0.05)) }
// special/floor2f
const k158 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default323(0.05 + u[i] * (0.95 - 0.05)) }
// special/floorb
const k159 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default325(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/floorf
const k160 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default16(0.05 + u[i] * (0.95 - 0.05)) }
// special/floorn
const k161 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default324(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/floornf
const k162 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default329(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/floorsd
const k163 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default330(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/fmod
const k164 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default228(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fmodf
const k165 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default231(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/fresnel
const k166 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default331(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/fresnelc
const k167 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default332(0.05 + u[i] * (0.95 - 0.05)) }
// special/fresnels
const k168 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default333(0.05 + u[i] * (0.95 - 0.05)) }
// special/frexp
const k169 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default334(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/frexpf
const k170 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default337(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/gamma
const k171 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default159(0.05 + u[i] * (0.95 - 0.05)) }
// special/gamma-delta-ratio
const k172 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default164(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/gamma-lanczos-sum
const k173 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default162(0.05 + u[i] * (0.95 - 0.05)) }
// special/gamma-lanczos-sum-expg-scaled
const k174 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default177(0.05 + u[i] * (0.95 - 0.05)) }
// special/gamma-lanczos-sum-expg-scaledf
const k175 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default338(0.05 + u[i] * (0.95 - 0.05)) }
// special/gamma1pm1
const k176 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default179(0.05 + u[i] * (0.95 - 0.05)) }
// special/gammainc
const k177 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default182(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5, 0.5) }
// special/gammaincinv
const k178 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default195(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/gammaln
const k179 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default167(0.05 + u[i] * (0.95 - 0.05)) }
// special/gammasgn
const k180 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default339(0.05 + u[i] * (0.95 - 0.05)) }
// special/gammasgnf
const k181 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default340(0.05 + u[i] * (0.95 - 0.05)) }
// special/gcd
const k182 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default186(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// special/gcdf
const k183 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default204(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// special/hacovercos
const k184 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default341(0.05 + u[i] * (0.95 - 0.05)) }
// special/hacovercosf
const k185 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default342(0.05 + u[i] * (0.95 - 0.05)) }
// special/hacoversin
const k186 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default343(0.05 + u[i] * (0.95 - 0.05)) }
// special/hacoversinf
const k187 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default344(0.05 + u[i] * (0.95 - 0.05)) }
// special/havercos
const k188 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default345(0.05 + u[i] * (0.95 - 0.05)) }
// special/havercosf
const k189 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default346(0.05 + u[i] * (0.95 - 0.05)) }
// special/haversin
const k190 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default347(0.05 + u[i] * (0.95 - 0.05)) }
// special/haversinf
const k191 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default348(0.05 + u[i] * (0.95 - 0.05)) }
// special/heaviside
const k192 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default349(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/heavisidef
const k193 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default350(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/hyp2f1
const k194 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default356(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5, 0.5) }
// special/hypot
const k195 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default357(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/hypotf
const k196 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default358(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/inv
const k197 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default359(0.05 + u[i] * (0.95 - 0.05)) }
// special/invf
const k198 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default360(0.05 + u[i] * (0.95 - 0.05)) }
// special/kernel-betainc
const k199 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default188(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5, 0.5, 2); out[at + i] = r[0] + r[1] } }
// special/kernel-betaincinv
const k200 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default197(0.05 + u[i] * (0.95 - 0.05), 0.5, 0.25, 2); out[at + i] = r[0] + r[1] } }
// special/kernel-cos
const k201 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default154(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/kernel-cosf
const k202 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default19(0.05 + u[i] * (0.95 - 0.05)) }
// special/kernel-log1p
const k203 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default213(0.05 + u[i] * (0.95 - 0.05)) }
// special/kernel-log1pf
const k204 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default361(0.05 + u[i] * (0.95 - 0.05)) }
// special/kernel-sin
const k205 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default155(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/kernel-sincosf
const k206 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default362(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/kernel-sinf
const k207 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default20(0.05 + u[i] * (0.95 - 0.05)) }
// special/kernel-tan
const k208 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default242(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/kernel-tanf
const k209 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default250(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/kronecker-delta
const k210 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default363(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/kronecker-deltaf
const k211 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default364(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/labs
const k212 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default294(0.05 + u[i] * (0.95 - 0.05)) }
// special/lcm
const k213 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default365(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// special/lcmf
const k214 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default366(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// special/ldexp
const k215 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default125(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/ldexpf
const k216 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default319(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/ln
const k217 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default48(0.05 + u[i] * (0.95 - 0.05)) }
// special/lnf
const k218 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default15(0.05 + u[i] * (0.95 - 0.05)) }
// special/log
const k219 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default367(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/log10
const k220 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default214(0.05 + u[i] * (0.95 - 0.05)) }
// special/log1mexp
const k221 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default368(0.05 + u[i] * (0.95 - 0.05)) }
// special/log1p
const k222 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default46(0.05 + u[i] * (0.95 - 0.05)) }
// special/log1pexp
const k223 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default369(0.05 + u[i] * (0.95 - 0.05)) }
// special/log1pf
const k224 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default51(0.05 + u[i] * (0.95 - 0.05)) }
// special/log1pmx
const k225 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default175(0.05 + u[i] * (0.95 - 0.05)) }
// special/log2
const k226 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default218(0.05 + u[i] * (0.95 - 0.05)) }
// special/logaddexp
const k227 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default370(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/logf
const k228 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default371(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/logit
const k229 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default373(0.05 + u[i] * (0.95 - 0.05)) }
// special/logitf
const k230 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default375(0.05 + u[i] * (0.95 - 0.05)) }
// special/lucas
const k231 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default377(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/lucasf
const k232 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default379(Math.floor(1 + u[i] * (24 - 1 + 1))) }
// special/max
const k233 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default149(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/maxabs
const k234 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default183(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/maxabsf
const k235 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default382(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/maxabsn
const k236 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default384(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/maxf
const k237 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default381(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/maxn
const k238 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default383(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/min
const k239 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default151(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/minabs
const k240 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default184(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/minabsf
const k241 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default386(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/minabsn
const k242 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default388(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/minf
const k243 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default385(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/minmax
const k244 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default389(0.05 + u[i] * (0.95 - 0.05), 2.5); out[at + i] = r[0] + r[1] } }
// special/minmaxabs
const k245 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default390(0.05 + u[i] * (0.95 - 0.05), 2.5); out[at + i] = r[0] + r[1] } }
// special/minmaxabsf
const k246 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default391(0.05 + u[i] * (0.95 - 0.05), 2.5); out[at + i] = r[0] + r[1] } }
// special/minmaxf
const k247 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default392(0.05 + u[i] * (0.95 - 0.05), 2.5); out[at + i] = r[0] + r[1] } }
// special/minn
const k248 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default387(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/modf
const k249 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default393(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/modff
const k250 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default394(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/nanmax
const k251 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default395(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/nanmaxf
const k252 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default396(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/nanmin
const k253 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default397(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/nanminf
const k254 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default398(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/negafibonacci
const k255 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default399(Math.floor(-40 + u[i] * (0 - -40 + 1))) }
// special/negafibonaccif
const k256 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default400(Math.floor(-40 + u[i] * (0 - -40 + 1))) }
// special/negalucas
const k257 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default401(Math.floor(-40 + u[i] * (0 - -40 + 1))) }
// special/nonfibonacci
const k258 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default402(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/nonfibonaccif
const k259 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default403(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/pdiff
const k260 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default404(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/pdifff
const k261 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default405(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/polygamma
const k262 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default409(Math.floor(0 + u[i] * (40 - 0 + 1)), 3) }
// special/pow
const k263 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default142(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/powf
const k264 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default320(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/powm1
const k265 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default178(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/rad2deg
const k266 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default35(0.05 + u[i] * (0.95 - 0.05)) }
// special/rad2degf
const k267 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default37(0.05 + u[i] * (0.95 - 0.05)) }
// special/ramp
const k268 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default410(0.05 + u[i] * (0.95 - 0.05)) }
// special/rampf
const k269 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default411(0.05 + u[i] * (0.95 - 0.05)) }
// special/rcbrt
const k270 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default412(0.05 + u[i] * (0.95 - 0.05)) }
// special/rcbrtf
const k271 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default413(0.05 + u[i] * (0.95 - 0.05)) }
// special/riemann-zeta
const k272 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default269(0.05 + u[i] * (0.95 - 0.05)) }
// special/rising-factorial
const k273 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default414(0.05 + u[i] * (0.95 - 0.05), 3) }
// special/round
const k274 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default128(0.05 + u[i] * (0.95 - 0.05)) }
// special/round-nearest-even
const k275 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default415(0.05 + u[i] * (0.95 - 0.05)) }
// special/round10
const k276 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default416(0.05 + u[i] * (0.95 - 0.05)) }
// special/round2
const k277 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default417(0.05 + u[i] * (0.95 - 0.05)) }
// special/roundb
const k278 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default419(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/roundf
const k279 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default233(0.05 + u[i] * (0.95 - 0.05)) }
// special/roundn
const k280 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default418(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/roundnf
const k281 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default420(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/roundsd
const k282 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default421(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/rsqrt
const k283 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default422(0.05 + u[i] * (0.95 - 0.05)) }
// special/rsqrtf
const k284 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default423(0.05 + u[i] * (0.95 - 0.05)) }
// special/sec
const k285 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default424(0.05 + u[i] * (0.95 - 0.05)) }
// special/secd
const k286 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default425(0.05 + u[i] * (0.95 - 0.05)) }
// special/secdf
const k287 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default426(0.05 + u[i] * (0.95 - 0.05)) }
// special/secf
const k288 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default427(0.05 + u[i] * (0.95 - 0.05)) }
// special/sech
const k289 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default428(0.05 + u[i] * (0.95 - 0.05)) }
// special/sici
const k290 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default429(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/signum
const k291 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default192(0.05 + u[i] * (0.95 - 0.05)) }
// special/signumf
const k292 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default247(0.05 + u[i] * (0.95 - 0.05)) }
// special/sin
const k293 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default156(0.05 + u[i] * (0.95 - 0.05)) }
// special/sinc
const k294 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default430(0.05 + u[i] * (0.95 - 0.05)) }
// special/sincf
const k295 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default431(0.05 + u[i] * (0.95 - 0.05)) }
// special/sincos
const k296 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default130(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/sincosd
const k297 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default432(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/sincosdf
const k298 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default433(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/sincosf
const k299 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default434(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/sincospi
const k300 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) { const r = lib_default435(0.05 + u[i] * (0.95 - 0.05)); out[at + i] = r[0] + r[1] } }
// special/sind
const k301 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default245(0.05 + u[i] * (0.95 - 0.05)) }
// special/sindf
const k302 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default248(0.05 + u[i] * (0.95 - 0.05)) }
// special/sinf
const k303 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default256(0.05 + u[i] * (0.95 - 0.05)) }
// special/sinh
const k304 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default264(0.05 + u[i] * (0.95 - 0.05)) }
// special/sinpi
const k305 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default166(0.05 + u[i] * (0.95 - 0.05)) }
// special/sinpif
const k306 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default27(0.05 + u[i] * (0.95 - 0.05)) }
// special/spence
const k307 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default436(0.05 + u[i] * (0.95 - 0.05)) }
// special/spencef
const k308 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default437(0.05 + u[i] * (0.95 - 0.05)) }
// special/sqrt
const k309 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default31(0.05 + u[i] * (0.95 - 0.05)) }
// special/sqrt1pm1
const k310 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default438(0.05 + u[i] * (0.95 - 0.05)) }
// special/sqrtf
const k311 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default38(0.05 + u[i] * (0.95 - 0.05)) }
// special/sqrtpi
const k312 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default439(0.05 + u[i] * (0.95 - 0.05)) }
// special/sqrtpif
const k313 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default440(0.05 + u[i] * (0.95 - 0.05)) }
// special/tan
const k314 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default243(0.05 + u[i] * (0.95 - 0.05)) }
// special/tand
const k315 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default441(0.05 + u[i] * (0.95 - 0.05)) }
// special/tandf
const k316 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default442(0.05 + u[i] * (0.95 - 0.05)) }
// special/tanf
const k317 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default251(0.05 + u[i] * (0.95 - 0.05)) }
// special/tanh
const k318 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default253(0.05 + u[i] * (0.95 - 0.05)) }
// special/tribonacci
const k319 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default444(Math.floor(0 + u[i] * (40 - 0 + 1))) }
// special/tribonaccif
const k320 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default446(Math.floor(1 + u[i] * (24 - 1 + 1))) }
// special/trigamma
const k321 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default407(0.05 + u[i] * (0.95 - 0.05)) }
// special/trigammaf
const k322 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default448(0.05 + u[i] * (0.95 - 0.05)) }
// special/trunc
const k323 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default137(0.05 + u[i] * (0.95 - 0.05)) }
// special/trunc10
const k324 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default449(0.05 + u[i] * (0.95 - 0.05)) }
// special/trunc2
const k325 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default450(0.05 + u[i] * (0.95 - 0.05)) }
// special/truncb
const k326 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default452(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/truncf
const k327 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default18(0.05 + u[i] * (0.95 - 0.05)) }
// special/truncn
const k328 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default451(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/truncsd
const k329 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default453(0.05 + u[i] * (0.95 - 0.05), 2.5, 1.5) }
// special/vercos
const k330 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default454(0.05 + u[i] * (0.95 - 0.05)) }
// special/vercosf
const k331 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default455(0.05 + u[i] * (0.95 - 0.05)) }
// special/versin
const k332 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default456(0.05 + u[i] * (0.95 - 0.05)) }
// special/versinf
const k333 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default457(0.05 + u[i] * (0.95 - 0.05)) }
// special/wrap
const k334 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default458(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// special/wrapf
const k335 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default459(0.05 + u[i] * (0.95 - 0.05), -1.5, 2.5) }
// special/xlog1py
const k336 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default460(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/xlogy
const k337 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default461(0.05 + u[i] * (0.95 - 0.05), 2.5) }
// special/xlogyf
const k338 = (u, out, at) => { for (let i = 0; i < N_EVAL; i++) out[at + i] = lib_default462(0.05 + u[i] * (0.95 - 0.05), 2.5) }

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

export let main = () => {
  run()
}
