import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import { evaluate } from './util.js'

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
  is(await evaluate('Math.round(-3.5)'), -4)
  is(await evaluate('Math.round(3)'), 3)
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

// ============================================
// Trigonometric functions
// ============================================

test('Math.sin', async () => {
  almost(await evaluate('Math.sin(0)'), Math.sin(0), 1e-6)
  almost(await evaluate('Math.sin(Math.PI / 2)'), Math.sin(Math.PI / 2), 1e-6)
  almost(await evaluate('Math.sin(Math.PI)'), Math.sin(Math.PI), 1e-6)
  almost(await evaluate('Math.sin(Math.PI * 2)'), Math.sin(Math.PI * 2), 1e-6)
  almost(await evaluate('Math.sin(1)'), Math.sin(1), 1e-6)
})

test('Math.cos', async () => {
  almost(await evaluate('Math.cos(0)'), Math.cos(0), 1e-6)
  almost(await evaluate('Math.cos(Math.PI / 2)'), Math.cos(Math.PI / 2), 1e-6)
  almost(await evaluate('Math.cos(Math.PI)'), Math.cos(Math.PI), 1e-6)
  almost(await evaluate('Math.cos(1)'), Math.cos(1), 1e-6)
})

test('Math.tan', async () => {
  almost(await evaluate('Math.tan(0)'), Math.tan(0), 1e-6)
  almost(await evaluate('Math.tan(Math.PI / 4)'), Math.tan(Math.PI / 4), 1e-6)
  almost(await evaluate('Math.tan(1)'), Math.tan(1), 1e-6)
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
  is(await evaluate('isNaN(NaN)'), 1)
  is(await evaluate('isNaN(0)'), 0)
  is(await evaluate('isNaN(1)'), 0)
  is(await evaluate('isNaN(Infinity)'), 0)
  is(await evaluate('isNaN(-Infinity)'), 0)
})

test('isFinite (global)', async () => {
  is(await evaluate('isFinite(0)'), 1)
  is(await evaluate('isFinite(1)'), 1)
  is(await evaluate('isFinite(-1)'), 1)
  is(await evaluate('isFinite(Infinity)'), 0)
  is(await evaluate('isFinite(-Infinity)'), 0)
  is(await evaluate('isFinite(NaN)'), 0)
})

test('Number.isNaN', async () => {
  is(await evaluate('Number.isNaN(NaN)'), 1)
  is(await evaluate('Number.isNaN(0)'), 0)
  is(await evaluate('Number.isNaN(1)'), 0)
})

test('Number.isFinite', async () => {
  is(await evaluate('Number.isFinite(0)'), 1)
  is(await evaluate('Number.isFinite(Infinity)'), 0)
  is(await evaluate('Number.isFinite(NaN)'), 0)
})

test('Number.isInteger', async () => {
  is(await evaluate('Number.isInteger(1)'), 1)
  is(await evaluate('Number.isInteger(1.5)'), 0)
  is(await evaluate('Number.isInteger(0)'), 1)
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
