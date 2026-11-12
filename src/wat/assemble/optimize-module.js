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
 *
 * What the passes read of the compile is read here, once a compile
 * (`passFacts`): no pass under src/optimize reads `ctx`.
 */

import parseWat from 'watr/parse'
import { ctx, checkpointed, eachChecked, declGlobal, warn, registerResetHook } from '../../ctx.js'
import { walkAst } from '../../ast.js'
import {
  optimizeFunc, collectReachableGlobalWrites, collectReachableMemoryWrites,
  hoistGlobalPtrOffset, hoistLoopGlobalPtrOffset, hoistStableGlobalConstLoads, guardMaskedVectorSuffix, hasIROp, stablePtrGlobalNames,
  specializeMkptr, scalarizeStaticScratch, dropStaticRoots, buildPureFuncMap, inlinePureFnsInFn,
} from '../../optimize/index.js'
import { dataLen, dataBytes } from '../../static-data.js'
import { HEAP } from '../../../layout.js'
import { appendLateStdlib } from './stdlib-pull.js'
import { insertLoopRewinds } from '../../optimize/loop-rewind.js'
import { insertLoopCompacts } from '../../optimize/loop-compact.js'
import { quietOptimizedLoops } from '../../optimize/quiet-loops.js'
import { outlineToInt32 } from '../../optimize/to-int32.js'
import { collectHeaderSafeFuncs } from '../../optimize/licm.js'
import { hoistForwardHops, collectStillFuncs, collectResults } from '../../optimize/forward-hops.js'
import { resetVectorizeState } from '../../optimize/vectorize/lift.js'
import { representationProgramHasBigint } from '../../compile/representation-plan.js'
import { compactSlack } from '../../../module/core/stub-log.js'
const COMPACT_KERNELS = ['$__gc_begin', '$__gc_walk', '$__gc_move', '$__gc_thresh']

// The vectorizer's module state starts each compile disarmed (optimize/vectorize/lift.js).
registerResetHook(resetVectorizeState)

/**
 * What the optimizer's passes read of the compile: one value a compile, read
 * when the module stage starts. The facts the stage derives of the module as
 * it stands (the write closure, the pure functions, the header-safe calls, the
 * quiet loops) join it as they are made; `icSite`, `warn` and `vectorized` are
 * what the passes hand back.
 */
export const passFacts = (cfg) => ({
  // the program
  hasBigint: representationProgramHasBigint(ctx),
  funcCount: ctx.funcs.list.length,
  exports: ctx.funcs.exports,
  imports: ctx.module.imports,
  f16: ctx.linkDemand.f16, typedView: ctx.linkDemand.typedView,
  resizable: ctx.features.resizable,
  // the memory and the module's bindings
  shared: ctx.memory.shared, memoryMax: ctx.memory.max,
  staticData: dataBytes,
  globals: ctx.scope.globals, globalTypes: ctx.scope.globalTypes, globalValTypes: ctx.scope.globalValTypes,
  globalTypedLen: ctx.scope.globalTypedLen, globalTypedElem: ctx.scope.globalTypedElem,
  freshTypedGlobals: ctx.scope.freshTypedGlobals, consts: ctx.scope.consts, userGlobals: ctx.scope.userGlobals,
  // promoteGlobals' types, by `$name`, of the bindings as the stage starts
  globalRefTypes: cfg?.promoteGlobals !== false && ctx.scope.globalTypes
    ? new Map([...ctx.scope.globalTypes].map(([k, v]) => [`$${k}`, v])) : null,
  // what the emitter proved and marked
  loweringLinks: ctx.plans.loweringLinks,
  staticArrs: ctx.scope.staticArrs, constFnArrays: ctx.scope.constFnArrays,
  arrResized: ctx.types.arrResized, nameEscapes: ctx.types.nameEscapes,
  schemas: ctx.schema.list, schemasByProp: ctx.schema._byProp,
  fieldKind: ctx.summary ? (sid, prop) => ctx.summary.fieldKind(sid, prop) : null,
  // the runtime
  includes: ctx.core.includes, stdlib: ctx.core.stdlib,
  compactLoopLabels: ctx.plans.compactLoopLabels, rewindLoopLabels: ctx.plans.rewindLoopLabels,
  compactSlack: compactSlack(),
  // made by the stage
  reachableWrites: null, pureFuncMap: null, dvArmFns: null, headerSafeFuncs: null, quietLoops: null,
  // handed back
  vectorized: new Set(),
  warn,
  icSite: () => {
    // A site's inline cache: two globals of its own (optimize/devirt.js devirtSchemaReads).
    const site = ctx.runtime.icSites = (ctx.runtime.icSites ?? 0) + 1
    declGlobal(`__ic_hi${site}`, 'i64', -1); declGlobal(`__ic_slot${site}`, 'i32')
    return site
  },
})

