// Type coercion: i32/f64 by operator, bitwise ops, named constants
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import compile from '../index.js'

function run(code, opts) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// === Integer preservation ===

test('type: 1 + 2 stays i32 internally', () => {
  is(run('export let f = () => 1 + 2').f(), 3)
})

test('type: 1.0 + 2.0 is f64', () => {
  is(run('export let f = () => 1.0 + 2.0').f(), 3)
})

test('type: mixed i32 + f64 promotes', () => {
  is(run('export let f = () => 1 + 2.5').f(), 3.5)
})

test('type: division always f64', () => {
  is(run('export let f = () => 10 / 3').f(), 10 / 3)
})

test('type: i32 chain', () => {
  is(run('export let f = (a, b) => a * 2 + b * 3').f(4, 5), 23)
})

test('type: local preserves i32', () => {
  is(run('export let f = () => { let x = 5; let y = 3; return x + y }').f(), 8)
})

test('type: local widens to f64', () => {
  is(run('export let f = () => { let x = 5; x = 2.5; return x }').f(), 2.5)
})

// === Bitwise operators ===

test('bitwise: &', () => {
  is(run('export let f = (a, b) => a & b').f(0xFF, 0x0F), 0x0F)
})

test('bitwise: |', () => {
  is(run('export let f = (a, b) => a | b').f(0xF0, 0x0F), 0xFF)
})

test('bitwise: ^', () => {
  is(run('export let f = (a, b) => a ^ b').f(0xFF, 0x0F), 0xF0)
})

test('bitwise: ~', () => {
  is(run('export let f = (a) => ~a').f(0), -1)
})

test('bitwise: <<', () => {
  is(run('export let f = (a, b) => a << b').f(1, 8), 256)
})

test('bitwise: >>', () => {
  is(run('export let f = (a, b) => a >> b').f(256, 4), 16)
})

test('bitwise: >>>', () => {
  is(run('export let f = (a, b) => a >>> b').f(256, 4), 16)
})

test('bitwise: floatbeat t >> 8 & 255', () => {
  is(run('export let f = (t) => t >> 8 & 255').f(0x1234), 0x12)
})

// === Named constants ===

test('constant: true', () => {
  is(run('export let f = () => true').f(), 1)
})

test('constant: false', () => {
  is(run('export let f = () => false').f(), 0)
})

test('constant: null', () => {
  is(run('export let f = () => null').f(), 0)
})

test('constant: NaN', () => {
  ok(isNaN(run('export let f = () => NaN').f()))
})

test('constant: Infinity', () => {
  is(run('export let f = () => Infinity').f(), Infinity)
})

test('constant: true/false in condition', () => {
  is(run('export let f = () => { if (true) return 1; return 0 }').f(), 1)
  is(run('export let f = () => { if (false) return 1; return 0 }').f(), 0)
})

test('comparison result in bitwise', () => {
  is(run('export let f = (a, b) => (a > b) & 1').f(5, 3), 1)
  is(run('export let f = (a, b) => (a > b) & 1').f(1, 3), 0)
})

// === Nullish coalescing ===

test('??: returns left if truthy', () => {
  is(run('export let f = (a, b) => a ?? b').f(5, 10), 5)
})

test('??: returns right if left is 0', () => {
  is(run('export let f = (a, b) => a ?? b').f(0, 10), 10)
})

// === void ===

test('void: returns 0', () => {
  is(run('export let f = (x) => void x').f(42), 0)
})

// === switch ===

test('switch: with default', () => {
  const { f } = run(`export let f = (x) => {
    switch(x) { case 1: return 10; default: return 0 }
  }`)
  is(f(1), 10)
  is(f(99), 0)
})

test('switch: two cases', () => {
  // Note: parser has recursion limit with many cases in block body
  const { f } = run(`export let f = (x) => {
    switch(x) { case 1: return 10; case 2: return 20 }
    return -1
  }`)
  is(f(1), 10)
  is(f(2), 20)
  is(f(99), -1)
})

// === Default params ===

test('default param: used when arg missing', () => {
  const { f } = run('export let f = (x = 5) => x')
  is(f(), 5)    // missing → NaN → default kicks in
  is(f(0), 0)   // explicit 0 is NOT missing
  is(f(3), 3)
})

test('default param: second param', () => {
  const { f } = run('export let f = (a, b = 10) => a + b')
  is(f(1, 2), 3)
  is(f(1), 11)   // b missing → NaN → default 10
})
