import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { hoistInvariantLoop } from '../src/optimize/licm.js'
import { parse, walk, loopCount } from '../scripts/wat-probe.mjs'
import { levels, onKernel } from './_matrix.js'
import { oracle } from './util.js'

const find = (ast, name) => ast.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === name)
const options = level => ({ optimize: { level, sourceInline: false } })

test('LICM Float32: fixed distinct input cells have the same motion as Float64', () => {
  for (const width of [32, 64]) {
    const src = `function kernel(a, out, n) {
      let s = 0
      for (let i = 0; i < n; i++) { out[i] = i; s += a[1] * i }
      return s
    }
    export function f(n) {
      const a = new Float${width}Array(3)
      a[0] = 1; a[1] = 2; a[2] = 3
      const out = new Float${width}Array(64)
      return kernel(a, out, n)
    }`
    const js = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const run = jz(src, options(level)).exports.f
      for (const n of [0, 1, 64, 75, 0, 64]) is(run(n), js(n), `Float${width} O${level}, n=${n}`)
    }
    if (onKernel()) continue
    for (const hoist of [false, true]) {
      const fn = find(parse(src, { level: 2, sourceInline: false, watr: false, hoistInvariantLoop: hoist }), '$kernel')
      const loads = loopCount(fn, n => n[0] === `f${width}.load`)
      if (hoist) is(loads, 0, `Float${width}: invariant cell leaves the loop`)
      else ok(loads > 0, `Float${width}: control retains the load without LICM`)
    }
  }
})

test('LICM: address origins pass through conversion scratch, retaining unknown effects', () => {
  if (onKernel()) return // Exercises the host IR pass and its proof metadata.
  const staged = `(block (result i32) (local.set $scratch (local.get $i))
    (select (i32.trunc_sat_f64_s (local.get $scratch)) (i32.const -1)
      (f64.eq (local.get $scratch) (local.get $scratch))))`
  const teed = `(block (result i32)
    (select (i32.trunc_sat_f64_s (local.tee $scratch (local.get $i))) (i32.const -1)
      (f64.eq (local.get $scratch) (local.get $scratch))))`
  for (const width of [32, 64]) for (const [name, offset, hoists] of [
    ['set', staged, true], ['tee', teed, true],
    ['load', '(block (result i32) (local.set $k (i32.load (i32.const 0))) (local.get $k))', false],
    ['call', '(block (result i32) (local.set $k (call $offset)) (local.get $k))', false],
    ['overwrite', '(block (result i32) (local.set $b (local.get $a)) (i32.const 0))', false],
  ]) {
    const lane = `f${width}`, value = width === 32 ? '(f32.demote_f64 (local.get $value))' : '(local.get $value)'
    const read = `(${lane}.load (local.get $a))`, answer = width === 32 ? `(f64.promote_f32 ${read})` : read
    const ast = parseWat(`(module (memory 1)
      (func $offset (result i32) (i32.const 0))
      (func $f (export "f") (param $a i32) (param $b i32) (param $n i32) (param $value f64) (result f64)
        (local $i f64) (local $scratch f64) (local $k i32) (local $sum f64)
        (${lane}.store (local.get $a) ${value})
        (block $exit (loop $loop
          (br_if $exit (f64.ge (local.get $i) (f64.convert_i32_s (local.get $n))))
          (${lane}.store (i32.add (local.get $b) (i32.shl ${offset} (i32.const ${width === 32 ? 2 : 3})))
            ${width === 32 ? '(f32.demote_f64 (local.get $i))' : '(local.get $i)'})
          (local.set $sum (f64.add (local.get $sum) ${answer}))
          (local.set $i (f64.add (local.get $i) (f64.const 1))) (br $loop)))
        (local.get $sum)))`)
    const fn = find(ast, '$f'), before = instantiate(ast)
    fn.distinctParams = new Set(['$a', '$b'])
    fn.fixedTypedBytes = new Map([['$a', width / 8]])
    hoistInvariantLoop(fn)
    const loads = loopCount(fn, n => n[0] === `${lane}.load`)
    is(loads, hoists ? 0 : 1, `${lane} ${name}: only a closed numeric origin permits the hoist`)
    const after = instantiate(ast)
    for (const count of [0, 1, 4, 4, 0, 2]) for (const v of [-0, 0, 1.25, -3, Infinity, -Infinity, NaN])
      ok(Object.is(after(32, 128, count, v), before(32, 128, count, v)), `${lane} ${name}, ${count}/${v}`)
  }
})

