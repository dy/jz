// Number methods (toString/toFixed/toExponential/toPrecision), numeric coercion
// (Number()/parseFloat/unary +/String()), and template-literal interpolation.
// String-method tests (charAt/charCodeAt/at/search/match) live in strings.js.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { run, cases, wat, funcWat } from './util.js'
import { levels, onKernel } from './_matrix.js'
import encodeWat from 'watr/compile'

// === toString ===

test('integer formatting: exact UTF-16 writes at decimal and memory boundaries', () => {
  const text = wat(`export let f = (i, v) => 'x' + (i|0) + ',' + (v|0) + '!'`,
    { optimize: { level: 2, watr: false } })
  // Isolate the actual helpers so a wrong width cannot hide in spare heap space.
  const names = ['__itoa', '__itoa_s', '__ilen']
  const { memory, __itoa, __itoa_s, __ilen } = new WebAssembly.Instance(new WebAssembly.Module(encodeWat(`(module
    (memory (export "memory") 1)
    ${names.map(name => funcWat(text, name) + `(export "${name}" (func $${name}))`).join('\n')}
  )`))).exports
  const units = new Uint16Array(memory.buffer)
  const edges = [0, 0, 1, 2147483647, 2147483648, 4294967295]
  for (let n = 10; n <= 1e9; n *= 10) edges.push(n - 1, n, n + 1)
  edges.push(42, 42, 4294967295, 42)
  for (const signed of [false, true]) for (const edge of edges) {
    const value = signed ? edge | 0 : edge
    const expected = String(value)
    if (signed) is(__ilen(value), expected.length, `width of ${value}`)
    for (const start of [8, units.length - expected.length]) {
      units.fill(0xcafe)
      const length = (signed ? __itoa_s : __itoa)(value, start * 2)
      is(length, expected.length, `written length of ${value}`)
      is(String.fromCharCode(...units.subarray(start, start + length)), expected, `digits of ${value}`)
      is(units[start - 1], 0xcafe, 'prefix untouched')
      if (start + length < units.length) is(units[start + length], 0xcafe, 'suffix untouched')
    }
  }
})

test('Number: toString', () => {
  cases([
    ['integer', '() => { let n = 42; return n.toString().length }', 2],
    ['zero', '() => { let n = 0; return n.toString().length }', 1],
    ['negative', '() => { let n = -7; return n.toString().length }', 2],
    ['float', '() => { let n = 1.5; return n.toString().length }', 3],
    ['large', '() => { let n = 123456; return n.toString().length }', 6],
    ['NaN', '() => (0/0).toString().length', 3],
    ['Infinity', '() => (1/0).toString().length', 8],
    ['-Infinity', '() => (-1/0).toString().length', 9],
    ['large int', '() => { let n = 9999999999; return n.toString().length }', 10],
    ['1e15', '() => { let n = 1000000000000000; return n.toString().length }', 16],
    // __ftoa was stripping trailing zeros from the integer part when prec=0 (auto-fit
    // reduces prec because scaled value won't fit i32). Repro: 1079623680 → "107962368".
    // Found via biquad bench when `(s >>> 0) / 4294967296` style PRNG output got
    // stringified via template literal. Fix: gate strip-trailing-zeros on prec>0.
    ['preserves trailing zero in integer', '() => { let n = 1079623680; return n.toString().length }', 10],
    ['preserves multiple trailing zeros in integer', '() => { let n = 1234567000; return n.toString().length }', 10],
    // The original bench bug surfaced via template-literal interpolation of an
    // i32-spec'd value. Compute a value with trailing zero so it can't fold,
    // then stringify. Without the fix, "1079623680" became "107962368" (length 9).
    ['preserves trailing zero through computed value', '() => { let n = 539811840 + 539811840; return n.toString().length }', 10],
  ])
})

// === toString(radix) — spec-compliant range validation ===
// Per 21.1.3.6: radix coerces to integer in [2, 36]; otherwise RangeError.
// Pre-fix: radix=1 hung the digit loop, radix=0 trapped 'remainder by zero',
// radix=37 / -1 silently returned wrong digit strings.

