// Tests of one shape joined by `|` or `&` run two to a vector
// (src/optimize/pair-tests.js), and a test of a choice between literals is the
// choice between its answers (src/optimize/tested-choices.js).
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, jz } from './util.js'
import { pairTests } from '../src/optimize/pair-tests.js'
import { foldTestedChoices } from '../src/optimize/tested-choices.js'

const g = (n) => ['local.get', n], f = (v) => ['f64.const', v]
const plane = (a, c) => ['f64.lt', ['f64.add', ['f64.mul', g(a), g('$x')], g(c)], g('$r')]
const or = (...t) => t.reduce((a, b) => ['i32.or', a, b])
const fn = (cond) => ['func', '$f', ['param', '$x', 'f64'], ['param', '$r', 'f64'], ...['$a0', '$a1', '$a2', '$a3', '$c0', '$c1', '$c2', '$c3'].map(n => ['param', n, 'f64']),
  ['local', '$v', 'i32'], ['loop', '$L', ['local.set', '$v', cond], ['br_if', '$L', g('$v')]]]

test('pairTests: four tests of one shape join as two vector tests, their lanes packed ahead of the loop', () => {
  const out = pairTests(['module', fn(or(plane('$a0', '$c0'), plane('$a1', '$c1'), plane('$a2', '$c2'), plane('$a3', '$c3')))])[1]
  const loop = out.find(n => Array.isArray(n) && n[0] === 'loop')
  const set = loop[2]
  is(set[2][0], 'v128.any_true', 'the join is a vector test')
  is(set[2][1][0], 'v128.or', 'of two pairs')
  ok(out.filter(n => Array.isArray(n) && n[0] === 'local.set' && Array.isArray(n[2]) && n[2][0] === 'f64x2.replace_lane').length === 4, 'each pair\'s multipliers and addends packed once ahead')
  ok(JSON.stringify(set).includes(JSON.stringify(['f64x2.splat', g('$x')])), 'the shared leaf a splat')
})

test('pairTests: tests of two shapes, a join of three, and a tee read past the join keep their scalars', () => {
  const kept = (cond, why) => { const m = ['module', fn(cond)], before = JSON.parse(JSON.stringify(m)); is(pairTests(m), before, why) }
  kept(or(plane('$a0', '$c0'), ['f64.gt', g('$x'), g('$r')], plane('$a2', '$c2'), plane('$a3', '$c3')), 'two shapes')
  kept(or(plane('$a0', '$c0'), plane('$a1', '$c1'), plane('$a2', '$c2')), 'three tests')
  const teed = ['f64.lt', ['local.tee', '$t', ['f64.add', ['f64.mul', g('$a0'), g('$x')], g('$c0')]], g('$r')]
  const m = ['module', ['func', '$f', ['param', '$x', 'f64'], ['param', '$r', 'f64'], ...['$a0', '$a1', '$a2', '$a3', '$c0', '$c1', '$c2', '$c3'].map(n => ['param', n, 'f64']),
    ['local', '$v', 'i32'], ['local', '$t', 'f64'], ['loop', '$L', ['local.set', '$v', or(teed, plane('$a1', '$c1'), plane('$a2', '$c2'), plane('$a3', '$c3'))], ['br_if', '$L', ['f64.lt', g('$t'), g('$r')]]]]]
  const before = JSON.parse(JSON.stringify(m))
  is(pairTests(m), before, 'a tee the loop reads after the join')
  is(pairTests(['module', fn(or(plane('$a0', '$c0'), plane('$a1', '$c1'), plane('$a2', '$c2'), plane('$a3', '$c3')))], { simd: false })[1], fn(or(plane('$a0', '$c0'), plane('$a1', '$c1'), plane('$a2', '$c2'), plane('$a3', '$c3'))), 'without SIMD')
})

test('testedChoices: a test of a choice between literals is the choice between its answers', () => {
  const c = ['f64.lt', g('$x'), g('$r')]
  const fold = (e) => foldTestedChoices(['module', ['func', '$f', ['param', '$x', 'f64'], ['param', '$r', 'f64'], ['drop', e]]])[1][4][1]
  is(fold(['f64.ne', ['select', f(0), f(1), c], f(0)]), ['i32.eqz', c], 'zero where the test holds: the test inverted')
  is(fold(['f64.ne', ['select', f(1), f(0), c], f(0)]), ['i32.ne', c, ['i32.const', 0]], 'one where it holds: the test')
  is(fold(['f64.lt', f(0.5), ['select', f(1), f(2), c]]), ['i32.const', 1], 'answers that agree')
  is(fold(['f64.ne', ['select', f(0), g('$x'), c], f(0)]), ['f64.ne', ['select', f(0), g('$x'), c], f(0)], 'an arm that is no literal')
})

// Joins of every shape over values of every float kind, the host's answers.
const JOINS = `
export let run = (s, mode) => {
  const a = new Float64Array(8), c = new Float64Array(8)
  for (let k = 0; k < 8; k++) { a[k] = Math.sin(s + k); c[k] = mode === 1 && k === 3 ? NaN : Math.cos(s * k) - 0.5 }
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], c0 = c[0], c1 = c[1], c2 = c[2], c3 = c[3], c4 = c[4]
  let any = 0, all = 0, odd = 0
  for (let i = 0; i < 64; i++) {
    const x = mode === 2 && i % 9 === 0 ? -0 : (i - 32) / 8, r = i % 5 - 2
    if ((a0 * x + c0 < r) | (a1 * x + c1 < r) | (a2 * x + c2 < r) | (a3 * x + c3 < r)) any++
    if ((a0 * x - c0 >= r) & (a1 * x - c1 >= r) & (a2 * x - c2 >= r) & (a3 * x - c3 >= r)) all++
    if ((a0 * x + c0 < r) | (a1 * x + c1 < r) | (a2 * x + c2 < r) | (a3 * x + c3 < r) | (a4 * x + c4 < r)) odd++
  }
  return any + '/' + all + '/' + odd
}`

test('pairTests: paired joins agree with the host with and without the vectors', () => {
  const native = oracle(JOINS).run
  for (const optimize of [...levels(0, 2, 3, 'size'), { level: 'speed', pairTests: false, testedChoices: false }]) {
    const wasm = jz(JOINS, { optimize }).exports.run
    for (const mode of [0, 1, 2]) for (const s of [0, 0.7, 2.3]) is(wasm(s, mode), native(s, mode), `${JSON.stringify(optimize)}: mode ${mode}, s ${s}`)
  }
})
