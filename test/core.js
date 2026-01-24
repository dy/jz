import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile, instantiate } from '../index.js'
import { evaluate, evaluateWat } from './util.js'
import { assemble } from '../src/compile.js'
import { compile as compileWat } from 'watr'

// MVP Test Suite - Focused on what works with current implementation

test('Basic arithmetic operations', async () => {
  is(await evaluateWat('(f64.add (f64.const 1) (f64.const 2))'), 3)
  is(await evaluateWat('(f64.sub (f64.const 5) (f64.const 2))'), 3)
  is(await evaluateWat('(f64.mul (f64.const 3) (f64.const 4))'), 12)
  is(await evaluateWat('(f64.div (f64.const 10) (f64.const 2))'), 5)
  is(await evaluateWat('(f64.add (f64.const 2) (f64.mul (f64.const 3) (f64.const 4)))'), 14)
  is(await evaluateWat('(f64.mul (f64.add (f64.const 2) (f64.const 3)) (f64.const 4))'), 20)
})

test('Numeric literals', async () => {
  is(await evaluateWat('(f64.const 1)'), 1)
  is(await evaluateWat('(f64.const 3.14)'), 3.14)
  is(await evaluateWat('(f64.const 1000)'), 1000)
})

test('Operator precedence', async () => {
  is(await evaluateWat('(f64.add (f64.const 1) (f64.mul (f64.const 2) (f64.const 3)))'), 7)
  is(await evaluateWat('(f64.mul (f64.add (f64.const 1) (f64.const 2)) (f64.const 3))'), 9)
  is(await evaluateWat('(f64.sub (f64.const 10) (f64.div (f64.const 4) (f64.const 2)))'), 8)
})

test('Edge cases', async () => {
  is(await evaluateWat('(f64.add (f64.const 0) (f64.const 5))'), 5)
  is(await evaluateWat('(f64.mul (f64.const 5) (f64.const 0))'), 0)
  is(await evaluateWat('(f64.add (f64.const -1) (f64.const 3))'), 2)
  is(await evaluateWat('(f64.add (f64.const 1.5) (f64.const 2.5))'), 4)
})

test('WebAssembly compilation', () => {
  const wat = assemble('(f64.add (f64.const 1) (f64.const 1))')
  const wasm = compileWat(wat)
  ok(wasm instanceof Uint8Array)
  ok(wasm.byteLength > 0)
  console.log('WASM size:', wasm.byteLength, 'bytes')
})

test('Error handling', async () => {
  throws(() => compile('1 + '))
})



test('test262 literals - numeric', async () => {
  // From test262/test/language/literals/numeric/S7.8.3_A3.2_T1.js
  is(await evaluate('0.0'), 0)
  is(await evaluate('1.0'), 1)
  is(await evaluate('2.0'), 2)
  is(await evaluate('3.14'), 3.14)
})

test('test262 literals - binary', async () => {
  // From test262/test/language/literals/numeric/binary.js
  is(await evaluate('0b0'), 0)
  is(await evaluate('0b1'), 1)
  is(await evaluate('0b10'), 2)
  is(await evaluate('0b11'), 3)
  is(await evaluate('0B0'), 0)
  is(await evaluate('0B1'), 1)
})

test('test262 literals - octal', async () => {
  // From test262/test/language/literals/numeric/octal.js
  is(await evaluate('0o10'), 8)
  is(await evaluate('0o11'), 9)
  is(await evaluate('0O10'), 8)
})

test('test262 literals - hex', async () => {
  // From test262/test/language/literals/numeric/hex.js
  is(await evaluate('0x10'), 16)
  is(await evaluate('0x1a'), 26)
  is(await evaluate('0X10'), 16)
})

test('test262 expressions - addition', async () => {
  // From test262/test/language/expressions/addition
  is(await evaluate('1 + 2'), 3)
  is(await evaluate('2 + 3'), 5)
  is(await evaluate('0 + 5'), 5)
})

test('test262 expressions - subtraction', async () => {
  is(await evaluate('5 - 2'), 3)
  is(await evaluate('10 - 5'), 5)
})

