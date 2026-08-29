/**
 * Literal lattice — compile-time truthiness/value/bool evaluation of a
 * literal-shaped AST node, plus the nullish-arm join predicate `VT['?:']`
 * (kind/val-type-of.js) consults for its BIGINT+nullish-literal merge rule.
 * Zero ctx dependency; pure AST pattern matching only.
 *
 * Split out of kind.js (pipeline-minimality slice, .work/kind-split.md).
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
    const [op, ...args] = expr
    if (op == null) {
      if (args.length === 0 || args[0] == null) return false
      return literalTruthiness(args[0])
    }
    if (op === 'bool') return literalTruthiness(args[0])
    if (op === 'nan') return false
    if (op === 'str' && typeof args[0] === 'string') return args[0].length !== 0
    if (op === '()' && expr.length === 2) return literalTruthiness(args[0])
    if (BOOL_OPS.has(op)) {
      const result = literalBool(expr)
      if (result != null) return result
    }
    if (op === '?:' || op === '?') {
      const truthy = literalTruthiness(args[0])
      if (truthy != null) return literalTruthiness(truthy ? args[1] : args[2])
      const thenTruthy = literalTruthiness(args[1])
      const elseTruthy = literalTruthiness(args[2])
      if (thenTruthy != null && thenTruthy === elseTruthy) return thenTruthy
    }
    if (op === '()' && Array.isArray(args[0]) && args[0][0] === '?') {
      const truthy = literalTruthiness(args[0][1])
      if (truthy != null) return literalTruthiness(truthy ? args[0][2] : args[0][3])
      const thenTruthy = literalTruthiness(args[0][2])
      const elseTruthy = literalTruthiness(args[0][3])
      if (thenTruthy != null && thenTruthy === elseTruthy) return thenTruthy
    }
  }
  return null
}

function literalValue(expr) {
  if (expr == null || typeof expr === 'number' || typeof expr === 'boolean' || typeof expr === 'bigint') return expr
  if (!Array.isArray(expr)) return undefined
  const [op, ...args] = expr
  if (op == null) return args.length ? args[0] : undefined
  if (op === 'nan') return NaN
  if (op === 'str') return args[0]
  if (op === 'bool') {
    const truthy = literalTruthiness(args[0])
    return truthy == null ? undefined : truthy
  }
  if (op === '()' && expr.length === 2) return literalValue(args[0])
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

