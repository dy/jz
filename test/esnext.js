import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluateWat, evaluate } from './util.js'

// ESNext Test Suite - Testing modern JS features in JZ

test('ESNext Numeric Literals', async () => {
  // Binary literals
  is(await evaluate('0b1010'), 10)
  is(await evaluate('0b11111111'), 255)
  is(await evaluate('let x = 0b1010; x'), 10)

  // Octal literals
  is(await evaluate('0o755'), 493)
  is(await evaluate('0o10'), 8)
  is(await evaluate('let x = 0o755; x'), 493)

  // Exponential notation
  is(await evaluate('1e3'), 1000)
  is(await evaluate('1.5e2'), 150)
  is(await evaluate('let x = 1e3; x'), 1000)

  // Hexadecimal
  is(await evaluate('0xFF'), 255)
  is(await evaluate('0xDEAD'), 0xDEAD)
  is(await evaluate('let x = 0xFF; x'), 255)
})

test('ESNext Arrow Functions', async () => {
  // Basic arrow function
  is(await evaluate('(() => 42)()'), 42)
  is(await evaluate('((x) => x * 2)(21)'), 42)
  is(await evaluate('((a, b) => a + b)(2, 3)'), 5)

  // Arrow function with block body
  is(await evaluate('(() => { return 42 })()'), 42)
  is(await evaluate('((x) => { return x * 2 })(21)'), 42)

  // Higher-order functions
  is(await evaluate('[1,2,3].map(x => x * 2)[1]'), 4)
  is(await evaluate('[1,2,3,4].filter(x => x > 2).length'), 2)
})

test('ESNext Destructuring', async () => {
  // Basic array destructuring (let)
  is(await evaluate('let [a, b] = [1, 2]; a + b'), 3)
  is(await evaluate('let [x, y, z] = [10, 20, 30]; x + y + z'), 60)

  // Basic array destructuring (const)
  is(await evaluate('const [a, b] = [1, 2]; a + b'), 3)
  is(await evaluate('const [x, y, z] = [10, 20, 30]; x + y + z'), 60)

  // Nested array destructuring
  is(await evaluate('let [a, [b, c]] = [1, [2, 3]]; a + b + c'), 6)
  is(await evaluate('let [[a, b], c] = [[1, 2], 3]; a + b + c'), 6)
  is(await evaluate('let [a, [b, [c, d]]] = [1, [2, [3, 4]]]; a + b + c + d'), 10)
  is(await evaluate('const [a, [b, c]] = [1, [2, 3]]; a + b + c'), 6)

  // Default values
  is(await evaluate('let [a = 10] = []; a'), 10)
  is(await evaluate('let [a = 10] = [5]; a'), 5)
  is(await evaluate('let [a, b = 20] = [1]; a + b'), 21)
  is(await evaluate('let [a = 1, b = 2, c = 3] = []; a + b + c'), 6)
  is(await evaluate('const [a = 10] = []; a'), 10)

  // Rest elements
  is(await evaluate('let [a, ...rest] = [1, 2, 3]; rest.length'), 2)
  is(await evaluate('let [a, ...rest] = [1, 2, 3]; rest[0]'), 2)
  is(await evaluate('let [a, ...rest] = [1, 2, 3]; rest[1]'), 3)
  is(await evaluate('let [a, b, ...rest] = [1, 2, 3, 4]; rest.length'), 2)
  is(await evaluate('const [a, ...rest] = [1, 2, 3]; rest.length'), 2)

  // Object destructuring
  is(await evaluate('let {a, b} = {a: 1, b: 2}; a + b'), 3)
  is(await evaluate('let {x: a} = {x: 5}; a'), 5)
  is(await evaluate('const {a, b} = {a: 1, b: 2}; a + b'), 3)

  // Object defaults
  is(await evaluate('let {a, b = 5} = {a: 1}; a + b'), 6)
  is(await evaluate('let {a, b = 5} = {a: 1, b: 10}; a + b'), 11)
  is(await evaluate('let {x = 1, y = 2} = {}; x + y'), 3)
  is(await evaluate('const {a, b = 5} = {a: 1}; a + b'), 6)

  // Object rest
  is(await evaluate('let {a, ...rest} = {a: 1, b: 2, c: 3}; a'), 1)
  is(await evaluate('const {a, ...rest} = {a: 1, b: 2, c: 3}; a'), 1)
})

test('ESNext Spread Operator', async () => {
  // Array spread
  is(await evaluate('let a = [1, 2]; let b = [...a, 3]; b.length'), 3)
  is(await evaluate('let a = [1, 2]; let b = [...a, 3]; b[2]'), 3)
  is(await evaluate('let a = [1]; let b = [2]; [...a, ...b].length'), 2)

  // Note: Spread in function calls with dynamic arrays not yet supported
  // (requires runtime dispatch for variable argument count)
})

test('ESNext Exponentiation', async () => {
  is(await evaluate('2 ** 10'), 1024)
  is(await evaluate('3 ** 3'), 27)
  is(await evaluate('let x = 2; x ** 8'), 256)
})

test('ESNext Const and Let Block Scoping', async () => {
  // Block scoping
  is(await evaluate('let x = 1; { let x = 2 }; x'), 1)
  is(await evaluate('const x = 1; { const x = 2 }; x'), 1)

  // Let in loops
  is(await evaluate('let sum = 0; for (let i = 0; i < 3; i++) sum += i; sum'), 3)
})

test('WASM-Optimized Math', async () => {
  // Math functions that map to WASM instructions
  is(await evaluate('Math.sqrt(16)'), 4)
  is(await evaluate('Math.abs(-7.5)'), 7.5)
  is(await evaluate('Math.floor(3.7)'), 3)
  is(await evaluate('Math.ceil(2.1)'), 3)
  is(await evaluate('Math.trunc(-3.7)'), -3)
  is(await evaluate('Math.min(5, 3)'), 3)
  is(await evaluate('Math.max(5, 3)'), 5)
})
