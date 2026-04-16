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

import { emit, typed, asF64, asI32, T, UNDEF_NAN } from '../src/compile.js'
import { ctx, inc, PTR } from '../src/ctx.js'


export default () => {
  inc('__mkptr', '__alloc')

  // === String literal: "abc" → SSO if ≤4 ASCII, else heap ===

  ctx.core.emit['str'] = (str) => {
    const MAX_SSO = 4
    if (str.length <= MAX_SSO && /^[\x00-\x7f]*$/.test(str)) {
      let packed = 0
      for (let i = 0; i < str.length; i++) packed |= str.charCodeAt(i) << (i * 8)
      return typed(['call', '$__mkptr', ['i32.const', PTR.SSO], ['i32.const', str.length], ['i32.const', packed]], 'f64')
    }
    const len = str.length
    if (!ctx.memory.shared) {
      // Own memory: place in static data segment (no runtime allocation)
      if (!ctx.runtime.data) ctx.runtime.data = ''
      while (ctx.runtime.data.length % 4 !== 0) ctx.runtime.data += '\0'
      const offset = ctx.runtime.data.length
      ctx.runtime.data += String.fromCharCode(len & 0xFF, (len >> 8) & 0xFF, (len >> 16) & 0xFF, (len >> 24) & 0xFF)
      for (let i = 0; i < len; i++) ctx.runtime.data += String.fromCharCode(str.charCodeAt(i))
      return typed(['call', '$__mkptr', ['i32.const', PTR.STRING], ['i32.const', 0], ['i32.const', offset + 4]], 'f64')
    }
    // Shared memory: heap-allocate (data segment would collide across modules)
    const t = `${T}str${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32')
    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', len + 4]]],
      ['i32.store', ['local.get', `$${t}`], ['i32.const', len]],
      ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]]],
    ]
    for (let i = 0; i < len; i++)
      body.push(['i32.store8', ['i32.add', ['local.get', `$${t}`], ['i32.const', i]], ['i32.const', str.charCodeAt(i)]])
    body.push(['call', '$__mkptr', ['i32.const', PTR.STRING], ['i32.const', 0], ['local.get', `$${t}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === WAT: char extraction ===

  ctx.core.stdlib['__sso_char'] = `(func $__sso_char (param $ptr f64) (param $i i32) (result i32)
    (i32.and (i32.shr_u (call $__ptr_offset (local.get $ptr)) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0xFF)))`

  ctx.core.stdlib['__str_char'] = `(func $__str_char (param $ptr f64) (param $i i32) (result i32)
    (i32.load8_u (i32.add (call $__ptr_offset (local.get $ptr)) (local.get $i))))`

  ctx.core.stdlib['__char_at'] = `(func $__char_at (param $ptr f64) (param $i i32) (result i32)
    (if (result i32) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.SSO}))
      (then (call $__sso_char (local.get $ptr) (local.get $i)))
      (else (call $__str_char (local.get $ptr) (local.get $i)))))`

  ctx.core.stdlib['__str_idx'] = `(func $__str_idx (param $ptr f64) (param $i i32) (result f64)
    (local $len i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.reinterpret_i64 (i64.const ${UNDEF_NAN})))
      (else
        (call $__mkptr
          (i32.const ${PTR.SSO})
          (i32.const 1)
          (call $__char_at (local.get $ptr) (local.get $i))))))`

  ctx.core.stdlib['__str_eq'] = `(func $__str_eq (param $a f64) (param $b f64) (result i32)
    (local $len i32) (local $i i32)
    (if (i64.eq (i64.reinterpret_f64 (local.get $a)) (i64.reinterpret_f64 (local.get $b)))
      (then (return (i32.const 1))))
    (local.set $len (call $__str_byteLen (local.get $a)))
    (if (i32.ne (local.get $len) (call $__str_byteLen (local.get $b)))
      (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (if (i32.ne (call $__char_at (local.get $a) (local.get $i))
                  (call $__char_at (local.get $b) (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))`

  // === WAT: unified byte length (SSO → aux, heap → header) ===

  ctx.core.stdlib['__str_byteLen'] = `(func $__str_byteLen (param $ptr f64) (result i32)
    (if (result i32) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.SSO}))
      (then (call $__ptr_aux (local.get $ptr)))
      (else (call $__str_len (local.get $ptr)))))`

  // === WAT: string methods ===

  ctx.core.stdlib['__str_slice'] = `(func $__str_slice (param $ptr f64) (param $start i32) (param $end i32) (result f64)
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
      (then (return (call $__mkptr (i32.const ${PTR.SSO}) (i32.const 0) (i32.const 0)))))
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
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  ctx.core.stdlib['__str_substring'] = `(func $__str_substring (param $ptr f64) (param $start i32) (param $end i32) (result f64)
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

  ctx.core.stdlib['__str_indexof'] = `(func $__str_indexof (param $hay f64) (param $ndl f64) (param $from i32) (result i32)
    (local $hlen i32) (local $nlen i32) (local $i i32) (local $j i32) (local $match i32)
    (local.set $hlen (call $__str_byteLen (local.get $hay)))
    (local.set $nlen (call $__str_byteLen (local.get $ndl)))
    (if (i32.eqz (local.get $nlen)) (then (return (local.get $from))))
    (if (i32.gt_s (local.get $nlen) (local.get $hlen)) (then (return (i32.const -1))))
    (local.set $i (if (result i32) (i32.gt_s (local.get $from) (i32.const 0)) (then (local.get $from)) (else (i32.const 0))))
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

  ctx.core.stdlib['__str_startswith'] = `(func $__str_startswith (param $str f64) (param $pfx f64) (result i32)
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

  ctx.core.stdlib['__str_endswith'] = `(func $__str_endswith (param $str f64) (param $sfx f64) (result i32)
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

  ctx.core.stdlib['__str_case'] = `(func $__str_case (param $ptr f64) (param $lo i32) (param $hi i32) (param $delta i32) (result f64)
    (local $len i32) (local $off i32) (local $i i32) (local $c i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${PTR.SSO}) (i32.const 0) (i32.const 0)))))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $off) (local.get $len))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $c (call $__char_at (local.get $ptr) (local.get $i)))
      (if (i32.and (i32.ge_u (local.get $c) (local.get $lo)) (i32.le_u (local.get $c) (local.get $hi)))
        (then (local.set $c (i32.add (local.get $c) (local.get $delta)))))
      (i32.store8 (i32.add (local.get $off) (local.get $i)) (local.get $c))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  ctx.core.stdlib['__str_trim'] = `(func $__str_trim (param $ptr f64) (result f64)
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

  ctx.core.stdlib['__str_trimStart'] = `(func $__str_trimStart (param $ptr f64) (result f64)
    (local $len i32) (local $start i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $start (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $start) (local.get $len)))
      (br_if $done (i32.gt_u (call $__char_at (local.get $ptr) (local.get $start)) (i32.const 32)))
      (local.set $start (i32.add (local.get $start) (i32.const 1)))
      (br $loop)))
    (call $__str_slice (local.get $ptr) (local.get $start) (local.get $len)))`

  ctx.core.stdlib['__str_trimEnd'] = `(func $__str_trimEnd (param $ptr f64) (result f64)
    (local $len i32) (local $end i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $end (local.get $len))
    (block $done (loop $loop
      (br_if $done (i32.le_s (local.get $end) (i32.const 0)))
      (br_if $done (i32.gt_u (call $__char_at (local.get $ptr) (i32.sub (local.get $end) (i32.const 1))) (i32.const 32)))
      (local.set $end (i32.sub (local.get $end) (i32.const 1)))
      (br $loop)))
    (call $__str_slice (local.get $ptr) (i32.const 0) (local.get $end)))`

  ctx.core.stdlib['__str_repeat'] = `(func $__str_repeat (param $ptr f64) (param $n i32) (result f64)
    (local $len i32) (local $total i32) (local $off i32) (local $i i32) (local $j i32) (local $pos i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.or (i32.eqz (local.get $n)) (i32.eqz (local.get $len)))
      (then (return (call $__mkptr (i32.const ${PTR.SSO}) (i32.const 0) (i32.const 0)))))
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
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  // Coerce value to string: numbers → __ftoa, plain NaN → "NaN", pointers pass through
  ctx.core.stdlib['__to_str'] = `(func $__to_str (param $val f64) (result f64)
    ;; Not NaN → number, convert
    (if (f64.eq (local.get $val) (local.get $val))
      (then (return (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0)))))
    ;; Plain NaN (type=0) → "NaN" string; pointers (type>0) pass through
    (if (i32.eqz (call $__ptr_type (local.get $val)))
      (then (return (call $__static_str (i32.const 0)))))
    (local.get $val))`

  ctx.core.stdlib['__str_concat'] = `(func $__str_concat (param $a f64) (param $b f64) (result f64)
    (local $alen i32) (local $blen i32) (local $total i32) (local $off i32) (local $i i32)
    ;; Coerce operands to strings if needed
    (local.set $a (call $__to_str (local.get $a)))
    (local.set $b (call $__to_str (local.get $b)))
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $blen (call $__str_byteLen (local.get $b)))
    (local.set $total (i32.add (local.get $alen) (local.get $blen)))
    (if (i32.eqz (local.get $total))
      (then (return (call $__mkptr (i32.const ${PTR.SSO}) (i32.const 0) (i32.const 0)))))
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
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  ctx.core.stdlib['__str_replace'] = `(func $__str_replace (param $str f64) (param $search f64) (param $repl f64) (result f64)
    (local $idx i32) (local $slen i32)
    (local.set $idx (call $__str_indexof (local.get $str) (local.get $search) (i32.const 0)))
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

  ctx.core.stdlib['__str_replaceall'] = `(func $__str_replaceall (param $str f64) (param $search f64) (param $repl f64) (result f64)
    (local $idx i32) (local $slen i32) (local $pos i32) (local $result f64)
    (local.set $slen (call $__str_byteLen (local.get $search)))
    (local.set $result (local.get $str))
    (local.set $pos (i32.const 0))
    (block $done (loop $next
      (local.set $idx (call $__str_indexof (local.get $result) (local.get $search) (local.get $pos)))
      (br_if $done (i32.lt_s (local.get $idx) (i32.const 0)))
      (local.set $result (call $__str_concat
        (call $__str_concat
          (call $__str_slice (local.get $result) (i32.const 0) (local.get $idx))
          (local.get $repl))
        (call $__str_slice (local.get $result) (i32.add (local.get $idx) (local.get $slen))
          (call $__str_byteLen (local.get $result)))))
      (local.set $pos (i32.add (local.get $idx) (call $__str_byteLen (local.get $repl))))
      (br $next)))
    (local.get $result))`

  ctx.core.stdlib['__str_split'] = `(func $__str_split (param $str f64) (param $sep f64) (result f64)
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

  ctx.core.stdlib['__str_join'] = `(func $__str_join (param $arr f64) (param $sep f64) (result f64)
    (local $off i32) (local $len i32) (local $i i32) (local $result f64)
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${PTR.SSO}) (i32.const 0) (i32.const 0)))))
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

  ctx.core.stdlib['__str_pad'] = `(func $__str_pad (param $str f64) (param $target i32) (param $pad f64) (param $before i32) (result f64)
    (local $slen i32) (local $plen i32) (local $fill i32) (local $off i32) (local $i i32)
    (local $str_off i32) (local $pad_off i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (if (i32.ge_s (local.get $slen) (local.get $target))
      (then (return (local.get $str))))
    (local.set $plen (call $__str_byteLen (local.get $pad)))
    (local.set $fill (i32.sub (local.get $target) (local.get $slen)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $target))))
    (i32.store (local.get $off) (local.get $target))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $str_off (select (local.get $fill) (i32.const 0) (local.get $before)))
    (local.set $pad_off (select (i32.const 0) (local.get $slen) (local.get $before)))
    (local.set $i (i32.const 0))
    (block $d1 (loop $l1
      (br_if $d1 (i32.ge_s (local.get $i) (local.get $slen)))
      (i32.store8 (i32.add (local.get $off) (i32.add (local.get $str_off) (local.get $i)))
        (call $__char_at (local.get $str) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l1)))
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_s (local.get $i) (local.get $fill)))
      (i32.store8 (i32.add (local.get $off) (i32.add (local.get $pad_off) (local.get $i)))
        (call $__char_at (local.get $pad) (i32.rem_u (local.get $i) (local.get $plen))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  // Always include base helpers
  inc('__sso_char', '__str_char', '__char_at', '__str_byteLen')

  // === Method emitters ===

  // Type-qualified (collide with array: slice, indexOf, includes)
  ctx.core.emit['.string:slice'] = (str, start, end) => {
    inc('__str_slice')
    if (end != null) return typed(['call', '$__str_slice', asF64(emit(str)), asI32(emit(start)), asI32(emit(end))], 'f64')
    const t = `${T}t${ctx.func.uniq++}`; ctx.func.locals.set(t, 'f64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(str))],
      ['call', '$__str_slice', ['local.get', `$${t}`], asI32(emit(start)),
        ['call', '$__str_byteLen', ['local.get', `$${t}`]]]], 'f64')
  }

  ctx.core.emit['.string:indexOf'] = (str, search, from) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s', ['call', '$__str_indexof', asF64(emit(str)), asF64(emit(search)), from ? asI32(emit(from)) : ['i32.const', 0]]], 'f64')
  }

  ctx.core.emit['.string:includes'] = (str, search) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s',
      ['i32.ge_s', ['call', '$__str_indexof', asF64(emit(str)), asF64(emit(search)), ['i32.const', 0]], ['i32.const', 0]]], 'f64')
  }

  // Generic (no collision)
  ctx.core.emit['.substring'] = (str, start, end) => {
    inc('__str_substring')
    if (end != null) return typed(['call', '$__str_substring', asF64(emit(str)), asI32(emit(start)), asI32(emit(end))], 'f64')
    const t = `${T}t${ctx.func.uniq++}`; ctx.func.locals.set(t, 'f64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(str))],
      ['call', '$__str_substring', ['local.get', `$${t}`], asI32(emit(start)),
        ['call', '$__str_byteLen', ['local.get', `$${t}`]]]], 'f64')
  }

  // Factory for simple str→call patterns: [emitKey, stdlibName, argCoercions, i32Result?]
  const coerce = { f: asF64, i: asI32 }
  const strMethod = (name, args, i32Result) => (str, ...params) => {
    inc(name)
    const call = ['call', `$${name}`, asF64(emit(str)), ...params.map((p, i) => coerce[args[i]](emit(p)))]
    return typed(i32Result ? ['f64.convert_i32_s', call] : call, 'f64')
  }

  // Simple str methods: [emitKey, stdlibName, argCoercions, i32Result?]
  ctx.core.emit['.startsWith'] = strMethod('__str_startswith', ['f'], true)
  ctx.core.emit['.endsWith'] = strMethod('__str_endswith', ['f'], true)
  ctx.core.emit['.trim'] = strMethod('__str_trim', [])
  ctx.core.emit['.trimStart'] = strMethod('__str_trimStart', [])
  ctx.core.emit['.trimEnd'] = strMethod('__str_trimEnd', [])
  ctx.core.emit['.repeat'] = strMethod('__str_repeat', ['i'])
  ctx.core.emit['.split'] = strMethod('__str_split', ['f'])
  ctx.core.emit['.replace'] = strMethod('__str_replace', ['f', 'f'])
  ctx.core.emit['.replaceAll'] = strMethod('__str_replaceall', ['f', 'f'])

  ctx.core.emit['.toUpperCase'] = (str) => {
    inc('__str_case')
    return typed(['call', '$__str_case', asF64(emit(str)), ['i32.const', 97], ['i32.const', 122], ['i32.const', -32]], 'f64')
  }

  ctx.core.emit['.toLowerCase'] = (str) => {
    inc('__str_case')
    return typed(['call', '$__str_case', asF64(emit(str)), ['i32.const', 65], ['i32.const', 90], ['i32.const', 32]], 'f64')
  }

  ctx.core.emit['.string:concat'] = (str, ...others) => {
    inc('__str_concat')
    let result = asF64(emit(str))
    for (const other of others) result = typed(['call', '$__str_concat', result, asF64(emit(other))], 'f64')
    return result
  }

  ctx.core.emit['.padStart'] = (str, len, pad) => {
    inc('__str_pad')
    const vpad = pad != null ? asF64(emit(pad))
      : typed(['call', '$__mkptr', ['i32.const', PTR.SSO], ['i32.const', 1], ['i32.const', 32]], 'f64')
    return typed(['call', '$__str_pad', asF64(emit(str)), asI32(emit(len)), vpad, ['i32.const', 1]], 'f64')
  }

  ctx.core.emit['.padEnd'] = (str, len, pad) => {
    inc('__str_pad')
    const vpad = pad != null ? asF64(emit(pad))
      : typed(['call', '$__mkptr', ['i32.const', PTR.SSO], ['i32.const', 1], ['i32.const', 32]], 'f64')
    return typed(['call', '$__str_pad', asF64(emit(str)), asI32(emit(len)), vpad, ['i32.const', 0]], 'f64')
  }

  // .charAt(i) → 1-char string from char code at index i
  ctx.core.emit['.charAt'] = (str, idx) => {
    const t = `${T}ch${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32')
    // Get char code, create SSO string with 1 byte
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__char_at', asF64(emit(str)), asI32(emit(idx))]],
      ['call', '$__mkptr', ['i32.const', PTR.SSO], ['i32.const', 1], ['local.get', `$${t}`]]], 'f64')
  }

  // .charCodeAt(i) → integer char code
  ctx.core.emit['.charCodeAt'] = (str, idx) => {
    return typed(['f64.convert_i32_u', ['call', '$__char_at', asF64(emit(str)), asI32(emit(idx))]], 'f64')
  }

  // String.fromCharCode(code) → 1-char SSO string
  ctx.core.emit['String.fromCharCode'] = (code) => {
    return typed(['call', '$__mkptr', ['i32.const', PTR.SSO], ['i32.const', 1], asI32(emit(code))], 'f64')
  }

  // String.fromCodePoint(cp) → UTF-8 encoded string
  ctx.core.stdlib['__fromCodePoint'] = `(func $__fromCodePoint (param $cp i32) (result f64)
    (local $off i32) (local $len i32)
    ;; ASCII: 1 byte SSO
    (if (i32.lt_u (local.get $cp) (i32.const 128))
      (then (return (call $__mkptr (i32.const ${PTR.SSO}) (i32.const 1) (local.get $cp)))))
    ;; 2-byte: 0x80-0x7FF → SSO
    (if (i32.lt_u (local.get $cp) (i32.const 0x800))
      (then (return (call $__mkptr (i32.const ${PTR.SSO}) (i32.const 2)
        (i32.or
          (i32.or (i32.const 0xC0) (i32.shr_u (local.get $cp) (i32.const 6)))
          (i32.shl (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))) (i32.const 8)))))))
    ;; 3-byte: 0x800-0xFFFF → SSO (3 bytes fits)
    (if (i32.lt_u (local.get $cp) (i32.const 0x10000))
      (then (return (call $__mkptr (i32.const ${PTR.SSO}) (i32.const 3)
        (i32.or (i32.or
          (i32.or (i32.const 0xE0) (i32.shr_u (local.get $cp) (i32.const 12)))
          (i32.shl (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))) (i32.const 8)))
          (i32.shl (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))) (i32.const 16)))))))
    ;; 4-byte: 0x10000-0x10FFFF → SSO (4 bytes fits)
    (return (call $__mkptr (i32.const ${PTR.SSO}) (i32.const 4)
      (i32.or (i32.or (i32.or
        (i32.or (i32.const 0xF0) (i32.shr_u (local.get $cp) (i32.const 18)))
        (i32.shl (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 12)) (i32.const 0x3F))) (i32.const 8)))
        (i32.shl (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))) (i32.const 16)))
        (i32.shl (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))) (i32.const 24))))))`

  ctx.core.emit['String.fromCodePoint'] = (code) => {
    inc('__fromCodePoint')
    return typed(['call', '$__fromCodePoint', asI32(emit(code))], 'f64')
  }

  // .at(i) → charAt with negative index support
  ctx.core.emit['.at'] = (str, idx) => {
    const t = `${T}at${ctx.func.uniq++}`, s = `${T}as${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'i32'); ctx.func.locals.set(s, 'f64')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${t}`, asI32(emit(idx))],
      // Negative index: t += length
      ['if', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]],
        ['then', ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`],
          ['call', '$__str_byteLen', ['local.get', `$${s}`]]]]]],
      ['call', '$__mkptr', ['i32.const', PTR.SSO], ['i32.const', 1],
        ['call', '$__char_at', ['local.get', `$${s}`], ['local.get', `$${t}`]]]], 'f64')
  }

  // .search(str) → indexOf (same as indexOf for string args)
  ctx.core.emit['.search'] = (str, search) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s', ['call', '$__str_indexof', asF64(emit(str)), asF64(emit(search)), ['i32.const', 0]]], 'f64')
  }

  // .match(str) → [match] array if found, or 0 (null) if not
  // For string args, returns single-element array with the matched substring
  ctx.core.emit['.match'] = (str, search) => {
    inc('__str_indexof', '__str_slice', '__wrap1')
    const s = `${T}ms${ctx.func.uniq++}`, q = `${T}mq${ctx.func.uniq++}`, idx = `${T}mi${ctx.func.uniq++}`
    ctx.func.locals.set(s, 'f64'); ctx.func.locals.set(q, 'f64'); ctx.func.locals.set(idx, 'i32')
    // indexOf, then if >= 0, create 1-element array with the match slice
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${q}`, asF64(emit(search))],
      ['local.set', `$${idx}`, ['call', '$__str_indexof', ['local.get', `$${s}`], ['local.get', `$${q}`], ['i32.const', 0]]],
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
  ctx.core.stdlib['__wrap1'] = `(func $__wrap1 (param $val f64) (result f64)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.const 16)))
    (i32.store (local.get $ptr) (i32.const 1))
    (i32.store (i32.add (local.get $ptr) (i32.const 4)) (i32.const 1))
    (f64.store (i32.add (local.get $ptr) (i32.const 8)) (local.get $val))
    (call $__mkptr (i32.const 1) (i32.const 0) (i32.add (local.get $ptr) (i32.const 8))))`

  // TextEncoder() / TextDecoder() → dummy values (methods do the work)
  ctx.core.emit['TextEncoder'] = () => typed(['f64.const', 1], 'f64')
  ctx.core.emit['TextDecoder'] = () => typed(['f64.const', 2], 'f64')

  // .encode(str) → Uint8Array of string's UTF-8 bytes
  // Copies bytes from string (SSO or heap) into a new Uint8Array
  ctx.core.stdlib['__str_encode'] = `(func $__str_encode (param $str f64) (result f64)
    (local $len i32) (local $dst i32) (local $i i32)
    (local.set $len (call $__str_byteLen (local.get $str)))
    (local.set $dst (call $__alloc (i32.add (i32.const 8) (local.get $len))))
    (i32.store (local.get $dst) (local.get $len))
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (local.get $len))
    (local.set $dst (i32.add (local.get $dst) (i32.const 8)))
    ;; Copy bytes using char_at (handles both SSO and heap)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $dst) (local.get $i))
        (call $__char_at (local.get $str) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $__mkptr (i32.const 3) (i32.const 1) (local.get $dst)))`

  ctx.core.emit['.encode'] = (obj, str) => {
    inc('__str_encode')
    return typed(['call', '$__str_encode', asF64(emit(str))], 'f64')
  }

  // .decode(uint8arr) → string from byte data
  ctx.core.stdlib['__bytes_decode'] = `(func $__bytes_decode (param $arr f64) (result f64)
    (local $off i32) (local $len i32) (local $dst i32)
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (local.set $dst (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $dst) (local.get $len))
    (local.set $dst (i32.add (local.get $dst) (i32.const 4)))
    (memory.copy (local.get $dst) (local.get $off) (local.get $len))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $dst)))`

  ctx.core.emit['.decode'] = (obj, arr) => {
    inc('__bytes_decode')
    return typed(['call', '$__bytes_decode', asF64(emit(arr))], 'f64')
  }
}
