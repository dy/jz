// The speed tier's copies stop growing a function once it is large (src/growth.js):
// a kernel keeps every copy, a large function keeps its loops as written. The
// optimizer's copies are weighed on the IR, the plan's on the source.
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
// nodes of straight-line code stand ahead of them, which keep their values.
const kernel = (pad) => {
  const stmts = Array.from({ length: Math.ceil(pad / 4) }, (_, k) => `(drop (i32.add (i32.const ${k}) (local.get $k)))`).join('\n')
  return parseWat(`(module
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
          (local.set $s (f64.add (local.get $s) (local.get $p)))
          (local.set $i (f64.add (local.get $i) (f64.const 1)))
          (br $inner)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $outer)))
      (f64.add (f64.mul (local.get $s) (f64.const 10)) (local.get $p))))`)
}
const copied = (fn) => /\.f\d/.test(JSON.stringify(fn))

test('growth: the specializer copies a loop where its function stays within the budget', () => {
  const small = kernel(0), fn = small.find(n => n[0] === 'func')
  const before = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(small))).exports.f
  ok(specializeLoops(fn) && copied(fn), 'a kernel\'s loop has its copy')
  const after = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(small))).exports.f
  for (const [x, n] of [[0, 9], [1.5, 20], [-3, 0], [0, 2.5]]) is(after(x, n), before(x, n), `f(${x}, ${n})`)

  // the copy would take the function past the budget: the loop stays as written
  const edge = kernel(0).find(n => n[0] === 'func'), size = irSize(edge)
  const near = kernel(IR_FULL - size - 8).find(n => n[0] === 'func')
  ok(irSize(near) <= IR_FULL, 'the function alone is within the budget')
  is(specializeLoops(near), null, 'its copy is not')
  ok(!copied(near), 'and is not made')

  const large = kernel(IR_FULL).find(n => n[0] === 'func')
  is(specializeLoops(large), null, 'a function past the budget keeps its loop as written')
})

// A loop testing a name it never writes, copied for each answer (plan/unswitch-loops.js),
// alone and behind enough calls to take its function past the source budget.
const calls = Math.ceil(SOURCE_FULL / 4) + 50   // `tick(k)` weighs four source nodes
const mix = (name, pad) => `export const ${name} = (stereo, g) => {
  let acc = 0
${pad}
  for (let i = 0; i < data.length; i++) {
    let x = stereo ? data[i] * 0.5 : data[i] * 2
    acc = acc * g + x
  }
  return acc
}`
const src = `let ticks = 0
const data = [1, 2, 3, 4]
export const tick = (k) => { ticks += k }
export const count = () => ticks
${mix('small', '')}
${mix('large', Array.from({ length: calls }, (_, k) => `  tick(${k})`).join('\n'))}`

test('growth: a loop is unswitched in a kernel, kept as written past the source budget', () => {
  const host = oracle(src), m = run(src)
  for (const [stereo, g] of [[1, 0.5], [0, 0.5], [1, 2]]) {
    is(m.small(stereo, g), host.small(stereo, g), `small(${stereo}, ${g})`)
    is(m.large(stereo, g), host.large(stereo, g), `large(${stereo}, ${g})`)
  }
  is(m.count(), host.count(), 'the calls ahead of the large loop all ran')
  if (belowOpt(2)) return
  // unswitching's copies alone (test/unswitch-loops.js)
  const alone = { level: 2, splitLoopKinds: false, versionIntegralLoops: false, specializeLoops: false }
  const text = wat(src, { optimize: alone })
  const loops = (name) => (funcWat(text, name).match(/\(loop /g) || []).length
  is(loops('small'), 2, 'a copy for each answer')
  is(loops('large'), 1, 'the loop as written')
})

// A shared body (four sites) spliced into a kernel, kept as a call past the source budget.
const shared = `let ticks = 0
export const tick = (k) => { ticks += k }
const scale = (x, g) => x * g + 1
export const near = (x, g) => scale(x, g) + scale(g, x)
export const far = (x, g) => {
${Array.from({ length: calls }, (_, k) => `  tick(${k})`).join('\n')}
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
