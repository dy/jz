/**
 * AST analysis predicates — pure functions over jz AST arrays.
 *
 * Extracted from emit.js to reduce the God File and enable reuse.
 * These functions walk the jz AST (array-of-atoms format) and answer
 * structural questions without emitting any IR.
 *
 * # Convention
 * AST nodes are either:
 *   - strings (identifiers / bare names)
 *   - numbers (numeric literals)
 *   - arrays where [0] is the operator tag: ['+', a, b], ['let', ...], ['=>', params, body], etc.
 *   - [null, value] for parenthesized/boxed literals
 *
 * @module ast
 */

import { ASSIGN_OPS, intLiteralValue } from './analyze.js'
import { ctx } from './ctx.js'

/** Detect whether `name` is written to (=, +=, ++, --, etc.) anywhere within `body`.
 *  Conservative over-reject: if unsure, treat as written.
 *  `let`/`const` declarations are NOT reassignments — only the initializer expressions
 *  inside them are scanned. */
export function isReassigned(body, name) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (ASSIGN_OPS.has(op) && body[1] === name) return true
  if ((op === '++' || op === '--') && body[1] === name) return true
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < body.length; i++) {
      const d = body[i]
      if (Array.isArray(d) && d[0] === '=' && d[2] != null && isReassigned(d[2], name)) return true
    }
    return false
  }
  for (let i = 1; i < body.length; i++) if (isReassigned(body[i], name)) return true
  return false
}

/** Does `body` contain a `continue` that targets THIS loop?
 *  A `continue` inside a nested `for`/`while`/`do` targets the inner loop, so we don't count it. */
export function hasOwnContinue(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'continue') return true
  if (op === 'for' || op === 'while' || op === 'do') return false
  for (let i = 1; i < body.length; i++) if (hasOwnContinue(body[i])) return true
  return false
}

export function hasOwnBreakOrContinue(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'break' || op === 'continue') return true
  if (op === 'for' || op === 'while' || op === 'do' || op === '=>') return false
  for (let i = 1; i < body.length; i++) if (hasOwnBreakOrContinue(body[i])) return true
  return false
}

export function containsNestedClosure(body) {
  if (!Array.isArray(body)) return false
  if (body[0] === '=>') return true
  for (let i = 1; i < body.length; i++) if (containsNestedClosure(body[i])) return true
  return false
}

export function containsNestedLoop(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'for' || op === 'while' || op === 'do') return true
  if (op === '=>') return false
  for (let i = 1; i < body.length; i++) if (containsNestedLoop(body[i])) return true
  return false
}

/** Recursive loop size estimator — product of trip counts for nested `for (let i=0; i<N; i++)` loops. */
export function nestedSmallLoopBudget(body) {
  if (!Array.isArray(body)) return 1
  if (body[0] === '=>') return 1
  if (body[0] === 'for') {
    const [, init, cond, step, loopBody] = body
    const n = smallConstForTripCount(init, cond, step)
    return n == null ? MAX_NESTED_FOR_UNROLL + 1 : n * nestedSmallLoopBudget(loopBody)
  }
  let max = 1
  for (let i = 1; i < body.length; i++) max = Math.max(max, nestedSmallLoopBudget(body[i]))
  return max
}

export function containsDeclOf(body, name) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === '=>') return false
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < body.length; i++) {
      const d = body[i]
      if (d === name) return true
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) return true
    }
  }
  for (let i = 1; i < body.length; i++) if (containsDeclOf(body[i], name)) return true
  return false
}

/** Clone AST node, substituting bare-name matches with [null, value]. Skips into closures. */
export function cloneWithSubst(node, name, value) {
  if (node === name) return [null, value]
  if (!Array.isArray(node)) return node
  if (node[0] === '=>') return node
  return node.map(x => cloneWithSubst(x, name, value))
}

export const MAX_SMALL_FOR_UNROLL = 8
export const MAX_NESTED_FOR_UNROLL = 64

/** Does `body` access a typed-array element by string name known to the type system? */
export function containsKnownTypedArrayIndex(body) {
  if (!Array.isArray(body)) return false
  if (body[0] === '=>') return false
  if (body[0] === '[]' && typeof body[1] === 'string' && ctx.types.typedElem?.has(body[1])) return true
  for (let i = 1; i < body.length; i++) if (containsKnownTypedArrayIndex(body[i])) return true
  return false
}

/** Analyze `for (let i=0; i<N; i++)` trip count. Returns N if structurally matches, else null. */
export function smallConstForTripCount(init, cond, step) {
  if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2) return null
  const decl = init[1]
  if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') return null
  const name = decl[1]
  const start = intLiteralValue(decl[2])
  if (start !== 0) return null

  if (!Array.isArray(cond) || cond[0] !== '<' || cond[1] !== name) return null
  const end = intLiteralValue(cond[2])
  if (end == null || end < 0 || end > MAX_SMALL_FOR_UNROLL) return null

  const stepOk = Array.isArray(step) && (
    (step[0] === '++' && step[1] === name) ||
    (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++' && step[1][1] === name && intLiteralValue(step[2]) === 1)
  )
  return stepOk ? end : null
}

/** Does `body` always exit the enclosing scope (return / throw / break / continue)? */
export function isTerminator(body) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'return' || op === 'throw' || op === 'break' || op === 'continue') return true
  if (op === '{}' || op === ';') {
    for (let i = body.length - 1; i >= 1; i--) {
      const s = body[i]
      if (s == null) continue
      return isTerminator(s)
    }
    return false
  }
  return false
}
