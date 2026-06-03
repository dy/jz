// Number methods (toString/toFixed/toExponential/toPrecision), numeric coercion
// (Number()/parseFloat/unary +/String()), and template-literal interpolation.
// String-method tests (charAt/charCodeAt/at/search/match) live in strings.js.
import test from 'tst'
import { is } from 'tst/assert.js'
import { run } from './util.js'

// === toString ===

test('Number: toString integer', () => {
  is(run(`export let f = () => { let n = 42; return n.toString().length }`).f(), 2)
})

test('Number: toString zero', () => {
  is(run(`export let f = () => { let n = 0; return n.toString().length }`).f(), 1)
})

test('Number: toString negative', () => {
  is(run(`export let f = () => { let n = -7; return n.toString().length }`).f(), 2)
})

test('Number: toString float', () => {
  is(run(`export let f = () => { let n = 1.5; return n.toString().length }`).f(), 3)
})

test('Number: toString large', () => {
  is(run(`export let f = () => { let n = 123456; return n.toString().length }`).f(), 6)
})

test('Number: toString NaN', () => {
  is(run(`export let f = () => (0/0).toString().length`).f(), 3)
})

test('Number: toString Infinity', () => {
  is(run(`export let f = () => (1/0).toString().length`).f(), 8)
})

test('Number: toString -Infinity', () => {
  is(run(`export let f = () => (-1/0).toString().length`).f(), 9)
})

test('Number: toString large int', () => {
  is(run(`export let f = () => { let n = 9999999999; return n.toString().length }`).f(), 10)
})

test('Number: toString 1e15', () => {
  is(run(`export let f = () => { let n = 1000000000000000; return n.toString().length }`).f(), 16)
})

// __ftoa was stripping trailing zeros from the integer part when prec=0 (auto-fit
// reduces prec because scaled value won't fit i32). Repro: 1079623680 → "107962368".
// Found via biquad bench when `(s >>> 0) / 4294967296` style PRNG output got
// stringified via template literal. Fix: gate strip-trailing-zeros on prec>0.
test('Number: toString preserves trailing zero in integer', () => {
  is(run(`export let f = () => { let n = 1079623680; return n.toString().length }`).f(), 10)
})

test('Number: toString preserves multiple trailing zeros in integer', () => {
  is(run(`export let f = () => { let n = 1234567000; return n.toString().length }`).f(), 10)
})

test('Number: toString preserves trailing zero through computed value', () => {
  // The original bench bug surfaced via template-literal interpolation of an
  // i32-spec'd value. Compute a value with trailing zero so it can't fold,
  // then stringify. Without the fix, "1079623680" became "107962368" (length 9).
  is(run(`export let f = () => { let n = 539811840 + 539811840; return n.toString().length }`).f(), 10)
})

// === toString(radix) — spec-compliant range validation ===
// Per 21.1.3.6: radix coerces to integer in [2, 36]; otherwise RangeError.
// Pre-fix: radix=1 hung the digit loop, radix=0 trapped 'remainder by zero',
// radix=37 / -1 silently returned wrong digit strings.

test('Number: toString(2) binary', () => {
  is(run(`export let f = () => (15).toString(2).length`).f(), 4)  // "1111"
})

test('Number: toString(16) hex', () => {
  is(run(`export let f = () => (255).toString(16).length`).f(), 2)  // "ff"
})

test('Number: toString(36) max', () => {
  is(run(`export let f = () => (35).toString(36).length`).f(), 1)  // "z"
})

test('Number: toString(1) throws (caught)', () => {
  is(run(`export let f = () => { try { (15).toString(1); return 0 } catch (e) { return 1 } }`).f(), 1)
})

test('Number: toString(37) throws (caught)', () => {
  is(run(`export let f = () => { try { (15).toString(37); return 0 } catch (e) { return 1 } }`).f(), 1)
})

test('Number: toString(0) throws (caught)', () => {
  is(run(`export let f = () => { try { (15).toString(0); return 0 } catch (e) { return 1 } }`).f(), 1)
})

test('Number: toString(-1) throws (caught)', () => {
  is(run(`export let f = () => { try { (15).toString(-1); return 0 } catch (e) { return 1 } }`).f(), 1)
})

test('Number: toString(dyn-radix) ok then bad', () => {
  is(run(`export let f = (r) => { try { return (255).toString(r).length } catch (e) { return -1 } }`).f(16), 2)
  is(run(`export let f = (r) => { try { return (255).toString(r).length } catch (e) { return -1 } }`).f(50), -1)
})

// === toFixed ===

test('Number: toFixed(2)', () => {
  is(run(`export let f = () => { let n = 3.14159; return n.toFixed(2).length }`).f(), 4)
})

test('Number: toFixed(0) rounds', () => {
  is(run(`export let f = () => { let n = 3.7; return n.toFixed(0).length }`).f(), 1)
})

test('Number: toFixed(3) pads', () => {
  is(run(`export let f = () => { let n = 1; return n.toFixed(3).length }`).f(), 5)
})

