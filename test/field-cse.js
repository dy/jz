// A field read twice with no store of that field and no writing call between
// is read once (compile/cse-load.js fieldOf): `e.type` tested against four
// names is one load and four compares. A store of the field through any
// receiver, a computed-key store into an object, a call that may write, an
// accessor of the name on one of the receiver's layouts, and a reassignment of
// the receiver each end the first read's reach.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'

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

const events = `const mk = (k) => k % 3 === 0 ? { startTime: k, type: 'setValue', value: k * 2 }
  : k % 3 === 1 ? { endTime: k + 1, insertTime: k, type: 'linearRampToValue', value: k * 3 }
  : { cancelTime: k + 2, type: 'cancelAndHold' }
`

const guards = `${events}
const isA = (e) => { return e.type === 'cancelAndHold' }
const isB = (e) => { return e.type === 'cancelScheduledValues' }
const isC = (e) => { return e.type === 'exponentialRampToValue' }
const isD = (e) => { return e.type === 'linearRampToValue' }
const timeOf = (e) => {
  if (isA(e) || isB(e)) return e.cancelTime
  if (isC(e) || isD(e)) return e.endTime
  return e.startTime
}
export let f = (n) => { const list = []; for (let i = 0; i < 9; i++) list.push(mk(i + n)); let h = 0; for (let r = 0; r < 5; r++) for (let i = 0; i < list.length; i++) h = h * 1.0001 + timeOf(list[i]); return h }`

test('field cse: a field tested by several guards', () => agrees(guards, [[0], [1], [2]], 'guards'))

test('field cse: what ends a read', () => {
  agrees(`${events}
const bump = (o) => { o.value += 7 }
const peek = (o) => o.value * 2
export let store = (n) => { const e = mk(n * 3); const a = e.value; e.value = a + 1; return a * 100 + e.value }
export let alias = (n) => { const e = mk(n * 3), g = e; const a = e.value; g.value = 50; return a + e.value }
export let call = (n) => { const e = mk(n * 3); const a = e.value; bump(e); return a * 1000 + e.value }
export let reader = (n) => { const e = mk(n * 3); const a = e.value; const b = peek(e); return a * 1000 + b + e.value }
export let keyed = (n) => { const e = mk(n * 3), key = n > 1 ? 'value' : 'startTime'; const a = e.value; e[key] = 9; return a * 10 + e.value }
export let step = (n) => { const e = mk(n * 3); const a = e.value; e.value++; ++e.value; return a * 100 + e.value }
export let compound = (n) => { const e = mk(n * 3); const a = e.value; e.value *= 3; return a * 100 + e.value }
export let rebind = (n) => { let e = mk(n * 3); const a = e.value; e = mk(n * 3 + 3); return a * 100 + e.value }
export let inArm = (n) => { const e = mk(n * 3); const a = e.value; if (n > 1) e.value = 1; return a * 100 + e.value }
export let inOperand = (n) => { const e = mk(n * 3); const a = e.value; const b = n > 1 && (e.value = 4) > 0; return a * 100 + e.value + (b ? 1000 : 0) }
export let firstInOperand = (n) => { const e = mk(n * 3), g = mk(n * 3 + 3); const c = n > 1 && g.value > 0; g.value = 77; return g.value + (c ? 1000 : 0) }
export let ternary = (n) => { const e = mk(n * 3); const v = e.value > 2 ? e.value * 2 : e.value - 1; e.value = 0; return v + e.value }`, [[0], [1], [2], [3]], 'ends')
})

test('field cse: an accessor of the name runs each time it is read', () => {
  agrees(`let reads = 0
class Osc { #t = 'sine'; get type() { reads++; return this.#t } set type(v) { this.#t = v } }
const plain = (k) => ({ type: 'plain' + k, value: k })
export let accessor = (n) => { reads = 0; const o = new Osc(); const a = o.type === 'x' || o.type === 'sine'; return reads * 10 + (a ? 1 : 0) }
export let field = (n) => { const o = plain(n); return (o.type === 'x' || o.type === 'plain' + n ? 1 : 0) + o.value }`, [[1], [4]], 'accessor')
})

test('field cse: the guards of one event read its type once', () => {
  if (belowOpt(2)) return
  // `timeOf` inlines its guards: four tests of `e.type`, one read of it.
  const count = (text) => (text.match(/\$__dyn_get/g) || []).length
  const on = wat(guards, { optimize: 2 }), off = wat(guards, { optimize: { level: 2, loadCSE: false } })
  ok(count(on) < count(off), `fewer reads with the cache (${count(on)} against ${count(off)})`)
})

// A ring buffer's cursor record: `c.b` and `c.p` are read by the declaration's
// element read and again by the element store and the cursor's own step, with
// only `c.f` stored between. Each field read the statement evaluates before any
// store, call or condition is one read; an element store through `c.b`, a
// typed array, writes no field.
const ring = `const mkBank = () => [7, 5].map(n => ({ b: new Float64Array(n), p: 0, f: 0.5 }))
const get = (c) => c.p
export let run = (n) => { const bank = mkBank(); let out = 0
  for (let i = 0; i < n; i++) for (let c of bank) {
    let y = c.b[c.p]
    c.f = y * 0.25 + c.f * 0.75
    c.b[c.p] = i * 0.5 + 0.8 * c.f
    c.p = (c.p + 1) % c.b.length
    out += y }
  return out }
export let ends = (n) => { const c = mkBank()[n & 1], d = { self: null, p: 3 }; d.self = d
  const a = get(c) + c.p, b = n > 1 && c.p > 0 ? c.p : -1
  c.b[c.p] = (c.p = 0) + c.p
  const e = d.p; d.self['p'] = 9
  return a * 1000 + b * 100 + c.p * 10 + e + d.p }`

test('field cse: a cursor record read by a statement before any change', () => agrees(ring, [[0], [3], [11]], 'ring'))

test('field cse: the cursor and the buffer are read once an iteration', () => {
  if (belowOpt(2)) return
  const text = wat(ring, { optimize: 2 })
  const loops = []
  for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
    let depth = 0, end = at
    do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
    loops.push(text.slice(at, end))
  }
  const inner = loops.filter(l => !/\(loop/.test(l.slice(5)) && /f64\.store offset=16/.test(l))
  ok(inner.length > 0, 'found the loop over the bank')
  for (const l of inner) ok((l.match(/f64\.load offset=8/g) || []).length === 1, `one read of the cursor, not ${(l.match(/f64\.load offset=8/g) || []).length}`)
})
