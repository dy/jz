/**
 * TYPED narrowing — internal sig narrowing of helpers that always return a
 * typed-array of constant elemType. compile.js narrowSignatures sets
 *   sig.results = ['i32'], sig.ptrKind = VAL.TYPED, sig.ptrAux = elemAux
 * so callers see an i32 offset and skip the f64 NaN-rebox; receivers also
 * get rep.ptrAux = elemAux populated, enabling static elem-aware index loads
 * (eliding the runtime __is_str_key + __pt0 kind dispatch).
 *
 * Mirrors the OBJECT-narrowing slot-types tests but on the TYPED axis:
 *   - aux carries elem code (Float64=7, Int32=4, etc.) not schemaId.
 *   - The reverse-mapping ctorFromElemAux round-trips aux through
 *     ctx.types.typedElem so analyzePtrUnboxable picks up the same aux on
 *     unboxed locals.
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

test('typed-narrow: Float64Array helper — direct index after narrowed call', () => {
  const { f } = run(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => { let a = mk(); return a[i] }
  `)
  is(f(0), 1.5)
  is(f(1), 2.5)
  is(f(2), 3.5)
})

test('typed-narrow: Int32Array helper — distinct elemType preserved', () => {
  // Int32Array (elemAux=4) must not collide with Float64Array (elemAux=7).
  // Each helper's call result gets its own aux; receiver's index load uses
  // the matching elem stride (4 bytes vs 8) and load type (i32 vs f64).
  const { f } = run(`
    let mk = () => new Int32Array([10, 20, 30])
    export let f = (i) => { let a = mk(); return a[i] }
  `)
  is(f(0), 10)
  is(f(1), 20)
  is(f(2), 30)
})

test('typed-narrow: chain — outer helper forwards inner narrowed result', () => {
  // Fixpoint: outer narrows only after inner; outer's typedAuxOfReturn
  // reads inner's f.sig.ptrAux to confirm same elem aux across all returns.
  const { f } = run(`
    let inner = () => new Float64Array([7.5, 8.5])
    let outer = () => inner()
    export let f = (i) => { let a = outer(); return a[i] }
  `)
  is(f(0), 7.5)
  is(f(1), 8.5)
})

test('typed-narrow: ?: with two same-elemType arms narrows', () => {
  const { f } = run(`
    let mk = (w) => w == 0 ? new Float64Array([1.5, 2.5]) : new Float64Array([3.5, 4.5])
    export let f = (w, i) => { let a = mk(w); return a[i] }
  `)
  is(f(0, 0), 1.5)
  is(f(0, 1), 2.5)
  is(f(1, 0), 3.5)
  is(f(1, 1), 4.5)
})

test('typed-narrow: ?: with mixed elemType does NOT narrow (still correct)', () => {
  // Polymorphic typed-array result — typedAuxOfReturn sees aux mismatch and
  // bails. Result stays f64 NaN-boxed; runtime kind dispatch resolves both
  // arms via __pt0. Behavior must remain correct on both branches.
  const { f } = run(`
    let mk = (w) => w == 0 ? new Float64Array([1.5, 2.5]) : new Int32Array([10, 20])
    export let f = (w, i) => { let a = mk(w); return a[i] }
  `)
  is(f(0, 0), 1.5)
  is(f(0, 1), 2.5)
  is(f(1, 0), 10)
  is(f(1, 1), 20)
})

test('typed-narrow: codegen — narrowed helper return type is i32', () => {
  // Pin the narrowing actually fires: `(func $mk … (result i32))` not f64.
  const w = wat(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => { let a = mk(); return a[i] }
  `)
  const body = fnBody(w, 'mk')
  ok(body, '$mk present in WAT')
  ok(/\(result i32\)/.test(body), '$mk returns i32 (narrowed)')
})

test('typed-narrow: codegen — receiver uses static elem load (no __is_str_key dispatch)', () => {
  // The downstream win: receiver's `a[i]` collapses to a direct `f64.load`
  // (Float64Array: 8-byte stride). No __is_str_key call, no __pt0 kind
  // extract, no __typed_idx fallback in the reachable path.
  const w = wat(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => { let a = mk(); return a[i] }
  `)
  const body = fnBody(w, 'f')
  ok(body, '$f present in WAT')
  ok(!/__is_str_key/.test(body), '$f has no __is_str_key dispatch')
})

test('typed-narrow: owned typed-array byteOffset is constant zero', () => {
  const w = wat(`
    export let f = () => {
      let a = new Float64Array(8)
      return a.byteOffset
    }
  `)
  ok(!/__byte_offset/.test(w), 'owned typed-array byteOffset should not pull runtime helper')
  is(run(`export let f = () => { let a = new Float64Array(8); return a.byteOffset }`).f(), 0)
})

test('typed-narrow: bytes — narrowed helper + static load is compact', () => {
  // The motivating program: tiny helper + index. After narrowing + post-watr
  // fusedRewrite, the rebox/unbox roundtrip across the call boundary is gone.
  // Threshold tracks the recorded baseline with headroom — loosen if a
  // deliberate codegen change pushes it over.
  const src = `
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => { let a = mk(); return a[i] }
  `
  const bytes = jz.compile(src).length
  ok(bytes <= 850, `typed helper probe ${bytes}b — narrowing or fusedRewrite likely regressed (>850b)`)
})

test('typed-narrow: escape via store does not break narrowed helper', () => {
  // Receiver is consumed in a way that requires reboxing to f64 (passed to
  // an array index store). The asF64 path on the narrowed-call result must
  // re-pack with the correct elemType aux.
  const { f } = run(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = () => {
      let a = mk()
      let arr = [a]
      return arr[0][1]
    }
  `)
  is(f(), 2.5)
})

// === Receiver unbox after .map on TYPED ===
// Extension B: analyzePtrUnboxable.isFreshInit accepts `arr.map(fn)` shape when
// `arr` is in ctx.types.typedElem (locally TYPED with a known elem ctor). Only
// `.typed:map` qualifies — `.filter`/`.slice` fall back to ARRAY emit, so the
// typedElem.has(src) gate keeps us safe from the polymorphic-receiver path.

test('typed-narrow: receiver unbox after .map on TYPED', () => {
  const { f } = run(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => {
      let a = mk()
      let b = a.map(x => x + 10)
      return b[i]
    }
  `)
  is(f(0), 11.5)
  is(f(1), 12.5)
  is(f(2), 13.5)
})

test('typed-narrow: codegen — .map receiver is i32 + static load', () => {
  // Both $a (narrowed-call result) and $b (.map receiver) unbox to i32.
  // Index access on $b collapses to direct f64.load — no __is_str_key.
  const w = wat(`
    let mk = () => new Float64Array([1.5, 2.5, 3.5])
    export let f = (i) => {
      let a = mk()
      let b = a.map(x => x + 10)
      return b[i]
    }
  `)
  const body = fnBody(w, 'f')
  ok(body, '$f present')
  ok(/\(local \$b i32\)/.test(body), '$b unboxed to i32 (.map receiver)')
  ok(!/__is_str_key/.test(body), '$f has no __is_str_key after .map receiver unbox')
})

test('typed-narrow: chained .map preserves elem type', () => {
  // a.map(...).map(...) — first .map's result is locally TYPED with the same
  // elem ctor (propagateTyped strips .view). Second .map's receiver is also
  // accepted by isFreshInit, so the chain unboxes end-to-end.
  const { f } = run(`
    let mk = () => new Float64Array([1.0, 2.0, 3.0])
    export let f = (i) => {
      let a = mk()
      let b = a.map(x => x * 2)
      let c = b.map(x => x + 1)
      return c[i]
    }
  `)
  is(f(0), 3)
  is(f(1), 5)
  is(f(2), 7)
})

test('typed-narrow: .map on Int32Array preserves distinct elem aux', () => {
  // Int32Array elemAux=4, Float64Array elemAux=7. The receiver's static-load
  // uses 4-byte stride + i32.load (signed convert), not 8-byte f64.load. If
  // the wrong aux leaked through propagateTyped → wrong stride → wrong values.
  const { f } = run(`
    let mk = () => new Int32Array([10, 20, 30])
    export let f = (i) => {
      let a = mk()
      let b = a.map(x => x + 100)
      return b[i]
    }
  `)
  is(f(0), 110)
  is(f(1), 120)
  is(f(2), 130)
})
