import { OPTF, getFactStore, DBG_INVARIANTS } from '../ctx.js'
import { DBG_BIGINT_STATS, noteLocalBoxed } from './bigint-boxed-stats.js'
/**
 * Pre-analysis passes — type inference, local analysis, capture detection.
 *
 * # Stage contract
 *   IN:  prepared AST + ctx.funcs.list (from prepare).
 *   OUT: per-function populated `ctx.func.localReps` (val field) + `ctx.func.locals` + `ctx.func.boxed`,
 *        module-global `ctx.scope.globalValTypes`, type-analysis `ctx.func.typedElem` /
 *        `.dynKeyVars` / `.anyDynKey`.
 *
 * # Passes (all walk AST; none mutate AST itself — only ctx)
 *   - boxedCaptures:       detect mutably-captured vars → ctx.func.boxed cells
 *
 * Value KIND inference: src/kind.js. WASM local typing: src/type.js. Static eval: src/static.js.
 *
 * Ordering: all passes run per function during compile(). plan.js owns the
 * cross-function dynKey scan via programFacts (results land in ctx.types.dynKeyVars).
 *
 * @module analyze
 */

import { commaList, ASSIGN_OPS, MUTATE_OPS, isReassigned, STMT_OPS, isBlockBody, isLiteralStr, isFuncRef, I32_MIN, I32_MAX, isI32, T, extractParams, classifyParam, collectParamNames, collectAllBoundNames, alwaysReturns, returnExprs, refsName, REFS_IN_EXPR } from '../ast.js'
import { ctx, setLinkDemand } from '../ctx.js'
import { withFunctionField } from './flow-state.js'
import { forEachFunctionPlanRep, functionPlanRepField } from './function-plan.js'
import { VAL, repOf, repOfGlobal, updateRep, updateGlobalRep, lookupValType, lookupNotString, KIND_UNIVERSE } from '../reps.js'
import { valTypeOf, jsonConstString, shapeOf, shapeOfObjectLiteralAst, censusMaybeUndefinedKind } from '../kind.js'
import { intLiteralValue, nonNegIntLiteral, constIntExpr, intExprRange, NO_VALUE, staticPropertyKey, staticValue, staticObjectProps, staticArrayElems, objLiteralSchemaId, exprSchemaId, inlineArraySid, inplaceKey } from '../static.js'
import { typedElemCtor, typedStaticLen, MIXED_CTORS, isCondExpr, ternaryCtorOfRhs, scanBoundedLoops, scanBoundedArrIdx, inBoundsCharCodeAt, exprType, intCertainMap, intLevelMap, isTerminator } from '../type.js'
import { TYPED_ELEM_CODE, TYPED_ELEM_VIEW_FLAG, TYPED_ELEM_BIGINT_FLAG, encodeTypedElemAux, typedElemAux, TYPED_ELEM_NAMES, ctorFromElemAux } from '../../layout.js'

// ValueRep field docs + ParamReps lattice helpers — storage lives in src/reps.js.

// === ParamReps lattice helpers (cross-call fixpoint) ===
// programFacts.paramReps: Map<funcName, Map<paramIdx, ValueRep>>. Per-field lattice:
// undefined unobserved, null sticky-poison (cross-site disagreement), value = consensus.

// Cross-call argument inference helpers (`infer*`) live in src/infer.js.
// paramReps lattice lives in src/param-reps.js.

/**
 * Per-binding use-summary — the substrate the representation analyses share.
 *
 * One traversal classifies every mention of each `let`/`const` binding into a
 * closed taxonomy of use-kinds (`USE.*`). The eligibility analyses below
 * (`scanFlatObjects`, `scanSliceViews`, `unboxablePtrs`) are then *policies* —
 * subset predicates over this summary — rather than three independent body
 * re-walks. The classification logic is the union of those walks; a use-kind
 * exists for every distinction at least one consumer needs.
 *
 * Deliberately NOT a consumer: `analyzeBody`'s `escapes` map. It looks like a
 * fourth escape analysis but is not — it is context-sensitive *taint* over
 * value-expression positions (member access short-circuits, a static index
 * does not escape but a dynamic one does), woven into the main typing walk it
 * shares with six other facts. Re-expressing it here would need `BARE` split
 * by enclosing construct (a plain `name;` statement vs `return name`) and a
 * second traversal — adding a walk, not removing one. It stays where it is.
 *
 * Returns `Map<name, { decls, initRhs, uses }>` for every name the body
 * `let`/`const`-declares. `uses` is a `UseRecord[]`; a record is
 * `{ kind, key?, optional?, computed?, compound?, nullCmp?, callee?, argIndex? }`.
 *
 * Scoping: decls are collected only outside closures (a `let` inside a nested
 * `=>` is a different scope), but uses ARE collected inside closures — every
 * mention there becomes a `CAPTURE`, which every policy treats as
 * disqualifying. A binding shadowed by an inner closure decl is conservatively
 * still flagged `CAPTURE`; sound, since it only ever forfeits an optimization.
 *
 * Order-independent: uses bucket by name, so a mention before its decl is fine.
 */



// === param helpers / AST predicates ===

// === Param / closure helpers ===

/** Find free variables in AST: referenced in node, not in `bound`, present in `scope`. */
import {
  findFreeVars, findMutations, boxedCaptures,
  collectI32SafeIndexVars, collectF64StridedIndexVars, collectBareEscapes, narrowUint32, scanBindingUses,
  scanObjectArrayFacts, scanNumericFill, isFreshArrayCtor, USE,
  stampCoInductionRanges,
} from './analyze-scans.js'

export { findFreeVars, findMutations, boxedCaptures } from './analyze-scans.js'

// Stage 2 slice 3a: a plain Map, NOT a WeakMap. Lifecycle is explicit — one
// compile's bodies, cleared by resetBodyFactsCache at compile start — so weak
// semantics bought nothing, and in the self-compiled kernel the WeakMap's
// INVARIANT: this store must hold STRONG refs — a weak/arena-backed store
// rewound by a warm-instance `_clear` mid-lifecycle makes cache behavior
// timing-dependent. Strong refs are bounded by program size and dropped at
// the next reset.
// Session-owned (audit P1 stage 5) — getFactStore().bodyFacts, NOT a private
// module-level Map; see src/session.js's factStore DEPS table.
export function resetBodyFactsCache() { getFactStore().bodyFacts.clear() }

// Per-name monotone fact trackers over a pluggable {get,set,delete} store. First
// observation wins; a conflicting later one poisons the name (and clears the store
// entry) so a sibling-scope decl (jz hoists `let` to function scope) can't lock in
// the wrong value. The get/set/del closures abstract WHERE the slice lives, letting
// analyzeBody (local Map) and analyzeValTypes (ctx.func.localReps / ctx.func.typedElem)
// share one definition — so the two body walks can't drift. Passed as three positional
// closures rather than a {get,set,delete} store object: a Map satisfies that interface
// natively (analyzeBody's slices) but the analyzeValTypes slices need custom logic
// (updateRep), so the param would be polymorphic (Map | object) — which the self-compile
// kernel cannot statically type, mis-dispatching `store.set` on the object form to the
// Map builtin. Direct closure calls sidestep method dispatch entirely.
//
// An UNRESOLVABLE observation (`vt` null — `let sub = node[i]` where the RHS's type
// isn't provable) is STILL an observation and must poison exactly like a conflicting
// definite one, not merely a no-op when nothing was set yet. The walk has no CFG/
// dominance info, so it cannot tell a later definite write (`sub = 'nan'`) that
// UNCONDITIONALLY overwrites the unresolved initializer (safe to adopt) from one
// reachable only on some paths (`if (...) sub = 'nan'` — the initializer's value
// survives on the other path). Treating "unresolved" as "no information" let the
// conditional case's definite arm win outright: `valTypeOf(sub)` then reported
// STRING everywhere, so `content += sub` skipped ToString and read a raw NUMBER
// box as string bits — empty output instead of the number's digits. Poisoning here
// costs only the narrow straight-line-overwrite case (`let x = f(); x = 5` no longer
// infers NUMBER for the dead initializer) — "default is never wrong, only sometimes
// wider than necessary" (module header, src/infer.js).
const makeValTracker = (get, set, del) => {
  const poison = new Set()
  return (name, vt) => {
    if (poison.has(name)) return
    if (!vt) { poison.add(name); del(name); return }
    const prev = get(name)
    if (prev && prev !== vt) { poison.add(name); del(name); return }
    set(name, vt)
  }
}
const makeTypedTracker = (get, set, del, getLen, setLen, delLen) => {
  const poison = new Set()
  const invalidate = (name) => { poison.add(name); del(name); if (delLen) delLen(name) }
  // Resolve a variable-name ternary branch to its known typed-array ctor: a
  // local typed binding (`get`), or a module global promoted typed by plan
  // (`inferModuleLetTypes` populates `globalTypedElem`, copied into
  // `ctx.func.typedElem` per-func). Lets `let cur = flip ? bufA : bufB` keep
  // the fast typed-load path instead of decaying to `$__typed_idx`.
  const resolveName = (n) =>
    get(n) ?? ctx.func.typedElem?.get(n) ?? ctx.scope.globalTypedElem?.get(n) ?? null
  return (name, rhs) => {
    if (poison.has(name)) return
    const setOrInvalidate = (c) => {
      if (c === MIXED_CTORS) return invalidate(name)
      // Module-level alias fact: a `.view` ctor (subarray / buffer-backed) is the ONLY
      // way two typed-array bindings can overlap. Recording that the program creates
      // ANY view lets memory-reordering passes (SLP) stay sound by bailing when set —
      // with no view, distinct typed bases own disjoint allocations.
      if (typeof c === 'string' && c.endsWith('.view')) setLinkDemand('typedView')
      const prev = get(name)
      if (prev && prev !== c) invalidate(name)
      else {
        set(name, c)
        // Static length rides the ctor's stability (fixed-length arrays): a redef
        // with an unknown or conflicting length drops the entry — typedStaticLen is
        // null for subarray/copy/ternary/computed rhs, so those invalidate for free.
        // Same live-closure style as get/set/del (call-time ctx deref, per the
        // makeValTracker comment above — a captured Map would orphan on the
        // per-function ctx.types reset).
        if (setLen) {
          // A name alias (`let x = a` — the inliner's param-alias splice) carries
          // the source's static length: typed arrays never resize, and typedLen
          // facts are single-def-stable by construction (validate strips written
          // params; the tracker invalidates redefs), so the copy is exact.
          const len = typedStaticLen(rhs) ?? (typeof rhs === 'string'
            ? getLen(rhs) ?? ctx.func.typedLen?.get(rhs) ?? ctx.scope?.globalTypedLen?.get(rhs) ?? null
            : null)
          const prevLen = getLen(name)
          if (len == null || (prevLen !== undefined && prevLen !== len)) delLen(name)
          else setLen(name, len)
        }
      }
    }
    const ctor = typedElemCtor(rhs)
    if (ctor) return setOrInvalidate(ctor)
    // Bare name alias (`let x = a` — the inliner's param-alias splice): the
    // source's settled ctor and static length copy to the alias — typed arrays
    // never resize, and a buffer-sharing VIEW arrives via the subarray arm
    // below, never as a bare name. A name with no typed fact stays untracked
    // (same silence as today).
    if (typeof rhs === 'string') {
      const c = resolveName(rhs)
      if (c) return setOrInvalidate(c)
      return
    }
    // `recv.subarray(...)` is a zero-copy VIEW aliasing the receiver's buffer — its elem
    // ctor is the receiver's type with the `.view` flag, so the binding unboxes to a typed
    // pointer and element writes take the descriptor-indirected path (not desc-as-data).
    if (Array.isArray(rhs) && rhs[0] === '()' && Array.isArray(rhs[1]) && rhs[1][0] === '.'
        && rhs[1][2] === 'subarray' && typeof rhs[1][1] === 'string') {
      const recvCtor = resolveName(rhs[1][1])
      if (recvCtor) return setOrInvalidate((recvCtor.endsWith('.view') ? recvCtor.slice(0, -5) : recvCtor) + '.view')
      return
    }
    // TYPED-narrowed call result carries its elem aux on f.sig.ptrAux — reverse-map
    // to a canonical ctor so the unboxed local's rep restores the same aux.
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
      const f = ctx.funcs.map?.get(rhs[1])
      if (f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null) {
        const c = ctorFromElemAux(f.sig.ptrAux)
        if (c) setOrInvalidate(c)
      }
      return
    }
    // Field provenance: `const tw = plan.twRe` where the receiver's schema slot
    // holds one typed-array kind program-wide and the prop is never written
    // (gate inside slotTypedCtorAt) — the binding keeps the concrete kind, so
    // hot-loop reads stay on the typed path (bench: provenance, fftplan).
    if (Array.isArray(rhs) && (rhs[0] === '.' || rhs[0] === '?.') &&
        typeof rhs[1] === 'string' && typeof rhs[2] === 'string' && ctx.schema?.slotTypedCtorAt) {
      const fc = ctx.schema.slotTypedCtorAt(rhs[1], rhs[2])
      if (fc) return setOrInvalidate(fc)
    }
    // Heterogeneous ternary (`n===16 ? new Uint8Array(16) : new Uint16Array(8)`):
    // ctors that don't unify must invalidate so a sibling-scope decl can't lock in
    // the wrong store width.
    const tc = ternaryCtorOfRhs(rhs, resolveName)
    if (tc) setOrInvalidate(tc)
  }
}

/**
 * Unified per-body analysis — see module header for slice overview.
 * Returns cached facts; DO NOT MUTATE the returned maps.
 *
 * NOTE on the cache (root A): entries are body-keyed and CAN read ctx that mutates
 * during narrowing (a `let x = f()` local's wasm type shifts when f's result
 * narrows). The cache is therefore *intentionally staleable* — invalidation
 * belongs at the phase boundaries where a stale read would matter, not
 * "everywhere". A recompute-vs-cache assertion was tried (JZ_DEBUG_CACHE) and
 * abandoned: it fires on benign staleness (the suite stays green through the
 * divergence), so it can't tell a real missing-invalidation from a harmless
 * one. See .work/todo.md.
 *
 * Ownership: callers no longer
 * call invalidateLocalsCache directly — it stays exported only because the
 * seam primitives below (reanalyzeBody / setFuncBody / invalidateBodies /
 * invalidateAllBodyFacts) are themselves implemented on top of it. The two
 * bespoke plan/literals.js call sites (scalarize-
 * FunctionTypedArrays' post-loop flush, scalarizeFunctionObjectLiterals' pre-
 * rewrite drop) both predated setFuncBody (before this seam existed) and were never re-examined once it landed here; both are now fully
 * subsumed by setFuncBody's own invalidation of the node it
 * assigns — read-tested clean (full suite + JZ_DEBUG_INVARIANTS leg +
 * self-compile.js + kernel-parity, all green) — so they were deleted rather than
 * kept as ceremony. Every mutation of a function's AST now goes through
 * reanalyzeBody / setFuncBody / invalidateBodies / invalidateAllBodyFacts,
 * which fuse the mutation with its invalidation so there's no second call
 * left to forget. A narrower, targeted safety net catches what fusion can't:
 * a signature retype (param .type/.ptrKind/.ptrAux, sig.results/.ptrKind/
 * .ptrAux/.unsignedResult) surviving under a stale cache HIT is caught LIVE,
 * on every read (walk-count design B1, .work/walk-count-design.md §2.4/§5
 * item 3 — promoted from a JZ_DEBUG_INVARIANTS-only assert-and-crash to an
 * always-on cache-coherence gate): a `sigFingerprint` mismatch on a hit
 * transparently invalidates and recomputes once inline instead of returning
 * the stale entry or a caller having to know to distrust it — see the gate
 * itself, right below, for why this is scoped to signatures and not the full
 * ambient staleness JZ_DEBUG_CACHE tried and failed at.
 */
