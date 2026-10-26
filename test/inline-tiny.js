// A function of a few instructions joins every caller at the speed tier (optimize/inline-tiny.js):
// V8's baseline tier pays a frame for every call and inlines nothing. These pin the splice on
// hand-written modules, then the speed tier end to end.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import parseWat from 'watr/parse'
import compileWat from 'watr/compile'
import jz, { compile } from '../index.js'
import { inlineTiny } from '../src/optimize/inline-tiny.js'
import { onKernel } from './_matrix.js'
import { oracle } from './util.js'

const run = (mod) => new WebAssembly.Instance(new WebAssembly.Module(compileWat(mod))).exports
const funcs = (mod) => mod.filter(n => Array.isArray(n) && n[0] === 'func').map(n => n[1])

const WAT = `(module
  (func $box (param $o i32) (result f64)
    (f64.reinterpret_i64 (i64.or (i64.const 0x7FF8800000000000) (i64.extend_i32_u (local.get $o)))))
  (func $low (param $x f64) (result i32) (i32.wrap_i64 (i64.reinterpret_f64 (local.get $x))))
  (func $sum (param $n i32) (result i32) (local $i i32) (local $s i32)
    (block $done (loop $next
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $s (i32.add (local.get $s) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (local.get $s))
  (func $f (export "f") (param $n i32) (result i32)
    (i32.add (call $low (call $box (local.get $n))) (call $sum (local.get $n))))
  (func $g (export "g") (param $n i32) (result i32)
    (call $low (call $box (i32.mul (local.get $n) (i32.const 3))))))`

test('inline tiny: a helper of a few instructions joins every caller and leaves', () => {
  const ref = run(parseWat(WAT))
  const mod = inlineTiny(parseWat(WAT), { max: 16 })
  const names = funcs(mod)
  ok(!names.includes('$box') && !names.includes('$low'), 'both helpers spliced and gone')
  ok(names.includes('$sum'), 'a function with a loop stays')
  const out = run(mod)
  for (const n of [0, 1, 7, 1000]) { is(out.f(n), ref.f(n), `f(${n})`); is(out.g(n), ref.g(n), `g(${n})`) }
})

test('inline tiny: a bound below a helper, a pin and an export keep it whole', () => {
  is(funcs(inlineTiny(parseWat(WAT), { max: 2 })).filter(n => n === '$box' || n === '$low').length, 2, 'bodies past the bound stay')
  ok(funcs(inlineTiny(parseWat(WAT), { max: 16, pin: ['$box'] })).includes('$box'), 'a pinned helper stays')
  const exported = WAT.replace('(func $low (param $x f64)', '(func $low (export "low") (param $x f64)')
  ok(funcs(inlineTiny(parseWat(exported), { max: 16 })).includes('$low'), 'an exported helper stays')
})

// An element's value read (`__arr_value`) and a join's element: the runtime's few-instruction
// helpers a dynamic program calls for every value it reads or makes.
const SRC = `
const make = (k, v) => ({ k, v: [v, v + 1] })
export let main = (n) => {
  const all = []
  for (let i = 0; i < n; i++) all.push(make('k' + (i % 5), i))
  let s = 0
  for (const o of all) s += o.v[1] - o.v[0] + o.k.length
  return s
}
`

test('inline tiny: the speed tier answers as the source does, with the helpers spliced', () => {
  const native = oracle(SRC).main
  for (const optimize of [{ level: 'speed' }, { level: 'speed', inlineTiny: false }]) {
    const main = jz(SRC, { optimize }).exports.main
    for (const n of [0, 1, 9, 100]) is(main(n), native(n), `${JSON.stringify(optimize)}: main(${n})`)
  }
  if (onKernel()) return
  const calls = (wat) => (wat.match(/\(call \$__arr_value\b/g) || []).length
  ok(calls(compile(SRC, { optimize: { level: 'speed', inlineTiny: false }, wat: true })) > 0, 'the helper is called without the pass')
  is(calls(compile(SRC, { optimize: { level: 'speed' }, wat: true })), 0, 'the speed tier splices it')
})

test('inline tiny: the default tier keeps its calls', () => {
  if (onKernel()) return
  ok(/\(call \$__arr_value\b/.test(compile(SRC, { optimize: { level: 2 }, wat: true })), 'the helper is called')
})
