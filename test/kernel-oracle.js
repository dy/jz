/**
 * Kernel ORACLE tier — three-way execution parity: HOST JS vs NATIVE-compiled
 * vs KERNEL-compiled, for the same source.
 *
 * Byte identity certifies identically-WRONG output just as readily as
 * identically-right — the boolconst mechanism (below) produces the SAME wrong WAT
 * from both compilers, and a byte-diff test is structurally blind to that: it can
 * only ever say "they agree", never "they're correct".
 *
 * # Three tiers
 *   AGREE      — native, kernel, and the JS oracle must all produce the exact
 *                same result (deep-equal: numbers incl. NaN/-0, strings,
 *                bigints, arrays, typed arrays, objects).
 *   DIVERGENT  — a documented, intentional-or-known departure from naive JS
 *                semantics (rational constant-folding trades bit-exactness
 *                for precision by design; the kernel's i64-carrier/subnormal
 *                collision is README's own documented self-compile limit). These
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
 */
import test from 'tst'
import { is, not, throws } from 'tst/assert.js'
import { CORPUS } from './_kernel-corpus.js'
import { compileViaKernel } from './kernel-target.js'
import { instantiate } from '../interop.js'
import { onWasi, withBigintStrict, levels } from './_matrix.js'
import { BIGINT_TYPED_STORE_CALLS, BIGINT_TYPED_STORE_CATCH_SOURCE, BIGINT_TYPED_STORE_ERROR_SOURCE, BIGINT_TYPED_STORE_THROW_CALLS } from './_bigint-typed-store-corpus.js'
import { jz, compile } from './util.js'

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

