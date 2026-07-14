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

import { typed, asF64, asI32, asI64, toI32, toNumF64, NULL_NAN, UNDEF_NAN, FALSE_NAN, TRUE_NAN, temp, tempI32, tempI64, ptrTypeEq, truthyIR } from '../src/ir.js'
import { ssoBitI64Hex, ptrNanHex } from '../layout.js'
import { emit, bool, deps, reg } from '../src/bridge.js'
import { isReassigned } from '../src/ast.js'
import { valTypeOf } from '../src/kind.js'
import { VAL } from '../src/reps.js'
import { inc, PTR, LAYOUT, declGlobal } from '../src/ctx.js'

// ─── Shared decimal-number parsing fragments ────────────────────────────────
// `__to_num` (Number coercion) and `__parseFloat` both scan a StrDecimalLiteral
// significand + ExponentPart, and that scan was verbatim-identical between them
// — a "fix the same bug twice" hazard (commit 652ba5f patched both copies).
// These named fragments are the common core, spliced into both bodies; the
// produced WASM is unchanged, the source now has one place to fix.
// Required locals (every consumer declares them):
//   $v i64 · $i $len $c $dot $seen $sigDigits $decExp $dropped $round
//   $exp $expNeg $expDigits $sbase i32 · $mant i64 · $result f64

// In-bounds byte read for a confirmed string `$v`. `__char_at` is ~95 WASM
// instructions — too large for V8 to inline — so a scan that calls it per
// char pays a real call plus a redundant SSO/view/bounds dispatch every step.
// A non-SSO string (the common case: source slices, heap strings) keeps its
// bytes contiguous at `$v & 0xFFFFFFFF` (`$sbase`); the read collapses to one
// `i32.load8_u`. The SSO test is loop-invariant — V8 hoists it — and the SSO
// arm still routes through `__char_at` (its bytes are packed in the pointer).
// Callers MUST declare `$sbase i32`, set it once after `$v` is final and a
// confirmed string, and only pass indices proven `< $len` (`__char_at` would
// otherwise return its OOB 0; the inline load has no such guard).
const SSO_BIT_I64 = ssoBitI64Hex()
const SBASE_INIT = '(local.set $sbase (i32.wrap_i64 (i64.and (local.get $v) (i64.const 4294967295))))'

/** In-place byte reversal of buf[i..j] (WAT fragment). __itoa/__radix_str emit the
 *  least-significant digit first, then flip the run. Caller pre-sets `j` to the last
 *  index and leaves `i` at 0; `tmp` is scratch. Labels $rev/$revl are block-local. */
const reverseBytesWat = (buf = '$buf', i = '$i', j = '$j', tmp = '$tmp') =>
  `(block $rev (loop $revl
      (br_if $rev (i32.ge_s (local.get ${i}) (local.get ${j})))
      (local.set ${tmp} (i32.load8_u (i32.add (local.get ${buf}) (local.get ${i}))))
      (i32.store8 (i32.add (local.get ${buf}) (local.get ${i})) (i32.load8_u (i32.add (local.get ${buf}) (local.get ${j}))))
      (i32.store8 (i32.add (local.get ${buf}) (local.get ${j})) (local.get ${tmp}))
      (local.set ${i} (i32.add (local.get ${i}) (i32.const 1)))
      (local.set ${j} (i32.sub (local.get ${j}) (i32.const 1)))
      (br $revl)))`
