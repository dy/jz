// A round's lane minima and maxima take the relaxed operators, tested once where the
// engine's are not IEEE's (src/optimize/relaxed-extremes.js): the trees go into locals
// ahead of what reads them, the sum of their leaves times every root is tested, and
// where it is zero or NaN the trees are taken again with f64x2.min and f64x2.max. Each
// call asks the engine how it answers a NaN; IEEE's answer tests nothing.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { oracle, jz, compile } from './util.js'
import { instantiate } from '../index.js'
import parseWat from 'watr/parse'
import { compile as assemble } from 'watr'
import { relaxExtremes } from '../src/optimize/relaxed-extremes.js'

const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
const latch = ['br_if', '$L', ['i32.lt_s', ['local.tee', '$i', ['i32.add', g('$i'), k(1)]], g('$n')]]
const one = (body, locals = []) => {
  const m = relaxExtremes(['module', ['func', '$f', ...locals, body]])
  return { global: m[1], zero: m[2], fn: m.find(n => Array.isArray(n) && n[0] === 'func') }
}
const find = (n, f, acc = []) => { if (Array.isArray(n)) { if (f(n)) acc.push(n); n.forEach(c => find(c, f, acc)) } return acc }
const loopOf = (fn) => find(fn, n => n[0] === 'loop')[0]   // (the tested one: the choice's first arm)

test('relaxExtremes: a round\'s tree takes the relaxed operators, its test and the exact tree after it', () => {
  const tree = ['f64x2.min', ['f64x2.min', g('$r'), g('$g')], g('$b')]
  const { global, zero, fn } = one(['loop', '$L', ['local.set', '$m', tree], ['v128.store', g('$p'), g('$m')], latch])
  is(global, ['global', '$__rnan', ['mut', 'f64'], ['f64.const', 'nan']], 'a NaN the engine cannot fold')
  is(zero, ['global', '$__rnz', ['mut', 'f64'], ['f64.const', '-0']], 'and a -0: an engine answering the NaN as IEEE may still answer either zero')
  const choice = find(fn, n => n[0] === 'if' && n[2]?.[1]?.[0] === 'loop')[0], L = choice[2][1], plain = choice[3][1]
  is(choice[1], g('$__rx0'), 'the engine not IEEE\'s runs the tested round')
  // x64's answers: a NaN reaches the root along the chain of second operands (V8's) or of first ones,
  // the chains ending at leaves the other trees would cover; alone, the tree's leaves are all summed
  is(L[2], ['local.set', '$m', ['f64x2.relaxed_min', ['f64x2.relaxed_min', g('$r'), g('$g')], g('$b')]], 'relaxed')
  const cheap = L[3], precise = cheap[2][1]
  is(cheap[1][1], g('$__rx1'), 'taken again every round where it answers neither as IEEE nor as x64')
  is(cheap[1][2][1][1][1][1], ['f64x2.mul', ['f64x2.add', ['f64x2.add', g('$r'), g('$g')], g('$b')], g('$m')], 'the leaves, times the root')
  is(find(precise[1], n => n[0] === 'local.tee')[0][2], ['f64x2.add', ['f64x2.add', ['f64x2.add', g('$r'), g('$g')], g('$b')], g('$m')], 'where that fails: a NaN at the root or a leaf')
  is(find(precise[1], n => n[0] === 'i64x2.eq').map(n => n[1][1]), ['$r', '$g', '$b'], 'or a -0 leaf')
  is(precise[2], ['then', ['local.set', '$m', ['f64x2.min', ['f64x2.min', g('$r'), g('$g')], g('$b')]]], 'the exact tree where both fail')
  is(L[4], ['v128.store', g('$p'), g('$m')], 'what reads the root follows the test')
  is(plain, ['loop', '$L_rx0', L[2], L[4], ['br_if', '$L_rx0', latch[2]]], 'IEEE\'s engine runs the relaxed round untested, a loop of its own')
  ok(find(fn, n => n[0] === 'local.set' && n[1] === '$__rx0').length === 1, 'the engine asked once')
  ok(find(fn, n => n[0] === 'f64x2.replace_lane' && n[3]?.[1] === '$__rnz').length === 2, 'and asked of zeros of two signs, each order a lane')
})

