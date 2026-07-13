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

test('isFinite (global)', async () => {
  is(await evaluate('isFinite(0)'), true)
  is(await evaluate('isFinite(1)'), true)
  is(await evaluate('isFinite(-1)'), true)
  is(await evaluate('isFinite(Infinity)'), false)
  is(await evaluate('isFinite(-Infinity)'), false)
  is(await evaluate('isFinite(NaN)'), false)
})

test('Number.isNaN', async () => {
  is(await evaluate('Number.isNaN(NaN)'), true)
  is(await evaluate('Number.isNaN(0)'), false)
  is(await evaluate('Number.isNaN(1)'), false)
})

test('Number.isFinite', async () => {
  is(await evaluate('Number.isFinite(0)'), true)
  is(await evaluate('Number.isFinite(Infinity)'), false)
  is(await evaluate('Number.isFinite(NaN)'), false)
})

test('Number.isInteger', async () => {
  is(await evaluate('Number.isInteger(1)'), true)
  is(await evaluate('Number.isInteger(1.5)'), false)
  is(await evaluate('Number.isInteger(0)'), true)
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