test('LICM Float32: a read-only helper needs an extent but no pairwise alias relation', () => {
  const src = `function kernel(a, n) {
    let s = 0
    for (let i = 0; i < n; i++) s += a[2] * i
    return s
  }
  export function f(n) {
    const a = new Float32Array(3)
    a[2] = -0.25
    return kernel(a, n)
  }`
  const js = oracle(src).f
  for (const level of levels(0, 2, 3, 'size')) {
    const run = jz(src, options(level)).exports.f
    for (const n of [0, 1, 6, 0, 6]) is(run(n), js(n), `O${level}, n=${n}`)
  }
  if (onKernel()) return
  const fn = find(parse(src, { level: 2, sourceInline: false, watr: false }), '$kernel')
  is(loopCount(fn, n => n[0] === 'f32.load'), 0, 'a read-only loop cannot change the proven cell')
})

test('LICM Float32: empty, nullable, view and alias receivers preserve conditional reads and writes', () => {
  const src = `function kernel(a, out, n, k, limit) {
    let s = 0
    try {
      for (let i = 0; i < n; i++) {
        out[1] = i + 1
        if (i < limit) s += a[k] * (i + 1)
      }
    } catch (e) { return [e.name, s, out[1]] }
    return ['ok', s, out[1]]
  }
  export function f(mode, n, k, limit) {
    const storage = new Float32Array(4)
    storage[0] = 2; storage[1] = 3; storage[2] = 5; storage[3] = 7
    const a = mode === 1 ? storage.subarray(1, 3) : mode === 2 ? new Float32Array(0) : mode === 3 ? null : storage
    const out = mode === 4 ? storage : new Float32Array(4)
    return kernel(a, out, n, k, limit)
  }`
  const js = oracle(src).f
  for (const level of levels(0, 2, 3, 'size')) {
    const run = jz(src, options(level)).exports.f
    for (const mode of [0, 1, 2, 3, 4]) for (const n of [0, 1, 3]) for (const k of [-1, 0, 1, 4]) for (const limit of [0, 2])
      is(run(mode, n, k, limit), js(mode, n, k, limit), `O${level}: ${mode}/${n}/${k}/${limit}`)
  }
})

test('LICM Float32: rebinding and callee writes invalidate a cell snapshot', () => {
  const src = `function edit(a, i) { a[1] = i + 10 }
  function kernel(a, b, n, mode) {
    let s = 0
    for (let i = 0; i < n; i++) {
      if (mode === 1 && i === 1) a = b
      if (mode === 2) edit(a, i)
      s += a[1]
    }
    return [s, a[1], b[1]]
  }
  export function f(n, mode) {
    const a = new Float32Array(3), b = new Float32Array(3)
    a[1] = 2; b[1] = 7
    return kernel(a, b, n, mode)
  }`
  const js = oracle(src).f
  for (const level of levels(0, 2, 3, 'size')) {
    const run = jz(src, options(level)).exports.f
    for (const n of [0, 1, 3, 0, 3]) for (const mode of [0, 1, 2])
      is(run(n, mode), js(n, mode), `O${level}: ${n}/${mode}`)
  }
})

