/**
 * Signature narrowing: the whole-program facts of each function's parameters
 * and results, then the ABI they license (an i32 parameter, an unboxed
 * pointer, a narrowed result).
 *
 * The value channels (`val`, `schemaId`, `typedCtor`, the array element
 * facts, the kind set) are the program summary's (src/summary): a parameter's
 * kind at entry is the join of its arguments at every direct call, and
 * `seedParamKinds` copies it onto the parameter record. The remaining
 * channels are call-site lattices over `programFacts.callSites`: the wasm
 * type (i32 for integer arguments), integer constants, static lengths, length
 * bounds and element ranges, which one range domain replaces (PLAN.md step
 * 3), and the closed schema unions (`schemaIdSet`, `arrayElemSchemaSet`).
 *
 * Reads programFacts.callSites plus ProgramIndex address-taken facts; mutates
 * sig.params/results, func.valResult, and programFacts.paramReps. Pure w.r.t.
 * the AST: only function `sig` records change.
 *
 * @module compile/narrow/index
 */

import { DBG_INVARIANTS } from '../../debug.js'
import { ctx, err } from '../../ctx.js'
import { withTypedElemOverlay } from '../flow-state.js'
import { I32_MIN, I32_MAX } from '../../ir.js'
import { staticArrayLen } from '../../static.js'
import { exprType, typedElemCtor, typedStaticLen } from '../../type.js'
import { VAL } from '../../reps.js'
import { ctorFromElemAux } from '../../../layout.js'
import { K, tagOf, paramOf, valOf, valsOf, hasTag, core, UNKNOWN } from '../../summary/index.js'
import { paramFactsOf, ensureParamRep, mergeParamFact, latticeMeet } from '../../param-reps.js'
import { inferArrElemSchemaSet } from '../infer.js'
import { RECUR_INT_OPS, assertValKindConsistent, buildCallerTypedLenCtx, resetParamWasmFacts, createPhaseState } from './caller-ctx.js'
import { applyI32ParamSpecialization, validateTypedLenParams, validateLenBoundOfParams, validateIntConstParams, applyPointerParamAbi, narrowableFuncs, applyTypedPointerParamAbi } from './param-abi.js'
import { narrowI32Results, seedResultKinds, narrowPointerResults, narrowReturnArrayElemSets } from './results.js'
import { inferInternalArrayLengths, inferTypedValueRanges, boundedByCallerLength } from './summaries.js'
import { jsstringEnabled, applyJsstringBoundaryCarrier } from './jsstring-carrier.js'
import { isExported } from '../func-exports.js'

/** The summary's kinds onto the parameter records of every function the
 *  call-site lattices see (a direct callee neither the host nor a value holder
 *  calls): the entry kind's value kind, schema, typed constructor and element
 *  facts, its tag set as `possibleKinds`, its NULLISH tag as `nullable`, its
 *  ABSENT tag as presence. A parameter never bound has no record, as before. */
function seedParamKinds(paramReps, addressTaken) {
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw || isExported(func) || addressTaken.has(func.name)) continue
    const summary = ctx.summary.at(func.sig)
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (let k = 0; k < func.sig.params.length; k++) {
      if (k === restIdx) continue
      const kd = summary.paramKindOf(func.sig.params[k].name), t = tagOf(kd), p = paramOf(kd)
      if (t === K.NONE) continue
      const r = ensureParamRep(paramReps, func.name, k)
      r.possibleKinds = new Set(valsOf(kd))
      const nullable = hasTag(kd, K.NULLISH) || hasTag(kd, K.ABSENT)
      r.presentVal = nullable ? valOf(core(kd)) ?? undefined : undefined
      r.mayBeUndefined = nullable
      r.presence = nullable ? 'maybe-undef' : 'present'

      // A kind some argument makes nullish carries no value fact (the callee's
      // reads stay dynamic and its nullish tests live), except BIGINT: its i64
      // bits carry no tag, so the kind holds and the parameter is nullable
      // beside it. A kind absent on a path the program does not mean to take
      // (an element past the end, a binding before its assignment) keeps its
      // facts, and the reads that test for it stay live through presence;
      // not for BIGINT, whose absent update the representation plan rejects
      // into f64 arithmetic (ledger-correctness.md 9, open).
      if (hasTag(kd, K.NULLISH)) { r.nullable = true; if (t === K.BIGINT) r.val = VAL.BIGINT; continue }
      if (hasTag(kd, K.ABSENT) && t !== K.BIGINT) { r.mayBeUndefined = true; r.presence = 'maybe-undef' }
      r.val = valOf(core(kd))
      if (t === K.OBJECT && p !== UNKNOWN) r.schemaId = p
      if (t === K.TYPED) r.typedCtor = p !== UNKNOWN ? ctorFromElemAux(p) : null
      if (t === K.ARRAY) {
        // The element facts likewise: an element absent on a path the program does not take keeps its kind.
        const e = summary.elemOfKind(kd)
        if (!hasTag(e, K.NULLISH)) {
          if (tagOf(e) === K.OBJECT && paramOf(e) !== UNKNOWN) r.arrayElemSchema = paramOf(e)
          const ev = valOf(core(e))
          if (ev != null) { r.arrayElemValType = ev; if (hasTag(e, K.ABSENT)) r.arrayHoles = true }
        }
      }
      // module/array.js's numeric-key receiver guard (reps.js recvArrTyped): every argument an array or a typed array.
      if (valsOf(kd).every(v => v === VAL.ARRAY || v === VAL.TYPED)) r.recvArrTyped = true
    }
  }
}

