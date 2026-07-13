/**
 * Pre-analysis passes — type inference, local analysis, capture detection.
 *
 * # Stage contract
 *   IN:  prepared AST + ctx.func.list (from prepare).
 *   OUT: per-function populated `ctx.func.localReps` (val field) + `ctx.func.locals` + `ctx.func.boxed`,
 *        module-global `ctx.scope.globalValTypes`, type-analysis `ctx.types.typedElem` /
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

import { commaList, ASSIGN_OPS, isReassigned, STMT_OPS, isBlockBody, isLiteralStr, isFuncRef, I32_MIN, I32_MAX, isI32, T, extractParams, classifyParam, collectParamNames, alwaysReturns, returnExprs, refsName, REFS_IN_EXPR } from '../ast.js'
import { ctx, err } from '../ctx.js'
import { VAL, repOf, repOfGlobal, updateRep, updateGlobalRep, lookupValType, lookupNotString } from '../reps.js'
import { valTypeOf, jsonConstString, shapeOf, shapeOfObjectLiteralAst } from '../kind.js'
import { intLiteralValue, nonNegIntLiteral, constIntExpr, NO_VALUE, staticPropertyKey, staticValue, staticObjectProps, staticArrayElems, objLiteralSchemaId, exprSchemaId, inlineArraySid } from '../static.js'
import { typedElemCtor, typedStaticLen, MIXED_CTORS, isCondExpr, ternaryCtorOfRhs, scanBoundedLoops, inBoundsCharCodeAt, exprType, intCertainMap } from '../type.js'
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
  collectI32SafeIndexVars, collectF64StridedIndexVars, narrowUint32, scanBindingUses,
  scanFlatObjects, scanSliceViews, scanNeverGrown, scanNumericFill, USE,
} from './analyze-scans.js'

export { findFreeVars, findMutations, boxedCaptures } from './analyze-scans.js'

let _bodyFactsCache = new WeakMap()
// Self-host-only: see resetProgramFactsCache (program-facts.js) — the WeakMap's own
// backing storage is an arena allocation that a warm-instance `_clear` rewinds, so
// a compile-clear-compile loop must swap in a fresh instance, not just rely on
// per-body identity misses (which natively is enough since AST nodes are fresh
// each compile and the old WeakMap contents just become GC-unreachable).
export function resetBodyFactsCache() { _bodyFactsCache = new WeakMap() }

// Per-name monotone fact trackers over a pluggable {get,set,delete} store. First
// observation wins; a conflicting later one poisons the name (and clears the store
// entry) so a sibling-scope decl (jz hoists `let` to function scope) can't lock in
// the wrong value. The get/set/del closures abstract WHERE the slice lives, letting
// analyzeBody (local Map) and analyzeValTypes (ctx.func.localReps / ctx.types.typedElem)
// share one definition — so the two body walks can't drift. Passed as three positional
// closures rather than a {get,set,delete} store object: a Map satisfies that interface
// natively (analyzeBody's slices) but the analyzeValTypes slices need custom logic
// (updateRep), so the param would be polymorphic (Map | object) — which the self-host
// kernel cannot statically type, mis-dispatching `store.set` on the object form to the
// Map builtin. Direct closure calls sidestep method dispatch entirely.
const makeValTracker = (get, set, del) => {
  const poison = new Set()
  return (name, vt) => {
    if (poison.has(name)) return
    const prev = get(name)
    if (!vt) { if (prev) poison.add(name); del(name); return }
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
  // `ctx.types.typedElem` per-func). Lets `let cur = flip ? bufA : bufB` keep
  // the fast typed-load path instead of decaying to `$__typed_idx`.
  const resolveName = (n) =>
    get(n) ?? ctx.types.typedElem?.get(n) ?? ctx.scope.globalTypedElem?.get(n) ?? null
  return (name, rhs) => {
    if (poison.has(name)) return
    const setOrInvalidate = (c) => {
      if (c === MIXED_CTORS) return invalidate(name)
      // Module-level alias fact: a `.view` ctor (subarray / buffer-backed) is the ONLY
      // way two typed-array bindings can overlap. Recording that the program creates
      // ANY view lets memory-reordering passes (SLP) stay sound by bailing when set —
      // with no view, distinct typed bases own disjoint allocations.
      if (typeof c === 'string' && c.endsWith('.view')) ctx.features.typedView = true
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
          const len = typedStaticLen(rhs)
          const prevLen = getLen(name)
          if (len == null || (prevLen !== undefined && prevLen !== len)) delLen(name)
          else setLen(name, len)
        }
      }
    }
    const ctor = typedElemCtor(rhs)
    if (ctor) return setOrInvalidate(ctor)
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
      const f = ctx.func.map?.get(rhs[1])
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
 * narrows). The cache is therefore *intentionally staleable* — invalidateLocalsCache
 * is placed at the phase boundaries where a stale read would matter, not "everywhere".
 * A recompute-vs-cache assertion was tried (JZ_DEBUG_CACHE) and abandoned: it fires
 * on benign staleness (the suite stays green through the divergence), so it can't
 * tell a real missing-invalidation from a harmless one. See .work/todo.md.
 */
