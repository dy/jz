(module
  (memory (export "memory") 1)
  (data
    (i32.const 0)
    "NaNInfinity-Infinitytruefalsenullundefined[Array][Object]"
  )
  (tag $__jz_err (param f64))
  (export "__jz_last_err_bits" (global $__jz_last_err_bits))
  (global $__heap
    (export "__heap")
    (mut i32)
    (i32.const 1024)
  )
  (global $W
    (mut i32)
    (i32.const 0)
  )
  (global $H
    (mut i32)
    (i32.const 0)
  )
  (global $px
    (mut f64)
    (f64.const 0)
  )
  (global $gray
    (mut f64)
    (f64.const 0)
  )
  (global $bayer4
    (mut f64)
    (f64.const 0)
  )
  (global $bayer8
    (mut f64)
    (f64.const 0)
  )
  (global $halftone
    (mut f64)
    (f64.const 0)
  )
  (global $__jz_last_err_bits i64
    (i64.const 0)
  )
  (func $__char_at
    (param $ptr i64)
    (param $i i32)
    (result i32)
    (if
      (result i32)
      (i64.ne
        (i64.and (local.get $ptr) (i64.const 0x0000400000000000))
        (i64.const 0)
      )
      (then
        (if
          (result i32)
          (i32.ge_u
            (local.get $i)
            (i32.and
              (i32.wrap_i64
                (i64.shr_u (local.get $ptr) (i64.const 32))
              )
              (i32.const 16383)
            )
          )
          (then (i32.const 0))
          (else
            (i32.and
              (i32.shr_u
                (i32.wrap_i64
                  (i64.and (local.get $ptr) (i64.const 4294967295))
                )
                (i32.shl (local.get $i) (i32.const 3))
              )
              (i32.const 0xFF)
            )
          )
        )
      )
      (else
        (if
          (result i32)
          (i32.ge_u
            (local.get $i)
            ;; non-SSO length: view → aux[12:0]; own heap string → header at off-4
            ;; (off<4 sentinel guards the literal-data-segment edge). Both arms
            ;; are loop-invariant — V8 LICM hoists the whole select.
            (if
              (result i32)
              (i64.ne
                (i64.and (local.get $ptr) (i64.const 0x0000200000000000))
                (i64.const 0)
              )
              (then
                (i32.and
                  (i32.wrap_i64
                    (i64.shr_u (local.get $ptr) (i64.const 32))
                  )
                  (i32.const 8191)
                )
              )
              (else
                (if
                  (result i32)
                  (i32.lt_u
                    (i32.wrap_i64
                      (i64.and (local.get $ptr) (i64.const 4294967295))
                    )
                    (i32.const 4)
                  )
                  (then (i32.const 0))
                  (else
                    (i32.load
                      (i32.sub
                        (i32.wrap_i64
                          (i64.and (local.get $ptr) (i64.const 4294967295))
                        )
                        (i32.const 4)
                      )
                    )
                  )
                )
              )
            )
          )
          (then (i32.const 0))
          (else
            (i32.load8_u
              (i32.add
                (i32.wrap_i64
                  (i64.and (local.get $ptr) (i64.const 4294967295))
                )
                (local.get $i)
              )
            )
          )
        )
      )
    )
  )
  (func $__mkptr
    (param $type i32)
    (param $aux i32)
    (param $offset i32)
    (result f64)
    (f64.reinterpret_i64
      (i64.or
        (i64.const 0x7FF8000000000000)
        (i64.or
          (i64.shl
            (i64.and
              (i64.extend_i32_u (local.get $type))
              (i64.const 15)
            )
            (i64.const 47)
          )
          (i64.or
            (i64.shl
              (i64.and
                (i64.extend_i32_u (local.get $aux))
                (i64.const 32767)
              )
              (i64.const 32)
            )
            (i64.and
              (i64.extend_i32_u (local.get $offset))
              (i64.const 4294967295)
            )
          )
        )
      )
    )
  )
  (func $__static_str
    (param $id i32)
    (result f64)
    (local $src i32)
    (local $len i32)
    (if
      (i32.eqz (local.get $id))
      (then
        (local.set $len (i32.const 3))
      )
    )
    (if
      (i32.eq (local.get $id) (i32.const 1))
      (then
        (local.set $src (i32.const 3))
        (local.set $len (i32.const 8))
      )
    )
    (if
      (i32.eq (local.get $id) (i32.const 2))
      (then
        (local.set $src (i32.const 11))
        (local.set $len (i32.const 9))
      )
    )
    (if
      (i32.eq (local.get $id) (i32.const 3))
      (then
        (local.set $src (i32.const 20))
        (local.set $len (i32.const 4))
      )
    )
    (if
      (i32.eq (local.get $id) (i32.const 4))
      (then
        (local.set $src (i32.const 24))
        (local.set $len (i32.const 5))
      )
    )
    (if
      (i32.eq (local.get $id) (i32.const 5))
      (then
        (local.set $src (i32.const 29))
        (local.set $len (i32.const 4))
      )
    )
    (if
      (i32.eq (local.get $id) (i32.const 6))
      (then
        (local.set $src (i32.const 33))
        (local.set $len (i32.const 9))
      )
    )
    (if
      (i32.eq (local.get $id) (i32.const 7))
      (then
        (local.set $src (i32.const 42))
        (local.set $len (i32.const 7))
      )
    )
    (if
      (i32.eq (local.get $id) (i32.const 8))
      (then
        (local.set $src (i32.const 49))
        (local.set $len (i32.const 8))
      )
    )
    (call $__mkstr
      (local.get $src)
      (local.get $len)
    )
  )
  (func $__pow10
    (param $n i32)
    (result f64)
    (local $r f64)
    ;; 10^309 already overflows f64 (max ~1.8e308); short-circuit so callers
    ;; get Infinity rather than the truncated product of a 9-bit decomposition.
    (if
      (i32.ge_s (local.get $n) (i32.const 309))
      (then
        (return (f64.const inf))
      )
    )
    (local.set $r (f64.const 1))
    (if
      (i32.and (local.get $n) (i32.const 1))
      (then
        (local.set $r
          (f64.mul (local.get $r) (f64.const 10))
        )
      )
    )
    (if
      (i32.and (local.get $n) (i32.const 2))
      (then
        (local.set $r
          (f64.mul (local.get $r) (f64.const 100))
        )
      )
    )
    (if
      (i32.and (local.get $n) (i32.const 4))
      (then
        (local.set $r
          (f64.mul (local.get $r) (f64.const 10000))
        )
      )
    )
    (if
      (i32.and (local.get $n) (i32.const 8))
      (then
        (local.set $r
          (f64.mul (local.get $r) (f64.const 1e8))
        )
      )
    )
    (if
      (i32.and (local.get $n) (i32.const 16))
      (then
        (local.set $r
          (f64.mul (local.get $r) (f64.const 1e16))
        )
      )
    )
    (if
      (i32.and (local.get $n) (i32.const 32))
      (then
        (local.set $r
          (f64.mul (local.get $r) (f64.const 1e32))
        )
      )
    )
    (if
      (i32.and (local.get $n) (i32.const 64))
      (then
        (local.set $r
          (f64.mul (local.get $r) (f64.const 1e64))
        )
      )
    )
    (if
      (i32.and (local.get $n) (i32.const 128))
      (then
        (local.set $r
          (f64.mul (local.get $r) (f64.const 1e128))
        )
      )
    )
    (if
      (i32.and (local.get $n) (i32.const 256))
      (then
        (local.set $r
          (f64.mul (local.get $r) (f64.const 1e256))
        )
      )
    )
    (local.get $r)
  )
  (func $__alloc
    (param $bytes i32)
    (result i32)
    (local $ptr i32)
    (local $next i32)
    (local.set $ptr (global.get $__heap))
    (local.set $next
      (i32.and
        (i32.add
          (i32.add (local.get $ptr) (local.get $bytes))
          (i32.const 7)
        )
        (i32.const -8)
      )
    )
    (call $__memgrow (local.get $next))
    (global.set $__heap (local.get $next))
    (local.get $ptr)
  )
  (func $putBW
    (param $idx i32)
    (param $on i32)
    (result f64)
    (local $v i32)
    (local.set $v
      (select
        (i32.const 255)
        (i32.const 0)
        (i32.ne (local.get $on) (i32.const 0))
      )
    )
    (i32.store
      (i32.add
        (i32.wrap_i64
          (i64.and
            (i64.reinterpret_f64 (global.get $px))
            (i64.const 4294967295)
          )
        )
        (i32.shl (local.get $idx) (i32.const 2))
      )
      (i32.or
        (i32.or
          (i32.or
            (i32.const -16777216)
            (i32.shl (local.get $v) (i32.const 16))
          )
          (i32.shl (local.get $v) (i32.const 8))
        )
        (local.get $v)
      )
    )
    (f64.const nan:0x7FF8000200000000)
  )
  (func $__to_num
    (param $v i64)
    (result f64)
    (local $t i32)
    (local $i i32)
    (local $c i32)
    (local $neg i32)
    (local $seen i32)
    (local $exp i32)
    (local $expNeg i32)
    (local $expDigits i32)
    (local $dot i32)
    (local $sigDigits i32)
    (local $decExp i32)
    (local $dropped i32)
    (local $round i32)
    (local $radix i32)
    (local $digit i32)
    (local $sbase i32)
    (local $result f64)
    (local $f f64)
    (local $mant i64)
    (local.set $f
      (f64.reinterpret_i64 (local.get $v))
    )
    (if
      (f64.eq (local.get $f) (local.get $f))
      (then
        (return (local.get $f))
      )
    )
    (if
      (i64.eq (local.get $v) (i64.const 0x7FF8000100000000))
      (then
        (return (f64.const 0))
      )
    )
    (if
      (i64.eq (local.get $v) (i64.const 0x7FF8000200000000))
      (then
        (return (f64.const nan))
      )
    )
    (if
      (i64.eq (local.get $v) (i64.const 0x7FF8000400000000))
      (then
        (return (f64.const 0))
      )
    )
    (if
      (i64.eq (local.get $v) (i64.const 0x7FF8000500000000))
      (then
        (return (f64.const 1))
      )
    )
    (local.set $t
      (i32.and
        (i32.wrap_i64
          (i64.shr_u (local.get $v) (i64.const 47))
        )
        (i32.const 15)
      )
    )
    ;; ToNumber(Symbol) is a TypeError. A Symbol is an ATOM (type 0) with a user
    ;; atom-id (>= 16); null/undefined returned above, and a bare NaN carries
    ;; aux 0, so type==0 && aux>=16 uniquely identifies a Symbol.
    (if
      (i32.and
        (i32.eqz (local.get $t))
        (i32.ge_u
          (i32.and
            (i32.wrap_i64
              (i64.shr_u (local.get $v) (i64.const 32))
            )
            (i32.const 32767)
          )
          (i32.const 16)
        )
      )
      (then
        (throw $__jz_err (f64.const 0))
      )
    )
    ;; Non-string values go through ToString per JS spec, then re-check the
    ;; type in case ToString itself returned a non-string sentinel.
    (if
      (i32.ne (local.get $t) (i32.const 4))
      (then
        (local.set $v
          (call $__to_str (local.get $v))
        )
        (local.set $t
          (i32.and
            (i32.wrap_i64
              (i64.shr_u (local.get $v) (i64.const 47))
            )
            (i32.const 15)
          )
        )
        (if
          (i32.ne (local.get $t) (i32.const 4))
          (then
            (return (f64.const nan))
          )
        )
      )
    )
    (local.set $t
      (call $__str_byteLen (local.get $v))
    )
    (local.set $sbase
      (i32.wrap_i64
        (i64.and (local.get $v) (i64.const 4294967295))
      )
    )
    ;; Trim leading whitespace. An empty / all-whitespace string is +0.
    (local.set $i
      (call $__skipws
        (local.get $v)
        (i32.const 0)
        (local.get $t)
      )
    )
    (if
      (i32.ge_s (local.get $i) (local.get $t))
      (then
        (return (f64.const 0))
      )
    )
    ;; NonDecimalIntegerLiteral (0x / 0o / 0b). Per the grammar no sign may
    ;; precede the prefix, so it is matched before sign consumption.
    (if
      (i32.and
        (i32.lt_s
          (i32.add (local.get $i) (i32.const 1))
          (local.get $t)
        )
        (i32.eq
          (if
            (result i32)
            (i64.eqz
              (i64.and (local.get $v) (i64.const 0x0000400000000000))
            )
            (then
              (i32.load8_u
                (i32.add (local.get $sbase) (local.get $i))
              )
            )
            (else
              (call $__char_at
                (local.get $v)
                (local.get $i)
              )
            )
          )
          (i32.const 48)
        )
      )
      (then
        (local.set $c
          (if
            (result i32)
            (i64.eqz
              (i64.and (local.get $v) (i64.const 0x0000400000000000))
            )
            (then
              (i32.load8_u
                (i32.add
                  (i32.add (local.get $sbase) (local.get $i))
                  (i32.const 1)
                )
              )
            )
            (else
              (call $__char_at
                (local.get $v)
                (i32.add (local.get $i) (i32.const 1))
              )
            )
          )
        )
        (if
          (i32.or
            (i32.eq (local.get $c) (i32.const 120))
            (i32.eq (local.get $c) (i32.const 88))
          )
          (then
            (local.set $radix (i32.const 16))
          )
        )
        (if
          (i32.or
            (i32.eq (local.get $c) (i32.const 111))
            (i32.eq (local.get $c) (i32.const 79))
          )
          (then
            (local.set $radix (i32.const 8))
          )
        )
        (if
          (i32.or
            (i32.eq (local.get $c) (i32.const 98))
            (i32.eq (local.get $c) (i32.const 66))
          )
          (then
            (local.set $radix (i32.const 2))
          )
        )
      )
    )
    (if
      (local.get $radix)
      (then
        (local.set $i
          (i32.add (local.get $i) (i32.const 2))
        )
        (block $ndDone
          (loop $ndLoop
            (br_if $ndDone
              (i32.ge_s (local.get $i) (local.get $t))
            )
            (local.set $c
              (if
                (result i32)
                (i64.eqz
                  (i64.and (local.get $v) (i64.const 0x0000400000000000))
                )
                (then
                  (i32.load8_u
                    (i32.add (local.get $sbase) (local.get $i))
                  )
                )
                (else
                  (call $__char_at
                    (local.get $v)
                    (local.get $i)
                  )
                )
              )
            )
            ;; Decode digit; 99 sentinel for any non-[0-9a-fA-F] char so the
            ;; unsigned ">= radix" test rejects it and any out-of-base digit.
            (local.set $digit
              (if
                (result i32)
                (i32.and
                  (i32.ge_s (local.get $c) (i32.const 48))
                  (i32.le_s (local.get $c) (i32.const 57))
                )
                (then
                  (i32.sub (local.get $c) (i32.const 48))
                )
                (else
                  (if
                    (result i32)
                    (i32.and
                      (i32.ge_s (local.get $c) (i32.const 97))
                      (i32.le_s (local.get $c) (i32.const 102))
                    )
                    (then
                      (i32.sub (local.get $c) (i32.const 87))
                    )
                    (else
                      (if
                        (result i32)
                        (i32.and
                          (i32.ge_s (local.get $c) (i32.const 65))
                          (i32.le_s (local.get $c) (i32.const 70))
                        )
                        (then
                          (i32.sub (local.get $c) (i32.const 55))
                        )
                        (else (i32.const 99))
                      )
                    )
                  )
                )
              )
            )
            (br_if $ndDone
              (i32.ge_u (local.get $digit) (local.get $radix))
            )
            (local.set $result
              (f64.add
                (f64.mul
                  (local.get $result)
                  (f64.convert_i32_s (local.get $radix))
                )
                (f64.convert_i32_s (local.get $digit))
              )
            )
            (local.set $seen (i32.const 1))
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $ndLoop)
          )
        )
        ;; No digits, or trailing non-whitespace ("0b1.0", "0xg") → NaN.
        (if
          (i32.eqz (local.get $seen))
          (then
            (return (f64.const nan))
          )
        )
        (local.set $i
          (call $__skipws
            (local.get $v)
            (local.get $i)
            (local.get $t)
          )
        )
        (if
          (i32.lt_s (local.get $i) (local.get $t))
          (then
            (return (f64.const nan))
          )
        )
        (return (local.get $result))
      )
    )
    ;; Sign (StrDecimalLiteral only).
    (if
      (i32.eq
        (if
          (result i32)
          (i64.eqz
            (i64.and (local.get $v) (i64.const 0x0000400000000000))
          )
          (then
            (i32.load8_u
              (i32.add (local.get $sbase) (local.get $i))
            )
          )
          (else
            (call $__char_at
              (local.get $v)
              (local.get $i)
            )
          )
        )
        (i32.const 45)
      )
      (then
        (local.set $neg (i32.const 1))
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
      )
    )
    (if
      (i32.eq
        (if
          (result i32)
          (i32.lt_s (local.get $i) (local.get $t))
          (then
            (if
              (result i32)
              (i64.eqz
                (i64.and (local.get $v) (i64.const 0x0000400000000000))
              )
              (then
                (i32.load8_u
                  (i32.add (local.get $sbase) (local.get $i))
                )
              )
              (else
                (call $__char_at
                  (local.get $v)
                  (local.get $i)
                )
              )
            )
          )
          (else (i32.const 0))
        )
        (i32.const 43)
      )
      (then
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
      )
    )
    ;; "Infinity" — the only non-numeric token ToNumber accepts. The 8 letters
    ;; are packed little-endian in one i64; any mismatch, short input, or
    ;; trailing non-whitespace makes the whole string NaN.
    (if
      (i32.eq
        (if
          (result i32)
          (i32.lt_s (local.get $i) (local.get $t))
          (then
            (if
              (result i32)
              (i64.eqz
                (i64.and (local.get $v) (i64.const 0x0000400000000000))
              )
              (then
                (i32.load8_u
                  (i32.add (local.get $sbase) (local.get $i))
                )
              )
              (else
                (call $__char_at
                  (local.get $v)
                  (local.get $i)
                )
              )
            )
          )
          (else (i32.const 0))
        )
        (i32.const 73)
      )
      (then
        (block $infBad
          (local.set $digit (i32.const 0))
          (loop $infl
            (if
              (i32.lt_s (local.get $digit) (i32.const 8))
              (then
                (br_if $infBad
                  (i32.ge_s
                    (i32.add (local.get $i) (local.get $digit))
                    (local.get $t)
                  )
                )
                (br_if $infBad
                  (i32.ne
                    (if
                      (result i32)
                      (i64.eqz
                        (i64.and (local.get $v) (i64.const 0x0000400000000000))
                      )
                      (then
                        (i32.load8_u
                          (i32.add
                            (local.get $sbase)
                            (i32.add (local.get $i) (local.get $digit))
                          )
                        )
                      )
                      (else
                        (call $__char_at
                          (local.get $v)
                          (i32.add (local.get $i) (local.get $digit))
                        )
                      )
                    )
                    (i32.and
                      (i32.wrap_i64
                        (i64.shr_u
                          (i64.const 0x7974696e69666e49)
                          (i64.extend_i32_u
                            (i32.shl (local.get $digit) (i32.const 3))
                          )
                        )
                      )
                      (i32.const 255)
                    )
                  )
                )
                (local.set $digit
                  (i32.add (local.get $digit) (i32.const 1))
                )
                (br $infl)
              )
            )
          )
          (local.set $i
            (call $__skipws
              (local.get $v)
              (i32.add (local.get $i) (i32.const 8))
              (local.get $t)
            )
          )
          (br_if $infBad
            (i32.lt_s (local.get $i) (local.get $t))
          )
          (return
            (if
              (result f64)
              (local.get $neg)
              (then (f64.const -inf))
              (else (f64.const inf))
            )
          )
        )
        (return (f64.const nan))
      )
    )
    ;; Decimal significand. Keep 18 significant decimal digits, track the
    ;; base-10 exponent for skipped digits, and round once before pow10 scaling.
    (block $numDone
      (loop $numLoop
        (br_if $numDone
          (i32.ge_s (local.get $i) (local.get $t))
        )
        (local.set $c
          (if
            (result i32)
            (i64.eqz
              (i64.and (local.get $v) (i64.const 0x0000400000000000))
            )
            (then
              (i32.load8_u
                (i32.add (local.get $sbase) (local.get $i))
              )
            )
            (else
              (call $__char_at
                (local.get $v)
                (local.get $i)
              )
            )
          )
        )
        (if
          (i32.and
            (i32.eq (local.get $c) (i32.const 46))
            (i32.eqz (local.get $dot))
          )
          (then
            (local.set $dot (i32.const 1))
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $numLoop)
          )
        )
        (br_if $numDone
          (i32.or
            (i32.lt_s (local.get $c) (i32.const 48))
            (i32.gt_s (local.get $c) (i32.const 57))
          )
        )
        (local.set $seen (i32.const 1))
        (local.set $c
          (i32.sub (local.get $c) (i32.const 48))
        )
        (if
          (i32.and
            (i32.eqz (local.get $sigDigits))
            (i32.eqz (local.get $c))
          )
          (then
            (if
              (local.get $dot)
              (then
                (local.set $decExp
                  (i32.sub (local.get $decExp) (i32.const 1))
                )
              )
            )
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $numLoop)
          )
        )
        ;; Accumulate the significand in an i64 (exact to 18 decimal digits,
        ;; since 10^18 < 2^63) and convert to f64 once at the end — a single
        ;; correctly-rounded i64->f64 step instead of lossy per-digit f64 math.
        (if
          (i32.lt_s (local.get $sigDigits) (i32.const 18))
          (then
            (local.set $mant
              (i64.add
                (i64.mul (local.get $mant) (i64.const 10))
                (i64.extend_i32_s (local.get $c))
              )
            )
            (local.set $sigDigits
              (i32.add (local.get $sigDigits) (i32.const 1))
            )
            (if
              (local.get $dot)
              (then
                (local.set $decExp
                  (i32.sub (local.get $decExp) (i32.const 1))
                )
              )
            )
          )
          (else
            (if
              (i32.eqz (local.get $dropped))
              (then
                (if
                  (i32.ge_s (local.get $c) (i32.const 5))
                  (then
                    (local.set $round (i32.const 1))
                  )
                )
              )
            )
            (local.set $dropped (i32.const 1))
            (if
              (i32.eqz (local.get $dot))
              (then
                (local.set $decExp
                  (i32.add (local.get $decExp) (i32.const 1))
                )
              )
            )
          )
        )
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (br $numLoop)
      )
    )
    ;; No digits — the literal was a bare sign or stray text ("abc", "+") → NaN.
    ;; (Empty / all-whitespace strings already returned +0 above.)
    (if
      (i32.eqz (local.get $seen))
      (then
        (return (f64.const nan))
      )
    )
    (if
      (local.get $round)
      (then
        (local.set $mant
          (i64.add (local.get $mant) (i64.const 1))
        )
      )
    )
    (local.set $result
      (f64.convert_i64_u (local.get $mant))
    )
    ;; Scientific notation. 'e'/'E' commits to an ExponentPart — at least one
    ;; digit must follow ("1e", "5e+" are NaN).
    (local.set $c
      (if
        (result i32)
        (i32.lt_s (local.get $i) (local.get $t))
        (then
          (if
            (result i32)
            (i64.eqz
              (i64.and (local.get $v) (i64.const 0x0000400000000000))
            )
            (then
              (i32.load8_u
                (i32.add (local.get $sbase) (local.get $i))
              )
            )
            (else
              (call $__char_at
                (local.get $v)
                (local.get $i)
              )
            )
          )
        )
        (else (i32.const 0))
      )
    )
    (if
      (i32.or
        (i32.eq (local.get $c) (i32.const 101))
        (i32.eq (local.get $c) (i32.const 69))
      )
      (then
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (if
          (i32.eq
            (if
              (result i32)
              (i32.lt_s (local.get $i) (local.get $t))
              (then
                (if
                  (result i32)
                  (i64.eqz
                    (i64.and (local.get $v) (i64.const 0x0000400000000000))
                  )
                  (then
                    (i32.load8_u
                      (i32.add (local.get $sbase) (local.get $i))
                    )
                  )
                  (else
                    (call $__char_at
                      (local.get $v)
                      (local.get $i)
                    )
                  )
                )
              )
              (else (i32.const 0))
            )
            (i32.const 45)
          )
          (then
            (local.set $expNeg (i32.const 1))
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
          )
        )
        (if
          (i32.eq
            (if
              (result i32)
              (i32.lt_s (local.get $i) (local.get $t))
              (then
                (if
                  (result i32)
                  (i64.eqz
                    (i64.and (local.get $v) (i64.const 0x0000400000000000))
                  )
                  (then
                    (i32.load8_u
                      (i32.add (local.get $sbase) (local.get $i))
                    )
                  )
                  (else
                    (call $__char_at
                      (local.get $v)
                      (local.get $i)
                    )
                  )
                )
              )
              (else (i32.const 0))
            )
            (i32.const 43)
          )
          (then
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
          )
        )
        (block $expDone
          (loop $expLoop
            (br_if $expDone
              (i32.ge_s (local.get $i) (local.get $t))
            )
            (local.set $c
              (if
                (result i32)
                (i64.eqz
                  (i64.and (local.get $v) (i64.const 0x0000400000000000))
                )
                (then
                  (i32.load8_u
                    (i32.add (local.get $sbase) (local.get $i))
                  )
                )
                (else
                  (call $__char_at
                    (local.get $v)
                    (local.get $i)
                  )
                )
              )
            )
            (br_if $expDone
              (i32.or
                (i32.lt_s (local.get $c) (i32.const 48))
                (i32.gt_s (local.get $c) (i32.const 57))
              )
            )
            (local.set $exp
              (i32.add
                (i32.mul (local.get $exp) (i32.const 10))
                (i32.sub (local.get $c) (i32.const 48))
              )
            )
            (local.set $expDigits
              (i32.add (local.get $expDigits) (i32.const 1))
            )
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $expLoop)
          )
        )
        (if
          (i32.eqz (local.get $expDigits))
          (then
            (return (f64.const nan))
          )
        )
        (if
          (local.get $expNeg)
          (then
            (local.set $decExp
              (i32.sub (local.get $decExp) (local.get $exp))
            )
          )
          (else
            (local.set $decExp
              (i32.add (local.get $decExp) (local.get $exp))
            )
          )
        )
      )
    )
    ;; Reject trailing non-whitespace ("5px", numeric separators "1_0", …).
    (local.set $i
      (call $__skipws
        (local.get $v)
        (local.get $i)
        (local.get $t)
      )
    )
    (if
      (i32.lt_s (local.get $i) (local.get $t))
      (then
        (return (f64.const nan))
      )
    )
    (if
      (i32.gt_s (local.get $decExp) (i32.const 0))
      (then
        (local.set $result
          (f64.mul
            (local.get $result)
            (call $__pow10 (local.get $decExp))
          )
        )
      )
    )
    (if
      (i32.lt_s (local.get $decExp) (i32.const 0))
      (then
        (local.set $result
          (f64.div
            (local.get $result)
            (call $__pow10
              (i32.sub (i32.const 0) (local.get $decExp))
            )
          )
        )
      )
    )
    (if
      (result f64)
      (local.get $neg)
      (then
        (f64.neg (local.get $result))
      )
      (else (local.get $result))
    )
  )
  (func $__alloc_hdr_n_d_d_1
    (param $a0 i32)
    (param $a1 i32)
    (result i32)
    (local $__inl1_len i32)
    (local $__inl1_stride i32)
    (local $__inl1_ptr i32)
    (local.set $__inl1_len (local.get $a0))
    (local.set $__inl1_stride (i32.const 1))
    (local.set $__inl1_ptr
      (call $__alloc
        (i32.add
          (i32.const 16)
          (local.tee $__inl1_stride (local.get $a1))
        )
      )
    )
    (i64.store (local.get $__inl1_ptr) (i64.const 0))
    (i32.store offset=8
      (local.get $__inl1_ptr)
      (local.get $a0)
    )
    (i32.store offset=12
      (local.get $__inl1_ptr)
      (local.get $a1)
    )
    (memory.fill
      (local.tee $__inl1_len
        (i32.add (local.get $__inl1_ptr) (i32.const 16))
      )
      (i32.const 0)
      (local.get $__inl1_stride)
    )
    (local.get $__inl1_len)
  )
  (func $__len
    (param $ptr i64)
    (result i32)
    (local $bits i64)
    (local $t i32)
    (local $off i32)
    (local $aux i32)
    (local.set $bits (local.get $ptr))
    (local.set $t
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $ptr) (i64.const 47))
          (i64.const 15)
        )
      )
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $ptr) (i64.const 4294967295))
      )
    )
    ;; ARRAY fast path: follow forwarding inline, then load len at off-8.
    (if
      (result i32)
      (i32.and
        (i32.eq (local.get $t) (i32.const 1))
        (i32.ge_u (local.get $off) (i32.const 8))
      )
      (then
        (if
          (i32.and
            (i32.const 1)
            (i32.le_u
              (local.get $off)
              (i32.shl (memory.size) (i32.const 16))
            )
          )
          (then
            (if
              (i32.eq
                (i32.load
                  (i32.sub (local.get $off) (i32.const 4))
                )
                (i32.const -1)
              )
              (then
                (local.set $off
                  (call $__ptr_offset_fwd (local.get $off))
                )
              )
            )
          )
        )
        (i32.load
          (i32.sub (local.get $off) (i32.const 8))
        )
      )
      (else
        (if
          (result i32)
          (i32.and
            (i32.ge_u (local.get $off) (i32.const 8))
            (i32.or
              (i32.eq (local.get $t) (i32.const 3))
              (i32.or
                (i32.eq (local.get $t) (i32.const 2))
                (i32.or
                  (i32.eq (local.get $t) (i32.const 7))
                  (i32.or
                    (i32.eq (local.get $t) (i32.const 8))
                    (i32.eq (local.get $t) (i32.const 9))
                  )
                )
              )
            )
          )
          (then
            (if
              (result i32)
              (i32.eq (local.get $t) (i32.const 3))
              (then
                (local.set $aux
                  (i32.wrap_i64
                    (i64.and
                      (i64.shr_u (local.get $bits) (i64.const 32))
                      (i64.const 32767)
                    )
                  )
                )
                (if
                  (result i32)
                  (i32.and (local.get $aux) (i32.const 8))
                  (then
                    (i32.shr_u
                      (i32.load (local.get $off))
                      (call $__typed_shift
                        (i32.and (local.get $aux) (i32.const 7))
                      )
                    )
                  )
                  (else
                    (i32.shr_u
                      (i32.load
                        (i32.sub (local.get $off) (i32.const 8))
                      )
                      (call $__typed_shift
                        (i32.and (local.get $aux) (i32.const 7))
                      )
                    )
                  )
                )
              )
              ;; HASH/SET/MAP/BUFFER: re-resolve offset so grown SET/MAP follow the
              ;; forwarding chain (HASH/BUFFER never forward → same inline offset).
              (else
                (i32.load
                  (i32.sub
                    (call $__ptr_offset (local.get $ptr))
                    (i32.const 8)
                  )
                )
              )
            )
          )
          (else (i32.const 0))
        )
      )
    )
  )
  (func $__ptr_offset
    (param $ptr i64)
    (result i32)
    (local $off i32)
    (local $t i32)
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $ptr) (i64.const 4294967295))
      )
    )
    ;; ARRAY/SET/MAP/HASH can be reallocated on growth; follow the forwarding pointer
    ;; (cap=-1 sentinel at -4, new offset at -8). Other types never forward, so they skip
    ;; the loop; a well-formed ptr without forwarding pays one bounds + cap check per hop.
    (local.set $t
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $ptr) (i64.const 47))
          (i64.const 15)
        )
      )
    )
    (if
      (i32.and
        (i32.shl (i32.const 1) (local.get $t))
        (i32.const 898)
      )
      (then
        (if
          (i32.and
            (i32.ge_u (local.get $off) (i32.const 8))
            (i32.le_u
              (local.get $off)
              (i32.shl (memory.size) (i32.const 16))
            )
          )
          (then
            (if
              (i32.eq
                (i32.load
                  (i32.sub (local.get $off) (i32.const 4))
                )
                (i32.const -1)
              )
              (then
                (local.set $off
                  (call $__ptr_offset_fwd (local.get $off))
                )
              )
            )
          )
        )
      )
    )
    (local.get $off)
  )
  (func $__to_str
    (param $val i64)
    (result i64)
    (local $f f64)
    (local $__inl3_val f64)
    (local $__inl3_prec i32)
    (local $__inl3_mode i32)
    (local $__inl3_buf i32)
    (local $__inl3_pos i32)
    (local $__inl3_neg i32)
    (local $__inl3_abs f64)
    (local $__inl3_scale f64)
    (local $__inl3_scaled f64)
    (local $__inl3_int i32)
    (local $__inl3_frac i32)
    (local $__inl3_ilen i32)
    (local $__inl3_i i32)
    (local $__inl3_j i32)
    (local $__inl3___pe0 i32)
    (local $__inl3___pe1 i32)
    (local $__inl3___pe2 i32)
    (local $__inl3___pe3 i32)
    (local $__inl4_arr i64)
    (local $__inl4_sep i64)
    (local $__inl4_off i32)
    (local $__inl4_len i32)
    (local $__inl4_i i32)
    (local $__inl4_result f64)
    (local $__inl4_isTyped i32)
    (local.set $f
      (f64.reinterpret_i64 (local.get $val))
    )
    ;; Not NaN → number, convert
    (if
      (f64.eq (local.get $f) (local.get $f))
      (then
        (return
          (i64.reinterpret_f64
            (block $__inl3
              (result f64)
              (local.set $__inl3_val (local.get $f))
              (local.set $__inl3_prec (i32.const 0))
              (local.set $__inl3_mode (i32.const 0))
              (local.set $__inl3_pos (i32.const 0))
              (local.set $__inl3_neg (i32.const 0))
              (local.set $__inl3_abs (f64.const 0))
              (local.set $__inl3_int (i32.const 0))
              (local.set $__inl3_frac (i32.const 0))
              (local.set $__inl3_ilen (i32.const 0))
              (local.set $__inl3_i (i32.const 0))
              (local.set $__inl3_j (i32.const 0))
              (local.set $__inl3___pe0 (i32.const 0))
              (local.set $__inl3___pe1 (i32.const 0))
              (local.set $__inl3___pe2 (i32.const 0))
              (local.set $__inl3___pe3 (i32.const 0))
              (if
                (f64.ne (local.get $__inl3_val) (local.get $__inl3_val))
                (then
                  (br $__inl3
                    (call $__static_str (i32.const 0))
                  )
                )
              )
              (if
                (f64.eq (local.get $__inl3_val) (f64.const inf))
                (then
                  (br $__inl3
                    (call $__static_str (i32.const 1))
                  )
                )
              )
              (if
                (f64.eq (local.get $__inl3_val) (f64.const -inf))
                (then
                  (br $__inl3
                    (call $__static_str (i32.const 2))
                  )
                )
              )
              ;; ES spec: |x| >= 1e21 or 0 < |x| < 1e-6 → exponential notation (default mode only).
              ;; __toExp clamps the digit count so its scaled mantissa fits an unsigned i32.
              ;; Fewer digits than ECMAScript shortest-repr ideal, but valid output.
              (if
                (i32.eqz (local.get $__inl3_mode))
                (then
                  (if
                    (f64.ge
                      (f64.abs (local.get $__inl3_val))
                      (f64.const 1e21)
                    )
                    (then
                      (br $__inl3
                        (call $__toExp
                          (local.get $__inl3_val)
                          (i32.const 8)
                          (i32.const 1)
                        )
                      )
                    )
                  )
                  (if
                    (i32.and
                      (f64.gt
                        (f64.abs (local.get $__inl3_val))
                        (f64.const 0)
                      )
                      (f64.lt
                        (f64.abs (local.get $__inl3_val))
                        (f64.const 1e-6)
                      )
                    )
                    (then
                      (br $__inl3
                        (call $__toExp
                          (local.get $__inl3_val)
                          (i32.const 8)
                          (i32.const 1)
                        )
                      )
                    )
                  )
                )
              )
              (local.set $__inl3_buf
                (call $__alloc (i32.const 40))
              )
              ;; Sign
              (if
                (f64.lt (local.get $__inl3_val) (f64.const 0))
                (then
                  (local.set $__inl3_neg (i32.const 1))
                  (local.set $__inl3_val
                    (f64.neg (local.get $__inl3_val))
                  )
                )
              )
              (if
                (i32.and
                  (f64.eq (local.get $__inl3_val) (f64.const 0))
                  (local.get $__inl3_neg)
                )
                (then
                  (local.set $__inl3_neg (i32.const 0))
                )
              )
              (if
                (local.get $__inl3_neg)
                (then
                  (i32.store8 (local.get $__inl3_buf) (i32.const 45))
                  (local.set $__inl3_pos (i32.const 1))
                )
              )
              ;; Default mode: auto-select precision (up to 9 digits, must fit i32 when scaled)
              (if
                (i32.eqz (local.get $__inl3_mode))
                (then
                  (local.set $__inl3_prec (i32.const 9))
                )
              )
              ;; Round and scale to integer: scaled = nearest(val * 10^prec).
              ;; NOTE: toFixed/toPrecision round ties-to-even here (f64.nearest), which differs from
              ;; JS's round-half-away-from-zero on exact halves like (2.5).toFixed(0) → '2' vs '3'.
              ;; A naive floor(x+0.5) "fixes" those but breaks values like 1.45 (whose ×10 rounds up
              ;; to 14.5 in f64, giving '1.5' vs JS '1.4'); bit-exact toFixed needs the exact-decimal
              ;; algorithm. Documented as a known difference rather than trading one error for another.
              (local.set $__inl3_scale
                (call $__pow10 (local.get $__inl3_prec))
              )
              (local.set $__inl3_scaled
                (f64.nearest
                  (f64.mul (local.get $__inl3_val) (local.get $__inl3_scale))
                )
              )
              ;; If scaled doesn't fit i32, reduce precision until it does (min prec=0)
              (block $__inl3L_fit
                (loop $__inl3L_fitl
                  (br_if $__inl3L_fit
                    (f64.lt (local.get $__inl3_scaled) (f64.const 2147483648))
                  )
                  (br_if $__inl3L_fit
                    (i32.le_s (local.get $__inl3_prec) (i32.const 0))
                  )
                  (local.set $__inl3_prec
                    (i32.sub (local.get $__inl3_prec) (i32.const 1))
                  )
                  (local.set $__inl3_scale
                    (call $__pow10 (local.get $__inl3_prec))
                  )
                  (local.set $__inl3_scaled
                    (f64.nearest
                      (f64.mul (local.get $__inl3_val) (local.get $__inl3_scale))
                    )
                  )
                  (br $__inl3L_fitl)
                )
              )
              ;; Split: int = scaled / scale, frac = scaled % scale
              (if
                (f64.lt (local.get $__inl3_scaled) (f64.const 2147483648))
                (then
                  (local.set $__inl3_int
                    (i32.trunc_f64_u
                      (f64.div (local.get $__inl3_scaled) (local.get $__inl3_scale))
                    )
                  )
                  (local.set $__inl3_frac
                    (i32.trunc_f64_u
                      (f64.sub
                        (local.get $__inl3_scaled)
                        (f64.mul
                          (f64.convert_i32_u (local.get $__inl3_int))
                          (local.get $__inl3_scale)
                        )
                      )
                    )
                  )
                  ;; Default mode, fit loop reduced prec to 0: the rounded integer is ready, but the
                  ;; original val may still have a fractional part that was discarded.  Recover it:
                  ;; frac_f = val - trunc(val); since frac_f ∈ [0,1), frac_f*10^9 < 10^9 < 2^31 — safe.
                  (if
                    (i32.and
                      (i32.eqz (local.get $__inl3_mode))
                      (i32.eqz (local.get $__inl3_prec))
                    )
                    (then
                      (local.set $__inl3_abs
                        (f64.sub
                          (local.get $__inl3_val)
                          (f64.trunc (local.get $__inl3_val))
                        )
                      )
                      (if
                        (f64.gt (local.get $__inl3_abs) (f64.const 0))
                        (then
                          ;; $int was taken from f64.nearest(val), which rounds .5+ UP (999999999.9 → 1e9),
                          ;; but $abs/$frac below derive from f64.trunc(val). Re-derive $int from the same
                          ;; trunc so integer and fraction agree — else String(999999999.9) → "1000000000.9".
                          (local.set $__inl3_int
                            (i32.trunc_f64_u
                              (f64.trunc (local.get $__inl3_val))
                            )
                          )
                          (local.set $__inl3_prec (i32.const 9))
                          (local.set $__inl3_scale
                            (call $__pow10 (i32.const 9))
                          )
                          ;; round: trunc_u(x+0.5) == floor(x+0.5) for the positive frac scale
                          (local.set $__inl3_frac
                            (i32.trunc_f64_u
                              (f64.add
                                (f64.mul (local.get $__inl3_abs) (f64.const 1000000000))
                                (f64.const 0.5)
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
                (else
                  (local.set $__inl3_int (i32.const 0))
                  (local.set $__inl3_frac (i32.const 0))
                  (local.set $__inl3_prec (i32.const 0))
                  (local.set $__inl3_abs
                    (f64.trunc (local.get $__inl3_val))
                  )
                  ;; Write large integer digits reversed.
                  ;; Clamp digit to [0,9]: f64 precision loss for large values can make the naive
                  ;; subtraction (abs - trunc(abs/10)*10) go slightly negative → i32.trunc_f64_u trap.
                  (local.set $__inl3_ilen (local.get $__inl3_pos))
                  (block $__inl3L_ld
                    (loop $__inl3L_ll
                      (br_if $__inl3L_ld
                        (f64.lt (local.get $__inl3_abs) (f64.const 1))
                      )
                      (i32.store8
                        (i32.add (local.get $__inl3_buf) (local.get $__inl3_pos))
                        (i32.add
                          (i32.const 48)
                          (i32.trunc_f64_u
                            (f64.max
                              (f64.const 0)
                              (f64.min
                                (f64.const 9)
                                (f64.nearest
                                  (f64.sub
                                    (local.get $__inl3_abs)
                                    (f64.mul
                                      (f64.trunc
                                        (f64.div (local.get $__inl3_abs) (f64.const 10))
                                      )
                                      (f64.const 10)
                                    )
                                  )
                                )
                              )
                            )
                          )
                        )
                      )
                      (local.set $__inl3_abs
                        (f64.trunc
                          (f64.div (local.get $__inl3_abs) (f64.const 10))
                        )
                      )
                      (local.set $__inl3_pos
                        (i32.add (local.get $__inl3_pos) (i32.const 1))
                      )
                      (br $__inl3L_ll)
                    )
                  )
                  ;; Reverse
                  (local.set $__inl3_i (local.get $__inl3_ilen))
                  (local.set $__inl3_j
                    (i32.sub (local.get $__inl3_pos) (i32.const 1))
                  )
                  (block $__inl3L_rd
                    (loop $__inl3L_rl
                      (br_if $__inl3L_rd
                        (i32.ge_s (local.get $__inl3_i) (local.get $__inl3_j))
                      )
                      (local.set $__inl3_int
                        (i32.load8_u
                          (local.tee $__inl3___pe0
                            (i32.add (local.get $__inl3_buf) (local.get $__inl3_i))
                          )
                        )
                      )
                      (i32.store8
                        (local.get $__inl3___pe0)
                        (i32.load8_u
                          (local.tee $__inl3___pe1
                            (i32.add (local.get $__inl3_buf) (local.get $__inl3_j))
                          )
                        )
                      )
                      (i32.store8 (local.get $__inl3___pe1) (local.get $__inl3_int))
                      (local.set $__inl3_i
                        (i32.add (local.get $__inl3_i) (i32.const 1))
                      )
                      (local.set $__inl3_j
                        (i32.sub (local.get $__inl3_j) (i32.const 1))
                      )
                      (br $__inl3L_rl)
                    )
                  )
                  ;; Default mode: emit fractional part if val has one (large-int path skipped it before).
                  ;; frac_f = val - trunc(val); since frac_f ∈ [0,1), frac_f*10^9 < 10^9 < 2^31 — safe.
                  (if
                    (i32.eqz (local.get $__inl3_mode))
                    (then
                      (local.set $__inl3_abs
                        (f64.sub
                          (local.get $__inl3_val)
                          (f64.trunc (local.get $__inl3_val))
                        )
                      )
                      (if
                        (f64.gt (local.get $__inl3_abs) (f64.const 0))
                        (then
                          ;; round: trunc_u(x+0.5) == floor(x+0.5) for the positive frac scale
                          (local.set $__inl3_frac
                            (i32.trunc_f64_u
                              (f64.add
                                (f64.mul (local.get $__inl3_abs) (f64.const 1000000000))
                                (f64.const 0.5)
                              )
                            )
                          )
                          (i32.store8
                            (i32.add (local.get $__inl3_buf) (local.get $__inl3_pos))
                            (i32.const 46)
                          )
                          (local.set $__inl3_pos
                            (i32.add (local.get $__inl3_pos) (i32.const 1))
                          )
                          ;; 9 fractional digits from $frac, high-to-low
                          (local.set $__inl3_i (i32.const 8))
                          (block $__inl3L_fd2
                            (loop $__inl3L_fl2
                              (br_if $__inl3L_fd2
                                (i32.lt_s (local.get $__inl3_i) (i32.const 0))
                              )
                              (local.set $__inl3_j
                                (i32.div_u
                                  (local.get $__inl3_frac)
                                  (i32.trunc_f64_u
                                    (call $__pow10 (local.get $__inl3_i))
                                  )
                                )
                              )
                              (i32.store8
                                (i32.add (local.get $__inl3_buf) (local.get $__inl3_pos))
                                (i32.add
                                  (i32.const 48)
                                  (i32.rem_u (local.get $__inl3_j) (i32.const 10))
                                )
                              )
                              (local.set $__inl3_pos
                                (i32.add (local.get $__inl3_pos) (i32.const 1))
                              )
                              (local.set $__inl3_i
                                (i32.sub (local.get $__inl3_i) (i32.const 1))
                              )
                              (br $__inl3L_fl2)
                            )
                          )
                          ;; Strip trailing zeros
                          (block $__inl3L_sz2
                            (loop $__inl3L_sl2
                              (br_if $__inl3L_sz2
                                (i32.le_s (local.get $__inl3_pos) (i32.const 0))
                              )
                              (br_if $__inl3L_sz2
                                (i32.ne
                                  (i32.load8_u
                                    (i32.add
                                      (local.get $__inl3_buf)
                                      (local.tee $__inl3___pe2
                                        (i32.sub (local.get $__inl3_pos) (i32.const 1))
                                      )
                                    )
                                  )
                                  (i32.const 48)
                                )
                              )
                              (local.set $__inl3_pos (local.get $__inl3___pe2))
                              (br $__inl3L_sl2)
                            )
                          )
                          ;; Strip trailing dot
                          (if
                            (i32.and
                              (i32.gt_s (local.get $__inl3_pos) (i32.const 0))
                              (i32.eq
                                (i32.load8_u
                                  (i32.add
                                    (local.get $__inl3_buf)
                                    (i32.sub (local.get $__inl3_pos) (i32.const 1))
                                  )
                                )
                                (i32.const 46)
                              )
                            )
                            (then
                              (local.set $__inl3_pos
                                (i32.sub (local.get $__inl3_pos) (i32.const 1))
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                  (br $__inl3
                    (call $__mkstr
                      (local.get $__inl3_buf)
                      (local.get $__inl3_pos)
                    )
                  )
                )
              )
              ;; Write integer part
              (local.set $__inl3_ilen
                (call $__itoa
                  (local.get $__inl3_int)
                  (i32.add (local.get $__inl3_buf) (local.get $__inl3_pos))
                )
              )
              (local.set $__inl3_pos
                (i32.add (local.get $__inl3_pos) (local.get $__inl3_ilen))
              )
              ;; Write fractional part: extract digits from $frac by dividing by 10^(prec-1), 10^(prec-2), ...
              (if
                (i32.gt_s (local.get $__inl3_prec) (i32.const 0))
                (then
                  (i32.store8
                    (i32.add (local.get $__inl3_buf) (local.get $__inl3_pos))
                    (i32.const 46)
                  )
                  (local.set $__inl3_pos
                    (i32.add (local.get $__inl3_pos) (i32.const 1))
                  )
                  (local.set $__inl3_i
                    (i32.sub (local.get $__inl3_prec) (i32.const 1))
                  )
                  (block $__inl3L_fd
                    (loop $__inl3L_fl
                      (br_if $__inl3L_fd
                        (i32.lt_s (local.get $__inl3_i) (i32.const 0))
                      )
                      (local.set $__inl3_j
                        (i32.div_u
                          (local.get $__inl3_frac)
                          (i32.trunc_f64_u
                            (call $__pow10 (local.get $__inl3_i))
                          )
                        )
                      )
                      (i32.store8
                        (i32.add (local.get $__inl3_buf) (local.get $__inl3_pos))
                        (i32.add
                          (i32.const 48)
                          (i32.rem_u (local.get $__inl3_j) (i32.const 10))
                        )
                      )
                      (local.set $__inl3_pos
                        (i32.add (local.get $__inl3_pos) (i32.const 1))
                      )
                      (local.set $__inl3_i
                        (i32.sub (local.get $__inl3_i) (i32.const 1))
                      )
                      (br $__inl3L_fl)
                    )
                  )
                )
              )
              ;; Default mode: strip trailing zeros and dot — only when a fractional part was emitted.
              ;; Gating on $prec>0 prevents stripping zeros from the integer part (e.g. 1079623680 → 107962368)
              ;; for values where auto-fit reduced prec to 0 because the scaled integer wouldn't fit i32.
              (if
                (i32.and
                  (i32.eqz (local.get $__inl3_mode))
                  (i32.gt_s (local.get $__inl3_prec) (i32.const 0))
                )
                (then
                  (block $__inl3L_sd
                    (loop $__inl3L_sl
                      (br_if $__inl3L_sd
                        (i32.le_s (local.get $__inl3_pos) (i32.const 0))
                      )
                      (br_if $__inl3L_sd
                        (i32.ne
                          (i32.load8_u
                            (i32.add
                              (local.get $__inl3_buf)
                              (local.tee $__inl3___pe3
                                (i32.sub (local.get $__inl3_pos) (i32.const 1))
                              )
                            )
                          )
                          (i32.const 48)
                        )
                      )
                      (local.set $__inl3_pos (local.get $__inl3___pe3))
                      (br $__inl3L_sl)
                    )
                  )
                  (if
                    (i32.and
                      (i32.gt_s (local.get $__inl3_pos) (i32.const 0))
                      (i32.eq
                        (i32.load8_u
                          (i32.add
                            (local.get $__inl3_buf)
                            (i32.sub (local.get $__inl3_pos) (i32.const 1))
                          )
                        )
                        (i32.const 46)
                      )
                    )
                    (then
                      (local.set $__inl3_pos
                        (i32.sub (local.get $__inl3_pos) (i32.const 1))
                      )
                    )
                  )
                )
              )
              (call $__mkstr
                (local.get $__inl3_buf)
                (local.get $__inl3_pos)
              )
            )
          )
        )
      )
    )
    (if
      (i64.eq (local.get $val) (i64.const 0x7FF8000100000000))
      (then
        (return
          (i64.reinterpret_f64
            (call $__static_str (i32.const 5))
          )
        )
      )
    )
    (if
      (i64.eq (local.get $val) (i64.const 0x7FF8000200000000))
      (then
        (return
          (i64.reinterpret_f64
            (call $__static_str (i32.const 6))
          )
        )
      )
    )
    (if
      (i64.eq (local.get $val) (i64.const 0x7FF8000400000000))
      (then
        (return
          (i64.reinterpret_f64
            (call $__static_str (i32.const 4))
          )
        )
      )
    )
    (if
      (i64.eq (local.get $val) (i64.const 0x7FF8000500000000))
      (then
        (return
          (i64.reinterpret_f64
            (call $__static_str (i32.const 3))
          )
        )
      )
    )
    (local.set $__inl3_prec
      (i32.and
        (i32.wrap_i64
          (i64.shr_u (local.get $val) (i64.const 47))
        )
        (i32.const 15)
      )
    )
    ;; Plain NaN (type=0) → "NaN" string
    (if
      (i32.eqz (local.get $__inl3_prec))
      (then
        (return
          (i64.reinterpret_f64
            (call $__static_str (i32.const 0))
          )
        )
      )
    )
    ;; Array (type=1) → join(",") like JS Array.toString()
    (if
      (i32.eq (local.get $__inl3_prec) (i32.const 1))
      (then
        (return
          (i64.reinterpret_f64
            (block $__inl4
              (result f64)
              (local.set $__inl4_arr (local.get $val))
              (local.set $__inl4_sep
                (i64.reinterpret_f64
                  (call $__mkptr
                    (i32.const 4)
                    (i32.const 16385)
                    (i32.const 44)
                  )
                )
              )
              (local.set $__inl4_isTyped
                (i32.eq
                  (i32.and
                    (i32.wrap_i64
                      (i64.shr_u (local.get $val) (i64.const 47))
                    )
                    (i32.const 15)
                  )
                  (i32.const 3)
                )
              )
              (local.set $__inl4_off
                (call $__ptr_offset (local.get $val))
              )
              (local.set $__inl4_len
                (call $__len (local.get $val))
              )
              (if
                (i32.eqz (local.get $__inl4_len))
                (then
                  (br $__inl4
                    (call $__mkptr
                      (i32.const 4)
                      (i32.const 16384)
                      (i32.const 0)
                    )
                  )
                )
              )
              (local.set $__inl4_result
                (f64.reinterpret_i64
                  (call $__to_str
                    (if
                      (result i64)
                      (local.get $__inl4_isTyped)
                      (then
                        (i64.reinterpret_f64
                          (call $__typed_idx
                            (local.get $__inl4_arr)
                            (i32.const 0)
                          )
                        )
                      )
                      (else
                        (i64.load (local.get $__inl4_off))
                      )
                    )
                  )
                )
              )
              (local.set $__inl4_i (i32.const 1))
              (block $__inl4L_done
                (loop $__inl4L_loop
                  (br_if $__inl4L_done
                    (i32.ge_s (local.get $__inl4_i) (local.get $__inl4_len))
                  )
                  (local.set $__inl4_result
                    (call $__str_concat
                      (i64.reinterpret_f64 (local.get $__inl4_result))
                      (local.get $__inl4_sep)
                    )
                  )
                  (local.set $__inl4_result
                    (call $__str_concat
                      (i64.reinterpret_f64 (local.get $__inl4_result))
                      (if
                        (result i64)
                        (local.get $__inl4_isTyped)
                        (then
                          (i64.reinterpret_f64
                            (call $__typed_idx
                              (local.get $__inl4_arr)
                              (local.get $__inl4_i)
                            )
                          )
                        )
                        (else
                          (i64.load
                            (i32.add
                              (local.get $__inl4_off)
                              (i32.shl (local.get $__inl4_i) (i32.const 3))
                            )
                          )
                        )
                      )
                    )
                  )
                  (local.set $__inl4_i
                    (i32.add (local.get $__inl4_i) (i32.const 1))
                  )
                  (br $__inl4L_loop)
                )
              )
              (local.get $__inl4_result)
            )
          )
        )
      )
    )
    (local.get $val)
  )
  (func $__skipws
    (param $v i64)
    (param $i i32)
    (param $len i32)
    (result i32)
    (local $b i32)
    (local $cp i32)
    (local $n i32)
    (local $sbase i32)
    (local.set $sbase
      (i32.wrap_i64
        (i64.and (local.get $v) (i64.const 4294967295))
      )
    )
    (block $done
      (loop $l
        (br_if $done
          (i32.ge_s (local.get $i) (local.get $len))
        )
        (local.set $b
          (if
            (result i32)
            (i64.eqz
              (i64.and (local.get $v) (i64.const 0x0000400000000000))
            )
            (then
              (i32.load8_u
                (i32.add (local.get $sbase) (local.get $i))
              )
            )
            (else
              (call $__char_at
                (local.get $v)
                (local.get $i)
              )
            )
          )
        )
        (if
          (i32.lt_u (local.get $b) (i32.const 0x80))
          (then
            (local.set $cp (local.get $b))
            (local.set $n (i32.const 1))
          )
          (else
            (if
              (i32.lt_u (local.get $b) (i32.const 0xe0))
              (then
                (local.set $n (i32.const 2))
                (local.set $cp
                  (i32.or
                    (i32.shl
                      (i32.and (local.get $b) (i32.const 0x1f))
                      (i32.const 6)
                    )
                    (i32.and
                      (call $__char_at
                        (local.get $v)
                        (i32.add (local.get $i) (i32.const 1))
                      )
                      (i32.const 0x3f)
                    )
                  )
                )
              )
              (else
                (if
                  (i32.lt_u (local.get $b) (i32.const 0xf0))
                  (then
                    (local.set $n (i32.const 3))
                    (local.set $cp
                      (i32.or
                        (i32.or
                          (i32.shl
                            (i32.and (local.get $b) (i32.const 0x0f))
                            (i32.const 12)
                          )
                          (i32.shl
                            (i32.and
                              (call $__char_at
                                (local.get $v)
                                (i32.add (local.get $i) (i32.const 1))
                              )
                              (i32.const 0x3f)
                            )
                            (i32.const 6)
                          )
                        )
                        (i32.and
                          (call $__char_at
                            (local.get $v)
                            (i32.add (local.get $i) (i32.const 2))
                          )
                          (i32.const 0x3f)
                        )
                      )
                    )
                  )
                  (else
                    (return (local.get $i))
                  )
                )
              )
            )
          )
        )
        (br_if $done
          (i32.eqz
            (i32.or
              (i32.or
                (i32.and
                  (i32.ge_s (local.get $cp) (i32.const 9))
                  (i32.le_s (local.get $cp) (i32.const 13))
                )
                (i32.or
                  (i32.eq (local.get $cp) (i32.const 32))
                  (i32.eq (local.get $cp) (i32.const 160))
                )
              )
              (i32.or
                (i32.or
                  (i32.eq (local.get $cp) (i32.const 0x1680))
                  (i32.and
                    (i32.ge_s (local.get $cp) (i32.const 0x2000))
                    (i32.le_s (local.get $cp) (i32.const 0x200a))
                  )
                )
                (i32.or
                  (i32.or
                    (i32.eq (local.get $cp) (i32.const 0x2028))
                    (i32.eq (local.get $cp) (i32.const 0x2029))
                  )
                  (i32.or
                    (i32.or
                      (i32.eq (local.get $cp) (i32.const 0x202f))
                      (i32.eq (local.get $cp) (i32.const 0x205f))
                    )
                    (i32.or
                      (i32.eq (local.get $cp) (i32.const 0x3000))
                      (i32.eq (local.get $cp) (i32.const 0xfeff))
                    )
                  )
                )
              )
            )
          )
        )
        (local.set $i
          (i32.add (local.get $i) (local.get $n))
        )
        (br $l)
      )
    )
    (local.get $i)
  )
  (func $__mkstr
    (param $buf i32)
    (param $len i32)
    (result f64)
    (local $i i32)
    (local $packed i32)
    (local $b i32)
    ;; SSO fast path: ≤4 ASCII bytes pack into the pointer with no allocation, so a
    ;; number-format result doesn't displace a heap-top accumulator — keeping the
    ;; canonical `s += n.toString(r)` builder O(n) via the bump-extend path.
    (if
      (i32.le_u (local.get $len) (i32.const 4))
      (then
        (block $heap
          (loop $pk
            (if
              (i32.lt_u (local.get $i) (local.get $len))
              (then
                (local.set $b
                  (i32.load8_u
                    (i32.add (local.get $buf) (local.get $i))
                  )
                )
                (br_if $heap
                  (i32.ge_u (local.get $b) (i32.const 0x80))
                )
                (local.set $packed
                  (i32.or
                    (local.get $packed)
                    (i32.shl
                      (local.get $b)
                      (i32.shl (local.get $i) (i32.const 3))
                    )
                  )
                )
                (local.set $i
                  (i32.add (local.get $i) (i32.const 1))
                )
                (br $pk)
              )
            )
          )
          (return
            (call $__mkptr
              (i32.const 4)
              (i32.or (i32.const 16384) (local.get $len))
              (local.get $packed)
            )
          )
        )
      )
    )
    (local.set $i
      (call $__alloc
        (i32.add (i32.const 4) (local.get $len))
      )
    )
    (i32.store (local.get $i) (local.get $len))
    (local.set $i
      (i32.add (local.get $i) (i32.const 4))
    )
    (memory.copy
      (local.get $i)
      (local.get $buf)
      (local.get $len)
    )
    (call $__mkptr
      (i32.const 4)
      (i32.const 0)
      (local.get $i)
    )
  )
  (func $__ptr_offset_fwd
    (param $off i32)
    (result i32)
    (block $done
      (loop $follow
        (br_if $done
          (i32.lt_u (local.get $off) (i32.const 8))
        )
        (br_if $done
          (i32.gt_u
            (local.get $off)
            (i32.shl (memory.size) (i32.const 16))
          )
        )
        (br_if $done
          (i32.ne
            (i32.load
              (i32.sub (local.get $off) (i32.const 4))
            )
            (i32.const -1)
          )
        )
        (local.set $off
          (i32.load
            (i32.sub (local.get $off) (i32.const 8))
          )
        )
        (br $follow)
      )
    )
    (local.get $off)
  )
  (func $__str_byteLen
    (param $ptr i64)
    (result i32)
    (local $t i32)
    (local $off i32)
    (local $aux i32)
    (local.set $t
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $ptr) (i64.const 47))
          (i64.const 15)
        )
      )
    )
    (if
      (result i32)
      (i32.eq (local.get $t) (i32.const 4))
      (then
        (local.set $aux
          (i32.and
            (i32.wrap_i64
              (i64.shr_u (local.get $ptr) (i64.const 32))
            )
            (i32.const 32767)
          )
        )
        (if
          (result i32)
          (i32.and (local.get $aux) (i32.const 16384))
          (then
            (i32.and (local.get $aux) (i32.const 16383))
          )
          (else
            (if
              (result i32)
              (i32.and (local.get $aux) (i32.const 8192))
              ;; view: length lives in aux[12:0], not a header.
              (then
                (i32.and (local.get $aux) (i32.const 8191))
              )
              (else
                (local.set $off
                  (i32.wrap_i64
                    (i64.and (local.get $ptr) (i64.const 4294967295))
                  )
                )
                (if
                  (result i32)
                  (i32.ge_u (local.get $off) (i32.const 4))
                  (then
                    (i32.load
                      (i32.sub (local.get $off) (i32.const 4))
                    )
                  )
                  (else (i32.const 0))
                )
              )
            )
          )
        )
      )
      (else (i32.const 0))
    )
  )
  (func $__itoa
    (param $val i32)
    (param $buf i32)
    (result i32)
    (local $len i32)
    (local $i i32)
    (local $j i32)
    (local $tmp i32)
    (local $__pe0 i32)
    (local $__pe1 i32)
    (if
      (i32.eqz (local.get $val))
      (then
        (i32.store8 (local.get $buf) (i32.const 48))
        (return (i32.const 1))
      )
    )
    (local.set $tmp (local.get $val))
    (block $d
      (loop $l
        (br_if $d
          (i32.eqz (local.get $tmp))
        )
        (i32.store8
          (i32.add (local.get $buf) (local.get $len))
          (i32.add
            (i32.const 48)
            (i32.rem_u (local.get $tmp) (i32.const 10))
          )
        )
        (local.set $tmp
          (i32.div_u (local.get $tmp) (i32.const 10))
        )
        (local.set $len
          (i32.add (local.get $len) (i32.const 1))
        )
        (br $l)
      )
    )
    ;; Reverse
    (local.set $j
      (i32.sub (local.get $len) (i32.const 1))
    )
    (block $rev
      (loop $revl
        (br_if $rev
          (i32.ge_s (local.get $i) (local.get $j))
        )
        (local.set $tmp
          (i32.load8_u
            (local.tee $__pe0
              (i32.add (local.get $buf) (local.get $i))
            )
          )
        )
        (i32.store8
          (local.get $__pe0)
          (i32.load8_u
            (local.tee $__pe1
              (i32.add (local.get $buf) (local.get $j))
            )
          )
        )
        (i32.store8 (local.get $__pe1) (local.get $tmp))
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (local.set $j
          (i32.sub (local.get $j) (i32.const 1))
        )
        (br $revl)
      )
    )
    (local.get $len)
  )
  (func $__str_copy
    (param $src i64)
    (param $dst i32)
    (param $len i32)
    (local $w i32)
    (if
      (i64.ne
        (i64.and (local.get $src) (i64.const 0x0000400000000000))
        (i64.const 0)
      )
      (then
        ;; SSO: up to 4 chars packed in low 32 bits (LE byte order). Unroll: write 1/2/3/4 bytes
        ;; depending on len. (len > 4 is rare/disallowed in practice — fallback handles up to 4.)
        (local.set $w
          (i32.wrap_i64 (local.get $src))
        )
        (if
          (i32.ge_u (local.get $len) (i32.const 4))
          (then
            (i32.store (local.get $dst) (local.get $w))
          )
          (else
            (if
              (i32.eq (local.get $len) (i32.const 0))
              (then (return))
            )
            (i32.store8 (local.get $dst) (local.get $w))
            (if
              (i32.eq (local.get $len) (i32.const 1))
              (then (return))
            )
            (i32.store8 offset=1
              (local.get $dst)
              (i32.shr_u (local.get $w) (i32.const 8))
            )
            (if
              (i32.eq (local.get $len) (i32.const 2))
              (then (return))
            )
            (i32.store8 offset=2
              (local.get $dst)
              (i32.shr_u (local.get $w) (i32.const 16))
            )
          )
        )
      )
      (else
        ;; Heap STRING: memory.copy directly from string data
        (memory.copy
          (local.get $dst)
          (i32.wrap_i64
            (i64.and (local.get $src) (i64.const 4294967295))
          )
          (local.get $len)
        )
      )
    )
  )
  (func $__typed_idx
    (param $ptr i64)
    (param $i i32)
    (result f64)
    (local $t i32)
    (local $off i32)
    (local $et i32)
    (local $len i32)
    (local $aux i32)
    (local.set $t
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $ptr) (i64.const 47))
          (i64.const 15)
        )
      )
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $ptr) (i64.const 4294967295))
      )
    )
    ;; ARRAY fast path: follow forwarding inline, bounds-check against header len, f64.load — no $__len call.
    (if
      (i32.and
        (i32.eq (local.get $t) (i32.const 1))
        (i32.ge_u (local.get $off) (i32.const 8))
      )
      (then
        (if
          (i32.and
            (i32.const 1)
            (i32.le_u
              (local.get $off)
              (i32.shl (memory.size) (i32.const 16))
            )
          )
          (then
            (if
              (i32.eq
                (i32.load
                  (i32.sub (local.get $off) (i32.const 4))
                )
                (i32.const -1)
              )
              (then
                (local.set $off
                  (call $__ptr_offset_fwd (local.get $off))
                )
              )
            )
          )
        )
        (return
          (if
            (result f64)
            (i32.and
              (i32.ge_s (local.get $i) (i32.const 0))
              (i32.lt_u
                (local.get $i)
                (i32.load
                  (i32.sub (local.get $off) (i32.const 8))
                )
              )
            )
            (then
              (f64.load
                (i32.add
                  (local.get $off)
                  (i32.shl (local.get $i) (i32.const 3))
                )
              )
            )
            (else (f64.const nan:0x7FF8000200000000))
          )
        )
      )
    )
    (local.set $aux
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $ptr) (i64.const 32))
          (i64.const 32767)
        )
      )
    )
    (if
      (i32.and
        (i32.eq (local.get $t) (i32.const 3))
        (i32.ne
          (i32.and (local.get $aux) (i32.const 8))
          (i32.const 0)
        )
      )
      (then
        (local.set $off
          (i32.load offset=4 (local.get $off))
        )
      )
    )
    (local.set $len
      (call $__len (local.get $ptr))
    )
    (if
      (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len))
      )
      (then (f64.const nan:0x7FF8000200000000))
      (else
        (if
          (result f64)
          (i32.eq (local.get $t) (i32.const 3))
          (then
            (local.set $et
              (i32.and (local.get $aux) (i32.const 7))
            )
            (if
              (result f64)
              (i32.ge_u (local.get $et) (i32.const 6))
              (then
                (if
                  (result f64)
                  (i32.eq (local.get $et) (i32.const 7))
                  (then
                    (if
                      (result f64)
                      (i32.and (local.get $aux) (i32.const 16))
                      (then
                        (f64.reinterpret_i64
                          (i64.load
                            (i32.add
                              (local.get $off)
                              (i32.shl (local.get $i) (i32.const 3))
                            )
                          )
                        )
                      )
                      (else
                        (f64.load
                          (i32.add
                            (local.get $off)
                            (i32.shl (local.get $i) (i32.const 3))
                          )
                        )
                      )
                    )
                  )
                  (else
                    (f64.promote_f32
                      (f32.load
                        (i32.add
                          (local.get $off)
                          (i32.shl (local.get $i) (i32.const 2))
                        )
                      )
                    )
                  )
                )
              )
              (else
                (if
                  (result f64)
                  (i32.ge_u (local.get $et) (i32.const 4))
                  (then
                    (if
                      (result f64)
                      (i32.and (local.get $et) (i32.const 1))
                      (then
                        (f64.convert_i32_u
                          (i32.load
                            (i32.add
                              (local.get $off)
                              (i32.shl (local.get $i) (i32.const 2))
                            )
                          )
                        )
                      )
                      (else
                        (f64.convert_i32_s
                          (i32.load
                            (i32.add
                              (local.get $off)
                              (i32.shl (local.get $i) (i32.const 2))
                            )
                          )
                        )
                      )
                    )
                  )
                  (else
                    (if
                      (result f64)
                      (i32.ge_u (local.get $et) (i32.const 2))
                      (then
                        (if
                          (result f64)
                          (i32.and (local.get $et) (i32.const 1))
                          (then
                            (f64.convert_i32_u
                              (i32.load16_u
                                (i32.add
                                  (local.get $off)
                                  (i32.shl (local.get $i) (i32.const 1))
                                )
                              )
                            )
                          )
                          (else
                            (f64.convert_i32_s
                              (i32.load16_s
                                (i32.add
                                  (local.get $off)
                                  (i32.shl (local.get $i) (i32.const 1))
                                )
                              )
                            )
                          )
                        )
                      )
                      (else
                        (if
                          (result f64)
                          (i32.and (local.get $et) (i32.const 1))
                          (then
                            (f64.convert_i32_u
                              (i32.load8_u
                                (i32.add (local.get $off) (local.get $i))
                              )
                            )
                          )
                          (else
                            (f64.convert_i32_s
                              (i32.load8_s
                                (i32.add (local.get $off) (local.get $i))
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
          (else
            (f64.load
              (i32.add
                (local.get $off)
                (i32.shl (local.get $i) (i32.const 3))
              )
            )
          )
        )
      )
    )
  )
  (func $__alloc_hdr
    (param $len i32)
    (param $cap i32)
    (result i32)
    (local $ptr i32)
    (local.set $ptr
      (call $__alloc
        (i32.add
          (i32.const 16)
          (i32.shl (local.get $cap) (i32.const 3))
        )
      )
    )
    (i64.store (local.get $ptr) (i64.const 0))
    (i32.store offset=8
      (local.get $ptr)
      (local.get $len)
    )
    (i32.store offset=12
      (local.get $ptr)
      (local.get $cap)
    )
    (i32.add (local.get $ptr) (i32.const 16))
  )
  (func $math.cos
    (param $x f64)
    (result f64)
    (call $math.cos_core (local.get $x))
  )
  (func $math.cos_core
    (param $x f64)
    (result f64)
    (local $q f64)
    (local $q2 f64)
    (local $r f64)
    (if
      (f64.ne (local.get $x) (local.get $x))
      (then
        (return (f64.const nan))
      )
    )
    (if
      (f64.eq
        (f64.abs (local.get $x))
        (f64.const inf)
      )
      (then
        (return (f64.const nan))
      )
    )
    (local.set $q
      (f64.nearest
        (f64.mul (local.get $x) (f64.const 0.3183098861837907))
      )
    )
    (local.set $r
      (f64.sub
        (local.get $x)
        (f64.mul (local.get $q) (f64.const 3.141592653589793))
      )
    )
    (if
      (f64.gt
        (f64.abs (local.get $r))
        (f64.const 1.5707963267948966)
      )
      (then
        (local.set $q2
          (f64.nearest
            (f64.mul (local.get $r) (f64.const 0.3183098861837907))
          )
        )
        (local.set $r
          (f64.sub
            (local.get $r)
            (f64.mul (local.get $q2) (f64.const 3.141592653589793))
          )
        )
        (local.set $q
          (f64.add (local.get $q) (local.get $q2))
        )
      )
    )
    (local.set $q
      (f64.sub
        (local.get $q)
        (f64.mul
          (f64.const 2)
          (f64.nearest
            (f64.mul (local.get $q) (f64.const 0.5))
          )
        )
      )
    )
    (local.set $q2
      (f64.mul (local.get $r) (local.get $r))
    )
    (local.set $r
      (f64.add
        (f64.const 1)
        (f64.mul
          (local.get $q2)
          (f64.add
            (f64.const -0.4999993043717576)
            (f64.mul
              (local.get $q2)
              (f64.add
                (f64.const 0.04166402742354027)
                (f64.mul
                  (local.get $q2)
                  (f64.add
                    (f64.const -0.0013856638518363177)
                    (f64.mul (local.get $q2) (f64.const 0.00002321737177898552))
                  )
                )
              )
            )
          )
        )
      )
    )
    ;; Negate for odd quasiperiods
    (if
      (f64.gt
        (f64.abs (local.get $q))
        (f64.const 0.5)
      )
      (then
        (local.set $r
          (f64.neg (local.get $r))
        )
      )
    )
    ;; Clamp to [-1, 1]: polynomial approximation can overshoot by ~1e-8 near peaks.
    ;; Branchless (f64.min/f64.max) avoids branch misprediction near peaks.
    (f64.min
      (f64.max (local.get $r) (f64.const -1.0))
      (f64.const 1.0)
    )
  )
  (func $__memgrow
    (param $next i32)
    (local $cur i32)
    (local $need i32)
    (local.set $need
      (i32.wrap_i64
        (i64.shr_u
          (i64.add
            (i64.extend_i32_u (local.get $next))
            (i64.const 65535)
          )
          (i64.const 16)
        )
      )
    )
    (if
      (i32.gt_u (local.get $need) (memory.size))
      (then
        (if
          (i64.gt_u
            (i64.extend_i32_u (local.get $need))
            (i64.const 65536)
          )
          (then (unreachable))
        )
        (local.set $cur
          (i32.sub (local.get $need) (memory.size))
        )
        ;; minimum delta
        (if
          (i32.lt_u (local.get $cur) (memory.size))
          (then
            (local.set $cur (memory.size))
          )
        )
        ;; geometric
        (if
          (i32.gt_u
            (i32.add (local.get $cur) (memory.size))
            (i32.const 65536)
          )
          (then
            (local.set $cur
              (i32.sub (i32.const 65536) (memory.size))
            )
          )
        )
        ;; cap at wasm32 max
        (if
          (i32.eq
            (memory.grow (local.get $cur))
            (i32.const -1)
          )
          (then
            (if
              (i32.eq
                (memory.grow
                  (i32.sub (local.get $need) (memory.size))
                )
                (i32.const -1)
              )
              (then (unreachable))
            )
          )
        )
      )
    )
  )
  (func $__typed_shift
    (param $et i32)
    (result i32)
    (if
      (result i32)
      (i32.eq (local.get $et) (i32.const 7))
      (then (i32.const 3))
      (else
        (if
          (result i32)
          (i32.ge_u (local.get $et) (i32.const 4))
          (then (i32.const 2))
          (else
            (i32.shr_u (local.get $et) (i32.const 1))
          )
        )
      )
    )
  )
  (func $__toExp
    (param $val f64)
    (param $prec i32)
    (param $strip i32)
    (result f64)
    (local $buf i32)
    (local $pos i32)
    (local $neg i32)
    (local $exp i32)
    (local $i i32)
    (local $mantissa f64)
    (local $scale f64)
    (local $__pe0 i32)
    (if
      (f64.ne (local.get $val) (local.get $val))
      (then
        (return
          (call $__static_str (i32.const 0))
        )
      )
    )
    (if
      (f64.eq (local.get $val) (f64.const inf))
      (then
        (return
          (call $__static_str (i32.const 1))
        )
      )
    )
    (if
      (f64.eq (local.get $val) (f64.const -inf))
      (then
        (return
          (call $__static_str (i32.const 2))
        )
      )
    )
    ;; The scaled mantissa is (prec+1) digits; cap prec at 8 so it stays below
    ;; 2^32 (10^9 < 2^32 < 10^10), otherwise i32.trunc_f64_u below traps with
    ;; "float unrepresentable in integer range" — e.g. 7.5e-151 normalizes to
    ;; 7.5 and 7.5*10^9 already overflows an unsigned i32.
    (if
      (i32.gt_s (local.get $prec) (i32.const 8))
      (then
        (local.set $prec (i32.const 8))
      )
    )
    (local.set $buf
      (call $__alloc (i32.const 32))
    )
    ;; Sign
    (if
      (f64.lt (local.get $val) (f64.const 0))
      (then
        (local.set $neg (i32.const 1))
        (local.set $val
          (f64.neg (local.get $val))
        )
      )
    )
    (if
      (i32.and
        (f64.eq (local.get $val) (f64.const 0))
        (local.get $neg)
      )
      (then
        (local.set $neg (i32.const 0))
      )
    )
    (if
      (local.get $neg)
      (then
        (i32.store8 (local.get $buf) (i32.const 45))
        (local.set $pos (i32.const 1))
      )
    )
    ;; Normalize: 1 <= val < 10
    (if
      (f64.gt (local.get $val) (f64.const 0))
      (then
        (block $d1
          (loop $l1
            (br_if $d1
              (f64.lt (local.get $val) (f64.const 10))
            )
            (local.set $val
              (f64.div (local.get $val) (f64.const 10))
            )
            (local.set $exp
              (i32.add (local.get $exp) (i32.const 1))
            )
            (br $l1)
          )
        )
        (block $d2
          (loop $l2
            (br_if $d2
              (f64.ge (local.get $val) (f64.const 1))
            )
            (local.set $val
              (f64.mul (local.get $val) (f64.const 10))
            )
            (local.set $exp
              (i32.sub (local.get $exp) (i32.const 1))
            )
            (br $l2)
          )
        )
      )
    )
    ;; Scale to integer mantissa: nearest(val * 10^prec). Ties-to-even (see __ftoa note).
    (local.set $scale
      (call $__pow10 (local.get $prec))
    )
    (local.set $mantissa
      (f64.nearest
        (f64.mul (local.get $val) (local.get $scale))
      )
    )
    ;; Rounding overflow (e.g. 9.95 → 1000 when prec=1, scale=10)
    (if
      (f64.ge
        (local.get $mantissa)
        (f64.mul (f64.const 10) (local.get $scale))
      )
      (then
        (local.set $mantissa
          (f64.div (local.get $mantissa) (f64.const 10))
        )
        (local.set $exp
          (i32.add (local.get $exp) (i32.const 1))
        )
      )
    )
    ;; Write mantissa digits via itoa
    (local.set $neg
      (call $__itoa
        (i32.trunc_f64_u (local.get $mantissa))
        (i32.add (local.get $buf) (local.get $pos))
      )
    )
    ;; Insert '.' after first digit
    (if
      (i32.gt_s (local.get $prec) (i32.const 0))
      (then
        (local.set $i (local.get $neg))
        (block $md
          (loop $ml
            (br_if $md
              (i32.le_s (local.get $i) (i32.const 1))
            )
            (i32.store8
              (i32.add
                (local.get $buf)
                (i32.add (local.get $pos) (local.get $i))
              )
              (i32.load8_u
                (i32.add
                  (local.get $buf)
                  (i32.add
                    (local.get $pos)
                    (local.tee $__pe0
                      (i32.sub (local.get $i) (i32.const 1))
                    )
                  )
                )
              )
            )
            (local.set $i (local.get $__pe0))
            (br $ml)
          )
        )
        (i32.store8
          (i32.add
            (i32.add (local.get $buf) (local.get $pos))
            (i32.const 1)
          )
          (i32.const 46)
        )
        (local.set $pos
          (i32.add
            (i32.add (local.get $pos) (local.get $neg))
            (i32.const 1)
          )
        )
      )
      (else
        (local.set $pos
          (i32.add (local.get $pos) (local.get $neg))
        )
      )
    )
    ;; Shortest form: drop trailing zeros (and a bare '.') from the mantissa.
    ;; The leading digit is always 1-9, so the walk-back stops at the '.' at worst.
    (if
      (i32.and
        (local.get $strip)
        (i32.gt_s (local.get $prec) (i32.const 0))
      )
      (then
        (block $sz
          (loop $szl
            (br_if $sz
              (i32.ne
                (i32.load8_u
                  (i32.sub
                    (i32.add (local.get $buf) (local.get $pos))
                    (i32.const 1)
                  )
                )
                (i32.const 48)
              )
            )
            (local.set $pos
              (i32.sub (local.get $pos) (i32.const 1))
            )
            (br $szl)
          )
        )
        (if
          (i32.eq
            (i32.load8_u
              (i32.sub
                (i32.add (local.get $buf) (local.get $pos))
                (i32.const 1)
              )
            )
            (i32.const 46)
          )
          (then
            (local.set $pos
              (i32.sub (local.get $pos) (i32.const 1))
            )
          )
        )
      )
    )
    ;; Write 'e', sign, exponent
    (i32.store8
      (i32.add (local.get $buf) (local.get $pos))
      (i32.const 101)
    )
    (local.set $pos
      (i32.add (local.get $pos) (i32.const 1))
    )
    (if
      (i32.lt_s (local.get $exp) (i32.const 0))
      (then
        (i32.store8
          (i32.add (local.get $buf) (local.get $pos))
          (i32.const 45)
        )
        (local.set $pos
          (i32.add (local.get $pos) (i32.const 1))
        )
        (local.set $exp
          (i32.sub (i32.const 0) (local.get $exp))
        )
      )
      (else
        (i32.store8
          (i32.add (local.get $buf) (local.get $pos))
          (i32.const 43)
        )
        (local.set $pos
          (i32.add (local.get $pos) (i32.const 1))
        )
      )
    )
    (local.set $pos
      (i32.add
        (local.get $pos)
        (call $__itoa
          (local.get $exp)
          (i32.add (local.get $buf) (local.get $pos))
        )
      )
    )
    (call $__mkstr
      (local.get $buf)
      (local.get $pos)
    )
  )
  (func $__str_concat
    (param $a i64)
    (param $b i64)
    (result f64)
    (local $alen i32)
    (local $blen i32)
    (local $total i32)
    (local $ta i32)
    (local $aoff i32)
    (local $newHeap i32)
    ;; Coerce operands to strings if needed
    (local.set $a
      (call $__to_str (local.get $a))
    )
    (local.set $b
      (call $__to_str (local.get $b))
    )
    (local.set $alen
      (call $__str_byteLen (local.get $a))
    )
    (local.set $blen
      (call $__str_byteLen (local.get $b))
    )
    (local.set $total
      (i32.add (local.get $alen) (local.get $blen))
    )
    (if
      (i32.eqz (local.get $total))
      (then
        (return
          (call $__mkptr
            (i32.const 4)
            (i32.const 16384)
            (i32.const 0)
          )
        )
      )
    )
    (if
      (i32.and
        (i32.and
          (i64.ne
            (i64.and (local.get $a) (i64.const 0x0000400000000000))
            (i64.const 0)
          )
          (i64.ne
            (i64.and (local.get $b) (i64.const 0x0000400000000000))
            (i64.const 0)
          )
        )
        (i32.le_u (local.get $total) (i32.const 4))
      )
      (then
        (return
          (call $__mkptr
            (i32.const 4)
            (i32.or (i32.const 16384) (local.get $total))
            (i32.or
              (i32.wrap_i64
                (i64.and (local.get $a) (i64.const 0xFFFFFFFF))
              )
              (i32.shl
                (i32.wrap_i64
                  (i64.and (local.get $b) (i64.const 0xFFFFFFFF))
                )
                (i32.shl (local.get $alen) (i32.const 3))
              )
            )
          )
        )
      )
    )
    (local.set $ta
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $a) (i64.const 47))
          (i64.const 15)
        )
      )
    )
    (local.set $aoff
      (i32.wrap_i64
        (i64.and (local.get $a) (i64.const 4294967295))
      )
    )
    ;; Bump-extend requires an OWN heap STRING — not SSO (offset holds packed bytes)
    ;; and not a slice/view (bumping would corrupt the parent buffer it points into).
    (if
      (i32.and
        (i32.and
          (i32.eq (local.get $ta) (i32.const 4))
          (i32.and
            (i64.eqz
              (i64.and (local.get $a) (i64.const 0x0000400000000000))
            )
            (i64.eqz
              (i64.and (local.get $a) (i64.const 0x0000200000000000))
            )
          )
        )
        (i32.eq
          (i32.and
            (i32.add
              (i32.add (local.get $aoff) (local.get $alen))
              (i32.const 7)
            )
            (i32.const -8)
          )
          (global.get $__heap)
        )
      )
      (then
        (local.set $newHeap
          (i32.and
            (i32.add
              (i32.add (local.get $aoff) (local.get $total))
              (i32.const 7)
            )
            (i32.const -8)
          )
        )
        (call $__memgrow (local.get $newHeap))
        (call $__str_copy
          (local.get $b)
          (i32.add (local.get $aoff) (local.get $alen))
          (local.get $blen)
        )
        (i32.store
          (i32.sub (local.get $aoff) (i32.const 4))
          (local.get $total)
        )
        (global.set $__heap (local.get $newHeap))
        (return
          (f64.reinterpret_i64 (local.get $a))
        )
      )
    )
    (local.set $ta
      (call $__alloc
        (i32.add (i32.const 4) (local.get $total))
      )
    )
    (i32.store (local.get $ta) (local.get $total))
    (local.set $ta
      (i32.add (local.get $ta) (i32.const 4))
    )
    (call $__str_copy
      (local.get $a)
      (local.get $ta)
      (local.get $alen)
    )
    (call $__str_copy
      (local.get $b)
      (i32.add (local.get $ta) (local.get $alen))
      (local.get $blen)
    )
    (call $__mkptr
      (i32.const 4)
      (i32.const 0)
      (local.get $ta)
    )
  )
  (func $math.sin_core
    (param $x f64)
    (result f64)
    (local $q f64)
    (local $q2 f64)
    (local $r f64)
    (if
      (f64.ne (local.get $x) (local.get $x))
      (then
        (return (f64.const nan))
      )
    )
    (if
      (f64.eq
        (f64.abs (local.get $x))
        (f64.const inf)
      )
      (then
        (return (f64.const nan))
      )
    )
    ;; |x| ≤ 2⁻²⁷: sin(x) = x to within a fraction of an ulp, and returning x preserves the
    ;; sign of ±0 (the range reduction below would turn -0 into +0: -0 − (-0·π) = +0).
    (if
      (f64.lt
        (f64.abs (local.get $x))
        (f64.const 7.450580596923828e-9)
      )
      (then
        (return (local.get $x))
      )
    )
    (local.set $q
      (f64.nearest
        (f64.mul (local.get $x) (f64.const 0.3183098861837907))
      )
    )
    (local.set $r
      (f64.sub
        (local.get $x)
        (f64.mul (local.get $q) (f64.const 3.141592653589793))
      )
    )
    (if
      (f64.gt
        (f64.abs (local.get $r))
        (f64.const 1.5707963267948966)
      )
      (then
        (local.set $q2
          (f64.nearest
            (f64.mul (local.get $r) (f64.const 0.3183098861837907))
          )
        )
        (local.set $r
          (f64.sub
            (local.get $r)
            (f64.mul (local.get $q2) (f64.const 3.141592653589793))
          )
        )
        (local.set $q
          (f64.add (local.get $q) (local.get $q2))
        )
      )
    )
    (local.set $q
      (f64.sub
        (local.get $q)
        (f64.mul
          (f64.const 2)
          (f64.nearest
            (f64.mul (local.get $q) (f64.const 0.5))
          )
        )
      )
    )
    (local.set $q2
      (f64.mul (local.get $r) (local.get $r))
    )
    (local.set $r
      (f64.mul
        (local.get $r)
        (f64.add
          (f64.const 1)
          (f64.mul
            (local.get $q2)
            (f64.add
              (f64.const -0.16666660296130772)
              (f64.mul
                (local.get $q2)
                (f64.add
                  (f64.const 0.008333091744946387)
                  (f64.mul
                    (local.get $q2)
                    (f64.add
                      (f64.const -0.00019811771757028443)
                      (f64.mul (local.get $q2) (f64.const 0.000002611054662215034))
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
    ;; Negate for odd quasiperiods
    (if
      (f64.gt
        (f64.abs (local.get $q))
        (f64.const 0.5)
      )
      (then
        (local.set $r
          (f64.neg (local.get $r))
        )
      )
    )
    ;; Clamp to [-1, 1]: polynomial approximation can overshoot by ~1e-8 near peaks.
    ;; Branchless (f64.min/f64.max) avoids branch misprediction near peaks.
    (f64.min
      (f64.max (local.get $r) (f64.const -1.0))
      (f64.const 1.0)
    )
  )
  (func $math.pow
    (param $x f64)
    (param $y f64)
    (result f64)
    (local $result f64)
    (local $n i32)
    (local $neg_base i32)
    (local $abs_x f64)
    ;; y == 0 -> 1 (covers pow(NaN,0), pow(±0,0), pow(±Inf,0))
    (local $__pe0 f64)
    (if
      (f64.eq (local.get $y) (f64.const 0.0))
      (then
        (return (f64.const 1.0))
      )
    )
    ;; y is NaN -> NaN
    (if
      (f64.ne (local.get $y) (local.get $y))
      (then
        (return (local.get $y))
      )
    )
    ;; x is NaN -> NaN
    (if
      (f64.ne (local.get $x) (local.get $x))
      (then
        (return (local.get $x))
      )
    )
    ;; y is ±Infinity
    (if
      (f64.eq
        (f64.abs (local.get $y))
        (f64.const inf)
      )
      (then
        (local.set $abs_x
          (f64.abs (local.get $x))
        )
        (if
          (f64.eq (local.get $abs_x) (f64.const 1.0))
          (then
            (return (f64.const nan))
          )
        )
        (if
          (i32.eq
            (f64.gt (local.get $abs_x) (f64.const 1.0))
            (f64.gt (local.get $y) (f64.const 0.0))
          )
          (then
            (return (f64.const inf))
          )
          (else
            (return (f64.const 0.0))
          )
        )
      )
    )
    ;; x == 1 -> 1 (after y=±Inf check, so 1**Inf already returned NaN)
    (if
      (f64.eq (local.get $x) (f64.const 1.0))
      (then
        (return (f64.const 1.0))
      )
    )
    ;; y == 1 -> x (preserves -0 for (-0)**1)
    (if
      (f64.eq (local.get $y) (f64.const 1.0))
      (then
        (return (local.get $x))
      )
    )
    ;; integer fast path: y integer in i32 range. Binary exponentiation is
    ;; O(log |n|) so the bound only matters for i32.trunc_f64_s safety.
    ;; Also covers ±Infinity x: abs_x stays Inf through the loop, 1/Inf=0,
    ;; with neg_base (x<0 && odd y) producing -0 — required for (-Inf)**-odd.
    ;; Runs before the x==0 fallback so (-0)**oddInt correctly returns ∓0/∓Inf.
    (if
      (i32.and
        (f64.eq
          (f64.nearest (local.get $y))
          (local.get $y)
        )
        (f64.lt
          (f64.abs (local.get $y))
          (f64.const 2147483648.0)
        )
      )
      (then
        (local.set $abs_x
          (f64.abs (local.get $x))
        )
        ;; copysign(1, x) gives -1 for any x with sign bit set (incl. -0); f64.lt picks that up.
        (local.set $neg_base
          (i32.and
            (f64.lt
              (f64.copysign (f64.const 1.0) (local.get $x))
              (f64.const 0.0)
            )
            (i32.and
              (i32.trunc_f64_s (local.get $y))
              (i32.const 1)
            )
          )
        )
        (local.set $n
          (i32.trunc_f64_s
            (f64.abs (local.get $y))
          )
        )
        (local.set $result (f64.const 1.0))
        (block $done
          (loop $loop
            (br_if $done
              (i32.le_s (local.get $n) (i32.const 0))
            )
            (if
              (i32.and (local.get $n) (i32.const 1))
              (then
                (local.set $result
                  (f64.mul (local.get $result) (local.get $abs_x))
                )
              )
            )
            (local.set $abs_x
              (f64.mul (local.get $abs_x) (local.get $abs_x))
            )
            (local.set $n
              (i32.shr_s (local.get $n) (i32.const 1))
            )
            (br $loop)
          )
        )
        (if
          (f64.lt (local.get $y) (f64.const 0.0))
          (then
            (local.set $result
              (f64.div (f64.const 1.0) (local.get $result))
            )
          )
        )
        (if
          (local.get $neg_base)
          (then
            (local.set $result
              (f64.neg (local.get $result))
            )
          )
        )
        (return (local.get $result))
      )
    )
    ;; x is ±Infinity with |y| >= 2^31 (the i32 fast path above handles smaller y):
    ;; magnitude is Inf for y>0, 0 for y<0; sign is negative only when x is -Inf
    ;; and y is an odd integer. Odd-ness is tested in f64 (y, y/2 both integral)
    ;; to avoid an i32.trunc trap on |y| beyond i32 range.
    (if
      (f64.eq
        (f64.abs (local.get $x))
        (f64.const inf)
      )
      (then
        (local.set $result
          (select
            (f64.const inf)
            (f64.const 0.0)
            (f64.gt (local.get $y) (f64.const 0.0))
          )
        )
        (if
          (i32.and
            (f64.lt (local.get $x) (f64.const 0.0))
            (i32.and
              (f64.eq
                (f64.nearest (local.get $y))
                (local.get $y)
              )
              (f64.ne
                (f64.nearest
                  (local.tee $__pe0
                    (f64.mul (local.get $y) (f64.const 0.5))
                  )
                )
                (local.get $__pe0)
              )
            )
          )
          (then
            (local.set $result
              (f64.neg (local.get $result))
            )
          )
        )
        (return (local.get $result))
      )
    )
    ;; x == 0 with non-integer y -> y<0 ? Infinity : 0 (sign-of-zero only matters for integer y, handled above)
    (if
      (f64.eq (local.get $x) (f64.const 0.0))
      (then
        (if
          (f64.lt (local.get $y) (f64.const 0.0))
          (then
            (return (f64.const inf))
          )
          (else
            (return (f64.const 0.0))
          )
        )
      )
    )
    ;; x < 0, non-integer finite y -> NaN
    (if
      (f64.lt (local.get $x) (f64.const 0.0))
      (then
        (return (f64.const nan))
      )
    )
    (local.set $abs_x
      (f64.mul
        (local.get $y)
        (call $math.log (local.get $x))
      )
    )
    (block $__inl6
      (result f64)
      (local.set $abs_x
        (f64.mul (local.get $abs_x) (f64.const 1.4426950408889634))
      )
      (local.set $neg_base (i32.const 0))
      (local.set $result (f64.const 0))
      (local.set $n (i32.const 0))
      (local.set $__pe0 (f64.const 0))
      (if
        (f64.ne (local.get $abs_x) (local.get $abs_x))
        (then
          (br $__inl6 (local.get $abs_x))
        )
      )
      (if
        (result f64)
        (f64.gt (local.get $abs_x) (f64.const 1024.0))
        (then (f64.const inf))
        (else
          (if
            (result f64)
            (f64.lt (local.get $abs_x) (f64.const -1075.0))
            (then (f64.const 0.0))
            (else
              (local.set $neg_base
                (i32.trunc_f64_s
                  (f64.nearest (local.get $abs_x))
                )
              )
              (local.set $result
                (f64.sub
                  (local.get $abs_x)
                  (f64.convert_i32_s (local.get $neg_base))
                )
              )
              (local.set $__pe0
                (f64.add
                  (f64.const 1)
                  (f64.mul
                    (local.get $result)
                    (f64.add
                      (f64.const 0.6931472000619209)
                      (f64.mul
                        (local.get $result)
                        (f64.add
                          (f64.const 0.24022650999918949)
                          (f64.mul
                            (local.get $result)
                            (f64.add
                              (f64.const 0.05550340682450019)
                              (f64.mul
                                (local.get $result)
                                (f64.add
                                  (f64.const 0.009618048870444599)
                                  (f64.mul
                                    (local.get $result)
                                    (f64.add
                                      (f64.const 0.0013395279077191057)
                                      (f64.mul (local.get $result) (f64.const 0.00015463102004723134))
                                    )
                                  )
                                )
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
              ;; 2^k via a single IEEE-exponent build for the normal range (the hot path); the
              ;; two-factor split (2^k2 · 2^(k−k2)) is only needed at the denormal/overflow edges.
              ;; For normal k both are bit-identical (powers of two multiply exactly) — free speedup.
              (if
                (result f64)
                (i32.and
                  (i32.gt_s (local.get $neg_base) (i32.const -1023))
                  (i32.lt_s (local.get $neg_base) (i32.const 1024))
                )
                (then
                  (f64.mul
                    (local.get $__pe0)
                    (f64.reinterpret_i64
                      (i64.shl
                        (i64.extend_i32_s
                          (i32.add (local.get $neg_base) (i32.const 1023))
                        )
                        (i64.const 52)
                      )
                    )
                  )
                )
                (else
                  (local.set $n
                    (i32.shr_s (local.get $neg_base) (i32.const 1))
                  )
                  (f64.mul
                    (f64.mul
                      (local.get $__pe0)
                      (f64.reinterpret_i64
                        (i64.shl
                          (i64.extend_i32_s
                            (i32.add (local.get $n) (i32.const 1023))
                          )
                          (i64.const 52)
                        )
                      )
                    )
                    (f64.reinterpret_i64
                      (i64.shl
                        (i64.extend_i32_s
                          (i32.add
                            (i32.sub (local.get $neg_base) (local.get $n))
                            (i32.const 1023)
                          )
                        )
                        (i64.const 52)
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  )
  (func $math.log
    (param $x f64)
    (result f64)
    (local $bits i64)
    (local $k i32)
    (local $m f64)
    (local $s f64)
    (local $z f64)
    (local $w f64)
    (local $hfsq f64)
    (if
      (f64.ne (local.get $x) (local.get $x))
      (then
        (return (local.get $x))
      )
    )
    (if
      (f64.le (local.get $x) (f64.const 0.0))
      (then
        (if
          (f64.eq (local.get $x) (f64.const 0.0))
          (then
            (return (f64.const -inf))
          )
        )
        (return (f64.const nan))
      )
    )
    (if
      (f64.eq (local.get $x) (f64.const inf))
      (then
        (return (local.get $x))
      )
    )
    ;; Normalize denormals (exponent=0): scale by 2^54 and remember the shift,
    ;; so the bit-extracted exponent below is meaningful for every finite x > 0.
    (if
      (f64.lt (local.get $x) (f64.const 0x1p-1022))
      (then
        (local.set $x
          (f64.mul (local.get $x) (f64.const 0x1p54))
        )
        (local.set $k (i32.const -54))
      )
    )
    ;; frexp via bit twiddling: k = ((bits >> 52) & 0x7ff) - 1023, then force exp=1023 so m ∈ [1,2).
    (local.set $bits
      (i64.reinterpret_f64 (local.get $x))
    )
    (local.set $k
      (i32.add
        (local.get $k)
        (i32.sub
          (i32.wrap_i64
            (i64.and
              (i64.shr_u (local.get $bits) (i64.const 52))
              (i64.const 0x7ff)
            )
          )
          (i32.const 1023)
        )
      )
    )
    (local.set $m
      (f64.reinterpret_i64
        (i64.or
          (i64.and (local.get $bits) (i64.const 0x000fffffffffffff))
          (i64.const 0x3ff0000000000000)
        )
      )
    )
    ;; Center on sqrt(2) to shrink |s| from 1/3 down to ~0.172.
    (if
      (f64.ge (local.get $m) (f64.const 1.4142135623730951))
      (then
        (local.set $m
          (f64.mul (local.get $m) (f64.const 0.5))
        )
        (local.set $k
          (i32.add (local.get $k) (i32.const 1))
        )
      )
    )
    ;; s = f/(2+f) with f = m−1 (= (m−1)/(m+1)); then the fdlibm even/odd-split
    ;; polynomial. Two parallel Horner chains (t1 over even powers, t2 over odd)
    ;; cut the dependency chain ~in half vs one 9-deep Horner — more ILP, fewer
    ;; terms — and reconstruct log(m) = f − hfsq + s·(hfsq + t1 + t2). ~1 ulp.
    (local.set $m
      (f64.sub (local.get $m) (f64.const 1.0))
    )
    (local.set $s
      (f64.div
        (local.get $m)
        (f64.add (local.get $m) (f64.const 2.0))
      )
    )
    (local.set $z
      (f64.mul (local.get $s) (local.get $s))
    )
    (local.set $w
      (f64.mul (local.get $z) (local.get $z))
    )
    (local.set $hfsq
      (f64.mul
        (f64.const 0.5)
        (f64.mul (local.get $m) (local.get $m))
      )
    )
    (f64.add
      (f64.mul
        (f64.convert_i32_s (local.get $k))
        (f64.const 0.6931471805599453)
      )
      (f64.add
        (f64.sub (local.get $m) (local.get $hfsq))
        (f64.mul
          (local.get $s)
          (f64.add
            (local.get $hfsq)
            (f64.add
              (f64.mul
                (local.get $w)
                (f64.add
                  (f64.const 0.3999999999940941908)
                  (f64.mul
                    (local.get $w)
                    (f64.add
                      (f64.const 0.2222219843214978396)
                      (f64.mul (local.get $w) (f64.const 0.1531383769920937332))
                    )
                  )
                )
              )
              (f64.mul
                (local.get $z)
                (f64.add
                  (f64.const 0.6666666666666735130)
                  (f64.mul
                    (local.get $w)
                    (f64.add
                      (f64.const 0.2857142874366239149)
                      (f64.mul
                        (local.get $w)
                        (f64.add
                          (f64.const 0.1818357216161805012)
                          (f64.mul (local.get $w) (f64.const 0.1479819860511658591))
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  )
  (func $resize
    (export "resize")
    (param $w f64)
    (param $h f64)
    (result f64)
    (local $i i32)
    (local $tan0 i32)
    (local $tfs4 f64)
    (local $tfl5 i32)
    (local $tfi6 i32)
    (local $inf22 f64)
    (local $__pe2 i32)
    (local $__pe3 f64)
    (global.set $W
      (i32.trunc_sat_f64_s (local.get $w))
    )
    (global.set $H
      (i32.trunc_sat_f64_s (local.get $h))
    )
    (local.set $tan0
      (i32.trunc_sat_f64_s
        (local.tee $__pe3
          (f64.mul
            (call $__to_num
              (i64.reinterpret_f64 (local.get $w))
            )
            (call $__to_num
              (i64.reinterpret_f64 (local.get $h))
            )
          )
        )
      )
    )
    (local.set $tan0
      (call $__alloc_hdr_n_d_d_1
        (local.tee $tan0
          (i32.shl (local.get $tan0) (i32.const 2))
        )
        (local.get $tan0)
      )
    )
    (global.set $px
      (call $__mkptr
        (i32.const 3)
        (i32.const 5)
        (local.get $tan0)
      )
    )
    (local.set $tan0
      (i32.trunc_sat_f64_s (local.get $__pe3))
    )
    (local.set $tan0
      (call $__alloc_hdr_n_d_d_1
        (local.tee $tan0
          (i32.shl (local.get $tan0) (i32.const 3))
        )
        (local.get $tan0)
      )
    )
    (global.set $gray
      (call $__mkptr
        (i32.const 3)
        (i32.const 7)
        (local.get $tan0)
      )
    )
    (local.set $tan0
      (call $__alloc_hdr
        (i32.const 16)
        (i32.const 16)
      )
    )
    (f64.store (local.get $tan0) (f64.const 0))
    (f64.store offset=8
      (local.get $tan0)
      (f64.const 8)
    )
    (f64.store offset=16
      (local.get $tan0)
      (f64.const 2)
    )
    (f64.store offset=24
      (local.get $tan0)
      (f64.const 10)
    )
    (f64.store offset=32
      (local.get $tan0)
      (f64.const 12)
    )
    (f64.store offset=40
      (local.get $tan0)
      (f64.const 4)
    )
    (f64.store offset=48
      (local.get $tan0)
      (f64.const 14)
    )
    (f64.store offset=56
      (local.get $tan0)
      (f64.const 6)
    )
    (f64.store offset=64
      (local.get $tan0)
      (f64.const 3)
    )
    (f64.store offset=72
      (local.get $tan0)
      (f64.const 11)
    )
    (f64.store offset=80
      (local.get $tan0)
      (f64.const 1)
    )
    (f64.store offset=88
      (local.get $tan0)
      (f64.const 9)
    )
    (f64.store offset=96
      (local.get $tan0)
      (f64.const 15)
    )
    (f64.store offset=104
      (local.get $tan0)
      (f64.const 7)
    )
    (f64.store offset=112
      (local.get $tan0)
      (f64.const 13)
    )
    (f64.store offset=120
      (local.get $tan0)
      (f64.const 5)
    )
    (local.set $tfs4
      (call $__mkptr
        (i32.const 1)
        (i32.const 0)
        (local.get $tan0)
      )
    )
    (local.set $tan0
      (call $__ptr_offset
        (i64.reinterpret_f64 (local.get $tfs4))
      )
    )
    (local.set $tfl5
      (call $__len
        (i64.reinterpret_f64 (local.get $tfs4))
      )
    )
    (local.set $__pe2
      (call $__alloc_hdr_n_d_d_1
        (local.tee $__pe2
          (i32.shl (local.get $tfl5) (i32.const 2))
        )
        (local.get $__pe2)
      )
    )
    (block $brk9
      (loop $loop9
        (br_if $brk9
          (i32.ge_s (local.get $tfi6) (local.get $tfl5))
        )
        (i32.store
          (i32.add
            (local.get $__pe2)
            (i32.shl (local.get $tfi6) (i32.const 2))
          )
          (i32.trunc_f64_s
            (f64.load
              (i32.add
                (local.get $tan0)
                (i32.shl (local.get $tfi6) (i32.const 3))
              )
            )
          )
        )
        (local.set $tfi6
          (i32.add (local.get $tfi6) (i32.const 1))
        )
        (br $loop9)
      )
    )
    (global.set $bayer4
      (call $__mkptr
        (i32.const 3)
        (i32.const 4)
        (local.get $__pe2)
      )
    )
    (local.set $tan0
      (call $__alloc_hdr
        (i32.const 64)
        (i32.const 64)
      )
    )
    (f64.store (local.get $tan0) (f64.const 0))
    (f64.store offset=8
      (local.get $tan0)
      (f64.const 32)
    )
    (f64.store offset=16
      (local.get $tan0)
      (f64.const 8)
    )
    (f64.store offset=24
      (local.get $tan0)
      (f64.const 40)
    )
    (f64.store offset=32
      (local.get $tan0)
      (f64.const 2)
    )
    (f64.store offset=40
      (local.get $tan0)
      (f64.const 34)
    )
    (f64.store offset=48
      (local.get $tan0)
      (f64.const 10)
    )
    (f64.store offset=56
      (local.get $tan0)
      (f64.const 42)
    )
    (f64.store offset=64
      (local.get $tan0)
      (f64.const 48)
    )
    (f64.store offset=72
      (local.get $tan0)
      (f64.const 16)
    )
    (f64.store offset=80
      (local.get $tan0)
      (f64.const 56)
    )
    (f64.store offset=88
      (local.get $tan0)
      (f64.const 24)
    )
    (f64.store offset=96
      (local.get $tan0)
      (f64.const 50)
    )
    (f64.store offset=104
      (local.get $tan0)
      (f64.const 18)
    )
    (f64.store offset=112
      (local.get $tan0)
      (f64.const 58)
    )
    (f64.store offset=120
      (local.get $tan0)
      (f64.const 26)
    )
    (f64.store offset=128
      (local.get $tan0)
      (f64.const 12)
    )
    (f64.store offset=136
      (local.get $tan0)
      (f64.const 44)
    )
    (f64.store offset=144
      (local.get $tan0)
      (f64.const 4)
    )
    (f64.store offset=152
      (local.get $tan0)
      (f64.const 36)
    )
    (f64.store offset=160
      (local.get $tan0)
      (f64.const 14)
    )
    (f64.store offset=168
      (local.get $tan0)
      (f64.const 46)
    )
    (f64.store offset=176
      (local.get $tan0)
      (f64.const 6)
    )
    (f64.store offset=184
      (local.get $tan0)
      (f64.const 38)
    )
    (f64.store offset=192
      (local.get $tan0)
      (f64.const 60)
    )
    (f64.store offset=200
      (local.get $tan0)
      (f64.const 28)
    )
    (f64.store offset=208
      (local.get $tan0)
      (f64.const 52)
    )
    (f64.store offset=216
      (local.get $tan0)
      (f64.const 20)
    )
    (f64.store offset=224
      (local.get $tan0)
      (f64.const 62)
    )
    (f64.store offset=232
      (local.get $tan0)
      (f64.const 30)
    )
    (f64.store offset=240
      (local.get $tan0)
      (f64.const 54)
    )
    (f64.store offset=248
      (local.get $tan0)
      (f64.const 22)
    )
    (f64.store offset=256
      (local.get $tan0)
      (f64.const 3)
    )
    (f64.store offset=264
      (local.get $tan0)
      (f64.const 35)
    )
    (f64.store offset=272
      (local.get $tan0)
      (f64.const 11)
    )
    (f64.store offset=280
      (local.get $tan0)
      (f64.const 43)
    )
    (f64.store offset=288
      (local.get $tan0)
      (f64.const 1)
    )
    (f64.store offset=296
      (local.get $tan0)
      (f64.const 33)
    )
    (f64.store offset=304
      (local.get $tan0)
      (f64.const 9)
    )
    (f64.store offset=312
      (local.get $tan0)
      (f64.const 41)
    )
    (f64.store offset=320
      (local.get $tan0)
      (f64.const 51)
    )
    (f64.store offset=328
      (local.get $tan0)
      (f64.const 19)
    )
    (f64.store offset=336
      (local.get $tan0)
      (f64.const 59)
    )
    (f64.store offset=344
      (local.get $tan0)
      (f64.const 27)
    )
    (f64.store offset=352
      (local.get $tan0)
      (f64.const 49)
    )
    (f64.store offset=360
      (local.get $tan0)
      (f64.const 17)
    )
    (f64.store offset=368
      (local.get $tan0)
      (f64.const 57)
    )
    (f64.store offset=376
      (local.get $tan0)
      (f64.const 25)
    )
    (f64.store offset=384
      (local.get $tan0)
      (f64.const 15)
    )
    (f64.store offset=392
      (local.get $tan0)
      (f64.const 47)
    )
    (f64.store offset=400
      (local.get $tan0)
      (f64.const 7)
    )
    (f64.store offset=408
      (local.get $tan0)
      (f64.const 39)
    )
    (f64.store offset=416
      (local.get $tan0)
      (f64.const 13)
    )
    (f64.store offset=424
      (local.get $tan0)
      (f64.const 45)
    )
    (f64.store offset=432
      (local.get $tan0)
      (f64.const 5)
    )
    (f64.store offset=440
      (local.get $tan0)
      (f64.const 37)
    )
    (f64.store offset=448
      (local.get $tan0)
      (f64.const 63)
    )
    (f64.store offset=456
      (local.get $tan0)
      (f64.const 31)
    )
    (f64.store offset=464
      (local.get $tan0)
      (f64.const 55)
    )
    (f64.store offset=472
      (local.get $tan0)
      (f64.const 23)
    )
    (f64.store offset=480
      (local.get $tan0)
      (f64.const 61)
    )
    (f64.store offset=488
      (local.get $tan0)
      (f64.const 29)
    )
    (f64.store offset=496
      (local.get $tan0)
      (f64.const 53)
    )
    (f64.store offset=504
      (local.get $tan0)
      (f64.const 21)
    )
    (local.set $tfs4
      (call $__mkptr
        (i32.const 1)
        (i32.const 0)
        (local.get $tan0)
      )
    )
    (local.set $tan0
      (call $__ptr_offset
        (i64.reinterpret_f64 (local.get $tfs4))
      )
    )
    (local.set $tfl5
      (call $__len
        (i64.reinterpret_f64 (local.get $tfs4))
      )
    )
    (local.set $__pe2
      (call $__alloc_hdr_n_d_d_1
        (local.tee $__pe2
          (i32.shl (local.get $tfl5) (i32.const 2))
        )
        (local.get $__pe2)
      )
    )
    (local.set $tfi6 (i32.const 0))
    (block $brk16
      (loop $loop16
        (br_if $brk16
          (i32.ge_s (local.get $tfi6) (local.get $tfl5))
        )
        (i32.store
          (i32.add
            (local.get $__pe2)
            (i32.shl (local.get $tfi6) (i32.const 2))
          )
          (i32.trunc_f64_s
            (f64.load
              (i32.add
                (local.get $tan0)
                (i32.shl (local.get $tfi6) (i32.const 3))
              )
            )
          )
        )
        (local.set $tfi6
          (i32.add (local.get $tfi6) (i32.const 1))
        )
        (br $loop16)
      )
    )
    (global.set $bayer8
      (call $__mkptr
        (i32.const 3)
        (i32.const 4)
        (local.get $__pe2)
      )
    )
    (local.set $tan0
      (call $__alloc_hdr_n_d_d_1
        (local.tee $tan0 (i32.const 256))
        (local.get $tan0)
      )
    )
    (global.set $halftone
      (call $__mkptr
        (i32.const 3)
        (i32.const 4)
        (local.get $tan0)
      )
    )
    (block $brk20
      (loop $loop20
        (br_if $brk20
          (i32.eqz
            (i32.lt_s (local.get $i) (i32.const 64))
          )
        )
        (local.set $tfs4
          (f64.add
            (call $math.cos
              (f64.mul
                (f64.const 3.141592653589793)
                (f64.sub
                  (f64.mul
                    (f64.div
                      (f64.add
                        (f64.convert_i32_s
                          (i32.rem_s (local.get $i) (i32.const 8))
                        )
                        (f64.const 0.5)
                      )
                      (f64.const 8)
                    )
                    (f64.const 2)
                  )
                  (f64.const 1)
                )
              )
            )
            (call $math.cos
              (f64.mul
                (f64.const 3.141592653589793)
                (f64.sub
                  (f64.mul
                    (f64.div
                      (f64.add
                        (f64.convert_i32_s
                          (i32.div_s (local.get $i) (i32.const 8))
                        )
                        (f64.const 0.5)
                      )
                      (f64.const 8)
                    )
                    (f64.const 2)
                  )
                  (f64.const 1)
                )
              )
            )
          )
        )
        (local.set $tan0
          (select
            (i32.wrap_i64
              (i64.trunc_sat_f64_s
                (local.tee $inf22
                  (f64.mul
                    (f64.div
                      (f64.sub (f64.const 2) (local.get $tfs4))
                      (f64.const 4)
                    )
                    (f64.const 63)
                  )
                )
              )
            )
            (i32.const 0)
            (f64.ne (local.get $inf22) (f64.const Infinity))
          )
        )
        (i32.store
          (i32.add
            (i32.wrap_i64
              (i64.and
                (i64.reinterpret_f64 (global.get $halftone))
                (i64.const 4294967295)
              )
            )
            (i32.shl (local.get $i) (i32.const 2))
          )
          (local.get $tan0)
        )
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (br $loop20)
      )
    )
    (return (global.get $px))
  )
  (func $frame
    (export "frame")
    (param $t f64)
    (param $mode f64)
    (result f64)
    (local $i i32)
    (local $py i32)
    (local $qx i32)
    (local $idx i32)
    (local $py0 i32)
    (local $qx1 i32)
    (local $idx2 i32)
    (local $thr f64)
    (local $py3 i32)
    (local $qx4 i32)
    (local $idx5 i32)
    (local $old f64)
    (local $on i32)
    (local $err f64)
    (local $py6 i32)
    (local $qx7 i32)
    (local $idx8 i32)
    (local $old9 f64)
    (local $on10 i32)
    (local $e f64)
    (local $r i32)
    (local $r11 i32)
    (local $py12 i32)
    (local $qx13 i32)
    (local $idx14 i32)
    (local $old15 f64)
    (local $on16 i32)
    (local $err17 f64)
    (local $inf3 f64)
    (local $4 i32)
    (local $5 i32)
    (local $inf8 f64)
    (local $inf11 f64)
    (local $inf18 f64)
    (local $tw21 f64)
    (local $tw22 f64)
    (local $tw23 f64)
    (local $tw26 f64)
    (local $tw27 f64)
    (local $tw28 f64)
    (local $inf33 f64)
    (local $__go0 i32)
    (local $__go1 i32)
    (local $__go2 i32)
    (local $__go3 i32)
    (local $__lb0 i32)
    (local $__li0 f64)
    (local $__li1 f64)
    (local $__li2 i32)
    (local $__li3 i32)
    (local $__li4 i32)
    (local $__li5 i32)
    (local $__li6 f64)
    (local $__li7 i32)
    (local $__li8 f64)
    (local $__li9 i32)
    (local $__li10 i32)
    (local $__li11 f64)
    (local $__li12 i32)
    (local $__li13 i32)
    (local $__ab0 i32)
    (local $__ab1 i32)
    (local $__ab2 i32)
    (local $__ab3 i32)
    (local $__ab4 i32)
    (local $__pe0 i32)
    (local $__pe1 i32)
    (local $__pe2 i32)
    (local $__pe3 i32)
    (local $_pg1 i32)
    (local $_pg0 i32)
    (local $__inl8_h i32)
    (local $__inl8_inf0 f64)
    (local $__inl8_inf1 f64)
    (local $__inl9_t f64)
    (local $__inl9_aspect f64)
    (local $__inl9_R f64)
    (local $__inl9_lx f64)
    (local $__inl9_ly f64)
    (local $__inl9_il f64)
    (local $__inl9_py i32)
    (local $__inl9_qx i32)
    (local $__inl9_nx f64)
    (local $__inl9_lum f64)
    (local $__inl9_r2 f64)
    (local $__inl9_z f64)
    (local $__inl9_d f64)
    (local $__inl9_cn2 f64)
    (local $__inl9___go0 i32)
    (local $__inl9___li0 f64)
    (local $__inl9___li1 f64)
    (local $__inl9___li2 f64)
    (local $__inl9___li3 f64)
    (local $__inl9__pg1 i32)
    (local $__inl9__pg0 i32)
    (local $__go4 i32)
    (local $__li14 f64)
    (local $__li15 f64)
    (local $__li16 f64)
    (local $__li17 i32)
    (local $__li18 f64)
    (local $__li19 i32)
    (local $__li20 f64)
    (local $__li21 f64)
    (local $__li22 i32)
    (local $__li23 f64)
    (local $__li24 i32)
    (local $__li25 i32)
    (local $__li26 i32)
    (local $__li27 f64)
    (local $__li28 i32)
    (local $__li29 i32)
    (local $__li30 i32)
    (local $__pe4 f64)
    (local $__pe5 f64)
    (local $__pe6 f64)
    (local $__pe7 f64)
    (local $__pe8 f64)
    (local $__iv1_0 i32)
    (local.set $__go4
      (i32.wrap_i64
        (i64.and
          (i64.reinterpret_f64 (global.get $gray))
          (i64.const 4294967295)
        )
      )
    )
    (local.set $_pg0 (global.get $W))
    (local.set $_pg1 (global.get $H))
    (local.set $__go0 (local.get $__go4))
    (local.set $__go1
      (i32.wrap_i64
        (i64.and
          (i64.reinterpret_f64 (global.get $bayer4))
          (i64.const 4294967295)
        )
      )
    )
    (local.set $__go2
      (i32.wrap_i64
        (i64.and
          (i64.reinterpret_f64 (global.get $bayer8))
          (i64.const 4294967295)
        )
      )
    )
    (local.set $__go3
      (i32.wrap_i64
        (i64.and
          (i64.reinterpret_f64 (global.get $halftone))
          (i64.const 4294967295)
        )
      )
    )
    (local.set $__inl9__pg0 (global.get $W))
    (local.set $__inl9__pg1 (global.get $H))
    (local.set $__inl9___go0 (local.get $__go4))
    (local.set $__inl9_t
      (call $__to_num
        (i64.reinterpret_f64 (local.get $t))
      )
    )
    (local.set $__inl9_aspect
      (f64.div
        (f64.convert_i32_s (local.get $__inl9__pg0))
        (f64.convert_i32_s (local.get $__inl9__pg1))
      )
    )
    (local.set $__inl9_R (f64.const 0.4))
    (local.set $__inl9_lx
      (call $math.cos_core
        (local.tee $__inl9_t
          (f64.mul (local.get $__inl9_t) (f64.const 0.6))
        )
      )
    )
    (local.set $__inl9_ly (f64.const 0.45))
    (local.set $__inl9_t
      (call $math.sin_core (local.get $__inl9_t))
    )
    (local.set $__inl9_il
      (f64.div
        (f64.const 1)
        (f64.sqrt
          (f64.add
            (f64.add
              (f64.mul (local.get $__inl9_lx) (local.get $__inl9_lx))
              (f64.mul (local.get $__inl9_ly) (local.get $__inl9_ly))
            )
            (f64.mul (local.get $__inl9_t) (local.get $__inl9_t))
          )
        )
      )
    )
    (local.set $__inl9_lx
      (f64.mul (local.get $__inl9_lx) (local.get $__inl9_il))
    )
    (local.set $__inl9_ly
      (f64.mul (local.get $__inl9_ly) (local.get $__inl9_il))
    )
    (local.set $__inl9_t
      (f64.mul (local.get $__inl9_t) (local.get $__inl9_il))
    )
    (block $__inl9L_brk0
      (loop $__inl9L_loop0
        (br_if $__inl9L_brk0
          (i32.eqz
            (i32.lt_s (local.get $__inl9_py) (local.get $__inl9__pg1))
          )
        )
        (local.set $__inl9_il
          (f64.mul
            (f64.sub
              (f64.div
                (local.tee $__pe4
                  (f64.convert_i32_s (local.get $__inl9_py))
                )
                (local.tee $__pe5
                  (f64.convert_i32_s (local.get $__inl9__pg1))
                )
              )
              (f64.const 0.5)
            )
            (f64.const 2)
          )
        )
        (local.set $__inl9_qx (i32.const 0))
        (block $__inl9L_brk1
          (local.set $__inl9___li0 (local.get $__pe4))
          (local.set $__inl9___li1
            (f64.mul (local.get $__inl9_il) (local.get $__inl9_il))
          )
          (local.set $__inl9___li2
            (f64.mul (local.get $__inl9_R) (local.get $__inl9_R))
          )
          (local.set $__inl9___li3
            (f64.div (f64.const 1) (local.get $__inl9_R))
          )
          (local.set $__li14
            (f64.convert_i32_s (local.get $__inl9__pg0))
          )
          (local.set $__li15
            (f64.mul
              (f64.sub
                (f64.const 1)
                (f64.div (local.get $__inl9___li0) (local.get $__pe5))
              )
              (f64.const 0.5)
            )
          )
          (local.set $__li16
            (f64.mul
              (f64.mul (local.get $__inl9_il) (local.get $__inl9___li3))
              (local.get $__inl9_ly)
            )
          )
          (local.set $__li17
            (i32.mul (local.get $__inl9_py) (local.get $__inl9__pg0))
          )
          (loop $__inl9L_loop1
            (br_if $__inl9L_brk1
              (i32.eqz
                (i32.lt_s (local.get $__inl9_qx) (local.get $__inl9__pg0))
              )
            )
            (local.set $__inl9_nx
              (f64.mul
                (f64.mul
                  (f64.sub
                    (f64.div
                      (local.tee $__pe6
                        (f64.convert_i32_s (local.get $__inl9_qx))
                      )
                      (local.get $__li14)
                    )
                    (f64.const 0.5)
                  )
                  (f64.const 2)
                )
                (local.get $__inl9_aspect)
              )
            )
            (local.set $__inl9_lum
              (f64.add
                (f64.const 0.16)
                (f64.mul
                  (f64.const 0.56)
                  (f64.add
                    (f64.mul
                      (f64.div (local.get $__pe6) (local.get $__li14))
                      (f64.const 0.5)
                    )
                    (local.get $__li15)
                  )
                )
              )
            )
            (local.set $__inl9_r2
              (f64.add
                (f64.mul (local.get $__inl9_nx) (local.get $__inl9_nx))
                (local.get $__inl9___li1)
              )
            )
            (if
              (f64.lt (local.get $__inl9_r2) (local.get $__inl9___li2))
              (then
                (local.set $__inl9_cn2
                  (f64.sqrt
                    (f64.sub (local.get $__inl9___li2) (local.get $__inl9_r2))
                  )
                )
                (local.set $__inl9_z
                  (select
                    (f64.const nan)
                    (local.get $__inl9_cn2)
                    (f64.ne (local.get $__inl9_cn2) (local.get $__inl9_cn2))
                  )
                )
                (local.set $__inl9_d
                  (f64.add
                    (f64.add
                      (f64.mul
                        (f64.mul (local.get $__inl9_nx) (local.get $__inl9___li3))
                        (local.get $__inl9_lx)
                      )
                      (local.get $__li16)
                    )
                    (f64.mul
                      (f64.mul (local.get $__inl9_z) (local.get $__inl9___li3))
                      (local.get $__inl9_t)
                    )
                  )
                )
                (if
                  (f64.lt (local.get $__inl9_d) (f64.const 0))
                  (then
                    (local.set $__inl9_d (f64.const 0))
                  )
                )
                (local.set $__inl9_lum
                  (f64.add
                    (f64.const 0.04)
                    (f64.mul
                      (f64.const 0.96)
                      (call $math.pow
                        (local.get $__inl9_d)
                        (f64.const 0.8)
                      )
                    )
                  )
                )
              )
            )
            (f64.store
              (i32.add
                (local.get $__inl9___go0)
                (i32.shl
                  (i32.add (local.get $__li17) (local.get $__inl9_qx))
                  (i32.const 3)
                )
              )
              (local.get $__inl9_lum)
            )
            (local.set $__inl9_qx
              (i32.add (local.get $__inl9_qx) (i32.const 1))
            )
            (br $__inl9L_loop1)
          )
        )
        (local.set $__inl9_py
          (i32.add (local.get $__inl9_py) (i32.const 1))
        )
        (br $__inl9L_loop0)
      )
    )
    (local.set $__inl9_py
      (select
        (i32.wrap_i64
          (i64.trunc_sat_f64_s (local.get $mode))
        )
        (i32.const 0)
        (f64.ne (local.get $mode) (f64.const Infinity))
      )
    )
    (local.set $__inl9_t
      (f64.mul
        (f64.convert_i32_s (local.get $_pg0))
        (f64.convert_i32_s (local.get $_pg1))
      )
    )
    (if
      (i32.eq (local.get $__inl9_py) (i32.const 0))
      (then
        (local.set $__lb0
          (i32.trunc_sat_f64_s
            (f64.ceil (local.get $__inl9_t))
          )
        )
        (block
          (local.set $__iv1_0
            (i32.add
              (local.get $__go0)
              (i32.shl (local.get $i) (i32.const 3))
            )
          )
          (block $brk0
            (loop $loop0
              (br_if $brk0
                (i32.eqz
                  (i32.lt_s (local.get $i) (local.get $__lb0))
                )
              )
              (call $putBW
                (local.get $i)
                (f64.ge
                  (f64.load (local.get $__iv1_0))
                  (f64.const 0.5)
                )
              ) drop
              (local.set $i
                (i32.add (local.get $i) (i32.const 1))
              )
              (local.set $__iv1_0
                (i32.add (local.get $__iv1_0) (i32.const 8))
              )
              (br $loop0)
            )
          )
        )
      )
      (else
        (if
          (i32.eq (local.get $__inl9_py) (i32.const 1))
          (then
            (block $brk1
              (loop $loop1
                (br_if $brk1
                  (i32.eqz
                    (i32.lt_s (local.get $py) (local.get $_pg1))
                  )
                )
                (local.set $qx (i32.const 0))
                (block $brk2
                  (local.set $__li0
                    (local.tee $__pe7
                      (f64.convert_i32_s (local.get $py))
                    )
                  )
                  (local.set $__li18
                    (f64.mul
                      (local.get $__li0)
                      (f64.convert_i32_s (local.get $_pg0))
                    )
                  )
                  (local.set $__li19
                    (select
                      (i32.wrap_i64
                        (i64.trunc_sat_f64_s
                          (local.tee $__inl8_inf1
                            (f64.add
                              (f64.mul (local.get $__pe7) (f64.const 12820163))
                              (f64.const 9301)
                            )
                          )
                        )
                      )
                      (i32.const 0)
                      (f64.ne (local.get $__inl8_inf1) (f64.const Infinity))
                    )
                  )
                  (loop $loop2
                    (br_if $brk2
                      (i32.eqz
                        (i32.lt_s (local.get $qx) (local.get $_pg0))
                      )
                    )
                    (local.set $idx
                      (select
                        (i32.wrap_i64
                          (i64.trunc_sat_f64_s
                            (local.tee $inf3
                              (f64.add
                                (local.get $__li18)
                                (local.tee $__pe8
                                  (f64.convert_i32_s (local.get $qx))
                                )
                              )
                            )
                          )
                        )
                        (i32.const 0)
                        (f64.ne (local.get $inf3) (f64.const Infinity))
                      )
                    )
                    (call $putBW
                      (local.get $idx)
                      (f64.ge
                        (f64.load
                          (i32.add
                            (local.get $__go0)
                            (i32.shl (local.get $idx) (i32.const 3))
                          )
                        )
                        (block $__inl8
                          (result f64)
                          (local.set $__inl8_h
                            (i32.xor
                              (select
                                (i32.wrap_i64
                                  (i64.trunc_sat_f64_s
                                    (local.tee $__inl8_inf0
                                      (f64.add
                                        (f64.mul (local.get $__pe8) (f64.const 1103515245))
                                        (f64.const 12345)
                                      )
                                    )
                                  )
                                )
                                (i32.const 0)
                                (f64.ne (local.get $__inl8_inf0) (f64.const Infinity))
                              )
                              (local.get $__li19)
                            )
                          )
                          (local.set $__inl8_h
                            (i32.and (local.get $__inl8_h) (i32.const 2147483647))
                          )
                          (f64.div
                            (f64.convert_i32_s
                              (i32.rem_s (local.get $__inl8_h) (i32.const 4096))
                            )
                            (f64.const 4096)
                          )
                        )
                      )
                    ) drop
                    (local.set $qx
                      (i32.add (local.get $qx) (i32.const 1))
                    )
                    (br $loop2)
                  )
                )
                (local.set $py
                  (i32.add (local.get $py) (i32.const 1))
                )
                (br $loop1)
              )
            )
          )
          (else
            (if
              (if
                (result i32)
                (local.tee $5
                  (if
                    (result i32)
                    (local.tee $4
                      (i32.eq (local.get $__inl9_py) (i32.const 2))
                    )
                    (then (local.get $4))
                    (else
                      (i32.eq (local.get $__inl9_py) (i32.const 3))
                    )
                  )
                )
                (then (local.get $5))
                (else
                  (i32.eq (local.get $__inl9_py) (i32.const 4))
                )
              )
              (then
                (block $brk6
                  (loop $loop6
                    (br_if $brk6
                      (i32.eqz
                        (i32.lt_s (local.get $py0) (local.get $_pg1))
                      )
                    )
                    (local.set $qx1 (i32.const 0))
                    (block $brk7
                      (local.set $__li1
                        (f64.convert_i32_s (local.get $py0))
                      )
                      (local.set $__li2
                        (i32.eq (local.get $__inl9_py) (i32.const 2))
                      )
                      (local.set $__li3
                        (i32.shl
                          (i32.and (local.get $py0) (i32.const 3))
                          (i32.const 2)
                        )
                      )
                      (local.set $__li4
                        (i32.eq (local.get $__inl9_py) (i32.const 3))
                      )
                      (local.set $__li5
                        (i32.shl
                          (i32.and (local.get $py0) (i32.const 7))
                          (i32.const 3)
                        )
                      )
                      (local.set $__li20
                        (f64.mul
                          (local.get $__li1)
                          (f64.convert_i32_s (local.get $_pg0))
                        )
                      )
                      (loop $loop7
                        (br_if $brk7
                          (i32.eqz
                            (i32.lt_s (local.get $qx1) (local.get $_pg0))
                          )
                        )
                        (local.set $idx2
                          (select
                            (i32.wrap_i64
                              (i64.trunc_sat_f64_s
                                (local.tee $inf8
                                  (f64.add
                                    (local.get $__li20)
                                    (f64.convert_i32_s (local.get $qx1))
                                  )
                                )
                              )
                            )
                            (i32.const 0)
                            (f64.ne (local.get $inf8) (f64.const Infinity))
                          )
                        )
                        (local.set $thr
                          (if
                            (result f64)
                            (local.get $__li2)
                            (then
                              (f64.div
                                (f64.add
                                  (f64.convert_i32_s
                                    (i32.load
                                      (i32.add
                                        (local.get $__go1)
                                        (i32.shl
                                          (i32.add
                                            (local.get $__li3)
                                            (i32.and (local.get $qx1) (i32.const 3))
                                          )
                                          (i32.const 2)
                                        )
                                      )
                                    )
                                  )
                                  (f64.const 0.5)
                                )
                                (f64.const 16)
                              )
                            )
                            (else
                              (if
                                (result f64)
                                (local.get $__li4)
                                (then
                                  (f64.div
                                    (f64.add
                                      (f64.convert_i32_s
                                        (i32.load
                                          (i32.add
                                            (local.get $__go2)
                                            (i32.shl
                                              (i32.add
                                                (local.get $__li5)
                                                (i32.and (local.get $qx1) (i32.const 7))
                                              )
                                              (i32.const 2)
                                            )
                                          )
                                        )
                                      )
                                      (f64.const 0.5)
                                    )
                                    (f64.const 64)
                                  )
                                )
                                (else
                                  (f64.div
                                    (f64.add
                                      (f64.convert_i32_s
                                        (i32.load
                                          (i32.add
                                            (local.get $__go3)
                                            (i32.shl
                                              (i32.add
                                                (local.get $__li5)
                                                (i32.and (local.get $qx1) (i32.const 7))
                                              )
                                              (i32.const 2)
                                            )
                                          )
                                        )
                                      )
                                      (f64.const 0.5)
                                    )
                                    (f64.const 64)
                                  )
                                )
                              )
                            )
                          )
                        )
                        (call $putBW
                          (local.get $idx2)
                          (f64.ge
                            (f64.load
                              (i32.add
                                (local.get $__go0)
                                (i32.shl (local.get $idx2) (i32.const 3))
                              )
                            )
                            (local.get $thr)
                          )
                        ) drop
                        (local.set $qx1
                          (i32.add (local.get $qx1) (i32.const 1))
                        )
                        (br $loop7)
                      )
                    )
                    (local.set $py0
                      (i32.add (local.get $py0) (i32.const 1))
                    )
                    (br $loop6)
                  )
                )
              )
              (else
                (if
                  (i32.eq (local.get $__inl9_py) (i32.const 5))
                  (then
                    (block $brk9
                      (loop $loop9
                        (br_if $brk9
                          (i32.eqz
                            (i32.lt_s (local.get $py3) (local.get $_pg1))
                          )
                        )
                        (local.set $qx4 (i32.const 0))
                        (block $brk10
                          (local.set $__li6
                            (f64.convert_i32_s (local.get $py3))
                          )
                          (local.set $__li7
                            (i32.add (local.get $py3) (i32.const 1))
                          )
                          (local.set $__li21
                            (f64.mul
                              (local.get $__li6)
                              (f64.convert_i32_s (local.get $_pg0))
                            )
                          )
                          (local.set $__li22
                            (i32.lt_s (local.get $__li7) (local.get $_pg1))
                          )
                          (loop $loop10
                            (br_if $brk10
                              (i32.eqz
                                (i32.lt_s (local.get $qx4) (local.get $_pg0))
                              )
                            )
                            (local.set $idx5
                              (select
                                (i32.wrap_i64
                                  (i64.trunc_sat_f64_s
                                    (local.tee $inf11
                                      (f64.add
                                        (local.get $__li21)
                                        (f64.convert_i32_s (local.get $qx4))
                                      )
                                    )
                                  )
                                )
                                (i32.const 0)
                                (f64.ne (local.get $inf11) (f64.const Infinity))
                              )
                            )
                            (local.set $old
                              (f64.load
                                (local.tee $__ab0
                                  (i32.add
                                    (local.get $__go0)
                                    (i32.shl (local.get $idx5) (i32.const 3))
                                  )
                                )
                              )
                            )
                            (local.set $on
                              (f64.ge (local.get $old) (f64.const 0.5))
                            )
                            (local.set $err
                              (f64.sub
                                (local.get $old)
                                (f64.convert_i32_s (local.get $on))
                              )
                            )
                            (if
                              (i32.lt_s
                                (i32.add (local.get $qx4) (i32.const 1))
                                (local.get $_pg0)
                              )
                              (then
                                (f64.store offset=8
                                  (local.get $__ab0)
                                  (f64.add
                                    (f64.load offset=8 (local.get $__ab0))
                                    (f64.mul (local.get $err) (f64.const 0.4375))
                                  )
                                )
                              )
                            )
                            (if
                              (local.get $__li22)
                              (then
                                (if
                                  (i32.gt_s (local.get $qx4) (i32.const 0))
                                  (then
                                    (f64.store
                                      (i32.add
                                        (local.get $__go0)
                                        (i32.shl
                                          (i32.sub
                                            (i32.add (local.get $idx5) (local.get $_pg0))
                                            (i32.const 1)
                                          )
                                          (i32.const 3)
                                        )
                                      )
                                      (f64.add
                                        (f64.load
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl
                                              (i32.sub
                                                (i32.add (local.get $idx5) (local.get $_pg0))
                                                (i32.const 1)
                                              )
                                              (i32.const 3)
                                            )
                                          )
                                        )
                                        (f64.mul (local.get $err) (f64.const 0.1875))
                                      )
                                    )
                                  )
                                )
                                (f64.store
                                  (i32.add
                                    (local.get $__go0)
                                    (i32.shl
                                      (i32.add (local.get $idx5) (local.get $_pg0))
                                      (i32.const 3)
                                    )
                                  )
                                  (f64.add
                                    (f64.load
                                      (i32.add
                                        (local.get $__go0)
                                        (i32.shl
                                          (i32.add (local.get $idx5) (local.get $_pg0))
                                          (i32.const 3)
                                        )
                                      )
                                    )
                                    (f64.mul (local.get $err) (f64.const 0.3125))
                                  )
                                )
                                (if
                                  (i32.lt_s
                                    (i32.add (local.get $qx4) (i32.const 1))
                                    (local.get $_pg0)
                                  )
                                  (then
                                    (f64.store offset=8
                                      (i32.add
                                        (local.get $__go0)
                                        (i32.shl
                                          (i32.add (local.get $idx5) (local.get $_pg0))
                                          (i32.const 3)
                                        )
                                      )
                                      (f64.add
                                        (f64.load offset=8
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl
                                              (i32.add (local.get $idx5) (local.get $_pg0))
                                              (i32.const 3)
                                            )
                                          )
                                        )
                                        (f64.mul (local.get $err) (f64.const 0.0625))
                                      )
                                    )
                                  )
                                )
                              )
                            )
                            (call $putBW
                              (local.get $idx5)
                              (local.get $on)
                            ) drop
                            (local.set $qx4
                              (i32.add (local.get $qx4) (i32.const 1))
                            )
                            (br $loop10)
                          )
                        )
                        (local.set $py3
                          (i32.add (local.get $py3) (i32.const 1))
                        )
                        (br $loop9)
                      )
                    )
                  )
                  (else
                    (if
                      (i32.eq (local.get $__inl9_py) (i32.const 6))
                      (then
                        (block $brk16
                          (loop $loop16
                            (br_if $brk16
                              (i32.eqz
                                (i32.lt_s (local.get $py6) (local.get $_pg1))
                              )
                            )
                            (local.set $qx7 (i32.const 0))
                            (block $brk17
                              (local.set $__li8
                                (f64.convert_i32_s (local.get $py6))
                              )
                              (local.set $__li9
                                (i32.add (local.get $py6) (i32.const 1))
                              )
                              (local.set $__li10
                                (i32.add (local.get $py6) (i32.const 2))
                              )
                              (local.set $__li23
                                (f64.mul
                                  (local.get $__li8)
                                  (f64.convert_i32_s (local.get $_pg0))
                                )
                              )
                              (local.set $__li24
                                (i32.lt_s (local.get $__li9) (local.get $_pg1))
                              )
                              (local.set $__li25
                                (i32.lt_s (local.get $__li10) (local.get $_pg1))
                              )
                              (local.set $__li26
                                (i32.shl (local.get $_pg0) (i32.const 1))
                              )
                              (loop $loop17
                                (br_if $brk17
                                  (i32.eqz
                                    (i32.lt_s (local.get $qx7) (local.get $_pg0))
                                  )
                                )
                                (local.set $idx8
                                  (select
                                    (i32.wrap_i64
                                      (i64.trunc_sat_f64_s
                                        (local.tee $inf18
                                          (f64.add
                                            (local.get $__li23)
                                            (f64.convert_i32_s (local.get $qx7))
                                          )
                                        )
                                      )
                                    )
                                    (i32.const 0)
                                    (f64.ne (local.get $inf18) (f64.const Infinity))
                                  )
                                )
                                (local.set $old9
                                  (f64.load
                                    (local.tee $__ab1
                                      (i32.add
                                        (local.get $__go0)
                                        (i32.shl (local.get $idx8) (i32.const 3))
                                      )
                                    )
                                  )
                                )
                                (local.set $on10
                                  (f64.ge (local.get $old9) (f64.const 0.5))
                                )
                                (local.set $e
                                  (f64.div
                                    (f64.sub
                                      (local.get $old9)
                                      (f64.convert_i32_s (local.get $on10))
                                    )
                                    (f64.const 48)
                                  )
                                )
                                (if
                                  (i32.lt_s
                                    (i32.add (local.get $qx7) (i32.const 1))
                                    (local.get $_pg0)
                                  )
                                  (then
                                    (f64.store offset=8
                                      (local.get $__ab1)
                                      (f64.add
                                        (f64.load offset=8 (local.get $__ab1))
                                        (f64.mul (local.get $e) (f64.const 7))
                                      )
                                    )
                                  )
                                )
                                (if
                                  (i32.lt_s
                                    (i32.add (local.get $qx7) (i32.const 2))
                                    (local.get $_pg0)
                                  )
                                  (then
                                    (f64.store offset=16
                                      (local.get $__ab1)
                                      (f64.add
                                        (f64.load offset=16 (local.get $__ab1))
                                        (f64.mul (local.get $e) (f64.const 5))
                                      )
                                    )
                                  )
                                )
                                (if
                                  (local.get $__li24)
                                  (then
                                    (local.set $r
                                      (i32.add (local.get $idx8) (local.get $_pg0))
                                    )
                                    (if
                                      (i32.ge_s
                                        (i32.sub (local.get $qx7) (i32.const 2))
                                        (i32.const 0)
                                      )
                                      (then
                                        (local.set $tw21
                                          (f64.add
                                            (f64.load
                                              (i32.add
                                                (local.get $__go0)
                                                (i32.shl
                                                  (local.tee $__pe0
                                                    (i32.sub (local.get $r) (i32.const 2))
                                                  )
                                                  (i32.const 3)
                                                )
                                              )
                                            )
                                            (f64.mul (local.get $e) (f64.const 3))
                                          )
                                        )
                                        (f64.store
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl (local.get $__pe0) (i32.const 3))
                                          )
                                          (local.get $tw21)
                                        )
                                      )
                                    )
                                    (if
                                      (i32.ge_s
                                        (i32.sub (local.get $qx7) (i32.const 1))
                                        (i32.const 0)
                                      )
                                      (then
                                        (local.set $tw22
                                          (f64.add
                                            (f64.load
                                              (i32.add
                                                (local.get $__go0)
                                                (i32.shl
                                                  (local.tee $__pe1
                                                    (i32.sub (local.get $r) (i32.const 1))
                                                  )
                                                  (i32.const 3)
                                                )
                                              )
                                            )
                                            (f64.mul (local.get $e) (f64.const 5))
                                          )
                                        )
                                        (f64.store
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl (local.get $__pe1) (i32.const 3))
                                          )
                                          (local.get $tw22)
                                        )
                                      )
                                    )
                                    (local.set $tw23
                                      (f64.add
                                        (f64.load
                                          (local.tee $__ab2
                                            (i32.add
                                              (local.get $__go0)
                                              (i32.shl (local.get $r) (i32.const 3))
                                            )
                                          )
                                        )
                                        (f64.mul (local.get $e) (f64.const 7))
                                      )
                                    )
                                    (f64.store (local.get $__ab2) (local.get $tw23))
                                    (if
                                      (i32.lt_s
                                        (i32.add (local.get $qx7) (i32.const 1))
                                        (local.get $_pg0)
                                      )
                                      (then
                                        (f64.store offset=8
                                          (local.get $__ab2)
                                          (f64.add
                                            (f64.load offset=8 (local.get $__ab2))
                                            (f64.mul (local.get $e) (f64.const 5))
                                          )
                                        )
                                      )
                                    )
                                    (if
                                      (i32.lt_s
                                        (i32.add (local.get $qx7) (i32.const 2))
                                        (local.get $_pg0)
                                      )
                                      (then
                                        (f64.store offset=16
                                          (local.get $__ab2)
                                          (f64.add
                                            (f64.load offset=16 (local.get $__ab2))
                                            (f64.mul (local.get $e) (f64.const 3))
                                          )
                                        )
                                      )
                                    )
                                  )
                                )
                                (if
                                  (local.get $__li25)
                                  (then
                                    (local.set $r11
                                      (i32.add (local.get $idx8) (local.get $__li26))
                                    )
                                    (if
                                      (i32.ge_s
                                        (i32.sub (local.get $qx7) (i32.const 2))
                                        (i32.const 0)
                                      )
                                      (then
                                        (local.set $tw26
                                          (f64.add
                                            (f64.load
                                              (i32.add
                                                (local.get $__go0)
                                                (i32.shl
                                                  (local.tee $__pe2
                                                    (i32.sub (local.get $r11) (i32.const 2))
                                                  )
                                                  (i32.const 3)
                                                )
                                              )
                                            )
                                            (local.get $e)
                                          )
                                        )
                                        (f64.store
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl (local.get $__pe2) (i32.const 3))
                                          )
                                          (local.get $tw26)
                                        )
                                      )
                                    )
                                    (if
                                      (i32.ge_s
                                        (i32.sub (local.get $qx7) (i32.const 1))
                                        (i32.const 0)
                                      )
                                      (then
                                        (local.set $tw27
                                          (f64.add
                                            (f64.load
                                              (i32.add
                                                (local.get $__go0)
                                                (i32.shl
                                                  (local.tee $__pe3
                                                    (i32.sub (local.get $r11) (i32.const 1))
                                                  )
                                                  (i32.const 3)
                                                )
                                              )
                                            )
                                            (f64.mul (local.get $e) (f64.const 3))
                                          )
                                        )
                                        (f64.store
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl (local.get $__pe3) (i32.const 3))
                                          )
                                          (local.get $tw27)
                                        )
                                      )
                                    )
                                    (local.set $tw28
                                      (f64.add
                                        (f64.load
                                          (local.tee $__ab3
                                            (i32.add
                                              (local.get $__go0)
                                              (i32.shl (local.get $r11) (i32.const 3))
                                            )
                                          )
                                        )
                                        (f64.mul (local.get $e) (f64.const 5))
                                      )
                                    )
                                    (f64.store (local.get $__ab3) (local.get $tw28))
                                    (if
                                      (i32.lt_s
                                        (i32.add (local.get $qx7) (i32.const 1))
                                        (local.get $_pg0)
                                      )
                                      (then
                                        (f64.store offset=8
                                          (local.get $__ab3)
                                          (f64.add
                                            (f64.load offset=8 (local.get $__ab3))
                                            (f64.mul (local.get $e) (f64.const 3))
                                          )
                                        )
                                      )
                                    )
                                    (if
                                      (i32.lt_s
                                        (i32.add (local.get $qx7) (i32.const 2))
                                        (local.get $_pg0)
                                      )
                                      (then
                                        (f64.store offset=16
                                          (local.get $__ab3)
                                          (f64.add
                                            (f64.load offset=16 (local.get $__ab3))
                                            (local.get $e)
                                          )
                                        )
                                      )
                                    )
                                  )
                                )
                                (call $putBW
                                  (local.get $idx8)
                                  (local.get $on10)
                                ) drop
                                (local.set $qx7
                                  (i32.add (local.get $qx7) (i32.const 1))
                                )
                                (br $loop17)
                              )
                            )
                            (local.set $py6
                              (i32.add (local.get $py6) (i32.const 1))
                            )
                            (br $loop16)
                          )
                        )
                      )
                      (else
                        (block $brk31
                          (loop $loop31
                            (br_if $brk31
                              (i32.eqz
                                (i32.lt_s (local.get $py12) (local.get $_pg1))
                              )
                            )
                            (local.set $qx13 (i32.const 0))
                            (block $brk32
                              (local.set $__li11
                                (f64.convert_i32_s (local.get $py12))
                              )
                              (local.set $__li12
                                (i32.add (local.get $py12) (i32.const 1))
                              )
                              (local.set $__li13
                                (i32.add (local.get $py12) (i32.const 2))
                              )
                              (local.set $__li27
                                (f64.mul
                                  (local.get $__li11)
                                  (f64.convert_i32_s (local.get $_pg0))
                                )
                              )
                              (local.set $__li28
                                (i32.lt_s (local.get $__li12) (local.get $_pg1))
                              )
                              (local.set $__li29
                                (i32.lt_s (local.get $__li13) (local.get $_pg1))
                              )
                              (local.set $__li30
                                (i32.shl (local.get $_pg0) (i32.const 1))
                              )
                              (loop $loop32
                                (br_if $brk32
                                  (i32.eqz
                                    (i32.lt_s (local.get $qx13) (local.get $_pg0))
                                  )
                                )
                                (local.set $idx14
                                  (select
                                    (i32.wrap_i64
                                      (i64.trunc_sat_f64_s
                                        (local.tee $inf33
                                          (f64.add
                                            (local.get $__li27)
                                            (f64.convert_i32_s (local.get $qx13))
                                          )
                                        )
                                      )
                                    )
                                    (i32.const 0)
                                    (f64.ne (local.get $inf33) (f64.const Infinity))
                                  )
                                )
                                (local.set $old15
                                  (f64.load
                                    (local.tee $__ab4
                                      (i32.add
                                        (local.get $__go0)
                                        (i32.shl (local.get $idx14) (i32.const 3))
                                      )
                                    )
                                  )
                                )
                                (local.set $on16
                                  (f64.ge (local.get $old15) (f64.const 0.5))
                                )
                                (local.set $err17
                                  (f64.mul
                                    (f64.sub
                                      (local.get $old15)
                                      (f64.convert_i32_s (local.get $on16))
                                    )
                                    (f64.const 0.125)
                                  )
                                )
                                (if
                                  (i32.lt_s
                                    (i32.add (local.get $qx13) (i32.const 1))
                                    (local.get $_pg0)
                                  )
                                  (then
                                    (f64.store offset=8
                                      (local.get $__ab4)
                                      (f64.add
                                        (f64.load offset=8 (local.get $__ab4))
                                        (local.get $err17)
                                      )
                                    )
                                  )
                                )
                                (if
                                  (i32.lt_s
                                    (i32.add (local.get $qx13) (i32.const 2))
                                    (local.get $_pg0)
                                  )
                                  (then
                                    (f64.store offset=16
                                      (local.get $__ab4)
                                      (f64.add
                                        (f64.load offset=16 (local.get $__ab4))
                                        (local.get $err17)
                                      )
                                    )
                                  )
                                )
                                (if
                                  (local.get $__li28)
                                  (then
                                    (if
                                      (i32.gt_s (local.get $qx13) (i32.const 0))
                                      (then
                                        (f64.store
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl
                                              (i32.sub
                                                (i32.add (local.get $idx14) (local.get $_pg0))
                                                (i32.const 1)
                                              )
                                              (i32.const 3)
                                            )
                                          )
                                          (f64.add
                                            (f64.load
                                              (i32.add
                                                (local.get $__go0)
                                                (i32.shl
                                                  (i32.sub
                                                    (i32.add (local.get $idx14) (local.get $_pg0))
                                                    (i32.const 1)
                                                  )
                                                  (i32.const 3)
                                                )
                                              )
                                            )
                                            (local.get $err17)
                                          )
                                        )
                                      )
                                    )
                                    (f64.store
                                      (i32.add
                                        (local.get $__go0)
                                        (i32.shl
                                          (i32.add (local.get $idx14) (local.get $_pg0))
                                          (i32.const 3)
                                        )
                                      )
                                      (f64.add
                                        (f64.load
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl
                                              (i32.add (local.get $idx14) (local.get $_pg0))
                                              (i32.const 3)
                                            )
                                          )
                                        )
                                        (local.get $err17)
                                      )
                                    )
                                    (if
                                      (i32.lt_s
                                        (i32.add (local.get $qx13) (i32.const 1))
                                        (local.get $_pg0)
                                      )
                                      (then
                                        (f64.store offset=8
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl
                                              (i32.add (local.get $idx14) (local.get $_pg0))
                                              (i32.const 3)
                                            )
                                          )
                                          (f64.add
                                            (f64.load offset=8
                                              (i32.add
                                                (local.get $__go0)
                                                (i32.shl
                                                  (i32.add (local.get $idx14) (local.get $_pg0))
                                                  (i32.const 3)
                                                )
                                              )
                                            )
                                            (local.get $err17)
                                          )
                                        )
                                      )
                                    )
                                  )
                                )
                                (if
                                  (local.get $__li29)
                                  (then
                                    (f64.store
                                      (i32.add
                                        (local.get $__go0)
                                        (i32.shl
                                          (i32.add (local.get $idx14) (local.get $__li30))
                                          (i32.const 3)
                                        )
                                      )
                                      (f64.add
                                        (f64.load
                                          (i32.add
                                            (local.get $__go0)
                                            (i32.shl
                                              (i32.add (local.get $idx14) (local.get $__li30))
                                              (i32.const 3)
                                            )
                                          )
                                        )
                                        (local.get $err17)
                                      )
                                    )
                                  )
                                )
                                (call $putBW
                                  (local.get $idx14)
                                  (local.get $on16)
                                ) drop
                                (local.set $qx13
                                  (i32.add (local.get $qx13) (i32.const 1))
                                )
                                (br $loop32)
                              )
                            )
                            (local.set $py12
                              (i32.add (local.get $py12) (i32.const 1))
                            )
                            (br $loop31)
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
    (f64.const nan:0x7FF8000200000000)
  )
  (func
    (export "_alloc")
    (param $bytes i32)
    (result i32)
    (call $__alloc (local.get $bytes))
  )
  (func
    (export "_clear")
    (global.set $__heap (i32.const 1024))
  )
  (func $__start
    (global.set $W (i32.const 0))
    (global.set $H (i32.const 0))
  )
  (start $__start)
)