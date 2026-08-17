import { ASSIGN_OPS, commaList, returnExprs } from '../ast.js'
import { censusMaybeUndefinedKind, nullishArm, valTypeOf } from '../kind.js'
import { DBG_INVARIANTS } from '../ctx.js'
import { KIND_UNIVERSE, VAL } from '../reps.js'

// RepresentationPlan v2 uses compact scalar facts. The low two bits describe
// the representation of the BigInt member (if one is semantically possible);
// bit 2 proves coverage closed. NONE is a real closed answer only when paired
// with semantic-kind coverage that excludes BigInt.
export const BIGINT_REP_NONE = 0
export const BIGINT_REP_RAW = 1
export const BIGINT_REP_BOXED = 2
export const BIGINT_REP_TOP = BIGINT_REP_RAW | BIGINT_REP_BOXED
export const BIGINT_REP_CLOSED = 4

export const BIGINT_DEMAND_RAW_OK = 0
export const BIGINT_DEMAND_TAG_REQUIRED = 1

export const REP_EDGE_KEEP = 0
export const REP_EDGE_BOX = 1
export const REP_EDGE_UNBOX = 2
export const REP_EDGE_HOST_BOX = 3
export const REP_EDGE_REJECT = 4

const KIND_BITS = new Map(KIND_UNIVERSE.map((kind, i) => [kind, 1 << i]))
const ALL_KIND_BITS = (1 << KIND_UNIVERSE.length) - 1
const BIGINT_KIND_BIT = KIND_BITS.get(VAL.BIGINT)
const SEM_CLOSED_BIT = 1 << 14
const SEM_NULLISH_BIT = 1 << 15
const SEM_OBSERVED_BIT = 1 << 16
const packSemantic = (kinds, closed, nullish, observed = true) => kinds |
  (closed ? SEM_CLOSED_BIT : 0) |
  (nullish ? SEM_NULLISH_BIT : 0) |
  (observed ? SEM_OBSERVED_BIT : 0)
const semanticKinds = packed => packed & ALL_KIND_BITS
const semanticClosed = packed => (packed & SEM_CLOSED_BIT) !== 0
const semanticNullish = packed => (packed & SEM_NULLISH_BIT) !== 0
const semanticObserved = packed => (packed & SEM_OBSERVED_BIT) !== 0

const EDGE_KIND = Object.freeze({
  'host-param': 0,
  'join-arm': 1,
  result: 2,
  'binding-write': 3,
  'storage-write': 4,
  return: 5,
  'call-arg': 6,
  'closure-arg': 7,
})
const EDGE_KIND_NAME = Object.freeze(Object.fromEntries(Object.entries(EDGE_KIND).map(([name, code]) => [code, name])))

const packRep = (bits, closed) => (bits & BIGINT_REP_TOP) | (closed ? BIGINT_REP_CLOSED : 0)
const bigintRepBits = packed => packed & BIGINT_REP_TOP
const bigintRepIsClosed = packed => (packed & BIGINT_REP_CLOSED) !== 0

const NO_BIGINT = packRep(BIGINT_REP_NONE, true)
const RAW_BIGINT = packRep(BIGINT_REP_RAW, true)
const BOXED_BIGINT = packRep(BIGINT_REP_BOXED, true)
const ANY_BIGINT = packRep(BIGINT_REP_TOP, false)

const bitOfKind = kind => KIND_BITS.get(kind) || 0
const semBottom = () => packSemantic(0, true, false, false)
const semAll = () => packSemantic(ALL_KIND_BITS, false, true)
const semKind = (kind, nullish = false) => packSemantic(bitOfKind(kind), true, nullish)

const sameSem = (a, b) => a === b

const joinSem = (a, b) => {
  if (!semanticObserved(a)) return b
  if (!semanticObserved(b)) return a
  return packSemantic(
    semanticKinds(a) | semanticKinds(b),
    semanticClosed(a) && semanticClosed(b),
    semanticNullish(a) || semanticNullish(b),
  )
}

const canBeBigint = sem => !semanticObserved(sem) || !semanticClosed(sem) || (semanticKinds(sem) & BIGINT_KIND_BIT) !== 0
const canBeOther = sem => !semanticObserved(sem) || !semanticClosed(sem) || semanticNullish(sem) || (semanticKinds(sem) & ~BIGINT_KIND_BIT) !== 0
const onlyBigintKind = sem => semanticObserved(sem) && semanticClosed(sem) && semanticKinds(sem) === BIGINT_KIND_BIT
const definiteBigint = sem => onlyBigintKind(sem) && !semanticNullish(sem)
const excludesBigint = sem => semanticObserved(sem) && semanticClosed(sem) && (semanticKinds(sem) & BIGINT_KIND_BIT) === 0

