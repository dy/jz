// The numbers an array's elements can be (src/summary `elemNums`, num-range.js):
// the interval every store into the cell keeps, whether all are integers, none
// -0 and how far from zero. A literal's elements, a `map`'s callback results
// (its parameters bound to the receiver's numbers and the index), a `fill`'s
// value; any other store of a number opens it. A dense array of words read
// inside its fixed length is read as a word, so the arithmetic it feeds stays
// integer: a dequantization table `tab[sf][q]` built by `.map` over
// `Math.round` (QOA's `qoa_dequant_tab`) adds and clamps in i32.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { ctx } from '../src/ctx.js'
import { levels } from './_matrix.js'
import { agree, wat, funcWat, compileInProcess as compile } from './util.js'

// The summary's numbers of the array an expression holds (module scope), as `[lo, hi, int, nz]`.
const nums = (src, e) => {
  compile(src, { host: 'js', optimize: 0 })
  const r = ctx.summary.at(null).elemNumsOfExpr(e)
  return r && [r.lo, r.hi, r.int, r.nz]
}
const len = (src, e) => { compile(src, { host: 'js', optimize: 0 }); return ctx.summary.at(null).fixedLenOfExpr(e) }
const use = 'export const f = (i) => '

test('element numbers: literals, map and fill state their elements', () => {
  is(nums(`const a = [1, 2, 3]\n${use}a[i & 1]`, 'a'), [1, 3, true, true], 'an integer literal')
  is(nums(`const a = [0.75, -7]\n${use}a[i & 1]`, 'a'), [-7, 0.75, false, true], 'a fraction')
  is(nums(`const a = [1, 2, 3].map(x => x * 2)\n${use}a[i & 1]`, 'a'), [2, 6, true, true], 'a map over a literal')
  is(nums(`const a = Array(4).fill().map((_, k) => k * k)\n${use}a[i & 3]`, 'a'), [0, 9, true, true], 'a map over the indices')
  is(nums(`const a = new Array(4).fill(7)\n${use}a[i & 3]`, 'a'), [7, 7, true, true], 'a fill')
  is(nums(`const r = n => Math.sign(n) * Math.round(Math.abs(n))
    const s = Array(16).fill().map((_, k) => r(Math.pow(k + 1, 2.75)))
    const t = s.map(sf => [0.75, -0.75, 7, -7].map(d => r(d * sf)))\n${use}t[i & 15][i & 3]`, ['[]', 't', [null, 0]]),
    [-14336, 14336, true, true], 'rows of rounded products: integers clear of -0, through a function of one expression')
})

test('element numbers: a map keeps its receiver\'s count, a fill keeps the construction\'s', () => {
  is(len(`const a = [1, 2, 3].map(x => x * 2)\n${use}a[i & 1]`, 'a'), 3)
  is(len(`const a = Array(5).fill().map((_, k) => k)\n${use}a[i & 3]`, 'a'), 5)
  is(len(`const a = [[1, 2], [3, 4]].map(r => r.map(x => -x))\n${use}a[i & 1][i & 1]`, ['[]', 'a', [null, 0]]), 2, 'a row of a row map')
})

test('element numbers: -0, a non-finite value or a store the walk cannot bound opens them', () => {
  const open = (src, why) => { const r = nums(src, 'a'); ok(r === null || !(r[2] && r[3]), why) }
  open(`const a = [1, -1].map(x => x * 0)\n${use}a[i & 1]`, 'a product that may be -0')
  open(`const a = [0, -0]\n${use}a[i & 1]`, 'a -0 literal')
  is(nums(`const a = [1, 1 / 0]\n${use}a[i & 1]`, 'a'), null, 'an infinity')
  is(nums(`const a = [1, 2]\nexport const f = (i, v) => { a[i & 1] = v; return a[0] }`, 'a'), null, 'a store of an argument')
  is(nums(`const a = [1, 2]\nexport const f = (i) => { a[i & 1] += 0.5; return a[0] }`, 'a'), null, 'a compound store')
  is(nums(`const a = [1, 2]\nexport const f = (v) => { a.push(v); return a[0] }`, 'a'), null, 'a push')
  is(nums(`export const a = [1, 2]\n${use}a[i & 1]`, 'a'), null, 'an exported binding')
  is(nums(`const g = x => x + 1, a = [1, 2].map(g)\nexport const f = (v) => g(v) + a[0]`, 'a'), null, 'a callback another call binds')
  is(nums(`const a = [1, 2].map((x, k) => { const y = x * k; return y })\n${use}a[i & 1]`, 'a'), null, 'a callback of statements')
})

