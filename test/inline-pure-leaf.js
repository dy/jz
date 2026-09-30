// A pure leaf inlines where a call would run per element: its element-read
// arguments substitute into its effect-free body (src/compile/plan/inline.js
// inlinedBody), Math builtins flatten as the arithmetic they are, and a leaf
// that calls such a leaf inlines below the speed tier. What must not move:
// a read into a body that writes, a read past an argument that runs code,
// and Math.random, whose duplicate is another draw.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, run, wat, funcWat as funcWatOf } from './util.js'
import { belowOpt } from './_matrix.js'

const funcWat = (text, name) => funcWatOf(text, name) || funcWatOf(text, `${name}$exp`)
const calls = (src, callee, fn = 'f') => (funcWat(wat(src), fn).match(new RegExp(`call \\$${callee}\\b`, 'g')) || []).length
// The inlining holds once the optimizer ran; every leg runs the differentials.
const inlined = (src, callee, label = `${callee} is inlined`) => { if (!belowOpt(2)) is(calls(src, callee), 0, label) }
const f32 = (n) => Float32Array.from({ length: n }, (_, i) => ((i * 7919) % 97 - 48) / 8)

test('pure leaf: element-read arguments inline inside a condition', () => {
  // three.js MikkTSpace's dot in its subgroup test: two calls per pair, in an && operand
  const src = `const fround = Math.fround
function dot( ax, ay, az, bx, by, bz ) { return fround( fround( fround( ax * bx ) + fround( ay * by ) ) + fround( az * bz ) ); }
export let f = (src, n) => {
  if (!(src instanceof Float32Array)) throw new TypeError('x')
  const a = new Float32Array(src.length)
  for (let i = 0; i < a.length; i++) a[i] = src[i] * 0.5
  let pairs = 0
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = i * 6, q = j * 6
    if (i === j || (dot(a[p], a[p + 1], a[p + 2], a[q], a[q + 1], a[q + 2]) > -1 && dot(a[p + 3], a[p + 4], a[p + 5], a[q + 3], a[q + 4], a[q + 5]) > -1)) pairs++
  }
  return pairs }`
  inlined(src, 'dot')
  for (const n of [0, 1, 4, 9]) agree(src, 'f', [f32(n * 6), n])
  // the same reads on the guarded parameter itself, through its view (plan/guard-views.js)
  const guarded = src.replace("const a = new Float32Array(src.length)\n  for (let i = 0; i < a.length; i++) a[i] = src[i] * 0.5\n", '').replace(/\ba\[/g, 'src[')
  inlined(guarded, 'dot', 'dot is inlined through the guard view')
  for (const n of [0, 4]) agree(guarded, 'f', [f32(n * 6), n])
})

test('pure leaf: a read of a receiver the summary does not name typed stays a call argument', () => {
  // a dictionary read or a plain-array read keeps its evaluation before the call
  const dict = `const mix = (h, x) => (((h ^ x) * 16777619) | 0)
export let f = (n) => { const counts = {}; let h = 5; for (let i = 0; i < n; i++) { const w = 'k' + (i & 3); counts[w] = (counts[w] | 0) + 1; h = mix(h, counts[w]) } return h >>> 0 }`
  for (const n of [0, 3, 40]) agree(dict, 'f', [n])
  const arr = `const g = (v) => v + 1
export let f = (k) => { const a = [1, 2, 3]; return g(a[k]) }`
  for (const k of [0, 2, 10]) agree(arr, 'f', [k])
})

test('pure leaf: a Math builtin flattens, a leaf through a leaf inlines', () => {
  const src = `const fround = Math.fround, FLOAT_MIN = 1.1754943508222875e-38
function dot( ax, ay, az, bx, by, bz ) { return fround( fround( fround( ax * bx ) + fround( ay * by ) ) + fround( az * bz ) ); }
function vectorLength( x, y, z ) { return fround( Math.sqrt( dot( x, y, z, x, y, z ) ) ); }
function isNonZero( x, y, z ) { return Math.abs( x ) > FLOAT_MIN || Math.abs( y ) > FLOAT_MIN || Math.abs( z ) > FLOAT_MIN; }
export let f = (src, n) => {
  const a = new Float32Array(src)
  let s = 0, k = 0
  for (let i = 0; i < n; i++) {
    const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2]
    if (isNonZero(x, y, z)) { s = fround(s + vectorLength(x, y, z)); k++ }
  }
  return s * 1000 + k }`
  for (const callee of ['dot', 'vectorLength', 'isNonZero']) inlined(src, callee)
  for (const n of [0, 1, 7, 100]) agree(src, 'f', [f32(n * 3), n])
  const zeros = new Float32Array(9)
  agree(src, 'f', [zeros, 3])
})

test('pure leaf: a read never moves past a write or a call', () => {
  const store = `function put(a, v) { a[0] = 5; return v }
export let f = (n) => { const a = new Int32Array(4); a[0] = n; return put(a, a[0]) * 10 + a[0] }`
  for (const n of [1, 7]) agree(store, 'f', [n])
  const effect = `let hits = 0
function bump(a) { hits++; a[0] += 100; return hits }
function sum(x, y) { return x + y }
export let f = (n) => { const a = new Int32Array(2); a[0] = n; return sum(a[0], bump(a)) * 1000 + a[0] }`
  for (const n of [1, 3]) agree(effect, 'f', [n])
})

test('pure leaf: Math.random is one draw per read', () => {
  const src = `function pick(k) { const r = Math.random(); return r === r + k ? 1 : 2 }
export let f = () => { let same = 0; for (let i = 0; i < 50; i++) same += pick(0); return same }`
  is(run(src, { randomSeed: 3 }).f(), 50, 'the same draw compared with itself')
})

test('pure leaf: a missing element read as an argument is undefined', () => {
  const src = `function dbl(v) { return v * 2 }
export let f = (n, k) => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i + 1; const d = dbl(a[k]); return d === d ? d : -1 }`
  inlined(src, 'dbl')
  for (const [n, k] of [[4, 0], [4, 3], [4, 4], [4, 9], [0, 0]]) agree(src, 'f', [n, k])
})
