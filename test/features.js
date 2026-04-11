// Spread, destruct alias, TypedArrays, Set, Map
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'

const interp = { __ext_prop:()=>0, __ext_has:()=>0, __ext_set:()=>0, __ext_call:()=>0 }
function run(code) {
  return new WebAssembly.Instance(new WebAssembly.Module(compile(code)), { env: interp }).exports
}

// === Object destruct alias ===

test('destruct: {x: a, y: b} = obj', () => {
  is(run(`export let f = () => {
    let o = {x: 10, y: 20}
    let {x: a, y: b} = o
    return a + b
  }`).f(), 30)
})

// === Array spread ===

test('spread: [...a, ...b]', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    let b = [3, 4]
    let c = [...a, ...b]
    return c.length
  }`)
  is(f(), 4)
})

test('spread: [...a, ...b] values', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20]
    let b = [30, 40]
    let c = [...a, ...b]
    return c[0] + c[1] + c[2] + c[3]
  }`)
  is(f(), 100)
})

test('spread: [...a, 99]', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = [...a, 99]
    return b[3]
  }`)
  is(f(), 99)
})

// === TypedArrays ===

test('Float64Array: create + length', () => {
  const { f } = run(`export let f = () => {
    let a = new Float64Array(10)
    return a
  }`)
  ok(isNaN(f()))  // NaN-boxed pointer
})

test('Int32Array: create', () => {
  const { f } = run(`export let f = () => {
    let a = new Int32Array(5)
    return a
  }`)
  ok(isNaN(f()))
})

// === Set ===

test('Set: create + add + has', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(42)
    return s.has(42)
  }`)
  is(f(), 1)
})

test('Set: has missing', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(1)
    return s.has(99)
  }`)
  is(f(), 0)
})

test('Set: size', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(1)
    s = s.add(2)
    s = s.add(3)
    return s.size
  }`)
  is(f(), 3)
})

test('Set: no duplicates', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(1)
    s = s.add(1)
    s = s.add(1)
    return s.size
  }`)
  is(f(), 1)
})

test('Set: delete returns 1 if found', () => {
  const { f } = run(`export let f = () => {
    let s = new Set()
    s = s.add(10)
    return s.delete(10) + s.has(10)
  }`)
  is(f(), 1)  // delete=1, has=0
})

// === Map ===

test('Map: set + get', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m = m.set(1, 100)
    m = m.set(2, 200)
    return m.get(1) + m.get(2)
  }`)
  is(f(), 300)
})

test('Map: get missing returns nullish', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m = m.set(1, 100)
    return m.get(99)
  }`)
  ok(Number.isNaN(f()))
})

test('Map: overwrite', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m = m.set(1, 100)
    m = m.set(1, 999)
    return m.get(1)
  }`)
  is(f(), 999)
})

test('Map: size', () => {
  const { f } = run(`export let f = () => {
    let m = new Map()
    m = m.set(1, 10)
    m = m.set(2, 20)
    m = m.set(3, 30)
    return m.size
  }`)
  is(f(), 3)
})
