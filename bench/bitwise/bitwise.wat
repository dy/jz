;; bitwise.wat — hand-written WebAssembly baseline for the bitwise bench.
;;
;; i32-only hot loop: no NaN-boxing, no typed-array dispatch, just the raw
;; xor-shift-imul chain V8 sees when all abstraction is removed.
;;
;; Memory: 65536 × i32 = 256 KiB → 4 wasm pages (256 KiB).

(module
  (memory (export "memory") 4)

  ;; XorShift32 fill — matches bitwise.js init exactly.
  (func (export "init") (param $ptr i32) (param $n i32)
    (local $s i32) (local $i i32)
    (local.set $s (i32.const 0x1234abcd))
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 13))))
        (local.set $s (i32.xor (local.get $s) (i32.shr_u (local.get $s) (i32.const 17))))
        (local.set $s (i32.xor (local.get $s) (i32.shl (local.get $s) (i32.const 5))))
        (i32.store
          (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 2)))
          (local.get $s))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top))))

  ;; Hot loop: 128 rounds of the i32 mix kernel.
  ;; Per element:
  ;;   x ^= x << 7
  ;;   x ^= x >>> 9
  ;;   x = imul(x, 1103515245) + 12345
  ;;   state[i] = x ^ (x >>> 16)
  (func (export "kernel") (param $ptr i32) (param $n i32) (param $rounds i32)
    (local $r i32) (local $i i32) (local $x i32) (local $addr i32)
    (local.set $r (i32.const 0))
    (block $r_exit
      (loop $r_top
        (br_if $r_exit (i32.ge_s (local.get $r) (local.get $rounds)))
        (local.set $i (i32.const 0))
        (block $i_exit
          (loop $i_top
            (br_if $i_exit (i32.ge_s (local.get $i) (local.get $n)))
            (local.set $addr (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 2))))
            (local.set $x (i32.load (local.get $addr)))
            (local.set $x (i32.xor (local.get $x) (i32.shl (local.get $x) (i32.const 7))))
            (local.set $x (i32.xor (local.get $x) (i32.shr_u (local.get $x) (i32.const 9))))
            (local.set $x (i32.add (i32.mul (local.get $x) (i32.const 1103515245)) (i32.const 12345)))
            (local.set $x (i32.xor (local.get $x) (i32.shr_u (local.get $x) (i32.const 16))))
            (i32.store (local.get $addr) (local.get $x))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $i_top)))
        (local.set $r (i32.add (local.get $r) (i32.const 1)))
        (br $r_top))))

  ;; FNV-1a checksum over every 128th element — same stride as benchlib.
  (func (export "checksum") (param $ptr i32) (param $n i32) (result i32)
    (local $h i32) (local $i i32)
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $h
          (i32.mul
            (i32.xor
              (local.get $h)
              (i32.load (i32.add (local.get $ptr) (i32.shl (local.get $i) (i32.const 2)))))
            (i32.const 0x01000193)))
        (local.set $i (i32.add (local.get $i) (i32.const 128)))
        (br $top)))
    (local.get $h))
)
