// The public compile options: eleven keys, with the memory and optimize objects
// folding onto the internal flags (index.js normalizeOptions).
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { belowOpt, levels } from './_matrix.js'

const flat = s => s.replace(/\s+/g, ' ')
const HEAP = 'export let f = (n) => { let a = new Float64Array(n); a[0] = 1.5; return a[0] }'
const LOOP = 'export let f = (n) => { let a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = a[i] * 2; return a[0] }'
const TAIL = 'export let sum = (n, acc) => n === 0 ? acc : sum(n - 1, acc + n)'
const GROW = 'export let f = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(i); return a }'
const THROW = 'export let f = (x) => { if (x < 0) throw new RangeError("neg"); return x }'
const DEP = 'export let f = (n) => { let a = new Float64Array(n); for (let i = 1; i < n; i++) a[i] = a[i - 1] + 1; return a[0] }'

test('options: define preserves scalar values, property names and sparse array length', () => {
  const shared = { 'a-b': 7 }, value = {
    '': null, 'a-b': -0, 'quote"\\': 'α😀', left: shared, right: shared,
    ['__proto__']: 13, slots: [, undefined, ,],
  }
  const src = `export const f = () => [K[''] === null, 1 / K['a-b'], K['quote"\\\\'],
    K.left['a-b'], K.right['a-b'], K['__proto__'], K.slots.length,
    K.slots[0] === undefined, K.slots[2] === undefined, 0 in K.slots, 2 in K.slots]`
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const f = jz(src, { define: { K: value }, optimize }).exports.f
    const expected = [true, -Infinity, 'α😀', 7, 7, 13, 3, true, true, true, true]
    is(f(), expected, `literal fields, O${optimize}`)
    is(f(), expected, `same instance again, O${optimize}`)
    for (const K of [undefined, null, true, false, 0, -0, NaN, Infinity, -Infinity, '', 'α😀']) {
      const actual = jz('export const f = () => K', { define: { K }, optimize }).exports.f()
      ok(Object.is(actual, K), `scalar ${String(K)}, O${optimize}`)
    }
    for (const K of [[], [,], [,,], [1,,], []]) {
      const f = jz('export const f = () => [K.length, K[K.length - 1] === undefined]', { define: { K }, optimize }).exports.f
      is(f(), [K.length, K[K.length - 1] === undefined], `empty/trailing holes, O${optimize}`)
    }
  }
})

test('options: define rejects cycles and nonliteral values, then compiles again', () => {
  const object = {}, array = []
  object.self = object; array.push(array)
  let reads = 0
  const accessor = { get x() { reads++; return 1 } }
  for (const K of [object, array, new Date(0), new Map(), new Float64Array(1), { fn() {} }, accessor]) {
    throws(() => compile('export const f = () => K', { define: { K } }), /not a compile-time constant/)
    is(jz('export const f = () => K', { define: { K: { x: 9 } } }).exports.f(), { x: 9 }, 'valid input after rejection')
  }
  is(reads, 0, 'reject accessors without executing them')
})

test('template constants preserve literal values at operator and property boundaries', () => {
  is(jz`export const f = () => 1-${-1}`.exports.f(), 2, 'subtraction before a negative value')
  is(jz`export const f = () => 1/${-0}`.exports.f(), -Infinity, 'negative zero')
  is(jz`export const f = () => !${false}`.exports.f(), true, 'boolean operand')
  const data = { 'a-b': 7, text: 'α😀', slots: [,] }
  const f = jz`export const f = () => { const k = ${data}; return [k['a-b'], k.text, k.slots.length] }`.exports.f
  is(f(), [7, 'α😀', 1])
  is(f(), [7, 'α😀', 1], 'repeat')
})

test('options: memory descriptor sets initial and maximum pages', () => {
  const wat = flat(compile(HEAP, { wat: true, memory: { initial: 4, maximum: 16 } }))
  ok(wat.includes('(memory (export "memory") 4 16'), 'min/max on the exported memory')
  throws(() => compile(HEAP, { memory: { initial: 10, maximum: 4 } }), /below the initial/)
})

test('options: invalid memory limits reject before encoding and leave later compiles intact', () => {
  for (const initial of [NaN, Infinity, -Infinity, -1, 0.5, 65537, '2', true]) {
    for (const memory of [initial, { initial }])
      throws(() => compile(HEAP, { memory }), /non-negative integer page count/, `initial ${String(initial)}`)
  }
  for (const maximum of [NaN, Infinity, -Infinity, -1, 0, 0.5, 65537, '2', true])
    throws(() => compile(HEAP, { memory: { maximum } }), /positive integer page count/, `maximum ${String(maximum)}`)
  // Zero requests no extra pages; runtime storage still supplies its minimum.
  for (const initial of [0, 1, 1, 2, 0]) {
    const p = jz(HEAP, { memory: { initial, maximum: 4 } })
    is(p.memory.buffer.byteLength, Math.max(1, initial) * 65536)
    is(p.exports.f(1), 1.5)
  }
  ok(flat(compile(HEAP, { wat: true, memory: { initial: 65536, maximum: 65536 } })).includes('65536 65536'), 'the wasm32 upper boundary remains valid without allocating it in the test')
  is(jz(HEAP).exports.f(1), 1.5, 'default options after explicit limits and rejected values')
})

test('options: memory descriptor imports env.memory', () => {
  const wat = flat(compile(HEAP, { wat: true, memory: { initial: 2, import: true } }))
  ok(wat.includes('(import "env" "memory" (memory 2'), 'memory imported from env')
})