const chAt = idx => `(if (result i32)
        (i64.eqz (i64.and (local.get $v) (i64.const ${SSO_BIT_I64})))
        (then (i32.load8_u (i32.add (local.get $sbase) ${idx})))
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
const DEC_SIGNIFICAND = `
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
const sciExponent = (tail) => `
    (local.set $c ${chAtSafe('(local.get $i)')})
    (if (i32.or
        (i32.eq (local.get $c) (i32.const 101))
        (i32.eq (local.get $c) (i32.const 69)))
      (then
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (if (i32.eq ${chAtSafe('(local.get $i)')} (i32.const 45))
          (then (local.set $expNeg (i32.const 1)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))
        (if (i32.eq ${chAtSafe('(local.get $i)')} (i32.const 43))
          (then (local.set $i (i32.add (local.get $i) (i32.const 1)))))
        (block $expDone (loop $expLoop
          (br_if $expDone (i32.ge_s (local.get $i) (local.get $len)))
          (local.set $c ${chAt('(local.get $i)')})
          (br_if $expDone
            (i32.or
              (i32.lt_s (local.get $c) (i32.const 48))
              (i32.gt_s (local.get $c) (i32.const 57))))
          (local.set $exp
            (i32.add
              (i32.mul (local.get $exp) (i32.const 10))
              (i32.sub (local.get $c) (i32.const 48))))
          (local.set $expDigits (i32.add (local.get $expDigits) (i32.const 1)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $expLoop)))
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
const EL_SCALE = `
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
// Reads 651-entry 128-bit power-of-ten table from global $__el_tbl (injected at compile time).
// Table layout: entry[i] = lo_i64_LE || hi_i64_LE, i = exp10 + 342.
//
// Algorithm: normalize mant to 64 bits, multiply by 128-bit table entry to get 128-bit
// product (prodHi:prodLo), extract 52-bit IEEE mantissa with correct rounding.
// Handles subnormals, overflow to Infinity, and early-exit for 0/trivial ranges.
const DEC_TO_F64_WAT = `(func $__dec_to_f64
    (param $mant i64) (param $exp10 i32)
    (result f64)
    (local $mBits i32)
    (local $w i64)
    (local $tbl i32)
    (local $tblHi i64) (local $tblLo i64)
    ;; 128-bit product: prodHi × 2^64 + prodLo
    (local $p1hi i64) (local $p1lo i64)
    (local $p2hi i64) (local $p2lo i64)
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
    ;; 32-bit limb temps for mul64
    (local $a0 i32) (local $a1 i32) (local $b0 i32) (local $b1 i32)
    (local $t00 i64) (local $t01 i64) (local $t10 i64) (local $t11 i64)
    (local $mid i64) (local $mid_carry i64)
    ;; Zero check
    (if (i64.eqz (local.get $mant)) (then (return (f64.const 0))))
    ;; Compute bit length of mant (1..64) by normalizing to 64 bits via clz
    ;; mBits = 64 - clz64(mant)
    (local.set $mBits (i32.sub (i32.const 64) (i32.wrap_i64 (i64.clz (local.get $mant)))))
    ;; Normalize mant to 64-bit: w = mant << (64 - mBits)
    (local.set $w (i64.shl (local.get $mant) (i64.extend_i32_u (i32.sub (i32.const 64) (local.get $mBits)))))
    ;; Full-range table: exp10 in [-342..308] — every finite/subnormal f64 decimal
    ;; parses correctly rounded (the trimmed [-65..65] table sent deep exponents to
    ;; the POW10_SCALE fallback, whose double rounding missed the subnormal boundary
    ;; by 1 ulp and whose 10^|e|>308 scale factor overflowed to Infinity, flushing
    ;; min-normal-adjacent literals to 0 — watr.wasm's float_literals leg). ~10.4KB
    ;; data on programs that pull __to_num; correctness owns the trade.
    (if (i32.or (i32.lt_s (local.get $exp10) (i32.const -342))
                (i32.gt_s (local.get $exp10) (i32.const 308)))
      (then (return (f64.const nan))))
    ;; Load 128-bit table entry for exp10:  tbl = $__el_tbl + (exp10 + 342) * 16
    (local.set $tbl (i32.add (global.get $__el_tbl) (i32.shl (i32.add (local.get $exp10) (i32.const 342)) (i32.const 4))))
    (local.set $tblLo (i64.load (local.get $tbl)))
    (local.set $tblHi (i64.load (i32.add (local.get $tbl) (i32.const 8))))
    ;; ─── Two-product: (prodHi:prodLo) = w × tblHi + (w × tblLo >> 64) ──────────
    ;; mul64(w, tblHi) → p1hi:p1lo
    ;; Split w into 32-bit halves
    (local.set $a0 (i32.wrap_i64 (i64.and (local.get $w) (i64.const 0xFFFFFFFF))))
    (local.set $a1 (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))))
    (local.set $b0 (i32.wrap_i64 (i64.and (local.get $tblHi) (i64.const 0xFFFFFFFF))))
    (local.set $b1 (i32.wrap_i64 (i64.shr_u (local.get $tblHi) (i64.const 32))))
    (local.set $t00 (i64.mul (i64.extend_i32_u (local.get $a0)) (i64.extend_i32_u (local.get $b0))))
    (local.set $t01 (i64.mul (i64.extend_i32_u (local.get $a0)) (i64.extend_i32_u (local.get $b1))))
    (local.set $t10 (i64.mul (i64.extend_i32_u (local.get $a1)) (i64.extend_i32_u (local.get $b0))))
    (local.set $t11 (i64.mul (i64.extend_i32_u (local.get $a1)) (i64.extend_i32_u (local.get $b1))))
    ;; mid = t01 + (t00>>32), track carry; then mid += t10, track carry
    ;; Each addition can carry at most 1 bit; total carry ≤ 2 → hi += carry<<32
    (local.set $mid (i64.add (local.get $t01) (i64.shr_u (local.get $t00) (i64.const 32))))
    (local.set $mid_carry (i64.extend_i32_u (i64.lt_u (local.get $mid) (local.get $t01))))
    (local.set $mid (i64.add (local.get $mid) (local.get $t10)))
    (local.set $mid_carry (i64.add (local.get $mid_carry)
      (i64.extend_i32_u (i64.lt_u (local.get $mid) (local.get $t10)))))
    (local.set $p1hi (i64.add
      (i64.add (local.get $t11) (i64.shr_u (local.get $mid) (i64.const 32)))
      (i64.shl (local.get $mid_carry) (i64.const 32))))
    (local.set $p1lo (i64.or
      (i64.and (local.get $t00) (i64.const 0xFFFFFFFF))
      (i64.shl (i64.and (local.get $mid) (i64.const 0xFFFFFFFF)) (i64.const 32))))
    ;; mul64(w, tblLo) → p2hi:p2lo
    (local.set $b0 (i32.wrap_i64 (i64.and (local.get $tblLo) (i64.const 0xFFFFFFFF))))
    (local.set $b1 (i32.wrap_i64 (i64.shr_u (local.get $tblLo) (i64.const 32))))
    (local.set $t00 (i64.mul (i64.extend_i32_u (local.get $a0)) (i64.extend_i32_u (local.get $b0))))
    (local.set $t01 (i64.mul (i64.extend_i32_u (local.get $a0)) (i64.extend_i32_u (local.get $b1))))
    (local.set $t10 (i64.mul (i64.extend_i32_u (local.get $a1)) (i64.extend_i32_u (local.get $b0))))
    (local.set $t11 (i64.mul (i64.extend_i32_u (local.get $a1)) (i64.extend_i32_u (local.get $b1))))
    (local.set $mid (i64.add (local.get $t01) (i64.shr_u (local.get $t00) (i64.const 32))))
    (local.set $mid_carry (i64.extend_i32_u (i64.lt_u (local.get $mid) (local.get $t01))))
    (local.set $mid (i64.add (local.get $mid) (local.get $t10)))
    (local.set $mid_carry (i64.add (local.get $mid_carry)
      (i64.extend_i32_u (i64.lt_u (local.get $mid) (local.get $t10)))))
    (local.set $p2hi (i64.add
      (i64.add (local.get $t11) (i64.shr_u (local.get $mid) (i64.const 32)))
      (i64.shl (local.get $mid_carry) (i64.const 32))))
    (local.set $p2lo (i64.or
      (i64.and (local.get $t00) (i64.const 0xFFFFFFFF))
      (i64.shl (i64.and (local.get $mid) (i64.const 0xFFFFFFFF)) (i64.const 32))))
    ;; Combine: prodHi:prodLo = p1hi:(p1lo + p2hi) with carry propagation
    (local.set $carry (i64.add (local.get $p1lo) (local.get $p2hi)))
    ;; Check if carry propagated (carry < p1lo → overflow into prodHi)
    (local.set $prodHi (i64.add (local.get $p1hi)
      (i64.extend_i32_u (i64.lt_u (local.get $carry) (local.get $p1lo)))))
    (local.set $prodLo (local.get $carry))
    ;; ─── Determine lz (leading-zero flag): 1 if MSB of prodHi is 0 ──────────────
    (local.set $lz (i32.wrap_i64 (i64.xor (i64.shr_u (local.get $prodHi) (i64.const 63)) (i64.const 1))))
    ;; ─── Compute biased exponent ─────────────────────────────────────────────────
    ;; floor(exp10 * log2(10)) via fixed-point: (exp10 * 14267572527) >> 32
    ;; 14267572527 = floor(log2(10) * 2^32) — correct for all exp10 in -342..308.
    (local.set $log2floor (i32.wrap_i64 (i64.shr_s
      (i64.mul (i64.extend_i32_s (local.get $exp10)) (i64.const 14267572527))
      (i64.const 32))))
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

// Hex → byte-string via char-array + one join. NOT `s += chr` in a loop: that
// allocates Σ1..n ≈ n²/2 bytes of dead strings (54 MB for the 10.4 KB EL table),
// and setup runs PER COMPILE inside the self-host kernel — a warm no-_clear
// instance exhausted its heap after ~70 compiles. join is linear: ~n boxes of
// array + 1-char strings plus the result.
const hexToBytes = (hex) => {
  const chars = []
  for (let i = 0; i < hex.length; i += 2) chars.push(String.fromCharCode(parseInt(hex.slice(i, i + 2), 16)))
  return chars.join('')
}

export default (ctx) => {
  deps({
    __mkstr: ['__alloc'],
    // own edge: __static_str's body calls $__mkstr — without it the helper
    // rides the self-host-unreliable auto-scan (test/selfhost-includes.js)
    __static_str: ['__mkstr'],
    __ftoa: ['__itoa', '__pow10', '__mkstr', '__static_str', '__ftoa_shortest'],
    __ftoa_shortest: ['__mkstr', '__static_str', '__alloc', '__itoa', '__ryu_mulshift', '__ryu_pow5', '__ryu_pow5div'],
    __ryu_pow5: ['__ryu_mulhi'],
    __ryu_mulshift: ['__ryu_mulhi'],
    __ryu_mulhi: [],
    __ryu_pow5div: [],
    __i32_to_str: ['__itoa_s', '__mkstr'],
    __itoa_s: ['__itoa'],
    __ilen: [],
    __toExp: ['__itoa', '__pow10', '__mkstr', '__static_str'],
    __radix_str: ['__mkstr'],
    __num_radix: ['__ftoa', '__mkstr'],
    __to_num: ['__char_at', '__str_byteLen', '__pow10', '__dec_to_f64', '__to_str', '__skipws', '__ptr_aux'],
    __skipws: ['__char_at', '__strws'],
    __to_bigint: ['__char_at', '__str_byteLen', '__num_to_bigint'],
    __parseInt: ['__char_at', '__str_byteLen', '__skipws', '__to_str'],
    __parseFloat: ['__char_at', '__str_byteLen', '__pow10', '__dec_to_f64', '__to_str', '__skipws'],
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
      (then (i32.store8 (local.get $buf) (i32.const 48)) (return (i32.const 1))))
    (local.set $tmp (local.get $val))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $tmp)))
      (i32.store8 (i32.add (local.get $buf) (local.get $len))
        (i32.add (i32.const 48) (i32.rem_u (local.get $tmp) (i32.const 10))))
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
        (i32.store8 (local.get $buf) (i32.const 45))   ;; '-'
        ;; magnitude as unsigned: negate via 0 - val (INT_MIN maps to itself, __itoa reads unsigned)
        (return (i32.add
          (call $__itoa (i32.sub (i32.const 0) (local.get $val)) (i32.add (local.get $buf) (i32.const 1)))
          (i32.const 1)))))
    (call $__itoa (local.get $val) (local.get $buf)))`

  // __i32_to_str(val: i32) → f64 (NaN-boxed string) — ToString for a value the
  // compiler proved is a signed i32. The whole point is to bypass __ftoa's float
  // machinery (shortest-repr search, __toExp, __pow10): a known integer renders with
  // just __itoa_s over a scratch buffer. Lets `"id " + (n|0)` and integer
  // templates skip the ~2 KB float formatter the generic ToString hard-pulls.
  ctx.core.stdlib['__i32_to_str'] = `(func $__i32_to_str (param $val i32) (result f64)
    (local $buf i32)
    (local.set $buf (call $__alloc (i32.const 12)))
    (call $__mkstr (local.get $buf) (call $__itoa_s (local.get $val) (local.get $buf))))`

  // __radix_str(val: i64, radix: i32) → f64 (NaN-boxed string)
  // Signed integer → radix string for BigInt.prototype.toString(radix). Digits go
  // 0-9 then a-z (lowercase, per spec); magnitude is taken unsigned so i64.MIN
  // (whose two's-complement negation is itself) formats correctly via div_u/rem_u.
  ctx.core.stdlib['__radix_str'] = `(func $__radix_str (param $val i64) (param $radix i32) (result f64)
    (local $buf i32) (local $pos i32) (local $neg i32) (local $mag i64) (local $r i64)
    (local $dg i32) (local $i i32) (local $j i32) (local $tmp i32)
    (local.set $buf (call $__alloc (i32.const 72)))
    (local.set $r (i64.extend_i32_s (local.get $radix)))
    (if (i64.eqz (local.get $val))
      (then (i32.store8 (local.get $buf) (i32.const 48)) (return (call $__mkstr (local.get $buf) (i32.const 1)))))
    (local.set $mag (local.get $val))
    (if (i64.lt_s (local.get $val) (i64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $mag (i64.sub (i64.const 0) (local.get $val)))))
    (block $mb (loop $ml
      (br_if $mb (i64.eqz (local.get $mag)))
      (local.set $dg (i32.wrap_i64 (i64.rem_u (local.get $mag) (local.get $r))))
      (i32.store8 (i32.add (local.get $buf) (local.get $pos))
        (select (i32.add (local.get $dg) (i32.const 48)) (i32.add (local.get $dg) (i32.const 87)) (i32.lt_s (local.get $dg) (i32.const 10))))
      (local.set $mag (i64.div_u (local.get $mag) (local.get $r)))
      (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
      (br $ml)))
    (if (local.get $neg)
      (then (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 45))
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
      (then (throw $__jz_err (f64.const 0))))
    (if (i32.or (f64.ne (local.get $val) (local.get $val)) (f64.eq (f64.abs (local.get $val)) (f64.const inf)))
      (then (return (call $__ftoa (local.get $val) (i32.const 0) (i32.const 0)))))
    (local.set $buf (call $__alloc (i32.const 180)))
    (local.set $r (i64.extend_i32_s (local.get $radix)))
    (local.set $rf (f64.convert_i32_s (local.get $radix)))
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $val (f64.neg (local.get $val)))))
    (local.set $int (f64.floor (local.get $val)))
    (local.set $frac (f64.sub (local.get $val) (local.get $int)))
    (local.set $iv (i64.trunc_sat_f64_u (local.get $int)))
    (if (i64.eqz (local.get $iv))
      (then (i32.store8 (local.get $buf) (i32.const 48)) (local.set $pos (i32.const 1)))
      (else
        (block $ib (loop $il
          (br_if $ib (i64.eqz (local.get $iv)))
          (local.set $dg (i32.wrap_i64 (i64.rem_u (local.get $iv) (local.get $r))))
          (i32.store8 (i32.add (local.get $buf) (local.get $pos))
            (select (i32.add (local.get $dg) (i32.const 48)) (i32.add (local.get $dg) (i32.const 87)) (i32.lt_s (local.get $dg) (i32.const 10))))
          (local.set $iv (i64.div_u (local.get $iv) (local.get $r)))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (br $il)))))
    (if (local.get $neg)
      (then (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 45))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
    (local.set $j (i32.sub (local.get $pos) (i32.const 1)))
    (block $rb (loop $rl
      (br_if $rb (i32.ge_s (local.get $i) (local.get $j)))
      (local.set $tmp (i32.load8_u (i32.add (local.get $buf) (local.get $i))))
      (i32.store8 (i32.add (local.get $buf) (local.get $i)) (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
      (i32.store8 (i32.add (local.get $buf) (local.get $j)) (local.get $tmp))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $j (i32.sub (local.get $j) (i32.const 1)))
      (br $rl)))
    (if (f64.gt (local.get $frac) (f64.const 0))
      (then
        (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 46))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (block $fb (loop $fl
          (br_if $fb (f64.le (local.get $frac) (f64.const 0)))
          (br_if $fb (i32.ge_s (local.get $fn) (i32.const 100)))
          (local.set $frac (f64.mul (local.get $frac) (local.get $rf)))
          (local.set $dg (i32.trunc_f64_s (f64.floor (local.get $frac))))
          (i32.store8 (i32.add (local.get $buf) (local.get $pos))
            (select (i32.add (local.get $dg) (i32.const 48)) (i32.add (local.get $dg) (i32.const 87)) (i32.lt_s (local.get $dg) (i32.const 10))))
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
  // Hot (~60M calls in watr self-host via __ftoa). bulk memory.copy is ~10× faster than
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
                (local.set $b (i32.load8_u (i32.add (local.get $buf) (local.get $i))))
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
    (local.set $off (call $__alloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $off) (local.get $len))
    (local.set $off (i32.add (local.get $off) (i32.const 4)))
    (memory.copy (local.get $off) (local.get $buf) (local.get $len))
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
    (local.set $buf (call $__alloc (i32.const 40)))
    ;; Sign
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $val (f64.neg (local.get $val)))))
    (if (i32.and (f64.eq (local.get $val) (f64.const 0)) (local.get $neg))
      (then (local.set $neg (i32.const 0))))
    (if (local.get $neg)
      (then (i32.store8 (local.get $buf) (i32.const 45))
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
          (i32.store8 (i32.add (local.get $buf) (local.get $pos))
            (i32.add (i32.const 48) (i32.trunc_f64_u (f64.max (f64.const 0) (f64.min (f64.const 9)
              (f64.nearest (f64.sub (local.get $abs)
                (f64.mul (f64.trunc (f64.div (local.get $abs) (f64.const 10))) (f64.const 10)))))))))
          (local.set $abs (f64.trunc (f64.div (local.get $abs) (f64.const 10))))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (br $ll)))
        ;; Reverse
        (local.set $i (local.get $ilen)) (local.set $j (i32.sub (local.get $pos) (i32.const 1)))
        (block $rd (loop $rl
          (br_if $rd (i32.ge_s (local.get $i) (local.get $j)))
          (local.set $int (i32.load8_u (i32.add (local.get $buf) (local.get $i))))
          (i32.store8 (i32.add (local.get $buf) (local.get $i))
            (i32.load8_u (i32.add (local.get $buf) (local.get $j))))
          (i32.store8 (i32.add (local.get $buf) (local.get $j)) (local.get $int))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (local.set $j (i32.sub (local.get $j) (i32.const 1)))
          (br $rl)))
        (return (call $__mkstr (local.get $buf) (local.get $pos)))))
    ;; Write integer part
    (local.set $ilen (call $__itoa (local.get $int) (i32.add (local.get $buf) (local.get $pos))))
    (local.set $pos (i32.add (local.get $pos) (local.get $ilen)))
    ;; Write fractional part: extract digits from $frac by dividing by 10^(prec-1), 10^(prec-2), ...
    (if (i32.gt_s (local.get $prec) (i32.const 0))
      (then
        (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 46))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (local.set $i (i32.sub (local.get $prec) (i32.const 1)))
        (block $fd (loop $fl
          (br_if $fd (i32.lt_s (local.get $i) (i32.const 0)))
          (local.set $j (i32.div_u (local.get $frac) (i32.trunc_f64_u (call $__pow10 (local.get $i)))))
          (i32.store8 (i32.add (local.get $buf) (local.get $pos))
            (i32.add (i32.const 48) (i32.rem_u (local.get $j) (i32.const 10))))
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
    (local.set $buf (call $__alloc (i32.const 32)))
    ;; Sign
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $val (f64.neg (local.get $val)))))
    (if (i32.and (f64.eq (local.get $val) (f64.const 0)) (local.get $neg))
      (then (local.set $neg (i32.const 0))))
    (if (local.get $neg)
      (then (i32.store8 (local.get $buf) (i32.const 45))
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
    (local.set $len (call $__itoa (i32.trunc_f64_u (local.get $mantissa)) (i32.add (local.get $buf) (local.get $pos))))
    ;; Insert '.' after first digit
    (if (i32.gt_s (local.get $prec) (i32.const 0))
      (then
        (local.set $i (local.get $len))
        (block $md (loop $ml
          (br_if $md (i32.le_s (local.get $i) (i32.const 1)))
          (i32.store8 (i32.add (local.get $buf) (i32.add (local.get $pos) (local.get $i)))
            (i32.load8_u (i32.add (local.get $buf) (i32.add (local.get $pos) (i32.sub (local.get $i) (i32.const 1))))))
          (local.set $i (i32.sub (local.get $i) (i32.const 1)))
          (br $ml)))
        (i32.store8 (i32.add (local.get $buf) (i32.add (local.get $pos) (i32.const 1))) (i32.const 46))
        (local.set $pos (i32.add (local.get $pos) (i32.add (local.get $len) (i32.const 1)))))
      (else (local.set $pos (i32.add (local.get $pos) (local.get $len)))))
    ;; Shortest form: drop trailing zeros (and a bare '.') from the mantissa.
    ;; The leading digit is always 1-9, so the walk-back stops at the '.' at worst.
    (if (i32.and (local.get $strip) (i32.gt_s (local.get $prec) (i32.const 0)))
      (then
        (block $sz (loop $szl
          (br_if $sz (i32.ne (i32.load8_u (i32.sub (i32.add (local.get $buf) (local.get $pos)) (i32.const 1))) (i32.const 48)))
          (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))
          (br $szl)))
        (if (i32.eq (i32.load8_u (i32.sub (i32.add (local.get $buf) (local.get $pos)) (i32.const 1))) (i32.const 46))
          (then (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))))))
    ;; Write 'e', sign, exponent
    (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 101))
    (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
    (if (i32.lt_s (local.get $exp) (i32.const 0))
      (then (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 45))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (local.set $exp (i32.sub (i32.const 0) (local.get $exp))))
      (else (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 43))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
    (local.set $pos (i32.add (local.get $pos) (call $__itoa (local.get $exp) (i32.add (local.get $buf) (local.get $pos)))))
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
    (if (i32.eq (local.get $id) (i32.const 1)) (then (local.set $src (i32.const 3))  (local.set $len (i32.const 8))))
    (if (i32.eq (local.get $id) (i32.const 2)) (then (local.set $src (i32.const 11)) (local.set $len (i32.const 9))))
    (if (i32.eq (local.get $id) (i32.const 3)) (then (local.set $src (i32.const 20)) (local.set $len (i32.const 4))))
    (if (i32.eq (local.get $id) (i32.const 4)) (then (local.set $src (i32.const 24)) (local.set $len (i32.const 5))))
    (if (i32.eq (local.get $id) (i32.const 5)) (then (local.set $src (i32.const 29)) (local.set $len (i32.const 4))))
    (if (i32.eq (local.get $id) (i32.const 6)) (then (local.set $src (i32.const 33)) (local.set $len (i32.const 9))))
    (if (i32.eq (local.get $id) (i32.const 7)) (then (local.set $src (i32.const 42)) (local.set $len (i32.const 7))))
    (if (i32.eq (local.get $id) (i32.const 8)) (then (local.set $src (i32.const 49)) (local.set $len (i32.const 8))))
    (if (i32.eq (local.get $id) (i32.const 9)) (then (local.set $src (i32.const 57)) (local.set $len (i32.const 2))))
    (if (i32.eq (local.get $id) (i32.const 10)) (then (local.set $src (i32.const 59)) (local.set $len (i32.const 9))))
    (if (i32.eq (local.get $id) (i32.const 11)) (then (local.set $src (i32.const 68)) (local.set $len (i32.const 9))))
    (call $__mkstr ${ctx.memory.shared ? '(i32.add (global.get $__staticBase) (local.get $src))' : '(local.get $src)'} (local.get $len)))`
  }

  // R: Static strings seeded at address 0. Compile.js strips if __static_str unused.
  // 0=NaN 1=Infinity 2=-Infinity 3=true 4=false 5=null 6=undefined 7=[Array] 8=[Object]
  // 9=ok 10=not-equal 11=timed-out (Atomics.wait results, module/atomics.js)
  const staticStr = 'NaNInfinity-Infinitytruefalsenullundefined[Array][Object]oknot-equaltimed-out'
  ctx.runtime.staticDataLen = staticStr.length
  ctx.runtime.data = (ctx.runtime.data || '') + staticStr

  // Eisel-Lemire power-of-10 table: 131 entries × 16 bytes = 2096 bytes,
  // staticStr.length = 57, pad 7 → table starts at byte 64 (always constant).
  // The table bytes are stashed in ctx.runtime.elTable. src/compile/index.js appends
  // them to ctx.runtime.data (padded to 8-byte boundary) only when $__dec_to_f64 is
  // actually pulled in, then declares global $__el_tbl = that offset. This keeps the
  // 2096-byte data segment out of modules that don't do decimal→f64 conversion.
  // TRIMMED to exp10 in [-65..65] (see __dec_to_f64 range check). Each entry: 8
  // bytes tblLo (LE) + 8 bytes tblHi (LE), for exp10 = -65 + i.
  const EL_TABLE_HEX = '3f3ba10629aa3f115ad63b92d653f4ee07c524a459cac74af865651b66b4589549f62d0df0bc795d76bf3ea27fe1aebadc7379102c2cd8f4536fce8adf995ae969e84b8a9b1b07799405c1b62ba0d89184e2de6c82e24897f94671a436c84eb6259b1608231b1bfdb7988d4d447ae2e3f7200ee5f5f030fe727f78b06a8c6d8e35a9515e332dbdbd4f9f965c85ef08b28213e63580782cad2347bcb3662b8bde31ccaf2150cb3b4c76ac553020fb168b3dbf1b2a24be4adf93176b3ce8b9dcad0dafa234ad6d1dd778dd854b62e853d968ade5408c6472866baa336f3d71d487c2181f51affd0e68069500cb8c8dc9a9f2de66251bbd120248bac0fdeff03bd4574b60f730b64b016d7498fe9576a5842d5e3835bda39e4188913e7e3bd4cea5b9758682ac4c0652ea35ce5d4a8942cf930994d1ebef4373b2e1a07ace958981f80bf9c5e6eb14101f1a491942fbeba1f64e7777e0261ad4a6609b9f12fa66cab422559598b02089d038824797b800fdb035555d5f6eb4558263b18c5e73209e1d83aa34f78921eb62bcdd2f3690a8c5e423d50175ece9a57b2bd5bb43b412f76e362521c933b2472d3b6555aab06b9a0a846e69bbc09e99f889beead49c06c10d25ca43ea7006c0762c6e250a4448f128575e6a92060438cadb6457862acd96f2ecf504370805c6bc123eed277580bc2e6833c6444a86f76b978de87192a0eb1d21e0fb6aeeb37aa37e5831875b44936429d8ba05ea60594c9eaefd687215b8bd338e298724b96fdf451a3d03cf1ae656e0f879d4b6d3a5ab6b300662c1d08f6c18779889a4488f9686bc87baf1c4b387de94feabcd1a333ca8ab29292eb6e0140b1d7f8bc0f09f25490bbad9dc718cd94de45eaef0ec076f1b8e2810548eaf50619df6d92ce8c94aa2b13214e971dbd25c223a081c31be6e05af9fac31278906f4aa480a63bd6dcac69ac717fe70ab08b1d5daccbb2c097d7881b99d3d4dd6a58ec50860f5bb254eebf0938246f0854ef2f60ab8f22aaf2126ed3823586ca7e1aeb40d66aff51aaa6f28072c6e47d14ded90c89f8dd950ca457984dba4cc82a028b5ba07f10fe53c97976512ce7fa3c87262a949ed531e0c7dfdfe96c15fcc7a0fbb139ce8e8254fdcbcbefcb177fface9548c6191b177b10936f73dcfaa9f17246aefb9f59dd51d8c03750d8395c71dad446b2873054b256f44d2d0e37af932ec0a43f967e34e77c56a8362ceec9b3fa7cd93f7419c22d5764524fb01e8c20f11c1787552436b8ad456ed7902a2f3a9aa786b89130a83d64456348c41459853d556c66b98cc230cd66b41ef9156bea88aecb786bebf2c8fcbc6116b36eceda9d6f33214d7f77b393f1ceb02a2b39453ccb03fd9ccf5da074fe3a5838ae0b968ff9c8f0f40b3d1c9225c8f24ad58e8a11fc2b909081023be9599d9366c37918aa732280c0ad4ab2dfbff8f444785b56c513f328f0cc916f9f9ffb31599e6e2e392677fd9a73dae3bfc7f90ad1fd08d9c7741dfcf11cd994afb9ff4982744b183d511d7435640401dfac7317f3195dd72256b66ea35284852fc1c7fef3e7d8acfee0500654332da663be45eab8e1cad826a07403ed4be90404a9d3656b263d891a204e8a644775a684e22e2754f3e8736cb05a2d015157102e2aa5a53e30da9033e87ca445b5a0d839a5531285c51d3c28694fe0a7958e89180d51e99d9128472a839be4d976e62b6e08a66ff8f17a58f12c82d213d0afbe3982d40ff735dce990b9dbc3466e67c8e7f1c887f68fa80804ec4ebc1ff1f1c729f236a9f0239a12062b566b2ff27a34e87ac44474387c9a8ba62009ffff14b22a9d7151914e9fba9b43d60c33f776fb5c9a6ad8fac719dd3214d38b40f55cb227c1099b317cec4486a6046a1532a7e2b9b547fa09d01f66d42fccb4474da2efbe0944f8402c1990853fbfe551191fa39197a63254331c0ca27ba7eab553579889f58bcee933df0de58342f8b55c14bb563b735757c2696166f01fbedaab19ea23c2583921bb0bbdccac179a9155e46cb8bee2377229ceac91e19ec89cdfa0b5f1775768a95a1927b661f67ec80f9ce365d1214edfa49b71a40e78027e1b78284f41659a8791ce5108890b0b8ecb2d1d258ae3709cc318f15aab4dce6a71f8607ef99850b3ffeb29ad4e193e091a767c96a0067cecebddfe0246d5c2cbbc8e0bd42600041a1d68b186e8873f7e9fa586d5378409149ccae9e896a5075a439af48689690f55b7fda03964252c906846d2d015e7a79998f88833bd3a67b08e5c87881f5d8d77fb3aa640a88909a4a1efbd6e132cfcd5f60d57f06559aa0eef25c26cd7fa1e03b5c851e48eac048aa2ff46fc0dfc9d84ab3a626da24f1da943bf18bb057fc8e1d60d05808b7d6083dc57657ceb65d79123c826eca640c4b8c7654ed8124b51717cba209fd7dcf5d2f94a968a26da2dddc7dcb4c7c5d43353bf9d3020b090b15545dfeaf6d1a4a01c57bc4e1a6e5268d54fa9e1b09a19c41b69a359a109f70b0e9b8c6624bc903d26301c3c0d4c68c1c2467f81dcf5d4263dee079f844fcd79176409be442f512fc1559983656fb4d369410c29d93b2177b5b6f3ec42b7ae143b994f2429ccfee2c9905a75a5bec6ccaf39c975383832a78ffc65031722708bd3084bd2864243556bff8a4bd4e314aec3ce5ec99be36e195771b8736d15eae13460f943f6e84597b55e2288485f699981713b9cf89e52fdaea1a33e52674c07edd57e72176ef5dc8d2f03f4f9848386fea9690a9536b757a07ed0f63be5a060ba5bcb49428c6125949e8d3fb6df1c74dceebe15cd9bbabd72d7164bde4f69cf060338db3cfaa964d798dbdec9d34c42c3980b0a08355fca0d7f0ec67c541f57747a0dc4472b59dc48616f4601b49f9aa2ce489d5ce22c575281c3139629bb7d5375dac8b826b369332637dc73a8225cb8574d7973103029cff5daebc6471f79ed3a886fcfd8302837ff5d9ebbd4db5860853a87bfd24c363df72d0662da162a8ca67d26d1ef7599ecb474260bca43da9de808308e674f085bed95278eb0d8d531661a48b1f926c272e906756665170e85b79cdb653dba3d81cba00f6df324671d96b80a428d2cc0ea4e880f397bf97cdcf86a0cdb2068012cd2261f07daffdc083a8c8815f082057806b796c5d1b3db1a4d2fab03b05743630e3cb631a31c6eea6c39c9c8a061144fcdbbefc60bd77aa90f4c3442d481555fb92ee3bb9ac15d5b4f1f44a1c4d2d15dd1b75c5f38b2d051117995d63a0785ad462d2b6f0ee7846d55cbf347cc8167189fb86e4ac2a17980a34efa04d3daee6355dd40eac7a0e9f86809509a1cc5960837489125719d246a8e0ba4bc93f7038a4d12bd7ac9f8658d298e9cfdd2746a306637b06cc23547783ff9142d5b1174cc83b1a08bf2c2955647fb6934a9e1d5fbaca20caee77736a3d1fe49cee82727bb47e543ef52a886286938e43aa234f9a619ee98db2352afb6738b2d494ece200fa0564311fc3f4f981c6de04ddd38d40bc83de7ef3f9383c113c8b45d448b150ab24965e7038478b150bae57099bdd24d6ad3b768c0619eeda8dd9d6e5800ad7a54ce5c917a4cfd4a8f8874c1f21cd4ccf9f5ebc1d8d030ad3f6a91f67690020c347762b657084cc8774d473e04100f4d9ec293b3fc6d2dfd4c88490585200711068f409cf77c7170afba5b4ee66408d148271ccc255b99dcc79cf30554048d84cf1c6bf99d593e21fac817c6a505a0ea0adb82f00cb38db2717a21c85e4f01108d9a63bc0fd06d2f19cca63a61d6d164a8f904a30bd88462e44fdfe8732044e8e599a2e3e7615ec9c4a9efd293f85e1f1ef40bacdd31a2744ddc57cf48ee659ee2bd128c188e1309554f7ce581930f874bb82b978f58c3edd949a01af1f3c36526ae3e7d632308e143ac1c19a27cbc3e644dca18c3fbcb19988f1b9c0f85e3a10ab29e5b7a7150f60f596e7f0b6f648d41574dea511db12b8b2bc21ad64345b491b11560fd6911766dfeb34ecbe00d90db1ca95c925bbce9f6b9342a7ee404f515d3dfb3bef69c28746b812512a11a3a5b40cfa0a6b04b32958e6ab72baea85e7f047dce6c2e20f1af78f560f69656721ed5993a073db93e0f4b32c53c33ec1696830b88850d2b818f2e0fb133ac71842411e73557283734f978cfa9808f99e92d1e5cfea4e645023bdaf39bf4ab746f745df83a5627d246cacdb83b78e328cba8b6b72a75dce96c34b896465323f2fa96e064f11f5817cb49eabbdfefe0e7b530ac8a25572a29b6186d6365f5fe92c7406bd8575874501fd13860437b7233811482ce752e99641fc98a7c504a52c86155af7a0a7a3fc513b7fd1fb22e7db734d989ac448e63d1385ef82baebe0d2d0603ec1f5da5f0d5866aba3a826990705f98d31b3d1b710ee3f96cc52707f494677f1fd1fc6e594e9cfbbff33a6efed8beab6fed39b0ffdf161d59fc08f6be92ea564fec882537c6ebacac7b073c6a37acefd3d7b63681b0a69bdf94e085ca60ca1be062d3e2151a661169c620af3cf4f496e48b88d69e50ffa1bc3faccefc3a3db895a26f1c3de93f8e2f31ce0755a462996f8b7763a6b5cdb6d98235813f197b3bbf665140986335289be2c2e58ed7da06a747f598b67c0a62beedc1c57b44ea4c2a8ef17b7403848db9413e46c61624df392ebdde450461a12ba171dc8f9ba20b07766151ee5d7a096e82e121ddc7414ce0a60cd32ef86245e91ba5624139299810db880ffaaa8adb5b5696ced97f6ffe110e660bfd5121923e3c163f41efa3f8dca8f9c97c5abeff58db27cb1a6f88f30bdb383fdb6966b73b1dedb5dd0f6b37caca0e4bc647c46d0dd6ba93a427af0cd6be40ef6be0d2ca28ac653c9d2986cc1869d92b32e11b74aadb7a87b07bfc771e84477607ad5649dd87249ad64d71c47118b4a7c6c055f6287cf9bd83d0de498d52d5d9bc7c6f63aa9c3c24e8d101dff4a7934827978b489d3ba3951582a72dfcecb60f14bcb103684288865eeb44e97c2feb8ed1efe9443a532eafe2962223d733e27a9a63d7a94ce5f523f5a7d35060887b8298866cc1c81f726cfb0dcc207caa826342a80ff63a1b5f002dd93b389fc5230c13460ffbcc9e2ac43d47820acbb677cf141383f2cfc0d4caa844b944bd5c0ed362983a79b9d11dfd4655e799e0a31a984f3639102c5d5164affb517464d7dd365f0bc3543f6454e8ebfd1ce4b502ea43f169601ea99d6e1712f86c25ee4398dcf9bfb8164c04c5a4ebb2773765d8870c3827aa27df06ff810d5f8076a3a5526ba918c854e968b36550af7890489eaaf28b6ef26e2bb2e84eacc74ac452be5dbb2a3abb0daea9d921200c98b0b3b6fc94f466baec89244371740bb6ece09cbbbe31706da7ab715051d106a0a42ccbdaadc9d879059e52d23124a8246a99fb6eaa9c254fa578ff9ab96dc22989347646554f3e9f82db3f756bc932b7e7859bd7e29702477f9df5ab6553cdb4eeb5736ef19c676eafb8bf1236b0b9222e6ed036ba07714e5faaeedec458e36ab5fe9c4858895599eb9da14b4eb1802cbdb119b5375fdf702b48819a1269fc2bd52d681a8d2fcb503e1aa5f49f046336de74ba252077ca34499d5db2d560c40a4706fa593842de6ca7f8552b96b0f50cd4ccb8eb8e5b89fbddfa6a7a74613a400207eb2261fa707ad97d0c8280c8c6600d48e2f7873c824cc5e82fa320f2f800089723b5690fa2d7ff6a2b9ffd23aa0402b4fca6b3479f91eb4cba8bf8749c810f6e2bc8681d7b726a1fec9d7f42d7dcad90d36f4b0e632b8249fbb0d72791c3d509143315da03fe6edc62a91ce97634ca475947d7488cf5fa9f8ba1ae13ebeaf86c97cce48b5e1db699b686199cead5be8fb1b029b22da5244c2c3b93f429972e2faa2c241ab9067d5f21ad467c99f87cddca519096bba60c59720c9c1bb87e900540f60cb05e9b8b6bd683bb2aae923012913383e47236724ed2165af0a72b6a0f90be3860c76c03694693e5b8d0ee408f8ce9ba88f937044b9040eb230121d0bb6c2c29273b88c95e7c2486f5e2bf2c6b1b9b93b48f377bd90f31a0b36b6ae381e28a84a1af0d5ecb4b0e18dc363dac6253252dd206c0b28e20ead385a7e489c575f538a942307598d51d8c6f09d5a832d37e8ac79ec48afb0658ef86c4531e4f844221898271bdbdcff581b64cb9e8e1b6b150fbff8f0088a3f2f223d7e4672e2c5dad2ee362d8bac0fbb6acc1dd80e5b779187aa84f8add7e9b4c29f1247e998eaba94ea52bbcc862462b347d798233fa5e939a527ea7fa8ad3aa0190d7fec8e0e64888eb1e49fd2ac24043068cf5319893e15f9eeeea383d72d053c42c3a85f2b8e5ab7aaea8ca44d7906cb12f49237b63131655525b0cdd00be4be8bd8bbe211bf3e5f55178e80c40e9daeaece6a5bd66e0eb72a9db1a07552445a5a8245f28b0ad2647504dec81267d5f0f0e2d6ee2e8d06be928515fb6b608596d64d46553d18c4b67b73ed9c86b8263c4ce197aa4c1e75a45ad028c4a866304b9fd93dd5df65924d710433f52940fe8e03a846e5ab7f7bd0c6e23f9933d0bd72045298de965f9a8478db8fbf40446d8f85663e967cf7c0a556d273efa84aa4791300e7ddad9a98277663a895525d0d5818c0605559c17eb1537c12bba6b4106e1ef0b8aaaf71de9d681bd7e9e870ca041396b3ca0d07ab6221712692220dfdc5977b603dd1c855bb690db0b66a507cb77d9ab88c053b2b2ac4105ce442b2ad928e60f377e3045b9a7a8ab98ed31e5937b238f0551cc6f14019ed67b288662fc5de466c6ba3372e915fe801df15a03d3b4bac2323c6e2bcba3b31618b1a080d0a5e97ecab771b6ca98a7d39ae214a908c35bde7965522c753eddcc7d9542eda7741d6507e75755c5414ea1c88e9b9d0d5d10be5ddd2927369992424aa64e8444bc64e5e958777d0c3bf2dadd43e110bef3bf15abdb44a62da973cec848ed5cdea8aadb1ec61ddfad0bd4b27a6f24a81a5ed18de67ba943945ad1eb1cfd7ce708794cfea80f4fc434b2cb3ce818d024da9798325a131fc145ef75f42a23043a01358e46e093e3b9a35f5f7d2cafc5388186e9dca8b0dca0083f2b587fd7d3455cf64a25e77487ee091b7d1749e9d812a03fe4a3695da9d5876250612c60422f583bddd833a51c5eed3ae8796f742357972966a92c4523b7544cd14be9a9382170f3c05b775278a9295009a6dc13863dd128bc62453b12cf7ba8000c9f1035ecaeb16fcf6d3ee7bda7450a01d9784f5bca61cbbf488ea1a11926408e5bce5326cd0e3e9312ba56195b67d4a1eeccf9f43622e32ff3a075d1d928eee9293c287d4fab9febe0949b4a43632aa77b8b3a9897968be2e4c5be14dc4be9495e6100af64b01379d0fd9acb03af77c1d90948cf39ec18484530fd85c0935dc24b4b96fb006f2a56528130eb44b42132ee1d3452e44b7873ff9cb88506f09ccbc8c48d73915a5698ff7feaa24cb0bffebaf1b4d885a0e4473b5bed5edbdcefee6db303095f8880a683197a5b436415f70893d7cba362b0dc2fdfcce61841177ccab4c1b69047690323dbc427ae5d594bfd60fb1c1c2499a3fa6b5696caf05bd3786531d7233dc80cf0f2384471b47acc5a7a8a44e401361c3d32b6519e25817b7d1e9263108ac1c5a643bdf4f8d976e1283a3703d0ad7a3703d0ad7a3703d0ad7a3cccccccccccccccccccccccccccccccc00000000000000000000000000000080000000000000000000000000000000a0000000000000000000000000000000c8000000000000000000000000000000fa0000000000000000000000000000409c000000000000000000000000000050c3000000000000000000000000000024f4000000000000000000000000008096980000000000000000000000000020bcbe00000000000000000000000000286bee00000000000000000000000000f9029500000000000000000000000040b743ba00000000000000000000000010a5d4e80000000000000000000000002ae78491000000000000000000000080f420e6b50000000000000000000000a031a95fe3000000000000000000000004bfc91b8e0000000000000000000000c52ebca2b10000000000000000000040763a6b0bde00000000000000000000e8890423c78a0000000000000000000062acc5eb78ad000000000000000000807a17b726d7d800000000000000000090ac6e32788687000000000000000000b4570a3f1668a9000000000000000000a1edccce1bc2d30000000000000000a0841440615159840000000000000000c8a51990b9a56fa500000000000000003a0f20f4278fcbce0000000000000040840994f878393f810000000000000050e50bb936d7078fa100000000000000a4de4e6704cdc9f2c9000000000000004d96228145407c6ffc00000000000020f09db5702ba8adc59d000000000000286c05e34c36121937c500000000000032c7c61be0c356df84f60000000000407f3c5c116c3a960b139a0000000000109f4bb31507c97bce97c00000000000d4861e20db48bb1ac2bdf00000000080441413f4880db55099769600000000a055d91731eb50e2a43f14bc0000000008abcf5dfd25e51a8e4f19eb00000000e5caa15abe37cfd0b8d1ef92000000409e3d4af1ad05030527c6abb7000000d005cd9c6d19c743c6b0b796e5000000a2230082e46f5cea7bce327e8f0000808a2c80a2dd8bf3e41a82bf5db3000020ad37200bd56e309ea1622f35e0000034cc22f4264545de02a59d3d218c0000417f2bb17096d695430e058d29af0040115f76dd0c3c4c7bd45146f0f3da00c86afb690a88a50fcd24f32b76d888007a457a040dea8e5300eeefb6930eab80d8d6984590a4726880e9aba438d2d55047867f2bdaa64741f071eb6663a38524d9675fb6909099516c4ea6403c0ca76dcf41f7e3b4f4ff6507e2cf504bcfd0a421897a0ef1f8bf9f44ed81128f81820d6a2b19522df7afc7956822d7f221a39044769fa6f8f49b39bb02eb8c6feacbb4d55347d036f202086ac325700be5fe9065942c4262d70145229a1726274f9ff57eb9b7d23a4d42d6aa809deff022c7b2dea7658789e0d28bd5e0842badebf82feb889ff455cc6377850c333b4c939bfb256bc7716bbf3cd5a6cfff491f78c27aef45394e46ef8b8a90c37f1c2716f3acb5cbe3f08b7597563adacf71d8ed9717a3be1cedee523decc8d0438e4ee9bddd4bee63a8aaa74c27fbc4d431a263ed6aef743ea9cae88ff81cfb245f455e94442b128e53fde2b336e439eeb6d675b916b69671a8bcdb60445dc8a9644cd3e7cd31fe46e95589bc4a3a1deabe0fe49041bebd9863abab6bdd88a4a4ae131db5d12ded7e3c9696c614abcd4d9a5864e2a23c54cfe51d1efcec8aa07060b77e8dcb4b29435fa5253ba8adc88c3865deb0be9ef313b70eef4912d9faaf86fe15dd3743786c3269356eabc7fc2d14bf2d8a045496077fc3c24996f97b39d92eb9ac06e97bc95e7433dcfbf7da878f7ae7d7a371ed3dbb28a069fddae8b499acf0860cce680dea3208c4bc112322c0d7aca89001c390a43f0af52bd6ab2ab00dd8d2fae079dac6672679db65ab1a8e08c78338591891b8017057523f56a1b1cab8a4866f5eb526024ced26cfab095efde6cdb4055b3158814f5478610bc65a5eb08021c7b13dae616369d6398e77f175dca0e9381ecd193abc034cc871d56d9313c923c76540a048ab045f3ace4a497858fb769c3f28640deb627be4c0ce2d4b179d94834f32bdd0a53b9a1d7142f91d5dc47964e37eec448fca00650d93776574f5cb1e4ecf138b997e205fe8bb6abf68997ea621c3d8ed3f9ee876e26a45efc2bf1e10eaf34ee9cfc5a2149bc516abb3ef124a7258d1f1a1bbe5ec803bee4ad09597dc8eae456e8a2a1f2861caa95d44bbbd93321ad7092df52672f93c147515ea569c5f7026263c5958e71ba62c694d926c83770cb02f8b6f2ee1a2cf77c3e0b64764950f9cfb6d0b7a998bc355f498e4ac5ebd8941bd2447ec3f379ab598df8e57b62cec91eced58e70fc500e37e97b2ede33767b667292fe153f6c09b5e3ddf74ee8200d2e079bd6cf49958215b868b11aaa3800659d8ec8771c0aee9f167ae9594cc20486f0ee8e98d701a64ee01dadddc7f148d050931b2588690fe34418815d49f59f0464bbddeeea7343e8251aa1ac90770ac189e6c96ead1c1cde2e5d4b0dd04c66bcfe2039e322399c0ad0f851c1586b74683db8445ff6bbf309953a6639a6765186412e616ff46ef7c7fe8cf7ec0603f8f7ecb4f6e5f8c15ae4ff1819df0380f335ebee34977ef9a99a36da2c52c07d3bff5ad5c1c55ab01800c09cbf6f7c8c72f73d973632a1602a04fcbfdfa9adddcfde767287eda4d01c4119f9eb8011554fde181b21d51a10135d646c626421aa97c5a221f65a50942c28bd8f75869b0e98d7875335f0746695957e79aae831c64b1d65200378997c32f2da1c19aa423bd5d8c67c0846b7db47b7809f2e0463696bab740f83263ce504deb459798d8c33ba9e550b6fffb01a5206617bdbeceb48a131fe5a3ff7a42cea83f5dec3701b1366c336fc6df8ce980c947ba9384415d4447000bb817f023e1bbd9a8b8e591741559c00da61dec6cd92a10d3e62fdb68ad3798c8879213e4c71aea4390fb11c39845beba297718dd79a1e454b47ad6f3fed66d29f4945e54d8c91d6ae10c66585fa6e499181dbb34279e52e28c8f7f2ef7cf5dc05ee4e901b145e71ab0731ffaf4437570765d64421d17a121dca8531c794a49066aba7e4972ae049589926863179ddb870469dedb0eda45faabb6423c5d84d2a94503d6929250d7f8d6b2a945ba92238a0bc2c59b5b92865b861e14d76877ac6c8e32b782f23668f2a726d90c4395d70732ff6423af4402efd1b807e849bde6447f1f1f76ed6a613583a609629c6c20165fe7a6d3a8c5b902a40f8c7ac387a8db36a1900813376803cd89972cda544949c2645ae56b222122806cbdb710aa9bdbf2fdb0de066ba92aa0c7ace5949482926f3d5d96c8c55335c8f9171fba392377cb8cf4bb3ab7a842fafb6e531404762affd778b58472a9699cba4a68198513f5fe0dd7e225cf1384c3695dc25f6658b27ed18c5befc21865f4617ad9fb3f772fef023899d5792fbf98fad8cffa0f55fbaa0386ff4a58fbeebe38cf83f9532aba958467bf5d2ebaaaee8361f27b745a94ddb2a097fa5cb42a95e4f9ee9a1171f994df883d39746175ba5db8aa0156cd377a17eb8c47d1b912e93ab30ac155e062acee12b8cc22b4ab9109604d316b987b57aa17e67f2ba116b60bb8a0fd857e5aed949ddf5f76499ce3077384be138f58147dc2ebfbe9ad418ec88f25aed8b26e591cb3e67a6419d2b1bbf3aed98e5fca6fe35fa099bd9f46de54580d48b97bde25ee3b0480d623ec8a6aae109aa71a56afe94a0520cc2ca7ad04da948051a12b1ba49d0628fff710d942085df0d244fb9086220479ff9aaa87534a74ac07163a35282b4557bf4195a9e85c9197899b8842f275162d2f92fad311dabafe35619569b7092e7c5d9b7c849590697e83b9fa43258c39db34c29ba5bbf4035ee467f9942eef0712c2b202cff578c2baeee01b1d7df5444bb9af6181321773692ad96264dc32169ea71bbaa1fedccf03758f7b7d93bf9b8591a228ca3ed4c3445273da5c78af02e735cbb2fca764fa6a1388083aabad61b001bfef9dd0fdb84518aa8a0816197a1cc2ae6bc5453d27579e54ad8a5b9f98a3729ac6f64b8678f6e254ac3699633fa687203c9adda716b41b6a57847f3ccf8fa928cbc0d5511ca1a2446d659f0bc3f3d3f2fdf025b3b1a4e54a649f43e75978c4b79e96ee1fde0d9f5d3d8714617096b56546bceaa755d106b50ca959790cfc22ff57ebf288d54224f1a709d8cb87dd75ff16932feb8a536ded110ccebee95453bfdcb7faa56da8c868168f812e242a28efd3e5bc8744697d016ef9109d561a7975a48faca995c3dc81c9375544ec60d7928db317147bf453e2bb856a5527398df770e08eeccc78746d95936295b843b89a468cb2270097d1c87a38bbbaa654664158af9e31c0fc057b99066a69d0e9bf512edb031ff8bde3ec1f44e24122f217f3fc88c32676ad1ce827d55ad2aaeedd2f3cab74b0d3d823e2718af186556ad53b0bd6494e8467562d87f6567475626505c785db616501acf828b46cd112bbbec638a752babe01d73633e1c785d7696ef806d1733417614602c0ec9cb32602455ba48290015df9d702f0278460b04216724da3f441b4f78d03ec31a5785cd39bce20cc7152a1757104677ece9633c8420229ff86d384e9c662000f413e20bd69a1799f6808e6a3787bc052d14d682cc40958c7828adfcc569a70a745618237350c2ef991b60b407660a688cb7cb142a1c7bc9b35a40ed093f8cf6afedb5d9389f9abc2434d12c4b8f68305fe5235f8ebf756f34a708b7a337a72c3de53217bf35a16985c4c2e59c0184f74d6a8e959b0f11bbe73df796ff0de62110c1364701ceea2eda82bac4556cbdd8ae78b3ec6d1d48594923617d72b3e956de12ece37064aa7b93704ddccb68dfac899bac1c5871c11e8a2220a4092989c1da01499dbd4b10a914bab0cd0b6be0325c8597f124a5e4db51dd60f8464ae442e3a301f97dcb5a0e2d2e589d2feecea5c247e73dea971a48d475f2c873ea82574ad5d1056148e0db11977f7284e122fd11875946b99f150dd6faa9ad9706bbd822fc93ce3ff96528a0b5501104dc66c637bfb0bdcbf3ce7ac4eaa0154e0f7473c5afa0ed3ef0b21d8710a8134ecfaac65785ce9e375a714870d4da141a739187f96b3e35c53d1d9a850a009121148de1e7ca01c34a84510d3320446ab0aed4a934de49120892bea833f8517564da81df8605db6686bb6e4a48e669dab60122536b9f4e34206e41dce1960426b7c2bd7c1f378cee983aed2801ff812865bf64cb2301742e4245a07a127b69767f233e0defc9c521dae3049c9b1a37d01ef4098163c44a7a4d97c9bfb4e86ee6095281f8ea58ae806082e419de2272ab9baf2a6f14eada2088a7991c4dbb1746769af10aea258cb8aecd7b5f529efa8e0a16dcaac6517bfd6f3a69199f32ad3580a09fd173fdd6eccb010f6bfb0f507ef4c4bfcdd8e948affdc94f3ef8ef9641510afbd4ad99cb61f0a3df895f137be1ad41a6d9d0f44a4a74c4c76bbedc56d218961c88413558dd15fdf53eab49be4b4f53cfd322c55f8e29b6b7492a1c21d22338cbc3f776ab6db828611b74a33a5ea3fafab0f1505a49223e8d5e40e40a7f2874dcb292d83a63b16b1058f121051efe9203e74f82390ca5b1dc7b21654256b24a94d91f62c34bdb2e478df8e54f7c2b689d01a1a9c40b6ef8eab8bb129b57324ac84a120c3d0a3ab7296ae1e74a2902dd7e5c9e8f3c48c560f3cda9288657a7ca62f7e7118fb1796896588b7eafe981b90bbdd8ddef99dfbeb7eaa65a53e7f22742a5531567885faa61ed55f27878f95883ad5de356b935c28338537f168f3ba2a898a560346b873f27fa6852d43b069752b2d2c8457a610ef1fd073fc290e62293b9c9bb2f6676af513828f7bb491baf34983425ff401c5f298a2739a2136a9701c2413777142762f3fcb1001aa83d38c23edd7d40dd353fb0efeaa404a32043836f406a5e863145dc99ed5d0dc3e05c643b148cee27c59b47bc60a05948e86b794ddda811bdc6fa11af826831c19b4f27cca283191e9e5a4109bf0a3631f612f1cfd727df5631fced4c1ec8c3c67393b63bccfdcf23ca7014af213d885e00305bed501ca178608416e97184ea7d844862d4b82bc9da74ad149bd9e21d10ed6e7f8dda22b85519d459cec03b542c9e590bbca453bf35282abe1934362933b1f756a3d170ab0e76216dab8d43a780a6712c50c9d0c9ca1fb9b10e7c5248b66802bfb27e28701457d616a90f6ed2d8060f6f9b1dae94196dcf984b4736939a0f873785e5164d2bb5338a6e1e8e123647b480bdbb27e635534e3078d62da2c3d9a1ace915f5ebc6a01dc49b0fb1078cc40a14176f7756bc501535cdc9d0acb7fc804e9a9ba29631be1b3b98944cdbd9ffa45635429f43b62d92028ac9540ad4779177ca933f1caba0f2932d75d48ccccab8eed49c0d6bed4a9597f86745affbf56f2685c708cee4914301fa81131ff6fec2e83738c2f6a5c19fc26d2ab7effc553fd31c8b75dc2d98f5d5883555e7fb7a87c3eba25f532d0f3742ea4eb355fe5d21bce286fb23fc430123acdb3815bcf63d1807985cfa77a5e4b44801f6232c3bc05e1d766c35119365e55a0a7fafef32b47d98d4034a69fc3b56ac851b9fef0f6984fb150c18f87346385fad3339f569abfd16ed2d8b9d4005e939cc80047ec802f860a074fe8098135b8c3fac0582761bb27cdc862624ce142a6f49c7897b81cd53880bd7dbdcfcce9e798c356bde6630a47e02cddac0340e421bf74ac6ce0fccc581878149804505deaeec8eb430c1e80370fcb0cdf02527a5295bae6548f256005d3fdcf9683e618a7ba69202af32eb8c647fd837c2420df50e94154fa571d33dc4c7ed2cd16748bd29152e9f8ade43f13e01d47811c512e47b6a62377d9dd0f1858e598a163e5f9d8e34876eaa7ea090f578fff445e2f9c678e'
  // Pre-decode the EL table bytes and stash in ctx.runtime.
  // src/compile/index.js appends elTable to ctx.runtime.data only when
  // __dec_to_f64 is actually pulled in via deps (lazy, keeps small modules clean).
  ctx.runtime.elTable = hexToBytes(EL_TABLE_HEX)

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
  ctx.runtime.ryuTable = hexToBytes(RYU_SEED_HEX)

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

  // (m × entry) >> j for a 128-bit table entry at $tbl (lo, hi LE u64 pair);
  // 64 < j < 128, result proven to fit u64 (ryu d2s_intrinsics.h).
  ctx.core.stdlib['__ryu_mulshift'] = `(func $__ryu_mulshift (param $m i64) (param $tbl i32) (param $j i32) (result i64)
    (local $hi i64) (local $h0 i64) (local $sum i64) (local $high1 i64) (local $d i64)
    (local.set $hi (i64.load (i32.add (local.get $tbl) (i32.const 8))))
    (local.set $h0 (call $__ryu_mulhi (local.get $m) (i64.load (local.get $tbl))))
    (local.set $sum (i64.add (local.get $h0) (i64.mul (local.get $m) (local.get $hi))))
    (local.set $high1 (i64.add (call $__ryu_mulhi (local.get $m) (local.get $hi))
      (i64.extend_i32_u (i64.lt_u (local.get $sum) (local.get $h0)))))
    (local.set $d (i64.extend_i32_u (i32.sub (local.get $j) (i32.const 64))))
    (i64.or (i64.shr_u (local.get $sum) (local.get $d))
      (i64.shl (local.get $high1) (i64.sub (i64.const 64) (local.get $d)))))`

  // Rebuild the 128-bit power-of-5 entry for index $i into 16 bytes at $out:
  // seed × 5^offset, shifted back into the 125/126-bit window, plus the stored
  // 2-bit rounding offset (reference double_computePow5/double_computeInvPow5).
  ctx.core.stdlib['__ryu_pow5'] = () => {
    if (!ctx.scope.globals.has('__ryu_tbl')) declGlobal('__ryu_tbl', 'i32')
    return `(func $__ryu_pow5 (param $i i32) (param $inv i32) (param $out i32) (result i32)
    (local $base i32) (local $base2 i32) (local $off i32) (local $mul i32)
    (local $mlo i64) (local $mhi i64) (local $m i64) (local $a i64)
    (local $lo0 i64) (local $hi0 i64) (local $lo2 i64) (local $hi2 i64)
    (local $delta i64) (local $sLo i64) (local $sHi i64) (local $tLo i64) (local $tHi i64)
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
      (then
        (i64.store (local.get $out) (local.get $mlo))
        (i64.store (i32.add (local.get $out) (i32.const 8)) (local.get $mhi))
        (return (local.get $out))))
    (local.set $m (i64.load (i32.add (i32.add (global.get $__ryu_tbl) (i32.const 448)) (i32.shl (local.get $off) (i32.const 3)))))
    ;; b0 = m·(mulLo - inv); b2 = m·mulHi   (inv subtracts 1 per the reference)
    (local.set $a (i64.sub (local.get $mlo) (i64.extend_i32_u (local.get $inv))))
    (local.set $lo0 (i64.mul (local.get $m) (local.get $a)))
    (local.set $hi0 (call $__ryu_mulhi (local.get $m) (local.get $a)))
    (local.set $lo2 (i64.mul (local.get $m) (local.get $mhi)))
    (local.set $hi2 (call $__ryu_mulhi (local.get $m) (local.get $mhi)))
    ;; delta = |pow5bits(i) - pow5bits(base2)| ∈ (0, 64)
    (local.set $delta (i64.extend_i32_u (i32.sub
      (i32.shr_u (i32.mul (select (local.get $base2) (local.get $i) (local.get $inv)) (i32.const 1217359)) (i32.const 19))
      (i32.shr_u (i32.mul (select (local.get $i) (local.get $base2) (local.get $inv)) (i32.const 1217359)) (i32.const 19)))))
    ;; (b0 >> delta) + (b2 << (64-delta)) as a 128-bit sum
    (local.set $sLo (i64.or (i64.shr_u (local.get $lo0) (local.get $delta))
      (i64.shl (local.get $hi0) (i64.sub (i64.const 64) (local.get $delta)))))
    (local.set $sHi (i64.shr_u (local.get $hi0) (local.get $delta)))
    (local.set $tLo (i64.shl (local.get $lo2) (i64.sub (i64.const 64) (local.get $delta))))
    (local.set $tHi (i64.or (i64.shl (local.get $hi2) (i64.sub (i64.const 64) (local.get $delta)))
      (i64.shr_u (local.get $lo2) (local.get $delta))))
    (local.set $rLo (i64.add (local.get $sLo) (local.get $tLo)))
    (local.set $rHi (i64.add (i64.add (local.get $sHi) (local.get $tHi))
      (i64.extend_i32_u (i64.lt_u (local.get $rLo) (local.get $sLo)))))
    ;; + stored 2-bit error (+1 more for the inverse table)
    (local.set $e (i64.add
      (i64.and (i64.extend_i32_u (i32.shr_u
        (i32.load (i32.add (i32.add (global.get $__ryu_tbl) (select (i32.const 656) (i32.const 744) (local.get $inv)))
          (i32.shl (i32.div_u (local.get $i) (i32.const 16)) (i32.const 2))))
        (i32.shl (i32.rem_u (local.get $i) (i32.const 16)) (i32.const 1)))) (i64.const 3))
      (i64.extend_i32_u (local.get $inv))))
    (local.set $a (i64.add (local.get $rLo) (local.get $e)))
    (local.set $rHi (i64.add (local.get $rHi) (i64.extend_i32_u (i64.lt_u (local.get $a) (local.get $rLo)))))
    (i64.store (local.get $out) (local.get $a))
    (i64.store (i32.add (local.get $out) (i32.const 8)) (local.get $rHi))
    (local.get $out))`
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
    (local $e10 i32) (local $q i32) (local $k i32) (local $sh i32) (local $tbl i32)
    (local $vmTZ i32) (local $vrTZ i32) (local $removed i32) (local $last i32) (local $roundUp i32)
    (local $out i64) (local $buf i32) (local $scr i32) (local $pos i32) (local $olen i32) (local $n i32) (local $i i32)
    (if (f64.ne (local.get $val) (local.get $val)) (then (return (call $__static_str (i32.const 0)))))
    (if (f64.eq (local.get $val) (f64.const inf)) (then (return (call $__static_str (i32.const 1)))))
    (if (f64.eq (local.get $val) (f64.const -inf)) (then (return (call $__static_str (i32.const 2)))))
    (local.set $buf (call $__alloc (i32.const 96)))
    (local.set $scr (i32.add (local.get $buf) (i32.const 64)))
    (if (f64.eq (local.get $val) (f64.const 0))
      (then
        (i32.store8 (local.get $buf) (i32.const 48))
        (return (call $__mkstr (local.get $buf) (i32.const 1)))))
    (local.set $bits (i64.reinterpret_f64 (local.get $val)))
    (if (i64.lt_s (local.get $bits) (i64.const 0))
      (then
        (i32.store8 (local.get $buf) (i32.const 45))
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
        (local.set $tbl (call $__ryu_pow5 (local.get $q) (i32.const 1) (i32.add (local.get $buf) (i32.const 48))))
        (local.set $vr (call $__ryu_mulshift (local.get $mv) (local.get $tbl) (local.get $sh)))
        (local.set $vp (call $__ryu_mulshift (i64.add (local.get $mv) (i64.const 2)) (local.get $tbl) (local.get $sh)))
        (local.set $vm (call $__ryu_mulshift (i64.sub (i64.sub (local.get $mv) (i64.const 1)) (local.get $mmShift)) (local.get $tbl) (local.get $sh)))
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
        (local.set $tbl (call $__ryu_pow5 (local.get $k) (i32.const 0) (i32.add (local.get $buf) (i32.const 48))))
        (local.set $vr (call $__ryu_mulshift (local.get $mv) (local.get $tbl) (local.get $sh)))
        (local.set $vp (call $__ryu_mulshift (i64.add (local.get $mv) (i64.const 2)) (local.get $tbl) (local.get $sh)))
        (local.set $vm (call $__ryu_mulshift (i64.sub (i64.sub (local.get $mv) (i64.const 1)) (local.get $mmShift)) (local.get $tbl) (local.get $sh)))
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
      (i32.store8 (i32.add (local.get $scr) (local.get $olen))
        (i32.add (i32.const 48) (i32.wrap_i64 (i64.sub (local.get $t) (i64.mul (local.get $h0) (i64.const 10))))))
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
          (i32.store8 (i32.add (local.get $buf) (local.get $pos))
            (i32.load8_u (i32.add (local.get $scr) (i32.sub (i32.sub (local.get $olen) (i32.const 1)) (local.get $i)))))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $b1l)))
        (block $z1d (loop $z1l
          (br_if $z1d (i32.ge_s (local.get $i) (local.get $n)))
          (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 48))
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
                (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 46))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))))
            (i32.store8 (i32.add (local.get $buf) (local.get $pos))
              (i32.load8_u (i32.add (local.get $scr) (i32.sub (i32.sub (local.get $olen) (i32.const 1)) (local.get $i)))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $b2l))))
        (else (if (i32.and (i32.gt_s (local.get $n) (i32.const -6)) (i32.le_s (local.get $n) (i32.const 0)))
          (then
            (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 48))
            (i32.store8 (i32.add (local.get $buf) (i32.add (local.get $pos) (i32.const 1))) (i32.const 46))
            (local.set $pos (i32.add (local.get $pos) (i32.const 2)))
            (local.set $i (i32.const 0))
            (block $z3d (loop $z3l
              (br_if $z3d (i32.ge_s (local.get $i) (i32.sub (i32.const 0) (local.get $n))))
              (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 48))
              (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $z3l)))
            (local.set $i (i32.const 0))
            (block $b3d (loop $b3l
              (br_if $b3d (i32.ge_s (local.get $i) (local.get $olen)))
              (i32.store8 (i32.add (local.get $buf) (local.get $pos))
                (i32.load8_u (i32.add (local.get $scr) (i32.sub (i32.sub (local.get $olen) (i32.const 1)) (local.get $i)))))
              (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $b3l))))
          (else
            (i32.store8 (i32.add (local.get $buf) (local.get $pos))
              (i32.load8_u (i32.add (local.get $scr) (i32.sub (local.get $olen) (i32.const 1)))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (if (i32.gt_s (local.get $olen) (i32.const 1))
              (then
                (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 46))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (local.set $i (i32.const 1))
                (block $b4d (loop $b4l
                  (br_if $b4d (i32.ge_s (local.get $i) (local.get $olen)))
                  (i32.store8 (i32.add (local.get $buf) (local.get $pos))
                    (i32.load8_u (i32.add (local.get $scr) (i32.sub (i32.sub (local.get $olen) (i32.const 1)) (local.get $i)))))
                  (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $b4l)))))
            (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 101))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (local.set $n (i32.sub (local.get $n) (i32.const 1)))
            (if (i32.lt_s (local.get $n) (i32.const 0))
              (then
                (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 45))
                (local.set $n (i32.sub (i32.const 0) (local.get $n))))
              (else (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 43))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (local.set $pos (i32.add (local.get $pos)
              (call $__itoa (local.get $n) (i32.add (local.get $buf) (local.get $pos)))))))))))
    (call $__mkstr (local.get $buf) (local.get $pos)))`


  // === Number constants ===

  // Each folds to inline (f64.const …), no stdlib dep. Written out (not a table
  // loop) to stay within the self-host subset. `NaN` uses the `nan` token (not raw
  // NaN) so it survives self-host IR marshalling — see emitNum.
  ctx.core.emit['Number.MAX_SAFE_INTEGER'] = () => typed(['f64.const', 9007199254740991], 'f64')
  ctx.core.emit['Number.MIN_SAFE_INTEGER'] = () => typed(['f64.const', -9007199254740991], 'f64')
  ctx.core.emit['Number.EPSILON'] = () => typed(['f64.const', 2.220446049250313e-16], 'f64')
  ctx.core.emit['Number.MAX_VALUE'] = () => typed(['f64.const', 1.7976931348623157e+308], 'f64')
  ctx.core.emit['Number.MIN_VALUE'] = () => typed(['f64.const', 5e-324], 'f64')
  ctx.core.emit['Number.POSITIVE_INFINITY'] = () => typed(['f64.const', Infinity], 'f64')
  ctx.core.emit['Number.NEGATIVE_INFINITY'] = () => typed(['f64.const', -Infinity], 'f64')
  ctx.core.emit['Number.NaN'] = () => typed(['f64.const', 'nan'], 'f64')

  // === Number static methods ===

  const emitIsNaN = (x) => {
    const v = asF64(emit(x))
    const t = temp('t')
    return typed(['f64.ne', ['local.tee', `$${t}`, v], ['local.get', `$${t}`]], 'i32')
  }

  const emitIsFinite = (x) => {
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
    (local.set $len (call $__str_byteLen (local.get $str)))
    ;; Skip StrWhiteSpace (UTF-8-decoded: NBSP, LS/PS, Zs — not just ASCII).
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

  // __skipws(v, i, len) → i32 — advance the byte index i past any run of
  // StrWhiteSpace. Strings are UTF-8, so each step decodes one scalar: every
  // whitespace code point is ≤ U+FEFF (≤ 3 bytes), and a 4-byte lead is never
  // whitespace, so it (and any non-space scalar) ends the run.
  ctx.core.stdlib['__skipws'] = `(func $__skipws (param $v i64) (param $i i32) (param $len i32) (result i32)
    (local $b i32) (local $cp i32) (local $n i32) (local $sbase i32)
    ${SBASE_INIT}
    (block $done (loop $l
      (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
      (local.set $b ${chAt('(local.get $i)')})
      (if (i32.lt_u (local.get $b) (i32.const 0x80))
        (then (local.set $cp (local.get $b)) (local.set $n (i32.const 1)))
        (else (if (i32.lt_u (local.get $b) (i32.const 0xe0))
          (then
            (local.set $n (i32.const 2))
            (local.set $cp (i32.or
              (i32.shl (i32.and (local.get $b) (i32.const 0x1f)) (i32.const 6))
              (i32.and (call $__char_at (local.get $v) (i32.add (local.get $i) (i32.const 1))) (i32.const 0x3f)))))
          (else (if (i32.lt_u (local.get $b) (i32.const 0xf0))
            (then
              (local.set $n (i32.const 3))
              (local.set $cp (i32.or (i32.or
                (i32.shl (i32.and (local.get $b) (i32.const 0x0f)) (i32.const 12))
                (i32.shl (i32.and (call $__char_at (local.get $v) (i32.add (local.get $i) (i32.const 1))) (i32.const 0x3f)) (i32.const 6)))
                (i32.and (call $__char_at (local.get $v) (i32.add (local.get $i) (i32.const 2))) (i32.const 0x3f)))))
            (else (return (local.get $i))))))))
      (br_if $done (i32.eqz (call $__strws (local.get $cp))))
      (local.set $i (i32.add (local.get $i) (local.get $n)))
      (br $l)))
    (local.get $i))`

  ctx.core.stdlib['__to_num'] = `(func $__to_num (param $v i64) (result f64)
    (local $t i32) (local $len i32) (local $i i32) (local $c i32) (local $neg i32)
    (local $seen i32) (local $exp i32) (local $expNeg i32) (local $expDigits i32)
    (local $dot i32) (local $sigDigits i32) (local $decExp i32) (local $dropped i32) (local $round i32)
    (local $radix i32) (local $digit i32) (local $sbase i32)
    (local $result f64) (local $f f64) (local $mant i64)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
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
      (then (throw $__jz_err (f64.const 0))))
    ;; Non-string values go through ToString per JS spec, then re-check the
    ;; type in case ToString itself returned a non-string sentinel.
    (if (i32.ne (local.get $t) (i32.const ${PTR.STRING}))
      (then
        (local.set $v (call $__to_str (local.get $v)))
        (local.set $t (call $__ptr_type (local.get $v)))
        (if (i32.ne (local.get $t) (i32.const ${PTR.STRING}))
          (then (return (f64.const nan))))))
    (local.set $len (call $__str_byteLen (local.get $v)))
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
      (then (throw $__jz_err (f64.const 0))))
    (f64.reinterpret_i64 (i64.trunc_sat_f64_s (local.get $n))))`

  // StringToBigInt: strict — the whole trimmed string must be a single integer
  // literal, else a SyntaxError ($__jz_err). Unlike parseInt this does NOT stop
  // at the first bad char: `BigInt("10n")` and `BigInt("000 12")` throw. Empty
  // or all-whitespace strings parse to 0n. Radix prefixes 0b/0o/0x (case-
  // insensitive) are recognised only when no sign precedes them, so `-0x1`
  // surfaces its `x` as an invalid decimal digit and throws, as the spec wants.
  // (jz's BigInt is i64-backed, so values past 2^63 wrap — out of these tests'
  // range.)
  ctx.core.stdlib['__to_bigint'] = `(func $__to_bigint (param $v i64) (result f64)
    (local $t i32) (local $len i32) (local $i i32) (local $end i32) (local $c i32)
    (local $neg i32) (local $sign i32) (local $radix i32) (local $digit i32)
    (local $seen i32) (local $result i64) (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (f64.eq (local.get $f) (local.get $f))
      (then (return (call $__num_to_bigint (local.get $f)))))
    (local.set $t (call $__ptr_type (local.get $v)))
    (if (i32.ne (local.get $t) (i32.const ${PTR.STRING}))
      (then (return (f64.reinterpret_i64 (i64.const 0)))))
    (local.set $len (call $__str_byteLen (local.get $v)))
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
      (then (return (f64.reinterpret_i64 (i64.const 0)))))
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
        (then (throw $__jz_err (f64.const 0))))
      (local.set $seen (i32.const 1))
      (local.set $result
        (i64.add
          (i64.mul (local.get $result) (i64.extend_i32_s (local.get $radix)))
          (i64.extend_i32_s (local.get $digit))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    ;; A sign or radix prefix with no digits ("-", "0x", "0b") is a SyntaxError.
    (if (i32.eqz (local.get $seen)) (then (throw $__jz_err (f64.const 0))))
    (f64.reinterpret_i64
      (if (result i64) (local.get $neg)
        (then (i64.sub (i64.const 0) (local.get $result)))
        (else (local.get $result)))))`

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
    (local.set $len (call $__str_byteLen (local.get $v)))
    ${SBASE_INIT}
    ;; Skip leading StrWhiteSpace (UTF-8-decoded: NBSP, LS/PS, Zs — not just ASCII).
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
    const radixIR = radix == null ? ['i32.const', 0] : toI32(toNumF64(radix, emit(radix)))
    return typed(['call', '$__parseInt', strInputI64(x), radixIR], 'f64')
  }
  ctx.core.emit['parseInt'] = ctx.core.emit['Number.parseInt']

  ctx.core.emit['Number.parseFloat'] = (x) => {
    inc('__parseFloat')
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
    typed(['call', '$__radix_str', asI64(emit(n)), radix == null ? ['i32.const', 10] : asI32(emit(radix))], 'f64'))

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
    if (valTypeOf(x) === VAL.BIGINT)
      return typed(['f64.convert_i64_s', asI64(emit(x))], 'f64')
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
    const vbits = asI32(emit(bits)), vval = asI64(emit(val))
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
  // BigInt.asUintN(64,·).toString() through this very handler in the self-host).
  ctx.core.emit['BigInt.asUintN'] = (bits, val) => {
    const vbits = asI32(emit(bits)), vval = asI64(emit(val))
    const shift = typed(['i64.sub', ['i64.const', 64], ['i64.extend_i32_s', vbits]], 'i64')
    const t = tempI64('bu')
    return typed(['f64.reinterpret_i64', ['block', ['result', 'i64'],
      ['local.set', `$${t}`, shift],
      ['i64.shr_u', ['i64.shl', vval, ['local.get', `$${t}`]], ['local.get', `$${t}`]]]], 'f64')
  }
}
