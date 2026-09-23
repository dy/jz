/**
 * Carried elements: a typed element a loop stores for its next pass stays in a
 * local across the back edge.
 *
 * A monotone stack's push is read back at the top of the next pass: the lower
 * envelope stores `v[k] = q` and its next pass begins with `v[k]`, a load on
 * the way to the `f[v[k]]` gather. With the stored value in a local, the pass
 * starts from a register:
 *     for (…) { … A[I] … ; A[I] = E; tail }
 *       →  let c = A[I]
 *          for (…) { … c … ; c = E′; A[I] = c; tail }
 * c starts as the element the first pass reads, and E′ is E converted to the
 * element type: what a read of the stored element returns.
 *
 * Applies when:
 *   - the store is a statement of the loop body, proven in bounds (an
 *     out-of-bounds store is dropped, and the read that follows returns
 *     undefined), no `continue` precedes it, and E writes and calls nothing;
 *   - the reads replaced come before the body's first write of I's names,
 *     store or call;
 *   - after the store, the rest of the body and the loop's step and test write
 *     none of I's names, store to A only at an index provably different from
 *     I and to no array that may share its buffer (both distinct parameters),
 *     and call nothing; the loop's init writes neither I's names nor A;
 *   - A holds integers or float64s, and the element read before the loop is
 *     proven too, so c keeps the element's type (else the change is undone).
 * Speed tiers.
 *
 * @module compile/carry-elements
 */
import { ctx } from '../ctx.js'
import { walkAst, some, collectAllBoundNames, hasOwnContinue, MUTATE_OPS, T } from '../ast.js'
import { freshId } from '../ir.js'
import { typedElemAux } from '../../layout.js'
import { typedStorageNameCtor } from '../typed-context.js'
import { idxKey } from '../type/canonical-bounds.js'
import { valTypeOf } from '../kind.js'
import { VAL } from '../reps.js'
import { typedIdxProven, receiverMayBeAbsent } from '../type/loop-versioning.js'
import { invalidateIntervalProof } from '../type/interval-proof.js'
import { withBodyTypedFacts } from './flow-state.js'
import { invalidateRewrittenBody } from './analyze/body-facts.js'
import { indexFacts, provablyDiffer } from './cse-load.js'

const isArr = Array.isArray
const num = (v) => [null, v]
const cloneExpr = (e) => isArr(e) ? e.map(cloneExpr) : e
// A store's conversion to its element code, in source form: what a read of the element returns.
const CONVERT = {
  0: e => ['>>', ['<<', e, num(24)], num(24)],
  1: e => ['&', e, num(255)],
  2: e => ['>>', ['<<', e, num(16)], num(16)],
  3: e => ['&', e, num(65535)],
  4: e => ['|', e, num(0)],
  5: e => ['>>>', e, num(0)],
  7: e => ['u+', e],
}

/** The names an index `c`, `c + k`, `c - k` or `k + c` reads, or null for another shape. */
const indexNames = (e) => {
  if (typeof e === 'string') return new Set([e])
  if (isArr(e) && e.length === 3 && (e[0] === '+' || e[0] === '-')) {
    const lit = (x) => isArr(x) && x[0] == null && Number.isInteger(x[1])
    if (typeof e[1] === 'string' && lit(e[2])) return new Set([e[1]])
    if (e[0] === '+' && typeof e[2] === 'string' && lit(e[1])) return new Set([e[2]])
  }
  return null
}

/** The typed stores in `n`: [receiver, index] of every element assignment or step. */
const storesIn = (n, out = []) => {
  walkAst(n, { enter: (x) => {
    if (!MUTATE_OPS.has(x[0])) return
    const t = x[1]
    if (isArr(t) && t[0] === '[]' && t.length === 3) out.push([t[1], t[2]])
  } })
  return out
}

const writesNames = (n, names) => some(n, x => MUTATE_OPS.has(x[0]) && names.has(x[1]), { skipArrow: false })
  || [...collectAllBoundNames(n)].some(x => names.has(x))
const calls = (n) => some(n, x => x[0] === '()' || x[0] === '?.()' || x[0] === 'new' || x[0] === '=>', { skipArrow: false })

/** A loop's header parts and the statement list of its body, or null. */
const loopParts = (n) => {
  const list = (b) => isArr(b) && b[0] === '{}' && isArr(b[1]) && b[1][0] === ';' ? b[1] : isArr(b) && b[0] === ';' ? b : null
  if (n[0] === 'for' && n.length === 5) return { init: n[1], cond: n[2], step: n[3], stmts: list(n[4]) }
  if (n[0] === 'while' && n.length === 3) return { init: null, cond: n[1], step: null, stmts: list(n[2]) }
  return null
}

/**
 * Carry the elements the loops of `body` store for their next pass. `facts` is
 * the body analysis, `distinct` the function's distinct typed parameters and
 * `reanalyze()` analyzes the body afresh. Returns the final facts, or null when
 * the body is unchanged.
 */
