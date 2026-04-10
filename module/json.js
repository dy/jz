/**
 * JSON module — JSON.stringify and JSON.parse.
 *
 * stringify: recursive type-dispatch → string assembly in scratch buffer.
 * parse: recursive descent parser using globals for input position.
 * Objects parsed as Map (dynamic keys). Arrays as standard jz arrays.
 *
 * @module json
 */

import { emit, typed, asF64 } from '../src/compile.js'
import { ctx, inc, PTR } from '../src/ctx.js'

export default () => {

  // === JSON.stringify ===

  // Scratch buffer approach: __json_buf is a growable output buffer.
  // Functions append bytes to it, __json_pos tracks current write position.

  ctx.globals.set('__jbuf', '(global $__jbuf (mut i32) (i32.const 0))')
  ctx.globals.set('__jpos', '(global $__jpos (mut i32) (i32.const 0))')
  ctx.globals.set('__jcap', '(global $__jcap (mut i32) (i32.const 0))')

  // __jput(byte: i32) — append one byte to output buffer
  ctx.stdlib['__jput'] = `(func $__jput (param $b i32)
    (local $new i32)
    (if (i32.ge_s (global.get $__jpos) (global.get $__jcap))
      (then
        (global.set $__jcap (i32.shl (i32.add (global.get $__jcap) (i32.const 1)) (i32.const 1)))
        (local.set $new (call $__alloc (global.get $__jcap)))
        (memory.copy (local.get $new) (global.get $__jbuf) (global.get $__jpos))
        (global.set $__jbuf (local.get $new))))
    (i32.store8 (i32.add (global.get $__jbuf) (global.get $__jpos)) (local.get $b))
    (global.set $__jpos (i32.add (global.get $__jpos) (i32.const 1))))`

  // __jput_str(ptr: f64) — append string chars (without quotes) to buffer
  ctx.stdlib['__jput_str'] = `(func $__jput_str (param $ptr f64)
    (local $len i32) (local $i i32) (local $ch i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $ch (call $__char_at (local.get $ptr) (local.get $i)))
      ;; Escape special JSON chars
      (if (i32.le_u (local.get $ch) (i32.const 13))
        (then
          (if (i32.eq (local.get $ch) (i32.const 10)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 110)))
          (else (if (i32.eq (local.get $ch) (i32.const 13)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 114)))
          (else (if (i32.eq (local.get $ch) (i32.const 9)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 116)))
          (else (if (i32.eq (local.get $ch) (i32.const 8)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 98)))
          (else (if (i32.eq (local.get $ch) (i32.const 12)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 102)))
            (else (call $__jput (local.get $ch)))))))))))))
        (else
          (if (i32.eq (local.get $ch) (i32.const 34)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 34)))
          (else (if (i32.eq (local.get $ch) (i32.const 92)) (then (call $__jput (i32.const 92)) (call $__jput (i32.const 92)))
            (else (call $__jput (local.get $ch))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))`

  // __jput_num(val: f64) — convert number to string, append bytes to buffer
  ctx.stdlib['__jput_num'] = `(func $__jput_num (param $val f64)
    (call $__jput_str (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0))))`

  // __json_val(val: f64) — stringify any value, append to buffer
  ctx.stdlib['__json_val'] = `(func $__json_val (param $val f64)
    (local $type i32) (local $len i32) (local $i i32) (local $off i32)
    ;; Number (not NaN) — but Infinity must be null per JSON spec
    (if (f64.eq (local.get $val) (local.get $val))
      (then
        (if (f64.eq (f64.abs (local.get $val)) (f64.const inf))
          (then
            (call $__jput (i32.const 110)) (call $__jput (i32.const 117))
            (call $__jput (i32.const 108)) (call $__jput (i32.const 108)) (return)))
        (call $__jput_num (local.get $val)) (return)))
    ;; NaN-boxed pointer
    (local.set $type (call $__ptr_type (local.get $val)))
    ;; Plain NaN (type=0) → null
    (if (i32.eqz (local.get $type))
      (then
        (call $__jput (i32.const 110)) (call $__jput (i32.const 117))
        (call $__jput (i32.const 108)) (call $__jput (i32.const 108)) (return)))
    ;; String
    (if (i32.or (i32.eq (local.get $type) (i32.const ${PTR.STRING}))
                (i32.eq (local.get $type) (i32.const ${PTR.SSO})))
      (then
        (call $__jput (i32.const 34))
        (call $__jput_str (local.get $val))
        (call $__jput (i32.const 34)) (return)))
    ;; Array
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then
        (call $__jput (i32.const 91))  ;; [
        (local.set $len (call $__len (local.get $val)))
        (local.set $off (call $__ptr_offset (local.get $val)))
        (local.set $i (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
          (if (local.get $i) (then (call $__jput (i32.const 44))))  ;; ,
          (call $__json_val (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
        (call $__jput (i32.const 93))  ;; ]
        (return)))
    ;; Object/Map/Hash → {}
    (if (i32.or (i32.or (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
                        (i32.eq (local.get $type) (i32.const ${PTR.HASH})))
                (i32.eq (local.get $type) (i32.const ${PTR.MAP})))
      (then
        (call $__jput (i32.const 123))
        (call $__jput (i32.const 125))
        (return)))
    ;; Unknown type → null
    (call $__jput (i32.const 110)) (call $__jput (i32.const 117))
    (call $__jput (i32.const 108)) (call $__jput (i32.const 108)))`

  // __stringify(val: f64) → f64 (NaN-boxed string)
  ctx.stdlib['__stringify'] = `(func $__stringify (param $val f64) (result f64)
    ;; Reset output buffer
    (global.set $__jbuf (call $__alloc (i32.const 256)))
    (global.set $__jpos (i32.const 0))
    (global.set $__jcap (i32.const 256))
    (call $__json_val (local.get $val))
    ;; Create string from buffer
    (call $__mkstr (global.get $__jbuf) (global.get $__jpos)))`

  // === JSON.parse ===

  ctx.globals.set('__jpstr', '(global $__jpstr (mut i32) (i32.const 0))')  // input string offset
  ctx.globals.set('__jplen', '(global $__jplen (mut i32) (i32.const 0))')  // input length
  ctx.globals.set('__jppos', '(global $__jppos (mut i32) (i32.const 0))')  // current parse position

  ctx.stdlib['__jp_peek'] = `(func $__jp_peek (result i32)
    (if (result i32) (i32.ge_s (global.get $__jppos) (global.get $__jplen))
      (then (i32.const -1))
      (else (i32.load8_u (i32.add (global.get $__jpstr) (global.get $__jppos))))))`

  ctx.stdlib['__jp_adv'] = `(func $__jp_adv (param $n i32)
    (global.set $__jppos (i32.add (global.get $__jppos) (local.get $n))))`

  ctx.stdlib['__jp_ws'] = `(func $__jp_ws
    (local $ch i32)
    (block $d (loop $l
      (local.set $ch (call $__jp_peek))
      (br_if $d (i32.and (i32.ne (local.get $ch) (i32.const 32))
        (i32.and (i32.ne (local.get $ch) (i32.const 9))
          (i32.and (i32.ne (local.get $ch) (i32.const 10))
            (i32.ne (local.get $ch) (i32.const 13))))))
      (call $__jp_adv (i32.const 1))
      (br $l))))`

  // Parse string (after opening " consumed)
  ctx.stdlib['__jp_str'] = `(func $__jp_str (result f64)
    (local $start i32) (local $ch i32) (local $len i32) (local $off i32) (local $i i32)
    (local.set $start (global.get $__jppos))
    ;; Scan to closing quote
    (block $d (loop $l
      (local.set $ch (call $__jp_peek))
      (br_if $d (i32.eq (local.get $ch) (i32.const 34)))
      (br_if $d (i32.eq (local.get $ch) (i32.const -1)))
      (if (i32.eq (local.get $ch) (i32.const 92))
        (then (call $__jp_adv (i32.const 2)))
        (else (call $__jp_adv (i32.const 1))))
      (br $l)))
    (local.set $len (i32.sub (global.get $__jppos) (local.get $start)))
    (call $__jp_adv (i32.const 1))  ;; skip "
    ;; Copy chars to new string (handles escapes inline)
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (global.set $__jppos (local.get $start))  ;; rewind to re-scan
    (local.set $len (i32.const 0))  ;; actual output length
    (block $d2 (loop $l2
      (local.set $ch (call $__jp_peek))
      (br_if $d2 (i32.eq (local.get $ch) (i32.const 34)))
      (br_if $d2 (i32.eq (local.get $ch) (i32.const -1)))
      (if (i32.eq (local.get $ch) (i32.const 92))
        (then
          (call $__jp_adv (i32.const 1))
          (local.set $ch (call $__jp_peek))
          (call $__jp_adv (i32.const 1))
          ;; Decode escape: n→10 t→9 r→13 b→8 f→12, else literal
          (if (i32.eq (local.get $ch) (i32.const 110)) (then (local.set $ch (i32.const 10))))
          (if (i32.eq (local.get $ch) (i32.const 116)) (then (local.set $ch (i32.const 9))))
          (if (i32.eq (local.get $ch) (i32.const 114)) (then (local.set $ch (i32.const 13))))
          (if (i32.eq (local.get $ch) (i32.const 98))  (then (local.set $ch (i32.const 8))))
          (if (i32.eq (local.get $ch) (i32.const 102)) (then (local.set $ch (i32.const 12)))))
        (else (call $__jp_adv (i32.const 1))))
      (i32.store8 (i32.add (local.get $off) (local.get $len)) (local.get $ch))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $l2)))
    (call $__jp_adv (i32.const 1))  ;; skip closing "
    ;; Store actual length in header
    (i32.store (i32.sub (local.get $off) (i32.const 4)) (local.get $len))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  // Parse number
  ctx.stdlib['__jp_num'] = `(func $__jp_num (result f64)
    (local $neg i32) (local $val f64) (local $scale f64) (local $ch i32)
    (local $exp i32) (local $expNeg i32)
    (if (i32.eq (call $__jp_peek) (i32.const 45))
      (then (local.set $neg (i32.const 1)) (call $__jp_adv (i32.const 1))))
    (block $d (loop $l
      (local.set $ch (call $__jp_peek))
      (br_if $d (i32.or (i32.lt_s (local.get $ch) (i32.const 48)) (i32.gt_s (local.get $ch) (i32.const 57))))
      (local.set $val (f64.add (f64.mul (local.get $val) (f64.const 10))
        (f64.convert_i32_s (i32.sub (local.get $ch) (i32.const 48)))))
      (call $__jp_adv (i32.const 1)) (br $l)))
    (if (i32.eq (call $__jp_peek) (i32.const 46))
      (then
        (call $__jp_adv (i32.const 1))
        (local.set $scale (f64.const 0.1))
        (block $fd (loop $fl
          (local.set $ch (call $__jp_peek))
          (br_if $fd (i32.or (i32.lt_s (local.get $ch) (i32.const 48)) (i32.gt_s (local.get $ch) (i32.const 57))))
          (local.set $val (f64.add (local.get $val)
            (f64.mul (local.get $scale) (f64.convert_i32_s (i32.sub (local.get $ch) (i32.const 48))))))
          (local.set $scale (f64.mul (local.get $scale) (f64.const 0.1)))
          (call $__jp_adv (i32.const 1)) (br $fl)))))
    (if (i32.or (i32.eq (call $__jp_peek) (i32.const 101)) (i32.eq (call $__jp_peek) (i32.const 69)))
      (then
        (call $__jp_adv (i32.const 1))
        (if (i32.eq (call $__jp_peek) (i32.const 45))
          (then (local.set $expNeg (i32.const 1)) (call $__jp_adv (i32.const 1)))
        (else (if (i32.eq (call $__jp_peek) (i32.const 43))
          (then (call $__jp_adv (i32.const 1))))))
        (block $ed (loop $el
          (local.set $ch (call $__jp_peek))
          (br_if $ed (i32.or (i32.lt_s (local.get $ch) (i32.const 48)) (i32.gt_s (local.get $ch) (i32.const 57))))
          (local.set $exp (i32.add (i32.mul (local.get $exp) (i32.const 10)) (i32.sub (local.get $ch) (i32.const 48))))
          (call $__jp_adv (i32.const 1)) (br $el)))
        (if (local.get $expNeg) (then (local.set $exp (i32.sub (i32.const 0) (local.get $exp)))))
        (local.set $val (f64.mul (local.get $val) (call $__pow10
          (if (result i32) (i32.lt_s (local.get $exp) (i32.const 0))
            (then (i32.const 0)) (else (local.get $exp))))))
        (if (i32.lt_s (local.get $exp) (i32.const 0))
          (then (local.set $val (f64.div (local.get $val) (call $__pow10 (i32.sub (i32.const 0) (local.get $exp)))))))))
    (if (result f64) (local.get $neg) (then (f64.neg (local.get $val))) (else (local.get $val))))`

  // Parse array
  ctx.stdlib['__jp_arr'] = `(func $__jp_arr (result f64)
    (local $ptr i32) (local $len i32) (local $cap i32) (local $new i32) (local $ch i32)
    (local.set $cap (i32.const 8))
    (local.set $ptr (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $cap) (i32.const 3)))))
    (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
    (call $__jp_ws)
    (if (i32.eq (call $__jp_peek) (i32.const 93))
      (then (call $__jp_adv (i32.const 1))
        (i32.store (i32.sub (local.get $ptr) (i32.const 8)) (i32.const 0))
        (i32.store (i32.sub (local.get $ptr) (i32.const 4)) (local.get $cap))
        (return (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $ptr)))))
    (block $d (loop $l
      (call $__jp_ws)
      ;; Grow if needed
      (if (i32.ge_s (local.get $len) (local.get $cap))
        (then
          (local.set $new (call $__alloc (i32.add (i32.const 8) (i32.shl (i32.shl (local.get $cap) (i32.const 1)) (i32.const 3)))))
          (local.set $new (i32.add (local.get $new) (i32.const 8)))
          (memory.copy (local.get $new) (local.get $ptr) (i32.shl (local.get $len) (i32.const 3)))
          (local.set $cap (i32.shl (local.get $cap) (i32.const 1)))
          (local.set $ptr (local.get $new))))
      (f64.store (i32.add (local.get $ptr) (i32.shl (local.get $len) (i32.const 3))) (call $__jp_val))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (call $__jp_ws)
      (local.set $ch (call $__jp_peek))
      (br_if $d (i32.eq (local.get $ch) (i32.const 93)))
      (if (i32.eq (local.get $ch) (i32.const 44)) (then (call $__jp_adv (i32.const 1))))
      (br $l)))
    (call $__jp_adv (i32.const 1))
    (i32.store (i32.sub (local.get $ptr) (i32.const 8)) (local.get $len))
    (i32.store (i32.sub (local.get $ptr) (i32.const 4)) (local.get $cap))
    (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $ptr)))`

  // Parse object → HASH (dynamic string-keyed object)
  ctx.stdlib['__jp_obj'] = `(func $__jp_obj (result f64)
    (local $obj f64) (local $key f64) (local $ch i32)
    (local.set $obj (call $__hash_new))
    (call $__jp_ws)
    (if (i32.eq (call $__jp_peek) (i32.const 125))
      (then (call $__jp_adv (i32.const 1)) (return (local.get $obj))))
    (block $d (loop $l
      (call $__jp_ws)
      (if (i32.eq (call $__jp_peek) (i32.const 34))
        (then (call $__jp_adv (i32.const 1))))
      (local.set $key (call $__jp_str))
      (call $__jp_ws)
      (if (i32.eq (call $__jp_peek) (i32.const 58))
        (then (call $__jp_adv (i32.const 1))))
      (call $__jp_ws)
      (local.set $obj (call $__hash_set (local.get $obj) (local.get $key) (call $__jp_val)))
      (call $__jp_ws)
      (local.set $ch (call $__jp_peek))
      (br_if $d (i32.eq (local.get $ch) (i32.const 125)))
      (if (i32.eq (local.get $ch) (i32.const 44)) (then (call $__jp_adv (i32.const 1))))
      (br $l)))
    (call $__jp_adv (i32.const 1))
    (local.get $obj))`

  // Main value dispatcher
  ctx.stdlib['__jp_val'] = `(func $__jp_val (result f64)
    (local $ch i32)
    (call $__jp_ws)
    (local.set $ch (call $__jp_peek))
    (if (i32.eq (local.get $ch) (i32.const 34))
      (then (call $__jp_adv (i32.const 1)) (return (call $__jp_str))))
    (if (i32.eq (local.get $ch) (i32.const 91))
      (then (call $__jp_adv (i32.const 1)) (return (call $__jp_arr))))
    (if (i32.eq (local.get $ch) (i32.const 123))
      (then (call $__jp_adv (i32.const 1)) (return (call $__jp_obj))))
    (if (i32.or (i32.and (i32.ge_s (local.get $ch) (i32.const 48)) (i32.le_s (local.get $ch) (i32.const 57)))
                (i32.eq (local.get $ch) (i32.const 45)))
      (then (return (call $__jp_num))))
    (if (i32.eq (local.get $ch) (i32.const 116))
      (then (call $__jp_adv (i32.const 4)) (return (f64.const 1))))
    (if (i32.eq (local.get $ch) (i32.const 102))
      (then (call $__jp_adv (i32.const 5)) (return (f64.const 0))))
    (if (i32.eq (local.get $ch) (i32.const 110))
      (then (call $__jp_adv (i32.const 4)) (return (f64.const 0))))
    (f64.const 0))`

  // Entry point — converts SSO to heap first so __jp_peek works uniformly
  ctx.stdlib['__jp'] = `(func $__jp (param $str f64) (result f64)
    (local $len i32) (local $buf i32) (local $i i32)
    (local.set $len (call $__str_byteLen (local.get $str)))
    ;; SSO: unpack to heap buffer
    (if (i32.eq (call $__ptr_type (local.get $str)) (i32.const ${PTR.SSO}))
      (then
        (local.set $buf (call $__alloc (local.get $len)))
        (local.set $i (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
          (i32.store8 (i32.add (local.get $buf) (local.get $i))
            (call $__sso_char (local.get $str) (local.get $i)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
        (global.set $__jpstr (local.get $buf)))
      (else
        (global.set $__jpstr (call $__ptr_offset (local.get $str)))))
    (global.set $__jplen (local.get $len))
    (global.set $__jppos (i32.const 0))
    (call $__jp_val))`

  // === Emitters ===

  ctx.emit['JSON.stringify'] = (x) => {
    inc('__stringify')
    return typed(['call', '$__stringify', asF64(emit(x))], 'f64')
  }

  ctx.emit['JSON.parse'] = (x) => {
    inc('__jp')
    return typed(['call', '$__jp', asF64(emit(x))], 'f64')
  }
}
