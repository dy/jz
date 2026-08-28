/**
 * URI percent-encoding — encodeURIComponent/encodeURI/decodeURIComponent/
 * decodeURI (ECMA-262 19.2.2-19.2.5). Pure move from module/string.js
 * (pipeline-minimality): every name below is used only within this file;
 * `__uri_hex` is also called at the WASM level from string/base64.js's
 * `__hex_dec_raw` (a `call $__uri_hex` inside a WAT template string, not a
 * JS reference — name-keyed stdlib registration, no import needed either
 * direction).
 *
 * @module string/uri
 */
import { typed, asI64, UNDEF_NAN } from '../../src/ir.js'
import { emit, wat, bind } from '../../src/bridge.js'
import { valTypeOf } from '../../src/kind.js'
import { VAL } from '../../src/reps.js'
import { ctx, inc, PTR, LAYOUT, err } from '../../src/ctx.js'
import { ERR } from '../../err-codes.js'

export const registerUri = () => {
  // Percent-codec char classes (ECMA-262 19.2.2–19.2.5). Both encoders share one
  // loop shape and differ only in the always-unescaped set: encodeURIComponent
  // passes only the unreserved marks; encodeURI additionally leaves the URI
  // reserved set `; / ? : @ & = + $ , #` intact. Same split decoding: decode-
  // URIComponent decodes every escape, decodeURI copies the original `%XX`
  // triplet through for reserved bytes (case-preserving). Generated kernels —
  // the unused variant dead-strips like any stdlib body.
  const URI_RESERVED = [59, 47, 63, 58, 64, 38, 61, 43, 36, 44, 35] // ; / ? : @ & = + $ , #
  const uriReservedTest = URI_RESERVED
    .map(c => `(i32.eq (local.get $c) (i32.const ${c}))`)
    .reduce((a, b) => `(i32.or ${a} ${b})`)
  const uriSafeTest = `(i32.or
            (i32.or
              (i32.or
                (i32.and (i32.ge_u (local.get $c) (i32.const 65)) (i32.le_u (local.get $c) (i32.const 90)))
                (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 122))))
              (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57))))
            (i32.or
              (i32.or
                (i32.or (i32.eq (local.get $c) (i32.const 45)) (i32.eq (local.get $c) (i32.const 95)))
                (i32.or (i32.eq (local.get $c) (i32.const 46)) (i32.eq (local.get $c) (i32.const 33))))
              (i32.or
                (i32.or (i32.eq (local.get $c) (i32.const 126)) (i32.eq (local.get $c) (i32.const 42)))
                (i32.or
                  (i32.eq (local.get $c) (i32.const 39))
                  (i32.or (i32.eq (local.get $c) (i32.const 40)) (i32.eq (local.get $c) (i32.const 41)))))))`

  const uriEncodeKernel = (name, keepReserved) => `(func $${name} (param $val i64) (result f64)
    (local $str i64) (local $slen i32) (local $base i32) (local $out i32)
    (local $i i32) (local $j i32) (local $c i32) (local $hi i32) (local $lo i32)
    (local.set $str (call $__to_str (local.get $val)))
    (local.set $slen (call $__str_byteLen (local.get $str)))
    (if (i32.eqz (local.get $slen))
      (then (return (call $__mkptr (i32.const ${PTR.STRING}) (i32.const ${LAYOUT.SSO_BIT}) (i32.const 0)))))
    (local.set $base (call $__alloc (i32.add (i32.const 4) (i32.mul (local.get $slen) (i32.const 3)))))
    (local.set $out (i32.add (local.get $base) (i32.const 4)))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $slen)))
      (local.set $c (call $__char_at (local.get $str) (local.get $i)))
      (if ${keepReserved ? `(i32.or ${uriSafeTest} ${uriReservedTest})` : uriSafeTest}
        (then
          (i32.store8 (i32.add (local.get $out) (local.get $j)) (local.get $c))
          (local.set $j (i32.add (local.get $j) (i32.const 1))))
        (else
          (local.set $hi (i32.shr_u (local.get $c) (i32.const 4)))
          (local.set $lo (i32.and (local.get $c) (i32.const 15)))
          (i32.store8 (i32.add (local.get $out) (local.get $j)) (i32.const 37))
          (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 1)))
            (i32.add (local.get $hi) (select (i32.const 55) (i32.const 48) (i32.gt_u (local.get $hi) (i32.const 9)))))
          (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 2)))
            (i32.add (local.get $lo) (select (i32.const 55) (i32.const 48) (i32.gt_u (local.get $lo) (i32.const 9)))))
          (local.set $j (i32.add (local.get $j) (i32.const 3)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.store (local.get $base) (local.get $j))
    (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $out))))`

  wat('__encodeURIComponent', uriEncodeKernel('__encodeURIComponent', false))
  wat('__encodeURI', uriEncodeKernel('__encodeURI', true))

  const uriEncodeBind = (kernel) => (value) => {
    inc(kernel)
    // ToPrimitive on an OBJECT argument needs a dynamic valueOf/toString call
    // jz's stdlib coercion layer doesn't have (see module/number.js's
    // rejectObjectArg for the same class, in the same words) — confirmed live:
    // encodeURIComponent({toString:()=>"a b"}) silently returned "" instead of
    // calling toString and encoding "a%20b". Reject rather than misencode the
    // object's raw bits; string/number/boolean arguments are unaffected.
    if (valTypeOf(value) === VAL.OBJECT)
      err(`${kernel === '__encodeURI' ? 'encodeURI' : 'encodeURIComponent'}: an object argument (with valueOf/toString) is not supported — jz has no general ToPrimitive dynamic dispatch; call .valueOf()/.toString() (or String()) yourself before passing the result`)
    const input = value === undefined ? ['i64.const', UNDEF_NAN] : asI64(emit(value))
    return typed(['call', `$${kernel}`, input], 'f64')
  }
  bind('encodeURIComponent', uriEncodeBind('__encodeURIComponent'))
  bind('encodeURI', uriEncodeBind('__encodeURI'))

  wat('__uri_hex', `(func $__uri_hex (param $c i32) (result i32)
    (if (result i32) (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57)))
      (then (i32.sub (local.get $c) (i32.const 48)))
      (else (if (result i32) (i32.and (i32.ge_u (local.get $c) (i32.const 65)) (i32.le_u (local.get $c) (i32.const 70)))
        (then (i32.sub (local.get $c) (i32.const 55)))
        (else (if (result i32) (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 102)))
          (then (i32.sub (local.get $c) (i32.const 87)))
          (else (i32.const -1))))))))`)

  // Reserved-byte passthrough for decodeURI: at this point $i still sits on the
  // `%`, the two hex chars are validated, and $c < 128 for every reserved code —
  // copy the ORIGINAL triplet (case-preserving per spec) and skip the store.
  const uriKeepReserved = `(if ${uriReservedTest} (then
            (i32.store8 (i32.add (local.get $dst) (local.get $outLen)) (i32.const 37))
            (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $outLen) (i32.const 1)))
              (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 1))))
            (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $outLen) (i32.const 2)))
              (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 2))))
            (local.set $outLen (i32.add (local.get $outLen) (i32.const 3)))
            (local.set $stored (i32.const 1))))`

  const uriDecodeKernel = (name, keepReserved) => `(func $${name} (param $v i64) (result f64)
    (local $s i64) (local $len i32) (local $i i32)
    (local $base i32) (local $dst i32) (local $outLen i32)
    (local $c i32) (local $hi i32) (local $lo i32)
    (local $b i32) (local $n i32) (local $j i32) (local $cp i32) (local $min i32) (local $stored i32)
    (local.set $s (call $__to_str (local.get $v)))
    (local.set $len (call $__str_byteLen (local.get $s)))
    (local.set $base (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (local.set $dst (i32.add (local.get $base) (i32.const 4)))
    (block $done (loop $loop
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $stored (i32.const 0))
      (local.set $c (call $__char_at (local.get $s) (local.get $i)))
      (if (i32.eq (local.get $c) (i32.const 37))
        (then
          (if (i32.ge_s (i32.add (local.get $i) (i32.const 2)) (local.get $len))
            (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.URI_TRUNC_ESCAPE}))) (throw $__jz_err (f64.const ${ERR.URI_TRUNC_ESCAPE}))))
          (local.set $hi (call $__uri_hex (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 1)))))
          (local.set $lo (call $__uri_hex (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 2)))))
          (if (i32.or (i32.lt_s (local.get $hi) (i32.const 0)) (i32.lt_s (local.get $lo) (i32.const 0)))
            (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.URI_BAD_HEX}))) (throw $__jz_err (f64.const ${ERR.URI_BAD_HEX}))))
          (local.set $c (i32.or (i32.shl (local.get $hi) (i32.const 4)) (local.get $lo)))
          ${keepReserved ? uriKeepReserved : ''}
          (local.set $i (i32.add (local.get $i) (i32.const 3)))
          (if (i32.ge_u (local.get $c) (i32.const 128))
            (then
              (if (i32.and (i32.ge_u (local.get $c) (i32.const 0xC2)) (i32.le_u (local.get $c) (i32.const 0xDF)))
                (then
                  (local.set $n (i32.const 2))
                  (local.set $cp (i32.and (local.get $c) (i32.const 0x1F)))
                  (local.set $min (i32.const 0x80)))
                (else (if (i32.and (i32.ge_u (local.get $c) (i32.const 0xE0)) (i32.le_u (local.get $c) (i32.const 0xEF)))
                  (then
                    (local.set $n (i32.const 3))
                    (local.set $cp (i32.and (local.get $c) (i32.const 0x0F)))
                    (local.set $min (i32.const 0x800)))
                  (else (if (i32.and (i32.ge_u (local.get $c) (i32.const 0xF0)) (i32.le_u (local.get $c) (i32.const 0xF4)))
                    (then
                      (local.set $n (i32.const 4))
                      (local.set $cp (i32.and (local.get $c) (i32.const 0x07)))
                      (local.set $min (i32.const 0x10000)))
                    (else (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.URI_BAD_LEAD_BYTE}))) (throw $__jz_err (f64.const ${ERR.URI_BAD_LEAD_BYTE}))))))))
              (i32.store8 (i32.add (local.get $dst) (local.get $outLen)) (local.get $c))
              (local.set $outLen (i32.add (local.get $outLen) (i32.const 1)))
              (local.set $j (i32.const 1))
              (block $seqDone (loop $seq
                (br_if $seqDone (i32.ge_s (local.get $j) (local.get $n)))
                (if (i32.ge_s (i32.add (local.get $i) (i32.const 2)) (local.get $len))
                  (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.URI_TRUNC_CONT_ESCAPE}))) (throw $__jz_err (f64.const ${ERR.URI_TRUNC_CONT_ESCAPE}))))
                (if (i32.ne (call $__char_at (local.get $s) (local.get $i)) (i32.const 37))
                  (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.URI_MISSING_CONT_PERCENT}))) (throw $__jz_err (f64.const ${ERR.URI_MISSING_CONT_PERCENT}))))
                (local.set $hi (call $__uri_hex (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 1)))))
                (local.set $lo (call $__uri_hex (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 2)))))
                (if (i32.or (i32.lt_s (local.get $hi) (i32.const 0)) (i32.lt_s (local.get $lo) (i32.const 0)))
                  (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.URI_BAD_CONT_HEX}))) (throw $__jz_err (f64.const ${ERR.URI_BAD_CONT_HEX}))))
                (local.set $b (i32.or (i32.shl (local.get $hi) (i32.const 4)) (local.get $lo)))
                (if (i32.or (i32.lt_u (local.get $b) (i32.const 0x80)) (i32.gt_u (local.get $b) (i32.const 0xBF)))
                  (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.URI_BAD_CONT_BYTE}))) (throw $__jz_err (f64.const ${ERR.URI_BAD_CONT_BYTE}))))
                (local.set $cp (i32.or (i32.shl (local.get $cp) (i32.const 6)) (i32.and (local.get $b) (i32.const 0x3F))))
                (i32.store8 (i32.add (local.get $dst) (local.get $outLen)) (local.get $b))
                (local.set $outLen (i32.add (local.get $outLen) (i32.const 1)))
                (local.set $i (i32.add (local.get $i) (i32.const 3)))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $seq)))
              (if (i32.or
                    (i32.or (i32.lt_u (local.get $cp) (local.get $min)) (i32.gt_u (local.get $cp) (i32.const 0x10FFFF)))
                    (i32.and (i32.ge_u (local.get $cp) (i32.const 0xD800)) (i32.le_u (local.get $cp) (i32.const 0xDFFF))))
                (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.URI_BAD_CODEPOINT}))) (throw $__jz_err (f64.const ${ERR.URI_BAD_CODEPOINT}))))
              (local.set $stored (i32.const 1)))))
        (else
          (local.set $i (i32.add (local.get $i) (i32.const 1)))))
      (if (i32.eqz (local.get $stored))
        (then
          (i32.store8 (i32.add (local.get $dst) (local.get $outLen)) (local.get $c))
          (local.set $outLen (i32.add (local.get $outLen) (i32.const 1)))))
      (br $loop)))
    (i32.store (local.get $base) (local.get $outLen))
    (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $dst))))`

  wat('__decodeURIComponent', uriDecodeKernel('__decodeURIComponent', false))
  wat('__decodeURI', uriDecodeKernel('__decodeURI', true))

  const uriDecodeBind = (kernel) => (value) => {
    ctx.runtime.throws = true
    inc(kernel)
    return typed(['call', `$${kernel}`,
      value === undefined ? ['i64.const', UNDEF_NAN] : asI64(emit(value))], 'f64')
  }
  bind('decodeURIComponent', uriDecodeBind('__decodeURIComponent'))
  bind('decodeURI', uriDecodeBind('__decodeURI'))
}
