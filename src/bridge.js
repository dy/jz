/**
 * Stdlib module bridge — `module/*` imports from here, not `src/emit.js`.
 *
 * Emit impls bind on `ctx.bridge` at reset(). Registration: `wat(name, body)`
 * for WAT stdlib, `reg(name, deps, fn)` for emit, or `reg(name, { deps, wat, emit })`
 * to co-register both. `method`/`call` remain sugar for simple `$stdlib` calls.
 *
 * @module bridge
 */

import { ctx, emitter } from './ctx.js'
import { typed, asF64, asI32, asI64 } from './ir.js'

export { emitter } from './ctx.js'

export const emit = (...a) => ctx.bridge.emit(...a)
export const flat = (...a) => ctx.bridge.flat(...a)
export const body = (...a) => ctx.bridge.body(...a)
export const bool = (...a) => ctx.bridge.bool(...a)
/** Index expr → i32 IR. */
export const idx = (...a) => ctx.bridge.idx(...a)
export const spread = (...a) => ctx.bridge.spread(...a)

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
  Object.defineProperty(h, 'length', { value: wrap.length, configurable: true })
  return h
}

const cast = { I: asI64, F: asF64, i: asI32 }

const coerce = (sig, nodes) =>
  sig.split('').map((c, i) => cast[c](emit(nodes[i])))

const wrap = (fmt, call) => {
  if (fmt === 'i64') return typed(['f64.reinterpret_i64', call], 'f64')
  if (fmt === 'i32') return typed(['f64.convert_i32_s', call], 'f64')
  return typed(call, 'f64')
}

/** `(…args) → call($stdlib, coerced…)`. fmt: f64 · i64 · i32 */
export const call = (stdlib, sig, fmt = 'f64') => {
  const h = emitter([stdlib], (...nodes) =>
    wrap(fmt, ['call', `$${stdlib}`, ...coerce(sig, nodes)]))
  Object.defineProperty(h, 'length', { value: sig.length, configurable: true })
  return h
}

/** method `(recv, …args) → call($stdlib, …)`. sig: I · F · i per arg. */
export const method = (stdlib, sig, ret = 'f64') => {
  const h = emitter([stdlib], (...nodes) => {
    const c = ['call', `$${stdlib}`, ...coerce(sig, nodes)]
    return typed(ret === 'i32' ? ['f64.convert_i32_s', c] : c, 'f64')
  })
  Object.defineProperty(h, 'length', { value: sig.length, configurable: true })
  return h
}
