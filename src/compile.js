/**
 * Compile prepared AST to WASM module (S-expression arrays for watr).
 *
 * # Stage contract
 *   IN:  prepared AST (from prepare) + `ctx.func.list` with raw bodies.
 *   OUT: WAT IR `['module', ...sections]` ready for watrCompile/watrPrint.
 *   FLOW: orchestrator only. Calls analyze passes per function, then emit(body) via
 *         src/emit.js's dispatch, then optimizeFunc (src/optimize.js) per function,
 *         finally assembles module sections in canonical order.
 *
 * # Core abstraction
 * Emitter table (ctx.core.emit) maps AST ops → WASM IR generators. Base operators defined
 * in `emitter` export (src/emit.js); on reset, ctx.core.emit starts as a flat copy of emitter
 * and modules add/override entries directly. No prototype chain.
 * emit(node) dispatches: numbers → i32/f64.const, strings → local.get, arrays → ctx.core.emit[op].
 *
 * # Type system
 * Every emitted node carries .type ('i32' | 'f64').
 * Operators preserve i32 when both operands are i32.
 * Division/power always produce f64. Bitwise/comparisons always produce i32.
 * Variables are typed by pre-analysis: if any assignment is f64, local is f64.
 *
 * Per-function state on ctx: locals (Map name→type), stack (loop labels), uniq (counter), sig.
 *
 * @module compile
 */

import { parse as parseWat } from 'watr'
import { ctx, err, inc, resolveIncludes, PTR } from './ctx.js'
import {
  T, VAL, valTypeOf, lookupValType, analyzeValTypes, collectValTypes, collectTypedElems, analyzeLocals, analyzePtrUnboxable, typedElemAux, exprType, invalidateLocalsCache, invalidateValTypesCache,
  extractParams, classifyParam, collectParamNames,
  findFreeVars, analyzeBoxedCaptures, analyzeDynKeys, typedElemCtor,
  collectArrElemSchemas, collectArrElemValTypes, exprSchemaId,
  repOf, updateRep, repOfGlobal, updateGlobalRep,
} from './analyze.js'
import { optimizeFunc, hoistConstantPool, specializeMkptr, specializePtrBase, sortStrPoolByFreq, treeshake } from './optimize.js'
import { emit, emitter, emitFlat, emitBody } from './emit.js'
import {
  typed, asF64, asI32, asPtrOffset, asParamType, toI32, asI64, fromI64,
  NULL_NAN, UNDEF_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, nullExpr, undefExpr,
  MAX_CLOSURE_ARITY, MEM_OPS, WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS,
  mkPtrIR, ptrOffsetIR, ptrTypeIR, extractF64Bits, appendStaticSlots,
  isLit, litVal, isNullishLit, isPureIR, isPostfix, emitNum,
  temp, tempI32, tempI64, f64rem, toNumF64, truthyIR, toBoolFromEmitted,
  keyValType, usesDynProps, needsDynShadow,
  isGlobal, isConst, boxedAddr, readVar, writeVar, isNullish,
  slotAddr, elemLoad, elemStore, arrayLoop, allocPtr,
  multiCount, loopTop, flat, reconstructArgsWithSpreads,
} from './ir.js'

// Re-export for backward compatibility (modules import from compile.js)
export { T, VAL, valTypeOf, lookupValType, extractParams, classifyParam, collectParamNames, repOf, updateRep, repOfGlobal, updateGlobalRep }
export { emit, emitter, emitFlat }
// IR helpers — re-export from ir.js so module/*.js keep their existing import paths.
export {
  typed, asF64, asI32, asParamType, toI32, asI64, fromI64,
  NULL_NAN, UNDEF_NAN, NULL_WAT, UNDEF_WAT, NULL_IR, UNDEF_IR, nullExpr, undefExpr,
  MAX_CLOSURE_ARITY, MEM_OPS, WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS,
  mkPtrIR, ptrOffsetIR, ptrTypeIR, extractF64Bits, appendStaticSlots,
  isLit, litVal, isNullishLit, isPureIR, isPostfix, emitNum,
  temp, tempI32, tempI64, f64rem, toNumF64, truthyIR, toBoolFromEmitted,
  keyValType, usesDynProps, needsDynShadow,
  isGlobal, isConst, boxedAddr, readVar, writeVar, isNullish,
  slotAddr, elemLoad, elemStore, arrayLoop, allocPtr,
  multiCount, loopTop, flat, reconstructArgsWithSpreads,
}
// Emit-dependent helpers (emitTypeofCmp, toBool, materializeMulti, emitDecl,
// buildArrayWithSpreads) live in emit.js and are re-exported there for modules.
export { emitTypeofCmp, toBool, materializeMulti, emitDecl, buildArrayWithSpreads } from './emit.js'

// Per-compile func name set + map live on ctx.func.names / ctx.func.map,
// populated at compile() entry. Both reset by ctx.js reset() and re-filled here.

// NaN-box high-bits mask: used by the static-prefix-strip pass below to
// identify pointer slots in the data segment. Kept local (ir.js owns the
// runtime packing via mkPtrIR).
const NAN_PREFIX_BITS = 0x7FF8n

// Typed-array element-ctor decoding from `ptrAux` bits (low 3 bits = elem type
// index, bit 3 = view-vs-bytes). Used by narrowSignatures F-phase and the
// bimorphic-typed specialization pass to materialize a ctor name from a
// narrowed callee result aux.
const _TYPED_ELEM_NAMES = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']
const ctorFromAux = (aux) => {
  if (aux == null) return null
  const name = _TYPED_ELEM_NAMES[aux & 7]
  if (!name) return null
  return (aux & 8) ? `new.${name}.view` : `new.${name}`
}
// Infer typed-array ctor (`new.Float64Array` etc.) of an arg expression at a
// call site. Sources: caller's body-local typedElems, caller's typed params,
// literal `new TypedArray(...)`, calls to typed-narrowed user funcs. Returns
// null when the ctor can't be determined (i.e. truly unknown to the caller).
const inferArgTypedCtor = (expr, callerTypedElems, callerTypedParams) => {
  if (typeof expr === 'string') {
    if (callerTypedElems?.has(expr)) return callerTypedElems.get(expr)
    if (callerTypedParams?.has(expr)) return callerTypedParams.get(expr)
    return null
  }
  const ctor = typedElemCtor(expr)
  if (ctor) return ctor
  if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
    const f = ctx.func.map?.get(expr[1])
    if (f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null) return ctorFromAux(f.sig.ptrAux)
  }
  return null
}

// Low-level IR helpers previously lived here. Pure ones moved to src/ir.js;
// emit-calling ones (toBool, emitTypeofCmp, emitDecl, materializeMulti,
// buildArrayWithSpreads) moved to src/emit.js.


// === Module compilation ===

/** Decode a `['{}', ...]` AST's children into `{names, values}`, or null if any
 *  property is non-static-key (computed key, spread, shorthand). Matches the
 *  emitter's flatten rule for comma-grouped props. Used by narrowSignatures and
 *  collectProgramFacts to register/observe schemas without re-deriving the AST
 *  shape; the emitter (module/object.js) does its own decoding because it must
 *  handle the spread/computed-key fall-through paths. */
function staticObjectProps(args) {
  const raw = args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',' ? args[0].slice(1) : args
  const names = [], values = []
  for (const p of raw) {
    if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') return null
    names.push(p[1]); values.push(p[2])
  }
  return names.length ? { names, values } : null
}

/**
 * Narrow return arr-elem-schema: for each non-exported, non-value-used user func with
 * `valResult === VAL.ARRAY`, walk its return exprs (and trailing-fallthrough literal),
 * resolve each to a per-body local arr-elem-schema map, and if all match, set
 * `func.arrayElemSchema`. Lets callers' `const rows = initRows()` observations gain
 * the elem-schema, propagating through to the runKernel param via paramArrSchemas.
 *
 * Sources for return-expr arr-elem inference:
 *   - body-local arr-elem map (collectArrElemSchemas, observes `.push`+literal-init)
 *   - param-bound arr-elem (paramArrSchemas[func.name][k] when populated)
 *   - call to another arr-narrowed user fn (`f.arrayElemSchema`)
 */
function narrowReturnArrayElemSchemas(paramArrSchemas, valueUsed) {
  const collectReturnExprs = (node, out) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'return') { if (args[0] != null) out.push(args[0]); return }
    for (const a of args) collectReturnExprs(a, out)
  }
  const alwaysReturns = (n) => {
    if (!Array.isArray(n)) return false
    const op = n[0]
    if (op === '=>') return false
    if (op === 'return' || op === 'throw') return true
    if (op === '{}' || op === ';') return alwaysReturns(n[n.length - 1])
    if (op === 'if') return n.length >= 4 && alwaysReturns(n[2]) && alwaysReturns(n[3])
    return false
  }
  const targets = ctx.func.list.filter(f =>
    !f.raw && !f.exported && !valueUsed.has(f.name) &&
    f.valResult === VAL.ARRAY && f.arrayElemSchema == null
  )
  let changed = true
  while (changed) {
    changed = false
    for (const func of targets) {
      if (func.arrayElemSchema != null) continue
      const isBlock = Array.isArray(func.body) && func.body[0] === '{}' && func.body[1]?.[0] !== ':'
      if (isBlock && !alwaysReturns(func.body)) continue
      const exprs = []
      if (isBlock) collectReturnExprs(func.body, exprs)
      else exprs.push(func.body)
      if (!exprs.length) continue
      // Body-local observations. Need ctx.func.locals seeded for collectArrElemSchemas's
      // `observe()` filter (which checks the var is a known local).
      const savedLocals = ctx.func.locals
      ctx.func.locals = analyzeLocals(func.body)
      for (const p of func.sig.params) if (!ctx.func.locals.has(p.name)) ctx.func.locals.set(p.name, p.type)
      const localArrElems = collectArrElemSchemas(func.body)
      ctx.func.locals = savedLocals
      // Param-bound arr-elem (transitive): paramArrSchemas[name][k] → name lookup map.
      const paramArrMap = new Map()
      const ps = paramArrSchemas.get(func.name)
      if (ps) for (const [k, v] of ps) {
        if (v != null && k < func.sig.params.length) paramArrMap.set(func.sig.params[k].name, v)
      }
      const resolveExpr = (expr) => {
        if (typeof expr === 'string') {
          if (localArrElems.has(expr)) {
            const v = localArrElems.get(expr)
            if (v != null) return v
          }
          if (paramArrMap.has(expr)) return paramArrMap.get(expr)
          return null
        }
        if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
          const f = ctx.func.map?.get(expr[1])
          if (f?.arrayElemSchema != null) return f.arrayElemSchema
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
      const sid0 = resolveExpr(exprs[0])
      if (sid0 == null) continue
      const allSame = exprs.every(e => resolveExpr(e) === sid0)
      if (!allSame) continue
      func.arrayElemSchema = sid0
      changed = true
    }
  }
}

/**
 * Narrow return arr-elem-val: parallel to narrowReturnArrayElemSchemas but tracks
 * the element val-kind (NUMBER/STRING/…) instead of a schema id. Lets callers'
 * `const a = init()` observations gain the elem-val-type, propagating through
 * to the runKernel param via paramArrElemValTypes — unlocking `__to_num`
 * elision in `arr.map(x => x*k)` style hot loops where elements are numeric.
 */
function narrowReturnArrayElemValTypes(paramArrElemValTypes, valueUsed) {
  const collectReturnExprs = (node, out) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'return') { if (args[0] != null) out.push(args[0]); return }
    for (const a of args) collectReturnExprs(a, out)
  }
  const alwaysReturns = (n) => {
    if (!Array.isArray(n)) return false
    const op = n[0]
    if (op === '=>') return false
    if (op === 'return' || op === 'throw') return true
    if (op === '{}' || op === ';') return alwaysReturns(n[n.length - 1])
    if (op === 'if') return n.length >= 4 && alwaysReturns(n[2]) && alwaysReturns(n[3])
    return false
  }
  const targets = ctx.func.list.filter(f =>
    !f.raw && !f.exported && !valueUsed.has(f.name) &&
    f.valResult === VAL.ARRAY && f.arrayElemValType == null
  )
  let changed = true
  while (changed) {
    changed = false
    for (const func of targets) {
      if (func.arrayElemValType != null) continue
      const isBlock = Array.isArray(func.body) && func.body[0] === '{}' && func.body[1]?.[0] !== ':'
      if (isBlock && !alwaysReturns(func.body)) continue
      const exprs = []
      if (isBlock) collectReturnExprs(func.body, exprs)
      else exprs.push(func.body)
      if (!exprs.length) continue
      const savedLocals = ctx.func.locals
      ctx.func.locals = analyzeLocals(func.body)
      for (const p of func.sig.params) if (!ctx.func.locals.has(p.name)) ctx.func.locals.set(p.name, p.type)
      const localArrElemVals = collectArrElemValTypes(func.body)
      ctx.func.locals = savedLocals
      const paramArrMap = new Map()
      const ps = paramArrElemValTypes.get(func.name)
      if (ps) for (const [k, v] of ps) {
        if (v != null && k < func.sig.params.length) paramArrMap.set(func.sig.params[k].name, v)
      }
      const resolveExpr = (expr) => {
        if (typeof expr === 'string') {
          if (localArrElemVals.has(expr)) {
            const v = localArrElemVals.get(expr)
            if (v != null) return v
          }
          if (paramArrMap.has(expr)) return paramArrMap.get(expr)
          return null
        }
        if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
          const f = ctx.func.map?.get(expr[1])
          if (f?.arrayElemValType != null) return f.arrayElemValType
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
      const vt0 = resolveExpr(exprs[0])
      if (vt0 == null) continue
      const allSame = exprs.every(e => resolveExpr(e) === vt0)
      if (!allSame) continue
      func.arrayElemValType = vt0
      changed = true
    }
  }
}