test('options: static data must fit memory.maximum before emitting a module', () => {
  const literal = 'x'.repeat(40000)
  const src = `export function f(){return ${JSON.stringify(literal)}}`
  for (const maximum of [1, 1, 2, 2, 1, 2]) {
    if (maximum === 1) throws(() => compile(src, { memory: { maximum } }), /exceeding memory.maximum/)
    else {
      const p = jz(src, { memory: { maximum } })
      is(p.exports.f(), literal, 'large data fits two pages')
      is(p.exports.f(), literal, 'same instance preserves its data')
      is(p.memory.buffer.byteLength, 2 * 65536)
    }
  }
  is(jz('export function f(){return "ok"}', { memory: { maximum: 1 } }).exports.f(), 'ok', 'small data after rejected large data')
  is(jz(src).exports.f(), literal, 'ordinary compilation after a limited one')
})

test('options: shared memory, by descriptor or by a shared Memory object', () => {
  const byDesc = flat(compile(HEAP, { wat: true, memory: { initial: 2, maximum: 8, shared: true } }))
  ok(/\(import "env" "memory" \(memory [^)]*shared/.test(byDesc), 'descriptor links the shared memtype')
  const mem = new WebAssembly.Memory({ initial: 2, maximum: 8, shared: true })
  const byObject = flat(compile(HEAP, { wat: true, memory: mem }))
  ok(/\(import "env" "memory" \(memory [^)]*shared/.test(byObject), 'a shared Memory object is detected')
})

test('options: optimize object — simd:false leaves no v128', () => {
  if (belowOpt(2)) return
  ok(/v128|f64x2/.test(compile(LOOP, { wat: true })), 'default vectorizes (sanity)')
  ok(!/v128|f64x2|i32x4|f32x4/.test(compile(LOOP, { wat: true, optimize: { simd: false } })), 'simd:false is scalar')
})

test('options: optimize object — tailCall:false uses ordinary call frames', () => {
  ok(/return_call/.test(compile(TAIL, { wat: true })), 'default emits return_call (sanity)')
  ok(!/return_call/.test(compile(TAIL, { wat: true, optimize: { tailCall: false } })), 'tailCall:false')
})

test('options: optimize object — exceptions:false drops the exceptions tag', () => {
  ok(/\(tag /.test(compile(THROW, { wat: true })), 'a bare throw keeps the tag by default')
  const wat = compile(THROW, { wat: true, optimize: { exceptions: false } })
  ok(!/\(tag /.test(wat) && /unreachable/.test(wat), 'exceptions:false traps instead')
})

test('options: optimize object — alloc:false omits the allocator exports', () => {
  const wat = compile(GROW, { wat: true })
  ok(/\(export "_alloc"/.test(wat) || /\(export "_clear"/.test(wat), 'a growing array exports the allocator (sanity)')
  const raw = compile(GROW, { wat: true, optimize: { alloc: false } })
  ok(!/\(export "_alloc"/.test(raw) && !/\(export "_clear"/.test(raw), 'alloc:false is the raw ABI')
})

test('options: optimize object — level and pass keys, unknown key refused', () => {
  ok(compile(LOOP, { optimize: { level: 'size' } }).byteLength > 0, 'level:size')
  ok(compile(LOOP, { optimize: { level: 'speed', stencil: false } }).byteLength > 0, 'pass override')
  throws(() => compile(LOOP, { optimize: { levle: 'size' } }), /Unknown optimize key/)
})

test('options: why reports declined loops through warnings, sink or callback', () => {
  if (belowOpt(2)) return
  const warnings = { entries: [] }
  compile(DEP, { why: true, warnings })
  ok(warnings.entries.some(w => w.code === 'simd-why-not' || w.code === 'rewind-why-not'), warnings.entries.map(w => w.code).join(','))
  const seen = []
  compile(DEP, { why: true, warnings: w => seen.push(w.code) })
  ok(seen.length > 0, 'a warnings callback receives each entry')
  const { warnings: entries } = jz(DEP, { why: true })
  ok(Array.isArray(entries) && entries.length > 0, 'jz() exposes the entries it collected')
})

test('options: the caller\'s option object is left untouched', () => {
  const opts = { memory: { initial: 2 }, optimize: { simd: false } }
  compile(HEAP, opts)
  is(JSON.stringify(opts), '{"memory":{"initial":2},"optimize":{"simd":false}}')
})

// A warnings callback runs after the compilation that recorded the entries,
// so it may compile; a callback that runs during compilation (whyNotRewind)
// may not, and says so.
test('options: warning callbacks run after compilation; a nested compile during one is rejected', () => {
  const src = `export let f = (o) => { let s = 0; for (const k in o) s += o[k]; return s }`
  const seen = []
  const wasm = compile(src, { warnings: (w) => { seen.push(w.code); compile('export let g = () => 1') } })
  ok(wasm.length > 0 && seen.length > 0, 'the callback compiled again once its own compilation was over')
  const again = compile(src, { warnings: { entries: [] } })
  is(again.length, wasm.length, 'the nested compile left the outer output intact')
  let error
  try { compile('let kept=[];export let f=n=>{kept.push([n]);return kept.length}', { optimize: 'speed', whyNotRewind: () => { compile('export let g = () => 1') } }) } catch (e) { error = e }
  ok(error && /while a compilation is active/.test(error.message), `nested compile rejected: ${error?.message}`)
})
