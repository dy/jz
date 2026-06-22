/**
 * Signature narrowing — fixpoint analysis that mutates each user func's `sig`
 * based on call-site observations.
 *
 * Reads programFacts.callSites + valueUsed; mutates sig.params/results,
 * func.valResult, and programFacts.paramReps. Pure w.r.t. the AST — only
 * function `sig` records change.
 */

import { ctx, warn, err } from '../ctx.js'
import { isBlockBody, alwaysReturns, hasBareReturn, returnExprs } from '../ast.js'
import { isLiteralStr, I32_MIN, I32_MAX } from '../ir.js'
import {
  analyzeBody, findMutations, invalidateLocalsCache,
} from './analyze.js'
import { staticObjectProps } from '../static.js'
import { scanBoundedLoops, exprType, typedElemCtor } from '../type.js'
import { typedElemAux, ctorFromElemAux } from '../../layout.js'
import { observeProgramSlots } from './program-facts.js'
import { valTypeOf } from '../kind.js'
import { VAL, updateRep } from '../reps.js'
import {
  paramFactsOf, ensureParamRep, mergeParamFact,
} from '../param-reps.js'
import {
  inferArrElemSchema, inferArrElemValType,
  inferSchemaId, inferValType, inferTypedCtor, inferParams,
} from './infer.js'

const PTR_ABI_KINDS = new Set([VAL.OBJECT, VAL.SET, VAL.MAP, VAL.BUFFER])


function filterLiveCallSites(callSites, valueUsed) {
  if (!callSites.length) return

  const live = new Set()
  for (const f of ctx.func.list) {
    if (f.exported || valueUsed.has(f.name)) live.add(f.name)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const cs of callSites) {
      if (cs.callerFunc === null || live.has(cs.callerFunc.name)) {
        if (!live.has(cs.callee)) { live.add(cs.callee); changed = true }
      }
    }
  }

  let w = 0
  for (let r = 0; r < callSites.length; r++) {
    const cs = callSites[r]
    if (cs.callerFunc === null || live.has(cs.callerFunc.name)) callSites[w++] = cs
  }
  callSites.length = w
}

function buildCallerCtx() {
  const callerCtx = new Map()
  callerCtx.set(null, { callerLocals: ctx.scope.globalTypes, callerValTypes: ctx.scope.globalValTypes })
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeBody(func.body)
    for (const p of func.sig.params) if (!facts.locals.has(p.name)) facts.locals.set(p.name, p.type)
    callerCtx.set(func, { callerLocals: facts.locals, callerValTypes: facts.valTypes })
  }
  return callerCtx
}

function buildCallerElems(sliceKey) {
  const m = new Map()
  m.set(null, new Map())
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    m.set(func, analyzeBody(func.body)[sliceKey])
  }
  return m
}

function applyI32ParamSpecialization(paramReps, valueUsed, { skipTyped = false } = {}) {
  for (const func of ctx.func.list) {
    if (func.raw || valueUsed.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, r] of reps) {
      if (k === restIdx || k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (func.defaults?.[p.name] != null) continue
      // SIMD: a param passed a v128 (lane vector) at every call site is a v128 param.
      if (r.wasm === 'v128') { p.type = 'v128'; continue }
      if (r.wasm !== 'i32' || p.type === 'i32') continue
      if (skipTyped && r.val === VAL.TYPED) continue
      p.type = 'i32'
    }
  }
}

function validateIntConstParams(paramReps, valueUsed) {
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    if (!func.body) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    let candidates = null
    for (const [k, r] of reps) {
      if (r.intConst == null || k === restIdx) continue
      if (k >= func.sig.params.length) { r.intConst = null; continue }
      const pname = func.sig.params[k].name
      if (func.defaults?.[pname] != null) { r.intConst = null; continue }
      ;(candidates ||= new Map()).set(pname, r)
    }
    if (!candidates) continue
    const mutated = new Set()
    findMutations(func.body, new Set(candidates.keys()), mutated)
    for (const name of mutated) candidates.get(name).intConst = null
  }
}

function applyPointerParamAbi(paramReps, valueUsed, hardParamVal) {
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k] of reps) {
      // Re-fold call sites HARD (the shared val lattice is soft, so r.val may be a
      // partial consensus from typed sites alone) — only specialize when every site
      // proves the same pointer kind.
      const hv = hardParamVal(func.name, k)
      if (!PTR_ABI_KINDS.has(hv)) continue
      if (k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue
      if (func.defaults?.[p.name] != null) continue
      p.type = 'i32'
      p.ptrKind = hv
    }
  }
}

function narrowableFuncs(valueUsed) {
  return ctx.func.list.filter(f =>
    !f.raw && !valueUsed.has(f.name) && f.sig.results.length === 1
  )
}

function refreshCallerValTypes(callerCtx) {
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const entry = callerCtx.get(func)
    if (entry) entry.callerValTypes = analyzeBody(func.body).valTypes
  }
}

// Per-caller typed-elem context: the caller's body-local typed arrays, layered
// over the module's typed-array globals so a call like `f(globalArr)` resolves
// `globalArr`'s ctor (inferTypedCtor reads only this map for a bare-name arg).
// A global is visible UNLESS the caller shadows the name with a param or local
// of its own — only then could the name denote a non-typed value. Globals are
// sound to consult: globalTypedElem holds a name only when EVERY assignment to
// it is the same single typed-array ctor (scope.js invalidates on any conflict),
// so it can't denote a different kind at the call site.
function callerTypedElemsFor(func, globalTE) {
  const local = analyzeBody(func.body).typedElems
  if (!globalTE.size) return local
  const shadowed = new Set(analyzeBody(func.body).locals.keys())
  for (const p of func.sig?.params || []) shadowed.add(p.name)
  const merged = new Map()
  for (const [k, v] of globalTE) if (!shadowed.has(k)) merged.set(k, v)
  for (const [k, v] of local) merged.set(k, v)  // local typed binding shadows the global
  return merged
}

function buildCallerTypedCtx() {
  const callerTypedCtx = new Map()
  const globalTE = ctx.scope.globalTypedElem || new Map()
  callerTypedCtx.set(null, globalTE)
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    callerTypedCtx.set(func, callerTypedElemsFor(func, globalTE))
  }
  return callerTypedCtx
}

function applyTypedPointerParamAbi(paramReps, valueUsed) {
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, r] of reps) {
      const ctor = r.typedCtor
      if (ctor == null) continue
      if (k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue
      if (func.defaults?.[p.name] != null) continue
      const aux = typedElemAux(ctor)
      if (aux == null) continue
      p.type = 'i32'
      p.ptrKind = VAL.TYPED
      p.ptrAux = aux
    }
  }
}

function enrichCallerValTypesFromPointerParams(callerCtx) {
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const entry = callerCtx.get(func)
    if (!entry) continue
    for (const p of func.sig.params) {
      if (p.ptrKind == null) continue
      if (entry.callerValTypes.has(p.name)) continue
      entry.callerValTypes.set(p.name, p.ptrKind)
    }
  }
}

function refreshCallerLocals(callerCtx) {
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    // Seed pointer-narrowed params' val-kind so analyzeBody recognises e.g.
    // `n = arr.length` (arr a TYPED/BUFFER pointer param) as an i32 local — without
    // this, post-G `refreshCallerLocals` still walks bodies with arr untyped, the
    // length stays f64, and any callee taking that length never gets an i32 param
    // (heapsort→siftDown's `end`). analyzeFuncForEmit re-seeds + re-invalidates at
    // emit time, so this transient localReps doesn't leak past narrowing.
    ctx.func.localReps = new Map()
    for (const p of func.sig.params) if (p.ptrKind != null) ctx.func.localReps.set(p.name, { val: p.ptrKind })
    invalidateLocalsCache(func.body)
    const fresh = analyzeBody(func.body).locals
    for (const p of func.sig.params) if (!fresh.has(p.name)) fresh.set(p.name, p.type)
    callerCtx.get(func).callerLocals = fresh
  }
  ctx.func.localReps = null
}

function resetParamWasmFacts(paramReps) {
  for (const m of paramReps.values()) for (const r of m.values()) r.wasm = undefined
}

