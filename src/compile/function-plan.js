import { cloneRep } from '../param-reps.js'
import { DBG_INVARIANTS } from '../ctx.js'

const cloneRepMap = map => map ? new Map([...map].map(([name, rep]) => [name, cloneRep(rep)])) : null

/** Publish-time snapshots (JZ_DEBUG_INVARIANTS only) — see installFunctionPlan's
 *  tripwire below. WeakMap<plan, independent-clone-of-plan>, populated the instant
 *  a plan goes public; never read or written outside this file. */
const publishSnapshots = new WeakMap()

/**
 * Structural equality over the closed set of shapes a FunctionPlan field can
 * take: Map, Set, Array, plain rep object, primitive. Deliberately NOT
 * Object.freeze-based (audit finding P1: freeze only locks the outer record,
 * and under the self-hosted kernel it doesn't even do that — Object.freeze is
 * identity there) and deliberately NOT a Proxy/getter facade (op-policy.js:
 * "jz objects have no accessors"; ctx.js: "no Proxy global at all" — neither
 * survives self-hosted compilation). Plain recursion over Map/Set/Object is
 * the one vocabulary guaranteed to compile identically native and self-hosted.
 */
function planFieldsEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false
    for (const [k, v] of a) { if (!b.has(k) || !planFieldsEqual(v, b.get(k))) return false }
    return true
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false
    for (const v of a) if (!b.has(v)) return false
    return true
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!planFieldsEqual(a[i], b[i])) return false
    return true
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    for (const k of ka) { if (!(k in b) || !planFieldsEqual(a[k], b[k])) return false }
    return true
  }
  return false
}

/**
 * Publish one function's durable analysis result.
 *
 * Mutable facts are detached from the analysis frame before publication. The
 * record itself is frozen; emission receives fresh mutable working copies via
 * installFunctionPlan(), never the authoritative collections.
 */
export function createFunctionPlan(facts) {
  return Object.freeze({
    block: !!facts.block,
    locals: new Map(facts.locals || []),
    boxed: new Map(facts.boxed || []),
    cellTypes: new Set(facts.cellTypes || []),
    flatObjects: new Map(facts.flatObjects || []),
    sliceViews: new Set(facts.sliceViews || []),
    cseLoadBases: new Set(facts.cseLoadBases || []),
    distinctParams: facts.distinctParams ? new Set(facts.distinctParams) : null,
    leanHashLocals: new Set(facts.leanHashLocals || []),
    i32HashLocals: new Set(facts.i32HashLocals || []),
    leanHashDomains: new Map(facts.leanHashDomains || []),
    // Pass-by-reference, not cloned (region-arena jz×jz-ceiling fix, .work/
    // research.md §Region arena "analyzeFuncForEmit's OWN clone-shape
    // instances FIXED"): facts.typedElem/typedLen are either null or a
    // MapOverlay (src/compile/index.js's makeMapOverlay) built fresh once per
    // analyzeFuncForEmit call for this function alone, never shared with or
    // mutated by any other function's facts (see analyzeFuncForEmit's own
    // "Pass the MapOverlay through by reference" comment) — cloning here
    // would be a second, pointless O(programSize) copy on top of the one
    // analyzeFuncForEmit's own entry already eliminated, AND would actively
    // crash: `new Map(overlay)` throws, a MapOverlay is a plain get/set/has
    // facade, not an iterable.
    typedElem: facts.typedElem || null,
    typedLen: facts.typedLen || null,
    localReps: cloneRepMap(facts.localReps),
  })
}

/** Publish exactly once for a function identity. */
export function publishFunctionPlan(ctx, func, facts) {
  if (ctx.plans.functions.has(func))
    throw new Error(`FunctionPlan already published for ${func?.name || '<anonymous>'}`)
  const plan = createFunctionPlan(facts)
  ctx.plans.functions.set(func, plan)
  // LOGICAL deep-freeze (audit P1): snapshot the just-published shape via an
  // independent re-clone (createFunctionPlan already builds fresh Map/Set/rep
  // copies from whatever `facts`-shaped object it's given — the plan itself
  // qualifies) so installFunctionPlan can prove later, at consumption, that
  // nothing mutated the collections in place. Zero-cost when the flag is off:
  // no snapshot, no WeakMap write, no behavior change.
  if (DBG_INVARIANTS) publishSnapshots.set(plan, createFunctionPlan(plan))
  return plan
}

/** Read the authoritative plan; missing publication is an internal error. */
export function functionPlanOf(ctx, func) {
  const plan = ctx.plans.functions.get(func)
  if (!plan) throw new Error(`FunctionPlan missing for ${func?.name || '<anonymous>'}`)
  return plan
}

/** Install detached emission working state from a frozen authoritative plan. */
export function installFunctionPlan(ctx, plan) {
  // Consumption-side half of the LOGICAL deep-freeze tripwire (audit P1): a
  // mismatch here means something mutated the plan's Map/Set/rep-object
  // fields in place since publishFunctionPlan snapshotted them — the
  // Object.freeze on the outer record (createFunctionPlan) never protected
  // those, and doesn't protect anything at all under the self-hosted kernel.
  // Gated the same as every other invariant in this layer: zero cost off.
  if (DBG_INVARIANTS) {
    const snapshot = publishSnapshots.get(plan)
    if (snapshot) for (const k of Object.keys(plan)) {
      if (!planFieldsEqual(plan[k], snapshot[k]))
        throw new Error(`[ctx invariant] FunctionPlan.${k} mutated after publish — the published plan is logically frozen; emission must consume detached working copies (installFunctionPlan), never rewrite the plan itself`)
    }
  }
  ctx.func.locals = new Map(plan.locals)
  ctx.func.boxed = new Map(plan.boxed)
  ctx.func.cellTypes = new Set(plan.cellTypes)
  ctx.func.flatObjects = new Map(plan.flatObjects)
  ctx.func.sliceViews = new Set(plan.sliceViews)
  ctx.func.localReps = cloneRepMap(plan.localReps)
  ctx.func.leanHashLocals = new Set(plan.leanHashLocals)
  ctx.func.i32HashLocals = new Set(plan.i32HashLocals)
  ctx.func.leanHashDomains = new Map(plan.leanHashDomains)
  // By reference, not cloned — see createFunctionPlan's own doc on this same
  // pair. The plan.typedLen-absent/global-fallback case (a function published
  // before ctx.scope.globalTypedLen existed — see below) is the caller's
  // concern, not this generic installer's: it needs `makeMapOverlay`, which
  // lives in index.js alongside the rest of the MapOverlay machinery, and
  // importing it back here would close a load cycle (function-plan.js has no
  // other reason to depend on index.js — same avoid-a-cycle discipline
  // narrow.js's freshId replica documents for abi/string.js).
  ctx.types.typedElem = plan.typedElem || null
  ctx.types.typedLen = plan.typedLen || null
}
