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

// boolconst (kernel-parity.js CORPUS, the exact row THE LESSON names): a
// helper mixing a NUMBER return with a bare `false` return, checked via
// `=== false` at the call site. kernel-parity.js's comment describes this as
// FIXED at "the narrowest sound root" (module/typedarray.js's isConst, which
// now returns `null` instead of overloading `false`) and says explicitly that
// "this class of return-boxing gap [may remain] elsewhere in the compiler."
// Running THIS generic shape through the oracle proves that remark true: it
// is NOT fixed in general, and — this is the finding the byte-identity tier
// structurally cannot see — it is wrong on NATIVE ALONE, with no kernel/self-
// host involvement at all. Verified directly (not just via this file):
//   node -e "import('./index.js').then(({default:jz}) => {
//     const src = \`const g=(n)=>{if(typeof n==='number')return n;return false}
//     export let f=(s)=>g(s)===false\`
//     for (const opt of [0,1,2,3])
//       console.log(opt, jz(src,{optimize:opt}).exports.f('hi'))  // false at every opt — should be true
//   })"
// Root cause (matches the ledger's own description of the class): the boolean
// literal's cheap i32 0/1 representation only gets boxed into a real f64
// TRUE/FALSE atom at a handful of explicit escape sites; a NUMBER-mixed
// generic-f64 `return` isn't one of them, so `return false` here silently
// crosses as the plain float 0 — indistinguishable from a genuine `0` at
// `=== false`. Asserting the CURRENT (wrong) value with a `not()` tripwire
// against the JS oracle: the moment this class is fixed generically, the
// tripwire fails and names exactly which line to flip to the AGREE tier.
test('kernel oracle: boolconst — PENDING FIX, native (not kernel-specific) return-boxing gap', async () => {
  if (onWasi()) return
  const src = CORPUS.boolconst
  const mod = await oracle(src)
  const cases = [
    { args: [5], want: false },     // typeof 5 === 'number' → g returns 5 → 5 === false → false (this one is correct)
    { args: ['hi'], want: true },   // g returns false → false === false → true (jz currently returns false — WRONG)
    { args: [true], want: true },   // same shape as above
  ]
  for (const { args, want } of cases) is(mod.f(...args), want, `boolconst: JS oracle baseline f(${args.map(String)})`)
  for (const opt of [0, 2, 3]) {
    const nat = runNative(src, opt).f
    const ker = runKernel(src, opt).f
    for (const { args, want } of cases) {
      const gotNat = nat(...args), gotKer = ker(...args)
      is(gotKer, gotNat, `boolconst O${opt}: kernel matches native (same wrong mechanism on both legs, THE LESSON's own point)`)
      if (want === false) {
        is(gotNat, want, `boolconst O${opt}: f(${args.map(String)}) already correct`)
      } else {
        // TODO(flip): once the generic return-boxing gap is fixed, gotNat === want (true) —
        // change this to `is(gotNat, want, ...)` and delete the `not()` tripwire above it.
        is(gotNat, false, `boolconst O${opt}: f(${args.map(String)}) CURRENT wrong value (should be ${want}) — TODO-flip once fixed`)
        not(gotNat, want, `boolconst O${opt}: f(${args.map(String)}) known miscompile vanished — flip this case to the AGREE tier (is(gotNat, want, …))`)
      }
    }
  }
})
