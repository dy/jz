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
 * The stage is a walk of the pass table's 'module' entries (optimize/pass-table.js,
 * their order, flags and why); `optimizeFuncs` walks each function's. What the
 * passes read of the compile is read here, once a compile (`passFacts`): no
 * pass under src/optimize reads `ctx`.
 */

import parseWat from 'watr/parse'
import { ctx, checkpointed, eachChecked, declGlobal, warn, registerResetHook } from '../../ctx.js'
import { walkAst } from '../../ast.js'
import {
  optimizeFunc, collectReachableGlobalWrites, collectReachableMemoryWrites,
  hoistGlobalPtrOffset, hoistLoopGlobalPtrOffset, hoistStableGlobalConstLoads, guardMaskedVectorSuffix, hasIROp, stablePtrGlobalNames,
  specializeMkptr, scalarizeStaticScratch, dropStaticRoots, buildPureFuncMap, inlinePureFnsInFn,
} from '../../optimize/index.js'
import { stage, walk } from '../../optimize/pass-table.js'
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
  reachableWrites: null, stableGlobals: null, pureFuncMap: null, dvArmFns: null, headerSafeFuncs: null,
  quietLoops: null, masked: null, memoryWrites: null,
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

// The per-function steps two module steps walk (`hoistGlobalPtr`, `hoistGlobalConstLoads`).
const GLOBAL_PTR = {
  hoistGlobalPtrOffset: (fn, cfg, facts, st) => { st.snapshots = hoistGlobalPtrOffset(fn, facts.stableGlobals, facts.reachableWrites) },
  hoistLoopGlobalPtrOffset: (fn, cfg, facts, st) => hoistLoopGlobalPtrOffset(fn, facts.stableGlobals, facts.reachableWrites, st.snapshots ?? null),
}
const GLOBAL_LOADS = {
  hoistStableGlobalConstLoads: (fn, cfg, facts) => { if (facts.globalTypedLen?.size) hoistStableGlobalConstLoads(fn, facts.memoryWrites, facts.reachableWrites, facts) },
  guardMaskedVectorSuffix: (fn, cfg, facts) => { if (facts.masked.has(fn)) guardMaskedVectorSuffix(fn, facts.memoryWrites) },
}
const GLOBAL_PTR_STEPS = stage('globalPtr', GLOBAL_PTR), GLOBAL_LOADS_STEPS = stage('globalLoads', GLOBAL_LOADS)

