/**
 * Shared op policy for jzify (transform) and prepare (reject).
 *
 * `.jz` source bypasses jzify, so prepare must enforce reject rules for both paths.
 * jzify lowers `var`/`function`/`class`/`arguments` before prepare; prepare rejects
 * survivors. Identifiers (`this`, `eval`, …) have no safe lowering in either pass.
 *
 * @module op-policy
 */

/** Ops prepare rejects when they appear in the AST (handler or identifier). */
export const REJECT_OPS = {
  async: 'async/await not supported: WASM is synchronous',
  await: 'async/await not supported: WASM is synchronous',
  class: 'class not supported: use object literals',
  yield: 'generators not supported: use loops',
  instanceof: 'instanceof not supported: use typeof',
  with: '`with` not supported: deprecated',
  ':': 'labeled statements not supported',
  var: '`var` not supported: use let/const',
  function: '`function` not supported: use arrow functions',
}

/** Bare identifiers prepare rejects (no jzify lowering). */
export const REJECT_IDENTS = {
  with: '`with` not supported',
  class: '`class` not supported',
  yield: '`yield` not supported',
  this: '`this` not supported: use explicit parameter',
  super: '`super` not supported: no class inheritance',
  arguments: '`arguments` not supported: use rest params',
  eval: '`eval` not supported',
}

/** Ops jzify transforms rather than rejecting (prepare still rejects survivors). */
export const JZIFY_TRANSFORM_OPS = new Set(['var', 'function', 'class', 'arguments'])

/** Build prepare handler map from shared reject messages. */
export function rejectHandlers(errFn) {
  const out = {}
  for (const [op, msg] of Object.entries(REJECT_OPS)) out[op] = () => errFn(msg)
  return out
}