export function carryElements(body, facts, distinct, reanalyze) {
  if (!isArr(body)) return null
  const F = indexFacts(body)
  const plans = []
  let queried = false
  withBodyTypedFacts(facts, () => walkAst(body, { enter: (n, parent, index) => {
    if (n[0] === '=>') return false
    const parts = parent?.[0] === ';' ? loopParts(n) : null
    if (!parts?.stmts) return
    const { init, cond, step, stmts } = parts, planned = plans.length
    for (let j = 1; j < stmts.length; j++) {
      const s = stmts[j]
      if (!isArr(s) || s[0] !== '=' || !isArr(s[1]) || s[1][0] !== '[]' || typeof s[1][1] !== 'string') continue
      const A = s[1][1], I = s[1][2], E = s[2], names = indexNames(I)
      if (!names || names.has(A) || calls(E) || some(E, x => MUTATE_OPS.has(x[0]), { skipArrow: false })) continue
      const aux = typedElemAux(typedStorageNameCtor(ctx, A))
      if (aux == null || aux & (16 | 32 | 64) || !CONVERT[aux & 7] || receiverMayBeAbsent(A, I)) continue
      if (stmts.slice(1, j).some(hasOwnContinue)) continue
      queried = true
      if (!typedIdxProven(A, I, s[1])) continue
      // after the store, around the back edge, until the next pass reads it
      const after = [...stmts.slice(j + 1), step, cond]
      if (after.some(x => x != null && (writesNames(x, names) || writesNames(x, new Set([A])) || calls(x)))) continue
      if (after.some(x => x != null && storesIn(x).some(([B, J]) =>
          B === A ? !provablyDiffer(I, J, F) : !(distinct?.has(A) && distinct?.has(B))))) continue
      if (init != null && (writesNames(init, names) || writesNames(init, new Set([A])))) continue
      // the reads before the body's first write of I's names, store or call
      const key = idxKey(A, I), reads = []
      for (let i = 1; i < j; i++) {
        const t = stmts[i]
        if (writesNames(t, names) || storesIn(t).length || calls(t)) break
        walkAst(t, { enter: (x, p, at) => {
          if (x[0] === '=>') return false
          if (x[0] === '[]' && x.length === 3 && x[1] === A && idxKey(x[1], x[2]) === key) { reads.push([p, at, x]); return false }
        } })
      }
      if (reads.length) plans.push({ loop: n, parent, stmts, j, A, I, E, aux, reads })
    }
    // a planned loop's statement lists stay its own: its nested loops are not planned
    if (plans.length > planned) return false
  } }))
  // the queries proved the body as it stands, under this analysis's facts
  if (!plans.length) { if (queried) invalidateIntervalProof(body); return null }
  // each loop's stores from the last, so its earlier statement indexes stay put
  const byLoop = new Map()
  for (const pl of plans) (byLoop.get(pl.loop) ?? byLoop.set(pl.loop, []).get(pl.loop)).push(pl)
  const ordered = [...byLoop.values()].flatMap(ps => ps.sort((a, b) => b.j - a.j))
  const applied = []
  // c holds a present element: it reads the element's program-summary kind
  const view = ctx.summary?.at(ctx.func.current)
  for (const pl of ordered) {
    const c = `${T}ce${freshId(ctx)}_${pl.A}`
    const pre = ['[]', pl.A, cloneExpr(pl.I)]
    // an integer element always takes its conversion: exact, a word by
    // construction (a copy of an unbounded counter would widen c), and free
    // on an int32; a Number already is a float64 element
    const value = (pl.aux & 7) === 7 && valTypeOf(pl.E) === VAL.NUMBER ? pl.E : CONVERT[pl.aux & 7](pl.E)
    view?.alias(c, pre, true)
    for (const [p, at] of pl.reads) p[at] = c
    pl.stmts.splice(pl.j, 1, ['=', c, value], ['=', pl.stmts[pl.j][1], c])
    const decl = ['let', ['=', c, pre]]
    pl.parent.splice(pl.parent.indexOf(pl.loop), 0, decl)
    applied.push({ ...pl, c, pre, decl })
  }
  invalidateRewrittenBody(body)
  let out = reanalyze()
  // c must keep the element's type: its first read proven, an integer element in a word
  const keep = (pl) => typedIdxProven(pl.A, pl.pre[2], pl.pre) && ((pl.aux & 7) === 7 || out.locals.get(pl.c) === 'i32')
  const undo = withBodyTypedFacts(out, () => applied.filter(pl => !keep(pl)))
  // the checks proved the body under this analysis's facts
  if (!undo.length) { invalidateIntervalProof(body); return out }
  for (const pl of undo) {
    view?.unalias(pl.c)
    pl.parent.splice(pl.parent.indexOf(pl.decl), 1)
    const k = pl.stmts.findIndex(x => isArr(x) && x[0] === '=' && x[1] === pl.c)
    pl.stmts.splice(k, 2, ['=', pl.stmts[k + 1][1], pl.E])
    for (const [p, i, x] of pl.reads) p[i] = x
  }
  invalidateRewrittenBody(body)
  return reanalyze()
}
