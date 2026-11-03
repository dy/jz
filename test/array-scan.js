// A loop from a constant start under the array's own length is in bounds
// (type/canonical-bounds.js scanBoundedArrIdx): the start may be any constant
// expression (`N + 1` of a module constant), not only a literal, and the loop
// answers what the host answers whatever the length.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'

const src = `
const N = 2
const build = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a }
// every slot of an array as one number: a hole, NaN and a string each marked apart
const digest = (a) => {
  let h = a.length
  for (let i = 0; i < a.length; i++) {
    const v = a[i]
    h = (h * 31 + (v === undefined ? 7 : typeof v === 'string' ? v.length * 1000 : v !== v ? 13 : v)) | 0
  }
  return h
}
const fromN = (a) => { for (let i = N + 1; i < a.length; i++) a[i] = a[i] + 1; return a }
export const from = (len) => digest(fromN(build(len)))`

test('array scan: a constant-start loop answers what the host answers', () => {
  const host = oracle(src)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const jz = run(src, { optimize })
    for (const len of [0, 2, 3, 6]) is(jz.from(len), host.from(len), `from(${len}) at ${optimize}`)
  }
})

const shape = { sourceInline: false, watr: false }   // (each kernel a function of its own)

test('array scan: a constant start under the length is in bounds', () => {
  if (belowOpt(2)) return
  for (const level of [2, 'speed']) {
    const body = funcWat(wat(src, { optimize: { level, ...shape } }), 'fromN')
    ok(/f64\.store/.test(body) && !/\$__arr_set_idx_ptr/.test(body), `fromN at ${level}: stores in place, nothing grows`)
  }
})
