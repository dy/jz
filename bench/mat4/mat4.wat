;; mat4.wat — hand-written WebAssembly baseline for the mat4 bench.
;;
;; Bare f64 4×4 multiply with a tiny perturbation swap at the end of each
;; iteration.  No allocations, no dispatch — just the loop shape V8 sees
;; when all JS abstraction is removed.
;;
;; Memory layout (1 page is plenty):
;;   a   @ 0   → 16 × f64 = 128 bytes
;;   b   @ 128 → 16 × f64 = 128 bytes
;;   out @ 256 → 16 × f64 = 128 bytes

(module
  (memory (export "memory") 1)

  ;; 4×4 multiply: out = a * b, then perturb a[0] and a[5].
  ;; iters is passed as f64 because the JS source uses `n * 0.0000001`.
  (func (export "multiplyMany")
    (param $a i32) (param $b i32) (param $out i32) (param $iters i32)
    (local $n i32) (local $r i32) (local $c i32) (local $k i32)
    (local $s f64) (local $sum f64) (local $t f64)
    (local.set $n (i32.const 0))
    (block $n_exit
      (loop $n_top
        (br_if $n_exit (i32.ge_s (local.get $n) (local.get $iters)))

        ;; out[r][c] = sum_k a[r][k] * b[k][c]
        (local.set $r (i32.const 0))
        (block $r_exit
          (loop $r_top
            (br_if $r_exit (i32.ge_s (local.get $r) (i32.const 4)))
            (local.set $c (i32.const 0))
            (block $c_exit
              (loop $c_top
                (br_if $c_exit (i32.ge_s (local.get $c) (i32.const 4)))
                (local.set $sum (f64.const 0))
                (local.set $k (i32.const 0))
                (block $k_exit
                  (loop $k_top
                    (br_if $k_exit (i32.ge_s (local.get $k) (i32.const 4)))
                    (local.set $sum
                      (f64.add
                        (local.get $sum)
                        (f64.mul
                          (f64.load
                            (i32.add (local.get $a)
                              (i32.shl
                                (i32.add (i32.mul (local.get $r) (i32.const 4)) (local.get $k))
                                (i32.const 3))))
                          (f64.load
                            (i32.add (local.get $b)
                              (i32.shl
                                (i32.add (i32.mul (local.get $k) (i32.const 4)) (local.get $c))
                                (i32.const 3)))))))
                    (local.set $k (i32.add (local.get $k) (i32.const 1)))
                    (br $k_top)))
                ;; out[r*4+c] = sum + n * 0.0000001
                (f64.store
                  (i32.add (local.get $out)
                    (i32.shl (i32.add (i32.mul (local.get $r) (i32.const 4)) (local.get $c)) (i32.const 3)))
                  (f64.add (local.get $sum) (f64.mul (f64.convert_i32_s (local.get $n)) (f64.const 0.0000001))))
                (local.set $c (i32.add (local.get $c) (i32.const 1)))
                (br $c_top)))
            (local.set $r (i32.add (local.get $r) (i32.const 1)))
            (br $r_top)))

        ;; dynamic perturbation from JS source:
        ;;   t = a[0]; a[0] = out[15]; a[5] = t + out[10] * 0.000001;
        ;;   b[0] += out[0] * 0.00000000001; b[5] -= out[5] * 0.00000000001;
        (local.set $t (f64.load (local.get $a)))
        (f64.store (local.get $a)
          (f64.load (i32.add (local.get $out) (i32.const 120)))) ;; out[15] @ 256+120
        (f64.store
          (i32.add (local.get $a) (i32.const 40))
          (f64.add (local.get $t)
            (f64.mul (f64.load (i32.add (local.get $out) (i32.const 80))) (f64.const 0.000001)))) ;; out[10] @ 256+80
        (f64.store (local.get $b)
          (f64.add
            (f64.load (local.get $b))
            (f64.mul (f64.load (local.get $out)) (f64.const 0.00000000001))))
        (f64.store
          (i32.add (local.get $b) (i32.const 40))
          (f64.sub
            (f64.load (i32.add (local.get $b) (i32.const 40)))
            (f64.mul (f64.load (i32.add (local.get $out) (i32.const 40))) (f64.const 0.00000000001))))

        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (br $n_top))))

  ;; FNV-1a over the lower u32 of out[0] (stride 256 only touches index 0 for 16-element array).
  (func (export "checksum") (param $out i32) (result i32)
    (local $h i32)
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $h
      (i32.mul
        (i32.xor (local.get $h) (i32.load (local.get $out)))
        (i32.const 0x01000193)))
    (local.get $h))
)
