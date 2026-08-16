/**
 * Pre-emit compile planning: bridges prepare (AST shape) and emit (wasm bytes).
 *
 * # Stage contract
 *   IN:  populated `ctx` from prepare.js (functions, schemas, scopes, modules)
 *        plus the prepared AST.
 *   OUT: returns a `programFacts` object; mutates `ctx` so each function has
 *        narrowed signatures, finalized global reps, and per-call decisions.
 *
 * # Pipeline (top-level `plan(ast)`)
 *   1. unboxConstTypedGlobals — finalize global storage. (Global value facts
 *      themselves are seeded by prepare via `infer.recordGlobalRep`.)
 *   2. collectProgramFacts — sweep arrow bodies for typed-elem usage, key sets,
 *      loop depth, control-transfer shapes; rerun if hot inlining changes the AST.
 *   3. materializeAutoBoxSchemas / resolveClosureWidth — settle layout decisions.
 *   4. Whole-program narrowing (skipped on simple programs):
 *        - narrowSignatures — pick a specialization per function from call sites
 *        - specializeBimorphicTyped — split typed-elem hot paths into two variants
 *          when callers diverge between two ctors
 *        - specializeValKindDichotomy — clone+pin a param's VAL kind when call
 *          sites landslide-disagree (≥90% one kind), fallback stays generic
 *        - refineDynKeys — tighten dynamic property-key sets
 *
 * No bytes are emitted here; emit.js consumes the planned ctx + programFacts.
 *
 * @module plan
 */

import { ctx } from '../../ctx.js'
import { invalidateAllBodyFacts } from '../analyze.js'
import { collectProgramFacts, analyzeSchemaSlotIntCertain, observeProgramSlots, analyzeParamNeverGrown } from '../program-facts.js'
import narrowSignatures, {
  specializeBimorphicTyped, specializeValKindDichotomy, speculateTypedParams, refineDynKeys,
  applyJsstringBoundaryCarrierStandalone, narrowBoolResults,
  strictBoundaryTypeCheck,
} from '../narrow.js'

import { optimizing } from './common.js'
import { adviseProgram } from './advise.js'
import { scanInplaceStores } from '../inplace-store.js'
import {
  inferModuleLetTypes, inferModuleGlobalValTypes, unboxConstTypedGlobals, inferModuleIntGlobals, refineFieldProvenance,
  flattenFuncNamespaces, devirtGlobalCalls, classifyHashDictGlobals,
  materializeAutoBoxSchemas, resolveClosureWidth, canSkipWholeProgramNarrowing,
} from './scope.js'
import { inlineHotInternalCalls, inlineLocalLambdas, specializeFixedRestCalls } from './inline.js'
import { bindNestedRowLengths, unrollRowLenPadLoops, splitCharScanLoops } from './loops.js'
import {
  scalarizeFunctionTypedArrays, scalarizeFunctionArrayLiterals,
  promoteIntArrayLiterals, scalarizeFunctionObjectLiterals, analyzeParamDistinctness,
} from './literals.js'

/**
 * @param {{mark: Function, exit: Function}} [regionHooks] - region-arena
 *  PLAN-TAIL boundaries (.work/research.md §Region arena, per-pass slice):
 *  supplied ONLY by the self-host kernel, forwarded from compile()'s own
 *  `regionHooks` (Slice 3) — never passed by the native host (plan() is
 *  called with 2 args everywhere else, so this stays undefined and every
 *  `regionHooks?.mark()` / `if (regionHooks)` below is dead code there).
 *  `narrowSignatures` itself (and its own internal narrow.js machinery,
 *  the single largest cost in this function — .work/research.md §Region
 *  arena "jz×jz phase-localized") is deliberately OUTSIDE every boundary
 *  here: narrow.js's O(functions×params×callSites) census is a NAMED,
 *  separately-banked pathology (627cf92a), not a churn-vs-retain shape a
 *  region round can help — wrapping it would mean rooting `programFacts`
 *  mid-fixpoint while narrowSignatures is still mutating it in place, a
 *  correctness hazard for zero reclaim (its own allocations ARE the
 *  fixpoint's live state, not garbage). Every boundary below starts AFTER
 *  narrowSignatures returns. Five rounds, one per named pass-group from
 *  the diffuse-cost phase map (0ae75f07, .work/research.md §Region arena
 *  "analyzeFuncForEmit's OWN clone-shape instances FIXED"): each pass's
 *  own working state (siteState-shaped temporaries, per-call scratch
 *  objects, body-walk locals) is garbage the instant the pass returns —
 *  never read by a LATER pass — while the FACTS each pass publishes
 *  (`programFacts` itself, `ctx.scope`/`ctx.types`/`ctx.schema`/
 *  `ctx.closure`/`ctx.funcs`) must survive to `emitFuncs`. Root is
 *  IDENTICAL across all five rounds (the container-level shape compile()'s
 *  own Slice 3 doc specifies, "root the CONTAINERS, not individual leaf
 *  fields") — `ctx.transform` excluded (plan() never writes it, per
 *  ctx.js's own writer table, so it stays durable and needs no root entry
 *  regardless of round count).
 */
