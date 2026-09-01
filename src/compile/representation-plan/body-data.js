import { ASSIGN_OPS, commaList, returnExprs } from '../../ast.js'
import { DBG_INVARIANTS } from '../../ctx.js'
import { BIGINT_JOINT_BINARY_OPS, censusMaybeUndefinedKind, nullishArm, valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { closureBodyReturnKind } from '../flow-types.js'
import {
  ANY_BIGINT, BIGINT_KIND_BIT, BIGINT_REP_BOXED, BIGINT_REP_NONE, BIGINT_REP_RAW, BIGINT_REP_TOP, BOXED_BIGINT,
  CONDITIONAL_ASSIGN_OPS, DEF_OWNER, DEF_RHS, EDGE_KIND, EDGE_KIND_NAME, JOIN_OPS, NO_BIGINT, NUMERIC_VALUE_OPS,
  RAW_BIGINT, REP_EDGE_BOX, REP_EDGE_HOST_BOX, REP_EDGE_KEEP, REP_EDGE_REJECT, REP_EDGE_UNBOX, STORAGE_READ_METHODS,
  bigintRepBits, bigintRepIsClosed, bitOfKind, callMember, canBeBigint, collectDefs, collectLocalClosures,
  definiteBigint, edgeAction, excludesBigint, isBigintOrigin, isExported, joinRep, joinSem, memberReceiver,
  noBigintSemantic, packSemantic, programPlanRecord, sameSem, semAll, semBottom, semKind, semanticClosed,
  semanticFromRep, semanticKinds, semanticObserved, targetRepFor,
} from './common.js'
import { ensureBoundary } from './boundaries.js'
import { deriveLocalProvenance } from './provenance.js'

const EMPTY_KIND_MAP = new Map()

const NON_BIGINT_OPS = new Set([
  'typeof', '!', '>', '<', '>=', '<=', '==', '!=', '===', '!==', 'u+', '>>>',
  'str', 'bool', 'new', 'delete', 'in', 'instanceof',
])
const joinArms = node => node[0] === '?:' ? [node[2], node[3]] : [node[1], node[2]]

const directCallBoundary = (ctx, name) => {
  const func = ctx.funcs.map.get(name)
  const handle = func && ctx.plans.representations.get(func)
  return handle ? ctx.plans.representationData.get(handle)?.boundary || null : null
}

/** True iff SOME return tail of `body` is the bare name `paramName`, verbatim
 *  — a genuine passthrough (`if (…) return x`), not a freshly-computed
 *  expression (`return BigInt(x)` doesn't count: its OWN carrier is always a
 *  fresh conversion, independent of x's). This is the ONE shape whose result
 *  carrier is inherited, unchanged, from the param's own entry — reuses
 *  returnExprs (ast.js), the same return-tail set buildBodyData's own
 *  resultExprs/materializedResult already fold over, so this asks the
 *  identical question a closure's own plan will ask of itself. */
const paramForwardsToReturn = (body, paramName) => returnExprs(body).some(e => e === paramName)

// A local—or a parameter on a covered direct boundary—whose complete def
// set uses plain writes can have every incoming edge normalized at
// emitDecl / the '=' handler. Keep this
// readiness private: readers get only a scalar projection, never the Set.
//
// BOX/UNBOX admission is plain valTypeOf(node) === VAL.BIGINT — no
// `.`-member widening needed here. kind.js's valTypeOf (VT['()']) now
// resolves a `.`-member callee through the same frozen ProgramIndex IDs
// this file's own calleeNameOf/resolveMemberCallee already consult, so a
// `.`-member call proves exactly as BIGINT here as the equivalent
// bare-name call always did — one authority, not a second proof re-derived
// from `source`'s own representation bits (the prior approach here, and
// ir.js's independent applyBigintRepresentationAction widening, both
// removed with kind.js's own fix: .work/archive/member-callee-binding-write-notes.md).
//
// Already fully self-contained (every dependency an explicit parameter or a
// module-level import) before this slice — buildBodyData's own materialization
// fixpoint is its only caller, at 5 sites, but nothing here reads that
// fixpoint's local state, so it lives at module scope like this file's
// other single-purpose predicates.
const edgeMaterializable = (source, target, node, sourceReady = false) => {
  const action = edgeAction(source, target)
  if (action === REP_EDGE_BOX || action === REP_EDGE_UNBOX)
    return valTypeOf(node) === VAL.BIGINT || isBigintOrigin(node)
  if (action !== REP_EDGE_KEEP) return false
  // NONE is unchanged on a tagged union edge. A raw KEEP is also a real
  // identity. BOXED→BOXED is ready only when the upstream producer family
  // has itself materialized, not merely because its eventual target is BOXED.
  return bigintRepBits(source) === BIGINT_REP_NONE ||
    (source === RAW_BIGINT && target === RAW_BIGINT) ||
    (source === BOXED_BIGINT && target === BOXED_BIGINT && sourceReady)
}

/** The "BOOL-veto": true when a closed semantic includes the BOOL member.
 *  RepresentationPlan only ever normalizes the BigInt member of a union; a
 *  value that MIGHT be a JS boolean still needs the separate BOOL-atom
 *  producer, so materializing BigInt onto it would erase that other
 *  identity. Repeated verbatim at 7 sites in buildBodyData's materialization
 *  fixpoints (materializedNames, hostBoxParams, closureBoxParams, the
 *  JOIN_OPS pass, the census-unary/joint pass, the materializedNames
 *  propagation pass, resultHasClosedBool) — one helper, not seven copies. */
const hasClosedBool = sem => semanticClosed(sem) && (semanticKinds(sem) & bitOfKind(VAL.BOOL)) !== 0

function buildBodyData(ctx, identity, sig, body, localReps, boundary, options) {
  const defs = collectDefs(body)
  const provenance = options.provenance
  const taintedNames = options.localProvenance?.names || provenance?.namesByFunc.get(identity)
  const localStorage = options.localProvenance ? options.localProvenance.storage : null
  const localStorageRead = node => {
    if (!localStorage || !Array.isArray(node)) return false
    const recv = memberReceiver(node), cm = callMember(node)
    if (recv != null && localStorage.has(recv)) return true
    return !!cm && STORAGE_READ_METHODS.has(cm[2]) && localStorage.has(cm[1])
  }
  const mayCarryBigint = node => localStorageRead(node) || !provenance || provenance.exprMay(node, identity, taintedNames)
  const params = new Map((sig?.params || []).map((p, i) => [p.name, i]))
  // Closure-forwarding slice (.work/archive/phase-c-unification.md §C4b queue):
  // same-body local closures, structurally (name → {params, body}) — a call
  // to one of these is invisible to directCallBoundary (closures never enter
  // ctx.funcs.map), so currentOf/plannedOf's ordinary callee lookup always
  // misses it. Used below to recognize the specific shape that needs a
  // representation verdict OTHER than the generic unresolved-call fallback.
  const localClosures = collectLocalClosures(body)
  // Shape #9 sibling (.work/archive/shape9-boxed-arg-raw-callee.md residual 2): every
  // directCallBoundary consumer below (semanticOf/currentOf/plannedOf/
  // walkEdges/emittedCandidate) resolved ONLY a bare-name callee
  // (`typeof node[1] === 'string'`) — a `.`-member callee the frozen
  // ProgramIndex proves (Shape #8/#7-residual, `resolveMemberCallee`,
  // the SAME function solveBigintProvenance's own exprMay/exprRep/scan/
  // visitCallSites already use) was invisible here even when fully resolved
  // there, so a binding write like watr's own `n = i64.parse(n)` never
  // reached its callee's proven representation. One authority, reused
  // verbatim (never re-derived): null whenever `provenance` itself is absent
  // or the node isn't a resolvable `.`-member call, exactly like every other
  // `provenance?.` guarded fact in this function.
  const calleeNameOf = node =>
    typeof node[1] === 'string' ? node[1] : provenance?.resolveMemberCallee(node[1])?.name ?? null
  const semanticNames = new Map()
  const currentNames = new Map()
  const targetNames = new Map()
  // Ordinary Maps, deliberately: semantic/current caches must be cleared
  // between widening sweeps. They remain private plan data, never exposed.
  const nodeSemantic = new Map()
  const nodeCurrent = new Map()
  const nodeTarget = new Map()
  const edges = []

  for (const [name, k] of params) {
    const p = boundary.params[k]
    semanticNames.set(name, p?.semantic || semAll())
    currentNames.set(name, p?.current ?? ANY_BIGINT)
  }
  if (localReps) for (const [name, rep] of localReps) {
    if (semanticNames.has(name) || defs.has(name)) continue
    if (provenance && !taintedNames?.has(name) && !provenance.globals.has(name)) {
      semanticNames.set(name, noBigintSemantic())
      currentNames.set(name, NO_BIGINT)
      continue
    }
    semanticNames.set(name, semanticFromRep(rep))
    if (excludesBigint(semanticNames.get(name))) currentNames.set(name, NO_BIGINT)
    else if (rep?.val === VAL.BIGINT) currentNames.set(name, RAW_BIGINT)
    else currentNames.set(name, ANY_BIGINT)
  }

  // Closure-forwarding slice: valTypeOf's own closure lookup (calleeValType,
  // kind-traits.js) reads ctx.closure.valResult — populated at ctx.closure
  // .make time, i.e. when THIS body's emission first processes the closure
  // literal's own decl statement. buildBodyData runs at analysis time,
  // strictly before this body ever emits (mintRepresentationPlan's own call
  // site, compile/index.js, precedes emitFunc's body walk) — so for a
  // same-body local closure, ctx.closure.valResult is always empty here,
  // and valTypeOf(callNode) always answers null, regardless of how
  // provably-uniform the closure's own return kind is. closureBodyReturnKind
  // (flow-types.js) is the identical proof through a channel with no such
  // dependency — its own doc comment: "derives a closure's kind directly
  // from its raw AST... so it can run BEFORE the closure itself compiles" —
  // reused here (not re-derived) for exactly the case it names. An empty
  // capturedKinds map is correct: the one shape this slice targets narrows
  // its own param via a same-tail typeof guard (crkBranchRefine), which
  // needs no external seeding.
  const closureCalleeKind = node =>
    Array.isArray(node) && node[0] === '()' && typeof node[1] === 'string' && localClosures.has(node[1])
      ? closureBodyReturnKind(localClosures.get(node[1]).body, EMPTY_KIND_MAP)
      : null

  const semanticJoinArm = node => {
    if (boundary.covered === true && typeof node === 'string') {
      const k = params.get(node)
      const observed = k == null ? null : boundary.params[k]?.observed
      if (observed != null && semanticObserved(observed) && semanticClosed(observed)) return observed
    }
    return semanticOf(node)
  }

  const semanticOf = node => {
    if (typeof node === 'number') return semKind(VAL.NUMBER)
    if (node == null) return packSemantic(0, true, true)
    if (typeof node === 'string') {
      if (semanticNames.has(node)) return semanticNames.get(node)
      if (provenance?.globals.has(node)) {
        const rep = provenance.globalReps.get(node) ?? ANY_BIGINT
        return bigintRepIsClosed(rep) && bigintRepBits(rep) !== BIGINT_REP_TOP ? semKind(VAL.BIGINT) : semAll()
      }
      if (provenance && !taintedNames?.has(node)) return noBigintSemantic()
      if (defs.has(node)) return semBottom()
      return semanticFromRep(localReps?.get(node))
    }
    if (!Array.isArray(node)) return semAll()
    const cached = nodeSemantic.get(node)
    if (cached) return cached
    let out
    // Join structure is precise even when provenance says neither arm can
    // carry BigInt. Preserve its actual kind/nullish union instead of falling
    // to noBigintSemantic's coarse all-kinds set (whose synthetic BOOL member
    // vetoes an enclosing BigInt join).
    if (nullishArm(node)) out = packSemantic(0, true, true)
    else if (node[0] === ',') out = semanticOf(node[node.length - 1])
    else if (node[0] === '=') out = semanticOf(node[2])
    else if (node[0] === '?:') out = joinSem(semanticJoinArm(node[2]), semanticJoinArm(node[3]))
    else if (node[0] === '&&' || node[0] === '||' || node[0] === '??')
      out = joinSem(semanticJoinArm(node[1]), semanticJoinArm(node[2]))
    else if (!mayCarryBigint(node)) {
      const vt = valTypeOf(node) ?? closureCalleeKind(node)
      out = vt ? semKind(vt) : noBigintSemantic()
    }
    else if (isBigintOrigin(node)) out = semKind(VAL.BIGINT)
    else if (node[0] === '()' && typeof node[1] === 'string' &&
             (node[1] === 'BigInt' || node[1].startsWith('BigInt.')))
      out = semKind(VAL.BIGINT)
    else if (node[0] === '()' && calleeNameOf(node) && directCallBoundary(ctx, calleeNameOf(node))) {
      // Same callee-before-caller upgrade currentOf/plannedOf already apply
      // (below, and see plannedOf's own comment): the BOUNDARY's semantic is
      // a coarse, PRE-BODY guess; once the callee's BODY has settled, its
      // OWN resultSemantic (stored on the body record right alongside
      // resultTarget) is the precise, PROVEN semantic every one of its
      // return edges already normalizes to. Without this, a join whose one
      // arm is this call node could never prove `definiteBigint` even when
      // the callee's body plainly does (watr's real i64.parse, a proven-RAW
      // typed-array storage read) — targetRepFor's OWN gate requires
      // definiteBigint before it will ever trust `current`, so a
      // still-coarse boundary semantic forced the BOXED default onto a join
      // whose value is a single, closed, proven carrier.
      const calleeName = calleeNameOf(node)
      const callee = ctx.funcs.map.get(calleeName)
      const calleeHandle = callee && ctx.plans.representations.get(callee)
      const calleeBody = calleeHandle && ctx.plans.representationData.get(calleeHandle)?.body
      out = calleeBody?.materializedResult === true
        ? calleeBody.resultSemantic ?? directCallBoundary(ctx, calleeName).result.semantic
        : directCallBoundary(ctx, calleeName).result.semantic
    }
    else if (NUMERIC_VALUE_OPS.has(node[0])) {
      const operands = node.slice(1).filter(x => x !== undefined).map(semanticOf)
      const anyBig = operands.some(canBeBigint)
      const allBig = operands.length > 0 && operands.every(definiteBigint)
      // A self-referential def is BOTTOM on the first widening round. Do not
      // manufacture a Number member from that temporary lack of evidence;
      // the next round will classify it from the other concrete defs.
      if (operands.some(x => !semanticObserved(x))) out = semBottom()
      else if (allBig) out = semKind(VAL.BIGINT)
      else if (anyBig) out = packSemantic(
        BIGINT_KIND_BIT | bitOfKind(VAL.NUMBER),
        operands.every(x => semanticClosed(x)),
        false,
      )
      else out = semKind(VAL.NUMBER)
    } else if (NON_BIGINT_OPS.has(node[0])) {
      const vt = valTypeOf(node)
      out = semKind(vt || (node[0] === 'typeof' ? VAL.STRING : VAL.BOOL))
    } else {
      const census = censusMaybeUndefinedKind(node)
      const vt = valTypeOf(node) ?? closureCalleeKind(node)
      if (census) out = semKind(census, true)
      else if (vt) out = semKind(vt)
      else out = semAll()
    }
    nodeSemantic.set(node, out)
    return out
  }

  // Semantic binding fixpoint. Definitions are body-local and joins widen;
  // recursive cycles with no seed remain BOTTOM and are opened after settle.
  let semanticChanged = true
  while (semanticChanged) {
    semanticChanged = false
    for (const [name, list] of defs) {
      let next = params.has(name) ? semanticNames.get(name) : semBottom()
      for (const def of list) {
        const value = def[DEF_RHS] == null
          ? packSemantic(0, true, true)
          : semanticOf(def[DEF_RHS])
        next = joinSem(next, value)
      }
      const prev = semanticNames.get(name) || semBottom()
      if (!sameSem(prev, next)) { semanticNames.set(name, next); semanticChanged = true }
    }
    if (semanticChanged) nodeSemantic.clear()
  }
  for (const name of defs.keys()) {
    const sem = semanticNames.get(name)
    if (!semanticObserved(sem)) semanticNames.set(name, semanticFromRep(localReps?.get(name)))
  }
  nodeSemantic.clear()

  // Closure-forwarding slice (.work/archive/phase-c-unification.md §C4b queue): a
  // call to a SAME-BODY local closure whose callee has a return tail that's
  // the bare forwarded param (paramForwardsToReturn), fed here by an
  // argument that isn't itself provably bigint-free. The value flowing back
  // is EITHER the closure's own fresh (raw) computation on some OTHER tail
  // OR this argument's own carrier forwarded unchanged — when the argument
  // may itself be a host-tag-ingress box (C4b: paramNeedsHostTag's own
  // closure-forwarding case, below, is what granted it that evidence in the
  // first place), the ordinary unresolved-call default just below (assume
  // RAW) would misread a forwarded box's pointer bits as a raw i64 payload —
  // the exact silent-wrong this slice exists to close (see the pin's own
  // comment, test/inference.js: `f(5n)` → box bits + 1n). BOXED is the
  // ADR-0001 default for an edge the plan cannot prove single-representation
  // end-to-end. Paired with the closure's OWN return-edge materialization
  // (closureAbiIdentity's relaxed covered gate, below) — that side boxes the
  // SAME tail for the identical reason (the callee's own x is
  // closureBoxParams-tagged whenever its ingress is ambiguous), so caller
  // and callee agree by construction: not a guess replicated on both sides,
  // but the one condition (a forwarded, non-excluded argument reaching a
  // passthrough tail) that both queries ask independently of each other.
  // Literal/provably-raw arguments (`parse(3)`) never reach this — their
  // OWN currentOf is excludesBigint-short-circuited to NO_BIGINT — so a
  // closure with no ambiguous callers keeps the ordinary RAW default
  // (unaffected; see e.g. a pure `(x) => BigInt(x) * 2n` fresh-conversion
  // closure, which has NO passthrough tail at all and never matches here).
  const closureCallNeedsBox = node => {
    if (node[0] !== '()' || typeof node[1] !== 'string') return false
    const callee = localClosures.get(node[1])
    if (!callee) return false
    const args = commaList(node[2])
    for (let k = 0; k < args.length && k < callee.params.length; k++) {
      if (typeof args[k] !== 'string') continue
      if (!paramForwardsToReturn(callee.body, callee.params[k])) continue
      if (bigintRepBits(currentOf(args[k])) !== BIGINT_REP_NONE) return true
    }
    return false
  }

  const currentOf = node => {
    const sem = semanticOf(node)
    if (excludesBigint(sem)) return NO_BIGINT
    if (typeof node === 'string') return currentNames.get(node) ?? provenance?.globalReps.get(node) ?? ANY_BIGINT
    if (!Array.isArray(node)) return ANY_BIGINT
    const cached = nodeCurrent.get(node)
    if (cached != null) return cached
    let out
    if (isBigintOrigin(node)) out = RAW_BIGINT
    else if (node[0] === '()' && calleeNameOf(node) && directCallBoundary(ctx, calleeNameOf(node))) {
      // Shape #7 (encode.i64's own real watr shape): the BOUNDARY's current
      // is the coarse, pre-body fact (open/ambiguous whenever the callee's
      // own return sites disagree on raw-vs-boxed by construction, e.g.
      // i64.parse's own multi-branch numeric-string parser) — but once the
      // callee's BODY has settled, its OWN materializedResult/resultTarget
      // is the precise, PROVEN single carrier every one of its return edges
      // already normalizes to (ground truth, not a guess). emittedCandidate
      // (below) already prefers this fact for join/materializedNames
      // propagation; currentOf lagged behind it for the identical reason —
      // a callee whose result is definitely one carrier, reached from a
      // caller whose OWN call-argument evidence doesn't otherwise resolve
      // the ambiguity, never got to use it. Same callee-before-caller
      // ordering guarantee (analyzeFuncs completes every function's body
      // before any caller's own buildBodyData runs) that emittedCandidate's
      // own comment already documents; falls open to the boundary's current
      // exactly like emittedCandidate does when the body isn't there yet.
      const calleeName = calleeNameOf(node)
      const callee = ctx.funcs.map.get(calleeName)
      const calleeHandle = callee && ctx.plans.representations.get(callee)
      const calleeBody = calleeHandle && ctx.plans.representationData.get(calleeHandle)?.body
      out = calleeBody?.materializedResult === true
        ? calleeBody.resultTarget ?? ANY_BIGINT
        : directCallBoundary(ctx, calleeName).result.current
    }
    else if (node[0] === ',') out = currentOf(node[node.length - 1])
    else if (node[0] === '=') out = currentOf(node[2])
    else {
      const recv = memberReceiver(node)
      const cm = callMember(node)
      if (recv != null) {
        const rv = valTypeOf(recv)
        if (rv === VAL.TYPED) out = RAW_BIGINT
        else if (node[0] === '.' && typeof recv === 'string' && typeof node[2] === 'string' &&
                 ctx.schema.slotBigintProvenAt?.(recv, node[2])) out = RAW_BIGINT
        else out = BOXED_BIGINT
      // Shape #6 layer 1: every STORAGE_READ_METHODS call (get/pop/shift/at),
      // not just 'get' — exprRep (solveBigintProvenance, above) already
      // recognizes the full set; this local carrier proof lagged behind it.
      } else if (cm && STORAGE_READ_METHODS.has(cm[2])) out = BOXED_BIGINT
      else if (node[0] === '?:') {
        const a = node[2], b = node[3]
        if ((valTypeOf(a) === VAL.BIGINT && nullishArm(b)) || (valTypeOf(b) === VAL.BIGINT && nullishArm(a)))
          out = BOXED_BIGINT
        else out = joinRep(currentOf(a), currentOf(b))
      } else if (node[0] === '&&' || node[0] === '||' || node[0] === '??')
        out = joinRep(currentOf(node[1]), currentOf(node[2]))
      else if (closureCallNeedsBox(node)) out = BOXED_BIGINT
      else if (NUMERIC_VALUE_OPS.has(node[0]) && canBeBigint(sem)) out = RAW_BIGINT
      else if (definiteBigint(sem)) out = RAW_BIGINT
      else out = ANY_BIGINT
    }
    nodeCurrent.set(node, out)
    return out
  }

  let representationChanged = true
  while (representationChanged) {
    representationChanged = false
    nodeCurrent.clear()
    for (const [name, list] of defs) {
      let out = params.has(name) ? (currentNames.get(name) ?? ANY_BIGINT) : null
      for (const def of list) {
        const next = def[DEF_RHS] == null ? NO_BIGINT : currentOf(def[DEF_RHS])
        out = out == null ? next : joinRep(out, next)
      }
      out ??= ANY_BIGINT
      if (currentNames.get(name) !== out) { currentNames.set(name, out); representationChanged = true }
    }
  }
  nodeCurrent.clear()
  for (const [name, sem] of semanticNames)
    targetNames.set(name, targetRepFor(sem, currentNames.get(name) ?? ANY_BIGINT))

  const addEdge = (kind, source, target, _detail, host = false) => {
    const action = edgeAction(source, target, host)
    if (action === REP_EDGE_REJECT) programPlanRecord(ctx).rejects++
    // KEEP is the default edge equation and needs no retained record. Canonical
    // storage contains only an actual normalization or unresolved obligation.
    if (action !== REP_EDGE_KEEP) edges.push(EDGE_KIND[kind], source, target, action)
    return action
  }

  const plannedSeen = new WeakSet()
  const plannedOf = node => {
    const sem = semanticOf(node)
    if (excludesBigint(sem)) return NO_BIGINT
    if (typeof node === 'string') return targetNames.get(node) ?? provenance?.globalReps.get(node) ?? ANY_BIGINT
    if (!Array.isArray(node)) return ANY_BIGINT
    const cached = nodeTarget.get(node)
    if (cached != null) return cached
    let target, normalizedElsewhere = false
    if (node[0] === '()' && calleeNameOf(node) && directCallBoundary(ctx, calleeNameOf(node))) {
      // Same callee-before-caller upgrade currentOf's own Shape #7 comment
      // already documents and applies (above): the BOUNDARY's target is a
      // coarse, PRE-BODY guess (targetRepFor defaults to BOXED whenever the
      // boundary can't yet prove a closed-RAW current) — once the callee's
      // BODY has settled, its OWN materializedResult/resultTarget is the
      // precise, PROVEN single carrier every one of its return edges already
      // normalizes to. plannedOf lacked this upgrade even for a bare-name
      // callee before this fix (a pre-existing asymmetry with currentOf,
      // not introduced by `.`-member resolution) — found live via a
      // `.`-member callee whose body IS a proven-RAW typed-array storage
      // read (watr's real i64.parse) but whose boundary alone can't prove
      // it: a ternary joining this callee's call against a plain closed-RAW
      // global literal boxed ONLY the callee arm, corrupting the join (the
      // callee arm's stale BOXED target disagreed with its own settled RAW
      // body, and nothing coerced the mismatch away since
      // `normalizedElsewhere` skips the ordinary result-edge check).
      const calleeName = calleeNameOf(node)
      const callee = ctx.funcs.map.get(calleeName)
      const calleeHandle = callee && ctx.plans.representations.get(callee)
      const calleeBody = calleeHandle && ctx.plans.representationData.get(calleeHandle)?.body
      target = calleeBody?.materializedResult === true
        ? calleeBody.resultTarget ?? ANY_BIGINT
        : directCallBoundary(ctx, calleeName).result.target
      normalizedElsewhere = true // the callee's return edges own this transition
    } else {
      const recv = memberReceiver(node)
      const cm = callMember(node)
      if (recv != null) {
        target = valTypeOf(recv) === VAL.TYPED ? RAW_BIGINT :
          (node[0] === '.' && typeof recv === 'string' && typeof node[2] === 'string' &&
           ctx.schema.slotBigintProvenAt?.(recv, node[2]) ? RAW_BIGINT : BOXED_BIGINT)
        normalizedElsewhere = true // storage's write edge owns the carrier
      // Shape #6 layer 1 (mirrors currentOf's identical fix above): the full
      // STORAGE_READ_METHODS set, not just 'get'.
      } else if (cm && STORAGE_READ_METHODS.has(cm[2])) {
        target = BOXED_BIGINT
        normalizedElsewhere = true
      } else target = targetRepFor(sem, currentOf(node))
    }
    nodeTarget.set(node, target)
    if (!plannedSeen.has(node)) {
      plannedSeen.add(node)
      if (node[0] === '?:') {
        addEdge('join-arm', plannedOf(node[2]), target, node)
        addEdge('join-arm', plannedOf(node[3]), target, node)
      } else if (node[0] === '&&' || node[0] === '||' || node[0] === '??') {
        addEdge('join-arm', plannedOf(node[1]), target, node)
        addEdge('join-arm', plannedOf(node[2]), target, node)
      } else {
        const current = currentOf(node)
        if (!normalizedElsewhere && current !== target) addEdge('result', current, target, node)
      }
    }
    return target
  }

  const resultExprs = !Array.isArray(body) || body[0] !== '{}' ? [body] : returnExprs(body)
  let bodyResultSemantic = semBottom(), bodyResultCurrent = null
  for (const expr of resultExprs) if (expr != null) {
    bodyResultSemantic = joinSem(bodyResultSemantic, semanticOf(expr))
    const rep = currentOf(expr)
    bodyResultCurrent = bodyResultCurrent == null ? rep : joinRep(bodyResultCurrent, rep)
  }
  if (!semanticObserved(bodyResultSemantic) || definiteBigint(boundary.result.semantic))
    bodyResultSemantic = boundary.result.semantic
  bodyResultCurrent ??= boundary.result.current
  const bodyResultTarget = (options.forceTaggedResult || boundary.result.forceTagged) && canBeBigint(bodyResultSemantic)
    ? BOXED_BIGINT : targetRepFor(bodyResultSemantic, bodyResultCurrent)

  const walkEdges = (node, root = false) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (Array.isArray(op)) { for (let i = 0; i < node.length; i++) walkEdges(node[i]); return }
    if (!root && op === '=>') return
    if (op === '?:' || op === '&&' || op === '||' || op === '??') plannedOf(node)
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string')
          addEdge('binding-write', plannedOf(decl[2]), targetNames.get(decl[1]) ?? ANY_BIGINT, decl)
      }
    } else if (ASSIGN_OPS.has(op)) {
      if (typeof node[1] === 'string') {
        const source = op === '=' || CONDITIONAL_ASSIGN_OPS.has(op) ? node[2] : node
        addEdge('binding-write', plannedOf(source), targetNames.get(node[1]) ?? ANY_BIGINT, node)
      } else if (Array.isArray(node[1]) && (node[1][0] === '[]' || node[1][0] === '.')) {
        const rv = valTypeOf(node[1][1])
        addEdge('storage-write', plannedOf(node[2]), rv === VAL.TYPED ? RAW_BIGINT : BOXED_BIGINT, node)
      }
    } else if (op === 'return' && node[1] != null) {
      addEdge('return', plannedOf(node[1]), bodyResultTarget, node)
    } else if (op === '()') {
      const args = commaList(node[2])
      const calleeName = calleeNameOf(node)
      if (calleeName) {
        const callee = directCallBoundary(ctx, calleeName)
        if (callee) {
          for (let i = 0; i < args.length && i < callee.params.length; i++)
            addEdge('call-arg', plannedOf(args[i]), callee.params[i].target, node)
        }
      } else {
        // Generic closure/call_indirect slots are tagged-value positions.
        for (const arg of args) addEdge('closure-arg', plannedOf(arg), BOXED_BIGINT, node)
      }
      const cm = callMember(node)
      if (cm && (cm[2] === 'set' || cm[2] === 'add' || cm[2] === 'push' || cm[2] === 'unshift')) {
        const start = cm[2] === 'set' ? 1 : 0
        for (let i = start; i < args.length; i++) addEdge('storage-write', plannedOf(args[i]), BOXED_BIGINT, node)
      }
    }
    for (let i = 1; i < node.length; i++) walkEdges(node[i])
  }
  walkEdges(body, true)

  // Expression-bodied functions have no explicit return node.
  if (!Array.isArray(body) || body[0] !== '{}')
    addEdge('return', plannedOf(body), bodyResultTarget, body)
  else {
    // Force all return expressions through plannedOf even when a transformed
    // body shape kept the return outside walkEdges' ordinary statement walk.
    for (const expr of returnExprs(body)) plannedOf(expr)
  }

  // Shape #6 layers 2+3: a storage READ always crosses the storage boundary
  // already boxed — the write side boxes unconditionally via
  // taggedStoredValue, a physical fact of the wire format, not a plan
  // decision — so a BOXED→BOXED edge sourced from one is ready BY
  // CONSTRUCTION, independent of whether any OTHER producer for this name
  // has materialized. Layer 2 is the STORAGE_READ_METHODS call shape
  // (`.get/.pop/.shift/.at`, currentOf/plannedOf's `cm` branch above); layer
  // 3 is the plain `[]`/`.member` read (currentOf/plannedOf's `recv` branch)
  // — both producers, same physical guarantee, one predicate.
  //
  // NARROWED to a genuinely storage-TRACKED receiver (regression found live,
  // FULL suite: array-destructure's `let [a, b] = [1, BigInt(v)]` desugars
  // to `let d0 = [1, BigInt(v)]; let a = d0[0]; let b = d0[1]` — `d0[1]` IS
  // a `[]` member read, but `d0` is an ARRAY-LITERAL temp, never `.push`/
  // `.set`-mutated, so the "write side always boxes" physical guarantee this
  // predicate exists to name was never actually established for it — a
  // literal's own construction path is free to choose a different internal
  // layout (unboxed, when every element's kind is statically known) with no
  // obligation to box uniformly. `provenance.storage`/`.bigintTyped` (this
  // file's own solveBigintProvenance, already the authority exprMay's
  // identical STORAGE_READ_METHODS/`[]` branches consult) is the precise,
  // already-computed signal for "this receiver is real, mutation-tracked
  // storage" — reusing it here closes the gap with no new analysis.
  const isStorageReadProducer = node => {
    if (!Array.isArray(node)) return false
    const isTrackedStorage = recv => typeof recv === 'string' &&
      ((localStorage && localStorage.has(recv)) || (provenance && provenance.storage.has(recv)) ||
       (provenance && provenance.bigintTyped.has(recv)))
    const recv = memberReceiver(node)
    if (recv != null) return isTrackedStorage(recv)
    const cm = callMember(node)
    return !!cm && STORAGE_READ_METHODS.has(cm[2]) && isTrackedStorage(cm[1])
  }

  // Generic closures and named function values enter through the uniform
  // boxed-value ABI. Treat a tagged-target param as a candidate before the
  // binding fixpoint, then publish closureBoxParams only if the stable entry or
  // complete body-def set proves every write normalizable. No candidate alone
  // becomes a representation fact.
  const closureBoxParams = new Set()
  // Boundaries are uncovered only for generic closures, exports, or named
  // functions used through the first-class value ABI. At body-plan time the
  // source-name address-taken Set is no longer carried, so recover the third case
  // from the frozen boundary plus the two exclusions.
  const valueAbiIdentity = boundary.covered === false && !options.generic && !isExported(ctx, identity)
  const valueAbiParamCandidates = new Set()
  if (options.generic || valueAbiIdentity) for (const [name, k] of params) {
    const sem = semanticNames.get(name) ?? semAll()
    if (targetNames.get(name) === BOXED_BIGINT && !hasClosedBool(sem))
      valueAbiParamCandidates.add(k)
  }

  const materializedNames = new Set()
  const exportedIdentity = isExported(ctx, identity)
  for (const [name, list] of defs) {
    if (ctx.scope.globals?.has(name)) continue
    const paramIndex = params.get(name)
    if (paramIndex != null && boundary.covered !== true && !exportedIdentity && !valueAbiParamCandidates.has(paramIndex)) continue
    // RepresentationPlan only normalizes the BigInt member. A BOOL member in
    // an ordinary dynamic scalar still needs the separate BOOL-atom producer.
    // A storage read is different: it is already fully tagged for every kind,
    // and a following numeric compound update throws before writing on a
    // non-numeric member, so materializing BigInt cannot erase BOOL identity.
    const nameSemantic = semanticNames.get(name) ?? semAll()
    let hasStorageSeed = false, identitySafeStorageFlow = true
    for (const def of list) {
      if (def[DEF_RHS] == null) continue
      if (isStorageReadProducer(def[DEF_RHS])) { hasStorageSeed = true; continue }
      if (!NUMERIC_VALUE_OPS.has(def[DEF_OWNER] && def[DEF_OWNER][0])) { identitySafeStorageFlow = false; break }
    }
    identitySafeStorageFlow = identitySafeStorageFlow && hasStorageSeed
    if (hasClosedBool(nameSemantic) && !identitySafeStorageFlow) continue
    const target = targetNames.get(name) ?? ANY_BIGINT
    const ready = list.every(def => {
      if (def[DEF_RHS] == null) return true
      // Shape #6 layer 4: a compound-assignment def (`n >>= 7n`) is a valid
      // ready shape too, not just plain '=' and the conditional compounds —
      // NUMERIC_VALUE_OPS already covers the full arithmetic/bitwise compound
      // family (+=, -=, ..., >>=, ++, --) and currentOf already resolves
      // their BigInt-ness correctly (the RAW-result NUMERIC_VALUE_OPS branch,
      // above); only this readiness gate lagged behind. ++/-- now consult the
      // dedicated representationUnaryUpdateAction when local valTypeOf cannot
      // see a covered param's whole-program proof.
      const ownerOp = def[DEF_OWNER] && def[DEF_OWNER][0]
      if (ownerOp !== '=' && !CONDITIONAL_ASSIGN_OPS.has(ownerOp) && !NUMERIC_VALUE_OPS.has(ownerOp)) return false
      // Readiness is about the carrier the emitter produces before this
      // binding-write edge, not the expression's eventual planned target.
      // A fresh BigInt computation can target BOXED while still emitting raw
      // i64 bits; this edge is precisely where that RAW→BOX transition lives.
      // Shape #6 layers 2+3: a storage-read producer boxes on the wire by
      // physical construction (taggedStoredValue) — sourceReady lets a
      // BOXED→BOXED KEEP through without waiting on some OTHER producer's
      // own materialization to prove the same physical fact twice.
      return edgeMaterializable(currentOf(def[DEF_RHS]), target, def[DEF_RHS], isStorageReadProducer(def[DEF_RHS]))
    })
    if (ready) materializedNames.add(name)
  }

  const hostBoxParams = new Set()
  if (exportedIdentity) for (const [name, k] of params) {
    const sem = semanticNames.get(name) ?? semAll()
    const ready = boundary.params[k]?.stable === true || materializedNames.has(name)
    if (ready && targetNames.get(name) === BOXED_BIGINT && !hasClosedBool(sem))
      hostBoxParams.add(k)
  }
  const closureAbiIdentity = options.generic || valueAbiIdentity
  if (closureAbiIdentity) for (const [name, k] of params) {
    const sem = semanticNames.get(name) ?? semAll()
    const ready = boundary.params[k]?.stable === true || materializedNames.has(name)
    if (ready && targetNames.get(name) === BOXED_BIGINT && !hasClosedBool(sem))
      closureBoxParams.add(k)
  }

  const materializedJoins = new WeakSet()
  const emittedCandidate = node => {
    if (typeof node === 'string') {
      if (materializedNames.has(node)) return { rep: targetNames.get(node) ?? ANY_BIGINT, ready: true }
      const k = params.get(node)
      if (k != null) {
        // Closure-forwarding slice: a param's boundary-level readiness is
        // `covered && stable` for an ordinary (named-function) boundary, but
        // a closure's boundary is ALWAYS `uncovered` (buildBodyData's own
        // `generic ⟹ uncovered` — the ABI is call_indirect-shaped regardless
        // of how many call sites are actually enumerable) — hostBoxParams/
        // closureBoxParams ARE that boundary's own readiness signal (the
        // SAME "boundaryReady" concept representationActiveMaterializedRep
        // already reads, just not yet threaded through this join/result
        // fixpoint), so a stable param the export/closure ingress already
        // proved tag-required is exactly as trustworthy as a covered+stable
        // one — same fact, different boundary shape.
        const boundaryReady = hostBoxParams.has(k) || closureBoxParams.has(k)
        if ((boundary.covered === true && boundary.params[k]?.stable === true) || boundaryReady)
          return { rep: targetNames.get(node) ?? ANY_BIGINT, ready: true }
      }
    }
    if (Array.isArray(node)) {
      if (materializedJoins.has(node)) return { rep: nodeTarget.get(node) ?? ANY_BIGINT, ready: true }
      if (node[0] === '()') {
        const calleeName = calleeNameOf(node)
        if (calleeName) {
          const callee = ctx.funcs.map.get(calleeName)
          const calleeHandle = callee && ctx.plans.representations.get(callee)
          const calleeBody = calleeHandle && ctx.plans.representationData.get(calleeHandle)?.body
          if (calleeBody?.materializedResult === true)
            return { rep: calleeBody.resultTarget ?? ANY_BIGINT, ready: true }
        }
        // Closure-forwarding slice: a same-body local closure's plan doesn't
        // exist yet at THIS body's build time (closures compile at module
        // end, after their callers — the ctx.funcs.map lookup above always
        // misses), so closureCallNeedsBox's own structural proof (a
        // passthrough tail fed a non-excluded argument) stands in for the
        // callee-plan lookup this branch ordinarily uses. Bare-name only by
        // construction (its own internal gate): a local closure is never
        // reachable through a `.`-member call, using program-index.js's own
        // property-write census never descends into any function body, so a
        // closure assigned to a property from inside one is never indexed.
        if (closureCallNeedsBox(node)) return { rep: BOXED_BIGINT, ready: true }
      }
    }
    return { rep: currentOf(node), ready: false }
  }
  // A join's own position — direct result expression, named-local RHS, or
  // any other operand — is irrelevant to whether it materializes: the plan
  // owns the join's carrier independent of where its value flows next (the
  // return/binding-write EDGE consumes whatever this fixpoint decides, it
  // does not gate it). Admitting resultExprs here is what lets a direct
  // `export let g = (flag) => flag ? 1n : 0` materialize the same way a
  // named-local `let value = flag ? 1n : 0; return value` already does.
  let joinChanged = true
  while (joinChanged) {
    joinChanged = false
    for (const [node, target] of nodeTarget) {
      if (materializedJoins.has(node) || !JOIN_OPS.has(node[0]) || target !== BOXED_BIGINT) continue
      const sem = semanticOf(node)
      if (hasClosedBool(sem)) continue
      const [armA, armB] = joinArms(node)
      const left = emittedCandidate(armA), right = emittedCandidate(armB)
      if (edgeMaterializable(left.rep, target, armA, left.ready) &&
          edgeMaterializable(right.rep, target, armB, right.ready)) {
        materializedJoins.add(node)
        joinChanged = true
      }
    }
  }

  // Census-shaped unary '-'/'~' and joint-binary result nodes. Reuses the
  // SAME `materializedJoins` set as the JOIN_OPS
  // fixpoint above — every consumer (emittedCandidate, materializedNames'
  // propagation pass, materializedResult, representationResultTagRequired's
  // exprMayBox below) already asks that one Set, so admitting a new node
  // shape into it is the whole wiring; no new consumer-side plumbing. NOT a
  // fixpoint (single pass, no `while`, unlike JOIN_OPS above): a JOIN_OPS
  // node's arms can be ARBITRARY sub-expressions (a name, a call, another
  // join) whose OWN readiness may only settle on a later round — but
  // bigIntUnary/bigIntJointDispatch (emit.js) always compute their "real
  // bigint" branch fresh from the operand's raw i64 bits, unconditionally,
  // regardless of any OTHER binding's materialization state. The only
  // precondition is the node's OWN target being BOXED_BIGINT (already
  // computed above by plannedOf's generic branch) — no arm-by-arm proof, so
  // no iteration is needed.
  for (const [node, target] of nodeTarget) {
    if (materializedJoins.has(node) || target !== BOXED_BIGINT) continue
    const op = node[0]
    const sentinelUnary = (op === 'u-' || op === '~') && censusMaybeUndefinedKind(node[1]) === VAL.BIGINT
    const sentinelJoint = BIGINT_JOINT_BINARY_OPS.has(op) &&
      censusMaybeUndefinedKind(node[1]) === VAL.BIGINT && censusMaybeUndefinedKind(node[2]) === VAL.BIGINT
    if (!sentinelUnary && !sentinelJoint) continue
    const sem = semanticOf(node)
    if (hasClosedBool(sem)) continue
    materializedJoins.add(node)
  }

  // Propagate newly-materialized ternaries — and, closure-forwarding slice,
  // closureCallNeedsBox-proven closure calls (`let a = parse(v)`) — through
  // their immediate plain-write binding edges. Other producer dependencies
  // stay deferred to their own slices; this pass cannot accidentally admit
  // an unrelated raw expression. emittedCandidate already resolves BOTH
  // proofs to `ready: true`, so one shared gate/body covers both — the gate
  // only widens which defs are worth re-checking, the check itself is
  // unchanged.
  for (const [name, list] of defs) {
    if (materializedNames.has(name) || ctx.scope.globals?.has(name)) continue
    if (params.has(name) && boundary.covered !== true) continue
    if (!list.some(def => Array.isArray(def[DEF_RHS]) && (materializedJoins.has(def[DEF_RHS]) || closureCallNeedsBox(def[DEF_RHS])))) continue
    const nameSemantic = semanticNames.get(name) ?? semAll()
    if (hasClosedBool(nameSemantic)) continue
    const target = targetNames.get(name) ?? ANY_BIGINT
    if (list.every(def => {
      if (def[DEF_RHS] == null) return true
      if (def[DEF_OWNER]?.[0] !== '=' && !CONDITIONAL_ASSIGN_OPS.has(def[DEF_OWNER]?.[0])) return false
      const source = emittedCandidate(def[DEF_RHS])
      return edgeMaterializable(source.rep, target, def[DEF_RHS], source.ready)
    })) materializedNames.add(name)
  }

  const resultHasClosedBool = hasClosedBool(bodyResultSemantic)
  // Closure-forwarding slice: a closure's boundary is ALWAYS uncovered
  // (options.generic forces it, independent of how enumerable its call sites
  // actually are — see the emittedCandidate param-branch comment above), so
  // `covered` alone would keep materializedResult permanently unreachable
  // for every closure. closureAbiIdentity ALONE is too broad an admission,
  // though (found live: array-methods.js's `.map(x => { return x + 1n })`
  // BigInt64Array callback) — `.map()`'s own internal call site has a FIXED,
  // unboxed calling convention baked into $__typed_set_idx (the callback's
  // return is stored as the raw target-array element, never a box; that
  // codegen is generic-array-method machinery, plan-blind, and unrelated to
  // representation-plan entirely), so boxing a result on the strength of the
  // ordinary "mixed-semantic result → BOXED" default (targetRepFor's own
  // fallback — x's OWN param provenance is unproven here, so `x + 1n`'s
  // semantic reads {number, bigint} mixed, same shape ANY export boundary
  // would legitimately box) corrupts that store. The closure-forwarding
  // slice's own proof is narrower and is exactly what distinguishes the two:
  // closureBoxParams is non-empty only when SOME param carries genuine,
  // plan-proven tag-required evidence (paramNeedsHostTag's closure-
  // forwarding case, or any other closureBoxParams producer) — requiring
  // that here scopes the admission to closures this slice actually reasons
  // about, leaving a closure with no tag-required param (the .map callback:
  // x's own boundary semantic excludes bigint entirely, closureBoxParams
  // stays empty) on its pre-existing REJECT path, unchanged.
  //
  // Shape #7: a SECOND, independent producer of genuine evidence —
  // closureBoxParams only ever looks at the closure's OWN params, but a
  // closure can be pure forwarding (`(nodes) => leb(nodes.shift())`, watr's
  // dispatch-table entry) whose bigint-ness comes entirely from its RETURN,
  // through a call to an ordinary named function, never touching a
  // param at all. emittedCandidate's `ready: true` branches (a materialized
  // name, a materialized join, or a callee whose OWN materializedResult is
  // already proven — exactly this case, once leb's param provenance sees
  // through the closure that calls it, see solveBigintProvenance's
  // visitCallSites) are ground truth, not a guess — the SAME distinction
  // that already excludes the .map callback above: `x + 1n` is a bare binary
  // op, covered by none of emittedCandidate's proof branches, so it falls to
  // the unready `{rep: currentOf(node), ready: false}` default and this
  // clause stays false for it, unchanged. Additive only: closureBoxParams
  // keeps its own job for a genuinely param-sourced result.
  const resultForwardsProvenCallee = !!closureAbiIdentity && resultExprs.length > 0 &&
    resultExprs.every(expr => expr != null && emittedCandidate(expr).ready === true)
  const materializedResult = (boundary.covered === true || boundary.result.forceTagged === true ||
      (!!closureAbiIdentity && closureBoxParams.size > 0) || resultForwardsProvenCallee) &&
    !resultHasClosedBool &&
    sig?.results?.length === 1 && sig.results[0] === 'f64' &&
    resultExprs.every(expr => {
      if (expr == null) return true
      const source = emittedCandidate(expr)
      return edgeMaterializable(source.rep, bodyResultTarget, expr, source.ready)
    })

  // Compact canonical node facts into one primitive-valued Map. The three
  // temporary caches above are build-time solver state and do not remain
  // reachable from the published plan.
  const nodeFacts = new Map()
  for (const [node, target] of nodeTarget) {
    const semantic = semanticOf(node)
    if (!canBeBigint(semantic)) continue
    const current = currentOf(node)
    nodeFacts.set(node, target | (current << 3) | (semantic << 6))
  }
  const packedSemantics = new Map()
  const keptCurrent = new Map(), keptTarget = new Map()
  for (const [name, semantic] of semanticNames) {
    if (!canBeBigint(semantic)) continue
    packedSemantics.set(name, semantic)
    keptCurrent.set(name, currentNames.get(name) ?? ANY_BIGINT)
    keptTarget.set(name, targetNames.get(name) ?? ANY_BIGINT)
  }
  const trivial = packedSemantics.size === 0 && nodeFacts.size === 0 && edges.length === 0

  return trivial ? {
    kind: 'body', identity, boundary, trivial: true,
    semanticNames: null, currentNames: null, targetNames: null, nodeFacts: null,
    materializedNames: null, hostBoxParams: null, closureBoxParams: null,
    materializedJoins: null, materializedResult: false,
    resultSemantic: bodyResultSemantic, resultTarget: bodyResultTarget, edges,
  } : {
    kind: 'body', identity, boundary, trivial: false,
    semanticNames: packedSemantics,
    currentNames: keptCurrent,
    targetNames: keptTarget,
    nodeFacts,
    materializedNames,
    hostBoxParams,
    closureBoxParams,
    materializedJoins,
    materializedResult,
    resultSemantic: bodyResultSemantic,
    resultTarget: bodyResultTarget,
    edges,
  }
}

