/**
 * RepresentationPlan owns BigInt body-local actions (ADR-0001,
 * .work/adr-0001-bigint-representation.md). ProgramIndex owns every
 * parameter/result boundary: named sources, specialization variants, and the
 * anonymous closure/start space. Every edge (call arg, binding
 * write, return, storage, join arm, host boundary) gets exactly one action
 * (KEEP/BOX/UNBOX/HOST_BOX/REJECT); analysis discovers facts, the plan
 * chooses actions, emission never reconstructs a plan decision.
 *
 * This file is a stable barrel: the implementation lives in
 * `representation-plan/` (common/boundaries/provenance/body-data/materialize/
 * call-args), split by phase — see `.work/archive/representation-plan-split.md` for
 * the phase map and module-split rationale. Every name below is re-exported
 * unchanged so no consumer import path (`from './representation-plan.js'` /
 * `from '../representation-plan.js'`) needs to move.
 */
export {
  BIGINT_REP_NONE,
  BIGINT_REP_RAW,
  BIGINT_REP_BOXED,
  BIGINT_REP_TOP,
  BIGINT_REP_CLOSED,
  BIGINT_DEMAND_RAW_OK,
  BIGINT_DEMAND_TAG_REQUIRED,
  REP_EDGE_KEEP,
  REP_EDGE_BOX,
  REP_EDGE_UNBOX,
  REP_EDGE_HOST_BOX,
  REP_EDGE_REJECT,
  JOIN_OPS,
} from './representation-plan/common.js'

export { solveRepresentationBoundaries } from './representation-plan/boundaries.js'

export { mintRepresentationPlan } from './representation-plan/body-data.js'

export {
  representationPlanOf,
  representationBoundaryOf,
  representationParamRep,
  representationResultRep,
  representationBindingRep,
  representationActionCount,
  representationBoundaryActionCount,
  representationActiveMaterializedRep,
  representationStorageWriteAction,
  representationHostBoxesParam,
  representationJoinArmAction,
  representationComputedExprAction,
  representationReturnAction,
  representationBindingWriteAction,
  representationCompoundAssignAction,
  representationUnaryUpdateAction,
  representationResultRawBigint,
  representationResultTagRequired,
  representationProgramHasBigint,
  representationProgramRejectCount,
} from './representation-plan/materialize.js'

export {
  representationClosureArgAction,
  representationCallArgAction,
  recordClosureCallRepresentations,
} from './representation-plan/call-args.js'
