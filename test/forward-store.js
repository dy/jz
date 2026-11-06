// Store-to-load forwarding and dead-store elimination in straight-line code
// (src/optimize/forward-store.js): a kernel that chains calls through an out
// parameter keeps its intermediate results in the locals that staged them, and the
// stores the chain overwrites go. What could alias, call, branch or loop between a
// store and a load keeps the memory round trip.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'
import { forwardStores } from '../src/optimize/forward-store.js'
import parseWat from 'watr/parse'
import { walk } from '../scripts/wat-probe.mjs'

test('store forwarding: expressions without forwarding candidates take linear traversal work', () => {
  const visits = depth => {
    let probes = 0
    const node = (...items) => new Proxy(items, { get(target, key) {
      if (key === '0') probes++
      return target[key]
    } })
    let value = node('local.get', '$x')
    for (let i = 0; i < depth; i++) value = node('f64.add', value, node('f64.const', 1))
    const fn = node('func', '$f', node('param', '$x', 'f64'), node('result', 'f64'), value)
    forwardStores(fn)
    return probes
  }
  const small = visits(128), large = visits(256)
  ok(large < small * 3, `doubling expression depth needs fewer than 3× opcode reads (${small} → ${large})`)
})

const chain = `const out = [0, 0, 0], a = [1, 2, 3], b = [4, 5, 6]
  const add = (o, x, y) => { o[0] = x[0] + y[0]; o[1] = x[1] + y[1]; o[2] = x[2] + y[2]; return o }
  const scale = (o, x, s) => { o[0] = x[0] * s; o[1] = x[1] * s; o[2] = x[2] * s; return o }
  export const f = (n) => { let acc = 0; for (let i = 0; i < n; i++) { add(out, a, b); scale(out, out, 0.5); acc += out[0] + out[2]; a[0] = acc * 1e-3 } return acc }`

test('store forwarding: a chain through an out parameter reloads nothing and keeps only the last stores', () => {
  for (const optimize of levels(0, 2, 3)) agree(chain, 'f', [7], { optimize }, `the chain at ${optimize}`)
  if (belowOpt(2)) return
  // (the round's last stores stay in the loop where sinkStores keeps them: it moves them past it)
  const text = wat(chain, { optimize: { level: 3, sinkStores: false } })
  const body = funcWat(text, 'f$exp') || funcWat(text, 'f')
  let loops=0
  walk(parseWat(body),n=>{
    if(n[0]!=='loop')return
    loops++
    const text=JSON.stringify(n),count=re=>(text.match(re)||[]).length
    // a[0] comes from the store that ends the round before (carryStores)
    is(count(/f64\.load/g) + 2 * count(/v128\.load/g), 5, 'each loop reads a and b once each, but the a[0] it stored; intermediate values come from locals')
    // The added out[0..2] are overwritten after scale read their values: a and b
    // are arrays of other cells (src/ir/mem-alias.js), so no load between reads them.
    is(count(/f64\.store/g) + 2 * count(/v128\.store/g), 4, 'each loop keeps the three scaled stores and a[0]')
  })
  ok(loops>0,'the guarded loop paths remain present')
})

const cases = [
  ['a store through another name between', `const x = [1, 2]
    const put = (o, p) => { o[0] = 1; p[0] = 2; return o[0] }
    export const f = () => put(x, x)`, []],
  ['a call between', `const x = [1, 2]
    let k = 0
    const bump = () => { k++; x[0] = k * 10 }
    const put = (o) => { o[0] = 1; bump(); return o[0] }
    export const f = () => put(x) + put(x)`, []],
  ['a conditional store between', `const x = [1, 2]
    const put = (o, c) => { o[0] = 1; if (c > 0) o[0] = 2; return o[0] }
    export const f = (c) => put(x, c)`, [1]],
  ['a load before the store in a loop body', `const o = [0]
    export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) { s += o[0]; o[0] = s + 1 } return s }`, [5]],
  ['the value local rewritten before the load', `const x = [0, 0]
    export const f = (n) => { let t = n; x[0] = t; t = t + 1; return x[0] + t }`, [3]],
  ['a slot read by a wider access between two stores', `const x = new Float64Array(2), v = new Float64Array(x.buffer)
    export const f = () => { x[0] = 1; const r = v[0]; x[0] = 2; return r + x[0] }`, []],
]

