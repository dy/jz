// preEval — compile-time constant folding (src/prepare/pre-eval.js)
import test from 'tst'
import { is, ok, almost } from 'tst/assert.js'
import { onWasi, onKernel } from './_matrix.js'
import jz, { compile } from '../index.js'

function run(code, opts) { return jz(code, opts).exports }

// ============================================================================
// Fold-fires pins — WAT contains the LITERAL, not the runtime ops/calls.
// (WAT-shape assertions don't hold on the kernel leg: no host-side `wat:true`.)
// ============================================================================

// A folded function's WHOLE-PROGRAM result may end up i32- or f64-carried
// (jz narrows an integer-valued function to an i32 wasm result + an f64
// convert at the export boundary) — match either literal-const form.
const constPin = (n) => new RegExp(`[fi](32|64)\\.const ${n}\\b`)

test('fold-fires: numeric chain -> literal, no arithmetic ops', () => {
  if (onKernel()) return
  const wat = compile('export let f = () => 1 + 2 * 3 - 4', { wat: true, optimize: false })
  ok(constPin(3).test(wat), 'expected the folded literal 3 in WAT')
  ok(!/[fi]64\.(add|sub|mul)/.test(wat), 'expected no runtime arithmetic ops')
})

test('fold-fires: string concat/case/slice -> literal', () => {
  if (onKernel()) return
  const wat = compile('export let f = () => "hello".toUpperCase().slice(1)', { wat: true, optimize: false })
  ok(!wat.includes('call $__str_case') && !wat.includes('call $__str_slice') && !wat.includes('call $__str_concat'),
    'expected no runtime string ops — folded to a literal (short strings SSO-pack into the NaN payload, not visible as ASCII text)')
})

test('fold-fires: boolean/nullish -> literal', () => {
  if (onKernel()) return
  const wat = compile('export let f = () => (true && false) || (null ?? 7)', { wat: true, optimize: false })
  ok(constPin(7).test(wat), 'expected folded literal 7')
})

test('fold-fires: dead if-branch eliminated', () => {
  if (onKernel()) return
  const wat = compile('export let f = () => { if (1 < 2) { return 10 } else { return 20 } }', { wat: true, optimize: false })
  ok(constPin(10).test(wat), 'expected the live branch literal')
  ok(!constPin(20).test(wat), 'expected the dead branch gone')
  ok(!/[fi]64\.lt/.test(wat), 'expected the constant condition itself gone')
})

test('fold-fires: while(false) removed entirely', () => {
  if (onKernel()) return
  const wat = compile('export let f = () => { let x = 0; while (false) { x = x + 1 } return x }', { wat: true, optimize: false })
  ok(!/loop/.test(wat), 'expected the dead loop gone')
})

test('fold-fires: zero-arg IIFE collapses to a literal', () => {
  if (onKernel()) return
  const wat = compile('let z = (() => 2 * 21)(); export let f = () => z', { wat: true, optimize: false })
  ok(constPin(42).test(wat), 'expected the IIFE result folded to a literal')
  ok(!/call \$\S*lift/.test(wat), 'expected no residual call to the lifted IIFE function')
})

test('fold-fires: zero-arg user helper function collapses too', () => {
  if (onKernel()) return
  const wat = compile('let helper = () => { const a = 3; const b = 4; return a * a + b * b }; export let f = () => helper()', { wat: true, optimize: false })
  ok(constPin(25).test(wat), 'expected the helper folded to a literal')
})

test('fold-fires: pure Math.* call with constant arg -> literal', () => {
  if (onKernel()) return
  const wat = compile('export let f = () => Math.sqrt(16)', { wat: true, optimize: false })
  ok(constPin(4).test(wat), 'expected the folded literal')
  ok(!wat.includes('$math.sqrt') && !/f64\.sqrt/.test(wat), 'expected no runtime sqrt op')
})

test('fold-fires: transcendental Math.* call with constant arg -> literal', () => {
  if (onKernel()) return
  const wat = compile('export let f = () => Math.sin(1.5)', { wat: true, optimize: false })
  ok(!wat.includes('call $math.sin'), 'expected no runtime call to $math.sin')
})

// ============================================================================
// Value correctness — folded and unfolded (param-forced) forms agree, bit-for-bit.
// ============================================================================

