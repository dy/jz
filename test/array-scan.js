// A loop from a constant start under the array's own length is in bounds
// (type/canonical-bounds.js scanBoundedArrIdx): the start may be any constant
// expression (`N + 1` of a module constant), not only a literal; so is one
// under a bound a constant declared before it holds below the lengths. Each
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

// A bound a constant declared before the loop holds below the lengths
// (`const n = a.length`, a `Math.min` of several) proves the loop in bounds as
// a bound of `a.length` itself does, while nothing between shrinks an array:
// a `pop` between keeps the loop as written.
const declared = `const build = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a }
  const digest = (a) => { let h = a.length; for (let i = 0; i < a.length; i++) h = (h * 31 + (a[i] === undefined ? 7 : a[i] !== a[i] ? 13 : a[i])) | 0; return h }
  const bumpN = (a) => { const n = a.length; for (let i = 0; i < n; i++) a[i] = a[i] + 1; return a }
  const sum2 = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) a[i] = a[i] + b[i]; return a }
  const shrunk = (a) => { const n = a.length; a.pop(); for (let i = 0; i < n; i++) a[i] = a[i] + 1; return a }
  export const one = (len) => digest(bumpN(build(len))) + digest(bumpN(build(len + 1)))
  export const two = (la, lb) => digest(sum2(build(la), build(lb))) + digest(sum2(build(lb), build(la)))
  export const three = (len) => digest(shrunk(build(len))) + digest(shrunk(build(len + 1)))`

test('array scan: a bound declared before the loop', () => {
  const host = oracle(declared)
  for (const optimize of levels(0, 2, 3, 'size')) {
    const jz = run(declared, { optimize })
    for (const len of [0, 1, 4]) {
      is(jz.one(len), host.one(len), `one(${len}) at ${optimize}`)
      is(jz.three(len), host.three(len), `three(${len}) at ${optimize}`)
      for (const lb of [0, 2, 6]) is(jz.two(len, lb), host.two(len, lb), `two(${len}, ${lb}) at ${optimize}`)
    }
  }
  if (belowOpt(2)) return
  for (const level of [2, 'speed']) {
    const text = wat(declared, { optimize: { level, ...shape } })
    for (const name of ['bumpN', 'sum2']) ok(!/\$__arr_set_idx_ptr/.test(funcWat(text, name)), `${name} at ${level}: in bounds, nothing grows`)
    ok(/\$__arr_set_idx_ptr/.test(funcWat(text, 'shrunk')), `shrunk at ${level}: a pop between keeps the growth call`)
  }
})

test('array scan: a constant start under the length is in bounds', () => {
  if (belowOpt(2)) return
  for (const level of [2, 'speed']) {
    const body = funcWat(wat(src, { optimize: { level, ...shape } }), 'fromN')
    ok(/f64\.store/.test(body) && !/\$__arr_set_idx_ptr/.test(body), `fromN at ${level}: stores in place, nothing grows`)
  }
})
