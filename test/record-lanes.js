// A reduction over the fields of records held k elements to a record in one array (`pts[2 * o + 2 * i]`,
// `pts[2 * o + 2 * i + 1]`: points, colors, complex numbers) lifts in the exact reduction tier
// (optimize/vectorize/reduce.js tryReduceBitExact): a field's two lanes are the reads of two
// passes, 8k bytes apart, each its own load (the address once), the work of each element in
// lanes and each accumulator's lanes added in the loop's order, so the answer is JavaScript's at
// every level. So does a reduction whose body holds an inlined helper's value block. Its
// population over the strides, the fields, the lengths and the holders:
// test/record-lanes-population.js.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { run, oracle, wat } from './util.js'
import { ownedLevels } from './_matrix.js'

const LEVELS = ownedLevels(false, true, 'size', { level: 'speed', relaxedFloat: false }, 'speed')
const name = (o) => JSON.stringify(o)
// (a record's lanes in the module, a kernel's loop at 'speed' perhaps in a split of main: a block's
// shuffles where every field is read, a gather's second lanes where one is)
const shuffles = (src, optimize) => (wat(src, { optimize }).match(/i8x16\.shuffle/g) || []).length
const gathers = (src, optimize) => (wat(src, { optimize }).match(/f64x2\.replace_lane/g) || []).length

// (records of k fields; R records of K points each, the record base o = r * K: the bounds proven)
const fit = (k, fields, body) => `const R = 6, K = 37
const pts = new Float64Array(R * K * ${k}), u = new Float64Array(K), out = new Float64Array(R * 4)
export let main = () => {
  for (let i = 0; i < pts.length; i++) pts[i] = ((i * 37) % 23 - 11) * 0.125 + i * 1e-3
  for (let i = 0; i < K; i++) u[i] = i / (K - 1)
  for (let r = 0; r < R; r++) {
    const o = r * K
    let s0 = 0, s1 = 0, s2 = 0
    for (let i = 0; i < K; i++) {
      const t = u[i]
      ${body}
    }
    out[r * 4] = s0; out[r * 4 + 1] = s1; out[r * 4 + 2] = s2
  }
  let h = 0
  for (let i = 0; i < out.length; i++) h = h * 0.5 + out[i]
  return h
}`

test('record lanes: two fields of a record beside a stride-1 read lift, as Node at every level', () => {
  const src = fit(2, 2, `const x = pts[(o + i) * 2], y = pts[(o + i) * 2 + 1]
      s0 += t * x; s1 += t * y; s2 += x * y`)
  const want = oracle(src).main()
  for (const optimize of LEVELS) is(run(src, { optimize }).main(), want, `${name(optimize)}: as Node`)
  for (const optimize of ownedLevels(true, 'speed')) ok(shuffles(src, optimize) >= 2, `${name(optimize)}: two fields, two shuffles`)
})

test('record lanes: a field of records of three, four and eight', () => {
  for (const [k, j] of [[3, 2], [4, 1], [8, 7]]) {
    const src = fit(k, 1, `const x = pts[(o + i) * ${k} + ${j}]
      s0 += t * x; s1 += x * x`)
    const want = oracle(src).main()
    for (const optimize of LEVELS) is(run(src, { optimize }).main(), want, `k ${k}, field ${j}, ${name(optimize)}: as Node`)
    for (const optimize of ownedLevels(true, 'speed')) ok(gathers(src, optimize) > 0, `k ${k}, ${name(optimize)}: the field gathered`)
  }
})

test('record lanes: an inlined helper\'s value block in a reduction lifts, as Node at every level', () => {
  const src = `const b1 = (t) => { const u = 1.0 - t; return 3.0 * t * u * u }
const b2 = (t) => { const u = 1.0 - t; return 3.0 * t * t * u }
${fit(2, 2, `const a = b1(t) * pts[(o + i) * 2], c = b2(t) * pts[(o + i) * 2 + 1]
      s0 += a * a; s1 += a * c; s2 += c * c`)}`
  const want = oracle(src).main()
  for (const optimize of LEVELS) is(run(src, { optimize }).main(), want, `${name(optimize)}: as Node`)
  for (const optimize of ownedLevels(true, 'speed')) ok(shuffles(src, optimize) >= 2, `${name(optimize)}: two fields, two shuffles`)
})