export function analyzeBody(body) {
  // Non-object bodies (`() => 0`, `() => x`, missing) have nothing to observe
  // for any slice and can't be WeakMap-keyed. Return empty maps without caching.
  if (body === null || typeof body !== 'object') return {
    locals: new Map(), valTypes: new Map(), arrElemSchemas: new Map(), arrElemSchemaSets: new Map(),
    arrElemValTypes: new Map(), arrElemTypedCtors: new Map(), typedElems: new Map(), escapes: new Map(),
    flatObjects: new Map(),
  }
  const bodyFacts = getFactStore().bodyFacts
  const hit = bodyFacts.get(body)
  if (hit) {
    // B1 live freshness gate (walk-count design §2.4/§5 item 3): a hit whose
    // __sig no longer matches this function's CURRENT signature was cached
    // under an earlier, not-yet-final signature/fact state (e.g.
    // narrow.js's refreshCallerLocals, a plan-time speculative-hypothesis
    // write that deliberately leaves its entry for the next reader to
    // distrust — see sigFingerprint's own doc). Drop it and fall through to
    // a real recompute instead of returning stale locals/valTypes. Skips
    // whenever either side is null — no reference to compare against is
    // "unknown", not "known unchanged" (same fail-open rule the former
    // DBG_INVARIANTS-only assertBodyFactsFresh used).
    if (hit.__sig == null || !ctx.func.current || hit.__sig === sigFingerprint(ctx.func.current))
      return hit
    bodyFacts.delete(body)
  }

  const locals = new Map()
  const valTypes = new Map()
  const arrElemSchemas = new Map()
  const arrElemSchemaSets = new Map()  // name → Set<sid> | null — closed heterogeneous union
  const arrElemValTypes = new Map()
  // Nested element kind: `name`'s elements are themselves arrays whose elements
  // share this VAL.*. Lets `chord = padChord[i]; chord[j]` (floatbeat pad voicings,
  // `padChord = [[0,2,4],…]`) bind `chord`'s arrayElemValType through one index step,
  // so `chord[j]` is a Number and skips __to_num. Single-level only — enough for the
  // 2-D table pattern without a general nested-type lattice.
  const arrElemElemValTypes = new Map()
  // `name`'s elements are all typed arrays of one ctor ('new.Float32Array'), e.g.
  // `Array.from(nCh, () => new Float32Array(n))` (codec channelData). Lets `arr[i]`
  // resolve as that typed array so `arr[i][j]` / `let o = arr[i]; o[j]` inline.
  const arrElemTypedCtors = new Map()
  const typedElems = new Map()
  const typedLens = new Map()
  const escapes = new Map() // name → bool: local holds allocation, true if it escapes

  const doSchemas = !!ctx.schema?.register
  // Per-walk local schema map for chained `arr.push(name)` resolution.
  const localSchemaMap = new Map()

  // === Observation helpers ===
  //
  // These trust the AST: any `arr.push(...)` syntactically present has `arr` as
  // a body-relevant name (decl, param, or global) since closure boundaries are
  // skipped at walk time. Pure typo names produce harmless dead Map entries
  // that are never queried (consumers index by known local/param names).
  // Removing the legacy `ctx.func.locals.has(arr)` filter makes analyzeBody's
  // output context-pure — cache hits don't depend on transient ctx state.

  const observeArrSchema = (arr, sid) => {
    if (!doSchemas) return
    if (typeof arr !== 'string') return
    // Set lattice rides every singular observation: sid disagreement ACCUMULATES
    // (the tagged-union stream — 8 record variants pushed into one array) while
    // an unknown-schema source (sid == null) poisons both lattices. The closed
    // union is what discriminant refinement and union-agreeing slot reads
    // consume; the singular fact keeps its monomorphic consumers unchanged.
    if (arrElemSchemaSets.get(arr) !== null) {
      if (sid == null) arrElemSchemaSets.set(arr, null)
      else {
        let s = arrElemSchemaSets.get(arr)
        if (!s) arrElemSchemaSets.set(arr, s = new Set())
        s.add(sid)
      }
    }
    if (arrElemSchemas.get(arr) === null) return
    if (sid == null) { arrElemSchemas.set(arr, null); return }
    if (!arrElemSchemas.has(arr)) arrElemSchemas.set(arr, sid)
    else if (arrElemSchemas.get(arr) !== sid) arrElemSchemas.set(arr, null)
  }

  const observeArrValType = (arr, vt) => {
    if (typeof arr !== 'string') return
    if (arrElemValTypes.get(arr) === null) return
    if (!vt) { arrElemValTypes.set(arr, null); return }
    if (!arrElemValTypes.has(arr)) arrElemValTypes.set(arr, vt)
    else if (arrElemValTypes.get(arr) !== vt) arrElemValTypes.set(arr, null)
  }

  const elemValOf = (name) => {
    if (typeof name !== 'string') return null
    const repVt = ctx.func.localReps?.get(name)?.arrayElemValType
    if (repVt) return repVt
    return arrElemValTypes.get(name) || null
  }

  // Disagreement → null poison, like observeArrValType. Records the common
  // TypedArray ctor of an array's elements.
  const observeArrTypedCtor = (arr, ctor) => {
    if (typeof arr !== 'string') return
    if (arrElemTypedCtors.get(arr) === null) return
    if (!ctor) { arrElemTypedCtors.set(arr, null); return }
    if (!arrElemTypedCtors.has(arr)) arrElemTypedCtors.set(arr, ctor)
    else if (arrElemTypedCtors.get(arr) !== ctor) arrElemTypedCtors.set(arr, null)
  }
  // The ctor a `new XxxArray(...)` element expr produces ('new.Float32Array'), if any.
  const elemTypedCtorOf = (expr) => {
    const c = typedElemCtor(expr)
    // typed-array views/buffers only — exclude ArrayBuffer/DataView (no element index).
    return c && !c.includes('ArrayBuffer') && !c.includes('DataView') ? c : null
  }

  // A literal negative index or a non-numeric STRING-literal key addresses a
  // PROPERTY, not an element (mirrors kind.js VT['[]']'s own guard — keep the
  // two in sync, they classify the same AST shape for the same reason: typing
  // a property read by the receiver's element kind would fold a `'@@iterator'
  // in arr`-style guard on a false premise).
  const isElemAccessKey = (key) => {
    const li = intLiteralValue(key)
    if (li != null) return li >= 0
    const lit = Array.isArray(key) && key.length === 2 && key[0] == null ? key[1]
      : Array.isArray(key) && key[0] === 'str' ? key[1] : undefined
    return !(typeof lit === 'string' && !/^(0|[1-9][0-9]*)$/.test(lit))
  }

  const exprElemSourceVal = (expr) => {
    if (typeof expr === 'string') {
      // Prefer this body walk's settled local slice. localReps is intentionally
      // sparse and globalValTypes cannot describe locals; omitting valTypes made
      // `let s = ...; strings.push(s)` poison an otherwise monomorphic array.
      const localVt = valTypes.get(expr)
      if (localVt) return localVt
      const repVt = ctx.func.localReps?.get(expr)?.val
      if (repVt) return repVt
      return ctx.scope.globalValTypes?.get(expr) || null
    }
    // One-hop element read `recv[i]` whose RECEIVER is a name this SAME body
    // walk already has an element-kind fact for (elemValOf: rep ∪ this walk's
    // in-progress arrElemValTypes — the identical fallback `elemValOf` already
    // uses for the alias case below). Lets `probes.push(words[i])` observe
    // probes' element kind as STRING when `words` is itself a body-local array
    // built earlier in program order (a call-return array, e.g. `buildWords()`)
    // — kind.js's generic valTypeOf can't see this walk's in-progress facts, only
    // settled localReps, so a receiver that's a LOCAL (not a param) with no rep
    // yet fell through to null here and poisoned the pushed-to array (the class
    // reverted before: see .work/todo.md "WORDCOUNT TRUE ROOT"). Deterministic
    // and safe to read mid-walk: the receiver's own decl is processed earlier in
    // this same forward, program-order pass (`arrElemValTypes` is a fresh Map per
    // analyzeBody call, so re-walks after a caller-side fact settles converge to
    // the same answer — no cross-invocation staleness). Try this FIRST (more
    // precise than valTypeOf can be here); fall through unchanged otherwise —
    // never overrides or bypasses the elemOrigin-gated observation this reads.
    if (Array.isArray(expr) && expr[0] === '[]' && expr.length === 3 && typeof expr[1] === 'string'
        && isElemAccessKey(expr[2])) {
      const v = elemValOf(expr[1])
      if (v) return v
    }
    return valTypeOf(expr)
  }

  // Common element VAL of an array-literal node (`[a,b,c]`), or null if not a literal
  // or its elements disagree. Used to read one level into an array-of-arrays literal.
  const arrLitElemCommonVal = (litNode) => {
    const raw = staticArrayElems(litNode)
    if (!raw) return null
    const items = raw.filter(e => e != null)
    if (!items.length || items.length !== raw.length) return null
    let common = exprElemSourceVal(items[0])
    for (let k = 1; k < items.length && common != null; k++) {
      if (exprElemSourceVal(items[k]) !== common) common = null
    }
    return common
  }

  // Names declared (`let`/`const`) in THIS body. A reassignment to any OTHER
  // name — a parameter or a captured outer binding — merges with an entry
  // value of caller-/outer-determined kind, so a POINTER-kind RHS must POISON
  // the val slice, not settle it: `if (Array.isArray(x)) …; else x = ['str', v]`
  // on a param would otherwise stamp x ARRAY flow-insensitively and const-fold
  // the very guard that proves it isn't (the kernel's JSON.parse-emitter
  // head-coercion — array-typed reads on a string, memory OOB). Scalar kinds
  // (NUMBER/BOOL/BIGINT) and coupled-tracker kinds (TYPED/BUFFER, whose trackTyped slice owns coherence) keep the settled-kind behavior: the i32-narrowing
  // machinery's locals/val coherence depends on it (unswitch reassigned-param
  // guard), and scalar guards don't take part in the ptr-tag fold class.
  const declared = new Set()
  // Names whose INITIAL element contents this body fully described: a decl whose
  // array-literal elems were all statically visible (including the empty `[]`).
  // Mutation observations (push / index-write) describe only elements ADDED here —
  // they may settle an element fact only when the pre-existing contents are also
  // known (elemOrigin, or an entry already recorded from a construction source:
  // call-return fact, split/map chain, literal elems). A push on a PARAM or an
  // unknown-origin alias proves nothing about the elements the array arrived
  // with — watr's `outline(ast)` pushes `['func',…]` nodes onto the module tree,
  // which settled arrayElemValType=ARRAY for the heterogeneous ['module', …]
  // param and const-folded the very `ast[0] !== 'module'` guard protecting it
  // (emitStrictEq's differing-primitive fold → outline dead in-kernel). Skip,
  // don't poison: the array simply stays untyped, and a caller-proven preseed
  // (index.js param facts) survives unchallenged.
  const elemOrigin = new Set()
  const poisonUndeclared = (name, vt) =>
    !declared.has(name) && vt != null && vt !== VAL.NUMBER && vt !== VAL.BOOL && vt !== VAL.BIGINT && vt !== VAL.TYPED && vt !== VAL.BUFFER ? null : vt

  // Local-Map slices: bind the Map's get/set/delete as the tracker's three ops.
  const trackVal = makeValTracker(n => valTypes.get(n), (n, vt) => valTypes.set(n, vt), n => valTypes.delete(n))
  const trackTyped = makeTypedTracker(n => typedElems.get(n), (n, c) => typedElems.set(n, c), n => typedElems.delete(n),
    n => typedLens.get(n), (n, l) => typedLens.set(n, l), n => typedLens.delete(n))

  // === Per-decl observation (called for each `let`/`const` `name = rhs`) ===
  const processDecl = (name, rhs) => {
    declared.add(name)
    // wasm type (locals slice). A `>>> 0` result is an unsigned uint32 that doesn't fit a
    // *signed* i32, so a binding initialized from one must be f64 — else reads and arithmetic
    // see the value as negative for inputs ≥ 2³¹. But `x >>> k` with a constant shift k where
    // (k & 31) ≥ 1 lands in [0, 2³¹−1] (max 0xFFFFFFFF >>> 1 = 0x7FFFFFFF), which DOES fit a
    // signed i32 — keep it on the fast integer path (FFT index math: `nn >>> 1`, `n2 >>> 2`).
    // Only `>>> 0` (and variable shifts, which could be 0) need widening. (ToUint32 accumulators
    // init from a literal and narrowUint32 re-narrows them — so this only governs `let u = x >>> k`.)
    const shr = Array.isArray(rhs) && rhs[0] === '>>>'
    const shrFitsI32 = shr && Array.isArray(rhs[2]) && rhs[2][0] == null
      && typeof rhs[2][1] === 'number' && (rhs[2][1] & 31) >= 1
    const wt = (shr && !shrFitsI32) ? 'f64' : exprType(rhs, locals)
    if (!locals.has(name)) locals.set(name, wt)
    else if (locals.get(name) === 'i32' && wt === 'f64') locals.set(name, 'f64')
    // Stamp the closed integer hull EARLY (mirrors analyzeValTypes's own later
    // declRange stamping below in this file, same predicate: a never-reassigned
    // decl whose init the range evaluator can bound). This copy exists because
    // of a real ordering gap: `exprType`'s `*` case needs a magnitude BOUND on
    // each operand (intExprRange → repOf(name).range) to prove a product fits
    // i32, and that bound must be visible from THIS SAME top-down walk — one
    // decl chaining off the previous (`raw` → `tri` → `dq`, the delayline q16
    // split) — not just from analyzeValTypes's separate walk, which runs its
    // own stamping AFTER analyzeBody (and this widenLocalTypes-feeding walk)
    // already finished, too late for a later sibling decl in the SAME body to
    // see an earlier one's bound. Without this, `tri`'s range is invisible
    // when `dq = DMIN*65536 + tri*DSPAN` is typed here, `bound(tri)` falls to
    // the unproven 2^31 default, `dq*` fails the magnitude check, and `dq`
    // starts life as f64 storage — permanently, since widenLocalTypes only
    // ever DEMOTES i32→f64, never promotes the other way. Confirmed via a
    // minimal repro isolating the exact mechanism (not guessed).
    const declRange = intExprRange(rhs)
    if (declRange && Number.isFinite(declRange[0]) && Number.isFinite(declRange[1]) && !isReassigned(body, name))
      updateRep(name, { range: declRange })

    // val type (valTypes slice)
    trackVal(name, valTypeOf(rhs))

    // typed-array element ctor (typedElems slice)
    trackTyped(name, rhs)

    // arr-elem schema (arrElemSchemas slice) — schema bindings + array-literal init + alias + call return
    if (doSchemas) {
      const sid = exprSchemaId(rhs, localSchemaMap)
      if (sid != null) localSchemaMap.set(name, sid)
      {
        const rawElems = staticArrayElems(rhs)
        if (rawElems) {
          const elems = rawElems.filter(e => e != null)
          if (elems.length && elems.length === rawElems.length) {
            let common = exprSchemaId(elems[0], localSchemaMap)
            for (let k = 1; k < elems.length && common != null; k++) {
              if (exprSchemaId(elems[k], localSchemaMap) !== common) common = null
            }
            if (common != null) observeArrSchema(name, common)
          }
        }
      }
      if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
        const f = ctx.funcs.map?.get(rhs[1])
        if (f?.arrayElemSchema != null) observeArrSchema(name, f.arrayElemSchema)
        // Return-channel closed union ('a,b,…' canonical key from
        // narrowReturnArrayElems): fold each member through the observer —
        // the set lattice unions, the singular lattice poisons. Exactly right.
        else if (typeof f?.arrayElemSchemaSet === 'string')
          for (const sid of f.arrayElemSchemaSet.split(',')) observeArrSchema(name, +sid)
      }
      if (typeof rhs === 'string' && arrElemSchemas.has(rhs)) {
        const sid2 = arrElemSchemas.get(rhs)
        if (sid2 != null) observeArrSchema(name, sid2)
        else { const s2 = arrElemSchemaSets.get(rhs); if (s2) for (const sid of s2) observeArrSchema(name, sid) }
      }
      if (typeof rhs === 'string') {
        const repSid = ctx.func.localReps?.get(rhs)?.arrayElemSchema
        if (repSid != null) observeArrSchema(name, repSid)
        else { const rs = ctx.func.localReps?.get(rhs)?.arrayElemSchemaSet; if (rs) for (const sid of rs) observeArrSchema(name, sid) }
      }
    }

    // arr-elem val type (arrElemValTypes slice) — array-literal init + call return + alias + .map/.filter/.slice/.concat chain
    {
      const rawElems = staticArrayElems(rhs)
      if ((rawElems && rawElems.every(e => e != null)) || isFreshArrayCtor(rhs)) elemOrigin.add(name)
      if (rawElems) {
        const elems = rawElems.filter(e => e != null)
        if (elems.length && elems.length === rawElems.length) {
          let common = exprElemSourceVal(elems[0])
          for (let k = 1; k < elems.length && common != null; k++) {
            if (exprElemSourceVal(elems[k]) !== common) common = null
          }
          if (common != null) observeArrValType(name, common)
          // Array-of-typed-arrays literal (`[new Float32Array(n), …]`): record the
          // common element ctor so `name[i]` is a known typed array.
          if (common === VAL.TYPED) {
            let ctor = elemTypedCtorOf(elems[0])
            for (let k = 1; k < elems.length && ctor != null; k++)
              if (elemTypedCtorOf(elems[k]) !== ctor) ctor = null
            observeArrTypedCtor(name, ctor)
          }
          // Array-of-arrays literal: record the common element-of-element kind so a
          // later `x = name[i]` binds `x`'s element type one level down.
          if (common === VAL.ARRAY) {
            let nested = arrLitElemCommonVal(elems[0])
            for (let k = 1; k < elems.length && nested != null; k++) {
              if (arrLitElemCommonVal(elems[k]) !== nested) nested = null
            }
            if (nested != null) arrElemElemValTypes.set(name, nested)
          }
        }
      }
      // `x = arr[i]` where `arr` is a known array-of-arrays → `x`'s elements take
      // `arr`'s nested element kind (the missing index-step in observeArrValType).
      // `arr` may be a function-local (arrElemElemValTypes) or a module-level const
      // table (global rep, recorded by recordGlobalRep) — the latter dynWrite-guarded.
      if (Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 && typeof rhs[1] === 'string') {
        const nested = arrElemElemValTypes.get(rhs[1])
          ?? (!ctx.func.localReps?.has(rhs[1]) && !ctx.types?.dynWriteVars?.has(rhs[1])
                ? ctx.scope.globalReps?.get(rhs[1])?.arrayElemElemValType : null)
        if (nested) observeArrValType(name, nested)
      }
    }
    if (Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string') {
      const f = ctx.funcs.map?.get(rhs[1])
      if (f?.arrayElemValType) observeArrValType(name, f.arrayElemValType)
    }
    // `Array.from(arg, () => new XxxArray(...))` — codec channelData and per-row
    // typed-array tables. The map-callback's returned ctor is every element's type.
    // Post-prepare AST: `['()', 'Array.from', [',', arg, callback]]` (args in a comma node).
    if (Array.isArray(rhs) && rhs[0] === '()' && rhs[1] === 'Array.from' && Array.isArray(rhs[2])) {
      const args = rhs[2][0] === ',' ? rhs[2].slice(1) : [rhs[2]]
      const fn = args[1]
      const body = Array.isArray(fn) && fn[0] === '=>' ? fn[2] : null
      const ret = Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === 'return'
        ? body[1][1] : body
      const ctor = ret && elemTypedCtorOf(ret)
      if (ctor) { observeArrValType(name, VAL.TYPED); observeArrTypedCtor(name, ctor) }
    }
    if (typeof rhs === 'string') {
      const v = elemValOf(rhs)
      if (v) observeArrValType(name, v)
    }
    if (Array.isArray(rhs) && rhs[0] === '()' &&
        Array.isArray(rhs[1]) && rhs[1][0] === '.' &&
        typeof rhs[1][1] === 'string') {
      const recvName = rhs[1][1], method = rhs[1][2]
      if (method === 'filter' || method === 'slice' || method === 'concat') {
        const v = elemValOf(recvName)
        if (v) observeArrValType(name, v)
      } else if (method === 'split' && valTypeOf(recvName) === VAL.STRING) {
        observeArrValType(name, VAL.STRING)
      } else if (method === 'map') {
        const arrowFn = rhs[2]
        const recvVt = elemValOf(recvName)
        const param = Array.isArray(arrowFn) && arrowFn[0] === '=>' ? arrowFn[1] : null
        const paramName = typeof param === 'string' ? param :
          (Array.isArray(param) && param[0] === '()' && typeof param[1] === 'string' ? param[1] : null)
        const arrowBody = paramName ? arrowFn[2] : null
        const exprBody = (Array.isArray(arrowBody) && arrowBody[0] === '{}' &&
          Array.isArray(arrowBody[1]) && arrowBody[1][0] === 'return') ? arrowBody[1][1] : arrowBody
        if (paramName && exprBody != null) {
          const refs = ctx.func.refinements
          const hadParam = refs?.has(paramName)
          const prev = hadParam ? refs.get(paramName) : undefined
          if (refs && recvVt) refs.set(paramName, { val: recvVt })
          let bodyVt = null
          try { bodyVt = valTypeOf(exprBody) }
          finally {
            if (refs && recvVt) {
              if (hadParam) refs.set(paramName, prev); else refs.delete(paramName)
            }
          }
          if (bodyVt) observeArrValType(name, bodyVt)
        }
      }
    }
    if (Array.isArray(rhs) && rhs[0] === '()' &&
        Array.isArray(rhs[1]) && rhs[1][0] === '.' && rhs[1][2] === 'split' &&
        valTypeOf(rhs[1][1]) === VAL.STRING) {
      observeArrValType(name, VAL.STRING)
    }
  }

  // arrElem invalidation rule — fires on `=` reassign of tracked name to non-array
  const isArrayProducingRhs = (rhs) =>
    Array.isArray(rhs) && (staticArrayElems(rhs) != null ||
      (rhs[0] === '()' && Array.isArray(rhs[1]) && rhs[1][0] === '.' &&
       (rhs[1][2] === 'slice' || rhs[1][2] === 'concat')))

  const markEscape = (name) => { if (escapes.has(name)) escapes.set(name, true) }

  const isStaticIndex = (key) =>
    typeof key === 'number' || typeof key === 'string' ||
    (Array.isArray(key) && ((key[0] == null && Number.isInteger(key[1])) || key[0] === 'str')) ||
    staticPropertyKey(key) != null

  const markEscapeValue = (expr) => {
    if (typeof expr === 'string') { markEscape(expr); return }
    if (!Array.isArray(expr)) return
    const op = expr[0]
    if (op === 'str') return
    if (op === ':') { markEscapeValue(expr[2]); return }
    if ((op === '.' || op === '?.') && typeof expr[1] === 'string' && escapes.has(expr[1])) return
    if (op === '[]' && typeof expr[1] === 'string' && escapes.has(expr[1])) {
      if (!isStaticIndex(expr[2])) markEscape(expr[1])
      markEscapeValue(expr[2])
      return
    }
    for (let i = 1; i < expr.length; i++) markEscapeValue(expr[i])
  }

  const markEscapeArgs = (args) => {
    if (args == null) return
    const list = Array.isArray(args) && args[0] === ',' ? args.slice(1) : [args]
    for (const a of list) markEscapeValue(Array.isArray(a) && a[0] === '...' ? a[1] : a)
  }

  // === Round-3/4 boxed-bigint intra-body W-sink walk ===
  // (design .work/carrier-representation-design.md §3.2 — clone of the escapes precedent
  // above: same single-pass walk, same "mark the binding, don't re-derive later"
  // shape.) A bare-name value proven VAL.BIGINT that reaches one of these AST
  // positions must round-trip through a real PTR.BIGINT box (ir.js boxBigInt/
  // unboxBigInt, Step 2) — inline (non-name) BIGINT expressions at a sink are
  // boxed at emission time directly from the AST shape, no rep needed. Call-arg/
  // return to a KNOWN user function are the narrow.js/emit.js inter-function
  // half (design §3.3) — skipped here to avoid a redundant, weaker verdict.
  const markBigintSink = (expr) => {
    if (typeof expr !== 'string' || valTypeOf(expr) !== VAL.BIGINT) return
    updateRep(expr, { bigintBoxed: true })
    // Three-store unification (ledger 2026-08-19 watr-slice core): marking a
    // PARAM on the seeded local rep alone leaves the CALL SITES passing raw
    // carriers (coerceArg reads sig.params' own bigintBoxed, stamped by
    // narrow's boundary verdict) while body reads deref the slot — the
    // boundary/local disagreement behind the uleb miscompile. Write the flip
    // through to the shared sig so every call site boxes the argument; AFE
    // completes before any call-site emission, so the stamp is always seen.
    // ctx.func.current can be null here (top-level analysis passes) — resolve
    // the owning function by the mangled name, which is globally unique.
    let sp = ctx.func.current?.sig?.params?.find(pp => pp.name === expr)
    if (!sp) for (const fo of ctx.funcs.list) {
      const q = fo.sig?.params?.find(pp => pp.name === expr)
      if (q) { sp = q; break }
    }
    if (sp) sp.bigintBoxed = true
    if (DBG_BIGINT_STATS) noteLocalBoxed(ctx.func.current?.name ?? '(top)', expr)
  }
  // Whole-body outer-scope set (mirrors boxedCaptures' own `outerScope`,
  // analyze-scans.js): every name THIS analyzeBody call's own `body` binds
  // via let/const (not crossing a nested `=>`) plus its params. Computed
  // once, upfront — deliberately NOT the incrementally-built `locals` map
  // above, which would still be missing a later-declared outer local at an
  // early arrow site (unsound: a genuine capture of a later-in-source outer
  // local would silently go unflagged). Feeds markBigintCapture's
  // findFreeVars call below as the real "is this actually one of my
  // enclosing function's own bindings" filter.
  const bigintOuterScope = new Set()
  ;(function collectOuterDecls(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'let' || op === 'const') collectParamNames(args, bigintOuterScope)
    for (const a of args) collectOuterDecls(a)
  })(body)
  if (ctx.func.current?.params) for (const p of ctx.func.current.params) bigintOuterScope.add(p.name)
  // BigInt retirement residual-site rule 2 (.work/bigint-retirement-
  // design.md §5): reuse the SAME free-variable computation the real
  // closure-conversion machinery trusts (boxedCaptures' findFreeVars,
  // analyze-scans.js) instead of this walk's own former ad-hoc "every
  // non-param name is a capture" pass. That cruder walk's `bound` held only
  // the arrow's OWN params, so it misclassified TWO distinct non-capture
  // shapes as "needs a box": (a) a name the arrow declares itself via its
  // own `let`/`const` (found live: watr's `i64.parse`'s `bi` local — not a
  // capture at all, bound within the very closure being scanned), and (b) a
  // reference to a module-level global (found live: watr's `F64_SIGN`/
  // `F64_NAN`/`F64_QUIET` consts, referenced from inside `f64` once `f64`
  // itself undergoes closure conversion — a global is never placed in a
  // closure's per-instance env, so there is nothing to box/unbox). findFreeVars
  // already tracks (a) correctly (it grows `bound` as it walks a nested
  // `let`/`const`, mirroring real lexical scoping) and `bigintOuterScope`
  // closes (b) (a name not bound by THIS enclosing function is never added
  // to `free`, matching boxedCaptures' own — already-verified-correct — capture
  // set exactly, so a genuine outer-local capture, e.g. the original
  // assemble.js shape Slice 0 fixed by hand, still triggers here precisely
  // as before).
  const markBigintCapture = (arrowNode) => {
    const bound = collectParamNames(extractParams(arrowNode[1]))
    const free = []
    findFreeVars(arrowNode[2], bound, free, bigintOuterScope)
    for (const n of free) markBigintSink(n)
  }
  const BIGINT_COLLECTION_METHODS = new Set(['push', 'unshift', 'add', 'set'])
  const DATAVIEW_SETBIG_RE = /^setBig(Int|Uint)64$/

  // === Single walk ===
  function walk(node) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') { markBigintCapture(node); return }  // don't cross closure boundary

    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        // analyzeBody: bare-name decl
        if (typeof a === 'string') { if (!locals.has(a)) locals.set(a, 'f64'); continue }
        if (!Array.isArray(a) || a[0] !== '=') continue
        // analyzeBody: destructuring decl — set destructured names to f64, walk rhs only
        if (typeof a[1] !== 'string') {
          for (const n of collectParamNames([a[1]])) if (!locals.has(n)) locals.set(n, 'f64')
          walk(a[2])
          continue
        }
        const name = a[1], rhs = a[2]
        processDecl(name, rhs)
        if (Array.isArray(rhs) && (rhs[0] === '[' || rhs[0] === '{}')) {
          escapes.set(name, false)
        }
        markEscapeValue(rhs)
        // Walk rhs only — never enter the `=` node so the reassignment-invalidation
        // rule won't misfire on the binding's own initializer.
        walk(rhs)
      }
      return
    }

    if (op === 'return' && node[1] != null) {
      markEscapeValue(node[1])
    }

    if (op === '()' && node.length > 2) {
      markEscapeArgs(node[2])
    }

    // arr.push(...) — observe both schemas and val types in one pass. Mutation
    // evidence describes only the ADDED elements — each slice may settle only
    // when the array's prior contents are known (elemOrigin decl, or an entry
    // this body already recorded from a construction source); see elemOrigin.
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && node[1][2] === 'push' && typeof node[1][1] === 'string') {
      const arr = node[1][1]
      const originVal = elemOrigin.has(arr) || arrElemValTypes.has(arr)
      const originSchema = elemOrigin.has(arr) || arrElemSchemas.has(arr) || arrElemSchemaSets.has(arr)
      const originCtor = elemOrigin.has(arr) || arrElemTypedCtors.has(arr)
      const list = commaList(node[2])
      for (const a of list) {
        if (Array.isArray(a) && a[0] === '...') {
          if (originSchema) observeArrSchema(arr, null)
          if (originVal) observeArrValType(arr, null)
          continue
        }
        if (originSchema) observeArrSchema(arr, exprSchemaId(a, localSchemaMap))
        if (originVal) observeArrValType(arr, exprElemSourceVal(a))
        // `ch.push(new Float32Array(m))` — track the element ctor so `ch[c][i]`
        // inlines, same as the Array.from / array-literal forms.
        if (originCtor && exprElemSourceVal(a) === VAL.TYPED) observeArrTypedCtor(arr, elemTypedCtorOf(a))
      }
    }

    // `ch[c] = new Float32Array(m)` — index-fill construction of a typed-array-of-
    // arrays (`let ch = new Array(n); for(c) ch[c] = new T(m)`). Mirror push,
    // including the known-origin gate (an index-write on a param array proves
    // nothing about its other elements).
    if (op === '=' && Array.isArray(node[1]) && node[1][0] === '[]' && node[1].length === 3
        && typeof node[1][1] === 'string' && valTypeOf(node[2]) === VAL.TYPED
        && (elemOrigin.has(node[1][1]) || arrElemValTypes.has(node[1][1]) || arrElemTypedCtors.has(node[1][1]))) {
      observeArrValType(node[1][1], VAL.TYPED)
      observeArrTypedCtor(node[1][1], elemTypedCtorOf(node[2]))
    }

    // `=` reassignment — locals widen, valTypes/typedElems track,
    // arrElemSchemas/ValTypes invalidate when rhs isn't array-producing.
    if (op === '=' && typeof node[1] === 'string') {
      const name = node[1], rhs = node[2]
      walk(rhs)
      markEscape(name)
      markEscapeValue(rhs)
      const wt = exprType(rhs, locals)
      if (locals.has(name) && locals.get(name) === 'i32' && wt === 'f64') locals.set(name, 'f64')
      trackVal(name, poisonUndeclared(name, valTypeOf(rhs)))
      trackTyped(name, rhs)
      if (arrElemSchemas.has(name) && !isArrayProducingRhs(rhs)) observeArrSchema(name, null)
      if (arrElemValTypes.has(name) && !isArrayProducingRhs(rhs)) observeArrValType(name, null)
      if (arrElemTypedCtors.has(name) && !isArrayProducingRhs(rhs)) observeArrTypedCtor(name, null)
      return
    }

    // compound-assign widening (locals slice)
    if ((op === '+=' || op === '-=' || op === '*=' || op === '%=') && typeof node[1] === 'string') {
      const name = node[1], opChar = op[0]
      const t = exprType([opChar, node[1], node[2]], locals)
      if (locals.has(name) && locals.get(name) === 'i32' && t === 'f64') locals.set(name, 'f64')
    }
    if (op === '/=' && typeof node[1] === 'string') {
      if (locals.has(node[1])) locals.set(node[1], 'f64')
    }

    if (op === 'for' || op === 'for-in' || op === 'for-of') {
      if (node[1] != null) markEscapeValue(node[1])
    }

    if (op === '[' || op === '{}') {
      for (let i = 1; i < node.length; i++) {
        const c = node[i]
        if (Array.isArray(c) && c[0] === ',') {
          for (let j = 1; j < c.length; j++) {
            if (Array.isArray(c[j]) && c[j][0] === '...') markEscapeValue(c[j][1])
          }
        } else if (Array.isArray(c) && c[0] === '...') {
          markEscapeValue(c[1])
        }
      }
    }

    // Round-3/4 boxed-bigint W-sinks (design §2, rows 1-3/6/8) — dyn-prop/array-
    // elem store, Set.add/Map.set/Array.push-family, DataView.setBig64, and the
    // ternary-nullish BIGINT carry (kind.js VT['?:'] — the one kind with no
    // runtime tag today; round-4 gives it a real one, so its merged value needs
    // the same box-on-write treatment as any other kind-erased sink).
    //
    // Proven-TYPED-receiver exemption (BigInt retirement residual-site rule
    // 3, .work/bigint-retirement-design.md §5): `recv[i] = bigintExpr` where
    // `recv` is a PROVEN TYPED array (BigInt64Array/BigUint64Array — the only
    // ctor a real BIGINT RHS can target without a runtime TypeError) is the
    // design's own explicit kept-raw exemption, ALREADY implemented on the
    // consuming side (emit-assign.js's `arrProvenTyped`, `lookupValType(arr)
    // === 'typed'` — mirrored verbatim here). This producing side lacked the
    // same exemption: every `[]`-headed write unconditionally boxed its
    // BIGINT-kinded name, even when the receiver's own ctor already fixes
    // the element kind with no ambiguity whatsoever (each element's kind is
    // fixed by the array's ctor at every read — .work/bigint-retirement-
    // design.md §4's "kept-raw contract"). Found live: watr's own `i64.parse`
    // (`node_modules/watr/src/encode.js`) — `_i64[0] = bi` unconditionally
    // boxed `bi` even though `_i64` is a `const _i64 = new BigInt64Array(...)`
    // and `bi` is never used anywhere else ambiguously. `.`/`?.` stay
    // unexempted — an OBJECT/schema-slot write is exactly the dynamic,
    // kind-erasing sink this W-sink exists for; only a `[]`-headed TYPED
    // receiver has a ctor-fixed element kind.
    if (ASSIGN_OPS.has(op) && Array.isArray(node[1]) &&
        (node[1][0] === '.' || node[1][0] === '[]' || node[1][0] === '?.')) {
      const provenTypedRecv = node[1][0] === '[]' && typeof node[1][1] === 'string' &&
        lookupValType(node[1][1]) === VAL.TYPED
      if (!provenTypedRecv) markBigintSink(node[2])
    }

    if (op === '?:') {
      const [, , a, b] = node
      if (valTypeOf(node) === VAL.BIGINT) {
        const nullish = (n) => n === 'undefined' || (Array.isArray(n) && ((n.length === 2 && n[0] == null && n[1] == null) || n.length === 0))
        if (nullish(b)) markBigintSink(a)
        else if (nullish(a)) markBigintSink(b)
      }
    }

    if (op === '()') {
      const callee = node[1]
      const rawArgs = node[2]
      const argList = Array.isArray(rawArgs) && rawArgs[0] === ',' ? rawArgs.slice(1) : (rawArgs != null ? [rawArgs] : [])
      const method = Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') && typeof callee[2] === 'string' ? callee[2] : null
      if (method && DATAVIEW_SETBIG_RE.test(method)) {
        for (const a of argList) markBigintSink(Array.isArray(a) && a[0] === '...' ? a[1] : a)
      } else if (method && BIGINT_COLLECTION_METHODS.has(method)) {
        for (const a of argList) markBigintSink(Array.isArray(a) && a[0] === '...' ? a[1] : a)
      } else if (typeof callee === 'string' && (callee.startsWith('BigInt') || callee.startsWith('Atomics.'))) {
        // Pure bigint-value transforms (BigInt.asIntN/asUintN) and Atomics ops
        // (compile-time-proven receiver, design §2 W-sink 8 exemption) — not
        // kind-erasing; leave the arithmetic-core raw path alone.
      } else if (typeof callee !== 'string' || !ctx.funcs.map?.has(callee)) {
        // Unresolvable target — external import, unclassified builtin, or
        // computed/closure dispatch through a value — fail-closed per design
        // §3.1: can't prove the callee's param treats this argument as
        // BIGINT, so box it before the call. A string callee IN ctx.funcs.map
        // (a known user function) is the narrow.js/emit.js call-site half
        // (design §3.3) instead — not duplicated here.
        for (const a of argList) markBigintSink(Array.isArray(a) && a[0] === '...' ? a[1] : a)
      }
    }

    if (op === '[]' && typeof node[1] === 'string' && escapes.has(node[1])) {
      const key = node[2]
      if (!isStaticIndex(key)) markEscape(node[1])
    }

    for (let i = 1; i < node.length; i++) walk(node[i])
  }

  // Install the in-progress valTypes as a lookup overlay so successive decls
  // resolve chains (`const a = new TypedArr(); const b = a[0]` → b: NUMBER)
  // and shorthand-bound `{a}` props see a's type. Restored after walk completes.
  let unsignedLocals, numericFill
  withFunctionField('localValTypesOverlay', valTypes, () =>
    withFunctionField('localTypedElemsOverlay', typedElems, () => {
    walk(body)
    // Co-induction accumulator fact (INDUCTION-VARIABLE FACT project,
    // analyze-scans.js's own header doc): durably stamps a body-local
    // accumulator's proven range BEFORE widenLocalTypes' Pass D runs, so its
    // bare-escape check (e.g. `return op` after the loop) sees a real hull
    // instead of blaming an unranged reassigned local into f64 storage.
    stampCoInductionRanges(body)
    widenLocalTypes(body, locals)
    // Narrow proven uint32 accumulator locals to unsigned i32. Runs post-widen so
    // a local already demoted to f64 above (e.g. compared against an f64) is
    // reconsidered with final types — and stays f64, since a relational compare
    // is a non-transparent read that disqualifies narrowing anyway.
    unsignedLocals = narrowUint32(body, locals)
    // Numeric-fill arrays — fresh `Array(n)`/`[]` whose every element write stores a
    // Number, so `a[i]` reads can skip __to_num (the win `[1,2,3]` already gets, for the
    // construct-then-fill kernel shape). Runs HERE, inside the val-type overlay, so a
    // write of a bare numeric local (`a[i] = out`) resolves via the just-built `valTypes`.
    // A bare read of the array's OWN elements (`a[i] = a[j]`, heapsort) is Numeric by
    // induction; any genuinely non-numeric write still fails the test and disqualifies.
    const numericFillRhs = (rhs, selfName) => {
      if (Array.isArray(rhs) && rhs[0] === '[]' && rhs[1] === selfName) return true
      if (typeof rhs === 'string') return valTypes.get(rhs) === VAL.NUMBER || exprElemSourceVal(rhs) === VAL.NUMBER
      return valTypeOf(rhs) === VAL.NUMBER
    }
    numericFill = scanNumericFill(body, numericFillRhs)
  }))

  // SRoA: dissolve non-escaping object-literal bindings into field locals.
  // The dead `o` local is dropped — every `o` reference is rewritten by the
  // codegen flat hooks, so a stray `local.get $o` becomes a loud wasm
  // validation error instead of a silent miscompile.
  //
  // No-copy slice views (`let t = s.slice(...)` bindings proven non-escaping,
  // consumed by emitDecl to lower the initializer to a SLICE_BIT view) and
  // never-relocated array bindings (reads may skip the realloc-forwarding
  // follow) are independent post-overlay facts over the same body — no
  // cross-dependency between the three (walk-count design A1,
  // .work/walk-count-design.md §1.3/§5 item 1) — so one fused scan computes
  // all three instead of three separate full-body scans.
  const { flatObjects, sliceViews, neverGrown } = doSchemas
    ? scanObjectArrayFacts(body)
    : { flatObjects: new Map(), sliceViews: new Set(), neverGrown: new Set() }
  for (const [name, props] of flatObjects) {
    for (let i = 0; i < props.names.length; i++) locals.set(`${name}#${i}`, 'f64')
    locals.delete(name)
  }

  const result = { locals, valTypes, arrElemSchemas, arrElemSchemaSets, arrElemValTypes, arrElemTypedCtors, typedElems, typedLens, escapes, flatObjects, sliceViews, unsignedLocals, neverGrown, numericFill }
  // null (not '') when ctx.func.current is unset at capture time — some legitimate
  // callers (plan/literals.js's AST-rewrite passes, narrow.js's refreshCallerLocals)
  // never set it, and a bare '' would then collide with a genuinely-empty signature's
  // real fingerprint. null is an explicit "no reference to compare against" sentinel —
  // see the live freshness gate above (cache-hit path), which skips the check
  // whenever either side is null. Always computed (walk-count design B1) — this
  // is the cache-coherence contract now, not a debug-only extra.
  result.__sig = ctx.func.current ? sigFingerprint(ctx.func.current) : null
  bodyFacts.set(body, result)
  return result
}

