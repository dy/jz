/**
 * A test the summary decided takes one arm on every run (summary/index.js
 * `decided`: a member of a primitive, a nullish comparison, `instanceof` of a
 * built-in class, Array.isArray, typeof, and their `!`, `&&`, `||`). The
 * summary walked that arm alone; the other is dead, and left in place it
 * compiles as code of no known kind, a call in it keeping alive a function
 * nothing live calls (a stream path beside the batch one every caller takes).
 * The plan drops it.
 *
 * @module compile/plan/fold-kind-tests
 */
import { ctx } from '../../ctx.js'

const isArr = Array.isArray

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
          // the arm taken, or an empty statement (`null`) for an `if` with none
          n[j] = (t ? c[2] : c[3]) ?? null
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
