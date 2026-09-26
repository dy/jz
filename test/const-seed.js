// Integer-constant seeding of local bindings (analyze-for-emit.js
// seedLocalIntConsts): a name declared more than once is one constant only
// when every declaration evaluates to the same value.
import test from 'tst'
import { levels } from './_matrix.js'
import { agree } from './util.js'

// The O1/O2 scalar unroller copies a loop body per iteration under its own
// names: each copy's `const sb = s * 4` binds its own value, so the integer
// constant seeder (analyze-for-emit.js) must not fold every `sb` to the first.
test('const seed: same-named const bindings in copied bodies keep their own values', () => {
  const src = `export let f = (n) => {
    const st = new Float64Array(16); let r = 0
    for (let s = 0; s < 2; s++) { const sb = s * 4; st[sb + 2] = n + s }
    for (let s = 0; s < 2; s++) { const sb = s * 4; r += st[sb + 2] * (s + 1) }
    return r
  }`
  for (const optimize of levels(0, 1, 2, 3, 'size')) agree(src, 'f', [3], { optimize }, `sibling copies at ${optimize}`)
})
