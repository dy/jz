// The speed tier's copies stop growing a function once it is large (src/growth.js),
// all but the versions of its kernel loops: a kernel keeps every copy, a large
// function keeps its loops that call as written and versions those that call
// nothing. The optimizer's copies are weighed on the IR, the plan's on the source.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { belowOpt } from './_matrix.js'
import { funcWat, oracle, run, wat } from './util.js'
import { specializeLoops } from '../src/optimize/specialize.js'
import { IR_FULL, SOURCE_FULL, irSize } from '../src/growth.js'

// Loops the specializer copies (test/specialize.js): a remainder of a counter
// carried in a float, which the integer copy holds in a register. `pad` IR
// nodes of straight-line code stand ahead of them, which keep their values;
// `call`: the inner loop adds its remainder through a call of the program's.
const kernel = (pad, call = false) => {
  const stmts = Array.from({ length: Math.ceil(pad / 4) }, (_, k) => `(drop (i32.add (i32.const ${k}) (local.get $k)))`).join('\n')
  return parseWat(`(module
    (func $half (param $v f64) (result f64) (f64.mul (local.get $v) (f64.const 0.5)))
    (func $f (export "f") (param $x f64) (param $n f64) (result f64)
      (local $k i32) (local $i f64) (local $s f64) (local $p f64)
      ${stmts}
      (local.set $s (local.get $x))
      (local.set $p (f64.const 7))
      (block $end (loop $outer
        (br_if $end (i32.ge_s (local.get $k) (i32.const 3)))
        (local.set $i (f64.const 0))
        (block $stop (loop $inner
          (br_if $stop (i32.eqz (f64.lt (local.get $i) (local.get $n))))
          (local.set $p (f64.convert_i32_s (i32.rem_s (i32.trunc_sat_f64_s (f64.add (local.get $p) (f64.const 3))) (i32.const 7))))
          (local.set $s (f64.add (local.get $s) ${call ? '(call $half (local.get $p))' : '(local.get $p)'}))
          (local.set $i (f64.add (local.get $i) (f64.const 1)))
          (br $inner)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $outer)))
      (f64.add (f64.mul (local.get $s) (f64.const 10)) (local.get $p))))`)
}
const funcOf = (mod) => mod.find(n => n[0] === 'func' && n[1] === '$f')
const copied = (fn) => /\.f\d/.test(JSON.stringify(fn))
// specialize `mod`'s $f in place: whether it made a copy, and whether f answers as before
const specialize = (mod, make) => {
  const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(make()))).exports.f
  const fn = funcOf(mod), made = specializeLoops(fn) != null
  const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(mod))).exports.f
  for (const [x, n] of [[0, 9], [1.5, 20], [-3, 0], [0, 2.5]]) is(after(x, n), before(x, n), `f(${x}, ${n})`)
  return made && copied(fn)
}

test('growth: the specializer copies a loop that calls where its function stays within the budget', () => {
  ok(specialize(kernel(0, true), () => kernel(0, true)), 'a kernel\'s loop has its copy')
  // the copy would take the function past the budget: the loop stays as written
  const size = irSize(funcOf(kernel(0, true))), make = () => kernel(IR_FULL - size - 8, true)
  ok(irSize(funcOf(make())) <= IR_FULL, 'the function alone is within the budget')
  ok(!specialize(make(), make), 'its copy is not, and is not made')
  ok(!specialize(kernel(IR_FULL, true), () => kernel(IR_FULL, true)), 'a function past the budget keeps its loop as written')
})

test('growth: the specializer copies a kernel loop past the budget', () => {
  ok(specialize(kernel(0), () => kernel(0)), 'within the budget')
  ok(irSize(funcOf(kernel(IR_FULL))) > IR_FULL, 'the function is past the budget')
  ok(specialize(kernel(IR_FULL), () => kernel(IR_FULL)), 'its loop, calling nothing, has its copy')
})

// Calls ahead of a loop take its function past the source budget.
const calls = Math.ceil(SOURCE_FULL / 4) + 50   // `tick(k)` weighs four source nodes
const pad = Array.from({ length: calls }, (_, k) => `  tick(${k})`).join('\n')

