/**
 * base64 / hex codecs — atob/btoa plus the Uint8Array.fromBase64/toBase64/
 * fromHex/toHex/setFrom* runtime primitives (typedarray.js's emitters call
 * these by name via `inc(name)`, a stdlib dependency string, not a JS
 * import). Pure move from module/string.js (pipeline-minimality).
 *
 * @module string/base64
 */
import { typed, asI64, UNDEF_NAN } from '../../src/ir.js'
import { emit, wat, bind } from '../../src/bridge.js'
import { ctx, inc, PTR } from '../../src/ctx.js'
import { ERR } from '../../err-codes.js'

export const registerBase64 = () => {
  // === base64 / hex codecs ===
  // One encode loop and one decode loop serve the whole family: the ES2026
  // Uint8Array.fromBase64/toBase64/fromHex/toHex/setFrom* methods (emitters in
  // module/typedarray.js) and the legacy atob/btoa pair. Decode follows WHATWG
  // forgiving-base64 == TC39 lastChunkHandling:'loose': ASCII whitespace
  // skipped, padding optional but validated when present, len%4==1 rejected,
  // extra trailing bits ignored. Alphabet (std/url) and padding ride as i32
  // flags — resolved compile-time from literal options, so no per-call parsing.

  // put one 6-bit value ($v pre-masked) as a base64 char at $out+$j
  const b64put = (bits) => `(local.set $v (i32.and ${bits} (i32.const 63)))
      (i32.store8 (i32.add (local.get $out) (local.get $j))
        (select (i32.add (local.get $v) (i32.const 65))
          (select (i32.add (local.get $v) (i32.const 71))
            (select (i32.add (local.get $v) (i32.const -4))
              (select (select (i32.const 45) (i32.const 43) (local.get $url))
                      (select (i32.const 95) (i32.const 47) (local.get $url))
                      (i32.eq (local.get $v) (i32.const 62)))
              (i32.lt_u (local.get $v) (i32.const 62)))
            (i32.lt_u (local.get $v) (i32.const 52)))
          (i32.lt_u (local.get $v) (i32.const 26))))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))`

  wat('__b64_enc', `(func $__b64_enc (param $src i32) (param $len i32) (param $url i32) (param $pad i32) (result f64)
    (local $g3 i32) (local $rem i32) (local $outLen i32) (local $base i32) (local $out i32)
    (local $i i32) (local $j i32) (local $w i32) (local $v i32)
    (local.set $g3 (i32.mul (i32.div_u (local.get $len) (i32.const 3)) (i32.const 3)))
    (local.set $rem (i32.sub (local.get $len) (local.get $g3)))
    (local.set $outLen (i32.mul (i32.div_u (local.get $len) (i32.const 3)) (i32.const 4)))
    (if (local.get $rem)
      (then (local.set $outLen (i32.add (local.get $outLen)
        (select (i32.const 4) (i32.add (local.get $rem) (i32.const 1)) (local.get $pad))))))
    (local.set $base (call $__alloc (i32.add (i32.const 4) (local.get $outLen))))
    (local.set $out (i32.add (local.get $base) (i32.const 4)))
    (block $gdone (loop $gloop
      (br_if $gdone (i32.ge_u (local.get $i) (local.get $g3)))
      (local.set $w (i32.or (i32.or
        (i32.shl (i32.load8_u (i32.add (local.get $src) (local.get $i))) (i32.const 16))
        (i32.shl (i32.load8_u (i32.add (local.get $src) (i32.add (local.get $i) (i32.const 1)))) (i32.const 8)))
        (i32.load8_u (i32.add (local.get $src) (i32.add (local.get $i) (i32.const 2))))))
      ${b64put('(i32.shr_u (local.get $w) (i32.const 18))')}
      ${b64put('(i32.shr_u (local.get $w) (i32.const 12))')}
      ${b64put('(i32.shr_u (local.get $w) (i32.const 6))')}
      ${b64put('(local.get $w)')}
      (local.set $i (i32.add (local.get $i) (i32.const 3)))
      (br $gloop)))
    (if (i32.eq (local.get $rem) (i32.const 1))
      (then
        (local.set $w (i32.shl (i32.load8_u (i32.add (local.get $src) (local.get $i))) (i32.const 16)))
        ${b64put('(i32.shr_u (local.get $w) (i32.const 18))')}
        ${b64put('(i32.shr_u (local.get $w) (i32.const 12))')}
        (if (local.get $pad) (then
          (i32.store8 (i32.add (local.get $out) (local.get $j)) (i32.const 61))
          (i32.store8 (i32.add (local.get $out) (i32.add (local.get $j) (i32.const 1))) (i32.const 61))
          (local.set $j (i32.add (local.get $j) (i32.const 2)))))))
    (if (i32.eq (local.get $rem) (i32.const 2))
      (then
        (local.set $w (i32.or
          (i32.shl (i32.load8_u (i32.add (local.get $src) (local.get $i))) (i32.const 16))
          (i32.shl (i32.load8_u (i32.add (local.get $src) (i32.add (local.get $i) (i32.const 1)))) (i32.const 8))))
        ${b64put('(i32.shr_u (local.get $w) (i32.const 18))')}
        ${b64put('(i32.shr_u (local.get $w) (i32.const 12))')}
        ${b64put('(i32.shr_u (local.get $w) (i32.const 6))')}
        (if (local.get $pad) (then
          (i32.store8 (i32.add (local.get $out) (local.get $j)) (i32.const 61))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))))))
    (i32.store (local.get $base) (local.get $j))
    (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $out))))`)

  // Forgiving decode. Returns (read << 32) | written; read = chars consumed
  // (== full length unless the $cap byte budget stopped a chunk; then the
  // stopped chunk's start). Throws on: a non-alphabet char, len%4==1,
  // misplaced/unterminated padding, content after complete padding.
  wat('__b64_dec_raw', `(func $__b64_dec_raw (param $s i64) (param $dst i32) (param $cap i32) (param $url i32) (result i64)
    (local $slen i32) (local $i i32) (local $c i32) (local $v i32)
    (local $acc i32) (local $cnt i32) (local $pads i32) (local $done i32)
    (local $mark i32) (local $written i32) (local $stopped i32) (local $n i32)
    (local.set $slen (call $__str_byteLen (local.get $s)))
    (block $stop (loop $loop
      (br_if $stop (i32.ge_s (local.get $i) (local.get $slen)))
      (local.set $c (call $__char_at (local.get $s) (local.get $i)))
      ;; ASCII whitespace (tab LF FF CR space) skipped everywhere
      (if (i32.or
            (i32.or (i32.eq (local.get $c) (i32.const 9)) (i32.eq (local.get $c) (i32.const 10)))
            (i32.or
              (i32.or (i32.eq (local.get $c) (i32.const 12)) (i32.eq (local.get $c) (i32.const 13)))
              (i32.eq (local.get $c) (i32.const 32))))
        (then
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop)))
      ;; after complete padding only whitespace may follow
      (if (local.get $done) (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.BASE64_TRAILING_CHAR}))) (throw $__jz_err (f64.const ${ERR.BASE64_TRAILING_CHAR}))))
      (if (i32.eq (local.get $c) (i32.const 61)) ;; '='
        (then
          (if (i32.lt_s (local.get $cnt) (i32.const 2)) (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.BASE64_EARLY_PAD}))) (throw $__jz_err (f64.const ${ERR.BASE64_EARLY_PAD}))))
          (local.set $pads (i32.add (local.get $pads) (i32.const 1)))
          (if (i32.eq (i32.add (local.get $cnt) (local.get $pads)) (i32.const 4))
            (then ;; flush the padded partial chunk: 2 chars → 1 byte, 3 → 2
              (local.set $n (i32.sub (local.get $cnt) (i32.const 1)))
              (if (i32.gt_s (i32.add (local.get $written) (local.get $n)) (local.get $cap))
                (then (local.set $stopped (i32.const 1)) (br $stop)))
              (i32.store8 (i32.add (local.get $dst) (local.get $written))
                (i32.and (i32.shr_u (local.get $acc)
                  (select (i32.const 10) (i32.const 4) (i32.eq (local.get $cnt) (i32.const 3)))) (i32.const 255)))
              (if (i32.eq (local.get $cnt) (i32.const 3))
                (then (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $written) (i32.const 1)))
                  (i32.and (i32.shr_u (local.get $acc) (i32.const 2)) (i32.const 255)))))
              (local.set $written (i32.add (local.get $written) (local.get $n)))
              (local.set $mark (i32.add (local.get $i) (i32.const 1)))
              (local.set $cnt (i32.const 0))
              (local.set $acc (i32.const 0))
              (local.set $done (i32.const 1)))))
        (else
          ;; a value char while padding is open ("AB=C") is malformed
          (if (local.get $pads) (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.BASE64_CHAR_AFTER_PAD}))) (throw $__jz_err (f64.const ${ERR.BASE64_CHAR_AFTER_PAD}))))
          (local.set $v (i32.const -1))
          (if (i32.and (i32.ge_u (local.get $c) (i32.const 65)) (i32.le_u (local.get $c) (i32.const 90)))
            (then (local.set $v (i32.sub (local.get $c) (i32.const 65)))))
          (if (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 122)))
            (then (local.set $v (i32.sub (local.get $c) (i32.const 71)))))
          (if (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57)))
            (then (local.set $v (i32.add (local.get $c) (i32.const 4)))))
          (if (local.get $url)
            (then
              (if (i32.eq (local.get $c) (i32.const 45)) (then (local.set $v (i32.const 62))))
              (if (i32.eq (local.get $c) (i32.const 95)) (then (local.set $v (i32.const 63)))))
            (else
              (if (i32.eq (local.get $c) (i32.const 43)) (then (local.set $v (i32.const 62))))
              (if (i32.eq (local.get $c) (i32.const 47)) (then (local.set $v (i32.const 63))))))
          (if (i32.lt_s (local.get $v) (i32.const 0)) (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.BASE64_INVALID_CHAR}))) (throw $__jz_err (f64.const ${ERR.BASE64_INVALID_CHAR}))))
          (local.set $acc (i32.or (i32.shl (local.get $acc) (i32.const 6)) (local.get $v)))
          (local.set $cnt (i32.add (local.get $cnt) (i32.const 1)))
          (if (i32.eq (local.get $cnt) (i32.const 4))
            (then
              (if (i32.gt_s (i32.add (local.get $written) (i32.const 3)) (local.get $cap))
                (then (local.set $stopped (i32.const 1)) (br $stop)))
              (i32.store8 (i32.add (local.get $dst) (local.get $written))
                (i32.shr_u (local.get $acc) (i32.const 16)))
              (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $written) (i32.const 1)))
                (i32.and (i32.shr_u (local.get $acc) (i32.const 8)) (i32.const 255)))
              (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $written) (i32.const 2)))
                (i32.and (local.get $acc) (i32.const 255)))
              (local.set $written (i32.add (local.get $written) (i32.const 3)))
              (local.set $mark (i32.add (local.get $i) (i32.const 1)))
              (local.set $cnt (i32.const 0))
              (local.set $acc (i32.const 0))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    ;; EOF: unterminated padding ("AA=") is malformed; a padless partial chunk
    ;; is the loose case — 1 leftover char is len%4==1 (malformed), 2 → 1 byte,
    ;; 3 → 2 bytes, extra bits ignored.
    (if (i32.eqz (local.get $stopped))
      (then
        (if (i32.and (i32.ne (local.get $pads) (i32.const 0)) (i32.eqz (local.get $done)))
          (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.BASE64_UNTERMINATED_PAD}))) (throw $__jz_err (f64.const ${ERR.BASE64_UNTERMINATED_PAD}))))
        (if (i32.eq (local.get $cnt) (i32.const 1)) (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.BASE64_LEFTOVER_CHAR}))) (throw $__jz_err (f64.const ${ERR.BASE64_LEFTOVER_CHAR}))))
        (if (i32.gt_s (local.get $cnt) (i32.const 1))
          (then
            (local.set $n (i32.sub (local.get $cnt) (i32.const 1)))
            (if (i32.gt_s (i32.add (local.get $written) (local.get $n)) (local.get $cap))
              (then (local.set $stopped (i32.const 1)))
              (else
                (i32.store8 (i32.add (local.get $dst) (local.get $written))
                  (i32.and (i32.shr_u (local.get $acc)
                    (select (i32.const 10) (i32.const 4) (i32.eq (local.get $cnt) (i32.const 3)))) (i32.const 255)))
                (if (i32.eq (local.get $cnt) (i32.const 3))
                  (then (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $written) (i32.const 1)))
                    (i32.and (i32.shr_u (local.get $acc) (i32.const 2)) (i32.const 255)))))
                (local.set $written (i32.add (local.get $written) (local.get $n)))
                (local.set $mark (local.get $slen))))))))
    (i64.or
      (i64.shl (i64.extend_i32_u (select (local.get $mark) (local.get $slen) (local.get $stopped))) (i64.const 32))
      (i64.extend_i32_u (local.get $written))))`)

  // Uint8Array receiver guard → data offset. u8-only per spec (TypeError otherwise).
  wat('__u8_data', `(func $__u8_data (param $ptr i64) (result i32)
    (if (i32.or
          (i32.ne (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.TYPED}))
          (i32.ne (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 7)) (i32.const 1)))
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.U8_RECEIVER}))) (throw $__jz_err (f64.const ${ERR.U8_RECEIVER}))))
    (call $__typed_data (local.get $ptr)))`)

  wat('__btoa', `(func $__btoa (param $v i64) (result f64)
    (local $s i64) (local $len i32) (local $buf i32)
    (local.set $s (call $__to_str (local.get $v)))
    (local.set $len (call $__str_byteLen (local.get $s)))
    (local.set $buf (call $__alloc (local.get $len)))
    (call $__str_copy (local.get $s) (local.get $buf) (local.get $len))
    (call $__b64_enc (local.get $buf) (local.get $len) (i32.const 0) (i32.const 1)))`)

  wat('__atob', `(func $__atob (param $v i64) (result f64)
    (local $s i64) (local $max i32) (local $base i32) (local $rw i64)
    (local.set $s (call $__to_str (local.get $v)))
    (local.set $max (i32.add (i32.mul (i32.add (i32.shr_u (call $__str_byteLen (local.get $s)) (i32.const 2)) (i32.const 1)) (i32.const 3)) (i32.const 3)))
    (local.set $base (call $__alloc (i32.add (i32.const 4) (local.get $max))))
    (local.set $rw (call $__b64_dec_raw (local.get $s) (i32.add (local.get $base) (i32.const 4)) (i32.const 2147483647) (i32.const 0)))
    (i32.store (local.get $base) (i32.wrap_i64 (local.get $rw)))
    (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (i32.add (local.get $base) (i32.const 4)))))`)

  // Canonical 16-byte header, hand-written (NOT __alloc_hdr): the real
  // length $n is only known AFTER decoding, unlike every other
  // __alloc_hdr(len,cap) call site in this codebase, so the header can't
  // be filled at alloc time — $base reserves 16 header bytes + $max
  // scratch (the base64-decode upper bound) up front, decode writes into
  // $base+16, then propsPtr/len/cap are patched in afterward. Still fixes
  // the FOURTH-mechanism defect class (.work/research.md §Region arena):
  // the OLD 8-byte-header version left the propsPtr word at off-16
  // entirely unallocated, aliasing whatever memory preceded this call.
  wat('__b64_from', `(func $__b64_from (param $v i64) (param $url i32) (result f64)
    (local $s i64) (local $max i32) (local $base i32) (local $rw i64) (local $n i32)
    (local.set $s (call $__to_str (local.get $v)))
    (local.set $max (i32.add (i32.mul (i32.add (i32.shr_u (call $__str_byteLen (local.get $s)) (i32.const 2)) (i32.const 1)) (i32.const 3)) (i32.const 3)))
    (local.set $base (call $__alloc (i32.add (i32.const 16) (local.get $max))))
    (i64.store (local.get $base) (i64.const 0))
    (local.set $rw (call $__b64_dec_raw (local.get $s) (i32.add (local.get $base) (i32.const 16)) (i32.const 2147483647) (local.get $url)))
    (local.set $n (i32.wrap_i64 (local.get $rw)))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $n))
    (i32.store (i32.add (local.get $base) (i32.const 12)) (local.get $n))
    (call $__mkptr (i32.const ${PTR.TYPED}) (i32.const 1) (i32.add (local.get $base) (i32.const 16))))`)

  wat('__b64_set', `(func $__b64_set (param $dst i64) (param $s i64) (param $url i32) (result i64)
    (call $__b64_dec_raw (local.get $s)
      (call $__u8_data (local.get $dst))
      (call $__len (local.get $dst))
      (local.get $url)))`)

  wat('__hex_enc', `(func $__hex_enc (param $src i32) (param $len i32) (result f64)
    (local $base i32) (local $out i32) (local $i i32) (local $b i32) (local $n i32)
    (local.set $base (call $__alloc (i32.add (i32.const 4) (i32.shl (local.get $len) (i32.const 1)))))
    (local.set $out (i32.add (local.get $base) (i32.const 4)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $b (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (local.set $n (i32.shr_u (local.get $b) (i32.const 4)))
      (i32.store8 (i32.add (local.get $out) (i32.shl (local.get $i) (i32.const 1)))
        (select (i32.add (local.get $n) (i32.const 87)) (i32.add (local.get $n) (i32.const 48)) (i32.gt_u (local.get $n) (i32.const 9))))
      (local.set $n (i32.and (local.get $b) (i32.const 15)))
      (i32.store8 (i32.add (i32.add (local.get $out) (i32.shl (local.get $i) (i32.const 1))) (i32.const 1))
        (select (i32.add (local.get $n) (i32.const 87)) (i32.add (local.get $n) (i32.const 48)) (i32.gt_u (local.get $n) (i32.const 9))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store (local.get $base) (i32.shl (local.get $len) (i32.const 1)))
    (call $__sso_norm (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $out))))`)

  // Hex decode: strict per spec — no whitespace, both nibble cases, odd length
  // or a non-hex char throw. Stops at $cap whole bytes (setFromHex).
  wat('__hex_dec_raw', `(func $__hex_dec_raw (param $s i64) (param $dst i32) (param $cap i32) (result i64)
    (local $slen i32) (local $i i32) (local $hi i32) (local $lo i32) (local $written i32)
    (local.set $slen (call $__str_byteLen (local.get $s)))
    (if (i32.and (local.get $slen) (i32.const 1)) (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.HEX_ODD_LENGTH}))) (throw $__jz_err (f64.const ${ERR.HEX_ODD_LENGTH}))))
    (block $stop (loop $l
      (br_if $stop (i32.ge_s (local.get $i) (local.get $slen)))
      (br_if $stop (i32.ge_s (local.get $written) (local.get $cap)))
      (local.set $hi (call $__uri_hex (call $__char_at (local.get $s) (local.get $i))))
      (local.set $lo (call $__uri_hex (call $__char_at (local.get $s) (i32.add (local.get $i) (i32.const 1)))))
      (if (i32.or (i32.lt_s (local.get $hi) (i32.const 0)) (i32.lt_s (local.get $lo) (i32.const 0)))
        (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.HEX_INVALID_DIGIT}))) (throw $__jz_err (f64.const ${ERR.HEX_INVALID_DIGIT}))))
      (i32.store8 (i32.add (local.get $dst) (local.get $written))
        (i32.or (i32.shl (local.get $hi) (i32.const 4)) (local.get $lo)))
      (local.set $written (i32.add (local.get $written) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 2)))
      (br $l)))
    (i64.or (i64.shl (i64.extend_i32_u (local.get $i)) (i64.const 32))
      (i64.extend_i32_u (local.get $written))))`)

  // Canonical 16-byte header, hand-written (NOT __alloc_hdr) — same reason
  // and same fix shape as __b64_from above (the real length is only known
  // after decoding); closes the same FOURTH-mechanism defect class
  // (.work/research.md §Region arena) for Uint8Array.fromHex.
  wat('__hex_from', `(func $__hex_from (param $v i64) (result f64)
    (local $s i64) (local $base i32) (local $rw i64) (local $n i32)
    (local.set $s (call $__to_str (local.get $v)))
    (local.set $base (call $__alloc (i32.add (i32.const 16) (i32.shr_u (call $__str_byteLen (local.get $s)) (i32.const 1)))))
    (i64.store (local.get $base) (i64.const 0))
    (local.set $rw (call $__hex_dec_raw (local.get $s) (i32.add (local.get $base) (i32.const 16)) (i32.const 2147483647)))
    (local.set $n (i32.wrap_i64 (local.get $rw)))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $n))
    (i32.store (i32.add (local.get $base) (i32.const 12)) (local.get $n))
    (call $__mkptr (i32.const ${PTR.TYPED}) (i32.const 1) (i32.add (local.get $base) (i32.const 16))))`)

  wat('__hex_set', `(func $__hex_set (param $dst i64) (param $s i64) (result i64)
    (call $__hex_dec_raw (local.get $s)
      (call $__u8_data (local.get $dst))
      (call $__len (local.get $dst))))`)

  // btoa(s): base64 of the string's bytes. jz strings ARE bytes, so every char
  // qualifies — JS's InvalidCharacterError for >0xFF code units cannot arise;
  // non-ASCII text encodes its UTF-8 bytes (documented byte-string divergence).
  bind('btoa', (value) => {
    inc('__btoa')
    return typed(['call', '$__btoa',
      value === undefined ? ['i64.const', UNDEF_NAN] : asI64(emit(value))], 'f64')
  })

  // atob(b64): decoded bytes as a byte-string — charCodeAt(i) reads the byte,
  // exactly what JS binary-string consumers observe.
  bind('atob', (value) => {
    ctx.runtime.throws = true
    inc('__atob')
    return typed(['call', '$__atob',
      value === undefined ? ['i64.const', UNDEF_NAN] : asI64(emit(value))], 'f64')
  })
}
