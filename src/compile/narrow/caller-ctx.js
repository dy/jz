/**
 * Shared per-caller context builders + tiny shared data for narrowSignatures'
 * fixpoint phases: the `Map<func, ...>` factories (buildCallerCtx/buildCallerElems/
 * buildCallerTypedCtx/buildCallerTypedLenCtx), their refresh/reset counterparts, and
 * createPhaseState — the lazily-cached bundle the driver threads through every phase.
 *
 * @module compile/narrow/caller-ctx
 */

import { ctx } from '../../ctx.js'
import { withTypedElems } from '../flow-state.js'
import { analyzeBody, reanalyzeBody, invalidateAllBodyFacts } from '../analyze.js'
import { ctorFromElemAux } from '../../../layout.js'
import { VAL } from '../../reps.js'

export const PTR_ABI_KINDS = new Set([VAL.OBJECT, VAL.SET, VAL.MAP, VAL.BUFFER])

// Integer-preserving ops: an expr over integers stays integer (ToInt32-consistent) through these.
// Excludes /, %, ** (fractional). Used to recognize a recursive arg whose i32-ness follows from
// its inputs' i32-ness (`f(n - 1)`), so it carries no independent type evidence.
export const RECUR_INT_OPS = new Set(['+', '-', '*', 'u-', 'u+', '&', '|', '^', '<<', '>>', '>>>', '~'])

// DBG-only (product-lattice Slice 4a, .work/archive/lattice-design.md §1.6): `val`
// (the meet, sticky-null-poisonable) and `possibleKinds` (the existential
// union) must never contradict — whenever a param's `val` has resolved to a
// concrete kind, `possibleKinds` must contain it (a wider set is fine; the
// two channels answer different questions but must agree on any fact both
// claim to know). A miss here is a jz bug — some val-writing site forgot to
// feed possibleKinds alongside it — never a value to silently trust one
// channel over the other. Called after every phase that can still write
// `.val` onto a paramReps entry (narrowSignatures' hard settle,
// specializeBimorphicTyped's and speculateTypedParams' clone overrides).
export function assertValKindConsistent(paramReps) {
  for (const [fname, reps] of paramReps)
    for (const [k, r] of reps)
      if (r.val != null && !r.possibleKinds?.has(r.val))
        throw new Error(`possibleKinds/val consistency: ${fname} param ${k} val=${r.val} missing from possibleKinds=${r.possibleKinds ? [...r.possibleKinds].join(',') : 'undefined'}`)
}

export function filterLiveCallSites(callSites, valueUsed) {
  if (!callSites.length) return

  const live = new Set()
  for (const f of ctx.funcs.list) {
    if (f.exported || valueUsed.has(f.name)) live.add(f.name)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const cs of callSites) {
      if (cs.callerFunc === null || live.has(cs.callerFunc.name)) {
        if (!live.has(cs.callee)) { live.add(cs.callee); changed = true }
      }
    }
  }

  let w = 0
  for (let r = 0; r < callSites.length; r++) {
    const cs = callSites[r]
    if (cs.callerFunc === null || live.has(cs.callerFunc.name)) callSites[w++] = cs
  }
  callSites.length = w
}

export function buildCallerCtx() {
  const callerCtx = new Map()
  const globalTE = ctx.scope.globalTypedElem || new Map()
  callerCtx.set(null, { callerLocals: ctx.scope.globalTypes, callerValTypes: ctx.scope.globalValTypes, callerTypedElems: globalTE })
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeBody(func.body)
    // COPY before adding params: analyzeBody's returned maps are shared cache
    // entries (immutable by contract) — writing params into facts.locals leaked
    // caller-view state into every later reader of the same cached facts.
    const callerLocals = new Map(facts.locals)
    for (const p of func.sig.params) if (!callerLocals.has(p.name)) callerLocals.set(p.name, p.type)
    // Shadow-aware local+global typed-array map: a `const buf = new Int32Array(…)`
    // local makes `buf[i]` arg reads type i32 at this caller's sites, so a callee
    // param fed only such elements narrows (else it stays f64 and `1 << p` drags in
    // __to_num → the whole string↔number stdlib). Mirrors callerTypedElemsFor.
    callerCtx.set(func, { callerLocals, callerValTypes: facts.valTypes, callerTypedElems: callerTypedElemsFor(func, globalTE) })
  }
  return callerCtx
}

function buildCallerElems(sliceKey) {
  const m = new Map()
  m.set(null, new Map())
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    m.set(func, analyzeBody(func.body)[sliceKey])
  }
  return m
}

function refreshCallerValTypes(callerCtx) {
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const entry = callerCtx.get(func)
    if (entry) entry.callerValTypes = analyzeBody(func.body).valTypes
  }
}

// Per-caller typed-elem context: the caller's body-local typed arrays, layered
// over the module's typed-array globals so a call like `f(globalArr)` resolves
// `globalArr`'s ctor (inferTypedCtor reads only this map for a bare-name arg).
// A global is visible UNLESS the caller shadows the name with a param or local
// of its own — only then could the name denote a non-typed value. Globals are
// sound to consult: globalTypedElem holds a name only when EVERY assignment to
// it is the same single typed-array ctor (scope.js invalidates on any conflict),
// so it can't denote a different kind at the call site.
function callerTypedElemsFor(func, globalTE) {
  const facts = analyzeBody(func.body)
  const local = facts.typedElems
  if (!globalTE.size) return local
  const shadowed = new Set(facts.locals.keys())
  for (const p of func.sig?.params || []) shadowed.add(p.name)
  const merged = new Map()
  for (const [k, v] of globalTE) if (!shadowed.has(k)) merged.set(k, v)
  for (const [k, v] of local) merged.set(k, v)  // local typed binding shadows the global
  return merged
}

