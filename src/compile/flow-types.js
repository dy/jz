/**
 * Flow-sensitive type refinement.
 *
 * A `typeof x === 'string'` guard, an `instanceof` check, or an `Array.isArray(x)`
 * call inside an `if` cond proves something about `x` in the then-branch. Encoded
 * here as a `name → {val?, notString?}` Map (the "refinements" set) installed into
 * `ctx.func.refinements` for the duration of the branch.
 *
 * Lifecycle: every emit site that descends into a conditional branch wraps the
 * inner emit() in `withRefinements(refs, body, () => emit(b))`. Saves/restores
 * the prior ctx state and skips refinement for names reassigned inside `body`
 * (refinement would be unsound).
 *
 * Read side: lookupValType (src/reps.js) checks ctx.func.refinements first —
 * see its lookup-priority docs.
 *
 * @module compile/flow-types
 */

import { ctx } from '../ctx.js'
import { VAL } from '../reps.js'
import { isReassigned, TYPEOF } from '../ast.js'
import { typeofPredicate } from './infer.js'

const TYPEOF_CODE_TO_VAL = { [TYPEOF.number]: VAL.NUMBER, [TYPEOF.string]: VAL.STRING, [TYPEOF.function]: VAL.CLOSURE }

/** Walk a boolean condition gathering refinements implied for the `sense` branch
 *  (sense=true = then-branch, sense=false = else-branch). `out` is a Map mutated
 *  in place; returns the same Map for chaining. */
export function extractRefinements(cond, out, sense = true) {
  if (!Array.isArray(cond)) return out
  const op = cond[0]
  // ! flips sense
  if (op === '!') return extractRefinements(cond[1], out, !sense)
  // && under positive sense refines with union of both branches.
  // || under negative sense (De Morgan) similarly refines the else-branch.
  if (op === '&&' && sense)  { extractRefinements(cond[1], out, true);  extractRefinements(cond[2], out, true);  return out }
  if (op === '||' && !sense) { extractRefinements(cond[1], out, false); extractRefinements(cond[2], out, false); return out }
  // typeof x == 'number' | 'string' | 'function' — sense must be positive for "==", negative for "!="
  if ((op === '==' || op === '===' || op === '!=' || op === '!==')) {
    const tp = typeofPredicate(cond)
    if (tp) {
      const wantPositive = tp.eq ? sense : !sense
      if (wantPositive) {
        const val = TYPEOF_CODE_TO_VAL[tp.code]
        if (val) mergeRefinement(out, tp.name, { val })
      } else if (tp.code === 'string' || tp.code === TYPEOF.string) {
        // Negative branch of typeof-string guard (e.g. post `if (typeof x === 'string') return`)
        // proves the binding is not a primitive string in the suffix scope — feeds B4's
        // length / subscript dispatch elision the same way write-shape evidence does.
        mergeRefinement(out, tp.name, { notString: true })
      }
    }
    return out
  }
  // Type-predicate calls under positive sense — refine by the asserted VAL.
  // Callee may be the flattened string 'Array.isArray' or the raw ['.', 'Array',
  // 'isArray'] pair; __is_map / __is_set / __is_typed come from jzify's
  // instanceof lowering as a bare string callee.
  if (op === '()' && sense && typeof cond[2] === 'string') {
    const callee = cond[1]
    const val = predicateRefinement(callee)
    if (val != null) { mergeRefinement(out, cond[2], { val }); return out }
  }
  return out
}

/** Map a call-callee shape to the VAL kind it asserts under positive sense, or null. */
export function predicateRefinement(callee) {
  if (callee === 'Array.isArray') return VAL.ARRAY
  if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Array' && callee[2] === 'isArray')
    return VAL.ARRAY
  if (callee === '__is_map') return VAL.MAP
  if (callee === '__is_set') return VAL.SET
  if (callee === '__is_typed') return VAL.TYPED
  return null
}

/** Merge a refinement fact into the per-name slot. Later facts override; non-overlapping
 *  fields union. Keeps the call-side simple (always assign through this). */
export function mergeRefinement(out, name, fact) {
  const cur = out.get(name)
  out.set(name, cur ? { ...cur, ...fact } : fact)
}

/** Apply refinements for the duration of `fn()`. Restores prior state on return/throw. */
export function withRefinements(refs, body, fn) {
  if (!refs || refs.size === 0) return fn()
  const cur = ctx.func.refinements
  // Drop names that are reassigned in the body — refinement would be unsound.
  const saved = []
  for (const [name, val] of refs) {
    if (isReassigned(body, name)) continue
    saved.push([name, cur.get(name)])
    cur.set(name, val)
  }
  try { return fn() }
  finally {
    for (const [name, prev] of saved) {
      if (prev === undefined) cur.delete(name); else cur.set(name, prev)
    }
  }
}