/**
 * Phase: signature narrowing.
 *
 * Reads programFacts.callSites + valueUsed; mutates each user func's `sig`:
 *   - param types  (f64 → i32 / pointer-ABI i32+ptrKind, when call sites agree)
 *   - param schemas (per-arg schemaId, recorded into programFacts.paramSchemas)
 *   - result type  (f64 → i32, when body always returns i32)
 *   - result valType (`func.valResult`) and pointer narrowing (sig.ptrKind)
 *
 * Pure w.r.t. the AST — only the function `sig` records change. The maps in
 * programFacts (paramValTypes/paramWasmTypes/paramSchemas) are populated here
 * and consumed by the per-function emit phase below.
 *
 * Encoded structurally as a phase so future S3 work can move it into a
 * pipeline runner without re-deriving the in/out contract from comments.
 */
function narrowSignatures(programFacts) {
  const { callSites, valueUsed, paramValTypes, paramWasmTypes, paramSchemas, paramArrSchemas, paramArrElemValTypes, paramTypedCtors } = programFacts

  // D: Call-site type propagation — infer param types from how functions are called.
  // Drives off `callSites` collected during the ProgramFacts walk; no AST re-walking.
  // For non-exported internal functions, if all call sites agree on a param's type,
  // seed the param's val rep (ctx.func.repByLocal) during per-function compilation.
  // Also infer i32/f64 WASM type — when all call sites pass i32 for a param, specialize
  // sig.params[k].type to i32 (no default, no rest, not exported, not value-used).
  // Also propagate schema ID — when all call sites pass objects with the same schema,
  // bind the callee's param to that schema so `p.x` becomes a direct slot load.
    // Infer schemaId for an argument expression. Returns null if not inferrable.
    // Safe sources: object literal with all string keys and no spreads, or a variable
    // whose schema is already bound in ctx.schema.vars (module-level) or callerSchemas.
    const inferArgSchema = (expr, callerSchemas) => {
      if (typeof expr === 'string') {
        if (callerSchemas && callerSchemas.has(expr)) return callerSchemas.get(expr)
        const id = ctx.schema.vars.get(expr)
        return id != null ? id : null
      }
      if (Array.isArray(expr) && expr[0] === '{}') {
        const parsed = staticObjectProps(expr.slice(1))
        return parsed ? ctx.schema.register(parsed.names) : null
      }
      return null
    }
    // Infer arg type using global valTypes + caller-local valTypes
    const inferArgType = (expr, callerValTypes) => {
      if (typeof expr === 'string') return callerValTypes?.get(expr) || ctx.scope.globalValTypes?.get(expr) || null
      return valTypeOf(expr)
    }
    // Per-caller analysis is stable across fixpoint iterations — precompute once.
    // callerCtx[null] (top-level) uses module globals for both locals and valTypes.
    const callerCtx = new Map()  // funcObj | null → { callerLocals, callerValTypes }
    callerCtx.set(null, { callerLocals: ctx.scope.globalTypes, callerValTypes: ctx.scope.globalValTypes })
    for (const func of ctx.func.list) {
      if (!func.body || func.raw) continue
      const callerLocals = analyzeLocals(func.body)
      for (const p of func.sig.params) if (!callerLocals.has(p.name)) callerLocals.set(p.name, p.type)
      callerCtx.set(func, { callerLocals, callerValTypes: collectValTypes(func.body) })
    }
    // Per-caller arr-elem-schema observations. Recomputed each fixpoint iteration so
    // newly-narrowed func.arrayElemSchema results propagate from `const rows = initRows()`
    // observations (collectArrElemSchemas reads `f.arrayElemSchema` from `ctx.func.map`).
    const buildCallerArrElems = () => {
      const m = new Map()
      m.set(null, ctx.scope.globalArrElems || new Map())
      for (const func of ctx.func.list) {
        if (!func.body || func.raw) continue
        // Set ctx.func.locals so collectArrElemSchemas's `observe()` filter passes.
        const savedLocals = ctx.func.locals
        ctx.func.locals = callerCtx.get(func).callerLocals
        m.set(func, collectArrElemSchemas(func.body))
        ctx.func.locals = savedLocals
      }
      return m
    }
    // Infer arr-elem-schema of an arg expression. Returns sid or null.
    // Sources: caller's body observations, caller's param arrSchema (transitive),
    // user fn returning Array<sid>, alias to a known-array param.
    const inferArgArrElemSchema = (expr, callerArrElems, callerArrParams) => {
      if (typeof expr === 'string') {
        if (callerArrElems?.has(expr)) {
          const v = callerArrElems.get(expr)
          if (v != null) return v
        }
        if (callerArrParams?.has(expr)) {
          const v = callerArrParams.get(expr)
          if (v != null) return v
        }
        return null
      }
      if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
        const f = ctx.func.map?.get(expr[1])
        if (f?.arrayElemSchema != null) return f.arrayElemSchema
      }
      return null
    }
    // Two-pass fixpoint: first pass learns from literals + module vars; second pass
    // lets callers forward propagated schemas (for chained helpers: f→addXY→{getX,getY}).
    let callerArrElemsCtx = buildCallerArrElems()
    const rebuildArrElems = () => { callerArrElemsCtx = buildCallerArrElems() }
    // Parallel: per-caller arr-elem-VAL observations (NUMBER/STRING/etc.) for the
    // paramArrElemValTypes fixpoint. Same structure as callerArrElemsCtx but tracks
    // val-kinds. Recomputed after E2 so newly-narrowed func.arrayElemValType results
    // propagate from `const a = init()` observations.
    const buildCallerArrElemVals = () => {
      const m = new Map()
      m.set(null, new Map())
      for (const func of ctx.func.list) {
        if (!func.body || func.raw) continue
        const savedLocals = ctx.func.locals
        ctx.func.locals = callerCtx.get(func).callerLocals
        m.set(func, collectArrElemValTypes(func.body))
        ctx.func.locals = savedLocals
      }
      return m
    }
    let callerArrElemValsCtx = buildCallerArrElemVals()
    const rebuildArrElemVals = () => { callerArrElemValsCtx = buildCallerArrElemVals() }
    // Infer arr-elem-VAL of an arg expression. Sources mirror inferArgArrElemSchema.
    const inferArgArrElemValType = (expr, callerArrElemVals, callerArrValParams) => {
      if (typeof expr === 'string') {
        if (callerArrElemVals?.has(expr)) {
          const v = callerArrElemVals.get(expr)
          if (v != null) return v
        }
        if (callerArrValParams?.has(expr)) {
          const v = callerArrValParams.get(expr)
          if (v != null) return v
        }
        return null
      }
      if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
        const f = ctx.func.map?.get(expr[1])
        if (f?.arrayElemValType != null) return f.arrayElemValType
      }
      return null
    }
    const runFixpoint = () => {
      for (let s = 0; s < callSites.length; s++) {
        const { callee, argList, callerFunc } = callSites[s]
        const func = ctx.func.map.get(callee)
        if (!func || func.exported || valueUsed.has(callee)) continue
        const ctxEntry = callerCtx.get(callerFunc)
        if (!ctxEntry) continue
        const { callerLocals, callerValTypes } = ctxEntry
        // Caller's schema bindings: params inferred so far (for transitive propagation).
        let callerSchemas = null
        if (callerFunc) {
          const cs = paramSchemas.get(callerFunc.name)
          if (cs) {
            for (const [k, v] of cs) if (v != null) {
              callerSchemas ||= new Map()
              callerSchemas.set(callerFunc.sig.params[k].name, v)
            }
          }
        }
        // Caller's arr-elem-schema bindings on its own params (transitive propagation).
        let callerArrParams = null
        if (callerFunc) {
          const ca = paramArrSchemas.get(callerFunc.name)
          if (ca) {
            for (const [k, v] of ca) if (v != null) {
              callerArrParams ||= new Map()
              callerArrParams.set(callerFunc.sig.params[k].name, v)
            }
          }
        }
        const callerArrElems = callerArrElemsCtx.get(callerFunc)
        if (!paramValTypes.has(callee)) paramValTypes.set(callee, new Map())
        if (!paramWasmTypes.has(callee)) paramWasmTypes.set(callee, new Map())
        if (!paramSchemas.has(callee)) paramSchemas.set(callee, new Map())
        const ptypes = paramValTypes.get(callee)
        const wtypes = paramWasmTypes.get(callee)
        const stypes = paramSchemas.get(callee)
        for (let k = 0; k < func.sig.params.length; k++) {
          if (k < argList.length) {
            if (ptypes.get(k) !== null) {
              const argType = inferArgType(argList[k], callerValTypes)
              if (!argType) ptypes.set(k, null)
              else {
                const prev = ptypes.get(k)
                if (prev === undefined) ptypes.set(k, argType)
                else if (prev !== argType) ptypes.set(k, null)
              }
            }
            if (wtypes.get(k) !== null) {
              const wt = exprType(argList[k], callerLocals)
              const prev = wtypes.get(k)
              if (prev === undefined) wtypes.set(k, wt)
              else if (prev !== wt) wtypes.set(k, null)
            }
            if (stypes.get(k) !== null) {
              const sId = inferArgSchema(argList[k], callerSchemas)
              if (sId == null) stypes.set(k, null)
              else {
                const prev = stypes.get(k)
                if (prev === undefined) stypes.set(k, sId)
                else if (prev !== sId) stypes.set(k, null)
              }
            }
          } else {
            // Missing arg — call pads with nullExpr (f64). Prevents i32 specialization.
            ptypes.set(k, null)
            wtypes.set(k, null)
            stypes.set(k, null)
          }
        }
      }
    }
    // Dedicated paramArrSchemas fixpoint. Run after E2 (so f.valResult+arrayElemSchema
    // are populated) so that aetypes[k] starts undefined and isn't sticky-null'd by
    // the early passes when valResult was unset. Mirrors runFixpoint structure.
    const runArrFixpoint = () => {
      for (let s = 0; s < callSites.length; s++) {
        const { callee, argList, callerFunc } = callSites[s]
        const func = ctx.func.map.get(callee)
        if (!func || func.exported || valueUsed.has(callee)) continue
        const ctxEntry = callerCtx.get(callerFunc)
        if (!ctxEntry) continue
        let callerArrParams = null
        if (callerFunc) {
          const ca = paramArrSchemas.get(callerFunc.name)
          if (ca) {
            for (const [k, v] of ca) if (v != null) {
              callerArrParams ||= new Map()
              callerArrParams.set(callerFunc.sig.params[k].name, v)
            }
          }
        }
        const callerArrElems = callerArrElemsCtx.get(callerFunc)
        if (!paramArrSchemas.has(callee)) paramArrSchemas.set(callee, new Map())
        const aetypes = paramArrSchemas.get(callee)
        for (let k = 0; k < func.sig.params.length; k++) {
          if (k >= argList.length) { aetypes.set(k, null); continue }
          if (aetypes.get(k) === null) continue
          const aeId = inferArgArrElemSchema(argList[k], callerArrElems, callerArrParams)
          if (aeId == null) aetypes.set(k, null)
          else {
            const prev = aetypes.get(k)
            if (prev === undefined) aetypes.set(k, aeId)
            else if (prev !== aeId) aetypes.set(k, null)
          }
        }
      }
    }
    // Dedicated paramArrElemValTypes fixpoint. Same shape as runArrFixpoint but for
    // VAL.* element kinds. Run after E2 so f.arrayElemValType is populated.
    const runArrValTypeFixpoint = () => {
      for (let s = 0; s < callSites.length; s++) {
        const { callee, argList, callerFunc } = callSites[s]
        const func = ctx.func.map.get(callee)
        if (!func || func.exported || valueUsed.has(callee)) continue
        const ctxEntry = callerCtx.get(callerFunc)
        if (!ctxEntry) continue
        let callerArrValParams = null
        if (callerFunc) {
          const ca = paramArrElemValTypes.get(callerFunc.name)
          if (ca) {
            for (const [k, v] of ca) if (v != null) {
              callerArrValParams ||= new Map()
              callerArrValParams.set(callerFunc.sig.params[k].name, v)
            }
          }
        }
        const callerArrElemVals = callerArrElemValsCtx.get(callerFunc)
        if (!paramArrElemValTypes.has(callee)) paramArrElemValTypes.set(callee, new Map())
        const aevtypes = paramArrElemValTypes.get(callee)
        for (let k = 0; k < func.sig.params.length; k++) {
          if (k >= argList.length) { aevtypes.set(k, null); continue }
          if (aevtypes.get(k) === null) continue
          const v = inferArgArrElemValType(argList[k], callerArrElemVals, callerArrValParams)
          if (v == null) aevtypes.set(k, null)
          else {
            const prev = aevtypes.get(k)
            if (prev === undefined) aevtypes.set(k, v)
            else if (prev !== v) aevtypes.set(k, null)
          }
        }
      }
    }
    runFixpoint()
    runFixpoint()

  // Apply i32 specialization: for non-exported/non-value-used funcs with consistent
  // i32 call sites and no defaults/rest at that position, narrow sig.params[k].type.
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    const wtypes = paramWasmTypes.get(func.name)
    if (!wtypes) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, wt] of wtypes) {
      if (wt !== 'i32' || k === restIdx) continue
      const pname = func.sig.params[k].name
      if (func.defaults?.[pname] != null) continue  // defaults need nullish-sentinel f64
      func.sig.params[k].type = 'i32'
    }
  }

  // Pointer-ABI specialization: for non-forwarding pointer params consistent across
  // call sites, narrow from NaN-boxed f64 to i32 offset. Eliminates per-call __ptr_offset
  // extraction + f64→i64→i32 reinterpret chains that dominate watr-style compilers.
  // Safety:
  //   - exclude ARRAY (forwards on realloc — f64 NaN-box is a stable identity) and
  //     STRING (SSO vs heap dual encoding depends on ptr-type bits we'd drop).
  //   - exclude CLOSURE/TYPED (aux bits carry schema/element-type, lost with offset).
  //   - exclude params with defaults (nullish sentinel needs the f64 NaN space).
  //   - exclude rest position (array pack/unpack stays f64).
  const PTR_ABI_KINDS = new Set([VAL.OBJECT, VAL.SET, VAL.MAP, VAL.BUFFER])
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    const ptypes = paramValTypes.get(func.name)
    if (!ptypes) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, vt] of ptypes) {
      if (!PTR_ABI_KINDS.has(vt)) continue
      if (k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue  // already narrowed by numeric pass
      if (func.defaults?.[p.name] != null) continue
      p.type = 'i32'
      p.ptrKind = vt
    }
  }

  // E: Result-type monomorphization — narrow sig.results[0] to 'i32' when body only
  // produces i32 values. Fixpoint: a call to another narrowed func now contributes i32;
  // iterate until stable so chains of i32-only helpers all narrow together.
  // Safety: skip exported (JS boundary preserves number semantics), value-used (closure
  // trampolines assume f64 result), raw WAT, multi-value. `undefined` return = skip.
  const collectReturnExprs = (node, out) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    if (op === '=>') return
    if (op === 'return') { if (args[0] != null) out.push(args[0]); return }
    for (const a of args) collectReturnExprs(a, out)
  }
  const exprTypeWithCalls = (expr, locals) => {
    // Shim: recognize calls to already-narrowed funcs as i32, everything else via exprType.
    if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
      const f = ctx.func.map.get(expr[1])
      if (f?.sig.results.length === 1 && f.sig.results[0] === 'i32') return 'i32'
      return 'f64'
    }
    // Ternary / logical / arith: recurse with our shim so nested calls contribute.
    if (Array.isArray(expr) && expr.length > 1) {
      const [op, ...args] = expr
      if (op === '?:') {
        const a = exprTypeWithCalls(args[1], locals), b = exprTypeWithCalls(args[2], locals)
        return a === 'i32' && b === 'i32' ? 'i32' : 'f64'
      }
      if (op === '&&' || op === '||') {
        const a = exprTypeWithCalls(args[0], locals), b = exprTypeWithCalls(args[1], locals)
        return a === 'i32' && b === 'i32' ? 'i32' : 'f64'
      }
      if (['+', '-', '*', '%'].includes(op)) {
        const a = exprTypeWithCalls(args[0], locals), b = args[1] != null ? exprTypeWithCalls(args[1], locals) : a
        return a === 'i32' && b === 'i32' ? 'i32' : 'f64'
      }
      if (op === 'u-' || op === 'u+') return exprTypeWithCalls(args[0], locals)
    }
    return exprType(expr, locals)
  }
  const narrowableFuncs = ctx.func.list.filter(f =>
    !f.raw && !f.exported && !valueUsed.has(f.name) && f.sig.results.length === 1
  )
  let changed = true
  while (changed) {
    changed = false
    for (const func of narrowableFuncs) {
      if (func.sig.results[0] === 'i32') continue
      const body = func.body
      const exprs = []
      if (Array.isArray(body) && body[0] === '{}') {
        collectReturnExprs(body, exprs)
        // Conservative: if body could fall through without return, trailing fallback is
        // of result type — matches narrowed i32 fine. But bare-return (`return;`) → undef (f64).
        // Detect bare returns by walking for `['return']` with no expr → exprs.push(null).
        const hasBareReturn = (n) => {
          if (!Array.isArray(n)) return false
          if (n[0] === '=>') return false
          if (n[0] === 'return' && n[1] == null) return true
          return n.some(hasBareReturn)
        }
        if (hasBareReturn(body)) continue  // undef is f64 — can't narrow
      } else {
        exprs.push(body)
      }
      if (!exprs.length) continue
      const savedCurrent = ctx.func.current
      ctx.func.current = func.sig
      const locals = (Array.isArray(body) && body[0] === '{}') ? analyzeLocals(body) : new Map()
      for (const p of func.sig.params) if (!locals.has(p.name)) locals.set(p.name, p.type)
      const allI32 = exprs.every(e => exprTypeWithCalls(e, locals) === 'i32')
      ctx.func.current = savedCurrent
      if (allI32) { func.sig.results = ['i32']; changed = true }
    }
  }

  // E2: VAL-type result inference — if a function always returns the same VAL kind,
  // record it so callers inherit that type (enables static dispatch on .length, .[],
  // .prop through a call chain). Fixpoint propagates through helper chains.
  // Safety: skip exported (host sees raw f64), value-used (indirect call signature).
  // Shim so calls to already-typed funcs contribute their result type.
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
  const valTypeNarrowable = ctx.func.list.filter(f =>
    !f.raw && !f.exported && !valueUsed.has(f.name) && f.sig.results.length === 1
  )
  changed = true
  while (changed) {
    changed = false
    for (const func of valTypeNarrowable) {
      if (func.valResult) continue
      const body = func.body
      const exprs = []
      // Block: `'{}'` with non-`:` first child (else it's an expression-bodied object literal)
      const isBlock = Array.isArray(body) && body[0] === '{}' && body[1]?.[0] !== ':'
      if (isBlock) {
        collectReturnExprs(body, exprs)
        const hasBareReturn = (n) => {
          if (!Array.isArray(n)) return false
          if (n[0] === '=>') return false
          if (n[0] === 'return' && n[1] == null) return true
          return n.some(hasBareReturn)
        }
        if (hasBareReturn(body)) continue
      } else {
        exprs.push(body)
      }
      if (!exprs.length) continue
      const localValTypes = isBlock ? collectValTypes(body) : new Map()
      // Params of this function contribute no known VAL type yet (paramValTypes may help later).
      const vt0 = valTypeOfWithCalls(exprs[0], localValTypes)
      if (!vt0) continue
      const allSame = exprs.every(e => valTypeOfWithCalls(e, localValTypes) === vt0)
      if (allSame) { func.valResult = vt0; changed = true }
    }
  }

  // Now that E2 set `valResult` on funcs, narrow per-func `arrayElemSchema` for
  // VAL.ARRAY-returning funcs (via push observations + call chains). Then re-run the
  // D-pass paramArrSchemas / paramValTypes fixpoint so `const rows = initRows()` in
  // main resolves to VAL.ARRAY (lets runKernel pick up paramValTypes[0]=ARRAY) and
  // its arr-elem-schema (sets paramArrSchemas[runKernel][0]=sid).
  // Cache invalidation: collectValTypes results are body-keyed, and entries cached
  // during the first D pass have stale (null) `valTypeOf(call)` results because
  // valResult was unset back then.
  narrowReturnArrayElemSchemas(paramArrSchemas, valueUsed)
  narrowReturnArrayElemValTypes(paramArrElemValTypes, valueUsed)
  for (const func of ctx.func.list) {
    if (func.body && !func.raw) invalidateValTypesCache(func.body)
  }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const entry = callerCtx.get(func)
    if (entry) entry.callerValTypes = collectValTypes(func.body)
  }
  rebuildArrElems()
  rebuildArrElemVals()
  // Clear sticky null entries in paramValTypes/paramSchemas — the first 2 passes ran
  // with valResult unset, so call args resolving via `f.valResult` returned null and
  // got stuck. Re-running with refreshed callerValTypes lets these flow.
  for (const m of paramValTypes.values()) for (const [k, v] of m) if (v == null) m.delete(k)
  for (const m of paramSchemas.values()) for (const [k, v] of m) if (v == null) m.delete(k)
  runFixpoint()
  // Now that paramValTypes is refreshed, dedicated arr-elem-schema fixpoint.
  runArrFixpoint()
  runArrFixpoint()
  // Parallel arr-elem-val fixpoint (NUMBER/STRING/…). Twice for transitive closure
  // through helper chains: `init()→main→runKernel`.
  runArrValTypeFixpoint()
  runArrValTypeFixpoint()
  // E3: Result-type pointer narrowing — when valResult is a non-ambiguous pointer kind
  // with constant aux, narrow sig.results[0] from f64 to i32 and tag sig.ptrKind/.ptrAux.
  // Eliminates the f64.reinterpret_i64+i64.or rebox at every return and the
  // i32.wrap_i64+i64.reinterpret_f64 unbox at every callsite that uses the value as a
  // pointer (load .[], .length, .prop slot dispatch).
  //   - SET/MAP/BUFFER: aux always 0 — no per-callsite aux preservation needed.
  //   - OBJECT: aux is schema-id; narrow only when all return exprs share a constant
  //     schema (literal `{a,b,c}`, paramSchemas-bound param, module-bound var, or call to
  //     another OBJECT-narrowed func). Caller picks aux up via callIR.ptrAux → readVar →
  //     repByLocal.schemaId, restoring property-slot dispatch through the call boundary.
  // Safety: ARRAY forwards on realloc (no narrowing). STRING dual-encoded SSO/heap.
  // CLOSURE/TYPED also carry meaningful aux — TYPED narrowing is a follow-up. Body must
  // be a guaranteed-return form — fallthrough fallback i32.const 0 would be a valid
  // offset 0 of the narrowed kind, not undefined.
  const PTR_RESULT_KINDS_NOAUX = new Set([VAL.SET, VAL.MAP, VAL.BUFFER])
  const alwaysReturns = (n) => {
    if (!Array.isArray(n)) return false
    const op = n[0]
    if (op === '=>') return false
    if (op === 'return' || op === 'throw') return true
    if (op === '{}' || op === ';') return alwaysReturns(n[n.length - 1])
    if (op === 'if') return n.length >= 4 && alwaysReturns(n[2]) && alwaysReturns(n[3])
    return false
  }
  // Schema-id inference for a return expression. Returns id (number), or null if unknown
  // / not constant. Mirrors inferArgSchema but extends with calls to already-narrowed
  // OBJECT-result funcs (fixpoint propagation through helper chains).
  const schemaIdOfReturn = (expr, paramSchemasMap) => {
    if (typeof expr === 'string') {
      if (paramSchemasMap?.has(expr)) return paramSchemasMap.get(expr)
      if (ctx.schema.vars.has(expr)) return ctx.schema.vars.get(expr)
      return null
    }
    if (!Array.isArray(expr)) return null
    const [op, ...args] = expr
    if (op === '{}') {
      // Object literal: bail to null on block body, dynamic key, or spread.
      const parsed = staticObjectProps(args)
      return parsed ? ctx.schema.register(parsed.names) : null
    }
    if (op === '()' && typeof args[0] === 'string') {
      const f = ctx.func.map.get(args[0])
      if (f?.valResult === VAL.OBJECT && f.sig.ptrAux != null) return f.sig.ptrAux
      return null
    }
    if (op === '?:') {
      const a = schemaIdOfReturn(args[1], paramSchemasMap)
      const b = schemaIdOfReturn(args[2], paramSchemasMap)
      return a != null && a === b ? a : null
    }
    if (op === '&&' || op === '||') {
      const a = schemaIdOfReturn(args[0], paramSchemasMap)
      const b = schemaIdOfReturn(args[1], paramSchemasMap)
      return a != null && a === b ? a : null
    }
    return null
  }
  // Per-body local elemAux map: scans `let/const x = new TypedArray(...)` decls so
  // a return like `let a = new Float64Array(...); return a` resolves to a constant
  // aux. Result calls + ?: are handled inline in typedAuxOfReturn.
  const localElemAuxMap = (body) => {
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
  const typedAuxOfReturn = (expr, localElemMap) => {
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
  // Fixpoint: a chain `outer → inner → {a,b}` needs inner to narrow first so outer's
  // call to inner contributes a known schema-id.
  let narrowChanged = true
  while (narrowChanged) {
    narrowChanged = false
    for (const func of valTypeNarrowable) {
      if (!func.valResult) continue
      if (func.sig.results[0] !== 'f64') continue
      const isBlock = Array.isArray(func.body) && func.body[0] === '{}' && func.body[1]?.[0] !== ':'
      if (isBlock && !alwaysReturns(func.body)) continue
      if (PTR_RESULT_KINDS_NOAUX.has(func.valResult)) {
        func.sig.results = ['i32']
        func.sig.ptrKind = func.valResult
        narrowChanged = true
        continue
      }
      if (func.valResult === VAL.OBJECT) {
        const exprs = []
        if (isBlock) collectReturnExprs(func.body, exprs)
        else exprs.push(func.body)
        if (!exprs.length) continue
        const ps = paramSchemas.get(func.name)
        let paramSchemasMap = null
        if (ps) {
          for (const [k, sid] of ps) {
            if (sid != null && k < func.sig.params.length) {
              paramSchemasMap ||= new Map()
              paramSchemasMap.set(func.sig.params[k].name, sid)
            }
          }
        }
        const sid0 = schemaIdOfReturn(exprs[0], paramSchemasMap)
        if (sid0 == null) continue
        const allSame = exprs.every(e => schemaIdOfReturn(e, paramSchemasMap) === sid0)
        if (!allSame) continue
        func.sig.results = ['i32']
        func.sig.ptrKind = VAL.OBJECT
        func.sig.ptrAux = sid0
        narrowChanged = true
      }
      if (func.valResult === VAL.TYPED) {
        const exprs = []
        if (isBlock) collectReturnExprs(func.body, exprs)
        else exprs.push(func.body)
        if (!exprs.length) continue
        const localMap = isBlock ? localElemAuxMap(func.body) : null
        const aux0 = typedAuxOfReturn(exprs[0], localMap)
        if (aux0 == null) continue
        const allSame = exprs.every(e => typedAuxOfReturn(e, localMap) === aux0)
        if (!allSame) continue
        func.sig.results = ['i32']
        func.sig.ptrKind = VAL.TYPED
        func.sig.ptrAux = aux0
        narrowChanged = true
      }
    }
  }

  // F: Cross-call typed-array element ctor propagation. Runs AFTER E3 so that
  // calls to user functions returning a TYPED-narrowed pointer (with constant
  // ptrAux, e.g. mkInput → Float64Array) contribute their element type to the
  // caller's local typedElem map. Result: callees pick up `ctx.types.typedElem`
  // for their own params and `arr[i]` reads emit a direct `f64.load` instead of
  // the runtime `__is_str_key + __typed_idx` dispatch — closes the largest
  // chunk of the JS→wasm gap on f64-heavy hot loops.
  // (Helpers `inferArgTypedCtor`/`ctorFromAux` lifted to file scope so the
  //  bimorphic-typed specialization pass below can reuse them.)
  // Per-caller typed-elem map, recomputed now that E3 has tagged helper sigs.
  const callerTypedCtx = new Map()
  callerTypedCtx.set(null, ctx.scope.globalTypedElem || new Map())
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    callerTypedCtx.set(func, collectTypedElems(func.body))
  }
  // Two-pass fixpoint: lets a caller's params, once typed, propagate further to
  // its own callees (e.g. if `outer(buf)` calls `inner(buf)` and we learn `buf`
  // for outer, the second pass picks it up for inner).
  const runTypedFixpoint = () => {
    for (let s = 0; s < callSites.length; s++) {
      const { callee, argList, callerFunc } = callSites[s]
      const func = ctx.func.map.get(callee)
      if (!func || func.exported || valueUsed.has(callee)) continue
      const callerTypedElems = callerTypedCtx.get(callerFunc)
      let callerTypedParams = null
      if (callerFunc) {
        const tc = paramTypedCtors.get(callerFunc.name)
        if (tc) {
          for (const [k, c] of tc) if (c != null) {
            callerTypedParams ||= new Map()
            callerTypedParams.set(callerFunc.sig.params[k].name, c)
          }
        }
      }
      if (!paramTypedCtors.has(callee)) paramTypedCtors.set(callee, new Map())
      const tctypes = paramTypedCtors.get(callee)
      for (let k = 0; k < func.sig.params.length; k++) {
        if (k >= argList.length) { tctypes.set(k, null); continue }
        if (tctypes.get(k) === null) continue
        const c = inferArgTypedCtor(argList[k], callerTypedElems, callerTypedParams)
        if (c == null) tctypes.set(k, null)
        else {
          const prev = tctypes.get(k)
          if (prev === undefined) tctypes.set(k, c)
          else if (prev !== c) tctypes.set(k, null)
        }
      }
    }
  }
  runTypedFixpoint()
  runTypedFixpoint()

  // G: TYPED pointer-ABI narrowing — once paramTypedCtors agrees on a single
  // ctor across all call sites, narrow the param from NaN-boxed f64 to raw
  // i32 offset (with ptrAux carrying the elem-type bits). Eliminates the
  // per-read `i32.wrap_i64 (i64.reinterpret_f64 (local.get $arr))` unbox dance
  // that today dominates hot loops dominated by typed-array indexing.
  // Call sites coerce via emitArgForParam → ptrOffsetIR(arg, VAL.TYPED).
  // Safety: same exclusions as the OBJECT/SET/MAP/BUFFER narrowing above —
  // exported, value-used, raw, defaults, rest position.
  for (const func of ctx.func.list) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    const tctors = paramTypedCtors.get(func.name)
    if (!tctors) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, ctor] of tctors) {
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

  // H: Post-F/G re-fixpoint — propagates VAL kinds through bimorphic call sites
  // where ptrKind narrowed but ptrAux disagreed (e.g. `sum(f64arr)` and `sum(i32arr)`
  // → both VAL.TYPED, different ctors). Without this, callerValTypes carries no entry
  // for caller's params, so inferArgType returns null and paramValTypes[callee][k] is
  // sticky null. With ptrKind enriching callerValTypes, sum's arr gets val=TYPED in
  // its rep, letting array.js skip __is_str_key + __str_idx dispatch on `arr[i]`.
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
  for (const m of paramValTypes.values()) for (const [k, v] of m) if (v == null) m.delete(k)
  runFixpoint()
}