test('test262 expressions - multiplication', async () => {
  is(await evaluate('3 * 4'), 12)
  is(await evaluate('2 * 3'), 6)
})

test('test262 expressions - division', async () => {
  is(await evaluate('10 / 2'), 5)
  is(await evaluate('15 / 3'), 5)
})

test('test262 expressions - precedence', async () => {
  is(await evaluate('2 + 3 * 4'), 14)
  is(await evaluate('10 - 4 / 2'), 8)
})

test('test262 expressions - unary', async () => {
  is(await evaluate('-1'), -1)
  is(await evaluate('+1'), 1)
})

test('operators - comparisons (boolean as 0/1)', async () => {
  is(await evaluate('1 < 2'), 1)
  is(await evaluate('2 < 1'), 0)
  is(await evaluate('2 <= 2'), 1)
  is(await evaluate('3 > 2'), 1)
  is(await evaluate('3 >= 4'), 0)
  is(await evaluate('3 == 3'), 1)
  // NOTE: '!=' is deferred (parser tokenization differs in current subscript build).
})

test('operators - bitwise and shifts (via stdlib)', async () => {
  is(await evaluate('5 & 3'), 1)
  is(await evaluate('5 | 2'), 7)
  is(await evaluate('5 ^ 1'), 4)
  is(await evaluate('~0'), -1)
  is(await evaluate('1 << 3'), 8)
  is(await evaluate('8 >> 1'), 4)
  // NOTE: unsigned shift (>>>) and short-circuit logicals are deferred until
  // we add a proper function-body codegen path (needs locals and blocks).
})

test('test262 literals - boolean', async () => {
  is(await evaluate('true'), 1)
  is(await evaluate('false'), 0)
})

test('meaningful-base coercions (piezo-ish)', async () => {
  // logical: returns actual values (like JS/piezo), not booleanized
  is(await evaluate('1 && 2'), 2) // truthy && x = x
  is(await evaluate('0 && 2'), 0) // falsy && x = 0
  is(await evaluate('0 || 2'), 2) // falsy || x = x
  is(await evaluate('1 || 2'), 1) // truthy || x = truthy
  is(await evaluate('!2'), 0)
  is(await evaluate('!0'), 1)

  // arithmetic: numeric domain (f64)
  is(await evaluate('true + 2'), 3) // true coerces to 1

  // bitwise: integer i32 domain
  is(await evaluate('true & 3'), 1)
  is(await evaluate('~1.9'), -2) // trunc(1.9)=1; ~1 == -2

  // coalesce: Memory mode can't distinguish 0 from null (both f64 0.0)
  // So ?? treats 0, null, undefined all as non-nullish (returns value, not fallback)
  is(await evaluate('1 ?? 9'), 1)
  is(await evaluate('0 ?? 9'), 0)
  is(await evaluate('null ?? 9'), 0)      // null is 0 in memory mode
  is(await evaluate('undefined ?? 9'), 0)  // undefined is 0 in memory mode

  // ternary: condition is booleanized; branches conciliate
  is(await evaluate('1 ? 2 : 3'), 2)
  is(await evaluate('0 ? 2 : 3'), 3)
  is(await evaluate('1 ? true : false'), 1)
  is(await evaluate('0 ? true : false'), 0)
})

test('short-circuit (no rhs evaluation)', async () => {
  // Short-circuit: if lhs is falsy, rhs not evaluated for &&
  // Using 1/0 to verify - if evaluated would be Infinity not 0
  is(await evaluate('0 && 1/0'), 0)
  is(await evaluate('1 || 1/0'), 1)
  // Additional short-circuit tests
  is(await evaluate('0 && 42'), 0)
  is(await evaluate('1 || 42'), 1)
  is(await evaluate('5 && 0'), 0)
  is(await evaluate('0 || 5'), 5)
})

test('i32 bit operations - Math.clz32', async () => {
  // Math.clz32 - count leading zeros (standard JS!)
  is(await evaluate('Math.clz32(1)'), 31)
  is(await evaluate('Math.clz32(2)'), 30)
  is(await evaluate('Math.clz32(256)'), 23)
  is(await evaluate('Math.clz32(0)'), 32)
})

