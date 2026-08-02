import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import { evaluate, run } from './util.js'
import jz, { compile } from '../index.js'
import { onKernel } from './_matrix.js'

// Math module tests - comprehensive coverage of all Math.* methods

// ============================================
// Constants
// ============================================

test('Math constants - PI and E', async () => {
  is(await evaluate('Math.PI'), Math.PI)
  is(await evaluate('Math.E'), Math.E)
})

test('Math constants - logarithmic', async () => {
  is(await evaluate('Math.LN2'), Math.LN2)
  is(await evaluate('Math.LN10'), Math.LN10)
  is(await evaluate('Math.LOG2E'), Math.LOG2E)
  is(await evaluate('Math.LOG10E'), Math.LOG10E)
})

test('Math constants - square roots', async () => {
  is(await evaluate('Math.SQRT2'), Math.SQRT2)
  is(await evaluate('Math.SQRT1_2'), Math.SQRT1_2)
})

// ============================================
// Built-in WASM operations
// ============================================

test('Math.sqrt', async () => {
  is(await evaluate('Math.sqrt(4)'), 2)
  is(await evaluate('Math.sqrt(9)'), 3)
  is(await evaluate('Math.sqrt(2)'), Math.sqrt(2))
  is(await evaluate('Math.sqrt(0)'), 0)
  is(await evaluate('Math.sqrt(1)'), 1)
})

test('canon-strip: sqrt/min/max feeding f64 arithmetic sheds the NaN-canon select', () => {
  // A freshly-minted NaN (sqrt of a negative, min/max with a NaN) is canon-ized so it
  // can't be bit-confused with a NaN-boxed pointer in untyped ===/typeof. But when the
  // result flows STRAIGHT into f64.add/sub/mul/div (or another math call), the consumer
  // propagates the NaN identically and re-canon-izes on escape — so the per-op select +
  // f64.ne is dead. Stripping it is the difference between ~1.2x and parity vs V8 on
  // sqrt-heavy kernels (julia, raymarcher, boids).
  const wat = jz.compile(`export const f = (s) => Math.sqrt(s + 1.0) + Math.sqrt(s + 2.0)`, { wat: true })
  const selects = (wat.match(/select/g) || []).length
  is(selects, 0, 'no NaN-canon select when the sqrt result feeds f64.add')
  // log(log(x)): inner log canon also stripped (math-call arg is ToNumber'd + NaN-safe).
  const wlog = jz.compile(`export const f = (x) => Math.log(Math.log(x))`, { wat: true })
  is((wlog.match(/select/g) || []).length, 0, 'no canon select for log feeding log')
})

test('canon-strip soundness: NaN-canon preserved where the result can escape untyped', () => {
  // The strip is ONLY for direct numeric consumers. A sqrt result stored to a local and
  // then ===/typeof-compared keeps correct NaN semantics — number-typed === uses f64.eq
  // (NaN-by-value), so the answer is right with or without the inner canon.
  is(run(`export const f = (x) => Math.sqrt(x)`).f(-1) !== run(`export const f = (x) => Math.sqrt(x)`).f(-1), true,
    'sqrt(-1) is NaN (≠ itself)')
  is(run(`export const f = (x) => { let r = Math.sqrt(x); return r === r }`).f(-1), false,
    'sqrt(-1) === itself is false (NaN semantics preserved)')
  is(run(`export const f = (x) => typeof (Math.sqrt(x) * 2.0)`).f(-1), 'number',
    'NaN through arithmetic is still typeof number')
  is(run(`export const f = (s) => Math.sqrt(s + 1.0) + Math.sqrt(s + 2.0)`).f(2), Math.sqrt(3) + Math.sqrt(4),
    'arithmetic sum of sqrts matches JS exactly')
})

test('Math.abs', async () => {
  is(await evaluate('Math.abs(-5)'), 5)
  is(await evaluate('Math.abs(5)'), 5)
  is(await evaluate('Math.abs(0)'), 0)
  is(await evaluate('Math.abs(-3.14)'), 3.14)
})

test('Math.floor', async () => {
  is(await evaluate('Math.floor(3.7)'), 3)
  is(await evaluate('Math.floor(3.2)'), 3)
  is(await evaluate('Math.floor(-3.2)'), -4)
  is(await evaluate('Math.floor(5)'), 5)
})

test('Math.ceil', async () => {
  is(await evaluate('Math.ceil(3.2)'), 4)
  is(await evaluate('Math.ceil(3.7)'), 4)
  is(await evaluate('Math.ceil(-3.2)'), -3)
  is(await evaluate('Math.ceil(5)'), 5)
})

test('Math.trunc', async () => {
  is(await evaluate('Math.trunc(3.7)'), 3)
  is(await evaluate('Math.trunc(-3.7)'), -3)
  is(await evaluate('Math.trunc(3.2)'), 3)
  is(await evaluate('Math.trunc(0.9)'), 0)
})

test('Math.round', async () => {
  is(await evaluate('Math.round(3.5)'), 4)
  is(await evaluate('Math.round(3.4)'), 3)
  is(await evaluate('Math.round(-3.5)'), -3)   // ties toward +∞, not away from zero
  is(await evaluate('Math.round(-3.6)'), -4)
  is(await evaluate('Math.round(0.5)'), 1)     // not roundTiesToEven (would give 0)
  is(await evaluate('Math.round(2.5)'), 3)
  is(await evaluate('Math.round(-0.5)'), -0)
  is(await evaluate('Math.round(3)'), 3)
})

