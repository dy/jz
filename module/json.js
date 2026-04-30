/**
 * JSON module — JSON.stringify and JSON.parse.
 *
 * stringify: recursive type-dispatch → string assembly in scratch buffer.
 * parse: recursive descent parser using globals for input position.
 * Objects parsed as Map (dynamic keys). Arrays as standard jz arrays.
 *
 * @module json
 */

import { emit, typed, asF64, T } from '../src/compile.js'
import { err, inc, PTR } from '../src/ctx.js'

export default (ctx) => {
  Object.assign(ctx.core.stdlibDeps, {
    __stringify: ['__json_val', '__jput', '__jput_str', '__jput_num', '__mkstr'],
    __json_val: ['__ptr_type', '__len', '__ptr_offset', '__jput', '__jput_num', '__jput_str', '__json_hash', '__json_obj'],
    __json_hash: ['__ptr_offset', '__jput', '__jput_str', '__json_val'],
    __json_obj: ['__ptr_offset', '__ptr_aux', '__len', '__jput', '__jput_str', '__json_val'],
    __jput_num: ['__ftoa'],
    __jput_str: ['__char_at', '__str_byteLen'],
    __jp: ['__jp_val', '__jp_str', '__jp_num', '__jp_arr', '__jp_obj', '__jp_peek', '__jp_adv', '__jp_ws'],
    __jp_str: ['__sso_char', '__char_at', '__str_byteLen'],
    __jp_num: ['__pow10'],
    __jp_arr: ['__jp_val'],
    __jp_obj: ['__jp_val', '__hash_new', '__hash_set'],
  })


  // === JSON.stringify ===

  // Scratch buffer approach: __json_buf is a growable output buffer.
  // Functions append bytes to it, __json_pos tracks current write position.

  ctx.scope.globals.set('__jbuf', '(global $__jbuf (mut i32) (i32.const 0))')
  ctx.scope.globals.set('__jpos', '(global $__jpos (mut i32) (i32.const 0))')
  ctx.scope.globals.set('__jcap', '(global $__jcap (mut i32) (i32.const 0))')
  ctx.scope.globals.set('__schema_tbl', '(global $__schema_tbl (mut i32) (i32.const 0))')

  // __jput(byte: i32) — append one byte to output buffer
  ctx.core.stdlib['__jput'] = `(func $__jput (param $b i32)
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
  ctx.core.stdlib['__jput_str'] = `(func $__jput_str (param $ptr f64)
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
  ctx.core.stdlib['__jput_num'] = `(func $__jput_num (param $val f64)
    (call $__jput_str (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0))))`

  // __json_val(val: f64) — stringify any value, append to buffer
  ctx.core.stdlib['__json_val'] = `(func $__json_val (param $val f64)
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
    ;; HASH/MAP — iterate entries: {"key":val,...}
    (if (i32.or (i32.eq (local.get $type) (i32.const ${PTR.HASH}))
                (i32.eq (local.get $type) (i32.const ${PTR.MAP})))
      (then (call $__json_hash (local.get $val)) (return)))
    ;; OBJECT — schema-based: iterate props with schema name table
    (if (i32.eq (local.get $type) (i32.const ${PTR.OBJECT}))
      (then (call $__json_obj (local.get $val)) (return)))
    ;; Unknown type → null
    (call $__jput (i32.const 110)) (call $__jput (i32.const 117))
    (call $__jput (i32.const 108)) (call $__jput (i32.const 108)))`

  // __json_hash(val: f64) — stringify HASH/MAP: iterate slots, emit {"key":val,...}
  // Slot layout: 24 bytes each — [hash:f64][key:f64][val:f64]. Empty slots have hash==0.
  ctx.core.stdlib['__json_hash'] = `(func $__json_hash (param $val f64)
    (local $off i32) (local $cap i32) (local $i i32) (local $slot i32) (local $first i32)
    (local.set $off (call $__ptr_offset (local.get $val)))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (local.set $first (i32.const 1))
    (call $__jput (i32.const 123))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $cap)))
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $i) (i32.const 24))))
      (if (f64.ne (f64.load (local.get $slot)) (f64.const 0))
        (then
          (if (i32.eqz (local.get $first))
            (then (call $__jput (i32.const 44))))
          (local.set $first (i32.const 0))
          (call $__jput (i32.const 34))
          (call $__jput_str (f64.load (i32.add (local.get $slot) (i32.const 8))))
          (call $__jput (i32.const 34))
          (call $__jput (i32.const 58))
          (call $__json_val (f64.load (i32.add (local.get $slot) (i32.const 16))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $__jput (i32.const 125)))`

  // __json_obj(val: f64) — stringify OBJECT using runtime schema name table.
  // Schema name table: global $__schema_tbl → array of f64 pointers.
  //   schema_tbl[schemaId * 8] = f64 pointer to jz Array of key name strings.
  // Object props are sequential f64 at ptr_offset, indexed same as schema.
  ctx.core.stdlib['__json_obj'] = `(func $__json_obj (param $val f64)
    (local $off i32) (local $sid i32) (local $keys i32) (local $nkeys i32)
    (local $i i32) (local $koff i32)
    (local.set $off (call $__ptr_offset (local.get $val)))
    (local.set $sid (call $__ptr_aux (local.get $val)))
    ;; Load keys array from schema table: schema_tbl + sid * 8
    (local.set $keys (call $__ptr_offset
      (f64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3))))))
    (local.set $nkeys (call $__len
      (f64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $sid) (i32.const 3))))))
    (local.set $koff (local.get $keys))
    (call $__jput (i32.const 123))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $nkeys)))
      (if (local.get $i) (then (call $__jput (i32.const 44))))
      (call $__jput (i32.const 34))
      (call $__jput_str (f64.load (i32.add (local.get $koff) (i32.shl (local.get $i) (i32.const 3)))))
      (call $__jput (i32.const 34))
      (call $__jput (i32.const 58))
      (call $__json_val (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $__jput (i32.const 125)))`

  // __stringify(val: f64) → f64 (NaN-boxed string)
  ctx.core.stdlib['__stringify'] = `(func $__stringify (param $val f64) (result f64)
    ;; Reset output buffer
    (global.set $__jbuf (call $__alloc (i32.const 256)))
    (global.set $__jpos (i32.const 0))
    (global.set $__jcap (i32.const 256))
    (call $__json_val (local.get $val))
    ;; Create string from buffer
    (call $__mkstr (global.get $__jbuf) (global.get $__jpos)))`

  // === JSON.parse ===

  ctx.scope.globals.set('__jpstr', '(global $__jpstr (mut i32) (i32.const 0))')  // input string offset
  ctx.scope.globals.set('__jplen', '(global $__jplen (mut i32) (i32.const 0))')  // input length
  ctx.scope.globals.set('__jppos', '(global $__jppos (mut i32) (i32.const 0))')  // current parse position

  // Sentinel-driven peek: __jp copies input to a scratch buffer with 0xFF bytes
  // appended past the end. i32.load8_s sign-extends, so the sentinel reads as -1
  // — exactly the EOF value all callers already test for. Bounds check and
  // function-call overhead both gone; ~50 calls/parse char in well-formed JSON.
  ctx.core.stdlib['__jp_peek'] = `(func $__jp_peek (result i32)
    (i32.load8_s (i32.add (global.get $__jpstr) (global.get $__jppos))))`

  ctx.core.stdlib['__jp_adv'] = `(func $__jp_adv (param $n i32)
    (global.set $__jppos (i32.add (global.get $__jppos) (local.get $n))))`

  ctx.core.stdlib['__jp_ws'] = `(func $__jp_ws
    (local $ch i32)
    (block $d (loop $l
      (local.set $ch (call $__jp_peek))
      (br_if $d (i32.and (i32.ne (local.get $ch) (i32.const 32))
        (i32.and (i32.ne (local.get $ch) (i32.const 9))
          (i32.and (i32.ne (local.get $ch) (i32.const 10))
            (i32.ne (local.get $ch) (i32.const 13))))))
      (call $__jp_adv (i32.const 1))
      (br $l))))`

  // Parse string (after opening " consumed). Two-phase: scan to closing quote
  // tracking whether all chars are simple ASCII (no escapes, no high-bit), then
  // either pack into SSO (≤4 simple chars) or heap-alloc + escape-decode.
  ctx.core.stdlib['__jp_str'] = `(func $__jp_str (result f64)
    (local $start i32) (local $ch i32) (local $len i32) (local $off i32) (local $i i32) (local $simple i32) (local $sso i32)
    (local.set $start (global.get $__jppos))
    (local.set $simple (i32.const 1))
    (block $d (loop $l
      (local.set $ch (call $__jp_peek))
      (br_if $d (i32.eq (local.get $ch) (i32.const 34)))
      (br_if $d (i32.eq (local.get $ch) (i32.const -1)))
      ;; Mark non-simple: escape (\\=92) or non-ASCII (load8_s gives <0 for byte≥128).
      (if (i32.or (i32.eq (local.get $ch) (i32.const 92)) (i32.lt_s (local.get $ch) (i32.const 0)))
        (then (local.set $simple (i32.const 0))))
      (if (i32.eq (local.get $ch) (i32.const 92))
        (then (call $__jp_adv (i32.const 2)))
        (else (call $__jp_adv (i32.const 1))))
      (br $l)))
    (local.set $len (i32.sub (global.get $__jppos) (local.get $start)))
    (call $__jp_adv (i32.const 1))  ;; skip "
    ;; SSO fast path: ≤4 ASCII chars, no escapes — pack bytes into the offset slot,
    ;; skip alloc + memcopy entirely. The dominant case for object keys (id/kind/meta/bias).
    (if (i32.and (local.get $simple) (i32.le_u (local.get $len) (i32.const 4)))
      (then
        (local.set $i (i32.const 0))
        (block $sd (loop $sl
          (br_if $sd (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $sso
            (i32.or (local.get $sso)
              (i32.shl (i32.load8_u (i32.add (i32.add (global.get $__jpstr) (local.get $start)) (local.get $i)))
                       (i32.shl (local.get $i) (i32.const 3)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $sl)))
        (return (call $__mkptr (i32.const ${PTR.SSO}) (local.get $len) (local.get $sso)))))
    ;; Simple STRING fast path: no escapes, len > 4 — bulk memcpy from parse buffer,
    ;; skip rewind + per-byte escape-decode loop. Hits 5+ char keys without escapes.
    (if (local.get $simple)
      (then
        (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
        (local.set $off (i32.add (local.get $off) (i32.const 4)))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (local.get $len))
        (memory.copy (local.get $off) (i32.add (global.get $__jpstr) (local.get $start)) (local.get $len))
        (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))))
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
  ctx.core.stdlib['__jp_num'] = `(func $__jp_num (result f64)
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
  ctx.core.stdlib['__jp_arr'] = `(func $__jp_arr (result f64)
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
  ctx.core.stdlib['__jp_obj'] = `(func $__jp_obj (result f64)
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
  ctx.core.stdlib['__jp_val'] = `(func $__jp_val (result f64)
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

  // Entry point — copies input to a scratch buffer with 0xFF sentinel padding
  // past the end so __jp_peek can omit its bounds check. Pad is 8 bytes so any
  // overshoot from speculative peek/adv on malformed input still hits sentinel,
  // not unallocated memory.
  ctx.core.stdlib['__jp'] = `(func $__jp (param $str f64) (result f64)
    (local $len i32) (local $buf i32) (local $i i32)
    (local.set $len (call $__str_byteLen (local.get $str)))
    (local.set $buf (call $__alloc (i32.add (local.get $len) (i32.const 8))))
    ;; Pre-fill 8 sentinel bytes at end (writes overlapping a 64-bit slot).
    (i64.store (i32.add (local.get $buf) (local.get $len)) (i64.const -1))
    ;; SSO: byte-by-byte via __sso_char; STRING: bulk memcpy from string offset.
    (if (i32.eq (call $__ptr_type (local.get $str)) (i32.const ${PTR.SSO}))
      (then
        (local.set $i (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
          (i32.store8 (i32.add (local.get $buf) (local.get $i))
            (call $__sso_char (local.get $str) (local.get $i)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l))))
      (else
        (memory.copy (local.get $buf) (call $__ptr_offset (local.get $str)) (local.get $len))))
    (global.set $__jpstr (local.get $buf))
    (global.set $__jplen (local.get $len))
    (global.set $__jppos (i32.const 0))
    (call $__jp_val))`

  // === Emitters ===

  ctx.core.emit['JSON.stringify'] = (x) => {
    inc('__stringify')
    return typed(['call', '$__stringify', asF64(emit(x))], 'f64')
  }

  ctx.core.emit['JSON.parse'] = (x) => {
    inc('__jp')
    return typed(['call', '$__jp', asF64(emit(x))], 'f64')
  }
}
