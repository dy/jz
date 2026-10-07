/**
 * A boolean declared once from a condition and read once, by the `if` right
 * after it (`const inside = x >= 0 && x < W && bmp[y * W + x] === 1; if (inside)
 * …`): the `if` tests the condition itself. Its arms then refine by every
 * conjunct (an index in range, a word of the row), as they would had the test
 * been written there, and the test short-circuits as written. The statements
 * are adjacent, so the condition reads the same values at the test. A
 * condition that calls stays named: the proofs around a named guard fail
 * closed on an effect, and the forwarding keeps that; so does one that writes.
 *
 * @module compile/plan/forward-conditions
 */
import { ctx } from '../../ctx.js'
import { walkAst, some, MUTATE_OPS } from '../../ast.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

// the reads of `name` in `node`: every operand position but a property key and a write's target
const reads = (node, name) => {
  let k = 0
  walkAst(node, { enter: (n) => {
    if (n[0] === 'str') return false
    for (let i = 1; i < n.length; i++) if (n[i] === name && !((n[0] === '.' || n[0] === '?.') && i === 2) && !(MUTATE_OPS.has(n[0]) && i === 1)) k++
  } })
  return k
}

const forwardIn = (body) => {
  let changed = false
  walkAst(body, { enter: (n) => {
    if (n[0] === '=>') return false
    if (n[0] !== ';') return
    for (let i = 1; i + 1 < n.length; i++) {
      const d = n[i], next = n[i + 1]
      if (!Array.isArray(d) || d[0] !== 'const' || d.length !== 2 || !Array.isArray(d[1]) || d[1][0] !== '=' || typeof d[1][1] !== 'string') continue
      if (!Array.isArray(next) || next[0] !== 'if' || next[1] !== d[1][1]) continue
      if (reads(body, d[1][1]) !== 1) continue
      // (a condition that calls or writes stays named: the proofs around a named guard fail closed on an effect)
      if (some(d[1][2], n => n[0] === '()' || n[0] === '?.()' || n[0] === 'new' || n[0] === '=>' || MUTATE_OPS.has(n[0]))) continue
      next[1] = d[1][2]
      n.splice(i, 1)
      changed = true
    }
  } })
  return changed
}

/** Plan sweep: every function's conditions forwarded into their tests. */
export const forwardConditions = () => {
  let changed = false
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.body) continue
    if (!forwardIn(func.body)) continue
    invalidateProgramFactsCache(func.body); invalidateBodies([func.body])
    changed = true
  }
  return changed
}
