/**
 * CompileSession begin — the ONE owner of per-compile lifecycle state (audit
 * P1, stage 4): ctx reset, every explicit-lifecycle cache clear, watr name-uid
 * reset, error-source binding, warnings sink, and options normalization
 * (resolveOptimize → optFlags). Host (index.js setupCtx) and self-host kernel
 * (scripts/self.js setupSelf) both call THIS for the shared core, so the two
 * setups cannot drift again (they had: the kernel cleared DOLLAR/stdlib caches
 * natively left to GC, native reset name-uids the kernel initially missed —
 * both directions of drift are documented in each file's history).
 *
 * Host-specific configuration (memory pages, imports marshaling, transform
 * injection, feature flags) stays with each caller — it is per-host POLICY,
 * not session lifecycle. The fuller CompileSession object (counters,
 * diagnostics, TargetProfile) grows here; this is the seam.
 *
 * @module src/session
 */
import { ctx, reset, initWarnings, assertCtxInvariants, optFlagsOf, getFactStore, resetFactStore } from './ctx.js'
import { clearDollar } from './ir.js'
import { clearStdlibParseCache } from './wat/assemble.js'
import { resolveOptimize } from './optimize/index.js'
import { resetNameUids } from 'watr/optimize'

export { getFactStore }

/**
 * Fact-store slices (audit P1, stage 5): program-facts.js / analyze.js /
 * analyze-scans.js used to keep their walk/body/binding-use memos in private
 * module-level Maps/WeakMaps, each cleared by its own resetXCache() export
 * called individually from beginSession. Session-owned now — ONE object,
 * (re)created fresh every beginSession — so a slice's lifetime is exactly
 * "this compile" without a separate reset call per module to remember. The
 * cache modules keep their existing resetXCache()/invalidateXCache() API;
 * internally those now read/write the slice below via getFactStore() instead
 * of a private module-level store.
 *
 * DEPS (what invalidates each slice — declared per the audit's ask; full
 * dependency-tracking machinery, e.g. auto-derived invalidation from a
 * declared read-set, is a later increment):
 *
 *   programFacts.walkCache      per-AST-root whole-program walk memo
 *                                (program-facts.js walkFactsRoot). Invalidated by:
 *                                (a) a fresh session (wholesale, new store);
 *                                (b) invalidateProgramFactsCache(root) for an
 *                                    in-place AST rewrite of one root (plan's
 *                                    flattenFuncNamespaces and friends).
 *   programFacts.moduleInitSlot per-module-init-node slot-observation memo
 *                                (observeProgramSlots). Same DEPS as walkCache —
 *                                shares its `gen` counter and reset call.
 *   programFacts.bodyIntCertain per-body int-certainty memo
 *                                (analyzeSchemaSlotIntCertain). Same DEPS as
 *                                walkCache, PLUS: dropped mid-pass whenever a
 *                                slot-int census round flips (a newly-poisoned
 *                                slot can invalidate a checker baked from the
 *                                previous round's optimism — see the `rounds`
 *                                loop in analyzeSchemaSlotIntCertain).
 *   programFacts.hazard          slotWriteHazards memo, keyed by (gen, late)
 *                                (collectSlotWriteHazards). Same DEPS as
 *                                walkCache; the `late` flag is compared on
 *                                read, not a separate invalidation path.
 *   bodyFacts                    analyzeBody's per-function-body memo (locals,
 *                                valTypes, arrElemSchemas, …). Invalidated by:
 *                                (a) a fresh session (wholesale); (b)
 *                                invalidateLocalsCache(body) at the phase
 *                                boundaries where narrowing can retype a
 *                                body's locals underneath the cache — UNCHANGED
 *                                this increment (13 call sites; see
 *                                .work/todo.md next-slice note — this is the
 *                                staleability contract, not storage, so it's
 *                                out of scope here).
 *   bindingUses                  scanBindingUses's per-body free/mutated-name
 *                                summary. Invalidated by: a fresh session only
 *                                (wholesale) — no surgical invalidation exists;
 *                                callers that structurally mutate a body scan a
 *                                fresh body reference rather than reusing the
 *                                cached one.
 *
 * ASSERT (a slice reset clears its dependents): programFacts's three
 * sub-caches share ONE `gen` counter and are always recreated together —
 * resetProgramFactsCache() cannot drop walkCache without also bumping `gen`,
 * which structurally invalidates moduleInitSlot and bodyIntCertain entries on
 * their next read (the `hit.gen === pf.gen` guard at each call site) even
 * before their own WeakMaps are swapped. There is no code path that clears one
 * sub-cache while leaving a dependent's stale entries live-reachable.
 *
 * Storage + getFactStore()/resetFactStore() live in src/ctx.js, not here —
 * see that module's comment for why (a module-cycle constraint, not a design
 * preference). This is still the documented seam: beginSession is the only
 * caller of resetFactStore(), and getFactStore() is re-exported above.
 */

/**
 * Reset all per-compile state and normalize options. Returns the resolved
 * optimize cfg (also installed on ctx.transform).
 * @param {object} p
 * @param {object} p.emitter    emitter table (reset() contract)
 * @param {object} p.globals    GLOBALS (reset() contract)
 * @param {object} p.hooks      emit hooks (reset() contract third arg)
 * @param {string} [p.source]   source text for error excerpts
 * @param {*}      [p.optimize] raw opts.optimize (level/alias/object/false)
 * @param {object} [p.warnings] advisory sink (opts.warnings) or null
 * @param {boolean}[p.strict]   enforce the pure canonical subset
 * @param {string} [p.host]     output host ('js' | 'wasi'), undefined = js
 */
export function beginSession({ emitter, globals, hooks, source, optimize, warnings, strict, host }) {
  reset(emitter, globals, hooks)
  // Explicit-lifecycle caches — EVERY one, on BOTH pipelines. DOLLAR and the
  // stdlib parse cache are plain Maps rebuilt each compile: in-kernel a stale
  // entry can alias post-_clear arena bytes (correctness), natively it is
  // retention; clearing uniformly costs nothing and removes the asymmetry.
  // Fact-store slices (programFacts/bodyFacts/bindingUses — see the factStore
  // doc above): a fresh store IS the reset, replacing the three separate
  // resetXCache() calls this used to make.
  resetFactStore()
  clearDollar()
  clearStdlibParseCache()
  // watr's generated-name counters (inline/outline/…): per-compile, else warm
  // recompiles emit history-dependent WAT text (__inl5 → __inl15).
  resetNameUids()
  if (source !== undefined) ctx.error.src = source
  initWarnings(warnings ?? null)
  if (strict) ctx.transform.strict = true
  if (host) ctx.transform.host = host
  ctx.transform.optimize = resolveOptimize(optimize)
  ctx.transform.optFlags = optFlagsOf(ctx.transform.optimize)
  assertCtxInvariants('post-reset')
  return ctx.transform.optimize
}
