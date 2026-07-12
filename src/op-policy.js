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
  yield: 'yield outside a generator body (or in an unsupported position — see jzify/generators.js v1 surface)',
  'yield*': 'yield* not supported yet: loop over the inner iterator and yield each value',
  'new.target': '`new.target` not supported: no constructor reflection',
  instanceof: 'instanceof not supported: use typeof',
  with: '`with` not supported: deprecated',
  ':': 'labeled statements not supported',
  var: '`var` not supported: use let/const',
  function: '`function` not supported: use arrow functions',
}

/** Bare identifiers prepare rejects (no jzify lowering). */
// Prototype-less (Object.create(null)): a plain `{}` inherits Object.prototype in V8, so
// `REJECT_IDENTS['valueOf']` would return the inherited method (truthy) and wrongly reject
// a user identifier named like an Object method. Kernel objects are already prototype-less.
export const REJECT_IDENTS = Object.assign(Object.create(null), {
  with: '`with` not supported',
  class: '`class` not supported',
  yield: '`yield` not supported',
  this: '`this` not supported: use explicit parameter',
  super: '`super` not supported: no class inheritance',
  arguments: '`arguments` not supported: use rest params',
  eval: '`eval` not supported',
  // `const` is an always-reserved word (like `class`/`with` above) — never a valid
  // binding/identifier name in any mode; subscript parses it as a plain identifier,
  // so reject it. NOT `let`: `let` is only *strict-mode* reserved and is a legal
  // identifier in sloppy JS (`var let = 5`), so rejecting it would refuse valid JS
  // (test262 language/expressions/object/let-non-strict-*).
  const: '`const` is a reserved word, not a valid name',
})

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
