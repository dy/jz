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
 *   sortLocalsByUse   — reorder local decls so hot ones get 1-byte LEB128 indices
 *   specializeMkptr   — `(call $__mkptr (i32.const T) (i32.const A) X)` → per-combo specialized helper (~4 B/site)
 *   hoistConstantPool — frequently-repeated f64.const values → mutable globals (~7 B/reuse)
 *   treeshake         — drop func decls unreachable from exports / start / elem / ref.func roots
 *
 * Per-function passes run over sec.funcs + sec.stdlib + sec.start.
 * Whole-module passes see the full function list + globals map.
 *
 * This file is the stable public entry: every pass now lives in its own family
 * module under src/optimize/ (see .work/optimize-split.md for the map), and
 * this barrel only re-exports — so no consumer import site needs to change.
 * The pass driver itself (`optimizeFunc`, the fixed per-function apply order)
 * lives in driver.js; the generic peephole/rewrite walker lives in peephole.js.
 *
 * @module optimize
 */

export { SIMD_PINNED, inlinePureFnsInFn } from './vectorize.js'

export { hasIROp } from './ir-scan.js'

// Level/string presets + resolveOptimize() — see src/optimize/config.js for
// the full doc (level semantics, the two-layer jz-vs-watr contract, sequencing).
export { PASS_NAMES, TUNING_KEYS, resolveOptimize } from './config.js'

// Region-tracking address/pointer CSE (hoistPtrType, hoistAddrBase) — see
// src/optimize/cse-address.js for the full doc.
export { hoistPtrType, hoistAddrBase } from './cse-address.js'

// Loop-invariant code motion family (hoistInvariantPtrOffset,
// splitLoopPrivateScratch, hoistInvariantLoop, narrowLoopBound, cseScalarLoad)
// — see src/optimize/licm.js for the full doc.
export { hoistInvariantPtrOffset, splitLoopPrivateScratch, hoistInvariantLoop, narrowLoopBound, cseScalarLoad } from './licm.js'

// Local def/use simplification family (propagateSingleUse, foldSetToTee) — see
// src/optimize/locals.js for the full doc.
export { propagateSingleUse, foldSetToTee } from './locals.js'

// Global/memory hoisting family (collectVolatileGlobals,
// collectReachableGlobalWrites, STABLE_PTR_VALS, stablePtrGlobalNames,
// hoistGlobalPtrOffset, collectReachableMemoryWrites, hoistStableGlobalConstLoads,
// guardMaskedVectorSuffix, hoistLoopGlobalPtrOffset, promoteGlobals) — see
// src/optimize/globals.js for the full doc.
export {
  collectVolatileGlobals, collectReachableGlobalWrites, STABLE_PTR_VALS, stablePtrGlobalNames,
  hoistGlobalPtrOffset, collectReachableMemoryWrites, hoistStableGlobalConstLoads,
  guardMaskedVectorSuffix, hoistLoopGlobalPtrOffset, promoteGlobals,
} from './globals.js'

// Whole-module f64 constant pooling (hoistConstantPool) — see
// src/optimize/const-pool.js for the full doc.
export { hoistConstantPool } from './const-pool.js'

// Call-site specialization by literal-arg signature (specializeMkptr) — see
// src/optimize/specialize-mkptr.js for the full doc.
export { specializeMkptr } from './specialize-mkptr.js'

// Pure-function detection for the SIMD lane inliner (buildPureFuncMap) and its
// dead string-dispatch fold (foldStrDispatchF64) — see src/optimize/pure-funcs.js.
export { buildPureFuncMap, foldStrDispatchF64 } from './pure-funcs.js'

// Loop unswitching/peeling family (unswitchTypedParamLoop) — see
// src/optimize/unswitch.js for the full doc. (unswitchStringRepLoop stays
// internal — driver.js is its only caller, same as upstream.)
export { unswitchTypedParamLoop } from './unswitch.js'

// Devirtualization family (devirtSchemaReads, foldStaticConstArrayReads,
// devirtConstFnArrayCalls) — see src/optimize/devirt.js for the full doc.
export { devirtSchemaReads, foldStaticConstArrayReads, devirtConstFnArrayCalls } from './devirt.js'

// Whole-module dead-code elimination (treeshake) — see
// src/optimize/treeshake.js for the full doc.
export { treeshake } from './treeshake.js'

// Encoding-compactness local reordering (sortLocalsByUse) — see
// src/optimize/sort-locals.js for the full doc.
export { sortLocalsByUse } from './sort-locals.js'

// Module-level arena-rewind escape analysis (arenaRewindModule) — see
// src/optimize/arena-rewind.js for the full doc.
export { arenaRewindModule } from './arena-rewind.js'

// The pass driver (optimizeFunc, the fixed per-function apply order) — see
// src/optimize/driver.js for the full doc.
export { optimizeFunc } from './driver.js'
