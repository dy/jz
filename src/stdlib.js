// Pure WASM Math stdlib - no JS imports required
// Individual functions exported for on-demand inclusion
//
// TODO: Compile from musl C stdlib for production-quality implementations
// Reference: https://gist.github.com/dy/4be96fc709ddf2db3c92fb3df691684e

// Global constants (always included if any math function is used)
export const CONSTANTS = `
  (global $PI f64 (f64.const 3.141592653589793))
  (global $PI_2 f64 (f64.const 1.5707963267948966))
  (global $LN2 f64 (f64.const 0.6931471805599453))
  (global $LN10 f64 (f64.const 2.302585092994046))
  (global $E f64 (f64.const 2.718281828459045))
  (global $SQRT2 f64 (f64.const 1.4142135623730951))
  (global $SQRT1_2 f64 (f64.const 0.7071067811865476))
  (global $LOG2E f64 (f64.const 1.4426950408889634))
  (global $LOG10E f64 (f64.const 0.4342944819032518))
  (global $rng_state (mut i32) (i32.const 12345))
`

// Individual math function implementations - included on demand
export const FUNCTIONS = {
  sign: `(func $sign (param $x f64) (result f64)
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0))
      (then (f64.const 0.0))
      (else (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
        (then (f64.const 1.0))
        (else (f64.const -1.0))))))`,

  round: `(func $round (param $x f64) (result f64) (f64.nearest (local.get $x)))`,

  fround: `(func $fround (param $x f64) (result f64) (f64.promote_f32 (f32.demote_f64 (local.get $x))))`,

  // f16round: no native f16 in WASM yet, approximate via f32 (loses some precision)
  f16round: `(func $f16round (param $x f64) (result f64) (f64.promote_f32 (f32.demote_f64 (local.get $x))))`,

  pow: `(func $pow (param $x f64) (param $y f64) (result f64)
    (local $result f64) (local $n i32) (local $neg_base i32) (local $abs_x f64)
    (if (result f64) (f64.eq (local.get $y) (f64.const 0.0))
      (then (f64.const 1.0))
      (else (if (result f64) (f64.eq (local.get $x) (f64.const 0.0))
        (then (f64.const 0.0))
        (else (if (result f64) (f64.eq (local.get $x) (f64.const 1.0))
          (then (f64.const 1.0))
          (else (if (result f64) (f64.eq (local.get $y) (f64.const 1.0))
            (then (local.get $x))
            (else
              (if (result f64)
                (i32.and
                  (f64.eq (f64.nearest (local.get $y)) (local.get $y))
                  (f64.le (f64.abs (local.get $y)) (f64.const 100.0)))
                (then
                  (local.set $abs_x (f64.abs (local.get $x)))
                  (local.set $neg_base (i32.and (f64.lt (local.get $x) (f64.const 0.0))
                                                (i32.and (i32.trunc_f64_s (local.get $y)) (i32.const 1))))
                  (local.set $n (i32.trunc_f64_s (f64.abs (local.get $y))))
                  (local.set $result (f64.const 1.0))
                  (block $done
                    (loop $loop
                      (br_if $done (i32.le_s (local.get $n) (i32.const 0)))
                      (if (i32.and (local.get $n) (i32.const 1))
                        (then (local.set $result (f64.mul (local.get $result) (local.get $abs_x)))))
                      (local.set $abs_x (f64.mul (local.get $abs_x) (local.get $abs_x)))
                      (local.set $n (i32.shr_s (local.get $n) (i32.const 1)))
                      (br $loop)))
                  (if (f64.lt (local.get $y) (f64.const 0.0))
                    (then (local.set $result (f64.div (f64.const 1.0) (local.get $result)))))
                  (if (local.get $neg_base)
                    (then (local.set $result (f64.neg (local.get $result)))))
                  (local.get $result))
                (else
                  (if (result f64) (f64.lt (local.get $x) (f64.const 0.0))
                    (then (f64.const 0.0))
                    (else (call $exp (f64.mul (local.get $y) (call $log (local.get $x)))))))))))))))))`,

  sin: `(func $sin (param $x f64) (result f64)
    (local $n i32) (local $r f64) (local $x2 f64) (local $sign f64)
    (local.set $sign (f64.const 1.0))
    (local.set $n (i32.trunc_f64_s (f64.floor (f64.div (local.get $x) (global.get $PI)))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $n)) (global.get $PI))))
    (if (i32.and (local.get $n) (i32.const 1)) (then (local.set $sign (f64.const -1.0))))
    (if (f64.gt (local.get $r) (global.get $PI_2)) (then (local.set $r (f64.sub (global.get $PI) (local.get $r)))))
    (if (f64.lt (local.get $r) (f64.const 0.0)) (then
      (local.set $r (f64.neg (local.get $r)))
      (local.set $sign (f64.neg (local.get $sign)))))
    (local.set $x2 (f64.mul (local.get $r) (local.get $r)))
    (f64.mul (local.get $sign) (f64.mul (local.get $r) (f64.sub (f64.const 1.0) (f64.mul (local.get $x2)
      (f64.sub (f64.const 0.16666666666666666) (f64.mul (local.get $x2)
        (f64.sub (f64.const 0.008333333333333333) (f64.mul (local.get $x2)
          (f64.sub (f64.const 0.0001984126984126984) (f64.mul (local.get $x2)
            (f64.sub (f64.const 0.0000027557319223985893) (f64.mul (local.get $x2)
              (f64.const 2.505210838544172e-8))))))))))))))`,

  cos: `(func $cos (param $x f64) (result f64)
    (local $n i32) (local $r f64) (local $x2 f64) (local $sign f64)
    (local.set $sign (f64.const 1.0))
    (local.set $n (i32.trunc_f64_s (f64.floor (f64.div (local.get $x) (global.get $PI)))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $n)) (global.get $PI))))
    (if (i32.and (local.get $n) (i32.const 1)) (then (local.set $sign (f64.const -1.0))))
    (if (f64.gt (local.get $r) (global.get $PI_2)) (then
      (local.set $r (f64.sub (global.get $PI) (local.get $r)))
      (local.set $sign (f64.neg (local.get $sign)))))
    (if (f64.lt (local.get $r) (f64.const 0.0)) (then (local.set $r (f64.neg (local.get $r)))))
    (local.set $x2 (f64.mul (local.get $r) (local.get $r)))
    (f64.mul (local.get $sign) (f64.sub (f64.const 1.0) (f64.mul (local.get $x2)
      (f64.sub (f64.const 0.5) (f64.mul (local.get $x2)
        (f64.sub (f64.const 0.041666666666666664) (f64.mul (local.get $x2)
          (f64.sub (f64.const 0.001388888888888889) (f64.mul (local.get $x2)
            (f64.sub (f64.const 0.0000248015873015873) (f64.mul (local.get $x2)
              (f64.const 2.7557319223985893e-7)))))))))))))`,

  tan: `(func $tan (param $x f64) (result f64)
    (f64.div (call $sin (local.get $x)) (call $cos (local.get $x))))`,

  exp: `(func $exp (param $x f64) (result f64)
    (local $k i32) (local $t f64) (local $t2 f64) (local $result f64)
    (if (result f64) (f64.gt (local.get $x) (f64.const 709.0)) (then (f64.const 1.7976931348623157e+308)) (else
      (if (result f64) (f64.lt (local.get $x) (f64.const -745.0)) (then (f64.const 0.0)) (else
        (local.set $k (i32.trunc_f64_s (f64.div (local.get $x) (global.get $LN2))))
        (local.set $t (f64.sub (local.get $x) (f64.mul (f64.convert_i32_s (local.get $k)) (global.get $LN2))))
        (local.set $t2 (f64.mul (local.get $t) (local.get $t)))
        (local.set $result (f64.add (f64.const 1.0) (f64.add (local.get $t)
          (f64.mul (local.get $t2) (f64.add (f64.const 0.5)
            (f64.mul (local.get $t) (f64.add (f64.const 0.16666666666666666)
              (f64.mul (local.get $t) (f64.add (f64.const 0.041666666666666664)
                (f64.mul (local.get $t) (f64.add (f64.const 0.008333333333333333)
                  (f64.mul (local.get $t) (f64.const 0.001388888888888889)))))))))))))
        (if (result f64) (i32.gt_s (local.get $k) (i32.const 0))
          (then (f64.mul (local.get $result) (call $exp_pow2 (local.get $k))))
          (else (if (result f64) (i32.lt_s (local.get $k) (i32.const 0))
            (then (f64.div (local.get $result) (call $exp_pow2 (i32.sub (i32.const 0) (local.get $k)))))
            (else (local.get $result))))))))))`,

  exp_pow2: `(func $exp_pow2 (param $k i32) (result f64)
    (local $result f64) (local.set $result (f64.const 1.0))
    (loop $loop (if (i32.gt_s (local.get $k) (i32.const 0)) (then
      (local.set $result (f64.mul (local.get $result) (f64.const 2.0)))
      (local.set $k (i32.sub (local.get $k) (i32.const 1))) (br $loop))))
    (local.get $result))`,

  log: `(func $log (param $x f64) (result f64)
    (local $k i32) (local $y f64) (local $s f64) (local $z f64)
    (if (f64.le (local.get $x) (f64.const 0.0))
      (then (return (f64.const 0.0))))
    (if (f64.eq (local.get $x) (f64.const 1.0))
      (then (return (f64.const 0.0))))
    (local.set $k (i32.const 0))
    (local.set $y (local.get $x))
    (block $done_up
      (loop $scale_up
        (br_if $done_up (f64.lt (local.get $y) (f64.const 2.0)))
        (local.set $y (f64.mul (local.get $y) (f64.const 0.5)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $scale_up)))
    (block $done_down
      (loop $scale_down
        (br_if $done_down (f64.ge (local.get $y) (f64.const 1.0)))
        (local.set $y (f64.mul (local.get $y) (f64.const 2.0)))
        (local.set $k (i32.sub (local.get $k) (i32.const 1)))
        (br $scale_down)))
    (local.set $s (f64.div (f64.sub (local.get $y) (f64.const 1.0)) (f64.add (local.get $y) (f64.const 1.0))))
    (local.set $z (f64.mul (local.get $s) (local.get $s)))
    (f64.add
      (f64.mul (f64.convert_i32_s (local.get $k)) (global.get $LN2))
      (f64.mul (f64.const 2.0) (f64.mul (local.get $s) (f64.add (f64.const 1.0)
        (f64.mul (local.get $z) (f64.add (f64.const 0.3333333333333333)
          (f64.mul (local.get $z) (f64.add (f64.const 0.2)
            (f64.mul (local.get $z) (f64.add (f64.const 0.14285714285714285)
              (f64.mul (local.get $z) (f64.add (f64.const 0.1111111111111111)
                (f64.mul (local.get $z) (f64.const 0.09090909090909091)))))))))))))))`,

  log2: `(func $log2 (param $x f64) (result f64) (f64.div (call $log (local.get $x)) (global.get $LN2)))`,
  log10: `(func $log10 (param $x f64) (result f64) (f64.div (call $log (local.get $x)) (global.get $LN10)))`,

  sinh: `(func $sinh (param $x f64) (result f64)
    (local $ex f64)
    (local.set $ex (call $exp (f64.abs (local.get $x))))
    (local.set $ex (f64.mul (f64.const 0.5) (f64.sub (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $ex))) (else (local.get $ex))))`,

  cosh: `(func $cosh (param $x f64) (result f64)
    (local $ex f64) (local.set $ex (call $exp (f64.abs (local.get $x))))
    (f64.mul (f64.const 0.5) (f64.add (local.get $ex) (f64.div (f64.const 1.0) (local.get $ex)))))`,

  tanh: `(func $tanh (param $x f64) (result f64)
    (local $e2x f64)
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 22.0))
      (then (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.const -1.0)) (else (f64.const 1.0))))
      (else (local.set $e2x (call $exp (f64.mul (f64.const 2.0) (f64.abs (local.get $x)))))
        (local.set $e2x (f64.div (f64.sub (local.get $e2x) (f64.const 1.0)) (f64.add (local.get $e2x) (f64.const 1.0))))
        (if (result f64) (f64.lt (local.get $x) (f64.const 0.0)) (then (f64.neg (local.get $e2x))) (else (local.get $e2x))))))`,

  atan: `(func $atan (param $x f64) (result f64)
    (local $x2 f64) (local $abs_x f64) (local $reduced f64)
    (local.set $abs_x (f64.abs (local.get $x)))
    (if (result f64) (f64.gt (local.get $abs_x) (f64.const 1.0))
      (then
        (if (result f64) (f64.gt (local.get $x) (f64.const 0.0))
          (then (f64.sub (global.get $PI_2) (call $atan (f64.div (f64.const 1.0) (local.get $x)))))
          (else (f64.add (f64.neg (global.get $PI_2)) (call $atan (f64.div (f64.const 1.0) (local.get $x)))))))
      (else
        (if (result f64) (f64.gt (local.get $abs_x) (f64.const 0.5))
          (then
            (local.set $reduced (f64.div (local.get $x) (f64.add (f64.const 1.0) (f64.sqrt (f64.add (f64.const 1.0) (f64.mul (local.get $x) (local.get $x)))))))
            (f64.mul (f64.const 2.0) (call $atan (local.get $reduced))))
          (else
            (local.set $x2 (f64.mul (local.get $x) (local.get $x)))
            (f64.mul (local.get $x)
              (f64.sub (f64.const 1.0)
                (f64.mul (local.get $x2)
                  (f64.sub (f64.const 0.3333333333333333)
                    (f64.mul (local.get $x2)
                      (f64.sub (f64.const 0.2)
                        (f64.mul (local.get $x2)
                          (f64.sub (f64.const 0.14285714285714285)
                            (f64.mul (local.get $x2)
                              (f64.sub (f64.const 0.1111111111111111)
                                (f64.mul (local.get $x2)
                                  (f64.sub (f64.const 0.09090909090909091)
                                    (f64.mul (local.get $x2) (f64.const 0.07692307692307693)))))))))))))))))))`,

  asin: `(func $asin (param $x f64) (result f64)
    (if (result f64) (f64.gt (f64.abs (local.get $x)) (f64.const 1.0))
      (then (f64.const 0.0))
      (else (call $atan (f64.div (local.get $x)
        (f64.sqrt (f64.sub (f64.const 1.0) (f64.mul (local.get $x) (local.get $x)))))))))`,

  acos: `(func $acos (param $x f64) (result f64) (f64.sub (global.get $PI_2) (call $asin (local.get $x))))`,

  atan2: `(func $atan2 (param $y f64) (param $x f64) (result f64)
    (if (result f64) (f64.eq (local.get $x) (f64.const 0.0)) (then
      (if (result f64) (f64.eq (local.get $y) (f64.const 0.0)) (then (f64.const 0.0)) (else
        (if (result f64) (f64.gt (local.get $y) (f64.const 0.0)) (then (global.get $PI_2)) (else (f64.neg (global.get $PI_2)))))))
      (else (if (result f64) (f64.ge (local.get $x) (f64.const 0.0))
        (then (call $atan (f64.div (local.get $y) (local.get $x))))
        (else (if (result f64) (f64.ge (local.get $y) (f64.const 0.0))
          (then (f64.add (call $atan (f64.div (local.get $y) (local.get $x))) (global.get $PI)))
          (else (f64.sub (call $atan (f64.div (local.get $y) (local.get $x))) (global.get $PI)))))))))`,

  asinh: `(func $asinh (param $x f64) (result f64)
    (call $log (f64.add (local.get $x) (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))`,

  acosh: `(func $acosh (param $x f64) (result f64)
    (if (result f64) (f64.lt (local.get $x) (f64.const 1.0)) (then (f64.const 0.0)) (else
      (call $log (f64.add (local.get $x) (f64.sqrt (f64.sub (f64.mul (local.get $x) (local.get $x)) (f64.const 1.0))))))))`,

  atanh: `(func $atanh (param $x f64) (result f64)
    (f64.mul (f64.const 0.5) (call $log (f64.div (f64.add (f64.const 1.0) (local.get $x)) (f64.sub (f64.const 1.0) (local.get $x))))))`,

  cbrt: `(func $cbrt (param $x f64) (result f64)
    (if (result f64) (f64.lt (local.get $x) (f64.const 0.0))
      (then (f64.neg (call $cbrt (f64.neg (local.get $x)))))
      (else (call $pow (local.get $x) (f64.const 0.3333333333333333)))))`,

  hypot: `(func $hypot (param $x f64) (param $y f64) (result f64)
    (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.mul (local.get $y) (local.get $y)))))`,

  expm1: `(func $expm1 (param $x f64) (result f64) (f64.sub (call $exp (local.get $x)) (f64.const 1.0)))`,
  log1p: `(func $log1p (param $x f64) (result f64) (call $log (f64.add (f64.const 1.0) (local.get $x))))`,

  min: `(func $min (param $a f64) (param $b f64) (result f64) (f64.min (local.get $a) (local.get $b)))`,
  max: `(func $max (param $a f64) (param $b f64) (result f64) (f64.max (local.get $a) (local.get $b)))`,

  clz32: `(func $clz32 (param $x f64) (result f64)
    (f64.convert_i32_u (i32.clz (i32.trunc_f64_s (local.get $x)))))`,

  imul: `(func $imul (param $a f64) (param $b f64) (result f64)
    (f64.convert_i32_s (i32.mul (i32.trunc_f64_s (local.get $a)) (i32.trunc_f64_s (local.get $b)))))`,

  isNaN: `(func $isNaN (param $x f64) (result f64)
    (if (result f64) (f64.ne (local.get $x) (local.get $x)) (then (f64.const 1.0)) (else (f64.const 0.0))))`,

  isFinite: `(func $isFinite (param $x f64) (result f64)
    (if (result f64) (f64.eq (f64.sub (local.get $x) (local.get $x)) (f64.const 0.0))
      (then (f64.const 1.0)) (else (f64.const 0.0))))`,

  isInteger: `(func $isInteger (param $x f64) (result f64)
    (if (result f64) (i32.and
        (f64.eq (local.get $x) (local.get $x))  ;; not NaN
        (i32.and
          (f64.ne (f64.abs (local.get $x)) (f64.const inf))  ;; finite
          (f64.eq (f64.trunc (local.get $x)) (local.get $x))))  ;; integer
      (then (f64.const 1.0)) (else (f64.const 0.0))))`,

  random: `(func $random (result f64)
    (local $s i32)
    (local.set $s (global.get $rng_state))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))
    (local.set $s (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 17))))
    (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 5))))
    (global.set $rng_state (local.get $s))
    (f64.div (f64.convert_i32_u (i32.and (local.get $s) (i32.const 0x7FFFFFFF))) (f64.const 2147483647.0)))`,

  // parseInt from char code (0-9, a-z, A-Z) - common floatbeat pattern
  // Input: char code (i32), radix (i32)
  // Returns: f64 value or NaN if invalid
  parseIntFromCode: `(func $parseIntFromCode (param $code i32) (param $radix i32) (result f64)
    (local $digit i32)
    ;; '0'-'9' = 48-57 → 0-9
    (if (i32.and (i32.ge_s (local.get $code) (i32.const 48))
                 (i32.le_s (local.get $code) (i32.const 57)))
      (then (local.set $digit (i32.sub (local.get $code) (i32.const 48))))
    ;; 'A'-'Z' = 65-90 → 10-35
    (else (if (i32.and (i32.ge_s (local.get $code) (i32.const 65))
                       (i32.le_s (local.get $code) (i32.const 90)))
      (then (local.set $digit (i32.sub (local.get $code) (i32.const 55))))
    ;; 'a'-'z' = 97-122 → 10-35
    (else (if (i32.and (i32.ge_s (local.get $code) (i32.const 97))
                       (i32.le_s (local.get $code) (i32.const 122)))
      (then (local.set $digit (i32.sub (local.get $code) (i32.const 87))))
    ;; Invalid char
    (else (return (f64.const nan))))))))
    ;; Check if digit is valid for this radix
    (if (i32.ge_s (local.get $digit) (local.get $radix))
      (then (return (f64.const nan))))
    (f64.convert_i32_s (local.get $digit)))`,

  // parseInt from string (first char only for now)
  // Input: string ptr (f64, packed as type+len+offset), radix (i32)
  // Returns: f64 value or NaN
  // Memory layout: i16 code units at offset
  parseInt: `(func $parseInt (param $str f64) (param $radix i32) (result f64)
    (local $code i32) (local $len i32)
    (local.set $len (call $__str_len (local.get $str)))
    (if (i32.eq (local.get $len) (i32.const 0))
      (then (return (f64.const nan))))
    ;; Get first character code (SSO-aware)
    (local.set $code (call $__str_char_at (local.get $str) (i32.const 0)))
    (call $parseIntFromCode (local.get $code) (local.get $radix)))`,

  // Array.fill - fill array with value, returns the array
  // Memory-based: f64 array stored as sequential f64 values at pointer offset
  arrayFill: `(func $arrayFill (param $arr f64) (param $val f64) (result f64)
    (local $i i32) (local $len i32)
    (local.set $len (call $__ptr_len (local.get $arr)))
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (f64.store (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $i) (i32.const 3))) (local.get $val))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $arr))`,

  // numToString - convert f64 to string pointer
  // Handles: integers, decimals, NaN, Infinity, negative numbers
  // Max 24 chars output (enough for any f64)
  numToString: `(func $numToString (param $x f64) (result f64)
    (local $str f64) (local $offset i32) (local $len i32)
    (local $neg i32) (local $intPart i64) (local $fracPart f64)
    (local $digit i32) (local $i i32) (local $j i32) (local $k i32)
    (local $temp i32) (local $buf i32) (local $hasDecimal i32)
    (local $intLen i32) (local $fracLen i32) (local $totalLen i32)
    (local $abs f64)
    ;; Handle NaN (STRING=3)
    (if (f64.ne (local.get $x) (local.get $x))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNaN)))))
    ;; Handle Infinity
    (if (f64.eq (local.get $x) (f64.const inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strInf)))))
    (if (f64.eq (local.get $x) (f64.const -inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNegInf)))))
    ;; Handle negative
    (local.set $neg (f64.lt (local.get $x) (f64.const 0)))
    (local.set $abs (f64.abs (local.get $x)))
    ;; Get integer and fractional parts
    (local.set $intPart (i64.trunc_f64_s (f64.floor (local.get $abs))))
    (local.set $fracPart (f64.sub (local.get $abs) (f64.floor (local.get $abs))))
    ;; Use fixed temp buffer at end of instance table area for digit extraction
    ;; 48 bytes at offset 65480-65528 (before string interning at 65536)
    (local.set $buf (i32.const 65480))
    ;; Extract integer digits (reversed)
    (local.set $intLen (i32.const 0))
    (if (i64.eqz (local.get $intPart))
      (then
        (i32.store8 (local.get $buf) (i32.const 48))
        (local.set $intLen (i32.const 1)))
      (else
        (loop $int_loop
          (if (i64.gt_u (local.get $intPart) (i64.const 0))
            (then
              (local.set $digit (i32.wrap_i64 (i64.rem_u (local.get $intPart) (i64.const 10))))
              (i32.store8 (i32.add (local.get $buf) (local.get $intLen)) (i32.add (i32.const 48) (local.get $digit)))
              (local.set $intLen (i32.add (local.get $intLen) (i32.const 1)))
              (local.set $intPart (i64.div_u (local.get $intPart) (i64.const 10)))
              (br $int_loop))))))
    ;; Extract fractional digits (max 15 to avoid floating point noise)
    (local.set $fracLen (i32.const 0))
    (local.set $hasDecimal (i32.const 0))
    (if (f64.gt (local.get $fracPart) (f64.const 0))
      (then
        (local.set $hasDecimal (i32.const 1))
        (local.set $k (i32.const 0))
        (block $frac_done
          (loop $frac_loop
            (br_if $frac_done (i32.ge_s (local.get $k) (i32.const 15)))
            (local.set $fracPart (f64.mul (local.get $fracPart) (f64.const 10)))
            (local.set $digit (i32.trunc_f64_s (f64.floor (local.get $fracPart))))
            (local.set $fracPart (f64.sub (local.get $fracPart) (f64.floor (local.get $fracPart))))
            (i32.store8 (i32.add (i32.add (local.get $buf) (i32.const 32)) (local.get $fracLen)) (i32.add (i32.const 48) (local.get $digit)))
            (local.set $fracLen (i32.add (local.get $fracLen) (i32.const 1)))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br_if $frac_done (f64.lt (local.get $fracPart) (f64.const 1e-15)))
            (br $frac_loop)))))
    ;; Trim trailing zeros from fraction
    (block $trim_done
      (loop $trim_loop
        (br_if $trim_done (i32.le_s (local.get $fracLen) (i32.const 0)))
        (br_if $trim_done (i32.ne (i32.load8_u (i32.add (i32.add (local.get $buf) (i32.const 32)) (i32.sub (local.get $fracLen) (i32.const 1)))) (i32.const 48)))
        (local.set $fracLen (i32.sub (local.get $fracLen) (i32.const 1)))
        (br $trim_loop)))
    (if (i32.eqz (local.get $fracLen))
      (then (local.set $hasDecimal (i32.const 0))))
    ;; Calculate total length
    (local.set $totalLen (local.get $intLen))
    (if (local.get $neg)
      (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.const 1)))))
    (if (local.get $hasDecimal)
      (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.add (i32.const 1) (local.get $fracLen))))))
    ;; Allocate result string (STRING=3)
    (local.set $str (call $__alloc (i32.const 3) (local.get $totalLen)))
    (local.set $offset (call $__ptr_offset (local.get $str)))
    (local.set $i (i32.const 0))
    ;; Write minus sign
    (if (local.get $neg)
      (then
        (i32.store16 (local.get $offset) (i32.const 45))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    ;; Write integer digits (reverse order)
    (local.set $j (i32.sub (local.get $intLen) (i32.const 1)))
    (block $write_int_done
      (loop $write_int
        (br_if $write_int_done (i32.lt_s (local.get $j) (i32.const 0)))
        (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (local.set $j (i32.sub (local.get $j) (i32.const 1)))
        (br $write_int)))
    ;; Write decimal point and fraction
    (if (local.get $hasDecimal)
      (then
        (i32.store16 (local.get $offset) (i32.const 46))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (local.set $j (i32.const 0))
        (block $write_frac_done
          (loop $write_frac
            (br_if $write_frac_done (i32.ge_s (local.get $j) (local.get $fracLen)))
            (i32.store16 (local.get $offset) (i32.load8_u (i32.add (i32.add (local.get $buf) (i32.const 32)) (local.get $j))))
            (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $write_frac)))))
    (local.get $str))`,

  // toFixed(x, digits) - format number with fixed decimal places
  // Returns string representation with exactly 'digits' decimal places
  toFixed: `(func $toFixed (param $x f64) (param $digits i32) (result f64)
    (local $str f64) (local $offset i32)
    (local $neg i32) (local $scaled i64) (local $intPart i64) (local $fracPart i64)
    (local $digit i32) (local $i i32) (local $j i32)
    (local $buf i32) (local $intLen i32) (local $fracLen i32) (local $totalLen i32)
    (local $abs f64) (local $scale f64)
    ;; Clamp digits to 0-20 (JS spec)
    (if (i32.lt_s (local.get $digits) (i32.const 0))
      (then (local.set $digits (i32.const 0))))
    (if (i32.gt_s (local.get $digits) (i32.const 20))
      (then (local.set $digits (i32.const 20))))
    ;; Handle NaN
    (if (f64.ne (local.get $x) (local.get $x))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNaN)))))
    ;; Handle Infinity
    (if (f64.eq (local.get $x) (f64.const inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strInf)))))
    (if (f64.eq (local.get $x) (f64.const -inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNegInf)))))
    ;; Handle negative
    (local.set $neg (f64.lt (local.get $x) (f64.const 0)))
    (local.set $abs (f64.abs (local.get $x)))
    ;; Compute scale = 10^digits
    (local.set $scale (f64.const 1))
    (local.set $i (i32.const 0))
    (block $scale_done (loop $scale_loop
      (br_if $scale_done (i32.ge_s (local.get $i) (local.get $digits)))
      (local.set $scale (f64.mul (local.get $scale) (f64.const 10)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scale_loop)))
    ;; Round: scaled = floor(abs * scale + 0.5) as integer
    (local.set $scaled (i64.trunc_f64_s (f64.floor (f64.add (f64.mul (local.get $abs) (local.get $scale)) (f64.const 0.5)))))
    ;; Split into integer and fractional parts using integer division
    (local.set $intPart (i64.div_u (local.get $scaled) (i64.trunc_f64_s (local.get $scale))))
    (local.set $fracPart (i64.rem_u (local.get $scaled) (i64.trunc_f64_s (local.get $scale))))
    ;; Handle digits=0 case
    (if (i32.eqz (local.get $digits))
      (then (local.set $intPart (local.get $scaled))))
    ;; Use temp buffer at 65480
    (local.set $buf (i32.const 65480))
    ;; Extract integer digits (reversed) at buf[0..31]
    (local.set $intLen (i32.const 0))
    (if (i64.eqz (local.get $intPart))
      (then
        (i32.store8 (local.get $buf) (i32.const 48))
        (local.set $intLen (i32.const 1)))
      (else
        (loop $int_loop
          (if (i64.gt_u (local.get $intPart) (i64.const 0))
            (then
              (local.set $digit (i32.wrap_i64 (i64.rem_u (local.get $intPart) (i64.const 10))))
              (i32.store8 (i32.add (local.get $buf) (local.get $intLen)) (i32.add (i32.const 48) (local.get $digit)))
              (local.set $intLen (i32.add (local.get $intLen) (i32.const 1)))
              (local.set $intPart (i64.div_u (local.get $intPart) (i64.const 10)))
              (br $int_loop))))))
    ;; Extract fractional digits (reversed) at buf[32..63]
    (local.set $fracLen (i32.const 0))
    (if (i32.gt_s (local.get $digits) (i32.const 0))
      (then
        (local.set $i (i32.const 0))
        (loop $frac_loop
          (if (i32.lt_s (local.get $i) (local.get $digits))
            (then
              (local.set $digit (i32.wrap_i64 (i64.rem_u (local.get $fracPart) (i64.const 10))))
              (i32.store8 (i32.add (i32.const 65512) (local.get $fracLen)) (i32.add (i32.const 48) (local.get $digit)))
              (local.set $fracLen (i32.add (local.get $fracLen) (i32.const 1)))
              (local.set $fracPart (i64.div_u (local.get $fracPart) (i64.const 10)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $frac_loop))))))
    ;; Calculate total length: neg? + intLen + (digits > 0 ? 1 + digits : 0)
    (local.set $totalLen (local.get $intLen))
    (if (local.get $neg)
      (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.const 1)))))
    (if (i32.gt_s (local.get $digits) (i32.const 0))
      (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.add (i32.const 1) (local.get $digits))))))
    ;; Allocate result string
    (local.set $str (call $__alloc (i32.const 3) (local.get $totalLen)))
    (local.set $offset (call $__ptr_offset (local.get $str)))
    ;; Write minus sign
    (if (local.get $neg)
      (then
        (i32.store16 (local.get $offset) (i32.const 45))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))))
    ;; Write integer digits (reverse order)
    (local.set $j (i32.sub (local.get $intLen) (i32.const 1)))
    (block $wi_done (loop $wi_loop
      (br_if $wi_done (i32.lt_s (local.get $j) (i32.const 0)))
      (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
      (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
      (local.set $j (i32.sub (local.get $j) (i32.const 1)))
      (br $wi_loop)))
    ;; Write decimal point and fraction digits (reverse order from extraction)
    (if (i32.gt_s (local.get $digits) (i32.const 0))
      (then
        (i32.store16 (local.get $offset) (i32.const 46))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (local.set $j (i32.sub (local.get $fracLen) (i32.const 1)))
        (block $wf_done (loop $wf_loop
          (br_if $wf_done (i32.lt_s (local.get $j) (i32.const 0)))
          (i32.store16 (local.get $offset) (i32.load8_u (i32.add (i32.const 65512) (local.get $j))))
          (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
          (local.set $j (i32.sub (local.get $j) (i32.const 1)))
          (br $wf_loop)))))
    (local.get $str))`,

  // toString(x, radix) - convert number to string with specified base (2-36)
  // For radix 10, delegates to numToString
  toString: `(func $toString (param $x f64) (param $radix i32) (result f64)
    (local $str f64) (local $offset i32) (local $neg i32)
    (local $intPart i64) (local $digit i32) (local $intLen i32) (local $j i32)
    (local $buf i32) (local $ch i32)
    ;; Clamp radix to 2-36
    (if (i32.lt_s (local.get $radix) (i32.const 2))
      (then (local.set $radix (i32.const 10))))
    (if (i32.gt_s (local.get $radix) (i32.const 36))
      (then (local.set $radix (i32.const 36))))
    ;; For radix 10, use numToString
    (if (i32.eq (local.get $radix) (i32.const 10))
      (then (return (call $numToString (local.get $x)))))
    ;; Handle NaN
    (if (f64.ne (local.get $x) (local.get $x))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNaN)))))
    ;; Handle Infinity
    (if (f64.eq (local.get $x) (f64.const inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strInf)))))
    (if (f64.eq (local.get $x) (f64.const -inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNegInf)))))
    ;; Handle negative
    (local.set $neg (f64.lt (local.get $x) (f64.const 0)))
    ;; Truncate to integer for non-decimal bases
    (local.set $intPart (i64.trunc_f64_s (f64.trunc (f64.abs (local.get $x)))))
    ;; Use temp buffer
    (local.set $buf (i32.const 65480))
    ;; Extract digits in given radix (reversed)
    (local.set $intLen (i32.const 0))
    (if (i64.eqz (local.get $intPart))
      (then
        (i32.store8 (local.get $buf) (i32.const 48))
        (local.set $intLen (i32.const 1)))
      (else
        (loop $int_loop
          (if (i64.gt_u (local.get $intPart) (i64.const 0))
            (then
              (local.set $digit (i32.wrap_i64 (i64.rem_u (local.get $intPart) (i64.extend_i32_s (local.get $radix)))))
              ;; 0-9 -> '0'-'9', 10-35 -> 'a'-'z'
              (if (i32.lt_s (local.get $digit) (i32.const 10))
                (then (local.set $ch (i32.add (i32.const 48) (local.get $digit))))
                (else (local.set $ch (i32.add (i32.const 87) (local.get $digit))))) ;; 87 = 'a' - 10
              (i32.store8 (i32.add (local.get $buf) (local.get $intLen)) (local.get $ch))
              (local.set $intLen (i32.add (local.get $intLen) (i32.const 1)))
              (local.set $intPart (i64.div_u (local.get $intPart) (i64.extend_i32_s (local.get $radix))))
              (br $int_loop))))))
    ;; Allocate result string
    (local.set $str (call $__alloc (i32.const 3) (i32.add (local.get $intLen) (local.get $neg))))
    (local.set $offset (call $__ptr_offset (local.get $str)))
    ;; Write minus sign
    (if (local.get $neg)
      (then
        (i32.store16 (local.get $offset) (i32.const 45))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))))
    ;; Write digits (reverse order)
    (local.set $j (i32.sub (local.get $intLen) (i32.const 1)))
    (block $w_done (loop $w_loop
      (br_if $w_done (i32.lt_s (local.get $j) (i32.const 0)))
      (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
      (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
      (local.set $j (i32.sub (local.get $j) (i32.const 1)))
      (br $w_loop)))
    (local.get $str))`,

  // toExponential(x, fractionDigits) - format number in exponential notation
  // Returns string like "1.23e+4" or "1.23e-4"
  toExponential: `(func $toExponential (param $x f64) (param $frac i32) (result f64)
    (local $str f64) (local $offset i32) (local $neg i32)
    (local $abs f64) (local $exp i32) (local $mantissa f64)
    (local $scaled i64) (local $digit i32) (local $i i32) (local $j i32)
    (local $buf i32) (local $digLen i32) (local $totalLen i32)
    (local $scale f64) (local $expNeg i32) (local $expAbs i32) (local $expLen i32)
    ;; Clamp fractionDigits to 0-20
    (if (i32.lt_s (local.get $frac) (i32.const 0))
      (then (local.set $frac (i32.const 0))))
    (if (i32.gt_s (local.get $frac) (i32.const 20))
      (then (local.set $frac (i32.const 20))))
    ;; Handle NaN
    (if (f64.ne (local.get $x) (local.get $x))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNaN)))))
    ;; Handle Infinity
    (if (f64.eq (local.get $x) (f64.const inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strInf)))))
    (if (f64.eq (local.get $x) (f64.const -inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNegInf)))))
    ;; Handle zero
    (if (f64.eq (local.get $x) (f64.const 0))
      (then
        ;; Build "0.000...e+0" with frac zeros
        (local.set $totalLen (i32.add (i32.const 5) (local.get $frac))) ;; "0." + frac + "e+0" = 1+1+frac+3
        (if (i32.eqz (local.get $frac))
          (then (local.set $totalLen (i32.const 4)))) ;; "0e+0"
        (local.set $str (call $__alloc (i32.const 3) (local.get $totalLen)))
        (local.set $offset (call $__ptr_offset (local.get $str)))
        (i32.store16 (local.get $offset) (i32.const 48)) ;; '0'
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (if (i32.gt_s (local.get $frac) (i32.const 0))
          (then
            (i32.store16 (local.get $offset) (i32.const 46)) ;; '.'
            (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
            (local.set $i (i32.const 0))
            (block $z_done (loop $z_loop
              (br_if $z_done (i32.ge_s (local.get $i) (local.get $frac)))
              (i32.store16 (local.get $offset) (i32.const 48))
              (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $z_loop)))))
        (i32.store16 (local.get $offset) (i32.const 101)) ;; 'e'
        (i32.store16 (i32.add (local.get $offset) (i32.const 2)) (i32.const 43)) ;; '+'
        (i32.store16 (i32.add (local.get $offset) (i32.const 4)) (i32.const 48)) ;; '0'
        (return (local.get $str))))
    ;; Handle negative
    (local.set $neg (f64.lt (local.get $x) (f64.const 0)))
    (local.set $abs (f64.abs (local.get $x)))
    ;; Calculate exponent: floor(log10(abs))
    (local.set $exp (i32.const 0))
    (local.set $mantissa (local.get $abs))
    ;; Normalize: find exp such that 1 <= mantissa < 10
    (block $norm_done
      (loop $norm_up
        (br_if $norm_done (f64.lt (local.get $mantissa) (f64.const 10)))
        (local.set $mantissa (f64.div (local.get $mantissa) (f64.const 10)))
        (local.set $exp (i32.add (local.get $exp) (i32.const 1)))
        (br $norm_up)))
    (block $norm_done2
      (loop $norm_down
        (br_if $norm_done2 (f64.ge (local.get $mantissa) (f64.const 1)))
        (local.set $mantissa (f64.mul (local.get $mantissa) (f64.const 10)))
        (local.set $exp (i32.sub (local.get $exp) (i32.const 1)))
        (br $norm_down)))
    ;; Round mantissa to (frac+1) digits
    (local.set $scale (f64.const 1))
    (local.set $i (i32.const 0))
    (block $sc_done (loop $sc_loop
      (br_if $sc_done (i32.ge_s (local.get $i) (local.get $frac)))
      (local.set $scale (f64.mul (local.get $scale) (f64.const 10)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sc_loop)))
    (local.set $scaled (i64.trunc_f64_s (f64.floor (f64.add (f64.mul (local.get $mantissa) (local.get $scale)) (f64.const 0.5)))))
    ;; Handle rounding overflow (e.g., 9.999 rounds to 10.00)
    (if (i64.ge_s (local.get $scaled) (i64.trunc_f64_s (f64.mul (local.get $scale) (f64.const 10))))
      (then
        (local.set $scaled (i64.div_s (local.get $scaled) (i64.const 10)))
        (local.set $exp (i32.add (local.get $exp) (i32.const 1)))))
    ;; Use temp buffer
    (local.set $buf (i32.const 65480))
    ;; Extract digits (reversed)
    (local.set $digLen (i32.const 0))
    (block $dig_done (loop $dig_loop
      (if (i64.gt_s (local.get $scaled) (i64.const 0))
        (then
          (local.set $digit (i32.wrap_i64 (i64.rem_u (local.get $scaled) (i64.const 10))))
          (i32.store8 (i32.add (local.get $buf) (local.get $digLen)) (i32.add (i32.const 48) (local.get $digit)))
          (local.set $digLen (i32.add (local.get $digLen) (i32.const 1)))
          (local.set $scaled (i64.div_u (local.get $scaled) (i64.const 10)))
          (br $dig_loop)))))
    ;; Pad with leading zeros if needed
    (block $pad_done (loop $pad_loop
      (br_if $pad_done (i32.gt_s (local.get $digLen) (local.get $frac)))
      (i32.store8 (i32.add (local.get $buf) (local.get $digLen)) (i32.const 48))
      (local.set $digLen (i32.add (local.get $digLen) (i32.const 1)))
      (br $pad_loop)))
    ;; Calculate exponent string length
    (local.set $expNeg (i32.lt_s (local.get $exp) (i32.const 0)))
    (local.set $expAbs (select (i32.sub (i32.const 0) (local.get $exp)) (local.get $exp) (local.get $expNeg)))
    (local.set $expLen (i32.const 1))
    (if (i32.ge_s (local.get $expAbs) (i32.const 10))
      (then (local.set $expLen (i32.const 2))))
    (if (i32.ge_s (local.get $expAbs) (i32.const 100))
      (then (local.set $expLen (i32.const 3))))
    ;; Total length: neg? + 1 + (frac>0 ? 1+frac : 0) + 2 + expLen
    (local.set $totalLen (i32.add (i32.const 1) (i32.add (i32.const 2) (local.get $expLen)))) ;; digit + "e+" + exp
    (if (local.get $neg)
      (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.const 1)))))
    (if (i32.gt_s (local.get $frac) (i32.const 0))
      (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.add (i32.const 1) (local.get $frac))))))
    ;; Allocate result
    (local.set $str (call $__alloc (i32.const 3) (local.get $totalLen)))
    (local.set $offset (call $__ptr_offset (local.get $str)))
    ;; Write minus sign
    (if (local.get $neg)
      (then
        (i32.store16 (local.get $offset) (i32.const 45))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))))
    ;; Write first digit (last in reversed buffer)
    (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (i32.sub (local.get $digLen) (i32.const 1)))))
    (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
    ;; Write decimal point and remaining digits
    (if (i32.gt_s (local.get $frac) (i32.const 0))
      (then
        (i32.store16 (local.get $offset) (i32.const 46))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (local.set $j (i32.sub (local.get $digLen) (i32.const 2)))
        (block $wd_done (loop $wd_loop
          (br_if $wd_done (i32.lt_s (local.get $j) (i32.const 0)))
          (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
          (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
          (local.set $j (i32.sub (local.get $j) (i32.const 1)))
          (br $wd_loop)))))
    ;; Write 'e'
    (i32.store16 (local.get $offset) (i32.const 101))
    (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
    ;; Write '+' or '-'
    (i32.store16 (local.get $offset) (select (i32.const 45) (i32.const 43) (local.get $expNeg)))
    (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
    ;; Write exponent digits
    (if (i32.ge_s (local.get $expLen) (i32.const 3))
      (then
        (i32.store16 (local.get $offset) (i32.add (i32.const 48) (i32.div_s (local.get $expAbs) (i32.const 100))))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (local.set $expAbs (i32.rem_s (local.get $expAbs) (i32.const 100)))))
    (if (i32.ge_s (local.get $expLen) (i32.const 2))
      (then
        (i32.store16 (local.get $offset) (i32.add (i32.const 48) (i32.div_s (local.get $expAbs) (i32.const 10))))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (local.set $expAbs (i32.rem_s (local.get $expAbs) (i32.const 10)))))
    (i32.store16 (local.get $offset) (i32.add (i32.const 48) (local.get $expAbs)))
    (local.get $str))`,

  // toPrecision(x, precision) - format number to specified significant digits
  // Returns exponential notation if needed, otherwise fixed notation
  toPrecision: `(func $toPrecision (param $x f64) (param $prec i32) (result f64)
    (local $str f64) (local $offset i32) (local $neg i32)
    (local $abs f64) (local $exp i32) (local $mantissa f64)
    (local $scaled i64) (local $digit i32) (local $i i32) (local $j i32)
    (local $buf i32) (local $digLen i32) (local $totalLen i32)
    (local $scale f64) (local $expNeg i32) (local $expAbs i32) (local $expLen i32)
    (local $useExp i32) (local $intDigits i32) (local $fracDigits i32)
    ;; Clamp precision to 1-21
    (if (i32.lt_s (local.get $prec) (i32.const 1))
      (then (local.set $prec (i32.const 1))))
    (if (i32.gt_s (local.get $prec) (i32.const 21))
      (then (local.set $prec (i32.const 21))))
    ;; Handle NaN
    (if (f64.ne (local.get $x) (local.get $x))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNaN)))))
    ;; Handle Infinity
    (if (f64.eq (local.get $x) (f64.const inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strInf)))))
    (if (f64.eq (local.get $x) (f64.const -inf))
      (then (return (call $__mkptr (i32.const 3) (i32.const 0) (global.get $__strNegInf)))))
    ;; Handle zero
    (if (f64.eq (local.get $x) (f64.const 0))
      (then
        ;; Build "0.000..." with prec-1 zeros after decimal
        (local.set $totalLen (local.get $prec))
        (if (i32.gt_s (local.get $prec) (i32.const 1))
          (then (local.set $totalLen (i32.add (local.get $prec) (i32.const 1))))) ;; +1 for '.'
        (local.set $str (call $__alloc (i32.const 3) (local.get $totalLen)))
        (local.set $offset (call $__ptr_offset (local.get $str)))
        (i32.store16 (local.get $offset) (i32.const 48))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (if (i32.gt_s (local.get $prec) (i32.const 1))
          (then
            (i32.store16 (local.get $offset) (i32.const 46))
            (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
            (local.set $i (i32.const 1))
            (block $z_done (loop $z_loop
              (br_if $z_done (i32.ge_s (local.get $i) (local.get $prec)))
              (i32.store16 (local.get $offset) (i32.const 48))
              (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $z_loop)))))
        (return (local.get $str))))
    ;; Handle negative
    (local.set $neg (f64.lt (local.get $x) (f64.const 0)))
    (local.set $abs (f64.abs (local.get $x)))
    ;; Calculate exponent
    (local.set $exp (i32.const 0))
    (local.set $mantissa (local.get $abs))
    (block $norm_done
      (loop $norm_up
        (br_if $norm_done (f64.lt (local.get $mantissa) (f64.const 10)))
        (local.set $mantissa (f64.div (local.get $mantissa) (f64.const 10)))
        (local.set $exp (i32.add (local.get $exp) (i32.const 1)))
        (br $norm_up)))
    (block $norm_done2
      (loop $norm_down
        (br_if $norm_done2 (f64.ge (local.get $mantissa) (f64.const 1)))
        (local.set $mantissa (f64.mul (local.get $mantissa) (f64.const 10)))
        (local.set $exp (i32.sub (local.get $exp) (i32.const 1)))
        (br $norm_down)))
    ;; Round to prec significant digits
    (local.set $scale (f64.const 1))
    (local.set $i (i32.const 1))
    (block $sc_done (loop $sc_loop
      (br_if $sc_done (i32.ge_s (local.get $i) (local.get $prec)))
      (local.set $scale (f64.mul (local.get $scale) (f64.const 10)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sc_loop)))
    (local.set $scaled (i64.trunc_f64_s (f64.floor (f64.add (f64.mul (local.get $mantissa) (local.get $scale)) (f64.const 0.5)))))
    ;; Handle rounding overflow
    (if (i64.ge_s (local.get $scaled) (i64.trunc_f64_s (f64.mul (local.get $scale) (f64.const 10))))
      (then
        (local.set $scaled (i64.div_s (local.get $scaled) (i64.const 10)))
        (local.set $exp (i32.add (local.get $exp) (i32.const 1)))))
    ;; Decide: use exponential if exp < -6 or exp >= prec
    (local.set $useExp (i32.or (i32.lt_s (local.get $exp) (i32.const -6))
                               (i32.ge_s (local.get $exp) (local.get $prec))))
    ;; Use temp buffer
    (local.set $buf (i32.const 65480))
    ;; Extract digits (reversed)
    (local.set $digLen (i32.const 0))
    (block $dig_done (loop $dig_loop
      (if (i64.gt_s (local.get $scaled) (i64.const 0))
        (then
          (local.set $digit (i32.wrap_i64 (i64.rem_u (local.get $scaled) (i64.const 10))))
          (i32.store8 (i32.add (local.get $buf) (local.get $digLen)) (i32.add (i32.const 48) (local.get $digit)))
          (local.set $digLen (i32.add (local.get $digLen) (i32.const 1)))
          (local.set $scaled (i64.div_u (local.get $scaled) (i64.const 10)))
          (br $dig_loop)))))
    ;; Pad with leading zeros if needed
    (block $pad_done (loop $pad_loop
      (br_if $pad_done (i32.ge_s (local.get $digLen) (local.get $prec)))
      (i32.store8 (i32.add (local.get $buf) (local.get $digLen)) (i32.const 48))
      (local.set $digLen (i32.add (local.get $digLen) (i32.const 1)))
      (br $pad_loop)))
    ;; Branch: exponential or fixed notation
    (if (local.get $useExp)
      (then
        ;; Exponential notation
        (local.set $expNeg (i32.lt_s (local.get $exp) (i32.const 0)))
        (local.set $expAbs (select (i32.sub (i32.const 0) (local.get $exp)) (local.get $exp) (local.get $expNeg)))
        (local.set $expLen (i32.const 1))
        (if (i32.ge_s (local.get $expAbs) (i32.const 10))
          (then (local.set $expLen (i32.const 2))))
        (if (i32.ge_s (local.get $expAbs) (i32.const 100))
          (then (local.set $expLen (i32.const 3))))
        ;; Length: neg? + 1 + (prec>1 ? 1+prec-1 : 0) + 2 + expLen
        (local.set $totalLen (i32.add (i32.const 3) (local.get $expLen))) ;; digit + "e+" + exp
        (if (local.get $neg)
          (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.const 1)))))
        (if (i32.gt_s (local.get $prec) (i32.const 1))
          (then (local.set $totalLen (i32.add (local.get $totalLen) (local.get $prec))))) ;; . + frac digits
        (local.set $str (call $__alloc (i32.const 3) (local.get $totalLen)))
        (local.set $offset (call $__ptr_offset (local.get $str)))
        ;; Write minus
        (if (local.get $neg)
          (then
            (i32.store16 (local.get $offset) (i32.const 45))
            (local.set $offset (i32.add (local.get $offset) (i32.const 2)))))
        ;; Write first digit
        (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (i32.sub (local.get $digLen) (i32.const 1)))))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        ;; Write decimal and remaining
        (if (i32.gt_s (local.get $prec) (i32.const 1))
          (then
            (i32.store16 (local.get $offset) (i32.const 46))
            (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
            (local.set $j (i32.sub (local.get $digLen) (i32.const 2)))
            (block $wd_done (loop $wd_loop
              (br_if $wd_done (i32.lt_s (local.get $j) (i32.const 0)))
              (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
              (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
              (local.set $j (i32.sub (local.get $j) (i32.const 1)))
              (br $wd_loop)))))
        ;; Write exponent
        (i32.store16 (local.get $offset) (i32.const 101))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (i32.store16 (local.get $offset) (select (i32.const 45) (i32.const 43) (local.get $expNeg)))
        (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
        (if (i32.ge_s (local.get $expLen) (i32.const 3))
          (then
            (i32.store16 (local.get $offset) (i32.add (i32.const 48) (i32.div_s (local.get $expAbs) (i32.const 100))))
            (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
            (local.set $expAbs (i32.rem_s (local.get $expAbs) (i32.const 100)))))
        (if (i32.ge_s (local.get $expLen) (i32.const 2))
          (then
            (i32.store16 (local.get $offset) (i32.add (i32.const 48) (i32.div_s (local.get $expAbs) (i32.const 10))))
            (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
            (local.set $expAbs (i32.rem_s (local.get $expAbs) (i32.const 10)))))
        (i32.store16 (local.get $offset) (i32.add (i32.const 48) (local.get $expAbs))))
      (else
        ;; Fixed notation - handles both exp >= 0 and exp < 0
        (if (i32.lt_s (local.get $exp) (i32.const 0))
          (then
            ;; Small number: 0.000...digits (exp < 0)
            ;; leadingZeros = abs(exp) - 1 = -exp - 1
            (local.set $intDigits (i32.sub (i32.sub (i32.const 0) (local.get $exp)) (i32.const 1)))
            ;; totalLen = neg? + "0." + leadingZeros + prec
            (local.set $totalLen (i32.add (i32.const 2) (i32.add (local.get $intDigits) (local.get $prec))))
            (if (local.get $neg)
              (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.const 1)))))
            (local.set $str (call $__alloc (i32.const 3) (local.get $totalLen)))
            (local.set $offset (call $__ptr_offset (local.get $str)))
            ;; Write minus
            (if (local.get $neg)
              (then
                (i32.store16 (local.get $offset) (i32.const 45))
                (local.set $offset (i32.add (local.get $offset) (i32.const 2)))))
            ;; Write "0."
            (i32.store16 (local.get $offset) (i32.const 48))
            (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
            (i32.store16 (local.get $offset) (i32.const 46))
            (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
            ;; Write leading zeros
            (local.set $i (i32.const 0))
            (block $lz_done (loop $lz_loop
              (br_if $lz_done (i32.ge_s (local.get $i) (local.get $intDigits)))
              (i32.store16 (local.get $offset) (i32.const 48))
              (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $lz_loop)))
            ;; Write significant digits (reversed in buffer)
            (local.set $j (i32.sub (local.get $digLen) (i32.const 1)))
            (block $sd_done (loop $sd_loop
              (br_if $sd_done (i32.lt_s (local.get $j) (i32.const 0)))
              (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
              (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
              (local.set $j (i32.sub (local.get $j) (i32.const 1)))
              (br $sd_loop))))
          (else
            ;; Normal fixed: intPart.fracPart (exp >= 0)
            (local.set $intDigits (i32.add (local.get $exp) (i32.const 1)))
            (local.set $fracDigits (i32.sub (local.get $prec) (local.get $intDigits)))
            ;; Length: neg? + intDigits + (fracDigits > 0 ? 1 + fracDigits : 0)
            (local.set $totalLen (local.get $intDigits))
            (if (local.get $neg)
              (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.const 1)))))
            (if (i32.gt_s (local.get $fracDigits) (i32.const 0))
              (then (local.set $totalLen (i32.add (local.get $totalLen) (i32.add (i32.const 1) (local.get $fracDigits))))))
            (local.set $str (call $__alloc (i32.const 3) (local.get $totalLen)))
            (local.set $offset (call $__ptr_offset (local.get $str)))
            ;; Write minus
            (if (local.get $neg)
              (then
                (i32.store16 (local.get $offset) (i32.const 45))
                (local.set $offset (i32.add (local.get $offset) (i32.const 2)))))
            ;; Write integer digits (from end of buffer, reversed)
            (local.set $j (i32.sub (local.get $digLen) (i32.const 1)))
            (local.set $i (i32.const 0))
            (block $wi_done (loop $wi_loop
              (br_if $wi_done (i32.ge_s (local.get $i) (local.get $intDigits)))
              (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
              (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
              (local.set $j (i32.sub (local.get $j) (i32.const 1)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $wi_loop)))
            ;; Write decimal and fraction
            (if (i32.gt_s (local.get $fracDigits) (i32.const 0))
              (then
                (i32.store16 (local.get $offset) (i32.const 46))
                (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
                (block $wf_done (loop $wf_loop
                  (br_if $wf_done (i32.lt_s (local.get $j) (i32.const 0)))
                  (i32.store16 (local.get $offset) (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
                  (local.set $offset (i32.add (local.get $offset) (i32.const 2)))
                  (local.set $j (i32.sub (local.get $j) (i32.const 1)))
                  (br $wf_loop)))))))))
    (local.get $str))`,

  // escapeJsonString - escape special characters for JSON
  escapeJsonString: `(func $escapeJsonString (param $str f64) (result f64)
    (local $srcOff i32) (local $srcLen i32) (local $i i32) (local $ch i32)
    (local $escCount i32) (local $result f64) (local $dstOff i32)
    (local.set $srcOff (call $__ptr_offset (local.get $str)))
    (local.set $srcLen (call $__ptr_len (local.get $str)))
    ;; Count chars needing escape
    (local.set $escCount (i32.const 0))
    (local.set $i (i32.const 0))
    (block $cnt_done (loop $cnt_loop
      (br_if $cnt_done (i32.ge_s (local.get $i) (local.get $srcLen)))
      (local.set $ch (i32.load16_u (i32.add (local.get $srcOff) (i32.shl (local.get $i) (i32.const 1)))))
      (if (i32.or (i32.or (i32.eq (local.get $ch) (i32.const 34))   ;; double quote
                         (i32.eq (local.get $ch) (i32.const 92)))  ;; backslash
              (i32.or (i32.eq (local.get $ch) (i32.const 10))      ;; newline
                      (i32.or (i32.eq (local.get $ch) (i32.const 13))  ;; carriage return
                              (i32.eq (local.get $ch) (i32.const 9))))) ;; tab
        (then (local.set $escCount (i32.add (local.get $escCount) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cnt_loop)))
    ;; If no escapes needed, return original
    (if (i32.eqz (local.get $escCount))
      (then (return (local.get $str))))
    ;; Allocate new string with extra space
    (local.set $result (call $__alloc (i32.const 3) (i32.add (local.get $srcLen) (local.get $escCount))))
    (local.set $dstOff (call $__ptr_offset (local.get $result)))
    ;; Copy with escaping
    (local.set $i (i32.const 0))
    (block $cpy_done (loop $cpy_loop
      (br_if $cpy_done (i32.ge_s (local.get $i) (local.get $srcLen)))
      (local.set $ch (i32.load16_u (i32.add (local.get $srcOff) (i32.shl (local.get $i) (i32.const 1)))))
      (if (i32.eq (local.get $ch) (i32.const 34))
        (then
          (i32.store16 (local.get $dstOff) (i32.const 92))
          (local.set $dstOff (i32.add (local.get $dstOff) (i32.const 2)))
          (i32.store16 (local.get $dstOff) (i32.const 34)))
        (else (if (i32.eq (local.get $ch) (i32.const 92))
          (then
            (i32.store16 (local.get $dstOff) (i32.const 92))
            (local.set $dstOff (i32.add (local.get $dstOff) (i32.const 2)))
            (i32.store16 (local.get $dstOff) (i32.const 92)))
          (else (if (i32.eq (local.get $ch) (i32.const 10))
            (then
              (i32.store16 (local.get $dstOff) (i32.const 92))
              (local.set $dstOff (i32.add (local.get $dstOff) (i32.const 2)))
              (i32.store16 (local.get $dstOff) (i32.const 110)))
            (else (if (i32.eq (local.get $ch) (i32.const 13))
              (then
                (i32.store16 (local.get $dstOff) (i32.const 92))
                (local.set $dstOff (i32.add (local.get $dstOff) (i32.const 2)))
                (i32.store16 (local.get $dstOff) (i32.const 114)))
              (else (if (i32.eq (local.get $ch) (i32.const 9))
                (then
                  (i32.store16 (local.get $dstOff) (i32.const 92))
                  (local.set $dstOff (i32.add (local.get $dstOff) (i32.const 2)))
                  (i32.store16 (local.get $dstOff) (i32.const 116)))
                (else
                  (i32.store16 (local.get $dstOff) (local.get $ch))))))))))))
      (local.set $dstOff (i32.add (local.get $dstOff) (i32.const 2)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cpy_loop)))
    (local.get $result))`,

  // ============================================================================
  // HASH TABLE CORE
  // ============================================================================
  // Memory layout (C-style headers - capacity/size BEFORE offset):
  //   offset-16: capacity (f64)
  //   offset-8:  size (f64)
  //   offset:    entries start
  //
  // Entry layouts by stride:
  //   Set (stride=16):       [hash:f64][key:f64]
  //   Map/DynObj (stride=24): [hash:f64][key:f64][value:f64]
  //
  // Entry states: hash=0 (EMPTY), hash=1 (TOMBSTONE), hash>=2 (occupied)
  // Pointer layout: [type:4][schemaId:16][offset:31] - schemaId=0 for pure Set/Map
  // ============================================================================

  // Hash function for f64 keys - handles strings by content, others by bits
  // To detect string pointers, we check for NaN-boxed format: hi & 0xFFF80000 == 0x7FF80000
  __hash: `(func $__hash (param $key f64) (result i32)
    (local $h i32) (local $lo i32) (local $hi i32) (local $offset i32) (local $len i32) (local $i i32) (local $c i32)
    (local.set $lo (i32.wrap_i64 (i64.reinterpret_f64 (local.get $key))))
    (local.set $hi (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $key)) (i64.const 32))))
    ;; Check if string pointer: must be NaN-boxed (hi & 0xFFF80000 == 0x7FF80000) AND type=3
    (if (i32.and
          (i32.eq (i32.and (local.get $hi) (i32.const 0xFFF80000)) (i32.const 0x7FF80000))
          (i32.eq (i32.and (i32.shr_u (local.get $hi) (i32.const 15)) (i32.const 0xF)) (i32.const 3)))
      (then
        ;; String: FNV-1a hash of characters
        (local.set $offset (i32.and (local.get $lo) (i32.const 0x7FFFFFFF)))
        ;; Extract length from id field (bits 31-46): use full 64-bit shift
        (local.set $len (i32.and
          (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $key)) (i64.const 31)))
          (i32.const 0xFFFF)))
        (local.set $h (i32.const 0x811c9dc5))
        (local.set $i (i32.const 0))
        (block $done (loop $loop
          (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $c (i32.load16_u (i32.add (local.get $offset) (i32.shl (local.get $i) (i32.const 1)))))
          (local.set $h (i32.mul (i32.xor (local.get $h) (local.get $c)) (i32.const 0x01000193)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop))))
      (else
        ;; Non-string: MurmurHash3-style bit mixing
        (local.set $h (i32.xor (local.get $lo) (local.get $hi)))
        (local.set $h (i32.mul (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 16))) (i32.const 0x85ebca6b)))
        (local.set $h (i32.mul (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 13))) (i32.const 0xc2b2ae35)))
        (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 16))))))
    ;; Ensure hash >= 2 (0=empty, 1=tombstone)
    (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
      (then (i32.add (local.get $h) (i32.const 2)))
      (else (local.get $h))))`,

  // Key equality: strings by content, others by bits
  // To detect string pointers, we check for NaN-boxed format: hi & 0xFFF80000 == 0x7FF80000
  __key_eq: `(func $__key_eq (param $a f64) (param $b f64) (result i32)
    (local $hi_a i32) (local $hi_b i32) (local $off_a i32) (local $off_b i32) (local $len i32) (local $i i32)
    ;; Fast path: bitwise equal
    (if (i64.eq (i64.reinterpret_f64 (local.get $a)) (i64.reinterpret_f64 (local.get $b)))
      (then (return (i32.const 1))))
    ;; Check if both are string pointers (NaN-boxed with type=3)
    (local.set $hi_a (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $a)) (i64.const 32))))
    (local.set $hi_b (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $b)) (i64.const 32))))
    (if (i32.and
          ;; Check $a is NaN-boxed string
          (i32.and
            (i32.eq (i32.and (local.get $hi_a) (i32.const 0xFFF80000)) (i32.const 0x7FF80000))
            (i32.eq (i32.and (i32.shr_u (local.get $hi_a) (i32.const 15)) (i32.const 0xF)) (i32.const 3)))
          ;; Check $b is NaN-boxed string
          (i32.and
            (i32.eq (i32.and (local.get $hi_b) (i32.const 0xFFF80000)) (i32.const 0x7FF80000))
            (i32.eq (i32.and (i32.shr_u (local.get $hi_b) (i32.const 15)) (i32.const 0xF)) (i32.const 3))))
      (then
        ;; Both strings: compare lengths first (extract using 64-bit shift)
        (local.set $len (i32.and
          (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $a)) (i64.const 31)))
          (i32.const 0xFFFF)))
        (if (i32.ne (local.get $len) (i32.and
              (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $b)) (i64.const 31)))
              (i32.const 0xFFFF)))
          (then (return (i32.const 0))))
        ;; Compare characters
        (local.set $off_a (i32.and (i32.wrap_i64 (i64.reinterpret_f64 (local.get $a))) (i32.const 0x7FFFFFFF)))
        (local.set $off_b (i32.and (i32.wrap_i64 (i64.reinterpret_f64 (local.get $b))) (i32.const 0x7FFFFFFF)))
        (local.set $i (i32.const 0))
        (block $ne (loop $loop
          (br_if 2 (i32.ge_s (local.get $i) (local.get $len)))
          (br_if $ne (i32.ne
            (i32.load16_u (i32.add (local.get $off_a) (i32.shl (local.get $i) (i32.const 1))))
            (i32.load16_u (i32.add (local.get $off_b) (i32.shl (local.get $i) (i32.const 1))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $loop)))
        (return (i32.const 0))))
    (i32.const 0))`,

  // Allocate Set with C-style headers (capacity/size before entries)
  // Layout: [... | cap:f64 | size:f64 | entry0... ] where offset points to entries
  // OBJECT type=4 with kind=2 (SET): aux = (2 << 14) = 0x8000
  __set_new: `(func $__set_new (param $cap i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (if (i32.lt_s (local.get $cap) (i32.const 16))
      (then (local.set $cap (i32.const 16))))
    ;; Allocate: 16 bytes header + cap * 16 bytes entries
    (local.set $bytes (i32.add (i32.const 16) (i32.shl (local.get $cap) (i32.const 4))))
    (local.set $offset (i32.add (global.get $__heap) (i32.const 16))) ;; offset points past header
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (i32.sub (local.get $offset) (i32.const 16)) (i32.const 0) (local.get $bytes))
    (f64.store (i32.sub (local.get $offset) (i32.const 16)) (f64.convert_i32_s (local.get $cap)))
    ;; OBJECT=4, kind=2 (SET), aux = (2 << 14) = 0x8000
    (call $__mkptr (i32.const 4) (i32.const 0x8000) (local.get $offset)))`,

  // Allocate Map with C-style headers
  // OBJECT type=4 with kind=3 (MAP): aux = (3 << 14) = 0xC000
  __map_new: `(func $__map_new (param $cap i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (if (i32.lt_s (local.get $cap) (i32.const 16))
      (then (local.set $cap (i32.const 16))))
    ;; Allocate: 16 bytes header + cap * 24 bytes entries
    (local.set $bytes (i32.add (i32.const 16) (i32.mul (local.get $cap) (i32.const 24))))
    (local.set $offset (i32.add (global.get $__heap) (i32.const 16)))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (i32.sub (local.get $offset) (i32.const 16)) (i32.const 0) (local.get $bytes))
    (f64.store (i32.sub (local.get $offset) (i32.const 16)) (f64.convert_i32_s (local.get $cap)))
    ;; OBJECT=4, kind=3 (MAP), aux = (3 << 14) = 0xC000
    (call $__mkptr (i32.const 4) (i32.const 0xC000) (local.get $offset)))`,

  // Set.has(key) - returns 1 if found, 0 if not
  __set_has: `(func $__set_has (param $set f64) (param $key f64) (result i32)
    (local $offset i32) (local $cap i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $h (call $__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.shl (local.get $idx) (i32.const 4))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (return (i32.const 0)))
    (i32.const 1))`,

  // Set.add(key) - adds key, returns the Set (for chaining)
  __set_add: `(func $__set_add (param $set f64) (param $key f64) (result f64)
    (local $offset i32) (local $cap i32) (local $size i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32) (local $firstDeleted i32)
    (local.set $offset (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $size (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 8)))))
    (local.set $h (call $__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (local.set $firstDeleted (i32.const -1))
    (block $found (block $insert
      (loop $probe
        (br_if $insert (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.shl (local.get $idx) (i32.const 4))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $insert (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.eq (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (local.get $firstDeleted) (i32.const -1))
              (then (local.set $firstDeleted (local.get $entryOff))))))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (if (i32.ne (local.get $firstDeleted) (i32.const -1))
        (then (local.set $entryOff (local.get $firstDeleted)))
        (else (local.set $entryOff (i32.add (local.get $offset) (i32.shl (local.get $idx) (i32.const 4))))))
      (f64.store (local.get $entryOff) (f64.convert_i32_s (local.get $h)))
      (f64.store (i32.add (local.get $entryOff) (i32.const 8)) (local.get $key))
      (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.convert_i32_s (i32.add (local.get $size) (i32.const 1)))))
    (local.get $set))`,

  // Set.delete(key) - removes key, returns 1 if existed, 0 if not
  __set_delete: `(func $__set_delete (param $set f64) (param $key f64) (result i32)
    (local $offset i32) (local $cap i32) (local $size i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $size (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 8)))))
    (local.set $h (call $__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.shl (local.get $idx) (i32.const 4))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (return (i32.const 0)))
    (f64.store (local.get $entryOff) (f64.const 1))
    (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.convert_i32_s (i32.sub (local.get $size) (i32.const 1))))
    (i32.const 1))`,

  // Set.size getter
  __set_size: `(func $__set_size (param $set f64) (result i32)
    (i32.trunc_f64_s (f64.load (i32.sub (call $__ptr_offset (local.get $set)) (i32.const 8)))))`,

  // Map.has(key)
  __map_has: `(func $__map_has (param $map f64) (param $key f64) (result i32)
    (local $offset i32) (local $cap i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $h (call $__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (return (i32.const 0)))
    (i32.const 1))`,

  // Map.get(key) - returns value or undefined (0)
  __map_get: `(func $__map_get (param $map f64) (param $key f64) (result f64)
    (local $offset i32) (local $cap i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $h (call $__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (result f64) (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found (f64.load (i32.add (local.get $entryOff) (i32.const 16))))))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (f64.const 0)))`,

  // Map.set(key, val) - sets value, returns the Map (for chaining)
  __map_set: `(func $__map_set (param $map f64) (param $key f64) (param $val f64) (result f64)
    (local $offset i32) (local $cap i32) (local $size i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32) (local $firstDeleted i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $size (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 8)))))
    (local.set $h (call $__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (local.set $firstDeleted (i32.const -1))
    (block $found (block $insert
      (loop $probe
        (br_if $insert (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $insert (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.eq (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (local.get $firstDeleted) (i32.const -1))
              (then (local.set $firstDeleted (local.get $entryOff))))))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (if (i32.ne (local.get $firstDeleted) (i32.const -1))
        (then (local.set $entryOff (local.get $firstDeleted)))
        (else (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))))
      (f64.store (local.get $entryOff) (f64.convert_i32_s (local.get $h)))
      (f64.store (i32.add (local.get $entryOff) (i32.const 8)) (local.get $key))
      (f64.store (i32.add (local.get $entryOff) (i32.const 16)) (local.get $val))
      (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.convert_i32_s (i32.add (local.get $size) (i32.const 1))))
      (return (local.get $map)))
    (f64.store (i32.add (local.get $entryOff) (i32.const 16)) (local.get $val))
    (local.get $map))`,

  // Map.delete(key)
  __map_delete: `(func $__map_delete (param $map f64) (param $key f64) (result i32)
    (local $offset i32) (local $cap i32) (local $size i32) (local $h i32) (local $idx i32)
    (local $entryOff i32) (local $entryHash f64) (local $probes i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (local.set $size (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 8)))))
    (local.set $h (call $__hash (local.get $key)))
    (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
    (local.set $probes (i32.const 0))
    (block $found (block $not_found
      (loop $probe
        (br_if $not_found (i32.ge_s (local.get $probes) (local.get $cap)))
        (local.set $entryOff (i32.add (local.get $offset) (i32.mul (local.get $idx) (i32.const 24))))
        (local.set $entryHash (f64.load (local.get $entryOff)))
        (br_if $not_found (f64.eq (local.get $entryHash) (f64.const 0)))
        (if (f64.ne (local.get $entryHash) (f64.const 1))
          (then
            (if (i32.eq (i32.trunc_f64_s (local.get $entryHash)) (local.get $h))
              (then
                (if (call $__key_eq (f64.load (i32.add (local.get $entryOff) (i32.const 8))) (local.get $key))
                  (then (br $found)))))))
        (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
        (br $probe)))
      (return (i32.const 0)))
    (f64.store (local.get $entryOff) (f64.const 1))
    (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.convert_i32_s (i32.sub (local.get $size) (i32.const 1))))
    (i32.const 1))`,

  // Map.size getter
  __map_size: `(func $__map_size (param $map f64) (result i32)
    (i32.trunc_f64_s (f64.load (i32.sub (call $__ptr_offset (local.get $map)) (i32.const 8)))))`,

  // Set.clear() - reset to empty
  __set_clear: `(func $__set_clear (param $set f64) (result f64)
    (local $offset i32) (local $cap i32)
    (local.set $offset (call $__ptr_offset (local.get $set)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (memory.fill (local.get $offset) (i32.const 0) (i32.shl (local.get $cap) (i32.const 4)))
    (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.const 0))
    (local.get $set))`,

  // Map.clear()
  __map_clear: `(func $__map_clear (param $map f64) (result f64)
    (local $offset i32) (local $cap i32)
    (local.set $offset (call $__ptr_offset (local.get $map)))
    (local.set $cap (i32.trunc_f64_s (f64.load (i32.sub (local.get $offset) (i32.const 16)))))
    (memory.fill (local.get $offset) (i32.const 0) (i32.mul (local.get $cap) (i32.const 24)))
    (f64.store (i32.sub (local.get $offset) (i32.const 8)) (f64.const 0))
    (local.get $map))`,

  // ============================================================================
  // JSON.parse - recursive descent parser
  // ============================================================================
  // Uses global $__json_pos to track current position during parsing.
  // Input string stored in $__json_str, length in $__json_len.
  // Returns: f64 (number), string pointer, array pointer, or Map pointer (objects)

  // Get current char, -1 if at end
  __json_peek: `(func $__json_peek (result i32)
    (if (result i32) (i32.ge_s (global.get $__json_pos) (global.get $__json_len))
      (then (i32.const -1))
      (else (i32.load16_u (i32.add (global.get $__json_str)
        (i32.shl (global.get $__json_pos) (i32.const 1)))))))`,

  // Advance position by n
  __json_advance: `(func $__json_advance (param $n i32)
    (global.set $__json_pos (i32.add (global.get $__json_pos) (local.get $n))))`,

  // Skip whitespace (space, tab, newline, cr)
  __json_skip_ws: `(func $__json_skip_ws
    (local $ch i32)
    (block $done (loop $loop
      (local.set $ch (call $__json_peek))
      (br_if $done (i32.and
        (i32.ne (local.get $ch) (i32.const 32))   ;; space
        (i32.and (i32.ne (local.get $ch) (i32.const 9))    ;; tab
          (i32.and (i32.ne (local.get $ch) (i32.const 10))   ;; newline
            (i32.ne (local.get $ch) (i32.const 13))))))      ;; cr
      (call $__json_advance (i32.const 1))
      (br $loop))))`,

  // Parse JSON string (called after opening quote consumed)
  __json_parse_string: `(func $__json_parse_string (result f64)
    (local $start i32) (local $len i32) (local $ch i32) (local $result f64)
    (local $srcOff i32) (local $dstOff i32) (local $hasEsc i32) (local $i i32)
    ;; First pass: find end and check for escapes
    (local.set $start (global.get $__json_pos))
    (local.set $hasEsc (i32.const 0))
    (block $done (loop $scan
      (local.set $ch (call $__json_peek))
      (br_if $done (i32.eq (local.get $ch) (i32.const 34)))  ;; closing quote
      (br_if $done (i32.eq (local.get $ch) (i32.const -1))) ;; EOF
      (if (i32.eq (local.get $ch) (i32.const 92))  ;; backslash
        (then
          (local.set $hasEsc (i32.const 1))
          (call $__json_advance (i32.const 2)))  ;; skip escape + char
        (else (call $__json_advance (i32.const 1))))
      (br $scan)))
    (local.set $len (i32.sub (global.get $__json_pos) (local.get $start)))
    (call $__json_advance (i32.const 1))  ;; skip closing quote
    ;; No escapes: direct copy (STRING=3)
    (if (i32.eqz (local.get $hasEsc))
      (then
        (local.set $result (call $__alloc (i32.const 3) (local.get $len)))
        (memory.copy (call $__ptr_offset (local.get $result))
          (i32.add (global.get $__json_str) (i32.shl (local.get $start) (i32.const 1)))
          (i32.shl (local.get $len) (i32.const 1)))
        (return (local.get $result))))
    ;; Has escapes: decode (STRING=3)
    (local.set $result (call $__alloc (i32.const 3) (local.get $len)))  ;; over-allocate
    (local.set $srcOff (i32.add (global.get $__json_str) (i32.shl (local.get $start) (i32.const 1))))
    (local.set $dstOff (call $__ptr_offset (local.get $result)))
    (local.set $i (i32.const 0))
    (local.set $len (i32.const 0))  ;; reuse as output len
    (block $copy_done (loop $copy
      (local.set $ch (i32.load16_u (local.get $srcOff)))
      (br_if $copy_done (i32.eq (local.get $ch) (i32.const 34)))
      (if (i32.eq (local.get $ch) (i32.const 92))
        (then
          (local.set $srcOff (i32.add (local.get $srcOff) (i32.const 2)))
          (local.set $ch (i32.load16_u (local.get $srcOff)))
          ;; Decode escape: n→10, t→9, r→13, "→34, \→92, /→47
          (if (i32.eq (local.get $ch) (i32.const 110))
            (then (local.set $ch (i32.const 10)))
          (else (if (i32.eq (local.get $ch) (i32.const 116))
            (then (local.set $ch (i32.const 9)))
          (else (if (i32.eq (local.get $ch) (i32.const 114))
            (then (local.set $ch (i32.const 13)))
          (else (if (i32.eq (local.get $ch) (i32.const 98))
            (then (local.set $ch (i32.const 8)))
          (else (if (i32.eq (local.get $ch) (i32.const 102))
            (then (local.set $ch (i32.const 12))))))))))))))
      (i32.store16 (local.get $dstOff) (local.get $ch))
      (local.set $dstOff (i32.add (local.get $dstOff) (i32.const 2)))
      (local.set $srcOff (i32.add (local.get $srcOff) (i32.const 2)))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $copy)))
    ;; Fix length in pointer and return
    (call $__ptr_set_len (local.get $result) (local.get $len))
    (local.get $result))`,

  // Parse JSON number
  __json_parse_number: `(func $__json_parse_number (result f64)
    (local $neg i32) (local $val f64) (local $frac f64) (local $ch i32)
    (local $exp i32) (local $expNeg i32) (local $scale f64)
    ;; Check for minus
    (if (i32.eq (call $__json_peek) (i32.const 45))
      (then (local.set $neg (i32.const 1)) (call $__json_advance (i32.const 1))))
    ;; Integer part
    (local.set $val (f64.const 0))
    (block $int_done (loop $int_loop
      (local.set $ch (call $__json_peek))
      (br_if $int_done (i32.or (i32.lt_s (local.get $ch) (i32.const 48))
                               (i32.gt_s (local.get $ch) (i32.const 57))))
      (local.set $val (f64.add (f64.mul (local.get $val) (f64.const 10))
        (f64.convert_i32_s (i32.sub (local.get $ch) (i32.const 48)))))
      (call $__json_advance (i32.const 1))
      (br $int_loop)))
    ;; Fractional part
    (if (i32.eq (call $__json_peek) (i32.const 46))
      (then
        (call $__json_advance (i32.const 1))
        (local.set $scale (f64.const 0.1))
        (block $frac_done (loop $frac_loop
          (local.set $ch (call $__json_peek))
          (br_if $frac_done (i32.or (i32.lt_s (local.get $ch) (i32.const 48))
                                    (i32.gt_s (local.get $ch) (i32.const 57))))
          (local.set $val (f64.add (local.get $val)
            (f64.mul (local.get $scale)
              (f64.convert_i32_s (i32.sub (local.get $ch) (i32.const 48))))))
          (local.set $scale (f64.mul (local.get $scale) (f64.const 0.1)))
          (call $__json_advance (i32.const 1))
          (br $frac_loop)))))
    ;; Exponent part
    (if (i32.or (i32.eq (call $__json_peek) (i32.const 101))
                (i32.eq (call $__json_peek) (i32.const 69)))
      (then
        (call $__json_advance (i32.const 1))
        (if (i32.eq (call $__json_peek) (i32.const 45))
          (then (local.set $expNeg (i32.const 1)) (call $__json_advance (i32.const 1)))
        (else (if (i32.eq (call $__json_peek) (i32.const 43))
          (then (call $__json_advance (i32.const 1))))))
        (local.set $exp (i32.const 0))
        (block $exp_done (loop $exp_loop
          (local.set $ch (call $__json_peek))
          (br_if $exp_done (i32.or (i32.lt_s (local.get $ch) (i32.const 48))
                                   (i32.gt_s (local.get $ch) (i32.const 57))))
          (local.set $exp (i32.add (i32.mul (local.get $exp) (i32.const 10))
            (i32.sub (local.get $ch) (i32.const 48))))
          (call $__json_advance (i32.const 1))
          (br $exp_loop)))
        (if (local.get $expNeg)
          (then (local.set $exp (i32.sub (i32.const 0) (local.get $exp)))))
        (local.set $val (f64.mul (local.get $val) (call $pow (f64.const 10) (f64.convert_i32_s (local.get $exp)))))))
    (if (result f64) (local.get $neg)
      (then (f64.neg (local.get $val)))
      (else (local.get $val))))`,

  // Parse JSON array
  __json_parse_array: `(func $__json_parse_array (result f64)
    (local $arr f64) (local $val f64) (local $len i32) (local $cap i32)
    (local $newArr f64) (local $ch i32)
    ;; Start with capacity 8
    (local.set $cap (i32.const 8))
    (local.set $arr (call $__alloc (i32.const 1) (local.get $cap)))
    (local.set $len (i32.const 0))
    (call $__json_skip_ws)
    ;; Check for empty array
    (if (i32.eq (call $__json_peek) (i32.const 93))
      (then
        (call $__json_advance (i32.const 1))
        (call $__ptr_set_len (local.get $arr) (i32.const 0))
        (return (local.get $arr))))
    ;; Parse elements
    (block $done (loop $elem_loop
      (call $__json_skip_ws)
      (local.set $val (call $__json_parse_value))
      ;; Grow if needed
      (if (i32.ge_s (local.get $len) (local.get $cap))
        (then
          (local.set $newArr (call $__alloc (i32.const 1) (i32.shl (local.get $cap) (i32.const 1))))
          (memory.copy (call $__ptr_offset (local.get $newArr))
            (call $__ptr_offset (local.get $arr))
            (i32.shl (local.get $len) (i32.const 3)))
          (local.set $cap (i32.shl (local.get $cap) (i32.const 1)))
          (local.set $arr (local.get $newArr))))
      ;; Store element
      (f64.store (i32.add (call $__ptr_offset (local.get $arr))
        (i32.shl (local.get $len) (i32.const 3))) (local.get $val))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (call $__json_skip_ws)
      (local.set $ch (call $__json_peek))
      (br_if $done (i32.eq (local.get $ch) (i32.const 93)))  ;; ]
      (if (i32.eq (local.get $ch) (i32.const 44))  ;; ,
        (then (call $__json_advance (i32.const 1))))
      (br $elem_loop)))
    (call $__json_advance (i32.const 1))  ;; skip ]
    (call $__ptr_set_len (local.get $arr) (local.get $len))
    (local.get $arr))`,

  // Parse JSON object (returns Map pointer)
  __json_parse_object: `(func $__json_parse_object (result f64)
    (local $map f64) (local $key f64) (local $val f64) (local $ch i32)
    (local.set $map (call $__map_new (i32.const 16)))
    (call $__json_skip_ws)
    ;; Check for empty object
    (if (i32.eq (call $__json_peek) (i32.const 125))
      (then
        (call $__json_advance (i32.const 1))
        (return (local.get $map))))
    ;; Parse key-value pairs
    (block $done (loop $kv_loop
      (call $__json_skip_ws)
      ;; Parse key (must be string)
      (if (i32.ne (call $__json_peek) (i32.const 34))
        (then (return (f64.const 0))))  ;; error: expected string key
      (call $__json_advance (i32.const 1))
      (local.set $key (call $__json_parse_string))
      (call $__json_skip_ws)
      ;; Expect colon
      (if (i32.ne (call $__json_peek) (i32.const 58))
        (then (return (f64.const 0))))  ;; error: expected :
      (call $__json_advance (i32.const 1))
      (call $__json_skip_ws)
      ;; Parse value
      (local.set $val (call $__json_parse_value))
      ;; Store in map
      (drop (call $__map_set (local.get $map) (local.get $key) (local.get $val)))
      (call $__json_skip_ws)
      (local.set $ch (call $__json_peek))
      (br_if $done (i32.eq (local.get $ch) (i32.const 125)))  ;; }
      (if (i32.eq (local.get $ch) (i32.const 44))  ;; ,
        (then (call $__json_advance (i32.const 1))))
      (br $kv_loop)))
    (call $__json_advance (i32.const 1))  ;; skip }
    (local.get $map))`,

  // Main value dispatcher
  __json_parse_value: `(func $__json_parse_value (result f64)
    (local $ch i32)
    (call $__json_skip_ws)
    (local.set $ch (call $__json_peek))
    ;; String
    (if (i32.eq (local.get $ch) (i32.const 34))
      (then
        (call $__json_advance (i32.const 1))
        (return (call $__json_parse_string))))
    ;; Array
    (if (i32.eq (local.get $ch) (i32.const 91))
      (then
        (call $__json_advance (i32.const 1))
        (return (call $__json_parse_array))))
    ;; Object
    (if (i32.eq (local.get $ch) (i32.const 123))
      (then
        (call $__json_advance (i32.const 1))
        (return (call $__json_parse_object))))
    ;; Number (digit or minus)
    (if (i32.or (i32.and (i32.ge_s (local.get $ch) (i32.const 48))
                         (i32.le_s (local.get $ch) (i32.const 57)))
                (i32.eq (local.get $ch) (i32.const 45)))
      (then (return (call $__json_parse_number))))
    ;; true
    (if (i32.eq (local.get $ch) (i32.const 116))
      (then
        (call $__json_advance (i32.const 4))
        (return (f64.const 1))))
    ;; false
    (if (i32.eq (local.get $ch) (i32.const 102))
      (then
        (call $__json_advance (i32.const 5))
        (return (f64.const 0))))
    ;; null
    (if (i32.eq (local.get $ch) (i32.const 110))
      (then
        (call $__json_advance (i32.const 4))
        (return (f64.const 0))))
    ;; Unknown - return 0
    (f64.const 0))`,

  // Entry point: JSON.parse(str)
  __json_parse: `(func $__json_parse (param $str f64) (result f64)
    (global.set $__json_str (call $__ptr_offset (local.get $str)))
    (global.set $__json_len (call $__ptr_len (local.get $str)))
    (global.set $__json_pos (i32.const 0))
    (call $__json_parse_value))`,
}

