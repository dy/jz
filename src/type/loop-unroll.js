/**
 * Loop-unroll AST predicates and trip-count arithmetic: generic shape tests
 * (`containsNestedClosure`, `containsDeclOf`, …) plus `smallConstForTripCount`/
 * `nestedSmallLoopBudget`, the budget math emit.js and plan/literals.js consult
 * before cloning a loop body per iteration. Independent of every other `type/`
 * bounds-proof family — a true leaf.
 *
 * @module type/loop-unroll
 */
import { some } from '../ast.js'
import { ctx } from '../ctx.js'
import { intLiteralValue } from '../static.js'

// === Loop unroll / AST transforms (emit + plan) ===

export const MAX_SMALL_FOR_UNROLL = 8
export const MAX_NESTED_FOR_UNROLL = 64

export function containsNestedClosure(body) {
  return some(body, n => n[0] === '=>')
}

export function containsNestedLoop(body) {
  return some(body, n => n[0] === 'for' || n[0] === 'while' || n[0] === 'do')
}

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
  return some(body, n => {
    if (n[0] !== 'let' && n[0] !== 'const') return false
    for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (d === name) return true
      if (Array.isArray(d) && d[0] === '=' && d[1] === name) return true
    }
    return false
  })
}

export function containsKnownTypedArrayIndex(body) {
  return some(body, n => n[0] === '[]' && typeof n[1] === 'string' && ctx.func.typedElem?.has(n[1]))
}

/** Trip count for `for (let i=0; i<N; i++)` when structurally obvious, else null. */
export function smallConstForTripCount(init, cond, step, maxEnd = MAX_SMALL_FOR_UNROLL) {
  if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2) return null
  const decl = init[1]
  if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') return null
  const name = decl[1]
  const start = intLiteralValue(decl[2])
  if (start !== 0) return null
  if (!Array.isArray(cond) || cond[0] !== '<' || cond[1] !== name) return null
  const end = intLiteralValue(cond[2])
  if (end == null || end < 0 || end > maxEnd) return null
  const stepOk = Array.isArray(step) && (
    (step[0] === '++' && step[1] === name) ||
    (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++' && step[1][1] === name && intLiteralValue(step[2]) === 1)
  )
  return stepOk ? end : null
}

/** Does `body` always exit via return/throw/break/continue? */
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