/**
 * Phase E: numeric result narrowing.
 *
 * For every narrowable func whose body returns only i32-typed expressions,
 * narrow sig.results[0] to 'i32'. An *unsigned* tail flips sig.unsignedResult so
 * the call-site rebox uses f64.convert_i32_u and preserves [0, 2^32) range.
 * A tail is unsigned when it is a top-level `(x >>> 0)` OR a call to a function
 * already narrowed `unsignedResult` — the latter propagates the flag through
 * helper chains (`const u = x => (x|0)>>>0; const main = x => u(x)`), which a
 * literal-`>>>`-only check would miss, reboxing main's result signed and
 * silently turning `4294967295` into `-1`.
 *
 * Sign must be consistent across *all* tails: the same i32 bit pattern maps to
 * two different JS numbers under signed vs unsigned conversion, so a function
 * mixing signed (`x|0`) and unsigned (`x>>>0`) tails cannot be reboxed with a
 * single boundary flag. Such functions are left at f64 — the body then converts
 * each tail with its own sign. (Pre-fix, a top-level `>>>` next to a signed tail
 * narrowed unsigned and corrupted the signed branch.)
 *
 * Fixpoint: a call to another narrowed func contributes i32; iterate until
 * stable so chains of i32-only helpers all narrow together. exprType already
 * consults ctx.func.map for narrowed user-function results plus the
 * Math.imul/Math.clz32/charCodeAt stdlib subset.
 *
 * Safe for exports — boundary wrapper restores the f64 JS ABI. `return;`
 * (bare) is preserved as f64; multi-value / raw / value-used are skipped by
 * the narrowable filter.
 */
function narrowI32Results(funcs) {
  // A return tail is unsigned-valued when it is a top-level `>>>` or a call to
  // a function already proven unsignedResult. Other i32 tails are signed.
  const isUnsignedTail = (e) => Array.isArray(e) && (
    e[0] === '>>>' ||
    (e[0] === '()' && typeof e[1] === 'string' && ctx.func.map?.get(e[1])?.sig?.unsignedResult === true)
  )
  let changed = true
  while (changed) {
    changed = false
    for (const func of funcs) {
      if (func.sig.results[0] === 'i32' || func.sig.results[0] === 'v128') continue
      const body = func.body
      if (isBlockBody(body) && hasBareReturn(body)) continue
      const exprs = returnExprs(body)
      if (!exprs.length) continue
      const savedCurrent = ctx.func.current
      ctx.func.current = func.sig
      const locals = isBlockBody(body) ? analyzeBody(body).locals : new Map()
      for (const p of func.sig.params) if (!locals.has(p.name)) locals.set(p.name, p.type)
      const allV128 = exprs.every(e => exprType(e, locals) === 'v128')
      const allI32 = !allV128 && exprs.every(e => exprType(e, locals) === 'i32')
      const anyUnsigned = exprs.some(isUnsignedTail)
      const allUnsigned = exprs.every(isUnsignedTail)
      ctx.func.current = savedCurrent
      // SIMD: every tail returns a lane vector → v128 result.
      if (allV128) {
        func.sig.results = ['v128']
        changed = true
      } else if (allI32 && (!anyUnsigned || allUnsigned)) {   // sign-consistent i32 tails
        func.sig.results = ['i32']
        if (allUnsigned) func.sig.unsignedResult = true
        changed = true
      }
    }
  }
}

/**
 * Phase E2: VAL-kind result inference.
 *
 * When every return-tail resolves to the same VAL.* kind, record it on
 * func.valResult so call-site valTypeOf inherits it (enables static dispatch
 * on .length / [i] / .prop through the call chain). Fixpoint propagates
 * through helper chains. Exports are safe — same boundary-wrapper guarantee
 * as numeric narrowing.
 */
function narrowValResults(funcs) {
  const valTypeOfWithCalls = (expr, localValTypes) => {
    if (expr == null) return null
    if (typeof expr === 'string') return localValTypes?.get(expr) || ctx.scope.globalValTypes?.get(expr) || null
    if (!Array.isArray(expr)) return valTypeOf(expr)
    const [op, ...args] = expr
    if (op === '()' && typeof args[0] === 'string') {
      const f = ctx.func.map.get(args[0])
      if (f?.valResult) return f.valResult
    }
    if (op === '?:') {
      const a = valTypeOfWithCalls(args[1], localValTypes), b = valTypeOfWithCalls(args[2], localValTypes)
      return a && a === b ? a : null
    }
    if (op === '&&' || op === '||') {
      const a = valTypeOfWithCalls(args[0], localValTypes), b = valTypeOfWithCalls(args[1], localValTypes)
      return a && a === b ? a : null
    }
    return valTypeOf(expr)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const func of funcs) {
      if (func.valResult) continue
      const body = func.body
      const isBlock = isBlockBody(body)
      if (isBlock && hasBareReturn(body)) continue
      const exprs = returnExprs(body)
      if (!exprs.length) continue
      const localValTypes = isBlock ? analyzeBody(body).valTypes : new Map()
      const vt0 = valTypeOfWithCalls(exprs[0], localValTypes)
      if (!vt0) continue
      const allSame = exprs.every(e => valTypeOfWithCalls(e, localValTypes) === vt0)
      if (allSame) { func.valResult = vt0; changed = true }
    }
  }
}

const PTR_RESULT_KINDS_NOAUX = new Set([VAL.SET, VAL.MAP, VAL.BUFFER])

// Per-body local elemAux map: scans `let/const x = new TypedArray(...)` decls so a return
// like `let a = new Float64Array(...); return a` resolves to a constant aux.
function localElemAuxMap(body) {
  const m = new Map()
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === '=>') return
    if ((op === 'let' || op === 'const') && n.length > 1) {
      for (let i = 1; i < n.length; i++) {
        const a = n[i]
        if (Array.isArray(a) && a[0] === '=' && typeof a[1] === 'string') {
          const aux = typedElemAux(typedElemCtor(a[2]))
          if (aux != null) m.set(a[1], aux)
        }
      }
    }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body)
  return m
}

function typedAuxOfReturn(expr, localElemMap) {
  if (typeof expr === 'string') return localElemMap?.get(expr) ?? null
  if (!Array.isArray(expr)) return null
  const [op, ...args] = expr
  if (op === '()' && typeof args[0] === 'string') {
    if (args[0].startsWith('new.')) {
      const ctor = typedElemCtor(expr)
      return ctor != null ? typedElemAux(ctor) : null
    }
    const f = ctx.func.map.get(args[0])
    if (f?.valResult === VAL.TYPED && f.sig.ptrAux != null) return f.sig.ptrAux
    return null
  }
  if (op === '?:') {
    const a = typedAuxOfReturn(args[1], localElemMap)
    const b = typedAuxOfReturn(args[2], localElemMap)
    return a != null && a === b ? a : null
  }
  if (op === '&&' || op === '||') {
    const a = typedAuxOfReturn(args[0], localElemMap)
    const b = typedAuxOfReturn(args[1], localElemMap)
    return a != null && a === b ? a : null
  }
  return null
}

/**
 * Phase E3: pointer result narrowing.
 *
 * For narrowable funcs whose valResult is a non-ambiguous pointer kind with a
 * constant aux, narrow sig.results[0] from f64 to i32 and tag sig.ptrKind/.ptrAux.
 * Eliminates the f64.reinterpret_i64+i64.or rebox at every return and the
 * matching unbox dance at every call site that uses the value as a pointer.
 *
 * Aux strategy:
 *   - SET/MAP/BUFFER: aux always 0 — no per-callsite preservation needed.
 *   - OBJECT: aux is schema-id; narrow only when all return exprs share a constant
 *     schema (literal, schemaId-bound param, module-bound var, or call to another
 *     OBJECT-narrowed func). Caller picks aux up via callIR.ptrAux → readVar →
 *     localReps.schemaId, restoring property-slot dispatch through the call boundary.
 *   - TYPED: aux is elem-type; require all return tails to agree on a single aux.
 *
 * Skipped: ARRAY forwards on realloc, STRING dual-encoded SSO/heap, CLOSURE
 * (aux carries funcIdx for call_indirect). Body must guarantee-return so the
 * fallthrough fallback can't produce a wrong-typed undef.
 *
 * Fixpoint: a chain `outer → inner → {a,b}` needs inner to narrow first so
 * outer's call to inner contributes a known schema-id.
 */
/** A function whose every return is the same parameter that was pointer-ABI
 *  narrowed to an unboxed i32 (p.ptrKind set). Returns that param, else null. */
function passthroughPtrParam(func) {
  const exprs = returnExprs(func.body)
  if (!exprs.length) return null
  const name = exprs[0]
  if (typeof name !== 'string' || !exprs.every(e => e === name)) return null
  return func.sig.params.find(p => p.name === name && p.ptrKind) || null
}