// The class, minimal: a table of tables of rounded integers indexed by a byte's
// fields, its element added to a prediction and clamped (decode-qoa's frame loop).
const TABLE = `const round = n => Math.sign(n) * Math.round(Math.abs(n))
const SF = Array(16).fill().map((_, s) => round(Math.pow(s + 1, 2.75)))
const DQ = [0.75, -0.75, 2.5, -2.5, 4.5, -4.5, 7, -7]
const TAB = SF.map(sf => DQ.map(d => round(d * sf)))
const B = new Uint8Array(4096), H = new Int16Array(4096)
for (let i = 0, x = 1; i < B.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; B[i] = x >>> 24 }
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v
export const f = () => {
  let b = B, h = H, s = 0
  for (let p = 2; p < b.length; p++) {
    let t = TAB[b[p] >>> 4], pred = (h[p - 1] * 3 - h[p - 2] * 2) >> 1
    h[p] = clamp(pred + t[b[p] & 7], -32768, 32767); s ^= h[p]
  }
  return s
}`

test('element numbers: a table of words feeds integer arithmetic', () => {
  for (const optimize of levels(1, 2, 3)) agree(TABLE, 'f', [], { optimize }, `the decoded checksum at ${optimize}`)
  // (from level 2, where the clamp inlines)
  for (const optimize of levels(2, 3)) {
    const body = funcWat(wat(TABLE, { optimize }), 'f')
    ok(/i32\.trunc_sat_f64_s/.test(body), `the element reads as a word at ${optimize}`)
    ok(!/f64\.(add|lt|gt)\b/.test(body), `the sum and the clamp stay integer at ${optimize}`)
  }
})

test('element numbers: values that are not words read as they are', () => {
  for (const optimize of levels(1, 2)) {
    agree(`const T = [1, -1].map(x => x * 0)\nexport const f = (i) => 1 / T[i & 1]`, 'f', [1], { optimize }, `a -0 element at ${optimize}`)
    agree(`const T = [1, 2, 3].map(x => x / 4)\nexport const f = (i) => T[i % 3] * 4 + 0.5`, 'f', [2], { optimize }, `a fraction at ${optimize}`)
    agree(`const T = [1, 2, 3]\nexport const f = (i) => { T[i % 3] = 0.5; return T[0] + T[1] + T[2] }`, 'f', [1], { optimize }, `a table stored to at ${optimize}`)
    agree(`const T = [2 ** 31, 1]\nexport const f = (i) => T[i & 1] + 1`, 'f', [0], { optimize }, `an integer past a word at ${optimize}`)
  }
})

