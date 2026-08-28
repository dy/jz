/**
 * Math.sumPrecise(iterable) — exact, correctly-rounded summation (ECMA-262).
 * Pure move from module/math.js (pipeline-minimality): a self-contained
 * algorithm (2304-bit fixed-point accumulator) with zero shared helpers —
 * doesn't touch math.js's f/fn/canon/isIntCertain emit-dispatch layer at
 * all, only generic imports plus its own deps-table entry (which stays in
 * math.js's flat deps({...}) map, unaffected by where the registration
 * lives).
 *
 * @module math/sum-precise
 */
import { typed, asF64 } from '../../src/ir.js'
import { emit, reg, wat } from '../../src/bridge.js'
import { ctx, err } from '../../src/ctx.js'
import { PTR, TYPED_ELEM_BIGINT_FLAG } from '../../layout.js'

export const registerSumPrecise = () => {
  // Math.sumPrecise(iterable) — exact, correctly-rounded summation (ECMA-262).
  // jz models arrays and typed arrays: the WAT routine dispatches on the pointer
  // tag (packed f64 cells vs the kind-aware element read). Spec-TypeError inputs
  // (numbers, atoms, strings, BigInt element kinds) yield NaN — jz's total error
  // model. Only a literal scalar argument rejects at compile: an unannotated
  // param defaults to the number rep, so a rep-based check would err legit code.
  reg('math.sumPrecise', ['math.sumPrecise'], arr => {
    // An AST-literal scalar (`[null, 5]` / bare number / string literal) is a
    // proven wrong argument — loud reject. Param-shaped args stay runtime-total:
    // an unannotated param defaults to the number rep, so a rep check would err
    // legit code.
    if (typeof arr === 'number' || (Array.isArray(arr) && ((arr[0] == null && typeof arr[1] === 'number') || arr[0] === 'str')))
      err('Math.sumPrecise expects an array of numbers')
    // Host callers can pass any TypedArray to an exported (arr) => … no matter
    // what the source names — the kind-aware reader must exist unconditionally.
    ctx.module.include('typedarray')
    return typed(['call', '$math.sumPrecise', ['i64.reinterpret_f64', asF64(emit(arr))]], 'f64')
  })

  wat('math.sumPrecise', `(func $math.sumPrecise (param $arr i64) (result f64)
    ;; Exact summation via a 2304-bit fixed-point accumulator (36 i64 words,
    ;; little-endian two's complement) holding sum*2^1074. Every finite f64 is an
    ;; integer multiple of 2^-1074, so the running sum carries zero rounding
    ;; error; a single ties-to-even rounding at the end yields the result.
    (local $base i32) (local $n i32) (local $i i32) (local $acc i32) (local $addr i32) (local $j i32)
    (local $b i64) (local $exp i32) (local $sig i64) (local $shift i32) (local $wi i32) (local $bo i32)
    (local $lo i64) (local $hi i64) (local $loW i64) (local $hiW i64) (local $ext i64) (local $neg i32)
    (local $carry i32) (local $old i64) (local $s i64) (local $s2 i64) (local $addend i64)
    (local $sawNaN i32) (local $posInf i32) (local $negInf i32) (local $allNegZero i32)
    (local $L i32) (local $word i64) (local $resultNeg i32)
    (local $rwi i32) (local $rbo i32) (local $top i64) (local $roundBit i64) (local $sticky i32) (local $k i32)
    (local $pow f64) (local $res f64) (local $ptype i32) (local $isTyped i32)
    ;; Input dispatch on the pointer tag. A genuine (non-NaN-boxed) f64 is never a
    ;; pointer — self-equality proves it — and it, like every non-ARRAY/non-TYPED
    ;; tag (atoms, strings, objects) and the BigInt element kinds, is the spec's
    ;; TypeError case: NaN under jz's total error model, before any memory read.
    (if (f64.eq (f64.reinterpret_i64 (local.get $arr)) (f64.reinterpret_i64 (local.get $arr)))
      (then (return (f64.const nan))))
    (local.set $ptype (call $__ptr_type (local.get $arr)))
    (if (i32.and (i32.ne (local.get $ptype) (i32.const ${PTR.ARRAY}))
                 (i32.ne (local.get $ptype) (i32.const ${PTR.TYPED})))
      (then (return (f64.const nan))))
    (local.set $isTyped (i32.eq (local.get $ptype) (i32.const ${PTR.TYPED})))
    (if (local.get $isTyped) (then
      (if (i32.and (call $__ptr_aux (local.get $arr)) (i32.const ${TYPED_ELEM_BIGINT_FLAG}))
        (then (return (f64.const nan))))))
    ;; allocate + zero 36 i64 words
    (local.set $acc (call $__alloc (i32.const 288)))
    (local.set $j (i32.const 0))
    (block $zdone (loop $zero
      (br_if $zdone (i32.ge_u (local.get $j) (i32.const 288)))
      (i64.store (i32.add (local.get $acc) (local.get $j)) (i64.const 0))
      (local.set $j (i32.add (local.get $j) (i32.const 8)))
      (br $zero)))
    (local.set $allNegZero (i32.const 1))
    (local.set $base (call $__ptr_offset (local.get $arr)))
    (local.set $n (call $__len (local.get $arr)))
    ;; accumulate every element
    (local.set $i (i32.const 0))
    (block $idone (loop $iter
      (br_if $idone (i32.ge_u (local.get $i) (local.get $n)))
      (block $next
        ;; ARRAY: element cells are raw f64 bits at stride 8. TYPED: the canonical
        ;; kind-aware read (u8…u32 exact int→f64, f16/f32 exact promote, views).
        (local.set $b (if (result i64) (local.get $isTyped)
          (then (i64.reinterpret_f64 (call $__typed_get_idx (local.get $arr) (local.get $i))))
          (else (i64.load (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 3)))))))
        (local.set $exp (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const 52)) (i64.const 0x7ff))))
        (local.set $sig (i64.and (local.get $b) (i64.const 0xfffffffffffff)))
        (local.set $neg (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const 63))))
        ;; NaN / +-Infinity
        (if (i32.eq (local.get $exp) (i32.const 0x7ff))
          (then
            (if (i64.ne (local.get $sig) (i64.const 0))
              (then (local.set $sawNaN (i32.const 1)))
              (else (if (local.get $neg)
                (then (local.set $negInf (i32.const 1)))
                (else (local.set $posInf (i32.const 1))))))
            (br $next)))
        ;; -0 tracking: any element not bit-identical to -0 clears allNegZero
        (if (i64.ne (local.get $b) (i64.const 0x8000000000000000))
          (then (local.set $allNegZero (i32.const 0))))
        ;; +-0 contributes nothing
        (if (i32.and (i32.eqz (local.get $exp)) (i64.eqz (local.get $sig)))
          (then (br $next)))
        ;; significand + bit shift: normal adds the implicit bit, shift=exp-1; subnormal shift=0
        (if (i32.eqz (local.get $exp))
          (then (local.set $shift (i32.const 0)))
          (else
            (local.set $sig (i64.or (local.get $sig) (i64.const 0x10000000000000)))
            (local.set $shift (i32.sub (local.get $exp) (i32.const 1)))))
        (local.set $wi (i32.shr_u (local.get $shift) (i32.const 6)))
        (local.set $bo (i32.and (local.get $shift) (i32.const 63)))
        (local.set $lo (i64.shl (local.get $sig) (i64.extend_i32_u (local.get $bo))))
        (local.set $hi (if (result i64) (i32.eqz (local.get $bo))
          (then (i64.const 0))
          (else (i64.shr_u (local.get $sig) (i64.extend_i32_u (i32.sub (i32.const 64) (local.get $bo)))))))
        ;; subtraction of a negative element = adding (~M)+1 with sign-extension ext=-1
        (local.set $ext (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $neg))))
        (local.set $loW (i64.xor (local.get $lo) (local.get $ext)))
        (local.set $hiW (i64.xor (local.get $hi) (local.get $ext)))
        (local.set $carry (local.get $neg))
        (local.set $j (local.get $wi))
        (block $adone (loop $add
          (br_if $adone (i32.ge_u (local.get $j) (i32.const 36)))
          (local.set $addend (select (local.get $loW)
            (select (local.get $hiW) (local.get $ext)
              (i32.eq (local.get $j) (i32.add (local.get $wi) (i32.const 1))))
            (i32.eq (local.get $j) (local.get $wi))))
          (local.set $addr (i32.add (local.get $acc) (i32.shl (local.get $j) (i32.const 3))))
          (local.set $old (i64.load (local.get $addr)))
          (local.set $s (i64.add (local.get $old) (local.get $addend)))
          (local.set $s2 (i64.add (local.get $s) (i64.extend_i32_u (local.get $carry))))
          (local.set $carry (i32.or (i64.lt_u (local.get $s) (local.get $old)) (i64.lt_u (local.get $s2) (local.get $s))))
          (i64.store (local.get $addr) (local.get $s2))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))
          (br $add))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $iter)))
    ;; special results
    (if (local.get $sawNaN) (then (return (f64.const nan))))
    (if (i32.and (local.get $posInf) (local.get $negInf)) (then (return (f64.const nan))))
    (if (local.get $posInf) (then (return (f64.const inf))))
    (if (local.get $negInf) (then (return (f64.neg (f64.const inf)))))
    ;; sign of accumulator = top bit of word 35; negate the magnitude if set
    (local.set $resultNeg (i32.wrap_i64 (i64.shr_u (i64.load (i32.add (local.get $acc) (i32.const 280))) (i64.const 63))))
    (if (local.get $resultNeg) (then
      (local.set $j (i32.const 0))
      (local.set $carry (i32.const 1))
      (block $ndone (loop $negl
        (br_if $ndone (i32.ge_u (local.get $j) (i32.const 36)))
        (local.set $addr (i32.add (local.get $acc) (i32.shl (local.get $j) (i32.const 3))))
        (local.set $old (i64.xor (i64.load (local.get $addr)) (i64.const -1)))
        (local.set $s (i64.add (local.get $old) (i64.extend_i32_u (local.get $carry))))
        (local.set $carry (i64.lt_u (local.get $s) (local.get $old)))
        (i64.store (local.get $addr) (local.get $s))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $negl)))))
    ;; bit length L (scan words high -> low)
    (local.set $L (i32.const 0))
    (local.set $j (i32.const 35))
    (block $ldone (loop $lscan
      (local.set $word (i64.load (i32.add (local.get $acc) (i32.shl (local.get $j) (i32.const 3)))))
      (if (i64.ne (local.get $word) (i64.const 0))
        (then
          (local.set $L (i32.sub (i32.add (i32.mul (local.get $j) (i32.const 64)) (i32.const 64))
            (i32.wrap_i64 (i64.clz (local.get $word)))))
          (br $ldone)))
      (br_if $ldone (i32.eqz (local.get $j)))
      (local.set $j (i32.sub (local.get $j) (i32.const 1)))
      (br $lscan)))
    ;; sum is exactly zero: -0 for empty input or an all-(-0) list, else +0
    (if (i32.eqz (local.get $L)) (then
      (return (if (result f64) (i32.or (i32.eqz (local.get $n)) (local.get $allNegZero))
        (then (f64.reinterpret_i64 (i64.const 0x8000000000000000)))
        (else (f64.const 0))))))
    ;; magnitude fits in 53 bits: exact, scale by 2^-1074 (reinterpret of i64 1)
    (if (i32.le_u (local.get $L) (i32.const 53)) (then
      (local.set $res (f64.mul (f64.convert_i64_u (i64.load (local.get $acc))) (f64.reinterpret_i64 (i64.const 1))))
      (return (select (f64.neg (local.get $res)) (local.get $res) (local.get $resultNeg)))))
    ;; round to nearest f64 (ties-to-even). top 53 bits start at bit L-53.
    (local.set $wi (i32.shr_u (i32.sub (local.get $L) (i32.const 53)) (i32.const 6)))
    (local.set $bo (i32.and (i32.sub (local.get $L) (i32.const 53)) (i32.const 63)))
    (local.set $top (i64.shr_u (i64.load (i32.add (local.get $acc) (i32.shl (local.get $wi) (i32.const 3)))) (i64.extend_i32_u (local.get $bo))))
    (if (i32.ne (local.get $bo) (i32.const 0)) (then
      (local.set $top (i64.or (local.get $top)
        (i64.shl (i64.load (i32.add (local.get $acc) (i32.shl (i32.add (local.get $wi) (i32.const 1)) (i32.const 3))))
          (i64.extend_i32_u (i32.sub (i32.const 64) (local.get $bo))))))))
    (local.set $top (i64.and (local.get $top) (i64.const 0x1fffffffffffff)))
    ;; round bit at L-54, sticky = OR of every lower bit
    (local.set $rwi (i32.shr_u (i32.sub (local.get $L) (i32.const 54)) (i32.const 6)))
    (local.set $rbo (i32.and (i32.sub (local.get $L) (i32.const 54)) (i32.const 63)))
    (local.set $roundBit (i64.and (i64.shr_u (i64.load (i32.add (local.get $acc) (i32.shl (local.get $rwi) (i32.const 3)))) (i64.extend_i32_u (local.get $rbo))) (i64.const 1)))
    (local.set $sticky (i32.const 0))
    (local.set $j (i32.const 0))
    (block $sdone (loop $sscan
      (br_if $sdone (i32.ge_u (local.get $j) (local.get $rwi)))
      (if (i64.ne (i64.load (i32.add (local.get $acc) (i32.shl (local.get $j) (i32.const 3)))) (i64.const 0))
        (then (local.set $sticky (i32.const 1))))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $sscan)))
    (if (i64.ne (i64.and (i64.load (i32.add (local.get $acc) (i32.shl (local.get $rwi) (i32.const 3))))
                         (i64.sub (i64.shl (i64.const 1) (i64.extend_i32_u (local.get $rbo))) (i64.const 1)))
                (i64.const 0))
      (then (local.set $sticky (i32.const 1))))
    (if (i32.and (i64.eq (local.get $roundBit) (i64.const 1))
                 (i32.or (local.get $sticky) (i32.wrap_i64 (i64.and (local.get $top) (i64.const 1)))))
      (then (local.set $top (i64.add (local.get $top) (i64.const 1)))))
    ;; result = top * 2^k where k is the exponent of top's low bit
    (local.set $k (i32.sub (local.get $L) (i32.const 1127)))
    (if (i32.ge_s (local.get $k) (i32.const 1024)) (then
      (return (select (f64.neg (f64.const inf)) (f64.const inf) (local.get $resultNeg)))))
    (local.set $pow (if (result f64) (i32.ge_s (local.get $k) (i32.const -1022))
      (then (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u (i32.add (local.get $k) (i32.const 1023))) (i64.const 52))))
      (else (f64.reinterpret_i64 (i64.shl (i64.const 1) (i64.extend_i32_u (i32.add (local.get $k) (i32.const 1074))))))))
    (local.set $res (f64.mul (f64.convert_i64_u (local.get $top)) (local.get $pow)))
    (select (f64.neg (local.get $res)) (local.get $res) (local.get $resultNeg)))`)
}