function narrowPointerResults(funcs, paramReps) {
  let changed = true
  while (changed) {
    changed = false
    for (const func of funcs) {
      // Pointer pass-through: every return is the same parameter that
      // applyPointerParamAbi narrowed to an unboxed i32 pointer. The result IS that
      // pointer, so its sig must carry the param's ptrKind (+ schemaId for OBJECT).
      // Without this the result is a bare i32 the caller numeric-converts
      // (`f64.convert_i32_s`) instead of reboxing — dropping the schema-id so a
      // later `.prop` read mis-resolves to `undefined`. narrowValResults can't see
      // this (it reads body-locals, not param facts) and narrowI32Results steals it
      // as a numeric i32, so resolve it here from the settled param lattice.
      if (func.sig.ptrKind == null) {
        const pp = passthroughPtrParam(func)
        if (pp) {
          const aux = pp.ptrKind === VAL.OBJECT
            ? paramFactsOf(paramReps, func, 'schemaId')?.get(pp.name) ?? null
            : null
          // OBJECT needs a known schema-id to rebox; a polymorphic pass-through
          // (conflicting schemas → null) keeps its current handling.
          if (pp.ptrKind !== VAL.OBJECT || aux != null) {
            func.sig.results = ['i32']
            func.sig.ptrKind = pp.ptrKind
            func.valResult = pp.ptrKind
            if (aux != null) func.sig.ptrAux = aux
            changed = true
            continue
          }
        }
      }
      if (!func.valResult) continue
      if (func.sig.results[0] !== 'f64') continue
      const isBlock = isBlockBody(func.body)
      if (isBlock && !alwaysReturns(func.body)) continue
      if (PTR_RESULT_KINDS_NOAUX.has(func.valResult)) {
        func.sig.results = ['i32']
        func.sig.ptrKind = func.valResult
        changed = true
        continue
      }
      const exprs = returnExprs(func.body)
      if (!exprs.length) continue
      if (func.valResult === VAL.OBJECT) {
        const paramSchemasMap = paramFactsOf(paramReps, func, 'schemaId')
        const sid0 = inferSchemaId(exprs[0], paramSchemasMap)
        if (sid0 == null) continue
        if (!exprs.every(e => inferSchemaId(e, paramSchemasMap) === sid0)) continue
        func.sig.results = ['i32']
        func.sig.ptrKind = VAL.OBJECT
        func.sig.ptrAux = sid0
        changed = true
      } else if (func.valResult === VAL.TYPED) {
        const localMap = isBlock ? localElemAuxMap(func.body) : null
        const aux0 = typedAuxOfReturn(exprs[0], localMap)
        if (aux0 == null) continue
        if (!exprs.every(e => typedAuxOfReturn(e, localMap) === aux0)) continue
        func.sig.results = ['i32']
        func.sig.ptrKind = VAL.TYPED
        func.sig.ptrAux = aux0
        changed = true
      }
    }
  }
}

function createPhaseState() {
  const callerCtx = buildCallerCtx()
  const elemCtx = new Map()
  let callerTypedCtx = null

  const clearDerived = () => {
    elemCtx.clear()
    callerTypedCtx = null
  }

  return {
    callerCtx,

    callerElems(sliceKey) {
      let m = elemCtx.get(sliceKey)
      if (!m) { m = buildCallerElems(sliceKey); elemCtx.set(sliceKey, m) }
      return m
    },

    callerTyped() {
      callerTypedCtx ||= buildCallerTypedCtx()
      return callerTypedCtx
    },

    invalidateBodyFacts() {
      for (const func of ctx.func.list) {
        if (func.body && !func.raw) invalidateLocalsCache(func.body)
      }
      clearDerived()
    },

    refreshValTypes() {
      refreshCallerValTypes(callerCtx)
      clearDerived()
    },

    refreshLocals() {
      refreshCallerLocals(callerCtx)
      clearDerived()
    },
  }
}

const _FIELD_TO_SLICE = {
  arrayElemSchema: 'arrElemSchemas',
  arrayElemValType: 'arrElemValTypes',
}

/** Propagate Array<T> element facts from return paths into caller paramReps (phase G). */
function narrowReturnArrayElems(field, paramReps, valueUsed) {
  const sliceKey = _FIELD_TO_SLICE[field]
  const targets = ctx.func.list.filter(f =>
    !f.raw && !f.exported && !valueUsed.has(f.name) &&
    f.valResult === VAL.ARRAY && f[field] == null
  )
  let changed = true
  while (changed) {
    changed = false
    for (const f of targets) invalidateLocalsCache(f.body)
    for (const func of targets) {
      if (func[field] != null) continue
      const isBlock = isBlockBody(func.body)
      if (isBlock && !alwaysReturns(func.body)) continue
      const exprs = returnExprs(func.body)
      if (!exprs.length) continue
      const savedLocals = ctx.func.locals
      const facts = analyzeBody(func.body)
      ctx.func.locals = new Map(facts.locals)
      for (const p of func.sig.params) if (!ctx.func.locals.has(p.name)) ctx.func.locals.set(p.name, p.type)
      const localElems = facts[sliceKey]
      ctx.func.locals = savedLocals
      const paramElemMap = paramFactsOf(paramReps, func, field) || new Map()
      const resolveExpr = (expr) => {
        if (typeof expr === 'string') {
          if (localElems.has(expr)) {
            const v = localElems.get(expr)
            if (v != null) return v
          }
          if (paramElemMap.has(expr)) return paramElemMap.get(expr)
          return null
        }
        if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
          const f = ctx.func.map?.get(expr[1])
          if (f?.[field] != null) return f[field]
        }
        if (Array.isArray(expr) && expr[0] === '?:') {
          const a = resolveExpr(expr[2]), b = resolveExpr(expr[3])
          return a != null && a === b ? a : null
        }
        if (Array.isArray(expr) && (expr[0] === '&&' || expr[0] === '||')) {
          const a = resolveExpr(expr[1]), b = resolveExpr(expr[2])
          return a != null && a === b ? a : null
        }
        return null
      }
      const v0 = resolveExpr(exprs[0])
      if (v0 == null) continue
      if (!exprs.every(e => resolveExpr(e) === v0)) continue
      func[field] = v0
      changed = true
    }
  }
}

