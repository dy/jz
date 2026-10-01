import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle } from './util.js'
import { levels, onKernel } from './_matrix.js'
import { parse, loopCount } from '../scripts/wat-probe.mjs'
import { forCounterBounds, forCounterRange } from '../src/static.js'

const compare = (source, inputs) => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const actual = run(source, { optimize }), expected = oracle(source)
    for (const args of inputs) is(actual.f(...args), expected.f(...args), `O${optimize}: ${args.join(', ')}`)
  }
}

test('counter width: square guards preserve their first test before any range theorem holds', () => {
  for (const start of ['65536', '-65536', '4294967296', '-1', '-0', '0.5', 'start']) {
    const source = `export function f(start) {
      let count = 0, last = 19, first = 19
      for (let i = ${start}; i * i < 16; i++) { count++; last = i; if (count === 1) first = i; if (count === 4) break }
      return [count, last, first]
    }`
    compare(source, [[65536], [-65536], [0], [1], [-1], [0.5], [NaN], [Infinity]])
  }
  compare(`export function f(start) {
    let i = start, count = 0
    while (i * i < 16) { count++; i++; if (count === 4) break }
    return [count, i]
  }`, [[65536], [-65536], [0], [1], [-1], [0.5]])
})

test('counter width: canonical square bounds retain strict, inclusive and mirrored edges', () => {
  for (const condition of ['i*i < B', 'i*i <= B', 'B > i*i', 'B >= i*i'])
    for (const bound of [0, 1, 1.0000000000000002, 3.9999999999999996, 4.000000000000001, 15, 16, 17, 1073741824]) {
      const source = `export function f() {
        let count = 0, last = -1
        for (let i = 0; ${condition.replace('B', String(bound))}; i++) { count++; last = i }
        return [count, last]
      }`
      compare(source, [[]])
    }
})

test('counter width: bounded variable steps retain both range and exact iteration sequence', () => {
  const source = `export function f(s, n) {
    const stride = (s & 7) + 1, limit = (n & 31) + 1
    const out = new Int32Array(32)
    let count = 0
    for (let j = 3; j < limit; j += stride) { out[count] = j; count = (count + 1) | 0 }
    return [count, out]
  }`
  compare(source, [-1, 0, 1, 7, 2147483647].flatMap(s => [-1, 0, 1, 3, 31].map(n => [s, n])))
  if (onKernel()) return
  const tree = parse(source, { level: 2, watr: false })
  ok(loopCount(tree, n => n[0] === 'i32.add') > 0, 'the bounded counter retains integer updates')
  is(loopCount(tree, n => n[0] === 'f64.lt'), 0, 'the bound and counter compare as integers')
})

test('counter width: a variable step includes final overshoot and rejects unbounded direction', () => {
  for (const [start, condition, step] of [
    [2147483647, 'j <= 2147483647', 'j += stride'],
    [-2147483648, 'j >= -2147483648', 'j -= stride'],
  ]) compare(`export function f(s) {
    const stride = (s & 3) + 1
    let count = 0, last = 0
    for (let j = ${start}; ${condition}; ${step}) { last = j; if (++count === 3) break }
    return [count, last]
  }`, [[0], [1], [3]])
  compare(`export function f(stride) {
    let count = 0, last = 0
    for (let j = 3; j < 16; j += stride) { last = j; if (++count === 3) break }
    return [count, last]
  }`, [[-1], [0], [0.5], [1], [2147483648], [NaN]])
  for (const update of ['stride = mode ? -2 : 2', 'reset()']) compare(`export function f(mode) {
    let stride = 1, count = 0, last = 0
    const reset = () => { stride = mode ? -2 : 2 }
    for (let j = -2147483648; j < 0; j += stride) { ${update}; last = j; if (++count === 3) break }
    return [count, last]
  }`, [[0], [1]])

})

test('counter width: width bounds never advertise a varying step as an exact stride', () => {
  if (onKernel()) return
  const init = ['let', ['=', 'j', [null, 3]]], cond = ['<', 'j', [null, 32]], step = ['+=', 'j', 'stride']
  const range = n => n === 'stride' ? [1, 8] : Array.isArray(n) && n[0] == null ? [n[1], n[1]] : null
  const bound = forCounterBounds(init, cond, step, 'j', range)
  is(bound.slice(), [3, 31], 'body values follow the guard')
  is(bound.test, [3, 39], 'the final largest step belongs to the lifetime hull')
  is(bound.step, null, 'no exact stride is claimed')
  is(forCounterRange(init, cond, step, 'j', range), null, 'trip-count consumers keep their exact-step contract')
  for (const bad of [[0, 8], [-1, 8], [0.5, 8], [1, Infinity]])
    is(forCounterBounds(init, cond, step, 'j', n => n === 'stride' ? bad : range(n)), null, `${bad} is no positive integer step hull`)
})
