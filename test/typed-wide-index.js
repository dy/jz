import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle, wat, funcWat } from './util.js'
import { belowOpt, levels, onKernel } from './_matrix.js'
import { ctx } from '../src/ctx.js'
import { emitIndex } from '../src/compile/emit/dispatch.js'
import encodeWat from 'watr/compile'

const WORDS = [-2147483648, -715827883, -1, -0, 0, 1, 2, 715827883, 2147483647, 2147483648, 4294967295]
const compare = (src, inputs) => {
  const actual = run(src), expected = oracle(src)
  for (const args of inputs) is(actual.f(...args), expected.f(...args), args.join(', '))
}

test('typed indices: implicit undefined survives conditional assignments and reuse', () => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    for (const ctor of ['Float32Array', 'Float64Array', 'Int32Array', 'Uint32Array', 'Array']) {
      const source = `export function f(mode) {
        const a = ${ctor === 'Array' ? '[2, 3]' : `new ${ctor}([2, 3])`}
        let index
        if (mode) index = 0
        const before = a[index]
        let effects = 0
        const assigned = a[index] = (effects++, 19)
        return [before, assigned, a[0], a[index], effects]
      }`
      const actual = run(source, { optimize }), expected = oracle(source)
      for (const mode of [0, 0, 1, 0, 2, 1, 0])
        is(actual.f(mode), expected.f(mode), `${ctor}, ${optimize}, mode=${mode}`)
    }
  }
})

test('typed indices: assignment paths retain absence and total assignments', () => {
  const bodies = [
    'let x; if (mode) x = 0; return a[x]',
    'let x; if (mode) x = 0; else x = 1; return a[x]',
    'let x; if (!mode) return 7; x = 0; return a[x]',
    'let x; for (let i = 0; i < mode; i++) x = 0; return a[x]',
    'let x; try { if (!mode) throw 1; x = 0 } catch (e) {} return a[x]',
    'let x; const assign = () => { x = 0 }; if (mode) assign(); return a[x]',
    'let sum = 0; for (let i = 0; i < 3; i++) { let x; if (mode || i === 0) x = 0; sum += a[x] } return sum',
  ]
  for (const optimize of levels(0, 1, 2, 3, 'size')) for (const body of bodies) {
    const source = `export function f(mode) { const a = new Float32Array([2, 3]); ${body} }`
    const actual = run(source, { optimize }), expected = oracle(source)
    for (const mode of [0, 0, 1, 3, 0])
      is(actual.f(mode), expected.f(mode), `${optimize}, mode=${mode}: ${body}`)
  }
})

test('captured integer cells: absence and magnitude survive uncalled and repeated writers', () => {
  const bodies = [
    'let x; const set = () => { x = 0 }; if (mode) set(); return x',
    'let x = 4294967296; const set = () => { x = 4294967296 }; if (mode) set(); return x',
    'let x = 2147483647; const step = () => { x++ }; for (let i = 0; i < mode; i++) step(); return x',
    'let x = 0; const set = () => { x = -1 * x }; if (mode) set(); return x',
    'let x = 2147483647; const step = () => { x = (x + 1) | 0 }; for (let i = 0; i < mode; i++) step(); return x',
  ]
  for (const optimize of levels(0, 1, 2, 3, 'size')) for (const body of bodies) {
    const source = `export function f(mode) { ${body} }`
    const actual = run(source, { optimize }), expected = oracle(source)
    for (const mode of [0, 0, 1, 2, 0])
      is(Object.is(actual.f(mode), expected.f(mode)), true, `${optimize}, mode=${mode}: ${body}`)
  }
})

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


test('typed bounded index: occurrence proofs keep the full unsigned address word', () => {
  if (onKernel()) return
  const emitters = ctx.core.emit
  try {
    ctx.core.emit = {}
    const value = Object.assign(['block', ['result', 'f64'],
      ['global.set', '$calls', ['i32.add', ['global.get', '$calls'], ['i32.const', 1]]],
      ['local.get', '$x']], { type: 'f64' })
    const bounded = emitIndex(value, true, false, true), unbounded = emitIndex(value, true)
    is(bounded[0], 'i32.wrap_i64', 'the whole and extent proofs preserve upper-half address bits')
    is(unbounded[0], 'i32.trunc_sat_f64_s', 'whole alone does not authorize wrapping a wide key')
    const module = ['module', ['global', '$calls', ['mut', 'i32'], ['i32.const', 0]],
      ['func', '$f', ['export', '"f"'], ['param', '$x', 'f64'], ['result', 'i32'], bounded],
      ['func', ['export', '"calls"'], ['result', 'i32'], ['global.get', '$calls']]]
    const actual = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(module))).exports
    let calls = 0
    for (const x of [0, -0, 1, 2147483647, 2147483648, 4294967294, 4294967295, 0]) {
      is(actual.f(x), x | 0, `address ${x}`)
      is(actual.calls(), ++calls, 'the original value executes once')
    }
  } finally { ctx.core.emit = emitters }
})

test('typed bounded index: offset windows preserve checked twins and view stores', () => {
  const source = `export function f(offset, end, len) {
    const storage = new Float64Array(len + 4), values = storage.subarray(2, len + 2)
    for (let i = 0; i < storage.length; i++) storage[i] = i + 0.5
    let sum = 0, effects = 0
    for (let i = 0; i + offset < end; i++) {
      sum += values[i + offset]
      values[i + offset] = (effects++, i + 10)
    }
    return [sum, effects, storage, values[offset]]
  }`
  const inputs = [-Infinity, -2147483648, -1, -0, 0, Number.MIN_VALUE, 0.5, 1, 6, 8,
    2147483647, 2147483648, 4294967294, 4294967295, 4294967296, 9007199254740991, Infinity, NaN]
    .flatMap(offset => [0, 1, 8].map(len => [offset, offset + 2, len]))
  const expected = oracle(source)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(source, { optimize })
    for (const args of [...inputs, [0, 2, 8], [0, 2, 8], [6, 8, 8], [0, 0, 0], [0, 2, 8]])
      is(actual.f(...args), expected.f(...args), `${optimize}: ${args.join(', ')}`)
  }
})

test('typed bounded index: index effects and replacement do not inherit a loop proof', () => {
  const source = `export function f(offset, end, replace) {
    let values = new Float64Array([2, 3, 5, 7]), effects = 0, sum = 0
    const original = values
    for (let i = 0; i + offset < end; i++) {
      sum += values[(effects++, i + offset)]
      values[(effects++, i + offset)] = (effects++, replace ? (values = new Float64Array(0), 11) : 13)
    }
    return [sum, effects, original, values, values[offset]]
  }`
  const expected = oracle(source)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(source, { optimize })
    for (const offset of [-2147483648, -1, -0, 0, 0.5, 3, 2147483647, 4294967295, 4294967296])
      for (const replace of [false, true, false])
        is(actual.f(offset, offset + 2, replace), expected.f(offset, offset + 2, replace), `${optimize}, ${offset}, replace=${replace}`)
  }
})