test('Math.floor/ceil/trunc/round elide on intCertain operand', async () => {
  // Each function is a no-op on integer values. When the operand is provably
  // integer (intCertain lattice), the wasm op should not be emitted.
  const wat = await compile(
    'export let f = (x) => { let i = x | 0; return Math.floor(i) + Math.ceil(i) + Math.trunc(i) + Math.round(i) }',
    { wat: true }
  )
  is(/f64\.floor/.test(wat), false)
  is(/f64\.ceil/.test(wat), false)
  is(/f64\.trunc(?!_)/.test(wat), false)
  is(/f64\.nearest/.test(wat), false)
  // Sanity: rule does NOT fire on a non-intCertain (param-only) operand.
  const wat2 = await compile('export let f = (x) => Math.floor(x)', { wat: true })
  is(/f64\.floor/.test(wat2), true)
  // Correctness: result equals the integer.
  is(await evaluate('(() => { let i = 7; return Math.floor(i) })()'), 7)
})

test('Math.min', async () => {
  is(await evaluate('Math.min(1, 2)'), 1)
  is(await evaluate('Math.min(5, 3)'), 3)
  is(await evaluate('Math.min(-1, 1)'), -1)
  is(await evaluate('Math.min(0, 0)'), 0)
})

test('Math.max', async () => {
  is(await evaluate('Math.max(1, 2)'), 2)
  is(await evaluate('Math.max(5, 3)'), 5)
  is(await evaluate('Math.max(-1, 1)'), 1)
  is(await evaluate('Math.max(0, 0)'), 0)
})

test('Math.sign', async () => {
  is(await evaluate('Math.sign(5)'), 1)
  is(await evaluate('Math.sign(-5)'), -1)
  is(await evaluate('Math.sign(0)'), 0)
})

test('Math.fround', async () => {
  is(await evaluate('Math.fround(1)'), 1)
  is(await evaluate('Math.fround(1.5)'), 1.5)
  almost(await evaluate('Math.fround(1.337)'), Math.fround(1.337), 1e-10)
})

// ES2025 Math.f16round — bit-exact vs the V8 reference (Math.f16round, node ≥ 24;
// literal values below ARE that reference so the test runs on node 22 CI too):
// round-to-nearest-even at the f16 quantum, subnormals, ±0/NaN/∞ passthrough,
// overflow to ∞ at the 65520 boundary (65504 = max f16 + half-ulp).
test('Math.f16round', async () => {
  is(await evaluate('Math.f16round(1.1)'), 1.099609375)                    // = V8 Math.f16round(1.1)
  is(await evaluate('Math.f16round(0.1)'), 0.0999755859375)                // = V8 Math.f16round(0.1)
  if (Math.f16round) {                                                     // host cross-check when present
    is(1.099609375, Math.f16round(1.1))
    is(0.0999755859375, Math.f16round(0.1))
  }
  is(await evaluate('Math.f16round(65504)'), 65504)
  is(await evaluate('Math.f16round(65519.99)'), 65504)
  is(await evaluate('Math.f16round(65520)'), Infinity)
  is(await evaluate('Math.f16round(-65520)'), -Infinity)
  is(await evaluate('Math.f16round(1.00048828125)'), 1)                    // tie → even
  is(await evaluate('Math.f16round(Math.pow(2, -25))'), 0)                 // tie at min-subnormal/2 → 0
  is(await evaluate('Math.f16round(Math.pow(2, -24))'), 2 ** -24)          // min subnormal exact
  is(await evaluate('1 / Math.f16round(-0)'), -Infinity)                   // -0 preserved
  is(await evaluate('1 / Math.f16round(-1e-30)'), -Infinity)               // underflow keeps sign
  is(await evaluate('isNaN(Math.f16round(NaN))'), true)
})

// ============================================
// Trigonometric functions
// ============================================

test('Math.sin', async () => {
  almost(await evaluate('Math.sin(0)'), Math.sin(0), 1e-6)
  almost(await evaluate('Math.sin(Math.PI / 2)'), Math.sin(Math.PI / 2), 1e-6)
  almost(await evaluate('Math.sin(Math.PI)'), Math.sin(Math.PI), 1e-6)
  almost(await evaluate('Math.sin(Math.PI * 2)'), Math.sin(Math.PI * 2), 1e-6)
  almost(await evaluate('Math.sin(1)'), Math.sin(1), 1e-6)
  ok(Number.isNaN(await evaluate('Math.sin(1 * 1e308 * 10)')))
  ok(Number.isNaN(await evaluate('Math.sin(-Infinity)')))
})

test('Math.cos', async () => {
  almost(await evaluate('Math.cos(0)'), Math.cos(0), 1e-6)
  almost(await evaluate('Math.cos(Math.PI / 2)'), Math.cos(Math.PI / 2), 1e-6)
  almost(await evaluate('Math.cos(Math.PI)'), Math.cos(Math.PI), 1e-6)
  almost(await evaluate('Math.cos(1)'), Math.cos(1), 1e-6)
  ok(Number.isNaN(await evaluate('Math.cos(Infinity)')))
  ok(Number.isNaN(await evaluate('Math.cos(-Infinity)')))
})

test('Math.tan', async () => {
  almost(await evaluate('Math.tan(0)'), Math.tan(0), 1e-6)
  almost(await evaluate('Math.tan(Math.PI / 4)'), Math.tan(Math.PI / 4), 1e-6)
  almost(await evaluate('Math.tan(1)'), Math.tan(1), 1e-6)
  ok(Number.isNaN(await evaluate('Math.tan(Infinity)')))
  ok(Number.isNaN(await evaluate('Math.tan(-Infinity)')))
})

// ============================================
// Inverse trigonometric functions
// ============================================

test('Math.asin', async () => {
  almost(await evaluate('Math.asin(0)'), Math.asin(0), 1e-6)
  almost(await evaluate('Math.asin(0.5)'), Math.asin(0.5), 1e-6)
  almost(await evaluate('Math.asin(1)'), Math.asin(1), 1e-6)
  almost(await evaluate('Math.asin(-0.5)'), Math.asin(-0.5), 1e-6)
})

test('Math.acos', async () => {
  almost(await evaluate('Math.acos(0)'), Math.acos(0), 1e-6)
  almost(await evaluate('Math.acos(0.5)'), Math.acos(0.5), 1e-6)
  almost(await evaluate('Math.acos(1)'), Math.acos(1), 1e-6)
  almost(await evaluate('Math.acos(-0.5)'), Math.acos(-0.5), 1e-6)
})

