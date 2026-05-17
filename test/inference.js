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

// ───────────────────────────────────────────────────── call-site lattice (paramReps)

test('paramReps val: consistent ARRAY callers fold to direct header read', () => {
  // Both callers pass array literals → val=ARRAY consensus → callee's
  // `.length` becomes a direct memory load of the header word (no helper).
  const wat = jz.compile(`
    const lenOf = (xs) => xs.length
    export const a = () => lenOf([1, 2, 3])
    export const b = () => lenOf([4, 5, 6, 7])
  `, { wat: true })
  is(count(wat, /\$__length\b/g), 0)
  is(count(wat, /\$__len\b/g), 0)
  // Body should contain a direct header load (i32.load over __ptr_offset - 8).
  ok(/\(i32\.load[\s\S]*?\$__ptr_offset[\s\S]*?\(i32\.const 8\)/.test(wat),
    'expected direct header i32.load')
})

test('paramReps val: caller disagreement forces __length poly', () => {
  // Caller a passes array, caller b passes string → val sticky-null on the
  // lattice → callee falls back to fully-polymorphic __length.
  const wat = jz.compile(`
    const lenOf = (xs) => xs.length
    export const a = () => lenOf([1, 2, 3])
    export const b = () => lenOf('foo')
  `, { wat: true })
  ok(count(wat, /\$__length\b/g) >= 1, 'sticky-null val should keep __length')
})

test('intConst: unanimous int-literal arg folds local.get to i32 const', () => {
  // Every caller passes k=7 → narrow.js D-phase sets paramReps[scale][1]
  // .intConst=7. compile.js seeds localReps.intConst; emitLocalGet sees it
  // and emits the literal instead of a local read.
  const wat = jz.compile(`
    const scale = (x, k) => x * k
    export const a = (x) => scale(x, 7)
    export const b = (x) => scale(x, 7)
  `, { wat: true })
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
  `, { wat: true })
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