export function mintRepresentationPlan(ctx, identity, sig, body, localReps, options = {}) {
  const program = programPlanRecord(ctx)
  if (program?.bigint === false) return program.emptyHandle
  const prior = ctx.plans.representations.get(identity)
  if (prior && ctx.plans.representationData.get(prior)?.body)
    throw new Error(`RepresentationPlan already published for ${identity?.name || '<anonymous>'}`)
  const localProvenance = options.generic && program.provenance
    ? deriveLocalProvenance(sig, body, localReps, program.provenance)
    : null
  const planOptions = {
    ...options,
    provenance: program.provenance,
    localProvenance,
    localReps,
  }
  const handle = ensureBoundary(ctx, identity, sig, planOptions)
  const record = ctx.plans.representationData.get(handle)
  if (sig && typeof sig === 'object') {
    ctx.plans.representations.set(sig, handle)
    if (sig.params) ctx.plans.representations.set(sig.params, handle)
  }
  // Closure-forwarding slice: the ACTIVE lookup key every ctx.func.current-
  // implicit accessor uses (representationReturnAction, representation
  // ActiveMaterializedRep, …) is whatever `ctx.func.current` actually holds
  // at emission time — for an ordinary function that IS `sig` (the same
  // object passed in above, verified: `sig === ctx.func.current` here,
  // since analyzeFuncForEmit mints while its own frame is active). A
  // closure's uniform call_indirect ABI shape (`closureSig(cb)`, module/
  // function.js) is a SEPARATE object from `repSig` (this call's own `sig`,
  // built to describe the closure's REAL params for the plan) — `sig`'s own
  // registration above therefore never matches `ctx.func.current` for a
  // closure, and representationReturnAction/representationActiveMaterialized
  // Rep have silently missed on every closure's own body ever since
  // hostBoxParams/closureBoxParams existed (dormant: nothing ever made a
  // closure's OWN result or a closureBoxParams-tagged param's consumer path
  // reachable before this slice — the closure-forwarding pin is the first
  // shape that exercises it). enterPreparedFunction restores the identical
  // ctx.func frame object this mint call runs inside (function-plan.js:
  // publishPreparedFunctionPlan captures `ctx.func` itself as the working
  // frame), so `ctx.func.current` at THIS instant is the exact object
  // identity emission will see later too — the missing key, added once,
  // covers every accessor uniformly instead of patching each one.
  if (ctx.func.current && ctx.func.current !== sig) ctx.plans.representations.set(ctx.func.current, handle)
  record.body = buildBodyData(ctx, identity, sig, body, localReps, record.boundary, planOptions)
  if (DBG_INVARIANTS) assertRepresentationPlan(ctx, handle)
  return handle
}