export default function narrowSignatures(programFacts, ast) {
  const { callSites, valueUsed, paramReps, hasSchemaLiterals } = programFacts

  // Reachability filter: dead callerFuncs (e.g. unused stdlib helpers from bundled
  // modules) shouldn't poison narrowing of live functions. Without this, a never-
  // executed call like `checksumF64 → mix(h, u[i])` would force mix's `x` rep to
  // bimorphic (f64 ∪ i32) and block i32 narrowing of mix's hot caller (runKernel).
  // Live = exported ∪ value-used ∪ transitively reached from those + top-level.
  // Top-level call sites have callerFunc === null and are unconditionally live.
  filterLiveCallSites(callSites, valueUsed)

  // D: Call-site type propagation — infer param types from how functions are called.
  // Drives off `callSites` collected during the ProgramFacts walk; no AST re-walking.
  // For non-exported internal functions, if all call sites agree on a param's type,
  // seed the param's val rep (ctx.func.localReps) during per-function compilation.
  // Also infer i32/f64 WASM type — when all call sites pass i32 for a param, specialize
  // sig.params[k].type to i32 (no default, no rest, not exported, not value-used).
  // Also propagate schema ID — when all call sites pass objects with the same schema,
  // bind the callee's param to that schema so `p.x` becomes a direct slot load.
  // Inference helpers (inferValType/inferSchemaId/inferArr*/inferTypedCtor)
  // live in infer.js — pure AST→fact resolvers shared across fixpoint phases.
  // Per-caller analysis is stable across fixpoint iterations — precompute once.
  // callerCtx[null] (top-level) uses module globals for both locals and valTypes.
  const phase = createPhaseState()
  const { callerCtx } = phase
  const intConstArg = (arg) => {
    let raw = null
    if (typeof arg === 'number') raw = arg
    else if (Array.isArray(arg) && arg[0] == null && typeof arg[1] === 'number') raw = arg[1]
    else if (Array.isArray(arg) && arg[0] === 'u-' && typeof arg[1] === 'number') raw = -arg[1]
    else if (typeof arg === 'string' && ctx.scope.constInts?.has(arg)) raw = ctx.scope.constInts.get(arg)
    return (raw != null && Number.isInteger(raw) && raw >= I32_MIN && raw <= I32_MAX) ? raw : null
  }

  // Per-call-site inference context for a narrowable callee. null for call sites
  // whose callee is exported / value-used / unknown, or whose caller has no ctx.
  const siteState = (cs) => {
    const { callee, argList, callerFunc } = cs
    const func = ctx.func.map.get(callee)
    if (!func || func.exported || valueUsed.has(callee)) return null
    const ctxEntry = callerCtx.get(callerFunc)
    if (!ctxEntry) return null
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    const paramFacts = new Map()
    return {
      callee, callerFunc, argList, func, restIdx,
      callerLocals: ctxEntry.callerLocals,
      callerValTypes: ctxEntry.callerValTypes,
      callerParamFacts(key) {
        if (!paramFacts.has(key)) paramFacts.set(key, paramFactsOf(paramReps, callerFunc, key))
        return paramFacts.get(key)
      },
    }
  }
  const runCallsiteLattice = (rules) => {
    for (let s = 0; s < callSites.length; s++) {
      const state = siteState(callSites[s])
      if (!state) continue
      const { func, argList } = state
      for (let k = 0; k < func.sig.params.length; k++) {
        const r = ensureParamRep(paramReps, state.callee, k)
        if (k >= argList.length) { for (const rule of rules) rule.missing(r, k, state); continue }
        for (const rule of rules) rule.apply(r, argList[k], k, state)
      }
    }
  }

  const poison = field => r => { r[field] = null }
  // Default-aware val inference. Adds two fallbacks beyond inferValType's
  // body-local `callerValTypes` lookup so a hot recursive helper like
  // `uleb(n, buffer = []) { ... return uleb(n, buffer) }` resolves the
  // recursive `buffer` arg to VAL.ARRAY (via callerParamFacts on iter 2,
  // or via the caller's own default expression on iter 1).
  const inferValAtSite = (arg, state) => {
    const v = inferValType(arg, state.callerValTypes)
    if (v != null) return v
    if (typeof arg !== 'string') return null
    const fromParam = state.callerParamFacts('val')?.get(arg)
    if (fromParam != null) return fromParam
    const def = state.callerFunc?.defaults?.[arg]
    return def != null ? valTypeOf(def) || null : null
  }
  // Substitute the default expression for a missing positional arg, so
  // `uleb(n)` doesn't poison buffer.val despite `buffer = []` provably
  // yielding VAL.ARRAY at runtime — unblocks inline ARRAY len/push fast
  // paths in encode.js's hot uleb/i32/i64 helpers.
  const defaultArg = (state, k) => {
    const pname = state.func.sig.params[k]?.name
    return pname != null ? state.func.defaults?.[pname] : null
  }
  // Hard consensus val for (funcName, param k): the kind every live call site
  // agrees on, or null if any site is untyped / missing / disagrees. The shared
  // `val` lattice runs SOFT (a value can come from typed sites alone, untyped
  // sites skipped); a consumer that *mutates the signature* off val must instead
  // ask this — it re-folds the sites HARD so it never specializes a param that
  // some call site can't prove. (applyPointerParamAbi is that consumer.)
  const hardParamVal = (funcName, k) => {
    let consensus
    for (let s = 0; s < callSites.length; s++) {
      if (callSites[s].callee !== funcName) continue
      const state = siteState(callSites[s])
      if (!state) continue
      if (k >= state.argList.length) return null         // missing → undefined at runtime
      const v = inferValAtSite(state.argList[k], state)
      if (v == null) return null                         // an untyped site ⇒ not specializable
      if (consensus === undefined) consensus = v
      else if (consensus !== v) return null              // disagreement ⇒ TOP
    }
    return consensus ?? null
  }
  // `soft` makes apply treat a null inference as BOTTOM (skip — "this site can't
  // tell yet") instead of TOP (poison): the monotone meet. A soft field never
  // needs clearStickyNull; its consumers either re-validate hard (hardParamVal)
  // or read it after a final hard settling sweep. `missing` poisons regardless —
  // an omitted arg with no default is undefined at runtime, a real reason not to
  // specialize, and must stay sticky.
  const mergeRule = (field, infer, soft = false) => ({
    missing(r, k, state) {
      if (r[field] === null) return
      const def = defaultArg(state, k)
      if (def != null) mergeParamFact(r, field, infer(def, k, state))
      else r[field] = null
    },
    apply(r, arg, k, state) {
      if (r[field] === null) return
      const v = infer(arg, k, state)
      if (v == null) { if (!soft) r[field] = null; return }
      mergeParamFact(r, field, v)
    },
  })
  const runFixpoint = () => runCallsiteLattice([
    // val runs SOFT (monotone): a TYPED param's val only becomes inferable after the
    // typedCtor fixpoint + pointer-ABI enrichment, so an early hard merge would
    // sticky-poison it (the old clearStickyNull undid that). Soft leaves it BOTTOM;
    // the post-enrichment rerun fills it in. applyPointerParamAbi re-validates via
    // hardParamVal; a final hard sweep settles val for emit + late consumers.
    mergeRule('val', (arg, _k, state) => inferValAtSite(arg, state), true),
    {
      missing: poison('wasm'),
      apply(r, arg, _k, state) {
        if (r.wasm === null) return
        const wt = exprType(arg, state.callerLocals)
        if (r.wasm === undefined) r.wasm = wt
        else if (r.wasm !== wt) r.wasm = null
      },
    },
    mergeRule('schemaId', (arg, _k, state) => inferSchemaId(arg, state.callerParamFacts('schemaId'))),
    {
      missing: poison('intConst'),
      apply(r, arg, k, state) {
        if (k === state.restIdx) r.intConst = null
        else if (r.intConst !== null) mergeParamFact(r, 'intConst', intConstArg(arg))
      },
    },
  ])
  // Transitive ctor/schema propagation down call chains. A naive single-pass
  // mergeRule poisons a callee's param on the *first* sweep if the caller's own
  // param (the very thing that supplies the ctor) hasn't been typed yet — and the
  // poison is sticky, so later sweeps can't recover. Two-pass was the old patch;
  // it still loses any chain deeper than `main→f→g→h` (e.g. heapsort's siftDown).
  // Fix: iterate a *soft* merge — propagate known ctors, treat "can't tell yet"
  // as skip (no poison) — to a fixpoint, then one *hard* validating sweep that
  // poisons params whose call sites still can't be proven (genuinely-untyped args).
  const runArrElemFixpoint = (field, inferFn, elemsCtxMap) => {
    const infer = (arg, _k, state) => inferFn(arg, elemsCtxMap.get(state.callerFunc), state.callerParamFacts(field))
    let changed
    const bump = (r, v) => { if (v == null || r[field] === null) return; const b = r[field]; mergeParamFact(r, field, v); if (r[field] !== b) changed = true }
    const soft = {
      missing(r, k, state) { const def = defaultArg(state, k); if (def != null) bump(r, infer(def, k, state)) },
      apply(r, arg, k, state) { bump(r, infer(arg, k, state)) },
    }
    do { changed = false; runCallsiteLattice([soft]) } while (changed)
    runCallsiteLattice([mergeRule(field, infer)])
  }
  const runArrFixpoint = () => runArrElemFixpoint('arrayElemSchema', inferArrElemSchema, phase.callerElems('arrElemSchemas'))
  const runArrValTypeFixpoint = () => runArrElemFixpoint('arrayElemValType', inferArrElemValType, phase.callerElems('arrElemValTypes'))

  // E2 (VAL-kind result inference) FIRST: it's body-driven and call-chain self-
  // fixpointing — independent of the param lattice and the narrowing acts (it reads
  // analyzeBody valTypes + callees' valResult, never paramReps or sig.params). Running
  // it up front means a call arg like `initRows()` resolves to its VAL.ARRAY result on
  // the param fixpoint's FIRST pass, so val/schemaId never get the can't-tell-yet
  // poison that clearStickyNull used to un-stick (root B). Numeric (i32) result
  // narrowing stays below — it benefits from i32 params being narrowed first.
  const funcsWithNarrowableResult = narrowableFuncs(valueUsed)
  narrowValResults(funcsWithNarrowableResult)
  runFixpoint()
  runFixpoint()

  // Apply i32 specialization: for non-value-used funcs with consistent i32 call
  // sites and no defaults/rest at that position, narrow sig.params[k].type.
  // Exports too — boundary wrapper handles the f64→i32 truncation at the JS edge.
  applyI32ParamSpecialization(paramReps, valueUsed)

  // intConst validation: a param marked with a unanimous integer literal at every call
  // site is only safe to substitute if the body never reassigns it. Clear intConst on any
  // param whose name appears on the LHS of an assignment / `++` / `--`. Skip exported
  // (callable from JS with arbitrary value), value-used (closure callees), raw, defaulted,
  // and rest params — same exclusions as the wasm-narrowing pass above.
  validateIntConstParams(paramReps, valueUsed)

  // Pointer-ABI specialization: for non-forwarding pointer params consistent across
  // call sites, narrow from NaN-boxed f64 to i32 offset. Eliminates per-call __ptr_offset
  // extraction + f64→i64→i32 reinterpret chains that dominate watr-style compilers.
  // Safety:
  //   - exclude ARRAY (forwards on realloc — f64 NaN-box is a stable identity) and
  //     STRING (SSO vs heap dual encoding depends on ptr-type bits we'd drop).
  //   - exclude CLOSURE (aux carries funcIdx, needed for call_indirect) and TYPED
  //     (aux carries element-type, handled separately by applyTypedPointerParamAbi).
  //   - exclude params with defaults (nullish sentinel needs the f64 NaN space).
  //   - exclude rest position (array pack/unpack stays f64).
  applyPointerParamAbi(paramReps, valueUsed, hardParamVal)

  // E: numeric (i32) result narrowing — kept here, after applyI32ParamSpecialization,
  // so a body returning `param + 1` sees param already narrowed to i32. (E2 / VAL
  // result inference ran up front — see above.) funcsWithNarrowableResult hoisted there.
  narrowI32Results(funcsWithNarrowableResult)

  // Now that E2 set `valResult` on funcs, narrow per-func `arrayElemSchema` for
  // VAL.ARRAY-returning funcs (via push observations + call chains). Then re-run the
  // D-pass arrayElemSchema/val fixpoints so `const rows = initRows()` in main
  // resolves to VAL.ARRAY (lets runKernel pick up r.val=ARRAY) and its arr-elem
  // schema (sets paramReps[runKernel][0].arrayElemSchema=sid).
  // Cache invalidation: analyzeBody.valTypes is body-keyed, and entries cached
  // during the first D pass have stale (null) `valTypeOf(call)` results because
  // valResult was unset back then.
  narrowReturnArrayElems('arrayElemSchema', paramReps, valueUsed)
  narrowReturnArrayElems('arrayElemValType', paramReps, valueUsed)
  phase.invalidateBodyFacts()
  phase.refreshValTypes()
  // Re-observe schema slot val-types now that E2 has set `valResult` on user
  // funcs. First pass runs in collectProgramFacts before valResult is known, so
  // a slot like `cs` in `{ ..., cs }` (where `cs = checksum(out)`) gets observed
  // as null. observeSlot's first-wins-then-clash rule lets a later precise
  // observation upgrade `undefined` → NUMBER without poisoning earlier
  // monomorphic observations.
  if (hasSchemaLiterals) observeProgramSlots(ast)
  // Re-run with refreshed callerValTypes + the new program-slot observations. (No
  // clearStickyNull needed: valResult was known before the first pass — see E2 hoist
  // above — so val/schemaId never got the can't-tell-yet poison this used to undo.)
  runFixpoint()
  // Now that .val is refreshed, dedicated arr-elem-schema fixpoint.
  runArrFixpoint()
  runArrFixpoint()
  // Parallel arr-elem-val fixpoint (NUMBER/STRING/…). Twice for transitive closure
  // through helper chains: `init()→main→runKernel`.
  runArrValTypeFixpoint()
  runArrValTypeFixpoint()
  // E3: pointer-kind result narrowing — once valResult is set, lift the wasm
  // return type to i32 + ptrKind/ptrAux when aux is statically resolvable.
  narrowPointerResults(funcsWithNarrowableResult, paramReps)

  // F: Cross-call typed-array element ctor propagation. Runs AFTER E3 so that
  // calls to user functions returning a TYPED-narrowed pointer (with constant
  // ptrAux, e.g. mkInput → Float64Array) contribute their element type to the
  // caller's local typedElem map. Result: callees pick up `ctx.types.typedElem`
  // for their own params and `arr[i]` reads emit a direct `f64.load` instead of
  // the runtime `__is_str_key + __typed_idx` dispatch — closes the largest
  // chunk of the JS→wasm gap on f64-heavy hot loops.
  // (Helper `inferTypedCtor` lives in src/infer.js — the call-site mirror
  //  of body-walk evidence — and is reused by the bimorphic-typed
  //  specialization pass below; `ctorFromElemAux` stays in analyze.js next
  //  to its encode/decode partner.)
  // Per-caller typed-elem map, recomputed now that E3 has tagged helper sigs.
  // Cache invalidation: analyzeBody.typedElems reads `ctx.func.map.get(...).sig.ptrKind`
  // for `let x = mkInput(...)` decls; entries cached during the initial walk
  // (before E3 ran) are stale (mkInput's ptrKind was unset then).
  phase.invalidateBodyFacts()
  const callerTypedCtx = phase.callerTyped()
  // Two-pass fixpoint: lets a caller's params, once typed, propagate further to
  // its own callees (e.g. if `outer(buf)` calls `inner(buf)` and we learn `buf`
  // for outer, the second pass picks it up for inner). Reuses runArrElemFixpoint
  // (same shape — field/inferFn/elemsCtxMap parameterization).
  const runTypedFixpoint = () => runArrElemFixpoint('typedCtor', inferTypedCtor, callerTypedCtx)
  runTypedFixpoint()
  runTypedFixpoint()

  // G: TYPED pointer-ABI narrowing — once .typedCtor agrees on a single
  // ctor across all call sites, narrow the param from NaN-boxed f64 to raw
  // i32 offset (with ptrAux carrying the elem-type bits). Eliminates the
  // per-read `i32.wrap_i64 (i64.reinterpret_f64 (local.get $arr))` unbox dance
  // that today dominates hot loops dominated by typed-array indexing.
  // Call sites coerce via coerceArg → ptrOffsetIR(arg, VAL.TYPED).
  // Safety: same exclusions as the OBJECT/SET/MAP/BUFFER narrowing above —
  // exported, value-used, raw, defaults, rest position.
  applyTypedPointerParamAbi(paramReps, valueUsed)

  // H: Post-F/G re-fixpoint — propagates VAL kinds through bimorphic call sites
  // where ptrKind narrowed but ptrAux disagreed (e.g. `sum(f64arr)` and `sum(i32arr)`
  // → both VAL.TYPED, different ctors). Without this, callerValTypes carries no entry
  // for caller's params, so inferValType returned null and (under the old hard merge)
  // sticky-poisoned the param's val. The soft val merge leaves it BOTTOM instead, so
  // this rerun — now that enrichment has put VAL.TYPED into callerValTypes — simply
  // fills it in (array.js then skips __is_str_key + __str_idx dispatch on `arr[i]`).
  enrichCallerValTypesFromPointerParams(callerCtx)
  runFixpoint()

  // I: Post-E re-narrow of numeric (i32) params. The first numeric narrowing pass
  // ran before E narrowed any result types, so callerLocals saw `let h = mix(...)`
  // as f64 (mix's result was f64 then). After E narrowed mix's result to i32,
  // exprType (which now consults func.sig.results for user calls) sees `h` as i32.
  // Refresh callerLocals + clear sticky-null wasm + re-run fixpoint + re-apply
  // numeric narrowing to propagate i32 through chains of i32-only helpers
  // (callback bench: mix is FNV — params and result all i32-shaped, but inferred
  // only after E phase narrowed mix's result).
  phase.refreshLocals()
  // Reset wasm field unconditionally — first pass populated it from stale callerLocals
  // (where `let h = mix(...)` widened h to f64 because mix's result wasn't narrowed
  // yet). clearStickyNull only resets null; here we need to reset f64-observed too
  // so the refreshed exprType view propagates.
  resetParamWasmFacts(paramReps)
  runFixpoint()
  // Settle val HARD now that every producer (results, typedCtor, enrichment) has run
  // and the soft lattice has converged: re-fold each param's sites and poison any
  // whose val isn't unanimous (a site left BOTTOM = genuinely untyped). After this,
  // r.val is sound for emit + the late/post-return consumers (applyI32ParamSpecial-
  // ization's skipTyped guard, specializeBimorphicTyped) — which read it directly.
  runCallsiteLattice([mergeRule('val', (arg, _k, state) => inferValAtSite(arg, state))])
  // Don't steal typed-array params from specializeBimorphicTyped: F phase parks
  // bimorphic typed params at type='f64' with sticky-null typedCtor (two distinct
  // ctors at call sites). Their callers post-F pass them as i32 (pointer ABI),
  // so r.wasm flips to 'i32' here — but narrowing now breaks the clone path
  // that still needs to mint per-ctor sigs with ptrKind=TYPED, ptrAux=ctor-aux.
  applyI32ParamSpecialization(paramReps, valueUsed, { skipTyped: true })

  // J: jsstring boundary opt-in — for exported funcs with a string param whose
  // every use is mappable to a wasm:js-string builtin, flip the param's wasm
  // slot from f64 (nanbox SSO carrier) to externref so the JS host passes the
  // native string directly. Zero copy, zero transcoding. See applyJsstringBoundaryCarrier.
  if (jsstringEnabled()) applyJsstringBoundaryCarrier(paramReps, valueUsed)
}

