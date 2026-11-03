/**
 * Flat (SRoA) slots: an object or small array literal dissolved into one
 * local per field (analyze-scans.js flatObjectCandidate). A slot is storage
 * like a heap field, and its carrier is decided by every value it can hold.
 *
 * @module compile/flat-slots
 */
import { ctx } from '../ctx.js'
import { VAL } from '../reps.js'
import { staticIndexKey } from '../static.js'
import { isLiteralStr } from '../ast.js'

/** The slot a read or write of a flat (SRoA) literal names: `o.k`, `o['k']`
 *  or `a[2]` where the binding dissolved into `name#i` locals
 *  (analyze-scans.js flatObjectCandidate); null for any other node. */
export const flatSlotOf = node => {
  if (!Array.isArray(node) || typeof node[1] !== 'string' || (node[0] !== '.' && node[0] !== '[]')) return null
  const flat = ctx.func.flatObjects?.get(node[1])
  if (!flat) return null
  const key = node[0] === '.' ? node[2] : isLiteralStr(node[2]) ? node[2][1] : staticIndexKey(node[2])
  return key != null && flat.names.includes(key) ? { name: node[1], key } : null
}

/** A flat slot holds raw BigInt bits only where every value it can hold, the
 *  literal's and each write's, is a BigInt and nothing else, by the summary
 *  (its kinds are its nodes' own, the same wherever the question is asked).
 *  Any other slot is tagged storage (ADR-0001): a BigInt write boxes, a BigInt
 *  read unboxes by tag, and no read of it claims the BigInt kind. */
export const flatSlotRaw = (name, key) => {
  const flat = ctx.func.flatObjects?.get(name), i = flat ? flat.names.indexOf(key) : -1
  const view = i >= 0 ? ctx.summary?.at(ctx.func.current) : null
  if (!view || flat.values[i] === undefined || view.valOfExpr(flat.values[i]) !== VAL.BIGINT) return false
  for (const w of flat.writes?.get(key) ?? []) if (view.valOfExpr(w) !== VAL.BIGINT) return false
  return true
}