test('integer div - via Math', async () => {
  // Integer division via Math.trunc(a/b) - pure JS way
  is(await evaluate('Math.trunc(7 / 3)'), 2)
  is(await evaluate('Math.trunc(10 / 4)'), 2)
  is(await evaluate('Math.trunc(-7 / 3)'), -2)
  is(await evaluate('Math.trunc(7 / -3)'), -2)
  is(await evaluate('Math.trunc(-7 / -3)'), 2)
})

test('isNaN and isFinite', async () => {
  // isNaN
  is(await evaluate('isNaN(NaN)'), 1)
  is(await evaluate('isNaN(0)'), 0)
  is(await evaluate('isNaN(1)'), 0)
  is(await evaluate('isNaN(Infinity)'), 0)
  is(await evaluate('isNaN(-Infinity)'), 0)

  // isFinite
  is(await evaluate('isFinite(0)'), 1)
  is(await evaluate('isFinite(1)'), 1)
  is(await evaluate('isFinite(-1)'), 1)
  is(await evaluate('isFinite(Infinity)'), 0)
  is(await evaluate('isFinite(-Infinity)'), 0)
  is(await evaluate('isFinite(NaN)'), 0)
})

test('array.set (arr[i] = x)', async () => {
  // Basic array mutation
  is(await evaluate('(a = [1,2,3], a[0] = 10, a[0])'), 10)
  is(await evaluate('(a = [1,2,3], a[1] = 20, a[1])'), 20)
  is(await evaluate('(a = [1,2,3], a[2] = 30, a[2])'), 30)

  // Assignment returns the value
  is(await evaluate('(a = [0,0], a[0] = 42)'), 42)

  // Multiple mutations
  is(await evaluate('(a = [1,2,3], a[0] = 10, a[1] = 20, a[0] + a[1])'), 30)

  // Dynamic index
  is(await evaluate('(a = [1,2,3], i = 1, a[i] = 99, a[1])'), 99)
})

test('array.length', async () => {
  // Basic length
  is(await evaluate('[1,2,3].length'), 3)
  is(await evaluate('[].length'), 0)
  is(await evaluate('[1].length'), 1)

  // Length via variable
  is(await evaluate('(a = [1,2,3,4,5], a.length)'), 5)

  // Use in expressions
  is(await evaluate('[1,2,3].length + 1'), 4)
  is(await evaluate('(a = [1,2], a.length * 2)'), 4)
})

test('optional chaining (?.)', async () => {
  // Optional array access - returns 0 for null
  is(await evaluate('(a = [1,2,3], a?.[0])'), 1)
  is(await evaluate('(a = null, a?.[0])'), 0)

  // Optional length - returns 0 for null
  is(await evaluate('(a = [1,2,3], a?.length)'), 3)
  is(await evaluate('(a = null, a?.length)'), 0)

  // Chained with expressions
  is(await evaluate('(a = [10,20], a?.[1] + 5)'), 25)
  is(await evaluate('(a = null, a?.[1] + 5)'), 5)
})

test('compound assignment', async () => {
  // Basic compound assignment
  is(await evaluate('(a = 5, a += 3, a)'), 8)
  is(await evaluate('(a = 10, a -= 4, a)'), 6)
  is(await evaluate('(a = 3, a *= 4, a)'), 12)
  is(await evaluate('(a = 20, a /= 5, a)'), 4)
  is(await evaluate('(a = 17, a %= 5, a)'), 2)

  // Compound returns the new value
  is(await evaluate('(a = 5, a += 3)'), 8)

  // Array element compound assignment
  is(await evaluate('(arr = [1,2,3], arr[0] += 10, arr[0])'), 11)
  is(await evaluate('(arr = [10,20], arr[1] *= 2, arr[1])'), 40)
})

