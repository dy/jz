/** Runtime module autoload rules used by prepare(). */

import { ctx, err, setFeature, verifyEmitIntegrity } from './ctx.js'
import * as mods from '../module/index.js'
import { DERIVED_PROP_MODULES } from './prop-modules.generated.js'

const dict = obj => Object.assign(Object.create(null), obj)

export const MOD_ALIAS = { Number: 'number', Array: 'array', Object: 'object', Symbol: 'symbol', JSON: 'json', Date: 'date', BigInt: 'number', Error: 'core', TextEncoder: 'string', TextDecoder: 'string', Atomics: 'atomics',
  // SIMD intrinsic namespaces (f32x4/i32x4/f64x2/v128) all live in the `simd` module.
  f32x4: 'simd', i32x4: 'simd', f64x2: 'simd', v128: 'simd' }

// Method names below are listed per-property because `includeForProperty` runs
// before value-type inference (prepare() precedes analyze()), so it can't yet
// know whether a given `.prop` receiver will resolve to string/array/typedarray/
// collection — each row lists every module whose `.<mod>:prop` (or generic
// `.prop`) emitter that name could resolve to, so whichever one the runtime
// dispatch fork (tryRuntimePtrTypeFork, emit.js) picks at compile time is
// actually registered. `typedarray` was missing from every method name TYPED
// shares with ARRAY/STRING (agent/typed-decline-b audit, coordinator finding
// for `set` generalized to the rest): a typed array reached ONLY through an
// erased-vt receiver (dyn-prop field, host-provided param — no `new XArray(...)`
// anywhere in source to trigger includeForRuntimeCtor) relied solely on this
// table to pull `typedarray` in, and every one of these rows silently didn't.
//
// This table is now a FLOOR, not the whole story: `includeForProperty` (below)
// consults RESOLVED_PROP_MODULES, this table unioned with the registration-
// derived one (src/prop-modules.generated.js) — see RESOLVED_PROP_MODULES's own
// comment for why union rather than outright replacement. Hand-edit this table
// only for a row with a genuine cross-module stdlib-helper edge the derivation
// can't see (a NEW encodeInto-shaped case — verify by reading the emitter body,
// don't guess); a plain "this module's `.name`/`.kind:name` key is missing"
// fix belongs in the module that owns the key, then `node
// scripts/gen-prop-modules.mjs` picks it up automatically.
export const PROP_MODULES = Object.assign(Object.create(null), {
  push: ['core', 'array'], pop: ['core', 'array'], shift: ['core', 'array'], unshift: ['core', 'array'],
  splice: ['core', 'array'], reverse: ['core', 'array', 'typedarray'], sort: ['core', 'array', 'typedarray'],
  fill: ['core', 'array', 'typedarray'],
  map: ['core', 'array', 'typedarray'], filter: ['core', 'array', 'typedarray'], reduce: ['core', 'array', 'typedarray'],
  reduceRight: ['core', 'array'],
  forEach: ['core', 'array', 'typedarray'], find: ['core', 'array', 'typedarray'], findIndex: ['core', 'array', 'typedarray'],
  findLast: ['core', 'array', 'typedarray'], findLastIndex: ['core', 'array', 'typedarray'],
  every: ['core', 'array', 'typedarray'], some: ['core', 'array', 'typedarray'], flat: ['core', 'array'], flatMap: ['core', 'array'],
  join: ['core', 'array'], copyWithin: ['core', 'array', 'typedarray'], at: ['core', 'string', 'array', 'typedarray'],
  toSorted: ['core', 'array', 'typedarray'], toReversed: ['core', 'array', 'typedarray'], with: ['core', 'array', 'typedarray'],
  charAt: ['core', 'string'], charCodeAt: ['core', 'string'], codePointAt: ['core', 'string'],
  toUpperCase: ['core', 'string'], toLowerCase: ['core', 'string'], toLocaleLowerCase: ['core', 'string'], trim: ['core', 'string'],
  trimStart: ['core', 'string'], trimEnd: ['core', 'string'],
  split: ['core', 'string'], replace: ['core', 'string'], replaceAll: ['core', 'string'],
  repeat: ['core', 'string'], startsWith: ['core', 'string'], endsWith: ['core', 'string'],
  padStart: ['core', 'string'], padEnd: ['core', 'string'], normalize: ['core', 'string'],
  matchAll: ['core', 'string'], match: ['core', 'string'],
  substring: ['core', 'string'], substr: ['core', 'string'],
  add: ['core', 'collection'], clear: ['core', 'collection'],
  // No `.array:set`/generic-array `.set` exists (Array has no `.set`) — only
  // Map (collection) and TypedArray. The dyn-field .set defect this branch
  // fixes (test/array-methods.js) is precisely `.set` on an erased-vt receiver
  // falling to Map.prototype.set for lack of this row.
  set: ['core', 'typedarray', 'collection'],
  slice: ['core', 'string', 'array', 'typedarray'], concat: ['core', 'string', 'array'],
  indexOf: ['core', 'string', 'array', 'typedarray'], lastIndexOf: ['core', 'string', 'array', 'typedarray'],
  includes: ['core', 'string', 'array', 'typedarray'],
  length: ['core', 'string', 'array', 'typedarray', 'collection'],
  toBase64: ['core', 'typedarray', 'string'], toHex: ['core', 'typedarray', 'string'],
  setFromBase64: ['core', 'typedarray', 'string', 'collection'],
  setFromHex: ['core', 'typedarray', 'string', 'collection'],
  encodeInto: ['core', 'string', 'typedarray', 'collection'],
})

