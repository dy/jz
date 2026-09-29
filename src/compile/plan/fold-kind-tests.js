/**
 * A test the summary decided takes one arm on every run (summary/index.js
 * `decided`: a member of a primitive, a nullish comparison, `instanceof` of a
 * built-in class, Array.isArray, typeof, and their `!`, `&&`, `||`). The
 * summary walked that arm alone; the other is dead, and left in place it
 * compiles as code of no known kind, a call in it keeping alive a function
 * nothing live calls (a stream path beside the batch one every caller takes).
 * The plan drops it. A decision leaves the test's own evaluation to run: it
 * goes with the dead arm only where evaluating it can do nothing.
 *
 * @module compile/plan/fold-kind-tests
 */
import { ctx } from '../../ctx.js'

const isArr = Array.isArray
const isLit = (e) => isArr(e) && (e[0] == null || e[0] === 'str')
const isNullishLit = (e) => isArr(e) && e[0] == null && e[1] == null

// A test whose evaluation can do nothing: a name, a literal, typeof,
// instanceof or Array.isArray of names, a strict comparison of such, a loose
// one that converts nothing (against a nullish literal, or of two strings),
// and !, && and || of these. Any other still runs where its test stood: a
// call's effect, the throw of a member read through a missing receiver.
const inert = (e) => {
  if (!isArr(e)) return true
  const op = e[0]
  if (op == null || op === 'str') return true
  if (op === 'typeof') return typeof e[1] === 'string'
  if (op === 'instanceof') return typeof e[1] === 'string' && typeof e[2] === 'string'
  if (op === '()') return e.length === 2 ? inert(e[1]) : e[1] === 'Array.isArray' && e.length === 3 && typeof e[2] === 'string'
  if (op === '!' || op === '&&' || op === '||' || op === '===' || op === '!==') return e.slice(1).every(inert)
  if (op === '==' || op === '!=') {
    const strish = (x) => isLit(x) || (isArr(x) && x[0] === 'typeof')
    return inert(e[1]) && inert(e[2]) && (isNullishLit(e[1]) || isNullishLit(e[2]) || (strish(e[1]) && strish(e[2])))
  }
  return false
}

/** Fold every decided `if` and `?:` in the program's functions. Returns whether any folded. */
export const foldKindTests = () => {
  const summary = ctx.summary
  if (!summary?.decisionOf) return false
  let changed = false
  const walk = (n) => {
    if (!isArr(n)) return
    for (let j = 1; j < n.length; j++) {
      const c = n[j]
      if (!isArr(c)) continue
      if (c[0] === 'if' || c[0] === '?:' || c[0] === '?') {
        const t = summary.decisionOf(c)
        if (t != null) {
          // the arm taken, or an empty statement (`null`) for an `if` with none,
          // after the test where evaluating it may do something; an empty
          // statement leaves a sequence that keeps another
          const arm = (t ? c[2] : c[3]) ?? null
          const out = inert(c[1]) ? arm : c[0] !== 'if' ? [',', c[1], arm] : arm == null ? c[1] : ['{}', [';', c[1], arm]]
          if (out == null && n[0] === ';' && n.length > 2) n.splice(j, 1)
          else n[j] = out
          changed = true
          j--
          continue
        }
      }
      walk(c)
    }
  }
  for (const f of ctx.funcs.list) if (f.body && !f.raw) walk(f.body)
  return changed
}
