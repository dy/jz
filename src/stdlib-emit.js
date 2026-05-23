/**
 * Stdlib → compiler emit surface.
 *
 * Language modules import emit helpers from `module/_emit.js` (ctx-bound at
 * reset). This module re-exports for external tooling and documents the boundary.
 *
 * @module stdlib-emit
 */

export {
  emit,
  emitFlat,
  emitBody,
  emitBoolStr,
  emitIndex,
  buildArrayWithSpreads,
} from './emit.js'