test('Number: toString(radix)', () => {
  cases([
    ['toString(2) binary', '() => (15).toString(2).length', 4],  // "1111"
    ['toString(16) hex', '() => (255).toString(16).length', 2],  // "ff"
    ['toString(36) max', '() => (35).toString(36).length', 1],  // "z"
    ['toString(1) throws (caught)', '() => { try { (15).toString(1); return 0 } catch (e) { return 1 } }', 1],
    ['toString(37) throws (caught)', '() => { try { (15).toString(37); return 0 } catch (e) { return 1 } }', 1],
    ['toString(0) throws (caught)', '() => { try { (15).toString(0); return 0 } catch (e) { return 1 } }', 1],
    ['toString(-1) throws (caught)', '() => { try { (15).toString(-1); return 0 } catch (e) { return 1 } }', 1],
    ['toString(dyn-radix) ok', '(r) => { try { return (255).toString(r).length } catch (e) { return -1 } }', 2, 16],
    ['toString(dyn-radix) bad', '(r) => { try { return (255).toString(r).length } catch (e) { return -1 } }', -1, 50],
  ])
})

test('Number: radix digits and sign survive reversal', () => {
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const { f } = run('export let f = (n, r) => n.toString(r)', { optimize })
    for (const radix of [2, 8, 16, 36])
      for (const n of [0, 1, -1, 17, -255, 1024, 2147483647, -2147483648, 4294967295, 1.5, -15.5])
        is(f(n, radix), n.toString(radix), `O${optimize}: ${n} in base ${radix}`)
  }
})

test('number formatting: scratch becomes the result without retaining temporary storage', () => {
  const src = `
    export function dec(n) { return n.toString() }
    export function int(n) { return String(n|0) }
    export function radix(n, r) { return n.toString(r) }
    export function big(n, r) { return BigInt(n).toString(r) }
    let saved = ''
    export function hold(n, r) { saved = n.toString(r) }
    export function held() { return saved }
    export function invalid(r) { try { return (17).toString(r) } catch (e) { return e.name } }
  `
  const rows = [
    ...[0, -0, 42, 42, 999999, 1000000, -2147483648, 0.125, 1.23456789,
      Number.MIN_VALUE, Number.MAX_VALUE, NaN, Infinity, -Infinity].map(n => ['dec', [n], String(n)]),
    ...[0, 42, 999999, 1000000, -2147483648, 2147483647].map(n => ['int', [n], String(n)]),
    ...[2, 8, 16, 36].flatMap(r => [0, -1, 123456789, -2147483648, 1.5, -15.5]
      .map(n => ['radix', [n, r], n.toString(r)])),
    ...[2, 10, 16, 36].flatMap(r => [0, 42, -2147483648, -(2 ** 63)]
      .map(n => ['big', [n, r], BigInt(n).toString(r)]))
  ]
  for (const optimize of levels(0, 1, 2, 3, 'size')) for (const alloc of [true, false]) {
    const r = jz(src, { optimize, alloc })
    // The raw ABI deliberately hides its private heap cursor. Its alias and
    // value checks still run; measure allocation where the counter is exposed.
    const heap = r.instance.exports.__heap
    if (alloc) ok(heap, 'the owned allocator exposes its counter')
    for (let round = 0; round < 2; round++) {
      r.exports.hold(123456789, 2)
      for (const [name, args, expected] of rows) {
        const before = heap ? heap.value >>> 0 : 0
        is(r.exports[name](...args), expected, `${name} ${args} O${optimize}`)
        const resultBytes = expected.length <= 6 ? 0 : (4 + expected.length * 2 + 7) & ~7
        if (heap) ok((heap.value >>> 0) - before <= resultBytes + 16, 'only the result and possible BigInt box remain')
        is(r.exports.held(), (123456789).toString(2), 'later formatting preserves retained digits')
      }
      is(r.exports.invalid(1), 'RangeError')
      is(r.exports.invalid(37), 'RangeError')
      is(r.exports.radix(17, 2), '10001', 'formatting still works after a rejected radix')
      if (alloc) r.instance.exports._clear()
    }
  }
})

test('number formatting: shared memories retain independent results across instances', () => {
  if (onKernel()) return // Host memory wiring is outside the single-source kernel API.
  for (const shared of [false, true]) {
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 128, shared })
    const src = `let saved = ''; export function hold(n, r) { saved = n.toString(r) }
      export function held() { return saved }
      export function dec(n) { return n.toString() }
      export function big(n) { return BigInt(n).toString(2) }`
    const a = jz(src, { memory, sharedMemory: shared }), b = jz(src, { memory, sharedMemory: shared })
    a.exports.hold(123456789, 2)
    b.exports.hold(-123456789, 16)
    for (const n of [0, 0, 123456789.125, Number.MIN_VALUE, -42]) {
      is(a.exports.dec(n), String(n))
      is(b.exports.dec(n), String(n))
      is(a.exports.held(), (123456789).toString(2))
      is(b.exports.held(), (-123456789).toString(16))
    }
    is(a.exports.big(-2147483648), (-2147483648n).toString(2))
    is(b.exports.held(), (-123456789).toString(16))
  }
})

