/**
 * program-facts split — cross-family primitives shared by two otherwise-
 * independent fact builders, so neither module owns them outright (mirrors
 * `analyze/trackers.js`'s identical reason for existing). See
 * `../program-facts.js` for the full module map and build order.
 *   - `ARR_RESIZE_METHODS`: walk-facts.js's `observeNodeFacts` (arrResized)
 *     and param-never-grown.js's `analyzeParamNeverGrown` (growth-freedom scan).
 *   - `collectBodyElemSids`: slot-write-hazards.js's `collectSlotWriteHazards`
 *     and slot-int-census.js's `analyzeSchemaSlotIntCertain` (late-mode
 *     body-local element-alias sids — both must resolve receivers identically
 *     or the hazard scan poisons slots the census just proved).
 *   - `effectiveWriteValue`: slot-kind-census.js's `observeProgramSlots` and
 *     slot-int-census.js's `analyzeSchemaSlotIntCertain` (compound-assign /
 *     inc-dec's effective stored value). Also part of this module's public
 *     API surface (re-exported from the barrel).
 * @module program-facts/shared
 */
import { analyzeBody } from '../analyze.js'

// Array methods that can change length or relocate the payload (grow copies to a
// new arena block and forwards the header). sort/reverse/fill/copyWithin mutate
// elements IN PLACE — base and len stay put — so they are deliberately absent.
export const ARR_RESIZE_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice'])
/** Body-local element-alias sids: single-`=` bindings whose init is a whole
 *  element read of an array with a known element schema (local decl facts or a
 *  narrowed param's arrayElemSchema — the latter exists only post-narrowing).
 *  Shared by the late slot-int census and the hazard scan so both resolve
 *  receivers equally (a hazard scan weaker than the census would poison the
 *  very slots the census just proved). */
export function collectBodyElemSids(func, paramReps) {
  if (!paramReps || !func?.body || func.raw) return null
  const facts = analyzeBody(func.body)
  const reps = paramReps.get(func.name)
  const paramIdx = new Map((func.sig?.params || []).map((p, k) => [p.name, k]))
  const elemSidOf = (arr) => facts.arrElemSchemas?.get(arr)
    ?? (paramIdx.has(arr) ? reps?.get(paramIdx.get(arr))?.arrayElemSchema : null)
  const sids = new Map(), writes = new Map()
  const scan = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === '=' && typeof n[1] === 'string') {
      writes.set(n[1], (writes.get(n[1]) || 0) + 1)
      const rhs = n[2]
      if (Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 && typeof rhs[1] === 'string') {
        const sid = elemSidOf(rhs[1])
        if (sid != null) sids.set(n[1], sid)
      }
    }
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  scan(func.body)
  for (const [name, c] of writes) if (c > 1) sids.delete(name)
  return sids.size ? sids : null
}

/** The value a compound assignment / inc-dec effectively stores — synthesized
 *  so census value-analyses (isIntExpr, kind checks) see the real shape:
 *  `o.n++` → `['+', o.n, 1]` (self-referential, resolved by the censuses' own
 *  optimistic fixpoint), `o.f ||= x` → either arm. */
export function effectiveWriteValue(op, lhs, rhs) {
  if (op === '=') return rhs
  if (op === '++' || op === '--') return [op === '++' ? '+' : '-', lhs, [null, 1]]
  if (op === '&&=' || op === '||=' || op === '??=') return ['?:', lhs, lhs, rhs]
  return [op.slice(0, -1), lhs, rhs]
}
