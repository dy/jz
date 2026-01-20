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

  fround: `(func $fround (param $x f64) (result f64) (local.get $x))`,

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
    (if (result f64) (f64.eq (f64.trunc (local.get $x)) (local.get $x))
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
    (local $code i32) (local $len i32) (local $offset i32)
    (local.set $len (call $__ptr_len (local.get $str)))
    (if (i32.eq (local.get $len) (i32.const 0))
      (then (return (f64.const nan))))
    (local.set $offset (call $__ptr_offset (local.get $str)))
    ;; Get first character code (i16 stored as 2-byte value)
    (local.set $code (i32.load16_u (local.get $offset)))
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
}
