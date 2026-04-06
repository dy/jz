/**
 * Number module — toString, toFixed, toPrecision, toExponential, String().
 *
 * Core: __ftoa(f64, precision, mode) → f64 (NaN-boxed string pointer).
 * Modes: 0=default (shortest repr), 1=fixed (toFixed).
 * Uses integer-based digit extraction to avoid float drift.
 * Static string table at address 0 for NaN, Infinity, etc.
 *
 * @module number
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const STRING = 4

export default () => {
  const inc = (...names) => names.forEach(n => ctx.includes.add(n))

  // __pow10(n: i32) → f64 — compute 10^n via loop
  ctx.stdlib['__pow10'] = `(func $__pow10 (param $n i32) (result f64)
    (local $r f64)
    (local.set $r (f64.const 1))
    (block $d (loop $l
      (br_if $d (i32.le_s (local.get $n) (i32.const 0)))
      (local.set $r (f64.mul (local.get $r) (f64.const 10)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $l)))
    (local.get $r))`

  // __itoa(val: i32, buf: i32) → i32 (digit count). Writes decimal digits to buf.
  ctx.stdlib['__itoa'] = `(func $__itoa (param $val i32) (param $buf i32) (result i32)
    (local $len i32) (local $i i32) (local $j i32) (local $tmp i32)
    (if (i32.eqz (local.get $val))
      (then (i32.store8 (local.get $buf) (i32.const 48)) (return (i32.const 1))))
    (local.set $tmp (local.get $val))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $tmp)))
      (i32.store8 (i32.add (local.get $buf) (local.get $len))
        (i32.add (i32.const 48) (i32.rem_u (local.get $tmp) (i32.const 10))))
      (local.set $tmp (i32.div_u (local.get $tmp) (i32.const 10)))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $l)))
    ;; Reverse
    (local.set $j (i32.sub (local.get $len) (i32.const 1)))
    (block $rd (loop $rl
      (br_if $rd (i32.ge_s (local.get $i) (local.get $j)))
      (local.set $tmp (i32.load8_u (i32.add (local.get $buf) (local.get $i))))
      (i32.store8 (i32.add (local.get $buf) (local.get $i))
        (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
      (i32.store8 (i32.add (local.get $buf) (local.get $j)) (local.get $tmp))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $j (i32.sub (local.get $j) (i32.const 1)))
      (br $rl)))
    (local.get $len))`

  // __mkstr(buf: i32, len: i32) → f64 — copy scratch buffer to heap string
  ctx.stdlib['__mkstr'] = `(func $__mkstr (param $buf i32) (param $len i32) (result f64)
    (local $off i32) (local $i i32)
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $off) (local.get $len))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $off) (local.get $i))
        (i32.load8_u (i32.add (local.get $buf) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $__mkptr (i32.const ${STRING}) (i32.const 0) (local.get $off)))`

  // __ftoa(val: f64, prec: i32, mode: i32) → f64 (NaN-boxed string)
  // mode 0: default (shortest repr, strip trailing zeros)
  // mode 1: fixed (exactly prec decimal places)
  // Uses integer-scaled digit extraction to avoid float drift.
  ctx.stdlib['__ftoa'] = `(func $__ftoa (param $val f64) (param $prec i32) (param $mode i32) (result f64)
    (local $buf i32) (local $pos i32) (local $neg i32)
    (local $abs f64) (local $scale f64) (local $scaled f64)
    (local $int i32) (local $frac i32) (local $ilen i32) (local $flen i32)
    (local $i i32) (local $j i32)
    ;; Special values
    (if (f64.ne (local.get $val) (local.get $val)) (then (return (call $__static_str (i32.const 0)))))
    (if (f64.eq (local.get $val) (f64.const inf)) (then (return (call $__static_str (i32.const 1)))))
    (if (f64.eq (local.get $val) (f64.const -inf)) (then (return (call $__static_str (i32.const 2)))))
    (local.set $buf (call $__alloc (i32.const 40)))
    ;; Sign
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $val (f64.neg (local.get $val)))))
    (if (i32.and (f64.eq (local.get $val) (f64.const 0)) (local.get $neg))
      (then (local.set $neg (i32.const 0))))
    (if (local.get $neg)
      (then (i32.store8 (local.get $buf) (i32.const 45))
        (local.set $pos (i32.const 1))))
    ;; Default mode: auto-select precision (up to 9 digits, must fit i32 when scaled)
    (if (i32.eqz (local.get $mode))
      (then (local.set $prec (i32.const 9))))
    ;; Round and scale to integer: scaled = nearest(val * 10^prec)
    (local.set $scale (call $__pow10 (local.get $prec)))
    (local.set $scaled (f64.nearest (f64.mul (local.get $val) (local.get $scale))))
    ;; If scaled doesn't fit i32, reduce precision until it does (min prec=0)
    (block $fit (loop $fitl
      (br_if $fit (f64.lt (local.get $scaled) (f64.const 2147483648)))
      (br_if $fit (i32.le_s (local.get $prec) (i32.const 0)))
      (local.set $prec (i32.sub (local.get $prec) (i32.const 1)))
      (local.set $scale (call $__pow10 (local.get $prec)))
      (local.set $scaled (f64.nearest (f64.mul (local.get $val) (local.get $scale))))
      (br $fitl)))
    ;; Split: int = scaled / scale, frac = scaled % scale
    (if (f64.lt (local.get $scaled) (f64.const 2147483648))
      (then
        (local.set $int (i32.trunc_f64_u (f64.div (local.get $scaled) (local.get $scale))))
        (local.set $frac (i32.trunc_f64_u (f64.sub (local.get $scaled)
          (f64.mul (f64.convert_i32_u (local.get $int)) (local.get $scale))))))
      (else
        (local.set $int (i32.const 0))
        (local.set $frac (i32.const 0))
        (local.set $prec (i32.const 0))
        (local.set $abs (f64.trunc (local.get $val)))
        ;; Write large integer digits reversed
        (local.set $ilen (local.get $pos))
        (block $ld (loop $ll
          (br_if $ld (f64.lt (local.get $abs) (f64.const 1)))
          (i32.store8 (i32.add (local.get $buf) (local.get $pos))
            (i32.add (i32.const 48) (i32.trunc_f64_u (f64.sub (local.get $abs)
              (f64.mul (f64.trunc (f64.div (local.get $abs) (f64.const 10))) (f64.const 10))))))
          (local.set $abs (f64.trunc (f64.div (local.get $abs) (f64.const 10))))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (br $ll)))
        ;; Reverse
        (local.set $i (local.get $ilen)) (local.set $j (i32.sub (local.get $pos) (i32.const 1)))
        (block $rd (loop $rl
          (br_if $rd (i32.ge_s (local.get $i) (local.get $j)))
          (local.set $int (i32.load8_u (i32.add (local.get $buf) (local.get $i))))
          (i32.store8 (i32.add (local.get $buf) (local.get $i))
            (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
          (i32.store8 (i32.add (local.get $buf) (local.get $j)) (local.get $int))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (local.set $j (i32.sub (local.get $j) (i32.const 1)))
          (br $rl)))
        (return (call $__mkstr (local.get $buf) (local.get $pos)))))
    ;; Write integer part
    (local.set $ilen (call $__itoa (local.get $int) (i32.add (local.get $buf) (local.get $pos))))
    (local.set $pos (i32.add (local.get $pos) (local.get $ilen)))
    ;; Write fractional part: extract digits from $frac by dividing by 10^(prec-1), 10^(prec-2), ...
    (if (i32.gt_s (local.get $prec) (i32.const 0))
      (then
        (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 46))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (local.set $i (i32.sub (local.get $prec) (i32.const 1)))
        (block $fd (loop $fl
          (br_if $fd (i32.lt_s (local.get $i) (i32.const 0)))
          (local.set $j (i32.div_u (local.get $frac) (i32.trunc_f64_u (call $__pow10 (local.get $i)))))
          (i32.store8 (i32.add (local.get $buf) (local.get $pos))
            (i32.add (i32.const 48) (i32.rem_u (local.get $j) (i32.const 10))))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (local.set $i (i32.sub (local.get $i) (i32.const 1)))
          (br $fl)))))
    ;; Default mode: strip trailing zeros and dot
    (if (i32.eqz (local.get $mode))
      (then
        (block $sd (loop $sl
          (br_if $sd (i32.le_s (local.get $pos) (i32.const 0)))
          (br_if $sd (i32.ne (i32.load8_u (i32.add (local.get $buf) (i32.sub (local.get $pos) (i32.const 1)))) (i32.const 48)))
          (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))
          (br $sl)))
        (if (i32.and (i32.gt_s (local.get $pos) (i32.const 0))
              (i32.eq (i32.load8_u (i32.add (local.get $buf) (i32.sub (local.get $pos) (i32.const 1)))) (i32.const 46)))
          (then (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))))))
    (call $__mkstr (local.get $buf) (local.get $pos)))`

  // __toExp(val: f64, prec: i32) → f64 (NaN-boxed string)
  // Format: [-]d.ddd...e[+/-]dd — integer-based digit extraction
  ctx.stdlib['__toExp'] = `(func $__toExp (param $val f64) (param $prec i32) (result f64)
    (local $buf i32) (local $pos i32) (local $neg i32) (local $exp i32)
    (local $len i32) (local $i i32) (local $j i32)
    (local $mantissa f64) (local $scale f64)
    (if (f64.ne (local.get $val) (local.get $val)) (then (return (call $__static_str (i32.const 0)))))
    (if (f64.eq (local.get $val) (f64.const inf)) (then (return (call $__static_str (i32.const 1)))))
    (if (f64.eq (local.get $val) (f64.const -inf)) (then (return (call $__static_str (i32.const 2)))))
    (local.set $buf (call $__alloc (i32.const 32)))
    ;; Sign
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $val (f64.neg (local.get $val)))))
    (if (i32.and (f64.eq (local.get $val) (f64.const 0)) (local.get $neg))
      (then (local.set $neg (i32.const 0))))
    (if (local.get $neg)
      (then (i32.store8 (local.get $buf) (i32.const 45))
        (local.set $pos (i32.const 1))))
    ;; Normalize: 1 <= val < 10
    (if (f64.gt (local.get $val) (f64.const 0))
      (then
        (block $d1 (loop $l1
          (br_if $d1 (f64.lt (local.get $val) (f64.const 10)))
          (local.set $val (f64.div (local.get $val) (f64.const 10)))
          (local.set $exp (i32.add (local.get $exp) (i32.const 1)))
          (br $l1)))
        (block $d2 (loop $l2
          (br_if $d2 (f64.ge (local.get $val) (f64.const 1)))
          (local.set $val (f64.mul (local.get $val) (f64.const 10)))
          (local.set $exp (i32.sub (local.get $exp) (i32.const 1)))
          (br $l2)))))
    ;; Scale to integer mantissa: nearest(val * 10^prec)
    (local.set $scale (call $__pow10 (local.get $prec)))
    (local.set $mantissa (f64.nearest (f64.mul (local.get $val) (local.get $scale))))
    ;; Rounding overflow (e.g. 9.95 → 1000 when prec=1, scale=10)
    (if (f64.ge (local.get $mantissa) (f64.mul (f64.const 10) (local.get $scale)))
      (then
        (local.set $mantissa (f64.div (local.get $mantissa) (f64.const 10)))
        (local.set $exp (i32.add (local.get $exp) (i32.const 1)))))
    ;; Write mantissa digits via itoa
    (local.set $len (call $__itoa (i32.trunc_f64_u (local.get $mantissa)) (i32.add (local.get $buf) (local.get $pos))))
    ;; Insert '.' after first digit
    (if (i32.gt_s (local.get $prec) (i32.const 0))
      (then
        (local.set $i (local.get $len))
        (block $md (loop $ml
          (br_if $md (i32.le_s (local.get $i) (i32.const 1)))
          (i32.store8 (i32.add (local.get $buf) (i32.add (local.get $pos) (local.get $i)))
            (i32.load8_u (i32.add (local.get $buf) (i32.add (local.get $pos) (i32.sub (local.get $i) (i32.const 1))))))
          (local.set $i (i32.sub (local.get $i) (i32.const 1)))
          (br $ml)))
        (i32.store8 (i32.add (local.get $buf) (i32.add (local.get $pos) (i32.const 1))) (i32.const 46))
        (local.set $pos (i32.add (local.get $pos) (i32.add (local.get $len) (i32.const 1)))))
      (else (local.set $pos (i32.add (local.get $pos) (local.get $len)))))
    ;; Write 'e', sign, exponent
    (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 101))
    (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
    (if (i32.lt_s (local.get $exp) (i32.const 0))
      (then (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 45))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (local.set $exp (i32.sub (i32.const 0) (local.get $exp))))
      (else (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 43))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
    (local.set $pos (i32.add (local.get $pos) (call $__itoa (local.get $exp) (i32.add (local.get $buf) (local.get $pos)))))
    (call $__mkstr (local.get $buf) (local.get $pos)))`

  // __static_str(id: i32) → f64 — create heap string from data segment
  // 0=NaN 1=Infinity 2=-Infinity 3=true 4=false 5=null 6=undefined 7=[Array] 8=[Object]
  ctx.stdlib['__static_str'] = `(func $__static_str (param $id i32) (result f64)
    (local $src i32) (local $len i32)
    (local.set $src (i32.const 0)) (local.set $len (i32.const 0))
    (if (i32.eqz (local.get $id))                   (then (local.set $len (i32.const 3))))
    (if (i32.eq (local.get $id) (i32.const 1)) (then (local.set $src (i32.const 3))  (local.set $len (i32.const 8))))
    (if (i32.eq (local.get $id) (i32.const 2)) (then (local.set $src (i32.const 11)) (local.set $len (i32.const 9))))
    (if (i32.eq (local.get $id) (i32.const 3)) (then (local.set $src (i32.const 20)) (local.set $len (i32.const 4))))
    (if (i32.eq (local.get $id) (i32.const 4)) (then (local.set $src (i32.const 24)) (local.set $len (i32.const 5))))
    (if (i32.eq (local.get $id) (i32.const 5)) (then (local.set $src (i32.const 29)) (local.set $len (i32.const 4))))
    (if (i32.eq (local.get $id) (i32.const 6)) (then (local.set $src (i32.const 33)) (local.set $len (i32.const 9))))
    (if (i32.eq (local.get $id) (i32.const 7)) (then (local.set $src (i32.const 42)) (local.set $len (i32.const 7))))
    (if (i32.eq (local.get $id) (i32.const 8)) (then (local.set $src (i32.const 49)) (local.set $len (i32.const 8))))
    (call $__mkstr (local.get $src) (local.get $len)))`

  // Data segment: static strings at address 0 (heap starts at 1024)
  // "NaN" "Infinity" "-Infinity" "true" "false" "null" "undefined" "[Array]" "[Object]"
  ctx.data = (ctx.data || '') + 'NaNInfinity-Infinitytruefalsenullundefined[Array][Object]'

  // === Number constants ===

  ctx.emit['Number.MAX_SAFE_INTEGER'] = () => typed(['f64.const', 9007199254740991], 'f64')
  ctx.emit['Number.MIN_SAFE_INTEGER'] = () => typed(['f64.const', -9007199254740991], 'f64')
  ctx.emit['Number.EPSILON'] = () => typed(['f64.const', 2.220446049250313e-16], 'f64')
  ctx.emit['Number.MAX_VALUE'] = () => typed(['f64.const', 1.7976931348623157e+308], 'f64')
  ctx.emit['Number.MIN_VALUE'] = () => typed(['f64.const', 5e-324], 'f64')
  ctx.emit['Number.POSITIVE_INFINITY'] = () => typed(['f64.const', Infinity], 'f64')
  ctx.emit['Number.NEGATIVE_INFINITY'] = () => typed(['f64.const', -Infinity], 'f64')
  ctx.emit['Number.NaN'] = () => typed(['f64.const', NaN], 'f64')

  // === Number static methods ===

  ctx.emit['Number.isNaN'] = (x) => {
    const v = asF64(emit(x))
    const t = `__t${ctx.uniq++}`; ctx.locals.set(t, 'f64')
    return typed(['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]], 'i32')
  }

  ctx.emit['Number.isFinite'] = (x) => {
    const v = asF64(emit(x))
    const t = `__t${ctx.uniq++}`; ctx.locals.set(t, 'f64')
    return typed(['i32.and',
      ['f64.eq', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      ['f64.lt', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', Infinity]]], 'i32')
  }

  ctx.emit['Number.isInteger'] = (x) => {
    const v = asF64(emit(x))
    const t = `__t${ctx.uniq++}`; ctx.locals.set(t, 'f64')
    return typed(['i32.and',
      ['i32.and',
        ['f64.eq', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
        ['f64.lt', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', Infinity]]],
      ['f64.eq', ['local.get', `$${t}`], ['f64.trunc', ['local.get', `$${t}`]]]], 'i32')
  }

  ctx.emit['Number.parseInt'] = (x) => typed(['f64.trunc', asF64(emit(x))], 'f64')
  ctx.emit['Number.parseFloat'] = (x) => asF64(emit(x))

  // === Instance method emitters ===

  const incNum = () => inc('__ftoa', '__itoa', '__pow10', '__mkstr', '__static_str')

  ctx.emit['.number:toString'] = (n) => {
    incNum()
    return typed(['call', '$__ftoa', asF64(emit(n)), ['i32.const', 0], ['i32.const', 0]], 'f64')
  }

  ctx.emit['.number:toFixed'] = (n, d) => {
    incNum()
    return typed(['call', '$__ftoa', asF64(emit(n)), asI32(emit(d || [, 0])), ['i32.const', 1]], 'f64')
  }

  ctx.emit['.number:toExponential'] = (n, d) => {
    inc('__toExp', '__itoa', '__pow10', '__mkstr', '__static_str')
    return typed(['call', '$__toExp', asF64(emit(n)), asI32(emit(d || [, 0]))], 'f64')
  }

  ctx.emit['.number:toPrecision'] = (n, p) => {
    incNum(); inc('__toExp')
    const val = `__pv${ctx.uniq++}`, t = `__tp${ctx.uniq++}`, exp = `__te${ctx.uniq++}`, pr = `__pp${ctx.uniq++}`
    ctx.locals.set(val, 'f64'); ctx.locals.set(t, 'f64'); ctx.locals.set(exp, 'i32'); ctx.locals.set(pr, 'i32')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${val}`, asF64(emit(n))],
      ['local.set', `$${pr}`, asI32(emit(p))],
      ['local.set', `$${t}`, ['f64.abs', ['local.get', `$${val}`]]],
      ['local.set', `$${exp}`, ['i32.const', 0]],
      ['if', ['f64.gt', ['local.get', `$${t}`], ['f64.const', 0]],
        ['then',
          ['block', '$d1', ['loop', '$l1',
            ['br_if', '$d1', ['f64.lt', ['local.get', `$${t}`], ['f64.const', 10]]],
            ['local.set', `$${t}`, ['f64.div', ['local.get', `$${t}`], ['f64.const', 10]]],
            ['local.set', `$${exp}`, ['i32.add', ['local.get', `$${exp}`], ['i32.const', 1]]],
            ['br', '$l1']]],
          ['block', '$d2', ['loop', '$l2',
            ['br_if', '$d2', ['f64.ge', ['local.get', `$${t}`], ['f64.const', 1]]],
            ['local.set', `$${t}`, ['f64.mul', ['local.get', `$${t}`], ['f64.const', 10]]],
            ['local.set', `$${exp}`, ['i32.sub', ['local.get', `$${exp}`], ['i32.const', 1]]],
            ['br', '$l2']]]]],
      ['if', ['result', 'f64'],
        ['i32.or',
          ['i32.lt_s', ['local.get', `$${exp}`], ['i32.const', -6]],
          ['i32.ge_s', ['local.get', `$${exp}`], ['local.get', `$${pr}`]]],
        ['then', ['call', '$__toExp', ['local.get', `$${val}`], ['i32.sub', ['local.get', `$${pr}`], ['i32.const', 1]]]],
        ['else', ['call', '$__ftoa', ['local.get', `$${val}`],
          ['i32.sub', ['i32.sub', ['local.get', `$${pr}`], ['i32.const', 1]], ['local.get', `$${exp}`]],
          ['i32.const', 1]]]]], 'f64')
  }

  ctx.emit['String'] = (x) => {
    incNum()
    if (Array.isArray(x) && x[0] === 'str') return emit(x)
    return typed(['call', '$__ftoa', asF64(emit(x)), ['i32.const', 0], ['i32.const', 0]], 'f64')
  }
}