/**
 * Phase: whole-module + per-function optimization passes.
 */
export function optimizeModule(sec, profiler) {
  const t = profiler?.time ? (name, fn) => profiler.time(`optMod:${name}`, () => checkpointed(fn)) : (_, fn) => checkpointed(fn)
  const cfg = ctx.transform.optimize
  const facts = passFacts(cfg)
  // (a binding of static typed storage the compaction never moves is no root of it)
  t('dropStaticRoots', () => dropStaticRoots([...sec.funcs, ...sec.stdlib, ...sec.start], facts))
  // First: it reads the accesses as emitted, before a pass stages their bases in locals.
  if (!cfg || cfg.staticScratch !== false) t('staticScratch', () =>
    scalarizeStaticScratch([...sec.funcs, ...sec.stdlib, ...sec.start], facts))
  if (!cfg || cfg.specializeMkptr !== false) t('specializeMkptr', () =>
    specializeMkptr([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat, { loc: false }))))
  // (specializePtrBase and sortStrPoolByFreq deleted: byte-identical output with
  // both disabled across the bench + examples corpora AND the self-compile kernel at
  // every watr tier — watr's own inlining/offset folding subsumed them. ~350ms/corpus.)
  const allFuncs = [...sec.funcs, ...sec.stdlib, ...sec.start]
  // Build the shared proof only if a global-load optimization consumes it.
  // Its precise call graph also subsumes the old coarse volatility census.
  let reachableWrites
  // A loop's compaction goes in after the passes that read this (loopCompacts, below).
  const compacting = ctx.plans.compactLoopLabels?.size ? new Map([...ctx.plans.compactLoopLabels.keys()].map(name => [name, COMPACT_KERNELS])) : null
  const globalWrites = () => reachableWrites ??= t('reachableWrites', () => collectReachableGlobalWrites(allFuncs, compacting))
  // Share function-entry snapshots with the loop-scoped complement. Both use
  // the same write proof and run before promoteGlobals hides global.get.
  if (!cfg || cfg.hoistGlobalPtrOffset !== false || cfg.hoistLoopGlobalPtrOffset !== false) t('hoistGlobalPtr', () => {
    const stable = stablePtrGlobalNames(facts.globalValTypes)
    if (!stable.size) return
    const writes = globalWrites()
    for (const s of allFuncs) {
      const snapshots = cfg?.hoistGlobalPtrOffset !== false ? hoistGlobalPtrOffset(s, stable, writes) : null
      if (cfg?.hoistLoopGlobalPtrOffset !== false) hoistLoopGlobalPtrOffset(s, stable, writes, snapshots)
    }
  })
  // Build the pure-function map for tryPerPixelColor's Phase-2 lane inline BEFORE the
  // per-function vectorizer runs — the vectorizer is jz lowering (pre-watr), so it needs
  // its inline candidates now, not after watr. Bodies are still clean scalar here.
  if (cfg && cfg.vectorizeLaneLocal === true) {
    const pureFuncMap = buildPureFuncMap(allFuncs)
    if (pureFuncMap.size) {
      facts.pureFuncMap = pureFuncMap
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
  if (facts.constFnArrays?.size) {
    const candNames = new Set()
    for (const list of facts.constFnArrays.values()) for (const c of list) candNames.add(`$${c.name}`)
    facts.dvArmFns = new Map(allFuncs.filter(f => Array.isArray(f) && candNames.has(f[1])).map(f => [f[1], f]))
  }
  t('optimizeFuncs', () => {
    facts.reachableWrites = cfg?.promoteGlobals !== false ? globalWrites() : null
    // The user functions a loop may call without a header changing (optimize/licm.js).
    facts.headerSafeFuncs = collectHeaderSafeFuncs(allFuncs)
    // (each function's passes keep nothing of their own past it: a hosted compile's phases)
    eachChecked(allFuncs, func => optimizeFunc(func, cfg, facts))
  })
  // The functions the lane vectorizer lifted, for the pins of watr's inliner (compile/index.js programPins).
  ctx.plans.vectorizedFns = facts.vectorized
  // A site's inline cache (optimize/devirt.js) may hold a layout JSON.parse
  // registered, whose id `__clear` reissues: the reset empties every site.
  if (ctx.runtime.icSites) {
    const clear = sec.stdlib.find(f => Array.isArray(f) && f[0] === 'func' && f[1] === '$__clear')
    if (clear) for (let s = 1; s <= ctx.runtime.icSites; s++) clear.push(['global.set', `$__ic_hi${s}`, ['i64.const', -1]])
  }
  // Per-iteration arena rewinds go in once the vectorizer has matched its loop
  // shapes (optimize/loop-rewind.js); a loop it lifted is a new node this never sees.
  // A specialized copy that allocates nothing as optimized: no release test, rewind or compaction (optimize/quiet-loops.js).
  t('quietCopies', () => { facts.quietLoops = quietOptimizedLoops(sec, facts) })
  if (ctx.plans.rewindLoopLabels) t('loopRewinds', () => { insertLoopRewinds(sec.funcs, ctx.plans.rewindLoopLabels, facts); ctx.plans.rewindLoopLabels = null })
  if (ctx.plans.compactLoopLabels) t('loopCompacts', () => {
    if (insertLoopCompacts(sec.funcs, ctx.plans.compactLoopLabels, facts)) ctx.plans.hasCompactLoops = true
    ctx.plans.compactLoopLabels = null
  })
  // A receiver a loop never rebinds: its forward hop once before the loop and
  // after each call that may move a block (optimize/forward-hops.js). After the
  // compaction goes in: a compacted loop is re-entered past the set before it.
  if (cfg && cfg.hoistForwardHops !== false) t('forwardHops', () => {
    const funcs = [...sec.funcs, ...sec.stdlib, ...sec.start]
    const still = collectStillFuncs(funcs), results = collectResults(funcs, facts.imports), writes = globalWrites()
    for (const fn of funcs) hoistForwardHops(fn, still, results, writes, facts.globalTypes)
  })
  if (!cfg || cfg.hoistGlobalConstLoads !== false || cfg.maskedSuffixGuard !== false) t('hoistGlobalConstLoads', () => {
    const wantLoads = cfg.hoistGlobalConstLoads !== false && !!facts.globalTypedLen?.size
    // The guarded form necessarily writes a declared v128 local. Keep scalar
    // programs on the old allocation-free path; only SIMD functions pay for
    // the DAG-safe deep opcode probe.
    const simd = cfg.maskedSuffixGuard !== false ? allFuncs.filter(fn =>
      fn.some(n => Array.isArray(n) && n[0] === 'local' && n[2] === 'v128')) : []
    const masked = new Set(simd.filter(fn => hasIROp(fn, 'v128.bitselect')))
    if (!wantLoads && !masked.size) return
    const writes = globalWrites()
    const memoryWrites = collectReachableMemoryWrites(allFuncs)
    for (const s of allFuncs) {
      if (wantLoads) hoistStableGlobalConstLoads(s, memoryWrites, writes, facts)
      if (masked.has(s)) guardMaskedVectorSuffix(s, memoryWrites)
    }
  })
  if (cfg?.leanRuntime) t('outlineToInt32', () => outlineToInt32([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat, { loc: false }))))
  // The lane vectorizer can inject f64x2 stdlib mirrors ($math.log_v, $math.cos2, …)
  // absent from the already-pulled+treeshaken module. Append any now-referenced mirror
  // body to sec.stdlib — the pre-watr analogue of index.js's post-watr appendLateStdlib.
  if (cfg && cfg.vectorizeLaneLocal === true) t('appendLateStdlib', () => appendLateStdlib(allFuncs, sec.stdlib))
  const dataEnd = dataLen()
  // Past HEAP.PTR_ADDR the static data covers the cell the host's allocator keeps its
  // pointer in when the module exports no heap of its own (interop.js), and a host
  // allocation overwrites the data's last word: 1024 bytes of it, the exponentials'
  // table alone, lost its last entry's tail to the first memory.Float64Array.
  if (dataEnd > HEAP.PTR_ADDR && !ctx.memory.shared) {
    // 64-byte heap-base alignment: the compiler's own vectorizer emits v128
    // stream loads/stores, and a heap base that isn't 64-byte aligned makes
    // every such access straddle cache lines on memory-bound kernels — a real,
    // measurable slowdown that a single unrelated prelude-size change can
    // trigger by shifting the base's alignment. Cache-line alignment makes
    // perf immune to prelude size changes — without it every stdlib edit
    // re-rolls the layout lottery.
    // Cost: ≤56 bytes of memory per module, zero code bytes.
    const heapBase = (dataEnd + 63) & ~63
    // Non-shared memory always carries a $__heap global — start it past the
    // static data so the bump allocator never overwrites a literal. `__heap_reset`
    // seeds to the same data end (its runtime value is overwritten by `__start`'s
    // tail capture for modules that init-allocate; this seed serves modules with no
    // `__start`, where the data end IS the correct rewind point). `__clear` reads
    // `$__heap_reset` directly, so no per-function constant patch is needed.
    declGlobal('__heap', 'i32', heapBase, { export: '__jz_heap' })
    if (ctx.scope.globals.has('__heap_reset')) declGlobal('__heap_reset', 'i32', heapBase)
    if (ctx.scope.globals.has('__heap_start')) declGlobal('__heap_start', 'i32', heapBase)
  }
}
