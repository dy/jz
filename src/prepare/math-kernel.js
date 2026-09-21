/**
 * Host-side JS mirrors of module/math.js's WAT transcendentals, op-for-op, so
 * `preEval` (pre-eval.js) can fold `Math.sin(1.5)` etc. at COMPILE time to the
 * exact bits the RUNTIME wasm would compute — bit-exact vs jz's own kernel,
 * deliberately NOT vs host `Math.sin`/`Math.cos`/… (whose libm differs in the
 * last ulp from jz's minimax/Newton approximations by design; see module/math.js
 * header comments on each algorithm).
 *
 * Every function below transliterates its `wat('math.X', ...)` twin literally:
 * same operand order, same parenthesization (float ops are NOT associative —
 * reordering would silently change the fold). f64 arithmetic in JS (+,-,*,/,
 * Math.sqrt/abs) is IEEE754 binary64 exactly like wasm's f64 ops, so the port
 * is bit-identical wherever the JS expression shape matches the WAT shape.
 *
 * A handful of ops are genuinely host-exact already (no algorithmic mirror
 * needed) because either jz's WAT wraps the SAME host-computed constant
 * (Math.PI et al — emitted via `f64.const ${Math.PI}` using the compiler's own
 * host Math), or the op is IEEE754-mandated correctly-rounded in both JS and
 * wasm (sqrt/abs/floor/ceil/trunc), or jz's WAT was deliberately engineered to
 * reproduce host JS Math semantics exactly (round, sign, imul, clz32, fround,
 * min/max — see module/math.js comments on each). Those are folded directly
 * via host Math in pre-eval.js's MATH_HOST_EXACT table; this module only ports
 * the ones with a genuinely bespoke algorithm.
 *
 * @module prepare/math-kernel
 */

import { PI, INV_PI, HALF_PI, SIN_C, COS_C, EXPM1_C, LOG_C, EXP2_TAB, EXP2_Q, EXP_Q, EXP_L1, EXP_L2, POW_LOG_TAB, POW_LOG_A, POW_LN2HI, POW_LN2LO, polyTree } from '../../module/math/trig-tables.js'

// ---- bit-level helpers (i64.reinterpret_f64 / f64.reinterpret_i64) ----
const _buf = new ArrayBuffer(8)
const _dv = new DataView(_buf)
/** f64 → its IEEE754 bit pattern, as an unsigned 64-bit BigInt (big-endian: bit 63 = sign). */
function f64Bits(x) { _dv.setFloat64(0, x, false); return _dv.getBigUint64(0, false) }
/** Unsigned 64-bit BigInt bit pattern → f64. */
function bitsF64(bits) { _dv.setBigUint64(0, BigInt.asUintN(64, bits), false); return _dv.getFloat64(0, false) }

/** `f64.copysign`: magnitude of `mag`, sign of `sign` (handles ±0 correctly). */
function copysign(mag, sign) {
  const sNeg = sign < 0 || Object.is(sign, -0)
  const mNeg = mag < 0 || Object.is(mag, -0)
  return sNeg === mNeg ? mag : -mag
}

/** `f64.nearest`: round-to-nearest, ties-to-even (NOT JS `Math.round`, which
 *  ties away from zero toward +Infinity). Preserves sign of a zero result. */
function nearest(x) {
  if (!Number.isFinite(x) || x === 0) return x
  const floor = Math.floor(x)
  const diff = x - floor
  let r
  if (diff < 0.5) r = floor
  else if (diff > 0.5) r = floor + 1
  else r = (floor % 2 === 0) ? floor : floor + 1
  return r === 0 ? copysign(0, x) : r
}

/** The shared evaluation tree (module/math/trig-tables.js `polyTree`) over plain
 *  numbers — the same tree the scalar and 2-wide WAT builders emit, so a folded
 *  `Math.cos(0.7)` and the compiled kernel's own answer agree bit for bit. */
const horner = (cs, v) => polyTree(cs, { konst: (c) => c, mul: (a, b) => a * b, add: (a, b) => a + b }, v)


function sinCore(x) {
  if (Number.isNaN(x)) return x
  if (Math.abs(x) === Infinity) return NaN
  if (Math.abs(x) < 2 ** -27) return x
  let q = nearest(x * INV_PI)
  let r = x - q * PI
  if (Math.abs(r) > HALF_PI) {
    const q2 = nearest(r * INV_PI)
    r = r - q2 * PI
    q = q + q2
  }
  q = q - 2 * nearest(q * 0.5)
  const r2 = r * r
  r = r * horner(SIN_C, r2)
  if (Math.abs(q) > 0.5) r = -r
  return Math.min(Math.max(r, -1), 1)
}

function cosCore(x) {
  if (Number.isNaN(x)) return x
  if (Math.abs(x) === Infinity) return NaN
  let q = nearest(x * INV_PI)
  let r = x - q * PI
  if (Math.abs(r) > HALF_PI) {
    const q2 = nearest(r * INV_PI)
    r = r - q2 * PI
    q = q + q2
  }
  q = q - 2 * nearest(q * 0.5)
  const r2 = r * r
  r = horner(COS_C, r2)
  if (Math.abs(q) > 0.5) r = -r
  return Math.min(Math.max(r, -1), 1)
}

