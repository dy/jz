// A loop's running minimum or maximum is taken after the loop where the round's
// test says it changes (src/optimize/extreme-guards.js): `v > m` decides
// f64.min(m, v) = m, so the round that keeps every extreme falls through its
// tests to the latch, and code after the loop takes an extreme, tests the ones
// after it and comes back in.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { oracle, jz, compile, funcWat } from './util.js'
import parseWat from 'watr/parse'
import { walk } from '../scripts/wat-probe.mjs'
import { guardExtremes } from '../src/optimize/extreme-guards.js'

const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
const x = ['f64.load', ['i32.add', g('$p'), ['i32.shl', g('$i'), k(3)]]]
const latch = ['br_if', '$L', ['i32.lt_s', ['local.tee', '$i', ['i32.add', g('$i'), k(1)]], g('$n')]]
const one = (body, locals = []) => guardExtremes(['module', ['func', '$f', ...locals, body]])[1]

test('guardExtremes: a running minimum is taken after the loop where its test fails', () => {
  const fn = one(['block', '$brk', ['loop', '$L', ['local.set', '$m', ['f64.min', g('$m'), x]], latch]])
  is(fn[2], ['local', '$__ex0', 'f64'], 'the operand gets a local')
  is(fn[3], ['block', '$brk', ['loop', '$again_x0',
    ['block', '$take_x1', ['loop', '$L', ['local.set', '$__ex0', x], ['br_if', '$take_x1', ['i32.eqz', ['f64.gt', g('$__ex0'), g('$m')]]], latch, ['br', '$brk']]],
    ['local.set', '$m', ['f64.min', g('$m'), g('$__ex0')]],
    ['br_if', '$again_x0', latch[2]]]], 'the round that keeps the minimum falls through to the latch')
})

test('guardExtremes: the extremes of a round each leave for code that takes it and the ones after it', () => {
  const fn = one(['block', '$brk', ['loop', '$L', ['local.set', '$lo', ['f64.min', g('$lo'), g('$v')]], ['local.set', '$hi', ['f64.max', g('$v'), g('$hi')]], latch]])
  const outer = fn[2][2]
  is(outer.slice(0, 2), ['loop', '$again_x0'], 'one loop takes the extremes and comes back in')
  const inner = outer[2][2][2]
  is(inner.slice(0, 2), ['loop', '$L'])
  is(inner[2], ['br_if', '$take_x1', ['i32.eqz', ['f64.gt', g('$v'), g('$lo')]]], 'the minimum keeps where its operand is above it')
  is(inner[3], ['br_if', '$take_x2', ['i32.eqz', ['f64.lt', g('$v'), g('$hi')]]], 'the maximum where below')
  // the code taking the minimum tests the maximum too
  is(outer[2][3], ['local.set', '$lo', ['f64.min', g('$lo'), g('$v')]])
  is(outer[2][4], ['if', ['i32.eqz', ['f64.lt', g('$v'), g('$hi')]], ['then', ['local.set', '$hi', ['f64.max', g('$hi'), g('$v')]]]])
})

test('guardExtremes: an extreme read or written elsewhere in the round, a branch out after it and a branch by depth keep their shape', () => {
  const kept = (body, why) => { const before = JSON.parse(JSON.stringify(body)); is(one(body)[2], before, why) }
  const min = ['local.set', '$m', ['f64.min', g('$m'), x]]
  kept(['block', '$brk', ['loop', '$L', min, ['local.set', '$s', ['f64.add', g('$s'), g('$m')]], latch]], 'a read after its statement')
  kept(['block', '$brk', ['loop', '$L', min, ['local.set', '$m', ['f64.const', 0]], latch]], 'another write')
  kept(['block', '$brk', ['loop', '$L', min, ['br_if', '$brk', g('$c')], latch]], 'a branch out of the round after it')
  kept(['block', '$brk', ['loop', '$L', min, ['br_if', '$L', ['i32.lt_s', g('$i'), g('$m')]]]], 'a latch that reads it')
  kept(['block', '$brk', ['loop', '$L', min, ['br_if', 1, g('$c')], latch]], 'a function that branches by depth')
})

test('guardExtremes: a canonicalized extreme takes its canonicalization along, where its temp is dead', () => {
  const canon = (t) => ['select', ['f64.const', 'nan'], ['local.tee', t, ['f64.min', g('$m'), x]], ['f64.ne', g(t), g(t)]]
  const fn = one(['block', '$brk', ['loop', '$L', ['local.set', '$m', canon('$t')], latch]])
  ok(JSON.stringify(fn).includes(JSON.stringify(['local.set', '$m', ['select', ['f64.const', 'nan'], ['local.tee', '$t', ['f64.min', g('$m'), g('$__ex0')]], ['f64.ne', g('$t'), g('$t')]]])),
    'the canonicalization goes with the minimum')
  // a temp read past the loop keeps the loop as written
  const live = ['block', '$brk', ['loop', '$L', ['local.set', '$m', canon('$t')], latch], ['local.set', '$y', g('$t')]]
  const before = JSON.parse(JSON.stringify(live))
  is(one(live)[2], before, 'a temp live past the loop')
})

// Running extremes over values of every kind of float: NaN, both zeros, infinities, runs that
// rise and fall, against the host.
const EXTREMES = `
export let run = (mode, n) => {
  const a = new Float64Array(n)
  let s = 7
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) | 0
    const r = ((s >>> 8) % 2001) - 1000
    a[i] = mode === 0 ? r : mode === 1 ? i : mode === 2 ? n - i : mode === 3 ? (i % 7 === 3 ? NaN : r) :
      mode === 4 ? (i % 2 ? 0 : -0) : mode === 5 ? (i % 5 === 0 ? -Infinity : i % 5 === 1 ? Infinity : r) : (i & 1 ? -r : r)
  }
  let lo = Infinity, hi = -Infinity, lo2 = Infinity
  for (let i = 0; i < n; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); lo2 = Math.min(a[i] * 0.5, lo2) }
  const box = [Infinity, Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 1 < n; i += 2) {
    box[0] = Math.min(box[0], a[i]); box[1] = Math.min(box[1], a[i + 1])
    box[2] = Math.max(box[2], a[i]); box[3] = Math.max(box[3], a[i + 1])
  }
  const sign = (v) => Object.is(v, -0) ? '-0' : String(v)
  return [lo, hi, lo2, ...box].map(sign).join(',')
}`

test('guardExtremes: running extremes agree with the host with and without the guards', () => {
  const native = oracle(EXTREMES).run
  for (const optimize of [...levels(0, 2, 3, 'size'), { level: 'speed', guardExtremes: false }]) {
    const wasm = jz(EXTREMES, { optimize }).exports.run
    for (let mode = 0; mode < 7; mode++) for (const n of [0, 1, 2, 9, 64])
      is(wasm(mode, n), native(mode, n), `${JSON.stringify(optimize)}: mode ${mode}, ${n} values`)
  }
  if (onKernel()) return
  // the speed build takes the running minimum after its loop: no f64.min stays in a loop that latches on it
  const wat = funcWat(compile(EXTREMES, { optimize: 'speed', wat: true }), 'run')
  let guarded = 0
  walk(parseWat(wat), n => { if (n[0] === 'loop' && typeof n[1] === 'string' && n[1].startsWith('$again_x')) guarded++ })
  ok(guarded >= 1, 'a loop takes its extremes after it')
})
