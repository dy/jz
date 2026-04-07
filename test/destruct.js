// Destructuring, optional chaining, typeof
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'

function run(code) {
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  return new WebAssembly.Instance(mod).exports
}

// ============================================
// Array destructuring
// ============================================

test('destruct: let [a, b] = arr', () => {
  const { f } = run(`export let f = () => {
    let arr = [10, 20, 30]
    let [a, b, c] = arr
    return a + b + c
  }`)
  is(f(), 60)
})

test('destruct: from pointer array', () => {
  const { f } = run(`export let f = () => {
    let pair = [7, 11]
    let [a, b] = pair
    return a * 10 + b
  }`)
  is(f(), 81)  // 7*10 + 11
})

test('destruct: partial array', () => {
  const { f } = run(`export let f = () => {
    let a = [100, 200, 300]
    let [x, y] = a
    return x + y
  }`)
  is(f(), 300)  // only first two elements
})

// ============================================
// Object destructuring
// ============================================

test('destruct: let {x, y} = obj', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 3, y: 4}
    let {x, y} = o
    return x * x + y * y
  }`)
  is(f(), 25)
})

test('destruct: object in function', () => {
  const { f } = run(`
    let mag2 = (v) => {
      let {x, y} = v
      return x * x + y * y
    }
    export let f = () => mag2({x: 5, y: 12})
  `)
  is(f(), 169)
})

// ============================================
// Optional chaining
// ============================================

test('optional: ?.prop on valid object', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 42, y: 0}
    return o?.x
  }`)
  is(f(), 42)
})

test('optional: ?.prop on null returns 0', () => {
  // null is 0 in jz — ?.prop should return 0
  const { f } = run(`export let f = () => {
    let o = null
    return o?.x
  }`)
  is(f(), 0)
})

test('optional: ?.[i] on valid array', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20]
    return a?.[1]
  }`)
  is(f(), 20)
})

test('optional: ?.[i] on null returns 0', () => {
  const { f } = run(`export let f = () => {
    let a = null
    return a?.[0]
  }`)
  is(f(), 0)
})

test('optional: ?.[i] on string returns char code', () => {
  const { f } = run(`export let f = () => {
    let s = "ab"
    return s?.[1]
  }`)
  is(f(), 98)  // 'b' = 98
})

test('optional: ?.length on array', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    return a?.length
  }`)
  is(f(), 3)
})

test('optional: ?.length on string', () => {
  const { f } = run(`export let f = () => {
    let s = "abc"
    return s?.length
  }`)
  is(f(), 3)
})

test('optional: ?.length on null returns 0', () => {
  const { f } = run(`export let f = () => {
    let a = null
    return a?.length
  }`)
  is(f(), 0)
})

test('optional: ?.[i] evaluates base once', () => {
  // Base expression should not be re-evaluated in the then branch
  const { f } = run(`export let f = () => {
    let c = 0
    let a = [100, 200]
    let r = a?.[c]
    return r
  }`)
  is(f(), 100)
})

test('optional: ?.prop on dynamic HASH object', () => {
  is(run(`export let f = () => {
    let o = JSON.parse('{"x":1}')
    return o?.x
  }`).f(), 1)
})

// ============================================
// typeof
// ============================================

test('typeof: number', () => {
  // -1 = plain number
  is(run('export let f = () => typeof 42').f(), -1)
})

test('typeof: array (pointer)', () => {
  // 1 = ARRAY type
  const { f } = run('export let f = () => { let a = [1,2]; return typeof a }')
  is(f(), 1)
})

test('typeof: object (pointer)', () => {
  // 6 = OBJECT type
  const { f } = run('export let f = () => { let o = {x: 1}; return typeof o }')
  is(f(), 6)
})

test('typeof: string SSO', () => {
  // 5 = STRING_SSO
  const { f } = run('export let f = () => { let s = "hi"; return typeof s }')
  is(f(), 5)
})

test('typeof: string heap', () => {
  // 4 = STRING
  const { f } = run('export let f = () => { let s = "hello world"; return typeof s }')
  is(f(), 4)
})