// AGREE tier
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
  { name: 'eqzero', src: CORPUS.eqzero, calls: [
    { fn: 'chain', args: [0, 9] }, { fn: 'chain', args: [7, 9] }, { fn: 'chain', args: [12, -4] },
    { fn: 'masked', args: [-8] }, { fn: 'masked', args: [7] }, { fn: 'masked', args: [8] },
    { fn: 'reversed', args: [-1] }, { fn: 'reversed', args: [0] }, { fn: 'reversed', args: [1] },
    { fn: 'main', args: [] },
  ] },
  { name: 'nestedtyped', src: CORPUS.nestedtyped, calls: [{ fn: 'f', args: [3] }, { fn: 'f', args: [-1.5] }, { fn: 'f', args: [2 ** 33] }] },
  { name: 'fromnested', src: CORPUS.fromnested, calls: [{ fn: 'f', args: [] }] },
  // Store-side BigInt carrier pairing: both compiler hosts must match Node on
  // the materialized and raw-tag-shaped paths, not merely emit equal bytes.
  { name: 'biginttypedstore', src: CORPUS.biginttypedstore, calls: BIGINT_TYPED_STORE_CALLS },
  // A Boolean-or-null result joined with null and a later declarator's
  // hoisted call: the missing value survives each.
  { name: 'boolnull', src: CORPUS.boolnull,
    calls: ['tern', 'and', 'type'].flatMap(fn => [0, 1, 2, 3].map(n => ({ fn, args: [n] }))) },
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
  { name: 'boolconst', src: CORPUS.boolconst,
    calls: [{ fn: 'f', args: [5] }, { fn: 'f', args: ['hi'] }, { fn: 'f', args: [true] }] },
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
  { name: 'String()',
    src: `export let f = (x) => String(x > 0 && 1)`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
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
  { name: 'computed member key read (inline, literal-key object)',
    src: `export let f = (x) => { let o = { '0': 'zero', 'false': 'FALSE' }; return o[x > 0 && 1] }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  { name: 'computed member key read (inline, dynamic hash)',
    src: `export let f = (x) => { let o = {}; o['0'] = 'zero'; o['false'] = 'FALSE'; return o[x > 0 && 1] }`,
    calls: [{ fn: 'f', args: [1] }, { fn: 'f', args: [-1] }] },
  { name: 'array-growth-class: arr[arr.length]=x through a 2-level property chain',
    src: `export let f = (n) => { let o = { inner: { arr: [] } }; for (let i = 0; i < n; i++) o.inner.arr[o.inner.arr.length] = i * 3; let s = 0; for (let j = 0; j < o.inner.arr.length; j++) s += o.inner.arr[j]; return o.inner.arr.length + '|' + s }`,
    calls: [{ fn: 'f', args: [0] }, { fn: 'f', args: [1] }, { fn: 'f', args: [9] }, { fn: 'f', args: [64] }] },
  { name: 'array-growth-class: sibling push()+indexed-append tables (envMeta shape)',
    src: `export let f = (n) => {
      let ctx = { closure: { table: [], envMeta: [] } }
      let addToTable = (name, cap) => {
        let idx = ctx.closure.table.length
        ctx.closure.table.push(name)
        ctx.closure.envMeta[ctx.closure.envMeta.length] = { cap: cap, idx: idx }
        return idx
      }
      for (let i = 0; i < n; i++) addToTable('fn' + i, i + 1)
      let s = 0
      for (let j = 0; j < ctx.closure.envMeta.length; j++) s += ctx.closure.envMeta[j].cap + ctx.closure.envMeta[j].idx
      return ctx.closure.table.length + '|' + ctx.closure.envMeta.length + '|' + s
    }`,
    calls: [{ fn: 'f', args: [0] }, { fn: 'f', args: [1] }, { fn: 'f', args: [5] }, { fn: 'f', args: [64] }] },
  // Two NAMED functions, one calling the other at two call sites with two
  // differently-typed second arguments, is the minimal shape that defeats the
  // skip: it gives `callSites.length > 0`, forcing narrowSignatures (and
  // therefore every later plan-tail/scan region round wired through `plan()`'s
  // `round()` helper) to actually execute — closing the gap for ANY future
  // plan()-internal region-boundary work, not just the chain-rounds session
  // this row was added for.
  { name: 'whole-program-narrowing-forcing (defeats canSkipWholeProgramNarrowing)',
    src: `function add(a, b) { return a + b }
function callAdd(x) { return add(x, 1) + add(x, 2.5) }
export let f = (x) => callAdd(x)`,
    calls: [{ fn: 'f', args: [3] }, { fn: 'f', args: [-2] }] },
  // `kind` selects the slice bounds, sweeping across LAYOUT.SLICE_LEN_MASK
  // (0x1FFF = 8191, module/string.js) — the bit width of a view's packed
  // length field: under (152, mimicking the original spans[0].start), AT the
  // mask exactly, one OVER it (nlen > SLICE_LEN_MASK forces __str_slice_view's
  // OWN internal fallback to a copy), and a large offset slice. Each `kind`
  // branch's `t` is its own `let t = s.slice(...)` declaration read back only
  // via `t.length` (a non-escaping local) — the documented trigger for
  // __str_slice_view (SLICE_BIT, no-copy) lowering
  // (src/compile/analyze-scans.js sliceViewCandidate requires the initializer
  // to be a DIRECT `.slice()` call — a ternary-selected initializer does NOT
  // qualify, verified while authoring this row: the ternary form the branches
  // replace never emitted __str_slice_view at all).
  { name: 'large-binary-slice-view (SLICE_BIT no-copy path, LAYOUT.SLICE_LEN_MASK boundary)',
    src: `export let f = (p, kind) => {
      let c = ''
      for (let j = 0; j < 256; j = j + 1) c = c + String.fromCharCode((j + p) & 0xFF)
      let s = ''
      for (let k = 0; k < 44; k = k + 1) s = s + c
      if (kind === 0) { let t = s.slice(0, 152); return t.length }
      if (kind === 1) { let t = s.slice(0, 8191); return t.length }
      if (kind === 2) { let t = s.slice(0, 8192); return t.length }
      if (kind === 3) { let t = s.slice(100, 9100); return t.length }
      let t = s.slice(0, 11264)
      return t.length
    }`,
    calls: [
      { fn: 'f', args: [0, 0] }, { fn: 'f', args: [0, 1] }, { fn: 'f', args: [0, 2] },
      { fn: 'f', args: [0, 3] }, { fn: 'f', args: [0, 4] },
    ] },
  { name: 'large-binary-slice-copy (escaping through a storing callee, mirrors dataReset(dataString().slice(...)) shape)',
    src: `let store = { part: '' }
    function reset(s) { store.part = s }
    function bigString(p) {
      let c = ''
      for (let j = 0; j < 256; j = j + 1) c = c + String.fromCharCode((j + p) & 0xFF)
      let s = ''
      for (let k = 0; k < 44; k = k + 1) s = s + c
      return s
    }
    export let f = (p, kind) => {
      if (kind === 0) reset(bigString(p).slice(0, 152))
      else if (kind === 1) reset(bigString(p).slice(0, 8191))
      else if (kind === 2) reset(bigString(p).slice(0, 8192))
      else reset(bigString(p).slice(100, 9100))
      return store.part.length
    }`,
    calls: [
      { fn: 'f', args: [0, 0] }, { fn: 'f', args: [0, 1] },
      { fn: 'f', args: [0, 2] }, { fn: 'f', args: [0, 3] },
    ] },
]

for (const opt of levels(0, 2, 3)) {
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

test('kernel oracle: BigInt typed-array stores reject a Number before in-range or OOB writes', async () => {
  if (onWasi()) return
  const src = BIGINT_TYPED_STORE_ERROR_SOURCE
  const mod = await oracle(src)
  const caught = await oracle(BIGINT_TYPED_STORE_CATCH_SOURCE)
  is(caught.caughtMismatch(), 11, 'JS oracle catches the OOB Number-to-BigInt conversion after the index effect')
  for (const opt of levels(0, 2, 3)) {
    const nat = runNative(src, opt), ker = runKernel(src, opt)
    is(runNative(BIGINT_TYPED_STORE_CATCH_SOURCE, opt).caughtMismatch(), 11, 'native catches conversion error')
    is(runKernel(BIGINT_TYPED_STORE_CATCH_SOURCE, opt).caughtMismatch(), 11, 'kernel catches conversion error')
    for (const { fn, args } of BIGINT_TYPED_STORE_THROW_CALLS) {
      throws(() => mod[fn](...args), error => error instanceof TypeError)
      throws(() => nat[fn](...args), error => error instanceof TypeError)
      throws(() => ker[fn](...args), error => error instanceof TypeError)
    }
  }
})

// preEval's rational constant-folding (src/prepare/pre-eval.js) carries an EXACT rational through a
// whole numeric chain and rounds ONCE at the end (module doc, "Purity / precision guards":
// `optimize.rationalConst`, by default as `relaxedFloat`: on at 'speed' alone). Naive JS rounds
// after EVERY op ("double rounding"). This is NOT the native/kernel divergence audit P0-2 fixed
// (that was native-vs-kernel disagreeing with EACH OTHER over HOST bigint width — both now compute
// the SAME rational-fold answer); it is jz's constant-fold disagreeing with naive JS BY DESIGN, on
// both legs identically.
test('kernel oracle: fold — documented divergence (rational constant-fold vs naive JS double-rounding)', async () => {
  if (onWasi()) return
  const src = CORPUS.fold
  const mod = await oracle(src)
  const want = mod.f()
  is(want, 5.551115123125783e-17, 'JS oracle baseline (pin so a V8 change is visible, not silently absorbed)')
  for (const opt of [3, { level: 0, rationalConst: true }, { level: 2, rationalConst: true }]) {
    const nat = runNative(src, opt).f()
    const ker = runKernel(src, opt).f()
    is(nat, 2.7755575615628914e-17, `fold ${JSON.stringify(opt)}: native's single-rounding rational fold (documented, not naive-JS-equal)`)
    is(ker, nat, `fold ${JSON.stringify(opt)}: kernel matches native exactly (both fold the same way)`)
  }
  for (const opt of levels(0, 2)) {
    is(runNative(src, opt).f(), want, `fold O${opt}: rationals off by default, JS's per-op rounding`)
    is(runKernel(src, opt).f(), want, `fold O${opt}: the kernel as well`)
  }
  // rationalConst:false is the documented escape hatch — with it, jz folds via
  // plain sequential per-op f64 rounding and MUST recover oracle parity.
  is(runNative(src, { level: 3, rationalConst: false }).f(), want,
    'fold: rationalConst:false recovers naive-JS parity (proves the divergence above is a chosen tradeoff, not an uncontrolled bug)')
})

