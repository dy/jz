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
import { belowOpt, onWasi } from './_matrix.js'
import jz from '../index.js'
import { run } from './util.js'

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
  // STRING-typed receiver routes .length through __str_byteLen, never __length.
  const wat = jz.compile(`
    export const hd = (s) => { const c = s.charCodeAt(0); return c + s.length }
  `, { wat: true })
  is(count(wat, /\$__length\b/g), 0)
  ok(/\$__str_byteLen\b/.test(wat) || /\$__str_len\b/.test(wat),
    'expected STRING-specific length op')
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
  ok(/\$__str_byteLen\b/.test(wat) || /\$__str_len\b/.test(wat),
    'expected STRING-specific length op')
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
  is(count(wat, /\$__length\b/g), 0, 'flow-narrowing should drop __length')
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
  is(ex.f({ foo: 7 }), 7, 'object arg reads its property')
  is(ex.f(42), undefined, 'number arg has no .foo → undefined (polymorphism is load-bearing)')
  is(ex.f('hi'), undefined, 'string arg has no .foo → undefined')
  const wat = jz.compile(`export function f(o) { return o.foo }`, { wat: true })
  // Polymorphic read uses an `_any_` dispatch variant (tag-checks at runtime).
  // An OBJECT-narrowed param would instead emit `__dyn_get_expr_t`, which assumes
  // OBJECT memory layout — its absence is the proof narrowing did NOT fire.
  ok(/\$__dyn_get_any/.test(wat), 'read-only param keeps a polymorphic _any_ dispatch')
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
  is(count(wat, /\$__typed_idx\b/g), 0, 'global typed-array arg → no runtime typed-idx dispatch')
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
  // Float64Array + plain array → typedCtor sticky-null → no SIMD, runtime
  // dispatch on every element access.
  const wat = jz.compile(`
    const sumArr = (a) => {
      let s = 0
      for (let i = 0; i < a.length; i++) s = s + a[i]
      return s
    }
    export const m1 = () => sumArr(new Float64Array([1, 2, 3, 4])) | 0
    export const m2 = () => sumArr([1, 2, 3]) | 0
  `, { wat: true })
  ok(!/v128\.load\b/.test(wat), 'disagreement should block SIMD')
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
  const wat = jz.compile(`
    export const probe = (x, k) => {
      if (x instanceof Map) return x.has(k) ? 1 : 0
      return -1
    }
  `, { wat: true, jzify: true })
  const probe = wat.match(/\(func \$probe[\s\S]+?\n  \)/)?.[0] || ''
  ok(/\$__map_has\b/.test(probe), 'expected __map_has dispatch under instanceof Map refinement')
  ok(!/\$__set_has\b/.test(probe), 'should not fall back to default __set_has')
})

test('extractRefinements: instanceof Set → __set_has dispatch (no Map path)', () => {
  const wat = jz.compile(`
    export const probe = (x, v) => {
      if (x instanceof Set) return x.has(v) ? 1 : 0
      return -1
    }
  `, { wat: true, jzify: true })
  const probe = wat.match(/\(func \$probe[\s\S]+?\n  \)/)?.[0] || ''
  ok(/\$__set_has\b/.test(probe), 'expected __set_has under instanceof Set refinement')
  ok(!/\$__map_has\b/.test(probe), 'should not also pull __map_has path')
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
