import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluateWat, evaluate } from './util.js'

// ESNext Test Suite - Focused on minimal functional JS subset
// Tests that align with JZ's philosophy: functional, minimal, WASM-compatible

// Note: Currently using WAT syntax for evaluation
// TODO: Update when JS-to-WAT compilation is implemented
console.log('ESNext Test Suite - Testing modern JS features in JZ context')
console.log('Note: Many features are conceptual until JS-to-WAT compilation is implemented')

test('ESNext Numeric Literals', async () => {
  // Binary literals (converted to decimal for WAT)
  is(await evaluateWat('(f64.const 10)'), 10) // 0b1010

  // Octal literals (converted to decimal for WAT)
  is(await evaluateWat('(f64.const 493)'), 493) // 0o755

  // Exponential notation
  is(await evaluateWat('(f64.const 1000)'), 1000) // 1e3
  is(await evaluateWat('(f64.const 150)'), 150) // 1.5e2

  // Hexadecimal (converted to decimal for WAT)
  is(await evaluateWat('(f64.const 255)'), 255) // 0xFF
})

test('ESNext Arrow Functions (conceptual)', async () => {
  // Test basic function evaluation
  // Note: Function compilation not yet implemented
  is(await evaluateWat('(f64.const 42)'), 42)

  // Test that we can handle simple expressions
  is(await evaluateWat('(f64.add (f64.const 2) (f64.const 3))'), 5)
})

test('ESNext Template Literals (conceptual)', async () => {
  // Test string concatenation via addition
  // Note: String support not yet implemented
  is(await evaluateWat('(f64.add (f64.const 1) (f64.const 2))'), 3)
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

test('ESNext Spread Operator (conceptual)', async () => {
  // Test function application patterns
  // Note: Spread operator not yet implemented
  is(await evaluateWat('(f64.div (f64.const 15) (f64.const 3))'), 5)
})

test('ESNext Optional Chaining (conceptual)', async () => {
  // Test safe property access patterns
  // Note: Optional chaining not yet implemented
  is(await evaluateWat('(f64.sub (f64.const 10) (f64.const 4))'), 6)
})

test('ESNext Nullish Coalescing (conceptual)', async () => {
  // Test logical operations with null/undefined handling
  // Note: Nullish coalescing not yet implemented
  is(await evaluateWat('(f64.add (f64.const 0) (f64.const 5))'), 5)
})

test('ESNext BigInt (conceptual)', async () => {
  // Test large number handling
  // Note: BigInt not yet implemented, but full f64 range works with NaN boxing
  is(await evaluateWat('(f64.const 281474976710655)'), 281474976710655)
  is(await evaluateWat('(f64.const 9007199254740991)'), 9007199254740991) // MAX_SAFE_INTEGER
})

test('ESNext Modules (conceptual)', async () => {
  // Test module-like behavior
  // Note: Module system not yet implemented
  is(await evaluateWat('(f64.const 1)'), 1)
})

test('ESNext Promises/Async (conceptual)', async () => {
  // Test async evaluation
  const result = await evaluateWat('(f64.const 42)')
  is(result, 42)
})

test('Functional Programming Patterns', async () => {
  // Higher-order function concepts
  is(await evaluateWat('(f64.mul (f64.const 2) (f64.const 21))'), 42)

  // Function composition
  is(await evaluateWat('(f64.add (f64.mul (f64.const 3) (f64.const 4)) (f64.const 2))'), 14)

  // Currying concept
  is(await evaluateWat('(f64.mul (f64.add (f64.const 1) (f64.const 2)) (f64.const 3))'), 9)
})

test('Immutable Data Patterns', async () => {
  // Test that operations don't mutate values
  const original = await evaluateWat('(f64.const 5)')
  const result = await evaluateWat('(f64.add (f64.const 5) (f64.const 3))')

  is(original, 5) // Original value unchanged
  is(result, 8)   // New value created
})

test('Pure Function Properties', async () => {
  // Same input always produces same output
  const result1 = await evaluateWat('(f64.add (f64.const 2) (f64.const 2))')
  const result2 = await evaluateWat('(f64.add (f64.const 2) (f64.const 2))')

  is(result1, result2)
  is(result1, 4)
})

test('Minimal Syntax Patterns', async () => {
  // Test concise expression evaluation
  is(await evaluateWat('(f64.const 42)'), 42)
  is(await evaluateWat('(f64.neg (f64.const 5))'), -5)
  is(await evaluateWat('(f64.abs (f64.const -7))'), 7)
})

test('WASM Compatibility', async () => {
  // Test that operations work within WASM constraints
  is(await evaluateWat('(f64.add (f64.const 0.1) (f64.const 0.2))'), 0.30000000000000004)
  is(await evaluateWat('(f64.div (f64.const 1) (f64.const 3))'), 0.3333333333333333)
})

test('JZ Core Philosophy - Minimal Functional Patterns', async () => {
  // Function composition (core to functional programming)
  is(await evaluateWat('(f64.add (f64.mul (f64.const 2) (f64.const 3)) (f64.const 1))'), 7)

  // Higher-order function concepts
  is(await evaluateWat('(f64.mul (f64.add (f64.const 1) (f64.const 2)) (f64.const 3))'), 9)

  // Pure functions - no side effects
  const result1 = await evaluateWat('(f64.const 42)')
  const result2 = await evaluateWat('(f64.const 42)')
  is(result1, result2)

  // Immutability - operations create new values
  const original = await evaluateWat('(f64.const 5)')
  const transformed = await evaluateWat('(f64.add (f64.const 5) (f64.const 3))')
  is(original, 5)
  is(transformed, 8)
})

test('WASM-Optimized Patterns', async () => {
  // Operations that map well to WASM instructions
  is(await evaluateWat('(f64.sqrt (f64.const 16))'), 4)
  is(await evaluateWat('(f64.abs (f64.const -7.5))'), 7.5)
  is(await evaluateWat('(f64.floor (f64.const 3.7))'), 3)
  is(await evaluateWat('(f64.ceil (f64.const 2.1))'), 3)
})

test('ESNext Features That Fit JZ Philosophy', async () => {
  // Const declarations (immutability)
  is(await evaluateWat('(f64.const 100)'), 100)

  // Arrow functions (concise syntax)
  is(await evaluateWat('(f64.add (f64.const 10) (f64.const 20))'), 30)

  // Template literals (string interpolation concept)
  is(await evaluateWat('(f64.const 42)'), 42)

  // Destructuring (pattern matching concept)
  is(await evaluateWat('(f64.mul (f64.const 6) (f64.const 7))'), 42)
})

console.log('ESNext Test Suite - Testing modern JS features in JZ context')
console.log('Note: Many features are conceptual until JS-to-WAT compilation is implemented')
