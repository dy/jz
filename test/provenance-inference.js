// Typed-array kind provenance — per-edge pins (bench/provenance's edges in
// miniature). Each edge differs ONLY in how the Float64Array reaches the hot
// loop; the kernel must stay on the typed path (no __typed_idx/__dyn_get/__len
// dispatch inside `go`). The inference chain under test: observeProgramSlots'
// slotTypedCtors census + slotTypedCtorAt/BySid (never-written gate) + the
// module-let fixpoint's field-read evidence (late run) + refineFieldProvenance
// (module-const sids from ABI-backed return schemas) + narrow's per-caller and
// module-seeded sid maps feeding the typed-param arg lattice.
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import jz from '../index.js'
import { TYPED_CTOR_CONFLICT, typedStorageFact } from '../src/typed-provenance.js'

test('typed provenance: one grammar authority joins and chains every storage source', () => {
  const names = new Map([['a', 'new.Int16Array'], ['b', 'new.Int16Array'], ['c', 'new.Float64Array']])
  const sources = {
    name: name => names.get(name) ?? null,
    call: name => name === 'make' ? 'new.BigInt64Array' : null,
    field: (_obj, prop) => prop === 'lane' ? 'new.Uint32Array' : null,
    index: obj => obj === 'rows' ? 'new.Float32Array' : null,
  }
  is(typedStorageFact(['?:', 'flag', 'a', 'b'], sources), 'new.Int16Array', 'same-ctor join closes')
  is(typedStorageFact(['?:', 'flag', 'a', 'c'], sources), TYPED_CTOR_CONFLICT, 'mixed join conflicts')
  is(typedStorageFact(['??', 'a', 'b'], sources), 'new.Int16Array', 'nullish join uses same meet')
  is(typedStorageFact(['()', ['.', ['()', 'make'], 'slice'], null], sources), 'new.BigInt64Array', 'call → copy')
  is(typedStorageFact(['()', ['.', ['.', 'plan', 'lane'], 'subarray'], null], sources), 'new.Uint32Array.view', 'field → view')
  is(typedStorageFact(['()', ['.', ['[]', 'rows', 'i'], 'map'], null], sources), 'new.Float32Array', 'indexed storage → copy')
})

const KERNEL = `export let go = (n) => { let s = 0; for (let i = 0; i < n; i++) s += T[i & 1023]; return s }`
const EDGES = {
  ret: `const mk = (n) => { const w = new Float64Array(n); return w }\nconst T = mk(1024)\n${KERNEL}`,
  field: `const mk = (n) => { const wre = new Float64Array(n), wim = new Float64Array(n); return { wre, wim } }\nconst P = mk(1024)\nconst T = P.wre\n${KERNEL}`,
  fieldInline: `const mk = (n) => { const wre = new Float64Array(n), wim = new Float64Array(n); return { wre, wim } }\nconst P = mk(1024)\nexport let go = (n) => { let s = 0; for (let i = 0; i < n; i++) s += P.wre[i & 1023]; return s }`,
  paramViaField: `const mk = (n) => { const wre = new Float64Array(n), wim = new Float64Array(n); return { wre, wim } }\nconst sum = (T, n) => { let s = 0; for (let i = 0; i < n; i++) s += T[i & 1023]; return s }\nconst P = mk(1024)\nexport let go = (n) => sum(P.wre, n)`,
}

const kernelOf = (w, fn = 'go') => {
  // the param edge inlines/renames — fall back to the sum body when go is a thin wrapper
  for (const name of [fn, 'sum']) {
    const i = w.indexOf(`func $${name}`)
    if (i < 0) continue
    const j = w.indexOf('\n  (func', i + 5)
    const body = w.slice(i, j > 0 ? j : undefined)
    if (body.includes('loop')) return body
  }
  return w
}

for (const [name, src] of Object.entries(EDGES)) {
  test(`provenance: ${name} edge keeps the typed element path`, () => {
    const w = jz.compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
    const body = kernelOf(w)
    ok(!/__typed_idx|__dyn_get|__arr_idx/.test(body), `${name}: no dynamic dispatch in the kernel`)
  })
}

