/**
 * The pass driver: `optimizeFunc` runs every per-function IR optimization on
 * one func node, in the fixed order the passes' cross-comments document
 * (structural hoists before the fused peephole walk, LICM before and after
 * fusedRewrite, vectorize before the late ptr_offset inliner, devirt before
 * the final loop-rotation/bool-canon/local-sort cleanup). Each pass lives in
 * its own family module; this file only sequences them.
 *
 * @module optimize/driver
 */
import { ctx } from '../ctx.js'
import { verifyFn } from '../ir.js'
import { recursionUnroll } from './recurse.js'
import { vectorizeLaneLocal } from './vectorize.js'
import { hoistPtrType, hoistAddrBase } from './cse-address.js'
import {
  boolConvertToSelect, foldV128Memargs, inlinePtrOffsetFastPass,
  simplifyBoolContexts, rotateLoops, fusedRewrite,
} from './peephole.js'
import { hoistInvariantPtrOffset, splitLoopPrivateScratch, hoistInvariantLoop, narrowLoopBound, cseScalarLoad } from './licm.js'
import { propagateSingleUse, foldSetToTee } from './locals.js'
import { promoteGlobals } from './globals.js'
import { unswitchTypedParamLoop, unswitchStringRepLoop } from './unswitch.js'
import { devirtSchemaReads, foldStaticConstArrayReads, devirtConstFnArrayCalls } from './devirt.js'
import { sortLocalsByUse } from './sort-locals.js'

// Debug-mode IR structural check (JZ_DEBUG_INVARIANTS=1). Zero production cost.
const DBG_IR = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'

/**
 * Run all per-function IR optimizations on a single function node.
 * hoistPtrType runs first — it introduces new locals (`$__ptN`) that the fused
 * walk should see in their final form. fusedRewrite then collapses rebox/unbox
 * round-trips, inlines tiny ptr/is_* helpers, and folds (i32.add base const)
 * into memarg offset= form, all in a single bottom-up traversal — and
 * piggybacks local-ref counting so sortLocalsByUse skips its own walk.
 *
 * @param fn  func IR node
 * @param cfg optional resolved config from resolveOptimize() — when omitted, all on.
 * @param globalTypes optional global name → wasm type map (for promoteGlobals)
 * @param volatileGlobals optional set of callee-mutable globals (see collectVolatileGlobals)
 * (The former 'post' phase and its csePureExprLoop arm are deleted, and the
 * straight-line csePureExpr followed in the 2026-07 ablation sweeps — watr's
 * write-clock CSE reaches a smaller fixpoint on its own; jz's optimizer runs
 * exactly once, before watr. splitLoopPrivateScratch remains as the flag-gated
 * migration seed; see the splitScratch gate below.)
 */
