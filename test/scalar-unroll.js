// A loop is copied out for a small typed array only when its counter reaches
// an element index of that array (compile/plan/literals.js indexesByCounter):
// the copies are what makes the index a literal. A loop whose counter reaches
// none stays a loop, whatever it holds.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, wat } from './util.js'

// Passes over a scratch array of 24: the pass counter indexes nothing, and the
// loops that do index run too long to copy.
const passes = (bound) => `const run = (pts, u, out, n, m) => {
  for (let it = 0; it < ${bound}; it++) {
    for (let r = 0; r < n; r++) {
      u[0] = 0
      for (let i = 1; i < 24; i++) u[i] = u[i - 1] + pts[r * 24 + i] * 0.5
      out[r] += u[23] * (r + 1)
    }
  }
}
export let f = (n) => {
  const pts = new Float64Array(24 * 8), u = new Float64Array(24), out = new Float64Array(200)
  for (let i = 0; i < 24 * 8; i++) pts[i] = (i % 13) * 0.25 + n
  run(pts, u, out, 8, n > 1e300 ? 5 : 6)   // a count only the run decides
  let h = 0
  for (let r = 0; r < 8; r++) h += out[r]
  return h
}`

// Stages over a state array of 4, the counter the index, through a const as well.
const stages = (bound) => `const run = (st, tap, out, n, m) => {
  for (let k = 0; k < n; k++) {
    let y = k * 0.125
    for (let s = 0; s < ${bound}; s++) { const j = s * 2; st[s] = st[s] * 0.5 + y; tap[j] = st[s]; tap[j + 1] = y; y = st[s] * 0.25 }
    out[k] = y + tap[7]
  }
}
export let f = (n) => {
  const st = new Float64Array(4), tap = new Float64Array(8), out = new Float64Array(64)
  run(st, tap, out, 64, n > 1e300 ? 3 : 4)   // a count only the run decides
  let h = st[0] + st[3] + tap[6]
  for (let k = 0; k < 64; k++) h += out[k] * (k + n)
  return h
}`

const agrees = (src, label) => {
  const host = oracle(src).f
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const f = jz(src, { optimize }).exports.f
    for (const n of [0, 1, 2.5, -3]) ok(Object.is(f(n), host(n)), `${label}, f(${n}) at ${optimize}: ${f(n)} for ${host(n)}`)
  }
}
// The emitter's own unroll of a small counted loop is off: the count is the plan's.
const loops = (src, level) => (wat(src, { optimize: { level, smallConstForUnroll: false } }).match(/\(loop/g) || []).length

test('scalar unroll: passes over a scratch array agree with JS', () => agrees(passes('6'), 'passes'))
test('scalar unroll: stages over a state array agree with JS', () => agrees(stages('4'), 'stages'))

test('scalar unroll: a counter that indexes nothing copies nothing', () => {
  if (belowOpt(2)) return
  for (const optimize of [2, 3])
    ok(loops(passes('6'), optimize) === loops(passes('m'), optimize), `a constant pass count makes the loops of a variable one at ${optimize}`)
})

test('scalar unroll: a counter that indexes the array still copies', () => {
  if (belowOpt(2)) return
  for (const optimize of [2, 3])
    ok(loops(stages('4'), optimize) < loops(stages('m'), optimize), `the stage loop is written out at ${optimize}`)
})

test('scalar unroll: a literal a written-out loop body declares reads its own counter', () => {
  // the field locals took the values the census read, the counter unreplaced (0 in every copy)
  const src = `export let run = (q) => { let s = 0; for (let i = 0; i < 3; i++) { let d = { a: (0.5 + i) / q, b: i }, a = d.a; s += a + d.b } return s }`
  const host = oracle(src).run
  for (const optimize of levels(0, 2, 3)) is(jz(src, { optimize }).exports.run(3), host(3), `run(3) at ${optimize}`)
})
