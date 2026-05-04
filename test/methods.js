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
  ok(Number.isNaN(run(`export let f = () => [1, 2, 3].find((x) => x > 10)`).f()))
})

// === .indexOf ===

test('.indexOf: found', () => {
  is(run(`export let f = () => [10, 20, 30].indexOf(20)`).f(), 1)
})

test('.indexOf: not found', () => {
  is(run(`export let f = () => [10, 20, 30].indexOf(99)`).f(), -1)
})

// String equality must compare values, not NaN-boxed pointer bits — distinct
// allocations of the same string literal land at different heap addresses, so
// f64.eq treats them as unequal. indexOf/includes must route through __eq.
test('.indexOf: string found', () => {
  is(run(`export let f = () => ["A","B","C"].indexOf("B")`).f(), 1)
})

test('.indexOf: string via variable still matches', () => {
  is(run(`export let f = () => { let x = "B"; return ["A","B","C"].indexOf(x) }`).f(), 1)
})

// === .includes ===

test('.includes: found', () => {
  is(run(`export let f = () => [10, 20, 30].includes(20)`).f(), 1)
})

test('.includes: not found', () => {
  is(run(`export let f = () => [10, 20, 30].includes(99)`).f(), 0)
})

test('.includes: string found', () => {
  is(run(`export let f = () => ["A","B","C"].includes("B")`).f(), 1)
})

test('.includes: string via variable still matches', () => {
  is(run(`export let f = () => { let x = "B"; return ["A","B","C"].includes(x) }`).f(), 1)
})

// === .shift ===

test('.shift: repeated shifts update visible array', () => {
  is(run(`export let f = () => {
    let a = [10, 20, 30, 40]
    let x = a.shift()
    let y = a.shift()
    return x + y * 10 + a.length * 100 + a[0] * 1000
  }`).f(), 30410)
})

test('.shift: aliases follow shifted storage', () => {
  is(run(`export let f = () => {
    let a = [5, 6, 7]
    let b = a
    a.shift()
    return b.length * 100 + b[0] * 10 + b[1]
  }`).f(), 267)
})

test('.shift: push after shift appends after live tail', () => {
  is(run(`export let f = () => {
    let a = [1, 2, 3]
    a.shift()
    a.push(9)
    return a.length * 100 + a[0] * 10 + a[2]
  }`).f(), 329)
})

test('.shift: dynamic properties move with array', () => {
  is(run(`export let f = () => {
    let a = [1, 2, 3]
    a.name = 7
    a.shift()
    return a.name + a.length * 100 + a[0] * 10
  }`).f(), 227)
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

test('.slice: negative and omitted bounds', () => {
  const { f } = run(`export let f = () => {
    let b = [10, 20, 30, 40, 50].slice(-3)
    return b.length * 1000 + b[0] * 100 + b[1] * 10 + b[2]
  }`)
  is(f(), 6450)
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

test('.flatMap: preserves prior output across growth', () => {
  is(run(`export let f = () => { let a = [1, 2, 3, 4, 5].flatMap((x) => [x, x + 10]); return a.length * 100 + a[0] + a[9] }`).f(), 1016)
})

// === Chained ===

test('chain: map + reduce', () => {
  is(run(`export let f = () => [1, 2, 3].map((x) => x * x).reduce((s, x) => s + x, 0)`).f(), 14)
})

test('chain: map + filter', () => {
  let { f } = run(`export let f = () => {
    let r = [1, 2, 3, 4, 5].map((x) => x * 2).filter((x) => x > 4)
    return r[0] * 10000 + r[1] * 100 + r[2] + r.length * 1000000
  }`)
  is(f(), 3060810)  // 3*1M + 6*10K + 8*100 + 10
})

test('chain: map + filter Boolean', () => {
  is(run(`export let f = () => [0, 1, 2, 3].map((x) => x - 1).filter(Boolean).length`).f(), 3)
})

test('chain: filter + map', () => {
  let { f } = run(`export let f = () => {
    let r = [1, 2, 3, 4, 5].filter((x) => x > 2).map((x) => x * 10)
    return r[0] * 10000 + r[1] * 100 + r[2] + r.length * 1000000
  }`)
  is(f(), 3304050)  // 3*1M + 30*10K + 40*100 + 50
})

test('chain: map + forEach', () => {
  let { f } = run(`export let f = () => { let s = 0; [1, 2, 3].map((x) => x * x).forEach((x) => { s = s + x }); return s }`)
  is(f(), 14)
})

test('chain: filter + forEach', () => {
  let { f } = run(`export let f = () => { let s = 0; [1, 2, 3, 4].filter((x) => x > 2).forEach((x) => { s = s + x }); return s }`)
  is(f(), 7)
})

test('chain: filter + reduce', () => {
  is(run(`export let f = () => [1, 2, 3, 4, 5].filter((x) => x > 2).reduce((s, x) => s + x, 0)`).f(), 12)
})
