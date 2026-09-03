/**
 * Whole-module + per-function optimization passes, plus the module-level
 * arena-rewind escape analysis (`applyArenaRewind`) it drives per function.
 *
 * Split out of assemble.js (pipeline-minimality slice) — pure move, no
 * behavior change. See ../assemble.js for the stage contract and
 * `.work/archive/assemble-outliers.md` §3-4: this is the one file in the split with
 * a real cross-seam call (`appendLateStdlib`, the late f64x2-vectorizer
 * stdlib top-up, lives in `./stdlib-pull.js`) — every other assemble/*.js
 * pair is fully independent.
 */

import parseWat from 'watr/parse'
import { ctx, declGlobal } from '../../ctx.js'
import { walkAst } from '../../ast.js'
import {
  optimizeFunc, collectVolatileGlobals, collectReachableGlobalWrites, collectReachableMemoryWrites,
  hoistGlobalPtrOffset, hoistLoopGlobalPtrOffset, hoistStableGlobalConstLoads, guardMaskedVectorSuffix, hasIROp, stablePtrGlobalNames,
  specializeMkptr, buildPureFuncMap, inlinePureFnsInFn,
} from '../../optimize/index.js'
import { dataLen } from '../../static-data.js'
import { appendLateStdlib } from './stdlib-pull.js'
/**
 * Phase: whole-module + per-function optimization passes.
 */