export function optimizeFunc(fn, cfg, globalTypes, volatileGlobals, reachableWrites) {
  // Entry verify attributes an invalid-IR failure to EMIT (already bad here)
  // vs an optimizer pass (bad only at the exit check) — the jzify free-name
  // `local.get $__it_drain` class was pinned this way. Debug-only cost.
  if (DBG_IR) { const bad = verifyFn(fn); if (bad) throw new Error(`[ir verify] fn ${fn[1]} invalid at optimizeFunc ENTRY (emit-produced): ${bad}`) }
  if (cfg && cfg.hoistPtrType === false &&
      cfg.hoistInvariantPtrOffset === false &&
      cfg.hoistInvariantLoop === false &&
      cfg.narrowLoopBound === false &&
      cfg.fusedRewrite === false &&
      cfg.hoistAddrBase === false &&
      cfg.cseScalarLoad === false &&
      cfg.unswitchStringRepLoop === false &&
      cfg.propagateSingleUse === false &&
      cfg.promoteGlobals === false &&
      cfg.sortLocalsByUse === false &&
      cfg.vectorizeLaneLocal === false &&
      cfg.inlinePtrOffsetFast === false) return
  // Static-const-array base/len fold runs FIRST: it matches the exact emit shape
  // via node tags (.saArr/.saBits), and any later pass that rebuilds a subtree
  // (CSE, fused rewrite, LICM temp-splitting) strips array properties — the tag
  // only survives untouched nodes.
  if (!cfg || cfg.foldStaticArrReads !== false) foldStaticConstArrayReads(fn)
  // Recursion-unrolling runs first in 'pre': self-calls are still clean `call`
  // nodes (watr's inliner hasn't reshaped them) and the freshly-inlined body then
  // rides every pass below (LICM, fold, sort). Speed-tier only; 'pre' only (so the
  // post-watr re-optimize doesn't unroll a second time).
  if (cfg && cfg.recursionUnroll === true) recursionUnroll(fn)
  if (!cfg || cfg.hoistPtrType !== false) hoistPtrType(fn)
  if (!cfg || cfg.hoistInvariantPtrOffset !== false) hoistInvariantPtrOffset(fn)
  // Before LICM: the snapped i32 bound is itself a hoistable hard-op subtree, so
  // an outer loop's LICM can lift it further when the bound is outer-invariant.
  if (!cfg || cfg.narrowLoopBound !== false) narrowLoopBound(fn)
  // Unified LICM (replaces hoistInvariantToInt32 / PtrOffsetLoop / CellLoads).
  // Run at both maturity points (idempotent): pre-fusedRewrite catches the raw
  // ToInt32/ptr-offset/arithmetic shapes; post-hoistAddrBase catches cell loads.
  if (!cfg || cfg.hoistInvariantLoop !== false) hoistInvariantLoop(fn)
  const counts = new Map()
  if (!cfg || cfg.fusedRewrite !== false) fusedRewrite(fn, counts)
  if (cfg && cfg.unswitchStringRepLoop === true && ctx.funcs.list.length <= 64 &&
      fn.some(n => Array.isArray(n) && n[0] === 'local' && typeof n[1] === 'string' && n[1].endsWith('$ccsso')))
    unswitchStringRepLoop(fn)
  if (cfg && cfg.boolConvertToSelect === true) boolConvertToSelect(fn)
  if (!cfg || cfg.hoistAddrBase !== false) hoistAddrBase(fn)
  if (!cfg || cfg.hoistInvariantLoop !== false) hoistInvariantLoop(fn)
  if (!cfg || cfg.cseScalarLoad !== false) cseScalarLoad(fn)
  if (!cfg || cfg.promoteGlobals !== false) promoteGlobals(fn, globalTypes, volatileGlobals, reachableWrites)
  if (cfg && cfg.vectorizeLaneLocal === true) {
    // Vectorization is jz LOWERING — it always runs pre-watr (never in a post-watr
    // re-optimize). watr is the sole optimizer that runs after, and it preserves the
    // v128 the lift produces. `phase === 'post'` is now vestigial (no post caller).
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
    if (!cfg || cfg.unswitchTypedParamLoop !== false) unswitchTypedParamLoop(fn)
    if (vectorizeLaneLocal(fn, {
      multiAcc: cfg.reduceUnroll === true,
      relaxedFma: cfg.relaxedSimd === true,
      blurMP: cfg.blurMultiPixel !== false,
      whyNot: cfg.whyNotSimd === true,
      stencil: cfg.stencil !== false,
      outerStrip: cfg.outerStrip !== false,
      pureFuncMap: cfg._pureFuncMap || null,
      toneMap: cfg.toneMap !== false,
      slp: cfg.slp !== false,  // SLP default-on
      crPow: cfg.crPow === true,
    }) && typeof fn[1] === 'string') (cfg._vectorizedFnNames ??= new Set()).add(fn[1])
    // The vectorizer emits `v128.load/store (i32.add base K)` for the unrolled
    // multi-accumulator reduction (a[i],a[i+2],a[i+4]…) and stencil/strided reads.
    // fusedRewrite's memarg fold already ran (above, before vectorize), so fold the
    // freshly-created v128 memargs now — one fewer i32.add per accumulator per
    // iteration in hot dot/sum-style reduction loops.
    foldV128Memargs(fn)
  }
  // Speed-tier only, and deliberately LATE (after unswitchTypedParamLoop/
  // vectorizeLaneLocal above, not bundled into fusedRewrite's earlier walk):
  // unswitchTypedParamLoop's polymorphic-store recognizer pattern-matches the
  // RAW `(call $__ptr_offset …)` shape inside the typed-array fallback store to
  // prove a Float64Array param loop is safe to unswitch + SIMD-lift — running
  // this inline first (it used to live in fusedRewrite) erased that shape and
  // silently starved the unswitch of its match (a whole scalar→SIMD loop lift
  // lost to save a handful of call frames — measured on the DSP self-map flagship
  // shape, test/unswitch-typed-param.js). Running here, after that pass has had
  // its pick, inlines whatever `$__ptr_offset` calls remain — still the large
  // majority of sites.
  if (cfg && cfg.inlinePtrOffsetFast === true) inlinePtrOffsetFastPass(fn)
  // Preserve source-unrolled SSA scratch before propagation sinks its single
  // definition into a local.tee. The transform is gated while it matures; when
  // enabled, its moved invariants ride the normal LICM pass once more below.
  if (cfg && cfg.splitScratch === true && (!cfg || cfg.hoistInvariantLoop !== false)) {
    splitLoopPrivateScratch(fn)
    hoistInvariantLoop(fn)
  }
  // Forward-substitute single-use temps — AFTER the vectorizer, never before: it pattern-matches a
  // STRAIGHT-LINE `s += a[i]*2`, and folding an address/index temp out scrambles it (the typed-array
  // loop fell from a SIMD body to a scalar unroll, +231 B). For watr:false the whole pipeline is the
  // 'pre' phase (no 'post' re-run), so vectorize already ran above; for full watr the vectorizer is
  // deferred to 'post', so skip 'pre' here to stay after it. (propagateSingleUse itself skips any
  // function the vectorizer already lifted to v128.)
  // Forward-substitute single-use temps AFTER the vectorizer (which now always runs in
  // 'pre', above) — propagateSingleUse itself skips any function already lifted to v128.
  if (!cfg || cfg.propagateSingleUse !== false) propagateSingleUse(fn)
  // Then sink single-def RHS into first use as a tee — captures the simplify-locals slack
  // watr's use-count propagate leaves (set→tee fold, incl. effectful single-use forward).
  if (!cfg || cfg.foldSetToTee !== false) foldSetToTee(fn)
  // A second idempotent sweep catches fresh opportunities exposed by
  // propagation/fold-to-tee. The first sweep above does the important work
  // while source-level SSA names are still explicit.
  if (cfg && cfg.splitScratch === true && (!cfg || cfg.hoistInvariantLoop !== false)) {
    splitLoopPrivateScratch(fn)
    hoistInvariantLoop(fn)
  }
  // Const-fn-array dispatch devirt: emit tagged the call_indirect of
  // `constOps[idx](args)` (the decl's candidate set only fills when module init
  // emits, AFTER function bodies) — rewrite to a br_table of direct calls with
  // the original call_indirect as the always-sound default arm.
  if (!cfg || cfg.devirtFnArrays !== false) devirtConstFnArrayCalls(fn, cfg)
  if (!cfg || cfg.devirtSchemaReads !== false) devirtSchemaReads(fn)
  // Loop rotation — the LAST shape pass. Runs in the pre phase (the only phase now); the
  // vectorizer above has already formed the v128 loops it skips. Speed-tier: it duplicates the
  // loop condition for a fused conditional back-edge (1.35× on the lz/qoi scalar scans). watr's
  // loopify is disabled when vectorizing, so nothing downstream reverts the rotation.
  if (cfg && cfg.rotateLoops === true) rotateLoops(fn)
  // Canonicalize boolean conditions (strip redundant `!= 0` / double-`eqz`) — after
  // rotateLoops so its fused back-edges get cleaned too. Tied to the peephole pass.
  if (!cfg || cfg.fusedRewrite !== false) simplifyBoolContexts(fn)
  if (!cfg || cfg.sortLocalsByUse !== false) sortLocalsByUse(fn, cfg && cfg.fusedRewrite !== false ? counts : null)
  // An optimizer pass that emits a malformed local — the class that otherwise dies
  // as an opaque watr "Duplicate/Unknown local $x" several phases on — is caught
  // here, pinned to the function and the bad name.
  if (DBG_IR) { const bad = verifyFn(fn); if (bad) throw new Error(`[ir verify] optimize produced invalid IR in ${fn[1]}: ${bad}`) }
}
