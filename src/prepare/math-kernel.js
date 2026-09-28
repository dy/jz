/**
 * Host-side JS twins of module/math/ieee754.js and module/math.js's pow, so `preEval`
 * (pre-eval.js) folds `Math.sin(1.5)` etc. at COMPILE time to the exact bits the
 * RUNTIME wasm computes, on any host.
 *
 * Both are V8's own Math: src/base/ieee754.cc (fdlibm as V8 adapted it) as Node v25.9.0
 * ships it, transliterated here from the C in its own order (float operations are not
 * associative: a reordering would change the fold). JS's +, -, *, / and Math.sqrt/abs are
 * IEEE binary64 exactly like wasm's f64 ops, so these return what x64 V8 returns. The host
 * `Math` is no reference: arm64 builds of V8 fuse `a*b + c` in the C and differ in the last
 * bit, and other engines use other libraries.
 *
 * Ops that are exact everywhere (sqrt/abs/floor/ceil/trunc, and round/sign/fround/min/max,
 * which jz's WAT reproduces exactly) fold through host Math in pre-eval.js's
 * HOST_EXACT_UNARY; this module holds the ones with an algorithm.
 *
 * @module prepare/math-kernel
 */

import {
  EXP2_TAB, EXP_Q, EXP_L1, EXP_L2, POW_LOG_TAB, POW_LOG_A, POW_LN2HI, POW_LN2LO, polyTree,
  TWO_OVER_PI, PIO2_CHUNKS, INVPIO2, PIO2_1, PIO2_1T, PIO2_2, PIO2_2T, PIO2_3, PIO2_3T,
  KSIN, KCOS, KTAN, PIO4, PIO4LO, ASIN_P, ASIN_Q, PIO2_HI, PIO2_LO, ATAN_HI, ATAN_LO, ATAN_T,
  PI_O_4, PI_O_2, PI_D, PI_LO, LN2_HI, LN2_LO, INVLN2, LN2, EXP_P, EXP_OVER, EXP_UNDER, EXP_E,
  TWOM1000, TWO1023, EXPM1_Q, EXPM1_TWO1023, LG, TWO54, IVLN2HI, IVLN2LO, IVLN10, LOG10_2HI,
  LOG10_2LO, CBRT_B1, CBRT_B2, CBRT_P, SINH_OVER, TWO_M28, LOG_MAXD,
} from '../../module/math/trig-tables.js'

// ---- fdlibm's word access: the two 32-bit halves of a double (little-endian host) ----
const _buf = new ArrayBuffer(8), _f = new Float64Array(_buf), _w = new Int32Array(_buf)
const hiw = (x) => { _f[0] = x; return _w[1] }
const low = (x) => { _f[0] = x; return _w[0] >>> 0 }
const words = (h, l) => { _w[1] = h; _w[0] = l; return _f[0] }
const setLow = (x, l) => { _f[0] = x; _w[0] = l; return _f[0] }
const setHigh = (x, h) => { _f[0] = x; _w[1] = h; return _f[0] }

