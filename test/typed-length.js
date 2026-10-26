// A typed array's `.length` where the plan knows its element kind, whatever
// the receiver expression (a record's field, a list element): the byte length's
// word shifted by the element width, no __length dispatch
// (module/typedarray.js '__typed_len').
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { belowOpt, levels } from './_matrix.js'
import { funcWat, oracle, wat } from './util.js'

const KINDS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array']

const ring = (K) => `let rings = [5, 7, 11].map(n => ({ b: new ${K}(n), p: 0 }))
  let view = { b: new ${K}(40).subarray(3, 20), p: 0 }
  export let step = (steps) => { let h = 0
    for (let i = 0; i < steps; i++) {
      for (let r of rings) { r.p = (r.p + 1) % r.b.length; h += r.p }
      view.p = (view.p + 2) % view.b.length; h += view.p * 3
    }
    return h + rings[2].b.length * 1000 + view.b.length * 100000 }`

for (const K of KINDS) test(`typed length: a field's ${K} answers its count`, () => {
  const src = ring(K), want = oracle(src).step
  for (const optimize of levels(0, 2, 3)) {
    const { step } = jz(src, { optimize }).exports
    for (const n of [0, 1, 13, 100]) ok(Object.is(step(n), want(n)), `${K} steps=${n} at ${optimize}: ${step(n)} for ${want(n)}`)
  }
})

test('typed length: a field\'s count reads the header, no dispatch', () => {
  if (belowOpt(2)) return
  const body = funcWat(wat(ring('Float64Array'), { optimize: 2 }), 'step')
  ok(!/call \$__length\b/.test(body), 'no __length')
})

test('typed length: a field that may hold a string keeps the dispatch', () => {
  const src = `let recs = [{ b: new Float32Array(6) }, { b: 'abc' }]
    export let f = (i) => recs[i].b.length`
  const want = oracle(src).f
  for (const optimize of levels(0, 2)) {
    const { f } = jz(src, { optimize }).exports
    for (const i of [0, 1]) ok(Object.is(f(i), want(i)), `recs[${i}] at ${optimize}`)
  }
})

test('typed length: a method named length on a receiver that may be a typed array calls the method', () => {
  const src = `const o = { length: (a, b) => a + b }
    export let f = (x) => { const r = x > 1 ? o : x > 0 ? new Float64Array(2) : undefined; return r.length(1, 2) }`
  for (const optimize of levels(0, 2)) ok(jz(src, { optimize }).exports.f(2) === 3, `O${optimize}`)
})

// A typed array a record holds keeps the size it was made with wherever the
// record goes (summary slotShapes): a table read through `({ perm }) =>` at
// `(c & 255) + perm[c + 37 & 255]` needs no bounds test, as the same table
// bound to a name has none, while a store, a size or a holder the compiler
// cannot see keeps the tests.
const table = (edit = '', size = '512') => `const make = (seed) => { const perm = new Uint8Array(${size}); for (let i = 0; i < perm.length; i++) perm[i] = (i * 151 + seed) & 255; return { perm, seed } }
const t = make(7)
const sample = ({ perm }, x) => { let h = 0
  for (let g = -1; g <= 1; g++) { const c = Math.floor(x) + g; h += perm[(c & 255) + perm[c + 37 & 255]] ?? -1 }
  return h }
${edit}
export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += sample(t, i * 0.37 - 20); return s }`
const sampleChecks = (src) => {
  const text = wat(src, { optimize: { level: 2, watr: false } })
  return (funcWat(text, /\(func \$(sample[^\s)]*)/.exec(text)?.[1] ?? 'sample').match(/i32\.lt_u/g) || []).length
}

test('typed length: a field made with one size reads its elements untested', () => {
  const src = table(), want = oracle(src).f
  for (const optimize of levels(0, 2, 3, 'size')) is(jz(src, { optimize }).exports.f(300), want(300), `O${optimize}`)
  if (belowOpt(2)) return
  is(sampleChecks(src), 0, 'no bounds test')
})

test('typed length: a field a store, a size or a holder may change keeps its tests', () => {
  const cases = {
    'a store of another size': table('export let g = (n) => { t.perm = new Uint8Array(n); return t.perm.length }'),
    'a size the walk cannot fix': table('', '(seed & 1) + 300'),
    'a store under a computed name': table('export let g = (k) => { t[k] = new Uint8Array(3); return 1 }'),
    'Object.assign': table('export let g = (n) => { Object.assign(t, { perm: new Uint8Array(n) }); return t.perm.length }'),
    'a shape without the field': table('export let g = (k) => k > 0 ? sample(k > 9 ? { seed: 1 } : t, k) : 0'),
    'the host': table('export const tt = t'),
  }
  for (const [label, src] of Object.entries(cases)) {
    const want = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = jz(src, { optimize }).exports
      if (want.g) is(m.g(5), want.g(5), `${label}: g at O${optimize}`)
      is(m.f(300), want.f(300), `${label}: f at O${optimize}`)
    }
    if (!belowOpt(2)) ok(sampleChecks(src) > 0, `${label}: the reads keep their tests`)
  }
})
