/**
 * A declaration in a loop of a Number the loop never changes moves before the
 * loop: `const hf = (((H - 1e-9) % 100) + 100) % 100 / 2.5 - 1` in a search
 * over chromas `c` at one hue `H`.
 *
 * A body spliced into a loop (plan/inline.js) brings the work of every argument
 * along, and the arguments the loop never changes make work it repeats each
 * pass: munsell's `muXyY( H, V, c )` over 19 chromas computes the value
 * polynomial of `V`, the value cell of `V` and the hue cell of `H` each time.
 * The engine hoists none of it: V8 moves no computation out of a wasm loop, and
 * watr's LICM takes pure expressions only, not the remainder whose fast path
 * branches to the runtime nor the statements that bind the value.
 *
 * A declaration moves where
 *   - it declares one name, of a `const` or a `let` the function writes nowhere
 *     else, declared nowhere else in the function and read only after it in its
 *     own statement list (a read before it is in its dead zone);
 *   - its value is arithmetic, comparison, choice and `Math` (but `random`) over
 *     literals, module constants and locals declared ahead of the loop that the
 *     loop and no closure writes, every name the summary's Number: no conversion
 *     runs, nothing throws, and no call the loop makes can change it (a module
 *     `let` may change under any call), so evaluating it once ahead of the loop,
 *     in an arm the pass may skip too, answers what each pass did;
 *   - it is no nested loop's (that loop moves it first, ahead of itself, where
 *     the enclosing loop then reads it) and no closure's.
 * The declarations keep their order, so one may read another moved before it.
 * The loops are innermost first: a value of the outer loop's alone moves on out.
 *
 * @module compile/plan/loop-invariants
 */
import { ctx } from '../../ctx.js'
import { walkAst, MUTATE_OPS } from '../../ast.js'
import { frameNode } from '../../function.js'
import { K, tagOf, core } from '../../summary/index.js'
import { normalizeLoop, rewriteBlocks, closureMutatedVars, loopHazards } from '../loop-model.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

const isArr = Array.isArray
const LOOPS = new Set(['for', 'while', 'do'])
const PURE_OPS = new Set(['+', '-', '*', '/', '%', '**', 'u-', 'u+', '<', '<=', '>', '>=', '===', '!==', '==', '!=', '!', '?:', '&&', '||'])
const pureMath = (callee) => typeof callee === 'string' && callee.startsWith('math.') && callee !== 'math.random'

/** The names `n` reads, or null where it is no pure Number arithmetic. */
export const pureNames = (n, out = new Set()) => {
  if (typeof n === 'string') { out.add(n); return out }
  if (!isArr(n)) return null
  if (n[0] == null) return typeof n[1] === 'number' ? out : null
  if (n[0] === '()') {
    if (!pureMath(n[1])) return null
    const a = n[2]
    const args = a == null ? [] : isArr(a) && a[0] === ',' ? a.slice(1) : [a]
    for (const x of args) if (!pureNames(x, out)) return null
    return out
  }
  if (!PURE_OPS.has(n[0])) return null
  for (let i = 1; i < n.length; i++) if (!pureNames(n[i], out)) return null
  return out
}

// (a declaration's own count of operators: a name or a literal alone saves nothing moved)
export const ops = (n) => !isArr(n) || n[0] == null ? 0 : 1 + n.slice(1).reduce((k, c) => k + ops(c), 0)

