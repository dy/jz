// Resizable ArrayBuffer (ECMA-262 25.1: `new ArrayBuffer(n, { maxByteLength })`,
// ArrayBuffer.prototype.resize) and the views that track it: each program runs
// under jz and as plain JS, and the two must agree.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

const tryIt = `const tryIt = (f) => { try { return f() } catch (e) { return e.name } }\n`
const agree = (src, calls) => {
  const want = oracle(tryIt + src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const got = jz(tryIt + src, { optimize }).exports
    for (const [name, ...args] of calls) is(got[name](...args), want[name](...args), `O${optimize} ${name}(${args.join(', ')})`)
  }
}

test('a resizable buffer reserves its maximum, resizes within it and zeroes what growth reveals', () => {
  agree(`
    export const make = (n, max) => tryIt(() => { const b = new ArrayBuffer(n, { maxByteLength: max }); return [b.byteLength, b.maxByteLength, b.resizable] })
    export const grow = () => { const b = new ArrayBuffer(4, { maxByteLength: 16 }), u = new Uint8Array(b)
      u.fill(7); b.resize(2); b.resize(6); const r = [...u]; b.resize(16); return [r, u.length, u[15], b.byteLength] }
    export const resize = (n) => tryIt(() => { const b = new ArrayBuffer(4, { maxByteLength: 8 }); const r = b.resize(n); return [r, b.byteLength] })
    export const fixed = () => tryIt(() => new ArrayBuffer(4).resize(2))
    export const options = () => [new ArrayBuffer(3).resizable, new ArrayBuffer(3).maxByteLength, new ArrayBuffer(3, {}).resizable,
      new ArrayBuffer(3, { maxByteLength: undefined }).resizable, new ArrayBuffer(3, { other: 1 }).maxByteLength]
    export const order = () => { const log = []
      const b = new ArrayBuffer({ valueOf() { log.push('length'); return 2 } }, { get maxByteLength() { log.push('get'); return { valueOf() { log.push('max'); return 8 } } } })
      return [log.join(), b.byteLength, b.maxByteLength] }
    export const slice = () => { const b = new ArrayBuffer(4, { maxByteLength: 8 }); new Uint8Array(b).set([1, 2, 3, 4]); const s = b.slice(1); return [s.byteLength, s.resizable, [...new Uint8Array(s)]] }
  `, [['make', 4, 8], ['make', 0, 0], ['make', 9, 8], ['make', 4, -1], ['make', 4, 2 ** 53], ['grow'],
    ['resize', 8], ['resize', 0], ['resize', 9], ['resize', -1], ['resize', 2.5], ['resize', NaN], ['fixed'], ['options'], ['order'], ['slice']])
})

test('a view made without a length tracks its buffer; one with a length goes out of bounds below it', () => {
  agree(`
    const b = new ArrayBuffer(8, { maxByteLength: 32 })
    const all = new Uint8Array(b), words = new Uint16Array(b), tail = new Uint8Array(b, 4), part = new Uint8Array(b, 2, 4)
    const dv = new DataView(b), dvTail = new DataView(b, 6), dvPart = new DataView(b, 2, 4)
    export const at = (n) => { b.resize(n); all.fill(0); for (let i = 0; i < all.length; i++) all[i] = i + 1
      return [all.length, words.length, tail.length, tail.byteOffset, part.length, part.byteOffset, part.byteLength, part[0], tail[0], words[1],
        tryIt(() => dv.byteLength), tryIt(() => dvTail.byteLength), tryIt(() => dvPart.byteLength), tryIt(() => dvPart.byteOffset),
        tryIt(() => dvTail.getUint8(0)), tryIt(() => dvPart.getUint16(2)), tryIt(() => dv.getUint8(n))] }
    export const store = (n) => { b.resize(8); all.fill(0); b.resize(n); part[0] = 9; tail[1] = 8; b.resize(8); return [...all] }
    export const same = () => [all.buffer === b, part.buffer === b, dv.buffer === b, all.buffer.resizable, tail.buffer.maxByteLength]
    export const named = () => { const r = new ArrayBuffer(2, { maxByteLength: 4 }), v = new Uint8Array(r); v.tag = 'x'; r.resize(4); return [v.tag, v.length, r.resizable] }
  `, [['at', 8], ['at', 32], ['at', 7], ['at', 6], ['at', 5], ['at', 4], ['at', 3], ['at', 0], ['at', 13], ['store', 3], ['store', 6], ['same'], ['named']])
})

