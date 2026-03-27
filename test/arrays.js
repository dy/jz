// Memory arrays: NaN-boxed pointers, array literals, indexing
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import compile from '../index.js'

function run(code, opts) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)
  return inst.exports
}

// === Array literal + index read ===

test('array: literal + read', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20, 30]
    return a[1]
  }`)
  is(f(), 20)
})

test('array: read all elements', () => {
  const { f } = run(`export let f = (i) => {
    let a = [100, 200, 300]
    return a[i]
  }`)
  is(f(0), 100)
  is(f(1), 200)
  is(f(2), 300)
})

// === Array index write ===

test('array: write + read', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    a[0] = 99
    return a[0]
  }`)
  is(f(), 99)
})

test('array: write computed', () => {
  const { f } = run(`export let f = (i, v) => {
    let a = [0, 0, 0]
    a[i] = v
    return a[i]
  }`)
  is(f(1, 42), 42)
})

// === Array in loop ===

test('array: fill via loop', () => {
  const { f } = run(`export let f = (n) => {
    let a = [0, 0, 0, 0, 0]
    for (let i = 0; i < 5; i++) a[i] = i * i
    return a[n]
  }`)
  is(f(0), 0)
  is(f(1), 1)
  is(f(2), 4)
  is(f(3), 9)
  is(f(4), 16)
})

test('array: sum elements', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3, 4, 5]
    let s = 0
    for (let i = 0; i < 5; i++) s += a[i]
    return s
  }`)
  is(f(), 15)
})

// === Array as pointer (pass between functions) ===

test('array: pass to function', () => {
  const { f } = run(`
    let sum3 = (a) => a[0] + a[1] + a[2]
    export let f = () => {
      let a = [10, 20, 30]
      return sum3(a)
    }
  `)
  is(f(), 60)
})

// === Return array as pointer ===

test('array: return pointer', () => {
  const { f, g } = run(`
    export let f = () => {
      let a = [5, 10, 15]
      return a
    }
    export let g = (a) => a[0] + a[1] + a[2]
  `)
  const ptr = f()
  ok(typeof ptr === 'number')
  ok(isNaN(ptr))  // NaN-boxed pointer!
  is(g(ptr), 30)  // pass pointer back to WASM
})

// === Multi-value vs pointer: literal return = multi-value ===

test('array: literal return is multi-value, not pointer', () => {
  const { f } = run('export let f = (a, b) => [a + 1, b + 2]')
  const result = f(10, 20)
  ok(Array.isArray(result))  // JS gets real Array from multi-value
  is(result[0], 11)
  is(result[1], 22)
})
