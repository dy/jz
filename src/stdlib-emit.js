/**
 * Stdlib → compiler codegen bridge.
 *
 * Language modules (`module/*`) import emit helpers from here only — not
 * `src/emit.js`. Implementations are bound on `ctx.stdlibEmit` at reset();
 * this file imports `ctx.js` alone so the stdlib module graph does not pull
 * the analyzer in at load time. Static imports only (metacircular-safe).
 *
 * @module stdlib-emit
 */

import { ctx } from './ctx.js'

export const emit = (...args) => ctx.stdlibEmit.emit(...args)
export const emitFlat = (...args) => ctx.stdlibEmit.emitFlat(...args)
export const emitBody = (...args) => ctx.stdlibEmit.emitBody(...args)
export const emitBoolStr = (...args) => ctx.stdlibEmit.emitBoolStr(...args)
export const emitIndex = (...args) => ctx.stdlibEmit.emitIndex(...args)
export const buildArrayWithSpreads = (...args) => ctx.stdlibEmit.buildArrayWithSpreads(...args)