export default function narrowSignatures(programFacts, ast) {
  const { callSites, paramReps } = programFacts
  const addressTaken = programFacts.programIndex.addressTaken

  // Callee-indexed view of `callSites` (compacted to the reachable set by the
  // plan driver, which also ran the export ABI and the summary this reads).
  const sitesByCallee = new Map()
  for (const cs of callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  // Own-default typed annotation: `(arr = new Int32Array(0)) => …` self-declares
  // the param's element ctor — the ONLY evidence a host-called export can carry
  // (no call sites to lattice over; Workers v1 SPMD kernels are exactly this
  // shape). A WEAK seed: set only at BOTTOM, so the summary's fact below
  // overrides it. Runtime safety for Atomics receivers is the tag+elem
  // guard in __atomics_addr (module/atomics.js) — a wrong host arg throws.
  for (const func of ctx.funcs.list) {
    if (!func.sig?.params || !func.defaults) continue
    for (let k = 0; k < func.sig.params.length; k++) {
      const d = func.defaults[func.sig.params[k].name]
      if (Array.isArray(d) && d[0] === '()' && typeof d[1] === 'string' &&
          d[1].startsWith('new.') && d[1].endsWith('Array')) {
        const r = ensureParamRep(paramReps, func.name, k)
        if (r.typedCtor === undefined) r.typedCtor = d[1]
      }
    }
  }
  seedParamKinds(paramReps, addressTaken)
  seedResultKinds()
  const funcsWithNarrowableResult = narrowableFuncs(addressTaken)

  // Per-caller analysis is stable across fixpoint iterations — precompute once.
  // callerCtx[null] (top-level) uses module globals for locals.
  const phase = createPhaseState()
  const { callerCtx } = phase
  const typedValueRanges = inferTypedValueRanges(paramReps)
  const internalArrayLengths = inferInternalArrayLengths(paramReps)
  programFacts.arrayLengths = internalArrayLengths.locals
  programFacts.arrayCapacities = internalArrayLengths.capacities
  const intConstArg = (arg) => {
    let raw = null
    if (typeof arg === 'number') raw = arg
    else if (Array.isArray(arg) && arg[0] == null && typeof arg[1] === 'number') raw = arg[1]
    else if (Array.isArray(arg) && arg[0] === 'u-' && typeof arg[1] === 'number') raw = -arg[1]
    else if (typeof arg === 'string' && ctx.scope.constInts?.has(arg)) raw = ctx.scope.constInts.get(arg)
    return (raw != null && Number.isInteger(raw) && raw >= I32_MIN && raw <= I32_MAX) ? raw : null
  }

  // Per-call-site inference context for a narrowable callee. Rules consume it
  // synchronously and never retain it, so reuse one stable record and one Map
  // across every sweep (a fresh record per site was the largest HASH-sidecar
  // source in self-hosted narrowing).
  const paramFactsCache = new Map()
  const paramNamesByFunc = new Map()
  let sharedSiteState
  const callerParamFacts = key => {
    const callerFunc = sharedSiteState.callerFunc
    if (!paramFactsCache.has(key)) paramFactsCache.set(key, paramFactsOf(paramReps, callerFunc, key))
    return paramFactsCache.get(key)
  }
  sharedSiteState = {
    callee: undefined, callerFunc: undefined, argList: undefined, func: undefined, restIdx: -1,
    callerLocals: undefined, callerSummary: undefined,
    callerParamFacts,
    // runArrElemFixpoint mutates these named context channels in place.
    callerElems: undefined, paramFacts: undefined,
    calleeParamNames: undefined, _teOverlay: null, _lastArgMiss: false,
  }
  const siteState = cs => {
    const { callee, argList, callerFunc } = cs
    const func = ctx.funcs.map.get(callee)
    if (!func || isExported(func) || addressTaken.has(callee)) return null
    const ctxEntry = callerCtx.get(callerFunc)
    if (!ctxEntry) return null
    paramFactsCache.clear()
    sharedSiteState.callee = callee
    sharedSiteState.callerFunc = callerFunc
    sharedSiteState.argList = argList
    sharedSiteState.func = func
    sharedSiteState.restIdx = func.rest ? func.sig.params.length - 1 : -1
    sharedSiteState.callerLocals = ctxEntry.callerLocals
    sharedSiteState.callerSummary = ctx.summary.at(callerFunc?.sig)
    let paramNames = paramNamesByFunc.get(func)
    if (!paramNames) {
      paramNames = new Set(func.sig.params.map(p => p.name))
      paramNamesByFunc.set(func, paramNames)
    }
    sharedSiteState.calleeParamNames = paramNames
    sharedSiteState.callerElems = undefined
    sharedSiteState.paramFacts = undefined
    sharedSiteState._teOverlay = null
    sharedSiteState._lastArgMiss = false
    return sharedSiteState
  }
  // Per-site rule application, shared by the sweeping lattice runner and the worklist fixpoint.
  const applySiteRules = (state, rules) => {
    const { func, argList } = state
    const recursive = state.callee === state.callerFunc?.name
    for (let k = 0; k < func.sig.params.length; k++) {
      const r = ensureParamRep(paramReps, state.callee, k)
      if (k >= argList.length) { for (const rule of rules) rule.missing(r, k, state); continue }
      const arg = argList[k]
      // Recursive identity arg — `f(…, p, …)` calling itself with its own param p threaded
      // through at the same position — is a fixpoint identity: it carries whatever type p
      // settles to, so it constrains nothing. Skip it, else exprType(p) reads p's not-yet-
      // narrowed f64 and the meet poisons the type the non-recursive call sites would prove
      // (nqueens' `solve(all, …)` — `all` stuck f64 while cols/d1/d2, passed as i32 bitwise
      // exprs, narrowed fine).
      const pname = func.sig.params[k].name
      if (recursive && (arg === pname || (Array.isArray(arg) && arg[0] === 'local.get' && arg[1] === pname))) continue
      for (const rule of rules) rule.apply(r, arg, k, state)
    }
  }
  const runCallsiteLattice = (rules) => {
    for (let s = 0; s < callSites.length; s++) {
      const state = siteState(callSites[s])
      if (!state) continue
      applySiteRules(state, rules)
    }
  }

  const poison = field => r => { if (r[field] !== null) { r[field] = null; latticeMeet.changed = true } }
  // Substitute the default expression for a missing positional arg, so
  // `uleb(n)` doesn't poison buffer's facts despite `buffer = []` provably
  // yielding VAL.ARRAY at runtime.
  const defaultArg = (state, k) => {
    const pname = state.func.sig.params[k]?.name
    return pname != null ? state.func.defaults?.[pname] : null
  }
  // `soft` makes apply treat a null inference as BOTTOM (skip — "this site can't
  // tell yet") instead of TOP (poison): the monotone meet. `missing` poisons
  // regardless — an omitted arg with no default is undefined at runtime, a real
  // reason not to specialize, and must stay sticky.
  const mergeRule = (field, infer, soft = false) => ({
    missing(r, k, state) {
      if (r[field] === null) return
      const def = defaultArg(state, k)
      if (def != null) mergeParamFact(r, field, infer(def, k, state))
      else { r[field] = null; latticeMeet.changed = true }
    },
    apply(r, arg, k, state) {
      if (r[field] === null) return
      const v = infer(arg, k, state)
      if (v == null) { if (!soft) { r[field] = null; latticeMeet.changed = true } return }
      mergeParamFact(r, field, v)
    },
  })
  // WASM type of a call arg. exprType resolves most shapes, but an INTEGER typed-array
  // element read `intArr[idx]` (and arithmetic over it, `intArr[idx]+1`) types f64 here:
  // exprType's `[]` rule reads the typedElem OVERLAY, which does not know the caller's
  // typed bindings at fixpoint time — yet the element is a 32-bit machine integer. Install
  // the summary's typed constructors of the caller's scope as that overlay for the duration
  // of the type query, so a param fed only such integer elements (dict's key `k` ← src[i],
  // threaded through Math.imul / === keys[h] / keys[h]=k) narrows to i32 instead of paying
  // convert + f64-compare + trunc round-trips through its probe loop.
  // A value built ONLY from the callee's own params + already-i32 locals + integer constants via
  // integer-preserving ops. Its i32-ness follows from its inputs' — for a recursive self-call it
  // carries no INDEPENDENT evidence about whether the params are i32. Used for the optimism below.
  const isRecurIntExpr = (n, pnames, callerLocals) => {
    if (typeof n === 'string') return pnames.has(n) || callerLocals?.get?.(n) === 'i32'
    if (typeof n === 'number') return Number.isInteger(n)
    if (!Array.isArray(n)) return false
    if (n[0] == null) return typeof n[1] === 'number' && Number.isInteger(n[1])           // boxed int literal
    if (n[0] === 'local.get') return pnames.has(n[1]) || callerLocals?.get?.(n[1]) === 'i32'
    if (RECUR_INT_OPS.has(n[0])) return n.slice(1).every(c => isRecurIntExpr(c, pnames, callerLocals))
    return false
  }
  const summaryTypedElems = (summary) => ({ size: 1, has: (n) => summary.typedCtorOf(n) != null, get: (n) => summary.typedCtorOf(n) })
  const argWasmType = (arg, state) => {
    // Recursive self-call: an arg built only from the callee's own params + already-i32 locals +
    // int constants (`f(n - 1)`, `f(n - 1 - i)`) is i32 IFF those params are i32 — a fixpoint
    // identity carrying no INDEPENDENT type evidence. Optimistically type it i32 so the NON-
    // recursive call sites decide: all i32 ⇒ the param narrows; any f64 ⇒ the meet still poisons
    // it. Lets a plain decreasing recursion narrow with no `|0` source crutch. (The bare-identity
    // arg `f(n)` is already skipped wholesale in runCallsiteLattice.)
    if (state.callee === state.callerFunc?.name &&
        isRecurIntExpr(arg, state.calleeParamNames, state.callerLocals)) return 'i32'
    if (!state._teOverlay) state._teOverlay = summaryTypedElems(state.callerSummary)
    const wt = withTypedElemOverlay(state._teOverlay, () => exprType(arg, state.callerLocals))
    // An i32-typed BARE NAME that carries a POINTER kind in the caller (a local
    // or param already narrowed to an unboxed i32 offset) is NOT integer
    // evidence: narrowing the callee's param to plain i32 on it makes every
    // callee read widen the raw offset NUMERICALLY (f64.convert_i32_s) — the
    // pointer arrives as a small number and every prop probe silently misses
    // (this ate `Promise.any(obj)`'s GetIterator through __p_any → __p_list).
    // Report the boxed f64 lane instead; only applyPointerParamAbi — which
    // stamps ptrKind/ptrAux so reads REBOX — may unbox pointer params.
    if (wt === 'i32' && typeof arg === 'string') {
      const t = tagOf(state.callerSummary.kindOf(arg))
      if (t !== K.NONE && t !== K.ANY && t !== K.NUMBER && t !== K.BOOL) return 'f64'
    }
    return wt
  }
  const fixpointRules = [
    {
      missing: poison('wasm'),
      apply(r, arg, _k, state) {
        // Positive maybe-miss evidence rides to the param: emit flags it
        // maybeNullish so arithmetic coerces the UNDEF box (NaN), and the rep
        // turns nullable. Distinct from the unknown-caller nullable — only
        // proven-possible misses pay the coercion.
        if (r.wasm === null) return
        const wt = argWasmType(arg, state)
        if (state._lastArgMiss && !r.missArg) { r.missArg = true; latticeMeet.changed = true }
        if (r.wasm === undefined) { if (wt !== undefined) { r.wasm = wt; latticeMeet.changed = true } }
        else if (r.wasm !== wt) { r.wasm = null; latticeMeet.changed = true }
      },
    },
    {
      missing: poison('intConst'),
      apply(r, arg, k, state) {
        if (k === state.restIdx) r.intConst = null
        else if (r.intConst !== null) mergeParamFact(r, 'intConst', intConstArg(arg))
      },
    },
  ]
  // Transitive propagation down call chains: iterate a *soft* merge — propagate
  // known facts, treat "can't tell yet" as skip (no poison) — to a fixpoint,
  // then one *hard* validating sweep that poisons params whose call sites still
  // can't be proven (genuinely-untyped args).
  const runArrElemFixpoint = (field, inferFn, elemsCtxMap) => {
    // Extends `state` in place rather than allocating a fresh object per call
    // (this runs inside the hottest worklist loop of the self-hosted kernel).
    const infer = (arg, _k, state) => {
      state.callerElems = elemsCtxMap.get(state.callerFunc)
      state.paramFacts = state.callerParamFacts(field)
      return inferFn(arg, state)
    }
    let changed, any = false
    const bump = (r, v) => { if (v == null || r[field] === null) return; const b = r[field]; mergeParamFact(r, field, v); if (r[field] !== b) changed = any = true }
    const soft = {
      missing(r, k, state) { const def = defaultArg(state, k); if (def != null) bump(r, infer(def, k, state)) },
      apply(r, arg, k, state) { bump(r, infer(arg, k, state)) },
    }
    do { changed = false; runCallsiteLattice([soft]) } while (changed)
    latticeMeet.changed = false
    runCallsiteLattice([mergeRule(field, infer)])
    return any || latticeMeet.changed
  }
  const runArrSetFixpoint = () => runArrElemFixpoint('arrayElemSchemaSet', inferArrElemSchemaSet, phase.callerElems('arrElemSchemaSets'))
  // OBJECT-param closed union: `measure(rows[i])` — every call site passes an
  // element of a set-carrying array (body census or the caller's own param
  // fact), or forwards a set-carrying object param. Canonical 'a,b,…' keys ride
  // the exact-agreement lattice; compile/index.js decodes into rep.schemaIdSet,
  // which discriminant refinement (flow-types) and union-agreeing slot reads
  // (schema.slotOf) consume — the guard-free tagged-union chain.
  const runSchemaIdSetFixpoint = () => {
    const setsBy = phase.callerElems('arrElemSchemaSets')
    const infer = (arg, _k, state) => {
      if (Array.isArray(arg) && arg[0] === '[]' && typeof arg[1] === 'string') {
        const s = setsBy.get(state.callerFunc)?.get(arg[1])
        if (s instanceof Set && s.size >= 2) return [...s].sort((a, b) => a - b).join(',')
        const p = state.callerParamFacts('arrayElemSchemaSet')?.get(arg[1])
        if (typeof p === 'string') return p
        return null
      }
      if (typeof arg === 'string') return state.callerParamFacts('schemaIdSet')?.get(arg) ?? null
      return null
    }
    let changed, any = false
    const bump = (r, v) => { if (v == null || r.schemaIdSet === null) return; const b = r.schemaIdSet; mergeParamFact(r, 'schemaIdSet', v); if (r.schemaIdSet !== b) changed = any = true }
    const soft = {
      missing(r, k, state) { const def = defaultArg(state, k); if (def != null) bump(r, infer(def, k, state)) },
      apply(r, arg, k, state) { bump(r, infer(arg, k, state)) },
    }
    do { changed = false; runCallsiteLattice([soft]) } while (changed)
    latticeMeet.changed = false
    runCallsiteLattice([mergeRule('schemaIdSet', infer)])
    return any || latticeMeet.changed
  }

  // Worklist fixpoint: the edge is site(caller→callee) — a callee's param reps
  // derive from its CALLER's facts, so when function F's reps change, only
  // sites where F is the CALLER need revisiting. Seed = every site once;
  // termination = monotone meets over finite-height lattices.
  const runFixpointConverged = () => {
    const rules = fixpointRules
    const sitesByCaller = new Map()
    for (let s = 0; s < callSites.length; s++) {
      const cf = callSites[s].callerFunc?.name
      if (cf == null) continue
      let a = sitesByCaller.get(cf)
      if (!a) sitesByCaller.set(cf, a = [])
      a.push(s)
    }
    const queued = new Array(callSites.length).fill(false)
    const queue = []
    for (let s = 0; s < callSites.length; s++) { queue.push(s); queued[s] = true }
    let head = 0
    let guard = callSites.length * 64   // belt far above any real edge count
    while (head < queue.length && guard-- > 0) {
      if (guard === 0) {
        // Exhaustion is ALWAYS a compiler bug (a supposedly-monotone rule turned
        // out not to be) — never silently emit the truncated, less-precise
        // lattice. Enough context to reproduce: the visit budget, how many
        // sites were still queued, and which site was about to run next.
        const budget = callSites.length * 64
        const remaining = queue.length - head
        const next = callSites[queue[head]]
        const nextCaller = next?.callerFunc?.name ?? '?'
        const nextCallee = typeof next?.callee === 'string' ? next.callee : '?'
        err(`internal: narrowSignatures param-lattice worklist failed to converge — exhausted its ${budget}-visit guard (${callSites.length} call sites × 64) with ${remaining} site(s) still queued, next unresolved site ${nextCaller} → ${nextCallee} (this is a jz bug — a narrowing rule is non-monotone; please report with a minimal repro)`)
      }
      const s = queue[head++]
      queued[s] = false
      const state = siteState(callSites[s])
      if (!state) continue
      latticeMeet.changed = false
      applySiteRules(state, rules)
      if (latticeMeet.changed) {
        // this site's CALLEE gained facts → sites where the callee CALLS out
        const dep = sitesByCaller.get(state.callee)
        if (dep) for (const d of dep) if (!queued[d]) { queue.push(d); queued[d] = true }
      }
      // compact the spent prefix occasionally so queue stays bounded
      if (head > 4096 && head * 2 > queue.length) { queue.splice(0, head); head = 0 }
    }
  }
  runFixpointConverged()

  // Apply i32 specialization: for non-value-used funcs with consistent i32 call
  // sites and no defaults/rest at that position, narrow sig.params[k].type.
  // Exports too — boundary wrapper handles the f64→i32 truncation at the JS edge.
  applyI32ParamSpecialization(paramReps, addressTaken, sitesByCallee)

  // intConst validation: a param marked with a unanimous integer literal at every call
  // site is only safe to substitute if the body never reassigns it. Clear intConst on any
  // param whose name appears on the LHS of an assignment / `++` / `--`. Skip exported
  // (callable from JS with arbitrary value), value-used (closure callees), raw, defaulted,
  // and rest params — same exclusions as the wasm-narrowing pass above.
  validateIntConstParams(paramReps, addressTaken)

  // Pointer-ABI specialization: for non-forwarding pointer params consistent across
  // call sites, narrow from NaN-boxed f64 to i32 offset. Eliminates per-call __ptr_offset
  // extraction + f64→i64→i32 reinterpret chains that dominate watr-style compilers.
  // Safety:
  //   - exclude ARRAY (forwards on realloc — f64 NaN-box is a stable identity) and
  //     STRING (SSO vs heap dual encoding depends on ptr-type bits we'd drop).
  //   - exclude CLOSURE (aux carries funcIdx, needed for call_indirect) and TYPED
  //     (aux carries element-type, handled separately by applyTypedPointerParamAbi).
  //   - exclude params with defaults (nullish sentinel needs the f64 NaN space).
  //   - exclude rest position (array pack/unpack stays f64).
  applyPointerParamAbi(paramReps, addressTaken)

  // E: numeric (i32) result narrowing — kept here, after applyI32ParamSpecialization,
  // so a body returning `param + 1` sees param already narrowed to i32. (E2 / VAL
  // result inference ran up front — see above.) funcsWithNarrowableResult hoisted there.
  narrowI32Results(funcsWithNarrowableResult)

  // The closed element-schema union of an array result, from its return paths.
  narrowReturnArrayElemSets(paramReps, addressTaken)
  phase.clearNarrowingBodyState()
  // The closed-union domains loop to a quiet round (each runner reports
  // change): a set settled in one enables a fact in another, and helper chains
  // of any depth converge. Guard cap is a backstop — the lattices are finite and monotone.
  for (let g = 16; g-- > 0; ) {
    let dirty = false
    if (runArrSetFixpoint()) dirty = true
    if (runSchemaIdSetFixpoint()) dirty = true
    if (!dirty) break
    if (g === 0) {
      err('internal: narrowSignatures arr/schema domain fixpoint failed to converge — still dirty after its 16-round guard (runArrSetFixpoint/runSchemaIdSetFixpoint) (this is a jz bug — a domain runner is non-monotone; please report with a minimal repro)')
    }
  }

  // Internal fixed Array lengths flow through call parameters just like element
  // kinds. Only the builder proof above can originate this fact.
  const arrayLenAtSite = (arg, state) => {
    if (typeof arg === 'string')
      return internalArrayLengths.locals.get(state.callerFunc)?.get(arg)
        ?? state.callerParamFacts('arrayLen')?.get(arg)
        ?? null
    if (Array.isArray(arg) && arg[0] === '()' && typeof arg[1] === 'string')
      return internalArrayLengths.funcLens.get(arg[1]) ?? null
    return staticArrayLen(arg)
  }
  // An entry length is not a body invariant for a resizing/escaping parameter.
  // Poison those slots before propagation so downstream readers cannot inherit it.
  for (const func of ctx.funcs.list) {
    const safe = internalArrayLengths.safeParams.get(func.name)
    for (let k = 0; k < func.sig.params.length; k++)
      if (!safe?.[k]) ensureParamRep(paramReps, func.name, k).arrayLen = null
  }
  let arrayLenChanged = true
  while (arrayLenChanged) {
    arrayLenChanged = false
    runCallsiteLattice([{
      missing: poison('arrayLen'),
      apply(r, arg, _k, state) {
        const v = arrayLenAtSite(arg, state)
        if (v == null || r.arrayLen === null) return
        const before = r.arrayLen
        mergeParamFact(r, 'arrayLen', v)
        if (r.arrayLen !== before) arrayLenChanged = true
      },
    }])
  }
  runCallsiteLattice([mergeRule('arrayLen', (arg, _k, state) => arrayLenAtSite(arg, state))])

  // Fresh typed-array element hulls: propagate fill-helper effects into later
  // compute helpers. Unknown sites poison; known sites union, since all call
  // paths remain within the resulting closed interval.
  const rangeAtSite = (arg, state) => {
    if (typeof arg === 'string')
      return typedValueRanges.locals.get(state.callerFunc)?.get(arg)
        ?? state.callerParamFacts('arrayElemRange')?.get(arg)
        ?? null
    const ctor = typedElemCtor(arg)
    return ctor && typedStaticLen(arg) != null ? typedValueRanges.initialRange(arg, ctor) : null
  }
  const mergeRange = (r, v) => {
    if (r.arrayElemRange === null || !v) { r.arrayElemRange = null; return false }
    const next = typedValueRanges.hull(r.arrayElemRange, v)
    const changed = !r.arrayElemRange || next[0] !== r.arrayElemRange[0] || next[1] !== r.arrayElemRange[1]
    r.arrayElemRange = next
    return changed
  }
  let rangeChanged = true
  while (rangeChanged) {
    rangeChanged = false
    runCallsiteLattice([{
      missing: poison('arrayElemRange'),
      apply(r, arg, _k, state) {
        const v = rangeAtSite(arg, state)
        // During the soft fixpoint, unresolved forwarded params are neutral.
        if (v && mergeRange(r, v)) rangeChanged = true
      },
    }])
  }
  // Hard validation: one unresolved live site invalidates the theorem.
  runCallsiteLattice([{
    missing: poison('arrayElemRange'),
    apply(r, arg, _k, state) { mergeRange(r, rangeAtSite(arg, state)) },
  }])
  // E3: pointer-kind result narrowing — once valResult is set, lift the wasm
  // return type to i32 + ptrKind/ptrAux when aux is statically resolvable.
  narrowPointerResults(funcsWithNarrowableResult, paramReps, sitesByCallee)
  phase.clearNarrowingBodyState()

  // STATIC LENGTH down call chains: when every call site passes a typed array
  // of ONE known static length (`new Float64Array(8192)` — directly, via a
  // stable caller binding, or via the caller's own already-settled param), the
  // param carries it. Unlocks the whole static-length proof family inside
  // callees — typedIdxProven's literal/masked/interval classes and the
  // `.length` literal fold — where the length was born one frame up (heapsort
  // reading `a` sized in main; a codec writing `out` sized at the call site).
  // Exact-agreement only (mergeParamFact poisons on mismatch): the fact also
  // feeds `.length` folds, so an under-approximating min would miscompile.
  // Transitive via the same soft-fixpoint + hard-validate driver as the sets.
  const callerTypedLenCtx = buildCallerTypedLenCtx()
  const inferTypedLen = (arg, cx) => {
    if (typeof arg === 'string') return cx.callerElems?.get(arg) ?? cx.paramFacts?.get(arg) ?? null
    return typedStaticLen(arg)
  }
  runArrElemFixpoint('typedLen', inferTypedLen, callerTypedLenCtx)
  // A length without a settled ctor is unusable evidence (the receiver never
  // takes the typed read path) and a length on a host-reachable or rebound
  // param is unsound — same exclusion discipline as intConst.
  validateTypedLenParams(paramReps, addressTaken)

  // PARAM LENGTH-BOUND relation (ledger-performance.md §6.1): does param k's
  // value never exceed param r's runtime `.length`? Extends the SAME
  // caller-computed/callee-consumed contract as typedLen just above,
  // generalized from "an exact literal length" (unanimous constant) to "a
  // relational bound against a sibling param" — the tokenizer shape
  // (`scan(src, n - (i&7))`, `n` a single-def alias of `src.length`): `len`
  // never exceeds `src`'s length, but neither is a compile-time constant, so
  // typedLen itself can't carry it. boundedByCallerLength (summaries.js) does
  // the small, closed-form structural proof over one call site's own
  // argument pair; here every OTHER param position is tried as a candidate
  // receiver, keeping whichever (if any) EVERY site agrees on
  // (mergeParamFact's ordinary exact-agreement poison) — one direct hard
  // pass, no transitive/soft pre-pass.
  runCallsiteLattice([mergeRule('lenBoundOf', (arg, k, state) => {
    const body = state.callerFunc?.body
    if (!body) return null
    const { argList } = state
    for (let r = 0; r < argList.length; r++) {
      if (r === k) continue
      const recvArg = argList[r]
      if (typeof recvArg !== 'string') continue
      if (boundedByCallerLength(arg, recvArg, body)) return r
    }
    return null
  })])
  // Host-reachable functions, rest/default positions on either side, and a
  // body that writes either name invalidate the theorem — same discipline as
  // validateTypedLenParams (param-abi.js).
  validateLenBoundOfParams(paramReps, addressTaken)

  // G: TYPED pointer-ABI narrowing — once .typedCtor is one ctor at every call
  // site, narrow the param from NaN-boxed f64 to raw i32 offset (with ptrAux
  // carrying the elem-type bits). Eliminates the per-read
  // `i32.wrap_i64 (i64.reinterpret_f64 (local.get $arr))` unbox dance that
  // dominates hot loops over typed-array indexing. Call sites coerce via
  // coerceArg → ptrOffsetIR(arg, VAL.TYPED). Safety: same exclusions as the
  // OBJECT/SET/MAP/BUFFER narrowing above — exported, value-used, raw, defaults, rest position.
  applyTypedPointerParamAbi(paramReps, addressTaken)

  // I: Post-E re-narrow of numeric (i32) params. The first numeric narrowing pass
  // ran before E narrowed any result types, so callerLocals saw `let h = mix(...)`
  // as f64 (mix's result was f64 then). After E narrowed mix's result to i32,
  // exprType (which now consults func.sig.results for user calls) sees `h` as i32.
  // Refresh callerLocals + clear sticky-null wasm + re-run fixpoint + re-apply
  // numeric narrowing to propagate i32 through chains of i32-only helpers
  // (callback bench: mix is FNV — params and result all i32-shaped, but inferred
  // only after E phase narrowed mix's result).
  phase.refreshLocals()
  // I1: Re-run POINTER results now that Phase G has tagged typed params — a
  // pass-through like `norm = (w) => { …w[i]…; return w }` gains w.ptrKind only
  // in G, AFTER the first narrowPointerResults sweep, so its sig.ptrKind stayed
  // null and the I2 numeric-results pass below then STOLE the return as plain
  // i32 — the caller f64.convert_i32_s'd the returned offset into a bogus float
  // (the cross-module memo miscompile: `g._w = norm(w)` stored a number, the
  // slot read dispatched on it as a pointer → undefined). The rerun stamps
  // sig.ptrKind first; I2's f64-results guard then skips these functions.
  narrowPointerResults(funcsWithNarrowableResult, paramReps, sitesByCallee)
  // I2: Re-narrow i32 RESULTS now that Phase G (applyTypedPointerParamAbi) has tagged
  // typed-array params ptrKind=TYPED. Phase E ran before G, so a function returning a
  // typed-array element — dict's `lookup = (keys, vals, k) => { … return vals[h] }` with
  // vals an Int32Array param — had its return tail type as NaN-boxed f64 (vals not yet a
  // typed pointer), leaving sig.results f64 and the call site running the full
  // __typed_idx/ToNumber unbox on every probe step (491520× per dict kernel run). Now that
  // evalTails seeds the typed-param overlay and params carry ptrAux, the fixpoint catches
  // `vals[h]` as i32, narrows the result, and the dispatch vanishes; the runFixpoint below
  // then propagates the i32 result into `let v = lookup(...)` at the call sites.
  narrowI32Results(funcsWithNarrowableResult)
  // Reset wasm field unconditionally — first pass populated it from stale callerLocals
  // (where `let h = mix(...)` widened h to f64 because mix's result wasn't narrowed
  // yet). Here we need to reset f64-observed too so the refreshed exprType view propagates.
  resetParamWasmFacts(paramReps)
  runFixpointConverged()
  // Don't steal typed-array params from specializeBimorphicTyped: F phase parks
  // bimorphic typed params at type='f64' with sticky-null typedCtor (two distinct
  // ctors at call sites). Their callers post-F pass them as i32 (pointer ABI),
  // so r.wasm flips to 'i32' here — but narrowing now breaks the clone path
  // that still needs to mint per-ctor sigs with ptrKind=TYPED, ptrAux=ctor-aux.
  applyI32ParamSpecialization(paramReps, addressTaken, sitesByCallee, { skipTyped: true })

  // J: jsstring boundary opt-in — for exported funcs with a string param whose
  // every use is mappable to a wasm:js-string builtin, flip the param's wasm
  // slot from f64 (nanbox SSO carrier) to externref so the JS host passes the
  // native string directly. Zero copy, zero transcoding. See applyJsstringBoundaryCarrier.
  if (jsstringEnabled()) applyJsstringBoundaryCarrier(paramReps, addressTaken)

  // Stamp the settled per-param val kind onto sig.params (mirror of emitFunc's
  // updateRep(pname, { val: r.val }) merge — same source, same condition). The
  // call-site emitter needs it to pick the arg carrier: a BOOL arg into an
  // UNTYPED f64 param boxes to its TRUE/FALSE atom (boolean identity crosses
  // the boundary), while a val-known param keeps the raw 0/1 ABI its body
  // assumes. Read by coerceArg (emit.js).
  for (const func of ctx.funcs.list) {
    if (!func.sig || func.raw) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    for (const [k, r] of reps) {
      const p = func.sig.params[k]
      if (p && r.val != null && p.val == null) p.val = r.val
    }
  }

  // kindsCoverage (param-reps.js's Fact JSDoc + the exclusion-projection
  // contract): mark 'closed' ONLY for a func whose every call site the summary
  // saw — not raw (no facts model), not exported (no external JS/host caller
  // with arbitrary args), and its name is not address-taken (no indirect/
  // first-class-value call that could invoke it outside the literal `f(...)`
  // nodes). DEFAULT stays 'open' (field absent) for every other param — a
  // wider possibleKinds set from more call sites is always safe to ADD later;
  // downgrading a wrongly-'closed' mark is not.
  for (const func of ctx.funcs.list) {
    if (func.raw || isExported(func) || addressTaken.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    for (const r of reps.values()) r.kindsCoverage = 'closed'
  }

  if (DBG_INVARIANTS) assertValKindConsistent(paramReps)
}