// ---- argument reduction: __ieee754_rem_pio2 / __kernel_rem_pio2 (prec 2) ----
// Results in RP[0] + RP[1]; returns n.
const RP = new Float64Array(2)
const kf = new Float64Array(20), kq = new Float64Array(20), kfq = new Float64Array(20), kiq = new Int32Array(20)
const TWO24 = 16777216, TWON24 = 5.96046447753906250000e-08
function kernelRemPio2(x, e0, nx) {
  const jk = 4, jp = jk, jx = nx - 1
  let jv = ((e0 - 3) / 24) | 0
  if (jv < 0) jv = 0
  let q0 = e0 - 24 * (jv + 1)
  let j = jv - jx
  for (let i = 0; i <= jx + jk; i++, j++) kf[i] = j < 0 ? 0 : TWO_OVER_PI[j]
  for (let i = 0; i <= jk; i++) { let fw = 0; for (j = 0; j <= jx; j++) fw += x[j] * kf[jx + i - j]; kq[i] = fw }
  let jz = jk, z = 0, n = 0, ih = 0, fw = 0
  for (;;) {
    let i = 0
    for (j = jz, z = kq[jz]; j > 0; i++, j--) {
      fw = (TWON24 * z) | 0
      kiq[i] = (z - TWO24 * fw) | 0
      z = kq[j - 1] + fw
    }
    z = z * 2 ** q0
    z -= 8.0 * Math.floor(z * 0.125)
    n = z | 0
    z -= n
    ih = 0
    if (q0 > 0) {
      i = kiq[jz - 1] >> (24 - q0)
      n += i
      kiq[jz - 1] -= i << (24 - q0)
      ih = kiq[jz - 1] >> (23 - q0)
    } else if (q0 === 0) ih = kiq[jz - 1] >> 23
    else if (z >= 0.5) ih = 2
    if (ih > 0) {
      n += 1
      let carry = 0
      for (i = 0; i < jz; i++) {
        j = kiq[i]
        if (carry === 0) { if (j !== 0) { carry = 1; kiq[i] = 0x1000000 - j } }
        else kiq[i] = 0xFFFFFF - j
      }
      if (q0 === 1) kiq[jz - 1] &= 0x7FFFFF
      else if (q0 === 2) kiq[jz - 1] &= 0x3FFFFF
      if (ih === 2) { z = 1 - z; if (carry !== 0) z -= 2 ** q0 }
    }
    if (z !== 0) break
    j = 0
    for (i = jz - 1; i >= jk; i--) j |= kiq[i]
    if (j !== 0) break
    let k = 1
    while (jk >= k && kiq[jk - k] === 0) k++
    for (i = jz + 1; i <= jz + k; i++) {
      kf[jx + i] = TWO_OVER_PI[jv + i]
      fw = 0
      for (j = 0; j <= jx; j++) fw += x[j] * kf[jx + i - j]
      kq[i] = fw
    }
    jz += k
  }
  if (z === 0) {
    jz -= 1; q0 -= 24
    while (kiq[jz] === 0) { jz--; q0 -= 24 }
  } else {
    z = z * 2 ** -q0
    if (z >= TWO24) {
      fw = (TWON24 * z) | 0
      kiq[jz] = z - TWO24 * fw
      jz += 1; q0 += 24
      kiq[jz] = fw
    } else kiq[jz] = z
  }
  fw = 2 ** q0
  for (let i = jz; i >= 0; i--) { kq[i] = fw * kiq[i]; fw *= TWON24 }
  for (let i = jz; i >= 0; i--) {
    fw = 0
    for (let k = 0; k <= jp && k <= jz - i; k++) fw += PIO2_CHUNKS[k] * kq[i + k]
    kfq[jz - i] = fw
  }
  fw = 0
  for (let i = jz; i >= 0; i--) fw += kfq[i]
  RP[0] = ih === 0 ? fw : -fw
  fw = kfq[0] - fw
  for (let i = 1; i <= jz; i++) fw += kfq[i]
  RP[1] = ih === 0 ? fw : -fw
  return n & 7
}
const tx = new Float64Array(3)
function remPio2(x) {
  const hx = hiw(x), ix = hx & 0x7FFFFFFF
  if (ix < 0x4002D97C) {
    if (hx > 0) {
      let z = x - PIO2_1
      if (ix !== 0x3FF921FB) { RP[0] = z - PIO2_1T; RP[1] = (z - RP[0]) - PIO2_1T }
      else { z -= PIO2_2; RP[0] = z - PIO2_2T; RP[1] = (z - RP[0]) - PIO2_2T }
      return 1
    }
    let z = x + PIO2_1
    if (ix !== 0x3FF921FB) { RP[0] = z + PIO2_1T; RP[1] = (z - RP[0]) + PIO2_1T }
    else { z += PIO2_2; RP[0] = z + PIO2_2T; RP[1] = (z - RP[0]) + PIO2_2T }
    return -1
  }
  if (ix <= 0x413921FB) {
    let t = Math.abs(x)
    const n = (t * INVPIO2 + 0.5) | 0, fn = n
    let r = t - fn * PIO2_1, w = fn * PIO2_1T, y0 = r - w
    // npio2_hw[n − 1] is the high word of n·PIO2_1 for every n < 32
    if (!(n < 32 && ix !== hiw(fn * PIO2_1))) {
      const j = ix >> 20
      if (j - ((hiw(y0) >> 20) & 0x7FF) > 16) {
        t = r; w = fn * PIO2_2; r = t - w; w = fn * PIO2_2T - ((t - r) - w); y0 = r - w
        if (j - ((hiw(y0) >> 20) & 0x7FF) > 49) { t = r; w = fn * PIO2_3; r = t - w; w = fn * PIO2_3T - ((t - r) - w); y0 = r - w }
      }
    }
    const y1 = (r - y0) - w
    if (hx < 0) { RP[0] = -y0; RP[1] = -y1; return -n }
    RP[0] = y0; RP[1] = y1
    return n
  }
  const e0 = (ix >> 20) - 1046
  let z = words(ix - (e0 << 20), low(x))
  for (let i = 0; i < 2; i++) { tx[i] = z | 0; z = (z - tx[i]) * TWO24 }
  tx[2] = z
  let nx = 3
  while (tx[nx - 1] === 0) nx--
  const n = kernelRemPio2(tx, e0, nx)
  if (hx < 0) { RP[0] = -RP[0]; RP[1] = -RP[1]; return -n }
  return n
}

