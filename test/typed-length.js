// A typed array's `.length` where the plan knows its element kind, whatever
// the receiver expression (a record's field, a list element): the byte length's
// word shifted by the element width, no __length dispatch
// (module/typedarray.js '__typed_len').
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels, onWasi } from './_matrix.js'
import { funcWat, oracle, wat, jz } from './util.js'

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

// A parameter every call passes a typed array of one size holds that size
// (summary paramShapeOf): `a[i & 255]` in `g` needs no bounds test where each
// call passes 256 elements, the table a record's field holds among them once
// the plan passes the field as a parameter of its own (plan/lanes.js). A call
// passing another size, one the walk cannot size or none, a caller it cannot
// see, an assignment of the parameter keep the tests; each answers as the host.
const param = (head, calls) => `const T = new Float64Array(256).fill(2), U = new Float64Array(256).fill(3), V = new Float64Array(100).fill(5)
${head}
export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += ${calls}; return s }`
const gChecks = (src) => { const text = wat(src, { optimize: { level: 2, watr: false, sourceInline: false } }); return (funcWat(text, 'g').match(/i32\.lt_u/g) || []).length }
test('typed length: a parameter every call passes one size reads its elements untested', () => {
  // (the fields of records a function makes: a slot's size, which no name carries)
  const src = param('const mk = (k) => { const a = new Float64Array(256); for (let i = 0; i < 256; i++) a[i] = i * k; return { a } }\nconst R = mk(1), Q = mk(3)\nconst g = (a, i) => a[i & 255]', 'g(R.a, i) + g(Q.a, i * 7)')
  for (const optimize of levels(0, 2, 3, 'size')) is(jz(src, { optimize }).exports.f(300), oracle(src).f(300), `O${optimize}`)
  if (!belowOpt(2)) is(gChecks(src), 0, 'no bounds test')
  const cases = {
    'a call of another size': param('const g = (a, i) => a[i & 255] ?? -1', 'g(T, i) + g(V, i * 7)'),
    'a call of a size the walk cannot fix': param('const g = (a, i) => a[i & 255] ?? -1\nconst W = new Float64Array((Math.random() > 2) + 99)', 'g(T, i) + g(W, i * 7)'),
    'a call that passes none': param('const g = (a = new Float64Array(9), i) => a[i & 255] ?? -1', 'g(T, i) + g(undefined, i * 7)'),
    'an exported function': param('export const g = (a, i) => a[i & 255] ?? -1', 'g(T, i) + g(U, i * 7)'),
    'a function the host holds': param('const g = (a, i) => a[i & 255] ?? -1\nexport const held = () => g', 'g(T, i) + g(U, i * 7)'),
    'an assignment of the parameter': param('const g = (a, i) => { if (i > 200) a = V; return a[i & 255] ?? -1 }', 'g(T, i) + g(U, i * 7)'),
  }
  for (const [label, src] of Object.entries(cases)) {
    const want = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = jz(src, { optimize }).exports
      is(m.f(300), want.f(300), `${label}: f at O${optimize}`)
      // (a host array of 100 read at 250: none on WASI, which passes no host array)
      const host = () => new Float64Array(100).fill(5)
      if (want.g && !onWasi()) is(m.g(host(), 250), want.g(host(), 250), `${label}: the host's call at O${optimize}`)
      if (want.held && !onWasi()) is(m.held()(host(), 250), want.held()(host(), 250), `${label}: the held function at O${optimize}`)
    }
    if (!belowOpt(2)) ok(gChecks(src) > 0, `${label}: the reads keep their tests`)
  }
})

// `X.from(array)` and `new X(array)` make an element for each of the array's: a
// literal's count, or a cell's fixed length (summary typedShapeOf).
test('typed length: a typed array built from an array of one count has that count', async () => {
  const { ctx } = await import('../src/ctx.js')
  const { compileInProcess } = await import('./util.js')
  const len = (src) => { compileInProcess(src, { host: 'js', optimize: 0 }); return ctx.summary.at(null).typedLenOf('T') }
  is(len(`const T = Int32Array.from([1, 2, 3])\nexport const f = (i) => T[i & 3]`), 3, 'from a literal')
  is(len(`const A = [1, 2, 3, 4].map(x => x * 2), T = Float64Array.from(A)\nexport const f = (i) => T[i & 3]`), 4, 'from a mapped array')
  is(len(`const T = new Uint8Array([1, 2])\nexport const f = (i) => T[i & 1]`), 2, 'constructed from a literal')
  is(len(`const A = [1, 2]\nexport const g = (v) => A.push(v)\nconst T = Int16Array.from(A)\nexport const f = (i) => T[i & 1]`), null, 'from an array a push may resize')
  const src = `const T = Int32Array.from([5, 6, 7])\nexport const f = (i) => T.length * 10 + T[i % 3]`
  for (const optimize of levels(0, 2)) is(jz(src, { optimize }).exports.f(4), oracle(src).f(4), `the count and an element at ${optimize}`)
})
