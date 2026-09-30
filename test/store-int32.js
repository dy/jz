// An integer element store converts its value with exact ToInt32 (src/ir/numeric.js
// toInt32). The range query sees through the emitter's value block, so a checked element
// read copied to another array converts inline (optimize/peephole.js, f64Range's block
// case); a loop-carried local every write of which has a range of its own has their
// hull (boundedFloatLocal); and the unknown tail converts inline below 2^63, calling the
// kernel only for the infinities and the values beyond. Every value is a differential
// against the host: a missing element stores 0, a huge value its low word.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { agree, wat } from './util.js'
import { belowOpt } from './_matrix.js'

// The kernel is the module's only user code: the counts are over the module. The
// shapes hold once the optimizer ran; every leg runs the differentials.
const calls = (text, name) => (text.match(new RegExp(`\\(call \\$${name}[\\s)]`, 'g')) || []).length
const shapes = (src, check) => { if (!belowOpt(2)) check(wat(src)) }

test('store-int32: a checked element read stored to an integer array', () => {
  const src = `function copy(dst, src, n) {
  let k = 0
  for (let i = 0; i < n; i++) { dst[k * 3] = src[i * 3]; dst[k * 3 + 1] = src[i * 3 + 1]; k++ }
  return k
}
export function f(n, m) {
  const src = new Int32Array(n * 3), dst = new Int32Array(m * 3)
  for (let i = 0; i < src.length; i++) src[i] = i * 7 - 40
  dst.fill(-1)
  copy(dst, src, m)
  let s = 0
  for (let i = 0; i < dst.length; i++) s = (s * 31 + dst[i]) | 0
  return s
}`
  shapes(src, w => is(calls(w, '__to_int32'), 0, 'the store converts inline'))
  // m > n reads past src: undefined stores 0
  for (const [n, m] of [[0, 0], [1, 1], [5, 5], [5, 8], [3, 0]]) agree(src, 'f', [n, m])
})

test('store-int32: a loop-carried local stepped by element reads', () => {
  const src = `function walk(next, out, n) {
  for (let e = 0; e < n; e++) {
    let last = e
    for (let other = next[e]; other !== -1; other = next[other]) last = other
    out[e] = last - last % 3
  }
}
export function f(n) {
  const next = new Int32Array(n), out = new Int32Array(n)
  for (let i = 0; i < n; i++) next[i] = i > 5 ? i - 5 : -1
  walk(next, out, n)
  let s = 0
  for (let i = 0; i < n; i++) s = (s * 31 + out[i]) | 0
  return s
}`
  shapes(src, w => is(calls(w, '__to_int32'), 0, 'the stores convert inline: the local has the hull of its element kind'))
  for (const n of [0, 1, 2, 5, 20]) agree(src, 'f', [n])
})

test('store-int32: an unknown value converts inline below 2^63 and through the kernel beyond', () => {
  const src = `export function f(v) { const a = new Int32Array(2); a[0] = v; a[1] = -v; return a[0] * 3 + a[1] }`
  // The emitter puts the fast arm first; late lowering puts the slow arm first.
  shapes(src, w => ok(/\(f64\.(?:lt|ge)\s*\(f64\.abs/.test(w) && calls(w, '__to_int32') >= 1, 'the kernel stays behind the magnitude guard'))
  const VALUES = [0, 1, -1, 1.5, -1.5, 2147483647, 2147483648, -2147483649, 4294967296.5, 1e20, -1e20,
    2 ** 53 + 2, 2 ** 63 - 1024, -(2 ** 63 - 1024), 2 ** 63, -(2 ** 63), 2 ** 63 + 4096, 2 ** 84, 2 ** 84 + 2 ** 40, NaN, Infinity, -Infinity, -0]
  for (const v of VALUES) agree(src, 'f', [v])
})