// ---- __kernel_sin, __kernel_cos, __kernel_tan ----
const [S1, S2, S3, S4, S5, S6] = KSIN
const [C1, C2, C3, C4, C5, C6] = KCOS
function kSin(x, y, iy) {
  if ((hiw(x) & 0x7FFFFFFF) < 0x3E400000) return x
  const z = x * x, v = z * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  if (iy === 0) return x + v * (S1 + z * r)
  return x - ((z * (0.5 * y - v * r) - y) - v * S1)
}
function kCos(x, y) {
  const ix = hiw(x) & 0x7FFFFFFF
  if (ix < 0x3E400000) return 1
  const z = x * x
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
  if (ix < 0x3FD33333) return 1 - (0.5 * z - (z * r - x * y))
  const qx = ix > 0x3FE90000 ? 0.28125 : words(ix - 0x00200000, 0)
  return (1 - qx) - ((0.5 * z - qx) - (z * r - x * y))
}
const T = KTAN
function kTan(x, y, iy) {
  const hx = hiw(x), ix = hx & 0x7FFFFFFF
  let z, r, v, w, s
  if (ix < 0x3E300000) {
    if (((ix | low(x)) | (iy + 1)) === 0) return 1 / Math.abs(x)
    if (iy === 1) return x
    w = x + y; z = setLow(w, 0); v = y - (z - x)
    const a = -1 / w, t = setLow(a, 0)
    s = 1 + t * z
    return t + a * (s + t * v)
  }
  if (ix >= 0x3FE59428) {
    if (hx < 0) { x = -x; y = -y }
    z = PIO4 - x; w = PIO4LO - y; x = z + w; y = 0
  }
  z = x * x; w = z * z
  r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))))
  v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))))
  s = z * x
  r = y + z * (s * (r + v) + y)
  r += T[0] * s
  w = x + r
  if (ix >= 0x3FE59428) { v = iy; return (1 - ((hx >> 30) & 2)) * (v - 2 * (x - (w * w / (w + v) - r))) }
  if (iy === 1) return w
  z = setLow(w, 0); v = r - (z - x)
  const a = -1 / w, t = setLow(a, 0)
  s = 1 + t * z
  return t + a * (s + t * v)
}

// ---- sin, cos, tan ----
function sin(x) {
  const ix = hiw(x) & 0x7FFFFFFF
  if (ix <= 0x3FE921FB) return kSin(x, 0, 0)
  if (ix >= 0x7FF00000) return NaN
  const n = remPio2(x) & 3
  if (n === 0) return kSin(RP[0], RP[1], 1)
  if (n === 1) return kCos(RP[0], RP[1])
  if (n === 2) return -kSin(RP[0], RP[1], 1)
  return -kCos(RP[0], RP[1])
}
function cos(x) {
  const ix = hiw(x) & 0x7FFFFFFF
  if (ix <= 0x3FE921FB) return kCos(x, 0)
  if (ix >= 0x7FF00000) return NaN
  const n = remPio2(x) & 3
  if (n === 0) return kCos(RP[0], RP[1])
  if (n === 1) return -kSin(RP[0], RP[1], 1)
  if (n === 2) return -kCos(RP[0], RP[1])
  return kSin(RP[0], RP[1], 1)
}
function tan(x) {
  const ix = hiw(x) & 0x7FFFFFFF
  if (ix <= 0x3FE921FB) return kTan(x, 0, 1)
  if (ix >= 0x7FF00000) return NaN
  const n = remPio2(x)
  return kTan(RP[0], RP[1], 1 - ((n & 1) << 1))
}

