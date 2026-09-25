// The shared watr pass defers expensive pure initializers to exclusive arms.
// Its trap/effect/alias proofs are tested in watr; these pin JS lowering and tiering.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, levels } from './_matrix.js'
import { oracle } from './util.js'

const POLY = '(((((x + 1) * x + 2) * x + 3) * x + 4) * x + 5) * x + 6'
const SRC = `export const f = (x, a, b) => {
  const v = ${POLY}
  const z = a > 0 ? v : b > 0 ? 0 - v : 7
  return z * z
}`
const OFF = { level: 'speed', watr: { lazySelect: false } }

test('lazy select: expensive arithmetic moves inside exclusive branches', () => {
  if (!onKernel()) {
    const on = compile(SRC, { optimize: 'speed', wat: true })
    const off = compile(SRC, { optimize: OFF, wat: true })
    ok(on !== off, 'the packaged watr optimizer performs the rewrite')
    ok(on.includes('(if') && on.indexOf('(if') < on.indexOf('(f64.add'), 'arithmetic starts inside a chosen arm')
    ok(off.includes('(select') && !off.includes('(if'), 'the baseline evaluates both value arms')
  }
  const native = oracle(SRC).f
  for (const optimize of ['speed', OFF]) {
    const f = jz(SRC, { optimize }).exports.f
    for (const x of [0, -0, 0.2, 0.2, -0.7, 0.2, Number.MIN_VALUE, Number.MAX_VALUE, Infinity, -Infinity, NaN])
      for (const a of [-1, 0, 1, NaN]) for (const b of [-1, 0, 1, NaN])
        ok(Object.is(f(x, a, b), native(x, a, b)), `${optimize}: f(${x}, ${a}, ${b})`)
  }
})

test('lazy select: default and size tiers retain their output', () => {
  if (onKernel()) return
  for (const level of [2, 'size'])
    is(compile(SRC, { optimize: level, wat: true }),
      compile(SRC, { optimize: { level, watr: { lazySelect: false } }, wat: true }), `${level}`)
})

test('lazy select: zero-work loops and input writes preserve the recurrence', () => {
  const src = `export const f = (x, a, n) => {
    let sum = 9
    for (let i = 0; i < n; i++) {
      const v = ${POLY}
      x += 0.1
      const z = a > i ? v : 7
      sum += z * x
    }
    return sum
  }`
  const native = oracle(src).f
  for (const optimize of levels(0, 1, 2, 'speed', 'size', OFF)) {
    const f = jz(src, { optimize }).exports.f
    for (const args of [[0.2, 1, 0], [0.2, 1, 1], [0.2, 1, 1], [-0.7, 2, 3], [1, 0, 3], [0.2, 1, 0]])
      is(f(...args), native(...args), `${optimize}: f(${args})`)
  }
})
