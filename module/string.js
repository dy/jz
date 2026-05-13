/**
 * String module — literals, char access, and string methods.
 *
 * Type=4 (STRING) covers both encodings; aux bit LAYOUT.SSO_BIT discriminates:
 *   bit clear: heap-allocated, length in header [-4:len], offset → bytes.
 *   bit set:   inline ≤4 ASCII chars packed in offset (no memory),
 *              length in aux low bits (0..4).
 *
 * Methods use type-qualified keys (.string:slice) for array-colliding names,
 * generic keys (.toUpperCase) for non-colliding ones.
 *
 * @module string
 */

import { typed, asF64, asI32, asI64, NULL_NAN, UNDEF_NAN, mkPtrIR, temp, tempI32 } from '../src/ir.js'
import { emit } from '../src/emit.js'
import { valTypeOf, VAL } from '../src/analyze.js'
import { inc, PTR, LAYOUT } from '../src/ctx.js'

// SSO discriminator bit pre-shifted to its slot in the full i64 ptr (bit 46).
// Used as `i64.and ptr SSO_BIT_I64` for branch-without-extracting-aux.
const SSO_BIT_I64 = '0x' + (BigInt(LAYOUT.SSO_BIT) << BigInt(LAYOUT.AUX_SHIFT)).toString(16).toUpperCase().padStart(16, '0')


