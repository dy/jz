import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { hoistInvariantLoop } from '../src/optimize/licm.js'
import { ctx } from '../src/ctx.js'
import { isInactiveFunction } from '../src/compile/active-function.js'
import { parse, walk, loopCount } from '../scripts/wat-probe.mjs'
import { levels, onKernel } from './_matrix.js'
import { oracle } from './util.js'

const scratch = (body, result = 'sum', setup = '') => `export function f(n, k, mode) {
  let data = new Float32Array(6), sum = 0
  const sizes = new Int32Array([0, n, n, 1])
  ${setup}
  for (let g = 0; g < sizes.length; g++) {
    const size = sizes[g]
    if (data.length < size * 3) data = new Float32Array(size * 3)
    for (let z = 0; z < size * 3; z++) data[z] = (z + 1) / 16
    for (let i = 0; i < size; i++) {
      const p = i * 3
      for (let j = i + 1; j < size; j++) {
        const q = j * 3
        ${body}
      }
    }
  }
  return ${result}
}`
const dot = `sum += Math.fround(Math.fround(Math.fround(data[p] * data[q]) +
  Math.fround(data[p + 1] * data[q + 1])) + Math.fround(data[p + 2] * data[q + 2]))`
const innermostLoads = ast => {
  const counts = []
  walk(ast, n => {
    if (n[0] !== 'loop') return
    let nested = false, loads = 0
    for (let i = 2; i < n.length; i++) walk(n[i], x => {
      if (x[0] === 'loop') nested = true
      if (x[0] === 'f32.load') loads++
    })
    if (!nested && loads) counts.push(loads)
  })
  return counts
}

test('LICM loop bounds: guarded scratch cells leave the inner loop and stay inside the outer iteration', () => {
  const source = scratch(dot)
  for (const src of [source, source.replace('export function f(n, k, mode)', 'export const f = (n, k, mode) =>')]) {
    const js = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const run = jz(src, {optimize: level}).exports.f
      if (!onKernel()) ok(isInactiveFunction(ctx), 'ordinary and closure frames restore the metadata demand')
      for (const n of [0, 1, 2, 3, 3, -1, 17, 0, 3]) is(run(n, 0, 0), js(n, 0, 0), `O${level}, n=${n}`)
    }
    if (onKernel()) continue
    const before = innermostLoads(parse(src, {level: 2, watr: false, hoistInvariantLoop: false}))
    const after = innermostLoads(parse(src, {level: 2, watr: false}))
    ok(before.length > 0 && before.every(n => n === 6), 'without motion every inner copy reads both vectors')
    ok(after.some(n => n === 3), 'guarded inner copies retain only the changing vector reads')
    ok(after.some(n => n === 6), 'the unchecked extent keeps the original inner reads')
  }
})

test('LICM loop bounds: zero work and offset boundaries retain the checked result', () => {
  const src = scratch('sum += data[p + k] * data[q]'), js = oracle(src).f
  for (const level of levels(0, 2, 3, 'size')) {
    const run = jz(src, {optimize: level}).exports.f
    for (const n of [0, 1, 3, 0, 5]) for (const k of [-2147483648, -1, 0, 2, 3, 2147483647])
      is(run(n, k, 0), js(n, k, 0), `O${level}, n=${n}, k=${k}`)
  }
})

test('LICM loop bounds: writes, calls and receiver replacement keep each iteration current', () => {
  for (const body of [
    `if (mode) data[p] = j; sum += data[p] * data[q]`,
    `if (mode) edit(data, p, j); sum += data[p] * data[q]`,
    `if (mode && j === i + 1) data = new Float32Array(size * 3); sum += data[p] * data[q]`,
  ]) {
    const src = 'function edit(a, p, v) { a[p] = v }\n' + scratch(body), js = oracle(src).f
    for (const level of levels(0, 2, 3, 'size')) {
      const run = jz(src, {optimize: {level, sourceInline: false}}).exports.f
      for (const n of [0, 1, 3, 3, 5, 0]) for (const mode of [0, 1])
        is(run(n, 0, mode), js(n, 0, mode), `O${level}, n=${n}, mode=${mode}: ${body}`)
    }
  }
})

for (const [name, body] of [
  ['conditional index definitions', `let index; if (mode) index = p; sum += data[index] * data[q]`],
  ['observed assignment results', `sum += data[(last = p)] * data[q]`],
]) test(`LICM loop bounds: ${name} are not speculated`, () => {
  const src = scratch(body, '[sum, last]', 'let last = -7'), js = oracle(src).f
  for (const level of levels(0, 2, 3, 'size')) {
    const run = jz(src, {optimize: level}).exports.f
    for (const n of [0, 1, 3, 0, 1]) for (const mode of [0, 1])
      is(run(n, 0, mode), js(n, 0, mode), `O${level}, n=${n}, mode=${mode}`)
  }
})

test('LICM loop bounds: view offsets and later owned replacements keep their own extents', () => {
  const src = scratch(dot).replace('let data = new Float32Array(6), sum = 0',
    'const backing = new Float32Array(8); let data = backing.subarray(1, 7), sum = 0')
  const js = oracle(src).f
  for (const level of levels(0, 2, 3, 'size')) {
    const run = jz(src, {optimize: level}).exports.f
    for (const n of [0, 1, 2, 7, 7, -1, 0, 3]) is(run(n, 0, 0), js(n, 0, 0), `O${level}, n=${n}`)
  }
})

