// An f64 local that holds integers is carried in an integer register
// (src/optimize/int-narrow.js), by the intervals src/optimize/int-range.js reads off
// the control flow: below 2^53 the integers are exact in f64, so their sums, products,
// remainders and truncated quotients are the integers' own. Every value is a
// differential against the host; the WAT shows where the arithmetic runs.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { agree, wat } from './util.js'
import { belowOpt } from './_matrix.js'

const count = (text, op) => (text.match(new RegExp(`\\(${op.replace('.', '\\.')}[\\s)]`, 'g')) || []).length
const shapes = (src, check) => { if (!belowOpt(2)) check(wat(src)) }
const ARGS = [0, 1, 2, 3, 5, 7, -1, -3, 16, 100, 2147483647, -2147483648, 0.5, NaN]

test('int-narrow: an index made of an element, its remainders and its quotient', () => {
  const src = `export function f(n) {
  const table = new Int32Array(64)
  for (let i = 0; i < 64; i++) table[i] = i % 5 ? (i * 7 + n) | 0 : 0
  let s = 0
  for (let slot = 0; slot < 64; slot++) {
    if (table[slot]) {
      const edge = table[slot] - 1
      const edgeEnd = edge - edge % 3 + (edge + 1) % 3
      s += edgeEnd * 3 + (edge / 3 | 0) + (edge / -7 | 0)
    }
  }
  return s
}`
  shapes(src, w => {
    ok(count(w, 'i32.rem_s') + count(w, 'i64.rem_s') >= 2, 'the remainders are the integers\'')
    ok(count(w, 'i32.div_s') + count(w, 'i64.div_s') >= 2, 'the quotients are the integers\'')
    ok(count(w, 'f64.div') === 0, 'no division is left in f64')
  })
  for (const n of ARGS) agree(src, 'f', [n])
})

test('int-narrow: a product of an element past the i32 range', () => {
  const src = `export function f(n) {
  const a = new Int32Array(4), v = new Int32Array(16)
  a[0] = 2147483647; a[1] = -2147483648; a[2] = n; a[3] = 65536
  for (let i = 0; i < 16; i++) v[i] = i * i - 40
  let s = 0
  for (let i = 0; i < 4; i++) {
    const f = a[i], base = f * 3, corner = base + 2
    s = s * 3 + (corner > 4294967296 ? 1 : 0) + (base === f + f + f ? 2 : 0) + v[(corner % 16 + 16) % 16]
  }
  return s
}`
  shapes(src, w => ok(count(w, 'i64.mul') + count(w, 'i64.add') >= 1, 'the product is carried in i64'))
  for (const n of ARGS) agree(src, 'f', [n])
})

test('int-narrow: the zero of a negative remainder keeps its sign where a division reads it', () => {
  const src = `export function f(n) {
  const a = new Int32Array(8)
  for (let i = 0; i < 8; i++) a[i] = i * 3 - n
  let s = 0, m = 0
  for (let i = 0; i < 8; i++) {
    const b = a[i] * 3 + 3, r = b % 3
    const q = 1 / r
    s += q === -Infinity ? 1 : q === Infinity ? 100 : 10000
    m += (b + 7) % 5
  }
  return s * 1000 + m
}`
  for (const n of [0, 1, 3, 4, 9, 12, 21, 100, -6]) agree(src, 'f', [n])
})

test('int-narrow: minimum, maximum, magnitude and negation of integers', () => {
  const src = `export function f(n) {
  const a = new Int32Array(6)
  a[0] = n; a[1] = -2147483648; a[2] = 2147483647; a[3] = 0; a[4] = -n; a[5] = 7
  let h = 0
  for (let i = 0; i < 5; i++) {
    const lo = Math.min(a[i], a[i + 1]), hi = Math.max(a[i], a[i + 1])
    h = Math.imul(h ^ lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b)
    h = (h + Math.abs(lo) - -hi) | 0
  }
  return h
}`
  for (const n of ARGS) agree(src, 'f', [n])
})

test('int-narrow: a value that may pass 2^53 stays a number', () => {
  const src = `export function f(n) {
  const a = new Int32Array(2)
  a[0] = n
  let x = a[0] + 9007199254740000, s = 0
  for (let k = 0; k < 8; k++) {
    const y = x + 1
    s = s * 4 + (y === x ? 1 : 0) + (y - x)
    x = x + 300
  }
  return s + x % 1024
}`
  for (const n of [0, 1, -1, 7, 991, 992, 993, 1000, -100000, 2147483647, -2147483648]) agree(src, 'f', [n])
})