// Dependencies - which functions call which other functions
export const DEPS = {
  tan: ['sin', 'cos'],
  exp: ['exp_pow2'],
  log2: ['log'],
  log10: ['log'],
  sinh: ['exp'],
  cosh: ['exp'],
  tanh: ['exp'],
  asin: ['atan'],
  acos: ['asin'],
  atan2: ['atan'],
  asinh: ['log'],
  acosh: ['log'],
  atanh: ['log'],
  pow: ['exp', 'log'],
  cbrt: ['pow'],
  expm1: ['exp'],
  log1p: ['log'],
  parseInt: ['parseIntFromCode'],
  // Number methods
  toString: ['numToString'],
  // Set/Map dependencies
  __set_has: ['__hash', '__key_eq'],
  __set_add: ['__hash', '__key_eq'],
  __set_delete: ['__hash', '__key_eq'],
  __map_has: ['__hash', '__key_eq'],
  __map_get: ['__hash', '__key_eq'],
  __map_set: ['__hash', '__key_eq'],
  __map_delete: ['__hash', '__key_eq'],
  // JSON.parse dependencies
  __json_parse: ['__json_parse_value'],
  __json_parse_value: ['__json_skip_ws', '__json_peek', '__json_advance',
    '__json_parse_string', '__json_parse_number', '__json_parse_array', '__json_parse_object'],
  __json_parse_string: ['__json_peek', '__json_advance'],
  __json_parse_number: ['__json_peek', '__json_advance', 'pow'],
  __json_parse_array: ['__json_skip_ws', '__json_peek', '__json_advance', '__json_parse_value'],
  __json_parse_object: ['__json_skip_ws', '__json_peek', '__json_advance', '__json_parse_string',
    '__json_parse_value', '__map_new', '__map_set'],
  __json_skip_ws: ['__json_peek', '__json_advance'],
}
