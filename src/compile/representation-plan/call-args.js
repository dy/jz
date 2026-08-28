import {
  ANY_BIGINT, BIGINT_REP_NONE, BOXED_BIGINT, REP_EDGE_KEEP, REP_EDGE_REJECT, bigintRepBits, edgeAction,
  programPlanRecord,
} from './common.js'
import { activeEmittedRep, activeRep, activeStorageSourceRep } from './materialize.js'

/** Frozen action for one generic closure/call_indirect argument slot. */
export function representationClosureArgAction(ctx, source) {
  if (programPlanRecord(ctx)?.bigint === false) return REP_EDGE_KEEP
  return edgeAction(activeStorageSourceRep(ctx, source), BOXED_BIGINT)
}

/** Current source→callee target action for one direct-call argument. */
export function representationCallArgAction(ctx, node, params, index) {
  if (programPlanRecord(ctx)?.bigint === false) return REP_EDGE_KEEP
  const targetHandle = ctx.plans.representations.get(params)
  const targetRecord = targetHandle && ctx.plans.representationData.get(targetHandle)
  const targetBoundary = targetRecord?.boundary
  if (!targetBoundary) return REP_EDGE_REJECT
  // A reassigned parameter is ready only when Slice 3b can normalize its
  // complete plain-write def set; otherwise switching entry alone would split
  // the local's ABI.
  const targetName = targetBoundary.func?.sig?.params?.[index]?.name
  const bodyReady = targetName != null && targetRecord.body?.materializedNames?.has(targetName)
  const hostReady = targetRecord.body?.hostBoxParams?.has(index) === true
  const closureReady = targetRecord.body?.closureBoxParams?.has(index) === true
  const ready = targetBoundary.params[index]?.stable === true || bodyReady
  if ((!ready || targetBoundary.covered !== true) && !hostReady && !closureReady) return REP_EDGE_REJECT
  const target = bodyReady || hostReady || closureReady
    ? targetRecord.body.targetNames?.get(targetName) ?? ANY_BIGINT
    : targetBoundary.params[index]?.target ?? ANY_BIGINT
  return edgeAction(activeEmittedRep(ctx, node), target)
}

/** Record direct-closure argument provenance before that closure is planned. */
export function recordClosureCallRepresentations(ctx, bodyName, args) {
  const program = programPlanRecord(ctx)
  if (!program?.bigint) return
  let row = program.closureParams.get(bodyName)
  for (let k = 0; k < args.length; k++) {
    if (bigintRepBits(activeRep(ctx, args[k], true)) === BIGINT_REP_NONE) continue
    if (!row) { row = new Set(); program.closureParams.set(bodyName, row) }
    row.add(k)
  }
}
