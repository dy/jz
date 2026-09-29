// A typed array a guard proves is read as that typed array
// (src/compile/plan/guard-views.js): past `if (!(a instanceof Float32Array))
// throw …` the statements read a Float32Array view of `a`, a declaration of
// known constructor, so element reads are loads of that width and the loop is
// typed as one over a local array. The guard runs as written: any other value
// still leaves through it. Values are differentials against the host running
// the same source; sums are integer so no lane order shows in them.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'
import { oracle, run, wat, funcWat as funcWatOf } from './util.js'
import { belowOpt } from './_matrix.js'

const funcWat = (text, name) => funcWatOf(text, name) || funcWatOf(text, `${name}$exp`)
/** Element reads and stores that decide the receiver's kind or the element's width at run time. */
const dispatches = (src, opts, name = 'f') => (funcWat(wat(src, opts), name).match(/call \$__(typed_idx|typed_get_idx|typed_set_idx|str_idx|dyn_get\w*|dyn_set)\b/g) || []).length
const OFF = { optimize: { level: 2, guardViews: false } }
const f32 = (n) => Float32Array.from({ length: n }, (_, i) => ((i * 7919) % 97 - 48) / 8)
const i32 = (n) => Int32Array.from({ length: n }, (_, i) => (i * 2654435761) | 0)
const same = (src, args, label) => is(run(src).f(...args()), oracle(src).f(...args()), label)

const SUM = `let s = 0; for (let i = 0; i < a.length; i++) s = (s + (a[i] * 8 | 0)) | 0; return s`

test('guard view: a parameter guarded by instanceof reads its elements by width', () => {
  const src = `export let f = (a) => { if (!(a instanceof Float32Array)) throw new TypeError('Float32Array expected'); ${SUM} }`
  if (!belowOpt(2)) is(dispatches(src), 0, 'no dispatch per element')
  ok(dispatches(src, OFF) > 0, 'without the pass each element dispatches')
  for (const n of [0, 1, 7, 1000]) {
    same(src, () => [f32(n)], `n=${n}`)
    is(run(src, OFF).f(f32(n)), run(src).f(f32(n)), `the pass changes no value, n=${n}`)
  }
})

test('guard view: the guard leaves as written for any other value', () => {
  const src = `export let f = (a) => { if (!(a instanceof Float32Array)) throw new TypeError('Float32Array expected'); ${SUM} }`
  const { f } = run(src)
  for (const v of [new Float64Array(4), new Int32Array(4), [1, 2, 3], 7, 'abc', null, undefined, {}])
    throws(() => f(v), /Float32Array expected/, `throws for ${Object.prototype.toString.call(v)}`)
  const ret = `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; ${SUM} }`
  for (const v of [new Float32Array(4), [1, 2], 3, undefined]) is(run(ret).f(v), -1)
  same(ret, () => [i32(50)])
})

test('guard view: one guard over several parameters', () => {
  // The form of three.js MikkTSpace generateTangents.
  const src = `export let f = (p, n, t) => {
    if (!(p instanceof Float32Array) || !(n instanceof Float32Array) || !(t instanceof Int32Array)) { throw new TypeError('typed inputs expected') }
    let s = 0
    for (let i = 0; i < p.length; i++) s = (s + (p[i] * 8 | 0) + (n[i] * 4 | 0) + t[i]) | 0
    return s }`
  if (!belowOpt(2)) is(dispatches(src), 0, 'no dispatch per element')
  same(src, () => [f32(64), f32(64), i32(64)])
  throws(() => run(src).f(f32(4), f32(4), f32(4)), /typed inputs expected/)
  throws(() => run(src).f(new Float64Array(4), f32(4), i32(4)), /typed inputs expected/)
})

test('guard view: && under a positive branch is no guard of the rest', () => {
  const src = `export let f = (a) => { if (a instanceof Float32Array && a.length > 2) return -1; let s = 0; for (let i = 0; i < a.length; i++) s = (s + (a[i] | 0)) | 0; return s }`
  same(src, () => [f32(2)])
  same(src, () => [i32(9)])
  same(src, () => [[1, 2, 3]])
})

test('guard view: the bits of the same storage', () => {
  const src = `export let f = (a) => {
    if (!(a instanceof Float32Array)) throw new TypeError('x')
    const bits = new Uint32Array(a.buffer, a.byteOffset, a.length)
    let h = 2166136261
    for (let i = 0; i < a.length; i++) h = Math.imul(h ^ (a[i] === 0 ? 0 : bits[i]), 16777619)
    return h >>> 0 }`
  if (!belowOpt(2)) is(dispatches(src), 0, 'no dispatch per element')
  for (const n of [0, 3, 200]) same(src, () => [f32(n)], `n=${n}`)
})

test('guard view: a write through the view is a write to the array', () => {
  const src = `const twice = (a) => { for (let i = 0; i < a.length; i++) a[i] = a[i] * 2 }
  export let f = (a) => {
    const n = a.length
    if (!(a instanceof Int32Array)) return -1
    for (let i = 0; i < a.length; i++) a[i] = (a[i] + i) | 0
    twice(a)
    a.fill(5, 0, 2)
    let s = n
    for (let i = 0; i < a.length; i++) s = (s + a[i]) | 0
    return s }`
  for (const n of [0, 1, 2, 40]) same(src, () => [i32(n)], `n=${n}`)
  // the host sees what it saw before the pass: the argument's own storage
  const { exports, memory } = jz(src)
  const p = memory.Int32Array(i32(8)), want = i32(8)
  oracle(src).f(want)
  exports.f(p)
  is([...memory.read(p)], [...want])
})

