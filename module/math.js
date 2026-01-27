/**
 * Math module - sin, cos, sqrt, PI, etc.
 * @module math
 */

import { type, emit, op, func } from './_core.js'

export default function init(ctx) {
  // Type declarations
  type(ctx, 'sin', 'f64 -> f64')
  type(ctx, 'cos', 'f64 -> f64')
  type(ctx, 'tan', 'f64 -> f64')
  type(ctx, 'sqrt', 'f64 -> f64')
  type(ctx, 'abs', 'f64 -> f64')
  type(ctx, 'floor', 'f64 -> f64')
  type(ctx, 'ceil', 'f64 -> f64')
  type(ctx, 'round', 'f64 -> f64')
  type(ctx, 'min', '(f64, f64) -> f64')
  type(ctx, 'max', '(f64, f64) -> f64')
  type(ctx, 'pow', '(f64, f64) -> f64')
  type(ctx, 'PI', 'f64')
  type(ctx, 'E', 'f64')

  // Constants
  emit(ctx, 'PI', () => ['f64.const', Math.PI])
  emit(ctx, 'E', () => ['f64.const', Math.E])

  // Built-in WASM ops
  op(ctx, 'sqrt', 'f64.sqrt')
  op(ctx, 'abs', 'f64.abs')
  op(ctx, 'floor', 'f64.floor')
  op(ctx, 'ceil', 'f64.ceil')
  op(ctx, 'min', 'f64.min')
  op(ctx, 'max', 'f64.max')
  op(ctx, 'round', 'f64.nearest')

  // Power operator (uses stdlib)
  emit(ctx, '**', (args) => ['call', '$__pow', ...args])

  // sin(x) Taylor series: x - x³/6 + x⁵/120 - x⁷/5040
  func(ctx, 'sin', `(func $__sin (param $x f64) (result f64)
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
  )`)

  func(ctx, 'cos', `(func $__cos (param $x f64) (result f64)
    (call $__sin (f64.add (local.get $x) (f64.const ${Math.PI / 2})))
  )`)

  func(ctx, 'tan', `(func $__tan (param $x f64) (result f64)
    (f64.div (call $__sin (local.get $x)) (call $__cos (local.get $x)))
  )`)

  func(ctx, 'pow', `(func $__pow (param $x f64) (param $y f64) (result f64)
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
  )`)
}
