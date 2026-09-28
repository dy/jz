/**
 * V8's Math, bit for bit: WAT ports of the functions V8 evaluates, operation for
 * operation in its source's order, so a compiled `Math.sin(x)` returns what V8
 * returns for every x.
 *
 * Source: V8 14.1 as Node v25.9.0 ships it. src/base/ieee754.cc, V8's adaptation of
 * fdlibm (https://github.com/nodejs/node/blob/v25.9.0/deps/v8/src/base/ieee754.cc),
 * for sin cos tan asin acos atan atan2 exp expm1 log log1p log2 log10 sinh cosh tanh
 * asinh acosh atanh cbrt; the Torque builtin MathHypot
 * (https://github.com/nodejs/node/blob/v25.9.0/deps/v8/src/builtins/math.tq) for hypot.
 * Each port names the function it transliterates. The constants are shared with the
 * JS twins in src/prepare/math-kernel.js, which fold constants to the same bits.
 *
 * The C is plain IEEE double arithmetic, which x64 builds of V8 compute and these
 * ports compute. arm64 builds of Node and Chrome let the C compiler fuse `a*b + c`
 * into one rounding, and land an ulp away on a fraction of a percent of arguments.
 *
 * A NaN result is the canonical constant or the NaN argument itself, never one minted
 * by arithmetic (Inf − Inf, x + x of a NaN), whose sign wasm leaves to the platform.
 *
 * @module math/ieee754
 */
import { wat, deps } from '../../src/bridge.js'
import { ctx } from '../../src/ctx.js'
import {
  TWO_OVER_PI, PIO2_CHUNKS, INVPIO2, PIO2_1, PIO2_1T, PIO2_2, PIO2_2T, PIO2_3, PIO2_3T,
  KSIN, KCOS, KTAN, PIO4, PIO4LO, ASIN_P, ASIN_Q, PIO2_HI, PIO2_LO, ATAN_HI, ATAN_LO, ATAN_T,
  PI_O_4, PI_O_2, PI_D, PI_LO, LN2_HI, LN2_LO, INVLN2, LN2, EXP_P, EXP_OVER, EXP_UNDER, EXP_E,
  TWOM1000, TWO1023, EXPM1_Q, EXPM1_TWO1023, LG, TWO54, IVLN2HI, IVLN2LO, IVLN10, LOG10_2HI,
  LOG10_2LO, CBRT_B1, CBRT_B2, CBRT_P, SINH_OVER, TWO_M28, LOG_MAXD,
} from './trig-tables.js'

// fdlibm's word access, as WAT: GET_HIGH_WORD / GET_LOW_WORD (i32), INSERT_WORDS(d, h, 0),
// SET_LOW_WORD(d, 0), SET_HIGH_WORD(d, h).
const hi = (v) => `(i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 ${v}) (i64.const 32)))`
const lo = (v) => `(i32.wrap_i64 (i64.reinterpret_f64 ${v}))`
const fromHi = (h) => `(f64.reinterpret_i64 (i64.shl (i64.extend_i32_u ${h}) (i64.const 32)))`
const clearLo = (v) => `(f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 ${v}) (i64.const 0xffffffff00000000)))`
const withHi = (v, h) => `(f64.reinterpret_i64 (i64.or (i64.and (i64.reinterpret_f64 ${v}) (i64.const 0xffffffff)) (i64.shl (i64.extend_i32_u ${h}) (i64.const 32))))`
const k = (c) => `(f64.const ${c})`
const $ = (n) => `(local.get $${n})`
// c0 + z*(c1 + z*(c2 + …)): the C's own nesting, innermost last
const poly = (z, cs) => cs.length === 1 ? k(cs[0]) : `(f64.add ${k(cs[0])} (f64.mul ${z} ${poly(z, cs.slice(1))}))`
// 2^e for an i32 e in the normal range (scalbn(1, e))
const pow2 = (e) => `(f64.reinterpret_i64 (i64.shl (i64.extend_i32_s (i32.add ${e} (i32.const 1023))) (i64.const 52)))`

// The Payne–Hanek table: π/2 in five 24-bit chunks (f64), then 2/π in 24-bit chunks packed
// three bytes each (read as an unaligned i32 masked to 24 bits, one pad byte after the
// last), then iq[20], __kernel_rem_pio2's one working array (q and fq are recomputed from
// iq and the table instead of stored: every product in them is exact).
const RP_TWO_OVER_PI = 40, RP_IQ = 240, RP_LEN = 320
const remPio2Table = () => {
  const bytes = new Uint8Array(RP_LEN), buf = new ArrayBuffer(8), f = new Float64Array(buf), b = new Uint8Array(buf)
  for (let i = 0; i < 5; i++) { f[0] = PIO2_CHUNKS[i]; for (let j = 0; j < 8; j++) bytes[i * 8 + j] = b[j] }
  for (let i = 0; i < TWO_OVER_PI.length; i++) {
    const v = TWO_OVER_PI[i], o = RP_TWO_OVER_PI + 3 * i
    bytes[o] = v & 255; bytes[o + 1] = (v >> 8) & 255; bytes[o + 2] = (v >> 16) & 255
  }
  return bytes
}

