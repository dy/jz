import { OPTF } from '../ctx.js'
import { dataLen, dataString, strPoolLen, strPoolString } from '../static-data.js'
/**
 * Compile prepared AST to WASM module (S-expression arrays for watr).
 *
 * # Stage contract
 *   IN:  prepared AST (from prepare) + `ctx.funcs.list` with raw bodies.
 *   OUT: WAT IR `['module', ...sections]` ready for watrCompile/watrPrint.
 *   FLOW: orchestrator only. Calls analyze passes per function, then emit(body) via
 *         src/emit.js's dispatch, then optimizeFunc (src/optimize.js) per function,
 *         finally assembles module sections in canonical order.
 *
 * # Core abstraction
 * Emitter table (ctx.core.emit) maps AST ops → WASM IR generators. Base operators defined
 * in `emitter` export (src/emit.js); on reset, ctx.core.emit starts as a flat copy of emitter
 * and modules add/override entries directly. No prototype chain.
 * emit(node) dispatches: numbers → i32/f64.const, strings → local.get, arrays → ctx.core.emit[op].
 *
 * # Type system
 * Every emitted node carries .type ('i32' | 'f64').
 * Operators preserve i32 when both operands are i32.
 * Division/power always produce f64. Bitwise/comparisons always produce i32.
 * Variables are typed by pre-analysis: if any assignment is f64, local is f64.
 *
 * Per-function state on ctx: locals (Map name→type), stack (loop labels), uniq (counter), sig.
 *
 * @module compile
 */

import parseWat from 'watr/parse'
import { ctx, err, inc, resolveIncludes, PTR, LAYOUT, HEAP, declGlobal, assertCtxInvariants } from '../ctx.js'
import { enterActiveFunction, restoreActiveFunction } from './active-function.js'
import { enterPreparedFunction, functionPlanOf, installFunctionPlan, publishFunctionPlan, publishPreparedFunctionPlan, retireFunctionPlan } from './function-plan.js'
import { makeMapOverlay, mapOrOverlaySize } from './map-overlay.js'
import { i64Hex } from '../../layout.js'
import { T, isBlockBody, isReassigned, returnExprs, MUTATE_OPS, beginAssignedMemo, endAssignedMemo, walkAst } from '../ast.js'
import { valTypeOf, hasAmbiguousBoolMerge, censusBigintResultShape } from '../kind.js'
import { intLiteralValue } from '../static.js'
import { intCertainMap, typedStaticLen } from '../type.js'
import {
  analyzeBody, unboxablePtrs, inheritPtrAliases, cseSafeLoadBases, boxedCaptures,
  structInlinePass, unionInlinePass, reanalyzeBody, invalidateAllBodyFacts,
} from './analyze.js'
import { typedElemAux } from '../../layout.js'
import { invalidateBindingUsesCache, resetBindingUsesCache } from './analyze-scans.js'
import { VAL, updateRep } from '../reps.js'
import { inferLocals } from './infer.js'
import { optimizeFunc } from '../optimize/index.js'
import { strengthReduceLoopDivMod } from './loop-divmod.js'
import { mintLoopPlans } from './loop-model.js'
import { mintClosureEnvPlans } from './closure-plan.js'
import { mintRepresentationPlan, representationHostBoxesParam, representationProgramHasBigint, representationReturnAction } from './representation-plan.js'
import { mintTypedStoragePlan } from './typed-storage-plan.js'
import { unboxAdmittedCursors } from './analyze/ptr-eligibility.js'
import { narrowBoundedSquare } from './loop-square.js'
import { specializeUnionCursorParams } from './narrow.js'
import { cloneRep, paramValTrustworthy } from '../param-reps.js'
import { unrollRecurrence, unrollScalarChains, selectArmUpdatesIn } from './loop-recurrence.js'
import { peelClampedStencil } from './peel-stencil.js'
import { cseLoads } from './cse-load.js'
import {
  scanDynClosureTableCandidates, recordParamClosureDefault, recordDirectReturnClosure, resolveDynFnTables,
  scanClosureTableLatticeCandidates, scanImperativeClosureTableLatticeCandidates,
} from './dyn-closure-tables.js'


import { emit, emitter, emitVoid, emitBlockBody, emitIdentitySafe, resolveClosureTableParamLattice, toBool } from './emit.js'
import { emitCharDecompPrologue, JSS_IMPORT_SIGS } from '../abi/string.js'
import {
  typed, asF64, asI32, asPtrOffset, asParamType, toI32, asI64, fromI64, ptrTypeEq,
  NULL_NAN, UNDEF_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, nullExpr, undefExpr,
  MAX_CLOSURE_ARITY,
  isLit, litVal, isNullishLit, emitNum,
  temp,
  isConst, boxedAddr, readVar, writeVar, isNullish, isUndef,
  slotAddr, elemLoad, elemStore, arrayLoop, allocPtr,
  multiCount, loopTop, flat, reconstructArgsWithSpreads,
  findBodyStart, tcoTailRewrite,
  I32_MIN, I32_MAX,
  carrierF64,
  applyBigintRepresentationAction,
  freshId,
} from '../ir.js'
import plan from './plan/index.js'
import { foldStaticConstAggregates } from './plan/literals.js'
import {
  buildStartFn, dedupClosureBodies, finalizeClosureTable,
  pullStdlib, syncImports, optimizeModule, stripStaticDataPrefix, hoistConstGlobalInits, stripDeadLazyTables, stripDeadInternedSpans,
} from '../wat/assemble.js'
import { link } from '../link/index.js'
import { summarize } from '../summary/index.js'
import { synthesizeClassDispatchers } from './emit/class-dispatch.js'
import { instrumentHelperCallsites } from '../helper-counters.js'
import { isExported, exportNamesOf } from './func-exports.js'
import { enterFunc, emitPreboxedLocalInits } from './func-entry.js'
import { paramAllUsesNumeric, paramNeverString } from './param-numeric.js'
import { ensureThrowRuntime } from './throw-runtime.js'
import { buildInternTable } from './intern-table.js'
import { captureFuncInspect } from './func-inspect.js'
import { isBoundaryWrapped, synthesizeBoundaryWrappers } from './boundary-wrap.js'
import { hoistInvariantParamCoercions, hoistUnionCursorUnbox } from './coercion-hoist.js'
import { analyzeFuncForEmit } from './analyze-for-emit.js'
import { emitFunc } from './emit-func.js'
import { analyzeClosureBodyForEmit, emitClosureBody } from './closure-emit.js'

