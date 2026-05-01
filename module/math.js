/**
 * Math module - Math.sin, Math.cos, Math.sqrt, Math.PI, etc.
 *
 * Module API:
 * - ctx.core.emit['math.X'] = (args) => WasmNode - custom emitters
 * - ctx.core.stdlib['math.X'] = '(func ...)' - WAT function definitions
 * - ctx.deps['math.X'] = ['dep1', 'dep2'] - stdlib dependencies
 * - include('math.X') - marks stdlib for inclusion (called by emitters)
 *
 * Prepare resolves Math.sin(x) → ['()', 'math.sin', x]
 * Compile looks up ctx.core.emit['math.sin'] and calls it.
 *
 * @module math
 */

import { emit, typed, asF64, asI32, temp, arrayLoop } from '../src/compile.js'
import { inc } from '../src/ctx.js'
import { repOf } from '../src/analyze.js'

export default (ctx) => {
  // Helpers: all math ops take f64 and return f64
  const f = (op, a) => typed([op, asF64(emit(a))], 'f64')
  const f2 = (op, a, b) => typed([op, asF64(emit(a)), asF64(emit(b))], 'f64')
  // floor/ceil/trunc/round are no-ops on integer-valued operands. When the
  // arg is a local whose every def is integer-valued (intCertain lattice),
  // skip the wasm op and just hand back the operand cast to f64.
  const fInt = (op, a) => typeof a === 'string' && repOf(a)?.intCertain === true
    ? asF64(emit(a))
    : f(op, a)
  const call = (name, ...args) => (inc(name), typed(['call', `$${name}`, ...args.map(a => asF64(emit(a)))], 'f64'))
  const callDeps = (deps, name, ...args) => (inc(...deps), call(name, ...args))

  // Constants
  ctx.core.emit['math.PI'] = () => typed(['f64.const', Math.PI], 'f64')
  ctx.core.emit['math.E'] = () => typed(['f64.const', Math.E], 'f64')
  ctx.core.emit['math.LN2'] = () => typed(['f64.const', Math.LN2], 'f64')
  ctx.core.emit['math.LN10'] = () => typed(['f64.const', Math.LN10], 'f64')
  ctx.core.emit['math.LOG2E'] = () => typed(['f64.const', Math.LOG2E], 'f64')
  ctx.core.emit['math.LOG10E'] = () => typed(['f64.const', Math.LOG10E], 'f64')
  ctx.core.emit['math.SQRT2'] = () => typed(['f64.const', Math.SQRT2], 'f64')
  ctx.core.emit['math.SQRT1_2'] = () => typed(['f64.const', Math.SQRT1_2], 'f64')

  /** Emit array reduce with a WASM binary op (for Math.max(...arr), Math.min(...arr)) */
  function emitArrayReduce(wasmOp, arrExpr, initVal) {
    const acc = temp('mr')
    const loop = arrayLoop(emit(arrExpr), (_ptr, _len, _i, item) => [
      ['local.set', `$${acc}`, [wasmOp, ['local.get', `$${acc}`], asF64(item)]]
    ])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${acc}`, ['f64.const', initVal]],
      ...loop,
      ['local.get', `$${acc}`]], 'f64')
  }

  // Built-in WASM ops
  ctx.core.emit['math.sqrt'] = a => f('f64.sqrt', a)
  ctx.core.emit['math.abs'] = a => f('f64.abs', a)
  ctx.core.emit['math.floor'] = a => fInt('f64.floor', a)
  ctx.core.emit['math.ceil'] = a => fInt('f64.ceil', a)
  ctx.core.emit['math.trunc'] = a => fInt('f64.trunc', a)
  ctx.core.emit['math.min'] = (a, b, ...rest) => {
    // Spread: Math.min(...arr) — iterate array to find min
    if (!b && Array.isArray(a) && a[0] === '...') return emitArrayReduce('f64.min', a[1], Infinity)
    return f2('f64.min', a, b)
  }
  ctx.core.emit['math.max'] = (a, b, ...rest) => {
    if (!b && Array.isArray(a) && a[0] === '...') return emitArrayReduce('f64.max', a[1], -Infinity)
    return f2('f64.max', a, b)
  }
  ctx.core.emit['math.round'] = a => fInt('f64.nearest', a)
  ctx.core.emit['math.fround'] = a => typed(['f64.promote_f32', ['f32.demote_f64', asF64(emit(a))]], 'f64')

  // Sign
  ctx.core.emit['math.sign'] = a => call('math.sign', a)

  // Trig
  ctx.core.emit['math.sin'] = a => call('math.sin', a)
  ctx.core.emit['math.cos'] = a => call('math.cos', a)
  ctx.core.emit['math.tan'] = a => callDeps(['math.sin', 'math.cos', 'math.tan'], 'math.tan', a)

  // Inverse trig
  ctx.core.emit['math.asin'] = a => callDeps(['math.atan', 'math.asin'], 'math.asin', a)
  ctx.core.emit['math.acos'] = a => callDeps(['math.atan', 'math.asin', 'math.acos'], 'math.acos', a)
  ctx.core.emit['math.atan'] = a => call('math.atan', a)
  ctx.core.emit['math.atan2'] = (a, b) => callDeps(['math.atan', 'math.atan2'], 'math.atan2', a, b)

  // Hyperbolic
  ctx.core.emit['math.sinh'] = a => callDeps(['math.exp', 'math.sinh'], 'math.sinh', a)
  ctx.core.emit['math.cosh'] = a => callDeps(['math.exp', 'math.cosh'], 'math.cosh', a)
  ctx.core.emit['math.tanh'] = a => callDeps(['math.exp', 'math.tanh'], 'math.tanh', a)

  // Inverse hyperbolic
  ctx.core.emit['math.asinh'] = a => callDeps(['math.log', 'math.asinh'], 'math.asinh', a)
  ctx.core.emit['math.acosh'] = a => callDeps(['math.log', 'math.acosh'], 'math.acosh', a)
  ctx.core.emit['math.atanh'] = a => callDeps(['math.log', 'math.atanh'], 'math.atanh', a)

  // Exponential and logarithmic
  ctx.core.emit['math.exp'] = a => call('math.exp', a)
  ctx.core.emit['math.expm1'] = a => callDeps(['math.exp', 'math.expm1'], 'math.expm1', a)
  ctx.core.emit['math.log'] = a => call('math.log', a)
  ctx.core.emit['math.log2'] = a => callDeps(['math.log', 'math.log2'], 'math.log2', a)
  ctx.core.emit['math.log10'] = a => callDeps(['math.log', 'math.log10'], 'math.log10', a)
  ctx.core.emit['math.log1p'] = a => callDeps(['math.log', 'math.log1p'], 'math.log1p', a)

  // Power
  ctx.core.emit['math.pow'] = (a, b) => callDeps(['math.exp', 'math.log', 'math.pow'], 'math.pow', a, b)
  ctx.core.emit['**'] = ctx.core.emit['math.pow']
  ctx.core.emit['math.cbrt'] = a => callDeps(['math.exp', 'math.log', 'math.pow', 'math.cbrt'], 'math.cbrt', a)
  ctx.core.emit['math.hypot'] = (a, b) => call('math.hypot', a, b)

  // Integer/bit operations: return i32 directly. Consumers `asF64`-rebox at
  // store/return boundaries; consumers staying in i32 (bit chains, i32 locals)
  // skip the convert/trunc round-trip entirely.
  ctx.core.emit['math.clz32'] = a => typed(['i32.clz', asI32(emit(a))], 'i32')
  ctx.core.emit['math.imul'] = (a, b) => typed(['i32.mul', asI32(emit(a)), asI32(emit(b))], 'i32')

  // Random
  ctx.core.emit['math.random'] = () => (inc('math.random'), typed(['call', '$math.random'], 'f64'))

  // ============================================
  // WAT stdlib implementations
  // ============================================

  ctx.core.stdlib['math.sign'] = `(func $math.sign (param $x f64) (result f64)
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0))
      (then (f64.const 0.0))
      (else (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
        (then (f64.const 1.0))
        (else (f64.const -1.0))))))`

  ctx.core.stdlib['math.sin'] = `(func $math.sin (param $x f64) (result f64)
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

  ctx.core.stdlib['math.cos'] = `(func $math.cos (param $x f64) (result f64)
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

  ctx.core.stdlib['math.tan'] = `(func $math.tan (param $x f64) (result f64)
    (f64.div (call $math.sin (local.get $x)) (call $math.cos (local.get $x))))`

  ctx.core.stdlib['math.exp'] = `(func $math.exp (param $x f64) (result f64)
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

  ctx.core.stdlib['math.expm1'] = `(func $math.expm1 (param $x f64) (result f64)
    (f64.sub (call $math.exp (local.get $x)) (f64.const 1.0)))`

  ctx.core.stdlib['math.log'] = `(func $math.log (param $x f64) (result f64)
    (local $k i32) (local $y f64) (local $s f64) (local $z f64)
    (if (f64.ne (local.get $x) (local.get $x))
      (then (return (local.get $x))))
    (if (f64.le (local.get $x) (f64.const 0.0))
      (then (return (f64.const 0.0))))
    (if (f64.eq (local.get $x) (f64.const 1.0))
      (then (return (f64.const 0.0))))
    (if (f64.eq (local.get $x) (f64.const inf))
      (then (return (local.get $x))))
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

  ctx.core.stdlib['math.log2'] = `(func $math.log2 (param $x f64) (result f64)
    (f64.div (call $math.log (local.get $x)) (f64.const ${Math.LN2})))`

  ctx.core.stdlib['math.log10'] = `(func $math.log10 (param $x f64) (result f64)
    (f64.div (call $math.log (local.get $x)) (f64.const ${Math.LN10})))`

  ctx.core.stdlib['math.log1p'] = `(func $math.log1p (param $x f64) (result f64)
    (call $math.log (f64.add (f64.const 1.0) (local.get $x))))`

  ctx.core.stdlib['math.pow'] = `(func $math.pow (param $x f64) (param $y f64) (result f64)
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

  ctx.core.stdlib['math.atan'] = `(func $math.atan (param $x f64) (result f64)
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

  ctx.core.stdlib['math.asin'] = `(func $math.asin (param $x f64) (result f64)
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 1.0))
      (then (f64.const 0.0))
      (else (call $math.atan (f64.div (local.get $x)
        (f64.sqrt (f64.sub (f64.const 1.0) (f64.mul (local.get $x) (local.get $x)))))))))`

  ctx.core.stdlib['math.acos'] = `(func $math.acos (param $x f64) (result f64)
    (f64.sub (f64.const ${Math.PI / 2}) (call $math.asin (local.get $x))))`

  ctx.core.stdlib['math.atan2'] = `(func $math.atan2 (param $y f64) (param $x f64) (result f64)
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0)) (then
      (if (result f64) (f64.eq (local.get $y) (f64.const 0.0)) (then (f64.const 0.0)) (else
        (if (result f64) (f64.gt (local.get $y) (f64.const 0.0)) (then (f64.const ${Math.PI / 2})) (else (f64.neg (f64.const ${Math.PI / 2})))))))
      (else (if (result f64) (f64.ge (local.get $x) (f64.const 0.0))
        (then (call $math.atan (f64.div (local.get $y) (local.get $x))))
        (else (if (result f64) (f64.ge (local.get $y) (f64.const 0.0))
          (then (f64.add (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${Math.PI})))
          (else (f64.sub (call $math.atan (f64.div (local.get $y) (local.get $x))) (f64.const ${Math.PI})))))))))`

  ctx.core.stdlib['math.sinh'] = `(func $math.sinh (param $x f64) (result f64)
    (local $ex f64)
    (local.set $ex (call $math.exp (f64.abs (local.get $x))))
    (local.set $ex (f64.mul (f64.const 0.5) (f64.sub (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $ex))) (else (local.get $ex))))`

  ctx.core.stdlib['math.cosh'] = `(func $math.cosh (param $x f64) (result f64)
    (local $ex f64) (local.set $ex (call $math.exp (f64.abs (local.get $x))))
    (f64.mul (f64.const 0.5) (f64.add (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))`

  ctx.core.stdlib['math.tanh'] = `(func $math.tanh (param $x f64) (result f64)
    (local $e2x f64)
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 22.0))
      (then (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.const -1.0)) (else (f64.const 1.0))))
      (else (local.set $e2x (call $math.exp (f64.mul (f64.const 2.0) (f64.abs (local.get $x)))))
        (local.set $e2x (f64.div (f64.sub (local.get $e2x) (f64.const 1.0)) (f64.add (local.get $e2x) (f64.const 1.0))))
        (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $e2x))) (else (local.get $e2x))))))`

  ctx.core.stdlib['math.asinh'] = `(func $math.asinh (param $x f64) (result f64)
    (call $math.log (f64.add (local.get $x) (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))`

  ctx.core.stdlib['math.acosh'] = `(func $math.acosh (param $x f64) (result f64)
    (if (result f64) (f64.lt (local.get $x) (f64.const 1.0)) (then (f64.const 0.0)) (else
      (call $math.log (f64.add (local.get $x) (f64.sqrt (f64.sub (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))))`

  ctx.core.stdlib['math.atanh'] = `(func $math.atanh (param $x f64) (result f64)
    (f64.mul (f64.const 0.5) (call $math.log (f64.div (f64.add (f64.const 1.0) (local.get $x)) (f64.sub (f64.const 1.0) (local.get $x))))))`

  ctx.core.stdlib['math.cbrt'] = `(func $math.cbrt (param $x f64) (result f64)
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

  ctx.core.stdlib['math.hypot'] = `(func $math.hypot (param $x f64) (param $y f64) (result f64)
    (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.mul (local.get $y) (local.get $y)))))`

  ctx.core.stdlib['math.random'] = `(func $math.random (result f64)
    (local $s i32)
    (local.set $s (global.get $math.rng_state))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))
    (local.set $s (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 17))))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 5))))
    (global.set $math.rng_state (local.get $s))
    (f64.div (f64.convert_i32_u (i32.and (local.get $s) (i32.const 0x7FFFFFFF))) (f64.const 2147483647.0)))`

  // Global for random state
  ctx.scope.globals.set('math.rng_state', '(global $math.rng_state (mut i32) (i32.const 12345))')
}
