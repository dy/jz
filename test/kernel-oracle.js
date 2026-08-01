/**
 * Kernel ORACLE tier — three-way execution parity: HOST JS vs NATIVE-compiled
 * vs KERNEL-compiled, for the same source.
 *
 * THE LESSON (re-audit #5 item 4, ledger "KERNEL LEG ZERO FAILS", boolconst row):
 * test/kernel-parity.js proves native-vs-kernel BYTE IDENTITY. Byte identity
 * certifies identically-WRONG output just as readily as identically-right —
 * the boolconst mechanism (below) produces the SAME wrong WAT from both
 * compilers, and a byte-diff test is structurally blind to that: it can only
 * ever say "they agree", never "they're correct". Semantic rows need a JS
 * ORACLE (the same source is valid JS — "valid jz === valid JS" — so plain
 * `import()` of it IS the reference implementation) plus EXECUTION of both
 * compiled modules, not just comparison of their text.
 *
 * # Three tiers
 *   AGREE      — native, kernel, and the JS oracle must all produce the exact
 *                same result (deep-equal: numbers incl. NaN/-0, strings,
 *                bigints, arrays, typed arrays, objects).
 *   DIVERGENT  — a documented, intentional-or-known departure from naive JS
 *                semantics (rational constant-folding trades bit-exactness
 *                for precision by design; the kernel's i64-carrier/subnormal
 *                collision is README's own documented self-host limit). These
 *                get an explicit pinned expectation and a reasoned comment,
 *                never a silent skip — a silent skip is indistinguishable
 *                from "nobody checked".
 *   PENDING-FIX — a REAL finding this harness surfaced: native (not just the
 *                kernel) currently disagrees with the JS oracle. The CURRENT
 *                wrong value is asserted explicitly with a TODO-flip comment,
 *                plus a `not()` tripwire — the moment a fix lands elsewhere,
 *                the tripwire fails and says exactly what to flip.
 *
 * Execution, not just codegen inspection: every row calls real exported
 * functions with real arguments on all three legs. Sources are self-
 * contained (zero-arg or plain-value args) so the JS oracle needs nothing
 * beyond `import()`-ing the exact same string jz compiled.
 *
 * @module test/kernel-oracle
 */
import test from 'tst'
import { is, not } from 'tst/assert.js'
import jz from '../index.js'
import { CORPUS } from './kernel-parity.js'
import { compileViaKernel } from './kernel-target.js'
import { instantiate } from '../interop.js'
import { onWasi } from './_matrix.js'

// The oracle: the exact same source, imported as a plain ES module. Valid jz
// source IS valid JS (export syntax, no jz-only sugar in any row below), so
// this needs no transform — the module namespace's exports ARE the reference.
const oracle = (src) => import(`data:text/javascript,${encodeURIComponent(src)}`)

// Instantiate the kernel-compiled bytes through the same interop.js `instantiate`
// index.js uses internally (jz()'s own instantiateRuntime) — identical export
// wrapping (heap values decode to real JS arrays/strings/objects; i64 carriers
// reinterpret) on both legs, so a mismatch can only be a real value difference,
// never a marshaling artifact.
const runKernel = (src, opt) => instantiate(compileViaKernel(src, { optimize: opt })).exports
const runNative = (src, opt) => jz(src, { optimize: opt }).exports

