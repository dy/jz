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
 * The meet is monotone: meet(BOTTOM, x) = x, meet(x, x) = x, meet(x, y≠x) = TOP,
 * meet(TOP, _) = TOP. Over a finite height-2 lattice it converges with NO resets —
 * narrow.js's clearStickyNull (which used to un-stick a spurious "can't tell yet"
 * poison) is gone entirely (root B closed). Two complementary policies keep it so:
 *
 *   - `val` runs SOFT (narrow.js mergeRule soft=true): a can't-tell-yet site is
 *     skipped (stays BOTTOM), never poisoned, so a later pass — e.g. once pointer-
 *     ABI enrichment puts VAL.TYPED into callerValTypes — simply fills it in. A
 *     signature-mutating consumer (applyPointerParamAbi) can't trust this partial
 *     soft value, so it re-folds the sites HARD (hardParamVal); a final hard sweep
 *     settles `val` for emit + late readers (specializeBimorphicTyped, …).
 *   - `schemaId` (and the others) stay HARD, but no longer get stuck: narrowValResults
 *     is hoisted ABOVE the param lattice, so a call arg `f()` resolves to its VAL
 *     result on the first pass and the can't-tell poison never forms.
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

/** The meet itself: fold `observed` into a param's ValueRep field. BOTTOM
 *  (undefined) → observed; equal → unchanged; disagreement → TOP (null, sticky).
 *  A null `observed` is "can't tell" — whether that means BOTTOM (skip) or TOP
 *  (poison) is the *caller's* policy: narrow.js's soft mergeRule skips before
 *  calling here; the hard mergeRule / missing-arg path poisons by passing null. */
export const mergeParamFact = (rep, key, observed) => {
  if (rep[key] === null) return                                  // already TOP — sticky
  if (observed == null) { rep[key] = null; return }              // caller chose to poison (hard path)
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
