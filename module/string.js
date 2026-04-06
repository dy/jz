/**
 * String module — literals, char access, and string methods.
 *
 * Type=4 (STRING): heap-allocated, length in header [-4:len].
 * Type=5 (STRING_SSO): ≤4 ASCII chars packed in pointer offset (no memory).
 *
 * Methods use type-qualified keys (.string:slice) for array-colliding names,
 * generic keys (.toUpperCase) for non-colliding ones.
 *
 * @module string
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const STRING = 4, STRING_SSO = 5

export default () => {
  const inc = (...names) => names.forEach(n => ctx.includes.add(n))
  const incConcat = () => inc('__str_concat', '__to_str', '__ftoa', '__itoa', '__pow10', '__mkstr', '__static_str')

  // === String literal: "abc" → SSO if ≤4 ASCII, else heap ===

  ctx.emit['str'] = (str) => {
    const MAX_SSO = 4
    if (str.length <= MAX_SSO && /^[\x00-\x7f]*$/.test(str)) {
      let packed = 0
      for (let i = 0; i < str.length; i++) packed |= str.charCodeAt(i) << (i * 8)
      return typed(['call', '$__mkptr', ['i32.const', STRING_SSO], ['i32.const', str.length], ['i32.const', packed]], 'f64')
    }
    const len = str.length
    const t = `__str${ctx.uniq++}`
    ctx.locals.set(t, 'i32')
    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', len + 4]]],
      ['i32.store', ['local.get', `$${t}`], ['i32.const', len]],
      ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]]],
    ]
    for (let i = 0; i < len; i++)
      body.push(['i32.store8', ['i32.add', ['local.get', `$${t}`], ['i32.const', i]], ['i32.const', str.charCodeAt(i)]])
    body.push(['call', '$__mkptr', ['i32.const', STRING], ['i32.const', 0], ['local.get', `$${t}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === WAT: char extraction ===

  ctx.stdlib['__sso_char'] = `(func $__sso_char (param $ptr f64) (param $i i32) (result i32)
    (i32.and (i32.shr_u (call $__ptr_offset (local.get $ptr)) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0xFF)))`

  ctx.stdlib['__str_char'] = `(func $__str_char (param $ptr f64) (param $i i32) (result i32)
    (i32.load8_u (i32.add (call $__ptr_offset (local.get $ptr)) (local.get $i))))`

  ctx.stdlib['__char_at'] = `(func $__char_at (param $ptr f64) (param $i i32) (result i32)
    (if (result i32) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${STRING_SSO}))
      (then (call $__sso_char (local.get $ptr) (local.get $i)))
      (else (call $__str_char (local.get $ptr) (local.get $i)))))`

  // === WAT: unified byte length (SSO → aux, heap → header) ===

  ctx.stdlib['__str_byteLen'] = `(func $__str_byteLen (param $ptr f64) (result i32)
    (if (result i32) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${STRING_SSO}))
      (then (call $__ptr_aux (local.get $ptr)))
      (else (call $__str_len (local.get $ptr)))))`

  // === WAT: string methods ===

  ctx.stdlib['__str_slice'] = `(func $__str_slice (param $ptr f64) (param $start i32) (param $end i32) (result f64)
    (local $len i32) (local $nlen i32) (local $off i32) (local $i i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.lt_s (local.get $start) (i32.const 0))
      (then (local.set $start (i32.add (local.get $len) (local.get $start)))))
    (if (i32.lt_s (local.get $end) (i32.const 0))
      (then (local.set $end (i32.add (local.get $len) (local.get $end)))))
    (if (i32.lt_s (local.get $start) (i32.const 0))
      (then (local.set $start (i32.const 0))))
    (if (i32.gt_s (local.get $start) (local.get $len))
      (then (local.set $start (local.get $len))))
    (if (i32.lt_s (local.get $end) (i32.const 0))
      (then (local.set $end (i32.const 0))))
    (if (i32.gt_s (local.get $end) (local.get $len))
      (then (local.set $end (local.get $len))))
    (if (i32.ge_s (local.get $start) (local.get $end))
      (then (return (call $__mkptr (i32.const ${STRING_SSO}) (i32.const 0) (i32.const 0)))))
    (local.set $nlen (i32.sub (local.get $end) (local.get $start)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $nlen))))
    (i32.store (local.get $off) (local.get $nlen))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $nlen)))
      (i32.store8 (i32.add (local.get $off) (local.get $i))
        (call $__char_at (local.get $ptr) (i32.add (local.get $start) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (call $__mkptr (i32.const ${STRING}) (i32.const 0) (local.get $off)))`

  ctx.stdlib['__str_substring'] = `(func $__str_substring (param $ptr f64) (param $start i32) (param $end i32) (result f64)
    (local $len i32) (local $tmp i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.lt_s (local.get $start) (i32.const 0))
      (then (local.set $start (i32.const 0))))
    (if (i32.lt_s (local.get $end) (i32.const 0))
      (then (local.set $end (i32.const 0))))
    (if (i32.gt_s (local.get $start) (local.get $len))
      (then (local.set $start (local.get $len))))
    (if (i32.gt_s (local.get $end) (local.get $len))
      (then (local.set $end (local.get $len))))
    (if (i32.gt_s (local.get $start) (local.get $end))
      (then
        (local.set $tmp (local.get $start))
        (local.set $start (local.get $end))
        (local.set $end (local.get $tmp))))
    (call $__str_slice (local.get $ptr) (local.get $start) (local.get $end)))`

  ctx.stdlib['__str_indexof'] = `(func $__str_indexof (param $hay f64) (param $ndl f64) (result i32)
    (local $hlen i32) (local $nlen i32) (local $i i32) (local $j i32) (local $match i32)
    (local.set $hlen (call $__str_byteLen (local.get $hay)))
    (local.set $nlen (call $__str_byteLen (local.get $ndl)))
    (if (i32.eqz (local.get $nlen)) (then (return (i32.const 0))))
    (if (i32.gt_s (local.get $nlen) (local.get $hlen)) (then (return (i32.const -1))))
    (local.set $i (i32.const 0))
    (block $done (loop $outer
      (br_if $done (i32.gt_s (local.get $i) (i32.sub (local.get $hlen) (local.get $nlen))))
      (local.set $match (i32.const 1))
      (local.set $j (i32.const 0))
      (block $nomatch (loop $inner
        (br_if $nomatch (i32.ge_s (local.get $j) (local.get $nlen)))
        (if (i32.ne
              (call $__char_at (local.get $hay) (i32.add (local.get $i) (local.get $j)))
              (call $__char_at (local.get $ndl) (local.get $j)))
          (then (local.set $match (i32.const 0)) (br $nomatch)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $inner)))
      (if (local.get $match) (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $outer)))
    (i32.const -1))`

  ctx.stdlib['__str_startswith'] = `(func $__str_startswith (param $str f64) (param $pfx f64) (result i32)
    (local $plen i32) (local $i i32)
    (local.set $plen (call $__str_byteLen (local.get $pfx)))
    (if (i32.gt_s (local.get $plen) (call $__str_byteLen (local.get $str)))
      (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $plen)))
      (if (i32.ne (call $__char_at (local.get $str) (local.get $i))
                  (call $__char_at (local.get $pfx) (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))`

  ctx.stdlib['__str_endswith'] = `(func $__str_endswith (param $str f64) (param $sfx f64) (result i32)
    (local $slen i32) (local $flen i32) (local $off i32) (local $i i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (local.set $flen (call $__str_byteLen (local.get $sfx)))
    (if (i32.gt_s (local.get $flen) (local.get $slen))
      (then (return (i32.const 0))))
    (local.set $off (i32.sub (local.get $slen) (local.get $flen)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $flen)))
      (if (i32.ne (call $__char_at (local.get $str) (i32.add (local.get $off) (local.get $i)))
                  (call $__char_at (local.get $sfx) (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))`

  ctx.stdlib['__str_upper'] = `(func $__str_upper (param $ptr f64) (result f64)
    (local $len i32) (local $off i32) (local $i i32) (local $c i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${STRING_SSO}) (i32.const 0) (i32.const 0)))))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $off) (local.get $len))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $c (call $__char_at (local.get $ptr) (local.get $i)))
      (if (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 122)))
        (then (local.set $c (i32.sub (local.get $c) (i32.const 32)))))
      (i32.store8 (i32.add (local.get $off) (local.get $i)) (local.get $c))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (call $__mkptr (i32.const ${STRING}) (i32.const 0) (local.get $off)))`

  ctx.stdlib['__str_lower'] = `(func $__str_lower (param $ptr f64) (result f64)
    (local $len i32) (local $off i32) (local $i i32) (local $c i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${STRING_SSO}) (i32.const 0) (i32.const 0)))))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $off) (local.get $len))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $c (call $__char_at (local.get $ptr) (local.get $i)))
      (if (i32.and (i32.ge_u (local.get $c) (i32.const 65)) (i32.le_u (local.get $c) (i32.const 90)))
        (then (local.set $c (i32.add (local.get $c) (i32.const 32)))))
      (i32.store8 (i32.add (local.get $off) (local.get $i)) (local.get $c))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (call $__mkptr (i32.const ${STRING}) (i32.const 0) (local.get $off)))`

  ctx.stdlib['__str_trim'] = `(func $__str_trim (param $ptr f64) (result f64)
    (local $len i32) (local $start i32) (local $end i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $start (i32.const 0))
    (local.set $end (local.get $len))
    (block $d1 (loop $l1
      (br_if $d1 (i32.ge_s (local.get $start) (local.get $end)))
      (br_if $d1 (i32.gt_u (call $__char_at (local.get $ptr) (local.get $start)) (i32.const 32)))
      (local.set $start (i32.add (local.get $start) (i32.const 1)))
      (br $l1)))
    (block $d2 (loop $l2
      (br_if $d2 (i32.le_s (local.get $end) (local.get $start)))
      (br_if $d2 (i32.gt_u (call $__char_at (local.get $ptr) (i32.sub (local.get $end) (i32.const 1))) (i32.const 32)))
      (local.set $end (i32.sub (local.get $end) (i32.const 1)))
      (br $l2)))
    (call $__str_slice (local.get $ptr) (local.get $start) (local.get $end)))`

  ctx.stdlib['__str_trimStart'] = `(func $__str_trimStart (param $ptr f64) (result f64)
    (local $len i32) (local $start i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $start (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $start) (local.get $len)))
      (br_if $done (i32.gt_u (call $__char_at (local.get $ptr) (local.get $start)) (i32.const 32)))
      (local.set $start (i32.add (local.get $start) (i32.const 1)))
      (br $loop)))
    (call $__str_slice (local.get $ptr) (local.get $start) (local.get $len)))`

  ctx.stdlib['__str_trimEnd'] = `(func $__str_trimEnd (param $ptr f64) (result f64)
    (local $len i32) (local $end i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $end (local.get $len))
    (block $done (loop $loop
      (br_if $done (i32.le_s (local.get $end) (i32.const 0)))
      (br_if $done (i32.gt_u (call $__char_at (local.get $ptr) (i32.sub (local.get $end) (i32.const 1))) (i32.const 32)))
      (local.set $end (i32.sub (local.get $end) (i32.const 1)))
      (br $loop)))
    (call $__str_slice (local.get $ptr) (i32.const 0) (local.get $end)))`

  ctx.stdlib['__str_repeat'] = `(func $__str_repeat (param $ptr f64) (param $n i32) (result f64)
    (local $len i32) (local $total i32) (local $off i32) (local $i i32) (local $j i32) (local $pos i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.or (i32.eqz (local.get $n)) (i32.eqz (local.get $len)))
      (then (return (call $__mkptr (i32.const ${STRING_SSO}) (i32.const 0) (i32.const 0)))))
    (local.set $total (i32.mul (local.get $len) (local.get $n)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $total))))
    (i32.store (local.get $off) (local.get $total))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $pos (i32.const 0))
    (local.set $i (i32.const 0))
    (block $d1 (loop $l1
      (br_if $d1 (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $j (i32.const 0))
      (block $d2 (loop $l2
        (br_if $d2 (i32.ge_s (local.get $j) (local.get $len)))
        (i32.store8 (i32.add (local.get $off) (local.get $pos))
          (call $__char_at (local.get $ptr) (local.get $j)))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $l2)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l1)))
    (call $__mkptr (i32.const ${STRING}) (i32.const 0) (local.get $off)))`

  // Coerce value to string: numbers → __ftoa, plain NaN → "NaN", pointers pass through
  ctx.stdlib['__to_str'] = `(func $__to_str (param $val f64) (result f64)
    ;; Not NaN → number, convert
    (if (f64.eq (local.get $val) (local.get $val))
      (then (return (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0)))))
    ;; Plain NaN (type=0) → "NaN" string; pointers (type>0) pass through
    (if (i32.eqz (call $__ptr_type (local.get $val)))
      (then (return (call $__static_str (i32.const 0)))))
    (local.get $val))`

  ctx.stdlib['__str_concat'] = `(func $__str_concat (param $a f64) (param $b f64) (result f64)
    (local $alen i32) (local $blen i32) (local $total i32) (local $off i32) (local $i i32)
    ;; Coerce operands to strings if needed
    (local.set $a (call $__to_str (local.get $a)))
    (local.set $b (call $__to_str (local.get $b)))
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $blen (call $__str_byteLen (local.get $b)))
    (local.set $total (i32.add (local.get $alen) (local.get $blen)))
    (if (i32.eqz (local.get $total))
      (then (return (call $__mkptr (i32.const ${STRING_SSO}) (i32.const 0) (i32.const 0)))))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $total))))
    (i32.store (local.get $off) (local.get $total))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $d1 (loop $l1
      (br_if $d1 (i32.ge_s (local.get $i) (local.get $alen)))
      (i32.store8 (i32.add (local.get $off) (local.get $i))
        (call $__char_at (local.get $a) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l1)))
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_s (local.get $i) (local.get $blen)))
      (i32.store8 (i32.add (local.get $off) (i32.add (local.get $alen) (local.get $i)))
        (call $__char_at (local.get $b) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $__mkptr (i32.const ${STRING}) (i32.const 0) (local.get $off)))`

  ctx.stdlib['__str_replace'] = `(func $__str_replace (param $str f64) (param $search f64) (param $repl f64) (result f64)
    (local $idx i32) (local $slen i32)
    (local.set $idx (call $__str_indexof (local.get $str) (local.get $search)))
    (if (result f64) (i32.lt_s (local.get $idx) (i32.const 0))
      (then (local.get $str))
      (else
        (local.set $slen (call $__str_byteLen (local.get $search)))
        (call $__str_concat
          (call $__str_concat
            (call $__str_slice (local.get $str) (i32.const 0) (local.get $idx))
            (local.get $repl))
          (call $__str_slice (local.get $str) (i32.add (local.get $idx) (local.get $slen))
            (call $__str_byteLen (local.get $str)))))))`

  ctx.stdlib['__str_split'] = `(func $__str_split (param $str f64) (param $sep f64) (result f64)
    (local $slen i32) (local $plen i32) (local $count i32)
    (local $i i32) (local $j i32) (local $match i32)
    (local $arr i32) (local $piece_start i32) (local $piece_idx i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (local.set $plen (call $__str_byteLen (local.get $sep)))
    (local.set $count (i32.const 1))
    (local.set $i (i32.const 0))
    (block $d1 (loop $l1
      (br_if $d1 (i32.gt_s (local.get $i) (i32.sub (local.get $slen) (local.get $plen))))
      (local.set $match (i32.const 1))
      (local.set $j (i32.const 0))
      (block $n1 (loop $c1
        (br_if $n1 (i32.ge_s (local.get $j) (local.get $plen)))
        (if (i32.ne (call $__char_at (local.get $str) (i32.add (local.get $i) (local.get $j)))
                    (call $__char_at (local.get $sep) (local.get $j)))
          (then (local.set $match (i32.const 0)) (br $n1)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $c1)))
      (if (local.get $match) (then
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (local.get $plen)))
        (br $l1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l1)))
    (local.set $arr (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $count) (i32.const 3)))))
    (i32.store (local.get $arr) (local.get $count))
    (i32.store (i32.add (local.get $arr) (i32.const 4)) (local.get $count))
    (local.set $arr (i32.add (local.get $arr) (i32.const 8)))
    (local.set $piece_start (i32.const 0))
    (local.set $piece_idx (i32.const 0))
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.gt_s (local.get $i) (i32.sub (local.get $slen) (local.get $plen))))
      (local.set $match (i32.const 1))
      (local.set $j (i32.const 0))
      (block $n2 (loop $c2
        (br_if $n2 (i32.ge_s (local.get $j) (local.get $plen)))
        (if (i32.ne (call $__char_at (local.get $str) (i32.add (local.get $i) (local.get $j)))
                    (call $__char_at (local.get $sep) (local.get $j)))
          (then (local.set $match (i32.const 0)) (br $n2)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $c2)))
      (if (local.get $match) (then
        (f64.store (i32.add (local.get $arr) (i32.shl (local.get $piece_idx) (i32.const 3)))
          (call $__str_slice (local.get $str) (local.get $piece_start) (local.get $i)))
        (local.set $piece_idx (i32.add (local.get $piece_idx) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (local.get $plen)))
        (local.set $piece_start (local.get $i))
        (br $l2)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (f64.store (i32.add (local.get $arr) (i32.shl (local.get $piece_idx) (i32.const 3)))
      (call $__str_slice (local.get $str) (local.get $piece_start) (local.get $slen)))
    (call $__mkptr (i32.const 1) (i32.const 0) (local.get $arr)))`

  ctx.stdlib['__str_join'] = `(func $__str_join (param $arr f64) (param $sep f64) (result f64)
    (local $off i32) (local $len i32) (local $i i32) (local $result f64)
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${STRING_SSO}) (i32.const 0) (i32.const 0)))))
    (local.set $result (f64.load (local.get $off)))
    (local.set $i (i32.const 1))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $result (call $__str_concat (local.get $result) (local.get $sep)))
      (local.set $result (call $__str_concat (local.get $result)
        (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $result))`

  ctx.stdlib['__str_padStart'] = `(func $__str_padStart (param $str f64) (param $target i32) (param $pad f64) (result f64)
    (local $slen i32) (local $plen i32) (local $fill i32) (local $off i32) (local $i i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (if (i32.ge_s (local.get $slen) (local.get $target))
      (then (return (local.get $str))))
    (local.set $plen (call $__str_byteLen (local.get $pad)))
    (local.set $fill (i32.sub (local.get $target) (local.get $slen)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $target))))
    (i32.store (local.get $off) (local.get $target))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $d1 (loop $l1
      (br_if $d1 (i32.ge_s (local.get $i) (local.get $fill)))
      (i32.store8 (i32.add (local.get $off) (local.get $i))
        (call $__char_at (local.get $pad) (i32.rem_u (local.get $i) (local.get $plen))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l1)))
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_s (local.get $i) (local.get $slen)))
      (i32.store8 (i32.add (local.get $off) (i32.add (local.get $fill) (local.get $i)))
        (call $__char_at (local.get $str) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $__mkptr (i32.const ${STRING}) (i32.const 0) (local.get $off)))`

  ctx.stdlib['__str_padEnd'] = `(func $__str_padEnd (param $str f64) (param $target i32) (param $pad f64) (result f64)
    (local $slen i32) (local $plen i32) (local $fill i32) (local $off i32) (local $i i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (if (i32.ge_s (local.get $slen) (local.get $target))
      (then (return (local.get $str))))
    (local.set $plen (call $__str_byteLen (local.get $pad)))
    (local.set $fill (i32.sub (local.get $target) (local.get $slen)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $target))))
    (i32.store (local.get $off) (local.get $target))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $d1 (loop $l1
      (br_if $d1 (i32.ge_s (local.get $i) (local.get $slen)))
      (i32.store8 (i32.add (local.get $off) (local.get $i))
        (call $__char_at (local.get $str) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l1)))
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_s (local.get $i) (local.get $fill)))
      (i32.store8 (i32.add (local.get $off) (i32.add (local.get $slen) (local.get $i)))
        (call $__char_at (local.get $pad) (i32.rem_u (local.get $i) (local.get $plen))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $__mkptr (i32.const ${STRING}) (i32.const 0) (local.get $off)))`

  // Always include base helpers
  for (const name of ['__sso_char', '__str_char', '__char_at', '__str_byteLen'])
    ctx.includes.add(name)

  // === Method emitters ===

  // Type-qualified (collide with array: slice, indexOf, includes)
  ctx.emit['.string:slice'] = (str, start, end) => {
    inc('__str_slice')
    if (end != null) return typed(['call', '$__str_slice', asF64(emit(str)), asI32(emit(start)), asI32(emit(end))], 'f64')
    const t = `__t${ctx.uniq++}`; ctx.locals.set(t, 'f64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(str))],
      ['call', '$__str_slice', ['local.get', `$${t}`], asI32(emit(start)),
        ['call', '$__str_byteLen', ['local.get', `$${t}`]]]], 'f64')
  }

  ctx.emit['.string:indexOf'] = (str, search) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s', ['call', '$__str_indexof', asF64(emit(str)), asF64(emit(search))]], 'f64')
  }

  ctx.emit['.string:includes'] = (str, search) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s',
      ['i32.ge_s', ['call', '$__str_indexof', asF64(emit(str)), asF64(emit(search))], ['i32.const', 0]]], 'f64')
  }

  // Generic (no collision)
  ctx.emit['.substring'] = (str, start, end) => {
    inc('__str_substring', '__str_slice')
    if (end != null) return typed(['call', '$__str_substring', asF64(emit(str)), asI32(emit(start)), asI32(emit(end))], 'f64')
    const t = `__t${ctx.uniq++}`; ctx.locals.set(t, 'f64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(str))],
      ['call', '$__str_substring', ['local.get', `$${t}`], asI32(emit(start)),
        ['call', '$__str_byteLen', ['local.get', `$${t}`]]]], 'f64')
  }

  ctx.emit['.startsWith'] = (str, pfx) => {
    inc('__str_startswith')
    return typed(['f64.convert_i32_s', ['call', '$__str_startswith', asF64(emit(str)), asF64(emit(pfx))]], 'f64')
  }

  ctx.emit['.endsWith'] = (str, sfx) => {
    inc('__str_endswith')
    return typed(['f64.convert_i32_s', ['call', '$__str_endswith', asF64(emit(str)), asF64(emit(sfx))]], 'f64')
  }

  ctx.emit['.toUpperCase'] = (str) => {
    inc('__str_upper')
    return typed(['call', '$__str_upper', asF64(emit(str))], 'f64')
  }

  ctx.emit['.toLowerCase'] = (str) => {
    inc('__str_lower')
    return typed(['call', '$__str_lower', asF64(emit(str))], 'f64')
  }

  ctx.emit['.trim'] = (str) => {
    inc('__str_trim', '__str_slice')
    return typed(['call', '$__str_trim', asF64(emit(str))], 'f64')
  }

  ctx.emit['.trimStart'] = (str) => {
    inc('__str_trimStart', '__str_slice')
    return typed(['call', '$__str_trimStart', asF64(emit(str))], 'f64')
  }

  ctx.emit['.trimEnd'] = (str) => {
    inc('__str_trimEnd', '__str_slice')
    return typed(['call', '$__str_trimEnd', asF64(emit(str))], 'f64')
  }

  ctx.emit['.repeat'] = (str, n) => {
    inc('__str_repeat')
    return typed(['call', '$__str_repeat', asF64(emit(str)), asI32(emit(n))], 'f64')
  }

  ctx.emit['.string:concat'] = (str, ...others) => {
    incConcat()
    // Chain concat for multiple args: s.concat(a, b, c) → concat(concat(concat(s, a), b), c)
    let result = asF64(emit(str))
    for (const other of others) {
      result = typed(['call', '$__str_concat', result, asF64(emit(other))], 'f64')
    }
    return result
  }

  ctx.emit['.replace'] = (str, search, repl) => {
    inc('__str_replace', '__str_indexof', '__str_slice')
    incConcat()
    return typed(['call', '$__str_replace', asF64(emit(str)), asF64(emit(search)), asF64(emit(repl))], 'f64')
  }

  ctx.emit['.split'] = (str, sep) => {
    inc('__str_split', '__str_slice')
    return typed(['call', '$__str_split', asF64(emit(str)), asF64(emit(sep))], 'f64')
  }

  ctx.emit['.padStart'] = (str, len, pad) => {
    inc('__str_padStart')
    const vpad = pad != null ? asF64(emit(pad))
      : typed(['call', '$__mkptr', ['i32.const', STRING_SSO], ['i32.const', 1], ['i32.const', 32]], 'f64')
    return typed(['call', '$__str_padStart', asF64(emit(str)), asI32(emit(len)), vpad], 'f64')
  }

  ctx.emit['.padEnd'] = (str, len, pad) => {
    inc('__str_padEnd')
    const vpad = pad != null ? asF64(emit(pad))
      : typed(['call', '$__mkptr', ['i32.const', STRING_SSO], ['i32.const', 1], ['i32.const', 32]], 'f64')
    return typed(['call', '$__str_padEnd', asF64(emit(str)), asI32(emit(len)), vpad], 'f64')
  }

  // .charAt(i) → 1-char string from char code at index i
  ctx.emit['.charAt'] = (str, idx) => {
    const t = `__ch${ctx.uniq++}`
    ctx.locals.set(t, 'i32')
    // Get char code, create SSO string with 1 byte
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__char_at', asF64(emit(str)), asI32(emit(idx))]],
      ['call', '$__mkptr', ['i32.const', STRING_SSO], ['i32.const', 1], ['local.get', `$${t}`]]], 'f64')
  }

  // .charCodeAt(i) → integer char code
  ctx.emit['.charCodeAt'] = (str, idx) => {
    return typed(['f64.convert_i32_u', ['call', '$__char_at', asF64(emit(str)), asI32(emit(idx))]], 'f64')
  }

  // .at(i) → charAt with negative index support
  ctx.emit['.at'] = (str, idx) => {
    const t = `__at${ctx.uniq++}`, s = `__as${ctx.uniq++}`
    ctx.locals.set(t, 'i32'); ctx.locals.set(s, 'f64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${t}`, asI32(emit(idx))],
      // Negative index: t += length
      ['if', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]],
        ['then', ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`],
          ['call', '$__str_byteLen', ['local.get', `$${s}`]]]]]],
      ['call', '$__mkptr', ['i32.const', STRING_SSO], ['i32.const', 1],
        ['call', '$__char_at', ['local.get', `$${s}`], ['local.get', `$${t}`]]]], 'f64')
  }

  // .search(str) → indexOf (same as indexOf for string args)
  ctx.emit['.search'] = (str, search) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s', ['call', '$__str_indexof', asF64(emit(str)), asF64(emit(search))]], 'f64')
  }

  // .match(str) → [match] array if found, or 0 (null) if not
  // For string args, returns single-element array with the matched substring
  ctx.emit['.match'] = (str, search) => {
    inc('__str_indexof', '__str_slice', '__wrap1')
    const s = `__ms${ctx.uniq++}`, q = `__mq${ctx.uniq++}`, idx = `__mi${ctx.uniq++}`
    ctx.locals.set(s, 'f64'); ctx.locals.set(q, 'f64'); ctx.locals.set(idx, 'i32')
    // indexOf, then if >= 0, create 1-element array with the match slice
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${q}`, asF64(emit(search))],
      ['local.set', `$${idx}`, ['call', '$__str_indexof', ['local.get', `$${s}`], ['local.get', `$${q}`]]],
      ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
        ['then', ['f64.const', 0]],  // null
        ['else',
          // Build 1-element array containing the search string
          ['call', '$__wrap1',
            ['call', '$__str_slice', ['local.get', `$${s}`],
              ['local.get', `$${idx}`],
              ['i32.add', ['local.get', `$${idx}`], ['call', '$__str_byteLen', ['local.get', `$${q}`]]]]]]]], 'f64')
  }

  // __wrap1(val: f64) → f64 — create 1-element array [val]
  ctx.stdlib['__wrap1'] = `(func $__wrap1 (param $val f64) (result f64)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.const 16)))
    (i32.store (local.get $ptr) (i32.const 1))
    (i32.store (i32.add (local.get $ptr) (i32.const 4)) (i32.const 1))
    (f64.store (i32.add (local.get $ptr) (i32.const 8)) (local.get $val))
    (call $__mkptr (i32.const 1) (i32.const 0) (i32.add (local.get $ptr) (i32.const 8))))`
}