// What stays as written: an index local is an address's value only where it is written once in a
// pass, ahead of the reads, outside a conditional (addr-model.js affineAddr's tees, indexDefs); a
// value block lifts only as sets of f64 locals then its value, nothing that branches out of it
// (a helper's early return) or writes anything else (a global).
test('record lanes: what an index local or a value block may not do keeps the loop as written', () => {
  const rows = [
    ['an index written twice in a pass', `let j = o + i; const x = pts[j * 2]; j = j + 1; const y = pts[j * 2 - 1]
      s0 += t * x; s1 += t * y; s2 += x * y`],
    ['an index read ahead of its write', `const x = pts[j * 2], y = pts[j * 2 + 1]; j = o + i + 1
      s0 += t * x; s1 += t * y; s2 += x * y`],
    ['a field chosen by a condition', `const x = t > 0.5 ? pts[(o + i) * 2] : pts[(o + i) * 2 + 1]
      s0 += t * x; s1 += x * x; s2 += x`],
    ['a helper returning early', `const x = early(t) * pts[(o + i) * 2], y = early(1 - t) * pts[(o + i) * 2 + 1]
      s0 += x * x; s1 += x * y; s2 += y * y`],
    ['a helper writing a global', `const x = noted(t) * pts[(o + i) * 2], y = noted(1 - t) * pts[(o + i) * 2 + 1]
      s0 += x * x; s1 += x * y; s2 += y * y`],
  ]
  for (const [label, body] of rows) {
    const src = `const early = (t) => { if (t > 0.5) return 1.0 - t; return t * t }
let seen = 0
const noted = (t) => { seen = t; return t * 3.0 }
${fit(2, 2, body).replace('let s0 = 0, s1 = 0, s2 = 0', 'let s0 = 0, s1 = 0, s2 = 0, j = o')}`
    const want = oracle(src).main()
    for (const optimize of LEVELS) is(run(src, { optimize }).main(), want, `${label}, ${name(optimize)}: as Node`)
    for (const optimize of ownedLevels(true, 'speed')) is(shuffles(src, optimize) + gathers(src, optimize), 0, `${label}, ${name(optimize)}: no record lanes`)
  }
})

// An address tee: the emitter tees the index a pass shares at its first read and reads the local
// at the next (`px[o + i]` then `py[o + i]`, `pts[2 * (o + i)]` then `pts[2 * (o + i) + 1]`); the
// lifts read the local as its value (addr-model.js addressTees: an i32 local written once by a tee
// the pass runs, read nowhere ahead of it). Maps and reductions alike, as Node at every level.
const offsets = (body) => `const R = 6, K = 37
const px = new Float64Array(R * K), py = new Float64Array(R * K), pts = new Float64Array(R * K * 2), u = new Float64Array(K), out = new Float64Array(R * K)
export let main = () => {
  for (let i = 0; i < R * K; i++) { px[i] = (i % 17) * 0.25 - 2; py[i] = (i % 13) * 0.5 - 3; pts[2 * i] = px[i] * 0.75; pts[2 * i + 1] = py[i] + 0.125 }
  for (let i = 0; i < K; i++) u[i] = (i + 1) / (K + 1)
  let h = 0
  for (let r = 0; r < R; r++) {
    const o = r * K
    let s0 = 0, s1 = 0
    for (let i = 0; i < K; i++) {
      const t = u[i], w = 1 - t
      ${body}
    }
    h = h * 0.5 + s0 + s1 * 0.25
  }
  for (let i = 0; i < out.length; i++) h = h * 0.5 + out[i]
  return h
}`
const vectors = (src, optimize) => (wat(src, { optimize }).match(/f64x2\.(mul|add|sub)/g) || []).length
test('record lanes: two arrays read at one runtime offset, and a map over records', () => {
  const rows = [
    ['a reduction over two arrays at o + i', `const x = px[o + i] * t, y = py[o + i] * w; s0 += x * y; s1 += x * x - y * w`, null],
    ['a map over two arrays at o + i', `out[o + i] = px[o + i] * t * w + py[o + i] * t * t`, null],
    ['a map from a record at o + i', `out[o + i] = pts[(o + i) * 2] * t * w + pts[(o + i) * 2 + 1] * t * t`, 'gather'],
  ]
  for (const [label, body, form] of rows) {
    const src = offsets(body), want = oracle(src).main()
    for (const optimize of LEVELS) is(run(src, { optimize }).main(), want, `${label}, ${name(optimize)}: as Node`)
    for (const optimize of ownedLevels(true, 'speed')) ok((form ? gathers(src, optimize) : vectors(src, optimize)) > 0, `${label}, ${name(optimize)}: lanes`)
  }
})
