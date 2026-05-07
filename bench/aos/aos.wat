;; aos.wat — hand-written WebAssembly baseline for the aos bench.
;;
;; Reads array-of-structs (rows[i].x/y/z) and writes three SoA Float64Arrays.
;; The hand-WAT version *is* SoA on the input side too — three flat f64 columns
;; for x, y, z — because the wasm equivalent of "schema-slot read" is just an
;; offset load. This is the floor: tight f64 loop, no boxing, no schema lookup.
;;
;; Memory layout (16384 rows × 3 columns + 3 outputs ≈ 768 KiB):
;;   rowsX @ 0x0000_0000  → 16384 × f64 = 131 072 bytes
;;   rowsY @ 0x0002_0000  → 16384 × f64 = 131 072 bytes
;;   rowsZ @ 0x0004_0000  → 16384 × f64 = 131 072 bytes
;;   xs    @ 0x0006_0000  → 16384 × f64 = 131 072 bytes
;;   ys    @ 0x0008_0000  → 16384 × f64 = 131 072 bytes
;;   zs    @ 0x000a_0000  → 16384 × f64 = 131 072 bytes

(module
  (memory (export "memory") 16)

  ;; Initialize the three "row" columns — matches aos.js initRows():
  ;;   rows[i].x = i * 0.5
  ;;   rows[i].y = i + 1
  ;;   rows[i].z = (i & 7) - 3
  (func (export "initRows")
    (param $xPtr i32) (param $yPtr i32) (param $zPtr i32) (param $n i32)
    (local $i i32) (local $fi f64)
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $fi (f64.convert_i32_s (local.get $i)))
        (f64.store
          (i32.add (local.get $xPtr) (i32.shl (local.get $i) (i32.const 3)))
          (f64.mul (local.get $fi) (f64.const 0.5)))
        (f64.store
          (i32.add (local.get $yPtr) (i32.shl (local.get $i) (i32.const 3)))
          (f64.add (local.get $fi) (f64.const 1)))
        (f64.store
          (i32.add (local.get $zPtr) (i32.shl (local.get $i) (i32.const 3)))
          (f64.convert_i32_s
            (i32.sub (i32.and (local.get $i) (i32.const 7)) (i32.const 3))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top))))

  ;; Hot loop: N_ITERS outer × N inner.
  ;;   xs[i] = rx + ry * 0.25 + r
  ;;   ys[i] = ry - rz * 0.5
  ;;   zs[i] = rz + rx * 0.125
  (func (export "runKernel")
    (param $rxPtr i32) (param $ryPtr i32) (param $rzPtr i32)
    (param $xsPtr i32) (param $ysPtr i32) (param $zsPtr i32)
    (param $n i32) (param $iters i32)
    (local $r i32) (local $rf f64) (local $i i32) (local $off i32)
    (local $rx f64) (local $ry f64) (local $rz f64)
    (local.set $r (i32.const 0))
    (block $r_exit
      (loop $r_top
        (br_if $r_exit (i32.ge_s (local.get $r) (local.get $iters)))
        (local.set $rf (f64.convert_i32_s (local.get $r)))
        (local.set $i (i32.const 0))
        (block $i_exit
          (loop $i_top
            (br_if $i_exit (i32.ge_s (local.get $i) (local.get $n)))
            (local.set $off (i32.shl (local.get $i) (i32.const 3)))
            (local.set $rx (f64.load (i32.add (local.get $rxPtr) (local.get $off))))
            (local.set $ry (f64.load (i32.add (local.get $ryPtr) (local.get $off))))
            (local.set $rz (f64.load (i32.add (local.get $rzPtr) (local.get $off))))
            (f64.store
              (i32.add (local.get $xsPtr) (local.get $off))
              (f64.add
                (f64.add (local.get $rx) (f64.mul (local.get $ry) (f64.const 0.25)))
                (local.get $rf)))
            (f64.store
              (i32.add (local.get $ysPtr) (local.get $off))
              (f64.sub (local.get $ry) (f64.mul (local.get $rz) (f64.const 0.5))))
            (f64.store
              (i32.add (local.get $zsPtr) (local.get $off))
              (f64.add (local.get $rz) (f64.mul (local.get $rx) (f64.const 0.125))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $i_top)))
        (local.set $r (i32.add (local.get $r) (i32.const 1)))
        (br $r_top))))

  ;; FNV-1a over a sparse stride of one f64 column (i.e. a u32 view stride 256).
  (func $checksumF64 (param $ptr i32) (param $n i32) (result i32)
    (local $h i32) (local $i i32) (local $end i32)
    (local.set $h (i32.const 0x811c9dc5))
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
        (local.set $i (i32.add (local.get $i) (i32.const 256)))
        (br $top)))
    (local.get $h))

  ;; checksum = csF64(xs) ^ csF64(ys) ^ csF64(zs)
  (func (export "checksum")
    (param $xs i32) (param $ys i32) (param $zs i32) (param $n i32) (result i32)
    (i32.xor
      (i32.xor
        (call $checksumF64 (local.get $xs) (local.get $n))
        (call $checksumF64 (local.get $ys) (local.get $n)))
      (call $checksumF64 (local.get $zs) (local.get $n))))
)