// ---- asin, acos, atan, atan2 ----
const [pS0, pS1, pS2, pS3, pS4, pS5] = ASIN_P
const [qS1, qS2, qS3, qS4] = ASIN_Q
const asinP = (z) => z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))))
const asinQ = (z) => 1 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)))
function acos(x) {
  const hx = hiw(x), ix = hx & 0x7FFFFFFF
  if (ix >= 0x3FF00000) {
    if (((ix - 0x3FF00000) | low(x)) === 0) return hx > 0 ? 0 : PI_D + 2 * PIO2_LO
    return NaN
  }
  if (ix < 0x3FE00000) {
    if (ix <= 0x3C600000) return PIO2_HI + PIO2_LO
    const z = x * x, r = asinP(z) / asinQ(z)
    return PIO2_HI - (x - (PIO2_LO - x * r))
  }
  if (hx < 0) {
    const z = (1 + x) * 0.5, p = asinP(z), q = asinQ(z), s = Math.sqrt(z), r = p / q
    const w = r * s - PIO2_LO
    return PI_D - 2 * (s + w)
  }
  const z = (1 - x) * 0.5, s = Math.sqrt(z), df = setLow(s, 0)
  const c = (z - df * df) / (s + df)
  const r = asinP(z) / asinQ(z)
  const w = r * s + c
  return 2 * (df + w)
}
function asin(x) {
  const hx = hiw(x), ix = hx & 0x7FFFFFFF
  let t, w, p, q
  if (ix >= 0x3FF00000) {
    if (((ix - 0x3FF00000) | low(x)) === 0) return x * PIO2_HI + x * PIO2_LO
    return NaN
  }
  if (ix < 0x3FE00000) {
    if (ix < 0x3E400000) return x
    t = x * x
    w = asinP(t) / asinQ(t)
    return x + x * w
  }
  w = 1 - Math.abs(x)
  t = w * 0.5
  p = asinP(t); q = asinQ(t)
  const s = Math.sqrt(t)
  if (ix >= 0x3FEF3333) {
    w = p / q
    t = PIO2_HI - (2 * (s + s * w) - PIO2_LO)
  } else {
    w = setLow(s, 0)
    const c = (t - w * w) / (s + w), r = p / q
    p = 2 * s * r - (PIO2_LO - 2 * c)
    q = PIO4 - 2 * w
    t = PIO4 - (p - q)
  }
  return hx > 0 ? t : -t
}
const [aT0, aT1, aT2, aT3, aT4, aT5, aT6, aT7, aT8, aT9, aT10] = ATAN_T
function atan(x) {
  const hx = hiw(x), ix = hx & 0x7FFFFFFF
  let id = -1
  if (ix >= 0x44100000) {
    if (x !== x) return x
    return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3]
  }
  if (ix < 0x3FDC0000) {
    if (ix < 0x3E400000) return x
  } else {
    x = Math.abs(x)
    if (ix < 0x3FF30000) {
      if (ix < 0x3FE60000) { id = 0; x = (2 * x - 1) / (2 + x) }
      else { id = 1; x = (x - 1) / (x + 1) }
    } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1 + 1.5 * x) }
    else { id = 3; x = -1 / x }
  }
  const z = x * x, w = z * z
  const s1 = z * (aT0 + w * (aT2 + w * (aT4 + w * (aT6 + w * (aT8 + w * aT10)))))
  const s2 = w * (aT1 + w * (aT3 + w * (aT5 + w * (aT7 + w * aT9))))
  if (id < 0) return x - x * (s1 + s2)
  const r = ATAN_HI[id] - ((x * (s1 + s2) - ATAN_LO[id]) - x)
  return hx < 0 ? -r : r
}
function atan2(y, x) {
  if (x !== x) return x
  if (y !== y) return y
  if (x === 1) return atan(y)
  const hx = hiw(x), hy = hiw(y), ix = hx & 0x7FFFFFFF, iy = hy & 0x7FFFFFFF
  let m = ((hy >> 31) & 1) | ((hx >> 30) & 2)
  if (y === 0) return m < 2 ? y : m === 3 ? -PI_D : PI_D
  if (x === 0) return hy < 0 ? -PI_O_2 : PI_O_2
  if (ix === 0x7FF00000) {
    if (iy === 0x7FF00000) return m === 0 ? PI_O_4 : m === 1 ? -PI_O_4 : m === 2 ? 3 * PI_O_4 : -3 * PI_O_4
    return m === 0 ? 0 : m === 1 ? -0 : m === 2 ? PI_D : -PI_D
  }
  if (iy === 0x7FF00000) return hy < 0 ? -PI_O_2 : PI_O_2
  const k = (iy - ix) >> 20
  let z
  if (k > 60) { z = PI_O_2 + 0.5 * PI_LO; m &= 1 }
  else if (hx < 0 && k < -60) z = 0
  else z = atan(Math.abs(y / x))
  if (m === 0) return z
  if (m === 1) return -z
  if (m === 2) return PI_D - (z - PI_LO)
  return (z - PI_LO) - PI_D
}

// ---- exp, expm1 ----
const [P1, P2, P3, P4, P5] = EXP_P
function exp(x) {
  let hx = hiw(x)
  const xsb = hx >>> 31
  hx &= 0x7FFFFFFF
  let hi = 0, lo = 0, k = 0
  if (hx >= 0x40862E42) {
    if (hx >= 0x7FF00000) return x === -Infinity ? 0 : x
    if (x > EXP_OVER) return Infinity
    if (x < EXP_UNDER) return 0
  }
  if (hx > 0x3FD62E42) {
    if (hx < 0x3FF0A2B2) {
      if (x === 1) return EXP_E
      hi = x - (xsb ? -LN2_HI : LN2_HI); lo = xsb ? -LN2_LO : LN2_LO; k = 1 - xsb - xsb
    } else {
      k = (INVLN2 * x + (xsb ? -0.5 : 0.5)) | 0
      const t = k
      hi = x - t * LN2_HI; lo = t * LN2_LO
    }
    x = hi - lo
  } else if (hx < 0x3E300000) return 1 + x
  const t = x * x
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  if (k === 0) return 1 - ((x * c) / (c - 2) - x)
  const y = 1 - ((lo - (x * c) / (2 - c)) - hi)
  if (k >= -1021) {
    if (k === 1024) return y * 2 * TWO1023
    return y * words(0x3FF00000 + (k << 20), 0)
  }
  return y * words(0x3FF00000 + ((k + 1000) << 20), 0) * TWOM1000
}
const [Q1, Q2, Q3, Q4, Q5] = EXPM1_Q
function expm1(x) {
  let hx = hiw(x)
  const xsb = hx & 0x80000000
  hx &= 0x7FFFFFFF
  let hi = 0, lo = 0, c = 0, k = 0, t, y
  if (hx >= 0x4043687A) {
    if (hx >= 0x40862E42) {
      if (hx >= 0x7FF00000) return x === -Infinity ? -1 : x
      if (x > EXP_OVER) return Infinity
    }
    if (xsb !== 0) return -1
  }
  if (hx > 0x3FD62E42) {
    if (hx < 0x3FF0A2B2) {
      if (xsb === 0) { hi = x - LN2_HI; lo = LN2_LO; k = 1 }
      else { hi = x + LN2_HI; lo = -LN2_LO; k = -1 }
    } else {
      k = (INVLN2 * x + (xsb === 0 ? 0.5 : -0.5)) | 0
      t = k
      hi = x - t * LN2_HI; lo = t * LN2_LO
    }
    x = hi - lo
    c = (hi - x) - lo
  } else if (hx < 0x3C900000) return x
  const hfx = 0.5 * x, hxs = x * hfx
  const r1 = 1 + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))))
  t = 3 - r1 * hfx
  let e = hxs * ((r1 - t) / (6 - x * t))
  if (k === 0) return x - (x * e - hxs)
  const twopk = words(0x3FF00000 + (k << 20), 0)
  e = (x * (e - c) - c)
  e -= hxs
  if (k === -1) return 0.5 * (x - e) - 0.5
  if (k === 1) return x < -0.25 ? -2 * (e - (x + 0.5)) : 1 + 2 * (x - e)
  if (k <= -2 || k > 56) {
    y = 1 - (e - x)
    y = k === 1024 ? y * 2 * EXPM1_TWO1023 : y * twopk
    return y - 1
  }
  if (k < 20) {
    t = words(0x3FF00000 - (0x200000 >> k), 0)
    return (t - (e - x)) * twopk
  }
  t = words((0x3FF - k) << 20, 0)
  y = x - (e + t)
  y += 1
  return y * twopk
}

