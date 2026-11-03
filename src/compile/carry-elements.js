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
/** An integer literal, negated or not (`2`, `-1`), or null. */
const litOf = (x) => {
  if (isArr(x) && x[0] == null && Number.isInteger(x[1])) return x[1]
  if (isArr(x) && (x[0] === 'u-' || x[0] === '-') && x.length === 2) { const v = Number.isInteger(x[1]) ? x[1] : litOf(x[1]); return v == null ? null : -v }
  return null
}
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

/** The constant step `step` moves `q` by (`q++`, `++q`, `q += 2`, `q = q + 2`), or null. */
const stepBy = (step, q) => {
  if (!isArr(step) || step[1] !== q) return null
  if (step[0] === '++' && step.length === 2) return 1
  if (step[0] === '+=' && step.length === 3) return litOf(step[2])
  if (step[0] === '=' && isArr(step[2]) && step[2][0] === '+' && step[2][1] === q) return litOf(step[2][2])
  return null
}

/** The literal a loop's init declares or sets `q` to, or null. */
const initLiteral = (init, q) => {
  const set = isArr(init) && (init[0] === 'let' || init[0] === 'var') && init.length === 2 ? init[1] : init
  return isArr(set) && set[0] === '=' && set[1] === q ? litOf(set[2]) : null
}

/** The literal a statement list leaves in `name` where `stmts[at]` starts: its last write
 *  before, a top-level `let name = K` or `name = K` no later statement writes over. */
const literalAt = (stmts, at, name) => {
  for (let i = at - 1; i >= 1; i--) {
    const s = stmts[i]
    if (!isArr(s)) continue
    const set = s[0] === 'let' || s[0] === 'const' ? s.find((d, i) => i > 0 && isArr(d) && d[0] === '=' && d[1] === name) : s[0] === '=' ? s : null
    if (set && set[1] === name) return litOf(set[2])
    if (writesNames(s, new Set([name]))) return null
  }
  return null
}

/** The literal an index of `c`, `c ± k` or `k + c` reads where `stmts[at]` starts, or null. */
const indexAt = (stmts, at, I) => {
  if (litOf(I) != null) return litOf(I)
  if (typeof I === 'string') return literalAt(stmts, at, I)
  if (isArr(I) && I.length === 3 && (I[0] === '+' || I[0] === '-')) {
    const a = typeof I[1] === 'string' ? literalAt(stmts, at, I[1]) : litOf(I[1])
    const b = typeof I[2] === 'string' ? literalAt(stmts, at, I[2]) : litOf(I[2])
    return a == null || b == null ? null : I[0] === '+' ? a + b : a - b
  }
  return null
}

/**
 * The element `A[I]` holds where `stmts[at]` starts, a literal the list stored there, or null:
 * the list's last store to A writes it at the same index, and nothing after that store
 * writes A or I's names, stores to an array that may share A's buffer, or calls.
 */
const storedAt = (stmts, at, A, I, distinct) => {
  const key = indexAt(stmts, at, I), names = indexNames(I)
  if (key == null || !names) return null
  for (let i = at - 1; i >= 1; i--) {
    const s = stmts[i]
    if (!isArr(s)) continue
    if (s[0] === '=' && isArr(s[1]) && s[1][0] === '[]' && s[1][1] === A && indexAt(stmts, i, s[1][2]) === key) {
      return litOf(s[2])
    }
    if (calls(s) || writesNames(s, new Set([A]))) return null
    // (a store between: to A only as a statement of the list, at another literal index)
    const top = s[0] === '=' && isArr(s[1]) && s[1][0] === '[]' && s[1][1] === A ? indexAt(stmts, i, s[1][2]) : null
    if (storesIn(s).some(([B]) => B === A ? top == null || top === key || storesIn(s[2]).length : !(distinct?.has(A) && distinct?.has(B)))) return null
  }
  return null
}

/**
 * Rewrite a planned counter copy's reads as the counter less its step. A name that holds
 * such a read holds the same through the loop body, where nothing writes the counter: a
 * declaration from the read (`const t = v[k]`), or a shared load's temp (cse-load.js:
 * declared from a literal, set by its first read, `f[t = v[k]]`, read after), set where
 * its statement runs it unconditionally and written nowhere else. Its reads, all after
 * that write, read the lagged counter too, so a difference of the two cancels
 * (`2 * q - 2 * t`).
 */