const raw = ({ owner = 'outer', guard = true, write = '', read = '(f32.load (local.get $a))', tail = '' } = {}) => {
  const ast = parseWat(`(module (memory 1)
    (func $f (export "f") (param $a i32) (param $n i32) (param $m i32) (result f32)
      (local $i i32) (local $j i32) (local $seen i32) (local $s f32)
      (block $done (loop $outer
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (if ${guard ? '(i32.le_u (local.get $a) (i32.const 65532))' : '(i32.const 1)'}
          (then
            (local.set $j (i32.const 0))
            (block $end (loop $inner
              (br_if $end (i32.ge_u (local.get $j) (local.get $m)))
              ${write}
              (local.set $s (f32.add (local.get $s) ${read}))
              (local.set $j (i32.add (local.get $j) (i32.const 1)))
              (br $inner)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $outer)))
      ${tail}(local.get $s)))`)
  let fn, outer, inner, load
  walk(ast, n => {
    if (n[0] === 'func') fn = n
    if (n[0] === 'loop' && n[1] === '$outer') outer = n
    if (n[0] === 'loop' && n[1] === '$inner') inner = n
    if (n[0] === 'f32.load') load = n
  })
  outer.boundsOwner = '$outer'
  inner.boundsOwner = '$inner'
  if (owner) { load.boundsOwner = '$' + owner; fn.hasBoundsOwners = true }
  return {ast, fn, outer, inner}
}
const instantiate = ast => new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports.f

test('LICM loop bounds: strict owner ancestry survives repeated motion and fails closed outside it', () => {
  for (const owner of ['outer', 'inner', 'sibling', null]) {
    const {ast, fn, outer, inner} = raw({owner})
    const before = instantiate(ast)
    hoistInvariantLoop(fn)
    hoistInvariantLoop(fn)
    is(loopCount(inner, n => n[0] === 'f32.load'), owner === 'outer' ? 0 : 1, `${owner}: only a strict ancestor licenses the preheader`)
    is(loopCount(outer, n => n[0] === 'f32.load'), 1, 'the load never crosses its owning loop condition')
    const after = instantiate(ast)
    for (const a of [0, 65532, 65536]) for (const n of [0, 1, 2]) for (const m of [0, 1, 3])
      is(after(a, n, m), before(a, n, m), `${owner}, ${a}/${n}/${m}`)
  }
  const missing = raw()
  delete missing.fn.hasBoundsOwners
  hoistInvariantLoop(missing.fn)
  is(loopCount(missing.inner, n => n[0] === 'f32.load'), 1, 'missing demand metadata fails closed')
  const {ast, fn, inner} = raw({owner: null, guard: false})
  hoistInvariantLoop(fn)
  is(loopCount(inner, n => n[0] === 'f32.load'), 1, 'an unguarded read has no motion license')
  const run = instantiate(ast)
  is(run(65536, 1, 0), 0, 'a zero-trip inner loop keeps the trapping read unevaluated')
  throws(() => run(65536, 1, 1), 'executing the invalid read still traps')
})

test('LICM loop bounds: memory writes and observable address tees block guarded snapshots', () => {
  for (const options of [
    {write: '(f32.store (local.get $a) (f32.convert_i32_u (local.get $j)))'},
    {read: '(f32.load (local.tee $seen (local.get $a)))', tail: '(local.set $s (f32.add (local.get $s) (f32.convert_i32_u (local.get $seen))))'},
  ]) {
    const {ast, fn, inner} = raw(options), before = instantiate(ast)
    hoistInvariantLoop(fn)
    is(loopCount(inner, n => n[0] === 'f32.load'), 1, 'the bounds theorem does not replace effect or private-local proofs')
    const after = instantiate(ast)
    for (const n of [0, 1, 2]) for (const m of [0, 1, 3]) is(after(65532, n, m), before(65532, n, m))
  }
})


test('LICM loop bounds: renamed loop copies keep their proof inside each copy', () => {
  const {ast, fn} = raw()
  const original = fn.find(n => Array.isArray(n) && n[0] === 'block')
  const clone = n => {
    if (!Array.isArray(n)) return typeof n === 'string' && ['$outer', '$inner', '$done', '$end'].includes(n) ? n + '.copy' : n
    const copied = n.map(clone)
    if (n.boundsOwner != null) copied.boundsOwner = n.boundsOwner
    return copied
  }
  const copy = clone(original)
  let inner, outer
  walk(copy, n => {
    if (n[0] === 'loop' && n[1] === '$outer.copy') outer = n
    if (n[0] === 'loop' && n[1] === '$inner.copy') inner = n
  })
  fn.splice(fn.length - 1, 0, ['local.set', '$i', ['i32.const', 0]], ['local.set', '$a', ['i32.const', 65536]], copy)
  const before = instantiate(ast)
  hoistInvariantLoop(fn)
  is(loopCount(inner, n => n[0] === 'f32.load'), 0, 'the copy keeps the same local proof')
  is(loopCount(outer, n => n[0] === 'f32.load'), 1, 'motion stops at the copied owning iteration')
  const after = instantiate(ast)
  for (const n of [0, 1, 3]) for (const m of [0, 1, 3]) is(after(65532, n, m), before(65532, n, m), 'the copied guard rejects its replaced pointer')
})
