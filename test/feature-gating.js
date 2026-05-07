// Feature gating: verify ctx.features.* flips on iff usage/producer site fires,
// and off-state code omits the gated imports/branches. WAT-level inspection —
// each probe asserts specific symbols present/absent.
import test from 'tst'
import { is, ok, any } from 'tst/assert.js'
import { compile } from '../index.js'

const wat = (code, opts = {}) => compile(code, { ...opts, wat: true })
const hasImport = (w, name) => new RegExp(`\\(import [^)]*"${name}"`).test(w)
const hasDef = (w, name) => new RegExp(`\\(func \\$${name}\\b`).test(w)
const hasCall = (w, name) => new RegExp(`\\(call \\$${name}\\b`).test(w)

// === features.external ===

test('features.external OFF: pure scalar — no __ext_* imports', () => {
  const w = wat(`export let f = (x) => x + 1`)
  is(hasImport(w, '__ext_prop'), false)
  is(hasImport(w, '__ext_has'), false)
  is(hasImport(w, '__ext_set'), false)
  is(hasImport(w, '__ext_call'), false)
})

test('features.external OFF: schema object — no __ext_* imports', () => {
  const w = wat(`export let f = () => { let p = {x:1, y:2}; return p.x + p.y }`)
  is(hasImport(w, '__ext_prop'), false)
  is(hasImport(w, '__ext_set'), false)
})

test('features.external OFF: typed array sum — no __ext_* imports', () => {
  const w = wat(`export let s = (a) => {
    let t = 0
    for (let i = 0; i < a.length; i++) t += a[i]
    return t
  }`)
  is(hasImport(w, '__ext_prop'), false)
  is(hasImport(w, '__ext_has'), false)
})

test('features.external ON: untyped .prop read — __ext_prop import present', () => {
  const w = wat(`export let f = (o) => o.x`)
  is(hasImport(w, '__ext_prop'), true)
})

test('features.external ON: untyped .prop write — __ext_set import present', () => {
  const w = wat(`export let f = (o, v) => { o.x = v }`)
  is(hasImport(w, '__ext_set'), true)
})

test('features.external ON: untyped method call — __ext_call import present', () => {
  const w = wat(`export let f = (o) => o.m()`)
  is(hasImport(w, '__ext_call'), true)
})

test('features.external ON: HOST_GLOBALS reference — __ext_prop import present', () => {
  const w = wat(`export let f = () => globalThis.foo`)
  is(hasImport(w, '__ext_prop'), true)
})

// === Stdlib factory collapse (EXTERNAL off → shorter bodies) ===

