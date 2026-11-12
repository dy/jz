/**
 * The pass driver: `optimizeFunc` runs every per-function IR optimization on
 * one func node, a walk of the 'func' stage of the pass table
 * (optimize/pass-table.js), which holds their order, their flags and why. Each pass
 * lives in its own family module; this file binds each step to its pass.
 *
 * @module optimize/driver
 */
import { DBG_INVARIANTS } from '../debug.js'
import { verifyFn } from '../ir.js'
import { stage, walk } from './pass-table.js'
import { recursionUnroll } from './recurse.js'
import { dropSettledTests } from './settled-tests.js'
import { stripDeadCanons } from './nan-canon.js'
import { forwardStores } from './forward-store.js'
import { sinkStores } from './sink-stores.js'
import { earlyStores } from './early-stores.js'
import { vectorizeLaneLocal } from './vectorize/index.js'
import { hoistPtrType, hoistPtrOffset, hoistAddrBase } from './cse-address.js'
import {
  boolConvertToSelect, foldV128Memargs, inlinePtrOffsetFastPass, fusedRewrite, lowerToInt32Tails, refoldMemargs, foldLoadCasts, holdWordNumbers,
} from './peephole.js'
import { hoistInvariantPtrOffset, splitLoopPrivateScratch, hoistInvariantLoop, narrowLoopBound, cseScalarLoad } from './licm.js'
import { reuseLoads, narrowByteLoads } from './reuse-loads.js'
import { promoteGlobals } from './globals.js'
import { promoteCells } from './cells.js'
import { unswitchTypedParamLoop, unswitchStringRepLoop } from './unswitch.js'
import { foldGuardedUpdates } from './guarded-update.js'
import { hoistTypedDecode } from './typed-decode.js'
import { foldShiftRemainder } from './shift-remainder.js'
import { narrowFloat32 } from './float32.js'
import { narrowInts, narrowWrappedWords } from './int-narrow.js'
import { specializeLoops } from './specialize.js'
import { combineGuards } from './guards.js'
import { wideAccumulator } from './wide-accumulator.js'
import { devirtSchemaReads, foldStaticConstArrayReads, devirtConstFnArrayCalls } from './devirt.js'

