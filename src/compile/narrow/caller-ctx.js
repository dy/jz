/**
 * Shared per-caller context builders + tiny shared data for narrowSignatures'
 * call-site lattices: the `Map<func, ...>` factories (buildCallerCtx/
 * buildCallerElems/buildCallerTypedLenCtx), their refresh/reset counterparts,
 * and createPhaseState — the lazily-cached bundle the driver threads through
 * every phase. The value kinds themselves are the program summary's.
 *
 * @module compile/narrow/caller-ctx
 */

import { ctx } from '../../ctx.js'
import { collectParamNames, extractParams } from '../../ast.js'
import { withTypedElems } from '../flow-state.js'
import { makeMapOverlay } from '../map-overlay.js'
import { analyzeBody, analyzeValueFacts, reanalyzeBody, clearBodyFacts } from '../analyze.js'
import { ctorFromElemAux } from '../../../layout.js'
import { VAL } from '../../reps.js'

export const PTR_ABI_KINDS = new Set([VAL.OBJECT, VAL.SET, VAL.MAP, VAL.BUFFER])

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

/** The closures of each caller that call sites run in (a site's `arrow`). */
export function siteClosures(callSites) {
  const out = new Map()
  for (const cs of callSites) {
    if (!cs.arrow) continue
    const set = out.get(cs.callerFunc)
    if (set) set.add(cs.arrow); else out.set(cs.callerFunc, new Set([cs.arrow]))
  }
  return out
}

// A call inside a closure passes that closure's values: its declarations, which
// the caller's body facts stop short of (analyzeBody does not cross into an
// arrow), and its parameters, values of any kind. The closures between the
// caller and the site count too, since the site reads their bindings. Prepared
// names are unique per scope, so they join the caller's view without shadowing.
function addClosureLocals(view, body, sites, analyze) {
  const arrows = []
  const walk = n => {
    if (!Array.isArray(n)) return false
    let holds = sites.has(n)
    for (let i = 1; i < n.length; i++) if (walk(n[i])) holds = true
    if (holds && n[0] === '=>') arrows.push(n)
    return holds
  }
  walk(body)
  for (const arrow of arrows) {
    for (const name of collectParamNames(extractParams(arrow[1]))) if (!view.has(name)) view.set(name, 'f64')
    const inner = arrow[2]
    if (inner === null || typeof inner !== 'object') continue
    const facts = analyze(inner)
    for (const [name, type] of facts.locals) if (!view.has(name)) view.set(name, type)
    if (facts.unsignedLocals) for (const name of facts.unsignedLocals) view.set(name, 'f64')
  }
}

function buildCallerCtx(closures) {
  const callerCtx = new Map()
  callerCtx.set(null, { callerLocals: ctx.scope.globalTypes })
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeBody(func.body)
    // Add params through an overlay; the cached body-fact map remains immutable
    // and is not cloned once per function.
    const callerLocals = makeMapOverlay(facts.locals)
    for (const p of func.sig.params) if (!callerLocals.has(p.name)) callerLocals.set(p.name, p.type)
    // This view describes argument values, not the unsigned word carrier.
    if (facts.unsignedLocals) for (const name of facts.unsignedLocals) callerLocals.set(name, 'f64')
    const sites = closures.get(func)
    if (sites) addClosureLocals(callerLocals, func.body, sites, analyzeBody)
    callerCtx.set(func, { callerLocals, readPresent: facts.readPresent })
  }
  return callerCtx
}

function buildCallerElems(sliceKey) {
  const m = new Map()
  m.set(null, new Map())
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    m.set(func, analyzeValueFacts(func.body)[sliceKey])
  }
  return m
}

// Static LENGTHS visible per caller — analyzeBody's typedLens (stable
// single-def `new T(<n>)` bindings; the tracker poisons on redef) shadowing
// module globals: every local/param shadows a same-named global.
export function buildCallerTypedLenCtx() {
  const out = new Map()
  const globalTL = ctx.scope.globalTypedLen || new Map()
  out.set(null, globalTL)
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeValueFacts(func.body)
    const local = facts.typedLens || new Map()
    if (!globalTL.size) { out.set(func, local); continue }
    const merged = makeMapOverlay(globalTL)
    for (const name of facts.locals.keys()) merged.delete(name)
    for (const p of func.sig?.params || []) merged.delete(p.name)
    for (const [k, v] of local) merged.set(k, v)
    out.set(func, merged)
  }
  return out
}

function refreshCallerLocals(callerCtx, closures) {
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
    const te = makeMapOverlay(ctx.scope.globalTypedElem || null)
    for (const p of func.sig.params) {
      if (p.ptrKind != null) ctx.func.localReps.set(p.name, { val: p.ptrKind })
      if (p.ptrKind === VAL.TYPED && p.ptrAux != null) { const c = ctorFromElemAux(p.ptrAux); if (c != null) te.set(p.name, c) }
    }
    ctx.func.typedElem = te
    const facts = reanalyzeBody(func.body), fresh = makeMapOverlay(facts.locals)
    for (const p of func.sig.params) if (!fresh.has(p.name)) fresh.set(p.name, p.type)
    if (facts.unsignedLocals) for (const name of facts.unsignedLocals) fresh.set(name, 'f64')
    const sites = closures.get(func)
    if (sites) addClosureLocals(fresh, func.body, sites, reanalyzeBody)
    const entry = callerCtx.get(func)
    entry.callerLocals = fresh
    entry.readPresent = facts.readPresent
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

export function createPhaseState(callSites) {
  const closures = siteClosures(callSites)
  const callerCtx = buildCallerCtx(closures)
  const elemCtx = new Map()

  return {
    callerCtx,

    callerElems(sliceKey) {
      let m = elemCtx.get(sliceKey)
      if (!m) { m = buildCallerElems(sliceKey); elemCtx.set(sliceKey, m) }
      return m
    },

    clearNarrowingBodyState() {
      clearBodyFacts()
      elemCtx.clear()
    },

    refreshLocals() {
      refreshCallerLocals(callerCtx, closures)
      elemCtx.clear()
    },
  }
}
