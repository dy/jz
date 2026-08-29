/**
 * Module assembly — WAT section construction, optimization, and finalization.
 *
 * # Stage contract
 *   IN:  per-function WAT IR (from emit), ctx state (includes, scope, closure, etc.)
 *   OUT: assembled module sections via the `sec` object, mutated in place.
 *
 * Extracted from compile.js to separate "per-function compilation" from
 * "module assembly" concerns. All functions receive `sec` (the named-slots
 * section accumulator) and read/write ctx state as needed.
 *
 * Stable barrel (pipeline-minimality split, `.work/archive/assemble-outliers.md`):
 * every real phase now lives in `./assemble/*.js`, grouped by the seam each
 * one belongs to (per that doc's §4 module-split plan) — this file only
 * re-exports, in the actual compile/index.js assembly order (§1) by the
 * first phase each grouped file contributes. Every existing
 * `from '../wat/assemble.js'` import keeps working unchanged.
 *
 * @module assemble
 */

// Phase 1: build the synthetic `$__start` function (+ later simplify it).
export { buildStartFn, hoistConstGlobalInits } from './assemble/start-fn.js'

// Phase 2 (syncImports) and phase 5 (pullStdlib): stdlib template parse
// cache, reachability, the late f64x2-vectorizer top-up, and import sync.
export {
  clearStdlibParseCache, stdlibParseCacheMap, setStdlibParseCacheMap,
  appendLateStdlib, pullStdlib, syncImports,
} from './assemble/stdlib-pull.js'

// Phases 3-4: closure-body dedup, then closure-table finalize + ABI shrink.
export { dedupClosureBodies, finalizeClosureTable } from './assemble/closure-table.js'

// Phase 6 (stripStaticDataPrefix) and phases 9-10 (stripDeadLazyTables,
// stripDeadInternedSpans): data-segment tail lifecycle.
export { stripDeadLazyTables, stripDeadInternedSpans, stripStaticDataPrefix } from './assemble/static-data.js'

// Phase 7: whole-module + per-function optimization passes.
export { optimizeModule } from './assemble/optimize-module.js'

// Phase 11 (much later — post section-ordering): WAT display-name cleanup.
export { stripLocalRenameSuffixes } from './assemble/rename-locals.js'