// === toFixed ===

test('Number: toFixed', () => {
  cases([
    ['toFixed(2)', '() => { let n = 3.14159; return n.toFixed(2).length }', 4],
    ['toFixed(0) rounds', '() => { let n = 3.7; return n.toFixed(0).length }', 1],
    ['toFixed(3) pads', '() => { let n = 1; return n.toFixed(3).length }', 5],
  ])
})

// === toExponential ===

test('Number: toExponential', () => {
  cases([
    ['toExponential(2)', '() => { let n = 123; return n.toExponential(2).length }', 7],
    ['toExponential(0)', '() => { let n = 5; return n.toExponential(0).length }', 4],
    ['toExponential small', '() => { let n = 0.0042; return n.toExponential(1).length }', 6],
  ])
})

// === toPrecision ===

test('Number: toPrecision', () => {
  cases([
    ['toPrecision(5) fixed', '() => { let n = 123; return n.toPrecision(5).length }', 6],
    ['toPrecision(2) exponential', '() => { let n = 123; return n.toPrecision(2).length }', 6],
    ['toPrecision(3) float', '() => { let n = 1.5; return n.toPrecision(3).length }', 4],
  ])
})

// === String() / expression toString ===

test('Number: String() / expression toString', () => {
  cases([
    ['String(42)', '() => String(42).length', 2],
    ['no argument returns empty string', "() => String() === ''", true],
    ['nullish, string, and number coercion', "() => (String(null) === 'null') + (String(undefined) === 'undefined') + (String('x') === 'x') + (String(3) === '3')", 4],
    ['unary plus string coerces', '() => +"0"', 0],
    ['unary plus variable string coerces', '() => { let s = "12"; return +s + 1 }', 13],
    ['Number(string) coerces', '() => Number("7.5")', 7.5],
    ['parseFloat common decimal parity', `() =>
    (parseFloat("6.28318530717958623") === 6.283185307179586) +
    (parseFloat("0.1") === 0.1) +
    (parseFloat("1e2") === 100) +
    (parseFloat("1e-2") === 0.01) +
    (parseFloat("1e") === 1) +
    (parseFloat("1e-") === 1) +
    (parseFloat(".5") === 0.5) +
    (parseFloat("000.00000123456789012345") === 0.00000123456789012345) +
    (parseFloat("123456789012345678901") === 123456789012345680000) +
    isNaN(parseFloat("."))`, 10],
    // Per JS spec, parseFloat(x) calls ToString(x) first. Array → "4", number → "12.5".
    ['parseFloat coerces non-string via ToString (array)', '() => parseFloat([4])', 4],
    ['parseFloat coerces non-string via ToString (number)', '() => parseFloat(12.5)', 12.5],
    ['String(0)', '() => String(0).length', 1],
    ['(1+2).toString()', '() => (1+2).toString().length', 1],
  ])
})

// === Template literal coercion ===

test('Template:', () => {
  cases([
    ['number interpolation', '() => `n=${42}`.length', 4],
    ['multiple interpolations', '() => `${1}+${2}=${1+2}`.length', 5],
    ['string var interpolation', '() => { let s = "world"; return `hello ${s}`.length }', 11],
    ['float interpolation', '() => `pi=${3.14}`.length', 7],
  ])
})

