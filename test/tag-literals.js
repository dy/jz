// A tag test of a discriminated union (`e.type === 'setValue'`) is answered by
// the receiver's layout where the summary lists every construction site the
// receiver's objects come from and each site's slot only ever took string
// literals (summary slotLiteralsOfExpr, emit/comparisons.js emitSlotLiteralEq):
// a layout that stored only the literal is true, one that never stored it is
// false, and a layout that stored it beside other strings keeps the compare.
// A store of any other value, a computed-key store, a copy into the object, a
// getter of the name and a host that sees the objects each keep the compare.
import test from 'tst'
import { ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
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

// Four tags over three layouts: the two ramps share one.
const events = `const setValue = (v, t) => ({ startTime: t, type: 'setValue', value: v })
const expRamp = (v, t, i) => ({ endTime: t, insertTime: i, type: 'exponentialRampToValue', value: v })
const linRamp = (v, t, i) => ({ endTime: t, insertTime: i, type: 'linearRampToValue', value: v })
const target = (v, t, c) => ({ startTime: t, target: v, timeConstant: c, type: 'setTarget' })
const mk = (k) => k % 4 === 0 ? setValue(k, k) : k % 4 === 1 ? expRamp(k, k + 1, k) : k % 4 === 2 ? linRamp(k, k + 2, k) : target(k, k + 3, 0.5)
`

const guards = `${events}
const isCancel = (e) => e.type === 'cancelAndHold'
const isExp = (e) => e.type === 'exponentialRampToValue'
const isLin = (e) => e.type === 'linearRampToValue'
const isSet = (e) => e.type === 'setValue'
const timeOf = (e) => {
  if (isCancel(e)) return -1
  if (isExp(e) || isLin(e)) return e.endTime
  return e.startTime
}
const code = (e) => (isSet(e) ? 1 : 0) + (e.type !== 'setTarget' ? 10 : 0) + ('linearRampToValue' == e.type ? 100 : 0) + (e.type != 'nothing' ? 1000 : 0)
export let times = (n) => { const list = []; for (let i = 0; i < 8; i++) list.push(mk(i + n)); let h = 0; for (let i = 0; i < list.length; i++) h = h * 7 + timeOf(list[i]); return h }
export let codes = (n) => { let h = 0; for (let i = 0; i < 8; i++) h = h * 3 + code(mk(i + n)); return h }`

test('tag literals: guards over a closed union of literal shapes', () => agrees(guards, [[0], [1], [2], [3]], 'guards'))

test('tag literals: what keeps the compare', () => {
  agrees(`${events}
export let relabel = (n) => { const e = mk(n); if (n > 1) e.type = 'setValue'; return (e.type === 'setValue' ? 1 : 0) + (e.type === 'setTarget' ? 10 : 0) }
export let computed = (n) => { const e = mk(n), names = ['setValue', 'other']; e.type = names[n & 1]; return e.type === 'setValue' ? 1 : 0 }
export let keyed = (n) => { const e = mk(n), key = n > 1 ? 'type' : 'value'; e[key] = 'setValue'; return e.type === 'setValue' ? 1 : 0 }
export let assigned = (n) => { const e = mk(n); Object.assign(e, { type: 'setValue' }); return e.type === 'setValue' ? 1 : 0 }
export let copied = (n) => { const e = { ...mk(n) }; return e.type === 'linearRampToValue' ? 1 : 0 }`, [[0], [1], [2], [3]], 'keeps')
})

test('tag literals: a nullish receiver still throws', () => {
  const src = `${events}
const isSet = (e) => e.type === 'setValue'
export let probe = (n) => { const list = [mk(0), mk(1)]; try { return isSet(list[n]) ? 1 : 0 } catch { return -1 } }`
  agrees(src, [[0], [1], [2], [5]], 'nullish')
})

test('tag literals: class instances and getters', () => {
  agrees(`class Circle { constructor(r) { this.kind = 'circle'; this.r = r } }
class Square { constructor(s) { this.kind = 'square'; this.s = s } }
class Named { constructor(k) { this.kind = k } }
let reads = 0
class Lazy { get kind() { reads++; return 'circle' } }
const shapes = (n) => [new Circle(n), new Square(n + 1), { kind: 'circle', r: 2 }]
export let classes = (n) => { let h = 0; for (const s of shapes(n)) h = h * 2 + (s.kind === 'circle' ? 1 : 0); return h }
export let named = (n) => { const s = n > 1 ? new Named('circle') : new Circle(n); return s.kind === 'circle' ? 1 : 0 }
export let getter = (n) => { reads = 0; const s = n > 1 ? new Lazy() : new Square(n); const a = s.kind === 'circle'; return reads * 10 + (a ? 1 : 0) }`, [[0], [1], [2], [3]], 'classes')
})

test('tag literals: a tag no layout holds is no compare at all', () => {
  if (belowOpt(2)) return
  // A static string lies in the data as UTF-16, and stays only while a compare reads it.
  const src = `${events}
const list = []
export let add = (n) => { list.push(mk(n)); return list.length }
export let f = () => { let h = 0; for (let i = 0; i < list.length; i++) { const e = list[i]; h = h * 4 + (e.type === 'nothing-of-the-kind' ? 1 : e.type === 'setValue' ? 2 : 3) } return h }`
  for (const optimize of levels(2, 3)) {
    const bytes = Buffer.from(compile(src, { optimize }))
    ok(!bytes.includes(Buffer.from('nothing-of-the-kind', 'utf16le')), `the literal is gone at ${optimize}`)
    const host = oracle(src), mod = jz(src, { optimize }).exports
    for (let n = 0; n < 6; n++) { host.add(n); mod.add(n) }
    ok(mod.f() === host.f(), `f() at ${optimize}: ${mod.f()} for ${host.f()}`)
  }
})

test('tag literals: a host that sees the objects keeps the compare', () => {
  // The objects reach the host: their fields may change there.
  const src = `${events}
export let make = (n) => mk(n)
export let isSet = (e) => e.type === 'setValue' ? 1 : 0`
  for (const optimize of levels(0, 2, 3)) {
    const { make, isSet } = jz(src, { optimize }).exports
    const e = make(0)
    ok(isSet(e) === 1, `a made setValue reads true at ${optimize}`)
    ok(isSet({ startTime: 0, type: 'other', value: 1 }) === 0, `a host object of its layout reads its own tag at ${optimize}`)
    throws(() => isSet(undefined), /undefined/, `a missing event throws at ${optimize}`)
  }
})

test('tag literals: an || of tag tests of one read is one test of the set', () => {
  // The two ramps share a layout, which stored both literals: neither compare
  // alone is its answer, their `||` is (emitTagSet), and so is the `&&` of the
  // negations; a nullish event still throws at the first read.
  const guards = `${events}
const isExp = (e) => e.type === 'exponentialRampToValue'
const isLin = (e) => e.type === 'linearRampToValue'
const isRamp = (e) => isExp(e) || isLin(e)
`
  const src = `${guards}
const list = []
export let add = (n) => { list.push(mk(n)); return list.length }
export let ramps = () => { let h = 0; for (const e of list) h = h * 3 + (isRamp(e) ? 1 : 2); return h }
export let flat = () => { let h = 0; for (const e of list) h = h * 3 + (e.type !== 'linearRampToValue' && e.type !== 'exponentialRampToValue' ? 1 : 2); return h }`
  for (const optimize of levels(0, 2, 3, 'size')) {
    const host = oracle(src), mod = jz(src, { optimize }).exports
    for (let n = 0; n < 9; n++) { host.add(n); mod.add(n) }
    ok(mod.ramps() === host.ramps() && mod.flat() === host.flat(), `the set tests at ${optimize}: ${mod.ramps()}, ${mod.flat()} for ${host.ramps()}, ${host.flat()}`)
  }
  agrees(`${guards}
export let probe = (n) => { const l = [mk(1), mk(2), mk(4)]; try { return isRamp(l[n]) ? 1 : 0 } catch { return -1 } }`, [[0], [1], [2], [3]], 'nullish set')
  if (belowOpt(2)) return
  for (const optimize of levels(2, 3)) {
    const text = wat(src, { optimize })
    for (const name of ['ramps', 'flat']) {
      const body = funcWat(text, name)
      ok(body && !/\$__str_eq/.test(body), `${name} compares no string at ${optimize}`)
    }
  }
})
