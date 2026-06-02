/**
 * Host→kernel AST marshalling.
 *
 * The self-host kernel (`src/compile/kernel.js`, compiled to wasm) is handed a
 * RAW parsed AST from the host. A few JS literal primitives can't survive that
 * boundary unchanged, so the host rewrites them to self-describing nodes the
 * kernel's `valTypeOf` / emit path recognize (the inverse of the literal forms
 * emitted in `src/compile/emit.js` and classified in `src/kind.js`).
 *
 * Host-only: never imported by the kernel graph, so it adds nothing to jz.wasm.
 *
 * @module marshal
 */

// Rewrite native BigInt literals in a parsed AST to the marshalling-safe,
// self-describing node `['bigint', <unsigned-64 decimal>]`. A native bigint
// primitive can't survive the host→wasm AST boundary: `wrapVal` stringifies it
// and jz's runtime `typeof` has no bigint case to re-detect it, so the kernel
// would read `255n` as the string "255". The decimal here is `BigInt.asUintN(64,
// n)` — the exact value the raw-primitive emit path (emit.js) feeds to
// `i64.const` — so kernel and host emit byte-identical constants. Mutates in
// place (preserving array holes and `.loc`); the AST is freshly parsed per call.
export function normalizeBigints(node) {
  if (Array.isArray(node)) {
    // Literal node `[<hole/null>, <bigint>]` → flat self-describing `['bigint', dec]`.
    // Replace the WHOLE node so `valTypeOf` sees the tag at node[0]; recursing
    // would only swap the primitive and leave `[null, ['bigint', dec]]` nested.
    if (node.length === 2 && node[0] == null && typeof node[1] === 'bigint')
      return ['bigint', BigInt.asUintN(64, node[1]).toString()]
    // Same hazard for a literal NaN (subscript parses `NaN` as the number, not an
    // identifier): a raw NaN crossing host→kernel is NaN-boxing-ambiguous and reads
    // back as 0. `['nan']` is self-describing (emit → canonical f64.const nan).
    // Infinity is a normal f64 and survives, so it needs no marker.
    if (node.length === 2 && node[0] == null && typeof node[1] === 'number' && node[1] !== node[1])
      return ['nan']
    // Same hazard for a boolean literal: a raw true/false coerces to 1/0 on the f64
    // slot and loses VAL.BOOL, so the kernel returns a plain number, not a boxed bool.
    if (node.length === 2 && node[0] == null && typeof node[1] === 'boolean')
      return ['bool', node[1] ? 1 : 0]
    for (let i = 0; i < node.length; i++) if (i in node) node[i] = normalizeBigints(node[i])
  }
  return node
}