const joinRep = (a, b) => packRep(
  bigintRepBits(a) | bigintRepBits(b),
  bigintRepIsClosed(a) && bigintRepIsClosed(b),
)

const semanticFromRep = (rep, coverage = null) => {
  if (rep?.possibleKinds instanceof Set && rep.possibleKinds.size) {
    let kinds = 0
    for (const kind of rep.possibleKinds) kinds |= bitOfKind(kind)
    return packSemantic(
      kinds,
      coverage != null ? coverage === 'closed' : rep.kindsCoverage === 'closed',
      !!(rep.nullable || rep.mayBeUndefined || rep.presence === 'maybe-undef'),
    )
  }
  const kind = rep?.val || rep?.presentVal
  if (kind) {
    return packSemantic(
      bitOfKind(kind),
      coverage != null ? coverage === 'closed' : true,
      !!(rep.nullable || rep.mayBeUndefined || rep.presence === 'maybe-undef'),
    )
  }
  return semAll()
}

const targetRepFor = (sem, current) => {
  if (excludesBigint(sem)) return NO_BIGINT
  if (definiteBigint(sem)) {
    if (bigintRepIsClosed(current) && bigintRepBits(current) === BIGINT_REP_RAW) return RAW_BIGINT
    if (bigintRepIsClosed(current) && bigintRepBits(current) === BIGINT_REP_BOXED) return BOXED_BIGINT
  }
  // Any value that can be both BigInt and another runtime kind needs a tag.
  // RepresentationPlan normalizes that boundary instead of retaining a
  // raw-i64-or-Number union and attempting to guess from magnitude.
  return BOXED_BIGINT
}

const demandFor = sem => canBeBigint(sem) && canBeOther(sem)
  ? BIGINT_DEMAND_TAG_REQUIRED
  : BIGINT_DEMAND_RAW_OK

const isExported = (ctx, func) => {
  if (func?.exported) return true
  for (const value of Object.values(ctx.funcs.exports || {}))
    if (value === func?.name) return true
  return false
}

const boundaryParamSemantic = (rep, uncovered) => {
  const sem = semanticFromRep(rep, uncovered ? 'open' : null)
  return uncovered ? sem & ~SEM_CLOSED_BIT : sem
}

