;; callback.wat — hand-written WebAssembly baseline for the callback bench.
;;
;; This is the "floor": no NaN-boxing, no closure dispatch, no array allocation
;; per iter — just the i32 hot loop V8 sees with all abstraction removed.
;; callback.js does `a.map(x => x*scale + i)` per outer iter, which allocates a
;; fresh array each pass; the wasm floor reuses a single pre-allocated buffer
;; so the measurement is the inner compute, not the allocator.
;;
;; Memory layout (1 wasm page = 64 KiB, fits both buffers):
;;   a @ 0x0000_0000  → N × i32 = 16 384 bytes  (input)
;;   b @ 0x0000_4000  → N × i32 = 16 384 bytes  (mapped output, reused)
;; With N = 4096, total = 32 KiB.

(module
  (memory (export "memory") 1)

  ;; init(ptr, n): a[i] = (i % 97) - 48
  (func (export "init") (param $ptr i32) (param $n i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        (i32.store
          (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 2)))
          (i32.sub
            (i32.rem_s (local.get $i) (i32.const 97))
            (i32.const 48)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top))))

  ;; kernel(ptrA, ptrB, n, iters, scale) → final h (u32-as-i32)
  ;;
  ;; Per outer iter i:
  ;;   for j in 0..n:  b[j] = a[j] * scale + i
  ;;   for j = 0; j < n; j += 64: h = imul(h ^ b[j], 0x01000193)
  ;;
  ;; mix(h, x) = imul(h ^ (x|0), 0x01000193) — FNV-1a multiplier.
  ;; h is left as i32 throughout; the JS driver applies `>>> 0` for u32 print.
  (func (export "kernel")
    (param $a i32) (param $b i32) (param $n i32)
    (param $iters i32) (param $scale i32)
    (result i32)
    (local $h i32) (local $i i32) (local $j i32)
    (local $bAddr i32)
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $i (i32.const 0))
    (block $iexit
      (loop $iloop
        (br_if $iexit (i32.ge_s (local.get $i) (local.get $iters)))
        ;; map: b[j] = a[j] * scale + i
        (local.set $j (i32.const 0))
        (block $mexit
          (loop $mloop
            (br_if $mexit (i32.ge_s (local.get $j) (local.get $n)))
            (i32.store
              (i32.add (local.get $b) (i32.shl (local.get $j) (i32.const 2)))
              (i32.add
                (i32.mul
                  (i32.load
                    (i32.add (local.get $a) (i32.shl (local.get $j) (i32.const 2))))
                  (local.get $scale))
                (local.get $i)))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $mloop)))
        ;; fold stride-64
        (local.set $j (i32.const 0))
        (block $fexit
          (loop $floop
            (br_if $fexit (i32.ge_s (local.get $j) (local.get $n)))
            (local.set $bAddr
              (i32.add (local.get $b) (i32.shl (local.get $j) (i32.const 2))))
            (local.set $h
              (i32.mul
                (i32.xor (local.get $h) (i32.load (local.get $bAddr)))
                (i32.const 0x01000193)))
            (local.set $j (i32.add (local.get $j) (i32.const 64)))
            (br $floop)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iloop)))
    (local.get $h))
)