// ---- log, log1p, log2, log10 ----
const [Lg1, Lg2, Lg3, Lg4, Lg5, Lg6, Lg7] = LG
function log(x) {
  let hx = hiw(x), k = 0
  if (hx < 0x00100000) {
    if (x === 0) return -Infinity
    if (hx < 0) return NaN
    k -= 54; x *= TWO54; hx = hiw(x)
  }
  if (hx >= 0x7FF00000) return x
  k += (hx >> 20) - 1023
  hx &= 0x000FFFFF
  const i = (hx + 0x95F64) & 0x100000
  x = setHigh(x, hx | (i ^ 0x3FF00000))
  k += i >> 20
  const f = x - 1, dk = k
  if ((0x000FFFFF & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO
    const R = f * f * (0.5 - 0.3333333333333333 * f)
    if (k === 0) return f - R
    return dk * LN2_HI - ((R - dk * LN2_LO) - f)
  }
  const s = f / (2 + f), z = s * s, w = z * z
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6))
  const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)))
  const R = t2 + t1
  if (((hx - 0x6147A) | (0x6B851 - hx)) > 0) {
    const hfsq = 0.5 * f * f
    if (k === 0) return f - (hfsq - s * (hfsq + R))
    return dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f)
  }
  if (k === 0) return f - s * (f - R)
  return dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f)
}
function log1p(x) {
  const hx = hiw(x), ax = hx & 0x7FFFFFFF
  let k = 1, f = 0, hu = 0, c = 0, u
  if (hx < 0x3FDA827A) {
    if (ax >= 0x3FF00000) return x === -1 ? -Infinity : NaN
    if (ax < 0x3E200000) return ax < 0x3C900000 ? x : x - x * x * 0.5
    if (hx > 0 || hx <= (0xBFD2BEC4 | 0)) { k = 0; f = x; hu = 1 }
  }
  if (hx >= 0x7FF00000) return x
  if (k !== 0) {
    if (hx < 0x43400000) {
      u = 1 + x
      hu = hiw(u)
      k = (hu >> 20) - 1023
      c = k > 0 ? 1 - (u - x) : x - (u - 1)
      c /= u
    } else { u = x; hu = hiw(u); k = (hu >> 20) - 1023; c = 0 }
    hu &= 0x000FFFFF
    if (hu < 0x6A09E) u = setHigh(u, hu | 0x3FF00000)
    else { k += 1; u = setHigh(u, hu | 0x3FE00000); hu = (0x00100000 - hu) >> 2 }
    f = u - 1
  }
  const hfsq = 0.5 * f * f
  if (hu === 0) {
    if (f === 0) {
      if (k === 0) return 0
      c += k * LN2_LO
      return k * LN2_HI + c
    }
    const R = hfsq * (1 - 0.6666666666666666 * f)
    if (k === 0) return f - R
    return k * LN2_HI - ((R - (k * LN2_LO + c)) - f)
  }
  const s = f / (2 + f), z = s * s
  const R = z * (Lg1 + z * (Lg2 + z * (Lg3 + z * (Lg4 + z * (Lg5 + z * (Lg6 + z * Lg7))))))
  if (k === 0) return f - (hfsq - s * (hfsq + R))
  return k * LN2_HI - ((hfsq - (s * (hfsq + R) + (k * LN2_LO + c))) - f)
}
function kLog1p(f) {
  const s = f / (2 + f), z = s * s, w = z * z
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6))
  const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)))
  return s * (0.5 * f * f + (t2 + t1))
}
function log2(x) {
  let hx = hiw(x), k = 0
  if (hx < 0x00100000) {
    if (x === 0) return -Infinity
    if (hx < 0) return NaN
    k -= 54; x *= TWO54; hx = hiw(x)
  }
  if (hx >= 0x7FF00000) return x
  if (x === 1) return 0
  k += (hx >> 20) - 1023
  hx &= 0x000FFFFF
  const i = (hx + 0x95F64) & 0x100000
  x = setHigh(x, hx | (i ^ 0x3FF00000))
  k += i >> 20
  const y = k, f = x - 1, hfsq = 0.5 * f * f, r = kLog1p(f)
  const hi = setLow(f - hfsq, 0)
  const lo = (f - hi) - hfsq + r
  let vhi = hi * IVLN2HI, vlo = (lo + hi) * IVLN2LO + lo * IVLN2HI
  const w = y + vhi
  vlo += (y - w) + vhi
  vhi = w
  return vlo + vhi
}
function log10(x) {
  let hx = hiw(x), k = 0
  if (hx < 0x00100000) {
    if (x === 0) return -Infinity
    if (hx < 0) return NaN
    k -= 54; x *= TWO54; hx = hiw(x)
  }
  if (hx >= 0x7FF00000) return x
  if (x === 1) return 0
  const lx = low(x)
  k += (hx >> 20) - 1023
  const i = k >>> 31
  const y = k + i
  x = words((hx & 0x000FFFFF) | ((0x3FF - i) << 20), lx)
  return (y * LOG10_2LO + IVLN10 * log(x)) + y * LOG10_2HI
}

