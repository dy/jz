import { isReassigned } from '../../ast.js'
import { VAL } from '../../reps.js'
import {
  ANY_BIGINT, BIGINT_DEMAND_RAW_OK, BIGINT_DEMAND_TAG_REQUIRED, BOXED_BIGINT, EDGE_KIND, NO_BIGINT, RAW_BIGINT,
  REP_EDGE_REJECT, SEM_CLOSED_BIT, bitOfKind, canBeBigint, canBeOther, edgeAction, excludesBigint, isExported,
  noBigintSemantic, onlyBigintKind, packSemantic, programPlanRecord, semAll, semKind, semanticClosed,
  semanticFromRep, semanticKinds, semanticNullish, targetRepFor,
} from './common.js'
import { solveBigintProvenance } from './provenance.js'

const boundaryParamSemantic = (rep, uncovered) => {
  const sem = semanticFromRep(rep, uncovered ? 'open' : null)
  return uncovered ? sem & ~SEM_CLOSED_BIT : sem
}

const currentParamRep = (rep, sem, uncovered) => {
  if (excludesBigint(sem)) return NO_BIGINT
  if (uncovered) return ANY_BIGINT
  if (onlyBigintKind(sem)) return RAW_BIGINT
  return ANY_BIGINT
}

const resultSemantic = func => {
  if (!func?.sig?.results?.length) return semKind(VAL.NUMBER)
  if (func.valResult === VAL.BIGINT && !func.valResultMayBeUndefined) return semKind(VAL.BIGINT)
  // i32 and pointer-result ABIs cannot carry a raw BigInt member.
  if (func.sig.ptrKind != null || func.sig.results[0] === 'i32')
    return semKind(func.valResult || VAL.NUMBER)
  // A non-number exact result kind is a reliable exclusion. NUMBER is kept
  // open: numeric operator defaults are deliberately optimistic elsewhere in
  // the compiler and cannot prove a BigInt member absent here.
  if (func.valResult && func.valResult !== VAL.NUMBER)
    return semKind(func.valResult, !!func.valResultMayBeUndefined)
  return semAll()
}

const currentResultRep = (func, sem, generic) => {
  if (excludesBigint(sem)) return NO_BIGINT
  if (generic) return ANY_BIGINT
  if (onlyBigintKind(sem)) return RAW_BIGINT
  return ANY_BIGINT
}

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
    current: NO_BIGINT,
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
    // strictly more precise than `rep` for this one purpose (the BOOL-veto
    // in buildBodyData's materializedNames fixpoint) since it is derived
    // from literally every real caller, not a per-function kind census.
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
    // vetoes materialization even though the value can never actually be a
    // JS boolean here (it comes from a storage read — self-tagged per
    // element at the wire, same invariant buildBodyData's own
    // identitySafeStorageFlow carve-out already relies on for body defs).
    // paramNeverBool proves the weaker, sufficient fact: not kind-purity,
    // only boolean-impossibility.
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
    // supply buildBodyData's BOOL-veto a precise, informative kind set
    // (`semantic`) so a covered param the legacy census under-proves isn't
    // permanently excluded from materializedNames. `current`/`target`
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
    const current = mayBigint ? (generic ? BOXED_BIGINT : currentParamRep(rep, legacySemantic, uncovered)) : NO_BIGINT
    return {
      semantic,
      observed,
      current,
      target: targetRepFor(semantic, current),
      demand: demandFor(semantic),
      stable: !isReassigned(func.body, param.name),
    }
  })
  const resultMayBigint = generic
    ? options.localProvenance?.result === true
    : options.provenance?.results.has(func.name)
  const semantic = resultMayBigint ? (generic ? semAll() : resultSemantic(func)) : noBigintSemantic()
  const current = resultMayBigint
    ? (generic ? currentResultRep(func, semantic, true) : options.provenance?.resultReps.get(func.name) ?? currentResultRep(func, semantic, false))
    : NO_BIGINT
  // A mixed-result closure table explicitly marks its member bodies: raw i64
  // BigInt bits cannot share the uniform closure result lane with Number.
  // Named top-level function values use their dedicated trampoline producer
  // boundary (emit.js) instead.
  const forceTaggedResult = resultMayBigint && options.forceTaggedResult === true
  return {
    kind: 'boundary',
    func,
    covered: !uncovered,
    params,
    result: {
      semantic,
      current,
      target: forceTaggedResult ? BOXED_BIGINT : targetRepFor(semantic, current),
      demand: demandFor(semantic),
      forceTagged: forceTaggedResult,
    },
    edges: [],
  }
}

const publishBoundary = (ctx, func, data) => {
  let handle = ctx.plans.representations.get(func)
  if (handle) {
    const record = ctx.plans.representationData.get(handle)
    if (record?.boundary)
      throw new Error(`Representation boundary already published for ${func?.name || '<anonymous>'}`)
    record.boundary = data
    return handle
  }
  handle = {}
  ctx.plans.representationData.set(handle, { boundary: data, body: null })
  ctx.plans.representations.set(func, handle)
  if (func?.sig) {
    ctx.plans.representations.set(func.sig, handle)
    if (func.sig.params) ctx.plans.representations.set(func.sig.params, handle)
  }
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
    ctx.plans.representationData.set(handle, { programEmpty: true, boundary: null, body: null })
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
  if (handle && ctx.plans.representationData.get(handle)?.boundary) return handle
  const func = identity?.sig ? identity : {
    name: identity?.name || sig?.name,
    sig,
    valResult: options.valResult || null,
    valResultMayBeUndefined: !!options.valResultMayBeUndefined,
    exported: !!options.exported,
  }
  const data = programPlanRecord(ctx)?.bigint === false
    ? makeNoBigintBoundary(func, sig)
    : makeBoundaryData(ctx, func, null, { ...options, generic: !!options.generic })
  return publishBoundary(ctx, identity, data)
}
