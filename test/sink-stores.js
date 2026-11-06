// A loop's every-round store to a slot nothing in it reads is a local the round sets,
// stored as the loop leaves (src/optimize/sink-stores.js): the out-parameter a chain
// of library calls writes each round (pmndrs/math's quat.multiply(out, inv, b[i])),
// and a value only the store reads is computed there.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { onKernel, levels } from './_matrix.js'
import { jz, compile } from './util.js'
import { sinkStores } from '../src/optimize/sink-stores.js'

const g = (n) => ['local.get', n], k = (v) => ['i32.const', v]
const st = (v, off) => off ? ['f64.store', `offset=${off}`, g('$o'), v] : ['f64.store', g('$o'), v]
const decls = [['param', '$o', 'i32'], ['param', '$n', 'i32'], ['param', '$x', 'f64'], ['param', '$y', 'f64'], ['local', '$i', 'i32'], ['local', '$v', 'f64'], ['local', '$w', 'f64'], ['local', '$s', 'f64']]
const fn = (...body) => ['func', '$f', ...decls, ...body]
const head = ['br_if', '$B', ['i32.ge_s', g('$i'), g('$n')]]
const step = ['local.set', '$i', ['i32.add', g('$i'), k(1)]]
const loop = (...body) => ['block', '$B', ['loop', '$L', head, ...body, step, ['br', '$L']]]
const out = (...body) => { const f = fn(...body); sinkStores(f); return f }
const copy = (n) => JSON.parse(JSON.stringify(n))

test('sinkStores: a slot stored every round and never read is a local, stored once past the loop', () => {
  const v = ['local.set', '$v', ['f64.convert_i32_s', g('$i')]], sum = ['local.set', '$s', ['f64.add', g('$s'), g('$v')]]
  is(out(loop(v, st(g('$v')), sum)), fn(['local', '$__sk0', 'f64'], ['local', '$__sk1', 'i32'],
    ['block', '$B', ['local.set', '$__sk1', k(0)], ['loop', '$L', head, v, ['local.set', '$__sk0', g('$v')], sum, step, ['local.set', '$__sk1', k(1)], ['br', '$L']]],
    ['if', g('$__sk1'), ['then', st(g('$__sk0'))]]), 'the store a set, a flag that a round ran, one store past the loop')
  // a value only the store reads, of what the round leaves as it was, is computed past the loop
  const w = ['local.set', '$w', ['f64.mul', g('$x'), g('$y')]]
  const moved = out(loop(v, w, st(g('$w'), 8), sum))
  is(moved.at(-1), ['if', g('$__sk0'), ['then', st(['f64.mul', g('$x'), g('$y')], 8)]], 'the product is computed where it is stored')
  ok(!JSON.stringify(moved[moved.length - 2]).includes('"$w"'), 'and no longer in the loop')
})

test('sinkStores: a read, another store that may reach the slot, a call, a store one arm makes and a guard after a store keep the loop', () => {
  const kept = (body, why) => { const f = fn(...copy(body)); sinkStores(f); is(f, fn(...body), why) }
  const v = ['local.set', '$v', g('$x')]
  kept([loop(v, st(g('$v')), ['local.set', '$s', ['f64.load', g('$o')]])], 'the round reads the slot')
  kept([loop(v, st(g('$v')), ['f64.store', ['i32.add', g('$o'), ['i32.shl', g('$i'), k(3)]], g('$x')])], 'a store at an address the round moves may reach it')
  kept([loop(v, st(g('$v')), ['call', '$h'])], 'a call may read it')
  kept([loop(v, ['if', ['f64.gt', g('$v'), g('$y')], ['then', st(g('$v'))]])], 'one arm stores: a round may not')
  kept([loop(st(g('$x')), ['if', ['i32.eqz', g('$n')], ['then', ['call', '$__throw_type'], ['unreachable']]])], 'a guard after the store would throw past it')
  kept([loop(st(g('$x')), ['br_if', '$B', g('$n')])], 'another way out')
  kept([['block', '$B', ['loop', '$L', head, st(g('$x')), ['block', '$C', ['loop', '$M', ['br', '$C']]], ['br', '$L']]]], 'a loop within')
})

// Products through two out-parameters, as pmndrs/math's quaternions take them: `one`
// passes the same array as both, a round may throw (an index past the quaternions
// reads undefined), and a loop may not run.
const QUAT = `
const multiply = (out, a, b) => {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3]
  out[0] = ax * bw + aw * bx + ay * bz - az * by
  out[1] = ay * bw + aw * by + az * bx - ax * bz
  out[2] = az * bw + aw * bz + ax * by - ay * bx
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}
const normalize = (out, a) => {
  const x = a[0], y = a[1], z = a[2], w = a[3]
  let len = x * x + y * y + z * z + w * w
  if (len > 0) len = 1 / Math.sqrt(len)
  out[0] = x * len; out[1] = y * len; out[2] = z * len; out[3] = w * len
  return out
}
const invert = (out, a) => {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3]
  const dot = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3
  if (dot === 0) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return out }
  const inv = 1 / dot
  out[0] = -a0 * inv; out[1] = -a1 * inv; out[2] = -a2 * inv; out[3] = a3 * inv
  return out
}
const out = [0, 0, 0, 1], inv = [0, 0, 0, 1], same = out
let seed = 1
const next = (z) => { seed = (seed * 1103515245 + 12345) % 2147483648; return z ? 0 : seed / 2147483648 - 0.5 }
const qs = (n, zero) => {
  const r = []
  for (let i = 0; i < n; i++) r.push([next(i === zero), next(i === zero), next(i === zero), next(i === zero)])
  return r
}
const a = qs(6, 2), b = qs(6, -1)
export let apart = (n) => {
  let sm = 0, si = 0
  for (let i = 0; i < n; i++) {
    multiply(out, a[i], b[i]); normalize(out, out); sm += out[0] + out[3]
    invert(inv, a[i]); multiply(out, inv, b[i]); si += out[1] + out[2]
  }
  return sm + si
}
export let one = (n) => {
  let sm = 0, si = 0
  for (let i = 0; i < n; i++) {
    multiply(out, a[i], b[i]); normalize(out, out); sm += out[0] + out[3]
    invert(same, a[i]); multiply(out, same, b[i]); si += out[1] + out[2]
  }
  return sm + si
}
export let reset = () => { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; inv[0] = 0; inv[1] = 0; inv[2] = 0; inv[3] = 1 }
export let state = () => out.join(',') + '|' + inv.join(',')
`

test('sinkStores: out-parameter products agree with the host, through a throw, one array as both and no round', () => {
  const host = new Function(QUAT.replace(/export let /g, 'let ') + '\nreturn { apart, one, reset, state }')()
  const call = (e, f, n) => { e.reset(); let r; try { r = e[f](n) } catch { r = 'threw' } return r + '|' + e.state() }
  for (const optimize of [...levels(0, 2, 3, 'size'), { level: 'speed', sinkStores: false }]) {
    const { exports } = jz(QUAT, { optimize })
    for (const f of ['apart', 'one']) for (const n of [0, 1, 3, 6, 7, 9]) is(call(exports, f, n), call(host, f, n), `${f}(${n}) ${JSON.stringify(optimize)}`)
  }
  if (onKernel()) return
  const sunk = (optimize) => (compile(QUAT, { optimize, wat: true }).match(/\(local \$__sk\d+ f64\)/g) || []).length
  ok(sunk('speed') > 0, 'the products are locals of the loop')
  is(sunk({ level: 'speed', sinkStores: false }), 0, 'and stores without the pass')
})
