/**
 * binary16 ↔ f64 conversion (Float16Array / DataView.getFloat16 / Math.f16round).
 * Pure move out of module/core.js (pipeline-minimality core split) — already
 * delimited by the original file's own `// === binary16 ↔ f64 ===` header.
 * Neither function is referenced anywhere else in core.js; module/typedarray.js
 * reaches both exclusively via `inc('__f16_to_f64'|'__f64_to_f16')`/`deps()`/raw
 * `call $__f16_to_f64` WAT text — a runtime name dependency, unaffected by which
 * file performs the `ctx.core.stdlib[name] = …` registration.
 *
 * @module core/f16
 */
import { ctx } from '../../src/ctx.js'
import { nanPrefixHex } from '../../layout.js'

export const registerF16 = () => {
  // Pure-integer, exactly rounded — f64 → f16 rounds DIRECTLY off the f64 bits
  // (an f32 hop double-rounds at the overflow boundary: 65519.999… must round
  // to 65504, not Inf). f16 → f64 is exact by construction (every half is a
  // double). NaN canonicalizes (sign/payload dropped) so `v !== v` stays sound
  // on jz's canonical-NaN model.
  ctx.core.stdlib['__f16_to_f64'] = `(func $__f16_to_f64 (param $b i32) (result f64)
    (local $h i32) (local $e i32) (local $m i32) (local $r f64)
    (local.set $h (i32.and (local.get $b) (i32.const 0x7FFF)))
    (local.set $e (i32.shr_u (local.get $h) (i32.const 10)))
    (local.set $m (i32.and (local.get $h) (i32.const 0x3FF)))
    (if (i32.eq (local.get $e) (i32.const 31))
      (then
        (if (local.get $m)
          (then (return (f64.reinterpret_i64 (i64.const ${nanPrefixHex()}))))
          (else (return (f64.reinterpret_i64 (i64.or (i64.const 0x7FF0000000000000)
            (i64.shl (i64.extend_i32_u (i32.and (local.get $b) (i32.const 0x8000))) (i64.const 48)))))))))
    (if (i32.eqz (local.get $e))
      ;; subnormal: mant · 2^-24 (exact — integer times a power of two)
      (then (local.set $r (f64.mul (f64.convert_i32_u (local.get $m)) (f64.const 5.960464477539063e-8))))
      (else (local.set $r (f64.reinterpret_i64 (i64.or
        (i64.shl (i64.extend_i32_u (i32.add (local.get $e) (i32.const 1008))) (i64.const 52))
        (i64.shl (i64.extend_i32_u (local.get $m)) (i64.const 42)))))))
    (f64.reinterpret_i64 (i64.or (i64.reinterpret_f64 (local.get $r))
      (i64.shl (i64.extend_i32_u (i32.and (local.get $b) (i32.const 0x8000))) (i64.const 48)))))`

  ctx.core.stdlib['__f64_to_f16'] = `(func $__f64_to_f16 (param $v f64) (result i32)
    (local $u i64) (local $sign i32) (local $ne i32) (local $half i32)
    (local $m i64) (local $full i64) (local $sh i64) (local $rb i64) (local $hp i64)
    (local.set $u (i64.reinterpret_f64 (local.get $v)))
    (local.set $sign (i32.wrap_i64 (i64.and (i64.shr_u (local.get $u) (i64.const 48)) (i64.const 0x8000))))
    (local.set $u (i64.and (local.get $u) (i64.const 0x7FFFFFFFFFFFFFFF)))
    (if (i64.ge_u (local.get $u) (i64.const 0x7FF0000000000000))
      (then (return (i32.or (local.get $sign)
        (select (i32.const 0x7E00) (i32.const 0x7C00) (i64.gt_u (local.get $u) (i64.const 0x7FF0000000000000)))))))
    (local.set $m (i64.and (local.get $u) (i64.const 0xFFFFFFFFFFFFF)))
    (local.set $ne (i32.sub (i32.wrap_i64 (i64.shr_u (local.get $u) (i64.const 52))) (i32.const 1008)))
    (if (i32.ge_s (local.get $ne) (i32.const 31))
      (then (return (i32.or (local.get $sign) (i32.const 0x7C00)))))
    (if (i32.ge_s (local.get $ne) (i32.const 1))
      (then ;; normal: 42 dropped mantissa bits round ties-to-even; a mantissa
            ;; carry overflows into the exponent or into infinity — both exact
        (local.set $half (i32.or (i32.shl (local.get $ne) (i32.const 10))
          (i32.wrap_i64 (i64.shr_u (local.get $m) (i64.const 42)))))
        (local.set $rb (i64.and (local.get $m) (i64.const 0x3FFFFFFFFFF)))
        (if (i32.or (i64.gt_u (local.get $rb) (i64.const 0x20000000000))
              (i32.and (i64.eq (local.get $rb) (i64.const 0x20000000000)) (i32.and (local.get $half) (i32.const 1))))
          (then (local.set $half (i32.add (local.get $half) (i32.const 1)))))
        (return (i32.or (local.get $sign) (local.get $half)))))
    (if (i32.lt_s (local.get $ne) (i32.const -10))
      (then (return (local.get $sign)))) ;; underflow → ±0
    ;; subnormal: shift the 53-bit significand by 43-ne (43…53), ties-to-even
    (local.set $full (i64.or (local.get $m) (i64.const 0x10000000000000)))
    (local.set $sh (i64.extend_i32_u (i32.sub (i32.const 43) (local.get $ne))))
    (local.set $half (i32.wrap_i64 (i64.shr_u (local.get $full) (local.get $sh))))
    (local.set $rb (i64.and (local.get $full) (i64.sub (i64.shl (i64.const 1) (local.get $sh)) (i64.const 1))))
    (local.set $hp (i64.shl (i64.const 1) (i64.sub (local.get $sh) (i64.const 1))))
    (if (i32.or (i64.gt_u (local.get $rb) (local.get $hp))
          (i32.and (i64.eq (local.get $rb) (local.get $hp)) (i32.and (local.get $half) (i32.const 1))))
      (then (local.set $half (i32.add (local.get $half) (i32.const 1)))))
    (i32.or (local.get $sign) (local.get $half)))`
}
