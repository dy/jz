import parseWat from 'watr/parse'
import { ctx, PTR, LAYOUT, assertCtxInvariants } from '../ctx.js'
import { isBlockBody, isReassigned, returnExprs } from '../ast.js'
import { hasAmbiguousBoolMerge } from '../kind.js'
import { VAL, updateRep } from '../reps.js'
import { paramValTrustworthy } from '../param-reps.js'
import { i64Hex } from '../../layout.js'
import {
  typed, asF64, asI32, asPtrOffset, asParamType, ptrTypeEq, undefExpr,
  isUndef, dollar, tcoTailRewrite, applyBigintRepresentationAction,
} from '../ir.js'
import { restoreActiveFunction } from './active-function.js'
import { installFunctionPlan } from './function-plan.js'
import { makeMapOverlay } from './map-overlay.js'
import { emit, emitBlockBody, emitIdentitySafe, toBool } from './emit.js'
import { emitCharDecompPrologue } from '../abi/string.js'
import { representationReturnAction } from './representation-plan.js'
import { recordParamClosureDefault, recordDirectReturnClosure } from './dyn-closure-tables.js'
import { enterFunc, emitPreboxedLocalInits } from './func-entry.js'
import { isBoundaryWrapped } from './boundary-wrap.js'
import { hoistInvariantParamCoercions, hoistUnionCursorUnbox } from './coercion-hoist.js'
import { isExported } from './func-exports.js'

/**
 * Phase: emit one user function to WAT IR.
 *
 * Reads the published `FunctionPlan` and narrowed `func.sig`; applies scoped
 * schema param bindings during emission so they cannot leak between functions.
 */