/** Gate the jsstring carrier on the host. ON by default for the JS host: a
 *  js-host build is already JS-locked (it imports `env.*`), so the externref +
 *  `wasm:js-string` carrier's JS dependency is free there, and the zero-copy
 *  string-read path is a clear win. OFF under WASI: the carrier needs a JS host,
 *  and wasi builds must stay portable (wasmtime/Go/Rust). Opt out on JS with
 *  `optimize: { jsstring: false }` (e.g. side-by-side benchmarks). */
function jsstringEnabled() {
  if (ctx.transform.host === 'wasi') return false
  if (ctx.transform.optimize?.jsstring === false) return false
  return true
}

/** Phase J standalone: runs even when `canSkipWholeProgramNarrowing` short-circuits
 *  the main narrow pass. The check is body-local and export-boundary-only, so call-
 *  site lattice isn't needed; just guard on host and run the use-scan. */
export function applyJsstringBoundaryCarrierStandalone(programFacts) {
  if (!jsstringEnabled()) return
  applyJsstringBoundaryCarrier(new Map(), programFacts.valueUsed)
}

/**
 * Body-local boolean/bigint-result inference. `narrowValResults` is the general
 * (any VAL.*) pass, but it lives inside whole-program narrowing, which is skipped
 * for trivial leaf modules (no call sites). Boolean and bigint are the two kinds
 * whose internal carrier differs from the host-boundary carrier — bool rides a 0/1
 * number internally but crosses as the TRUE_NAN/FALSE_NAN atom; bigint rides an
 * i64-reinterpreted f64 internally but must cross as a real Number — so an exported
 * `(a) => a > 2` or `() => 100n` still needs its boundary thunk even on the skip path.
 * This pass only ever *sets* valResult to VAL.BOOL / VAL.BIGINT, so it is safe to run
 * unconditionally — pointer/array/number results are untouched.
 */