export function analyzeBody(body) {
  // Non-object bodies (`() => 0`, `() => x`, missing) have nothing to observe
  // for any slice and can't be WeakMap-keyed. Return empty maps without caching.
  if (body === null || typeof body !== 'object') return {
    locals: new Map(), valTypes: new Map(), arrElemSchemas: new Map(),
    arrElemValTypes: new Map(), arrElemTypedCtors: new Map(), typedElems: new Map(), escapes: new Map(),
    flatObjects: new Map(),
  }
  const hit = _bodyFactsCache.get(body)
  if (hit) return hit

  const locals = new Map()
  const valTypes = new Map()
  const arrElemSchemas = new Map()
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

  const exprElemSourceVal = (expr) => {
    if (typeof expr === 'string') {
      const repVt = ctx.func.localReps?.get(expr)?.val
      if (repVt) return repVt
      return ctx.scope.globalValTypes?.get(expr) || null
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

  // Local-Map slices: bind the Map's get/set/delete as the tracker's three ops.
  const trackVal = makeValTracker(n => valTypes.get(n), (n, vt) => valTypes.set(n, vt), n => valTypes.delete(n))
  const trackTyped = makeTypedTracker(n => typedElems.get(n), (n, c) => typedElems.set(n, c), n => typedElems.delete(n),
    n => typedLens.get(n), (n, l) => typedLens.set(n, l), n => typedLens.delete(n))

  // === Per-decl observation (called for each `let`/`const` `name = rhs`) ===
  const processDecl = (name, rhs) => {
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
        const f = ctx.func.map?.get(rhs[1])
        if (f?.arrayElemSchema != null) observeArrSchema(name, f.arrayElemSchema)
      }
      if (typeof rhs === 'string' && arrElemSchemas.has(rhs)) {
        const sid2 = arrElemSchemas.get(rhs)
        if (sid2 != null) observeArrSchema(name, sid2)
      }
      if (typeof rhs === 'string') {
        const repSid = ctx.func.localReps?.get(rhs)?.arrayElemSchema
        if (repSid != null) observeArrSchema(name, repSid)
      }
    }

    // arr-elem val type (arrElemValTypes slice) — array-literal init + call return + alias + .map/.filter/.slice/.concat chain
    {
      const rawElems = staticArrayElems(rhs)
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
      const f = ctx.func.map?.get(rhs[1])
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

  // === Single walk ===
  function walk(node) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return  // don't cross closure boundary

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

    // arr.push(...) — observe both schemas and val types in one pass
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && node[1][2] === 'push' && typeof node[1][1] === 'string') {
      const arr = node[1][1]
      const list = commaList(node[2])
      for (const a of list) {
        if (Array.isArray(a) && a[0] === '...') {
          observeArrSchema(arr, null); observeArrValType(arr, null); continue
        }
        observeArrSchema(arr, exprSchemaId(a, localSchemaMap))
        observeArrValType(arr, exprElemSourceVal(a))
        // `ch.push(new Float32Array(m))` — track the element ctor so `ch[c][i]`
        // inlines, same as the Array.from / array-literal forms.
        if (exprElemSourceVal(a) === VAL.TYPED) observeArrTypedCtor(arr, elemTypedCtorOf(a))
      }
    }

    // `ch[c] = new Float32Array(m)` — index-fill construction of a typed-array-of-
    // arrays (`let ch = new Array(n); for(c) ch[c] = new T(m)`). Mirror push.
    if (op === '=' && Array.isArray(node[1]) && node[1][0] === '[]' && node[1].length === 3
        && typeof node[1][1] === 'string' && valTypeOf(node[2]) === VAL.TYPED) {
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
      trackVal(name, valTypeOf(rhs))
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

    if (op === '[]' && typeof node[1] === 'string' && escapes.has(node[1])) {
      const key = node[2]
      if (!isStaticIndex(key)) markEscape(node[1])
    }

    for (let i = 1; i < node.length; i++) walk(node[i])
  }

  // Install the in-progress valTypes as a lookup overlay so successive decls
  // resolve chains (`const a = new TypedArr(); const b = a[0]` → b: NUMBER)
  // and shorthand-bound `{a}` props see a's type. Restored after walk completes.
  const prevOverlay = ctx.func.localValTypesOverlay
  const prevTypedOverlay = ctx.func.localTypedElemsOverlay
  ctx.func.localValTypesOverlay = valTypes
  ctx.func.localTypedElemsOverlay = typedElems
  let unsignedLocals, numericFill
  try {
    walk(body)
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
  } finally {
    ctx.func.localValTypesOverlay = prevOverlay
    ctx.func.localTypedElemsOverlay = prevTypedOverlay
  }

  // SRoA: dissolve non-escaping object-literal bindings into field locals.
  // The dead `o` local is dropped — every `o` reference is rewritten by the
  // codegen flat hooks, so a stray `local.get $o` becomes a loud wasm
  // validation error instead of a silent miscompile.
  const flatObjects = doSchemas ? scanFlatObjects(body) : new Map()
  for (const [name, props] of flatObjects) {
    for (let i = 0; i < props.names.length; i++) locals.set(`${name}#${i}`, 'f64')
    locals.delete(name)
  }

  // No-copy slice views — `let t = s.slice(...)` bindings proven non-escaping.
  // Consumed by emitDecl, which lowers the initializer to a SLICE_BIT view.
  const sliceViews = doSchemas ? scanSliceViews(body) : new Set()

  // Never-relocated array bindings — reads may skip the realloc-forwarding follow.
  const neverGrown = doSchemas ? scanNeverGrown(body) : new Set()

  const result = { locals, valTypes, arrElemSchemas, arrElemValTypes, arrElemTypedCtors, typedElems, typedLens, escapes, flatObjects, sliceViews, unsignedLocals, neverGrown, numericFill }
  _bodyFactsCache.set(body, result)
  return result
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
  const intCounters = intCertainMap(body, nestedNames)
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
}

/** Drop the cached analyzeBody entry for this body. Used by emitFunc after
 *  seeding cross-call param VAL facts so the next walk picks up fresh
 *  `ctx.func.localReps` (drives exprType receiver-type lookups).
 *  Same hook as `invalidateValTypesCache` — split names preserve caller intent. */
export function invalidateLocalsCache(body) {
  if (body && typeof body === 'object') _bodyFactsCache.delete(body)
}

// Can this RHS expression produce null/undefined? FAIL-CLOSED: anything not
// STRUCTURALLY provable non-nullish counts nullable. The flag's only effect
// is suppressing emit.js's strictSentinel constant fold (the comparison pays
// a cheap runtime nullish check instead) plus capture propagation — while a
// wrong non-nullable verdict FOLDS AWAY a real miss guard. The old shape
// list (nullish literals + ternary arms only) was sound while opaque sources
// carried no value kind (no kind ⇒ no fold); the Map/element value-kind
// inference broke that assumption: the self-host kernel's own
// `autoCache.get(name) !== undefined` cache probe folded to TRUE (the get's
// rep carried the map's value kind, non-nullable) and every autoDepsOf call
// returned the miss sentinel unconditionally — the byte-parity root.
const NEVER_NULLISH_OPS = new Set([
  'str', '//', '{}', '[', '=>', 'new', 'bool',
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

/**
 * Analyze all local value types from declarations and assignments.
 * Writes the per-name `val` field of `ctx.func.localReps` for method dispatch
 * and schema resolution.
 */
export function analyzeValTypes(body) {
  // localReps slice: store reads/writes the rep's `val` field (updateRep clears it
  // when set to undefined, matching the old explicit delete).
  const setVal = makeValTracker(
    (n) => ctx.func.localReps?.get(n)?.val,
    (n, vt) => updateRep(n, { val: vt }),
    (n) => updateRep(n, { val: undefined }),
  )
  const getVal = name => ctx.func.localReps?.get(name)?.val
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
  // Resolve a name's array-elem-schema, preferring rep.arrayElemSchema (set from
  // paramReps[k].arrayElemSchema at emit start) over local body observations.
  const arrElemSchemaOf = (name) => {
    if (typeof name !== 'string') return null
    const repSid = ctx.func.localReps?.get(name)?.arrayElemSchema
    if (repSid != null) return repSid
    const localSid = arrElems.get(name)
    return localSid != null ? localSid : null
  }
  function trackRegex(name, rhs) {
    if (ctx.runtime.regex && Array.isArray(rhs) && rhs[0] === '//') ctx.runtime.regex.vars.set(name, rhs)
  }
  // ctx.types.typedElem slice (lazily created on first write, as before — readers
  // tolerate null). Disagreeing decls poison the name (jz hoists `let` to function
  // scope, so sibling-scope decls share a name and must not lock in a wrong width).
  const trackTyped = makeTypedTracker(
    (n) => ctx.types.typedElem?.get(n),
    (n, c) => (ctx.types.typedElem ??= new Map()).set(n, c),
    (n) => ctx.types.typedElem?.delete(n),
    (n) => ctx.types.typedLen?.get(n),
    (n, l) => (ctx.types.typedLen ??= new Map()).set(n, l),
    (n) => ctx.types.typedLen?.delete(n),
  )
  // Total write count for `name` across the whole body, recursing into nested
  // closures so a closure that reassigns the var is also counted. Capped at 2 —
  // callers only need the "exactly one write" verdict.
  function writeCount(node, name, n) {
    if (n > 1 || !Array.isArray(node)) return n
    const o = node[0]
    if ((ASSIGN_OPS.has(o) || o === '++' || o === '--') && node[1] === name) n++
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
  function walk(node) {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return  // don't leak inner-closure val types
    // Propagate typed array type through method calls (e.g. buf.map → typed)
    function propagateTyped(name, rhs) {
      if (!Array.isArray(rhs) || rhs[0] !== '()') return
      const callee = rhs[1]
      if (!Array.isArray(callee) || callee[0] !== '.') return
      const src = callee[1], method = callee[2]
      if (typeof src === 'string' && getVal(src) === VAL.TYPED && method === 'map') {
        setVal(name, VAL.TYPED)
        if (ctx.types.typedElem?.has(src)) {
          const srcCtor = ctx.types.typedElem.get(src)
          ctx.types.typedElem.set(name, srcCtor.endsWith('.view') ? srcCtor.slice(0, -5) : srcCtor)
        }
      }
    }
    if (op === 'let' || op === 'const') {
      for (const a of args) {
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        const vt = valTypeOf(a[2])
        setVal(a[1], vt)
        if (mayBeNullish(a[2])) updateRep(a[1], { nullable: true })
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
          const f = ctx.func.map?.get(a[2][1])
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
          }
        }
      }
    }
    if (op === '=' && typeof args[0] === 'string') {
      walk(args[1])
      const vt = valTypeOf(args[1])
      setVal(args[0], vt)
      if (mayBeNullish(args[1])) updateRep(args[0], { nullable: true })
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
  walk(body)

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
        const f = ctx.func.map?.get(expr[1])
        return f?.sig?.ptrKind === kind
      }
      // `let p = arr[i]` where arr has a known elem schema: the runtime helper
      // returns f64 (NaN-box of an OBJECT pointer), but its low 32 bits are
      // exactly the pointer offset. Dual-write coerces once via reinterpret/wrap;
      // subsequent `p.x` reads then become direct `f64.load offset=K (local.get $p)`
      // (since ptrOffsetIR sees ptrKind=OBJECT and skips the per-access wrap).
      if (expr[0] === '[]' && typeof expr[1] === 'string') {
        const repSid = ctx.func.localReps?.get(expr[1])?.arrayElemSchema
        return repSid != null
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
      const f = ctx.func.map?.get(callee)
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
        ctx.types.typedElem?.has(expr[1][1])) {
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
    if (ASSIGN_OPS.has(op) || op === '++' || op === '--' || op === 'delete') {
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
    if ((ASSIGN_OPS.has(op) || op === '++' || op === '--') && Array.isArray(node[1]) &&
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
 * (`funcFacts.get(func).localReps`) carries `arrayElemSchema = S` — the exact
 * map the emitter consults — so the analysis and the emitter never disagree on
 * which bindings are inline-carried.
 *
 * Conservative corners (sound, give up the optimization): closures and module
 * inits are not walked in detail — any schema reachable as a `.push({S})`
 * argument, an `Array<S>`-returning call, an `[{S}, …]` literal, or a captured
 * tracked array inside one is poisoned.
 */
export function analyzeStructInline(funcFacts, programFacts) {
  const inlineArray = ctx.schema?.inlineArray
  if (!inlineArray || !ctx.schema?.list) return
  const { paramReps } = programFacts
  const cand = new Set()      // sids observed as an `Array<S>` element schema
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
        const sid = ctx.func.map?.get(callee)?.arrayElemSchema
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

  for (const [func, facts] of funcFacts) {
    const body = func?.body
    const reps = facts?.localReps
    if (func?.raw || !reps || body == null || typeof body !== 'object') continue

    // `Array<S>` bindings of this function (codegen truth) and their schemas.
    const arrName = new Map()       // name → sid
    for (const [name, r] of reps) {
      const sid = r?.arrayElemSchema
      if (sid == null) continue
      if ((propsOf(sid).length || 0) < 1) continue   // K=0 — not inlinable
      cand.add(sid)
      arrName.set(name, sid)
    }
    if (!arrName.size) continue

    // A structInline `Array<S>` value is only ever born from an empty `[]`
    // grown by structInline `.push`. `expr` is such a producer of `Array<sid>`
    // iff it is: a tracked `Array<sid>` alias, an empty `[]` literal, or a call
    // to a user function (whose returned array is structInline whenever sid
    // survives this whole-program pass). Every other source — a non-empty
    // `[{S},…]` literal, a builtin call (`JSON.parse`, `Object.values`, `.map`,
    // `.slice`, a member access onto a parsed object) — yields a taggedLinear
    // array and must poison sid.
    const safeArrSource = (expr, sid) => {
      if (typeof expr === 'string') return arrName.get(expr) === sid
      if (!Array.isArray(expr)) return false
      const elems = staticArrayElems(expr)
      if (elems) return elems.length === 0
      return expr[0] === '()' && typeof expr[1] === 'string' && !!ctx.func.map?.has(expr[1])
    }

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
          else if (cursor.has(o)) { if (!(isStrLit(k) && inSchema(cursor.get(o), k[1]))) black.add(cursor.get(o)) }
          if (k != null) visitChild(k)
          return
        }
        const esid = elemArrSid(o)
        if (esid != null) {
          if (!(isStrLit(k) && inSchema(esid, k[1]))) black.add(esid)
          visitChild(o[2])
        } else if (o != null) visitChild(o)
        if (k != null) visitChild(k)
        return
      }

      // Reassignment of the array binding — the rhs must be a structInline
      // `Array<S>` producer; an alias is left un-walked (flagging it would
      // self-poison), other producers are walked to verify their subtree.
      if (op === '=' && typeof node[1] === 'string' && arrName.has(node[1])) {
        const sid = arrName.get(node[1])
        if (!safeArrSource(node[2], sid)) black.add(sid)
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
          const args = argsOf(node)
          const known = ctx.func.map?.has(callee)
          const cParams = paramReps?.get(callee)
          for (let k = 0; k < args.length; k++) {
            const arg = args[k]
            if (typeof arg === 'string' && arrName.has(arg)) {
              const sid = arrName.get(arg)
              if (!(known && cParams?.get(k)?.arrayElemSchema === sid)) black.add(sid)
            } else if (!flag(arg)) verify(arg)
          }
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
            else if (typeof rhs !== 'string') visitChild(rhs)          // [] / user-call — verify subtree
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
  const funcNames = ctx.func.names
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
  for (const fn of ctx.func.list) if (fn.body && !fn.raw) visit(fn.body, false)

  return ns
}

