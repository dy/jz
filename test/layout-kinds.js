/**
 * Heap-kind registry SLICE 1 shadow-check (.work/heap-kind-registry-design.md).
 *
 * Proves layout-kinds.js's KIND_REGISTRY columns against LIVE behavior: one
 * probe per kind × consumer (typeof, ===/==, Set/Map keying, interop
 * roundtrip) plus one live-reproducing probe per FINDINGS entry. Every
 * assertion here encodes what the runtime ACTUALLY does today — a divergence
 * from some OTHER consumer's stated intent is recorded as a FINDING in
 * layout-kinds.js, not "fixed" by picking a side in this file (Slice 1 is
 * table + proof, zero codegen change — see the design doc's Slices list).
 *
 * Runs identically under plain and JZ_DEBUG_INVARIANTS=1 (no codegen this
 * slice touches is gated on that flag) — the one DBG_INVARIANTS-conditional
 * test below adds a stricter completeness check, matching test/invariants.js's
 * existing gated-test convention.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { DBG_INVARIANTS } from '../src/ctx.js'
import { PTR } from '../layout.js'
import { KIND_REGISTRY, FINDINGS } from '../layout-kinds.js'

const run = (code, opts) => jz(code, opts).exports

// ============================================================================
// Registry self-consistency (catches this FILE going stale, not the runtime)
// ============================================================================

test('registry: every live PTR.* tag has at least one KIND_REGISTRY row', () => {
  const tagsInRegistry = new Set(Object.values(KIND_REGISTRY).map(k => k.tag).filter(t => t != null))
  for (const [name, tag] of Object.entries(PTR)) ok(tagsInRegistry.has(tag), `PTR.${name} (${tag}) missing from KIND_REGISTRY`)
})

test('registry: every FINDINGS id is cross-referenced from every kind it names', () => {
  for (const f of FINDINGS) {
    for (const kindName of f.kinds) {
      const row = KIND_REGISTRY[kindName]
      ok(row, `FINDINGS[${f.id}] names unknown kind ${kindName}`)
      ok(row.findings?.includes(f.id), `KIND_REGISTRY.${kindName}.findings missing '${f.id}'`)
    }
  }
})

if (DBG_INVARIANTS) {
  test('registry: every KIND_REGISTRY row declares all seven documented columns', () => {
    const COLS = ['tag', 'allocShape', 'childPointers', 'forwarding', 'identity', 'interopDecode', 'typeofArm']
    for (const [name, row] of Object.entries(KIND_REGISTRY))
      for (const c of COLS) ok(c in row, `KIND_REGISTRY.${name} missing column '${c}'`)
  })
}

// ============================================================================
// typeof — one probe per kind, dynamic dispatch ($__typeof, module/core.js).
// Real values wherever jz syntax can produce the kind; __mkptr(tag,aux,0)
// synthetic pointers (test/pointers.js's own EXTERNAL precedent) for kinds
// with no jz-source literal (HASH) or where deref safety matters (typeof
// never dereferences a pointer's offset — safe with any offset, including 0).
// ============================================================================

test('typeof: NUMBER', () => is(run('export let f = () => typeof 1').f(), 'number'))
test('typeof: STRING (heap, non-literal-folded)', () => is(run('export let f = () => typeof ("a" + "b" + "c" + "d" + "e" + "f" + "g")').f(), 'string'))
test('typeof: ARRAY', () => is(run('export let f = () => typeof [1,2,3]').f(), 'object'))
test('typeof: OBJECT (schema)', () => is(run('export let f = () => typeof ({a:1,b:2})').f(), 'object'))
test('typeof: SET', () => is(run('export let f = () => typeof new Set()').f(), 'object'))
test('typeof: MAP', () => is(run('export let f = () => typeof new Map()').f(), 'object'))
test('typeof: TYPED', () => is(run('export let f = () => typeof new Float64Array(4)').f(), 'object'))
test('typeof: BUFFER', () => is(run('export let f = () => typeof new ArrayBuffer(8)').f(), 'object'))
test('typeof: CLOSURE', () => is(run('export let f = () => typeof (() => 1)').f(), 'function'))
test('typeof: ATOM.NULL', () => is(run('export let f = () => typeof null').f(), 'object'))
test('typeof: ATOM.UNDEFINED', () => is(run('export let f = () => typeof undefined').f(), 'undefined'))
test('typeof: ATOM.BOOLEAN true', () => is(run('export let f = () => typeof true').f(), 'boolean'))
test('typeof: ATOM.BOOLEAN false', () => is(run('export let f = () => typeof false').f(), 'boolean'))
test('typeof: ATOM.SYMBOL', () => is(run('export let f = () => typeof Symbol("x")').f(), 'symbol'))

test('typeof: HASH (synthetic __mkptr — no jz-source literal produces a bare HASH value)', () => {
  is(run(`export let f = () => { let a = [0]; return typeof __mkptr(${PTR.HASH}, 0, 0) }`).f(), 'object')
})
test('typeof: EXTERNAL (synthetic __mkptr, mirrors test/pointers.js\'s __ptr_type EXTERNAL pin)', () => {
  is(run(`export let f = () => { let a = [0]; return typeof __mkptr(${PTR.EXTERNAL}, 67, 0) }`).f(), 'object')
})
test('typeof: BIGINT literal (statically folded, bypasses $__typeof entirely)', () => {
  is(run('export let f = () => typeof 5n').f(), 'bigint')
})

// ============================================================================
// Identity — pointer-bits (REF_EQ_KINDS) for every heap kind except STRING
// (content). Two freshly-built, distinctly-allocated same-shape values must
// be !== for the pointer-bits kinds, and two independently-built but
// content-equal strings must be ===.
// ============================================================================

test('identity: STRING content — two independently-built equal strings are ===', () => {
  is(run(`export let f = () => {
    let a = "a" + "b" + "c" + "d" + "e" + "f" + "g"
    let b = "a" + "bc" + "d" + "ef" + "g"
    return a === b
  }`).f(), true)
})

test('identity: ARRAY pointer-bits — two same-content arrays are !==', () => {
  is(run('export let f = () => [1,2] === [1,2]').f(), false)
})
test('identity: OBJECT pointer-bits — two same-shape objects are !==', () => {
  is(run('export let f = () => ({a:1}) === ({a:1})').f(), false)
})
test('identity: SET pointer-bits — two empty sets are !==', () => {
  is(run('export let f = () => new Set() === new Set()').f(), false)
})
test('identity: MAP pointer-bits — two empty maps are !==', () => {
  is(run('export let f = () => new Map() === new Map()').f(), false)
})
test('identity: TYPED pointer-bits — two same-content typed arrays are !==', () => {
  is(run('export let f = () => { let a = new Int32Array([1,2]); let b = new Int32Array([1,2]); return a === b }').f(), false)
})
test('identity: BUFFER pointer-bits — two same-size buffers are !==', () => {
  is(run('export let f = () => new ArrayBuffer(4) === new ArrayBuffer(4)').f(), false)
})
test('identity: CLOSURE pointer-bits — two CAPTURING closures from the same factory are !== (real per-creation heap block)', () => {
  is(run('export let f = () => { let mk = (x) => (() => x); return mk(1) === mk(1) }').f(), false)
})
test('identity: CLOSURE zero-capture degenerate case — a captureless closure has no heap block, so re-evaluating the same literal is === (documented in layout-kinds.js CLOSURE.identity, not a cross-consumer finding)', () => {
  is(run('export let f = () => { let mk = () => (() => 1); return mk() === mk() }').f(), true)
})

// ============================================================================
// Set/Map keying — $__map_hash + $__same_value_zero (module/collection.js).
// STRING dedups by content; every other kind dedups by pointer-bits.
// ============================================================================

test('Set keying: STRING dedups by content across independently-built equal strings', () => {
  is(run(`export let f = () => {
    let s = new Set()
    s.add("a" + "b" + "c" + "d" + "e" + "f" + "g")
    s.add("a" + "bc" + "d" + "ef" + "g")
    return s.size
  }`).f(), 1)
})
test('Set keying: ARRAY does NOT dedup by content (pointer-bits)', () => {
  is(run(`export let f = () => { let s = new Set(); s.add([1,2]); s.add([1,2]); return s.size }`).f(), 2)
})
test('Map keying: a re-derived equal string still hits (content hash+eq)', () => {
  is(run(`export let f = () => {
    let m = new Map()
    m.set("a" + "b" + "c" + "d" + "e" + "f" + "g", 1)
    return m.get("a" + "bc" + "d" + "ef" + "g")
  }`).f(), 1)
})

// ============================================================================
// Interop decode — sanity pass for the kinds mem.read DOES handle (interop.js).
// ============================================================================

test('interop: ARRAY decodes to a real JS array', () => ok(Array.isArray(run('export let f = () => [1,2,3]').f())))
test('interop: OBJECT decodes to a real JS object', () => is(run('export let f = () => ({a:1,b:2})').f().b, 2))
test('interop: SET decodes to a real JS Set', () => ok(run('export let f = () => { let s = new Set(); s.add(1); return s }').f() instanceof Set))
test('interop: MAP decodes to a real JS Map', () => ok(run('export let f = () => { let m = new Map(); m.set(1,2); return m }').f() instanceof Map))
test('interop: STRING decodes to a real JS string', () => is(run('export let f = () => "a"+"b"+"c"+"d"+"e"+"f"+"g"').f(), 'abcdefg'))

// ============================================================================
// FINDINGS — CLOSED (CARRIER PROGRAM Slice 3, .work/carrier-representation-
// design.md §7). These probes ORIGINALLY reproduced documented bugs (the
// registry's own FINDINGS array recorded the divergence); Slice 3 landed the
// missing arm each one exercises, so each now asserts the JS-CORRECT value —
// the oracle-flip this slice's own worklist named. Retained under the same
// names/probes (not deleted) as the regression pin for the arm that closed
// each gap; layout-kinds.js's FINDINGS array now only lists the still-open
// OBJECT/HASH/CLOSURE region-forwarding gap (region-program-scoped, not
// carrier-scoped — untouched here).
// ============================================================================

test('closed[typeof]: typeof(boxed BigInt) reports "bigint" ($__typeof PTR.BIGINT arm)', () => {
  // __box_bigint is the test-only intrinsic (module/core.js, mirrors
  // __mkptr/__ptr_type) that materializes a REAL PTR.BIGINT box without
  // needing JZ_CARRIER_BOX=1 — see test/pointers.js's own carrier-boxing
  // section. valTypeOf(__box_bigint(...)) is not statically provable BIGINT,
  // so this reaches $__typeof's dynamic dispatch — now a real tag arm.
  is(run(`export let f = () => { let a = [0]; return typeof __box_bigint(5n) }`).f(), 'bigint')
})

test('closed[eq-identity]: === on two equal-value boxed BigInts is true ($__eq content-compare arm)', () => {
  is(run(`export let f = () => { let a = [0]; return __box_bigint(5n) === __box_bigint(5n) }`).f(), true)
})

test('closed[eq-identity]: === on two DIFFERENT-value boxed BigInts is still false', () => {
  is(run(`export let f = () => { let a = [0]; return __box_bigint(5n) === __box_bigint(6n) }`).f(), false)
})

test('closed[eq-identity]: Set dedup by BigInt value now works across separate boxes ($__same_value_zero/$__map_hash arms)', () => {
  is(run(`export let f = () => { let a = [0]; let s = new Set(); s.add(__box_bigint(5n)); s.add(__box_bigint(5n)); return s.size }`).f(), 1)
})

test('closed[interop-decode]: a boxed BigInt returned to the host decodes to a real host bigint (mem.read t===5 arm)', () => {
  const r = run(`export let f = () => { let a = [0]; return __box_bigint(5n) }`).f()
  is(typeof r, 'bigint', 'mem.read now has a PTR.BIGINT arm — decodes the payload, not the pointer bits')
  is(r, 5n)
})

test('closed[truthy]: Boolean(boxed 0n) is false, Boolean(boxed nonzero) is true ($__is_truthy PTR.BIGINT arm)', () => {
  is(run(`export let f = () => { let a = [0]; return __box_bigint(0n) ? 1 : 0 }`).f(), 0)
  is(run(`export let f = () => { let a = [0]; return __box_bigint(-1n) ? 1 : 0 }`).f(), 1)
})

test('region-forwarding (BIGINT closed, informational): structuredClone passes a boxed BigInt through unchanged — now an explicit __sclone_rec arm (immutable content, registry: never relocates), not the old silent unrecognized-tag fallback', () => {
  is(run(`export let f = () => {
    let a = [0]
    let p = __box_bigint(5n)
    let c = structuredClone(p)
    return __ptr_offset(p) === __ptr_offset(c)
  }`).f(), true)
})
