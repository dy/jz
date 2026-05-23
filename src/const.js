/**
 * Compile-time integer literal folding.
 * @module const
 */
import { I32_MIN, I32_MAX } from './ast.js'
import { ctx } from './ctx.js'
import { repOf } from './reps.js'

/** Extract integer value from AST literal node. Returns null if not a 32-bit integer. */
export function intLiteralValue(expr) {
  let v = null
  if (typeof expr === 'number') v = expr
  else if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'number') v = expr[1]
  else if (Array.isArray(expr) && expr[0] === 'u-' && typeof expr[1] === 'number') v = -expr[1]
  else if (typeof expr === 'string') v = repOf(expr)?.intConst ?? ctx.scope.constInts?.get(expr) ?? null
  return v != null && Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX ? v : null
}

/** Non-negative integer literal — used for string/typed-array index bounds. */
export const nonNegIntLiteral = (node) => { const n = intLiteralValue(node); return n != null && n >= 0 ? n : null }

/** Fold compile-time integer expressions (literals, const bindings, + - * <<). */
export function constIntExpr(node) {
  let lit = intLiteralValue(node)
  if (lit == null && typeof node === 'number' && Number.isInteger(node)) lit = node
  if (lit == null && Array.isArray(node) && node[0] == null && Number.isInteger(node[1])) lit = node[1]
  if (lit != null) return lit
  if (typeof node === 'string') return repOf(node)?.intConst ?? ctx.scope.constInts?.get(node) ?? null
  if (!Array.isArray(node)) return null
  const op = node[0]
  if (op === 'u-') {
    const v = constIntExpr(node[1])
    return v == null ? null : -v
  }
  if (node.length !== 3) return null
  const a = constIntExpr(node[1]), b = constIntExpr(node[2])
  if (a == null || b == null) return null
  if (op === '+') return a + b
  if (op === '-') return a - b
  if (op === '*') return a * b
  if (op === '<<') return a << b
  return null
}
