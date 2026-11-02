// A function of a few instructions joins every caller at the speed tier (optimize/inline-tiny.js):
// V8's baseline tier pays a frame for every call and inlines nothing. These pin the splice on
// hand-written modules, then the speed tier end to end.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import parseWat from 'watr/parse'
import compileWat from 'watr/compile'
import { inlineTiny } from '../src/optimize/inline-tiny.js'
import { onKernel } from './_matrix.js'
import { oracle, jz, compile } from './util.js'

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

// A runtime helper past the tiny bound joins the calls a program's loop makes on every iteration
// (the larger `loop` bound) where that loop calls only the runtime, through a copy only those
// sites take: a call outside a loop keeps the function, as do a loop of a function the `user`
// predicate leaves out, a loop that calls the program, and a call in an arm within the loop;
// a function only loops called goes.
const DIGITS = `(module
  (func $digits (param $v i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $v) (i32.const 100))
      (then (select (i32.const 1) (i32.const 2) (i32.lt_u (local.get $v) (i32.const 10))))
      (else (if (result i32) (i32.lt_u (local.get $v) (i32.const 10000))
        (then (select (i32.const 3) (i32.const 4) (i32.lt_u (local.get $v) (i32.const 1000))))
        (else (i32.const 5))))))
  (func $sum (export "sum") (param $n i32) (result i32) (local $i i32) (local $s i32)
    (block $done (loop $next
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $s (i32.add (local.get $s) (call $digits (i32.mul (local.get $i) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (local.get $s))
  (func $once (export "once") (param $n i32) (result i32) (call $digits (local.get $n))))`

const USER = n => n === '$sum' || n === '$once'
const callsTo = (mod, fn, callee) => JSON.stringify(mod.find(n => Array.isArray(n) && n[1] === fn)).split(`"call","${callee}"`).length - 1

test('inline tiny: a loop\'s call takes the larger bound, through a copy only it takes', () => {
  const ref = run(parseWat(DIGITS))
  is(callsTo(inlineTiny(parseWat(DIGITS), { max: 16, user: USER }), '$sum', '$digits'), 1, 'without the loop bound the loop calls')
  const mod = inlineTiny(parseWat(DIGITS), { max: 16, loop: 90, user: USER })
  is(callsTo(mod, '$sum', '$digits'), 0, 'the loop\'s call is spliced')
  is(callsTo(mod, '$once', '$digits'), 1, 'a call outside a loop stays')
  ok(funcs(mod).includes('$digits') && !funcs(mod).some(n => n.endsWith('$loop')), 'the function stays, no copy is left')
  const out = run(mod)
  for (const n of [0, 1, 12, 150]) { is(out.sum(n), ref.sum(n), `sum(${n})`); is(out.once(n * 77), ref.once(n * 77), `once(${n * 77})`) }
  const loopOnly = DIGITS.replace(/\(func \$once[^\n]*\)\)$/, ')')
  ok(!funcs(inlineTiny(parseWat(loopOnly), { max: 16, loop: 90, user: USER })).includes('$digits'), 'a function only a loop called goes')
})

test('inline tiny: a loop of the runtime\'s, a loop calling the program and a call in an arm keep the call', () => {
  const kept = (wat, user = USER) => callsTo(inlineTiny(parseWat(wat), { max: 16, loop: 90, user }), '$sum', '$digits')
  is(kept(DIGITS, n => n === '$once'), 1, 'a loop of a function the predicate leaves out')
  const callsProgram = DIGITS.replace('(local.set $i (i32.add', '(drop (call $once (local.get $i)))\n      (local.set $i (i32.add')
  is(kept(callsProgram), 1, 'a loop that also calls the program')
  const step = '(local.set $s (i32.add (local.get $s) (call $digits (i32.mul (local.get $i) (local.get $i)))))'
  const inArm = DIGITS.replace(step, () => `(if (i32.and (local.get $i) (i32.const 1)) (then ${step}))`)
  ok(inArm !== DIGITS, 'the arm is written')
  is(kept(inArm), 1, 'a call in an arm the loop may skip')
  const ref = run(parseWat(inArm)), out = run(inlineTiny(parseWat(inArm), { max: 16, loop: 90, user: USER }))
  for (const n of [0, 12, 150]) is(out.sum(n), ref.sum(n), `sum(${n})`)
})

test('inline tiny: a copy the inliner cannot lift goes back to the function', () => {
  // (a tail call is past watr's liftability contract)
  const TAIL = DIGITS.replace('(else (i32.const 5))', '(else (return_call $five))')
    .replace('(func $sum', '(func $five (result i32) (i32.const 5))\n  (func $sum')
  const ref = run(parseWat(TAIL))
  const mod = inlineTiny(parseWat(TAIL), { max: 0, loop: 90, user: USER })
  is(callsTo(mod, '$sum', '$digits'), 1, 'the loop calls the function again')
  ok(!funcs(mod).some(n => n.endsWith('$loop')), 'the copy is gone')
  const out = run(mod)
  for (const n of [0, 12, 150]) is(out.sum(n), ref.sum(n), `sum(${n})`)
})

// Per-record formatting: each row of integer and string fields becomes a line by concatenation,
// its characters folded. The loop calls the runtime's digit count, integer conversion, string
// length and copy once a row; V8's inliner has room in the kernel for one of them.
const ROWS = `
const NAMES = ['alpha', 'bravo', 'carol', 'echo']
export let main = (seed) => {
  const code = new Int32Array(64), vals = new Int32Array(64)
  for (let i = 0; i < 64; i++) { code[i] = i & 3; vals[i] = Math.imul(i + seed, -1640531535) }
  let h = 0
  for (let i = 0; i < 64; i++) {
    const line = i + ',' + NAMES[code[i]] + ',' + ((vals[i] + seed) | 0) + '\\n'
    for (let j = 0; j < line.length; j++) h = Math.imul(h ^ line.charCodeAt(j), 16777619)
  }
  return h
}
`
const HELPERS = ['$__ilen', '$__itoa_sn', '$__str_length', '$__str_copy_over']

test('inline tiny: a loop formatting records splices the runtime it calls per row', () => {
  const native = oracle(ROWS).main
  for (const optimize of [{ level: 'speed' }, { level: 'speed', loopNodes: 16 }, { level: 2 }]) {
    const main = jz(ROWS, { optimize }).exports.main
    for (const s of [0, 1, 7, -3]) is(main(s), native(s), `${JSON.stringify(optimize)}: main(${s})`)
  }
  if (onKernel()) return
  const called = (optimize) => HELPERS.filter(h => new RegExp(`\\(call \\${h}\\b`).test(compile(ROWS, { optimize, wat: true })))
  is(called({ level: 'speed', loopNodes: 16 }), HELPERS, 'past the tiny bound each is a call')
  is(called({ level: 'speed' }), [], 'the speed tier splices each into the loop')
  is(called({ level: 2 }), HELPERS, 'the default tier keeps its calls')
})
