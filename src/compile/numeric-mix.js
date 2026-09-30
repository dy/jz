import { some } from '../ast.js'
import { K, hasTag } from '../summary/kind.js'

// Substitution must not turn a call's runtime TypeError into a compile-time
// rejection. Comparisons accept both domains; arithmetic and bitwise ops do not.
const UNMIXED_OPS = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>'])
export const mixesNumericKinds = (body, kindOf) => some(body, n => {
  const op = n[0]
  if (n.length !== 3 || !UNMIXED_OPS.has(op) &&
      !(typeof op === 'string' && op.endsWith('=') && UNMIXED_OPS.has(op.slice(0, -1)))) return false
  const a = kindOf(n[1]), b = kindOf(n[2])
  return hasTag(a, K.BIGINT) && hasTag(b, K.NUMBER) || hasTag(a, K.NUMBER) && hasTag(b, K.BIGINT)
})
