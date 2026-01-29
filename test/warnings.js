import test from 'tst'
import { ok, is } from 'tst/assert.js'
import jzCompile from '../index.js'
import { getWarnings, setWarnings } from '../src/prepare.js'

// Helper: compile JS to WASM binary, capturing warnings
function compileWithWarnings(code) {
  setWarnings([])
  try {
    const wasm = jzCompile(code)
    return { wasm, warnings: getWarnings() }
  } catch (e) {
    return { error: e, warnings: getWarnings() }
  }
}

// Helper: compile JS to WASM binary (no warning capture)
const compile = code => jzCompile(code)

// Warning tests - verify warnings ARE actually emitted

test('warnings - var hoisting', () => {
  const { wasm, warnings } = compileWithWarnings('export let f = x => { var y = x; return y }')
  ok(wasm instanceof Uint8Array)
  ok(warnings.some(w => w.code === 'var'), `Expected var warning, got: ${JSON.stringify(warnings)}`)
})

test('warnings - function keyword', () => {
  const { wasm, warnings } = compileWithWarnings('function f(x) { return x }')
  ok(wasm instanceof Uint8Array)
  ok(warnings.some(w => w.code === 'function'), `Expected function warning, got: ${JSON.stringify(warnings)}`)
})
// Prohibited JS features

test('errors - this', () => {
  let threw = false
  try { compile('export let f = () => this.x') } catch (e) { threw = e.message.includes('this') }
  ok(threw, 'this should be prohibited')
})

test('errors - arguments', () => {
  let threw = false
  try { compile('export let f = () => arguments.length') } catch (e) { threw = e.message.includes('arguments') }
  ok(threw, 'arguments should be prohibited')
})

test('errors - eval', () => {
  let threw = false
  try { compile('eval("1+1")') } catch (e) { threw = e.message.includes('eval') }
  ok(threw, 'eval should be prohibited')
})

test('errors - new with custom class', () => {
  let threw = false
  try { compile('new MyClass()') } catch (e) { threw = e.message.includes('MyClass') }
  ok(threw, 'new MyClass should be prohibited')
})

test('errors - Promise', () => {
  let threw = false
  try { compile('new Promise(r => r())') } catch (e) { threw = e.message.includes('Promise') }
  ok(threw, 'Promise should be prohibited')
})

test('errors - async/await', () => {
  let threw = false
  try { compile('async function f() {}') } catch (e) { threw = e.message.includes('async') }
  ok(threw, 'async should be prohibited')
})

test('errors - class', () => {
  let threw = false
  try { compile('class Foo {}') } catch (e) { threw = e.message.includes('class') }
  ok(threw, 'class should be prohibited')
})

test('allowed - new Array', () => {
  const wasm = compile('export let f = () => new Array(5)')
  ok(wasm instanceof Uint8Array)
})

test('allowed - new Float64Array', () => {
  const wasm = compile('export let f = () => new Float64Array(3)')
  ok(wasm instanceof Uint8Array)
})

test('allowed - new Set', () => {
  const wasm = compile('export let f = () => new Set()')
  ok(wasm instanceof Uint8Array)
})

test('allowed - new Map', () => {
  const wasm = compile('export let f = () => new Map()')
  ok(wasm instanceof Uint8Array)
})

// TODO: These warnings require more analysis

// test('warnings - no-redeclare', () => {
//   // Should warn: x already declared in scope
//   const wasm = compile('let x = 1; let x = 2')
//   ok(wasm instanceof Uint8Array)
// })

// test('warnings - no-redeclare in block scope', () => {
//   // Should NOT warn: different scopes
//   const wasm = compile('let x = 1; { let x = 2 }')
//   ok(wasm instanceof Uint8Array)
// })

// test('warnings - no-loss-of-precision', () => {
//   // Should warn: exceeds MAX_SAFE_INTEGER
//   const wasm = compile('let x = 9007199254740993')  // MAX_SAFE_INTEGER + 2
//   ok(wasm instanceof Uint8Array)
// })

// test('no warning - safe integer', () => {
//   // Should NOT warn: within safe range
//   const wasm = compile('let x = 9007199254740991')  // MAX_SAFE_INTEGER
//   ok(wasm instanceof Uint8Array)
// })
