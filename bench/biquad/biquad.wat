;; biquad.wat — hand-written WebAssembly baseline for the biquad bench.
;;
;; This is the "floor": no NaN-boxing, no dispatch, no type narrowing pass —
;; just the f64 hot loop V8 sees with no abstraction in the way. Comparing
;; this against jz/porffor wasm tells us how much overhead the JS→wasm
;; compiler is adding on top of what V8's wasm tier can do natively.
;;
;; Memory layout (linear memory grown on instantiate to fit everything):
;;   x      @ 0x0000_0000  → 480000 × f64  =  3 840 000 bytes
;;   coeffs @ 0x0040_0000  → 40 × f64       =        320 bytes
;;   state  @ 0x0040_1000  → 32 × f64       =        256 bytes
;;   out    @ 0x0040_2000  → 480000 × f64  =  3 840 000 bytes
;; Total ≈ 7.7 MB, fits in 128 wasm pages (8 MB).

(module
  (memory (export "memory") 128)

  ;; XorShift32 PRNG → fills x[] with values in [-1, 1).
  ;; Matches biquad.js exactly so checksum is bit-equal to V8.
  ;;   for (let i=0;i<n;i++) {
  ;;     s ^= s<<13; s ^= s>>>17; s ^= s<<5;
  ;;     out[i] = ((s>>>0) / 2^32) * 2 - 1;
  ;;   }
  (func (export "mkInput") (param $ptr i32) (param $n i32)
    (local $s i32) (local $i i32) (local $u f64)
    (local.set $s (i32.const 0x1234abcd))
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        ;; s ^= s << 13
        (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))
        ;; s ^= s >>> 17
        (local.set $s (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 17))))
        ;; s ^= s << 5
        (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 5))))
        ;; u = (s >>> 0) / 2^32
        ;; f64.convert_i32_u handles the unsigned conversion natively.
        (local.set $u (f64.div
          (f64.convert_i32_u (local.get $s))
          (f64.const 4294967296.0)))
        ;; out[i] = u * 2 - 1
        (f64.store
          (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 3)))
          (f64.sub (f64.mul (local.get $u) (f64.const 2.0)) (f64.const 1.0)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top))))

  ;; Coefficients laid out as [b0, b1, b2, a1, a2] × n_stages.
  (func (export "mkCoeffs") (param $ptr i32) (param $n i32)
    (local $i i32) (local $base i32) (local $fi f64)
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $fi (f64.convert_i32_s (local.get $i)))
        ;; base = ptr + i * 5 * 8  (5 doubles per stage)
        (local.set $base
          (i32.add (local.get $ptr)
            (i32.shl
              (i32.mul (local.get $i) (i32.const 5))
              (i32.const 3))))
        (f64.store offset=0  (local.get $base) (f64.add (f64.const 0.10) (f64.mul (local.get $fi) (f64.const 0.001))))
        (f64.store offset=8  (local.get $base) (f64.sub (f64.const 0.20) (f64.mul (local.get $fi) (f64.const 0.0005))))
        (f64.store offset=16 (local.get $base) (f64.const 0.10))
        (f64.store offset=24 (local.get $base) (f64.add (f64.const -1.50) (f64.mul (local.get $fi) (f64.const 0.01))))
        (f64.store offset=32 (local.get $base) (f64.sub (f64.const 0.60) (f64.mul (local.get $fi) (f64.const 0.005))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top))))

  ;; Zero a region of memory by f64-stride.
  (func (export "zero") (param $ptr i32) (param $n i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        (f64.store
          (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 3)))
          (f64.const 0))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top))))

  ;; Hot loop: 8-stage biquad cascade.
  ;;
  ;; Layout invariants:
  ;;   coeffs[s*5+0..4] = [b0, b1, b2, a1, a2]
  ;;   state [s*4+0..3] = [x1, x2, y1, y2]
  ;;
  ;; Per sample:
  ;;   v = x[i]
  ;;   for s in 0..n_stages:
  ;;     y = b0*v + b1*x1 + b2*x2 - a1*y1 - a2*y2
  ;;     state = [v, x1, y, y1]
  ;;     v = y
  ;;   out[i] = v
  (func (export "processCascade")
    (param $x i32) (param $coeffs i32) (param $state i32)
    (param $nStages i32) (param $out i32) (param $n i32)
    (local $i i32) (local $s i32)
    (local $cBase i32) (local $sBase i32)
    (local $b0 f64) (local $b1 f64) (local $b2 f64) (local $a1 f64) (local $a2 f64)
    (local $x1 f64) (local $x2 f64) (local $y1 f64) (local $y2 f64)
    (local $v f64) (local $y f64)
    (local.set $i (i32.const 0))
    (block $iexit
      (loop $iloop
        (br_if $iexit (i32.ge_s (local.get $i) (local.get $n)))
        ;; v = x[i]
        (local.set $v (f64.load
          (i32.add (local.get $x) (i32.shl (local.get $i) (i32.const 3)))))
        (local.set $s (i32.const 0))
        (block $sexit
          (loop $sloop
            (br_if $sexit (i32.ge_s (local.get $s) (local.get $nStages)))
            ;; cBase = coeffs + s * 5 * 8
            (local.set $cBase
              (i32.add (local.get $coeffs)
                (i32.shl (i32.mul (local.get $s) (i32.const 5)) (i32.const 3))))
            ;; sBase = state + s * 4 * 8
            (local.set $sBase
              (i32.add (local.get $state)
                (i32.shl (local.get $s) (i32.const 5))))
            (local.set $b0 (f64.load offset=0  (local.get $cBase)))
            (local.set $b1 (f64.load offset=8  (local.get $cBase)))
            (local.set $b2 (f64.load offset=16 (local.get $cBase)))
            (local.set $a1 (f64.load offset=24 (local.get $cBase)))
            (local.set $a2 (f64.load offset=32 (local.get $cBase)))
            (local.set $x1 (f64.load offset=0  (local.get $sBase)))
            (local.set $x2 (f64.load offset=8  (local.get $sBase)))
            (local.set $y1 (f64.load offset=16 (local.get $sBase)))
            (local.set $y2 (f64.load offset=24 (local.get $sBase)))
            ;; y = ((((b0*v + b1*x1) + b2*x2) - a1*y1) - a2*y2)
            ;; Left-to-right f64 ops to match biquad.js bit-exactly.
            (local.set $y
              (f64.sub
                (f64.sub
                  (f64.add
                    (f64.add
                      (f64.mul (local.get $b0) (local.get $v))
                      (f64.mul (local.get $b1) (local.get $x1)))
                    (f64.mul (local.get $b2) (local.get $x2)))
                  (f64.mul (local.get $a1) (local.get $y1)))
                (f64.mul (local.get $a2) (local.get $y2))))
            ;; state = [v, x1, y, y1]
            (f64.store offset=0  (local.get $sBase) (local.get $v))
            (f64.store offset=8  (local.get $sBase) (local.get $x1))
            (f64.store offset=16 (local.get $sBase) (local.get $y))
            (f64.store offset=24 (local.get $sBase) (local.get $y1))
            (local.set $v (local.get $y))
            (local.set $s (i32.add (local.get $s) (i32.const 1)))
            (br $sloop)))
        ;; out[i] = v
        (f64.store
          (i32.add (local.get $out) (i32.shl (local.get $i) (i32.const 3)))
          (local.get $v))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iloop))))

  ;; FNV-1a over a sparse stride of the f64 output's i32 view.
  ;; out[] is f64; we read 32-bit u32 lanes at every (4096*4)-byte stride.
  (func (export "checksum") (param $ptr i32) (param $n i32) (result i32)
    (local $h i32) (local $i i32) (local $end i32)
    (local.set $h (i32.const 0x811c9dc5))
    ;; u.length = n * 2 (u32 view of f64 buffer), iterate i = 0, 4096, 8192, ...
    ;; byte offset = i * 4 (since u32 stride). end = (n*2) in u32 units.
    (local.set $end (i32.shl (local.get $n) (i32.const 1)))
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_u (local.get $i) (local.get $end)))
        (local.set $h
          (i32.mul
            (i32.xor
              (local.get $h)
              (i32.load
                (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 2)))))
            (i32.const 0x01000193)))
        (local.set $i (i32.add (local.get $i) (i32.const 4096)))
        (br $top)))
    (local.get $h))
)
