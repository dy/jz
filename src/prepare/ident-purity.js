/**
 * BindingId renaming and call/receiver purity predicates: `mintLocal` (the
 * function-local rename minter), `scanReassignedTopLevel`, `\u` escape decoding
 * (IDESC/decodeIdent), and the callFree/boundSafeCalls/writesReceiver family used to
 * recognize safe-to-fold calls and receiver mutation.
 *
 * @module prepare/ident-purity
 */

import { ASSIGN_OPS, MUTATE_OPS, PARAM_NAME, T, classifyParam, extractParams, walkAst } from '../ast.js'
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
      const inner = new Set(bound)
      for (const p of extractParams(n[1])) {
        const c = classifyParam(p)
        if (c[PARAM_NAME]) inner.add(c[PARAM_NAME])
      }
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
// Calls that provably can't resize ANY receiver: read-only builtin methods
// (no mutators, no callback-takers — a callback could close over the receiver
// and push) and pure namespaces. Everything else (user fns, push/splice,
// map/forEach) may reach the bound receiver through an alias — disqualifies
// the length snapshot. A user object shadowing one of these names with a
// mutating closure is a documented divergence (same class as for-of's).
const _BOUND_PURE_NS = new Set(['Math', 'math', 'Number', 'String', 'JSON', 'console', 'Date', 'performance'])
const _BOUND_RO_METHODS = new Set([
  'charCodeAt', 'charAt', 'codePointAt', 'at', 'indexOf', 'lastIndexOf', 'includes',
  'startsWith', 'endsWith', 'slice', 'substring', 'trim', 'toUpperCase', 'toLowerCase',
  'join', 'concat', 'toString', 'get', 'has', 'now',
])
export const boundSafeCalls = node => {
  if (!Array.isArray(node)) return true
  if (node[0] === 'new') return false
  if (node[0] === '()' || node[0] === '?.()') {
    const callee = node[1]
    const safe = Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') &&
      (_BOUND_RO_METHODS.has(callee[2]) ||
       (typeof callee[1] === 'string' && _BOUND_PURE_NS.has(callee[1])))
    if (!safe) return false
  }
  for (let i = 1; i < node.length; i++) if (!boundSafeCalls(node[i])) return false
  return true
}
export const writesReceiver = (node, recv) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (MUTATE_OPS.has(op) &&
      (node[1] === recv ||
       (Array.isArray(node[1]) && (node[1][0] === '[]' || node[1][0] === '.') && node[1][1] === recv)))
    return true
  for (let i = 1; i < node.length; i++) if (writesReceiver(node[i], recv)) return true
  return false
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