test('Math.atan', async () => {
  almost(await evaluate('Math.atan(0)'), Math.atan(0), 1e-5)
  almost(await evaluate('Math.atan(1)'), Math.atan(1), 1e-5)
  almost(await evaluate('Math.atan(-1)'), Math.atan(-1), 1e-5)
  almost(await evaluate('Math.atan(0.5)'), Math.atan(0.5), 1e-5)
})

test('Math.atan2', async () => {
  almost(await evaluate('Math.atan2(1, 1)'), Math.atan2(1, 1), 1e-6)
  almost(await evaluate('Math.atan2(1, 0)'), Math.atan2(1, 0), 1e-6)
  almost(await evaluate('Math.atan2(0, 1)'), Math.atan2(0, 1), 1e-6)
  almost(await evaluate('Math.atan2(-1, -1)'), Math.atan2(-1, -1), 1e-6)
  almost(await evaluate('Math.atan2(3, 4)'), Math.atan2(3, 4), 1e-6)
})

// ============================================
// Hyperbolic functions
// ============================================

test('Math.sinh', async () => {
  almost(await evaluate('Math.sinh(0)'), Math.sinh(0), 1e-5)
  almost(await evaluate('Math.sinh(1)'), Math.sinh(1), 1e-5)
  almost(await evaluate('Math.sinh(-1)'), Math.sinh(-1), 1e-5)
  almost(await evaluate('Math.sinh(2)'), Math.sinh(2), 1e-4)
})

test('Math.cosh', async () => {
  almost(await evaluate('Math.cosh(0)'), Math.cosh(0), 1e-5)
  almost(await evaluate('Math.cosh(1)'), Math.cosh(1), 1e-5)
  almost(await evaluate('Math.cosh(-1)'), Math.cosh(-1), 1e-5)
  almost(await evaluate('Math.cosh(2)'), Math.cosh(2), 1e-4)
})

test('Math.tanh', async () => {
  almost(await evaluate('Math.tanh(0)'), Math.tanh(0), 1e-6)
  almost(await evaluate('Math.tanh(1)'), Math.tanh(1), 1e-6)
  almost(await evaluate('Math.tanh(-1)'), Math.tanh(-1), 1e-6)
  almost(await evaluate('Math.tanh(100)'), 1, 1e-6)
  almost(await evaluate('Math.tanh(-100)'), -1, 1e-6)
})

// ============================================
// Inverse hyperbolic functions
// ============================================

test('Math.asinh', async () => {
  almost(await evaluate('Math.asinh(0)'), Math.asinh(0), 1e-6)
  almost(await evaluate('Math.asinh(1)'), Math.asinh(1), 1e-6)
  almost(await evaluate('Math.asinh(-1)'), Math.asinh(-1), 1e-6)
  almost(await evaluate('Math.asinh(2)'), Math.asinh(2), 1e-6)
})

test('Math.acosh', async () => {
  almost(await evaluate('Math.acosh(1)'), Math.acosh(1), 1e-6)
  almost(await evaluate('Math.acosh(2)'), Math.acosh(2), 1e-6)
  almost(await evaluate('Math.acosh(10)'), Math.acosh(10), 1e-6)
})

test('Math.atanh', async () => {
  almost(await evaluate('Math.atanh(0)'), Math.atanh(0), 1e-6)
  almost(await evaluate('Math.atanh(0.5)'), Math.atanh(0.5), 1e-6)
  almost(await evaluate('Math.atanh(-0.5)'), Math.atanh(-0.5), 1e-6)
  almost(await evaluate('Math.atanh(0.9)'), Math.atanh(0.9), 1e-6)
})

// ============================================
// Exponential and logarithmic functions
// ============================================

test('Math.exp', async () => {
  almost(await evaluate('Math.exp(0)'), Math.exp(0), 1e-6)
  almost(await evaluate('Math.exp(1)'), Math.exp(1), 1e-5)
  almost(await evaluate('Math.exp(-1)'), Math.exp(-1), 1e-6)
  almost(await evaluate('Math.exp(2)'), Math.exp(2), 1e-4)
})

test('Math.expm1', async () => {
  almost(await evaluate('Math.expm1(0)'), Math.expm1(0), 1e-6)
  almost(await evaluate('Math.expm1(1)'), Math.expm1(1), 1e-5)
  almost(await evaluate('Math.expm1(-1)'), Math.expm1(-1), 1e-6)
})

test('Math.log', async () => {
  almost(await evaluate('Math.log(1)'), Math.log(1), 1e-6)
  almost(await evaluate('Math.log(Math.E)'), Math.log(Math.E), 1e-6)
  almost(await evaluate('Math.log(10)'), Math.log(10), 1e-6)
  almost(await evaluate('Math.log(2)'), Math.log(2), 1e-6)
})

test('Math.log2', async () => {
  almost(await evaluate('Math.log2(1)'), Math.log2(1), 1e-6)
  almost(await evaluate('Math.log2(2)'), Math.log2(2), 1e-6)
  almost(await evaluate('Math.log2(8)'), Math.log2(8), 1e-6)
  almost(await evaluate('Math.log2(1024)'), Math.log2(1024), 1e-6)
})

test('Math.log10', async () => {
  almost(await evaluate('Math.log10(1)'), Math.log10(1), 1e-6)
  almost(await evaluate('Math.log10(10)'), Math.log10(10), 1e-6)
  almost(await evaluate('Math.log10(100)'), Math.log10(100), 1e-6)
  almost(await evaluate('Math.log10(1000)'), Math.log10(1000), 1e-6)
})

test('Math.log1p', async () => {
  almost(await evaluate('Math.log1p(0)'), Math.log1p(0), 1e-6)
  almost(await evaluate('Math.log1p(1)'), Math.log1p(1), 1e-6)
  almost(await evaluate('Math.log1p(Math.E - 1)'), Math.log1p(Math.E - 1), 1e-6)
})

