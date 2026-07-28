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
 * TargetProfile (audit P1): the output target's compile-policy, named and frozen
 * per target, replacing scattered `ctx.transform.host === 'wasi'` string checks
 * (23 read sites across compile/emit/module before this — one string comparison,
 * 23 places that could drift). Fields are named for the POLICY they gate, not the
 * host they happen to come from today, so a third target (the 'gc' backend index.js
 * already reserves the error message for) adds a profile entry, not a new axis
 * threaded through every call site.
 *
 * Distinct from HOST_PROFILE (src/ctx.js) — that's the capabilities of the ENGINE
 * RUNNING THE COMPILER (currently empty); this is the policy of the wasm OUTPUT's
 * target host. Do not conflate the two (ctx.js says the same in the other direction).
 *
 * @typedef {Object} TargetProfile
 * @property {boolean} envImports     `env.*` host-JS bridge is available as a
 *   dynamic-dispatch fallback (__ext_call/__ext_set/__ext_prop, host globals via
 *   env import, fetch, navigator.hardwareConcurrency, opts._interp glue). false
 *   under wasi — wasmtime/wasmer/deno have no JS runtime to satisfy `env.__ext_*`,
 *   so those paths must degrade (fold to undefined/1) or error at compile time
 *   instead of emitting an import nothing will service.
 * @property {boolean} jsStringInterop  the `wasm:js-string` builtin-import string
 *   carrier (externref zero-copy reads) is usable. Needs a JS host to intercept the
 *   `wasm:js-string` namespace (or polyfill it) — off under wasi, which must stay
 *   portable across non-JS runtimes.
 * @property {boolean} wasiShims      link the WASI-syscall module shims (module/
 *   timer.js, console.js, fs.js setupWasi; module/math.js, crypto.js
 *   wasi_snapshot_preview1 random_get) instead of the JS-host shims (setupJsHost;
 *   env.rngSeed/env.random).
 * @property {boolean} commandEntry   legalize WASI command-mode module structure:
 *   re-export `run`/`_start` as `() -> ()` (wasmtime/wasmer reject f64-returning
 *   entries under those names) and convert module init from the wasm `start`
 *   section to the reactor `_initialize` export convention (WASI forbids WASI
 *   calls inside `start` — no memory is wired yet for a top-level console.log).
 * @property {'host'|'blocking'} timerModel  'host': a JS event loop drives
 *   timers/rAF — jz emits no scheduler. 'blocking': no host scheduler exists, so
 *   `__timer_init`/`__timer_loop` run inline in `__start` when the program uses
 *   timers.
 * @property {boolean} preserveClosureTable  keep the closure funcref table (and
 *   the `$ftN` call_indirect type) live even when this compile's own scan finds no
 *   `call_indirect` — a wasi build's embedder may supply table-calling host
 *   functions the in-module scan can't see.
 */
const TARGET_PROFILES = Object.freeze({
  js: Object.freeze({
    envImports: true, jsStringInterop: true, wasiShims: false,
    commandEntry: false, timerModel: 'host', preserveClosureTable: false,
  }),
  wasi: Object.freeze({
    envImports: false, jsStringInterop: false, wasiShims: true,
    commandEntry: true, timerModel: 'blocking', preserveClosureTable: true,
  }),
})

/** Resolve a TargetProfile for a `ctx.transform.host` value. Unknown/undefined
 *  hosts fall back to 'js' (beginSession's own default), so a caller can pass the
 *  raw (possibly-undefined) opts.host through without a null-check. */
export function targetProfileFor(host) {
  return host === 'wasi' ? TARGET_PROFILES.wasi : TARGET_PROFILES.js
}

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
 *                                (a) a fresh session (wholesale); (b) the
 *                                solver-owned mutation seam (audit P1
 *                                next-slice, src/compile/analyze.js, past
 *                                invalidateLocalsCache) — reanalyzeBody(body,
 *                                read?) fuses "mutate ambient state, read
 *                                this body fresh" into one call;
 *                                setFuncBody(func, node) fuses "rewrite this
 *                                body's AST" with dropping its cache entry;
 *                                invalidateBodies(bodies) /
 *                                invalidateAllBodyFacts() name the
 *                                phase-boundary bulk flush. The raw
 *                                invalidateLocalsCache(body) primitive still
 *                                exists (2 bespoke call sites remain in
 *                                plan/literals.js) but is no longer the
 *                                pass-author-facing API — a NEW pass reaches
 *                                for one of the four seam functions instead
 *                                of re-deriving its own invalidate-then-read
 *                                pairing, so the "forgot the second half"
 *                                failure mode is structural, not a matter of
 *                                discipline. A signature-retyping miss that
 *                                still slips through (raw `func.sig...=`
 *                                without going through the seam) throws under
 *                                JZ_DEBUG_INVARIANTS=1 (assertBodyFactsFresh,
 *                                analyze.js, above analyzeBody) — scoped to
 *                                param/result WASM-type fields only; a
 *                                broader recompute-and-compare check
 *                                (JZ_DEBUG_CACHE) was tried and abandoned —
 *                                see analyzeBody's own module comment for why.
 *                                Ambient-overlay staleness (ctx.func.localReps
 *                                / ctx.types.typedElem / ctx.schema.slotI32Certain
 *                                changing without a signature retype) stays
 *                                the documented "intentionally staleable"
 *                                surface — unchanged, still out of scope.
 *   bindingUses                  scanBindingUses's per-body free/mutated-name
 *                                summary. Invalidated by: a fresh session only
 *                                (wholesale) — no surgical invalidation exists,
 *                                and this is fine, not a gap: every pass that
 *                                restructures a body's AST now does so through
 *                                setFuncBody (above), which always assigns a
 *                                NEW func.body reference, so a caller reading
 *                                scanBindingUses(func.body) after a rewrite is
 *                                structurally reading a fresh WeakMap key, never
 *                                a stale hit for the old shape (see the doc at
 *                                resetBindingUsesCache, analyze-scans.js).
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
  ctx.transform.targetProfile = targetProfileFor(ctx.transform.host)
  ctx.transform.optimize = resolveOptimize(optimize)
  ctx.transform.optFlags = optFlagsOf(ctx.transform.optimize)
  assertCtxInvariants('post-reset')
  return ctx.transform.optimize
}
