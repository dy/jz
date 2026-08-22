import { ASSIGN_OPS, commaList, isReassigned, returnExprs } from '../ast.js'
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

const BIGINT_TYPED_CTORS = new Set(['new.BigInt64Array', 'new.BigUint64Array'])
const BIGINT_READ_METHODS = new Set(['getBigInt64', 'getBigUint64'])
const VALUE_COERCERS = new Set(['Number', 'String', 'Boolean', 'parseInt', 'parseFloat'])
const STORAGE_READ_METHODS = new Set(['get', 'pop', 'shift', 'at'])
const STORAGE_WRITE_METHODS = new Set(['set', 'add', 'push', 'unshift'])

const isBigintOrigin = node => Array.isArray(node) && (
  node[0] === 'bigint' ||
  (node[0] === '()' && typeof node[1] === 'string' &&
    (node[1] === 'BigInt' || node[1].startsWith('BigInt.'))) ||
  (node[0] === '()' && Array.isArray(node[1]) && BIGINT_READ_METHODS.has(node[1][2]))
)

/**
 * Forward existential provenance from real BigInt origins through bindings,
 * calls, returns, and named storage. Unknown semantic kind is not itself an
 * origin: this is the proof v1 lacked when it treated every TOP as raw-capable.
 */
function solveBigintProvenance(ctx, programFacts, ast) {
  const namesByFunc = new Map()
  const paramsByFunc = new Map()
  const results = new Set()
  const resultReps = new Map()
  const storage = new Set()
  const bigintTyped = new Set()
  const globals = new Set()
  const globalReps = new Map()
  let indirectResult = false

  const namesFor = func => {
    let names = namesByFunc.get(func)
    if (!names) { names = new Set(); namesByFunc.set(func, names) }
    return names
  }
  const paramsFor = func => {
    let set = paramsByFunc.get(func.name)
    if (!set) { set = new Set(); paramsByFunc.set(func.name, set) }
    return set
  }
  const mark = (set, value) => {
    if (set.has(value)) return false
    set.add(value)
    return true
  }

  const paramNeedsHostTag = (node, name, root = true) => {
    if (!Array.isArray(node)) return false
    if (!root && node[0] === '=>') return false
    if (node[0] === 'typeof' && node[1] === name) return true
    if (node[0] === 'u+' && node[1] === name) return true
    if (node[0] === '()' && node[1] === 'Number' && commaList(node[2]).includes(name)) return true
    // BigInt(name) — same producer as Number(name): BigInt() is a total
    // normalizer over string/number/boolean/bigint (ES2024 21.2.1.1), so a
    // param feeding it is well-equipped for the tagged ingress — a plain
    // host bigint there should box and pass through BigInt()'s identity
    // case, not be rejected as zero-evidence (phase-c C4b coordinator fix).
    if (node[0] === '()' && node[1] === 'BigInt' && commaList(node[2]).includes(name)) return true
    for (let i = 1; i < node.length; i++) if (paramNeedsHostTag(node[i], name, false)) return true
    return false
  }

  for (const func of ctx.funcs.list) {
    if (func.raw || !func.sig) continue
    const row = programFacts.paramReps.get(func.name)
    const pset = paramsFor(func)
    for (let k = 0; k < func.sig.params.length; k++) {
      const rep = row?.get(k)
      const observed = rep?.possibleKinds
      if (typeof rep?.typedCtor === 'string' && (rep.typedCtor.includes('BigInt64') || rep.typedCtor.includes('BigUint64')))
        bigintTyped.add(func.sig.params[k].name)
      if (rep?.val === VAL.BIGINT || rep?.presentVal === VAL.BIGINT || rep?.bigintBoxed === true ||
          (observed instanceof Set && observed.size < KIND_UNIVERSE.length && observed.has(VAL.BIGINT)) ||
          (isExported(ctx, func) && paramNeedsHostTag(func.body, func.sig.params[k].name)))
        pset.add(k)
    }
    for (const k of pset) namesFor(func).add(func.sig.params[k].name)
    if (func.valResult === VAL.BIGINT) results.add(func.name)
  }

  const defMapByFunc = new Map()
  for (const func of ctx.funcs.list)
    if (!func.raw && func.body) defMapByFunc.set(func, collectDefs(func.body))

  const exprMay = (node, func, localNames) => {
    if (isBigintOrigin(node)) return true
    if (typeof node === 'string') return localNames?.has(node) || globals.has(node)
    if (!Array.isArray(node) || nullishArm(node)) return false
    const op = node[0]
    if (op === '?:') return exprMay(node[2], func, localNames) || exprMay(node[3], func, localNames)
    if (op === '&&' || op === '||' || op === '??')
      return exprMay(node[1], func, localNames) || exprMay(node[2], func, localNames)
    if (op === ',') return exprMay(node[node.length - 1], func, localNames)
    if (op === '=' && typeof node[1] === 'string') return exprMay(node[2], func, localNames)
    if (op === 'typeof' || op === '!' || op === 'u+' || op === '>>>' ||
        op === '==' || op === '!=' || op === '===' || op === '!==' ||
        op === '<' || op === '>' || op === '<=' || op === '>=' || op === 'in' || op === 'instanceof') return false
    if (op === '[]' || op === '.' || op === '?.')
      return typeof node[1] === 'string' && (storage.has(node[1]) || (op === '[]' && bigintTyped.has(node[1])))
    if (op === '()') {
      if (typeof node[1] === 'string') {
        if (VALUE_COERCERS.has(node[1])) return false
        if (node[1] === 'Atomics.load') {
          const recv = commaList(node[2])[0]
          return typeof recv === 'string' && bigintTyped.has(recv)
        }
        if (BIGINT_TYPED_CTORS.has(node[1])) return false // constructor yields a TYPED pointer, not a BigInt value
        const callee = ctx.funcs.map.get(node[1])
        return callee ? results.has(callee.name) : false
      }
      if (Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.')) {
        const method = node[1][2]
        if (BIGINT_READ_METHODS.has(method)) return true
        if (STORAGE_READ_METHODS.has(method) && typeof node[1][1] === 'string')
          return storage.has(node[1][1]) || bigintTyped.has(node[1][1])
        return false
      }
      return indirectResult
    }
    // Arithmetic preserves a BigInt member from a BigInt operand. Object/
    // array/string construction returns a pointer and is not a BigInt value.
    if (op === '[' || op === '{}' || op === 'str' || op === 'bool' || op === 'new' ||
        (typeof op === 'string' && op.startsWith('new.'))) return false
    for (let i = 1; i < node.length; i++) if (exprMay(node[i], func, localNames)) return true
    return false
  }

  const exprRep = (node, func, localNames) => {
    if (!exprMay(node, func, localNames)) return NO_BIGINT
    if (isBigintOrigin(node)) return RAW_BIGINT
    if (typeof node === 'string') return globalReps.get(node) ?? ANY_BIGINT
    if (!Array.isArray(node)) return ANY_BIGINT
    if (node[0] === ',') return exprRep(node[node.length - 1], func, localNames)
    if (node[0] === '=') return exprRep(node[2], func, localNames)
    if (node[0] === '?:') return joinRep(exprRep(node[2], func, localNames), exprRep(node[3], func, localNames))
    if (node[0] === '&&' || node[0] === '||' || node[0] === '??')
      return joinRep(exprRep(node[1], func, localNames), exprRep(node[2], func, localNames))
    if (node[0] === '[]' && typeof node[1] === 'string')
      return bigintTyped.has(node[1]) ? RAW_BIGINT : storage.has(node[1]) ? BOXED_BIGINT : ANY_BIGINT
    if ((node[0] === '.' || node[0] === '?.') && typeof node[1] === 'string')
      return storage.has(node[1]) ? BOXED_BIGINT : ANY_BIGINT
    if (node[0] === '()') {
      if (typeof node[1] === 'string') {
        const callee = ctx.funcs.map.get(node[1])
        return callee ? resultReps.get(callee.name) ?? ANY_BIGINT : RAW_BIGINT
      }
      if (Array.isArray(node[1]) && BIGINT_READ_METHODS.has(node[1][2])) return RAW_BIGINT
      if (Array.isArray(node[1]) && STORAGE_READ_METHODS.has(node[1][2])) return BOXED_BIGINT
    }
    if (NUMERIC_VALUE_OPS.has(node[0])) return RAW_BIGINT
    return ANY_BIGINT
  }

  const noteResult = (func, expr) => {
    if (!func || !exprMay(expr, func, namesFor(func))) return false
    let changed = mark(results, func.name)
    const rep = exprRep(expr, func, namesFor(func))
    const prev = resultReps.get(func.name)
    const next = prev == null ? rep : joinRep(prev, rep)
    if (prev !== next) { resultReps.set(func.name, next); changed = true }
    return changed
  }

  const scan = (node, func, localNames) => {
    if (!Array.isArray(node)) return false
    let changed = false
    const op = node[0]
    if (Array.isArray(op)) {
      for (let i = 0; i < node.length; i++) if (scan(node[i], func, localNames)) changed = true
      return changed
    }
    if (op === '=>') return false
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const decl = node[i]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' &&
            Array.isArray(decl[2]) && decl[2][0] === '()' && BIGINT_TYPED_CTORS.has(decl[2][1]))
          if (mark(bigintTyped, decl[1])) changed = true
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' &&
            exprMay(decl[2], func, localNames)) {
          if (mark(localNames, decl[1])) changed = true
          if (!func) {
            const rep = isBigintOrigin(decl[2]) ? RAW_BIGINT : ANY_BIGINT
            const prev = globalReps.get(decl[1])
            const next = prev == null ? rep : joinRep(prev, rep)
            if (prev !== next) { globalReps.set(decl[1], next); changed = true }
          }
        }
      }
    }
    if (op === '()' && typeof node[1] === 'string') {
      const callee = ctx.funcs.map.get(node[1])
      if (callee) {
        const args = commaList(node[2]), pset = paramsFor(callee)
        for (let k = 0; k < args.length && k < callee.sig.params.length; k++)
          if (exprMay(args[k], func, localNames) && mark(pset, k)) changed = true
        for (const k of pset) if (mark(namesFor(callee), callee.sig.params[k].name)) changed = true
        // A callee that mutates a storage-bearing param propagates that
        // storage provenance back to the caller's bare receiver argument.
        for (let k = 0; k < args.length && k < callee.sig.params.length; k++)
          if (storage.has(callee.sig.params[k].name) && typeof args[k] === 'string' && mark(storage, args[k])) changed = true
      }
    }
    if (op === '()' && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.')) {
      const recv = node[1][1], method = node[1][2], args = commaList(node[2])
      if (STORAGE_WRITE_METHODS.has(method)) {
        const start = method === 'set' ? 1 : 0
        for (let k = start; k < args.length; k++)
          if (exprMay(args[k], func, localNames) && typeof recv === 'string' && mark(storage, recv)) changed = true
      }
    }
    if (ASSIGN_OPS.has(op) && typeof node[1] === 'string' && exprMay(node[2], func, localNames)) {
      if (mark(localNames, node[1])) changed = true
      // Body-write acquisition: a param that ACQUIRES its BigInt via a body
      // write (`if (r) v = 4n`, `if (typeof n === 'string') n = BigInt(n)`)
      // is bigint-provenant even when NO call site ever passes one. Without
      // this the boundary's mayBigint stays false, the plan never
      // materializes the tagged carrier for the binding, and the adopted
      // write-kind folds `typeof` wrong for the non-BigInt entries
      // (numberKind() === 'bigint' with Number-only call sites — found by
      // direct probe; the suite's own pin passes only because its source
      // also has a 5n call site that trips the call-arg provenance).
      if (func?.sig?.params) {
        const kp = func.sig.params.findIndex(p => p.name === node[1])
        if (kp >= 0 && mark(paramsFor(func), kp)) changed = true
      }
      if (!func) {
        const rep = isBigintOrigin(node[2]) ? RAW_BIGINT : ANY_BIGINT
        const prev = globalReps.get(node[1])
        const next = prev == null ? rep : joinRep(prev, rep)
        if (prev !== next) { globalReps.set(node[1], next); changed = true }
      }
    }
    if (ASSIGN_OPS.has(op) && Array.isArray(node[1]) && (node[1][0] === '[]' || node[1][0] === '.')) {
      const recv = node[1][1]
      if (exprMay(node[2], func, localNames) && typeof recv === 'string' && mark(storage, recv)) changed = true
    }
    if (op === 'return' && noteResult(func, node[1])) changed = true
    for (let i = 1; i < node.length; i++) if (scan(node[i], func, localNames)) changed = true
    return changed
  }

  let graphChanged = true
  while (graphChanged) {
    graphChanged = false
    for (const func of ctx.funcs.list) {
      if (func.raw || !func.body) continue
      const names = namesFor(func), defs = defMapByFunc.get(func)
      let localChanged = true
      while (localChanged) {
        localChanged = false
        for (const [name, entries] of defs) {
          for (const entry of entries) if (entry.rhs != null && exprMay(entry.rhs, func, names)) {
            if (mark(names, name)) { localChanged = true; graphChanged = true }
            break
          }
          // Storage aliases preserve the receiver's content provenance.
          for (const entry of entries) if (typeof entry.rhs === 'string') {
            if (storage.has(entry.rhs) && mark(storage, name)) { localChanged = true; graphChanged = true }
            if (bigintTyped.has(entry.rhs) && mark(bigintTyped, name)) { localChanged = true; graphChanged = true }
          }
        }
      }
      if (!Array.isArray(func.body) || func.body[0] !== '{}')
        if (noteResult(func, func.body)) graphChanged = true
      if (scan(func.body, func, names)) graphChanged = true
    }
    if (!indirectResult)
      for (const name of programFacts.valueUsed) if (results.has(name)) { indirectResult = true; graphChanged = true; break }
    if (scan(ast, null, globals)) graphChanged = true
    if (ctx.module.moduleInits) for (const init of ctx.module.moduleInits)
      if (scan(init, null, globals)) graphChanged = true
  }

  return { namesByFunc, paramsByFunc, results, resultReps, storage, bigintTyped, globals, globalReps, indirectResult, exprMay }
}

