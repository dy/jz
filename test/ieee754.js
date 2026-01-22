/**
 * IEEE 754 Edge Cases - test262 inspired
 * Tests for proper handling of special floating point values
 * These test WASM's natural IEEE 754 behavior, not JS quirks
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluate } from './util.js'

// ============================================================
// Infinity arithmetic
// ============================================================

test('IEEE 754: Infinity arithmetic', async () => {
  // Infinity + finite = Infinity
  is(await evaluate('Infinity + 1'), Infinity)
  is(await evaluate('-Infinity + 1'), -Infinity)

  // Infinity + -Infinity = NaN
  ok(isNaN(await evaluate('Infinity + -Infinity')))

  // Infinity * finite = Infinity (with sign)
  is(await evaluate('Infinity * 2'), Infinity)
  is(await evaluate('Infinity * -2'), -Infinity)

  // Infinity * 0 = NaN
  ok(isNaN(await evaluate('Infinity * 0')))

  // Infinity / finite = Infinity
  is(await evaluate('Infinity / 2'), Infinity)

  // finite / Infinity = 0
  is(await evaluate('1 / Infinity'), 0)

  // Infinity / Infinity = NaN
  ok(isNaN(await evaluate('Infinity / Infinity')))

  // Infinity % finite = NaN
  ok(isNaN(await evaluate('Infinity % 1')))

  // finite % Infinity = finite
  is(await evaluate('5 % Infinity'), 5)
})

// ============================================================
// NaN propagation
// ============================================================

test('IEEE 754: NaN propagation', async () => {
  // NaN in any arithmetic = NaN
  ok(isNaN(await evaluate('NaN + 1')))
  ok(isNaN(await evaluate('NaN - 1')))
  ok(isNaN(await evaluate('NaN * 2')))
  ok(isNaN(await evaluate('NaN / 2')))
  ok(isNaN(await evaluate('NaN % 2')))
  ok(isNaN(await evaluate('1 + NaN')))
  ok(isNaN(await evaluate('NaN + NaN')))

  // NaN comparisons - IEEE 754 compliant
  // NaN is not equal to anything, including itself
  is(await evaluate('NaN == NaN'), 0)  // IEEE 754: NaN != NaN
  is(await evaluate('NaN < 1'), 0)
  is(await evaluate('NaN > 1'), 0)
  is(await evaluate('NaN <= 1'), 0)
  is(await evaluate('NaN >= 1'), 0)
  is(await evaluate('NaN != NaN'), 1)  // IEEE 754: NaN != NaN
})

// ============================================================
// Division edge cases
// ============================================================

test('IEEE 754: Division by zero', async () => {
  // Non-zero / 0 = ±Infinity
  is(await evaluate('1 / 0'), Infinity)
  is(await evaluate('-1 / 0'), -Infinity)

  // 0 / 0 = NaN
  ok(isNaN(await evaluate('0 / 0')))
})

test('IEEE 754: Modulus edge cases', async () => {
  // x % 0 = NaN
  ok(isNaN(await evaluate('1 % 0')))

  // 0 % x = 0 (for x != 0)
  is(await evaluate('0 % 5'), 0)
})

// ============================================================
// Exponentiation edge cases
// ============================================================

test('IEEE 754: Exponentiation', async () => {
  // x ** 0 = 1 (including NaN!)
  is(await evaluate('NaN ** 0'), 1)
  is(await evaluate('Infinity ** 0'), 1)
  is(await evaluate('0 ** 0'), 1)

  // 0 ** negative = Infinity
  is(await evaluate('0 ** -1'), Infinity)

  // 0 ** positive = 0
  is(await evaluate('0 ** 2'), 0)

  // Infinity ** positive = Infinity
  is(await evaluate('Infinity ** 2'), Infinity)

  // Infinity ** negative = 0
  is(await evaluate('Infinity ** -1'), 0)
})

// ============================================================
// Bitwise ToInt32 conversion
// ============================================================

test('ToInt32: Large number wrap-around', async () => {
  // Numbers > 2^31 wrap around
  is(await evaluate('2147483648 | 0'), -2147483648) // 2^31 becomes -2^31
  is(await evaluate('4294967296 | 0'), 0)           // 2^32 becomes 0
  is(await evaluate('4294967295 | 0'), -1)          // 2^32 - 1 becomes -1
})

test('ToInt32: Float truncation', async () => {
  is(await evaluate('1.9 | 0'), 1)
  is(await evaluate('~1.9'), -2)  // trunc to 1, then ~1 = -2
})

test('Shift amount masking (& 31)', async () => {
  // Shift amounts are masked to 5 bits (0-31)
  is(await evaluate('1 << 32'), 1)   // 32 & 31 = 0
  is(await evaluate('1 << 33'), 2)   // 33 & 31 = 1
  is(await evaluate('8 >> 35'), 1)   // 35 & 31 = 3
})

test('Unsigned right shift (>>>)', async () => {
  is(await evaluate('-1 >>> 0'), 4294967295)  // All 1s as unsigned
  is(await evaluate('-1 >>> 1'), 2147483647)
  is(await evaluate('-8 >>> 2'), 1073741822)
})

// ============================================================
// Math function edge cases
// ============================================================

test('Math functions with special values', async () => {
  // sqrt
  is(await evaluate('Math.sqrt(Infinity)'), Infinity)
  ok(isNaN(await evaluate('Math.sqrt(-1)')))

  // abs
  is(await evaluate('Math.abs(-Infinity)'), Infinity)
  ok(isNaN(await evaluate('Math.abs(NaN)')))

  // floor/ceil/trunc with Infinity
  is(await evaluate('Math.floor(Infinity)'), Infinity)
  is(await evaluate('Math.ceil(-Infinity)'), -Infinity)

  // min/max
  is(await evaluate('Math.min(1, Infinity)'), 1)
  is(await evaluate('Math.max(1, -Infinity)'), 1)
})

// ============================================================
// Comparison edge cases
// ============================================================

test('Infinity comparisons', async () => {
  is(await evaluate('Infinity > 1e308'), 1)
  is(await evaluate('-Infinity < -1e308'), 1)
  is(await evaluate('Infinity == Infinity'), 1)
  is(await evaluate('Infinity > -Infinity'), 1)
})
