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

/** Convergence signal for change-driven fixpoints (Stage 2 solver): every
 *  lattice transition through the meet below (and the few direct-writer rules
 *  in narrow.js) sets `changed`; a fixpoint loop clears it per sweep and stops
 *  on the first quiet sweep. Replaces the "run it twice" guess — a fixed
 *  iteration count either wastes a sweep or, on deep call chains, stops short. */
export const latticeMeet = { changed: false }

/** The meet itself: fold `observed` into a param's ValueRep field. BOTTOM
 *  (undefined) → observed; equal → unchanged; disagreement → TOP (null, sticky).
 *  A null `observed` is "can't tell" — whether that means BOTTOM (skip) or TOP
 *  (poison) is the *caller's* policy: narrow.js's soft mergeRule skips before
 *  calling here; the hard mergeRule / missing-arg path poisons by passing null. */
export const mergeParamFact = (rep, key, observed) => {
  if (rep[key] === null) return                                  // already TOP — sticky
  if (observed == null) { rep[key] = null; latticeMeet.changed = true; return }     // caller chose to poison (hard path)
  if (rep[key] === undefined) { rep[key] = observed; latticeMeet.changed = true }   // BOTTOM → first observation
  else if (rep[key] !== observed) { rep[key] = null; latticeMeet.changed = true }   // disagreement → TOP
}

/** Get-or-create per-param rep at (funcName, paramIdx) on a paramReps map. */
export const ensureParamRep = (paramReps, funcName, k) => {
  let m = paramReps.get(funcName)
  if (!m) { m = new Map(); paramReps.set(funcName, m) }
  let r = m.get(k)
  if (!r) { r = {}; m.set(k, r) }
  return r
}

/**
 * Fact — the product-lattice record (`.work/lattice-design.md` §1). Each field
 * gets the algebra its OWN question requires instead of one poison-on-disagreement
 * meet forced onto everything (mergeParamFact above is that meet — correct for
 * `numeric`'s universal "does every write fit i32" question, wrong for an
 * existential "which kinds was this ever observed as" question — FINDING-7 /
 * lattice-design.md §thesis). Landed as a shape + primitive precondition
 * (design §5, Slice 0); `possibleKinds` itself is populated for paramReps'
 * `val` as of Slice 4a (narrow.js's `mergeRule('val', …, trackKind=true)` +
 * the two typed-clone override sites) — `val` keeps its own meet/sticky-null
 * behavior byte-identical alongside it (design's 4a spec, OQ1-compliant: no
 * consumer reads `possibleKinds` yet, so there is nothing to opt in).
 *
 * @typedef {Object} Fact
 * @property {Set<string>} possibleKinds  Powerset over VAL.*. BOTTOM = ∅ (unobserved).
 *   Join = ∪. Never null/undefined for a resolved key — TOP is the full 14-member
 *   Set, an ordinary member of the same type as every narrowed answer (§1.6).
 * @property {boolean} presence  false = PRESENT, true = MAYBE_UNDEF. Join = ∨
 *   (monotone OR, same algebra as today's `mayBeUndefined`, re-homed only).
 * @property {Set<string>|'ALL'} pointsTo  Powerset over SchemaId, or the literal
 *   string `'ALL'` as an abstract top sentinel (never a materialized snapshot —
 *   §1.3). Join = ∪, with `'ALL'` absorbing.
 * @property {{level: 0|1|2, range: [number,number]|null}} numeric  MEET-semilattice,
 *   unchanged polarity from today's `slotIntLevels` (§1.4) — a universal claim
 *   ("every observed write fits i32"), so this field alone stays a meet, not a join.
 * @property {Set<'raw'|'boxed'|'tagged'>} rep  Powerset over carrier class. Join = ∪.
 */

/**
 * Join (union) an observed set of kinds into `fact[key]` — the existential
 * counterpart to `mergeParamFact`'s meet, for fields whose sound algebra is
 * "wider on disagreement," never "poison on disagreement" (§thesis, FINDING-2).
 * BOTTOM is `∅`: an absent `fact[key]` is created as an empty Set on first use,
 * never left `undefined`/`null` (§1.6 — no second sentinel-typed "unknown").
 * Reuses `latticeMeet.changed` as the SAME convergence signal `mergeParamFact`
 * drives, so a fixpoint loop can watch one flag regardless of which fields it
 * touches this round.
 *
 * @param {Object} fact single Fact-shaped record (or any object with Set-valued fields)
 * @param {string} key field name on `fact`
 * @param {Iterable<*>} observedSet kinds observed at this site (may be a singleton)
 */
export const joinKinds = (fact, key, observedSet) => {
  let set = fact[key]
  if (!set) { set = new Set(); fact[key] = set }
  for (const k of observedSet) {
    if (!set.has(k)) { set.add(k); latticeMeet.changed = true }
  }
}

/**
 * THE authoritative Fact/rep clone (audit-#16 P1-3): `{ ...r }` shallow-copies
 * Set-valued lattice fields, so a join on the clone silently mutates the
 * source (confirmed live — a specialization's observation leaked into its
 * origin's possibleKinds). Every rep-copy path MUST use this instead of a
 * bare spread; new Set-valued Fact fields (pointsTo, rep) get their line here
 * when they land, nowhere else.
 */
export const cloneRep = (r) => {
  const c = { ...r }
  if (r.possibleKinds) c.possibleKinds = new Set(r.possibleKinds)
  return c
}

/**
 * Exclusion-projection contract (audit-#16 P0-1, second half): `possibleKinds`
 * with ∅ means ZERO observations (BOTTOM — an unanalyzed, exported,
 * host-callable, or never-called binding), NOT "no kinds possible". Any
 * projection that EXCLUDES a kind (`cannotBe`/disjointness over this field)
 * must fail closed — return "cannot exclude" — when the set is empty or the
 * fact is absent. Only a non-empty set (every live observation joined, with
 * unresolvable observations joining the full KIND_UNIVERSE per narrow.js's
 * mergeRule) may prove exclusion.
 */
