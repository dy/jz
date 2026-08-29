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
import { ctx, err, inc, resolveIncludes, PTR, LAYOUT, declGlobal, assertCtxInvariants } from '../ctx.js'
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
  analyzeStructInline, analyzeUnionInline, reanalyzeBody, invalidateAllBodyFacts,
} from './analyze.js'
import { typedElemAux } from '../../layout.js'
import { invalidateBindingUsesCache, resetBindingUsesCache } from './analyze-scans.js'
import { VAL, updateRep } from '../reps.js'
import { inferLocals } from './infer.js'
import { optimizeFunc, treeshake } from '../optimize/index.js'
import { strengthReduceLoopDivMod } from './loop-divmod.js'
import { mintLoopPlans } from './loop-model.js'
import { mintClosureEnvPlans } from './closure-plan.js'
import { mintRepresentationPlan, representationHostBoxesParam, representationProgramHasBigint, representationReturnAction } from './representation-plan.js'
import { mintTypedStoragePlan } from './typed-storage-plan.js'
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
  I32_MIN, I32_MAX, dollar,
  carrierF64,
  applyBigintRepresentationAction,
  freshId,
  dollarMap, setDollarMap,
} from '../ir.js'
import plan from './plan/index.js'
import { foldStaticConstAggregates } from './plan/literals.js'
import {
  buildStartFn, dedupClosureBodies, finalizeClosureTable,
  pullStdlib, syncImports, optimizeModule, stripStaticDataPrefix, hoistConstGlobalInits, stripDeadLazyTables, stripDeadInternedSpans,
  stripLocalRenameSuffixes,
  stdlibParseCacheMap, setStdlibParseCacheMap,
} from '../wat/assemble.js'
import { instrumentHelperCallsites } from '../helper-counters.js'
import { isExported, exportNamesOf } from './func-exports.js'
import { enterFunc, emitPreboxedLocalInits } from './func-entry.js'
import { paramAllUsesNumeric, paramNeverString } from './param-numeric.js'
import { ensureThrowRuntime, pruneUnusedThrowRuntime } from './throw-runtime.js'
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


/**
 * Compile prepared AST to WASM module IR.
 * @param {import('./prepare.js').ASTNode} ast - Prepared AST
 * @param {Object} [profiler] - host-only per-phase timing sink (timePhase)
 * @param {{mark: Function, exit: Function}} [regionHooks] - region-arena EMIT
 *  boundary (.work/evidence.md §Region arena, Slice 3): supplied ONLY by the
 *  self-compile kernel entry (scripts/self.js), mirroring frontHalf's own
 *  `regionHooks` contract (src/front.js) one boundary later in the pipeline —
 *  never passed by the native host (index.js calls `compile(ast, profiler)`,
 *  2 args, so `regionHooks` stays undefined there, zero behavior change: the
 *  gate battery below is for the NATIVE/dormant axis, unaffected by any of
 *  this). When present, wraps this WHOLE function body in one region round:
 *  every allocation `compile()` makes (plan/analyze facts, per-function
 *  locals, emit scratch, the whole `sec.*` staging structure) gets reclaimed
 *  at exit EXCEPT what's reachable from the root `[module, ctx.func,
 *  ctx.funcs, ctx.transform, ctx.scope]` — the returned module tree, plus the
 *  ctx containers the emit/encode tail (this file's own caller: scripts/self.js's
 *  `optimizeTail` wrapper, then `watrTail`'s post-watr `stablePtrGlobalNames`/
 *  `hoistGlobalPtrOffset` repair) still reads AFTER this function returns
 *  (`ctx.funcs.list.length`/`.map` — populated by the two `.clear()`-then-
 *  rebuild loops right below, read back by `scripts/self.js`'s own
 *  `optimizeTail` at `funcCount: ctx.funcs.list.length` and
 *  `ctx.funcs.map.get(...)`; `ctx.transform.optimize`/`.targetProfile`/
 *  `._vectorizedFnNames`; `ctx.scope.globalValTypes` — populated by this
 *  function's own `declGlobal` calls). Root the CONTAINERS, not individual
 *  leaf fields, matching `ctx.module`/`ctx.schema`/`ctx.closure` already
 *  riding front's own root this way. `ctx.module`/`ctx.schema` are NOT in
 *  THIS root: every read of either happens INSIDE this function, before exit
 *  fires (schema custom-section emission above, module import resolution at
 *  the top) — not needed post-return.
 *  The root must name `ctx.funcs` (plural, the function REGISTRY: `.list`/
 *  `.map`/`.names`, freshly rebuilt by this function's own opening
 *  `.clear()`-then-rebuild loops below), not `ctx.func` (singular, the
 *  ACTIVE-FRAME scratch record — inert/null by the time this exit fires):
 *  only the registry survives to be read by `optimizeTail`/`watrTail` after
 *  `compile()` returns. `ctx.func` is kept in the root too (harmless,
 *  uniform-root idiom) alongside it.
 *
 *  Rooting `ctx.transform` requires `__region_relocate_props` to be
 *  idempotent under re-application to its own output — otherwise
 *  `__region_copy_rec` corrupts a durable-but-unreached receiver's dyn-props
 *  on a second pass (see `module/core.js`, .work/evidence.md §Region arena
 *  "REGION MACHINERY SOUND"). `REGION_HOOKS_ACTIVE` still stays `false` as
 *  the committed default (scripts/self.js) — this boundary and its
 *  PLAN-TAIL children (`src/compile/plan/index.js`'s own five inner region
 *  rounds, threaded through the SAME `regionHooks` this function receives —
 *  see that file's own doc) ship DORMANT, gate-verified on both axes, not
 *  wired live in any shipped build.
 *
 *  THE RULE for every one of this function's SIX-plus nested mark/exit
 *  pairs (SCAN, AFE, emitFuncs, `__buildMark`, `__stdlibMark`, this
 *  outermost one — each documented individually at its own call site):
 *  a round's root/snapshot must carry every PLAIN-DATA field ANY code
 *  reachable before the NEXT mark (including code after this round's own
 *  exit, up to and including the function's return and whatever the
 *  caller reads next) still touches — not just what the round's OWN body
 *  writes. Two confirmed instances of getting this wrong, both fixed by
 *  WIDENING an existing snapshot rather than adding a new root category:
 *  front's round originally missed `ctx.core` entirely (a stdlib module's
 *  `init(ctx)` triggered mid-round by `prepare()`'s unconditional
 *  `includeModule('core')`, fixed by hoisting every stdlib load before
 *  `mark()` — `88e48378`); `__stdlibMark`'s `lateSchema` snapshot missed
 *  `ctx.schema.namedUses` (a plain array `module/core.js`'s
 *  `__throw_property_nullish` populates for nearly every compile, read
 *  ~40 lines after this round's own exit by the `usedSchemaIds` walk —
 *  region-emitir-round session, `.work/archive/region-release-notes.md`). Neither
 *  bug was a fault in `__region_exit`'s own relocation walk (that
 *  machinery is sound and unconditionally correct for whatever root it's
 *  given) — both were root-COMPLETENESS gaps at the JS call site. `ctx.core`
 *  itself (its `.emit`/`.stdlib` closure dicts) stays permanently OUT of
 *  every round's root (wholesale-rooting it was tried in `7085cb57` and
 *  made the regression WORSE) — the fix for a field living there is always
 *  to either hoist its write before `mark()`, or copy the specific
 *  plain-data field a round's own snapshot needs into that snapshot, never
 *  to root `ctx.core` itself.
 * @returns {Array} Complete WASM module as S-expression
 */