/** Signature fingerprint of the WASM-type fields a retyping pass can flip:
 *  param .type/.ptrKind/.ptrAux and sig.results/.ptrKind/.ptrAux/
 *  .unsignedResult. Consulted on every bodyFacts cache-hit read (analyzeBody,
 *  above) to catch a retype of THIS body's OWN function signature surviving
 *  underneath an entry captured before the retype — the "silent stale-types
 *  miscompile" class session.js's DEPS table calls out, and exactly the
 *  shape every hypothesis-probe / emit-time site in narrow.js and index.js
 *  used to pair an invalidate with an immediate re-read to avoid (see
 *  reanalyzeBody below) before this gate went live (walk-count design B1,
 *  .work/walk-count-design.md §2.4/§5 item 3 — promoted from a
 *  JZ_DEBUG_INVARIANTS-only assert-and-crash to an always-on check whose
 *  mismatch now self-heals via recompute instead of throwing).
 *
 *  Deliberately NARROW, not a full recompute-and-compare: JZ_DEBUG_CACHE
 *  tried that and was abandoned (.work/todo.md) because it fired on ambient
 *  staleness the design accepts as benign (ctx.func.localReps /
 *  ctx.func.typedElem overlay swaps, ctx.schema.slotI32Certain rounds — the
 *  bodyFacts row's own "intentionally staleable" comment above analyzeBody).
 *  A signature fingerprint mismatch is never benign: the cached
 *  locals/valTypes were derived from param/result WASM types that no longer
 *  hold, so it alone is worth checking on every read.
 *
 *  Relies on ctx.func.current tracking "whose signature is this read
 *  happening under" — the same save/restore idiom every retyping pass
 *  already wraps its analyzeBody calls in. A caller that never sets it
 *  (plan/literals.js's AST-rewrite passes; narrow.js's refreshCallerLocals,
 *  which retypes ambient overlays, not the signature) captures/reads `null`
 *  on that side; the gate SKIPS whenever either side is null — no reference
 *  to compare against is "unknown", not "known unchanged", so it fails open
 *  rather than false-firing on a caller that was never part of this
 *  contract. */
function sigFingerprint(sig) {
  if (!sig) return ''
  let s = ''
  for (const p of sig.params) s += p.type + '.' + (p.ptrKind ?? '') + '.' + (p.ptrAux ?? '') + ','
  return s + '|' + sig.results.join(',') + '|' + (sig.ptrKind ?? '') + '.' + (sig.ptrAux ?? '') + '.' + (sig.unsignedResult ?? '')
}

/**
 * Post-walk wasm-type widening over `locals`, in place — analyzeBody stage 2.
 *
 * Pass A (widenPass): i32 locals compared against f64 widen — EXCEPT integer
 * counters used as affine array indices (collectI32SafeIndexVars: i32-range
 * proven, direct indexing with no per-access trunc_sat) and integer-certain
 * locals (intCertainMap: every definition integer-valued). An f64 counter
 * would poison the loop body's arithmetic and the increment (f64.add per
 * iteration), the dominant cost of `for (i<n) acc=(acc+i)|0` — measured ~18×
 * vs V8 before this. The compare coerces the counter once. Sound for n ≤ 2³¹
 * (the asm.js-style integer contract); a fractional assignment poisons
 * intCertain → widens normally.
 *
 * Pass B (assignment fixpoint): re-resolve decl/assign RHS types now that
 * pass A widened. `let x2 = zx*zx` declared i32 because zx was i32 at scan
 * time must widen when zx re-types to f64 — else trunc_sat silently floors
 * the fractional value (mandelbrot escape: 3.515 → 3). Re-checks `=` and
 * compound assigns too: a single-pass walk sees each assign once with stale
 * operand types, missing widens through loop back-edges. keepI32 vars are
 * exempt: a hoisted product `o = y*w` types f64 but is proven integer.
 * Monotonic (i32 → f64 only), bounded by locals count.
 *
 * Pass D: Pass A/B's
 * `keepI32`/exprType checks are magnitude-blind BY DESIGN (a value merely
 * STORED i32 is safe regardless of magnitude ONLY WHEN every read re-applies
 * the same ToInt32 the write did — type.js's widening invariant (load-bearing perf
 * tradeoff) — so an intCertain-but-UNBOUNDED (intLevelMap level 1: `+`/`-`/
 * `*` are "integral-closed, range-open") local that grows past i32 range via
 * a compound-assign NEVER widens through them. That premise breaks the
 * instant such a local is ALSO read bare with no governing comparison
 * anywhere (collectBareEscapes) — `id` after `id *= 100000` / `id += d`
 * (the FFT-butterfly KNOWN-FAIL, test/inference.js). Level 2 (STRICT
 * i32-range-safe by construction: literals, bitwise ops, comparisons,
 * Math.imul/clz32) needs no check — every value it can hold already fits i32.
 */
function widenLocalTypes(body, locals) {
  const i32SafeIdx = collectI32SafeIndexVars(body, locals)
  // Names this scope's own locals map might be reassigned FROM INSIDE A NESTED
  // ARROW — a captured, mutated variable. analyzeBody runs before boxedCaptures
  // populates ctx.func.boxed, so recompute the same "some arrow writes this
  // name" fact locally via findMutations (which already doesn't skip `=>`).
  // Threaded into intCertainMap and both widening walks below: none of them
  // used to look past a `=>` boundary, so `let env = 0; let set = () => { env
  // = 1.5 }` never saw the closure-body float write — `env` stayed provably-int
  // (keepI32 exempted it from Pass A, Pass B never re-checked its only visible
  // def, the never-a-def-of-1.5 one), and the ENCLOSING FUNCTION's own result
  // then narrowed to i32 (narrowI32Results trusts this same `locals` map),
  // silently truncating the return. Gated on nestedNames.size so the common
  // case (no nested reassignment anywhere) keeps the original, cheaper walk.
  const nestedNames = new Set()
  findMutations(body, new Set(locals.keys()), nestedNames)
  // Raw levels (not the collapsed intCertainMap boolean): level 2 (STRICT
  // i32-range-safe by construction — literals, bitwise ops, comparisons,
  // Math.imul/clz32) needs no further check below, but level 1 (integral,
  // UNBOUNDED magnitude — `id *= 100000`, `id += d`) rests on the SAME
  // magnitude-blind "every read re-applies ToInt32" premise
  // collectI32SafeIndexVars' back-propagation does, and Pass D below closes
  // the identical gap for it (see .work/todo.md KNOWN GAP #1 sibling note).
  const intLevels = intLevelMap(body, nestedNames)
  const intCounters = new Map(); for (const [n, l] of intLevels) intCounters.set(n, l >= 1)
  const f64IdxVars = collectF64StridedIndexVars(body, locals)  // counters that trunc anyway — don't keep i32
  const keepI32 = (name) => i32SafeIdx.has(name) || (intCounters.get(name) === true && !f64IdxVars.has(name))
  const CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!='])
  const widenPass = (node) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (CMP_OPS.has(op)) {
      const [a, b] = args
      const ta = exprType(a, locals), tb = exprType(b, locals)
      if (ta === 'i32' && tb === 'f64' && typeof a === 'string' && locals.has(a) && !keepI32(a)) locals.set(a, 'f64')
      if (tb === 'i32' && ta === 'f64' && typeof b === 'string' && locals.has(b) && !keepI32(b)) locals.set(b, 'f64')
    }
    if (op === '=>') { if (nestedNames.size) widenPass(args[1]) }
    else for (const a of args) widenPass(a)
  }
  widenPass(body)

  let widened = true
  while (widened) {
    widened = false
    const recheck = (node) => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === '=>') { if (nestedNames.size) recheck(node[2]); return }
      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const a = node[i]
          if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') {
            const name = a[1], rhs = a[2]
            if (locals.get(name) === 'i32' && exprType(rhs, locals) === 'f64' && !keepI32(name)) {
              locals.set(name, 'f64'); widened = true
            }
          }
        }
      }
      if (op === '=' && typeof node[1] === 'string') {
        const name = node[1], rhs = node[2]
        if (locals.get(name) === 'i32' && exprType(rhs, locals) === 'f64' && !keepI32(name)) {
          locals.set(name, 'f64'); widened = true
        }
      }
      if ((op === '+=' || op === '-=' || op === '*=' || op === '%=') && typeof node[1] === 'string') {
        const name = node[1]
        if (locals.get(name) === 'i32' && exprType([op[0], name, node[2]], locals) === 'f64' && !keepI32(name)) {
          locals.set(name, 'f64'); widened = true
        }
      }
      if (op === '/=' && typeof node[1] === 'string') {
        const name = node[1]
        if (locals.get(name) === 'i32') { locals.set(name, 'f64'); widened = true }
      }
      for (let i = 1; i < node.length; i++) recheck(node[i])
    }
    recheck(body)
  }

  // Pass D: close the level-1 sibling of collectI32SafeIndexVars' own bare-
  // escape gap. Passes A-C above all keep i32 storage via MAGNITUDE-BLIND
  // exprType checks (a value merely STORED i32 is safe regardless of
  // magnitude ONLY WHEN every read re-applies the same ToInt32 conversion
  // the write did — the P0-2 ledger's own load-bearing perf tradeoff, kept
  // exactly as-is here) — so an intCertain-but-unbounded (level 1) local
  // that grows past i32 range via a compound-assign/assign NEVER widens
  // through them, by design. That premise breaks the instant such a local
  // is ALSO read bare with no governing comparison anywhere (the loop-
  // counter "sound for n<=2^31" tolerance is scoped to compared names only,
  // untouched — collectBareEscapes' own compared-name exemption) — `id`
  // after `id *= 100000` / `id += d` (test/inference.js's FFT-butterfly
  // KNOWN-FAIL). Level 2 (STRICT i32-range-safe by construction) needs no
  // check: every value it can ever hold already fits i32.
  let level1I32 = false
  for (const [name, level] of intLevels) if (level === 1 && locals.get(name) === 'i32') { level1I32 = true; break }
  if (level1I32) {
    const bareEscapes = collectBareEscapes(body, locals)
    for (const [name, level] of intLevels)
      if (level === 1 && locals.get(name) === 'i32' && bareEscapes.has(name)) locals.set(name, 'f64')
  }
}

