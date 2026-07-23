/**
 * The final-optimizer tail, shared VERBATIM by the host pipeline (index.js)
 * and the self-host kernel (scripts/self.js): watr option construction +
 * the single post-watr proof repair. One module so the two pipelines cannot
 * drift — the kernel previously duplicated a subset of the option logic and
 * omitted ifset tiering, inlineWrappers, watr LICM, the size-guard policy,
 * the large-module unroll2 rule, boundary pins, and the pointer repair,
 * so kernel O2/O3 output diverged from native on the same source.
 *
 * Cycle-free: imports only watr and src/optimize (no index.js, no ctx-heavy
 * compile modules) — safe for the kernel's minimal module graph.
 *
 * @module optimize/watr-tail
 */
import watOptimize from 'watr/optimize'
import {
  SIMD_PINNED, collectReachableGlobalWrites, hoistGlobalPtrOffset, stablePtrGlobalNames,
} from './index.js'

/**
 * Compute the watr optimizer options for a resolved jz `optimize` config (see
 * `resolveOptimize`) — the single source of truth for "which watr passes does THIS
 * jz tier ask for". A caller that already holds a resolved cfg (e.g.
 * scripts/audit-fixpoint.mjs, re-running watr on jz's own output to check
 * idempotence) builds the IDENTICAL options jz's own pipeline used, instead
 * of drifting to watr's bare defaults — which lean size (outline/tailmerge/rettail
 * ON) and would misreport a deliberate speed-tier trade as a missed rewrite.
 * `funcCount`/`boundaryPins` are the two refinements that need live compile ctx
 * (module function count, JS-boundary vectorized fn names) — omit them for a
 * cfg-only approximation (fine for small/synthetic corpora).
 * @returns {Object|false} watr options, or `false` when `cfg.watr` is off.
 */
