/**
 * Stdlib module bridge — `module/*` imports from here, not `src/emit.js`.
 *
 * Emit impls bind on `ctx.lib` at reset(). Registration helpers (`reg`,
 * `edges`, …) keep handler + WAT include edges in one place.
 *
 * @module lib
 */

import { ctx, emitter } from './ctx.js'
import { typed, asF64, asI32, asI64 } from './ir.js'

export { emitter } from './ctx.js'

export const emit = (...args) => ctx.lib.emit(...args)
export const emitFlat = (...args) => ctx.lib.emitFlat(...args)
export const emitBody = (...args) => ctx.lib.emitBody(...args)
export const emitBoolStr = (...args) => ctx.lib.emitBoolStr(...args)
export const emitIndex = (...args) => ctx.lib.emitIndex(...args)
export const buildArrayWithSpreads = (...args) => ctx.lib.buildArrayWithSpreads(...args)

/** `ctx.core.emit[name] = emitter(deps, fn)`. `deps` = WAT stdlib names; `[]` for host-import wiring. */
export const reg = (name, deps, fn) => {
  const h = emitter(deps, fn)
  ctx.core.emit[name] = h
  return h
}

/** WAT stdlib→stdlib edges for `resolveIncludes()`. */
export const edges = (map) => Object.assign(ctx.core.stdlibDeps, map)

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

const K = { I: asI64, F: asF64, i: asI32 }

const args = (sig, nodes) =>
  sig.split('').map((c, i) => K[c](emit(nodes[i])))

const wrap = (fmt, call) => {
  if (fmt === 'i64') return typed(['f64.reinterpret_i64', call], 'f64')
  if (fmt === 'i32') return typed(['f64.convert_i32_s', call], 'f64')
  return typed(call, 'f64')
}

/** `(…args) → call($stdlib, coerced…)`. fmt: f64 · i64 · i32 */
export const call = (stdlib, sig, fmt = 'f64') => {
  const h = emitter([stdlib], (...nodes) =>
    wrap(fmt, ['call', `$${stdlib}`, ...args(sig, nodes)]))
  Object.defineProperty(h, 'length', { value: sig.length, configurable: true })
  return h
}

/** method `(recv, …args) → call($stdlib, …)`. sig: I · F · i per arg. */
export const method = (stdlib, sig, ret = 'f64') => {
  const h = emitter([stdlib], (...nodes) => {
    const c = ['call', `$${stdlib}`, ...args(sig, nodes)]
    return typed(ret === 'i32' ? ['f64.convert_i32_s', c] : c, 'f64')
  })
  Object.defineProperty(h, 'length', { value: sig.length, configurable: true })
  return h
}
