;; poly.wat — hand-written WebAssembly baseline for the poly bench.
;;
;; Two parallel sums on Float64Array + Int32Array. The WAT version
;; specializes both: f64 reduction over f64 buffer, i32 reduction over
;; i32 buffer. No NaN-boxing, no dispatch — just two tight loops mixed
;; through the FNV-1a accumulator.
;;
;; Memory layout:
;;   f64s @ 0x0000_0000  → 8192 × f64 =  65 536 bytes
;;   i32s @ 0x0001_0000  →  8192 × i32 =  32 768 bytes

(module
  (memory (export "memory") 2)

  ;; Initialize both buffers — matches poly.js exactly.
  ;;   for i in 0..N: f64s[i] = (i % 251) * 0.25
  ;;                  i32s[i] = (i * 17) & 1023
  (func (export "init") (param $f64Ptr i32) (param $i32Ptr i32) (param $n i32)
    (local $i i32) (local $rem i32)
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        ;; rem = i % 251
        (local.set $rem (i32.rem_s (local.get $i) (i32.const 251)))
        (f64.store
          (i32.add (local.get $f64Ptr) (i32.shl (local.get $i) (i32.const 3)))
          (f64.mul (f64.convert_i32_s (local.get $rem)) (f64.const 0.25)))
        (i32.store
          (i32.add (local.get $i32Ptr) (i32.shl (local.get $i) (i32.const 2)))
          (i32.and (i32.mul (local.get $i) (i32.const 17)) (i32.const 1023)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top))))

  ;; Sum f64s[0..n] with left-to-right f64 add.
  (func $sumF64 (param $ptr i32) (param $n i32) (result f64)
    (local $i i32) (local $s f64)
    (local.set $s (f64.const 0))
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $s
          (f64.add (local.get $s)
            (f64.load
              (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 3))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top)))
    (local.get $s))

  ;; Sum i32s[0..n] with wrapping i32 add (matches `s += a[i]` in JS where
  ;; the result is coerced via `| 0`).
  (func $sumI32 (param $ptr i32) (param $n i32) (result i32)
    (local $i i32) (local $s i32)
    (local.set $s (i32.const 0))
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $s
          (i32.add (local.get $s)
            (i32.load
              (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 2))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top)))
    (local.get $s))

  ;; Hot loop: N_ITERS rounds, each mixes both sums into FNV-1a accumulator.
  ;; matches poly.js:
  ;;   for i in 0..N_ITERS:
  ;;     h = mix(h, sumF64(f64) | 0)
  ;;     h = mix(h, sumI32(i32) | 0)
  (func (export "runKernel")
    (param $f64Ptr i32) (param $i32Ptr i32)
    (param $n i32) (param $iters i32) (result i32)
    (local $r i32) (local $h i32)
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $r (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $r) (local.get $iters)))
        ;; h = mix(h, (f64 sum) | 0)
        (local.set $h
          (i32.mul
            (i32.xor
              (local.get $h)
              (i32.trunc_sat_f64_s (call $sumF64 (local.get $f64Ptr) (local.get $n))))
            (i32.const 0x01000193)))
        ;; h = mix(h, i32 sum)
        (local.set $h
          (i32.mul
            (i32.xor
              (local.get $h)
              (call $sumI32 (local.get $i32Ptr) (local.get $n)))
            (i32.const 0x01000193)))
        (local.set $r (i32.add (local.get $r) (i32.const 1)))
        (br $top)))
    (local.get $h))
)
