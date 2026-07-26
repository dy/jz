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
 * not session lifecycle. The fuller CompileSession object (factStore ownership,
 * counters, diagnostics, TargetProfile) grows here; this is the seam.
 *
 * @module src/session
 */
import { ctx, reset, initWarnings, assertCtxInvariants, optFlagsOf } from './ctx.js'
import { resetProgramFactsCache } from './compile/program-facts.js'
import { resetBodyFactsCache } from './compile/analyze.js'
import { resetBindingUsesCache } from './compile/analyze-scans.js'
import { clearDollar } from './ir.js'
import { clearStdlibParseCache } from './wat/assemble.js'
import { resolveOptimize } from './optimize/index.js'
import { resetNameUids } from 'watr/optimize'

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
  resetProgramFactsCache()
  resetBodyFactsCache()
  resetBindingUsesCache()
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
