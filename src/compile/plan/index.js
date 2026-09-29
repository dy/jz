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
 *   3. resolveClosureWidth: settle layout decisions.
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

import { ctx, getFactStore } from '../../ctx.js'
import { clearBodyFacts } from '../analyze.js'
import {
  collectProgramFacts, collectSlotConstants, analyzeSchemaSlotIntCertain, collectSlotWriteHazards, analyzeParamNeverGrown,
  synthesizeComputedDispatchCallSites, synthesizeMemberDispatchCallSites, readonlyParamReps, freezeCallSites,
  assertProgramFactsShape,
} from '../program-facts.js'
import { buildProgramIndex, releaseLiftedAddressTakenNames } from '../program-index.js'
import narrowSignatures, {
  specializeBimorphicTyped, specializeValKindDichotomy, speculateTypedParams, refineDynKeys,
  applyJsstringBoundaryCarrierStandalone, seedResultKinds,
  strictBoundaryTypeCheck, applyExportTypedArrayAbi, splitByListKinds,
} from '../narrow.js'

import { optimizing } from './common.js'
import { adviseProgram } from './advise.js'
import { scanInplaceStores } from '../inplace-store.js'
import { solveRepresentationBoundaries } from '../representation-plan.js'
import {
  moduleGlobalKinds, unboxConstTypedGlobals, inferModuleIntGlobals, dropUnreadGlobals,
  flattenFuncNamespaces, devirtGlobalCalls, devirtClassCalls, classifyHashDictGlobals,
  resolveClosureWidth, canSkipWholeProgramNarrowing,
  holdModuleNumbers, resolveHeldMethods, holdModuleRegexes,
} from './scope.js'
import { declareWrittenKeys } from './declare-written-keys.js'
import { declareUnseenKeys } from './declare-unseen-keys.js'
import { versionIntegralLoops } from './integral-loops.js'
import { callChosenFunctions } from './chosen-calls.js'
import { foldKindTests } from './fold-kind-tests.js'
import { indexArrayPatterns } from './index-array-patterns.js'
import { inlineHotInternalCalls, inlineLocalLambdas, specializeFixedRestCalls } from './inline.js'
import { laneRecordParams } from './lanes.js'
import { bindNestedRowLengths, unrollRowLenPadLoops, splitCharScanLoops } from './loops.js'
import { guardConstants, canonicalizeCountedLoops } from './counted-loops.js'
import { scalarizeModuleScratch } from './scratch.js'
import { resolveAliases, splitSplicedBindings } from './alias.js'
import { propagateConstants } from './constants.js'
import {
  scalarizeFunctionTypedArrays, scalarizeFunctionArrayLiterals,
  promoteIntArrayLiterals, scalarizeFunctionObjectLiterals, analyzeParamDistinctness,
} from './literals.js'