test('guard view: a use of the value itself keeps the binding', () => {
  const ident = `export let f = (a, b) => { if (!(a instanceof Float32Array)) return -1; return (a === b ? 100 : 0) + a.length }`
  const { exports, memory } = jz(ident)
  const p = memory.Float32Array(f32(6)), q = memory.Float32Array(f32(6))
  is(exports.f(p, p), 106, 'the array is itself')
  is(exports.f(p, q), 6, 'and no other')
  const ret = `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; a[0] = 9; return a }`
  is([...run(ret).f(i32(3))], [...oracle(ret).f(i32(3))])
  const copy = `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; const b = a; b[1] = 4; return a[1] + b.length }`
  same(copy, () => [i32(5)])
})

test('guard view: a reassigned binding and a guard in a loop keep the binding', () => {
  const re = `export let f = (a, n) => { if (!(a instanceof Int32Array)) return -1; if (n) a = new Int32Array(n); let s = a.length; for (let i = 0; i < a.length; i++) s = (s + a[i]) | 0; return s }`
  same(re, () => [i32(5), 0])
  same(re, () => [i32(5), 3])
  const loop = `export let f = (a, k) => { let s = 0; for (let r = 0; r < k; r++) { if (!(a instanceof Int32Array)) break; for (let i = 0; i < a.length; i++) s = (s + a[i]) | 0 } return s }`
  same(loop, () => [i32(9), 3])
  same(loop, () => [f32(9), 3])
})

test('guard view: a call through the view allocates nothing that stays', () => {
  const src = `export let f = (a) => { if (!(a instanceof Float32Array)) throw new TypeError('x'); ${SUM} }`
  const { exports, memory } = jz(src)
  const p = memory.Float32Array(f32(64))
  const want = oracle(src).f(f32(64))
  const cursor = () => exports._alloc(1)
  const before = cursor()
  for (let i = 0; i < 2000; i++) is(exports.f(p), want)
  ok(cursor() - before <= 16, 'the heap cursor stays where the probes left it')
})

// A guard can be the program's only mention of a typed array. The element
// helpers then linked their plain-array bodies, eight bytes per element: a
// read decoded two elements as one float, a store overwrote its neighbour and,
// at the end of the array, the bytes past it. These hold with the pass on or off.
test('guarded element: a guard alone names the typed array', () => {
  const rows = [
    ['early exit, constant index', `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; return a[0] * 1000000 + a[1] * 1000 + a[2] }`, () => new Int32Array([1, 2, 3])],
    ['positive branch', `export let f = (a) => { if (a instanceof Int32Array) { return a[0] * 1000000 + a[1] * 1000 + a[2] } return -1 }`, () => new Int32Array([1, 2, 3])],
    ['a store keeps its neighbour', `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; a[0] = 9; return a[0] * 1000000 + a[1] * 1000 + a[2] }`, () => new Int32Array([1, 2, 3])],
    ['a store in the positive branch', `export let f = (a) => { if (a instanceof Int32Array) { a[1] = 7; return a[0] * 1000000 + a[1] * 1000 + a[2] } return -1 }`, () => new Int32Array([1, 2, 3])],
    ['a store at the end stays inside', `export let f = (a) => { if (!(a instanceof Uint8Array)) return -1; a[a.length - 1] = 200; let s = 0; for (let i = 0; i < a.length; i++) s = s * 256 + a[i]; return s }`, () => new Uint8Array([1, 2, 3])],
    ['Float32Array', `export let f = (a) => { if (!(a instanceof Float32Array)) return -1; a[0] = 1.5; return a[0] * 1000 + a[1] }`, () => new Float32Array([1, 2, 3])],
    ['Int16Array', `export let f = (a) => { if (!(a instanceof Int16Array)) return -1; a[1] = -2; return a[0] * 1000 + a[1] * 10 + a[2] }`, () => new Int16Array([1, 2, 3])],
    ['the value of the test', `export let f = (a) => { const k = a instanceof Int32Array ? 5 : 100; a[1] = k; return a[0] * 1000 + a[1] * 10 + a[2] }`, () => new Int32Array([1, 2, 3])],
    ['ArrayBuffer.isView as the guard', `export let f = (a) => { if (!ArrayBuffer.isView(a)) return -1; a[0] = 9; return a[0] * 1000 + a[1] }`, () => new Int32Array([1, 2, 3])],
    ['the test in a helper', `const typed = (a) => a instanceof Int32Array
export let f = (a) => { if (!typed(a)) return -1; a[0] = 9; return a[0] * 1000 + a[1] }`, () => new Int32Array([1, 2, 3])],
    ['a store through a subarray', `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; const s = a.subarray(1); s[0] = 7; return a[0] * 1000 + a[1] }`, () => new Int32Array([1, 2, 3])],
    ['a fill', `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; a.fill(4, 0, 1); return a[0] * 1000 + a[1] }`, () => new Int32Array([1, 2, 3])],
    ['a store in a counted loop', `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; for (let i = 0; i < a.length; i++) a[i] = a[i] * 2 + 1; return a[0] * 1000 + a[1] }`, () => new Int32Array([1, 2, 3])],
    ['an empty array', `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s + a.length }`, () => new Int32Array(0)],
  ]
  for (const opts of [undefined, OFF, { optimize: 0 }, { optimize: 'size' }, { optimize: 'speed' }])
    for (const [label, src, arg] of rows) is(run(src, opts).f(arg()), oracle(src).f(arg()), `${label} (${JSON.stringify(opts?.optimize ?? 'default')})`)
})

test('guarded element: the host sees the store', () => {
  const src = `export let f = (a) => { if (!(a instanceof Int32Array)) return -1; a[0] = 9; return a }`
  for (const opts of [undefined, OFF]) is([...run(src, opts).f(new Int32Array([1, 2, 3]))], [9, 2, 3])
})
