// Number methods (toString/toFixed/toExponential/toPrecision), numeric coercion
// (Number()/parseFloat/unary +/String()), and template-literal interpolation.
// String-method tests (charAt/charCodeAt/at/search/match) live in strings.js.
import test from 'tst'
import { is } from 'tst/assert.js'
import { run } from './util.js'

// === toString ===

test('Number: toString integer', () => {
  is(run(`export let f = () => { let n = 42; return n.toString().length }`).f(), 2)
})

test('Number: toString zero', () => {
  is(run(`export let f = () => { let n = 0; return n.toString().length }`).f(), 1)
})

test('Number: toString negative', () => {
  is(run(`export let f = () => { let n = -7; return n.toString().length }`).f(), 2)
})

test('Number: toString float', () => {
  is(run(`export let f = () => { let n = 1.5; return n.toString().length }`).f(), 3)
})

test('Number: toString large', () => {
  is(run(`export let f = () => { let n = 123456; return n.toString().length }`).f(), 6)
})

test('Number: toString NaN', () => {
  is(run(`export let f = () => (0/0).toString().length`).f(), 3)
})

test('Number: toString Infinity', () => {
  is(run(`export let f = () => (1/0).toString().length`).f(), 8)
})

test('Number: toString -Infinity', () => {
  is(run(`export let f = () => (-1/0).toString().length`).f(), 9)
})

test('Number: toString large int', () => {
  is(run(`export let f = () => { let n = 9999999999; return n.toString().length }`).f(), 10)
})

test('Number: toString 1e15', () => {
  is(run(`export let f = () => { let n = 1000000000000000; return n.toString().length }`).f(), 16)
})

// __ftoa was stripping trailing zeros from the integer part when prec=0 (auto-fit
// reduces prec because scaled value won't fit i32). Repro: 1079623680 → "107962368".
// Found via biquad bench when `(s >>> 0) / 4294967296` style PRNG output got
// stringified via template literal. Fix: gate strip-trailing-zeros on prec>0.
test('Number: toString preserves trailing zero in integer', () => {
  is(run(`export let f = () => { let n = 1079623680; return n.toString().length }`).f(), 10)
})

test('Number: toString preserves multiple trailing zeros in integer', () => {
  is(run(`export let f = () => { let n = 1234567000; return n.toString().length }`).f(), 10)
})

test('Number: toString preserves trailing zero through computed value', () => {
  // The original bench bug surfaced via template-literal interpolation of an
  // i32-spec'd value. Compute a value with trailing zero so it can't fold,
  // then stringify. Without the fix, "1079623680" became "107962368" (length 9).
  is(run(`export let f = () => { let n = 539811840 + 539811840; return n.toString().length }`).f(), 10)
})

// === toString(radix) — spec-compliant range validation ===
// Per 21.1.3.6: radix coerces to integer in [2, 36]; otherwise RangeError.
// Pre-fix: radix=1 hung the digit loop, radix=0 trapped 'remainder by zero',
// radix=37 / -1 silently returned wrong digit strings.

test('Number: toString(2) binary', () => {
  is(run(`export let f = () => (15).toString(2).length`).f(), 4)  // "1111"
})

test('Number: toString(16) hex', () => {
  is(run(`export let f = () => (255).toString(16).length`).f(), 2)  // "ff"
})

test('Number: toString(36) max', () => {
  is(run(`export let f = () => (35).toString(36).length`).f(), 1)  // "z"
})

test('Number: toString(1) throws (caught)', () => {
  is(run(`export let f = () => { try { (15).toString(1); return 0 } catch (e) { return 1 } }`).f(), 1)
})

test('Number: toString(37) throws (caught)', () => {
  is(run(`export let f = () => { try { (15).toString(37); return 0 } catch (e) { return 1 } }`).f(), 1)
})

test('Number: toString(0) throws (caught)', () => {
  is(run(`export let f = () => { try { (15).toString(0); return 0 } catch (e) { return 1 } }`).f(), 1)
})

test('Number: toString(-1) throws (caught)', () => {
  is(run(`export let f = () => { try { (15).toString(-1); return 0 } catch (e) { return 1 } }`).f(), 1)
})

test('Number: toString(dyn-radix) ok then bad', () => {
  is(run(`export let f = (r) => { try { return (255).toString(r).length } catch (e) { return -1 } }`).f(16), 2)
  is(run(`export let f = (r) => { try { return (255).toString(r).length } catch (e) { return -1 } }`).f(50), -1)
})

// === toFixed ===

test('Number: toFixed(2)', () => {
  is(run(`export let f = () => { let n = 3.14159; return n.toFixed(2).length }`).f(), 4)
})

test('Number: toFixed(0) rounds', () => {
  is(run(`export let f = () => { let n = 3.7; return n.toFixed(0).length }`).f(), 1)
})

