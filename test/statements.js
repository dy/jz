// Phase 1: Block bodies, control flow, statements
import test from 'tst'
import { is, ok, throws, almost } from 'tst/assert.js'
import compile from '../index.js'
import math from '../module/math.js'

function run(code, opts) {
  const wasm = compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// === Block body with let/return ===

test('block: let + return', () => {
  is(run('export let f = (x) => { let y = x * 2; return y + 1 }').f(3), 7)
})

test('block: multiple lets', () => {
  is(run('export let f = (x) => { let a = x + 1; let b = a * 2; return b }').f(3), 8)
})

test('block: const in body', () => {
  is(run('export let f = (x) => { const y = x * x; return y + 1 }').f(4), 17)
})

// === Assignment operators ===

test('assignment: =', () => {
  is(run('export let f = (x) => { let y = 0; y = x * 2; return y }').f(5), 10)
})

test('assignment: +=', () => {
  is(run('export let f = (x) => { let y = 10; y += x; return y }').f(5), 15)
})

test('assignment: -=', () => {
  is(run('export let f = (x) => { let y = 10; y -= x; return y }').f(3), 7)
})

test('assignment: *=', () => {
  is(run('export let f = (x) => { let y = 3; y *= x; return y }').f(4), 12)
})

test('assignment: /=', () => {
  is(run('export let f = (x) => { let y = 20; y /= x; return y }').f(4), 5)
})

// === If/else ===

test('if: early return', () => {
  const { f } = run('export let f = (x) => { if (x > 0) return x; return -x }')
  is(f(5), 5)
  is(f(-3), 3)
})

test('if-else: both branches return', () => {
  const { f } = run('export let f = (x) => { if (x > 0) return 1; else return -1 }')
  is(f(5), 1)
  is(f(-5), -1)
})

test('if: comparison ==', () => {
  const { f } = run('export let f = (x) => { if (x == 0) return 42; return x }')
  is(f(0), 42)
  is(f(7), 7)
})

// === For loop ===

test('for: sum 0..n', () => {
  const { f } = run(`export let f = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) s += i
    return s
  }`)
  is(f(0), 0)
  is(f(1), 0)
  is(f(5), 10)  // 0+1+2+3+4
  is(f(10), 45)
})

test('for: factorial', () => {
  const { f } = run(`export let f = (n) => {
    let r = 1
    for (let i = 1; i <= n; i++) r *= i
    return r
  }`)
  is(f(0), 1)
  is(f(1), 1)
  is(f(5), 120)
})

test('for: nested', () => {
  // sum of i*j for i=0..a, j=0..b
  const { f } = run(`export let f = (a, b) => {
    let s = 0
    for (let i = 0; i < a; i++)
      for (let j = 0; j < b; j++)
        s += i * j
    return s
  }`)
  is(f(3, 3), 9)  // (0*0+0*1+0*2) + (1*0+1*1+1*2) + (2*0+2*1+2*2) = 0+3+6
})

// === Logical operators ===

test('&&: short-circuit', () => {
  is(run('export let f = (a, b) => a && b').f(3, 5), 5)
  is(run('export let f = (a, b) => a && b').f(0, 5), 0)
})

test('||: short-circuit', () => {
  is(run('export let f = (a, b) => a || b').f(3, 5), 3)
  is(run('export let f = (a, b) => a || b').f(0, 5), 5)
})

test('&&: chained', () => {
  is(run('export let f = (a, b, c) => a && b && c').f(1, 2, 3), 3)
  is(run('export let f = (a, b, c) => a && b && c').f(1, 0, 3), 0)
})

test('||: chained', () => {
  is(run('export let f = (a, b, c) => a || b || c').f(0, 0, 3), 3)
  is(run('export let f = (a, b, c) => a || b || c').f(0, 2, 3), 2)
})

// === Combined patterns ===

test('abs via if', () => {
  const { f } = run('export let f = (x) => { if (x < 0) return -x; return x }')
  is(f(5), 5)
  is(f(-5), 5)
  is(f(0), 0)
})

test('clamp via if', () => {
  const { f } = run(`export let f = (x, lo, hi) => {
    if (x < lo) return lo
    if (x > hi) return hi
    return x
  }`)
  is(f(5, 0, 10), 5)
  is(f(-1, 0, 10), 0)
  is(f(15, 0, 10), 10)
})

test('power via loop', () => {
  // x^n via repeated multiplication
  const { f } = run(`export let f = (x, n) => {
    let r = 1
    for (let i = 0; i < n; i++) r *= x
    return r
  }`)
  is(f(2, 0), 1)
  is(f(2, 10), 1024)
  is(f(3, 4), 81)
})

test('with math module', () => {
  const { f } = run(`export let f = (x) => {
    let y = Math.abs(x)
    return Math.sqrt(y)
  }`, { modules: [math] })
  is(f(16), 4)
  is(f(-16), 4)
})

test('inter-function call from block body', () => {
  const { f } = run(`
    let square = x => x * x
    export let f = (x) => {
      let y = square(x)
      return y + 1
    }
  `)
  is(f(3), 10)
  is(f(5), 26)
})