/**
 * Phase: bimorphic typed-array param specialization.
 *
 * For each non-exported user function with a typed-array param that F/G-phase
 * left bimorphic (paramTypedCtors[k] === null because two or more call sites
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
function specializeBimorphicTyped(programFacts) {
  const { callSites, valueUsed, paramTypedCtors, paramValTypes, paramSchemas, paramArrSchemas } = programFacts
  const MAX_CLONES_PER_FN = 4

  // Per-callee static-call-site index. Built once; cheap.
  const sitesByCallee = new Map()
  for (const cs of callSites) {
    const list = sitesByCallee.get(cs.callee)
    if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
  }

  // Per-caller typedElem map (literal `new TypedArray(N)` bindings inside body).
  const callerTypedCtx = new Map()
  callerTypedCtx.set(null, ctx.scope.globalTypedElem || new Map())
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    callerTypedCtx.set(func, collectTypedElems(func.body))
  }
  // Per-caller typed-param map: caller's own params that F/G already narrowed
  // (so transitive `sum(arr)` inside a func that took `arr` from above resolves).
  const callerTypedParamsCtx = new Map()
  for (const func of ctx.func.list) {
    let m = null
    const tc = paramTypedCtors.get(func.name)
    if (tc) for (const [k, c] of tc) {
      if (c != null) { m ||= new Map(); m.set(func.sig.params[k].name, c) }
    }
    if (func.sig?.params) for (const p of func.sig.params) {
      if (p.ptrKind === VAL.TYPED && p.ptrAux != null) {
        m ||= new Map()
        if (!m.has(p.name)) m.set(p.name, ctorFromAux(p.ptrAux))
      }
    }
    if (m) callerTypedParamsCtx.set(func, m)
  }

  // Snapshot ctx.func.list — we'll be appending clones during the loop.
  const originals = ctx.func.list.slice()
  for (const func of originals) {
    if (func.exported || func.raw || valueUsed.has(func.name)) continue
    if (!func.body) continue
    if (func.rest) continue
    const tctors = paramTypedCtors.get(func.name)
    if (!tctors) continue
    const sites = sitesByCallee.get(func.name)
    if (!sites || sites.length < 2) continue

    // Find sticky-bimorphic typed-param positions left by F-phase.
    const bimorphic = []
    for (let k = 0; k < func.sig.params.length; k++) {
      if (tctors.get(k) !== null) continue
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
        const c = inferArgTypedCtor(site.argList[k], callerTypedElems, callerTypedParams)
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
    for (const [key, combo] of distinct) {
      const suffix = combo.map(c => c.replace(/^new\./, '').replace(/\./g, '_')).join('$')
      let cloneName = `${func.name}$${suffix}`
      let n = 0
      while (ctx.func.names.has(cloneName)) cloneName = `${func.name}$${suffix}$${++n}`

      const cloneSig = {
        ...func.sig,
        params: func.sig.params.map(p => ({ ...p })),
        results: [...func.sig.results],
      }
      for (let i = 0; i < bimorphic.length; i++) {
        const k = bimorphic[i]
        const aux = typedElemAux(combo[i])
        const p = cloneSig.params[k]
        p.type = 'i32'
        p.ptrKind = VAL.TYPED
        p.ptrAux = aux
      }
      const clone = { ...func, name: cloneName, sig: cloneSig }
      ctx.func.list.push(clone)
      ctx.func.map.set(cloneName, clone)
      ctx.func.names.add(cloneName)

      // Mirror programFacts under the clone's name with mono ctors at bimorphic
      // positions. emitFunc's preseed reads paramTypedCtors → seeds typedElem
      // map → `arr[i]` lowers to direct typed load.
      const cloneTctors = new Map(tctors)
      for (let i = 0; i < bimorphic.length; i++) cloneTctors.set(bimorphic[i], combo[i])
      paramTypedCtors.set(cloneName, cloneTctors)

      const origPvt = paramValTypes.get(func.name)
      const clonePvt = origPvt ? new Map(origPvt) : new Map()
      for (const k of bimorphic) clonePvt.set(k, VAL.TYPED)
      paramValTypes.set(cloneName, clonePvt)

      if (paramSchemas.has(func.name)) paramSchemas.set(cloneName, new Map(paramSchemas.get(func.name)))
      if (paramArrSchemas.has(func.name)) paramArrSchemas.set(cloneName, new Map(paramArrSchemas.get(func.name)))

      cloneByKey.set(key, clone)
    }

    // Rewrite each site's call AST to point at the matching clone.
    for (let i = 0; i < sites.length; i++) {
      const clone = cloneByKey.get(siteCombos[i].join('|'))
      sites[i].node[1] = clone.name
    }
  }
}

/**
 * Phase: program-fact collection.
 *
 * Single whole-program walk over the module AST + each user function body
 * + all moduleInits. Collects:
 *   dynVars/anyDyn   — vars accessed via runtime key (drives strict mode +
 *                      __dyn_get fallback gating)
 *   propMap          — property assignments per receiver (auto-box schemas)
 *   valueUsed        — ctx.func.names passed as first-class values (excluded
 *                      from internal narrowing — they need uniform $ftN ABI)
 *   maxDef/maxCall   — closure ABI width inputs
 *   hasRest/hasSpread
 *   callSites        — `{ callee, argList, callerFunc }` for static-name
 *                      calls (drives the type/schema fixpoint without
 *                      re-walking the AST)
 *   paramValTypes/paramWasmTypes/paramSchemas — empty Maps populated later
 *                      by narrowSignatures and read by emitFunc.
 *
 * Three visit modes:
 *   full=true  (ast + user funcs)  → all facts including call-site collection
 *   full=false (moduleInits)        → dyn + arity only (no propMap/valueUsed/
 *                                     callSites: moduleInits don't own user
 *                                     props/funcs)
 *   inArrow=true                    → flips off call-site collection so
 *                                     closure-internal calls don't poison
 *                                     caller-context type inference.
 */
