/**
 * Stdlib → compiler emit surface.
 *
 * Language modules must import emit helpers from here, not `emit.js` directly.
 * Keeps the stdlib boundary explicit and gives one place to split/lazy-load later.
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