// ── AGREE tier ───────────────────────────────────────────────────────────
// Reuses kernel-parity.js's own CORPUS (same source text — one corpus, two
// questions asked of it: "same bytes?" there, "correct execution?" here) plus
// a handful of new rows for mechanisms the byte-identity CORPUS doesn't touch
// at the call-argument level: dynamic property keys and closure captures
// across loop iterations.
const AGREE = [
  { name: 'sum', src: CORPUS.sum, calls: [{ fn: 'sum', args: [0] }, { fn: 'sum', args: [10] }, { fn: 'sum', args: [100] }] },
  { name: 'math', src: CORPUS.math, calls: [{ fn: 'f', args: [3] }, { fn: 'f', args: [-4.5] }, { fn: 'f', args: [0] }] },
  { name: 'dict', src: CORPUS.dict, calls: [{ fn: 'count', args: ['banana'] }, { fn: 'count', args: [''] }] },
  { name: 'arr', src: CORPUS.arr, calls: [{ fn: 'rev', args: [0] }, { fn: 'rev', args: [7] }] },
  { name: 'mfold', src: CORPUS.mfold, calls: [{ fn: 'g', args: [] }] },
  // Self-host miscompile #4/#5 (kernel-parity.js's audit-#5 shapes): nested
  // same-family typed-array construction and TypedArray.from with a nested
  // literal element. Both were fixed at the closure-capture-before-nested-emit
  // root — this is the execution-level check that the fix is semantically
  // correct, not just byte-stable.
  { name: 'nestedtyped', src: CORPUS.nestedtyped, calls: [{ fn: 'f', args: [3] }, { fn: 'f', args: [-1.5] }, { fn: 'f', args: [2 ** 33] }] },
  { name: 'fromnested', src: CORPUS.fromnested, calls: [{ fn: 'f', args: [] }] },
  // New (oracle-only): the SUBVIEW branch of the same new.${name} closure family
  // as nestedtyped/fromnested (module/typedarray.js's per-iteration emitter) —
  // `new T(buffer, off, len)` with the len argument itself a nested typed-array
  // `.length` read, forcing the SAME closure to re-read `stride`/`name` after a
  // nested emit(). Self-contained (builds its own buffer) so the JS oracle needs
  // no host-object argument marshaling; returns a scalar (sum of the first two
  // i32 lanes of a written f64) so three-way comparison is a plain number.
  { name: 'subviewtyped-mechanism',
    src: `export let f = () => { let buf = new ArrayBuffer(64); let fa = new Float64Array(buf); fa[0] = 3.25; let ia = new Int32Array(buf, 0, new Float64Array(4).length); return ia[0] + ia[1] }`,
    calls: [{ fn: 'f', args: [] }] },
  // New (oracle-only): the DataView get/set closures (DV_GET/DV_SET loops) —
  // a DataView call nesting another DataView call in an offset/value position,
  // same closure-capture-after-nested-emit family. Self-contained: builds its
  // own buffer, mutates in place, reads back through a second view.
  { name: 'dvnested-mechanism',
    src: `export let f = () => { let buf = new ArrayBuffer(24); let dv = new DataView(buf); dv.setInt32(0, 8); dv.setFloat64(8, 3.25); dv.setFloat64(dv.getInt32(0), dv.getFloat64(8)); return new Float64Array(buf)[1] }`,
    calls: [{ fn: 'f', args: [] }] },
  // New: dynamic (computed, non-literal) property key read-after-write —
  // the o[k]=v / o[k] shape static.js's schema/hash classification has to
  // treat as a genuine dynamic key (no compile-time-known key set).
  { name: 'dynkey',
    src: `export let f = (k, v) => { let o = {}; o[k] = v; return o[k] }`,
    calls: [{ fn: 'f', args: ['a', 1] }, { fn: 'f', args: ['xyz', 42.5] }] },
  // New: closure capturing and mutating an outer `let` across loop iterations
  // (the accumulator-in-closure shape — distinct from the byte-identity
  // CORPUS's recursionUnroll-class rows, which are same-function recursion,
  // not a nested closure reading/writing a captured outer binding).
  { name: 'closure',
    src: `export let make = (n) => { let total = 0; const add = (x) => { total += x; return total }; for (let i = 0; i < n; i++) add(i); return total }`,
    calls: [{ fn: 'make', args: [5] }, { fn: 'make', args: [0] }] },
  // FLIPPED from PENDING-FIX (audit #5 item 2, ledger "KERNEL LEG ZERO FAILS"
  // boolconst row — THE LESSON's own named example): a helper mixing a NUMBER
  // return with a bare `false` return, checked via `=== false` at the call
  // site. Fixed at the return-STATEMENT boxing root (src/compile/emit.js
  // 'return', gated by src/compile/index.js emitFunc's ctx.func.mixedAtomReturn —
  // a func with >= 2 syntactic return statements that isn't proven uniformly
  // BOOL now boxes any individually-BOOL return tail to its TRUE_NAN/FALSE_NAN
  // atom, matching the "unknown operand carries booleans boxed" invariant the
  // rest of the compiler already assumed). Both native AND kernel now agree
  // with the JS oracle — the AGREE tier is the correct home now, not a
  // PENDING-FIX not()-tripwire.
  { name: 'boolconst', src: CORPUS.boolconst,
    calls: [{ fn: 'f', args: [5] }, { fn: 'f', args: ['hi'] }, { fn: 'f', args: [true] }] },
  // FLIPPED from PENDING-FIX (.work/bool-merge-identity-design.md — the
  // ambiguous BOOL-merge identity fix): `cond ? 1 : false` used as a return
  // value, observed via `=== false` at a DIFFERENT function's call site (the
  // function-boundary mechanism, distinct from boolconst's own — this one
  // routes through kind.js's hasAmbiguousBoolMerge + emit.js emitIdentitySafe,
  // wired at the return-tail (src/compile/index.js emitFunc's mixedAtomReturn
  // additive single-return admission + the top-level expression-body site) and
  // at emitStrictEq's differing-class fold/box decision. Was previously
  // documented as an open, different-mechanism gap from boolconst (its own
  // comment lived here); now fixed at the same conceptual root (an atom must
  // cross unboxed at NO identity-observing site), generalized rather than
  // patched per-shape.
  { name: 'ternary-bool-merge-return', src: `const g = (s) => s ? 1 : false
export let f = (s) => g(s) === false`,
    calls: [{ fn: 'f', args: [true] }, { fn: 'f', args: [false] }] },
  // New AGREE rows for the WIDER live envelope the same design doc found
  // (7b/7c/10a) — all four fire through emitStrictEq's differing-primitive-
  // class static fold / emitTypeofCmp's static fold trusting the ambiguous
  // BOOL-vs-NUMBER merge coercion (kind.js VT['?:']/VT['&&']), no function
  // boundary needed for any of these three (inline within one function).
  { name: 'ternary-bool-merge-inline-eq',
    src: `export let f = (s) => (s ? 1 : false) === false`,
    calls: [{ fn: 'f', args: [true] }, { fn: 'f', args: [false] }] },
  { name: 'ternary-bool-merge-typeof',
    src: `export let f = (s) => typeof (s ? 1 : false)`,
    calls: [{ fn: 'f', args: [true] }, { fn: 'f', args: [false] }] },
  { name: 'and-bool-merge-eq',
    src: `export let f = (x) => ((x > 0) && 1) === false`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
]

for (const opt of [0, 2, 3]) {
  test(`kernel oracle: native + kernel agree with JS at O${opt}`, async () => {
    // Same rationale as kernel-parity.js's wasi guard: the WASI boundary
    // shims are a native-only construction, orthogonal to what this tier checks.
    if (onWasi()) return
    for (const { name, src, calls } of AGREE) {
      const mod = await oracle(src)
      const nat = runNative(src, opt)
      const ker = runKernel(src, opt)
      for (const { fn, args } of calls) {
        const want = mod[fn](...args)
        is(nat[fn](...args), want, `${name} O${opt}: native ${fn}(${args.map(String).join(', ')}) vs JS oracle`)
        is(ker[fn](...args), want, `${name} O${opt}: kernel ${fn}(${args.map(String).join(', ')}) vs JS oracle`)
      }
    }
  })
}

// ── DIVERGENT tier: documented departures from naive JS, not bugs ─────────

// preEval's rational constant-folding (src/prepare/pre-eval.js) carries an
// EXACT rational through a whole numeric chain and rounds ONCE at the end
// (module doc, "Purity / precision guards": `optimize.rationalConst !== false`,
// default ON). Naive JS rounds after EVERY op ("double rounding"). For
// `0.1 + 0.2 - 0.3` these genuinely disagree: JS's sequential rounding gives
// 5.551115123125783e-17; jz's single-rounding exact-rational fold gives
// 2.7755575615628914e-17 (exactly half — the classic double-rounding artifact
// for this literal triple). This is NOT the native/kernel divergence audit
// P0-2 fixed (that was native-vs-kernel disagreeing with EACH OTHER over HOST
// bigint width — both now compute the SAME rational-fold answer); it is jz's
// constant-fold disagreeing with naive JS BY DESIGN, on both legs identically.
// The escape hatch (`optimize.rationalConst: false`) is asserted too, as the
// design's own regression pin: turning rational folding off must recover
// exact JS-oracle parity.
test('kernel oracle: fold — documented divergence (rational constant-fold vs naive JS double-rounding)', async () => {
  if (onWasi()) return
  const src = CORPUS.fold
  const mod = await oracle(src)
  const want = mod.f()
  is(want, 5.551115123125783e-17, 'JS oracle baseline (pin so a V8 change is visible, not silently absorbed)')
  for (const opt of [0, 2, 3]) {
    const nat = runNative(src, opt).f()
    const ker = runKernel(src, opt).f()
    is(nat, 2.7755575615628914e-17, `fold O${opt}: native's single-rounding rational fold (documented, not naive-JS-equal)`)
    is(ker, nat, `fold O${opt}: kernel matches native exactly (both fold the same way)`)
  }
  // rationalConst:false is the documented escape hatch — with it, jz folds via
  // plain sequential per-op f64 rounding and MUST recover oracle parity.
  is(runNative(src, { level: 2, rationalConst: false }).f(), want,
    'fold: rationalConst:false recovers naive-JS parity (proves the divergence above is a chosen tradeoff, not an uncontrolled bug)')
})

// README's own documented self-host limit (README.md, "One known divergence
// class"): inside dist/jz.wasm, BigInt values ride raw i64 bits in an f64
// slot, and small-magnitude bit patterns collide with subnormal Numbers (`1n`
// and `5e-324` are the same 64 bits) — so the KERNEL misreads a negative
// subnormal literal. Native has no such collision (P0-2 tagged the literal's
// AST kind directly). This is the oracle-tier version of that same pin
// (test/data.js's P0-2 test, `onKernel()`-gated for `JZ_TEST_TARGET=jz.wasm`
// runs of the WHOLE suite): here BOTH legs run unconditionally in one process,
// so the divergence is asserted directly instead of behind an env-var branch.
test('kernel oracle: subnormal literal — documented divergence (kernel-only, README self-host note)', async () => {
  if (onWasi()) return
  const src = 'export let f = () => -5e-324'
  const mod = await oracle(src)
  const want = mod.f()
  is(want, -5e-324, 'JS oracle baseline')
  for (const opt of [0, 2, 3]) {
    is(runNative(src, opt).f(), want, `subnormal O${opt}: native matches JS oracle exactly (AST-tagged literal kind, no carrier ambiguity)`)
    is(runKernel(src, opt).f(), -1, `subnormal O${opt}: kernel misreads the literal as the colliding BigInt bit pattern (documented; README "One known divergence class")`)
  }
})

// ── PENDING-FIX tier: a REAL finding, not a documented tradeoff ───────────
//
// (boolconst LANDED — moved to the AGREE array above. It lived here as a
// PENDING-FIX not()-tripwire from re-audit #5 item 4 until the mixed
// BOOL|NUMBER return-representation class it named was fixed generically —
// audit #5 item 2, see AGREE's boolconst comment for the fix location.)
//
// A sibling, DIFFERENT-mechanism gap the same audit item's sweep surfaced and
// deliberately did NOT fix: a ternary `cond ? 1 : false` used AS a return
// value. The return-statement fix above only boxes a return whose own static
// valType is BOOL; `s ? 1 : false`'s valType is (by src/compile/emit.js '?:'
// design) NUMBER — the ternary handler intentionally keeps a BOOL∪NUMBER arm
// pair raw so `x + (cond ? 1 : false)` stays correct arithmetic (its `?:` has
// no notion of its own consumer — return position vs arithmetic position).
// Forcing the box unconditionally at every such ternary would reopen the
// REVERTED broad fix's exact failure mode: an arithmetic consumer statically
// proven "numeric arm" (emit.js isNumArm) would read a NaN atom's raw bits as
// if they were the number, corrupting `+`. Same root (an atom crosses
// unboxed at a boxed-value observation site), different, riskier mechanism
// (needs consumer-position-aware context threading through emit(), not a
// return-statement gate) — documented and pinned, not fixed, per the audit's
// own "map it, fix if same-root, pin regardless" instruction.
test('kernel oracle: ternary BOOL|NUMBER return — AGREE (closed by the ambiguous-BOOL-merge identity work)', async () => {
  // Was PENDING FIX: g(false) returned the `false` atom collapsed to raw 0.0,
  // so `g(s) === false` read false for both arguments. Closed by
  // .work/bool-merge-identity-design.md — hasAmbiguousBoolMerge admits the
  // single-return ternary at the return tail, and emitStrictEq's differing-
  // class fold defers to the identity-safe path for ambiguous operands. The
  // former not() tripwire fired as designed; this is its designed rewrite.
  if (onWasi()) return
  const src = `const g = (s) => s ? 1 : false
export let f = (s) => g(s) === false`
  const mod = await oracle(src)
  const cases = [
    { args: [true], want: false },  // g(true)=1 (number); 1 === false → false
    { args: [false], want: true },  // g(false)=false (atom); false === false → true
  ]
  for (const { args, want } of cases) is(mod.f(...args), want, `ternary: JS oracle baseline f(${args.map(String)})`)
  for (const opt of [0, 2, 3]) {
    const nat = runNative(src, opt).f
    const ker = runKernel(src, opt).f
    for (const { args, want } of cases) {
      is(nat(...args), want, `ternary O${opt}: native f(${args.map(String)}) agrees with JS`)
      is(ker(...args), want, `ternary O${opt}: kernel f(${args.map(String)}) agrees with JS`)
    }
  }
})