const timePhase = (profiler, name, fn) => profiler?.time ? profiler.time(name, fn) : fn()

// Per-compile func name set + map live on ctx.funcs.names / ctx.funcs.map,
// populated at compile() entry. Both reset by ctx.js reset() and re-filled here.

// Low-level IR helpers previously lived here. Pure ones moved to src/ir.js;
// emit-calling ones (toBool, emitTypeofCmp, emitDecl, materializeMulti,
// buildArrayWithSpreads) moved to src/emit.js.

// AST-analysis primitives live in kind.js, type.js, static.js, program-facts.js.




// === Module compilation ===








// MapOverlay implementation lives in map-overlay.js so FunctionPlan can
// fork detached typed views without importing this compile driver.


/** Compile a prepared AST into the assembled WAT IR consumed by watr. */
export default function compile(ast, profiler) {
  // Contract: callers (jzCompileInner / scripts/self.js compileSelf) must set
  // ctx.transform.optimize before reaching here — every optimize-gated pass below
  // reads `cfg && cfg.x === false`, so a null cfg silently runs every pass.
  // Populate known function names + lookup map on ctx.func for direct call detection
  ctx.module.entryInit = ast   // the entry module's own statements, beside `moduleInits`
  synthesizeClassDispatchers()   // the class dispatchers, functions like any other from here on
  ctx.funcs.names.clear()
  ctx.funcs.map.clear()
  for (const f of ctx.funcs.list) { ctx.funcs.names.add(f.name); ctx.funcs.map.set(f.name, f) }
  ctx.summary = timePhase(profiler, 'summary', () => summarize(ast, {
    funcs: ctx.funcs.list, schemas: ctx.schema.list, brandOf: ctx.schema.brandOf, classes: ctx.transform.classes, exported: isExported,
    imports: new Set(ctx.module.imports.filter(imp => imp[3]?.[0] === 'func').map(imp => imp[3][1].replace(/^\$/, ''))),
  }))
  // Include imported functions for call resolution (e.g. template interpolations).
  // Also register a synthesized sig in func.map so emit's arity-aware branches see
  // the import's declared param count — needed for arg pad/truncate to match it.
  for (const imp of ctx.module.imports) {
    if (imp[3]?.[0] !== 'func') continue
    const fname = imp[3][1].replace(/^\$/, '')
    ctx.funcs.names.add(fname)
    if (!ctx.funcs.map.has(fname)) {
      const params = []
      let result = 'f64'
      for (let k = 2; k < imp[3].length; k++) {
        const part = imp[3][k]
        if (Array.isArray(part) && part[0] === 'param') params.push({ type: part[1] || 'f64' })
        else if (Array.isArray(part) && part[0] === 'result') result = part[1] || 'f64'
      }
      ctx.funcs.map.set(fname, { name: fname, sig: { params, results: [result] } })
    }
  }

  // Check user globals don't conflict with runtime globals (modules loaded after user decls)
  for (const name of ctx.scope.userGlobals)
    if (!(ctx.scope.globals.get(name)?.mut && ctx.scope.globals.get(name)?.type === 'f64'))
      err(`'${name}' conflicts with a compiler internal — choose a different name`)

  // Pre-fold const globals: evaluate constant initializers before function compilation
  // so functions see the correct global types (i32 vs f64). Covers the main module
  // and every bundled sub-module — a sub-module's top-level `const SPACE = 32` lands
  // in `moduleInits` (emitted from __start), not `ast`, so without this it stays a
  // `(mut f64)` global. Folding it makes the scanner's char-code constants immutable
  // globals V8 constant-folds at each read site.
  if (ast) {
    const evalConst = n => {
      if (typeof n === 'number') return n
      // A reference to an already-folded integer const (`const NEW = CALL + 1`):
      // resolve it from constInts so const-referencing-const initializers fold too.
      // Without this they stay unfolded → decl defaults to 0 AND emitDecl skips the
      // (const) runtime init → the binding reads 0 (e.g. subscript's NEW=CALL+1 → the
      // `new` keyword registers with precedence 0 and never dispatches).
      if (typeof n === 'string') return ctx.scope.constInts?.get(n) ?? null
      if (Array.isArray(n) && n[0] == null && typeof n[1] === 'number') return n[1]
      if (!Array.isArray(n)) return null
      const [op, a, b] = n
      const va = evalConst(a), vb = b !== undefined ? evalConst(b) : null
      if (va == null) return null
      if (op === 'u-' || (op === '-' && b === undefined)) return -va
      if (vb == null) return null
      if (op === '+') return va + vb; if (op === '-') return va - vb
      if (op === '*') return va * vb; if (op === '%' && vb) return va % vb
      if (op === '/' && vb) return va / vb; if (op === '**') return va ** vb
      if (op === '&') return va & vb; if (op === '|') return va | vb
      if (op === '^') return va ^ vb; if (op === '<<') return va << vb
      if (op === '>>') return va >> vb; if (op === '>>>') return va >>> vb
      return null
    }
    const topStmts = n => Array.isArray(n) && n[0] === ';' ? n.slice(1)
      : Array.isArray(n) && n[0] === 'const' ? [n] : []
    const stmts = [...topStmts(ast)]
    for (const mi of ctx.module.moduleInits || []) stmts.push(...topStmts(mi))
    // Fixpoint: a const may reference one declared later or in another module
    // (`NEW = CALL + 1`). Each pass folds every now-resolvable initializer (its refs
    // already in constInts); repeat until none change so order/cross-module refs resolve.
    const foldedDecls = new Set()
    let changed = true
    while (changed) {
      changed = false
      for (const s of stmts) {
        if (!Array.isArray(s) || s[0] !== 'const') continue
        for (const decl of s.slice(1)) {
          if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
          const [, name, init] = decl
          if (foldedDecls.has(name)) continue
          if (!ctx.scope.globals.has(name) || !ctx.scope.consts?.has(name)) continue
          const v = evalConst(init)
          if (v == null || !isFinite(v)) continue
          foldedDecls.add(name)
          changed = true
          const isInt = Number.isInteger(v) && v >= I32_MIN && v <= I32_MAX
          declGlobal(name, isInt ? 'i32' : 'f64', v, { mut: false })
          // Cache integer values for cross-call const-arg propagation: `f(N)` where
          // `const N = 8` should observe the param as intConst=8.
          if (isInt) (ctx.scope.constInts ||= new Map()).set(name, v)
          // Cache EVERY folded value (fractional too) so readVar substitutes the
          // literal at each read site — compile-time paths (emitPow's constant
          // non-integer exponent → exp(c·log x), narrowing, the vectorizer) see
          // through the global where V8 would only fold it at runtime. colorpq's
          // PQ exponents (nv = 2610/16384, p = 1.7·2523/32) rode global.get into
          // the generic runtime-exponent $math.pow because of exactly this gap.
          ;(ctx.scope.constNums ||= new Map()).set(name, v)
        }
      }
    }
  }

  // Typed-ctor sizes parked at prepare (`new T(CIN*H*W)` — names only now folded):
  // re-run the static-len derivation with constInts populated. Feeds the interval
  // proof's receiver lengths (typedIdxProven class 5).
  if (ctx.scope.pendingTypedLens) {
    for (const [name, rhs] of ctx.scope.pendingTypedLens) {
      const len = typedStaticLen(rhs)
      if (len != null && ctx.scope.globalTypedElem?.has(name))
        (ctx.scope.globalTypedLen ||= new Map()).set(name, len)
    }
    ctx.scope.pendingTypedLens = null
  }

  // Whole-program constant fold of module-scope aggregate literals — `var x=[1,2,3];
  // y=x[0]` → `y=1`, dropping the array (no data segment, no __arr_idx_known) when
  // every reference is a static read. The scalar analog of the constInts fold above.
  timePhase(profiler, 'foldAggregates', () => foldStaticConstAggregates(ast))

  const programFacts = timePhase(profiler, 'plan', () => plan(ast, profiler))

  // A module global's declaration-time literal length holds only while nothing
  // rewrites the binding (the element kind is an all-writers fact already).
  for (const name of programFacts.typedRedefs) ctx.scope.globalTypedLen?.delete(name)

  // Closure-table planning is post-plan so every scan sees the final AST.
  // Same-body indirect devirt (dyn-closure-tables.js): which module globals are
  // structurally safe candidate closure tables (never alias/escape) — the
  // write-family + call-site facts gathered during emission below only fire
  // for names in this set. Post-plan so the scan sees the AST shapes that will
  // actually emit.
  if ((ctx.transform.optFlags & OPTF.devirtClosureTables)) ctx.scope.dynFnTableCandidates = scanDynClosureTableCandidates(ast)

  // Closure-TABLE call-site PARAM lattice (dispatch-through-array-of-closures
  // class — dyn-closure-tables.js's scanClosureTableLatticeCandidates docs the
  // exact safety notion, stricter than the devirt scan above): which const
  // arrays of closures are provably invoked ONLY via `name[idx](args)`. Always
  // on (fail-open by construction — no gate needed, mirrors the ungated direct-
  // closure paramTypes lattice in emit.js/tryDirectClosureCall). emit.js
  // consults this set at every `name[idx](args)` call site to decide whether
  // to accumulate arg-kind evidence for the table's elements. NOTE: "always
  // on" describes the FACT computation; whether emit consumes the proof is
  // tier-dependent (O0 keeps the generic call path — values identical, no
  // proof-shaped codegen; the structural pins in test/closures.js are
  // belowOpt(2)-guarded accordingly).
  ctx.scope.closureTableLatticeCandidates = scanClosureTableLatticeCandidates(ast)

  // Same lattice, IMPERATIVE-construction class (dispatch tables built via
  // scattered `name[key] = arrowLiteral` writes rather than one array
  // literal — jessie's subscript `lookup` shape; the named follow-on to the
  // const-literal scan above). Also always on, fail-open by construction —
  // see dyn-closure-tables.js's own doc for the safety notion and the
  // module-init-order reasoning behind its "early-mergeable" subset.
  ctx.scope.imperativeClosureTableLatticeCandidates = scanImperativeClosureTableLatticeCandidates(ast)

  // Inspect sink: editor hosts opt in via { inspect: true } to read inferred shapes.
  // Initialized here (post-plan) so paramReps and schema.list are stable, populated
  // per-function below as FunctionPlans settle. Bytes themselves are unchanged.
  if (ctx.transform.inspect) ctx.inspect = { functions: {}, schemas: ctx.schema.list.map(s => s.slice()) }

  const publishPlan = (func, facts) => publishFunctionPlan(ctx, func, facts)
  // Whole-program SRoA passes as compact summaries: each pass collects its
  // per-function facts inside the analyze loop, while that function's plan
  // and body are hot, and decides at its original phase position from the
  // collected summaries alone. `optimize: { structInline/unionInline: false }`
  // disable a representation wholesale — the REFERENCE MODES for three-way
  // differentials (off / on / plain JS); with an empty registry every
  // consumer takes the plain path.
  const structInline = ctx.transform.optimize?.structInline !== false ? structInlinePass(programFacts) : null
  const unionInline = ctx.transform.optimize?.unionInline !== false ? unionInlinePass(programFacts) : null
  // Reachability precedes body analysis (M4): a function the frozen graph
  // does not reach is neither analyzed nor emitted. Unsupported syntax in
  // such a body still rejects, at prepare, before any of this runs.
  const { reachableForLowering } = programFacts.programIndex
  timePhase(profiler, 'analyzeFuncs', () => {
    for (const func of ctx.funcs.list) {
      if (func.raw || !reachableForLowering(func)) continue
      const facts = analyzeFuncForEmit(func, programFacts)
      publishPlan(func, facts)
      captureFuncInspect(func, facts, programFacts)
      if (structInline) structInline.collect(func)
      if (unionInline) unionInline.collect(func)
    }
  })
  // Runs once the per-function reps have settled (they are codegen truth) and
  // before any function is emitted.
  if (structInline)
    timePhase(profiler, 'structInline', () => structInline.finish())
  if (ctx.transform.optimize?.unionInline !== false) {
    if (unionInline) timePhase(profiler, 'unionInline', () => unionInline.finish())
    // Carrier-specialized clones (after the registry settles): verified
    // cursor-param functions get a raw-i32 `$union` sibling; sanctioned
    // callsites rewrite to it — no NaN-box crosses the call.
    // The clone's facts must derive under ITS sig (the pointer-ABI param
    // registration + reps seeding live in analyzeFuncForEmit) — re-run it
    // per clone rather than sharing the original's f64-sig facts.
    timePhase(profiler, 'unionClones', () => {
      for (const clone of specializeUnionCursorParams(programFacts)) {
        if (!reachableForLowering(clone)) continue
        const facts = analyzeFuncForEmit(clone, programFacts)
        publishPlan(clone, facts)
        captureFuncInspect(clone, facts, programFacts)
      }
      // Only an admitted local cursor unboxes to a cell address; an
      // unadmitted one keeps its box, where the member schema lives
      // (ptr-eligibility.js). The verdict lands after analysis, so the
      // admitted cursors' storage is settled here on the published plan.
      if (ctx.schema.inlineUnionCursors?.size) for (const func of ctx.funcs.list) {
        const cursors = !func.raw && reachableForLowering(func) ? ctx.schema.inlineUnionCursors.get(func.sig) : null
        if (!cursors) continue
        unboxAdmittedCursors(ctx, functionPlanOf(ctx, func), func, cursors)
      }
    })
  }
  // Every specialization producer has now run, including union-cursor clones.
  // Close the disjoint variant ID space before emission and prove each variant's
  // signature, parameter facts, and FunctionPlan were derived rather than shared.
  timePhase(profiler, 'finalizeVariantIdentities', () =>
    programFacts.programIndex.finalizeVariantIdentities(
      programFacts.paramReps, func => ctx.plans.functions.get(func)))
  // Concrete Wasm function IDs: one assignment of the final emission order,
  // freezing the registry list so no later writer reorders or grows it.
  // Emission and assembly ordering below read this order, not the registry.
  timePhase(profiler, 'finalizeConcreteFunctionIds', () =>
    programFacts.programIndex.finalizeConcreteFunctionIds())
  // Parameter-ABI ownership transfer: the lattice's settled rows move to
  // concrete-ID slots and the name-keyed key dies here, so no later reader
  // can consult the analysis index.
  timePhase(profiler, 'publishParameterAbi', () => {
    programFacts.programIndex.publishParameterAbi(programFacts.paramReps)
    const retiredParamRepsKey = 'paramReps'
    delete programFacts[retiredParamRepsKey]
  })
  // FeaturePlan freeze (.work/evidence.md §FeaturePlan freeze): every per-function
  // analyze pass has now run (analyzeFuncs + structInline/unionInline/unionClones
  // above) — this is the freeze point after which NO ctx.features key may change
  // (uniform, no exceptions; typedView — the one key that used to keep flipping
  // past this point — was reclassified onto ctx.linkDemand). Extends the
  // post-prepare SESSION+PROGRAM snapshot with ANALYSIS (currently empty);
  // compared at 'pre-assemble' below.
  assertCtxInvariants('post-analyze')
  // FunctionPlans now own every named-function fact needed by emission. Drop
  // the duplicate bodyFacts cache; any genuinely late consumer recomputes.
  invalidateAllBodyFacts()
  resetBindingUsesCache()
  // isReassigned memo window: emission is a pure projection of the frozen
  // post-analyze AST, so per-subtree assigned-name sets stay valid for the
  // whole stage (see the memo doc in ast.js).
  const funcs = timePhase(profiler, 'emitFuncs', () => {
    const out = []
    beginAssignedMemo()
    try {
      for (const func of programFacts.programIndex.concreteFunctionOrder()) {
        if (func.raw) out.push(emitFunc(func, null, programFacts))
        else if (!reachableForLowering(func)) continue
        else {
          const functionPlan = functionPlanOf(ctx, func)
          out.push(emitFunc(func, functionPlan, programFacts))
          retireFunctionPlan(ctx, func, functionPlan)
          invalidateBindingUsesCache(func.body)
        }
      }
    } finally { endAssignedMemo() }
    return out
  })
  funcs.push(...synthesizeBoundaryWrappers())

  const closureFuncs = []
  let compiledBodyCount = 0
  const compilePendingClosures = () => timePhase(profiler, 'emitClosures', () => {
    // Emitting a body may discover nested closures. Process stable batches:
    // every body known at batch entry is fully planned before any body in that
    // batch emits; newly discovered bodies become the next batch.
    // analyzeClosureBodyForEmit runs outside the isReassigned memo window;
    // only the pure emit half is bracketed.
    while (compiledBodyCount < (ctx.closure.bodies?.length || 0)) {
      const batchEnd = ctx.closure.bodies.length
      for (let i = compiledBodyCount; i < batchEnd; i++) analyzeClosureBodyForEmit(ctx.closure.bodies[i])
      beginAssignedMemo()
      try {
        for (let i = compiledBodyCount; i < batchEnd; i++) {
          const cb = ctx.closure.bodies[i]
          const functionPlan = functionPlanOf(ctx, cb)
          closureFuncs.push(emitClosureBody(cb, functionPlan))
          retireFunctionPlan(ctx, cb, functionPlan)
          invalidateBindingUsesCache(cb.body)
        }
      } finally { endAssignedMemo() }
      compiledBodyCount = batchEnd
    }
  })

  // Imperative closure-TABLE PARAM lattice — early merge (dyn-closure-
  // tables.js scanImperativeClosureTableLatticeCandidates). Every named
  // function has now emitted (the map() just above), so every write
  // (register()-style `lookup[c] = fn`) and every read (`lookup[cc](...)`)
  // this candidate class permits has already recorded its evidence — but
  // NONE of the closure bodies those writes created have COMPILED yet
  // (compilePendingClosures' first flush is the very next line). This is the
  // one window where merging is both sound (every occurrence the safety scan
  // allows is confined to functions that already emitted) and useful (still
  // before the bodies it targets compile). Module-scope-touching candidates
  // are excluded from imperativeClosureTableEarlyMergeable up front — see
  // that scan's own doc.
  if (ctx.scope.imperativeClosureTableEarlyMergeable?.size)
    for (const name of ctx.scope.imperativeClosureTableEarlyMergeable) {
      const members = ctx.scope.imperativeClosureTableMembers?.get(name)
      if (members?.length) resolveClosureTableParamLattice(name, members)
    }

  compilePendingClosures()

  // `wasm:js-string` imports — drained from `ctx.core.jsstring`, one
  // `(import …)` per builtin referenced by emitted code. Engines with
  // js-string-builtins support intercept the namespace; engines without
  // fall back to JS-side polyfills wired in interop.js. The import nodes
  // precede user imports so the host providing them sees them first.
  const jssImports = []
  if (ctx.core.jsstring?.size) {
    for (const name of ctx.core.jsstring) {
      const sig = JSS_IMPORT_SIGS[name]
      if (!sig) continue  // unknown builtin — silently skip (defensive)
      const funcNode = ['func', `$__jss_${name}`,
        ...sig.params.map(t => ['param', t]),
        ['result', sig.result],
      ]
      jssImports.push(['import', '"wasm:js-string"', `"${name}"`, funcNode])
    }
  }

  // Build module sections — named slots, assembled at the end (no index bookkeeping)
  const sec = {
    extStdlib: [],  // external stdlib (imports that must precede all other imports)
    imports: [...jssImports, ...ctx.module.imports],
    types: [],      // function types for call_indirect
    memory: [],     // memory declaration
    data: [],       // data segment (filled after emit)
    tags: [],       // error tags + related exports
    table: [],      // function table (at most one)
    globals: [],    // globals (filled after __start)
    funcs: [],      // closure funcs + regular funcs
    elem: [],       // element section (table init)
    start: [],      // __start func + start directive
    stdlib: [],     // stdlib functions
    customs: [],    // custom sections + exports
  }
  // Uniform closure convention: (env f64, argc i32, a0..a{MAX-1} f64) → f64.
  // argc = actual arg count passed; missing slots padded with UNDEF_NAN at caller.
  // Rest-param bodies pack slots a[fixedParams..argc-1] into their rest array.
  // MAX_CLOSURE_ARITY is the fixed inline-slot count; calls with more args error.
  // Bare truthy, not `.size`: `ctx.closure.types` existing means `fn` loaded
  // for SOME real reason — not only literal closure minting, but any use of
  // ctx.closure.call (generic dynamic dispatch that COULD invoke a
  // closure-shaped value at runtime, even one this specific program never
  // literally constructs) also needs `$ftN` for its call_indirect. A `.size`
  // gate here (this session's first attempt) undercounted that second case —
  // regressed 71 native tests with "'ftN' is not in scope" (any compile whose
  // ONLY closure-shaped code is a generic-dispatch call_indirect, never a
  // literal `=>` reaching ctx.closure.mint). The REAL fix for eager-load's
  // "fn loaded but never actually needed" divergence lives downstream, in
  // finalizeClosureTable (src/wat/assemble.js): its own `indirectUsed` scan
  // is the authoritative, later check (real call_indirect usage in the
  // ACTUALLY-COMPILED, reachability-resolved output) — its `else` branch
  // already strips this exact `$ftN` type back out (`sec.types = sec.types.
  // filter(...)`) whenever indirectUsed is false, regardless of whether it
  // was pushed here. That authoritative scan is what needed fixing (see its
  // own doc — it used to scan EVERY ever-registered stdlib template instead
  // of only reachable ones); this push staying unconditional-on-module-load
  // was never the bug.
  if (ctx.closure.types) {
    const params = [['param', 'f64'], ['param', 'i32']] // env + argc
    for (let i = 0; i < (ctx.closure.width ?? MAX_CLOSURE_ARITY); i++) params.push(['param', 'f64'])
    sec.types.push(['type', `$ftN`, ['func', ...params, ['result', 'f64']]])
  }

  // Memory section deferred — emitted after resolveIncludes() when __alloc is needed

  if (ctx.closure.table?.length)
    sec.table.push(['table', ...(ctx.transform.alloc === false ? [] : [['export', '"__jz_table"']]),
      ctx.closure.table.length, 'funcref'])

  sec.funcs.push(...closureFuncs, ...funcs)

  // WASI command-mode entry legalization (`run`/`_start` re-exported as () -> ()) and
  // the WASI reactor `_initialize` conversion used to live here and further down in this
  // function, mutating `sec.funcs`/`sec.start` in place. Both are now target legalization
  // (src/optimize/watr-tail.js legalizeForTarget), ported onto the fully assembled
  // `['module', …]` tree — see that function's doc comment for why (and for the byte-
  // identity evidence that the relocation is safe). Nothing here builds `wasiCommandExports`
  // any more, so the "Named export aliases" loop below always emits the natural alias
  // export entry for an aliased `run`/`_start` — legalizeForTarget rewrites it from there.

  if (ctx.closure.table?.length)
    sec.elem.push(['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)])

  timePhase(profiler, 'buildStart', () => buildStartFn(ast, sec, closureFuncs, compilePendingClosures))

  // dyn-closure-tables.js: every function AND module init has now emitted, so
  // callSites/paramClosureDefaults/directReturnClosures are complete — resolve
  // each candidate table's write family and (if monomorphic) hand it to
  // devirtConstFnArrayCalls via ctx.scope.constFnArrays, same as a const array.
  if ((ctx.transform.optFlags & OPTF.devirtClosureTables)) timePhase(profiler, 'resolveDynFnTables', () => resolveDynFnTables(programFacts))

  // Host globals (globalThis/process/WebAssembly/…) referenced as values are
  // recorded in ctx.core.hostGlobals during emit; register them as env imports
  // now (assembly owns ctx.module.imports). Drained after buildStartFn so a
  // host global first used in a top-level statement (emitted into __start) is
  // captured; syncImports below merges them into sec.imports.
  for (const name of ctx.core.hostGlobals) {
    ctx.module.imports.push(['import', '"env"', `"${name}"`, ['global', `$${name}`, 'i64']])
    // Host references cross the JS↔wasm boundary as raw i64 NaN-box carriers.
    // Register that REPRESENTATION type alongside the import: optimizeModule's
    // promoteGlobals consumes globalTypes, and treating this slot as the
    // source-level f64 value would emit `(local f64) (local.set … global.get i64)`.
    ctx.scope.globalTypes.set(name, 'i64')
  }

  syncImports(sec)

  dedupClosureBodies(closureFuncs, sec)

  finalizeClosureTable(sec)

  buildInternTable()

  // FeaturePlan freeze (.work/evidence.md §FeaturePlan freeze): emission is done —
  // asserts ctx.features' SESSION+PROGRAM+ANALYSIS strata are present and unchanged
  // since their post-prepare/post-analyze snapshots, right before pullStdlib's
  // resolveIncludes() starts reading the DEMAND stratum (module template factories
  // + deps lambdas).
  assertCtxInvariants('pre-assemble')

  // Snapshot export metadata before stdlib realization mutates module sections.
  const lateRest = []
  const lateExt = []
  const lateI64 = []
  const lateHostAbi = []
  const lateNamedExports = []
  for (const f of programFacts.programIndex.concreteFunctionOrder()) {
    if (isExported(f) && f.rest) {
      const fixed = f.sig.params.length - 1
      for (const exportName of exportNamesOf(f.name)) lateRest.push({ name: exportName, fixed })
    }
    if (isExported(f) && isBoundaryWrapped(f) && f._exportExtParams) {
      const p = []
      const d = {}
      f._exportExtParams.forEach((b, i) => {
        if (!b) return
        p.push(i)
        if (typeof b === 'object' && b.def != null) d[String(i)] = b.def
      })
      if (p.length) {
        const hasDefaults = Object.keys(d).length > 0
        for (const exportName of exportNamesOf(f.name))
          lateExt.push(hasDefaults ? { name: exportName, p, d } : { name: exportName, p })
      }
    }
    if (isExported(f) && isBoundaryWrapped(f) && f._exportI64) {
      const { p, r, m, t } = f._exportI64
      for (const exportName of exportNamesOf(f.name))
        lateI64.push(t
          ? (m ? { name: exportName, p, m, t } : r ? { name: exportName, p, r, t } : { name: exportName, p, t })
          : (m ? { name: exportName, p, m } : r ? { name: exportName, p, r } : { name: exportName, p }))
    }
    if (isExported(f)) {
      const tag = []
      for (let i = 0; i < f.sig.params.length; i++)
        if (representationHostBoxesParam(ctx, f, i)) tag.push(i)
      if (tag.length) for (const exportName of exportNamesOf(f.name))
        lateHostAbi.push({ name: exportName, tag })
    }
  }
  for (const [name, val] of Object.entries(ctx.funcs.exports)) {
    if (val === true) {
      if (ctx.scope.userGlobals?.has(name)) lateNamedExports.push(['export', `"${name}"`, ['global', `$${name}`]])
      continue
    }
    if (typeof val !== 'string') continue
    const func = programFacts.programIndex.concreteFunctionOrder().find(f => f.name === val)
    if (func) lateNamedExports.push(['export', `"${name}"`, ['func', `$${isBoundaryWrapped(func) ? val + '$exp' : val}`]])
    else if (ctx.scope.globals.has(val)) lateNamedExports.push(['export', `"${name}"`, ['global', `$${val}`]])
  }
  const lateFacts = {
    rest: lateRest,
    ext: lateExt,
    i64: lateI64,
    hostAbi: lateHostAbi,
    namedExports: lateNamedExports,
    userFuncs: new Set(programFacts.programIndex.concreteFunctionOrder().map(f => `$${f.name}`)),
    errorSidEntries: [...ctx.schema.errorSidEntries()],
  }

  timePhase(profiler, 'pullStdlib', () => pullStdlib(sec))
  // The host last-error channel follows the source: a `throw` in a function
  // that reachability never lowered still declares and exports it.
  if (programFacts.hasThrow) ctx.runtime.throws = ctx.runtime.userThrows = true
  ensureThrowRuntime(sec)
  lateFacts.errorSidEntries = [...ctx.schema.errorSidEntries()]

  stripStaticDataPrefix(sec)

  timePhase(profiler, 'optimizeModule', () => optimizeModule(sec, profiler))
  if (ctx.transform.helperCallsites) instrumentHelperCallsites([...sec.funcs, ...sec.stdlib, ...sec.start])

  // Fold constant `__start` global inits into immutable inline decls (drops the
  // store, and `__start` with it when that empties it). Runs HERE — after
  // stripStaticDataPrefix and optimizeModule — so any data-segment offset a hoisted
  // pointer carries is already in its final, shifted form (hoisting earlier would
  // freeze a pre-strip offset the shift pass never revisits in the global decl).
  hoistConstGlobalInits(sec)

  // Standalone alloc:false has no JS allocator to synchronize, so its internal
  // bump pointer is not part of the host ABI.
  if (ctx.transform.alloc === false) {
    const heap = ctx.scope.globals.get('__heap')
    if (heap) heap.export = null
  }

  // Populate globals (after __start — const folding may update declarations).
  // Records build IR directly — no WAT-text parse-back.
  // The wasm type comes from globalTypes (the canonical name→type map declGlobal
  // maintains alongside the entry), falling back to the entry's own `.type`. They
  // are normally identical, but a global whose entry object is later rebuilt (e.g.
  // hoistConstGlobalInits' `{...g, …}` spread) must not depend on that rebuild
  // preserving `.type` — globalTypes is the stable source, so an entry that lost
  // its `.type` still emits a well-typed `(global …)` rather than `(undefined.const)`.
  sec.globals.push(...[...ctx.scope.globals].filter(([, g]) => g).map(([n, g]) => {
    const ty = ctx.scope.globalTypes.get(n) ?? g.type
    return ['global', `$${n}`,
      ...(g.export ? [['export', `"${g.export}"`]] : []),
      g.mut ? ['mut', ty] : ty,
      [`${ty}.const`, g.init]]
  }))

  // Drop the lazy conversion tables (EL decimal→f64, Ryū float→decimal) whose owner
  // functions no live code calls — must run after sec.globals/funcs are final (exact
  // reachability) and before the data segment below serializes ctx.runtime.data.
  stripDeadLazyTables(sec)

  // Reclaim the trailing run of any OTHER coarsely-interned data (buildStartFn's
  // whole-schema-list table, a stdlib thunk's own string constants — see
  // stripDeadInternedSpans' own doc) that the same exact, final reachability
  // proves dead. Runs after stripDeadLazyTables so a dead lazy table doesn't
  // masquerade as the "true tail" this pass's contiguity check relies on.
  stripDeadInternedSpans(sec)

  // Data segments (after emit — string literals append to ctx.runtime.data / strPool during emit)
  // Active segment at address 0 — skipped for shared memory (would collide across modules)
  const escBytes = (s) => {
    let esc = ''
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 32 && c < 127 && c !== 34 && c !== 92) esc += s[i]
      else esc += '\\' + c.toString(16).padStart(2, '0')
    }
    return esc
  }
  // Module-defined memory is zero-initialized, so a long zero run inside the
  // segment (static typed storage's payload) ships as a gap between segments
  // at every optimize level, not only where watr's packer runs.
  if (dataLen() && !ctx.memory.shared) {
    const data = dataString()
    const GAP = 32
    let at = 0
    while (at < data.length) {
      let end = at, zeros = 0
      for (let i = at; i < data.length; i++) {
        if (data.charCodeAt(i) === 0) { if (++zeros === GAP) { end = i + 1 - GAP; break } }
        else zeros = 0
        end = i + 1
      }
      if (end > at) sec.data.push(['data', ['i32.const', at], '"' + escBytes(data.slice(at, end)) + '"'])
      at = end
      while (at < data.length && data.charCodeAt(at) === 0) at++
    }
  }
  // Shared memory: no active segment at 0 (instances would collide) — ship the
  // static region (static strings + lazy conversion tables) as a PASSIVE segment,
  // memory.init it into __alloc'd space at start, and rebase its consumers:
  // $__staticBase for __static_str, plus each surviving table global (their
  // declared inits hold offsets WITHIN the region — see injectTable/strip).
  else if (dataLen() && ctx.memory.shared && ctx.scope.globals.has('__staticBase')) {
    const len = dataLen()
    sec.data.push(['data', '$__staticData', '"' + escBytes(dataString()) + '"'])
    const inits = [
      ['global.set', '$__staticBase', ['call', '$__alloc', ['i32.const', len]]],
      ['memory.init', '$__staticData', ['global.get', '$__staticBase'], ['i32.const', 0], ['i32.const', len]],
      ['data.drop', '$__staticData'],
      ...(ctx.runtime.lazySpans || []).map(t => ['global.set', `$${t.global}`,
        ['i32.add', ['global.get', '$__staticBase'], ['i32.const', ctx.scope.globals.get(t.global)?.init || 0]]]),
    ]
    let startFn = sec.start.find(n => Array.isArray(n) && n[0] === 'func' && n[1] === '$__start')
    if (!startFn) sec.start.push(startFn = ['func', '$__start'], ['start', '$__start'])
    // insert after the local decls, before any init code (module init may stringify)
    let at = 2
    while (at < startFn.length && Array.isArray(startFn[at]) && startFn[at][0] === 'local') at++
    startFn.splice(at, 0, ...inits)
  }
  // Passive segment for shared-memory string literals (copied via memory.init at runtime)
  if (strPoolLen())
    sec.data.push(['data', '$__strPool', '"' + escBytes(strPoolString()) + '"'])

  // Custom section: rest params for exported functions (JS-side wrapping).
  // Entry per JS-visible export name (not per internal func name) — host's
  // interop.js wrap() keys by export name. Aliased re-export
  // (`function foo (...rest); export { foo as bar }`) needs `bar` in the
  // list; otherwise JS pads the missing args with UNDEF_NAN and the
  // VAL.ARRAY narrow path reads i32 at `__ptr_offset(UNDEF_NAN) - 8`, hitting
  // OOB instead of the polymorphic length-check fallback's tag-aware return-0.
  const restParamFuncs = lateFacts.rest
  if (restParamFuncs.length)
    sec.customs.push(['@custom', '"jz:rest"', `"${JSON.stringify(restParamFuncs).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Custom section: per-export externref param positions. interop.js reads
  // this to pass JS arguments straight through at those positions (no
  // `mem.wrapVal`, no SSO encoding). Format: { name, p, d? } where p lists
  // 0-based externref param indices and d (optional) is a map idx→default
  // string for jsstring-carrier params whose default-substitution happens
  // JS-side. Empty list emits nothing.
  const extExports = lateFacts.ext
  if (extExports.length)
    sec.customs.push(['@custom', '"jz:extparam"', `"${JSON.stringify(extExports).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // jz:i64exp — per-export i64 carrier map (NaN-canonicalization dodging).
  // `{name, p:[i64 param indices], r:1? | m:N?}`: `p` lists params interop
  // passes as BigInt; `r` marks a single result for generic tagged decode;
  // `m` marks an N-lane multi-value result. Pure-numeric single-result
  // exports emit no entry. A proven raw BigInt result is i64 but unmarked.
  // Written under every JS-visible alias, like jz:extparam. Each shape is built as a direct
  // literal (no spread) — the self-compile kernel's fixed schemas don't enumerate post-hoc keys.
  const i64Exports = lateFacts.i64
  if (i64Exports.length)
    sec.customs.push(['@custom', '"jz:i64exp"', `"${JSON.stringify(i64Exports).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // jz:hostabi — ONE authority for the per-slot host-BigInt ingress policy
  // (phase-c C4b, external audit P0 #1/#2: interop must dispatch on an
  // explicit enum, never guess a slot's policy from the absence of a
  // different signal). Supersedes jz:bigintbox's bare boolean membership
  // (interop used to read "absent" as "reject" with no way to represent a
  // hypothetical proven-raw slot at all). Per export: `raw` lists i64 param
  // indices the plan proved ALWAYS bigint — a plain host bigint would cross
  // with no box (wasm's native BigInt→i64 coercion). ALWAYS EMPTY TODAY:
  // reachability audit (phase-c C4b) — makeBoundaryData (representation-
  // plan.js) sets `uncovered = isExported(...)` unconditionally for every
  // exported function's params, because the JS host can call with ANY value
  // regardless of what the body proves about its own internal call sites.
  // `uncovered` forces `currentParamRep` to ANY_BIGINT (never CLOSED) for
  // any param that may touch bigint at all, which forces `targetRepFor` past
  // both `bigintRepIsClosed(current)` guards straight to BOXED_BIGINT — RAW
  // is only reachable there when `current` is closed, which an exported
  // param's forced-open boundary can never be. Confirmed empirically too:
  // every export-param shape tried (direct bigint arithmetic on a param,
  // typeof-guarded params, BigInt()-converted params) either lands in `tag`
  // below or gets no i64/bigint marking at all — never a bare i64 carrier
  // proven bigint with no box. The field is real (not a placeholder) and
  // reserved: a future closed-world export analysis needs no interop
  // redesign, only a producer for this array. `tag` lists indices the plan
  // proved MAY be bigint (representationHostBoxesParam) — the one reachable
  // evidenced state today; interop boxes a plain bigint via mem.BigInt, wasm
  // dispatches by tag. `rest` (present+truthy only) would mark the
  // REST-ELEMENT policy tagged when the plan can prove bigint evidence for
  // elements past the fixed count — omitted always today: rest elements are
  // host-populated (interop's own mem.Array, never a traceable in-program
  // def site RepresentationPlan's provenance solver can reach), so no
  // evidence source exists yet; interop.js rejects a plain bigint rest
  // element exactly like an unmarked fixed slot. A slot in neither `raw` nor
  // `tag` — the overwhelming common case — carries no BigInt evidence of any
  // kind: reject.
  const hostAbiExports = lateFacts.hostAbi
  if (hostAbiExports.length)
    sec.customs.push(['@custom', '"jz:hostabi"', `"${JSON.stringify(hostAbiExports).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Named export aliases: export { name } or export { source as alias }. A `run`/`_start`
  // alias under host:'wasi' emits its natural entry here too — legalizeForTarget (TargetProfile
  // stage, src/optimize/watr-tail.js) rewrites it into the () -> () wrapper afterward, keyed
  // off this same customs entry shape (no wasiCommandExports skip needed).
  sec.customs.push(...lateFacts.namedExports)

  // The module assembles here in section order with the functions in
  // emission order (runtime, user, start); link (src/link) runs the
  // whole-module passes on the tape: treeshake, the schema and error-class
  // sections, the throw-runtime prune, the call-count function order, the
  // local-name suffix strip and the constant pool.
  const startFn = sec.start.find(n => n[0] === 'func')
  const startDir = sec.start.find(n => n[0] === 'start')
  const module = ['module',
    ...sec.extStdlib, ...sec.imports, ...sec.types, ...sec.memory, ...sec.data,
    ...sec.tags, ...sec.table, ...sec.globals, ...sec.stdlib, ...sec.funcs, ...(startFn ? [startFn] : []),
    ...sec.elem, ...(startDir ? [startDir] : []), ...sec.customs,
  ]
  // A function's record allows an arena rewind when it takes nothing and
  // returns one scalar that is not a pointer (a boxed f64 result must be a
  // number); link decides from the body.
  const rewindable = new Map()
  for (const f of ctx.funcs.list) {
    if (f.raw || f.sig.params.length !== 0 || f.sig.results.length !== 1 || f.sig.ptrKind != null) continue
    const ty = f.sig.results[0]
    if (ty === 'i32' || (ty === 'f64' && f.valResult === VAL.NUMBER)) rewindable.set(`$${f.name}`, ty)
  }
  return timePhase(profiler, 'link', () => link(module, {
    optimize: ctx.transform.optimize,
    userFuncs: lateFacts.userFuncs, userGlobals: ctx.scope.userGlobals,
    rewindable, heapAddr: ctx.memory.shared ? HEAP.PTR_ADDR : null,
    schemas: ctx.schema.list, namedUses: ctx.schema.namedUses, errorSids: lateFacts.errorSidEntries,
    throws: ctx.runtime.throws, userThrows: ctx.runtime.userThrows, noEhAbort: ctx.transform.noEhAbort,
    rawAbi: ctx.transform.alloc === false,
  }))
}
