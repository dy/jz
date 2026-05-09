// Comprehensive spread operator tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'
import { compile } from '../index.js'

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

test('spread: short local array literals scalarize through spread and reads', () => {
  const wat = compile(`export let run = (n) => {
    let s = 0
    for (let i = 0; i < n; i++) {
      let a = [i, i+1]
      let b = [i+2, i+3]
      let c = [...a, 99, ...b]
      s = s + c[0] + c[2] + c[4]
    }
    return s
  }`, { wat: true })
  const start = wat.indexOf('(func $run')
  const end = wat.indexOf('\n  (func', start + 1)
  const body = wat.slice(start, end)
  ok(!/__arr|__alloc_hdr|__mkptr|__len|__typed_idx/.test(body), 'hot spread concat should not materialize arrays')
})

// ============================================
// OBJECT SPREAD
// ============================================

test('spread: {...obj} basic', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {...a}
    return b.x + b.y
  }`)
  is(f(), 3)
})

test('spread: {...a, z: 3} add prop', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {...a, z: 3}
    return b.x + b.y + b.z
  }`)
  is(f(), 6)
})

test('spread: {...a, x: 10} override', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {...a, x: 10}
    return b.x + b.y
  }`)
  is(f(), 12)
})

test('spread: {...a, ...b} merge', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1}
    let b = {y: 2}
    let c = {...a, ...b}
    return c.x + c.y
  }`)
  is(f(), 3)
})

test('spread: {...a, ...b} override order', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {x: 10, y: 20}
    let c = {...a, ...b}
    return c.x + c.y
  }`)
  is(f(), 30)
})

test('spread: {x: 0, ...a} prefix override', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 5, y: 6}
    let b = {x: 0, ...a}
    return b.x + b.y
  }`)
  is(f(), 11)  // a.x overrides the 0
})

// ============================================
// OBJECT REST DESTRUCTURING
// ============================================

test('spread: let {x, ...rest} = obj', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 1, y: 2, z: 3}
    let {x, ...rest} = o
    return x + rest.y + rest.z
  }`)
  is(f(), 6)
})

test('spread: ({x, ...rest} = obj) assignment', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 1, y: 2, z: 3}
    let x, rest
    ;({x, ...rest} = o)
    return x + rest.y + rest.z
  }`)
  is(f(), 6)
})

test('spread: {a: alias, ...rest} with rename', () => {
  const { f } = run(`export let f = () => {
    let o = {a: 10, b: 20, c: 30}
    let {a: first, ...rest} = o
    return first + rest.b + rest.c
  }`)
  is(f(), 60)
})

test('spread: rest gets only remaining props', () => {
  const { f } = run(`export let f = () => {
    let o = {a: 1, b: 2, c: 3, d: 4}
    let {a, b, ...rest} = o
    return a + b + rest.c + rest.d
  }`)
  is(f(), 10)
})