// ---- sinh, cosh, tanh, asinh, acosh, atanh ----
function sinh(x) {
  const h = x < 0 ? -0.5 : 0.5, ax = Math.abs(x)
  if (ax < 22) {
    if (ax < TWO_M28) return x
    const t = expm1(ax)
    if (ax < 1) return h * (2 * t - t * t / (t + 1))
    return h * (t + t / (t + 1))
  }
  if (ax < LOG_MAXD) return h * exp(ax)
  if (ax <= SINH_OVER) { const w = exp(0.5 * ax), t = h * w; return t * w }
  return x * 1.0e307
}
function cosh(x) {
  const ix = hiw(x) & 0x7FFFFFFF, ax = Math.abs(x)
  if (ix < 0x3FD62E43) {
    const t = expm1(ax), w = 1 + t
    if (ix < 0x3C800000) return w
    return 1 + (t * t) / (w + w)
  }
  if (ix < 0x40360000) { const t = exp(ax); return 0.5 * t + 0.5 / t }
  if (ix < 0x40862E42) return 0.5 * exp(ax)
  if (ax <= SINH_OVER) { const w = exp(0.5 * ax), t = 0.5 * w; return t * w }
  return ix >= 0x7FF00000 ? x * x : Infinity
}
function tanh(x) {
  const jx = hiw(x), ix = jx & 0x7FFFFFFF
  let z
  if (ix >= 0x7FF00000) return x !== x ? x : jx >= 0 ? 1 : -1
  if (ix < 0x40360000) {
    if (ix < 0x3E300000) return x
    if (ix >= 0x3FF00000) { const t = expm1(2 * Math.abs(x)); z = 1 - 2 / (t + 2) }
    else { const t = expm1(-2 * Math.abs(x)); z = -t / (t + 2) }
  } else z = 1
  return jx >= 0 ? z : -z
}
function asinh(x) {
  const hx = hiw(x), ix = hx & 0x7FFFFFFF
  let w
  if (ix >= 0x7FF00000) return x
  if (ix < 0x3E300000) return x
  if (ix > 0x41B00000) w = log(Math.abs(x)) + LN2
  else if (ix > 0x40000000) { const t = Math.abs(x); w = log(2 * t + 1 / (Math.sqrt(x * x + 1) + t)) }
  else { const t = x * x; w = log1p(Math.abs(x) + t / (1 + Math.sqrt(1 + t))) }
  return hx > 0 ? w : -w
}
function acosh(x) {
  const hx = hiw(x)
  if (hx < 0x3FF00000) return NaN
  if (hx >= 0x41B00000) return hx >= 0x7FF00000 ? x : log(x) + LN2
  if (x === 1) return 0
  if (hx > 0x40000000) { const t = x * x; return log(2 * x - 1 / (x + Math.sqrt(t - 1))) }
  const t = x - 1
  return log1p(t + Math.sqrt(2 * t + t * t))
}
function atanh(x) {
  const hx = hiw(x), ix = hx & 0x7FFFFFFF
  let t
  if (Math.abs(x) > 1) return NaN
  if (x !== x) return x
  if (ix === 0x3FF00000) return x > 0 ? Infinity : -Infinity
  if (ix < 0x3E300000) return x
  x = Math.abs(x)
  if (ix < 0x3FE00000) { t = x + x; t = 0.5 * log1p(t + t * x / (1 - x)) }
  else t = 0.5 * log1p((x + x) / (1 - x))
  return hx >= 0 ? t : -t
}