// This is the oracle-tier version of test/data.js's P0-2 test (`onKernel()`-gated
// for `JZ_TEST_TARGET=jz.wasm` runs of the whole suite): here BOTH legs run
// unconditionally in one process, so the (now-closed) divergence's AGREEMENT is
// asserted directly instead of behind an env-var branch.
test('kernel oracle: subnormal literal — AGREE (closed by audit-#11 P0-1, ctx.features.bigint-gated __to_num)', async () => {
  if (onWasi()) return
  const src = 'export let f = () => -5e-324'
  const mod = await oracle(src)
  const want = mod.f()
  is(want, -5e-324, 'JS oracle baseline')
  for (const opt of levels(0, 2, 3)) {
    is(runNative(src, opt).f(), want, `subnormal O${opt}: native matches JS oracle exactly (AST-tagged literal kind, no carrier ambiguity)`)
    is(runKernel(src, opt).f(), want, `subnormal O${opt}: kernel matches JS oracle too (no more BigInt-carrier collision on a bigint-free program)`)
  }
})

// Below, `a.jz` (imported first) contains ONLY a numeric coercion, zero bigint
// syntax; `b.jz` (imported second) is the ONLY module with bigint syntax anywhere
// in the program.
//
// BANKED, not fixed — pinned precisely (exact corrupted value, both native AND
// kernel legs, both optimize tiers) so a future close of either (a) or (b)
// flips this test's asserted values from the corrupted carrier to `want` in one
// edit. `bSrc`'s `const arr = [1.5, 123456789012345n, 2.5]` is a heterogeneous
// array literal carrying a BigInt element into element storage whose kind this
// program never proves uniform — exactly the "collection" flow class §4's table
// names.
test('kernel oracle: heterogeneous BigInt array element — strict-mode (opt-in) collection diagnostic (was audit-#16 KNOWN-FAIL, a runtime module-ordering corruption)', () => {
  const bSrc = `
    const arr = [1.5, 123456789012345n, 2.5]
    export let mkBig = (i) => Number(arr[i])
  `
  const mainSrc = `
    import { touch } from './a.jz'
    import { mkBig } from './b.jz'
    export let out = () => { touch(1); return mkBig(1) }
  `
  const modules = { './a.jz': `export let touch = (x) => +x`, './b.jz': bSrc }
  for (const opt of levels(0, 2, 3))
    throws(() => withBigintStrict(() => jz(mainSrc, { modules, optimize: opt })), /BigInt value at this collection/, `O${opt}: heterogeneous BigInt array element refuses to compile`)
})

