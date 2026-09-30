// Record identity may disappear only when every reader observes fields or presence.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { run, oracle, wat, funcWat } from './util.js'
import { levels, belowOpt } from './_matrix.js'

const agree = (src) => {
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(src, { optimize })
    for (const name of Object.keys(js)) for (const n of [0, 1, 2, 9])
      is(wasm[name](n), js[name](n), `${name}(${n}), optimize ${optimize}`)
  }
}

const kernel = `export const f = (n) => {
  const hit = { x: 1, y: 2 }
  let sum = 0
  for (let i = 0; i < n; i++) {
    let result = null
    if (i % 2) {
      const target = hit
      target.x += i
      target.y = target.x * 2
      result = target
    }
    const r = result
    if (r !== null) sum += hit.x + hit.y
  }
  return sum
}`

test('scalar record: stable field aliases and null-tested result copies', () => {
  agree(kernel)
  if (belowOpt(1)) return
  const text = wat(kernel)
  ok(!/\b(?:load|store)\b|\$__alloc/.test(text), 'record fields stay in locals, with no heap storage')
})

test('scalar record: nullish receiver guards preserve initialization, identity and fallback effects', () => {
  const src = `export function f(n) {
    let total = 0, calls = 0
    for (let i = 0; i < n; i++) {
      const o = { x: i + 1, y: i * 2 }, a = o ?? (calls++, { x: 99, y: 99 })
      const { x, y } = a
      total += x + y
    }
    return total * 10 + calls
  }
  export function changed(n) {
    let o = { x: n }, calls = 0
    if (n === 0) o = null
    const a = o ?? (calls++, { x: 7 })
    a.x++
    return a.x * 100 + calls * 10 + (a === o ? 1 : 0)
  }
  export function captured(n) {
    let o = { x: n }
    const clear = () => { o = null }
    if (n === 0) clear()
    const { x } = o
    return x
  }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const js = oracle(src), wasm = run(src, { optimize })
    for (const n of [0, 0, 4, 1, 0]) {
      is(wasm.f(n), js.f(n), `guarded fields, n=${n}, O${optimize}`)
      is(wasm.changed(n), js.changed(n), `reassigned receiver, n=${n}, O${optimize}`)
      if (n === 0) throws(() => wasm.captured(n), TypeError)
      else is(wasm.captured(n), js.captured(n), `read after a failed call, O${optimize}`)
    }
  }
  if (!belowOpt(2)) ok(!/__alloc|call_indirect/.test(funcWat(wat(src, { optimize: 2 }), 'f')),
    'the guarded literal keeps its fields in locals')
})

test('scalar record: null and undefined remain distinct through result assignments', () => {
  agree(`export const f = (n) => {
    const o = { x: n + 1 }; let r
    if (n === 1) r = null
    if (n > 1) r = o
    const a = r; let b = a
    return (b === null ? 1 : 0) + (b === undefined ? 2 : 0)
      + (b == null ? 4 : 0) + (null !== b ? 8 : 0)
      + (undefined != b ? 16 : 0) + o.x
  }`)
})

test('scalar record: observed identities, captures, coercions and assignment values keep storage', () => {
  agree(`
export const identity = (n) => { const o = { x: n }; let r = o; return r === o }
export const capture = (n) => { const o = { x: n }; let r = o; const read = () => r.x; o.x++; return read() }
export const relational = (n) => { const o = { x: n }; let r = o; return r > null }
export const assignment = (n) => { const o = { x: n }; let r; const a = (r = o); a.x++; return o.x + (r !== null ? 10 : 0) }
export const rebound = (n) => { let o = { x: n }; const a = o; o = { x: n + 10 }; a.x++; return o.x * 100 + a.x }
export const returnAlias = (n) => { const o = { x: n }; const a = o; return a.x + (a === o ? 10 : 0) }
export const field = (n) => { const o = { x: n }; let r = o; if (n > 1) r = { x: 7 }; return r.x }
export const update = (n) => { const o = { x: n }; let r = o; const old = r++; return old + (r !== null ? 1 : 0) }
`)
})

test('scalar record: escaped aliases preserve object values', () => {
  const save = `let saved; export const f = (n) => { const o = { x: n }; const a = o; saved = a; a.x++; return saved.x }`
  const give = `export const g = (n) => { const o = { x: n }; let r = o; return r }`
  const js = oracle(save), result = oracle(give)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(save, { optimize }), returned = run(give, { optimize })
    for (const n of [0, 4]) {
      is(wasm.f(n), js.f(n))
    }
    for (const n of [0, 4]) is(returned.g(n).x, result.g(n).x)
  }
})

test('scalar record: deleting through an alias preserves an absent field', () => {
  const src = `export const f = (n, key) => {
    const o = { x: n, y: 2 }, a = o
    delete a[key]
    return (o.x === undefined ? 10 : o.x) + (o.y === undefined ? 100 : o.y)
  }`
  const js = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const wasm = run(src, { optimize })
    for (const n of [0, 2]) for (const key of ['x', 'y', 'absent'])
      is(wasm.f(n, key), js.f(n, key), `${key}, n=${n}, optimize ${optimize}`)
  }
})

test('scalar record: class factory undefined slots and aliased method results', () => {
  const src = `class Point {
    constructor(x = 0) { this.x = x; this.y = null }
    step(n) { this.x += n; if (n <= 0) return null; return this }
  }
  export const f = (n) => {
    const p = new Point(); let sum = 0
    for (let i = 0; i < n; i++) { const r = p.step(i); if (r !== null) sum += p.x }
    return sum + (p.y === null ? 1 : 0)
  }`
  agree(src)
  if (!belowOpt(1)) ok(!/\$__alloc/.test(funcWat(wat(src), 'f')), 'class slots and presence-only result need no allocation')
})

test('scalar record: an absent own slot retains its class method fallback', () => {
  agree(`class Point {
    constructor(x = 0) { this._x = x; this.n = 0 }
    set x(v) { this._x = v; this._cb() }
    get x() { return this._x }
    on(cb) { this._cb = cb; return this }
    _cb() { this.n++ }
  }
  export const f = (n) => {
    const p = new Point(n); p.x = n + 1; p.x = n + 2
    return p.x + p.n
  }`)
})