// KNOWN-OPEN edges (memo global / Map cache): the value-level "kind or nullish"
// return facts they need proved UNSOUND as consumed — an unguarded typed unbox
// on a nullish/dyn-undefined value reads garbage memory instead of JS behavior
// (caught by a composite-route OOB during development). Their revival needs a
// guarded unbox (tag-checked pointer materialization, hoistable) or a non-null
// flow proof. Pinned DYNAMIC until then.
for (const [name, src] of Object.entries({
  memo: `const mk = (n) => new Float64Array(n)\nlet last = null\nconst get = (n) => { if (last === null) last = mk(n); return last }\nexport let go = (n) => { const T = get(1024); let s = 0; for (let i = 0; i < n; i++) s += T[i & 1023]; return s }`,
  map: `const mk = (n) => new Float64Array(n)\nconst cache = new Map()\nconst get = (n) => { let p = cache.get(n); if (p === undefined) { p = mk(n); cache.set(n, p) }; return p }\nexport let go = (n) => { const T = get(1024); let s = 0; for (let i = 0; i < n; i++) s += T[i & 1023]; return s }`,
})) {
  test(`provenance: ${name} edge stays dynamic (known-open, unsound to trust unguarded)`, () => {
    const w = jz.compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
    ok(/__typed_idx|__dyn_get|shr_u/.test(kernelOf(w)), `${name}: runtime dispatch retained`)
  })
}

// value-correctness of the trusted field route — the shape pins above prove the
// PATH; this proves the VALUES (an unsound fold reads garbage, not wrong shapes)
test('provenance: field route is value-correct', () => {
  const src = `const mk = (n) => { const wre = new Float64Array(n), wim = new Float64Array(n); for (let i = 0; i < n; i++) wre[i] = i * 0.5; return { wre, wim } }
const P = mk(64)
const T = P.wre
export let go = () => {
  let s = 0
  for (let i = 0; i < 64; i++) s += T[i]
  return s
}`
  const { exports } = jz(src)
  // Σ i·0.5 for i in [0,64) = 0.5·(63·64/2) = 1008
  is(exports.go(), 1008)
})

// module-memo OBJECT-FIELD route (bench/provenance's edge 4, distinct from the
// KNOWN-OPEN bare-typed-array "memo" edge above): `getMemo`'s return is
// classified VAL.OBJECT (never nullish by construction — every path either
// returns the already-populated global or freshly makes one), so
// module/core.js's emitPropAccess devirtualizes the `.wre`/`.wim` field reads
// through guardedSlotOf's runtime tag-checked fast path (same mechanism the
// `field`/`fieldInline` edges above already use, previously skipped for a
// vt===VAL.OBJECT receiver — see module/core.js emitPropAccess's `vt ===
// VAL.OBJECT` arm). Guarded, not unconditional: a schema mismatch still falls
// to the ordinary dynamic dispatch, so this can only ever be as fast, never
// wrong — the same safety margin the KNOWN-OPEN edges above are pinned on.
test('provenance: module-memo object-field route is value-correct', () => {
  const src = `const mk = (n) => { const wre = new Float64Array(n), wim = new Float64Array(n); for (let i = 0; i < n; i++) { wre[i] = i * 0.5; wim[i] = i * 0.25 }; return { wre, wim } }
let lastN = 0, lastPlan = null
const getMemo = (n) => { if (n === lastN) return lastPlan; lastPlan = mk(n); lastN = n; return lastPlan }
export let go = () => {
  const memo = getMemo(64)
  const wre = memo.wre
  const wim = memo.wim
  let s = 0
  for (let i = 0; i < 64; i++) s += wre[i] + wim[i]
  return s
}`
  const { exports } = jz(src)
  // Σ i·0.5 + Σ i·0.25 for i in [0,64) = 0.75·(63·64/2) = 0.75·2016 = 1512
  is(exports.go(), 1512)
  // Same value across every optimize tier (the guard must not change behavior).
  for (const optimize of [false, 2, 3]) is(jz(src, { optimize }).exports.go(), 1512, `O${optimize || 0}`)
})

test('provenance: indexed TypedArray → copy chain preserves BigInt storage at every tier', () => {
  const src = `const mk = x => new BigInt64Array([x])
const rows = [mk(7n), mk(9n)]
export let read = flag => {
  const out = rows[flag].slice().map(x => x)
  return Number(out.at(0))
}`
  for (const optimize of [false, 2, 3]) {
    const { exports } = jz(src, { optimize })
    is(exports.read(0), 7, `O${optimize || 0}: row 0`)
    is(exports.read(1), 9, `O${optimize || 0}: row 1`)
  }
})

// the write gate: a single prop write anywhere keeps the dynamic path (soundness)
test('provenance: a written field prop disables the slot-ctor trust', () => {
  const src = `const mk = (n) => { const wre = new Float64Array(n), wim = new Float64Array(n); return { wre, wim } }
const P = mk(1024)
export let poke = (x) => { P.wre = x; return 1 }
export let go = (n) => { let s = 0; for (let i = 0; i < n; i++) s += P.wre[i & 1023]; return s }`
  const w = jz.compile(src, { wat: true, optimize: { level: 'speed', watr: false } })
  // the kernel must NOT bake a Float64Array element width for a rewritable field
  const body = kernelOf(w)
  ok(/__typed_idx|__dyn_get|shr_u/.test(body), 'written prop keeps runtime dispatch')
})