// === toExponential ===

test('Number: toExponential(2)', () => {
  is(run(`export let f = () => { let n = 123; return n.toExponential(2).length }`).f(), 7)
})

test('Number: toExponential(0)', () => {
  is(run(`export let f = () => { let n = 5; return n.toExponential(0).length }`).f(), 4)
})

test('Number: toExponential small', () => {
  is(run(`export let f = () => { let n = 0.0042; return n.toExponential(1).length }`).f(), 6)
})

// === toPrecision ===

test('Number: toPrecision(5) fixed', () => {
  is(run(`export let f = () => { let n = 123; return n.toPrecision(5).length }`).f(), 6)
})

test('Number: toPrecision(2) exponential', () => {
  is(run(`export let f = () => { let n = 123; return n.toPrecision(2).length }`).f(), 6)
})

test('Number: toPrecision(3) float', () => {
  is(run(`export let f = () => { let n = 1.5; return n.toPrecision(3).length }`).f(), 4)
})

// === String() / expression toString ===

test('Number: String(42)', () => {
  is(run(`export let f = () => String(42).length`).f(), 2)
})

test('String: no argument returns empty string', () => {
  is(run(`export let f = () => String() === ''`).f(), true)
})

test('String: nullish, string, and number coercion', () => {
  is(run(`export let f = () => (String(null) === 'null') + (String(undefined) === 'undefined') + (String('x') === 'x') + (String(3) === '3')`).f(), 4)
})

test('Number: unary plus string coerces', () => {
  is(run(`export let f = () => +"0"`).f(), 0)
})

test('Number: unary plus variable string coerces', () => {
  is(run(`export let f = () => { let s = "12"; return +s + 1 }`).f(), 13)
})

test('Number: Number(string) coerces', () => {
  is(run(`export let f = () => Number("7.5")`).f(), 7.5)
})

test('Number: parseFloat common decimal parity', () => {
  is(run(`export let f = () =>
    (parseFloat("6.28318530717958623") === 6.283185307179586) +
    (parseFloat("0.1") === 0.1) +
    (parseFloat("1e2") === 100) +
    (parseFloat("1e-2") === 0.01) +
    (parseFloat("1e") === 1) +
    (parseFloat("1e-") === 1) +
    (parseFloat(".5") === 0.5) +
    (parseFloat("000.00000123456789012345") === 0.00000123456789012345) +
    (parseFloat("123456789012345678901") === 123456789012345680000) +
    isNaN(parseFloat("."))`).f(), 10)
})

test('Number: parseFloat coerces non-string via ToString', () => {
  // Per JS spec, parseFloat(x) calls ToString(x) first. Array → "4", number → "12.5".
  is(run(`export let f = () => parseFloat([4])`).f(), 4)
  is(run(`export let f = () => parseFloat(12.5)`).f(), 12.5)
})

test('Number: String(0)', () => {
  is(run(`export let f = () => String(0).length`).f(), 1)
})

test('Number: (1+2).toString()', () => {
  is(run(`export let f = () => (1+2).toString().length`).f(), 1)
})

// === Template literal coercion ===

test('Template: number interpolation', () => {
  is(run('export let f = () => `n=${42}`.length').f(), 4)
})

test('Template: multiple interpolations', () => {
  is(run('export let f = () => `${1}+${2}=${1+2}`.length').f(), 5)
})

test('Template: string var interpolation', () => {
  is(run('export let f = () => { let s = "world"; return `hello ${s}`.length }').f(), 11)
})

test('Template: float interpolation', () => {
  is(run('export let f = () => `pi=${3.14}`.length').f(), 7)
})

// Documented divergence: subscript parses the leading-zero form as decimal, so a
// legacy octal literal is its decimal digits (not octal, and not the SyntaxError a
// JS module/strict mode raises). Use 0o377 for octal. See README "Where does jz differ".
test('Number: legacy octal literal is decimal (documented divergence)', () => {
  is(run(`export let f = () => 0377`).f(), 377)   // not 255
  is(run(`export let f = () => 0o377`).f(), 255)  // explicit octal is correct
})

// === Regression: String() large-value fraction-drop + trap ===
// Pre-fix, the __ftoa fit loop reduced precision until the scaled integer fit i32, which
// (a) dropped the fractional part once floor(val) exceeded ~2^31, and (b) trapped on the
// large-integer digit-extraction path for values just below the 1e21 exponential threshold
// (a per-digit subtraction could go slightly negative under f64 rounding → i32.trunc_f64_u trap).
test('Number: String() preserves the fraction when the integer part exceeds 2^31', () => {
  is(run(`export let f = () => String(1073741824.5)`).f(), String(1073741824.5))   // '1073741824.5'
  is(run(`export let f = () => String(4294967295.5)`).f(), String(4294967295.5))   // '4294967295.5'
})

test('Number: String() does not trap for large values below 1e21', () => {
  is(run(`export let f = () => String(999999900000000000000)`).f(), String(999999900000000000000))
})