// `includeForProperty` consults THIS, not PROP_MODULES directly: PROP_MODULES ∪
// the registration-DERIVED table (src/prop-modules.generated.js — see its own
// header and scripts/gen-prop-modules.mjs for what it is and how it's built).
// Union, not replacement: the derived table is authoritative for "which module
// registers a `.name`/`.kind:name` dispatch key" (it's built by OBSERVING
// registration, not guessing), so it safely ADDS rows PROP_MODULES's hand
// audit missed entirely (e.g. `forEach` on Map/Set, `match`/`replace`/`split`/
// `search`'s regex-side emitters) or never covered (Date/RegExp/DataView
// methods, previously fell through to includeForProperty's broad `else`
// catch-all with no module-specific coverage at all). It is NOT authoritative
// for shrinking an EXISTING PROP_MODULES row, because dispatch-key ownership
// isn't the whole story — a module's emitter body can call another module's
// stdlib helper directly (a MOD_DEPS-shaped edge) without that showing up as
// a ctx.core.emit key at all: `.encodeInto` is owned by `string` alone, but
// its WAT body calls typedarray-owned `__typed_data`/setLinkDemand('typedarray')
// — confirmed by reading module/string.js, not assumed — so the derived row
// for `encodeInto` is `['string']`, silently short of what emission actually
// needs. PROP_MODULES's hand-audited `['string','typedarray','collection']`
// already covers it; union keeps that floor rather than trusting the narrower
// derived row. (MOD_DEPS.typedarray now including 'core' — see MOD_DEPS above
// — closes the analogous, actually-general gap: every derived typedarray-only
// row, e.g. `buffer`/`byteLength`/`subarray`/the DataView accessor family,
// needs core's pointer helpers too, and unlike encodeInto's cross-module edge
// this one CAN be expressed as a plain module dependency.)
// `length` is the one PROP_MODULES row with NO derived counterpart at all —
// module/core.js's `.length` read is dispatched by an inline `emitLengthAccess`
// helper, never a `.length`/`.kind:length` ctx.core.emit key — so it stays
// exactly the hand-audited row (union with `undefined` is a no-op).
//
// byteLength/byteOffset/buffer are DELIBERATELY NOT folded in here (tried it —
// reverted, see test/objects.js's own extensive comment on "fields named like
// TypedArray accessors resolve like any other field"): they're kept OUT of
// this table on purpose so a property read that ISN'T actually a typed array
// (a plain-object field that merely happens to be spelled `buffer`) still
// falls through to includeForProperty's generic catch-all below and gets
// `string`/`collection` — needed for the dyn-prop fallback path's
// `__dyn_get_expr_t_h`/string-literal-key machinery, NOT for any
// typedarray-specific dispatch. Folding them into a precise `['typedarray']`
// row (this table's normal shape) silently dropped that — confirmed by
// re-running this exact test, not assumed. includeForProperty's own hardcoded
// `if` for these three stays, unmodified, ADDITIONAL to (not instead of) the
// catch-all — that non-obvious redundancy is load-bearing, not dead weight.
const unionMods = (a, b) => [...new Set([...(a || []), ...(b || [])])]
export const RESOLVED_PROP_MODULES = (() => {
  const out = Object.create(null)
  // Union of BOTH key sets (re-audit finding 5): iterating only the hand
  // table's keys silently dropped every DERIVED-ONLY row — Date/RegExp/
  // DataView/TypedArray methods the generator attributes but no hand row
  // names (e.g. getDate) never reached includeForProperty at all.
  //
  // DERIVED-ONLY rows additionally keep the CATCH-ALL set (regression
  // 3085bba6, bisected): before the union landed, these 86 names fell
  // through to includeForProperty's generic catch-all, and emit-time
  // hand-built IR sites (buildArrayWithSpreads' '[' node, object.js's 'in'
  // node, 'str' nodes, ...) depended on the catch-all's modules BY
  // ACCIDENT — narrowing to the derived row alone broke them (`m.get(k)
  // .toFixed(2)` → "Unknown op: [", 25-fail blast radius). Superset-of-old
  // semantics restores main to green; the SIZE narrowing returns
  // site-by-site as each hand-built-IR emitter gains its own
  // includeFor*() self-demand (the emitter-owns-dependencies doctrine —
  // buildArrayWithSpreads is the first, 57fa6989).
  const CATCH_ALL = ['object', 'array', 'string', 'collection']
  for (const name of new Set([...Object.keys(PROP_MODULES), ...Object.keys(DERIVED_PROP_MODULES)]))
    out[name] = PROP_MODULES[name] != null
      ? unionMods(PROP_MODULES[name].filter(m => m !== 'core'), DERIVED_PROP_MODULES[name])
      : unionMods(CATCH_ALL, DERIVED_PROP_MODULES[name])
  return out
})()

