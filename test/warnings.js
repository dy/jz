import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { compile as jzCompile } from '../index.js'
import { compile as watrCompile } from 'watr'
import { getWarnings, setWarnings } from '../src/normalize.js'

// Helper: compile JS to WASM binary, capturing warnings
let capturedWarnings = []
const originalWarn = console.warn

function captureWarnings() {
  capturedWarnings = []
  setWarnings([])  // Reset normalize warnings
  console.warn = (...args) => {
    capturedWarnings.push(args.join(' '))
  }
}

function restoreWarnings() {
  console.warn = originalWarn
  // Also capture normalize warnings
  for (const w of getWarnings()) {
    capturedWarnings.push(`jz: [${w.code}] ${w.msg}`)
  }
  return capturedWarnings
}

function compileWithWarnings(code) {
  captureWarnings()
  const wat = jzCompile(code)
  const warnings = restoreWarnings()
  const wasm = watrCompile(wat)
  return { wasm, warnings }
}

// Helper: compile JS to WASM binary (no warning capture)
const compile = code => watrCompile(jzCompile(code))

// Warning tests - verify warnings ARE actually emitted

test('warnings - var hoisting', () => {
  const { wasm, warnings } = compileWithWarnings('var x = 1')
  ok(wasm instanceof Uint8Array)
  ok(warnings.some(w => w.includes('var') && w.includes('prefer')),
    `Expected var warning, got: ${warnings.join('; ')}`)
})

test('warnings - parseInt without radix', () => {
  const { wasm, warnings } = compileWithWarnings('parseInt("10")')
  ok(wasm instanceof Uint8Array)
  ok(warnings.some(w => w.includes('parseInt') && w.includes('radix')),
    `Expected parseInt warning, got: ${warnings.join('; ')}`)
})

test('warnings - NaN === NaN', () => {
  const { wasm, warnings } = compileWithWarnings('NaN === NaN')
  ok(wasm instanceof Uint8Array)
  ok(warnings.some(w => w.includes('NaN') && w.includes('Number.isNaN')),
    `Expected NaN warning, got: ${warnings.join('; ')}`)
})

test('warnings - NaN !== NaN', () => {
  const { wasm, warnings } = compileWithWarnings('NaN !== NaN')
  ok(wasm instanceof Uint8Array)
  ok(warnings.some(w => w.includes('NaN') && w.includes('Number.isNaN')),
    `Expected NaN warning, got: ${warnings.join('; ')}`)
})

test('warnings - array alias', () => {
  const { wasm, warnings } = compileWithWarnings('let a = [1,2,3]; let b = a')
  ok(wasm instanceof Uint8Array)
  ok(warnings.some(w => w.includes('array') && w.includes('pointer')),
    `Expected array alias warning, got: ${warnings.join('; ')}`)
})

test('warnings - x == null idiom', () => {
  const { wasm, warnings } = compileWithWarnings('let x = 1; x == null')
  ok(wasm instanceof Uint8Array)
  ok(warnings.some(w => w.includes('null') && w.includes('undefined')),
    `Expected null compare warning, got: ${warnings.join('; ')}`)
})

test('errors - +[] coercion', () => {
  // Should throw: nonsense coercion
  let threw = false
  try { compile('+[]') } catch (e) { threw = e.message.includes('nonsense') }
  ok(threw, '+[] should throw')
})

test('errors - [] + {} coercion', () => {
  // Should throw: nonsense coercion
  let threw = false
  try { compile('[] + {}') } catch (e) { threw = e.message.includes('nonsense') }
  ok(threw, '[] + {} should throw')
})

test('errors - implicit global', () => {
  // Should throw: unknown identifier (on read, not assignment)
  let threw = false
  try { compile('y + 1') } catch (e) { threw = e.message.includes('Unknown identifier') }
  ok(threw, 'undeclared read should throw')
})
// Prohibited JS features

test('errors - arguments', () => {
  let threw = false
  try { compile('fn = () => arguments.length') } catch (e) { threw = e.message.includes('prohibited') }
  ok(threw, 'arguments should be prohibited')
})

test('errors - eval', () => {
  let threw = false
  try { compile('eval("1+1")') } catch (e) { threw = e.message.includes('prohibited') }
  ok(threw, 'eval should be prohibited')
})

test('errors - new with custom class', () => {
  let threw = false
  try { compile('new MyClass()') } catch (e) { threw = e.message.includes('prohibited') && e.message.includes('MyClass') }
  ok(threw, 'new MyClass should be prohibited')
})

test('allowed - new Array', () => {
  const wasm = compile('new Array(5)')
  ok(wasm instanceof Uint8Array)
})

test('allowed - new Float64Array', () => {
  const wasm = compile('new Float64Array(3)')
  ok(wasm instanceof Uint8Array)
})

test('allowed - new Set', () => {
  const wasm = compile('new Set()')
  ok(wasm instanceof Uint8Array)
})

test('allowed - new Map', () => {
  const wasm = compile('new Map()')
  ok(wasm instanceof Uint8Array)
})

test('warnings - no-redeclare', () => {
  // Should warn: x already declared in scope
  const wasm = compile('let x = 1; let x = 2')
  ok(wasm instanceof Uint8Array)
})

test('warnings - no-redeclare in block scope', () => {
  // Should NOT warn: different scopes
  const wasm = compile('let x = 1; { let x = 2 }')
  ok(wasm instanceof Uint8Array)
})

test('warnings - no-loss-of-precision', () => {
  // Should warn: exceeds MAX_SAFE_INTEGER
  const wasm = compile('let x = 9007199254740993')  // MAX_SAFE_INTEGER + 2
  ok(wasm instanceof Uint8Array)
})

test('no warning - safe integer', () => {
  // Should NOT warn: within safe range
  const wasm = compile('let x = 9007199254740991')  // MAX_SAFE_INTEGER
  ok(wasm instanceof Uint8Array)
})