export function buildCallerTypedCtx() {
  const callerTypedCtx = new Map()
  const globalTE = ctx.scope.globalTypedElem || new Map()
  callerTypedCtx.set(null, globalTE)
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    callerTypedCtx.set(func, callerTypedElemsFor(func, globalTE))
  }
  return callerTypedCtx
}

// Static LENGTHS visible per caller — analyzeBody's typedLens (stable
// single-def `new T(<n>)` bindings; the tracker poisons on redef) shadowing
// module globals, same shadowing rule as callerTypedElemsFor.
export function buildCallerTypedLenCtx() {
  const out = new Map()
  const globalTL = ctx.scope.globalTypedLen || new Map()
  out.set(null, globalTL)
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeBody(func.body)
    const local = facts.typedLens || new Map()
    if (!globalTL.size) { out.set(func, local); continue }
    const shadowed = new Set(facts.locals.keys())
    for (const p of func.sig?.params || []) shadowed.add(p.name)
    const merged = new Map()
    for (const [k, v] of globalTL) if (!shadowed.has(k)) merged.set(k, v)
    for (const [k, v] of local) merged.set(k, v)
    out.set(func, merged)
  }
  return out
}

export function enrichCallerValTypesFromPointerParams(callerCtx) {
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const entry = callerCtx.get(func)
    if (!entry) continue
    for (const p of func.sig.params) {
      if (p.ptrKind == null) continue
      if (entry.callerValTypes.has(p.name)) continue
      entry.callerValTypes.set(p.name, p.ptrKind)
    }
  }
}

function refreshCallerLocals(callerCtx) {
  withTypedElems(ctx.func.typedElem, () => {
  ctx.func.localReps = null
  try {
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    // Seed pointer-narrowed params' val-kind so analyzeBody recognises e.g.
    // `n = arr.length` (arr a TYPED/BUFFER pointer param) as an i32 local — without
    // this, post-G `refreshCallerLocals` still walks bodies with arr untyped, the
    // length stays f64, and any callee taking that length never gets an i32 param
    // (heapsort→siftDown's `end`). analyzeFuncForEmit re-seeds + re-invalidates at
    // emit time, so this transient localReps doesn't leak past narrowing.
    ctx.func.localReps = new Map()
    // Seed the typedElem overlay with this func's TYPED-pointer params (element ctor from
    // ptrAux), exactly as analyzeFuncForEmit does at emit time. Without it, a local bound to
    // an integer typed-array PARAM element — `aa = perm[perm[X]+Y]` (noise), perm an Int32
    // pointer param — types f64 here, so a callee fed it (`grad(aa,…)`, used only as `aa&3`)
    // never narrows its param to i32. Mirrors emit so narrow-time callerLocals agree with it.
    const te = ctx.scope.globalTypedElem ? new Map(ctx.scope.globalTypedElem) : new Map()
    for (const p of func.sig.params) {
      if (p.ptrKind != null) ctx.func.localReps.set(p.name, { val: p.ptrKind })
      if (p.ptrKind === VAL.TYPED && p.ptrAux != null) { const c = ctorFromElemAux(p.ptrAux); if (c != null) te.set(p.name, c) }
    }
    ctx.func.typedElem = te
    const fresh = reanalyzeBody(func.body).locals
    for (const p of func.sig.params) if (!fresh.has(p.name)) fresh.set(p.name, p.type)
    callerCtx.get(func).callerLocals = fresh
  }
  } finally {
    // This pass owns a transient scratch map rather than shadowing an outer
    // value: completion clears it instead of restoring a stale predecessor.
    ctx.func.localReps = null
  }
  })
}

export function resetParamWasmFacts(paramReps) {
  for (const m of paramReps.values()) for (const r of m.values()) r.wasm = undefined
}

export function createPhaseState() {
  const callerCtx = buildCallerCtx()
  const elemCtx = new Map()
  let callerTypedCtx = null

  const clearDerived = () => {
    elemCtx.clear()
    callerTypedCtx = null
  }

  return {
    callerCtx,

    callerElems(sliceKey) {
      let m = elemCtx.get(sliceKey)
      if (!m) { m = buildCallerElems(sliceKey); elemCtx.set(sliceKey, m) }
      return m
    },

    callerTyped() {
      callerTypedCtx ||= buildCallerTypedCtx()
      return callerTypedCtx
    },

    // Renamed from invalidateBodyFacts (FINDING-5, .work/archive/lattice-design.md §4): the
    // product-lattice design reserves that name for a future module-level
    // `invalidateBodyFacts(body, reason)` entry point (research.md:704-708) —
    // this phase-local, bulk, no-args method is a different shape and had to
    // move out of the way first.
    clearNarrowingBodyState() {
      invalidateAllBodyFacts()
      clearDerived()
    },

    refreshValTypes() {
      refreshCallerValTypes(callerCtx)
      clearDerived()
    },

    refreshLocals() {
      refreshCallerLocals(callerCtx)
      clearDerived()
    },
  }
}