// ---- cbrt ----
const [cP0, cP1, cP2, cP3, cP4] = CBRT_P
function cbrt(x) {
  let hx = hiw(x)
  const sign = hx & 0x80000000
  hx ^= sign
  if (hx >= 0x7FF00000) return x
  let t
  if (hx < 0x00100000) {
    if (x === 0) return x
    t = words(0x43500000, 0) * x
    t = words(sign | (((hiw(t) & 0x7FFFFFFF) / 3 | 0) + CBRT_B2), 0)
  } else t = words(sign | ((hx / 3 | 0) + CBRT_B1), 0)
  let r = (t * t) * (t / x)
  t = t * ((cP0 + r * (cP1 + r * cP2)) + ((r * r) * r) * (cP3 + r * cP4))
  // round t away from zero to 23 bits: bits = (bits + 0x80000000) & 0xFFFFFFFFC0000000
  const l = low(t)
  t = words(hiw(t) + (l >= 0x80000000 ? 1 : 0), ((l + 0x80000000) >>> 0) & 0xC0000000)
  const s = t * t
  r = x / s
  const w = t + t
  r = (r - t) / (w + r)
  return t + t * r
}

// ---- hypot: V8's MathHypot (builtins/math.tq), the Kahan-compensated general form ----
function hypot(...vs) {
  const n = vs.length, abs = new Float64Array(n)
  let inf = false, max = 0
  for (let i = 0; i < n; i++) { const a = Math.abs(vs[i]); abs[i] = a; if (a === Infinity) inf = true; max = Math.max(max, a) }
  if (inf) return Infinity
  if (max !== max) return NaN
  if (max === 0) return 0
  let sum = 0, comp = 0
  for (let i = 0; i < n; i++) {
    const m = abs[i] / max, summand = m * m - comp, pre = sum + summand
    comp = (pre - sum) - summand
    sum = pre
  }
  return Math.sqrt(sum) * max
}

// ---- pow: module/math.js's $math.pow and emitPow's constant folds ----
/** Fully-constant `Math.pow`/`**` fold, mirroring emitPow's own constant-arg
 *  branches exactly (module/math.js `emitPow`) — NOT the general runtime
 *  `$math.pow`, because emit.js already special-cases fully-literal operands
 *  before ever reaching that call: an integer |n|<=16 exponent square-and-
 *  multiplies (foldPow), exponent 0.5 is f64.sqrt, and everything else is
 *  host `Math.pow` (emit.js's own constant fold, line ~358). Folding earlier
 *  at the source level with this SAME 3-way split reproduces exactly what
 *  compiling the unfolded expression already does today — zero new divergence. */
function pow(a, b) {
  if (Number.isInteger(b) && Math.abs(b) <= 16) return powInt(a, b)
  if (b === 0.5) return Math.sqrt(a)
  return powRuntime(a, b)
}