const rawLoad = ({ offset = 0, bytes = 4, change = '', write = '', marked = true, address = '(local.get $a)' } = {}) => {
  const ast = parseWat(`(module (memory 1)
    (func $f (export "f") (param $a i32) (param $b i32) (param $n i32) (result f32)
      (local $i i32) (local $s f32)
      (block $exit (loop $loop
        (br_if $exit (i32.ge_u (local.get $i) (local.get $n)))
        ${change}${write}
        (local.set $s (f32.add (local.get $s) (f32.load offset=${offset} ${address})))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
      (local.get $s)))`)
  const fn = find(ast, '$f')
  fn.distinctParams = new Set(['$a', '$b'])
  if (marked) fn.fixedTypedBytes = new Map([['$a', bytes]])
  return { ast, fn }
}
const instantiate = ast => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f

test('LICM Float32: extent proof preserves zero-work and conditional trapping', () => {
  for (const args of [{ marked: false }, { bytes: 0 }, { offset: 4 }, { offset: 65536 }]) {
    const { ast, fn } = rawLoad(args), before = instantiate(ast)
    hoistInvariantLoop(fn)
    ok(loopCount(fn, n => n[0] === 'f32.load') > 0, 'unknown or out-of-extent load is not speculated')
    const after = instantiate(ast)
    const at = args.offset ? 65532 : 65536
    is(after(at, 0, 0), before(at, 0, 0), 'zero work does not execute a trapping read')
    throws(() => after(at, 0, 1), 'an executed invalid read still traps')
  }
  for (const [address, at] of [
    ['(i32.add (local.get $a) (i32.const -4))', 0],
    ['(i32.add (local.get $a) (i32.const 0x1_0000))', 65532],
  ]) {
    const { ast, fn } = rawLoad({ address })
    hoistInvariantLoop(fn)
    ok(loopCount(fn, n => n[0] === 'f32.load') > 0, 'negative and unrecognized constant displacements fail closed')
    const run = instantiate(ast)
    is(run(at, 0, 0), 0, 'zero work keeps its access unevaluated')
    throws(() => run(at, 0, 1), 'out-of-memory displacement traps only when reached')
  }
  for (const args of [
    { change: '(local.set $a (local.get $b))' },
    { write: '(f32.store (local.get $a) (f32.const 3))' },
  ]) {
    const { ast, fn } = rawLoad(args), before = instantiate(ast)
    hoistInvariantLoop(fn)
    ok(loopCount(fn, n => n[0] === 'f32.load') > 0, 'rebound or written cell stays in the loop')
    const after = instantiate(ast)
    for (const n of [0, 1, 3]) is(after(65532, 0, n), before(65532, 0, n), 'same operation order')
  }
  const { ast, fn } = rawLoad(), before = instantiate(ast)
  hoistInvariantLoop(fn)
  is(loopCount(fn, n => n[0] === 'f32.load'), 0, 'a present last cell fits exactly')
  const after = instantiate(ast)
  for (const n of [0, 1, 3]) is(after(65532, 0, n), before(65532, 0, n), 'the exact final boundary is addressable')
})

test('LICM Float32: rounded invariant expressions retain signed zero, NaN and infinities', () => {
  const { ast, fn } = rawLoad()
  fn.splice(6, 0, ['param', '$value', 'f32'])
  const start = fn.findIndex(n => n?.[0] === 'block')
  fn.splice(start, 0, ['f32.store', ['i32.const', 65532], ['local.get', '$value']])
  walk(fn, n => {
    if (n[0] === 'local.set' && n[1] === '$s') n[2] = ['f32.sqrt', n[2][2]]
  })
  const before = instantiate(ast)
  hoistInvariantLoop(fn)
  is(loopCount(fn, n => n[0] === 'f32.sqrt'), 0, 'the rounded expression leaves as one invariant')
  const after = instantiate(ast)
  for (const value of [-0, 0, -4, 4, Infinity, -Infinity, NaN]) for (const n of [0, 1, 3])
    ok(Object.is(after(65532, 0, n, value), before(65532, 0, n, value)), `${value}, n=${n}: exact Number result`)
})
