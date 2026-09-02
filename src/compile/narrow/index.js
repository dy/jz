/**
 * Signature narrowing — fixpoint analysis that mutates each user func's `sig`
 * based on call-site observations.
 *
 * Reads programFacts.callSites plus ProgramIndex address-taken facts; mutates sig.params/results,
 * func.valResult, and programFacts.paramReps. Pure w.r.t. the AST — only
 * function `sig` records change.
 *
 * narrowSignatures is the file's real outlier (~1,200 ln, ~20 nested
 * closures): it deliberately reuses ONE mutable `sharedSiteState` object
 * across every call-site visit — see the comment at its own declaration for
 * why (a measured self-hosted memory constraint, not a readability choice).
 * Flagged, not solved, by .work/archive/narrow-split.md §6 — the driver and its
 * shared state stay in this one module.
 *
 * @module compile/narrow/index
 */

import { ctx, err, DBG_INVARIANTS } from '../../ctx.js'
import { withTypedElemOverlay } from '../flow-state.js'
import { ASSIGN_OPS, walkAst } from '../../ast.js'
import { I32_MIN, I32_MAX } from '../../ir.js'
import { mayBeNullish } from '../analyze.js'
import { staticArrayElems, hull } from '../../static.js'
import { exprType, typedElemCtor, typedStaticLen } from '../../type.js'
import { observeProgramSlots } from '../program-facts.js'
import {
  valTypeOf, hasAmbiguousBoolMerge, exprMayBeUndefinedIn, exprPresentValIn, localMapGetMayCarryBigint,
} from '../../kind.js'
import { typedCtorElemValType } from '../../kind-traits.js'
import { VAL, KIND_UNIVERSE } from '../../reps.js'
import {
  paramFactsOf, ensureParamRep, mergeParamFact, joinKinds, latticeMeet,
} from '../../param-reps.js'
import {
  inferArrElemSchema, inferArrElemSchemaSet, inferArrElemValType, inferSchemaId, inferValType, inferTypedCtor,
} from '../infer.js'
import { RECUR_INT_OPS, assertValKindConsistent, buildCallerTypedLenCtx, enrichCallerValTypesFromPointerParams, resetParamWasmFacts, createPhaseState } from './caller-ctx.js'
import { applyI32ParamSpecialization, validateTypedLenParams, validateLenBoundOfParams, validateIntConstParams, applyPointerParamAbi, narrowableFuncs, applyTypedPointerParamAbi } from './param-abi.js'
import { narrowI32Results, narrowValResults, narrowPointerResults, narrowReturnArrayElems } from './results.js'
import { inferInternalArrayLengths, arrayReadProvenInBounds, inferTypedValueRanges, boundedByCallerLength } from './summaries.js'
import { jsstringEnabled, applyJsstringBoundaryCarrier } from './jsstring-carrier.js'
import { makeMapOverlay } from '../map-overlay.js'
import { isExported } from '../func-exports.js'

