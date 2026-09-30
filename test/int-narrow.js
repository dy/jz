// An f64 local that holds integers is carried in an integer register
// (src/optimize/int-narrow.js), by the intervals src/optimize/int-range.js reads off
// the control flow: below 2^53 the integers are exact in f64, so their sums, products,
// remainders and truncated quotients are the integers' own. Every value is a
// differential against the host; the WAT shows where the arithmetic runs.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, oracle, run, wat } from './util.js'
import { belowOpt } from './_matrix.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { narrowInts } from '../src/optimize/int-narrow.js'

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

// A number the intervals know is truthy where it is not zero: no call to the
// runtime's kind chain for a flag carried as an integer.
test('int-narrow: the truthiness of a number the intervals know', () => {
  const src = `export function f(n) {
  let split = false, total = 0
  for (let g = 0; g < n; g++) {
    for (let i = 0; i < 4 && !split; i++) if ((g + i) % 7 === 3) split = true
    const size = split ? 0 : 8
    for (let j = 0; split && j < 8; j++) total += j
    total += size + (g % 5 ? 1 : 2)
    split = false
  }
  return total
}`
  shapes(src, w => ok(!w.includes('$__is_truthy'), 'no truthiness through the runtime'))
  for (const n of [0, 1, 5, 20, 100]) agree(src, 'f', [n])
})

// A typed array the function makes and keeps to itself holds what the function
// stores into it: an index read from one is bounded by those stores, and its
// arithmetic stays in i32 where the bound says so.
test('int-narrow: elements bounded by what the function stores', () => {
  const src = `export function f(n) {
  const stack = new Int32Array(n + 1), seen = new Int32Array(n)
  let top = 0, s = 0
  stack[top++] = 0
  while (top > 0) {
    const f = stack[--top]
    const base = f * 3
    s += base
    if (f < n && seen[f] === 0) { seen[f] = 1; stack[top++] = (f * 7 + 1) & 0xffff; if (top < n) stack[top++] = (f + 1) & 0xffff }
  }
  return s
}`
  shapes(src, w => { const copy = w.slice(w.search(/\(loop \$[^\s)]*\.f\d+[\s)]/)); ok(!/i64\.mul/.test(copy.slice(0, copy.indexOf('(br $'))), 'the product of an element the stores bound is an i32') })
  for (const n of [0, 1, 2, 5, 16, 100]) agree(src, 'f', [n])
})

test('int-narrow: i64 comparisons retain bits beyond exact Number integers', () => {
  const pairs = [
    ['9007199254740992', '9007199254740993'],
    ['-9007199254740992', '-9007199254740993'],
    ['9223372036854775806', '9223372036854775807'],
    ['-9223372036854775808', '-9223372036854775807'],
    ['0x7ff8000000000000', '0x7ff8000000000001'],
  ]
  for (const [a, b] of pairs) for (const op of ['eq', 'ne', 'lt_s', 'le_s', 'gt_s', 'ge_s']) {
    const src = `(module (func $f (export "f") (param $c i32) (result i32) (local $x i64)
      (local.set $x (select (i64.const ${a}) (i64.const ${b}) (local.get $c)))
      (if (result i32) (i64.${op} (local.get $x) (i64.const ${a})) (then (i32.const 7)) (else (i32.const 9)))))`
    const ir = parseWat(src), before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir[1])
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const c of [0, 0, 1, 0]) is(after(c), before(c), `${a}, ${b}, ${op}, c=${c}`)
  }
})

test('int-narrow: saturating i64 conversions keep their actual magnitude', () => {
  for (const n of ['1e30', '-1e30', 'inf', '-inf', 'nan', '4503599627370496', '-4503599627370496', '0']) {
    const src = `(module (func $f (export "f") (result i32)
      (f64.gt (f64.abs (f64.convert_i64_s (i64.trunc_sat_f64_s (f64.const ${n})))) (f64.const 1e25))))`
    const ir = parseWat(src), before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir[1])
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    is(after(), before(), `saturated magnitude, ${n}`)
  }
  const src = `(module (func $f (export "f") (param $c i32) (result i32) (local $x f64)
    (local.set $x (select (f64.const 1e30) (f64.const -1e30) (local.get $c)))
    (f64.gt (f64.abs (f64.convert_i64_s (i64.trunc_sat_f64_s (local.get $x)))) (f64.const 1e25))))`
  const ir = parseWat(src), before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  narrowInts(ir[1])
  const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
  for (const c of [0, 0, 1, 0]) is(after(c), before(c), `saturated magnitude, c=${c}`)
})

test('int-narrow: guard refinements follow later operand writes', () => {
  const bodies = [
    'if (x < (x = (n + 1) & 7)) return x === 7; return 3',
    'return x < (x = (n + 1) & 7) ? x === 7 : 3',
    'if (x > (x = (n - 1) & 7)) return x === 0; return 3',
    'if (!((x < 3) & (x = (n + 5) & 7))) return x; return x === 7',
    'if ((x > 3) | (x = (n + 2) & 7)) return x; return x === 0',
    'if ((x = (n + 1) & 7) < 7) return x === 7; return x',
  ]
  for (const body of bodies) {
    const src = `export function f(n) { let x = n & 7; ${body} }`, host = oracle(src).f
    for (const optimize of [0, 1, 2, 3, 'size']) {
      const f = run(src, { optimize }).f
      for (const n of [6, 6, 0, 6, -1, 1, 2, 7, 8, 14, 2147483647, -2147483648])
        is(f(n), host(n), `${body}, ${optimize}, ${n}`)
    }
  }
})

test('int-narrow: eager compound guards keep refinements on current reads', () => {
  const guards = [
    '(i32.lt_s (local.get $x) (local.tee $x (i32.and (i32.add (local.get $n) (i32.const 1)) (i32.const 7))))',
    '(i32.and (i32.lt_s (local.get $x) (i32.const 3)) (local.tee $x (i32.and (i32.add (local.get $n) (i32.const 5)) (i32.const 7))))',
    '(i32.eqz (i32.or (i32.gt_s (local.get $x) (i32.const 3)) (local.tee $x (i32.and (i32.add (local.get $n) (i32.const 2)) (i32.const 7)))))',
  ]
  for (const guard of guards) {
    const src = `(module (func $f (export "f") (param $n i32) (result i32) (local $x i32)
      (local.set $x (i32.and (local.get $n) (i32.const 7)))
      (if (result i32) ${guard}
        (then (i32.eq (local.get $x) (i32.const 7)))
        (else (i32.eq (local.get $x) (i32.const 0))))))`
    const ir = parseWat(src), before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    narrowInts(ir[1])
    const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ir))).exports.f
    for (const n of [6, 6, 0, 6, -1, 1, 2, 3, 4, 5, 7, 8, 14]) is(after(n), before(n), `${guard}, n=${n}`)
  }
})
