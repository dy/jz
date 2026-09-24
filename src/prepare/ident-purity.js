/**
 * BindingId renaming and call purity predicates: `mintLocal` (the
 * function-local rename minter), `scanReassignedTopLevel`, `\u` escape decoding
 * (IDESC/decodeIdent), and the callFree predicate used to
 * recognize safe-to-fold calls.
 *
 * @module prepare/ident-purity
 */

import { ASSIGN_OPS, T, collectParamNames, extractParams, walkAst } from '../ast.js'
import { ownerStack, renameSerial } from './state.js'


/** BindingId totality: every function-local binding renames to the
 *  module-wide-unique `name<T>f<fnId>_<serial>` — fnId = the owning arrow's
 *  ownerStack id, serial = a per-arrow traversal counter (names stay stable
 *  under sibling-function edits). Bare names survive only at module scope
 *  (exports/diagnostics/constInts keep their spelling). Not flagged: the
 *  census collapse (1b) makes unique names load-bearing for correctness. */
export const mintLocal = (name) => `${name}${T}f${ownerStack[ownerStack.length - 1]}_${renameSerial[renameSerial.length - 1]++}`

// Bare-name write targets across a module root, scope-tracked: a write to a
// same-named LOCAL (arrow param, or a let/const anywhere in the enclosing
// function body — the function-scope approximation the sibling scans use)
// does not count. Over-demotion is sound but taxes a lifted function with the
// closure convention for nothing, so shadowed writes are excluded.
export const scanReassignedTopLevel = (root) => {
  const out = new Set()
  const isWriteOp = (op) => op === '++' || op === '--' ||
    (typeof op === 'string' && op.endsWith('=') && ASSIGN_OPS.has(op))
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
    if (isWriteOp(n[0]) && typeof n[1] === 'string' && !bound.has(n[1])) out.add(n[1])
    for (let i = 1; i < n.length; i++) walk(n[i], bound)
  }
  // Top-level declarations don't shadow — they ARE the bindings being tested;
  // a top-level `g = …` after `let g = …` is exactly the reassignment case.
  walk(root, new Set())
  return out
}

// ES spec: identifier with \uHHHH or \u{...} escape is equivalent to the decoded
// form. subscript preserves raw spelling in the AST; normalize once before prep.
const IDESC = /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g
const decodeIdent = s => s.includes('\\u')
  ? s.replace(IDESC, (_, b, p) => String.fromCodePoint(parseInt(b || p, 16)))
  : s

// A for-loop bound `arr.length` may be snapshotted into a pre-loop local only when
// nothing in the loop can change it. Two ways it can change: a write to the receiver
// (`arr = …`, `arr.length = …`, `arr[k] = …`) or a call — push/pop/splice mutate
// directly, and any call can reach `arr` through an alias the compiler can't track
// locally (compilePendingClosures grows ctx.closure.bodies this way). Both predicates
// recurse the whole node; nested arrow *definitions* are harmless until invoked, and
// an invocation is itself a call node, so `callFree` already covers escaped mutators.
const callFree = node => {
  if (!Array.isArray(node)) return true
  if (node[0] === '()' || node[0] === 'new') return false
  for (let i = 1; i < node.length; i++) if (!callFree(node[i])) return false
  return true
}
export const normalizeIdents = node => {
  if (!Array.isArray(node)) return
  // Literal-value wrapper [null, X] / [undefined, X]: X is a value, not an identifier
  if (node.length === 2 && node[0] == null) return
  for (let i = 1; i < node.length; i++) {
    const v = node[i]
    if (typeof v === 'string') node[i] = decodeIdent(v)
    else if (Array.isArray(v)) normalizeIdents(v)
  }
}