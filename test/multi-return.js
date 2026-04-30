// Phase 2: Multi-value return tests
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile } from '../index.js'

function run(code, opts) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// Multi-value just works — no profile needed

test('multi-return: just works', () => {
  const { f } = run('export let f = (a, b) => [a, b]')
  ok(f)
})

// === Expression body multi-return ===

test('multi: 2-value return', () => {
  const { f } = run('export let f = (a, b) => [a + 1, b * 2]')
  const [x, y] = f(3, 5)
  is(x, 4)
  is(y, 10)
})

test('multi: 3-value return', () => {
  const { f } = run('export let f = (a, b, c) => [a * 2, b * 3, c * 4]')
  const [x, y, z] = f(1, 2, 3)
  is(x, 2)
  is(y, 6)
  is(z, 12)
})

test('multi: identity', () => {
  const { f } = run('export let f = (a, b) => [a, b]')
  const [x, y] = f(42, 99)
  is(x, 42)
  is(y, 99)
})

// === Block body multi-return ===

test('multi: block body return', () => {
  const { f } = run(`export let f = (x) => {
    let y = x * 2
    return [x, y]
  }`)
  const [a, b] = f(5)
  is(a, 5)
  is(b, 10)
})

test('multi: block body with if', () => {
  const { f } = run(`export let f = (x) => {
    if (x > 0) return [x, 1]
    return [-x, -1]
  }`)
  const [a, b] = f(5)
  is(a, 5)
  is(b, 1)
  const [c, d] = f(-3)
  is(c, 3)
  is(d, -1)
})

// === Color-space pattern ===

test('multi: rgb2xyz pattern', () => {
  const { rgb2xyz } = run(`export let rgb2xyz = (r, g, b) => [
    r * 0.4124 + g * 0.3576 + b * 0.1805,
    r * 0.2126 + g * 0.7152 + b * 0.0722,
    r * 0.0193 + g * 0.1192 + b * 0.9505
  ]`)
  const [x, y, z] = rgb2xyz(1, 1, 1)
  // Sum of coefficients for each row
  ok(Math.abs(x - 0.9505) < 0.001)
  ok(Math.abs(y - 1.0) < 0.001)
  ok(Math.abs(z - 1.089) < 0.001)
})

// === Single-value still works in multi profile ===

test('multi profile: single return still works', () => {
  const { f } = run('export let f = (a, b) => a + b')
  is(f(2, 3), 5)
})

test('multi profile: block single return', () => {
  const { f } = run(`export let f = (x) => {
    let y = x * 2
    return y
  }`)
  is(f(5), 10)
})
