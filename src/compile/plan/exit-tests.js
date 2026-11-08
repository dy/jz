/**
 * A loop of a few passes that leaves at the first pass whose test holds tests
 * all its passes at once, where no pass's work has an effect or can throw:
 *
 *   for (let j = 0; j < 6; j++) { const p = planes[j]; const d = …p…; if (d < r) { h = false; break } }
 *
 * is written out
 *
 *   { const p0 = planes[0]; const d0 = …p0…; const t0 = d0 < r; …; const t5 = d5 < r; if (t0 | … | t5) h = false }
 *
 * Which pass a test holds on is the data's: three's Frustum.intersectsSphere,
 * spliced into the loop over a scene's bounding spheres
 * (WebGLRenderer.projectObject), left by whichever plane a sphere lies outside,
 * and the branch mispredicted about once a sphere. Written out, every pass
 * runs, its reads at constant indices: a loop around it that writes nothing
 * reads the same planes every round (optimize/still-loads.js), and six tests
 * of one shape over them run two to a vector (optimize/pair-tests.js).
 *
 * The loop counts from 0 by one below a literal of at most MAX_PASSES (a
 * `for (let j …)`, smallConstForTripCount) inside another loop (a search per
 * item); its body is declarations, then an `if` without an else, testing an
 * order of two Numbers, whose arm assigns names declared outside the loop
 * values the passes do not change (a literal, a name the body leaves alone) and
 * ends in `break`: the shape an inlined `return X` from inside a loop takes
 * (plan/inline.js lowerReturns). Its passes' tests are then of one shape, which
 * the optimizer pairs into vectors. No other statement leaves the body. A pass
 * runs where the original would have left already, so each one's work must be
 * free of effects and unable to throw in every pass, the counter a literal in
 * each: reads of a binding, Number and boolean arithmetic and comparison
 * (Number operands only: no conversion runs, no BigInt meets a Number), Math's
 * pure functions, a member read of an object no accessor takes (the summary's
 * kind present: an object, never missing, member-uses.js plainMember), an
 * element of an array at a literal index below the length the summary knows
 * for good, an element of a typed array at a literal index (a read past the
 * end is undefined, no throw, and no member is read of it). A body larger than
 * MAX_NODES written out keeps its loop.
 *
 * @module compile/plan/exit-tests
 */
import { ctx } from '../../ctx.js'
import { T, some, isReassigned } from '../../ast.js'
import { freshId } from '../../ir.js'
import { K, core, tagOf, isNullable, hasTag } from '../../summary/kind.js'
import { plainMember } from '../../member-uses.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'
import { cloneWithSubst, smallConstForTripCount } from '../../type.js'
import { collectBindings, nodeSize } from './common.js'

/** The passes a loop written out so may have, and the nodes its passes may hold together. */
export const MAX_PASSES = 8
const MAX_NODES = 600
const EXITS = new Set(['break', 'continue', 'return', 'label', 'throw', 'yield', 'await', '=>'])
// Number and boolean operators: no conversion runs where every operand is a Number or a boolean
const ARITH = new Set(['+', '-', '*', '/', '%', '**', '<', '<=', '>', '>=', '===', '!==', '==', '!=', 'u-', 'u+', '!', '&&', '||', '?',
  '&', '|', '^', '<<', '>>', '>>>', '~'])
// Math's functions that read Numbers and write nothing
const IMPURE_MATH = new Set(['math.random'])
const ORDERS = new Set(['<', '<=', '>', '>='])

const lit = (n) => Array.isArray(n) && n[0] == null && typeof n[1] === 'number' ? n[1] : typeof n === 'number' ? n : null
const tag = (k) => tagOf(core(k ?? 0))
const missing = (k) => k == null || isNullable(k) || hasTag(k, K.NULLISH) || hasTag(k, K.ABSENT)
const primitive = (k) => k != null && !missing(k) && (tag(k) === K.NUMBER || tag(k) === K.BOOL)

/** Whether `e` can run in a pass the loop would not have reached: no effect, no throw. */
const speculative = (e, view) => {
  if (typeof e === 'string') return true
  if (!Array.isArray(e)) return typeof e === 'number'
  const op = e[0]
  if (op == null || op === 'bool' || op === 'str') return true
  if (op === '(') return e.length === 2 && speculative(e[1], view)
  // (an inlined body's expression may declare: `(const n = p.normal, n.x * c.x + …)`)
  if (op === ',') return e.slice(1).every(c => speculative(c, view))
  if (op === 'const') return e.slice(1).every(d => Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && speculative(d[2], view))
  if (ARITH.has(op)) return e.slice(1).every(c => speculative(c, view) && primitive(view.kindOfExpr(c)))
  if (op === '.') {
    if (typeof e[2] !== 'string' || !speculative(e[1], view)) return false
    const k = view.kindOfExpr(e[1])
    return tag(k) === K.OBJECT && !missing(k) && plainMember(view, view.shapesOfExpr(e[1]), e[2])
  }
  if (op === '[]') {
    const i = lit(e[2])
    if (i == null || i < 0 || !Number.isInteger(i) || !speculative(e[1], view)) return false
    const k = view.kindOfExpr(e[1])
    if (missing(k)) return false
    if (tag(k) === K.TYPED) return true
    return tag(k) === K.ARRAY && view.arrayDenseOfExpr(e[1]) && (view.fixedLenOfExpr(e[1]) ?? -1) > i
  }
  if (op === '()') return typeof e[1] === 'string' && e[1].startsWith('math.') && !IMPURE_MATH.has(e[1]) &&
    (e.length < 3 || (Array.isArray(e[2]) && e[2][0] === ',' ? e[2].slice(1) : e.slice(2)).every(c => speculative(c, view) && primitive(view.kindOfExpr(c))))
  return false
}

