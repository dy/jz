import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { evaluate } from './util.js'

// Basic nested function definition and call
test('nested function - basic', async () => {
  is(await evaluate('outer = (x) => { inner = (y) => x + y; inner(5) }; outer(10)'), 15)
})

test('nested function - multiple captures', async () => {
  is(await evaluate('outer = (a, b) => { inner = (c) => a + b + c; inner(3) }; outer(1, 2)'), 6)
})

// Closure capture - inner functions capture outer variables
test('closure capture - read', async () => {
  is(await evaluate('x = 10; fn = () => x; fn()'), 10)
})

test('closure capture - from param', async () => {
  is(await evaluate('outer = (x) => { inner = () => x; inner() }; outer(42)'), 42)
})

// Mutation of captured variables - NOT SUPPORTED (closures capture by value)
// Note: globals CAN be mutated, only captured locals cannot
// These tests verify the error message is thrown for captured local mutation
test('closure capture - mutation in inner scope throws error', async t => {
  try {
    await evaluate('outer = () => { count = 0; inc = () => { count = count + 1; count }; inc() }; outer()')
    t.fail('Should have thrown')
  } catch (e) {
    t.ok(e.message.includes('Cannot mutate captured variable'), e.message)
  }
})

test('closure capture - mutation of nested local throws error', async t => {
  try {
    await evaluate('outer = () => { x = 0; inner = () => { x = x + 1 }; inner() }; outer()')
    t.fail('Should have thrown')
  } catch (e) {
    t.ok(e.message.includes('Cannot mutate captured variable'), e.message)
  }
})

// Note: shared environment with mutation is NOT supported
// Closures capture by value, not by reference
test.skip('closure - shared environment (unsupported)', async () => {
  // Two closures sharing the same captured variable
  is(await evaluate(`
    maker = () => {
      val = 0;
      inc = () => { val = val + 1; val };
      get = () => val;
      inc(); inc();
      get()
    };
    maker()
  `), 2)
})

// Closure passed to higher-order function
test('closure - with map', async () => {
  is(await evaluate('factor = 10; [1, 2, 3].map((x) => x * factor).reduce((a, b) => a + b, 0)'), 60)
})

// Array capture works in gc:false mode
// gc:true mode has issues storing refs in f64 struct fields
test.todo('closure - array capture (gc:false only)', async () => {
  is(await evaluate('arr = [1, 2, 3]; sum = () => arr[0] + arr[1] + arr[2]; sum()'), 6)
})

// First-class functions (returning closures, currying)
test('closure - currying', async () => {
  is(await evaluate('add = (x) => (y) => x + y; add5 = add(5); add5(3)'), 8)
})

test('closure - currying with multiple args', async () => {
  is(await evaluate('make = (a, b) => (c) => a * b + c; fn = make(2, 3); fn(4)'), 10)
})

test('closure - nested depth 2', async () => {
  is(await evaluate('a = (x) => (y) => (z) => x + y + z; a(1)(2)(3)'), 6)
})

// Closure capturing i32 pointer param (Phase 7: closure boundary reboxing)
// When internal func has i32 array param and closure captures it,
// the i32 offset must be reboxed to f64 pointer for the closure env
test('closure - i32 array param capture', async () => {
  const { compile } = await import('./util.js')
  // process uses arr[0] to trigger i32 param, closure captures arr
  const mod = await compile(`
    const process = arr => {
      const first = arr[0]
      const getLen = () => arr.length
      return first + getLen()
    }
    export const main = arr => arr.reduce((s, x) => s + x, 0) + process(arr)
  `)
  // reduce([10,20,30]) = 60, process returns first(10) + len(3) = 13
  is(mod.main([10, 20, 30]), 73)
})