/** Drop the cached analyzeBody entry for this body. Used by emitFunc after
 *  seeding cross-call param VAL facts so the next walk picks up fresh
 *  `ctx.func.localReps` (drives exprType receiver-type lookups).
 *  Same hook as `invalidateValTypesCache` — split names preserve caller intent. */
export function invalidateLocalsCache(body) {
  if (body && typeof body === 'object') getFactStore().bodyFacts.delete(body)
}

/**
 * Solver-owned bodyFacts mutation seam (audit P1 next-slice — see the DEPS
 * table in session.js). The 14 pre-slice call sites across narrow.js/
 * index.js/plan/literals.js/plan/index.js each independently paired a raw
 * invalidateLocalsCache(body) with a later read or write and TRUSTED the
 * author to keep the pairing intact — a dropped half is the "forgotten
 * invalidation ⇒ silent stale-types miscompile" class the DEPS table names.
 * These three functions collapse every such pairing into ONE call so there
 * is no second half left to forget:
 *
 *   reanalyzeBody(body, read?)  — the "mutate ambient state, then read THIS
 *     body's facts under the new state" pattern (hypothesis-probing param/
 *     result narrowing in narrow.js; the params/localReps/typedElem/schema
 *     overlay reseed immediately before an emit-time read in index.js).
 *     Invalidates, then performs the read (default: analyzeBody(body); pass
 *     `read` when the actual analyzeBody call is inside a callee, e.g.
 *     narrow.js's evalTails). The read is unreachable without the
 *     invalidate — there is no way to call this and skip it.
 *
 *   setFuncBody(func, node)     — the "structurally rewrite this function's
 *     AST" pattern (plan/literals.js's loop unrolling / scalarization /
 *     literal promotion). Assigns func.body AND drops any bodyFacts entry
 *     for the new node in one step, covering both a fresh node (no-op
 *     delete, cheap) and an in-place-mutated same-identity node (a real,
 *     otherwise-easy-to-forget delete). Also the reason bindingUses' "no
 *     surgical invalidation" contract (session.js DEPS table) stays honest:
 *     every AST-rewriting pass reaches func.body through here, so a
 *     restructured body is always a NEW object identity by construction,
 *     and scanBindingUses' body-keyed cache naturally misses on it instead
 *     of serving stale binding-use facts for the old shape.
 *
 *   invalidateBodies(bodies) / invalidateAllBodyFacts() — the phase-boundary
 *     bulk flush (many bodies invalidated together, no immediate read):
 *     narrow.js's per-phase sweeps, narrowReturnArrayElems's per-target
 *     sweep, plan/index.js's post-narrowing flush before emit begins. Named
 *     so a new phase boundary reaches for the existing primitive instead of
 *     re-deriving its own `for (const f of ctx.funcs.list) invalidateLocalsCache(f.body)`.
 *
 * Ambient-overlay staleness (ctx.func.localReps / ctx.func.typedElem /
 * ctx.schema.slotI32Certain changing WITHOUT a signature retype) stays the
 * documented "intentionally staleable" surface above analyzeBody — the live
 * sigFingerprint freshness gate (analyzeBody's cache-hit path) deliberately
 * does not cover it; see sigFingerprint's own doc for why. A pass that seeds
 * one of those overlays and needs a fresh read still routes through
 * reanalyzeBody, same as before — this slice changes WHO owns forgetting,
 * not what the overlay contract permits.
 */
export function reanalyzeBody(body, read = () => analyzeBody(body)) {
  invalidateLocalsCache(body)
  return read()
}

/** Replace `func.body` and drop any bodyFacts entry for the new node — see
 *  the seam doc above `invalidateLocalsCache`. */
export function setFuncBody(func, node) {
  func.body = node
  invalidateLocalsCache(node)
}

/** Invalidate a known set of bodies (funcs already filtered by the caller —
 *  e.g. narrowReturnArrayElems's `targets`). See the seam doc above. */
export function invalidateBodies(bodies) {
  for (const body of bodies) invalidateLocalsCache(body)
}

/** Invalidate every non-raw function body's bodyFacts entry — the
 *  phase-boundary flush used when a signature-level fact just settled that
 *  arbitrarily many caller bodies may have read stale (narrowing's own
 *  callerLocals/valTypes lattices, or the final flush before emit begins).
 *  See the seam doc above. */
export function invalidateAllBodyFacts() {
  for (const func of ctx.funcs.list) if (func.body && !func.raw) invalidateLocalsCache(func.body)
}

// Can this RHS expression produce null/undefined? FAIL-CLOSED: anything not
// STRUCTURALLY provable non-nullish counts nullable. The flag's only effect
// is suppressing emit.js's strictSentinel constant fold (the comparison pays
// a cheap runtime nullish check instead) plus capture propagation — while a
// wrong non-nullable verdict FOLDS AWAY a real miss guard. The old shape
// list (nullish literals + ternary arms only) was sound while opaque sources
// carried no value kind (no kind ⇒ no fold); the Map/element value-kind
// inference broke that assumption: the self-compile kernel's own
// `autoCache.get(name) !== undefined` cache probe folded to TRUE (the get's
// rep carried the map's value kind, non-nullable) and every autoDepsOf call
// returned the miss sentinel unconditionally — the byte-parity root.
const NEVER_NULLISH_OPS = new Set([
  'str', 'bigint', '//', '{}', '[', '=>', 'new', 'bool',
  '+', '-', '*', '/', '%', '**', '|', '&', '^', '~', '<<', '>>', '>>>',
  '==', '!=', '===', '!==', '<', '>', '<=', '>=', '!', 'u-', 'u+',
  'typeof', 'in', 'instanceof', '++', '--',
])
// `nameNullable` resolves a bare-name read; the default reads the CURRENT
// function's rep (emit-time callers). narrow.js passes its own resolver — at
// plan time no caller's ctx.func is installed, so it re-derives nullability
// from the caller body's writes instead. Exported for exactly that consumer.
export function mayBeNullish(n, nameNullable = (name) => !!repOf(name)?.nullable) {
  if (typeof n === 'number' || typeof n === 'boolean') return false
  // name read: inherit the source binding's settled flag (best-effort — an
  // unsettled rep reads false, matching the old behavior for plain aliases)
  if (typeof n === 'string') return nameNullable(n)
  if (!Array.isArray(n)) return true
  const op = n[0]
  if (op == null) return n[1] == null                    // [null, v] literal value
  if (op === '?' || op === '?:') return mayBeNullish(n[2], nameNullable) || mayBeNullish(n[3], nameNullable)
  // `a && b` yields a (when falsy — possibly nullish) or b; `a || b` / `a ?? b`
  // yield a only when truthy/non-nullish, so only b's nullability matters.
  if (op === '&&') return mayBeNullish(n[1], nameNullable) || mayBeNullish(n[2], nameNullable)
  if (op === '||' || op === '??') return mayBeNullish(n[2], nameNullable)
  if (op === '=') return mayBeNullish(n[2], nameNullable) // assignment expression yields its rhs
  if (op === ',') return mayBeNullish(n[n.length - 1], nameNullable)
  if (typeof op === 'string' && (NEVER_NULLISH_OPS.has(op) || op.startsWith('new.'))) return false
  // calls (incl. `.get()` misses), member/element reads, optional chains,
  // and anything unrecognized: missable — fail closed.
  return true
}

// Decl-time producer for the `mayBeUndefined` REP field
// (.work/todo.md §deletion-sweep §2/§3 Slice 1) — the
// container-read sibling of `mayBeNullish` above, deliberately NOT folded
// into it: `mayBeNullish` answers "could this expression itself be a nullish
// LITERAL/merge", or with a Map/dict a `.get()`/`[]` call already fails
// closed (returns true) whether or not the census can name an exact
// non-nullish kind for it — `mayBeUndefined` answers the NARROWER question
// this design needs, "does the census's SPECIFIC exact-kind claim for this
// RHS need the mayBeUndefined carve-out", which only a direct
// censusMaybeUndefinedKind-recognized node or an already-flagged bare-name
// copy can answer. Two arms, no recursion through ternary/&&/||/`,` (unlike
// mayBeNullish's full walk) — deliberately narrow, matching Slice 1's scope
// per the design's own "smaller surface" instruction; a composed RHS
// (`cond ? m.get(k) : 0`) is out of scope until a later slice extends this.
const mayBeUndefinedRhs = (rhs) =>
  censusMaybeUndefinedKind(rhs) != null || (typeof rhs === 'string' && !!repOf(rhs)?.mayBeUndefined)

/** True iff `name` appears in `body` ONLY as the receiver of an indexed read
 *  `name[k]` (the lean-dict idiom) — a bare reference, a `.`-target, or any
 *  other position disqualifies. ITERATIVE (explicit worklist) by necessity:
 *  the original nested self-recursive closure (`verify` capturing `name` +
 *  `body`) MISCOMPILED under the self-compiled kernel into non-termination —
 *  the `h[dk]=v` dict idiom sent the dist kernel leg red (bisected to
 *  83d6add5's analyze.js additions; a depth cap and a `seen` identity-guard
 *  both failed, so the divergence is in the kernel's closure-call ABI, below
 *  JS control flow — a worklist sidesteps the fragile construct entirely).
 *  The kernel two-level-capture-recursion miscompile is ledgered for its own
 *  dissection. Module-scope so no capture, no recursion. */
function dictWalkLean(body, name) {
  const stack = [body]
  let plainRead = false
  while (stack.length) {
    const n = stack.pop()
    if (typeof n === 'string') { if (n === name) return false; continue }
    if (!Array.isArray(n)) continue
    const op = n[0]
    if (op === '=>' || op === 'str') continue
    // WRITE/RMW target `name[k] (op)= v`: the ephemeral-slot upsert serves it.
    // Inside the RHS, the RMW's OWN read (structurally equal to the target —
    // emit-assign's _rmwStructEq fuses exactly that) is part of the same slot
    // op; any OTHER same-name `[]` in the RHS is a plain read → reject below.
    if (ASSIGN_OPS.has(op) && Array.isArray(n[1]) && n[1][0] === '[]' && n[1][1] === name) {
      const tgt = JSON.stringify(n[1])
      if (n[1][2] != null) stack.push(n[1][2])
      const pushSkippingFused = (m) => {
        if (!Array.isArray(m)) { stack.push(m); return }
        if (m[0] === '[]' && m[1] === name && JSON.stringify(m) === tgt) { if (m[2] != null) stack.push(m[2]); return }
        if (m[0] === '[]' && m[1] === name) { stack.push(m); return }   // plain read — rejected by the arm below
        for (let i = 1; i < m.length; i++) pushSkippingFused(m[i])
      }
      for (let i = 2; i < n.length; i++) pushSkippingFused(n[i])
      continue
    }
    // PLAIN READ of the dict: the lean/ephemeral write layout is only sound to
    // read back when the read tolerates a fresh/zero slot — i.e. when EVERY
    // read is immediately bitwise-coerced (the i32-dict rule: missing → 0 is
    // the documented ToInt32 semantics). An uncoerced read (`d[k] === undefined`,
    // `d[k] <= 5`) against eph-written memory got garbage in-bounds or walked
    // OOB (the loop-built-dict trap class). Flag it; the final verdict defers
    // to dictWalkI32, which validates the every-read-coerced property.
    if (op === '[]' && n[1] === name) { plainRead = true; if (n[2] != null) stack.push(n[2]); continue }
    if ((op === ':' || op === '.' || op === '?.') && n.length >= 3) { stack.push(n[op === ':' ? 2 : 1]); continue }
    // let/const: the decl values; every other op: all children.
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (op === 'let' || op === 'const') {
        if (Array.isArray(c) && c[0] === '=') { if (c[2] != null) stack.push(c[2]) }
        else stack.push(c)
      } else stack.push(c)
    }
  }
  return !plainRead || dictWalkI32(body, name)
}

const I32_DICT_BITWISE = new Set(['&', '|', '^', '<<', '>>', '>>>'])
/** Count/histogram dict test: `name` used only as `name[k]`, every READ
 *  immediately bitwise-coerced and every WRITE a discarded statement (so the
 *  slot may keep only ToInt32 bits). ITERATIVE for the same reason as
 *  dictWalkLean — the original nested self-recursive `walk` (four captured
 *  params + mutated outer state) is the exact shape the self-compiled kernel
 *  miscompiled into non-termination (bisected culprit of the 83d6add5
 *  kernel-leg red). Module-scope, worklist of (node,parent,pos,grand). */
function dictWalkI32(body, name) {
  let reads = 0, writes = 0
  const stack = [[body, null, -1, null]]
  while (stack.length) {
    const [n, parent, pos, grand] = stack.pop()
    if (!Array.isArray(n) || n[0] === '=>') continue
    if (n[0] === '[]' && n[1] === name) {
      if (parent && ASSIGN_OPS.has(parent[0]) && pos === 1) {
        writes++
        // Only an expression statement discards the value; in a
        // condition/update replacing the boxed result with ToInt32 is observable.
        if (!(grand && (grand[0] === ';' || grand[0] === '{}'))) return false
      } else {
        reads++
        if (!(parent && I32_DICT_BITWISE.has(parent[0]))) return false
      }
      if (n[2] != null) stack.push([n[2], n, 2, parent])
      continue
    }
    for (let i = 1; i < n.length; i++) stack.push([n[i], n, i, parent])
  }
  return reads > 0 && writes > 0
}

/** Preallocation-hint domain for a computed-key dict `name`: the single array
 *  `dom` such that every `name[k] = …` uses a key `k = dom[i]` (a missed/wrong
 *  alias only costs a resize, never semantics). ITERATIVE for the same reason
 *  as dictWalkLean/dictWalkI32 — the original TWO nested self-recursive
 *  closures (`collect`, `scan`, both capturing outer state) are the kernel-
 *  fragile shape (83d6add5 leg red). Module-scope, two worklist passes. */
function dictDomainOf(body, name) {
  // Pass 1: single-def `let/const x = value` map (clashing names dropped).
  const defs = new Map(), clashes = new Set()
  let stack = [body]
  while (stack.length) {
    const n = stack.pop()
    if (!Array.isArray(n) || n[0] === '=>') continue
    if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
        if (defs.has(d[1])) clashes.add(d[1]); else defs.set(d[1], d[2])
      }
    }
    for (let i = 1; i < n.length; i++) stack.push(n[i])
  }
  for (const n of clashes) defs.delete(n)
  const sourceOf = (idx) => {
    const e = typeof idx === 'string' ? defs.get(idx) : idx
    return Array.isArray(e) && e[0] === '[]' && typeof e[1] === 'string' ? e[1] : null
  }
  // Pass 2: every `name[k] = …` must draw k from one shared domain array.
  let domain = null, bad = false, writes = 0
  stack = [body]
  while (stack.length) {
    const n = stack.pop()
    if (!Array.isArray(n) || n[0] === '=>') continue
    if (ASSIGN_OPS.has(n[0]) && Array.isArray(n[1]) && n[1][0] === '[]' && n[1][1] === name) {
      writes++
      const dom = sourceOf(n[1][2])
      if (!dom || (domain && domain !== dom)) bad = true
      else domain = dom
    }
    for (let i = 1; i < n.length; i++) stack.push(n[i])
  }
  return writes && !bad ? domain : null
}

/**
 * Analyze all local value types from declarations and assignments.
 * Writes the per-name `val` field of `ctx.func.localReps` for method dispatch
 * and schema resolution.
 */