test('store forwarding: what could alias, call or branch keeps the round trip', () => {
  for (const [name, src, args] of cases)
    for (const optimize of levels(0, 2, 3)) agree(src, 'f', args, { optimize }, `${name} at ${optimize}`)
})

// An `if` whose arms only set locals and store: past it the list knows what both arms
// leave, a slot both store holds one value through a local each arm sets beside its
// store, and a pending store both arms overwrite, unread, is dead.
test('store forwarding: a slot both arms of an if store is read from the local they set, and the store they overwrite goes', () => {
  const g = (n) => ['local.get', n], st = (v, off) => off ? ['f64.store', `offset=${off}`, g('$o'), v] : ['f64.store', g('$o'), v]
  const fn = (...body) => ['func', '$f', ['param', '$o', 'i32'], ['param', '$c', 'i32'], ['param', '$x', 'f64'], ['param', '$y', 'f64'], ['local', '$r', 'f64'], ...body]
  const load = ['local.set', '$r', ['f64.load', g('$o')]]
  const f = fn(st(g('$x')), ['if', g('$c'), ['then', st(g('$y'))], ['else', st(['f64.const', 2])]], load)
  forwardStores(f)
  is(f, fn(['local', '$__fj0', 'f64'],
    ['if', g('$c'), ['then', st(g('$y')), ['local.set', '$__fj0', g('$y')]], ['else', st(['f64.const', 2]), ['local.set', '$__fj0', ['f64.const', 2]]]],
    ['local.set', '$r', g('$__fj0')]), 'the first store is dead, the reload reads the joined local')
  const kept = (body, why) => { const before = JSON.stringify(fn(...body)); const h = fn(...JSON.parse(JSON.stringify(body))); forwardStores(h); is(JSON.stringify(h), before, why) }
  kept([st(g('$x')), ['if', g('$c'), ['then', st(g('$y'))]], load], 'one arm stores: the slot holds either value')
  const read = fn(st(g('$x')), ['if', g('$c'), ['then', ['local.set', '$r', ['f64.load', g('$o')]], st(g('$y'))], ['else', st(g('$y'))]], load)
  forwardStores(read)
  is(read[8], st(g('$x')), 'an arm reads the first store: it stays')
  is(read.at(-1), ['local.set', '$r', g('$__fj0')], 'and the reload past the if still reads the joined local')
  kept([st(g('$x')), ['if', g('$c'), ['then', ['call', '$h'], st(g('$y'))], ['else', st(g('$y'))]], load], 'an arm calls')
  // another slot of another name the arms store: its pending store stays, the value forgotten
  const other = fn(st(g('$x'), 8), ['if', g('$c'), ['then', ['f64.store', g('$p'), g('$y')]], ['else', ['f64.store', g('$p'), g('$x')]]], ['local.set', '$r', ['f64.load', 'offset=8', g('$o')]])
  forwardStores(other)
  is(other.at(-1), ['local.set', '$r', ['f64.load', 'offset=8', g('$o')]], 'a store through another name may reach the slot: the reload stays')
})

const quats = `const out = [0, 0, 0, 1], inv = [0, 0, 0, 1]
  const mul = (o, a, b) => { const ax = a[0], aw = a[3], bx = b[0], bw = b[3]; o[0] = ax * bw + aw * bx; o[3] = aw * bw - ax * bx; return o }
  const invert = (o, a) => { const d = a[0] * a[0] + a[3] * a[3]; if (d === 0) { o[0] = 0; o[3] = 0; return o } o[0] = -a[0] / d; o[3] = a[3] / d; return o }
  const qs = [[1, 2, 3, 4], [0, 0, 0, 0], [-2, 1, 0.5, 3]]
  export const f = (n) => { let s = 0; for (let i = 0; i < n; i++) { const q = qs[i % 3]; mul(out, q, q); s += out[0]; invert(inv, q); mul(out, inv, q); s += out[3] } return s + out[0] + inv[3] }`

test('store forwarding: an out parameter an if stores reads back through the joined local', () => {
  for (const optimize of levels(0, 2, 3)) for (const n of [0, 1, 2, 5]) agree(quats, 'f', [n], { optimize }, `n = ${n} at ${optimize}`)
})