export const OP_MODULES = {
  '?.': ['core', 'string', 'collection'],
  '?.[]': ['core', 'array', 'collection'],
  '?.()': ['core', 'fn'],
  'u+': ['number', 'string'],
  'in': ['core', 'collection', 'string'],
  '==': ['core', 'string'],
  '!=': ['core', 'string'],
  '===': ['core', 'string'],
  '!==': ['core', 'string'],
  'typeof': ['core', 'string'],
  '[': ['core', 'array'],
  '{': ['core', 'object', 'string', 'collection'],
  'delete': ['core', 'collection', 'string'],
  '//': ['core', 'string', 'regex'],
  '**': ['math'],
  '**=': ['math'],  // desugars to `name = name ** val` at emit — needs the same module
}

export const TYPED_CTORS = ['Float64Array','Float32Array','Float16Array','Int32Array','Uint32Array','Int16Array','Uint16Array','Int8Array','Uint8Array','Uint8ClampedArray','BigInt64Array','BigUint64Array','ArrayBuffer','DataView']

export const CALL_MODULES = dict({
  ArrayBuffer: ['core', 'typedarray'],
  DataView: ['core', 'typedarray'],
  BigInt64Array: ['core', 'typedarray'],
  BigUint64Array: ['core', 'typedarray'],
  parseFloat: ['number', 'string'],
  parseInt: ['number', 'string'],
  encodeURIComponent: ['core', 'string', 'number'],
  decodeURIComponent: ['core', 'string', 'number'],
  encodeURI: ['core', 'string', 'number'],
  decodeURI: ['core', 'string', 'number'],
  String: ['core', 'string', 'number'],
  Number: ['number', 'string'],
  Boolean: ['number'],
  TextEncoder: ['core', 'string'],
  TextDecoder: ['core', 'string'],
  Error: ['core', 'string'],
  BigInt: ['number'],
  'console.log': ['core', 'string', 'number', 'console'],
  'console.warn': ['core', 'string', 'number', 'console'],
  'console.error': ['core', 'string', 'number', 'console'],
  'console.info': ['core', 'string', 'number', 'console'],
  'console.debug': ['core', 'string', 'number', 'console'],
  'Object.fromEntries': ['core', 'object', 'collection', 'string'],
  'Object.keys': ['core', 'object', 'string'],
  'Object.getOwnPropertyNames': ['core', 'object', 'string'],
  'Object.values': ['core', 'object', 'string'],
  'Object.entries': ['core', 'object', 'string'],
  'Object.hasOwn': ['core', 'object', 'string', 'collection'],
  'Object.groupBy': ['core', 'collection', 'object', 'string', 'array', 'fn'],
  'Map.groupBy': ['core', 'collection', 'array', 'fn'],
  'RegExp.escape': ['core', 'string', 'regex'],
  structuredClone: ['core', 'collection', 'array'],
  'Atomics.load': ['core', 'typedarray', 'atomics'],
  'Atomics.store': ['core', 'typedarray', 'atomics'],
  'Atomics.add': ['core', 'typedarray', 'atomics'],
  'Atomics.sub': ['core', 'typedarray', 'atomics'],
  'Atomics.and': ['core', 'typedarray', 'atomics'],
  'Atomics.or': ['core', 'typedarray', 'atomics'],
  'Atomics.xor': ['core', 'typedarray', 'atomics'],
  'Atomics.exchange': ['core', 'typedarray', 'atomics'],
  'Atomics.compareExchange': ['core', 'typedarray', 'atomics'],
  'Atomics.notify': ['core', 'typedarray', 'atomics'],
  'Atomics.isLockFree': ['core', 'typedarray', 'atomics'],
  'Atomics.wait': ['core', 'typedarray', 'atomics', 'number', 'string'],
  'Object.freeze': ['core', 'object'],
  'Object.assign': ['core', 'object'],
  'Object.create': ['core', 'object'],
  'Object.defineProperty': ['core', 'object'],
  '__object_toString': ['core', 'object', 'string'],
  'Date.UTC': ['core', 'date'],
  'Date.parse': ['core', 'date'],
  'Date.now': ['core', 'console'],
  'performance.now': ['core', 'console'],
  'readStdin': ['core', 'console'],
  'fs.read': ['core', 'string', 'fs'],
  'fetch': ['core', 'web'],
  'fs.write': ['core', 'string', 'fs'],
  'String.fromCharCode': ['core', 'string'],
  'String.fromCodePoint': ['core', 'string'],
  'Uint8Array.fromBase64': ['core', 'typedarray', 'string'],
  'Uint8Array.fromHex': ['core', 'typedarray', 'string'],
  atob: ['core', 'string'],
  btoa: ['core', 'string'],
  'crypto.getRandomValues': ['core', 'typedarray', 'crypto'],
  'crypto.randomUUID': ['core', 'string', 'crypto'],
  'BigInt.asIntN': ['number'],
  'BigInt.asUintN': ['number'],
  ...Object.fromEntries(TYPED_CTORS.filter(n => n.endsWith('Array')).map(n => [`${n}.from`, ['core', 'typedarray', 'array']])),
  'Array.of': ['core', 'array'],
  'ArrayBuffer.isView': ['core', 'typedarray'],
  // instanceof Map / Set / TypedArray predicates (synthesized by jzify).
  '__is_map': ['core', 'collection'],
  '__is_set': ['core', 'collection'],
  '__is_typed': ['core', 'typedarray'],
})

