import { returnExprs } from '../../ast.js'
import { BIGINT_JOINT_BINARY_OPS } from '../../kind.js'
import {
  BIGINT_REP_BOXED, BOXED_BIGINT, JOIN_OPS, NO_BIGINT, RAW_BIGINT, REP_EDGE_REJECT, bigintRepBits,
  bigintRepIsClosed, definiteBigint, edgeAction, isBigintOrigin, programPlanRecord,
} from './common.js'

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
  if (!handle || (!record?.programEmpty && record?.boundary?.kind !== 'boundary'))
    throw new Error(`Representation boundary missing for ${identity?.name || identity || '<anonymous>'}`)
  return handle
}

export function representationParamRep(ctx, identity, index, target = true) {
  const record = ctx.plans.representationData.get(representationBoundaryOf(ctx, identity))
  if (record.programEmpty) return NO_BIGINT
  const data = record.boundary
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

export function representationResultRep(ctx, identity, target = true) {
  const record = ctx.plans.representationData.get(representationBoundaryOf(ctx, identity))
  if (record.programEmpty) return NO_BIGINT
  const data = record.boundary
  return target ? data.result.target : data.result.current
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
  const data = record?.body || record?.boundary
  if (!data) throw new Error('Invalid RepresentationPlan handle')
  let n = 0
  for (let i = 3; i < data.edges.length; i += 4) if (data.edges[i] === action) n++
  return n
}

export function representationBoundaryActionCount(ctx, identity, action) {
  const record = ctx.plans.representationData.get(representationBoundaryOf(ctx, identity))
  if (record.programEmpty) return 0
  let n = 0
  for (let i = 3; i < record.boundary.edges.length; i += 4)
    if (record.boundary.edges[i] === action) n++
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
  if (typeof node === 'string')
    return (target ? body.targetNames : body.currentNames)?.get(node) ?? NO_BIGINT
  if (Array.isArray(node)) {
    const packed = body.nodeFacts?.get(node)
    if (packed == null) return NO_BIGINT
    return target ? packed & 7 : (packed >> 3) & 7
  }
  return NO_BIGINT
}

/** Materialized representation of a stable parameter or normalized local. */
export function representationActiveMaterializedRep(ctx, name) {
  const active = activeBody(ctx, 'representationActiveMaterializedRep')
  if (Array.isArray(name) && JOIN_OPS.has(name[0])) {
    const body = active
    if (body?.materializedJoins?.has(name)) return activeRep(ctx, name, true)
    return NO_BIGINT
  }
  if (Array.isArray(name) && name[0] === '()') {
    // Shape #9 sibling: same one-authority widening as buildBodyData's own
    // calleeNameOf (this function runs at emission time, outside that
    // closure, so it reaches the identical frozen resolver via the program
    // plan record's own `provenance` instead of re-deriving it).
    const calleeName = typeof name[1] === 'string'
      ? name[1]
      : programPlanRecord(ctx)?.provenance?.resolveMemberCallee(name[1])?.name ?? null
    const callee = calleeName ? ctx.funcs.map.get(calleeName) : null
    const calleeHandle = callee && ctx.plans.representations.get(callee)
    const calleeRecord = calleeHandle && ctx.plans.representationData.get(calleeHandle)
    return calleeRecord?.body?.materializedResult === true
      ? calleeRecord.body.resultTarget ?? NO_BIGINT : NO_BIGINT
  }
  const body = active
  if (!body) return NO_BIGINT
  const handle = ctx.plans.representations.get(ctx.func.current)
  const record = handle && ctx.plans.representationData.get(handle)
  const k = record?.boundary?.func?.sig?.params?.findIndex(p => p.name === name) ?? -1
  if (k >= 0) {
    const boundaryReady = record.body?.hostBoxParams?.has(k) || record.body?.closureBoxParams?.has(k)
    const ready = record.boundary.params[k]?.stable === true || record.body?.materializedNames?.has(name)
    return (record.boundary.covered === true && ready) || boundaryReady ? activeRep(ctx, name, true) : NO_BIGINT
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
  if (!body?.materializedJoins?.has(node)) return REP_EDGE_REJECT
  // This emitter branch computes a fresh raw i64 result even though the
  // expression's planned value is materialized. Name the actual producer
  // carrier explicitly; consulting activeEmittedRep(node) would become KEEP
  // if generic materialized-expression lookup later learns this node shape.
  return edgeAction(RAW_BIGINT, activeRep(ctx, node, true))
}

/** Frozen action for one materialized return edge. */
export function representationReturnAction(ctx, source) {
  activeBody(ctx, 'representationReturnAction')
  const handle = ctx.plans.representations.get(ctx.func.current)
  const record = handle && ctx.plans.representationData.get(handle)
  if (record?.body?.materializedResult !== true) return REP_EDGE_REJECT
  return edgeAction(activeEmittedRep(ctx, source), record.body.resultTarget ?? record.boundary.result.target)
}

/** Frozen action for one plain declaration/assignment write. */
export function representationBindingWriteAction(ctx, name, source) {
  const body = activeBody(ctx, 'representationBindingWriteAction')
  if (!body?.materializedNames?.has(name)) return REP_EDGE_REJECT
  return edgeAction(activeEmittedRep(ctx, source), activeRep(ctx, name, true))
}

/** Frozen action for one materialized COMPOUND-ASSIGNMENT write (`n >>= v`,
 *  `n += v`, `n++`, …) — shape #6's emission-side companion to layer 4's
 *  plan-side readiness gate. Mirrors representationComputedExprAction's own
 *  reasoning for JOIN_OPS/census-unary nodes, applied to a NAME: emit.js's
 *  compound-assign families (compoundAssign's bigint arm, the bitwise
 *  '&='/'|='/'^='/'<<='/'>>='/'>>>=' dispatch, '++'/'--') all unbox the
 *  CURRENT value via readI64 (already plan-aware — isPlanTaggedBigint), run
 *  ONE i64 op, and re-wrap with fromI64 — the result is RAW_BIGINT by
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
  const body = record && record.body, boundary = record && record.boundary
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
  return rep === NO_BIGINT && isBigintOrigin(node) ? RAW_BIGINT : rep
}

/** True when every result tail is a proven raw BigInt carrier. This is the
 *  boundary twin of representationResultTagRequired: transformed callers can
 *  retain a direct call whose callee body has specialized to RAW even when
 *  the caller's coarse valResult/boundary semantic is still open. */
export function representationResultRawBigint(ctx, func, seen = new WeakSet()) {
  if (programPlanRecord(ctx)?.bigint === false || func == null || seen.has(func)) return false
  seen.add(func)
  const handle = ctx.plans.representations.get(func)
  const record = handle && ctx.plans.representationData.get(handle)
  const body = record?.body
  if (!body) { seen.delete(func); return false }
  const fb = func.body
  const tails = Array.isArray(fb) && fb[0] === '{}' ? returnExprs(fb) : [fb]
  const exprRaw = e => {
    if (isBigintOrigin(e)) return true
    if (typeof e === 'string')
      return body.materializedNames?.has(e) === true && body.targetNames?.get(e) === RAW_BIGINT
    if (!Array.isArray(e)) return false
    if (e[0] === ',') return exprRaw(e[e.length - 1])
    if (e[0] === '=') return exprRaw(e[2])
    if (e[0] === '()' && typeof e[1] === 'string') {
      const callee = ctx.funcs.map?.get(e[1])
      if (!callee) return false
      const calleeHandle = ctx.plans.representations.get(callee)
      const calleeBody = calleeHandle && ctx.plans.representationData.get(calleeHandle)?.body
      if (calleeBody?.materializedResult === true) return calleeBody.resultTarget === RAW_BIGINT
      return representationResultRawBigint(ctx, callee, seen)
    }
    return false
  }
  const result = tails.length > 0 && tails.every(exprRaw)
  seen.delete(func)
  return result
}

/** True when the plan's RESULT verdict for `func` is a tagged BigInt UNION —
 *  the value can be BigInt AND another kind (demandFor: canBeBigint &&
 *  canBeOther). Such a result is carried as the NaN-box tag discipline
 *  (BigInt member BOXED, number raw, pointers self-tagged), so the export
 *  boundary must take the generic tag decode (resultDynamic's `r` lane,
 *  interop's t===PTR.BIGINT arm derefs the box) — never the raw-bigint
 *  passthrough lane, which reinterprets the union's bits as one BigInt
 *  (a box POINTER's own bits, or a raw number's, both observed live:
 *  phase-c doc §gap 2a). */
/** `strict` (three-state discipline, re-audit P0): when true, answer TRUE
 *  only for PROVEN-tagged results — materialized names with BOXED targets,
 *  proven-boxed slots, and callee recursion thereof. The trailing
 *  open-current fallback is DISABLED: an open operand may carry a raw
 *  BigInt whose bits the tag test cannot distinguish, so consumers that
 *  short-circuit non-box members to false (strict equality's tagged arm)
 *  must never fire on it. The boundary LANE keeps the non-strict form —
 *  its generic decode is total over every tag, so over-routing is safe
 *  there and under-routing is not. */
export function representationResultTagRequired(ctx, func, seen = new WeakSet(), strict = false) {
  if (programPlanRecord(ctx)?.bigint === false) return false
  if (func == null || seen.has(func)) return false
  seen.add(func)
  const handle = ctx.plans.representations.get(func)
  const record = handle && ctx.plans.representationData.get(handle)
  const r = record?.boundary?.result
  if (r == null) return false
  // The boundary record's CURRENT is too coarse here: BOTH a raw member-slot
  // read (o.n on a decl-literal raw slot — statements' ++/-- pins) AND a
  // genuinely box-producing union (gnorm) sit at open-ANY, while keying on
  // demand or target both over-fire on nullish-raw LAYOUT shapes (pointers'
  // raw-exact pins). The precise verdict is PER RETURN EXPRESSION, through
  // the same arms the body solver plans with: a direct call may box iff its
  // callee's own body resultTarget carries the BOXED bit; a '.'-member read
  // is RAW when the slot is proven raw (slotBigintProvenAt) and otherwise
  // follows the storage discipline (BOXED for census-boxed storage); a bare
  // name may box iff this body materialized it to a BOXED target. Anything
  // unresolved falls back to the boundary current's BOXED bit.
  const body = record.body
  const fb = func.body
  const tails = Array.isArray(fb) && fb[0] === '{}' ? returnExprs(fb) : [fb]
  const exprMayBox = (e) => {
    if (typeof e === 'string')
      return body?.materializedNames?.has(e) === true &&
        (bigintRepBits(body.targetNames?.get(e) ?? NO_BIGINT) & BIGINT_REP_BOXED) !== 0
    if (Array.isArray(e)) {
      const op = e[0]
      if (op === '()' && typeof e[1] === 'string') {
        // The callee's return may box exactly when ITS result would demand
        // the tag at a boundary — the same question, one call deeper
        // (C3's compare arm asks it of the callee directly, which is why
        // the two stayed consistent only once this recursed).
        const callee = ctx.funcs.map?.get(e[1])
        if (!callee) return null
        const calleeHandle = ctx.plans.representations.get(callee)
        const calleeBody = calleeHandle && ctx.plans.representationData.get(calleeHandle)?.body
        if (calleeBody?.materializedResult === true)
          return (bigintRepBits(calleeBody.resultTarget ?? NO_BIGINT) & BIGINT_REP_BOXED) !== 0
        return representationResultTagRequired(ctx, callee, seen, strict)
      }
      if ((op === '.' || op === '?.') && typeof e[1] === 'string' && typeof e[2] === 'string')
        return ctx.schema.slotBigintProvenAt?.(e[1], e[2]) ? false
          : ctx.schema.slotBigintBoxedAt?.(e[1], e[2]) === true
      // A join the body fixpoint already proved materialized IS boxed —
      // ground truth, more precise than guessing from its arms (an arm can
      // be an unresolved literal, like a bare bigint origin, that recursion
      // alone would never resolve — see C5b: `flag ? 1n : 0`'s arms are both
      // leaves with no name/call to recurse into).
      if (JOIN_OPS.has(op) && body?.materializedJoins?.has(e) === true) return true
      // Census-shaped unary '-'/'~'/joint-binary result: same ground truth
      // as the JOIN_OPS line above — the body fixpoint's computed-expression pass (buildBodyData, beside the
      // JOIN_OPS materialization loop) already proved this exact node boxed.
      if ((op === 'u-' || op === '~' || BIGINT_JOINT_BINARY_OPS.has(op)) &&
          body?.materializedJoins?.has(e) === true) return true
      // Symmetric tri-state join (re-audit: bare `||` collapsed null||false
      // to false but false||null to null — arm ORDER changed the verdict):
      // TRUE dominates, else UNKNOWN (null) dominates, else FALSE.
      const j3 = (x, y) => x === true || y === true ? true : x == null || y == null ? null : false
      if (op === '?:') return j3(exprMayBox(e[2]), exprMayBox(e[3]))
      if (op === '&&' || op === '||' || op === '??') return j3(exprMayBox(e[1]), exprMayBox(e[2]))
    }
    return null  // unresolved — defer to the boundary fallback
  }
  // strict (the compare arm's question) demands a UNIVERSAL proof: EVERY
  // result-producing tail must be proven tagged — one tagged tail beside a
  // raw or unresolved sibling means a raw BigInt can still flow, and the
  // else-FALSE short-circuit would erase it. Non-strict (the boundary lane)
  // is existential: any may-box tail routes the generic decode, which is
  // total over every tag.
  let sawUnresolved = false, sawTagged = false, sawUntagged = false
  for (const e of tails) {
    const v = exprMayBox(e)
    if (v === true) sawTagged = true
    else if (v === false) sawUntagged = true
    else sawUnresolved = true
  }
  if (strict) return sawTagged && !sawUntagged && !sawUnresolved
  if (sawTagged) return true
  if (!sawUnresolved) return false
  return (bigintRepBits(r.current) & BIGINT_REP_BOXED) !== 0 && !bigintRepIsClosed(r.current)
}

export const representationProgramHasBigint = ctx => programPlanRecord(ctx)?.bigint === true

export const representationProgramRejectCount = ctx => programPlanRecord(ctx)?.rejects || 0