const currentParamRep = (rep, sem, uncovered) => {
  if (excludesBigint(sem)) return NO_BIGINT
  if (uncovered) return ANY_BIGINT
  if (rep?.bigintBoxed === true && semanticClosed(sem)) return BOXED_BIGINT
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

const noBigintSemantic = () => packSemantic(ALL_KIND_BITS & ~BIGINT_KIND_BIT, true, true)

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

const programPlanRecord = ctx => ctx.plans.representationData.get(ctx.plans)

const makeBoundaryData = (ctx, func, paramReps, options = {}) => {
  const generic = !!options.generic
  const uncovered = generic || isExported(ctx, func) || options.valueUsed?.has(func.name)
  const row = paramReps?.get(func.name)
  const params = (func.sig?.params || []).map((_, k) => {
    const rep = row?.get(k)
    const semantic = generic ? semAll() : boundaryParamSemantic(rep, uncovered)
    const current = generic ? BOXED_BIGINT : currentParamRep(rep, semantic, uncovered)
    return {
      semantic,
      current,
      target: targetRepFor(semantic, current),
      demand: demandFor(semantic),
    }
  })
  const semantic = generic ? semAll() : resultSemantic(func)
  const current = currentResultRep(func, semantic, generic)
  return {
    kind: 'boundary',
    func,
    params,
    result: {
      semantic,
      current,
      target: targetRepFor(semantic, current),
      demand: demandFor(semantic),
    },
    edges: [],
  }
}

const edgeAction = (source, target, host = false) => {
  const sb = bigintRepBits(source), tb = bigintRepBits(target)
  if (sb === BIGINT_REP_NONE && bigintRepIsClosed(source)) return REP_EDGE_KEEP
  if (host && tb === BIGINT_REP_BOXED) return REP_EDGE_HOST_BOX
  if (!bigintRepIsClosed(source) || !bigintRepIsClosed(target)) return REP_EDGE_REJECT
  if (tb === BIGINT_REP_RAW) {
    if (sb === BIGINT_REP_RAW) return REP_EDGE_KEEP
    if (sb === BIGINT_REP_BOXED) return REP_EDGE_UNBOX
    return REP_EDGE_REJECT
  }
  if (tb === BIGINT_REP_BOXED) {
    if (sb === BIGINT_REP_BOXED) return REP_EDGE_KEEP
    if (sb === BIGINT_REP_RAW) return REP_EDGE_BOX
    return REP_EDGE_REJECT
  }
  return sb === tb ? REP_EDGE_KEEP : REP_EDGE_REJECT
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
  return handle
}

/**
 * Slice 1: publish the whole-program boundary policy after call/kind facts have
 * settled. This is shadow-only; no emitter consumes target/action facts yet.
 */
export function solveRepresentationBoundaries(ctx, programFacts) {
  const bigint = programFacts.hasBigint === true
  const program = { program: true, bigint, emptyHandle: null }
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
  for (const func of ctx.funcs.list) {
    if (func.raw || !func.sig) continue
    const data = makeBoundaryData(ctx, func, programFacts.paramReps, {
      valueUsed: programFacts.valueUsed,
    })
    if (isExported(ctx, func)) for (let k = 0; k < data.params.length; k++) {
      const p = data.params[k]
      p.hostAction = edgeAction(p.current, p.target, true)
      data.edges.push(EDGE_KIND['host-param'], p.current, p.target, p.hostAction)
    }
    publishBoundary(ctx, func, data)
  }
}

function ensureBoundary(ctx, identity, sig, options = {}) {
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
    : makeBoundaryData(ctx, func, null, { generic: !!options.generic })
  return publishBoundary(ctx, identity, data)
}

const directCallBoundary = (ctx, name) => {
  const func = ctx.funcs.map.get(name)
  const handle = func && ctx.plans.representations.get(func)
  return handle ? ctx.plans.representationData.get(handle)?.boundary || null : null
}

const memberReceiver = node => Array.isArray(node) && (node[0] === '[]' || node[0] === '.') ? node[1] : null
const callMember = node => Array.isArray(node) && node[0] === '()' && Array.isArray(node[1]) &&
  (node[1][0] === '.' || node[1][0] === '?.') ? node[1] : null

const NUMERIC_VALUE_OPS = new Set([
  '+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', 'u-', '~', '+1', '-1',
  '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '++', '--',
])
const NON_BIGINT_OPS = new Set([
  'typeof', '!', '>', '<', '>=', '<=', '==', '!=', '===', '!==', 'u+', '>>>',
  'str', 'bool', 'new', 'delete', 'in', 'instanceof',
])

function collectDefs(body) {
  const defs = new Map()
  const add = (name, rhs, owner, slot) => {
    if (typeof name !== 'string') return
    let list = defs.get(name)
    if (!list) { list = []; defs.set(name, list) }
    list.push({ rhs, owner, slot })
  }
  const walk = (node, root = false) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (!root && op === '=>') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (typeof decl === 'string') add(decl, null, node, i)
        else if (Array.isArray(decl) && decl[0] === '=') add(decl[1], decl[2], decl, 2)
      }
    } else if (ASSIGN_OPS.has(op) && typeof node[1] === 'string') {
      add(node[1], op === '=' ? node[2] : node, node, 2)
    } else if ((op === '++' || op === '--') && typeof node[1] === 'string') {
      add(node[1], node, node, 1)
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body, true)
  return defs
}

