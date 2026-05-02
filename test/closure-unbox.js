/**
 * Tests for CLOSURE local unboxing (analyzePtrUnboxable VAL.CLOSURE branch).
 *
 * `let g = (x) => …` with non-reassigned `g` is stored as i32 envPtr instead of
 * the full f64 NaN-box. ptrAux=funcIdx is preserved on the rep so reboxing for
 * escape paths (array store, pass to non-narrowed param, indirect call through
 * inner helper) reconstructs the correct call_indirect target.
 *
 * Coverage axes:
 *   - direct dispatch on unboxed local (no rebox)
 *   - indirect call via inner helper that takes f64 (rebox + extract aux)
 *   - escape via array store + load
 *   - escape via being passed as arg to a non-narrowed function
 *   - reassignment / nullish-comparison disqualifies
 *   - capture in inner closure works (parent-side)
 *   - codegen: i32 local declared (proves unboxing fired)
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { run } from './util.js'

const wat = (src) => jz.compile(src, { wat: true })
const fnBody = (w, name) => {
  // Match `(func $name` or `(func $name$exp` (boundary wrapper for narrowed exports).
  const re = new RegExp(`\\(func \\$${name}(?:\\$exp)?(?:\\s|$)`)
  const m = w.match(re)
  return m ? w.slice(m.index, m.index + 4000) : null
}

test('closure-unbox: direct call with capture works', () => {
  const { f } = run(`export let f = (n) => {
    let g = (x) => x + n
    return g(1) + g(2)
  }`)
  is(f(10), 23)
})

test('closure-unbox: passed to inner taking fn (call_indirect rebox path)', () => {
  // `h(g)` reboxes `g` to f64 for the inner closure's f64 param. Inner does
  // call_indirect on it — funcIdx must be preserved through the rebox.
  const { f } = run(`export let f = (n) => {
    let g = (x) => x * 2 + n
    let h = (fn) => fn(7)
    return h(g)
  }`)
  is(f(10), 24)
})

test('closure-unbox: escape via array store + indirect call', () => {
  const { f } = run(`export let f = (n) => {
    let g = (x) => x + n
    let arr = [g]
    return arr[0](5)
  }`)
  is(f(10), 15)
})

test('closure-unbox: escape via apply (passed across function boundary)', () => {
  const { f } = run(`
    export let apply = (fn, x) => fn(x)
    export let f = (n) => {
      let g = (x) => x + n
      return apply(g, 5)
    }
  `)
  is(f(10), 15)
})

test('closure-unbox: multiple unboxed closures with distinct funcIdx', () => {
  // Two CLOSURE locals in the same function, each with different aux; rebox
  // for both must use the right funcIdx. Calling via inner helper to force
  // the call_indirect path (not directClosures fast path).
  const { f } = run(`export let f = (n) => {
    let a = (x) => x + n
    let b = (x) => x * n
    let h = (fn, x) => fn(x)
    return h(a, 3) + h(b, 3)
  }`)
  is(f(10), 13 + 30)
})

test('closure-unbox: reassignment disqualifies', () => {
  // `g = …` reassignment must keep `g` as f64 (NaN-box) so re-bind works.
  // analyzePtrUnboxable disqualifies any name with > 0 bare `=` assignments.
  const { f } = run(`export let f = (n) => {
    let g = (x) => x + n
    g = (x) => x - n
    return g(5)
  }`)
  is(f(10), -5)
})

test('closure-unbox: nullish comparison disqualifies', () => {
  // `g == null` would lose the nullish NaN representation if `g` were i32.
  // analyzePtrUnboxable bails for any candidate compared to null/undefined.
  const { f } = run(`export let f = (n) => {
    let g = (x) => x + n
    if (g == null) return 0
    return g(7)
  }`)
  is(f(10), 17)
})

test('closure-unbox: captured by inner closure still works', () => {
  // `g` is captured by an inner arrow `h`. The outer-side rep on `g` is i32;
  // capture serialization in closure.make uses asF64(emit('g')) which must
  // rebox correctly.
  const { f } = run(`export let f = (n) => {
    let g = (x) => x + n
    let h = (y) => g(y) * 2
    return h(3)
  }`)
  is(f(10), 26)
})

test('closure-unbox: codegen — local declared as i32', () => {
  // Pin the unboxing actually fires: a function with a fresh-arrow-init
  // local must declare it as `(local $g i32)` rather than `(local $g f64)`.
  const w = wat(`
    export let f = (n) => {
      let g = (x) => x + n
      return g(1)
    }
  `)
  const body = fnBody(w, 'f')
  ok(body, '$f present')
  ok(/\(local \$g i32\)/.test(body), '$g declared as i32 (closure unboxed)')
  ok(!/\(local \$g f64\)/.test(body), '$g not f64')
})

// Regression: `o.fn(g)` — closure stored in an object property and dispatched
// through `__dyn_get`/`__ext_call`. Previously failed with table-index trap
// (function-scope) or `Unknown local $g` (module-scope). Fixed by the
// polymorphic ?: + schema-aware __dyn_get OBJECT-arm: receiver carries
// per-instance schemaId, runtime resolves the slot, and the dispatched
// closure has its funcIdx preserved through the f64 rebox.
test('closure-unbox: o.fn(g) — object-property closure dispatch', () => {
  const { f } = run(`export let f = () => {
    let g = (n) => n + 100
    let o = { fn: g }
    return o.fn(5)
  }`)
  is(f(), 105)
})

// Module-level variant: previously "Unknown local $g" at compile time.
// Root cause: `let g = (n) => …` at module scope is extracted via defFunc
// into ctx.func.list (top-level function, not a closure literal), so the
// `fn` module isn't auto-loaded by the depth>0 arrow path. Without fn,
// ctx.closure.table is null, so emit.js's func-as-value branch falls
// through to the unconditional `(local.get $name)` fallback — bogus WAT.
// Fix: post-prep scan in prepare.js detects top-level func names used in
// value positions across ast/func.bodies/moduleInits and includeModule('fn').
test('closure-unbox: o.fn(g) — module-level binding', () => {
  const { f } = run(`
    let g = (n) => n + 100
    let o = { fn: g }
    export let f = () => o.fn(5)
  `)
  is(f(), 105)
})

// Pin the post-watrOptimize fusedRewrite pass (commit 712d768) — without it
// watr's inliner re-introduces a rebox/unbox roundtrip across the closure-
// body inline boundary. The roundtrip is invisible to behavior tests but
// costs ~32 bytes per simple closure call site. Threshold tracks the ≤252b
// figure recorded in .work/todo.md (Tier A "Devirtualize non-escaping
// closures") with a small headroom; loosen if a deliberate codegen change
// pushes it over.
test('closure-unbox: trivial closure-call program stays compact (post-watr fusedRewrite)', () => {
  const src = `
    let g = (x) => x + 1
    export let f = () => g(41)
  `
  const bytes = jz.compile(src).length
  ok(bytes <= 260, `closure-call probe ${bytes}b — rebox/unbox roundtrip likely re-introduced (>260b)`)
})

test('closure-unbox: no reinterpret/wrap_i64 roundtrip in inlined closure call', () => {
  // Structural pin: after watrOptimize inlines the closure body, the
  // call-site `asF64(local.get $g)` (rebox to f64) immediately meets the
  // body's `i32.wrap_i64 (i64.reinterpret_f64 …)` (unbox back to envPtr).
  // The post-watr fusedRewrite pass folds this — assert the WAT for $f
  // doesn't contain the surviving roundtrip pattern.
  const w = wat(`
    let g = (x) => x + 1
    export let f = () => g(41)
  `)
  const body = fnBody(w, 'f')
  ok(body, '$f present')
  // The roundtrip leaves a `wrap_i64 (i64.reinterpret_f64 …)` somewhere in
  // $f when un-folded. After the fold, $f's body is just the (possibly
  // inlined) addition + return.
  ok(!/i32\.wrap_i64\s*\(\s*i64\.reinterpret_f64/.test(body),
    '$f contains wrap_i64(reinterpret_f64 …) — rebox roundtrip survived')
})
