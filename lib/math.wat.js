// Pure WASM Math stdlib - no JS imports required
// Using proven implementations from C stdlib and existing WASM projects
// 
// TODO: Current Taylor series approximations need more precision
// Better approach: Compile from musl C stdlib using:
//   clang --target=wasm32 -pipe -O3 -Wall -flto -c ./sin.c -o ./sin.o
//   llvm-lto ./sin.o -o ./sin.wasm --exported-symbol=sin
//   wasm2wat -f ./sin.wasm
// 
// Reference: https://gist.github.com/dy/4be96fc709ddf2db3c92fb3df691684e
// C stdlib: https://git.musl-libc.org/cgit/musl/tree/src/math
// 
// pow() implementation from: https://github.com/colorjs/color-space/blob/v3/test/wasm-perf.js#L8

export function mathStdLib() {
  return `
  ;; Constants as globals (watr supports f64 globals)
  (global $PI f64 (f64.const 3.141592653589793))
  (global $PI_2 f64 (f64.const 1.5707963267948966))
  (global $LN2 f64 (f64.const 0.6931471805599453))
  (global $LN10 f64 (f64.const 2.302585092994046))
  (global $E f64 (f64.const 2.718281828459045))

  ;; random() - constant for now
  (func $random (result f64)
    (f64.const 0.5)
  )

  ;; fract(x) - fractional part
  (func $fract (param $x f64) (result f64)
    (f64.sub (local.get $x) (f64.floor (local.get $x)))
  )

  ;; sign(x)
  (func $sign (param $x f64) (result f64)
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0))
      (then (f64.const 0.0))
      (else
        (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
          (then (f64.const 1.0))
          (else (f64.const -1.0))
        )
      )
    )
  )

  ;; round(x)
  (func $round (param $x f64) (result f64)
    (f64.nearest (local.get $x))
  )

  ;; fround(x) - no-op for f64
  (func $fround (param $x f64) (result f64)
    (local.get $x)
  )

  ;; pow(x,y) - Production-quality implementation from colorjs/color-space
  ;; Source: https://github.com/colorjs/color-space/blob/v3/test/wasm-perf.js#L8
  (func $pow (param f64 f64) (result f64)
    (local f64 i64 i64 i64 f64 f64 f64 f64 f64 f64)
    (local.set 2 (f64.const 0x1p+0))
    (block
      (br_if 0 (f64.eq (local.get 1) (f64.const 0x0p+0)))
      (local.set 3 (i64.const 0))
      (block
        (br_if 0 (i64.gt_s (i64.reinterpret_f64 (local.get 0)) (i64.const -1)))
        (br_if 0 (f64.ne (f64.nearest (local.get 1)) (local.get 1)))
        (local.set 3
          (i64.shl
            (i64.extend_i32_u
              (f64.ne
                (f64.nearest
                  (local.tee 2 (f64.mul (local.get 1) (f64.const 0x1p-1)))
                )
                (local.get 2)
              )
            )
            (i64.const 63)
          )
        )
        (local.set 0 (f64.neg (local.get 0)))
      )
      (local.set 2 (f64.const 0x1p+0))
      (block
        (br_if 0 (f64.eq (local.get 0) (f64.const 0x1p+0)))
        (block
          (br_if 0 (f64.ne (local.get 0) (f64.const 0x0p+0)))
          (local.set 2
            (select
              (f64.const inf)
              (f64.const 0x0p+0)
              (i64.lt_s (i64.reinterpret_f64 (local.get 1)) (i64.const 0))
            )
          )
          (br 1)
        )
        (block
          (br_if 0 (f64.ne (f64.abs (local.get 0)) (f64.const inf)))
          (local.set 2
            (select
              (f64.const 0x0p+0)
              (f64.const inf)
              (i64.lt_s (i64.reinterpret_f64 (local.get 1)) (i64.const 0))
            )
          )
          (br 1)
        )
        (block
          (br_if 0 (i64.ge_s (local.tee 4 (i64.reinterpret_f64 (local.get 0))) (i64.const 0)))
          (local.set 2 (f64.const nan))
          (br 1)
        )
        (block
          (br_if 0 (f64.ne (f64.abs (local.get 1)) (f64.const inf)))
          (local.set 2
            (select
              (f64.const inf)
              (f64.const 0x0p+0)
              (i32.eq
                (i32.wrap_i64
                  (i64.shr_u (i64.reinterpret_f64 (local.get 1)) (i64.const 63))
                )
                (f64.lt (local.get 0) (f64.const 0x1p+0))
              )
            )
          )
          (br 1)
        )
        (block
          (br_if 0 (i64.gt_u (local.get 4) (i64.const 4503599627370495)))
          (local.set 4
            (i64.sub
              (i64.shl
                (local.get 4)
                (local.tee 5 (i64.add (i64.clz (local.get 4)) (i64.const -11)))
              )
              (i64.shl (local.get 5) (i64.const 52))
            )
          )
        )
        (local.set 2 (f64.const inf))
        (br_if 0
          (f64.gt
            (local.tee 1
              (f64.add
                (local.tee 10
                  (f64.mul
                    (local.tee 6
                      (f64.reinterpret_i64
                        (i64.and (i64.reinterpret_f64 (local.get 1)) (i64.const -4294967296))
                      )
                    )
                    (local.tee 0
                      (f64.reinterpret_i64
                        (i64.and
                          (i64.reinterpret_f64
                            (f64.add
                              (f64.add
                                (local.tee 7
                                  (f64.mul
                                    (local.tee 0
                                      (f64.reinterpret_i64
                                        (i64.and
                                          (i64.reinterpret_f64
                                            (f64.add
                                              (local.tee 11
                                                (f64.mul
                                                  (local.tee 0
                                                    (f64.reinterpret_i64
                                                      (i64.and
                                                        (i64.reinterpret_f64
                                                          (local.tee 9
                                                            (f64.div
                                                              (local.tee 7
                                                                (f64.add
                                                                  (f64.reinterpret_i64
                                                                    (i64.sub
                                                                      (local.get 4)
                                                                      (i64.and
                                                                        (local.tee 5
                                                                          (i64.add
                                                                            (local.get 4)
                                                                            (i64.const -4604544271217802189)
                                                                          )
                                                                        )
                                                                        (i64.const -4503599627370496)
                                                                      )
                                                                    )
                                                                  )
                                                                  (f64.const -0x1p+0)
                                                                )
                                                              )
                                                              (local.tee 8
                                                                (f64.add (local.get 7) (f64.const 0x1p+1))
                                                              )
                                                            )
                                                          )
                                                        )
                                                        (i64.const -134217728)
                                                      )
                                                    )
                                                  )
                                                  (local.tee 0
                                                    (f64.reinterpret_i64
                                                      (i64.and
                                                        (i64.reinterpret_f64
                                                          (f64.add
                                                            (f64.add
                                                              (local.tee 10 (f64.mul (local.get 0) (local.get 0)))
                                                              (local.tee 8
                                                                (f64.add
                                                                  (f64.mul
                                                                    (local.tee 7
                                                                      (f64.div
                                                                        (f64.sub
                                                                          (f64.sub
                                                                            (local.get 7)
                                                                            (f64.mul
                                                                              (local.get 0)
                                                                              (local.tee 11
                                                                                (f64.reinterpret_i64
                                                                                  (i64.and
                                                                                    (i64.reinterpret_f64 (local.get 8))
                                                                                    (i64.const -4294967296)
                                                                                  )
                                                                                )
                                                                              )
                                                                            )
                                                                          )
                                                                          (f64.mul
                                                                            (local.get 0)
                                                                            (f64.add
                                                                              (local.get 7)
                                                                              (f64.sub (f64.const 0x1p+1) (local.get 11))
                                                                            )
                                                                          )
                                                                        )
                                                                        (local.get 8)
                                                                      )
                                                                    )
                                                                    (f64.add (local.get 9) (local.get 0))
                                                                  )
                                                                  (f64.mul
                                                                    (f64.mul
                                                                      (local.tee 0 (f64.mul (local.get 9) (local.get 9)))
                                                                      (local.get 0)
                                                                    )
                                                                    (f64.add
                                                                      (f64.mul
                                                                        (f64.add
                                                                          (f64.mul
                                                                            (f64.add
                                                                              (f64.mul
                                                                                (f64.add
                                                                                  (f64.mul
                                                                                    (f64.add
                                                                                      (f64.mul
                                                                                        (local.get 0)
                                                                                        (f64.const 0x1.91a4911cbce5ap-3)
                                                                                      )
                                                                                      (f64.const 0x1.97a897f8e6cap-3)
                                                                                    )
                                                                                    (local.get 0)
                                                                                  )
                                                                                  (f64.const 0x1.d8a9d6a7940bp-3)
                                                                                )
                                                                                (local.get 0)
                                                                              )
                                                                              (f64.const 0x1.1745bc213e72fp-2)
                                                                            )
                                                                            (local.get 0)
                                                                          )
                                                                          (f64.const 0x1.5555557cccac1p-2)
                                                                        )
                                                                        (local.get 0)
                                                                      )
                                                                      (f64.const 0x1.b6db6db6b8d5fp-2)
                                                                    )
                                                                  )
                                                                )
                                                              )
                                                            )
                                                            (f64.const 0x1.8p+1)
                                                          )
                                                        )
                                                        (i64.const -67108864)
                                                      )
                                                    )
                                                  )
                                                )
                                              )
                                              (local.tee 9
                                                (f64.add
                                                  (f64.mul (local.get 7) (local.get 0))
                                                  (f64.mul
                                                    (local.get 9)
                                                    (f64.add
                                                      (local.get 8)
                                                      (f64.add
                                                        (local.get 10)
                                                        (f64.sub (f64.const 0x1.8p+1) (local.get 0))
                                                      )
                                                    )
                                                  )
                                                )
                                              )
                                            )
                                          )
                                          (i64.const -4294967296)
                                        )
                                      )
                                    )
                                    (f64.const 0x1.ec709dc4p-1)
                                  )
                                )
                                (local.tee 9
                                  (f64.add
                                    (f64.mul (local.get 0) (f64.const -0x1.7f00a2d80faabp-35))
                                    (f64.mul
                                      (f64.add
                                        (local.get 9)
                                        (f64.sub (local.get 11) (local.get 0))
                                      )
                                      (f64.const 0x1.ec709dc3a03fdp-1)
                                    )
                                  )
                                )
                              )
                              (local.tee 8
                                (f64.convert_i64_s (i64.shr_s (local.get 5) (i64.const 52)))
                              )
                            )
                          )
                          (i64.const -2097152)
                        )
                      )
                    )
                  )
                )
                (local.tee 0
                  (f64.add
                    (f64.mul (f64.sub (local.get 1) (local.get 6)) (local.get 0))
                    (f64.mul
                      (f64.add
                        (local.get 9)
                        (f64.add (local.get 7) (f64.sub (local.get 8) (local.get 0)))
                      )
                      (local.get 1)
                    )
                  )
                )
              )
            )
            (f64.const 0x1p+10)
          )
        )
        (local.set 9 (f64.sub (local.get 1) (local.get 10)))
        (block
          (br_if 0 (f64.ne (local.get 1) (f64.const 0x1p+10)))
          (br_if 1 (f64.lt (local.get 9) (local.get 0)))
        )
        (local.set 2 (f64.const 0x0p+0))
        (br_if 0 (f64.lt (local.get 1) (f64.const -0x1.0ccp+10)))
        (block
          (br_if 0 (f64.ne (local.get 1) (f64.const -0x1.0ccp+10)))
          (br_if 1 (f64.gt (local.get 9) (local.get 0)))
        )
        (local.set 4
          (i64.reinterpret_f64
            (f64.add
              (f64.add
                (local.tee 8
                  (f64.mul
                    (local.tee 7
                      (f64.reinterpret_i64
                        (i64.and
                          (i64.reinterpret_f64
                            (local.tee 2
                              (f64.sub
                                (local.get 1)
                                (local.tee 9 (f64.nearest (local.get 1)))
                              )
                            )
                          )
                          (i64.const -4294967296)
                        )
                      )
                    )
                    (f64.const 0x1.62e42ffp-1)
                  )
                )
                (f64.add
                  (local.tee 2
                    (f64.add
                      (f64.mul (local.get 2) (f64.const -0x1.718432a1b0e26p-35))
                      (f64.mul
                        (f64.add
                          (local.get 0)
                          (f64.sub
                            (local.get 10)
                            (f64.add (local.get 9) (local.get 7))
                          )
                        )
                        (f64.const 0x1.62e42ffp-1)
                      )
                    )
                  )
                  (f64.div
                    (f64.mul
                      (local.tee 0 (f64.add (local.get 8) (local.get 2)))
                      (local.tee 2
                        (f64.sub
                          (local.get 0)
                          (f64.mul
                            (local.tee 2 (f64.mul (local.get 0) (local.get 0)))
                            (f64.add
                              (f64.mul
                                (local.get 2)
                                (f64.add
                                  (f64.mul
                                    (local.get 2)
                                    (f64.add
                                      (f64.mul
                                        (local.get 2)
                                        (f64.add
                                          (f64.mul
                                            (local.get 2)
                                            (f64.const 0x1.63f2a09c94b4cp-25)
                                          )
                                          (f64.const -0x1.bbd53273e8fb7p-20)
                                        )
                                      )
                                      (f64.const 0x1.1566ab5c2ba0dp-14)
                                    )
                                  )
                                  (f64.const -0x1.6c16c16c0ac3cp-9)
                                )
                              )
                              (f64.const 0x1.5555555555553p-3)
                            )
                          )
                        )
                      )
                    )
                    (f64.sub (f64.const 0x1p+1) (local.get 2))
                  )
                )
              )
              (f64.const 0x1p+0)
            )
          )
        )
        (block
          (block
            (br_if 0
              (i32.eqz (f64.lt (f64.abs (local.get 9)) (f64.const 0x1p+63)))
            )
            (local.set 5 (i64.trunc_f64_s (local.get 9)))
            (br 1)
          )
          (local.set 5 (i64.const -9223372036854775808))
        )
        (local.set 2
          (select
            (f64.mul
              (f64.reinterpret_i64
                (i64.add
                  (local.tee 4
                    (i64.add (i64.shl (local.get 5) (i64.const 52)) (local.get 4))
                  )
                  (i64.const 4593671619917905920)
                )
              )
              (f64.const 0x1p-1020)
            )
            (f64.reinterpret_i64 (local.get 4))
            (f64.lt (local.get 1) (f64.const -0x1.fep+9))
          )
        )
      )
    )
    (local.set 2 (f64.reinterpret_i64 (i64.or (local.get 3) (i64.reinterpret_f64 (local.get 2)))))
    (local.get 2)
  )

  ;; sin(x) - Taylor series with range reduction
  (func $sin (param $x f64) (result f64)
    (local $n i32)
    (local $r f64)
    (local $x2 f64)
    
    ;; Range reduction to [-pi, pi]
    (local.set $n (i32.trunc_f64_s (f64.div (local.get $x) (global.get $PI))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $n)) (global.get $PI))))
    
    ;; Further reduce to [-pi/2, pi/2]
    (if (f64.gt (local.get $r) (global.get $PI_2))
      (then
        (local.set $r (f64.sub (local.get $r) (global.get $PI)))
      )
    )
    (if (f64.lt (local.get $r) (f64.neg (global.get $PI_2)))
      (then
        (local.set $r (f64.add (local.get $r) (global.get $PI)))
      )
    )
    
    ;; Taylor series: sin(x) ≈ x - x³/6 + x⁵/120 - x⁷/5040
    (local.set $x2 (f64.mul (local.get $r) (local.get $r)))
    (f64.mul (local.get $r)
      (f64.sub (f64.const 1.0)
        (f64.mul (local.get $x2)
          (f64.sub (f64.const 0.16666666666666666)
            (f64.mul (local.get $x2)
              (f64.sub (f64.const 0.008333333333333333)
                (f64.mul (local.get $x2) (f64.const 0.0001984126984126984))
              )
            )
          )
        )
      )
    )
  )

  ;; cos(x) - Direct implementation
  (func $cos (param $x f64) (result f64)
    (local $n i32)
    (local $r f64)
    (local $x2 f64)
    
    ;; Range reduction to [-pi, pi]
    (local.set $n (i32.trunc_f64_s (f64.div (local.get $x) (global.get $PI))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $n)) (global.get $PI))))
    
    ;; Further reduce to [-pi/2, pi/2]
    (if (f64.gt (local.get $r) (global.get $PI_2))
      (then
        (local.set $r (f64.sub (local.get $r) (global.get $PI)))
      )
    )
    (if (f64.lt (local.get $r) (f64.neg (global.get $PI_2)))
      (then
        (local.set $r (f64.add (local.get $r) (global.get $PI)))
      )
    )
    
    ;; Taylor series: cos(x) ≈ 1 - x²/2 + x⁴/24 - x⁶/720
    (local.set $x2 (f64.mul (local.get $r) (local.get $r)))
    (f64.sub (f64.const 1.0)
      (f64.mul (local.get $x2)
        (f64.sub (f64.const 0.5)
          (f64.mul (local.get $x2)
            (f64.sub (f64.const 0.041666666666666664)
              (f64.mul (local.get $x2) (f64.const 0.001388888888888889))
            )
          )
        )
      )
    )
  )

  ;; tan(x)
  (func $tan (param $x f64) (result f64)
    (f64.div (call $sin (local.get $x)) (call $cos (local.get $x)))
  )

  ;; exp(x) - exponential using series for small x
  (func $exp (param $x f64) (result f64)
    (local $k i32)
    (local $t f64)
    (local $result f64)
    
    ;; Clamp extremes
    (if (result f64) (f64.gt (local.get $x) (f64.const 709.0))
      (then (f64.const 1.7976931348623157e+308))
      (else
        (if (result f64) (f64.lt (local.get $x) (f64.const -745.0))
          (then (f64.const 0.0))
          (else
            ;; exp(x) = 2^(x/ln2) approximation
            (local.set $k (i32.trunc_f64_s (f64.div (local.get $x) (global.get $LN2))))
            (local.set $t (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $k)) (global.get $LN2))))
            
            ;; Taylor for small t: exp(t) ≈ 1 + t + t²/2 + t³/6
            (local.set $result 
              (f64.add (f64.const 1.0)
                (f64.add (local.get $t)
                  (f64.add 
                    (f64.mul (f64.const 0.5) (f64.mul (local.get $t) (local.get $t)))
                    (f64.mul (f64.const 0.16666666666666666) 
                      (f64.mul (local.get $t) (f64.mul (local.get $t) (local.get $t))))
                  )
                )
              )
            )
            
            ;; Scale by 2^k using repeated multiplication
            (if (result f64) (i32.gt_s (local.get $k) (i32.const 0))
              (then 
                (f64.mul (local.get $result) 
                  (call $exp_pow2 (local.get $k)))
              )
              (else
                (if (result f64) (i32.lt_s (local.get $k) (i32.const 0))
                  (then
                    (f64.div (local.get $result)
                      (call $exp_pow2 (i32.sub (i32.const 0) (local.get $k))))
                  )
                  (else (local.get $result))
                )
              )
            )
          )
        )
      )
    )
  )

  ;; Helper: compute 2^k for small positive k
  (func $exp_pow2 (param $k i32) (result f64)
    (local $result f64)
    (local.set $result (f64.const 1.0))
    (loop $loop
      (if (i32.gt_s (local.get $k) (i32.const 0))
        (then
          (local.set $result (f64.mul (local.get $result) (f64.const 2.0)))
          (local.set $k (i32.sub (local.get $k) (i32.const 1)))
          (br $loop)
        )
      )
    )
    (local.get $result)
  )

  ;; log(x) - natural logarithm
  (func $log (param $x f64) (result f64)
    (local $s f64)
    (local $z f64)
    
    (if (result f64) (f64.le (local.get $x) (f64.const 0.0))
      (then (f64.const 0.0))
      (else
        (if (result f64) (f64.eq (local.get $x) (f64.const 1.0))
          (then (f64.const 0.0))
          (else
            ;; log(x) ≈ 2*s where s = (x-1)/(x+1)
            (local.set $s (f64.div 
              (f64.sub (local.get $x) (f64.const 1.0))
              (f64.add (local.get $x) (f64.const 1.0))
            ))
            (local.set $z (f64.mul (local.get $s) (local.get $s)))
            
            ;; Series: 2s(1 + z/3 + z²/5 + ...)
            (f64.mul (f64.const 2.0)
              (f64.mul (local.get $s)
                (f64.add (f64.const 1.0)
                  (f64.mul (local.get $z)
                    (f64.add (f64.const 0.3333333333333333)
                      (f64.mul (local.get $z) (f64.const 0.2))
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

  ;; log2(x)
  (func $log2 (param $x f64) (result f64)
    (f64.div (call $log (local.get $x)) (global.get $LN2))
  )

  ;; log10(x)
  (func $log10 (param $x f64) (result f64)
    (f64.div (call $log (local.get $x)) (global.get $LN10))
  )

  ;; Hyperbolic functions
  (func $sinh (param $x f64) (result f64)
    (local $ex f64)
    (local.set $ex (call $exp (f64.abs (local.get $x))))
    (local.set $ex (f64.mul (f64.const 0.5)
      (f64.sub (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))
    ))
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0))
      (then (f64.neg (local.get $ex)))
      (else (local.get $ex))
    )
  )

  (func $cosh (param $x f64) (result f64)
    (local $ex f64)
    (local.set $ex (call $exp (f64.abs (local.get $x))))
    (f64.mul (f64.const 0.5)
      (f64.add (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))
    )
  )

  (func $tanh (param $x f64) (result f64)
    (local $e2x f64)
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 22.0))
      (then
        (if (result f64) (f64.lt (local.get $x) (f64.const 0.0))
          (then (f64.const -1.0))
          (else (f64.const 1.0))
        )
      )
      (else
        (local.set $e2x (call $exp (f64.mul (f64.const 2.0) (f64.abs (local.get $x)))))
        (local.set $e2x (f64.div 
          (f64.sub (local.get $e2x) (f64.const 1.0))
          (f64.add (local.get $e2x) (f64.const 1.0))
        ))
        (if (result f64) (f64.lt (local.get $x) (f64.const 0.0))
          (then (f64.neg (local.get $e2x)))
          (else (local.get $e2x))
        )
      )
    )
  )

  ;; Inverse trig
  (func $atan (param $x f64) (result f64)
    (local $x2 f64)
    (local $abs_x f64)
    
    (local.set $abs_x (f64.abs (local.get $x)))
    
    (if (result f64) (f64.gt (local.get $abs_x) (f64.const 1.0))
      (then
        ;; atan(x) = π/2 - atan(1/x) for |x| > 1
        (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
          (then
            (f64.sub (global.get $PI_2) (call $atan (f64.div (f64.const 1.0) (local.get $x))))
          )
          (else
            (f64.add (f64.neg (global.get $PI_2)) (call $atan (f64.div (f64.const 1.0) (local.get $x))))
          )
        )
      )
      (else
        ;; Taylor: atan(x) ≈ x - x³/3 + x⁵/5 - x⁷/7 + x⁹/9
        (local.set $x2 (f64.mul (local.get $x) (local.get $x)))
        (f64.mul (local.get $x)
          (f64.sub (f64.const 1.0)
            (f64.mul (local.get $x2)
              (f64.sub (f64.const 0.3333333333333333)
                (f64.mul (local.get $x2)
                  (f64.sub (f64.const 0.2)
                    (f64.mul (local.get $x2)
                      (f64.sub (f64.const 0.14285714285714285)
                        (f64.mul (local.get $x2) (f64.const 0.1111111111111111))
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

  (func $asin (param $x f64) (result f64)
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 1.0))
      (then (f64.const 0.0))
      (else
        (if (result f64) (f64.lt (f64.abs (local.get $x)) (f64.const 0.5))
          (then
            ;; asin(x) ≈ x + x³/6 for small x
            (f64.add (local.get $x)
              (f64.mul (f64.const 0.16666666666666666)
                (f64.mul (local.get $x) (f64.mul (local.get $x) (local.get $x)))
              )
            )
          )
          (else
            ;; asin(x) = atan(x / sqrt(1-x²))
            (call $atan 
              (f64.div (local.get $x)
                (f64.sqrt (f64.sub (f64.const 1.0) 
                  (f64.mul (local.get $x) (local.get $x))
                ))
              )
            )
          )
        )
      )
    )
  )

  (func $acos (param $x f64) (result f64)
    (f64.sub (global.get $PI_2) (call $asin (local.get $x)))
  )

  (func $atan2 (param $y f64) (param $x f64) (result f64)
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0))
      (then
        (if (result f64) (f64.eq (local.get $y) (f64.const 0.0))
          (then (f64.const 0.0))
          (else
            (if (result f64) (f64.gt (local.get $y) (f64.const 0.0))
              (then (global.get $PI_2))
              (else (f64.neg (global.get $PI_2)))
            )
          )
        )
      )
      (else
        (if (result f64) (f64.ge (local.get $x) (f64.const 0.0))
          (then
            (call $atan (f64.div (local.get $y) (local.get $x)))
          )
          (else
            (if (result f64) (f64.ge (local.get $y) (f64.const 0.0))
              (then
                (f64.add (call $atan (f64.div (local.get $y) (local.get $x))) (global.get $PI))
              )
              (else
                (f64.sub (call $atan (f64.div (local.get $y) (local.get $x))) (global.get $PI))
              )
            )
          )
        )
      )
    )
  )

  ;; Inverse hyperbolic
  (func $asinh (param $x f64) (result f64)
    (call $log (f64.add (local.get $x)
      (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0)))
    ))
  )

  (func $acosh (param $x f64) (result f64)
    (if (result f64) (f64.lt (local.get $x) (f64.const 1.0))
      (then (f64.const 0.0))
      (else
        (call $log (f64.add (local.get $x)
          (f64.sqrt (f64.sub (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0)))
        ))
      )
    )
  )

  (func $atanh (param $x f64) (result f64)
    (f64.mul (f64.const 0.5)
      (call $log (f64.div
        (f64.add (f64.const 1.0) (local.get $x))
        (f64.sub (f64.const 1.0) (local.get $x))
      ))
    )
  )

  ;; Additional functions
  (func $cbrt (param $x f64) (result f64)
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0))
      (then (f64.neg (call $cbrt (f64.neg (local.get $x)))))
      (else (call $pow (local.get $x) (f64.const 0.3333333333333333)))
    )
  )

  (func $hypot (param $x f64) (param $y f64) (result f64)
    (f64.sqrt (f64.add
      (f64.mul (local.get $x) (local.get $x))
      (f64.mul (local.get $y) (local.get $y))
    ))
  )

  (func $expm1 (param $x f64) (result f64)
    (f64.sub (call $exp (local.get $x)) (f64.const 1.0))
  )

  (func $log1p (param $x f64) (result f64)
    (call $log (f64.add (f64.const 1.0) (local.get $x)))
  )
`;
}