test('subarray of a tracking view tracks without an end; views pass through calls and fields', () => {
  agree(`
    const b = new ArrayBuffer(8, { maxByteLength: 16 })
    const u = new Uint8Array(b), tracked = u.subarray(2), held = u.subarray(2, 6)
    const len = (a) => a.length, box = { v: null }
    export const f = (n) => tryIt(() => { b.resize(n); box.v = new Uint8Array(b, 1); const w = new Uint16Array(b)
      return [tracked.length, held.length, len(u), len(box.v), box.v.length, len(w), len(new Uint8Array(b))] })
  `, [['f', 8], ['f', 16], ['f', 5], ['f', 1], ['f', 0]])
})

test('a loop over a view sees a resize a call makes inside it', () => {
  agree(`
    const b = new ArrayBuffer(16, { maxByteLength: 16 }), u = new Uint8Array(b)
    const shrink = () => b.resize(4)
    export const f = () => { b.resize(16); u.fill(1); let s = 0, seen = 0
      for (let i = 0; i < 16; i++) { if (i === 2) shrink(); const v = u[i]; if (v !== undefined) s += v; else seen++ }
      return [s, seen, u.length] }
    export const g = () => { b.resize(16); u.fill(2); let s = 0; for (let i = 0; i < u.length; i++) { s += u[i]; if (i === 1) shrink() } return s }
    export const h = () => { b.resize(16); const v = new Uint8Array(b); v.fill(3); let s = 0
      for (let i = 0; i < 16; i++) { if (i === 2) shrink(); s += v[i] ?? 100 } return s }
    export const k = (n) => { b.resize(16); const v = new Float64Array(b, 0, 2); v[0] = 1.5; v[1] = 2.5; let s = 0
      for (let i = 0; i < 2; i++) { s += v[i] ?? 10; b.resize(n) } return s }
  `, [['f'], ['g'], ['h'], ['k', 8], ['k', 16]])
})

test('a program that resizes buffers still copies, sizes and views as before', () => {
  agree(`
    const r = new ArrayBuffer(2, { maxByteLength: 4 })
    export const f = (src) => { const a = new Float64Array(src), n = new Uint8Array(3), c = new Int16Array([1, 2, 3])
      const v = new Uint8Array(new ArrayBuffer(6)), t = new Int32Array(new Int32Array([5, 6]))
      return [a.length, a[0], n.length, c[2], v.length, t[1], r.byteLength, new Uint8Array(r).length] }
  `, [['f', [1.5, 2]], ['f', 2]])
})

test('a program that makes no resizable buffer compiles as it did', () => {
  const src = `export const f = (n) => { const b = new ArrayBuffer(n), u = new Uint8Array(b), d = new DataView(b)
    u[0] = 1; return u.length + d.byteLength + d.getUint8(0) + u.subarray(1).length }`
  ok(!/__view_bytes|__ab_new/.test(compile(src, { wat: true })), 'no resizable machinery is linked')
  ok(!/__view_bytes|__ab_new/.test(compile(src.replace('new ArrayBuffer(n)', 'new ArrayBuffer(n, {})'), { wat: true })), 'options naming no maximum make a fixed buffer')
  ok(/__view_bytes/.test(compile(src.replace('new ArrayBuffer(n)', 'new ArrayBuffer(n, { maxByteLength: 64 })'), { wat: true })), 'a maximum links the view bound')
})