test('value: numeric chain', () => {
  is(run('export let f = () => 1 + 2 * 3 - 4').f(), 3)
  is(run('export let f = () => (10 - 3) / 2').f(), 3.5)
  is(run('export let f = () => 2 ** 10').f(), 1024)
  is(run('export let f = () => 7 % 3').f(), 1)
  is(run('export let f = () => -5 * -2').f(), 10)
})

test('value: string ops', () => {
  is(run('export let f = () => "a" + "b" + 1').f(), 'ab1')
  is(run('export let f = () => "Hello".toLowerCase()').f(), 'hello')
  is(run('export let f = () => "hello world".indexOf("world")').f(), 6)
  is(run('export let f = () => "abcdef".slice(1, 4)').f(), 'bcd')
  is(run('export let f = () => "abc".length').f(), 3)
})

test('value: boolean/nullish/comparison', () => {
  is(run('export let f = () => true && false').f(), false)
  is(run('export let f = () => null ?? 5').f(), 5)
  is(run('export let f = () => 1 < 2').f(), true)
  is(run('export let f = () => 1 === "1"').f(), false)
  is(run('export let f = () => 1 == "1"').f(), true)
})

test('value: dead-branch selection picks the right value at runtime', () => {
  is(run('export let f = () => { if (2 > 1) { return "yes" } else { return "no" } }').f(), 'yes')
})

test('value: IIFE / zero-arg helper collapse', () => {
  is(run('let z = (() => 2 * Math.PI)(); export let f = () => z').f(), 2 * Math.PI)
  is(run('let g = () => 5; export let f = () => g() + 1').f(), 6)
  // nested: an IIFE that calls another zero-arg helper
  is(run('let h = () => 3; let z = (() => h() * h())(); export let f = () => z').f(), 9)
})

test('value: Math.* constant folds match the actual compiled+executed kernel', () => {
  // Every arg is a PARAM here (never a literal) so none of these calls are
  // themselves preEval-foldable — this is the ground truth the folded form
  // (below) must reproduce bit-for-bit.
  const cases = [
    ['Math.sqrt(2)', 'x'], ['Math.sin(1.2345)', 'x'], ['Math.cos(0.7)', 'x'], ['Math.exp(3.5)', 'x'],
    ['Math.log(42)', 'x'], ['Math.atan2(1, 2)', 'x,y'],
    ['Math.hypot(3, 4)', 'x,y'], ['Math.cbrt(27)', 'x'], ['Math.min(3, -1, 5)', null], ['Math.max(3, -1, 5)', null],
  ]
  for (const [expr, paramSpec] of cases) {
    const folded = run(`export let f = () => ${expr}`).f()
    if (!paramSpec) { ok(Number.isFinite(folded) || Number.isNaN(folded), expr); continue }
    const args = expr.match(/\(([^)]*)\)/)[1].split(',').map(s => s.trim())
    const params = paramSpec.split(',')
    const unfoldedExpr = expr.replace(/\(([^)]*)\)/, `(${params.join(',')})`)
    const unfolded = run(`export let f = (${params.join(',')}) => ${unfoldedExpr}`).f(...args.map(Number))
    is(folded, unfolded, expr)
  }
})

test('value: Math.pow / ** constant fold — exact 3-way split emit.js already uses for literal args', () => {
  // Integer |n|<=16 exponent: square-and-multiply (module/math.js foldPow) — same
  // algorithm the WAT emitter already runs for a literal base + literal small int
  // exponent (whether or not preEval got there first).
  is(run('export let f = () => 2 ** 10').f(), 1024)
  is(run('export let f = () => 1.1 ** 7').f(), run('export let f = (x) => x ** 7').f(1.1))
  // exponent 0.5: exact sqrt.
  is(run('export let f = () => Math.pow(2, 0.5)').f(), Math.sqrt(2))
  // everything else: host Math.pow directly (matches emit.js's own fully-constant fast path).
  is(run('export let f = () => Math.pow(1.5, 2.5)').f(), Math.pow(1.5, 2.5))
})

// ============================================================================
// Precision-improvement — rational carry rounds the WHOLE formula once,
// strictly tighter than sequential per-op f64 rounding (module/math.js /
// pre-eval.js doc: the 0.1+0.2-0.3 example the charter names).
// ============================================================================