const COND = new Set(['if', '?:', '&&', '||', '??', 'while', 'for', 'do', 'for-in', 'for-of', 'switch', '=>', 'try'])
const lagReads = (pl) => {
  const lagged = () => ['-', pl.E, num(pl.lag)]
  for (const [p, at] of pl.reads) {
    p[at] = lagged()
    const name = p[0] === '=' && at === 2 && typeof p[1] === 'string' ? p[1] : null
    if (!name) continue
    const only = new Set([name])
    // the statement that sets the name, and a declaration of it from a literal before that (its placeholder)
    const sp = pl.stmts.findIndex((t, i) => i > 0 && some(t, x => x === p, { skipArrow: false }))
    const placeholder = (t) => isArr(t) && (t[0] === 'let' || t[0] === 'const') && t.length === 2 && isArr(t[1]) && t[1][0] === '=' && t[1][1] === name && litOf(t[1][2]) != null
    let ok = sp > 0 && !pl.stmts.some((t, i) => i > 0 && i !== sp && !placeholder(t) && (writesNames(t, only) || i < sp && some(t, x => x === name || isArr(x) && x.includes(name), { skipArrow: false })))
      && !pl.stmts.some((t, i) => i > sp && placeholder(t))
      // (declared here, by `p` itself: `const t = v[k]`)
      && (!collectAllBoundNames(pl.stmts[sp]).has(name) || (pl.stmts[sp][0] === 'let' || pl.stmts[sp][0] === 'const') && pl.stmts[sp].includes(p)
        && pl.stmts[sp].filter(d => d === name || isArr(d) && d[0] === '=' && d[1] === name).length === 1)
    // in its own statement: set by `p` alone, unconditionally, before any read of it (in evaluation
    // order, operands from the first), and read by no closure, which may run in a later pass
    let found = false, depth = 0
    const walk = (x) => {
      if (!ok || !isArr(x)) return
      if (x === p) { if (depth) ok = false; found = true; return }
      if (x[0] === '=>') { if (some(x, y => y === name || isArr(y) && y.includes(name), { skipArrow: false })) ok = false; return }
      if (MUTATE_OPS.has(x[0]) && x[1] === name) { ok = false; return }
      for (let i = 1; i < x.length && ok; i++) {
        if (x[i] === name) { if (!found && !(x[0] === '.' && i === 2)) ok = false; continue }
        const cond = COND.has(x[0]) && i > 1
        if (cond) depth++
        walk(x[i])
        if (cond) depth--
      }
    }
    if (ok) walk(pl.stmts[sp])
    if (!ok || !found) continue
    const rewrite = (x) => {
      if (!isArr(x) || x === p || placeholder(x)) return
      for (let i = 1; i < x.length; i++) {
        if (x[i] === name && !(x[0] === '.' && i === 2)) x[i] = lagged()
        else rewrite(x[i])
      }
    }
    for (let i = sp; i < pl.stmts.length; i++) rewrite(pl.stmts[i])
  }
}

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
          B === A ? !provablyDiffer(I, J, F, stmts) : !(distinct?.has(A) && distinct?.has(B))))) continue
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
      if (!reads.length) continue
      // the counter stored where the list before the loop left the counter's value a step
      // before its first: every pass reads the counter less its step, and nothing crosses
      // the back edge (a monotone stack whose bottom holds the first index, its top pushed
      // each pass: the lower envelope's `v[k]`, then `q - 1`)
      const by = typeof E === 'string' && n[0] === 'for' && ((aux & 7) === 4 || (aux & 7) === 7) && facts?.locals?.get(E) === 'i32'
        ? stepBy(step, E) : null
      const first = by != null ? initLiteral(init, E) : null
      // (the element there in bounds: a dropped store would leave the first pass `undefined`)
      const at = parent.indexOf(n), entry = first != null ? indexAt(parent, at, I) : null
      const lag = entry != null && !stmts.slice(1).some(t => writesNames(t, new Set([E]))) && !writesNames(cond, new Set([E]))
        && typedIdxProven(A, num(entry)) && storedAt(parent, at, A, I, distinct) === first - by ? by : null
      plans.push({ loop: n, parent, stmts, j, A, I, E, aux, reads, lag })
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
    if (pl.lag != null) { lagReads(pl); continue }
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
