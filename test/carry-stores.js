// A round's last store to an address its next round reads first passes the value
// through a local (src/optimize/carry-stores.js): the lower envelope's boundary
// `z[k] = s`, read back by the next round's pop test, a filter state kept in
// memory. V8 forwards nothing across a back edge; the value went through the
// store queue where a register would hand it over.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { oracle, jz, compile } from './util.js'
import { carryStores } from '../src/optimize/carry-stores.js'

const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
const addr = () => ['i32.add', g('$z'), ['i32.shl', g('$k'), k(3)]]
const latch = ['br_if', '$L', ['i32.lt_s', ['local.tee', '$q', ['i32.add', g('$q'), k(1)]], k(9)]]
const fn = (...body) => ['func', '$f', ['param', '$z', 'i32'], ['param', '$k', 'i32'], ['local', '$q', 'i32'], ['local', '$p', 'i32'], ['local', '$s', 'f64'], ['local', '$t', 'f64'], ...body]
const out = (...body) => carryStores(['module', fn(...body)])[1]

test('carryStores: the next round reads the value the round stored last from a local', () => {
  const head = ['local.set', '$s', ['f64.load', addr()]]
  const work = ['local.set', '$t', ['f64.add', g('$s'), ['f64.const', 1]]]
  const store = ['f64.store', ['local.tee', '$p', addr()], g('$t')]
  const next = ['f64.store', 'offset=8', g('$p'), ['f64.const', 0]]
  is(out(['block', '$B', ['loop', '$L', head, work, store, next, latch]]),
    fn(['local', '$__cs0', 'f64'], ['block', '$B',
      ['local.set', '$__cs0', ['f64.load', addr()]],
      ['loop', '$L', ['local.set', '$s', g('$__cs0')], work, ['f64.store', ['local.tee', '$p', addr()], ['local.tee', '$__cs0', g('$t')]], next, latch]]),
    'the first round loads where it would, each store sets the local')
  // a read under a conditional of the round: the first round loads it under the same test
  // (the pass rewrites its input in place: fresh nodes)
  const guarded = ['if', ['i32.ge_s', g('$k'), k(0)], ['then', ['local.set', '$s', ['f64.load', addr()]]]]
  is(out(['block', '$B', ['loop', '$L', guarded, work, ['f64.store', ['local.tee', '$p', addr()], g('$t')], next, latch]])[9][2],
    ['if', ['i32.ge_s', g('$k'), k(0)], ['then', ['local.set', '$__cs0', ['f64.load', addr()]]]],
    'the entry load runs under the test the round reads it under')
})

test('carryStores: a store that may reach the address, a call, a moved address, a branch before the read and a second way back keep the loads', () => {
  const head = ['local.set', '$s', ['f64.load', addr()]]
  const store = ['f64.store', ['local.tee', '$p', addr()], g('$s')]
  const kept = (body, why) => { const before = fn(JSON.parse(JSON.stringify(body))); is(out(body), before, why) }
  kept(['block', '$B', ['loop', '$L', head, store, ['f64.store', g('$q'), ['f64.const', 0]], latch]], 'a later store through another address may reach it')
  kept(['block', '$B', ['loop', '$L', head, store, ['f64.store', 'offset=4', g('$p'), ['f64.const', 0]], latch]], 'a later store overlapping its bytes')
  kept(['block', '$B', ['loop', '$L', head, store, ['call', '$g'], latch]], 'a later call')
  kept(['block', '$B', ['loop', '$L', head, store, ['local.set', '$k', ['i32.add', g('$k'), k(1)]], latch]], 'the address moves before the next round')
  kept(['block', '$B', ['loop', '$L', ['br_if', '$B', g('$q')], head, store, latch]], 'a branch comes before the read')
  kept(['block', '$B', ['loop', '$L', ['br_if', '$L', g('$t')], head, store, latch]], 'a second way back to the head')
  kept(['block', '$B', ['loop', '$L', ['f64.store', g('$q'), ['f64.const', 0]], head, store, latch]], 'a store comes before the read')
  kept(['block', '$B', ['loop', '$L', ['local.set', '$s', ['f64.load', 'offset=8', addr()]], store, latch]], 'the read is of another offset')
})

// The lower envelope's pop test reads z[k] after the round stored it; a one-pole filter
// keeps its state in a typed array at a fixed channel. Each against the host, at every level.
const KERNELS = {
  envelope: `
const INF = 1e20
const edt1d = (f, d, v, z, n) => {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k])
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k]) }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF
  }
  return k
}
export let run = (seed, mode) => {
  const f = new Float64Array(40), d = new Float64Array(40), v = new Int32Array(40), z = new Float64Array(41)
  let s = seed | 0
  for (let i = 0; i < 40; i++) {
    s = (s * 1103515245 + 12345) | 0
    const r = (s >>> 8) % 100
    f[i] = mode === 0 ? (r < 30 ? 0 : INF) : mode === 1 ? r - 50 : mode === 2 ? (r < 10 ? -Infinity : r) : (r < 10 ? NaN : r)
  }
  const k = edt1d(f, d, v, z, 40)
  let h = 0
  for (let i = 0; i <= k + 1; i++) h = (h * 31 + (z[i] === z[i] ? Math.round(z[i] * 1000) % 1000003 : 7)) % 1000000007
  return h + '/' + k
}`,
  filter: `
const step = (x, st, ch, n, a) => {
  for (let i = 0; i < n; i++) { const y = st[ch] * a + x[i]; x[i] = y; st[ch] = y }
}
export let run = (seed, ch) => {
  const x = new Float64Array(32), st = new Float64Array(4)
  for (let i = 0; i < 32; i++) x[i] = ((i * 7 + seed) % 11) - 5
  st[ch & 3] = seed
  step(x, st, ch & 3, 32, 0.75)
  let h = 0
  for (let i = 0; i < 32; i++) h = h * 0.5 + x[i]
  return h + '/' + st[ch & 3]
}`,
}

test('carryStores: kernels agree with the host with and without the carry', () => {
  for (const [name, src] of Object.entries(KERNELS)) {
    const native = oracle(src).run
    for (const optimize of [...levels(0, 2, 3, 'size'), { level: 'speed', carryStores: false }]) {
      const wasm = jz(src, { optimize }).exports.run
      for (let a = 0; a < 4; a++) for (let b = 1; b <= 5; b++) is(wasm(b, a), native(b, a), `${name} ${JSON.stringify(optimize)}: run(${b}, ${a})`)
    }
  }
  if (onKernel()) return
  const carried = (src, optimize) => (compile(src, { optimize, wat: true }).match(/\(local \$__cs\d+ f64\)/g) || []).length
  ok(carried(KERNELS.envelope, 'speed') > 0, 'the envelope carries its boundary')
  is(carried(KERNELS.envelope, { level: 'speed', carryStores: false }), 0, 'and keeps the load without the pass')
})