/** The written-out form of `loop` (a `for`), or null. */
const writeOut = (loop, view) => {
  if (loop.length !== 5) return null
  const [, init, cond, step, block] = loop
  const trips = smallConstForTripCount(init, cond, step, MAX_PASSES)
  if (trips == null || trips < 2) return null
  const j = init[1][1]
  const body = Array.isArray(block) && block[0] === '{}' && Array.isArray(block[1]) && block[1][0] === ';' ? block[1].slice(1) : null
  if (!body || body.length < 1) return null
  const exit = body[body.length - 1], decls = body.slice(0, -1)
  if (!Array.isArray(exit) || exit[0] !== 'if' || exit.length !== 3) return null
  const arm = Array.isArray(exit[2]) && exit[2][0] === '{}' && Array.isArray(exit[2][1]) && exit[2][1][0] === ';' ? exit[2][1].slice(1) : null
  if (!arm || arm.length < 2 || !Array.isArray(arm[arm.length - 1]) || arm[arm.length - 1][0] !== 'break' || arm[arm.length - 1].length !== 1) return null
  const assigns = arm.slice(0, -1)
  const own = new Set()
  collectBindings(block, own)
  if (own.has(j)) return null
  // (no statement but the exit's break leaves a pass, and the counter is the loop's alone)
  if (decls.some(s => !Array.isArray(s) || (s[0] !== 'const' && s[0] !== 'let') || some(s, n => EXITS.has(n[0])))) return null
  if (some(exit[1], n => EXITS.has(n[0])) || isReassigned(block, j)) return null
  // (an order of two Numbers: the passes' tests then pair two to a vector, optimize/pair-tests.js)
  const t = exit[1]
  if (!Array.isArray(t) || !ORDERS.has(t[0]) || t.length !== 3 || !primitive(view.kindOfExpr(t[1])) || !primitive(view.kindOfExpr(t[2])) ||
      tag(view.kindOfExpr(t[1])) !== K.NUMBER || tag(view.kindOfExpr(t[2])) !== K.NUMBER) return null
  // (the exit assigns names of the function values no pass changes)
  for (const a of assigns) {
    if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string' || own.has(a[1])) return null
    const v = a[2]
    if (!(Array.isArray(v) && (v[0] == null || v[0] === 'bool')) && !(typeof v === 'string' && v !== j && !own.has(v))) return null
  }
  if (nodeSize(block) * trips > MAX_NODES) return null
  // every pass's work runs where the loop might have left: no effect, no throw, in every pass
  const tests = []
  for (let k = 0; k < trips; k++) {
    const subst = new Map([[j, [null, k]]])
    for (const d of decls) for (let i = 1; i < d.length; i++) {
      const x = d[i]
      if (!Array.isArray(x) || x[0] !== '=' || typeof x[1] !== 'string' || !speculative(cloneWithSubst(x[2], subst), view)) return null
    }
    if (!speculative(cloneWithSubst(exit[1], subst), view)) return null
  }
  const out = []
  for (let k = 0; k < trips; k++) {
    const rename = new Map([...own].map(b => [b, `${b}${T}p${freshId(ctx)}`]))
    const subst = new Map([[j, [null, k]]])
    for (const d of decls) out.push(cloneWithSubst(d, subst, rename))
    const t = `${T}hit${freshId(ctx)}`
    out.push(['const', ['=', t, cloneWithSubst(exit[1], subst, rename)]])
    tests.push(t)
  }
  out.push(['if', tests.reduce((a, b) => ['|', a, b]), ['{}', [';', ...assigns.map(a => a.slice())]]])
  return ['{}', [';', ...out]]
}

/** Whether some function holds a loop of the shape (a cheap look before the summary is refreshed for it). */
export const exitTestCandidates = () => ctx.transform.optimize?.joinExitTests === true && ctx.funcs.list.some(f => f.body && !f.raw &&
  some(f.body, n => n[0] === 'for' && n.length === 5 && smallConstForTripCount(n[1], n[2], n[3], MAX_PASSES) != null &&
    some(n[4], m => m[0] === 'if' && m.length === 3 && some(m[2], b => b[0] === 'break'))))

/** Plan sweep: every function's small early-exit loops written out, their tests joined. */
export const joinExitTests = () => {
  if (ctx.transform.optimize?.joinExitTests !== true) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    const view = ctx.summary?.at(func.sig)
    if (!view) continue
    let rewrote = false
    // (a search per item of a loop around it: one standing alone runs once, its first hit as likely as any)
    const visit = (n, inLoop) => {
      if (!Array.isArray(n) || n[0] === '=>') return
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (!Array.isArray(c)) continue
        if (c[0] === 'for' && inLoop) {
          const w = writeOut(c, view)
          if (w) { n[i] = w; rewrote = true; continue }
        }
        visit(c, inLoop || c[0] === 'for' || c[0] === 'while' || c[0] === 'do')
      }
    }
    visit(func.body, false)
    if (rewrote) { invalidateProgramFactsCache(func.body); invalidateBodies([func.body]); changed = true }
  }
  return changed
}
