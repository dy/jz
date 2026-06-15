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
 *        - refineDynKeys — tighten dynamic property-key sets
 *
 * No bytes are emitted here; emit.js consumes the planned ctx + programFacts.
 *
 * @module plan
 */

import { ctx } from '../../ctx.js'
import { collectProgramFacts, refreshProgramFacts } from '../program-facts.js'
import narrowSignatures, {
  specializeBimorphicTyped, refineDynKeys,
  applyJsstringBoundaryCarrierStandalone, narrowBoolResults,
  strictBoundaryTypeCheck,
} from '../narrow.js'

import { optimizing } from './common.js'
import { adviseProgram } from './advise.js'
import {
  inferModuleLetTypes, unboxConstTypedGlobals, inferModuleIntGlobals,
  flattenFuncNamespaces, devirtGlobalCalls,
  materializeAutoBoxSchemas, resolveClosureWidth, canSkipWholeProgramNarrowing,
} from './scope.js'
import { inlineHotInternalCalls, inlineLocalLambdas, specializeFixedRestCalls } from './inline.js'
import { bindNestedRowLengths, unrollRowLenPadLoops, splitCharScanLoops } from './loops.js'
import {
  scalarizeFunctionTypedArrays, scalarizeFunctionArrayLiterals,
  promoteIntArrayLiterals, scalarizeFunctionObjectLiterals,
} from './literals.js'

export default function plan(ast, profiler) {
  // Per-pass timing under `plan:` — the plan stage is the compile pipeline's
  // multi-pass hot spot (each mutating pass triggers a whole-program fact
  // refresh), so the profile must show WHICH pass and refresh dominate.
  const t = profiler?.time ? (name, fn) => profiler.time(`plan:${name}`, fn) : (_, fn) => fn()
  // AST-mutating pass: run timed; on change, re-sweep program facts (timed
  // separately — the refreshes are usually the cost, not the passes).
  let programFacts
  const sweep = (name, pass) => {
    if (t(name, pass)) programFacts = t('refreshFacts', () => refreshProgramFacts(ast, programFacts))
  }

  t('inferModuleLetTypes', () => inferModuleLetTypes(ast))
  t('unboxConstTypedGlobals', unboxConstTypedGlobals)
  t('inferModuleIntGlobals', () => inferModuleIntGlobals(ast))

  programFacts = t('collectFacts', () => collectProgramFacts(ast))
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
  sweep('inlineHotInternalCalls', () => inlineHotInternalCalls(programFacts, ast))
  sweep('bindNestedRowLengths', bindNestedRowLengths)
  sweep('unrollRowLenPadLoops', unrollRowLenPadLoops)
  sweep('inlineLocalLambdas', inlineLocalLambdas)
  sweep('specializeFixedRestCalls', () => specializeFixedRestCalls(programFacts))
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
    sweep('scalarizeTypedArrays', () => scalarizeFunctionTypedArrays(programFacts))
  }
  ctx.types.dynKeyVars = programFacts.dynVars
  ctx.types.dynWriteVars = programFacts.dynWriteVars
  ctx.types.anyDynKey = programFacts.anyDyn

  t('materializeAutoBoxSchemas', () => materializeAutoBoxSchemas(programFacts))
  t('resolveClosureWidth', () => resolveClosureWidth(programFacts))
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

  t('narrowSignatures', () => narrowSignatures(programFacts, ast))
  t('specializeBimorphicTyped', () => specializeBimorphicTyped(programFacts))
  t('refineDynKeys', () => refineDynKeys(programFacts))
  strictBoundaryTypeCheck(programFacts)

  adviseProgram(programFacts)
  return programFacts
}