export function narrowBoolResults() {
  for (const func of ctx.func.list) {
    if (func.raw || func.valResult || !func.body || func.sig.results.length !== 1) continue
    const body = func.body
    const isBlock = isBlockBody(body)
    if (isBlock && hasBareReturn(body)) continue
    const exprs = returnExprs(body)
    if (!exprs.length) continue
    const localValTypes = isBlock ? analyzeBody(body).valTypes : null
    const vt = e => typeof e === 'string'
      ? (localValTypes?.get(e) || ctx.scope.globalValTypes?.get(e) || null)
      : valTypeOf(e)
    if (exprs.every(e => vt(e) === VAL.BOOL)) func.valResult = VAL.BOOL
    else if (exprs.every(e => vt(e) === VAL.BIGINT)) func.valResult = VAL.BIGINT
  }
}

// ── jsstring boundary carrier ───────────────────────────────────────────────
//
// Mappable use of an exported string param:
//   - `s.length`               → wasm:js-string.length
//   - `s.charCodeAt(idx)`      → wasm:js-string.charCodeAt — but ONLY when the
//                                index is provably in-bounds (scanBoundedLoops).
//                                The builtin traps on OOB; JS semantics return
//                                NaN. The only way to preserve JS semantics with
//                                zero overhead is to refuse non-bounded use.
// Anything else (concat, indexing `s[i]`, regex, hash key, passing to a non-
// externref param, reassignment, closure capture, `==` with anything, …) is a
// fallback trigger and disqualifies the param.

const JSS_OK_PROPS = new Set(['length', 'charCodeAt'])

/**
 * Decide whether `name` (an exported func's STRING-shaped param) can flow
 * through the boundary as `externref`. Walk the body once: every leaf
 * occurrence of `name` must be the receiver of `.length` (always safe) or
 * `.charCodeAt` whose callee node lives in `safeCC` (provably bounded).
 * Reassignment / `++` / `--` / closure capture all reject conservatively.
 *
 * Returns `{ ok, stringDiscriminating, reason? }` — `stringDiscriminating` is
 * true iff we saw at least one string-only use (`.charCodeAt`); `reason` names
 * the first blocking use when `ok` is false.
 */
