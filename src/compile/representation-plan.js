/**
 * RepresentationPlan owns BigInt body-local actions (the BigInt representation
 * decisions below). ProgramIndex owns every
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
 *
 * A carrier proof alone cannot establish a value's kind: call-site BigInt-only proofs also require
 * the source expression's semantic kind.
 *
 * Mixed dynamic BigInt is a core feature, not compat sugar: the self-compiled compiler parses
 * `i64.const` operands through it, a raw BigInt∪Number union is physically ambiguous (tagged Number
 * 0 bit-equals raw 0n, Number.MIN_VALUE bit-equals 1n), and a raw-only, reject-the-rest mode was
 * reverted once already.
 *
 * - The tagged carrier is the universal correct crossing for any BigInt∪other edge (call, storage,
 *   closure, return, host). Raw i64 is an optimization applied only where the plan proves
 *   single-representation flow end to end.
 * - Each identity and edge has one representation authority. ProgramIndex owns every
 *   parameter/result boundary (named sources, specialization variants, the anonymous closure/start
 *   space); RepresentationPlan owns body-local actions. Analysis discovers facts, the owning plan
 *   chooses actions, emission never reconstructs a decision, and optimizers preserve
 *   plan-materialized unions or invalidate the plan.
 * - The host boundary is evidence-based per slot, one descriptor: the wrapper dispatches on a
 *   per-export, per-slot policy the compiler emits (RAW_BIGINT, TAGGED_VALUE, NUMBER, EXTERNREF,
 *   plus a rest-element policy), never on the absence of a box marker. BigInt ingress with no
 *   evidence rejects with a TypeError; it never stringifies or misdecodes.
 * - `JZ_BIGINT_STRICT=1` stays opt-in (reject what is unprovable, a lint or deploy mode), never the
 *   default.
 * - No accepted program returns a known-wrong value at any optimization level, and the jz×jz
 *   self-compile completes under wasm32's 4 GiB ceiling.
 */
export {
  BIGINT_REP_RAW,
  BIGINT_REP_BOXED,
  BIGINT_REP_CLOSED,
  REP_EDGE_KEEP,
  REP_EDGE_BOX,
  REP_EDGE_UNBOX,
  REP_EDGE_HOST_BOX,
  REP_EDGE_REJECT,
  REP_EDGE_TAG_BOX,
  JOIN_OPS,
  STORAGE_READ_METHODS,
  callContractOf,
} from './representation-plan/common.js'

export { solveRepresentationBoundaries } from './representation-plan/boundaries.js'

export { mintRepresentationPlan } from './representation-plan/body-data.js'

export {
  representationPlanOf,
  representationParamRep,
  representationResultRep,
  representationBindingRep,
  representationActionCount,
  representationBoundaryActionCount,
  representationActiveMaterializedRep,
  representationProvesBigint,
  representationStorageWriteAction,
  representationHostBoxesParam,
  representationJoinArmAction,
  representationComputedExprAction,
  representationReturnAction,
  representationBindingWriteAction,
  representationGlobalMayBox,
  representationCompoundAssignAction,
  representationUnaryUpdateAction,
  representationProgramHasBigint,
  representationBodyBuilt,
  representationProgramRejectCount,
} from './representation-plan/materialize.js'

export {
  representationClosureArgAction,
  representationCallArgAction,
  recordClosureCallRepresentations,
} from './representation-plan/call-args.js'
