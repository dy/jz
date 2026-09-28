// An element store whose index the summary cannot bound (`out[k] = v` into an
// array that grew last round, `indices[k] = indices[k + 1]`) stores in place
// when the index is inside the length and asks the helper only past it: the
// helper's growth, its hole fill and its negative-index property write are
// unchanged (emit-assign.js storeArrayPayload).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const fnText = (text, name) => funcWat(text, name + '$exp') || funcWat(text, name)

const src = `const out = []
  export const fill = (n) => { for (let i = 0; i < n; i++) out[i] = i * 2; return out.length }
  export const at = (i) => out[i] === undefined ? -1 : out[i]
  export const shift = (n) => { for (let k = 0; k < n; k++) out[k] = out[k + 1]; return out[0] }
  export const gap = () => { const v = [1]; v[3] = 4; return v.length * 10 + (v[1] === undefined ? 1 : 0) }
  export const neg = () => { const v = [1, 2]; v[-1] = 9; return v.length * 10 + v[0] }`

test('index store: growth, in-place stores, holes and a negative index answer what the host answers', () => {
  for (const optimize of levels(0, 2, 3)) {
    const host = oracle(src), jz = run(src, { optimize })
    const steps = [['fill', 5], ['at', 3], ['at', 5], ['fill', 3], ['at', 4], ['shift', 4], ['at', 0], ['at', 3], ['fill', 8], ['at', 7], ['gap'], ['neg']]
    for (const [name, ...args] of steps) is(jz[name](...args), host[name](...args), `${name}(${args.join(', ')}) at ${optimize}`)
  }
})

test('index store: the in-range store is a plain store, the helper stands behind the bounds test', () => {
  if (belowOpt(2)) return
  const body = fnText(wat(src, { optimize: 2 }), 'fill')
  ok(/f64\.store/.test(body), 'the in-range arm stores directly')
  ok(/call \$__arr_set_idx_ptr/.test(body), 'the helper remains for an index at or past the end')
  ok(/i32\.lt_u/.test(body), 'one unsigned bounds test decides between them')
})
