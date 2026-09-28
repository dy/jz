/**
 * f64x2 twins of the scalar math kernels, for the vectorizer's lifts (src/optimize/vectorize,
 * PPC_CALL2) and the f64x2.* intrinsics (module/simd.js). Every lane is bit for bit its
 * scalar kernel's: sin2/cos2/log_v/exp_v/pow2 take both lanes through one evaluation of the
 * scalar's operations where both lanes are on its common path, choosing per lane where the
 * scalar branches, and hand anything else to the scalar kernel lane by lane; the rest are
 * lane-by-lane scalar calls. Consumers reach them by name, never a JS symbol, so this file
 * is a one-way leaf off math/trig-tables.js.
 *
 * @module math/simd
 */
import { wat } from '../../src/bridge.js'
import { ctx } from '../../src/ctx.js'
import {
  EXP2_Q, EXP_Q, EXP_L1, EXP_L2, POW_LN2HI, POW_LN2LO, POW_LOG_A, polyTree,
  INVPIO2, PIO2_1, PIO2_1T, KSIN, KCOS, LG, LN2_HI, LN2_LO, INVLN2, EXP_P, EXP_E,
} from './trig-tables.js'

export const registerMathSimd = () => {
  const crPow = !!ctx.transform.optimize?.crPow
  const splat = (c) => `(f64x2.splat (f64.const ${c}))`
  const i32s = (v) => `(i32x4.splat (i32.const ${v}))`
  const i64s = (v) => `(i64x2.splat (i64.const ${v}))`
  // The shared evaluation tree in 2-wide WAT — bit-exact with the scalar builder
  // and the JS folder because all three walk the same tree (trig-tables.js).
  const horner2 = (cs, v = '$r2') => polyTree(cs, {
    konst: splat,
    mul: (a, b) => `(f64x2.mul ${a} ${b})`,
    add: (a, b) => `(f64x2.add ${a} ${b})`,
  }, `(local.get ${v})`)
  // c0 + z*(c1 + z*(c2 + …)) as the fdlibm C nests it (module/math/ieee754.js's poly)
  const poly2 = (z, cs) => cs.length === 1 ? splat(cs[0]) : `(f64x2.add ${splat(cs[0])} (f64x2.mul (local.get ${z}) ${poly2(z, cs.slice(1))}))`
  // the two lanes' high words as i32 lanes [h0 h1 h0 h1]; a double from high words [h0 h1 . .] and zero low words
  const hi2 = (v) => `(i8x16.shuffle 4 5 6 7 12 13 14 15 4 5 6 7 12 13 14 15 ${v} ${v})`
  const fromHi2 = (h) => `(i8x16.shuffle 16 16 16 16 0 1 2 3 16 16 16 16 4 5 6 7 ${h} (v128.const i32x4 0 0 0 0))`
  const wide = (m) => `(i64x2.extend_low_i32x4_s ${m})`   // an i32-lane mask over the two f64 lanes
  // both lanes through the scalar kernel
  const lanes = (fn, args) => `(f64x2.replace_lane 1
      (f64x2.splat (call $${fn} ${args.map(a => `(f64x2.extract_lane 0 (local.get $${a}))`).join(' ')}))
      (call $${fn} ${args.map(a => `(f64x2.extract_lane 1 (local.get $${a}))`).join(' ')}))`
  const repack = (name, fn, args) => wat(name, `(func $${name} ${args.map(a => `(param $${a} v128)`).join(' ')} (result v128)
    ${lanes(fn, args)})`, [fn])

  // sin and cos (module/math/ieee754.js): both lanes below 2^19·π/2, reduced by n·π/2 as
  // __ieee754_rem_pio2 does (n = 0 up to π/4, 1 up to 3π/4, ⌊|x|·2/π + ½⌋ past it, one
  // subtraction of n·pio2_1 and n·pio2_1t while it cancels at most 16 bits), then both
  // kernels on both lanes and the one n mod 4 picks. A lane past 2^19·π/2, at the high word
  // 0x3ff921fb (which subtracts π/2 in three pieces), cancelling more, or not finite: scalar.
  // At n = 0, __kernel_sin's iy = 0 form; __kernel_cos's qx is 0 below 0.3, which is its
  // plain form.
  const [S1, S2, S3, S4, S5, S6] = KSIN
  const trig2 = (name, cos) => wat(`math.${name}2`, `(func $math.${name}2 (param $x v128) (result v128)
    (local $hw v128) (local $ix v128) (local $small v128) (local $mid v128) (local $n v128) (local $t v128) (local $fn v128)
    (local $r v128) (local $w v128) (local $y0 v128) (local $y1 v128) (local $neg v128) (local $iy v128) (local $tiny v128)
    (local $z v128) (local $v v128) (local $rs v128) (local $ks v128) (local $kc v128) (local $qx v128) (local $q v128)
    (local.set $hw ${hi2('(local.get $x)')})
    (local.set $ix (v128.and (local.get $hw) ${i32s(0x7fffffff)}))
    (if (i32.eqz (i32x4.all_true (v128.and (i32x4.le_s (local.get $ix) ${i32s(0x413921fb)}) (i32x4.ne (local.get $ix) ${i32s(0x3ff921fb)}))))
      (then (return ${lanes(`math.${name}`, ['x'])})))
    (local.set $small (i32x4.le_s (local.get $ix) ${i32s(0x3fe921fb)}))
    (local.set $mid (i32x4.lt_s (local.get $ix) ${i32s(0x4002d97c)}))
    (local.set $t (f64x2.abs (local.get $x)))
    (local.set $n (v128.bitselect (v128.const i32x4 0 0 0 0)
      (v128.bitselect (v128.const i32x4 1 1 1 1)
        (i32x4.trunc_sat_f64x2_s_zero (f64x2.add (f64x2.mul (local.get $t) ${splat(INVPIO2)}) ${splat(0.5)}))
        (local.get $mid))
      (local.get $small)))
    (local.set $fn (f64x2.convert_low_i32x4_s (local.get $n)))
    (local.set $r (f64x2.sub (local.get $t) (f64x2.mul (local.get $fn) ${splat(PIO2_1)})))
    (local.set $w (f64x2.mul (local.get $fn) ${splat(PIO2_1T)}))
    (local.set $y0 (f64x2.sub (local.get $r) (local.get $w)))
    (if (i32.eqz (i32x4.all_true (v128.or (local.get $mid)
          (i32x4.le_s (i32x4.sub (i32x4.shr_s (local.get $ix) (i32.const 20))
            (v128.and (i32x4.shr_u ${hi2('(local.get $y0)')} (i32.const 20)) ${i32s(0x7ff)})) ${i32s(16)}))))
      (then (return ${lanes(`math.${name}`, ['x'])})))
    (local.set $y1 (f64x2.sub (f64x2.sub (local.get $r) (local.get $y0)) (local.get $w)))
    ;; a negative x: −y0, −y1, −n
    (local.set $neg (i32x4.lt_s (local.get $hw) (v128.const i32x4 0 0 0 0)))
    (local.set $y0 (v128.xor (local.get $y0) (v128.and ${wide('(local.get $neg)')} ${splat('-0')})))
    (local.set $y1 (v128.xor (local.get $y1) (v128.and ${wide('(local.get $neg)')} ${splat('-0')})))
    (local.set $n (v128.bitselect (i32x4.neg (local.get $n)) (local.get $n) (local.get $neg)))
    ;; __kernel_sin and __kernel_cos on y0 + y1: x itself and 1 below 2^-27
    (local.set $iy (v128.and ${hi2('(local.get $y0)')} ${i32s(0x7fffffff)}))
    (local.set $tiny ${wide(`(i32x4.lt_s (local.get $iy) ${i32s(0x3e400000)})`)})
    (local.set $z (f64x2.mul (local.get $y0) (local.get $y0)))
    (local.set $v (f64x2.mul (local.get $z) (local.get $y0)))
    (local.set $rs ${poly2('$z', [S2, S3, S4, S5, S6])})
    (local.set $ks (v128.bitselect (local.get $y0)
      (v128.bitselect
        (f64x2.add (local.get $y0) (f64x2.mul (local.get $v) (f64x2.add ${splat(S1)} (f64x2.mul (local.get $z) (local.get $rs)))))
        (f64x2.sub (local.get $y0) (f64x2.sub (f64x2.sub (f64x2.mul (local.get $z)
          (f64x2.sub (f64x2.mul ${splat(0.5)} (local.get $y1)) (f64x2.mul (local.get $v) (local.get $rs)))) (local.get $y1))
          (f64x2.mul (local.get $v) ${splat(S1)})))
        ${wide('(local.get $small)')})
      (local.get $tiny)))
    (local.set $qx (v128.bitselect ${splat(0)}
      (v128.bitselect ${splat(0.28125)} ${fromHi2(`(i32x4.sub (local.get $iy) ${i32s(0x00200000)})`)}
        ${wide(`(i32x4.gt_s (local.get $iy) ${i32s(0x3fe90000)})`)})
      ${wide(`(i32x4.lt_s (local.get $iy) ${i32s(0x3fd33333)})`)}))
    (local.set $kc (v128.bitselect ${splat(1)}
      (f64x2.sub (f64x2.sub ${splat(1)} (local.get $qx))
        (f64x2.sub (f64x2.sub (f64x2.mul ${splat(0.5)} (local.get $z)) (local.get $qx))
          (f64x2.sub (f64x2.mul (local.get $z) (f64x2.mul (local.get $z) ${poly2('$z', KCOS)})) (f64x2.mul (local.get $y0) (local.get $y1)))))
      (local.get $tiny)))
    ;; n mod 4: an odd n takes the other kernel; sin negates at 2 and 3, cos at 1 and 2
    (local.set $q ${wide('(local.get $n)')})
    (v128.xor
      (v128.bitselect (local.get $${cos ? 'ks' : 'kc'}) (local.get $${cos ? 'kc' : 'ks'}) (i64x2.ne (v128.and (local.get $q) ${i64s(1)}) (v128.const i64x2 0 0)))
      (v128.and (i64x2.ne (v128.and ${cos ? `(i64x2.add (local.get $q) ${i64s(1)})` : '(local.get $q)'} ${i64s(2)}) (v128.const i64x2 0 0)) ${splat('-0')})))`, [`math.${name}`])
  trig2('sin', false)
  trig2('cos', true)

  // True f64x2 pow: both lanes through one pass of $math.pow_core's kernel (module/math.js,
  // Arm's optimized-routines pow), op for op in the same order, so every lane is BIT-EXACT
  // with the scalar path. The HOT path takes both lanes in the common case ($math.pow's own
  // fast entry: a normal finite x > 0, a finite non-integer y with 2^-65 ≤ |y| < 2^63, not
  // 0.5) whose exponent product lands where the scale needs one rounding (2^-54 ≤ |y·log x|
  // < 512). The log table rows and the exp table entries come from two scalar loads per lane;
  // everything else runs 2-wide. Any other lane routes BOTH lanes to the scalar $math.pow
  // (its ladder and the kernel's own edge paths), bit-exact by construction.
  const powLanes = lanes('math.pow', ['x', 'y'])
  wat('math.pow2', `(func $math.pow2 (param $x v128) (param $y v128) (result v128)
    (local $tmp v128) (local $z v128) (local $kd v128) (local $ix v128) (local $invc v128) (local $logc v128) (local $logctail v128)
    (local $zhi v128) (local $zlo v128) (local $rhi v128) (local $rlo v128) (local $r v128)
    (local $t1 v128) (local $t2 v128) (local $lo1 v128) (local $lo2 v128) (local $ar v128) (local $ar2 v128) (local $ar3 v128)
    (local $arhi v128) (local $arhi2 v128) (local $hi v128) (local $lo3 v128) (local $lo4 v128) (local $p v128) (local $lo v128) (local $lg v128) (local $tail v128)
    (local $yhi v128) (local $ylo v128) (local $lhi v128) (local $llo v128) (local $ehi v128) (local $elo v128)
    (local $ax v128) (local $ki v128) (local $f v128) (local $t v128) (local $q v128) (local $scale v128)
    (local $a0 i32) (local $a1 i32)
    (local.set $ax (f64x2.abs (local.get $y)))
    (if (result v128)
      (i64x2.all_true (v128.and
        (v128.and (f64x2.ge (local.get $x) ${splat(2 ** -1022)}) (f64x2.lt (local.get $x) ${splat('inf')}))
        (v128.and
          (v128.and (f64x2.ge (local.get $ax) ${splat(2 ** -65)}) (f64x2.lt (local.get $ax) ${splat(2 ** 63)}))
          (v128.and (f64x2.ne (f64x2.nearest (local.get $ax)) (local.get $ax)) (f64x2.ne (local.get $y) ${splat(0.5)})))))
      (then
        ;; log(x) = k·ln2 + log(c) + log1p(z/c − 1), as hi + lo (see $math.pow_core)
        (local.set $tmp (i64x2.sub (local.get $x) ${i64s('0x3fe6955500000000')}))
        (local.set $z (i64x2.sub (local.get $x) (v128.and (local.get $tmp) ${i64s('0xfff0000000000000')})))
        ;; k = tmp >> 52 per lane, to f64 through the low i32 of each lane
        (local.set $kd (f64x2.convert_low_i32x4_s (i8x16.shuffle 0 1 2 3 8 9 10 11 0 1 2 3 8 9 10 11
          (i64x2.shr_s (local.get $tmp) (i32.const 52)) (v128.const i64x2 0 0))))
        (local.set $ix (v128.and (i64x2.shr_u (local.get $tmp) (i32.const 45)) ${i64s(127)}))
        (local.set $a0 (i32.add (global.get $math.pow_log_tbl) (i32.mul (i32.wrap_i64 (i64x2.extract_lane 0 (local.get $ix))) (i32.const 24))))
        (local.set $a1 (i32.add (global.get $math.pow_log_tbl) (i32.mul (i32.wrap_i64 (i64x2.extract_lane 1 (local.get $ix))) (i32.const 24))))
        (local.set $invc (f64x2.replace_lane 1 (f64x2.splat (f64.load (local.get $a0))) (f64.load (local.get $a1))))
        (local.set $logc (f64x2.replace_lane 1 (f64x2.splat (f64.load offset=8 (local.get $a0))) (f64.load offset=8 (local.get $a1))))
        (local.set $logctail (f64x2.replace_lane 1 (f64x2.splat (f64.load offset=16 (local.get $a0))) (f64.load offset=16 (local.get $a1))))
        (local.set $zhi (v128.and (i64x2.add (local.get $z) ${i64s('0x80000000')}) ${i64s('0xffffffff00000000')}))
        (local.set $zlo (f64x2.sub (local.get $z) (local.get $zhi)))
        (local.set $rhi (f64x2.sub (f64x2.mul (local.get $zhi) (local.get $invc)) ${splat(1.0)}))
        (local.set $rlo (f64x2.mul (local.get $zlo) (local.get $invc)))
        (local.set $r (f64x2.add (local.get $rhi) (local.get $rlo)))
        (local.set $t1 (f64x2.add (f64x2.mul (local.get $kd) ${splat(POW_LN2HI)}) (local.get $logc)))
        (local.set $t2 (f64x2.add (local.get $t1) (local.get $r)))
        (local.set $lo1 (f64x2.add (f64x2.mul (local.get $kd) ${splat(POW_LN2LO)}) (local.get $logctail)))
        (local.set $lo2 (f64x2.add (f64x2.sub (local.get $t1) (local.get $t2)) (local.get $r)))
        (local.set $ar (f64x2.mul ${splat(POW_LOG_A[0])} (local.get $r)))
        (local.set $ar2 (f64x2.mul (local.get $r) (local.get $ar)))
        (local.set $ar3 (f64x2.mul (local.get $r) (local.get $ar2)))
        (local.set $arhi (f64x2.mul ${splat(POW_LOG_A[0])} (local.get $rhi)))
        (local.set $arhi2 (f64x2.mul (local.get $rhi) (local.get $arhi)))
        (local.set $hi (f64x2.add (local.get $t2) (local.get $arhi2)))
        (local.set $lo3 (f64x2.mul (local.get $rlo) (f64x2.add (local.get $ar) (local.get $arhi))))
        (local.set $lo4 (f64x2.add (f64x2.sub (local.get $t2) (local.get $hi)) (local.get $arhi2)))
        (local.set $p (f64x2.mul (local.get $ar3)
          (f64x2.add ${splat(POW_LOG_A[1])} (f64x2.add (f64x2.mul (local.get $r) ${splat(POW_LOG_A[2])})
            (f64x2.mul (local.get $ar2) (f64x2.add ${splat(POW_LOG_A[3])} (f64x2.add (f64x2.mul (local.get $r) ${splat(POW_LOG_A[4])})
              (f64x2.mul (local.get $ar2) (f64x2.add ${splat(POW_LOG_A[5])} (f64x2.mul (local.get $r) ${splat(POW_LOG_A[6])}))))))))))
        (local.set $lo (f64x2.add (f64x2.add (f64x2.add (f64x2.add (local.get $lo1) (local.get $lo2)) (local.get $lo3)) (local.get $lo4)) (local.get $p)))
        (local.set $lg (f64x2.add (local.get $hi) (local.get $lo)))
        (local.set $tail (f64x2.add (f64x2.sub (local.get $hi) (local.get $lg)) (local.get $lo)))
        ;; y·(hi + lo) = ehi + elo, the factors split at 27 bits
        (local.set $yhi (v128.and (local.get $y) ${i64s('0xfffffffff8000000')}))
        (local.set $ylo (f64x2.sub (local.get $y) (local.get $yhi)))
        (local.set $lhi (v128.and (local.get $lg) ${i64s('0xfffffffff8000000')}))
        (local.set $llo (f64x2.add (f64x2.sub (local.get $lg) (local.get $lhi)) (local.get $tail)))
        (local.set $ehi (f64x2.mul (local.get $yhi) (local.get $lhi)))
        (local.set $elo (f64x2.add (f64x2.mul (local.get $ylo) (local.get $lhi)) (f64x2.mul (local.get $y) (local.get $llo))))
        ;; exp(ehi + elo) where both lanes scale with one rounding: 2^-54 ≤ |ehi| < 512
        (local.set $ax (f64x2.abs (local.get $ehi)))
        (if (result v128)
          (i64x2.all_true (v128.and (f64x2.ge (local.get $ax) ${splat(2 ** -54)}) (f64x2.lt (local.get $ax) ${splat(512.0)})))
          (then
            (local.set $ki (i32x4.trunc_sat_f64x2_s_zero (f64x2.nearest (f64x2.mul (local.get $ehi) ${splat(64 / Math.LN2)}))))
            (local.set $kd (f64x2.convert_low_i32x4_s (local.get $ki)))
            (local.set $f (f64x2.add (f64x2.sub (f64x2.sub (local.get $ehi) (f64x2.mul (local.get $kd) ${splat(EXP_L1)})) (f64x2.mul (local.get $kd) ${splat(EXP_L2)})) (local.get $elo)))
            (local.set $a0 (i32.add (global.get $math.exp2_tbl) (i32.shl (i32.and (i32x4.extract_lane 0 (local.get $ki)) (i32.const 63)) (i32.const 4))))
            (local.set $a1 (i32.add (global.get $math.exp2_tbl) (i32.shl (i32.and (i32x4.extract_lane 1 (local.get $ki)) (i32.const 63)) (i32.const 4))))
            (local.set $t (f64x2.replace_lane 1 (f64x2.splat (f64.load (local.get $a0))) (f64.load (local.get $a1))))
            (local.set $q (f64x2.add (f64x2.replace_lane 1 (f64x2.splat (f64.load offset=8 (local.get $a0))) (f64.load offset=8 (local.get $a1)))
              (f64x2.mul (local.get $f) ${horner2(EXP_Q, '$f')})))
            (local.set $scale (i64x2.add (local.get $t) (i64x2.shl (i64x2.extend_low_i32x4_s (i32x4.shr_s (local.get $ki) (i32.const 6))) (i32.const 52))))
            (f64x2.add (local.get $scale) (f64x2.mul (local.get $scale) (local.get $q))))
          (else ${powLanes})))
      (else ${powLanes})))`, ['math.pow'])

  // $math.pow_fold_v — SIMD twin of $math.pow_fold, ONLY registered under optimize.crPow (that
  // fold itself only exists then — see the authoritative comment above emitPow). Per-lane scalar
  // repack — BIT-EXACT by construction, no cheap 2-lane polynomial for the branchy fdlibm-style
  // dd/td kernel — and it keeps a constant-exponent-pow-bearing pixel kernel's surrounding f64x2
  // arithmetic vectorized exactly like pow2/atan2_2/hypot_2/cbrt_v/fifthroot_v already do for
  // their own callees. c arrives as v128 (every PPC_CALL2 arg is lifted through the generic splat
  // path — see src/optimize/vectorize.js), but every lane holds the SAME compile-time constant,
  // so extracting lane 0 for both scalar calls is exact. Off crPow, the vectorizer's own
  // const-exponent lift (vectorize.js) uses $math.exp_v/$math.log_v directly instead — no mirror
  // needed here, matching the default exp(c·log(x)) fold's own shape.
  if (crPow) {
    wat('math.pow_fold_v', `(func $math.pow_fold_v (param $x v128) (param $c v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.pow_fold
        (f64x2.extract_lane 0 (local.get $x))
        (f64x2.extract_lane 0 (local.get $c))))
      (call $math.pow_fold
        (f64x2.extract_lane 1 (local.get $x))
        (f64x2.extract_lane 1 (local.get $c)))))`, ['math.pow_fold'])
  }

  // atan2, hypot, cbrt, fifthroot: lane by lane through the scalar kernel. The vectorizer lifts
  // them only where a truly two-wide op (sin2/cos2/sqrt) already carries the loop, so the
  // extract and repack never make a kernel slower. (Names avoid $math.log2, which is log base 2.)
  repack('math.atan2_2', 'math.atan2', ['y', 'x'])
  repack('math.hypot_2', 'math.hypot', ['x', 'y'])
  repack('math.cbrt_v', 'math.cbrt', ['x'])
  repack('math.fifthroot_v', 'math.fifthroot', ['x'])

  // log (module/math/ieee754.js): both lanes a normal finite x > 0 off the |f| < 2^-20 path
  // (the mantissa's high word 0, 0xffffe or 0xfffff), else scalar lane by lane. Reduced as the
  // scalar does, k from the exponent field through the 2^52 magic-add; of the four returns,
  // the two k ≠ 0 forms, which equal the k = 0 ones at k = 0, chosen per lane by (i | j) > 0.
  const [Lg1, Lg2, Lg3, Lg4, Lg5, Lg6, Lg7] = LG
  wat('math.log_v', `(func $math.log_v (param $x v128) (result v128)
    (local $hx v128) (local $m v128) (local $i v128) (local $f v128) (local $dk v128) (local $s v128) (local $z v128) (local $w v128)
    (local $R v128) (local $hfsq v128)
    (local.set $hx (i64x2.shr_u (local.get $x) (i32.const 32)))
    (local.set $m (v128.and (local.get $hx) ${i64s(0xfffff)}))
    (if (i32.eqz (i64x2.all_true (v128.and
          (v128.and (i64x2.ge_s (local.get $hx) ${i64s(0x00100000)}) (i64x2.lt_s (local.get $hx) ${i64s(0x7ff00000)}))
          (i64x2.ge_s (v128.and (i64x2.add (local.get $m) ${i64s(2)}) ${i64s(0xfffff)}) ${i64s(3)}))))
      (then (return ${lanes('math.log', ['x'])})))
    (local.set $i (v128.and (i64x2.add (local.get $m) ${i64s(0x95f64)}) ${i64s(0x100000)}))
    (local.set $f (f64x2.sub
      (v128.or (i64x2.shl (v128.or (local.get $m) (v128.xor (local.get $i) ${i64s(0x3ff00000)})) (i32.const 32))
        (v128.and (local.get $x) ${i64s(0xffffffff)}))
      ${splat(1)}))
    (local.set $dk (f64x2.sub
      (v128.or (i64x2.add (i64x2.shr_u (local.get $hx) (i32.const 20)) (i64x2.shr_u (local.get $i) (i32.const 20))) ${i64s('0x4330000000000000')})
      ${splat(4503599627371519)}))
    (local.set $s (f64x2.div (local.get $f) (f64x2.add ${splat(2)} (local.get $f))))
    (local.set $z (f64x2.mul (local.get $s) (local.get $s)))
    (local.set $w (f64x2.mul (local.get $z) (local.get $z)))
    (local.set $R (f64x2.add (f64x2.mul (local.get $z) ${poly2('$w', [Lg1, Lg3, Lg5, Lg7])}) (f64x2.mul (local.get $w) ${poly2('$w', [Lg2, Lg4, Lg6])})))
    (local.set $hfsq (f64x2.mul (f64x2.mul ${splat(0.5)} (local.get $f)) (local.get $f)))
    (v128.bitselect
      (f64x2.sub (f64x2.mul (local.get $dk) ${splat(LN2_HI)}) (f64x2.sub (f64x2.sub (local.get $hfsq)
        (f64x2.add (f64x2.mul (local.get $s) (f64x2.add (local.get $hfsq) (local.get $R))) (f64x2.mul (local.get $dk) ${splat(LN2_LO)}))) (local.get $f)))
      (f64x2.sub (f64x2.mul (local.get $dk) ${splat(LN2_HI)}) (f64x2.sub (f64x2.sub (f64x2.mul (local.get $s) (f64x2.sub (local.get $f) (local.get $R)))
        (f64x2.mul (local.get $dk) ${splat(LN2_LO)})) (local.get $f)))
      (i64x2.gt_s (v128.or (i64x2.sub (local.get $m) ${i64s(0x6147a)}) (i64x2.sub ${i64s(0x6b851)} (local.get $m))) (v128.const i64x2 0 0))))`, ['math.log'])

  // f64x2 exp2 – the hot path (every lane's k = round(64y) in [−65408, 65535], i.e. a normal
  // result) mirrors the scalar table kernel op for op: the two lanes' T and tail come from two
  // scalar loads, the polynomial and T + T·(q + tail) run 2-wide, 2^e is the one exponent
  // build. Any other lane (NaN, overflow, a denormal result) routes both lanes to the scalar
  // kernel → bit-exact.
  wat('math.exp2_v', `(func $math.exp2_v (param $y v128) (result v128)
    (local $k v128) (local $ki v128) (local $f v128) (local $t v128) (local $a0 i32) (local $a1 i32)
    (local.set $k (f64x2.nearest (f64x2.mul (local.get $y) (f64x2.splat (f64.const 64.0)))))
    (if (result v128)
      (i64x2.all_true (v128.and
        (f64x2.ge (local.get $k) (f64x2.splat (f64.const -65408)))
        (f64x2.le (local.get $k) (f64x2.splat (f64.const 65535)))))
      (then
        (local.set $ki (i32x4.trunc_sat_f64x2_s_zero (local.get $k)))
        (local.set $f (f64x2.sub (local.get $y) (f64x2.mul (f64x2.convert_low_i32x4_s (local.get $ki)) (f64x2.splat (f64.const 0.015625)))))
        (local.set $a0 (i32.add (global.get $math.exp2_tbl) (i32.shl (i32.and (i32x4.extract_lane 0 (local.get $ki)) (i32.const 63)) (i32.const 4))))
        (local.set $a1 (i32.add (global.get $math.exp2_tbl) (i32.shl (i32.and (i32x4.extract_lane 1 (local.get $ki)) (i32.const 63)) (i32.const 4))))
        (local.set $t (f64x2.replace_lane 1 (f64x2.splat (f64.load (local.get $a0))) (f64.load (local.get $a1))))
        (f64x2.mul
          (f64x2.add (local.get $t) (f64x2.mul (local.get $t)
            (f64x2.add (f64x2.mul (local.get $f) ${horner2(EXP2_Q, '$f')})
              (f64x2.replace_lane 1 (f64x2.splat (f64.load offset=8 (local.get $a0))) (f64.load offset=8 (local.get $a1))))))
          (i64x2.shl (i64x2.add
            (i64x2.extend_low_i32x4_s (i32x4.shr_s (local.get $ki) (i32.const 6)))
            (i64x2.splat (i64.const 1023))) (i32.const 52))))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.exp2 (f64x2.extract_lane 0 (local.get $y))))
          (call $math.exp2 (f64x2.extract_lane 1 (local.get $y)))))))`, ['math.exp2'])

  // exp (module/math/ieee754.js): both lanes with 2^-28 ≤ |x| < 708 (k within ±1021), else
  // scalar lane by lane. k per lane as the scalar picks it: 0 up to ½·ln2, ±1 up to 1.5·ln2,
  // ⌊x/ln2 ± ½⌋ past it; hi = x − k·ln2hi and lo = k·ln2lo are then the scalar's in all three
  // (x and 0 at k = 0), and its k ≠ 0 return equals its k = 0 one there; x = 1 is e.
  wat('math.exp_v', `(func $math.exp_v (param $x v128) (result v128)
    (local $hx v128) (local $kd v128) (local $hi v128) (local $lo v128) (local $r v128) (local $t v128) (local $c v128)
    (local.set $hx (v128.and (i64x2.shr_u (local.get $x) (i32.const 32)) ${i64s(0x7fffffff)}))
    (if (i32.eqz (i64x2.all_true (v128.and (i64x2.ge_s (local.get $hx) ${i64s(0x3e300000)}) (i64x2.lt_s (local.get $hx) ${i64s(0x40862000)}))))
      (then (return ${lanes('math.exp', ['x'])})))
    (local.set $kd (v128.bitselect
      (f64x2.convert_low_i32x4_s (i32x4.trunc_sat_f64x2_s_zero (f64x2.add (f64x2.mul ${splat(INVLN2)} (local.get $x))
        (v128.bitselect ${splat(-0.5)} ${splat(0.5)} (f64x2.lt (local.get $x) ${splat(0)})))))
      (v128.bitselect (v128.bitselect ${splat(-1)} ${splat(1)} (f64x2.lt (local.get $x) ${splat(0)})) ${splat(0)}
        (i64x2.gt_s (local.get $hx) ${i64s(0x3fd62e42)}))
      (i64x2.ge_s (local.get $hx) ${i64s(0x3ff0a2b2)})))
    (local.set $hi (f64x2.sub (local.get $x) (f64x2.mul (local.get $kd) ${splat(LN2_HI)})))
    (local.set $lo (f64x2.mul (local.get $kd) ${splat(LN2_LO)}))
    (local.set $r (f64x2.sub (local.get $hi) (local.get $lo)))
    (local.set $t (f64x2.mul (local.get $r) (local.get $r)))
    (local.set $c (f64x2.sub (local.get $r) (f64x2.mul (local.get $t) ${poly2('$t', EXP_P)})))
    (v128.bitselect ${splat(EXP_E)}
      (f64x2.mul
        (f64x2.sub ${splat(1)} (f64x2.sub (f64x2.sub (local.get $lo) (f64x2.div (f64x2.mul (local.get $r) (local.get $c)) (f64x2.sub ${splat(2)} (local.get $c)))) (local.get $hi)))
        (i64x2.shl (i64x2.add (i64x2.extend_low_i32x4_s (i32x4.trunc_sat_f64x2_s_zero (local.get $kd))) ${i64s(1023)}) (i32.const 52)))
      (f64x2.eq (local.get $x) ${splat(1)})))`, ['math.exp'])
}
