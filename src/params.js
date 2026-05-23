/**
 * Arrow param normalization and free-variable analysis.
 * @module params
 */
import { ctx } from './ctx.js'

export function extractParams(rawParams) {
  let p = rawParams
  if (Array.isArray(p) && p[0] === '()') p = p[1]
  return p == null ? [] : Array.isArray(p) ? (p[0] === ',' ? p.slice(1) : [p]) : [p]
}

export function classifyParam(r) {
  if (Array.isArray(r) && r[0] === '...') return { kind: 'rest', name: r[1] }
  if (Array.isArray(r) && r[0] === '=') {
    if (typeof r[1] === 'string') return { kind: 'default', name: r[1], defValue: r[2] }
    return { kind: 'destruct-default', pattern: r[1], defValue: r[2] }
  }
  if (Array.isArray(r) && (r[0] === '[]' || r[0] === '{}')) return { kind: 'destruct', pattern: r }
  return { kind: 'plain', name: r }
}

export function collectParamNames(raw, out = new Set()) {
  for (const r of raw) {
    if (typeof r === 'string') out.add(r)
    else if (Array.isArray(r)) {
      if (r[0] === '=' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '...' && typeof r[1] === 'string') out.add(r[1])
      else if (r[0] === '=' && Array.isArray(r[1])) collectParamNames([r[1]], out)
      else if (r[0] === '[]' || r[0] === '{}' || r[0] === ',') collectParamNames(r.slice(1), out)
    }
  }
  return out
}

/** Find free variables in AST: referenced in node, not in `bound`, present in `scope`. */
export function findFreeVars(node, bound, free, scope) {
  if (node == null) return
  if (typeof node === 'string') {
    if (bound.has(node) || free.includes(node)) return
    const inScope = scope
      ? scope.has(node)
      : (ctx.func.locals?.has(node) || ctx.func.current?.params.some(p => p.name === node))
    if (inScope) free.push(node)
    return
  }
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (op === '=>') {
    const innerBound = collectParamNames(extractParams(args[0]), new Set(bound))
    findFreeVars(args[1], innerBound, free, scope)
    return
  }
  if (op === 'catch') {
    // ['catch', tryBody, errName, handler] — errName is a binding occurrence,
    // not a reference, and is in scope only inside the handler. Recursing into
    // it as a plain string would mis-capture an outer var of the same name.
    findFreeVars(args[0], bound, free, scope)
    const errName = args[1]
    const handlerBound = typeof errName === 'string' && errName
      ? new Set(bound).add(errName) : bound
    findFreeVars(args[2], handlerBound, free, scope)
    return
  }
  if (op === 'let' || op === 'const') {
    collectParamNames(args, bound)
    if (scope) collectParamNames(args, scope)
  }
  if (op === 'for' && Array.isArray(args[0]) && (args[0][0] === 'let' || args[0][0] === 'const')) {
    collectParamNames(args[0].slice(1), bound)
    if (scope) collectParamNames(args[0].slice(1), scope)
  }
  for (const a of args) findFreeVars(a, bound, free, scope)
}
