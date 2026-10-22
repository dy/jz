/**
 * A loop dividing by a name it never writes runs a copy that multiplies by
 * the divisor's reciprocal, where the divisor is a power of two:
 * `if (w is 2^k) { const r = 1 / w; loop, a * r } else { loop, a / w }`.
 *
 * A float division is the slowest arithmetic a loop runs: on x64 a
 * division issues every four to five cycles where a multiply issues twice a
 * cycle, so a loop storing `sum / m` per sample, or scaling every sample by
 * `/ span`, runs at the divider's pace. The engine multiplies by a constant
 * divisor's reciprocal itself, where that is exact; a divisor the program
 * computes (a window's length, a range's span, a size from a table) it
 * divides by. For `w = 2^k` the reciprocal `2^-k` is exact, and `a * 2^-k` is
 * `a / 2^k` for every `a`: both round the one real number `a * 2^-k` once,
 * zeros keep their signs, infinities and NaNs propagate, and an operand that
 * is no Number converts once in either. Other divisors run the loop as
 * written: it is no colder for that (a window of 10 is no rarer than one of
 * 16), and every later pass versions it as before.
 *
 * The guard reads the divisor a positive int32 power of two:
 * `typeof w === 'number' && w === (w | 0) && w > 0 && (w & (w - 1)) === 0`,
 * up to 2^30, every reciprocal of which is a normal number. A divisor is a
 * local of the function (a parameter or a declaration outside the loop) the
 * loop never writes and no closure writes; a module binding or a literal
 * divisor is the engine's to fold, a member read the loop may change. A
 * quotient made an integer (`(e / w) | 0`, `Math.floor(e / w)`) is an
 * integer division of words, or a seed of the counters loop-divmod.js steps.
 * A division in a nested loop belongs to that loop (versioned first, the walk
 * being post-order). Only a kernel loop is copied, one calling nothing but
 * Math (src/growth.js): a loop that calls spends its passes in the callees.
 * A loop with a closure in it, a loop another version left as written
 * (cold) and one too large to copy are left alone, as the loop-copying
 * passes leave them.
 *
 * A plan pass after the divisions by an invariant the counter's dividend
 * steps (loop-divmod.js): those are counters by then, the rest divide.
 *
 * @module compile/plan/reciprocal-loops
 */
import { ctx } from '../../ctx.js'
import { T, some, numberGuard, walkAst } from '../../ast.js'
import { frameNode } from '../../function.js'
import { freshId } from '../../ir.js'
import { cloneWithSubst } from '../../type.js'
import { collectBindings, nodeSize } from './common.js'
import { normalizeLoop, rewriteBlocks, closureMutatedVars, loopHazards } from '../loop-model.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'
import { kernelLoop } from '../../growth.js'

const MAX_SIZE = 800   // nodes a copy duplicates at most (plan/unswitch-loops.js's budget)
const LOOPS = new Set(['for', 'while', 'do'])
const lit = (v) => [null, v]
const and = (tests) => tests.reduce((a, b) => ['&&', a, b])

/** `w` is a positive int32 power of two: its reciprocal is exact. */
const pow2 = (w) => and([numberGuard(w), ['===', w, ['|', w, lit(0)]], ['>', w, lit(0)], ['===', ['&', w, ['-', w, lit(1)]], lit(0)]])

// A quotient made an integer (`(e / w) | 0`, `~~(e / w)`, `Math.floor(e / w)`) is an integer
// division where its operands are words, and a seed of the counters loop-divmod.js steps.
const INT_OPS = new Set(['|', '&', '^', '~', '<<', '>>', '>>>'])
const INT_CALLS = new Set(['math.floor', 'math.ceil', 'math.trunc', 'math.round'])
const intQuotient = (parent) => Array.isArray(parent) && (INT_OPS.has(parent[0]) || parent[0] === '()' && INT_CALLS.has(parent[1]))

/** Each division of the loop's own body (no nested loop's, no closure's) by a name `divisor` accepts: `a / w`, `x /= w`. */
const ownDivisions = (body, divisor, visit) => walkAst(body, { enter: (n, parent) => {
  if (n[0] === '=>' || LOOPS.has(n[0])) return false
  if (n[0] === '/=' && n.length === 3 && typeof n[2] === 'string' && divisor(n[2])) visit(n)
  if (n[0] === '/' && n.length === 3 && typeof n[2] === 'string' && divisor(n[2]) && !intQuotient(parent)) visit(n)
} })

function tryVersion(stmt, M) {
  const L = normalizeLoop(stmt)
  if (!L || stmt.cold || nodeSize(stmt) > MAX_SIZE) return null
  // (a loop that calls spends its passes in the callees: a kernel loop's alone is the divider's pace)
  if (!kernelLoop(stmt)) return null
  if (some(stmt, n => n[0] === '=>' || n[0] === 'yield' || n[0] === 'await')) return null
  // what the loop declares holds a value of one pass (or of the loop's own init)
  const inner = new Set()
  collectBindings(stmt, inner)
  const hz = loopHazards(M.cm, [';', L.body, L.cond ?? lit(0), ...(L.step ? [L.step] : []), ...(L.init ? [L.init] : [])])
  const divisor = (n) => M.locals.has(n) && !inner.has(n) && !ctx.funcs.names.has(n) && !hz.mutated(n)
  const ws = []
  ownDivisions(L.body, divisor, (n) => { if (!ws.includes(n[2])) ws.push(n[2]) })
  if (L.cond) ownDivisions(L.cond, divisor, (n) => { if (!ws.includes(n[2])) ws.push(n[2]) })
  if (!ws.length) return null

  // the copy: its declarations under names of its own, each division a product by the reciprocal
  const id = freshId(ctx)
  const rcp = new Map(ws.map((w, k) => [w, `${T}rcp${id}_${k}`]))
  const fast = cloneWithSubst(stmt, new Map(), new Map([...inner].map(n => [n, `${n}${T}rc${id}`])))
  const fl = normalizeLoop(fast)
  const rewrite = (n) => { n[0] = n[0] === '/' ? '*' : '*='; n[2] = rcp.get(n[2]) }
  ownDivisions(fl.body, (n) => rcp.has(n), rewrite)
  if (fl.cond) ownDivisions(fl.cond, (n) => rcp.has(n), rewrite)
  const decl = ['const', ...ws.map(w => ['=', rcp.get(w), ['/', lit(1), w]])]
  return [['if', and(ws.map(pow2)), ['{}', [';', decl, fast]], stmt]]
}

/** Version the loops of every function body (a plan pass: the summary reads the copies' fresh names). */
export function reciprocalLoopDivisors() {
  if (ctx.transform.optimize?.reciprocalDivisors === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    const locals = new Set((func.sig?.params ?? []).map(p => p.name))
    collectBindings(func.body, locals)
    const M = { locals, cm: closureMutatedVars(frameNode(func)) }
    const body = rewriteBlocks(func.body, stmt => tryVersion(stmt, M))
    if (body === func.body) continue
    invalidateProgramFactsCache(func.body)
    invalidateBodies([func.body])
    func.body = body
    changed = true
  }
  return changed
}
