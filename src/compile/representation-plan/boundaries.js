/**
 * BigInt ABI boundary producer. Every boundary publishes into ProgramIndex
 * numeric slots: named sources and specialization variants use the frozen ID
 * arrays; anonymous closure bodies and the synthetic start frame use the
 * append-only anonymous space. RepresentationPlan records carry body facts
 * only; no identity keeps a second boundary writer.
 */
import { isReassigned } from '../../ast.js'
import { VAL } from '../../reps.js'
import { K as SUMMARY_KIND, hasTag as summaryHasTag, tagOf as summaryTagOf, isNullable as summaryNullable, CARRIER } from '../../summary/index.js'
import {
  ANY_BIGINT, BIGINT_DEMAND_RAW_OK, BIGINT_DEMAND_TAG_REQUIRED, BOXED_BIGINT, EDGE_KIND, NO_BIGINT, RAW_BIGINT,
  REP_EDGE_REJECT, SEM_CLOSED_BIT, bitOfKind, canBeBigint, canBeOther, contractRep, edgeAction, excludesBigint,
  isExported, noBigintSemantic, onlyBigintKind, packSemantic, programPlanRecord, semAll, semKind, semanticClosed,
  semanticFromRep, semanticKinds, semanticNullish, targetRepFor,
} from './common.js'
import { solveBigintProvenance } from './provenance.js'

const boundaryParamSemantic = (rep, uncovered) => {
  const sem = semanticFromRep(rep, uncovered ? 'open' : null)
  return uncovered ? sem & ~SEM_CLOSED_BIT : sem
}

// A parameter's incoming carrier: the kind says BigInt or not, never which
// carrier the arguments arrive in (a literal is raw, a storage read a box);
// RAW only when every call site's argument is (provenance's paramRawOnly).
const currentParamRep = (rep, sem, uncovered, rawOnly) => {
  if (excludesBigint(sem)) return NO_BIGINT
  if (uncovered) return ANY_BIGINT
  if (onlyBigintKind(sem) && rawOnly) return RAW_BIGINT
  return ANY_BIGINT
}

// The result contract's claim in the plan's own lattice. A contract whose
// carrier is the raw or the boxed BigInt one claims a BigInt member: every
// completion a BigInt (RAW_I64, or BOXED beside a nullish one) is the closed
// BigInt semantic; a BigInt beside other kinds stays the open one, as before
// the contract (the plan's lattice takes the summary's bound in a later
// slice). An unbounded result that names no BigInt return claims nothing.
const contractClaimsBigint = c => c != null && (c.carrier === CARRIER.RAW_I64 || c.carrier === CARRIER.BOXED)
const contractSemantic = c => summaryTagOf(c.kind) === SUMMARY_KIND.BIGINT
  ? semKind(VAL.BIGINT, summaryNullable(c.kind))
  : semAll()

const makeNoBigintBoundary = (func, sig = func?.sig) => ({
  kind: 'boundary',
  func,
  params: (sig?.params || []).map(() => ({
    semantic: noBigintSemantic(),
    current: NO_BIGINT,
    target: NO_BIGINT,
    demand: BIGINT_DEMAND_RAW_OK,
  })),
  result: {
    semantic: noBigintSemantic(),
    claimed: NO_BIGINT,
    target: NO_BIGINT,
    demand: BIGINT_DEMAND_RAW_OK,
  },
  edges: [],
})

const demandFor = sem => canBeBigint(sem) && canBeOther(sem)
  ? BIGINT_DEMAND_TAG_REQUIRED
  : BIGINT_DEMAND_RAW_OK