// Each step's pass, `(fn, cfg, facts, st)`: `st` is what a step hands the steps after it in this function.
const RUN = {
  foldStaticArrReads: (fn, cfg, facts) => foldStaticConstArrayReads(fn, facts),
  holdWordNumbers: (fn) => holdWordNumbers(fn),
  promoteCells: (fn) => promoteCells(fn),
  nanCanon: (fn) => stripDeadCanons(fn),
  hoistPtrType: (fn) => hoistPtrType(fn),
  hoistInvariantPtrOffset: (fn) => hoistInvariantPtrOffset(fn),
  hoistPtrOffset: (fn) => hoistPtrOffset(fn),
  narrowLoopBound: (fn) => narrowLoopBound(fn),
  // Unified LICM (replaces hoistInvariantToInt32 / PtrOffsetLoop / CellLoads), at both maturity points (idempotent).
  hoistInvariantLoop: (fn, cfg, facts) => hoistInvariantLoop(fn, facts),
  fusedRewrite: (fn, cfg, facts) => fusedRewrite(fn, !!facts.hasBigint, !cfg?.leanRuntime, facts.loweringLinks),
  unswitchStringRepLoop: (fn, cfg, facts) => {
    if ((facts.funcCount ?? 0) <= 64 && fn.some(n => Array.isArray(n) && n[0] === 'local' && typeof n[1] === 'string' && n[1].endsWith('$ccsso'))) unswitchStringRepLoop(fn)
  },
  shiftRemainder: (fn) => foldShiftRemainder(fn),
  boolConvertToSelect: (fn) => boolConvertToSelect(fn),
  hoistAddrBase: (fn) => hoistAddrBase(fn),
  'hoistInvariantLoop.late': (fn, cfg, facts) => hoistInvariantLoop(fn, facts),
  cseScalarLoad: (fn) => cseScalarLoad(fn),
  // a chained kernel's out-parameter results stay in the locals that staged them, and the stores the chain overwrites go
  forwardStores: (fn) => forwardStores(fn),
  // (a loop's every-round stores to a slot it never reads, stored as it leaves)
  sinkStores: (fn) => sinkStores(fn),
  // (one ready before a computation it does not read goes first)
  earlyStores: (fn) => earlyStores(fn),
  promoteGlobals: (fn, cfg, facts) => promoteGlobals(fn, facts.globalRefTypes, facts.reachableWrites),
  unswitchTypedParamLoop: (fn, cfg, facts) => unswitchTypedParamLoop(fn, facts.f16),
  // Vectorization is jz LOWERING — it always runs pre-watr (never in a post-watr
  // re-optimize). watr is the sole optimizer that runs after, and it preserves the
  // v128 the lift produces.
  // foldStrDispatchF64(fn) must not run directly on `fn` here: `fn` is the real,
  // standalone-callable function, and foldStrDispatchF64's "proven rawF64 param"
  // claim is unsound for a bare declared param (see buildPureFuncMap's note above —
  // under NaN-boxing an f64 param can carry a string/undefined/atom just as validly
  // as a real number). Folding `fn` directly would strip its own live runtime
  // string/atom dispatch, not just a copy used for proven-numeric inline
  // substitution — the `g(m.get(missingKey))` "+"-miscompile class. The
  // pureFuncMap-driven inline path (buildPureFuncMap, above in assemble.js) instead
  // folds a private CLONE for the one context where the substituted argument is
  // independently proven numeric (a per-lane typed-array read) — that's the only
  // place this fold is sound.
  vectorizeLaneLocal: (fn, cfg, facts) => {
    if (vectorizeLaneLocal(fn, {
      multiAcc: cfg.reduceUnroll === true,
      relaxedFloat: cfg.relaxedFloat === true,
      relaxedSimd: cfg.relaxedSimd === true,
      blurMP: cfg.blurMultiPixel !== false,
      whyNot: cfg.whyNotSimd === true,
      stencil: cfg.stencil !== false,
      outerStrip: cfg.outerStrip !== false,
      pureFuncMap: facts.pureFuncMap || null,
      toneMap: cfg.toneMap !== false,
      slp: cfg.slp !== false,  // SLP default-on
      crPow: cfg.crPow === true,
      pairIterations: cfg.pairIterations === true,
      links: facts.loweringLinks, typedView: !!facts.typedView, warn: facts.warn,
    }) && typeof fn[1] === 'string') facts.vectorized?.add(fn[1])
  },
  // The vectorizer emits `v128.load/store (i32.add base K)` for the unrolled
  // multi-accumulator reduction (a[i],a[i+2],a[i+4]…) and stencil/strided reads:
  // one fewer i32.add per accumulator per iteration in hot dot/sum-style reduction loops.
  foldV128Memargs: (fn) => foldV128Memargs(fn),
  guardedUpdate: (fn) => foldGuardedUpdates(fn),
  // A view's length is fixed only where no buffer of the program resizes.
  typedDecode: (fn, cfg, facts) => { if (!facts.resizable) hoistTypedDecode(fn) },
  // Preserve source-unrolled SSA scratch before propagation sinks its single
  // definition into a local.tee. The transform is gated while it matures.
  splitLoopPrivateScratch: (fn, cfg, facts) => splitLoopPrivateScratch(fn, facts),
  'hoistInvariantLoop.scratch': (fn, cfg, facts) => hoistInvariantLoop(fn, facts),
  // Const-fn-array dispatch devirt: emit tagged the call_indirect of
  // `constOps[idx](args)` — rewrite to a br_table of direct calls with
  // the original call_indirect as the always-sound default arm.
  devirtFnArrays: (fn, cfg, facts) => devirtConstFnArrayCalls(fn, facts, cfg),
  devirtSchemaReads: (fn, cfg, facts) => devirtSchemaReads(fn, facts, cfg),
  // (the inline tail is the per-site fast path of a conversion: where those
  // share their helper for size, `inlineToNum: false`, this one calls its own)
  lowerToInt32Tails: (fn) => lowerToInt32Tails(fn),
  // (the specializer hands on the plan it read last where it changed nothing after)
  specializeLoops: (fn, cfg, facts, st) => { const left = { plan: null }; st.copies = specializeLoops(fn, left); st.plan = left.plan },
  narrowInts: (fn, cfg, facts, st) => narrowInts(fn, st.copies ?? null, cfg?.inlineToNum !== false, cfg?.wordTruncation ?? 'wide', st.plan ?? null),
  // A wide integer read only for its low word (an element offset) is that word;
  // the addresses it indexes take their constant parts into the memarg again.
  narrowWrappedWords: (fn, cfg, facts, st) => { st.wrapped = narrowWrappedWords(fn) },
  refoldMemargs: (fn, cfg, facts, st) => { if (st.wrapped) refoldMemargs(fn) },
  // Over the integers: the guards of the copies, where one test decides many.
  combineGuards: (fn, cfg, facts, st) => { if (st.copies) combineGuards(fn) },
  // Wide fallback copies otherwise hide both the vector loop scaffold and checked-access i32 certificates.
  wideAccumulator: (fn) => wideAccumulator(fn),
  narrowFloat32: (fn) => narrowFloat32(fn),
  // Recursion-unrolling clones the body the passes above leave (nqueens' `avail`
  // is an f64 with its conversions before the narrowing, 112 nodes against a gate
  // of 110; 90 after). Self-calls are still clean `call` nodes: watr's inliner
  // runs after this driver. Speed-tier only.
  recursionUnroll: (fn) => recursionUnroll(fn),
  // A load only its bits are read of is the load of the integer type.
  foldLoadCasts: (fn) => foldLoadCasts(fn),
  // A load an earlier one read, nothing stored between; then a part of a word read alone, the narrow load of it.
  reuseLoads: (fn) => reuseLoads(fn),
  narrowByteLoads: (fn) => narrowByteLoads(fn),
  // One a dominating test settled goes.
  settledTests: (fn) => dropSettledTests(fn),
  inlinePtrOffsetFast: (fn) => inlinePtrOffsetFastPass(fn),
}
const STEPS = stage('func', RUN)

