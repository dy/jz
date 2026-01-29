/**
 * Math module - Math.sin, Math.cos, Math.sqrt, Math.PI, etc.
 * 
 * Module API:
 * - ctx.emit['math.X'] = (args) => WasmNode - custom emitters
 * - ctx.stdlib['math.X'] = '(func ...)' - WAT function definitions
 * - ctx.deps['math.X'] = ['dep1', 'dep2'] - stdlib dependencies
 * - include('math.X') - marks stdlib for inclusion (called by emitters)
 * 
 * Prepare resolves Math.sin(x) → ['()', 'math.sin', x]
 * Compile looks up ctx.emit['math.sin'] and calls it.
 * 
 * @module math
 */

import { emit } from '../src/compile.js'
import { include } from '../src/prepare.js'

export default (ctx) => {
  // Constants
  ctx.emit['math.PI'] = () => ['f64.const', Math.PI]
  ctx.emit['math.E'] = () => ['f64.const', Math.E]

  // Built-in WASM ops (prefixed)
  ctx.emit['math.sqrt'] = (a) => ['f64.sqrt', emit(a)]
  ctx.emit['math.abs'] = (a) => ['f64.abs', emit(a)]
  ctx.emit['math.floor'] = (a) => ['f64.floor', emit(a)]
  ctx.emit['math.ceil'] = (a) => ['f64.ceil', emit(a)]
  ctx.emit['math.min'] = (a, b) => ['f64.min', emit(a), emit(b)]
  ctx.emit['math.max'] = (a, b) => ['f64.max', emit(a), emit(b)]
  ctx.emit['math.round'] = (a) => ['f64.nearest', emit(a)]

  // Trig - include wat, return call
  ctx.emit['math.sin'] = (a) => (include('math.sin'), ['call', '$math.sin', emit(a)])
  ctx.emit['math.cos'] = (a) => (include('math.cos'), ['call', '$math.cos', emit(a)])
  ctx.emit['math.tan'] = (a) => (include('math.tan'), ['call', '$math.tan', emit(a)])

  // Power
  ctx.emit['math.pow'] = (a, b) => (include('math.pow'), ['call', '$math.pow', emit(a), emit(b)])
  ctx.emit['**'] = (a, b) => ctx.emit['math.pow'](a, b)

  // Dependencies
  ctx.deps['math.cos'] = ['math.sin']
  ctx.deps['math.tan'] = ['math.sin', 'math.cos']

  // WAT stdlib
  ctx.stdlib['math.sin'] = `(func $math.sin (param $x f64) (result f64)
    (local $x2 f64) (local $r f64)
    (local.set $x2 (f64.mul (local.get $x) (local.get $x)))
    (local.set $r (local.get $x))
    (local.set $r (f64.sub (local.get $r)
      (f64.div (f64.mul (local.get $x) (local.get $x2)) (f64.const 6))))
    (local.set $r (f64.add (local.get $r)
      (f64.div (f64.mul (local.get $x) (f64.mul (local.get $x2) (local.get $x2))) (f64.const 120))))
    (local.set $r (f64.sub (local.get $r)
      (f64.div (f64.mul (local.get $x) (f64.mul (local.get $x2) (f64.mul (local.get $x2) (local.get $x2)))) (f64.const 5040))))
    (local.get $r)
  )`

  ctx.stdlib['math.cos'] = `(func $math.cos (param $x f64) (result f64)
    (call $math.sin (f64.add (local.get $x) (f64.const ${Math.PI / 2})))
  )`

  ctx.stdlib['math.tan'] = `(func $math.tan (param $x f64) (result f64)
    (f64.div (call $math.sin (local.get $x)) (call $math.cos (local.get $x)))
  )`

  ctx.stdlib['math.pow'] = `(func $math.pow (param $x f64) (param $y f64) (result f64)
    (local $r f64) (local $i f64)
    (local.set $r (f64.const 1))
    (local.set $i (f64.const 0))
    (block $done
      (loop $loop
        (br_if $done (f64.ge (local.get $i) (local.get $y)))
        (local.set $r (f64.mul (local.get $r) (local.get $x)))
        (local.set $i (f64.add (local.get $i) (f64.const 1)))
        (br $loop)))
    (local.get $r)
  )`
}
