/**
 * Freeze discipline for `programFacts` (v1 architecture-convergence, "facts
 * frozen before consumers" — .work/program-facts-split.md §7 has the full
 * lifecycle table and the subset-constraint audit this module's shape
 * follows; read that first). Two independent problems, two mechanisms:
 *
 *  1. `paramReps`/`callSites` are STAGED facts — published empty/raw by
 *     `collectProgramFacts`, then mutated in place by `narrow.js`'s
 *     `narrowSignatures` and its `specialize*` siblings across plan()'s
 *     rounds 2-3. `readonlyParamReps`/`freezeCallSites` below close each one
 *     off at its own true last-producer point (plan/index.js's own call
 *     sites document exactly where).
 *  2. `programFacts` itself is an OPEN BAG — `collectProgramFacts` returns a
 *     plain object with a fixed, documented key set, but nothing stops a
 *     later pass from stapling on an undocumented new one the way
 *     `plan/index.js` deliberately does for `callTargets`. `FACT_KEYS` +
 *     `assertProgramFactsShape` close that gap with an allowlist scan.
 *
 * SUBSET-SAFE BY CONSTRUCTION, same discipline as `call-target-index.js` and
 * `session-views.js` (this module sits in the self-hosted kernel's own
 * module graph — reachable from scripts/self.js via compile/index.js →
 * plan() → program-facts.js's barrel — so it is compiled BY jz, not merely
 * run by it):
 *
 *  - No `Proxy` (jz registers no Proxy global anywhere — session-views.js's
 *    own header, ctx.js's registerName doc: "Proxy traps aren't in the
 *    self-compilable subset").
 *  - `Object.freeze` is a real, enforcing freeze under native V8 execution
 *    but an IDENTITY PASSTHROUGH under jz's own self-hosted execution
 *    (module/object.js's own `Object.freeze` handler comment;
 *    function-plan.js:135 names the identical asymmetry as an
 *    already-accepted tradeoff elsewhere). `freezeCallSites` inherits this:
 *    real protection in `node test/index.js`, inert-but-harmless in
 *    `dist/jz.wasm` — matching `call-target-index.js`'s own
 *    `Object.freeze({resolveMember})`, already shipping.
 *  - `Object.seal`/`Object.preventExtensions` are not registered anywhere in
 *    `module/*.js` — calling either from kernel-reachable code risks an
 *    outright self-host compile failure (the `Object.defineProperty`
 *    precedent, module/object.js, shows an unrecognized-shape builtin
 *    becomes a hard compile-time `err(...)`), so `programFacts`'s shape is
 *    checked with `Object.keys` (which IS registered) instead of sealed.
 *
 * `readonlyParamReps`'s protection therefore comes from ORDINARY property
 * lookup, not from any freeze/trap primitive: the returned object simply has
 * no `.set`, so a caller that reaches for one gets a plain "is not a
 * function" TypeError — identical behavior natively and self-hosted, the
 * same idiom `call-target-index.js`'s `Object.freeze({resolveMember})`
 * already proves self-hostable.
 *
 * @module program-facts/freeze
 */
import { DBG_INVARIANTS } from '../../ctx.js'

/** The exact 20 names `collectProgramFacts` publishes (walk-facts.js's own
 *  return statement — program-facts-split.md §1's table cites the same list,
 *  minus `computedCallSites`, added after that doc's own snapshot ref by
 *  fix/string-method-guess's computed-dispatch-table synthesis: the raw
 *  `TABLE[key](args)` candidates `synthesizeComputedDispatchCallSites`
 *  resolves into real `callSites` entries — see that function's own doc)
 *  plus two staple-on keys `plan/index.js` adds afterward, both right after
 *  `buildCallTargetIndex`: `callTargets` itself (§7.1 — at the time of that
 *  audit, grep-verified the ONLY such site) and `dictKinds`
 *  (`buildDictKindIndex`, dict-kind-index.js — added later, same
 *  fix/string-method-guess branch, same shape: a whole-program index built
 *  once and stapled on for emit.js/narrow.js to read via `ctx.types`, never
 *  read back off `programFacts` itself past this file's own return). `plan/
 *  index.js`'s own `assertProgramFactsShape` call sits BETWEEN the two
 *  staples (right after `callTargets`, before `dictKinds`), so it only ever
 *  checks the `callTargets`-only snapshot today — `dictKinds` is listed here
 *  for the allowlist's own accuracy, not because any call currently checks a
 *  state where it's present. Any OTHER top-level key appearing on
 *  `programFacts` is an undocumented producer that bypassed this file's own
 *  contract. */