// Each module step, `(sec, cfg, facts, ms)`: `ms` holds the stage's timer `t`, the module's
// functions once the helpers specializeMkptr adds are in (`funcs()`), and the write closure (`writes()`).
const MODULE = {
  // (a binding of static typed storage the compaction never moves is no root of it)
  dropStaticRoots: (sec, cfg, facts, ms) => ms.t('dropStaticRoots', () => dropStaticRoots([...sec.funcs, ...sec.stdlib, ...sec.start], facts)),
  staticScratch: (sec, cfg, facts, ms) => ms.t('staticScratch', () => scalarizeStaticScratch([...sec.funcs, ...sec.stdlib, ...sec.start], facts)),
  // (specializePtrBase and sortStrPoolByFreq deleted: byte-identical output with
  // both disabled across the bench + examples corpora AND the self-compile kernel at
  // every watr tier — watr's own inlining/offset folding subsumed them. ~350ms/corpus.)
  specializeMkptr: (sec, cfg, facts, ms) => ms.t('specializeMkptr', () =>
    specializeMkptr([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat, { loc: false })))),
  // Share function-entry snapshots with the loop-scoped complement. Both use the same write proof.
  hoistGlobalPtr: (sec, cfg, facts, ms) => ms.t('hoistGlobalPtr', () => {
    const stable = stablePtrGlobalNames(facts.globalValTypes)
    if (!stable.size) return
    facts.stableGlobals = stable
    facts.reachableWrites = ms.writes()
    for (const s of ms.funcs()) walk(GLOBAL_PTR_STEPS, GLOBAL_PTR, cfg, s, facts, {})
  }),
  // The pure-function map for tryPerPixelColor's Phase-2 lane inline, before the
  // per-function vectorizer runs — the vectorizer is jz lowering (pre-watr), so it needs
  // its inline candidates now, not after watr. Bodies are still clean scalar here.
  pureFuncMap: (sec, cfg, facts, ms) => { const map = buildPureFuncMap(ms.funcs()); if (map.size) facts.pureFuncMap = map },
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
  inlinePureFns: (sec, cfg, facts, ms) => {
    const pureFuncMap = facts.pureFuncMap
    if (pureFuncMap) ms.t('inlinePureFns', () => {
      const callCount = new Map()
      for (const s of ms.funcs()) walkAst(s, { enter: n => {
        if ((n[0] === 'call' || n[0] === 'return_call') && typeof n[1] === 'string') callCount.set(n[1], (callCount.get(n[1]) || 0) + 1)
      } })
      const nodeCount = (n) => { let c = 0; walkAst(n, { enter: () => { c++ } }); return c }
      const INLINE_MAX = 48
      const canInline = new Set([...pureFuncMap.keys()].filter(name =>
        callCount.get(name) === 1 && nodeCount(pureFuncMap.get(name)) <= INLINE_MAX))
      if (canInline.size) { const idRef = { next: 0 }; for (const s of ms.funcs()) inlinePureFnsInFn(s, pureFuncMap, idRef, canInline) }
    })
  },
  // Candidate bodies for devirt arm inlining and block-narrowing
  // (devirtConstFnArrayCalls): the UNFILTERED name→fn map of const-fn-array
  // element bodies. No purity filter: the inliner enforces
  // straight-line shape itself, and an arm executes exactly when the original
  // call did, so side-effecting bodies substitute safely.
  dvArmFns: (sec, cfg, facts, ms) => {
    if (!facts.constFnArrays?.size) return
    const candNames = new Set()
    for (const list of facts.constFnArrays.values()) for (const c of list) candNames.add(`$${c.name}`)
    facts.dvArmFns = new Map(ms.funcs().filter(f => Array.isArray(f) && candNames.has(f[1])).map(f => [f[1], f]))
  },
  optimizeFuncs: (sec, cfg, facts, ms) => ms.t('optimizeFuncs', () => {
    if (cfg?.promoteGlobals !== false) facts.reachableWrites = ms.writes()
    // The user functions a loop may call without a header changing (optimize/licm.js).
    facts.headerSafeFuncs = collectHeaderSafeFuncs(ms.funcs())
    // (each function's passes keep nothing of their own past it: a hosted compile's phases)
    eachChecked(ms.funcs(), func => optimizeFunc(func, cfg, facts))
  }),
  // The functions the lane vectorizer lifted, for the pins of watr's inliner (compile/index.js programPins).
  vectorizedFns: (sec, cfg, facts) => { ctx.plans.vectorizedFns = facts.vectorized },
  // A site's inline cache (optimize/devirt.js) may hold a layout JSON.parse
  // registered, whose id `__clear` reissues: the reset empties every site.
  clearIcSites: (sec) => {
    if (!ctx.runtime.icSites) return
    const clear = sec.stdlib.find(f => Array.isArray(f) && f[0] === 'func' && f[1] === '$__clear')
    if (clear) for (let s = 1; s <= ctx.runtime.icSites; s++) clear.push(['global.set', `$__ic_hi${s}`, ['i64.const', -1]])
  },
  // A specialized copy that allocates nothing as optimized: no release test, rewind or compaction (optimize/quiet-loops.js).
  quietCopies: (sec, cfg, facts, ms) => ms.t('quietCopies', () => { facts.quietLoops = quietOptimizedLoops(sec, facts) }),
  // Per-iteration arena rewinds (optimize/loop-rewind.js).
  loopRewinds: (sec, cfg, facts, ms) => {
    if (ctx.plans.rewindLoopLabels) ms.t('loopRewinds', () => { insertLoopRewinds(sec.funcs, ctx.plans.rewindLoopLabels, facts); ctx.plans.rewindLoopLabels = null })
  },
  loopCompacts: (sec, cfg, facts, ms) => {
    if (ctx.plans.compactLoopLabels) ms.t('loopCompacts', () => {
      if (insertLoopCompacts(sec.funcs, ctx.plans.compactLoopLabels, facts)) ctx.plans.hasCompactLoops = true
      ctx.plans.compactLoopLabels = null
    })
  },
  // A receiver a loop never rebinds: its forward hop once before the loop and
  // after each call that may move a block (optimize/forward-hops.js).
  forwardHops: (sec, cfg, facts, ms) => ms.t('forwardHops', () => {
    const funcs = [...sec.funcs, ...sec.stdlib, ...sec.start]
    const still = collectStillFuncs(funcs), results = collectResults(funcs, facts.imports), writes = ms.writes()
    for (const fn of funcs) hoistForwardHops(fn, still, results, writes, facts.globalTypes)
  }),
  hoistGlobalConstLoads: (sec, cfg, facts, ms) => ms.t('hoistGlobalConstLoads', () => {
    const wantLoads = cfg.hoistGlobalConstLoads !== false && !!facts.globalTypedLen?.size
    // The guarded form necessarily writes a declared v128 local. Keep scalar
    // programs on the old allocation-free path; only SIMD functions pay for
    // the DAG-safe deep opcode probe.
    const simd = cfg.maskedSuffixGuard !== false ? ms.funcs().filter(fn =>
      fn.some(n => Array.isArray(n) && n[0] === 'local' && n[2] === 'v128')) : []
    const masked = new Set(simd.filter(fn => hasIROp(fn, 'v128.bitselect')))
    if (!wantLoads && !masked.size) return
    facts.reachableWrites = ms.writes()
    facts.memoryWrites = collectReachableMemoryWrites(ms.funcs())
    facts.masked = masked
    for (const s of ms.funcs()) walk(GLOBAL_LOADS_STEPS, GLOBAL_LOADS, cfg, s, facts, null)
  }),
  outlineToInt32: (sec, cfg, facts, ms) => ms.t('outlineToInt32', () => outlineToInt32([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat, { loc: false })))),
  // The lane vectorizer can inject f64x2 stdlib mirrors ($math.log_v, $math.cos2, …)
  // absent from the already-pulled+treeshaken module. Append any now-referenced mirror
  // body to sec.stdlib — the pre-watr analogue of index.js's post-watr appendLateStdlib.
  appendLateStdlib: (sec, cfg, facts, ms) => ms.t('appendLateStdlib', () => appendLateStdlib(ms.funcs(), sec.stdlib)),
}
const MODULE_STEPS = stage('module', MODULE)

/**
 * Phase: whole-module + per-function optimization passes.
 */
export function optimizeModule(sec, profiler) {
  const t = profiler?.time ? (name, fn) => profiler.time(`optMod:${name}`, () => checkpointed(fn)) : (_, fn) => checkpointed(fn)
  const cfg = ctx.transform.optimize
  const facts = passFacts(cfg)
  // The write closure, built where a step first needs it. A loop's compaction goes in
  // after the steps that read it (loopCompacts): its kernels count as written already.
  const compacting = facts.compactLoopLabels?.size ? new Map([...facts.compactLoopLabels.keys()].map(name => [name, COMPACT_KERNELS])) : null
  let allFuncs = null, reachableWrites = null
  const ms = {
    t,
    funcs: () => allFuncs ??= [...sec.funcs, ...sec.stdlib, ...sec.start],
    writes: () => reachableWrites ??= t('reachableWrites', () => collectReachableGlobalWrites(ms.funcs(), compacting)),
  }
  walk(MODULE_STEPS, MODULE, cfg, sec, facts, ms)
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
