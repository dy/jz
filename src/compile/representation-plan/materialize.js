import { valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import {
  BOXED_BIGINT, JOIN_OPS, NO_BIGINT, RAW_BIGINT, REP_EDGE_REJECT, REP_EDGE_TAG_BOX, callContractOf, canBeBigint, contractRep,
  definiteBigint, edgeAction, isBigintOrigin, programPlanRecord, returnEdgeAction,
} from './common.js'
import { memberStorageRep } from './body-data.js'
import { boundaryDataOf } from './boundaries.js'

export function representationPlanOf(ctx, identity) {
  const program = programPlanRecord(ctx)
  const handle = ctx.plans.representations.get(identity) || (program?.bigint === false ? program.emptyHandle : null)
  const record = handle && ctx.plans.representationData.get(handle)
  if (!handle || (!record?.programEmpty && record?.body?.kind !== 'body'))
    throw new Error(`RepresentationPlan missing for ${identity?.name || '<anonymous>'}`)
  return handle
}

export function representationBoundaryOf(ctx, identity) {
  const program = programPlanRecord(ctx)
  const func = typeof identity === 'string' ? ctx.funcs.map.get(identity) : identity
  const handle = (func && ctx.plans.representations.get(func)) || (program?.bigint === false ? program.emptyHandle : null)
  const record = handle && ctx.plans.representationData.get(handle)
  const boundary = func && boundaryDataOf(ctx, func)
  if (!handle || (!record?.programEmpty && boundary?.kind !== 'boundary'))
    throw new Error(`Representation boundary missing for ${identity?.name || identity || '<anonymous>'}`)
  return handle
}

export function representationParamRep(ctx, identity, index, target = true) {
  const record = ctx.plans.representationData.get(representationBoundaryOf(ctx, identity))
  if (record.programEmpty) return NO_BIGINT
  const data = boundaryDataOf(ctx, typeof identity === 'string' ? ctx.funcs.map.get(identity) : identity)
  const param = data.params[index]
  if (target || !record.body) return target ? param?.target : param?.current

  // Boundary solving precedes body materialization. Once the body proves a
  // parameter's complete entry/write normalization, its active entry carrier
  // is the body target—not the coarse pre-body current estimate. Read that
  // second-phase verdict without mutating the already-published boundary.
  const name = data.func?.sig?.params?.[index]?.name
  const ready = name != null && (
    (data.covered === true && param?.stable === true) ||
    record.body.materializedNames?.has(name) === true ||
    record.body.hostBoxParams?.has(index) === true ||
    record.body.closureBoxParams?.has(index) === true
  )
  return ready
    ? record.body.targetNames?.get(name) ?? param?.target ?? NO_BIGINT
    : param?.current ?? NO_BIGINT
}

/** The carrier a callable's result crosses in: the target its return edges
 *  convert every tail to (its contract's, or the body's own walk for a
 *  contract naming none). */
export function representationResultRep(ctx, identity) {
  const record = ctx.plans.representationData.get(representationBoundaryOf(ctx, identity))
  if (record.programEmpty) return NO_BIGINT
  const data = boundaryDataOf(ctx, typeof identity === 'string' ? ctx.funcs.map.get(identity) : identity)
  return record.body?.resultTarget ?? data.result.target
}

export function representationBindingRep(ctx, plan, name, target = true) {
  const record = ctx.plans.representationData.get(plan)
  if (record?.programEmpty) return NO_BIGINT
  const data = record?.body
  if (data?.kind !== 'body') throw new Error('Invalid RepresentationPlan handle')
  return (target ? data.targetNames : data.currentNames)?.get(name) ?? NO_BIGINT
}

export function representationActionCount(ctx, plan, action) {
  const record = ctx.plans.representationData.get(plan)
  if (record?.programEmpty) return 0
  const data = record?.body
  if (!data) throw new Error('Invalid RepresentationPlan handle')
  let n = 0
  for (let i = 3; i < data.edges.length; i += 4) if (data.edges[i] === action) n++
  return n
}

export function representationBoundaryActionCount(ctx, identity, action) {
  const record = ctx.plans.representationData.get(representationBoundaryOf(ctx, identity))
  if (record.programEmpty) return 0
  const boundary = boundaryDataOf(ctx, typeof identity === 'string' ? ctx.funcs.map.get(identity) : identity)
  let n = 0
  for (let i = 3; i < boundary.edges.length; i += 4)
    if (boundary.edges[i] === action) n++
  return n
}

const activeBody = (ctx, consumer) => {
  const program = programPlanRecord(ctx)
  if (program?.bigint !== true) return null
  const handle = ctx.plans.representations.get(ctx.func.current)
  const body = handle && ctx.plans.representationData.get(handle)?.body
  if (!body)
    throw new Error(`RepresentationPlan active body missing in ${consumer} for ${ctx.func.current?.name || '<anonymous>'}`)
  return body
}

export const activeRep = (ctx, node, target) => {
  const body = activeBody(ctx, 'activeRep')
  if (!body) return NO_BIGINT
  // A module binding's carrier is the program's fact, as body-data reads it.
  if (typeof node === 'string')
    return (target ? body.targetNames : body.currentNames)?.get(node)
      ?? programPlanRecord(ctx)?.provenance?.globalReps.get(node) ?? NO_BIGINT
  if (Array.isArray(node)) {
    const packed = body.nodeFacts?.get(node)
    if (packed == null) return NO_BIGINT
    return target ? packed & 7 : (packed >> 3) & 7
  }
  return NO_BIGINT
}

/** True when the plan's own semantic for a retained node is exactly BigInt
 *  (no other kind, no nullish member): an edge on it acts without a kind
 *  gate, as on a name the plan materialized. */
export function representationProvesBigint(ctx, node) {
  const body = activeBody(ctx, 'representationProvesBigint')
  const packed = body?.nodeFacts?.get(node)
  return packed != null && definiteBigint(packed >> 6)
}

/** Materialized representation of a stable parameter or normalized local. */
export function representationActiveMaterializedRep(ctx, name) {
  // A sequence forwards its final producer's carrier, not just its kind.
  while (Array.isArray(name) && name[0] === ',') name = name[name.length - 1]
  const active = activeBody(ctx, 'representationActiveMaterializedRep')
  if (!active) return NO_BIGINT
  if (Array.isArray(name) && active.materializedJoins?.has(name))
    return activeRep(ctx, name, true)
  if (Array.isArray(name) && JOIN_OPS.has(name[0])) return NO_BIGINT
  // A direct call's result crosses in its callee's contract carrier (the
  // callee's return edges convert every tail to it). A closure's is the
  // call node's own retained fact (body-data.js callRep).
  if (Array.isArray(name) && name[0] === '()') {
    const calleeName = typeof name[1] === 'string' ? name[1]
      : programPlanRecord(ctx)?.provenance?.resolveMemberCallee(name[1])?.name ?? null
    return calleeName != null && ctx.funcs.map.get(calleeName)?.body ? contractRep(callContractOf(ctx, name)) ?? NO_BIGINT : NO_BIGINT
  }
  const handle = ctx.plans.representations.get(ctx.func.current)
  const record = handle && ctx.plans.representationData.get(handle)
  const boundary = record?.body?.boundary
  const k = boundary?.func?.sig?.params?.findIndex(p => p.name === name) ?? -1
  if (k >= 0) {
    const boundaryReady = record.body?.hostBoxParams?.has(k) || record.body?.closureBoxParams?.has(k)
    const ready = boundary.params[k]?.stable === true || record.body?.materializedNames?.has(name)
    return (boundary.covered === true && ready) || boundaryReady ? activeRep(ctx, name, true) : NO_BIGINT
  }
  return record?.body?.materializedNames?.has(name) ? activeRep(ctx, name, true) : NO_BIGINT
}

/** Frozen action for one ordinary tagged storage/value slot. */
export function representationStorageWriteAction(ctx, source) {
  if (programPlanRecord(ctx)?.bigint === false) return REP_EDGE_REJECT
  return edgeAction(activeStorageSourceRep(ctx, source), BOXED_BIGINT)
}

/** True when JS interop must box an actual BigInt at this export slot. */
export function representationHostBoxesParam(ctx, identity, index) {
  const handle = ctx.plans.representations.get(identity)
  const record = handle && ctx.plans.representationData.get(handle)
  if (programPlanRecord(ctx)?.bigint === true && !record?.body)
    throw new Error(`RepresentationPlan host boundary missing for ${identity?.name || '<anonymous>'}`)
  return record?.body?.hostBoxParams?.has(index) === true
}

/** Frozen action for one materialized ternary arm. */
export function representationJoinArmAction(ctx, join, arm) {
  const body = activeBody(ctx, 'representationJoinArmAction')
  if (!body?.materializedJoins?.has(join)) return REP_EDGE_REJECT
  return edgeAction(activeEmittedRep(ctx, arm), activeRep(ctx, join, true))
}

/** Frozen action for one materialized census-shaped unary '-'/'~' or
 *  joint-binary result node. Unlike a JOIN_OPS node, there is no separate
 *  "arm" to ask about: the node's own single
 *  computed value IS the thing that may need boxing (bigIntUnary/
 *  bigIntJointDispatch in emit.js build the "real bigint" branch fresh from
 *  the operand's raw i64 bits, not from some other already-typed operand),
 *  so join and arm collapse to the same node. */
export function representationComputedExprAction(ctx, node) {
  const body = activeBody(ctx, 'representationComputedExprAction')
  // An emitter-rebuilt node (`n += v` as `n = n + v`, an inline callback
  // body) names the slot it lands in: a binding, a member, or a tagged slot.
  // A definite BigInt result stays raw for the slot's own write edge
  // (activeStorageSourceRep); only a mixed result normalizes itself here.
  const compound = ctx.plans.compoundOf.get(node)
  if (compound === true || Array.isArray(compound)) {
    if (valTypeOf(node) === VAL.BIGINT) return REP_EDGE_REJECT
    return edgeAction(RAW_BIGINT, compound === true ? BOXED_BIGINT : memberStorageRep(ctx, compound))
  }
  if (compound != null) return representationCompoundAssignAction(ctx, compound)
  const target = activeRep(ctx, node, true)
  // Some emitter wrappers rebuild an equivalent arithmetic node and therefore
  // cannot share the planner's WeakSet identity. The retained nodeFacts entry
  // is the stable fallback: only a BOXED target licenses materialization.
  if (!body?.materializedJoins?.has(node) && target !== BOXED_BIGINT) return REP_EDGE_REJECT
  // This emitter branch computes a fresh raw i64 result even though the
  // expression's planned value is materialized. Name the actual producer
  // carrier explicitly; consulting activeEmittedRep(node) would become KEEP
  // if generic materialized-expression lookup later learns this node shape.
  return edgeAction(RAW_BIGINT, target)
}

/** Frozen action for one return edge: the tail converts to the result's
 *  carrier (the contract's). A tail the plan retained no carrier for (a
 *  checked read's deferred box, a producer outside the retained facts)
 *  converts to a boxed result by tag, the deferred materializer boxing its
 *  present arm. */
export function representationReturnAction(ctx, source) {
  const body = activeBody(ctx, 'representationReturnAction')
  if (!body) return REP_EDGE_REJECT
  const target = body.resultTarget
  if (target !== RAW_BIGINT && target !== BOXED_BIGINT) return REP_EDGE_REJECT
  const current = activeEmittedRep(ctx, source)
  if (current === NO_BIGINT)
    return target === BOXED_BIGINT && canBeBigint(body.resultSemantic) ? REP_EDGE_TAG_BOX : edgeAction(current, target)
  return returnEdgeAction(current, target)
}

/** Frozen action for one plain declaration/assignment write. */
export function representationBindingWriteAction(ctx, name, source) {
  const body = activeBody(ctx, 'representationBindingWriteAction')
  if (!body?.materializedNames?.has(name)) return REP_EDGE_REJECT
  return edgeAction(activeEmittedRep(ctx, source), activeRep(ctx, name, true))
}

/** Frozen action for one materialized arithmetic compound write (`n += v`,
 *  `n *= v`, …) — shape #6's emission-side companion to layer 4's
 *  plan-side readiness gate. Mirrors representationComputedExprAction's own
 *  reasoning for JOIN_OPS/census-unary nodes, applied to a NAME. The arithmetic
 *  compoundAssign handler unboxes the CURRENT value via readI64 (already
 *  plan-aware — isPlanTaggedBigint), runs ONE i64 op, and re-wraps with
 *  fromI64 — the result is RAW_BIGINT by
 *  construction, never anything else, so (unlike representationBindingWriteAction,
 *  whose source can be any expression shape) there is no per-node fact to
 *  look up: no AST node to key nodeFacts by even exists inside these
 *  handlers (they receive `name`/`val`, never the wrapping compound node
 *  collectDefs recorded as `def[DEF_RHS]`). Without this action, layer 4 letting
 *  such a def into materializedNames just moves the corruption: the WRITE
 *  back into a now-BOXED-target binding stored the raw i64 bits unboxed
 *  (readVar's next isPlanTaggedBigint-gated read would then unbox THOSE
 *  bits again, misreading a raw payload as a box pointer — the exact
 *  box-pointer-bits-as-value disease this fixpoint exists to close). */
export function representationCompoundAssignAction(ctx, name) {
  const body = activeBody(ctx, 'representationCompoundAssignAction')
  if (!body?.materializedNames?.has(name)) return REP_EDGE_REJECT
  return edgeAction(RAW_BIGINT, activeRep(ctx, name, true))
}

/** ++/-- have no RHS operand whose local valType can select the BigInt path.
 * Admit a covered binding only when its frozen semantic is definitely BigInt;
 * return the raw-result write action for that binding's planned target. */
export function representationUnaryUpdateAction(ctx, name) {
  activeBody(ctx, 'representationUnaryUpdateAction')
  const handle = ctx.plans.representations.get(ctx.func.current)
  const record = handle && ctx.plans.representationData.get(handle)
  const body = record && record.body, boundary = body && body.boundary
  if (!body || !boundary) return REP_EDGE_REJECT
  let semantic = body.semanticNames ? body.semanticNames.get(name) : null
  let target = body.targetNames ? body.targetNames.get(name) : null
  if (semantic == null || target == null) {
    const func = boundary.func
    const params = func && func.sig ? func.sig.params : null
    const k = params ? params.findIndex(p => p.name === name) : -1
    if (k >= 0) {
      if (semantic == null) semantic = boundary.params[k] ? boundary.params[k].semantic : null
      if (target == null) target = boundary.params[k] ? boundary.params[k].target : null
    }
  }
  if (semantic == null || !definiteBigint(semantic) || target == null) return REP_EDGE_REJECT
  return edgeAction(RAW_BIGINT, target)
}

export const activeEmittedRep = (ctx, node) => {
  if (typeof node === 'string' || Array.isArray(node)) {
    const materialized = representationActiveMaterializedRep(ctx, node)
    if (materialized !== NO_BIGINT) return materialized
  }
  return activeRep(ctx, node, false)
}

// Some emit-time storage producers are nested below AST sites retained in
// nodeFacts (array/object literal elements are the common case). Their own
// syntax still proves a fresh raw BigInt carrier; NO_BIGINT here means "not
// retained", not "this BigInt origin emits no BigInt".
export const activeStorageSourceRep = (ctx, node) => {
  const rep = activeEmittedRep(ctx, node)
  if (rep !== NO_BIGINT) return rep
  if (isBigintOrigin(node)) return RAW_BIGINT
  // An emitter-rebuilt node has no retained facts (ctx.plans.compoundOf): a
  // definite BigInt result of one is the raw i64 the arithmetic emitters
  // compute; a mixed one normalized itself (representationComputedExprAction).
  if (Array.isArray(node) && ctx.plans.compoundOf.has(node) && valTypeOf(node) === VAL.BIGINT) return RAW_BIGINT
  return rep
}

export const representationProgramHasBigint = ctx => programPlanRecord(ctx)?.bigint === true

export const representationProgramRejectCount = ctx => programPlanRecord(ctx)?.rejects || 0