function tan(x) { return sinCore(x) / cosCore(x) }

// 2^e for the table kernels: one exponent build for a normal e, two factors at the edges.
function expScale(p, e) {
  if (e > -1023 && e < 1024) return p * bitsF64(BigInt(e + 1023) << 52n)
  const k2 = e >> 1
  return p * bitsF64(BigInt(k2 + 1023) << 52n) * bitsF64(BigInt(e - k2 + 1023) << 52n)
}
// $math.exp2 / $math.exp op for op (module/math.js): the 2^(j/64) table with tails.
function exp2(y) {
  if (Number.isNaN(y)) return y
  if (y > 1024) return Infinity
  if (y < -1075) return 0
  const k = Math.trunc(nearest(y * 64))  // i32.trunc_f64_s(f64.nearest(64y)) – integral already
  const f = y - k * 0.015625
  const t = EXP2_TAB[2 * (k & 63)], tail = EXP2_TAB[2 * (k & 63) + 1]
  return expScale(t + t * (f * horner(EXP2_Q, f) + tail), k >> 6)
}
function exp(x) {
  if (Number.isNaN(x)) return x
  if (x > 709.782712893384) return Infinity
  if (x < -745.1332191019412) return 0
  const k = Math.trunc(nearest(x * (64 / Math.LN2)))
  const r = (x - k * EXP_L1) - k * EXP_L2
  const t = EXP2_TAB[2 * (k & 63)], tail = EXP2_TAB[2 * (k & 63) + 1]
  return expScale(t + t * (r * horner(EXP_Q, r) + tail), k >> 6)
}

function expm1(x) {
  if (Math.abs(x) < 0.5) return x * horner(EXPM1_C, x)
  return exp(x) - 1
}

function log(x) {
  if (Number.isNaN(x)) return x
  if (x <= 0) return x === 0 ? -Infinity : NaN
  if (x === Infinity) return x
  let k = 0
  if (x < 2.2250738585072014e-308) { x = x * 18014398509481984; k = -54 }
  const bits = f64Bits(x)
  k += Number((bits >> 52n) & 0x7ffn) - 1023
  let m = bitsF64((bits & 0x000fffffffffffffn) | 0x3ff0000000000000n)
  if (m >= 1.4142135623730951) { m = m * 0.5; k += 1 }
  const s = (m - 1) / (m + 1)
  const z = s * s
  return k * Math.LN2 + 2 * s * horner(LOG_C, z)
}

function log2_(x) { return log(x) / Math.LN2 }

function log10_(x) {
  if (Number.isNaN(x)) return x
  if (x <= 0) return x === 0 ? -Infinity : NaN
  if (x === Infinity) return x
  let k = 0
  if (x < 2.2250738585072014e-308) { x = x * 18014398509481984; k = -54 }
  const bits = f64Bits(x)
  k += Number((bits >> 52n) & 0x7ffn) - 1023
  let m = bitsF64((bits & 0x000fffffffffffffn) | 0x3ff0000000000000n)
  if (m >= 1.4142135623730951) { m = m * 0.5; k += 1 }
  const f = m - 1
  const hfsq = 0.5 * (f * f)
  const s = f / (2 + f)
  const z = s * s
  const w = z * z
  const t1 = w * (0.3999999999940942 + w * (0.22222198432149792 + w * 0.15313837699209373))
  const t2 = z * (0.6666666666666735 + w * (0.2857142874366239 + w * (0.1818357216161805 + w * 0.14798198605116586)))
  const R = t2 + t1
  let hi = f - hfsq
  hi = bitsF64(f64Bits(hi) & 0xffffffff00000000n)
  const lo = ((f - hi) - hfsq) + s * (hfsq + R)
  const valhi = hi * 0.4342944818781689
  const dk = k
  const y = dk * 0.30102999566361177
  const vallo = ((dk * 3.694239077158931e-13) + ((lo + hi) * 2.5082946711645275e-11)) + (lo * 0.4342944818781689)
  const w2 = y + valhi
  const vallo2 = vallo + ((y - w2) + valhi)
  return vallo2 + w2
}

function log1p(x) {
  if (x === Infinity) return Infinity
  const u = 1 + x
  if (u === 1) return x
  return (log(u) * x) / (u - 1)
}

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

function atan(x) {
  if (Number.isNaN(x)) return x
  if (x === 0) return x
  let t = Math.abs(x)
  let off = 0
  let flip = false
  if (t > 1) { t = 1 / t; flip = true }
  if (t > 0.41421356237309503) {
    t = (t - 0.41421356237309503) / (1 + 0.41421356237309503 * t)
    off = 0.39269908169872414
  }
  const u = t * t
  let r = off + t * (0.99999999939667072 + u * (-0.33333307625846248 + u * (0.19998216947828790 + u * (-0.14240083011830104 + u * (0.10573479828448784 + u * (-0.060347904072425573))))))
  if (flip) r = HALF_PI - r
  return copysign(r, x)
}