test('features.external OFF: __dyn_get_any factory collapses (no __ext_prop call in body)', () => {
  // Need __dyn_get_any in output but without EXTERNAL arm — force via `?.prop` on dyn-type var
  const w = wat(`export let f = () => {
    let a = [1,2,3]
    return a.x
  }`)
  if (hasDef(w, '__dyn_get_any')) {
    // body must not call __ext_prop when external is off
    const body = w.match(/\(func \$__dyn_get_any[\s\S]*?\)\s*(?=\(func|\(export|\(start|$)/)[0]
    is(/__ext_prop/.test(body), false)
  }
})

test('features.external ON: __dyn_get_any_t factory has EXTERNAL arm', () => {
  const w = wat(`export let f = (o) => o.x`)
  ok(hasDef(w, '__dyn_get_any_t'))
  const body = w.match(/\(func \$__dyn_get_any_t[\s\S]*?\)\s*(?=\(func|\(export|\(start|$)/)[0]
  is(/__ext_prop/.test(body), true)
})

// === Organically usage-gated features ===

test('features.hash OFF: scalar-only — no hash substrate', () => {
  const w = wat(`export let f = (x) => x + 1`)
  is(hasDef(w, '__hash_get'), false)
  is(hasDef(w, '__hash_set'), false)
  is(hasDef(w, '__dyn_get'), false)
  is(hasDef(w, '__dyn_set'), false)
  is(hasDef(w, '__str_hash'), false)
})

test('features.hash ON: JSON.parse pulls schema substrate', () => {
  // JSON.parse builds OBJECT pointers via a runtime schema cache (__jp_obj
  // routes through __jp_schema_get); previously it emitted HASH and pulled
  // __hash_set_local. The schema substrate is what gets exercised now.
  const w = wat(`export let f = (s) => JSON.parse(s)`)
  ok(hasDef(w, '__jp_schema_get'))
})

test('features.hash ON: untyped .prop pulls __dyn_get_any_t', () => {
  const w = wat(`export let f = (o) => o.x`)
  ok(hasDef(w, '__dyn_get_any_t'))
})

test('array grow: plain push does not pull dynamic prop mover', () => {
  const w = wat(`export let f = () => {
    let a = []
    for (let i = 0; i < 8; i++) a.push(i)
    return a.length
  }`)
  ok(hasDef(w, '__arr_grow_known'))
  is(hasDef(w, '__dyn_move'), false)
  is(hasDef(w, '__ihash_set_local'), false)
})

test('array grow: dynamic props keep mover when arrays can grow', () => {
  const w = wat(`export let f = () => {
    let a = []
    a.name = 7
    for (let i = 0; i < 8; i++) a.push(i)
    return a.name
  }`)
  ok(hasDef(w, '__arr_grow_known'))
  ok(hasDef(w, '__dyn_move'))
})

test('features.regex OFF: scalar-only — no regex stdlibs', () => {
  const w = wat(`export let f = (x) => x + 1`)
  is(hasDef(w, '__regex_new'), false)
  is(hasDef(w, '__regex_exec'), false)
})

test('features.regex ON: regex literal pulls regex stdlibs', () => {
  const w = wat(`export let f = (s) => s.match(/a/)`)
  ok(/regex/i.test(w))
})

test('features.json OFF: scalar-only — no JSON stdlibs', () => {
  const w = wat(`export let f = (x) => x + 1`)
  is(hasDef(w, '__json_stringify'), false)
  is(hasDef(w, '__jp_val'), false)
})

test('features.json ON: JSON.stringify pulls json stdlibs', () => {
  const w = wat(`export let f = (x) => JSON.stringify(x)`)
  ok(/__json_|__js_/.test(w))
})

// TypedArrays don't have dedicated __typed_* stdlibs — they compile to raw
// f64.load/f32.load/etc. at header-offset addresses. No stdlib-level gating
// dimension to assert; usage is invisible in the stdlib-symbol view.

test('features.set OFF: scalar-only — no set stdlibs', () => {
  const w = wat(`export let f = (x) => x + 1`)
  is(hasDef(w, '__set_add'), false)
  is(hasDef(w, '__set_has'), false)
})

test('features.set ON: new Set pulls set stdlibs', () => {
  const w = wat(`export let f = () => { let s = new Set(); s.add(1); return s.has(1) }`)
  ok(hasDef(w, '__set_add'))
  ok(hasDef(w, '__set_has'))
})

test('features.map OFF: scalar-only — no map stdlibs', () => {
  const w = wat(`export let f = (x) => x + 1`)
  is(hasDef(w, '__map_get'), false)
  is(hasDef(w, '__map_set'), false)
})

test('features.map ON: new Map pulls map stdlibs', () => {
  const w = wat(`export let f = () => { let m = new Map(); m.set('k', 1); return m.get('k') }`)
  ok(hasDef(w, '__map_set'))
  ok(hasDef(w, '__map_get'))
})

test('runtimeExports:false omits allocator helper exports', () => {
  const w = wat(`export let f = () => {
    let a = [1, 2, 3]
    return a.length
  }`, { runtimeExports: false })
  is(/\(export "_alloc"/.test(w), false)
  is(/\(export "_reset"/.test(w), false)
  ok(/\(memory/.test(w))
})

test('features.closure OFF: no arrows — no closure table', () => {
  const w = wat(`export let f = (x) => x + 1`)
  // Single exported arrow is emitted as a plain wasm func, not a closure
  is(/\(table \d+ funcref\)/.test(w), false)
})

test('features.closure ON: first-class function — closure table present', () => {
  const w = wat(`
    export let apply = (fn, x) => fn(x)
    export let f = () => apply((y) => y * 2, 5)
  `)
  ok(/\(table[\s\S]*?funcref/.test(w))
})

// === Runtime autowiring: passing a JS object to exported fn ===

test('autowire: JS object passed to exported fn reads via EXTERNAL', async () => {
  // features.external must be on at compile time (untyped .prop triggers it),
  // and runtime wraps the JS object as EXTERNAL.
  const jz = (await import('../index.js')).default
  const { getProp } = jz(`export let getProp = (o) => o.nodeType`).exports
  is(getProp({ nodeType: 1 }), 1)
})

test('autowire: JS object method call via __ext_call', async () => {
  const jz = (await import('../index.js')).default
  const { callMe } = jz(`export let callMe = (o) => o.greet('world')`).exports
  const obj = { greet(n) { return 'hi ' + n } }
  is(callMe(obj), 'hi world')
})

test('autowire: JS object .prop write goes through __ext_set', async () => {
  const jz = (await import('../index.js')).default
  const { setIt } = jz(`export let setIt = (o, v) => { o.x = v }`).exports
  const o = { x: 0 }
  setIt(o, 42)
  is(o.x, 42)
})
