/**
 * `arguments` object + destructuring-param lowering for function→arrow conversion.
 * @module jzify/arguments
 */

import { paramList } from '../src/ast.js'
import { isDestructurePat, prependDecls } from './hoist-vars.js'

export function usesArguments(node) {
  if (node === 'arguments') return true
  if (!Array.isArray(node)) return false
  // Nested function OR generator bodies own their own `arguments` — a
  // `function*` was walked through here, so an outer function containing a
  // generator that used `arguments` got the rest-param lowering applied to
  // ITSELF and the generator's writes aliased the outer (empty) rest array.
  if (node[0] === 'function' || node[0] === 'function*') return false
  // Literal node `[, value]` (op === null) — node[1] is a string/number VALUE, not an
  // identifier. A string literal `'arguments'` must not read as the arguments object.
  if (node[0] == null) return false
  if (node[0] === '.' || node[0] === '?.') return usesArguments(node[1])
  if (node[0] === ':') return usesArguments(node[2])
  for (let i = 1; i < node.length; i++) if (usesArguments(node[i])) return true
  return false
}

// A parameter literally named `arguments` (or a destructure / default / rest that
// binds it) SHADOWS the arguments object: every `arguments` in the body resolves to
// that parameter, not the args array. So the args-object lowering must not fire —
// `function f(arguments){ return arguments }` is just a one-param function, and `f()`
// returns undefined (not the `[]` args object). Mirrors the spec's param-scope
// shadowing of the implicit `arguments` binding (test262 13_A15_T3).
function paramsBindArguments(params) {
  const bound = (p) => {
    if (p === 'arguments') return true
    if (!Array.isArray(p)) return false
    if (p[0] === '=' || p[0] === '...') return bound(p[1])
    if (p[0] === '[]' || p[0] === '{}' || p[0] === ',') return p.slice(1).some(bound)
    if (p[0] === ':') return bound(p[2])
    return false
  }
  return paramList(params).some(bound)
}

function bindsArguments(body) {
  const isArgDecl = s => Array.isArray(s) && (s[0] === 'var' || s[0] === 'let' || s[0] === 'const') &&
    s.slice(1).some(d => d === 'arguments' || (Array.isArray(d) && d[0] === '=' && d[1] === 'arguments'))
  let n = body
  if (Array.isArray(n) && n[0] === '{}') n = n[1]
  if (Array.isArray(n) && n[0] === ';') return n.slice(1).some(isArgDecl)
  return isArgDecl(n)
}

function renameArguments(node, to) {
  if (node === 'arguments') return to
  if (!Array.isArray(node)) return node
  if (node[0] === 'function' || node[0] === 'function*') return node
  // Literal node `[, value]` — node[1] is a value, not an identifier; leave untouched
  // so a string literal `'arguments'` survives the rename.
  if (node[0] == null) return node
  if (node[0] === '.' || node[0] === '?.')
    return [node[0], renameArguments(node[1], to), node[2]]
  if (node[0] === ':')
    return [node[0], node[1], renameArguments(node[2], to)]
  return node.map(n => renameArguments(n, to))
}

function prependParamDecls(decl, body) {
  if (Array.isArray(body) && body[0] === '{}') {
    const inner = body[1]
    if (Array.isArray(inner) && inner[0] === ';') return ['{}', [';', decl, ...inner.slice(1)]]
    if (inner == null) return ['{}', decl]
    return ['{}', [';', decl, inner]]
  }
  if (Array.isArray(body) && (body[0] === ';' || body[0] === 'return')) return [';', decl, body]
  return ['{}', [';', decl, ['return', body]]]
}

/** @param {ReturnType<import('./names.js').createNames>} names */
export function createArgumentsLowering(names) {
  function lowerArguments(params, body) {
    // A param named `arguments` shadows the implicit args object: rename it (and its
    // in-scope body refs — renameArguments stops at nested `function`s, and arrows
    // legitimately inherit the param) to a fresh binding, so it becomes an ordinary
    // parameter. No args-object lowering fires, and the strict-subset
    // `arguments`-unsupported guard never sees the name. (test262 13_A15_T3.)
    if (paramsBindArguments(params)) {
      const fresh = names.arg()
      return lowerArguments(renameArguments(params, fresh), renameArguments(body, fresh))
    }
    if (bindsArguments(body)) body = renameArguments(body, names.arg())
    const paramsNeedLowering = paramList(params).some(isDestructurePat)
    const usesArgsObj = usesArguments(params) || usesArguments(body)
    if (!paramsNeedLowering && !usesArgsObj) return [params, body]
    const name = names.arg()
    const decls = []
    for (const [idx, param] of paramList(params).entries()) {
      if (Array.isArray(param) && param[0] === '...') {
        decls.push(['=', param[1], ['()', ['.', name, 'slice'], [null, idx]]])
        continue
      }
      if (Array.isArray(param) && param[0] === '=') {
        // Param default fires ONLY on undefined, not null — `??` would take the
        // default for a passed null. The rest-array index read is idempotent
        // and pure, so the ternary re-reads instead of spilling a temp.
        const read = ['[]', name, [null, idx]]
        decls.push(['=', param[1], ['?:', ['===', read, 'undefined'], renameArguments(param[2], name), read]])
        continue
      }
      decls.push(['=', param, ['[]', name, [null, idx]]])
    }
    const renamed = usesArgsObj ? renameArguments(body, name) : body
    return [['()', ['...', name]], decls.length ? prependParamDecls(['let', ...decls], renamed) : renamed]
  }

  let transformRef = null
  const transformPattern = (node) => {
    const transform = transformRef
    if (node == null || !Array.isArray(node)) return node
    const op = node[0]
    if (op === '=') return ['=', transformPattern(node[1]), transform(node[2])]
    if (op === ':') return [':', transform(node[1]), transformPattern(node[2])]
    if (op === '...') return ['...', transformPattern(node[1])]
    if (op === '[]' || op === '{}' || op === ',') return [op, ...node.slice(1).map(transformPattern)]
    return transform(node)
  }

  return {
    lowerArguments,
    transformPattern,
    bindTransform(fn) { transformRef = fn },
  }
}
