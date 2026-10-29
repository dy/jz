// A field read twice with no store of that field and no writing call between
// is read once (compile/cse-load.js fieldOf): `e.type` tested against four
// names is one load and four compares. A store through a receiver that may
// alias, a computed-key store into that object, a call that may write, an
// accessor of the name on one of the receiver's layouts, and a reassignment of
// the receiver each end the first read's reach.
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat, funcWat } from './util.js'

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
  // A tag only ever a literal is the layout's answer (test/tag-literals.js), so
  // the shapes take their tags from their callers here: their tests read the field.
  // The schema dispatch's own read memo reaches the same reads, so it is off
  // on both sides: the difference is the source cache's.
  const open = guards.replace('const mk = (k) =>', 'const mk = (k, s, l, c) =>')
    .replace("type: 'setValue'", 'type: s').replace("type: 'linearRampToValue'", 'type: l').replace("type: 'cancelAndHold' }", 'type: c }')
    .replace('list.push(mk(i + n))', "list.push(mk(i + n, n > 99 ? 'x' : 'setValue', n > 99 ? 'y' : 'linearRampToValue', n > 99 ? 'z' : 'cancelAndHold'))")
  ok(!/type: '/.test(open) && open.includes("'z'"), 'every tag is a value')
  agrees(open, [[0], [1], [2]], 'open tag')
  const count = (text) => (text.match(/\$__dyn_get/g) || []).length
  const on = wat(open, { optimize: { level: 2, devirtSchemaReads: false } })
  const off = wat(open, { optimize: { level: 2, loadCSE: false, devirtSchemaReads: false } })
  ok(count(on) < count(off), `fewer reads with the cache (${count(on)} against ${count(off)})`)
})

test('field cse: branch traversal preserves typed-array reductions', () => {
  for (const [cmp, op] of [['>', 'pmax'], ['<', 'pmin']]) {
    const src = `let a = new Float64Array(17)
export const put = (i, x) => { a[i] = x }
export const peak = n => {
  let m = 1, i = 0
  while (i < n) { if (a[i] ${cmp} m) m = a[i]; i++ }
  return m * 1
}`
    const host = oracle(src), mod = jz(src, { optimize: 'speed' }).exports
    const values = [NaN, -0, 0, 4, -7, 3, NaN, 2, 8, -9, 5, 1, 6, -2, 7, Infinity, -Infinity]
    values.forEach((x, i) => { host.put(i, x); mod.put(i, x) })
    for (const n of [-1, 0, 1, 2, 15, 16, 17, 19])
      ok(Object.is(mod.peak(n), host.peak(n)), `${op}: empty, odd, NaN and missing elements, n=${n}`)
    ok(wat(src, { optimize: 'speed' }).includes(`f64x2.${op}`), `${op}: the conditional reduction still vectorizes`)
  }
})

const distinct = `let left, right
export const f = (n) => {
  const a = { x: n }, b = { x: n + 1 }
  left = a; right = b
  const before = a.x
  b.x = before + 2
  const after = a.x
  return before + after + right.x
}`

test('field cse: stores to distinct objects with the same layout keep cached reads', () => {
  agrees(distinct, [[0], [1], [7]], 'distinct')
  if (belowOpt(2)) return
  const loads = o => (funcWat(wat(distinct, { optimize: o }), 'f').match(/f64\.load\b/g) || []).length
  const on = loads(2), off = loads({ level: 2, loadCSE: false })
  ok(on < off, `fewer loads across the unrelated store (${on} against ${off})`)
})

test('field cse: joined aliases, computed stores and rebound receivers', () => {
  agrees(`let keep
export const alias = (n) => {
  const a = { x: n }, b = n > 1 ? a : { x: 5 }; keep = a
  const before = a.x; b.x = 20; const after = a.x
  return before * 100 + after
}
export const key = (n) => {
  const a = { x: n, y: 1 }, b = n > 1 ? a : { x: 5, y: 6 }; keep = a
  const before = a.x; b[n % 2 ? 'x' : 'y'] = 20; const after = a.x
  return before * 100 + after
}
export const rebind = (n) => {
  let a = { x: n }; const b = { x: 8 }; keep = a
  const before = a.x; a = b; b.x++; const after = a.x
  return before * 100 + after
}
export const branches = (n) => {
  const a = { x: n }, b = n > 1 ? a : { x: 5 }; keep = a
  let result = 0
  if (a.x > 0) {
    b.x += 10
    if (a.x > 10) result = a.x
  } else { b.x = 2; result = a.x }
  const after = a.x
  return result * 100 + after
}
export const firstInArm = (n) => {
  const a = { x: n }, b = { x: n + 1 }; keep = a
  let result = 0
  if (n > 1) { const before = a.x; b.x++; result = before + a.x }
  else { a.x = 30; result = a.x }
  const after = a.x
  return result * 100 + after
}`, [[0], [1], [2], [7]], 'aliasing')
})