test('Number: toFixed(3) pads', () => {
  is(run(`export let f = () => { let n = 1; return n.toFixed(3).length }`).f(), 5)
})

// === toExponential ===

test('Number: toExponential(2)', () => {
  is(run(`export let f = () => { let n = 123; return n.toExponential(2).length }`).f(), 7)
})

test('Number: toExponential(0)', () => {
  is(run(`export let f = () => { let n = 5; return n.toExponential(0).length }`).f(), 4)
})

test('Number: toExponential small', () => {
  is(run(`export let f = () => { let n = 0.0042; return n.toExponential(1).length }`).f(), 6)
})

// === toPrecision ===

test('Number: toPrecision(5) fixed', () => {
  is(run(`export let f = () => { let n = 123; return n.toPrecision(5).length }`).f(), 6)
})

test('Number: toPrecision(2) exponential', () => {
  is(run(`export let f = () => { let n = 123; return n.toPrecision(2).length }`).f(), 6)
})

test('Number: toPrecision(3) float', () => {
  is(run(`export let f = () => { let n = 1.5; return n.toPrecision(3).length }`).f(), 4)
})

// === String() / expression toString ===

test('Number: String(42)', () => {
  is(run(`export let f = () => String(42).length`).f(), 2)
})

test('String: no argument returns empty string', () => {
  is(run(`export let f = () => String() === ''`).f(), true)
})

test('String: nullish, string, and number coercion', () => {
  is(run(`export let f = () => (String(null) === 'null') + (String(undefined) === 'undefined') + (String('x') === 'x') + (String(3) === '3')`).f(), 4)
})

test('Number: unary plus string coerces', () => {
  is(run(`export let f = () => +"0"`).f(), 0)
})

test('Number: unary plus variable string coerces', () => {
  is(run(`export let f = () => { let s = "12"; return +s + 1 }`).f(), 13)
})

test('Number: Number(string) coerces', () => {
  is(run(`export let f = () => Number("7.5")`).f(), 7.5)
})

test('Number: parseFloat common decimal parity', () => {
  is(run(`export let f = () =>
    (parseFloat("6.28318530717958623") === 6.283185307179586) +
    (parseFloat("0.1") === 0.1) +
    (parseFloat("1e2") === 100) +
    (parseFloat("1e-2") === 0.01) +
    (parseFloat("1e") === 1) +
    (parseFloat("1e-") === 1) +
    (parseFloat(".5") === 0.5) +
    (parseFloat("000.00000123456789012345") === 0.00000123456789012345) +
    (parseFloat("123456789012345678901") === 123456789012345680000) +
    isNaN(parseFloat("."))`).f(), 10)
})

test('Number: parseFloat coerces non-string via ToString', () => {
  // Per JS spec, parseFloat(x) calls ToString(x) first. Array → "4", number → "12.5".
  is(run(`export let f = () => parseFloat([4])`).f(), 4)
  is(run(`export let f = () => parseFloat(12.5)`).f(), 12.5)
})

test('Number: String(0)', () => {
  is(run(`export let f = () => String(0).length`).f(), 1)
})

test('Number: (1+2).toString()', () => {
  is(run(`export let f = () => (1+2).toString().length`).f(), 1)
})

// === Template literal coercion ===

test('Template: number interpolation', () => {
  is(run('export let f = () => `n=${42}`.length').f(), 4)
})

test('Template: multiple interpolations', () => {
  is(run('export let f = () => `${1}+${2}=${1+2}`.length').f(), 5)
})

test('Template: string var interpolation', () => {
  is(run('export let f = () => { let s = "world"; return `hello ${s}`.length }').f(), 11)
})

test('Template: float interpolation', () => {
  is(run('export let f = () => `pi=${3.14}`.length').f(), 7)
})

// Documented divergence: subscript parses the leading-zero form as decimal, so a
// legacy octal literal is its decimal digits (not octal, and not the SyntaxError a
// JS module/strict mode raises). Use 0o377 for octal.
test('Number: legacy octal literal is decimal (documented divergence)', () => {
  is(run(`export let f = () => 0377`).f(), 377)   // not 255
  is(run(`export let f = () => 0o377`).f(), 255)  // explicit octal is correct
})

test('Number: a bound `>>> 0` uint32 reads and computes as its unsigned value', () => {
  // `let u = expr >>> 0` holds the full uint32 (can exceed signed i32). The binding is typed f64,
  // so reads, arithmetic, and the return all match JS — not the old signed-i32 wrap. (0 - 1 = -1.)
  is(run('export let f = () => { let u = (0 - 1) >>> 0; return u }').f(), 4294967295)
  is(run('export let f = () => { let u = (0 - 1) >>> 0; return u + 1 }').f(), 4294967296)
  is(run('export let f = () => { let u = (0 - 1) >>> 0; return u * 2 }').f(), 8589934590)
  is(run('export let f = () => { let u = (0 - 1) >>> 0; return u / 4294967296 }').f(), (4294967295) / 4294967296)
  // A ToUint32 hash accumulator (literal init, every use `>>> 0`-sunk) keeps the fast i32 path.
  is(run('export let f = () => { let h = 0; for (let i = 0; i < 5; i++) { h = (h * 31 + 7) >>> 0 } return h }').f(),
     (() => { let h = 0; for (let i = 0; i < 5; i++) { h = (h * 31 + 7) >>> 0 } return h })())
})

