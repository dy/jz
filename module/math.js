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
export default (ctx) => {
  // Constants
  ctx.emit['math.PI'] = () => ['f64.const', Math.PI]
  ctx.emit['math.E'] = () => ['f64.const', Math.E]
  ctx.emit['math.LN2'] = () => ['f64.const', Math.LN2]
  ctx.emit['math.LN10'] = () => ['f64.const', Math.LN10]
  ctx.emit['math.LOG2E'] = () => ['f64.const', Math.LOG2E]
  ctx.emit['math.LOG10E'] = () => ['f64.const', Math.LOG10E]
  ctx.emit['math.SQRT2'] = () => ['f64.const', Math.SQRT2]
  ctx.emit['math.SQRT1_2'] = () => ['f64.const', Math.SQRT1_2]

  // Built-in WASM ops (prefixed)
  ctx.emit['math.sqrt'] = (a) => ['f64.sqrt', emit(a)]
  ctx.emit['math.abs'] = (a) => ['f64.abs', emit(a)]
  ctx.emit['math.floor'] = (a) => ['f64.floor', emit(a)]
  ctx.emit['math.ceil'] = (a) => ['f64.ceil', emit(a)]
  ctx.emit['math.trunc'] = (a) => ['f64.trunc', emit(a)]
  ctx.emit['math.min'] = (a, b) => ['f64.min', emit(a), emit(b)]
  ctx.emit['math.max'] = (a, b) => ['f64.max', emit(a), emit(b)]
  ctx.emit['math.round'] = (a) => ['f64.nearest', emit(a)]

  // Sign
  ctx.emit['math.sign'] = (a) => (
    ctx.includes.add('math.sign'),
    ['call', '$math.sign', emit(a)]
  )

  // fround
  ctx.emit['math.fround'] = (a) => ['f64.promote_f32', ['f32.demote_f64', emit(a)]]

  // Trig - include wat, return call
  ctx.emit['math.sin'] = (a) => (
    ctx.includes.add('math.sin'),
    ['call', '$math.sin', emit(a)]
  )
  ctx.emit['math.cos'] = (a) => (
    ctx.includes.add('math.cos'),
    ['call', '$math.cos', emit(a)]
  )
  ctx.emit['math.tan'] = (a) => (
    ctx.includes.add('math.sin').add('math.cos').add('math.tan'),
    ['call', '$math.tan', emit(a)]
  )

  // Inverse trig
  ctx.emit['math.asin'] = (a) => (
    ctx.includes.add('math.atan').add('math.asin'),
    ['call', '$math.asin', emit(a)]
  )
  ctx.emit['math.acos'] = (a) => (
    ctx.includes.add('math.atan').add('math.asin').add('math.acos'),
    ['call', '$math.acos', emit(a)]
  )
  ctx.emit['math.atan'] = (a) => (
    ctx.includes.add('math.atan'),
    ['call', '$math.atan', emit(a)]
  )
  ctx.emit['math.atan2'] = (a, b) => (
    ctx.includes.add('math.atan').add('math.atan2'),
    ['call', '$math.atan2', emit(a), emit(b)]
  )

  // Hyperbolic
  ctx.emit['math.sinh'] = (a) => (
    ctx.includes.add('math.exp').add('math.sinh'),
    ['call', '$math.sinh', emit(a)]
  )
  ctx.emit['math.cosh'] = (a) => (
    ctx.includes.add('math.exp').add('math.cosh'),
    ['call', '$math.cosh', emit(a)]
  )
  ctx.emit['math.tanh'] = (a) => (
    ctx.includes.add('math.exp').add('math.tanh'),
    ['call', '$math.tanh', emit(a)]
  )

  // Inverse hyperbolic
  ctx.emit['math.asinh'] = (a) => (
    ctx.includes.add('math.log').add('math.asinh'),
    ['call', '$math.asinh', emit(a)]
  )
  ctx.emit['math.acosh'] = (a) => (
    ctx.includes.add('math.log').add('math.acosh'),
    ['call', '$math.acosh', emit(a)]
  )
  ctx.emit['math.atanh'] = (a) => (
    ctx.includes.add('math.log').add('math.atanh'),
    ['call', '$math.atanh', emit(a)]
  )

  // Exponential and logarithmic
  ctx.emit['math.exp'] = (a) => (
    ctx.includes.add('math.exp'),
    ['call', '$math.exp', emit(a)]
  )
  ctx.emit['math.expm1'] = (a) => (
    ctx.includes.add('math.exp').add('math.expm1'),
    ['call', '$math.expm1', emit(a)]
  )
  ctx.emit['math.log'] = (a) => (
    ctx.includes.add('math.log'),
    ['call', '$math.log', emit(a)]
  )
  ctx.emit['math.log2'] = (a) => (
    ctx.includes.add('math.log').add('math.log2'),
    ['call', '$math.log2', emit(a)]
  )
  ctx.emit['math.log10'] = (a) => (
    ctx.includes.add('math.log').add('math.log10'),
    ['call', '$math.log10', emit(a)]
  )
  ctx.emit['math.log1p'] = (a) => (
    ctx.includes.add('math.log').add('math.log1p'),
    ['call', '$math.log1p', emit(a)]
  )

  // Power
  ctx.emit['math.pow'] = (a, b) => (
    ctx.includes.add('math.exp').add('math.log').add('math.pow'),
    ['call', '$math.pow', emit(a), emit(b)]
  )
  ctx.emit['**'] = ctx.emit['math.pow']

  // Other functions
  ctx.emit['math.cbrt'] = (a) => (
    ctx.includes.add('math.exp').add('math.log').add('math.pow').add('math.cbrt'),
    ['call', '$math.cbrt', emit(a)]
  )
  ctx.emit['math.hypot'] = (a, b) => (
    ctx.includes.add('math.hypot'),
    ['call', '$math.hypot', emit(a), emit(b)]
  )

  // Integer/bit operations
  ctx.emit['math.clz32'] = (a) => ['f64.convert_i32_u', ['i32.clz', ['i32.trunc_f64_s', emit(a)]]]
  ctx.emit['math.imul'] = (a, b) => ['f64.convert_i32_s', ['i32.mul', ['i32.trunc_f64_s', emit(a)], ['i32.trunc_f64_s', emit(b)]]]

  // Random
  ctx.emit['math.random'] = () => (
    ctx.includes.add('math.random'),
    ['call', '$math.random']
  )

  // ============================================
  // WAT stdlib implementations
  // ============================================

  ctx.stdlib['math.sign'] = `(func $math.sign (param $x f64) (result f64)
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0))
      (then (f64.const 0.0))
      (else (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
        (then (f64.const 1.0))
        (else (f64.const -1.0))))))`

  ctx.stdlib['math.sin'] = `(func $math.sin (param $x f64) (result f64)
    (local $n i32) (local $r f64) (local $x2 f64) (local $sign f64)
    (local.set $sign (f64.const 1.0))
    (local.set $n (i32.trunc_f64_s (f64.floor (f64.div (local.get $x) (f64.const ${Math.PI})))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $n)) (f64.const ${Math.PI}))))
    (if (i32.and (local.get $n) (i32.const 1)) (then (local.set $sign (f64.const -1.0))))
    (if (f64.gt (local.get $r) (f64.const ${Math.PI / 2})) (then (local.set $r (f64.sub (f64.const ${Math.PI}) (local.get $r)))))
    (if (f64.lt (local.get $r) (f64.const 0.0)) (then
      (local.set $r (f64.neg (local.get $r)))
      (local.set $sign (f64.neg (local.get $sign)))))
    (local.set $x2 (f64.mul (local.get $r) (local.get $r)))
    (f64.mul (local.get $sign) (f64.mul (local.get $r) (f64.sub (f64.const 1.0) (f64.mul (local.get $x2)
      (f64.sub (f64.const 0.16666666666666666) (f64.mul (local.get $x2)
        (f64.sub (f64.const 0.008333333333333333) (f64.mul (local.get $x2)
          (f64.sub (f64.const 0.0001984126984126984) (f64.mul (local.get $x2)
            (f64.sub (f64.const 0.0000027557319223985893) (f64.mul (local.get $x2)
              (f64.const 2.505210838544172e-8))))))))))))))`

  ctx.stdlib['math.cos'] = `(func $math.cos (param $x f64) (result f64)
    (local $n i32) (local $r f64) (local $x2 f64) (local $sign f64)
    (local.set $sign (f64.const 1.0))
    (local.set $n (i32.trunc_f64_s (f64.floor (f64.div (local.get $x) (f64.const ${Math.PI})))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $n)) (f64.const ${Math.PI}))))
    (if (i32.and (local.get $n) (i32.const 1)) (then (local.set $sign (f64.const -1.0))))
    (if (f64.gt (local.get $r) (f64.const ${Math.PI / 2})) (then
      (local.set $r (f64.sub (f64.const ${Math.PI}) (local.get $r)))
      (local.set $sign (f64.neg (local.get $sign)))))
    (if (f64.lt (local.get $r) (f64.const 0.0)) (then (local.set $r (f64.neg (local.get $r)))))
    (local.set $x2 (f64.mul (local.get $r) (local.get $r)))
    (f64.mul (local.get $sign) (f64.sub (f64.const 1.0) (f64.mul (local.get $x2)
      (f64.sub (f64.const 0.5) (f64.mul (local.get $x2)
        (f64.sub (f64.const 0.041666666666666664) (f64.mul (local.get $x2)
          (f64.sub (f64.const 0.001388888888888889) (f64.mul (local.get $x2)
            (f64.sub (f64.const 0.0000248015873015873) (f64.mul (local.get $x2)
              (f64.const 2.7557319223985893e-7)))))))))))))`

  ctx.stdlib['math.tan'] = `(func $math.tan (param $x f64) (result f64)
    (f64.div (call $math.sin (local.get $x)) (call $math.cos (local.get $x))))`

  ctx.stdlib['math.exp'] = `(func $math.exp (param $x f64) (result f64)
    (local $k i32) (local $t f64) (local $t2 f64) (local $result f64) (local $pow2 f64)
    (if (result f64) (f64.gt (local.get $x) (f64.const 709.0)) (then (f64.const 1.7976931348623157e+308)) (else
      (if (result f64) (f64.lt (local.get $x) (f64.const -745.0)) (then (f64.const 0.0)) (else
        (local.set $k (i32.trunc_f64_s (f64.div (local.get $x) (f64.const ${Math.LN2}))))
        (local.set $t (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $k)) (f64.const ${Math.LN2}))))
        (local.set $t2 (f64.mul (local.get $t) (local.get $t)))
        (local.set $result (f64.add (f64.const 1.0) (f64.add (local.get $t)
          (f64.mul (local.get $t2) (f64.add (f64.const 0.5)
            (f64.mul (local.get $t) (f64.add (f64.const 0.16666666666666666)
              (f64.mul (local.get $t) (f64.add (f64.const 0.041666666666666664)
                (f64.mul (local.get $t) (f64.add (f64.const 0.008333333333333333)
                  (f64.mul (local.get $t) (f64.const 0.001388888888888889)))))))))))))
        (local.set $pow2 (f64.const 1.0))
        (if (i32.gt_s (local.get $k) (i32.const 0))
          (then (block $done (loop $loop
            (br_if $done (i32.le_s (local.get $k) (i32.const 0)))
            (local.set $pow2 (f64.mul (local.get $pow2) (f64.const 2.0)))
            (local.set $k (i32.sub (local.get $k) (i32.const 1)))
            (br $loop)))
            (local.set $result (f64.mul (local.get $result) (local.get $pow2))))
          (else (if (i32.lt_s (local.get $k) (i32.const 0))
            (then (block $done2 (loop $loop2
              (br_if $done2 (i32.ge_s (local.get $k) (i32.const 0)))
              (local.set $pow2 (f64.mul (local.get $pow2) (f64.const 2.0)))
              (local.set $k (i32.add (local.get $k) (i32.const 1)))
              (br $loop2)))
              (local.set $result (f64.div (local.get $result) (local.get $pow2)))))))
        (local.get $result))))))`

  ctx.stdlib['math.expm1'] = `(func $math.expm1 (param $x f64) (result f64)
    (f64.sub (call $math.exp (local.get $x)) (f64.const 1.0)))`

  ctx.stdlib['math.log'] = `(func $math.log (param $x f64) (result f64)
    (local $k i32) (local $y f64) (local $s f64) (local $z f64)
    (if (f64.le (local.get $x) (f64.const 0.0))
      (then (return (f64.const 0.0))))
    (if (f64.eq (local.get $x) (f64.const 1.0))
      (then (return (f64.const 0.0))))
    (local.set $k (i32.const 0))
    (local.set $y (local.get $x))
    (block $done_up
      (loop $scale_up
        (br_if $done_up (f64.lt (local.get $y) (f64.const 2.0)))
        (local.set $y (f64.mul (local.get $y) (f64.const 0.5)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $scale_up)))
    (block $done_down
      (loop $scale_down
        (br_if $done_down (f64.ge (local.get $y) (f64.const 1.0)))
        (local.set $y (f64.mul (local.get $y) (f64.const 2.0)))
        (local.set $k (i32.sub (local.get $k) (i32.const 1)))
        (br $scale_down)))
    (local.set $s (f64.div (f64.sub (local.get $y) (f64.const 1.0)) (f64.add (local.get $y) (f64.const 1.0))))
    (local.set $z (f64.mul (local.get $s) (local.get $s)))
    (f64.add
      (f64.mul (f64.convert_i32_s (local.get $k)) (f64.const ${Math.LN2}))
      (f64.mul (f64.const 2.0) (f64.mul (local.get $s) (f64.add (f64.const 1.0)
        (f64.mul (local.get $z) (f64.add (f64.const 0.3333333333333333)
          (f64.mul (local.get $z) (f64.add (f64.const 0.2)
            (f64.mul (local.get $z) (f64.add (f64.const 0.14285714285714285)
              (f64.mul (local.get $z) (f64.add (f64.const 0.1111111111111111)
                (f64.mul (local.get $z) (f64.const 0.09090909090909091)))))))))))))))`

  ctx.stdlib['math.log2'] = `(func $math.log2 (param $x f64) (result f64)
    (f64.div (call $math.log (local.get $x)) (f64.const ${Math.LN2})))`

  ctx.stdlib['math.log10'] = `(func $math.log10 (param $x f64) (result f64)
    (f64.div (call $math.log (local.get $x)) (f64.const ${Math.LN10})))`

  ctx.stdlib['math.log1p'] = `(func $math.log1p (param $x f64) (result f64)
    (call $math.log (f64.add (f64.const 1.0) (local.get $x))))`

  ctx.stdlib['math.pow'] = `(func $math.pow (param $x f64) (param $y f64) (result f64)
    (local $result f64) (local $n i32) (local $neg_base i32) (local $abs_x f64)
    (if (result f64) (f64.eq (local.get $y) (f64.const 0.0))
      (then (f64.const 1.0))
      (else (if (result f64) (f64.eq (local.get $x) (f64.const 0.0))
        (then (f64.const 0.0))
        (else (if (result f64) (f64.eq (local.get $x) (f64.const 1.0))
          (then (f64.const 1.0))
          (else (if (result f64) (f64.eq (local.get $y) (f64.const 1.0))
            (then (local.get $x))
            (else
              (if (result f64)
                (i32.and
                  (f64.eq (f64.nearest (local.get $y)) (local.get $y))
                  (f64.le (f64.abs (local.get $y)) (f64.const 100.0)))
                (then
                  (local.set $abs_x (f64.abs (local.get $x)))
                  (local.set $neg_base (i32.and (f64.lt (local.get $x) (f64.const 0.0))
                                                (i32.and (i32.trunc_f64_s (local.get $y)) (i32.const 1))))
                  (local.set $n (i32.trunc_f64_s (f64.abs (local.get $y))))
                  (local.set $result (f64.const 1.0))
                  (block $done
                    (loop $loop
                      (br_if $done (i32.le_s (local.get $n) (i32.const 0)))
                      (if (i32.and (local.get $n) (i32.const 1))
                        (then (local.set $result (f64.mul (local.get $result) (local.get $abs_x)))))
                      (local.set $abs_x (f64.mul (local.get $abs_x) (local.get $abs_x)))
                      (local.set $n (i32.shr_s (local.get $n) (i32.const 1)))
                      (br $loop)))
                  (if (f64.lt (local.get $y) (f64.const 0.0))
                    (then (local.set $result (f64.div (f64.const 1.0) (local.get $result)))))
                  (if (local.get $neg_base)
                    (then (local.set $result (f64.neg (local.get $result)))))
                  (local.get $result))
                (else
                  (if (result f64) (f64.lt (local.get $x) (f64.const 0.0))
                    (then (f64.const 0.0))
                    (else (call $math.exp (f64.mul (local.get $y) (call $math.log (local.get $x)))))))))))))))))`

  ctx.stdlib['math.atan'] = `(func $math.atan (param $x f64) (result f64)
    (local $x2 f64) (local $abs_x f64) (local $reduced f64)
    (local.set $abs_x (f64.abs (local.get $x)))
    (if (result f64) (f64.gt (local.get $abs_x) (f64.const 1.0))
      (then
        (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
          (then (f64.sub (f64.const ${Math.PI / 2}) (call $math.atan (f64.div (f64.const 1.0) (local.get $x)))))
          (else (f64.add (f64.neg (f64.const ${Math.PI / 2})) (call $math.atan (f64.div (f64.const 1.0) (local.get $x)))))))
      (else
        (if (result f64) (f64.gt (local.get $abs_x) (f64.const 0.5))
          (then
            (local.set $reduced (f64.div (local.get $x) (f64.add (f64.const 1.0) (f64.sqrt (f64.add (f64.const 1.0) (f64.mul (local.get $x) (local.get $x)))))))
            (f64.mul (f64.const 2.0) (call $math.atan (local.get $reduced))))
          (else
            (local.set $x2 (f64.mul (local.get $x) (local.get $x)))
            (f64.mul (local.get $x)
              (f64.sub (f64.const 1.0)
                (f64.mul (local.get $x2)
                  (f64.sub (f64.const 0.3333333333333333)
                    (f64.mul (local.get $x2)
                      (f64.sub (f64.const 0.2)
                        (f64.mul (local.get $x2)
                          (f64.sub (f64.const 0.14285714285714285)
                            (f64.mul (local.get $x2)
                              (f64.sub (f64.const 0.1111111111111111)
                                (f64.mul (local.get $x2)
                                  (f64.sub (f64.const 0.09090909090909091)
                                    (f64.mul (local.get $x2) (f64.const 0.07692307692307693)))))))))))))))))))`

  ctx.stdlib['math.asin'] = `(func $math.asin (param $x f64) (result f64)
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 1.0))
      (then (f64.const 0.0))
      (else (call $math.atan (f64.div (local.get $x)
        (f64.sqrt (f64.sub (f64.const 1.0) (f64.mul (local.get $x) (local.get $x)))))))))`

  ctx.stdlib['math.acos'] = `(func $math.acos (param $x f64) (result f64)
    (f64.sub (f64.const ${Math.PI / 2}) (call $math.asin (local.get $x))))`

  ctx.stdlib['math.atan2'] = `(func $math.atan2 (param $y f64) (param $x f64) (result f64)
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0)) (then
      (if (result f64) (f64.eq (local.get $y) (f64.const 0.0)) (then (f64.const 0.0)) (else
        (if (result f64) (f64.gt (local.get $y) (f64.const 0.0)) (then (f64.const ${Math.PI / 2})) (else (f64.neg (f64.const ${Math.PI / 2})))))))
      (else (if (result f64) (f64.ge (local.get $x) (f64.const 0.0))
        (then (call $math.atan (f64.div (local.get $y) (local.get $x))))
        (else (if (result f64) (f64.ge (local.get $y) (f64.const 0.0))
          (then (f64.add (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${Math.PI})))
          (else (f64.sub (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${Math.PI})))))))))`

  ctx.stdlib['math.sinh'] = `(func $math.sinh (param $x f64) (result f64)
    (local $ex f64)
    (local.set $ex (call $math.exp (f64.abs (local.get $x))))
    (local.set $ex (f64.mul (f64.const 0.5) (f64.sub (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $ex))) (else (local.get $ex))))`

  ctx.stdlib['math.cosh'] = `(func $math.cosh (param $x f64) (result f64)
    (local $ex f64) (local.set $ex (call $math.exp (f64.abs (local.get $x))))
    (f64.mul (f64.const 0.5) (f64.add (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))`

  ctx.stdlib['math.tanh'] = `(func $math.tanh (param $x f64) (result f64)
    (local $e2x f64)
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 22.0))
      (then (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.const -1.0)) (else (f64.const 1.0))))
      (else (local.set $e2x (call $math.exp (f64.mul (f64.const 2.0) (f64.abs (local.get $x)))))
        (local.set $e2x (f64.div (f64.sub (local.get $e2x) (f64.const 1.0)) (f64.add (local.get $e2x) (f64.const 1.0))))
        (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $e2x))) (else (local.get $e2x))))))`

  ctx.stdlib['math.asinh'] = `(func $math.asinh (param $x f64) (result f64)
    (call $math.log (f64.add (local.get $x) (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))`

  ctx.stdlib['math.acosh'] = `(func $math.acosh (param $x f64) (result f64)
    (if (result f64) (f64.lt (local.get $x) (f64.const 1.0)) (then (f64.const 0.0)) (else
      (call $math.log (f64.add (local.get $x) (f64.sqrt (f64.sub (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))))`

  ctx.stdlib['math.atanh'] = `(func $math.atanh (param $x f64) (result f64)
    (f64.mul (f64.const 0.5) (call $math.log (f64.div (f64.add (f64.const 1.0) (local.get $x)) (f64.sub (f64.const 1.0) (local.get $x))))))`

  ctx.stdlib['math.cbrt'] = `(func $math.cbrt (param $x f64) (result f64)
    (local $y f64)
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0))
      (then (f64.neg (call $math.cbrt (f64.neg (local.get $x)))))
      (else (if (result f64) (f64.eq (local.get $x) (f64.const 0.0))
        (then (f64.const 0.0))
        (else
          ;; Initial guess via pow, then Newton-Raphson: y = (2y + x/y²)/3
          (local.set $y (call $math.pow (local.get $x) (f64.const 0.3333333333333333)))
          (local.set $y (f64.div (f64.add (f64.mul (f64.const 2.0) (local.get $y)) (f64.div (local.get $x) (f64.mul (local.get $y) (local.get $y)))) (f64.const 3.0)))
          (local.set $y (f64.div (f64.add (f64.mul (f64.const 2.0) (local.get $y)) (f64.div (local.get $x) (f64.mul (local.get $y) (local.get $y)))) (f64.const 3.0)))
          (local.get $y))))))`

  ctx.stdlib['math.hypot'] = `(func $math.hypot (param $x f64) (param $y f64) (result f64)
    (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.mul (local.get $y) (local.get $y)))))`

  ctx.stdlib['math.random'] = `(func $math.random (result f64)
    (local $s i32)
    (local.set $s (global.get $math.rng_state))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))
    (local.set $s (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 17))))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 5))))
    (global.set $math.rng_state (local.get $s))
    (f64.div (f64.convert_i32_u (i32.and (local.get $s) (i32.const 0x7FFFFFFF))) (f64.const 2147483647.0)))`

  // Global for random state
  ctx.globals = ctx.globals || []
  ctx.globals.push('(global $math.rng_state (mut i32) (i32.const 12345))')
}