/**
 * Run all per-function IR optimizations on a single function node, as the
 * 'func' stage of optimize/pass-table.js lists them.
 *
 * @param fn  func IR node
 * @param cfg optional resolved config from resolveOptimize() — when omitted, all on.
 * @param facts what the passes read of the compile (wat/assemble/optimize-module.js
 *   passFacts): when omitted, none, and a pass that needs one keeps its hand.
 * (The former 'post' phase and its csePureExprLoop arm are deleted, and the
 * straight-line csePureExpr followed in the 2026-07 ablation sweeps — watr's
 * write-clock CSE reaches a smaller fixpoint on its own; jz's optimizer runs
 * exactly once, before watr. splitLoopPrivateScratch remains as the flag-gated
 * migration seed.)
 */
export function optimizeFunc(fn, cfg, facts = {}) {
  // Entry verify attributes an invalid-IR failure to EMIT (already bad here)
  // vs an optimizer pass (bad only at the exit check) — the jzify free-name
  // `local.get $__it_drain` class was pinned this way. Debug-only cost.
  if (DBG_INVARIANTS) { const bad = verifyFn(fn); if (bad) throw new Error(`[ir verify] fn ${fn[1]} invalid at optimizeFunc ENTRY (emit-produced): ${bad}`) }
  if (cfg && cfg.hoistPtrType === false &&
      cfg.hoistInvariantPtrOffset === false &&
      cfg.hoistInvariantLoop === false &&
      cfg.narrowLoopBound === false &&
      cfg.fusedRewrite === false &&
      cfg.hoistAddrBase === false &&
      cfg.cseScalarLoad === false &&
      cfg.unswitchStringRepLoop === false &&
      cfg.propagateLocals === false &&
      cfg.promoteGlobals === false &&
      cfg.sortLocalsByUse === false &&
      cfg.vectorizeLaneLocal === false &&
      cfg.inlinePtrOffsetFast === false) return
  walk(STEPS, RUN, cfg, fn, facts, {})
  // An optimizer pass that emits a malformed local — the class that otherwise dies
  // as an opaque watr "Duplicate/Unknown local $x" several phases on — is caught
  // here, pinned to the function and the bad name.
  if (DBG_INVARIANTS) { const bad = verifyFn(fn); if (bad) throw new Error(`[ir verify] optimize produced invalid IR in ${fn[1]}: ${bad}`) }
}
