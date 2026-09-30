/**
 * Function-value and closure classification: hasFunc, isNamespaceAliasScoped,
 * shadowsBuiltin, isFuncValueLocal, renameFunc, isUnresolvableBareIdent — used by
 * handlers.js to decide when a function value can be lifted/renamed safely.
 *
 * @module prepare/closure-lift
 */

import { ctx } from '../ctx.js'
import { hasModule, isNamedCallee } from '../autoload.js'
import { REJECT_IDENTS } from '../op-policy.js'
import { isDeclared, resolveScope } from './scope.js'
import { CONSTANTS, F64_CONSTANTS, GLOBAL_TYPEOF, builtinMemberKey, funcLocalNames, funcValueNames, scopes } from './state.js'



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
  return typeof key === 'string' && key !== name && (hasModule(key) || isNamedCallee(key) || !!builtinMemberKey(key))
}
export const shadowsBuiltin = name => typeof name === 'string' &&
  ((scopes.length && isDeclared(name) && !isNamespaceAliasScoped(name)) || hasFunc(name) || hasFunc(ctx.scope.chain[name]) ||
    ctx.scope.userGlobals?.has?.(name) || ctx.scope.userGlobals?.has?.(ctx.scope.chain[name]) ||
    ctx.module.imports.some(i => i[3]?.[1] === `$${name}`))
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
  // A builtin global jz provides is a real, spec-defined binding, whether or
  // not jz holds a value for it (GLOBAL_TYPEOF answers its `typeof`).
  if (GLOBAL_TYPEOF[name]) return false
  if (REJECT_IDENTS[name]) return false
  if (scopes.length && isDeclared(name)) return false
  if (ctx.scope.chain[name]) return false
  if (ctx.funcs.names.has(name)) return false
  if (ctx.func?.locals?.has?.(name)) return false
  // Top-level decls live in ctx.scope.globals / userGlobals (set by prepDecl at
  // depth 0). Current arrow's local names are tracked in funcLocalNames.
  if (ctx.scope.globals?.has?.(name)) return false
  if (ctx.scope.userGlobals?.has?.(name)) return false
  const fnNames = funcLocalNames[funcLocalNames.length - 1]
  if (fnNames?.has(name)) return false
  return true
}