// Strict write-kind resolver for the dict-value-type census (local half,
// design .work/todo.md §deletion-sweep §1a) — a local mirror of
// program-facts.js's writeVT/effectiveWriteValue. Not imported: program-facts.js
// already imports analyzeBody from this module, so importing back would cycle.
// Kept in exact lockstep with the program-facts.js pair — any resolver change
// there belongs here too.
function dictWriteVT(n) {
  if (Array.isArray(n)) {
    const op = n[0]
    if (op === '.' || op === '?.') return null
    if (op === '+' || op === '+=') {
      const ta = dictWriteVT(n[1]), tb = dictWriteVT(n[2])
      if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
      if (ta == null || tb == null) return null
      if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
      return VAL.NUMBER
    }
    if (op === '?:') { const a = dictWriteVT(n[2]), b = dictWriteVT(n[3]); return a === b ? a : null }
    if (op === '&&' || op === '||' || op === '??') { const a = dictWriteVT(n[1]), b = dictWriteVT(n[2]); return a === b ? a : null }
  }
  return valTypeOf(n)
}
function dictEffectiveWriteValue(op, lhs, rhs) {
  if (op === '=') return rhs
  if (op === '++' || op === '--') return [op === '++' ? '+' : '-', lhs, [null, 1]]
  if (op === '&&=' || op === '||=' || op === '??=') return ['?:', lhs, lhs, rhs]
  return [op.slice(0, -1), lhs, rhs]
}
// Same-body scan for every `name[key] = rhs` (any MUTATE_OP, any key —
// dict-mode receivers have no literal-key fast path) rooted at `name` through
// nested `[]` chains. First-wins-then-clash, poisons to null on any
// unresolved write — identical lattice to observeProgramSlots' global-half
// dictValueTypes census.
//
// Observes THROUGH nested `=>` bodies: a write captured in a
// callback — `[0].forEach(() => m.set('y', 'oops'))` — is a write to the SAME
// lexical `name` binding as any top-level write, so leaving it unobserved
// (the old blanket `if (op === '=>') return`) let a stale census kind survive
// past a mutation that actually happened, miscompiling `m.get('y') + 1` to a
// bare NUMBER add. Sound direction: MORE observations only ever tightens or
// poisons the join, never loosens it. The one exception is a SHADOW — an
// arrow whose own param or nested let/const/var re-declares `name` binds a
// DIFFERENT variable for its whole body, so `collectAllBoundNames` (ast.js;
// position-insensitive, scans the whole arrow subtree including further
// nesting) gates entry per arrow: shadowed → skip the subtree entirely (same
// "over-bail is sound, never unsound" precedent as scanBindingUses' CAPTURE
// rule, this file's doc comment ~line 65). dictWalkLean/dictWalkI32 keep their
// own `=>`-stopping cut — this census only feeds the maybeUndefined-joined
// consumer path (kind.js dictValueKindOf), not those leaner direct-index ones.
//
// PRODUCT-LATTICE Slice 7: union-join instead of first-wins-then-clash
// poison-to-null (.work/lattice-design.md §thesis — this is an EXISTENTIAL
// fact, "which kinds has this dict been written with," and existential facts
// compose by union, not meet). Returns the raw Set (possibly empty = BOTTOM/
// unobserved): a disagreeing write ADDS to the set instead of nulling it; an
// unresolved write union-joins the full KIND_UNIVERSE (TOP) instead of a
// null sentinel — dictValueKindOf's exact-or-null projection (size===1 → the
// kind, else null) reproduces today's observable answer byte-for-byte from
// this Set, while censusKindsOf (opt-in) can now see the real union.
function dictValueTypeOf(body, name) {
  const kinds = new Set()
  const walk = (node) => {
    if (kinds.size === KIND_UNIVERSE.length || !Array.isArray(node)) return
    const op = node[0]
    if (op === '=>' && collectAllBoundNames(node, new Set()).has(name)) return
    if (MUTATE_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '[]') {
      const [, wobj, widx] = node[1]
      if (!isLiteralStr(widx)) {
        let root = wobj
        while (Array.isArray(root) && root[0] === '[]') root = root[1]
        if (root === name) {
          const wvt = dictWriteVT(dictEffectiveWriteValue(op, node[1], node[2]))
          if (!wvt) { for (const k of KIND_UNIVERSE) kinds.add(k); return }
          kinds.add(wvt)
        }
      }
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return kinds
}

// Map-value-type census, local half (design .work/todo.md §deletion-sweep
// §1) — mirrors dictValueTypeOf above but matches `recv.set(k, v)` CALL nodes
// instead of `[]=` writes (Map has no bracket-write form). No self-read/
// paramVts handling here, same as dictValueTypeOf's own local half (those are
// the late whole-program {fresh:true} pass's concerns, program-facts.js).
// Caller gates on decl vt === VAL.MAP (receiver already proven), so `name`
// need not be re-checked here. Observes THROUGH nested `=>` bodies with the
// SAME shadow-bail as dictValueTypeOf above — see that
// function's doc comment for the soundness argument. Same product-lattice
// Slice 7 union-join swap as dictValueTypeOf above — see its doc comment.
function mapValueTypeOf(body, name) {
  const kinds = new Set()
  const walk = (node) => {
    if (kinds.size === KIND_UNIVERSE.length || !Array.isArray(node)) return
    const op = node[0]
    if (op === '=>' && collectAllBoundNames(node, new Set()).has(name)) return
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' &&
        node[1][1] === name && node[1][2] === 'set') {
      const cargs = commaList(node[2])
      if (cargs.length === 2) {
        const wvt = dictWriteVT(cargs[1])
        if (!wvt) { for (const k of KIND_UNIVERSE) kinds.add(k); return }
        kinds.add(wvt)
      }
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return kinds
}

export function analyzeValTypes(body) {
  // localReps slice: store reads/writes the rep's `val` field (updateRep clears it
  // when set to undefined, matching the old explicit delete).
  const setVal = makeValTracker(
    (n) => ctx.func.localReps?.get(n)?.val,
    (n, vt) => updateRep(n, { val: vt }),
    (n) => updateRep(n, { val: undefined }),
  )
  const getVal = name => ctx.func.localReps?.get(name)?.val
  // presentVal slice: decl-time producer (.work/todo.md §deletion-sweep
  // §14 Slice 6, reps.js `presentVal` doc comment). Own
  // makeValTracker instance — a SEPARATE poison set from `setVal`'s (this
  // function is called fresh per analyzeValTypes invocation, exactly like
  // setVal above, so poison state never leaks across functions/compiles).
  // Fed `censusMaybeUndefinedKind(rhs)` directly at both write sites below:
  // that one predicate already composes direct census-shaped RHS, one-hop
  // bare-name copy-through (reading this SAME field on an earlier-processed
  // name in the same forward walk), and call-results — no separate helper
  // needed (kind.js's own "one predicate function" discipline, §4).
  const setPresentVal = makeValTracker(
    (n) => ctx.func.localReps?.get(n)?.presentVal,
    (n, vt) => updateRep(n, { presentVal: vt }),
    (n) => updateRep(n, { presentVal: undefined }),
  )
  // Names declared in THIS body. A reassignment to any other name (parameter /
  // captured outer binding) merges with an entry value of unknown kind, so a
  // POINTER-kind RHS must POISON the val slice, not settle it — else a branch
  // like `if (Array.isArray(x)) …; else x = ['str', v]` on a param stamps x
  // ARRAY flow-insensitively and const-folds the very guard proving it isn't
  // (the kernel JSON.parse-emitter head-coercion: array reads on a string →
  // OOB). Scalar kinds (NUMBER/BOOL/BIGINT) and coupled-tracker kinds (TYPED/BUFFER, whose trackTyped slice owns coherence) keep the settled-kind behavior —
  // see analyzeBody's poisonUndeclared for why.
  const declared = new Set()
  const poisonUndeclared = (name, vt) =>
    !declared.has(name) && vt != null && vt !== VAL.NUMBER && vt !== VAL.BOOL && vt !== VAL.BIGINT && vt !== VAL.TYPED && vt !== VAL.BUFFER ? null : vt
  // Pre-walk: observe Array<schema> facts so `const p = arr[i]` can bind a schemaId
  // on `p`, unlocking schema slot reads + skipping str_key dispatch on `.prop` access.
  // Parallel arrElemValTypes walk records VAL.* element kinds into
  // rep.arrayElemValType so valTypeOf's `arr[i]` rule can elide __to_num and route
  // method dispatch on `arr[i].method()`. Both come from a single unified walk.
  const facts = analyzeBody(body)
  const arrElems = facts.arrElemSchemas
  for (const [name, vt] of facts.arrElemValTypes) {
    if (vt != null) updateRep(name, { arrayElemValType: vt })
  }
  // Array-of-typed-arrays element ctor → rep, so `arr[i]` resolves as a typed array
  // and `arr[i][j]` / `let o = arr[i]; o[j]` inline (codec channelData scatter).
  for (const [name, ctor] of facts.arrElemTypedCtors) {
    if (ctor != null) updateRep(name, { arrayElemTypedCtor: ctor })
  }
  // Construct-then-fill numeric arrays (`let a = Array(n); a[i] = expr`) carry no
  // element evidence at their decl, so the walk above leaves them untyped. scanNumericFill
  // proved every write Numeric and every other use a pure read — record NUMBER so `arr[i]`
  // reads skip __to_num, unless an observation already poisoned the slot to a conflict.
  for (const name of facts.numericFill || []) {
    if (facts.arrElemValTypes.get(name) !== null) updateRep(name, { arrayElemValType: VAL.NUMBER })
  }
  // Propagate body-observed array-elem schemas to localReps so unboxablePtrs's
  // `let p = arr[i]` rule (which only consults rep) sees the schema and can unbox `p`
  // to an i32 offset. Without this, `arr.push({x,y,z})` followed by `arr[i].x` reads
  // pay an i64.reinterpret/i32.wrap on every slot access (no aliasing → CSE can't fold).
  for (const [name, sid] of arrElems) {
    if (sid != null) updateRep(name, { arrayElemSchema: sid })
  }
  // Closed heterogeneous unions (≥2 sids, no unknown source) ride to reps the
  // same way — size-1 sets are exactly the singular fact and stay off the rep.
  for (const [name, set] of facts.arrElemSchemaSets || []) {
    if (set != null && set.size >= 2) updateRep(name, { arrayElemSchemaSet: [...set].sort((a, b) => a - b) })
  }
  // Resolve a name's array-elem-schema, preferring rep.arrayElemSchema (set from
  // paramReps[k].arrayElemSchema at emit start) over local body observations.
  const arrElemSchemaOf = (name) => {
    if (typeof name !== 'string') return null
    const repSid = ctx.func.localReps?.get(name)?.arrayElemSchema
    if (repSid != null) return repSid
    const localSid = arrElems.get(name)
    return localSid != null ? localSid : null
  }
  // Set sibling of arrElemSchemaOf — rep channel first (param-carried unions).
  const arrElemSchemaSetOf = (name) => {
    if (typeof name !== 'string') return null
    const repSet = ctx.func.localReps?.get(name)?.arrayElemSchemaSet
    if (repSet != null) return repSet
    const s = facts.arrElemSchemaSets?.get(name)
    return s != null && s.size >= 2 ? [...s].sort((a, b) => a - b) : null
  }
  function trackRegex(name, rhs) {
    if (ctx.runtime.regex && Array.isArray(rhs) && rhs[0] === '//') ctx.runtime.regex.vars.set(name, rhs)
  }
  // ctx.func.typedElem slice (lazily created on first write, as before — readers
  // tolerate null). Disagreeing decls poison the name (jz hoists `let` to function
  // scope, so sibling-scope decls share a name and must not lock in a wrong width).
  const trackTyped = makeTypedTracker(
    (n) => ctx.func.typedElem?.get(n),
    (n, c) => (ctx.func.typedElem ??= new Map()).set(n, c),
    (n) => ctx.func.typedElem?.delete(n),
    (n) => ctx.func.typedLen?.get(n),
    (n, l) => (ctx.func.typedLen ??= new Map()).set(n, l),
    (n) => ctx.func.typedLen?.delete(n),
  )
  // Total write count for `name` across the whole body, recursing into nested
  // closures so a closure that reassigns the var is also counted. Capped at 2 —
  // callers only need the "exactly one write" verdict.
  function writeCount(node, name, n) {
    if (n > 1 || !Array.isArray(node)) return n
    const o = node[0]
    if (MUTATE_OPS.has(o) && node[1] === name) n++
    if (o === 'let' || o === 'const') {
      for (let i = 1; i < node.length && n <= 1; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && d[2] != null) n = writeCount(d[2], name, n)
      }
      return n
    }
    for (let i = 1; i < node.length && n <= 1; i++) n = writeCount(node[i], name, n)
    return n
  }
  // Bind an object-literal's schemaId onto its holding local's rep so that
  // `o.prop` / `o.method()` dispatch is precise instead of falling back to
  // structural subtyping (which mis-resolves when another in-scope object
  // shares a member at a different slot). `shapeOf` already covers plain-data
  // literals on a direct `let o = {…}` decl, but not literals with
  // function-valued props — and `var o = {…}` is rewritten by jzify into
  // `let o; o = {…}`, so the schemaId never reaches `o` either way.
  // `expectWrites` is the reassignment count that marks `o` single-assignment:
  // 1 for the jzify `=` form (the synthesized assignment IS the only write),
  // 0 for a direct `let`/`const` decl (the initializer is not counted as a
  // write). A polymorphically reassigned holder keeps dynamic dispatch.
  // A name already in `ctx.schema.vars` carries a prepare-phase schema
  // (Object.assign merge via `inferAssignSchema`, destructure tracking) that
  // supersedes the bare-literal one — binding here would shadow the merged
  // schema (rep schemaId wins over `ctx.schema.vars` in `idOf`).
  function bindObjSchema(name, rhs, expectWrites = 1) {
    if (ctx.func.current?.params?.some(p => p.name === name)) return
    if (ctx.schema.vars?.has(name)) return
    const sid = objLiteralSchemaId(rhs)
    if (sid != null && writeCount(body, name, 0) === expectWrites) updateRep(name, { schemaId: sid })
  }
  // Non-escaping computed-key dictionary: every use of `name` is exactly the
  // receiver of `name[key]` (read or write), apart from its declaration. Such
  // a fresh HASH never deletes/enumerates/escapes, so its upsert may use the
  // lean no-tombstone/no-order/no-durable-log probe.
  const leanDictUse = (name) => dictWalkLean(body, name)
  // Count/histogram dictionaries: if every read is immediately bitwise-
  // coerced and every write is a statement, the slot may retain only the
  // observable ToInt32 bits. Missing `undefined|0` and a zero slot are equal.
  const i32DictUse = (name) => dictWalkI32(body, name)
  // Upper bound on distinct keys: `const k = domain[index]; dict[k] = …`
  // cannot insert more unique keys than domain.length. Capacity planning uses
  // this only as a preallocation hint (the table still grows), so a missed
  // alias costs speed while an over/underestimate cannot affect semantics.
  const dictDomain = (name) => dictDomainOf(body, name)
  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return  // don't leak inner-closure val types
    // Collect Object.assign(name, …) sites for the post-walk boxed-schema
    // predictor (slice-4 P3) — decided AFTER the walk so the target's FINAL
    // val kind matches what emit reads.
    if (op === '()' && args[0] === 'Object.assign') {
      let aa = args.slice(1)
      if (aa.length === 1 && Array.isArray(aa[0]) && aa[0][0] === ',') aa = aa[0].slice(1)
      if (typeof aa[0] === 'string' && aa.length > 1)
        objAssignSites.push({ target: aa[0], sources: aa.slice(1) })
    }
    // Propagate typed array type through method calls (e.g. buf.map → typed)
    function propagateTyped(name, rhs) {
      if (!Array.isArray(rhs) || rhs[0] !== '()') return
      const callee = rhs[1]
      if (!Array.isArray(callee) || callee[0] !== '.') return
      const src = callee[1], method = callee[2]
      if (typeof src === 'string' && getVal(src) === VAL.TYPED && method === 'map') {
        setVal(name, VAL.TYPED)
        if (ctx.func.typedElem?.has(src)) {
          const srcCtor = ctx.func.typedElem.get(src)
          ctx.func.typedElem.set(name, srcCtor.endsWith('.view') ? srcCtor.slice(0, -5) : srcCtor)
        }
      }
    }
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        declared.add(a[1])
        // Empty object used exclusively as a computed-key sink is represented
        // as HASH by object.js. Stamp the same kind during analysis (before
        // emission), so every subsequent read/write takes the strict one-table
        // path and hash-RMW fusion needs no speculative runtime-type fallback.
        const merged = ctx.schema.resolve?.(a[1])
        const emptyLit = Array.isArray(a[2]) && a[2][0] === '{}' && a[2].length === 1
        const dict = emptyLit && ctx.types.dynWriteVars?.has(a[1]) && !merged?.length
        // INVARIANT: a truly EMPTY `{}` still binds a real (0-prop) schema
        // decl — prepare/index.js's own decl-schema tracking (the props.length
        // guard right next to the non-empty-literal case this mirrors) only
        // ever bound a NON-empty literal's schema; module/core.js's
        // isClosedObjNoStringMethod (`new Error(o).message` for a bound
        // object) needs a resolvable schema to prove a truly-empty `o`
        // closed, same as it already can for `{x:1}`. Bound HERE, not in
        // prepare, and ONLY for the non-dict arm: `dict` (computed above,
        // WHOLE-PROGRAM `ctx.types.dynWriteVars` context prepare's earlier,
        // single-pass walk never has) is the one fact that must gate whether
        // this schema is minted AT ALL — not just whether it's bound to this
        // name. Minting an unused schema for a dict-mode binding (one that
        // NEVER reads it — HASH mode bypasses schema dispatch entirely, and
        // errorMessageIR's own separate VAL.HASH arm covers ITS Error-message
        // case) still changes `ctx.schema.list`'s size, which is enough to
        // flip a shared codegen branch in module/collection.js's
        // $__dyn_get_t_h — reopening the exact PRE-EXISTING, host-dependent
        // watr-fold divergence test/kernel-parity.js's "dict|2 + dict|3" note
        // already documents (confirmed live: binding unconditionally, even
        // via prepare, reproduced it; skipping the dict arm here does not).
        // `merged == null` (not just "no schema yet"): if prepare's own
        // assignment-schema tracking already bound (or poisoned) this name
        // from a LATER reassignment (`o = {x:1}`), that fact was decided with
        // MORE information than a bare `{}` decl carries — never overwrite it.
        if (!dict && emptyLit && merged == null && ctx.schema.register && !ctx.schema.poisoned?.has(a[1]))
          ctx.schema.vars.set(a[1], ctx.schema.register([]))
        const vt = dict ? VAL.HASH : valTypeOf(a[2])
        // Dict-value-type census, local half (design §1a): every value ever
        // written through `a[1][key] = rhs` in this body, additive alongside
        // the HASH receiver stamp above — never a substitute for `val`.
        if (dict) {
          const dvt = dictValueTypeOf(body, a[1])
          if (dvt.size) updateRep(a[1], { dictValueValType: dvt })
        }
        // Map-value-type census, local half (design .work/todo.md
        // §deletion-sweep §1) — sibling of the dict census above, gated on decl
        // vt === VAL.MAP instead of the HASH-literal `dict` shape check
        // (new Map() is a hard classification, valTypeOf(a[2]) already
        // resolves it via CALLEE_VAL — no structural re-derivation needed).
        if (vt === VAL.MAP) {
          const mvt = mapValueTypeOf(body, a[1])
          if (mvt.size) updateRep(a[1], { mapValueValType: mvt })
        }
        const leanDict = dict && (ctx.transform.optFlags & OPTF.hashRmwFusion) && leanDictUse(a[1])
        if (leanDict) {
          (ctx.func.leanHashLocals ??= new Set()).add(a[1])
          if (i32DictUse(a[1])) (ctx.func.i32HashLocals ??= new Set()).add(a[1])
          const domain = dictDomain(a[1])
          if (domain) (ctx.func.leanHashDomains ??= new Map()).set(a[1], domain)
        }
        setVal(a[1], vt)
        const declMayBeNullish = mayBeNullish(a[2])
        if (declMayBeNullish) updateRep(a[1], { nullable: true })
        // presence (re-audit item 9(b)): 'maybe-undef' mirrors mayBeUndefined's
        // own boolean exactly (same condition, same site). 'present' is a
        // SEPARATE, narrower positive proof — non-nullish init (declMayBeNullish
        // already computed above for `nullable`) AND never reassigned anywhere
        // in the body (writeCount, the SAME never-reassigned check the range
        // stamp below reuses) — mutually exclusive with 'maybe-undef' by
        // construction (if/else if): a census-shaped RHS is already
        // mayBeNullish-true (mayBeNullish fails closed on any call/bracket
        // read), so the two arms never both fire for the same write.
        if (mayBeUndefinedRhs(a[2])) updateRep(a[1], { mayBeUndefined: true, presence: 'maybe-undef' })
        else if (!declMayBeNullish && writeCount(body, a[1], 0) === 0) updateRep(a[1], { presence: 'present' })
        setPresentVal(a[1], censusMaybeUndefinedKind(a[2]))
        // Closed integer hull for never-reassigned decls whose init the range
        // evaluator can bound (masks, ternary hulls, bounded products) — chains
        // through earlier ranged decls via intExprRange's repOf hook. Feeds the
        // i32-provability of products and div-by-2^k strength reduction (the
        // delayline q16 chain: raw = lfo & 0x1ffff → tri → dq stays i32).
        //
        // This is the SAME predicate analyzeBody's own processDecl stamps
        // EARLY, during its (possibly cache-skipped) body walk. DBG_INVARIANTS asserts the redundancy claim that justifies
        // leaving that early stamp as-is rather than threading ranges through
        // an explicit BodyFacts slice: whenever processDecl already stamped a
        // range for this name (cache miss ran it, ctx.func.localReps wasn't
        // reset since), THIS unconditional re-derivation must land the exact
        // same bound — same rhs, same walk order, same repOf-chained bounds
        // for earlier decls (ctx.func.localReps is never touched between the
        // two stamps within one function's own compile turn). See session.js's
        // DEPS table / analyzeBody's cache doc for why a genuine STALE hit
        // (skipping the early stamp) is harmless: this line still fires
        // unconditionally and fills the gap.
        const declRange = intExprRange(a[2])
        if (declRange && Number.isFinite(declRange[0]) && Number.isFinite(declRange[1]) && writeCount(body, a[1], 0) === 0) {
          if (DBG_INVARIANTS) {
            const prior = repOf(a[1])?.range
            if (prior && (prior[0] !== declRange[0] || prior[1] !== declRange[1]))
              throw new Error(`analyzeValTypes: declRange restamp for '${a[1]}' diverges from analyzeBody's early stamp — prior=[${prior}] new=[${declRange}] (idempotence probe)`)
          }
          updateRep(a[1], { range: declRange })
        }
        if (vt === VAL.REGEX) trackRegex(a[1], a[2])
        // VAL gate covers definite-typed RHS; `?:`/`&&`/`||` slip through valTypeOf
        // returning null but may still need ctor unification (or poisoning when
        // branches disagree, since jz hoists `let` to function scope).
        if (vt === VAL.TYPED || vt === VAL.BUFFER || isCondExpr(a[2])) trackTyped(a[1], a[2])
        propagateTyped(a[1], a[2])
        // JSON-shape propagation. When the RHS resolves to a known JSON shape
        // (root: `JSON.parse(literal)`; nested: `o.meta`, `items[j]` from a known
        // root), record it on the binding so subsequent `.prop`/`[i]` accesses
        // skip dynamic dispatch and propagate VAL kinds. Generic for any
        // compile-time JSON literal.
        const sh = shapeOf(a[2])
        if (sh) {
          updateRep(a[1], { jsonShape: sh })
          if (sh.val === VAL.ARRAY && sh.elem?.val) {
            updateRep(a[1], { arrayElemValType: sh.elem.val })
            // Array of fixed-shape OBJECTs: register elem schema so `it = items[j]`
            // → `it.prop` lowers to slot read via the existing arr-elem-schema path.
            if (sh.elem.val === VAL.OBJECT && sh.elem.names && ctx.schema.register) {
              const elemSid = ctx.schema.register(sh.elem.names)
              updateRep(a[1], { arrayElemSchema: elemSid })
            }
          }
          if (sh.val === VAL.OBJECT && sh.names && ctx.schema.register) {
            const sid = ctx.schema.register(sh.names)
            updateRep(a[1], { schemaId: sid })
            ctx.schema.vars.set(a[1], sid)
          }
        }
        // `shapeOf` misses object literals with function-valued props; bind
        // their schemaId here so number-hint ToPrimitive (valueOf/toString slot
        // dispatch) resolves. expectWrites=0: a decl initializer is not a write.
        if (vt === VAL.OBJECT) bindObjSchema(a[1], a[2], 0)
        // Propagate schemaId from a narrowed call result so subsequent valTypeOf
        // calls in this function body see the precise schema. emitDecl rebinds
        // this at emission time too — analyze-time binding is what unlocks the
        // slotVT lookup chain in `analyzeValTypes`'s own walk + per-func emit
        // dispatch reading localReps.
        if (vt === VAL.OBJECT && Array.isArray(a[2]) && a[2][0] === '()' && typeof a[2][1] === 'string') {
          const f = ctx.funcs.map?.get(a[2][1])
          if (f?.sig?.ptrAux != null) updateRep(a[1], { schemaId: f.sig.ptrAux })
        }
        // `const p = arr[i]` — when arr's element schema is known (from .push observations
        // or from paramReps arrayElemSchema binding), p inherits the schema. Unlocks slotVT-driven
        // numeric typing on `.prop` reads + slot-direct loads.
        if (Array.isArray(a[2]) && a[2][0] === '[]' && typeof a[2][1] === 'string') {
          const elemSid = arrElemSchemaOf(a[2][1])
          if (elemSid != null) {
            updateRep(a[1], { schemaId: elemSid })
            // Also set the val so structural call dispatch + valTypeOf see VAL.OBJECT.
            setVal(a[1], VAL.OBJECT)
          } else {
            // Closed heterogeneous union: `const o = rows[i]` over a
            // set-carrying array — o is provably ONE of the union's schemas.
            // Discriminant refinement (flow-types) narrows per-branch; the
            // union-agreeing slot path (schema.slotOf) serves unbranched reads
            // like the tag itself.
            // Decl-only binding (no reassignment anywhere, incl. closures) — a
            // second write could carry a foreign schema the set doesn't cover.
            const elemSet = arrElemSchemaSetOf(a[2][1])
            if (elemSet != null && writeCount(body, a[1], 0) === 0) {
              updateRep(a[1], { schemaIdSet: elemSet })
              setVal(a[1], VAL.OBJECT)
            }
          }
        }
      }
    }
    if (op === '=' && typeof args[0] === 'string') {
      walk(args[1])
      const merged = ctx.schema.resolve?.(args[0])
      const dict = Array.isArray(args[1]) && args[1][0] === '{}' && args[1].length === 1 &&
        ctx.types.dynWriteVars?.has(args[0]) && !merged?.length
      const vt = dict ? VAL.HASH : valTypeOf(args[1])
      // Dict-value-type census, local half (design §1a) — reassignment site
      // sibling of the decl-site stamp above.
      if (dict) {
        const dvt = dictValueTypeOf(body, args[0])
        if (dvt.size) updateRep(args[0], { dictValueValType: dvt })
      }
      // Map-value-type census, local half — reassignment site sibling of the
      // decl-site stamp above.
      if (vt === VAL.MAP) {
        const mvt = mapValueTypeOf(body, args[0])
        if (mvt.size) updateRep(args[0], { mapValueValType: mvt })
      }
      if (dict && (ctx.transform.optFlags & OPTF.hashRmwFusion) && leanDictUse(args[0])) {
        (ctx.func.leanHashLocals ??= new Set()).add(args[0])
        if (i32DictUse(args[0])) (ctx.func.i32HashLocals ??= new Set()).add(args[0])
        const domain = dictDomain(args[0])
        if (domain) (ctx.func.leanHashDomains ??= new Map()).set(args[0], domain)
      }
      setVal(args[0], poisonUndeclared(args[0], vt))
      if (mayBeNullish(args[1])) updateRep(args[0], { nullable: true })
      // presence (re-audit item 9(b)): 'maybe-undef' mirrors mayBeUndefined's
      // boolean here too. No 'present' arm at a REASSIGN site — this write
      // itself makes writeCount(body, args[0], 0) ≥ 1 for the whole body, so
      // the decl site's never-reassigned precondition for 'present' is
      // already false whenever this site can even fire (decl-site 'present'
      // never gets set for a name that reaches a reassignment anywhere).
      if (mayBeUndefinedRhs(args[1])) updateRep(args[0], { mayBeUndefined: true, presence: 'maybe-undef' })
      setPresentVal(args[0], censusMaybeUndefinedKind(args[1]))
      if (vt === VAL.REGEX) trackRegex(args[0], args[1])
      if (vt === VAL.TYPED || vt === VAL.BUFFER || isCondExpr(args[1])) trackTyped(args[0], args[1])
      propagateTyped(args[0], args[1])
      if (vt === VAL.OBJECT) bindObjSchema(args[0], args[1])
      return
    }
    // Track property assignments for auto-boxing: x.prop = val
    if (op === '=' && Array.isArray(args[0]) && args[0][0] === '.' && typeof args[0][1] === 'string') {
      const [, obj, prop] = args[0]
      const vt = getVal(obj)
      if ((vt === VAL.NUMBER || vt === VAL.BIGINT) && ctx.func.locals?.has(obj) && ctx.schema.register) {
        if (!ctx.func.localProps) ctx.func.localProps = new Map()
        if (!ctx.func.localProps.has(obj)) ctx.func.localProps.set(obj, new Set())
        ctx.func.localProps.get(obj).add(prop)
      }
    }
    for (const a of args) walk(a)
  }
  const objAssignSites = []
  walk(body)

  // Slice-4 P3 predictor: `Object.assign(x, …)` onto a non-OBJECT binding
  // (boxed primitive / array carrier) allocates an `__inner__` record at emit;
  // the schema BINDING is plan state — register + bind here, mirroring
  // module/object.js's emit site (which now asserts instead of writing).
  // Post-walk so the target's FINAL val kind matches what emit reads; the
  // shared ctx.schema.resolveExpr keeps source resolution identical to emit's.
  for (const { target, sources } of objAssignSites) {
    const vt = repOf(target)?.val
    if (!vt || vt === VAL.OBJECT || !ctx.schema.resolveExpr) continue
    const allProps = []
    let known = true
    for (const src of sources) {
      const s = ctx.schema.resolveExpr(src)
      if (!s) { known = false; break }
      for (const p of s) if (!allProps.includes(p)) allProps.push(p)
    }
    if (!known) continue   // emit errs on unknown-source schemas — nothing to bind
    const sid = ctx.schema.register(['__inner__', ...allProps])
    // Extern-write belt: source slot values copied in at emit, unseen by censuses.
    ctx.schema.externSlotSids?.add(sid)
    ctx.schema.vars.set(target, sid)
    updateRep(target, { schemaId: sid })
  }

  // Register boxed schemas for local variables with property assignments
  if (ctx.func.localProps) {
    for (const [name, props] of ctx.func.localProps) {
      if (ctx.schema.vars.has(name)) continue
      const schema = ['__inner__', ...props]
      const sid = ctx.schema.register(schema)
      ctx.schema.vars.set(name, sid)
      updateRep(name, { schemaId: sid })
    }
  }
}