test('Number: a bound `>>> k` (k≥1) keeps the fast signed-i32 path and stays correct', () => {
  // `expr >>> k` for a constant k with (k & 31) ≥ 1 lands in [0, 2³¹−1] — it fits a *signed*
  // i32, so the binding stays i32 (the FFT index path: `nn >>> 1`), unlike the `>>> 0` above
  // which must widen to f64. The unsigned-shift semantics still hold: a value negative as a
  // signed i32 before the shift (−1 ≡ 0xFFFFFFFF) reads as uint32 >>> k, never the signed >>.
  is(run('export let f = () => { let u = (0 - 1) >>> 1; return u }').f(), 2147483647)   // 0xFFFFFFFF >>> 1
  is(run('export let f = () => { let u = (0 - 2) >>> 1; return u }').f(), 2147483647)   // 0xFFFFFFFE >>> 1
  is(run('export let f = () => { let u = (0 - 1) >>> 4; return u }').f(), 268435455)    // 0xFFFFFFFF >>> 4
  is(run('export let f = () => { let u = (0 - 1) >>> 31; return u }').f(), 1)
  // `>>> 32` ≡ `>>> 0` (shift count is mod 32) → full uint32, so it must still widen to f64.
  is(run('export let f = () => { let u = (0 - 1) >>> 32; return u }').f(), 4294967295)
})

// === Regression: String() large-value fraction-drop + trap ===
// Pre-fix, the __ftoa fit loop reduced precision until the scaled integer fit i32, which
// (a) dropped the fractional part once floor(val) exceeded ~2^31, and (b) trapped on the
// large-integer digit-extraction path for values just below the 1e21 exponential threshold
// (a per-digit subtraction could go slightly negative under f64 rounding → i32.trunc_f64_u trap).
test('Number: String() preserves the fraction when the integer part exceeds 2^31', () => {
  is(run(`export let f = () => String(1073741824.5)`).f(), String(1073741824.5))   // '1073741824.5'
  is(run(`export let f = () => String(4294967295.5)`).f(), String(4294967295.5))   // '4294967295.5'
})

test('Number: String() does not trap for large values below 1e21', () => {
  is(run(`export let f = () => String(999999900000000000000)`).f(), String(999999900000000000000))
})

// ---- platform-NaN const folding (the linux-x64 selfhost OOB) ----------------
// x64 wasm arithmetic produces SIGN-SET qNaNs where arm64 produces canonical
// ones. A folded NaN (Math.sqrt(-1) on the narrowed path) must normalize to
// the canonical atom before it rides a kind-erased const-node slot — and the
// detector must be Number.isNaN, not `v !== v`: in-kernel `!==` goes through
// __eq's bit-equality, where a sign-set qNaN equals itself (the arm that keeps
// negative i64-carrier BigInts working), so the !== guard missed exactly the
// payload that traps. Byte-identical kernels passed on arm64 and OOB'd on
// linux-x64 until this.

test('NaN const fold: sqrt(-1) through reductions stays canonical', () => {
  const r = run(`
    export const main = () => {
      const N = 64
      const a = new Float64Array(N)
      for (let i = 0; i < N; i++) a[i] = i + 1
      a[13] = Math.sqrt(-1)
      let m = a[0]
      for (let i = 1; i < N; i++) m = Math.max(m, a[i])
      return (m !== m) | 0
    }
  `, { optimize: 2 })
  is(r.main(), 1)
})

// ---- Eisel-Lemire mul64 carry fix (1-ULP misparse) --------------------------
// The __dec_to_f64 WASM implementation used a 3-way 64-bit addition to compute
// the 128-bit product's middle limb (mid = t01 + t10 + (t00>>32)). For certain
// inputs the addition overflows 64 bits, silently dropping a carry bit into the
// high 64-bit product word. This produced a result 1 ULP low for values like
// 2505210838544172e-23.  Fix: split into two sequential additions, detecting
// overflow from each step and propagating the carry into p1hi.

