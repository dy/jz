/**
 * A callback that runs in place: an arrow written as the callback of an array
 * or typed-array method whose walk the emitter builds (module/array.js,
 * module/typedarray.js, module/array/early-exit.js). The walk calls it there
 * and nowhere else, so its statements are emitted in the walk
 * (module/array/callback.js makeCallback) and a local of the enclosing function
 * it writes stays a local (compile/analyze-scans.js boxedCaptures).
 *
 * The arrow's value is plain: no `return`, or one as its last statement. It
 * writes none of its parameters (they are the walk's locals) and makes no
 * function, so nothing it declares outlives its round. The receiver is a
 * present array, or a typed array of Numbers, with no own member that could
 * take the call: the method's one emitter walks it.
 *
 * @module compile/in-place
 */
import { ctx } from '../ctx.js'
import { blockStmts, collectAssignedNames, collectAllBoundNames, extractParams, isBlockBody, some } from '../ast.js'
import { VAL } from '../reps.js'
import { valTypeOf } from '../kind.js'
import { NUMBER, typedElemKind } from '../summary/kind.js'
import { representationProgramHasBigint } from './representation-plan.js'

const WALKS = new Set(['forEach', 'map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex'])
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

const plainArrow = (fn) => {
  const params = extractParams(fn[1])
  if (!params.every(p => typeof p === 'string')) return false
  let returns = 0
  if (some(fn[2], n => { if (n[0] === 'return') returns++; return OWN.has(n[0]) })) return false
  const stmts = isBlockBody(fn[2]) ? blockStmts(fn[2]) : null
  if (returns > (stmts && stmts[stmts.length - 1]?.[0] === 'return' ? 1 : 0)) return false
  const written = collectAssignedNames(fn[2], new Set())
  return !params.some(p => written.has(p))
}

/** The arrow the method call `call` runs in place, else null. The summary and
 *  the emitter's dispatch (emit/method-dispatch.js, by `valTypeOf`) both name
 *  the receiver's kind: one of no kind there is dispatched at run time, where
 *  a Map's or a Set's arm makes the closure. A program with a BigInt plans each
 *  node's carrier, which the walk's rebuilt nodes would lose. */
export const inPlaceArrow = (call) => {
  if (call[0] !== '()' || call.length !== 3 || !Array.isArray(call[1]) || call[1][0] !== '.' || !WALKS.has(call[1][2])) return null
  const fn = Array.isArray(call[2]) && call[2][0] === ',' ? call[2][1] : call[2]
  if (!Array.isArray(fn) || fn[0] !== '=>' || !plainArrow(fn) || representationProgramHasBigint(ctx)) return null
  const view = ctx.summary?.at(ctx.func.current), recv = call[1][1]
  const vt = view?.valOfExpr(recv)
  if (vt !== VAL.ARRAY && !(vt === VAL.TYPED && typedElemKind(view.kindOfExpr(recv)) === NUMBER)) return null
  return valTypeOf(recv) !== vt || ctx.summary.memberMayBeOwnOn(call[1][2], vt) ? null : fn
}
