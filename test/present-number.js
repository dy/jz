// A binding read from an element that may be missing holds a Number beside its
// presence (summary/kind.js valBesidePresence, the one projection the reps and the
// flow overlay share): `===` against it compares the numbers and the undefined boxes
// inline (emit/comparisons.js), the runtime helper serving values of no known kind
// only. A typed binding whose every constructor agrees reads its length from its
// header, and a subarray sorted in place reads no length through the runtime. Every
// value is a differential against the host.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, wat, funcWat } from './util.js'
import { belowOpt } from './_matrix.js'

// The kernel is the module's only user code: the counts are over the module. The
// shapes hold once the optimizer ran; every leg runs the differentials.
const calls = (text, name) => (text.match(new RegExp(`\\(call \\$${name}[\\s)]`, 'g')) || []).length
const shapes = (src, check) => { if (!belowOpt(2)) check(wat(src)) }

const KERNEL = (walk) => `function g(tv, n, k) {
  let s = 0
  for (let seed = 0; seed < n; seed++) {
    const rep = tv[seed + k]
    if (tv[seed * 2] === rep) s++
    if (tv[seed + k] === rep) s += 10${walk}
  }
  return s
}
export function f(n, k) {
  const tv = new Int32Array(n)
  for (let i = 0; i < n; i++) tv[i] = (i * 7) % 5 - 1
  return g(tv, n + k, k)
}`

test('present-number: strict equality against a binding that may be missing', () => {
  const src = KERNEL('')
  shapes(src, w => is(calls(w, '__eq_strict'), 0, 'the compare is inline'))
  // k > 0 reads past the end: undefined === undefined holds, undefined === number does not
  for (const [n, k] of [[0, 0], [1, 0], [8, 0], [8, 3], [3, 5]]) agree(src, 'f', [n, k])
})

test('present-number: the same compare against an element a loop-carried index reads', () => {
  // In range only: a loop variable that goes undefined through a read past the
  // end differs from JS before this change (every level), and is not this test's.
  const src = KERNEL(`
    for (let other = tv[seed], steps = 0; other !== -1 && steps < 4; other = tv[other], steps++) if (tv[other + 1] === rep) s += 100`)
  shapes(src, w => is(calls(w, '__eq_strict'), 0, 'the compare is inline'))
  for (const n of [0, 1, 8, 20]) agree(src, 'f', [n, 0])
})

test('present-number: the length of a typed binding reassigned to the same constructor', () => {
  const src = `export function f(n) {
  let buf = new Float32Array(64)
  let s = 0
  for (let i = 0; i < n; i++) {
    if (buf.length < i) buf = new Float32Array(i)
    s += buf.length
  }
  return s
}`
  shapes(src, w => is(calls(w, '__length.value'), 0, 'the length reads from the header'))
  for (const n of [0, 1, 64, 65, 200]) agree(src, 'f', [n])
})

test('present-number: a subarray sorted in place reads its bounds from the header', () => {
  const src = `export function f(n, k) {
  const a = new Int32Array(n)
  for (let i = 0; i < n; i++) a[i] = (i * 7919) % 101 - 50
  a.subarray(0, k).sort()
  let s = 0
  for (let i = 0; i < n; i++) s = (s * 31 + a[i]) | 0
  return s
}`
  shapes(src, w => {
    // Generic ToNumber support for k includes array/string conversion helpers,
    // whose unrelated reads need runtime lengths. Inspect the typed operation.
    const f = funcWat(w, 'f$exp') || funcWat(w, 'f')
    ok(f.length > 0, 'inspect the function containing the typed sort')
    is(calls(f, '__len'), 0, 'the typed sort reads length from its header')
    is(calls(f, '__length.value'), 0, 'the typed sort has no runtime length dispatch')
  })
  for (const [n, k] of [[0, 0], [1, 1], [10, 0], [10, 4], [10, 10], [40, 30], [40, 60], [10, -1], [10, 2.5], [10, NaN],
    [10, Infinity], [10, -Infinity], [10, '4'], [10, [4]], [10, null], [10, undefined]]) agree(src, 'f', [n, k])
})

// A number that may be missing (an element of a typed binding that is a box)
// is truthy where it is a number other than zero, inline: a box is a NaN.
test('present-number: the truthiness of an element that may be missing', () => {
  const src = `export function f(n, k) {
  let flags = new Uint8Array(4)
  if (n > 4) flags = new Uint8Array(n)
  for (let i = 0; i < n; i++) flags[i] = (i * 7 + k) % 3
  let a = 0, b = 0, c = 0
  for (let i = 0; i < n + 2; i++) {
    if (flags[i]) a++
    if (!flags[i]) b++
    c += flags[i] ? 2 : 1
  }
  return a * 10000 + b * 100 + c
}`
  if (!belowOpt(2)) is(wat(src).includes('$__is_truthy'), false, 'no truthiness through the runtime')
  for (const n of [0, 1, 3, 4, 5, 9, 16]) for (const k of [0, 1, 2]) agree(src, 'f', [n, k])
})