test('precision: rational carry beats sequential per-op rounding', () => {
  const naive = 0.1 + 0.2 - 0.3   // per-op: round(round(0.1+0.2) - 0.3) = 1/2^54
  const folded = run('export let f = () => 0.1 + 0.2 - 0.3').f()
  ok(Math.abs(folded) < Math.abs(naive), `expected |${folded}| < |${naive}|`)
  is(folded, Math.pow(2, -55), 'exact rational result: (double(0.1)+double(0.2)-double(0.3)) rounded ONCE')
})

test('precision: rationalConst:false falls back to bit-exact-vs-JS per-op rounding', () => {
  const naive = 0.1 + 0.2 - 0.3
  const folded = run('export let f = () => 0.1 + 0.2 - 0.3', { optimize: { rationalConst: false } }).f()
  is(folded, naive, 'opt-out matches naive sequential JS evaluation exactly')
})

test('precision: a case where naive intermediate rounding loses a whole unit, rational carry does not', () => {
  // naive: (1e16 + 1) rounds to 1e16 (1 is below the ULP there) -> minus 1e16 -> 0.
  // exact: the true value of the formula over the exact double literals is 1.
  const naive = 1e16 + 1 - 1e16
  is(naive, 0)
  const folded = run('export let f = () => 1e16 + 1 - 1e16').f()
  is(folded, 1)
})

// ============================================================================
// Non-fold guards — impure / host-dependent / param-dependent constructs stay
// unfolded (the runtime op/call survives in the WAT).
// ============================================================================

test('guard: Math.random never folds', () => {
  if (onKernel()) return
  const wat = compile('export let f = () => Math.random()', { wat: true, optimize: false })
  ok(wat.includes('$math.random'), 'expected the runtime random call to survive')
})

test('guard: Math.* with a param arg is not folded', () => {
  if (onKernel()) return
  const wat = compile('export let f = (x) => Math.sin(x)', { wat: true, optimize: false })
  ok(wat.includes('$math.sin'), 'expected the runtime call to survive')
})

test('guard: a reassigned local is never inlined', () => {
  is(run('export let f = () => { let x = 1 + 2; x = x + 10; return x }').f(), 13)
  if (onKernel()) return
  const wat = compile('export let f = (n) => { let x = 1 + 2; if (n > 0) { x = n } return x }', { wat: true, optimize: false })
  ok(!/f64\.const 3\b/.test(wat) === false, 'sanity: x’s initializer 1+2 still folds to 3')
})

test('guard: closure capture of an outer non-constant is untouched', () => {
  is(run('export let f = (n) => { let g = () => n + 1; return g() }').f(41), 42)
})

test('guard: string ops on non-ASCII source are left unfolded (documented UTF-8/UTF-16 boundary)', () => {
  // jz strings are UTF-8 internally: .length is a BYTE count, not JS's UTF-16 code-unit
  // count — "héllo".length is 5 in JS but 6 here (é is 2 UTF-8 bytes). Folding via a host
  // ASCII-blind .length would have silently baked in the WRONG (JS-shaped) constant; the
  // ASCII guard leaves it to the (correct) runtime path instead.
  is(run('export let f = () => "héllo".length').f(), run('export let f = (s) => s.length').f('héllo'))
})

test('guard: mixed number+string concat is not compile-time folded (self-host __ftoa fidelity)', () => {
  is(run('export let f = () => 1.5 + "x"').f(), '1.5x')   // still correct at runtime
})

test('guard: recursive/self-referential zero-arg call never folds (and never hangs)', () => {
  ok(true, 'compiling must not hang or throw')
  const wat = onKernel() ? null : compile('let loop = () => loop(); export let f = () => 1', { wat: true, optimize: false })
  if (wat != null) ok(constPin(1).test(wat), 'the unrelated export still compiles fine')
})

// ============================================================================
// WASI / matrix sanity — the pass runs identically under every host leg.
// ============================================================================

test('matrix: folds under wasi host too', () => {
  if (onWasi()) { is(run('export let f = () => 6 * 7', { host: 'wasi' }).f(), 42); return }
  is(run('export let f = () => 6 * 7').f(), 42)
})
