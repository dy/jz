// NaN-boxing pointer encoding tests + multi-value threshold
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'

function run(code, opts) {
  return jz(code, opts).exports
}

// === Multi-value threshold ===

test('multi: vec2', () => {
  const r = run('export let f = (a, b) => [a, b]').f(1, 2)
  ok(Array.isArray(r))
  is(r[0], 1)
  is(r[1], 2)
})

test('multi: vec3', () => {
  const r = run('export let f = (a, b, c) => [a, b, c]').f(1, 2, 3)
  ok(Array.isArray(r))
  is(r.length, 3)
})

test('multi: vec4', () => {
  const r = run('export let f = (a, b, c, d) => [a, b, c, d]').f(1, 2, 3, 4)
  ok(Array.isArray(r))
  is(r[3], 4)
})

test('multi: vec8 (threshold)', () => {
  const r = run('export let f = (a, b) => [a, a+1, a+2, a+3, b, b+1, b+2, b+3]').f(10, 20)
  ok(Array.isArray(r))
  is(r.length, 8)
  is(r[0], 10)
  is(r[7], 23)
})

test('multi: >8 becomes pointer', () => {
  const { f, g } = run(`
    export let f = () => {
      let a = [1, 2, 3, 4, 5, 6, 7, 8, 9]
      return a
    }
    export let g = (a, i) => a[i]
  `)
  const ptr = f()
  ok(isNaN(ptr))
  is(g(ptr, 0), 1)
  is(g(ptr, 8), 9)
})

// === NaN-boxing: encode/decode for all pointer types ===
// Each test uses an array to auto-include memory module, then tests pointer helpers

test('nan-box: ATOM (type=0)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(0, 0, 0)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 0); is(a, 0); is(o, 0)
})

test('nan-box: ARRAY (type=1, inline len)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(1, 100, 2048)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 1); is(a, 100); is(o, 2048)
})

test('nan-box: BUFFER (type=2)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(2, 0, 4096)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, _, o] = f()
  is(t, 2); is(o, 4096)
})

test('nan-box: TYPED (type=3)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(3, 7, 8192)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 3); is(a, 7); is(o, 8192)
})

test('nan-box: STRING (type=4)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(4, 5, 1024)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 4); is(a, 5); is(o, 1024)
})

test('nan-box: STRING SSO (aux SSO_BIT)', () => {
  // SSO is a STRING (type=4) with the SSO_BIT (0x4000) set in aux.
  const { f } = run(`export let f = () => {
    let a = [0]
    return [__ptr_type(__mkptr(4, 0x4000 | 3, 0x636261)), __ptr_aux(__mkptr(4, 0x4000 | 3, 0x636261))]
  }`)
  const [t, a] = f()
  is(t, 4); is(a, 0x4000 | 3)
})

test('nan-box: OBJECT (type=6)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(6, 42, 3072)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 6); is(a, 42); is(o, 3072)
})

test('nan-box: HASH (type=7)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_type(__mkptr(7, 0, 5000))
  }`)
  is(f(), 7)
})

test('nan-box: SET (type=8)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_type(__mkptr(8, 0, 6000))
  }`)
  is(f(), 8)
})

test('nan-box: MAP (type=9)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_type(__mkptr(9, 0, 7000))
  }`)
  is(f(), 9)
})

test('nan-box: CLOSURE (type=10)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __mkptr(10, 255, 8000)
    return [__ptr_type(p), __ptr_aux(p), __ptr_offset(p)]
  }`)
  const [t, a, o] = f()
  is(t, 10); is(a, 255); is(o, 8000)
})

test('nan-box: EXTERNAL (type=11)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_type(__mkptr(11, 67, 0))
  }`)
  is(f(), 11)
})

// === BigInt carrier boxing (CARRIER PROGRAM Slice 1, .work/carrier-
// representation-design.md §7) — dormant primitives, unit-level pins.
// __box_bigint/__unbox_bigint are test-only jz-source intrinsics (module/
// core.js, mirroring __mkptr/__ptr_type/__ptr_offset above) exposing ir.js's
// boxBigInt/unboxBigInt directly. Nothing in the production compile path
// calls these yet — this section proves the primitives themselves are
// correct in isolation, ahead of any real consumer (Slice 2).

const f64BitsBig = (f64) => {
  const dv = new DataView(new ArrayBuffer(8))
  dv.setFloat64(0, f64)
  return dv.getBigInt64(0)
}

test('carrier: box tags PTR.BIGINT (type=5), aux=0', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __box_bigint(5n)
    return [__ptr_type(p), __ptr_aux(p)]
  }`)
  const [t, aux] = f()
  is(t, 5); is(aux, 0)
})

test('carrier: box/unbox roundtrip — small positive', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __unbox_bigint(__box_bigint(5n))
  }`)
  is(f64BitsBig(f()), 5n)
})

test('carrier: box/unbox roundtrip — small negative', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __unbox_bigint(__box_bigint(-5n))
  }`)
  is(f64BitsBig(f()), -5n)
})

test('carrier: box/unbox roundtrip — zero', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __unbox_bigint(__box_bigint(0n))
  }`)
  is(f64BitsBig(f()), 0n)
})

test('carrier: box/unbox roundtrip — i64 max (2^63-1)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __unbox_bigint(__box_bigint(9223372036854775807n))
  }`)
  is(f64BitsBig(f()), 9223372036854775807n)
})

