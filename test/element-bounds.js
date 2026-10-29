import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onKernel, levels } from './_matrix.js'
import { funcWat, oracle } from './util.js'

const kernel = (ctor = 'Int32Array', edit = '', extra = '', targetSize = 'size') => `
function fill(indices) {
  for (let i = 0; i < indices.length; i++) indices[i] = i
}
function gather(values, indices) {
  let total = 0
  for (let i = 0; i < indices.length; i++) {
    total += values[indices[i]] ?? -1000
  }
  return total
}
function forward(values, indices) { return gather(values, indices) }
export function run(n, value) {
  const size = n & 511
  const indices = new ${ctor}(size), values = new Float64Array(${targetSize})
  for (let i = 0; i < values.length; i++) values[i] = i * 13 + 5
  fill(indices)
  ${edit}
  return forward(values, indices)
}
${extra}`

const options = level => ({ optimize: { level, sourceInline: false } })
const check = (src, inputs, label) => {
  const native = oracle(src).run
  for (const level of levels(0, 2, 3, 'size')) {
    const run = jz(src, options(level)).exports.run
    for (const args of inputs) is(run(...args), native(...args), `${label}/O${level}: ${args}`)
  }
}
const gatherWat = src => funcWat(compile(src, { optimize: { level: 2, sourceInline: false, watr: false }, wat: true }), 'gather')
// a bounds check: a word against the length, or a key of unknown integrality as its truncation, in i64
const checked = text => /\bi(32|64)\.lt_u\b/.test(text)

test('element bounds: escaped size receivers cannot establish equal allocation lengths', () => {
  if (onKernel()) return
  const src = `function fill(indices) {
    for (let i = 0; i < indices.length; i++) indices[i] = i
  }
  function gather(values, indices) {
    let total = 0
    for (let i = 0; i < indices.length; i++) total += values[indices[i]] ?? -1000
    return total
  }
  export function f(n) {
    const sizes = new Int32Array(n & 511)
    const indices = new Int32Array(sizes.length)
    Object.defineProperty(sizes, 'length', { value: 1 })
    const values = new Float64Array(sizes.length)
    fill(indices)
    return gather(values, indices)
  }`
  // A typed array's storage length is immutable, but its JS .length property
  // can be shadowed. This proof must reject an escaped receiver independently
  // of the emitter's current typed-property reflection behavior.
  ok(checked(gatherWat(src)), 'a repeated .length syntax is not a stable allocation count after escape')
})