/** Forward-propagate `intCertain` on local bindings. Fixpoint lives in type.js.
 *  Threads the settled slot census as the `.prop`-read resolver — without it a
 *  binding built from an int-certain slot (`const x = hitX ? p.x : nx`) stayed
 *  uncertain and every consumer re-paid the ToNumber guard. */
export function analyzeIntCertain(body) {
  const slotIntOf = ctx.schema?.slotIntCertainAt
    ? (obj, prop) => {
      const id = ctx.schema.idOf?.(obj)
      if (id == null) return null
      const idx = ctx.schema.list[id]?.indexOf(prop)
      if (idx == null || idx < 0) return null
      return ctx.schema.slotIntCertainAt(obj, prop)
    }
    : undefined
  for (const [name, intC] of intCertainMap(body, undefined, slotIntOf)) {
    if (intC) updateRep(name, { intCertain: true })
  }
}

// A directly-uint32 expression: `x >>> 0` (zero-fill shift) or a call to a function
// already proven `unsignedResult`. Such a value lives in i32 but ranges [0, 2^32),
// so signed i32 ops on it are wrong — exprType widens its arithmetic to f64 to
// match emit (which reboxes via `f64.convert_i32_u`). Unsignedness through a local
// assignment is intentionally not tracked here — kept in lockstep with narrow.js's
// `isUnsignedTail`, so emit and exprType agree (no trunc_sat saturation).

// `analyzeBody` was inlined to `analyzeBody(body).locals` at its three real
// call sites in src/compile.js and src/narrow.js — the one-line facade existed
// only as a historical surface and obscured the unified-walk relationship.

/**
 * Identify locals that can be stored as an unboxed i32 pointer offset instead of
 * a NaN-boxed f64. Static type is tracked out-of-band so reads skip `__ptr_offset`
 * and `__ptr_type` entirely and writes unbox once at the assignment site.
 *
 * Criteria — the local must be:
 *   - declared once with `let`/`const`, never reassigned or compound-assigned
 *   - valType is an unambiguous non-forwarding pointer kind:
 *       OBJECT, SET, MAP, CLOSURE, TYPED, BUFFER
 *     (excluded: ARRAY — forwards on realloc; STRING — SSO/heap dual encoding.)
 *   - initialized from a form that guarantees a fresh, non-null pointer of that VAL:
 *       OBJECT ← `{…}`
 *       SET    ← `new Set(...)`
 *       MAP    ← `new Map(...)`
 *       CLOSURE← `=>` literal
 *       BUFFER ← `new ArrayBuffer(...)`
 *       TYPED  ← `new XxxArray(...)` / method returning typed array
 *                (`new DataView(...)` is TYPED but stays boxed — no elem aux)
 *   - not captured in boxed storage (boxed locals stay f64 for the heap slot)
 *   - never compared to null/undefined (we lose the nullish NaN representation)
 *
 * Returns Map<name, VAL> of locals to unbox.
 */
export function unboxablePtrs(body, locals, boxed) {
  const valOf = name => ctx.func.localReps?.get(name)?.val
  const UNBOXABLE_KINDS = new Set([VAL.OBJECT, VAL.SET, VAL.MAP, VAL.BUFFER, VAL.TYPED, VAL.CLOSURE, VAL.DATE])

  // RHS must produce a fresh, non-null pointer of the declared VAL kind.
  //   OBJECT  ← `{…}`
  //   CLOSURE ← `=>`
  //   SET/MAP/BUFFER/TYPED ← `new X(...)`
  // Validating the exact ctor→VAL match keeps the analysis tied to valTypeOf, so when
  // that helper grows (e.g. `Array.from` → ARRAY), we don't drift out of sync.
  const isFreshInit = (expr, kind) => {
    if (!Array.isArray(expr)) return false
    if (kind === VAL.OBJECT) {
      if (expr[0] === '{}') return true
      // Call to a narrow-ABI'd helper: returns i32 ptr-offset of the same VAL kind.
      // Unboxing skips the f64-rebox at the callsite. Verifying via sig (not just
      // valResult) ensures the call already produces an i32 — which dual-write picks
      // up to bind ptrKind/schemaId on the local.
      if (expr[0] === '()' && typeof expr[1] === 'string') {
        const f = ctx.funcs.map?.get(expr[1])
        return f?.sig?.ptrKind === kind
      }
      // `let p = arr[i]` where arr has a known elem schema: the runtime helper
      // returns f64 (NaN-box of an OBJECT pointer), but its low 32 bits are
      // exactly the pointer offset. Dual-write coerces once via reinterpret/wrap;
      // subsequent `p.x` reads then become direct `f64.load offset=K (local.get $p)`
      // (since ptrOffsetIR sees ptrKind=OBJECT and skips the per-access wrap).
      if (expr[0] === '[]' && typeof expr[1] === 'string') {
        const r = ctx.func.localReps?.get(expr[1])
        if (r?.arrayElemSchema != null) return true
        // Closed-union element: an OBJECT of some member schema on EITHER
        // layout (plain ptr or inline cell) — unboxing to a raw offset is
        // valid regardless of whether analyzeUnionInline (which runs later)
        // admits the packed carrier.
        return (r?.arrayElemSchemaSet?.length ?? 0) >= 2
      }
      return false
    }
    if (kind === VAL.CLOSURE) return expr[0] === '=>'
    if (expr[0] === '()' && typeof expr[1] === 'string') {
      const callee = expr[1]
      if (callee.startsWith('new.')) {
        if (kind === VAL.SET) return callee === 'new.Set'
        if (kind === VAL.MAP) return callee === 'new.Map'
        if (kind === VAL.DATE) return callee === 'new.Date'
        if (kind === VAL.BUFFER) return callee === 'new.ArrayBuffer'
        if (kind === VAL.TYPED) return callee.endsWith('Array') && callee !== 'new.ArrayBuffer'
      }
      // Call to narrow-ABI'd helper of matching VAL kind.
      const f = ctx.funcs.map?.get(callee)
      if (f?.sig?.ptrKind === kind) return true
    }
    // Method call returning TYPED: `arr.map(fn)` where `arr` is in typedElem
    // (locally TYPED with a known elem ctor). Only `.typed:map` is registered
    // as TYPED-returning — `.filter`/`.slice` fall back to ARRAY emit. The
    // typedElem.has(src) gate ensures we don't accept the polymorphic-receiver
    // path that emits a plain ARRAY result. propagateTyped already mirrored
    // the src ctor onto the receiver, so the unbox path picks up its aux.
    if (kind === VAL.TYPED && expr[0] === '()' &&
        Array.isArray(expr[1]) && expr[1][0] === '.' &&
        typeof expr[1][1] === 'string' && expr[1][2] === 'map' &&
        ctx.func.typedElem?.has(expr[1][1])) {
      return true
    }
    return false
  }
  // A policy over `scanBindingUses`: an UNBOXABLE-kind `let/const` local with a
  // fresh-pointer initializer stays unboxable unless some use forbids it. The
  // only forbidding uses are a reassignment (`=`/compound/`++`/`--`) or a
  // null/undefined comparison (an unboxed pointer has no nullish NaN form).
  // Closure captures do not disqualify — a capture-*mutated* local is already
  // in `boxed`, and a capture-*read* leaves the pointer in its own slot.
  const result = new Map()
  for (const [name, s] of scanBindingUses(body)) {
    const vt = valOf(name)
    if (!UNBOXABLE_KINDS.has(vt)) continue
    if (locals.get(name) !== 'f64') continue
    if (boxed?.has(name)) continue
    if (!isFreshInit(s.initRhs, vt)) continue
    const ok = s.uses.every(u =>
      u.kind !== USE.REASSIGN && !(u.kind === USE.COMPARE && u.nullCmp))
    if (ok) result.set(name, vt)
  }
  return result
}

/**
 * Plan-time ptrKind inheritance for decl inits (slice-4 P1 predictor).
 *
 * The class `unboxablePtrs` rejects but emit resolves anyway: a `let/const`
 * whose init VALUE is already an unboxed pointer, where the binding itself is
 * later reassigned — radixsort's ping-pong (`let a = src, b = tmp; …
 * const t = a; a = b; b = t`). analyzeBody types the local i32 (RHS is an i32
 * pointer), so without the inherited ptrKind a read reboxes numerically
 * instead of via reinterpret.
 *
 * Predicts exactly what emitDecl's `val.ptrKind` observes, from the same
 * sources it derives from:
 *   bare local  → readVar tag: repOf(y).ptrKind, aux = ptrAux ?? schema.idOf(y)
 *                 (intConst substitution carries no tag — mirrored)
 *   bare global → tag iff i32-stored && repOfGlobal(y).ptrKind (constInts /
 *                 constNums substitutions carry no tag — mirrored)
 *   direct call → attachSigMeta: ctx.funcs.map.get(f).sig.ptrKind / ptrAux
 *
 * Program-order walk so alias chains (`a ← src; t ← a`) resolve through reps
 * exactly as sequential emitDecl calls would; nested '=>' bodies are skipped
 * (each closure runs its own plan pass). Names written here are recorded in
 * `ctx.func.p1Predicted`; the emit site ASSERTS agreement (both directions)
 * under JZ_DEBUG_INVARIANTS instead of writing.
 */
export function inheritPtrAliases(body, locals, boxed) {
  const isGlobalName = n => ctx.scope.globals.has(n) && !locals?.has(n) &&
    !ctx.func.current?.params?.some(p => p.name === n)
  const predictPtr = init => {
    if (typeof init === 'string') {
      const y = init
      if (boxed?.has(y)) return null
      if (isGlobalName(y)) {
        if (ctx.scope.constInts?.get?.(y) != null && isI32(ctx.scope.constInts.get(y))) return null
        if (ctx.scope.constNums?.get?.(y) != null) return null
        if ((ctx.scope.globalTypes.get(y) || 'f64') !== 'i32') return null
        const g = repOfGlobal(y)
        return g?.ptrKind != null ? { ptrKind: g.ptrKind, ptrAux: g.ptrAux ?? null } : null
      }
      const r = ctx.func.localReps?.get(y)
      if (r?.intConst != null) return null
      if (r?.ptrKind != null) return { ptrKind: r.ptrKind, ptrAux: r.ptrAux ?? ctx.schema.idOf?.(y) ?? null }
      return null
    }
    if (Array.isArray(init) && init[0] === '()' && typeof init[1] === 'string') {
      const f = ctx.funcs.map?.get(init[1])
      if (f?.sig?.ptrKind != null) return { ptrKind: f.sig.ptrKind, ptrAux: f.sig.ptrAux ?? null }
    }
    return null
  }
  const predicted = (ctx.func.p1Predicted ??= new Set())
  ;(function walk(node) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const name = d[1]
        if (locals.get(name) !== 'i32' || boxed?.has(name)) continue
        if (ctx.func.localReps?.get(name)?.ptrKind != null) continue
        const p = predictPtr(d[2])
        if (!p) continue
        updateRep(name, { ptrKind: p.ptrKind })
        predicted.add(name)
        if (p.ptrAux != null) {
          updateRep(name, { ptrAux: p.ptrAux })
          // OBJECT-only: aux IS the schemaId — mirror to schema.vars + rep so
          // .prop slot resolution binds precisely. TYPED/CLOSURE aux carries
          // other semantics (elem code / funcIdx). Poisoned names stay bare.
          if (p.ptrKind === VAL.OBJECT && !ctx.schema.vars?.has(name) && !ctx.schema.poisoned?.has(name)) {
            ctx.schema.vars.set(name, p.ptrAux)
            updateRep(name, { schemaId: p.ptrAux })
          }
        }
      }
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  })(body)
}

/**
 * CSE-safe load bases — `let/const` pointer locals whose `(f64.load offset=K $X)`
 * reads `cseScalarLoad` (src/optimize.js) may scalar-replace without a store
 * clobbering them. `cseScalarLoad` is module-wide disabled because it scanned
 * *every* i32 local; a store through an i32 local legitimately aliasing the load
 * base returned stale bytes. This pass is the missing soundness gate: a
 * per-function whitelist, each entry proven non-aliasing — guarantee, not guess.
 *
 * `X` qualifies iff ALL hold:
 *  (a) X is an unboxed pointer — `localReps.get(X).ptrKind` set, `locals[X]==='i32'`.
 *  (b) X is bound exactly once (no re-decl, no `=`/`++`/`--`/compound reassign).
 *  (c) Every occurrence of X is the receiver of a `.`/`?.`/`[]` *read* — never a
 *      write target, never a bare value (alias / arg / return / stored element),
 *      never captured by a closure. So X's pointer lives only in `$X`; nothing
 *      else holds it, and no store names it.
 *  (d) The allocation X's bytes live in is disjoint from every store target.
 *      jz allocations carry one kind each and distinct kinds never share bytes,
 *      so X is store-safe when every store's base has a determinable kind ≠ X's
 *      source kind. Any indeterminable store target disqualifies the whole set
 *      (a store through unknown memory could alias anything).
 *
 * (c)+(d): no store in the function can touch a cell reachable via `$X + K`, so
 * a load on `$X` is invariant between two control-flow boundaries — exactly
 * `cseScalarLoad`'s straight-line region model. Method-call mutations (`.push`,
 * …) need no accounting here: the pass already flushes its table on every call.
 *
 * Returns `Set<name>` — names only, no `$` prefix (the caller stamps it).
 */
export function cseSafeLoadBases(body, locals, localReps) {
  if (body === null || typeof body !== 'object') return new Set()

  // Allocation kind a pointer name's bytes live in: ptrKind (unboxed) wins,
  // else value-kind, else an array-schema'd binding is an ARRAY, else unknown.
  const kindOf = (name) => {
    if (typeof name !== 'string') return null
    const r = localReps?.get(name)
    return r?.ptrKind || r?.val || (r?.arrayElemSchema != null ? VAL.ARRAY : null) ||
      ctx.scope.globalValTypes?.get(name) || null
  }
  // X's bytes live in: the array/object an element read drew it from
  // (`X = src[i]` / `X = src.f`), else a fresh `{}`/`new` (X's own kind).
  const srcKind = (rhs) =>
    Array.isArray(rhs) && (rhs[0] === '[]' || rhs[0] === '.' || rhs[0] === '?.') &&
      typeof rhs[1] === 'string' ? kindOf(rhs[1]) : valTypeOf(rhs)

  // Pass 1 — bound-once unboxed-pointer candidates; record each source kind.
  const cand = new Map()                 // name → source allocation kind
  const declCount = new Map()
  const collect = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        if (typeof a === 'string') { declCount.set(a, (declCount.get(a) || 0) + 1); continue }
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') {
          const name = a[1]
          declCount.set(name, (declCount.get(name) || 0) + 1)
          if (localReps?.get(name)?.ptrKind != null && locals.get(name) === 'i32')
            cand.set(name, srcKind(a[2]))
          collect(a[2])
        } else collect(a)
      }
      return
    }
    for (let i = 1; i < node.length; i++) collect(node[i])
  }
  collect(body)
  for (const [n, c] of declCount) if (c > 1) cand.delete(n)
  if (!cand.size) return new Set()

  // Pass 2 — every occurrence must be a `.`/`?.`/`[]` read receiver (c).
  const live = new Set(cand.keys())
  const walk = (node, inClosure) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'str') return
    const closured = inClosure || op === '=>'
    if (op === 'let' || op === 'const') {        // decl `=` — bound name is not a use
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        if (typeof a === 'string') continue
        if (Array.isArray(a) && a[0] === '=') {
          if (typeof a[1] !== 'string') walk(a[1], closured)
          walk(a[2], closured)
        } else walk(a, closured)
      }
      return
    }
    if (op === '.' || op === '?.' || op === '[]') {   // member READ — receiver is safe
      const o = node[1]
      if (typeof o === 'string') { if (inClosure && cand.has(o)) live.delete(o) }
      else walk(o, closured)
      if (op === '[]' && node[2] != null) walk(node[2], closured)
      return
    }
    if (MUTATE_OPS.has(op) || op === 'delete') {
      const t = node[1]                            // write target — X here disqualifies
      if (typeof t === 'string') { if (cand.has(t)) live.delete(t) }
      else if (Array.isArray(t) && (t[0] === '.' || t[0] === '?.' || t[0] === '[]') &&
               typeof t[1] === 'string' && cand.has(t[1])) live.delete(t[1])
      else walk(t, closured)
      for (let i = 2; i < node.length; i++) walk(node[i], closured)
      return
    }
    for (let i = 1; i < node.length; i++) {        // any other position — bare X escapes
      const c = node[i]
      if (typeof c === 'string') { if (cand.has(c)) live.delete(c) }
      else walk(c, closured)
    }
  }
  walk(body, false)
  if (!live.size) return live

  // Pass 3 — store-target disjointness (d). A store lands in `base`'s allocation.
  let unknownStore = false
  const storeKinds = new Set()
  const scanStores = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (MUTATE_OPS.has(op) && Array.isArray(node[1]) &&
        (node[1][0] === '.' || node[1][0] === '?.' || node[1][0] === '[]') &&
        typeof node[1][1] === 'string') {
      const k = kindOf(node[1][1])
      if (k == null) unknownStore = true
      else storeKinds.add(k)
    }
    for (let i = 1; i < node.length; i++) scanStores(node[i])
  }
  scanStores(body)
  if (unknownStore) return new Set()

  const safe = new Set()
  for (const name of live) {
    const k = cand.get(name)
    if (k != null && !storeKinds.has(k)) safe.add(name)
  }
  return safe
}


/**
 * Whole-program SRoA eligibility — decides which object schemas may back an
 * `Array<S>` with the `structInline` carrier (the K f64 schema fields inlined
 * per element, no per-row heap object). Writes `ctx.schema.inlineArray:
 * Set<sid>`, read by the array push / index / length codegen.
 *
 * Default-disqualify: a schema is inlinable only when *every* observed use of
 * every `Array<S>` binding — across all user functions and module inits — is
 * one the structInline codegen handles. A missed or unrecognized use poisons
 * the schema, so the worst outcome is a lost optimization, never a stride
 * mismatch (miscompile).
 *
 * Handled uses of an `Array<S>` binding `a`:
 *   - decl/reassign from `[]` (empty), a call returning `Array<S>`, or an alias
 *   - `a.push({S-literal})`        — struct push (K-cell store)
 *   - `a.length`                  — physical len / K
 *   - `a[i]` consumed as `const p = a[i]` cursor, or directly `a[i].field`
 *   - `a` passed where the callee param is `Array<S>` (paramReps agreement)
 *   - `return a` when the enclosing function returns `Array<S>`
 * A cursor `p` (`const p = a[i]`) may only be read/written as `p.field`.
 * Anything else — bare ref, value escape, other array method, `a[i] = …`
 * element-replace — poisons S.
 *
 * Reads codegen truth: a binding is `Array<S>` iff its settled rep
 * (the opaque FunctionPlan's local-rep projection) carries
 * `arrayElemSchema = S` — the exact facts the emitter installs — so analysis
 * and emission never disagree on
 * which bindings are inline-carried.
 *
 * Conservative corners (sound, give up the optimization): closures and module
 * inits are not walked in detail — any schema reachable as a `.push({S})`
 * argument, an `Array<S>`-returning call, an `[{S}, …]` literal, or a captured
 * tracked array inside one is poisoned.
 */