test('field cse: conditional reads preserve skipped and throwing null receivers', () => {
  agrees(`let keep
export const f = n => {
  const a = n > 0 ? { x: 3 } : null, b = { x: 1 }; keep = b
  let step = 0, sum = 0
  try {
    if (n > 0) { const first = a.x; step = 1; b.x = 8; sum = first + a.x }
    else if (n === 0) { const first = a.x; step = 2; b.x = 9; sum = first + a.x }
    return sum * 100 + b.x * 10 + step
  } catch (e) { return (e instanceof TypeError ? 900 : 0) + b.x * 10 + step }
}`, [[-1], [0], [1], [7]], 'skip, throw before store, or reuse after disjoint store')
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

// A receiver bound to a local, not a parameter, and read past the source's
// reach (a guard's test of `type` against two names, `next === undefined ||`
// before it): the schema dispatch's memo follows the local to its next write
// (optimize/devirt.js), a string comparison between the reads writing nothing.
const shapes4 = `const mk = (k) => k % 4 === 0 ? { startTime: k, type: 'setValue', value: k * 2 }
  : k % 4 === 1 ? { endTime: k + 1, insertTime: k, type: 'linearRampToValue', value: k * 3 }
  : k % 4 === 2 ? { duration: 2, startTime: k, type: 'setValueCurve', values: [k, k + 1] }
  : { startTime: k, target: 1, timeConstant: 2, type: 'setTarget' }
const list = []
for (let i = 0; i < 12; i++) list.push(mk(i))
const isSet = (e) => e.type === 'setValue'
const isLin = (e) => e.type === 'linearRampToValue'
const isExp = (e) => e.type === 'exponentialRampToValue'
const isRamp = (e) => isExp(e) || isLin(e)
const isCurve = (e) => e.type === 'setValueCurve'
const isTarget = (e) => e.type === 'setTarget'
`
const valueAt = `${shapes4}
export let f = (i, time) => {
  const next = list[i % 12]
  const cur = list[(i + 11) % 12]
  if (cur !== undefined && isTarget(cur) && (next === undefined || !isRamp(next) || next.insertTime > time)) return 1
  if (cur !== undefined && isSet(cur) && (next === undefined || !isRamp(next))) return 2
  if (cur !== undefined && isCurve(cur) && (next === undefined || !isRamp(next) || cur.startTime + cur.duration > time)) return 3
  if (cur !== undefined && isRamp(cur) && (next === undefined || !isRamp(next))) return 4
  if (next !== undefined && isExp(next)) return 5
  if (next !== undefined && isLin(next)) return 6
  return 0
}
export let rebind = (i) => {
  let e = list[i % 12], s = isSet(e) ? 1 : 0
  e = list[(i + 1) % 12]
  if (isSet(e)) s += 2
  if (i > 2) e = list[(i + 2) % 12]
  if (isRamp(e)) s += 4
  return s
}
export let loop = (i) => {
  let e = list[i % 12], s = 0
  const first = isSet(e)
  for (let k = 0; k < 3; k++) {
    if (isRamp(e)) s += 1 << k
    e = list[(i + k + 1) % 12]
  }
  return s * 10 + (first ? 1 : 0)
}`

test('field cse: a bound event read by the guards of a lookup, and rebound', () => {
  agrees(valueAt, [0, 1, 2, 3, 4, 5, 6, 7, 11].map(i => [i, 1.5]), 'bound')
  if (belowOpt(2)) return
  // 18 dispatches where the memo followed parameters alone
  const reads = (funcWat(wat(valueAt, { optimize: 2 }), 'f').match(/\$__dyn_get/g) || []).length
  ok(reads <= 13, `${reads} reads of the two events' fields`)
})

// A channel a method returns (an array of typed views, an AudioBuffer's
// getChannelData) has no val type at the store, but the summary names only
// typed arrays: an element store into it writes no field, so the offset field
// read in the copy loop moves before the loop.
const views = `class Buffer {
  #n
  #data
  #channels
  constructor(nch, len) {
    this.#n = nch
    this.#data = new Float32Array(len * nch)
    const channels = this.#channels = new Array(nch)
    for (let c = 0; c < nch; c++) channels[c] = this.#data.subarray(c * len, (c + 1) * len)
  }
  getChannelData(ch) {
    if (ch < 0 || ch >= this.#n) throw new Error('channel')
    return this.#channels[ch]
  }
}
const st = { w: 0 }
const buf = new Buffer(2, 4096)
const put = (count) => {
  for (let c = 0; c < 2; c++) {
    const dst = buf.getChannelData(c)
    for (let i = 0; i < count; i++) dst[st.w + i] = i * 0.25 + c
  }
  st.w += count
}
export let f = (n) => { st.w = 0; for (let k = 0; k < 9; k++) put(100 + (n & 7)); return st.w }
export let at = (c, i) => buf.getChannelData(c & 1)[i | 0]`

test('field cse: an element store into a method\'s typed array keeps the field read out of the loop', () => {
  const host = oracle(views)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const mod = jz(views, { optimize }).exports
    for (const n of [0, 3]) {
      ok(mod.f(n) === host.f(n), `f(${n}) at ${optimize}`)
      for (const [c, i] of [[0, 5], [1, 99], [0, 400], [1, 811]]) ok(mod.at(c, i) === host.at(c, i), `at(${c}, ${i}) at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  for (const optimize of levels(2, 3)) {
    const text = wat(views, { optimize })
    const inner = []
    for (let at = text.indexOf('(loop'); at >= 0; at = text.indexOf('(loop', at + 1)) {
      let depth = 0, end = at
      do { const c = text[end++]; if (c === '(') depth++; else if (c === ')') depth-- } while (depth && end < text.length)
      const l = text.slice(at, end)
      if (!/\(loop/.test(l.slice(5)) && /f32\.store/.test(l)) inner.push(l)
    }
    ok(inner.length > 0, `found the copy loops at ${optimize}`)
    for (const l of inner) ok(!/f64\.load/.test(l), `the offset is read before the copy loop at ${optimize}`)
  }
})
