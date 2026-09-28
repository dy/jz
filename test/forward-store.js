// Store-to-load forwarding and dead-store elimination in straight-line code
// (src/optimize/forward-store.js): a kernel that chains calls through an out
// parameter keeps its intermediate results in the locals that staged them, and the
// stores the chain overwrites go. What could alias, call, branch or loop between a
// store and a load keeps the memory round trip.
import test from 'tst'
import { is } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'

const chain = `const out = [0, 0, 0], a = [1, 2, 3], b = [4, 5, 6]
  const add = (o, x, y) => { o[0] = x[0] + y[0]; o[1] = x[1] + y[1]; o[2] = x[2] + y[2]; return o }
  const scale = (o, x, s) => { o[0] = x[0] * s; o[1] = x[1] * s; o[2] = x[2] * s; return o }
  export const f = (n) => { let acc = 0; for (let i = 0; i < n; i++) { add(out, a, b); scale(out, out, 0.5); acc += out[0] + out[2]; a[0] = acc * 1e-3 } return acc }`

test('store forwarding: a chain through an out parameter reloads nothing and keeps only the last stores', () => {
  for (const optimize of levels(0, 2, 3)) agree(chain, 'f', [7], { optimize }, `the chain at ${optimize}`)
  if (belowOpt(2)) return
  const text = wat(chain, { optimize: 3 })
  const body = funcWat(text, 'f$exp') || funcWat(text, 'f')
  const count = re => (body.match(re) || []).length
  is(count(/f64\.load/g) + 2 * count(/v128\.load/g), 6, 'the six loads of a and b; the scaled and summed values come from locals')
  // The added out[2] is overwritten unread and goes; out[0] and out[1] are followed by
  // loads of a and b, which may name the same array, so they stay.
  is(count(/f64\.store/g) + 2 * count(/v128\.store/g), 6, 'the three scaled stores, a[0], and the two added stores a later load may read')
})

const cases = [
  ['a store through another name between', `const x = [1, 2]
    const put = (o, p) => { o[0] = 1; p[0] = 2; return o[0] }
    export const f = () => put(x, x)`, []],
  ['a call between', `const x = [1, 2]
    let k = 0
    const bump = () => { k++; x[0] = k * 10 }
    const put = (o) => { o[0] = 1; bump(); return o[0] }
    export const f = () => put(x) + put(x)`, []],
  ['a conditional store between', `const x = [1, 2]
    const put = (o, c) => { o[0] = 1; if (c > 0) o[0] = 2; return o[0] }
    export const f = (c) => put(x, c)`, [1]],
  ['a load before the store in a loop body', `const o = [0]
    export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) { s += o[0]; o[0] = s + 1 } return s }`, [5]],
  ['the value local rewritten before the load', `const x = [0, 0]
    export const f = (n) => { let t = n; x[0] = t; t = t + 1; return x[0] + t }`, [3]],
  ['a slot read by a wider access between two stores', `const x = new Float64Array(2), v = new Float64Array(x.buffer)
    export const f = () => { x[0] = 1; const r = v[0]; x[0] = 2; return r + x[0] }`, []],
]

test('store forwarding: what could alias, call or branch keeps the round trip', () => {
  for (const [name, src, args] of cases)
    for (const optimize of levels(0, 2, 3)) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
})