test('relaxExtremes: a minimum and a maximum of the same leaves cover each other\'s chains, one leaf left to sum', () => {
  const T = (op) => [op, [op, g('$r'), g('$g')], g('$b')]
  const { fn } = one(['loop', '$L', ['local.set', '$lo', T('f64x2.min')], ['local.set', '$hi', T('f64x2.max')], ['v128.store', g('$p'), ['f64x2.sub', g('$hi'), g('$lo')]], latch])
  const L = loopOf(fn)
  is(L[2][2], ['f64x2.relaxed_min', ['f64x2.relaxed_min', g('$r'), g('$g')], g('$b')], 'the minimum\'s chains end at b (second) and r (first)')
  is(L[3][2], ['f64x2.relaxed_max', g('$b'), ['f64x2.relaxed_max', g('$g'), g('$r')]], 'the maximum\'s at r (second) and b (first)')
  is(L[4][1][2][1][1][1][1], ['f64x2.mul', ['f64x2.mul', g('$g'), g('$lo')], g('$hi')], 'g alone in the sum')
})

test('relaxExtremes: trees later in the round move up to the first, past what leaves them alone', () => {
  const T = (op, a, b) => [op, g(a), g(b)]
  const { fn } = one(['loop', '$L',
    ['local.set', '$lo', T('f64x2.min', '$a', '$b')],
    ['local.set', '$d', ['f64x2.sub', ['local.tee', '$hi', T('f64x2.max', '$a', '$b')], g('$lo')]],
    ['v128.store', g('$p'), g('$d')],
    ['v128.store', ['i32.add', g('$p'), ['local.tee', '$q', k(16)]], ['f64x2.mul', T('f64x2.min', '$c', '$a'), g('$k')]],
    latch])
  const L = loopOf(fn)
  is(L.slice(2, 5).map(s => s[0] + ' ' + s[1]), ['local.set $lo', 'local.set $__rx2', 'local.set $__rx4'], 'three trees, then their test')
  is(L[5][0], 'if')
  is(L[6], ['local.set', '$d', ['f64x2.sub', ['local.tee', '$hi', g('$__rx2')], g('$lo')]], 'the tree a statement read is its root')
  is(L[8], ['local.set', '$__rx3', ['i32.add', g('$p'), ['local.tee', '$q', k(16)]]], 'a store of a tree computes its address first')
  is(L[9], ['v128.store', g('$__rx3'), ['f64x2.mul', g('$__rx4'), g('$k')]])
})

test('relaxExtremes: a tree past a call or a branch, or past a write of its leaf, stays exact', () => {
  const max = () => ['local.set', '$y', ['f64x2.max', g('$a'), g('$b')]]
  const kept = (between, why) => {
    const { fn } = one(['loop', '$L', ['local.set', '$x', ['f64x2.min', g('$a'), g('$b')]], between, max(), latch])
    is(find(loopOf(fn), n => n[0] === 'local.set' && n[1] === '$y')[0], max(), why)
  }
  kept(['call', '$h'], 'a call')
  kept(['br_if', '$out', g('$c')], 'a branch')
  kept(['local.set', '$a', ['f64x2.neg', g('$a')]], 'a write of a leaf')
  const { fn } = one(['loop', '$L', ['if', g('$c'), ['then', max()]], latch])
  ok(!find(fn, n => n[0] === 'f64x2.relaxed_max').length, 'a tree inside a construct of the round')
  // a root the round writes again: taken again in order, the second tree would read the first's relaxed value
  const twice = one(['loop', '$L', ['local.set', '$m', ['f64x2.min', g('$m'), g('$a')]], ['local.set', '$m', ['f64x2.min', g('$m'), g('$b')]], latch]).fn
  is(loopOf(twice).filter(n => n[0] === 'local.set' && n[1] === '$m').map(n => n[2][0]), ['f64x2.relaxed_min', 'f64x2.min'], 'the second write of a root stays exact')
  const teed = one(['loop', '$L', ['local.set', '$x', ['f64x2.min', g('$a'), g('$b')]], ['local.set', '$y', ['f64x2.max', ['local.tee', '$x', g('$c')], g('$d')]], latch]).fn
  is(find(loopOf(teed), n => n[0] === 'local.set' && n[1] === '$y')[0][2][0], 'f64x2.max', 'a tree writing an earlier root stays exact')
})

