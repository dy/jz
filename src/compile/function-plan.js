import { cloneRep } from '../param-reps.js'

const cloneRepMap = map => map ? new Map([...map].map(([name, rep]) => [name, cloneRep(rep)])) : null

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
    typedElem: facts.typedElem ? new Map(facts.typedElem) : null,
    typedLen: facts.typedLen ? new Map(facts.typedLen) : null,
    localReps: cloneRepMap(facts.localReps),
  })
}

/** Publish exactly once for a function identity. */
export function publishFunctionPlan(ctx, func, facts) {
  if (ctx.plans.functions.has(func))
    throw new Error(`FunctionPlan already published for ${func?.name || '<anonymous>'}`)
  const plan = createFunctionPlan(facts)
  ctx.plans.functions.set(func, plan)
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
  if (!Object.isFrozen(plan)) throw new Error('installFunctionPlan: expected a published frozen plan')
  ctx.func.locals = new Map(plan.locals)
  ctx.func.boxed = new Map(plan.boxed)
  ctx.func.cellTypes = new Set(plan.cellTypes)
  ctx.func.flatObjects = new Map(plan.flatObjects)
  ctx.func.sliceViews = new Set(plan.sliceViews)
  ctx.func.localReps = cloneRepMap(plan.localReps)
  ctx.func.leanHashLocals = new Set(plan.leanHashLocals)
  ctx.func.i32HashLocals = new Set(plan.i32HashLocals)
  ctx.func.leanHashDomains = new Map(plan.leanHashDomains)
  ctx.types.typedElem = plan.typedElem ? new Map(plan.typedElem) : null
  ctx.types.typedLen = plan.typedLen ? new Map(plan.typedLen)
    : ctx.scope.globalTypedLen ? new Map(ctx.scope.globalTypedLen) : null
}
