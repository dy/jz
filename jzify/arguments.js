/**
 * `arguments` object + destructuring-param lowering for function→arrow conversion.
 * @module jzify/arguments
 */

import { paramList } from '../src/ast.js'
import { isDestructurePat, prependDecls } from './hoist-vars.js'

function usesArguments(node) {
  if (node === 'arguments') return true
  if (!Array.isArray(node)) return false
  if (node[0] === 'function') return false
  if (node[0] === '.' || node[0] === '?.') return usesArguments(node[1])
  if (node[0] === ':') return usesArguments(node[2])
  for (let i = 1; i < node.length; i++) if (usesArguments(node[i])) return true
  return false
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
  if (node[0] === 'function') return node
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
        decls.push(['=', param[1], ['??', ['[]', name, [null, idx]], renameArguments(param[2], name)]])
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