export function optimizeModule(sec, profiler) {
  const t = profiler?.time ? (name, fn) => profiler.time(`optMod:${name}`, fn) : (_, fn) => fn()
  const cfg = ctx.transform.optimize
  if (!cfg || cfg.specializeMkptr !== false) t('specializeMkptr', () =>
    specializeMkptr([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat))))
  // (specializePtrBase and sortStrPoolByFreq deleted: byte-identical output with
  // both disabled across the bench + examples corpora AND the self-compile kernel at
  // every watr tier — watr's own inlining/offset folding subsumed them. ~350ms/corpus.)
  // (globalTypes backfill gone: declGlobal sets the type at declaration.)
  // Build global name→type map from ctx.scope.globalTypes (keys without $) for promoteGlobals
  const globalTypesMap = ctx.scope.globalTypes ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null
  const allFuncs = [...sec.funcs, ...sec.stdlib, ...sec.start]
  const volatileGlobals = t('volatileGlobals', () => collectVolatileGlobals(allFuncs))
  const reachableWrites = t('reachableWrites', () => collectReachableGlobalWrites(allFuncs))
  // Offset-hoist BEFORE promoteGlobals (inside optimizeFunc): value-promoting a
  // stable-pointee global to a $_pg local would destroy the global.get pattern
  // this pass matches, reverting rfft/diffusion to per-iteration resolves. After
  // the hoist, the surviving global.get count is 1 (the entry snap) — naturally
  // below promoteGlobals' threshold, so the two passes compose either way.
  if (!cfg || cfg.hoistGlobalPtrOffset !== false) t('hoistGlobalPtr', () => {
    const stable = stablePtrGlobalNames()
    if (stable.size) for (const s of allFuncs) hoistGlobalPtrOffset(s, stable, reachableWrites)
  })
  // Per-loop complement: a function the whole-function pass above declined
  // (an unrelated call_indirect / write ANYWHERE in the function poisons
  // every global for it) may still have individual loops that are clean on
  // their own narrower scope — e.g. a char-scan loop inside a devirtualized
  // Pratt-loop trampoline that also inlines unrelated operator dispatch.
  if (!cfg || cfg.hoistLoopGlobalPtrOffset !== false) t('hoistLoopGlobalPtr', () => {
    const stable = stablePtrGlobalNames()
    if (stable.size) for (const s of allFuncs) hoistLoopGlobalPtrOffset(s, stable, reachableWrites)
  })
  // Build the pure-function map for tryPerPixelColor's Phase-2 lane inline BEFORE the
  // per-function vectorizer runs — the vectorizer is jz lowering (pre-watr), so it needs
  // its inline candidates now, not after watr. Bodies are still clean scalar here.
  if (cfg && cfg.vectorizeLaneLocal === true) {
    const pureFuncMap = buildPureFuncMap(allFuncs)
    if (pureFuncMap.size) {
      cfg._pureFuncMap = pureFuncMap
      // jz semantic inlining (LOWERING) — inline pure user functions into their call sites BEFORE the
      // vectorizer, so it sees the callee arithmetic (the pow/decode a colour helper hides). jz owns
      // this because the decision is purity+type-driven; watr keeps only mechanical residual inlining.
      // Gated to SINGLE-CALLER pure functions: inlining the sole call site is a guaranteed win (removes
      // the call AND the now-dead function, zero size cost). Multi-caller small helpers stay watr's
      // size-gated mechanical job at the speed tier — jz doesn't duplicate that.
      // SMALL single-caller only: inlining a small pure helper (a `spow`/`decode` colour term) into its
      // sole caller exposes its arithmetic to the vectorizer at zero size cost. Inlining a LARGE function
      // (a whole conversion loop) is neutral-to-harmful (worse layout/regalloc, measured on colorpq), and
      // watr's own inlineOnce already handles the mechanical single-caller case — so jz stays out of it.
      // OPT-IN (default off): correct + fuzz-clean, but inlining across the corpus changes a lot of
      // pinned output-shape assertions for no measured bench win (the current regressions are outer-strip/
      // widening recognition + watr wasm-opt-class, not inlining). Kept as the architectural home for
      // semantic inlining, enabled per-compile via `optimize.inlinePureFns: true`, until a real case pays.
      if (cfg.inlinePureFns === true) t('inlinePureFns', () => {
        const callCount = new Map()
        for (const s of allFuncs) walkAst(s, { enter: n => {
          if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') callCount.set(n[1], (callCount.get(n[1]) || 0) + 1)
        } })
        const nodeCount = (n) => { let c = 0; walkAst(n, { enter: () => { c++ } }); return c }
        const INLINE_MAX = 48
        const canInline = new Set([...pureFuncMap.keys()].filter(name =>
          callCount.get(name) === 1 && nodeCount(pureFuncMap.get(name)) <= INLINE_MAX))
        if (canInline.size) { const idRef = { next: 0 }; for (const s of allFuncs) inlinePureFnsInFn(s, pureFuncMap, idRef, canInline) }
      })
    }
  }
  // Candidate bodies for devirt arm inlining and block-narrowing
  // (devirtConstFnArrayCalls): the UNFILTERED name→fn map of const-fn-array
  // element bodies. Built here — the pass runs per-function inside optimizeFunc
  // and can't see sibling functions. No purity filter: the inliner enforces
  // straight-line shape itself, and an arm executes exactly when the original
  // call did, so side-effecting bodies substitute safely.
  if (ctx.scope.constFnArrays?.size) {
    const candNames = new Set()
    for (const list of ctx.scope.constFnArrays.values()) for (const c of list) candNames.add(`$${c.name}`)
    ctx.scope.dvArmFns = new Map(allFuncs.filter(f => Array.isArray(f) && candNames.has(f[1])).map(f => [f[1], f]))
  }
  t('optimizeFuncs', () => {
    for (const func of allFuncs) optimizeFunc(func, cfg, globalTypesMap, volatileGlobals, reachableWrites)
  })
  if (!cfg || cfg.hoistGlobalConstLoads !== false || cfg.maskedSuffixGuard !== false) t('hoistGlobalConstLoads', () => {
    const wantLoads = cfg.hoistGlobalConstLoads !== false && !!ctx.scope.globalTypedLen?.size
    // The guarded form necessarily writes a declared v128 local. Keep scalar
    // programs on the old allocation-free path; only SIMD functions pay for
    // the DAG-safe deep opcode probe.
    const mayHaveMasks = cfg.maskedSuffixGuard !== false && allFuncs.some(fn =>
      fn.some(n => Array.isArray(n) && n[0] === 'local' && n[2] === 'v128'))
    const wantMasks = mayHaveMasks && hasIROp(allFuncs, 'v128.bitselect')
    if (!wantLoads && !wantMasks) return
    const memoryWrites = collectReachableMemoryWrites(allFuncs)
    for (const s of allFuncs) {
      if (wantLoads) hoistStableGlobalConstLoads(s, memoryWrites, reachableWrites)
      if (wantMasks) guardMaskedVectorSuffix(s, memoryWrites)
    }
  })
  // Redundant low-word masks under `i32.wrap_i64` go last: the global-base
  // hoists above recognize the masked form.
  // The lane vectorizer can inject f64x2 stdlib mirrors ($math.log_v, $math.cos2, …)
  // absent from the already-pulled+treeshaken module. Append any now-referenced mirror
  // body to sec.stdlib — the pre-watr analogue of index.js's post-watr appendLateStdlib.
  if (cfg && cfg.vectorizeLaneLocal === true) t('appendLateStdlib', () => appendLateStdlib(allFuncs, sec.stdlib))
  const dataBytes = dataLen()
  if (dataBytes > 1024 && !ctx.memory.shared) {
    // 64-byte heap-base alignment: the compiler's own vectorizer emits v128
    // stream loads/stores, and a heap base that isn't 64-byte aligned makes
    // every such access straddle cache lines on memory-bound kernels — a real,
    // measurable slowdown that a single unrelated prelude-size change can
    // trigger by shifting the base's alignment. Cache-line alignment makes
    // perf immune to prelude size changes — without it every stdlib edit
    // re-rolls the layout lottery.
    // Cost: ≤56 bytes of memory per module, zero code bytes.
    const heapBase = (dataBytes + 63) & ~63
    // Non-shared memory always carries a $__heap global — start it past the
    // static data so the bump allocator never overwrites a literal. `__heap_reset`
    // seeds to the same data end (its runtime value is overwritten by `__start`'s
    // tail capture for modules that init-allocate; this seed serves modules with no
    // `__start`, where the data end IS the correct rewind point). `__clear` reads
    // `$__heap_reset` directly, so no per-function constant patch is needed.
    declGlobal('__heap', 'i32', heapBase, { export: '__heap' })
    if (ctx.scope.globals.has('__heap_reset')) declGlobal('__heap_reset', 'i32', heapBase)
    if (ctx.scope.globals.has('__heap_start')) declGlobal('__heap_start', 'i32', heapBase)
  }
}
