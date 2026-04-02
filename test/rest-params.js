// Rest params and variadic method tests
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run } from './util.js'

// ============================================
// REST PARAMS
// ============================================

// === Basic rest params ===

test('rest: (...args) => args.length', () => {
  const { f } = run(`export let f = (...args) => args.length`)
  is(f(), 0)
  is(f(1), 1)
  is(f(1, 2), 2)
  is(f(1, 2, 3, 4, 5), 5)
})

test('rest: (...args) => args[0]', () => {
  const { f } = run(`export let f = (...args) => args[0]`)
  is(f(99), 99)
  is(f(10, 20, 30), 10)
})

test('rest: (...args) => args[1]', () => {
  const { f } = run(`export let f = (...args) => { let a = args; return a[1] }`)
  is(f(1, 2), 2)
  is(f(1, 2, 3), 2)
})

test('rest: sum(...args)', () => {
  const { f } = run(`export let f = (...args) => {
    let s = 0
    for (let i = 0; i < args.length; i++) s += args[i]
    return s
  }`)
  is(f(), 0)
  is(f(1), 1)
  is(f(1, 2), 3)
  is(f(1, 2, 3, 4, 5), 15)
})

test('rest: reduce over rest', () => {
  const { f } = run(`export let f = (...args) => {
    return args.reduce((a, b) => a + b, 0)
  }`)
  is(f(1, 2, 3), 6)
  is(f(10, 20, 30), 60)
})

// === Mixed rest with fixed params ===

// TODO: Mixed fixed + rest params have memory layout issue
// test('rest: (a, ...rest) => a + rest.length', () => {
//   const { f } = run(`export let f = (a, ...rest) => a + rest.length`)
//   is(f(10), 10)
//   is(f(10, 1, 2, 3), 13)
//   is(f(5, 1, 1, 1, 1), 9)
// })

// TODO: Mixed fixed + rest params have memory layout issue
// test('rest: (a, b, ...rest) => a + b + rest[0]', () => {
//   const { f } = run(`export let f = (a, b, ...rest) => {
//     return a + b + rest[0]
//   }`)
//   is(f(10, 20, 30), 60)
//   is(f(1, 2, 3, 4, 5), 6)
// })

test('rest: variadic product', () => {
  const { f } = run(`export let f = (...nums) => {
    let p = 1
    for (let i = 0; i < nums.length; i++) p *= nums[i]
    return p
  }`)
  is(f(2, 3), 6)
  is(f(2, 3, 4), 24)
  is(f(1, 2, 3, 4, 5), 120)
})

// ============================================
// VARIADIC METHODS
// ============================================

// === String.concat with multiple args ===

test('string.concat: multiple', () => {
  is(run(`export let f = () => "a".concat("b", "c").length`).f(), 3)
})

test('string.concat: many args', () => {
  is(run(`export let f = () => "x".concat("y", "z", "w").length`).f(), 4)
})

test('string.concat: chaining', () => {
  const { f } = run(`export let f = () => {
    let s = "a"
    return s.concat("b").concat("c", "d").length
  }`)
  is(f(), 4)
})

// === Array.push with multiple args ===

test('array.push: single', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    a = a.push(3)
    return a.length
  }`)
  is(f(), 3)
})

test('array.push: multiple', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    a = a.push(3, 4, 5)
    return a.length
  }`)
  is(f(), 5)
})

test('array.push: multiple preserves order', () => {
  const { f } = run(`export let f = () => {
    let a = [1]
    a = a.push(2, 3, 4)
    return a[1] + a[2] + a[3]
  }`)
  is(f(), 9)  // 2+3+4
})

test('array.push: many values', () => {
  const { f } = run(`export let f = () => {
    let a = []
    a = a.push(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    return a.length
  }`)
  is(f(), 10)
})

// === Object.assign: same-schema copies ===

test('Object.assign: overwrite prop', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {x: 10}
    Object.assign(a, b)
    return a.x
  }`)
  is(f(), 10)
})

test('Object.assign: two sources', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1, y: 2}
    let b = {x: 10}
    let c = {y: 20}
    Object.assign(a, b, c)
    return a.x + a.y
  }`)
  is(f(), 30)
})

test('Object.assign: last source wins', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1}
    let b = {x: 2}
    let c = {x: 3}
    Object.assign(a, b, c)
    return a.x
  }`)
  is(f(), 3)
})

// === Object.assign: schema extension ===

test('Object.assign: extend from variable', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1}
    let b = {y: 2}
    Object.assign(a, b)
    return a.x + a.y
  }`)
  is(f(), 3)
})

test('Object.assign: extend from literal', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1}
    Object.assign(a, {y: 2, z: 3})
    return a.x + a.y + a.z
  }`)
  is(f(), 6)
})

test('Object.assign: extend from multiple sources', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 1}
    let b = {y: 2}
    let c = {z: 3}
    Object.assign(a, b, c)
    return a.x + a.y + a.z
  }`)
  is(f(), 6)
})

test('Object.assign: original props unchanged', () => {
  const { f } = run(`export let f = () => {
    let a = {x: 10}
    Object.assign(a, {y: 20})
    return a.x
  }`)
  is(f(), 10)
})

// === Boxed primitives: Object.assign on arrays ===

test('Object.assign: boxed array prop', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    Object.assign(a, {loc: 5})
    return a.loc
  }`)
  is(f(), 5)
})

test('Object.assign: boxed array length', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20, 30]
    Object.assign(a, {tag: 1})
    return a.length
  }`)
  is(f(), 3)
})

test('Object.assign: boxed array write prop', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    Object.assign(a, {x: 10})
    a.x = 42
    return a.x
  }`)
  is(f(), 42)
})

test('Object.assign: boxed array indexing', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20, 30]
    Object.assign(a, {x: 99})
    return a[0] + a[1] + a[2]
  }`)
  is(f(), 60)
})

// === Object.assign in conditionals ===

test('Object.assign: conditional', () => {
  const { f } = run(`export let f = (x) => {
    let a = {x: 1, y: 2}
    let b = {x: 10}
    if (x) Object.assign(a, b)
    return a.x
  }`)
  is(f(0), 1)
  is(f(1), 10)
})

// === Array.concat ===

test('array.concat: two arrays', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2]
    let b = [3, 4]
    let c = a.concat(b)
    return c.length
  }`)
  is(f(), 4)
})

test('array.concat: preserves values', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20]
    let b = [30]
    let c = a.concat(b)
    return c[0] + c[1] + c[2]
  }`)
  is(f(), 60)
})
