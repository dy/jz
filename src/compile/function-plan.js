import { cloneMapView, isMapOverlay, makeMapOverlay, mapOrOverlaySize } from './map-overlay.js'

/** Deep-copy the closed collection vocabulary used by FunctionPlan fields.
 *
 *  Allocation shape matters here more than anywhere else in plan-land: this
 *  is the leaf of every FunctionPlan clone, so it runs once per localReps
 *  entry per publish — the compiler's hottest record-copy path when compiling
 *  itself. The object branch spread-clones (`{...value}` → one right-sized
 *  allocation preserving the source's shape) and then overwrites only
 *  object-valued fields in place — writes to EXISTING keys never grow the
 *  backing table. The pre-2026-08-18 form (`out={}` + per-key computed
 *  writes, and `new Map([...value].map(...))` with its 2N intermediate
 *  arrays) built every cloned ValueRep by incremental dictionary growth —
 *  measured as the m86 goal-gate wall (.work/research.md §Creator NAMED). */
function clonePlanValue(value) {
  if (value == null || typeof value !== 'object') return value
  if (value.mapOverlay === true) return cloneMapView(value)
  if (value instanceof Map) {
    const out = new Map()
    for (const [key, item] of value) out.set(key, clonePlanValue(item))
    return out
  }
  if (value instanceof Set) {
    const out = new Set()
    for (const item of value) out.add(clonePlanValue(item))
    return out
  }
  if (Array.isArray(value)) return value.map(clonePlanValue)
  const out = { ...value }
  for (const key in out) {
    const item = out[key]
    if (item != null && typeof item === 'object') out[key] = clonePlanValue(item)
  }
  return out
}

// Canonical plans live across the whole analyze→emit gap. Store their string-
// keyed maps and sets as flat tuples rather than full HASH-backed collections;
// installFunctionPlan materializes the mutable working collections exactly once.
// This is an ownership representation, not a semantic one: values are detached
// at publication and again at installation just as before.
function packMap(value) {
  if (!value?.size) return null
  const out = []
  for (const [key, item] of value) out.push(key, clonePlanValue(item))
  return out
}

function packSet(value) {
  if (!value?.size) return null
  const out = []
  for (const item of value) out.push(clonePlanValue(item))
  return out
}

function unpackMap(packed) {
  const out = new Map()
  if (packed) for (let i = 0; i < packed.length; i += 2)
    out.set(packed[i], clonePlanValue(packed[i + 1]))
  return out
}

function unpackSet(packed) {
  const out = new Set()
  if (packed) for (const item of packed) out.add(clonePlanValue(item))
  return out
}

function packMapView(view) {
  if (!view || !mapOrOverlaySize(view)) return null
  return isMapOverlay(view)
    ? [view.base, packMap(view.own), true]
    : [null, packMap(view), false]
}

function unpackMapView(packed) {
  if (!packed) return null
  const own = unpackMap(packed[1])
  return packed[2] ? makeMapOverlay(packed[0], own) : own
}

function packPlanData(facts) {
  return {
    block: !!facts.block,
    locals: packMap(facts.locals),
    boxed: packMap(facts.boxed),
    // Captured-anywhere names (src/compile/index.js's analyzeFuncForEmit
    // facts, src/compile/analyze-scans.js boxedCaptures) — emitDecl's
    // closure-capture identity shadow needs this restored at emission.
    capturedNames: packSet(facts.capturedNames),
    cellTypes: packSet(facts.cellTypes),
    flatObjects: packMap(facts.flatObjects),
    sliceViews: packSet(facts.sliceViews),
    cseLoadBases: packSet(facts.cseLoadBases),
    distinctParams: packSet(facts.distinctParams),
    leanHashLocals: packSet(facts.leanHashLocals),
    i32HashLocals: packSet(facts.i32HashLocals),
    leanHashDomains: packMap(facts.leanHashDomains),
    // MapOverlay forks copy only the function-local `own` layer and retain the
    // stable program-wide base, preserving the O(1)-in-program-size contract.
    typedElem: packMapView(facts.typedElem),
    typedLen: packMapView(facts.typedLen),
    localReps: packMap(facts.localReps),
  }
}

