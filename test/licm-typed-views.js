import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { hoistInvariantLoop } from '../src/optimize/licm.js'
import { parse, loopCount } from '../scripts/wat-probe.mjs'
import { levels, onKernel } from './_matrix.js'
import { oracle } from './util.js'

const find = (ast, name) => ast.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === name)
const options = level => ({ optimize: { level, sourceInline: false } })

test('LICM typed views: mixed descriptor data and length leave the loop together', () => {
  const src = `function sum(a, n) {
    let total = 0
    for (let i = 0; i < n; i++) { a[i] += 1; total += a[i] }
    return total
  }
  export function f(size, view, n) {
    const storage = new Float64Array(size)
    for (let i = 0; i < size; i++) storage[i] = i + 0.5
    const a = view ? storage.subarray(1, size - 1) : storage
    return [sum(a, n), storage[0], storage[1], storage[size - 1]]
  }`
  const js = oracle(src).f
  for (const level of levels(0, 2, 3, 'size')) {
    const run = jz(src, options(level)).exports.f
    for (const size of [0, 1, 8]) for (const view of [false, true]) for (const n of [0, 1, 4, 9]) {
      is(run(size, view, n), js(size, view, n), `O${level}: ${size}/${view}/${n}`)
      is(run(size, view, n), js(size, view, n), 'repeat with the same instance')
    }
  }
  if (onKernel()) return
  for (const hoist of [false, true]) {
    const fn = find(parse(src, { level: 2, sourceInline: false, watr: false, hoistInvariantLoop: hoist }), '$sum')
    const loads = loopCount(fn, n => n[0] === 'i32.load')
    if (hoist) is(loads, 0, 'both descriptor words are invariant across element stores')
    else ok(loads > 0, 'control: descriptor loads remain when LICM is disabled')
    ok(loopCount(fn, n => n[0] === 'f64.load') > 0, 'element values still reload after writes')
  }
})

test('LICM typed views: absent and reassigned receivers retain execution order', () => {
  const src = `export function f(kind, n, swap) {
    const storage = new Float64Array([3, 5, 7, 11])
    let a = kind === 0 ? storage : kind === 1 ? storage.subarray(1, 3) : null
    let total = 0
    try {
      for (let i = 0; i < n; i++) {
        total += a[0]
        if (swap) a = storage.subarray(2, 4)
      }
    } catch (e) { return [e.name, total] }
    return ['ok', total]
  }`
  const js = oracle(src).f
  for (const level of levels(0, 2, 3, 'size')) {
    const run = jz(src, options(level)).exports.f
    for (const kind of [0, 1, 2]) for (const n of [0, 1, 3]) for (const swap of [false, true])
      is(run(kind, n, swap), js(kind, n, swap), `O${level}: ${kind}/${n}/${swap}`)
  }
})

// These are the two exact emitter expressions, isolated from later folding.
// The full data select is invariant even when address zero changes; its
// eagerly evaluated load on the owned arm is not independently invariant.
const base = name => `(i32.wrap_i64 (i64.and (i64.reinterpret_f64 (local.get ${name})) (i64.const 4294967295)))`
const view = name => `(i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get ${name})) (i64.const 32))) (i32.const 8))`
const data = (a = '$a', b = '$a', c = '$a') => `(select
  (i32.load (select (i32.add ${base(a)} (i32.const 4)) (i32.const 0) ${view(b)}))
  ${base(a)} ${view(c)})`
const length = `(i32.load (select ${base('$a')} (i32.sub ${base('$a')} (i32.const 8)) ${view('$a')}))`
const boxed = bits => {
  const data = new DataView(new ArrayBuffer(8))
  data.setBigUint64(0, BigInt(bits), true)
  return data.getFloat64(0, true)
}
const moduleOf = (expression, present = true, change = '') => {
  const ast = parseWat(`(module (memory 1)
    (func $edit (param $i i32) (i32.store (i32.const 0) (local.get $i)))
    (func $f (export "f") (param $a f64) (param $b f64) (param $n i32) (result i32)
      (local $i i32) (local $sum i32)
      (i32.store (i32.const 24) (i32.const 16))
      (i32.store (i32.const 32) (i32.const 8))
      (i32.store (i32.const 36) (i32.const 64))
      (block $exit (loop $loop
        (br_if $exit (i32.ge_u (local.get $i) (local.get $n)))
        (call $edit (local.get $i))
        ${change}
        (local.set $sum (i32.add (local.get $sum) ${expression}))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
      (local.get $sum)))`)
  const fn = find(ast, '$f')
  if (present) fn.presentTyped = new Set(['$a', '$b'])
  return { ast, fn }
}
const instantiate = ast => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f

test('LICM typed views: the selected immutable word survives calls and mutable address zero', () => {
  for (const expression of [data(), length]) {
    const { ast, fn } = moduleOf(expression)
    const before = instantiate(ast)
    hoistInvariantLoop(fn)
    is(loopCount(fn, n => n[0] === 'i32.load'), 0, 'descriptor word leaves the loop')
    const after = instantiate(ast)
    for (const a of [boxed(32), boxed(8n << 32n | 32n)]) for (const n of [0, 1, 3, 0, 3])
      is(after(a, a, n), before(a, a, n), 'same descriptor, changing element memory, repeated invocation')
  }
})

test('LICM typed views: mismatched selectors and changing receivers are not immutable words', () => {
  for (const [expression, change] of [
    [data('$a', '$b', '$a'), ''],
    [data('$a', '$a', '$b'), ''],
    [data(), '(if (local.get $i) (then (local.set $a (local.get $b))))'],
  ]) {
    const { ast, fn } = moduleOf(expression, true, change)
    const before = instantiate(ast)
    hoistInvariantLoop(fn)
    ok(loopCount(fn, n => n[0] === 'i32.load') > 0, 'unproved descriptor load stays in the loop')
    const after = instantiate(ast)
    for (const [a, b] of [[boxed(32), boxed(8n << 32n | 32n)], [boxed(8n << 32n | 32n), boxed(32)]])
      for (const n of [0, 1, 3]) is(after(a, b, n), before(a, b, n), 'every load and selector keeps its receiver')
  }
})

test('LICM typed views: an unproved descriptor may trap only on an executed iteration', () => {
  for (const expression of [data(), length]) {
    const { ast, fn } = moduleOf(expression, false)
    hoistInvariantLoop(fn)
    ok(loopCount(fn, n => n[0] === 'i32.load') > 0, 'absence of presence proof blocks speculative descriptor load')
    const run = instantiate(ast), invalid = boxed(8n << 32n | 0xfffffff0n)
    is(run(invalid, invalid, 0), 0, 'zero work never reads the invalid descriptor')
    throws(() => run(invalid, invalid, 1), 'an executed invalid descriptor still traps')
  }
})
