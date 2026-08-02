/**
 * Stdlib module bridge — `module/*` imports from here, not `src/compile/emit.js`.
 *
 * Emit impls bind on `ctx.bridge` at reset(). Registration: `wat(name, body)`
 * for WAT stdlib, `reg(name, deps, fn)` for emit, or `reg(name, { deps, wat, emit })`
 * to co-register both. `method`/`call` remain sugar for simple `$stdlib` calls.
 *
 * @module bridge
 */

import { ctx, emitter } from './ctx.js'
import { typed, asF64, asI32, asI64, carrierF64 } from './ir.js'
import { hasAmbiguousBoolMerge } from './kind.js'

export { emitter } from './ctx.js'

export const emit = (...a) => ctx.bridge.emit(...a)
// Identity-safe re-emission of an ambiguous BOOL-merge node (kind.js
// hasAmbiguousBoolMerge, .work/bool-merge-identity-design.md) — the
// escape-site twin of `emit` for consumers (container/closure-arg boxing)
// that need a merge's own BOOL arm to keep its atom identity. Bridged the
// same way `emit` is (module/*.js and emit-assign.js can't import emit.js
// directly — the acyclic bridge indirection) — bound alongside it at reset().
export const emitIdentitySafe = (...a) => ctx.bridge.emitIdentitySafe(...a)

// THE represented-carrier chokepoint (carrier-invariant-design.md, "Decision:
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
export const storedValue = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : carrierF64(node, emit(node))

// Non-boxing twin of storedValue: for positions guarded by a static-kind-
// driven fast path downstream (an i32-PROVEN emit shortcut, a typeof-operand
// switch) that must keep firing unmodified for the overwhelmingly common
// non-ambiguous case — the non-ambiguous branch is byte-identical to a plain
// `emit(node)`. Reinvented inline at src/compile/emit.js:1176 (that file owns
// emit/emitIdentitySafe directly, no bridge round-trip needed there) and at
// module/core.js's typeof operand — this is the bridged copy for module/*.js
// consumers (formatter-dispatch-design.md).
export const argIR = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : emit(node)

export const flat = (...a) => ctx.bridge.flat(...a)
export const body = (...a) => ctx.bridge.body(...a)
export const bool = (...a) => ctx.bridge.bool(...a)
/** Index expr → i32 IR. */
export const idx = (...a) => ctx.bridge.idx(...a)
export const spread = (...a) => ctx.bridge.spread(...a)

/** Attach a pre-built handler (e.g. from method/emitter) to ctx.core.emit. */
export const bind = (name, handler) => {
  ctx.core.emit[name] = handler
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
  ctx.core.stdlib[name] = body
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
      ctx.core.emit[name] = h
      return h
    }
    return
  }
  const h = emitter(depsOrOpts, maybeFn)
  ctx.core.emit[name] = h
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
