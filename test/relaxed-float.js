// A program's float results are JavaScript's at every level but 'speed', where the
// public `optimize.relaxedFloat` lets them differ in their last bits (README, "Float
// results at 'speed'"), and `{ level: 'speed', relaxedFloat: false }` is the speed build
// with JavaScript's results. A loop's sum or product is the left fold in index order
// (ECMA-262 2024 14.7.4.2 ForBodyEvaluation), each step rounded once to nearest, ties to
// even (6.1.6.1.7 Number::add, 6.1.6.1.4 Number::multiply); a constant chain rounds at
// each operation as written (13.15.3 ApplyStringOrNumericBinaryOperator); a comparison
// maximum keeps the first of two equal values, and +0 and -0 compare equal (7.2.13
// IsLessThan). The data is built from integers and
// quotients, never from a Math function (jz's kernels are within their stated ulps of
// V8's, README "Math within 50 ulp of V8"). The expected values are Node's (util.js oracle),
// each module compiled through the public entry (index.js), which checks the option.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { oracle } from './util.js'

const EXACT = [false, true, 'size', { level: 'speed', relaxedFloat: false }]
const name = o => JSON.stringify(o)
const bits = x => Object.is(x, -0) ? '-0' : String(x)
// Every export of `src` called with `args` at `optimize`, against Node, bit for bit.
const agreeAt = (src, optimize, argsOf) => {
  const want = oracle(src), got = jz(src, { optimize }).exports
  for (const [fn, args] of argsOf) for (const a of args)
    is(bits(got[fn](...a)), bits(want[fn](...a)), `${fn}(${a.map(bits).join(', ')}) at ${name(optimize)}`)
}

// 1e16 beside 1: an order that adds the ones together first keeps them
const SUMS = `const M = [1e-4, 0.001, 0.01, 0.1, 1, 10, 100, 1000, 10000]
const fill = (n, k) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = k === 0 ? (i % 4 === 0 ? 1e16 : i % 4 === 2 ? -1e16 : 1) : ((i * 7919) % 1013 - 506) / 37 * M[i % 9]; return a }
export let sum = (n, k) => { const a = fill(n, k); let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s }
export let dot = (n, k) => { const a = fill(n, k), b = fill(n, 1 - k); let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s }
export let squares = (n, k) => { const a = fill(n, k); let s = 0; for (let i = 0; i < n; i++) s += a[i] * a[i]; return Math.sqrt(s) }
export let product = (n, k) => { const a = fill(n, k); let p = 1; for (let i = 0; i < n; i++) p *= 1 + a[i] * 1e-17; return p }
export let f32sum = (n, k) => { const a = new Float32Array(fill(n, k)); let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s }
export let plain = (n, k) => { const a = [...fill(n, k)]; let s = 0; for (let i = 0; i < n; i++) s += a[i]; return s }`
const SIZES = [[8, 0], [9, 0], [17, 0], [64, 0], [65, 0], [8, 1], [33, 1], [64, 1], [1000, 1]]
const SUM_CALLS = ['sum', 'dot', 'squares', 'product', 'f32sum', 'plain'].map(fn => [fn, SIZES])

test('relaxedFloat: a loop\'s sum, dot and product are the left fold at every level but speed', () => {
  for (const optimize of EXACT) agreeAt(SUMS, optimize, SUM_CALLS)
})

test('relaxedFloat: speed is the relaxed build, by default and on request', () => {
  // the trade is real: in lanes the ones beside 1e16 are not lost
  const want = oracle(SUMS).sum(8, 0)
  is(want, 1, 'Node loses each one to 1e16')
  for (const optimize of ['speed', { relaxedFloat: true }]) ok(jz(SUMS, { optimize }).exports.sum(8, 0) !== want, `${name(optimize)} adds in lanes`)
})

// the maximum of +0 and -0 across two lanes: the scalar loop keeps the first it meets
const PEAK = `export let peak = (n, k) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = -1; a[k] = 0; a[1 - k] = -0; let m = -Infinity; for (let i = 0; i < n; i++) if (a[i] > m) m = a[i]; return 1 / m }`

test('relaxedFloat: a running maximum keeps the sign of the zero it met first', () => {
  for (const optimize of EXACT) agreeAt(PEAK, optimize, [['peak', [[2, 0], [2, 1], [9, 0], [64, 1]]]])
})

// a 4x4 product of which most terms do not change across rounds: summed in the order written
const MAT4 = `const mm = (a, b, out, iters) => {
  for (let n = 0; n < iters; n++) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; out[r * 4 + c] = s + n * 0.0000001 }
    const t = a[0]; a[0] = out[15]; a[5] = t + out[10] * 0.000001; b[0] += out[0] * 0.00000000001; b[5] -= out[5] * 0.00000000001
  }
}
export const mat = (iters) => {
  const a = new Float64Array(16), b = new Float64Array(16), out = new Float64Array(16)
  for (let i = 0; i < 16; i++) { a[i] = (i + 1) / 3; b[i] = (16 - i) / 7 }
  mm(a, b, out, iters | 0)
  return out[0] + out[5] + out[10] + out[15] + a[0] + a[5]
}`

test('relaxedFloat: a dot whose invariant terms the speed build hoists keeps their order', () => {
  for (const optimize of EXACT) agreeAt(MAT4, optimize, [['mat', [[1], [5], [40]]]])
})

const CONST = 'export let c = () => 0.1 + 0.2 - 0.3'

test('relaxedFloat: constant chains round per operation unless relaxedFloat or rationalConst says otherwise', () => {
  for (const optimize of [...EXACT, { level: 'speed', rationalConst: false }]) agreeAt(CONST, optimize, [['c', [[]]]])
  const rational = 2.7755575615628914e-17   // the exact 1/36028797018963968, rounded once
  for (const optimize of ['speed', { level: false, rationalConst: true }, { level: 'size', rationalConst: true }, { relaxedFloat: true }])
    is(jz(CONST, { optimize }).exports.c(), rational, `${name(optimize)} folds in rationals`)
})
