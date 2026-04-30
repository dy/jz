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
    "NaNInfinity-Infinitytruefalsenullundefined[Array][Object]\00\00\00\0a\00\00\00median_us=\00\00\0a\00\00\00 checksum=\00\00\09\00\00\00 samples=\00\00\00\08\00\00\00 stages=\06\00\00\00 runs="
  )
  (global $__heap
    (mut i32)
    (i32.const 1024)
  )
  (global $__dyn_props
    (mut f64)
    (f64.const 0)
  )
  (func $__char_at
    (param $ptr f64)
    (param $i i32)
    (result i32)
    (local $bits i64)
    (local $off i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $ptr))
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
      )
    )
    (if
      (result i32)
      (i32.eq
        (i32.wrap_i64
          (i64.and
            (i64.shr_u (local.get $bits) (i64.const 47))
            (i64.const 0xF)
          )
        )
        (i32.const 5)
      )
      (then
        (i32.and
          (i32.shr_u
            (local.get $off)
            (i32.shl (local.get $i) (i32.const 3))
          )
          (i32.const 0xFF)
        )
      )
      (else
        (i32.load8_u
          (i32.add (local.get $off) (local.get $i))
        )
      )
    )
  )
  (func $__ptr_offset
    (param $ptr f64)
    (result i32)
    (local $bits i64)
    (local $off i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $ptr))
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
      )
    )
    ;; Arrays can be reallocated during growth; follow forwarding pointer (cap=-1 sentinel).
    ;; Bounds are checked inside the loop so non-array ptrs skip them entirely, and well-formed
    ;; ARRAY ptrs without forwarding still pay only one bounds check before the cap load.
    (if
      (i32.eq
        (i32.wrap_i64
          (i64.and
            (i64.shr_u (local.get $bits) (i64.const 47))
            (i64.const 0xF)
          )
        )
        (i32.const 1)
      )
      (then
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
      )
    )
    (local.get $off)
  )
  (func $__str_concat
    (param $a f64)
    (param $b f64)
    (result f64)
    (local $alen i32)
    (local $blen i32)
    (local $total i32)
    (local $off i32)
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
          (f64.reinterpret_i64 (i64.const 9221823924482867200))
        )
      )
    )
    (local.set $off
      (call $__alloc
        (i32.add (i32.const 4) (local.get $total))
      )
    )
    (i32.store (local.get $off) (local.get $total))
    (local.set $off
      (i32.add (local.get $off) (i32.const 4))
    )
    (call $__str_copy
      (local.get $a)
      (local.get $off)
      (local.get $alen)
    )
    (call $__str_copy
      (local.get $b)
      (i32.add (local.get $off) (local.get $alen))
      (local.get $blen)
    )
    (f64.reinterpret_i64
      (i64.or
        (i64.const 9221120237041090560)
        (i64.or
          (i64.const 562949953421312)
          (i64.and
            (i64.extend_i32_u (local.get $off))
            (i64.const 0xFFFFFFFF)
          )
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
    ;; Align next allocation to 8 bytes
    (local.set $next
      (i32.and
        (i32.add
          (i32.add (local.get $ptr) (local.get $bytes))
          (i32.const 7)
        )
        (i32.const -8)
      )
    )
    ;; Grow memory if needed (each page = 65536 bytes)
    (if
      (i32.gt_u
        (local.get $next)
        (i32.shl (memory.size) (i32.const 16))
      )
      (then
        (if
          (i32.eq
            (memory.grow
              (i32.shr_u
                (i32.add
                  (i32.sub
                    (local.get $next)
                    (i32.shl (memory.size) (i32.const 16))
                  )
                  (i32.const 65535)
                )
                (i32.const 16)
              )
            )
            (i32.const -1)
          )
          (then (unreachable))
        )
      )
    )
    (global.set $__heap (local.get $next))
    (local.get $ptr)
  )
  (func $__len
    (param $ptr f64)
    (result i32)
    (local $bits i64)
    (local $t i32)
    (local $off i32)
    (local $aux i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $ptr))
    )
    (local.set $t
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $bits) (i64.const 47))
          (i64.const 0xF)
        )
      )
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
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
        (block $done
          (loop $follow
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
                      (i64.const 0x7FFF)
                    )
                  )
                )
                (if
                  (result i32)
                  (i32.and (local.get $aux) (i32.const 8))
                  (then
                    (i32.shr_u
                      (i32.load (local.get $off))
                      (if
                        (result i32)
                        (i32.eq
                          (i32.and (local.get $aux) (i32.const 7))
                          (i32.const 7)
                        )
                        (then (i32.const 3))
                        (else
                          (if
                            (result i32)
                            (i32.ge_u
                              (i32.and (local.get $aux) (i32.const 7))
                              (i32.const 4)
                            )
                            (then (i32.const 2))
                            (else
                              (i32.shr_u
                                (i32.and (local.get $aux) (i32.const 7))
                                (i32.const 1)
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                  (else
                    (i32.shr_u
                      (i32.load
                        (i32.sub (local.get $off) (i32.const 8))
                      )
                      (if
                        (result i32)
                        (i32.eq (local.get $aux) (i32.const 7))
                        (then (i32.const 3))
                        (else
                          (if
                            (result i32)
                            (i32.ge_u (local.get $aux) (i32.const 4))
                            (then (i32.const 2))
                            (else
                              (i32.shr_u (local.get $aux) (i32.const 1))
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
              (else
                (i32.load
                  (i32.sub (local.get $off) (i32.const 8))
                )
              )
            )
          )
          (else (i32.const 0))
        )
      )
    )
  )
  (func $__alloc_hdr
    (param $len i32)
    (param $cap i32)
    (param $stride i32)
    (result i32)
    (local $ptr i32)
    (local.set $ptr
      (call $__alloc
        (i32.add
          (i32.const 8)
          (i32.mul (local.get $cap) (local.get $stride))
        )
      )
    )
    (i32.store (local.get $ptr) (local.get $len))
    (i32.store offset=4
      (local.get $ptr)
      (local.get $cap)
    )
    (i32.add (local.get $ptr) (i32.const 8))
  )
  (func $__static_str
    (param $id i32)
    (result f64)
    (local $src i32)
    (local $len i32)
    (local.set $src (i32.const 0))
    (local.set $len (i32.const 0))
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
  (func $__to_num
    (param $v f64)
    (result f64)
    (local $t i32)
    (local $len i32)
    (local $i i32)
    (local $c i32)
    (local $neg i32)
    (local $seen i32)
    (local $exp i32)
    (local $expNeg i32)
    (local $result f64)
    (local $scale f64)
    (if
      (f64.eq (local.get $v) (local.get $v))
      (then
        (return (local.get $v))
      )
    )
    (if
      (i64.eq
        (i64.reinterpret_f64 (local.get $v))
        (i64.const 0x7FF8000100000000)
      )
      (then
        (return (f64.const 0))
      )
    )
    (if
      (i64.eq
        (i64.reinterpret_f64 (local.get $v))
        (i64.const 0x7FF8000000000001)
      )
      (then
        (return (f64.const nan))
      )
    )
    (local.set $t
      (i32.and
        (i32.wrap_i64
          (i64.shr_u
            (i64.reinterpret_f64 (local.get $v))
            (i64.const 47)
          )
        )
        (i32.const 15)
      )
    )
    (if
      (i32.eqz
        (i32.or
          (i32.eq (local.get $t) (i32.const 4))
          (i32.eq (local.get $t) (i32.const 5))
        )
      )
      (then
        (return (f64.const nan))
      )
    )
    (local.set $len
      (call $__str_byteLen (local.get $v))
    )
    ;; Skip leading whitespace.
    (block $ws
      (loop $wsl
        (br_if $ws
          (i32.ge_s (local.get $i) (local.get $len))
        )
        (br_if $ws
          (i32.gt_s
            (call $__char_at
              (local.get $v)
              (local.get $i)
            )
            (i32.const 32)
          )
        )
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (br $wsl)
      )
    )
    ;; Sign.
    (if
      (i32.and
        (i32.lt_s (local.get $i) (local.get $len))
        (i32.eq
          (call $__char_at
            (local.get $v)
            (local.get $i)
          )
          (i32.const 45)
        )
      )
      (then
        (local.set $neg (i32.const 1))
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
      )
    )
    (if
      (i32.and
        (i32.lt_s (local.get $i) (local.get $len))
        (i32.eq
          (call $__char_at
            (local.get $v)
            (local.get $i)
          )
          (i32.const 43)
        )
      )
      (then
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
      )
    )
    ;; 0x prefix → hex parse and early return
    (if
      (i32.and
        (i32.le_s
          (i32.add (local.get $i) (i32.const 1))
          (local.get $len)
        )
        (i32.and
          (i32.eq
            (call $__char_at
              (local.get $v)
              (local.get $i)
            )
            (i32.const 48)
          )
          (i32.or
            (i32.eq
              (call $__char_at
                (local.get $v)
                (i32.add (local.get $i) (i32.const 1))
              )
              (i32.const 120)
            )
            (i32.eq
              (call $__char_at
                (local.get $v)
                (i32.add (local.get $i) (i32.const 1))
              )
              (i32.const 88)
            )
          )
        )
      )
      (then
        (local.set $i
          (i32.add (local.get $i) (i32.const 2))
        )
        (block $hexDone
          (loop $hexLoop
            (br_if $hexDone
              (i32.ge_s (local.get $i) (local.get $len))
            )
            (local.set $c
              (call $__char_at
                (local.get $v)
                (local.get $i)
              )
            )
            (if
              (i32.and
                (i32.ge_s (local.get $c) (i32.const 48))
                (i32.le_s (local.get $c) (i32.const 57))
              )
              (then
                (local.set $result
                  (f64.add
                    (f64.mul (local.get $result) (f64.const 16))
                    (f64.convert_i32_s
                      (i32.sub (local.get $c) (i32.const 48))
                    )
                  )
                )
                (local.set $seen (i32.const 1))
                (local.set $i
                  (i32.add (local.get $i) (i32.const 1))
                )
                (br $hexLoop)
              )
            )
            (if
              (i32.and
                (i32.ge_s (local.get $c) (i32.const 97))
                (i32.le_s (local.get $c) (i32.const 102))
              )
              (then
                (local.set $result
                  (f64.add
                    (f64.mul (local.get $result) (f64.const 16))
                    (f64.convert_i32_s
                      (i32.sub (local.get $c) (i32.const 87))
                    )
                  )
                )
                (local.set $seen (i32.const 1))
                (local.set $i
                  (i32.add (local.get $i) (i32.const 1))
                )
                (br $hexLoop)
              )
            )
            (if
              (i32.and
                (i32.ge_s (local.get $c) (i32.const 65))
                (i32.le_s (local.get $c) (i32.const 70))
              )
              (then
                (local.set $result
                  (f64.add
                    (f64.mul (local.get $result) (f64.const 16))
                    (f64.convert_i32_s
                      (i32.sub (local.get $c) (i32.const 55))
                    )
                  )
                )
                (local.set $seen (i32.const 1))
                (local.set $i
                  (i32.add (local.get $i) (i32.const 1))
                )
                (br $hexLoop)
              )
            )
          )
        )
        (return
          (if
            (result f64)
            (local.get $neg)
            (then
              (f64.neg (local.get $result))
            )
            (else (local.get $result))
          )
        )
      )
    )
    ;; Integer part.
    (block $intDone
      (loop $intLoop
        (br_if $intDone
          (i32.ge_s (local.get $i) (local.get $len))
        )
        (local.set $c
          (call $__char_at
            (local.get $v)
            (local.get $i)
          )
        )
        (br_if $intDone
          (i32.or
            (i32.lt_s (local.get $c) (i32.const 48))
            (i32.gt_s (local.get $c) (i32.const 57))
          )
        )
        (local.set $result
          (f64.add
            (f64.mul (local.get $result) (f64.const 10))
            (f64.convert_i32_s
              (i32.sub (local.get $c) (i32.const 48))
            )
          )
        )
        (local.set $seen (i32.const 1))
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (br $intLoop)
      )
    )
    ;; Fractional part.
    (if
      (i32.and
        (i32.lt_s (local.get $i) (local.get $len))
        (i32.eq
          (call $__char_at
            (local.get $v)
            (local.get $i)
          )
          (i32.const 46)
        )
      )
      (then
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (local.set $scale (f64.const 0.1))
        (block $fracDone
          (loop $fracLoop
            (br_if $fracDone
              (i32.ge_s (local.get $i) (local.get $len))
            )
            (local.set $c
              (call $__char_at
                (local.get $v)
                (local.get $i)
              )
            )
            (br_if $fracDone
              (i32.or
                (i32.lt_s (local.get $c) (i32.const 48))
                (i32.gt_s (local.get $c) (i32.const 57))
              )
            )
            (local.set $result
              (f64.add
                (local.get $result)
                (f64.mul
                  (f64.convert_i32_s
                    (i32.sub (local.get $c) (i32.const 48))
                  )
                  (local.get $scale)
                )
              )
            )
            (local.set $scale
              (f64.mul (local.get $scale) (f64.const 0.1))
            )
            (local.set $seen (i32.const 1))
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $fracLoop)
          )
        )
      )
    )
    (if
      (i32.eqz (local.get $seen))
      (then
        (return (f64.const nan))
      )
    )
    ;; Scientific notation.
    (if
      (i32.and
        (i32.lt_s (local.get $i) (local.get $len))
        (i32.or
          (i32.eq
            (call $__char_at
              (local.get $v)
              (local.get $i)
            )
            (i32.const 101)
          )
          (i32.eq
            (call $__char_at
              (local.get $v)
              (local.get $i)
            )
            (i32.const 69)
          )
        )
      )
      (then
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (if
          (i32.and
            (i32.lt_s (local.get $i) (local.get $len))
            (i32.eq
              (call $__char_at
                (local.get $v)
                (local.get $i)
              )
              (i32.const 45)
            )
          )
          (then
            (local.set $expNeg (i32.const 1))
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
          )
        )
        (if
          (i32.and
            (i32.lt_s (local.get $i) (local.get $len))
            (i32.eq
              (call $__char_at
                (local.get $v)
                (local.get $i)
              )
              (i32.const 43)
            )
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
              (i32.ge_s (local.get $i) (local.get $len))
            )
            (local.set $c
              (call $__char_at
                (local.get $v)
                (local.get $i)
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
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $expLoop)
          )
        )
        (if
          (local.get $expNeg)
          (then
            (local.set $result
              (f64.div
                (local.get $result)
                (call $__pow10 (local.get $exp))
              )
            )
          )
          (else
            (local.set $result
              (f64.mul
                (local.get $result)
                (call $__pow10 (local.get $exp))
              )
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
  (func $__pow10
    (param $n i32)
    (result f64)
    (local $r f64)
    (local.set $r (f64.const 1))
    (block $d
      (loop $l
        (br_if $d
          (i32.le_s (local.get $n) (i32.const 0))
        )
        (local.set $r
          (f64.mul (local.get $r) (f64.const 10))
        )
        (local.set $n
          (i32.sub (local.get $n) (i32.const 1))
        )
        (br $l)
      )
    )
    (local.get $r)
  )
  (func $__length
    (param $v f64)
    (result f64)
    (local $t i32)
    (local $off i32)
    (if
      (result f64)
      (f64.eq (local.get $v) (local.get $v))
      (then (f64.const nan:0x7FF8000000000001))
      (else
        (local.set $t
          (i32.and
            (i32.wrap_i64
              (i64.shr_u
                (i64.reinterpret_f64 (local.get $v))
                (i64.const 47)
              )
            )
            (i32.const 15)
          )
        )
        (local.set $off
          (call $__ptr_offset (local.get $v))
        )
        (if
          (result f64)
          (i32.eq (local.get $t) (i32.const 5))
          (then
            (f64.convert_i32_s
              (i32.and
                (i32.wrap_i64
                  (i64.shr_u
                    (i64.reinterpret_f64 (local.get $v))
                    (i64.const 32)
                  )
                )
                (i32.const 32767)
              )
            )
          )
          (else
            (if
              (result f64)
              (i32.eq (local.get $t) (i32.const 4))
              (then
                (if
                  (result f64)
                  (i32.ge_u (local.get $off) (i32.const 4))
                  (then
                    (f64.convert_i32_s
                      (call $__str_len (local.get $v))
                    )
                  )
                  (else (f64.const nan:0x7FF8000000000001))
                )
              )
              (else
                (if
                  (result f64)
                  (i32.or
                    (i32.or
                      (i32.or
                        (i32.eq (local.get $t) (i32.const 1))
                        (i32.eq (local.get $t) (i32.const 3))
                      )
                      (i32.eq (local.get $t) (i32.const 8))
                    )
                    (i32.eq (local.get $t) (i32.const 9))
                  )
                  (then
                    (if
                      (result f64)
                      (i32.ge_u (local.get $off) (i32.const 8))
                      (then
                        (f64.convert_i32_s
                          (call $__len (local.get $v))
                        )
                      )
                      (else (f64.const nan:0x7FF8000000000001))
                    )
                  )
                  (else (f64.const nan:0x7FF8000000000001))
                )
              )
            )
          )
        )
      )
    )
  )
  (func $__str_byteLen
    (param $ptr f64)
    (result i32)
    (local $bits i64)
    (local $t i32)
    (local $off i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $ptr))
    )
    (local.set $t
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $bits) (i64.const 47))
          (i64.const 0xF)
        )
      )
    )
    (if
      (result i32)
      (i32.eq (local.get $t) (i32.const 5))
      (then
        (i32.wrap_i64
          (i64.and
            (i64.shr_u (local.get $bits) (i64.const 32))
            (i64.const 0x7FFF)
          )
        )
      )
      (else
        (local.set $off
          (i32.wrap_i64
            (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
          )
        )
        (if
          (result i32)
          (i32.and
            (i32.eq (local.get $t) (i32.const 4))
            (i32.ge_u (local.get $off) (i32.const 4))
          )
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
  (func $__write_str
    (param $fd i32)
    (param $ptr f64)
    (local $iov i32)
    (local $type i32)
    (local $len i32)
    (local $off i32)
    (local $buf i32)
    ;; Allocate iov (8 bytes: ptr + len) + nwritten (4 bytes)
    (local.set $iov
      (call $__alloc (i32.const 12))
    )
    (local.set $type
      (i32.and
        (i32.wrap_i64
          (i64.shr_u
            (i64.reinterpret_f64 (local.get $ptr))
            (i64.const 47)
          )
        )
        (i32.const 15)
      )
    )
    (if
      (i32.eq (local.get $type) (i32.const 5))
      (then
        ;; SSO: unpack chars to memory buffer, then write
        (local.set $len
          (i32.and
            (i32.wrap_i64
              (i64.shr_u
                (i64.reinterpret_f64 (local.get $ptr))
                (i64.const 32)
              )
            )
            (i32.const 32767)
          )
        )
        (local.set $buf
          (call $__alloc (local.get $len))
        )
        (local.set $off (i32.const 0))
        (block $done
          (loop $loop
            (br_if $done
              (i32.ge_s (local.get $off) (local.get $len))
            )
            (i32.store8
              (i32.add (local.get $buf) (local.get $off))
              (i32.and
                (i32.shr_u
                  (i32.wrap_i64
                    (i64.and
                      (i64.reinterpret_f64 (local.get $ptr))
                      (i64.const 0xFFFFFFFF)
                    )
                  )
                  (i32.shl (local.get $off) (i32.const 3))
                )
                (i32.const 0xFF)
              )
            )
            (local.set $off
              (i32.add (local.get $off) (i32.const 1))
            )
            (br $loop)
          )
        )
        (i32.store (local.get $iov) (local.get $buf))
        (i32.store offset=4
          (local.get $iov)
          (local.get $len)
        )
      )
      (else
        ;; Heap string: offset points directly to char data
        (i32.store
          (local.get $iov)
          (call $__ptr_offset (local.get $ptr))
        )
        (i32.store offset=4
          (local.get $iov)
          (call $__str_len (local.get $ptr))
        )
      )
    )
    (drop
      (call $__fd_write
        (local.get $fd)
        (local.get $iov)
        (i32.const 1)
        (i32.add (local.get $iov) (i32.const 8))
      )
    )
  )
  (func $__mkstr
    (param $buf i32)
    (param $len i32)
    (result f64)
    (local $off i32)
    (local.set $off
      (call $__alloc
        (i32.add (i32.const 4) (local.get $len))
      )
    )
    (i32.store (local.get $off) (local.get $len))
    (local.set $off
      (i32.add (local.get $off) (i32.const 4))
    )
    (memory.copy
      (local.get $off)
      (local.get $buf)
      (local.get $len)
    )
    (f64.reinterpret_i64
      (i64.or
        (i64.const 9221120237041090560)
        (i64.or
          (i64.const 562949953421312)
          (i64.and
            (i64.extend_i32_u (local.get $off))
            (i64.const 0xFFFFFFFF)
          )
        )
      )
    )
  )
  (func $____lib_benchlib_js$mix
    (export "____lib_benchlib_js$mix")
    (param $h f64)
    (param $x f64)
    (result f64)
    (f64.convert_i32_s
      (i32.mul
        (i32.xor
          (i32.wrap_i64
            (i64.trunc_sat_f64_s (local.get $h))
          )
          (i32.wrap_i64
            (i64.trunc_sat_f64_s (local.get $x))
          )
        )
        (i32.const 16777619)
      )
    )
  )
  (func $__typed_idx
    (param $ptr f64)
    (param $i i32)
    (result f64)
    (local $bits i64)
    (local $t i32)
    (local $off i32)
    (local $et i32)
    (local $len i32)
    (local $aux i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $ptr))
    )
    (local.set $t
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $bits) (i64.const 47))
          (i64.const 0xF)
        )
      )
    )
    (local.set $aux
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $bits) (i64.const 32))
          (i64.const 0x7FFF)
        )
      )
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
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
      (then (f64.const nan:0x7FF8000000000001))
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
                    (f64.load
                      (i32.add
                        (local.get $off)
                        (i32.shl (local.get $i) (i32.const 3))
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
  (func $__is_str_key
    (param $v f64)
    (result i32)
    (local $t i32)
    (if
      (result i32)
      (f64.eq (local.get $v) (local.get $v))
      (then (i32.const 0))
      (else
        (local.set $t
          (i32.and
            (i32.wrap_i64
              (i64.shr_u
                (i64.reinterpret_f64 (local.get $v))
                (i64.const 47)
              )
            )
            (i32.const 15)
          )
        )
        (i32.or
          (i32.eq (local.get $t) (i32.const 4))
          (i32.eq (local.get $t) (i32.const 5))
        )
      )
    )
  )
  (func $__dyn_get
    (param $obj f64)
    (param $key f64)
    (result f64)
    (local $props f64)
    (local $bits i64)
    (local $off i32)
    (local $poff i32)
    (local $pcap i32)
    (local $h i32)
    (local $idx i32)
    (local $slot i32)
    (local $tries i32)
    (local $type i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $obj))
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
      )
    )
    (local.set $type
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $bits) (i64.const 47))
          (i64.const 0xF)
        )
      )
    )
    (if
      (i32.eq (local.get $type) (i32.const 1))
      (then
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
      )
    )
    (block $dynDone
      (br_if $dynDone
        (f64.eq (global.get $__dyn_props) (f64.const 0))
      )
      (local.set $props
        (call $__ihash_get_local
          (global.get $__dyn_props)
          (f64.convert_i32_s (local.get $off))
        )
      )
      (br_if $dynDone
        (i32.or
          (i64.eq
            (i64.reinterpret_f64 (local.get $props))
            (i64.const 0x7FF8000100000000)
          )
          (i64.eq
            (i64.reinterpret_f64 (local.get $props))
            (i64.const 0x7FF8000000000001)
          )
        )
      )
      (local.set $bits
        (i64.reinterpret_f64 (local.get $props))
      )
      (local.set $poff
        (i32.wrap_i64
          (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
        )
      )
      (local.set $pcap
        (i32.load
          (i32.sub (local.get $poff) (i32.const 4))
        )
      )
      (local.set $h
        (call $__str_hash (local.get $key))
      )
      (local.set $idx
        (i32.and
          (local.get $h)
          (i32.sub (local.get $pcap) (i32.const 1))
        )
      )
      (block $hdone
        (loop $hprobe
          (local.set $slot
            (i32.add
              (local.get $poff)
              (i32.mul (local.get $idx) (i32.const 24))
            )
          )
          (br_if $dynDone
            (f64.eq
              (f64.load (local.get $slot))
              (f64.const 0)
            )
          )
          (if
            (call $__str_eq
              (f64.load offset=8 (local.get $slot))
              (local.get $key)
            )
            (then
              (return
                (f64.load offset=16 (local.get $slot))
              )
            )
          )
          (local.set $idx
            (i32.and
              (i32.add (local.get $idx) (i32.const 1))
              (i32.sub (local.get $pcap) (i32.const 1))
            )
          )
          (local.set $tries
            (i32.add (local.get $tries) (i32.const 1))
          )
          (br_if $hdone
            (i32.ge_s (local.get $tries) (local.get $pcap))
          )
          (br $hprobe)
        )
      )
    )
    (f64.const nan:0x7FF8000000000001)
  )
  (func $__str_idx
    (param $ptr f64)
    (param $i i32)
    (result f64)
    (local $len i32)
    (local.set $len
      (call $__str_byteLen (local.get $ptr))
    )
    (if
      (result f64)
      (i32.or
        (i32.lt_s (local.get $i) (i32.const 0))
        (i32.ge_u (local.get $i) (local.get $len))
      )
      (then (f64.const nan:0x7FF8000000000001))
      (else
        (f64.reinterpret_i64
          (i64.or
            (i64.const 9221120237041090560)
            (i64.or
              (i64.const 703687441776640)
              (i64.or
                (i64.const 4294967296)
                (i64.and
                  (i64.extend_i32_u
                    (call $__char_at
                      (local.get $ptr)
                      (local.get $i)
                    )
                  )
                  (i64.const 0xFFFFFFFF)
                )
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
  (func $__ihash_get_local
    (param $coll f64)
    (param $key f64)
    (result f64)
    (local $bits i64)
    (local $off i32)
    (local $cap i32)
    (local $idx i32)
    (local $slot i32)
    (local $tries i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $coll))
    )
    (if
      (i32.ne
        (i32.wrap_i64
          (i64.and
            (i64.shr_u (local.get $bits) (i64.const 47))
            (i64.const 0xF)
          )
        )
        (i32.const 7)
      )
      (then
        (return (f64.const nan:0x7FF8000000000001))
      )
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
      )
    )
    (local.set $cap
      (i32.load
        (i32.sub (local.get $off) (i32.const 4))
      )
    )
    (local.set $idx
      (i32.and
        (i32.wrap_i64
          (i64.xor
            (i64.reinterpret_f64 (local.get $key))
            (i64.shr_u
              (i64.reinterpret_f64 (local.get $key))
              (i64.const 32)
            )
          )
        )
        (i32.sub (local.get $cap) (i32.const 1))
      )
    )
    (block $done
      (loop $probe
        (local.set $slot
          (i32.add
            (local.get $off)
            (i32.mul (local.get $idx) (i32.const 24))
          )
        )
        (if
          (f64.eq
            (f64.load (local.get $slot))
            (f64.const 0)
          )
          (then
            (return (f64.const nan:0x7FF8000000000001))
          )
        )
        (if
          (f64.eq
            (f64.load offset=8 (local.get $slot))
            (local.get $key)
          )
          (then
            (return
              (f64.load offset=16 (local.get $slot))
            )
          )
        )
        (local.set $idx
          (i32.and
            (i32.add (local.get $idx) (i32.const 1))
            (i32.sub (local.get $cap) (i32.const 1))
          )
        )
        (local.set $tries
          (i32.add (local.get $tries) (i32.const 1))
        )
        (br_if $done
          (i32.ge_s (local.get $tries) (local.get $cap))
        )
        (br $probe)
      )
    )
    (f64.const nan:0x7FF8000000000001)
  )
  (func $__to_str
    (param $val f64)
    (result f64)
    (local $type i32)
    ;; Not NaN → number, convert
    (if
      (f64.eq (local.get $val) (local.get $val))
      (then
        (return
          (call $__ftoa
            (local.get $val)
            (i32.const 0)
            (i32.const 0)
          )
        )
      )
    )
    (local.set $type
      (i32.and
        (i32.wrap_i64
          (i64.shr_u
            (i64.reinterpret_f64 (local.get $val))
            (i64.const 47)
          )
        )
        (i32.const 15)
      )
    )
    ;; Plain NaN (type=0) → "NaN" string
    (if
      (i32.eqz (local.get $type))
      (then
        (return
          (call $__static_str (i32.const 0))
        )
      )
    )
    ;; Array (type=1) → join(",") like JS Array.toString()
    (if
      (i32.eq (local.get $type) (i32.const 1))
      (then
        (return
          (call $__str_join
            (local.get $val)
            (f64.reinterpret_i64 (i64.const 9221823928777834540))
          )
        )
      )
    )
    (local.get $val)
  )
  (func $__str_copy
    (param $src f64)
    (param $dst i32)
    (param $len i32)
    (local $bits i64)
    (local $w i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $src))
    )
    (if
      (i32.eq
        (i32.wrap_i64
          (i64.and
            (i64.shr_u (local.get $bits) (i64.const 47))
            (i64.const 0xF)
          )
        )
        (i32.const 5)
      )
      (then
        ;; SSO: up to 4 chars packed in low 32 bits (LE byte order). Unroll: write 1/2/3/4 bytes
        ;; depending on len. (len > 4 is rare/disallowed in practice — fallback handles up to 4.)
        (local.set $w
          (i32.wrap_i64 (local.get $bits))
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
            (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
          )
          (local.get $len)
        )
      )
    )
  )
  (func $__str_len
    (param $ptr f64)
    (result i32)
    (local $off i32)
    (local.set $off
      (call $__ptr_offset (local.get $ptr))
    )
    (if
      (result i32)
      (i32.and
        (i32.eq
          (i32.and
            (i32.wrap_i64
              (i64.shr_u
                (i64.reinterpret_f64 (local.get $ptr))
                (i64.const 47)
              )
            )
            (i32.const 15)
          )
          (i32.const 4)
        )
        (i32.ge_u (local.get $off) (i32.const 4))
      )
      (then
        (i32.load
          (i32.sub (local.get $off) (i32.const 4))
        )
      )
      (else (i32.const 0))
    )
  )
  (func $__ftoa
    (param $val f64)
    (param $prec i32)
    (param $mode i32)
    (result f64)
    (local $buf i32)
    (local $pos i32)
    (local $neg i32)
    (local $abs f64)
    (local $scale f64)
    (local $scaled f64)
    (local $int i32)
    (local $frac i32)
    (local $ilen i32)
    (local $i i32)
    (local $j i32)
    ;; Special values
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
    (local.set $buf
      (call $__alloc (i32.const 40))
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
    ;; Default mode: auto-select precision (up to 9 digits, must fit i32 when scaled)
    (if
      (i32.eqz (local.get $mode))
      (then
        (local.set $prec (i32.const 9))
      )
    )
    ;; Round and scale to integer: scaled = nearest(val * 10^prec)
    (local.set $scale
      (call $__pow10 (local.get $prec))
    )
    (local.set $scaled
      (f64.nearest
        (f64.mul (local.get $val) (local.get $scale))
      )
    )
    ;; If scaled doesn't fit i32, reduce precision until it does (min prec=0)
    (block $fit
      (loop $fitl
        (br_if $fit
          (f64.lt (local.get $scaled) (f64.const 2147483648))
        )
        (br_if $fit
          (i32.le_s (local.get $prec) (i32.const 0))
        )
        (local.set $prec
          (i32.sub (local.get $prec) (i32.const 1))
        )
        (local.set $scale
          (call $__pow10 (local.get $prec))
        )
        (local.set $scaled
          (f64.nearest
            (f64.mul (local.get $val) (local.get $scale))
          )
        )
        (br $fitl)
      )
    )
    ;; Split: int = scaled / scale, frac = scaled % scale
    (if
      (f64.lt (local.get $scaled) (f64.const 2147483648))
      (then
        (local.set $int
          (i32.trunc_f64_u
            (f64.div (local.get $scaled) (local.get $scale))
          )
        )
        (local.set $frac
          (i32.trunc_f64_u
            (f64.sub
              (local.get $scaled)
              (f64.mul
                (f64.convert_i32_u (local.get $int))
                (local.get $scale)
              )
            )
          )
        )
      )
      (else
        (local.set $int (i32.const 0))
        (local.set $frac (i32.const 0))
        (local.set $prec (i32.const 0))
        (local.set $abs
          (f64.trunc (local.get $val))
        )
        ;; Write large integer digits reversed
        (local.set $ilen (local.get $pos))
        (block $ld
          (loop $ll
            (br_if $ld
              (f64.lt (local.get $abs) (f64.const 1))
            )
            (i32.store8
              (i32.add (local.get $buf) (local.get $pos))
              (i32.add
                (i32.const 48)
                (i32.trunc_f64_u
                  (f64.sub
                    (local.get $abs)
                    (f64.mul
                      (f64.trunc
                        (f64.div (local.get $abs) (f64.const 10))
                      )
                      (f64.const 10)
                    )
                  )
                )
              )
            )
            (local.set $abs
              (f64.trunc
                (f64.div (local.get $abs) (f64.const 10))
              )
            )
            (local.set $pos
              (i32.add (local.get $pos) (i32.const 1))
            )
            (br $ll)
          )
        )
        ;; Reverse
        (local.set $i (local.get $ilen))
        (local.set $j
          (i32.sub (local.get $pos) (i32.const 1))
        )
        (block $rd
          (loop $rl
            (br_if $rd
              (i32.ge_s (local.get $i) (local.get $j))
            )
            (local.set $int
              (i32.load8_u
                (i32.add (local.get $buf) (local.get $i))
              )
            )
            (i32.store8
              (i32.add (local.get $buf) (local.get $i))
              (i32.load8_u
                (i32.add (local.get $buf) (local.get $j))
              )
            )
            (i32.store8
              (i32.add (local.get $buf) (local.get $j))
              (local.get $int)
            )
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (local.set $j
              (i32.sub (local.get $j) (i32.const 1))
            )
            (br $rl)
          )
        )
        (return
          (call $__mkstr
            (local.get $buf)
            (local.get $pos)
          )
        )
      )
    )
    ;; Write integer part
    (local.set $ilen
      (call $__itoa
        (local.get $int)
        (i32.add (local.get $buf) (local.get $pos))
      )
    )
    (local.set $pos
      (i32.add (local.get $pos) (local.get $ilen))
    )
    ;; Write fractional part: extract digits from $frac by dividing by 10^(prec-1), 10^(prec-2), ...
    (if
      (i32.gt_s (local.get $prec) (i32.const 0))
      (then
        (i32.store8
          (i32.add (local.get $buf) (local.get $pos))
          (i32.const 46)
        )
        (local.set $pos
          (i32.add (local.get $pos) (i32.const 1))
        )
        (local.set $i
          (i32.sub (local.get $prec) (i32.const 1))
        )
        (block $fd
          (loop $fl
            (br_if $fd
              (i32.lt_s (local.get $i) (i32.const 0))
            )
            (local.set $j
              (i32.div_u
                (local.get $frac)
                (i32.trunc_f64_u
                  (call $__pow10 (local.get $i))
                )
              )
            )
            (i32.store8
              (i32.add (local.get $buf) (local.get $pos))
              (i32.add
                (i32.const 48)
                (i32.rem_u (local.get $j) (i32.const 10))
              )
            )
            (local.set $pos
              (i32.add (local.get $pos) (i32.const 1))
            )
            (local.set $i
              (i32.sub (local.get $i) (i32.const 1))
            )
            (br $fl)
          )
        )
      )
    )
    ;; Default mode: strip trailing zeros and dot — only when a fractional part was emitted.
    ;; Gating on $prec>0 prevents stripping zeros from the integer part (e.g. 1079623680 → 107962368)
    ;; for values where auto-fit reduced prec to 0 because the scaled integer wouldn't fit i32.
    (if
      (i32.and
        (i32.eqz (local.get $mode))
        (i32.gt_s (local.get $prec) (i32.const 0))
      )
      (then
        (block $sd
          (loop $sl
            (br_if $sd
              (i32.le_s (local.get $pos) (i32.const 0))
            )
            (br_if $sd
              (i32.ne
                (i32.load8_u
                  (i32.add
                    (local.get $buf)
                    (i32.sub (local.get $pos) (i32.const 1))
                  )
                )
                (i32.const 48)
              )
            )
            (local.set $pos
              (i32.sub (local.get $pos) (i32.const 1))
            )
            (br $sl)
          )
        )
        (if
          (i32.and
            (i32.gt_s (local.get $pos) (i32.const 0))
            (i32.eq
              (i32.load8_u
                (i32.add
                  (local.get $buf)
                  (i32.sub (local.get $pos) (i32.const 1))
                )
              )
              (i32.const 46)
            )
          )
          (then
            (local.set $pos
              (i32.sub (local.get $pos) (i32.const 1))
            )
          )
        )
      )
    )
    (call $__mkstr
      (local.get $buf)
      (local.get $pos)
    )
  )
  (func $runKernel
    (param $a f64)
    (param $scale i32)
    (result i32)
    (local $h f64)
    (local $b f64)
    (local $j f64)
    (local $len4 f64)
    (local $cell_i i32)
    (local $ar1 f64)
    (local $ml2 i32)
    (local $mo3 i32)
    (local $aa4 f64)
    (local $ap5 i32)
    (local $ai6 i32)
    (local $av7 f64)
    (local $inl9 f64)
    (local $11 f64)
    (local.set $h (f64.const -2128831035))
    (local.set $cell_i
      (call $__alloc (i32.const 8))
    )
    (f64.store (local.get $cell_i) (f64.const 0))
    (block $brk0
      (loop $loop0
        (br_if $brk0
          (i32.eqz
            (f64.lt
              (f64.load (local.get $cell_i))
              (f64.convert_i32_s (i32.const 128))
            )
          )
        )
        (local.set $b
          (block
            (result f64)
            (local.set $ar1 (local.get $a))
            (local.set $ml2
              (call $__len (local.get $ar1))
            )
            (local.set $mo3
              (call $__alloc_hdr
                (local.get $ml2)
                (local.get $ml2)
                (i32.const 8)
              )
            )
            (local.set $aa4 (local.get $ar1))
            (local.set $ap5
              (call $__ptr_offset (local.get $aa4))
            )
            (local.set $ai6 (i32.const 0))
            (block $brk8
              (loop $loop8
                (br_if $brk8
                  (i32.ge_s (local.get $ai6) (local.get $ml2))
                )
                (local.set $av7
                  (f64.load
                    (i32.add
                      (local.get $ap5)
                      (i32.shl (local.get $ai6) (i32.const 3))
                    )
                  )
                )
                (f64.store
                  (i32.add
                    (local.get $mo3)
                    (i32.shl (local.get $ai6) (i32.const 3))
                  )
                  (block
                    (result f64)
                    (local.set $inl9 (local.get $av7))
                    (f64.add
                      (f64.mul
                        (call $__to_num (local.get $inl9))
                        (f64.convert_i32_s (local.get $scale))
                      )
                      (f64.load (local.get $cell_i))
                    )
                  )
                )
                (local.set $ai6
                  (i32.add (local.get $ai6) (i32.const 1))
                )
                (br $loop8)
              )
            )
            (f64.reinterpret_i64
              (i64.or
                (i64.const 9221120237041090560)
                (i64.or
                  (i64.const 140737488355328)
                  (i64.and
                    (i64.extend_i32_u (local.get $mo3))
                    (i64.const 0xFFFFFFFF)
                  )
                )
              )
            )
          )
        )
        (local.set $j (f64.const 0))
        (local.set $len4
          (f64.convert_i32_s
            (i32.load
              (i32.sub
                (call $__ptr_offset (local.get $b))
                (i32.const 8)
              )
            )
          )
        )
        (block $brk10
          (loop $loop10
            (br_if $brk10
              (i32.eqz
                (f64.lt (local.get $j) (local.get $len4))
              )
            )
            (local.set $h
              (call $____lib_benchlib_js$mix
                (local.get $h)
                (f64.convert_i32_s
                  (i32.wrap_i64
                    (i64.trunc_sat_f64_s
                      (block
                        (result f64)
                        (local.set $11 (local.get $b))
                        (call $__arr_idx
                          (local.get $11)
                          (i32.trunc_sat_f64_s (local.get $j))
                        )
                      )
                    )
                  )
                )
              )
            )
            (local.set $j
              (f64.add (local.get $j) (f64.const 64))
            )
            (br $loop10)
          )
        )
        (block
          (f64.store
            (local.get $cell_i)
            (f64.add
              (f64.load (local.get $cell_i))
              (f64.const 1)
            )
          )
        )
        (br $loop0)
      )
    )
    (return
      (i32.wrap_i64
        (i64.trunc_sat_f64_s (local.get $h))
      )
    )
  )
  (func $__set_len
    (param $ptr f64)
    (param $len i32)
    (local $bits i64)
    (local $t i32)
    (local $off i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $ptr))
    )
    (local.set $t
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $bits) (i64.const 47))
          (i64.const 0xF)
        )
      )
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
      )
    )
    ;; Only ARRAY (1), TYPED (3), HASH (7), SET (8), MAP (9) carry an 8-byte header.
    ;; Of those, only ARRAY can be forwarded — follow the chain inline.
    (if
      (i32.and
        (i32.ge_u (local.get $off) (i32.const 8))
        (i32.or
          (i32.or
            (i32.eq (local.get $t) (i32.const 1))
            (i32.eq (local.get $t) (i32.const 3))
          )
          (i32.or
            (i32.eq (local.get $t) (i32.const 7))
            (i32.or
              (i32.eq (local.get $t) (i32.const 8))
              (i32.eq (local.get $t) (i32.const 9))
            )
          )
        )
      )
      (then
        (if
          (i32.eq (local.get $t) (i32.const 1))
          (then
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
          )
        )
        (i32.store
          (i32.sub (local.get $off) (i32.const 8))
          (local.get $len)
        )
      )
    )
  )
  (func $__to_buffer
    (param $ptr f64)
    (result f64)
    (local $t i32)
    (local $off i32)
    (local.set $t
      (i32.and
        (i32.wrap_i64
          (i64.shr_u
            (i64.reinterpret_f64 (local.get $ptr))
            (i64.const 47)
          )
        )
        (i32.const 15)
      )
    )
    (if
      (result f64)
      (i32.eq (local.get $t) (i32.const 2))
      (then (local.get $ptr))
      (else
        (local.set $off
          (call $__ptr_offset (local.get $ptr))
        )
        (if
          (result f64)
          (i32.and
            (i32.eq (local.get $t) (i32.const 3))
            (i32.ne
              (i32.and
                (i32.and
                  (i32.wrap_i64
                    (i64.shr_u
                      (i64.reinterpret_f64 (local.get $ptr))
                      (i64.const 32)
                    )
                  )
                  (i32.const 32767)
                )
                (i32.const 8)
              )
              (i32.const 0)
            )
          )
          (then
            (f64.reinterpret_i64
              (i64.or
                (i64.const 9221120237041090560)
                (i64.or
                  (i64.const 281474976710656)
                  (i64.and
                    (i64.extend_i32_u
                      (i32.load offset=8 (local.get $off))
                    )
                    (i64.const 0xFFFFFFFF)
                  )
                )
              )
            )
          )
          (else
            (f64.reinterpret_i64
              (i64.or
                (i64.const 9221120237041090560)
                (i64.or
                  (i64.const 281474976710656)
                  (i64.and
                    (i64.extend_i32_u (local.get $off))
                    (i64.const 0xFFFFFFFF)
                  )
                )
              )
            )
          )
        )
      )
    )
  )
  (func $__byte_offset
    (param $ptr f64)
    (result i32)
    (local $off i32)
    (if
      (result i32)
      (i32.and
        (i32.eq
          (i32.and
            (i32.wrap_i64
              (i64.shr_u
                (i64.reinterpret_f64 (local.get $ptr))
                (i64.const 47)
              )
            )
            (i32.const 15)
          )
          (i32.const 3)
        )
        (i32.ne
          (i32.and
            (i32.and
              (i32.wrap_i64
                (i64.shr_u
                  (i64.reinterpret_f64 (local.get $ptr))
                  (i64.const 32)
                )
              )
              (i32.const 32767)
            )
            (i32.const 8)
          )
          (i32.const 0)
        )
      )
      (then
        (local.set $off
          (call $__ptr_offset (local.get $ptr))
        )
        (i32.sub
          (i32.load offset=4 (local.get $off))
          (i32.load offset=8 (local.get $off))
        )
      )
      (else (i32.const 0))
    )
  )
  (func $__write_val
    (param $fd i32)
    (param $val f64)
    (local $type i32)
    ;; Not NaN → plain number
    (if
      (f64.eq (local.get $val) (local.get $val))
      (then
        (call $__write_str
          (local.get $fd)
          (call $__ftoa
            (local.get $val)
            (i32.const 0)
            (i32.const 0)
          )
        )
        (return)
      )
    )
    ;; NaN: check if it's a pointer (type > 0) or plain NaN (type = 0)
    (local.set $type
      (i32.and
        (i32.wrap_i64
          (i64.shr_u
            (i64.reinterpret_f64 (local.get $val))
            (i64.const 47)
          )
        )
        (i32.const 15)
      )
    )
    (if
      (i32.eqz (local.get $type))
      (then
        (call $__write_str
          (local.get $fd)
          (call $__static_str (i32.const 0))
        )
        (return)
      )
    )
    ;; String pointer
    (if
      (i32.or
        (i32.eq (local.get $type) (i32.const 4))
        (i32.eq (local.get $type) (i32.const 5))
      )
      (then
        (call $__write_str
          (local.get $fd)
          (local.get $val)
        )
        (return)
      )
    )
    ;; Array/Object placeholder
    (call $__write_str
      (local.get $fd)
      (call $__static_str
        (if
          (result i32)
          (i32.eq (local.get $type) (i32.const 1))
          (then (i32.const 7))
          (else (i32.const 8))
        )
      )
    )
  )
  (func $__write_byte
    (param $fd i32)
    (param $byte i32)
    (local $iov i32)
    (local.set $iov
      (call $__alloc (i32.const 13))
    )
    (i32.store8
      (i32.add (local.get $iov) (i32.const 12))
      (local.get $byte)
    )
    (i32.store
      (local.get $iov)
      (i32.add (local.get $iov) (i32.const 12))
    )
    (i32.store offset=4
      (local.get $iov)
      (i32.const 1)
    )
    (drop
      (call $__fd_write
        (local.get $fd)
        (local.get $iov)
        (i32.const 1)
        (i32.add (local.get $iov) (i32.const 8))
      )
    )
  )
  (func $__arr_grow
    (param $ptr f64)
    (param $minCap i32)
    (result f64)
    (local $t i32)
    (local $off i32)
    (local $oldCap i32)
    (local $newCap i32)
    (local $newOff i32)
    (local $len i32)
    (local.set $t
      (i32.and
        (i32.wrap_i64
          (i64.shr_u
            (i64.reinterpret_f64 (local.get $ptr))
            (i64.const 47)
          )
        )
        (i32.const 15)
      )
    )
    (local.set $off
      (call $__ptr_offset (local.get $ptr))
    )
    ;; Defensive path: invalid/non-array pointer -> create fresh array buffer.
    (if
      (i32.or
        (i32.ne (local.get $t) (i32.const 1))
        (i32.lt_u (local.get $off) (i32.const 8))
      )
      (then
        (local.set $newCap
          (select
            (local.get $minCap)
            (i32.const 4)
            (i32.gt_s (local.get $minCap) (i32.const 4))
          )
        )
        (local.set $newOff
          (call $__alloc_hdr
            (i32.const 0)
            (local.get $newCap)
            (i32.const 8)
          )
        )
        (return
          (f64.reinterpret_i64
            (i64.or
              (i64.const 9221120237041090560)
              (i64.or
                (i64.const 140737488355328)
                (i64.and
                  (i64.extend_i32_u (local.get $newOff))
                  (i64.const 0xFFFFFFFF)
                )
              )
            )
          )
        )
      )
    )
    (local.set $oldCap
      (i32.load
        (i32.sub (local.get $off) (i32.const 4))
      )
    )
    (if
      (i32.ge_s (local.get $oldCap) (local.get $minCap))
      (then
        (return (local.get $ptr))
      )
    )
    (local.set $newCap
      (select
        (local.get $minCap)
        (i32.shl (local.get $oldCap) (i32.const 1))
        (i32.gt_s
          (local.get $minCap)
          (i32.shl (local.get $oldCap) (i32.const 1))
        )
      )
    )
    (local.set $len
      (i32.load
        (i32.sub (local.get $off) (i32.const 8))
      )
    )
    (local.set $newOff
      (call $__alloc_hdr
        (local.get $len)
        (local.get $newCap)
        (i32.const 8)
      )
    )
    (memory.copy
      (local.get $newOff)
      (local.get $off)
      (i32.shl (local.get $len) (i32.const 3))
    )
    (call $__dyn_move
      (local.get $off)
      (local.get $newOff)
    )
    (i32.store
      (i32.sub (local.get $off) (i32.const 8))
      (local.get $newOff)
    )
    (i32.store
      (i32.sub (local.get $off) (i32.const 4))
      (i32.const -1)
    )
    (f64.reinterpret_i64
      (i64.or
        (i64.const 9221120237041090560)
        (i64.or
          (i64.const 140737488355328)
          (i64.and
            (i64.extend_i32_u (local.get $newOff))
            (i64.const 0xFFFFFFFF)
          )
        )
      )
    )
  )
  (func $__arr_idx
    (param $ptr f64)
    (param $i i32)
    (result f64)
    (local $bits i64)
    (local $off i32)
    (local.set $bits
      (i64.reinterpret_f64 (local.get $ptr))
    )
    (if
      (result f64)
      (i32.ne
        (i32.wrap_i64
          (i64.and
            (i64.shr_u (local.get $bits) (i64.const 47))
            (i64.const 0xF)
          )
        )
        (i32.const 1)
      )
      (then (f64.const nan:0x7FF8000000000001))
      (else
        (local.set $off
          (i32.wrap_i64
            (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
          )
        )
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
        (if
          (result f64)
          (i32.and
            (i32.ge_u (local.get $off) (i32.const 8))
            (i32.and
              (i32.ge_s (local.get $i) (i32.const 0))
              (i32.lt_u
                (local.get $i)
                (i32.load
                  (i32.sub (local.get $off) (i32.const 8))
                )
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
          (else (f64.const nan:0x7FF8000000000001))
        )
      )
    )
  )
  (func $__dyn_move
    (param $oldOff i32)
    (param $newOff i32)
    (local $props f64)
    (local $root f64)
    (if
      (f64.eq (global.get $__dyn_props) (f64.const 0))
      (then (return))
    )
    (local.set $props
      (call $__ihash_get_local
        (global.get $__dyn_props)
        (f64.convert_i32_s (local.get $oldOff))
      )
    )
    (if
      (i32.or
        (i64.eq
          (i64.reinterpret_f64 (local.get $props))
          (i64.const 0x7FF8000100000000)
        )
        (i64.eq
          (i64.reinterpret_f64 (local.get $props))
          (i64.const 0x7FF8000000000001)
        )
      )
      (then (return))
    )
    (local.set $root
      (call $__ihash_set_local
        (global.get $__dyn_props)
        (f64.convert_i32_s (local.get $newOff))
        (local.get $props)
      )
    )
    (global.set $__dyn_props (local.get $root))
  )
  (func $__ihash_set_local
    (param $obj f64)
    (param $key f64)
    (param $val f64)
    (result f64)
    (local $off i32)
    (local $cap i32)
    (local $h i32)
    (local $idx i32)
    (local $slot i32)
    (local $size i32)
    (local $newptr i32)
    (local $newcap i32)
    (local $i i32)
    (local $oldslot i32)
    (local $newidx i32)
    (local $newslot i32)
    (if
      (i32.ne
        (i32.and
          (i32.wrap_i64
            (i64.shr_u
              (i64.reinterpret_f64 (local.get $obj))
              (i64.const 47)
            )
          )
          (i32.const 15)
        )
        (i32.const 7)
      )
      (then
        (return (local.get $obj))
      )
    )
    (local.set $off
      (call $__ptr_offset (local.get $obj))
    )
    (local.set $cap
      (i32.load
        (i32.sub (local.get $off) (i32.const 4))
      )
    )
    (local.set $size
      (i32.load
        (i32.sub (local.get $off) (i32.const 8))
      )
    )
    ;; Grow if load factor > 75%: size * 4 >= cap * 3
    (if
      (i32.ge_s
        (i32.shl (local.get $size) (i32.const 2))
        (i32.mul (local.get $cap) (i32.const 3))
      )
      (then
        (local.set $newcap
          (i32.shl (local.get $cap) (i32.const 1))
        )
        (local.set $newptr
          (call $__alloc_hdr
            (i32.const 0)
            (local.get $newcap)
            (i32.const 24)
          )
        )
        (local.set $i (i32.const 0))
        (block $rd
          (loop $rl
            (br_if $rd
              (i32.ge_s (local.get $i) (local.get $cap))
            )
            (local.set $oldslot
              (i32.add
                (local.get $off)
                (i32.mul (local.get $i) (i32.const 24))
              )
            )
            (if
              (f64.ne
                (f64.load (local.get $oldslot))
                (f64.const 0)
              )
              (then
                (local.set $h
                  (i32.wrap_i64
                    (i64.xor
                      (i64.reinterpret_f64
                        (f64.load offset=8 (local.get $oldslot))
                      )
                      (i64.shr_u
                        (i64.reinterpret_f64
                          (f64.load offset=8 (local.get $oldslot))
                        )
                        (i64.const 32)
                      )
                    )
                  )
                )
                (local.set $newidx
                  (i32.and
                    (local.get $h)
                    (i32.sub (local.get $newcap) (i32.const 1))
                  )
                )
                (block $ins
                  (loop $probe2
                    (local.set $newslot
                      (i32.add
                        (local.get $newptr)
                        (i32.mul (local.get $newidx) (i32.const 24))
                      )
                    )
                    (br_if $ins
                      (f64.eq
                        (f64.load (local.get $newslot))
                        (f64.const 0)
                      )
                    )
                    (local.set $newidx
                      (i32.and
                        (i32.add (local.get $newidx) (i32.const 1))
                        (i32.sub (local.get $newcap) (i32.const 1))
                      )
                    )
                    (br $probe2)
                  )
                )
                (f64.store
                  (local.get $newslot)
                  (f64.load (local.get $oldslot))
                )
                (f64.store offset=8
                  (local.get $newslot)
                  (f64.load offset=8 (local.get $oldslot))
                )
                (f64.store offset=16
                  (local.get $newslot)
                  (f64.load offset=16 (local.get $oldslot))
                )
                (i32.store
                  (i32.sub (local.get $newptr) (i32.const 8))
                  (i32.add
                    (i32.load
                      (i32.sub (local.get $newptr) (i32.const 8))
                    )
                    (i32.const 1)
                  )
                )
              )
            )
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $rl)
          )
        )
        (local.set $off (local.get $newptr))
        (local.set $cap (local.get $newcap))
        (local.set $obj
          (f64.reinterpret_i64
            (i64.or
              (i64.const 9221120237041090560)
              (i64.or
                (i64.const 985162418487296)
                (i64.and
                  (i64.extend_i32_u (local.get $newptr))
                  (i64.const 0xFFFFFFFF)
                )
              )
            )
          )
        )
      )
    )
    ;; Insert/update
    (local.set $h
      (i32.wrap_i64
        (i64.xor
          (i64.reinterpret_f64 (local.get $key))
          (i64.shr_u
            (i64.reinterpret_f64 (local.get $key))
            (i64.const 32)
          )
        )
      )
    )
    (local.set $idx
      (i32.and
        (local.get $h)
        (i32.sub (local.get $cap) (i32.const 1))
      )
    )
    (block $done
      (loop $probe
        (local.set $slot
          (i32.add
            (local.get $off)
            (i32.mul (local.get $idx) (i32.const 24))
          )
        )
        (if
          (f64.eq
            (f64.load (local.get $slot))
            (f64.const 0)
          )
          (then
            (f64.store
              (local.get $slot)
              (f64.reinterpret_i64
                (i64.extend_i32_u (local.get $h))
              )
            )
            (f64.store offset=8
              (local.get $slot)
              (local.get $key)
            )
            (f64.store offset=16
              (local.get $slot)
              (local.get $val)
            )
            (i32.store
              (i32.sub (local.get $off) (i32.const 8))
              (i32.add
                (i32.load
                  (i32.sub (local.get $off) (i32.const 8))
                )
                (i32.const 1)
              )
            )
            (br $done)
          )
        )
        (if
          (f64.eq
            (f64.load offset=8 (local.get $slot))
            (local.get $key)
          )
          (then
            (f64.store offset=16
              (local.get $slot)
              (local.get $val)
            )
            (br $done)
          )
        )
        (local.set $idx
          (i32.and
            (i32.add (local.get $idx) (i32.const 1))
            (i32.sub (local.get $cap) (i32.const 1))
          )
        )
        (br $probe)
      )
    )
    (local.get $obj)
  )
  (func $__str_join
    (param $arr f64)
    (param $sep f64)
    (result f64)
    (local $off i32)
    (local $len i32)
    (local $i i32)
    (local $result f64)
    (local.set $off
      (call $__ptr_offset (local.get $arr))
    )
    (local.set $len
      (call $__len (local.get $arr))
    )
    (if
      (i32.eqz (local.get $len))
      (then
        (return
          (f64.reinterpret_i64 (i64.const 9221823924482867200))
        )
      )
    )
    (local.set $result
      (f64.load (local.get $off))
    )
    (local.set $i (i32.const 1))
    (block $done
      (loop $loop
        (br_if $done
          (i32.ge_s (local.get $i) (local.get $len))
        )
        (local.set $result
          (call $__str_concat
            (local.get $result)
            (local.get $sep)
          )
        )
        (local.set $result
          (call $__str_concat
            (local.get $result)
            (f64.load
              (i32.add
                (local.get $off)
                (i32.shl (local.get $i) (i32.const 3))
              )
            )
          )
        )
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (br $loop)
      )
    )
    (local.get $result)
  )
  (func $__itoa
    (param $val i32)
    (param $buf i32)
    (result i32)
    (local $len i32)
    (local $i i32)
    (local $j i32)
    (local $tmp i32)
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
    (block $rd
      (loop $rl
        (br_if $rd
          (i32.ge_s (local.get $i) (local.get $j))
        )
        (local.set $tmp
          (i32.load8_u
            (i32.add (local.get $buf) (local.get $i))
          )
        )
        (i32.store8
          (i32.add (local.get $buf) (local.get $i))
          (i32.load8_u
            (i32.add (local.get $buf) (local.get $j))
          )
        )
        (i32.store8
          (i32.add (local.get $buf) (local.get $j))
          (local.get $tmp)
        )
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (local.set $j
          (i32.sub (local.get $j) (i32.const 1))
        )
        (br $rl)
      )
    )
    (local.get $len)
  )
  (func $__str_hash
    (param $s f64)
    (result i32)
    (local $h i32)
    (local $len i32)
    (local $lenA i32)
    (local $i i32)
    (local $t i32)
    (local $off i32)
    (local $bits i64)
    (local $w i32)
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $bits
      (i64.reinterpret_f64 (local.get $s))
    )
    (local.set $t
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $bits) (i64.const 47))
          (i64.const 0xF)
        )
      )
    )
    (local.set $off
      (i32.wrap_i64
        (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))
      )
    )
    (if
      (i32.eq (local.get $t) (i32.const 5))
      (then
        (local.set $len
          (i32.wrap_i64
            (i64.and
              (i64.shr_u (local.get $bits) (i64.const 32))
              (i64.const 0x7FFF)
            )
          )
        )
        (block $ds
          (loop $ls
            (br_if $ds
              (i32.ge_s (local.get $i) (local.get $len))
            )
            (local.set $h
              (i32.mul
                (i32.xor
                  (local.get $h)
                  (i32.and
                    (i32.shr_u
                      (local.get $off)
                      (i32.shl (local.get $i) (i32.const 3))
                    )
                    (i32.const 0xFF)
                  )
                )
                (i32.const 0x01000193)
              )
            )
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $ls)
          )
        )
      )
      (else
        (if
          (i32.and
            (i32.eq (local.get $t) (i32.const 4))
            (i32.ge_u (local.get $off) (i32.const 4))
          )
          (then
            (local.set $len
              (i32.load
                (i32.sub (local.get $off) (i32.const 4))
              )
            )
          )
        )
        ;; 4-byte unrolled FNV-1a: each iter loads i32, mixes 4 bytes (little-endian) sequentially.
        (local.set $lenA
          (i32.and (local.get $len) (i32.const -4))
        )
        (block $d4
          (loop $l4
            (br_if $d4
              (i32.ge_s (local.get $i) (local.get $lenA))
            )
            (local.set $w
              (i32.load
                (i32.add (local.get $off) (local.get $i))
              )
            )
            (local.set $h
              (i32.mul
                (i32.xor
                  (local.get $h)
                  (i32.and (local.get $w) (i32.const 0xFF))
                )
                (i32.const 0x01000193)
              )
            )
            (local.set $h
              (i32.mul
                (i32.xor
                  (local.get $h)
                  (i32.and
                    (i32.shr_u (local.get $w) (i32.const 8))
                    (i32.const 0xFF)
                  )
                )
                (i32.const 0x01000193)
              )
            )
            (local.set $h
              (i32.mul
                (i32.xor
                  (local.get $h)
                  (i32.and
                    (i32.shr_u (local.get $w) (i32.const 16))
                    (i32.const 0xFF)
                  )
                )
                (i32.const 0x01000193)
              )
            )
            (local.set $h
              (i32.mul
                (i32.xor
                  (local.get $h)
                  (i32.shr_u (local.get $w) (i32.const 24))
                )
                (i32.const 0x01000193)
              )
            )
            (local.set $i
              (i32.add (local.get $i) (i32.const 4))
            )
            (br $l4)
          )
        )
        (block $dh
          (loop $lh
            (br_if $dh
              (i32.ge_s (local.get $i) (local.get $len))
            )
            (local.set $h
              (i32.mul
                (i32.xor
                  (local.get $h)
                  (i32.load8_u
                    (i32.add (local.get $off) (local.get $i))
                  )
                )
                (i32.const 0x01000193)
              )
            )
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $lh)
          )
        )
      )
    )
    ;; Ensure >= 2 (0=empty, 1=tombstone)
    (if
      (result i32)
      (i32.le_s (local.get $h) (i32.const 1))
      (then
        (i32.add (local.get $h) (i32.const 2))
      )
      (else (local.get $h))
    )
  )
  (func $__str_eq
    (param $a f64)
    (param $b f64)
    (result i32)
    (local $len i32)
    (local $lenB i32)
    (local $i i32)
    (local $ba i64)
    (local $bb i64)
    (local $ta i32)
    (local $tb i32)
    (local $offA i32)
    (local $offB i32)
    (local.set $ba
      (i64.reinterpret_f64 (local.get $a))
    )
    (local.set $bb
      (i64.reinterpret_f64 (local.get $b))
    )
    (if
      (i64.eq (local.get $ba) (local.get $bb))
      (then
        (return (i32.const 1))
      )
    )
    (local.set $ta
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $ba) (i64.const 47))
          (i64.const 0xF)
        )
      )
    )
    (local.set $tb
      (i32.wrap_i64
        (i64.and
          (i64.shr_u (local.get $bb) (i64.const 47))
          (i64.const 0xF)
        )
      )
    )
    (local.set $offA
      (i32.wrap_i64
        (i64.and (local.get $ba) (i64.const 0xFFFFFFFF))
      )
    )
    (local.set $offB
      (i32.wrap_i64
        (i64.and (local.get $bb) (i64.const 0xFFFFFFFF))
      )
    )
    ;; Both SSO with !bit-eq ⇒ content differs (high 32 bits hold type+len; both equal here).
    (if
      (i32.and
        (i32.eq (local.get $ta) (i32.const 5))
        (i32.eq (local.get $tb) (i32.const 5))
      )
      (then
        (return (i32.const 0))
      )
    )
    ;; Both STRING fast path: inline len from header. Chunk by 4 bytes via unaligned i32.load
    ;; (wasm guarantees unaligned-OK), then byte-tail. Most string comparisons fail early on
    ;; the first 4-byte word, so this collapses the per-byte branch overhead into a single
    ;; 32-bit equality.
    (if
      (i32.and
        (i32.eq (local.get $ta) (i32.const 4))
        (i32.eq (local.get $tb) (i32.const 4))
      )
      (then
        (if
          (i32.or
            (i32.lt_u (local.get $offA) (i32.const 4))
            (i32.lt_u (local.get $offB) (i32.const 4))
          )
          (then
            (return (i32.const 0))
          )
        )
        (local.set $len
          (i32.load
            (i32.sub (local.get $offA) (i32.const 4))
          )
        )
        (local.set $lenB
          (i32.load
            (i32.sub (local.get $offB) (i32.const 4))
          )
        )
        (if
          (i32.ne (local.get $len) (local.get $lenB))
          (then
            (return (i32.const 0))
          )
        )
        (local.set $lenB
          (i32.and (local.get $len) (i32.const -4))
        )
        (block $d4
          (loop $l4
            (br_if $d4
              (i32.ge_s (local.get $i) (local.get $lenB))
            )
            (if
              (i32.ne
                (i32.load
                  (i32.add (local.get $offA) (local.get $i))
                )
                (i32.load
                  (i32.add (local.get $offB) (local.get $i))
                )
              )
              (then
                (return (i32.const 0))
              )
            )
            (local.set $i
              (i32.add (local.get $i) (i32.const 4))
            )
            (br $l4)
          )
        )
        (block $dh
          (loop $lh
            (br_if $dh
              (i32.ge_s (local.get $i) (local.get $len))
            )
            (if
              (i32.ne
                (i32.load8_u
                  (i32.add (local.get $offA) (local.get $i))
                )
                (i32.load8_u
                  (i32.add (local.get $offB) (local.get $i))
                )
              )
              (then
                (return (i32.const 0))
              )
            )
            (local.set $i
              (i32.add (local.get $i) (i32.const 1))
            )
            (br $lh)
          )
        )
        (return (i32.const 1))
      )
    )
    ;; Mixed (SSO×STRING) or anything else: compute len per side then per-byte via __char_at.
    (if
      (i32.eq (local.get $ta) (i32.const 5))
      (then
        (local.set $len
          (i32.wrap_i64
            (i64.and
              (i64.shr_u (local.get $ba) (i64.const 32))
              (i64.const 0x7FFF)
            )
          )
        )
      )
      (else
        (if
          (i32.and
            (i32.eq (local.get $ta) (i32.const 4))
            (i32.ge_u (local.get $offA) (i32.const 4))
          )
          (then
            (local.set $len
              (i32.load
                (i32.sub (local.get $offA) (i32.const 4))
              )
            )
          )
        )
      )
    )
    (if
      (i32.eq (local.get $tb) (i32.const 5))
      (then
        (local.set $lenB
          (i32.wrap_i64
            (i64.and
              (i64.shr_u (local.get $bb) (i64.const 32))
              (i64.const 0x7FFF)
            )
          )
        )
      )
      (else
        (if
          (i32.and
            (i32.eq (local.get $tb) (i32.const 4))
            (i32.ge_u (local.get $offB) (i32.const 4))
          )
          (then
            (local.set $lenB
              (i32.load
                (i32.sub (local.get $offB) (i32.const 4))
              )
            )
          )
        )
      )
    )
    (if
      (i32.ne (local.get $len) (local.get $lenB))
      (then
        (return (i32.const 0))
      )
    )
    (block $dm
      (loop $lm
        (br_if $dm
          (i32.ge_s (local.get $i) (local.get $len))
        )
        (if
          (i32.ne
            (call $__char_at
              (local.get $a)
              (local.get $i)
            )
            (call $__char_at
              (local.get $b)
              (local.get $i)
            )
          )
          (then
            (return (i32.const 0))
          )
        )
        (local.set $i
          (i32.add (local.get $i) (i32.const 1))
        )
        (br $lm)
      )
    )
    (i32.const 1)
  )
  (func $____lib_benchlib_js$medianUs
    (export "____lib_benchlib_js$medianUs")
    (param $samples f64)
    (result f64)
    (local $sorted i32)
    (local $i f64)
    (local $len0 f64)
    (local $len1 f64)
    (local $v f64)
    (local $j i32)
    (local $ts0 f64)
    (local $tl1 i32)
    (local $ta2 i32)
    (local $tfs3 f64)
    (local $tfl4 i32)
    (local $tfi5 i32)
    (local $tfo6 i32)
    (local $tf7 i32)
    (local $11 f64)
    (local $__pt0 i32)
    (local $__ab0 i32)
    (local.set $sorted
      (i32.wrap_i64
        (i64.reinterpret_f64
          (block
            (result f64)
            (local.set $ts0
              (call $__length (local.get $samples))
            )
            (if
              (result f64)
              (f64.eq (local.get $ts0) (local.get $ts0))
              (then
                (block
                  (result f64)
                  (local.set $tl1
                    (i32.trunc_sat_f64_s (local.get $ts0))
                  )
                  (local.set $ta2
                    (call $__alloc_hdr
                      (i32.shl (local.get $tl1) (i32.const 3))
                      (i32.shl (local.get $tl1) (i32.const 3))
                      (i32.const 1)
                    )
                  )
                  (f64.reinterpret_i64
                    (i64.or
                      (i64.const 9221120237041090560)
                      (i64.or
                        (i64.const 422212465065984)
                        (i64.or
                          (i64.const 30064771072)
                          (i64.and
                            (i64.extend_i32_u (local.get $ta2))
                            (i64.const 0xFFFFFFFF)
                          )
                        )
                      )
                    )
                  )
                )
              )
              (else
                (if
                  (result f64)
                  (i32.eq
                    (i32.and
                      (i32.wrap_i64
                        (i64.shr_u
                          (i64.reinterpret_f64 (local.get $ts0))
                          (i64.const 47)
                        )
                      )
                      (i32.const 15)
                    )
                    (i32.const 1)
                  )
                  (then
                    (block
                      (result f64)
                      (local.set $tfs3 (local.get $ts0))
                      (local.set $tfo6
                        (call $__ptr_offset (local.get $tfs3))
                      )
                      (local.set $tfl4
                        (call $__len (local.get $tfs3))
                      )
                      (local.set $tf7
                        (call $__alloc_hdr
                          (i32.shl (local.get $tfl4) (i32.const 3))
                          (i32.shl (local.get $tfl4) (i32.const 3))
                          (i32.const 1)
                        )
                      )
                      (local.set $tfi5 (i32.const 0))
                      (block $brk8
                        (loop $loop8
                          (br_if $brk8
                            (i32.ge_s (local.get $tfi5) (local.get $tfl4))
                          )
                          (f64.store
                            (i32.add
                              (local.get $tf7)
                              (i32.shl (local.get $tfi5) (i32.const 3))
                            )
                            (f64.load
                              (i32.add
                                (local.get $tfo6)
                                (i32.shl (local.get $tfi5) (i32.const 3))
                              )
                            )
                          )
                          (local.set $tfi5
                            (i32.add (local.get $tfi5) (i32.const 1))
                          )
                          (br $loop8)
                        )
                      )
                      (f64.reinterpret_i64
                        (i64.or
                          (i64.const 9221120237041090560)
                          (i64.or
                            (i64.const 422212465065984)
                            (i64.or
                              (i64.const 30064771072)
                              (i64.and
                                (i64.extend_i32_u (local.get $tf7))
                                (i64.const 0xFFFFFFFF)
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                  (else
                    (f64.reinterpret_i64
                      (i64.or
                        (i64.const 9221120237041090560)
                        (i64.or
                          (i64.const 422212465065984)
                          (i64.or
                            (i64.const 30064771072)
                            (i64.and
                              (i64.extend_i32_u
                                (call $__ptr_offset (local.get $ts0))
                              )
                              (i64.const 0xFFFFFFFF)
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
    )
    (local.set $i (f64.const 0))
    (local.set $len0
      (call $__length (local.get $samples))
    )
    (block $brk9
      (loop $loop9
        (br_if $brk9
          (i32.eqz
            (f64.lt (local.get $i) (local.get $len0))
          )
        )
        (f64.store
          (i32.add
            (local.get $sorted)
            (i32.shl
              (i32.trunc_sat_f64_s (local.get $i))
              (i32.const 3)
            )
          )
          (block
            (result f64)
            (local.set $11 (local.get $i))
            (if
              (result f64)
              (call $__is_str_key (local.get $11))
              (then
                (call $__dyn_get
                  (local.get $samples)
                  (local.get $11)
                )
              )
              (else
                (if
                  (result f64)
                  (i32.or
                    (i32.eq
                      (local.tee $__pt0
                        (i32.and
                          (i32.wrap_i64
                            (i64.shr_u
                              (i64.reinterpret_f64 (local.get $samples))
                              (i64.const 47)
                            )
                          )
                          (i32.const 15)
                        )
                      )
                      (i32.const 4)
                    )
                    (i32.eq (local.get $__pt0) (i32.const 5))
                  )
                  (then
                    (call $__str_idx
                      (local.get $samples)
                      (i32.trunc_sat_f64_s (local.get $11))
                    )
                  )
                  (else
                    (call $__typed_idx
                      (local.get $samples)
                      (i32.trunc_sat_f64_s (local.get $11))
                    )
                  )
                )
              )
            )
          )
        )
        (local.set $i
          (f64.add (local.get $i) (f64.const 1))
        )
        (br $loop9)
      )
    )
    (local.set $i (f64.const 1))
    (local.set $len1
      (f64.convert_i32_s
        (call $__len
          (f64.reinterpret_i64
            (i64.or
              (i64.const 0x7FF9800700000000)
              (i64.extend_i32_u (local.get $sorted))
            )
          )
        )
      )
    )
    (block $brk12
      (loop $loop12
        (br_if $brk12
          (i32.eqz
            (f64.lt (local.get $i) (local.get $len1))
          )
        )
        (local.set $v
          (f64.load
            (i32.add
              (local.get $sorted)
              (i32.shl
                (i32.trunc_sat_f64_s (local.get $i))
                (i32.const 3)
              )
            )
          )
        )
        (local.set $j
          (i32.trunc_sat_f64_s
            (f64.sub (local.get $i) (f64.const 1))
          )
        )
        (block $brk13
          (loop $loop13
            (br_if $brk13
              (i32.eqz
                (i32.and
                  (i32.ge_s (local.get $j) (i32.const 0))
                  (f64.gt
                    (f64.load
                      (local.tee $__ab0
                        (i32.add
                          (local.get $sorted)
                          (i32.shl (local.get $j) (i32.const 3))
                        )
                      )
                    )
                    (local.get $v)
                  )
                )
              )
            )
            (f64.store offset=8
              (local.get $__ab0)
              (f64.load (local.get $__ab0))
            )
            (local.set $j
              (i32.sub (local.get $j) (i32.const 1))
            )
            (br $loop13)
          )
        )
        (f64.store offset=8
          (i32.add
            (local.get $sorted)
            (i32.shl (local.get $j) (i32.const 3))
          )
          (local.get $v)
        )
        (local.set $i
          (f64.add (local.get $i) (f64.const 1))
        )
        (br $loop12)
      )
    )
    (return
      (f64.convert_i32_s
        (i32.wrap_i64
          (i64.trunc_sat_f64_s
            (f64.mul
              (f64.load
                (i32.add
                  (local.get $sorted)
                  (i32.shl
                    (i32.shr_s
                      (i32.wrap_i64
                        (i64.trunc_sat_f64_s
                          (f64.sub
                            (call $__to_num
                              (f64.convert_i32_s
                                (call $__len
                                  (f64.reinterpret_i64
                                    (i64.or
                                      (i64.const 0x7FF9800700000000)
                                      (i64.extend_i32_u (local.get $sorted))
                                    )
                                  )
                                )
                              )
                            )
                            (f64.const 1)
                          )
                        )
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
    )
  )
  (func $____lib_benchlib_js$printResult
    (export "____lib_benchlib_js$printResult")
    (param $medianUs f64)
    (param $checksum f64)
    (param $samples f64)
    (param $stages f64)
    (param $runs f64)
    (result f64)
    (block
      (result f64)
      (call $__write_val
        (i32.const 1)
        (call $__str_concat
          (call $__str_concat
            (call $__str_concat
              (call $__str_concat
                (call $__str_concat
                  (call $__str_concat
                    (call $__str_concat
                      (call $__str_concat
                        (call $__str_concat
                          (f64.const nan:0x7FFA000000000040)
                          (local.get $medianUs)
                        )
                        (f64.const nan:0x7FFA000000000050)
                      )
                      (local.get $checksum)
                    )
                    (f64.const nan:0x7FFA000000000060)
                  )
                  (local.get $samples)
                )
                (f64.const nan:0x7FFA000000000070)
              )
              (local.get $stages)
            )
            (f64.const nan:0x7FFA00000000007C)
          )
          (local.get $runs)
        )
      )
      (call $__write_byte
        (i32.const 1)
        (i32.const 10)
      )
      (f64.const 0)
    ) drop
    (f64.const 0)
  )
  (func $init
    (result f64)
    (local $a f64)
    (local $i f64)
    (local $arr0 i32)
    (local $pp2 f64)
    (local $pl3 i32)
    (local $pb4 i32)
    (local.set $a
      (block
        (result f64)
        (local.set $arr0
          (call $__alloc_hdr
            (i32.const 0)
            (i32.const 4)
            (i32.const 8)
          )
        )
        (f64.reinterpret_i64
          (i64.or
            (i64.const 9221120237041090560)
            (i64.or
              (i64.const 140737488355328)
              (i64.and
                (i64.extend_i32_u (local.get $arr0))
                (i64.const 0xFFFFFFFF)
              )
            )
          )
        )
      )
    )
    (local.set $i (f64.const 0))
    (block $brk1
      (loop $loop1
        (br_if $brk1
          (i32.eqz
            (f64.lt
              (local.get $i)
              (f64.convert_i32_s (i32.const 4096))
            )
          )
        )
        (block
          (result f64)
          (local.set $pp2 (local.get $a))
          (local.set $pb4
            (call $__ptr_offset (local.get $pp2))
          )
          (local.set $pl3
            (i32.load
              (i32.sub (local.get $pb4) (i32.const 8))
            )
          )
          (if
            (i32.lt_s
              (i32.load
                (i32.sub (local.get $pb4) (i32.const 4))
              )
              (i32.add (local.get $pl3) (i32.const 1))
            )
            (then
              (local.set $pp2
                (call $__arr_grow
                  (local.get $pp2)
                  (i32.add (local.get $pl3) (i32.const 1))
                )
              )
              (local.set $pb4
                (call $__ptr_offset (local.get $pp2))
              )
            )
          )
          (f64.store
            (i32.add
              (local.get $pb4)
              (i32.shl (local.get $pl3) (i32.const 3))
            )
            (f64.sub
              (f64.sub
                (local.get $i)
                (f64.mul
                  (f64.trunc
                    (f64.div (local.get $i) (f64.const 97))
                  )
                  (f64.const 97)
                )
              )
              (f64.const 48)
            )
          )
          (local.set $pl3
            (i32.add (local.get $pl3) (i32.const 1))
          )
          (call $__set_len
            (local.get $pp2)
            (local.get $pl3)
          )
          (local.set $a (local.get $pp2))
          (f64.convert_i32_s (local.get $pl3))
        ) drop
        (local.set $i
          (f64.add (local.get $i) (f64.const 1))
        )
        (br $loop1)
      )
    )
    (return (local.get $a))
  )
  (func $____lib_benchlib_js$checksumF64
    (export "____lib_benchlib_js$checksumF64")
    (param $out f64)
    (result f64)
    (local $u i32)
    (local $h f64)
    (local $stride i32)
    (local $i f64)
    (local $len2 f64)
    (local $tvs0 f64)
    (local $tvp1 i32)
    (local $tvb2 i32)
    (local $tvd3 i32)
    (local.set $u
      (i32.wrap_i64
        (i64.reinterpret_f64
          (block
            (result f64)
            (local.set $tvs0
              (call $__to_buffer (local.get $out))
            )
            (local.set $tvp1
              (call $__ptr_offset (local.get $tvs0))
            )
            (local.set $tvb2
              (i32.shl
                (i32.trunc_sat_f64_s
                  (f64.mul
                    (call $__to_num
                      (call $__length (local.get $out))
                    )
                    (f64.const 2)
                  )
                )
                (i32.const 2)
              )
            )
            (local.set $tvd3
              (call $__alloc (i32.const 16))
            )
            (i32.store (local.get $tvd3) (local.get $tvb2))
            (i32.store offset=4
              (local.get $tvd3)
              (i32.add
                (local.get $tvp1)
                (i32.trunc_sat_f64_s
                  (f64.convert_i32_s
                    (call $__byte_offset (local.get $out))
                  )
                )
              )
            )
            (i32.store offset=8
              (local.get $tvd3)
              (local.get $tvp1)
            )
            (f64.reinterpret_i64
              (i64.or
                (i64.const 9221120237041090560)
                (i64.or
                  (i64.const 422212465065984)
                  (i64.or
                    (i64.const 55834574848)
                    (i64.and
                      (i64.extend_i32_u (local.get $tvd3))
                      (i64.const 0xFFFFFFFF)
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
    (local.set $h (f64.const -2128831035))
    (local.set $stride (i32.const 256))
    (local.set $i (f64.const 0))
    (local.set $len2
      (f64.convert_i32_s
        (call $__len
          (f64.reinterpret_i64
            (i64.or
              (i64.const 0x7FF9800D00000000)
              (i64.extend_i32_u (local.get $u))
            )
          )
        )
      )
    )
    (block $brk4
      (loop $loop4
        (br_if $brk4
          (i32.eqz
            (f64.lt (local.get $i) (local.get $len2))
          )
        )
        (local.set $h
          (call $____lib_benchlib_js$mix
            (local.get $h)
            (f64.convert_i32_u
              (i32.load
                (i32.add
                  (i32.load offset=4 (local.get $u))
                  (i32.shl
                    (i32.trunc_sat_f64_s (local.get $i))
                    (i32.const 2)
                  )
                )
              )
            )
          )
        )
        (local.set $i
          (f64.add
            (local.get $i)
            (f64.convert_i32_s (local.get $stride))
          )
        )
        (br $loop4)
      )
    )
    (return
      (f64.convert_i32_u
        (i32.wrap_i64
          (i64.trunc_sat_f64_s (local.get $h))
        )
      )
    )
  )
  (func $____lib_benchlib_js$checksumU32
    (export "____lib_benchlib_js$checksumU32")
    (param $out f64)
    (result f64)
    (local $h f64)
    (local $stride i32)
    (local $i f64)
    (local $len3 f64)
    (local $1 f64)
    (local $__pt0 i32)
    (local.set $h (f64.const -2128831035))
    (local.set $stride (i32.const 128))
    (local.set $i (f64.const 0))
    (local.set $len3
      (call $__length (local.get $out))
    )
    (block $brk0
      (loop $loop0
        (br_if $brk0
          (i32.eqz
            (f64.lt (local.get $i) (local.get $len3))
          )
        )
        (local.set $h
          (call $____lib_benchlib_js$mix
            (local.get $h)
            (block
              (result f64)
              (local.set $1 (local.get $i))
              (if
                (result f64)
                (call $__is_str_key (local.get $1))
                (then
                  (call $__dyn_get
                    (local.get $out)
                    (local.get $1)
                  )
                )
                (else
                  (if
                    (result f64)
                    (i32.or
                      (i32.eq
                        (local.tee $__pt0
                          (i32.and
                            (i32.wrap_i64
                              (i64.shr_u
                                (i64.reinterpret_f64 (local.get $out))
                                (i64.const 47)
                              )
                            )
                            (i32.const 15)
                          )
                        )
                        (i32.const 4)
                      )
                      (i32.eq (local.get $__pt0) (i32.const 5))
                    )
                    (then
                      (call $__str_idx
                        (local.get $out)
                        (i32.trunc_sat_f64_s (local.get $1))
                      )
                    )
                    (else
                      (call $__typed_idx
                        (local.get $out)
                        (i32.trunc_sat_f64_s (local.get $1))
                      )
                    )
                  )
                )
              )
            )
          )
        )
        (local.set $i
          (f64.add
            (local.get $i)
            (f64.convert_i32_s (local.get $stride))
          )
        )
        (br $loop0)
      )
    )
    (return
      (f64.convert_i32_u
        (i32.wrap_i64
          (i64.trunc_sat_f64_s (local.get $h))
        )
      )
    )
  )
  (func $main
    (export "main")
    (result f64)
    (local $a f64)
    (local $cs f64)
    (local $i f64)
    (local $samples i32)
    (local $t0 f64)
    (local $tan1 i32)
    (local $ta2 i32)
    (local.set $a (call $init))
    (local.set $i (f64.const 0))
    (block $brk0
      (loop $loop0
        (br_if $brk0
          (i32.eqz
            (f64.lt
              (local.get $i)
              (f64.convert_i32_s (i32.const 5))
            )
          )
        )
        (local.set $cs
          (f64.convert_i32_s
            (call $runKernel
              (local.get $a)
              (i32.const 2)
            )
          )
        )
        (local.set $i
          (f64.add (local.get $i) (f64.const 1))
        )
        (br $loop0)
      )
    )
    (local.set $samples
      (i32.wrap_i64
        (i64.reinterpret_f64
          (block
            (result f64)
            (local.set $tan1 (i32.const 21))
            (local.set $ta2
              (call $__alloc_hdr
                (i32.shl (local.get $tan1) (i32.const 3))
                (i32.shl (local.get $tan1) (i32.const 3))
                (i32.const 1)
              )
            )
            (f64.reinterpret_i64
              (i64.or
                (i64.const 9221120237041090560)
                (i64.or
                  (i64.const 422212465065984)
                  (i64.or
                    (i64.const 30064771072)
                    (i64.and
                      (i64.extend_i32_u (local.get $ta2))
                      (i64.const 0xFFFFFFFF)
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
    (local.set $i (f64.const 0))
    (block $brk3
      (loop $loop3
        (br_if $brk3
          (i32.eqz
            (f64.lt
              (local.get $i)
              (f64.convert_i32_s (i32.const 21))
            )
          )
        )
        (local.set $t0
          (call $__time_ms (i32.const 1))
        )
        (local.set $cs
          (f64.convert_i32_s
            (call $runKernel
              (local.get $a)
              (i32.const 2)
            )
          )
        )
        (f64.store
          (i32.add
            (local.get $samples)
            (i32.shl
              (i32.trunc_sat_f64_s (local.get $i))
              (i32.const 3)
            )
          )
          (f64.sub
            (call $__to_num
              (call $__time_ms (i32.const 1))
            )
            (call $__to_num (local.get $t0))
          )
        )
        (local.set $i
          (f64.add (local.get $i) (f64.const 1))
        )
        (br $loop3)
      )
    )
    (call $____lib_benchlib_js$printResult
      (call $____lib_benchlib_js$medianUs
        (f64.reinterpret_i64
          (i64.or
            (i64.const 0x7FF9800700000000)
            (i64.extend_i32_u (local.get $samples))
          )
        )
      )
      (local.get $cs)
      (f64.convert_i32_s (i32.const 524288))
      (f64.const 1)
      (f64.convert_i32_s (i32.const 21))
    ) drop
    (f64.const 0)
  )
  (func
    (export "_alloc")
    (param $bytes i32)
    (result i32)
    (call $__alloc (local.get $bytes))
  )
  (func
    (export "_reset")
    (global.set $__heap (i32.const 1024))
  )
)