test('object literals and property access', async () => {
  // Basic object literal
  is(await evaluate('{x: 1}.x'), 1)
  is(await evaluate('{x: 1, y: 2}.y'), 2)
  is(await evaluate('{a: 10, b: 20, c: 30}.b'), 20)

  // Object in variable
  is(await evaluate('(obj = {x: 5, y: 10}, obj.x)'), 5)
  is(await evaluate('(obj = {x: 5, y: 10}, obj.y)'), 10)

  // Expressions in values
  is(await evaluate('{x: 1 + 2, y: 3 * 4}.x'), 3)
  is(await evaluate('{x: 1 + 2, y: 3 * 4}.y'), 12)

  // Object with variable
  is(await evaluate('(t = 5, {val: t * 2}.val)'), 10)

  // Nested property expressions
  is(await evaluate('(o = {a: 1, b: 2}, o.a + o.b)'), 3)
})

test('string literals', async () => {
  // String indexing returns char code
  is(await evaluate('"hello"[0]'), 104) // 'h'
  is(await evaluate('"hello"[1]'), 101) // 'e'
  is(await evaluate('"A"[0]'), 65)

  // String length
  is(await evaluate('"hello".length'), 5)
  is(await evaluate('"".length'), 0)
  is(await evaluate('"abc".length'), 3)

  // String in variable
  is(await evaluate('(s = "test", s.length)'), 4)
  is(await evaluate('(s = "test", s[0])'), 116) // 't'

  // Use char codes in expressions
  is(await evaluate('"A"[0] + 32'), 97) // 'a'

  // UTF-16: characters > 255 (i16 storage)
  is(await evaluate('"α"[0]'), 945)    // Greek alpha
  is(await evaluate('"中"[0]'), 20013) // Chinese character
  is(await evaluate('"€"[0]'), 8364)   // Euro sign

  // String interning - same string used multiple times
  is(await evaluate('(a = "hi", b = "hi", a[0] + b[0])'), 104 * 2) // 'h' + 'h'
})

test('destructuring', async () => {
  // Array destructuring assignment
  is(await evaluate('([a, b] = [1, 2], a)'), 1)
  is(await evaluate('([a, b] = [1, 2], b)'), 2)
  is(await evaluate('([a, b] = [1, 2], a + b)'), 3)
  is(await evaluate('([x, y, z] = [10, 20, 30], x + y + z)'), 60)

  // Object destructuring assignment
  is(await evaluate('({a, b} = {a: 5, b: 10}, a)'), 5)
  is(await evaluate('({a, b} = {a: 5, b: 10}, b)'), 10)
  is(await evaluate('({a, b} = {a: 5, b: 10}, a + b)'), 15)
  is(await evaluate('({x, y, z} = {x: 1, y: 2, z: 3}, x * y * z)'), 6)

  // Destructure from variable
  is(await evaluate('(arr = [7, 8], [a, b] = arr, a * b)'), 56)
  is(await evaluate('(obj = {a: 3, b: 4}, {a, b} = obj, a + b)'), 7)
})

// Destructuring in declarations (let/const)
test('destructuring declarations', async () => {
  // let array destructuring
  is(await evaluate('let [a, b] = [1, 2]; a + b'), 3)
  is(await evaluate('let [x, y, z] = [10, 20, 30]; x + y + z'), 60)

  // const array destructuring
  is(await evaluate('const [a, b] = [5, 6]; a * b'), 30)

  // let object destructuring
  is(await evaluate('let {a, b} = {a: 3, b: 4}; a + b'), 7)

  // const object destructuring
  is(await evaluate('const {x, y} = {x: 2, y: 3}; x * y'), 6)

  // Object destructuring with rename
  is(await evaluate('let {a: x, b: y} = {a: 5, b: 10}; x + y'), 15)

  // Multi-value optimization: let [a, b] = [expr, expr] uses no allocation
  is(await evaluate('let [a, b] = [1 + 2, 3 + 4]; a * 10 + b'), 37)
})

// Swap and rotate patterns - optimized via temporaries, no array allocation
test('swap pattern', async () => {
  // Basic swap: [a, b] = [b, a]
  is(await evaluate('(a = 1, b = 2, [a, b] = [b, a], a * 10 + b)'), 21)
  // Swap with f64
  is(await evaluate('(a = 1.5, b = 2.5, [a, b] = [b, a], a + b)'), 4)
  // Swap with let
  is(await evaluate('let a = 1; let b = 2; [a, b] = [b, a]; a * 10 + b'), 21)
})

