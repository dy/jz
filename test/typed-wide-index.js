import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle, wat, funcWat } from './util.js'
import { belowOpt, levels } from './_matrix.js'

const WORDS = [-2147483648, -715827883, -1, -0, 0, 1, 2, 715827883, 2147483647, 2147483648, 4294967295]
const compare = (src, inputs) => {
  const actual = run(src), expected = oracle(src)
  for (const args of inputs) is(actual.f(...args), expected.f(...args), args.join(', '))
}

test('typed wide index: scaled gathers compare the full integer before addressing', () => {
  for (const ctor of ['Int32Array', 'Uint32Array']) compare(`export function f(n, len) {
    const indices = new ${ctor}(1); indices[0] = n
    const values = new Float32Array(len)
    for (let i = 0; i < len; i++) values[i] = i + 0.25
    const x = indices[0]
    return [values[x * 6], values[x * 6 + 1], values[x * 6 + 2], values[x * 6 - 2]]
  }`, WORDS.flatMap(n => [0, 1, 8, 15].map(len => [n, len])))

  if (belowOpt(2)) return
  const text = wat(`export function f(a, b) {
    if (!(a instanceof Int32Array) || !(b instanceof Float32Array)) throw 1
    let s = 0
    for (let i = 0; i < a.length; i++) {
      const x = a[i]
      s += b[x * 6] + b[x * 6 + 1] + b[x * 6 + 2]
    }
    return s
  }`)
  const body = funcWat(text, 'f') || funcWat(text, 'f$exp')
  ok(body.includes('i64.lt_u'), 'bounds compare the wide key against the unsigned length')
  ok(!body.includes('i64.gt_s') && !body.includes('i64.lt_s'), 'scaled keys need no signed clamps')
})

test('typed wide index: writes retain their key and run the RHS on rejected indices', () => {
  for (const ctor of ['Int32Array', 'Uint32Array']) compare(`export function f(n, len) {
    const indices = new ${ctor}(1); indices[0] = n
    let values = new Float64Array(len), effects = 0, x = indices[0]
    const original = values
    for (let i = 0; i < len; i++) values[i] = i + 0.5
    const assigned = values[x * 6 + 1] = (x = 0, effects++, values = new Float64Array(2), 19)
    return [assigned, effects, x, original, values]
  }`, WORDS.flatMap(n => [0, 1, 8, 15].map(len => [n, len])))
})

test('typed wide index: calls and key updates execute once in source order', () => {
  compare(`let calls = 0
  function pick(n) { calls++; return n | 0 }
  export function f(n, len) {
    const before = calls, values = new Float64Array(len)
    for (let i = 0; i < len; i++) values[i] = i + 0.5
    let x = pick(n)
    const read = values[x * 6 + 1]
    const assigned = values[x * 6 + 1] = (x = pick(0), 23)
    const tee = values[(x = pick(n)) * 6 + 1]
    return [read, assigned, tee, values, calls - before]
  }`, WORDS.flatMap(n => [0, 1, 8, 15].map(len => [n, len])))
})

test('typed wide index: absent, fractional and rounded keys keep element semantics', () => {
  compare(`export function f(n, len) {
    const values = new Float64Array(len)
    for (let i = 0; i < len; i++) values[i] = i + 0.5
    const indices = new Int32Array([1])
    const x = indices[n]
    const before = [values[n * 6], values[x * 6]]
    values[n * 6] = 19; values[x * 6] = 23
    return [before, values]
  }`, [-Infinity, -2147483648, -1, -0, 0, Number.MIN_VALUE, 1 / 12, 1 / 6, 0.5, 1,
    2147483647, 4294967296, 9007199254740991, Infinity, NaN].flatMap(n => [0, 1, 8].map(len => [n, len])))
  compare(`export function f(n) {
    const indices = new Uint32Array([n]), values = new Float64Array([7, 11, 13])
    const x = indices[0], key = (x * 2097153 - x * 2097152) - x
    const before = values[key]
    values[key] = 19
    return [key, before, values]
  }`, WORDS.map(n => [n]))
})

test('typed wide index: views, missing receivers and throwing values keep their boundaries', () => {
  compare(`function fail() { throw 7 }
  export function f(n, len, missing) {
    const indices = new Int32Array([n]), x = indices[0]
    const storage = new Float64Array(len + 4)
    for (let i = 0; i < storage.length; i++) storage[i] = i + 0.5
    const view = new Float64Array(storage.buffer, 16, len)
    const values = missing ? null : view
    let effects = 0, caught = 0
    try { values[x * 6 + 1] = (effects++, 19) } catch (e) { caught++ }
    try { values[x * 6 + 1] = (effects++, fail()) } catch (e) { caught++ }
    return [storage, view[x * 6 + 1], effects, caught]
  }`, WORDS.flatMap(n => [0, 1, 8].flatMap(len => [[n, len, false], [n, len, true]])))
})


test('typed wide index: nested misses and a wide RHS preserve the original store key', () => {
  for (const ctor of ['Int32Array', 'Uint32Array']) {
    const source = `export function f(n, innerLen, outerLen) {
      const words = new ${ctor}(1); words[0] = n
      const indices = new Int32Array(innerLen), values = new Float64Array(outerLen)
      for (let i = 0; i < innerLen; i++) indices[i] = i % 3
      for (let i = 0; i < outerLen; i++) values[i] = i + 0.5
      let x = words[0], effects = 0
      const before = values[indices[x * 6]]
      const assigned = values[indices[x * 6]] = (effects++, x = -x, values[indices[x * 6 + 1]])
      return [before, assigned, effects, x, values]
    }`
    const expected = oracle(source)
    for (const optimize of levels(0, 1, 2, 3, 'size')) {
      const actual = run(source, { optimize })
      for (const n of WORDS) for (const innerLen of [0, 1, 8]) for (const outerLen of [0, 1, 8]) {
        const got = actual.f(n, innerLen, outerLen)
        is(got, expected.f(n, innerLen, outerLen), `${ctor} ${n}, lengths ${innerLen}/${outerLen}, ${optimize}`)
        is(got[2], 1, 'the RHS executes once even when either index read misses')
      }
    }
  }
})
