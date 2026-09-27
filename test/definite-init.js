// A field's declared `undefined` is a value its slot never holds when the
// constructor assigns the field before anything can read the instance
// (summary definiteStores). The proof ends where the instance is read: a
// method the constructor calls sees the fields after it still undefined, its
// own and a derived class's. Statements that do not name the instance (the
// values a constructor computes first) run between the stores.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

const agrees = (src, args, label) => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const mod = jz(src, { optimize }).exports
    for (const name of Object.keys(host)) for (const a of args) {
      const want = host[name](...a), got = mod[name](...a)
      ok(Object.is(want, got), `${label}: ${name}(${a}) at ${optimize}: ${String(got)} for ${String(want)}`)
    }
  }
}

test('definite init: a method the constructor calls reads a later field as undefined', () => {
  agrees(`class P { constructor() { this.a = 1; this.note(); this.b = 2 } note() { this.was = this.b * 2; this.kind = typeof this.b } }
export let product = (n) => { const o = new P(); return o.was }
export let kind = (n) => { const o = new P(); return o.kind }
export let later = (n) => { const o = new P(); return o.b * n }`, [[5]], 'own field')
})

test('definite init: a base constructor reads a derived field before its initializer', () => {
  agrees(`class A { constructor() { this.a = 1; this.peek() } peek() { this.total = this.y + 1; this.seen = this.y } }
class B extends A { y = 5; constructor() { super() } }
export let total = (n) => { const b = new B(); return b.total }
export let seen = (n) => { const b = new B(); return b.seen === undefined ? 100 + n : b.seen + n }
export let own = (n) => { const b = new B(); return b.y + n }`, [[5]], 'derived field')
})

test('definite init: a return before the stores leaves the fields undefined', () => {
  agrees(`class Q { constructor(x) { this.a = 1; if (x < 0) return; this.b = x * 2 } }
export let f = (n) => { const o = new Q(n); return o.b === undefined ? -1 : o.b + o.a }`, [[5], [-5]], 'early return')
})

const counter = `class Acc {
  #n = 0
  #len
  #tag
  constructor(len, tag) { const limit = len * 2; let t = tag; if (typeof t === 'number') t = 'n' + t; this.#len = limit; this.#tag = t }
  step(c) { this.#n += c; return this.#n }
  span() { return this.#len + this.#n }
  left() { return this.#len - this.#n }
  label() { return this.#tag + this.#n }
}
export let f = (n) => { const a = new Acc(n * 1, 'x'); let h = 0; for (let i = 0; i < n; i++) { a.step(i & 3); h += a.span() * 2 + a.left() } return h }
export let g = (n) => { const a = new Acc(n * 1, 7); a.step(n * 1); return a.label() }`

test('definite init: statements that compute values run between the stores', () => {
  agrees(counter, [[5], [12]], 'counter')
})

test('definite init: a field stored after such statements keeps its kind', () => {
  if (belowOpt(2)) return
  // `#len` is stored a number after the constructor computed it: a number
  // where `span` adds to it, in its own function or inlined into the loop of `f`.
  const text = wat(counter, { optimize: 2 })
  const starts = [...text.matchAll(/\(func\s+(\$[^\s)]+)/g)]
  let seen = 0
  for (let i = 0; i < starts.length; i++) {
    const name = starts[i][1]
    if (!/span$|^\$f(\$exp)?$/.test(name)) continue
    seen++
    const body = text.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : text.length)
    ok(!/call \$__is_str_key/.test(body), `no string test in ${name}`)
    ok(!/call \$__add_slow/.test(body), `no generic sum in ${name}`)
  }
  ok(seen > 0, 'the functions are there')
})
