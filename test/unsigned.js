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
  is(run('export let main = (x) => (x >>> 0) < 5').main(-1), 0)   // 4294967295 < 5 → false
  is(run('export let main = (x) => (x >>> 0) > 5').main(-1), 1)
  is(run('export let main = (x) => (x >>> 0) <= 5').main(-1), 0)
  is(run('export let main = (x) => (x >>> 0) >= 5').main(-1), 1)
  is(run('export let main = (x) => 5 < (x >>> 0)').main(-1), 1)   // unsigned on the right
  is(run('let u = (x) => x >>> 0; export let main = (x) => u(x) < 5').main(-1), 0)
})

test('relational comparisons on small unsigned values still correct', () => {
  is(run('export let main = (x) => (x >>> 0) < 5').main(3), 1)
  is(run('export let main = (x) => (x >>> 0) > 5').main(3), 0)
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
  is(await evaluate('(-1 >>> 0) < 5'), 0)
  is(await evaluate('(-1 >>> 0) >= 4294967295'), 1)
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
  is(run('export let main = (x) => (x | 0) < 5').main(3), 1)
  is(await evaluate('3 < 5'), 1)
  is(await evaluate('(-1 | 0) < 5'), 1) // signed -1 < 5
})

// ───────────────────────────────────────────── KNOWN LIMITATION (not yet fixed)

test.todo('unsignedness survives a local binding read outside a >>> sink', () => {
  // ROOT CAUSE: `narrowUint32` (src/analyze.js) only keeps a local as unsigned i32
  // for the canonical accumulator pattern — a uint32 *literal* initializer where
  // *every* read is funnelled through a `>>>` (ToUint32) sink (FNV/PRNG hash loops).
  // A local initialized from `x >>> 0` and read raw (bare `return u`, or `u + 1`,
  // `u < 5`) doesn't qualify, so the uint32 tag is dropped and the bits rebox signed
  // (-1 instead of 4294967295). Extending unsigned tracking to such reads is sound
  // but must preserve narrowUint32's "every use is ToUint32-sunk" guarantee, so it's
  // a wider analyzeBody change deferred from this pass. Flip `test.todo` → `test` then.
  is(run('export let main = (x) => { let u = x >>> 0; return u }').main(-1), 4294967295)
  is(run('export let main = (x) => { let u = x >>> 0; return u + 1 }').main(-1), 4294967296)
  is(run('export let main = (x) => { let u = x >>> 0; return u < 5 }').main(-1), 0)
})
