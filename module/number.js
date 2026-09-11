/**
 * Number module — toString, toFixed, toPrecision, toExponential, String().
 *
 * Core: __ftoa(f64, precision, mode) → f64 (NaN-boxed string pointer).
 * Modes: 0=default (shortest repr), 1=fixed (toFixed).
 * Uses integer-based digit extraction to avoid float drift.
 * Static string table at address 0 for NaN, Infinity, etc.
 *
 * @module number
 */

import { typed, asF64, asI32, asI64, toI32, toNumF64, NULL_NAN, UNDEF_NAN, FALSE_NAN, TRUE_NAN, temp, tempI32, tempI64, ptrTypeEq, truthyIR, readI64, isPlanRawBigint } from '../src/ir.js'
import { ssoBitI64Hex, ptrNanHex, nanPrefixHex } from '../layout.js'
import { emit, bool, deps, reg } from '../src/bridge.js'
import { isReassigned } from '../src/ast.js'
import { dataPush, dataAlign, dataLen, hexBytes } from '../src/static-data.js'
import { stringBytes } from '../src/string-data.js'
import { valTypeOf, censusMaybeUndefined } from '../src/kind.js'
import { VAL } from '../src/reps.js'
import { inc, PTR, LAYOUT, declGlobal, err } from '../src/ctx.js'
import { ERR } from '../err-codes.js'

// ─── Shared decimal-number parsing fragments ────────────────────────────────
// Number, parseFloat and JSON.parse share decimal accumulation and rounding.
// Each caller supplies its grammar checks and input position.
// Required locals (every consumer declares them):
//   $v i64 · $i $len $c $dot $seen $sigDigits $decExp $dropped $round
//   $exp $expNeg $expDigits $sbase i32 · $mant i64 · $result f64

// In-bounds byte read for a confirmed string `$v`. `__char_at` is ~95 WASM
// instructions — too large for V8 to inline — so a scan that calls it per
// char pays a real call plus a redundant SSO/view/bounds dispatch every step.
// A non-SSO string (the common case: source slices, heap strings) keeps its
// bytes contiguous at `$v & 0xFFFFFFFF` (`$sbase`); the read collapses to one
// `i32.load16_u`. The SSO test is loop-invariant — V8 hoists it — and the SSO
// arm still routes through `__char_at` (its bytes are packed in the pointer).
// Callers MUST declare `$sbase i32`, set it once after `$v` is final and a
// confirmed string, and only pass indices proven `< $len` (`__char_at` would
// otherwise return its OOB 0; the inline load has no such guard).
const SSO_BIT_I64 = ssoBitI64Hex()
// Canonical NaN-box bit pattern (sign=0, tag=ATOM(0), aux=0) — same constant module/core.js's
// $__typeof uses to recognize a genuine number-NaN vs a NaN-boxed pointer/atom.
const NAN_BITS = nanPrefixHex()
const SBASE_INIT = '(local.set $sbase (i32.wrap_i64 (i64.and (local.get $v) (i64.const 4294967295))))'

/** In-place byte reversal of buf[i..j] (WAT fragment). __itoa/__radix_str emit the
 *  least-significant digit first, then flip the run. Caller pre-sets `j` to the last
 *  index and leaves `i` at 0; `tmp` is scratch. Labels $rev/$revl are block-local. */
const reverseBytesWat = (buf = '$buf', i = '$i', j = '$j', tmp = '$tmp') =>
  `(block $rev (loop $revl
      (br_if $rev (i32.ge_s (local.get ${i}) (local.get ${j})))
      (local.set ${tmp} (i32.load16_u (i32.add (local.get ${buf}) (i32.shl (local.get ${i}) (i32.const 1)))))
      (i32.store16 (i32.add (local.get ${buf}) (i32.shl (local.get ${i}) (i32.const 1))) (i32.load16_u (i32.add (local.get ${buf}) (i32.shl (local.get ${j}) (i32.const 1)))))
      (i32.store16 (i32.add (local.get ${buf}) (i32.shl (local.get ${j}) (i32.const 1))) (local.get ${tmp}))
      (local.set ${i} (i32.add (local.get ${i}) (i32.const 1)))
      (local.set ${j} (i32.sub (local.get ${j}) (i32.const 1)))
      (br $revl)))`
const chAt = idx => `(if (result i32)
        (i64.eqz (i64.and (local.get $v) (i64.const ${SSO_BIT_I64})))
        (then (i32.load16_u (i32.add (local.get $sbase) (i32.shl ${idx} (i32.const 1)))))
        (else (call $__char_at (local.get $v) ${idx})))`

// chAt for reads NOT dominated by a `$i < $len` guard. `i32.and` does not
// short-circuit, so `(i32.and (lt_s $i $len) (… chAt …))` would still run the
// unguarded inline load when `$i == $len`. chAtSafe restores `__char_at`'s
// total contract (0 out of bounds), so such a site drops the now-redundant
// outer guard and compares chAtSafe directly against the wanted byte.
const chAtSafe = idx => `(if (result i32)
        (i32.lt_s ${idx} (local.get $len))
        (then ${chAt(idx)})
        (else (i32.const 0)))`

// 18-significant-digit significand → $mant; $decExp tracks the base-10 exponent
// of dropped/fractional digits; $round defers a single round-up.
export const DEC_SIGNIFICAND = `
    (block $numDone (loop $numLoop
      (br_if $numDone (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $c ${chAt('(local.get $i)')})
      (if (i32.and (i32.eq (local.get $c) (i32.const 46)) (i32.eqz (local.get $dot)))
        (then
          (local.set $dot (i32.const 1))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $numLoop)))
      (br_if $numDone
        (i32.or
          (i32.lt_s (local.get $c) (i32.const 48))
          (i32.gt_s (local.get $c) (i32.const 57))))
      (local.set $seen (i32.const 1))
      (local.set $c (i32.sub (local.get $c) (i32.const 48)))
      (if (i32.and (i32.eqz (local.get $sigDigits)) (i32.eqz (local.get $c)))
        (then
          (if (local.get $dot) (then (local.set $decExp (i32.sub (local.get $decExp) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $numLoop)))
      ;; Accumulate the significand in an i64, UNSIGNED-exact to 19 decimal
      ;; digits (2^64-1 ≈ 1.8e19): the first 18 always fit; the 19th joins only
      ;; when mant*10+9 cannot overflow (mant ≤ (2^64-1-9)/10). Rounding by
      ;; increment only ever applies from the 20th digit on — pre-rounding the
      ;; 19th double-rounded 19-digit literals (parseFloat('1152921504606847359')
      ;; came out 2 ulp off; the EL consumer is unsigned throughout).
      (if (i32.or
            (i32.lt_s (local.get $sigDigits) (i32.const 18))
            (i32.and (i32.eq (local.get $sigDigits) (i32.const 18))
                     (i64.le_u (local.get $mant) (i64.const 1844674407370955160))))
        (then
          (local.set $mant
            (i64.add
              (i64.mul (local.get $mant) (i64.const 10))
              (i64.extend_i32_s (local.get $c))))
          (local.set $sigDigits (i32.add (local.get $sigDigits) (i32.const 1)))
          (if (local.get $dot) (then (local.set $decExp (i32.sub (local.get $decExp) (i32.const 1))))))
        (else
          (if (i32.eqz (local.get $dropped))
            (then (if (i32.ge_s (local.get $c) (i32.const 5)) (then (local.set $round (i32.const 1))))))
          (local.set $dropped (i32.const 1))
          (if (i32.eqz (local.get $dot)) (then (local.set $decExp (i32.add (local.get $decExp) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $numLoop)))`

// No significant digit seen → NaN; apply the deferred round; $mant → $result.
const FINISH_SIGNIFICAND = `
    (if (i32.eqz (local.get $seen)) (then (return (f64.const nan))))
    (if (local.get $round) (then (local.set $mant (i64.add (local.get $mant) (i64.const 1)))))
    (local.set $result (f64.convert_i64_u (local.get $mant)))`

// ExponentPart scan: 'e'/'E' + optional sign + digits → $exp / $expDigits.
// `tail` runs inside the e/E branch — Number rejects an empty exponent ("1e")
// as NaN, parseFloat ignores it, so each caller passes its own resolution.
export const sciExponent = (tail) => `
    (local.set $c ${chAtSafe('(local.get $i)')})
    (if (i32.or
        (i32.eq (local.get $c) (i32.const 101))
        (i32.eq (local.get $c) (i32.const 69)))
      (then
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (if (i32.eq ${chAtSafe('(local.get $i)')} (i32.const 45))
          (then (local.set $expNeg (i32.const 1)) (local.set $i (i32.add (local.get $i) (i32.const 1))))
          (else (if (i32.eq ${chAtSafe('(local.get $i)')} (i32.const 43))
            (then (local.set $i (i32.add (local.get $i) (i32.const 1)))))))
        (block $expDone (loop $expLoop
          (br_if $expDone (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $c ${chAt('(local.get $i)')})
          (br_if $expDone
            (i32.or
              (i32.lt_s (local.get $c) (i32.const 48))
              (i32.gt_s (local.get $c) (i32.const 57))))
          ;; Saturate while still consuming digits: an enormous exponent must not wrap.
          (if (i32.or (i32.gt_u (local.get $exp) (i32.const 214748364))
                (i32.and (i32.eq (local.get $exp) (i32.const 214748364)) (i32.gt_u (local.get $c) (i32.const 55))))
            (then (local.set $exp (i32.const 2147483647)))
            (else (local.set $exp (i32.add (i32.mul (local.get $exp) (i32.const 10))
              (i32.sub (local.get $c) (i32.const 48))))))
          (local.set $expDigits (i32.add (local.get $expDigits) (i32.const 1)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $expLoop)))
        ;; More than input length + 400 cannot cancel the significand's scale.
        ;; Bound before adding/subtracting decExp so saturated exponents stay signed.
        (if (i32.gt_u (local.get $exp) (i32.add (local.get $len) (i32.const 400)))
          (then (local.set $exp (i32.add (local.get $len) (i32.const 400)))))
        ${tail}))`

// Apply the accumulated base-10 exponent to $result via __pow10.
// Used as fallback when EL cannot determine a unique rounding.
// Deep exponents split in two steps so the intermediate stays finite/normal:
// 10^324 overflows f64 (__pow10 → Infinity) and x/Infinity flushed every
// |exp10| > 308 literal to 0 — including min-normal 2.2250738585072014e-308
// (17 mantissa digits → decExp −324) and the 5e-324 min subnormal. Dividing
// by 10^(|e|−308) FIRST keeps the intermediate normal; the final /10^308
// rounds once into the (sub)normal target. Symmetric split on overflow-side
// exponents (mant digits can drag decExp past +308 while the value is finite).
const POW10_SCALE = `
    (if (i32.gt_s (local.get $decExp) (i32.const 0))
      (then
        (if (i32.gt_s (local.get $decExp) (i32.const 308))
          (then
            (local.set $result (f64.mul (local.get $result) (call $__pow10 (i32.sub (local.get $decExp) (i32.const 308)))))
            (local.set $result (f64.mul (local.get $result) (call $__pow10 (i32.const 308)))))
          (else (local.set $result (f64.mul (local.get $result) (call $__pow10 (local.get $decExp))))))))
    (if (i32.lt_s (local.get $decExp) (i32.const 0))
      (then
        (if (i32.lt_s (local.get $decExp) (i32.const -308))
          (then
            (local.set $result (f64.div (local.get $result) (call $__pow10 (i32.sub (i32.const -308) (local.get $decExp)))))
            (local.set $result (f64.div (local.get $result) (call $__pow10 (i32.const 308)))))
          (else (local.set $result (f64.div (local.get $result) (call $__pow10 (i32.sub (i32.const 0) (local.get $decExp)))))))))`

// Eisel-Lemire correctly-rounded decimal-to-f64.
// Used in place of FINISH_SIGNIFICAND + POW10_SCALE. Keeps $mant as i64 until after
// sciExponent finalizes $decExp, then calls $__dec_to_f64 with both.
// Falls back to f64.convert_i64_u + POW10_SCALE when EL returns NaN (ambiguous).
// The caller handles sign INSIDE this fragment (so the final return is the signed result).
export const EL_SCALE = `
    (if (i32.eqz (local.get $seen)) (then (return (f64.const nan))))
    (if (local.get $round) (then (local.set $mant (i64.add (local.get $mant) (i64.const 1)))))
    (local.set $result (call $__dec_to_f64 (local.get $mant) (local.get $decExp)))
    (if (f64.ne (local.get $result) (local.get $result))
      (then
        (local.set $result (f64.convert_i64_u (local.get $mant)))
        ${POW10_SCALE}))
    (if (local.get $neg) (then (local.set $result (f64.neg (local.get $result)))))`