test('element bounds: runtime-sized index buffers flow through direct helpers', () => {
  for (const ctor of ['Int32Array', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array']) {
    const src = kernel(ctor)
    check(src, [[0, 0], [1, 0], [1, 0], [2, 0], [257, 0], [511, 0], [0, 0], [2, 0]], ctor)
    if (onKernel()) continue
    const body = gatherWat(src)
    ok(body.includes('f64.load'), `${ctor}: gather remains a load`)
    ok(!checked(body), `${ctor}: matching dynamic lengths remove dependent bounds checks`)
  }
})

test('element bounds: same-buffer copies include missing-read zero', () => {
  const src = kernel('Int32Array', 'indices[0] = indices[value | 0]')
  check(src, [[0, -1], [1, -1], [4, 0], [4, 3], [4, 4], [4, -1], [1, 0]], 'copy')
  if (!onKernel()) ok(!checked(gatherWat(src)), 'copies preserve the index-buffer invariant')
})

test('element bounds: own-index writes preserve bounds only through actual elements', () => {
  const src = kernel('Int32Array', 'const key = +value; indices[key] = key')
  const keys = [-1, -0, 0, Number.MIN_VALUE, 0.5, 1, 3, 4, NaN, Infinity, -Infinity, 4294967296]
  check(src, keys.flatMap(key => [[0, key], [4, key]]), 'element key')
  if (!onKernel()) ok(!checked(gatherWat(src)), 'invalid numeric keys cannot add a non-index element')
})

test('element bounds: incompatible writers, aliases and lengths retain checked reads', () => {
  const sources = [
    kernel('Int8Array'),
    kernel('Int16Array', 'indices[0] = 32768'),
    kernel('Int32Array', 'indices[0] = value'),
    kernel('Int32Array', 'indices[0] += value'),
    kernel('Int32Array', 'change(indices, value)', 'function change(a, v) { a[0] = v }'),
    kernel('Int32Array', 'const alias = new Int32Array(indices.buffer); alias[0] = value'),
    kernel('Int32Array', 'const box = { indices }; change(box, value)', 'function change(box, v) { box.indices[0] = v }'),
    kernel('Int32Array', 'const change = () => { indices[0] = value }; change()'),
    kernel('Int32Array', '', '', 'size ? size - 1 : 0'),
  ]
  for (let i = 0; i < sources.length; i++) {
    check(sources[i], [[0, 0], [1, -1], [4, 3], [4, 4], [4, 511], [257, -1], [1, 0]], `reject ${i}`)
    if (!onKernel()) ok(checked(gatherWat(sources[i])), `reject ${i}: dependent read remains checked`)
  }
})

test('element bounds: an unbounded incoming path and an unseen caller open the proof', () => {
  const mismatch = kernel().replace('return forward(values, indices)', `
    if (value) return forward(new Float64Array(1), indices)
    return forward(values, indices)`)
  const exported = kernel().replace('function gather(', 'export function gather(')
  for (const src of [mismatch, exported]) {
    check(src, [[0, 0], [4, 0], [4, 1], [1, 1], [4, 0]], 'open call')
    if (!onKernel()) ok(checked(gatherWat(src)), 'every incoming receiver must establish the length relation')
  }
})

test('element bounds: recursive alias components close writers but supply no circular length proof', () => {
  const written = kernel('Int32Array', 'change(indices, 2, value)', `
    function change(a, depth, value) {
      if (depth > 0) { change(a, depth - 1, value); return }
      a[0] = value
    }`)
  const circular = kernel().replace('function forward(values, indices) { return gather(values, indices) }', `
    function forward(values, indices, depth) {
      if (depth > 0) return forward(values, indices, depth - 1)
      return gather(values, indices)
    }`).replace('return forward(values, indices)', 'return forward(values, indices, 2)')
  for (const src of [written, circular]) {
    check(src, [[0, 0], [1, -1], [4, 3], [4, 4], [4, 511], [1, 0]], 'recursive aliases')
    if (!onKernel()) ok(checked(gatherWat(src)), 'the unresolved recursive relation remains checked')
  }
})

test('element bounds: zero-work initializers supply no presence or equal-length proof', () => {
  const skippedRead = kernel().replace('let total = 0\n  for (let i = 0; i < indices.length; i++) {\n    total += values[indices[i]] ?? -1000\n  }\n  return total',
    'for (let i = 0; i < indices.length; i++) { var index = indices[i] } return values[index] ?? -1000')
  const laterSize = kernel().replace('const size = n & 511\n  const indices = new Int32Array(size), values = new Float64Array(size)',
    'const values = new Float64Array(size); var size = n & 511; const indices = new Int32Array(size)')
  for (const src of [skippedRead, laterSize]) {
    check(src, [[0, 0], [1, 0], [4, 0], [0, 0], [1, 0]], 'skipped definition')
    if (!onKernel()) ok(checked(gatherWat(src)), 'a definition alone supplies no occurrence proof')
  }
})

test('element bounds: a conditionally initialized receiver keeps its missing-value behavior', () => {
  const src = kernel().replace('const indices = new Int32Array(size), values = new Float64Array(size)',
    'const indices = new Int32Array(size); if (value) { var values = new Float64Array(size) }')
    .replace('for (let i = 0; i < values.length; i++)', 'if (values) for (let i = 0; i < values.length; i++)')
    .replace('return forward(values, indices)', 'try { return forward(values, indices) } catch (e) { return -12345 }')
  check(src, [[0, 0], [1, 0], [4, 1], [4, 0], [0, 0], [1, 1]], 'missing receiver')
})

test('element bounds: compiler reuse keeps allocation relations local to one program', () => {
  if (onKernel()) return
  const good = kernel(), other = kernel('Int32Array', 'indices[0] = value')
  const cold = compile(good, options(2))
  for (const src of [good, good, other, other, good]) {
    compile(src, options(2))
    is(compile(good, options(2)), cold, 'A -> A and A -> different B preserve the original output bytes')
  }
})

test('element bounds: a bitwise key over Numbers names an element of a plain array', () => {
  // `(ix[s] & MASK) * 2` is a 32-bit integer whatever ix holds: the read is an element
  // read, with no own-property path for a key outside the index domain (an array of
  // the cell holds numeric properties: `v[1.5]`)
  const src = `const MASK = 0x0fffffff
const pick = (v, ix, s) => v[(ix[s] & MASK) * 2] + v[((ix[s] >>> 1) ^ 3) % 7]
export let f = (n) => { const v = [], ix = []
  for (let i = 0; i < n; i++) { v.push(i * 0.5, -i); ix.push((n - 1 - i) | 0x80000000) }
  v[1.5] = n
  let t = 0; for (let k = 0; k < n; k++) t += pick(v, ix, k); return t }
export let g = (a, b) => [10, 20, 30, 40][(a | 0) & b] ?? -1`
  const want = oracle(src)
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { optimize }).exports
    for (const n of [0, 1, 5, 40]) is(m.f(n), want.f(n), `f(${n}) at ${optimize}`)
    for (const [a, b] of [[1, 3], [2.5, 3], [-1, 7], [7, 3]]) is(m.g(a, b), want.g(a, b), `g(${a}, ${b}) at ${optimize}`)
  }
  // a negative word is a property name, read as the array holds it
  const neg = `const w = [1, 2, 3]
w[-1] = 9
export let h = (a, b) => w[a & b] + w[~a] * 10`
  const host = oracle(neg).h
  for (const optimize of levels(0, 2, 3)) {
    const h = jz(neg, { optimize }).exports.h
    for (const [a, b] of [[-1, -1], [0, 2], [-2, 1]]) is(h(a, b), host(a, b), `h(${a}, ${b}) at ${optimize}`)
  }
  if (onKernel()) return
  const pick = funcWat(compile(src, { wat: true, optimize: { level: 'speed', sourceInline: false } }), 'pick')
  ok(pick && !/__dyn_get_expr/.test(pick), 'the masked read takes no property path')
})