// Documented divergence: subscript parses the leading-zero form as decimal, so a
// legacy octal literal is its decimal digits (not octal, and not the SyntaxError a
// JS module/strict mode raises). Use 0o377 for octal.
test('Number: legacy octal literal is decimal (documented divergence)', () => {
  cases([
    ['0377', '() => 0377', 377],    // not 255
    ['0o377', '() => 0o377', 255],  // explicit octal is correct
  ])
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
test('Number: String() large-value fraction-drop + trap', () => {
  cases([
    ['preserves the fraction: 1073741824.5', '() => String(1073741824.5)', String(1073741824.5)],  // '1073741824.5'
    ['preserves the fraction: 4294967295.5', '() => String(4294967295.5)', String(4294967295.5)],  // '4294967295.5'
    ['does not trap for large values below 1e21', '() => String(999999900000000000000)', String(999999900000000000000)],
  ])
})

// ---- platform-NaN const folding (the linux-x64 self-compile OOB) ----------------
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
  is(run(`export let f = () => parseInt(" 7")`).f(), 7)          // NBSP
  is(run(`export let f = () => parseInt(" 7")`).f(), 7)          // LS
  is(run(`export let f = () => parseInt(" 7", 10)`).f(), 7)      // PS, explicit radix
  is(run(`export let f = () => isNaN(parseInt("0", 1))`).f(), true)   // radix < 2 (isNaN exports as real boolean)
  is(run(`export let f = () => isNaN(parseInt("0", 37))`).f(), true)  // radix > 36
  is(run(`export let f = () => isNaN(parseInt("11", -2147483650))`).f(), true) // ToInt32-wrapped radix
  is(run(`export let f = () => isNaN(parseInt(Infinity))`).f(), true) // "Infinity" has no digits
  is(run(`export let f = () => parseInt(1e21)`).f(), 1)               // "1e+21" → 1
  is(run(`export let f = () => parseInt(1e-7)`).f(), 1)               // "1e-7" → 1
  is(run(`export let f = () => 1 / parseInt(-0)`).f(), Infinity)      // ToString(-0)="0" → +0
  is(run(`export let f = () => 1 / parseInt(-0.5)`).f(), -Infinity)   // "-0.5" → -0
  is(run(`export let f = () => parseInt(123.9)`).f(), 123)            // plain-decimal fast path
  is(run(`export let f = () => parseFloat(" 1.5")`).f(), 1.5)    // parseFloat same skip
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


test('Number/parseFloat: saturated exponents and a single exponent sign', () => {
  const { n, p } = run(`export function n(s) { return Number(s) }
    export function p(s) { return parseFloat(s) }`)
  for (const s of ['1e4294967296', '1e-4294967296', '0e9999', '1e-+2', '1e+-2', '1e+', '5e-324', '100000000000000000000e2147483647', '0.' + '0'.repeat(20000) + '1e20001']) {
    is(Object.is(n(s), Number(s)), true, 'Number ' + s)
    is(Object.is(p(s), parseFloat(s)), true, 'parseFloat ' + s)
  }
})


test('Number/parseFloat: full decimal exponent range and high-product carries', () => {
  for (const optimize of levels(0, 2, 'speed', 'size')) {
    const { num, parse } = run('export const num=s=>Number(s); export const parse=s=>parseFloat(s)', { optimize })
    for (let q = -342; q <= 308; q++) for (const mant of ['1', '2505210838544172', '9007199254740991']) {
      const input = `${mant}e${q}`, expected = Number(input)
      is(num(input), expected, `Number(${input})`)
      is(parse(input), expected, `parseFloat(${input})`)
    }
    for (const mant of ['3', '9007199254740991', '9007199254740992', '9007199254740993', '9007199254740995'])
      for (const q of [-23, -22, -1, 0, 1, 22, 23]) {
        const input = `${mant}e${q}`
        is(num(input), Number(input), `exact-operand boundary: Number(${input})`)
        is(parse(input), parseFloat(input), `exact-operand boundary: parseFloat(${input})`)
      }
    is(num(''), 0, 'empty input')
    is(parse(''), NaN, 'empty parseFloat input')
    is(num('invalid'), NaN, 'invalid input')
    is(num('5e-324'), 5e-324, 'minimum subnormal after invalid input')
  }
})

test('Number.isNaN retains the numeric proof across a nullable helper result', () => {
  const src = `function maybe(k) {
    if (k === 0) return null
    if (k === -1) return undefined
    if (k === 2) return 7
    const b = new ArrayBuffer(8), u = new Uint32Array(b), f = new Float64Array(b)
    u[1] = k === 3 ? 0xfffa0000 : 0x7ffa0000
    u[0] = 32
    return f[0]
  }
  export function f(k) {
    const n = maybe(k), v = n != null ? n : 1
    const record = {value: Number.isNaN(v) ? NaN : v}
    return [Number.isNaN(n), Number.isNaN(v), String(record.value)]
  }`
  const native = new Function(src.replace('export ', '') + ';return f')()
  for (const optimize of levels(0, 2, 3)) {
    const { f } = run(src, { optimize })
    for (const k of [0, 0, -1, 1, 1, 2, 3, 0]) is(f(k), native(k), `O${optimize}, input ${k}`)
  }
})