// ============================================
// Power functions
// ============================================

test('Math.pow', async () => {
  is(await evaluate('Math.pow(2, 3)'), 8)
  is(await evaluate('Math.pow(2, 10)'), 1024)
  is(await evaluate('Math.pow(3, 2)'), 9)
  is(await evaluate('Math.pow(10, 0)'), 1)
  is(await evaluate('Math.pow(5, 1)'), 5)
  is(await evaluate('Math.pow(2, -1)'), 0.5)
  is(await evaluate('Math.pow(2, -2)'), 0.25)
})

test('** operator (power)', async () => {
  is(await evaluate('2 ** 3'), 8)
  is(await evaluate('2 ** 10'), 1024)
  is(await evaluate('3 ** 2'), 9)
  is(await evaluate('10 ** 0'), 1)
})

test('Math.pow / ** — constant-integer-exponent fold (bit-identical, stdlib-free)', async () => {
  // A constant integer exponent lowers to inline square-and-multiply instead of a
  // $math.pow call — bit-identical to the runtime integer fast path (proven below
  // against the non-folding runtime-exponent path), and pulling no stdlib.
  const m = run(`
    export let ref = (x, e) => x ** e
    export let p2 = (x) => x ** 2
    export let p3 = (x) => x ** 3
    export let p6 = (x) => x ** 6
    export let p8 = (x) => x ** 8
    export let pm2 = (x) => x ** -2
    export let p0 = (x) => x ** 0
    export let p1 = (x) => x ** 1
  `)
  is(m.p2(3), 9); is(m.p3(2), 8); is(m.p6(2), 64); is(m.p8(2), 256)
  is(m.pm2(2), 0.25); is(m.p0(7), 1); is(m.p1(5), 5)
  // Sign falls out of the f64 sign bit: even→positive, odd→signed; −0 survives.
  is(m.p3(-2), -8); is(m.p2(-2), 4)
  ok(Object.is(m.p3(-0), -0)); ok(Object.is(m.p2(-0), 0))
  // Every awkward operand matches the runtime $math.pow exactly (NaN/±Inf/±0/subnormal).
  for (const x of [0, -0, 1.1, -1.1, 3.14159, 1e150, NaN, Infinity, -Infinity, Number.MIN_VALUE]) {
    for (const [fn, n] of [[m.p2, 2], [m.p3, 3], [m.p6, 6], [m.p8, 8], [m.pm2, -2]])
      ok(Object.is(fn(x), m.ref(x, n)), `x=${x} n=${n}`)
  }
  // When every pow use folds, the math.pow/exp/log stdlib is gone entirely.
  const wat = compile(`export let f = (x) => x ** 2 + x ** 3`, { wat: true })
  ok(!/\(func \$math\.pow/.test(wat), 'math.pow stdlib elided')
  ok(!/\(func \$math\.exp/.test(wat), 'math.exp stdlib elided')
  ok(!/\(func \$math\.log/.test(wat), 'math.log stdlib elided')
})

test('Math.pow / ** — constant-non-integer-exponent inline (exp∘log, ~1e-9 rel. of $math.pow)', () => {
  // A constant NON-integer exponent lowers to inline exp(c·log x) — a fast, ~1e-9-relative-error
  // path (log's ~1.7e-11 rel. err composed with exp2's ~6e-9, jz's usual transcendental budget),
  // deliberately cheaper than a $math.pow call: no special-case ladder, no stdlib pull for
  // programs that only ever raise to a compile-time-constant power. $math.pow's own non-integer
  // tail ($math.pow_core, module/math.js) is a correctly-rounded fdlibm port instead — the two
  // no longer share an implementation, so they're close but not bit-identical (a ~1e-9 relative
  // gap is tens of millions of ULPs at this magnitude, hence `almost`, not `is`). The gamma
  // curves v**0.45 / a**(1/2.4) that dominate tone-mapping ride the fold.
  const m = run(`
    export let ref = (x, e) => x ** e          // runtime exponent → $math.pow (no fold) — the reference
    export let g45 = (x) => x ** 0.45
    export let gsrgb = (x) => x ** (1.0 / 2.4)
    export let gneg = (x) => x ** -1.5
  `)
  // within the fold's documented ~1e-9 relative budget of the correctly-rounded $math.pow path,
  // across finite values + every edge but -∞ (NaN/±0/1 land exactly, since log/exp carry them exactly).
  // `almost`'s eps is absolute, so scale it to the reference's own magnitude — a fixed eps is
  // meaningless once values range from Number.MIN_VALUE to 1e150.
  const relEps = (want) => Math.abs(want) * 1e-6
  for (const x of [0, -0, 0.5, 1, 2, 1.1, 3.14159, 47.032, 1e150, 1e-300, Infinity, Number.MIN_VALUE]) {
    almost(m.g45(x), m.ref(x, 0.45), relEps(m.ref(x, 0.45)), `0.45: x=${x}`)
    almost(m.gsrgb(x), m.ref(x, 1 / 2.4), relEps(m.ref(x, 1 / 2.4)), `1/2.4: x=${x}`)
    almost(m.gneg(x), m.ref(x, -1.5), relEps(m.ref(x, -1.5)), `-1.5: x=${x}`)
  }
  ok(Number.isNaN(m.g45(NaN)) && Number.isNaN(m.ref(NaN, 0.45)), 'NaN → NaN (matches $math.pow)')
  ok(Number.isNaN(m.g45(-3)) && Number.isNaN(m.ref(-3, 0.45)), '(-finite)**c = NaN (matches $math.pow)')
  // The ONE divergence: (-∞)**c is NaN here (log(-∞)=NaN) where spec Math.pow gives ±∞ — deliberate,
  // mirrors the (-∞)**0.5 sqrt trade; -∞ is never a real tone-map/gamma base.
  ok(Number.isNaN(m.g45(-Infinity)), '(-∞)**0.45 → NaN (deliberate boundary trade)')
  is(Math.pow(-Infinity, 0.45), Infinity)
  // A program whose only pow is a constant non-integer exponent never pulls $math.pow — it inlines
  // to exp(c·log x), so exp + log are present and the pow body is gone.
  const wat = compile(`export let f = (x) => x ** 0.45`, { wat: true })
  ok(!/\(func \$math\.pow/.test(wat), 'math.pow stdlib elided (inlined as exp∘log)')
  ok(/\(func \$math\.exp/.test(wat) && /\(func \$math\.log/.test(wat), 'exp + log stdlib present')
})

test('Math.pow / ** — positive-constant base lowers to exp (no pow/log stdlib)', async () => {
  const m = run(`export let f = (n) => 2 ** (n / 12)`)
  almost(m.f(5), Math.pow(2, 5 / 12), 1e-6)
  almost(m.f(0), 1, 1e-6)
  const wat = compile(`export let g = (n) => 440 * (2 ** (n / 12))`, { wat: true })
  ok(!/\(func \$math\.pow/.test(wat), 'math.pow stdlib elided for 2 ** (n/12)')
  ok(!/\(func \$math\.log/.test(wat), 'math.log stdlib elided')
  // exp route used — as a `$math.exp` func, or (since the O(1) loop-free exp is now
  // inlinable) its inlined body, identified by the Taylor coefficient 1/6.
  ok(/\(func \$math\.exp|0\.16666666666666666/.test(wat), 'uses math.exp (func or inlined)')
})

test('Math.cbrt', async () => {
  almost(await evaluate('Math.cbrt(8)'), 2, 1e-6)
  almost(await evaluate('Math.cbrt(27)'), 3, 1e-6)
  almost(await evaluate('Math.cbrt(1)'), 1, 1e-6)
  almost(await evaluate('Math.cbrt(-8)'), -2, 1e-6)
})

test('Math.hypot', async () => {
  is(await evaluate('Math.hypot(3, 4)'), 5)
  is(await evaluate('Math.hypot(5, 12)'), 13)
  is(await evaluate('Math.hypot(0, 5)'), 5)
  is(await evaluate('Math.hypot(1, 1)'), Math.hypot(1, 1))
})

// ============================================
// Integer and bit operations
// ============================================

test('Math.clz32', async () => {
  is(await evaluate('Math.clz32(1)'), 31)
  is(await evaluate('Math.clz32(2)'), 30)
  is(await evaluate('Math.clz32(4)'), 29)
  is(await evaluate('Math.clz32(256)'), 23)
  is(await evaluate('Math.clz32(0)'), 32)
})

test('Math.imul', async () => {
  is(await evaluate('Math.imul(3, 4)'), 12)
  is(await evaluate('Math.imul(5, 5)'), 25)
  is(await evaluate('Math.imul(-1, 8)'), -8)
  is(await evaluate('Math.imul(-1, 5)'), -5)
})

// ============================================
// Type check functions
// ============================================

test('isNaN (global)', async () => {
  is(await evaluate('isNaN(NaN)'), true)
  is(await evaluate('isNaN(0)'), false)
  is(await evaluate('isNaN(1)'), false)
  is(await evaluate('isNaN(Infinity)'), false)
  is(await evaluate('isNaN(-Infinity)'), false)
})

// Global isNaN (ECMA-262 19.2.3) ToNumber-COERCES its argument, unlike Number.isNaN
// (21.1.2.4) below, which does not. Contrast pins: same carrier, opposite verdict.
test('isNaN (global) coerces — contrast with non-coercing Number.isNaN', async () => {
  is(await evaluate('isNaN("hi")'), true)    // Number("hi") is NaN
  is(await evaluate('isNaN("42")'), false)   // Number("42") is 42
  is(await evaluate('isNaN(undefined)'), true)  // Number(undefined) is NaN
  is(await evaluate('isNaN(null)'), false)      // Number(null) is 0
  is(await evaluate('isNaN(true)'), false)      // Number(true) is 1
})

test('isFinite (global)', async () => {
  is(await evaluate('isFinite(0)'), true)
  is(await evaluate('isFinite(1)'), true)
  is(await evaluate('isFinite(-1)'), true)
  is(await evaluate('isFinite(Infinity)'), false)
  is(await evaluate('isFinite(-Infinity)'), false)
  is(await evaluate('isFinite(NaN)'), false)
})

// Number.isNaN (ECMA-262 21.1.2.4): "If Type(number) is not Number, return false" —
// NO ToNumber coercion. jz NaN-boxes strings/objects/arrays/undefined/null/booleans
// as NaN-shaped f64 carriers; a bare hardware self-compare (`x !== x`) can't tell a
// genuine number-NaN from one of those, so every non-Number carrier here used to read
// as `true` (jz) instead of `false` (JS) — the carrier-miscompile this pins against.
test('Number.isNaN', async () => {
  is(await evaluate('Number.isNaN(NaN)'), true)
  is(await evaluate('Number.isNaN(0)'), false)
  is(await evaluate('Number.isNaN(1)'), false)
  is(await evaluate('Number.isNaN("hi")'), false)          // NaN-boxed string carrier, not coerced
  is(await evaluate('Number.isNaN("NaN")'), false)
  is(await evaluate('Number.isNaN({})'), false)             // NaN-boxed object carrier
  is(await evaluate('Number.isNaN([1][2])'), false)         // OOB → represented-undefined is a NaN carrier
  is(await evaluate('Number.isNaN(undefined)'), false)      // NaN-boxed atom
  is(await evaluate('Number.isNaN(null)'), false)           // NaN-boxed atom
  is(await evaluate('Number.isNaN(true)'), false)           // NaN-boxed bool atom
  is(await evaluate('Number.isNaN(false)'), false)
  is(await evaluate('Number.isNaN(5n)'), false)              // BigInt is never a Number
  is(await evaluate('Number.isNaN(-5n)'), false)             // raw i64 carrier bits alias NaN-shaped f64
})

test('Number.isNaN: dynamic/polymorphic argument (not statically NUMBER)', () => {
  // A ternary-merged NUMBER∪other argument stays a genuinely runtime-typed f64 —
  // the compiler can't fold it to a literal, so this exercises the kind-unknown
  // runtime discrimination path, not just the static-literal short-circuit above.
  const src = `
    function isNaNOf(x) { return Number.isNaN(x) }
    export let f = (tag) => isNaNOf(
      tag === 0 ? 5 : tag === 1 ? "hi" : tag === 2 ? (0/0) : tag === 3 ? true : undefined)`
  const { f } = jz(src).exports
  is(f(0), false, 'number 5')
  is(f(1), false, 'string "hi"')
  is(f(2), true, 'real NaN')
  is(f(3), false, 'boolean true')
  is(f(4), false, 'undefined')
})

// Number.isFinite (21.1.2.2) / Number.isInteger (21.1.2.3) / Number.isSafeInteger
// (21.1.2.5) share the same "not a Number → false, no coercion" contract. Their raw
// arithmetic (`x === x && …`) already excludes every NaN-boxed pointer/atom carrier
// (self-compare fails on all of them) — the gap was specifically the RAW, non-NaN-
// boxed carriers: a static boolean (unboxed i32 0/1) and any BigInt (raw i64 sharing
// f64's bit-space with no tag at all) both convert/reinterpret to an ordinary finite
// float and used to read as true.
test('Number.isFinite', async () => {
  is(await evaluate('Number.isFinite(0)'), true)
  is(await evaluate('Number.isFinite(Infinity)'), false)
  is(await evaluate('Number.isFinite(NaN)'), false)
  is(await evaluate('Number.isFinite("42")'), false)
  is(await evaluate('Number.isFinite(true)'), false)
  is(await evaluate('Number.isFinite(false)'), false)
  is(await evaluate('Number.isFinite(null)'), false)
  is(await evaluate('Number.isFinite(undefined)'), false)
  is(await evaluate('Number.isFinite(0n)'), false)   // raw carrier bits ARE 0.0 — the sharpest repro
  is(await evaluate('Number.isFinite(5n)'), false)
})

test('Number.isInteger', async () => {
  is(await evaluate('Number.isInteger(1)'), true)
  is(await evaluate('Number.isInteger(1.5)'), false)
  is(await evaluate('Number.isInteger(0)'), true)
  is(await evaluate('Number.isInteger(true)'), false)
  is(await evaluate('Number.isInteger(false)'), false)
  is(await evaluate('Number.isInteger("1")'), false)
  is(await evaluate('Number.isInteger(0n)'), false)
})

test('Number.isSafeInteger', async () => {
  is(await evaluate('Number.isSafeInteger(1)'), true)
  is(await evaluate('Number.isSafeInteger(1.5)'), false)
  is(await evaluate('Number.isSafeInteger(2 ** 53)'), false)
  is(await evaluate('Number.isSafeInteger(true)'), false)
  is(await evaluate('Number.isSafeInteger(0n)'), false)
  is(await evaluate('Number.isSafeInteger("1")'), false)
})

test('Number.isFinite / Object.is: exact boolean chain — typeof guard && (!isFinite || Object.is(-0))', () => {
  // watr's print.js used exactly this composition (typeof-guarded, ||-short-
  // circuited) to decide whether a number leaf needs a WAT non-finite/-0 token.
  // Number.isFinite and Object.is are each correct standalone (pinned above /
  // in test/objects.js) — this pins the FULL composed chain, since the reported
  // in-kernel symptom ("finite 150 classified non-finite/-0") traced entirely to
  // the `typeof x === 'number'` fast-path folding false for NaN (see
  // test/statements.js's "typeof: NaN is still number" pin): once that's fixed,
  // this chain needs no changes of its own — verified here so a regression in
  // either operand would be caught immediately by the composition, not just in
  // isolation.
  const src = `export let f = (v) =>
    (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) ? 1 : 0`
  const { f } = jz(src).exports
  is(f(150), 0, '150: finite, not -0 — chain false')
  is(f(0), 0, '0: finite, not -0 (Object.is(0,-0) is false) — chain false')
  is(f(-5), 0, '-5: finite, not -0 — chain false')
  is(f(-0), 1, '-0: finite but Object.is(-0,-0) — chain true')
  is(f(NaN), 1, 'NaN: not finite — chain true')
  is(f(Infinity), 1, 'Infinity: not finite — chain true')
  is(f(-Infinity), 1, '-Infinity: not finite — chain true')
})

// ============================================
// Random
// ============================================

test('Math.random', async () => {
  const r1 = await evaluate('Math.random()')
  ok(r1 >= 0 && r1 < 1, `random() returned ${r1}`)

  const r2 = await evaluate('Math.random()')
  ok(r2 >= 0 && r2 < 1, `random() returned ${r2}`)

  const r3 = await evaluate('Math.random() * 100')
  ok(r3 >= 0 && r3 < 100, `random()*100 returned ${r3}`)
})

test('Math.random: entropy by default, reproducible only with randomSeed', () => {
  if (onKernel()) return  // kernel: host entropy import + {randomSeed} option are host-side, not in (code, strict)
  // Default is entropy-seeded — two fresh modules diverge (determinism is no longer the default).
  const a = jz('export let f = () => Math.random()').exports.f()
  const b = jz('export let f = () => Math.random()').exports.f()
  ok(a >= 0 && a < 1 && b >= 0 && b < 1, 'in [0,1)')
  ok(a !== b, 'entropy default → fresh instances differ')
  // A numeric randomSeed restores a fixed, reproducible sequence.
  const seeded = (n) => jz('export let f = () => Math.random()', { randomSeed: n }).exports.f()
  is(seeded(42), seeded(42))
})

test('Math.random: the entropy syscall is treeshaken when unused', () => {
  // Pay-for-use: a program that never calls Math.random pulls no rng seed import/path.
  is(/rngSeed|random_get/.test(compile('export let f = (x) => x + 1', { wat: true })), false)
  ok(/rngSeed|random_get|rng_seed/.test(compile('export let f = () => Math.random()', { wat: true })),
     'rng seed path present when Math.random is used')
})

// ============================================
// Combined expressions
// ============================================

test('Math expressions - combined', async () => {
  // Pythagorean identity: sin^2(x) + cos^2(x) = 1
  almost(await evaluate('Math.sin(1) * Math.sin(1) + Math.cos(1) * Math.cos(1)'), 1, 1e-6)

  // exp and log are inverses
  almost(await evaluate('Math.log(Math.exp(2))'), 2, 1e-4)
  almost(await evaluate('Math.exp(Math.log(3))'), 3, 1e-5)

  // pow and cbrt
  almost(await evaluate('Math.cbrt(Math.pow(5, 3))'), 5, 1e-6)

  // Complex expression
  almost(await evaluate('Math.sqrt(Math.pow(3, 2) + Math.pow(4, 2))'), 5, 1e-6)
})

// ============================================
// Modulo (%) operator
// ============================================

test('modulo - f64', async () => {
  is(await evaluate('10.5 % 3'), 10.5 % 3)
  is(await evaluate('7.0 % 2.0'), 7.0 % 2.0)
  is(await evaluate('5.5 % 1.5'), 5.5 % 1.5)
  is(await evaluate('-7.0 % 3.0'), -7.0 % 3.0)
})

test('modulo - integer', async () => {
  is(await evaluate('10 % 3'), 1)
  is(await evaluate('7 % 2'), 1)
  is(await evaluate('100 % 10'), 0)
  is(await evaluate('-7 % 3'), -1)
})

test('modulo - compound assignment (%=)', () => {
  is(run('export let f = () => { let x = 10.5; x %= 3; return x }').f(), 10.5 % 3)
  is(run('export let f = () => { let x = 10; x %= 3; return x }').f(), 1)
})

// ============================================
// Unsigned right shift — `>>> 0` is the canonical "to uint32" idiom.
// When the result crosses to f64 (division, template literal, return),
// the bit pattern must be interpreted unsigned. jz used to lift via
// f64.convert_i32_s, sign-flipping any value with high bit set.
// Repro found via biquad bench: `(s >>> 0) / 4294967296` PRNG idiom produced
// negative outputs for negative-i32 s. Fix: `>>>` marks node.unsigned=true;
// asF64 honors it and emits f64.convert_i32_u.
// ============================================

test('unsigned right shift - high bit f64 conversion', async () => {
  is(await evaluate('(-1 | 0) >>> 0'), 4294967295)
})

test('unsigned right shift - PRNG idiom produces [-1, 1)', () => {
  const code = `export let f = () => {
    let s = 0x80000001 | 0
    return ((s >>> 0) / 4294967296) * 2 - 1
  }`
  const got = run(code).f()
  ok(got >= -1 && got < 1, 'PRNG output must be in [-1, 1)')
})

test('unsigned right shift - division of high-bit value', async () => {
  // 3959422976 = 0xEC000000 — high bit set, fits u32, exceeds i31.
  is(await evaluate('((-335544320 | 0) >>> 0) / 4294967296'), 3959422976 / 4294967296)
})

// ---- Math.hypot n-ary (test262 builtins gate, 2026-07-10) -------------------
// The pre-eval MATH_KERNEL hypot was strictly 2-ary: hypot() folded to
// hypot(undefined,undefined)=NaN and hypot(3,4,12) silently dropped the third
// arg. Kernel now mirrors the runtime emitter's left-chained 2-ary calls.

test('Math: hypot arities (const-fold and runtime agree)', () => {
  is(run(`export let f = () => Math.hypot()`).f(), 0)
  is(run(`export let f = () => 1 / Math.hypot(0)`).f(), Infinity)
  is(run(`export let f = () => Math.hypot(-3)`).f(), 3)
  is(run(`export let f = () => Math.hypot(3, 4, 12)`).f(), 13)
  is(run(`export let f = () => Math.hypot(NaN, Infinity)`).f(), Infinity)
  is(run(`export let f = () => isNaN(Math.hypot(NaN, 1))`).f(), true)
  const r = run(`export let f = (a, b, c) => Math.hypot(a, b, c)`)
  is(r.f(3, 4, 12), 13)
})

// Decimal→f64 parse at the extremes — full-range Eisel-Lemire (references: host
// Number/parseFloat, V8; all values are exact IEEE-754 bit patterns).
test('Number/parseFloat: subnormals, deep exponents, 19-digit significands', async () => {
  for (const s of ['5e-324', '4.9406564584124654e-324', '2.2250738585072014e-308',
    '2.2250738585072011e-308', '1e-309', '9.99e-321', '5.357543035931338e+300',
    '1.7976931348623157e308', '1e309', '1152921504606847359', '1152921504606847105']) {
    is(await evaluate(`Number('${s}')`), Number(s), `Number('${s}')`)
    is(await evaluate(`parseFloat('${s}')`), parseFloat(s), `parseFloat('${s}')`)
  }
})

// ============================================
// Math.sumPrecise — exact, correctly-rounded summation (proposal-math-sum /
// test262 built-ins/Math/sumPrecise). Reference values from an exact
// BigInt-rational oracle: every finite f64 is k·2⁻¹⁰⁷⁴ with integer k; sum the
// k exactly, round once ties-to-even. Fuzz-verified bit-exact over 4000+
// random shapes (mixed magnitude, cancellation, sticky-tie, near-overflow).
// ============================================

test('Math.sumPrecise: correctly rounded where naive accumulation drifts', () => {
  const { f } = run(`export let f = (a) => Math.sumPrecise(a)`)
  is(f([0.1, 0.2]), 0.30000000000000004)           // exact sum of the two doubles — same as one IEEE add
  is(f([0.1, 0.2, -0.3]), 2.7755575615628914e-17)  // 2⁻⁵⁵ exactly; stepwise JS rounds twice to 2⁻⁵⁴
  is(f(Array(10000).fill(0.1)), 1000)              // naive += drifts below 1000
  is(f([1e308, 1e308, -1e308]), 1e308)             // intermediate overflow must not poison the sum
  is(f([-1e308, -1e308, 1e308]), -1e308)
  is(f([1e308, 1e-308, -1e308]), 1e-308)           // ~2000-bit cancellation leaves the tiny term
  is(f([2 ** 53, 1]), 2 ** 53)                     // exact halfway tie → even
  is(f([2 ** 53, 1, 5e-324]), 2 ** 53 + 2)         // one min-subnormal sticky bit tips the tie up
  is(f([1, 2 ** -53]), 1)
  is(f([1, 2 ** -53, 2 ** -105]), 1 + 2 ** -52)
})

test('Math.sumPrecise: zeros, infinities, NaN (spec edge table)', () => {
  const r = run(`
    export let f = (a) => Math.sumPrecise(a)
    export let inv = (a) => 1 / Math.sumPrecise(a)
  `)
  is(r.inv([]), -Infinity)              // empty → -0
  is(r.inv([-0, -0]), -Infinity)        // all -0 → -0
  is(r.inv([-0, 0]), Infinity)          // any +0 → +0
  is(r.inv([1, -1]), Infinity)          // exact cancel → +0
  is(r.f([Infinity, 1e308]), Infinity)
  is(r.f([-Infinity, -1e308]), -Infinity)
  ok(Number.isNaN(r.f([Infinity, -Infinity])))
  ok(Number.isNaN(r.f([NaN, 1])))
})

test('Math.sumPrecise: typed arrays — kind-aware reads, not stride-8 misreads', () => {
  // Int32Array elements are 4-byte lanes; the old raw stride-8 f64 load read
  // pairs of them as one garbage double (8.48e-314 for [1,2,3]). Every element
  // kind now routes through the runtime kind dispatch; int→f64 and f16/f32
  // promotion are exact, so equality against JS is bit-for-bit.
  const r = run(`
    export let i32 = () => Math.sumPrecise(new Int32Array([1, 2, 3]))
    export let u32 = (a, b) => Math.sumPrecise(new Uint32Array([a, b]))
    export let f32 = () => Math.sumPrecise(new Float32Array([0.1, 0.2]))
    export let f64v = () => Math.sumPrecise(new Float64Array([9, 1, 2, 3, 9]).subarray(1, 4))
    export let big = () => Math.sumPrecise(new BigInt64Array(2))
    export let bools = () => Math.sumPrecise([true, true])
  `)
  is(r.i32(), 6)
  is(r.u32(4000000000, 1), 4000000001)
  is(r.f32(), Math.fround(0.1) + Math.fround(0.2))
  is(r.f64v(), 6)
  // spec throws TypeError on non-number elements (BigInt, booleans); jz's total
  // error model maps those to NaN (see README error-model limits)
  ok(Number.isNaN(r.big()))
  ok(Number.isNaN(r.bools()))
  // host-marshaled TYPED param with no ctor named in source still dispatches
  const lone = run(`export let sp = (a) => Math.sumPrecise(a)`)
  is(lone.sp(new Int32Array([10, 20, 30])), 60)
  is(lone.sp(new Float64Array([0.1, 0.2])), 0.30000000000000004)
  ok(Number.isNaN(lone.sp(null)))       // spec TypeError → total NaN
})

test('Math.atan2: signed-zero and infinite-quadrant table (ES 21.3.2.5)', () => {
  // The x<0 fixup adds ±π with the sign of y — a plain y≥0 test reads -0 as
  // nonnegative (atan2(-0,-1) returned +π), and ∞/∞ reached atan(NaN).
  const r = run(`
    export let f = (y, x) => Math.atan2(y, x)
    export let inv = (y, x) => 1 / Math.atan2(y, x)
  `)
  is(r.f(-0, -1), -Math.PI)
  is(r.f(0, -1), Math.PI)
  is(r.f(Infinity, Infinity), Math.PI / 4)
  is(r.f(-Infinity, Infinity), -Math.PI / 4)
  is(r.f(Infinity, -Infinity), 3 * Math.PI / 4)
  is(r.f(-Infinity, -Infinity), -3 * Math.PI / 4)
  is(r.f(Infinity, 1), Math.PI / 2)
  is(r.inv(-0, 1), -Infinity)           // atan2(-0, +x) is -0
  is(r.inv(-0, 0), -Infinity)           // atan2(-0, +0) is -0
})

test('Math.hypot/asinh/acosh: no spurious overflow/underflow at range extremes', () => {
  // hypot scales by an exact power of two before squaring (x²+y² overflowed to
  // Inf at 1e300 and flushed to 0 at 1e-300); asinh/acosh switch to
  // log(x) + ln 2 once x² would overflow (asinh(1e300) returned Infinity).
  const r = run(`
    export let hy = (a, b) => Math.hypot(a, b)
    export let as = (a) => Math.asinh(a)
    export let ac = (a) => Math.acosh(a)
  `)
  is(r.hy(1e300, 1e300), 1.4142135623730952e+300)
  ok(Math.abs(r.hy(1e-300, 1e-300) / 1.4142135623730952e-300 - 1) < 1e-15)  // √2·1e-300, kernel ±1 ulp
  is(r.hy(5e-324, 0), 5e-324)
  almost(r.as(1e300), 691.4686750787736, 1e-10)   // = log(1e300) + ln 2
  almost(r.as(-1e300), -691.4686750787736, 1e-10)
  almost(r.ac(1e300), 691.4686750787736, 1e-10)
  ok(Number.isNaN(r.ac(0.5)))
})
