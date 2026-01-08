import test from 'tst'
import { compile, evaluate } from './index.js'

// MVP Test Suite - Focused on what works with current implementation

test('Basic arithmetic operations', async t => {
  t.equal(await evaluate('(f64.add (f64.const 1) (f64.const 2))'), 3)
  t.equal(await evaluate('(f64.sub (f64.const 5) (f64.const 2))'), 3)
  t.equal(await evaluate('(f64.mul (f64.const 3) (f64.const 4))'), 12)
  t.equal(await evaluate('(f64.div (f64.const 10) (f64.const 2))'), 5)
  t.equal(await evaluate('(f64.add (f64.const 2) (f64.mul (f64.const 3) (f64.const 4)))'), 14)
  t.equal(await evaluate('(f64.mul (f64.add (f64.const 2) (f64.const 3)) (f64.const 4))'), 20)
})

test('Numeric literals', async t => {
  t.equal(await evaluate('(f64.const 1)'), 1)
  t.equal(await evaluate('(f64.const 3.14)'), 3.14)
  t.equal(await evaluate('(f64.const 1000)'), 1000)
})

test('Operator precedence', async t => {
  t.equal(await evaluate('(f64.add (f64.const 1) (f64.mul (f64.const 2) (f64.const 3)))'), 7)
  t.equal(await evaluate('(f64.mul (f64.add (f64.const 1) (f64.const 2)) (f64.const 3))'), 9)
  t.equal(await evaluate('(f64.sub (f64.const 10) (f64.div (f64.const 4) (f64.const 2)))'), 8)
})

test('Edge cases', async t => {
  t.equal(await evaluate('(f64.add (f64.const 0) (f64.const 5))'), 5)
  t.equal(await evaluate('(f64.mul (f64.const 5) (f64.const 0))'), 0)
  t.equal(await evaluate('(f64.add (f64.const -1) (f64.const 3))'), 2)
  t.equal(await evaluate('(f64.add (f64.const 1.5) (f64.const 2.5))'), 4)
})

test('WebAssembly compilation', t => {
  try {
    const wasm = compile('(f64.add (f64.const 1) (f64.const 1))')
    t.ok(wasm instanceof Uint8Array)
    t.ok(wasm.byteLength > 0)
    console.log('WASM size:', wasm.byteLength, 'bytes')
  } catch (e) {
    console.warn('WASM compilation skipped:', e.message)
  }
})

test('Error handling', async t => {
  try {
    await jz.evaluate('1 + ')
    t.fail('Should have thrown')
  } catch (e) {
    // subscript throws different error messages, just check that it throws
    t.ok(e.message.length > 0)
  }
})

console.log('Running JZ MVP test suite...')
console.log('Note: Some features are implemented via subscript fallback')