export default (ctx) => {
  Object.assign(ctx.core.stdlibDeps, {
    __str_concat: ['__to_str', '__str_byteLen', '__alloc', '__mkptr', '__str_copy'],
    __str_concat_raw: ['__str_byteLen', '__alloc', '__mkptr', '__str_copy'],
    __str_append_byte: ['__str_byteLen', '__alloc', '__mkptr', '__str_copy'],
    __str_copy: [],
    __str_slice: ['__str_byteLen', '__alloc'],
    __str_indexof: ['__str_byteLen'],
    __str_substring: ['__str_slice'],
    __str_startswith: ['__str_byteLen'],
    __str_endswith: ['__str_byteLen'],
    __str_case: ['__str_byteLen', '__alloc'],
    __str_trim: ['__str_slice', '__str_byteLen', '__char_at'],
    __str_trimStart: ['__str_slice', '__str_byteLen', '__char_at'],
    __str_trimEnd: ['__str_slice', '__str_byteLen', '__char_at'],
    __str_repeat: ['__str_byteLen', '__str_copy', '__alloc'],
    __str_replace: ['__str_indexof', '__str_slice', '__str_concat'],
    __str_replaceall: ['__str_indexof', '__str_slice', '__str_concat'],
    __str_split: ['__str_slice', '__str_byteLen', '__char_at', '__alloc'],
    __str_idx: [],
    __str_eq: ['__char_at'],
    __str_cmp: ['__char_at', '__str_byteLen'],
    __str_pad: ['__str_byteLen', '__str_copy', '__alloc'],
    __str_join: ['__str_concat', '__to_str', '__str_byteLen', '__len', '__ptr_offset'],
    __str_encode: ['__str_byteLen', '__str_copy'],
    __to_str: ['__ftoa', '__static_str', '__str_join', '__mkptr'],
    __str_byteLen: ['__ptr_type', '__ptr_aux', '__str_len'],
  })

  inc('__mkptr', '__alloc')

  // === String literal: "abc" → SSO if ≤4 ASCII, else heap ===

  ctx.core.emit['str'] = (str) => {
    const MAX_SSO = 4
    if (ctx.features.sso && str.length <= MAX_SSO && /^[\x00-\x7f]*$/.test(str)) {
      let packed = 0
      for (let i = 0; i < str.length; i++) packed |= str.charCodeAt(i) << (i * 8)
      return mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT | str.length, packed)
    }
    const bytes = new TextEncoder().encode(str)
    const len = bytes.length
    if (!ctx.memory.shared) {
      // Own memory: place in static data segment (no runtime allocation)
      if (!ctx.runtime.data) ctx.runtime.data = ''
      const prior = ctx.runtime.dataDedup.get(str)
      if (prior !== undefined) return mkPtrIR(PTR.STRING, 0, prior + 4)
      while (ctx.runtime.data.length % 4 !== 0) ctx.runtime.data += '\0'
      const offset = ctx.runtime.data.length
      ctx.runtime.data += String.fromCharCode(len & 0xFF, (len >> 8) & 0xFF, (len >> 16) & 0xFF, (len >> 24) & 0xFF)
      for (let i = 0; i < len; i++) ctx.runtime.data += String.fromCharCode(bytes[i])
      ctx.runtime.dataDedup.set(str, offset)
      return mkPtrIR(PTR.STRING, 0, offset + 4)
    }
    // Shared memory: pack all string literals into one passive data segment with 4-byte
    // length prefixes. At __start, alloc the whole pool once and memory.init it in a single
    // call. Each use site resolves to `strBase + compile-time-offset` — O(1) IR nodes per
    // use, independent of string length AND reused across uses.
    if (!ctx.runtime.strPool) {
      ctx.runtime.strPool = ''
      ctx.scope.globals.set('__strBase', '(global $__strBase (mut i32) (i32.const 0))')
    }
    let off = ctx.runtime.strPoolDedup.get(str)
    if (off === undefined) {
      // Pack length header then UTF-8 bytes; offset points PAST the length (at the data).
      ctx.runtime.strPool += String.fromCharCode(len & 0xFF, (len >> 8) & 0xFF, (len >> 16) & 0xFF, (len >> 24) & 0xFF)
      off = ctx.runtime.strPool.length
      for (let i = 0; i < len; i++) ctx.runtime.strPool += String.fromCharCode(bytes[i])
      ctx.runtime.strPoolDedup.set(str, off)
    }
    return mkPtrIR(PTR.STRING, 0, ['i32.add', ['global.get', '$__strBase'], ['i32.const', off]])
  }

  // === WAT: char extraction ===

  // SSO/STRING ptrs never have forwarding pointers (only ARRAY does), so we extract
  // the raw offset directly instead of paying the __ptr_offset function-call overhead.
  ctx.core.stdlib['__sso_char'] = `(func $__sso_char (param $ptr i64) (param $i i32) (result i32)
    (i32.and
      (i32.shr_u
        (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK})))
        (i32.mul (local.get $i) (i32.const 8)))
      (i32.const 0xFF)))`

  ctx.core.stdlib['__str_char'] = `(func $__str_char (param $ptr i64) (param $i i32) (result i32)
    (i32.load8_u (i32.add
      (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK})))
      (local.get $i))))`

  // Hot (~37M calls in watr self-host). Caller guarantees $ptr is a STRING;
  // SSO bit picks inline-byte-extract vs heap memory load.
  ctx.core.stdlib['__char_at'] = `(func $__char_at (param $ptr i64) (param $i i32) (result i32)
    (local $off i32)
    (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (if (result i32)
      (i64.ne (i64.and (local.get $ptr) (i64.const ${SSO_BIT_I64})) (i64.const 0))
      (then
        (i32.and
          (i32.shr_u (local.get $off) (i32.mul (local.get $i) (i32.const 8)))
          (i32.const 0xFF)))
      (else
        (i32.load8_u (i32.add (local.get $off) (local.get $i))))))`

  ctx.core.stdlib['__str_idx'] = `(func $__str_idx (param $ptr i64) (param $i i32) (result f64)
    (local $t i32) (local $off i32) (local $len i32) (local $isSso i32)
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $isSso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $len
      (if (result i32) (local.get $isSso)
        (then (i32.and
          (i32.wrap_i64 (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})))
          (i32.const ${LAYOUT.SSO_BIT - 1})))
        (else
          (if (result i32) (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.ge_u (local.get $off) (i32.const 4)))
            (then (i32.load (i32.sub (local.get $off) (i32.const 4))))
            (else (i32.const 0))))))
    (if (result f64)
      (i32.or (i32.lt_s (local.get $i) (i32.const 0)) (i32.ge_u (local.get $i) (local.get $len)))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (f64.reinterpret_i64
          (i64.or
            ;; mkptr(STRING, SSO_BIT|1, 0) = NAN_PREFIX | (STRING<<TAG_SHIFT) | ((SSO_BIT|1)<<AUX_SHIFT)
            (i64.const ${'0x' + (LAYOUT.NAN_PREFIX_BITS | (BigInt(PTR.STRING) << BigInt(LAYOUT.TAG_SHIFT)) | ((BigInt(LAYOUT.SSO_BIT) | 1n) << BigInt(LAYOUT.AUX_SHIFT))).toString(16).toUpperCase().padStart(16, '0')})
            (i64.extend_i32_u
              (if (result i32) (local.get $isSso)
                (then (i32.and (i32.shr_u (local.get $off) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0xFF)))
                (else (i32.load8_u (i32.add (local.get $off) (local.get $i)))))))))))`

  // Hot: ~53M calls in watr self-host. Bit-eq covers identity. SSO/SSO with !bit-eq
  // guarantees content differs (high 32 bits encode type+len; both equal → low 32 differs
  // ⇒ bytes differ). Heap/heap uses raw load8_u — no per-byte function calls.
  // Mixed SSO×heap is rare; falls back to __char_at.
  ctx.core.stdlib['__str_eq'] = `(func $__str_eq (param $a i64) (param $b i64) (result i32)
    (local $len i32) (local $lenB i32) (local $i i32)
    (local $ta i32) (local $tb i32)
    (local $offA i32) (local $offB i32)
    (local $ssoA i32) (local $ssoB i32)
    (if (i64.eq (local.get $a) (local.get $b))
      (then (return (i32.const 1))))
    (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $tb (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $offA (i32.wrap_i64 (i64.and (local.get $a) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $offB (i32.wrap_i64 (i64.and (local.get $b) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $ssoA (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $ssoB (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    ;; Both SSO with !bit-eq ⇒ content differs (high 32 bits hold tag+aux; both equal here).
    (if (i32.and (local.get $ssoA) (local.get $ssoB))
      (then (return (i32.const 0))))
    ;; Both heap STRING fast path: inline len from header. Chunk by 4 bytes via unaligned
    ;; i32.load (wasm guarantees unaligned-OK), then byte-tail. Most string comparisons fail
    ;; early on the first 4-byte word, so this collapses the per-byte branch overhead into a
    ;; single 32-bit equality.
    (if (i32.and
          (i32.and (i32.eq (local.get $ta) (i32.const ${PTR.STRING})) (i32.eqz (local.get $ssoA)))
          (i32.and (i32.eq (local.get $tb) (i32.const ${PTR.STRING})) (i32.eqz (local.get $ssoB))))
      (then
        (if (i32.or (i32.lt_u (local.get $offA) (i32.const 4)) (i32.lt_u (local.get $offB) (i32.const 4)))
          (then (return (i32.const 0))))
        (local.set $len (i32.load (i32.sub (local.get $offA) (i32.const 4))))
        (local.set $lenB (i32.load (i32.sub (local.get $offB) (i32.const 4))))
        (if (i32.ne (local.get $len) (local.get $lenB))
          (then (return (i32.const 0))))
        (local.set $lenB (i32.and (local.get $len) (i32.const -4)))
        (block $d4 (loop $l4
          (br_if $d4 (i32.ge_s (local.get $i) (local.get $lenB)))
          (if (i32.ne
                (i32.load (i32.add (local.get $offA) (local.get $i)))
                (i32.load (i32.add (local.get $offB) (local.get $i))))
            (then (return (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 4)))
          (br $l4)))
        (block $dh (loop $lh
          (br_if $dh (i32.ge_s (local.get $i) (local.get $len)))
          (if (i32.ne
                (i32.load8_u (i32.add (local.get $offA) (local.get $i)))
                (i32.load8_u (i32.add (local.get $offB) (local.get $i))))
            (then (return (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lh)))
        (return (i32.const 1))))
    ;; Mixed (SSO×heap) or anything else: compute len per side then per-byte via __char_at.
    (if (local.get $ssoA)
      (then (local.set $len (i32.and
        (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const ${LAYOUT.AUX_SHIFT})))
        (i32.const ${LAYOUT.SSO_BIT - 1}))))
      (else
        (if (i32.and (i32.eq (local.get $ta) (i32.const ${PTR.STRING})) (i32.ge_u (local.get $offA) (i32.const 4)))
          (then (local.set $len (i32.load (i32.sub (local.get $offA) (i32.const 4))))))))
    (if (local.get $ssoB)
      (then (local.set $lenB (i32.and
        (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const ${LAYOUT.AUX_SHIFT})))
        (i32.const ${LAYOUT.SSO_BIT - 1}))))
      (else
        (if (i32.and (i32.eq (local.get $tb) (i32.const ${PTR.STRING})) (i32.ge_u (local.get $offB) (i32.const 4)))
          (then (local.set $lenB (i32.load (i32.sub (local.get $offB) (i32.const 4))))))))
    (if (i32.ne (local.get $len) (local.get $lenB))
      (then (return (i32.const 0))))
    (block $dm (loop $lm
      (br_if $dm (i32.ge_s (local.get $i) (local.get $len)))
      (if (i32.ne (call $__char_at (local.get $a) (local.get $i))
                  (call $__char_at (local.get $b) (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lm)))
    (i32.const 1))`

  // Three-way byte-wise compare: -1 if a < b, 0 if equal, +1 if a > b. Returns
  // i32 so callers can `i32.lt_s 0`, `i32.gt_s 0`, etc. without coercion.
  // Comparison is unsigned (i32.load8_u via __char_at) — matches JS spec for
  // ASCII; for non-ASCII it's a UTF-8 byte order, which collates the same as
  // codepoint order for code points < 0x80 and well-formed strings. NOT locale-
  // aware: this is the byte-wise variant suitable for sort-stability use cases,
  // not human-language collation.
  ctx.core.stdlib['__str_cmp'] = `(func $__str_cmp (param $a i64) (param $b i64) (result i32)
    (local $lenA i32) (local $lenB i32) (local $minLen i32) (local $i i32)
    (local $ca i32) (local $cb i32)
    ;; Bit-equal pointers (including same SSO inline form) ⇒ identical strings.
    (if (i64.eq (local.get $a) (local.get $b))
      (then (return (i32.const 0))))
    (local.set $lenA (call $__str_byteLen (local.get $a)))
    (local.set $lenB (call $__str_byteLen (local.get $b)))
    (local.set $minLen (select (local.get $lenA) (local.get $lenB)
      (i32.lt_s (local.get $lenA) (local.get $lenB))))
    (block $done (loop $next
      (br_if $done (i32.ge_s (local.get $i) (local.get $minLen)))
      (local.set $ca (call $__char_at (local.get $a) (local.get $i)))
      (local.set $cb (call $__char_at (local.get $b) (local.get $i)))
      (if (i32.lt_u (local.get $ca) (local.get $cb)) (then (return (i32.const -1))))
      (if (i32.gt_u (local.get $ca) (local.get $cb)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    ;; Common prefix matches — shorter string sorts first.
    (if (i32.lt_s (local.get $lenA) (local.get $lenB)) (then (return (i32.const -1))))
    (if (i32.gt_s (local.get $lenA) (local.get $lenB)) (then (return (i32.const 1))))
    (i32.const 0))`

  // === WAT: unified byte length (SSO → aux low bits, heap → header) ===

  ctx.core.stdlib['__str_byteLen'] = `(func $__str_byteLen (param $ptr i64) (result i32)
    (local $t i32) (local $off i32) (local $aux i32)
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (if (result i32) (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
      (then
        (local.set $aux (i32.and
          (i32.wrap_i64 (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})))
          (i32.const ${LAYOUT.AUX_MASK})))
        (if (result i32) (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT}))
          (then (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT - 1})))
          (else
            (local.set $off (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
            (if (result i32) (i32.ge_u (local.get $off) (i32.const 4))
              (then (i32.load (i32.sub (local.get $off) (i32.const 4))))
              (else (i32.const 0))))))
      (else (i32.const 0))))`

  // === WAT: string methods ===

  // SSO source uses an unrolled byte-extract loop (len ≤ 4); heap source uses memory.copy
  // (single bulk op instead of nlen × __char_at).
  ctx.core.stdlib['__str_slice'] = `(func $__str_slice (param $ptr i64) (param $start i32) (param $end i32) (result f64)
    (local $len i32) (local $nlen i32) (local $off i32) (local $i i32)
    (local $srcOff i32) (local $isSso i32)
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
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $nlen (i32.sub (local.get $end) (local.get $start)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $nlen))))
    (i32.store (local.get $off) (local.get $nlen))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $srcOff (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $isSso (i32.wrap_i64 (i64.shr_u
      (i64.and (local.get $ptr) (i64.const ${SSO_BIT_I64}))
      (i64.const ${LAYOUT.AUX_SHIFT}))))
    (if (local.get $isSso)
      (then
        (block $done (loop $loop
          (br_if $done (i32.ge_s (local.get $i) (local.get $nlen)))
          (i32.store8 (i32.add (local.get $off) (local.get $i))
            (i32.and (i32.shr_u (local.get $srcOff)
              (i32.shl (i32.add (local.get $start) (local.get $i)) (i32.const 3)))
              (i32.const 0xFF)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop))))
      (else
        (memory.copy (local.get $off) (i32.add (local.get $srcOff) (local.get $start)) (local.get $nlen))))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  ctx.core.stdlib['__str_substring'] = `(func $__str_substring (param $ptr i64) (param $start i32) (param $end i32) (result f64)
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

  // Hoist SSO/heap dispatch for hay and ndl out of the inner byte loop. Inner
  // loop becomes (load8_u OR sso byte-extract) per side — no per-byte calls.
  ctx.core.stdlib['__str_indexof'] = `(func $__str_indexof (param $hay i64) (param $ndl i64) (param $from i32) (result i32)
    (local $hlen i32) (local $nlen i32) (local $i i32) (local $j i32) (local $match i32)
    (local $hoff i32) (local $noff i32)
    (local $hsso i32) (local $nsso i32) (local $hb i32) (local $nb i32) (local $k i32)
    (local.set $hlen (call $__str_byteLen (local.get $hay)))
    (local.set $nlen (call $__str_byteLen (local.get $ndl)))
    (if (i32.eqz (local.get $nlen)) (then (return (local.get $from))))
    (if (i32.gt_s (local.get $nlen) (local.get $hlen)) (then (return (i32.const -1))))
    (local.set $hoff (i32.wrap_i64 (i64.and (local.get $hay) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $noff (i32.wrap_i64 (i64.and (local.get $ndl) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $hsso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $hay) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $nsso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $ndl) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $i (if (result i32) (i32.gt_s (local.get $from) (i32.const 0)) (then (local.get $from)) (else (i32.const 0))))
    (block $done (loop $outer
      (br_if $done (i32.gt_s (local.get $i) (i32.sub (local.get $hlen) (local.get $nlen))))
      (local.set $match (i32.const 1))
      (local.set $j (i32.const 0))
      (block $nomatch (loop $inner
        (br_if $nomatch (i32.ge_s (local.get $j) (local.get $nlen)))
        (local.set $k (i32.add (local.get $i) (local.get $j)))
        (local.set $hb (if (result i32) (local.get $hsso)
          (then (i32.and (i32.shr_u (local.get $hoff) (i32.shl (local.get $k) (i32.const 3))) (i32.const 0xFF)))
          (else (i32.load8_u (i32.add (local.get $hoff) (local.get $k))))))
        (local.set $nb (if (result i32) (local.get $nsso)
          (then (i32.and (i32.shr_u (local.get $noff) (i32.shl (local.get $j) (i32.const 3))) (i32.const 0xFF)))
          (else (i32.load8_u (i32.add (local.get $noff) (local.get $j))))))
        (if (i32.ne (local.get $hb) (local.get $nb))
          (then (local.set $match (i32.const 0)) (br $nomatch)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $inner)))
      (if (local.get $match) (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $outer)))
    (i32.const -1))`

  // SSO/heap dispatch hoisted; inner loop is two inlined byte-fetches and a compare.
  ctx.core.stdlib['__str_startswith'] = `(func $__str_startswith (param $str i64) (param $pfx i64) (result i32)
    (local $plen i32) (local $i i32)
    (local $soff i32) (local $poff i32) (local $ssso i32) (local $psso i32)
    (local.set $plen (call $__str_byteLen (local.get $pfx)))
    (if (i32.gt_s (local.get $plen) (call $__str_byteLen (local.get $str)))
      (then (return (i32.const 0))))
    (local.set $soff (i32.wrap_i64 (i64.and (local.get $str) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $poff (i32.wrap_i64 (i64.and (local.get $pfx) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $ssso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $str) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $psso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $pfx) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $plen)))
      (if (i32.ne
            (if (result i32) (local.get $ssso)
              (then (i32.and (i32.shr_u (local.get $soff) (i32.shl (local.get $i) (i32.const 3))) (i32.const 0xFF)))
              (else (i32.load8_u (i32.add (local.get $soff) (local.get $i)))))
            (if (result i32) (local.get $psso)
              (then (i32.and (i32.shr_u (local.get $poff) (i32.shl (local.get $i) (i32.const 3))) (i32.const 0xFF)))
              (else (i32.load8_u (i32.add (local.get $poff) (local.get $i))))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))`

  ctx.core.stdlib['__str_endswith'] = `(func $__str_endswith (param $str i64) (param $sfx i64) (result i32)
    (local $slen i32) (local $flen i32) (local $off i32) (local $i i32) (local $k i32)
    (local $soff i32) (local $foff i32) (local $ssso i32) (local $fsso i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (local.set $flen (call $__str_byteLen (local.get $sfx)))
    (if (i32.gt_s (local.get $flen) (local.get $slen))
      (then (return (i32.const 0))))
    (local.set $off (i32.sub (local.get $slen) (local.get $flen)))
    (local.set $soff (i32.wrap_i64 (i64.and (local.get $str) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $foff (i32.wrap_i64 (i64.and (local.get $sfx) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $ssso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $str) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (local.set $fsso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $sfx) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $flen)))
      (local.set $k (i32.add (local.get $off) (local.get $i)))
      (if (i32.ne
            (if (result i32) (local.get $ssso)
              (then (i32.and (i32.shr_u (local.get $soff) (i32.shl (local.get $k) (i32.const 3))) (i32.const 0xFF)))
              (else (i32.load8_u (i32.add (local.get $soff) (local.get $k)))))
            (if (result i32) (local.get $fsso)
              (then (i32.and (i32.shr_u (local.get $foff) (i32.shl (local.get $i) (i32.const 3))) (i32.const 0xFF)))
              (else (i32.load8_u (i32.add (local.get $foff) (local.get $i))))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))`

  // Source SSO/heap dispatch hoisted out of the byte loop (was a per-byte __char_at).
  ctx.core.stdlib['__str_case'] = `(func $__str_case (param $ptr i64) (param $lo i32) (param $hi i32) (param $delta i32) (result f64)
    (local $len i32) (local $off i32) (local $i i32) (local $c i32)
    (local $srcOff i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $off) (local.get $len))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $srcOff (i32.wrap_i64 (i64.and (local.get $ptr) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (if (i64.ne (i64.and (local.get $ptr) (i64.const ${SSO_BIT_I64})) (i64.const 0))
      (then
        (block $dsso (loop $lsso
          (br_if $dsso (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $c (i32.and
            (i32.shr_u (local.get $srcOff) (i32.shl (local.get $i) (i32.const 3)))
            (i32.const 0xFF)))
          (if (i32.and (i32.ge_u (local.get $c) (local.get $lo)) (i32.le_u (local.get $c) (local.get $hi)))
            (then (local.set $c (i32.add (local.get $c) (local.get $delta)))))
          (i32.store8 (i32.add (local.get $off) (local.get $i)) (local.get $c))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lsso))))
      (else
        (block $dh (loop $lh
          (br_if $dh (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $c (i32.load8_u (i32.add (local.get $srcOff) (local.get $i))))
          (if (i32.and (i32.ge_u (local.get $c) (local.get $lo)) (i32.le_u (local.get $c) (local.get $hi)))
            (then (local.set $c (i32.add (local.get $c) (local.get $delta)))))
          (i32.store8 (i32.add (local.get $off) (local.get $i)) (local.get $c))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lh)))))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  ctx.core.stdlib['__str_trim'] = `(func $__str_trim (param $ptr i64) (result f64)
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

  ctx.core.stdlib['__str_trimStart'] = `(func $__str_trimStart (param $ptr i64) (result f64)
    (local $len i32) (local $start i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $start (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $start) (local.get $len)))
      (br_if $done (i32.gt_u (call $__char_at (local.get $ptr) (local.get $start)) (i32.const 32)))
      (local.set $start (i32.add (local.get $start) (i32.const 1)))
      (br $loop)))
    (call $__str_slice (local.get $ptr) (local.get $start) (local.get $len)))`

  ctx.core.stdlib['__str_trimEnd'] = `(func $__str_trimEnd (param $ptr i64) (result f64)
    (local $len i32) (local $end i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (local.set $end (local.get $len))
    (block $done (loop $loop
      (br_if $done (i32.le_s (local.get $end) (i32.const 0)))
      (br_if $done (i32.gt_u (call $__char_at (local.get $ptr) (i32.sub (local.get $end) (i32.const 1))) (i32.const 32)))
      (local.set $end (i32.sub (local.get $end) (i32.const 1)))
      (br $loop)))
    (call $__str_slice (local.get $ptr) (i32.const 0) (local.get $end)))`

  // Materialize source bytes once via __str_copy (handles SSO/heap), then memory.copy
  // each subsequent repetition (single bulk op vs len byte stores per copy).
  ctx.core.stdlib['__str_repeat'] = `(func $__str_repeat (param $ptr i64) (param $n i32) (result f64)
    (local $len i32) (local $total i32) (local $off i32) (local $i i32)
    (local.set $len (call $__str_byteLen (local.get $ptr)))
    (if (i32.or (i32.eqz (local.get $n)) (i32.eqz (local.get $len)))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $total (i32.mul (local.get $len) (local.get $n)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $total))))
    (i32.store (local.get $off) (local.get $total))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (call $__str_copy (local.get $ptr) (local.get $off) (local.get $len))
    (local.set $i (i32.const 1))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (memory.copy
        (i32.add (local.get $off) (i32.mul (local.get $i) (local.get $len)))
        (local.get $off)
        (local.get $len))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  // Coerce value to string: numbers → __ftoa, nullish → static strings,
  // plain NaN → "NaN", arrays → join(","), other string-like pointers pass through.
  ctx.core.stdlib['__to_str'] = `(func $__to_str (param $val i64) (result i64)
    (local $type i32) (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $val)))
    ;; Not NaN → number, convert
    (if (f64.eq (local.get $f) (local.get $f))
      (then (return (i64.reinterpret_f64 (call $__ftoa (local.get $f) (i32.const 0) (i32.const 0))))))
    (if (i64.eq (local.get $val) (i64.const ${NULL_NAN}))
      (then (return (i64.reinterpret_f64 (call $__static_str (i32.const 5))))))
    (if (i64.eq (local.get $val) (i64.const ${UNDEF_NAN}))
      (then (return (i64.reinterpret_f64 (call $__static_str (i32.const 6))))))
    (local.set $type (call $__ptr_type (local.get $val)))
    ;; Plain NaN (type=0) → "NaN" string
    (if (i32.eqz (local.get $type))
      (then (return (i64.reinterpret_f64 (call $__static_str (i32.const 0))))))
    ;; Array (type=1) → join(",") like JS Array.toString()
    (if (i32.eq (local.get $type) (i32.const ${PTR.ARRAY}))
      (then (return (i64.reinterpret_f64 (call $__str_join (local.get $val)
        (i64.reinterpret_f64 (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT | 1}) (i32.const 44))))))))
    (local.get $val))`

  // Copy bytes of a string (SSO or heap) into memory at dst. Uses memory.copy for
  // heap strings (single native op); unpacks SSO offset-packed bytes inline.
  ctx.core.stdlib['__str_copy'] = `(func $__str_copy (param $src i64) (param $dst i32) (param $len i32)
    (local $w i32)
    (if (i64.ne (i64.and (local.get $src) (i64.const ${SSO_BIT_I64})) (i64.const 0))
      (then
        ;; SSO: up to 4 chars packed in low 32 bits (LE byte order). Unroll: write 1/2/3/4 bytes
        ;; depending on len. (len > 4 is rare/disallowed in practice — fallback handles up to 4.)
        (local.set $w (i32.wrap_i64 (local.get $src)))
        (if (i32.ge_u (local.get $len) (i32.const 4))
          (then (i32.store (local.get $dst) (local.get $w)))
          (else
            (if (i32.eq (local.get $len) (i32.const 0)) (then (return)))
            (i32.store8 (local.get $dst) (local.get $w))
            (if (i32.eq (local.get $len) (i32.const 1)) (then (return)))
            (i32.store8 offset=1 (local.get $dst) (i32.shr_u (local.get $w) (i32.const 8)))
            (if (i32.eq (local.get $len) (i32.const 2)) (then (return)))
            (i32.store8 offset=2 (local.get $dst) (i32.shr_u (local.get $w) (i32.const 16))))))
      (else
        ;; Heap STRING: memory.copy directly from string data
        (memory.copy (local.get $dst)
          (i32.wrap_i64 (i64.and (local.get $src) (i64.const ${LAYOUT.OFFSET_MASK})))
          (local.get $len)))))`

  // Bump-extend fast path: when `a` is a heap STRING sitting at the top of the
  // bump allocator, extend its allocation in place instead of copying. Mutates
  // memory[a.off-4] to the new length and bumps __heap. This makes the canonical
  // `buf += char` build pattern O(N) instead of O(N²) — closing the asymptotic
  // gap with V8's cons-strings. Tradeoff: aliased refs to `a` see the larger
  // length too, so this departs from strict JS string immutability for the rare
  // `let b = a; a += x` aliasing case. The fast path can't trigger when other
  // allocations have happened since `a` was created (it's no longer at heap top).
  // Only emitted for own-memory mode; shared memory falls back to slow path.
  const concatFast = !ctx.memory.shared ? `
    (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $aoff (i32.wrap_i64 (i64.and (local.get $a) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; Bump-extend requires heap STRING (not SSO — its offset holds packed bytes).
    (if (i32.and
          (i32.and
            (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
            (i64.eqz (i64.and (local.get $a) (i64.const ${SSO_BIT_I64}))))
          (i32.eq
            (i32.and (i32.add (i32.add (local.get $aoff) (local.get $alen)) (i32.const 7)) (i32.const -8))
            (global.get $__heap)))
      (then
        (local.set $newHeap
          (i32.and (i32.add (i32.add (local.get $aoff) (local.get $total)) (i32.const 7)) (i32.const -8)))
        (if (i32.gt_u (local.get $newHeap) (i32.mul (memory.size) (i32.const 65536)))
          (then (if (i32.eq (memory.grow
            (i32.shr_u (i32.add (i32.sub (local.get $newHeap) (i32.mul (memory.size) (i32.const 65536))) (i32.const 65535)) (i32.const 16)))
            (i32.const -1)) (then (unreachable)))))
        (call $__str_copy (local.get $b)
          (i32.add (local.get $aoff) (local.get $alen))
          (local.get $blen))
        (i32.store (i32.sub (local.get $aoff) (i32.const 4)) (local.get $total))
        (global.set $__heap (local.get $newHeap))
        (return (f64.reinterpret_i64 (local.get $a)))))` : ''

  // Fused single-byte append: `buf += str[i]` lowers to this when both sides are
  // VAL.STRING and the rhs is a string-index. Skips __str_idx's 1-char SSO
  // construction and __str_concat's type-dispatch — byte goes directly from
  // __char_at to memory. Bump-extends in place when `a` is at heap top.
  ctx.core.stdlib['__str_append_byte'] = `(func $__str_append_byte (param $a i64) (param $byte i32) (result f64)
    (local $ta i32) (local $aoff i32) (local $alen i32)
    (local $newHeap i32) (local $off i32) (local $total i32)
    (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $aoff (i32.wrap_i64 (i64.and (local.get $a) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; Heap STRING at heap top: bump-extend by 1 byte (own-memory mode only).
    ;; Gate on STRING tag AND !SSO_BIT — for SSO, $aoff holds packed bytes (not a heap addr).
    ${!ctx.memory.shared ? `
    (if (i32.and
          (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
          (i64.eqz (i64.and (local.get $a) (i64.const ${SSO_BIT_I64}))))
      (then
        (local.set $alen (i32.load (i32.sub (local.get $aoff) (i32.const 4))))
        (if (i32.eq
              (i32.and (i32.add (i32.add (local.get $aoff) (local.get $alen)) (i32.const 7)) (i32.const -8))
              (global.get $__heap))
          (then
            (local.set $newHeap
              (i32.and (i32.add (i32.add (local.get $aoff) (local.get $alen)) (i32.const 8)) (i32.const -8)))
            (if (i32.gt_u (local.get $newHeap) (i32.mul (memory.size) (i32.const 65536)))
              (then (if (i32.eq (memory.grow
                (i32.shr_u (i32.add (i32.sub (local.get $newHeap) (i32.mul (memory.size) (i32.const 65536))) (i32.const 65535)) (i32.const 16)))
                (i32.const -1)) (then (unreachable)))))
            (i32.store8 (i32.add (local.get $aoff) (local.get $alen)) (local.get $byte))
            (i32.store (i32.sub (local.get $aoff) (i32.const 4)) (i32.add (local.get $alen) (i32.const 1)))
            (global.set $__heap (local.get $newHeap))
            (return (f64.reinterpret_i64 (local.get $a)))))))` : ''}
    ;; SSO (STRING with SSO bit) with len < 4 and ASCII byte: pack into SSO without allocation
    (if (i32.and
          (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
          (i32.and
            (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const ${LAYOUT.AUX_SHIFT})))
            (i32.const ${LAYOUT.SSO_BIT})))
      (then
        (local.set $alen (i32.and
          (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const ${LAYOUT.AUX_SHIFT})))
          (i32.const ${LAYOUT.SSO_BIT - 1})))
        (if (i32.and
              (i32.lt_u (local.get $alen) (i32.const 4))
              (i32.lt_u (local.get $byte) (i32.const 0x80)))
          (then
            (return (call $__mkptr
              (i32.const ${PTR.STRING})
              (i32.or (i32.const ${LAYOUT.SSO_BIT}) (i32.add (local.get $alen) (i32.const 1)))
              (i32.or
                (local.get $aoff)
                (i32.shl (local.get $byte) (i32.shl (local.get $alen) (i32.const 3))))))))))
    ;; Slow path: allocate new heap STRING with original bytes + 1 new byte
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $total (i32.add (local.get $alen) (i32.const 1)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $total))))
    (i32.store (local.get $off) (local.get $total))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (call $__str_copy (local.get $a) (local.get $off) (local.get $alen))
    (i32.store8 (i32.add (local.get $off) (local.get $alen)) (local.get $byte))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  ctx.core.stdlib['__str_concat'] = `(func $__str_concat (param $a i64) (param $b i64) (result f64)
    (local $alen i32) (local $blen i32) (local $total i32) (local $off i32)
    (local $ta i32) (local $aoff i32) (local $newHeap i32)
    ;; Coerce operands to strings if needed
    (local.set $a (call $__to_str (local.get $a)))
    (local.set $b (call $__to_str (local.get $b)))
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $blen (call $__str_byteLen (local.get $b)))
    (local.set $total (i32.add (local.get $alen) (local.get $blen)))
    (if (i32.eqz (local.get $total))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    ${concatFast}
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $total))))
    (i32.store (local.get $off) (local.get $total))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (call $__str_copy (local.get $a) (local.get $off) (local.get $alen))
    (call $__str_copy (local.get $b) (i32.add (local.get $off) (local.get $alen)) (local.get $blen))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  ctx.core.stdlib['__str_concat_raw'] = `(func $__str_concat_raw (param $a i64) (param $b i64) (result f64)
    (local $alen i32) (local $blen i32) (local $total i32) (local $off i32)
    (local $ta i32) (local $aoff i32) (local $newHeap i32)
    (local.set $alen (call $__str_byteLen (local.get $a)))
    (local.set $blen (call $__str_byteLen (local.get $b)))
    (local.set $total (i32.add (local.get $alen) (local.get $blen)))
    (if (i32.eqz (local.get $total))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    ${concatFast}
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $total))))
    (i32.store (local.get $off) (local.get $total))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (call $__str_copy (local.get $a) (local.get $off) (local.get $alen))
    (call $__str_copy (local.get $b) (i32.add (local.get $off) (local.get $alen)) (local.get $blen))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  ctx.core.stdlib['__str_replace'] = `(func $__str_replace (param $str i64) (param $search i64) (param $repl i64) (result f64)
    (local $idx i32) (local $slen i32)
    (local.set $idx (call $__str_indexof (local.get $str) (local.get $search) (i32.const 0)))
    (if (result f64) (i32.lt_s (local.get $idx) (i32.const 0))
      (then (f64.reinterpret_i64 (local.get $str)))
      (else
        (local.set $slen (call $__str_byteLen (local.get $search)))
        (call $__str_concat
          (i64.reinterpret_f64 (call $__str_concat
            (i64.reinterpret_f64 (call $__str_slice (local.get $str) (i32.const 0) (local.get $idx)))
            (local.get $repl)))
          (i64.reinterpret_f64 (call $__str_slice (local.get $str) (i32.add (local.get $idx) (local.get $slen))
            (call $__str_byteLen (local.get $str))))))))`

  ctx.core.stdlib['__str_replaceall'] = `(func $__str_replaceall (param $str i64) (param $search i64) (param $repl i64) (result f64)
    (local $idx i32) (local $slen i32) (local $pos i32) (local $result i64)
    (local.set $slen (call $__str_byteLen (local.get $search)))
    (local.set $result (local.get $str))
    (local.set $pos (i32.const 0))
    (block $done (loop $next
      (local.set $idx (call $__str_indexof (local.get $result) (local.get $search) (local.get $pos)))
      (br_if $done (i32.lt_s (local.get $idx) (i32.const 0)))
      (local.set $result (i64.reinterpret_f64 (call $__str_concat
        (i64.reinterpret_f64 (call $__str_concat
          (i64.reinterpret_f64 (call $__str_slice (local.get $result) (i32.const 0) (local.get $idx)))
          (local.get $repl)))
        (i64.reinterpret_f64 (call $__str_slice (local.get $result) (i32.add (local.get $idx) (local.get $slen))
          (call $__str_byteLen (local.get $result)))))))
      (local.set $pos (i32.add (local.get $idx) (call $__str_byteLen (local.get $repl))))
      (br $next)))
    (f64.reinterpret_i64 (local.get $result)))`

  // Empty separator: per JS spec, split into individual byte-chars
  // ("abc".split("") -> ["a","b","c"], "".split("") -> []). Without this
  // guard the main loop advances by plen=0 and spins forever.
  ctx.core.stdlib['__str_split'] = `(func $__str_split (param $str i64) (param $sep i64) (result f64)
    (local $slen i32) (local $plen i32) (local $count i32)
    (local $i i32) (local $j i32) (local $match i32)
    (local $arr i32) (local $piece_start i32) (local $piece_idx i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (local.set $plen (call $__str_byteLen (local.get $sep)))
    (if (i32.eqz (local.get $plen)) (then
      (local.set $arr (call $__alloc (i32.add (i32.const 8) (i32.shl (local.get $slen) (i32.const 3)))))
      (i32.store (local.get $arr) (local.get $slen))
      (i32.store (i32.add (local.get $arr) (i32.const 4)) (local.get $slen))
      (local.set $arr (i32.add (local.get $arr) (i32.const 8)))
      (block $de (loop $le
        (br_if $de (i32.ge_s (local.get $i) (local.get $slen)))
        (f64.store (i32.add (local.get $arr) (i32.shl (local.get $i) (i32.const 3)))
          (call $__str_slice (local.get $str) (local.get $i) (i32.add (local.get $i) (i32.const 1))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $le)))
      (return (call $__mkptr (i32.const 1) (i32.const 0) (local.get $arr)))))
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

  ctx.core.stdlib['__str_join'] = `(func $__str_join (param $arr i64) (param $sep i64) (result f64)
    (local $off i32) (local $len i32) (local $i i32) (local $result f64)
    (local.set $off (call $__ptr_offset (local.get $arr)))
    (local.set $len (call $__len (local.get $arr)))
    (if (i32.eqz (local.get $len))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $result (f64.reinterpret_i64 (call $__to_str (i64.load (local.get $off)))))
    (local.set $i (i32.const 1))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $result (call $__str_concat (i64.reinterpret_f64 (local.get $result)) (local.get $sep)))
      (local.set $result (call $__str_concat (i64.reinterpret_f64 (local.get $result))
        (i64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $result))`

  // Source string copied via __str_copy (handles SSO/heap with memory.copy where possible).
  // Pad fill loops a single tile of pad bytes — hoist pad dispatch out of the byte loop.
  ctx.core.stdlib['__str_pad'] = `(func $__str_pad (param $str i64) (param $target i32) (param $pad i64) (param $before i32) (result f64)
    (local $slen i32) (local $plen i32) (local $fill i32) (local $off i32) (local $i i32)
    (local $str_off i32) (local $pad_off i32)
    (local $pbits i64) (local $poff i32) (local $psso i32)
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (if (i32.ge_s (local.get $slen) (local.get $target))
      (then (return (f64.reinterpret_i64 (local.get $str)))))
    (local.set $plen (call $__str_byteLen (local.get $pad)))
    (local.set $fill (i32.sub (local.get $target) (local.get $slen)))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $target))))
    (i32.store (local.get $off) (local.get $target))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (local.set $str_off (select (local.get $fill) (i32.const 0) (local.get $before)))
    (local.set $pad_off (select (i32.const 0) (local.get $slen) (local.get $before)))
    (call $__str_copy (local.get $str) (i32.add (local.get $off) (local.get $str_off)) (local.get $slen))
    (local.set $pbits (local.get $pad))
    (local.set $poff (i32.wrap_i64 (i64.and (local.get $pbits) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $psso (i32.and
      (i32.wrap_i64 (i64.shr_u (local.get $pbits) (i64.const ${LAYOUT.AUX_SHIFT})))
      (i32.const ${LAYOUT.SSO_BIT})))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_s (local.get $i) (local.get $fill)))
      (i32.store8 (i32.add (local.get $off) (i32.add (local.get $pad_off) (local.get $i)))
        (if (result i32) (local.get $psso)
          (then (i32.and
            (i32.shr_u (local.get $poff) (i32.shl (i32.rem_u (local.get $i) (local.get $plen)) (i32.const 3)))
            (i32.const 0xFF)))
          (else (i32.load8_u (i32.add (local.get $poff) (i32.rem_u (local.get $i) (local.get $plen)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  // Base helpers (__sso_char/__str_char/__char_at/__str_byteLen) are referenced
  // from other helpers' WAT bodies and from emit sites; their `stdlibDeps`
  // entries pull them transitively when actually used. No unconditional inc.

  // === Method emitters ===

  // Type-qualified (collide with array: slice, indexOf, includes)
  // String.prototype.toString / .valueOf — both return the receiver per spec
  // (21.1.3.27/28). Typed forms cover the static-string case; generic forms
  // pair with them so the dispatcher can pick a runtime ptr-type branch when
  // the receiver type can't be statically inferred (e.g. a callback param).
  ctx.core.emit['.string:toString'] = (str) => asF64(emit(str))
  ctx.core.emit['.string:valueOf'] = (str) => asF64(emit(str))
  ctx.core.emit['.toString'] = (val) => {
    inc('__to_str')
    return typed(['f64.reinterpret_i64', ['call', '$__to_str', asI64(emit(val))]], 'f64')
  }
  // Object.prototype.valueOf returns the receiver (per ES2024 20.1.3.7).
  // Array/Object inherit this; only primitive wrappers (Number/Boolean/String)
  // override to return the primitive — strings already covered by .string:valueOf.
  ctx.core.emit['.valueOf'] = (val) => asF64(emit(val))

  ctx.core.emit['.string:slice'] = (str, start, end) => {
    inc('__str_slice')
    const startIR = start == null ? ['i32.const', 0] : asI32(emit(start))
    if (end != null) return typed(['call', '$__str_slice', asI64(emit(str)), startIR, asI32(emit(end))], 'f64')
    const t = temp('t')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(str))],
      ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${t}`]], startIR,
        ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]], 'f64')
  }

  ctx.core.emit['.string:indexOf'] = (str, search, from) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s', ['call', '$__str_indexof', asI64(emit(str)), asI64(emit(search)), from ? asI32(emit(from)) : ['i32.const', 0]]], 'f64')
  }

  ctx.core.emit['.string:includes'] = (str, search) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s',
      ['i32.ge_s', ['call', '$__str_indexof', asI64(emit(str)), asI64(emit(search)), ['i32.const', 0]], ['i32.const', 0]]], 'f64')
  }

  // Generic (no collision)
  ctx.core.emit['.substring'] = (str, start, end) => {
    inc('__str_substring')
    if (end != null) return typed(['call', '$__str_substring', asI64(emit(str)), asI32(emit(start)), asI32(emit(end))], 'f64')
    const t = temp('t')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(emit(str))],
      ['call', '$__str_substring', ['i64.reinterpret_f64', ['local.get', `$${t}`]], asI32(emit(start)),
        ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]]], 'f64')
  }

  // Factory for simple str→call patterns: [emitKey, stdlibName, argCoercions, i32Result?]
  const coerce = { f: asF64, i: asI32 }
  const strMethod = (name, args, i32Result) => (str, ...params) => {
    inc(name)
    const call = ['call', `$${name}`, asF64(emit(str)), ...params.map((p, i) => coerce[args[i]](emit(p)))]
    return typed(i32Result ? ['f64.convert_i32_s', call] : call, 'f64')
  }

  // Search args go through ToString per spec — coerce non-string-typed args
  // via __to_str so the underlying byte-compare receives an actual string.
  const stringSearchMethod = (name) => (str, sfx) => {
    inc(name)
    let sfxArg = asI64(emit(sfx))
    if (valTypeOf(sfx) !== VAL.STRING) {
      inc('__to_str')
      sfxArg = ['call', '$__to_str', sfxArg]
    }
    return typed(['f64.convert_i32_s', ['call', `$${name}`, asI64(emit(str)), sfxArg]], 'f64')
  }
  ctx.core.emit['.startsWith'] = stringSearchMethod('__str_startswith')
  ctx.core.emit['.endsWith'] = stringSearchMethod('__str_endswith')
  ctx.core.emit['.trim'] = (str) => (inc('__str_trim'),
    typed(['call', '$__str_trim', asI64(emit(str))], 'f64'))
  ctx.core.emit['.trimStart'] = (str) => (inc('__str_trimStart'),
    typed(['call', '$__str_trimStart', asI64(emit(str))], 'f64'))
  ctx.core.emit['.trimEnd'] = (str) => (inc('__str_trimEnd'),
    typed(['call', '$__str_trimEnd', asI64(emit(str))], 'f64'))
  ctx.core.emit['.repeat'] = (str, n) => (inc('__str_repeat'),
    typed(['call', '$__str_repeat', asI64(emit(str)), asI32(emit(n))], 'f64'))
  ctx.core.emit['.split'] = (str, sep) => (inc('__str_split'),
    typed(['call', '$__str_split', asI64(emit(str)), asI64(emit(sep))], 'f64'))
  ctx.core.emit['.replace'] = (str, search, repl) => (inc('__str_replace'),
    typed(['call', '$__str_replace', asI64(emit(str)), asI64(emit(search)), asI64(emit(repl))], 'f64'))
  ctx.core.emit['.replaceAll'] = (str, search, repl) => (inc('__str_replaceall'),
    typed(['call', '$__str_replaceall', asI64(emit(str)), asI64(emit(search)), asI64(emit(repl))], 'f64'))

  ctx.core.emit['.toUpperCase'] = (str) => {
    inc('__str_case')
    return typed(['call', '$__str_case', asI64(emit(str)), ['i32.const', 97], ['i32.const', 122], ['i32.const', -32]], 'f64')
  }

  ctx.core.emit['.toLowerCase'] = (str) => {
    inc('__str_case')
    return typed(['call', '$__str_case', asI64(emit(str)), ['i32.const', 65], ['i32.const', 90], ['i32.const', 32]], 'f64')
  }

  // Locale-specific casing needs ICU/CLDR data. jz intentionally has no
  // runtime, so this follows the existing ASCII-only lowercase helper and
  // ignores optional locale arguments.
  ctx.core.emit['.toLocaleLowerCase'] = ctx.core.emit['.toLowerCase']

  // Byte-wise variant of String.prototype.localeCompare. Returns -1/0/1 from
  // an unsigned byte-by-byte compare with shorter-string-sorts-first tiebreak.
  // NOT locale-aware: real localeCompare is ICU-driven (CLDR collation, case
  // folding, accent ordering). For ASCII inputs the byte-wise result matches
  // the spec exactly; for non-ASCII it follows UTF-8 byte order, which is
  // codepoint order for well-formed strings — close enough for sort-stability
  // use cases, wrong for human-language collation.
  ctx.core.emit['.localeCompare'] = (str, other) => {
    inc('__str_cmp')
    return typed(['f64.convert_i32_s', ['call', '$__str_cmp', asI64(emit(str)), asI64(emit(other))]], 'f64')
  }

  ctx.core.emit['.string:concat'] = (str, ...others) => {
    inc('__str_concat')
    let result = asF64(emit(str))
    for (const other of others) result = typed(['call', '$__str_concat', ['i64.reinterpret_f64', result], asI64(emit(other))], 'f64')
    return result
  }

  ctx.core.emit['strcat'] = (...parts) => {
    inc('__to_str', '__str_byteLen', '__alloc', '__mkptr', '__str_copy')
    if (!parts.length) return mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT, 0)
    if (parts.length === 1) return typed(['f64.reinterpret_i64', ['call', '$__to_str', asI64(emit(parts[0]))]], 'f64')

    const vals = parts.map(() => temp('s'))
    const lens = parts.map(() => tempI32('sl'))
    const total = tempI32('st')
    const off = tempI32('so')
    const dst = tempI32('sd')
    const ir = []

    for (let i = 0; i < parts.length; i++) {
      ir.push(['local.set', `$${vals[i]}`, ['f64.reinterpret_i64', ['call', '$__to_str', asI64(emit(parts[i]))]]])
      ir.push(['local.set', `$${lens[i]}`, ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${vals[i]}`]]]])
    }
    ir.push(['local.set', `$${total}`, ['i32.const', 0]])
    for (const len of lens)
      ir.push(['local.set', `$${total}`, ['i32.add', ['local.get', `$${total}`], ['local.get', `$${len}`]]])
    const alloc = [
      ['local.set', `$${off}`, ['call', '$__alloc', ['i32.add', ['i32.const', 4], ['local.get', `$${total}`]]]],
      ['i32.store', ['local.get', `$${off}`], ['local.get', `$${total}`]],
      ['local.set', `$${off}`, ['i32.add', ['local.get', `$${off}`], ['i32.const', 4]]],
      ['local.set', `$${dst}`, ['local.get', `$${off}`]],
    ]
    for (let i = 0; i < parts.length; i++) {
      alloc.push(['call', '$__str_copy', ['i64.reinterpret_f64', ['local.get', `$${vals[i]}`]], ['local.get', `$${dst}`], ['local.get', `$${lens[i]}`]])
      alloc.push(['local.set', `$${dst}`, ['i32.add', ['local.get', `$${dst}`], ['local.get', `$${lens[i]}`]]])
    }
    alloc.push(['call', '$__mkptr', ['i32.const', PTR.STRING], ['i32.const', 0], ['local.get', `$${off}`]])
    ir.push(['if', ['result', 'f64'], ['i32.eqz', ['local.get', `$${total}`]],
      ['then', mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT, 0)],
      ['else', ['block', ['result', 'f64'], ...alloc]]])
    return typed(['block', ['result', 'f64'], ...ir], 'f64')
  }

  ctx.core.emit['.padStart'] = (str, len, pad) => {
    inc('__str_pad')
    const vpad = pad != null ? asI64(emit(pad)) : ['i64.reinterpret_f64', mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT | 1, 32)]
    return typed(['call', '$__str_pad', asI64(emit(str)), asI32(emit(len)), vpad, ['i32.const', 1]], 'f64')
  }

  ctx.core.emit['.padEnd'] = (str, len, pad) => {
    inc('__str_pad')
    const vpad = pad != null ? asI64(emit(pad)) : ['i64.reinterpret_f64', mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT | 1, 32)]
    return typed(['call', '$__str_pad', asI64(emit(str)), asI32(emit(len)), vpad, ['i32.const', 0]], 'f64')
  }

  // .charAt(i) → 1-char string from char code at index i
  ctx.core.emit['.charAt'] = (str, idx) => {
    inc('__char_at')
    const t = tempI32('ch')
    // Get char code, create SSO string with 1 byte
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__char_at', asI64(emit(str)), asI32(emit(idx))]],
      mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT | 1, ['local.get', `$${t}`])], 'f64')
  }

  // .charCodeAt(i) → integer char code (0..255 for ASCII bytes — unsigned, always
  // representable as i32). Returning i32 directly lets `let c = s.charCodeAt(i)`
  // stay on the i32 ABI: chained comparisons (`c >= 48 && c <= 57`), bit-ops, and
  // `c - 48` arithmetic skip the per-iteration f64 widen + i32 trunc round-trip.
  ctx.core.emit['.charCodeAt'] = (str, idx) => {
    inc('__char_at')
    return typed(['call', '$__char_at', asI64(emit(str)), asI32(emit(idx))], 'i32')
  }

  // String.fromCharCode(code) → 1-char SSO string
  ctx.core.emit['String'] = (value) => {
    if (value === undefined) return emit(['str', ''])
    if (valTypeOf(value) === VAL.STRING) return emit(value)
    if (valTypeOf(value) === VAL.NUMBER) {
      inc('__ftoa')
      return typed(['call', '$__ftoa', asF64(emit(value)), ['i32.const', 0], ['i32.const', 0]], 'f64')
    }
    inc('__to_str')
    return typed(['f64.reinterpret_i64', ['call', '$__to_str', asI64(emit(value))]], 'f64')
  }

  ctx.core.emit['String.fromCharCode'] = (code) => {
    if (code === undefined) return emit(['str', ''])
    return mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT | 1, asI32(emit(code)))
  }

  // String.fromCodePoint(cp) → UTF-8 encoded string
  ctx.core.stdlib['__fromCodePoint'] = `(func $__fromCodePoint (param $cp i32) (result f64)
    (local $off i32) (local $len i32)
    ;; ASCII: 1 byte SSO
    (if (i32.lt_u (local.get $cp) (i32.const 128))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT | 1}) (local.get $cp)))))
    ;; 2-byte: 0x80-0x7FF → SSO
    (if (i32.lt_u (local.get $cp) (i32.const 0x800))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT | 2})
        (i32.or
          (i32.or (i32.const 0xC0) (i32.shr_u (local.get $cp) (i32.const 6)))
          (i32.shl (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))) (i32.const 8)))))))
    ;; 3-byte: 0x800-0xFFFF → SSO (3 bytes fits)
    (if (i32.lt_u (local.get $cp) (i32.const 0x10000))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT | 3})
        (i32.or (i32.or
          (i32.or (i32.const 0xE0) (i32.shr_u (local.get $cp) (i32.const 12)))
          (i32.shl (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))) (i32.const 8)))
          (i32.shl (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))) (i32.const 16)))))))
    ;; 4-byte: 0x10000-0x10FFFF → SSO (4 bytes fits)
    (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT | 4})
      (i32.or (i32.or (i32.or
        (i32.or (i32.const 0xF0) (i32.shr_u (local.get $cp) (i32.const 18)))
        (i32.shl (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 12)) (i32.const 0x3F))) (i32.const 8)))
        (i32.shl (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))) (i32.const 16)))
        (i32.shl (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))) (i32.const 24))))))`

  ctx.core.emit['String.fromCodePoint'] = (code) => {
    if (code === undefined) return emit(['str', ''])
    inc('__fromCodePoint')
    return typed(['call', '$__fromCodePoint', asI32(emit(code))], 'f64')
  }

  // .at(i) → charAt with negative index support
  ctx.core.emit['.string:at'] = (str, idx) => {
    inc('__char_at', '__str_byteLen')
    const t = tempI32('at'), s = temp('as')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${t}`, asI32(emit(idx))],
      // Negative index: t += length
      ['if', ['i32.lt_s', ['local.get', `$${t}`], ['i32.const', 0]],
        ['then', ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`],
          ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${s}`]]]]]]],
      mkPtrIR(PTR.STRING, LAYOUT.SSO_BIT | 1, ['call', '$__char_at', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['local.get', `$${t}`]])], 'f64')
  }

  // .search(str) → indexOf (same as indexOf for string args)
  ctx.core.emit['.search'] = (str, search) => {
    inc('__str_indexof')
    return typed(['f64.convert_i32_s', ['call', '$__str_indexof', asI64(emit(str)), asI64(emit(search)), ['i32.const', 0]]], 'f64')
  }

  // .match(str) → [match] array if found, or 0 (null) if not
  // For string args, returns single-element array with the matched substring
  ctx.core.emit['.match'] = (str, search) => {
    inc('__str_indexof', '__str_slice', '__wrap1')
    const s = temp('ms'), q = temp('mq'), idx = tempI32('mi')
    // indexOf, then if >= 0, create 1-element array with the match slice
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${s}`, asF64(emit(str))],
      ['local.set', `$${q}`, asF64(emit(search))],
      ['local.set', `$${idx}`, ['call', '$__str_indexof', ['i64.reinterpret_f64', ['local.get', `$${s}`]], ['i64.reinterpret_f64', ['local.get', `$${q}`]], ['i32.const', 0]]],
      ['if', ['result', 'f64'], ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]],
        ['then', ['f64.const', 0]],  // null
        ['else',
          // Build 1-element array containing the search string
          ['call', '$__wrap1',
            ['i64.reinterpret_f64',
              ['call', '$__str_slice', ['i64.reinterpret_f64', ['local.get', `$${s}`]],
                ['local.get', `$${idx}`],
                ['i32.add', ['local.get', `$${idx}`], ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${q}`]]]]]]]]]], 'f64')
  }

  // __wrap1(val: i64) → f64 — create 1-element array [val]
  ctx.core.stdlib['__wrap1'] = `(func $__wrap1 (param $val i64) (result f64)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.const 16)))
    (i32.store (local.get $ptr) (i32.const 1))
    (i32.store (i32.add (local.get $ptr) (i32.const 4)) (i32.const 1))
    (i64.store (i32.add (local.get $ptr) (i32.const 8)) (local.get $val))
    (call $__mkptr (i32.const 1) (i32.const 0) (i32.add (local.get $ptr) (i32.const 8))))`

  // TextEncoder() / TextDecoder() → dummy values (methods do the work)
  ctx.core.emit['TextEncoder'] = () => typed(['f64.const', 1], 'f64')
  ctx.core.emit['TextDecoder'] = () => typed(['f64.const', 2], 'f64')

  // .encode(str) → Uint8Array of string's UTF-8 bytes
  // Copies bytes from string (SSO or heap) into a new Uint8Array
  ctx.core.stdlib['__str_encode'] = `(func $__str_encode (param $str i64) (result f64)
    (local $len i32) (local $dst i32)
    (local.set $len (call $__str_byteLen (local.get $str)))
    (local.set $dst (call $__alloc (i32.add (i32.const 8) (local.get $len))))
    (i32.store (local.get $dst) (local.get $len))
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (local.get $len))
    (local.set $dst (i32.add (local.get $dst) (i32.const 8)))
    (call $__str_copy (local.get $str) (local.get $dst) (local.get $len))
    (call $__mkptr (i32.const 3) (i32.const 1) (local.get $dst)))`

  ctx.core.emit['.encode'] = (obj, str) => {
    inc('__str_encode')
    return typed(['call', '$__str_encode', asI64(emit(str))], 'f64')
  }

  // .decode(uint8arr) → string from byte data
  ctx.core.stdlib['__bytes_decode'] = `(func $__bytes_decode (param $arr i64) (result f64)
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
    return typed(['call', '$__bytes_decode', asI64(emit(arr))], 'f64')
  }
}