function deriveLocalProvenance(sig, body, localReps, program) {
  const names = new Set(), params = new Set()
  const observedParams = program?.closureParams.get(sig?.name)
  for (let k = 0; k < (sig?.params?.length || 0); k++) {
    const name = sig.params[k].name, rep = localReps?.get(name)
    if (rep?.val === VAL.BIGINT || rep?.presentVal === VAL.BIGINT || rep?.bigintBoxed === true || observedParams?.has(k)) {
      params.add(k)
      names.add(name)
    }
  }
  if (localReps) for (const [name, rep] of localReps)
    if (rep?.val === VAL.BIGINT || rep?.presentVal === VAL.BIGINT || rep?.bigintBoxed === true) names.add(name)
  const defs = collectDefs(body)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, entries] of defs)
      if (!names.has(name) && entries.some(entry => entry.rhs != null && program.exprMay(entry.rhs, null, names))) {
        names.add(name)
        changed = true
      }
  }
  const tails = Array.isArray(body) && body[0] === '{}' ? returnExprs(body) : [body]
  return { names, params, result: tails.some(expr => program.exprMay(expr, null, names)) }
}

const makeBoundaryData = (ctx, func, paramReps, options = {}) => {
  const generic = !!options.generic
  const valueAbi = options.valueUsed?.has(func.name) === true
  const uncovered = generic || isExported(ctx, func) || valueAbi
  const row = paramReps?.get(func.name)
  const params = (func.sig?.params || []).map((param, k) => {
    const rep = row?.get(k) || (generic ? options.localReps?.get(param.name) : null)
    const mayBigint = generic
      ? options.localProvenance?.params.has(k)
      : options.provenance?.paramsByFunc.get(func.name)?.has(k)
    const semantic = mayBigint
      ? (generic ? (rep ? semanticFromRep(rep) : semAll()) : boundaryParamSemantic(rep, uncovered))
      : noBigintSemantic()
    const current = mayBigint ? (generic ? BOXED_BIGINT : currentParamRep(rep, semantic, uncovered)) : NO_BIGINT
    return {
      semantic,
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
  return {
    kind: 'boundary',
    func,
    covered: !uncovered,
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
      valueUsed: programFacts.valueUsed,
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
    : makeBoundaryData(ctx, func, null, { ...options, generic: !!options.generic })
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
  const provenance = options.provenance
  const taintedNames = options.localProvenance?.names || provenance?.namesByFunc.get(identity)
  const mayCarryBigint = node => !provenance || provenance.exprMay(node, identity, taintedNames)
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
    if (!mayCarryBigint(node)) {
      const vt = valTypeOf(node)
      out = nullishArm(node) ? packSemantic(0, true, true)
        : vt ? semKind(vt) : noBigintSemantic()
    }
    else if (nullishArm(node)) out = packSemantic(0, true, true)
    else if (isBigintOrigin(node)) out = semKind(VAL.BIGINT)
    else if (node[0] === ',') out = semanticOf(node[node.length - 1])
    else if (node[0] === '=') out = semanticOf(node[2])
    else if (node[0] === '?:') out = joinSem(semanticOf(node[2]), semanticOf(node[3]))
    else if (node[0] === '&&' || node[0] === '||' || node[0] === '??')
      out = joinSem(semanticOf(node[1]), semanticOf(node[2]))
    else if (node[0] === '()' && typeof node[1] === 'string' &&
             (node[1] === 'BigInt' || node[1].startsWith('BigInt.')))
      out = semKind(VAL.BIGINT)
    else if (node[0] === '()' && typeof node[1] === 'string' && directCallBoundary(ctx, node[1]))
      out = directCallBoundary(ctx, node[1]).result.semantic
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
  let semanticChanged = true
  while (semanticChanged) {
    semanticChanged = false
    for (const [name, list] of defs) {
      let next = params.has(name) ? semanticNames.get(name) : semBottom()
      for (const def of list) {
        const value = def.rhs == null
          ? packSemantic(0, true, true)
          : semanticOf(def.rhs)
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

  const currentOf = node => {
    const sem = semanticOf(node)
    if (excludesBigint(sem)) return NO_BIGINT
    if (typeof node === 'string') return currentNames.get(node) ?? provenance?.globalReps.get(node) ?? ANY_BIGINT
    if (!Array.isArray(node)) return ANY_BIGINT
    const cached = nodeCurrent.get(node)
    if (cached != null) return cached
    let out
    if (isBigintOrigin(node)) out = RAW_BIGINT
    else if (node[0] === '()' && typeof node[1] === 'string' && directCallBoundary(ctx, node[1]))
      out = directCallBoundary(ctx, node[1]).result.current
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

  let representationChanged = true
  while (representationChanged) {
    representationChanged = false
    nodeCurrent.clear()
    for (const [name, list] of defs) {
      let out = params.has(name) ? (currentNames.get(name) ?? ANY_BIGINT) : null
      for (const def of list) {
        const next = def.rhs == null ? NO_BIGINT : currentOf(def.rhs)
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
    if (node[0] === '()' && typeof node[1] === 'string' && directCallBoundary(ctx, node[1])) {
      target = directCallBoundary(ctx, node[1]).result.target
      normalizedElsewhere = true // the callee's return edges own this transition
    } else {
      const recv = memberReceiver(node)
      const cm = callMember(node)
      if (recv != null) {
        target = valTypeOf(recv) === VAL.TYPED ? RAW_BIGINT :
          (node[0] === '.' && typeof recv === 'string' && typeof node[2] === 'string' &&
           ctx.schema.slotBigintProvenAt?.(recv, node[2]) ? RAW_BIGINT : BOXED_BIGINT)
        normalizedElsewhere = true // storage's write edge owns the carrier
      } else if (cm && cm[2] === 'get') {
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
  const bodyResultTarget = targetRepFor(bodyResultSemantic, bodyResultCurrent)

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
        const source = op === '=' ? node[2] : node
        addEdge('binding-write', plannedOf(source), targetNames.get(node[1]) ?? ANY_BIGINT, node)
      } else if (Array.isArray(node[1]) && (node[1][0] === '[]' || node[1][0] === '.')) {
        const rv = valTypeOf(node[1][1])
        addEdge('storage-write', plannedOf(node[2]), rv === VAL.TYPED ? RAW_BIGINT : BOXED_BIGINT, node)
      }
    } else if (op === 'return' && node[1] != null) {
      addEdge('return', plannedOf(node[1]), bodyResultTarget, node)
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
    addEdge('return', plannedOf(body), bodyResultTarget, body)
  else {
    // Force all return expressions through plannedOf even when a transformed
    // body shape kept the return outside walkEdges' ordinary statement walk.
    for (const expr of returnExprs(body)) plannedOf(expr)
  }

  // A local—or a parameter on a covered direct boundary—whose complete def
  // set uses plain writes can have every incoming edge normalized at
  // emitDecl / the '=' handler. Keep this
  // readiness private: readers get only a scalar projection, never the Set.
  const edgeMaterializable = (source, target, node, sourceReady = false) => {
    const action = edgeAction(source, target)
    if (action === REP_EDGE_BOX || action === REP_EDGE_UNBOX)
      return valTypeOf(node) === VAL.BIGINT
    if (action !== REP_EDGE_KEEP) return false
    // NONE is unchanged on a tagged union edge. A raw KEEP is also a real
    // identity. BOXED→BOXED is ready only when the upstream producer family
    // has itself materialized, not merely because its eventual target is BOXED.
    return bigintRepBits(source) === BIGINT_REP_NONE ||
      (source === RAW_BIGINT && target === RAW_BIGINT) ||
      (source === BOXED_BIGINT && target === BOXED_BIGINT && sourceReady)
  }

  const materializedNames = new Set()
  const exportedIdentity = isExported(ctx, identity)
  for (const [name, list] of defs) {
    if (ctx.scope.globals?.has(name)) continue
    if (params.has(name) && boundary.covered !== true && !exportedIdentity) continue
    // RepresentationPlan only normalizes the BigInt member. A BOOL member in
    // an otherwise dynamic scalar still needs the separate BOOL-atom producer;
    // do not claim the whole binding materialized before that project lands.
    const nameSemantic = semanticNames.get(name) ?? semAll()
    if (semanticClosed(nameSemantic) && (semanticKinds(nameSemantic) & bitOfKind(VAL.BOOL)) !== 0) continue
    const target = targetNames.get(name) ?? ANY_BIGINT
    const ready = list.every(def => {
      if (def.rhs == null) return true
      if (def.owner?.[0] !== '=') return false
      return edgeMaterializable(plannedOf(def.rhs), target, def.rhs)
    })
    if (ready) materializedNames.add(name)
  }

  const hostBoxParams = new Set()
  if (exportedIdentity) for (const [name, k] of params) {
    const sem = semanticNames.get(name) ?? semAll()
    const ready = boundary.params[k]?.stable === true || materializedNames.has(name)
    if (ready && targetNames.get(name) === BOXED_BIGINT &&
        !(semanticClosed(sem) && (semanticKinds(sem) & bitOfKind(VAL.BOOL)) !== 0))
      hostBoxParams.add(k)
  }
  const closureBoxParams = new Set()
  const closureAbiIdentity = options.generic
  if (closureAbiIdentity) for (const [name, k] of params) {
    const sem = semanticNames.get(name) ?? semAll()
    const ready = boundary.params[k]?.stable === true || materializedNames.has(name)
    if (ready && targetNames.get(name) === BOXED_BIGINT &&
        !(semanticClosed(sem) && (semanticKinds(sem) & bitOfKind(VAL.BOOL)) !== 0))
      closureBoxParams.add(k)
  }

  const materializedJoins = new WeakSet()
  const directResultNodes = new WeakSet(resultExprs.filter(Array.isArray))
  const emittedCandidate = node => {
    if (typeof node === 'string') {
      if (materializedNames.has(node)) return { rep: targetNames.get(node) ?? ANY_BIGINT, ready: true }
      const k = params.get(node)
      if (k != null && boundary.covered === true && boundary.params[k]?.stable === true)
        return { rep: targetNames.get(node) ?? ANY_BIGINT, ready: true }
    }
    if (Array.isArray(node)) {
      if (materializedJoins.has(node)) return { rep: nodeTarget.get(node) ?? ANY_BIGINT, ready: true }
      if (node[0] === '()' && typeof node[1] === 'string') {
        const callee = ctx.funcs.map.get(node[1])
        const calleeHandle = callee && ctx.plans.representations.get(callee)
        const calleeBody = calleeHandle && ctx.plans.representationData.get(calleeHandle)?.body
        if (calleeBody?.materializedResult === true)
          return { rep: calleeBody.resultTarget ?? ANY_BIGINT, ready: true }
      }
    }
    return { rep: currentOf(node), ready: false }
  }
  let joinChanged = true
  while (joinChanged) {
    joinChanged = false
    for (const [node, target] of nodeTarget) {
      if (materializedJoins.has(node) || directResultNodes.has(node) ||
          node[0] !== '?:' || target !== BOXED_BIGINT) continue
      const sem = semanticOf(node)
      if (semanticClosed(sem) && (semanticKinds(sem) & bitOfKind(VAL.BOOL)) !== 0) continue
      const left = emittedCandidate(node[2]), right = emittedCandidate(node[3])
      if (edgeMaterializable(left.rep, target, node[2], left.ready) &&
          edgeMaterializable(right.rep, target, node[3], right.ready)) {
        materializedJoins.add(node)
        joinChanged = true
      }
    }
  }

  // Propagate newly-materialized ternaries through their immediate plain-write
  // binding edges. Other producer dependencies stay deferred to their own
  // slices; this pass cannot accidentally admit an unrelated raw expression.
  for (const [name, list] of defs) {
    if (materializedNames.has(name) || ctx.scope.globals?.has(name)) continue
    if (params.has(name) && boundary.covered !== true) continue
    if (!list.some(def => Array.isArray(def.rhs) && materializedJoins.has(def.rhs))) continue
    const nameSemantic = semanticNames.get(name) ?? semAll()
    if (semanticClosed(nameSemantic) && (semanticKinds(nameSemantic) & bitOfKind(VAL.BOOL)) !== 0) continue
    const target = targetNames.get(name) ?? ANY_BIGINT
    if (list.every(def => {
      if (def.rhs == null) return true
      if (def.owner?.[0] !== '=') return false
      const source = emittedCandidate(def.rhs)
      return edgeMaterializable(source.rep, target, def.rhs, source.ready)
    })) materializedNames.add(name)
  }

  const resultHasClosedBool = semanticClosed(bodyResultSemantic) &&
    (semanticKinds(bodyResultSemantic) & bitOfKind(VAL.BOOL)) !== 0
  const materializedResult = boundary.covered === true && !resultHasClosedBool &&
    sig?.results?.length === 1 && sig.results[0] === 'f64' &&
    resultExprs.every(expr => expr == null ||
      edgeMaterializable(currentOf(expr), bodyResultTarget, expr))

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

/** Publish one opaque per-body RepresentationPlan after all local facts settle. */
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
  record.body = buildBodyData(ctx, identity, sig, body, localReps, record.boundary, planOptions)
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

const activeRep = (ctx, node, target) => {
  const handle = ctx.plans.representations.get(ctx.func.current)
  const body = handle && ctx.plans.representationData.get(handle)?.body
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
  if (Array.isArray(name) && name[0] === '?:') {
    const activeHandle = ctx.plans.representations.get(ctx.func.current)
    const activeBody = activeHandle && ctx.plans.representationData.get(activeHandle)?.body
    if (activeBody?.materializedJoins?.has(name)) return activeRep(ctx, name, true)
    return NO_BIGINT
  }
  if (Array.isArray(name) && name[0] === '()' && typeof name[1] === 'string') {
    const callee = ctx.funcs.map.get(name[1])
    const calleeHandle = callee && ctx.plans.representations.get(callee)
    const calleeRecord = calleeHandle && ctx.plans.representationData.get(calleeHandle)
    return calleeRecord?.body?.materializedResult === true
      ? calleeRecord.body.resultTarget ?? NO_BIGINT : NO_BIGINT
  }
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
  return edgeAction(activeEmittedRep(ctx, source), BOXED_BIGINT)
}

/** Frozen action for one generic closure/call_indirect argument slot. */
export function representationClosureArgAction(ctx, source) {
  if (programPlanRecord(ctx)?.bigint === false) return REP_EDGE_KEEP
  return edgeAction(activeEmittedRep(ctx, source), BOXED_BIGINT)
}

/** True when JS interop must box an actual BigInt at this export slot. */
export function representationHostBoxesParam(ctx, identity, index) {
  const handle = ctx.plans.representations.get(identity)
  return ctx.plans.representationData.get(handle)?.body?.hostBoxParams?.has(index) === true
}

/** Frozen action for one materialized ternary arm. */
export function representationJoinArmAction(ctx, join, arm) {
  const handle = ctx.plans.representations.get(ctx.func.current)
  const body = handle && ctx.plans.representationData.get(handle)?.body
  if (!body?.materializedJoins?.has(join)) return REP_EDGE_REJECT
  return edgeAction(activeEmittedRep(ctx, arm), activeRep(ctx, join, true))
}

/** Frozen action for one materialized return edge. */
export function representationReturnAction(ctx, source) {
  const handle = ctx.plans.representations.get(ctx.func.current)
  const record = handle && ctx.plans.representationData.get(handle)
  if (record?.body?.materializedResult !== true) return REP_EDGE_REJECT
  return edgeAction(activeEmittedRep(ctx, source), record.body.resultTarget ?? record.boundary.result.target)
}

/** Frozen action for one plain declaration/assignment write. */
export function representationBindingWriteAction(ctx, name, source) {
  const handle = ctx.plans.representations.get(ctx.func.current)
  const body = handle && ctx.plans.representationData.get(handle)?.body
  if (!body?.materializedNames?.has(name)) return REP_EDGE_REJECT
  return edgeAction(activeEmittedRep(ctx, source), activeRep(ctx, name, true))
}

const activeEmittedRep = (ctx, node) => {
  if (typeof node === 'string' || Array.isArray(node)) {
    const materialized = representationActiveMaterializedRep(ctx, node)
    if (materialized !== NO_BIGINT) return materialized
  }
  return activeRep(ctx, node, false)
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
        return callee ? representationResultTagRequired(ctx, callee, seen, strict) : null
      }
      if ((op === '.' || op === '?.') && typeof e[1] === 'string' && typeof e[2] === 'string')
        return ctx.schema.slotBigintProvenAt?.(e[1], e[2]) ? false
          : ctx.schema.slotBigintBoxedAt?.(e[1], e[2]) === true
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

export const representationProgramHasBigint = ctx => programPlanRecord(ctx)?.bigint === true
export const representationProgramRejectCount = ctx => programPlanRecord(ctx)?.rejects || 0

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
