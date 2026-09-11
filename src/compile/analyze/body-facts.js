/**
 * Per-function body fact collection — analyzeBody, its cache seam, and the
 * post-walk wasm-type widening it drives. Split out of analyze.js along the
 * "body facts" seam (pipeline-minimality slice); see analyze.js's module
 * header for the full split rationale and `.work/archive/analyze-traversals.md` for
 * the traversal inventory.
 *
 * @module compile/analyze/body-facts
 */
import { ctx, getFactStore } from '../../ctx.js'
import { commaList, isReassigned, collectParamNames, walkAst, some, takeScratchSet, releaseScratchSet } from '../../ast.js'
import { withValueOverlay, withTypedElemOverlay } from '../flow-state.js'
import { VAL, updateRep } from '../../reps.js'
import { intLiteralValue, intExprRange, staticPropertyKey, staticArrayElems, exprSchemaId } from '../../static.js'
import { exprType, intLevelMap } from '../../type.js'
import { K, tagOf, paramOf, hasTag, valOf, core, UNKNOWN } from '../../summary/index.js'
import { ctorFromElemAux } from '../../../layout.js'
import {
  findMutations, collectI32SafeIndexVars, collectF64StridedIndexVars, collectBareEscapes, narrowUint32,
  scanObjectArrayFacts, isFreshArrayCtor, stampCoInductionRanges,
} from '../analyze-scans.js'
import { makeTypedTracker } from './trackers.js'

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

/**
 * Unified per-body analysis — see module header for slice overview.
 * Returns cached facts; DO NOT MUTATE the returned maps.
 *
 * Validity depends on the body, its signature, the program summary, global
 * type/length facts, function overlays and schema numeric facts. Signature
 * changes are checked on cache hits. Other changes invalidate at their owning
 * mutation/phase seam before a dependent read; the fingerprint is not a proof
 * that ambient facts are unchanged. See CONTRIBUTING.md's freshness table.
 * Use reanalyzeBody for a changed overlay, setFuncBody for AST replacement,
 * invalidateBodies for changed callees' dependents, and invalidateAllBodyFacts
 * when program/schema facts settle or the phase changes. Returned maps are
 * owned by this cache and must not be modified by consumers.
 */
const EMPTY_BODY_FACT_MAP = new Map()
const EMPTY_BODY_FACT_SET = new Set()
const EMPTY_OBJECT_ARRAY_FACTS = [EMPTY_BODY_FACT_MAP, EMPTY_BODY_FACT_SET, EMPTY_BODY_FACT_SET, EMPTY_BODY_FACT_SET]

