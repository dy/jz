// Closures: capture by value, currying, callbacks, first-class functions
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import compile from '../index.js'

function run(code) {
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// === Basic closure (capture outer variable) ===

test('closure: capture param', () => {
  is(run(`
    export let makeAdder = (n) => (x) => x + n
    export let test = () => {
      let add5 = makeAdder(5)
      return add5(10)
    }
  `).test(), 15)
})

test('closure: capture multiple values', () => {
  is(run(`
    export let test = () => {
      let a = 10
      let b = 20
      let fn = (x) => x + a + b
      return fn(3)
    }
  `).test(), 33)
})

// === Currying ===

test('closure: currying', () => {
  const { test } = run(`
    export let add = (a) => (b) => a + b
    export let test = () => {
      let add3 = add(3)
      return add3(7) + add3(10)
    }
  `)
  is(test(), 23)  // 10 + 13
})

test('closure: curried mul', () => {
  is(run(`
    export let mul = (a) => (b) => a * b
    export let test = () => {
      let double = mul(2)
      let triple = mul(3)
      return double(5) + triple(5)
    }
  `).test(), 25)  // 10 + 15
})

// === Callbacks ===

test('closure: pass function as callback', () => {
  is(run(`
    let apply = (fn, x) => fn(x)
    export let test = () => {
      let double = (x) => x * 2
      return apply(double, 21)
    }
  `).test(), 42)
})

test('closure: callback with capture', () => {
  is(run(`
    let apply = (fn, x) => fn(x)
    export let test = () => {
      let n = 100
      let addN = (x) => x + n
      return apply(addN, 5)
    }
  `).test(), 105)
})

// === No captures (function reference) ===

test('closure: no-capture function reference', () => {
  is(run(`
    export let test = () => {
      let neg = (x) => -x
      return neg(42)
    }
  `).test(), -42)
})

// === Closure preserves value at creation time ===

test('closure: captures value, not reference', () => {
  is(run(`
    export let test = () => {
      let n = 10
      let fn = (x) => x + n
      n = 999
      return fn(5)
    }
  `).test(), 15)  // captures n=10, not n=999
})

// === Multiple closures from same factory ===

test('closure: multiple instances', () => {
  const { test } = run(`
    export let make = (n) => (x) => x * n
    export let test = () => {
      let x2 = make(2)
      let x3 = make(3)
      let x10 = make(10)
      return x2(5) + x3(5) + x10(5)
    }
  `)
  is(test(), 75)  // 10 + 15 + 50
})