// $__dec_to_f64: Eisel-Lemire correctly-rounded f64 from (mant × 10^exp10).
// Returns NaN (as sentinel) for ambiguous cases — caller falls back to POW10_SCALE.
// Shares the formatter's power-of-five generator. Three correction bits per exponent
// restore the full 128-bit normalized power of ten (exp10 = -342..308).
//
// Algorithm: normalize mant to 64 bits, multiply by 128-bit table entry to get 128-bit
// product (prodHi:prodLo), extract 52-bit IEEE mantissa with correct rounding.
// Handles subnormals, overflow to Infinity, and early-exit for 0/trivial ranges.
const DEC_TO_F64_WAT = `(func $__dec_to_f64
    (param $mant i64) (param $exp10 i32)
    (result f64)
    (local $mBits i32) (local $scale f64)
    (local $w i64)
    (local $tbl i32) (local $inv i32)
    (local $tblHi i64) (local $tblLo i64)
    ;; 128-bit product: prodHi × 2^64 + prodLo
    (local $p2lo i64)
    (local $prodHi i64) (local $prodLo i64)
    (local $carry i64)
    (local $lz i32)
    (local $log2floor i32)
    (local $exp2 i32) (local $biased i32)
    (local $roundShift i32)
    (local $roundBit i64)
    (local $sticky i64)
    (local $mant52 i64)
    (local $subnShift i32) (local $totalShift i32)
    (local $snRound i64) (local $snSticky i64) (local $snMant i64)
    ;; An integral significand needs only the correctly rounded Wasm conversion.
    (if (i32.eqz (local.get $exp10)) (then (return (f64.convert_i64_u (local.get $mant)))))
    ;; Zero check
    (if (i64.eqz (local.get $mant)) (then (return (f64.const 0))))
    ;; For exact f64 operands, one multiply/divide gives the correctly rounded
    ;; decimal directly. 10^0..10^22 and every integer through 2^53 are exact.
    (if (i32.and (i64.le_u (local.get $mant) (i64.const 9007199254740992))
          (i32.le_u (i32.add (local.get $exp10) (i32.const 22)) (i32.const 44)))
      (then
        (local.set $inv (i32.lt_s (local.get $exp10) (i32.const 0)))
        (local.set $scale (call $__pow10
          (select (i32.sub (i32.const 0) (local.get $exp10)) (local.get $exp10) (local.get $inv))))
        (if (local.get $inv)
          (then (return (f64.div (f64.convert_i64_u (local.get $mant)) (local.get $scale)))))
        (return (f64.mul (f64.convert_i64_u (local.get $mant)) (local.get $scale)))))
    ;; Compute bit length of mant (1..64) by normalizing to 64 bits via clz
    ;; mBits = 64 - clz64(mant)
    (local.set $mBits (i32.sub (i32.const 64) (i32.wrap_i64 (i64.clz (local.get $mant)))))
    ;; Normalize mant to 64-bit: w = mant << (64 - mBits)
    (local.set $w (i64.shl (local.get $mant) (i64.extend_i32_u (i32.sub (i32.const 64) (local.get $mBits)))))
    ;; Keep every finite/subnormal decimal exponent; out-of-range falls back.
    (if (i32.or (i32.lt_s (local.get $exp10) (i32.const -342))
                (i32.gt_s (local.get $exp10) (i32.const 308)))
      (then (return (f64.const nan))))
    (local.set $inv (i32.lt_s (local.get $exp10) (i32.const 0)))
    (call $__ryu_pow5
      (select (i32.sub (i32.const 0) (local.get $exp10)) (local.get $exp10) (local.get $inv))
      (local.get $inv))
    (local.set $tblHi)
    (local.set $tblLo)
    ;; Ryū's normalized entry has 125 significant bits here. Restore the low
    ;; three bits: floor(8*entry)+correction, or 8*ceil(entry)-correction-1.
    (local.set $tblHi (i64.or (i64.shl (local.get $tblHi) (i64.const 3))
      (i64.shr_u (local.get $tblLo) (i64.const 61))))
    (local.set $tblLo (i64.shl (local.get $tblLo) (i64.const 3)))
    (local.set $tbl (i32.mul (i32.add (local.get $exp10) (i32.const 342)) (i32.const 3)))
    (local.set $carry (i64.extend_i32_u (i32.and
      (i32.shr_u (i32.load16_u (i32.add (global.get $__el_tbl) (i32.shr_u (local.get $tbl) (i32.const 3))))
        (i32.and (local.get $tbl) (i32.const 7))) (i32.const 7))))
    (if (local.get $inv)
      (then
        (local.set $carry (i64.add (local.get $carry) (i64.const 1)))
        (local.set $tblHi (i64.sub (local.get $tblHi) (i64.extend_i32_u (i64.lt_u (local.get $tblLo) (local.get $carry)))))
        (local.set $tblLo (i64.sub (local.get $tblLo) (local.get $carry))))
      (else
        (local.set $tblLo (i64.add (local.get $tblLo) (local.get $carry)))
        (local.set $tblHi (i64.add (local.get $tblHi) (i64.extend_i32_u (i64.lt_u (local.get $tblLo) (local.get $carry)))))))
    ;; Full unsigned product: retain its low limb for exact rounding ties.
    (call $__umul128 (local.get $w) (local.get $tblLo) (local.get $tblHi))
    (local.set $prodHi)
    (local.set $prodLo)
    (local.set $p2lo)
    ;; ─── Determine lz (leading-zero flag): 1 if MSB of prodHi is 0 ──────────────
    (local.set $lz (i32.wrap_i64 (i64.xor (i64.shr_u (local.get $prodHi) (i64.const 63)) (i64.const 1))))
    ;; ─── Compute biased exponent ─────────────────────────────────────────────────
    ;; floor(exp10 * log2(10)), exact on [-342..308] with a signed i32 product.
    (local.set $log2floor (i32.shr_s
      (i32.mul (local.get $exp10) (i32.const 217706)) (i32.const 16)))
    ;; exp2 = mBits + floor(exp10 * log2(10)) - lz
    (local.set $exp2 (i32.sub (i32.add (local.get $mBits) (local.get $log2floor)) (local.get $lz)))
    (local.set $biased (i32.add (local.get $exp2) (i32.const 1023)))
    ;; Overflow → Infinity
    (if (i32.ge_s (local.get $biased) (i32.const 2047)) (then (return (f64.const inf))))
    ;; ─── Subnormal path (biased ≤ 0) ────────────────────────────────────────────
    (if (i32.le_s (local.get $biased) (i32.const 0))
      (then
        ;; total_shift = 11 - lz + (1 - biased) = 12 - lz - biased
        (local.set $totalShift (i32.sub (i32.sub (i32.const 12) (local.get $lz)) (local.get $biased)))
        ;; If totalShift >= 64: prodHi >> totalShift == 0 in BigInt, but here:
        ;; For totalShift in [64..127]: snMant = (prodHi >> (totalShift-64)) >> 64... = 0
        ;; We just use BigInt-style: clamp to 0 if >=64 (prodHi is 64-bit)
        (if (i32.ge_u (local.get $totalShift) (i32.const 64))
          (then
            ;; All mantissa bits are 0; only rounding could give min subnormal.
            ;; round bit: at position (totalShift-1) of prodHi → always 0 for totalShift>=65
            ;; For totalShift==64: round bit = bit 63 of prodHi = MSB
            (if (i32.eq (local.get $totalShift) (i32.const 64))
              (then
                (local.set $snRound (i64.shr_u (local.get $prodHi) (i64.const 63)))
                (local.set $snSticky (i64.or (local.get $prodLo) (local.get $p2lo)))
                ;; Return min-subnormal if snRound=1 AND snSticky!=0 (boolean AND, not bitwise)
                (if (i32.and
                  (i32.wrap_i64 (local.get $snRound))
                  (i64.ne (local.get $snSticky) (i64.const 0)))
                  (then (return (f64.reinterpret_i64 (i64.const 1)))))
              ))
            (return (f64.const 0))))
        ;; totalShift in [1..63]: extract directly from prodHi
        (local.set $snMant (i64.and
          (i64.shr_u (local.get $prodHi) (i64.extend_i32_u (local.get $totalShift)))
          (i64.const 0x000FFFFFFFFFFFFF)))
        (local.set $snRound
          (i64.and (i64.shr_u (local.get $prodHi)
            (i64.extend_i32_u (i32.sub (local.get $totalShift) (i32.const 1))))
            (i64.const 1)))
        (local.set $snSticky (i64.or
          (i64.and (local.get $prodHi)
            (i64.sub (i64.shl (i64.const 1) (i64.extend_i32_u (i32.sub (local.get $totalShift) (i32.const 1))))
                     (i64.const 1)))
          (i64.or (local.get $prodLo) (local.get $p2lo))))
        ;; Round: snMant++ if roundBit && (sticky > 0 || snMant is odd)
        (if (i64.ne (i64.and (local.get $snRound)
              (i64.or (i64.extend_i32_u (i64.ne (local.get $snSticky) (i64.const 0)))
                      (i64.and (local.get $snMant) (i64.const 1))))
             (i64.const 0))
          (then (local.set $snMant (i64.add (local.get $snMant) (i64.const 1)))))
        ;; Overflow of subnormal mantissa → minimum normal (biased=1, mant=0)
        (if (i64.ge_u (local.get $snMant) (i64.const 0x0010000000000000))
          (then (return (f64.reinterpret_i64 (i64.const 0x0010000000000000)))))
        (return (f64.reinterpret_i64 (local.get $snMant)))))
    ;; ─── Normal path ─────────────────────────────────────────────────────────────
    ;; roundShift = 10 - lz  (bit position of round bit in prodHi)
    (local.set $roundShift (i32.sub (i32.const 10) (local.get $lz)))
    (local.set $roundBit (i64.and
      (i64.shr_u (local.get $prodHi) (i64.extend_i32_u (local.get $roundShift)))
      (i64.const 1)))
    ;; sticky = bits below roundBit in prodHi, plus all of prodLo and p2lo
    (local.set $sticky (i64.or
      (i64.and (local.get $prodHi)
        (i64.sub (i64.shl (i64.const 1) (i64.extend_i32_u (local.get $roundShift)))
                 (i64.const 1)))
      (i64.or (local.get $prodLo) (local.get $p2lo))))
    ;; mant52 = (prodHi >> (11 - lz)) & MASK52
    (local.set $mant52 (i64.and
      (i64.shr_u (local.get $prodHi) (i64.extend_i32_u (i32.sub (i32.const 11) (local.get $lz))))
      (i64.const 0x000FFFFFFFFFFFFF)))
    ;; Round: mant52++ if roundBit && (sticky > 0 || mant52 is odd)
    (if (i64.ne (i64.and (local.get $roundBit)
          (i64.or (i64.extend_i32_u (i64.ne (local.get $sticky) (i64.const 0)))
                  (i64.and (local.get $mant52) (i64.const 1))))
         (i64.const 0))
      (then (local.set $mant52 (i64.add (local.get $mant52) (i64.const 1)))))
    ;; Mantissa overflow: carry into exponent
    (if (i64.ge_u (local.get $mant52) (i64.const 0x0010000000000000))
      (then
        (local.set $mant52 (i64.const 0))
        (local.set $biased (i32.add (local.get $biased) (i32.const 1)))))
    ;; Final overflow check after rounding
    (if (i32.ge_s (local.get $biased) (i32.const 2047)) (then (return (f64.const inf))))
    ;; Assemble IEEE 754 bits: biased_exp << 52 | mant52
    (f64.reinterpret_i64
      (i64.or
        (i64.shl (i64.extend_i32_u (local.get $biased)) (i64.const 52))
        (local.get $mant52))))`

