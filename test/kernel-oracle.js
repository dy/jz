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
  // FLIPPED from PENDING-FIX (.work/todo.md §deletion-sweep — the
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
  // FLIPPED from PENDING-FIX (research.md §Carrier invariant MECHANISM A — the
  // container-store carrier-collapse rows below this array): storedValue
  // promoted from src/compile/emit-assign.js to src/bridge.js as the ONE
  // producer chokepoint, replacing 16 raw `carrierF64(node, emit(node))`
  // call sites across module/array.js, module/collection.js, module/
  // object.js (a local, unguarded clone), module/function.js — plus three
  // MORE unguarded sites the promotion surfaced (not in the design's
  // original 16): bridge.js's own `coerce` 'I'-sig helper (used by every
  // `call()`/`method()` stdlib registration, incl. Set.add), emit.js's
  // generic direct-call `coerceArg`/`emitCallArgs` (a bare `emit(a)` before
  // any hasAmbiguousBoolMerge check — fixed via a single-emission `argIR`
  // helper so the ambiguous case re-emits through emitIdentitySafe instead
  // of double-evaluating), and emit.js's flat/SRoA object-literal field
  // init (was a bare `asF64(emit(v))`, never boxing a proven-BOOL value at
  // all, let alone an ambiguous merge). The generic SCALAR `let`/`const`
  // declaration init site (module-level, not flat/SRoA) has the SAME gap
  // but is NOT fixed here — every implementation shape tried miscompiled
  // the self-hosted kernel's own compiled emitDecl at that exact call site
  // (verified live with a fresh dist rebuild); banked, see emit.js's
  // emitDecl comment and the 'captured-then-read' PENDING-FIX row below.
  // Also required two ROOT-CAUSE type-inference fixes (not container-store
  // sites, but load-bearing for these exact rows): src/type.js's exprType
  // '?:'/'&&'/'||' conciliation vetoes
  // i32 STORAGE classification for an ambiguous-merge node (it only asked
  // "is each branch i32-representable", not "do the branches carry the same
  // represented value" — this fed BOTH narrowI32Results' return-tail
  // narrowing and the param lattice's argWasmType, silently narrowing a
  // whole function or parameter to i32 and permanently losing the FALSE atom
  // at the f64 export/callee rebox no downstream boxing fix could recover);
  // and narrow.js's inferValAtSite declines to harden a param's `val` fact
  // to NUMBER from an ambiguous-merge call-site argument (the SAME
  // "unknown side → no claim" principle valTypeOfWithLocals's SOUND `+`
  // rule already applies), closing a cross-function-boundary identity fold
  // in emitStrictEq's differing-primitive-class shortcut.
  { name: 'array literal',
    src: `export let f = (x) => { let a = [x > 0 && 1]; return a[0] }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  { name: 'object literal',
    src: `export let f = (x) => { let o = {a: x > 0 && 1}; return o.a }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  { name: 'Map value',
    src: `export let f = (x) => { let m = new Map(); m.set('k', x > 0 && 1); return m.get('k') }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  // Map KEY identity: JS `false` and `0` are distinct Map keys (SameValueZero),
  // so setting both leaves size 2 — a collapsed carrier would alias them into
  // the same bucket (size 1).
  { name: 'Map key',
    src: `export let f = (x) => { let m = new Map(); m.set(x > 0 && 1, 'A'); m.set(0, 'B'); return m.size }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  { name: 'Set membership',
    src: `export let f = (x) => { let s = new Set(); s.add(x > 0 && 1); s.add(0); return s.size }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  { name: 'push',
    src: `export let f = (x) => { let a = []; a.push(x > 0 && 1); return a[0] }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  { name: 'JSON.stringify',
    src: `export let f = (x) => JSON.stringify([x > 0 && 1])`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  // module/function.js:291's closure-arg boxing (the call_indirect/$ftN
  // convention) AND emit.js's generic coerceArg/emitCallArgs (the direct-
  // call convention g() takes here, having no captures) both needed the fix
  // — direct closure arg exercises the LATTER, verified live at every
  // optimize level (O2+ also devirtualizes THIS call to a plain wasm call,
  // a different, already-sound path, so O0 alone doesn't isolate the fix —
  // both must agree).
  { name: 'direct closure arg',
    src: `const g = (p) => p === false
export let f = (x) => g(x > 0 && 1)`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  // Parenthesized-&& value stored into a container (step 1's MECHANISM B
  // grouping-unwrap shape, exercised through MECHANISM A's chokepoint
  // instead of a return tail) — same wrongness, different site.
  { name: 'parenthesized-&&',
    src: `export let f = (x) => { let a = [(x > 0) && 1]; return a[0] }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  // FLIPPED from PENDING-FIX (.work/todo.md §deletion-sweep — formatter/
  // ToPropertyKey carrier-dispatch fix): the same MECHANISM A/argIR
  // producer-side collapse, un-swept at three consumer chokepoints.
  // String()'s VAL.NUMBER __ftoa fast path is a STATIC-VALTYPE check (not an
  // IR-shape check) — needs an explicit hasAmbiguousBoolMerge early exit
  // (module/string.js bind('String', …)), boxing via emitIdentitySafe before
  // toStrI64/__to_str (which already special-cases TRUE_NAN/FALSE_NAN
  // correctly — the defect was entirely upstream of it, never in the runtime
  // dispatcher itself).
  { name: 'String()',
    src: `export let f = (x) => String(x > 0 && 1)`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  // Template literal: strcat's per-part i32-PROVEN fast path (module/
  // string.js, the `v.type === 'i32'` check) IS an IR-shape check — argIR
  // (promoted to src/bridge.js from emit.js's own private copy) fixes it for
  // free: emitIdentitySafe's output is always f64-typed, so the i32 check
  // structurally can't fire on an ambiguous merge, falling through to
  // partStrI64 → toStrI64 → the same correct __to_str arm. partStrI64's own
  // 0-arg fallback gets the same argIR fix for the 1-part strcat shortcut.
  { name: 'template literal',
    src: `export let f = (x) => \`\${x > 0 && 1}\``,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  // Computed member key (WRITE): src/compile/emit-assign.js's universal
  // dynamic-key emit site (`keyExpr`, feeding $__dyn_set) was a bare
  // `asF64(emit(idx))` — the 18th unswept MECHANISM A site. storedValue
  // already returns f64-typed IR in every branch (no asF64 wrap needed) and
  // is byte-identical to the old line for the non-ambiguous, non-pure-BOOL
  // case. o['0'] must stay undefined — ToPropertyKey(false) → 'false', a
  // different slot than ToPropertyKey(0) → '0'.
  { name: 'computed member key',
    src: `export let f = (x) => { let o = {}; o[x > 0 && 1] = 'v'; return o['0'] }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  // READ-side sibling family (.work/todo.md §deletion-sweep Finding #2, same
  // landing session, not a documented-then-flipped PENDING-FIX gap — a
  // proactive fix): module/array.js's dyn-get key sites had the identical
  // bare `emit(idx)`/`asI64(emit(idx))`/`asF64(emit(idx))` producer bypass
  // for a bare `o[k]` read (no prior write). Swept the sites reachable by an
  // INLINE ambiguous-merge key node (i32HashLocal fallback, HASH-receiver
  // useRuntimeKeyDispatch block and __dyn_get_expr fallthrough, OBJECT-
  // receiver __dyn_get_expr fallthrough, unknown-receiver-kind proven-
  // NUMBER-key cold arm) to storedValue(idx)/asI64(storedValue(idx)). Sites
  // structurally guarded to STRING-only keys (an ambiguous merge always
  // resolves NUMBER, never STRING — VT['&&']/VT['?:'] only mix BOOL/NUMBER)
  // are a genuinely different, unreachable-for-this-bug class and were left
  // untouched: module/array.js's i32HashLocal literal-string-key arm, the
  // boxed-object/HASH/known-array `keyType === VAL.STRING` guarded reads.
  // emitDynamicKeyDispatch call sites gated `!keyIsNum`/`keyType !==
  // VAL.NUMBER` are likewise unreachable (an ambiguous merge always resolves
  // NUMBER) — also left untouched.
  // NOT closed by this sweep: a NAMED LOCAL holding an ambiguous merge
  // (`let k = x > 0 && 1; o[k]`, read OR write) — storedValue(idx) is a
  // no-op there (hasAmbiguousBoolMerge only recognizes the `?:`/`&&`/`||`/
  // `??`/`()` AST shape directly, not an identifier referencing one), and
  // the merge already collapsed at k's OWN declaration — the DECL-INIT WALL
  // (research.md §Carrier invariant), the same root as the 'captured-then-read'
  // PENDING-FIX row below, banked and out of scope here. Re-attempted
  // audit-#8 P0-4 Part 2 (2026-08-03): a NARROWER, hasAmbiguousBoolMerge-
  // gated fix (emit.js emitDecl's `argIR(init)`) proved byte-identical on
  // the kernel-parity corpus but surfaced a DIFFERENT, genuine self-host
  // miscompile (invalid WASM for a captured-and-mutated closure decl,
  // unrelated to this row's own shape) — reverted; see emit.js's emitDecl
  // comment for the full finding. This row and 'captured-then-read' below
  // both stay PENDING-FIX.
  { name: 'computed member key read (inline, literal-key object)',
    src: `export let f = (x) => { let o = { '0': 'zero', 'false': 'FALSE' }; return o[x > 0 && 1] }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  { name: 'computed member key read (inline, dynamic hash)',
    src: `export let f = (x) => { let o = {}; o['0'] = 'zero'; o['false'] = 'FALSE'; return o[x > 0 && 1] }`,
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
      let ker
      try { ker = runKernel(src, opt) } catch (e) { console.error('KERNEL FAIL ROW:', name, e.message); throw e }
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

// Was a documented self-host limit (README.md, "One known divergence class"):
// inside dist/jz.wasm, BigInt values ride raw i64 bits in an f64 slot, and
// small-magnitude bit patterns collide with subnormal Numbers (`1n` and
// `5e-324` are the same 64 bits) — module/number.js's `__to_num` treated ANY
// nonzero finite subnormal reaching it as raw BigInt carrier bits, UNGATED.
// The compiler's OWN source is itself bigint-free by design (bignum.js's own
// doc comment: earlier revisions carried rational n/d as native BigInt and
// hit exactly this native-vs-kernel divergence, so it was rewritten onto
// plain safe-integer limb arrays specifically to avoid it) — so `ctx.features.
// bigint` is false for the compiler's own self-hosted compilation, and the
// kernel's internal coercions of a subnormal literal like this one hit the
// exact same unconditional-heuristic bug the compiled OUTPUT program did
// (audit-#11 P0-1: `+Number.MIN_VALUE`/`+5e-324` misdecoded as bigint 1).
// Closed by gating `__to_num`'s subnormal-as-BigInt arm on `ctx.features.
// bigint` (module/number.js) — a bigint-free program (the compiler's own
// source included) can never produce that carrier, so every subnormal it
// touches, literal or computed, is now read as the real Number it is. This is
// the oracle-tier version of test/data.js's P0-2 test (`onKernel()`-gated for
// `JZ_TEST_TARGET=jz.wasm` runs of the whole suite): here BOTH legs run
// unconditionally in one process, so the (now-closed) divergence's AGREEMENT
// is asserted directly instead of behind an env-var branch.
test('kernel oracle: subnormal literal — AGREE (closed by audit-#11 P0-1, ctx.features.bigint-gated __to_num)', async () => {
  if (onWasi()) return
  const src = 'export let f = () => -5e-324'
  const mod = await oracle(src)
  const want = mod.f()
  is(want, -5e-324, 'JS oracle baseline')
  for (const opt of [0, 2, 3]) {
    is(runNative(src, opt).f(), want, `subnormal O${opt}: native matches JS oracle exactly (AST-tagged literal kind, no carrier ambiguity)`)
    is(runKernel(src, opt).f(), want, `subnormal O${opt}: kernel matches JS oracle too (no more BigInt-carrier collision on a bigint-free program)`)
  }
})

// ── KNOWN-FAIL tier: ctx.features.bigint module-inclusion-ORDERING hazard
// (audit-#16, differential fixture the audit prescribes) ───────────────────
//
// The subnormal-literal test above closed audit-#11 P0-1 by gating __to_num's
// BigInt-carrier heuristic on ctx.features.bigint — but that flag's freeze is
// PHASE-complete (one prep() pass), not GRAPH-complete. `prep()`'s own per-
// node dispatch runs `includeForOp(node[0])` (module inclusion — may bake a
// module's stdlib template into a ctx.core.stdlib STRING, evaluated ONCE,
// autoload.js includeModule → init(ctx)) BEFORE it checks whether THIS node
// is a bigint-construction site (src/prepare/index.js prep(), the `if
// (Array.isArray(node) && (node[0] === 'bigint' || …))` check). Any node
// visited earlier than a program's own bigint-construction site, whose op
// transitively needs the 'number' module (module/number.js's `$__to_num`,
// gated `${ctx.features.bigint ? … : …}` at module-init time, module/
// number.js ~1540), bakes the UNGATED (bigint-carrier-blind) arm PERMANENTLY
// — later setting the flag true does not retroactively re-bake the string.
// `prepareModule` (src/prepare/index.js ~3783) makes this a cross-MODULE
// hazard, not just cross-statement: each imported module gets its OWN
// separate `prep(ast)` call, so an earlier-imported module's numeric
// coercion (`+x`, OP_MODULES['u+'] → ['number','string']) can materialize
// `$__to_num` with the flag still false, before a LATER-imported module's
// bigint literal is ever walked. Below, `a.jz` (imported first) contains
// ONLY a numeric coercion, zero bigint syntax; `b.jz` (imported second) is
// the ONLY module with bigint syntax anywhere in the program. Root class
// matches the already-hunted JSON shaped-parser bug (.work/todo.md, "JSON
// SHAPED-PARSER 'Bad int 9.067910317e-315' HUNTED — ROOT NAMED, BANKED NOT
// FIXED") — same corrupted-carrier symptom (`Number()` of a boxed BigInt
// printing its own raw i64 bits reinterpreted as f64), reproduced here via a
// clean two-module fixture isolated from that bug's Map-value-census tangle.
//
// FIX ATTEMPTED PREVIOUSLY (that same todo.md entry) AND VERIFIED, THEN
// REVERTED: hoisting the bigint-construction scan to a standalone whole-tree
// prescan run to completion before ANY module's stdlib template can
// materialize (both for the top-level program and per-module, before each
// `prepareModule`'s own `prep(ast)`) closes THIS bug precisely — but flips
// `ctx.features.bigint` true for the self-hosted KERNEL BUILD too, because
// layout.js's `i64Hex`/`packPtrBits` family (imported unconditionally by
// src/ir.js, used for EVERY NaN-boxed pointer encoding) contains real BigInt
// literals (confirmed still present: layout.js `NAN_PREFIX_BITS`, `i64Hex`,
// `TAG_SHIFT`/`AUX_SHIFT`/`OFFSET_MASK` BigInt views, 2026-08-09 grep) — so
// the compiler's OWN self-hosted source is NOT bigint-free, contrary to the
// invariant the subnormal-literal AGREE test above depends on. Graph-
// completing the prescan correctly detects that pre-existing BigInt usage
// and flips the kernel's `$__to_num` to the guarded arm program-wide, which
// REGRESSES the subnormal-literal test (a real subnormal Number, e.g.
// `-5e-324`, misread as a BigInt-carrier collision again) — trading the
// narrow bug pinned here for the broader one P0-1 already closed. VERDICT:
// structural, not small — true fix is either (a) scrub all real-BigInt
// syntax from the self-hosted-bundle-reachable source (layout.js rewritten
// to hi/lo-split plain-Number i64 arithmetic, mirroring bignum.js's own
// deliberate BigInt-avoidance rewrite) to restore the "compiler source is
// bigint-free" invariant, or (b) redesign the carrier disambiguation off a
// single whole-program boolean toward something that survives the self-
// hosting identity conflation (compiler-as-program vs compiler-as-target
// share one flag today). BANKED, not fixed — pinned precisely (exact
// corrupted value, both native AND kernel legs, both optimize tiers) so a
// future close of either (a) or (b) flips this test's asserted values from
// the corrupted carrier to `want` in one edit.
test('kernel oracle: KNOWN-FAIL (audit-#16, ctx.features.bigint module-ordering, differential fixture) — an earlier-imported module\'s numeric coercion bakes $__to_num before a later-imported module\'s BigInt use is ever seen, corrupting Number() of that BigInt at native+kernel runtime under default, kernel-only under JZ_CARRIER_BOX=1 (§31)', async () => {
  if (onWasi()) return
  const want = 123456789012345
  const corrupted = 6.09957581968707e-310  // raw i64 bits of 123456789012345n reinterpreted as f64, unconverted — same corruption class as the JSON shaped-parser 9.067910317e-315 finding
  // a.jz: imported FIRST, zero bigint syntax — a numeric coercion (OP_MODULES['u+']
  // = ['number','string']) materializes $__to_num while ctx.features.bigint is still false.
  const aSrc = `export let touch = (x) => +x`
  // b.jz: imported SECOND — the ONLY module with bigint syntax in the whole program.
  // A mixed-type array element (not statically bigint-typed) forces Number() through
  // the real dynamic $__to_num call rather than a compile-time fold or typed lowering.
  const bSrc = `
    const arr = [1.5, 123456789012345n, 2.5]
    export let mkBig = (i) => Number(arr[i])
  `
  const mainSrc = `
    import { touch } from './a.jz'
    import { mkBig } from './b.jz'
    export let out = () => { touch(1); return mkBig(1) }
  `
  const modules = { './a.jz': aSrc, './b.jz': bSrc }
  // §31: under JZ_CARRIER_BOX=1, the NATIVE leg is no longer corrupted here —
  // incidentally closed the same way the console.log row above was (§24
  // CONSERVATIVE PAIRING's runtime maybeUnboxBigInt dispatch at readI64,
  // unrelated to ctx.features.bigint/module-ordering itself, which is
  // STILL real and STILL open). The KERNEL leg stays wrong: its own
  // compiled $__to_num was baked by the self-hosted build BEFORE this
  // specific census value ever reaches a readI64 call site CONSERVATIVE
  // PAIRING covers (Number()'s own dynamic coercion path is a different
  // call shape than ptrBits' arithmetic OR-expression — not yet verified
  // which shape gap keeps it open; a future session's starting point, not
  // re-investigated here). Verified live, both directions, all three opt
  // tiers, default AND flag-forced, before landing this branch.
  const nativeCorrupted = process.env.JZ_CARRIER_BOX !== '1'
  for (const opt of [0, 2, 3]) {
    const nat = jz(mainSrc, { modules, optimize: opt }).exports.out()
    const ker = instantiate(compileViaKernel(mainSrc, { modules, optimize: opt })).exports.out()
    if (nativeCorrupted) {
      is(nat, corrupted, `O${opt}: native currently WRONG (raw BigInt carrier reinterpreted as f64) — TODO-flip guard`)
      not(nat, want, `O${opt}: tripwire — native must start disagreeing with the correct ToNumber value the moment this closes`)
    } else {
      is(nat, want, `O${opt}: native CORRECT under JZ_CARRIER_BOX=1 (§31 — closed incidentally by §24 CONSERVATIVE PAIRING, not by an audit-#16 fix)`)
      not(nat, corrupted, `O${opt}: tripwire — native must start agreeing again if this regresses`)
    }
    is(ker, corrupted, `O${opt}: kernel currently WRONG${nativeCorrupted ? ' too, identical corruption' : ' (unlike native under this flag)'} — TODO-flip guard`)
    not(ker, want, `O${opt}: tripwire — kernel must start disagreeing too`)
  }
  // Control: reversing the import order puts the bigint-construction site (b.jz)
  // ahead of the numeric-coercion op (a.jz) in prep()'s walk, so the flag is set
  // true BEFORE $__to_num materializes — proves the fault tracks ORDER, not the
  // Number()/mixed-array mechanism itself (which is correct on its own).
  const mainReversed = `
    import { mkBig } from './b.jz'
    import { touch } from './a.jz'
    export let out = () => { touch(1); return mkBig(1) }
  `
  for (const opt of [0, 2, 3]) {
    is(jz(mainReversed, { modules, optimize: opt }).exports.out(), want, `O${opt}: control — reversed import order is correct (isolates the fault to ORDER, not the value mechanism)`)
    is(instantiate(compileViaKernel(mainReversed, { modules, optimize: opt })).exports.out(), want, `O${opt}: control kernel leg, same proof`)
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
  // .work/todo.md §deletion-sweep — hasAmbiguousBoolMerge admits the
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

// ── PENDING-FIX tier: research.md §Carrier invariant's 51-mismatch sweep ─────
//
// MECHANISM A (the design's own framing): emit-assign.js's storedValue
// (hasAmbiguousBoolMerge ? emitIdentitySafe : carrierF64(emit)) is the ONE
// correct shape for a boxed-bool-aware container store. Step 3 promoted it
// to src/bridge.js as the chokepoint and closed the 16 enumerated raw sites
// PLUS several more the promotion surfaced (see the AGREE array's "FLIPPED"
// comment above for the full inventory) — array/object/Map/Set/push/direct-
// closure-arg/parenthesized-&& all moved there. Two families remain here:
//
// FORMATTER (design step 5, "un-traced" at design time): String()/template-
// literal stringification and computed-key ToPropertyKey conversion —
// different consumer code (module/string.js's String() dispatch, template
// concat emission, module/array.js's computed-key path). CLOSED by
// .work/todo.md §deletion-sweep — the three rows below moved to the AGREE
// array's "FLIPPED from PENDING-FIX" formatter-dispatch entry, plus a
// read-side sibling sweep (module/array.js dyn-get key sites, same design
// doc's Finding #2). Only the generic-scalar-decl family remains here.
//
// GENERIC SCALAR DECL (a WALL, banked — see emit.js emitDecl's comment on
// the `const val = viewInit || emit(init)` line): every implementation of
// "box an ambiguous-merge scalar `let`/`const` init" tried miscompiled the
// self-hosted kernel's own compiled emitDecl at that exact call site,
// verified with a fresh dist rebuild and reproducing with a plain, non-
// ambiguous `let v = x + 1` local (zero merge shapes anywhere in the
// program) — a self-host-only bug in how the kernel compiles ITS OWN
// emitDecl, not a logic error in the fix, and out of this design's
// carrier-boxing scope to chase further this session. RE-ATTEMPTED audit-#8
// P0-4 Part 2 (2026-08-03) with a NARROWER, hasAmbiguousBoolMerge-gated fix
// (`argIR(init)`, byte-identical to today for every non-ambiguous decl,
// confirmed via kernel-parity's full byte-identity corpus) — still hits a
// DIFFERENT self-host miscompile (invalid WASM for a captured-and-mutated
// closure decl, 'closure' AGREE row above, isolated via a clean A/B against
// this session's other two parts, which self-host cleanly). See emit.js's
// emitDecl comment for the full finding and the next concrete lead
// (resolveCallee's compiled-local shift). Still banked.
//
// Verified live: the wrong value is asserted explicitly (both legs share
// the bug) plus a not() tripwire against the true JS value, so a future
// fix flips these loudly.
const PENDING_FIX = [
  // Generic scalar decl (the emitDecl self-host wall above): `v`'s own
  // declaration never gets boxed, so a later capture-then-read still
  // observes the raw carrier. NOT the minimal `const g = () => v; return
  // g()` shape — direct-closure devirtualization eligibility differs
  // between native and kernel for that exact shape regardless of this bug
  // (a SEPARATE, also out-of-scope divergence); wrapping `g` in an array
  // before calling sidesteps it on both legs uniformly so this row isolates
  // only the scalar-decl gap.
  { name: 'captured-then-read',
    src: `export let f = (x) => { let v = x > 0 && 1; const g = () => v; let arr = [g]; return arr[0]() }`,
    wrong: 0 },
]

test('kernel oracle: PENDING-FIX — generic-scalar-decl BOOL∪NUMBER carrier collapse (research.md §Carrier invariant — not yet fixed; formatter/ToPropertyKey rows CLOSED, see .work/todo.md §deletion-sweep)', async () => {
  if (onWasi()) return
  for (const { name, src, wrong, opts = [0, 2, 3] } of PENDING_FIX) {
    const mod = await oracle(src)
    const want = mod.f(-1)
    not(wrong, want, `${name}: TODO-flip guard — wrong !== want (else this row is stale, delete it)`)
    for (const opt of opts) {
      const nat = runNative(src, opt).f(-1)
      const ker = runKernel(src, opt).f(-1)
      is(nat, wrong, `${name} O${opt}: native currently WRONG (${JSON.stringify(wrong)}) — TODO flip to AGREE once fixed`)
      is(ker, wrong, `${name} O${opt}: kernel currently WRONG (${JSON.stringify(wrong)}) — same bug, same leg`)
      not(nat, want, `${name} O${opt}: tripwire — native must start disagreeing with JS oracle the moment this is fixed`)
      not(ker, want, `${name} O${opt}: tripwire — kernel must start disagreeing with JS oracle the moment this is fixed`)
    }
  }
})

// ── AGREE tier: carrier-built KERNEL console.log string constants (.work/
// carrier-representation-design.md §16 finding 2 → §17 → §31) ─────────────
//
// FLIPPED from KNOWN-FAIL (2026-08-10, §31): a carrier-built KERNEL
// (JZ_CARRIER_BOX=1, self-hosted — dist/jz.wasm compiled from scripts/
// self.js by the NATIVE compiler under the same flag) used to miscompile
// ANY heap string literal used as a console.log argument — traced by §17 to
// mkPtrIR/packPtrBits (src/ir.js) constant-folding a NaN-boxed pointer via
// layout.js's `ptrBits`, whose `LAYOUT.NAN_PREFIX_BITS` read starves for
// `slotBigintProvenBySid` under the self-hosted build's whole-program
// `pointsTo==='ALL'` blanket (§17 finding 1, kernel-parity's `dict` row —
// STILL open, §18/§21/§22/§23 all walled on closing it safely). This row
// closed anyway, NOT via that lever: §24's CONSERVATIVE PAIRING (commit
// `83c7f9bc`, landed AFTER §17 named this bug) added a SEPARATE, RUNTIME
// (not static-proof-gated) dispatch at `readI64`'s arithmetic-core call
// sites — `isSchemaSlotBigintPossible` fires whenever a bare `.prop` read
// is write-side boxed (`slotBigintBoxedAt`, fail-open, unaffected by
// `pointsTo==='ALL'`) but read-side unproven, routing through
// `maybeUnboxBigInt`'s runtime `$__ptr_type` tag check instead of a naive
// unconditional reinterpret. `ptrBits`'s own `LAYOUT.NAN_PREFIX_BITS | (…)`
// IS exactly this shape (an arithmetic-core BigInt-operand OR-expression) —
// so once §24 baked THAT dispatch into the self-hosted kernel build, the
// running kernel's own compiled `ptrBits` started correctly unboxing the
// LAYOUT box AT RUNTIME, immune to whether `slotBigintProvenAt` was ever
// statically proven for the self-hosted build. §29/§30 both re-ran this
// row and recorded "unchanged" — true at the PASS/FAIL BLOCK level (the
// block still read 1 failure both times) but stale at the ASSERTION level:
// the failure had silently flipped from "throws, as expected" to "runs
// clean, breaking the KNOWN-FAIL pin's own throw assertion" — the coarse
// per-block count masked the flip. Re-verified directly (§31): heap string
// ('bare-fired', ≥7 chars) and SSO string ('short', ≤6 chars) BOTH print
// their correct, undecorated value on the kernel leg, at every optimize
// level (0/1/2/3), deterministically, across repeated fresh-process runs —
// not a fluke of one run. Native was never affected (self-host-only bug).
test('kernel oracle: console.log string constants — AGREE (closed incidentally by §24 CONSERVATIVE PAIRING, .work/carrier-representation-design.md §16→§17→§31)', async () => {
  if (onWasi()) return
  const heapSrc = `export let start = () => { console.log('bare-fired'); return 1 }`  // 10 chars — heap string
  const ssoSrc = `export let start = () => { console.log('short'); return 1 }`        // 5 chars — SSO string
  for (const opt of [0, 1, 2, 3]) {
    for (const [label, src, want] of [['heap', heapSrc, 'bare-fired'], ['sso', ssoSrc, 'short']]) {
      is(runNative(src, opt).start(), 1, `${label} O${opt}: native runs cleanly`)
      if (process.env.JZ_CARRIER_BOX !== '1') continue  // kernel leg below is meaningful only under the flag
      const seen = []
      const origLog = console.log
      console.log = (...a) => seen.push(a)
      try { instantiate(compileViaKernel(src, { optimize: opt })).exports.start() }
      finally { console.log = origLog }
      is(seen.length, 1, `${label} O${opt}: kernel console.log calls print exactly once (no crash)`)
      is(seen[0]?.[0], want, `${label} O${opt}: kernel prints the correct decoded string`)
    }
  }
})

// ── AGREE tier: bare BigInt array-element return (re-audit #6 finding 2) ──
//
// FLIPPED from PENDING-FIX: `let a = [1n]; return a[0]` used to decode as a
// raw-bit-reinterpreted NUMBER, not the BigInt value. NOT the boxed-BigInt-
// carrier limitation (the subnormal-literal row above is a DIFFERENT,
// documented divergence) — the i64 VALUE itself was always correct
// (`a[0] + 0n` already resolved right, through the separately-correct
// emit-time path that embeds the element in a proven-BigInt expression);
// only the JS-BOUNDARY RESULT KIND mis-resolved for a bare, unembedded tail.
// Root (.work/todo.md "NOT FIXED, BANKED" entry, member-desugar landing
// session): BigInt array literals never qualify for flat SRoA (static.js's
// staticValue has no 'bigint' case), so the kind had to resolve through
// rep.arrayElemValType — a whole-program fact store the return-kind
// pre-passes (narrow.js's narrowValResults / narrowBoolResults) didn't
// install for the function under examination, unlike ctx.func.flatObjects
// (the object-field sibling fix that landed earlier). Closed by
// installArrElemReps (src/compile/narrow.js): both passes now install the
// function's own proven (elemOrigin-gated — analyze.js only ever settles a
// non-null arrElemValTypes entry from a construction origin, so "non-null"
// already IS the soundness gate) arr-elem VAL-kind facts onto
// ctx.func.localReps for the duration of their own kind resolution,
// mirroring the flatObjects install exactly. Both a small (1n) and a
// near-2^62 magnitude are pinned.
test('kernel oracle: bare BigInt array-element return — AGREE (re-audit #6 finding 2, closed by installArrElemReps)', async () => {
  if (onWasi()) return
  const cases = [
    { name: 'array-elem bigint (small)', src: `export let f = () => { let a = [1n]; return a[0] }` },
    { name: 'array-elem bigint (2^62 boundary)', src: `export let f = () => { let a = [4611686018427387905n]; return a[0] }` },
  ]
  for (const { name, src } of cases) {
    const mod = await oracle(src)
    const want = mod.f()
    for (const opt of [0, 1, 2, 3]) {
      is(runNative(src, opt).f(), want, `${name} O${opt}: native agrees with JS oracle`)
      is(runKernel(src, opt).f(), want, `${name} O${opt}: kernel agrees with JS oracle`)
    }
  }
})
