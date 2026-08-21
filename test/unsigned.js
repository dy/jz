/**
 * uint32 / `>>>` correctness — regression pins for the unsigned-i32-operand family.
 *
 * `x >>> 0` (and any function proven to return one) yields a uint32 in [0, 2^32):
 * a value that lives in a wasm i32 but whose magnitude can exceed signed i32 range.
 * jz tags such nodes `.unsigned` so the f64 boundary reboxes via `convert_i32_u`.
 * Every operation that consumes the value must respect that tag — otherwise a signed
 * i32 fast-path silently miscompiles (wrap, sign-flip, or trunc_sat saturation).
 *
 * These all assert *runtime values against the JS spec*, since the bug class is
 * silent wrong-answers, not a WAT-shape change. Each block targets one leak that
 * was found and fixed:
 *   • narrow.js  — unsignedResult propagates through (tail-)call chains; mixed-sign
 *                  tails do NOT narrow to unsigned (sign must be consistent).
 *   • emit.js    — `+`/`-`/`*`/`%` and relational `<`/`>`/`<=`/`>=` skip the signed
 *                  i32 fast-path when an operand is `.unsigned` (widen to f64).
 *   • emit.js    — `>>>` const-fold ≥ 2^31 keeps `.unsigned`; foldConst / cmpOp
 *                  const-fold bail on `.unsigned` operands.
 *   • ir.js      — asF64 of an `.unsigned` i32.const widens by its uint32 value.
 */
import test from 'tst'
import { is } from 'tst/assert.js'
import { run, evaluate } from './util.js'

// ───────────────────────────────────────────────── canonical uint32 boundary

test('(x >>> 0) reboxes as uint32 across the export boundary', async () => {
  const { main } = run('export let main = (x) => x >>> 0')
  is(main(-1), 4294967295)
  is(main(-2147483648), 2147483648) // high-bit set
  is(main(0), 0)
  is(main(2147483647), 2147483647)
})

test('(x >>> 0) / 2^32 — canonical PRNG unit-interval idiom', () => {
  const { main } = run('export let main = (x) => (x >>> 0) / 4294967296')
  is(main(-1), 4294967295 / 4294967296) // 0.9999999997671694
  is(main(0), 0)
})

// ───────────────────────────────────────────── unsignedResult call-chain propagation

test('unsignedResult propagates through a tail-call helper', () => {
  const { main } = run('let toU32 = (x) => x >>> 0; export let main = (x) => toU32(x)')
  is(main(-1), 4294967295)
})

test('unsignedResult propagates through a 2-deep call chain', () => {
  const { main } = run(`
    let a = (x) => x >>> 0
    let b = (x) => a(x)
    export let main = (x) => b(x)
  `)
  is(main(-1), 4294967295)
})

test('unsigned result used in arithmetic at the call site widens (no wrap)', () => {
  const { main } = run('let u = (x) => x >>> 0; export let main = (x) => u(x) + 1')
  is(main(-1), 4294967296)
})

// ─────────────────────────────────────────────── mixed-tail sign consistency

test('mixed signed/unsigned return tails do NOT narrow to unsigned', () => {
  // One tail is `x | 0` (signed), the other `x >>> 0` (unsigned). Narrowing the
  // whole function to unsigned would corrupt the signed branch — so it must not.
  const { main } = run('export let main = (x) => { if (x < 0) return x | 0; return x >>> 0 }')
  is(main(-1), -1)        // signed branch preserved
  is(main(5), 5)          // unsigned branch (small) unaffected
})

// ─────────────────────────────────────────── arithmetic with an unsigned operand

test('`+` / `-` with an unsigned operand widen to f64 (no i32 wrap)', () => {
  is(run('export let main = (x) => (x >>> 0) + 1').main(-1), 4294967296)
  is(run('export let main = (x) => (x >>> 0) - 1').main(0), -1)
  is(run('export let main = (x) => 1 + (x >>> 0)').main(-1), 4294967296)
})

