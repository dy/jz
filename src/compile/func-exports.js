import { ctx } from '../ctx.js'

// =============================================================================
// Single-source export semantics
// =============================================================================
// Two distinct concepts that callers used to conflate:
//
//   1. `f.exported`  — *syntactic* inline-export form, snapshot at `defFunc`
//      time (prepare.js). True iff the func decl carried the inline `export`
//      keyword AND `ctx.funcs.exports[name]` was already populated by parent
//      decl processing. Only the inline-emit gate below (`(func (export "name") ...)`)
//      should read it — that emit path requires the inline-syntax invariant
//      to avoid duplicate-export collisions with sec.customs.
//
//   2. `isExported(f)` — *semantic* "is this func reachable from JS via any
//      export?". Covers the four forms equally:
//        • inline:           `export function foo` → exports[foo]=true
//        • non-aliased:      `function foo; export { foo }` → exports[foo]='foo'
//        • aliased:          `function foo; export { foo as bar }` → exports[bar]='foo'
//        • default-by-name:  `function foo; export default foo` → exports['default']='foo'
//      Every public-ABI gate (boundary wrap, rest-param packing, i64 ABI,
//      cross-call signature narrowing) should consult this.

/** Semantic export predicate. Use everywhere the question is "should this
 *  func behave as part of the public ABI?" — boundary-wrap, rest-pack,
 *  i64-ABI, sig-narrowing gates.
 *
 *  `f.exported` short-circuits the inline-export case (no map walk needed);
 *  the value-scan picks up `export { f }` / `export { f as g }` / `export
 *  default f` where the source name appears as a *value* keyed under the
 *  public name. */
export const isExported = f => {
  if (f.exported) return true
  for (const val of Object.values(ctx.funcs.exports)) {
    if (val === f.name) return true
  }
  return false
}

/** Collect JS-visible export names that resolve to `funcName` (as an array).
 *  Used to emit per-export ABI metadata in custom sections — one entry per
 *  JS-visible name, since the host (interop.js wrap) keys by export name. */
export function exportNamesOf(funcName) {
  const names = []
  for (const [key, val] of Object.entries(ctx.funcs.exports)) {
    if ((val === true && key === funcName) || val === funcName) names.push(key)
  }
  return names
}