// Every transfer rule against the host's own arithmetic: values drawn from each
// operand's range (its ends, a seeded draw inside it that keeps its facts) give
// results inside the result's range, of its facts. The operands are joins of
// points (NaN, -0, the infinities and magnitudes past 2^53 among them) and
// integers of an open end, the intervals a loop's widening leaves.
test('element numbers: the transfer rules hold of the values they bound', async () => {
  const { nrPoint, nrInts, nrJoin, nrBinary, nrUnary, nrMath, NUMBER } = await import('../src/summary/num-range.js')
  const { powRuntime } = await import('../src/prepare/math-kernel.js')
  const POOL = [-0, 0, 0.25, -0.5, 0.5, 0.75, -0.75, 1, -1, 1.5, -2.5, 3, 7, -7, 16, -16, 31, 33, 255, 2048, -14336, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), 2 ** 32,
    1e-200, -1e-200, 2 ** 53 + 2, -(2 ** 60), 1e300, -1e300, 1.7e308, NaN, Infinity, -Infinity]
  // (and numbers integral wherever finite: what Math.floor makes of any number, an infinity among them)
  const OPEN = [[nrInts(0, Infinity), [0, 1, 15, 16, 2 ** 40, 1e300]], [nrInts(-Infinity, 3), [3, 0, -1, -16, -(2 ** 60), -1.7e308]],
    [nrInts(-Infinity, Infinity), [0, -5, 5, 1e308, -1e308]],
    [nrMath('floor', [NUMBER]), [0, -0, 5, -5, 2 ** 60, -1e300, NaN, Infinity, -Infinity]],
    [nrMath('floor', [nrBinary('/', nrInts(0, Infinity), nrPoint(3))]), [0, 1, 7, 2 ** 60, 1.7e308, Infinity]]]
  let seed = 7
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32 }
  const pick = () => { const n = 1 + Math.floor(rnd() * 3), s = []; for (let i = 0; i < n; i++) s.push(POOL[Math.floor(rnd() * POOL.length)]); return s }
  const operand = () => { if (rnd() < 0.2) return OPEN[Math.floor(rnd() * OPEN.length)]; const s = pick(); return [s.map(nrPoint).reduce(nrJoin), s] }
  const holds = (r, v) => Number.isNaN(v) ? r.nan : v >= r.lo && v <= r.hi && (!r.int || Number.isInteger(v)) &&
    (!r.whole || !Number.isFinite(v) || Number.isInteger(v)) && (!r.nz || !Object.is(v, -0)) && Math.abs(v) >= r.gap
  // values of a range: its set's, its ends where they keep its facts, draws inside it
  const values = (r, set) => {
    const out = [...set]
    for (const v of [r.lo, r.hi]) if (holds(r, v)) out.push(v)
    for (let i = 0; i < 6 && Number.isFinite(r.hi - r.lo); i++) { let v = r.lo + (r.hi - r.lo) * rnd(); if (r.int) v = Math.round(v); if (holds(r, v)) out.push(v) }
    return out
  }
  const BIN = { '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y, '%': (x, y) => x % y, '**': (x, y) => x ** y,
    '&': (x, y) => x & y, '|': (x, y) => x | y, '^': (x, y) => x ^ y, '<<': (x, y) => x << y, '>>': (x, y) => x >> y, '>>>': (x, y) => x >>> y }
  const UN = { 'u-': x => -x, 'u+': x => +x, '~': x => ~x }
  const MATH = ['abs', 'sign', 'round', 'floor', 'ceil', 'trunc', 'sqrt']
  let checked = 0, bad = []
  const check = (label, r, v) => { if (r === null) return; checked++; if (!holds(r, v)) bad.push(`${label} = ${Object.is(v, -0) ? '-0' : v} outside ${JSON.stringify(r)}`) }
  for (let t = 0; t < 600 && bad.length < 5; t++) {
    const [a, sa] = operand(), [b, sb] = operand()
    if (!a || !b) continue
    const xs = values(a, sa), ys = values(b, sb)
    for (const op in BIN) { const r = nrBinary(op, a, b, powRuntime); for (const x of xs) for (const y of ys) check(`${x} ${op} ${y}`, r, BIN[op](x, y)) }
    for (const op in UN) { const r = nrUnary(op, a); for (const x of xs) check(`${op} ${x}`, r, UN[op](x)) }
    for (const f of MATH) { const r = nrMath(f, [a]); for (const x of xs) check(`Math.${f}(${x})`, r, Math[f](x)) }
    for (const f of ['min', 'max', 'imul']) { const r = nrMath(f, [a, b]); for (const x of xs) for (const y of ys) check(`Math.${f}(${x}, ${y})`, r, Math[f](x, y)) }
    const e = nrPoint(sb[0]), rp = nrMath('pow', [a, e]); for (const x of xs) check(`Math.pow(${x}, ${sb[0]})`, rp, Math.pow(x, sb[0]))
  }
  is(bad, [], `${checked} values inside their ranges`)
})