function buildBodyData(ctx, identity, sig, body, localReps, boundary, options) {
  const defs = collectDefs(body)
  const params = new Map((sig?.params || []).map((p, i) => [p.name, i]))
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
    semanticNames.set(name, semanticFromRep(rep))
    if (excludesBigint(semanticNames.get(name))) currentNames.set(name, NO_BIGINT)
    else if (rep?.val === VAL.BIGINT) currentNames.set(name, RAW_BIGINT)
    else currentNames.set(name, ANY_BIGINT)
  }

  const semanticOf = node => {
    if (typeof node === 'number') return semKind(VAL.NUMBER)
    if (node == null) return packSemantic(0, true, true)
    if (typeof node === 'string') return semanticNames.get(node) || semanticFromRep(localReps?.get(node))
    if (!Array.isArray(node)) return semAll()
    const cached = nodeSemantic.get(node)
    if (cached) return cached
    let out
    if (nullishArm(node)) out = packSemantic(0, true, true)
    else if (node[0] === '?:') out = joinSem(semanticOf(node[2]), semanticOf(node[3]))
    else if (node[0] === '&&' || node[0] === '||' || node[0] === '??')
      out = joinSem(semanticOf(node[1]), semanticOf(node[2]))
    else if (node[0] === '()' && typeof node[1] === 'string' && directCallBoundary(ctx, node[1]))
      out = directCallBoundary(ctx, node[1]).result.semantic
    else if (node[0] === '()' && typeof node[1] === 'string' &&
             (node[1] === 'BigInt' || node[1].startsWith('BigInt.')))
      out = semKind(VAL.BIGINT)
    else if (NUMERIC_VALUE_OPS.has(node[0])) {
      const operands = node.slice(1).filter(x => x !== undefined).map(semanticOf)
      const anyBig = operands.some(canBeBigint)
      const allBig = operands.length > 0 && operands.every(definiteBigint)
      if (allBig) out = semKind(VAL.BIGINT)
      else if (anyBig) out = packSemantic(
        BIGINT_KIND_BIT | bitOfKind(VAL.NUMBER),
        operands.every(x => semanticObserved(x) && semanticClosed(x)),
        false,
      )
      else out = semKind(VAL.NUMBER)
    } else if (NON_BIGINT_OPS.has(node[0])) {
      const vt = valTypeOf(node)
      out = semKind(vt || (node[0] === 'typeof' ? VAL.STRING : VAL.BOOL))
    } else {
      const census = censusMaybeUndefinedKind(node)
      const vt = valTypeOf(node)
      if (census) out = semKind(census, true)
      else if (vt) out = semKind(vt)
      else out = semAll()
    }
    nodeSemantic.set(node, out)
    return out
  }

  // Semantic binding fixpoint. Definitions are body-local and joins widen;
  // recursive cycles with no seed remain BOTTOM and are opened after settle.
  const budget = defs.size + 2
  for (let round = 0; round < budget; round++) {
    let changed = false
    for (const [name, list] of defs) {
      let next = params.has(name) ? semanticNames.get(name) : semBottom()
      for (const def of list) {
        const value = def.rhs == null
          ? packSemantic(0, true, true)
          : semanticOf(def.rhs)
        next = joinSem(next, value)
      }
      const prev = semanticNames.get(name) || semBottom()
      if (!sameSem(prev, next)) { semanticNames.set(name, next); changed = true }
    }
    if (!changed) break
    nodeSemantic.clear()
  }
  for (const name of defs.keys()) {
    const sem = semanticNames.get(name)
    if (!semanticObserved(sem)) semanticNames.set(name, semanticFromRep(localReps?.get(name)))
  }
  nodeSemantic.clear()

  const currentOf = node => {
    const sem = semanticOf(node)
    if (excludesBigint(sem)) return NO_BIGINT
    if (typeof node === 'string') return currentNames.get(node) ?? ANY_BIGINT
    if (!Array.isArray(node)) return ANY_BIGINT
    const cached = nodeCurrent.get(node)
    if (cached != null) return cached
    let out
    if (node[0] === '()' && typeof node[1] === 'string' && directCallBoundary(ctx, node[1]))
      out = directCallBoundary(ctx, node[1]).result.current
    else {
      const recv = memberReceiver(node)
      const cm = callMember(node)
      if (recv != null) {
        const rv = valTypeOf(recv)
        if (rv === VAL.TYPED) out = RAW_BIGINT
        else if (node[0] === '.' && typeof recv === 'string' && typeof node[2] === 'string' &&
                 ctx.schema.slotBigintProvenAt?.(recv, node[2])) out = RAW_BIGINT
        else out = BOXED_BIGINT
      } else if (cm && cm[2] === 'get') out = BOXED_BIGINT
      else if (node[0] === '?:') {
        const a = node[2], b = node[3]
        if ((valTypeOf(a) === VAL.BIGINT && nullishArm(b)) || (valTypeOf(b) === VAL.BIGINT && nullishArm(a)))
          out = BOXED_BIGINT
        else out = joinRep(currentOf(a), currentOf(b))
      } else if (node[0] === '&&' || node[0] === '||' || node[0] === '??')
        out = joinRep(currentOf(node[1]), currentOf(node[2]))
      else if (NUMERIC_VALUE_OPS.has(node[0]) && canBeBigint(sem)) out = RAW_BIGINT
      else if (definiteBigint(sem)) out = RAW_BIGINT
      else out = ANY_BIGINT
    }
    nodeCurrent.set(node, out)
    return out
  }

  for (let round = 0; round < budget; round++) {
    let changed = false
    nodeCurrent.clear()
    for (const [name, list] of defs) {
      let out = params.has(name) ? (currentNames.get(name) ?? ANY_BIGINT) : null
      for (const def of list) {
        const next = def.rhs == null ? NO_BIGINT : currentOf(def.rhs)
        out = out == null ? next : joinRep(out, next)
      }
      out ??= ANY_BIGINT
      if (currentNames.get(name) !== out) { currentNames.set(name, out); changed = true }
    }
    if (!changed) break
  }
  nodeCurrent.clear()
  for (const [name, sem] of semanticNames)
    targetNames.set(name, targetRepFor(sem, currentNames.get(name) ?? ANY_BIGINT))

  const addEdge = (kind, source, target, _detail, host = false) => {
    const action = edgeAction(source, target, host)
    // KEEP is the default edge equation and needs no retained record. Canonical
    // storage contains only an actual normalization or unresolved obligation.
    if (action !== REP_EDGE_KEEP) edges.push(EDGE_KIND[kind], source, target, action)
    return action
  }

  const plannedSeen = new WeakSet()
  const plannedOf = node => {
    const sem = semanticOf(node)
    if (excludesBigint(sem)) return NO_BIGINT
    if (typeof node === 'string') return targetNames.get(node) ?? ANY_BIGINT
    if (!Array.isArray(node)) return ANY_BIGINT
    const cached = nodeTarget.get(node)
    if (cached != null) return cached
    let target
    if (node[0] === '()' && typeof node[1] === 'string' && directCallBoundary(ctx, node[1]))
      target = directCallBoundary(ctx, node[1]).result.target
    else {
      const recv = memberReceiver(node)
      const cm = callMember(node)
      if (recv != null) target = valTypeOf(recv) === VAL.TYPED ? RAW_BIGINT :
        (node[0] === '.' && typeof recv === 'string' && typeof node[2] === 'string' &&
         ctx.schema.slotBigintProvenAt?.(recv, node[2]) ? RAW_BIGINT : BOXED_BIGINT)
      else if (cm && cm[2] === 'get') target = BOXED_BIGINT
      else target = targetRepFor(sem, currentOf(node))
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
        if (current !== target) addEdge('result', current, target, node)
      }
    }
    return target
  }

  const walkEdges = (node, root = false) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (!root && op === '=>') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string')
          addEdge('binding-write', plannedOf(decl[2]), targetNames.get(decl[1]) ?? ANY_BIGINT, decl)
      }
    } else if (ASSIGN_OPS.has(op)) {
      if (typeof node[1] === 'string') {
        const source = op === '=' ? node[2] : node
        addEdge('binding-write', plannedOf(source), targetNames.get(node[1]) ?? ANY_BIGINT, node)
      } else if (Array.isArray(node[1]) && (node[1][0] === '[]' || node[1][0] === '.')) {
        const rv = valTypeOf(node[1][1])
        addEdge('storage-write', plannedOf(node[2]), rv === VAL.TYPED ? RAW_BIGINT : BOXED_BIGINT, node)
      }
    } else if (op === 'return' && node[1] != null) {
      addEdge('return', plannedOf(node[1]), boundary.result.target, node)
    } else if (op === '()') {
      const args = commaList(node[2])
      if (typeof node[1] === 'string') {
        const callee = directCallBoundary(ctx, node[1])
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
    addEdge('return', plannedOf(body), boundary.result.target, body)
  else {
    // Force all return expressions through plannedOf even when a transformed
    // body shape kept the return outside walkEdges' ordinary statement walk.
    for (const expr of returnExprs(body)) plannedOf(expr)
  }

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
    semanticNames: null, currentNames: null, targetNames: null, nodeFacts: null, edges,
  } : {
    kind: 'body', identity, boundary, trivial: false,
    semanticNames: packedSemantics,
    currentNames: keptCurrent,
    targetNames: keptTarget,
    nodeFacts,
    edges,
  }
}

/** Publish one opaque per-body RepresentationPlan after all local facts settle. */
export function mintRepresentationPlan(ctx, identity, sig, body, localReps, options = {}) {
  const program = programPlanRecord(ctx)
  if (program?.bigint === false) return program.emptyHandle
  const prior = ctx.plans.representations.get(identity)
  if (prior && ctx.plans.representationData.get(prior)?.body)
    throw new Error(`RepresentationPlan already published for ${identity?.name || '<anonymous>'}`)
  const handle = ensureBoundary(ctx, identity, sig, options)
  const record = ctx.plans.representationData.get(handle)
  record.body = programPlanRecord(ctx)?.bigint === false
    ? {
        kind: 'body', identity, boundary: record.boundary, trivial: true,
        semanticNames: new Map(), currentNames: new Map(), targetNames: new Map(),
        nodeFacts: new Map(), edges: [],
      }
    : buildBodyData(ctx, identity, sig, body, localReps, record.boundary, options)
  if (DBG_INVARIANTS) assertRepresentationPlan(ctx, handle)
  return handle
}

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
  return target ? data.params[index]?.target : data.params[index]?.current
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

export const representationProgramHasBigint = ctx => programPlanRecord(ctx)?.bigint === true

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
