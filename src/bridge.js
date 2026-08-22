/**
 * Stdlib module bridge — `module/*` imports from here, not `src/compile/emit.js`.
 *
 * Emit impls bind on `ctx.bridge` at reset(). Registration: `wat(name, body)`
 * for WAT stdlib, `reg(name, deps, fn)` for emit, or `reg(name, { deps, wat, emit })`
 * to co-register both. `method`/`call` remain sugar for simple `$stdlib` calls.
 *
 * @module bridge
 */

import { ctx, emitter, registerName } from './ctx.js'
import { typed, asF64, asI32, asI64, applyBigintRepresentationAction, bigintEraseErr, bigintStrict, carrierF64, carrierF64Narrow } from './ir.js'
import { REP_EDGE_BOX, REP_EDGE_REJECT, representationStorageWriteAction } from './compile/representation-plan.js'
import { hasAmbiguousBoolMerge, valTypeOf } from './kind.js'
import { VAL } from './reps.js'

export { emitter } from './ctx.js'

export const emit = (...a) => ctx.bridge.emit(...a)
// Identity-safe re-emission of an ambiguous BOOL-merge node (kind.js
// hasAmbiguousBoolMerge, .work/todo.md §deletion-sweep) — the
// escape-site twin of `emit` for consumers (container/closure-arg boxing)
// that need a merge's own BOOL arm to keep its atom identity. Bridged the
// same way `emit` is (module/*.js and emit-assign.js can't import emit.js
// directly — the acyclic bridge indirection) — bound alongside it at reset().
export const emitIdentitySafe = (...a) => ctx.bridge.emitIdentitySafe(...a)

// THE represented-carrier chokepoint (research.md §Carrier invariant, "Decision:
// box-at-production via ONE producer chokepoint") — the single sound producer
// for any BOXED-VALUE storage position (array/object/Map/Set element, closure
// arg, stdlib 'I' slot): emit ONCE, before branching on hasAmbiguousBoolMerge.
// A raw `carrierF64(node, emit(node))` is post-hoc powerless for an ambiguous
// BOOL∪NUMBER merge (`cond && 1`, `cond ? 1 : false`) — the merge's own
// valTypeOf already collapsed to NUMBER, so carrierF64 never recognizes it as
// BOOL-carrying; by the time a plain `emit(node)` result exists, the coerced
// false and a genuine 0 are the same bits. emitIdentitySafe re-emits the
// merge with its own BOOL arm boxed to its atom BEFORE that collapse.
// Previously hand-reimplemented (the unsound half only) at 16 raw call sites
// across module/array.js, module/collection.js, module/object.js (a local,
// unguarded clone), module/function.js — this promotion is the fix (MECHANISM
// A). Formerly local to src/compile/emit-assign.js:42 (the same pattern
// module/*.js already bridges emit/emitIdentitySafe through).
const storedValueLegacy = node => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : carrierF64(node, emit(node))

/** Plan-driven BigInt twin for tagged ABI slots; BOOL handling stays exactly
 * on storedValue's established path when no BigInt transform is selected. */
export const storedValuePlanned = (node, action) => {
  if (bigintStrict() && action === REP_EDGE_BOX)
    bigintEraseErr('collection', typeof node === 'string' ? node : 'this expression')
  if (hasAmbiguousBoolMerge(node)) return emitIdentitySafe(node)
  const emitted = emit(node)
  if (valTypeOf(node) === VAL.BOOL) return carrierF64(node, emitted)
  return asF64(applyBigintRepresentationAction(emitted, node, action))
}

export const storedValue = node => {
  const action = representationStorageWriteAction(ctx, node)
  return action === REP_EDGE_REJECT ? storedValueLegacy(node) : storedValuePlanned(node, action)
}

// Narrow-admission twin of storedValue — same single-emission/BOOL-identity
// discipline, but routes the non-ambiguous fallback through carrierF64Narrow
// (ir.js) instead of carrierF64: for a genuinely non-dynamic boxed-value slot
// (SRoA flat-object/array field storage — no heap allocation, every read/
// write rewritten to a plain local, no registry-aware dynamic reader ever
// observes it) where carrierF64's unconditional inline-BIGINT fallback boxes
// a value nothing downstream knows to unbox. See carrierF64Narrow's own doc
// comment for the two call sites and the live incident that found this gap.
export const storedValueNarrow = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : carrierF64Narrow(node, emit(node))