function collectProgramFacts(ast) {
  const paramValTypes = new Map() // funcName → Map<paramIdx, valType | null>
  const paramWasmTypes = new Map() // funcName → Map<paramIdx, 'i32' | 'f64' | null>
  const paramSchemas = new Map()   // funcName → Map<paramIdx, schemaId | null>
  const paramArrSchemas = new Map()// funcName → Map<paramIdx, schemaId | null> (Array<schema>)
  const paramArrElemValTypes = new Map() // funcName → Map<paramIdx, VAL.* | null> (Array<vt>)
  const paramTypedCtors = new Map()// funcName → Map<paramIdx, ctor string | null>
  const valueUsed = new Set()
  const dynVars = new Set()
  let anyDyn = false
  const propMap = new Map()
  const callSites = []  // { callee, argList, callerFunc /* func obj or null */, node /* the ('()' callee args) AST node, mutable for specialization */ }
  const doSchema = ast && ctx.schema.register
  const doArity = !!ctx.closure.make
  let maxDef = 0, maxCall = 0, hasRest = false, hasSpread = false
  const isLiteralStr = idx => Array.isArray(idx) && idx[0] === 'str' && typeof idx[1] === 'string'
  // Slot-type collection: monomorphic property val types per schema, populated from
  // every static `{a: e1, b: e2, …}` literal in the program. Read by ctx.schema.slotVT
  // → valTypeOf on `.prop` AST nodes so downstream `+`, `===`, method dispatch can
  // skip the "is it a string?" runtime check on numeric props of known shapes.
  // Merge rule: first observation wins; second distinct kind → null (ambiguous).
  const slotTypes = ctx.schema.slotTypes
  const observeSlot = (sid, idx, vt) => {
    if (!vt) return
    let arr = slotTypes.get(sid)
    if (!arr) { arr = []; slotTypes.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    if (arr[idx] === null) return
    if (arr[idx] === undefined) arr[idx] = vt
    else if (arr[idx] !== vt) arr[idx] = null
  }
  const walkFacts = (node, full, inArrow, callerFunc) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    // dyn-key detection. Strict check deferred to emit time (e.g. `buf[i]` on a
    // Float64Array uses typed-array load, not __dyn_get — only the actual
    // dynamic-dispatch fallback should error in strict mode).
    if (op === '[]') {
      const [obj, idx] = args
      if (!isLiteralStr(idx)) { anyDyn = true; if (typeof obj === 'string') dynVars.add(obj) }
    } else if (op === 'for-in') {
      if (ctx.transform.strict) err(`strict mode: \`for (... in ...)\` is not allowed (dynamic enumeration). Pass { strict: false } to enable.`)
      anyDyn = true
      if (typeof args[1] === 'string') dynVars.add(args[1])
    }
    // Object literal: register schema + observe slot val types. Static-key only;
    // dynamic-key/spread shapes route through __dyn_set and have no fixed slot mapping.
    if (op === '{}' && doSchema) {
      const parsed = staticObjectProps(args)
      if (parsed) {
        const sid = ctx.schema.register(parsed.names)
        for (let i = 0; i < parsed.values.length; i++) observeSlot(sid, i, valTypeOf(parsed.values[i]))
      }
    }
    // closure ABI arity
    if (doArity) {
      if (op === '=>') {
        let fixedN = 0
        for (const r of extractParams(args[0])) {
          if (classifyParam(r).kind === 'rest') hasRest = true
          else fixedN++
        }
        if (fixedN > maxDef) maxDef = fixedN
      } else if (op === '()') {
        const a = args[1]
        const callArgs = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
        if (callArgs.some(x => Array.isArray(x) && x[0] === '...')) hasSpread = true
        if (callArgs.length > maxCall) maxCall = callArgs.length
      }
    }
    // Crossing into a closure body: from now on, no call-site collection (matches the
    // pre-fusion scanCalls bailing at '=>'). Still walks children for arity/dyn.
    if (op === '=>') {
      for (const a of args) walkFacts(a, full, true, callerFunc)
      return
    }
    if (full) {
      // property-assignment scan for auto-box
      if (doSchema && op === '=' && Array.isArray(args[0]) && args[0][0] === '.') {
        const [, obj, prop] = args[0]
        if (typeof obj === 'string' && (ctx.scope.globals.has(obj) || ctx.func.names.has(obj))) {
          if (!propMap.has(obj)) propMap.set(obj, new Set())
          propMap.get(obj).add(prop)
        }
      }
      // first-class function-value + static-call-site scan
      if (op === '()' && typeof args[0] === 'string' && ctx.func.names.has(args[0])) {
        if (!inArrow) {
          // Record call site for the type/schema fixpoint. Filtering by
          // exported/raw/valueUsed happens later (valueUsed isn't fully populated yet).
          // `node` is the call AST node itself; specializeBimorphicTyped mutates
          // node[1] (the callee name) to point at a per-ctor clone.
          const a = args[1]
          const argList = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
          callSites.push({ callee: args[0], argList, callerFunc, node })
        }
        for (let i = 1; i < args.length; i++) {
          const a = args[i]
          if (typeof a === 'string' && ctx.func.names.has(a)) valueUsed.add(a)
          else walkFacts(a, true, inArrow, callerFunc)
        }
        return
      }
      if ((op === '.' || op === '?.') && typeof args[0] === 'string' && ctx.func.names.has(args[0])) return
      for (const a of args) {
        if (typeof a === 'string' && ctx.func.names.has(a)) valueUsed.add(a)
        else walkFacts(a, true, inArrow, callerFunc)
      }
    } else {
      for (const a of args) walkFacts(a, false, inArrow, callerFunc)
    }
  }
  walkFacts(ast, true, false, null)
  for (const func of ctx.func.list) if (func.body && !func.raw) walkFacts(func.body, true, false, func)
  if (ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) walkFacts(mi, false, false, null)
  return {
    dynVars, anyDyn, propMap, valueUsed, callSites,
    maxDef, maxCall, hasRest, hasSpread,
    paramValTypes, paramWasmTypes, paramSchemas, paramArrSchemas, paramArrElemValTypes, paramTypedCtors,
  }
}