export default function compile(ast, profiler, regionHooks) {
  const __regionMark = regionHooks?.mark()
  // Contract: callers (jzCompileInner / scripts/self.js compileSelf) must set
  // ctx.transform.optimize before reaching here — every optimize-gated pass below
  // reads `cfg && cfg.x === false`, so a null cfg silently runs every pass.
  // Populate known function names + lookup map on ctx.func for direct call detection
  ctx.funcs.names.clear()
  ctx.funcs.map.clear()
  for (const f of ctx.funcs.list) { ctx.funcs.names.add(f.name); ctx.funcs.map.set(f.name, f) }
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

  // `let`, not `const`: the post-plan-scans region round below (region-live
  // only, dead code otherwise) rebinds this from its own `exit()` return.
  let programFacts = timePhase(profiler, 'plan', () => plan(ast, profiler, regionHooks))

  // Region-arena plan-tail round 6 (.work/evidence.md §Region arena, per-pass
  // slice): the three closure-table scans below are pure AST walks producing
  // three ctx.scope fields (+~61 MB combined, dominated by
  // scanClosureTableLatticeCandidates's own +61 MB)
  // — one round. Root: the UNION-FIELD set (Slice C-v2, `.work/archive/compile-
  // session-design.md` §2.1/§3, front.js's own doc has the full rationale
  // for why this is the union of every field any round has ever needed,
  // applied uniformly, rather than a wholesale `[ast, ctx]` root).
  const __scanMark = regionHooks?.mark()
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
  if (regionHooks) {
    ;[ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts] =
      regionHooks.exit(__scanMark, [ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts])
  }

  // Inspect sink: editor hosts opt in via { inspect: true } to read inferred shapes.
  // Initialized here (post-plan) so paramReps and schema.list are stable, populated
  // per-function below as FunctionPlans settle. Bytes themselves are unchanged.
  if (ctx.transform.inspect) ctx.inspect = { functions: {}, schemas: ctx.schema.list.map(s => s.slice()) }

  const publishPlan = (func, facts) => publishFunctionPlan(ctx, func, facts)
  // Region-arena analyzeFuncs BATCHED round (.work/evidence.md §Region arena,
  // Lever 1 — the retained-set census's own top lever: ~70% MAP/HASH-shaped
  // churn, up to 1435 calls for jz×jz). Iteration below is index-based,
  // re-reading `ctx.funcs.list[i]` FRESH every access rather than holding
  // the array or an iterator across a region exit: a plain `for…of` iterator
  // over `ctx.funcs.list` caches the array's base pointer ONCE at loop entry
  // (this codebase's own self-compiled for-of lowering, not V8's), so a
  // mid-loop `region_exit` that relocates `ctx.funcs` (and thus its `.list`
  // backing store) would leave that cached base stale — the "durable
  // receiver, stale pointer to reclaimed memory" class (see the
  // closure4232/fromnested test cases). The index-based form is
  // behavior-identical to the original `for…of` both natively (V8's own
  // Array iterator is itself index+length-checked per step, so growth-
  // during-iteration behaves the same either way) and self-compiled (a fresh
  // property read always observes the just-rebound `ctx.funcs`).
  //
  // GRANULARITY — batched (every AFE_ROUND_BATCH functions), not per-function:
  // this round's own root bundle (below) must include `ctx.plans` (see its
  // own note) — a container that grows by one FunctionPlan every iteration
  // and is never emptied. `__region_exit` is a compacting relocator that
  // walks and RE-COPIES the entire root-reachable durable set at every exit
  // (confirmed by the census's own mark/delta methodology: the memo resets at
  // every new round — no cross-round memoization of "unchanged since last
  // round"), so exiting once per function against a linearly-growing root
  // would cost O(N²) total copy work for N functions (1435 for jz×jz) — a
  // real risk of the reclaim overhead eclipsing the reclaim benefit. Batching
  // divides that cost by the batch size while still reclaiming per-function
  // churn (the actual target) far more often than the status quo (never).
  // AFE_ROUND_BATCH is a tunable constant, sized from jessie/watr/jzify-entry
  // measurement (`.work/evidence.md` §Region arena, this entry), not guessed.
  const AFE_ROUND_BATCH = 32
  // Fixed-shape closure records closed the former `cb.params` relocation
  // corruption, but full closure-round jz×jz still reaches wasm32's copying
  // ceiling before producing bytes. Keep this high-copy boundary dormant until
  // the complete goal (not only parity/oracle probes) proves it end to end.
  const CLOSURE_ROUNDS_ACTIVE = false
  const EMIT_FUNC_ROUNDS_ACTIVE = true
  timePhase(profiler, 'analyzeFuncs', () => {
    // Mark lazily, at the first index actually reached (not unconditionally
    // before the loop) — an empty/all-raw `ctx.funcs.list` must never leave
    // an unpaired `mark()` with no matching `exit()`.
    let __mark = null
    for (let i = 0; i < ctx.funcs.list.length; i++) {
      if (regionHooks && __mark == null) __mark = regionHooks.mark()
      const func = ctx.funcs.list[i]
      if (!func.raw) {
        const facts = analyzeFuncForEmit(func, programFacts)
        publishPlan(func, facts)
        captureFuncInspect(func, facts, programFacts)
      }
      const lastFunc = i === ctx.funcs.list.length - 1
      if (regionHooks && ((i + 1) % AFE_ROUND_BATCH === 0 || lastFunc)) {
        // Union-field root (Slice C-v2, `.work/archive/compile-session-design.md`
        // §2.1/§3, front.js's own doc has the full rationale): covers every
        // container this loop writes — `ctx.plans` (publishFunctionPlan's
        // per-iteration `.set()`) and `ctx.inspect` (captureFuncInspect)
        // included. `func`/`functionPlan` (the loop locals) stay
        // deliberately unrooted: both are fully consumed (published,
        // captured, scanned) before this exit fires, dead the instant this
        // branch is reached — exactly the garbage this round exists to
        // reclaim.
        ;[ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts] =
          regionHooks.exit(__mark, [ast, programFacts, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts])
        __mark = null  // re-armed lazily at the next index, if any
      }
    }
  })
  // Whole-program SRoA: pick the schemas whose `Array<S>` instances use the
  // `structInline` carrier. Runs once the per-function reps have settled (they
  // are codegen truth) and before any function is emitted.
  // `optimize: { structInline/unionInline: false }` disable a representation
  // wholesale — the REFERENCE MODES for three-way differentials (off / on /
  // plain JS); with an empty registry every consumer takes the plain path.
  if (ctx.transform.optimize?.structInline !== false)
    timePhase(profiler, 'structInline', () => analyzeStructInline(programFacts))
  if (ctx.transform.optimize?.unionInline !== false) {
    timePhase(profiler, 'unionInline', () => analyzeUnionInline(programFacts))
    // Carrier-specialized clones (after the registry settles): verified
    // cursor-param functions get a raw-i32 `$union` sibling; sanctioned
    // callsites rewrite to it — no NaN-box crosses the call.
    // The clone's facts must derive under ITS sig (the pointer-ABI param
    // registration + reps seeding live in analyzeFuncForEmit) — re-run it
    // per clone rather than sharing the original's f64-sig facts.
    timePhase(profiler, 'unionClones', () => {
      for (const clone of specializeUnionCursorParams(programFacts)) {
        const facts = analyzeFuncForEmit(clone, programFacts)
        publishPlan(clone, facts)
        captureFuncInspect(clone, facts, programFacts)
      }
    })
  }
  // FeaturePlan freeze (.work/evidence.md §FeaturePlan freeze): every per-function
  // analyze pass has now run (analyzeFuncs + structInline/unionInline/unionClones
  // above) — this is the freeze point after which NO ctx.features key may change
  // (uniform, no exceptions; typedView — the one key that used to keep flipping
  // past this point — was reclassified onto ctx.linkDemand). Extends the
  // post-prepare SESSION+PROGRAM snapshot with ANALYSIS (currently empty);
  // compared at 'pre-assemble' below.
  assertCtxInvariants('post-analyze')
  // FunctionPlans now own every named-function fact needed by emission. Drop
  // the duplicate bodyFacts cache before region rounds start; any genuinely
  // late consumer recomputes, while the self-host relocator no longer copies
  // both the canonical plan and its analysis cache for every function.
  invalidateAllBodyFacts()
  resetBindingUsesCache()
  // isReassigned memo window: emission is a pure projection of the frozen
  // post-analyze AST, so per-subtree assigned-name sets stay valid for the
  // whole stage (see the memo doc in ast.js).
  //
  // EMISSION region-round exit wrapper — roots/rebinds non-`ctx` module-scope
  // caches alongside the ordinary ctx.* root array. DOLLAR (src/ir.js,
  // dollarMap/setDollarMap) lives entirely outside `ctx`, invisible to any
  // ctx.*-based root no matter how that array is extended: `dollar()` fires
  // on effectively every emitted IR node, growing DOLLAR's backing Map
  // heavily mid-emission, and with DOLLAR unrooted a round-exit mid-batch
  // reclaims that growth out from under it — the SAME class this binding's
  // own doc already names for warm-instance reuse (`_clear` swap-in-fresh-
  // Map), just triggered by a region-round boundary instead of a new
  // compile. Verified NOT sufficient alone to close the jz×jz-scale trap
  // (see the ledger note below) but real and worth keeping regardless — it
  // is unconditionally safer than leaving DOLLAR unrooted. `extern` pairs
  // (get, set) let a specific round add MORE non-ctx caches (pullStdlib's
  // stdlibParseCache, src/wat/assemble.js — same documented hazard class,
  // only live during that one stage) without every site paying for it.
  const DOLLAR_EXTERN = [dollarMap, setDollarMap]
  const emissionRoundExit = (mark, root, extern = [DOLLAR_EXTERN], exit = regionHooks.exit) => {
    const values = []
    for (let i = 0; i < extern.length; i++) values.push(extern[i][0]())
    const rootLen = root.length
    // `extern` itself contains closure-valued setter functions and is used
    // AFTER region exit. Root and rebind that descriptor too; otherwise the
    // freshly-created default `[DOLLAR_EXTERN]` can be reclaimed and the first
    // setter call reads a stale closure aux → call_indirect table OOB.
    const out = exit(mark, [...root, extern, ...values])
    const movedExtern = out[rootLen]
    for (let i = movedExtern.length - 1; i >= 0; i--) movedExtern[i][1](out.pop())
    out.splice(rootLen, 1)
    return out
  }
  // Region rounds through EMISSION (re-landing .work/evidence.md §Emission
  // rounds — same batching rationale and iterator discipline as the
  // analyzeFuncs loop above: index-based fresh reads, roots rebound at every
  // exit, batch size shared with AFE_ROUND_BATCH). Nothing reclaimed here
  // before this re-land: the whole emission+assembly pipeline ran hook-free,
  // accumulating every emit temporary from the last AFE exit to the
  // (never-reached) outer boundary — the quantified 69.1%/2,274 MB jz×jz
  // window (fresh forensic attribution, this entry). The accumulating output
  // array rides in the root bundle; the isReassigned memo is pointer-keyed
  // off AST nodes, so it is closed before every exit and reopened after
  // (relocation would strand its keys).
  //
  // ROOT BUNDLE — extended past the ANALYSIS-stratum 12-field union (front.js's
  // own doc, shared by every round so far) with EMISSION's own write-set,
  // PLAIN-DATA FIELDS ONLY: ctx.runtime (dataParts/dataDedup grow per string
  // literal), ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features
  // (scalars/Maps/Sets, no closures) — plus the specific ctx.core SUB-fields
  // emission writes (ctx.core.includes/extImports/jsstring/hostGlobals/
  // stdlibDeps — Sets/plain objects). `ctx.core` ITSELF (its `.emit`/`.stdlib`
  // siblings — hundreds of CLOSURE-valued dispatch/codegen entries), plus
  // `ctx.bridge`/`ctx.abi` (same shape), stay OUT of every round root: this is
  // the load-bearing lesson of the FIRST re-land attempt (53bcb112+7085cb57,
  // reverted) — 7085cb57 rooted `ctx.core`/`ctx.abi`/`ctx.bridge` wholesale to
  // fix exactly this under-coverage and made the regression WORSE ("phantom
  // pair GROWN", third failure mode), and a dedicated prior investigation unrelated
  // to this file (.work/evidence.md §CompileSession Slice D, two direct
  // experiments) independently proved wholesale-rooting these same nine
  // fields reproduces real WASM traps (`unreachable`, `memory access out of
  // bounds`) neither hypothesis closed — walking a several-hundred-entry
  // closure dict is a shape `__region_copy_rec` has never been proven safe
  // against. Narrower fix: root only the plain-data containers actually
  // written; `ensureThrowRuntime`'s one post-pullStdlib read of
  // `ctx.core.stdlib` (the sole read of the excluded closure dicts found
  // anywhere after any round's exit) is closed by reordering, not rooting —
  // see the pullStdlib round below.
  //
  // KNOWN OPEN ISSUE (re-land session, jz×jz scale only): this round is
  // GATE-CLEAN on jessie/watr/jzify (region-live probes: jessie 345.44 MB,
  // ≤380.8 baseline PASS; jzify 2032.56 MB PASS, completes; watr traps at
  // the pre-existing 4 GiB ceiling, neutral — bit-identical to the SAME
  // probes run against this round entirely absent, i.e. genuinely zero
  // regression at this scale). The jz×jz goal probe (self.js compiling
  // itself, 2234 functions) does NOT yet pass with this round active: it
  // hits a deterministic "memory access out of bounds" / "Cannot iterate
  // null or undefined" at peak 3059.38 MB, IDENTICAL across three tested
  // root-set configurations (full ctx.runtime/ctx.core extension + DOLLAR;
  // extension without DOLLAR; DOLLAR without extension) — ruling out both
  // DOLLAR and the ctx.* extension as the cause by elimination. HEAD (no
  // emission round at all, front+AFE only) ALSO fails the same probe, but
  // with a DIFFERENT, pre-existing signature ("Maximum call stack size
  // exceeded" @ 3669.50 MB) — the jz×jz goal probe was not passing on this
  // exact methodology before this round existed either, so this is a
  // genuinely distinct, deeper mechanism (likely in `__region_copy_rec`'s
  // handling of the `out` accumulator's large/deeply-nested WAT-IR content
  // specifically — the one structural difference between this round and
  // AFE's own proven-safe use of the same 12-field union), not a simple
  // root-completeness gap. Needs dedicated WAT-breadcrumb forensics (the
  // campaign's own established method for this exact class,
  // .work/evidence.md §CompileSession Slice B) — banked, not chased further this
  // session, per the same campaign's repeated precedent of not spot-fixing
  // an unconfirmed mechanism.
  let funcs = timePhase(profiler, 'emitFuncs', () => {
    let out = []
    let __mark = null, batchN = 0
    const closeRound = () => {
      endAssignedMemo()
      ;[ast, programFacts, out, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps] =
        emissionRoundExit(__mark, [ast, programFacts, out, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps])
      __mark = null
      batchN = 0
      beginAssignedMemo()
    }
    beginAssignedMemo()
    try {
      for (let i = 0; i < ctx.funcs.list.length; i++) {
        const func = ctx.funcs.list[i]
        // Fixed-shape closure records make closure-producing named functions
        // relocation-safe too; all named functions share one batched policy.
        // Closure-BODY waves remain separately gated below.
        if (EMIT_FUNC_ROUNDS_ACTIVE && regionHooks && __mark == null) __mark = regionHooks.mark()
        if (func.raw) out.push(emitFunc(func, null, programFacts))
        else {
          const functionPlan = functionPlanOf(ctx, func)
          out.push(emitFunc(func, functionPlan, programFacts))
          retireFunctionPlan(ctx, func, functionPlan)
          invalidateBindingUsesCache(func.body)
        }
        if (__mark != null) batchN++
        const last = i === ctx.funcs.list.length - 1
        if (__mark != null && (batchN >= AFE_ROUND_BATCH || last)) closeRound()
      }
    } finally { endAssignedMemo() }
    return out
  })
  funcs.push(...synthesizeBoundaryWrappers())

  let closureFuncs = []
  // `sec` doesn't exist yet at the first compilePendingClosures() call (its
  // declaration is further below), but the buildStartFn callback re-enters
  // this function AFTER sec holds every emitted function — a region exit
  // there must root sec or reclaim the module. Registered once sec is built
  // (right after its own declaration, below); null until then (an inert,
  // always-safe root — every round tolerates a null element, same as
  // ctx.inspect's own null-until-populated shape in the 12-field union).
  let __secRoot = null
  let compiledBodyCount = 0
  const compilePendingClosures = () => timePhase(profiler, 'emitClosures', () => {
    // Emitting a body may discover nested closures. Process stable batches:
    // every body known at batch entry is fully planned before any body in that
    // batch emits; newly discovered bodies become the next batch.
    // NOTE: analyzeClosureBodyForEmit runs OUTSIDE the isReassigned memo window
    // (it may touch analyze-side caches); only the pure emit half is bracketed.
    // Region round per batch (see the emitFuncs loop above, same write-set +
    // DOLLAR discipline via emissionRoundExit): `ctx.closure.bodies` is
    // re-read fresh each access (never held across an exit — the AFE loop's
    // own "durable receiver, stale pointer" note applies identically here);
    // `funcs`/`closureFuncs`/`__secRoot` ride in the root bundle.
    while (compiledBodyCount < (ctx.closure.bodies?.length || 0)) {
      const __mark = CLOSURE_ROUNDS_ACTIVE ? regionHooks?.mark() : null
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
      if (CLOSURE_ROUNDS_ACTIVE && regionHooks) {
        ;[ast, programFacts, funcs, closureFuncs, __secRoot, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps] =
          emissionRoundExit(__mark, [ast, programFacts, funcs, closureFuncs, __secRoot, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps])
        if (__secRoot) sec = __secRoot
      }
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
  let sec = {
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
  // Register `sec` for the closure round above (its `__secRoot` was null
  // until now — see that binding's own doc) and for the stage rounds below.
  __secRoot = sec

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
    sec.table.push(['table', ['export', '"__jz_table"'], ctx.closure.table.length, 'funcref'])

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

  // Stage region round: mark before buildStart (late closure batches + the
  // start-function IR churn — top-level statements, module-init code — none
  // of which any prior round has ever reclaimed), exit after — mirrors the
  // AFE-round shape, same write-set + DOLLAR discipline via
  // emissionRoundExit. `sec` rides via __secRoot (registered above); `funcs`/
  // `closureFuncs` may still grow here (compilePendingClosures' own re-entry
  // from inside buildStartFn) so both stay in the root too.
  const __buildMark = regionHooks?.mark()
  timePhase(profiler, 'buildStart', () => buildStartFn(ast, sec, closureFuncs, compilePendingClosures))
  if (regionHooks) {
    ;[ast, programFacts, funcs, closureFuncs, sec, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps] =
      emissionRoundExit(__buildMark, [ast, programFacts, funcs, closureFuncs, sec, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts, ctx.runtime, ctx.memory, ctx.error, ctx.linkDemand, ctx.names, ctx.features, ctx.core.includes, ctx.core.extImports, ctx.core.jsstring, ctx.core.hostGlobals, ctx.core.stdlibDeps])
    __secRoot = sec
  }

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

  // Stage region round: pullStdlib realizes every stdlib helper's WAT
  // template (+927 MB churn measured on jz×jz, .work/evidence.md §Parts-fix
  // verified) via resolveIncludes()/includeModule() — module registration,
  // which is ALSO where ctx.core.emit/ctx.core.stdlib (the closure-bearing
  // dicts excluded from every round's root, see the emitFuncs round's own
  // doc above) grow most heavily. `ensureThrowRuntime` is called INSIDE this
  // round's mark/exit window, not after: it is the one caller anywhere that
  // reads `ctx.core.stdlib` post-pullStdlib (checking realized helper bodies
  // for `(throw `), and with those dicts deliberately unrooted a read after
  // THIS exit would be the exact dangling-arena-pointer class the DOLLAR fix
  // documents — closed by REORDERING the read inside the live round instead
  // of rooting the closure dict. `stripStaticDataPrefix` stays after the
  // exit: its own ctx.core dependency (`.includes`, a plain Set) is already
  // rooted, so a post-exit read is sound. `stdlibParseCache` (src/wat/
  // assemble.js) is the SAME non-ctx module-scope hazard class as DOLLAR,
  // fired by every `parseTemplate` call inside pullStdlib's own realize
  // step — rooted here via the `extern` list (site-scoped: no other round
  // touches it).
  // Everything below pullStdlib needs only compact public-ABI/export facts,
  // never source bodies or FunctionPlans. Snapshot those facts before the
  // stage-8 region exit so that exit can release the complete analysis graph.
  const lateRest = []
  const lateExt = []
  const lateI64 = []
  const lateHostAbi = []
  const lateNamedExports = []
  const lateExportedNames = new Set()
  for (const f of ctx.funcs.list) {
    if (isExported(f)) lateExportedNames.add(f.name)
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
      const { p, r, m } = f._exportI64
      for (const exportName of exportNamesOf(f.name))
        lateI64.push(m ? { name: exportName, p, m } : r ? { name: exportName, p, r } : { name: exportName, p })
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
    const func = ctx.funcs.list.find(f => f.name === val)
    if (func) lateNamedExports.push(['export', `"${name}"`, ['func', `$${isBoundaryWrapped(func) ? val + '$exp' : val}`]])
    else if (ctx.scope.globals.has(val)) lateNamedExports.push(['export', `"${name}"`, ['global', `$${val}`]])
  }
  let lateFacts = {
    rest: lateRest,
    ext: lateExt,
    i64: lateI64,
    hostAbi: lateHostAbi,
    namedExports: lateNamedExports,
    userFuncs: new Set(ctx.funcs.list.map(f => `$${f.name}`)),
    exportedNames: lateExportedNames,
    funcCount: ctx.funcs.list.length,
    errorSidEntries: [...ctx.schema.errorSidEntries()],
    typedPins: null,
  }

  const __stdlibMark = regionHooks?.mark()
  timePhase(profiler, 'pullStdlib', () => pullStdlib(sec))
  ensureThrowRuntime(sec)
  lateFacts.errorSidEntries = [...ctx.schema.errorSidEntries()]
  lateFacts.typedPins = ctx.linkDemand.typedRuntime
    ? ['$__typed_idx', '$__typed_set_idx', '$__typed_idx_tagged', '$__typed_set_idx_tagged', '$__arr_typed_set_idx', '$__arr_typed_obj_set_idx']
      .filter(name => ctx.core.includes.has(name.slice(1)))
    : []
  if (regionHooks) {
    let lateScope = {
      globals: ctx.scope.globals,
      globalTypes: ctx.scope.globalTypes,
      userGlobals: ctx.scope.userGlobals,
      globalValTypes: ctx.scope.globalValTypes,
      globalTypedLen: ctx.scope.globalTypedLen,
      globalTypedElem: ctx.scope.globalTypedElem,
      staticArrs: ctx.scope.staticArrs,
      constFnArrays: ctx.scope.constFnArrays,
      dvArmFns: ctx.scope.dvArmFns,
    }
    let lateTypes = { arrResized: ctx.types.arrResized, nameEscapes: ctx.types.nameEscapes }
    // `namedUses` (plain {sid, funcName} pairs — module/core.js's
    // __throw_property_nullish and module/json.js's per-shape parsers push
    // onto it eagerly, unconditionally, for essentially every compile) MUST
    // ride along here: the usedSchemaIds walk a little further down this
    // function (`if (ctx.schema.namedUses.length) {...}`) reads it AFTER this
    // round's exit, unconditionally. Omitting it left `ctx.schema` narrowed to
    // `{list}` post-exit, so that later read threw `Cannot read properties of
    // undefined (reading 'length')` on EVERY region-live compile, including
    // the trivial single-function AGREE-tier corpus — this was the emitIR-
    // round crash this whole investigation chased (region-emitir-round
    // session, .work/archive/region-release-notes.md).
    let lateSchema = { list: ctx.schema.list, namedUses: ctx.schema.namedUses }
    // pullStdlib only mutates these section arrays. Root them individually;
    // traversing `sec` would also walk every already-durable user function,
    // turning a ~stdlib-only reclaim into a multi-gigabyte full-module copy.
    let lateSections = {
      start: sec.start,
      imports: sec.imports,
      memory: sec.memory,
      extStdlib: sec.extStdlib,
      stdlib: sec.stdlib,
      tags: sec.tags,
    }
    ;[lateSections, lateFacts, lateScope, lateTypes, lateSchema, ctx.transform, ctx.runtime, ctx.memory, ctx.core.includes, ctx.warnings] =
      emissionRoundExit(__stdlibMark, [lateSections, lateFacts, lateScope, lateTypes, lateSchema, ctx.transform, ctx.runtime, ctx.memory, ctx.core.includes, ctx.warnings],
        [DOLLAR_EXTERN, [stdlibParseCacheMap, setStdlibParseCacheMap]])
    sec.start = lateSections.start
    sec.imports = lateSections.imports
    sec.memory = lateSections.memory
    sec.extStdlib = lateSections.extStdlib
    sec.stdlib = lateSections.stdlib
    sec.tags = lateSections.tags
    ctx.scope = lateScope
    ctx.types = lateTypes
    ctx.schema = lateSchema
    ctx.funcs = { list: { length: lateFacts.funcCount } }
    __secRoot = sec
  }

  stripStaticDataPrefix(sec)

  timePhase(profiler, 'optimizeModule', () => optimizeModule(sec, profiler,
    regionHooks ? {
      mark: regionHooks.mark,
      exit: (mark, root) => emissionRoundExit(mark, root),
      forceExit: regionHooks.forceExit || regionHooks.exit,
    } : null))
  if (ctx.transform.helperCallsites) instrumentHelperCallsites([...sec.funcs, ...sec.stdlib, ...sec.start])

  // Fold constant `__start` global inits into immutable inline decls (drops the
  // store, and `__start` with it when that empties it). Runs HERE — after
  // stripStaticDataPrefix and optimizeModule — so any data-segment offset a hoisted
  // pointer carries is already in its final, shifted form (hoisting earlier would
  // freeze a pre-strip offset the shift pass never revisits in the global decl).
  hoistConstGlobalInits(sec)

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
  if (dataLen() && !ctx.memory.shared)
    sec.data.push(['data', ['i32.const', 0], '"' + escBytes(dataString()) + '"'])
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

  // Custom sections "jz:schema" / "jz:errcls" (object schemas + Error-class
  // sid→name map for JS-side interop) are built further down, AFTER the
  // treeshake() call — see the usedSchemaIds block just below it for why
  // (mint-vs-treeshake reconciliation, audit-evidenced size-gate fix).

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

  // Whole-module: prune funcs unreachable from entry points (start, exports, elem refs).
  // Removes orphan top-level consts that never get called (e.g. watr's unused `hoist` = 26 KB).
  // Also returns callCount Map (computed during the same walk — used below for funcidx sort).
  // Reachability walk always runs (callCount feeds the sort even when shake is off);
  // actual removal gated by ctx.transform.optimize.treeshake.
  const optCfg = ctx.transform.optimize
  const { callCount } = treeshake(
    [{ arr: sec.stdlib }, { arr: sec.funcs }, { arr: sec.start }],
    [...sec.start, ...sec.elem, ...sec.customs, ...sec.extStdlib, ...sec.imports, ...sec.tags],
    { removeDead: !optCfg || optCfg.treeshake !== false, globals: sec.globals, userGlobals: ctx.scope.userGlobals,
      userFuncs: lateFacts.userFuncs }
  )

  // Custom sections "jz:schema" / "jz:errcls": object schemas + Error-class
  // sid→name map, for JS-side interop (interop.js). Built HERE — after
  // treeshake, not before — because the MINT (module/schema.js's
  // ctx.schema.register/errorSid) and the SERIALIZE step can now legitimately
  // disagree: emitLengthAccess (module/core.js) and Array.from's general path
  // (module/array.js) mint 'TypeError' eagerly and unconditionally the moment
  // either is visited during emission (commit 8954dac2 — load-bearing, keeps
  // the schema minted before O0 catch/property planning freezes schema
  // tables; do not make this conditional). But a later pass can still
  // constant-fold away the one call that would have used it, or treeshake
  // above can remove the whole function around it — so by this point some
  // minted schema ids may have zero surviving constructors. Serializing
  // straight from ctx.schema.list/errorSidEntries (as before) shipped every
  // schema ever minted, dead or not — the audited size-gate regression
  // (aos/dotprod/wav/callback, e867c3af's opaque-length TypeError).
  //
  // A schema id is LIVE iff a surviving PTR.OBJECT construction still carries
  // it — determined from two EMISSION-TIME facts (ctx.js's ctx.schema doc),
  // not a post-hoc re-derivation:
  //
  //  1. mkPtrIR/boxPtrIR (src/ir.js), the only two places a PTR.OBJECT
  //     pointer is ever IR-constructed, stamp a `.schemaSid` property
  //     directly onto the node they return — additive metadata in the same
  //     family as `.type`/`.ptrKind`/`.ptrAux`, still a plain JS number, not
  //     yet a WAT string for anything downstream to reformat. Collected below
  //     by walking sec.stdlib/funcs/start/globals/elem — the SAME arrays,
  //     already treeshaken — checking one plain property per node. A
  //     construction whose sole containing function treeshake removed
  //     entirely is simply never visited; no separate reachability check
  //     needed for this, the overwhelming majority of PTR.OBJECT sites.
  //  2. ctx.schema.namedUses: the few hand-written WAT-text templates that
  //     build a `$__mkptr` call as a raw string instead of through mkPtrIR
  //     (module/core.js's __throw_property_nullish, module/json.js's
  //     per-shape __jp_shape_N parser) — no IR node exists to tag before
  //     that text is parsed, so each instead names the ONE stdlib function
  //     its construction lives inside; live iff that function, BY NAME,
  //     survived treeshake (checked below against the same surviving-name
  //     set the funcidx sort just below already needs).
  //
  // This replaced a WAT-AST scan (`scanMkptrAux`, audit-flagged wrong-level
  // architecture: "re-derives schema liveness by parsing WAT helper names and
  // packed hex literals") that walked the identical arrays POST-treeshake,
  // pattern-matching `f64.const`/`i64.const` operand STRINGS and
  // `$__mkptr`/`$__mkptr_*` call names to recover the SAME fact from OUTSIDE
  // — every one of those shapes existed only because mkPtrIR/boxPtrIR had
  // already built it from a number the scan then had to re-parse back out of
  // text. A recursive OBJECT param's re-box (narrow.js's applyPointerParamAbi
  // devirt — `chase`-shaped self-recursion) produced a fully-folded
  // `f64.const nan:...` literal the scan's own strict 16-hex-digit parser
  // rejected once self-hosted (dist/jz.wasm compiling this exact scan's own
  // source): correct natively, silently dead-marked a live schema self-
  // hosted-only. Tagging the node (or naming the function) where the id is
  // still a number sidesteps that whole class, and any WAT-text-string-shape
  // class after it, while staying exactly as post-treeshake-precise as the
  // scan it replaces — including the ORIGINAL size-gate case it was built for
  // (a schema whose sole constructor's containing function treeshakes away
  // entirely; test/objects.js's "dead opaque-length TypeError schema" pin).
  //
  // A dynamic clone/copy helper forwarding some OTHER value's already-tagged
  // type+aux (`local.get $sid`, not a literal — module/core.js's __obj_clone)
  // needs no separate accounting: it can only ever reproduce a sid some
  // OTHER, literal-bearing site already recorded for a value that must
  // already exist, so that other site is what makes it live. The generic
  // (non-shaped) JSON.parse path (module/json.js's __jp_obj/__jp_schema_get)
  // is a DIFFERENT case, not merely a dynamic forward: its `$sid` is a
  // wholly runtime-discovered schema number in its own runtime-only table
  // ($__schema_tbl/$__schema_next, keyed by the actual JSON text's key set),
  // never one of ctx.schema.list's compile-time ids — the old scan's own
  // litI32 aux check already fell through it identically (a `local.get`, not
  // a literal), so this is pre-existing, unchanged behavior, not a new gap.
  // specializeMkptr (src/optimize/index.js), which runs earlier in this same
  // compile, only ever REWRITES an existing literal-aux `call $__mkptr` (one
  // mkPtrIR already tagged) into a folded literal or a named `$__mkptr_T_A_d`
  // variant — it copies `.schemaSid` onto its replacement (see there), so it
  // mints no schema reference mkPtrIR didn't already tag, never a NEW one.
  // hoistConstantPool similarly replaces a repeated literal's call site with
  // a `global.get` — it too copies `.schemaSid` onto that replacement (see
  // there), so a hoisted schema-carrying literal stays visible to the walk
  // above even though its original node is gone. Over-approximating (treating
  // a schema as live when its only construction site later got treeshaken
  // out entirely) is always safe — it only costs bytes; under-approximating
  // would silently corrupt a live interop decode.
  const usedSchemaIds = new Set()
  {
    const collectSchemaTags = (n) => {
      if (!Array.isArray(n)) return
      if (n.schemaSid != null) usedSchemaIds.add(n.schemaSid)
      for (const c of n) collectSchemaTags(c)
    }
    for (const arr of [sec.stdlib, sec.funcs, sec.start, sec.globals, sec.elem]) for (const f of arr) collectSchemaTags(f)
    if (ctx.schema.namedUses.length) {
      const survivingNames = new Set()
      for (const arr of [sec.stdlib, sec.funcs, sec.start])
        for (const f of arr) if (Array.isArray(f) && f[0] === 'func' && typeof f[1] === 'string') survivingNames.add(f[1])
      for (const { sid, funcName } of ctx.schema.namedUses)
        if (survivingNames.has('$' + funcName)) usedSchemaIds.add(sid)
    }
  }
  if (usedSchemaIds.size) {
    // Positional format (entry index === schema id, no key per entry — see
    // STABILITY.md's "raw custom sections stay experimental": the byte FORMAT
    // is unchanged here, only which entries carry real content). A dead id's
    // slot must still be emitted, to keep every live id's position correct —
    // varint(nSchemas) below stays ctx.schema.list.length either way.
    //
    // NOT emitted empty (`[]`) — interop.js's own ingestion (enhance(), the
    // `newSchemas`/`schemas` merge loop) deduplicates incoming entries by
    // CONTENT (`s.join(',')`) before appending, then indexes the merged array
    // directly BY SID (`mem.schemas[aux(p)]`, decodeThrown's schema lookup).
    // `[].join(',')` is `''` for every dead entry alike, so two-plus zeroed
    // entries collide on that one key, the dedupe silently keeps only the
    // first and drops the rest, and EVERY live sid positioned after the first
    // collision then indexes the wrong (shifted) array slot — reproduced
    // exactly this way: the self-hosted kernel's own `Error`/`TypeError`/
    // `SyntaxError` schemas decoded fine in isolation (verified byte-for-byte
    // correct in the built jz:schema section) but the kernel oracle's
    // ambiguous-BOOL|NUMBER reject still lost its message, because some
    // OTHER dead schema earlier in its (825-entry) list collided with
    // another and shifted every later sid's runtime array position. A
    // one-element placeholder keyed by the id itself (`[String(id)]`) is
    // unique per dead entry — collides with nothing else dead, and
    // collision with a live entry is no more likely than any other
    // pre-existing content collision this dedupe already tolerates — while
    // still costing far fewer bytes than the real prop list it replaces.
    const bytes = []
    const utf8 = new TextEncoder()
    const varint = (n) => { while (n >= 0x80) { bytes.push((n & 0x7F) | 0x80); n >>>= 7 } bytes.push(n) }
    const enc = (p) => {
      if (p === null) bytes.push(0)
      else if (Array.isArray(p)) { bytes.push(1); enc(p[1]) }
      else { bytes.push(2); const b = utf8.encode(p); varint(b.length); for (const x of b) bytes.push(x) }
    }
    varint(ctx.schema.list.length)
    ctx.schema.list.forEach((props, id) => {
      const live = usedSchemaIds.has(id) ? props : [String(id)]
      varint(live.length); for (const p of live) enc(p)
    })
    sec.customs.push(['@custom', '"jz:schema"', bytes])
  }
  // jz:errcls has an explicit sid per entry (unlike jz:schema above), so a
  // dead class is simply omitted rather than zeroed.
  //
  // Reads `lateFacts.errorSidEntries` (an already-resolved ARRAY, captured
  // from `ctx.schema.errorSidEntries()` — a METHOD — before `__stdlibMark`'s
  // exit narrows `ctx.schema` to `lateSchema = {list, namedUses}`, which has
  // no such method), not `ctx.schema.errorSidEntries()` directly: that method
  // no longer exists post-narrowing, so re-calling it here silently produced
  // `undefined` (optional-chained away, not thrown) — no `jz:errcls` custom
  // section ever got emitted under region-live compiles, so `interop.js`'s
  // decodeThrown always missed the sid->class-name lookup and every
  // `new TypeError(...)`/`new SyntaxError(...)`/etc. reached the host as a
  // generic `Error("[object Object]")` — right fields (verified via
  // `e.thrown`: `{message, name}` both correct), wrong class/message
  // (region-emitir-round session, `.work/archive/region-release-notes.md`). Same
  // fix shape as `lateSchema.namedUses` just above: consume the
  // already-captured snapshot instead of re-deriving through a field this
  // round's narrowing removed.
  if (lateFacts.errorSidEntries.length) {
    const entries = lateFacts.errorSidEntries.filter(([sid]) => usedSchemaIds.has(sid))
    if (entries.length) {
      const bytes = []
      const utf8 = new TextEncoder()
      const varint = (n) => { while (n >= 0x80) { bytes.push((n & 0x7F) | 0x80); n >>>= 7 } bytes.push(n) }
      varint(entries.length)
      for (const [sid, name] of entries) {
        varint(sid)
        const b = utf8.encode(name)
        varint(b.length)
        for (const x of b) bytes.push(x)
      }
      sec.customs.push(['@custom', '"jz:errcls"', bytes])
    }
  }

  pruneUnusedThrowRuntime(sec)

  // WASI reactor `_initialize` conversion (the p1 ABI forbids WASI calls inside the wasm
  // start section — top-level console.log/Date.now crashed with "Cannot read properties of
  // null" since no host can service them before `new WebAssembly.Instance` finishes wiring
  // memory) used to run here, mutating `sec.start`/`sec.funcs` in place. It's target
  // legalization now (src/optimize/watr-tail.js legalizeForTarget), ported onto the fully
  // assembled `['module', …]` tree together with the command-entry rewrite above — see that
  // function's doc comment. `sec.start`'s `$__start` func and its `(start …)` directive are
  // left exactly as built here; legalizeForTarget finds `$__start` by name and does the
  // `_initialize` conversion + self-arming guard injection from there.

  // Reorder non-import funcs by call count: hot callees get low LEB128 indices.
  // `call $f` encodes funcidx as ULEB128 (1 B for idx < 128, 2 B for idx < 16384).
  // On watr self-compile this saves ~6 KB (hot specialized helpers migrate to idx < 128).
  // callCount was computed inline by treeshake's walk (same set of nodes).
  const byCalls = (a, b) => (callCount.get(b[1]) || 0) - (callCount.get(a[1]) || 0)
  const startFn = sec.start.find(n => n[0] === 'func')
  const startDir = sec.start.find(n => n[0] === 'start')
  const sortedFuncs = [
    ...sec.stdlib, ...sec.funcs, ...(startFn ? [startFn] : []),
  ].sort(byCalls)

  // BindingId suffixes off the WAT surface LAST — every internal pass keys
  // facts (distinctParams, boxed cells, alias bases) by the full renamed
  // spelling; stripping earlier desyncs those sets from the tokens (the
  // param-distinctness LICM pin caught exactly that). Display-only: binaries
  // carry no name section.
  stripLocalRenameSuffixes(sortedFuncs)

  // Assemble: named slots → flat section list.
  const sections = [
    ...sec.extStdlib, ...sec.imports, ...sec.types, ...sec.memory, ...sec.data,
    ...sec.tags, ...sec.table, ...sec.globals, ...sortedFuncs,
    ...sec.elem, ...(startDir ? [startDir] : []), ...sec.customs,
  ]
  let builtModule = ['module', ...sections]
  // Region-arena Slice 3 (union-field root, Slice C-v2 — `.work/archive/compile-
  // session-design.md` §2.1/§3, front.js's own doc has the full rationale):
  // exit the emit round here, rebinding `builtModule` (phase-local, not
  // durable ctx state) and every `ctx.*` field any round needs, including
  // both `ctx.func` AND `ctx.funcs` (see .work/evidence.md §Region arena for
  // the root-completeness requirement), without exposing `ctx.core`/
  // `ctx.bridge`/etc to the relocator, which don't need it. Any later read
  // through a stale `ctx.*` or the pre-relocation `builtModule` reference is
  // a use-after-free, the identical contract frontHalf's own rebind
  // documents.
  if (regionHooks?.releaseSession) {
    // The wasm-hosted compiler immediately feeds this module to the WAT tail;
    // it never observes analysis/session internals after compileAst returns.
    // Preserve only immutable optimizer facts and a compact boundary summary,
    // rather than copying every AST, FunctionPlan and analysis cache alongside
    // the already-large emitted module at the final region boundary.
    const cfg = ctx.transform.optimize
    const boundaryPins = [
      ...(cfg?._vectorizedFnNames?.size
        ? [...cfg._vectorizedFnNames].filter(name => lateFacts.exportedNames.has(name.slice(1)))
        : []),
      ...lateFacts.typedPins,
    ]
    let released = {
      transform: ctx.transform,
      funcs: { list: { length: lateFacts.funcCount } },
      scope: {
        globalValTypes: ctx.scope.globalValTypes,
        globalTypedLen: ctx.scope.globalTypedLen,
        globalTypedElem: ctx.scope.globalTypedElem,
        staticArrs: ctx.scope.staticArrs,
        constFnArrays: ctx.scope.constFnArrays,
        dvArmFns: ctx.scope.dvArmFns,
      },
      types: { arrResized: ctx.types.arrResized, nameEscapes: ctx.types.nameEscapes },
      schema: { list: ctx.schema.list },
      includes: ctx.core.includes,
      warnings: ctx.warnings,
      diagSink: ctx.core.diagSink,
      tail: { funcCount: lateFacts.funcCount, boundaryPins, targetProfile: ctx.transform.targetProfile },
    }
    ;[builtModule, released] = (regionHooks.finalExit || regionHooks.exit)(__regionMark, [builtModule, released])
    ctx.transform = released.transform
    ctx.funcs = released.funcs
    ctx.scope = released.scope
    ctx.types = released.types
    ctx.schema = released.schema
    ctx.core.includes = released.includes
    ctx.warnings = released.warnings
    ctx.core.diagSink = released.diagSink
    ctx.transform._regionTail = released.tail
  } else if (regionHooks) {
    [builtModule, ctx.func, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.transform, ctx.facts] =
      regionHooks.exit(__regionMark, [builtModule, ctx.func, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.transform, ctx.facts])
  }
  return builtModule
}
