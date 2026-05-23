/**
 * Runtime emit accessors for stdlib modules.
 *
 * Delegates to ctx.stdlibEmit (bound at compile reset) so module files do not
 * statically import emit.js and its analyzer dependency chain.
 *
 * @module module/_emit
 */

import { ctx } from '../src/ctx.js'

export const emit = (...args) => ctx.stdlibEmit.emit(...args)
export const emitFlat = (...args) => ctx.stdlibEmit.emitFlat(...args)
export const emitBody = (...args) => ctx.stdlibEmit.emitBody(...args)
export const emitBoolStr = (...args) => ctx.stdlibEmit.emitBoolStr(...args)
export const emitIndex = (...args) => ctx.stdlibEmit.emitIndex(...args)
export const buildArrayWithSpreads = (...args) => ctx.stdlibEmit.buildArrayWithSpreads(...args)
