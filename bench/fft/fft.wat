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
    "NaNInfinity-Infinitytruefalsenullundefined[Array][Object]\00\00\00C\d2C\06\0a\00\00\00median_us=\00\00\c5\f23\f2\0a\00\00\00 checksum=\00\00gL^\e1\09\00\00\00 samples=\00\00\00\f1\cd\0b\fe\08\00\00\00 stages=d\d0\b3v\06\00\00\00 runs=\00\00\00\00\00\00\00\00\00\00\f1\cd\0b\fe\80\00\00\00\00\00\00\00\00\00\00\00C\d2C\06D\00\00\00d\d0\b3v\90\00\00\00\c5\f23\f2X\00\00\00\00\00\00\00\00\00\00\00gL^\e1l"
  )
  (table
    (export "__jz_table") 0 funcref
  )
  (global $__heap
    (export "__heap")
    (mut i32)
    (i32.const 1024)
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
  (func $__alloc_hdr_n_d_d_1
    (param $a0 i32)
    (param $a1 i32)
    (result i32)
    (local $__inl3_len i32)
    (local $__inl3_stride i32)
    (local $__inl3_ptr i32)
    (local.set $__inl3_len (local.get $a0))
    (local.set $__inl3_stride (i32.const 1))
    (local.set $__inl3_ptr
      (call $__alloc
        (i32.add
          (i32.const 16)
          (local.tee $__inl3_stride (local.get $a1))
        )
      )
    )
    (i64.store (local.get $__inl3_ptr) (i64.const 0))
    (i32.store offset=8
      (local.get $__inl3_ptr)
      (local.get $a0)
    )
    (i32.store offset=12
      (local.get $__inl3_ptr)
      (local.get $a1)
    )
    (memory.fill
      (local.tee $__inl3_len
        (i32.add (local.get $__inl3_ptr) (i32.const 16))
      )
      (i32.const 0)
      (local.get $__inl3_stride)
    )
    (local.get $__inl3_len)
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
  (func $fft
    (param $re i32)
    (param $im i32)
    (param $wre i32)
    (param $wim i32)
    (param $n i32)
    (result f64)
    (local $i i32)
    (local $j i32)
    (local $bit i32)
    (local $tr f64)
    (local $ti f64)
    (local $xi f64)
    (local $tr3 f64)
    (local $ti4 f64)
    (local $tw2 f64)
    (local $tw4 f64)
    (local $tw10 f64)
    (local $tw11 f64)
    (local $__ab0 i32)
    (local $__ab1 i32)
    (local $__ab2 i32)
    (local $__ab3 i32)
    (local $__ab4 i32)
    (local $__ab5 i32)
    (local $__ab6 i32)
    (local $__ab7 i32)
    (local $__pe0 i32)
    (local $__pe1 i32)
    (local $__pe4 i32)
    (local.set $i (i32.const 1))
    (block $brk0
      (loop $loop0
        (br_if $brk0
          (i32.eqz
            (i32.lt_s (local.get $i) (i32.const 65536))
          )
        )
        (local.set $bit (i32.const 32768))
        (block $brk1
          (loop $loop1
            (br_if $brk1
              (i32.eqz
                (i32.ne
                  (i32.and (local.get $j) (local.get $bit))
                  (i32.const 0)
                )
              )
            )
            (local.set $j
              (i32.xor (local.get $j) (local.get $bit))
            )
            (local.set $bit
              (i32.shr_s (local.get $bit) (i32.const 1))
            )
            (br $loop1)
          )
        )
        (local.set $j
          (i32.xor (local.get $j) (local.get $bit))
        )
        (if
          (i32.lt_s (local.get $i) (local.get $j))
          (then
            (local.set $tr
              (f64.load
                (local.tee $__ab0
                  (i32.add
                    (local.get $re)
                    (local.tee $__pe0
                      (i32.shl (local.get $i) (i32.const 3))
                    )
                  )
                )
              )
            )
            (local.set $tw2
              (f64.load
                (local.tee $__ab1
                  (i32.add
                    (local.get $re)
                    (local.tee $__pe1
                      (i32.shl (local.get $j) (i32.const 3))
                    )
                  )
                )
              )
            )
            (f64.store (local.get $__ab0) (local.get $tw2))
            (f64.store (local.get $__ab1) (local.get $tr))
            (local.set $ti
              (f64.load
                (local.tee $__ab2
                  (i32.add (local.get $im) (local.get $__pe0))
                )
              )
            )
            (local.set $tw4
              (f64.load
                (local.tee $__ab3
                  (i32.add (local.get $im) (local.get $__pe1))
                )
              )
            )
            (f64.store (local.get $__ab2) (local.get $tw4))
            (f64.store (local.get $__ab3) (local.get $ti))
          )
        )
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (br $loop0)
      )
    )
    (local.set $i (i32.const 2))
    (block $brk6
      (loop $loop6
        (br_if $brk6
          (i32.eqz
            (i32.le_s (local.get $i) (i32.const 65536))
          )
        )
        (local.set $bit
          (i32.shr_s (local.get $i) (i32.const 1))
        )
        (local.set $j
          (select
            (i32.wrap_i64
              (i64.trunc_sat_f64_s
                (local.tee $tr
                  (f64.div
                    (f64.const 65536)
                    (f64.convert_i32_s (local.get $i))
                  )
                )
              )
            )
            (i32.const 0)
            (f64.ne (local.get $tr) (f64.const Infinity))
          )
        )
        (local.set $__pe0 (i32.const 0))
        (block $brk8
          (loop $loop8
            (br_if $brk8
              (i32.eqz
                (i32.lt_s (local.get $__pe0) (i32.const 65536))
              )
            )
            (local.set $__ab0 (i32.const 0))
            (local.set $__pe1 (i32.const 0))
            (block $brk9
              (loop $loop9
                (br_if $brk9
                  (i32.eqz
                    (i32.lt_s (local.get $__ab0) (local.get $bit))
                  )
                )
                (local.set $tw2
                  (f64.load
                    (i32.add
                      (local.get $wre)
                      (local.tee $__ab1
                        (i32.shl (local.get $__pe1) (i32.const 3))
                      )
                    )
                  )
                )
                (local.set $ti
                  (f64.load
                    (i32.add (local.get $wim) (local.get $__ab1))
                  )
                )
                (local.set $__ab2
                  (i32.add (local.get $__pe0) (local.get $__ab0))
                )
                (local.set $tw4
                  (f64.load
                    (local.tee $__ab4
                      (i32.add
                        (local.get $re)
                        (local.tee $__ab3
                          (i32.shl
                            (i32.add (local.get $__ab2) (local.get $bit))
                            (i32.const 3)
                          )
                        )
                      )
                    )
                  )
                )
                (local.set $xi
                  (f64.load
                    (local.tee $__ab5
                      (i32.add (local.get $im) (local.get $__ab3))
                    )
                  )
                )
                (local.set $tr3
                  (f64.sub
                    (f64.mul (local.get $tw2) (local.get $tw4))
                    (f64.mul (local.get $ti) (local.get $xi))
                  )
                )
                (local.set $ti4
                  (f64.add
                    (f64.mul (local.get $tw2) (local.get $xi))
                    (f64.mul (local.get $ti) (local.get $tw4))
                  )
                )
                (local.set $tw10
                  (f64.sub
                    (f64.load
                      (local.tee $__ab6
                        (i32.add
                          (local.get $re)
                          (local.tee $__pe4
                            (i32.shl (local.get $__ab2) (i32.const 3))
                          )
                        )
                      )
                    )
                    (local.get $tr3)
                  )
                )
                (f64.store (local.get $__ab4) (local.get $tw10))
                (local.set $tw11
                  (f64.sub
                    (f64.load
                      (local.tee $__ab7
                        (i32.add (local.get $im) (local.get $__pe4))
                      )
                    )
                    (local.get $ti4)
                  )
                )
                (f64.store (local.get $__ab5) (local.get $tw11))
                (f64.store
                  (local.get $__ab6)
                  (f64.add
                    (f64.load (local.get $__ab6))
                    (local.get $tr3)
                  )
                )
                (f64.store
                  (local.get $__ab7)
                  (f64.add
                    (f64.load (local.get $__ab7))
                    (local.get $ti4)
                  )
                )
                (local.set $__ab0
                  (i32.add (local.get $__ab0) (i32.const 1))
                )
                (local.set $__pe1
                  (i32.add (local.get $__pe1) (local.get $j))
                )
                (br $loop9)
              )
            )
            (local.set $__pe0
              (i32.add (local.get $__pe0) (local.get $i))
            )
            (br $loop8)
          )
        )
        (local.set $i
          (i32.shl (local.get $i) (i32.const 1))
        )
        (br $loop6)
      )
    )
    (f64.const nan:0x7FF8000200000000)
  )
  (func $main
    (export "main")
    (result f64)
    (local $inl6_dt f64)
    (local $inl10_ci f64)
    (local $inl11_half i32)
    (local $inl12_k i32)
    (local $inl14_ni f64)
    (local $i i32)
    (local $i5 i32)
    (local $__pe2 i32)
    (local $__pe3 i32)
    (local $__pe4 i32)
    (local $_pg1 i32)
    (local $_pg0 i32)
    (local $__inl11_s5 f64)
    (local $__inl11_s6 f64)
    (local $__inl11_s7 f64)
    (local $__inl11_s8 f64)
    (local $__inl11_s9 f64)
    (local $__inl11_s10 f64)
    (local $__inl11_sl17 i32)
    (local $__inl11_sl18 i32)
    (local $__inl11_sl19 i32)
    (local $__inl11_sl20 i32)
    (local $__inl11_sl21 i32)
    (local $__inl11_st22 i32)
    (local $__inl11___inl2_ptr i64)
    (local $__inl11___inl4_ptr i64)
    (local $__inl12_x2 f64)
    (local $__inl13_x f64)
    (local $__inl14_n i32)
    (local $__inl14_s i32)
    (local $__inl14___pe0 i32)
    (local $__iv0_0 i32)
    (local $__simd_bound1 i32)
    (local $inl6_dt__v v128)
    (local $__simd_bound2 i32)
    (local $__iv3_0 i32)
    (local $__iv4_0 i32)
    (local.set $_pg0 (i32.const 65536))
    (local.set $_pg1 (i32.const 21))
    (local.set $__inl14___pe0
      (call $__alloc_hdr_n_d_d_1
        (local.tee $__inl14___pe0 (i32.const 524288))
        (local.get $__inl14___pe0)
      )
    )
    (local.set $__inl14_s (i32.const 305441741))
    (block
      (local.set $__iv0_0
        (i32.add
          (local.get $__inl14___pe0)
          (i32.shl (local.get $__inl14_n) (i32.const 3))
        )
      )
      (block $__inl14L_brk2
        (loop $__inl14L_loop2
          (br_if $__inl14L_brk2
            (i32.eqz
              (i32.lt_s (local.get $__inl14_n) (i32.const 65536))
            )
          )
          (local.set $__inl14_s
            (i32.xor
              (local.get $__inl14_s)
              (i32.shl (local.get $__inl14_s) (i32.const 13))
            )
          )
          (local.set $__inl14_s
            (i32.xor
              (local.get $__inl14_s)
              (i32.shr_u (local.get $__inl14_s) (i32.const 17))
            )
          )
          (local.set $__inl14_s
            (i32.xor
              (local.get $__inl14_s)
              (i32.shl (local.get $__inl14_s) (i32.const 5))
            )
          )
          (f64.store
            (local.get $__iv0_0)
            (f64.sub
              (f64.mul
                (f64.div
                  (f64.convert_i32_u (local.get $__inl14_s))
                  (f64.const 4294967296)
                )
                (f64.const 2)
              )
              (f64.const 1)
            )
          )
          (local.set $__inl14_n
            (i32.add (local.get $__inl14_n) (i32.const 1))
          )
          (local.set $__iv0_0
            (i32.add (local.get $__iv0_0) (i32.const 8))
          )
          (br $__inl14L_loop2)
        )
      )
    )
    (local.set $__inl14_n (local.get $__inl14___pe0))
    (local.set $__inl14___pe0
      (call $__alloc_hdr_n_d_d_1
        (local.tee $__inl14___pe0
          (i32.shl (local.get $_pg0) (i32.const 3))
        )
        (local.get $__inl14___pe0)
      )
    )
    (local.set $__inl14_s
      (call $__alloc_hdr_n_d_d_1
        (local.tee $__inl14_s
          (i32.shl (local.get $_pg0) (i32.const 3))
        )
        (local.get $__inl14_s)
      )
    )
    (local.set $__pe2
      (call $__alloc_hdr_n_d_d_1
        (local.tee $__pe2
          (i32.shl
            (i32.shr_s (local.get $_pg0) (i32.const 1))
            (i32.const 3)
          )
        )
        (local.get $__pe2)
      )
    )
    (local.set $__pe3
      (call $__alloc_hdr_n_d_d_1
        (local.tee $__pe3
          (i32.shl
            (i32.shr_s (local.get $_pg0) (i32.const 1))
            (i32.const 3)
          )
        )
        (local.get $__pe3)
      )
    )
    (local.set $inl6_dt
      (f64.div
        (f64.const -6.283185307179586)
        (f64.convert_i32_s (local.get $_pg0))
      )
    )
    (local.set $__inl13_x
      (f64.mul (local.get $inl6_dt) (local.get $inl6_dt))
    )
    (local.set $__inl13_x
      (f64.add
        (f64.const 1)
        (f64.mul
          (local.get $__inl13_x)
          (f64.add
            (f64.const -0.5)
            (f64.mul
              (local.get $__inl13_x)
              (f64.add
                (f64.const 0.041666666666666664)
                (f64.mul
                  (local.get $__inl13_x)
                  (f64.add
                    (f64.const -0.001388888888888889)
                    (f64.mul
                      (local.get $__inl13_x)
                      (f64.add
                        (f64.const 0.0000248015873015873)
                        (f64.mul (local.get $__inl13_x) (f64.const -2.7557319223985894e-7))
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
    (local.set $__inl12_x2
      (f64.mul (local.get $inl6_dt) (local.get $inl6_dt))
    )
    (local.set $inl6_dt
      (f64.mul
        (local.get $inl6_dt)
        (f64.add
          (f64.const 1)
          (f64.mul
            (local.get $__inl12_x2)
            (f64.add
              (f64.const -0.16666666666666666)
              (f64.mul
                (local.get $__inl12_x2)
                (f64.add
                  (f64.const 0.008333333333333333)
                  (f64.mul
                    (local.get $__inl12_x2)
                    (f64.add
                      (f64.const -0.0001984126984126984)
                      (f64.mul
                        (local.get $__inl12_x2)
                        (f64.add
                          (f64.const 0.0000027557319223985893)
                          (f64.mul (local.get $__inl12_x2) (f64.const -2.505210838544172e-8))
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
    (local.set $__inl12_x2 (f64.const 1))
    (local.set $inl11_half
      (i32.shr_s (local.get $_pg0) (i32.const 1))
    )
    (block $brk8
      (loop $loop8
        (br_if $brk8
          (i32.eqz
            (i32.lt_s (local.get $inl12_k) (local.get $inl11_half))
          )
        )
        (f64.store
          (i32.add
            (local.get $__pe2)
            (local.tee $__pe4
              (i32.shl (local.get $inl12_k) (i32.const 3))
            )
          )
          (local.get $__inl12_x2)
        )
        (f64.store
          (i32.add (local.get $__pe3) (local.get $__pe4))
          (local.get $inl10_ci)
        )
        (local.set $inl14_ni
          (f64.add
            (f64.mul (local.get $__inl12_x2) (local.get $inl6_dt))
            (f64.mul (local.get $inl10_ci) (local.get $__inl13_x))
          )
        )
        (local.set $__inl12_x2
          (f64.sub
            (f64.mul (local.get $__inl12_x2) (local.get $__inl13_x))
            (f64.mul (local.get $inl10_ci) (local.get $inl6_dt))
          )
        )
        (local.set $inl10_ci (local.get $inl14_ni))
        (local.set $inl12_k
          (i32.add (local.get $inl12_k) (i32.const 1))
        )
        (br $loop8)
      )
    )
    (block $brk11
      (loop $loop11
        (br_if $brk11
          (i32.eqz
            (i32.lt_s (local.get $i) (i32.const 5))
          )
        )
        (local.set $inl11_half (i32.const 0))
        (block
          (local.set $__simd_bound1
            (i32.and (local.get $_pg0) (i32.const -2))
          )
          (block $__simd_brk1
            (loop $__simd_loop1
              (br_if $__simd_brk1
                (i32.eqz
                  (i32.lt_s (local.get $inl11_half) (local.get $__simd_bound1))
                )
              )
              (local.set $inl6_dt__v
                (v128.load
                  (i32.add
                    (local.get $__inl14_n)
                    (local.tee $inl12_k
                      (i32.shl (local.get $inl11_half) (i32.const 3))
                    )
                  )
                )
              )
              (v128.store
                (i32.add (local.get $__inl14___pe0) (local.get $inl12_k))
                (local.get $inl6_dt__v)
              )
              (v128.store
                (i32.add (local.get $__inl14_s) (local.get $inl12_k))
                (f64x2.splat (f64.const 0))
              )
              (local.set $inl11_half
                (i32.add (local.get $inl11_half) (i32.const 2))
              )
              (br $__simd_loop1)
            )
          )
          (block $brk12
            (loop $loop12
              (br_if $brk12
                (i32.eqz
                  (i32.lt_s (local.get $inl11_half) (local.get $_pg0))
                )
              )
              (local.set $inl6_dt
                (f64.load
                  (i32.add
                    (local.get $__inl14_n)
                    (local.tee $inl12_k
                      (i32.shl (local.get $inl11_half) (i32.const 3))
                    )
                  )
                )
              )
              (f64.store
                (i32.add (local.get $__inl14___pe0) (local.get $inl12_k))
                (local.get $inl6_dt)
              )
              (f64.store
                (i32.add (local.get $__inl14_s) (local.get $inl12_k))
                (f64.const 0)
              )
              (local.set $inl11_half
                (i32.add (local.get $inl11_half) (i32.const 1))
              )
              (br $loop12)
            )
          )
        )
        (call $fft
          (local.get $__inl14___pe0)
          (local.get $__inl14_s)
          (local.get $__pe2)
          (local.get $__pe3)
          (local.get $_pg0)
        ) drop
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (br $loop11)
      )
    )
    (local.set $inl11_half
      (call $__alloc_hdr_n_d_d_1
        (local.tee $inl11_half
          (i32.shl (local.get $_pg1) (i32.const 3))
        )
        (local.get $inl11_half)
      )
    )
    (block
      (local.set $__iv3_0
        (i32.add
          (local.get $inl11_half)
          (i32.shl (local.get $i5) (i32.const 3))
        )
      )
      (block $brk17
        (loop $loop17
          (br_if $brk17
            (i32.eqz
              (i32.lt_s (local.get $i5) (local.get $_pg1))
            )
          )
          (local.set $inl12_k (i32.const 0))
          (block
            (local.set $__simd_bound2
              (i32.and (local.get $_pg0) (i32.const -2))
            )
            (block $__simd_brk2
              (loop $__simd_loop2
                (br_if $__simd_brk2
                  (i32.eqz
                    (i32.lt_s (local.get $inl12_k) (local.get $__simd_bound2))
                  )
                )
                (local.set $inl6_dt__v
                  (v128.load
                    (i32.add
                      (local.get $__inl14_n)
                      (local.tee $__pe4
                        (i32.shl (local.get $inl12_k) (i32.const 3))
                      )
                    )
                  )
                )
                (v128.store
                  (i32.add (local.get $__inl14___pe0) (local.get $__pe4))
                  (local.get $inl6_dt__v)
                )
                (v128.store
                  (i32.add (local.get $__inl14_s) (local.get $__pe4))
                  (f64x2.splat (f64.const 0))
                )
                (local.set $inl12_k
                  (i32.add (local.get $inl12_k) (i32.const 2))
                )
                (br $__simd_loop2)
              )
            )
            (block $brk18
              (loop $loop18
                (br_if $brk18
                  (i32.eqz
                    (i32.lt_s (local.get $inl12_k) (local.get $_pg0))
                  )
                )
                (local.set $inl6_dt
                  (f64.load
                    (i32.add
                      (local.get $__inl14_n)
                      (local.tee $__pe4
                        (i32.shl (local.get $inl12_k) (i32.const 3))
                      )
                    )
                  )
                )
                (f64.store
                  (i32.add (local.get $__inl14___pe0) (local.get $__pe4))
                  (local.get $inl6_dt)
                )
                (f64.store
                  (i32.add (local.get $__inl14_s) (local.get $__pe4))
                  (f64.const 0)
                )
                (local.set $inl12_k
                  (i32.add (local.get $inl12_k) (i32.const 1))
                )
                (br $loop18)
              )
            )
          )
          (local.set $__inl13_x
            (call $__time_ms (i32.const 1))
          )
          (call $fft
            (local.get $__inl14___pe0)
            (local.get $__inl14_s)
            (local.get $__pe2)
            (local.get $__pe3)
            (local.get $_pg0)
          ) drop
          (local.set $__inl12_x2
            (f64.sub
              (call $__time_ms (i32.const 1))
              (local.get $__inl13_x)
            )
          )
          (f64.store (local.get $__iv3_0) (local.get $__inl12_x2))
          (local.set $i5
            (i32.add (local.get $i5) (i32.const 1))
          )
          (local.set $__iv3_0
            (i32.add (local.get $__iv3_0) (i32.const 8))
          )
          (br $loop17)
        )
      )
    )
    (local.set $__inl14_n (local.get $inl11_half))
    (local.set $__inl14_s (i32.const 1))
    (local.set $__pe2
      (i32.shr_u
        (i32.load
          (i32.sub (local.get $inl11_half) (i32.const 8))
        )
        (i32.const 3)
      )
    )
    (block
      (local.set $__iv4_0
        (i32.add
          (local.get $__inl14_n)
          (i32.shl (local.get $__inl14_s) (i32.const 3))
        )
      )
      (block $__inl9L_brk0
        (loop $__inl9L_loop0
          (br_if $__inl9L_brk0
            (i32.eqz
              (i32.lt_s (local.get $__inl14_s) (local.get $__pe2))
            )
          )
          (local.set $inl6_dt
            (f64.load (local.get $__iv4_0))
          )
          (local.set $__pe3
            (i32.sub (local.get $__inl14_s) (i32.const 1))
          )
          (block $__inl9L_brk2
            (loop $__inl9L_loop2
              (br_if $__inl9L_brk2
                (i32.eqz
                  (i32.and
                    (i32.ge_s (local.get $__pe3) (i32.const 0))
                    (f64.gt
                      (f64.load
                        (local.tee $inl11_half
                          (i32.add
                            (local.get $__inl14_n)
                            (i32.shl (local.get $__pe3) (i32.const 3))
                          )
                        )
                      )
                      (local.get $inl6_dt)
                    )
                  )
                )
              )
              (f64.store offset=8
                (local.get $inl11_half)
                (f64.load (local.get $inl11_half))
              )
              (local.set $__pe3
                (i32.sub (local.get $__pe3) (i32.const 1))
              )
              (br $__inl9L_loop2)
            )
          )
          (f64.store offset=8
            (i32.add
              (local.get $__inl14_n)
              (i32.shl (local.get $__pe3) (i32.const 3))
            )
            (local.get $inl6_dt)
          )
          (local.set $__inl14_s
            (i32.add (local.get $__inl14_s) (i32.const 1))
          )
          (local.set $__iv4_0
            (i32.add (local.get $__iv4_0) (i32.const 8))
          )
          (br $__inl9L_loop0)
        )
      )
    )
    (local.set $__inl14_n
      (select
        (i32.wrap_i64
          (i64.trunc_sat_f64_s
            (local.tee $inl6_dt
              (f64.mul
                (f64.load
                  (i32.add
                    (local.get $__inl14_n)
                    (i32.shl
                      (i32.shr_s
                        (i32.sub
                          (i32.shr_u
                            (i32.load
                              (i32.sub (local.get $__inl14_n) (i32.const 8))
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
        (f64.ne (local.get $inl6_dt) (f64.const Infinity))
      )
    )
    (local.set $__inl14_s (i32.const 0))
    (local.set $inl6_dt
      (call $__mkptr
        (i32.const 2)
        (i32.const 0)
        (local.get $__inl14___pe0)
      )
    )
    (local.set $__pe2
      (call $__ptr_offset
        (i64.reinterpret_f64 (local.get $inl6_dt))
      )
    )
    (local.set $__pe3
      (call $__alloc (i32.const 16))
    )
    (i32.store
      (local.get $__pe3)
      (i32.shl
        (i32.trunc_sat_f64_s
          (f64.mul
            (f64.convert_i32_s
              (i32.shr_u
                (i32.load
                  (i32.sub (local.get $__inl14___pe0) (i32.const 8))
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
      (local.get $__pe3)
      (i32.add
        (local.get $__pe2)
        (i32.trunc_sat_f64_s (f64.const 0))
      )
    )
    (i32.store offset=8
      (local.get $__pe3)
      (local.get $__pe2)
    )
    (local.set $__inl14___pe0 (local.get $__pe3))
    (local.set $__pe2 (i32.const -2128831035))
    (local.set $__pe3
      (i32.shr_u
        (i32.load (local.get $__pe3))
        (i32.const 2)
      )
    )
    (block $__inl10L_brk4
      (loop $__inl10L_loop4
        (br_if $__inl10L_brk4
          (i32.eqz
            (i32.lt_s (local.get $__inl14_s) (local.get $__pe3))
          )
        )
        (local.set $__pe2
          (i32.mul
            (i32.xor
              (local.get $__pe2)
              (i32.load
                (i32.add
                  (i32.load offset=4 (local.get $__inl14___pe0))
                  (i32.shl (local.get $__inl14_s) (i32.const 2))
                )
              )
            )
            (i32.const 16777619)
          )
        )
        (local.set $__inl14_s
          (i32.add (local.get $__inl14_s) (i32.const 256))
        )
        (br $__inl10L_loop4)
      )
    )
    (local.set $__inl14___pe0 (local.get $__pe2))
    (local.set $_pg0
      (i32.shr_s
        (select
          (i32.wrap_i64
            (i64.trunc_sat_f64_s
              (local.tee $inl6_dt
                (f64.mul
                  (f64.convert_i32_s (local.get $_pg0))
                  (f64.const 16)
                )
              )
            )
          )
          (i32.const 0)
          (f64.ne (local.get $inl6_dt) (f64.const Infinity))
        )
        (i32.const 1)
      )
    )
    (local.set $_pg1 (i32.const 0))
    (local.set $__inl14_s (i32.const 0))
    (local.set $__pe2 (i32.const 0))
    (local.set $__pe3 (i32.const 0))
    (local.set $inl11_half (i32.const 0))
    (local.set $inl12_k (i32.const 1))
    (local.set $__inl11___inl2_ptr
      (i64.reinterpret_f64
        (block
          (result f64)
          (local.set $inl6_dt
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa000100000044))
            )
          )
          (local.set $__pe4
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $inl6_dt))
            )
          )
          (local.set $__inl13_x
            (call $__i32_to_str (local.get $__inl14_n))
          )
          (local.set $__inl14_n
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl13_x))
            )
          )
          (local.set $__inl12_x2
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa000100000058))
            )
          )
          (local.set $i
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl12_x2))
            )
          )
          (local.set $inl10_ci
            (call $__i32_to_str (local.get $__inl14___pe0))
          )
          (local.set $__inl14___pe0
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $inl10_ci))
            )
          )
          (local.set $inl14_ni
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa00010000006c))
            )
          )
          (local.set $i5
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $inl14_ni))
            )
          )
          (local.set $__inl11_s5
            (call $__i32_to_str (local.get $_pg0))
          )
          (local.set $_pg0
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl11_s5))
            )
          )
          (local.set $__inl11_s6
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa000100000080))
            )
          )
          (local.set $__inl11_sl17
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl11_s6))
            )
          )
          (local.set $__inl11_s7
            (call $__i32_to_str (i32.const 16))
          )
          (local.set $__inl11_sl18
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl11_s7))
            )
          )
          (local.set $__inl11_s8
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa000100000090))
            )
          )
          (local.set $__inl11_sl19
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl11_s8))
            )
          )
          (local.set $__inl11_s9
            (call $__i32_to_str (i32.const 21))
          )
          (local.set $__inl11_sl20
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl11_s9))
            )
          )
          (local.set $__inl11_s10
            (f64.reinterpret_i64
              (call $__to_str (i64.const 0x7ffa400000000000))
            )
          )
          (local.set $__inl11_sl21
            (call $__str_byteLen
              (i64.reinterpret_f64 (local.get $__inl11_s10))
            )
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__pe4) (local.get $__inl14_n))
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__inl11_st22) (local.get $i))
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__inl11_st22) (local.get $__inl14___pe0))
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__inl11_st22) (local.get $i5))
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__inl11_st22) (local.get $_pg0))
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__inl11_st22) (local.get $__inl11_sl17))
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__inl11_st22) (local.get $__inl11_sl18))
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__inl11_st22) (local.get $__inl11_sl19))
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__inl11_st22) (local.get $__inl11_sl20))
          )
          (local.set $__inl11_st22
            (i32.add (local.get $__inl11_st22) (local.get $__inl11_sl21))
          )
          (if
            (result f64)
            (i32.eqz (local.get $__inl11_st22))
            (then (f64.const nan:0x7FFA400000000000))
            (else
              (local.set $_pg1
                (call $__alloc
                  (i32.add (i32.const 4) (local.get $__inl11_st22))
                )
              )
              (i32.store (local.get $_pg1) (local.get $__inl11_st22))
              (local.set $_pg1
                (i32.add (local.get $_pg1) (i32.const 4))
              )
              (local.set $__inl14_s (local.get $_pg1))
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $inl6_dt))
                (local.get $_pg1)
                (local.get $__pe4)
              )
              (local.set $__inl14_s
                (i32.add (local.get $_pg1) (local.get $__pe4))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl13_x))
                (local.get $__inl14_s)
                (local.get $__inl14_n)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $__inl14_n))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl12_x2))
                (local.get $__inl14_s)
                (local.get $i)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $i))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $inl10_ci))
                (local.get $__inl14_s)
                (local.get $__inl14___pe0)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $__inl14___pe0))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $inl14_ni))
                (local.get $__inl14_s)
                (local.get $i5)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $i5))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl11_s5))
                (local.get $__inl14_s)
                (local.get $_pg0)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $_pg0))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl11_s6))
                (local.get $__inl14_s)
                (local.get $__inl11_sl17)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $__inl11_sl17))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl11_s7))
                (local.get $__inl14_s)
                (local.get $__inl11_sl18)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $__inl11_sl18))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl11_s8))
                (local.get $__inl14_s)
                (local.get $__inl11_sl19)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $__inl11_sl19))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl11_s9))
                (local.get $__inl14_s)
                (local.get $__inl11_sl20)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $__inl11_sl20))
              )
              (call $__str_copy
                (i64.reinterpret_f64 (local.get $__inl11_s10))
                (local.get $__inl14_s)
                (local.get $__inl11_sl21)
              )
              (local.set $__inl14_s
                (i32.add (local.get $__inl14_s) (local.get $__inl11_sl21))
              )
              (call $__mkptr
                (i32.const 4)
                (i32.const 0)
                (local.get $_pg1)
              )
            )
          )
        )
      )
    )
    (local.set $_pg0 (i32.const 0))
    (local.set $_pg1 (i32.const 0))
    (local.set $__inl14_n (i32.const 0))
    (local.set $__inl14___pe0
      (call $__alloc (i32.const 12))
    )
    (local.set $__inl14_s
      (i32.and
        (i32.wrap_i64
          (i64.shr_u (local.get $__inl11___inl2_ptr) (i64.const 32))
        )
        (i32.const 32767)
      )
    )
    (if
      (i32.and (local.get $__inl14_s) (i32.const 16384))
      (then
        (local.set $_pg0
          (i32.and (local.get $__inl14_s) (i32.const 7))
        )
        (local.set $__inl14_n
          (call $__alloc (local.get $_pg0))
        )
        (local.set $_pg1 (i32.const 0))
        (block $__inl11L___inl2L_done
          (loop $__inl11L___inl2L_loop
            (br_if $__inl11L___inl2L_done
              (i32.ge_s (local.get $_pg1) (local.get $_pg0))
            )
            (i32.store8
              (i32.add (local.get $__inl14_n) (local.get $_pg1))
              (block $__inl11L___inl5
                (result i32)
                (local.set $inl11_half (local.get $_pg1))
                (i32.and
                  (i32.shr_u
                    (i32.wrap_i64
                      (i64.and (local.get $__inl11___inl2_ptr) (i64.const 4294967295))
                    )
                    (i32.shl (local.get $_pg1) (i32.const 3))
                  )
                  (i32.const 0xFF)
                )
              )
            )
            (local.set $_pg1
              (i32.add (local.get $_pg1) (i32.const 1))
            )
            (br $__inl11L___inl2L_loop)
          )
        )
        (i32.store (local.get $__inl14___pe0) (local.get $__inl14_n))
        (i32.store offset=4
          (local.get $__inl14___pe0)
          (local.get $_pg0)
        )
      )
      (else
        (i32.store
          (local.get $__inl14___pe0)
          (call $__ptr_offset (local.get $__inl11___inl2_ptr))
        )
        (i32.store offset=4
          (local.get $__inl14___pe0)
          (block $__inl11L___inl4
            (result i32)
            (local.set $__inl11___inl4_ptr (local.get $__inl11___inl2_ptr))
            (if
              (i32.ne
                (i32.and
                  (i32.wrap_i64
                    (i64.shr_u (local.get $__inl11___inl4_ptr) (i64.const 47))
                  )
                  (i32.const 15)
                )
                (i32.const 4)
              )
              (then
                (br $__inl11L___inl4 (i32.const 0))
              )
            )
            (local.set $__pe3
              (i32.and
                (i32.wrap_i64
                  (i64.shr_u (local.get $__inl11___inl4_ptr) (i64.const 32))
                )
                (i32.const 32767)
              )
            )
            (if
              (i32.and (local.get $__pe3) (i32.const 16384))
              (then
                (br $__inl11L___inl4
                  (i32.and (local.get $__pe3) (i32.const 7))
                )
              )
            )
            (local.set $__pe2
              (call $__ptr_offset (local.get $__inl11___inl4_ptr))
            )
            (if
              (result i32)
              (i32.ge_u (local.get $__pe2) (i32.const 4))
              (then
                (i32.load
                  (i32.sub (local.get $__pe2) (i32.const 4))
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
        (local.get $inl12_k)
        (local.get $__inl14___pe0)
        (i32.const 1)
        (i32.add (local.get $__inl14___pe0) (i32.const 8))
      )
    )
    (local.set $_pg0 (i32.const 1))
    (local.set $_pg1 (i32.const 10))
    (local.set $__inl14_n
      (call $__alloc (i32.const 13))
    )
    (i32.store8
      (local.tee $__inl14___pe0
        (i32.add (local.get $__inl14_n) (i32.const 12))
      )
      (i32.const 10)
    )
    (i32.store (local.get $__inl14_n) (local.get $__inl14___pe0))
    (i32.store offset=4
      (local.get $__inl14_n)
      (i32.const 1)
    )
    (drop
      (call $__fd_write
        (i32.const 1)
        (local.get $__inl14_n)
        (i32.const 1)
        (i32.add (local.get $__inl14_n) (i32.const 8))
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