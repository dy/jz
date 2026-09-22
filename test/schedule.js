// Statement scheduling (src/optimize/schedule.js): within a straight-line
// run, statements go by the longest chain of work still depending on them,
// so independent kernel calls start together. Every case is a differential
// against the same program with the pass off: the bits never change.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { funcWat as funcWatOf, run, wat } from './util.js'
import parseWat from 'watr/parse'
import encodeWat from 'watr/compile'
import { scheduleStatements } from '../src/optimize/schedule.js'
import { pureCallees } from '../src/optimize/pure-funcs.js'

const ON = { optimize: 'speed' }
const OFF = { optimize: { level: 'speed', scheduleStatements: false } }
/** The function's WAT, under its own name or its export wrapper's. */
const funcWat = (text, name) => funcWatOf(text, name) || funcWatOf(text, `${name}$exp`)
/** Kernel calls whose argument is itself a kernel call: a dependent pair issued back to back. */
const nested = (text) => (text.match(/sin_core\s*\(call \$math\.sin_core/g) || []).length

test('scheduling: independent chains start together', () => {
  const src = `export let f = (a, b) => { const p = Math.sin(a); const q = Math.sin(p) + 1; const r = Math.sin(b); const s = Math.sin(r) + 1; return q * s }`
  is(nested(funcWat(wat(src, OFF), 'f')), 2, 'as written: each chain nests its two calls')
  is(nested(funcWat(wat(src, ON), 'f')), 0, 'scheduled: the two independent calls first, then the two dependent ones')
  is(run(src, ON).f(0.3, 0.9), run(src, OFF).f(0.3, 0.9))
})

test('scheduling: a load stays after the store it reads, a store after the load it clobbers', () => {
  const src = `export let g = (a, b) => { const out = new Float64Array(4); out[0] = Math.sin(a); const t = out[0]; out[0] = Math.sin(b) + t; const u = out[0]; out[1] = Math.sin(t) + u; return out[0] * 3 + out[1] }`
  is(run(src, ON).g(0.3, 0.9), run(src, OFF).g(0.3, 0.9))
})

test('scheduling: a loop body schedules each iteration, never across the back edge', () => {
  const src = `export let h = (n) => { let x = 0.5, y = 0.25, s = 0; for (let i = 0; i < n; i++) { const p = Math.sin(x); const q = Math.sin(p); const r = Math.sin(y); const t = Math.sin(r); s += q * t; x = q + 0.1; y = t + 0.2 } return s }`
  const on = funcWat(wat(src, ON), 'h')
  is(nested(on), 0)
  is(run(src, ON).h(50), run(src, OFF).h(50))
})

test('scheduling: an effectful call keeps its place among effects', () => {
  const src = `let log = []
export let k = (a, b) => { log = []; const p = Math.sin(a); log.push(p); const q = Math.sin(b); log.push(q); log.push(Math.sin(p) + Math.sin(q)); return log.length === 3 ? log[0] + log[1] * 2 + log[2] * 4 : -1 }`
  is(run(src, ON).k(0.3, 0.9), run(src, OFF).k(0.3, 0.9))
})

test('scheduling: direct and read-only callee loads retain their trap order', () => {
  for (const indirect of [false, true]) for (const before of [false, true]) {
    const load = indirect ? '(call $read (local.get $p))' : '(f64.load (local.get $p))'
    const write = '(global.set $g (i32.const 1))'
    const ast = parseWat(`(module (memory 1)
      (global $g (export "g") (mut i32) (i32.const 0))
      (func $read (param $p i32) (result f64) (f64.load (local.get $p)))
      (func $math.sqrt (param $x f64) (result f64) (f64.sqrt (local.get $x)))
      (func $f (export "f") (param $p i32) (param $skip i32) (result f64) (local $a f64) (local $b f64)
        (if (local.get $skip) (then (return (f64.const 7))))
        ${before ? write : ''}
        (local.set $a (call $math.sqrt (call $math.sqrt ${load})))
        ${before ? '' : write}
        (local.set $b (call $math.sqrt (f64.const 4)))
        (f64.add (local.get $a) (local.get $b))))`)
    const funcs = ast.filter(n => Array.isArray(n) && n[0] === 'func'), pure = pureCallees(funcs)
    for (const fn of funcs) scheduleStatements(fn, pure)
    const { f, g } = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(ast))).exports
    is(f(65536, 1), 7, 'zero-work path does not load'); is(g.value, 0)
    let error
    try { f(65536, 0) } catch (e) { error = e }
    ok(error instanceof WebAssembly.RuntimeError)
    is(g.value, before ? 1 : 0, `write ${before ? 'before' : 'after'} ${indirect ? 'callee' : 'direct'} load`)
    is(f(65528, 0), 2, 'last valid f64 load'); is(g.value, 1)
    is(f(0, 0), 2, 'reuse with a different address')
  }
})
