// Comprehensive spread operator tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'

// ============================================
// SPREAD IN ARRAY LITERALS
// ============================================

test('spread: [...arr] basic', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = [...a]
    return b.length
  }`)
  is(f(), 3)
})

test('spread: [...a, ...b] concatenate', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    let b = [3, 4]
    let c = [...a, ...b]
    return c.length
  }`)
  is(f(), 4)
})

test('spread: [...a, 5, ...b] mixed', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    let b = [4, 5]
    let c = [...a, 3, ...b]
    return c.length
  }`)
  is(f(), 5)
})

test('spread: [...arr] preserves values', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20, 30]
    let b = [...a]
    return b[0] + b[1] + b[2]
  }`)
  is(f(), 60)
})

test('spread: [...arr] creates new array', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    let b = [...a]
    b.push(3)
    return a.length
  }`)
  is(f(), 2)  // original unchanged
})

test('spread: empty spread', () => {
  const { f } = run(`export let f = () => {
    let a = []
    let b = [...a]
    return b.length
  }`)
  is(f(), 0)
})

// ============================================
// SPREAD IN FUNCTION CALLS WITH REST PARAMS
// ============================================

test('spread in call: f(...arr) with rest', () => {
  const { f } = run(`export let f = (...args) => args.length`)
  is(f(...[1, 2, 3]), 3)  // JS-side spread into rest function
})

test('spread in call: mixed args with rest', () => {
  const { f } = run(`export let f = (...args) => args[1]`)
  is(f(10, ...[20, 30]), 20)
})

test('spread in WASM call: f(...arr)', () => {
  // Spread inside WASM code calling rest function
  const { f } = run(`export let f = () => {
    let sum = (...nums) => {
      let s = 0
      for (let i = 0; i < nums.length; i++) s += nums[i]
      return s
    }
    let arr = [1, 2, 3]
    return sum(...arr)
  }`)
  is(f(), 6)
})

test('spread in WASM call: mixed', () => {
  const { f } = run(`export let f = () => {
    let sum = (...nums) => {
      let s = 0
      for (let i = 0; i < nums.length; i++) s += nums[i]
      return s
    }
    let arr = [2, 3]
    return sum(1, ...arr, 4)
  }`)
  is(f(), 10)  // 1+2+3+4
})

// ============================================
// SPREAD IN ARRAY METHODS
// ============================================

test('spread: .push(...values)', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    a.push(2, 3, 4)
    return a.length
  }`)
  is(f(), 4)
})

test('spread: [...a].length after push', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    a.push(2, 3)
    let b = [...a]
    return b.length
  }`)
  is(f(), 3)
})

// ============================================
// SPREAD IN METHOD CALLS WITH VARIADIC
// ============================================

test('spread: string.concat(...strings)', () => {
  const { f } = run(`export let f = () => {
    let parts = ["b", "c"]
    return "a".concat(...parts).length
  }`)
  is(f(), 3)
})

test('spread: Object.assign(...objects)', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1}
    let b = {y: 2}
    let c = {z: 3}
    Object.assign(a, b, c)
    return a.x + a.y + a.z
  }`)
  is(f(), 6)
})

// ============================================
// EDGE CASES
// ============================================

test('spread: nested arrays', () => {
  const { f } = run(`export let f = () => {
    let a = [[1, 2], [3, 4]]
    let b = [...a]
    return b.length
  }`)
  is(f(), 2)
})

test('spread: single element', () => {
  const { f } = run(`export let f = () => {
    let a = [42]
    let b = [...a]
    return b[0]
  }`)
  is(f(), 42)
})

test('spread: chain spreads', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    let b = [2]
    let c = [3]
    let d = [...[...a, ...b], ...c]
    return d.length
  }`)
  is(f(), 3)
})