export function analyzeStructInline(programFacts) {
  const inlineArray = ctx.schema?.inlineArray
  if (!inlineArray || !ctx.schema?.list) return
  const { paramReps } = programFacts
  const cand = new Set()      // sids observed as an `Array<S>` element schema
  // env-gated debug — dist/jz.js runs in browsers where `process` doesn't
  // exist, and WASI hosts strip `process.env`
  const DBG = typeof process !== 'undefined' && process.env?.JZ_DBG_INLARR
  const black = new Set()     // sids disqualified by some use

  const propsOf = (sid) => ctx.schema.list[sid] || []
  const inSchema = (sid, p) => typeof p === 'string' && propsOf(sid).includes(p)
  const isStrLit = (k) => Array.isArray(k) && k[0] === 'str' && typeof k[1] === 'string'

  // Argument list of a `['()', callee, argNode]` call node.
  const argsOf = (node) => {
    const a = node[2]
    return a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
  }

  // `name` referenced anywhere as a value (skips `:`/`.` property-name slots).
  const mentions = (node, name) => {
    if (typeof node === 'string') return node === name
    if (!Array.isArray(node)) return false
    const op = node[0]
    if (op === 'str') return false
    if (op === ':') return mentions(node[2], name)
    if (op === '.' || op === '?.') return mentions(node[1], name)
    for (let i = 1; i < node.length; i++) if (mentions(node[i], name)) return true
    return false
  }

  // Poison every schema whose `Array<S>` could materialize inside an un-walked
  // subtree (closure body / module init): `.push({S})` args, `Array<S>`-returning
  // calls, `[{S}, …]` array literals. Standalone `{S}` objects are independent
  // of array layout and intentionally left alone.
  const poisonAll = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '()') {
      const callee = node[1]
      if (typeof callee === 'string') {
        const sid = ctx.funcs.map?.get(callee)?.arrayElemSchema
        if (sid != null) black.add(sid)
      } else if (Array.isArray(callee) && callee[0] === '.' && callee[2] === 'push') {
        for (const a of argsOf(node)) {
          const sid = objLiteralSchemaId(a)
          if (sid != null) black.add(sid)
        }
      }
    } else if (op === '[' || op === '[]') {
      for (const el of staticArrayElems(node) || []) {
        const sid = objLiteralSchemaId(el)
        if (sid != null) black.add(sid)
      }
    }
    for (let i = 1; i < node.length; i++) poisonAll(node[i])
  }

  const cursorsByFunc = new Map()   // sig → Map<name, sid> — feeds inlineCellCursors
  const bracketKeyed = new Set()    // sids with `p['x']` cursor reads — those route
                                    // through the boxed dyn path (f64 slots), so
                                    // they stay on f64 cells (no i32 packing)
  // A no-array frame needs the call-composition walk ONLY when some function
  // program-wide returns an `Array<S>` (its result could flow into an
  // un-sanctioned call position here). With zero such functions, no `mk()`
  // call can carry an inline array, so the walk is a guaranteed no-op — skip
  // it (compile-time: the self-compile compiler has hundreds of array-free frames
  // whose full-body walk was pure waste).
  const anyArrRetFn = ctx.funcs.list.some(f => f?.arrayElemSchema != null && !f.raw)
  for (const func of ctx.funcs.list) {
    const functionPlan = ctx.plans.functions.get(func)
    const body = func?.body
    if (func?.raw || body == null || typeof body !== 'object') continue

    // `Array<S>` bindings of this function (codegen truth) and their schemas.
    // FunctionPlan stays opaque: iterate names and read detached scalar fields.
    const arrName = new Map()       // name → sid
    forEachFunctionPlanRep(ctx, functionPlan, name => {
      const sid = functionPlanRepField(ctx, functionPlan, name, 'arrayElemSchema')
      if (sid == null || (propsOf(sid).length || 0) < 1) return // K=0 — not inlinable
      cand.add(sid)
      arrName.set(name, sid)
    })
    // A frame with no tracked arrays of its own still gets the walk when the
    // program has Array<S>-returning functions: it can FORWARD inline-carried
    // returns through call compositions (`use(mk())` in a helper-free main,
    // `mk().length`) — the verify walk's call rules must see those sites (this
    // closed a live wrong-value: `mk().length` read the PHYSICAL cell count
    // K·n). When nothing returns Array<S>, the walk is provably a no-op.
    if (!arrName.size && !anyArrRetFn) continue

    // A structInline `Array<S>` value is only ever born from an empty `[]`
    // grown by structInline `.push`. `expr` is such a producer of `Array<sid>`
    // iff it is: a tracked `Array<sid>` alias, an empty `[]` literal, or a call
    // to a user function whose settled return fact IS `Array<sid>` (narrow's
    // fact — the exact agreement the receiving binding's own rep derives from;
    // a fact-less callee could return an inline-carried array into a binding
    // read as plain, `mk().length`-class). Every other source — a non-empty
    // `[{S},…]` literal, a builtin call (`JSON.parse`, `Object.values`, `.map`,
    // `.slice`, a member access onto a parsed object) — yields a taggedLinear
    // array and must poison sid.
    const safeArrSource = (expr, sid) => {
      if (typeof expr === 'string') return arrName.get(expr) === sid
      if (!Array.isArray(expr)) return false
      const elems = staticArrayElems(expr)
      if (elems) return elems.length === 0
      return expr[0] === '()' && typeof expr[1] === 'string' &&
        ctx.funcs.map?.get(expr[1])?.arrayElemSchema === sid
    }
    const isUserCall = (e) => Array.isArray(e) && e[0] === '()' && typeof e[1] === 'string'

    // Pass 1 — collect `const p = a[i]` cursors; drop on name clash / re-decl.
    const cursor = new Map()        // name → sid
    const declSeen = new Set()
    const collectCursors = (node) => {
      if (!Array.isArray(node) || node[0] === '=>') return
      if (node[0] === 'let' || node[0] === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
          const name = d[1], rhs = d[2]
          if (declSeen.has(name)) { const s = cursor.get(name); if (s != null) black.add(s) }
          declSeen.add(name)
          if (Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 &&
              typeof rhs[1] === 'string' && arrName.has(rhs[1]) && !isStrLit(rhs[2])) {
            const sid = arrName.get(rhs[1])
            if (cursor.has(name) || arrName.has(name)) black.add(sid)
            else cursor.set(name, sid)
          }
        }
      }
      for (let i = 1; i < node.length; i++) collectCursors(node[i])
    }
    collectCursors(body)
    if (cursor.size) cursorsByFunc.set(func.sig, cursor)

    // A `['[]', arrName, idx]` element read of a tracked array → its sid.
    const elemArrSid = (n) =>
      Array.isArray(n) && n[0] === '[]' && n.length === 3 &&
      typeof n[1] === 'string' && arrName.has(n[1]) && !isStrLit(n[2])
        ? arrName.get(n[1]) : null

    // Pass 2 — verify every occurrence is a structInline-handled use.
    const flag = (c) => {
      if (typeof c !== 'string') return false
      if (arrName.has(c)) { black.add(arrName.get(c)); return true }
      if (cursor.has(c)) { black.add(cursor.get(c)); return true }
      return false
    }
    const visitChild = (c) => { if (!flag(c)) verify(c) }

    // Argument walk of a direct user call — the one sanctioned way to verify
    // a call node. `Array<S>` values may cross a call boundary only when the
    // callee's param carries the same settled elem fact (a structInline-
    // carried array read as plain on the other side misinterprets cells —
    // both name args and `g(mk())` call-expr args need the agreement).
    function verifyCall(node) {
      const callee = node[1]
      const args = argsOf(node)
      const known = typeof callee === 'string' && ctx.funcs.map?.has(callee)
      const cParams = known ? paramReps?.get(callee) : null
      for (let k = 0; k < args.length; k++) {
        const arg = args[k]
        if (typeof arg === 'string' && arrName.has(arg)) {
          const sid = arrName.get(arg)
          if (!(known && cParams?.get(k)?.arrayElemSchema === sid)) black.add(sid)
        } else if (isUserCall(arg) && ctx.funcs.map?.get(arg[1])?.arrayElemSchema != null) {
          const rsid = ctx.funcs.map.get(arg[1]).arrayElemSchema
          if (!(known && cParams?.get(k)?.arrayElemSchema === rsid)) black.add(rsid)
          verifyCall(arg)
        } else if (!flag(arg)) verify(arg)
      }
    }

    function verify(node) {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'str') return
      if (op === '=>') {                       // closure — un-walked, poison
        for (const n of arrName.keys()) if (mentions(node, n)) black.add(arrName.get(n))
        for (const [n, s] of cursor) if (mentions(node, n)) black.add(s)
        poisonAll(node)
        return
      }
      if (op === ':') { visitChild(node[2]); return }

      if (op === '.' || op === '?.') {
        const o = node[1], p = node[2]
        if (typeof o === 'string') {
          if (arrName.has(o)) { if (!(op === '.' && p === 'length')) black.add(arrName.get(o)) }
          else if (cursor.has(o)) { if (!(op === '.' && inSchema(cursor.get(o), p))) black.add(cursor.get(o)) }
          return
        }
        const esid = elemArrSid(o)
        if (esid != null) {
          if (!(op === '.' && inSchema(esid, p))) black.add(esid)
          visitChild(o[2])
          return
        }
        visitChild(o)
        return
      }

      if (op === '[]') {
        const o = node[1], k = node[2]
        if (typeof o === 'string') {
          if (arrName.has(o)) black.add(arrName.get(o))   // element value escape
          else if (cursor.has(o)) {
            if (!(isStrLit(k) && inSchema(cursor.get(o), k[1]))) black.add(cursor.get(o))
            else bracketKeyed.add(cursor.get(o))   // legal, but f64-cells-only
          }
          if (k != null) visitChild(k)
          return
        }
        const esid = elemArrSid(o)
        if (esid != null) {
          if (!(isStrLit(k) && inSchema(esid, k[1]))) black.add(esid)
          else bracketKeyed.add(esid)
          visitChild(o[2])
        } else if (o != null) visitChild(o)
        if (k != null) visitChild(k)
        return
      }

      // Property WRITES on a tracked array (`a.length = n`, `a.length++`) —
      // the `.` receiver rule below allows `.length` READS only; a resize in
      // LOGICAL units through the physical-cell header would corrupt the
      // carrier's length semantics. Any dot-target write/update poisons.
      if ((op === '++' || op === '--' || ASSIGN_OPS.has(op)) &&
          Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.') &&
          typeof node[1][1] === 'string' && arrName.has(node[1][1])) {
        black.add(arrName.get(node[1][1]))
        for (let i = 2; i < node.length; i++) visitChild(node[i])
        return
      }

      // Wholesale element replace `a[i] = {S-literal}` — the immutable-update
      // idiom. Handled iff the whole-program alias sweep (scanInplaceStores)
      // proved every same-content store safe (content-keyed — node identity
      // does not survive analyzeFuncForEmit's loop rewrites) WITH target-
      // binding reuse: a same-index tracked cursor precedes the store, so the
      // replace idiom is separated from append-builders (`out[len] = {…}`),
      // which stay on the plain layout where extend keeps JS semantics. A
      // value-position `x = (a[i] = {…})` poisons the sid inside the sweep
      // itself (its `[]` target walks as a value read), so a surviving verdict
      // implies statement position. Index must be an int-certain name — a
      // fractional/negative index is a sidecar PROPERTY write in JS, which the
      // inline arm cannot express (it drops OOB writes like the checked typed
      // store). Emit lowers via emit-assign's tryStructInlineReplaceStore.
      if (op === '=' && Array.isArray(node[1]) && node[1][0] === '[]' && node[1].length === 3 &&
          typeof node[1][1] === 'string' && arrName.has(node[1][1])) {
        const sid = arrName.get(node[1][1])
        const rhs = node[2], idx = node[1][2]
        const entry = Array.isArray(rhs) && rhs[0] === '{}'
          ? ctx.schema.inplaceStores?.get(inplaceKey(node[1][1], rhs)) : null
        const idxIntCertain = typeof idx === 'string' &&
          functionPlanRepField(ctx, functionPlan, idx, 'intCertain') === true
        const ok = idxIntCertain && entry != null && entry.alias != null && entry.idx === idx &&
          objLiteralSchemaId(rhs) === sid
        if (!ok) {
          if (DBG) console.error('[inlarr-store-reject]', func.name, node[1][1], 'sid', sid,
            'idxIntCertain', idxIntCertain,
            'entry', entry, 'litSid', Array.isArray(rhs) ? objLiteralSchemaId(rhs) : null)
          black.add(sid)
          if (idx != null) visitChild(idx)
          if (rhs != null) visitChild(rhs)
          return
        }
        if (idx != null) visitChild(idx)
        // literal is a fresh value consumed by the store — verify slot values only
        const props = rhs.length === 2 && Array.isArray(rhs[1]) && rhs[1][0] === ',' ? rhs[1].slice(1) : rhs.slice(1)
        for (const pr of props) visitChild(Array.isArray(pr) && pr[0] === ':' ? pr[2] : pr)
        return
      }

      // Reassignment of the array binding — the rhs must be a structInline
      // `Array<S>` producer; an alias is left un-walked (flagging it would
      // self-poison), other producers are walked to verify their subtree.
      if (op === '=' && typeof node[1] === 'string' && arrName.has(node[1])) {
        const sid = arrName.get(node[1])
        if (!safeArrSource(node[2], sid)) black.add(sid)
        else if (isUserCall(node[2])) verifyCall(node[2])
        else if (typeof node[2] !== 'string') visitChild(node[2])
        return
      }

      if (op === '()') {
        const callee = node[1]
        if (Array.isArray(callee) && callee[0] === '.') {
          const recv = callee[1], method = callee[2]
          if (typeof recv === 'string' && arrName.has(recv)) {
            const sid = arrName.get(recv)
            const args = argsOf(node)
            if (method !== 'push' || !args.length) black.add(sid)
            else for (const arg of args) {
              if (Array.isArray(arg) && arg[0] === '{}' && objLiteralSchemaId(arg) === sid) {
                for (let i = 1; i < arg.length; i++) {
                  const pr = arg[i]
                  visitChild(Array.isArray(pr) && pr[0] === ':' ? pr[2] : pr)
                }
              } else black.add(sid)
            }
            return
          }
          if (typeof recv === 'string' && cursor.has(recv)) { black.add(cursor.get(recv)); return }
          const esid = elemArrSid(recv)
          if (esid != null) { black.add(esid); visitChild(recv[2]) }
          else visitChild(recv)
          for (const a of argsOf(node)) visitChild(a)
          return
        }
        if (typeof callee === 'string') {
          // A call reached through GENERIC descent is an un-sanctioned
          // position for an `Array<S>`-returning callee — a receiver
          // (`mk().length` reads the PHYSICAL cell count), an operand, a
          // spread, a bare statement. Sanctioned positions (decl init /
          // return with fact agreement, agreement-checked call args) route
          // through verifyCall directly and never reach this poison. An
          // expression-bodied arrow's whole body is its return position —
          // sanction it under the same fact agreement.
          const retSid = ctx.funcs.map?.get(callee)?.arrayElemSchema
          if (retSid != null && !(node === body && func.arrayElemSchema === retSid)) black.add(retSid)
          verifyCall(node)
          return
        }
        visitChild(callee)
        for (const a of argsOf(node)) visitChild(a)
        return
      }

      if (op === 'return') {
        const e = node[1]
        if (typeof e === 'string') {
          if (arrName.has(e)) { if (func.arrayElemSchema !== arrName.get(e)) black.add(arrName.get(e)) }
          else flag(e)
          return
        }
        // A function typed `Array<S>` must return a structInline producer —
        // a non-empty literal / builtin call here yields a taggedLinear array.
        if (func.arrayElemSchema != null && !safeArrSource(e, func.arrayElemSchema))
          black.add(func.arrayElemSchema)
        const esid = elemArrSid(e)
        if (esid != null) { black.add(esid); visitChild(e[2]); return }
        if (isUserCall(e)) {
          // `return g()` in a function with NO matching elem fact lets an
          // inline-carried array escape into fact-less land — poison unless
          // the facts agree (the agreeing case is the sanctioned position).
          const rsid = ctx.funcs.map?.get(e[1])?.arrayElemSchema
          if (rsid != null && func.arrayElemSchema !== rsid) black.add(rsid)
          verifyCall(e)
          return
        }
        if (e != null) visitChild(e)
        return
      }

      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=') { if (Array.isArray(d)) visitChild(d); continue }
          const name = d[1], rhs = d[2]
          if (typeof name === 'string' && cursor.has(name) &&
              Array.isArray(rhs) && rhs[0] === '[]') {
            if (rhs[2] != null) visitChild(rhs[2])   // cursor decl — verify index only
            continue
          }
          if (typeof name === 'string' && arrName.has(name)) {
            const sid = arrName.get(name)
            if (!safeArrSource(rhs, sid)) black.add(sid)               // non-structInline producer
            // [] / fact-agreeing user call — sanctioned; verify args/subtree
            else if (isUserCall(rhs)) verifyCall(rhs)
            else if (typeof rhs !== 'string') visitChild(rhs)
            continue
          }
          if (typeof name !== 'string') visitChild(name)
          visitChild(rhs)
        }
        return
      }

      for (let i = 1; i < node.length; i++) visitChild(node[i])
    }
    verify(body)
  }

  // Module inits are not walked in detail — poison any schema whose array form
  // could appear there (struct-array consumed/built at module scope).
  if (ctx.module?.moduleInits) for (const mi of ctx.module.moduleInits) poisonAll(mi)

  for (const sid of cand) if (!black.has(sid)) inlineArray.add(sid)

  // Packed i32 cells (inlineCellI32): all slots strict-int32 (slotI32Certain —
  // every censused write exactly-int32, never -0, hazard-belted), K ≥ 2 (a
  // 1-field element still occupies one 8-byte cell — packing buys nothing),
  // and no bracket-keyed cursor reads (those route through the boxed dyn
  // path, which assumes f64 slots). Elements then pack K raw i32 fields into
  // ⌈K/2⌉ physical cells — C's record layout; loads/stores drop the
  // trunc_sat/convert layer. The packed decision is consumed through cursor
  // nodes (inlineCellCursors → readVar's `.cellI32` tag), never the bare sid:
  // a standalone `{S}` object of the same sid keeps tagged f64 slots.
  for (const sid of inlineArray) {
    const props = propsOf(sid)
    if (props.length >= 2 && !bracketKeyed.has(sid) &&
        props.every(p => ctx.schema.slotI32CertainBySid?.(sid, p)))
      ctx.schema.inlineCellI32.add(sid)
  }
  for (const [sig, cur] of cursorsByFunc) {
    let set = null
    for (const [name, sid] of cur) if (ctx.schema.inlineCellI32.has(sid)) (set ??= new Set()).add(name)
    if (set) ctx.schema.inlineCellCursors.set(sig, set)
  }
  if (DBG) console.error('[inlarr]', 'eligible:', [...inlineArray], 'packedI32:', [...ctx.schema.inlineCellI32])
}

/** Closed heterogeneous unions as max-K-stride packed i32 cell arrays — the
 *  tagged-record stream layout (shapes class): `rows.push({k, …variant})` over
 *  a CLOSED schema set stores each record as `stride` raw i32 cells (stride =
 *  max member K; every member's slot i is cell i), contiguous — no per-record
 *  heap object, no element pointer. Reads devirt through the landed
 *  closed-union chain: the tag (union-agreeing slot) directly; variant fields
 *  under the user's own `tag === C` branches (discriminant refinement).
 *
 *  FAIL-CLOSED like analyzeStructInline: a union inlines only when EVERY use
 *  of every union-array binding and cursor — across all functions — is a
 *  handled shape, and every cursor field read RESOLVES statically (agreeing
 *  slot, or discriminant-narrowed members that agree). Anything else
 *  blacklists the union. v1 scope: packed-only (every member all-slots
 *  strict-int32), same-function cursors (`measure(rows[i])` param cursors are
 *  stage 3 — the pointer-ABI seam), reads only (element replace poisons).
 */