// Non-boxing twin of storedValue: for positions guarded by a static-kind-
// driven fast path downstream (an i32-PROVEN emit shortcut, a typeof-operand
// switch) that must keep firing unmodified for the overwhelmingly common
// non-ambiguous case — the non-ambiguous branch is byte-identical to a plain
// `emit(node)`. Reinvented inline at src/compile/emit.js:1176 (that file owns
// emit/emitIdentitySafe directly, no bridge round-trip needed there) and at
// module/core.js's typeof operand — this is the bridged copy for module/*.js
// consumers (.work/todo.md §deletion-sweep).
export const argIR = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : emit(node)

export const flat = (...a) => ctx.bridge.flat(...a)
export const body = (...a) => ctx.bridge.body(...a)
export const bool = (...a) => ctx.bridge.bool(...a)
/** Index expr → i32 IR. */
export const idx = (...a) => ctx.bridge.idx(...a)
export const spread = (...a) => ctx.bridge.spread(...a)

/** Attach a pre-built handler (e.g. from method/emitter) to ctx.core.emit.
 *  Sugar for the DEFAULT dialect (CONTRIBUTING "Stdlib registration"), not
 *  the structured reg()/wat() one — but a FLAT key (no `:`) still goes
 *  through registerName's same guarded write as reg()/wat()/registerGetter,
 *  and throws on collision. This used to be a bare `ctx.core.emit[name] =
 *  handler`, deliberately unguarded, on the theory that a later, more
 *  specific module shadowing an earlier generic default (e.g. date.js's
 *  Date-specific `.valueOf` over string.js's generic Object.prototype
 *  fallback) was a load-bearing specialization idiom. It wasn't: that exact
 *  pair WAS the bug (.work/printer-trio.md) — date.js's handler is only
 *  correct for a PROVEN Date receiver, but the flat `.valueOf` key is the
 *  fallback for every UNRESOLVED-type receiver, so the "override" silently
 *  broke `.valueOf()` on every array/object/map/set whose static type
 *  wasn't proven. A flat key has exactly one legitimate owner; two bind()
 *  (or bind()-vs-raw) writers for the same flat name is always a mistake,
 *  same as two reg() writers. Type-qualified keys (`.date:valueOf`,
 *  `.string:padStart`, …) stay unguarded — namespaced by design, one
 *  physical owner (the type's own module) per key, so cross-module
 *  collision there isn't a realistic hazard the way a shared flat name is.
 *  A raw (non-bind) assignment clobbering a bind()-registered flat key is
 *  still only catchable post-hoc — `verifyEmitIntegrity` (src/ctx.js),
 *  after every module's init(ctx) (src/autoload.js includeModule), which is
 *  mechanism-agnostic: it flags the protected name being overwritten
 *  regardless of whether a raw assignment or a bind()/reg() call did it. */
export const bind = (name, handler) => {
  if (name.includes(':')) { ctx.core.emit[name] = handler; return handler }
  registerName(ctx.core.emit, ctx.core.regEmitOrder, ctx.core.regEmitDialect, ctx.core.regEmitModule, ctx.core.regEmitValue, name, 'bind', handler)
  return handler
}

/** Register a host import once, idempotent on (module, name). Stdlib modules
 *  call this from each use site without re-adding the env/wasi import. */
export const hostImport = (mod, name, fn) => {
  if (ctx.module.imports.some(i => i[1] === `"${mod}"` && i[2] === `"${name}"`)) return
  ctx.module.imports.push(['import', `"${mod}"`, `"${name}"`, fn])
}

/** WAT stdlib→stdlib deps for `resolveIncludes()`. */
export const deps = (map) => Object.assign(ctx.core.stdlibDeps, map)