test('`*` with an unsigned operand widens (product exceeds i32)', () => {
  is(run('export let main = (x) => (x >>> 0) * 2').main(-1), 8589934590)
  is(run('let u = (x) => x >>> 0; export let main = (x) => u(x) * 2').main(-1), 8589934590)
})

test('`%` with an unsigned operand uses true uint32 value (not signed rem)', () => {
  is(run('export let main = (x) => (x >>> 0) % 7').main(-1), 4294967295 % 7) // 3
  is(run('let u = (x) => x >>> 0; export let main = (x) => u(x) % 7').main(-1), 3)
})

// ────────────────────────────────────────── relational comparison with unsigned

test('relational comparisons treat an unsigned operand by its true magnitude', () => {
  is(run('export let main = (x) => (x >>> 0) < 5').main(-1), false)   // 4294967295 < 5 → false
  is(run('export let main = (x) => (x >>> 0) > 5').main(-1), true)
  is(run('export let main = (x) => (x >>> 0) <= 5').main(-1), false)
  is(run('export let main = (x) => (x >>> 0) >= 5').main(-1), true)
  is(run('export let main = (x) => 5 < (x >>> 0)').main(-1), true)   // unsigned on the right
  is(run('let u = (x) => x >>> 0; export let main = (x) => u(x) < 5').main(-1), false)
})

test('relational comparisons on small unsigned values still correct', () => {
  is(run('export let main = (x) => (x >>> 0) < 5').main(3), true)
  is(run('export let main = (x) => (x >>> 0) > 5').main(3), false)
})

// ───────────────────────────────────────────── constant folding of unsigned

test('constant-folded `>>>` ≥ 2^31 keeps its uint32 value', async () => {
  is(await evaluate('(-1 >>> 0)'), 4294967295)
  is(await evaluate('(2147483648 >>> 0)'), 2147483648)
  is(await evaluate('(8 >>> 1)'), 4) // small value: ordinary signed const, still folds
})

test('arithmetic / comparison over a constant uint32 is spec-correct', async () => {
  is(await evaluate('(-1 >>> 0) + 1'), 4294967296)
  is(await evaluate('(-1 >>> 0) * 2'), 8589934590)
  is(await evaluate('(-1 >>> 0) % 7'), 3)
  is(await evaluate('(-1 >>> 0) < 5'), false)
  is(await evaluate('(-1 >>> 0) >= 4294967295'), true)
  is(await evaluate('(8 >>> 1) + 1'), 5) // small const folds normally
})

test('const-folded uint32 through an unsignedResult helper', () => {
  is(run('let u = (x) => x >>> 0; export let main = () => u(-1)').main(), 4294967295)
})

// ───────────────────────────────────────────── signed i32 fast-paths unaffected

test('signed i32 operands keep their fast-path semantics', async () => {
  // `| 0` produces a signed i32; none of the unsigned guards should perturb it.
  is(run('export let main = (x) => (x | 0) + 1').main(5), 6)
  is(run('export let main = (x) => (x | 0) * 2').main(5), 10)
  is(run('export let main = (x) => (x | 0) % 7').main(9), 2)
  is(run('export let main = (x) => (x | 0) < 5').main(3), true)
  is(await evaluate('3 < 5'), true)
  is(await evaluate('(-1 | 0) < 5'), true) // signed -1 < 5
})