// The runtime `$math.pow` (module/math.js), operation for operation, so a fold
// and a run agree bit for bit on any host: the special-case ladder, the
// small-integer fast path, then the kernel: x^y = exp(y·log(x)) with log(x)
// as a double-double (Arm's optimized-routines pow, within 0.54 ulp) over the
// 2^(j/64) table. Bit patterns through BigInt, as the kernel's i64 ops.
const F64 = new Float64Array(1), U64 = new BigUint64Array(F64.buffer)
const bitsOf = (d) => { F64[0] = d; return U64[0] }
const ofBits = (b) => { U64[0] = BigInt.asUintN(64, b); return F64[0] }
const nearestEven = (v) => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r }
const oddInteger = (y) => Number.isInteger(y) && Math.abs(y) < 2 ** 53 && Math.abs(y) % 2 === 1
function powRuntime(x, y) {
  if (y === 0) return 1
  if (Number.isNaN(y)) return y
  if (Number.isNaN(x)) return x
  if (Math.abs(y) === Infinity) { const ax = Math.abs(x); return ax === 1 ? NaN : (ax > 1) === (y > 0) ? Infinity : 0 }
  if (x === 1) return 1
  if (y === 1) return x
  if (Number.isInteger(y) && Math.abs(y) <= 16) {
    let ax = Math.abs(x), n = Math.abs(y), res = 1
    const neg = (x < 0 || Object.is(x, -0)) && (n & 1) === 1
    while (n > 0) { if (n & 1) res = res * ax; ax = ax * ax; n >>= 1 }
    if (y < 0) res = 1 / res
    return neg ? -res : res
  }
  if (Math.abs(x) === Infinity) { const r = y > 0 ? Infinity : 0; return x < 0 && oddInteger(y) ? -r : r }
  if (x === 0) { const r = y < 0 ? Infinity : 0; return 1 / x < 0 && oddInteger(y) ? -r : r }
  if (x < 0) { if (!Number.isInteger(y)) return NaN; const r = powCore(-x, y); return oddInteger(y) ? -r : r }
  return powCore(x, y)
}
const expQ = (f) => polyTree(EXP_Q, { konst: c => c, mul: (a, b) => a * b, add: (a, b) => a + b }, f)   // (e^f − 1)/f, the kernel's own tree
function powCore(x, y) {
  if (y === 0.5) return Math.sqrt(x)
  const ay = Math.abs(y)
  if (ay < 2 ** -65) return x > 1 ? 1 + y : 1 - y
  if (ay >= 2 ** 63) return (x > 1) === (y > 0) ? Infinity : 0
  let ix = bitsOf(x)
  if (ix < 0x0010000000000000n) ix = BigInt.asUintN(64, bitsOf(x * 2 ** 52) - (52n << 52n))
  const tmp = BigInt.asIntN(64, ix - 0x3fe6955500000000n)
  const i = Number((tmp >> 45n) & 127n), kd = Number(tmp >> 52n)
  const z = ofBits(ix - (tmp & 0xfff0000000000000n))
  const invc = POW_LOG_TAB[3 * i], logc = POW_LOG_TAB[3 * i + 1], logctail = POW_LOG_TAB[3 * i + 2]
  const zhi = ofBits((bitsOf(z) + 0x80000000n) & 0xffffffff00000000n), zlo = z - zhi
  const rhi = zhi * invc - 1, rlo = zlo * invc, r = rhi + rlo
  const t1 = kd * POW_LN2HI + logc, t2 = t1 + r
  const lo1 = kd * POW_LN2LO + logctail, lo2 = t1 - t2 + r
  const ar = POW_LOG_A[0] * r, ar2 = r * ar, ar3 = r * ar2
  const arhi = POW_LOG_A[0] * rhi, arhi2 = rhi * arhi
  const hi = t2 + arhi2, lo3 = rlo * (ar + arhi), lo4 = t2 - hi + arhi2
  const p = ar3 * (POW_LOG_A[1] + (r * POW_LOG_A[2] + ar2 * (POW_LOG_A[3] + (r * POW_LOG_A[4] + ar2 * (POW_LOG_A[5] + r * POW_LOG_A[6])))))
  const lo = lo1 + lo2 + lo3 + lo4 + p
  const lg = hi + lo, tail = hi - lg + lo
  const yhi = ofBits(bitsOf(y) & 0xfffffffff8000000n), ylo = y - yhi
  const lhi = ofBits(bitsOf(lg) & 0xfffffffff8000000n), llo = lg - lhi + tail
  const ehi = yhi * lhi, elo = ylo * lhi + y * llo
  const ax = Math.abs(ehi)
  if (ax < 2 ** -54) return 1 + ehi
  if (ax >= 1024) return ehi < 0 ? 0 : Infinity
  const k = nearestEven(ehi * (64 / Math.LN2))
  const f = ehi - k * EXP_L1 - k * EXP_L2 + elo
  const j = k & 63, t = EXP2_TAB[2 * j]
  const q = EXP2_TAB[2 * j + 1] + f * expQ(f)
  const sbits = BigInt.asIntN(64, bitsOf(t) + (BigInt(k >> 6) << 52n))
  if (ax < 512) { const scale = ofBits(sbits); return scale + scale * q }
  if (k >= 0) { const scale = ofBits(sbits - 0x3f10000000000000n); return (scale + scale * q) * 2 ** 1009 }
  const scale = ofBits(sbits + 0x3fe0000000000000n)
  let res = scale + scale * q
  if (Math.abs(res) < 1) { const one = res < 0 ? -1 : 1; let lo = scale - res + scale * q; const hi = one + res; lo = one - hi + res + lo; res = hi + lo - one }
  return res * 2 ** -1022
}
function powInt(a, n) {
  if (n === 0) return 1
  let sq = a, res = null
  for (let m = Math.abs(n); m > 0; m >>= 1) {
    if (m & 1) res = (res === null) ? sq : res * sq
    if (m >> 1) sq = sq * sq
  }
  return n < 0 ? 1 / res : res
}

/** V8's Math functions, dispatched by the `math.<name>` key prepare resolves `Math.foo` to. */
export const MATH_KERNEL = {
  'math.sin': sin, 'math.cos': cos, 'math.tan': tan,
  'math.asin': asin, 'math.acos': acos, 'math.atan': atan, 'math.atan2': atan2,
  'math.exp': exp, 'math.expm1': expm1, 'math.log': log, 'math.log1p': log1p, 'math.log2': log2, 'math.log10': log10,
  'math.sinh': sinh, 'math.cosh': cosh, 'math.tanh': tanh, 'math.asinh': asinh, 'math.acosh': acosh, 'math.atanh': atanh,
  'math.cbrt': cbrt, 'math.hypot': hypot,
}
/** `Math.pow`/`**` — special-cased 3-way split (see `pow` doc above), not a plain unary kernel entry. */
export const powFold = pow
