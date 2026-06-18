(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $__fd_write
      (param i32)
      (param i32)
      (param i32)
      (param i32)
      (result i32)
    )
  )
  (import "wasi_snapshot_preview1" "clock_time_get"
    (func $__clock_time_get
      (param i32)
      (param i64)
      (param i32)
      (result i32)
    )
  )
  (memory (export "memory") 1)
  (data
    (i32.const 0)
    "NaNInfinity-Infinitytruefalsenullundefined[Array][Object]\00\00\00C\d2C\06\0a\00\00\00median_us=\00\00\c5\f23\f2\0a\00\00\00 checksum=\00\00gL^\e1\09\00\00\00 samples=\00\00\00\f1\cd\0b\fe\08\00\00\00 stages=d\d0\b3v\06\00\00\00 runs=\00\00\00\00\00\00\00\00\00\00\08\00\00\00\08\00\00\00\aeG\e1z\14Zp@\c3\f5(\5c\8fZr@\aeG\e1z\14\9at@H\e1z\14\ae\d3u@\00\00\00\00\00\80x@\00\00\00\00\00\80{@\aeG\e1z\14\de~@\00\00\00\00\00Z\80@\00\00\00\00\00\00\00\00\f1\cd\0b\fe\80\00\00\00\00\00\00\00\00\00\00\00C\d2C\06D\00\00\00d\d0\b3v\90\00\00\00\c5\f23\f2X\00\00\00\00\00\00\00\00\00\00\00gL^\e1l"
  )
  (tag $__jz_err (param f64))
  (export "__jz_last_err_bits" (global $__jz_last_err_bits))
  (table
    (export "__jz_table") 0 funcref
  )
  (global $__heap
    (export "__heap")
    (mut i32)
    (i32.const 1024)
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
  (func $__to_str
    (param $val i64)
    (result i64)
    (local $f f64)
    (local $__inl6_val f64)
    (local $__inl6_prec i32)
    (local $__inl6_mode i32)
    (local $__inl6_buf i32)
    (local $__inl6_pos i32)
    (local $__inl6_neg i32)
    (local $__inl6_abs f64)
    (local $__inl6_scale f64)
    (local $__inl6_scaled f64)
    (local $__inl6_int i32)
    (local $__inl6_frac i32)
    (local $__inl6_ilen i32)
    (local $__inl6_i i32)
    (local $__inl6_j i32)
    (local $__inl6___pe0 i32)
    (local $__inl6___pe1 i32)
    (local $__inl6___pe2 i32)
    (local $__inl6___pe3 i32)
    (local $__inl7_arr i64)
    (local $__inl7_sep i64)
    (local $__inl7_off i32)
    (local $__inl7_len i32)
    (local $__inl7_i i32)
    (local $__inl7_result f64)
    (local $__inl7_isTyped i32)
    (local.set $f
      (f64.reinterpret_i64 (local.get $val))
    )
    ;; Not NaN → number, convert
    (if
      (f64.eq (local.get $f) (local.get $f))
      (then
        (return
          (i64.reinterpret_f64
            (block $__inl6
              (result f64)
              (local.set $__inl6_val (local.get $f))
              (local.set $__inl6_prec (i32.const 0))
              (local.set $__inl6_mode (i32.const 0))
              (local.set $__inl6_pos (i32.const 0))
              (local.set $__inl6_neg (i32.const 0))
              (local.set $__inl6_abs (f64.const 0))
              (local.set $__inl6_int (i32.const 0))
              (local.set $__inl6_frac (i32.const 0))
              (local.set $__inl6_ilen (i32.const 0))
              (local.set $__inl6_i (i32.const 0))
              (local.set $__inl6_j (i32.const 0))
              (local.set $__inl6___pe0 (i32.const 0))
              (local.set $__inl6___pe1 (i32.const 0))
              (local.set $__inl6___pe2 (i32.const 0))
              (local.set $__inl6___pe3 (i32.const 0))
              (if
                (f64.ne (local.get $__inl6_val) (local.get $__inl6_val))
                (then
                  (br $__inl6
                    (call $__static_str (i32.const 0))
                  )
                )
              )
              (if
                (f64.eq (local.get $__inl6_val) (f64.const inf))
                (then
                  (br $__inl6
                    (call $__static_str (i32.const 1))
                  )
                )
              )
              (if
                (f64.eq (local.get $__inl6_val) (f64.const -inf))
                (then
                  (br $__inl6
                    (call $__static_str (i32.const 2))
                  )
                )
              )
              ;; ES spec: |x| >= 1e21 or 0 < |x| < 1e-6 → exponential notation (default mode only).
              ;; __toExp clamps the digit count so its scaled mantissa fits an unsigned i32.
              ;; Fewer digits than ECMAScript shortest-repr ideal, but valid output.
              (if
                (i32.eqz (local.get $__inl6_mode))
                (then
                  (if
                    (f64.ge
                      (f64.abs (local.get $__inl6_val))
                      (f64.const 1e21)
                    )
                    (then
                      (br $__inl6
                        (call $__toExp
                          (local.get $__inl6_val)
                          (i32.const 8)
                          (i32.const 1)
                        )
                      )
                    )
                  )
                  (if
                    (i32.and
                      (f64.gt
                        (f64.abs (local.get $__inl6_val))
                        (f64.const 0)
                      )
                      (f64.lt
                        (f64.abs (local.get $__inl6_val))
                        (f64.const 1e-6)
                      )
                    )
                    (then
                      (br $__inl6
                        (call $__toExp
                          (local.get $__inl6_val)
                          (i32.const 8)
                          (i32.const 1)
                        )
                      )
                    )
                  )
                )
              )
              (local.set $__inl6_buf
                (call $__alloc (i32.const 40))
              )
              ;; Sign
              (if
                (f64.lt (local.get $__inl6_val) (f64.const 0))
                (then
                  (local.set $__inl6_neg (i32.const 1))
                  (local.set $__inl6_val
                    (f64.neg (local.get $__inl6_val))
                  )
                )
              )
              (if
                (i32.and
                  (f64.eq (local.get $__inl6_val) (f64.const 0))
                  (local.get $__inl6_neg)
                )
                (then
                  (local.set $__inl6_neg (i32.const 0))
                )
              )
              (if
                (local.get $__inl6_neg)
                (then
                  (i32.store8 (local.get $__inl6_buf) (i32.const 45))
                  (local.set $__inl6_pos (i32.const 1))
                )
              )
              ;; Default mode: auto-select precision (up to 9 digits, must fit i32 when scaled)
              (if
                (i32.eqz (local.get $__inl6_mode))
                (then
                  (local.set $__inl6_prec (i32.const 9))
                )
              )
              ;; Round and scale to integer: scaled = nearest(val * 10^prec).
              ;; NOTE: toFixed/toPrecision round ties-to-even here (f64.nearest), which differs from
              ;; JS's round-half-away-from-zero on exact halves like (2.5).toFixed(0) → '2' vs '3'.
              ;; A naive floor(x+0.5) "fixes" those but breaks values like 1.45 (whose ×10 rounds up
              ;; to 14.5 in f64, giving '1.5' vs JS '1.4'); bit-exact toFixed needs the exact-decimal
              ;; algorithm. Documented as a known difference rather than trading one error for another.
              (local.set $__inl6_scale
                (call $__pow10 (local.get $__inl6_prec))
              )
              (local.set $__inl6_scaled
                (f64.nearest
                  (f64.mul (local.get $__inl6_val) (local.get $__inl6_scale))
                )
              )
              ;; If scaled doesn't fit i32, reduce precision until it does (min prec=0)
              (block $__inl6L_fit
                (loop $__inl6L_fitl
                  (br_if $__inl6L_fit
                    (f64.lt (local.get $__inl6_scaled) (f64.const 2147483648))
                  )
                  (br_if $__inl6L_fit
                    (i32.le_s (local.get $__inl6_prec) (i32.const 0))
                  )
                  (local.set $__inl6_prec
                    (i32.sub (local.get $__inl6_prec) (i32.const 1))
                  )
                  (local.set $__inl6_scale
                    (call $__pow10 (local.get $__inl6_prec))
                  )
                  (local.set $__inl6_scaled
                    (f64.nearest
                      (f64.mul (local.get $__inl6_val) (local.get $__inl6_scale))
                    )
                  )
                  (br $__inl6L_fitl)
                )
              )
              ;; Split: int = scaled / scale, frac = scaled % scale
              (if
                (f64.lt (local.get $__inl6_scaled) (f64.const 2147483648))
                (then
                  (local.set $__inl6_int
                    (i32.trunc_f64_u
                      (f64.div (local.get $__inl6_scaled) (local.get $__inl6_scale))
                    )
                  )
                  (local.set $__inl6_frac
                    (i32.trunc_f64_u
                      (f64.sub
                        (local.get $__inl6_scaled)
                        (f64.mul
                          (f64.convert_i32_u (local.get $__inl6_int))
                          (local.get $__inl6_scale)
                        )
                      )
                    )
                  )
                  ;; Default mode, fit loop reduced prec to 0: the rounded integer is ready, but the
                  ;; original val may still have a fractional part that was discarded.  Recover it:
                  ;; frac_f = val - trunc(val); since frac_f ∈ [0,1), frac_f*10^9 < 10^9 < 2^31 — safe.
                  (if
                    (i32.and
                      (i32.eqz (local.get $__inl6_mode))
                      (i32.eqz (local.get $__inl6_prec))
                    )
                    (then
                      (local.set $__inl6_abs
                        (f64.sub
                          (local.get $__inl6_val)
                          (f64.trunc (local.get $__inl6_val))
                        )
                      )
                      (if
                        (f64.gt (local.get $__inl6_abs) (f64.const 0))
                        (then
                          ;; $int was taken from f64.nearest(val), which rounds .5+ UP (999999999.9 → 1e9),
                          ;; but $abs/$frac below derive from f64.trunc(val). Re-derive $int from the same
                          ;; trunc so integer and fraction agree — else String(999999999.9) → "1000000000.9".
                          (local.set $__inl6_int
                            (i32.trunc_f64_u
                              (f64.trunc (local.get $__inl6_val))
                            )
                          )
                          (local.set $__inl6_prec (i32.const 9))
                          (local.set $__inl6_scale
                            (call $__pow10 (i32.const 9))
                          )
                          ;; round: trunc_u(x+0.5) == floor(x+0.5) for the positive frac scale
                          (local.set $__inl6_frac
                            (i32.trunc_f64_u
                              (f64.add
                                (f64.mul (local.get $__inl6_abs) (f64.const 1000000000))
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
                  (local.set $__inl6_int (i32.const 0))
                  (local.set $__inl6_frac (i32.const 0))
                  (local.set $__inl6_prec (i32.const 0))
                  (local.set $__inl6_abs
                    (f64.trunc (local.get $__inl6_val))
                  )
                  ;; Write large integer digits reversed.
                  ;; Clamp digit to [0,9]: f64 precision loss for large values can make the naive
                  ;; subtraction (abs - trunc(abs/10)*10) go slightly negative → i32.trunc_f64_u trap.
                  (local.set $__inl6_ilen (local.get $__inl6_pos))
                  (block $__inl6L_ld
                    (loop $__inl6L_ll
                      (br_if $__inl6L_ld
                        (f64.lt (local.get $__inl6_abs) (f64.const 1))
                      )
                      (i32.store8
                        (i32.add (local.get $__inl6_buf) (local.get $__inl6_pos))
                        (i32.add
                          (i32.const 48)
                          (i32.trunc_f64_u
                            (f64.max
                              (f64.const 0)
                              (f64.min
                                (f64.const 9)
                                (f64.nearest
                                  (f64.sub
                                    (local.get $__inl6_abs)
                                    (f64.mul
                                      (f64.trunc
                                        (f64.div (local.get $__inl6_abs) (f64.const 10))
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
                      (local.set $__inl6_abs
                        (f64.trunc
                          (f64.div (local.get $__inl6_abs) (f64.const 10))
                        )
                      )
                      (local.set $__inl6_pos
                        (i32.add (local.get $__inl6_pos) (i32.const 1))
                      )
                      (br $__inl6L_ll)
                    )
                  )
                  ;; Reverse
                  (local.set $__inl6_i (local.get $__inl6_ilen))
                  (local.set $__inl6_j
                    (i32.sub (local.get $__inl6_pos) (i32.const 1))
                  )
                  (block $__inl6L_rd
                    (loop $__inl6L_rl
                      (br_if $__inl6L_rd
                        (i32.ge_s (local.get $__inl6_i) (local.get $__inl6_j))
                      )
                      (local.set $__inl6_int
                        (i32.load8_u
                          (local.tee $__inl6___pe0
                            (i32.add (local.get $__inl6_buf) (local.get $__inl6_i))
                          )
                        )
                      )
                      (i32.store8
                        (local.get $__inl6___pe0)
                        (i32.load8_u
                          (local.tee $__inl6___pe1
                            (i32.add (local.get $__inl6_buf) (local.get $__inl6_j))
                          )
                        )
                      )
                      (i32.store8 (local.get $__inl6___pe1) (local.get $__inl6_int))
                      (local.set $__inl6_i
                        (i32.add (local.get $__inl6_i) (i32.const 1))
                      )
                      (local.set $__inl6_j
                        (i32.sub (local.get $__inl6_j) (i32.const 1))
                      )
                      (br $__inl6L_rl)
                    )
                  )
                  ;; Default mode: emit fractional part if val has one (large-int path skipped it before).
                  ;; frac_f = val - trunc(val); since frac_f ∈ [0,1), frac_f*10^9 < 10^9 < 2^31 — safe.
                  (if
                    (i32.eqz (local.get $__inl6_mode))
                    (then
                      (local.set $__inl6_abs
                        (f64.sub
                          (local.get $__inl6_val)
                          (f64.trunc (local.get $__inl6_val))
                        )
                      )
                      (if
                        (f64.gt (local.get $__inl6_abs) (f64.const 0))
                        (then
                          ;; round: trunc_u(x+0.5) == floor(x+0.5) for the positive frac scale
                          (local.set $__inl6_frac
                            (i32.trunc_f64_u
                              (f64.add
                                (f64.mul (local.get $__inl6_abs) (f64.const 1000000000))
                                (f64.const 0.5)
                              )
                            )
                          )
                          (i32.store8
                            (i32.add (local.get $__inl6_buf) (local.get $__inl6_pos))
                            (i32.const 46)
                          )
                          (local.set $__inl6_pos
                            (i32.add (local.get $__inl6_pos) (i32.const 1))
                          )
                          ;; 9 fractional digits from $frac, high-to-low
                          (local.set $__inl6_i (i32.const 8))
                          (block $__inl6L_fd2
                            (loop $__inl6L_fl2
                              (br_if $__inl6L_fd2
                                (i32.lt_s (local.get $__inl6_i) (i32.const 0))
                              )
                              (local.set $__inl6_j
                                (i32.div_u
                                  (local.get $__inl6_frac)
                                  (i32.trunc_f64_u
                                    (call $__pow10 (local.get $__inl6_i))
                                  )
                                )
                              )
                              (i32.store8
                                (i32.add (local.get $__inl6_buf) (local.get $__inl6_pos))
                                (i32.add
                                  (i32.const 48)
                                  (i32.rem_u (local.get $__inl6_j) (i32.const 10))
                                )
                              )
                              (local.set $__inl6_pos
                                (i32.add (local.get $__inl6_pos) (i32.const 1))
                              )
                              (local.set $__inl6_i
                                (i32.sub (local.get $__inl6_i) (i32.const 1))
                              )
                              (br $__inl6L_fl2)
                            )
                          )
                          ;; Strip trailing zeros
                          (block $__inl6L_sz2
                            (loop $__inl6L_sl2
                              (br_if $__inl6L_sz2
                                (i32.le_s (local.get $__inl6_pos) (i32.const 0))
                              )
                              (br_if $__inl6L_sz2
                                (i32.ne
                                  (i32.load8_u
                                    (i32.add
                                      (local.get $__inl6_buf)
                                      (local.tee $__inl6___pe2
                                        (i32.sub (local.get $__inl6_pos) (i32.const 1))
                                      )
                                    )
                                  )
                                  (i32.const 48)
                                )
                              )
                              (local.set $__inl6_pos (local.get $__inl6___pe2))
                              (br $__inl6L_sl2)
                            )
                          )
                          ;; Strip trailing dot
                          (if
                            (i32.and
                              (i32.gt_s (local.get $__inl6_pos) (i32.const 0))
                              (i32.eq
                                (i32.load8_u
                                  (i32.add
                                    (local.get $__inl6_buf)
                                    (i32.sub (local.get $__inl6_pos) (i32.const 1))
                                  )
                                )
                                (i32.const 46)
                              )
                            )
                            (then
                              (local.set $__inl6_pos
                                (i32.sub (local.get $__inl6_pos) (i32.const 1))
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                  (br $__inl6
                    (call $__mkstr
                      (local.get $__inl6_buf)
                      (local.get $__inl6_pos)
                    )
                  )
                )
              )
              ;; Write integer part
              (local.set $__inl6_ilen
                (call $__itoa
                  (local.get $__inl6_int)
                  (i32.add (local.get $__inl6_buf) (local.get $__inl6_pos))
                )
              )
              (local.set $__inl6_pos
                (i32.add (local.get $__inl6_pos) (local.get $__inl6_ilen))
              )
              ;; Write fractional part: extract digits from $frac by dividing by 10^(prec-1), 10^(prec-2), ...
              (if
                (i32.gt_s (local.get $__inl6_prec) (i32.const 0))
                (then
                  (i32.store8
                    (i32.add (local.get $__inl6_buf) (local.get $__inl6_pos))
                    (i32.const 46)
                  )
                  (local.set $__inl6_pos
                    (i32.add (local.get $__inl6_pos) (i32.const 1))
                  )
                  (local.set $__inl6_i
                    (i32.sub (local.get $__inl6_prec) (i32.const 1))
                  )
                  (block $__inl6L_fd
                    (loop $__inl6L_fl
                      (br_if $__inl6L_fd
                        (i32.lt_s (local.get $__inl6_i) (i32.const 0))
                      )
                      (local.set $__inl6_j
                        (i32.div_u
                          (local.get $__inl6_frac)
                          (i32.trunc_f64_u
                            (call $__pow10 (local.get $__inl6_i))
                          )
                        )
                      )
                      (i32.store8
                        (i32.add (local.get $__inl6_buf) (local.get $__inl6_pos))
                        (i32.add
                          (i32.const 48)
                          (i32.rem_u (local.get $__inl6_j) (i32.const 10))
                        )
                      )
                      (local.set $__inl6_pos
                        (i32.add (local.get $__inl6_pos) (i32.const 1))
                      )
                      (local.set $__inl6_i
                        (i32.sub (local.get $__inl6_i) (i32.const 1))
                      )
                      (br $__inl6L_fl)
                    )
                  )
                )
              )
              ;; Default mode: strip trailing zeros and dot — only when a fractional part was emitted.
              ;; Gating on $prec>0 prevents stripping zeros from the integer part (e.g. 1079623680 → 107962368)
              ;; for values where auto-fit reduced prec to 0 because the scaled integer wouldn't fit i32.
              (if
                (i32.and
                  (i32.eqz (local.get $__inl6_mode))
                  (i32.gt_s (local.get $__inl6_prec) (i32.const 0))
                )
                (then
                  (block $__inl6L_sd
                    (loop $__inl6L_sl
                      (br_if $__inl6L_sd
                        (i32.le_s (local.get $__inl6_pos) (i32.const 0))
                      )
                      (br_if $__inl6L_sd
                        (i32.ne
                          (i32.load8_u
                            (i32.add
                              (local.get $__inl6_buf)
                              (local.tee $__inl6___pe3
                                (i32.sub (local.get $__inl6_pos) (i32.const 1))
                              )
                            )
                          )
                          (i32.const 48)
                        )
                      )
                      (local.set $__inl6_pos (local.get $__inl6___pe3))
                      (br $__inl6L_sl)
                    )
                  )
                  (if
                    (i32.and
                      (i32.gt_s (local.get $__inl6_pos) (i32.const 0))
                      (i32.eq
                        (i32.load8_u
                          (i32.add
                            (local.get $__inl6_buf)
                            (i32.sub (local.get $__inl6_pos) (i32.const 1))
                          )
                        )
                        (i32.const 46)
                      )
                    )
                    (then
                      (local.set $__inl6_pos
                        (i32.sub (local.get $__inl6_pos) (i32.const 1))
                      )
                    )
                  )
                )
              )
              (call $__mkstr
                (local.get $__inl6_buf)
                (local.get $__inl6_pos)
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
    (local.set $__inl6_prec
      (i32.and
        (i32.wrap_i64
          (i64.shr_u (local.get $val) (i64.const 47))
        )
        (i32.const 15)
      )
    )
    ;; Plain NaN (type=0) → "NaN" string
    (if
      (i32.eqz (local.get $__inl6_prec))
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
      (i32.eq (local.get $__inl6_prec) (i32.const 1))
      (then
        (return
          (i64.reinterpret_f64
            (block $__inl7
              (result f64)
              (local.set $__inl7_arr (local.get $val))
              (local.set $__inl7_sep
                (i64.reinterpret_f64
                  (call $__mkptr
                    (i32.const 4)
                    (i32.const 16385)
                    (i32.const 44)
                  )
                )
              )
              (local.set $__inl7_isTyped
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
              (local.set $__inl7_off
                (call $__ptr_offset (local.get $val))
              )
              (local.set $__inl7_len
                (call $__len (local.get $val))
              )
              (if
                (i32.eqz (local.get $__inl7_len))
                (then
                  (br $__inl7
                    (call $__mkptr
                      (i32.const 4)
                      (i32.const 16384)
                      (i32.const 0)
                    )
                  )
                )
              )
              (local.set $__inl7_result
                (f64.reinterpret_i64
                  (call $__to_str
                    (if
                      (result i64)
                      (local.get $__inl7_isTyped)
                      (then
                        (i64.reinterpret_f64
                          (call $__typed_idx
                            (local.get $__inl7_arr)
                            (i32.const 0)
                          )
                        )
                      )
                      (else
                        (i64.load (local.get $__inl7_off))
                      )
                    )
                  )
                )
              )
              (local.set $__inl7_i (i32.const 1))
              (block $__inl7L_done
                (loop $__inl7L_loop
                  (br_if $__inl7L_done
                    (i32.ge_s (local.get $__inl7_i) (local.get $__inl7_len))
                  )
                  (local.set $__inl7_result
                    (call $__str_concat
                      (i64.reinterpret_f64 (local.get $__inl7_result))
                      (local.get $__inl7_sep)
                    )
                  )
                  (local.set $__inl7_result
                    (call $__str_concat
                      (i64.reinterpret_f64 (local.get $__inl7_result))
                      (if
                        (result i64)
                        (local.get $__inl7_isTyped)
                        (then
                          (i64.reinterpret_f64
                            (call $__typed_idx
                              (local.get $__inl7_arr)
                              (local.get $__inl7_i)
                            )
                          )
                        )
                        (else
                          (i64.load
                            (i32.add
                              (local.get $__inl7_off)
                              (i32.shl (local.get $__inl7_i) (i32.const 3))
                            )
                          )
                        )
                      )
                    )
                  )
                  (local.set $__inl7_i
                    (i32.add (local.get $__inl7_i) (i32.const 1))
                  )
                  (br $__inl7L_loop)
                )
              )
              (local.get $__inl7_result)
            )
          )
        )
      )
    )
    (local.get $val)
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
  (func $render
    (param $out i32)
    (result f64)
    (local $x1 f64)
    (local $x2 f64)
    (local $y1 f64)
    (local $y2 f64)
    (local $note i32)
    (local $freq f64)
    (local $dph f64)
    (local $ph f64)
    (local $off i32)
    (local $t i32)
    (local $s f64)
    (local $y f64)
    (local $ab1 i32)
    (local $ai2 i32)
    (local $inf3 f64)
    (local $_pg2 f64)
    (local $_pg1 i32)
    (local $_pg0 i32)
    (local $__inl1_v i64)
    (local $__inl1_t i32)
    (local $__inl1_len i32)
    (local $__inl1_i i32)
    (local $__inl1_c i32)
    (local $__inl1_neg i32)
    (local $__inl1_seen i32)
    (local $__inl1_exp i32)
    (local $__inl1_expNeg i32)
    (local $__inl1_expDigits i32)
    (local $__inl1_dot i32)
    (local $__inl1_sigDigits i32)
    (local $__inl1_decExp i32)
    (local $__inl1_dropped i32)
    (local $__inl1_round i32)
    (local $__inl1_radix i32)
    (local $__inl1_digit i32)
    (local $__inl1_sbase i32)
    (local $__inl1_result f64)
    (local $__inl1_f f64)
    (local $__inl1_mant i64)
    (local $__inl13_q f64)
    (local $__inl13_m f64)
    (local $__inl13_phi f64)
    (local $__inl13_p2 f64)
    (local $__inl13_sp f64)
    (local $__inl13_cp f64)
    (local $__inl13_r i32)
    (local $__inl13_ng0 f64)
    (local $__inl13_ng1 f64)
    (local $__li0 i32)
    (local $__li1 f64)
    (local $__li2 i32)
    (local $__li3 i32)
    (local $__li4 i32)
    (local $__li5 f64)
    (local $__li6 i32)
    (local $__li7 f64)
    (local $__li8 i32)
    (local.set $_pg0 (i32.const 8192))
    (local.set $_pg1 (i32.const 400))
    (local.set $_pg2 (f64.const 0.6))
    (block $brk0
      (loop $loop0
        (br_if $brk0
          (i32.eqz
            (i32.lt_s (local.get $note) (i32.const 64))
          )
        )
        (local.set $freq
          (f64.mul
            (block $__inl1
              (result f64)
              (local.set $__inl1_v
                (i64.reinterpret_f64
                  (if
                    (result f64)
                    (i32.lt_u
                      (local.tee $ai2
                        (i32.and
                          (i32.add
                            (i32.mul (local.get $note) (i32.const 3))
                            (i32.const 1)
                          )
                          (i32.const 7)
                        )
                      )
                      (i32.load
                        (i32.sub
                          (local.tee $ab1
                            (call $__ptr_offset (i64.const 0x7ff88000000000a8))
                          )
                          (i32.const 8)
                        )
                      )
                    )
                    (then
                      (f64.load
                        (i32.add
                          (local.get $ab1)
                          (i32.shl (local.get $ai2) (i32.const 3))
                        )
                      )
                    )
                    (else (f64.const nan:0x7FF8000200000000))
                  )
                )
              )
              (local.set $__inl1_c (i32.const 0))
              (local.set $__inl1_neg (i32.const 0))
              (local.set $__inl1_seen (i32.const 0))
              (local.set $__inl1_exp (i32.const 0))
              (local.set $__inl1_expNeg (i32.const 0))
              (local.set $__inl1_expDigits (i32.const 0))
              (local.set $__inl1_dot (i32.const 0))
              (local.set $__inl1_sigDigits (i32.const 0))
              (local.set $__inl1_decExp (i32.const 0))
              (local.set $__inl1_dropped (i32.const 0))
              (local.set $__inl1_round (i32.const 0))
              (local.set $__inl1_radix (i32.const 0))
              (local.set $__inl1_digit (i32.const 0))
              (local.set $__inl1_result (f64.const 0))
              (local.set $__inl1_mant (i64.const 0))
              (local.set $__inl1_f
                (f64.reinterpret_i64 (local.get $__inl1_v))
              )
              (if
                (f64.eq (local.get $__inl1_f) (local.get $__inl1_f))
                (then
                  (br $__inl1 (local.get $__inl1_f))
                )
              )
              (if
                (i64.eq (local.get $__inl1_v) (i64.const 0x7FF8000100000000))
                (then
                  (br $__inl1 (f64.const 0))
                )
              )
              (if
                (i64.eq (local.get $__inl1_v) (i64.const 0x7FF8000200000000))
                (then
                  (br $__inl1 (f64.const nan))
                )
              )
              (if
                (i64.eq (local.get $__inl1_v) (i64.const 0x7FF8000400000000))
                (then
                  (br $__inl1 (f64.const 0))
                )
              )
              (if
                (i64.eq (local.get $__inl1_v) (i64.const 0x7FF8000500000000))
                (then
                  (br $__inl1 (f64.const 1))
                )
              )
              (local.set $__inl1_t
                (i32.and
                  (i32.wrap_i64
                    (i64.shr_u (local.get $__inl1_v) (i64.const 47))
                  )
                  (i32.const 15)
                )
              )
              ;; ToNumber(Symbol) is a TypeError. A Symbol is an ATOM (type 0) with a user
              ;; atom-id (>= 16); null/undefined returned above, and a bare NaN carries
              ;; aux 0, so type==0 && aux>=16 uniquely identifies a Symbol.
              (if
                (i32.and
                  (i32.eqz (local.get $__inl1_t))
                  (i32.ge_u
                    (i32.and
                      (i32.wrap_i64
                        (i64.shr_u (local.get $__inl1_v) (i64.const 32))
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
                (i32.ne (local.get $__inl1_t) (i32.const 4))
                (then
                  (local.set $__inl1_v
                    (call $__to_str (local.get $__inl1_v))
                  )
                  (local.set $__inl1_t
                    (i32.and
                      (i32.wrap_i64
                        (i64.shr_u (local.get $__inl1_v) (i64.const 47))
                      )
                      (i32.const 15)
                    )
                  )
                  (if
                    (i32.ne (local.get $__inl1_t) (i32.const 4))
                    (then
                      (br $__inl1 (f64.const nan))
                    )
                  )
                )
              )
              (local.set $__inl1_len
                (call $__str_byteLen (local.get $__inl1_v))
              )
              (local.set $__inl1_sbase
                (i32.wrap_i64
                  (i64.and (local.get $__inl1_v) (i64.const 4294967295))
                )
              )
              ;; Trim leading whitespace. An empty / all-whitespace string is +0.
              (local.set $__inl1_i
                (call $__skipws
                  (local.get $__inl1_v)
                  (i32.const 0)
                  (local.get $__inl1_len)
                )
              )
              (if
                (i32.ge_s (local.get $__inl1_i) (local.get $__inl1_len))
                (then
                  (br $__inl1 (f64.const 0))
                )
              )
              ;; NonDecimalIntegerLiteral (0x / 0o / 0b). Per the grammar no sign may
              ;; precede the prefix, so it is matched before sign consumption.
              (if
                (i32.and
                  (i32.lt_s
                    (i32.add (local.get $__inl1_i) (i32.const 1))
                    (local.get $__inl1_len)
                  )
                  (i32.eq
                    (if
                      (result i32)
                      (i64.eqz
                        (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                      )
                      (then
                        (i32.load8_u
                          (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                        )
                      )
                      (else
                        (call $__char_at
                          (local.get $__inl1_v)
                          (local.get $__inl1_i)
                        )
                      )
                    )
                    (i32.const 48)
                  )
                )
                (then
                  (local.set $__inl1_c
                    (if
                      (result i32)
                      (i64.eqz
                        (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                      )
                      (then
                        (i32.load8_u
                          (i32.add
                            (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                            (i32.const 1)
                          )
                        )
                      )
                      (else
                        (call $__char_at
                          (local.get $__inl1_v)
                          (i32.add (local.get $__inl1_i) (i32.const 1))
                        )
                      )
                    )
                  )
                  (if
                    (i32.or
                      (i32.eq (local.get $__inl1_c) (i32.const 120))
                      (i32.eq (local.get $__inl1_c) (i32.const 88))
                    )
                    (then
                      (local.set $__inl1_radix (i32.const 16))
                    )
                  )
                  (if
                    (i32.or
                      (i32.eq (local.get $__inl1_c) (i32.const 111))
                      (i32.eq (local.get $__inl1_c) (i32.const 79))
                    )
                    (then
                      (local.set $__inl1_radix (i32.const 8))
                    )
                  )
                  (if
                    (i32.or
                      (i32.eq (local.get $__inl1_c) (i32.const 98))
                      (i32.eq (local.get $__inl1_c) (i32.const 66))
                    )
                    (then
                      (local.set $__inl1_radix (i32.const 2))
                    )
                  )
                )
              )
              (if
                (local.get $__inl1_radix)
                (then
                  (local.set $__inl1_i
                    (i32.add (local.get $__inl1_i) (i32.const 2))
                  )
                  (block $__inl1L_ndDone
                    (local.set $__li0
                      (i64.eqz
                        (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                      )
                    )
                    (local.set $__li1
                      (f64.convert_i32_s (local.get $__inl1_radix))
                    )
                    (loop $__inl1L_ndLoop
                      (br_if $__inl1L_ndDone
                        (i32.ge_s (local.get $__inl1_i) (local.get $__inl1_len))
                      )
                      (local.set $__inl1_c
                        (if
                          (result i32)
                          (local.get $__li0)
                          (then
                            (i32.load8_u
                              (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                            )
                          )
                          (else
                            (call $__char_at
                              (local.get $__inl1_v)
                              (local.get $__inl1_i)
                            )
                          )
                        )
                      )
                      ;; Decode digit; 99 sentinel for any non-[0-9a-fA-F] char so the
                      ;; unsigned ">= radix" test rejects it and any out-of-base digit.
                      (local.set $__inl1_digit
                        (if
                          (result i32)
                          (i32.and
                            (i32.ge_s (local.get $__inl1_c) (i32.const 48))
                            (i32.le_s (local.get $__inl1_c) (i32.const 57))
                          )
                          (then
                            (i32.sub (local.get $__inl1_c) (i32.const 48))
                          )
                          (else
                            (if
                              (result i32)
                              (i32.and
                                (i32.ge_s (local.get $__inl1_c) (i32.const 97))
                                (i32.le_s (local.get $__inl1_c) (i32.const 102))
                              )
                              (then
                                (i32.sub (local.get $__inl1_c) (i32.const 87))
                              )
                              (else
                                (if
                                  (result i32)
                                  (i32.and
                                    (i32.ge_s (local.get $__inl1_c) (i32.const 65))
                                    (i32.le_s (local.get $__inl1_c) (i32.const 70))
                                  )
                                  (then
                                    (i32.sub (local.get $__inl1_c) (i32.const 55))
                                  )
                                  (else (i32.const 99))
                                )
                              )
                            )
                          )
                        )
                      )
                      (br_if $__inl1L_ndDone
                        (i32.ge_u (local.get $__inl1_digit) (local.get $__inl1_radix))
                      )
                      (local.set $__inl1_result
                        (f64.add
                          (f64.mul (local.get $__inl1_result) (local.get $__li1))
                          (f64.convert_i32_s (local.get $__inl1_digit))
                        )
                      )
                      (local.set $__inl1_seen (i32.const 1))
                      (local.set $__inl1_i
                        (i32.add (local.get $__inl1_i) (i32.const 1))
                      )
                      (br $__inl1L_ndLoop)
                    )
                  )
                  ;; No digits, or trailing non-whitespace ("0b1.0", "0xg") → NaN.
                  (if
                    (i32.eqz (local.get $__inl1_seen))
                    (then
                      (br $__inl1 (f64.const nan))
                    )
                  )
                  (local.set $__inl1_i
                    (call $__skipws
                      (local.get $__inl1_v)
                      (local.get $__inl1_i)
                      (local.get $__inl1_len)
                    )
                  )
                  (if
                    (i32.lt_s (local.get $__inl1_i) (local.get $__inl1_len))
                    (then
                      (br $__inl1 (f64.const nan))
                    )
                  )
                  (br $__inl1 (local.get $__inl1_result))
                )
              )
              ;; Sign (StrDecimalLiteral only).
              (if
                (i32.eq
                  (if
                    (result i32)
                    (i64.eqz
                      (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                    )
                    (then
                      (i32.load8_u
                        (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                      )
                    )
                    (else
                      (call $__char_at
                        (local.get $__inl1_v)
                        (local.get $__inl1_i)
                      )
                    )
                  )
                  (i32.const 45)
                )
                (then
                  (local.set $__inl1_neg (i32.const 1))
                  (local.set $__inl1_i
                    (i32.add (local.get $__inl1_i) (i32.const 1))
                  )
                )
              )
              (if
                (i32.eq
                  (if
                    (result i32)
                    (i32.lt_s (local.get $__inl1_i) (local.get $__inl1_len))
                    (then
                      (if
                        (result i32)
                        (i64.eqz
                          (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                        )
                        (then
                          (i32.load8_u
                            (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                          )
                        )
                        (else
                          (call $__char_at
                            (local.get $__inl1_v)
                            (local.get $__inl1_i)
                          )
                        )
                      )
                    )
                    (else (i32.const 0))
                  )
                  (i32.const 43)
                )
                (then
                  (local.set $__inl1_i
                    (i32.add (local.get $__inl1_i) (i32.const 1))
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
                    (i32.lt_s (local.get $__inl1_i) (local.get $__inl1_len))
                    (then
                      (if
                        (result i32)
                        (i64.eqz
                          (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                        )
                        (then
                          (i32.load8_u
                            (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                          )
                        )
                        (else
                          (call $__char_at
                            (local.get $__inl1_v)
                            (local.get $__inl1_i)
                          )
                        )
                      )
                    )
                    (else (i32.const 0))
                  )
                  (i32.const 73)
                )
                (then
                  (block $__inl1L_infBad
                    (local.set $__inl1_digit (i32.const 0))
                    (local.set $__li2
                      (i64.eqz
                        (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                      )
                    )
                    (loop $__inl1L_infl
                      (if
                        (i32.lt_s (local.get $__inl1_digit) (i32.const 8))
                        (then
                          (br_if $__inl1L_infBad
                            (i32.ge_s
                              (i32.add (local.get $__inl1_i) (local.get $__inl1_digit))
                              (local.get $__inl1_len)
                            )
                          )
                          (br_if $__inl1L_infBad
                            (i32.ne
                              (if
                                (result i32)
                                (local.get $__li2)
                                (then
                                  (i32.load8_u
                                    (i32.add
                                      (local.get $__inl1_sbase)
                                      (i32.add (local.get $__inl1_i) (local.get $__inl1_digit))
                                    )
                                  )
                                )
                                (else
                                  (call $__char_at
                                    (local.get $__inl1_v)
                                    (i32.add (local.get $__inl1_i) (local.get $__inl1_digit))
                                  )
                                )
                              )
                              (i32.and
                                (i32.wrap_i64
                                  (i64.shr_u
                                    (i64.const 0x7974696e69666e49)
                                    (i64.extend_i32_u
                                      (i32.shl (local.get $__inl1_digit) (i32.const 3))
                                    )
                                  )
                                )
                                (i32.const 255)
                              )
                            )
                          )
                          (local.set $__inl1_digit
                            (i32.add (local.get $__inl1_digit) (i32.const 1))
                          )
                          (br $__inl1L_infl)
                        )
                      )
                    )
                    (local.set $__inl1_i
                      (call $__skipws
                        (local.get $__inl1_v)
                        (i32.add (local.get $__inl1_i) (i32.const 8))
                        (local.get $__inl1_len)
                      )
                    )
                    (br_if $__inl1L_infBad
                      (i32.lt_s (local.get $__inl1_i) (local.get $__inl1_len))
                    )
                    (br $__inl1
                      (if
                        (result f64)
                        (local.get $__inl1_neg)
                        (then (f64.const -inf))
                        (else (f64.const inf))
                      )
                    )
                  )
                  (br $__inl1 (f64.const nan))
                )
              )
              ;; Decimal significand. Keep 18 significant decimal digits, track the
              ;; base-10 exponent for skipped digits, and round once before pow10 scaling.
              (block $__inl1L_numDone
                (local.set $__li3
                  (i64.eqz
                    (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                  )
                )
                (loop $__inl1L_numLoop
                  (br_if $__inl1L_numDone
                    (i32.ge_s (local.get $__inl1_i) (local.get $__inl1_len))
                  )
                  (local.set $__inl1_c
                    (if
                      (result i32)
                      (local.get $__li3)
                      (then
                        (i32.load8_u
                          (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                        )
                      )
                      (else
                        (call $__char_at
                          (local.get $__inl1_v)
                          (local.get $__inl1_i)
                        )
                      )
                    )
                  )
                  (if
                    (i32.and
                      (i32.eq (local.get $__inl1_c) (i32.const 46))
                      (i32.eqz (local.get $__inl1_dot))
                    )
                    (then
                      (local.set $__inl1_dot (i32.const 1))
                      (local.set $__inl1_i
                        (i32.add (local.get $__inl1_i) (i32.const 1))
                      )
                      (br $__inl1L_numLoop)
                    )
                  )
                  (br_if $__inl1L_numDone
                    (i32.or
                      (i32.lt_s (local.get $__inl1_c) (i32.const 48))
                      (i32.gt_s (local.get $__inl1_c) (i32.const 57))
                    )
                  )
                  (local.set $__inl1_seen (i32.const 1))
                  (local.set $__inl1_c
                    (i32.sub (local.get $__inl1_c) (i32.const 48))
                  )
                  (if
                    (i32.and
                      (i32.eqz (local.get $__inl1_sigDigits))
                      (i32.eqz (local.get $__inl1_c))
                    )
                    (then
                      (if
                        (local.get $__inl1_dot)
                        (then
                          (local.set $__inl1_decExp
                            (i32.sub (local.get $__inl1_decExp) (i32.const 1))
                          )
                        )
                      )
                      (local.set $__inl1_i
                        (i32.add (local.get $__inl1_i) (i32.const 1))
                      )
                      (br $__inl1L_numLoop)
                    )
                  )
                  ;; Accumulate the significand in an i64 (exact to 18 decimal digits,
                  ;; since 10^18 < 2^63) and convert to f64 once at the end — a single
                  ;; correctly-rounded i64->f64 step instead of lossy per-digit f64 math.
                  (if
                    (i32.lt_s (local.get $__inl1_sigDigits) (i32.const 18))
                    (then
                      (local.set $__inl1_mant
                        (i64.add
                          (i64.mul (local.get $__inl1_mant) (i64.const 10))
                          (i64.extend_i32_s (local.get $__inl1_c))
                        )
                      )
                      (local.set $__inl1_sigDigits
                        (i32.add (local.get $__inl1_sigDigits) (i32.const 1))
                      )
                      (if
                        (local.get $__inl1_dot)
                        (then
                          (local.set $__inl1_decExp
                            (i32.sub (local.get $__inl1_decExp) (i32.const 1))
                          )
                        )
                      )
                    )
                    (else
                      (if
                        (i32.eqz (local.get $__inl1_dropped))
                        (then
                          (if
                            (i32.ge_s (local.get $__inl1_c) (i32.const 5))
                            (then
                              (local.set $__inl1_round (i32.const 1))
                            )
                          )
                        )
                      )
                      (local.set $__inl1_dropped (i32.const 1))
                      (if
                        (i32.eqz (local.get $__inl1_dot))
                        (then
                          (local.set $__inl1_decExp
                            (i32.add (local.get $__inl1_decExp) (i32.const 1))
                          )
                        )
                      )
                    )
                  )
                  (local.set $__inl1_i
                    (i32.add (local.get $__inl1_i) (i32.const 1))
                  )
                  (br $__inl1L_numLoop)
                )
              )
              ;; No digits — the literal was a bare sign or stray text ("abc", "+") → NaN.
              ;; (Empty / all-whitespace strings already returned +0 above.)
              (if
                (i32.eqz (local.get $__inl1_seen))
                (then
                  (br $__inl1 (f64.const nan))
                )
              )
              (if
                (local.get $__inl1_round)
                (then
                  (local.set $__inl1_mant
                    (i64.add (local.get $__inl1_mant) (i64.const 1))
                  )
                )
              )
              (local.set $__inl1_result
                (f64.convert_i64_u (local.get $__inl1_mant))
              )
              ;; Scientific notation. 'e'/'E' commits to an ExponentPart — at least one
              ;; digit must follow ("1e", "5e+" are NaN).
              (local.set $__inl1_c
                (if
                  (result i32)
                  (i32.lt_s (local.get $__inl1_i) (local.get $__inl1_len))
                  (then
                    (if
                      (result i32)
                      (i64.eqz
                        (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                      )
                      (then
                        (i32.load8_u
                          (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                        )
                      )
                      (else
                        (call $__char_at
                          (local.get $__inl1_v)
                          (local.get $__inl1_i)
                        )
                      )
                    )
                  )
                  (else (i32.const 0))
                )
              )
              (if
                (i32.or
                  (i32.eq (local.get $__inl1_c) (i32.const 101))
                  (i32.eq (local.get $__inl1_c) (i32.const 69))
                )
                (then
                  (local.set $__inl1_i
                    (i32.add (local.get $__inl1_i) (i32.const 1))
                  )
                  (if
                    (i32.eq
                      (if
                        (result i32)
                        (i32.lt_s (local.get $__inl1_i) (local.get $__inl1_len))
                        (then
                          (if
                            (result i32)
                            (i64.eqz
                              (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                            )
                            (then
                              (i32.load8_u
                                (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                              )
                            )
                            (else
                              (call $__char_at
                                (local.get $__inl1_v)
                                (local.get $__inl1_i)
                              )
                            )
                          )
                        )
                        (else (i32.const 0))
                      )
                      (i32.const 45)
                    )
                    (then
                      (local.set $__inl1_expNeg (i32.const 1))
                      (local.set $__inl1_i
                        (i32.add (local.get $__inl1_i) (i32.const 1))
                      )
                    )
                  )
                  (if
                    (i32.eq
                      (if
                        (result i32)
                        (i32.lt_s (local.get $__inl1_i) (local.get $__inl1_len))
                        (then
                          (if
                            (result i32)
                            (i64.eqz
                              (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                            )
                            (then
                              (i32.load8_u
                                (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                              )
                            )
                            (else
                              (call $__char_at
                                (local.get $__inl1_v)
                                (local.get $__inl1_i)
                              )
                            )
                          )
                        )
                        (else (i32.const 0))
                      )
                      (i32.const 43)
                    )
                    (then
                      (local.set $__inl1_i
                        (i32.add (local.get $__inl1_i) (i32.const 1))
                      )
                    )
                  )
                  (block $__inl1L_expDone
                    (local.set $__li4
                      (i64.eqz
                        (i64.and (local.get $__inl1_v) (i64.const 0x0000400000000000))
                      )
                    )
                    (loop $__inl1L_expLoop
                      (br_if $__inl1L_expDone
                        (i32.ge_s (local.get $__inl1_i) (local.get $__inl1_len))
                      )
                      (local.set $__inl1_c
                        (if
                          (result i32)
                          (local.get $__li4)
                          (then
                            (i32.load8_u
                              (i32.add (local.get $__inl1_sbase) (local.get $__inl1_i))
                            )
                          )
                          (else
                            (call $__char_at
                              (local.get $__inl1_v)
                              (local.get $__inl1_i)
                            )
                          )
                        )
                      )
                      (br_if $__inl1L_expDone
                        (i32.or
                          (i32.lt_s (local.get $__inl1_c) (i32.const 48))
                          (i32.gt_s (local.get $__inl1_c) (i32.const 57))
                        )
                      )
                      (local.set $__inl1_exp
                        (i32.add
                          (i32.mul (local.get $__inl1_exp) (i32.const 10))
                          (i32.sub (local.get $__inl1_c) (i32.const 48))
                        )
                      )
                      (local.set $__inl1_expDigits
                        (i32.add (local.get $__inl1_expDigits) (i32.const 1))
                      )
                      (local.set $__inl1_i
                        (i32.add (local.get $__inl1_i) (i32.const 1))
                      )
                      (br $__inl1L_expLoop)
                    )
                  )
                  (if
                    (i32.eqz (local.get $__inl1_expDigits))
                    (then
                      (br $__inl1 (f64.const nan))
                    )
                  )
                  (if
                    (local.get $__inl1_expNeg)
                    (then
                      (local.set $__inl1_decExp
                        (i32.sub (local.get $__inl1_decExp) (local.get $__inl1_exp))
                      )
                    )
                    (else
                      (local.set $__inl1_decExp
                        (i32.add (local.get $__inl1_decExp) (local.get $__inl1_exp))
                      )
                    )
                  )
                )
              )
              ;; Reject trailing non-whitespace ("5px", numeric separators "1_0", …).
              (local.set $__inl1_i
                (call $__skipws
                  (local.get $__inl1_v)
                  (local.get $__inl1_i)
                  (local.get $__inl1_len)
                )
              )
              (if
                (i32.lt_s (local.get $__inl1_i) (local.get $__inl1_len))
                (then
                  (br $__inl1 (f64.const nan))
                )
              )
              (if
                (i32.gt_s (local.get $__inl1_decExp) (i32.const 0))
                (then
                  (local.set $__inl1_result
                    (f64.mul
                      (local.get $__inl1_result)
                      (call $__pow10 (local.get $__inl1_decExp))
                    )
                  )
                )
              )
              (if
                (i32.lt_s (local.get $__inl1_decExp) (i32.const 0))
                (then
                  (local.set $__inl1_result
                    (f64.div
                      (local.get $__inl1_result)
                      (call $__pow10
                        (i32.sub (i32.const 0) (local.get $__inl1_decExp))
                      )
                    )
                  )
                )
              )
              (if
                (result f64)
                (local.get $__inl1_neg)
                (then
                  (f64.neg (local.get $__inl1_result))
                )
                (else (local.get $__inl1_result))
              )
            )
            (f64.convert_i32_s
              (select
                (i32.const 2)
                (i32.const 1)
                (i32.ne
                  (i32.and
                    (i32.shr_s (local.get $note) (i32.const 2))
                    (i32.const 1)
                  )
                  (i32.const 0)
                )
              )
            )
          )
        )
        (local.set $dph
          (f64.div (local.get $freq) (f64.const 44100))
        )
        (local.set $ph (f64.const 0))
        (local.set $off
          (select
            (i32.wrap_i64
              (i64.trunc_sat_f64_s
                (local.tee $inf3
                  (f64.mul
                    (f64.convert_i32_s (local.get $note))
                    (f64.convert_i32_s (local.get $_pg0))
                  )
                )
              )
            )
            (i32.const 0)
            (f64.ne (local.get $inf3) (f64.const Infinity))
          )
        )
        (local.set $t (i32.const 0))
        (block $brk4
          (local.set $__li5
            (f64.convert_i32_s (local.get $_pg1))
          )
          (local.set $__li6
            (i32.add (local.get $_pg1) (i32.const 1600))
          )
          (local.set $__li7
            (f64.sub (f64.const 1) (local.get $_pg2))
          )
          (local.set $__li8
            (i32.sub (local.get $_pg0) (i32.const 2400))
          )
          (loop $loop4
            (br_if $brk4
              (i32.eqz
                (i32.lt_s (local.get $t) (local.get $_pg0))
              )
            )
            (local.set $s
              (f64.mul
                (block $__inl13
                  (result f64)
                  (local.set $__inl13_ng0 (f64.const 0))
                  (local.set $__inl13_ng1 (f64.const 0))
                  (local.set $__inl13_q
                    (f64.mul (local.get $ph) (f64.const 4))
                  )
                  (local.set $__inl13_m
                    (f64.floor
                      (f64.add (local.get $__inl13_q) (f64.const 0.5))
                    )
                  )
                  (local.set $__inl13_phi
                    (f64.mul
                      (f64.sub (local.get $__inl13_q) (local.get $__inl13_m))
                      (f64.const 1.5707963267948966)
                    )
                  )
                  (local.set $__inl13_p2
                    (f64.mul (local.get $__inl13_phi) (local.get $__inl13_phi))
                  )
                  (local.set $__inl13_sp
                    (f64.mul
                      (local.get $__inl13_phi)
                      (f64.add
                        (f64.const 1)
                        (f64.mul
                          (local.get $__inl13_p2)
                          (f64.add
                            (f64.const -0.16666666666666666)
                            (f64.mul
                              (local.get $__inl13_p2)
                              (f64.add
                                (f64.const 0.008333333333333333)
                                (f64.mul
                                  (local.get $__inl13_p2)
                                  (f64.add
                                    (f64.const -0.0001984126984126984)
                                    (f64.mul
                                      (local.get $__inl13_p2)
                                      (f64.add
                                        (f64.const 0.0000027557319223985893)
                                        (f64.mul (local.get $__inl13_p2) (f64.const -2.505210838544172e-8))
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
                  (local.set $__inl13_cp
                    (f64.add
                      (f64.const 1)
                      (f64.mul
                        (local.get $__inl13_p2)
                        (f64.add
                          (f64.const -0.5)
                          (f64.mul
                            (local.get $__inl13_p2)
                            (f64.add
                              (f64.const 0.041666666666666664)
                              (f64.mul
                                (local.get $__inl13_p2)
                                (f64.add
                                  (f64.const -0.001388888888888889)
                                  (f64.mul
                                    (local.get $__inl13_p2)
                                    (f64.add
                                      (f64.const 0.0000248015873015873)
                                      (f64.mul (local.get $__inl13_p2) (f64.const -2.7557319223985894e-7))
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
                  (local.set $__inl13_r
                    (i32.and
                      (select
                        (i32.wrap_i64
                          (i64.trunc_sat_f64_s (local.get $__inl13_m))
                        )
                        (i32.const 0)
                        (f64.ne (local.get $__inl13_m) (f64.const Infinity))
                      )
                      (i32.const 3)
                    )
                  )
                  (if
                    (result f64)
                    (i32.eq (local.get $__inl13_r) (i32.const 0))
                    (then (local.get $__inl13_sp))
                    (else
                      (if
                        (result f64)
                        (i32.eq (local.get $__inl13_r) (i32.const 1))
                        (then (local.get $__inl13_cp))
                        (else
                          (if
                            (result f64)
                            (i32.eq (local.get $__inl13_r) (i32.const 2))
                            (then
                              (local.set $__inl13_ng0
                                (f64.neg (local.get $__inl13_sp))
                              )
                              (select
                                (f64.const nan)
                                (local.get $__inl13_ng0)
                                (f64.ne (local.get $__inl13_ng0) (local.get $__inl13_ng0))
                              )
                            )
                            (else
                              (local.set $__inl13_ng1
                                (f64.neg (local.get $__inl13_cp))
                              )
                              (select
                                (f64.const nan)
                                (local.get $__inl13_ng1)
                                (f64.ne (local.get $__inl13_ng1) (local.get $__inl13_ng1))
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
                (if
                  (result f64)
                  (i32.lt_s (local.get $t) (local.get $_pg1))
                  (then
                    (f64.div
                      (f64.convert_i32_s (local.get $t))
                      (local.get $__li5)
                    )
                  )
                  (else
                    (if
                      (result f64)
                      (i32.lt_s (local.get $t) (local.get $__li6))
                      (then
                        (f64.sub
                          (f64.const 1)
                          (f64.div
                            (f64.mul
                              (local.get $__li7)
                              (f64.convert_i32_s
                                (i32.sub (local.get $t) (local.get $_pg1))
                              )
                            )
                            (f64.const 1600)
                          )
                        )
                      )
                      (else
                        (select
                          (local.get $_pg2)
                          (f64.mul
                            (f64.div
                              (f64.convert_i32_s
                                (i32.sub (local.get $_pg0) (local.get $t))
                              )
                              (f64.const 2400)
                            )
                            (local.get $_pg2)
                          )
                          (i32.lt_s (local.get $t) (local.get $__li8))
                        )
                      )
                    )
                  )
                )
              )
            )
            (local.set $ph
              (f64.add (local.get $ph) (local.get $dph))
            )
            (if
              (f64.ge (local.get $ph) (f64.const 1))
              (then
                (local.set $ph
                  (f64.sub (local.get $ph) (f64.const 1))
                )
              )
            )
            (local.set $y
              (f64.sub
                (f64.sub
                  (f64.add
                    (f64.add
                      (f64.mul (f64.const 0.0675) (local.get $s))
                      (f64.mul (f64.const 0.135) (local.get $x1))
                    )
                    (f64.mul (f64.const 0.0675) (local.get $x2))
                  )
                  (f64.mul (f64.const -1.143) (local.get $y1))
                )
                (f64.mul (f64.const 0.412) (local.get $y2))
              )
            )
            (local.set $x2 (local.get $x1))
            (local.set $x1 (local.get $s))
            (local.set $y2 (local.get $y1))
            (local.set $y1 (local.get $y))
            (f64.store
              (i32.add
                (local.get $out)
                (i32.shl
                  (i32.add (local.get $off) (local.get $t))
                  (i32.const 3)
                )
              )
              (local.get $y)
            )
            (local.set $t
              (i32.add (local.get $t) (i32.const 1))
            )
            (br $loop4)
          )
        )
        (local.set $note
          (i32.add (local.get $note) (i32.const 1))
        )
        (br $loop0)
      )
    )
    (f64.const nan:0x7FF8000200000000)
  )
  (func $__i32_to_str
    (param $val i32)
    (result f64)
    (local $buf i32)
    (local $len i32)
    (local.set $buf
      (call $__alloc (i32.const 12))
    )
    (if
      (i32.lt_s (local.get $val) (i32.const 0))
      (then
        (i32.store8 (local.get $buf) (i32.const 45))
        ;; '-'
        ;; magnitude as unsigned: negate via 0 - val (INT_MIN maps to itself, read u below)
        (local.set $len
          (call $__itoa
            (i32.sub (i32.const 0) (local.get $val))
            (i32.add (local.get $buf) (i32.const 1))
          )
        )
        (return
          (call $__mkstr
            (local.get $buf)
            (i32.add (local.get $len) (i32.const 1))
          )
        )
      )
      (else
        (local.set $len
          (call $__itoa
            (local.get $val)
            (local.get $buf)
          )
        )
        (return
          (call $__mkstr
            (local.get $buf)
            (local.get $len)
          )
        )
      )
    )
    (f64.const 0)
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
  (func $__typed_idx
    (param $ptr i64)
    (param $i i32)
    (result f64)
    (local $off i32)
    (local $et i32)
    (local $len i32)
    (local $aux i32)
    (local $__pt0 i32)
    (local.set $off
      (call $__ptr_offset (local.get $ptr))
    )
    ;; ARRAY fast path: __ptr_offset already followed any forwarding — read header len + f64.load, no $__len call.
    (if
      (i32.and
        (i32.eq
          (local.tee $__pt0
            (i32.and
              (i32.wrap_i64
                (i64.shr_u (local.get $ptr) (i64.const 47))
              )
              (i32.const 15)
            )
          )
          (i32.const 1)
        )
        (i32.ge_u (local.get $off) (i32.const 8))
      )
      (then
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
      (i32.and
        (i32.wrap_i64
          (i64.shr_u (local.get $ptr) (i64.const 32))
        )
        (i32.const 32767)
      )
    )
    (if
      (i32.and
        (i32.eq (local.get $__pt0) (i32.const 3))
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
          (i32.eq (local.get $__pt0) (i32.const 3))
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
  (func $__alloc_hdr_n
    (param $len i32)
    (param $cap i32)
    (param $stride i32)
    (result i32)
    (local $ptr i32)
    (local $__pe0 i32)
    (local.set $ptr
      (call $__alloc
        (i32.add
          (i32.const 16)
          (local.tee $__pe0
            (i32.mul (local.get $cap) (local.get $stride))
          )
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
    (memory.fill
      (local.tee $ptr
        (i32.add (local.get $ptr) (i32.const 16))
      )
      (i32.const 0)
      (local.get $__pe0)
    )
    (local.get $ptr)
  )
  (func $__time_ms
    (param $clock i32)
    (result f64)
    (drop
      (call $__clock_time_get
        (local.get $clock)
        (i64.const 1000)
        (i32.const 0)
      )
    )
    (f64.div
      (f64.convert_i64_u
        (i64.load (i32.const 0))
      )
      (f64.const 1000000)
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
  (func $main
    (export "main")
    (result f64)
    (local $i1 i32)
    (local $t0 f64)
    (local $tw5 f64)
    (local $__pe0 i32)
    (local $__pe1 i32)
    (local $_pg0 i32)
    (local $__inl10_j i32)
    (local $__inl10_len1 i32)
    (local $__inl10___ab0 i32)
    (local $__inl12_s2 f64)
    (local $__inl12_s3 f64)
    (local $__inl12_s4 f64)
    (local $__inl12_s5 f64)
    (local $__inl12_s6 f64)
    (local $__inl12_s7 f64)
    (local $__inl12_s8 f64)
    (local $__inl12_s9 f64)
    (local $__inl12_s10 f64)
    (local $__inl12_sl11 i32)
    (local $__inl12_sl13 i32)
    (local $__inl12_sl15 i32)
    (local $__inl12_sl16 i32)
    (local $__inl12_sl17 i32)
    (local $__inl12_sl18 i32)
    (local $__inl12_sl19 i32)
    (local $__inl12_sl20 i32)
    (local $__inl12_sl21 i32)
    (local $__inl12_st22 i32)
    (local $__inl12___inl3_fd i32)
    (local $__inl12___inl3_ptr i64)
    (local $__inl12___inl4_ptr i64)
    (local $__iv0_0 i32)
    (local $__iv1_0 i32)
    (local.set $_pg0 (i32.const 21))
    (local.set $__pe0
      (call $__alloc_hdr_n
        (local.tee $__pe0 (i32.const 4194304))
        (local.get $__pe0)
        (i32.const 1)
      )
    )
    (call $render (local.get $__pe0)) drop
    (call $render (local.get $__pe0)) drop
    (call $render (local.get $__pe0)) drop
    (call $render (local.get $__pe0)) drop
    (call $render (local.get $__pe0)) drop
    (local.set $__pe1
      (call $__alloc_hdr_n
        (local.tee $__pe1 (i32.const 168))
        (local.get $__pe1)
        (i32.const 1)
      )
    )
    (block
      (local.set $__iv0_0
        (i32.add
          (local.get $__pe1)
          (i32.shl (local.get $i1) (i32.const 3))
        )
      )
      (block $brk4
        (loop $loop4
          (br_if $brk4
            (i32.eqz
              (i32.lt_s (local.get $i1) (local.get $_pg0))
            )
          )
          (local.set $t0
            (call $__time_ms (i32.const 1))
          )
          (call $render (local.get $__pe0)) drop
          (local.set $tw5
            (f64.sub
              (call $__time_ms (i32.const 1))
              (local.get $t0)
            )
          )
          (f64.store (local.get $__iv0_0) (local.get $tw5))
          (local.set $i1
            (i32.add (local.get $i1) (i32.const 1))
          )
          (local.set $__iv0_0
            (i32.add (local.get $__iv0_0) (i32.const 8))
          )
          (br $loop4)
        )
      )
    )
    (local.set $i1 (i32.const 1))
    (local.set $__inl10_len1
      (i32.shr_u
        (i32.load
          (i32.sub (local.get $__pe1) (i32.const 8))
        )
        (i32.const 3)
      )
    )
    (block
      (local.set $__iv1_0
        (i32.add
          (local.get $__pe1)
          (i32.shl (local.get $i1) (i32.const 3))
        )
      )
      (block $__inl10L_brk0
        (loop $__inl10L_loop0
          (br_if $__inl10L_brk0
            (i32.eqz
              (i32.lt_s (local.get $i1) (local.get $__inl10_len1))
            )
          )
          (local.set $t0
            (f64.load (local.get $__iv1_0))
          )
          (local.set $__inl10_j
            (i32.sub (local.get $i1) (i32.const 1))
          )
          (block $__inl10L_brk2
            (loop $__inl10L_loop2
              (br_if $__inl10L_brk2
                (i32.eqz
                  (i32.and
                    (i32.ge_s (local.get $__inl10_j) (i32.const 0))
                    (f64.gt
                      (f64.load
                        (local.tee $__inl10___ab0
                          (i32.add
                            (local.get $__pe1)
                            (i32.shl (local.get $__inl10_j) (i32.const 3))
                          )
                        )
                      )
                      (local.get $t0)
                    )
                  )
                )
              )
              (f64.store offset=8
                (local.get $__inl10___ab0)
                (f64.load (local.get $__inl10___ab0))
              )
              (local.set $__inl10_j
                (i32.sub (local.get $__inl10_j) (i32.const 1))
              )
              (br $__inl10L_loop2)
            )
          )
          (f64.store offset=8
            (i32.add
              (local.get $__pe1)
              (i32.shl (local.get $__inl10_j) (i32.const 3))
            )
            (local.get $t0)
          )
          (local.set $i1
            (i32.add (local.get $i1) (i32.const 1))
          )
          (local.set $__iv1_0
            (i32.add (local.get $__iv1_0) (i32.const 8))
          )
          (br $__inl10L_loop0)
        )
      )
    )
    (local.set $__pe1
      (select
        (i32.wrap_i64
          (i64.trunc_sat_f64_s
            (local.tee $t0
              (f64.mul
                (f64.load
                  (i32.add
                    (local.get $__pe1)
                    (i32.shl
                      (i32.shr_s
                        (i32.sub
                          (i32.shr_u
                            (i32.load
                              (i32.sub (local.get $__pe1) (i32.const 8))
                            )
                            (i32.const 3)
                          )
                          (i32.const 1)
                        )
                        (i32.const 1)
                      )
                      (i32.const 3)
                    )
                  )
                )
                (f64.const 1000)
              )
            )
          )
        )
        (i32.const 0)
        (f64.ne (local.get $t0) (f64.const Infinity))
      )
    )
    (local.set $i1 (i32.const 0))
    (local.set $t0
      (call $__mkptr
        (i32.const 2)
        (i32.const 0)
        (local.get $__pe0)
      )
    )
    (local.set $__inl10_len1
      (call $__ptr_offset
        (i64.reinterpret_f64 (local.get $t0))
      )
    )
    (local.set $__inl10_j
      (call $__alloc (i32.const 16))
    )
    (i32.store
      (local.get $__inl10_j)
      (i32.shl
        (i32.trunc_sat_f64_s
          (f64.mul
            (f64.convert_i32_s
              (i32.shr_u
                (i32.load
                  (i32.sub (local.get $__pe0) (i32.const 8))
                )
                (i32.const 3)
              )
            )
            (f64.const 2)
          )
        )
        (i32.const 2)
      )
    )
    (i32.store offset=4
      (local.get $__inl10_j)
      (i32.add
        (local.get $__inl10_len1)
        (i32.trunc_sat_f64_s (f64.const 0))
      )
    )
    (i32.store offset=8
      (local.get $__inl10_j)
      (local.get $__inl10_len1)
    )
    (local.set $__pe0 (local.get $__inl10_j))
    (local.set $__inl10_len1 (i32.const -2128831035))
    (local.set $__inl10_j
      (i32.shr_u
        (i32.load (local.get $__inl10_j))
        (i32.const 2)
      )
    )
    (block $__inl11L_brk4
      (loop $__inl11L_loop4
        (br_if $__inl11L_brk4
          (i32.eqz
            (i32.lt_s (local.get $i1) (local.get $__inl10_j))
          )
        )
        (local.set $__inl10_len1
          (i32.mul
            (i32.xor
              (local.get $__inl10_len1)
              (i32.load
                (i32.add
                  (i32.load offset=4 (local.get $__pe0))
                  (i32.shl (local.get $i1) (i32.const 2))
                )
              )
            )
            (i32.const 16777619)
          )
        )
        (local.set $i1
          (i32.add (local.get $i1) (i32.const 256))
        )
        (br $__inl11L_loop4)
      )
    )
    (local.set $__pe0 (local.get $__inl10_len1))
    (local.set $_pg0 (i32.const 0))
    (local.set $i1 (i32.const 0))
    (local.set $__inl10_len1 (i32.const 0))
    (local.set $__inl10_j (i32.const 0))
    (local.set $__inl10___ab0 (i32.const 0))
    (local.set $__inl12___inl3_fd (i32.const 1))
    (local.set $__inl12___inl3_ptr
      (i64.reinterpret_f64
        (block
          (result f64)
          (local.set $t0
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa000100000044))
            )
          )
          (local.set $__inl12_sl11
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $t0))
            )
          )
          (local.set $tw5
            (call $__i32_to_str (local.get $__pe1))
          )
          (local.set $__pe1
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $tw5))
            )
          )
          (local.set $__inl12_s2
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa000100000058))
            )
          )
          (local.set $__inl12_sl13
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_s2))
            )
          )
          (local.set $__inl12_s3
            (call $__i32_to_str (local.get $__pe0))
          )
          (local.set $__pe0
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_s3))
            )
          )
          (local.set $__inl12_s4
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa00010000006c))
            )
          )
          (local.set $__inl12_sl15
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_s4))
            )
          )
          (local.set $__inl12_s5
            (call $__i32_to_str (i32.const 524288))
          )
          (local.set $__inl12_sl16
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_s5))
            )
          )
          (local.set $__inl12_s6
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa000100000080))
            )
          )
          (local.set $__inl12_sl17
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_s6))
            )
          )
          (local.set $__inl12_s7
            (call $__i32_to_str (i32.const 64))
          )
          (local.set $__inl12_sl18
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_s7))
            )
          )
          (local.set $__inl12_s8
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa000100000090))
            )
          )
          (local.set $__inl12_sl19
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_s8))
            )
          )
          (local.set $__inl12_s9
            (call $__i32_to_str (i32.const 21))
          )
          (local.set $__inl12_sl20
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_s9))
            )
          )
          (local.set $__inl12_s10
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa400000000000))
            )
          )
          (local.set $__inl12_sl21
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_s10))
            )
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_sl11) (local.get $__pe1))
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_st22) (local.get $__inl12_sl13))
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_st22) (local.get $__pe0))
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_st22) (local.get $__inl12_sl15))
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_st22) (local.get $__inl12_sl16))
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_st22) (local.get $__inl12_sl17))
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_st22) (local.get $__inl12_sl18))
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_st22) (local.get $__inl12_sl19))
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_st22) (local.get $__inl12_sl20))
          )
          (local.set $__inl12_st22
            (i32.add (local.get $__inl12_st22) (local.get $__inl12_sl21))
          )
          (if
            (result f64)
            (i32.eqz (local.get $__inl12_st22))
            (then (f64.const nan:0x7FFA400000000000))
            (else
              (local.set $_pg0
                (call $__alloc
                  (i32.add (i32.const 4) (local.get $__inl12_st22))
                )
              )
              (i32.store (local.get $_pg0) (local.get $__inl12_st22))
              (local.set $_pg0
                (i32.add (local.get $_pg0) (i32.const 4))
              )
              (local.set $i1 (local.get $_pg0))
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $t0))
                (local.get $_pg0)
                (local.get $__inl12_sl11)
              )
              (local.set $i1
                (i32.add (local.get $_pg0) (local.get $__inl12_sl11))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $tw5))
                (local.get $i1)
                (local.get $__pe1)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__pe1))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_s2))
                (local.get $i1)
                (local.get $__inl12_sl13)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__inl12_sl13))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_s3))
                (local.get $i1)
                (local.get $__pe0)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__pe0))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_s4))
                (local.get $i1)
                (local.get $__inl12_sl15)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__inl12_sl15))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_s5))
                (local.get $i1)
                (local.get $__inl12_sl16)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__inl12_sl16))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_s6))
                (local.get $i1)
                (local.get $__inl12_sl17)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__inl12_sl17))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_s7))
                (local.get $i1)
                (local.get $__inl12_sl18)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__inl12_sl18))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_s8))
                (local.get $i1)
                (local.get $__inl12_sl19)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__inl12_sl19))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_s9))
                (local.get $i1)
                (local.get $__inl12_sl20)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__inl12_sl20))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_s10))
                (local.get $i1)
                (local.get $__inl12_sl21)
              )
              (local.set $i1
                (i32.add (local.get $i1) (local.get $__inl12_sl21))
              )
              (call $__mkptr
                (i32.const 4)
                (i32.const 0)
                (local.get $_pg0)
              )
            )
          )
        )
      )
    )
    (local.set $_pg0 (i32.const 0))
    (local.set $__pe0 (i32.const 0))
    (local.set $__pe1 (i32.const 0))
    (local.set $i1
      (call $__alloc (i32.const 12))
    )
    (local.set $__inl12_sl11
      (i32.and
        (i32.wrap_i64
          (i64.shr_u (local.get $__inl12___inl3_ptr) (i64.const 32))
        )
        (i32.const 32767)
      )
    )
    (if
      (i32.and (local.get $__inl12_sl11) (i32.const 16384))
      (then
        (local.set $_pg0
          (i32.and (local.get $__inl12_sl11) (i32.const 7))
        )
        (local.set $__pe1
          (call $__alloc (local.get $_pg0))
        )
        (local.set $__pe0 (i32.const 0))
        (block $__inl12L___inl3L_done
          (loop $__inl12L___inl3L_loop
            (br_if $__inl12L___inl3L_done
              (i32.ge_s (local.get $__pe0) (local.get $_pg0))
            )
            (i32.store8
              (i32.add (local.get $__pe1) (local.get $__pe0))
              (block $__inl12L___inl5
                (result i32)
                (local.set $__inl10___ab0 (local.get $__pe0))
                (i32.and
                  (i32.shr_u
                    (i32.wrap_i64
                      (i64.and (local.get $__inl12___inl3_ptr) (i64.const 4294967295))
                    )
                    (i32.shl (local.get $__pe0) (i32.const 3))
                  )
                  (i32.const 0xFF)
                )
              )
            )
            (local.set $__pe0
              (i32.add (local.get $__pe0) (i32.const 1))
            )
            (br $__inl12L___inl3L_loop)
          )
        )
        (i32.store (local.get $i1) (local.get $__pe1))
        (i32.store offset=4
          (local.get $i1)
          (local.get $_pg0)
        )
      )
      (else
        (i32.store
          (local.get $i1)
          (call $__ptr_offset (local.get $__inl12___inl3_ptr))
        )
        (i32.store offset=4
          (local.get $i1)
          (block $__inl12L___inl4
            (result i32)
            (local.set $__inl12___inl4_ptr (local.get $__inl12___inl3_ptr))
            (if
              (i32.ne
                (i32.and
                  (i32.wrap_i64
                    (i64.shr_u (local.get $__inl12___inl4_ptr) (i64.const 47))
                  )
                  (i32.const 15)
                )
                (i32.const 4)
              )
              (then
                (br $__inl12L___inl4 (i32.const 0))
              )
            )
            (local.set $__inl10_j
              (i32.and
                (i32.wrap_i64
                  (i64.shr_u (local.get $__inl12___inl4_ptr) (i64.const 32))
                )
                (i32.const 32767)
              )
            )
            (if
              (i32.and (local.get $__inl10_j) (i32.const 16384))
              (then
                (br $__inl12L___inl4
                  (i32.and (local.get $__inl10_j) (i32.const 7))
                )
              )
            )
            (local.set $__inl10_len1
              (call $__ptr_offset (local.get $__inl12___inl4_ptr))
            )
            (if
              (result i32)
              (i32.ge_u (local.get $__inl10_len1) (i32.const 4))
              (then
                (i32.load
                  (i32.sub (local.get $__inl10_len1) (i32.const 4))
                )
              )
              (else (i32.const 0))
            )
          )
        )
      )
    )
    (drop
      (call $__fd_write
        (local.get $__inl12___inl3_fd)
        (local.get $i1)
        (i32.const 1)
        (i32.add (local.get $i1) (i32.const 8))
      )
    )
    (local.set $_pg0 (i32.const 1))
    (local.set $__pe0 (i32.const 10))
    (local.set $__pe1
      (call $__alloc (i32.const 13))
    )
    (i32.store8
      (local.tee $i1
        (i32.add (local.get $__pe1) (i32.const 12))
      )
      (i32.const 10)
    )
    (i32.store (local.get $__pe1) (local.get $i1))
    (i32.store offset=4
      (local.get $__pe1)
      (i32.const 1)
    )
    (drop
      (call $__fd_write
        (i32.const 1)
        (local.get $__pe1)
        (i32.const 1)
        (i32.add (local.get $__pe1) (i32.const 8))
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
)