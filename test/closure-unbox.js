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
  const re = new RegExp(`\\(func \\$${name}(?:\\s|$)`)
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
