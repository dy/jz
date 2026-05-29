/**
 * Cross-call paramReps lattice — Map<funcName, Map<paramIdx, ValueRep fields>>.
 *
 * Cycle-free leaf consumed by narrow.js (fixpoint) and infer.js (call-site
 * evidence producers).
 *
 * THE LATTICE (per field). Three states:
 *   - BOTTOM = `undefined`  — unobserved / "no site has spoken yet".
 *   - a value               — consensus across all sites seen so far.
 *   - TOP    = `null`        — conflict: two sites disagreed. Sticky.
 *
 * The intended meet is monotone: meet(BOTTOM, x) = x, meet(x, x) = x,
 * meet(x, y≠x) = TOP, meet(TOP, _) = TOP. A monotone meet over a finite height-2
 * lattice converges in ONE fixpoint with no resets.
 *
 * KNOWN NON-MONOTONICITY (root B — to be removed in the planned lattice refactor).
 * mergeParamFact below folds a THIRD input — `observed == null`, meaning "this
 * call site can't determine the fact *yet*" (its own dependency isn't typed) —
 * into TOP, when it should be treated as BOTTOM (skip, no poison). That spurious
 * poison is why narrow.js calls clearStickyNull between phases to un-stick it and
 * re-run the fixpoint. The monotone fix exists for the arrayElem fields (narrow.js
 * runArrElemFixpoint): a SOFT merge that skips on null and iterates to a fixpoint,
 * then ONE hard validating sweep that poisons params still unproven.
 *
 * BUT generalizing that to val/schemaId is NOT a drop-in (attempted + reverted —
 * see .work/todo.md step 8): unlike arrayElem, val/schemaId are consumed by
 * narrowing passes (applyPointerParamAbi, which trusts r.val without re-checking
 * sites) that run BEFORE valResult is known. A hard sweep there over-poisons the
 * "not computed yet" case (breaks `sumScaled(initRows(), 3)`); pure soft
 * under-guards the "one site typed, another genuinely-untyped" case. The real fix
 * needs the consumption reordered after all refinement, or consumers made
 * site-coverage-aware — a larger restructuring, not a meet tweak.
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

/** Per-call-site fact merge into a param's ValueRep field (the non-monotone meet
 *  documented above — `observed == null` poisons rather than skipping; the planned
 *  refactor replaces this with a soft merge that treats null as BOTTOM). */
export const mergeParamFact = (rep, key, observed) => {
  if (rep[key] === null) return                                  // already TOP — sticky
  if (observed == null) { rep[key] = null; return }              // NON-MONOTONE: should be BOTTOM (skip)
  if (rep[key] === undefined) rep[key] = observed                // BOTTOM → first observation
  else if (rep[key] !== observed) rep[key] = null                // disagreement → TOP
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
