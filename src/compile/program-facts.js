/**
 * Whole-program fact collection — dyn keys, call sites, schema slots.
 *
 * Stable entry point / barrel: every name this module ever exported still
 * comes from here, unchanged, so no consumer import path changes (v1
 * architecture campaign, `.work/archive/v1-architecture-campaign.md` — the
 * program-facts.js split, second step after the frozen ProgramIndex,
 * `program-index.js`). The actual builders live in `program-facts/`,
 * one small single-purpose module per fact family, each with its own
 * explicit import list (no module imports a symbol it doesn't call).
 *
 * ## Module map (dependency order — each layer only imports layers above it;
 * `shared.js` and `cache.js` depend on nothing else here):
 *
 *   1. `program-facts/shared.js`   — cross-family primitives two builders
 *      below share (`ARR_RESIZE_METHODS`, `collectBodyElemSids`,
 *      `effectiveWriteValue`) — see that file's own header for which two.
 *   1. `program-facts/cache.js`    — fact-store cache lifecycle
 *      (`resetProgramFactsCache`, `invalidateProgramFactsCache`); reads/
 *      resets the same `getFactStore().programFacts` (`gen`/`walkCache`/
 *      `moduleInitSlot`/`bodyIntCertain`/`hazard`) every builder below uses.
 *   2. `program-facts/slot-write-hazards.js` — `collectSlotWriteHazards` /
 *      `applySlotWriteHazards`: every way a schema slot can change OTHER
 *      than a `{}` literal or a resolvable `.prop=` write. Depends only on
 *      `shared.js`.
 *   3. `program-facts/slot-kind-census.js`  — `observeProgramSlots`: the
 *      per-slot VAL-kind / typed-ctor / bigint-observed / dict-and-map-
 *      value-kind census. Calls `collectSlotWriteHazards` to poison what it
 *      can't resolve.
 *   3. `program-facts/slot-int-census.js`   — `analyzeSchemaSlotIntCertain`:
 *      the per-slot int-certain / i32-certain census, a greatest-fixpoint
 *      sibling of the kind census over the SAME write shapes. Also calls
 *      `collectSlotWriteHazards` (same hazard cache, keyed by `(gen, late)`
 *      — a same-mode call in the same generation is a cache hit, not a
 *      recompute). Independent of slot-kind-census.js — neither calls the
 *      other.
 *   4. `program-facts/param-never-grown.js` — `analyzeParamNeverGrown`:
 *      cross-function array-growth-freedom proof for raw-base param reads.
 *      Independent of the whole slot-census family (array facts, not schema
 *      facts) — depends only on `shared.js`.
 *   5. `program-facts/walk-facts.js` — `observeNodeFacts` / `collectProgramFacts` /
 *      `synthesizeComputedDispatchCallSites`:
 *      the whole-program AST walk (dyn keys, escapes, call sites) and its
 *      orchestrator. `collectProgramFacts` conditionally calls
 *      `observeProgramSlots` (3) and, in turn, `analyzeSchemaSlotIntCertain`
 *      (3) — the two slot censuses run as part of ONE `collectProgramFacts`
 *      pass, kind census before int census (int census's hazard call is a
 *      cache hit as a result, not a correctness order — see analyzeBody call
 *      graph in that file for the exact `hasSchemaLiterals`/`hasMapSet` gates).
 *      `synthesizeComputedDispatchCallSites` is a separate, later entry point
 *      used while ProgramIndex remains local to plan(). It resolves
 *      `collectProgramFacts`'s stashed `computedCallSites` candidates, enriches
 *      `callSites` in place, and finishes before ProgramIndex freezes numeric
 *      direct edges and roots. See its own doc comment for the two-hop
 *      (named-member / inline-arrow-member) resolution it performs.
 *   6. `program-facts/freeze.js` — `readonlyParamReps`/`freezeCallSites`/
 *      `assertProgramFactsShape`: the freeze discipline for the two STAGED
 *      facts (`paramReps`/`callSites`, settled by `plan/index.js`'s own round
 *      3, not by this module) and for `programFacts`'s own closed key-set.
 *      Depends on nothing else here — a leaf, like `shared.js`/`cache.js`.
 *
 * External build order (documented in full in `plan/index.js`, cited here
 * so it's discoverable from this side too): `collectProgramFacts` runs once
 * per compile as the EARLY pass (pre-narrowing receivers); after
 * `narrowSignatures` settles `programFacts.paramReps`, `plan/index.js` calls
 * `observeProgramSlots` again (`{fresh:true}` — late-mode rebuild with
 * narrowed receivers), then `analyzeParamNeverGrown`, then
 * `analyzeSchemaSlotIntCertain` again (same late-mode rebuild). Every one of
 * these later calls is a REBUILD (clears and re-derives), never an
 * incremental patch of the earlier pass's output — see `.work/archive/program-facts-split.md`
 * §7 for the full fact-to-producer-to-consumer table: `paramReps` and
 * `.callSites` are mutated in place after publication through plan's own
 * round 3 (`narrowSignatures` and its `specialize*` siblings), then frozen or
 * view-wrapped by `plan/index.js` via this module's own `freeze.js`. The mutable
 * `addressTakenNames` ends earlier: ProgramIndex applies lifted-value release,
 * converts the source-name census to numeric address-taken bits, and deletes
 * the key before any later consumer.
 *
 * @module program-facts
 */
export { observeNodeFacts, collectProgramFacts, synthesizeComputedDispatchCallSites, synthesizeMemberDispatchCallSites } from './program-facts/walk-facts.js'
export { resetProgramFactsCache, invalidateProgramFactsCache } from './program-facts/cache.js'
export { observeProgramSlots } from './program-facts/slot-kind-census.js'
export { analyzeSchemaSlotIntCertain } from './program-facts/slot-int-census.js'
export { collectSlotWriteHazards, applySlotWriteHazards } from './program-facts/slot-write-hazards.js'
export { analyzeParamNeverGrown } from './program-facts/param-never-grown.js'
export { effectiveWriteValue } from './program-facts/shared.js'
export { readonlyParamReps, freezeCallSites, assertProgramFactsShape, FACT_KEYS } from './program-facts/freeze.js'