export default function narrowSignatures(programFacts, ast) {
  const { callSites, paramReps, hasSchemaLiterals, hasMapSet } = programFacts
  const addressTaken = programFacts.programIndex.addressTaken

  // Dead callers must not poison live signature facts. ProgramIndex owns the
  // numeric roots and direct-edge closure; this consumer only compacts the rich
  // call-site observations to that already-final reachability set.
  programFacts.programIndex.filterCallSitesToReachable(callSites)

  // Callee-indexed view of `callSites`, built ONCE per narrowSignatures call.
  // Several consumers below (hardParamVal, hardParamRecvArrTyped,
  // hardParamPresentVal, the BIGINT-nullable join, the
  // mayBeUndefined join, callerArgSelfConsistentI32 via applyI32ParamSpecialization)
  // each used to linear-scan the FULL `callSites` array filtering on
  // `cs.callee === funcName`, from an outer loop over every function × every
  // param — O(functions × params × callSites), the pass's own dominant cost on
  // a program this size (self-hosted-only: native V8 GCs the resulting churn;
  // the self-host bump arena can't, see research.md). `callSites` is stable
  // from here on; ProgramIndex compaction just above is the ONLY place
  // anywhere in this module that mutates it (in-place compaction), and it has
  // already run — so one grouping pass here replaces every one of those scans
  // with an O(1) `.get(funcName)` lookup into just that callee's own sites,
  // turning the whole shape into O(callSites + functions × params). Built by a
  // single forward pass that only ever appends, so each callee's bucket keeps
  // `callSites`' original relative order — the same order-preservation
  // `sitesByCaller` (below, in runFixpointConverged) already relies on for its
  // own per-caller grouping.
  const sitesByCallee = new Map()
  for (const cs of callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  // Body-driven result kinds do not depend on the parameter lattice. Settle
  // them before caller contexts are built so those contexts are born against
  // the final value-result view instead of immediately becoming stale.
  const funcsWithNarrowableResult = narrowableFuncs(addressTaken)
  narrowValResults(funcsWithNarrowableResult)

  // D: Call-site type propagation — infer param types from how functions are called.
  // Drives off `callSites` collected during the ProgramFacts walk; no AST re-walking.
  // For non-exported internal functions, if all call sites agree on a param's type,
  // seed the param's val rep (ctx.func.localReps) during per-function compilation.
  // Also infer i32/f64 WASM type — when all call sites pass i32 for a param, specialize
  // sig.params[k].type to i32 (no default, no rest, not exported, not value-used).
  // Also propagate schema ID — when all call sites pass objects with the same schema,
  // bind the callee's param to that schema so `p.x` becomes a direct slot load.
  // Inference helpers (inferValType/inferSchemaId/inferArr*/inferTypedCtor)
  // live in infer.js — pure AST→fact resolvers shared across fixpoint phases.
  // Per-caller analysis is stable across fixpoint iterations — precompute once.
  // callerCtx[null] (top-level) uses module globals for both locals and valTypes.
  const phase = createPhaseState()
  const { callerCtx } = phase
  const typedValueRanges = inferTypedValueRanges(paramReps)
  const internalArrayLengths = inferInternalArrayLengths(paramReps)
  const callerArrValTypes = phase.callerElems('arrElemValTypes')
  // Same hoist-once-early idiom as callerArrValTypes above (its own long-
  // standing acceptable staleness applies identically here: phase.refreshValTypes/
  // clearNarrowingBodyState rebuild the underlying map later, but this captured
  // reference stays whatever it resolved at hoist time — never WRONG, only
  // possibly missing a later-provable win, same as every other consumer of
  // this exact pattern already accepts). Used by inferValAtSite's `.`-read
  // case to resolve `arr[i].prop`'s receiver schemaId through a proven
  // array-element read, one hop beyond a bare-name/param receiver.
  const callerArrSchemas = phase.callerElems('arrElemSchemas')
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
  // across every sweep. The former fresh 13-field object + method closure + Map
  // per site was the largest attributed HASH-sidecar source in self-hosted
  // narrowing (hundreds of thousands of constructions before the 4 GiB wall).
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
    callerLocals: undefined, callerValTypes: undefined, callerTypedElems: undefined,
    callerParamFacts,
    // runArrElemFixpoint mutates these named context channels in place.
    callerElems: undefined, paramFacts: undefined, callerSids: undefined, callerSchemaIds: undefined,
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
    sharedSiteState.callerValTypes = ctxEntry.callerValTypes
    sharedSiteState.callerTypedElems = ctxEntry.callerTypedElems
    let paramNames = paramNamesByFunc.get(func)
    if (!paramNames) {
      paramNames = new Set(func.sig.params.map(p => p.name))
      paramNamesByFunc.set(func, paramNames)
    }
    sharedSiteState.calleeParamNames = paramNames
    sharedSiteState.callerElems = undefined
    sharedSiteState.paramFacts = undefined
    sharedSiteState.callerSids = undefined
    sharedSiteState.callerSchemaIds = undefined
    sharedSiteState._teOverlay = null
    sharedSiteState._lastArgMiss = false
    return sharedSiteState
  }
  // Per-site rule application, extracted so both the sweeping lattice runner
  // and the worklist fixpoint drive the same body (Stage 2 slice 3b).
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
  // Resolve a `.`-read's RECEIVER to a proven schemaId, from settled facts
  // only — never a guess. Two sources, both already-audited primitives used
  // elsewhere in this exact fixpoint, not new machinery:
  //   - inferSchemaId (infer.js) — the SAME resolver the `schemaId` mergeRule
  //     (below) already runs per call-site argument: a bare name settles via
  //     the caller's OWN already-narrowed param schemaId census
  //     (state.callerParamFacts('schemaId')) or a module-level ctx.schema.vars
  //     binding; a compound expr recurses through `{}`/`()`/`?:`/`&&`/`||`.
  //   - one hop through a proven ARRAY-element read (`rows[i].x`): the SAME
  //     arrayElemSchema census runArrFixpoint settles (caller body census via
  //     callerArrSchemas, or the caller's own arrayElemSchema param fact).
  // Returns null on anything unproven (receiver kind unknown, or a schema-
  // less/hazarded/OBJECT-free value) — inferValAtSite's caller then simply
  // contributes nothing for this site, exactly like any other unclassifiable
  // argument shape below.
  const receiverSchemaId = (recv, state) => {
    const sid = inferSchemaId(recv, state.callerParamFacts('schemaId'))
    if (sid != null) return sid
    if (Array.isArray(recv) && recv[0] === '[]' && typeof recv[1] === 'string') {
      return callerArrSchemas.get(state.callerFunc)?.get(recv[1])
        ?? state.callerParamFacts('arrayElemSchema')?.get(recv[1])
        ?? null
    }
    return null
  }
  // Default-aware val inference. Adds two fallbacks beyond inferValType's
  // body-local `callerValTypes` lookup so a hot recursive helper like
  // `uleb(n, buffer = []) { ... return uleb(n, buffer) }` resolves the
  // recursive `buffer` arg to VAL.ARRAY (via callerParamFacts on iter 2,
  // or via the caller's own default expression on iter 1).
  const inferValAtSite = (arg, state) => {
    // research.md §Carrier invariant: an ambiguous BOOL∪NUMBER merge argument
    // (`cond && 1`) legitimately answers NUMBER here (inferValType →
    // valTypeOf's arithmetic-safe benign coercion — the SAME kind.js rule
    // hasAmbiguousBoolMerge exists to flag as unsound elsewhere) — but a
    // param's hardened `val` fact also feeds IDENTITY-observing static folds
    // in the CALLEE's body (emitStrictEq's differing-primitive-class fold:
    // `p === false` compile-time-folds to `false` when p.val is confidently
    // NUMBER, even though this call site's actual runtime value could be the
    // boxed FALSE atom). Decline the claim — same "unknown side → no claim"
    // principle valTypeOfWithLocals's SOUND `+` rule already applies (kind.js).
    // A rare-shape cost only: this design's own COST section's census found
    // zero ambiguous-merge shapes in the bench corpus, so ordinary programs
    // keep the full val-lattice fast path unchanged.
    if (Array.isArray(arg) && hasAmbiguousBoolMerge(arg)) return null
    const v = inferValType(arg, state.callerValTypes)
    if (v != null) return v
    if (typeof arg !== 'string') {
      // Plain Array<T> element passed directly to a helper. valTypeOf runs in
      // the callee's ambient context here, so resolve through the caller's own
      // body/param element facts instead (`visit(rows[i])` → OBJECT).
      if (Array.isArray(arg) && arg[0] === '[]' && typeof arg[1] === 'string') {
        const v = callerArrValTypes.get(state.callerFunc)?.get(arg[1])
          ?? state.callerParamFacts('arrayElemValType')?.get(arg[1])
        if (v != null) return v
      }
      // Typed-array element read `recv[i]` where the receiver is a TYPED param/local of the CALLER:
      // valTypeOf can't see this (it queries ctx.func, not the caller), so `f(src[i])` with a
      // Float64Array PARAM `src` never propagated Number to f's param. Mirror VT['[]'] exactly,
      // but resolve the receiver through the caller's own context — sound: only fires when the
      // receiver is provably VAL.TYPED, and the ctor decides Number vs BigInt (BigInt64Array).
      if (Array.isArray(arg) && arg[0] === '[]' && arg.length === 3 && typeof arg[1] === 'string' &&
          (state.callerValTypes?.get(arg[1]) || ctx.scope.globalValTypes?.get(arg[1])) === VAL.TYPED)
        return typedCtorElemValType(state.callerTypedElems?.get(arg[1])) || VAL.NUMBER
      // Property read (`c.type`, `rows[i].x`): resolve the receiver to a
      // proven schemaId (never guessed — receiverSchemaId above) and read
      // that field's program-wide-monomorphic kind off the SAME SlotFact
      // census kind.js's VT['.'] trusts for a live receiver (ctx.schema.
      // slotVT) — slotVTBySid is the by-sid sibling for exactly this caller:
      // a call-site-resolved sid, never a live ctx.func/repOf frame (mirrors
      // slotTypedCtorAt/slotTypedCtorBySid's existing split, module/schema.js).
      // A genuinely mixed-kind field declines for free: SlotFact.kind is
      // itself null on any whole-program disagreement, no separate check
      // needed here.
      if (Array.isArray(arg) && arg[0] === '.' && typeof arg[2] === 'string') {
        const sid = receiverSchemaId(arg[1], state)
        if (sid != null) {
          const v = ctx.schema.slotVTBySid(sid, arg[2])
          if (v != null) return v
        }
        // Sibling source for a receiver that is never schema-registered at all —
        // an ARRAY-declared local/module target only ever used as a static
        // string-keyed dictionary (dict-kind-index.js's own doc has the full
        // mechanism: a `for (k in OBJ) T[k] = …` unroll over a constant object
        // literal). `arg[1]` is looked up by its OWN exact (alpha-renamed, if
        // local) spelling — the index itself already resolves every alias this
        // receiver could be forwarded through, so a direct name lookup here is
        // exactly as sound as the schemaId path above, just keyed differently.
        if (typeof arg[1] === 'string') {
          const v = ctx.types.dictKinds?.resolveDictKind(arg[1], arg[2])
          if (v != null) return v
        }
      }
      return null
    }
    const fromParam = state.callerParamFacts('val')?.get(arg)
    if (fromParam != null) return fromParam
    const def = state.callerFunc?.defaults?.[arg]
    return def != null ? valTypeOf(def) || null : null
  }
  // Substitute the default expression for a missing positional arg, so
  // `uleb(n)` doesn't poison buffer.val despite `buffer = []` provably
  // yielding VAL.ARRAY at runtime — unblocks inline ARRAY len/push fast
  // paths in encode.js's hot uleb/i32/i64 helpers.
  const defaultArg = (state, k) => {
    const pname = state.func.sig.params[k]?.name
    return pname != null ? state.func.defaults?.[pname] : null
  }
  // Hard consensus val for (funcName, param k): the kind every live call site
  // agrees on, or null if any site is untyped / missing / disagrees. The shared
  // `val` lattice runs SOFT (a value can come from typed sites alone, untyped
  // sites skipped); a consumer that *mutates the signature* off val must instead
  // ask this — it re-folds the sites HARD so it never specializes a param that
  // some call site can't prove. (applyPointerParamAbi is that consumer.)
  const hardParamVal = (funcName, k) => {
    let consensus
    const sites = sitesByCallee.get(funcName)
    if (!sites) return null
    for (const cs of sites) {
      const state = siteState(cs)
      if (!state) continue
      if (k >= state.argList.length) return null         // missing → undefined at runtime
      const v = inferValAtSite(state.argList[k], state)
      if (v == null) return null                         // an untyped site ⇒ not specializable
      if (consensus === undefined) consensus = v
      else if (consensus !== v) return null              // disagreement ⇒ TOP
    }
    return consensus ?? null
  }
  // Class-level sibling of hardParamVal: true iff every live call site proves
  // ARRAY OR TYPED at this position — mixing the two (unlike hardParamVal's
  // exact-equality fold) does NOT disqualify, since module/array.js's numeric-
  // key unproven-receiver guard only needs to rule out OBJECT/HASH/STRING/etc
  // (reps.js recvArrTyped doc). Same fail-closed discipline as hardParamVal:
  // one untyped/missing/other-kind site and the whole param declines (returns
  // false) — always safe, since false only means the runtime guard stays.
  const hardParamRecvArrTyped = (funcName, k) => {
    let any = false
    const sites = sitesByCallee.get(funcName)
    if (!sites) return false
    for (const cs of sites) {
      const state = siteState(cs)
      if (!state) continue
      if (k >= state.argList.length) return false
      const v = inferValAtSite(state.argList[k], state)
      if (v !== VAL.ARRAY && v !== VAL.TYPED) return false
      any = true
    }
    return any
  }
  // `soft` makes apply treat a null inference as BOTTOM (skip — "this site can't
  // tell yet") instead of TOP (poison): the monotone meet. A soft field never
  // needs clearStickyNull; its consumers either re-validate hard (hardParamVal)
  // or read it after a final hard settling sweep. `missing` poisons regardless —
  // an omitted arg with no default is undefined at runtime, a real reason not to
  // specialize, and must stay sticky.
  //
  // `trackKind` (val only — product-lattice Slice 4a, .work/archive/lattice-design.md
  // §3.2/§1.1): also union every per-site observation into `possibleKinds`,
  // `val`'s existential twin. Computed UNCONDITIONALLY, even once `field` has
  // already gone sticky-TOP — possibleKinds exists precisely to keep the kinds
  // val's poison threw away, so it must not inherit val's early-return. `val`
  // itself is untouched by this: the mergeParamFact call and the
  // `r[field]===null` early-return still fire exactly where they did before.
  //
  // CALLER DISCIPLINE (must hold wherever trackKind=true is passed): `infer`'s
  // `v == null` means EITHER "genuinely unclassifiable" (join KIND_UNIVERSE —
  // real uncertainty) OR "this site's argument is a forwarding reference to
  // some OTHER param whose own val hasn't settled on THIS sweep yet" (an
  // ordering artifact, not uncertainty) — `joinKinds` can't tell those apart,
  // and being a monotone union with no retraction, a KIND_UNIVERSE joined for
  // the second reason on one premature sweep can never be undone by a later,
  // correctly-resolved re-visit (unlike `val` itself, whose per-visit
  // mergeParamFact call OVERWRITES rather than accumulates, so it self-heals
  // from the identical ordering hazard for free). The only way to make every
  // `v == null` mean the first case is to run trackKind=true exactly ONCE, as
  // a final pass, after every fact `infer` reads (val itself, arrayElemValType,
  // schemaId, typedCtor, pointer-ABI enrichment, …) has already reached ITS
  // OWN fixed point — see the sole trackKind=true call below (~"Settle val
  // HARD"), and keep it the only one. Do not add trackKind=true to `fixpointRules`
  // or any other mid-convergence sweep (root-caused + traced in
  // .work/archive/string-method-guess-notes.md, "Root cause of the REMAINING
  // ~16718-byte gap"; the shape: a recursive `uleb(n, buffer = [])` forwarded
  // through a second function `wleb(v, out) { uleb(v, out) }` — `buffer`'s val
  // genuinely converges to ARRAY, but a premature visit of the `wleb→uleb`
  // site, before `wleb`'s own `out` had settled, used to permanently
  // pessimize its possibleKinds to the full universe, making
  // paramValTrustworthy distrust a genuinely monomorphic param).
  const mergeRule = (field, infer, soft = false, trackKind = false) => ({
    // INVARIANT: an UNRESOLVED live observation (v == null — a call-site
    // argument the inferrer cannot classify, or a missing arg with no default)
    // must join the FULL universe, not be skipped — otherwise possibleKinds
    // reads as a complete superset while silently omitting the unclassifiable
    // site, and a future `!set.has(K)` exclusion would be a live miscompile.
    // (∅ stays BOTTOM = "zero observations"; the projection contract in
    // param-reps.js makes exclusion fail closed on ∅ for the zero-observed/
    // exported-param case that never reaches these rules at all.)
    missing(r, k, state) {
      const poisoned = r[field] === null
      if (poisoned && !trackKind) return
      const def = defaultArg(state, k)
      const v = def != null ? infer(def, k, state) : undefined
      if (trackKind) joinKinds(r, 'possibleKinds', v != null ? [v] : KIND_UNIVERSE)
      if (poisoned) return
      if (def != null) mergeParamFact(r, field, v)
      else { r[field] = null; latticeMeet.changed = true }
    },
    apply(r, arg, k, state) {
      const poisoned = r[field] === null
      if (poisoned && !trackKind) return
      const v = infer(arg, k, state)
      if (trackKind) joinKinds(r, 'possibleKinds', v != null ? [v] : KIND_UNIVERSE)
      if (poisoned) return
      if (v == null) { if (!soft) { r[field] = null; latticeMeet.changed = true } return }
      mergeParamFact(r, field, v)
    },
  })
  // WASM type of a call arg. exprType resolves most shapes, but an INTEGER typed-array
  // element read `intArr[idx]` (and arithmetic over it, `intArr[idx]+1`) types f64 here:
  // exprType's `[]` rule reads the typedElem OVERLAY, which doesn't see a typedCtor-narrowed
  // PARAM array at fixpoint time — yet the element is a 32-bit machine integer. Install the
  // caller's resolved param-typedCtors (+ module globals) as that overlay for the duration
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
  const argWasmType = (arg, state) => {
    // Recursive self-call: an arg built only from the callee's own params + already-i32 locals +
    // int constants (`f(n - 1)`, `f(n - 1 - i)`) is i32 IFF those params are i32 — a fixpoint
    // identity carrying no INDEPENDENT type evidence. Optimistically type it i32 so the NON-
    // recursive call sites decide: all i32 ⇒ the param narrows; any f64 ⇒ the meet still poisons
    // it. Lets a plain decreasing recursion narrow with no `|0` source crutch. (The bare-identity
    // arg `f(n)` is already skipped wholesale in runCallsiteLattice.)
    if (state.callee === state.callerFunc?.name &&
        isRecurIntExpr(arg, state.calleeParamNames, state.callerLocals)) return 'i32'
    if (!state._teOverlay) {
      // Overlay per-site param facts on the caller's stable typed map without
      // cloning that whole map on every fixpoint visit.
      const base = state.callerTypedElems || ctx.scope.globalTypedElem || null
      const pf = state.callerParamFacts('typedCtor')
      if (pf?.size) {
        const overlay = makeMapOverlay(base)
        for (const [name, ctor] of pf) if (ctor != null) overlay.set(name, ctor)
        state._teOverlay = overlay
      } else state._teOverlay = base
    }
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
      const vk = state.callerValTypes?.get?.(arg)
      if (vk != null && vk !== VAL.NUMBER && vk !== VAL.BOOL) return 'f64'
    }
    return wt
  }
  const fixpointRules = [
    // val runs SOFT (monotone): a TYPED param's val only becomes inferable after the
    // typedCtor fixpoint + pointer-ABI enrichment, so an early hard merge would
    // sticky-poison it (the old clearStickyNull undid that). Soft leaves it BOTTOM;
    // the post-enrichment rerun fills it in. applyPointerParamAbi re-validates via
    // hardParamVal; a final hard sweep settles val for emit + late consumers.
    // trackKind=false (not true): this rule rides EVERY sweep of the worklist
    // fixpoint below, most of them mid-convergence — see mergeRule's own
    // "CALLER DISCIPLINE" comment above for why possibleKinds must not be
    // touched here. The ~"Settle val HARD" sweep near the end of this function
    // is the one and only trackKind=true pass.
    mergeRule('val', (arg, _k, state) => inferValAtSite(arg, state), true),
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
    mergeRule('schemaId', (arg, _k, state) => inferSchemaId(arg, state.callerParamFacts('schemaId'))),
    {
      missing: poison('intConst'),
      apply(r, arg, k, state) {
        if (k === state.restIdx) r.intConst = null
        else if (r.intConst !== null) mergeParamFact(r, 'intConst', intConstArg(arg))
      },
    },
  ]
  const runFixpoint = () => runCallsiteLattice(fixpointRules)
  // Transitive ctor/schema propagation down call chains. A naive single-pass
  // mergeRule poisons a callee's param on the *first* sweep if the caller's own
  // param (the very thing that supplies the ctor) hasn't been typed yet — and the
  // poison is sticky, so later sweeps can't recover. Two-pass was the old patch;
  // it still loses any chain deeper than `main→f→g→h` (e.g. heapsort's siftDown).
  // Fix: iterate a *soft* merge — propagate known ctors, treat "can't tell yet"
  // as skip (no poison) — to a fixpoint, then one *hard* validating sweep that
  // poisons params whose call sites still can't be proven (genuinely-untyped args).
  const runArrElemFixpoint = (field, inferFn, elemsCtxMap, sidsCtxMap) => {
    // Named cx, not a positional tail (infer.js's "Fixpoint call-site inference
    // context" doc has the field shape + the collision history that
    // motivated it). Extends `state` in place rather than allocating a fresh
    // object per call: `state` is already a per-site-per-sweep throwaway
    // (siteState builds a new one every runCallsiteLattice pass, with these
    // 4 slots pre-declared there so this stays a same-shape value write, not
    // a reshape), and this runs inside narrowSignatures' hottest worklist
    // loop — which is itself compiled and executed AS the self-host kernel,
    // so allocation/shape churn here is on the self-host compile-speed
    // critical path. INVARIANT: allocating a NEW object per call here tips
    // test/self-compile-perf.js's warm-instance ratio well past
    // its 0.99× cap; this mutate-in-place form is required to stay under it.
    // KNOWN RESIDUAL COST (not fully closed): `cx`
    // still reaches inferFn through a function-VALUE parameter (inferFn
    // itself is passed in, not named at the call site below) — narrow.js's
    // own schema/VAL narrowing can't prove an argument's shape across an
    // indirectly-dispatched call, so each inferFn's `cx.field` reads fall
    // back to generic dyn-get, unlike the old positional Map/scalar args
    // (a Map dispatches through one cheap fixed VAL tag check): an isolated
    // probe shows object-cx doubles __dyn_get vs positional args, and
    // test/self-compile-perf.js's warm-instance geomean sits a few % over its
    // cap post-mitigation where a positional-args baseline sits a few % under it.
    // Not fixed here: doing so would mean either abandoning the named-object
    // shape this refactor exists to deliver, or degrading it to a `cx.get(k)`
    // Map — a real ergonomics trade nobody asked for. test/self-compile-perf.js
    // isn't in test/index.js's battery; flagged, not fixed.
    const infer = (arg, _k, state) => {
      state.callerElems = elemsCtxMap.get(state.callerFunc)
      state.paramFacts = state.callerParamFacts(field)
      state.callerSids = sidsCtxMap?.get(state.callerFunc)
      state.callerSchemaIds = state.callerParamFacts('schemaId')
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
  const runArrFixpoint = () => runArrElemFixpoint('arrayElemSchema', inferArrElemSchema, phase.callerElems('arrElemSchemas'))
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
  const runArrValTypeFixpoint = () => runArrElemFixpoint('arrayElemValType', inferArrElemValType, phase.callerElems('arrElemValTypes'))

  // E2 (VAL-kind result inference) FIRST: it's body-driven and call-chain self-
  // fixpointing — independent of the param lattice and the narrowing acts (it reads
  // analyzeBody valTypes + callees' valResult, never paramReps or sig.params). Running
  // it up front means a call arg like `initRows()` resolves to its VAL.ARRAY result on
  // the param fixpoint's FIRST pass, so val/schemaId never get the can't-tell-yet
  // poison that clearStickyNull used to un-stick (root B). Numeric (i32) result
  // narrowing stays below — it benefits from i32 params being narrowed first.
  // Own-default typed annotation: `(arr = new Int32Array(0)) => …` self-declares
  // the param's element ctor — the ONLY evidence a host-called export can carry
  // (no call sites to lattice over; Workers v1 SPMD kernels are exactly this
  // shape). A WEAK seed: set only at BOTTOM, so call-site facts merge/poison
  // over it as usual. Runtime safety for Atomics receivers is the tag+elem
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
  // Change-driven convergence (Stage 2 slice 1): sweep until a quiet pass.
  // The facts are monotone meets over finite-height lattices, so this
  // terminates; 32 is a safety belt far above any real chain depth. Replaces
  // the "run twice" guess — deep caller chains (main→f→g→h) need more sweeps,
  // shallow programs need one.
  // Worklist fixpoint (Stage 2 slice 3b): the edge is site(caller→callee) —
  // a callee's param reps derive from its CALLER's facts, so when function
  // F's reps change, only sites where F is the CALLER need revisiting.
  // Seed = every site once; termination = monotone meets over finite-height
  // lattices (the same argument as the sweep form, minus the wasted quiet
  // sweep and the re-application to unaffected sites). Sweep callers of
  // runFixpoint elsewhere (arrElem enrichment re-sweeps) are unchanged.
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
  applyPointerParamAbi(paramReps, addressTaken, hardParamVal)

  // E: numeric (i32) result narrowing — kept here, after applyI32ParamSpecialization,
  // so a body returning `param + 1` sees param already narrowed to i32. (E2 / VAL
  // result inference ran up front — see above.) funcsWithNarrowableResult hoisted there.
  narrowI32Results(funcsWithNarrowableResult)

  // Now that E2 set `valResult` on funcs, narrow per-func `arrayElemSchema` for
  // VAL.ARRAY-returning funcs (via push observations + call chains). Then re-run the
  // D-pass arrayElemSchema/val fixpoints so `const rows = initRows()` in main
  // resolves to VAL.ARRAY (lets runKernel pick up r.val=ARRAY) and its arr-elem
  // schema (sets paramReps[runKernel][0].arrayElemSchema=sid).
  // Cache invalidation: analyzeBody.valTypes is body-keyed, and entries cached
  // during the first D pass have stale (null) `valTypeOf(call)` results because
  // valResult was unset back then.
  narrowReturnArrayElems('arrayElemSchema', paramReps, addressTaken)
  narrowReturnArrayElems('arrayElemSchemaSet', paramReps, addressTaken)
  narrowReturnArrayElems('arrayElemValType', paramReps, addressTaken)
  phase.clearNarrowingBodyState()
  phase.refreshValTypes()
  // Re-observe schema slot val-types now that E2 has set `valResult` on user
  // funcs. First pass runs in collectProgramFacts before valResult is known, so
  // a slot like `cs` in `{ ..., cs }` (where `cs = checksum(out)`) gets observed
  // as null. observeSlot's first-wins-then-clash rule lets a later precise
  // observation upgrade `undefined` → NUMBER without poisoning earlier
  // monomorphic observations.
  // hasMapSet joins hasSchemaLiterals (design .work/archive/todo.md §deletion-sweep
  // §1) — same reasoning as program-facts.js's own gate widening: a Map-only
  // program has no `{}` to trip hasSchemaLiterals, but still needs this re-
  // observation pass for its own census (methodValType 'get' consumer wants
  // the freshest facts too, not just schema slots).
  if (hasSchemaLiterals || hasMapSet) observeProgramSlots(ast)
  // Re-run with refreshed callerValTypes + the new program-slot observations. (No
  // clearStickyNull needed: valResult was known before the first pass — see E2 hoist
  // above — so val/schemaId never got the can't-tell-yet poison this used to undo.)
  runFixpointConverged()
  // Now that .val is refreshed, the arr-elem/schema-set domain GROUP loops to a
  // full quiet round (each runner reports change): a schemaId settled in one
  // domain enables an arr fact in another, and helper chains DEEPER than two
  // now converge instead of silently truncating at the old "run twice" depth.
  // Guard cap is a backstop — the lattices are finite and monotone.
  for (let g = 16; g-- > 0; ) {
    let dirty = false
    if (runArrFixpoint()) dirty = true
    if (runArrSetFixpoint()) dirty = true
    if (runSchemaIdSetFixpoint()) dirty = true
    if (runArrValTypeFixpoint()) dirty = true
    if (!dirty) break
    if (g === 0) {
      err('internal: narrowSignatures arr/schema domain fixpoint failed to converge — still dirty after its 16-round guard (runArrFixpoint/runArrSetFixpoint/runSchemaIdSetFixpoint/runArrValTypeFixpoint) (this is a jz bug — a domain runner is non-monotone; please report with a minimal repro)')
    }
  }
  // Array<T> facts can make a direct `helper(rows[i])` argument precise only
  // now; settle the ordinary val lattice once more with that caller context.
  runFixpointConverged()

  // Internal fixed Array lengths flow through call parameters just like element
  // kinds. Only the builder proof above can originate this fact.
  const arrayLenAtSite = (arg, state) => {
    if (typeof arg === 'string')
      return internalArrayLengths.locals.get(state.callerFunc)?.get(arg)
        ?? state.callerParamFacts('arrayLen')?.get(arg)
        ?? null
    if (Array.isArray(arg) && arg[0] === '()' && typeof arg[1] === 'string')
      return internalArrayLengths.funcLens.get(arg[1]) ?? null
    const elems = staticArrayElems(arg)
    return elems ? elems.length : null
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
  narrowPointerResults(funcsWithNarrowableResult, paramReps)

  // F: Cross-call typed-array element ctor propagation. Runs AFTER E3 so that
  // calls to user functions returning a TYPED-narrowed pointer (with constant
  // ptrAux, e.g. mkInput → Float64Array) contribute their element type to the
  // caller's local typedElem map. Result: callees pick up `ctx.func.typedElem`
  // for their own params and `arr[i]` reads emit a direct `f64.load` instead of
  // the runtime `__is_str_key + __typed_idx` dispatch — closes the largest
  // chunk of the JS→wasm gap on f64-heavy hot loops.
  // (Helper `inferTypedCtor` lives in src/infer.js — the call-site mirror
  //  of body-walk evidence — and is reused by the bimorphic-typed
  //  specialization pass below; `ctorFromElemAux` stays in analyze.js next
  //  to its encode/decode partner.)
  // Per-caller typed-elem map, recomputed now that E3 has tagged helper sigs.
  // Cache invalidation: analyzeBody.typedElems reads `ctx.funcs.map.get(...).sig.ptrKind`
  // for `let x = mkInput(...)` decls; entries cached during the initial walk
  // (before E3 ran) are stale (mkInput's ptrKind was unset then).
  phase.clearNarrowingBodyState()
  const callerTypedCtx = phase.callerTyped()
  // Per-caller receiver schemas for field-provenance args (`transform(plan.tw…)`):
  // a small decl scan per body — collision-free and live-rep-independent (the
  // rep/schema.vars chains aren't trustworthy mid-lattice). inferSchemaId covers
  // literals and calls (valResult/ptrAux — E-complete by this phase); chained
  // decls resolve through the accumulating map. Module-const sids (`const P =
  // mk(n)` at top level) seed every caller's map; a local decl SHADOWS the seed
  // (unresolvable → masks it), and any reassignment drops the name (the second
  // write could carry a different schema).
  const moduleSids = new Map()
  // Top-level declarations only: recursion is an ALLOWLIST of wrapper ops
  // (`;` statement lists, `export`), not the generic child walk — anything
  // else (an `if`, a call, an arrow body, …) is a hard stop, so `enter`
  // prunes by default and only lets `;`/`export` through.
  walkAst(ast, { enter: node => {
    if (node[0] === 'let' || node[0] === 'const') {
      for (const d of node.slice(1)) {
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        if (!ctx.scope.consts?.has(d[1])) continue
        const sid = inferSchemaId(d[2], moduleSids)
        if (sid != null && !moduleSids.has(d[1])) moduleSids.set(d[1], sid)
      }
      return false
    }
    if (node[0] !== ';' && node[0] !== 'export') return false
  } })
  const callerSidsCtx = new Map()
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const sids = new Map(moduleSids), poisoned = new Set()
    const scan = (n) => {
      if (!Array.isArray(n)) return
      if (n[0] === '=>') return
      if (n[0] === 'let' || n[0] === 'const') {
        for (const d of n.slice(1)) {
          if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
            const sid = inferSchemaId(d[2], sids)
            sids.delete(d[1])          // a local decl shadows any module seed
            if (sid != null && !poisoned.has(d[1])) sids.set(d[1], sid)
            scan(d[2])
          } else scan(d)
        }
        return
      }
      if ((ASSIGN_OPS.has(n[0]) || n[0] === '++' || n[0] === '--') && typeof n[1] === 'string') { poisoned.add(n[1]); sids.delete(n[1]) }
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    // params shadow module seeds too — an arg-bound `P` is not the module const
    for (const p of func.sig?.params || []) sids.delete(p.name)
    scan(func.body)
    callerSidsCtx.set(func, sids)
  }
  // Two-pass fixpoint: lets a caller's params, once typed, propagate further to
  // its own callees (e.g. if `outer(buf)` calls `inner(buf)` and we learn `buf`
  // for outer, the second pass picks it up for inner). Reuses runArrElemFixpoint
  // (same shape — field/inferFn/elemsCtxMap parameterization).
  const runTypedFixpoint = () => runArrElemFixpoint('typedCtor', inferTypedCtor, callerTypedCtx, callerSidsCtx)
  // Quiet-loop (was "run twice"): caller→callee typed-ctor chains of any depth.
  for (let g = 16; g-- > 0 && runTypedFixpoint(); ) {
    if (g === 0) {
      err('internal: narrowSignatures typed-ctor fixpoint failed to converge — still dirty after its 16-round guard (caller→callee typedCtor propagation) (this is a jz bug — non-monotone inference; please report with a minimal repro)')
    }
  }

  // STATIC LENGTH down call chains: when every call site passes a typed array
  // of ONE known static length (`new Float64Array(8192)` — directly, via a
  // stable caller binding, or via the caller's own already-settled param), the
  // param carries it. Unlocks the whole static-length proof family inside
  // callees — typedIdxProven's literal/masked/interval classes and the
  // `.length` literal fold — where the length was born one frame up (heapsort
  // reading `a` sized in main; a codec writing `out` sized at the call site).
  // Exact-agreement only (mergeParamFact poisons on mismatch): the fact also
  // feeds `.length` folds, so an under-approximating min would miscompile.
  // Transitive via the same soft-fixpoint + hard-validate driver as typedCtor.
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
  // pass, no transitive/soft pre-pass (unverified for this shape-class; a
  // wrapper-forwarding chain would need summaries.js's own single-def
  // resolver taught to consult state.callerParamFacts('lenBoundOf') the way
  // inferTypedLen does above — not attempted here, see the ledger note).
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

  // G: TYPED pointer-ABI narrowing — once .typedCtor agrees on a single
  // ctor across all call sites, narrow the param from NaN-boxed f64 to raw
  // i32 offset (with ptrAux carrying the elem-type bits). Eliminates the
  // per-read `i32.wrap_i64 (i64.reinterpret_f64 (local.get $arr))` unbox dance
  // that today dominates hot loops dominated by typed-array indexing.
  // Call sites coerce via coerceArg → ptrOffsetIR(arg, VAL.TYPED).
  // Safety: same exclusions as the OBJECT/SET/MAP/BUFFER narrowing above —
  // exported, value-used, raw, defaults, rest position.
  applyTypedPointerParamAbi(paramReps, addressTaken)

  // H: Post-F/G re-fixpoint — propagates VAL kinds through bimorphic call sites
  // where ptrKind narrowed but ptrAux disagreed (e.g. `sum(f64arr)` and `sum(i32arr)`
  // → both VAL.TYPED, different ctors). Without this, callerValTypes carries no entry
  // for caller's params, so inferValType returned null and (under the old hard merge)
  // sticky-poisoned the param's val. The soft val merge leaves it BOTTOM instead, so
  // this rerun — now that enrichment has put VAL.TYPED into callerValTypes — simply
  // fills it in (array.js then skips __is_str_key + __str_idx dispatch on `arr[i]`).
  enrichCallerValTypesFromPointerParams(callerCtx)
  runFixpointConverged()

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
  narrowPointerResults(funcsWithNarrowableResult, paramReps)
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
  // yet). clearStickyNull only resets null; here we need to reset f64-observed too
  // so the refreshed exprType view propagates.
  resetParamWasmFacts(paramReps)
  runFixpointConverged()
  // Settle val HARD now that every producer (results, typedCtor, enrichment) has run
  // and the soft lattice has converged: re-fold each param's sites and poison any
  // whose val isn't unanimous (a site left BOTTOM = genuinely untyped). After this,
  // r.val is sound for emit + the late/post-return consumers (applyI32ParamSpecial-
  // ization's skipTyped guard, specializeBimorphicTyped) — which read it directly.
  // trackKind=true: this is ALSO the one and only place `possibleKinds` gets
  // populated (every earlier fixpointRules sweep above runs trackKind=false —
  // see that rule's comment). Since every fact `inferValAtSite` reads is
  // already at its final, fully-converged value by this point — including
  // its `.`-property-read case's own two dependencies: `schemaId` (this
  // exact runFixpointConverged, just above) and ctx.schema's SlotFact kind
  // census (observeProgramSlots' mid-function re-observation, well before
  // this line — see that call site's own comment) — (this sweep
  // itself only ever moves a param BOTTOM→null, never disturbs an
  // already-settled concrete val — a hard rule's `v == null` poisons
  // regardless of WHY it's null, so a not-yet-visited-this-pass source and a
  // genuinely-unresolvable one poison identically either way), a single plain
  // sweep over `callSites` — no worklist, no re-queueing — suffices: every
  // site's classification is final before the census ever reads it, so the
  // result cannot depend on visit order.
  runCallsiteLattice([mergeRule('val', (arg, _k, state) => inferValAtSite(arg, state), false, true)])
  // recvArrTyped: same final-sweep timing as the val hard-settle just above (every
  // producer — results, typedCtor, enrichment — has run). A param whose exact `val`
  // just poisoned to null because two sites disagree (ARRAY vs TYPED) may still
  // qualify here — that's the whole point (reps.js recvArrTyped doc). Computed for
  // every param position regardless of exported/address-taken status: an exported
  // function has no in-program call sites, so hardParamRecvArrTyped's fold sees
  // none and returns false — declines safely, no separate gating needed.
  for (const [fname, reps] of paramReps)
    for (const [k, r] of reps)
      if (hardParamRecvArrTyped(fname, k)) r.recvArrTyped = true
  // BIGINT params: re-derive nullability the val claim just erased. VT['?:']
  // carries BIGINT through a nullish-literal arm (the kind is untaggable at
  // runtime — kind.js), so a site arg like `c ? BigInt(x) : null` PROVES
  // BIGINT while still passing null on the other path; the settle above
  // stamps bare val=BIGINT and strictSentinel would then FOLD the callee's
  // `x == null` guard (watr's `_i64Arith(r)`: fold-miss null crosses for
  // real — the guard must return null, not format atom bits as hex). Any
  // site arg not structurally non-nullish marks the param nullable, which
  // only suppresses that fold (emitFunc's caller-side nullability block).
  // Scoped to BIGINT vals: tagged kinds keep their runtime forks and their
  // folds. Name args resolve through the CALLER body's own writes — at plan
  // time no caller ctx.func is installed, so rep lookups would misread;
  // an unwritten name (param/global/closure) fails closed.
  const bodyNameNullable = (callerFunc) => {
    const seen = new Set()
    const nameNullable = (name) => {
      if (seen.has(name)) return false            // cyclic alias: no new evidence
      seen.add(name)
      let found = false, nullish = false
      walkAst(callerFunc?.body, { enter: node => {
        if (nullish) return false
        const op = node[0]
        if ((op === 'let' || op === 'const') && node.length >= 2) {
          for (let i = 1; i < node.length; i++) {
            const d = node[i]
            if (Array.isArray(d) && d[0] === '=' && d[1] === name) {
              found = true
              if (mayBeNullish(d[2], nameNullable)) nullish = true
            }
          }
        } else if (op === '=' && node[1] === name) {
          found = true
          if (mayBeNullish(node[2], nameNullable)) nullish = true
        } else if (typeof op === 'string' && op.length > 1 && op.endsWith('=') &&
                   ASSIGN_OPS.has(op) && node[1] === name) {
          found = true
          nullish = true                          // ??=/||= etc. — fail closed
        }
      } })
      return found ? nullish : true               // unwritten name — fail closed
    }
    return nameNullable
  }
  for (const [fname, reps] of paramReps) {
    for (const [k, r] of reps) {
      if (r.val !== VAL.BIGINT || r.nullable) continue
      for (const cs of sitesByCallee.get(fname) ?? []) {
        if (k >= cs.argList.length) continue
        if (mayBeNullish(cs.argList[k], bodyNameNullable(cs.callerFunc))) {
          r.nullable = true
          break
        }
      }
    }
  }
  // Destructured-parameter default shared by the mayBeUndefined solver below.
  const isDestructuredParamBody = (func, pname) => {
    const b = func?.body
    const stmts = Array.isArray(b) && b[0] === '{}' && Array.isArray(b[1]) && b[1][0] === ';'
      ? b[1].slice(1) : (b != null ? [b] : [])
    for (const s of stmts) {
      if (Array.isArray(s) && s[0] === 'let' && Array.isArray(s[1]) && s[1][0] === '=' &&
          Array.isArray(s[1][1]) && (s[1][1][0] === '[' || s[1][1][0] === '{}') && s[1][2] === pname)
        return true
    }
    return false
  }
  // mayBeUndefined param propagation (Slice 2, .work/archive/todo.md
  // §deletion-sweep §3 "Param lattice") — the inter-procedural half of
  // the same fact Slice 1 (analyze.js analyzeValTypes) already seeds at decl
  // time. Uses the shared fail-closed destructured-param default (isDestructuredParamBody, reused verbatim —
  // no per-call-site proof mechanism exists for what a destructured element
  // ends up holding, so assume the worst), same call-site OR-fold shape.
  //
  // Deliberately NOT built on mayBeNullish/bodyNameNullable (the BIGINT-
  // nullable block's own machinery, above): mayBeNullish already fails
  // closed for ANY call/property read (kind.js's "missable" bucket), which
  // would make mayBeUndefined fire for nearly every param in the program —
  // the wrong breadth for a fact whose whole point (reps.js doc,
  // censusMaybeUndefinedKind arm 3) is staying tied to a dict/Map absent-key
  // provenance, not "any unproven expression". analyze.js's mayBeUndefinedRhs
  // already established this as a deliberately separate, narrower mechanism
  // from mayBeNullish (Slice 1's own comment); this block continues that
  // precedent into the whole-program half via exprMayBeUndefinedIn (kind.js —
  // censusShapedNode's ctx-independent shape test, needed here for the exact
  // reason bodyNameNullable's own comment gives: at this plan-time fixpoint,
  // no CALLER's ctx.func.localReps is installed, so the real (ctx-aware)
  // census would misread).
  //
  // An UNWRITTEN bare-name arg (a caller param/global/capture forwarded
  // straight through) contributes NO evidence and resolves false — unlike
  // nullable's blanket "unwritten → fail closed" (mayBeNullish's own
  // universal-nullability contract), mayBeUndefined's provenance is narrow
  // enough that "no trace to a census read" is the same honest default the
  // decl producer (Slice 1) already applies to every ordinary RHS.
  // presence: 'maybe-undef' sibling stamped alongside
  // r.mayBeUndefined at both writes below — same fail-closed
  // (destructured-param-body) and call-site-union sources, no 'present' arm
  // here (a param's positive-presence proof, if any, is settled at the
  // ARGUMENT's own decl site in the caller body, not something this
  // whole-program join independently proves).
  for (const [fname, reps] of paramReps) {
    for (const [k, r] of reps) {
      if (r.mayBeUndefined) continue
      const func = ctx.funcs.map?.get(fname)
      if (!func?.sig?.params || k >= func.sig.params.length) continue
      const pname = func.sig.params[k].name
      if (isDestructuredParamBody(func, pname)) { r.mayBeUndefined = true; r.presence = 'maybe-undef'; continue }
      for (const cs of sitesByCallee.get(fname) ?? []) {
        if (k >= cs.argList.length) continue
        const argNode = cs.argList[k]
        // Co-induction + interprocedural bounds proof (colorlog project,
        // .work/archive/todo.md "the co-induction prover") — see
        // arrayReadProvenInBounds's own doc above: censusShapedNode (inside
        // exprMayBeUndefinedIn below) over-approximates ANY `arr[idx]`
        // call-argument as possibly undefined, even a read that's PROVABLY
        // in-bounds by index arithmetic. Try the narrow, sound proof FIRST;
        // it only ever SKIPS evidence this join would otherwise count, never
        // adds any — so a shape it can't recognize just falls through to the
        // existing over-approximation below, unchanged.
        if (arrayReadProvenInBounds(argNode, cs.callerFunc, paramReps)) continue
        if (exprMayBeUndefinedIn(argNode, cs.callerFunc?.body)) { r.mayBeUndefined = true; r.presence = 'maybe-undef'; break }
      }
    }
  }

  // presentVal param propagation — the
  // inter-procedural half of the SAME fact analyze.js's `setPresentVal`
  // already seeds at decl/reassign time. Unlike mayBeUndefined's
  // boolean OR-fold just above, presentVal is an EXACT KIND claim (reps.js's
  // own doc: mutually exclusive with `val`, poison-on-disagreement, same
  // discipline as `val` itself) — so this fold is modeled on `hardParamVal`
  // above, NOT on the mayBeUndefined loop's OR/no-evidence-is-false shape:
  // every live call site's argument must independently resolve the SAME
  // presentVal kind (exprPresentValIn, kind.js — censusShapedNode's direct
  // arms plus a poison-disciplined bare-name trace through the CALLER's own
  // body, mirroring analyze.js's makeValTracker), or the whole param declines
  // (no claim — never a wrong one). A destructured param body is skipped
  // (not force-poisoned to a fake kind, unlike mayBeUndefined's fail-closed
  // `true`): "no per-call-site proof mechanism" means no EVIDENCE for an
  // exact-kind fact, and absence of a presentVal claim is always safe — every
  // consumer (censusMaybeUndefinedKind's arm 3) only ever gets asked "what
  // kind does the census claim", never "is this definitely a container
  // value", so under-claiming just forwards to the plain dynamic path,
  // never wrong.
  //
  // INVARIANT: this fact is what makes a param-hop BigInt unary shape
  // (`const f = (v) => -v; f(m.get('x'))`, present-key BIGINT) correct:
  // emitNeg's OR-arm (emit.js bigIntUnary) already asks
  // `censusMaybeUndefinedKind(v)` unconditionally —
  // nullableOperand/bigIntOperand/bigIntUnary need NO further widening for
  // that shape — so seeding `v`'s `presentVal` here is the ENTIRE fix; no
  // consumer-side change needed.
  const hardParamPresentVal = (funcName, k) => {
    let consensus
    const sites = sitesByCallee.get(funcName)
    if (!sites) return null
    for (const cs of sites) {
      const state = siteState(cs)
      if (!state) continue
      if (k >= state.argList.length) return null   // missing → undefined at runtime, no claim
      const v = exprPresentValIn(state.argList[k], state.callerFunc?.body)
      if (v == null) return null                    // an untraced site ⇒ no claim (fail-closed to "absent", never wrong)
      if (consensus === undefined) consensus = v
      else if (consensus !== v) return null          // disagreement ⇒ no claim
    }
    return consensus ?? null
  }
  for (const [fname, reps] of paramReps) {
    for (const [k, r] of reps) {
      if (r.presentVal) continue
      const func = ctx.funcs.map?.get(fname)
      if (!func?.sig?.params || k >= func.sig.params.length) continue
      const pname = func.sig.params[k].name
      if (isDestructuredParamBody(func, pname)) continue
      const v = hardParamPresentVal(fname, k)
      if (v != null) r.presentVal = v
      else {
        const sites = sitesByCallee.get(fname)
        if (sites?.some(cs => {
          const state = siteState(cs)
          return state && k < state.argList.length &&
            localMapGetMayCarryBigint(state.argList[k], state.callerFunc?.body)
        })) r.localMapBigintUnknown = true
      }
    }
  }

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

  // kindsCoverage (param-reps.js's Fact JSDoc + the
  // exclusion-projection contract): mark 'closed' ONLY for a func whose every
  // call site this fixpoint's `callSites` census actually enumerated — not
  // raw (no facts model), not exported (no external JS/host caller with
  // arbitrary args), and its name is not address-taken (no
  // indirect/first-class-value call — stored/passed/returned as a value —
  // that could invoke it outside the literal `f(...)` nodes `callSites`
  // tracked). Same predicate `narrowReturnArrayElems`'s own `targets` filter
  // already uses for the identical "have we truly seen every site" question
  // (line ~1010 above). DEFAULT stays 'open' (field absent) for every other
  // param — a wider possibleKinds set from more call sites is always safe to
  // ADD later; downgrading a wrongly-'closed' mark is not, so this only ever
  // marks 'closed' where the predicate holds, never guesses.
  for (const func of ctx.funcs.list) {
    if (func.raw || isExported(func) || addressTaken.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    for (const r of reps.values()) r.kindsCoverage = 'closed'
  }

  if (DBG_INVARIANTS) assertValKindConsistent(paramReps)
}