function materializePlanData(data) {
  return {
    block: data.block,
    locals: unpackMap(data.locals),
    boxed: unpackMap(data.boxed),
    capturedNames: unpackSet(data.capturedNames),
    cellTypes: unpackSet(data.cellTypes),
    flatObjects: unpackMap(data.flatObjects),
    sliceViews: unpackSet(data.sliceViews),
    cseLoadBases: unpackSet(data.cseLoadBases),
    distinctParams: data.distinctParams ? unpackSet(data.distinctParams) : null,
    leanHashLocals: unpackSet(data.leanHashLocals),
    i32HashLocals: unpackSet(data.i32HashLocals),
    leanHashDomains: unpackMap(data.leanHashDomains),
    typedElem: unpackMapView(data.typedElem),
    typedLen: unpackMapView(data.typedLen),
    localReps: unpackMap(data.localReps),
  }
}

/**
 * Canonical FunctionPlan data is module-owned. The public value stored in
 * ctx.plans.functions is only an opaque identity key; it contains no Map, Set,
 * array, or rep object a consumer could mutate. Persistent user-function data
 * lives in session-owned functionData; one-shot closure/__start plans are
 * sealed ActiveFunction frames in functionWorking until linear transfer. Both
 * remain reachable through ctx.plans across region relocation without exposing
 * facts on the handle. This is logical deep immutability in native JS and the
 * self-compile, where Object.freeze is identity and Proxy/accessors are unavailable.
 */
export function createFunctionPlan(ctx, facts) {
  const plan = {}
  ctx.plans.functionData.set(plan, packPlanData(facts))
  return plan
}

/** Publish one persistent user-function plan exactly once. */
export function publishFunctionPlan(ctx, func, facts) {
  if (ctx.plans.functions.has(func))
    throw new Error(`FunctionPlan already published for ${func?.name || '<anonymous>'}`)
  const plan = createFunctionPlan(ctx, facts)
  ctx.plans.functions.set(func, plan)
  return plan
}

/** Publish one sealed, linearly-consumed closure/__start frame exactly once. */
export function publishPreparedFunctionPlan(ctx, func, workingFrame) {
  if (ctx.plans.functions.has(func))
    throw new Error(`FunctionPlan already published for ${func?.name || '<anonymous>'}`)
  const plan = {}
  ctx.plans.functionWorking.set(plan, workingFrame)
  ctx.plans.functions.set(func, plan)
  return plan
}

/** Read the opaque authoritative plan identity; missing publication is an error. */
export function functionPlanOf(ctx, func) {
  const plan = ctx.plans.functions.get(func)
  if (!plan || (!ctx.plans.functionData.has(plan) && !ctx.plans.functionWorking.has(plan)))
    throw new Error(`FunctionPlan missing for ${func?.name || '<anonymous>'}`)
  return plan
}

/** Linear retirement after the sole emission consumer has installed/used a plan. */
export function retireFunctionPlan(ctx, func, plan) {
  ctx.plans.functions.delete(func)
  ctx.plans.functionData.delete(plan)
  ctx.plans.functionWorking.delete(plan)
}

/**
 * Activate the detached analysis frame published with a one-shot plan.
 * Closure and __start emission consume this path; ordinary user functions use
 * installFunctionPlan() because their analysis frames are region-batch-local.
 */
export function enterPreparedFunction(ctx, plan) {
  const frame = ctx.plans.functionWorking.get(plan)
  if (!frame) throw new Error('FunctionPlan has no prepared emission frame')
  // Linear ownership transfer: after this point the frame is mutable emission
  // state, no longer an immutable FunctionPlan. Retire canonical access first.
  ctx.plans.functionWorking.delete(plan)
  const previous = ctx.func
  ctx.func = frame
  return previous
}

/**
 * Visit rep names without exposing the canonical rep map or any rep object.
 * Callers obtain individual fields through functionPlanRepField().
 */
export function forEachFunctionPlanRep(ctx, plan, visit) {
  const reps = ctx.plans.functionData.get(plan)?.localReps
  if (!reps) return
  for (let i = 0; i < reps.length; i += 2) visit(reps[i])
}

/** Pure projection: composite fields are detached before they leave the module. */
export function functionPlanRepField(ctx, plan, name, field) {
  const reps = ctx.plans.functionData.get(plan)?.localReps
  if (!reps) return undefined
  for (let i = 0; i < reps.length; i += 2)
    if (reps[i] === name) return clonePlanValue(reps[i + 1]?.[field])
  return undefined
}

/**
 * Install a fresh mutable working copy on the active function and return that
 * detached copy for emission-only metadata reads. Repeated installs never
 * share mutable collections with each other or with canonical plan storage.
 */
export function installFunctionPlan(ctx, plan) {
  const data = ctx.plans.functionData.get(plan)
  if (!data) throw new Error('Invalid FunctionPlan handle')
  const working = materializePlanData(data)
  ctx.func.locals = working.locals
  ctx.func.boxed = working.boxed
  ctx.func.capturedNames = working.capturedNames
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
