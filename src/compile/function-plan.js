/**
 * Linear ownership boundary between per-function analysis and emission.
 *
 * Analysis already owns fresh Maps, Sets and ValueRep records. Publishing a
 * plan transfers those collections into opaque module-owned storage without
 * cloning them. Emission consumes that storage exactly once and installs the
 * same collections on a fresh ActiveFunction frame. No mutable collection is
 * exposed through the public handle; cross-function readers use detached field
 * projections below.
 */

export function createFunctionPlan(ctx, facts) {
  const plan = {}
  ctx.plans.functionData.set(plan, facts)
  return plan
}

/** Publish one ordinary user-function plan exactly once. */
export function publishFunctionPlan(ctx, func, facts) {
  if (ctx.plans.functions.has(func))
    throw new Error(`FunctionPlan already published for ${func?.name || '<anonymous>'}`)
  const plan = createFunctionPlan(ctx, facts)
  ctx.plans.functions.set(func, plan)
  return plan
}

/** Publish a complete closure/__start ActiveFunction frame exactly once. */
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

/** Retire the function-to-plan binding after its sole emission consumer. */
export function retireFunctionPlan(ctx, func, plan) {
  ctx.plans.functions.delete(func)
  ctx.plans.functionData.delete(plan)
  ctx.plans.functionWorking.delete(plan)
}

/** Activate and consume a complete closure/__start frame. */
export function enterPreparedFunction(ctx, plan) {
  const frame = ctx.plans.functionWorking.get(plan)
  if (!frame) throw new Error('FunctionPlan has no prepared emission frame')
  ctx.plans.functionWorking.delete(plan)
  const previous = ctx.func
  ctx.func = frame
  return previous
}

/** Visit rep names without exposing the authoritative rep map. */
export function forEachFunctionPlanRep(ctx, plan, visit) {
  const reps = ctx.plans.functionData.get(plan)?.localReps
  if (!reps) return
  for (const name of reps.keys()) visit(name)
}

/** Read the scalar facts and schema-ID arrays needed by cross-function planning.
 * @param {'arrayElemSchema'|'arrayElemSchemaSet'|'intCertain'} field
 */
export function functionPlanRepField(ctx, plan, name, field) {
  const rep = ctx.plans.functionData.get(plan)?.localReps?.get(name)
  if (field === 'arrayElemSchema') return rep?.arrayElemSchema
  if (field === 'intCertain') return rep?.intCertain
  if (field === 'arrayElemSchemaSet') return rep?.arrayElemSchemaSet?.slice()
  throw new Error(`Unknown FunctionPlan projection: ${field}`)
}

/**
 * Consume an ordinary plan and transfer its collections to the active frame.
 * A second install is an ownership error, even before retireFunctionPlan runs.
 */
export function installFunctionPlan(ctx, plan) {
  const data = ctx.plans.functionData.get(plan)
  if (!data) throw new Error('Invalid or already-consumed FunctionPlan handle')
  ctx.plans.functionData.delete(plan)
  ctx.func.locals = data.locals
  ctx.func.boxed = data.boxed
  ctx.func.capturedNames = data.capturedNames
  ctx.func.cellTypes = data.cellTypes
  ctx.func.flatObjects = data.flatObjects
  ctx.func.sliceViews = data.sliceViews
  ctx.func.localReps = data.localReps
  ctx.func.leanHashLocals = data.leanHashLocals
  ctx.func.i32HashLocals = data.i32HashLocals
  ctx.func.leanHashDomains = data.leanHashDomains
  ctx.func.typedElem = data.typedElem
  ctx.func.typedLen = data.typedLen
  return data
}