export const registerIeee754 = () => {
  const [S1, S2, S3, S4, S5, S6] = KSIN
  const [aT0, aT1, aT2, aT3, aT4, aT5, aT6, aT7, aT8, aT9, aT10] = ATAN_T
  const [Lg1, Lg2, Lg3, Lg4, Lg5, Lg6, Lg7] = LG
  const [P0, P1, P2, P3, P4] = CBRT_P
  const T = KTAN

  deps({
    'math.sin': ['math.rem_pio2'],
    'math.cos': ['math.rem_pio2'],
    'math.tan': ['math.k_tan', 'math.rem_pio2'],
    'math.rem_pio2': ['math.rem_pio2_large'],
    'math.acos': [], 'math.asin': [], 'math.atan': [], 'math.atan2': ['math.atan'],
    'math.exp': [], 'math.expm1': [], 'math.log': [], 'math.log1p': [], 'math.log2': [], 'math.log10': ['math.log'],
    'math.sinh': ['math.exp', 'math.expm1'], 'math.cosh': ['math.exp', 'math.expm1'], 'math.tanh': ['math.expm1'],
    'math.asinh': ['math.log', 'math.log1p'], 'math.acosh': ['math.log', 'math.log1p'], 'math.atanh': ['math.log1p'],
    'math.cbrt': [], 'math.hypot': [],
  })
  ctx.runtime.remPio2Table = remPio2Table()

  // __ieee754_rem_pio2 (ieee754.cc): x reduced by n·π/2 to y0 + y1, |y0| ≤ π/4, for a finite
  // |x| > π/4 (its callers take the rest). n = ±1 below 3π/4; the medium range subtracts
  // n·π/2 in up to three 33-bit pieces; past 2^19·π/2, __kernel_rem_pio2 ($math.rem_pio2_large).
  // The quick "no cancellation" test compares |x|'s high word with npio2_hw[n−1], which is
  // the high word of n·pio2_1 (an exact product) for every n < 32.
  wat('math.rem_pio2', `(func $math.rem_pio2 (param $x f64) (result i32 f64 f64)
    (local $hx i32) (local $ix i32) (local $n i32) (local $j i32)
    (local $z f64) (local $t f64) (local $r f64) (local $w f64) (local $fn f64) (local $y0 f64) (local $y1 f64)
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.lt_s (local.get $ix) (i32.const 0x4002d97c))
      (then
        (if (i32.gt_s (local.get $hx) (i32.const 0))
          (then
            (local.set $z (f64.sub (local.get $x) ${k(PIO2_1)}))
            (if (i32.ne (local.get $ix) (i32.const 0x3ff921fb))
              (then
                (local.set $y0 (f64.sub (local.get $z) ${k(PIO2_1T)}))
                (return (i32.const 1) (local.get $y0) (f64.sub (f64.sub (local.get $z) (local.get $y0)) ${k(PIO2_1T)}))))
            (local.set $z (f64.sub (local.get $z) ${k(PIO2_2)}))
            (local.set $y0 (f64.sub (local.get $z) ${k(PIO2_2T)}))
            (return (i32.const 1) (local.get $y0) (f64.sub (f64.sub (local.get $z) (local.get $y0)) ${k(PIO2_2T)}))))
        (local.set $z (f64.add (local.get $x) ${k(PIO2_1)}))
        (if (i32.ne (local.get $ix) (i32.const 0x3ff921fb))
          (then
            (local.set $y0 (f64.add (local.get $z) ${k(PIO2_1T)}))
            (return (i32.const -1) (local.get $y0) (f64.add (f64.sub (local.get $z) (local.get $y0)) ${k(PIO2_1T)}))))
        (local.set $z (f64.add (local.get $z) ${k(PIO2_2)}))
        (local.set $y0 (f64.add (local.get $z) ${k(PIO2_2T)}))
        (return (i32.const -1) (local.get $y0) (f64.add (f64.sub (local.get $z) (local.get $y0)) ${k(PIO2_2T)}))))
    (if (i32.gt_s (local.get $ix) (i32.const 0x413921fb)) (then (return (call $math.rem_pio2_large (local.get $x)))))
    (local.set $t (f64.abs (local.get $x)))
    (local.set $n (i32.trunc_f64_s (f64.add (f64.mul (local.get $t) ${k(INVPIO2)}) (f64.const 0.5))))
    (local.set $fn (f64.convert_i32_s (local.get $n)))
    (local.set $r (f64.sub (local.get $t) (f64.mul (local.get $fn) ${k(PIO2_1)})))
    (local.set $w (f64.mul (local.get $fn) ${k(PIO2_1T)}))
    (local.set $y0 (f64.sub (local.get $r) (local.get $w)))
    (if (i32.eqz (i32.and (i32.lt_s (local.get $n) (i32.const 32))
          (i32.ne (local.get $ix) ${hi(`(f64.mul (local.get $fn) ${k(PIO2_1)})`)})))
      (then
        (local.set $j (i32.shr_s (local.get $ix) (i32.const 20)))
        (if (i32.gt_s (i32.sub (local.get $j) (i32.and (i32.shr_u ${hi($('y0'))} (i32.const 20)) (i32.const 0x7ff))) (i32.const 16))
          (then
            (local.set $t (local.get $r))
            (local.set $w (f64.mul (local.get $fn) ${k(PIO2_2)}))
            (local.set $r (f64.sub (local.get $t) (local.get $w)))
            (local.set $w (f64.sub (f64.mul (local.get $fn) ${k(PIO2_2T)}) (f64.sub (f64.sub (local.get $t) (local.get $r)) (local.get $w))))
            (local.set $y0 (f64.sub (local.get $r) (local.get $w)))
            (if (i32.gt_s (i32.sub (local.get $j) (i32.and (i32.shr_u ${hi($('y0'))} (i32.const 20)) (i32.const 0x7ff))) (i32.const 49))
              (then
                (local.set $t (local.get $r))
                (local.set $w (f64.mul (local.get $fn) ${k(PIO2_3)}))
                (local.set $r (f64.sub (local.get $t) (local.get $w)))
                (local.set $w (f64.sub (f64.mul (local.get $fn) ${k(PIO2_3T)}) (f64.sub (f64.sub (local.get $t) (local.get $r)) (local.get $w))))
                (local.set $y0 (f64.sub (local.get $r) (local.get $w)))))))))
    (local.set $y1 (f64.sub (f64.sub (local.get $r) (local.get $y0)) (local.get $w)))
    (if (i32.lt_s (local.get $hx) (i32.const 0))
      (then (return (i32.sub (i32.const 0) (local.get $n)) (f64.neg (local.get $y0)) (f64.neg (local.get $y1)))))
    (local.get $n) (local.get $y0) (local.get $y1))`)

  // __ieee754_rem_pio2's large branch and __kernel_rem_pio2 at prec 2 (ieee754.cc): |x|
  // split into three 24-bit chunks x0 x1 x2 scaled by 2^e0; the product with 2/π formed
  // chunk by chunk, q(i) = Σ x_j·ipio2[jv + i − j] (every term and sum exact, so computed
  // where it is read instead of stored in q[]); the carries distilled into iq[]; more chunks
  // of 2/π when the fraction cancels; then y0 + y1 = Σ fq, fq(m) = Σ_k PIo2[k]·q[jz − m + k]
  // in the source's order. The i32 locals keep the C's names.
  const iq = (i) => `(i32.load offset=${RP_IQ} (i32.add (local.get $tb) (i32.shl ${i} (i32.const 2))))`
  const iqSet = (i, v) => `(i32.store offset=${RP_IQ} (i32.add (local.get $tb) (i32.shl ${i} (i32.const 2))) ${v})`
  const q = (i) => `(call $math.rem_pio2_q (local.get $tb) (i32.add (local.get $jv) ${i}) (local.get $x0) (local.get $x1) (local.get $x2))`
  wat('math.rem_pio2_large', `(func $math.rem_pio2_large (param $x f64) (result i32 f64 f64)
    (local $tb i32) (local $hx i32) (local $ix i32) (local $e0 i32) (local $jv i32) (local $q0 i32) (local $jz i32)
    (local $i i32) (local $j i32) (local $kk i32) (local $m i32) (local $n i32) (local $ih i32) (local $carry i32)
    (local $z f64) (local $fw f64) (local $x0 f64) (local $x1 f64) (local $x2 f64) (local $y0 f64) (local $y1 f64)
    (local.set $tb (global.get $math.pio2_tbl))
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (local.set $e0 (i32.sub (i32.shr_s (local.get $ix) (i32.const 20)) (i32.const 1046)))
    (local.set $z (f64.reinterpret_i64 (i64.or
      (i64.shl (i64.extend_i32_u (i32.sub (local.get $ix) (i32.shl (local.get $e0) (i32.const 20)))) (i64.const 32))
      (i64.extend_i32_u ${lo($('x'))}))))
    (local.set $x0 (f64.trunc (local.get $z)))
    (local.set $z (f64.mul (f64.sub (local.get $z) (local.get $x0)) (f64.const 16777216)))
    (local.set $x1 (f64.trunc (local.get $z)))
    (local.set $x2 (f64.mul (f64.sub (local.get $z) (local.get $x1)) (f64.const 16777216)))
    (local.set $jv (i32.div_s (i32.sub (local.get $e0) (i32.const 3)) (i32.const 24)))
    (if (i32.lt_s (local.get $jv) (i32.const 0)) (then (local.set $jv (i32.const 0))))
    (local.set $q0 (i32.sub (local.get $e0) (i32.mul (i32.const 24) (i32.add (local.get $jv) (i32.const 1)))))
    (local.set $jz (i32.const 4))
    (loop $recompute
      ;; distill q[] into iq[] reversingly
      (local.set $i (i32.const 0))
      (local.set $j (local.get $jz))
      (local.set $z ${q($('jz'))})
      (block $distilled (loop $distill
        (br_if $distilled (i32.le_s (local.get $j) (i32.const 0)))
        (local.set $fw (f64.convert_i32_s (i32.trunc_f64_s (f64.mul (f64.const ${2 ** -24}) (local.get $z)))))
        ${iqSet($('i'), `(i32.trunc_f64_s (f64.sub (local.get $z) (f64.mul (f64.const 16777216) (local.get $fw))))`)}
        (local.set $z (f64.add ${q(`(i32.sub (local.get $j) (i32.const 1))`)} (local.get $fw)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (local.set $j (i32.sub (local.get $j) (i32.const 1)))
        (br $distill)))
      ;; n: the integer part mod 8
      (local.set $z (f64.mul (local.get $z) ${pow2($('q0'))}))
      (local.set $z (f64.sub (local.get $z) (f64.mul (f64.const 8) (f64.floor (f64.mul (local.get $z) (f64.const 0.125))))))
      (local.set $n (i32.trunc_f64_s (local.get $z)))
      (local.set $z (f64.sub (local.get $z) (f64.convert_i32_s (local.get $n))))
      (local.set $ih (i32.const 0))
      (if (i32.gt_s (local.get $q0) (i32.const 0))
        (then
          (local.set $i (i32.shr_s ${iq(`(i32.sub (local.get $jz) (i32.const 1))`)} (i32.sub (i32.const 24) (local.get $q0))))
          (local.set $n (i32.add (local.get $n) (local.get $i)))
          ${iqSet(`(i32.sub (local.get $jz) (i32.const 1))`, `(i32.sub ${iq(`(i32.sub (local.get $jz) (i32.const 1))`)} (i32.shl (local.get $i) (i32.sub (i32.const 24) (local.get $q0))))`)}
          (local.set $ih (i32.shr_s ${iq(`(i32.sub (local.get $jz) (i32.const 1))`)} (i32.sub (i32.const 23) (local.get $q0)))))
        (else (if (i32.eqz (local.get $q0))
          (then (local.set $ih (i32.shr_s ${iq(`(i32.sub (local.get $jz) (i32.const 1))`)} (i32.const 23))))
          (else (if (f64.ge (local.get $z) (f64.const 0.5)) (then (local.set $ih (i32.const 2))))))))
      ;; q ≥ 0.5: take 1 − q, the remainder negative
      (if (i32.gt_s (local.get $ih) (i32.const 0))
        (then
          (local.set $n (i32.add (local.get $n) (i32.const 1)))
          (local.set $carry (i32.const 0))
          (local.set $i (i32.const 0))
          (block $done (loop $each
            (br_if $done (i32.ge_s (local.get $i) (local.get $jz)))
            (local.set $j ${iq($('i'))})
            (if (i32.eqz (local.get $carry))
              (then (if (local.get $j) (then (local.set $carry (i32.const 1)) ${iqSet($('i'), `(i32.sub (i32.const 0x1000000) (local.get $j))`)})))
              (else ${iqSet($('i'), `(i32.sub (i32.const 0xffffff) (local.get $j))`)}))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $each)))
          (if (i32.eq (local.get $q0) (i32.const 1))
            (then ${iqSet(`(i32.sub (local.get $jz) (i32.const 1))`, `(i32.and ${iq(`(i32.sub (local.get $jz) (i32.const 1))`)} (i32.const 0x7fffff))`)}))
          (if (i32.eq (local.get $q0) (i32.const 2))
            (then ${iqSet(`(i32.sub (local.get $jz) (i32.const 1))`, `(i32.and ${iq(`(i32.sub (local.get $jz) (i32.const 1))`)} (i32.const 0x3fffff))`)}))
          (if (i32.eq (local.get $ih) (i32.const 2))
            (then
              (local.set $z (f64.sub (f64.const 1) (local.get $z)))
              (if (local.get $carry) (then (local.set $z (f64.sub (local.get $z) ${pow2($('q0'))}))))))))
      ;; the fraction cancelled to zero: fetch k more chunks of 2/π and redo
      (if (f64.eq (local.get $z) (f64.const 0))
        (then
          (local.set $j (i32.const 0))
          (local.set $i (i32.sub (local.get $jz) (i32.const 1)))
          (block $ored (loop $or
            (br_if $ored (i32.lt_s (local.get $i) (i32.const 4)))
            (local.set $j (i32.or (local.get $j) ${iq($('i'))}))
            (local.set $i (i32.sub (local.get $i) (i32.const 1)))
            (br $or)))
          (if (i32.eqz (local.get $j))
            (then
              (local.set $kk (i32.const 1))
              (block $counted (loop $count
                (br_if $counted (i32.gt_s (local.get $kk) (i32.const 4)))
                (br_if $counted ${iq(`(i32.sub (i32.const 4) (local.get $kk))`)})
                (local.set $kk (i32.add (local.get $kk) (i32.const 1)))
                (br $count)))
              (local.set $jz (i32.add (local.get $jz) (local.get $kk)))
              (br $recompute))))))
    ;; chop off zero terms, or break z into 24-bit chunks
    (if (f64.eq (local.get $z) (f64.const 0))
      (then
        (local.set $jz (i32.sub (local.get $jz) (i32.const 1)))
        (local.set $q0 (i32.sub (local.get $q0) (i32.const 24)))
        (block $chopped (loop $chop
          (br_if $chopped ${iq($('jz'))})
          (local.set $jz (i32.sub (local.get $jz) (i32.const 1)))
          (local.set $q0 (i32.sub (local.get $q0) (i32.const 24)))
          (br $chop))))
      (else
        (local.set $z (f64.mul (local.get $z) ${pow2(`(i32.sub (i32.const 0) (local.get $q0))`)}))
        (if (f64.ge (local.get $z) (f64.const 16777216))
          (then
            (local.set $fw (f64.convert_i32_s (i32.trunc_f64_s (f64.mul (f64.const ${2 ** -24}) (local.get $z)))))
            ${iqSet($('jz'), `(i32.trunc_f64_s (f64.sub (local.get $z) (f64.mul (f64.const 16777216) (local.get $fw))))`)}
            (local.set $jz (i32.add (local.get $jz) (i32.const 1)))
            (local.set $q0 (i32.add (local.get $q0) (i32.const 24)))
            ${iqSet($('jz'), `(i32.trunc_f64_s (local.get $fw))`)})
          (else ${iqSet($('jz'), `(i32.trunc_f64_s (local.get $z))`)}))))
    ;; y0 = fq[jz] + … + fq[0], then y1 = (fq[0] − y0) + fq[1] + … + fq[jz]
    (local.set $fw (f64.const 0))
    (local.set $m (local.get $jz))
    (block $s0 (loop $sum0
      (br_if $s0 (i32.lt_s (local.get $m) (i32.const 0)))
      (local.set $fw (f64.add (local.get $fw) (call $math.rem_pio2_fq (local.get $tb) (local.get $m) (local.get $jz) (local.get $q0))))
      (local.set $m (i32.sub (local.get $m) (i32.const 1)))
      (br $sum0)))
    (local.set $y0 (select (f64.neg (local.get $fw)) (local.get $fw) (local.get $ih)))
    (local.set $fw (f64.sub (call $math.rem_pio2_fq (local.get $tb) (i32.const 0) (local.get $jz) (local.get $q0)) (local.get $fw)))
    (local.set $m (i32.const 1))
    (block $s1 (loop $sum1
      (br_if $s1 (i32.gt_s (local.get $m) (local.get $jz)))
      (local.set $fw (f64.add (local.get $fw) (call $math.rem_pio2_fq (local.get $tb) (local.get $m) (local.get $jz) (local.get $q0))))
      (local.set $m (i32.add (local.get $m) (i32.const 1)))
      (br $sum1)))
    (local.set $y1 (select (f64.neg (local.get $fw)) (local.get $fw) (local.get $ih)))
    (local.set $n (i32.and (local.get $n) (i32.const 7)))
    (if (i32.lt_s (local.get $hx) (i32.const 0))
      (then (return (i32.sub (i32.const 0) (local.get $n)) (f64.neg (local.get $y0)) (f64.neg (local.get $y1)))))
    (local.get $n) (local.get $y0) (local.get $y1))`, ['math.rem_pio2_fq', 'math.rem_pio2_q'])

  // q of __kernel_rem_pio2 at m = jv + i: x0·ipio2[m] + x1·ipio2[m − 1] + x2·ipio2[m − 2], a
  // negative index reading 0 (every product and sum exact)
  const ipio2 = (d) => `(if (result f64) (i32.lt_s (local.get $m) (i32.const ${d})) (then (f64.const 0))
      (else (f64.convert_i32_u (i32.and (i32.load offset=${RP_TWO_OVER_PI - 3 * d} align=1 (i32.add (local.get $tb) (i32.mul (local.get $m) (i32.const 3)))) (i32.const 0xffffff)))))`
  wat('math.rem_pio2_q', `(func $math.rem_pio2_q (param $tb i32) (param $m i32) (param $x0 f64) (param $x1 f64) (param $x2 f64) (result f64)
    (f64.add (f64.add (f64.mul (local.get $x0) ${ipio2(0)}) (f64.mul (local.get $x1) ${ipio2(1)})) (f64.mul (local.get $x2) ${ipio2(2)})))`)

  // fq[m] of __kernel_rem_pio2: Σ_{k ≤ min(4, m)} PIo2[k]·q[jz − m + k], summed from k = 0,
  // with q[i] = 2^(q0 − 24(jz − i))·iq[i] (both products exact).
  wat('math.rem_pio2_fq', `(func $math.rem_pio2_fq (param $tb i32) (param $m i32) (param $jz i32) (param $q0 i32) (result f64)
    (local $kk i32) (local $i i32) (local $fw f64)
    (local.set $fw (f64.const 0))
    (block $done (loop $each
      (br_if $done (i32.gt_s (local.get $kk) (i32.const 4)))
      (br_if $done (i32.gt_s (local.get $kk) (local.get $m)))
      (local.set $i (i32.add (i32.sub (local.get $jz) (local.get $m)) (local.get $kk)))
      (local.set $fw (f64.add (local.get $fw) (f64.mul (f64.load (i32.add (local.get $tb) (i32.shl (local.get $kk) (i32.const 3))))
        (f64.mul ${pow2(`(i32.sub (local.get $q0) (i32.mul (i32.const 24) (i32.sub (local.get $jz) (local.get $i))))`)}
          (f64.convert_i32_s ${iq($('i'))})))))
      (local.set $kk (i32.add (local.get $kk) (i32.const 1)))
      (br $each)))
    (local.get $fw))`)

  // __kernel_sin and __kernel_cos (ieee754.cc) as expressions over the caller's locals $kz
  // $kv $kr $kq $ki, a label each, so sin and cos run their kernels without a call.
  // __kernel_sin: sin(x + y) on |x| ≤ π/4, y the tail (iy = 0: y is 0), x itself below 2^-27
  const kSin = (label, x, y, iy) => `(block ${label} (result f64)
      (drop (br_if ${label} ${x} (i32.lt_s (i32.and ${hi(x)} (i32.const 0x7fffffff)) (i32.const 0x3e400000))))
      (local.set $kz (f64.mul ${x} ${x}))
      (local.set $kv (f64.mul (local.get $kz) ${x}))
      (local.set $kr ${poly($('kz'), [S2, S3, S4, S5, S6])})
      ${iy === 0 ? `(f64.add ${x} (f64.mul (local.get $kv) (f64.add ${k(S1)} (f64.mul (local.get $kz) (local.get $kr)))))`
        : `(f64.sub ${x} (f64.sub (f64.sub (f64.mul (local.get $kz)
          (f64.sub (f64.mul (f64.const 0.5) ${y}) (f64.mul (local.get $kv) (local.get $kr)))) ${y})
          (f64.mul (local.get $kv) ${k(S1)})))`})`
  // __kernel_cos: cos(x + y) on |x| ≤ π/4, 1 below 2^-27; past 0.3 the 1 − x²/2 subtraction is
  // split through qx (x/4 with its low word cleared, or 0.28125) so both parts are exact
  const kCos = (label, x, y) => `(block ${label} (result f64)
      (local.set $ki (i32.and ${hi(x)} (i32.const 0x7fffffff)))
      (drop (br_if ${label} (f64.const 1) (i32.lt_s (local.get $ki) (i32.const 0x3e400000))))
      (local.set $kz (f64.mul ${x} ${x}))
      (local.set $kr (f64.mul (local.get $kz) ${poly($('kz'), KCOS)}))
      (drop (br_if ${label} (f64.sub (f64.const 1) (f64.sub (f64.mul (f64.const 0.5) (local.get $kz))
          (f64.sub (f64.mul (local.get $kz) (local.get $kr)) (f64.mul ${x} ${y}))))
        (i32.lt_s (local.get $ki) (i32.const 0x3fd33333))))
      (local.set $kq (select (f64.const 0.28125) ${fromHi(`(i32.sub (local.get $ki) (i32.const 0x00200000))`)}
        (i32.gt_s (local.get $ki) (i32.const 0x3fe90000))))
      (f64.sub (f64.sub (f64.const 1) (local.get $kq))
        (f64.sub (f64.sub (f64.mul (f64.const 0.5) (local.get $kz)) (local.get $kq))
          (f64.sub (f64.mul (local.get $kz) (local.get $kr)) (f64.mul ${x} ${y})))))`

  // __kernel_tan (ieee754.cc): tan(x + y) (iy = 1) or −1/tan(x + y) (iy = −1) on |x| ≤ π/4,
  // above 0.6744 through tan(π/4 − x); the −1/w division carried with its low word split off
  const negRecip = (w, r) => `
      (local.set $z ${clearLo(w)})
      (local.set $v (f64.sub ${r} (f64.sub (local.get $z) (local.get $x))))
      (local.set $a (f64.div (f64.const -1) ${w}))
      (local.set $t ${clearLo($('a'))})
      (local.set $s (f64.add (f64.const 1) (f64.mul (local.get $t) (local.get $z))))
      (f64.add (local.get $t) (f64.mul (local.get $a) (f64.add (local.get $s) (f64.mul (local.get $t) (local.get $v)))))`
  wat('math.k_tan', `(func $math.k_tan (param $x f64) (param $y f64) (param $iy i32) (result f64)
    (local $hx i32) (local $ix i32) (local $z f64) (local $r f64) (local $v f64) (local $w f64) (local $s f64) (local $a f64) (local $t f64)
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3e300000))
      (then
        (if (i32.eqz (i32.or (i32.or (local.get $ix) ${lo($('x'))}) (i32.add (local.get $iy) (i32.const 1))))
          (then (return (f64.div (f64.const 1) (f64.abs (local.get $x))))))
        (if (i32.eq (local.get $iy) (i32.const 1)) (then (return (local.get $x))))
        (local.set $w (f64.add (local.get $x) (local.get $y)))
        (return ${negRecip($('w'), $('y'))})))
    (if (i32.ge_s (local.get $ix) (i32.const 0x3fe59428))
      (then
        (if (i32.lt_s (local.get $hx) (i32.const 0))
          (then (local.set $x (f64.neg (local.get $x))) (local.set $y (f64.neg (local.get $y)))))
        (local.set $z (f64.sub ${k(PIO4)} (local.get $x)))
        (local.set $w (f64.sub ${k(PIO4LO)} (local.get $y)))
        (local.set $x (f64.add (local.get $z) (local.get $w)))
        (local.set $y (f64.const 0))))
    (local.set $z (f64.mul (local.get $x) (local.get $x)))
    (local.set $w (f64.mul (local.get $z) (local.get $z)))
    (local.set $r ${poly($('w'), [T[1], T[3], T[5], T[7], T[9], T[11]])})
    (local.set $v (f64.mul (local.get $z) ${poly($('w'), [T[2], T[4], T[6], T[8], T[10], T[12]])}))
    (local.set $s (f64.mul (local.get $z) (local.get $x)))
    (local.set $r (f64.add (local.get $y) (f64.mul (local.get $z) (f64.add (f64.mul (local.get $s) (f64.add (local.get $r) (local.get $v))) (local.get $y)))))
    (local.set $r (f64.add (local.get $r) (f64.mul ${k(T[0])} (local.get $s))))
    (local.set $w (f64.add (local.get $x) (local.get $r)))
    (if (i32.ge_s (local.get $ix) (i32.const 0x3fe59428))
      (then
        (local.set $v (f64.convert_i32_s (local.get $iy)))
        (return (f64.mul (f64.convert_i32_s (i32.sub (i32.const 1) (i32.and (i32.shr_s (local.get $hx) (i32.const 30)) (i32.const 2))))
          (f64.sub (local.get $v) (f64.mul (f64.const 2) (f64.sub (local.get $x)
            (f64.sub (f64.div (f64.mul (local.get $w) (local.get $w)) (f64.add (local.get $w) (local.get $v))) (local.get $r)))))))))
    (if (i32.eq (local.get $iy) (i32.const 1)) (then (return (local.get $w))))
    ${negRecip($('w'), $('r'))})`)

  // __ieee754_rem_pio2 (ieee754.cc) up to 2^19·π/2, inline: y0 + y1 = x − n·π/2 over the
  // caller's locals ($hx $ix $t $fn $r $w; $y0 $y1 $n out). n = 0 up to π/4, 1 up to 3π/4 (the
  // high word 0x3ff921fb aside, which subtracts π/2 in three pieces), else ⌊|x|·2/π + ½⌋, n·π/2
  // subtracted in two pieces, and in two more where fdlibm takes a second step (n ≥ 32 or |x|
  // on n·π/2's high word, and more than 16 bits cancelling). A third step, and everything past
  // 2^19·π/2, is $math.rem_pio2's.
  // the bits x's exponent exceeds y's by, as __ieee754_rem_pio2 measures a cancellation
  const drop = (y) => `(i32.sub (i32.shr_s (local.get $ix) (i32.const 20)) (i32.and (i32.shr_u ${hi($(y))} (i32.const 20)) (i32.const 0x7ff)))`
  const reduceLocals = '(local $hx i32) (local $ix i32) (local $n i32) (local $t f64) (local $fn f64) (local $r f64) (local $w f64) (local $y0 f64) (local $y1 f64)'
  const reduce = `(block $reduced (block $signed
      (if (i32.le_s (local.get $ix) (i32.const 0x3fe921fb))
        (then (local.set $y0 (local.get $x)) (local.set $y1 (f64.const 0)) (local.set $n (i32.const 0)) (br $reduced)))
      (block $general
        (br_if $general (i32.or (i32.gt_s (local.get $ix) (i32.const 0x413921fb)) (i32.eq (local.get $ix) (i32.const 0x3ff921fb))))
        (local.set $t (f64.abs (local.get $x)))
        (local.set $n (select (i32.const 1) (i32.trunc_f64_s (f64.add (f64.mul (local.get $t) ${k(INVPIO2)}) (f64.const 0.5)))
          (i32.lt_s (local.get $ix) (i32.const 0x4002d97c))))
        (local.set $fn (f64.convert_i32_s (local.get $n)))
        (local.set $r (f64.sub (local.get $t) (f64.mul (local.get $fn) ${k(PIO2_1)})))
        (local.set $w (f64.mul (local.get $fn) ${k(PIO2_1T)}))
        (local.set $y0 (f64.sub (local.get $r) (local.get $w)))
        (br_if $general (i32.and (i32.ge_s (local.get $ix) (i32.const 0x4002d97c))
          (i32.and (i32.eqz (i32.and (i32.lt_s (local.get $n) (i32.const 32))
              (i32.ne (local.get $ix) ${hi(`(f64.mul (local.get $fn) ${k(PIO2_1)})`)})))
            (i32.gt_s ${drop('y0')} (i32.const 16)))))
        (br $signed))
      ;; the second step, for an argument the first left cancelling (t, fn, r, w as it left them);
      ;; a third, and everything else, is $math.rem_pio2's
      (if (i32.and (i32.le_s (local.get $ix) (i32.const 0x413921fb)) (i32.ne (local.get $ix) (i32.const 0x3ff921fb)))
        (then
          (local.set $t (local.get $r))
          (local.set $w (f64.mul (local.get $fn) ${k(PIO2_2)}))
          (local.set $r (f64.sub (local.get $t) (local.get $w)))
          (local.set $w (f64.sub (f64.mul (local.get $fn) ${k(PIO2_2T)}) (f64.sub (f64.sub (local.get $t) (local.get $r)) (local.get $w))))
          (local.set $y0 (f64.sub (local.get $r) (local.get $w)))
          (br_if $signed (i32.le_s ${drop('y0')} (i32.const 49)))))
      (local.set $n (local.set $y0 (local.set $y1 (call $math.rem_pio2 (local.get $x)))))
      (br $reduced))
      (local.set $y1 (f64.sub (f64.sub (local.get $r) (local.get $y0)) (local.get $w)))
      (if (i32.lt_s (local.get $hx) (i32.const 0))
        (then
          (local.set $y0 (f64.neg (local.get $y0)))
          (local.set $y1 (f64.neg (local.get $y1)))
          (local.set $n (i32.sub (i32.const 0) (local.get $n))))))`

  // sin and cos (ieee754.cc): x reduced, then __kernel_sin for an even n and __kernel_cos for
  // an odd one, negated by n mod 4. The kernel is a branch on n's parity, as in C: a phase
  // advancing less than π/2 a step keeps it predictable, and even on random arguments both
  // kernels and a select cost more than the mispredictions. `small` is sin's |x| ≤ π/4,
  // __kernel_sin(x, 0, 0); cos takes n = 0, y1 = 0 there, which __kernel_cos answers the same.
  const trig = (name, small, odd, negate) => wat(`math.${name}`, `(func $math.${name} (param $x f64) (result f64)
    ${reduceLocals} (local $ki i32) (local $kz f64) (local $kv f64) (local $kr f64) (local $kq f64)
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    ${small}
    (if (i32.ge_s (local.get $ix) (i32.const 0x7ff00000)) (then (return (f64.const nan))))
    ${reduce}
    (if (i32.and (local.get $n) (i32.const 1))
      (then (local.set $r ${odd === 'cos' ? kCos('$kc', $('y0'), $('y1')) : kSin('$ks', $('y0'), $('y1'), 1)}))
      (else (local.set $r ${odd === 'cos' ? kSin('$ks', $('y0'), $('y1'), 1) : kCos('$kc', $('y0'), $('y1'))})))
    (select (f64.neg (local.get $r)) (local.get $r) (i32.and ${negate} (i32.const 2))))`)
  trig('sin', `(if (i32.le_s (local.get $ix) (i32.const 0x3fe921fb)) (then (return ${kSin('$ks0', $('x'), '(f64.const 0)', 0)})))`,
    'cos', '(local.get $n)')
  trig('cos', '', 'sin', '(i32.add (local.get $n) (i32.const 1))')
  // tan (ieee754.cc): __kernel_tan on the reduced y0 + y1 (x itself up to π/4), −1/tan for an odd n
  wat('math.tan', `(func $math.tan (param $x f64) (result f64)
    ${reduceLocals}
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.ge_s (local.get $ix) (i32.const 0x7ff00000)) (then (return (f64.const nan))))
    ${reduce}
    (call $math.k_tan (local.get $y0) (local.get $y1) (i32.sub (i32.const 1) (i32.shl (i32.and (local.get $n) (i32.const 1)) (i32.const 1)))))`)

  // R(z) = z·P(z)/Q(z) of asin and acos, P and Q as the C evaluates them
  const asinP = (z) => `(f64.mul ${z} ${poly(z, ASIN_P)})`
  const asinQ = (z) => `(f64.add (f64.const 1) (f64.mul ${z} ${poly(z, ASIN_Q)}))`

  // acos (ieee754.cc)
  wat('math.acos', `(func $math.acos (param $x f64) (result f64)
    (local $hx i32) (local $ix i32) (local $z f64) (local $p f64) (local $q f64) (local $r f64) (local $w f64) (local $s f64) (local $c f64) (local $df f64)
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.ge_s (local.get $ix) (i32.const 0x3ff00000))
      (then
        (if (i32.eqz (i32.or (i32.sub (local.get $ix) (i32.const 0x3ff00000)) ${lo($('x'))}))
          (then (return (select (f64.const 0) (f64.add ${k(PI_D)} (f64.mul (f64.const 2) ${k(PIO2_LO)})) (i32.gt_s (local.get $hx) (i32.const 0))))))
        (return (f64.const nan))))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3fe00000))
      (then
        (if (i32.le_s (local.get $ix) (i32.const 0x3c600000)) (then (return (f64.add ${k(PIO2_HI)} ${k(PIO2_LO)}))))
        (local.set $z (f64.mul (local.get $x) (local.get $x)))
        (local.set $r (f64.div ${asinP($('z'))} ${asinQ($('z'))}))
        (return (f64.sub ${k(PIO2_HI)} (f64.sub (local.get $x) (f64.sub ${k(PIO2_LO)} (f64.mul (local.get $x) (local.get $r))))))))
    (if (i32.lt_s (local.get $hx) (i32.const 0))
      (then
        (local.set $z (f64.mul (f64.add (f64.const 1) (local.get $x)) (f64.const 0.5)))
        (local.set $p ${asinP($('z'))})
        (local.set $q ${asinQ($('z'))})
        (local.set $s (f64.sqrt (local.get $z)))
        (local.set $r (f64.div (local.get $p) (local.get $q)))
        (local.set $w (f64.sub (f64.mul (local.get $r) (local.get $s)) ${k(PIO2_LO)}))
        (return (f64.sub ${k(PI_D)} (f64.mul (f64.const 2) (f64.add (local.get $s) (local.get $w)))))))
    (local.set $z (f64.mul (f64.sub (f64.const 1) (local.get $x)) (f64.const 0.5)))
    (local.set $s (f64.sqrt (local.get $z)))
    (local.set $df ${clearLo($('s'))})
    (local.set $c (f64.div (f64.sub (local.get $z) (f64.mul (local.get $df) (local.get $df))) (f64.add (local.get $s) (local.get $df))))
    (local.set $p ${asinP($('z'))})
    (local.set $q ${asinQ($('z'))})
    (local.set $r (f64.div (local.get $p) (local.get $q)))
    (local.set $w (f64.add (f64.mul (local.get $r) (local.get $s)) (local.get $c)))
    (f64.mul (f64.const 2) (f64.add (local.get $df) (local.get $w))))`)

  // asin (ieee754.cc)
  wat('math.asin', `(func $math.asin (param $x f64) (result f64)
    (local $hx i32) (local $ix i32) (local $t f64) (local $w f64) (local $p f64) (local $q f64) (local $c f64) (local $r f64) (local $s f64)
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.ge_s (local.get $ix) (i32.const 0x3ff00000))
      (then
        (if (i32.eqz (i32.or (i32.sub (local.get $ix) (i32.const 0x3ff00000)) ${lo($('x'))}))
          (then (return (f64.add (f64.mul (local.get $x) ${k(PIO2_HI)}) (f64.mul (local.get $x) ${k(PIO2_LO)})))))
        (return (f64.const nan))))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3fe00000))
      (then
        (if (i32.lt_s (local.get $ix) (i32.const 0x3e400000)) (then (return (local.get $x))))
        (local.set $t (f64.mul (local.get $x) (local.get $x)))
        (local.set $w (f64.div ${asinP($('t'))} ${asinQ($('t'))}))
        (return (f64.add (local.get $x) (f64.mul (local.get $x) (local.get $w))))))
    (local.set $w (f64.sub (f64.const 1) (f64.abs (local.get $x))))
    (local.set $t (f64.mul (local.get $w) (f64.const 0.5)))
    (local.set $p ${asinP($('t'))})
    (local.set $q ${asinQ($('t'))})
    (local.set $s (f64.sqrt (local.get $t)))
    (if (i32.ge_s (local.get $ix) (i32.const 0x3fef3333))
      (then
        (local.set $w (f64.div (local.get $p) (local.get $q)))
        (local.set $t (f64.sub ${k(PIO2_HI)} (f64.sub (f64.mul (f64.const 2) (f64.add (local.get $s) (f64.mul (local.get $s) (local.get $w)))) ${k(PIO2_LO)}))))
      (else
        (local.set $w ${clearLo($('s'))})
        (local.set $c (f64.div (f64.sub (local.get $t) (f64.mul (local.get $w) (local.get $w))) (f64.add (local.get $s) (local.get $w))))
        (local.set $r (f64.div (local.get $p) (local.get $q)))
        (local.set $p (f64.sub (f64.mul (f64.mul (f64.const 2) (local.get $s)) (local.get $r)) (f64.sub ${k(PIO2_LO)} (f64.mul (f64.const 2) (local.get $c)))))
        (local.set $q (f64.sub ${k(PIO4)} (f64.mul (f64.const 2) (local.get $w))))
        (local.set $t (f64.sub ${k(PIO4)} (f64.sub (local.get $p) (local.get $q))))))
    (select (local.get $t) (f64.neg (local.get $t)) (i32.gt_s (local.get $hx) (i32.const 0))))`)

  // atan (ieee754.cc): |x| reduced onto [0, 7/16] by atan(½), atan(1), atan(3/2) or
  // atan(∞), then an odd polynomial split into its even and odd halves
  wat('math.atan', `(func $math.atan (param $x f64) (result f64)
    (local $hx i32) (local $ix i32) (local $id i32) (local $z f64) (local $w f64) (local $s1 f64) (local $s2 f64) (local $h f64) (local $l f64)
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.ge_s (local.get $ix) (i32.const 0x44100000))
      (then
        (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
        (return (select (f64.add ${k(ATAN_HI[3])} ${k(ATAN_LO[3])}) (f64.sub ${k(-ATAN_HI[3])} ${k(ATAN_LO[3])}) (i32.gt_s (local.get $hx) (i32.const 0))))))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3fdc0000))
      (then
        (if (i32.lt_s (local.get $ix) (i32.const 0x3e400000)) (then (return (local.get $x))))
        (local.set $id (i32.const -1)))
      (else
        (local.set $x (f64.abs (local.get $x)))
        (if (i32.lt_s (local.get $ix) (i32.const 0x3ff30000))
          (then (if (i32.lt_s (local.get $ix) (i32.const 0x3fe60000))
            (then (local.set $id (i32.const 0))
              (local.set $x (f64.div (f64.sub (f64.mul (f64.const 2) (local.get $x)) (f64.const 1)) (f64.add (f64.const 2) (local.get $x)))))
            (else (local.set $id (i32.const 1))
              (local.set $x (f64.div (f64.sub (local.get $x) (f64.const 1)) (f64.add (local.get $x) (f64.const 1)))))))
          (else (if (i32.lt_s (local.get $ix) (i32.const 0x40038000))
            (then (local.set $id (i32.const 2))
              (local.set $x (f64.div (f64.sub (local.get $x) (f64.const 1.5)) (f64.add (f64.const 1) (f64.mul (f64.const 1.5) (local.get $x))))))
            (else (local.set $id (i32.const 3))
              (local.set $x (f64.div (f64.const -1) (local.get $x)))))))))
    (local.set $z (f64.mul (local.get $x) (local.get $x)))
    (local.set $w (f64.mul (local.get $z) (local.get $z)))
    (local.set $s1 (f64.mul (local.get $z) ${poly($('w'), [aT0, aT2, aT4, aT6, aT8, aT10])}))
    (local.set $s2 (f64.mul (local.get $w) ${poly($('w'), [aT1, aT3, aT5, aT7, aT9])}))
    (if (i32.lt_s (local.get $id) (i32.const 0))
      (then (return (f64.sub (local.get $x) (f64.mul (local.get $x) (f64.add (local.get $s1) (local.get $s2)))))))
    (block $got (block $i2 (block $i1 (block $i0
      (br_table $i0 $i1 $i2 $got (local.get $id)))
      (local.set $h ${k(ATAN_HI[0])}) (local.set $l ${k(ATAN_LO[0])}) (br $got))
      (local.set $h ${k(ATAN_HI[1])}) (local.set $l ${k(ATAN_LO[1])}) (br $got))
      (local.set $h ${k(ATAN_HI[2])}) (local.set $l ${k(ATAN_LO[2])}) (br $got))
    (if (i32.eq (local.get $id) (i32.const 3)) (then (local.set $h ${k(ATAN_HI[3])}) (local.set $l ${k(ATAN_LO[3])})))
    (local.set $z (f64.sub (local.get $h) (f64.sub (f64.sub (f64.mul (local.get $x) (f64.add (local.get $s1) (local.get $s2))) (local.get $l)) (local.get $x))))
    (select (f64.neg (local.get $z)) (local.get $z) (i32.lt_s (local.get $hx) (i32.const 0))))`)

  // atan2 (ieee754.cc): the signed-zero and infinite quadrants by table, else atan(|y/x|)
  // placed by the signs (m = 2·sign(x) + sign(y)); the tiny = 1e-300 additions round away
  wat('math.atan2', `(func $math.atan2 (param $y f64) (param $x f64) (result f64)
    (local $hx i32) (local $hy i32) (local $ix i32) (local $iy i32) (local $m i32) (local $kk i32) (local $z f64)
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (f64.ne (local.get $y) (local.get $y)) (then (return (local.get $y))))
    (if (f64.eq (local.get $x) (f64.const 1)) (then (return (call $math.atan (local.get $y)))))
    (local.set $hx ${hi($('x'))})
    (local.set $hy ${hi($('y'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (local.set $iy (i32.and (local.get $hy) (i32.const 0x7fffffff)))
    (local.set $m (i32.or (i32.and (i32.shr_s (local.get $hy) (i32.const 31)) (i32.const 1)) (i32.and (i32.shr_s (local.get $hx) (i32.const 30)) (i32.const 2))))
    (if (f64.eq (local.get $y) (f64.const 0))
      (then (if (i32.lt_s (local.get $m) (i32.const 2)) (then (return (local.get $y))))
        (return (select ${k(-PI_D)} ${k(PI_D)} (i32.eq (local.get $m) (i32.const 3))))))
    (if (f64.eq (local.get $x) (f64.const 0))
      (then (return (select ${k(-PI_O_2)} ${k(PI_O_2)} (i32.lt_s (local.get $hy) (i32.const 0))))))
    (if (i32.eq (local.get $ix) (i32.const 0x7ff00000))
      (then
        (if (i32.eq (local.get $iy) (i32.const 0x7ff00000))
          (then (return (select
            (select ${k(-3 * PI_O_4)} ${k(3 * PI_O_4)} (i32.and (local.get $m) (i32.const 1)))
            (select ${k(-PI_O_4)} ${k(PI_O_4)} (i32.and (local.get $m) (i32.const 1)))
            (i32.and (local.get $m) (i32.const 2))))))
        (return (select
          (select ${k(-PI_D)} ${k(PI_D)} (i32.and (local.get $m) (i32.const 1)))
          (select (f64.const -0) (f64.const 0) (i32.and (local.get $m) (i32.const 1)))
          (i32.and (local.get $m) (i32.const 2))))))
    (if (i32.eq (local.get $iy) (i32.const 0x7ff00000))
      (then (return (select ${k(-PI_O_2)} ${k(PI_O_2)} (i32.lt_s (local.get $hy) (i32.const 0))))))
    (local.set $kk (i32.shr_s (i32.sub (local.get $iy) (local.get $ix)) (i32.const 20)))
    (if (i32.gt_s (local.get $kk) (i32.const 60))
      (then
        (local.set $z (f64.add ${k(PI_O_2)} (f64.mul (f64.const 0.5) ${k(PI_LO)})))
        (local.set $m (i32.and (local.get $m) (i32.const 1))))
      (else (if (i32.and (i32.lt_s (local.get $hx) (i32.const 0)) (i32.lt_s (local.get $kk) (i32.const -60)))
        (then (local.set $z (f64.const 0)))
        (else (local.set $z (call $math.atan (f64.abs (f64.div (local.get $y) (local.get $x)))))))))
    (block $m3 (block $m2 (block $m1 (block $m0
      (br_table $m0 $m1 $m2 $m3 (local.get $m)))
      (return (local.get $z)))
      (return (f64.neg (local.get $z))))
      (return (f64.sub ${k(PI_D)} (f64.sub (local.get $z) ${k(PI_LO)}))))
    (f64.sub (f64.sub (local.get $z) ${k(PI_LO)}) ${k(PI_D)}))`)

  // exp (ieee754.cc): x = k·ln2 + r (hi − lo), exp(r) = 1 + r + r·c/(2 − c) on the
  // remainder's Remez polynomial, times 2^k built into the exponent
  wat('math.exp', `(func $math.exp (param $x f64) (result f64)
    (local $hx i32) (local $xsb i32) (local $kk i32) (local $hi f64) (local $lo f64) (local $t f64) (local $c f64) (local $y f64)
    (local.set $hx ${hi($('x'))})
    (local.set $xsb (i32.shr_u (local.get $hx) (i32.const 31)))
    (local.set $hx (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.ge_u (local.get $hx) (i32.const 0x40862e42))
      (then
        (if (i32.ge_u (local.get $hx) (i32.const 0x7ff00000))
          (then (return (select (f64.const 0) (local.get $x) (f64.eq (local.get $x) (f64.const -inf))))))
        (if (f64.gt (local.get $x) ${k(EXP_OVER)}) (then (return (f64.const inf))))
        (if (f64.lt (local.get $x) ${k(EXP_UNDER)}) (then (return (f64.const 0))))))
    (if (i32.gt_u (local.get $hx) (i32.const 0x3fd62e42))
      (then
        (if (i32.lt_u (local.get $hx) (i32.const 0x3ff0a2b2))
          (then
            (if (f64.eq (local.get $x) (f64.const 1)) (then (return ${k(EXP_E)})))
            (local.set $hi (f64.sub (local.get $x) (select ${k(-LN2_HI)} ${k(LN2_HI)} (local.get $xsb))))
            (local.set $lo (select ${k(-LN2_LO)} ${k(LN2_LO)} (local.get $xsb)))
            (local.set $kk (i32.sub (i32.const 1) (i32.shl (local.get $xsb) (i32.const 1)))))
          (else
            (local.set $kk (i32.trunc_f64_s (f64.add (f64.mul ${k(INVLN2)} (local.get $x)) (select (f64.const -0.5) (f64.const 0.5) (local.get $xsb)))))
            (local.set $t (f64.convert_i32_s (local.get $kk)))
            (local.set $hi (f64.sub (local.get $x) (f64.mul (local.get $t) ${k(LN2_HI)})))
            (local.set $lo (f64.mul (local.get $t) ${k(LN2_LO)}))))
        (local.set $x (f64.sub (local.get $hi) (local.get $lo))))
      (else (if (i32.lt_u (local.get $hx) (i32.const 0x3e300000)) (then (return (f64.add (f64.const 1) (local.get $x)))))))
    (local.set $t (f64.mul (local.get $x) (local.get $x)))
    (local.set $c (f64.sub (local.get $x) (f64.mul (local.get $t) ${poly($('t'), EXP_P)})))
    (if (i32.eqz (local.get $kk))
      (then (return (f64.sub (f64.const 1) (f64.sub (f64.div (f64.mul (local.get $x) (local.get $c)) (f64.sub (local.get $c) (f64.const 2))) (local.get $x))))))
    (local.set $y (f64.sub (f64.const 1) (f64.sub (f64.sub (local.get $lo) (f64.div (f64.mul (local.get $x) (local.get $c)) (f64.sub (f64.const 2) (local.get $c)))) (local.get $hi))))
    (if (i32.ge_s (local.get $kk) (i32.const -1021))
      (then
        (if (i32.eq (local.get $kk) (i32.const 1024)) (then (return (f64.mul (f64.mul (local.get $y) (f64.const 2)) ${k(TWO1023)}))))
        (return (f64.mul (local.get $y) ${fromHi(`(i32.add (i32.const 0x3ff00000) (i32.shl (local.get $kk) (i32.const 20)))`)}))))
    (f64.mul (f64.mul (local.get $y) ${fromHi(`(i32.add (i32.const 0x3ff00000) (i32.shl (i32.add (local.get $kk) (i32.const 1000)) (i32.const 20)))`)}) ${k(TWOM1000)}))`)

  // expm1 (ieee754.cc): the same reduction with a correction term c, and a rational form
  // of e^r − 1 that keeps its digits near 0
  wat('math.expm1', `(func $math.expm1 (param $x f64) (result f64)
    (local $hx i32) (local $xsb i32) (local $kk i32) (local $y f64) (local $hi f64) (local $lo f64) (local $c f64) (local $t f64) (local $e f64)
    (local $hxs f64) (local $hfx f64) (local $r1 f64) (local $twopk f64)
    (local.set $hx ${hi($('x'))})
    (local.set $xsb (i32.and (local.get $hx) (i32.const 0x80000000)))
    (local.set $hx (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.ge_u (local.get $hx) (i32.const 0x4043687a))
      (then
        (if (i32.ge_u (local.get $hx) (i32.const 0x40862e42))
          (then
            (if (i32.ge_u (local.get $hx) (i32.const 0x7ff00000))
              (then (return (select (f64.const -1) (local.get $x) (f64.eq (local.get $x) (f64.const -inf))))))
            (if (f64.gt (local.get $x) ${k(EXP_OVER)}) (then (return (f64.const inf))))))
        (if (local.get $xsb) (then (return (f64.const -1))))))
    (if (i32.gt_u (local.get $hx) (i32.const 0x3fd62e42))
      (then
        (if (i32.lt_u (local.get $hx) (i32.const 0x3ff0a2b2))
          (then (if (i32.eqz (local.get $xsb))
            (then (local.set $hi (f64.sub (local.get $x) ${k(LN2_HI)})) (local.set $lo ${k(LN2_LO)}) (local.set $kk (i32.const 1)))
            (else (local.set $hi (f64.add (local.get $x) ${k(LN2_HI)})) (local.set $lo ${k(-LN2_LO)}) (local.set $kk (i32.const -1)))))
          (else
            (local.set $kk (i32.trunc_f64_s (f64.add (f64.mul ${k(INVLN2)} (local.get $x)) (select (f64.const 0.5) (f64.const -0.5) (i32.eqz (local.get $xsb))))))
            (local.set $t (f64.convert_i32_s (local.get $kk)))
            (local.set $hi (f64.sub (local.get $x) (f64.mul (local.get $t) ${k(LN2_HI)})))
            (local.set $lo (f64.mul (local.get $t) ${k(LN2_LO)}))))
        (local.set $x (f64.sub (local.get $hi) (local.get $lo)))
        (local.set $c (f64.sub (f64.sub (local.get $hi) (local.get $x)) (local.get $lo))))
      (else (if (i32.lt_u (local.get $hx) (i32.const 0x3c900000)) (then (return (local.get $x))))))
    (local.set $hfx (f64.mul (f64.const 0.5) (local.get $x)))
    (local.set $hxs (f64.mul (local.get $x) (local.get $hfx)))
    (local.set $r1 (f64.add (f64.const 1) (f64.mul (local.get $hxs) ${poly($('hxs'), EXPM1_Q)})))
    (local.set $t (f64.sub (f64.const 3) (f64.mul (local.get $r1) (local.get $hfx))))
    (local.set $e (f64.mul (local.get $hxs) (f64.div (f64.sub (local.get $r1) (local.get $t)) (f64.sub (f64.const 6) (f64.mul (local.get $x) (local.get $t))))))
    (if (i32.eqz (local.get $kk)) (then (return (f64.sub (local.get $x) (f64.sub (f64.mul (local.get $x) (local.get $e)) (local.get $hxs))))))
    (local.set $twopk ${fromHi(`(i32.add (i32.const 0x3ff00000) (i32.shl (local.get $kk) (i32.const 20)))`)})
    (local.set $e (f64.sub (f64.mul (local.get $x) (f64.sub (local.get $e) (local.get $c))) (local.get $c)))
    (local.set $e (f64.sub (local.get $e) (local.get $hxs)))
    (if (i32.eq (local.get $kk) (i32.const -1))
      (then (return (f64.sub (f64.mul (f64.const 0.5) (f64.sub (local.get $x) (local.get $e))) (f64.const 0.5)))))
    (if (i32.eq (local.get $kk) (i32.const 1))
      (then
        (if (f64.lt (local.get $x) (f64.const -0.25))
          (then (return (f64.mul (f64.const -2) (f64.sub (local.get $e) (f64.add (local.get $x) (f64.const 0.5)))))))
        (return (f64.add (f64.const 1) (f64.mul (f64.const 2) (f64.sub (local.get $x) (local.get $e)))))))
    (if (i32.or (i32.le_s (local.get $kk) (i32.const -2)) (i32.gt_s (local.get $kk) (i32.const 56)))
      (then
        (local.set $y (f64.sub (f64.const 1) (f64.sub (local.get $e) (local.get $x))))
        (local.set $y (select (f64.mul (f64.mul (local.get $y) (f64.const 2)) ${k(EXPM1_TWO1023)}) (f64.mul (local.get $y) (local.get $twopk))
          (i32.eq (local.get $kk) (i32.const 1024))))
        (return (f64.sub (local.get $y) (f64.const 1)))))
    (if (i32.lt_s (local.get $kk) (i32.const 20))
      (then
        (local.set $t ${fromHi(`(i32.sub (i32.const 0x3ff00000) (i32.shr_s (i32.const 0x200000) (local.get $kk)))`)})
        (return (f64.mul (f64.sub (local.get $t) (f64.sub (local.get $e) (local.get $x))) (local.get $twopk)))))
    (local.set $t ${fromHi(`(i32.shl (i32.sub (i32.const 0x3ff) (local.get $kk)) (i32.const 20))`)})
    (local.set $y (f64.sub (local.get $x) (f64.add (local.get $e) (local.get $t))))
    (local.set $y (f64.add (local.get $y) (f64.const 1)))
    (f64.mul (local.get $y) (local.get $twopk)))`)

  // log (ieee754.cc): x = 2^k·(1 + f), √2/2 < 1 + f < √2; log(1 + f) through s = f/(2 + f)
  // and the Remez polynomial in s²; k·ln2 added as hi + lo
  wat('math.log', `(func $math.log (param $x f64) (result f64)
    (local $hx i32) (local $kk i32) (local $i i32) (local $j i32)
    (local $f f64) (local $s f64) (local $z f64) (local $w f64) (local $R f64) (local $t1 f64) (local $t2 f64) (local $dk f64) (local $hfsq f64)
    (local.set $hx ${hi($('x'))})
    (if (i32.lt_s (local.get $hx) (i32.const 0x00100000))
      (then
        (if (f64.eq (local.get $x) (f64.const 0)) (then (return (f64.const -inf))))
        (if (i32.lt_s (local.get $hx) (i32.const 0)) (then (return (f64.const nan))))
        (local.set $kk (i32.const -54))
        (local.set $x (f64.mul (local.get $x) ${k(TWO54)}))
        (local.set $hx ${hi($('x'))})))
    (if (i32.ge_s (local.get $hx) (i32.const 0x7ff00000)) (then (return (local.get $x))))
    (local.set $kk (i32.add (local.get $kk) (i32.sub (i32.shr_s (local.get $hx) (i32.const 20)) (i32.const 1023))))
    (local.set $hx (i32.and (local.get $hx) (i32.const 0x000fffff)))
    (local.set $i (i32.and (i32.add (local.get $hx) (i32.const 0x95f64)) (i32.const 0x100000)))
    (local.set $x ${withHi($('x'), `(i32.or (local.get $hx) (i32.xor (local.get $i) (i32.const 0x3ff00000)))`)})
    (local.set $kk (i32.add (local.get $kk) (i32.shr_s (local.get $i) (i32.const 20))))
    (local.set $f (f64.sub (local.get $x) (f64.const 1)))
    (local.set $dk (f64.convert_i32_s (local.get $kk)))
    (if (i32.lt_s (i32.and (i32.const 0x000fffff) (i32.add (i32.const 2) (local.get $hx))) (i32.const 3))
      (then
        (if (f64.eq (local.get $f) (f64.const 0))
          (then
            (if (i32.eqz (local.get $kk)) (then (return (f64.const 0))))
            (return (f64.add (f64.mul (local.get $dk) ${k(LN2_HI)}) (f64.mul (local.get $dk) ${k(LN2_LO)})))))
        (local.set $R (f64.mul (f64.mul (local.get $f) (local.get $f)) (f64.sub (f64.const 0.5) (f64.mul (f64.const 0.3333333333333333) (local.get $f)))))
        (if (i32.eqz (local.get $kk)) (then (return (f64.sub (local.get $f) (local.get $R)))))
        (return (f64.sub (f64.mul (local.get $dk) ${k(LN2_HI)}) (f64.sub (f64.sub (local.get $R) (f64.mul (local.get $dk) ${k(LN2_LO)})) (local.get $f))))))
    (local.set $s (f64.div (local.get $f) (f64.add (f64.const 2) (local.get $f))))
    (local.set $z (f64.mul (local.get $s) (local.get $s)))
    (local.set $i (i32.sub (local.get $hx) (i32.const 0x6147a)))
    (local.set $w (f64.mul (local.get $z) (local.get $z)))
    (local.set $j (i32.sub (i32.const 0x6b851) (local.get $hx)))
    (local.set $t1 (f64.mul (local.get $w) ${poly($('w'), [Lg2, Lg4, Lg6])}))
    (local.set $t2 (f64.mul (local.get $z) ${poly($('w'), [Lg1, Lg3, Lg5, Lg7])}))
    (local.set $R (f64.add (local.get $t2) (local.get $t1)))
    (if (i32.gt_s (i32.or (local.get $i) (local.get $j)) (i32.const 0))
      (then
        (local.set $hfsq (f64.mul (f64.mul (f64.const 0.5) (local.get $f)) (local.get $f)))
        (if (i32.eqz (local.get $kk))
          (then (return (f64.sub (local.get $f) (f64.sub (local.get $hfsq) (f64.mul (local.get $s) (f64.add (local.get $hfsq) (local.get $R))))))))
        (return (f64.sub (f64.mul (local.get $dk) ${k(LN2_HI)}) (f64.sub (f64.sub (local.get $hfsq)
          (f64.add (f64.mul (local.get $s) (f64.add (local.get $hfsq) (local.get $R))) (f64.mul (local.get $dk) ${k(LN2_LO)}))) (local.get $f))))))
    (if (i32.eqz (local.get $kk))
      (then (return (f64.sub (local.get $f) (f64.mul (local.get $s) (f64.sub (local.get $f) (local.get $R)))))))
    (f64.sub (f64.mul (local.get $dk) ${k(LN2_HI)})
      (f64.sub (f64.sub (f64.mul (local.get $s) (f64.sub (local.get $f) (local.get $R))) (f64.mul (local.get $dk) ${k(LN2_LO)})) (local.get $f))))`)

  // log1p (ieee754.cc): 1 + x = 2^k·(1 + f) with the rounding of 1 + x carried as c/u
  wat('math.log1p', `(func $math.log1p (param $x f64) (result f64)
    (local $hx i32) (local $ax i32) (local $kk i32) (local $hu i32)
    (local $f f64) (local $c f64) (local $u f64) (local $hfsq f64) (local $R f64) (local $s f64) (local $z f64) (local $dk f64)
    (local.set $hx ${hi($('x'))})
    (local.set $ax (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (local.set $kk (i32.const 1))
    (if (i32.lt_s (local.get $hx) (i32.const 0x3fda827a))
      (then
        (if (i32.ge_s (local.get $ax) (i32.const 0x3ff00000))
          (then (return (select (f64.const -inf) (f64.const nan) (f64.eq (local.get $x) (f64.const -1))))))
        (if (i32.lt_s (local.get $ax) (i32.const 0x3e200000))
          (then
            (if (i32.lt_s (local.get $ax) (i32.const 0x3c900000)) (then (return (local.get $x))))
            (return (f64.sub (local.get $x) (f64.mul (f64.mul (local.get $x) (local.get $x)) (f64.const 0.5))))))
        (if (i32.or (i32.gt_s (local.get $hx) (i32.const 0)) (i32.le_s (local.get $hx) (i32.const 0xbfd2bec4)))
          (then (local.set $kk (i32.const 0)) (local.set $f (local.get $x)) (local.set $hu (i32.const 1))))))
    (if (i32.ge_s (local.get $hx) (i32.const 0x7ff00000)) (then (return (local.get $x))))
    (if (local.get $kk)
      (then
        (if (i32.lt_s (local.get $hx) (i32.const 0x43400000))
          (then
            (local.set $u (f64.add (f64.const 1) (local.get $x)))
            (local.set $hu ${hi($('u'))})
            (local.set $kk (i32.sub (i32.shr_s (local.get $hu) (i32.const 20)) (i32.const 1023)))
            (local.set $c (select (f64.sub (f64.const 1) (f64.sub (local.get $u) (local.get $x))) (f64.sub (local.get $x) (f64.sub (local.get $u) (f64.const 1)))
              (i32.gt_s (local.get $kk) (i32.const 0))))
            (local.set $c (f64.div (local.get $c) (local.get $u))))
          (else
            (local.set $u (local.get $x))
            (local.set $hu ${hi($('u'))})
            (local.set $kk (i32.sub (i32.shr_s (local.get $hu) (i32.const 20)) (i32.const 1023)))
            (local.set $c (f64.const 0))))
        (local.set $hu (i32.and (local.get $hu) (i32.const 0x000fffff)))
        (if (i32.lt_s (local.get $hu) (i32.const 0x6a09e))
          (then (local.set $u ${withHi($('u'), `(i32.or (local.get $hu) (i32.const 0x3ff00000))`)}))
          (else
            (local.set $kk (i32.add (local.get $kk) (i32.const 1)))
            (local.set $u ${withHi($('u'), `(i32.or (local.get $hu) (i32.const 0x3fe00000))`)})
            (local.set $hu (i32.shr_s (i32.sub (i32.const 0x00100000) (local.get $hu)) (i32.const 2)))))
        (local.set $f (f64.sub (local.get $u) (f64.const 1)))))
    (local.set $hfsq (f64.mul (f64.mul (f64.const 0.5) (local.get $f)) (local.get $f)))
    (local.set $dk (f64.convert_i32_s (local.get $kk)))
    (if (i32.eqz (local.get $hu))
      (then
        (if (f64.eq (local.get $f) (f64.const 0))
          (then
            (if (i32.eqz (local.get $kk)) (then (return (f64.const 0))))
            (local.set $c (f64.add (local.get $c) (f64.mul (local.get $dk) ${k(LN2_LO)})))
            (return (f64.add (f64.mul (local.get $dk) ${k(LN2_HI)}) (local.get $c)))))
        (local.set $R (f64.mul (local.get $hfsq) (f64.sub (f64.const 1) (f64.mul (f64.const 0.6666666666666666) (local.get $f)))))
        (if (i32.eqz (local.get $kk)) (then (return (f64.sub (local.get $f) (local.get $R)))))
        (return (f64.sub (f64.mul (local.get $dk) ${k(LN2_HI)})
          (f64.sub (f64.sub (local.get $R) (f64.add (f64.mul (local.get $dk) ${k(LN2_LO)}) (local.get $c))) (local.get $f))))))
    (local.set $s (f64.div (local.get $f) (f64.add (f64.const 2) (local.get $f))))
    (local.set $z (f64.mul (local.get $s) (local.get $s)))
    (local.set $R (f64.mul (local.get $z) ${poly($('z'), LG)}))
    (if (i32.eqz (local.get $kk))
      (then (return (f64.sub (local.get $f) (f64.sub (local.get $hfsq) (f64.mul (local.get $s) (f64.add (local.get $hfsq) (local.get $R))))))))
    (f64.sub (f64.mul (local.get $dk) ${k(LN2_HI)})
      (f64.sub (f64.sub (local.get $hfsq) (f64.add (f64.mul (local.get $s) (f64.add (local.get $hfsq) (local.get $R)))
        (f64.add (f64.mul (local.get $dk) ${k(LN2_LO)}) (local.get $c)))) (local.get $f))))`)

  // log2 (ieee754.cc, FreeBSD's e_log2.c on k_log1p): x reduced as in log, then
  // (f − f²/2 + k_log1p(f))/ln2 + k with f − f²/2 split at its low word
  wat('math.log2', `(func $math.log2 (param $x f64) (result f64)
    (local $hx i32) (local $kk i32) (local $i i32)
    (local $f f64) (local $hfsq f64) (local $hi f64) (local $lo f64) (local $r f64) (local $s f64) (local $z f64) (local $w f64)
    (local $vhi f64) (local $vlo f64) (local $y f64)
    (local.set $hx ${hi($('x'))})
    (if (i32.lt_s (local.get $hx) (i32.const 0x00100000))
      (then
        (if (f64.eq (local.get $x) (f64.const 0)) (then (return (f64.const -inf))))
        (if (i32.lt_s (local.get $hx) (i32.const 0)) (then (return (f64.const nan))))
        (local.set $kk (i32.const -54))
        (local.set $x (f64.mul (local.get $x) ${k(TWO54)}))
        (local.set $hx ${hi($('x'))})))
    (if (i32.ge_s (local.get $hx) (i32.const 0x7ff00000)) (then (return (local.get $x))))
    (if (f64.eq (local.get $x) (f64.const 1)) (then (return (f64.const 0))))
    (local.set $kk (i32.add (local.get $kk) (i32.sub (i32.shr_s (local.get $hx) (i32.const 20)) (i32.const 1023))))
    (local.set $hx (i32.and (local.get $hx) (i32.const 0x000fffff)))
    (local.set $i (i32.and (i32.add (local.get $hx) (i32.const 0x95f64)) (i32.const 0x100000)))
    (local.set $x ${withHi($('x'), `(i32.or (local.get $hx) (i32.xor (local.get $i) (i32.const 0x3ff00000)))`)})
    (local.set $kk (i32.add (local.get $kk) (i32.shr_s (local.get $i) (i32.const 20))))
    (local.set $y (f64.convert_i32_s (local.get $kk)))
    (local.set $f (f64.sub (local.get $x) (f64.const 1)))
    (local.set $hfsq (f64.mul (f64.mul (f64.const 0.5) (local.get $f)) (local.get $f)))
    ;; k_log1p(f)
    (local.set $s (f64.div (local.get $f) (f64.add (f64.const 2) (local.get $f))))
    (local.set $z (f64.mul (local.get $s) (local.get $s)))
    (local.set $w (f64.mul (local.get $z) (local.get $z)))
    (local.set $r (f64.mul (local.get $s) (f64.add (f64.mul (f64.mul (f64.const 0.5) (local.get $f)) (local.get $f))
      (f64.add (f64.mul (local.get $z) ${poly($('w'), [Lg1, Lg3, Lg5, Lg7])}) (f64.mul (local.get $w) ${poly($('w'), [Lg2, Lg4, Lg6])})))))
    (local.set $hi ${clearLo(`(f64.sub (local.get $f) (local.get $hfsq))`)})
    (local.set $lo (f64.add (f64.sub (f64.sub (local.get $f) (local.get $hi)) (local.get $hfsq)) (local.get $r)))
    (local.set $vhi (f64.mul (local.get $hi) ${k(IVLN2HI)}))
    (local.set $vlo (f64.add (f64.mul (f64.add (local.get $lo) (local.get $hi)) ${k(IVLN2LO)}) (f64.mul (local.get $lo) ${k(IVLN2HI)})))
    (local.set $w (f64.add (local.get $y) (local.get $vhi)))
    (local.set $vlo (f64.add (local.get $vlo) (f64.add (f64.sub (local.get $y) (local.get $w)) (local.get $vhi))))
    (f64.add (local.get $vlo) (local.get $w)))`)

  // log10 (ieee754.cc, fdlibm's e_log10.c): x = 2^n·m with m ∈ [½, 2) chosen by n's sign,
  // log10(x) = n·log10_2hi + (n·log10_2lo + ivln10·log(m))
  wat('math.log10', `(func $math.log10 (param $x f64) (result f64)
    (local $hx i32) (local $lx i32) (local $kk i32) (local $i i32) (local $y f64)
    (local.set $hx ${hi($('x'))})
    (if (i32.lt_s (local.get $hx) (i32.const 0x00100000))
      (then
        (if (f64.eq (local.get $x) (f64.const 0)) (then (return (f64.const -inf))))
        (if (i32.lt_s (local.get $hx) (i32.const 0)) (then (return (f64.const nan))))
        (local.set $kk (i32.const -54))
        (local.set $x (f64.mul (local.get $x) ${k(TWO54)}))
        (local.set $hx ${hi($('x'))})))
    (if (i32.ge_s (local.get $hx) (i32.const 0x7ff00000)) (then (return (local.get $x))))
    (if (f64.eq (local.get $x) (f64.const 1)) (then (return (f64.const 0))))
    (local.set $lx ${lo($('x'))})
    (local.set $kk (i32.add (local.get $kk) (i32.sub (i32.shr_s (local.get $hx) (i32.const 20)) (i32.const 1023))))
    (local.set $i (i32.shr_u (local.get $kk) (i32.const 31)))
    (local.set $hx (i32.or (i32.and (local.get $hx) (i32.const 0x000fffff)) (i32.shl (i32.sub (i32.const 0x3ff) (local.get $i)) (i32.const 20))))
    (local.set $y (f64.convert_i32_s (i32.add (local.get $kk) (local.get $i))))
    (local.set $x (f64.reinterpret_i64 (i64.or (i64.shl (i64.extend_i32_u (local.get $hx)) (i64.const 32)) (i64.extend_i32_u (local.get $lx)))))
    (f64.add (f64.add (f64.mul (local.get $y) ${k(LOG10_2LO)}) (f64.mul ${k(IVLN10)} (call $math.log (local.get $x))))
      (f64.mul (local.get $y) ${k(LOG10_2HI)})))`)

  // sinh (ieee754.cc): h·(E + E/(E + 1)) with E = expm1(|x|) below 22, then h·e^|x|,
  // then (h·e^(|x|/2))·e^(|x|/2) up to the overflow threshold
  wat('math.sinh', `(func $math.sinh (param $x f64) (result f64)
    (local $h f64) (local $ax f64) (local $t f64) (local $w f64)
    (local.set $h (select (f64.const -0.5) (f64.const 0.5) (f64.lt (local.get $x) (f64.const 0))))
    (local.set $ax (f64.abs (local.get $x)))
    (if (f64.lt (local.get $ax) (f64.const 22))
      (then
        (if (f64.lt (local.get $ax) ${k(TWO_M28)}) (then (return (local.get $x))))
        (local.set $t (call $math.expm1 (local.get $ax)))
        (if (f64.lt (local.get $ax) (f64.const 1))
          (then (return (f64.mul (local.get $h) (f64.sub (f64.mul (f64.const 2) (local.get $t))
            (f64.div (f64.mul (local.get $t) (local.get $t)) (f64.add (local.get $t) (f64.const 1))))))))
        (return (f64.mul (local.get $h) (f64.add (local.get $t) (f64.div (local.get $t) (f64.add (local.get $t) (f64.const 1))))))))
    (if (f64.lt (local.get $ax) ${k(LOG_MAXD)}) (then (return (f64.mul (local.get $h) (call $math.exp (local.get $ax))))))
    (if (f64.le (local.get $ax) ${k(SINH_OVER)})
      (then
        (local.set $w (call $math.exp (f64.mul (f64.const 0.5) (local.get $ax))))
        (return (f64.mul (f64.mul (local.get $h) (local.get $w)) (local.get $w)))))
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (f64.copysign (f64.const inf) (local.get $x)))`)

  // cosh (ieee754.cc)
  wat('math.cosh', `(func $math.cosh (param $x f64) (result f64)
    (local $ix i32) (local $t f64) (local $w f64)
    (local.set $ix (i32.and ${hi($('x'))} (i32.const 0x7fffffff)))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3fd62e43))
      (then
        (local.set $t (call $math.expm1 (f64.abs (local.get $x))))
        (local.set $w (f64.add (f64.const 1) (local.get $t)))
        (if (i32.lt_s (local.get $ix) (i32.const 0x3c800000)) (then (return (local.get $w))))
        (return (f64.add (f64.const 1) (f64.div (f64.mul (local.get $t) (local.get $t)) (f64.add (local.get $w) (local.get $w)))))))
    (if (i32.lt_s (local.get $ix) (i32.const 0x40360000))
      (then
        (local.set $t (call $math.exp (f64.abs (local.get $x))))
        (return (f64.add (f64.mul (f64.const 0.5) (local.get $t)) (f64.div (f64.const 0.5) (local.get $t))))))
    (if (i32.lt_s (local.get $ix) (i32.const 0x40862e42)) (then (return (f64.mul (f64.const 0.5) (call $math.exp (f64.abs (local.get $x)))))))
    (if (f64.le (f64.abs (local.get $x)) ${k(SINH_OVER)})
      (then
        (local.set $w (call $math.exp (f64.mul (f64.const 0.5) (f64.abs (local.get $x)))))
        (return (f64.mul (f64.mul (f64.const 0.5) (local.get $w)) (local.get $w)))))
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (f64.const inf))`)

  // tanh (ieee754.cc): −t/(t + 2), t = expm1(−2|x|), below 1; 1 − 2/(t + 2), t = expm1(2|x|),
  // below 22; ±1 beyond
  wat('math.tanh', `(func $math.tanh (param $x f64) (result f64)
    (local $jx i32) (local $ix i32) (local $t f64) (local $z f64)
    (local.set $jx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $jx) (i32.const 0x7fffffff)))
    (if (i32.ge_s (local.get $ix) (i32.const 0x7ff00000))
      (then
        (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
        (return (f64.copysign (f64.const 1) (local.get $x)))))
    (if (i32.ge_s (local.get $ix) (i32.const 0x40360000)) (then (return (f64.copysign (f64.const 1) (local.get $x)))))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3e300000)) (then (return (local.get $x))))
    (if (i32.ge_s (local.get $ix) (i32.const 0x3ff00000))
      (then
        (local.set $t (call $math.expm1 (f64.mul (f64.const 2) (f64.abs (local.get $x)))))
        (local.set $z (f64.sub (f64.const 1) (f64.div (f64.const 2) (f64.add (local.get $t) (f64.const 2))))))
      (else
        (local.set $t (call $math.expm1 (f64.mul (f64.const -2) (f64.abs (local.get $x)))))
        (local.set $z (f64.div (f64.neg (local.get $t)) (f64.add (local.get $t) (f64.const 2))))))
    (select (local.get $z) (f64.neg (local.get $z)) (i32.ge_s (local.get $jx) (i32.const 0))))`)

  // asinh (ieee754.cc)
  wat('math.asinh', `(func $math.asinh (param $x f64) (result f64)
    (local $hx i32) (local $ix i32) (local $t f64) (local $w f64)
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (i32.ge_s (local.get $ix) (i32.const 0x7ff00000)) (then (return (local.get $x))))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3e300000)) (then (return (local.get $x))))
    (if (i32.gt_s (local.get $ix) (i32.const 0x41b00000))
      (then (local.set $w (f64.add (call $math.log (f64.abs (local.get $x))) ${k(LN2)})))
      (else (if (i32.gt_s (local.get $ix) (i32.const 0x40000000))
        (then
          (local.set $t (f64.abs (local.get $x)))
          (local.set $w (call $math.log (f64.add (f64.mul (f64.const 2) (local.get $t))
            (f64.div (f64.const 1) (f64.add (f64.sqrt (f64.add (f64.mul (local.get $x) (local.get $x)) (f64.const 1))) (local.get $t)))))))
        (else
          (local.set $t (f64.mul (local.get $x) (local.get $x)))
          (local.set $w (call $math.log1p (f64.add (f64.abs (local.get $x))
            (f64.div (local.get $t) (f64.add (f64.const 1) (f64.sqrt (f64.add (f64.const 1) (local.get $t))))))))))))
    (select (local.get $w) (f64.neg (local.get $w)) (i32.gt_s (local.get $hx) (i32.const 0))))`)

  // acosh (ieee754.cc)
  wat('math.acosh', `(func $math.acosh (param $x f64) (result f64)
    (local $hx i32) (local $t f64)
    (local.set $hx ${hi($('x'))})
    (if (i32.lt_s (local.get $hx) (i32.const 0x3ff00000)) (then (return (f64.const nan))))
    (if (i32.ge_s (local.get $hx) (i32.const 0x41b00000))
      (then
        (if (i32.ge_s (local.get $hx) (i32.const 0x7ff00000)) (then (return (local.get $x))))
        (return (f64.add (call $math.log (local.get $x)) ${k(LN2)}))))
    (if (f64.eq (local.get $x) (f64.const 1)) (then (return (f64.const 0))))
    (if (i32.gt_s (local.get $hx) (i32.const 0x40000000))
      (then
        (local.set $t (f64.mul (local.get $x) (local.get $x)))
        (return (call $math.log (f64.sub (f64.mul (f64.const 2) (local.get $x))
          (f64.div (f64.const 1) (f64.add (local.get $x) (f64.sqrt (f64.sub (local.get $t) (f64.const 1))))))))))
    (local.set $t (f64.sub (local.get $x) (f64.const 1)))
    (call $math.log1p (f64.add (local.get $t) (f64.sqrt (f64.add (f64.mul (f64.const 2) (local.get $t)) (f64.mul (local.get $t) (local.get $t)))))))`)

  // atanh (ieee754.cc)
  wat('math.atanh', `(func $math.atanh (param $x f64) (result f64)
    (local $hx i32) (local $ix i32) (local $t f64)
    (local.set $hx ${hi($('x'))})
    (local.set $ix (i32.and (local.get $hx) (i32.const 0x7fffffff)))
    (if (f64.gt (f64.abs (local.get $x)) (f64.const 1)) (then (return (f64.const nan))))
    (if (f64.ne (local.get $x) (local.get $x)) (then (return (local.get $x))))
    (if (i32.eq (local.get $ix) (i32.const 0x3ff00000)) (then (return (f64.copysign (f64.const inf) (local.get $x)))))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3e300000)) (then (return (local.get $x))))
    (local.set $x (f64.abs (local.get $x)))
    (if (i32.lt_s (local.get $ix) (i32.const 0x3fe00000))
      (then
        (local.set $t (f64.add (local.get $x) (local.get $x)))
        (local.set $t (f64.mul (f64.const 0.5) (call $math.log1p (f64.add (local.get $t)
          (f64.div (f64.mul (local.get $t) (local.get $x)) (f64.sub (f64.const 1) (local.get $x))))))))
      (else
        (local.set $t (f64.mul (f64.const 0.5) (call $math.log1p (f64.div (f64.add (local.get $x) (local.get $x)) (f64.sub (f64.const 1) (local.get $x))))))))
    (select (local.get $t) (f64.neg (local.get $t)) (i32.ge_s (local.get $hx) (i32.const 0))))`)

  // cbrt (ieee754.cc, FreeBSD's s_cbrt.c): a bit-hack seed to 5 bits, a polynomial to 23,
  // rounded away from zero to 23 bits, one Newton step to 53
  wat('math.cbrt', `(func $math.cbrt (param $x f64) (result f64)
    (local $hx i32) (local $sign i32) (local $t f64) (local $r f64) (local $s f64) (local $w f64)
    (local.set $hx ${hi($('x'))})
    (local.set $sign (i32.and (local.get $hx) (i32.const 0x80000000)))
    (local.set $hx (i32.xor (local.get $hx) (local.get $sign)))
    (if (i32.ge_u (local.get $hx) (i32.const 0x7ff00000)) (then (return (local.get $x))))
    (if (i32.lt_u (local.get $hx) (i32.const 0x00100000))
      (then
        (if (f64.eq (local.get $x) (f64.const 0)) (then (return (local.get $x))))
        (local.set $t (f64.mul ${fromHi('(i32.const 0x43500000)')} (local.get $x)))
        (local.set $t ${fromHi(`(i32.or (local.get $sign) (i32.add (i32.div_u (i32.and ${hi($('t'))} (i32.const 0x7fffffff)) (i32.const 3)) (i32.const ${CBRT_B2})))`)}))
      (else (local.set $t ${fromHi(`(i32.or (local.get $sign) (i32.add (i32.div_u (local.get $hx) (i32.const 3)) (i32.const ${CBRT_B1})))`)})))
    (local.set $r (f64.mul (f64.mul (local.get $t) (local.get $t)) (f64.div (local.get $t) (local.get $x))))
    (local.set $t (f64.mul (local.get $t) (f64.add ${poly($('r'), [P0, P1, P2])}
      (f64.mul (f64.mul (f64.mul (local.get $r) (local.get $r)) (local.get $r)) ${poly($('r'), [P3, P4])}))))
    (local.set $t (f64.reinterpret_i64 (i64.and (i64.add (i64.reinterpret_f64 (local.get $t)) (i64.const 0x80000000)) (i64.const 0xffffffffc0000000))))
    (local.set $s (f64.mul (local.get $t) (local.get $t)))
    (local.set $r (f64.div (local.get $x) (local.get $s)))
    (local.set $w (f64.add (local.get $t) (local.get $t)))
    (local.set $r (f64.div (f64.sub (local.get $r) (local.get $t)) (f64.add (local.get $w) (local.get $r))))
    (f64.add (local.get $t) (f64.mul (local.get $t) (local.get $r))))`)

  // Math.hypot of two (V8 builtins/math.tq FastMathHypot, length 2): an infinity wins over a
  // NaN, then sqrt((a/max)² + (b/max)²)·max. More arguments take the Kahan-summed general
  // form (module/math.js), which reproduces this one at two.
  wat('math.hypot', `(func $math.hypot (param $a f64) (param $b f64) (result f64)
    (local $max f64)
    (local.set $a (f64.abs (local.get $a)))
    (local.set $b (f64.abs (local.get $b)))
    (if (i32.or (f64.eq (local.get $a) (f64.const inf)) (f64.eq (local.get $b) (f64.const inf))) (then (return (f64.const inf))))
    (local.set $max (f64.max (local.get $a) (local.get $b)))
    (if (f64.ne (local.get $max) (local.get $max)) (then (return (f64.const nan))))
    (if (f64.eq (local.get $max) (f64.const 0)) (then (return (f64.const 0))))
    (local.set $a (f64.div (local.get $a) (local.get $max)))
    (local.set $b (f64.div (local.get $b) (local.get $max)))
    (f64.mul (f64.sqrt (f64.add (f64.mul (local.get $a) (local.get $a)) (f64.mul (local.get $b) (local.get $b)))) (local.get $max)))`)
}
