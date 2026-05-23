/**
 * Stdlib emit accessors — delegates to ctx.stdlibEmit (bound at compile reset).
 *
 * Keeps language modules off src/emit.js so they do not pull the analyzer in
 * at import time. Static imports only (metacircular / self-host friendly).
 *
 * @module module/emit
 */

import { ctx } from '../src/ctx.js'

export const emit = (...args) => ctx.stdlibEmit.emit(...args)
export const emitFlat = (...args) => ctx.stdlibEmit.emitFlat(...args)
export const emitBody = (...args) => ctx.stdlibEmit.emitBody(...args)
export const emitBoolStr = (...args) => ctx.stdlibEmit.emitBoolStr(...args)
export const emitIndex = (...args) => ctx.stdlibEmit.emitIndex(...args)
export const buildArrayWithSpreads = (...args) => ctx.stdlibEmit.buildArrayWithSpreads(...args)
