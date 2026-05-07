// Number and String method tests
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
  // i32-shaped value. Compute a value with trailing zero so it can't fold,
  // then stringify. Without the fix, "1079623680" became "107962368" (length 9).
  is(run(`export let f = () => { let n = 539811840 + 539811840; return n.toString().length }`).f(), 10)
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
  is(run(`export let f = () => String() === ''`).f(), 1)
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

// === charAt, charCodeAt, at ===

test('String: charAt', () => {
  is(run(`export let f = () => "hello".charAt(1).charCodeAt(0)`).f(), 101)
})

test('String: charCodeAt', () => {
  is(run(`export let f = () => "ABC".charCodeAt(0)`).f(), 65)
})

test('String: charCodeAt(2)', () => {
  is(run(`export let f = () => "ABC".charCodeAt(2)`).f(), 67)
})

test('String: at positive', () => {
  is(run(`export let f = () => "hello".at(0).charCodeAt(0)`).f(), 104)
})

test('String: at negative', () => {
  is(run(`export let f = () => "hello".at(-1).charCodeAt(0)`).f(), 111)
})

// === search / match ===

test('String: search found', () => {
  is(run(`export let f = () => "hello world".search("world")`).f(), 6)
})

test('String: search not found', () => {
  is(run(`export let f = () => "hello".search("xyz")`).f(), -1)
})

test('String: match found', () => {
  is(run(`export let f = () => "hello world".match("world").length`).f(), 1)
})

test('String: match not found', () => {
  is(run(`export let f = () => "hello".match("xyz")`).f(), 0)
})

test('String: match result content', () => {
  is(run(`export let f = () => "hello world".match("world")[0].length`).f(), 5)
})
