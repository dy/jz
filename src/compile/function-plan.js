import { cloneMapView } from './map-overlay.js'

/** Deep-copy the closed collection vocabulary used by FunctionPlan fields. */
function clonePlanValue(value) {
  if (value == null || typeof value !== 'object') return value
  if (value.mapOverlay === true) return cloneMapView(value)
  if (value instanceof Map)
    return new Map([...value].map(([key, item]) => [key, clonePlanValue(item)]))
  if (value instanceof Set)
    return new Set([...value].map(clonePlanValue))
  if (Array.isArray(value)) return value.map(clonePlanValue)
  const out = {}
  for (const key of Object.keys(value)) out[key] = clonePlanValue(value[key])
  return out
}

const cloneRepMap = map => map
  ? new Map([...map].map(([name, rep]) => [name, clonePlanValue(rep)]))
  : null

function clonePlanData(facts) {
  return {
    block: !!facts.block,
    locals: clonePlanValue(facts.locals || new Map()),
    boxed: clonePlanValue(facts.boxed || new Map()),
    cellTypes: clonePlanValue(facts.cellTypes || new Set()),
    flatObjects: clonePlanValue(facts.flatObjects || new Map()),
    sliceViews: clonePlanValue(facts.sliceViews || new Set()),
    cseLoadBases: clonePlanValue(facts.cseLoadBases || new Set()),
    distinctParams: facts.distinctParams ? clonePlanValue(facts.distinctParams) : null,
    leanHashLocals: clonePlanValue(facts.leanHashLocals || new Set()),
    i32HashLocals: clonePlanValue(facts.i32HashLocals || new Set()),
    leanHashDomains: clonePlanValue(facts.leanHashDomains || new Map()),
    // MapOverlay forks copy only the function-local `own` layer and retain the
    // stable program-wide base, preserving the O(1)-in-program-size contract.
    typedElem: cloneMapView(facts.typedElem),
    typedLen: cloneMapView(facts.typedLen),
    localReps: cloneRepMap(facts.localReps),
  }
}

/**
 * Canonical FunctionPlan data is module-owned. The public value stored in
 * ctx.plans.functions is only an opaque identity key; it contains no Map, Set,
 * array, or rep object a consumer could mutate. Canonical data lives in the
 * session-owned ctx.plans.functionData WeakMap, keeping it reachable across a
 * region relocation without exposing it on the handle. This is logical deep
 * immutability in both native JS and the self-host, where Object.freeze is an
 * identity operation and Proxy/accessor facades are unavailable.
 */
export function createFunctionPlan(ctx, facts) {
  const plan = {}
  ctx.plans.functionData.set(plan, clonePlanData(facts))
  return plan
}

/** Publish exactly once for a function identity. */
export function publishFunctionPlan(ctx, func, facts) {
  if (ctx.plans.functions.has(func))
    throw new Error(`FunctionPlan already published for ${func?.name || '<anonymous>'}`)
  const plan = createFunctionPlan(ctx, facts)
  ctx.plans.functions.set(func, plan)
  return plan
}

/** Read the opaque authoritative plan identity; missing publication is an error. */
export function functionPlanOf(ctx, func) {
  const plan = ctx.plans.functions.get(func)
  if (!plan || !ctx.plans.functionData.has(plan))
    throw new Error(`FunctionPlan missing for ${func?.name || '<anonymous>'}`)
  return plan
}

/**
 * Visit rep names without exposing the canonical rep map or any rep object.
 * Callers obtain individual fields through functionPlanRepField().
 */
export function forEachFunctionPlanRep(ctx, plan, visit) {
  const reps = ctx.plans.functionData.get(plan)?.localReps
  if (!reps) return
  for (const [name] of reps) visit(name)
}

/** Pure projection: composite fields are detached before they leave the module. */
export function functionPlanRepField(ctx, plan, name, field) {
  const rep = ctx.plans.functionData.get(plan)?.localReps?.get(name)
  return clonePlanValue(rep?.[field])
}

/**
 * Install a fresh mutable working copy on the active function and return that
 * detached copy for emission-only metadata reads. Repeated installs never
 * share mutable collections with each other or with canonical plan storage.
 */
export function installFunctionPlan(ctx, plan) {
  const data = ctx.plans.functionData.get(plan)
  if (!data) throw new Error('Invalid FunctionPlan handle')
  const working = clonePlanData(data)
  ctx.func.locals = working.locals
  ctx.func.boxed = working.boxed
  ctx.func.cellTypes = working.cellTypes
  ctx.func.flatObjects = working.flatObjects
  ctx.func.sliceViews = working.sliceViews
  ctx.func.localReps = working.localReps
  ctx.func.leanHashLocals = working.leanHashLocals
  ctx.func.i32HashLocals = working.i32HashLocals
  ctx.func.leanHashDomains = working.leanHashDomains
  ctx.func.typedElem = working.typedElem
  ctx.func.typedLen = working.typedLen
  return working
}
