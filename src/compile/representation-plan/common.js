import { ASSIGN_OPS, walkAst } from '../../ast.js'
import { KIND_UNIVERSE, VAL } from '../../reps.js'

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
export const BIGINT_KIND_BIT = KIND_BITS.get(VAL.BIGINT)
export const SEM_CLOSED_BIT = 1 << 14
const SEM_NULLISH_BIT = 1 << 15
const SEM_OBSERVED_BIT = 1 << 16
export const packSemantic = (kinds, closed, nullish, observed = true) => kinds |
  (closed ? SEM_CLOSED_BIT : 0) |
  (nullish ? SEM_NULLISH_BIT : 0) |
  (observed ? SEM_OBSERVED_BIT : 0)
export const semanticKinds = packed => packed & ALL_KIND_BITS
export const semanticClosed = packed => (packed & SEM_CLOSED_BIT) !== 0
export const semanticNullish = packed => (packed & SEM_NULLISH_BIT) !== 0
export const semanticObserved = packed => (packed & SEM_OBSERVED_BIT) !== 0

export const EDGE_KIND = Object.freeze({
  'host-param': 0,
  'join-arm': 1,
  result: 2,
  'binding-write': 3,
  'storage-write': 4,
  return: 5,
  'call-arg': 6,
  'closure-arg': 7,
})
export const EDGE_KIND_NAME = Object.freeze(Object.fromEntries(Object.entries(EDGE_KIND).map(([name, code]) => [code, name])))

const packRep = (bits, closed) => (bits & BIGINT_REP_TOP) | (closed ? BIGINT_REP_CLOSED : 0)
export const bigintRepBits = packed => packed & BIGINT_REP_TOP
export const bigintRepIsClosed = packed => (packed & BIGINT_REP_CLOSED) !== 0

export const NO_BIGINT = packRep(BIGINT_REP_NONE, true)
export const RAW_BIGINT = packRep(BIGINT_REP_RAW, true)
export const BOXED_BIGINT = packRep(BIGINT_REP_BOXED, true)
export const ANY_BIGINT = packRep(BIGINT_REP_TOP, false)

export const bitOfKind = kind => KIND_BITS.get(kind) || 0
export const semBottom = () => packSemantic(0, true, false, false)
export const semAll = () => packSemantic(ALL_KIND_BITS, false, true)
export const semKind = (kind, nullish = false) => packSemantic(bitOfKind(kind), true, nullish)

export const sameSem = (a, b) => a === b

export const joinSem = (a, b) => {
  if (!semanticObserved(a)) return b
  if (!semanticObserved(b)) return a
  return packSemantic(
    semanticKinds(a) | semanticKinds(b),
    semanticClosed(a) && semanticClosed(b),
    semanticNullish(a) || semanticNullish(b),
  )
}

export const canBeBigint = sem => !semanticObserved(sem) || !semanticClosed(sem) || (semanticKinds(sem) & BIGINT_KIND_BIT) !== 0
export const canBeOther = sem => !semanticObserved(sem) || !semanticClosed(sem) || semanticNullish(sem) || (semanticKinds(sem) & ~BIGINT_KIND_BIT) !== 0
export const onlyBigintKind = sem => semanticObserved(sem) && semanticClosed(sem) && semanticKinds(sem) === BIGINT_KIND_BIT
export const definiteBigint = sem => onlyBigintKind(sem) && !semanticNullish(sem)
export const excludesBigint = sem => semanticObserved(sem) && semanticClosed(sem) && (semanticKinds(sem) & BIGINT_KIND_BIT) === 0

export const joinRep = (a, b) => packRep(
  bigintRepBits(a) | bigintRepBits(b),
  bigintRepIsClosed(a) && bigintRepIsClosed(b),
)