// A Uint32Array element read is typed i32 (the 32-bit element) for fast integer/bitwise use, but
// its full 0..2^32-1 magnitude must survive EVERY use — bitwise (bits), comparison, integer and
// f64 arithmetic, and a raw value read. Unlike the `>>>`-result local below, the typed-array read
// carries its unsigned elem-aux to each use, so high values (≥ 2^31) don't sign-flip. (This is what
// lets the lorenz fade loop drop the i32→f64→i32 round-trip while staying numerically correct.)
test('uint32: Uint32Array element reads keep full unsigned range across all uses', () => {
  const e = run(`let a = new Uint32Array(2)
    export let setup = () => { a[0] = 4294967295; a[1] = 16 }
    export let raw  = () => a[0]
    export let cmp  = () => a[0] < 5 ? 1 : 0
    export let add  = () => a[0] + 1
    export let bits = () => (a[0] >>> 16) & 0xff
    export let div  = () => a[0] / 16`)
  e.setup()
  is(e.raw(), 4294967295)         // raw value read — unsigned, not -1
  is(e.cmp(), 0)                  // 4294967295 < 5 is false (unsigned compare)
  is(e.add(), 4294967296)         // value arithmetic carries the magnitude
  is(e.bits(), 255)               // bitwise on the top byte
  is(e.div(), 268435455.9375)     // f64 convert is unsigned
})

// ───────────────────────────────────────────── local-binding unsigned reads

test('unsignedness survives a local binding read outside a >>> sink', () => {
  // ROOT CAUSE (fixed): `narrowUint32` (src/compile/analyze-scans.js) proves a
  // local is a canonical uint32 accumulator from its WRITES alone — a uint32
  // literal initializer plus every reassignment shaped `name = (…) >>> k`.
  // ToUint32 is idempotent (re-masking an already-masked value is a no-op), so
  // that write invariant alone guarantees the stored bits always equal the true
  // [0, 2^32) value — independent of how the local is later READ. The old code
  // additionally required every READ to be re-sunk through its own `>>>`, which
  // wrongly dropped the `.unsigned` tag for a bare `return u`, `u + 1`, or
  // `u < 5`: the bits then reboxed SIGNED (-1 instead of 4294967295).
  //
  // A second leak in the same class: `narrowI32Results` (src/compile/narrow.js)
  // decides whether a whole function's narrowed i32 RESULT reboxes at the call/
  // export boundary via convert_i32_u or _s from its return tail's shape —
  // but only recognized a literal `>>>` or a call to an already-unsignedResult
  // function, not a bare read of the local narrowUint32 just proved unsigned.
  // A function whose only tail is `return h` (h a `>>> 0`-reassigned local)
  // narrowed to a SIGNED i32 result and reboxed -1294967296 instead of
  // 3000000000 — the exact "hashing/checksum" shape named atop this file,
  // returning the accumulator bare instead of re-masking it on the way out.
  is(run('export let main = (x) => { let u = x >>> 0; return u }').main(-1), 4294967295)
  is(run('export let main = (x) => { let u = x >>> 0; return u + 1 }').main(-1), 4294967296)
  is(run('export let main = (x) => { let u = x >>> 0; return u < 5 }').main(-1), false)
})

test('unsigned accumulator: magnitude-boundary pins (ECMA-262 §7.1.8 ToUint32)', () => {
  // ToUint32(k) = k modulo 2^32, mapped into [0, 2^32) — the exact semantics
  // `>>> 0` implements (ECMA-262 §7.1.8). A local reassigned `h = (…) >>> 0`
  // and read BARE (no further `>>>` sink on the read side) must reproduce that
  // magnitude exactly at every boundary, not just for values small enough to
  // also fit signed i32.
  const acc = (v) => run(`export let main = () => { let h = 0; h = (h + ${v}) >>> 0; return h }`).main()
  is(acc(2147483648), 2147483648)   // 2^31 — first value whose signed i32 reading goes negative
  is(acc(2147483649), 2147483649)   // 2^31 + 1
  is(acc(4294967295), 4294967295)   // 2^32 - 1 — max uint32
  // Wrap case: the accumulator crosses the 2^32 boundary through ordinary
  // addition, same as a running FNV/djb2 hash total — ToUint32 wraps it back
  // into [0, 2^32) rather than saturating or reading back negative.
  const wrapped = run(`export let main = () => {
    let h = 0
    h = (h + 4294967290) >>> 0
    h = (h + 10) >>> 0
    return h
  }`).main()
  is(wrapped, 4)   // 4294967290 + 10 = 4294967300 ≡ 4 (mod 2^32)
})