test('Number: unary + / Number() correctly-rounded hard cases (EL carry fix)', () => {
  // 2505210838544172e-23: triggers the mul64 carry overflow in __dec_to_f64.
  // The 3-way mid accumulation (t01 + t10 + t00>>32) overflowed 64 bits, dropping
  // a carry bit into p1hi, producing a result 1 ULP too low.
  is(run(`export let f = () => +"2505210838544172e-23"`).f(), 2.505210838544172e-8)
  is(run(`export let f = () => +"2.505210838544172e-8"`).f(), 2.505210838544172e-8)
  // More cases inside the trimmed table range (exp10 ∈ [-65,65]) — the realistic
  // span every source / JSON constant lives in (fft/synth's coefficients are ~10^-23).
  is(run(`export let f = () => +"1e-23"`).f(), 1e-23)
  is(run(`export let f = () => +"9007199254740992"`).f(), 9007199254740992) // 2^53 exact
  is(run(`export let f = () => +"1.23456789012345678e-40"`).f(), 1.23456789012345678e-40)
  is(run(`export let f = () => +"6.022140857e23"`).f(), 6.022140857e23)
  // f64-EXTREME exponents (|10^e| > 10^65 — denormals / near-MAX) intentionally fall
  // back to POW10_SCALE (the EL table is trimmed for size, see module/number.js).
  // No real-world literal reaches them; Number.MIN_VALUE / Number.MAX_VALUE are still
  // exact (emitted as f64.const, not parsed). The mul64 carry fix is exercised by the
  // 2505210838544172e-23 case above (exp10 -23, inside the table).
})

// ---- parseInt/parseFloat spec edges (test262 builtins gate, 2026-07-10) -----
// parseInt: StrWhiteSpace is UTF-8-decoded __skipws (NBSP/LS/PS/Zs — was ASCII-
// only), invalid radix (≠0 and outside 2..36 after ToInt32) is NaN before any
// input inspection, and a number input takes ToString like any other value —
// the trunc fast path is valid only in the plain-decimal range (no exponent in
// ToString): parseInt(1e21) is 1, parseInt(1e-7) is 1, parseInt(Infinity) NaN,
// parseInt(-0) +0.

test('Number: parseInt whitespace / radix / numeric-arg spec edges', () => {
  is(run(`export let f = () => parseInt(" 7")`).f(), 7)          // NBSP
  is(run(`export let f = () => parseInt(" 7")`).f(), 7)          // LS
  is(run(`export let f = () => parseInt(" 7", 10)`).f(), 7)      // PS, explicit radix
  is(run(`export let f = () => isNaN(parseInt("0", 1))`).f(), true)   // radix < 2 (isNaN exports as real boolean)
  is(run(`export let f = () => isNaN(parseInt("0", 37))`).f(), true)  // radix > 36
  is(run(`export let f = () => isNaN(parseInt("11", -2147483650))`).f(), true) // ToInt32-wrapped radix
  is(run(`export let f = () => isNaN(parseInt(Infinity))`).f(), true) // "Infinity" has no digits
  is(run(`export let f = () => parseInt(1e21)`).f(), 1)               // "1e+21" → 1
  is(run(`export let f = () => parseInt(1e-7)`).f(), 1)               // "1e-7" → 1
  is(run(`export let f = () => 1 / parseInt(-0)`).f(), Infinity)      // ToString(-0)="0" → +0
  is(run(`export let f = () => 1 / parseInt(-0.5)`).f(), -Infinity)   // "-0.5" → -0
  is(run(`export let f = () => parseInt(123.9)`).f(), 123)            // plain-decimal fast path
  is(run(`export let f = () => parseFloat(" 1.5")`).f(), 1.5)    // parseFloat same skip
})

// Ryū shortest round-trip String(number) (2026-07-11, Ring 2): reference values
// verified against live V8 (node) String() — spec Number::toString, incl.
// notation boundaries (1e21 / 1e-7), subnormals, ties, and -0.
test('Number: String() shortest round-trip (Ryū)', () => {
  const f = run(`export let f = (x) => String(x)`).f
  is(f(0.1), '0.1')
  is(f(0.3), '0.3')
  is(f(0.1 + 0.2), '0.30000000000000004')
  is(f(Math.PI), '3.141592653589793')
  is(f(1 / 3), '0.3333333333333333')
  is(f(100), '100')
  is(f(1024), '1024')
  is(f(-0), '0')
  is(f(1.0000000000000002), '1.0000000000000002')
  is(f(5e-324), '5e-324')                                  // min subnormal
  is(f(1.7976931348623157e308), '1.7976931348623157e+308') // MAX_VALUE
  is(f(1e21), '1e+21')                                     // notation boundary
  is(f(999999999999999900000), '999999999999999900000')    // last plain integer form
  is(f(1e-6), '0.000001')
  is(f(1e-7), '1e-7')
  is(f(123456.789), '123456.789')
  is(f(-123456.789), '-123456.789')
  is(f(2 ** 53), '9007199254740992')
  is(f(4.35), '4.35')
  is(f(999999999.9), '999999999.9')
})
