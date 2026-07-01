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
import { emit, bool, deps, reg, hostImport } from '../src/bridge.js'
import { isReassigned } from '../src/ast.js'
import { valTypeOf } from '../src/kind.js'
import { VAL } from '../src/reps.js'
import { inc, PTR, LAYOUT } from '../src/ctx.js'

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
      ;; Accumulate the significand in an i64 (exact to 18 decimal digits,
      ;; since 10^18 < 2^63) and convert to f64 once at the end — a single
      ;; correctly-rounded i64->f64 step instead of lossy per-digit f64 math.
      (if (i32.lt_s (local.get $sigDigits) (i32.const 18))
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
const POW10_SCALE = `
    (if (i32.gt_s (local.get $decExp) (i32.const 0))
      (then (local.set $result (f64.mul (local.get $result) (call $__pow10 (local.get $decExp))))))
    (if (i32.lt_s (local.get $decExp) (i32.const 0))
      (then (local.set $result (f64.div (local.get $result) (call $__pow10 (i32.sub (i32.const 0) (local.get $decExp)))))))`

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
    ;; Range checks: the table is TRIMMED to exp10 in [-65..65] (covers every
    ;; real-world / source / JSON constant; fft/synth's coefficients are ~10^-23).
    ;; Outside that, return NaN → caller falls back to POW10_SCALE (the pre-EL path,
    ;; ~1 ULP for moderate exponents, exact only near the f64 limits no real literal
    ;; reaches). This keeps the data segment ~2KB instead of ~10KB on every program
    ;; that does an untyped numeric coercion (which pulls __to_num).
    (if (i32.or (i32.lt_s (local.get $exp10) (i32.const -65))
                (i32.gt_s (local.get $exp10) (i32.const 65)))
      (then (return (f64.const nan))))
    ;; Load 128-bit table entry for exp10:  tbl = $__el_tbl + (exp10 + 65) * 16
    (local.set $tbl (i32.add (global.get $__el_tbl) (i32.shl (i32.add (local.get $exp10) (i32.const 65)) (i32.const 4))))
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

export default (ctx) => {
  deps({
    __mkstr: ['__alloc'],
    __ftoa: ['__itoa', '__pow10', '__mkstr', '__static_str', '__toExp'],
    __i32_to_str: ['__itoa', '__mkstr'],
    __toExp: ['__itoa', '__pow10', '__mkstr', '__static_str'],
    __radix_str: ['__mkstr'],
    __num_radix: ['__ftoa', '__mkstr'],
    __to_num: ['__char_at', '__str_byteLen', '__pow10', '__dec_to_f64', '__to_str', '__skipws', '__ptr_aux'],
    __skipws: ['__char_at', '__strws'],
    __to_bigint: ['__char_at', '__str_byteLen', '__num_to_bigint'],
    __parseInt: ['__char_at', '__str_byteLen'],
    __parseFloat: ['__char_at', '__str_byteLen', '__pow10', '__dec_to_f64', '__to_str'],
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

  // __i32_to_str(val: i32) → f64 (NaN-boxed string) — ToString for a value the
  // compiler proved is a signed i32. The whole point is to bypass __ftoa's float
  // machinery (shortest-repr search, __toExp, __pow10): a known integer renders with
  // just __itoa over its magnitude plus a sign byte. Lets `"id " + (n|0)` and integer
  // templates skip the ~2 KB float formatter the generic ToString hard-pulls.
  ctx.core.stdlib['__i32_to_str'] = `(func $__i32_to_str (param $val i32) (result f64)
    (local $buf i32) (local $len i32) (local $u i32)
    (local.set $buf (call $__alloc (i32.const 12)))
    (if (i32.lt_s (local.get $val) (i32.const 0))
      (then
        (i32.store8 (local.get $buf) (i32.const 45))   ;; '-'
        ;; magnitude as unsigned: negate via 0 - val (INT_MIN maps to itself, read u below)
        (local.set $u (i32.sub (i32.const 0) (local.get $val)))
        (local.set $len (call $__itoa (local.get $u) (i32.add (local.get $buf) (i32.const 1))))
        (return (call $__mkstr (local.get $buf) (i32.add (local.get $len) (i32.const 1)))))
      (else
        (local.set $len (call $__itoa (local.get $val) (local.get $buf)))
        (return (call $__mkstr (local.get $buf) (local.get $len)))))
    (f64.const 0))`

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
    ;; ES spec: |x| >= 1e21 or 0 < |x| < 1e-6 → exponential notation (default mode only).
    ;; __toExp clamps the digit count so its scaled mantissa fits an unsigned i32.
    ;; Fewer digits than ECMAScript shortest-repr ideal, but valid output.
    (if (i32.eqz (local.get $mode))
      (then
        (if (f64.ge (f64.abs (local.get $val)) (f64.const 1e21))
          (then (return (call $__toExp (local.get $val) (i32.const 8) (i32.const 1)))))
        (if (i32.and
              (f64.gt (f64.abs (local.get $val)) (f64.const 0))
              (f64.lt (f64.abs (local.get $val)) (f64.const 1e-6)))
          (then (return (call $__toExp (local.get $val) (i32.const 8) (i32.const 1)))))))
    (local.set $buf (call $__alloc (i32.const 40)))
    ;; Sign
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $val (f64.neg (local.get $val)))))
    (if (i32.and (f64.eq (local.get $val) (f64.const 0)) (local.get $neg))
      (then (local.set $neg (i32.const 0))))
    (if (local.get $neg)
      (then (i32.store8 (local.get $buf) (i32.const 45))
        (local.set $pos (i32.const 1))))
    ;; Default mode: auto-select precision (up to 9 digits, must fit i32 when scaled)
    (if (i32.eqz (local.get $mode))
      (then (local.set $prec (i32.const 9))))
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
          (f64.mul (f64.convert_i32_u (local.get $int)) (local.get $scale)))))
        ;; Default mode, fit loop reduced prec to 0: the rounded integer is ready, but the
        ;; original val may still have a fractional part that was discarded.  Recover it:
        ;; frac_f = val - trunc(val); since frac_f ∈ [0,1), frac_f*10^9 < 10^9 < 2^31 — safe.
        (if (i32.and (i32.eqz (local.get $mode)) (i32.eqz (local.get $prec)))
          (then
            (local.set $abs (f64.sub (local.get $val) (f64.trunc (local.get $val))))
            (if (f64.gt (local.get $abs) (f64.const 0))
              (then
                ;; $int was taken from f64.nearest(val), which rounds .5+ UP (999999999.9 → 1e9),
                ;; but $abs/$frac below derive from f64.trunc(val). Re-derive $int from the same
                ;; trunc so integer and fraction agree — else String(999999999.9) → "1000000000.9".
                (local.set $int (i32.trunc_f64_u (f64.trunc (local.get $val))))
                (local.set $prec (i32.const 9))
                (local.set $scale (call $__pow10 (i32.const 9)))
                ;; round: trunc_u(x+0.5) == floor(x+0.5) for the positive frac scale
                (local.set $frac (i32.trunc_f64_u (f64.add
                  (f64.mul (local.get $abs) (f64.const 1000000000))
                  (f64.const 0.5)))))))))
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
        ;; Default mode: emit fractional part if val has one (large-int path skipped it before).
        ;; frac_f = val - trunc(val); since frac_f ∈ [0,1), frac_f*10^9 < 10^9 < 2^31 — safe.
        (if (i32.eqz (local.get $mode))
          (then
            (local.set $abs (f64.sub (local.get $val) (f64.trunc (local.get $val))))
            (if (f64.gt (local.get $abs) (f64.const 0))
              (then
                ;; round: trunc_u(x+0.5) == floor(x+0.5) for the positive frac scale
                (local.set $frac (i32.trunc_f64_u (f64.add
                  (f64.mul (local.get $abs) (f64.const 1000000000))
                  (f64.const 0.5))))
                (i32.store8 (i32.add (local.get $buf) (local.get $pos)) (i32.const 46))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                ;; 9 fractional digits from $frac, high-to-low
                (local.set $i (i32.const 8))
                (block $fd2 (loop $fl2
                  (br_if $fd2 (i32.lt_s (local.get $i) (i32.const 0)))
                  (local.set $j (i32.div_u (local.get $frac) (i32.trunc_f64_u (call $__pow10 (local.get $i)))))
                  (i32.store8 (i32.add (local.get $buf) (local.get $pos))
                    (i32.add (i32.const 48) (i32.rem_u (local.get $j) (i32.const 10))))
                  (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                  (local.set $i (i32.sub (local.get $i) (i32.const 1)))
                  (br $fl2)))
                ;; Strip trailing zeros
                (block $sz2 (loop $sl2
                  (br_if $sz2 (i32.le_s (local.get $pos) (i32.const 0)))
                  (br_if $sz2 (i32.ne
                    (i32.load8_u (i32.add (local.get $buf) (i32.sub (local.get $pos) (i32.const 1))))
                    (i32.const 48)))
                  (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))
                  (br $sl2)))
                ;; Strip trailing dot
                (if (i32.and (i32.gt_s (local.get $pos) (i32.const 0))
                      (i32.eq
                        (i32.load8_u (i32.add (local.get $buf) (i32.sub (local.get $pos) (i32.const 1))))
                        (i32.const 46)))
                  (then (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))))))))
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
    ;; Default mode: strip trailing zeros and dot — only when a fractional part was emitted.
    ;; Gating on $prec>0 prevents stripping zeros from the integer part (e.g. 1079623680 → 107962368)
    ;; for values where auto-fit reduced prec to 0 because the scaled integer wouldn't fit i32.
    (if (i32.and (i32.eqz (local.get $mode)) (i32.gt_s (local.get $prec) (i32.const 0)))
      (then
        (block $sd (loop $sl
          (br_if $sd (i32.le_s (local.get $pos) (i32.const 0)))
          (br_if $sd (i32.ne (i32.load8_u (i32.add (local.get $buf) (i32.sub (local.get $pos) (i32.const 1)))) (i32.const 48)))
          (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))
          (br $sl)))
        (if (i32.and (i32.gt_s (local.get $pos) (i32.const 0))
              (i32.eq (i32.load8_u (i32.add (local.get $buf) (i32.sub (local.get $pos) (i32.const 1)))) (i32.const 46)))
          (then (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))))))
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
  ctx.core.stdlib['__static_str'] = `(func $__static_str (param $id i32) (result f64)
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
    (call $__mkstr (local.get $src) (local.get $len)))`

  // R: Static strings seeded at address 0. Compile.js strips if __static_str unused.
  // 0=NaN 1=Infinity 2=-Infinity 3=true 4=false 5=null 6=undefined 7=[Array] 8=[Object]
  const staticStr = 'NaNInfinity-Infinitytruefalsenullundefined[Array][Object]'
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
  const EL_TABLE_HEX = 'e9b4c29f1247e998eaba94ea52bbcc862462b347d798233fa5e939a527ea7fa8ad3aa0190d7fec8e0e64888eb1e49fd2ac24043068cf5319893e15f9eeeea383d72d053c42c3a85f2b8e5ab7aaea8ca44d7906cb12f49237b63131655525b0cdd00be4be8bd8bbe211bf3e5f55178e80c40e9daeaece6a5bd66e0eb72a9db1a07552445a5a8245f28b0ad2647504dec81267d5f0f0e2d6ee2e8d06be928515fb6b608596d64d46553d18c4b67b73ed9c86b8263c4ce197aa4c1e75a45ad028c4a866304b9fd93dd5df65924d710433f52940fe8e03a846e5ab7f7bd0c6e23f9933d0bd72045298de965f9a8478db8fbf40446d8f85663e967cf7c0a556d273efa84aa4791300e7ddad9a98277663a895525d0d5818c0605559c17eb1537c12bba6b4106e1ef0b8aaaf71de9d681bd7e9e870ca041396b3ca0d07ab6221712692220dfdc5977b603dd1c855bb690db0b66a507cb77d9ab88c053b2b2ac4105ce442b2ad928e60f377e3045b9a7a8ab98ed31e5937b238f0551cc6f14019ed67b288662fc5de466c6ba3372e915fe801df15a03d3b4bac2323c6e2bcba3b31618b1a080d0a5e97ecab771b6ca98a7d39ae214a908c35bde7965522c753eddcc7d9542eda7741d6507e75755c5414ea1c88e9b9d0d5d10be5ddd2927369992424aa64e8444bc64e5e958777d0c3bf2dadd43e110bef3bf15abdb44a62da973cec848ed5cdea8aadb1ec61ddfad0bd4b27a6f24a81a5ed18de67ba943945ad1eb1cfd7ce708794cfea80f4fc434b2cb3ce818d024da9798325a131fc145ef75f42a23043a01358e46e093e3b9a35f5f7d2cafc5388186e9dca8b0dca0083f2b587fd7d3455cf64a25e77487ee091b7d1749e9d812a03fe4a3695da9d5876250612c60422f583bddd833a51c5eed3ae8796f742357972966a92c4523b7544cd14be9a9382170f3c05b775278a9295009a6dc13863dd128bc62453b12cf7ba8000c9f1035ecaeb16fcf6d3ee7bda7450a01d9784f5bca61cbbf488ea1a11926408e5bce5326cd0e3e9312ba56195b67d4a1eeccf9f43622e32ff3a075d1d928eee9293c287d4fab9febe0949b4a43632aa77b8b3a9897968be2e4c5be14dc4be9495e6100af64b01379d0fd9acb03af77c1d90948cf39ec18484530fd85c0935dc24b4b96fb006f2a56528130eb44b42132ee1d3452e44b7873ff9cb88506f09ccbc8c48d73915a5698ff7feaa24cb0bffebaf1b4d885a0e4473b5bed5edbdcefee6db303095f8880a683197a5b436415f70893d7cba362b0dc2fdfcce61841177ccab4c1b69047690323dbc427ae5d594bfd60fb1c1c2499a3fa6b5696caf05bd3786531d7233dc80cf0f2384471b47acc5a7a8a44e401361c3d32b6519e25817b7d1e9263108ac1c5a643bdf4f8d976e1283a3703d0ad7a3703d0ad7a3703d0ad7a3cccccccccccccccccccccccccccccccc00000000000000000000000000000080000000000000000000000000000000a0000000000000000000000000000000c8000000000000000000000000000000fa0000000000000000000000000000409c000000000000000000000000000050c3000000000000000000000000000024f4000000000000000000000000008096980000000000000000000000000020bcbe00000000000000000000000000286bee00000000000000000000000000f9029500000000000000000000000040b743ba00000000000000000000000010a5d4e80000000000000000000000002ae78491000000000000000000000080f420e6b50000000000000000000000a031a95fe3000000000000000000000004bfc91b8e0000000000000000000000c52ebca2b10000000000000000000040763a6b0bde00000000000000000000e8890423c78a0000000000000000000062acc5eb78ad000000000000000000807a17b726d7d800000000000000000090ac6e32788687000000000000000000b4570a3f1668a9000000000000000000a1edccce1bc2d30000000000000000a0841440615159840000000000000000c8a51990b9a56fa500000000000000003a0f20f4278fcbce0000000000000040840994f878393f810000000000000050e50bb936d7078fa100000000000000a4de4e6704cdc9f2c9000000000000004d96228145407c6ffc00000000000020f09db5702ba8adc59d000000000000286c05e34c36121937c500000000000032c7c61be0c356df84f60000000000407f3c5c116c3a960b139a0000000000109f4bb31507c97bce97c00000000000d4861e20db48bb1ac2bdf00000000080441413f4880db55099769600000000a055d91731eb50e2a43f14bc0000000008abcf5dfd25e51a8e4f19eb00000000e5caa15abe37cfd0b8d1ef92000000409e3d4af1ad05030527c6abb7000000d005cd9c6d19c743c6b0b796e5000000a2230082e46f5cea7bce327e8f0000808a2c80a2dd8bf3e41a82bf5db3000020ad37200bd56e309ea1622f35e0000034cc22f4264545de02a59d3d218c0000417f2bb17096d695430e058d29af0040115f76dd0c3c4c7bd45146f0f3da00c86afb690a88a50fcd24f32b76d888007a457a040dea8e5300eeefb6930eab80d8d6984590a4726880e9aba438d2d55047867f2bdaa64741f071eb6663a38524d9675fb6909099516c4ea6403c0ca76dcf41f7e3b4f4ff6507e2cf504bcfd0a421897a0ef1f8bf9f44ed81128f81820d6a2b19522df7afc7956822d7f221a39044769fa6f8f49b39bb02eb8c6feacbb4d55347d036f202086ac325700be5fe9065942c4262d70145229a1726274f9ff57eb9b7d23a4d42d6aa809deff022c7b2dea7658789e0d28bd5e0842badebf82feb889ff455cc6377850c333b4c939bfb256bc7716bbf3cd5a6cfff491f78c27aef45394e46ef8b8a90c37f1c2716f3'
  // Pre-decode the EL table bytes once and stash in ctx.runtime.
  // src/compile/index.js appends elTable to ctx.runtime.data only when
  // __dec_to_f64 is actually pulled in via deps (lazy, keeps small modules clean).
  let elTableBytes = ''
  for (let i = 0; i < EL_TABLE_HEX.length; i += 2)
    elTableBytes += String.fromCharCode(parseInt(EL_TABLE_HEX.slice(i, i + 2), 16))
  ctx.runtime.elTable = elTableBytes

  // Register the stdlib function (no data appended here — see compile/index.js hook)
  ctx.core.stdlib['__dec_to_f64'] = DEC_TO_F64_WAT

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
    (local.set $f (f64.reinterpret_i64 (local.get $str)))
    ;; If input is a number, just truncate
    (if (f64.eq (local.get $f) (local.get $f)) (then (return (f64.trunc (local.get $f)))))
    ;; If NaN-boxed but not a string → return NaN
    (if (i32.ne (call $__ptr_type (local.get $str)) (i32.const 4))
      (then (return (f64.const nan))))
    (local.set $off (call $__ptr_offset (local.get $str)))
    (local.set $len (call $__str_byteLen (local.get $str)))
    (local.set $i (i32.const 0))
    ;; Skip whitespace
    (block $ws (loop $wsl
      (br_if $ws (i32.ge_s (local.get $i) (local.get $len)))
      (br_if $ws (i32.gt_s (call $__char_at (local.get $str) (local.get $i)) (i32.const 32)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $wsl)))
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
    ;; Skip leading whitespace.
    (block $ws (loop $wsl
      (br_if $ws (i32.ge_s (local.get $i) (local.get $len)))
      (br_if $ws (i32.gt_s ${chAt('(local.get $i)')} (i32.const 32)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $wsl)))
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

  ctx.core.emit['Number.parseInt'] = (x, radix) => {
    if (ctx.transform.host === 'wasi') {
      inc('__parseInt')
      const radixIR = radix == null ? ['i32.const', 0] : toI32(toNumF64(radix, emit(radix)))
      return typed(['call', '$__parseInt', strInputI64(x), radixIR], 'f64')
    }
    needParseInt()
    const radixIR = radix == null ? ['i32.const', 0] : toI32(toNumF64(radix, emit(radix)))
    return typed(['call', '$__parseInt', strInputI64(x), radixIR], 'f64')
  }
  ctx.core.emit['parseInt'] = ctx.core.emit['Number.parseInt']
  const needParseFloat = () => hostImport('env', 'parseFloat',
    ['func', '$__parseFloat', ['param', 'i64'], ['result', 'f64']])
  const needParseInt = () => hostImport('env', 'parseInt',
    ['func', '$__parseInt', ['param', 'i64'], ['param', 'i32'], ['result', 'f64']])

  ctx.core.emit['Number.parseFloat'] = (x) => {
    if (ctx.transform.host === 'wasi') {
      inc('__parseFloat')
      return typed(['call', '$__parseFloat', strInputI64(x)], 'f64')
    }
    needParseFloat()
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