export const GENERIC_METHOD_MODULES = dict({
  toString: ['core', 'string', 'number'],
  toFixed: ['core', 'string', 'number'],
  toPrecision: ['core', 'string', 'number'],
  toExponential: ['core', 'string', 'number'],
  hasOwnProperty: ['core', 'object', 'string', 'collection'],
})

export const CTORS = ['Float64Array','Float32Array','Float16Array','Int32Array','Uint32Array','Int16Array','Uint16Array','Int8Array','Uint8Array','Uint8ClampedArray','BigInt64Array','BigUint64Array','Set','Map','WeakSet','WeakMap','Date']
// WeakSet/WeakMap fold to Set/Map (the `new` handler rewrites the ctor name).
// jz has no GC, so weakness is unobservable; this also accepts primitive keys
// (real WeakMap throws TypeError) and exposes `.size`/iteration — a deliberate
// semantic deviation documented in README. Compilers lean on them as identity
// caches / cycle-detection sets and never observe the missing weak semantics.
export const COLLECTION_CTORS = ['Set', 'Map', 'WeakSet', 'WeakMap']
export const TIMER_NAMES = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'])

const MOD_DEPS = {
  number: ['core', 'string'],
  crypto: ['core'],
  navigator: ['core'],
  atomics: ['core', 'typedarray'],
  string: ['core', 'number'],
  array: ['core'],
  object: ['core'],
  collection: ['core', 'number'],
  symbol: ['core'],
  json: ['core', 'string', 'number', 'collection'],
  date: ['core', 'number', 'string'],
  console: ['core', 'string', 'number'],
  regex: ['core', 'string', 'array'],
  // f64x2.sin/cos lower to math's $math.sin2/$math.cos2 WAT helpers; pull math in so
  // they're registered. Unused math helpers are pruned by reachability — no output cost.
  simd: ['math'],
  // typedarray's own emitters (`.byteLength`/`.buffer`/`.typed:*`/DataView get*/set*)
  // call CORE-owned pointer/alloc helpers (__ptr_type, __ptr_offset, __ptr_aux,
  // __mkptr) directly in their WAT bodies — a real edge, just never expressed here:
  // every PROP_MODULES row that lists 'typedarray' happened to ALSO always list
  // 'array' or 'string' or 'collection' (all of which already chain to 'core'), so
  // the gap was masked by coincidence, not closed. src/prop-modules.generated.js's
  // derived rows for typedarray-only properties (buffer/byteLength/byteOffset, the
  // DataView accessor family, subarray) have no such accompanying module — this
  // entry is the actual, general fix (root cause, not per-row patching).
  typedarray: ['core'],
}