export function resolveWatrOpts(cfg, { funcCount = 0, boundaryPins = [] } = {}) {
  if (!cfg.watr) return false
  let watrOpts = typeof cfg.watr === 'object' ? { ...cfg.watr } : true
  if (cfg.vectorizeLaneLocal) {
    // Off at the speed tier: watr's loopify collapses the while-idiom to
    // `loop { if C { …; br } }` (an UNfused back-jump — no win) AND would mangle the
    // lane-vectorizer's loop shape. jz's own `rotateLoops` (optimize/index.js, post
    // phase) does the rotation instead, emitting the FUSED `br_if $loop C` back-edge.
    if (watrOpts === true) watrOpts = { loopify: false }
    else if (typeof watrOpts === 'object' && watrOpts.loopify === undefined) watrOpts.loopify = false
  }
  if (cfg.devirtIndirect) {
    if (watrOpts === true) watrOpts = { devirt: true }
    else if (typeof watrOpts === 'object' && watrOpts.devirt === undefined) watrOpts.devirt = true
  }
  // Multi-caller small-function inlining (size-for-speed): on at the 'speed'/level-3
  // tier only, like devirt above. Removes call overhead from hot inner loops at the
  // cost of duplicating tiny bodies; level 2 (and the size budgets measured there)
  // stay untouched.
  if (cfg.inlineFns) {
    if (watrOpts === true) watrOpts = { inline: 'simd' }
    else if (typeof watrOpts === 'object' && watrOpts.inline === undefined) watrOpts.inline = 'simd'
  }
  // Wrapper elision (speed tier): dissolve adapter frames — closure-ABI
  // trampolines for functions-as-values, thin dispatch heads like
  // __dyn_get_expr — into their target at the wrapper site. The recorded
  // "table entries native against ftN" restructure, done mechanically in the
  // optimizer instead of per-case emit surgery (one wrapper = one duplicated
  // target; treeshake collects whichever copy ends up unreferenced).
  if (cfg.inlineFns) {
    if (typeof watrOpts === 'object' && watrOpts.inlineWrappers === undefined) watrOpts.inlineWrappers = true
  }
  // watr LICM (speed tier): hoist loop-invariant pure arithmetic AFTER watr's inlining exposes it
  // (the raytrace per-iteration NaN/Inf guard pairs). Mechanical — lives in watr, jz just enables it.
  if (cfg.watrLicm) {
    if (watrOpts === true) watrOpts = { licm: true }
    else if (typeof watrOpts === 'object' && watrOpts.licm === undefined) watrOpts.licm = true
  }
  // guardRefine folds jz's NaN-box tag reads — default-off in watr (general WAT
  // never matches it), so jz always enables it explicitly.
  if (watrOpts === true) watrOpts = { guardRefine: true }
  else if (typeof watrOpts === 'object' && watrOpts.guardRefine === undefined) watrOpts.guardRefine = true
  // watr's ifset (one-armed conditional update → select) rides jz's select
  // tiering: an unconditional-update trade belongs to the speed tier exactly
  // like boolConvertToSelect. jz's DEFAULT tier also passes watrProfile:'speed'
  // (for the outline/tailmerge shape), which would enable ifset via the
  // profile — the explicit flag here overrides it in both directions.
  if (typeof watrOpts === 'object' && watrOpts.ifset === undefined)
    watrOpts.ifset = cfg.boolConvertToSelect === true || cfg.watrIfset === true
  // jz's promise is runtime speed, but watr's OWN profile default leans size — outline/
  // tailmerge/rettail fold repeated sequences into out-of-line calls (measured 1.433→1.316
  // on the self-host kernel with them off, watr ≥5.2.0). Every speed-tier preset carries
  // watrProfile:'speed' (src/optimize/index.js LEVEL_PRESETS); the 'size' preset keeps
  // watr's size-leaning default. An explicit user profile always wins.
  if (watrOpts.profile === undefined && cfg.watrProfile) watrOpts.profile = cfg.watrProfile
  // Speed tier waives watr's size-revert guard (two full binary encodes per
  // optimize — its costliest fixed overhead): inlining growth is the shape this
  // tier asks for, and jz's own perf/size gates own the size budget. Level 2
  // (default) and 'size' keep the guard — watr's never-inflate contract stands
  // where the user didn't opt into speed-for-size.
  if (watrOpts.guard === undefined && cfg.watrGuard === false) watrOpts.guard = false
  // Pin jz's scalar transcendentals (the PPC_CALL2 keys the auto-vectorizer rewrites to f64x2
  // mirrors) so watr's inline passes don't dissolve the call nodes the lift needs. The protection
  // policy lives here in jz — watr just honours the `pin` list (no jz names hardcoded in watr).
  if (watrOpts === true) watrOpts = {}
  watrOpts.pin = watrOpts.pin ? [...watrOpts.pin, ...SIMD_PINNED] : SIMD_PINNED
  // Partial unrolling overlaps branch latency in compact codecs, but duplicates
  // too many cold compiler/parser loops in large module graphs and loses the
  // warm self-host I-cache race. Users may still opt in explicitly.
  if (watrOpts.unroll2 == null && funcCount > 64) watrOpts.unroll2 = false
  // Keep only JS-boundary vectorized functions intact: their `$name$exp`
  // wrapper must not swallow the body/markers structural host tests inspect.
  // Internal lifted helpers remain inlineable — SIMD survives the splice,
  // while caller-level constant propagation and hot-call removal become live.
  if (boundaryPins.length) watrOpts.pin = [...watrOpts.pin, ...boundaryPins]
  return watrOpts
}

/**
 * Run the whole final-optimizer tail on an assembled `['module', …]` tree:
 * watr (the sole generic fixpoint, exactly once) followed by the one narrow
 * post-watr proof repair. See index.js's call-site comments for why the
 * repair exists (watr's inliner can merge stable-pointee decodes into one
 * caller past the multi-site hoist threshold) and why there is NO post-watr
 * generic optimizer. `time` is the host profiler hook; the kernel passes none.
 */
export function watrTail(module, cfg, { funcCount = 0, boundaryPins = [], time = (n, f) => f() } = {}) {
  const watrOpts = resolveWatrOpts(cfg, { funcCount, boundaryPins })
  const optimized = watrOpts ? time('watOptimize', () => watOptimize(module, watrOpts)) : module
  if (cfg.hoistGlobalPtrOffset !== false) {
    const funcs = optimized.filter(node => Array.isArray(node) && node[0] === 'func')
    const stableGlobals = stablePtrGlobalNames()
    if (stableGlobals.size) {
      const reach = collectReachableGlobalWrites(funcs)
      for (const node of funcs) hoistGlobalPtrOffset(node, stableGlobals, reach)
    }
  }
  return optimized
}
