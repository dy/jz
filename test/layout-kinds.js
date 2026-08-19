/**
 * Heap-kind registry shadow-check (.work/research.md §Heap-kind registry).
 *
 * Proves layout-kinds.js's compact KIND_REGISTRY + layout-kinds-doc.js's
 * prose extension against LIVE behavior: one probe per kind × consumer
 * (typeof, ===/==, Set/Map keying, interop roundtrip) plus one live-
 * reproducing probe per FINDINGS entry. Every assertion here encodes what
 * the runtime ACTUALLY does today — a divergence from some OTHER consumer's
 * stated intent is recorded as a FINDING in layout-kinds-doc.js, not "fixed"
 * by picking a side in this file.
 *
 * Imports BOTH modules (Slice 4 split, audit-#16 registry finding): plain
 * KIND_REGISTRY (layout-kinds.js) is the compact table production actually
 * consumes — tag/aux/identity/identityArm reads and the identity-dispatch
 * generators below are checked against it directly. KIND_REGISTRY_DOC
 * (layout-kinds-doc.js) is the prose-extended table — FINDINGS
 * cross-referencing and the full-column completeness check use it, since
 * the prose columns (allocShape, childPointers, forwarding, identityNote,
 * interopDecode, typeofArm, findings) no longer live on the compact table.
 *
 * Runs identically under plain and JZ_DEBUG_INVARIANTS=1 (no codegen this
 * file touches is gated on that flag) — the DBG_INVARIANTS-conditional
 * tests below add stricter completeness checks, matching test/invariants.js's
 * existing gated-test convention.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { DBG_INVARIANTS } from '../src/ctx.js'
import { PTR } from '../layout.js'
import { KIND_REGISTRY, CONTENT_IDENTITY_ORDER, eqIdentityChain, sameValueZeroIdentityChain, mapHashStringArm, mapHashBigintArm } from '../layout-kinds.js'
import { KIND_REGISTRY as KIND_REGISTRY_DOC, FINDINGS } from '../layout-kinds-doc.js'

const run = (code, opts) => jz(code, opts).exports

// ============================================================================
// Registry self-consistency (catches this FILE going stale, not the runtime)
// ============================================================================

test('registry: every live PTR.* tag has at least one KIND_REGISTRY row', () => {
  const tagsInRegistry = new Set(Object.values(KIND_REGISTRY).map(k => k.tag).filter(t => t != null))
  for (const [name, tag] of Object.entries(PTR)) ok(tagsInRegistry.has(tag), `PTR.${name} (${tag}) missing from KIND_REGISTRY`)
})

test('registry: every FINDINGS id is cross-referenced from every kind it names (doc-extended table)', () => {
  for (const f of FINDINGS) {
    for (const kindName of f.kinds) {
      const row = KIND_REGISTRY_DOC[kindName]
      ok(row, `FINDINGS[${f.id}] names unknown kind ${kindName}`)
      ok(row.findings?.includes(f.id), `KIND_REGISTRY_DOC.${kindName}.findings missing '${f.id}'`)
    }
  }
})

if (DBG_INVARIANTS) {
  test('registry: every KIND_REGISTRY_DOC row declares all seven documented columns', () => {
    const COLS = ['tag', 'allocShape', 'childPointers', 'forwarding', 'identityNote', 'interopDecode', 'typeofArm']
    for (const [name, row] of Object.entries(KIND_REGISTRY_DOC))
      for (const c of COLS) ok(c in row, `KIND_REGISTRY_DOC.${name} missing column '${c}'`)
  })

  test('registry: doc-extended table adds prose on top of the SAME compact rows (no duplication of executable fields)', () => {
    for (const [name, row] of Object.entries(KIND_REGISTRY))
      is(KIND_REGISTRY_DOC[name].tag, row.tag, `KIND_REGISTRY_DOC.${name}.tag diverged from the compact table`)
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
// each gap; layout-kinds.js's FINDINGS['region-forwarding'] entry is now
// RESOLVED too (region-relocate[CLOSURE] tests below), region-program-scoped,
// not carrier-scoped.
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

// ============================================================================
// FINDINGS[region-forwarding] — CLOSURE region-copy arm (regionArmClosure,
// layout-kinds.js), the region program's own front-boundary forcing case
// (.work/research.md §Region arena). __region_mark/__region_exit are
// ordinary ctx.core.emit-dispatched intrinsics (module/core.js) — reachable
// from plain jz source natively, no self-compile kernel needed to exercise the
// arm itself (the self-compiled kernel gate ladder — kernel-oracle/kernel-
// parity/fuzz/test:wasm — is what proves it under REAL region rounds; these
// are the fast, direct regression pins for the mechanism).
// ============================================================================

test('region-relocate[CLOSURE]: zero-capture closure crosses a region boundary (no heap block — passthrough)', () => {
  is(run(`export let f = () => {
    let mark = __region_mark()
    let g = () => 41
    let out = __region_exit(mark, [g])
    return out[0]() + 1
  }`).f(), 42)
})

test('region-relocate[CLOSURE]: unboxed (value-mode) captures survive relocation', () => {
  is(run(`export let f = (a) => {
    let mark = __region_mark()
    let g = (x) => x + a
    let out = __region_exit(mark, [g])
    return out[0](10)
  }`).f(5), 15)
})

test('region-relocate[CLOSURE]: boxed (cell-mode) mutable capture survives relocation and keeps mutating', () => {
  is(run(`export let f = () => {
    let mark = __region_mark()
    let n = 1
    let inc = () => { n = n + 1; return n }
    inc()
    let out = __region_exit(mark, [inc])
    return out[0]()
  }`).f(), 3)
})

test('region-relocate[CLOSURE]: a cell shared by two closures relocates to the SAME address (aliasing preserved)', () => {
  is(run(`export let f = () => {
    let mark = __region_mark()
    let n = 0
    let inc = () => { n = n + 1; return n }
    let get = () => n
    inc(); inc()
    let out = __region_exit(mark, [inc, get])
    out[0]()
    return out[1]()
  }`).f(), 3)
})

test('region-relocate[CLOSURE]: a closure captured inside another closure\'s env recurses through the arm', () => {
  is(run(`export let f = () => {
    let mark = __region_mark()
    let inner = () => 7
    let outer = () => inner() + 1
    let out = __region_exit(mark, [outer])
    return out[0]()
  }`).f(), 8)
})

test('region-relocate[CLOSURE]: >8 captures (beyond MAX_CLOSURE_ARITY call-arity, env is unbounded)', () => {
  is(run(`export let f = () => {
    let a=1,b=2,c=3,d=4,ee=5,ff=6,g=7,h=8,i=9,j=10
    let mark = __region_mark()
    let sum10 = () => a+b+c+ee+ff+g+h+i+j+d
    let out = __region_exit(mark, [sum10])
    return out[0]()
  }`).f(), 55)
})

test('region-relocate[CLOSURE]: a closure created BEFORE mark (durable) is walked in place, not reallocated', () => {
  is(run(`
    let n = 0
    let inc = () => { n = n + 1; return n }
    export let f = () => {
      inc()
      let mark = __region_mark()
      let out = __region_exit(mark, [inc])
      return out[0]()
    }
  `).f(), 2)
})

test('region-relocate[CLOSURE]: diamond-shared closure identity (===) survives relocation (memoized, not double-copied)', () => {
  is(run(`export let f = () => {
    let mark = __region_mark()
    let g = () => 9
    let out = __region_exit(mark, [g, g])
    return out[0] === out[1]
  }`).f(), true)
})

test('region-relocate[CLOSURE]: self-referential recursive closure (reassigned through a boxed cell) survives relocation', () => {
  is(run(`export let f = (n) => {
    let mark = __region_mark()
    let fact = (x) => 1
    fact = (x) => x <= 1 ? 1 : x * fact(x - 1)
    let out = __region_exit(mark, [fact])
    return out[0](n)
  }`).f(5), 120)
})

// ============================================================================
// regionArmSetMap's durable short-circuit (.work/research.md §Region arena —
// regionArmSetMap's durable short-circuit): SET/MAP had no region-relocate
// coverage at all before this (the pre-existing __coll_order+reinsert rebuild
// path was only ever exercised indirectly, via kernel-oracle/self-build) —
// the baseline pair below (ephemeral rebuild, diamond identity) pins the
// UNCHANGED path; the rest exercise the new durable value-patch fast path and
// its read-only-scan fallback specifically.
// ============================================================================

test('region-relocate[MAP]: ephemeral Map (created after mark) crosses a region boundary via the rebuild path', () => {
  is(run(`export let f = () => {
    let mark = __region_mark()
    let m = new Map()
    m.set('a', 1)
    m.set('b', 2)
    let out = __region_exit(mark, [m])
    return out[0].get('a') + out[0].get('b')
  }`).f(), 3)
})

test('region-relocate[SET]: ephemeral Set (created after mark) crosses a region boundary via the rebuild path', () => {
  is(run(`export let f = () => {
    let mark = __region_mark()
    let s = new Set([1, 2, 3])
    let out = __region_exit(mark, [s])
    return out[0].has(2) && out[0].size === 3
  }`).f(), true)
})

test('region-relocate[MAP]: an ephemeral Map reachable from two root slots is memoized, not double-rebuilt (identity survives)', () => {
  is(run(`export let f = () => {
    let mark = __region_mark()
    let m = new Map()
    m.set(1, 2)
    let out = __region_exit(mark, [m, m])
    return out[0] === out[1]
  }`).f(), true)
})

test('region-relocate[MAP]: durable Map (created before mark) with hash-stable keys takes the value-patch fast path, no rebuild needed', () => {
  is(run(`
    let m = new Map()
    m.set(1, 10)
    m.set(2, 20)
    export let f = () => {
      let mark = __region_mark()
      m.set(3, 30)
      let out = __region_exit(mark, [m])
      return out[0].get(1) + out[0].get(2) + out[0].get(3)
    }
  `).f(), 60)
})

test('region-relocate[MAP]: durable Map, durable key, EPHEMERAL replacement value — the value-patch pass relocates the new value in place', () => {
  is(run(`
    let m = new Map()
    m.set('k', 0)
    export let f = () => {
      let mark = __region_mark()
      m.set('k', [4, 5, 6])
      let out = __region_exit(mark, [m])
      let v = out[0].get('k')
      return v[0] + v[1] + v[2]
    }
  `).f(), 15)
})

test('region-relocate[MAP]: durable Map holding an EPHEMERAL pointer-typed key falls back to a full rebuild and stays correct', () => {
  is(run(`
    let m = new Map()
    m.set('base', 100)
    export let f = () => {
      let mark = __region_mark()
      let arr = [1, 2, 3]
      m.set(arr, 'arrval')
      let out = __region_exit(mark, [m])
      let arrKey = null
      for (let k of out[0].keys()) if (Array.isArray(k)) arrKey = k
      return out[0].get('base') + (out[0].get(arrKey) === 'arrval' ? 1 : 0) + arrKey[0] + arrKey[1] + arrKey[2]
    }
  `).f(), 107)
})

test('region-relocate[MAP]: durable Map, durable pointer-typed key (both container and key stable) — fully-durable table survives untouched', () => {
  is(run(`
    let keyArr = [7, 8, 9]
    let m = new Map()
    m.set(keyArr, 'x')
    export let f = () => {
      let mark = __region_mark()
      let out = __region_exit(mark, [m])
      return out[0].get(keyArr)
    }
  `).f(), 'x')
})

test('region-relocate[SET]: durable Set (created before mark) with hash-stable members takes the value-patch fast path', () => {
  is(run(`
    let s = new Set([10, 20])
    export let f = () => {
      let mark = __region_mark()
      s.add(30)
      let out = __region_exit(mark, [s])
      return out[0].has(10) && out[0].has(20) && out[0].has(30) && out[0].size === 3
    }
  `).f(), true)
})

test('region-relocate[SET]: durable Set holding an EPHEMERAL pointer-typed member falls back to a full rebuild and stays correct', () => {
  is(run(`
    let s = new Set()
    s.add('base')
    export let f = () => {
      let mark = __region_mark()
      let arr = [1, 2]
      s.add(arr)
      let out = __region_exit(mark, [s])
      let arrM = null
      for (let m of out[0]) if (Array.isArray(m)) arrM = m
      return out[0].has('base') && arrM[0] === 1 && arrM[1] === 2 && out[0].size === 2
    }
  `).f(), true)
})

// fplan-2026-08-17 (.work/research.md §CompileSession forensic — "FunctionPlan
// missing for m6_parse$parse"): the stability scan and the rebuild path below
// it share the SAME $i local. On finding an unstable key the scan branches out
// of its loop EARLY, leaving $i frozen at that break's raw SLOT index (0..cap-1,
// table layout order) rather than 0 or $cap. The rebuild loop right below reuses
// that same $i as its OWN starting index into $ord (the insertion-ORDER gather
// __coll_order produces) — silently skipping the first $i insertion-order
// entries, which are the OLDEST published keys, not related to the raw slot
// the scan happened to break on. The two prior tests above (a single durable
// key + one ephemeral key) never catch this, for a reason found only by
// instrumenting the arm directly with unreachable traps: __region_exit has its
// own "adaptive exit-skip" (module/core.js, THE MEMORY ENDGAME) — under 16 MiB
// of churn since mark, it returns the root UNCHANGED without ever calling
// __region_copy_rec at all, so a tiny snippet never reaches this arm's code in
// the first place (trivially "correct" because nothing moved). A big-enough
// durable table alone isn't sufficient either: at the default optimize level
// watr inlines+specializes a small, statically-shaped __region_mark/
// __region_exit call pair down to bespoke code that doesn't route through this
// generic arm at all (confirmed by dumping the WAT — region_mark/region_exit
// call counts are 0 at the default level, real calls only appear under
// optimize:false). Both defeated in combination below: a >16 MiB pad array
// forces a real walk, optimize:false keeps the call sites unspecialized, and
// 40 durable + 5 ephemeral pointer-typed entries (see the sizing note) makes a
// non-zero scan-break index near-certain. Verified directly against the
// pre-fix arm (temporarily reverted, unreachable traps at the scan's break and
// at the rebuild's own entry): the SAME construction reproducibly rebuilds the
// table to size 0 (every entry lost, not just a handful) without this fix.
// Sizing note: the table must stay DURABLE (its own address must not move)
// across mark, or the "if (off < mark)" gate never even reaches the scan — so
// the ephemeral inserts below must not cross the 75%-load grow threshold. 40
// durable entries settle the table at cap=64 (load 0.625); up to 7 more
// entries can be added before the next grow (to 48, i.e. cap 128) fires, so 5
// ephemeral pointer-typed entries stay safely inside that margin. With 40 of
// 64 slots ALREADY durable-occupied before any ephemeral insert, slot 0 has
// ~62% odds of already holding a durable entry — so the scan's first found
// unstable key (which is what freezes $i) lands past index 0 with high
// probability, reliably exercising the regression.
test('region-relocate[MAP]: durable Map (40 durable keys, stays at cap 64) plus 5 late EPHEMERAL pointer-typed keys, churn past the exit-skip threshold — every durable key survives the rebuild (stale-$i regression)', () => {
  is(run(`
    let m = new Map()
    for (let i = 0; i < 40; i++) m.set('k' + i, i)
    export let f = () => {
      let mark = __region_mark()
      let pad = new Float64Array(3000000)  // >16 MiB churn — defeats __region_exit's adaptive skip
      pad[0] = 1
      for (let i = 0; i < 5; i++) m.set([i], 'e' + i)
      let out = __region_exit(mark, [m])
      let sum = 0
      for (let i = 0; i < 40; i++) { let v = out[0].get('k' + i); if (v !== undefined) sum += v }
      let eCount = 0
      for (let k of out[0].keys()) if (Array.isArray(k)) eCount++
      return out[0].size === 45 && sum === 780 && eCount === 5
    }
  `, { optimize: false }).f(), true)  // optimize:false — defeats watr's small-call-site inlining/specialization
})

test('region-relocate[SET]: durable Set (40 durable members, stays at cap 64) plus 5 late EPHEMERAL pointer-typed members, churn past the exit-skip threshold — every durable member survives the rebuild (stale-$i regression)', () => {
  is(run(`
    let s = new Set()
    for (let i = 0; i < 40; i++) s.add('k' + i)
    export let f = () => {
      let mark = __region_mark()
      let pad = new Float64Array(3000000)
      pad[0] = 1
      for (let i = 0; i < 5; i++) s.add([i])
      let out = __region_exit(mark, [s])
      let n = 0
      for (let i = 0; i < 40; i++) if (out[0].has('k' + i)) n++
      let eCount = 0
      for (let v of out[0]) if (Array.isArray(v)) eCount++
      return out[0].size === 45 && n === 40 && eCount === 5
    }
  `, { optimize: false }).f(), true)
})

// ============================================================================
// Heap-kind registry Slice 3 (.work/research.md §Heap-kind registry —
// "$__eq/$__map_hash arms generated"): $__eq's/$__same_value_zero's content-
// identity dispatch chains and $__map_hash's STRING/BIGINT arms are now
// GENERATED by layout-kinds.js from KIND_REGISTRY.{STRING,BIGINT}.identityArm
// (module/core.js and module/collection.js call eqIdentityChain() /
// sameValueZeroIdentityChain() / mapHashStringArm() / mapHashBigintArm()
// instead of inlining the WAT text). These are GOLDEN-TEXT PINS: the exact
// strings below were captured from the hand-written source BEFORE the swap
// and verified byte-identical to the generator's output at migration time —
// a future edit to either side that silently drifts the other is caught
// here as a string mismatch, not as a distant behavior regression.
//
// FINDINGS[identity-arm-divergence] (layout-kinds.js): extracting these two
// eq-style chains verbatim surfaced a genuine, PRE-EXISTING divergence
// between $__eq and $__same_value_zero's STRING arms. Registry Slice 5
// re-derived it: the per-operand NaN re-guard was load-bearing (proven by
// the live crash probe below, not just re-read) and now ships in BOTH golden
// strings; the interned-vs-interned short-circuit is confirmed perf-only and
// stays $__eq-exclusive — that's the one STRING sub-fragment the two golden
// strings below still don't share. See the FINDINGS entry for the full
// writeup.
// ============================================================================

test('registry: content-identity kinds are BIGINT then STRING, in that order', () => {
  is(CONTENT_IDENTITY_ORDER.length, 2)
  is(CONTENT_IDENTITY_ORDER[0], 'BIGINT')
  is(CONTENT_IDENTITY_ORDER[1], 'STRING')
})

test('registry: STRING/BIGINT identityArm columns are structured (kind + order)', () => {
  is(KIND_REGISTRY.BIGINT.identityArm.kind, 'content')
  is(KIND_REGISTRY.STRING.identityArm.kind, 'content')
  ok(KIND_REGISTRY.BIGINT.identityArm.order < KIND_REGISTRY.STRING.identityArm.order)
})

test('golden[eqIdentityChain]: $__eq\'s generated content-identity chain matches the captured hand-written text', () => {
  is(eqIdentityChain(), "(if (result i32)\n              (i32.and (i32.eq (local.get $ta) (i32.const 5)) (i32.eq (local.get $tb) (i32.const 5)))\n              (then (i64.eq\n                (i64.load (call $__ptr_offset (local.get $a)))\n                (i64.load (call $__ptr_offset (local.get $b)))))\n              (else\n            (if (result i32)\n              (i32.and\n                (i32.and (f64.ne (local.get $fa) (local.get $fa)) (i32.eq (local.get $ta) (i32.const 4)))\n                (i32.and (f64.ne (local.get $fb) (local.get $fb)) (i32.eq (local.get $tb) (i32.const 4))))\n              (then\n                ;; both canonical interned (bit-ne already known) ⇒ unequal —\n                ;; skip the __str_eq call entirely (see STR_INTERN_BIT, layout.js)\n                (if (result i32)\n                  (i32.and\n                    (i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const 32))) (i32.const 24577)) (i32.const 1))\n                    (i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const 32))) (i32.const 24577)) (i32.const 1)))\n                  (then (i32.const 0))\n                  (else (call $__str_eq (local.get $a) (local.get $b)))))\n              (else (i32.const 0)))))")
})

test('golden[sameValueZeroIdentityChain]: $__same_value_zero\'s generated chain matches the captured hand-written text', () => {
  is(sameValueZeroIdentityChain(), "(if (result i32)\n              (i32.and (i32.eq (local.get $ta) (i32.const 5)) (i32.eq (local.get $tb) (i32.const 5)))\n              (then (i64.eq\n                (i64.load (call $__ptr_offset (local.get $a)))\n                (i64.load (call $__ptr_offset (local.get $b)))))\n              (else\n            (if (result i32)\n              (i32.and\n                (i32.and (f64.ne (local.get $fa) (local.get $fa)) (i32.eq (local.get $ta) (i32.const 4)))\n                (i32.and (f64.ne (local.get $fb) (local.get $fb)) (i32.eq (local.get $tb) (i32.const 4))))\n              (then (call $__str_eq (local.get $a) (local.get $b)))\n              (else (i32.const 0)))))")
})

// FINDINGS[identity-arm-divergence] live regression: an ordinary finite,
// self-equal f64 can have ANY 4-bit pattern at mantissa bits 47-50 (the tag
// field) by sheer construction — including PTR.STRING's tag id (4) — purely
// by chance. 0x3ff20000ffffffff (≈1.1250009536743162) is one such value:
// finite (exponent 0x3ff, nowhere near the 0x7ff NaN/Inf reserved range),
// self-equal, tag-bits-alias-STRING. Before this slice, $__same_value_zero's
// STRING arm trusted the tag WITHOUT re-verifying the operand was actually
// NaN-boxed (unlike $__eq, which re-guards each operand with `f64.ne(f,f)`)
// — so on a genuine $__map_hash collision between such a float and a real
// heap string, it dereferenced the float's low 32 bits as a string offset
// via __str_eq and OOB-TRAPPED. Natural full-hash collisions are ~2^-32, far
// outside what a jz-source fuzz probe could hit — this test reaches the same
// runtime arm the way the runtime itself would (a genuine LANE hash-word
// match), by writing the Set's own LANE/entry words directly, exactly as
// __set_add itself does on an insert. See layout-kinds-doc.js's
// FINDINGS[identity-arm-divergence] for the full writeup.
test('identity-arm-divergence: $__same_value_zero survives a forced STRING-tag-aliasing hash collision (regression pin)', () => {
  const SET_ENTRY = 16
  const code = `
    export let mk = () => {
      let s = new Set()
      s.add("this is a genuinely long heap string, not SSO")
      return s
    }
    export let hasQ = (s, n) => s.has(n)
    export let eqQ = (a, b) => a === b
  `
  const { instance } = instantiate(compile(code))
  const ex = instance.exports
  const dv = new DataView(ex.memory.buffer)

  const sBits = ex.mk()
  const off = Number(sBits & 0xFFFFFFFFn)
  const cap = dv.getInt32(off - 4, true)
  const laneBase = off + cap * SET_ENTRY
  let idx0 = -1
  for (let i = 0; i < cap; i++) if (dv.getInt32(laneBase + i * 4, true) !== 0) { idx0 = i; break }
  ok(idx0 >= 0, 'the string entry landed somewhere in the table')
  const entryAddr = off + idx0 * SET_ENTRY
  const hashWord = dv.getBigInt64(entryAddr, true)
  const keyBits = dv.getBigInt64(entryAddr + 8, true)

  // 0x3ff20000ffffffff: exponent=0x3ff (finite), mantissa bits 47-50 = 4 (PTR.STRING),
  // aux bits (32-46) = 0 (no SSO/SLICE/INTERN alias), low 32 bits = 0xffffffff (a wildly
  // invalid "string offset" if ever dereferenced).
  const craftedBits = 0x3ff20000ffffffffn
  ok(craftedBits === craftedBits, 'sanity: this is a real BigInt bit pattern')

  const jzHash = (bits) => {
    const lo = bits & 0xFFFFFFFFn, hi = (bits >> 32n) & 0xFFFFFFFFn
    let h = Number((lo ^ hi) & 0xFFFFFFFFn) | 0
    return (h <= 1 ? h + 2 : h) >>> 0
  }
  const hTarget = jzHash(craftedBits)
  const idxTarget = hTarget & (cap - 1)
  const targetEntryAddr = off + idxTarget * SET_ENTRY
  dv.setBigInt64(targetEntryAddr, hashWord, true)
  dv.setBigInt64(targetEntryAddr + 8, keyBits, true)
  dv.setInt32(laneBase + idxTarget * 4, hTarget, true)
  if (idxTarget !== idx0) dv.setInt32(laneBase + idx0 * 4, 0, true)

  // The fixed $__same_value_zero must return false (not crash) — it must reject
  // the non-NaN-boxed operand exactly like $__eq/$__eq_strict already do. `hasQ`'s
  // receiver is unproven, so `.has()` routes through collProbeDyn (module/collection.js)
  // — its result is now the canonical boxed FALSE_NAN atom (not a raw 0.0 number, whose
  // exported bits used to read back as `0n`), matching `eqQ` below's own boxed-false
  // convention (carrier-representation-design.md §33/§34: collProbeDyn used to return
  // an unboxed number, breaking `=== true` bit-comparisons on the same value elsewhere).
  is(ex.hasQ(sBits, craftedBits), 9221120254220959744n, '$__same_value_zero: no false-positive AND no OOB trap on the forced collision')
  is(ex.eqQ(craftedBits, keyBits), 9221120254220959744n, '$__eq agrees (false), unaffected — sanity cross-check')
})

test('golden[mapHashStringArm]: $__map_hash\'s generated STRING arm matches the captured hand-written text', () => {
  is(mapHashStringArm(), "(if (i32.and (f64.ne (local.get $f) (local.get $f))\n          (i32.eq (local.get $t) (i32.const 4)))\n      (then (return (call $__str_hash (local.get $v)))))")
})

test('golden[mapHashBigintArm]: $__map_hash\'s generated BIGINT arm matches the captured hand-written text', () => {
  is(mapHashBigintArm(), "(if (i32.and (f64.ne (local.get $f) (local.get $f))\n          (i32.eq (local.get $t) (i32.const 5)))\n      (then (local.set $h (call $__hash (i64.load (call $__ptr_offset (local.get $v)))))\n        (return (if (result i32) (i32.le_s (local.get $h) (i32.const 1))\n          (then (i32.add (local.get $h) (i32.const 2)))\n          (else (local.get $h))))))")
})

test('golden: BIGINT arm text is IDENTICAL between eqIdentityChain and sameValueZeroIdentityChain (the one shared sub-fragment)', () => {
  // Both chains open with the exact same BIGINT dispatch (tag check + payload i64.eq
  // + `(else`) before diverging on STRING — confirms the shared fragment really is
  // shared, not just coincidentally similar.
  const bigintPrefixLen = eqIdentityChain().indexOf('(else\n            (if (result i32)\n              (i32.and\n')
  ok(bigintPrefixLen > 0)
  is(eqIdentityChain().slice(0, bigintPrefixLen), sameValueZeroIdentityChain().slice(0, bigintPrefixLen))
})

// ============================================================================
// Lane-below-survivors invariant (.work/research.md §survivorMargin
// unsoundness, 2026-08-19): the memo lane sits AT the heap cursor and
// survivor copies start ABOVE its reserved end. The pre-redesign layout
// (lane at heap + min(churn/2, 256 MiB), survivors below) corrupted the memo
// on any round whose survivor ratio exceeded 1/2 — this construction retains
// essentially ALL of its >16 MiB churn in the root (survivor ratio ≈ 1), the
// shape that reproduced the emission-rounds phantom-allocation regression.
// ============================================================================

test('region-relocate[LANE]: high-survivor-ratio round (nearly all churn retained in the root) relocates intact — survivors cannot collide with the memo lane', () => {
  is(run(`
    export let f = () => {
      let mark = __region_mark()
      let a = new Float64Array(1500000)  // ~12 MiB, retained
      for (let i = 0; i < 1500000; i += 100000) a[i] = i
      let b = new Float64Array(1500000)  // ~12 MiB, retained — churn ~24 MiB, survivors ≈ churn
      for (let i = 0; i < 1500000; i += 100000) b[i] = i * 2
      let m = new Map()
      for (let i = 0; i < 30; i++) m.set('k' + i, [i])  // pointer values — deep relocation, memo-exercising
      let out = __region_exit(mark, [a, b, m])
      let ok = out[0][100000] === 100000 && out[1][100000] === 200000
      let sum = 0
      for (let i = 0; i < 30; i++) sum += out[2].get('k' + i)[0]
      return ok && out[2].size === 30 && sum === 435
    }
  `, { optimize: false }).f(), true)
})
