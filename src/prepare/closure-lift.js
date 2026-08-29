/**
 * Function-value and closure classification: hasFunc, isNamespaceAliasScoped,
 * shadowsBuiltin, isFuncValueLocal, renameFunc, isUnresolvableBareIdent — used by
 * handlers.js to decide when a function value can be lifted/renamed safely.
 *
 * @module prepare/closure-lift
 */

import { ctx } from '../ctx.js'
import { hasModule } from '../autoload.js'
import { REJECT_IDENTS } from '../op-policy.js'
import { isDeclared, resolveScope } from './scope.js'
import { CONSTANTS, F64_CONSTANTS, GLOBALS, NS_CTORS, builtinMemberKey, funcLocalNames, funcValueNames, scopes } from './state.js'



export const hasFunc = name => ctx.funcs.names.has(name)
// A builtin name (`Map`, `Array`, `Math`, …) is shadowed when the user bound it
// as a local (let/const/param, via `isDeclared`), a top-level function (via
// `hasFunc`), or a top-level let/const global (via `userGlobals`). A shadowed
// name must resolve to the user binding, so the constructor / named-call
// fast-paths bail and fall through to `resolveCallee`, which already routes a
// declared name to its local value. Mirrors the guard in
// `foldNamespaceIntrospection`.
// …EXCEPT a namespace alias (`const M = Math` at any depth): registerBuiltinAlias
// maps the name to the MODULE ITSELF in the block scope — that's the namespace,
// not a shadow of it. An ordinary local can never carry that resolution (only the
// hasModule-gated alias branch writes module names into scope maps).
const isNamespaceAliasScoped = name => {
  if (!scopes.length || !isDeclared(name)) return false
  const key = resolveScope(name)
  return typeof key === 'string' && key !== name && (hasModule(key) || !!builtinMemberKey(key))
}
export const shadowsBuiltin = name => typeof name === 'string' &&
  ((scopes.length && isDeclared(name) && !isNamespaceAliasScoped(name)) || hasFunc(name) ||
    ctx.scope.userGlobals?.has?.(name) || ctx.module.imports.some(i => i[3]?.[1] === `$${name}`))
// A local bound to a function literal in any active arrow scope (the nested-
// closure counterpart to `hasFunc`, which only knows depth-0 lifted functions).
export const isFuncValueLocal = name => typeof name === 'string' && funcValueNames.some(s => s.has(name))

export const renameFunc = (func, nextName) => {
  ctx.funcs.names.delete(func.name)
  func.name = nextName
  ctx.funcs.names.add(nextName)
}

// `typeof`-string → code table lives in ast.js (TYPEOF) — shared with
// emitTypeofCmp and flow-types so the codes have one home.
// Spec §13.5.3: `typeof undeclared_x` returns 'undefined' without throwing.
// True iff `name` is a bare identifier with no resolution path. Mirrors the
// resolution chain inside `prep()` so we don't speculate emit-time failures.
export function isUnresolvableBareIdent(name) {
  if (typeof name !== 'string') return false
  if (name in CONSTANTS || name in F64_CONSTANTS) return false
  if (name === 'Boolean' || name === 'Number') return false
  if (REJECT_IDENTS[name]) return false
  if (scopes.length && isDeclared(name)) return false
  if (ctx.scope.chain[name]) return false
  if (GLOBALS[name]) return false
  if (ctx.funcs.names.has(name)) return false
  if (ctx.func?.locals?.has?.(name)) return false
  // Top-level decls live in ctx.scope.globals / userGlobals (set by prepDecl at
  // depth 0). Current arrow's local names are tracked in funcLocalNames.
  if (ctx.scope.globals?.has?.(name)) return false
  if (ctx.scope.userGlobals?.has?.(name)) return false
  const fnNames = funcLocalNames[funcLocalNames.length - 1]
  if (fnNames?.has(name)) return false
  // A builtin-namespace constructor name (NS_CTORS, declared below — safe to
  // forward-reference: this function only ever runs after module init) or
  // `Iterator` is NOT a spec §13.5.3 unresolvable reference — it's a real,
  // spec-defined global, just one jz has no first-class VALUE for (no
  // general function/builtin reflection — see the emit-time "not in scope"
  // reject this falls through to instead). Folding `typeof Promise` straight
  // to the string 'undefined' here would ship a confident wrong answer
  // (confirmed live: real JS says 'function') that never even reaches that
  // reject, since a folded literal never emits the identifier at all.
  if (NS_CTORS.has(name) || name === 'Iterator') return false
  return true
}