/** Debug invariant: every non-reject action maps into the target's allowed set. */
function assertRepresentationPlan(ctx, plan) {
  const record = ctx.plans.representationData.get(plan)
  if (record?.programEmpty) return true
  const data = record?.body || record?.boundary
  if (!data) throw new Error('Invalid RepresentationPlan handle')
  for (let i = 0; i < data.edges.length; i += 4) {
    const kind = EDGE_KIND_NAME[data.edges[i]] || 'unknown'
    const source = data.edges[i + 1]
    const target = data.edges[i + 2]
    const action = data.edges[i + 3]
    if (!bigintRepIsClosed(target))
      throw new Error(`RepresentationPlan edge '${kind}' has an open target`)
    if (action === REP_EDGE_REJECT) continue
    const sourceBits = bigintRepBits(source)
    let outputBits = sourceBits
    if (action === REP_EDGE_BOX || action === REP_EDGE_HOST_BOX)
      outputBits = sourceBits === BIGINT_REP_NONE ? BIGINT_REP_NONE : BIGINT_REP_BOXED
    else if (action === REP_EDGE_UNBOX)
      outputBits = sourceBits === BIGINT_REP_NONE ? BIGINT_REP_NONE : BIGINT_REP_RAW
    if ((outputBits & ~bigintRepBits(target)) !== 0)
      throw new Error(`RepresentationPlan edge '${kind}' action ${action} violates target representation`)
  }
  return true
}