// The bitwise operators read each operand's word: a field of non-negative words
// stays below the higher one's top bit, a shift that keeps a word scales it,
// a count of a range shifts by each of its counts.
test('element numbers: bit fields and shifts of words', async () => {
  const { nrInts, nrPoint, nrBinary, nrUnary, nrSpan, NUMBER } = await import('../src/summary/num-range.js')
  const span = (op, a, b) => nrSpan(nrBinary(op, a, b))
  is(span('|', nrBinary('<<', nrInts(0, 3), nrPoint(4)), nrInts(0, 15)), [0, 63], 'a packed table index: two fields')
  is(span('^', nrInts(0, 511), nrInts(1, 256)), [0, 511], 'a bit-reversal cursor stays in its field')
  is(span('|', nrInts(-3, 5), nrPoint(0)), [-3, 5], 'x | 0 of a word is the word')
  is(span('|', nrInts(-3, 5), nrPoint(1)), [-2147483648, 2147483647], 'a negative operand sets any bit')
  is(span('&', NUMBER, nrInts(0, 200)), [0, 200], 'a non-negative operand bounds a mask')
  is(span('>>>', nrInts(0, 2 ** 32 - 1), nrPoint(0)), [0, 2 ** 32 - 1], 'x >>> 0 of a uint32 keeps it')
  is(span('>>>', nrInts(-1, 3), nrPoint(28)), [0, 15], 'a negative word shifted unsigned')
  is(span('>>', nrInts(-64, 64), nrInts(1, 3)), [-32, 32], 'a range of counts')
  is(span('<<', nrInts(-3, 5), nrInts(0, 2)), [-12, 20], 'a left shift inside the word')
  is(span('<<', nrInts(0, 2 ** 30), nrPoint(2)), [-2147483648, 2147483647], 'a left shift past the word wraps to any')
  is(span('|', nrBinary('/', nrInts(0, 7), nrPoint(2)), nrPoint(0)), [0, 3], 'ToInt32 truncates a fraction')
  is(nrSpan(nrUnary('~', nrInts(0, 7))), [-8, -1], 'a complement')
})

// The remainder by a nonzero integer of an integer that is never NaN: below the
// divisor's magnitude whatever the dividend's (a counter a loop widened to an
// open end), the dividend's sign, -0 only of a negative or -0 dividend.
test('element numbers: the remainder of an integer of any magnitude', async () => {
  const { nrInts, nrPoint, nrBinary, nrWord, nrSpan } = await import('../src/summary/num-range.js')
  const rem = (lo, hi, k) => nrBinary('%', nrInts(lo, hi), nrPoint(k))
  is(nrSpan(rem(0, Infinity, 16)), [0, 15], 'an open non-negative dividend by 16')
  ok(nrWord(rem(1, Infinity, 16)), 'a word, never -0 nor NaN')
  is(nrSpan(rem(0, Infinity, -16)), [0, 15], 'a negative divisor: its magnitude')
  is(nrSpan(rem(0, 9, 16)), [0, 9], 'a dividend below the divisor keeps its own bound')
  is(nrSpan(rem(-Infinity, Infinity, 16)), [-15, 15], 'a dividend of either sign')
  ok(!rem(-20, 3, 16).nz && !nrWord(rem(-20, 3, 16)), 'a negative dividend may give -0')
  ok(rem(0, Infinity, 0).nan, 'a zero divisor: NaN')
  ok(nrBinary('%', nrPoint(Infinity), nrPoint(16)).nan, 'an infinite dividend: NaN')
  const half = nrBinary('%', nrInts(0, Infinity), nrPoint(2.5))
  ok(!half.int && half.hi === 2.5, 'a fractional divisor: no integer, below its magnitude')
})
