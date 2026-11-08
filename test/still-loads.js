// A loop that writes no memory and calls nothing reads its invariant loads once
// before it (src/optimize/still-loads.js): the work every round runs before
// anything can leave it, where its addresses hold still.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, jz } from './util.js'
import { hoistStillLoads } from '../src/optimize/still-loads.js'

const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
const latch = ['br_if', '$L', ['i32.lt_s', ['local.tee', '$i', ['i32.add', g('$i'), k(1)]], g('$n')]]
const fn = (...body) => ['func', '$f', ['param', '$p', 'i32'], ['param', '$n', 'i32'], ['local', '$i', 'i32'], ['local', '$q', 'i32'], ['local', '$s', 'f64'], ...body]
const one = (...body) => hoistStillLoads(['module', fn(...body)])[1]

test('stillLoads: a load at an address the loop holds, a write of an invariant once, move ahead of it', () => {
  const read = ['f64.load', 'offset=8', ['local.get', '$q']]
  const out = one(['loop', '$L', ['local.set', '$q', ['i32.load', g('$p')]], ['local.set', '$s', ['f64.add', g('$s'), read]], latch])
  is(out.slice(8), [
    ['local.set', '$q', ['i32.load', g('$p')]],
    ['local.set', '$__still0', read],
    ['loop', '$L', ['local.set', '$s', ['f64.add', g('$s'), g('$__still0')]], latch],
  ], 'the pointer is read ahead, the field through it too, and the round reads the local')
  is(out[7], ['local', '$__still0', 'f64'], 'of the field\'s type')
})

test('stillLoads: a write without a load moves only ahead of a load that reads it', () => {
  const at = ['local.set', '$q', ['i32.add', g('$p'), k(8)]]
  is(one(['loop', '$L', at, ['local.set', '$s', ['f64.add', g('$s'), ['f64.load', g('$q')]]], latch]).slice(8), [
    at, ['local.set', '$__still0', ['f64.load', g('$q')]],
    ['loop', '$L', ['local.set', '$s', ['f64.add', g('$s'), g('$__still0')]], latch],
  ], 'the address the load reads goes ahead with it')
  const m = ['module', fn(['loop', '$L', at, ['local.set', '$s', ['f64.add', g('$s'), ['f64.convert_i32_s', g('$q')]]], latch])]
  const before = JSON.parse(JSON.stringify(m))
  is(hoistStillLoads(m), before, 'no load reads it: watr\'s LICM moves it')
})

test('stillLoads: a loop that stores or calls, a load after a branch and a local written twice keep their reads', () => {
  const kept = (body, why) => { const m = ['module', fn(body)], before = JSON.parse(JSON.stringify(m)); is(hoistStillLoads(m), before, why) }
  const read = ['f64.load', g('$p')]
  kept(['loop', '$L', ['local.set', '$s', ['f64.add', g('$s'), read]], ['f64.store', g('$p'), g('$s')], latch], 'a store')
  kept(['loop', '$L', ['local.set', '$s', ['f64.add', g('$s'), read]], ['call', '$g'], latch], 'a call')
  kept(['loop', '$L', ['br_if', '$L', g('$q')], ['local.set', '$s', ['f64.add', g('$s'), read]], latch], 'a load past a branch')
  kept(['loop', '$L', ['local.set', '$s', ['f64.add', g('$s'), ['f64.load', g('$i')]]], latch], 'an address the loop moves')
  // a local written twice keeps its writes and the reads through it; the load of its first value is read ahead
  const twice = one(['loop', '$L', ['local.set', '$q', ['i32.load', g('$p')]], ['local.set', '$q', ['i32.add', g('$q'), k(1)]], ['local.set', '$s', ['f64.load', g('$q')]], latch])
  is(twice.slice(8), [['local.set', '$__still0', ['i32.load', g('$p')]],
    ['loop', '$L', ['local.set', '$q', g('$__still0')], ['local.set', '$q', ['i32.add', g('$q'), k(1)]], ['local.set', '$s', ['f64.load', g('$q')]], latch]], 'a local written twice')
})

// Fields of records a read-only loop reads through pointers, beside one it writes.
const FIELDS = `
class P { constructor(a, b) { this.a = a; this.b = b } }
const ps = [new P(1, 2), new P(3, 4), new P(NaN, -0)]
export let run = (n, k) => {
  const q = ps[k % 3]
  let s = 0
  for (let i = 0; i < n; i++) s += q.a * i - q.b
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) { out[i] = q.a + i; s += out[i] }
  return s
}`

test('stillLoads: reads moved ahead of a loop answer what the loop read, with and without the pass', () => {
  const native = oracle(FIELDS).run
  for (const optimize of [...levels(0, 2, 3, 'size'), { level: 'speed', stillLoads: false }]) {
    const wasm = jz(FIELDS, { optimize }).exports.run
    for (const n of [0, 1, 5]) for (const kk of [0, 1, 2]) is(wasm(n, kk), native(n, kk), `${JSON.stringify(optimize)}: ${n} rounds, record ${kk}`)
  }
})
