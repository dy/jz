// A strict equality whose operands the summary holds to numbers or missing
// values (an element read a parameter array may not hold) compares inline: a
// bit-equal pair is equal unless it is the NaN, else the numbers decide. The
// helper's kind dispatch is for operands that may be strings or objects.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'

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
  for (const optimize of levels(0, 2, 3))
    for (const [i, j, why] of pairs) { agree(src, 'f', [i, j], { optimize }, `=== ${why} at ${optimize}`); agree(src, 'g', [i, j], { optimize }, `!== ${why} at ${optimize}`) }
})

test('number equality: the compare is inline, the helper is not called', () => {
  const text = wat(src, { optimize: 2 })
  ok(!/call \$__eq_strict/.test(text), 'no strict-equality helper call in the module')
  const body = fnText(text, 'f')
  ok(/f64\.eq/.test(body), 'the numbers compare as f64')
})
