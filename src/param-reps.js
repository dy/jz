/**
 * Cross-call paramReps lattice — Map<funcName, Map<paramIdx, ValueRep fields>>.
 *
 * Cycle-free leaf consumed by narrow.js (fixpoint) and infer.js (call-site
 * evidence producers). Sticky-null semantics: undefined → observe, equal → stay,
 * disagreement → null (poison until clearStickyNull).
 *
 * @module param-reps
 */

/** Build `paramName → fact` lookup for a caller's already-narrowed param facts. */
export const paramFactsOf = (paramReps, callerFunc, key) => {
  if (!callerFunc) return null
  const m = paramReps.get(callerFunc.name)
  if (!m) return null
  let out = null
  for (const [k, r] of m) {
    const v = r[key]
    if (v != null && k < callerFunc.sig.params.length) {
      out ||= new Map()
      out.set(callerFunc.sig.params[k].name, v)
    }
  }
  return out
}

/** Per-call-site fact merge into a param's ValueRep field. */
export const mergeParamFact = (rep, key, observed) => {
  if (rep[key] === null) return
  if (observed == null) { rep[key] = null; return }
  if (rep[key] === undefined) rep[key] = observed
  else if (rep[key] !== observed) rep[key] = null
}

/** Get-or-create per-param rep at (funcName, paramIdx) on a paramReps map. */
export const ensureParamRep = (paramReps, funcName, k) => {
  let m = paramReps.get(funcName)
  if (!m) { m = new Map(); paramReps.set(funcName, m) }
  let r = m.get(k)
  if (!r) { r = {}; m.set(k, r) }
  return r
}

/** Reset sticky-null on a single field across all params program-wide. */
export const clearStickyNull = (paramReps, key) => {
  for (const m of paramReps.values()) for (const r of m.values()) {
    if (r[key] === null) r[key] = undefined
  }
}
