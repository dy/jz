// A strict equality whose operands the summary holds to numbers or missing
// values (an element read a parameter array may not hold) compares inline: a
// bit-equal pair is equal unless it is the NaN, else the numbers decide. The
// helper's kind dispatch is for operands that may be strings or objects.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const fnText = (text, name) => funcWat(text, name + '$exp') || funcWat(text, name)

const src = `const A = [1, 2, NaN, -0, 5], B = [1, 3, NaN, 0]
  const same = (a, b, i, j) => a[i] === b[j]
  const differ = (a, b, i, j) => a[i] !== b[j]
  export const f = (i, j) => same(A, B, i, j) ? 1 : 0
  export const g = (i, j) => differ(A, B, i, j) ? 1 : 0`

// [i, j, why]
const pairs = [
  [0, 0, 'equal numbers'], [1, 1, 'different numbers'], [2, 2, 'the NaN against itself'],
  [3, 3, '-0 against 0'], [9, 9, 'two reads past the end'], [9, 0, 'a read past the end against a number'],
  [4, 9, 'a number against a read past the end'], [2, 9, 'the NaN against a read past the end'],
]

test('number equality: every pair answers what the host answers', () => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const wasm = run(src, { optimize })
    for (const [i, j, why] of pairs) {
      is(wasm.f(i, j), host.f(i, j), `=== ${why} at ${optimize}`)
      is(wasm.g(i, j), host.g(i, j), `!== ${why} at ${optimize}`)
    }
  }
})

test('number equality: the compare is inline, the helper is not called', () => {
  const text = wat(src, { optimize: 2 })
  ok(!/call \$__eq_strict/.test(text), 'no strict-equality helper call in the module')
  const body = fnText(text, 'f')
  ok(/f64\.eq/.test(body), 'the numbers compare as f64')
})

test('number equality: missing-only and nullish operands preserve all four comparisons', () => {
  const code = `const bytes = new Uint8Array([1, 2])
    const floats = new Float64Array([NaN, -0, 1])
    const mixed = [1, null, undefined, NaN, -0]
    const holes = [1, , 2]
    ${['bytes', 'floats', 'mixed', 'holes'].flatMap((a, i) =>
      ['bytes', 'floats', 'mixed', 'holes'].map((b, j) => `
        export let f${i}${j} = (i, j) => {
          const x = ${a}[i | 0], y = ${b}[j | 0]
          return (x === y ? 1 : 0) | (x !== y ? 2 : 0) | (x == y ? 4 : 0) | (x != y ? 8 : 0)
        }`)).join('\n')}`
  const host = oracle(code)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const wasm = run(code, { optimize })
    for (const name of Object.keys(host)) for (let i = -1; i < 6; i++) for (let j = -1; j < 6; j++)
      is(wasm[name](i, j), host[name](i, j), `${name}(${i}, ${j}) at ${optimize}`)
  }
})

test('number equality: operands evaluate once in order before the missing comparison', () => {
  const code = `const a = new Float64Array([NaN, -0, 1]); let trace = 0
    const left = i => { trace = trace * 10 + 1; return a[i] }
    const right = i => { trace = trace * 10 + 2; return a[i] }
    export let f = (i, j) => { trace = 0; const same = left(i|0) === right(j|0); return trace * 10 + (same ? 1 : 0) }`
  const host = oracle(code)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const wasm = run(code, { optimize })
    for (const [i, j] of [[0, 0], [1, 1], [2, 2], [5, 5], [5, 2]])
      is(wasm.f(i, j), host.f(i, j), `once and in order at ${optimize}`)
  }
})

test('number equality: numeric reads test undefined without a null comparison', () => {
  const text = wat(`const a = new Float64Array([1, NaN])
    export let f = (i, j) => a[i|0] === a[j|0] ? 1 : 0`, { optimize: 0 })
  const body = funcWat(text, 'f')
  ok(/f64\.eq/.test(body), 'NaN still compares as a number')
  is((body.match(/i64\.eq/g) || []).length, 2, 'one undefined check per operand')
})