export const FACT_KEYS = new Set([
  'dynVars', 'dynWriteVars', 'anyDyn', 'propMap', 'valueUsed', 'callSites',
  'computedCallSites',
  'maxDef', 'maxCall', 'hasRest', 'hasSpread', 'paramReps', 'hasSchemaLiterals',
  'hasMapSet', 'hasBigint', 'writtenProps', 'literalWriteKeys', 'arrResized',
  'nameEscapes', 'literalObjectVars', 'callTargets', 'dictKinds',
])

/** Read-only view of a `paramReps`-shaped `Map<funcName, Map<paramIdx, rep>>`
 *  — exposes `.get`, the sole method every reader strictly after plan's
 *  round 3 needs (`analyzeSchemaSlotIntCertain`'s `collectBodyElemSids`,
 *  representation-plan.js's `makeBoundaryData`/`solveBigintProvenance` family
 *  — program-facts-split.md §7.1's table) — plus `.raw`, a plain (non-
 *  accessor) data property carrying the real Map back for `plan/index.js`'s
 *  OWN restore before it returns. `.raw` is a deliberately weaker guard than
 *  a hidden channel would be (anyone COULD write `paramReps.raw.set(...)`),
 *  chosen over a module-scope WeakMap-keyed lookup specifically for
 *  region-arena SAFETY: `plan()`'s plan-tail rounds (round(), `.work/
 *  program-facts-split.md` doesn't cover this, see plan/index.js's own doc)
 *  can relocate `programFacts` wholesale between install and restore under
 *  the self-hosted kernel's region allocator — anything reachable ONLY from
 *  a plain local variable held across such a boundary goes stale (the same
 *  hazard class `round()`'s own doc calls out for a cached `ctx.funcs.list`
 *  iterator). `.raw` stays reachable through `programFacts.paramReps` itself
 *  the whole time, so it rides along correctly with every relocation instead
 *  of needing its own root entry. `paramReps`'s true last writer is NOT
 *  scoped to `plan()` at all: `specializeUnionCursorParams` (narrow.js) is
 *  called from `compile/index.js`'s post-plan() `unionClones` phase and
 *  legitimately keeps minting new paramReps entries for the clones IT
 *  creates (§7.2) — a view that outlived `plan()`'s return would make that
 *  call throw, so `plan/index.js` always restores via `.raw` before
 *  returning. */
export function readonlyParamReps(paramReps) {
  return Object.freeze({ get: k => paramReps.get(k), raw: paramReps })
}

/** Freeze `callSites` (array + each entry) once its own last producer —
 *  plan round 3 — is done. Unlike `paramReps`, grep-verified PERMANENT: no
 *  code anywhere (including `compile/index.js`'s post-plan() emit phase)
 *  writes to `programFacts.callSites` again, so this is a genuine
 *  frozen-forever publish, not a scoped view — no restore call needed. */
export function freezeCallSites(callSites) {
  for (const cs of callSites) Object.freeze(cs)
  return Object.freeze(callSites)
}

/** Dev/test-only shape check (mirrors narrow.js's `assertValKindConsistent` /
 *  session-views.js's `assertMidCompile`: opt-in via JZ_DEBUG_INVARIANTS=1,
 *  zero cost otherwise). Throws if `programFacts` carries any top-level key
 *  outside `FACT_KEYS` — the container-level twin of the two Map/Array
 *  freezes above, catching a future undocumented staple-on the way
 *  `callTargets` itself was added deliberately (§7.1). */
export function assertProgramFactsShape(programFacts, label) {
  if (!DBG_INVARIANTS) return
  for (const k of Object.keys(programFacts))
    if (!FACT_KEYS.has(k))
      throw new Error(`[program-facts] ${label}: unexpected key '${k}' on programFacts — every top-level fact needs a single documented producer (program-facts-split.md §7); add it to FACT_KEYS in program-facts/freeze.js if this is a genuine new staged fact`)
}