/** WAT stdlib body (+ optional deps edge for resolveIncludes). */
export const wat = (name, body, depNames = []) => {
  registerName(ctx.core.stdlib, ctx.core.regStdlibOrder, ctx.core.regStdlibDialect, ctx.core.regStdlibModule, ctx.core.regStdlibValue, name, 'wat', body)
  if (depNames.length) deps({ [name]: depNames })
}

/** Emit handler; optionally co-register WAT when `depsOrOpts.wat` is set.
 *  reg(name, deps, fn) — emit only
 *  reg(name, { deps, wat, emit }) — WAT key inferred from first `__…` dep
 *  reg(name, { watKey, deps, wat, emit }) — explicit WAT key when deps differ */
export const reg = (name, depsOrOpts, maybeFn) => {
  if (typeof depsOrOpts === 'object' && depsOrOpts !== null && !Array.isArray(depsOrOpts)) {
    const o = depsOrOpts
    const depsList = o.deps ?? []
    if (o.wat) {
      const watKey = o.watKey ?? depsList.find(d => d.startsWith('__')) ?? name
      wat(watKey, o.wat, o.watDeps ?? [])
    }
    if (o.emit) {
      const h = emitter(depsList, o.emit)
      registerName(ctx.core.emit, ctx.core.regEmitOrder, ctx.core.regEmitDialect, ctx.core.regEmitModule, ctx.core.regEmitValue, name, 'reg', h)
      return h
    }
    return
  }
  const h = emitter(depsOrOpts, maybeFn)
  registerName(ctx.core.emit, ctx.core.regEmitOrder, ctx.core.regEmitDialect, ctx.core.regEmitModule, ctx.core.regEmitValue, name, 'reg', h)
  return h
}

/** Tag a hand-wrapped handler with `.deps` (pow/** dual lowering). */
export const tag = (handler, deps) => {
  handler.deps = deps
  return handler
}

/** `fast(firstArg)` → `core`, else `wrap`. Keeps wrap `.deps`. */
export const dual = (wrap, core, fast) => {
  const h = (a, ...rest) => (fast(a) ? core(a, ...rest) : wrap(a, ...rest))
  h.deps = wrap.deps
  h.argc = wrap.argc ?? wrap.length
  return h
}

const cast = { I: asI64, F: asF64, i: asI32 }

// 'I' is the boxed-value slot (receivers, collection keys/values) — a boolean
// crosses it as its TRUE/FALSE atom so identity survives the container round-trip
// (typeof / String / strict-eq); 'F'/'i' are numeric positions and stay raw.
// storedValue (not a raw carrierF64(emit)): a 17th site of the same MECHANISM
// A gap the design's 16-site enumeration didn't name (it lives in this file,
// not module/array|collection|object|function.js) — found while promoting
// the chokepoint here. An ambiguous BOOL∪NUMBER merge (`cond && 1`) passed as
// an 'I'-sig stdlib arg (any `call()`/`method()` registration) collapsed the
// same way the 16 named sites did.
const coerce = (sig, nodes) =>
  sig.split('').map((c, i) => c === 'I'
    ? asI64(storedValue(nodes[i]))
    : cast[c](emit(nodes[i])))

const wrap = (fmt, call) => {
  if (fmt === 'i64') return typed(['f64.reinterpret_i64', call], 'f64')
  if (fmt === 'i32') return typed(['f64.convert_i32_s', call], 'f64')
  return typed(call, 'f64')
}

/** `(…args) → call($stdlib, coerced…)`. fmt: f64 · i64 · i32 */
export const call = (stdlib, sig, fmt = 'f64') => {
  const h = emitter([stdlib], (...nodes) =>
    wrap(fmt, ['call', `$${stdlib}`, ...coerce(sig, nodes)]))
  h.argc = sig.length
  return h
}

/** method `(recv, …args) → call($stdlib, …)`. sig: I · F · i per arg. */
export const method = (stdlib, sig, ret = 'f64') => {
  const h = emitter([stdlib], (...nodes) => {
    const c = ['call', `$${stdlib}`, ...coerce(sig, nodes)]
    return typed(ret === 'i32' ? ['f64.convert_i32_s', c] : c, 'f64')
  })
  h.argc = sig.length
  return h
}
