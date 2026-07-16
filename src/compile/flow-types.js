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
    const positiveEq = (op === '==' || op === '===') ? sense : !sense
    if (positiveEq) refineIntegerDiscriminant(cond[1], cond[2], out)
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

/** When an exact integer comparison uses an immutable `obj.tag` alias,
 * select the matching censused schema as a guarded fast-path hint. The runtime
 * sid guard remains the proof; the census only orders speculation. */
function refineIntegerDiscriminant(a, b, out) {
  const lit = n => typeof n === 'number' && Number.isInteger(n) ? n
    : Array.isArray(n) && n[0] == null && Number.isInteger(n[1]) ? n[1]
    : null
  let name, value
  const bv = lit(b), av = lit(a)
  if (typeof a === 'string' && bv != null) { name = a; value = bv }
  else if (typeof b === 'string' && av != null) { name = b; value = av }
  else return

  const alias = constPropAliases().get(name)
  if (!alias || ctx.module.writtenProps?.has(alias.prop)) return
  const matches = []
  for (let sid = 0; sid < ctx.schema.list.length; sid++) {
    if (ctx.schema.externSlotSids?.has(sid)) continue
    const slot = ctx.schema.list[sid]?.indexOf(alias.prop) ?? -1
    if (slot >= 0 && ctx.schema.slotConstInts?.get(sid)?.[slot] === value) matches.push(sid)
  }
  // This is a speculation hint, never a proof: host/external objects or a
  // construction site with a dynamic tag may share the same runtime value.
  // emitBranch must retain an exact-sid guard and the original dynamic fallback.
  if (matches.length === 1) mergeRefinement(out, alias.obj, { schemaHint: matches[0] })
}

/** Map immutable `const tag = obj.kind` aliases in the current function. */
function constPropAliases() {
  const body = ctx.func.body
  if (ctx.func._constPropAliasBody === body) return ctx.func._constPropAliases
  const out = new Map()
  const walk = (n, root = false) => {
    if (!Array.isArray(n)) return
    if (!root && (n[0] === '=>' || n[0] === 'function')) return
    if (n[0] === 'const') for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
          Array.isArray(d[2]) && d[2][0] === '.' &&
          typeof d[2][1] === 'string' && typeof d[2][2] === 'string')
        out.set(d[1], { obj: d[2][1], prop: d[2][2] })
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body, true)
  ctx.func._constPropAliasBody = body
  ctx.func._constPropAliases = out
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

/**
 * Find a profitable branch-local schema speculation.
 *
 * A branch that reads several fields from one unresolved receiver often narrows
 * to exactly one registered schema even when ordinary value-flow cannot prove
 * it (tagged unions are the canonical shape). The emitter can guard that schema
 * once, emit a direct-slot fast body, and retain the original dynamic body as
 * the fallback. The runtime guard, not this census, is the soundness proof.
 *
 * Returns the best `{ name, schemaIds, schemaSlots, accesses }`, or null. Nested closures are
 * excluded: they may run after the guarded branch and outlive its refinement.
 */
export function inferSchemaBranch(body) {
  const schemas = ctx.schema?.list
  if (!schemas?.length) return null
  const byName = new Map()
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=>' || op === 'function') return
    if (op === '.' && typeof n[1] === 'string' && typeof n[2] === 'string') {
      let row = byName.get(n[1])
      if (!row) byName.set(n[1], row = { props: new Set(), accesses: 0 })
      row.props.add(n[2]); row.accesses++
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body)

  let best = null
  for (const [name, row] of byName) {
    // One read already has the ordinary guarded-slot/devirt path. Version only
    // when a single guard amortizes over multiple dynamic accesses.
    if (row.accesses < 2 || isReassigned(body, name)) continue
    if (ctx.schema.idOf?.(name) != null) continue
    const candidates = []
    for (let sid = 0; sid < schemas.length; sid++) {
      const schema = schemas[sid]
      let carriesAll = true
      for (const prop of row.props) if (schema.indexOf(prop) < 0) { carriesAll = false; break }
      if (carriesAll) candidates.push(sid)
    }
    if (!candidates.length) continue
    // A bounded schema UNION is just as direct when every candidate lays each
    // accessed field at the same slot. Guard membership once, then all reads
    // share fixed offsets (e.g. {r} and {r,s}, or {w,h} and {w,h,d}).
    const schemaSlots = new Map()
    let compatible = true
    for (const prop of row.props) {
      const slot = schemas[candidates[0]].indexOf(prop)
      for (let i = 1; i < candidates.length; i++)
        if (schemas[candidates[i]].indexOf(prop) !== slot) { compatible = false; break }
      if (!compatible) break
      schemaSlots.set(prop, slot)
    }
    if (!compatible) continue
    const candidate = {
      name, schemaIds: candidates, schemaId: candidates.length === 1 ? candidates[0] : null,
      schemaSlots, accesses: row.accesses,
    }
    if (!best || candidate.accesses > best.accesses) best = candidate
  }
  return best
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