export function analyzeBody(body) {
  // Non-object bodies (`() => 0`, `() => x`, missing) have nothing to observe
  // for any slice and can't be WeakMap-keyed. Return empty maps without caching.
  if (body === null || typeof body !== 'object') return {
    locals: new Map(), valTypes: new Map(), arrElemSchemas: new Map(), arrElemSchemaSets: new Map(),
    arrElemValTypes: new Map(), arrayHoles: new Set(), arrElemTypedCtors: new Map(), typedElems: new Map(), typedLens: new Map(),
    escapes: new Map(), flatObjects: new Map(),
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
  // The names declared in the body and the arrays whose initial contents it
  // described: two tables keyed by the body's names, dropped at exit.
  const elemOrigin = takeScratchSet()
  try { return computeBodyFacts(body, bodyFacts, elemOrigin) }
  finally { releaseScratchSet(elemOrigin) }
}

function computeBodyFacts(body, bodyFacts, elemOrigin) {
  const locals = new Map()
  const valTypes = new Map()
  const arrElemSchemas = new Map()
  let arrElemSchemaSets = null  // name → Set<sid> | null — closed heterogeneous union
  // The element kind (arrElemValTypes), holes (arrayHoles: an unwritten slot
  // of `Array(n)` reads undefined) and typed element constructor
  // (arrElemTypedCtors: `Array.from(nCh, () => new Float32Array(n))`, so
  // `arr[i][j]` inlines) of each array declared here are the program
  // summary's cell (src/summary): one cell per array, joining every store
  // through every alias, callback and callee. Read at the declaration, never
  // observed: a mutation this body cannot see (`unshift` in a helper, a
  // callback's index store) is in the cell already.
  const arrElemValTypes = new Map()
  let arrayHoles = null
  let arrElemTypedCtors = null
  const typedElems = new Map()
  let typedLens = null
  let escapes = null // name → bool: local holds allocation, true if it escapes

  const doSchemas = !!ctx.schema?.register
  // Per-walk local schema map for chained `arr.push(name)` resolution.
  let localSchemaMap = null
  const summary = ctx.summary?.at(body)

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
    if (arrElemSchemaSets?.get(arr) !== null) {
      arrElemSchemaSets ||= new Map()
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

  /** The summary's element facts of the array `name` declares: the kind when
   *  no producer is nullish (a null element has no numeric path), holes as
   *  presence, a typed element's constructor. Elements the cell knows are not
   *  objects poison the schema census below, whose push observation would
   *  otherwise stand after an `unshift('y')` it cannot see. */
  const readElemFacts = (name) => {
    if (!summary || tagOf(summary.kindOf(name)) !== K.ARRAY) return
    const e = summary.elemKindOf(name)
    if (e == null) return
    if (!hasTag(e, K.NULLISH)) {
      const ev = valOf(core(e))
      if (ev != null) {
        arrElemValTypes.set(name, ev)
        if (hasTag(e, K.ABSENT)) (arrayHoles ||= new Set()).add(name)
        if (ev === VAL.TYPED && paramOf(e) !== UNKNOWN) (arrElemTypedCtors ||= new Map()).set(name, ctorFromElemAux(paramOf(e)))
      }
    }
    if (tagOf(core(e)) !== K.OBJECT) { arrElemSchemas.set(name, null); (arrElemSchemaSets ||= new Map()).set(name, null) }
  }

  const trackVal = name => {
    const k = summary?.kindOf(name) ?? K.NONE
    const vt = valOf(k) ?? (!hasTag(k, K.NULLISH) && tagOf(core(k)) !== K.BIGINT ? valOf(core(k)) : null)
    if (vt) valTypes.set(name, vt)
    else valTypes.delete(name)
  }
  const trackTyped = makeTypedTracker(n => typedElems.get(n), (n, c) => typedElems.set(n, c), n => typedElems.delete(n),
    n => typedLens?.get(n),
    (n, l) => { (typedLens ||= new Map()).set(n, l) },
    n => typedLens?.delete(n))

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
    // An integer TypedArray read is i32 only as a value-domain fact. A literal
    // index with no static in-bounds proof can legally yield `undefined`; storing
    // it in i32 would turn that into 0 before identity/JSON observes it. Variable
    // indices retain the existing loop/range proof pipeline.
    const typedRead = Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 && typeof rhs[1] === 'string'
    const readCtor = typedRead
      ? (typedElems.get(rhs[1]) ?? ctx.func.typedElem?.get(rhs[1]) ?? ctx.scope.globalTypedElem?.get(rhs[1]))
      : null
    const readLen = typedRead
      ? (typedLens?.get(rhs[1]) ?? ctx.func.typedLen?.get(rhs[1]) ?? ctx.scope.globalTypedLen?.get(rhs[1]))
      : null
    const readIdx = typedRead ? intLiteralValue(rhs[2]) : null
    const typedReadMayMiss = readCtor != null && readIdx != null &&
      (readLen == null || readIdx < 0 || readIdx >= readLen)
    const wt = typedReadMayMiss ? 'f64' : (shr && !shrFitsI32) ? 'f64' : exprType(rhs, locals)
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
    trackVal(name)

    // typed-array element ctor (typedElems slice)
    trackTyped(name, rhs)

    // arr-elem schema (arrElemSchemas slice) — schema bindings + array-literal init + alias + call return
    if (doSchemas) {
      const sid = exprSchemaId(rhs, localSchemaMap || EMPTY_BODY_FACT_MAP)
      if (sid != null) (localSchemaMap ||= new Map()).set(name, sid)
      {
        const rawElems = staticArrayElems(rhs)
        if (rawElems) {
          const elems = rawElems.filter(e => e != null)
          if (elems.length && elems.length === rawElems.length) {
            let common = exprSchemaId(elems[0], localSchemaMap || EMPTY_BODY_FACT_MAP)
            for (let k = 1; k < elems.length && common != null; k++) {
              if (exprSchemaId(elems[k], localSchemaMap || EMPTY_BODY_FACT_MAP) !== common) common = null
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
        else { const s2 = arrElemSchemaSets?.get(rhs); if (s2) for (const sid of s2) observeArrSchema(name, sid) }
      }
      if (typeof rhs === 'string') {
        const repSid = ctx.func.localReps?.get(rhs)?.arrayElemSchema
        if (repSid != null) observeArrSchema(name, repSid)
        else { const rs = ctx.func.localReps?.get(rhs)?.arrayElemSchemaSet; if (rs) for (const sid of rs) observeArrSchema(name, sid) }
      }
      // The program summary: an array whose every element, from every
      // construction and store in the program, is one shape (a factory's
      // result built by pushes, an element read from another such array).
      const sumSid = summary?.arrayElemSidOf(name)
      if (sumSid != null) observeArrSchema(name, sumSid)
    }
    // A decl whose initial contents this body fully described (the schema census's push gate).
    {
      const rawElems = staticArrayElems(rhs)
      if ((rawElems && rawElems.every(e => e != null)) || isFreshArrayCtor(rhs)) elemOrigin.add(name)
    }
    readElemFacts(name)
  }

  // arrElem invalidation rule — fires on `=` reassign of tracked name to non-array
  const isArrayProducingRhs = (rhs) =>
    Array.isArray(rhs) && (staticArrayElems(rhs) != null ||
      (rhs[0] === '()' && Array.isArray(rhs[1]) && rhs[1][0] === '.' &&
       (rhs[1][2] === 'slice' || rhs[1][2] === 'concat')))

  const markEscape = (name) => { if (escapes?.has(name)) escapes.set(name, true) }

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
    if ((op === '.' || op === '?.') && typeof expr[1] === 'string' && escapes?.has(expr[1])) return
    if (op === '[]' && typeof expr[1] === 'string' && escapes?.has(expr[1])) {
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
          (escapes ||= new Map()).set(name, false)
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

    // arr.push(...) — observe the element schemas. Mutation evidence describes
    // only the ADDED elements — the slice may settle only when the array's
    // prior contents are known (elemOrigin decl, or an entry this body already
    // recorded from a construction source); see elemOrigin.
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && node[1][2] === 'push' && typeof node[1][1] === 'string') {
      const arr = node[1][1]
      if (elemOrigin.has(arr) || arrElemSchemas.has(arr) || arrElemSchemaSets?.has(arr)) {
        for (const a of commaList(node[2])) observeArrSchema(arr, Array.isArray(a) && a[0] === '...' ? null : exprSchemaId(a, localSchemaMap || EMPTY_BODY_FACT_MAP))
      }
    }

    // `=` reassignment — locals widen, valTypes/typedElems track,
    // arrElemSchemas invalidate when rhs isn't array-producing.
    if (op === '=' && typeof node[1] === 'string') {
      const name = node[1], rhs = node[2]
      walk(rhs)
      markEscape(name)
      markEscapeValue(rhs)
      const wt = exprType(rhs, locals)
      if (locals.has(name) && locals.get(name) === 'i32' && wt === 'f64') locals.set(name, 'f64')
      trackVal(name)
      trackTyped(name, rhs)
      if (arrElemSchemas.has(name) && !isArrayProducingRhs(rhs)) observeArrSchema(name, null)
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

    if (op === '[]' && typeof node[1] === 'string' && escapes?.has(node[1])) {
      const key = node[2]
      if (!isStaticIndex(key)) markEscape(node[1])
    }

    for (let i = 1; i < node.length; i++) walk(node[i])
  }

  // Install the in-progress valTypes as a lookup overlay so successive decls
  // resolve chains (`const a = new TypedArr(); const b = a[0]` → b: NUMBER)
  // and shorthand-bound `{a}` props see a's type. Restored after walk completes.
  let unsignedLocals
  withValueOverlay(valTypes, () =>
    withTypedElemOverlay(typedElems, () => {
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
    // A narrowing above retypes a never-reassigned decl whose initializer
    // reads the narrowed name (`const np = 20 + t % 101` over `const t = s
    // >>> 0`): the first pass typed it f64 through t's provisional f64. Re-
    // derive such decls under the final local types, to a fixpoint (a
    // retyped decl may feed the next). Initializers processDecl types by
    // their own shape (`>>>`, a typed read) are left as they are.
    if (unsignedLocals.size) {
      // the range evaluator reads the uint32 fact off the rep (`t % 101` over
      // `const t = s >>> 0` is [0, 100]): stamp it now, ahead of analyze-for-emit's own copy
      for (const nm of unsignedLocals) updateRep(nm, { unsigned: true })
      let narrowed = new Set(unsignedLocals)
      while (narrowed.size) {
        const next = new Set()
        walkAst(body, { enter: n => {
          if (n[0] === '=>') return false
          if (n[0] !== 'const' && n[0] !== 'let') return
          for (let i = 1; i < n.length; i++) {
            const d = n[i]
            if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string' || !Array.isArray(d[2])) continue
            const [name, rhs] = [d[1], d[2]]
            if (locals.get(name) !== 'f64' || rhs[0] === '>>>' || rhs[0] === '[]' || unsignedLocals.has(name)) continue
            if (!some(rhs, x => x.some(c => typeof c === 'string' && narrowed.has(c)))) continue
            if (n[0] === 'let' && isReassigned(body, name)) continue
            // a proven SIGNED hull only: a bare uint32 name flowing through (`c ? h : h2`)
            // keeps its magnitude in f64 storage
            const r = intExprRange(rhs)
            if (r && r[0] >= -0x80000000 && r[1] <= 0x7fffffff && exprType(rhs, locals) === 'i32') { locals.set(name, 'i32'); next.add(name) }
          }
        } })
        narrowed = next
      }
    }
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
  // .work/archive/walk-count-design.md §1.3/§5 item 1) — so one fused scan computes
  // all three instead of three separate full-body scans.
  const [flatObjects, sliceViews, neverGrown, ownCurrent] = doSchemas
    ? scanObjectArrayFacts(body)
    : EMPTY_OBJECT_ARRAY_FACTS
  for (const [name, props] of flatObjects) {
    for (let i = 0; i < props.names.length; i++) locals.set(`${name}#${i}`, 'f64')
    locals.delete(name)
  }

  const result = {
    locals, valTypes, arrElemSchemas,
    arrElemSchemaSets: arrElemSchemaSets || EMPTY_BODY_FACT_MAP,
    arrElemValTypes,
    arrayHoles: arrayHoles || EMPTY_BODY_FACT_SET,
    arrElemTypedCtors: arrElemTypedCtors || EMPTY_BODY_FACT_MAP,
    typedElems,
    typedLens: typedLens || EMPTY_BODY_FACT_MAP,
    escapes: escapes || EMPTY_BODY_FACT_MAP,
    flatObjects, sliceViews, unsignedLocals, neverGrown, ownCurrent,
  }
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
 *  .work/archive/walk-count-design.md §2.4/§5 item 3 — promoted from a
 *  JZ_DEBUG_INVARIANTS-only assert-and-crash to an always-on check whose
 *  mismatch now self-heals via recompute instead of throwing).
 *
 *  Deliberately NARROW, not a full recompute-and-compare: JZ_DEBUG_CACHE
 *  tried that and was abandoned (.work/archive/todo.md) because it fired on ambient
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
const WIDEN_CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!='])
function widenLocalTypes(body, locals) {
  // Shared, lazily-memoized across collectI32SafeIndexVars' own internal use
  // and Pass D below — both want the identical collectBareEscapes(body,
  // locals) fact (same body, same locals, no crossClosure), and it's a real
  // full-body walk (plus its own collectComparedNames sub-walk); computing
  // it once here instead of once per consumer avoids a duplicate traversal
  // whenever both fire (collectI32SafeIndexVars' own dynamic-index early
  // exit, or Pass D's level1I32 gate, mean it's often needed by only one or
  // neither — this only computes it when at least one consumer actually
  // asks, still zero-cost when neither does).
  let bareEscapesCache
  const bareEscapesOf = () => bareEscapesCache ??= collectBareEscapes(body, locals)
  const i32SafeIdx = collectI32SafeIndexVars(body, locals, bareEscapesOf)
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
  findMutations(body, locals, nestedNames)
  // Raw levels (not the collapsed intCertainMap boolean): level 2 (STRICT
  // i32-range-safe by construction — literals, bitwise ops, comparisons,
  // Math.imul/clz32) needs no further check below, but level 1 (integral,
  // UNBOUNDED magnitude — `id *= 100000`, `id += d`) rests on the SAME
  // magnitude-blind "every read re-applies ToInt32" premise
  // collectI32SafeIndexVars' back-propagation does, and Pass D below closes
  // the identical gap for it (see .work/archive/todo.md KNOWN GAP #1 sibling note).
  const intLevels = intLevelMap(body, nestedNames)
  const f64IdxVars = collectF64StridedIndexVars(body, locals)  // counters that trunc anyway — don't keep i32
  const keepI32 = (name) => i32SafeIdx.has(name) || ((intLevels.get(name) ?? 0) >= 1 && !f64IdxVars.has(name))
  const widenPass = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (WIDEN_CMP_OPS.has(op)) {
      const a = node[1], b = node[2]
      const ta = exprType(a, locals), tb = exprType(b, locals)
      if (ta === 'i32' && tb === 'f64' && typeof a === 'string' && locals.has(a) && !keepI32(a)) locals.set(a, 'f64')
      if (tb === 'i32' && ta === 'f64' && typeof b === 'string' && locals.has(b) && !keepI32(b)) locals.set(b, 'f64')
    }
    if (op === '=>') { if (nestedNames.size) widenPass(node[2]) }
    else for (let i = 1; i < node.length; i++) widenPass(node[i])
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
    const bareEscapes = bareEscapesOf()
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
 * An overlay change must use reanalyzeBody before its next dependent read.
 * Program-wide fact changes use invalidateAllBodyFacts, including anonymous
 * bodies that do not have an entry in ctx.funcs.list.
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

/** Invalidate the complete bodyFacts store, including anonymous roots — the
 *  phase-boundary flush used when a signature-level fact just settled that
 *  arbitrarily many caller bodies may have read stale (narrowing's own
 *  callerLocals/valTypes lattices, or the final flush before emit begins).
 *  See the seam doc above. */
export function invalidateAllBodyFacts() {
  resetBodyFactsCache()
}