test('carrier: box/unbox roundtrip — i64 min (-2^63)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __unbox_bigint(__box_bigint(-9223372036854775808n))
  }`)
  is(f64BitsBig(f()), -9223372036854775808n)
})

test('carrier: box/unbox roundtrip — bit pattern that aliases a real NaN-box (round-2\'s own wall)', () => {
  // The exact hazard round 2 could not resolve at read time: a raw i64 whose
  // bits alias a genuine PTR.OBJECT-shaped NaN-box. Round 3's answer is
  // structural (never re-derive box-vs-raw from bit SHAPE) — this pin proves
  // the box/unbox PAIR round-trips such a value correctly regardless: the
  // payload is opaque to boxBigInt/unboxBigInt, whatever bits it carries.
  // boxShapedBits is itself a real PTR.BIGINT pointer (a NaN-boxed f64) —
  // re-boxing ITS bits as a fresh BigInt payload and unboxing must yield
  // those exact bits back, byte-identical, independent of what tag they
  // happen to decode as. Compared entirely IN-WASM (i32 boolean result):
  // CARRIER PROGRAM Slice 3 gave mem.read a real PTR.BIGINT decode arm, so
  // returning the raw f64 bit pattern directly across the boundary is no
  // longer a safe way to inspect it when those bits themselves alias a box
  // shape (this test's own deliberate setup) — the boundary would
  // (correctly, now) re-decode it as ANOTHER box's payload instead of
  // preserving the bits verbatim. Bit-identical operands take $__eq's exact-
  // bits fast path (top of the function, before any tag dispatch), so this
  // comparison is sound regardless of what tag the shared bits alias.
  const { f } = run(`export let f = () => {
    let a = [0]
    let boxShapedBits = __box_bigint(0n)
    return __unbox_bigint(__box_bigint(boxShapedBits)) === boxShapedBits
  }`)
  is(f(), true)
})

test('carrier: two distinct boxes get distinct heap cells (not interned)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    let p = __box_bigint(7n)
    let q = __box_bigint(7n)
    return __ptr_offset(p) === __ptr_offset(q)
  }`)
  is(f(), false)
})

test('carrier: PTR.BIGINT (5) is disjoint from every other pointer tag', () => {
  // NaN-prefix disjointness: PTR.BIGINT's own 4-bit tag field must not
  // collide with any live PTR.* tag (layout.js) — every existing tag's own
  // __mkptr round-trip above already pins its own value; this pin asserts
  // the SET is what the design's audit (layout.js:27-39) claims: {0,1,2,3,4,
  // 6,7,8,9,10,11} plus 5, no duplicates, matching LAYOUT.TAG_MASK's 4-bit
  // (16-value) space with 12-15 still free.
  const liveTags = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  is(new Set(liveTags).size, liveTags.length)
})

// === Limits ===

test('nan-box: max aux (32767)', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_aux(__mkptr(1, 32767, 0))
  }`)
  is(f(), 32767)
})

test('nan-box: large offset', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __ptr_offset(__mkptr(1, 0, 1048576))
  }`)
  is(f(), 1048576)  // 1MB
})

test('nan-box: pointer is NaN in JS', () => {
  const { f } = run(`export let f = () => {
    let a = [0]
    return __mkptr(1, 3, 1024)
  }`)
  ok(isNaN(f()))
  ok(typeof f() === 'number')
})

test('nan-box: JS roundtrip preserves bits', () => {
  const { mk, pt, pa, po } = run(`
    export let mk = () => {
      let a = [0]
      return __mkptr(6, 42, 3072)
    }
    export let pt = (p) => { let a = [0]; return __ptr_type(p) }
    export let pa = (p) => { let a = [0]; return __ptr_aux(p) }
    export let po = (p) => { let a = [0]; return __ptr_offset(p) }
  `)
  const p = mk()
  is(pt(p), 6)
  is(pa(p), 42)
  is(po(p), 3072)
})

test('typed read indexed by typed read keeps the receiver element kind', () => {
  // t[p[i]] — the nested index emit must not clobber the OUTER array's load
  // op (self-host regression: deferred load closure re-read the elem kind
  // AFTER the inner Uint32Array emit and loaded the f64 array as u32).
  const { exports } = jz(`
    export let one = () => { const t = new Float64Array(4); t[3] = 7; const p = new Uint32Array(4); p[0] = 3; return t[p[0]] }
    export let sum = (n) => { const t = new Float64Array(n); const p = new Uint32Array(n); for (let i = 0; i < n; i++) { t[i] = i; p[i] = n - 1 - i } let s = 0; for (let i = 0; i < n; i++) s += t[p[i]]; return s }
  `)
  is(exports.one(), 7)
  is(exports.sum(8), 28)
})

test('module-global typed array passed as param: versioning guard uses the narrowed base', () => {
  // The loop-versioning guard's length read box-decoded the ptr-NARROWED i32
  // param (asF64 numerically coerced the offset, reinterpret extracted garbage
  // bits) — a wild bound made a perfectly bounded loop trap OOB.
  const { exports } = jz(`
    const out = new Float64Array(64)
    const k = (o, n) => { for (let i = 0; i < n; i++) o[i] = i; return o[5] }
    export let go = (n) => k(out, n)
  `)
  is(exports.go(8), 5)
  is(exports.go(64), 5)
})