test('kernel oracle: ternary BOOL|NUMBER return — AGREE (closed by the ambiguous-BOOL-merge identity work)', async () => {
  if (onWasi()) return
  const src = `const g = (s) => s ? 1 : false
export let f = (s) => g(s) === false`
  const mod = await oracle(src)
  const cases = [
    { args: [true], want: false },  // g(true)=1 (number); 1 === false → false
    { args: [false], want: true },  // g(false)=false (atom); false === false → true
  ]
  for (const { args, want } of cases) is(mod.f(...args), want, `ternary: JS oracle baseline f(${args.map(String)})`)
  for (const opt of levels(0, 2, 3)) {
    const nat = runNative(src, opt).f
    const ker = runKernel(src, opt).f
    for (const { args, want } of cases) {
      is(nat(...args), want, `ternary O${opt}: native f(${args.map(String)}) agrees with JS`)
      is(ker(...args), want, `ternary O${opt}: kernel f(${args.map(String)}) agrees with JS`)
    }
  }
})

// Both legs then hit the decl-STORAGE WALL directly (previous paragraph):
// `v`'s own storage is the raw carrier, `return v` is a bare name with no
// expression shape for hasAmbiguousBoolMerge to see, so both compilers return
// the raw 0/number where JS returns the coerced-false atom — agreeing with
// EACH OTHER, disagreeing with the oracle.
test('kernel oracle: ambiguous BOOL|NUMBER local storage keeps its identity through a capturing closure', () => {
  if (onWasi()) return
  const rows = [
    [`export let f = (x) => { let v = x > 0 && 1; const g = () => v; return g() }`, [1, false]],
    [`export let f = (x) => { let v = x > 0 && 1; const g = () => typeof v; return g() }`, ['number', 'boolean']],
  ]
  for (const [src, [want1, want0]] of rows) for (const opt of levels(0, 2, 3)) {
    const native = runNative(src, opt), kernel = runKernel(src, opt)
    is(native.f(1), want1, `native O${opt}: the Number arm`); is(native.f(0), want0, `native O${opt}: the Boolean arm keeps its identity`)
    is(kernel.f(1), want1, `kernel O${opt}: the Number arm`); is(kernel.f(0), want0, `kernel O${opt}: the same values`)
  }
})

