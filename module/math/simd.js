/**
 * f64x2 SIMD transcendentals: sin2/cos2/pow2/pow_fold_v/atan2_2/hypot_2/
 * cbrt_v/fifthroot_v/log_v/exp2_v/exp_v. Pure move from module/math.js
 * (pipeline-minimality) — delimited by the original author's own comment
 * banner ("f64x2 SIMD sin/cos — both lanes through one polynomial"). No
 * back-reference from math.js: every consumer of these WAT functions
 * reaches them by name (src/optimize/vectorize.js's PPC_CALL2 lifts), never
 * a JS symbol, so this file is a pure one-way leaf off math/trig-tables.js
 * (needs its own local helpers splat/horner2/reduce2/signClamp — used only
 * here — plus the shared SIN_C/COS_C/EXP2_C/PI/INV_PI coefficients math.js's
 * scalar kernels also use).
 *
 * @module math/simd
 */
import { wat } from '../../src/bridge.js'
import { ctx } from '../../src/ctx.js'
import { PI, INV_PI, SIN_C, COS_C, EXP2_C } from './trig-tables.js'

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
  const horner2 = (cs, v = '$r2') => cs.reduceRight((acc, c, i) =>
    i === cs.length - 1 ? splat(c)
      : `(f64x2.add ${splat(c)} (f64x2.mul (local.get ${v}) ${acc}))`, '')
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
  // pow has no cheap 2-lane polynomial (it is exp(y·ln x) with cancellation-sensitive reductions),
  // so the f64x2 mirror computes each lane with the scalar $math.pow and repacks — BIT-EXACT by
  // construction. No transcendental speedup, but it keeps a pow-bearing pixel kernel's surrounding
  // f64x2 arithmetic vectorized (the per-pixel-color pass only emits this when a truly-2-wide op —
  // sin2/cos2/sqrt — already justifies the pair, so the extract/repack never makes a kernel slower).
  wat('math.pow2', `(func $math.pow2 (param $x v128) (param $y v128) (result v128)
    (f64x2.replace_lane 1
      (f64x2.splat (call $math.pow (f64x2.extract_lane 0 (local.get $x)) (f64x2.extract_lane 0 (local.get $y))))
      (call $math.pow (f64x2.extract_lane 1 (local.get $x)) (f64x2.extract_lane 1 (local.get $y)))))`, ['math.pow'])

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
          (f64x2.mul (f64x2.mul (f64x2.splat (f64.const 2.0)) (local.get $s))
            (f64x2.add (f64x2.splat (f64.const 1.0))
              (f64x2.mul (local.get $z)
                (f64x2.add (f64x2.splat (f64.const 0.33333333283005556))
                  (f64x2.mul (local.get $z)
                    (f64x2.add (f64x2.splat (f64.const 0.20000059590510924))
                      (f64x2.mul (local.get $z)
                        (f64x2.add (f64x2.splat (f64.const 0.14275490984342690))
                          (f64x2.mul (local.get $z) (f64x2.splat (f64.const 0.11663796426848184)))))))))))))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.log (f64x2.extract_lane 0 (local.get $x))))
          (call $math.log (f64x2.extract_lane 1 (local.get $x)))))))`, ['math.log'])

  // True f64x2 exp2 — hot path (round(y) ∈ (−1023,1024), the normal-result range) mirrors $math.exp2's
  // single-IEEE-build branch op-for-op (Horner over f=y−round(y), 2^k via (k+1023)<<52); edges
  // (overflow/underflow/denormal/NaN) route both lanes to the scalar fallback → bit-exact.
  wat('math.exp2_v', `(func $math.exp2_v (param $y v128) (result v128)
    (local $k v128) (local $f v128)
    (local.set $k (f64x2.nearest (local.get $y)))
    (if (result v128)
      (i64x2.all_true (v128.and
        (f64x2.gt (local.get $k) (f64x2.splat (f64.const -1023)))
        (f64x2.lt (local.get $k) (f64x2.splat (f64.const 1024)))))
      (then
        (local.set $f (f64x2.sub (local.get $y) (local.get $k)))
        (f64x2.mul ${horner2(EXP2_C, '$f')}
          (i64x2.shl (i64x2.add
            (i64x2.extend_low_i32x4_s (i32x4.trunc_sat_f64x2_s_zero (local.get $k)))
            (i64x2.splat (i64.const 1023))) (i32.const 52))))
      (else
        (f64x2.replace_lane 1
          (f64x2.splat (call $math.exp2 (f64x2.extract_lane 0 (local.get $y))))
          (call $math.exp2 (f64x2.extract_lane 1 (local.get $y)))))))`, ['math.exp2'])

  // e^x = 2^(x·log2e) — defers to exp2_v exactly as scalar $math.exp defers to $math.exp2. Bit-exact.
  wat('math.exp_v', `(func $math.exp_v (param $x v128) (result v128)
    (call $math.exp2_v (f64x2.mul (local.get $x) (f64x2.splat (f64.const ${Math.LOG2E})))))`, ['math.exp2_v'])
}