export function analyzeUnionInline(programFacts) {
  const registry = ctx.schema?.inlineUnion
  if (!registry || !ctx.schema?.list) return
  const DBG = typeof process !== 'undefined' && process.env?.JZ_DBG_INLARR
  const propsOf = (sid) => ctx.schema.list[sid] || []
  const keyOf = (sids) => sids.join(',')
  const black = new Set()                    // union keys disqualified
  const cand = new Map()                     // key → sids
  const uArraysByFunc = new Map(), uCursorsByFunc = new Map()

  const intLit = (n) => typeof n === 'number' && Number.isInteger(n) ? n
    : Array.isArray(n) && n[0] == null && Number.isInteger(n[1]) ? n[1] : null
  const litOfConst = (n) => intLit(n) ?? (typeof n === 'string' ? ctx.scope.constInts?.get(n) ?? null : null)

  // Union-agreeing slot for prop across MEMBERS (all contain it at one slot).
  const agreeSlot = (sids, prop) => {
    let slot = null
    for (const sid of sids) {
      const idx = propsOf(sid).indexOf(prop)
      if (idx < 0 || (slot != null && slot !== idx)) return -1
      slot = idx
    }
    return slot ?? -1
  }

  for (const func of ctx.funcs.list) {
    const functionPlan = ctx.plans.functions.get(func)
    const body = func?.body
    if (func?.raw || body == null || typeof body !== 'object') continue

    // Union-array bindings of this frame (rep channel — the landed census).
    const uArr = new Map()                   // name → key
    forEachFunctionPlanRep(ctx, functionPlan, name => {
      const set = functionPlanRepField(ctx, functionPlan, name, 'arrayElemSchemaSet')
      if (!set || set.length < 2) return
      const key = keyOf(set)
      if (!cand.has(key)) cand.set(key, set)
      uArr.set(name, key)
    })
    // Candidate cursor-PARAMS (stage 3): a param whose settled schemaIdSet
    // keys a union. Schema membership alone is NOT carrier provenance — the
    // body must survive the same cursor grammar as a local cursor (direct
    // narrowed dot reads only; any alias, bracket read, write, escape,
    // forward, or closure capture reinterprets the packed cell as a generic
    // object → miscompile). Seeding them into `cursor` runs the full verify
    // walk over this body and BLACKS the key on any violation — which also
    // keeps the CALLER from packing (one shared verdict, fail-closed).
    const cursorParams = new Map()
    const preps = programFacts.paramReps?.get(func.name)
    if (preps && func.sig?.params) for (let k = 0; k < func.sig.params.length; k++) {
      const set = preps.get(k)?.schemaIdSet
      const key = typeof set === 'string' ? set : Array.isArray(set) ? keyOf(set) : null
      if (!key || !key.includes(',')) continue
      cursorParams.set(func.sig.params[k].name, key)
      if (!cand.has(key)) cand.set(key, key.split(',').map(Number))
    }
    if (!uArr.size && !cursorParams.size) continue
    if (uArr.size) uArraysByFunc.set(func.sig, uArr)

    // `const t = o.PROP` aliases (discriminant reads) + `const o = a[i]`
    // cursors — pre-seeded with this function's candidate cursor-params so
    // the one grammar verifies (and later registers) both.
    const cursor = new Map(cursorParams)     // name → key
    const inbCursorPairs = new Set()
    scanBoundedArrIdx(body, inbCursorPairs, new Map())
    const tagAlias = new Map()               // tagLocal → { obj, prop }
    const declSeen = new Set()
    const shadowed = new Set()               // param names shadow-declared in the body
    const maskMax = new Map()                // name → max for `x = Y & LIT`
    const assigned = new Set()               // names written outside their decl
    ;(function collect(n) {
      if (!Array.isArray(n)) return
      if (n[0] === '=>') {
        // closure writes count too — a captured tag/mask local can change
        ;(function cw(m) {
          if (!Array.isArray(m)) return
          if (MUTATE_OPS.has(m[0]) && typeof m[1] === 'string') assigned.add(m[1])
          for (let i = 1; i < m.length; i++) cw(m[i])
        })(n)
        return
      }
      if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') assigned.add(n[1])
      if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const name = d[1], rhs = d[2]
        // First decl over a PRE-SEEDED cursor param = a block-scoped shadow:
        // the flow-insensitive maps cannot hold two meanings for one name, so
        // poison the param's key and bar the name from cursor re-admission
        // (a subsequent `[]`-cursor decl of the same name blacks that union
        // too — reads elsewhere in the body are ambiguous).
        if (cursor.has(name) && !declSeen.has(name)) {
          black.add(cursor.get(name)); cursor.delete(name); tagAlias.delete(name); shadowed.add(name)
        }
        if (declSeen.has(name)) { const k = cursor.get(name); if (k != null) black.add(k); cursor.delete(name); tagAlias.delete(name) }
        declSeen.add(name)
        if (Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 &&
            typeof rhs[1] === 'string' && uArr.has(rhs[1])) {
          // Index must be the canonical bounded pair (`for (i < a.length)` —
          // scanBoundedArrIdx): an unproven index mints a raw cell address
          // with no miss path. Fail closed otherwise.
          if (!shadowed.has(name) && typeof rhs[2] === 'string' && inbCursorPairs.has(rhs[1] + '\x00' + rhs[2]))
            cursor.set(name, uArr.get(rhs[1]))
          else black.add(uArr.get(rhs[1]))
        }
        else if (Array.isArray(rhs) && rhs[0] === '.' && typeof rhs[1] === 'string' && typeof rhs[2] === 'string')
          tagAlias.set(name, { obj: rhs[1], prop: rhs[2] })
        if (Array.isArray(rhs) && rhs[0] === '&') {
          const l = litOfConst(rhs[1]), r2 = litOfConst(rhs[2])
          const m = l != null && l >= 0 ? l : r2 != null && r2 >= 0 ? r2 : null
          if (m != null && m <= 0xFFFF) maskMax.set(name, m)
        }
      }
      if (n[0] === 'let' || n[0] === 'const') {
        // own the descent: the generic loop would re-visit each decl's inner
        // `=` node and count the INITIALIZER as an assignment, purging every
        // alias/mask the arm just recorded. Descend into the RHS values only.
        for (let i = 1; i < n.length; i++) {
          const d = n[i]
          if (Array.isArray(d) && d[0] === '=' && d[2] != null) collect(d[2])
          else collect(d)
        }
        return
      }
      for (let i = 1; i < n.length; i++) collect(n[i])
    })(body)
    // A tag alias or mask fact is single-def only: any assignment (incl. from
    // a closure) makes the refinement stale — unsound to narrow by. Drop.
    for (const name of assigned) { tagAlias.delete(name); maskMax.delete(name) }
    if (cursor.size) uCursorsByFunc.set(func.sig, cursor)

    // Discriminant narrowing of a member set under refs (Map tagLocal → int
    // exact | Set excluded). A member whose censused const for the tag slot
    // contradicts the refinement is excluded; unknown-const members stay.
    const narrow = (sids, oName, refs) => {
      if (!refs) return sids
      let out = sids
      for (const [t, v] of refs) {
        const al = tagAlias.get(t)
        if (!al || al.obj !== oName) continue
        out = out.filter(sid => {
          const slot = propsOf(sid).indexOf(al.prop)
          if (slot < 0) return typeof v !== 'number'   // missing prop reads undefined ≠ any int
          const cv = ctx.schema.slotConstInts?.get(sid)?.[slot]
          if (cv == null) return true                  // unknown const — keep (superset-sound)
          return typeof v === 'number' ? cv === v : !v.has(cv)
        })
      }
      return out
    }

    const condNV = (cond) => {
      if (!Array.isArray(cond) || cond[0] !== '===') return null
      const a = cond[1], b = cond[2], av = intLit(a), bv = intLit(b)
      if (typeof a === 'string' && bv != null) return [a, bv]
      if (typeof b === 'string' && av != null) return [b, av]
      return null
    }
    const thenRefs = (cond, refs) => {
      const nv = condNV(cond); if (!nv) return refs
      const out = new Map(refs || []); out.set(nv[0], nv[1]); return out
    }
    const elseRefs = (cond, refs) => {
      const nv = condNV(cond); if (!nv) return refs
      const [name, v] = nv
      const out = new Map(refs || [])
      const prev = out.get(name)
      if (typeof prev === 'number') return out
      const excl = new Set(prev instanceof Set ? prev : []); excl.add(v)
      const max = maskMax.get(name)
      if (max != null && excl.size === max) {
        for (let c = 0; c <= max; c++) if (!excl.has(c)) { out.set(name, c); return out }
      }
      out.set(name, excl)
      return out
    }

    // A cursor field read resolves iff the refs-narrowed members that could
    // reach it all CONTAIN prop at one slot, and no reachable member lacks it
    // (a lacking member's read is `undefined` — inexpressible in raw cells).
    const readResolves = (key, oName, prop, refs) => {
      const sids = cand.get(key)
      const reach = narrow(sids, oName, refs)
      if (!reach.length) return true                   // branch unreachable for the union
      if (reach.some(sid => propsOf(sid).indexOf(prop) < 0)) return false
      return agreeSlot(reach, prop) >= 0
    }

    const flag = (c) => {
      if (typeof c !== 'string') return false
      if (uArr.has(c)) { black.add(uArr.get(c)); return true }
      if (cursor.has(c)) { black.add(cursor.get(c)); return true }
      return false
    }

    ;(function verify(node, refs) {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'str') return
      const visit = (c) => { if (!flag(c)) verify(c, refs) }
      // Statement sequence: statements AFTER a terminator else-if ladder see
      // the stacked exclusion refinements — control past `if (c0) return …
      // else if (c1) return …` implies ¬cN for every level whose then-arm
      // terminates, up to the first non-terminator arm (mirrors
      // emitBlockBody's narrowing; without this the canonical trailing-
      // fallback read fails closed on props the excluded members lack).
      if (op === ';') {
        let cur = refs
        for (let i = 1; i < node.length; i++) {
          const s = node[i]
          verify(s, cur)
          if (Array.isArray(s) && s[0] === 'if' && isTerminator(s[2])) {
            let t = s
            while (Array.isArray(t) && t[0] === 'if' && isTerminator(t[2])) {
              cur = elseRefs(t[1], cur)
              t = t[3]
            }
          }
        }
        return
      }
      if (op === '=>') {                     // closures un-walked — poison mentions
        const touches = (n, name) => typeof n === 'string' ? n === name
          : Array.isArray(n) ? n.slice(1).some(c => touches(c, name)) : false
        for (const [n, k] of uArr) if (touches(node, n)) black.add(k)
        for (const [n, k] of cursor) if (touches(node, n)) black.add(k)
        return
      }
      if (op === 'if' || op === '?:') {
        verify(node[1], refs)
        const isTern = op === '?:'
        verify(node[2], thenRefs(node[1], refs))
        const elseArm = isTern ? node[3] : node[3]
        if (elseArm != null) verify(elseArm, elseRefs(node[1], refs))
        if (isTern && node.length > 4) for (let i = 4; i < node.length; i++) verify(node[i], refs)
        return
      }
      if (op === '.' || op === '?.') {
        const o = node[1], p = node[2]
        if (typeof o === 'string') {
          if (uArr.has(o)) { if (!(op === '.' && p === 'length')) black.add(uArr.get(o)) }
          else if (cursor.has(o)) { if (!(op === '.' && readResolves(cursor.get(o), o, p, refs))) black.add(cursor.get(o)) }
          return
        }
        // direct `a[i].p` — treated as an anonymous cursor of a[i]'s union
        if (Array.isArray(o) && o[0] === '[]' && typeof o[1] === 'string' && uArr.has(o[1])) {
          const key = uArr.get(o[1])
          // no alias name → only union-agreeing props resolve
          if (!(op === '.' && agreeSlot(cand.get(key), p) >= 0)) black.add(key)
          verify(o[2], refs)
          return
        }
        visit(o)
        return
      }
      if (op === '[]') {
        const o = node[1], k = node[2]
        if (typeof o === 'string' && uArr.has(o)) {
          // bare a[i] in value position outside a cursor decl → escape; the
          // cursor decls were collected up front and are re-matched here so
          // the generic descent doesn't double-reject them (decl handling).
          black.add(uArr.get(o))
          if (k != null) verify(k, refs)
          return
        }
        if (typeof o === 'string' && cursor.has(o)) { black.add(cursor.get(o)); if (k != null) verify(k, refs); return }
        if (o != null) visit(o)
        if (k != null) verify(k, refs)
        return
      }
      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=') { verify(d, refs); continue }
          const name = d[1], rhs = d[2]
          if (typeof name === 'string' && cursor.has(name) && Array.isArray(rhs) && rhs[0] === '[]') {
            if (rhs[2] != null) verify(rhs[2], refs)   // sanctioned cursor decl — index only
            continue
          }
          if (typeof name === 'string' && uArr.has(name)) {
            const key = uArr.get(name)
            // A union array is born from an empty `[]` (built by member pushes)
            // OR from a user call whose settled return union IS this key
            // (`const rows = initRows()`), OR aliased from another union-key
            // binding. Any other producer poisons.
            const elems = staticArrayElems(rhs)
            const bornEmpty = elems && elems.length === 0
            const bornCall = Array.isArray(rhs) && rhs[0] === '()' && typeof rhs[1] === 'string' &&
              ctx.funcs.map?.get(rhs[1])?.arrayElemSchemaSet === key
            const bornAlias = typeof rhs === 'string' && uArr.get(rhs) === key
            if (!(bornEmpty || bornCall || bornAlias)) black.add(key)
            continue
          }
          // Shadow decl of a cursor name (a block-scoped `const o = other`
          // over a cursor PARAM, or a non-sanctioned cursor redecl): later
          // reads of the name would keep the packed-cell tag while holding
          // an arbitrary value. Fail closed.
          if (typeof name === 'string' && cursor.has(name)) {
            black.add(cursor.get(name))
            if (rhs != null) visit(rhs)
            continue
          }
          if (typeof name !== 'string') verify(name, refs)
          if (rhs != null) visit(rhs)
        }
        return
      }
      if ((op === '++' || op === '--' || ASSIGN_OPS.has(op))) {
        const lhs = node[1]
        if (Array.isArray(lhs) && (lhs[0] === '.' || lhs[0] === '?.' || lhs[0] === '[]') && typeof lhs[1] === 'string') {
          if (uArr.has(lhs[1])) { black.add(uArr.get(lhs[1])); return }   // element replace / length write — v1 reads-only
          if (cursor.has(lhs[1])) { black.add(cursor.get(lhs[1])); return }
        }
        if (typeof lhs === 'string' && (uArr.has(lhs) || cursor.has(lhs))) { flag(lhs); return }
        for (let i = 1; i < node.length; i++) visit(node[i])
        return
      }
      if (op === '()') {
        const callee = node[1]
        const args = node[2] == null ? [] : (Array.isArray(node[2]) && node[2][0] === ',') ? node[2].slice(1) : [node[2]]
        if (Array.isArray(callee) && callee[0] === '.' && typeof callee[1] === 'string' && uArr.has(callee[1])) {
          const key = uArr.get(callee[1])
          if (callee[2] !== 'push' || !args.length) { black.add(key); return }
          for (const arg of args) {
            const sid = Array.isArray(arg) && arg[0] === '{}' ? objLiteralSchemaId(arg) : null
            if (sid == null || !cand.get(key).includes(sid)) { black.add(key); continue }
            const props = arg.length === 2 && Array.isArray(arg[1]) && arg[1][0] === ',' ? arg[1].slice(1) : arg.slice(1)
            for (const pr of props) visit(Array.isArray(pr) && pr[0] === ':' ? pr[2] : pr)
          }
          return
        }
        // Two sanctioned cross-call flows to a direct user callee:
        //   1. a union ARRAY arg — callee param carries the same settled
        //      arrayElemSchemaSet (canonical key).
        //   2. a CURSOR arg `arr[i]` (an element of a union array) — callee
        //      param carries the same settled schemaIdSet, i.e. it reads `o`
        //      through the packed-cell union carrier (`measure(rows[i])`).
        //      The cell address is stable across the call only if the callee
        //      grows NO union array reachable from its args; here the union
        //      arrays are function-local (never params), so a callee cannot
        //      reach one — trivially safe. (Passing a union array itself as a
        //      grow-capable arg is covered by case 1's array-agreement gate.)
        if (typeof callee === 'string') {
          const cParams = programFacts.paramReps?.get(callee)
          for (let k = 0; k < args.length; k++) {
            const a = args[k]
            if (typeof a === 'string' && uArr.has(a)) {
              if (cParams?.get(k)?.arrayElemSchemaSet !== uArr.get(a)) black.add(uArr.get(a))
            } else if (Array.isArray(a) && a[0] === '[]' && typeof a[1] === 'string' && uArr.has(a[1]) &&
                       inbCursorPairs.has(a[1] + '\x00' + a[2])) {
              // element cursor crossing — needs param schemaIdSet agreement.
              if (cParams?.get(k)?.schemaIdSet !== uArr.get(a[1])) black.add(uArr.get(a[1]))
            } else visit(a)
          }
          return
        }
        if (callee != null && typeof callee !== 'string') visit(callee)
        for (const a of args) visit(a)                  // union array/cursor as arg → flag → poison (stage 3 lifts)
        return
      }
      // `return rows` — sanctioned when this function's OWN settled return
      // fact is the same union (narrowReturnArrayElems' canonical key).
      if (op === 'return') {
        const v = node[1]
        if (typeof v === 'string' && uArr.has(v)) {
          if (func.arrayElemSchemaSet !== uArr.get(v)) black.add(uArr.get(v))
          return
        }
        if (v != null) visit(v)
        return
      }
      for (let i = 1; i < node.length; i++) visit(node[i])
    })(body, null)
  }

  // v1: packed-only — every member all-slots strict-int32 and stride ≥ 2.
  for (const [key, sids] of cand) {
    if (black.has(key)) continue
    const stride = Math.max(...sids.map(sid => propsOf(sid).length))
    const packed = stride >= 2 && sids.every(sid => propsOf(sid).every(p => ctx.schema.slotI32CertainBySid?.(sid, p)))
    if (!packed) continue
    registry.set(key, { sids, stride })
  }
  for (const [sig, m] of uArraysByFunc) {
    let keep = null
    for (const [name, key] of m) if (registry.has(key)) (keep ??= new Map()).set(name, key)
    if (keep) ctx.schema.inlineUnionArrays.set(sig, keep)
  }
  // Registers LOCAL cursors and cursor-PARAMS alike — both entered `cursor`
  // in the per-function walk, so registration here is registration of a
  // VERIFIED name only (a param whose body violated the cursor grammar
  // blacked its key above, dropping it from the registry). The param stays
  // f64 in the sig (the cell address rides the OBJECT NaN-box across the
  // call, unboxed at first read) — no sig-type narrowing, no cross-phase
  // ordering hazard.
  for (const [sig, m] of uCursorsByFunc) {
    let keep = null
    for (const [name, key] of m) if (registry.has(key)) (keep ??= new Map()).set(name, key)
    if (keep) ctx.schema.inlineUnionCursors.set(sig, keep)
  }
  if (DBG) console.error('[inlarr-union]', 'eligible:', [...registry.keys()], 'black:', [...black])
}

/** Schema id when `name` is bound (codegen truth) to a structInline `Array<S>`,
 *  else null. `ctx.func.localReps` is the per-function rep map the emitter
 *  consults for element-schema facts; `ctx.schema.inlineArray` is the
 *  whole-program eligibility set filled by `analyzeStructInline`. Read together
 *  so the emitter never inline-carries a binding the analysis rejected. */

/**
 * Whole-program function-namespace SRoA analysis.
 *
 * A user function used as a property bag — `parse.space = …; parse.step()` —
 * is otherwise compiled as a dynamic object: each `f.prop` write becomes a
 * `__dyn_set` into a hash side-table keyed by the closure pointer, each read a
 * `__dyn_get`. But a function's property table can never be observed by the
 * host (the host gets only the callable; the table lives in jz linear memory),
 * so the property set is statically closed — jz sees every `f.PROP` site. When
 * `f` never escapes as a bare value, each property dissolves:
 *   - written once, at module top level, to a known function → the property is
 *     constant: every `f.PROP` site rewrites straight to that function name
 *     (direct calls, no storage at all).
 *   - otherwise → a mutable f64 module global (`global.get` / `global.set`).
 *
 * Escape-as-CALLEE vs escape-as-TABLE: `f`/`f.PROP` appearing as a call's
 * callee (`f(...)`, `f?.(...)`, `f.prop(...)`, `f.prop?.(...)`) or as the
 * exported value (`export`) hands out only the invoked/callable function
 * VALUE — never a handle onto f's property table — so neither disqualifies.
 * Every other bare mention of `f` (stored into a data structure, aliased
 * `let g = f`, compared, an argument to anything but treated as a plain call
 * position, `f[computed]`/`f?.[computed]`) COULD leak a reference the table
 * is reachable through, so it still disqualifies (`start strict`: this is
 * deliberately not trying to prove higher-order callback safety yet).
 *
 * Returns `Map<funcName, { disq, props:Set, valRead:Set,
 * writes:Map<prop,[{rhs,atInit}]> }>` — `valRead` is the subset of props read
 * as a value (not merely called). `flattenFuncNamespaces` (plan.js) turns it
 * into the rewrite. A name carrying `disq` escapes / is reassigned / is
 * computed-indexed and must not be touched.
 */
export function analyzeFuncNamespaces(ast) {
  const funcNames = ctx.funcs.names
  if (!funcNames || !funcNames.size) return new Map()

  const ns = new Map()
  const rec = (name) => {
    let r = ns.get(name)
    if (!r) ns.set(name, r = { disq: false, props: new Set(), valRead: new Set(), writes: new Map() })
    return r
  }
  // `['.'|'?.', f, P]` member where f is a known function and P a string key.
  const memberOf = (n) =>
    Array.isArray(n) && (n[0] === '.' || n[0] === '?.') &&
    isFuncRef(n[1], funcNames) && typeof n[2] === 'string' ? n : null

  // `atInit` — node is a direct top-level statement (constant-fold candidate);
  // read only at the `=` handler, never propagated into sub-expressions.
  function visit(node, atInit) {
    if (typeof node === 'string') {
      // Bare mention of a known function in value position — it escapes; an
      // alias could reach its property table. Disqualify.
      if (funcNames.has(node)) rec(node).disq = true
      return
    }
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=') {
          if (!isFuncRef(d[1], funcNames)) visit(d[1], false)  // skip f's own decl
          // `let f = f` is prepare's self-name placeholder for a lifted function —
          // skip it (a bare visit would falsely disqualify f). Any other funcRef
          // rhs (`let g = f`) is a real alias and must disqualify f.
          if (!(isFuncRef(d[2], funcNames) && d[2] === d[1])) visit(d[2], false)
        } else visit(d, false)
      }
      return
    }

    if (op === 'export') {
      // Exporting the function value is safe — the host gets the callable,
      // never the linear-memory property table. Skip bare function children.
      for (let i = 1; i < node.length; i++)
        if (!isFuncRef(node[i], funcNames)) visit(node[i], false)
      return
    }

    if (op === '=') {
      const m = memberOf(node[1])
      if (m) {
        const r = rec(m[1]); r.props.add(m[2])
        let w = r.writes.get(m[2]); if (!w) r.writes.set(m[2], w = [])
        w.push({ rhs: node[2], atInit })
        visit(node[2], false)
        return
      }
      if (isFuncRef(node[1], funcNames)) rec(node[1]).disq = true  // reassignment
      else visit(node[1], false)
      visit(node[2], false)
      return
    }

    // `f(...)` / `f?.(...)` and `f.PROP(...)` / `f.PROP?.(...)` — escape-as-
    // CALLEE, not escape-as-table. Calling f (or a prop of f) hands the host/
    // callee only the invoked function VALUE, never f's property table, so
    // neither shape disqualifies. `prep()` keeps `?.()` a distinct op from
    // `()` (same flattened-args shape — see prepare/index.js's `'?.()'`
    // handler) — mirror both here, exactly as `boundSafeCalls` does.
    if (op === '()' || op === '?.()') {
      const m = memberOf(node[1])
      if (m) rec(m[1]).props.add(m[2])
      else if (!isFuncRef(node[1], funcNames)) visit(node[1], false)  // bare f(...)/f?.(...) ok
      for (let i = 2; i < node.length; i++) visit(node[i], false)
      return
    }

    // `f.PROP` / `f?.PROP` as a plain value (read) — not the callee of a call
    // (those are handled by the `()`/`?.()` branch above). A value-read means
    // the property's stored value must stay retrievable; devirt cannot drop it.
    const m = memberOf(node)
    if (m) { const r = rec(m[1]); r.props.add(m[2]); r.valRead.add(m[2]); return }

    // Computed `f[k]` / `f?.[k]` — the key set is no longer static: a genuine
    // table escape (unlike computed CALL args, this reaches arbitrary props).
    if ((op === '[]' || op === '?.[]') && isFuncRef(node[1], funcNames)) {
      rec(node[1]).disq = true
      for (let i = 2; i < node.length; i++) visit(node[i], false)
      return
    }

    for (let i = 1; i < node.length; i++) visit(node[i], false)
  }

  const visitTop = (n) => {
    if (Array.isArray(n) && n[0] === ';')
      for (let i = 1; i < n.length; i++) visit(n[i], true)
    else visit(n, true)
  }
  visitTop(ast)
  // Bundled multi-module programs keep each module's top-level statements in
  // moduleInits, not `ast` — the `f.prop = …` writes that define a namespace
  // live there. Walk them at init scope so writes are recorded and an escape
  // inside init code still disqualifies.
  for (const mi of ctx.module.moduleInits || []) visitTop(mi)
  for (const fn of ctx.funcs.list) if (fn.body && !fn.raw) visit(fn.body, false)

  return ns
}