export default function plan(ast, profiler, regionHooks) {
  // Per-pass timing under `plan:` — the plan stage is the compile pipeline's
  // multi-pass hot spot (each mutating pass triggers a whole-program fact
  // refresh), so the profile must show WHICH pass and refresh dominate.
  const t = profiler?.time ? (name, fn) => profiler.time(`plan:${name}`, fn) : (_, fn) => fn()
  // One round shape shared by all five plan-tail boundaries below — mark,
  // run `body`, exit rooting `ast`/`programFacts` (phase-local, not session
  // state) + the UNION-FIELD root (Slice C-v2, `.work/compile-session-
  // design.md` §2.1/§3, front.js's own doc has the full rationale for why
  // this is the union of every `ctx.*` field ANY round in this campaign has
  // ever needed — `funcs, module, schema, closure, scope, types, warnings,
  // plans, inspect, func, transform, facts` — applied uniformly here too,
  // not just this round's own historical subset, closing the SAME kind of
  // cross-round inconsistency a616ca43's session found and fixed). A
  // durable container's BACKING STORE can still grow, ephemeral, post-mark,
  // during any of these rounds' own passes — round 1's `narrowBoolResults`
  // populating `bodyFacts` (`ctx.facts`) on first touch per function was
  // the confirmed case — so `ctx.facts` rides along explicitly rather than
  // via a trailing, non-rebound `getFactStore()` call.
  // `exitRound` is factored out of `round` below so the two upstream rounds
  // (early-plan prefix, narrowSignatures whole-call — 7346f7e7's own design,
  // reimplemented here against the CURRENT 14-field union bundle rather than
  // reproducing that session's own narrower 11-field `fullRoot()`) can share
  // the identical exit shape without a third copy of this array literal.
  const exitRound = m => {
    if (regionHooks)
      [ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts] =
        regionHooks.exit(m, [ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts])
  }
  const round = body => {
    const m = regionHooks?.mark()
    body()
    exitRound(m)
  }
  // AST-mutating pass: run timed; on change, re-sweep program facts (timed
  // separately — the refreshes are usually the cost, not the passes).
  // Fact freshness is OWNED HERE (stage-2 solver slice 1): mutating passes
  // report that they changed the AST (truthy return) and the driver marks the
  // fact store dirty; the store re-collects LAZILY at the next facts() READ.
  // Passes no longer trigger eager whole-program refreshes — back-to-back
  // mutations between reads collapse into ONE re-collect, and a pass cannot
  // forget to refresh (reading through facts() is the only access). Laziness
  // is scoped to the sweep window: after it, `programFacts` is materialized
  // once and ENRICHED in place (narrowSignatures settles paramReps into the
  // same object), so no later re-collect may discard those writes.
  let _facts = null, _dirty = true
  const facts = () => {
    if (_dirty) { _facts = t('collectFacts', () => collectProgramFacts(ast)); _dirty = false }
    return _facts
  }
  const sweep = (name, pass) => {
    if (t(name, pass)) _dirty = true
  }

  // Region-arena EARLY-PLAN round (7346f7e7's own design — 627cf92a's phase
  // map named this exact span "+900MB before narrowSignatures even starts":
  // compileAst entry → plan() entry → classifyHashDictGlobals →
  // flattenFuncNamespaces/devirtGlobalCalls/inlineHotInternalCalls →
  // collectProgramFacts's own dirty-resweep loop → narrowSignatures entry).
  // Every pass from here through `resolveClosureWidth` is a SEQUENTIAL
  // top-level call, none a loop body holding a stale container reference
  // across an exit (the `ctx.funcs.list` relocation hazard `round()`'s own
  // doc and e640e77a's design note name doesn't apply — nothing below
  // iterates `ctx.funcs.list` across this boundary). One round spanning the
  // WHOLE early-plan prefix: mark here, exit right before the
  // `canSkipWholeProgramNarrowing` branch below — after `programFacts` is
  // declared and `resolveClosureWidth` has settled it — so BOTH the skip-path
  // and the full-narrowing path start from an already-reclaimed state. Uses
  // raw mark/`exitRound()` rather than the `round(body)` wrapper because
  // `programFacts` itself is DECLARED partway through this span (`let
  // programFacts = facts()` below) — nesting that declaration inside a
  // `round(() => {...})` callback would scope it away from every later
  // reader (`canSkipWholeProgramNarrowing` and the whole narrowing tail).
  const __earlyMark = regionHooks?.mark()

  t('inferModuleLetTypes', () => inferModuleLetTypes(ast))
  // Pass 1 (no call-site param facts yet): literal/alias/global-to-global
  // evidence only. Early enough that a freshly-proven NUMBER global still
  // reaches inferModuleIntGlobals's candidacy check below.
  t('inferModuleGlobalValTypes', () => inferModuleGlobalValTypes(ast))
  t('unboxConstTypedGlobals', unboxConstTypedGlobals)
  t('inferModuleIntGlobals', () => inferModuleIntGlobals(ast))

  facts()
  // Receiver-HASH global classification (.work/todo.md §deletion-sweep):
  // fill `ctx.scope.globalValTypes` with VAL.HASH for module-level `{}`-decl
  // dict globals module/object.js's allocator already tags HASH at the
  // pointer level (identical predicate — target's merged schema empty +
  // dynWriteVars membership) — a pure FILL (`.has()`-guarded, see
  // classifyHashDictGlobals doc), so it can run this early: before
  // flattenFuncNamespaces/devirtGlobalCalls, using the just-collected
  // programFacts.dynWriteVars directly (`ctx.types.dynWriteVars` isn't
  // published until this function's later `programFacts` fan-out below).
  t('classifyHashDictGlobals', () => classifyHashDictGlobals(ast, facts()))
  // Function-namespace SROA — dissolve reassigned `f.prop` slots into module
  // globals before inlining/narrowing, so all downstream passes see plain
  // globals instead of the dynamic property machinery.
  sweep('flattenFuncNamespaces', () => flattenFuncNamespaces(ast))
  // Devirtualize calls through init-constant function globals (closure
  // devirtualization) — must follow the SROA above, which creates the globals.
  t('devirtGlobalCalls', () => devirtGlobalCalls(ast))
  sweep('bindNestedRowLengths', bindNestedRowLengths)
  sweep('unrollRowLenPadLoops', unrollRowLenPadLoops)
  // The call-inlining family (`inlineHotInternalCalls` self-gates on `sourceInline`)
  // is a pure speed optimization — the un-inlined calls emit correctly. Scalar
  // replacement (`scalarize*`) and array promotion gate on `optimizing()`: off only
  // under a fully-disabled optimizer, on for every enabled preset (incl. the
  // `optimize:{sourceInline:false}` heap-elision-test form, which is level-2 based).
  sweep('inlineHotInternalCalls', () => inlineHotInternalCalls(facts(), ast))
  sweep('bindNestedRowLengths', bindNestedRowLengths)
  sweep('unrollRowLenPadLoops', unrollRowLenPadLoops)
  sweep('inlineLocalLambdas', inlineLocalLambdas)
  sweep('specializeFixedRestCalls', () => specializeFixedRestCalls(facts()))
  if (optimizing()) {
    sweep('splitCharScan', splitCharScanLoops)
    sweep('scalarizeArrayLiterals', scalarizeFunctionArrayLiterals)
    sweep('scalarizeObjectLiterals', scalarizeFunctionObjectLiterals)
    // Promotion runs AFTER literal scalarization (those that fully reduce to scalars
    // are gone) and BEFORE typed-array scalarization (so a freshly-promoted array's
    // fixed-length-typed-of-known-size variant could still participate in loop
    // unrolling — currently it can't, since promotion produces the `[...]`-arg
    // form rather than `new Int32Array(N)`, but the ordering keeps the door open).
    sweep('promoteIntArrayLiterals', promoteIntArrayLiterals)
    sweep('scalarizeTypedArrays', () => scalarizeFunctionTypedArrays(facts()))
  }
  // `let`, not `const`: the plan-tail region rounds below (region-live only,
  // dead code otherwise) rebind this from each round's `exit()` return —
  // `__region_copy_rec` may relocate the object wholesale.
  let programFacts = facts()
  ctx.types.dynKeyVars = programFacts.dynVars
  ctx.types.dynWriteVars = programFacts.dynWriteVars
  ctx.types.anyDynKey = programFacts.anyDyn
  ctx.types.literalWriteKeys = programFacts.literalWriteKeys
  ctx.types.writtenProps = programFacts.writtenProps
  ctx.types.arrResized = programFacts.arrResized
  ctx.types.nameEscapes = programFacts.nameEscapes

  t('materializeAutoBoxSchemas', () => materializeAutoBoxSchemas(programFacts))
  t('resolveClosureWidth', () => resolveClosureWidth(programFacts))
  // Early-plan round's own exit — fixpoint complete for this span (nothing
  // below is still mutating what was just rooted mid-pass; `programFacts`
  // keeps accumulating in EITHER branch below, exactly like every other
  // round's own "enriched in place, never re-collected past this point"
  // contract).
  exitRound(__earlyMark)
  if (canSkipWholeProgramNarrowing(programFacts)) {
    // Phase J (jsstring boundary opt-in) is body-local and call-site-independent;
    // run it even when the rest of narrowing is skipped so simple `export let
    // f = (s) => s.length` still flips to externref. Likewise the boolean-result
    // fact, so `export let f = (a) => a > 2` boxes its boundary atom.
    applyJsstringBoundaryCarrierStandalone(programFacts)
    narrowBoolResults()
    strictBoundaryTypeCheck(programFacts)
    adviseProgram(programFacts)
    return programFacts
  }

  // Region-arena NARROWSIGNATURES round (7346f7e7's own design — the named
  // next lever after e640e77a's own "narrowSignatures itself is EXCLUDED"
  // boundary design and 0ae75f07's callee-index fix). e640e77a's exclusion
  // rationale ("wrapping it would mean rooting `programFacts` mid-fixpoint
  // while narrowSignatures is still mutating it in place — a correctness
  // hazard for zero reclaim") is about boundaries INSIDE narrowSignatures'
  // own internal fixpoint (its internal `runFixpointConverged()` sweeps) —
  // never attempted here. This wraps the WHOLE call via the standard
  // `round(body)` helper: mark before, exit strictly AFTER narrowSignatures
  // returns (its own fixpoint fully converged, `programFacts.paramReps`/
  // `.callSites` settled) — no mid-mutation rooting, by construction.
  // narrowSignatures returns nothing — its entire effect is IN-PLACE
  // MUTATION of `programFacts` (`.paramReps`/`.callSites`) and `ctx.funcs`
  // (`func.sig.*`/`.valResult`/...), both already union-root members, plus
  // `ctx.facts` (`analyzeBody` first-touch population inside its own
  // multi-phase fixpoint — the same 274b6bd8 hazard the early-plan round
  // above already covers) — every touched container already rides in
  // `round()`'s own 14-field bundle, no extra audit needed beyond
  // confirming narrowSignatures writes nothing outside it (verified:
  // narrow.js references only `programFacts`, `ctx.funcs`/`.func`,
  // `ctx.scope`/`.types` read-only + self-restored `ctx.types.typedElem`).
  round(() => t('narrowSignatures', () => narrowSignatures(programFacts, ast)))
  // Boolean/bigint result kinds for funcs the call-site census can't reach —
  // value-used-only functions have no direct sites, but their results still
  // cross boxed positions (closure trampolines, boundary wrappers). Guarded:
  // only ever SETS an unset valResult (see narrowBoolResults doc).
  // Plan-tail round 1 (own boundary — the single largest individual delta
  // outside narrowSignatures itself, +198 MB measured, 0ae75f07's phase map).
  round(() => t('narrowBoolResults', () => narrowBoolResults()))
  // Plan-tail round 2: the six passes below (+~395 MB combined, dominated by
  // analyzeParamDistinctness's own +159 MB) share one round — none indivi-
  // dually justifies a dedicated mark/exit pair, and they run back-to-back
  // with no external read between them.
  round(() => {
    // Pass 2: narrowSignatures has now settled `programFacts.paramReps`, so a
    // global written from a bare parameter alias (`cur = s`, subscript's parse-
    // state shape) resolves — pass 1 saw only an untyped param and poisoned it.
    // Idempotent: names pass 1 already claimed are skipped.
    t('inferModuleGlobalValTypes2', () => inferModuleGlobalValTypes(ast, programFacts.paramReps))
    // After narrowSignatures (params now carry ptrKind): mark typed-array params that every call
    // site passes a distinct fresh buffer for → enables alias-aware LICM in the optimizer.
    if (optimizing()) t('analyzeParamDistinctness', () => analyzeParamDistinctness(programFacts))
    // Slot-kind census REBUILD with post-narrowing receiver resolution: the early
    // hazard scan can't type params (`re[j] = tr` on a then-unnarrowed TYPED param
    // read as a world-poisoning keyed write), so recompute hazards with paramReps
    // and rebuild slotTypes/slotTypedCtors fresh BEFORE their consumers below
    // (inplace sweep, bimorphic split, typed-param speculation) and at emit.
    t('refineSlotKindCensus', () => observeProgramSlots(ast, { fresh: true, paramReps: programFacts.paramReps }))
    // Cross-function neverGrown for read-only array PARAMS (growth-free callee
    // closure + safeReads) — the raw-base element read skips __ptr_offset.
    if (optimizing()) t('analyzeParamNeverGrown', () => analyzeParamNeverGrown(programFacts.paramReps))
    // Whole-program alias sweep for in-place replace-stores (`arr[i] = {lit}` →
    // overwrite the old element's slots) — needs the settled arrayElemSchema
    // facts, so it runs after the signature fixpoint.
    if (optimizing()) t('scanInplaceStores', () => scanInplaceStores(programFacts))
    t('specializeBimorphicTyped', () => specializeBimorphicTyped(programFacts))
  })
  // Plan-tail round 3: five more passes, small individually (refineDynKeys is
  // the largest at +15 MB) — bundled for the same reason as round 2.
  round(() => {
    // VAL-kind landslide specialization (context-sensitivity-survey.md §3-4): a
    // pure precision/perf slice, sized/gated the same as speculateTypedParams.
    if (optimizing()) t('specializeValKindDichotomy', () => specializeValKindDichotomy(programFacts))
    if (optimizing()) t('speculateTypedParams', () => speculateTypedParams(programFacts, ast))
    t('refineDynKeys', () => refineDynKeys(programFacts))
    // Late: return sids (narrowSignatures) + the slot/write censuses are complete —
    // bind module consts' schemas from returned objects, then re-run the module-let
    // ctor fixpoint whose FIELD evidence (slotTypedCtorAt, write-gated) resolves
    // only now. Upgrade-only: strictly more evidence than the early run.
    t('refineFieldProvenance', () => refineFieldProvenance(ast))
    t('refineModuleLetTypes', () => inferModuleLetTypes(ast))
  })
  // Plan-tail round 4 (own boundary — the second-largest post-narrowSignatures
  // delta, +60 MB, analyzeSchemaSlotIntCertain's own whole-program AST walk).
  round(() => {
    // Late slot-int census: rebuild FRESH with body-local element-alias sids
    // (`const p = ps[i]` through the param's arrayElemSchema — knowledge that
    // exists only after narrowing). Consumers read at emit, after this.
    t('refineSlotIntCensus', () => analyzeSchemaSlotIntCertain(ast, { paramReps: programFacts.paramReps }))
  })
  // Plan-tail round 5: the plan() tail — invalidateAllBodyFacts drops the
  // now-stale analyzeBody cache entries the late upgrades above superseded
  // (its OWN +22 MB is churn from the walk that decides what to drop, not
  // retained state — the dropped entries themselves were never rooted, so
  // they're already reclaimed by rounds 3-4's own exits before this runs).
  round(() => {
    invalidateAllBodyFacts()
    strictBoundaryTypeCheck(programFacts)
    adviseProgram(programFacts)
  })
  return programFacts
}