/**
 * Phase: emit one user function to WAT IR.
 *
 * Reads the (already-narrowed) `func.sig` and `programFacts.paramValTypes/paramSchemas`
 * to seed per-param val reps / schema bindings; emits body via emit / emitBody.
 *
 * Mutates ctx.func.* per-function state (locals, boxed, repByLocal, …) and
 * ctx.schema.vars (restored on exit so bindings don't leak across functions).
 */
function emitFunc(func, programFacts) {
  const { paramValTypes, paramSchemas, paramArrSchemas, paramArrElemValTypes, paramTypedCtors } = programFacts

  // Raw WAT functions (e.g., _alloc, _reset from memory module)
  if (func.raw) return parseWat(func.raw)

  const { name, body, exported, sig } = func
  const multi = sig.results.length > 1

  // Reset per-function state
  ctx.func.stack = []
  ctx.func.uniq = 0
  ctx.func.current = sig
  ctx.func.body = body
  ctx.func.directClosures = null

  // Pre-analyze local types from body
  // Block body vs object literal: object has ':' property nodes
  const block = Array.isArray(body) && body[0] === '{}' && body[1]?.[0] !== ':'
  ctx.func.boxed = new Map()  // variable name → cell local name (i32) for mutable capture
  ctx.func.localProps = null  // reset per function
  ctx.func.repByLocal = null  // Map<name, ValueRep> — populated lazily; reset per function
  ctx.types.typedElem = ctx.scope.globalTypedElem ? new Map(ctx.scope.globalTypedElem) : null
  // Pre-seed cross-call param facts BEFORE analyzeLocals/analyzeValTypes(body) so that
  // when the walker sees `const b0 = arr[i]` or `let n = arr.length`, lookupValType(arr)
  // already resolves to VAL.TYPED — letting valTypeOf's `[]` rule propagate VAL.NUMBER
  // to b0 (skips __to_num) and exprType's `.length` rule keep n as i32 (skips per-iter
  // f64.convert_i32_s + i32.trunc_sat_f64_s on the loop counter). Without this seed,
  // params don't gain VAL.TYPED until after analyzeLocals freezes counter widths.
  // (See narrowSignatures F-phase for paramTypedCtors source.)
  const _preTctors = paramTypedCtors.get(name)
  if (_preTctors) {
    for (const [k, ctor] of _preTctors) {
      if (ctor && k < sig.params.length) {
        const pname = sig.params[k].name
        if (!ctx.types.typedElem) ctx.types.typedElem = new Map()
        if (!ctx.types.typedElem.has(pname)) ctx.types.typedElem.set(pname, ctor)
        updateRep(pname, { val: VAL.TYPED })
      }
    }
  }
  const _prePtypes = paramValTypes.get(name)
  if (_prePtypes) {
    for (const [k, vt] of _prePtypes) {
      if (vt && k < sig.params.length) {
        const pname = sig.params[k].name
        if (!ctx.func.repByLocal?.get(pname)?.val) updateRep(pname, { val: vt })
      }
    }
  }
  // Pre-seed paramArrSchemas so analyzeValTypes's `arrElemSchemaOf(name)` finds
  // rep.arrayElemSchema for params bound to Array<sid> across all call sites.
  // Unlocks `const p = rows[i]` → bind p's schemaId → `p.x .y .z` → slot reads.
  const _preAetypes = paramArrSchemas.get(name)
  if (_preAetypes) {
    for (const [k, sid] of _preAetypes) {
      if (sid != null && k < sig.params.length) {
        const pname = sig.params[k].name
        updateRep(pname, { arrayElemSchema: sid })
      }
    }
  }
  // Pre-seed paramArrElemValTypes so valTypeOf's `arr[i]` rule finds
  // rep.arrayElemValType for params bound to Array<NUMBER/STRING/…>. Unlocks
  // `const x = a[i]` → x.val=NUMBER → `x*k` skips __to_num. Also unblocks
  // .map's argRep hint for inlined callback params.
  const _preAevtypes = paramArrElemValTypes.get(name)
  if (_preAevtypes) {
    for (const [k, vt] of _preAevtypes) {
      if (vt != null && k < sig.params.length) {
        const pname = sig.params[k].name
        updateRep(pname, { arrayElemValType: vt })
      }
    }
  }
  // Drop any earlier-cached analyzeLocals for this body — narrowSignatures called
  // it before our pre-seed, when params still had no inferred VAL.TYPED, so the
  // cached widths reflect the pre-narrow state. Re-walk now with reps in place.
  invalidateLocalsCache(body)
  ctx.func.locals = block ? analyzeLocals(body) : new Map()
  if (block) {
    analyzeValTypes(body)
    analyzeBoxedCaptures(body)
    // Lower provably-monomorphic pointer locals to i32 offset storage.
    const unbox = analyzePtrUnboxable(body, ctx.func.locals, ctx.func.boxed)
    if (unbox.size > 0) {
      for (const [n, kind] of unbox) {
        ctx.func.locals.set(n, 'i32')
        const fields = { ptrKind: kind }
        if (kind === VAL.TYPED) {
          const aux = typedElemAux(ctx.types.typedElem?.get(n))
          if (aux != null) fields.ptrAux = aux
        }
        updateRep(n, fields)
      }
    }
  }
  // Pointer-ABI params (from narrowing loop above): params already have type='i32' and
  // ptrKind set. Register them in ctx.func.repByLocal so readVar tags local.gets correctly.
  // Boxed capture still works: the boxed-init path (below) uses a ptrKind-tagged local.get
  // so asF64 reboxes to NaN-form before f64.store to the cell.
  for (const p of sig.params) {
    if (p.ptrKind == null) continue
    const fields = { ptrKind: p.ptrKind }
    if (p.ptrAux != null) fields.ptrAux = p.ptrAux
    updateRep(p.name, fields)
  }
  // D: Apply call-site param types (only if body analysis didn't already set them)
  const ptypes = paramValTypes.get(name)
  if (ptypes) {
    for (const [k, vt] of ptypes) {
      if (vt && k < sig.params.length) {
        const pname = sig.params[k].name
        if (!ctx.func.repByLocal?.get(pname)?.val) updateRep(pname, { val: vt })
      }
    }
  }
  // D: Apply call-site typed-array element ctors so `arr[i]` reads emit the
  // direct f64.load fast path inside the body (resolveElem(arr) hits a known
  // ctor instead of falling through to the runtime __typed_idx dispatch).
  // Also seeds val=TYPED on the param's rep if call-site valType propagation
  // didn't already pick it up — having the ctor implies TYPED (the array.js
  // indexed-access fast path keys off `lookupValType(arr) === 'typed'`).
  const tctors = paramTypedCtors.get(name)
  if (tctors) {
    for (const [k, ctor] of tctors) {
      if (ctor && k < sig.params.length) {
        const pname = sig.params[k].name
        if (!ctx.types.typedElem) ctx.types.typedElem = new Map()
        if (!ctx.types.typedElem.has(pname)) ctx.types.typedElem.set(pname, ctor)
        if (!ctx.func.repByLocal?.get(pname)?.val) updateRep(pname, { val: VAL.TYPED })
      }
    }
  }
  // D: Apply call-site schema bindings for non-exported params. Saved schema.vars
  // are restored after this function's emit so bindings don't leak across functions
  // that reuse param names (e.g. `o`). Requires all call sites to agree on schemaId.
  const stypes = paramSchemas.get(name)
  const schemaVarsPrev = new Map(ctx.schema.vars)
  if (stypes && !exported) {
    for (const [k, sid] of stypes) {
      if (sid == null || k >= sig.params.length) continue
      const pname = sig.params[k].name
      if (!ctx.schema.vars.has(pname)) {
        ctx.schema.vars.set(pname, sid)
        updateRep(pname, { schemaId: sid })
      }
    }
  }

  const fn = ['func', `$${name}`]
  if (exported) fn.push(['export', `"${name}"`])
  fn.push(...sig.params.map(p => ['param', `$${p.name}`, p.type]))
  fn.push(...sig.results.map(t => ['result', t]))

  // Default params: missing JS args become canonical NaN (0x7FF8000000000000) in WASM f64 params.
  // Check for canonical NaN specifically — NaN-boxed pointers are also NaN but have non-zero payload.
  const defaults = func.defaults || {}
  const defaultInits = []
  for (const [pname, defVal] of Object.entries(defaults)) {
    const p = sig.params.find(p => p.name === pname)
    const t = p?.type || 'f64'
    defaultInits.push(
      ['if', isNullish(typed(['local.get', `$${pname}`], 'f64')),
        ['then', ['local.set', `$${pname}`, t === 'f64' ? asF64(emit(defVal)) : asI32(emit(defVal))]]])
  }

  // Box params that are mutably captured: allocate cell, copy param value
  const boxedParamInits = []
  for (const p of sig.params) {
    if (ctx.func.boxed.has(p.name)) {
      const cell = ctx.func.boxed.get(p.name)
      ctx.func.locals.set(cell, 'i32')
      const lget = typed(['local.get', `$${p.name}`], p.type)
      if (p.ptrKind != null) lget.ptrKind = p.ptrKind
      boxedParamInits.push(
        ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
        ['f64.store', ['local.get', `$${cell}`], asF64(lget)])
    }
  }

  if (block) {
    const stmts = emitBody(body)
    for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
    // I: Skip trailing fallback when last statement is return (unreachable code)
    const lastStmt = stmts.at(-1)
    const endsWithReturn = lastStmt && (lastStmt[0] === 'return' || lastStmt[0] === 'return_call')
    fn.push(...defaultInits, ...boxedParamInits, ...stmts, ...(endsWithReturn ? [] : sig.results.map(t => [`${t}.const`, 0])))
  } else if (multi && body[0] === '[') {
    const values = body.slice(1).map(e => asF64(emit(e)))
    for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
    fn.push(...boxedParamInits, ...values)
  } else {
    const ir = emit(body)
    for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])
    const finalIR = sig.ptrKind != null ? asPtrOffset(ir, sig.ptrKind) : asParamType(ir, sig.results[0])
    fn.push(...defaultInits, ...boxedParamInits, finalIR)
  }

  // Restore schema.vars so param bindings don't leak to next function.
  ctx.schema.vars = schemaVarsPrev
  return fn
}

/**
 * Phase: emit one closure body to WAT IR.
 *
 * Closures share a uniform signature (env f64, argc i32, a0..a{W-1} f64) → f64
 * so any closure can be invoked via call_indirect on $ftN. This function
 * builds one body fn given the body record (cb) created by ctx.closure.make.
 *
 * Mutates ctx.func.* per-body state (locals, boxed, repByLocal) and
 * ctx.schema.vars / ctx.types.typedElem (restored on exit so capture-binding
 * leaks don't poison the next body). Returns the WAT IR for the func node.
 */
