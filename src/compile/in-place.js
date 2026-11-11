/**
 * A callback that runs in place: an arrow written as the callback of a walk the
 * emitter builds (module/array.js, module/typedarray.js,
 * module/array/early-exit.js). The walk calls it there, so its statements are
 * emitted in the walk (module/array/callback.js makeCallback): no closure, no
 * call_indirect, no argument array.
 *
 * It is the emitter's choice alone. To every analysis the arrow is the closure
 * it is written as: a local of the enclosing function it writes is held in a
 * cell (compile/analyze-scans.js boxedCaptures), which the inlined statements
 * read and write as the function's own code does. A cell no closure took is
 * a local again in the optimizer (optimize/cells.js).
 *
 * The arrow's value is plain: no `return`, or one as its last statement. It
 * writes none of its parameters (they are the walk's locals) and makes no
 * function, so nothing it declares outlives its round. A program with a BigInt
 * plans each node's carrier, which the walk's rebuilt nodes would lose.
 *
 * @module compile/in-place
 */
import { ctx } from '../ctx.js'
import { blockStmts, collectAssignedNames, collectAllBoundNames, extractParams, isBlockBody, some } from '../ast.js'
import { representationProgramHasBigint } from './representation-plan.js'

// (what an arrow's body may not hold to run in place: a function it makes, a receiver of its own)
const OWN = new Set(['=>', 'function', 'class', 'this', 'yield', 'await'])

/** The statements an arrow body runs before its value, and the value: its last
 *  statement's `return`, else undefined (null). An expression body is its value. */
export const bodyParts = (body) => {
  const stmts = isBlockBody(body) ? blockStmts(body) : null
  if (!stmts) return { stmts: [], value: body }
  const last = stmts[stmts.length - 1]
  return Array.isArray(last) && last[0] === 'return' ? { stmts: stmts.slice(0, -1), value: last[1] ?? null } : { stmts, value: null }
}

/** The names an arrow's body declares: its `let`/`const` targets, a value's
 *  among them (a spliced call's `(const t = a, …)`), and `catch` parameters. */
export const declaredNames = (body) => {
  const out = collectAllBoundNames(body)
  some(body, n => { if (n[0] === 'catch' && n.length === 4 && typeof n[2] === 'string') out.add(n[2]); return false })
  return out
}

/** Whether a walk runs the callback `fn` in place: an arrow of plain value. */
export const runsInPlace = (fn) => {
  if (!Array.isArray(fn) || fn[0] !== '=>' || representationProgramHasBigint(ctx)) return false
  const params = extractParams(fn[1])
  if (!params.every(p => typeof p === 'string')) return false
  let returns = 0
  if (some(fn[2], n => { if (n[0] === 'return') returns++; return OWN.has(n[0]) })) return false
  const stmts = isBlockBody(fn[2]) ? blockStmts(fn[2]) : null
  if (returns > (stmts && stmts[stmts.length - 1]?.[0] === 'return' ? 1 : 0)) return false
  const written = collectAssignedNames(fn[2], new Set())
  return !params.some(p => written.has(p))
}