test('kernel oracle: captured BOOL∪NUMBER merge — AGREE (FLIPPED from PENDING-FIX, closed by the closure-capture identity shadow)', async () => {
  // NOT the minimal `const g = () => v; return g()` shape (no array) — that
  // isn't a native/kernel split (PROBED 2026-08-21, falsifying this test's
  // prior "devirtualization eligibility differs" claim: compile vs
  // compileViaKernel emit byte-identical WAT for it, both legs, zero
  // call_indirect). The array below gives `g` a second reference (the array
  // store), which disqualifies inlineLocalLambdas and keeps the closure on
  // THIS row's fixed path.
  if (onWasi()) return
  const src = `export let f = (x) => { let v = x > 0 && 1; const g = () => v; let arr = [g]; return arr[0]() }`
  const mod = await oracle(src)
  const cases = [
    { args: [-1], want: false },  // x>0 is false; v is the coerced-false atom
    { args: [1], want: 1 },       // x>0 is true; v is the genuine number 1
  ]
  for (const { args, want } of cases) is(mod.f(...args), want, `captured-then-read: JS oracle baseline f(${args.map(String)})`)
  for (const opt of levels(0, 2, 3)) {
    const nat = runNative(src, opt).f
    const ker = runKernel(src, opt).f
    for (const { args, want } of cases) {
      is(nat(...args), want, `captured-then-read O${opt}: native f(${args.map(String)}) agrees with JS`)
      is(ker(...args), want, `captured-then-read O${opt}: kernel f(${args.map(String)}) agrees with JS`)
    }
  }
})

// FLIPPED from KNOWN-FAIL (2026-08-10, §31): a carrier-built KERNEL
// (JZ_CARRIER_BOX=1, self-compiled — dist/jz.wasm compiled from scripts/
// self.js by the NATIVE compiler under the same flag) used to miscompile ANY
// heap string literal used as a console.log argument — traced by §17 to
// mkPtrIR/packPtrBits (src/ir.js) constant-folding a NaN-boxed pointer via
// layout.js's `ptrBits`, whose `LAYOUT.NAN_PREFIX_BITS` read starves for
// `slotBigintProvenBySid` under the self-compiled build's whole-program
// `pointsTo==='ALL'` blanket (§17 finding 1, kernel-parity's `dict` row —
// STILL open, §18/§21/§22/§23 all walled on closing it safely). Re-verified
// directly (§31): heap string ('bare-fired', ≥7 chars) and SSO string
// ('short', ≤6 chars) BOTH print their correct, undecorated value on the
// kernel leg, at every optimize level (0/1/2/3), deterministically, across
// repeated fresh-process runs — not a fluke of one run.
test('kernel oracle: console.log string constants — AGREE (closed incidentally by §24 CONSERVATIVE PAIRING, .work/archive/carrier-representation-design.md §16→§17→§31)', async () => {
  if (onWasi()) return
  const heapSrc = `export let start = () => { console.log('bare-fired'); return 1 }`  // 10 chars — heap string
  const ssoSrc = `export let start = () => { console.log('short'); return 1 }`        // 5 chars — SSO string
  for (const opt of levels(0, 1, 2, 3)) {
    for (const [label, src, want] of [['heap', heapSrc, 'bare-fired'], ['sso', ssoSrc, 'short']]) {
      is(runNative(src, opt).start(), 1, `${label} O${opt}: native runs cleanly`)
      // CARRIER_BOX flag deleted — boxing unconditional; row always runs.
      // kernel leg below is meaningful only when carrier boxing is active.
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

// Both a small (1n) and a near-2^62 magnitude are pinned.
test('kernel oracle: bare BigInt array-element return — AGREE', async () => {
  if (onWasi()) return
  const cases = [
    { name: 'array-elem bigint (small)', src: `export let f = () => { let a = [1n]; return a[0] }` },
    { name: 'array-elem bigint (2^62 boundary)', src: `export let f = () => { let a = [4611686018427387905n]; return a[0] }` },
  ]
  for (const { name, src } of cases) {
    const mod = await oracle(src)
    const want = mod.f()
    for (const opt of levels(0, 1, 2, 3)) {
      is(runNative(src, opt).f(), want, `${name} O${opt}: native agrees with JS oracle`)
      is(runKernel(src, opt).f(), want, `${name} O${opt}: kernel agrees with JS oracle`)
    }
  }
})