test('rotate pattern', async () => {
  // Rotate right: [a, b, c] = [c, a, b]
  is(await evaluate('(a = 1, b = 2, c = 3, [a, b, c] = [c, a, b], a * 100 + b * 10 + c)'), 312)
  // Rotate left: [a, b, c] = [b, c, a]
  is(await evaluate('(a = 1, b = 2, c = 3, [a, b, c] = [b, c, a], a * 100 + b * 10 + c)'), 231)
})

// JS COMPATIBILITY TESTS
// jz code must be valid JS - these tests run the same code in both jz and native JS

test('JS compat - Math namespace', async () => {
  // Standard Math methods must work with namespace
  is(await evaluate('Math.sqrt(4)'), Math.sqrt(4))
  is(await evaluate('Math.abs(-5)'), Math.abs(-5))
  is(await evaluate('Math.floor(3.7)'), Math.floor(3.7))
  is(await evaluate('Math.ceil(3.2)'), Math.ceil(3.2))
  is(await evaluate('Math.trunc(3.9)'), Math.trunc(3.9))
  is(await evaluate('Math.round(3.5)'), Math.round(3.5))
  is(await evaluate('Math.min(1, 2)'), Math.min(1, 2))
  is(await evaluate('Math.max(1, 2)'), Math.max(1, 2))
  is(await evaluate('Math.clz32(1)'), Math.clz32(1))
})

test('JS compat - Math trig', async () => {
  const eps = 0.0001
  ok(Math.abs(await evaluate('Math.sin(0)') - Math.sin(0)) < eps)
  ok(Math.abs(await evaluate('Math.cos(0)') - Math.cos(0)) < eps)
  ok(Math.abs(await evaluate('Math.tan(0)') - Math.tan(0)) < eps)
})

test('JS compat - Math exp/log', async () => {
  const eps = 0.0001
  ok(Math.abs(await evaluate('Math.exp(1)') - Math.exp(1)) < eps)
  ok(Math.abs(await evaluate('Math.log(Math.E)') - Math.log(Math.E)) < eps)
  ok(Math.abs(await evaluate('Math.log2(8)') - Math.log2(8)) < eps)
  ok(Math.abs(await evaluate('Math.log10(100)') - Math.log10(100)) < eps)
})

test('JS compat - Math pow/hypot', async () => {
  is(await evaluate('Math.pow(2, 3)'), Math.pow(2, 3))
  is(await evaluate('Math.hypot(3, 4)'), Math.hypot(3, 4))
  is(await evaluate('Math.imul(3, 4)'), Math.imul(3, 4))
})

test('JS compat - Number namespace', async () => {
  // Number.isNaN
  is(await evaluate('Number.isNaN(NaN)'), Number.isNaN(NaN) ? 1 : 0)
  is(await evaluate('Number.isNaN(0)'), Number.isNaN(0) ? 1 : 0)
  is(await evaluate('Number.isNaN(Infinity)'), Number.isNaN(Infinity) ? 1 : 0)

  // Number.isFinite
  is(await evaluate('Number.isFinite(0)'), Number.isFinite(0) ? 1 : 0)
  is(await evaluate('Number.isFinite(Infinity)'), Number.isFinite(Infinity) ? 1 : 0)
  is(await evaluate('Number.isFinite(NaN)'), Number.isFinite(NaN) ? 1 : 0)

  // Number.isInteger
  is(await evaluate('Number.isInteger(5)'), Number.isInteger(5) ? 1 : 0)
  is(await evaluate('Number.isInteger(5.5)'), Number.isInteger(5.5) ? 1 : 0)
})

test('JS compat - global isNaN/isFinite', async () => {
  // These exist globally in JS too
  is(await evaluate('isNaN(NaN)'), isNaN(NaN) ? 1 : 0)
  is(await evaluate('isNaN(0)'), isNaN(0) ? 1 : 0)
  is(await evaluate('isFinite(0)'), isFinite(0) ? 1 : 0)
  is(await evaluate('isFinite(Infinity)'), isFinite(Infinity) ? 1 : 0)
})

