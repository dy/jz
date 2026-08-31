/**
 * Literal lattice — compile-time truthiness/value/bool evaluation of a
 * literal-shaped AST node, plus the nullish-arm join predicate `VT['?:']`
 * (kind/val-type-of.js) consults for its BIGINT+nullish-literal merge rule.
 * Zero ctx dependency; pure AST pattern matching only.
 *
 * Split out of kind.js (pipeline-minimality slice, .work/archive/kind-split.md).
 *
 * @module kind/lattice
 */

import { BOOL_OPS } from '../kind-traits.js'
import { intLiteralValue } from '../static.js'

export function literalTruthiness(expr) {
  if (typeof expr === 'number') return expr !== 0 && expr === expr
  if (typeof expr === 'boolean') return expr
  if (typeof expr === 'bigint') return expr !== 0n
  if (typeof expr === 'string') {
    const value = intLiteralValue(expr)
    if (value != null) return value !== 0
  }
  if (Array.isArray(expr)) {
    const op = expr[0]
    if (op == null) {
      if (expr.length === 1 || expr[1] == null) return false
      return literalTruthiness(expr[1])
    }
    if (op === 'bool') return literalTruthiness(expr[1])
    if (op === 'nan') return false
    if (op === 'str' && typeof expr[1] === 'string') return expr[1].length !== 0
    if (op === '()' && expr.length === 2) return literalTruthiness(expr[1])
    if (BOOL_OPS.has(op)) {
      const result = literalBool(expr)
      if (result != null) return result
    }
    if (op === '?:' || op === '?') {
      const truthy = literalTruthiness(expr[1])
      if (truthy != null) return literalTruthiness(truthy ? expr[2] : expr[3])
      const thenTruthy = literalTruthiness(expr[2])
      const elseTruthy = literalTruthiness(expr[3])
      if (thenTruthy != null && thenTruthy === elseTruthy) return thenTruthy
    }
    if (op === '()' && Array.isArray(expr[1]) && expr[1][0] === '?') {
      const ternary = expr[1]
      const truthy = literalTruthiness(ternary[1])
      if (truthy != null) return literalTruthiness(truthy ? ternary[2] : ternary[3])
      const thenTruthy = literalTruthiness(ternary[2])
      const elseTruthy = literalTruthiness(ternary[3])
      if (thenTruthy != null && thenTruthy === elseTruthy) return thenTruthy
    }
  }
  return null
}

function literalValue(expr) {
  if (expr == null || typeof expr === 'number' || typeof expr === 'boolean' || typeof expr === 'bigint') return expr
  if (!Array.isArray(expr)) return undefined
  const op = expr[0]
  if (op == null) return expr.length > 1 ? expr[1] : undefined
  if (op === 'nan') return NaN
  if (op === 'str') return expr[1]
  if (op === 'bool') {
    const truthy = literalTruthiness(expr[1])
    return truthy == null ? undefined : truthy
  }
  if (op === '()' && expr.length === 2) return literalValue(expr[1])
  return undefined
}

function literalBool(expr) {
  if (!Array.isArray(expr)) return null
  const [op, left, right] = expr
  if (op === '!') {
    const truthy = literalTruthiness(left)
    return truthy == null ? null : !truthy
  }
  if (!['<', '<=', '>', '>=', '==', '!=', '===', '!=='].includes(op)) return null
  const a = literalValue(left), b = literalValue(right)
  if (a === undefined || b === undefined) return null
  switch (op) {
    case '<': return a < b
    case '<=': return a <= b
    case '>': return a > b
    case '>=': return a >= b
    case '==': return a == b
    case '!=': return a != b
    case '===': return a === b
    case '!==': return a !== b
  }
  return null
}

// AST nullish literal — mirrors ir.js isNullishLit ([null,null] = null literal,
// [] = undefined) plus the bare `undefined` name form recordGlobalRep accepts;
// local copy because ir.js already imports valTypeOf from here (cycle).
export const nullishArm = (n) => n === 'undefined' ||
  (Array.isArray(n) && ((n.length === 2 && n[0] == null && n[1] == null) || n.length === 0))