function asin(x) {
  if (Math.abs(x) > 1) return NaN
  const ax = Math.abs(x)
  const a = ax <= 0.5 ? ax : Math.sqrt(0.5 * (1 - ax))
  const u = a * a
  let r = a + (a * u) * (0.16666666715486264 + u * (0.074999892151409259 + u * (0.044648555271317079 + u * (0.030259196387355945 + u * (0.023661273034955098 + u * (0.010472588920432560 + u * 0.031028862087420162))))))
  if (ax > 0.5) r = HALF_PI - 2 * r
  return copysign(r, x)
}

function acos(x) { return HALF_PI - asin(x) }

function atan2(y, x) {
  if (Number.isNaN(x)) return x
  if (Number.isNaN(y)) return y
  if (x === 0) {
    if (y === 0) return copysign((x < 0 || Object.is(x, -0)) ? PI : 0, y)
    return y > 0 ? HALF_PI : -HALF_PI
  }
  if (x >= 0) return atan(y / x)
  return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI
}

function sinh(x) {
  if (x === 0) return x
  let ex = exp(Math.abs(x))
  ex = 0.5 * (ex - 1 / ex)
  return x < 0 ? -ex : ex
}

function cosh(x) {
  const ex = exp(Math.abs(x))
  return 0.5 * (ex + 1 / ex)
}

function tanh(x) {
  if (x === 0) return x
  if (Math.abs(x) > 22) return x < 0 ? -1 : 1
  let e2x = exp(2 * Math.abs(x))
  e2x = (e2x - 1) / (e2x + 1)
  return x < 0 ? -e2x : e2x
}

function asinh(x) {
  if (!Number.isFinite(x)) return x
  if (x === 0) return x
  return log(x + Math.sqrt(x * x + 1))
}

function acosh(x) {
  if (x === Infinity) return Infinity
  if (x < 1) return NaN
  return log(x + Math.sqrt(x * x - 1))
}

function atanh(x) {
  if (x === 0) return x
  if (Math.abs(x) === Infinity) return NaN
  return 0.5 * log((1 + x) / (1 - x))
}

// fdlibm s_cbrt.c, the twin of module/math.js's `math.cbrt` kernel.
function cbrt(x) {
  if (!Number.isFinite(x)) return x
  if (x === 0) return x
  let hx = Number(f64Bits(x) >> 32n)
  const sign = hx & 0x80000000
  hx = (hx ^ sign) >>> 0
  let t
  if (hx < 0x00100000) {
    t = x * 18014398509481984   // 2^54
    const high = Number(f64Bits(t) >> 32n) & 0x7fffffff
    t = bitsF64(BigInt(((sign | (Math.floor(high / 3) + 696219795)) >>> 0)) << 32n)
  } else {
    t = bitsF64(BigInt(((sign | (Math.floor(hx / 3) + 715094163)) >>> 0)) << 32n)
  }
  let r = (t * t) * (t / x)
  t = t * ((1.87595182427177009643 + r * (-1.88497979543377169875 + r * 1.621429720105354466140)) + ((r * r) * r) * (-0.758397934778766047437 + r * 0.145996192886612446982))
  t = bitsF64((f64Bits(t) + 0x80000000n) & 0xffffffffc0000000n)
  const s = t * t
  r = x / s
  const w = t + t
  r = (r - t) / (w + r)
  return t + t * r
}

// N-ary like Math.hypot, folded as the SAME left-chained 2-ary calls the runtime
// emitter builds (module/math.js `math.hypot`) so constant folds stay bit-equal to
// the compiled chain: () → +0, (x) → abs(x), (a,b,…) → hypot2(hypot2(a,b),…).
function hypot2(x, y) {
  if (Math.abs(x) === Infinity) return Infinity
  if (Math.abs(y) === Infinity) return Infinity
  return Math.sqrt(x * x + y * y)
}
function hypot(...vs) {
  if (vs.length === 0) return 0
  if (vs.length === 1) return Math.abs(vs[0])
  let r = hypot2(vs[0], vs[1])
  for (let i = 2; i < vs.length; i++) r = hypot2(r, vs[i])
  return r
}

/** Pure bit-exact-vs-kernel transcendentals — dispatched by `math.<name>` key
 *  (matches the resolved callee jz's prepare already produces for `Math.foo`). */
export const MATH_KERNEL = {
  'math.sin': sinCore, 'math.sin_core': sinCore,
  'math.cos': cosCore, 'math.cos_core': cosCore,
  'math.tan': tan,
  'math.exp2': exp2, 'math.exp': exp, 'math.expm1': expm1,
  'math.log': log, 'math.log2': log2_, 'math.log10': log10_, 'math.log1p': log1p,
  'math.atan': atan, 'math.asin': asin, 'math.acos': acos, 'math.atan2': atan2,
  'math.sinh': sinh, 'math.cosh': cosh, 'math.tanh': tanh,
  'math.asinh': asinh, 'math.acosh': acosh, 'math.atanh': atanh,
  'math.cbrt': cbrt, 'math.hypot': hypot,
}
/** `Math.pow`/`**` — special-cased 3-way split (see `pow` doc above), not a plain unary kernel entry. */
export const powFold = pow