/** Plan the program: `summarize` returns the program summary (src/summary) of the AST as it stands, rebuilt only when the program changed. */
export default function plan(ast, profiler, summarize) {
  // Per-pass timing under `plan:` — the plan stage is the compile pipeline's
  // multi-pass hot spot (each mutating pass triggers a whole-program fact
  // refresh), so the profile must show WHICH pass and refresh dominate.
  const t = profiler?.time ? (name, fn) => profiler.time(`plan:${name}`, fn) : (_, fn) => fn()
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
    if (t(name, pass)) { _dirty = true; getFactStore().revision++ }
  }

  // The module globals' kinds are the summary's, whole-program from the start:
  // a NUMBER global reaches inferModuleIntGlobals's candidacy below.
  t('moduleGlobalKinds', () => moduleGlobalKinds(ctx.summary))
  t('unboxConstTypedGlobals', unboxConstTypedGlobals)
  sweep('inferModuleIntGlobals', () => inferModuleIntGlobals(ast))
  // A test the summary decided folds with the arm it never takes. What that arm
  // passed on then joins no kind, which may decide further tests.
  for (let round = 0; round < 4; round++) {
    if (!t('foldKindTests', foldKindTests)) break
    _dirty = true; getFactStore().revision++
    ctx.summary = summarize()
  }

  facts()
  // A call the sweeps below inline leaves no site for the boundary check after
  // narrowing; the sources' own call sites are checked here too.
  t('strictBoundaryTypeCheck', () => strictBoundaryTypeCheck(facts()))
  // Receiver-HASH global classification (.work/archive/todo.md §deletion-sweep):
  // fill `ctx.scope.globalValTypes` with VAL.HASH for module-level `{}`-decl
  // dict globals module/object.js's allocator already tags HASH at the
  // pointer level (identical predicate: target's merged schema empty +
  // dynWriteVars or literal-key write membership), a pure FILL (`.has()`-guarded, see
  // classifyHashDictGlobals doc), so it can run this early: before
  // flattenFuncNamespaces/devirtGlobalCalls, using the just-collected
  // programFacts.dynWriteVars directly (`ctx.types.dynWriteVars` isn't
  // published until this function's later `programFacts` fan-out below).
  t('classifyHashDictGlobals', () => classifyHashDictGlobals(ast, facts()))
  // Function-namespace SROA — dissolve reassigned `f.prop` slots into module
  // globals before inlining/narrowing, so all downstream passes see plain
  // globals instead of the dynamic property machinery.
  sweep('flattenFuncNamespaces', () => flattenFuncNamespaces(ast, facts().propMap))
  // A literal-key write outside a literal-bound name's layout becomes a
  // declared slot of that literal (flattened function properties included).
  sweep('declareWrittenKeys', () => declareWrittenKeys(ast))
  // A name that holds a method of `Object.prototype` is the method where it is called.
  sweep('resolveHeldMethods', () => resolveHeldMethods(ast))
  // A key stored on objects nothing asks for their keys becomes a declared
  // slot of their literals too, the literals their values join sharing one layout.
  ctx.summary = summarize()
  if (t('declareUnseenKeys', () => declareUnseenKeys(ast))) { _dirty = true; getFactStore().revision++; ctx.summary = summarize() }
  // Devirtualize calls through init-constant function globals (closure
  // devirtualization) — must follow the SROA above, which creates the globals.
  sweep('devirtGlobalCalls', () => devirtGlobalCalls(ast))
  // A method call on a receiver the summary names calls the class's function directly.
  sweep('devirtClassCalls', devirtClassCalls)
  // An array pattern over a proven array reads it by index, no cursor.
  sweep('indexArrayPatterns', indexArrayPatterns)
  sweep('bindNestedRowLengths', bindNestedRowLengths)
  sweep('unrollRowLenPadLoops', unrollRowLenPadLoops)
  // The call-inlining family (`inlineHotInternalCalls` self-gates on `sourceInline`)
  // is a pure speed optimization — the un-inlined calls emit correctly. Scalar
  // replacement (`scalarize*`) and array promotion gate on `optimizing()`: off only
  // under a fully-disabled optimizer, on for every enabled preset (incl. the
  // `optimize:{sourceInline:false}` heap-elision-test form, which is level-2 based).
  // Ahead of the splices: a function that reads `arguments` is one of a fixed count at each site.
  sweep('specializeFixedRestCalls', () => specializeFixedRestCalls(facts()))
  // A name that stands for another reads it: a parameter called through a local of
  // its own (`generator = arguments[ 0 ]`) is a parameter called, ahead of the splices.
  const aliases = optimizing() && ctx.transform.optimize.aliases === true
  if (aliases) sweep('resolveAliases', resolveAliases)
  // A local holding one of several functions and only called: a choice of direct calls.
  sweep('callChosenFunctions', () => callChosenFunctions(ast))
  sweep('inlineHotInternalCalls', () => inlineHotInternalCalls(facts(), ast))
  // A spliced call's statements are statements of its caller's lists, and its seams
  // are names for one value: the bindings split, then each alias reads what it stands for.
  // A parameter the spliced body writes is bound to the literal the site passed:
  // read where it still holds it, the body's tests of it are decided.
  if (optimizing() && ctx.transform.optimize.constants === true) sweep('propagateConstants', propagateConstants)
  if (aliases) { sweep('splitSplicedBindings', splitSplicedBindings); sweep('resolveAliases', resolveAliases) }
  sweep('bindNestedRowLengths', bindNestedRowLengths)
  sweep('unrollRowLenPadLoops', unrollRowLenPadLoops)
  sweep('inlineLocalLambdas', inlineLocalLambdas)
  sweep('specializeFixedRestCalls', () => specializeFixedRestCalls(facts()))
  if (optimizing()) {
    // After inlining, so a stride passed as a literal is one: the loops then
    // read over their trip number, the form every later pass takes.
    sweep('guardConstants', guardConstants)
    sweep('canonicalizeCountedLoops', canonicalizeCountedLoops)
    sweep('splitCharScan', splitCharScanLoops)
    // Record parameters read field by field become lanes before the object
    // scalarizer looks: a literal passed to such a callee has no reader left.
    sweep('laneRecordParams', () => laneRecordParams(facts()))
    // After inlining: a helper that fills an array of the module for its caller
    // is part of the caller, and the array's elements are values of the call.
    if (ctx.transform.optimize.moduleScratch === true) sweep('scalarizeModuleScratch', () => scalarizeModuleScratch(facts(), ast))
    sweep('scalarizeArrayLiterals', scalarizeFunctionArrayLiterals)
    sweep('scalarizeObjectLiterals', scalarizeFunctionObjectLiterals)
    // Promotion runs AFTER literal scalarization (those that fully reduce to scalars
    // are gone) and BEFORE typed-array scalarization (so a freshly-promoted array's
    // fixed-length-typed-of-known-size variant could still participate in loop
    // unrolling — currently it can't, since promotion produces the `[...]`-arg
    // form rather than `new Int32Array(N)`, but the ordering keeps the door open).
    sweep('promoteIntArrayLiterals', promoteIntArrayLiterals)
    sweep('scalarizeTypedArrays', () => scalarizeFunctionTypedArrays(facts()))
    // A loop indexing by numbers of unknown integrality: a copy over their int32s, where they are ones.
    sweep('versionIntegralLoops', versionIntegralLoops)
  }
  const programFacts = facts()
  // A module global's declaration-time literal length holds only while nothing
  // rewrites the binding (the element kind is an all-writers fact already).
  // Dropped here, before narrowing reads the lengths into parameter facts.
  for (const name of programFacts.typedRedefs) ctx.scope.globalTypedLen?.delete(name)
  ctx.types.dynKeyVars = programFacts.dynVars
  ctx.types.dynWriteVars = programFacts.dynWriteVars
  ctx.types.anyDynKey = programFacts.anyDyn
  ctx.types.literalWriteKeys = programFacts.literalWriteKeys
  ctx.types.writtenProps = programFacts.writtenProps
  ctx.types.arrResized = programFacts.arrResized
  ctx.types.nameEscapes = programFacts.nameEscapes
  ctx.types.literalObjectVars = programFacts.literalObjectVars
  // ProgramIndex identity and direct-graph slice. Build numeric identities and
  // member resolvers after every early AST mutation. Its builder exposes one
  // temporary resolver to computed-dispatch synthesis and lifted-value release,
  // then freezes numeric call edges, roots, and reachability. The published index
  // keeps only its variant-ID registrar open until the post-analysis specialization
  // boundary. Consumers use explicitly typed source or graph accessors;
  // no second member-target or call-graph table survives.
  const programIndex = t('buildProgramIndex', () => buildProgramIndex(ctx, programFacts, ast,
    resolver => {
      t('synthesizeComputedDispatchCallSites', () => synthesizeComputedDispatchCallSites(programFacts, resolver))
      t('synthesizeMemberDispatchCallSites', () => synthesizeMemberDispatchCallSites(programFacts, resolver))
      t('releaseLiftedAddressTakenNames', () => releaseLiftedAddressTakenNames(ctx, programFacts, resolver))
    }))
  programFacts.programIndex = programIndex
  ctx.plans.programIndex = programIndex
  // A binding no reached function reads computes nothing at init. The graph is
  // frozen: the values dropped hold no call. At every level, like the functions
  // nothing reaches: what a program may name does not depend on the optimizer.
  if (t('dropUnreadGlobals', () => dropUnreadGlobals(ast, programFacts))) getFactStore().revision++
  // Shape check (.work/archive/program-facts-split.md §7.1): this is the ONLY staple-on
  // site anywhere in src/compile/ that adds a top-level key to `programFacts`
  // after `collectProgramFacts` publishes it — the moment it lands is the
  // right place to assert no OTHER, undocumented key has snuck on too.
  // Placed after call-site synthesis and graph finalization so this same check
  // covers the complete ProgramIndex build, not only its identity census.
  // Always-on (core-simplification-audit.md §4(ii) slice 7 — measured <0.03 ms/compile,
  // see assertProgramFactsShape's own doc for the numbers).
  assertProgramFactsShape(programFacts, 'post-programIndex')
  t('resolveClosureWidth', () => resolveClosureWidth(programFacts))
  if (canSkipWholeProgramNarrowing(programFacts)) {
    // Freeze point (.work/archive/program-facts-split.md §7): narrowSignatures never runs
    // on this branch, so collectProgramFacts is paramReps/callSites' ONLY
    // producer here — already fully settled the moment we reach this check.
    // callSites is frozen for good (no writer anywhere ever touches it
    // again); paramReps gets the read-only `{get,raw}` view for the four
    // reads below and is restored through `.raw` to the real Map before
    // returning.
    freezeCallSites(programFacts.callSites)
    programFacts.paramReps = readonlyParamReps(programFacts.paramReps)
    // Phase J (jsstring boundary opt-in) is body-local and call-site-independent;
    // run it even when the rest of narrowing is skipped so simple `export let
    // f = (s) => s.length` still flips to externref. Likewise the result kinds,
    // so `export let f = (a) => a > 2` boxes its boundary atom.
    applyJsstringBoundaryCarrierStandalone(programFacts)
    ctx.summary = summarize()
    seedResultKinds()
    strictBoundaryTypeCheck(programFacts)
    adviseProgram(programFacts)
    solveRepresentationBoundaries(ctx, programFacts, ast)
    programFacts.paramReps = programFacts.paramReps.raw
    return programFacts
  }

  // Dead callers must not poison live signature facts: ProgramIndex owns the
  // reachability set; the call-site census compacts to it here, once.
  programFacts.programIndex.filterCallSitesToReachable(programFacts.callSites)
  // Export parameters used only as numeric array-likes take the typed pointer
  // ABI before the summary runs, so every callee fed from them sees a typed
  // argument (the wrapper normalizes the host value at entry).
  t('applyExportTypedArrayAbi', () => applyExportTypedArrayAbi(programFacts.paramReps, programFacts.callSites, programFacts.programIndex.addressTaken))
  // The program the sweeps rewrote (inlined calls, scalar-replaced literals),
  // with the export contract: narrowing reads the parameter kinds from it.
  t('collectSlotConstants', () => collectSlotConstants(ast))
  ctx.summary = summarize()
  // the numbers the rewritten program's names hold for good: a call through a name that holds a builtin is the builtin's now
  holdModuleNumbers()
  // and the regular expressions, which the emitter compiles where it knows the literal
  holdModuleRegexes(ast)
  // Normalizing an input can prove the values stored into an output buffer.
  // Close that dependency before narrowing. Each round fixes at least one
  // previously untyped boundary parameter; established contracts are skipped.
  while (t('applyExportTypedArrayAbi', () => applyExportTypedArrayAbi(programFacts.paramReps, programFacts.callSites, programFacts.programIndex.addressTaken)))
    ctx.summary = summarize()
  // A list of typed arrays reaching one function in several kinds: a copy per kind.
  while (t('splitByListKinds', () => splitByListKinds(programFacts))) ctx.summary = summarize()
  t('narrowSignatures', () => narrowSignatures(programFacts, ast))

    // After narrowSignatures (params now carry ptrKind): mark typed-array params that every call
    // site passes a distinct fresh buffer for → enables alias-aware LICM in the optimizer.
    if (optimizing()) t('analyzeParamDistinctness', () => analyzeParamDistinctness(programFacts))
    // Range and alias proofs need hazards resolved against settled parameters.
    t('refineSlotWriteHazards', () => collectSlotWriteHazards(ast, {
      paramReps: programFacts.paramReps, callSites: programFacts.callSites,
      addressTaken: programFacts.programIndex.addressTaken,
    }))
    // Cross-function neverGrown for read-only array PARAMS (growth-free callee
    // closure + arrayUsesSafe) — the raw-base element read skips __ptr_offset.
    if (optimizing()) t('analyzeParamNeverGrown', () => analyzeParamNeverGrown(programFacts.paramReps, programFacts.callSites, programFacts.programIndex.addressTaken))
    // Whole-program alias sweep for in-place replace-stores (`arr[i] = {lit}` →
    // overwrite the old element's slots) — needs the settled arrayElemSchema
    // facts, so it runs after the signature fixpoint.
    if (optimizing()) t('scanInplaceStores', () => scanInplaceStores(programFacts))
  t('specializeBimorphicTyped', () => specializeBimorphicTyped(programFacts))

  // VAL-kind landslide specialization (.work/archive/context-sensitivity-survey.md §3-4): a
    // pure precision/perf slice, sized/gated the same as speculateTypedParams.
    // `optimize: { valKindClones: false }` keeps a parameter's kind the join of every call site (test/summary.js reads it so)
    if (optimizing() && ctx.transform.optimize?.valKindClones !== false) t('specializeValKindDichotomy', () => specializeValKindDichotomy(programFacts))
    if (optimizing()) t('speculateTypedParams', () => speculateTypedParams(programFacts, ast))
    t('refineDynKeys', () => refineDynKeys(programFacts))
  // Freeze point (.work/archive/program-facts-split.md §7): paramReps/callSites' true last
  // producer WITHIN plan() is this round just above — specializeValKindDichotomy/
  // speculateTypedParams when optimizing() (both write through materializeVariant),
  // else round 2's unconditional specializeBimorphicTyped; refineDynKeys right
  // above is read-only and always runs last in this round either way. Rounds
  // 4-5 and solveRepresentationBoundaries below are exactly the consumers this
  // closes off. callSites has no writer anywhere past this point (grep-verified,
  // including compile/index.js's post-plan() emit phase) — frozen for good.
  // paramReps does: compile/index.js's specializeUnionCursorParams (EMIT-phase
  // union-cursor clones, called from OUTSIDE plan() entirely) legitimately
  // keeps minting new entries for the clones it creates, so the read-only view
  // is scoped to plan() and restored before return.
  freezeCallSites(programFacts.callSites)
  programFacts.paramReps = readonlyParamReps(programFacts.paramReps)
  // Rebuild slot ranges with the final parameter and element-alias facts.
  t('refineSlotIntCensus', () => analyzeSchemaSlotIntCertain(ast, {
    paramReps: programFacts.paramReps, callSites: programFacts.callSites,
    addressTaken: programFacts.programIndex.addressTaken,
  }))
  clearBodyFacts()
  strictBoundaryTypeCheck(programFacts)
  adviseProgram(programFacts)
  // RepresentationPlan v2 Slice 1: semantic call/kind facts and every
  // specialization are settled. Publish boundary targets before any body
  // FunctionPlan is analyzed or emitted; this slice is observation-only.
  solveRepresentationBoundaries(ctx, programFacts, ast)
  // Restore the real, writable Map before returning (see the freeze-point
  // comment above): compile/index.js's own post-plan() emit phase
  // (specializeUnionCursorParams) mutates programFacts.paramReps directly and
  // must see the identical object it always has, unwrapped.
  programFacts.paramReps = programFacts.paramReps.raw
  return programFacts
}