// Lane minima and maxima over values of every kind of float, against the host: NaN in each
// operand, zeros of both signs meeting, infinities, numbers. Each run also answers every
// choice the specification lets relaxed_min and relaxed_max make, the relaxed operators
// rewritten to it: IEEE's (arm64), the first operand's, the second's (x64), the number's.
const LANES = `
export let run = (mode, n) => {
  const a = new Float64Array(3 * n), out = new Float64Array(3 * n)
  const V = [NaN, -0, 0, Infinity, -Infinity, 1, -1, 0.5]
  let s = 7
  for (let i = 0; i < 3 * n; i++) {
    s = (s * 1103515245 + 12345) | 0
    const r = (s >>> 8) % 64
    a[i] = mode === 0 ? r - 30 : mode === 1 ? V[r & 7] : mode === 2 ? (r < 8 ? V[r & 7] : r - 30) : mode === 3 ? r + 1 : r & 3 ? r - 30 : 0
  }
  for (let i = 0; i < n; i++) {
    const j = 3 * i, r = a[j], g = a[j + 1], b = a[j + 2]
    const lo = Math.min(r, g, b), hi = Math.max(r, g, b)
    out[j] = lo; out[j + 1] = hi; out[j + 2] = Math.max(Math.min(r, g), b) - lo
  }
  let t = ''
  for (let i = 0; i < 3 * n; i++) t += (Object.is(out[i], -0) ? '-0' : String(out[i])) + ','
  return t
}`

const PSEUDO = { 'f64x2.relaxed_min': 'f64x2.pmin', 'f64x2.relaxed_max': 'f64x2.pmax' }
/** The speed build of `src` with its relaxed operators answering as `choice`; `poison` (the second operand's answer)
 *  and `poison1` (the first's) also answer the exact trees with 7s. */
const answering = (src, choice) => {
  const ast = parseWat(compile(src, { optimize: 'speed', wat: true }))
  const visit = (n) => {
    if (!Array.isArray(n)) return
    n.forEach(visit)
    const [op, a, b] = n
    if (PSEUDO[op] && (choice === 'first' || choice === 'poison1')) n.splice(0, 3, PSEUDO[op], a, b)
    else if (PSEUDO[op] && (choice === 'second' || choice === 'poison')) n.splice(0, 3, PSEUDO[op], b, a)
    else if (PSEUDO[op] && choice === 'number') {
      const c = (x) => structuredClone(x), exact = op.endsWith('min') ? 'f64x2.min' : 'f64x2.max'
      n.splice(0, 3, 'v128.bitselect', c(b), ['v128.bitselect', c(a), [exact, a, b], ['f64x2.ne', c(b), c(b)]], ['f64x2.ne', c(a), c(a)])
    } else if (choice.startsWith('poison') && (op === 'f64x2.min' || op === 'f64x2.max')) n.splice(0, n.length, 'v128.const', 'f64x2', '7', '7')
  }
  visit(ast)
  return instantiate(assemble(ast)).exports.run
}

test('relaxExtremes: lane extremes agree with the host on every relaxed answer, and the test passes numbers', () => {
  const native = oracle(LANES).run
  for (const optimize of [...levels(0, 2, 3, 'size'), { level: 'speed', relaxExtremes: false }, { level: 'speed', relaxedSimd: false }]) {
    const wasm = jz(LANES, { optimize }).exports.run
    for (let mode = 0; mode < 5; mode++) for (const n of [0, 1, 2, 3, 17, 64])
      is(wasm(mode, n), native(mode, n), `${JSON.stringify(optimize)}: mode ${mode}, ${n} lanes`)
  }
  if (onKernel()) return
  ok(find(parseWat(compile(LANES, { optimize: 'speed', wat: true })), n => n[0] === 'f64x2.relaxed_min').length >= 3, 'the speed build relaxes the round')
  for (const choice of ['ieee', 'first', 'second', 'number']) {
    const wasm = answering(LANES, choice)
    for (let mode = 0; mode < 5; mode++) for (const n of [1, 3, 17, 64])
      is(wasm(mode, n), native(mode, n), `relaxed answering ${choice}: mode ${mode}, ${n} lanes`)
  }
  // the second operand's answer (V8 on x64) and the first's, the exact trees poisoned: rounds of
  // numbers, +0 among them, pass the tests and never take them
  for (const choice of ['poison', 'poison1']) {
    const poisoned = answering(LANES, choice)
    for (const mode of [3, 4]) for (const n of [1, 3, 17, 64]) is(poisoned(mode, n), native(mode, n), `${choice}: mode ${mode}, ${n} lanes of numbers never take the exact trees`)
  }
})
