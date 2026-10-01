/**
 * f64x2 SIMD transcendentals: sin2/cos2/pow2/pow_fold_v/atan2_2/hypot_2/
 * cbrt_v/pow_fifths_v/log_v/exp2_v/exp_v. Fast paths retain the scalar kernel's
 * operations per lane; exceptional lanes use the scalar helper. Consumers
 * reach these functions by name through PPC_CALL2, never by a JS symbol.
 *
 * @module math/simd
 */
import { wat } from '../../src/bridge.js'
import { ctx } from '../../src/ctx.js'
import { PI, HALF_PI, PIO2_CW, INV_PIO2, ROUND_MAGIC, CW_LIMIT, SIN_C, COS_C, ATAN_C, LOG_C, EXP2_Q, EXP_Q, EXP_L1, EXP_L2, POW_LN2HI, POW_LN2LO, POW_LOG_A, polyTree } from './trig-tables.js'

export const registerMathSimd = () => {
  const crPow = !!ctx.transform.optimize?.crPow

  // ── f64x2 sin/cos: both lanes through the scalar kernel's operations ─────────
  // $math.sin/$math.cos (module/math.js) two lanes wide: the same Cody–Waite reduction,
  // each lane taking sin(r) or cos(r) by its quadrant's parity and the sign by its
  // second bit (an xor into the sign bit).
  // Every lane is bit-identical with the scalar kernel. A lane past 2^24, NaN or
  // infinite sends both lanes to the scalar kernel (Payne–Hanek, the NaN).
  const splat = (c) => `(f64x2.splat (f64.const ${c}))`
  const i64s = (v) => `(i64x2.splat (i64.const ${v}))`
  // The shared evaluation tree in 2-wide WAT: bit-exact with the scalar builder
  // and the JS folder because all three walk the same tree (trig-tables.js).
  const horner2 = (cs, v = '$z') => polyTree(cs, {
    konst: splat,
    mul: (a, b) => `(f64x2.mul ${a} ${b})`,
    add: (a, b) => `(f64x2.add ${a} ${b})`,
  }, `(local.get ${v})`)
  const [H1, H2, H3, H4] = PIO2_CW
  // $t holds x·2/π + ROUND_MAGIC, whose low bits are each lane's quadrant; cos is the next quadrant
  const trig2 = (name, next) => wat(`math.${name}2`, `(func $math.${name}2 (param $x v128) (result v128)
    (local $t v128) (local $n v128) (local $r v128) (local $z v128) (local $odd v128)
    (if (result v128) (i64x2.all_true (f64x2.lt (f64x2.abs (local.get $x)) ${splat(CW_LIMIT)}))
      (then
        (local.set $t (f64x2.add (f64x2.mul (local.get $x) ${splat(INV_PIO2)}) ${splat(ROUND_MAGIC)}))
        (local.set $n (f64x2.sub (local.get $t) ${splat(ROUND_MAGIC)}))
        (local.set $r (f64x2.sub (f64x2.sub (f64x2.sub (f64x2.sub (local.get $x)
          (f64x2.mul (local.get $n) ${splat(H1)})) (f64x2.mul (local.get $n) ${splat(H2)}))
          (f64x2.mul (local.get $n) ${splat(H3)})) (f64x2.mul (local.get $n) ${splat(H4)})))${next ? `
        (local.set $t (i64x2.add (local.get $t) ${i64s(1)}))` : ''}
        (local.set $z (f64x2.mul (local.get $r) (local.get $r)))
        ;; odd lanes take the cosine: one kernel where the lanes' parities agree (a phase's
        ;; neighbouring samples mostly share a quadrant), both and a bitselect where not
        (local.set $odd (i64x2.ne (v128.and (local.get $t) ${i64s(1)}) ${i64s(0)}))
        (v128.xor
          (if (result v128) (i64x2.all_true (local.get $odd))
            (then ${horner2(COS_C)})
            (else (if (result v128) (v128.any_true (local.get $odd))
              (then (v128.bitselect ${horner2(COS_C)} (f64x2.mul (local.get $r) ${horner2(SIN_C)}) (local.get $odd)))
              (else (f64x2.mul (local.get $r) ${horner2(SIN_C)})))))
          (i64x2.shl (v128.and (local.get $t) ${i64s(2)}) (i32.const 62))))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.${name} (f64x2.extract_lane 0 (local.get $x))))
          (call $math.${name} (f64x2.extract_lane 1 (local.get $x)))))))`, [`math.${name}`])
  trig2('sin', false)
  trig2('cos', true)
  // True f64x2 pow: both lanes through one pass of $math.pow's kernel (module/math.js,
  // Arm's optimized-routines pow), op for op in the same order, so every lane is BIT-EXACT
  // with the scalar path. The HOT path takes both lanes in the common case ($math.pow's own
  // fast entry: a normal finite x > 0, a finite non-integer y with 2^-65 ≤ |y| < 2^63, not
  // 0.5) whose exponent product lands where the scale needs one rounding (2^-54 ≤ |y·log x|
  // < 512). The log table rows and the exp table entries come from two scalar loads per lane;
  // everything else runs 2-wide. Any other lane routes BOTH lanes to the scalar $math.pow
  // (its ladder and the kernel's own edge paths), bit-exact by construction.
  const powLanes = `(f64x2.replace_lane 1
          (f64x2.splat (call $math.pow (f64x2.extract_lane 0 (local.get $x)) (f64x2.extract_lane 0 (local.get $y))))
          (call $math.pow (f64x2.extract_lane 1 (local.get $x)) (f64x2.extract_lane 1 (local.get $y))))`
  // y·(lhi + llo) = ehi + elo, the factors split at 27 bits, and exp(ehi + elo) both lanes
  // wide where both scale with one rounding (2^-54 ≤ |ehi| < 512); `edge` computes any
  // other pair. $math.pow's kernel steps after log(x): $math.pow2 takes lhi and llo from
  // its own log, $math.pow_b_v from the compiler.
  const powExpTail2 = (edge) => `
        (local.set $yhi (v128.and (local.get $y) ${i64s('0xfffffffff8000000')}))
        (local.set $ylo (f64x2.sub (local.get $y) (local.get $yhi)))
        (local.set $ehi (f64x2.mul (local.get $yhi) (local.get $lhi)))
        (local.set $elo (f64x2.add (f64x2.mul (local.get $ylo) (local.get $lhi)) (f64x2.mul (local.get $y) (local.get $llo))))
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
          (else ${edge}))`
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
        ;; log(x) = k·ln2 + log(c) + log1p(z/c − 1), as hi + lo (see module/math.js powCoreBody)
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
        ;; log(x)'s split for the product with y
        (local.set $lhi (v128.and (local.get $lg) ${i64s('0xfffffffff8000000')}))
        (local.set $llo (f64x2.add (f64x2.sub (local.get $lg) (local.get $lhi)) (local.get $tail)))${powExpTail2(powLanes)})
      (else ${powLanes})))`, ['math.pow'])

  // $math.pow_b two lanes wide: the constant base's lhi and llo arrive splat, and both
  // lanes take $math.pow2's exponential where both take $math.pow_b's kernel path and scale
  // with one rounding, bit for bit the scalar; any other pair takes $math.pow_b a lane.
  const powBLanes = `(f64x2.replace_lane 1
          (f64x2.splat (call $math.pow_b (f64x2.extract_lane 0 (local.get $y)) (f64x2.extract_lane 0 (local.get $x))
            (f64x2.extract_lane 0 (local.get $lhi)) (f64x2.extract_lane 0 (local.get $llo))))
          (call $math.pow_b (f64x2.extract_lane 1 (local.get $y)) (f64x2.extract_lane 1 (local.get $x))
            (f64x2.extract_lane 1 (local.get $lhi)) (f64x2.extract_lane 1 (local.get $llo))))`
  if (!crPow) wat('math.pow_b_v', `(func $math.pow_b_v (param $y v128) (param $x v128) (param $lhi v128) (param $llo v128) (result v128)
    (local $yhi v128) (local $ylo v128) (local $ehi v128) (local $elo v128) (local $ax v128) (local $ki v128) (local $kd v128)
    (local $f v128) (local $t v128) (local $q v128) (local $scale v128) (local $a0 i32) (local $a1 i32)
    (local.set $ax (f64x2.abs (local.get $y)))
    (if (result v128)
      (i64x2.all_true (v128.and
        (v128.and (f64x2.ge (local.get $ax) ${splat(2 ** -65)}) (f64x2.lt (local.get $ax) ${splat(2 ** 63)}))
        (v128.and (f64x2.ne (f64x2.nearest (local.get $ax)) (local.get $ax)) (f64x2.ne (local.get $y) ${splat(0.5)}))))
      (then${powExpTail2(powBLanes)})
      (else ${powBLanes})))`, ['math.pow_b'])

  // $math.pow_fold_v — SIMD twin of $math.pow_fold, ONLY registered under optimize.crPow (that
  // fold itself only exists then — see the authoritative comment above emitPow). Per-lane scalar
  // repack — BIT-EXACT by construction, no cheap 2-lane polynomial for the branchy fdlibm-style
  // dd/td kernel — and it keeps a constant-exponent-pow-bearing pixel kernel's surrounding f64x2
  // arithmetic vectorized exactly like pow2/atan2_2/hypot_2/cbrt_v/pow_fifths_v already do for
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

  // $math.atan2 two lanes wide where both lanes have a finite y and a finite nonzero x: y/x,
  // atan's interval picked per lane (numerator, denominator and offset by bitselect, the
  // smallest as u/1 = u), one division, the polynomial, t's sign, then π added or taken
  // for a negative x by y's sign: the scalar kernel's operations, so its bits. Any other
  // pair of lanes (a zero or an infinite x, a NaN) takes the scalar kernel.
  const [ATAN_LO, ATAN_HI] = [Math.SQRT2 - 1, Math.SQRT2 + 1]
  wat('math.atan2_2', `(func $math.atan2_2 (param $y v128) (param $x v128) (result v128)
    (local $t v128) (local $a v128) (local $m1 v128) (local $m2 v128) (local $u v128) (local $z v128) (local $r v128)
    (if (result v128) (i64x2.all_true (v128.and
        (v128.and (f64x2.lt (f64x2.abs (local.get $x)) ${splat('inf')}) (f64x2.ne (local.get $x) ${splat(0)}))
        (f64x2.lt (f64x2.abs (local.get $y)) ${splat('inf')})))
      (then
        (local.set $t (f64x2.div (local.get $y) (local.get $x)))
        (local.set $a (f64x2.abs (local.get $t)))
        (local.set $m1 (f64x2.gt (local.get $a) ${splat(ATAN_LO)}))
        (local.set $m2 (f64x2.gt (local.get $a) ${splat(ATAN_HI)}))
        (local.set $u (f64x2.div
          (v128.bitselect (v128.bitselect ${splat(-1)} (f64x2.sub (local.get $a) ${splat(1)}) (local.get $m2)) (local.get $a) (local.get $m1))
          (v128.bitselect (v128.bitselect (local.get $a) (f64x2.add (local.get $a) ${splat(1)}) (local.get $m2)) ${splat(1)} (local.get $m1))))
        (local.set $z (f64x2.mul (local.get $u) (local.get $u)))
        (local.set $r (f64x2.add
          (v128.bitselect (v128.bitselect ${splat(HALF_PI)} ${splat(PI / 4)} (local.get $m2)) ${splat(0)} (local.get $m1))
          (f64x2.mul (local.get $u) ${horner2(ATAN_C)})))
        (local.set $r (v128.bitselect (local.get $t) (local.get $r) ${splat('-0.0')}))
        (v128.bitselect
          (v128.bitselect (f64x2.sub (local.get $r) ${splat(PI)}) (f64x2.add (local.get $r) ${splat(PI)}) (i64x2.lt_s (local.get $y) ${i64s(0)}))
          (local.get $r)
          (f64x2.lt (local.get $x) ${splat(0)})))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.atan2 (f64x2.extract_lane 0 (local.get $y)) (f64x2.extract_lane 0 (local.get $x))))
          (call $math.atan2 (f64x2.extract_lane 1 (local.get $y)) (f64x2.extract_lane 1 (local.get $x)))))))`, ['math.atan2'])
  // hypot has no cheap 2-lane form (its scaling branches), so its f64x2 mirror computes
  // both lanes with the SCALAR helper and repacks, as the other kernels' edge lanes do: BIT-EXACT by
  // construction. The per-pixel-color pass only emits these when a truly-2-wide op (sin2/cos2/sqrt)
  // already justifies the f64x2 pair, so the extract/repack never makes a kernel slower.
  // NOTE: names avoid the $math.log2/$math.exp2 collision (those are log-/exp-BASE-2).
  wat('math.hypot_2', `(func $math.hypot_2 (param $x v128) (param $y v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.hypot (f64x2.extract_lane 0 (local.get $x)) (f64x2.extract_lane 0 (local.get $y))))
      (call $math.hypot (f64x2.extract_lane 1 (local.get $x)) (f64x2.extract_lane 1 (local.get $y)))))`, ['math.hypot'])
  // cbrt: the scalar kernel's normal finite path two lanes wide. The high-word
  // seed divides by 3 as x*0xaaaaaaab >> 33, exact for unsigned 32-bit x.
  // Keep the scalar polynomial's grouping, rounding and Newton step unchanged;
  // either exceptional lane sends both through the scalar helper.
  wat('math.cbrt_v', `(func $math.cbrt_v (param $x v128) (result v128)
    (local $t v128) (local $r v128) (local $s v128)
    (if (i32.eqz (i64x2.all_true (v128.and
        (f64x2.ge (f64x2.abs (local.get $x)) ${splat(2 ** -1022)})
        (f64x2.lt (f64x2.abs (local.get $x)) ${splat('inf')}))))
      (then (return (f64x2.replace_lane 1
        (f64x2.splat (call $math.cbrt (f64x2.extract_lane 0 (local.get $x))))
        (call $math.cbrt (f64x2.extract_lane 1 (local.get $x)))))))
    (local.set $t (v128.or (v128.and (local.get $x) ${i64s('0x8000000000000000')})
      (i64x2.shl (i64x2.add (i64x2.shr_u (i64x2.mul
        (v128.and (i64x2.shr_u (local.get $x) (i32.const 32)) ${i64s(0x7fffffff)}) ${i64s(0xaaaaaaab)})
        (i32.const 33)) ${i64s(715094163)}) (i32.const 32))))
    (local.set $r (f64x2.mul (f64x2.mul (local.get $t) (local.get $t)) (f64x2.div (local.get $t) (local.get $x))))
    (local.set $t (f64x2.mul (local.get $t) (f64x2.add
      (f64x2.add ${splat(1.87595182427177009643)} (f64x2.mul (local.get $r)
        (f64x2.add ${splat(-1.88497979543377169875)} (f64x2.mul (local.get $r) ${splat(1.621429720105354466140)}))))
      (f64x2.mul (f64x2.mul (f64x2.mul (local.get $r) (local.get $r)) (local.get $r))
        (f64x2.add ${splat(-0.758397934778766047437)} (f64x2.mul (local.get $r) ${splat(0.145996192886612446982)}))))))
    (local.set $t (v128.and (i64x2.add (local.get $t) ${i64s(0x80000000)}) ${i64s('0xffffffffc0000000')}))
    (local.set $s (f64x2.mul (local.get $t) (local.get $t)))
    (local.set $r (f64x2.div (local.get $x) (local.get $s)))
    (local.set $r (f64x2.div (f64x2.sub (local.get $r) (local.get $t))
      (f64x2.add (f64x2.add (local.get $t) (local.get $t)) (local.get $r))))
    (f64x2.add (local.get $t) (f64x2.mul (local.get $t) (local.get $r))))`, ['math.cbrt'])
  // $math.pow_fifths two lanes wide: x^r and x^p two-wide, the fifth root a scalar call a lane
  // (the Newton steps divide), exactly the scalar helper's operations; a lane outside [lo, hi]
  // sends both through the scalar helper. c, lo and hi are the fold's constants, splat.
  wat('math.pow_fifths_v', `(func $math.pow_fifths_v (param $x v128) (param $c v128) (param $lo v128) (param $hi v128) (result v128)
    (local $p f64) (local $r f64) (local $x2 v128) (local $v v128)
    (if (result v128) (i64x2.all_true (f64x2.ge (f64x2.mul (f64x2.sub (local.get $x) (local.get $lo)) (f64x2.sub (local.get $hi) (local.get $x))) ${splat(0)}))
      (then
        (local.set $p (f64.floor (f64x2.extract_lane 0 (local.get $c))))
        (local.set $r (f64.sub (f64.nearest (f64.mul (f64x2.extract_lane 0 (local.get $c)) (f64.const 5))) (f64.mul (local.get $p) (f64.const 5))))
        (local.set $x2 (f64x2.mul (local.get $x) (local.get $x)))
        (local.set $v (if (result v128) (f64.lt (local.get $r) (f64.const 2.5))
          (then (select (local.get $x2) (local.get $x) (f64.gt (local.get $r) (f64.const 1.5))))
          (else (select (f64x2.mul (local.get $x2) (local.get $x2)) (f64x2.mul (local.get $x2) (local.get $x)) (f64.gt (local.get $r) (f64.const 3.5))))))
        (local.set $v (f64x2.replace_lane 1
          (f64x2.splat (call $math.fifthroot (f64x2.extract_lane 0 (local.get $v))))
          (call $math.fifthroot (f64x2.extract_lane 1 (local.get $v)))))
        (if (result v128) (f64.lt (local.get $p) (f64.const 0.5))
          (then (local.get $v))
          (else (f64x2.mul
            (if (result v128) (f64.lt (local.get $p) (f64.const 2.5))
              (then (select (local.get $x2) (local.get $x) (f64.gt (local.get $p) (f64.const 1.5))))
              (else (select (f64x2.mul (local.get $x2) (local.get $x2)) (f64x2.mul (local.get $x2) (local.get $x)) (f64.gt (local.get $p) (f64.const 3.5)))))
            (local.get $v)))))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.pow_fifths (f64x2.extract_lane 0 (local.get $x)) (f64x2.extract_lane 0 (local.get $c))
            (f64x2.extract_lane 0 (local.get $lo)) (f64x2.extract_lane 0 (local.get $hi))))
          (call $math.pow_fifths (f64x2.extract_lane 1 (local.get $x)) (f64x2.extract_lane 1 (local.get $c))
            (f64x2.extract_lane 1 (local.get $lo)) (f64x2.extract_lane 1 (local.get $hi)))))))`, ['math.pow_fifths', 'math.fifthroot'])
  // True f64x2 log — both lanes through one fdlibm poly (≈2× over two scalar calls). The HOT path
  // (both lanes a normal finite x>0) mirrors $math.log's normal branch op-for-op: bit-exact (the
  // sqrt2-center conditional becomes a per-lane bitselect; the i32 exponent k becomes an f64 via the
  // 2^52 magic-add, identical to convert_i32_s for |k|≤1075). Any other lane (≤0/∞/NaN/denormal)
  // routes BOTH lanes to the scalar fallback → bit-exact by construction, edges never lose precision.
  wat('math.log_v', `(func $math.log_v (param $x v128) (result v128)
    (local $k v128) (local $m v128) (local $mask v128) (local $s v128) (local $z v128)
    (if (result v128)
      (i64x2.all_true (v128.and
        (f64x2.ge (local.get $x) (f64x2.splat (f64.const 0x1p-1022)))
        (f64x2.lt (local.get $x) (f64x2.splat (f64.const inf)))))
      (then
        (local.set $k (f64x2.sub
          (v128.or (v128.and (i64x2.shr_u (local.get $x) (i32.const 52)) (i64x2.splat (i64.const 0x7ff)))
                   (i64x2.splat (i64.const 0x4330000000000000)))
          (f64x2.splat (f64.const 4503599627371519))))
        (local.set $m (v128.or (v128.and (local.get $x) (i64x2.splat (i64.const 0x000fffffffffffff))) (i64x2.splat (i64.const 0x3ff0000000000000))))
        (local.set $mask (f64x2.ge (local.get $m) (f64x2.splat (f64.const 1.4142135623730951))))
        (local.set $m (v128.bitselect (f64x2.mul (local.get $m) (f64x2.splat (f64.const 0.5))) (local.get $m) (local.get $mask)))
        (local.set $k (f64x2.add (local.get $k) (v128.and (local.get $mask) (f64x2.splat (f64.const 1.0)))))
        ;; mirrors scalar $math.log op-for-op (same constants/order) → bit-exact lanes
        (local.set $s (f64x2.div (f64x2.sub (local.get $m) (f64x2.splat (f64.const 1.0))) (f64x2.add (local.get $m) (f64x2.splat (f64.const 1.0)))))
        (local.set $z (f64x2.mul (local.get $s) (local.get $s)))
        (f64x2.add
          (f64x2.mul (local.get $k) (f64x2.splat (f64.const ${Math.LN2})))
          (f64x2.mul (f64x2.mul (f64x2.splat (f64.const 2.0)) (local.get $s)) ${horner2(LOG_C, '$z')})))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.log (f64x2.extract_lane 0 (local.get $x))))
          (call $math.log (f64x2.extract_lane 1 (local.get $x)))))))`, ['math.log'])

  // True f64x2 exp2 and exp – the hot path (every lane's k = round(64y) in [−65408, 65535],
  // i.e. a normal result) mirrors the scalar table kernels op for op: the two lanes' T and
  // tail come from two scalar loads, the polynomial and T + T·(q + tail) run 2-wide, 2^e is
  // the one exponent build. Any other lane (NaN, overflow, a denormal result) routes both
  // lanes to the scalar kernel → bit-exact.
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

  wat('math.exp_v', `(func $math.exp_v (param $x v128) (result v128)
    (local $k v128) (local $ki v128) (local $f v128) (local $t v128) (local $a0 i32) (local $a1 i32)
    (local.set $k (f64x2.nearest (f64x2.mul (local.get $x) (f64x2.splat (f64.const ${64 / Math.LN2})))))
    (if (result v128)
      (i64x2.all_true (v128.and
        (f64x2.ge (local.get $k) (f64x2.splat (f64.const -65408)))
        (f64x2.le (local.get $k) (f64x2.splat (f64.const 65535)))))
      (then
        (local.set $ki (i32x4.trunc_sat_f64x2_s_zero (local.get $k)))
        (local.set $t (f64x2.convert_low_i32x4_s (local.get $ki)))
        (local.set $f (f64x2.sub (f64x2.sub (local.get $x) (f64x2.mul (local.get $t) (f64x2.splat (f64.const ${EXP_L1})))) (f64x2.mul (local.get $t) (f64x2.splat (f64.const ${EXP_L2})))))
        (local.set $a0 (i32.add (global.get $math.exp2_tbl) (i32.shl (i32.and (i32x4.extract_lane 0 (local.get $ki)) (i32.const 63)) (i32.const 4))))
        (local.set $a1 (i32.add (global.get $math.exp2_tbl) (i32.shl (i32.and (i32x4.extract_lane 1 (local.get $ki)) (i32.const 63)) (i32.const 4))))
        (local.set $t (f64x2.replace_lane 1 (f64x2.splat (f64.load (local.get $a0))) (f64.load (local.get $a1))))
        (f64x2.mul
          (f64x2.add (local.get $t) (f64x2.mul (local.get $t)
            (f64x2.add (f64x2.mul (local.get $f) ${horner2(EXP_Q, '$f')})
              (f64x2.replace_lane 1 (f64x2.splat (f64.load offset=8 (local.get $a0))) (f64.load offset=8 (local.get $a1))))))
          (i64x2.shl (i64x2.add
            (i64x2.extend_low_i32x4_s (i32x4.shr_s (local.get $ki) (i32.const 6)))
            (i64x2.splat (i64.const 1023))) (i32.const 52))))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.exp (f64x2.extract_lane 0 (local.get $x))))
          (call $math.exp (f64x2.extract_lane 1 (local.get $x)))))))`, ['math.exp'])
}