// ValidateAtomicAccess (ECMA-262 25.4.3.x) reads the length before ToIndex runs
// the index's valueOf, and Atomics.notify checks it no more, so a valueOf that
// shrinks a non-shared buffer to nothing still notifies index 0 and answers 0
// (test262 built-ins/Atomics/notify/retrieve-length-before-index-coercion-non-
// shared-resize-to-zero.js). V8 rereads the length and throws a RangeError, so
// that case pins the spec's value; the rest agree with plain JS.
test('Atomics.notify checks its index against the length before the index converts', () => {
  const src = `export const shrink = () => {
      const rab = new ArrayBuffer(4, { maxByteLength: 4 }), ta = new Int32Array(rab)
      return [Atomics.notify(ta, { valueOf() { rab.resize(0); return 0 } }), rab.byteLength] }
    const ta = new Int32Array(new ArrayBuffer(8, { maxByteLength: 16 }))
    export const past = () => tryIt(() => Atomics.notify(ta, 2))
    export const inside = () => Atomics.notify(ta, 1, 3)
    export const below = () => tryIt(() => Atomics.notify(ta, -1))`
  for (const optimize of levels(0, 2, 3, 'size')) is(jz(tryIt + src, { optimize }).exports.shrink(), [0, 0], `O${optimize} the shrunk buffer notifies 0`)
  agree(src, [['past'], ['inside'], ['below']])
})

// ValidateTypedArray (ECMA-262 23.2.4.4): a typed array its resizable buffer
// ends before is a TypeError for %TypedArray%.prototype's methods and its
// iteration, after the receiver and arguments evaluate; its length, byteLength
// and byteOffset read 0, an element read undefined, subarray empty.
test('a typed array its buffer shrank below throws for its methods and iteration, and reads empty', () => {
  agree(`
    const b = new ArrayBuffer(8, { maxByteLength: 16 })
    const fixed = new Uint8Array(b, 0, 8), track = new Uint8Array(b, 4), whole = new Uint8Array(b)
    export const shrink = (n) => { b.resize(n); return [fixed.length, fixed.byteLength, fixed.byteOffset, track.length, track.byteOffset, whole.length, fixed[0], fixed.subarray(0).length] }
    export const methods = () => [tryIt(() => fixed.fill(1)), tryIt(() => fixed.indexOf(0)), tryIt(() => fixed.at(0)), tryIt(() => fixed.join()),
      tryIt(() => fixed.slice().length), tryIt(() => fixed.includes(0)), tryIt(() => fixed.map(x => x).length),
      tryIt(() => { let n = 0; fixed.forEach(() => n++); return n }), tryIt(() => fixed.set([1])), tryIt(() => fixed.reverse().length),
      tryIt(() => fixed.sort().length), tryIt(() => fixed.every(x => x)), tryIt(() => [...fixed].length), tryIt(() => { let n = 0; for (const x of fixed) n++; return n }),
      tryIt(() => whole.fill(2).length)]
    export const others = () => [tryIt(() => [...fixed.keys()].length), tryIt(() => [...fixed.values()].length), tryIt(() => [...fixed.entries()].length),
      tryIt(() => fixed.lastIndexOf(0)), tryIt(() => fixed.findLast(x => x)),
      tryIt(() => fixed.copyWithin(0, 1).length), tryIt(() => fixed.reduce((a, x) => a + x, 0)), tryIt(() => fixed.filter(x => x).length),
      tryIt(() => fixed.toReversed().length), tryIt(() => fixed.with(0, 1).length)]
    export const order = () => { const log = []; const r = tryIt(() => fixed.fill((log.push('arg'), 1))); return [r, log.join()] }
  `, [['shrink', 3], ['methods'], ['others'], ['order'], ['shrink', 10], ['methods'], ['others']])
})

test('a resizable buffer reaches the host resizable to its maximum, and memory.reset restores its length', () => {
  const src = `let g = new ArrayBuffer(4, { maxByteLength: 16 })
    const v = new Uint8Array(g)
    export const grow = () => { g.resize(12); v[10] = 7; return [g.byteLength, v.length] }
    export const state = () => [g.byteLength, v.length, v[10]]
    export const buf = () => g`
  for (const optimize of levels(0, 2, 'size')) {
    const { exports, memory } = jz(src, { optimize })
    is(exports.grow(), [12, 12], `O${optimize} grown`)
    const host = exports.buf()
    is([host.byteLength, host.resizable, host.maxByteLength, new Uint8Array(host)[10]], [12, true, 16, 7], `O${optimize} the host's copy is resizable`)
    host.resize(16)
    is(exports.state(), [12, 12, 7], `O${optimize} the host resizes its copy`)
    memory.reset()
    is(exports.state(), [4, 4, undefined], `O${optimize} reset takes back the length`)
    is(exports.grow(), [12, 12], `O${optimize} grows again`)
  }
})