const makeBoundaryData = (ctx, func, paramReps, options = {}) => {
  const generic = !!options.generic
  const indirectAbi = options.addressTaken?.has(func.name) === true
  const uncovered = generic || isExported(ctx, func) || indirectAbi
  const row = paramReps?.get(func.name)
  const params = (func.sig?.params || []).map((param, k) => {
    const rep = row?.get(k) || (generic ? options.localReps?.get(param.name) : null)
    const mayBigint = generic
      ? options.localProvenance?.params.has(k)
      : options.provenance?.paramsByFunc.get(func.name)?.has(k)
    const observed = rep ? semanticFromRep(rep) : semAll()
    // Shape #6 layer 5: a COVERED boundary's complete call-site enumeration
    // can PROVE a param's runtime domain is bigint-only even when the
    // legacy paramReps census (feeding `rep` above) can't narrow past "any
    // of the 14 kinds, closed" for a storage-read call argument — see
    // solveBigintProvenance's paramBigintOnly (this file). That proof is
    // strictly more precise than `rep` for this one purpose (the semantic
    // buildBodyData's materializedNames fixpoint plans against) since it is
    // derived from literally every real caller, not a per-function kind census.
    const bigintOnlyRow = options.provenance && options.provenance.paramBigintOnly
      ? options.provenance.paramBigintOnly.get(func.name) : null
    const provenBigintOnly = !generic && !uncovered && bigintOnlyRow != null && bigintOnlyRow.has(k)
    // Shape #7 (encode.i64's real watr shape, sibling to layer 5 above): a
    // param can be body-write bigint-provenant (a genuine typeof-guarded
    // string/number/bigint normalizer) while its call-site argument is a
    // storage read on an array that ISN'T bigint-pure (watr's `nodes` holds
    // parsed WAT syntax; the i64 immediate arrives as text and is BigInt()-
    // normalized inside the callee) — provenBigintOnly correctly declines
    // (the argument truly isn't closed-bigint), but the legacy census still
    // stamps the coarse closed-ALL-kinds answer, whose synthetic BOOL member
    // widens the semantic even though the value can never actually be a
    // JS boolean here (it comes from a storage read — self-tagged per
    // element at the wire). paramNeverBool proves the weaker, sufficient
    // fact: not kind-purity, only boolean-impossibility.
    const neverBoolRow = options.provenance && options.provenance.paramNeverBool
      ? options.provenance.paramNeverBool.get(func.name) : null
    const provenNeverBool = !generic && !uncovered && neverBoolRow != null && neverBoolRow.has(k)
    // `current` deliberately keeps deriving from the LEGACY (rep-based)
    // semantic even when provenBigintOnly overrides `semantic` itself —
    // regression found live (test/watr.js's uleb-loop pin): currentParamRep's
    // onlyBigintKind(sem) branch reads "kind-pure bigint" as license to
    // choose the RAW carrier over BOXED, an optimization that is only sound
    // once EVERY consumer downstream understands a plan-materialized RAW
    // param — not yet universally true across emit.js (found live: Number(n)
    // on such a param reinterpreted its raw i64 bits as an already-numeric
    // f64 — no int->float conversion, no unbox — silently wrong). Layer 5's
    // OWN job is narrower than "pick the optimal carrier": it exists to
    // supply buildBodyData a precise, informative kind set (`semantic`)
    // for a covered param the legacy census under-proves. `current`/`target`
    // staying on the legacy derivation preserves the exact BOXED default
    // this shape already used, correctly, before shape #6 touched anything.
    const legacySemantic = mayBigint ? (generic ? observed : boundaryParamSemantic(rep, uncovered)) : noBigintSemantic()
    // SECOND regression layer, same root class: even with `current` pinned
    // to the legacy derivation above, `target = targetRepFor(semantic,
    // current)` still reads `semantic` — and semKind's own `nullish=false`
    // default silently upgraded a genuinely-nullable param (uleb's own
    // `rep.nullable === true`, from the legacy census — this proof is
    // SILENT on nullability, never having claimed it either way) to
    // "definitely present", which flips targetRepFor's own definiteBigint
    // gate open and lets its RAW-preserving branch fire off of the
    // (nullish-blind) `current` computed above. Preserving the legacy
    // semantic's own nullish bit closes both regression layers with the
    // one shared cause: this proof's precision is scoped to KIND purity
    // only, never presence.
    const semantic = mayBigint
      ? (generic ? observed
        : provenBigintOnly ? semKind(VAL.BIGINT, semanticNullish(legacySemantic))
        : provenNeverBool ? packSemantic(
            semanticKinds(legacySemantic) & ~bitOfKind(VAL.BOOL),
            semanticClosed(legacySemantic),
            semanticNullish(legacySemantic),
          )
        : legacySemantic)
      : noBigintSemantic()
    const rawRow = options.provenance && options.provenance.paramRawOnly ? options.provenance.paramRawOnly.get(func.name) : null
    const current = mayBigint ? (generic ? BOXED_BIGINT : currentParamRep(rep, legacySemantic, uncovered, rawRow != null && rawRow.has(k))) : NO_BIGINT
    return {
      semantic,
      observed,
      current,
      target: targetRepFor(semantic, current),
      demand: demandFor(semantic),
      stable: !isReassigned(func.body, param.name),
    }
  })
  // A callable's result is its contract: ProgramIndex holds the one the plan's
  // summary published for a named function (`parse(n) { n = parseInt(n);
  // return n }` is a Number whatever its parameter held), the summary's freeze
  // a closure's. The contract's carrier is the target every return tail
  // converts to; a contract naming no carrier (`any`) leaves the target to the
  // body's own walk, which for a closure plans against its local provenance.
  const contract = generic
    ? ctx.summary?.resultContract(func) ?? null
    : ctx.plans.programIndex?.resultContract(func) ?? ctx.summary?.resultContract(func.name) ?? null
  const claimed = contractRep(contract)
  const resultMayBigint = contractClaimsBigint(contract) || (generic && claimed == null && options.localProvenance?.result === true)
  const semantic = resultMayBigint ? (generic ? semAll() : contractSemantic(contract)) : noBigintSemantic()
  return {
    kind: 'boundary',
    func,
    covered: !uncovered,
    params,
    result: {
      semantic,
      claimed,
      target: claimed ?? targetRepFor(semantic, ANY_BIGINT),
      demand: demandFor(semantic),
    },
    edges: [],
  }
}