// `onRegister(modName, newKeys)` is an OPTIONAL build-time-only observation hook —
// every real call site passes just `name`, so `onRegister` is `undefined` and the
// `before`/diff line below never runs (one falsy check, no cost). scripts/
// gen-prop-modules.mjs is the sole caller that supplies it: it drives every module
// through here once (host-side, plain Node, never part of the self-compiled
// surface) and diffs `Object.keys(ctx.core.emit)` around EACH module's own
// `init(ctx)` call (including ones reached only via the MOD_DEPS loop below) to
// attribute every `.method`/`.kind:method` dispatch key it registers to the module
// that registered it — the authoritative source for src/prop-modules.generated.js,
// replacing hand-typed guesses. Scoping the diff to THIS call's own before/after
// window (not the caller's) is why circular MOD_DEPS pairs (e.g. string↔number)
// still attribute correctly: a dep pulled in via the loop below finishes its own
// registration (and its own onRegister callback) before this module's `before`
// snapshot is even taken, so the dep's keys are already in `before` and never
// double-counted here.
export function includeModule(name, onRegister) {
  const modName = MOD_ALIAS[name] || name
  const init = mods[modName]
  if (!init) return err(`Module not found: ${name}`)
  if (ctx.module.modules[modName]) return
  ctx.module.modules[modName] = true
  for (const dep of MOD_DEPS[modName] || []) includeModule(dep, onRegister)
  // Stdlib registration two-dialect gate (CONTRIBUTING "Stdlib registration"):
  // reg()/registerGetter()/bind() guard their OWN flat-key write (src/ctx.js
  // registerName), but can't see a LATER raw `ctx.core.emit[name] = …`
  // assignment inside this module's init(ctx) silently clobbering one of
  // them — that needs checking AFTER init(ctx) runs, once its raw
  // assignments (if any) have already landed. ctx.core.emit only — see
  // verifyEmitIntegrity's doc comment for why ctx.core.stdlib/wat() isn't
  // symmetric here.
  ctx.core.currentModule = modName
  const before = onRegister ? new Set(Object.keys(ctx.core.emit)) : null
  init(ctx)
  if (onRegister) onRegister(modName, Object.keys(ctx.core.emit).filter(k => !before.has(k)))
  verifyEmitIntegrity(ctx.core.emit, ctx.core.regEmitOrder, ctx.core.regEmitDialect, ctx.core.regEmitModule, ctx.core.regEmitValue)
}