function emitClosureBody(cb) {
  const prevSchemaVars = ctx.schema.vars
  const prevTypedElems = ctx.types.typedElem
  // Reset per-function state for closure body
  ctx.func.locals = new Map()
  ctx.func.repByLocal = null
  if (cb.valTypes) for (const [name, vt] of cb.valTypes) updateRep(name, { val: vt })
  if (cb.schemaVars) {
    ctx.schema.vars = new Map([...prevSchemaVars, ...cb.schemaVars])
    for (const [name, sid] of cb.schemaVars) updateRep(name, { schemaId: sid })
  }
  const globalTE = ctx.scope.globalTypedElem
  if (cb.typedElems) {
    ctx.types.typedElem = globalTE ? new Map([...globalTE, ...cb.typedElems]) : new Map(cb.typedElems)
  } else if (globalTE) {
    ctx.types.typedElem = new Map(globalTE)
  } else {
    ctx.types.typedElem = prevTypedElems
  }
  // In closure bodies, boxed captures use the original name as both var and cell local
  ctx.func.boxed = cb.boxed ? new Map([...cb.boxed].map(v => [v, v])) : new Map()
  ctx.func.stack = []
  ctx.func.uniq = Math.max(ctx.func.uniq, 100) // avoid label collisions
  ctx.func.body = cb.body
  // Seed direct-call dispatch for captured const-bound closures (A3 across capture boundary).
  // closure.make snapshotted the parent's directClosures for each capture; here we restore
  // them so calls to a captured `peek` lower to `call $closureN` instead of call_indirect.
  ctx.func.directClosures = cb.directClosures ? new Map(cb.directClosures) : null
  // Uniform convention: (env f64, argc i32, a0..a{width-1} f64) → f64
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const paramDecls = [{ name: '__env', type: 'f64' }, { name: '__argc', type: 'i32' }]
  for (let i = 0; i < W; i++) paramDecls.push({ name: `__a${i}`, type: 'f64' })
  ctx.func.current = { params: paramDecls, results: ['f64'] }

  const fn = ['func', `$${cb.name}`]
  fn.push(['param', '$__env', 'f64'])
  fn.push(['param', '$__argc', 'i32'])
  for (let i = 0; i < W; i++) fn.push(['param', `$__a${i}`, 'f64'])
  fn.push(['result', 'f64'])

  // Params are locals, assigned directly from inline slots
  for (const p of cb.params) ctx.func.locals.set(p, 'f64')

  // Register captured variable locals: boxed = i32 cell pointer, otherwise f64 value
  for (let i = 0; i < cb.captures.length; i++) {
    const name = cb.captures[i]
    ctx.func.locals.set(name, ctx.func.boxed.has(name) ? 'i32' : 'f64')
  }

  // Emit body
  const block = Array.isArray(cb.body) && cb.body[0] === '{}' && cb.body[1]?.[0] !== ':'
  let bodyIR
  if (block) {
    for (const [k, v] of analyzeLocals(cb.body)) if (!ctx.func.locals.has(k)) ctx.func.locals.set(k, v)
    // Detect captures from deeper nested arrows that mutate this body's locals/params/captures
    analyzeBoxedCaptures(cb.body)
    for (const name of ctx.func.boxed.keys()) {
      if (ctx.func.locals.get(name) === 'f64') ctx.func.locals.set(name, 'i32')
    }
    bodyIR = emitBody(cb.body)
  } else {
    bodyIR = [asF64(emit(cb.body))]
  }

  // Pre-allocate cache locals for env unpacking
  const envBase = cb.captures.length > 0 ? `${T}envBase${ctx.func.uniq++}` : null
  if (envBase) ctx.func.locals.set(envBase, 'i32')
  // Rest param: allocate helper locals (len + offset) before emitting decls
  let restOff, restLen
  if (cb.rest) {
    restOff = `${T}restOff${ctx.func.uniq++}`
    restLen = `${T}restLen${ctx.func.uniq++}`
    ctx.func.locals.set(restOff, 'i32')
    ctx.func.locals.set(restLen, 'i32')
    inc('__alloc_hdr', '__mkptr')
  }

  // Insert locals (captures + params + declared)
  for (const [l, t] of ctx.func.locals) fn.push(['local', `$${l}`, t])

  // Load captures from env: boxed → i32.load (raw cell pointer), immutable → f64.load value.
  // env is the CLOSURE pointer (PTR.CLOSURE) — never an ARRAY, no forwarding chain.
  // Inline the offset extraction (low 32 bits) instead of calling __ptr_offset per invocation.
  if (envBase) {
    fn.push(['local.set', `$${envBase}`,
      ['i32.wrap_i64', ['i64.reinterpret_f64', ['local.get', '$__env']]]])
    for (let i = 0; i < cb.captures.length; i++) {
      const name = cb.captures[i]
      const addr = ['i32.add', ['local.get', `$${envBase}`], ['i32.const', i * 8]]
      fn.push(['local.set', `$${name}`,
        ctx.func.boxed.has(name) ? ['i32.load', addr] : ['f64.load', addr]])
    }
  }

  // Unpack fixed params directly from inline slots (caller padded missing with UNDEF_NAN).
  // Rest name (if present) is last in cb.params — handled separately below.
  const fixedParamN = cb.params.length - (cb.rest ? 1 : 0)
  for (let i = 0; i < fixedParamN && i < W; i++) {
    fn.push(['local.set', `$${cb.params[i]}`, ['local.get', `$__a${i}`]])
  }

  // Rest param: pack slots a[fixedParams..argc-1] into fresh array.
  // len = clamp(argc - fixedParams, 0, restSlots). Rest-param closures receive
  // at most (width - fixedParams) rest args — spread callers with
  // more dynamic elements lose the overflow (documented limitation).
  if (cb.rest) {
    const fixedN = fixedParamN
    const restSlots = W - fixedN
    fn.push(['local.set', `$${restLen}`,
      ['select',
        ['i32.sub', ['local.get', '$__argc'], ['i32.const', fixedN]],
        ['i32.const', 0],
        ['i32.gt_s', ['local.get', '$__argc'], ['i32.const', fixedN]]]])
    fn.push(['if', ['i32.gt_s', ['local.get', `$${restLen}`], ['i32.const', restSlots]],
      ['then', ['local.set', `$${restLen}`, ['i32.const', restSlots]]]])
    fn.push(['local.set', `$${restOff}`,
      ['call', '$__alloc_hdr',
        ['local.get', `$${restLen}`], ['local.get', `$${restLen}`], ['i32.const', 8]]])
    for (let i = 0; i < restSlots; i++) {
      fn.push(['if', ['i32.gt_s', ['local.get', `$${restLen}`], ['i32.const', i]],
        ['then', ['f64.store',
          ['i32.add', ['local.get', `$${restOff}`], ['i32.const', i * 8]],
          ['local.get', `$__a${fixedN + i}`]]]])
    }
    fn.push(['local.set', `$${cb.rest}`,
      ['call', '$__mkptr', ['i32.const', PTR.ARRAY], ['i32.const', 0], ['local.get', `$${restOff}`]]])
  }

  // Default params for closures (check sentinel after unpack)
  if (cb.defaults) {
    for (const [pname, defVal] of Object.entries(cb.defaults)) {
      fn.push(['if', isNullish(['local.get', `$${pname}`]),
        ['then', ['local.set', `$${pname}`, asF64(emit(defVal))]]])
    }
  }
  fn.push(...bodyIR)
  // I: Skip trailing fallback when last statement is return
  if (block && !(bodyIR.at(-1)?.[0] === 'return' || bodyIR.at(-1)?.[0] === 'return_call')) fn.push(['f64.const', 0])
  ctx.schema.vars = prevSchemaVars
  ctx.types.typedElem = prevTypedElems
  return fn
}

/**
 * Phase: build module-init function `__start`.
 *
 * `__start` is the WebAssembly start function: runs once at instantiation, after
 * imports/globals are bound but before any export is called. It threads together
 * everything that must happen before user code observes a ready module:
 *
 *   1. Reset per-function emit state (locals/repByLocal/boxed/stack) — __start is
 *      a fresh function context with no params.
 *   2. analyzeValTypes(ast) so emit sees correct ptrKind on top-level decls.
 *   3. Sub-module init (foreign module bootstrap) emits first — its globals
 *      must be assigned before main-module code reads them.
 *   4. emit(ast) — user top-level statements (let/const, call expressions, …).
 *   5. boxInit — auto-boxing globals (vars with prop assignments lifted to OBJECT).
 *   6. schemaInit — runtime schema-name table for JSON.stringify.
 *   7. strPoolInit — copy passive string-pool segment to heap (shared memory).
 *   8. typeofInit — preallocate typeof-result string globals.
 *
 * Order in the assembled body: strPool → typeof → box → schema → moduleInits → init.
 *
 * Late closures (those compiled during __start emit, e.g. arrows declared at
 * module scope) are flushed via `compilePendingClosures` and prepended to
 * `sec.funcs` so closure indices stay stable across the table.
 */
function buildStartFn(ast, sec, closureFuncs, compilePendingClosures) {
  ctx.func.locals = new Map()
  ctx.func.repByLocal = null
  ctx.func.boxed = new Map()
  ctx.func.stack = []
  ctx.func.current = { params: [], results: [] }
  analyzeValTypes(ast)
  const normalizeIR = ir => !ir?.length ? [] : Array.isArray(ir[0]) ? ir : [ir]

  const moduleInits = []
  if (ctx.module.moduleInits) {
    for (const mi of ctx.module.moduleInits) {
      analyzeValTypes(mi)
      moduleInits.push(...normalizeIR(emit(mi)))
    }
  }
  const init = emit(ast)

  const boxInit = []
  if (ctx.schema.autoBox) {
    const bt = `${T}box`
    ctx.func.locals.set(bt, 'i32')
    for (const [name, { schemaId, schema }] of ctx.schema.autoBox) {
      inc('__alloc', '__mkptr')
      boxInit.push(
        ['local.set', `$${bt}`, ['call', '$__alloc', ['i32.const', schema.length * 8]]],
        ['f64.store', ['local.get', `$${bt}`],
          ctx.func.names.has(name) ? ['f64.const', 0] : ['global.get', `$${name}`]],
        ...schema.slice(1).map((_, i) =>
          ['f64.store', ['i32.add', ['local.get', `$${bt}`], ['i32.const', (i + 1) * 8]], ['f64.const', 0]]),
        ['global.set', `$${name}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${bt}`])])
    }
  }

  const schemaInit = []
  // Schema name table is needed by JSON.stringify (legacy), and by __dyn_get's
  // OBJECT-schema fallback for polymorphic-receiver `.prop` access. Lift the
  // gate to also populate when any __dyn_get* family helper is included so
  // polymorphic OBJECT patterns (mismatched-schema `?:`, unknown-schema
  // params) resolve via runtime aux→sid lookup. Direct dependents of
  // __dyn_get (set transitively by resolveIncludes() later) are listed
  // explicitly here because the dep graph hasn't been expanded yet at
  // start-fn build time.
  const needsSchemaTbl = ctx.schema.list.length && (
    ctx.core.includes.has('__stringify') ||
    ctx.core.includes.has('__dyn_get') ||
    ctx.core.includes.has('__dyn_get_any') ||
    ctx.core.includes.has('__dyn_get_expr') ||
    ctx.core.includes.has('__dyn_get_or'))
  if (needsSchemaTbl) {
    const nSchemas = ctx.schema.list.length
    const stbl = `${T}stbl`
    const sarr = `${T}sarr`
    ctx.func.locals.set(stbl, 'i32')
    ctx.func.locals.set(sarr, 'i32')
    inc('__alloc', '__alloc_hdr', '__mkptr')
    schemaInit.push(
      ['local.set', `$${stbl}`, ['call', '$__alloc', ['i32.const', nSchemas * 8]]],
      ['global.set', '$__schema_tbl', ['local.get', `$${stbl}`]])
    for (let s = 0; s < nSchemas; s++) {
      const keys = ctx.schema.list[s]
      const n = keys.length
      schemaInit.push(
        ['local.set', `$${sarr}`, ['call', '$__alloc_hdr', ['i32.const', n], ['i32.const', n], ['i32.const', 8]]])
      for (let k = 0; k < n; k++)
        schemaInit.push(
          ['f64.store', ['i32.add', ['local.get', `$${sarr}`], ['i32.const', k * 8]],
            emit(['str', String(keys[k])])])
      schemaInit.push(
        ['f64.store', ['i32.add', ['local.get', `$${stbl}`], ['i32.const', s * 8]],
          mkPtrIR(PTR.ARRAY, 0, ['local.get', `$${sarr}`])])
    }
  }

  const strPoolInit = []
  if (ctx.runtime.strPool) {
    const total = ctx.runtime.strPool.length
    strPoolInit.push(
      ['global.set', '$__strBase', ['call', '$__alloc', ['i32.const', total]]],
      ['memory.init', '$__strPool', ['global.get', '$__strBase'], ['i32.const', 0], ['i32.const', total]],
      ['data.drop', '$__strPool'],
    )
  }

  const typeofInit = []
  if (ctx.runtime.typeofStrs) {
    for (const s of ctx.runtime.typeofStrs)
      typeofInit.push(['global.set', `$__tof_${s}`, emit(['str', s])])
  }
  if (moduleInits.length || init?.length || boxInit.length || schemaInit.length || typeofInit.length || strPoolInit.length) {
    const initIR = normalizeIR(init)
    const startFn = ['func', '$__start']
    for (const [l, t] of ctx.func.locals) startFn.push(['local', `$${l}`, t])
    startFn.push(...strPoolInit, ...typeofInit, ...boxInit, ...schemaInit, ...moduleInits, ...initIR)
    sec.start.push(startFn, ['start', '$__start'])
  }

  const beforeLen = closureFuncs.length
  compilePendingClosures()
  if (closureFuncs.length > beforeLen)
    sec.funcs.unshift(...closureFuncs.slice(beforeLen))
}

/**
 * Phase: closure-body dedup.
 *
 * Two closures with structurally-equal bodies (same shape after alpha-renaming
 * locals/params) are emitted as a single function — duplicates redirect through
 * the elem table to the canonical name. Closure bodies often share shape because
 * the same inner arrow can be instantiated in many places (e.g. parser combinators).
 *
 * IN:  closureFuncs (the WAT IR list emitted by emitClosureBody),
 *      sec.funcs (already contains closureFuncs + regular funcs),
 *      ctx.closure.table (elem-section names).
 * OUT: sec.funcs filtered to canonical bodies, ctx.closure.table redirected.
 *
 * Runs AFTER all closures (including those compiled during __start emit) are
 * collected so structural duplicates across batches collapse together.
 */
function dedupClosureBodies(closureFuncs, sec) {
  if (closureFuncs.length <= 1) return
  const canonicalize = (fn) => {
    const localNames = new Set()
    const collect = (node) => {
      if (!Array.isArray(node)) return
      if ((node[0] === 'local' || node[0] === 'param') && typeof node[1] === 'string' && node[1][0] === '$')
        localNames.add(node[1])
      for (const c of node) collect(c)
    }
    collect(fn)
    let counter = 0
    const renameMap = new Map()
    const walk = node => {
      if (typeof node === 'string') {
        if (!localNames.has(node)) return node
        let r = renameMap.get(node)
        if (!r) { r = `$_c${counter++}`; renameMap.set(node, r) }
        return r
      }
      if (!Array.isArray(node)) return node
      return node.map(walk)
    }
    return JSON.stringify(['func', ...fn.slice(2).map(walk)])
  }
  const hashToName = new Map()
  const redirect = new Map()
  const keepSet = new Set()
  for (const fn of closureFuncs) {
    const key = canonicalize(fn)
    const name = fn[1].slice(1)
    const canonical = hashToName.get(key)
    if (canonical) redirect.set(name, canonical)
    else { hashToName.set(key, name); keepSet.add(name) }
  }
  if (!redirect.size) return
  ctx.closure.table = ctx.closure.table.map(n => redirect.get(n) || n)
  const kept = sec.funcs.filter(fn => {
    if (!Array.isArray(fn) || fn[0] !== 'func') return true
    const name = typeof fn[1] === 'string' && fn[1][0] === '$' ? fn[1].slice(1) : null
    return !name || !redirect.has(name)
  })
  sec.funcs.length = 0
  sec.funcs.push(...kept)
}

