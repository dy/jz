/**
 * Pre-analysis passes — type inference, local analysis, capture detection.
 *
 * # Stage contract
 *   IN:  prepared AST + ctx.funcs.list (from prepare).
 *   OUT: per-function populated `ctx.func.localReps` (val field) + `ctx.func.locals` + `ctx.func.boxed`,
 *        module-global `ctx.scope.globalValTypes`, type-analysis `ctx.func.typedElem` /
 *        `.dynKeyVars` / `.anyDynKey`.
 *
 * # Passes (all walk AST; none mutate AST itself — only ctx)
 *   - boxedCaptures:       detect mutably-captured vars → ctx.func.boxed cells
 *
 * Value KIND inference: src/kind.js. WASM local typing: src/type.js. Static eval: src/static.js.
 *
 * Ordering: all passes run per function during compile(). plan.js owns the
 * cross-function dynKey scan via programFacts (results land in ctx.types.dynKeyVars).
 *
 * # File layout (pipeline-minimality split)
 * This file is a stable re-exporting barrel — every external import keeps
 * working unchanged (`from './analyze.js'`). The implementation lives under
 * `src/compile/analyze/`, split along the real internal seams:
 *   - `analyze/trackers.js`       — per-name monotone fact trackers shared
 *                                   by body-facts.js and val-types.js
 *   - `analyze/body-facts.js`     — analyzeBody + its cache seam + widening
 *   - `analyze/val-types.js`      — analyzeValTypes, analyzeIntCertain,
 *                                   mayBeNullish, dict/map-shaped helpers
 *   - `analyze/ptr-eligibility.js`— unboxablePtrs, inheritPtrAliases,
 *                                   cseSafeLoadBases
 *   - `analyze/struct-inline.js`  — analyzeStructInline
 *   - `analyze/union-inline.js`   — analyzeUnionInline
 *   - `analyze/func-namespaces.js`— analyzeFuncNamespaces
 * `src/compile/analyze-scans.js` (findFreeVars/findMutations/boxedCaptures/
 * scanBindingUses/etc.) is a separate, pre-existing, already-scoped module —
 * not moved. See `.work/archive/analyze-traversals.md` for the full traversal
 * inventory and split rationale.
 *
 * @module analyze
 */

export {
  resetBodyFactsCache, analyzeBody, invalidateLocalsCache, reanalyzeBody,
  setFuncBody, invalidateBodies, invalidateAllBodyFacts,
} from './analyze/body-facts.js'

export { mayBeNullish, analyzeValTypes, analyzeIntCertain } from './analyze/val-types.js'

export { unboxablePtrs, inheritPtrAliases, cseSafeLoadBases } from './analyze/ptr-eligibility.js'

export { analyzeStructInline } from './analyze/struct-inline.js'

export { analyzeUnionInline } from './analyze/union-inline.js'

export { analyzeFuncNamespaces } from './analyze/func-namespaces.js'

export { findFreeVars, findMutations, boxedCaptures } from './analyze-scans.js'