function paramAllUsesJsstringMappable(body, name, safeCC) {
  if (body == null) return { ok: false, stringDiscriminating: false, reason: null }
  let ok = true
  let stringDiscriminating = false
  let reason = null
  const fail = (msg) => { ok = false; reason ||= msg }
  const refsParam = (node) => {
    if (node === name) return true
    if (!Array.isArray(node)) return false
    for (let i = 1; i < node.length; i++) if (refsParam(node[i])) return true
    return false
  }
  const walk = (node) => {
    if (!ok) return
    if (typeof node === 'string') {
      if (node === name) fail('bare use of the string param disables the zero-copy externref boundary carrier')
      return
    }
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') {
      const params = node[1]
      const shadowed = Array.isArray(params)
        ? params.some(p => (typeof p === 'string' && p === name) ||
                           (Array.isArray(p) && p[1] === name))
        : params === name
      if (!shadowed) fail('closure capture of the string param disables the zero-copy externref boundary carrier')
      return
    }
    if ((op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' ||
         op === '%=' || op === '&=' || op === '|=' || op === '^=' ||
         op === '>>=' || op === '<<=' || op === '>>>=' ||
         op === '||=' || op === '&&=' || op === '??=' ||
         op === '++' || op === '--') && node[1] === name) {
      fail('reassigning the string param disables the zero-copy externref boundary carrier')
      return
    }
    if (op === '+' && node.slice(1).some(arg => refsParam(arg))) {
      fail('string concatenation on the param disables the zero-copy externref boundary carrier')
      return
    }
    if (op === '.' && node[1] === name && JSS_OK_PROPS.has(node[2])) {
      if (node[2] === 'length') return
      if (safeCC.has(node)) { stringDiscriminating = true; return }
      fail(`\`.${node[2]}\` on the string param disables the zero-copy externref boundary carrier`)
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return { ok, stringDiscriminating, reason }
}

function applyJsstringBoundaryCarrier(paramReps, valueUsed) {
  for (const func of ctx.func.list) {
    if (func.raw || !func.exported) continue
    if (!func.body) continue
    if (func.rest) continue                          // rest position stays packed-array
    if (valueUsed.has(func.name)) continue           // value-used → callers may pass non-string
    // Pre-compute the in-bounds .charCodeAt callee nodes once per body.
    const safeCC = new Set()
    scanBoundedLoops(func.body, safeCC)
    const reps = paramReps.get(func.name)
    for (let k = 0; k < func.sig.params.length; k++) {
      const p = func.sig.params[k]
      if (p.type !== 'f64' || p.ptrKind != null) continue
      // String-literal defaults (`s = ''`, `s = 'default'`) are both string-
      // discrimination proof AND substituted JS-side by the interop wrapper —
      // see `jz:extparam` def field. Non-string defaults still disqualify:
      // the wasm side has no way to materialise an arbitrary externref default
      // at boundary-check time without a host import.
      const defVal = func.defaults?.[p.name]
      if (defVal != null && !isLiteralStr(defVal)) continue
      const { ok: usesOk, stringDiscriminating } = paramAllUsesJsstringMappable(func.body, p.name, safeCC)
      if (!usesOk) continue
      const r = reps?.get(k)
      // Skip if any rep says non-STRING (`r.val` set to ARRAY/TYPED at any
      // call site rules out jsstring).
      if (r && r.val != null && r.val !== VAL.STRING) continue
      // Discrimination signal: either a string-discriminating body use
      // (`.charCodeAt`), a call-site proof (`r.val === STRING`), or an
      // explicit string-literal default (the source intent declaration).
      const hasStringDefault = defVal != null && isLiteralStr(defVal)
      if (!stringDiscriminating && r?.val !== VAL.STRING && !hasStringDefault) continue
      p.type = 'externref'
      p.jsstring = true
      updateRep(p.name, { carrier: 'jsstring', val: VAL.STRING })
      if (hasStringDefault) p.jsstringDefault = defVal[1]
    }
  }
}

/** Soft warnings when a string param could use the externref carrier but doesn't. */
export function adviseJsstringCarrier(paramReps, valueUsed) {
  if (!ctx.warnings || !jsstringEnabled()) return

  for (const func of ctx.func.list) {
    if (func.raw || !func.exported || !func.body || func.rest) continue
    if (valueUsed?.has(func.name)) continue

    const safeCC = new Set()
    scanBoundedLoops(func.body, safeCC)
    const reps = paramReps?.get(func.name)

    for (let k = 0; k < func.sig.params.length; k++) {
      const p = func.sig.params[k]
      if (p.jsstring) continue
      if (p.type !== 'f64' || p.ptrKind != null) continue

      const defVal = func.defaults?.[p.name]
      if (defVal != null && !isLiteralStr(defVal)) continue

      const r = reps?.get(k)
      if (r && r.val != null && r.val !== VAL.STRING) continue

      const hasStringDefault = defVal != null && isLiteralStr(defVal)
      const { ok: usesOk, stringDiscriminating, reason } =
        paramAllUsesJsstringMappable(func.body, p.name, safeCC)
      const isCandidate = stringDiscriminating || r?.val === VAL.STRING || hasStringDefault
      if (!isCandidate || usesOk) continue

      warn('jsstring-declined',
        `export '${func.name}' param '${p.name}': ${reason || 'string param uses disable the zero-copy externref boundary carrier'}`,
        { fn: func.name }, func.body.loc)
    }
  }
}

// Two value-kinds CONFLICT when passing one where the other is expected would
// rely on a JS boundary coercion jz does not implement (so the result diverges).
// NUMBER↔STRING is the canonical pair: `"5" * 2` is 10 in JS but NaN in jz, and a
// STRING passed to a numeric param reads its NaN-boxed bits as an f64. ARRAY/OBJECT
// vs NUMBER/STRING likewise. We treat the four primitive-ish kinds as mutually
// exclusive; BOOL is omitted (it nanboxes to 0/1 and numeric code tolerates it).
const STRICT_CONFLICT = {
  [VAL.NUMBER]: new Set([VAL.STRING, VAL.ARRAY, VAL.OBJECT]),
  [VAL.STRING]: new Set([VAL.NUMBER, VAL.ARRAY, VAL.OBJECT]),
  [VAL.ARRAY]: new Set([VAL.NUMBER, VAL.STRING]),
  [VAL.OBJECT]: new Set([VAL.NUMBER, VAL.STRING]),
}
const kindName = (v) => ({ [VAL.NUMBER]: 'number', [VAL.STRING]: 'string', [VAL.ARRAY]: 'array', [VAL.OBJECT]: 'object' }[v] || 'value')

/**
 * Strict-mode boundary type check (standalone; runs in both the full-narrow and
 * skip-narrow plan paths).
 *
 * jz infers a param's type from how it's used (`x * 2` → number, `s.charCodeAt`
 * → string) or from an explicit default (`x = 0` → number). In permissive mode a
 * caller may pass any type and jz silently computes a divergent result (`"5"*2`
 * is 10 in JS, NaN here). Strict mode is the canonical subset where that misuse
 * is a compile error instead — consistent with strict already rejecting `==`,
 * dynamic dispatch, and `void`.
 *
 * Fires ONLY when BOTH sides are statically certain and conflict:
 *   - the callee param has a known kind (its default-value type, or a settled
 *     `val` rep from body-usage / call-site inference), AND
 *   - the argument expression has a known, conflicting kind (a literal or a
 *     locally-typed binding).
 * An untyped param or untyped arg is never flagged — no false positives on
 * genuinely polymorphic code.
 */
export function strictBoundaryTypeCheck(programFacts) {
  if (!ctx.transform.strict) return
  const { callSites, paramReps } = programFacts

  // Per-callee body-evidence cache: methodEvidence (.charCodeAt→STRING, .push→
  // ARRAY) keyed by param name. Computed lazily, once per callee.
  const bodyEvidence = new Map()
  const evidenceOf = (func) => {
    if (!bodyEvidence.has(func.name)) {
      const names = func.sig.params.map(p => p.name).filter(Boolean)
      bodyEvidence.set(func.name, func.body ? inferParams(func.body, names) : new Map())
    }
    return bodyEvidence.get(func.name)
  }

  // Expected kind of callee param k, from any statically-certain source:
  //   1. explicit default value type — the source's own declaration (x = 0 → number)
  //   2. settled call-site/usage rep `val` (paramReps; present after full narrow)
  //   3. type-exclusive body evidence (methodEvidence; works in skip-narrow path too)
  // First certain source wins; null when the param is genuinely polymorphic.
  const paramKind = (func, k) => {
    const p = func.sig.params[k]
    if (!p) return null
    const def = func.defaults?.[p.name]
    if (def != null) { const dv = valTypeOf(def); if (dv) return dv }
    const repVal = paramReps?.get(func.name)?.get(k)?.val
    if (repVal != null) return repVal
    return evidenceOf(func).get(p.name)?.val ?? null
  }

  for (const cs of callSites) {
    const func = ctx.func.map.get(cs.callee)
    if (!func || func.raw || !func.sig) continue
    if (func.rest) continue                       // rest packs args into an array
    for (let k = 0; k < cs.argList.length && k < func.sig.params.length; k++) {
      const want = paramKind(func, k)
      if (want == null) continue
      const conflicts = STRICT_CONFLICT[want]
      if (!conflicts) continue
      const got = valTypeOf(cs.argList[k])
      if (got != null && conflicts.has(got)) {
        const pname = func.sig.params[k].name
        err(`strict mode: ${kindName(want)} parameter '${pname}' of '${cs.callee}' received a ${kindName(got)} argument — jz does not coerce ${kindName(got)}→${kindName(want)} at the call boundary (the result would diverge from JS). Pass a ${kindName(want)}, or { strict: false }.`)
      }
    }
  }
}

/**
 * Phase: bimorphic typed-array param specialization.
 *
 * For each non-exported user function with a typed-array param that F/G-phase
 * left bimorphic (paramReps[name][k].typedCtor === null because two or more call sites
 * disagreed on the elem-ctor — e.g. `sum(f64)` and `sum(i32)`), clone the
 * function once per concrete ctor seen at the call sites, narrow each clone's
 * sig.params[k] to a monomorphic typed pointer ABI (type='i32', ptrKind=TYPED,
 * ptrAux=ctor's aux), and rewrite the call AST nodes to dispatch to the right
 * clone. The original survives as a fallback for any non-static call sites
 * (e.g. inside arrow bodies); treeshake removes it if every site got rewritten.
 *
 * Why this matters: without specialization, `arr[i]` inside `sum` falls into
 * the runtime `__typed_idx` path on every iteration — V8 can't inline a wasm
 * call dominated by a switch on elem type. After specialization, each clone's
 * `arr[i]` lowers to a direct `f64.load` (or `i32.load + f64.convert`) with
 * the elem-ctor known at compile time. On poly bench this is the difference
 * between ~5 ms and matching AS at ~1 ms.
 *
 * Safety mirrors G-phase: skip exported, raw, value-used, defaulted, rest, or
 * already-i32 params. Bounded by MAX_CLONES_PER_FN to guard against polymorphic
 * blow-up (≥5 distinct ctors at one site → no specialization).
 */
export function specializeBimorphicTyped(programFacts) {
  const { callSites, valueUsed, paramReps } = programFacts
  const MAX_CLONES_PER_FN = 4

  // Per-callee static-call-site index. Built once; cheap.
  const sitesByCallee = new Map()
  for (const cs of callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  // Per-caller typedElem map: body-local `new TypedArray(N)` bindings layered
  // over the module's typed globals (shared with buildCallerTypedCtx).
  const callerTypedCtx = buildCallerTypedCtx()
  // Per-caller typed-param map: caller's own params that F/G already narrowed
  // (so transitive `sum(arr)` inside a func that took `arr` from above resolves).
  const callerTypedParamsCtx = new Map()
  for (const func of ctx.func.list) {
    const m = paramFactsOf(paramReps, func, 'typedCtor') || null
    let acc = m
    if (func.sig?.params) for (const p of func.sig.params) {
      if (p.ptrKind === VAL.TYPED && p.ptrAux != null) {
        acc ||= new Map()
        if (!acc.has(p.name)) acc.set(p.name, ctorFromElemAux(p.ptrAux))
      }
    }
    if (acc) callerTypedParamsCtx.set(func, acc)
  }

  // Snapshot ctx.func.list — we'll be appending clones during the loop.
  const originals = ctx.func.list.slice()
  for (const func of originals) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    if (!func.body) continue
    if (func.rest) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const sites = sitesByCallee.get(func.name)
    if (!sites || sites.length < 2) continue

    // Find sticky-bimorphic typed-param positions left by F-phase.
    const bimorphic = []
    for (let k = 0; k < func.sig.params.length; k++) {
      const r = reps.get(k)
      if (!r || r.val !== VAL.TYPED || r.typedCtor !== null) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue
      if (func.defaults?.[p.name] != null) continue
      bimorphic.push(k)
    }
    if (bimorphic.length === 0) continue

    // For each site, infer the ctor combination across bimorphic positions.
    // Abort if any site has unknown ctor at any bimorphic position — we can't
    // route that call to a specific clone without it.
    const siteCombos = []
    let abort = false
    for (const site of sites) {
      const callerTypedElems = callerTypedCtx.get(site.callerFunc)
      const callerTypedParams = callerTypedParamsCtx.get(site.callerFunc)
      const combo = []
      for (const k of bimorphic) {
        if (k >= site.argList.length) { abort = true; break }
        const c = inferTypedCtor(site.argList[k], callerTypedElems, callerTypedParams)
        if (c == null || typedElemAux(c) == null) { abort = true; break }
        combo.push(c)
      }
      if (abort) break
      siteCombos.push(combo)
    }
    if (abort) continue

    // Distinct combos seen across call sites.
    const distinct = new Map()
    for (const combo of siteCombos) {
      const key = combo.join('|')
      if (!distinct.has(key)) distinct.set(key, combo)
    }
    if (distinct.size < 2) continue          // F-phase already mono — nothing to do
    if (distinct.size > MAX_CLONES_PER_FN) continue  // polymorphic blow-up

    // Build one clone per distinct combo.
    const cloneByKey = new Map()
    for (const [dkey, cmb] of distinct) {
      // NB: this loop variable must NOT reuse the name `combo` (declared twice above, at the
      // site loop and the distinct-building loop). The self-host miscompiles a for-of loop
      // variable whose name collides with an earlier block-scoped declaration — it aliases the
      // prior binding instead of rebinding per iteration, so `combo` would stay stuck at the
      // last site's ctor and every clone would get the same (wrong) element type → silent
      // garbage. A unique name gets a clean per-iteration binding.
      const suffix = cmb.map(c => c.replace(/^new\./, '').replace(/\./g, '_')).join('$')
      let cloneName = `${func.name}$${suffix}`
      let n = 0
      while (ctx.func.names.has(cloneName)) cloneName = `${func.name}$${suffix}$${++n}`

      // Build cloneSig with clean, fully-formed object literals — never by spreading a
      // live object and then overriding/extending its keys. The self-host (jz.wasm)
      // miscompiles two such moves: (1) a full-override spread of a sig (`{...func.sig,
      // params, results}`) corrupts the sig's schema → a later `sig.params` read faults
      // out of bounds; (2) post-mutating a `{...p}` param copy to ADD ptrKind/ptrAux
      // extends its schema → the clone reads its param as untyped and emits wrong code
      // (silent garbage result). So: a sig is exactly { params, results } (spread is pure
      // redundancy here anyway), and each bimorphic param is constructed with its pointer
      // ABI baked in. Output is unchanged on the host; this is what round-trips through
      // jz.wasm. Same hazard the rest-param clone in plan/inline.js documents.
      const cloneSig = {
        params: func.sig.params.map((p, idx) => {
          const bi = bimorphic.indexOf(idx)
          return bi < 0
            ? { ...p }
            : { name: p.name, type: 'i32', ptrKind: VAL.TYPED, ptrAux: typedElemAux(cmb[bi]) }
        }),
        results: [...func.sig.results],
      }
      const clone = { ...func, name: cloneName, sig: cloneSig }
      ctx.func.list.push(clone)
      ctx.func.map.set(cloneName, clone)
      ctx.func.names.add(cloneName)

      // Mirror per-param reps under the clone's name with mono ctors at bimorphic
      // positions. emitFunc's preseed reads typedCtor → seeds typedElem map →
      // `arr[i]` lowers to direct typed load.
      // Mirror each rep with the bimorphic positions pinned to their mono ctor — in ONE
      // literal per rep, NOT copy-then-post-mutate. In the self-host a `{...r}` spread shares
      // the source's backing, so a later `cloneReps.get(k).typedCtor = …` mutates the shared
      // rep and every clone ends up with the last ctor (silent garbage). A spread-with-override
      // literal allocates a fresh, correctly-keyed rep per clone (partial override is safe).
      const cloneReps = new Map()
      for (const [k, r] of reps) {
        const bi = bimorphic.indexOf(k)
        cloneReps.set(k, bi < 0 ? { ...r } : { ...r, typedCtor: cmb[bi], val: VAL.TYPED })
      }
      paramReps.set(cloneName, cloneReps)

      cloneByKey.set(dkey, clone)
    }

    // Rewrite each site's call AST to point at the matching clone.
    for (let i = 0; i < sites.length; i++) {
      const clone = cloneByKey.get(siteCombos[i].join('|'))
      sites[i].node[1] = clone.name
    }
  }
}

/**
 * Phase: refine ctx.types.anyDynKey using post-narrowSignatures type info.
 */
const NON_DYN_VTS = new Set([VAL.TYPED, VAL.ARRAY, VAL.STRING, VAL.BUFFER])
const TYPED_ARRAY_CTOR = /^(Float|Int|Uint|BigInt|BigUint)(8|16|32|64)(Clamped)?Array$/

export function refineDynKeys(programFacts) {
  if (!ctx.types.anyDynKey) return
  const { paramReps, valueUsed } = programFacts

  // Per-function type map: param vtypes from paramReps, plus locals
  // we can prove are typed arrays from `let v = new TypedArray(...)`. After
  // prepare, that node is `['()', 'new.Float64Array', ...args]`.
  const buildTypeMap = (funcName, body, params) => {
    const map = new Map()
    if (params) {
      const reps = paramReps.get(funcName)
      if (reps) for (let i = 0; i < params.length; i++) {
        const t = reps.get(i)?.val
        if (t != null) map.set(params[i].name, t)
      }
    }
    const walk = (node) => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const d = node[i]
          if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
          const init = d[2]
          let ctor = null
          if (Array.isArray(init) && init[0] === '()' && typeof init[1] === 'string' && init[1].startsWith('new.'))
            ctor = init[1].slice(4)
          if (ctor && TYPED_ARRAY_CTOR.test(ctor)) map.set(d[1], VAL.TYPED)
          else if (Array.isArray(init) && init[0] === '[') map.set(d[1], VAL.ARRAY)
          else if (typeof init === 'string' && map.has(init)) map.set(d[1], map.get(init))
        }
      }
      if (op === '=>') return  // don't cross into nested arrows; they're separate funcs
      for (let i = 1; i < node.length; i++) walk(node[i])
    }
    walk(body)
    return map
  }

  let real = false
  const visit = (typeMap, node) => {
    if (real || !Array.isArray(node)) return
    const op = node[0]
    if (op === '[]') {
      const idx = node[2]
      if (!isLiteralStr(idx)) {
        const obj = node[1]
        const vt = typeof obj === 'string' ? typeMap.get(obj) : null
        if (!NON_DYN_VTS.has(vt)) real = true
      }
    } else if (op === 'for-in') real = true
    // Recurse into nested arrows too. Closures stay inline (defFunc skips
    // depth>0), so a dynamic-key access captured in one — e.g. `handlers[op]`
    // in a dispatch closure — is reachable only through its parent's body.
    // Matches collectProgramFacts, which also crosses arrows when setting
    // anyDyn; not crossing here let refineDynKeys reset a flag the initial scan
    // correctly raised. Monotone-safe: extra visits only ever raise `real`.
    for (let i = 1; i < node.length; i++) visit(typeMap, node[i])
  }

  // Live: anything reachable from exports/first-class value uses. Skipping
  // dead helpers (unused benchlib imports) keeps their generic params from
  // pretending to be dyn-key access.
  const isLive = f => f.exported || paramReps.has(f.name) || (valueUsed && valueUsed.has(f.name))

  const topMap = buildTypeMap(null, null, null)
  for (const f of ctx.func.list) {
    if (real) break
    if (!f.body || !isLive(f)) continue
    visit(buildTypeMap(f.name, f.body, f.sig?.params), f.body)
  }
  if (!real && ctx.module.initFacts?.anyDyn && ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) {
    if (real) break
    visit(topMap, mi)
  }

  if (!real) ctx.types.anyDynKey = false
}