/** Move the invariant declarations of every loop of every function before it. */
export function hoistLoopInvariants() {
  if (ctx.transform.optimize?.loopInvariants === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    const view = ctx.summary?.at(func.sig)
    if (!view) continue
    // every declaration and write of each name in the function, closures included
    const declared = new Map(), writes = new Map(), inits = new Set()
    // the walk's order: a loop's place, and each name's declaration's (a parameter's before all)
    const at = new Map(), firstAt = new Map()
    let order = 0
    walkAst(func.body, { enter: n => {
      order++
      if (LOOPS.has(n[0])) at.set(n, order)
      if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
        const d = n[i], name = typeof d === 'string' ? d : isArr(d) && d[0] === '=' && typeof d[1] === 'string' ? d[1] : null
        if (name) { declared.set(name, (declared.get(name) || 0) + 1); if (!firstAt.has(name)) firstAt.set(name, order) }
        if (isArr(d) && d[0] === '=') inits.add(d)
      }
      if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string' && !inits.has(n)) writes.set(n[1], (writes.get(n[1]) || 0) + 1)
    } })
    for (const p of func.sig?.params ?? []) { declared.set(p.name, (declared.get(p.name) || 0) + 1); firstAt.set(p.name, 0) }
    // a name no call can change, with a value ahead of the loop at `place`
    const steady = (y, place) => firstAt.has(y) ? firstAt.get(y) < place : ctx.scope.consts?.has(y) === true
    const cm = closureMutatedVars(frameNode(func))
    const number = (name) => { const k = view.kindOfExpr(name); return k != null && tagOf(core(k)) === K.NUMBER }
    const tryLoop = (stmt) => {
      const L = normalizeLoop(stmt)
      if (!L || stmt.cold) return null
      // a loop that is another's whole body (`for (…) for (…) { … }`) is in no statement list: its moves first, into a block
      if (LOOPS.has(L.body?.[0])) {
        const inner = tryLoop(L.body)
        if (inner) setBody(stmt, ['{}', [';', ...inner]])
      }
      return tryOwn(stmt)
    }
    const tryOwn = (stmt) => {
      const L = normalizeLoop(stmt)
      const hz = loopHazards(cm, [';', L.body, L.cond ?? [null, 0], ...(L.step ? [L.step] : []), ...(L.init ? [L.init] : [])])
      const moved = []
      const hoisted = new Set()
      // `list` a statement list of the loop's body: its declarations that move, in order
      const visit = (list) => {
        if (!isArr(list) || list[0] !== ';') return
        const moves = (d, k, held) => {
          if (!isArr(d) || d[0] !== '=' || typeof d[1] !== 'string') return false
          const x = d[1], e = d[2], names = pureNames(e)
          return !!names && ops(e) >= 2 && declared.get(x) === 1 && !writes.has(x) && !cm.has(x) &&
            [...names].every(y => (held.has(y) || !hz.mutated(y) && !declaredIn(stmt, y) && steady(y, at.get(stmt) ?? 0)) && number(y)) && !readBefore(list, k, x)
        }
        for (let k = 1; k < list.length; k++) {
          const s = list[k]
          if (!isArr(s)) continue
          if (LOOPS.has(s[0]) || s[0] === '=>') continue
          if (s[0] === 'const' || s[0] === 'let') {
            // (a declaration of several names is one of each where one of them moves)
            if (s.length > 2) {
              const held = new Set(hoisted)
              if (s.slice(1).some(d => { const m = moves(d, k, held); if (m) held.add(d[1]); return m })) { list.splice(k, 1, ...s.slice(1).map(d => [s[0], d])); k--; continue }
            } else if (moves(s[1], k, hoisted)) { moved.push(s); hoisted.add(s[1][1]); list[k] = null; continue }
          }
          // the arms and blocks of the pass, not a closure's or a nested loop's
          walkAst(s, { enter: n => {
            if (n === s) return
            if (n[0] === '=>' || LOOPS.has(n[0])) return false
            if (n[0] === ';') { visit(n); return false }
          } })
        }
      }
      const body = isArr(L.body) && L.body[0] === '{}' ? L.body[1] : L.body
      visit(body)
      if (!moved.length) return null
      count += moved.length
      prune(stmt)
      return [...moved, stmt]
    }
    count = 0
    const body = rewriteBlocks(func.body, tryLoop)
    if (!count) continue
    invalidateProgramFactsCache(func.body)
    invalidateBodies([func.body])
    func.body = body
    changed = true
  }
  return changed
}
// the declarations moved in the function under way
let count = 0
// `stmt`'s body replaced by `body`, in place
const setBody = (stmt, body) => { stmt[stmt[0] === 'while' ? 2 : 4] = body }

// (a name declared in the loop is a value of one pass)
const declaredIn = (body, y) => {
  let found = false
  walkAst(body, { enter: n => {
    if (found) return false
    if ((n[0] === 'let' || n[0] === 'const') && n.slice(1).some(d => d === y || isArr(d) && d[0] === '=' && d[1] === y)) found = true
  } })
  return found
}

// whether `list` reads `x` before its statement `k`
const readBefore = (list, k, x) => {
  let hit = false
  for (let i = 1; i < k && !hit; i++) walkAst(list[i], { enter: n => { if (hit) return false; if (n === x || isArr(n) && n.includes(x)) hit = true } })
  return hit
}

// the nulls the moves left in the statement lists of `stmt`, in place
const prune = (stmt) => {
  walkAst(stmt, { enter: n => {
    if (n[0] === ';') for (let i = n.length - 1; i >= 1; i--) if (n[i] === null) n.splice(i, 1)
  } })
}
