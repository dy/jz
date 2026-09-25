/**
 * WASM IR post-emission optimizations.
 *
 * # Stage contract
 *   IN:  WAT-as-array IR (function body or module-level).
 *   OUT: equivalent WAT-as-array IR (same semantics, smaller encoding).
 *   INVARIANTS: semantics-preserving IR→IR rewrites. Leaf passes are context-free;
 *        explicitly documented module-proof passes may read immutable ctx facts. No ctx writes.
 *        No new top-level declarations except those surfaced via `addGlobal`.
 *
 * Each pass is orthogonal. Apply order matters: structural hoists (hoistPtrType) introduce
 * new locals before the fused walk, which mixes peephole rebox folds, ptr-helper inlining,
 * and memarg-offset folding in one bottom-up traversal.
 *
 * Passes:
 *   hoistPtrType      — repeated `(call $__ptr_type X)` on same X → single local.tee + local.get reuse
 *   fusedRewrite      — peephole rebox folds + inline ptr/is_* helpers + memarg-offset fold (one walk)
 *   sortLocalsByUse   — reorder local decls so hot ones get 1-byte LEB128 indices; a tape pass, run by src/link
 *   specializeMkptr   — `(call $__mkptr (i32.const T) (i32.const A) X)` → per-combo specialized helper (~4 B/site)
 *
 * Per-function passes run over sec.funcs + sec.stdlib + sec.start.
 * Whole-module passes see the full function list + globals map.
 *
 * Every pass lives in its own family module under src/optimize/; this entry
 * re-exports what the rest of the compiler consumes. The pass driver
 * (`optimizeFunc`, the fixed per-function apply order) lives in driver.js; the
 * generic peephole/rewrite walker lives in peephole.js.
 *
 * @module optimize
 */

export { SIMD_PINNED } from './vectorize/lane-tables.js'
export { inlinePureFnsInFn } from './vectorize/inline-pure.js'
export { hasIROp } from './ir-scan.js'

// Level/string presets + resolveOptimize(): level semantics, the jz-vs-watr contract.
export { PASS_NAMES, TUNING_KEYS, resolveOptimize } from './config.js'

// Module-wide write sets and the global/memory hoists built on them.
export {
  collectReachableGlobalWrites, collectReachableMemoryWrites, stablePtrGlobalNames,
  hoistGlobalPtrOffset, hoistLoopGlobalPtrOffset, hoistStableGlobalConstLoads, guardMaskedVectorSuffix,
} from './globals.js'

export { specializeMkptr } from './specialize-mkptr.js'
export { buildPureFuncMap } from './pure-funcs.js'

// The pass driver: the fixed per-function apply order.
export { optimizeFunc } from './driver.js'