const ensureBodyHandle = (ctx, identity) => {
  let handle = ctx.plans.representations.get(identity)
  if (!handle) {
    handle = {}
    ctx.plans.representationData.set(handle, { body: null })
    ctx.plans.representations.set(identity, handle)
  }
  if (identity?.sig) {
    ctx.plans.representations.set(identity.sig, handle)
    if (identity.sig.params) ctx.plans.representations.set(identity.sig.params, handle)
  }
  return handle
}

export const boundaryDataOf = (ctx, identity) => {
  const indexed = ctx.plans.programIndex?.functionBoundaryData(identity)
  if (indexed) return indexed
  // Signature- and params-keyed lookups resolve through the body's captured
  // reference to the exact ProgramIndex boundary object: a view, not a copy.
  const handle = ctx.plans.representations.get(identity)
  const record = handle && ctx.plans.representationData.get(handle)
  return record?.body?.boundary || null
}

const publishBoundary = (ctx, func, data) => {
  const index = ctx.plans.programIndex
  if (!index)
    throw new Error(`ProgramIndex missing for boundary '${func?.name || '<anonymous>'}'`)
  const indexed = index.sourceIdOf(func) >= 0 || index.variantIdOf(func) >= 0
  if (!indexed && ctx.funcs.map.get(func?.name) === func)
    throw new Error(`ProgramIndex has no identity for named boundary '${func.name}'`)
  const handle = ensureBodyHandle(ctx, func)
  index.publishFunctionBoundaryData(func, data, func?.moduleScope === true ? 'start' : 'closure')
  return handle
}

/**
 * Slice 1: publish the whole-program boundary policy after call/kind facts have
 * settled. This is shadow-only; no emitter consumes target/action facts yet.
 */
export function solveRepresentationBoundaries(ctx, programFacts, ast) {
  const bigint = programFacts.hasBigint === true
  const program = {
    program: true, bigint, emptyHandle: null, provenance: null, rejects: 0,
    closureParams: new Map(),
  }
  ctx.plans.representationData.set(ctx.plans, program)
  // BigInt-free programs cannot produce either raw or boxed BigInt carriers.
  // One opaque singleton answers NONE for every identity; body analysis only
  // returns that handle, with no per-function Map allocation or AST walk.
  if (!bigint) {
    const handle = {}
    program.emptyHandle = handle
    ctx.plans.representationData.set(handle, { programEmpty: true, body: null })
    return
  }
  program.provenance = solveBigintProvenance(ctx, programFacts, ast)
  program.provenance.closureParams = program.closureParams
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.sig) continue
    const data = makeBoundaryData(ctx, func, programFacts.paramReps, {
      addressTaken: programFacts.programIndex.addressTaken,
      provenance: program.provenance,
    })
    if (isExported(ctx, func)) for (let k = 0; k < data.params.length; k++) {
      const p = data.params[k]
      p.hostAction = edgeAction(p.current, p.target, true)
      if (p.hostAction === REP_EDGE_REJECT) program.rejects++
      data.edges.push(EDGE_KIND['host-param'], p.current, p.target, p.hostAction)
    }
    publishBoundary(ctx, func, data)
  }
}

export function ensureBoundary(ctx, identity, sig, options = {}) {
  const handle = ctx.plans.representations.get(identity)
  if (handle && boundaryDataOf(ctx, identity)) return handle
  // A closure's boundary record carries the summary's key for it (`scope`,
  // its parameter node: closure-emit.js closureSig), so its contract is read
  // as a named function's is.
  const func = identity?.sig ? identity : {
    name: identity?.name || sig?.name,
    sig,
    scope: identity?.scope ?? null,
    valResult: options.valResult || null,
    valResultMayBeUndefined: !!options.valResultMayBeUndefined,
    exported: !!options.exported,
  }
  const data = programPlanRecord(ctx)?.bigint === false
    ? makeNoBigintBoundary(func, sig)
    : makeBoundaryData(ctx, func, null, { ...options, generic: !!options.generic })
  return publishBoundary(ctx, identity, data)
}