export const semanticFromRep = (rep, coverage = null) => {
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

export const targetRepFor = (sem, current) => {
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

export const isExported = (ctx, func) => {
  if (func?.exported) return true
  for (const value of Object.values(ctx.funcs.exports || {}))
    if (value === func?.name) return true
  return false
}

export const noBigintSemantic = () => packSemantic(ALL_KIND_BITS & ~BIGINT_KIND_BIT, true, true)

export const programPlanRecord = ctx => ctx.plans.representationData.get(ctx.plans)

export const BIGINT_TYPED_CTORS = new Set(['new.BigInt64Array', 'new.BigUint64Array'])
export const BIGINT_READ_METHODS = new Set(['getBigInt64', 'getBigUint64'])
export const VALUE_COERCERS = new Set(['Number', 'String', 'Boolean', 'parseInt', 'parseFloat'])
export const STORAGE_READ_METHODS = new Set(['get', 'pop', 'shift', 'at'])
export const STORAGE_WRITE_METHODS = new Set(['set', 'add', 'push', 'unshift'])

export const isBigintOrigin = node => Array.isArray(node) && (
  node[0] === 'bigint' ||
  (node[0] === '()' && typeof node[1] === 'string' &&
    (node[1] === 'BigInt' || node[1].startsWith('BigInt.'))) ||
  (node[0] === '()' && Array.isArray(node[1]) && BIGINT_READ_METHODS.has(node[1][2]))
)

/** name → { params: [string], body } for every `let/const NAME = (…) => BODY`
 *  declared anywhere in `body` (including nested control-flow blocks, not
 *  nested arrows — a closure declared INSIDE another closure isn't a
 *  same-body forwarding target for the outer scope). Same construction as
 *  paramAllUsesNumeric's own `closures` map (compile/index.js) — kept as a
 *  fresh per-call scan rather than a cached cross-cutting fact, matching that
 *  precedent (called once per exported function here, not per-param). First
 *  declaration of a name wins, mirroring paramAllUsesNumeric's `!closures.has`
 *  guard — a rare shadow-name imprecision, not new to this pass. */
export function collectLocalClosures(body) {
  const closures = new Map()
  const collect = node => walkAst(node, { enter: n => {
    if ((n[0] === 'let' || n[0] === 'const') && n.length === 2 &&
        Array.isArray(n[1]) && n[1][0] === '=' && typeof n[1][1] === 'string') {
      const init = n[1][2]
      if (Array.isArray(init) && init[0] === '=>' && !closures.has(n[1][1])) {
        const ps = Array.isArray(init[1]) ? init[1].slice(1) : [init[1]]
        if (ps.every(p => typeof p === 'string')) closures.set(n[1][1], { params: ps, body: init[2] })
      }
    }
  } })
  collect(body)
  return closures
}

export const memberReceiver = node => Array.isArray(node) && (node[0] === '[]' || node[0] === '.') ? node[1] : null
export const callMember = node => Array.isArray(node) && node[0] === '()' && Array.isArray(node[1]) &&
  (node[1][0] === '.' || node[1][0] === '?.') ? node[1] : null

export const NUMERIC_VALUE_OPS = new Set([
  '+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', 'u-', '~', '+1', '-1',
  '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '++', '--',
])
// The four join-shaped ops: two arms merge into one value at runtime, each a
// candidate BigInt producer. '?:' carries its arms at [2]/[3] (a condition
// sits at [1]); the three short-circuit ops carry theirs at [1]/[2] (no
// separate condition slot — the left operand IS the first arm).
export const JOIN_OPS = new Set(['?:', '&&', '||', '??'])
export const CONDITIONAL_ASSIGN_OPS = new Set(['&&=', '||=', '??='])

export const DEF_RHS = 0, DEF_OWNER = 1
export function collectDefs(body) {
  const defs = new Map()
  const add = (name, rhs, owner, slot) => {
    if (typeof name !== 'string') return
    let list = defs.get(name)
    if (!list) { list = []; defs.set(name, list) }
    list.push([rhs, owner])
  }
  const walk = (node, root = false) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (Array.isArray(op)) { for (let i = 0; i < node.length; i++) walk(node[i]); return }
    if (!root && op === '=>') return
    if (op === 'let' || op === 'const') {
      // Prepared declarations carry both a binder token and its `=` init
      // (`['let', name, ['=', name, rhs]]`). The binder is not a second
      // undefined write when an initializer for that same BindingId exists.
      const initialized = new Set()
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string') initialized.add(decl[1])
      }
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (typeof decl === 'string') { if (!initialized.has(decl)) add(decl, null, node, i) }
        else if (Array.isArray(decl) && decl[0] === '=') add(decl[1], decl[2], decl, 2)
      }
    } else if (ASSIGN_OPS.has(op) && typeof node[1] === 'string') {
      add(node[1], op === '=' || CONDITIONAL_ASSIGN_OPS.has(op) ? node[2] : node, node, 2)
    } else if ((op === '++' || op === '--') && typeof node[1] === 'string') {
      add(node[1], node, node, 1)
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body, true)
  return defs
}

export const edgeAction = (source, target, host = false) => {
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