// Default params
test('Default params - basic', async () => {
  is(await evaluate('add = (a, b = 10) => a + b; add(5)'), 15)
  is(await evaluate('add = (a, b = 10) => a + b; add(5, 3)'), 8)
  is(await evaluate('greet = (x = 1, y = 2, z = 3) => x + y + z; greet()'), 6)
  is(await evaluate('greet = (x = 1, y = 2, z = 3) => x + y + z; greet(10)'), 15)
  is(await evaluate('greet = (x = 1, y = 2, z = 3) => x + y + z; greet(10, 20)'), 33)
  is(await evaluate('greet = (x = 1, y = 2, z = 3) => x + y + z; greet(10, 20, 30)'), 60)
})

test('Default params - expression defaults', async () => {
  is(await evaluate('f = (x = 2 + 3) => x * 2; f()'), 10)
  is(await evaluate('f = (x = 2 * 3) => x + 1; f()'), 7)
})

test('Default params - array default', async () => {
  // Array default param signals array type
  is(await evaluate('len = (arr = []) => arr.length; len()'), 0)
  is(await evaluate('sum = (arr = []) => arr.reduce((a,b) => a+b, 0); sum([1,2,3])'), 6)
})

test('Default params - object default with schema', async () => {
  // Object default param declares schema inline
  is(await evaluate('getX = (pos = {x: 0, y: 0}) => pos.x; getX({x: 5, y: 10})'), 5)
  is(await evaluate('getY = (pos = {x: 0, y: 0}) => pos.y; getY({x: 5, y: 10})'), 10)
  is(await evaluate('getX = (pos = {x: 0, y: 0}) => pos.x; getX()'), 0) // default value
})

// Rest params
test('Rest params - basic', async () => {
  is(await evaluate('len = (...args) => args.length; len(1, 2, 3)'), 3)
  is(await evaluate('len = (...args) => args.length; len()'), 0)
  is(await evaluate('sum = (...args) => args.reduce((a, b) => a + b, 0); sum(1, 2, 3, 4)'), 10)
})

test('Rest params - mixed with regular', async () => {
  is(await evaluate('f = (a, ...rest) => a + rest.length; f(10, 1, 2, 3)'), 13)
  is(await evaluate('f = (a, b, ...rest) => a + b + rest.length; f(10, 20, 1, 2)'), 32)
})

// Spread in arrays
test('Spread in arrays', async () => {
  is(await evaluate('arr = [1, 2]; [...arr, 3].length'), 3)
  is(await evaluate('arr = [1, 2]; [...arr, 3][2]'), 3)
  is(await evaluate('a = [1, 2]; b = [3, 4]; [...a, ...b].length'), 4)
  is(await evaluate('a = [1, 2]; b = [3, 4]; [...a, ...b][3]'), 4)
  is(await evaluate('[...[1, 2, 3]][1]'), 2)
})

// Spread in calls
test('Spread in calls', async () => {
  is(await evaluate('sum = (...args) => args.length; arr = [1, 2, 3]; sum(...arr)'), 3)
  is(await evaluate('sum = (...args) => args.reduce((a, b) => a + b, 0); sum(...[1, 2, 3, 4])'), 10)
})

// Array destructuring params
test('Array destructuring params', async () => {
  is(await evaluate('add = ([a, b]) => a + b; add([3, 5])'), 8)
  is(await evaluate('first = ([x]) => x; first([42])'), 42)
  is(await evaluate('sum3 = ([a, b, c]) => a + b + c; sum3([1, 2, 3])'), 6)
})

// Object destructuring params
test('Object destructuring params', async () => {
  is(await evaluate('sum = ({x, y}) => x + y; sum({x: 10, y: 20})'), 30)
  is(await evaluate('getX = ({x}) => x; getX({x: 42, y: 1})'), 42)
})

// NOTE: JZ is PURE JS subset - no shorthand math or WASM extensions
// All math functions require Math.* namespace (Math.sin, Math.sqrt, etc.)
// This ensures ANY JZ code can run in a standard JS interpreter