export const hasModule = name => Boolean(mods[MOD_ALIAS[name] || name])

// NOT `names.forEach(includeModule)`: Array#forEach's callback receives
// `(element, index, array)` — with includeModule's 2nd param now meaningful
// (the onRegister observation hook), the bare index leaked through as a
// truthy-but-uncallable "onRegister" for every 2nd+ module in a call
// (`includeMods('core','array','typedarray')` crashed on 'array' with
// "onRegister is not a function" — the classic `.forEach(parseInt)` footgun).
export const includeMods = (...names) => names.forEach(name => includeModule(name))

export const includeForOp = op => {
  const modules = OP_MODULES[op]
  if (!modules) return false
  includeMods(...modules)
  return true
}

export const includeForCallableValue = () => includeMods('core', 'fn')
export const includeForNumericCoercion = () => includeMods('number', 'string')
export const includeForStringValue = () => includeMods('core', 'string', 'number')
export const includeForStringOnly = () => includeMods('core', 'string')
export const includeForArrayLiteral = () => includeMods('core', 'array')
export const includeForArrayAccess = () => includeMods('core', 'array', 'collection')
export const includeForArrayPattern = includeForArrayAccess
export const includeForObjectLiteral = () => includeMods('core', 'object')
export const includeForObjectPattern = () => includeMods('core', 'object', 'string', 'collection')
export const includeForKnownKeyIteration = includeForStringOnly
export const includeForRuntimeKeyIteration = () => includeMods('core', 'string', 'collection')
export const includeForTimerRuntime = () => {
  setFeature('timers', true)
  includeModule('timer')
  includeModule('fn')
}

export const includeForNamedCall = callee => {
  const modules = CALL_MODULES[callee]
  if (!modules) return false
  includeMods(...modules)
  return true
}

export const includeForGenericMethod = prop => {
  const modules = GENERIC_METHOD_MODULES[prop]
  if (!modules) return false
  includeMods(...modules)
  return true
}

export const includeForProperty = prop => {
  // Deliberately NOT part of RESOLVED_PROP_MODULES — see that table's own
  // comment. Additional to, not instead of, the catch-all below.
  if (prop === 'byteLength' || prop === 'byteOffset' || prop === 'buffer') includeMods('core', 'typedarray')
  if (typeof prop === 'string' && RESOLVED_PROP_MODULES[prop]) includeMods(...RESOLVED_PROP_MODULES[prop])
  else includeMods('core', 'object', 'array', 'string', 'collection')
}

export const runtimeCtorKind = name =>
  TYPED_CTORS.includes(name) ? 'typedarray' : COLLECTION_CTORS.includes(name) ? 'collection' : name === 'Date' ? 'date' : name === 'Array' ? 'array' : null

export const includeForRuntimeCtor = name => {
  const kind = runtimeCtorKind(name)
  if (kind === 'typedarray') includeMods('core', 'typedarray')
  else if (kind === 'collection') includeMods('core', 'collection')
  else if (kind === 'date') includeMods('core', 'console', 'date')
  else if (kind === 'array') includeMods('core', 'array')
  return kind
}
