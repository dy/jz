/**
 * Stdlib → compiler codegen bridge.
 *
 * Language modules (`module/*`) import emit helpers from here only — not
 * `src/emit.js`. Implementations are bound on `ctx.stdlibEmit` at reset().
 * Also hosts stdlib registration helpers (`regEmit`, `watDeps`, …) so modules
 * declare emit handlers and WAT include edges in one place. Imports `ir.js`
 * for coercion helpers only — cycle-free w.r.t. the analyzer.
 *
 * @module stdlib-emit
 */

import { ctx, emitter } from './ctx.js'
import { typed, asF64, asI32, asI64 } from './ir.js'

export { emitter } from './ctx.js'

export const emit = (...args) => ctx.stdlibEmit.emit(...args)
export const emitFlat = (...args) => ctx.stdlibEmit.emitFlat(...args)
export const emitBody = (...args) => ctx.stdlibEmit.emitBody(...args)
export const emitBoolStr = (...args) => ctx.stdlibEmit.emitBoolStr(...args)
export const emitIndex = (...args) => ctx.stdlibEmit.emitIndex(...args)
export const buildArrayWithSpreads = (...args) => ctx.stdlibEmit.buildArrayWithSpreads(...args)

/** Register `ctx.core.emit[name] = emitter(deps, fn)`. `deps` are WAT stdlib names (via `inc`), not host imports — use `[]` when a helper like `needNow()` wires imports separately. */
export const regEmit = (name, deps, fn) => {
  const h = emitter(deps, fn)
  ctx.core.emit[name] = h
  return h
}

/** Record WAT stdlib→stdlib edges for transitive `resolveIncludes()`. */
export const watDeps = (edges) => Object.assign(ctx.core.stdlibDeps, edges)

/** Attach `.deps` metadata to a hand-wrapped handler (pow/** dual lowering). */
export const attachDeps = (handler, deps) => {
  handler.deps = deps
  return handler
}

/** Fast-path route: `fast(firstArg)` → `core`, else `wrap`. Preserves wrap `.deps`. */
export const dualCall = (wrap, core, fast) => {
  const h = (a, ...rest) => (fast(a) ? core(a, ...rest) : wrap(a, ...rest))
  h.deps = wrap.deps
  Object.defineProperty(h, 'length', { value: wrap.length, configurable: true })
  return h
}

const COERCE = { I: asI64, F: asF64, i: asI32 }

const coerceArgs = (coerce, nodes) =>
  coerce.split('').map((c, i) => COERCE[c](emit(nodes[i])))

const wrapCall = (fmt, call) => {
  if (fmt === 'i64') return typed(['f64.reinterpret_i64', call], 'f64')
  if (fmt === 'i32') return typed(['f64.convert_i32_s', call], 'f64')
  return typed(call, 'f64')
}

/** Factory: `(…args) → call($stdlib, coerced…)`. fmt: f64 · i64 · i32 */
export const stdlibCall = (stdlib, coerce, fmt = 'f64') => {
  const h = emitter([stdlib], (...nodes) =>
    wrapCall(fmt, ['call', `$${stdlib}`, ...coerceArgs(coerce, nodes)]))
  // Method emitters (arity ≥ 2) must not satisfy the property-read gate in
  // core.js (`propEmitter.length <= 1`) — rest-param fns report length 0.
  Object.defineProperty(h, 'length', { value: coerce.length, configurable: true })
  return h
}

/** Factory: method `(recv, …args) → call($stdlib, coerced…)`. Coerce: I · F · i per arg. */
export const stdlibMethod = (stdlib, coerce, ret = 'f64') => {
  const h = emitter([stdlib], (...nodes) => {
    const c = ['call', `$${stdlib}`, ...coerceArgs(coerce, nodes)]
    return typed(ret === 'i32' ? ['f64.convert_i32_s', c] : c, 'f64')
  })
  Object.defineProperty(h, 'length', { value: coerce.length, configurable: true })
  return h
}
