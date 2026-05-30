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
  // Reserved words that are never valid binding/identifier names (strict mode /
  // ES grammar). subscript parses them as plain identifiers; reject so they fail
  // loudly instead of compiling to a stray local named `let`/`const`/etc.
  let: '`let` is a reserved word, not a valid name',
  const: '`const` is a reserved word, not a valid name',
}

/** jzify-only errors for class lowering (no prepare counterpart). */
export const JZIFY_CLASS_ERRORS = {
  computedMember: 'non-constant computed class member names are not supported',
  computedStaticField: 'non-constant computed static class fields are not supported',
  computedField: 'non-constant computed/destructured class fields are not supported',
  computedStaticMember: 'non-constant computed static class member names are not supported',
  accessor: 'class getters/setters are not supported — jz objects have no accessors',
  staticMember: '`static` class members are not supported yet',
  superProp: '`super` property access is not supported yet',
}

/** Build prepare handler map from shared reject messages. */
export function rejectHandlers(errFn) {
  const out = {}
  for (const [op, msg] of Object.entries(REJECT_OPS)) out[op] = () => errFn(msg)
  return out
}