export default (ctx) => {
  deps({
    __mkstr: ['__alloc'],
    // own edge: __static_str's body calls $__mkstr — without it the helper
    // rides the self-compile-unreliable auto-scan (test/self-compile-includes.js)
    __static_str: ['__mkstr'],
    __ftoa: ['__itoa', '__pow10', '__mkstr', '__static_str', '__ftoa_shortest'],
    __ftoa_shortest: ['__mkstr', '__static_str', '__alloc', '__itoa', '__ryu_mulshift', '__ryu_pow5', '__ryu_pow5div'],
    __ryu_pow5: ['__umul128'],
    __dec_to_f64: ['__ryu_pow5', '__umul128', '__pow10'],
    __ryu_mulshift: ['__umul128'],
    __ryu_mulhi: [],
    __umul128: ['__ryu_mulhi'],
    __ryu_pow5div: [],
    __i32_to_str: ['__itoa_s', '__mkstr'],
    __itoa_s: ['__itoa'],
    __ilen: [],
    __toExp: ['__itoa', '__pow10', '__mkstr', '__static_str'],
    __radix_str: ['__mkstr'],
    __num_radix: ['__ftoa', '__mkstr'],
    __to_num: ['__char_at', '__str_length', '__pow10', '__dec_to_f64', '__to_str', '__skipws', '__ptr_aux'],
    __skipws: ['__char_at', '__strws'],
    __str_to_bigint: ['__char_at', '__str_length'],
    __to_bigint: ['__str_to_bigint', '__num_to_bigint', '__ptr_type', '__ptr_offset'],
    __bigint_eq_num: [],
    __bigint_eq_str: ['__str_to_bigint'],
    __bigint_eq: ['__bigint_eq_num', '__bigint_eq_str', '__ptr_type', '__ptr_offset'],
    __parseInt: ['__char_at', '__str_length', '__skipws', '__to_str'],
    __parseFloat: ['__char_at', '__str_length', '__pow10', '__dec_to_f64', '__to_str', '__skipws'],
  })


  // __pow10(n: i32) → f64 — compute 10^n via binary decomposition.
  // Naive iterative `r *= 10` accumulates O(n) ULPs of rounding drift —
  // 1e308 came out 1 ULP low, breaking parseFloat round-trip at the f64 edge.
  // Bit-decomposition multiplies at most 9 precomputed powers (10^1 .. 10^256),
  // so accumulated error stays at O(log n) ULPs.
  ctx.core.stdlib['__pow10'] = `(func $__pow10 (param $n i32) (result f64)
    (local $r f64)
    ;; 10^309 already overflows f64 (max ~1.8e308); short-circuit so callers
    ;; get Infinity rather than the truncated product of a 9-bit decomposition.
    (if (i32.ge_s (local.get $n) (i32.const 309)) (then (return (f64.const inf))))
    (local.set $r (f64.const 1))
    (if (i32.and (local.get $n) (i32.const 1))
      (then (local.set $r (f64.mul (local.get $r) (f64.const 10)))))
    (if (i32.and (local.get $n) (i32.const 2))
      (then (local.set $r (f64.mul (local.get $r) (f64.const 100)))))
    (if (i32.and (local.get $n) (i32.const 4))
      (then (local.set $r (f64.mul (local.get $r) (f64.const 10000)))))
    (if (i32.and (local.get $n) (i32.const 8))
      (then (local.set $r (f64.mul (local.get $r) (f64.const 1e8)))))
    (if (i32.and (local.get $n) (i32.const 16))
      (then (local.set $r (f64.mul (local.get $r) (f64.const 1e16)))))
    (if (i32.and (local.get $n) (i32.const 32))
      (then (local.set $r (f64.mul (local.get $r) (f64.const 1e32)))))
    (if (i32.and (local.get $n) (i32.const 64))
      (then (local.set $r (f64.mul (local.get $r) (f64.const 1e64)))))
    (if (i32.and (local.get $n) (i32.const 128))
      (then (local.set $r (f64.mul (local.get $r) (f64.const 1e128)))))
    (if (i32.and (local.get $n) (i32.const 256))
      (then (local.set $r (f64.mul (local.get $r) (f64.const 1e256)))))
    (local.get $r))`

  // __itoa(val: i32, buf: i32) → i32 (digit count). Writes decimal digits to buf.
  ctx.core.stdlib['__itoa'] = `(func $__itoa (param $val i32) (param $buf i32) (result i32)
    (local $len i32) (local $i i32) (local $j i32) (local $tmp i32)
    (if (i32.eqz (local.get $val))
      (then (i32.store16 (local.get $buf) (i32.const 48)) (return (i32.const 1))))
    (local.set $tmp (local.get $val))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $tmp)))
      (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $len) (i32.const 1))) (i32.add (i32.const 48) (i32.rem_u (local.get $tmp) (i32.const 10))))
      (local.set $tmp (i32.div_u (local.get $tmp) (i32.const 10)))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $l)))
    ;; Reverse
    (local.set $j (i32.sub (local.get $len) (i32.const 1)))
    ${reverseBytesWat()}
    (local.get $len))`

  // __ilen(val: i32) → i32 — exact byte length of ToString(val): sign + decimal
  // digits over the unsigned magnitude (INT_MIN negates to itself; read unsigned the
  // ladder still lands on 10). Must agree with __itoa_s byte-for-byte: the fused
  // concat emitters alloc from __ilen totals and render with __itoa_s at the cursor —
  // a one-byte disagreement is heap corruption (pinned differentially in test/strings.js).
  ctx.core.stdlib['__ilen'] = `(func $__ilen (param $val i32) (result i32)
    (local $u i32) (local $n i32)
    (local.set $u (local.get $val))
    (if (i32.lt_s (local.get $val) (i32.const 0))
      (then
        (local.set $u (i32.sub (i32.const 0) (local.get $val)))
        (local.set $n (i32.const 1))))
    (if (i32.lt_u (local.get $u) (i32.const 10)) (then (return (i32.add (local.get $n) (i32.const 1)))))
    (if (i32.lt_u (local.get $u) (i32.const 100)) (then (return (i32.add (local.get $n) (i32.const 2)))))
    (if (i32.lt_u (local.get $u) (i32.const 1000)) (then (return (i32.add (local.get $n) (i32.const 3)))))
    (if (i32.lt_u (local.get $u) (i32.const 10000)) (then (return (i32.add (local.get $n) (i32.const 4)))))
    (if (i32.lt_u (local.get $u) (i32.const 100000)) (then (return (i32.add (local.get $n) (i32.const 5)))))
    (if (i32.lt_u (local.get $u) (i32.const 1000000)) (then (return (i32.add (local.get $n) (i32.const 6)))))
    (if (i32.lt_u (local.get $u) (i32.const 10000000)) (then (return (i32.add (local.get $n) (i32.const 7)))))
    (if (i32.lt_u (local.get $u) (i32.const 100000000)) (then (return (i32.add (local.get $n) (i32.const 8)))))
    (if (i32.lt_u (local.get $u) (i32.const 1000000000)) (then (return (i32.add (local.get $n) (i32.const 9)))))
    (i32.add (local.get $n) (i32.const 10)))`

  // __itoa_s(val: i32, buf: i32) → i32 (bytes written) — signed decimal render at
  // buf: '-' + digits over the unsigned magnitude. The render core shared by
  // __i32_to_str (temp-string ToString) and the fused concat emitters (render
  // directly at the destination cursor — no temp string, no copy).
  ctx.core.stdlib['__itoa_s'] = `(func $__itoa_s (param $val i32) (param $buf i32) (result i32)
    (if (i32.lt_s (local.get $val) (i32.const 0))
      (then
        (i32.store16 (local.get $buf) (i32.const 45))   ;; '-'
        ;; magnitude as unsigned: negate via 0 - val (INT_MIN maps to itself, __itoa reads unsigned)
        (return (i32.add
          (call $__itoa (i32.sub (i32.const 0) (local.get $val)) (i32.add (local.get $buf) (i32.const 2)))
          (i32.const 1)))))
    (call $__itoa (local.get $val) (local.get $buf)))`

  // __i32_to_str(val: i32) → f64 (NaN-boxed string) — ToString for a value the
  // compiler proved is a signed i32. The whole point is to bypass __ftoa's float
  // machinery (shortest-repr search, __toExp, __pow10): a known integer renders with
  // just __itoa_s over a scratch buffer. Lets `"id " + (n|0)` and integer
  // templates skip the ~2 KB float formatter the generic ToString hard-pulls.
  ctx.core.stdlib['__i32_to_str'] = `(func $__i32_to_str (param $val i32) (result f64)
    (local $buf i32)
    (local.set $buf (call $__alloc (i32.const 24)))
    (call $__mkstr (local.get $buf) (call $__itoa_s (local.get $val) (local.get $buf))))`

  // __radix_str(val: i64, radix: i32) → f64 (NaN-boxed string)
  // Signed integer → radix string for BigInt.prototype.toString(radix). Digits go
  // 0-9 then a-z (lowercase, per spec); magnitude is taken unsigned so i64.MIN
  // (whose two's-complement negation is itself) formats correctly via div_u/rem_u.
  ctx.core.stdlib['__radix_str'] = `(func $__radix_str (param $val i64) (param $radix i32) (result f64)
    (local $buf i32) (local $pos i32) (local $neg i32) (local $mag i64) (local $r i64)
    (local $dg i32) (local $i i32) (local $j i32) (local $tmp i32)
    (local.set $buf (call $__alloc (i32.const 144)))
    (local.set $r (i64.extend_i32_s (local.get $radix)))
    (if (i64.eqz (local.get $val))
      (then (i32.store16 (local.get $buf) (i32.const 48)) (return (call $__mkstr (local.get $buf) (i32.const 1)))))
    (local.set $mag (local.get $val))
    (if (i64.lt_s (local.get $val) (i64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $mag (i64.sub (i64.const 0) (local.get $val)))))
    (block $mb (loop $ml
      (br_if $mb (i64.eqz (local.get $mag)))
      (local.set $dg (i32.wrap_i64 (i64.rem_u (local.get $mag) (local.get $r))))
      (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (select (i32.add (local.get $dg) (i32.const 48)) (i32.add (local.get $dg) (i32.const 87)) (i32.lt_s (local.get $dg) (i32.const 10))))
      (local.set $mag (i64.div_u (local.get $mag) (local.get $r)))
      (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
      (br $ml)))
    (if (local.get $neg)
      (then (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 45))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
    (local.set $j (i32.sub (local.get $pos) (i32.const 1)))
    ${reverseBytesWat()}
    (call $__mkstr (local.get $buf) (local.get $pos)))`

  // __num_radix(val: f64, radix: i32) → f64 (NaN-boxed string)
  // Number.prototype.toString(radix) for radix != 10. Non-finite values defer to
  // __ftoa ("NaN"/"Infinity"/"-Infinity"). Integer part uses exact i64 division
  // (magnitude bounded by jz's i64 BigInt domain); the fraction multiplies out in
  // f64, capped at 100 digits (radix fractions are implementation-defined precision).
  //
  // Per 21.1.3.6: radix must be an integer in [2, 36] — otherwise RangeError.
  // The check sits at the canonical entry point so the const-radix fold path
  // (which still calls here for any non-10 constant) and the dynamic-radix
  // branch are validated uniformly. `(throw $__jz_err …)` is picked up by
  // ensureThrowRuntime via stdlib scan, so callers do not need to flag throws.
  ctx.core.stdlib['__num_radix'] = `(func $__num_radix (param $val f64) (param $radix i32) (result f64)
    (local $buf i32) (local $pos i32) (local $neg i32) (local $iv i64) (local $r i64) (local $rf f64)
    (local $int f64) (local $frac f64) (local $dg i32) (local $i i32) (local $j i32) (local $tmp i32) (local $fn i32) (local $rv f64)
    (if (i32.or (i32.lt_s (local.get $radix) (i32.const 2)) (i32.gt_s (local.get $radix) (i32.const 36)))
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.NUMBER_RADIX}))) (throw $__jz_err (f64.const ${ERR.NUMBER_RADIX}))))
    (if (i32.or (f64.ne (local.get $val) (local.get $val)) (f64.eq (f64.abs (local.get $val)) (f64.const inf)))
      (then (return (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0)))))
    (local.set $buf (call $__alloc (i32.const 360)))
    (local.set $r (i64.extend_i32_s (local.get $radix)))
    (local.set $rf (f64.convert_i32_s (local.get $radix)))
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $val (f64.neg (local.get $val)))))
    (local.set $int (f64.floor (local.get $val)))
    (local.set $frac (f64.sub (local.get $val) (local.get $int)))
    (local.set $iv (i64.trunc_sat_f64_u (local.get $int)))
    (if (i64.eqz (local.get $iv))
      (then (i32.store16 (local.get $buf) (i32.const 48)) (local.set $pos (i32.const 1)))
      (else
        (block $ib (loop $il
          (br_if $ib (i64.eqz (local.get $iv)))
          (local.set $dg (i32.wrap_i64 (i64.rem_u (local.get $iv) (local.get $r))))
          (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (select (i32.add (local.get $dg) (i32.const 48)) (i32.add (local.get $dg) (i32.const 87)) (i32.lt_s (local.get $dg) (i32.const 10))))
          (local.set $iv (i64.div_u (local.get $iv) (local.get $r)))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (br $il)))))
    (if (local.get $neg)
      (then (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 45))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
    (local.set $j (i32.sub (local.get $pos) (i32.const 1)))
    (block $rb (loop $rl
      (br_if $rb (i32.ge_s (local.get $i) (local.get $j)))
      (local.set $tmp (i32.load16_u (i32.add (local.get $buf) (i32.shl (local.get $i) (i32.const 1)))))
      (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $i) (i32.const 1))) (i32.load16_u (i32.add (local.get $buf) (i32.shl (local.get $j) (i32.const 1)))))
      (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $j) (i32.const 1))) (local.get $tmp))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $j (i32.sub (local.get $j) (i32.const 1)))
      (br $rl)))
    (if (f64.gt (local.get $frac) (f64.const 0))
      (then
        (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 46))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (block $fb (loop $fl
          (br_if $fb (f64.le (local.get $frac) (f64.const 0)))
          (br_if $fb (i32.ge_s (local.get $fn) (i32.const 100)))
          (local.set $frac (f64.mul (local.get $frac) (local.get $rf)))
          (local.set $dg (i32.trunc_f64_s (f64.floor (local.get $frac))))
          (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (select (i32.add (local.get $dg) (i32.const 48)) (i32.add (local.get $dg) (i32.const 87)) (i32.lt_s (local.get $dg) (i32.const 10))))
          (local.set $frac (f64.sub (local.get $frac) (f64.floor (local.get $frac))))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (local.set $fn (i32.add (local.get $fn) (i32.const 1)))
          (br $fl)))))
    ${!ctx.memory.shared ? `
    ;; When __mkstr packed an SSO result it allocated nothing, so the digit scratch
    ;; ($buf, at heap top) is dead — reclaim it so a heap-top accumulator stays on
    ;; top and \`s += n.toString(r)\` bump-extends instead of reallocating (O(n)).
    (local.set $rv (call $__mkstr (local.get $buf) (local.get $pos)))
    (if (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $rv)) (i64.const ${LAYOUT.AUX_SHIFT}))) (i32.const ${LAYOUT.SSO_BIT}))
      (then (global.set $__heap (local.get $buf))))
    (local.get $rv)` : `(call $__mkstr (local.get $buf) (local.get $pos))`})`

  // __mkstr(buf: i32, len: i32) → f64 — copy scratch buffer to heap string.
  // Hot (~60M calls in watr self-compile via __ftoa). bulk memory.copy is ~10× faster than
  // a hand-rolled byte loop (wasm2c lowers it to memcpy under PGO+LTO).
  ctx.core.stdlib['__mkstr'] = `(func $__mkstr (param $buf i32) (param $len i32) (result f64)
    (local $off i32) (local $i i32) (local $packed i64) (local $b i32)
    ;; SSO fast path: ≤6 ASCII bytes pack into the pointer with no allocation, so a
    ;; number-format result doesn't displace a heap-top accumulator — keeping the
    ;; canonical \`s += n.toString(r)\` builder O(n) via the bump-extend path.
    ;; ≤6-ASCII⇒SSO is also the string-module INVARIANT __str_eq relies on.
    (if (i32.le_u (local.get $len) (i32.const 6))
      (then
        (block $heap
          (loop $pk
            (if (i32.lt_u (local.get $i) (local.get $len))
              (then
                (local.set $b (i32.load16_u (i32.add (local.get $buf) (i32.shl (local.get $i) (i32.const 1)))))
                (br_if $heap (i32.ge_u (local.get $b) (i32.const 0x80)))
                ;; 7-bit ASCII SSO: char i at payload bit i*7; len at payload bits 42-44.
                (local.set $packed (i64.or (local.get $packed)
                  (i64.shl (i64.extend_i32_u (local.get $b)) (i64.mul (i64.extend_i32_u (local.get $i)) (i64.const 7)))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $pk))))
          (return (f64.reinterpret_i64 (i64.or
            (i64.or
              (i64.const ${ptrNanHex(PTR.STRING, LAYOUT.SSO_BIT)})
              (i64.shl (i64.extend_i32_u (local.get $len)) (i64.const 42)))
            (local.get $packed)))))))
    (local.set $off (call $__alloc (i32.add (i32.const 4) (i32.shl (local.get $len) (i32.const 1)))))
    (i32.store (local.get $off) (local.get $len))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (memory.copy (local.get $off) (local.get $buf) (i32.shl (local.get $len) (i32.const 1)))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $off)))`

  // __ftoa(val: f64, prec: i32, mode: i32) → f64 (NaN-boxed string)
  // mode 0: default (shortest repr, strip trailing zeros)
  // mode 1: fixed (exactly prec decimal places)
  // Uses integer-scaled digit extraction to avoid float drift.
  ctx.core.stdlib['__ftoa'] = `(func $__ftoa (param $val f64) (param $prec i32) (param $mode i32) (result f64)
    (local $buf i32) (local $pos i32) (local $neg i32)
    (local $abs f64) (local $scale f64) (local $scaled f64)
    (local $int i32) (local $frac i32) (local $ilen i32) (local $flen i32)
    (local $i i32) (local $j i32)
    ;; Special values
    (if (f64.ne (local.get $val) (local.get $val)) (then (return (call $__static_str (i32.const 0)))))
    (if (f64.eq (local.get $val) (f64.const inf)) (then (return (call $__static_str (i32.const 1)))))
    (if (f64.eq (local.get $val) (f64.const -inf)) (then (return (call $__static_str (i32.const 2)))))
    ;; Default mode: ES-exact shortest round-trip digits + notation (Ryū core) —
    ;; the rest of this function serves mode 1 (toFixed/toPrecision) only.
    (if (i32.eqz (local.get $mode))
      (then (return (call $__ftoa_shortest (local.get $val)))))
    (local.set $buf (call $__alloc (i32.const 80)))
    ;; Sign
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $val (f64.neg (local.get $val)))))
    (if (i32.and (f64.eq (local.get $val) (f64.const 0)) (local.get $neg))
      (then (local.set $neg (i32.const 0))))
    (if (local.get $neg)
      (then (i32.store16 (local.get $buf) (i32.const 45))
        (local.set $pos (i32.const 1))))
    ;; Round and scale to integer: scaled = nearest(val * 10^prec).
    ;; NOTE: toFixed/toPrecision round ties-to-even here (f64.nearest), which differs from
    ;; JS's round-half-away-from-zero on exact halves like (2.5).toFixed(0) → '2' vs '3'.
    ;; A naive floor(x+0.5) "fixes" those but breaks values like 1.45 (whose ×10 rounds up
    ;; to 14.5 in f64, giving '1.5' vs JS '1.4'); bit-exact toFixed needs the exact-decimal
    ;; algorithm. Documented as a known difference rather than trading one error for another.
    (local.set $scale (call $__pow10 (local.get $prec)))
    (local.set $scaled (f64.nearest (f64.mul (local.get $val) (local.get $scale))))
    ;; If scaled doesn't fit i32, reduce precision until it does (min prec=0)
    (block $fit (loop $fitl
      (br_if $fit (f64.lt (local.get $scaled) (f64.const 2147483648)))
      (br_if $fit (i32.le_s (local.get $prec) (i32.const 0)))
      (local.set $prec (i32.sub (local.get $prec) (i32.const 1)))
      (local.set $scale (call $__pow10 (local.get $prec)))
      (local.set $scaled (f64.nearest (f64.mul (local.get $val) (local.get $scale))))
      (br $fitl)))
    ;; Split: int = scaled / scale, frac = scaled % scale
    (if (f64.lt (local.get $scaled) (f64.const 2147483648))
      (then
        (local.set $int (i32.trunc_f64_u (f64.div (local.get $scaled) (local.get $scale))))
        (local.set $frac (i32.trunc_f64_u (f64.sub (local.get $scaled)
          (f64.mul (f64.convert_i32_u (local.get $int)) (local.get $scale))))))
      (else
        (local.set $int (i32.const 0))
        (local.set $frac (i32.const 0))
        (local.set $prec (i32.const 0))
        (local.set $abs (f64.trunc (local.get $val)))
        ;; Write large integer digits reversed.
        ;; Clamp digit to [0,9]: f64 precision loss for large values can make the naive
        ;; subtraction (abs - trunc(abs/10)*10) go slightly negative → i32.trunc_f64_u trap.
        (local.set $ilen (local.get $pos))
        (block $ld (loop $ll
          (br_if $ld (f64.lt (local.get $abs) (f64.const 1)))
          (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.add (i32.const 48) (i32.trunc_f64_u (f64.max (f64.const 0) (f64.min (f64.const 9)
              (f64.nearest (f64.sub (local.get $abs)
                (f64.mul (f64.trunc (f64.div (local.get $abs) (f64.const 10))) (f64.const 10)))))))))
          (local.set $abs (f64.trunc (f64.div (local.get $abs) (f64.const 10))))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (br $ll)))
        ;; Reverse
        (local.set $i (local.get $ilen)) (local.set $j (i32.sub (local.get $pos) (i32.const 1)))
        (block $rd (loop $rl
          (br_if $rd (i32.ge_s (local.get $i) (local.get $j)))
          (local.set $int (i32.load16_u (i32.add (local.get $buf) (i32.shl (local.get $i) (i32.const 1)))))
          (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $i) (i32.const 1))) (i32.load16_u (i32.add (local.get $buf) (i32.shl (local.get $j) (i32.const 1)))))
          (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $j) (i32.const 1))) (local.get $int))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (local.set $j (i32.sub (local.get $j) (i32.const 1)))
          (br $rl)))
        (return (call $__mkstr (local.get $buf) (local.get $pos)))))
    ;; Write integer part
    (local.set $ilen (call $__itoa (local.get $int) (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1)))))
    (local.set $pos (i32.add (local.get $pos) (local.get $ilen)))
    ;; Write fractional part: extract digits from $frac by dividing by 10^(prec-1), 10^(prec-2), ...
    (if (i32.gt_s (local.get $prec) (i32.const 0))
      (then
        (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 46))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (local.set $i (i32.sub (local.get $prec) (i32.const 1)))
        (block $fd (loop $fl
          (br_if $fd (i32.lt_s (local.get $i) (i32.const 0)))
          (local.set $j (i32.div_u (local.get $frac) (i32.trunc_f64_u (call $__pow10 (local.get $i)))))
          (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.add (i32.const 48) (i32.rem_u (local.get $j) (i32.const 10))))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (local.set $i (i32.sub (local.get $i) (i32.const 1)))
          (br $fl)))))
    (call $__mkstr (local.get $buf) (local.get $pos)))`

  // __toExp(val: f64, prec: i32, strip: i32) → f64 (NaN-boxed string)
  // Format: [-]d.ddd...e[+/-]dd — integer-based digit extraction.
  // strip=1 drops trailing fractional zeros (default ToString); strip=0 keeps
  // the exact prec digits (toExponential/toPrecision need a fixed digit count).
  ctx.core.stdlib['__toExp'] = `(func $__toExp (param $val f64) (param $prec i32) (param $strip i32) (result f64)
    (local $buf i32) (local $pos i32) (local $neg i32) (local $exp i32)
    (local $len i32) (local $i i32) (local $j i32)
    (local $mantissa f64) (local $scale f64)
    (if (f64.ne (local.get $val) (local.get $val)) (then (return (call $__static_str (i32.const 0)))))
    (if (f64.eq (local.get $val) (f64.const inf)) (then (return (call $__static_str (i32.const 1)))))
    (if (f64.eq (local.get $val) (f64.const -inf)) (then (return (call $__static_str (i32.const 2)))))
    ;; The scaled mantissa is (prec+1) digits; cap prec at 8 so it stays below
    ;; 2^32 (10^9 < 2^32 < 10^10), otherwise i32.trunc_f64_u below traps with
    ;; "float unrepresentable in integer range" — e.g. 7.5e-151 normalizes to
    ;; 7.5 and 7.5*10^9 already overflows an unsigned i32.
    (if (i32.gt_s (local.get $prec) (i32.const 8)) (then (local.set $prec (i32.const 8))))
    (local.set $buf (call $__alloc (i32.const 64)))
    ;; Sign
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $val (f64.neg (local.get $val)))))
    (if (i32.and (f64.eq (local.get $val) (f64.const 0)) (local.get $neg))
      (then (local.set $neg (i32.const 0))))
    (if (local.get $neg)
      (then (i32.store16 (local.get $buf) (i32.const 45))
        (local.set $pos (i32.const 1))))
    ;; Normalize: 1 <= val < 10
    (if (f64.gt (local.get $val) (f64.const 0))
      (then
        (block $d1 (loop $l1
          (br_if $d1 (f64.lt (local.get $val) (f64.const 10)))
          (local.set $val (f64.div (local.get $val) (f64.const 10)))
          (local.set $exp (i32.add (local.get $exp) (i32.const 1)))
          (br $l1)))
        (block $d2 (loop $l2
          (br_if $d2 (f64.ge (local.get $val) (f64.const 1)))
          (local.set $val (f64.mul (local.get $val) (f64.const 10)))
          (local.set $exp (i32.sub (local.get $exp) (i32.const 1)))
          (br $l2)))))
    ;; Scale to integer mantissa: nearest(val * 10^prec). Ties-to-even (see __ftoa note).
    (local.set $scale (call $__pow10 (local.get $prec)))
    (local.set $mantissa (f64.nearest (f64.mul (local.get $val) (local.get $scale))))
    ;; Rounding overflow (e.g. 9.95 → 1000 when prec=1, scale=10)
    (if (f64.ge (local.get $mantissa) (f64.mul (f64.const 10) (local.get $scale)))
      (then
        (local.set $mantissa (f64.div (local.get $mantissa) (f64.const 10)))
        (local.set $exp (i32.add (local.get $exp) (i32.const 1)))))
    ;; Write mantissa digits via itoa
    (local.set $len (call $__itoa (i32.trunc_f64_u (local.get $mantissa)) (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1)))))
    ;; Insert '.' after first digit
    (if (i32.gt_s (local.get $prec) (i32.const 0))
      (then
        (local.set $i (local.get $len))
        (block $md (loop $ml
          (br_if $md (i32.le_s (local.get $i) (i32.const 1)))
          (i32.store16 (i32.add (local.get $buf) (i32.shl (i32.add (local.get $pos) (local.get $i)) (i32.const 1))) (i32.load16_u (i32.add (local.get $buf) (i32.shl (i32.add (local.get $pos) (i32.sub (local.get $i) (i32.const 1))) (i32.const 1)))))
          (local.set $i (i32.sub (local.get $i) (i32.const 1)))
          (br $ml)))
        (i32.store16 (i32.add (local.get $buf) (i32.shl (i32.add (local.get $pos) (i32.const 1)) (i32.const 1))) (i32.const 46))
        (local.set $pos (i32.add (local.get $pos) (i32.add (local.get $len) (i32.const 1)))))
      (else (local.set $pos (i32.add (local.get $pos) (local.get $len)))))
    ;; Shortest form: drop trailing zeros (and a bare '.') from the mantissa.
    ;; The leading digit is always 1-9, so the walk-back stops at the '.' at worst.
    (if (i32.and (local.get $strip) (i32.gt_s (local.get $prec) (i32.const 0)))
      (then
        (block $sz (loop $szl
          (br_if $sz (i32.ne (i32.load16_u (i32.sub (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.shl (i32.const 1) (i32.const 1)))) (i32.const 48)))
          (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))
          (br $szl)))
        (if (i32.eq (i32.load16_u (i32.sub (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.shl (i32.const 1) (i32.const 1)))) (i32.const 46))
          (then (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))))))
    ;; Write 'e', sign, exponent
    (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 101))
    (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
    (if (i32.lt_s (local.get $exp) (i32.const 0))
      (then (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 45))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (local.set $exp (i32.sub (i32.const 0) (local.get $exp))))
      (else (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 43))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
    (local.set $pos (i32.add (local.get $pos) (call $__itoa (local.get $exp) (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))))))
    (call $__mkstr (local.get $buf) (local.get $pos)))`

  // __static_str(id: i32) → f64 — create heap string from data segment
  // 0=NaN 1=Infinity 2=-Infinity 3=true 4=false 5=null 6=undefined 7=[Array] 8=[Object]
  // Thunked: shared memory has no active data segment at 0 — the static-string
  // region is memory.init'd into __alloc'd space at start (compile/index.js) and
  // reads rebase off $__staticBase. Owned memory keeps absolute offsets (base 0).
  ctx.core.stdlib['__static_str'] = () => {
    if (ctx.memory.shared && !ctx.scope.globals.has('__staticBase')) declGlobal('__staticBase', 'i32')
    return `(func $__static_str (param $id i32) (result f64)
    (local $src i32) (local $len i32)
    (local.set $src (i32.const 0)) (local.set $len (i32.const 0))
    (if (i32.eqz (local.get $id))                   (then (local.set $len (i32.const 3))))
    (if (i32.eq (local.get $id) (i32.const 1)) (then (local.set $src (i32.const 6))  (local.set $len (i32.const 8))))
    (if (i32.eq (local.get $id) (i32.const 2)) (then (local.set $src (i32.const 22)) (local.set $len (i32.const 9))))
    (if (i32.eq (local.get $id) (i32.const 3)) (then (local.set $src (i32.const 40)) (local.set $len (i32.const 4))))
    (if (i32.eq (local.get $id) (i32.const 4)) (then (local.set $src (i32.const 48)) (local.set $len (i32.const 5))))
    (if (i32.eq (local.get $id) (i32.const 5)) (then (local.set $src (i32.const 58)) (local.set $len (i32.const 4))))
    (if (i32.eq (local.get $id) (i32.const 6)) (then (local.set $src (i32.const 66)) (local.set $len (i32.const 9))))
    (if (i32.eq (local.get $id) (i32.const 7)) (then (local.set $src (i32.const 84)) (local.set $len (i32.const 7))))
    (if (i32.eq (local.get $id) (i32.const 8)) (then (local.set $src (i32.const 98)) (local.set $len (i32.const 8))))
    (if (i32.eq (local.get $id) (i32.const 9)) (then (local.set $src (i32.const 114)) (local.set $len (i32.const 2))))
    (if (i32.eq (local.get $id) (i32.const 10)) (then (local.set $src (i32.const 118)) (local.set $len (i32.const 9))))
    (if (i32.eq (local.get $id) (i32.const 11)) (then (local.set $src (i32.const 136)) (local.set $len (i32.const 9))))
    (call $__mkstr ${ctx.memory.shared ? '(i32.add (global.get $__staticBase) (local.get $src))' : '(local.get $src)'} (local.get $len)))`
  }

  // R: Static strings seeded at address 0. Compile.js strips if __static_str unused.
  // 0=NaN 1=Infinity 2=-Infinity 3=true 4=false 5=null 6=undefined 7=[Array] 8=[Object]
  // 9=ok 10=not-equal 11=timed-out (Atomics.wait results, module/atomics.js)
  // Padded to 16 so stripping the prefix keeps every later alignment.
  const staticStr = 'NaNInfinity-Infinitytruefalsenullundefined[Array][Object]oknot-equaltimed-out'
  dataPush(stringBytes(staticStr))
  dataAlign(16)
  ctx.runtime.staticDataLen = dataLen()

  // Three exact correction bits per exponent (-342..308) extend Ryū's shared
  // power generator to the 128-bit entries needed by decimal parsing. Negative
  // powers subtract code+1; nonnegative powers add code. No second power table.
  ctx.runtime.elTable = hexBytes('80e709aaa5b790f9ec5aaa379a32cc6fae587f0715306fde1dc7a20e5bf8bf79bdc9cc5efd430ec9e381d554de80bdf11331eacce46fd56ea21c372103bf6f8c16dbf05a66ac3965625ffe69c78d48ed8641c1be802a4b19184d326acd60f1fa667bf6b7573e16004f833e95b9f9376fcbab9e9714faa495e784f233cf6be0cd0100000000000000000000000000000000000000c0b220aa4f7c4537d17c7a84602633335baf79be4c5b81736bc1b0009ffdc40fb26cf8e13325c25865c7286a4857d947d7d6d245def2c64c0363289d38e85af57c4ea13b7fac6570cac8b263bd7ff74195c1c11beb412b5b66ddfe0ce208253200')

  // Register the stdlib function (no data appended here — see compile/index.js hook)
  ctx.core.stdlib['__dec_to_f64'] = DEC_TO_F64_WAT

  // === Ryū shortest round-trip float→decimal (Adams, PLDI'18) ===
  // Digit core for the default String(number)/template/JSON.stringify path: the
  // unique shortest digit string that parses back to the same f64 bits, with ES
  // Number::toString notation rules applied on top. Ported from the reference
  // d2s.c (github.com/ulfjack/ryu, Apache-2.0/Boost-1.0), full-table variant.
  //
  // Size-optimized table (reference RYU_OPTIMIZE_SIZE, d2s_small_table.h):
  // instead of all 618 required 128-bit powers of 5 (~9.7KB), store every 26th
  // power (plus 5^0..5^25 as u64 and 2-bit rounding-error offsets) and rebuild
  // any entry with one extra 64×128 multiply per call ($__ryu_pow5) — verified
  // entry-exact against the full reference tables for all 618 indices.
  // Seed layout at $__ryu_tbl (828 bytes, LE):
  //   +0   DOUBLE_POW5_INV_SPLIT2[15]  (lo,hi u64 pairs — 1/5^(26k), 126-bit)
  //   +240 DOUBLE_POW5_SPLIT2[13]      (lo,hi u64 pairs — 5^(26k), 125-bit)
  //   +448 DOUBLE_POW5_TABLE[26]       (5^0..5^25 as u64)
  //   +656 POW5_INV_OFFSETS[22]        (u32 bitmaps, 2 bits per index)
  //   +744 POW5_OFFSETS[21]            (u32 bitmaps, 2 bits per index)
  const RYU_SEED_HEX = '01000000000000000000000000000020345065c05fc9a652bb13cbaec440c21806c8df7100d5a87cf56f0fda58fc27136e4756357d24206502c7e768e48ca41de9e60268d7cd39617977fcc2405bef16798cde43ffa751f991f3b278f5bdbe11e857e9d6e8bee87bb054ac8f848d751bea23a499e9f9d38bb7a3714061da3e15cee33ecb73f948088c97b427d51b7010a2bfefb9eb8532154db44db49bbb6f1996b6076cf8e7eead36d9b4f59135ae13222218af4e6a684d91daaa3d4f40741e9fbd9ee006a1c09857c2a7fda40e90170e7d497173e3208fb220d87605143b12853d7434811343b0ad297a5f27f4351c000000000000000000000000000000100000000000000000b9340332b7f4ad1410db1ab30892540e0d307d951447ba1a66088f4d26adc66df598bf85e2b74511ca96853d92bd1debfca11860dcef52163c92ae220bb8c1b4839d2d5b0562da1c304c7e8f4e8bb25b16f4529f8b56a512fbd4827643ed8af08fe7f9311565191850f19bd94a13eeb4284cf0a686c1251f035fc270cb9e4916e642889c44eb2014b0650836ad6ea58585f0ca14e2fd031a0b899979d5b13d09d8da973a35ebcf10ac363f5e73bb38cf3e6752fa44afba150100000000000000050000000000000019000000000000007d000000000000007102000000000000350c000000000000093d0000000000002d31010000000000e1f505000000000065cd1d0000000000f902950000000000dd0ee90200000000514a8d0e000000009573c24800000000e941cc6b010000008d49fd1a07000000c16ff28623000000c52ebca2b1000000d9e9ac2d780300003d9160e45811000031d6e275bc560000f52e6e4daeb10100c9ea268367780800ed95c28f055a2a00a1edccce1bc2d30025a4000a8bca220454455454455505040010041014044000000001405555154154040000440001000000004041000044504445505400555554556551004000400100000100050100115451515455550500154150000004401001040500000000000000000000000000000000000000000000004095596959555554551555555604051541105455404551554440455044505555450040004040044496655556554540455451411540559155555555405105010000'
  ctx.runtime.ryuTable = hexBytes(RYU_SEED_HEX)

  // 64×64 → high 64 bits, via 32-bit limb products (wasm has no mul-high).
  ctx.core.stdlib['__ryu_mulhi'] = `(func $__ryu_mulhi (param $a i64) (param $b i64) (result i64)
    (local $a0 i64) (local $a1 i64) (local $b0 i64) (local $b1 i64) (local $mid i64) (local $mid2 i64)
    (local.set $a0 (i64.and (local.get $a) (i64.const 0xFFFFFFFF)))
    (local.set $a1 (i64.shr_u (local.get $a) (i64.const 32)))
    (local.set $b0 (i64.and (local.get $b) (i64.const 0xFFFFFFFF)))
    (local.set $b1 (i64.shr_u (local.get $b) (i64.const 32)))
    (local.set $mid (i64.add (i64.mul (local.get $a1) (local.get $b0))
      (i64.shr_u (i64.mul (local.get $a0) (local.get $b0)) (i64.const 32))))
    (local.set $mid2 (i64.add (i64.mul (local.get $a0) (local.get $b1))
      (i64.and (local.get $mid) (i64.const 0xFFFFFFFF))))
    (i64.add (i64.add (i64.mul (local.get $a1) (local.get $b1))
      (i64.shr_u (local.get $mid) (i64.const 32)))
      (i64.shr_u (local.get $mid2) (i64.const 32))))`

  // Unsigned 64×128 → 192 bits, least-significant limb first. Decimal parsing,
  // power reconstruction and float formatting share the same carry arithmetic.
  ctx.core.stdlib['__umul128'] = `(func $__umul128
    (param $m i64) (param $lo i64) (param $hi i64) (result i64 i64 i64)
    (local $h0 i64) (local $mid i64) (local $top i64)
    (local.set $h0 (call $__ryu_mulhi (local.get $m) (local.get $lo)))
    (local.set $mid (i64.add (local.get $h0) (i64.mul (local.get $m) (local.get $hi))))
    (local.set $top (i64.add (call $__ryu_mulhi (local.get $m) (local.get $hi))
      (i64.extend_i32_u (i64.lt_u (local.get $mid) (local.get $h0)))))
    (i64.mul (local.get $m) (local.get $lo))
    (local.get $mid)
    (local.get $top))`

  // (m × entry) >> j; 64 < j < 128, result proven to fit u64.
  ctx.core.stdlib['__ryu_mulshift'] = `(func $__ryu_mulshift
    (param $m i64) (param $lo i64) (param $hi i64) (param $j i32) (result i64)
    (local $mid i64) (local $top i64) (local $d i64)
    (call $__umul128 (local.get $m) (local.get $lo) (local.get $hi))
    (local.set $top)
    (local.set $mid)
    (drop)
    (local.set $d (i64.extend_i32_u (i32.sub (local.get $j) (i32.const 64))))
    (i64.or (i64.shr_u (local.get $mid) (local.get $d))
      (i64.shl (local.get $top) (i64.sub (i64.const 64) (local.get $d)))))`

  // Rebuild the power-of-five entry for index $i as a pair of i64 lanes:
  // seed × 5^offset, shifted back into the 125/126-bit window, plus the stored
  // 2-bit rounding offset (reference double_computePow5/double_computeInvPow5).
  ctx.core.stdlib['__ryu_pow5'] = () => {
    if (!ctx.scope.globals.has('__ryu_tbl')) declGlobal('__ryu_tbl', 'i32')
    return `(func $__ryu_pow5 (param $i i32) (param $inv i32) (result i64 i64)
    (local $base i32) (local $base2 i32) (local $off i32) (local $mul i32)
    (local $mlo i64) (local $mhi i64) (local $m i64) (local $a i64)
    (local $prodLo i64) (local $prodMid i64) (local $prodHi i64) (local $delta i64)
    (local $rLo i64) (local $rHi i64) (local $e i64)
    (if (local.get $inv)
      (then
        (local.set $base (i32.div_u (i32.add (local.get $i) (i32.const 25)) (i32.const 26)))
        (local.set $base2 (i32.mul (local.get $base) (i32.const 26)))
        (local.set $off (i32.sub (local.get $base2) (local.get $i)))
        (local.set $mul (i32.add (global.get $__ryu_tbl) (i32.shl (local.get $base) (i32.const 4)))))
      (else
        (local.set $base (i32.div_u (local.get $i) (i32.const 26)))
        (local.set $base2 (i32.mul (local.get $base) (i32.const 26)))
        (local.set $off (i32.sub (local.get $i) (local.get $base2)))
        (local.set $mul (i32.add (i32.add (global.get $__ryu_tbl) (i32.const 240)) (i32.shl (local.get $base) (i32.const 4))))))
    (local.set $mlo (i64.load (local.get $mul)))
    (local.set $mhi (i64.load (i32.add (local.get $mul) (i32.const 8))))
    (if (i32.eqz (local.get $off))
      (then (return (local.get $mlo) (local.get $mhi))))
    (local.set $m (i64.load (i32.add (i32.add (global.get $__ryu_tbl) (i32.const 448)) (i32.shl (local.get $off) (i32.const 3)))))
    (call $__umul128 (local.get $m)
      (i64.sub (local.get $mlo) (i64.extend_i32_u (local.get $inv))) (local.get $mhi))
    (local.set $prodHi)
    (local.set $prodMid)
    (local.set $prodLo)
    ;; delta = |pow5bits(i) - pow5bits(base2)| ∈ (0, 64)
    (local.set $delta (i64.extend_i32_u (i32.sub
      (i32.shr_u (i32.mul (select (local.get $base2) (local.get $i) (local.get $inv)) (i32.const 1217359)) (i32.const 19))
      (i32.shr_u (i32.mul (select (local.get $i) (local.get $base2) (local.get $inv)) (i32.const 1217359)) (i32.const 19)))))
    ;; Shift the 192-bit product back into the normalized window.
    (local.set $rLo (i64.or (i64.shr_u (local.get $prodLo) (local.get $delta))
      (i64.shl (local.get $prodMid) (i64.sub (i64.const 64) (local.get $delta)))))
    (local.set $rHi (i64.or (i64.shr_u (local.get $prodMid) (local.get $delta))
      (i64.shl (local.get $prodHi) (i64.sub (i64.const 64) (local.get $delta)))))
    ;; + stored 2-bit error (+1 more for the inverse table)
    (local.set $e (i64.add
      (i64.and (i64.extend_i32_u (i32.shr_u
        (i32.load (i32.add (i32.add (global.get $__ryu_tbl) (select (i32.const 656) (i32.const 744) (local.get $inv)))
          (i32.shl (i32.div_u (local.get $i) (i32.const 16)) (i32.const 2))))
        (i32.shl (i32.rem_u (local.get $i) (i32.const 16)) (i32.const 1)))) (i64.const 3))
      (i64.extend_i32_u (local.get $inv))))
    (local.set $a (i64.add (local.get $rLo) (local.get $e)))
    (local.set $rHi (i64.add (local.get $rHi) (i64.extend_i32_u (i64.lt_u (local.get $a) (local.get $rLo)))))
    (local.get $a)
    (local.get $rHi))`
  }

  // divisible by 5^p?
  ctx.core.stdlib['__ryu_pow5div'] = `(func $__ryu_pow5div (param $v i64) (param $p i32) (result i32)
    (block $out (loop $l
      (br_if $out (i32.le_s (local.get $p) (i32.const 0)))
      (if (i64.ne (i64.rem_u (local.get $v) (i64.const 5)) (i64.const 0)) (then (return (i32.const 0))))
      (local.set $v (i64.div_u (local.get $v) (i64.const 5)))
      (local.set $p (i32.sub (local.get $p) (i32.const 1)))
      (br $l)))
    (i32.const 1))`

  // Shortest-round-trip ToString(number). Transcribes d2s.c's d2d (same local
  // names where possible: mv/vp/vr/vm, q, e10, acceptBounds≡$even) and renders
  // per ES Number::toString: n = e10+len is the decimal-point position; k≤n≤21
  // plain integer, 0<n≤21 embedded point, -6<n≤0 leading zeros, else d.dddde±k.
  ctx.core.stdlib['__ftoa_shortest'] = () => `(func $__ftoa_shortest (param $val f64) (result f64)
    (local $bits i64) (local $ieeeM i64) (local $ieeeE i32)
    (local $e2 i32) (local $m2 i64) (local $even i32) (local $mmShift i64) (local $mv i64)
    (local $vr i64) (local $vp i64) (local $vm i64) (local $h0 i64) (local $t i64) (local $d10 i64)
    (local $e10 i32) (local $q i32) (local $k i32) (local $sh i32) (local $powLo i64) (local $powHi i64)
    (local $vmTZ i32) (local $vrTZ i32) (local $removed i32) (local $last i32) (local $roundUp i32)
    (local $out i64) (local $buf i32) (local $scr i32) (local $pos i32) (local $olen i32) (local $n i32) (local $i i32)
    (if (f64.ne (local.get $val) (local.get $val)) (then (return (call $__static_str (i32.const 0)))))
    (if (f64.eq (local.get $val) (f64.const inf)) (then (return (call $__static_str (i32.const 1)))))
    (if (f64.eq (local.get $val) (f64.const -inf)) (then (return (call $__static_str (i32.const 2)))))
    (local.set $buf (call $__alloc (i32.const 192)))
    (local.set $scr (i32.add (local.get $buf) (i32.const 64)))
    (if (f64.eq (local.get $val) (f64.const 0))
      (then
        (i32.store16 (local.get $buf) (i32.const 48))
        (return (call $__mkstr (local.get $buf) (i32.const 1)))))
    (local.set $bits (i64.reinterpret_f64 (local.get $val)))
    (if (i64.lt_s (local.get $bits) (i64.const 0))
      (then
        (i32.store16 (local.get $buf) (i32.const 45))
        (local.set $pos (i32.const 1))))
    (local.set $ieeeM (i64.and (local.get $bits) (i64.const 0xFFFFFFFFFFFFF)))
    (local.set $ieeeE (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 52)) (i64.const 0x7FF))))
    ;; m2·2^e2 = |val|·2^-2 — two extra bits for the halfway-boundary math
    (if (i32.eqz (local.get $ieeeE))
      (then
        (local.set $e2 (i32.const -1076))
        (local.set $m2 (local.get $ieeeM)))
      (else
        (local.set $e2 (i32.sub (local.get $ieeeE) (i32.const 1077)))
        (local.set $m2 (i64.or (i64.const 0x10000000000000) (local.get $ieeeM)))))
    (local.set $even (i64.eqz (i64.and (local.get $m2) (i64.const 1))))
    (local.set $mv (i64.shl (local.get $m2) (i64.const 2)))
    (local.set $mmShift (i64.extend_i32_u (i32.or
      (i64.ne (local.get $ieeeM) (i64.const 0))
      (i32.le_s (local.get $ieeeE) (i32.const 1)))))
    (if (i32.ge_s (local.get $e2) (i32.const 0))
      (then
        ;; q = log10Pow2(e2) - (e2 > 3); shift = -e2 + q + 125 + (pow5bits(q)-1)
        (local.set $q (i32.sub
          (i32.shr_u (i32.mul (local.get $e2) (i32.const 78913)) (i32.const 18))
          (i32.gt_s (local.get $e2) (i32.const 3))))
        (local.set $e10 (local.get $q))
        (local.set $sh (i32.add
          (i32.add (i32.sub (local.get $q) (local.get $e2)) (i32.const 125))
          (i32.shr_u (i32.mul (local.get $q) (i32.const 1217359)) (i32.const 19))))
        (call $__ryu_pow5 (local.get $q) (i32.const 1))
        (local.set $powHi)
        (local.set $powLo)
        (local.set $vr (call $__ryu_mulshift (local.get $mv) (local.get $powLo) (local.get $powHi) (local.get $sh)))
        (local.set $vp (call $__ryu_mulshift (i64.add (local.get $mv) (i64.const 2)) (local.get $powLo) (local.get $powHi) (local.get $sh)))
        (local.set $vm (call $__ryu_mulshift (i64.sub (i64.sub (local.get $mv) (i64.const 1)) (local.get $mmShift)) (local.get $powLo) (local.get $powHi) (local.get $sh)))
        (if (i32.le_u (local.get $q) (i32.const 21))
          (then
            (if (i64.eqz (i64.rem_u (local.get $mv) (i64.const 5)))
              (then (local.set $vrTZ (call $__ryu_pow5div (local.get $mv) (local.get $q))))
              (else
                (if (local.get $even)
                  (then (local.set $vmTZ (call $__ryu_pow5div (i64.sub (i64.sub (local.get $mv) (i64.const 1)) (local.get $mmShift)) (local.get $q))))
                  (else (local.set $vp (i64.sub (local.get $vp)
                    (i64.extend_i32_u (call $__ryu_pow5div (i64.add (local.get $mv) (i64.const 2)) (local.get $q))))))))))))
      (else
        ;; q = log10Pow5(-e2) - (-e2 > 1); i = -e2-q (in $k); shift = q - (pow5bits(i)-125)
        (local.set $q (i32.sub
          (i32.shr_u (i32.mul (i32.sub (i32.const 0) (local.get $e2)) (i32.const 732923)) (i32.const 20))
          (i32.gt_s (i32.sub (i32.const 0) (local.get $e2)) (i32.const 1))))
        (local.set $e10 (i32.add (local.get $q) (local.get $e2)))
        (local.set $k (i32.sub (i32.sub (i32.const 0) (local.get $e2)) (local.get $q)))
        (local.set $sh (i32.add (i32.sub (local.get $q)
          (i32.add (i32.shr_u (i32.mul (local.get $k) (i32.const 1217359)) (i32.const 19)) (i32.const 1)))
          (i32.const 125)))
        (call $__ryu_pow5 (local.get $k) (i32.const 0))
        (local.set $powHi)
        (local.set $powLo)
        (local.set $vr (call $__ryu_mulshift (local.get $mv) (local.get $powLo) (local.get $powHi) (local.get $sh)))
        (local.set $vp (call $__ryu_mulshift (i64.add (local.get $mv) (i64.const 2)) (local.get $powLo) (local.get $powHi) (local.get $sh)))
        (local.set $vm (call $__ryu_mulshift (i64.sub (i64.sub (local.get $mv) (i64.const 1)) (local.get $mmShift)) (local.get $powLo) (local.get $powHi) (local.get $sh)))
        (if (i32.le_u (local.get $q) (i32.const 1))
          (then
            (local.set $vrTZ (i32.const 1))
            (if (local.get $even)
              (then (local.set $vmTZ (i64.eq (local.get $mmShift) (i64.const 1))))
              (else (local.set $vp (i64.sub (local.get $vp) (i64.const 1))))))
          (else
            (if (i32.lt_u (local.get $q) (i32.const 63))
              (then (local.set $vrTZ (i64.eqz (i64.and (local.get $mv)
                (i64.sub (i64.shl (i64.const 1) (i64.extend_i32_u (local.get $q))) (i64.const 1)))))))))))
    ;; shortest digits within [vm, vp]
    (if (i32.or (local.get $vmTZ) (local.get $vrTZ))
      (then
        ;; rare general path: tracks trailing zeros for exact ties
        (block $g1 (loop $gl1
          (local.set $t (i64.div_u (local.get $vp) (i64.const 10)))
          (local.set $d10 (i64.div_u (local.get $vm) (i64.const 10)))
          (br_if $g1 (i64.le_u (local.get $t) (local.get $d10)))
          (local.set $vmTZ (i32.and (local.get $vmTZ)
            (i64.eqz (i64.sub (local.get $vm) (i64.mul (local.get $d10) (i64.const 10))))))
          (local.set $vrTZ (i32.and (local.get $vrTZ) (i32.eqz (local.get $last))))
          (local.set $h0 (i64.div_u (local.get $vr) (i64.const 10)))
          (local.set $last (i32.wrap_i64 (i64.sub (local.get $vr) (i64.mul (local.get $h0) (i64.const 10)))))
          (local.set $vr (local.get $h0))
          (local.set $vp (local.get $t))
          (local.set $vm (local.get $d10))
          (local.set $removed (i32.add (local.get $removed) (i32.const 1)))
          (br $gl1)))
        (if (local.get $vmTZ)
          (then (block $g2 (loop $gl2
            (local.set $d10 (i64.div_u (local.get $vm) (i64.const 10)))
            (br_if $g2 (i64.ne (i64.sub (local.get $vm) (i64.mul (local.get $d10) (i64.const 10))) (i64.const 0)))
            (local.set $vrTZ (i32.and (local.get $vrTZ) (i32.eqz (local.get $last))))
            (local.set $h0 (i64.div_u (local.get $vr) (i64.const 10)))
            (local.set $last (i32.wrap_i64 (i64.sub (local.get $vr) (i64.mul (local.get $h0) (i64.const 10)))))
            (local.set $vr (local.get $h0))
            (local.set $vp (i64.div_u (local.get $vp) (i64.const 10)))
            (local.set $vm (local.get $d10))
            (local.set $removed (i32.add (local.get $removed) (i32.const 1)))
            (br $gl2)))))
        ;; exact .5 tail rounds to even
        (if (i32.and (i32.and (local.get $vrTZ) (i32.eq (local.get $last) (i32.const 5)))
              (i64.eqz (i64.and (local.get $vr) (i64.const 1))))
          (then (local.set $last (i32.const 4))))
        (local.set $out (i64.add (local.get $vr) (i64.extend_i32_u (i32.or
          (i32.and (i64.eq (local.get $vr) (local.get $vm))
            (i32.or (i32.eqz (local.get $even)) (i32.eqz (local.get $vmTZ))))
          (i32.ge_s (local.get $last) (i32.const 5)))))))
      (else
        ;; common fast path (~99.3%): two digits at a time first
        (local.set $t (i64.div_u (local.get $vp) (i64.const 100)))
        (local.set $d10 (i64.div_u (local.get $vm) (i64.const 100)))
        (if (i64.gt_u (local.get $t) (local.get $d10))
          (then
            (local.set $h0 (i64.div_u (local.get $vr) (i64.const 100)))
            (local.set $roundUp (i64.ge_u (i64.sub (local.get $vr) (i64.mul (local.get $h0) (i64.const 100))) (i64.const 50)))
            (local.set $vr (local.get $h0))
            (local.set $vp (local.get $t))
            (local.set $vm (local.get $d10))
            (local.set $removed (i32.add (local.get $removed) (i32.const 2)))))
        (block $f1 (loop $fl1
          (local.set $t (i64.div_u (local.get $vp) (i64.const 10)))
          (local.set $d10 (i64.div_u (local.get $vm) (i64.const 10)))
          (br_if $f1 (i64.le_u (local.get $t) (local.get $d10)))
          (local.set $h0 (i64.div_u (local.get $vr) (i64.const 10)))
          (local.set $roundUp (i64.ge_u (i64.sub (local.get $vr) (i64.mul (local.get $h0) (i64.const 10))) (i64.const 5)))
          (local.set $vr (local.get $h0))
          (local.set $vp (local.get $t))
          (local.set $vm (local.get $d10))
          (local.set $removed (i32.add (local.get $removed) (i32.const 1)))
          (br $fl1)))
        (local.set $out (i64.add (local.get $vr) (i64.extend_i32_u
          (i32.or (i64.eq (local.get $vr) (local.get $vm)) (local.get $roundUp)))))))
    (local.set $e10 (i32.add (local.get $e10) (local.get $removed)))
    ;; digits, least-significant first, into scratch
    (local.set $t (local.get $out))
    (block $dd (loop $dl
      (local.set $h0 (i64.div_u (local.get $t) (i64.const 10)))
      (i32.store16 (i32.add (local.get $scr) (i32.shl (local.get $olen) (i32.const 1))) (i32.add (i32.const 48) (i32.wrap_i64 (i64.sub (local.get $t) (i64.mul (local.get $h0) (i64.const 10))))))
      (local.set $olen (i32.add (local.get $olen) (i32.const 1)))
      (local.set $t (local.get $h0))
      (br_if $dd (i64.eqz (local.get $t)))
      (br $dl)))
    ;; ES notation: n = decimal-point position
    (local.set $n (i32.add (local.get $e10) (local.get $olen)))
    (if (i32.and (i32.le_s (local.get $olen) (local.get $n)) (i32.le_s (local.get $n) (i32.const 21)))
      (then
        (local.set $i (i32.const 0))
        (block $b1d (loop $b1l
          (br_if $b1d (i32.ge_s (local.get $i) (local.get $olen)))
          (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.load16_u (i32.add (local.get $scr) (i32.shl (i32.sub (i32.sub (local.get $olen) (i32.const 1)) (local.get $i)) (i32.const 1)))))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $b1l)))
        (block $z1d (loop $z1l
          (br_if $z1d (i32.ge_s (local.get $i) (local.get $n)))
          (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 48))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $z1l))))
      (else (if (i32.and (i32.gt_s (local.get $n) (i32.const 0)) (i32.le_s (local.get $n) (i32.const 21)))
        (then
          (local.set $i (i32.const 0))
          (block $b2d (loop $b2l
            (br_if $b2d (i32.ge_s (local.get $i) (local.get $olen)))
            (if (i32.eq (local.get $i) (local.get $n))
              (then
                (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 46))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
            (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.load16_u (i32.add (local.get $scr) (i32.shl (i32.sub (i32.sub (local.get $olen) (i32.const 1)) (local.get $i)) (i32.const 1)))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $b2l))))
        (else (if (i32.and (i32.gt_s (local.get $n) (i32.const -6)) (i32.le_s (local.get $n) (i32.const 0)))
          (then
            (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 48))
            (i32.store16 (i32.add (local.get $buf) (i32.shl (i32.add (local.get $pos) (i32.const 1)) (i32.const 1))) (i32.const 46))
            (local.set $pos (i32.add (local.get $pos) (i32.const 2)))
            (local.set $i (i32.const 0))
            (block $z3d (loop $z3l
              (br_if $z3d (i32.ge_s (local.get $i) (i32.sub (i32.const 0) (local.get $n))))
              (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 48))
              (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $z3l)))
            (local.set $i (i32.const 0))
            (block $b3d (loop $b3l
              (br_if $b3d (i32.ge_s (local.get $i) (local.get $olen)))
              (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.load16_u (i32.add (local.get $scr) (i32.shl (i32.sub (i32.sub (local.get $olen) (i32.const 1)) (local.get $i)) (i32.const 1)))))
              (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $b3l))))
          (else
            (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.load16_u (i32.add (local.get $scr) (i32.shl (i32.sub (local.get $olen) (i32.const 1)) (i32.const 1)))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (if (i32.gt_s (local.get $olen) (i32.const 1))
              (then
                (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 46))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (local.set $i (i32.const 1))
                (block $b4d (loop $b4l
                  (br_if $b4d (i32.ge_s (local.get $i) (local.get $olen)))
                  (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.load16_u (i32.add (local.get $scr) (i32.shl (i32.sub (i32.sub (local.get $olen) (i32.const 1)) (local.get $i)) (i32.const 1)))))
                  (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $b4l)))))
            (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 101))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (local.set $n (i32.sub (local.get $n) (i32.const 1)))
            (if (i32.lt_s (local.get $n) (i32.const 0))
              (then
                (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 45))
                (local.set $n (i32.sub (i32.const 0) (local.get $n))))
              (else (i32.store16 (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))) (i32.const 43))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (local.set $pos (i32.add (local.get $pos)
              (call $__itoa (local.get $n) (i32.add (local.get $buf) (i32.shl (local.get $pos) (i32.const 1))))))))))))
    (call $__mkstr (local.get $buf) (local.get $pos)))`


  // === Number constants ===

  // Each folds to inline (f64.const …), no stdlib dep. Written out (not a table
  // loop) to stay within the self-compile subset. `NaN` uses the `nan` token (not raw
  // NaN) so it survives self-compile IR marshalling — see emitNum.
  ctx.core.emit['Number.MAX_SAFE_INTEGER'] = () => typed(['f64.const', 9007199254740991], 'f64')
  ctx.core.emit['Number.MIN_SAFE_INTEGER'] = () => typed(['f64.const', -9007199254740991], 'f64')
  ctx.core.emit['Number.EPSILON'] = () => typed(['f64.const', 2.220446049250313e-16], 'f64')
  ctx.core.emit['Number.MAX_VALUE'] = () => typed(['f64.const', 1.7976931348623157e+308], 'f64')
  ctx.core.emit['Number.MIN_VALUE'] = () => typed(['f64.const', 5e-324], 'f64')
  ctx.core.emit['Number.POSITIVE_INFINITY'] = () => typed(['f64.const', Infinity], 'f64')
  ctx.core.emit['Number.NEGATIVE_INFINITY'] = () => typed(['f64.const', -Infinity], 'f64')
  ctx.core.emit['Number.NaN'] = () => typed(['f64.const', 'nan'], 'f64')

  // === Number static methods ===
  //
  // Number.isNaN (21.1.2.4) / Number.isFinite (21.1.2.2) / Number.isInteger (21.1.2.3) /
  // Number.isSafeInteger (21.1.2.5) each start "If Type(number) is not Number, return
  // false" and perform NO ToNumber coercion (unlike the global isNaN/isFinite below,
  // which DO coerce — 19.2.3/19.2.4). jz erases kind at runtime for two carrier classes
  // that can reach these methods' argument: (a) a NaN-boxed pointer/atom (string/object/
  // array/undefined/null/boolean/closure/…) is bit-identical to a hardware NaN, so raw
  // `x !== x` alone can't tell a genuine number-NaN from a boxed string; (b) the raw i64
  // BigInt carrier shares f64's bit-space outright with no distinguishing tag at all — a
  // small bigint's bits can decode as an ordinary finite float (e.g. 0n's bits ARE 0.0).
  // `nonNumberFalse` covers both: any STATICALLY provable non-Number kind is
  // unconditionally false by spec, independent of its runtime bits — x is still
  // evaluated for side effects. A provably-NUMBER argument can carry neither carrier
  // class, so the plain arithmetic below it is exact and pays nothing extra.
  const nonNumberFalse = (x) => typed(['block', ['result', 'i32'], ['drop', asF64(emit(x))], ['i32.const', 0]], 'i32')

  // Kind-unknown fallback for Number.isNaN only: the boxed-carrier ambiguity in (a)
  // above still applies dynamically (a polymorphic value could be a boxed string/atom
  // at runtime), so `x !== x` alone is necessary but not sufficient. Discriminate a
  // genuine number-NaN from a boxed carrier the same way $__typeof does (module/
  // core.js's $__typeof number branch — keep both in sync): the NaN-box prefix is
  // always sign=0 with tag/aux bits set, so a real number's NaN is either the canonical
  // NAN_BITS (tag=0/aux=0 — no live atom ever uses aux=0) or any NEGATIVE-signed NaN
  // bit pattern (an uncanonicalized fresh float NaN can leave the sign bit set; a
  // NaN-boxed pointer/atom never does — its prefix bits are fixed at sign=0). The (b)
  // BigInt-vs-Number ambiguity (no tag distinguishes them at all when dynamically
  // merged) is a pre-existing representation limitation shared with typeof's own
  // dynamic path (typeof of a runtime-merged number∪bigint value already
  // misreports "number") — out of scope here, not introduced by this fix.
  const isNumNaNBits = (bitsLocal) => ['i32.or',
    ['i64.eq', ['local.get', bitsLocal], ['i64.const', NAN_BITS]],
    ['i64.eq', ['i64.and', ['local.get', bitsLocal], ['i64.const', '0xFFF0000000000000']], ['i64.const', '0xFFF0000000000000']]]

  // maybeUndefined gate (.work/archive/todo.md §deletion-sweep §1/§4): a NUMBER claim
  // sourced from a dict/map value census (censusMaybeUndefined) is really
  // NUMBER|undefined — an absent key reads back UNDEF_NAN at runtime, a bit
  // pattern that (unlike a genuine number-NaN) must NOT satisfy Number.isNaN.
  // A non-census proven-NUMBER arg (loop counters, arithmetic results, schema
  // slots) can never carry ANY boxed pointer/atom, so its bare self-compare
  // stays exact and pays nothing extra — only census reads fall through to the
  // tag-discriminating dynamic path below (already sound for kind-unknown args;
  // reused as-is, no new coercion logic needed here).
  const emitIsNaN = (x) => {
    const vt = valTypeOf(x)
    if (vt != null && vt !== VAL.NUMBER) return nonNumberFalse(x)
    const v = asF64(emit(x))
    const t = temp('t')
    const raw = typed(['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]], 'i32')
    if (vt === VAL.NUMBER && !censusMaybeUndefined(x)) return raw
    const bits = tempI64('b')
    return typed(['if', ['result', 'i32'], raw,
      ['then', ['block', ['result', 'i32'],
        ['local.set', `$${bits}`, ['i64.reinterpret_f64', ['local.get', `$${t}`]]],
        isNumNaNBits(`$${bits}`)]],
      ['else', ['i32.const', 0]]], 'i32')
  }

  // No censusMaybeUndefined gate needed here (unlike emitIsNaN above): every
  // formula in this family's remaining three methods (isFinite/isInteger/
  // isSafeInteger) OPENS with `f64.eq(v,v)` — self-equality, false for ANY
  // NaN bit pattern, including UNDEF_NAN. isNaN's whole problem is that it
  // wants `true` for one NaN-bit-pattern class (genuine number-NaN) and
  // `false` for another (boxed pointers/UNDEF_NAN) — a distinction these
  // three methods never need to make, because their spec answer for BOTH
  // classes is the same `false`. A census-sourced UNDEF_NAN therefore already
  // fails the leading `f64.eq` term structurally, with no extra check — a
  // Map/dict-absent read is `false` for all three (see test/math.js).
  const emitIsFinite = (x) => {
    const vt = valTypeOf(x)
    if (vt != null && vt !== VAL.NUMBER) return nonNumberFalse(x)
    const v = asF64(emit(x))
    const t = temp('t')
    return typed(['i32.and',
      ['f64.eq', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      ['f64.lt', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', Infinity]]], 'i32')
  }

  ctx.core.emit['Number.isNaN'] = emitIsNaN
  ctx.core.emit['Number.isFinite'] = emitIsFinite

  // Global isNaN/isFinite — coerce string→number first (unlike Number.isNaN/isFinite)
  ctx.core.emit['isNaN'] = (x) => {
    const v = toNumF64(x, emit(x))
    const t = temp('t')
    return typed(['f64.ne',
      ['local.tee', `$${t}`, v],
      ['local.get', `$${t}`]], 'i32')
  }
  ctx.core.emit['isFinite'] = (x) => {
    const v = toNumF64(x, emit(x))
    const t = temp('t')
    return typed(['i32.and',
      ['f64.eq', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
      ['f64.lt', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', Infinity]]], 'i32')
  }

  ctx.core.emit['Number.isInteger'] = (x) => {
    const vt = valTypeOf(x)
    if (vt != null && vt !== VAL.NUMBER) return nonNumberFalse(x)
    const v = asF64(emit(x))
    const t = temp('t')
    return typed(['i32.and',
      ['i32.and',
        ['f64.eq', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
        ['f64.lt', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', Infinity]]],
      ['f64.eq', ['local.get', `$${t}`], ['f64.trunc', ['local.get', `$${t}`]]]], 'i32')
  }

  // Number.isSafeInteger(x): integer AND |x| ≤ 2^53 − 1.
  ctx.core.emit['Number.isSafeInteger'] = (x) => {
    const vt = valTypeOf(x)
    if (vt != null && vt !== VAL.NUMBER) return nonNumberFalse(x)
    const v = asF64(emit(x))
    const t = temp('t')
    return typed(['i32.and',
      ['i32.and',
        ['f64.eq', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]],
        ['f64.eq', ['local.get', `$${t}`], ['f64.trunc', ['local.get', `$${t}`]]]],
      ['f64.le', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', 9007199254740991]]], 'i32')
  }

  ctx.core.stdlib['__parseInt'] = `(func $__parseInt (param $str i64) (param $radix i32) (result f64)
    (local $off i32) (local $len i32) (local $i i32) (local $c i32) (local $neg i32)
    (local $digit i32) (local $seen i32) (local $f f64)
    (local $acc i64) (local $rad i64) (local $ovf i32) (local $exp i32) (local $sticky i32) (local $k i32) (local $e i32)
    ;; Invalid radix (nonzero and outside 2..36 after ToInt32) → NaN regardless of input.
    (if (i32.and (i32.ne (local.get $radix) (i32.const 0))
      (i32.or (i32.lt_s (local.get $radix) (i32.const 2)) (i32.gt_s (local.get $radix) (i32.const 36))))
      (then (return (f64.const nan))))
    (local.set $f (f64.reinterpret_i64 (local.get $str)))
    ;; Number input takes ToString like any other value. In the plain-decimal range
    ;; (finite, 1e-6 ≤ |x| < 1e21, or ±0) ToString has no exponent, so parsing its
    ;; leading digits IS trunc — keep that as the fast path. Outside it ("1e+21",
    ;; "1e-7", "Infinity") route through the real formatter: parseInt(1e21) is 1,
    ;; parseInt(Infinity) is NaN.
    (if (f64.eq (local.get $f) (local.get $f)) (then
      ;; ±0 → +0: ToString(-0) is "0", no sign survives.
      (if (f64.eq (local.get $f) (f64.const 0)) (then (return (f64.const 0))))
      (if (i32.and (f64.lt (f64.abs (local.get $f)) (f64.const 1e21))
        (f64.ge (f64.abs (local.get $f)) (f64.const 0.000001)))
        (then (return (f64.trunc (local.get $f)))))
      (local.set $str (call $__to_str (local.get $str)))))
    ;; If NaN-boxed but not a string → return NaN
    (if (i32.ne (call $__ptr_type (local.get $str)) (i32.const 4))
      (then (return (f64.const nan))))
    (local.set $off (call $__ptr_offset (local.get $str)))
    (local.set $len (call $__str_length (local.get $str)))
    ;; Skip StrWhiteSpace (UTF-16 units: NBSP, LS/PS, Zs — not just ASCII).
    (local.set $i (call $__skipws (local.get $str) (i32.const 0) (local.get $len)))
    ;; Sign
    (if (i32.and (i32.lt_s (local.get $i) (local.get $len))
      (i32.eq (call $__char_at (local.get $str) (local.get $i)) (i32.const 45)))
      (then (local.set $neg (i32.const 1)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    (if (i32.and (i32.lt_s (local.get $i) (local.get $len))
      (i32.eq (call $__char_at (local.get $str) (local.get $i)) (i32.const 43)))
      (then (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    ;; 0x prefix → radix 16 (stripped when radix is unspecified OR explicitly 16, per JS)
    (if (i32.and (i32.or (i32.eqz (local.get $radix)) (i32.eq (local.get $radix) (i32.const 16)))
      (i32.and (i32.le_s (i32.add (local.get $i) (i32.const 1)) (local.get $len))
        (i32.and (i32.eq (call $__char_at (local.get $str) (local.get $i)) (i32.const 48))
          (i32.or (i32.eq (call $__char_at (local.get $str) (i32.add (local.get $i) (i32.const 1))) (i32.const 120))
            (i32.eq (call $__char_at (local.get $str) (i32.add (local.get $i) (i32.const 1))) (i32.const 88))))))
      (then (local.set $radix (i32.const 16)) (local.set $i (i32.add (local.get $i) (i32.const 2)))))
    (if (i32.eqz (local.get $radix)) (then (local.set $radix (i32.const 10))))
    ;; Power-of-two radix → exact bit width per digit (lets the >2^64 path round once).
    (if (i32.eqz (i32.and (local.get $radix) (i32.sub (local.get $radix) (i32.const 1))))
      (then (local.set $k (i32.ctz (local.get $radix)))))
    (local.set $rad (i64.extend_i32_u (local.get $radix)))
    ;; Parse digits — accumulate EXACTLY in u64 (round-once via convert at the end, matching JS for
    ;; any value < 2^64). On u64 overflow, freeze the high bits and track the dropped magnitude
    ;; (exp) + a sticky bit so the final round-to-f64 still matches round-once for power-of-two radix.
    (block $done (loop $lp
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $c (call $__char_at (local.get $str) (local.get $i)))
      ;; Digit value
      (local.set $digit (i32.const -1))
      (if (i32.and (i32.ge_s (local.get $c) (i32.const 48)) (i32.le_s (local.get $c) (i32.const 57)))
        (then (local.set $digit (i32.sub (local.get $c) (i32.const 48)))))
      (if (i32.and (i32.ge_s (local.get $c) (i32.const 97)) (i32.le_s (local.get $c) (i32.const 122)))
        (then (local.set $digit (i32.sub (local.get $c) (i32.const 87)))))
      (if (i32.and (i32.ge_s (local.get $c) (i32.const 65)) (i32.le_s (local.get $c) (i32.const 90)))
        (then (local.set $digit (i32.sub (local.get $c) (i32.const 55)))))
      (br_if $done (i32.or (i32.lt_s (local.get $digit) (i32.const 0)) (i32.ge_s (local.get $digit) (local.get $radix))))
      (local.set $seen (i32.const 1))
      (if (i32.eqz (local.get $ovf))
        (then
          ;; acc*radix + digit, exact while it stays within unsigned 64-bit
          (if (i64.le_u (local.get $acc) (i64.div_u (i64.sub (i64.const -1) (i64.extend_i32_u (local.get $digit))) (local.get $rad)))
            (then (local.set $acc (i64.add (i64.mul (local.get $acc) (local.get $rad)) (i64.extend_i32_u (local.get $digit)))))
            (else
              (local.set $ovf (i32.const 1))
              ;; non-power-of-two radix: continue round-each in f64 from the exact seed (keeps magnitude)
              (if (i32.eqz (local.get $k)) (then (local.set $f (f64.convert_i64_u (local.get $acc)))))))))
      (if (local.get $ovf)
        (then
          (if (local.get $k)
            (then  ;; power-of-two: this digit and all later ones sit below the frozen high bits
              (local.set $exp (i32.add (local.get $exp) (local.get $k)))
              (if (local.get $digit) (then (local.set $sticky (i32.const 1)))))
            (else  ;; other radix: round-each f64 — ≤1 ULP past 2^53, but only for >2^64 values
              (local.set $f (f64.add (f64.mul (local.get $f) (f64.convert_i32_u (local.get $radix))) (f64.convert_i32_u (local.get $digit))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    ;; No digits consumed → NaN
    (if (i32.eqz (local.get $seen)) (then (return (f64.const nan))))
    ;; Produce the f64. No overflow → exact round-once convert. Overflow+power-of-two → round the
    ;; frozen high bits (sticky-injected to break ties correctly) and scale by 2^exp. Overflow on
    ;; another radix → $f already holds the round-each result.
    (if (i32.eqz (local.get $ovf))
      (then (local.set $f (f64.convert_i64_u (local.get $acc))))
      (else (if (local.get $k)
        (then
          (if (local.get $sticky) (then (local.set $acc (i64.or (local.get $acc) (i64.const 1)))))
          (local.set $f (f64.convert_i64_u (local.get $acc)))
          (local.set $e (i32.add (local.get $exp) (i32.const 1023)))
          (if (i32.ge_s (local.get $e) (i32.const 2047))
            (then (local.set $f (f64.const inf)))
            (else (local.set $f (f64.mul (local.get $f) (f64.reinterpret_i64 (i64.shl (i64.extend_i32_u (local.get $e)) (i64.const 52)))))))))))
    (if (result f64) (local.get $neg) (then (f64.neg (local.get $f))) (else (local.get $f))))`

  // __strws(c: i32) → i32 — ECMA StrWhiteSpace predicate. Covers TAB..CR, SP,
  // NBSP, BOM, LS/PS, and every Unicode Space_Separator. U+180E is *not*
  // whitespace (declassified in Unicode 6.3).
  ctx.core.stdlib['__strws'] = `(func $__strws (param $c i32) (result i32)
    (i32.or
      (i32.or
        (i32.and (i32.ge_s (local.get $c) (i32.const 9)) (i32.le_s (local.get $c) (i32.const 13)))
        (i32.or (i32.eq (local.get $c) (i32.const 32)) (i32.eq (local.get $c) (i32.const 160))))
      (i32.or
        (i32.or
          (i32.eq (local.get $c) (i32.const 0x1680))
          (i32.and (i32.ge_s (local.get $c) (i32.const 0x2000)) (i32.le_s (local.get $c) (i32.const 0x200a))))
        (i32.or
          (i32.or (i32.eq (local.get $c) (i32.const 0x2028)) (i32.eq (local.get $c) (i32.const 0x2029)))
          (i32.or
            (i32.or (i32.eq (local.get $c) (i32.const 0x202f)) (i32.eq (local.get $c) (i32.const 0x205f)))
            (i32.or (i32.eq (local.get $c) (i32.const 0x3000)) (i32.eq (local.get $c) (i32.const 0xfeff))))))))`

  // Every ECMAScript whitespace character occupies one UTF-16 unit.
  ctx.core.stdlib['__skipws'] = `(func $__skipws (param $v i64) (param $i i32) (param $len i32) (result i32)
    (local $sbase i32)
    ${SBASE_INIT}
    (block $done (loop $l
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (br_if $done (i32.eqz (call $__strws ${chAt('(local.get $i)')})))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (local.get $i))`

  ctx.core.stdlib['__to_num'] = `(func $__to_num (param $v i64) (result f64)
    (local $t i32) (local $len i32) (local $i i32) (local $c i32) (local $neg i32)
    (local $seen i32) (local $exp i32) (local $expNeg i32) (local $expDigits i32)
    (local $dot i32) (local $sigDigits i32) (local $decExp i32) (local $dropped i32) (local $round i32)
    (local $radix i32) (local $digit i32) (local $sbase i32)
    (local $result f64) (local $f f64) (local $mant i64)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    ;; RepresentationPlan boxes every BigInt that reaches a dynamic ToNumber
    ;; edge. Every non-NaN raw f64 here is therefore a genuine Number,
    ;; including subnormals; PTR.BIGINT is handled by the tagged arm below.
    (if (f64.eq (local.get $f) (local.get $f)) (then (return (local.get $f))))
    (if (i64.eq (local.get $v) (i64.const ${NULL_NAN})) (then (return (f64.const 0))))
    (if (i64.eq (local.get $v) (i64.const ${UNDEF_NAN})) (then (return (f64.const nan))))
    (if (i64.eq (local.get $v) (i64.const ${FALSE_NAN})) (then (return (f64.const 0))))
    (if (i64.eq (local.get $v) (i64.const ${TRUE_NAN})) (then (return (f64.const 1))))
    (local.set $t (call $__ptr_type (local.get $v)))
    ;; ToNumber(Symbol) is a TypeError. A Symbol is an ATOM (type 0) with a user
    ;; atom-id (>= 16); null/undefined returned above, and a bare NaN carries
    ;; aux 0, so type==0 && aux>=16 uniquely identifies a Symbol.
    (if (i32.and (i32.eqz (local.get $t))
                 (i32.ge_u (call $__ptr_aux (local.get $v)) (i32.const 16)))
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.SYMBOL_TO_NUMBER}))) (throw $__jz_err (f64.const ${ERR.SYMBOL_TO_NUMBER}))))
    ;; Dynamic BigInt is always tagged; ToNumber reads its mathematical i64
    ;; payload. Raw BigInt is confined to statically-proven paths.
    (if (i32.eq (local.get $t) (i32.const ${PTR.BIGINT}))
      (then (return (f64.convert_i64_s (i64.load (call $__ptr_offset (local.get $v)))))))
    ;; Non-string values go through ToString per JS spec, then re-check the
    ;; type in case ToString itself returned a non-string sentinel.
    (if (i32.ne (local.get $t) (i32.const ${PTR.STRING}))
      (then
        (local.set $v (call $__to_str (local.get $v)))
        (local.set $t (call $__ptr_type (local.get $v)))
        (if (i32.ne (local.get $t) (i32.const ${PTR.STRING}))
          (then (return (f64.const nan))))))
    (local.set $len (call $__str_length (local.get $v)))
    ${SBASE_INIT}
    ;; Trim leading whitespace. An empty / all-whitespace string is +0.
    (local.set $i (call $__skipws (local.get $v) (i32.const 0) (local.get $len)))
    (if (i32.ge_s (local.get $i) (local.get $len)) (then (return (f64.const 0))))
    ;; NonDecimalIntegerLiteral (0x / 0o / 0b). Per the grammar no sign may
    ;; precede the prefix, so it is matched before sign consumption.
    (if (i32.and
      (i32.lt_s (i32.add (local.get $i) (i32.const 1)) (local.get $len))
      (i32.eq ${chAt('(local.get $i)')} (i32.const 48)))
      (then
        (local.set $c ${chAt('(i32.add (local.get $i) (i32.const 1))')})
        (if (i32.or (i32.eq (local.get $c) (i32.const 120)) (i32.eq (local.get $c) (i32.const 88)))
          (then (local.set $radix (i32.const 16))))
        (if (i32.or (i32.eq (local.get $c) (i32.const 111)) (i32.eq (local.get $c) (i32.const 79)))
          (then (local.set $radix (i32.const 8))))
        (if (i32.or (i32.eq (local.get $c) (i32.const 98)) (i32.eq (local.get $c) (i32.const 66)))
          (then (local.set $radix (i32.const 2))))))
    (if (local.get $radix)
      (then
        (local.set $i (i32.add (local.get $i) (i32.const 2)))
        (block $ndDone (loop $ndLoop
          (br_if $ndDone (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $c ${chAt('(local.get $i)')})
          ;; Decode digit; 99 sentinel for any non-[0-9a-fA-F] char so the
          ;; unsigned ">= radix" test rejects it and any out-of-base digit.
          (local.set $digit
            (if (result i32) (i32.and (i32.ge_s (local.get $c) (i32.const 48)) (i32.le_s (local.get $c) (i32.const 57)))
              (then (i32.sub (local.get $c) (i32.const 48)))
              (else (if (result i32) (i32.and (i32.ge_s (local.get $c) (i32.const 97)) (i32.le_s (local.get $c) (i32.const 102)))
                (then (i32.sub (local.get $c) (i32.const 87)))
                (else (if (result i32) (i32.and (i32.ge_s (local.get $c) (i32.const 65)) (i32.le_s (local.get $c) (i32.const 70)))
                  (then (i32.sub (local.get $c) (i32.const 55)))
                  (else (i32.const 99))))))))
          (br_if $ndDone (i32.ge_u (local.get $digit) (local.get $radix)))
          (local.set $result (f64.add (f64.mul (local.get $result) (f64.convert_i32_s (local.get $radix))) (f64.convert_i32_s (local.get $digit))))
          (local.set $seen (i32.const 1))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ndLoop)))
        ;; No digits, or trailing non-whitespace ("0b1.0", "0xg") → NaN.
        (if (i32.eqz (local.get $seen)) (then (return (f64.const nan))))
        (local.set $i (call $__skipws (local.get $v) (local.get $i) (local.get $len)))
        (if (i32.lt_s (local.get $i) (local.get $len)) (then (return (f64.const nan))))
        (return (local.get $result))))
    ;; Sign (StrDecimalLiteral only).
    (if (i32.eq ${chAt('(local.get $i)')} (i32.const 45))
      (then (local.set $neg (i32.const 1)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    (if (i32.eq ${chAtSafe('(local.get $i)')} (i32.const 43))
      (then (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    ;; "Infinity" — the only non-numeric token ToNumber accepts. The 8 letters
    ;; are packed little-endian in one i64; any mismatch, short input, or
    ;; trailing non-whitespace makes the whole string NaN.
    (if (i32.eq ${chAtSafe('(local.get $i)')} (i32.const 73))
      (then
        (block $infBad
          (local.set $digit (i32.const 0))
          (loop $infl
            (if (i32.lt_s (local.get $digit) (i32.const 8))
              (then
                (br_if $infBad (i32.ge_s (i32.add (local.get $i) (local.get $digit)) (local.get $len)))
                (br_if $infBad (i32.ne
                  ${chAt('(i32.add (local.get $i) (local.get $digit))')}
                  (i32.and (i32.wrap_i64 (i64.shr_u (i64.const 0x7974696e69666e49)
                    (i64.extend_i32_u (i32.shl (local.get $digit) (i32.const 3))))) (i32.const 255))))
                (local.set $digit (i32.add (local.get $digit) (i32.const 1)))
                (br $infl))))
          (local.set $i (call $__skipws (local.get $v) (i32.add (local.get $i) (i32.const 8)) (local.get $len)))
          (br_if $infBad (i32.lt_s (local.get $i) (local.get $len)))
          (return (if (result f64) (local.get $neg) (then (f64.const -inf)) (else (f64.const inf)))))
        (return (f64.const nan))))
    ;; Decimal significand. Keep 18 significant decimal digits, track the
    ;; base-10 exponent for skipped digits, and round once before pow10 scaling.
    ${DEC_SIGNIFICAND}
    ;; Scientific notation. 'e'/'E' commits to an ExponentPart — at least one
    ;; digit must follow ("1e", "5e+" are NaN).
    ${sciExponent(`(if (i32.eqz (local.get $expDigits)) (then (return (f64.const nan))))
        (if (local.get $expNeg)
          (then (local.set $decExp (i32.sub (local.get $decExp) (local.get $exp))))
          (else (local.set $decExp (i32.add (local.get $decExp) (local.get $exp)))))`)}
    ;; Reject trailing non-whitespace ("5px", numeric separators "1_0", …).
    (local.set $i (call $__skipws (local.get $v) (local.get $i) (local.get $len)))
    (if (i32.lt_s (local.get $i) (local.get $len)) (then (return (f64.const nan))))
    ;; Eisel-Lemire exact rounding; fallback to __pow10 for ambiguous cases.
    ${EL_SCALE}
    (local.get $result))`

  // NumberToBigInt: a RangeError unless n is an integral Number — finite and
  // equal to its own truncation. NaN fails the f64.eq integrality test;
  // ±Infinity fails the finite test. Non-integers (1.1, .5, …) fail integrality.
  // The throw rides $__jz_err so `assert.throws`/try-catch observe it.
  ctx.core.stdlib['__num_to_bigint'] = `(func $__num_to_bigint (param $n f64) (result f64)
    (if (i32.eqz (i32.and
          (f64.eq (local.get $n) (f64.trunc (local.get $n)))
          (f64.lt (f64.abs (local.get $n)) (f64.const inf))))
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.NUMBER_TO_BIGINT_RANGE}))) (throw $__jz_err (f64.const ${ERR.NUMBER_TO_BIGINT_RANGE}))))
    (f64.reinterpret_i64 (i64.trunc_sat_f64_s (local.get $n))))`

  // StringToBigInt (ES2024 7.1.14): the whole trimmed string must be a single
  // integer literal. Returns the payload and a status: 0 for a parse, else the
  // error code the caller reports (BigInt(s) throws it as a SyntaxError; loose
  // `==` treats the undefined result as unequal). Unlike parseInt this does
  // NOT stop at the first bad char: "10n" and "000 12" fail. Empty or all-
  // whitespace strings parse to 0n. Radix prefixes 0b/0o/0x (case-insensitive)
  // are recognised only when no sign precedes them, so `-0x1` surfaces its `x`
  // as an invalid decimal digit, as the spec wants. (jz's BigInt is i64-
  // backed, so values past 2^63 wrap.)
  ctx.core.stdlib['__str_to_bigint'] = `(func $__str_to_bigint (param $v i64) (result i64 i32)
    (local $len i32) (local $i i32) (local $end i32) (local $c i32)
    (local $neg i32) (local $sign i32) (local $radix i32) (local $digit i32)
    (local $seen i32) (local $result i64)
    (local.set $len (call $__str_length (local.get $v)))
    (local.set $end (local.get $len))
    ;; Trim leading whitespace (any byte <= 32).
    (block $ws (loop $wsl
      (br_if $ws (i32.ge_s (local.get $i) (local.get $end)))
      (br_if $ws (i32.gt_s (call $__char_at (local.get $v) (local.get $i)) (i32.const 32)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $wsl)))
    ;; Trim trailing whitespace.
    (block $te (loop $tel
      (br_if $te (i32.le_s (local.get $end) (local.get $i)))
      (br_if $te (i32.gt_s (call $__char_at (local.get $v) (i32.sub (local.get $end) (i32.const 1))) (i32.const 32)))
      (local.set $end (i32.sub (local.get $end) (i32.const 1)))
      (br $tel)))
    ;; Empty / all-whitespace string → 0n.
    (if (i32.ge_s (local.get $i) (local.get $end))
      (then (return (i64.const 0) (i32.const 0))))
    ;; Optional single leading sign — decimal literals only.
    (local.set $c (call $__char_at (local.get $v) (local.get $i)))
    (if (i32.eq (local.get $c) (i32.const 45))
      (then (local.set $neg (i32.const 1)) (local.set $sign (i32.const 1)) (local.set $i (i32.add (local.get $i) (i32.const 1))))
      (else (if (i32.eq (local.get $c) (i32.const 43))
        (then (local.set $sign (i32.const 1)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))))
    (local.set $radix (i32.const 10))
    ;; Radix prefix 0b/0o/0x (case-insensitive) — not allowed after a sign.
    (if (i32.and (i32.eqz (local.get $sign))
          (i32.and (i32.lt_s (i32.add (local.get $i) (i32.const 1)) (local.get $end))
                   (i32.eq (call $__char_at (local.get $v) (local.get $i)) (i32.const 48))))
      (then
        (local.set $c (i32.or (call $__char_at (local.get $v) (i32.add (local.get $i) (i32.const 1))) (i32.const 0x20)))
        (if (i32.eq (local.get $c) (i32.const 98)) (then (local.set $radix (i32.const 2))))
        (if (i32.eq (local.get $c) (i32.const 111)) (then (local.set $radix (i32.const 8))))
        (if (i32.eq (local.get $c) (i32.const 120)) (then (local.set $radix (i32.const 16))))
        (if (i32.ne (local.get $radix) (i32.const 10))
          (then (local.set $i (i32.add (local.get $i) (i32.const 2)))))))
    ;; Strict scan — every remaining char must be a valid radix digit.
    (block $done (loop $lp
      (br_if $done (i32.ge_s (local.get $i) (local.get $end)))
      (local.set $c (call $__char_at (local.get $v) (local.get $i)))
      (local.set $digit (i32.const -1))
      (if (i32.and (i32.ge_s (local.get $c) (i32.const 48)) (i32.le_s (local.get $c) (i32.const 57)))
        (then (local.set $digit (i32.sub (local.get $c) (i32.const 48)))))
      (if (i32.and (i32.ge_s (local.get $c) (i32.const 97)) (i32.le_s (local.get $c) (i32.const 122)))
        (then (local.set $digit (i32.sub (local.get $c) (i32.const 87)))))
      (if (i32.and (i32.ge_s (local.get $c) (i32.const 65)) (i32.le_s (local.get $c) (i32.const 90)))
        (then (local.set $digit (i32.sub (local.get $c) (i32.const 55)))))
      (if (i32.or (i32.lt_s (local.get $digit) (i32.const 0)) (i32.ge_s (local.get $digit) (local.get $radix)))
        (then (return (i64.const 0) (i32.const ${ERR.BIGINT_PARSE_DIGIT}))))
      (local.set $seen (i32.const 1))
      (local.set $result
        (i64.add
          (i64.mul (local.get $result) (i64.extend_i32_s (local.get $radix)))
          (i64.extend_i32_s (local.get $digit))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    ;; A sign or radix prefix with no digits ("-", "0x", "0b") is a SyntaxError.
    (if (i32.eqz (local.get $seen)) (then (return (i64.const 0) (i32.const ${ERR.BIGINT_PARSE_EMPTY}))))
    (if (result i64) (local.get $neg)
      (then (i64.sub (i64.const 0) (local.get $result)))
      (else (local.get $result)))
    (i32.const 0))`

  // ToBigInt (ES2024 7.1.13) for `BigInt(x)`: a Number must be integral, a
  // boxed BigInt is the identity, a boolean is 0n or 1n, a string parses
  // through StringToBigInt (a failed parse is a SyntaxError, $__jz_err), null
  // and undefined are a TypeError.
  ctx.core.stdlib['__to_bigint'] = `(func $__to_bigint (param $v i64) (result f64)
    (local $t i32) (local $status i32) (local $result i64) (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (f64.eq (local.get $f) (local.get $f))
      (then (return (call $__num_to_bigint (local.get $f)))))
    (local.set $t (call $__ptr_type (local.get $v)))
    ;; ToBigInt(bigint) is the identity (ES2024 21.2.1.1 step 2b via BigInt()'s
    ;; own ToPrimitive+dispatch) — mirrors __to_num's identical PTR.BIGINT arm
    ;; a few lines above it in this same file: a genuine boxed BigInt crossing
    ;; here (phase-c C4b: an exported param feeding BigInt(x) now gets
    ;; host-tag ingress evidence, so a plain host bigint arrives boxed)
    ;; dereferences its own payload cell directly instead of falling through
    ;; to the "not a string" zero fallback below, which pre-dates any caller
    ;; ever being able to deliver a boxed BigInt here.
    (if (i32.eq (local.get $t) (i32.const ${PTR.BIGINT}))
      (then (return (f64.reinterpret_i64 (i64.load (call $__ptr_offset (local.get $v)))))))
    (if (i32.or (i64.eq (local.get $v) (i64.const ${NULL_NAN})) (i64.eq (local.get $v) (i64.const ${UNDEF_NAN})))
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.const ${ERR.BIGINT_NULLISH}))) (throw $__jz_err (f64.const ${ERR.BIGINT_NULLISH}))))
    (if (i64.eq (local.get $v) (i64.const ${TRUE_NAN})) (then (return (f64.reinterpret_i64 (i64.const 1)))))
    (if (i64.eq (local.get $v) (i64.const ${FALSE_NAN})) (then (return (f64.reinterpret_i64 (i64.const 0)))))
    (if (i32.ne (local.get $t) (i32.const ${PTR.STRING}))
      (then (return (f64.reinterpret_i64 (i64.const 0)))))
    (call $__str_to_bigint (local.get $v))
    (local.set $status)
    (local.set $result)
    (if (local.get $status)
      (then (global.set $__jz_last_err_bits (i64.reinterpret_f64 (f64.convert_i32_s (local.get $status))))
        (throw $__jz_err (f64.convert_i32_s (local.get $status)))))
    (f64.reinterpret_i64 (local.get $result)))`

  // IsLooselyEqual (ES2024 7.2.14) with a BigInt on one side, its payload
  // `b`: a Number compares mathematically (step 14; NaN and the infinities
  // are equal to nothing), a boolean as its ToNumber (steps 10-11), a string
  // through StringToBigInt (step 8; no parse, no equality), a boxed BigInt by
  // content, everything else (null, undefined, a heap kind) is unequal.
  // __bigint_eq is the dynamic form the static lowering reaches for a
  // partner it cannot kind; $__eq (module/core.js) takes it for a box it
  // meets beside another tag.
  ctx.core.stdlib['__bigint_eq_num'] = `(func $__bigint_eq_num (param $b i64) (param $n f64) (result i32)
    ;; Integral and inside the i64 range: its truncation is exact, and the
    ;; payload converted back must give the same f64 (a payload past 2^53 that
    ;; only rounds to n is unequal). The range test rejects NaN and ±Infinity.
    (i32.and
      (i32.and
        (f64.ge (local.get $n) (f64.const -9223372036854775808))
        (f64.lt (local.get $n) (f64.const 9223372036854775808)))
      (i32.and
        (i64.eq (local.get $b) (i64.trunc_sat_f64_s (local.get $n)))
        (f64.eq (f64.convert_i64_s (local.get $b)) (local.get $n)))))`

  ctx.core.stdlib['__bigint_eq_str'] = `(func $__bigint_eq_str (param $b i64) (param $s i64) (result i32)
    (local $status i32) (local $result i64)
    (call $__str_to_bigint (local.get $s))
    (local.set $status)
    (local.set $result)
    (i32.and (i32.eqz (local.get $status)) (i64.eq (local.get $b) (local.get $result))))`

  ctx.core.stdlib['__bigint_eq'] = `(func $__bigint_eq (param $b i64) (param $v i64) (result i32)
    (local $f f64) (local $t i32)
    ;; Identical bits are equal, as in $__eq: a carrier the lowering could not
    ;; kind may hold a raw BigInt (an Array.from of a BigInt64Array keeps the
    ;; element bits), whose payload is the value itself.
    (if (i64.eq (local.get $b) (local.get $v)) (then (return (i32.const 1))))
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (f64.eq (local.get $f) (local.get $f))
      (then (return (call $__bigint_eq_num (local.get $b) (local.get $f)))))
    (if (i64.eq (local.get $v) (i64.const ${TRUE_NAN})) (then (return (i64.eq (local.get $b) (i64.const 1)))))
    (if (i64.eq (local.get $v) (i64.const ${FALSE_NAN})) (then (return (i64.eqz (local.get $b)))))
    (local.set $t (call $__ptr_type (local.get $v)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.BIGINT}))
      (then (return (i64.eq (local.get $b) (i64.load (call $__ptr_offset (local.get $v)))))))
    (if (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
      (then (return (call $__bigint_eq_str (local.get $b) (local.get $v)))))
    (i32.const 0))`

  ctx.core.stdlib['__parseFloat'] = `(func $__parseFloat (param $v i64) (result f64)
    (local $t i32) (local $len i32) (local $i i32) (local $c i32) (local $neg i32)
    (local $seen i32) (local $exp i32) (local $expNeg i32) (local $expDigits i32)
    (local $dot i32) (local $sigDigits i32) (local $decExp i32) (local $dropped i32) (local $round i32)
    (local $result f64) (local $f f64) (local $mant i64) (local $sbase i32)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (f64.eq (local.get $f) (local.get $f)) (then (return (local.get $f))))
    (local.set $t (call $__ptr_type (local.get $v)))
    ;; parseFloat first applies ToString, then parses the longest decimal prefix.
    ;; Unlike Number(), empty strings and non-decimal prefixes produce NaN/0
    ;; according to the consumed prefix rather than whole-string numeric coercion.
    (if (i32.ne (local.get $t) (i32.const ${PTR.STRING}))
      (then
        (local.set $v (call $__to_str (local.get $v)))
        (local.set $t (call $__ptr_type (local.get $v)))
        (if (i32.ne (local.get $t) (i32.const ${PTR.STRING}))
          (then (return (f64.const nan))))))
    (local.set $len (call $__str_length (local.get $v)))
    ${SBASE_INIT}
    ;; Skip leading StrWhiteSpace (UTF-16 units: NBSP, LS/PS, Zs — not just ASCII).
    (local.set $i (call $__skipws (local.get $v) (i32.const 0) (local.get $len)))
    ;; Sign.
    (if (i32.eq ${chAtSafe('(local.get $i)')} (i32.const 45))
      (then (local.set $neg (i32.const 1)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    (if (i32.eq ${chAtSafe('(local.get $i)')} (i32.const 43))
      (then (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    ;; Decimal significand. Keep 18 significant decimal digits, track the
    ;; base-10 exponent for skipped digits, and round once before pow10 scaling.
    ${DEC_SIGNIFICAND}
    ;; Scientific notation.
    ${sciExponent(`(if (local.get $expDigits)
          (then
            (if (local.get $expNeg)
              (then (local.set $decExp (i32.sub (local.get $decExp) (local.get $exp))))
              (else (local.set $decExp (i32.add (local.get $decExp) (local.get $exp)))))))`)}
    ;; Eisel-Lemire exact rounding; fallback to __pow10 for ambiguous cases.
    ${EL_SCALE}
    (local.get $result))`

  // A statically OBJECT-typed argument needs ToPrimitive (try valueOf, then
  // toString) before parseInt/parseFloat can treat it as a string — jz's
  // object model has no general dynamic-dispatch machinery to call an
  // arbitrary (possibly user-defined) valueOf/toString method and re-enter
  // ToPrimitive on its result, so this can't silently fall through to
  // treating the object's raw bits as a string pointer (confirmed live:
  // parseInt({valueOf:()=>"42"}) returned null, not 42 — the coercion was
  // skipped, not differently rounded). Reject; string/number/boolean/array
  // arguments are unaffected and keep their existing (correct) handling.
  // valTypeOf(x) used to MISS this once the enclosing function also
  // contained a try/catch anywhere (even unrelated, even textually after
  // this call) — test262 built-ins/parseInt/S15.1.2.2_A1_T7.js, which has
  // exactly this shape (`var object = {valueOf:…}` reassigned again inside a
  // LATER try/catch elsewhere in the function), slipped the object through
  // uncoerced. Root-caused and fixed in emit.js (fix/wrong-values-3):
  // valTypeOf itself was never the bug — the flow-sensitive overlay it reads
  // (ctx.func.localValTypesOverlay, "tier #2") was blocked from EVER
  // recording a fact for `object` ANYWHERE in the function, by a whole-block
  // veto (setFlowVal/nestedWritesOf) that didn't distinguish "reassigned
  // later, at a nested position" from "reassigned later, INSIDE A LOOP" —
  // only the second actually needs a blanket veto (a loop's static body runs
  // dynamically many times); the first only needs to stop trusting the fact
  // FROM THE REASSIGNMENT POINT FORWARD, not retroactively for every read
  // that already dominates it. ctx.schema.slotOf tracks an object literal's
  // OWN property schema independently of that flow-sensitive valType
  // inference (the same resolution src/ir.js's primMethodIdx already relies
  // on for toPrimitiveChain), so this still checks it directly too rather
  // than trusting valTypeOf as the sole signal — a second, structural proof
  // for whatever valTypeOf still can't reach (e.g. a name never assigned an
  // object-shaped RHS in THIS function at all, only received boxed through a
  // dynamic path).
  const rejectObjectArg = (x, who) => {
    const objType = valTypeOf(x) === VAL.OBJECT
    const hasToPrimitiveMethod = typeof x === 'string' && ctx.schema?.slotOf &&
      (ctx.schema.slotOf(x, 'valueOf') >= 0 || ctx.schema.slotOf(x, 'toString') >= 0)
    if (objType || hasToPrimitiveMethod)
      err(`${who}: an object argument (with valueOf/toString) is not supported — jz has no general ToPrimitive dynamic dispatch; call .valueOf()/.toString() (or String()/Number()) yourself before passing the result`)
  }

  // ToString(arg) for the string-input builtins. A statically-known boolean must
  // render as "true"/"false" (spec step 1: ToString) before parsing — otherwise
  // its 0/1 carrier bits are fed to the parser as if a string pointer. Other types
  // (string already, number/object ToPrimitive) stay out of scope per the runner.
  const strInputI64 = (x) => valTypeOf(x) === VAL.BOOL ? asI64(bool(x)) : asI64(emit(x))

  // Native for EVERY host (formerly host-imported off-wasi): the wasm-side
  // parsers are exact (u64 round-once accumulation / Eisel-Lemire), while a
  // host round-trip re-decodes the string box in the embedder — the bench
  // runner's decoder mishandled SSO lanes and slice views, silently corrupting
  // watr's parseInt(hex) calls. Self-contained also means browsers/shells
  // need no env.parseInt/parseFloat import at all.
  ctx.core.emit['Number.parseInt'] = (x, radix) => {
    inc('__parseInt')
    rejectObjectArg(x, 'parseInt')
    rejectObjectArg(radix, 'parseInt')
    const radixIR = radix == null ? ['i32.const', 0] : toI32(toNumF64(radix, emit(radix)))
    return typed(['call', '$__parseInt', strInputI64(x), radixIR], 'f64')
  }
  ctx.core.emit['parseInt'] = ctx.core.emit['Number.parseInt']

  ctx.core.emit['Number.parseFloat'] = (x) => {
    inc('__parseFloat')
    rejectObjectArg(x, 'parseFloat')
    return typed(['call', '$__parseFloat', strInputI64(x)], 'f64')
  }
  ctx.core.emit['parseFloat'] = ctx.core.emit['Number.parseFloat']

  // Boolean(x) → truthiness (non-zero → 1, zero → 0)
  reg('Boolean', ['__is_truthy'], (x) => {
    if (x === undefined) return typed(['f64.const', 0], 'f64')
    // Via truthyIR so a NUMBER arg gets the NaN-safe f64 test (Boolean(0/0) === false
    // on every platform); other types fall to __is_truthy inside truthyIR.
    return typed(['f64.convert_i32_s', truthyIR(emit(x))], 'f64')
  })

  // === Instance method emitters ===

  const ftoaDefault = (v) => typed(['call', '$__ftoa', v, ['i32.const', 0], ['i32.const', 0]], 'f64')
  reg('.number:toString', ['__ftoa', '__num_radix'], (n, radix) => {
    const v = asF64(emit(n))
    if (radix == null) return ftoaDefault(v)
    const rv = emit(radix)
    // Constant radix folds the 10-vs-other choice at compile time; radix 10 keeps
    // __ftoa's shortest-repr (the radix loop would emit float-noise tail digits).
    if (Array.isArray(rv) && rv[0] === 'f64.const' && typeof rv[1] === 'number')
      return rv[1] === 10 ? ftoaDefault(v) : typed(['call', '$__num_radix', v, ['i32.const', rv[1] | 0]], 'f64')
    const vt = temp('rv'), rt = tempI32('rr')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${vt}`, v],
      ['local.set', `$${rt}`, asI32(rv)],
      ['if', ['result', 'f64'], ['i32.eq', ['local.get', `$${rt}`], ['i32.const', 10]],
        ['then', ftoaDefault(['local.get', `$${vt}`])],
        ['else', ['call', '$__num_radix', ['local.get', `$${vt}`], ['local.get', `$${rt}`]]]]], 'f64')
  })

  // BigInt.prototype.toString(radix) — i64-exact, default radix 10.
  reg('.bigint:toString', ['__radix_str'], (n, radix) =>
    typed(['call', '$__radix_str', readI64(n, emit(n)), radix == null ? ['i32.const', 10] : asI32(emit(radix))], 'f64'))

  reg('.number:toFixed', ['__ftoa'], (n, d) =>
    typed(['call', '$__ftoa', asF64(emit(n)), asI32(emit(d || [, 0])), ['i32.const', 1]], 'f64'))

  reg('.number:toExponential', ['__toExp'], (n, d) =>
    typed(['call', '$__toExp', asF64(emit(n)), asI32(emit(d || [, 0])), ['i32.const', 0]], 'f64'))

  reg('.number:toPrecision', ['__ftoa', '__toExp'], (n, p) => {
    const val = temp('pv'), t = temp('tp'), exp = tempI32('te'), pr = tempI32('pp')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${val}`, asF64(emit(n))],
      ['local.set', `$${pr}`, asI32(emit(p))],
      ['local.set', `$${t}`, ['f64.abs', ['local.get', `$${val}`]]],
      ['local.set', `$${exp}`, ['i32.const', 0]],
      ['if', ['f64.gt', ['local.get', `$${t}`], ['f64.const', 0]],
        ['then',
          ['block', '$d1', ['loop', '$l1',
            ['br_if', '$d1', ['f64.lt', ['local.get', `$${t}`], ['f64.const', 10]]],
            ['local.set', `$${t}`, ['f64.div', ['local.get', `$${t}`], ['f64.const', 10]]],
            ['local.set', `$${exp}`, ['i32.add', ['local.get', `$${exp}`], ['i32.const', 1]]],
            ['br', '$l1']]],
          ['block', '$d2', ['loop', '$l2',
            ['br_if', '$d2', ['f64.ge', ['local.get', `$${t}`], ['f64.const', 1]]],
            ['local.set', `$${t}`, ['f64.mul', ['local.get', `$${t}`], ['f64.const', 10]]],
            ['local.set', `$${exp}`, ['i32.sub', ['local.get', `$${exp}`], ['i32.const', 1]]],
            ['br', '$l2']]]]],
      ['if', ['result', 'f64'],
        ['i32.or',
          ['i32.lt_s', ['local.get', `$${exp}`], ['i32.const', -6]],
          ['i32.ge_s', ['local.get', `$${exp}`], ['local.get', `$${pr}`]]],
        ['then', ['call', '$__toExp', ['local.get', `$${val}`], ['i32.sub', ['local.get', `$${pr}`], ['i32.const', 1]], ['i32.const', 0]]],
        ['else', ['call', '$__ftoa', ['local.get', `$${val}`],
          ['i32.sub', ['i32.sub', ['local.get', `$${pr}`], ['i32.const', 1]], ['local.get', `$${exp}`]],
          ['i32.const', 1]]]]], 'f64')
  })

  // Number(x) — identity for numbers, i64→f64 conversion for BigInt
  ctx.core.emit['Number'] = (x) => {
    if (x === undefined) return typed(['f64.const', 0], 'f64')
    // A BigInt by its valType, or by the representation plan (a reassigned raw
    // parameter's valType is unknown to the body; its bits are still an i64).
    if (valTypeOf(x) === VAL.BIGINT || isPlanRawBigint(x))
      return typed(['f64.convert_i64_s', readI64(x, emit(x))], 'f64')
    return toNumF64(x, emit(x))
  }

  // BigInt(x) — f64→i64 conversion (reinterpret as BigInt-as-f64).
  // For number input: truncate directly. For string / unknown: first coerce via __to_num
  // (handles both decimal and hex string parse), then truncate.
  ctx.core.emit['BigInt'] = (x) => {
    // Every BigInt() path can fault: a non-integral Number is a RangeError and
    // a malformed String is a SyntaxError, both raised via $__jz_err.
    ctx.runtime.throws = true
    const vt = valTypeOf(x)
    if (vt === VAL.BIGINT) {
      if (typeof x === 'bigint' || (typeof x === 'string' && !isReassigned(ctx.func.body, x))) return emit(x)
      inc('__to_bigint', '__ptr_type')
      const t = temp('bi')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, asF64(emit(x))],
        ['if', ['result', 'f64'], ['f64.eq', ['local.get', `$${t}`], ['local.get', `$${t}`]],
          ['then', ['f64.reinterpret_i64', ['i64.trunc_sat_f64_s', ['local.get', `$${t}`]]]],
          ['else', ['if', ['result', 'f64'],
            ptrTypeEq(['local.get', `$${t}`], PTR.STRING),
            ['then', ['call', '$__to_bigint', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
            ['else', ['local.get', `$${t}`]]]]]], 'f64')
    }
    if (vt === VAL.NUMBER) {
      inc('__num_to_bigint')
      return typed(['call', '$__num_to_bigint', asF64(emit(x))], 'f64')
    }
    inc('__to_bigint')
    return typed(['call', '$__to_bigint', asI64(emit(x))], 'f64')
  }

  // BigInt.asIntN(bits, bigint) — truncate to signed N-bit
  ctx.core.emit['BigInt.asIntN'] = (bits, val) => {
    const vbits = asI32(emit(bits)), vval = readI64(val, emit(val))
    // (val << (64 - bits)) >> (64 - bits)  — arithmetic shift for sign extension
    const shift = typed(['i64.sub', ['i64.const', 64], ['i64.extend_i32_s', vbits]], 'i64')
    const t = tempI64('bi')
    return typed(['f64.reinterpret_i64', ['block', ['result', 'i64'],
      ['local.set', `$${t}`, shift],
      ['i64.shr_s', ['i64.shl', vval, ['local.get', `$${t}`]], ['local.get', `$${t}`]]]], 'f64')
  }

  // BigInt.asUintN(bits, bigint) — truncate to unsigned N-bit.
  // (val << (64 - bits)) >>> (64 - bits) — logical shift zero-extends the low `bits`.
  // The naive `val & ((1 << bits) - 1)` mask is wrong at bits=64: i64.shl shifts mod 64,
  // so `1 << 64` is `1 << 0 = 1`, making the mask `0` and asUintN(64,·) collapse to 0 —
  // which also zeroed every bigint *literal* (emit reinterprets `Nn` via
  // BigInt.asUintN(64,·).toString() through this very handler in the self-compile).
  ctx.core.emit['BigInt.asUintN'] = (bits, val) => {
    const vbits = asI32(emit(bits)), vval = readI64(val, emit(val))
    const shift = typed(['i64.sub', ['i64.const', 64], ['i64.extend_i32_s', vbits]], 'i64')
    const t = tempI64('bu')
    return typed(['f64.reinterpret_i64', ['block', ['result', 'i64'],
      ['local.set', `$${t}`, shift],
      ['i64.shr_u', ['i64.shl', vval, ['local.get', `$${t}`]], ['local.get', `$${t}`]]]], 'f64')
  }
}
