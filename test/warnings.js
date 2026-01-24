import test from 'tst'
import { ok } from 'tst/assert.js'
import { compile as jzCompile } from '../index.js'
import { compile as watrCompile } from 'watr'

// Helper: compile JS to WASM binary
const compile = code => watrCompile(jzCompile(code))

// Warning tests - these compile successfully but emit warnings
// Run `npm test` to see warnings in output

test('warnings - var hoisting', () => {
  // Should warn: prefer let/const
  const wasm = compile('var x = 1')
  ok(wasm instanceof Uint8Array)
})

test('warnings - parseInt without radix', () => {
  // Should warn: JZ defaults to 10
  const wasm = compile('parseInt("10")')
  ok(wasm instanceof Uint8Array)
})

test('warnings - NaN === NaN', () => {
  // Should warn: always false, use Number.isNaN
  const wasm = compile('NaN === NaN')
  ok(wasm instanceof Uint8Array)
})

test('warnings - NaN !== NaN', () => {
  // Should warn: always true, use Number.isNaN
  const wasm = compile('NaN !== NaN')
  ok(wasm instanceof Uint8Array)
})

test('warnings - array alias', () => {
  // Should warn: pointer copy, not deep clone
  const wasm = compile('let a = [1,2,3]; let b = a')
  ok(wasm instanceof Uint8Array)
})

test('warnings - x == null idiom', () => {
  // Should warn: won't catch undefined in JZ
  const wasm = compile('let x = 1; x == null')
  ok(wasm instanceof Uint8Array)
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
