/**
 * f64x2 SIMD transcendentals: sin2/cos2/pow2/pow_fold_v/atan2_2/hypot_2/
 * cbrt_v/fifthroot_v/log_v/exp2_v/exp_v. pow2 is a true two-wide kernel
 * (both lanes through one pass of the scalar kernel's operations); the
 * others were a pure move from module/math.js
 * (pipeline-minimality) — delimited by the original author's own comment
 * banner ("f64x2 SIMD sin/cos — both lanes through one polynomial"). No
 * back-reference from math.js: every consumer of these WAT functions
 * reaches them by name (src/optimize/vectorize.js's PPC_CALL2 lifts), never
 * a JS symbol, so this file is a pure one-way leaf off math/trig-tables.js
 * (needs its own local helpers splat/horner2/reduce2/signClamp — used only
 * here – plus the shared SIN_C/COS_C/EXP2_Q/EXP_Q/PI/INV_PI coefficients math.js's
 * scalar kernels also use).
 *
 * @module math/simd
 */
import { wat } from '../../src/bridge.js'
import { ctx } from '../../src/ctx.js'
import { PI, INV_PI, SIN_C, COS_C, LOG_C, EXP2_Q, EXP_Q, EXP_L1, EXP_L2, POW_LN2HI, POW_LN2LO, POW_LOG_A, polyTree } from './trig-tables.js'

export const registerMathSimd = () => {
  const crPow = !!ctx.transform.optimize?.crPow

  // ── f64x2 SIMD sin/cos — both lanes through one polynomial ───────────────────
  // The scalar sin_core/cos_core algorithm lifted to two f64 lanes: same
  // round-to-nearest π reduction, same minimax poly (SIN_C/COS_C), same quadrant
  // parity — but every branch becomes branchless so two independent angles cost one
  // evaluation. A kernel computing sin and cos of distinct args (rotations, de Jong /
  // Clifford maps, oscillator banks) packs them two-per-vector and ≈halves trig cost.
  //   • Both reduction passes run unconditionally: for an in-range r the second pass'
  //     q2 = nearest(r/π) = 0, so it's an exact no-op — no per-lane branch needed, and
  //     it still rescues |x| up to ~1e15 just like the scalar's gated pass.
  //   • NaN and ±∞ fall out as NaN through the arithmetic (∞ − ∞·π = NaN); a v128 lane
  //     is raw f64, not a NaN-box, so the canonical-NaN guard the scalar needs is moot.
  //   • Sign flip for odd quadrants is `r XOR (mask & −0.0)` (mask = |q|>0.5); final
  //     min/max clamps the ~1e-8 poly overshoot to [−1,1], same as scalar.
  const splat = (c) => `(f64x2.splat (f64.const ${c}))`
  // The shared evaluation tree in 2-wide WAT — bit-exact with the scalar builder
  // and the JS folder because all three walk the same tree (trig-tables.js).
  const horner2 = (cs, v = '$r2') => polyTree(cs, {
    konst: splat,
    mul: (a, b) => `(f64x2.mul ${a} ${b})`,
    add: (a, b) => `(f64x2.add ${a} ${b})`,
  }, `(local.get ${v})`)
  // Shared reduce → r ∈ [−π/2,π/2] in $r, quadrant parity in $q (branchless, 2 passes).
  const reduce2 = `
    (local.set $q (f64x2.nearest (f64x2.mul (local.get $x) ${splat(INV_PI)})))
    (local.set $r (f64x2.sub (local.get $x) (f64x2.mul (local.get $q) ${splat(PI)})))
    (local.set $q2 (f64x2.nearest (f64x2.mul (local.get $r) ${splat(INV_PI)})))
    (local.set $r (f64x2.sub (local.get $r) (f64x2.mul (local.get $q2) ${splat(PI)})))
    (local.set $q (f64x2.add (local.get $q) (local.get $q2)))
    (local.set $q (f64x2.sub (local.get $q) (f64x2.mul ${splat(2)} (f64x2.nearest (f64x2.mul (local.get $q) ${splat(0.5)})))))
    (local.set $r2 (f64x2.mul (local.get $r) (local.get $r)))`
  // r XOR (|q|>0.5 ? −0.0 : 0), then clamp to [−1,1].
  const signClamp = `
    (local.set $r (v128.xor (local.get $r)
      (v128.and (f64x2.gt (f64x2.abs (local.get $q)) ${splat(0.5)}) ${splat('-0.0')})))
    (f64x2.min (f64x2.max (local.get $r) ${splat(-1)}) ${splat(1)})`
  wat('math.sin2', `(func $math.sin2 (param $x v128) (result v128)
    (local $q v128) (local $q2 v128) (local $r v128) (local $r2 v128)${reduce2}
    (local.set $r (f64x2.mul (local.get $r) ${horner2(SIN_C)}))${signClamp})`)
  wat('math.cos2', `(func $math.cos2 (param $x v128) (result v128)
    (local $q v128) (local $q2 v128) (local $r v128) (local $r2 v128)${reduce2}
    (local.set $r ${horner2(COS_C)})${signClamp})`)
  // True f64x2 pow: both lanes through one pass of $math.pow_core's kernel (module/math.js,
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
  const i64s = (v) => `(i64x2.splat (i64.const ${v}))`
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

  // atan2/hypot/log have no cheap 2-lane polynomial (multi-`return` fdlibm bodies), so — like pow2 —
  // each f64x2 mirror computes both lanes with the SCALAR helper and repacks: BIT-EXACT by
  // construction. The per-pixel-color pass only emits these when a truly-2-wide op (sin2/cos2/sqrt)
  // already justifies the f64x2 pair, so the extract/repack never makes a kernel slower.
  // NOTE: names avoid the $math.log2/$math.exp2 collision (those are log-/exp-BASE-2).
  wat('math.atan2_2', `(func $math.atan2_2 (param $y v128) (param $x v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.atan2 (f64x2.extract_lane 0 (local.get $y)) (f64x2.extract_lane 0 (local.get $x))))
      (call $math.atan2 (f64x2.extract_lane 1 (local.get $y)) (f64x2.extract_lane 1 (local.get $x)))))`, ['math.atan2'])
  wat('math.hypot_2', `(func $math.hypot_2 (param $x v128) (param $y v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.hypot (f64x2.extract_lane 0 (local.get $x)) (f64x2.extract_lane 0 (local.get $y))))
      (call $math.hypot (f64x2.extract_lane 1 (local.get $x)) (f64x2.extract_lane 1 (local.get $y)))))`, ['math.hypot'])
  // cbrt/fifthroot: same per-lane scalar repack (their scalar bodies are branchy exponent-split +
  // Newton, no cheap 2-lane poly). BIT-EXACT by construction. Unlocks the Oklab/OkLCh path (3 cbrt
  // per pixel) and the sRGB/Rec.709 `x**(k/5)` gamma so their surrounding f64x2 arithmetic vectorizes.
  wat('math.cbrt_v', `(func $math.cbrt_v (param $x v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.cbrt (f64x2.extract_lane 0 (local.get $x))))
      (call $math.cbrt (f64x2.extract_lane 1 (local.get $x)))))`, ['math.cbrt'])
  wat('math.fifthroot_v', `(func $math.fifthroot_v (param $x v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.fifthroot (f64x2.extract_lane 0 (local.get $x))))
      (call $math.fifthroot (f64x2.extract_lane 1 (local.get $x)))))`, ['math.fifthroot'])
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