export function emitFunc(func, functionPlan, programFacts) {
  // Raw WAT functions (e.g., _alloc, _clear from memory module)
  if (func.raw) return parseWat(func.raw)

  const { name, body, exported, sig } = func
  const multi = sig.results.length > 1
  const _reps = programFacts.programIndex.parameterAbiOf(func)

  const previousFrame = enterFunc(sig, body, { exported: isExported(func) })
  let schemaVarsPrev = null
  try {
  // Escape-boxing gate for return-position BOOL literals/expressions (emit.js
  // 'return'): a func with >= 2 syntactic return statements whose overall
  // valResult ISN'T proven uniformly BOOL may still have individual return
  // tails that ARE statically BOOL (a mixed BOOL|NUMBER — or BOOL|anything —
  // return join). Those callers see this func's result as "dynamic/unknown", and the
  // rest of the compiler already assumes an unknown f64 value carries a
  // boolean as its TRUE_NAN/FALSE_NAN atom (emitStrictEq's BOOL-vs-unknown
  // identity compare, '+'​'s numSide atom ladder, __to_num's atom arms) — so
  // the atom-typed return tail must box to honor that invariant.
  //
  // The >=2-return-statement guard is load-bearing, not cosmetic: a SINGLE
  // return statement whose valType narrowValResults couldn't prove early is
  // NOT evidence of mixing — it's just an early-unprovable UNIFORM result
  // (e.g. Set.has/Map.get's VAL.BOOL kind resolves only once ctx.schema.vars
  // is populated, later than narrowValResults' own pass). An earlier version
  // of this fix gated only on `valResult !== VAL.BOOL` and boxed these too —
  // it broke every single-return Set/Map/array-element boolean read in the
  // test suite: those funcs have no boundary-wrapper code path to UN-box
  // (isBoundaryWrapped's resultDynamic arm just reinterprets bits), so a lone
  // boxed return either surfaced as a decoded JS `true`/`false` where a raw
  // `1`/`0` was the established, separately-pinned contract (test/data.js
  // Set/Map alias tests, test/booleans.js's documented "bare boolean read
  // from a container" gap), or handed NaN straight to an un-wrapped caller.
  // Requiring a SECOND return statement restricts boxing to genuine syntactic
  // joins (≥2 `return` sites in one body) — exactly the boolconst repro's
  // shape — and leaves every real single-return function, provable or not,
  // untouched. ADDITIVE single-return admission (.work/archive/todo.md
  // §deletion-sweep): a single-expression arrow body whose lone return IS itself an
  // ambiguous BOOL-merge (`s => cond ? 1 : false`) is STRUCTURAL evidence of
  // genuine mixing, not "unproven" — categorically unlike the ≥2-return gate's
  // own concern (an early-unprovable UNIFORM result), so it's safe to admit
  // without reopening the reverted broad fix's timing hazard. This was
  // previously out of scope here (returnExprs on a non-block body is always
  // length 1) — see test/kernel-oracle.js's now-flipped s?1:false row.
  //
  // A proven-uniform-BOOL func (valResult === VAL.BOOL) also needs no
  // per-return boxing: its own escape sites (the boundary wrapper's
  // resultBool arm / the closure trampoline's boolResult arm) box the WHOLE
  // result once from valResult. carrierF64 itself is a no-op (byte-identical
  // to the prior asParamType/asF64) for any return whose OWN static valType
  // isn't BOOL, so a genuinely mixed func's NUMBER (or other) arms — and
  // every non-bool-mixed function, period — are untouched either way.
  ctx.func.valResult = func.valResult
  {
    const returns = isBlockBody(body) ? returnExprs(body) : [body]
    ctx.func.mixedAtomReturn = func.valResult !== VAL.BOOL &&
      (returns.length > 1 || (returns.length === 1 && hasAmbiguousBoolMerge(returns[0])))
  }
  // Only this path drains charDecomp prologues (collectParamInits below) —
  // the shape-1b global-receiver decomposition may mint only here.
  ctx.func.charDecompGlobals = true
  // FunctionPlan is an opaque identity; install returns one detached mutable
  // working copy and seeds the complete active record from it. Canonical plan
  // collections never leave function-plan.js.
  const installedPlan = installFunctionPlan(ctx, functionPlan)
  const block = installedPlan.block
  // emitDecl's closure-capture identity shadow (emit.js, ctx.func.
  // identityShadow — name → shadow-local name) is purely an EMISSION-tier
  // fact: minted and consumed entirely within this one emitFunc call (unlike
  // capturedNames above, it has no analysis-time source and needs no plan
  // publication) — but createActiveFunction's baseline record doesn't carry
  // it either, so it must start fresh here, not inherit whatever a sibling
  // function's emission left on a reused field.
  ctx.func.identityShadow = new Map()
  // Derive WAT-node metadata before call-site seeding mutates the active rep
  // map. This preserves the published analysis snapshot's exact semantics.
  const plannedCseLoadBases = installedPlan.cseLoadBases.size
    ? new Set([...installedPlan.cseLoadBases].map(n => `$${n}`)) : null
  const plannedDistinctParams = installedPlan.distinctParams?.size
    ? new Set([...installedPlan.distinctParams].map(n => `$${n}`)) : null
  let plannedStableHeaderNames = null
  if (installedPlan.localReps?.size) {
    const names = new Set()
    for (const [nm, r] of installedPlan.localReps)
      if (r && (r.val === VAL.TYPED || r.neverGrown === true)) names.add(`$${nm}`)
    if (names.size) plannedStableHeaderNames = names
  }
  // Global-table fallback for a plan published before global typed lengths
  // settled. The active record owns the resulting overlay.
  if (!ctx.func.typedLen && ctx.scope.globalTypedLen) ctx.func.typedLen = makeMapOverlay(ctx.scope.globalTypedLen)

  // D: Apply call-site param facts (only if body analysis didn't already set them).
  // Schema bindings additionally write into ctx.schema.vars so prop-access dispatch
  // hits the slot map. ctx.schema.vars is saved/restored so bindings don't leak.
  // MapOverlay instead of a clone (same jz×jz-ceiling fix as typedElem/typedLen
  // above and emitClosureBody's own doc): this used to be `new Map(ctx.schema.
  // vars)` — an O(programSize) clone of the WHOLE-PROGRAM schema table, paid once
  // per function in emitFuncs' driver loop. `own` starts empty; the `.set` calls
  // below (unchanged) write this function's own param-schema bindings into it;
  // restoring below is the identical "re-point the ctx field back" the overlay
  // doc already establishes, now O(1) instead of O(programSize) either direction.
  schemaVarsPrev = ctx.schema.vars
  ctx.schema.vars = makeMapOverlay(schemaVarsPrev)
  if (_reps) {
    for (const [k, r] of _reps) {
      if (k >= sig.params.length) continue
      const pname = sig.params[k].name
      // Same entry-vs-body-reassignment hazard analyzeFuncForEmit guards against
      // (see its comment): r.val/r.typedCtor/r.schemaId describe the CALLER's
      // argument, sound only while the body never writes the name. This step
      // duplicates that seeding (FunctionPlan.localReps already carries whatever
      // analyzeFuncForEmit settled, guarded — but re-applying the UNGUARDED
      // call-site fact here would undo it) so it needs the identical guard.
      const reassigned = isReassigned(body, pname)
      // paramValTrustworthy: `r.val` and `r.possibleKinds` are independent
      // lattices over the same call sites (param-reps.js's own header) — a
      // parameter fed by a mix of easily-proven and unresolved-argument call
      // sites (e.g. a compiler-internal helper whose receiver sometimes comes
      // from a plain literal, sometimes from an array-element read whose own
      // kind this fixpoint's `val` meet never got to observe) can settle
      // `val` to a single, UNCHALLENGED kind from the one site that WAS
      // provable, while `possibleKinds`' own wider census (closed coverage:
      // every site enumerated) proves the parameter is genuinely polymorphic.
      // Trusting `val` alone there hardcodes a receiver type tag
      // (emitTypeTag, src/ir.js) that's wrong for every other-kinded call —
      // fix/selfhost-hash-read's own root cause (a HASH-representation
      // parameter compiled with an unconditionally-hardcoded PTR.OBJECT tag).
      if (r.val && !reassigned && paramValTrustworthy(r) && !ctx.func.localReps?.get(pname)?.val) updateRep(pname, { val: r.val })
      // presentVal: mirrors the analyzeFuncForEmit seeding above (see its comment) —
      // same guard, same duplication reason.
      if (r.presentVal && !reassigned && !ctx.func.localReps?.get(pname)?.presentVal) updateRep(pname, { presentVal: r.presentVal })
      // recvArrTyped: mirrors the analyzeFuncForEmit seeding above (see its comment).
      if (r.recvArrTyped && !reassigned) updateRep(pname, { recvArrTyped: true })
      if (r.typedCtor && !reassigned) {
        if (!ctx.func.typedElem) ctx.func.typedElem = new Map()
        if (!ctx.func.typedElem.has(pname)) ctx.func.typedElem.set(pname, r.typedCtor)
        if (!ctx.func.localReps?.get(pname)?.val) updateRep(pname, { val: VAL.TYPED })
        if (r.typedLen != null) {
          if (!ctx.func.typedLen) ctx.func.typedLen = new Map()
          if (!ctx.func.typedLen.has(pname)) ctx.func.typedLen.set(pname, r.typedLen)
        }
      }
      // lenBoundOf: mirrors the analyzeFuncForEmit seeding above (see its
      // comment) — same "already validated, no extra reassigned guard
      // needed" reasoning, same duplication reason.
      if (r.lenBoundOf != null) {
        const recvName = sig.params[r.lenBoundOf]?.name
        if (recvName != null) {
          if (!ctx.func.lenBoundOf) ctx.func.lenBoundOf = new Map()
          if (!ctx.func.lenBoundOf.has(pname)) ctx.func.lenBoundOf.set(pname, recvName)
        }
      }
      if (r.schemaId != null && !reassigned && !exported && !ctx.schema.vars.has(pname)) {
        ctx.schema.vars.set(pname, r.schemaId)
        updateRep(pname, { schemaId: r.schemaId })
      }
    }
  }

  const fn = ['func', `$${name}`]
  // Stamp the emit-side CSE, alias, and stable-header facts captured from the
  // detached install snapshot above. Watr ignores these non-index expandos.
  if (plannedCseLoadBases) fn.cseLoadBases = plannedCseLoadBases
  if (plannedDistinctParams) fn.distinctParams = plannedDistinctParams
  if (plannedStableHeaderNames) fn.stableHeaderNames = plannedStableHeaderNames
  // Inline `(export ...)` attribute only for the syntactic inline-export
  // form (`export function foo`, snapshot in `func.exported` at defFunc
  // time). Re-exports (`function foo; export { foo }`) and aliases (`export
  // { foo as bar }`) flow through sec.customs below — emitting an inline
  // attribute under the internal symbol would collide with the customs
  // entry on the same name, or leak the internal symbol publicly.
  // Boundary-wrapped exports also defer the attribute to the synthesized
  // wrapper ($${name}$exp) that reboxes the narrowed result back to f64.
  if (exported && !isBoundaryWrapped(func)) fn.push(['export', `"${name}"`])
  fn.push(...sig.params.map(p => ['param', dollar(p.name), p.type]))
  fn.push(...sig.results.map(t => ['result', t]))

  // Default params: ES spec says default applies only when arg is `undefined`
  // (or missing). `null`, `0`, `false`, etc. all skip the default.
  // Emitted here (registers any `charCodeAt` decomposition the default's
  // initializer triggers) but keyed by param name — final ordering vs the
  // charDecomp prologue is resolved in `collectParamInits` below.
  const defaults = func.defaults || {}
  const defaultInits = new Map()
  for (const [pname, defVal] of Object.entries(defaults)) {
    const p = sig.params.find(p => p.name === pname)
    // jsstring-carrier params with string-literal defaults skip wasm-side
    // substitution — the interop wrapper applies the default JS-side (the
    // value rides through `jz:extparam`). The wasm side never sees a null
    // externref so no `ref.is_null` branch is needed.
    if (p?.jsstring && p.jsstringDefault != null) continue
    const t = p?.type || 'f64'
    // emit(defVal) ONCE, before branching on t — same self-compile miscompile class as
    // emit.js's 'return' handler. See .work/archive/todo.md (groundtruth archive).
    const emittedDefVal = emit(defVal)
    // dyn-closure-tables.js: a default value that's provably a closure literal
    // (e.g. subscript's `dispatch(ops, tail, fn = (a, …) => {…})`) is the fact
    // proveClosureFactory needs to see through `dispatch`'s forwarded return.
    recordParamClosureDefault(name, pname, emittedDefVal)
    defaultInits.set(pname,
      ['if', isUndef(typed(['local.get', `$${pname}`], 'f64')),
        ['then', ['local.set', `$${pname}`, t === 'f64' ? asF64(emittedDefVal) : asI32(emittedDefVal)]]])
  }

  // Box params that are mutably captured: allocate cell, copy param value
  const boxedParamInits = []
  ctx.func.preboxed = new Set()
  const paramNames = new Set(sig.params.map(p => p.name))
  for (const p of sig.params) {
    if (ctx.func.boxed.has(p.name)) {
      const cell = ctx.func.boxed.get(p.name)
      ctx.func.locals.set(cell, 'i32')
      ctx.func.preboxed.add(p.name)
      const lget = typed(['local.get', `$${p.name}`], p.type)
      if (p.ptrKind != null) lget.ptrKind = p.ptrKind
      boxedParamInits.push(
        ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
        ['f64.store', ['local.get', `$${cell}`], asF64(lget)])
    }
  }
  // Remaining boxed locals (non-params) get a fresh null-init cell.
  const preboxedLocalInits = emitPreboxedLocalInits(name => paramNames.has(name))

  // Drain `ctx.func.charDecomp` after body emit: any param `charCodeAt` use
  // registered a decomposition request that needs a function-entry prologue
  // initialising its four i32 locals (base / len / sso / loadbase). Locals
  // themselves were already added to `ctx.func.locals` during emit so they
  // appear in the local-decl block below.
  //
  // Interleave with the per-param default inits in `sig.params` order so each
  // param's prologue runs *after* that param's own default init (the prologue
  // reads the param's final value) and *before* any later param's default
  // init — a default like `c = op.charCodeAt(0)` must see `op`'s prologue
  // locals already populated, else its bounds check reads len=0 and the
  // in-bounds char wrongly decodes as the OOB NaN.
  const collectParamInits = () => {
    const inits = []
    // Global-receiver decompositions (shape 1b) come first: a param default
    // like `(c = cur.charCodeAt(0))` must see the global's prologue locals
    // populated. Globals are readable at entry, so nothing precedes them.
    if (ctx.func.charDecomp) for (const dec of ctx.func.charDecomp.values())
      if (dec.global) inits.push(...emitCharDecompPrologue(dec))
    // Hoisted method-override probes (emit.js tryGenericEmitter): the probe's
    // answer is loop-invariant for a stable-global receiver — resolve it once.
    // Mirrors sidecarOverride's arm: primitives (real numbers, strings) can
    // never carry an own override, so only NaN-boxed non-STRING receivers probe.
    // Function-invariant typed lens (module/typedarray.js leanLen): a stable
    // PARAM receiver's element count, shared by every checked read/write guard.
    if (ctx.func.lenHoist) for (const h of ctx.func.lenHoist.values())
      inits.push(['local.set', `$${h.t}`, h.init])
    if (ctx.func.probeHoist) for (const ph of ctx.func.probeHoist.values()) {
      const g = () => ['i64.reinterpret_f64', ph.recvIR()]
      inits.push(
        ['local.set', `$${ph.ovr}`, ['if', ['result', 'f64'],
          ['i32.and',
            ['f64.ne', ph.recvIR(), ph.recvIR()],
            ['i64.ne',
              ['i64.and', g(), ['i64.const', i64Hex(BigInt(LAYOUT.TAG_MASK) << BigInt(LAYOUT.TAG_SHIFT))]],
              ['i64.const', i64Hex(BigInt(PTR.STRING) << BigInt(LAYOUT.TAG_SHIFT))]]],
          ['then', ['f64.reinterpret_i64', ['call', '$__dyn_get_expr', g(), ph.keyIR()]]],
          ['else', undefExpr()]]],
        ['local.set', `$${ph.is}`, ptrTypeEq(['local.get', `$${ph.ovr}`], PTR.CLOSURE)])
    }
    for (const p of sig.params) {
      const di = defaultInits.get(p.name)
      if (di) inits.push(di)
      const dec = ctx.func.charDecomp?.get(p.name)
      if (dec) inits.push(...emitCharDecompPrologue(dec))
    }
    return inits
  }

  ctx.func.repsFrozen = true   // FunctionPlan freeze: body emission begins — durable reps read-only
  assertCtxInvariants('pre-emit')
  if (block) {
    const stmts = emitBlockBody(body)
    // Hoist loop-invariant `__to_num(param)` coercions to a single entry rebind.
    const numCoerceInits = hoistInvariantParamCoercions(stmts, func)
    const cursorUnboxInits = hoistUnionCursorUnbox(stmts, func)
    const paramInits = collectParamInits()
    for (const [l, t] of ctx.func.locals) fn.push(['local', dollar(l), t])
    // I: Skip trailing fallback when last statement is return (unreachable code)
    const lastStmt = stmts.at(-1)
    const endsWithReturn = lastStmt && (lastStmt[0] === 'return' || lastStmt[0] === 'return_call')
    // Implicit fall-through return is `undefined` per JS spec, not 0 — same as
    // the closure path below. A reachable fall-through forces an f64 result
    // (it must carry undefined); concretely-typed results keep the `.const 0`
    // form since they can only be reached via explicit typed returns.
    const fallthrough = endsWithReturn ? []
      : sig.results.length === 1 && sig.results[0] === 'f64' ? [undefExpr()]
      : sig.results.map(t => [`${t}.const`, 0])
    fn.push(...paramInits, ...boxedParamInits, ...preboxedLocalInits, ...numCoerceInits, ...cursorUnboxInits, ...stmts, ...fallthrough)
  } else if (multi && body[0] === '[') {
    const values = body.slice(1).map(e => asF64(emit(e)))
    const paramInits = collectParamInits()
    for (const [l, t] of ctx.func.locals) fn.push(['local', dollar(l), t])
    fn.push(...paramInits, ...boxedParamInits, ...preboxedLocalInits, ...values)
  } else {
    // Top-level twin of emitFunc's 'return'-statement mixedAtomReturn admission
    // and emitClosureBody's expression-body site: a non-block arrow body
    // (`g = (s) => s ? 1 : false`) is this function's ENTIRE result, emitted
    // here directly rather than through the 'return' handler. An ambiguous
    // BOOL-merge body needs emitIdentitySafe in place of plain `emit` for the
    // same reason as those two sites — the merge's own valTypeOf already
    // collapsed to NUMBER, so a post-hoc box (there is none on this path
    // today) would be powerless; the box has to happen while the merge's own
    // arms are still separately known (.work/archive/todo.md §deletion-sweep).
    // Guarded on sig.results[0] === 'f64': a proven-uniform-BOOL (or numeric)
    // result already narrows to i32 and needs no boxing here (the boundary
    // wrapper's own resultBool arm handles that crossing).
    const resultBool = func.valResult === VAL.BOOL && sig.ptrKind == null && sig.results[0] === 'i32'
    const ambiguous = sig.ptrKind == null && sig.results[0] === 'f64' && hasAmbiguousBoolMerge(body)
    // A uniformly boolean expression body crosses an i32 ABI as truthiness,
    // not ToInt32 of its temporary f64 carrier. Choose toBool before emission
    // so effects still execute once and short-circuit order stays intact.
    let ir = resultBool ? toBool(body) : ambiguous ? emitIdentitySafe(body) : emit(body)
    if (!resultBool)
      ir = applyBigintRepresentationAction(ir, body, representationReturnAction(ctx, body))
    // dyn-closure-tables.js: an expression-bodied function whose return value
    // is unconditionally a closure literal (e.g. `mk = (n) => (x) => x + n`) —
    // a direct-return closure factory, no defaulted-param indirection needed.
    recordDirectReturnClosure(name, ir)
    // Final carrier conversion can allocate a temp (for example ToInt32's
    // evaluate-once Infinity guard). Build it before freezing the local
    // declarations, just like default and parameter prologues above.
    const finalIR = resultBool ? ir
      : sig.ptrKind != null ? asPtrOffset(ir, sig.ptrKind) : asParamType(ir, sig.results[0])
    const paramInits = collectParamInits()
    for (const [l, t] of ctx.func.locals) fn.push(['local', dollar(l), t])
    fn.push(...paramInits, ...boxedParamInits, ...preboxedLocalInits, tcoTailRewrite(finalIR, sig.results[0]))
  }

  return fn
  } finally {
    if (schemaVarsPrev) ctx.schema.vars = schemaVarsPrev
    restoreActiveFunction(ctx, previousFrame)
  }
}