/**
 * Phase: closure-table finalize + ABI shrink.
 *
 * Two opportunities, both gated on a post-emit scan for `call_indirect`:
 *
 *   1. Drop dead $ftN type / table / elem when the scan finds zero call_indirect
 *      sites (every closure call was direct-dispatched via A3 + capture-boundary
 *      propagation, AND no top-level fn was taken as a value). Closure pointers
 *      still carry funcIdx in their NaN-box aux bits, but those bits become dead
 *      state with no reader.
 *
 *   2. Per-body ABI shrink: with no call_indirect, every closure is direct-only,
 *      so the uniform `(env, argc, a0..a{W-1})` ABI is no longer required.
 *      Each body sheds:
 *        • $__env     when captures.length === 0
 *        • $__argc    when no rest param (defaults check param value, not argc)
 *        • $__a{i}    for i ≥ fixedN when no rest (caller's UNDEF padding is dead)
 *      Rest closures keep all W slots — argc + slot{fixedN..W-1} are how rest packs.
 *      Both `call` and `return_call` (tail call) sites are rewritten in the same walk.
 */
function finalizeClosureTable(sec) {
  if (!ctx.closure.table?.length) return
  let indirectUsed = false
  const scan = (n) => {
    if (!Array.isArray(n) || indirectUsed) return
    if (n[0] === 'call_indirect') { indirectUsed = true; return }
    for (const c of n) if (Array.isArray(c)) scan(c)
  }
  for (const fn of sec.funcs) { scan(fn); if (indirectUsed) break }
  if (!indirectUsed) for (const fn of sec.start) scan(fn)
  // Keep table if host may call closures (timers, etc.)
  const hostCallsClosures = ctx.module.imports.some(i => i[1] === '"jz"')
  if (indirectUsed || hostCallsClosures) {
    sec.table = [['table', ['export', '"__jz_table"'], ctx.closure.table.length, 'funcref']]
    sec.elem = [['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)]]
    return
  }
  sec.table = []
  sec.elem = []
  sec.types = sec.types.filter(t => !(Array.isArray(t) && t[1] === '$ftN'))
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const abiOf = new Map()
  for (const cb of (ctx.closure.bodies || [])) {
    const fixedN = cb.params.length - (cb.rest ? 1 : 0)
    abiOf.set(cb.name, {
      needEnv: cb.captures.length > 0,
      needArgc: !!cb.rest,
      usedSlots: cb.rest ? W : fixedN,
      rest: !!cb.rest,
    })
  }
  for (const fn of sec.funcs) {
    if (!Array.isArray(fn) || fn[0] !== 'func') continue
    const fnName = typeof fn[1] === 'string' && fn[1][0] === '$' ? fn[1].slice(1) : null
    const abi = abiOf.get(fnName)
    if (!abi) continue
    for (let i = fn.length - 1; i >= 0; i--) {
      const node = fn[i]
      if (!Array.isArray(node) || node[0] !== 'param') continue
      const pname = node[1]
      if (pname === '$__env' && !abi.needEnv) fn.splice(i, 1)
      else if (pname === '$__argc' && !abi.needArgc) fn.splice(i, 1)
      else if (typeof pname === 'string' && pname.startsWith('$__a') && !abi.rest) {
        const idx = parseInt(pname.slice(4), 10)
        if (Number.isFinite(idx) && idx >= abi.usedSlots) fn.splice(i, 1)
      }
    }
  }
  const rewriteCalls = (node) => {
    if (!Array.isArray(node)) return
    for (const c of node) if (Array.isArray(c)) rewriteCalls(c)
    if ((node[0] === 'call' || node[0] === 'return_call') && typeof node[1] === 'string') {
      const callee = node[1].slice(1)
      const abi = abiOf.get(callee)
      if (!abi) return
      const newArgs = []
      if (abi.needEnv) newArgs.push(node[2])
      if (abi.needArgc) newArgs.push(node[3])
      for (let i = 0; i < abi.usedSlots; i++) newArgs.push(node[4 + i])
      node.splice(2, node.length - 2, ...newArgs)
    }
  }
  for (const fn of sec.funcs) rewriteCalls(fn)
  for (const fn of sec.start) rewriteCalls(fn)
}

/**
 * Phase: pull stdlib + memory.
 *
 * Runs AFTER __start is built — emit calls during __start (e.g. typeofStrs,
 * boxInit, schemaInit) trigger `inc()` for any helpers they need, and those
 * additions must be observed before resolveIncludes() expands the dependency
 * closure.
 *
 * Steps:
 *   1. resolveIncludes() — close the include set under stdlib dependencies.
 *   2. Emit memory section ONLY when some included helper uses memory ops
 *      (G optimization: pure scalar programs ship without memory + __heap).
 *      When memory is needed, the allocator (__alloc + __alloc_hdr + __reset)
 *      is force-included since stdlib funcs may call into it.
 *   3. Pull external (host) stdlibs into sec.extStdlib (must precede normal
 *      imports in the module byte order).
 *   4. Pull resolved factory stdlibs (those keyed by feature gates) into
 *      sec.stdlib via parseWat.
 *
 * Also reports any unresolved stdlib name (logged, not thrown — keeps test
 * output readable when a missing helper is the actual bug).
 */
function pullStdlib(sec) {
  resolveIncludes()

  const needsMemory = [...ctx.core.includes].some(n => ctx.core.stdlib[n] && MEM_OPS.test(ctx.core.stdlib[n]))
  if (!needsMemory) ctx.scope.globals.delete('__heap')
  if (needsMemory && ctx.module.modules.core) {
    for (const fn of ['__alloc', '__alloc_hdr', '__reset']) if (!ctx.core.includes.has(fn)) ctx.core.includes.add(fn)
    const pages = ctx.memory.pages || 1
    if (ctx.memory.shared) sec.imports.push(['import', '"env"', '"memory"', ['memory', pages]])
    else sec.memory.push(['memory', ['export', '"memory"'], pages])
    if (ctx.core._allocRawFuncs) sec.funcs.push(...ctx.core._allocRawFuncs.map(s => parseWat(s)))
  }

  const stdlibStr = (name) => {
    const v = ctx.core.stdlib[name]
    return typeof v === 'function' ? v() : v
  }
  for (const name of Object.keys(ctx.core.stdlib)) {
    if (name.startsWith('__ext_') && ctx.core.includes.has(name)) {
      const parsed = parseWat(stdlibStr(name))
      sec.extStdlib.push(parsed[0] === "module" ? parsed[1] : parsed)
      ctx.core.includes.delete(name)
    }
  }
  for (const n of ctx.core.includes) if (!ctx.core.stdlib[n]) console.error("MISSING stdlib:", n)
  sec.stdlib.push(...[...ctx.core.includes].map(n => parseWat(stdlibStr(n))))
}

/**
 * Phase: whole-module + per-function optimization passes.
 *
 * Order matters and is non-obvious — fixed deliberately:
 *
 *   1. specializeMkptr — replaces `call $__mkptr (T, A, off)` with `$__mkptr_T_A_d`
 *      for known (T, A) pairs (saves ~4 B/site). Must run BEFORE per-function
 *      passes so the new variants exist when fusedRewrite folds calls into them.
 *   2. specializePtrBase — folds `call F (add (global G) const)` to a `_p`
 *      variant (saves ~3 B/site). After specializeMkptr so mkptr variants
 *      ($__mkptr_T_A_d) are visible to it.
 *   3. sortStrPoolByFreq — reorders string-pool entries so hot strings get low
 *      offsets (shrinking i32.const LEB128). Shared-memory only (passive segment).
 *   4. optimizeFunc per fn — hoistPtrType + fusedRewrite + sortLocalsByUse.
 *      Must run after specializeMkptr/specializePtrBase introduce new helpers.
 *   5. hoistConstantPool — repeated f64 literals → mutable globals.
 *      Last because earlier passes might fold/eliminate constants.
 *
 * Also adjusts $__heap base when data segment exceeds 1024 bytes (default
 * heap base) — keeps user code at offset 0 from clobbering the data segment.
 */
function optimizeModule(sec) {
  specializeMkptr([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat)
  specializePtrBase([...sec.funcs, ...sec.stdlib, ...sec.start], wat => sec.stdlib.push(parseWat(wat)), parseWat)
  if (ctx.runtime.strPool) {
    const poolRef = { pool: ctx.runtime.strPool }
    sortStrPoolByFreq([...sec.funcs, ...sec.stdlib, ...sec.start], poolRef, ctx.runtime.strPoolDedup)
    ctx.runtime.strPool = poolRef.pool
  }
  for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) optimizeFunc(s)
  hoistConstantPool([...sec.funcs, ...sec.stdlib, ...sec.start], (name, wat) => ctx.scope.globals.set(name, wat))

  const dataLen = ctx.runtime.data?.length || 0
  if (dataLen > 1024 && !ctx.memory.shared) {
    const heapBase = (dataLen + 7) & ~7
    ctx.scope.globals.set('__heap', `(global $__heap (mut i32) (i32.const ${heapBase}))`)
    for (const s of sec.stdlib)
      if (s[0] === 'func' && s[1] === '$__reset')
        for (let i = 2; i < s.length; i++)
          if (Array.isArray(s[i]) && s[i][0] === 'global.set' && Array.isArray(s[i][2]) && s[i][2][0] === 'i32.const')
            s[i][2][1] = `${heapBase}`
  }
}

/**
 * Phase: strip static-data prefix.
 *
 * R: when `__static_str` runtime helper isn't included, the leading prefix of the
 * data segment (the static string-table header) is dead — strip it and shift all
 * pointer offsets in user code, embedded data slots, and constant-folded NaN-box
 * literals down by `prefix` bytes. ATOM/SSO have no offset, so they're unaffected.
 *
 * Patches both runtime-call form (`__mkptr(T, A, off)`) and the constant-folded
 * form (`f64.reinterpret_i64 (i64.const ...)`) when offset >= prefix.
 */
function stripStaticDataPrefix(sec) {
  if (!ctx.runtime.staticDataLen || ctx.core.includes.has('__static_str')) return
  const prefix = ctx.runtime.staticDataLen
  const SHIFTABLE = new Set([PTR.STRING, PTR.OBJECT, PTR.ARRAY, PTR.HASH, PTR.SET, PTR.MAP, PTR.BUFFER, PTR.TYPED, PTR.CLOSURE])
  const data = ctx.runtime.data || ''
  const buf = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i)
  const dv = new DataView(buf.buffer)
  if (ctx.runtime.staticPtrSlots) {
    for (const slotOff of ctx.runtime.staticPtrSlots) {
      if (slotOff < prefix) continue
      const bits = dv.getBigUint64(slotOff, true)
      if (((bits >> 48n) & 0xFFF8n) !== NAN_PREFIX_BITS) continue
      const ty = Number((bits >> 47n) & 0xFn)
      if (!SHIFTABLE.has(ty)) continue
      const off = Number(bits & 0xFFFFFFFFn)
      if (off < prefix) continue
      const hi = bits & ~0xFFFFFFFFn
      dv.setBigUint64(slotOff, hi | BigInt(off - prefix), true)
    }
  }
  let s = ''
  for (let i = prefix; i < buf.length; i++) s += String.fromCharCode(buf[i])
  ctx.runtime.data = s
  if (ctx.runtime.staticPtrSlots) ctx.runtime.staticPtrSlots = ctx.runtime.staticPtrSlots
    .filter(o => o >= prefix).map(o => o - prefix)
  const shift = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) {
      const child = node[i]
      if (!Array.isArray(child)) continue
      if (child[0] === 'call' && child[1] === '$__mkptr' &&
        Array.isArray(child[2]) && SHIFTABLE.has(child[2][1]) &&
        Array.isArray(child[4]) && child[4][0] === 'i32.const' &&
        typeof child[4][1] === 'number' && child[4][1] >= prefix) {
        child[4][1] -= prefix
      } else if (child[0] === 'f64.const' &&
        typeof child[1] === 'string' && child[1].startsWith('nan:0x')) {
        const bits = BigInt(child[1].slice(4)) | 0x7FF0000000000000n
        if (((bits >> 48n) & 0xFFF8n) === NAN_PREFIX_BITS) {
          const ty = Number((bits >> 47n) & 0xFn)
          if (SHIFTABLE.has(ty)) {
            const off = Number(bits & 0xFFFFFFFFn)
            if (off >= prefix) {
              const hi = bits & ~0xFFFFFFFFn
              const newBits = hi | BigInt(off - prefix)
              child[1] = 'nan:0x' + newBits.toString(16).toUpperCase().padStart(16, '0')
            }
          }
        }
      }
      shift(child)
    }
  }
  for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) shift(s)
}

/**
 * Compile prepared AST to WASM module IR.
 * @param {import('./prepare.js').ASTNode} ast - Prepared AST
 * @returns {Array} Complete WASM module as S-expression
 */