test('int-narrow: a fraction truncated where it is read', () => {
  const src = `export function f(n) {
  const a = new Int32Array(8)
  for (let i = 0; i < 8; i++) a[i] = i * 5 - n
  let s = 0
  for (let i = 0; i < 8; i++) { const e = a[i] - 1, t = e / 3, k = t | 0; s = (s * 31 + k + (t * 2 | 0)) | 0 }
  return s
}`
  for (const n of ARGS) agree(src, 'f', [n])
})

test('int-narrow: a value that may be missing stays as it is', () => {
  const src = `export function f(n) {
  const a = new Int32Array(4)
  a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4
  let s = 0
  for (let i = 0; i < 6; i++) { const e = a[i + n] - 1; s += e % 3 === 0 ? 1 : e !== e ? 100 : 10 }
  return s
}`
  for (const n of [0, 1, 2, 3, 5, 7, -1, -3, 16, 100]) agree(src, 'f', [n])
})

test('int-narrow: a slot that holds any value is no number', () => {
  const src = `export let f = (n) => {
  let [x, y] = [, 7]
  let row = [n, undefined, null, 'a']
  let s = (x == null) + y
  for (let i = 0; i < 4; i++) s = s * 3 + (row[i] == null ? 1 : row[i] === n ? 2 : 0)
  return s
}`
  for (const n of [0, 1, -1, 0.5]) agree(src, 'f', [n])
})

test('int-narrow: a word of flags stays a word', () => {
  const src = `export function f(n) {
  const flags = new Uint8Array(8), area = new Float32Array(8)
  for (let i = 0; i < 8; i++) area[i] = (i - n) / 4
  let s = 0
  for (let i = 0; i < 8; i++) {
    flags[i] = 4 | (area[i] > 0 ? 8 : 0)
    if (area[i] * area[i] > 0.2) flags[i] &= ~4
    s = s * 16 + flags[i]
  }
  return s
}`
  for (const n of [0, 1, 3, 5, 9]) agree(src, 'f', [n])
})

// Two values the emitter could not type compare through the runtime; two
// numbers compare as numbers do: -0 equals 0, NaN equals nothing, and a miss
// (undefined) equals another miss.
test('int-narrow: strict equality of values that are numbers where they are read', () => {
  const src = `export function f(n, at, other) {
  const a = new Float64Array(8), b = new Int32Array(8), c = new Float64Array(8)
  for (let i = 0; i < 8; i++) { a[i] = i % 3 === 0 ? -0 : i % 3 === 1 ? NaN : i * 0.5; b[i] = i % 3 === 0 ? 0 : i; c[i] = i % 3 === 2 ? i * 0.5 : i % 3 === 1 ? NaN : 0 }
  let same = 0, differ = 0
  for (let i = 0; i < n; i++) {
    const x = a[(i + at) & 15], y = c[(i + other) & 15], z = b[(i + at) & 15]
    if (x === y) same++
    else differ++
    if (z === x) same += 10
    if (y !== z) differ += 100
    if (x === undefined) same += 1000
  }
  return same * 1e6 + differ
}`
  for (const n of [0, 1, 8, 16, 40]) for (const at of [0, 1, 5, 8]) for (const other of [0, 3, 9]) agree(src, 'f', [n, at, other])
})

// A shift by a count that is not known leaves anything from the value down to
// zero; an assignment inside an operand is made before the operand after it.
test('int-narrow: a shift by a count the intervals do not know', () => {
  const src = `export function f(n, k) {
  let s = 0
  for (let i = 0; i < n; i++) {
    let x = i & 7
    const a = (x = 5) >>> x, b = x >>> (x = (i & 3)), c = (i + 40) >>> (k & 31), d = (x = 9) >> x, e = (x = 2) << x
    s = (s * 31 + a + b * 3 + c * 5 + d * 7 + e * 11 + x) | 0
    if ((x = 1) >>> x !== 0) s += 1000
    if ((i + 1000) >>> k > 3) s += 7
  }
  return s
}`
  for (const n of [0, 5, 9, 20]) for (const k of [0, 1, 3, 33, -1]) agree(src, 'f', [n, k])
})