// A loop testing a name it never writes, copied for each answer (plan/unswitch-loops.js),
// alone and behind the calls; `calling`: the loop calls `tick` too.
const mix = (name, padded, calling) => `export const ${name} = (stereo, g) => {
  let acc = 0
${padded ? pad : ''}
  for (let i = 0; i < data.length; i++) {
    let x = stereo ? data[i] * 0.5 : data[i] * 2
    acc = acc * g + x${calling ? '\n    tick(i)' : ''}
  }
  return acc
}`
const src = `let ticks = 0
const data = [1, 2, 3, 4]
export const tick = (k) => { ticks += k }
export const count = () => ticks
${mix('small', false, true)}
${mix('large', true, true)}
${mix('kernel', true, false)}`

test('growth: past the source budget a kernel loop is unswitched, a loop that calls is kept as written', () => {
  const host = oracle(src), m = run(src)
  for (const [stereo, g] of [[1, 0.5], [0, 0.5], [1, 2]]) for (const name of ['small', 'large', 'kernel'])
    is(m[name](stereo, g), host[name](stereo, g), `${name}(${stereo}, ${g})`)
  is(m.count(), host.count(), 'the calls ahead of the large loops all ran')
  if (belowOpt(2)) return
  // unswitching's copies alone (test/unswitch-loops.js)
  const alone = { level: 2, splitLoopKinds: false, versionIntegralLoops: false, specializeLoops: false }
  const text = wat(src, { optimize: alone })
  const loops = (name) => (funcWat(text, name).match(/\(loop /g) || []).length
  is(loops('small'), 2, 'a copy for each answer in a function within the budget')
  is(loops('large'), 1, 'the loop that calls as written past it')
  is(loops('kernel'), 2, 'the kernel loop\'s copies past it')
})

// A loop indexing an Int32Array under a bound of unknown integrality, versioned
// over int32 names (plan/integral-loops.js), alone and behind the calls.
const count = (name, padded, calling) => `export const ${name} = () => {
  const a = new Int32Array(16)
  let i = 0, s = 0, n = N
${padded ? pad : ''}
  while (i < n) { s += a[i] + i;${calling ? ' tick(i);' : ''} i++ }
  return s
}`
const integral = `let N = 0, ticks = 0
export const set = (n) => { N = n }
export const tick = (k) => { ticks += k }
export const ticked = () => ticks
${count('small', false, true)}
${count('large', true, true)}
${count('kernel', true, false)}`

test('growth: past the source budget a kernel loop takes its integral version, a loop that calls none', () => {
  const host = oracle(integral), m = run(integral)
  for (const n of [0, 5, 16, 2.5, -1]) {
    host.set(n); m.set(n)
    for (const name of ['small', 'large', 'kernel']) is(m[name](), host[name](), `${name}() at N = ${n}`)
  }
  is(m.ticked(), host.ticked(), 'every call ran')
  if (belowOpt(2)) return
  // (watr off: the source names of the version's int32 counter stay readable)
  const text = wat(integral, { optimize: { level: 3, watr: false } })
  const versioned = (name) => /\(local \$i\S*int\d+ i32\)/.test(funcWat(text, name))
  ok(versioned('small'), 'a loop that calls, in a function within the budget')
  ok(!versioned('large'), 'none for the loop that calls past it')
  ok(versioned('kernel'), 'the kernel loop\'s version past it')
})

// A shared body (four sites) spliced into a kernel, kept as a call past the source budget.
const shared = `let ticks = 0
export const tick = (k) => { ticks += k }
const scale = (x, g) => x * g + 1
export const near = (x, g) => scale(x, g) + scale(g, x)
export const far = (x, g) => {
${pad}
  return scale(x, g) + scale(g, x)
}`

test('growth: a shared body splices into a kernel, a caller past the source budget calls it', () => {
  const host = oracle(shared), m = run(shared)
  for (const [x, g] of [[2, 3], [0.5, -1]]) {
    is(m.near(x, g), host.near(x, g), `near(${x}, ${g})`)
    is(m.far(x, g), host.far(x, g), `far(${x}, ${g})`)
  }
  if (belowOpt(2)) return
  // (watr off: its own inliner would move the one body left into its last caller)
  const text = wat(shared, { optimize: { level: 2, watr: false } })
  is((funcWat(text, 'near').match(/call \$scale\b/g) || []).length, 0, 'spliced at both sites')
  is((funcWat(text, 'far').match(/call \$scale\b/g) || []).length, 2, 'called at both sites')
})
