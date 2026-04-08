// Array methods: map, filter, reduce, forEach, find, indexOf, includes, slice
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'

function run(code) {
  const wasm = compile(code)
  return new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports
}

// === .map ===

test('.map: double', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = a.map((x) => x * 2)
    return b[0] + b[1] + b[2]
  }`)
  is(f(), 12)
})

test('.map: with capture', () => {
  const { f } = run(`export let f = (n) => {
    let a = [1, 2, 3]
    let b = a.map((x) => x + n)
    return b[0] + b[1] + b[2]
  }`)
  is(f(10), 36)  // 11+12+13
})

test('.map: preserves length', () => {
  is(run(`export let f = () => {
    let b = [10, 20, 30, 40, 50].map((x) => x / 10)
    return b.length
  }`).f(), 5)
})

// === .filter ===

test('.filter: basic', () => {
  is(run(`export let f = () => {
    let b = [1, 2, 3, 4, 5].filter((x) => x > 3)
    return b.length
  }`).f(), 2)
})

test('.filter: read elements', () => {
  const { f } = run(`export let f = () => {
    let b = [10, 5, 20, 3, 15].filter((x) => x > 8)
    return b[0] + b[1] + b[2]
  }`)
  is(f(), 45)  // 10+20+15
})

test('.filter: none match', () => {
  is(run(`export let f = () => [1, 2, 3].filter((x) => x > 10).length`).f(), 0)
})

// === .reduce ===

test('.reduce: sum', () => {
  is(run(`export let f = () => [1, 2, 3, 4, 5].reduce((s, x) => s + x, 0)`).f(), 15)
})

test('.reduce: product', () => {
  is(run(`export let f = () => [1, 2, 3, 4].reduce((p, x) => p * x, 1)`).f(), 24)
})

test('.reduce: max', () => {
  is(run(`export let f = () => [3, 7, 2, 9, 1].reduce((m, x) => { if (x > m) return x; return m }, 0)`).f(), 9)
})

// === .forEach ===

test('.forEach: runs without error', () => {
  // forEach returns 0 (void). We can't test side effects because capture is by value.
  is(run(`export let f = () => {
    let a = [1, 2, 3]
    return a.forEach((x) => x * 2)
  }`).f(), 0)
})

// === .find ===

test('.find: found', () => {
  is(run(`export let f = () => [10, 20, 30].find((x) => x > 15)`).f(), 20)
})

test('.find: not found', () => {
  is(run(`export let f = () => [1, 2, 3].find((x) => x > 10)`).f(), 0)
})

// === .indexOf ===

test('.indexOf: found', () => {
  is(run(`export let f = () => [10, 20, 30].indexOf(20)`).f(), 1)
})

test('.indexOf: not found', () => {
  is(run(`export let f = () => [10, 20, 30].indexOf(99)`).f(), -1)
})

// === .includes ===

test('.includes: found', () => {
  is(run(`export let f = () => [10, 20, 30].includes(20)`).f(), 1)
})

test('.includes: not found', () => {
  is(run(`export let f = () => [10, 20, 30].includes(99)`).f(), 0)
})

// === .slice ===

test('.slice: middle', () => {
  const { f } = run(`export let f = () => {
    let b = [10, 20, 30, 40, 50].slice(1, 4)
    return b.length
  }`)
  is(f(), 3)
})

test('.slice: values', () => {
  const { f } = run(`export let f = () => {
    let b = [10, 20, 30, 40, 50].slice(1, 4)
    return b[0] + b[1] + b[2]
  }`)
  is(f(), 90)  // 20+30+40
})

// === .join ===

test('.join: comma sep', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    return a.join(",")
  }`)
  ok(isNaN(f()))  // returns NaN-boxed string pointer
})

// === Chained ===

// === .flat ===

test('.flat: nested arrays', () => {
  is(run(`export let f = () => [[1,2],[3,4],[5]].flat().length`).f(), 5)
})

test('.flat: mixed', () => {
  is(run(`export let f = () => { let a = [[10, 20], 30, [40]].flat(); return a[0] + a[1] + a[2] + a[3] }`).f(), 100)
})

// === .flatMap ===

test('.flatMap: expand', () => {
  is(run(`export let f = () => [1, 2, 3].flatMap((x) => [x, x * 2]).length`).f(), 6)
})

test('.flatMap: values', () => {
  is(run(`export let f = () => { let a = [1, 2].flatMap((x) => [x, x * 10]); return a[0] + a[1] + a[2] + a[3] }`).f(), 33)
})

// === Chained ===

test('chain: map + reduce', () => {
  is(run(`export let f = () => [1, 2, 3].map((x) => x * x).reduce((s, x) => s + x, 0)`).f(), 14)
})
