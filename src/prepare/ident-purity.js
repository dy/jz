/**
 * BindingId renaming and call purity predicates: `mintLocal` (the
 * function-local rename minter), `scanReassignedTopLevel`.
 *
 * @module prepare/ident-purity
 */

import { MUTATE_OPS, T, collectParamNames, extractParams, walkAst } from '../ast.js'
import { ownerStack, renameSerial } from './state.js'


/** BindingId totality: every function-local binding renames to the
 *  module-wide-unique `name<T>f<fnId>_<serial>` — fnId = the owning arrow's
 *  ownerStack id, serial = a per-arrow traversal counter (names stay stable
 *  under sibling-function edits). Bare names survive only at module scope
 *  (exports/diagnostics/constInts keep their spelling). Not flagged: the
 *  census collapse (1b) makes unique names load-bearing for correctness. */
export const mintLocal = (name) => `${name}${T}f${ownerStack[ownerStack.length - 1]}_${renameSerial[renameSerial.length - 1]++}`

// The bare names a write node stores into, added to `out` unless `bound`
// holds them: its target through any grouping, and every name a destructuring
// assignment's pattern binds.
const addWriteTargets = (n, out, bound) => {
  let t = n[1]
  while (Array.isArray(t) && t[0] === '()' && t.length === 2) t = t[1]
  if (typeof t === 'string' || n[0] === '=' && isPattern(t)) addPatternNames(t, out, bound)
}
// `['[]', items]` is a pattern; `['[]', obj, index]` is an element, which
// names no binding.
const isPattern = (p) => Array.isArray(p) && p.length <= 2 && (p[0] === '[]' || p[0] === '{}')
const addPatternNames = (p, out, bound) => {
  if (typeof p === 'string') { if (!bound?.has(p)) out.add(p) }
  else if (!Array.isArray(p)) return
  else if (p[0] === '...' || p[0] === '=') addPatternNames(p[1], out, bound)
  else if (p[0] === ':') addPatternNames(p[2], out, bound)
  else if (isPattern(p) || p[0] === ',' || p[0] === ';') for (let i = 1; i < p.length; i++) addPatternNames(p[i], out, bound)
}

/** Every bare name written anywhere under `node`, nested arrows included (a
 *  closure writes the binding it captures). By spelling, so a write to a
 *  shadowing binding counts too: the answer may say "written" of a binding
 *  nothing writes, never the reverse. A declarator's own `=` binds. */
export const writtenNames = (node, out = new Set()) => {
  if (!Array.isArray(node)) return out
  const op = node[0]
  if ((op === 'let' || op === 'const' || op === 'var') && node.length >= 2) {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (Array.isArray(d) && d[0] === '=') writtenNames(d[2], out)
      else writtenNames(d, out)
    }
    return out
  }
  if (MUTATE_OPS.has(op)) addWriteTargets(node, out)
  for (let i = 1; i < node.length; i++) writtenNames(node[i], out)
  return out
}

// Bare-name write targets across a module root, scope-tracked: a write to a
// same-named LOCAL (arrow param, or a let/const anywhere in the enclosing
// function body — the function-scope approximation the sibling scans use)
// does not count. Over-demotion is sound but taxes a lifted function with the
// closure convention for nothing, so shadowed writes are excluded.
export const scanReassignedTopLevel = (root) => {
  const out = new Set()
  const declaredIn = (body, bound) => {
    walkAst(body, { enter: n => {
      if (n[0] === '=>') return false
      if ((n[0] === 'let' || n[0] === 'const' || n[0] === 'var') && n.length >= 2) {
        for (let i = 1; i < n.length; i++) {
          const d = n[i]
          if (typeof d === 'string') bound.add(d)
          else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') bound.add(d[1])
        }
      }
      if (n[0] === 'catch' && typeof n[1] === 'string') bound.add(n[1])
    } })
  }
  const walk = (n, bound) => {
    if (!Array.isArray(n)) return
    if (n[0] === '=>') {
      // defaults run where the parameters are bound, before the body's declarations
      const params = collectParamNames(extractParams(n[1]), new Set(bound))
      walk(n[1], params)
      const inner = new Set(params)
      declaredIn(n[2], inner)
      walk(n[2], inner)
      return
    }
    // A declarator's own `=` is the DECLARATION, not a reassignment — descend
    // only into each declarator's init expression.
    if ((n[0] === 'let' || n[0] === 'const' || n[0] === 'var') && n.length >= 2) {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=') walk(d[2], bound)
        else if (Array.isArray(d)) walk(d, bound)
      }
      return
    }
    if (MUTATE_OPS.has(n[0])) addWriteTargets(n, out, bound)
    for (let i = 1; i < n.length; i++) walk(n[i], bound)
  }
  // Top-level declarations don't shadow — they ARE the bindings being tested;
  // a top-level `g = …` after `let g = …` is exactly the reassignment case.
  walk(root, new Set())
  return out
}
