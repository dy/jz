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

/** Horner evaluation matching module/math.js's `horner()` builder: for
 *  cs = [c0, c1, ..., cN], returns c0 + v*(c1 + v*(c2 + ... + v*cN)). */
function horner(cs, v) {
  let acc = cs[cs.length - 1]
  for (let i = cs.length - 2; i >= 0; i--) acc = cs[i] + v * acc
  return acc
}

// Range-reduction constants — the EXACT decimal strings module/math.js embeds
// (native toString's shortest round-trip repr of Math.PI etc.); JS numeric
// literal parsing is correctly-rounded like WAT float parsing, so the same
// string reproduces the identical f64 bits in both legs.
const PI = 3.141592653589793, INV_PI = 0.3183098861837907, HALF_PI = 1.5707963267948966
const SIN_C = [1, -0.16666660296130772, 0.008333091744946387, -0.00019811771757028443, 0.000002611054662215034]
const COS_C = [1, -0.4999993043717576, 0.04166402742354027, -0.0013856638518363177, 0.00002321737177898552]
const EXP2_C = [1, 0.6931472000619209, 0.24022650999918949, 0.05550340682450019, 0.009618048870444599, 0.0013395279077191057, 0.00015463102004723134]
const EXPM1_COEF = [1, 1 / 2, 1 / 6, 1 / 24, 1 / 120, 1 / 720, 1 / 5040, 1 / 40320]

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

function exp2(y) {
  if (Number.isNaN(y)) return y
  if (y > 1024) return Infinity
  if (y < -1075) return 0
  const k = nearest(y)  // i32.trunc_f64_s(f64.nearest y) — nearest is already integral here
  const f = y - k
  const p = horner(EXP2_C, f)
  if (k > -1023 && k < 1024) {
    return p * bitsF64(BigInt(k + 1023) << 52n)
  }
  const k2 = k >> 1
  return p * bitsF64(BigInt(k2 + 1023) << 52n) * bitsF64(BigInt(k - k2 + 1023) << 52n)
}

function exp(x) { return exp2(x * Math.LOG2E) }

function expm1(x) {
  if (Math.abs(x) < 0.5) return x * horner(EXPM1_COEF, x)
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
  return k * Math.LN2 + 2 * s * (1 + z * (0.33333333283005556 + z * (0.20000059590510924 + z * (0.14275490984342690 + z * 0.11663796426848184))))
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
  return Math.pow(a, b)
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

function cbrt(x) {
  if (!Number.isFinite(x)) return x
  if (x === 0) return x
  let a = Math.abs(x)
  let s = 1
  if (a < 2.2250738585072014e-308) { a = a * 1152921504606846976; s = 9.5367431640625e-7 }
  let t = bitsF64((f64Bits(a) / 3n) + 0x2A9F7893BF800000n)
  t = ((t + t) + a / (t * t)) * 0.3333333333333333
  t = ((t + t) + a / (t * t)) * 0.3333333333333333
  t = ((t + t) + a / (t * t)) * 0.3333333333333333
  t = t * s
  return x < 0 ? -t : t
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
