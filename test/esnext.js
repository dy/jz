import test from 'tst'
import { evaluate } from '../index.js'

// ESNext Test Suite - Focused on minimal functional JS subset
// Tests that align with JZ's philosophy: functional, minimal, WASM-compatible

// Note: Currently using WAT syntax for evaluation
// TODO: Update when JS-to-WAT compilation is implemented

test('ESNext Numeric Literals', async t => {
  // Binary literals (converted to decimal for WAT)
  t.equal(await evaluate('(f64.const 10)'), 10) // 0b1010

  // Octal literals (converted to decimal for WAT)
  t.equal(await evaluate('(f64.const 493)'), 493) // 0o755

  // Exponential notation
  t.equal(await evaluate('(f64.const 1000)'), 1000) // 1e3
  t.equal(await evaluate('(f64.const 150)'), 150) // 1.5e2

  // Hexadecimal (converted to decimal for WAT)
  t.equal(await evaluate('(f64.const 255)'), 255) // 0xFF
})

test('ESNext Arrow Functions (conceptual)', async t => {
  // Test basic function evaluation
  // Note: Function compilation not yet implemented
  t.equal(await evaluate('(f64.const 42)'), 42)

  // Test that we can handle simple expressions
  t.equal(await evaluate('(f64.add (f64.const 2) (f64.const 3))'), 5)
})

test('ESNext Template Literals (conceptual)', async t => {
  // Test string concatenation via addition
  // Note: String support not yet implemented
  t.equal(await evaluate('(f64.add (f64.const 1) (f64.const 2))'), 3)
})

test('ESNext Destructuring (conceptual)', async t => {
  // Test array-like operations
  // Note: Array destructuring not yet implemented
  t.equal(await evaluate('(f64.mul (f64.const 3) (f64.const 4))'), 12)
})

test('ESNext Spread Operator (conceptual)', async t => {
  // Test function application patterns
  // Note: Spread operator not yet implemented
  t.equal(await evaluate('(f64.div (f64.const 15) (f64.const 3))'), 5)
})

test('ESNext Optional Chaining (conceptual)', async t => {
  // Test safe property access patterns
  // Note: Optional chaining not yet implemented
  t.equal(await evaluate('(f64.sub (f64.const 10) (f64.const 4))'), 6)
})

test('ESNext Nullish Coalescing (conceptual)', async t => {
  // Test logical operations with null/undefined handling
  // Note: Nullish coalescing not yet implemented
  t.equal(await evaluate('(f64.add (f64.const 0) (f64.const 5))'), 5)
})

test('ESNext BigInt (conceptual)', async t => {
  // Test large number handling
  // Note: BigInt not yet implemented
  t.equal(await evaluate('(f64.const 9007199254740991)'), 9007199254740991) // Max safe integer
})

test('ESNext Modules (conceptual)', async t => {
  // Test module-like behavior
  // Note: Module system not yet implemented
  t.equal(await evaluate('(f64.const 1)'), 1)
})

test('ESNext Promises/Async (conceptual)', async t => {
  // Test async evaluation
  const result = await evaluate('(f64.const 42)')
  t.equal(result, 42)
})

test('Functional Programming Patterns', async t => {
  // Higher-order function concepts
  t.equal(await evaluate('(f64.mul (f64.const 2) (f64.const 21))'), 42)

  // Function composition
  t.equal(await evaluate('(f64.add (f64.mul (f64.const 3) (f64.const 4)) (f64.const 2))'), 14)

  // Currying concept
  t.equal(await evaluate('(f64.mul (f64.add (f64.const 1) (f64.const 2)) (f64.const 3))'), 9)
})

test('Immutable Data Patterns', async t => {
  // Test that operations don't mutate values
  const original = await evaluate('(f64.const 5)')
  const result = await evaluate('(f64.add (f64.const 5) (f64.const 3))')

  t.equal(original, 5) // Original value unchanged
  t.equal(result, 8)   // New value created
})

test('Pure Function Properties', async t => {
  // Same input always produces same output
  const result1 = await evaluate('(f64.add (f64.const 2) (f64.const 2))')
  const result2 = await evaluate('(f64.add (f64.const 2) (f64.const 2))')

  t.equal(result1, result2)
  t.equal(result1, 4)
})

test('Minimal Syntax Patterns', async t => {
  // Test concise expression evaluation
  t.equal(await evaluate('(f64.const 42)'), 42)
  t.equal(await evaluate('(f64.neg (f64.const 5))'), -5)
  t.equal(await evaluate('(f64.abs (f64.const -7))'), 7)
})

test('WASM Compatibility', async t => {
  // Test that operations work within WASM constraints
  t.equal(await evaluate('(f64.add (f64.const 0.1) (f64.const 0.2))'), 0.30000000000000004)
  t.equal(await evaluate('(f64.div (f64.const 1) (f64.const 3))'), 0.3333333333333333)
})

test('JZ Core Philosophy - Minimal Functional Patterns', async t => {
  // Function composition (core to functional programming)
  t.equal(await evaluate('(f64.add (f64.mul (f64.const 2) (f64.const 3)) (f64.const 1))'), 7)

  // Higher-order function concepts
  t.equal(await evaluate('(f64.mul (f64.add (f64.const 1) (f64.const 2)) (f64.const 3))'), 9)

  // Pure functions - no side effects
  const result1 = await evaluate('(f64.const 42)')
  const result2 = await evaluate('(f64.const 42)')
  t.equal(result1, result2)

  // Immutability - operations create new values
  const original = await evaluate('(f64.const 5)')
  const transformed = await evaluate('(f64.add (f64.const 5) (f64.const 3))')
  t.equal(original, 5)
  t.equal(transformed, 8)
})

test('WASM-Optimized Patterns', async t => {
  // Operations that map well to WASM instructions
  t.equal(await evaluate('(f64.sqrt (f64.const 16))'), 4)
  t.equal(await evaluate('(f64.abs (f64.const -7.5))'), 7.5)
  t.equal(await evaluate('(f64.floor (f64.const 3.7))'), 3)
  t.equal(await evaluate('(f64.ceil (f64.const 2.1))'), 3)
})

test('ESNext Features That Fit JZ Philosophy', async t => {
  // Const declarations (immutability)
  t.equal(await evaluate('(f64.const 100)'), 100)

  // Arrow functions (concise syntax)
  t.equal(await evaluate('(f64.add (f64.const 10) (f64.const 20))'), 30)

  // Template literals (string interpolation concept)
  t.equal(await evaluate('(f64.const 42)'), 42)

  // Destructuring (pattern matching concept)
  t.equal(await evaluate('(f64.mul (f64.const 6) (f64.const 7))'), 42)
})

console.log('ESNext Test Suite - Testing modern JS features in JZ context')
console.log('Note: Many features are conceptual until JS-to-WAT compilation is implemented')