export default function compile(ast) {
  // Populate known function names + lookup map on ctx.func for direct call detection
  ctx.func.names.clear()
  ctx.func.map.clear()
  for (const f of ctx.func.list) { ctx.func.names.add(f.name); ctx.func.map.set(f.name, f) }
  // Include imported functions for call resolution (e.g. template interpolations)
  for (const imp of ctx.module.imports)
    if (imp[3]?.[0] === 'func') ctx.func.names.add(imp[3][1].replace(/^\$/, ''))

  // Check user globals don't conflict with runtime globals (modules loaded after user decls)
  for (const name of ctx.scope.userGlobals)
    if (!ctx.scope.globals.get(name)?.includes('mut f64'))
      err(`'${name}' conflicts with a compiler internal — choose a different name`)

  // Pre-fold const globals: evaluate constant initializers before function compilation
  // so functions see the correct global types (i32 vs f64).
  if (ast) {
    const evalConst = n => {
      if (typeof n === 'number') return n
      if (Array.isArray(n) && n[0] == null && typeof n[1] === 'number') return n[1]
      if (!Array.isArray(n)) return null
      const [op, a, b] = n
      const va = evalConst(a), vb = b !== undefined ? evalConst(b) : null
      if (va == null) return null
      if (op === 'u-' || (op === '-' && b === undefined)) return -va
      if (vb == null) return null
      if (op === '+') return va + vb; if (op === '-') return va - vb
      if (op === '*') return va * vb; if (op === '%' && vb) return va % vb
      if (op === '/' && vb) return va / vb; if (op === '**') return va ** vb
      if (op === '&') return va & vb; if (op === '|') return va | vb
      if (op === '^') return va ^ vb; if (op === '<<') return va << vb
      if (op === '>>') return va >> vb; if (op === '>>>') return va >>> vb
      return null
    }
    const stmts = Array.isArray(ast) && ast[0] === ';' ? ast.slice(1)
      : Array.isArray(ast) && ast[0] === 'const' ? [ast] : []
    for (const s of stmts) {
      if (!Array.isArray(s) || s[0] !== 'const') continue
      for (const decl of s.slice(1)) {
        if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
        const [, name, init] = decl
        if (!ctx.scope.globals.has(name) || !ctx.scope.consts?.has(name)) continue
        const v = evalConst(init)
        if (v == null || !isFinite(v)) continue
        const isInt = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
        ctx.scope.globals.set(name, isInt
          ? `(global $${name} i32 (i32.const ${v}))`
          : `(global $${name} f64 (f64.const ${v}))`)
        ctx.scope.globalTypes.set(name, isInt ? 'i32' : 'f64')
      }
    }
  }

  // Pre-scan module-scope value types so functions can dispatch methods on globals.
  // Also scan moduleInits so cross-module imports (e.g. regex literals from util.js)
  // resolve to the correct static dispatch path.
  const scanStmts = (root) => {
    if (!root) return
    const stmts = Array.isArray(root) && root[0] === ';' ? root.slice(1) : [root]
    for (const s of stmts) {
      if (!Array.isArray(s) || (s[0] !== 'const' && s[0] !== 'let')) continue
      for (const decl of s.slice(1)) {
        if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
        const vt = valTypeOf(decl[2])
        if (vt) {
          if (!ctx.scope.globalValTypes) ctx.scope.globalValTypes = new Map()
          ctx.scope.globalValTypes.set(decl[1], vt)
          if (vt === VAL.REGEX && ctx.runtime.regex) ctx.runtime.regex.vars.set(decl[1], decl[2])
        }
        const ctor = typedElemCtor(decl[2])
        if (ctor) {
          if (!ctx.scope.globalTypedElem) ctx.scope.globalTypedElem = new Map()
          ctx.scope.globalTypedElem.set(decl[1], ctor)
        }
      }
    }
  }
  scanStmts(ast)
  if (ctx.module.moduleInits) for (const init of ctx.module.moduleInits) scanStmts(init)

  // Unbox const TYPED globals: change `(mut f64)` slot to `(mut i32)` and store the raw
  // pointer offset. Reads tag the global.get with ptrKind=TYPED + ptrAux=elemType so
  // typed-array consumers (.[]/.buffer/…) can resolve through ptrOffsetIR without ever
  // calling __ptr_offset on a NaN-box. Init still flows through emit.js, but the assign
  // coerces via asPtrOffset(val, VAL.TYPED) — one bit-extract at startup, then every
  // hot read is a plain `global.get` of an i32.
  if (ctx.scope.globalTypedElem && ctx.scope.consts) {
    for (const [name, ctor] of ctx.scope.globalTypedElem) {
      if (!ctx.scope.consts.has(name)) continue
      if (ctx.scope.globalValTypes?.get(name) !== VAL.TYPED) continue
      const aux = typedElemAux(ctor)
      if (aux == null) continue
      const decl = ctx.scope.globals.get(name)
      if (typeof decl !== 'string' || !decl.includes('mut f64')) continue
      ctx.scope.globals.set(name, `(global $${name} (mut i32) (i32.const 0))`)
      ctx.scope.globalTypes.set(name, 'i32')
      updateGlobalRep(name, { ptrKind: VAL.TYPED, ptrAux: aux })
    }
  }

  // === ProgramFacts: single whole-program walk over ast + user funcs + moduleInits ===
  // See collectProgramFacts (top of file) for the contract. ctx.types.* mirrors are
  // kept here because ir.js consumes them at emit time (will be replaced when emit
  // takes facts explicitly — S3).
  const programFacts = collectProgramFacts(ast)
  ctx.types.dynKeyVars = programFacts.dynVars
  ctx.types.anyDynKey = programFacts.anyDyn

  // Materialize auto-box schemas from collected propMap
  if (ast && ctx.schema.register) {
    for (const [name, props] of programFacts.propMap) {
      if (ctx.schema.vars.has(name)) {
        const existing = ctx.schema.resolve(name)
        const newProps = [...props].filter(p => !existing.includes(p))
        if (newProps.length) {
          const merged = [...existing, ...newProps]
          const mergedId = ctx.schema.register(merged)
          ctx.schema.vars.set(name, mergedId)
        }
        continue
      }
      const valueProps = [...props].filter(p => !ctx.func.names.has(`${name}$${p}`))
      if (!valueProps.length) continue
      const allProps = [...props]
      const schema = ['__inner__', ...allProps]
      const schemaId = ctx.schema.register(schema)
      ctx.schema.vars.set(name, schemaId)
      if (ctx.func.names.has(name) && !ctx.scope.globals.has(name))
        ctx.scope.globals.set(name, `(global $${name} (mut f64) (f64.const 0))`)
      if (!ctx.schema.autoBox) ctx.schema.autoBox = new Map()
      ctx.schema.autoBox.set(name, { schemaId, schema })
    }
  }

  // Dynamic closure ABI width: max param count (`=>` defs), max call arity, rest/spread
  // accumulated by walkFacts above. $ftN type, call-site padding, and body slot decls
  // use this instead of the static MAX_CLOSURE_ARITY cap. hasRest adds +1 for rest
  // overflow. hasSpread + hasRest together force MAX (spread expands unknown element
  // count at runtime, and any rest receiver may consume them).
  if (ctx.closure.make) {
    const { hasSpread, hasRest, maxCall, maxDef } = programFacts
    const floor = ctx.closure.floor ?? 0
    ctx.closure.width = (hasSpread && hasRest)
      ? MAX_CLOSURE_ARITY
      : Math.min(MAX_CLOSURE_ARITY, Math.max(maxCall, maxDef + (hasRest ? 1 : 0), floor))
  }

  narrowSignatures(programFacts)
  specializeBimorphicTyped(programFacts)

  const funcs = ctx.func.list.map(func => emitFunc(func, programFacts))

  const closureFuncs = []
  let compiledBodyCount = 0
  const compilePendingClosures = () => {
    const bodies = ctx.closure.bodies || []
    for (let bodyIndex = compiledBodyCount; bodyIndex < bodies.length; bodyIndex++) {
      closureFuncs.push(emitClosureBody(bodies[bodyIndex]))
    }
    compiledBodyCount = bodies.length
  }
  compilePendingClosures()

  // Build module sections — named slots, assembled at the end (no index bookkeeping)
  const sec = {
    extStdlib: [],  // external stdlib (imports that must precede all other imports)
    imports: [...ctx.module.imports],
    types: [],      // function types for call_indirect
    memory: [],     // memory declaration
    data: [],       // data segment (filled after emit)
    tags: [],       // error tags + related exports
    table: [],      // function table (at most one)
    globals: [],    // globals (filled after __start)
    funcs: [],      // closure funcs + regular funcs
    elem: [],       // element section (table init)
    start: [],      // __start func + start directive
    stdlib: [],     // stdlib functions
    customs: [],    // custom sections + exports
  }

  // Uniform closure convention: (env f64, argc i32, a0..a{MAX-1} f64) → f64.
  // argc = actual arg count passed; missing slots padded with UNDEF_NAN at caller.
  // Rest-param bodies pack slots a[fixedParams..argc-1] into their rest array.
  // MAX_CLOSURE_ARITY is the fixed inline-slot count; calls with more args error.
  if (ctx.closure.types) {
    const params = [['param', 'f64'], ['param', 'i32']] // env + argc
    for (let i = 0; i < (ctx.closure.width ?? MAX_CLOSURE_ARITY); i++) params.push(['param', 'f64'])
    sec.types.push(['type', `$ftN`, ['func', ...params, ['result', 'f64']]])
  }

  // Memory section deferred — emitted after resolveIncludes() when __alloc is needed

  if (ctx.runtime.throws) {
    ctx.scope.globals.set('__jz_last_err_bits', '(global $__jz_last_err_bits (mut i64) (i64.const 0))')
    sec.tags.push(['tag', '$__jz_err', ['param', 'f64']])
    sec.tags.push(['export', '"__jz_last_err_bits"', ['global', '$__jz_last_err_bits']])
  }

  if (ctx.closure.table?.length)
    sec.table.push(['table', ['export', '"__jz_table"'], ctx.closure.table.length, 'funcref'])

  sec.funcs.push(...closureFuncs, ...funcs)

  if (ctx.closure.table?.length)
    sec.elem.push(['elem', ['i32.const', 0], 'func', ...ctx.closure.table.map(n => `$${n}`)])

  buildStartFn(ast, sec, closureFuncs, compilePendingClosures)

  dedupClosureBodies(closureFuncs, sec)

  finalizeClosureTable(sec)

  pullStdlib(sec)

  stripStaticDataPrefix(sec)

  optimizeModule(sec)

  // Populate globals (after __start — const folding may update declarations)
  sec.globals.push(...[...ctx.scope.globals.values()].filter(g => g).map(g => parseWat(g)))

  // Data segments (after emit — string literals append to ctx.runtime.data / strPool during emit)
  // Active segment at address 0 — skipped for shared memory (would collide across modules)
  const escBytes = (s) => {
    let esc = ''
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 32 && c < 127 && c !== 34 && c !== 92) esc += s[i]
      else esc += '\\' + c.toString(16).padStart(2, '0')
    }
    return esc
  }
  if (ctx.runtime.data && !ctx.memory.shared)
    sec.data.push(['data', ['i32.const', 0], '"' + escBytes(ctx.runtime.data) + '"'])
  // Passive segment for shared-memory string literals (copied via memory.init at runtime)
  if (ctx.runtime.strPool)
    sec.data.push(['data', '$__strPool', '"' + escBytes(ctx.runtime.strPool) + '"'])

  // Custom section: embed object schemas for JS-side interop.
  // Compact binary format: varint(nSchemas); per schema: varint(nProps); per prop:
  //   0x00=null, 0x01=[null, <prop>], 0x02=<varint len><utf8 bytes>. Runtime decodes.
  if (ctx.schema.list.length) {
    const bytes = []
    const utf8 = new TextEncoder()
    const varint = (n) => { while (n >= 0x80) { bytes.push((n & 0x7F) | 0x80); n >>>= 7 } bytes.push(n) }
    const enc = (p) => {
      if (p === null) bytes.push(0)
      else if (Array.isArray(p)) { bytes.push(1); enc(p[1]) }
      else { bytes.push(2); const b = utf8.encode(p); varint(b.length); for (const x of b) bytes.push(x) }
    }
    varint(ctx.schema.list.length)
    for (const s of ctx.schema.list) { varint(s.length); for (const p of s) enc(p) }
    sec.customs.push(['@custom', '"jz:schema"', bytes])
  }

  // Custom section: rest params for exported functions (JS-side wrapping)
  const restParamFuncs = ctx.func.list.filter(f => f.exported && f.rest)
    .map(f => ({ name: f.name, fixed: f.sig.params.length - 1 }))
  if (restParamFuncs.length)
    sec.customs.push(['@custom', '"jz:rest"', `"${JSON.stringify(restParamFuncs).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`])

  // Named export aliases: export { name } or export { source as alias }
  for (const [name, val] of Object.entries(ctx.func.exports)) {
    if (val === true) {
      if (ctx.scope.userGlobals?.has(name)) sec.customs.push(['export', `"${name}"`, ['global', `$${name}`]])
      continue
    }
    if (typeof val !== 'string') continue
    const func = ctx.func.list.find(f => f.name === val)
    if (func) sec.customs.push(['export', `"${name}"`, ['func', `$${val}`]])
    else if (ctx.scope.globals.has(val)) sec.customs.push(['export', `"${name}"`, ['global', `$${val}`]])
  }

  // Whole-module: prune funcs unreachable from entry points (start, exports, elem refs).
  // Removes orphan top-level consts that never get called (e.g. watr's unused `hoist` = 26 KB).
  // Also returns callCount Map (computed during the same walk — used below for funcidx sort).
  const { callCount } = treeshake(
    [{ arr: sec.stdlib }, { arr: sec.funcs }, { arr: sec.start }],
    [...sec.start, ...sec.elem, ...sec.customs, ...sec.extStdlib, ...sec.imports]
  )

  // Reorder non-import funcs by call count: hot callees get low LEB128 indices.
  // `call $f` encodes funcidx as ULEB128 (1 B for idx < 128, 2 B for idx < 16384).
  // On watr self-host this saves ~6 KB (hot specialized helpers migrate to idx < 128).
  // callCount was computed inline by treeshake's walk (same set of nodes).
  const byCalls = (a, b) => (callCount.get(b[1]) || 0) - (callCount.get(a[1]) || 0)
  const startFn = sec.start.find(n => n[0] === 'func')
  const startDir = sec.start.find(n => n[0] === 'start')
  const sortedFuncs = [
    ...sec.stdlib, ...sec.funcs, ...(startFn ? [startFn] : []),
  ].sort(byCalls)

  // Assemble: named slots → flat section list.
  const sections = [
    ...sec.extStdlib, ...sec.imports, ...sec.types, ...sec.memory, ...sec.data,
    ...sec.tags, ...sec.table, ...sec.globals, ...sortedFuncs,
    ...sec.elem, ...(startDir ? [startDir] : []), ...sec.customs,
  ]
  return ['module', ...sections]
}
