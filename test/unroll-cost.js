// Small-constant loop unrolling measures a copy with its counter substituted
// (emit/control-flow.js foldedBodyCost): index arithmetic over the counter
// folds to literals, so it does not count against the copy budget.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'
import parseWat from 'watr/parse'

// How many times a literal only the loop body holds is emitted: copies × loop versions.
const copies = (src, name, literal) => (funcWat(wat(src, { optimize: 3 }), name).match(new RegExp(`f64\\.const ${literal.replace('.', '\\.')}\\b`, 'g')) || []).length

// A cascade whose stage loop is addressing over the counter: eight copies of
// the folded body fit the budget, the rolled body does not.
const cascade = `export let f = (n) => {
  const x = new Float64Array(n), c = new Float64Array(40), st = new Float64Array(32), out = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = (i % 7) / 7 - 0.5
  for (let i = 0; i < 40; i++) c[i] = 0.1 + i * 0.001
  for (let i = 0; i < n; i++) {
    let v = x[i]
    for (let s = 0; s < 8; s++) {
      const k = s * 5, sb = s * 4
      const b0 = c[k + 0], b1 = c[k + 1], b2 = c[k + 2], a1 = c[k + 3], a2 = c[k + 4]
      const x1 = st[sb + 0], x2 = st[sb + 1], y1 = st[sb + 2], y2 = st[sb + 3]
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2 + 1.5e-300
      st[sb + 0] = v; st[sb + 1] = x1; st[sb + 2] = y; st[sb + 3] = y1
      v = y
    }
    out[i] = v
  }
  let h = 0
  for (let i = 0; i < n; i++) h += out[i] * (i + 1)
  return h
}`

// The same trip count over a body the counter barely touches: eight copies of
// 150 live nodes stay a loop.
const heavy = `export let f = (n) => {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let v = i * 0.25, acc = 0
    for (let s = 0; s < 8; s++) {
      const t = v + s
      const p = t * t * 0.5 - t * 0.25 + 1
      const q = p * p * 0.125 - p * 0.375 + t * 2.5 - 0.75
      const r = q * q * 0.0625 - q * 0.1875 + p * 1.25 - t * 0.5 + 0.125
      const u = r * r * 0.03125 - r * 0.09375 + q * 0.625 - p * 0.25 + t * 0.0625
      const w = u * u * 0.015625 - u * 0.046875 + r * 0.3125 - q * 0.125 + p * 0.03125 - t * 0.5
      acc += (w + u * 0.5 + r * 0.25 + q * 0.125 + p * 0.0625) / (1 + t * t)
      v = v * 0.5 + acc * 0.001
    }
    out[i] = acc
  }
  let h = 0
  for (let i = 0; i < n; i++) h += out[i] * (i + 1)
  return h
}`

test('unroll cost: a stage loop of counter addressing unrolls', () => {
  ok(copies(cascade, 'f', '1.5e-300') >= 8, 'eight copies of the stage body')
  for (const optimize of levels(0, 2, 3, 'size')) agree(cascade, 'f', [64], { optimize }, `cascade at ${optimize}`)
})

test('unroll cost: a large body the counter barely touches stays rolled', () => {
  // Source and IR specialization can each copy the outer loop. The costly
  // stage body must remain in its own loop in every copy, not just one.
  const depths = []
  const visit = (n, depth = 0) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'loop') depth++
    if (n[0] === 'f64.const' && Number(n[1]) === 0.015625) depths.push(depth)
    for (const child of n) visit(child, depth)
  }
  visit(parseWat(funcWat(wat(heavy, { optimize: 3 }), 'f')))
  ok(depths.length > 0 && depths.every(depth => depth >= 2), 'every stage body stays in its inner loop')
  for (const optimize of levels(0, 2, 3, 'size')) agree(heavy, 'f', [16], { optimize }, `heavy at ${optimize}`)
})
