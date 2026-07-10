/**
 * Inference module — actionability tests.
 *
 * Each inference aspect must change emitted WAT in a way that proves the
 * fact reached the consumer. Pure "fact set / fact read" coverage on
 * `ctx.func.localReps` doesn't count — the user only observes the WAT.
 *
 * Aspects covered (src/infer.js evidence ladder):
 *   • notStringEvidence   — write-shape disproves STRING → drops __length poly
 *   • methodEvidence STR  — STRING_ONLY method induces STRING → drops __length
 *   • methodEvidence ARR  — ARRAY inducer (.push) → drops STRING/TYPED branches
 *   • extractRefinements  — flow `typeof x === 'string'` → return; → notString
 *
 * Call-site facts (infer* family):
 *   • inferValType        — paramReps val agreement folds polymorphic dispatch
 *   • inferValType        — sticky-null on disagree forces __length poly
 *   • inferArrElemSchema — array-elem schema flows through paramReps
 *   • intConst            — unanimous int literal at every call site folds
 *
 * Layout: pair positive + negative for each aspect when the negative case
 * exists. Negative cases use a probe known to stay polymorphic so future
 * regressions of either direction break a test.
 *
 * @see research/inference.md for the three load-bearing principles.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, onKernel, onWasi } from './_matrix.js'
import jz from '../index.js'
import { run } from './util.js'
import { parse as watTree, callsOutside } from '../scripts/wat-probe.mjs'

const count = (wat, re) => (wat.match(re) || []).length

// ───────────────────────────────────────────────────────────── body-walk evidence

test('notStringEvidence: index-write + length read drops __length poly', () => {
  // `xs[i] = v` is silently dropped on a primitive string, so an index-write
  // proves xs is not a string. The `.length` read then routes through `__len`
  // (direct typed/array header) instead of `__length` (poly STRING-aware).
  const wat = jz.compile(`
    export const fill = (xs, v) => {
      for (let i = 0; i < xs.length; i++) xs[i] = v
      return xs.length
    }
  `, { wat: true })
  is(count(wat, /\$__length\b/g), 0)
  ok(count(wat, /\$__len\b/g) >= 1, 'expected direct __len for length read')
})

test('notStringEvidence: pure-read (no write) keeps __length poly', () => {
  // Negative control: without a write site, notString can't fire and the
  // read must stay polymorphic (xs could be a string).
  const wat = jz.compile(`
    export const readlen = (xs) => xs.length
  `, { wat: true })
  ok(count(wat, /\$__length\b/g) >= 1, 'expected __length on pure read')
})

test('notStringEvidence: stringy-evidence (typeof) disqualifies even with write', () => {
  // `typeof xs === 'string'` (with no narrowing return) proves xs *can* be
  // a string in some flow → notString stays unset → __length keeps poly.
  const wat = jz.compile(`
    export const mixed = (xs, v) => {
      let n = 0
      if (typeof xs === 'string') n = 1
      xs[0] = v
      return xs.length
    }
  `, { wat: true })
  ok(count(wat, /\$__length\b/g) >= 1, 'expected __length when stringy disqualifies')
})

test('methodEvidence STRING: charCodeAt induces STRING (no __length poly)', () => {
  // `.charCodeAt` is a STRING_ONLY method → method source emits {val: STRING}.
  // STRING-typed receiver routes .length through the string byte-length op
  // (__str_byteLen, possibly inlined by splitCharScan), never polymorphic
  // __length or the array-element __len.
  const wat = jz.compile(`
    export const hd = (s) => { const c = s.charCodeAt(0); return c + s.length }
  `, { wat: true })
  is(count(wat, /\$__length\b/g), 0, 'no polymorphic __length for STRING receiver')
  is(count(wat, /\$__len\b/g), 0, 'no array-element __len for STRING receiver')
})

test('methodEvidence STRING: expression-bodied arrow narrows too', () => {
  // Regression for the `inferLocals` block-only gate. Before the lift,
  // `analyzeFuncForEmit` ran inferLocals only when `isBlockBody(body)` —
  // an expression-bodied arrow like `(s) => s.charCodeAt(0) + s.length`
  // skipped the pre-emit evidence pass and emit defaulted to polymorphic
  // __length. Now inferLocals walks any AST, so the expression body
  // narrows `s: VAL.STRING` the same as its block-bodied equivalent.
  const wat = jz.compile(`
    export const hd = (s) => s.charCodeAt(0) + s.length
  `, { wat: true })
  is(count(wat, /\$__length\b/g), 0, 'expr-body should not fall back to polymorphic __length')
  is(count(wat, /\$__len\b/g), 0, 'no array-element __len for STRING receiver')
})

test('methodEvidence ARRAY: .push induces VAL.ARRAY (no STRING branch)', () => {
  // `.push` is in ARRAY_INDUCERS → method source emits {val: ARRAY}. ARRAY
  // tagging removes the STRING-vs-TYPED dispatch from `xs[i]` reads.
  const wat = jz.compile(`
    export const tail = (xs) => {
      xs.push(0)
      return xs[xs.length - 1]
    }
  `, { wat: true })
  // ARRAY-known reads use __arr_idx_known (no STRING/TYPED branch).
  // Just check there's no string-index dispatch.
  is(count(wat, /\$__str_idx\b/g), 0, 'no __str_idx for ARRAY-typed receiver')
})

test('extractRefinements: post-typeof-string early-return narrows notString', () => {
  // Flow-sensitive refinement: after the early return, xs cannot be a string.
  // notString suffix on the rep makes the subsequent .length skip __length.
  // (B3 in todo.md — already wired; this test pins the win in place.)
  const wat = jz.compile(`
    export const tailLen = (xs) => {
      if (typeof xs === 'string') return 0
      return xs.length
    }
  `, { wat: true })
  if (!onKernel()) is(count(wat, /\$__length\b/g), 0, 'flow-narrowing should drop __length')  // self-host kernel codegen differs; in-process leg owns the shape check
})

// ──────────────────────────────────────────── soundness boundary: non-exclusive use ≠ type
//
// The evidence ladder narrows from *type-exclusive* signals only: a method that
// throws on the wrong receiver (`.charCodeAt`, `.push`) proves its type on every
// non-trapping run. Signals that are DEFINED for primitives prove nothing and must
// NOT induce a type — narrowing them swaps the polymorphic dispatch (which returns
// the correct JS value) for a layout-assuming fast path that reads a primitive's
// bits as a heap pointer. These tests pin that boundary: a future "infer OBJECT
// from `o.foo`" / "infer from `x[k]`" attempt must keep primitives working or fail
// here, loudly, instead of silently miscompiling.

test('boundary: bare property READ does not narrow param → primitive stays undefined', () => {
  // `(42).foo` is `undefined` in JS, not a trap — so `o.foo` proves nothing about
  // `o`. The param must stay polymorphic (`__dyn_get_any`), NOT narrow to OBJECT
  // (which would route to `__dyn_get_expr_t` and reinterpret 42's f64 bits as an
  // OBJECT pointer → OOB heap read).
  const ex = run(`export function f(o) { return o.foo }`)
  // A live JS object arg only marshals across the JS-host boundary; the hostless WASI
  // boundary has no string-keyed object representation (numeric arrays still marshal).
  // The soundness assertions below (primitives stay undefined, WAT keeps the poly
  // dispatch) are host-independent and DO run under wasi — that's the load-bearing part.
  if (!onWasi()) is(ex.f({ foo: 7 }), 7, 'object arg reads its property')
  is(ex.f(42), undefined, 'number arg has no .foo → undefined (polymorphism is load-bearing)')
  is(ex.f('hi'), undefined, 'string arg has no .foo → undefined')
  // Pre-watr: watr's inliner splices the dispatch helper's body into $f — the
  // NAME disappears while the polymorphic dispatch (rightly) stays.
  const wat = jz.compile(`export function f(o) { return o.foo }`, { wat: true, optimize: { level: 2, watr: false } })
  // Polymorphic read keeps a runtime tag-dispatch helper. The name is host-coupled:
  // the JS host emits the `__dyn_get_any_*` variant, the WASI boundary lowers the same
  // poly read through the `__dyn_get_cache_*` path. An OBJECT-narrowed param would
  // instead emit `__dyn_get_expr_t` (OBJECT memory layout) — its absence is the
  // host-independent proof that narrowing did NOT fire.
  ok((onWasi() ? /\$__dyn_get_cache/ : /\$__dyn_get_any/).test(wat), 'read-only param keeps a polymorphic dispatch')
  is(count(wat, /\$__dyn_get_expr_t\b/g), 0, 'no OBJECT-layout fast path on a bare-read param')
})

test('boundary: number-key index does not imply ARRAY → string indexing returns a char', () => {
  // `'hello'[0]` is `'h'` — strings ARE index-accessible. A number key therefore
  // does NOT prove the receiver is an array; narrowing `x` to ARRAY on `x[0]` would
  // read a string pointer's bytes as array elements. The polymorphic `[]` read must
  // honor JS string indexing.
  const ex = run(`export function f(x) { return x[0] }`)
  is(ex.f([9, 8]), 9, 'array arg → element 0')
  is(ex.f('hello'), 'h', 'string arg → character 0 (number key ≠ array proof)')
})

test('boundary: string-key index does not imply OBJECT → string receiver stays valid', () => {
  // `'hi'['a']` is `undefined` (valid — strings accept string keys, yielding
  // undefined for non-index keys). A string key does NOT prove OBJECT; narrowing
  // would reinterpret a string/number value as an OBJECT pointer.
  const ex = run(`export function f(x) { return x['a'] }`)
  is(ex.f('hi'), undefined, 'string arg, string key → undefined (string key ≠ object proof)')
  is(ex.f(42), undefined, 'number arg, string key → undefined')
})

// ───────────────────────────────────────────────────── call-site lattice (paramReps)

test('paramReps val: consistent ARRAY callers fold to direct header read', () => {
  // Both callers pass array literals → val=ARRAY consensus → callee's
  // `.length` becomes a direct memory load of the header word (no helper).
  // Inspect jz output without watr — `inlineOnce` would fuse `$lenOf` away,
  // erasing the helper-resolved header-load and leaving the test ambiguous.
  const wat = jz.compile(`
    const lenOf = (xs) => xs.length
    export const a = () => lenOf([1, 2, 3])
    export const b = () => lenOf([4, 5, 6, 7])
  `, { wat: true, optimize: { watr: false } })
  is(count(wat, /\$__length\b/g), 0)
  is(count(wat, /\$__len\b/g), 0)
  // Body should contain a direct header load (i32.load over __ptr_offset - 8).
  ok(/\(i32\.load[\s\S]*?\$__ptr_offset[\s\S]*?\(i32\.const 8\)/.test(wat),
    'expected direct header i32.load')
})

test('paramReps val: caller disagreement forces __length poly', () => {
  // Caller a passes array, caller b passes string → val sticky-null on the
  // lattice → callee falls back to fully-polymorphic __length.
  // sourceInline off: inlined, each site resolves monomorphically and the
  // poly __length (the mechanism under test) correctly disappears.
  const wat = jz.compile(`
    const lenOf = (xs) => xs.length
    export const a = () => lenOf([1, 2, 3])
    export const b = () => lenOf('foo')
  `, { wat: true, optimize: { sourceInline: false } })
  ok(count(wat, /\$__length\b/g) >= 1, 'sticky-null val should keep __length')
})

test('paramReps val: a default value supplies the kind for an omitted arg', () => {
  // `g(a = [])` called with an omitted arg AND a typed-array arg: the missing-arg
  // site contributes the default's kind (ARRAY) instead of poisoning the lattice,
  // so the consensus is ARRAY and `.length` drops the polymorphic `__length`.
  // This is the sound core of "declare a param's type with a default": every value
  // reaching `g` is either a proven array or the array default.
  const wat = jz.compile(`
    const g = (a = []) => a.length
    export const p = () => g([1, 2, 3])
    export const q = () => g()
  `, { wat: true, optimize: { sourceInline: false } })
  is(count(wat, /\$__length\b/g), 0, 'default-supplied ARRAY consensus drops poly __length')
})

test('paramReps val: an untyped forwarded arg keeps a default param polymorphic', () => {
  // Soundness floor. `g(a = [])` is fed `g(x)` where `x` is an exported param —
  // an external caller may pass a string (`f("hi")` → `"hi".length` is valid JS,
  // === 2). The default does NOT prove the runtime value is an array, so the
  // consensus is poisoned by the untyped site and `.length` MUST stay polymorphic.
  const wat = jz.compile(`
    const g = (a = []) => a.length
    export const f = (x) => g(x)
  `, { wat: true })
  ok(count(wat, /\$__length\b/g) >= 1, 'untyped forwarded arg must keep __length poly')
})

test('default-param narrowing: runtime stays JS-correct across arg shapes', () => {
  // The narrowing must not change observable results. Omitted → default; typed → arg.
  const g = run(`const g = (a = []) => a.length; export const f = (n) => n === 0 ? g() : g([1, 2, 3])`).f
  is(g(0), 0, 'omitted arg uses the [] default (length 0)')
  is(g(1), 3, 'typed-array arg used directly (length 3)')
  // The soundness floor at runtime: an untyped forward of a string still reads
  // string length (param stayed polymorphic).
  const h = run(`const g = (a = []) => a.length; export const f = (x) => g(x)`).f
  is(h('hi'), 2, 'string forwarded through a default param reads string length')
  is(h([9, 8]), 2, 'array forwarded reads array length')
})

test('intConst: unanimous int-literal arg folds local.get to i32 const', () => {
  // Every caller passes k=7 → narrow.js D-phase sets paramReps[scale][1]
  // .intConst=7. compile.js seeds localReps.intConst; emitLocalGet sees it
  // and emits the literal instead of a local read.
  // sourceInline off: the fixture observes the narrowing through $scale's
  // body, and the leaf inliner would otherwise (correctly) dissolve it.
  const wat = jz.compile(`
    const scale = (x, k) => x * k
    export const a = (x) => scale(x, 7)
    export const b = (x) => scale(x, 7)
  `, { wat: true, optimize: { sourceInline: false } })
  const body = wat.match(/\(func \$scale[\s\S]*?^  \)/m)
  ok(body, 'expected $scale func')
  ok(/f64\.const 7/.test(body[0]), 'expected k folded to f64.const 7')
  ok(!/local\.get \$k/.test(body[0]), 'expected no local.get $k')
})

test('intConst: caller disagreement keeps local.get', () => {
  // Negative: callers pass different literals → intConst poisoned →
  // body must read the param.
  const wat = jz.compile(`
    const scale = (x, k) => x * k
    export const a = (x) => scale(x, 7)
    export const b = (x) => scale(x, 9)
  `, { wat: true, optimize: { sourceInline: false } })
  const body = wat.match(/\(func \$scale[\s\S]*?^  \)/m)
  ok(body, 'expected $scale func')
  ok(/local\.get \$k/.test(body[0]), 'disagreement should keep local.get')
})

test('intConst: body write to param clears intConst (validateIntConstParams)', () => {
  // Even with unanimous callers, if the body writes to k (`k++`), the
  // const-substitution is unsound. validateIntConstParams clears it.
  const wat = jz.compile(`
    const step = (x, k) => { k = k + 1; return x * k }
    export const a = (x) => step(x, 7)
    export const b = (x) => step(x, 7)
  `, { wat: true })
  const body = wat.match(/\(func \$step[\s\S]*?^  \)/m)
  ok(body, 'expected $step func')
  ok(/local\.get \$k/.test(body[0]), 'body-write should keep local.get $k')
})

test('inferArrElemSchema: consistent caller schemas → direct slot load', () => {
  if (belowOpt(1)) return  // asserts schema-aware slot load eliminated __dyn_get (optimize >= 1)
  // initRows builds an array of `{x,y}` objects via .push. narrowReturnArrayElems
  // sets initRows.arrayElemSchema; runArrFixpoint propagates to runKernel's param
  // via inferArrElemSchema. The callee's `rows[i].y` becomes a direct
  // `f64.load offset=8` over a ptr-unboxed local (no __dyn_get_*, no __is_str_key).
  const wat = jz.compile(`
    const initRows = () => {
      const xs = []
      xs.push({x: 1, y: 2})
      xs.push({x: 3, y: 4})
      return xs
    }
    const runKernel = (rows) => {
      let s = 0
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        s = s + r.y
      }
      return s
    }
    export const main = () => runKernel(initRows()) | 0
  `, { wat: true })
  is(count(wat, /\$__dyn_get_/g), 0, 'schema-aware → no __dyn_get fallback')
  is(count(wat, /\$__is_str_key\b/g), 0, 'schema-aware → no string-key dispatch')
  ok(/f64\.load offset=\d+/.test(wat), 'expected direct schema-slot load')
})

test('inferTypedCtor: Float64Array arg unlocks SIMD vectorization', () => {
  if (belowOpt(2)) return  // asserts SIMD emission — requires the vectorizer (optimize >= 2)
  // Caller passes new Float64Array(...) → inferTypedCtor resolves the elem
  // ctor → paramReps[sumArr][0].typedCtor → compile.js seeds val=TYPED + the
  // elem ctor → ptrUnboxable narrows param to i32 + len becomes a direct
  // typed-header read + the loop vectorizes to f64x2 SIMD.
  const wat = jz.compile(`
    const sumArr = (a) => {
      let s = 0
      for (let i = 0; i < a.length; i++) s = s + a[i]
      return s
    }
    export const m1 = () => sumArr(new Float64Array([1, 2, 3, 4])) | 0
    export const m2 = () => sumArr(new Float64Array([5, 6, 7])) | 0
  `, { wat: true })
  ok(/v128\.load\b/.test(wat), 'expected SIMD vectorization')
  is(count(wat, /\$__typed_idx\b/g), 0, 'no runtime typed-idx dispatch')
  is(count(wat, /\$__length\b/g), 0, 'no polymorphic length')
})

test('inferTypedCtor: typed-array GLOBAL arg types the callee param (direct loads)', () => {
  // A module-global typed array passed as an arg must resolve its ctor the same
  // as a local would — the caller-side typed-elem context layers the module's
  // typed globals under its body locals. Regression: watercolor's `samp(f,…)` and
  // `advect(s,s0)` took their buffers from globals (u/v/dn), so without the global
  // layer `f`/`s0` stayed untyped and every bilinear tap went through the runtime
  // `__typed_idx` dispatch instead of a direct `f64.load` — ~1.6× slower than JS.
  const wat = jz.compile(`
    let g, g0
    let samp = (f, i) => f[i] + f[i + 1]
    let advect = (s, s0) => { let t = 0, i = 0; while (i < 50) { t = t + samp(s0, i); s[i] = t; i = i + 1 } return t }
    export let setup = (n) => { g = new Float64Array(n); g0 = new Float64Array(n); return g0 }
    export let run = () => advect(g, g0)
  `, { wat: true })
  // samp inlines into advect; the taps must be direct loads, not dynamic dispatch.
  is(forkOutsideInit(`
    let g, g0
    let samp = (f, i) => f[i] + f[i + 1]
    let advect = (s, s0) => { let t = 0, i = 0; while (i < 50) { t = t + samp(s0, i); s[i] = t; i = i + 1 } return t }
    export let setup = (n) => { g = new Float64Array(n); g0 = new Float64Array(n); return g0 }
    export let run = () => advect(g, g0)`), 0, 'global typed-array arg → no runtime typed-idx dispatch')
  ok(/f64\.load\b/.test(wat), 'expected direct f64.load on the global-typed buffer')
})

test('inferTypedCtor: a caller LOCAL shadowing a typed global is not mistyped', () => {
  // Soundness guard for the global layer: if the caller declares its own binding
  // with a global's name, that local — not the typed global — is the arg. Here the
  // local `g` is a plain Number, so `take(g)` must NOT inherit Float64Array; the
  // body indexing must stay polymorphic (string-key aware), never a direct load.
  const wat = jz.compile(`
    let g
    let take = (a) => a[0]
    export let setup = (n) => { g = new Float64Array(n); return g }
    export let run = (n) => { let g = n + 1; return take(g) }
  `, { wat: true })
  ok(/\$__is_str_key\b|\$__typed_idx\b|\$__dyn_get/.test(wat),
    'shadowing local (a Number) must keep polymorphic access — global ctor must not leak')
})

test('inferTypedCtor: typed + array caller disagreement keeps runtime dispatch', () => {
  // Float64Array + plain array → typedCtor sticky-null: the ORIGINAL function
  // must keep runtime dispatch (no unsound direct loads). Since the guarded
  // speculation pass (speculateTypedParams), the typed caller's evidence may
  // additionally produce a $spec clone — that's fine (its dispatch is a
  // runtime tag guard; the plain-array call falls back) — but the original
  // body itself must stay polymorphic, and both callers must compute exact
  // values through their respective paths.
  const src = `
    const sumArr = (a) => {
      let s = 0
      for (let i = 0; i < a.length; i++) s = s + a[i]
      return s
    }
    export const m1 = () => sumArr(new Float64Array([1, 2, 3, 4])) | 0
    export const m2 = () => sumArr([1, 2, 3]) | 0
  `
  const wat = jz.compile(src, { wat: true })
  const orig = wat.split(/\(func /).find(c => /^\$sumArr\b(?!\$)/.test(c)) || wat
  ok(!/v128\.load\b/.test(orig), 'original body stays scalar/polymorphic under disagreement')
  const { exports } = jz(src)
  is(exports.m1(), 10, 'typed caller exact (guarded fast path allowed)')
  is(exports.m2(), 6, 'plain-array caller exact through the original')
})

test('paramAllUsesNumeric: relational use proves a TypedArray-length param numeric', () => {
  // `new Float64Array(n)` is polymorphic (length | array-copy | buffer-view). A
  // bare param there proves nothing — but `i < n` is a numeric use (jz lowers `<`
  // to f64.lt), so the param is VAL.NUMBER and the ctor collapses to the length
  // path: no `.from` copy arm, no `__ptr_offset` view arm. No source type hint.
  const wat = jz.compile(`export let f = (n) => {
    let a = new Float64Array(n)
    for (let i = 0; i < n; i++) a[i] = i
    return a[0]
  }`, { wat: true })
  is(count(wat, /\$__ptr_offset\b/g), 0, 'proven-numeric length collapses the polymorphic ctor (no view arm)')
  is(count(wat, /\.from\b/g), 0, 'no array-copy arm')
  is(run(`export let f = (n) => { let a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = i; return a.length }`).f(5), 5, 'length path sizes the buffer')
})

test('paramAllUsesNumeric: TypedArray-copy param stays polymorphic (no false proof)', () => {
  // `arr` is used ONLY as `new Float64Array(arr)` — that slot is numeric-COMPATIBLE
  // but not PROVING. Marking it numeric would mis-size a zero-length buffer instead
  // of copying. It must stay polymorphic so the array-copy path runs.
  const f = run(`export let f = (arr) => { let a = new Float64Array(arr); return a.length }`).f
  is(f([10, 20, 30]), 3, 'array arg is copied (length 3), not treated as a length')
})

test('paramAllUsesNumeric: forwarding to a numeric local closure proves the param', () => {
  // heapsort shape: `n` forwarded to `heapify(n)`. The call arg is judged by the
  // closure's own param numericity (`m >> 1`, `child < m` are numeric), so `n` is
  // VAL.NUMBER and the `new Float64Array(n)` collapses — no string runtime dragged in.
  const wat = jz.compile(`export let sort = (n) => {
    let a = new Float64Array(n)
    for (let i = 0; i < n; i++) a[i] = i
    let heapify = (m) => { for (let r = (m >> 1) - 1; r >= 0; r--) { let c = 2 * r + 1; if (c < m) a[r] = a[c] } }
    heapify(n)
    return a[0]
  }`, { wat: true })
  is(count(wat, /\$__ptr_offset\b/g), 0, 'forwarded-to-numeric-closure param collapses the ctor')
  is(count(wat, /\$__to_str\b/g), 0, 'no string runtime — param never ToNumber-coerced through a string path')
})

test('paramAllUsesNumeric: forwarding to a string-using closure stays polymorphic', () => {
  // Soundness floor: `s` forwarded to `g(x)=>x.toUpperCase()` is a STRING use, so
  // the param must NOT be marked numeric. The string flows through correctly.
  is(run(`export let f = (s) => { let g = (x) => x.toUpperCase(); return g(s) }`).f('hi'), 'HI',
    'string forwarded to a string-using closure is preserved')
})

test('paramAllUsesNumeric: multi-arg forward to a MODULE helper proves the param', () => {
  // The plasma/raytrace shape: an exported `t` proven by `t * 0.6` is ALSO passed,
  // amid several args, into a sibling module helper — `fbm(x, y, t, …)`. Two gaps
  // conspired: (1) multi-arg calls parse to one flat `(, a b c)` node, so the
  // forward never matched arg POSITIONS and rejected the param; (2) only body-local
  // closures (not module functions) were forwarded into at all. With both fixed `t`
  // proves numeric — no per-pixel `__to_num`, no polymorphic-`+` string fork inside
  // `Math.sin(2*y + t)`. Plasma 1.0× → 1.75×, raytrace → 1.32× over V8.
  // `g` takes 3 args and is called twice (so it stays a real function, not inlined),
  // exercising the flat `(, …)` multi-arg node + the module-forward path. The loop
  // stores into a global buffer (plasma's `px[j]=` shape) — that's what defeats the
  // simpler expression-level numeric inference, leaving paramAllUsesNumeric the
  // deciding proof; the comma-bugged forward then rejected `t` despite its `t*0.6`.
  const wat = jz.compile(`
    let W = 0, px
    export let init = (n) => { W = n; px = new Int32Array(n); return px }
    let g = (a, b, ph) => Math.sin(a * 2.0 + ph) + Math.sin(b * 4.0 + ph) + Math.sin(a * 8.0 + ph)
                        + Math.sin(a * 16.0 + ph) + Math.sin(b * 32.0 + ph)
    export let frame = (t) => {
      let i = 0, t6 = t * 0.6, t3 = t * 0.3
      while (i < W) { let y = i * 0.01; px[i] = (g(y, y, t) + g(y, y, t6) + g(y, y, t3) + Math.sin(2.0 * y + t)) | 0; i = i + 1 }
    }
  `, { wat: true })
  const fr = wat.match(/\(func \$frame[\s\S]*?\n  \)/)?.[0] || ''
  is(count(fr, /\$__to_num\b/g), 0, 'multi-arg module-forward proves t — no per-iter coercion')
  is(count(fr, /\$__str_concat\b/g), 0, 'numeric `+` — no string-concat fork')
})

test('paramAllUsesNumeric: bare Math.* + `+` prove a numeric param inside a nested loop', () => {
  // The interference example: an exported `tick` used as `Math.sin(tick)` (bare),
  // `Math.sin(tick*2)`, and `tick + 1.2`, driving a nested per-pixel sweep that
  // stores into a global. `Math.f(x)` ToNumbers its arg, so a bare param there is a
  // PROVING numeric use (like `x*2`); binary `+` is numeric-COMPATIBLE and must not
  // reject that proof. Before the fix the generic-call fallthrough rejected the bare
  // Math arg, so `tick` stayed unproven and every cell paid a `__to_num` plus a
  // polymorphic `+` string-concat fork — interference ran 0.90× of JS, now ~parity.
  // The nested loop + global store defeats the simpler expression-level inference, so
  // the proof must come from paramAllUsesNumeric here.
  const wat = jz.compile(`
    let width = 0, mem
    export let setup = (n) => { width = n; mem = new Int32Array(n); return mem }
    export let update = (tick) => {
      let cx = Math.sin(tick * 2.0) + Math.sin(tick), y = 0
      while (y < 4) {
        let x = 0
        while (x < width) {
          mem[width * y + x] = (Math.sin(cx - tick * 8.0 + 1.2) * 255.0) | 0
          x = x + 1
        }
        y = y + 1
      }
    }
  `, { wat: true })
  const upd = wat.match(/\(func \$update[\s\S]*?\n  \)/)?.[0] || ''
  is(count(upd, /\$__to_num\b/g), 0, 'bare Math.sin(tick) proves tick numeric — no per-cell coercion')
  is(count(upd, /\$__str_concat\b/g), 0, 'numeric `+` — no per-cell string-concat fork')
})

test('paramAllUsesNumeric: a `+`-with-string-literal use stays a real concat (soundness)', () => {
  // The numeric proof must NOT swallow genuine concatenation: a `+` with a string
  // literal operand is concat intent, so the param stays polymorphic (not narrowed).
  const wat = jz.compile(`export let f = (s) => { let r = s + "!"; return r }`, { wat: true })
  ok(/\$__str_concat\b/.test(wat), '`+` with a string literal stays a real concat')
})

test('paramNeverString: additive exported f64 param skips the per-iteration string fork', () => {
  // The julia/floatbeat shape: `z = z*z + cre` in a hot loop, `cre` an exported f64
  // param used only additively. Binary `+` doesn't PROVE numericity (it may concat),
  // so paramAllUsesNumeric rejects it — but the export boundary (`wrapVal` passes a
  // JS number; a string arg is unsupported, → NaN) does. paramNeverString trusts it,
  // dropping the `__is_str_key`/`__str_concat` fork that a typed-array store in the
  // same function would otherwise drag onto every `+`.
  const wat = jz.compile(`
    let px
    export const resize = (n) => { px = new Uint32Array(n); return px }
    export const frame = (cre, cim, n) => {
      let q = 0
      while (q < n) {
        let z = 0.0, zy = 0.0, it = 0
        while (it < 160 && z*z + zy*zy < 16.0) { zy = 2.0*z*zy + cim; z = z*z - zy*zy + cre; it++ }
        px[q] = it; q++
      }
    }
  `, { wat: true, optimize: 2 })
  is(count(wat, /\$__is_str_key\b/g), 0, 'additive numeric params must not emit a string-key fork')
  is(count(wat, /\$__str_concat\b/g), 0, 'no string-concat helper dragged into a pure float kernel')
})

test('paramNeverString: a param used as a string is NOT falsely trusted numeric', () => {
  // Soundness floor for the boundary trust. A string-literal `+` operand, a string
  // method, or a member/index access on the param all disqualify it — it stays
  // polymorphic and string semantics are preserved.
  is(run(`export const f = (p) => "x" + p`).f('y'), 'xy', 'string-literal concat preserved')
  is(run(`export const f = (p) => p + "x"`).f('y'), 'yx', 'reverse string concat preserved')
  is(run(`export const f = (p) => \`v=\${p}\``).f('hi'), 'v=hi', 'template interpolation preserved')
  is(run(`export const f = (p) => p.charCodeAt(0)`).f('A'), 65, 'string method receiver preserved')
})

test('boxedCaptures: mutated capture allocates a heap cell', () => {
  // `let n = 0; const inc = () => { n = n + 1; ... }` — the closure mutates
  // the outer var. boxedCaptures marks n boxed → cell allocated on
  // heap, captured by the closure, read/written via the cell pointer.
  // Force escape via `keep(...)` so inlineLocalLambdas doesn't splice the
  // closure away (which would leave n as a plain wasm local).
  const wat = jz.compile(`
    const keep = (f) => f
    export const main = () => {
      let n = 0
      const inc = keep(() => { n = n + 1; return n })
      inc()
      return inc() | 0
    }
  `, { wat: true })
  // The cell local is named `cell_<name>` by boxedCaptures.
  // ($ is non-word in JS regex, so \b after \$cell_n doesn't match — use cell_n.)
  ok(/cell_n\b/.test(wat), 'expected $cell_n local for boxed capture')
})

test('recordGlobalRep: module-level Float64Array enables SIMD in consumers', () => {
  if (belowOpt(2)) return  // asserts SIMD emission — requires the vectorizer (optimize >= 2)
  // Module-level `const buf = new Float64Array(...)` is recorded by
  // recordGlobalRep into ctx.scope.globalTypedElem. Any function
  // reading `buf[i]` / `buf.length` picks up the typed-element ctor without
  // call-site inference, enabling the same SIMD + direct-length paths as
  // the param-flow case.
  const wat = jz.compile(`
    const buf = new Float64Array([1, 2, 3, 4])
    export const sum = () => {
      let s = 0
      for (let i = 0; i < buf.length; i++) s = s + buf[i]
      return s | 0
    }
  `, { wat: true })
  ok(/v128\.load\b/.test(wat), 'expected SIMD over module-level typed buf')
  is(count(wat, /\$__length\b/g), 0, 'no poly length over typed global')
})

// ─────────────────────────────────────── inferModuleLetTypes: alias-graph fixpoint
//
// A module `let` typed-array global must keep its kind across aliasing — a single
// forward pass can't resolve a value that flows through a cycle or a not-yet-seen
// sibling. The fixpoint over the whole-program assignment graph closes these.
// Each case asserts the hot read stays a direct typed load (no __typed_idx element
// dispatch, no __str_idx/__str_concat string fork). The shared probe: two/more
// Float64Array globals, summed in a loop — dynamic dispatch shows up as forks.
const FORK = /\$__typed_idx\b|\$__str_idx\b|\$__str_concat\b|\$__is_str_key\b/g
const noFork = (body, msg) => is(count(body, FORK), 0, msg)
// PRE-watr, ctor-funcs excluded: `new Float64Array(x)` with a boundary-unknown x
// (exported init's param) must carry the TYPED-source copy arm (__typed_idx loop) —
// a semantically-required COLD arm, not the hot-loop dispatch these pins guard.
// Post-watr scoping is unusable both ways: watr's inliner erases helper NAMES
// (vacuous pass) or splices whole init bodies into callers (false fail).
const FORK_CALL = new Set(['$__typed_idx', '$__str_idx', '$__str_concat', '$__is_str_key'])
const forkOutsideInit = (src, initRe = /^\$(init|setup)$/) =>
  callsOutside(watTree(src, { level: 2, watr: false }), FORK_CALL, initRe)
const noForkHot = (src, msg) => is(forkOutsideInit(src), 0, msg)

test('inferModuleLetTypes: double-buffer swap keeps typed loads (waves regression)', () => {
  // `let tmp = a; a = b; b = tmp` — the canonical ping-pong swap. `a` flows from
  // `b`, `b` from a local `tmp` aliasing `a`: a 3-node cycle anchored on each
  // global's `new Float64Array` decl. A forward pass invalidated both (made waves
  // 16× slower — every a[i] forked __str_idx/__typed_idx, every + forked __str_concat).
  const src = `
    let a, b
    export let init = (n) => { a = new Float64Array(n); b = new Float64Array(n) }
    export let frame = (w) => {
      let s = 0.0, i = 0
      while (i < w) { s = s + a[i] + b[i]; i++ }
      let tmp = a; a = b; b = tmp
      return s
    }`
  noForkHot(src, 'swap-aliased typed globals must keep direct f64 loads, no string/typed fork')
  ok(/f64\.load\b/.test(jz.compile(src, { wat: true })), 'expected direct f64.load over the swapped buffers')
})

test('inferModuleLetTypes: 3-buffer rotation keeps typed loads', () => {
  noForkHot(`
    let a, b, c
    export let init = (n) => { a = new Float64Array(n); b = new Float64Array(n); c = new Float64Array(n) }
    export let f = (w) => {
      let s = 0.0, i = 0
      while (i < w) { s = s + a[i] + b[i] + c[i]; i++ }
      let t = a; a = b; b = c; c = t; return s
    }`, 'rotated typed globals stay typed')
})

test('inferModuleLetTypes: global aliased from a typed-returning user fn', () => {
  // `a = mk(n)` — globals are typed before inlining runs, so the call is opaque to
  // the forward pass. The `@ret:mk` virtual node carries mk's return ctor across.
  // BOTH arrow-body forms must anchor @ret: an arrow EXPR-body is the implicit
  // return (the scope-aware walk only sees explicit `return` nodes, so this arm
  // needs the enterFn implicit-return capture); a `{}` block uses explicit return.
  const exprBody = jz.compile(`
    let a
    let mk = (n) => new Float64Array(n)
    export let init = (n) => { a = mk(n) }
    export let f = (w) => { let s = 0.0, i = 0; while (i < w) { s = s + a[i]; i++ } return s }
  `, { wat: true })
  noFork(exprBody, 'global from expr-body typed fn must be typed')
  const blockBody = jz.compile(`
    let a
    let mk = (n) => { return new Float64Array(n) }
    export let init = (n) => { a = mk(n) }
    export let f = (w) => { let s = 0.0, i = 0; while (i < w) { s = s + a[i]; i++ } return s }
  `, { wat: true })
  noFork(blockBody, 'global from block-body typed fn must be typed')
})

test('inferModuleLetTypes: global aliased from a ctor-preserving typed method', () => {
  // `.subarray()` / `.slice()` return the receiver's typed-array kind.
  const wat = jz.compile(`
    let a, b
    export let init = (n) => { a = new Float64Array(n); b = a.subarray(0, n) }
    export let f = (w) => { let s = 0.0, i = 0; while (i < w) { s = s + b[i]; i++ } return s }
  `, { wat: true })
  noFork(wat, 'global from .subarray() must inherit the typed kind')
})

test('inferModuleLetTypes: alias to a NON-typed value stays polymorphic (soundness)', () => {
  // The fixpoint must not over-promote: if any assignment yields a non-typed value,
  // the global must keep dynamic dispatch (else a raw f64.load on a string traps).
  const wat = jz.compile(`
    let a
    export let init = (n, s) => { a = new Float64Array(n); if (s) a = "oops" }
    export let f = (i) => a[i]
  `, { wat: true, jzify: true })
  ok(count(wat, FORK) > 0, 'a mixed typed/string global must keep its dynamic read path')
})

test('inferModuleLetTypes: swap-temp name colliding with a numeric local stays typed (lbm regression)', () => {
  // The swap temp `s` in `step` (aliases typed `a`) shares its NAME with the loop
  // counter `s` in `frame` (a number, mutated by `s++`). A name-keyed alias graph
  // let the numeric `s` poison the typed swap-temp, cascading MIXED into both
  // buffers — every a[i] fell to runtime __str_idx/__typed_idx dispatch + f64
  // indices (lbm: 3.9× slower than JS). Scope-qualified keys keep the two `s` apart.
  const src = `
    let a, b
    export let init = (n) => { a = new Float64Array(n); b = new Float64Array(n) }
    export let step = (w) => {
      let i = 0; while (i < w) { b[i] = a[i] * 2.0; i++ }
      let s = a; a = b; b = s
    }
    export let frame = (n) => { let s = 0; while (s < n) { step(8); s++ } }`
  noForkHot(src, 'a numeric local must not poison a same-named typed swap-temp in another function')
  ok(/f64\.load\b/.test(jz.compile(src, { wat: true })), 'expected direct f64.load over the swapped buffers')
})

// ────────────────────────────── inferModuleGlobalValTypes: all-writers global scan
//
// recordGlobalRep only observes depth-0 (module-init-time) assignments. A global
// whose every write lives INSIDE a function body — subscript's parser keeps its
// cursor this way: `export let idx, cur, parse = s => (idx = 0, cur = s, …)` —
// never gets a valType from it, so every `cur.charCodeAt(i)` / `cur[i]` read
// keeps a runtime string-vs-typed fork (and the durable-receiver override probe
// for method calls). inferModuleGlobalValTypes closes that gap: a whole-program,
// shadow-aware scan of every write, meeting the RHS valTypes to one kind or
// failing closed. The `[]`-index read is the cleanest probe — a receiver with a
// proven kind drops straight to `$__str_idx` with no runtime dispatch; an unclaimed
// one forks between `$__str_idx` and `$__typed_idx` on a runtime tag test.
const TYPE_FORK = /\$__typed_idx\b/g
const noTypeFork = (wat, msg) => is(count(wat, TYPE_FORK), 0, msg)
const keepsTypeFork = (wat, msg) => ok(count(wat, TYPE_FORK) > 0, msg)

test('inferModuleGlobalValTypes: global assigned STRING only inside a function body proves STRING (subscript cur shape)', () => {
  // Mirrors subscript/parse.js exactly: a module global (`cur`) written only
  // inside a non-exported helper's body, from that helper's OWN parameter —
  // whose type in turn comes from a call-site argument (`buildSrc()`'s proven
  // STRING return), not a literal. Needs narrowSignatures' resolved param facts
  // (pass 2, post-narrowSignatures) — disable inlining so `setSrc`/`buildSrc`
  // survive as separate functions long enough to be call-site-typed, exactly
  // as subscript's own (much larger, naturally un-inlined) `parse` does.
  const src = `
    let cur
    const setSrc = (s) => { cur = s }
    const buildSrc = () => { let s = ''; for (let i = 0; i < 3; i++) s = s + 'ab'; return s }
    export let scan = () => {
      setSrc(buildSrc())
      let n = 0, i = 0
      while (i < cur.length) { n += cur[i].charCodeAt(0); i++ }
      return n
    }
  `
  const wat = jz.compile(src, { wat: true, optimize: { sourceInline: false } })
  noTypeFork(wat, 'a STRING-proven global receiver must drop the runtime string-vs-typed fork on `[]` reads')
  const ex = run(src, { optimize: { sourceInline: false } })
  const s = 'ababab'
  let want = 0
  for (let i = 0; i < s.length; i++) want += s[i].charCodeAt(0)
  is(ex.scan(), want, 'values bit-exact vs plain JS')
})

test('inferModuleGlobalValTypes: conflicting STRING/NUMBER writes across functions → no claim (fail closed)', () => {
  const src = `
    let g
    export let setStr = () => { g = 'x' }
    export let setNum = () => { g = 5 }
    export let getFirst = () => g[0]
    export let get = () => g
  `
  keepsTypeFork(jz.compile(src, { wat: true }),
    'a global written STRING in one function and NUMBER in another must keep the runtime dispatch — no false claim')
  const ex = run(src)
  ex.setStr(); is(ex.get(), 'x', 'string value round-trips')
  ex.setNum(); is(ex.get(), 5, 'numeric value round-trips — no false claim corrupted it')
})

test('inferModuleGlobalValTypes: a local shadowing the global name does not pollute its kind', () => {
  // `unrelated`'s `g` is a DIFFERENT, locally-scoped binding (`let g = 0`) that
  // happens to share the module global's name. Its NUMBER-ish writes must not
  // be attributed to the real global, whose only genuine write (in `setG`) is STRING.
  const src = `
    let g
    export let setG = () => { g = 'hello' }
    export let unrelated = () => { let g = 0; g = g + 1; return g }
    export let getFirst = () => g[0]
  `
  noTypeFork(jz.compile(src, { wat: true }),
    'a same-named LOCAL in an unrelated function must not poison the global — STRING claim should still fire')
  const ex = run(src)
  ex.setG()
  is(ex.getFirst(), 'h', 'global read is correct')
  is(ex.unrelated(), 1, 'the shadowing local computes independently')
})

test('inferModuleGlobalValTypes: a write from a nested closure counts (poisons on conflict)', () => {
  // If the closure body were invisible to the scan (treated as an opaque `=>`
  // boundary, the way analyzeBody's OWN per-function walk deliberately is),
  // `g` would wrongly resolve STRING from `setStr` alone. The closure's NUMBER
  // write must be seen and must conflict.
  const src = `
    let g
    export let setStr = () => { g = 'x' }
    export let setNumViaClosure = (arr) => { arr.forEach(x => { g = 5 }) }
    export let getFirst = () => g[0]
  `
  keepsTypeFork(jz.compile(src, { wat: true }),
    'a NUMBER write buried inside a closure must still conflict with the STRING evidence elsewhere')
})

test('inferModuleGlobalValTypes: a global written only inside a closure resolves (positive)', () => {
  // The mirror of the pin above: when the closure's write IS the only, provable
  // (literal) evidence, the closure must not be skipped as an opaque boundary —
  // the global should resolve cleanly.
  const src = `
    let g
    export let setG = (arr) => { arr.forEach(x => { g = 'hi' }) }
    export let getFirst = () => g[0]
  `
  noTypeFork(jz.compile(src, { wat: true }), 'a literal STRING write inside a closure must resolve the global')
  const ex = run(src)
  ex.setG([1])
  is(ex.getFirst(), 'h', 'closure-proven global reads correctly')
})

test('inferModuleGlobalValTypes: an exported mutable global stays unclaimed (host can write any value)', () => {
  // A wasm export of a MUTABLE global lets the host assign it any bit pattern
  // via `instance.exports.g.value = …`, invisible to any AST scan — must never
  // be claimed regardless of how consistent its VISIBLE writes look.
  const src = `
    export let g = undefined
    export let setG = () => { g = 'x' }
    export let getFirst = () => g[0]
  `
  keepsTypeFork(jz.compile(src, { wat: true }),
    'an exported MUTABLE global must stay unclaimed — the host can write any bit pattern to it directly')
  const ex = run(src)
  ex.setG()
  is(ex.getFirst(), 'x', 'value is still correct even though the kind is unclaimed')
})

// ─────────────────────────────────── typed-array index arithmetic stays i32
//
// A subscript is truncated to i32 at the memory boundary, so integer index math —
// including a literal term, the `+ 1` / `(j + 1)` of a bilinear/stencil gather —
// must compile to i32 ops, never an f64 round-trip (convert_i32 … f64.mul/add …
// trunc_sat). A prepare-wrapped literal `[null, 1]` used to bail the WHOLE index
// to f64 (tryI32Index rejected the Array-shaped literal before its int-literal
// check), dragging marble's hot bilinear sample ~1.6× behind JS.
test('typed-array index with a literal term stays pure i32 (marble regression)', () => {
  const wat = jz.compile(`
    let arr = new Float64Array(64)
    let W = 8
    export let gather = (fx, fy) => {
      let i = fx | 0, j = fy | 0
      return arr[j*W + i] + arr[j*W + i + 1] + arr[(j+1)*W + i] + arr[(j+1)*W + i + 1]
    }
  `, { wat: true })
  const at = wat.indexOf('(func $gather')
  const fn = wat.slice(at, wat.indexOf('(func', at + 6))
  is(count(fn, /i32\.trunc_sat_f64_s/g), 0, 'no f64→i32 index truncation in the gather')
  is(count(fn, /f64\.convert_i32_s/g), 0, 'index terms stay i32 — no i32→f64 widening')
  // Row offsets are i32 muls, never the guarded f64.mul ToInt32 round-trip.
  is(count(fn, /f64\.mul\b/g), 0, 'no f64 multiply on the index path')
  // hoistAddrBase now CSEs the shared `j*W` base between the two same-row reads
  // (`arr[j*W+i]` + `arr[j*W+i+1]` collapse to one base + offset=8), so the two
  // distinct row offsets need ≥2 i32.muls — fewer than the un-CSE'd 4, still all i32.
  ok(count(fn, /i32\.mul\b/g) >= 2, 'each distinct row offset (j*W, (j+1)*W) computed with i32.mul')
})

test('plain-array index with a literal term stays pure i32 (sibling of marble)', () => {
  // The non-typed ARRAY read path (module/array.js) computed its index with a bare
  // `asI32(emit(idx))` — the same f64 round-trip on `a[j*W + x + 1]`. Routed through
  // emitIndex so integer index math narrows to i32 there too. i32 index leaves
  // (`jj|0`/`xx|0`) so the only f64 risk would be the index lowering itself.
  const wat = jz.compile(`
    export let f = (arr, jj, xx) => {
      let j = jj | 0, x = xx | 0, W = 4
      return arr[j*W + x] + arr[j*W + x + 1] + arr[(j+1)*W + x]
    }
  `, { wat: true })
  const at = wat.indexOf('(func $f')
  const fn = wat.slice(at, wat.indexOf('(func', at + 6))
  is(count(fn, /i32\.trunc_sat_f64_s/g), 0, 'plain-array index stays i32 — no f64 truncation')
  is(count(fn, /f64\.convert_i32_s/g), 0, 'plain-array index terms stay i32')
})

// A `& m`-masked operand is provably ≤ m, so `t * (… & 63)` can't exceed 2^53 and
// must use i32.mul — not the guarded f64.mul + Infinity-canon `select` that ToInt32
// emits for an unbounded f64 product. That round-trip made the bytebeat kernel lose
// ~1.4× to V8/AS on x86 (it wins on ARM either way, so only this pin or an x86 bench
// catches the regression). mulFitsI32 now accepts a mask-bounded operand, not just a
// small literal.
test('masked multiply narrows to i32 — bytebeat t*(m&63) deopt', () => {
  const wat = jz.compile(
    'export let fill = (out, n) => { for (let t = 0; t < n; t++) out[t] = (t * (((t>>12)|(t>>8)) & (63 & (t>>4)))) & 255 }',
    { wat: true })
  const at = wat.indexOf('(func $fill')
  const fn = wat.slice(at, wat.indexOf('(func', at + 6))
  is(count(fn, /f64\.mul/g), 0, 'masked scale uses i32.mul, not f64.mul')
  is(count(fn, /f64\.const Infinity/g), 0, 'no Infinity-canon guard in the i32 kernel')
  ok(count(fn, /i32\.mul\b/g) >= 1, 'the t*(mask) product is an i32.mul')
})

test('inferArrElemSchema: caller disagreement keeps polymorphic dispatch', () => {
  // initA pushes `{x,y}`, initB pushes `{a,b}` — disagreeing schemas at the
  // lattice → paramReps[runKernel][0].arrayElemSchema sticky-nulls → callee
  // falls back to polymorphic dispatch.
  const wat = jz.compile(`
    const initA = () => { const xs = []; xs.push({x: 1, y: 2}); return xs }
    const initB = () => { const xs = []; xs.push({a: 1, b: 2}); return xs }
    const runKernel = (rows) => {
      let s = 0
      for (let i = 0; i < rows.length; i++) s = s + rows[i].x
      return s
    }
    export const m1 = () => runKernel(initA()) | 0
    export const m2 = () => runKernel(initB()) | 0
  `, { wat: true })
  ok(count(wat, /\$__dyn_get_/g) > 0, 'disagreement should keep __dyn_get fallback')
})

// ──────────────────────────────────────────────────────────────── instanceof B1

test('extractRefinements: instanceof Map → __map_has dispatch (not default __set_has)', () => {
  // Without refinement the .has fallback picks __set_has by default. With B1's
  // VAL.MAP refinement the post-condition scope dispatches to .map:has.
  // Pre-watr: the dispatch CHOICE is what's pinned; watr may inline the helper.
  const wat = jz.compile(`
    export const probe = (x, k) => {
      if (x instanceof Map) return x.has(k) ? 1 : 0
      return -1
    }
  `, { wat: true, jzify: true, optimize: { watr: false } })
  const probe = wat.match(/\(func \$probe[\s\S]+?\n  \)/)?.[0] || ''
  if (!onKernel()) ok(/\$__map_has\b/.test(probe), 'expected __map_has dispatch under instanceof Map refinement')  // self-host kernel codegen differs; in-process leg owns the shape check
  if (!onKernel()) ok(!/\$__set_has\b/.test(probe), 'should not fall back to default __set_has')
})

test('extractRefinements: instanceof Set → __set_has dispatch (no Map path)', () => {
  const wat = jz.compile(`
    export const probe = (x, v) => {
      if (x instanceof Set) return x.has(v) ? 1 : 0
      return -1
    }
  `, { wat: true, jzify: true, optimize: { watr: false } })
  const probe = wat.match(/\(func \$probe[\s\S]+?\n  \)/)?.[0] || ''
  ok(/\$__set_has\b/.test(probe), 'expected __set_has under instanceof Set refinement')
  if (!onKernel()) ok(!/\$__map_has\b/.test(probe), 'should not also pull __map_has path')  // self-host dispatch differs; in-process leg owns the shape check
})

test('extractRefinements: instanceof Float64Array → __typed_idx dispatch', () => {
  // Refinement to VAL.TYPED routes `x[i]` through the typed-array index helper.
  const wat = jz.compile(`
    export const probe = (x, i) => {
      if (x instanceof Float64Array) return x[i]
      return 0
    }
  `, { wat: true, jzify: true })
  const probe = wat.match(/\(func \$probe[\s\S]+?\n  \)/)?.[0] || ''
  ok(/\$__typed_idx\b/.test(probe), 'expected __typed_idx dispatch under TYPED refinement')
  ok(!/\$__arr_idx\b/.test(probe), 'should not fall back to __arr_idx')
})

test('staticInstanceofFold: [..] instanceof Array folds to constant true at jzify', () => {
  // No runtime check — dead-code elim collapses the whole branch.
  const wat = jz.compile(`
    export const probe = () => ([1,2,3] instanceof Array) ? 1 : 0
  `, { wat: true, jzify: true })
  const probe = wat.match(/\(func \$probe[\s\S]+?\n  \)/)?.[0] || ''
  ok(!/\$__ptr_type\b/.test(probe), 'static fold should leave no runtime predicate')
  ok(!/\$__is_/.test(probe), 'should not emit __is_* helper call')
})

test('staticInstanceofFold: primitive literal instanceof X folds to false', () => {
  // Per JS spec, primitives are never instances. jzify folds at AST time.
  const wat = jz.compile(`
    export const probe = () => ('hello' instanceof Map) ? 1 : 0
  `, { wat: true, jzify: true })
  const probe = wat.match(/\(func \$probe[\s\S]+?\n  \)/)?.[0] || ''
  ok(!/\$__is_map\b/.test(probe), 'static fold should skip the runtime predicate')
  // Result must be 0 (the false branch).
  ok(/f64\.const 0/.test(probe))
})

// ──────────────────────────────────────────────────────────────── runtime sanity

test('inference runtime sanity: notString + intConst + arrElemSchema', () => {
  // Cross-check: facts that elide dispatch must not change observed semantics.
  const { main } = run(`
    const initRows = () => {
      const xs = []
      xs.push({x: 1, y: 2})
      xs.push({x: 10, y: 20})
      xs.push({x: 100, y: 200})
      return xs
    }
    const sumScaled = (rows, k) => {
      let s = 0
      for (let i = 0; i < rows.length; i++) s = s + rows[i].x * k
      return s
    }
    export const main = () => sumScaled(initRows(), 3) | 0
  `)
  // (1 + 10 + 100) * 3 = 333
  is(main(), 333)
})

// ──────────────────────────────────────────────────────────── i32 narrow range-safety

// jz narrows a local to i32 only on an i32 *signal* — an i32-literal init plus
// i32-only operands (or `x|0`, bitwise, Int32Array reads). A binding fed by any
// non-i32 source is *ambiguous* and stays NaN-boxed f64: the README promise
// "ambiguous → f64, never a wrong type". These pin that the f64 default actually
// holds where it must, so a future over-eager narrower can't silently 32-bit-wrap
// an accumulator that grows past 2^31.
//
// The converse — an accumulator with *unanimous* i32 signals (i32 init + i32
// steps / Int32Array elements) stays i32 and wraps mod 2^32 past 2^31 — is the
// deliberate i32 value-model trade, the same feature that lets integer reductions
// auto-vectorize (`i32x4`) and digit parsers stay scalar-i32. It is *not* an
// ambiguity bug: the code's own literals chose i32. See test/optimizer.js
// ("auto-vectorize via i32x4 SIMD", "no f64 widen/truncate in tokenizer-shape loop").

test('i32 range-safety: ambiguous accumulator defaults to f64 (no silent 2^31 wrap)', () => {
  // Each accumulator is fed by a non-i32 source and pushed past 2^31. The f64
  // default keeps the exact value; an i32 narrowing here would wrap (e.g. 1e10
  // → 1410065408). No `| 0` anywhere — the source type alone must decide.
  const { fParam, fDiv, fBig } = run(`
    export const fParam = (step) => { let s = 0; for (let i = 0; i < 100000; i++) s += step; return s }
    export const fDiv = () => { let s = 0; for (let i = 1; i < 5; i++) s += 1e10 / i; return s }
    export const fBig = () => { let a = [3e9, 3e9, 3e9, 3e9]; let s = 0; for (let i = 0; i < 4; i++) s += a[i]; return s }
  `)
  is(fParam(100000), 1e10)                                  // f64 param step
  is(fDiv(), 1e10 / 1 + 1e10 / 2 + 1e10 / 3 + 1e10 / 4)     // division → f64
  is(fBig(), 12e9)                                          // elems > 2^31 → f64 array
})

test('i32 range-safety: f64-fed accumulator declared f64 in WAT (never i32-narrowed)', () => {
  // Type-level proof the ambiguous binding never narrows: the accumulator local
  // is f64 and updated with f64.add — not i32.add.
  const wat = jz.compile(`
    export const sum = (step) => { let s = 0; for (let i = 0; i < 10; i++) s += step; return s }
  `, { wat: true, optimize: { watr: false } })
  const body = wat.match(/\(func \$sum[\s\S]*?^  \)/m)[0]
  ok(/\(local \$s f64\)/.test(body), 'f64-fed accumulator must stay f64')
  ok(/local\.set \$s\s*\(f64\.add/.test(body), 'accumulation into $s must use f64.add')
  ok(/\(local \$i i32\)/.test(body), 'the i32-bounded counter still narrows independently')
})

// ───────────────────────────────────────────────────── integer-global inference
//
// Purpose-focused numeric module globals (sizes, strides, indices, counters) are
// integers; demanding `x | 0` annotations defeats clean code. So a numeric global
// is i32 by default, demoted to f64 only on *proof* of a fraction (a non-integer
// literal, `/`, `**`, a float `Math.*`, or a reference to an already-fractional
// value). See research/inference.md ("Assume integer unless provably fractional").

test('integer-global inference: i32 narrowing preserves integer arithmetic end-to-end', () => {
  if (onWasi()) return  // wasi: run-reserved export
  // `N`, `acc` carry integers through param assigns, `>>>`, `+= i`. Narrowing to
  // i32 must compute identically to the f64 path for in-range values:
  // sum(0..n-1) + (n>>>1) = 499500 + 500 at n=1000.
  const ex = run(`
    let N = 0, acc = 0;
    export let init = (n) => { N = n; acc = 0; };
    export let run = () => { let i = 0; while (i < N) { acc += i; i++; } return acc + (N >>> 1); };
  `)
  ex.init(1000)
  is(ex.run(), 499500 + 500, 'i32-narrowed counter/accumulator compute exactly')
})

test('integer-global inference: provably-fractional global stays f64 (no truncation)', () => {
  // `step = 1.0 / n` is fractional — must NOT narrow to i32, or the running sum
  // truncates each addend to 0. The f64 carrier preserves the fraction.
  const ex = run(`
    let step = 0, total = 0;
    export let init = (n) => { step = 1.0 / n; total = 0; };
    export let run = (k) => { let i = 0; while (i < k) { total = total + step; i++; } return total; };
  `)
  ex.init(8)               // step = 0.125
  is(ex.run(4), 0.5, 'fractional global keeps its fraction (4 × 0.125)')
})

test('integer-global inference: numeric-init global reassigned to a string stays the f64 box', () => {
  // Safety guard: a global initialized numeric but later assigned a non-number
  // must remain the f64 NaN-box carrier — narrowing it to i32 would truncate the
  // boxed pointer to garbage. The disqualifier keeps it f64.
  const ex = run(`
    let g = 0;
    export let setNum = (n) => { g = n; };
    export let setStr = () => { g = "hello"; };
    export let get = () => g;
  `)
  ex.setNum(42)
  is(ex.get(), 42, 'numeric value round-trips')
  ex.setStr()
  is(ex.get(), 'hello', 'string value round-trips — global was not narrowed to i32')
})

// ──────────────────────────────────────────── hoisted integer index offset → i32

test('i32-offset: hoisted row offset `let o = y*n` narrows to i32 for a typed-array index', () => {
  // `let o = y*n` is f64-typed (variable-stride product) but integer-valued and
  // feeds an array index — it must narrow to i32, giving pure-i32 addressing with
  // no per-access widening, like the inline `a[y*n+x]` form. Observed at
  // `optimize: false` where the offset survives as a local.
  const wat = jz.compile(`
    export let f = () => {
      let n = 64
      let a = new Float64Array(4096)
      let s = 0
      for (let y = 0; y < n; y++) {
        let o = y * n
        for (let x = 0; x < n; x++) s += a[o + x]
      }
      return s
    }
  `, { wat: true, optimize: false })
  ok(/\(local \$o i32\)/.test(wat), 'offset `o` is typed i32 (no per-access f64 widening)')
})

test('i32-offset: hoisted offset computes correct in-bounds values', () => {
  const ex = run(`
    export let f = () => {
      let n = 100
      let a = new Float64Array(n * n)
      for (let y = 0; y < n; y++) { let o = y * n; for (let x = 0; x < n; x++) a[o + x] = o + x }
      return a[99 * 100 + 99]
    }
  `)
  is(ex.f(), 9999, 'hoisted-offset write/read round-trips exactly')
})

test('i32-offset: fractional intermediate is NOT narrowed to i32 (no truncation)', () => {
  const ex = run(`export let f = () => { let z = 0.5; let p = z * z + z; return p }`)
  is(ex.f(), 0.75, 'fractional arithmetic stays f64 — not truncated to 0')
})

test('i32-offset: a fractional-derived index truncates at access, not earlier', () => {
  const ex = run(`
    export let f = () => {
      let a = new Float64Array(8)
      a[3] = 42
      let i = 1.5
      let j = i * 2
      return a[j]
    }
  `)
  is(ex.f(), 42, 'j = 3.0 truncates at the access → reads a[3]')
})

// Param i32-narrowing from integer typed-array element args. A helper whose scalar param is
// fed ONLY integer typed-array elements — directly `probe(keys, src[i])` and via a local
// `aa = perm[i]; grad(aa,…)` — is an i32 value (the element is a 32-bit int in i32 range), so
// the param narrows to i32 and its probe/hash loop stays native i32: no f64 compare, no
// convert/trunc round-trip. Two fixes feed this: the wasm-consensus sees an int-typed-array
// element ARG as i32 (caller typedCtor overlay), and the narrow-phase callerLocals type a LOCAL
// bound to a typed-pointer-param element as i32 (mirrors emit's typedElem seeding). Drives the
// dict / noise / levenshtein gains.
test('param i32-narrowing: scalar param fed integer typed-array elements narrows to i32', () => {
  if (onWasi()) return  // wasi run-reserved locals rename; types are the portable assertion
  // dict-shaped: key `k` from src[i] (direct arg), threaded through Math.imul + === keys[h].
  // (hash folded inline so the assertion isolates `k`'s narrowing, not a separate helper's.)
  const dictWat = jz.compile(`
    let probe = (keys, k) => { let h = (Math.imul(k, 0x9e3779b1) >>> 0) & 1023; while (keys[h] !== k && keys[h] !== -1) h = (h+1)&1023; return h }
    let run = (keys, src, n) => { let s = 0, i = 0; while (i < n) { s = (s + probe(keys, src[i]) + probe(keys, src[i]+1)) | 0; i++ } return s }
    export let main = () => { let keys = new Int32Array(1024), src = new Int32Array(512); return run(keys, src, 512) }
  `, { wat: true, optimize: { level: 'speed', sourceInline: false } })
  const probe = dictWat.match(/\(func \$probe\b[\s\S]*?\n  \)/)[0]
  ok(/\(param \$k i32\)/.test(probe), 'probe key param narrows to i32 (fed int typed-array elements)')
  ok(!/f64\.eq|f64\.ne|trunc_sat/.test(probe), 'no f64 compare / trunc round-trip in the probe loop')

  // noise-shaped: hash from a LOCAL `aa = perm[…]` (typed-pointer param element) → grad(aa,…).
  const noiseWat = jz.compile(`
    let grad = (hash, x, y) => { let h = hash & 3; let u = (h&1)===0 ? x : -x; let v = (h&2)===0 ? y : -y; return u+v }
    let perlin = (perm, x, y) => { let X = (x|0)&255; let aa = perm[perm[X]+1]; let ba = perm[perm[X+1]+1]; return grad(aa, x, y) + grad(ba, x-1.0, y) }
    let run = (perm, n) => { let s = 0.0, i = 0; while (i < n) { s = s + perlin(perm, i*0.1, i*0.2); i++ } return s }
    export let main = () => { let perm = new Int32Array(512); return run(perm, 256) }
  `, { wat: true, optimize: { level: 'speed', sourceInline: false } })
  const grad = noiseWat.match(/\(func \$grad\b[\s\S]*?\n  \)/)[0]
  ok(/\(param \$hash i32\)/.test(grad), 'grad hash param narrows to i32 (fed a local bound to an Int32 param element)')
})

// Recursive identity arg doesn't poison i32-narrowing. nqueens' `solve(all, cols, d1, d2)` is
// recursive; `all` threads through unchanged (`solve(all, …)`) while the others recur as i32
// bitwise exprs. The self-call's bare `all` arg must be treated as a fixpoint identity (no
// constraint), else exprType reads `all`'s not-yet-narrowed f64 and the meet poisons the i32 the
// non-recursive caller (`solve((1<<n)-1, …)`) proves — leaving `all` an f64 bitmask paying
// convert/trunc per recursion.
test('param i32-narrowing: recursive identity arg does not poison the i32 consensus', () => {
  if (onWasi()) return
  const wat = jz.compile(`
    let solve = (all, cols, d1, d2) => {
      if (cols === all) return 1
      let cnt = 0, avail = all & ~(cols | d1 | d2)
      while (avail !== 0) { let b = avail & (-avail); avail = avail - b; cnt = cnt + solve(all, cols|b, (d1|b)<<1, (d2|b)>>1) }
      return cnt
    }
    let countN = (n) => solve((1<<n)-1, 0, 0, 0)
    export let main = () => { let s = 0, i = 0; while (i < 6) { s = (s + countN(8 + (i&3))) | 0; i++ } return s }
  `, { wat: true, optimize: { level: 'speed', sourceInline: false } })
  const solve = wat.match(/\(func \$solve\b[\s\S]*?\n  \)/)[0]
  ok(/\(param \$all i32\)/.test(solve), 'recursive identity param `all` narrows to i32')
  ok(!/convert_i32_s|trunc_sat/.test(solve), 'no f64↔i32 round-trip in the recursive bitmask loop')
  ok(/\(result i32\)/.test(solve) && /\(local \$cnt i32\)/.test(solve), 'recursive i32 result narrows (cnt + return stay i32, not f64)')
})

// Recursive result cycle narrows to i32. A recursive integer function whose result feeds its own
// returns (`cnt = cnt + sumTo(n-1); return cnt`) is stuck f64 unless the result narrowing breaks
// the cycle optimistically (assume i32, re-analyze, keep iff self-consistent). Without it `cnt` and
// the return widen to f64, so an i32 consumer of the result pays a convert.
test('result i32-narrowing: a recursive integer result narrows to i32 (optimistic cycle break)', () => {
  if (onWasi()) return
  // No `|0` crutch: jz reasons that `n` and the result are integers on its own. The recursive arg
  // `n - 1 - i` is a param/local integer expression (i32 iff n is i32) — optimistic recursive
  // narrowing breaks the cycle so `n` narrows from the non-recursive `sumTo(7)` site.
  const wat = jz.compile(`
    let sumTo = (n) => { if (n <= 0) return 0; let s = 0; let i = 0; while (i < n) { s = s + sumTo(n - 1 - i); i++ } return s & 0x3ffffff }
    export let main = () => sumTo(7) | 0
  `, { wat: true, optimize: { level: 'speed', sourceInline: false } })
  const sumTo = wat.match(/\(func \$sumTo\b[\s\S]*?\n  \)/)[0]
  ok(/\(param \$n i32\)/.test(sumTo), 'recursive param `n` narrows to i32 (no |0 hint — decreasing-recursion cycle broken)')
  ok(/\(result i32\)/.test(sumTo), 'recursive sumTo result narrows to i32')
  ok(!/f64\./.test(sumTo), 'no f64 ops in the recursive integer body (param + result + accumulator all i32)')
})

// A function returning a typed-array-element read — `lookup = (keys, vals, k) => { … return vals[h] }`
// with vals an Int32Array param — must narrow its RESULT to i32. The result-narrowing pass (Phase E)
// runs before the typed-pointer param ABI (Phase G) tags `vals` as Int32Array, so the first pass sees
// `vals[h]` as NaN-boxed f64 and leaves the result f64 — every call site then runs the full
// __typed_idx/ToNumber unbox on the returned element (the dict bench paid this 491520× per kernel run).
// The fix: evalTails seeds the typed-elem overlay from the func's TYPED params, and an I2 re-narrow runs
// after Phase G. Observable: lookup's result is i32 with no ToNumber dispatch on the returned element.
test('result i32-narrowing: a typed-array-element return narrows to i32 (post-typed-param re-narrow)', () => {
  if (onWasi()) return
  const wat = jz.compile(`
    let lookup = (keys, vals, k) => {
      let h = k & 1023
      while (keys[h] !== -1) { if (keys[h] === k) return vals[h]; h = (h + 1) & 1023 }
      return -1
    }
    export let main = () => {
      let keys = new Int32Array(1024), vals = new Int32Array(1024)
      let i = 0; while (i < 1024) { keys[i] = -1; i++ }
      i = 0; while (i < 500) { let h = (i*7) & 1023; while (keys[h] !== -1) h = (h+1)&1023; keys[h] = i*7; vals[h] = i*3; i++ }
      let s = 0; i = 0; while (i < 500) { s = (s + lookup(keys, vals, i*7)) | 0; i++ }
      i = 0; while (i < 500) { s = (s + lookup(keys, vals, i*11)) | 0; i++ }
      return s
    }
  `, { wat: true, optimize: { level: 'speed', sourceInline: false } })
  const lookup = wat.match(/\(func \$lookup\b[\s\S]*?\n  \)/)[0]
  ok(/\(result i32\)/.test(lookup), 'typed-element return narrows the result to i32 (not NaN-boxed f64)')
  ok(!/__to_str|__typed_idx|trunc_sat/.test(lookup), 'no ToNumber/__typed_idx dispatch on the returned element')
  ok(!/convert_i32/.test(lookup), 'no i32→f64 rebox inside lookup — the element stays i32 end to end')
})

// A helper `f(src[i])` where the receiver `src` is a typed-array PARAMETER of the caller: the
// element is a Number, so f's param is numeric and skips `__to_num`. Previously only bare-name /
// global-binding args carried caller value-type context to the call-site val lattice — a typed
// PARAM's element type was invisible, so the param stayed polymorphic and every use pulled the
// __to_num string-parse tree (which then blocks the SIMD lane-inline of colour helpers like lin).
test('param VAL.NUMBER: a helper fed typed-array-PARAM elements skips __to_num', () => {
  if (onWasi()) return  // wasi run-reserved locals rename; the param type is the portable assertion
  // Two call sites keep `lin` standalone (single-caller inline would hide the param proof).
  const wat = jz.compile(`
    let lin = (c) => c <= 0.04045 ? c / 12.92 : (c + 0.055) * 1.5
    let run = (src, dst, n) => { let i = 0; while (i < n) { dst[i] = lin(src[i]) + lin(src[i] + 1); i++ } }
    export let main = () => { let s = new Float64Array(64), d = new Float64Array(64); run(s, d, 64); return d[3] }
  `, { wat: true, optimize: { level: 'speed', sourceInline: false } })
  const lin = wat.match(/\(func \$lin\b[\s\S]*?\n  \)/)[0]
  ok(/\(param \$c f64\)/.test(lin), 'lin param stays f64')
  ok(!/\$__to_num/.test(lin), 'lin param is numeric (fed Float64Array-param elements) — no __to_num coercion')
})

// Soundness: the typed-array-element propagation must fire ONLY for a provably-TYPED receiver.
// A string literal arg to the same numeric helper must still ToNumber-coerce, not read raw bits.
test('param VAL.NUMBER: string arg to a numeric helper still coerces (bounded narrowing)', () => {
  is(jz(`let lin = (c) => c / 2 + 1; export let main = () => lin("8") + lin(10)`, { optimize: 'speed' }).exports.main(), 11)
})

// Soundness: a BigInt64Array element is VAL.BIGINT, not VAL.NUMBER — the ctor decides, so the
// helper's param must NOT be narrowed to Number (its i64 bigint carrier must survive).
test('param VAL.NUMBER: BigInt64Array element stays BigInt (ctor-gated, not narrowed to Number)', () => {
  is(jz(`let h = (x) => x + 1n; export let main = () => { let a = new BigInt64Array(3); a[0] = 5n; return Number(h(a[0])) }`, { optimize: 'speed' }).exports.main(), 6)
})

// === flow-fact overlay soundness (emitDecl/setFlowVal + collectNestedAssigns) ===
// The overlay (reps.js lookup tier #2) records decl/assignment value kinds as emit
// passes them. A fact is only sound while its recording site DOMINATES every read:
// a name reassigned at a NESTED position (if/loop/closure body, for-step) must carry
// no fact — `let x = [7,8]; if (c) x = 5; x.length` used to read the number 5
// through the ARRAY fast path (OOB trap): a latent miscompile that predated the
// for-init extension which exposed it.
test('flow-fact: nested conditional reassignment invalidates the decl fact', () => {
  const f = jz('export let f = (n) => { let x = [7,8]; if (n > 0) x = 5; return x.length === undefined ? -1 : x.length }').exports.f
  is(f(1), -1, 'reassigned arm: number has no .length')
  is(f(-1), 2, 'untouched arm keeps the array')
})
test('flow-fact: for-init decl reassigned in the step carries no stale fact', () => {
  const f = jz('export let f = () => { let s = 0; for (let x = [1,2,3]; x.length; x = 0) { s += x.length; if (s > 3) break } return s }').exports.f
  is(f(), 3, 'condition re-evaluates against the reassigned number, not the stale array')
})
test('flow-fact: for-of desugar keeps the array fast path (the win the guard must not kill)', () => {
  const { f, g } = jz(`
    export let f = () => { let s = 0; for (const v of [10, 20, 30]) s += v; return s }
    export let g = (n) => { let x = [7,8]; if (n > 0) x = 5; let s = 0; for (let i = 0; i < 2; i++) s += x === 5 ? 1 : x[i]; return s }
  `).exports
  is(f(), 60)
  is(g(1), 2)
  is(g(-1), 15)
})
