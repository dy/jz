/**
 * Signature narrowing — fixpoint analysis that mutates each user func's `sig`
 * based on call-site observations.
 *
 * Reads programFacts.callSites + valueUsed; mutates sig.params/results,
 * func.valResult, and programFacts.paramReps. Pure w.r.t. the AST — only
 * function `sig` records change.
 */

import { ctx } from './ctx.js'
import {
  VAL,
  analyzeBody, analyzeLocals,
  callerParamFactMap, clearStickyNull, ensureParamRep, mergeParamFact,
  exprType, findMutations, hasBareReturn, inferArgArrElemSchema,
  inferArgArrElemValType, inferArgSchema, inferArgType, inferArgTypedCtor,
  invalidateLocalsCache, invalidateValTypesCache, isBlockBody, alwaysReturns,
  narrowReturnArrayElems, observeProgramSlots, returnExprs, staticObjectProps,
  typedElemAux, typedElemCtor, ctorFromElemAux, valTypeOf,
} from './analyze.js'

export default function narrowSignatures(programFacts, ast) {
  const { callSites, valueUsed, paramReps } = programFacts

  // Reachability filter: dead callerFuncs (e.g. unused stdlib helpers from bundled
  // modules) shouldn't poison narrowing of live functions. Without this, a never-
  // executed call like `checksumF64 → mix(h, u[i])` would force mix's `x` rep to
  // bimorphic (f64 ∪ i32) and block i32 narrowing of mix's hot caller (runKernel).
  // Live = exported ∪ value-used ∪ transitively reached from those + top-level.
  // Top-level call sites have callerFunc === null and are unconditionally live.
  if (callSites.length) {
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
    // Mutate in place — every later phase reads the same array.
    let w = 0
    for (let r = 0; r < callSites.length; r++) {
      const cs = callSites[r]
      if (cs.callerFunc === null || live.has(cs.callerFunc.name)) callSites[w++] = cs
    }
    callSites.length = w
  }

  // D: Call-site type propagation — infer param types from how functions are called.
  // Drives off `callSites` collected during the ProgramFacts walk; no AST re-walking.
  // For non-exported internal functions, if all call sites agree on a param's type,
  // seed the param's val rep (ctx.func.repByLocal) during per-function compilation.
  // Also infer i32/f64 WASM type — when all call sites pass i32 for a param, specialize
  // sig.params[k].type to i32 (no default, no rest, not exported, not value-used).
  // Also propagate schema ID — when all call sites pass objects with the same schema,
  // bind the callee's param to that schema so `p.x` becomes a direct slot load.
  // Inference helpers (inferArgType/inferArgSchema/inferArgArr*/inferArgTypedCtor)
  // live in analyze.js — pure AST→fact resolvers shared across fixpoint phases.
  // Per-caller analysis is stable across fixpoint iterations — precompute once.
  // callerCtx[null] (top-level) uses module globals for both locals and valTypes.
  const callerCtx = new Map()  // funcObj | null → { callerLocals, callerValTypes }
  callerCtx.set(null, { callerLocals: ctx.scope.globalTypes, callerValTypes: ctx.scope.globalValTypes })
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    // Single unified walk — locals + valTypes from the same traversal.
    const facts = analyzeBody(func.body)
    for (const p of func.sig.params) if (!facts.locals.has(p.name)) facts.locals.set(p.name, p.type)
    callerCtx.set(func, { callerLocals: facts.locals, callerValTypes: facts.valTypes })
  }
  // Per-caller arr-elem observations. Recomputed each fixpoint iteration so
  // newly-narrowed func.arrayElemSchema/.arrayElemValType results propagate
  // from `const rows = initRows()` observations. Two-pass fixpoint: first
  // pass learns from literals + module vars; second pass forwards through
  // chained helpers (f → addXY → {getX, getY}).
  const buildCallerElems = (sliceKey) => {
    const m = new Map()
    m.set(null, new Map())
    for (const func of ctx.func.list) {
      if (!func.body || func.raw) continue
      m.set(func, analyzeBody(func.body)[sliceKey])
    }
    return m
  }
  let callerArrElemsCtx = buildCallerElems('arrElemSchemas')
  const rebuildArrElems = () => { callerArrElemsCtx = buildCallerElems('arrElemSchemas') }
  let callerArrElemValsCtx = buildCallerElems('arrElemValTypes')
  const rebuildArrElemVals = () => { callerArrElemValsCtx = buildCallerElems('arrElemValTypes') }
  const runFixpoint = () => {
    for (let s = 0; s < callSites.length; s++) {
      const { callee, argList, callerFunc } = callSites[s]
      const func = ctx.func.map.get(callee)
      if (!func || func.exported || valueUsed.has(callee)) continue
      const ctxEntry = callerCtx.get(callerFunc)
      if (!ctxEntry) continue
      const { callerLocals, callerValTypes } = ctxEntry
      const callerSchemas = callerParamFactMap(paramReps, callerFunc, 'schemaId')
      const restIdx = func.rest ? func.sig.params.length - 1 : -1
      for (let k = 0; k < func.sig.params.length; k++) {
        const r = ensureParamRep(paramReps, callee, k)
        if (k < argList.length) {
          if (r.val !== null) mergeParamFact(r, 'val', inferArgType(argList[k], callerValTypes))
          // Wasm-type lattice: exprType always returns 'i32'|'f64' — no null sentinel.
          if (r.wasm !== null) {
            const wt = exprType(argList[k], callerLocals)
            if (r.wasm === undefined) r.wasm = wt
            else if (r.wasm !== wt) r.wasm = null
          }
          if (r.schemaId !== null) mergeParamFact(r, 'schemaId', inferArgSchema(argList[k], callerSchemas))
          // intConst lattice: bare-integer literal at every site → param has fixed value.
          // Skip rest position — argList[restIdx] is just the first packed arg, not the
          // whole array. Drop intConst for the rest param so it's never substituted.
          if (k === restIdx) r.intConst = null
          else if (r.intConst !== null) {
            // Literal forms after prepare: bare number, `[null, n]` (literal wrap),
            // or `['u-', n]` (negative literal). A bare string referencing a known
            // module-scope `const NAME = <int-literal>` resolves through ctx.scope.constInts.
            // Anything else → no-consensus.
            const a = argList[k]
            let raw = null
            if (typeof a === 'number') raw = a
            else if (Array.isArray(a) && a[0] == null && typeof a[1] === 'number') raw = a[1]
            else if (Array.isArray(a) && a[0] === 'u-' && typeof a[1] === 'number') raw = -a[1]
            else if (typeof a === 'string' && ctx.scope.constInts?.has(a)) raw = ctx.scope.constInts.get(a)
            const v = (raw != null && Number.isInteger(raw) && raw >= -2147483648 && raw <= 2147483647) ? raw : null
            mergeParamFact(r, 'intConst', v)
          }
        } else {
          // Missing arg — call pads with nullExpr (f64). Prevents narrowing.
          r.val = null; r.wasm = null; r.schemaId = null; r.intConst = null
        }
      }
    }
  }
  // Generic arr-elem fixpoint: same shape for arrayElemSchema (schema-id),
  // arrayElemValType (VAL.*), and typedCtor. `field` selects which fact;
  // `inferFn` and `elemsCtxMap` provide per-callee inference.
  const runArrElemFixpoint = (field, inferFn, elemsCtxMap) => {
    for (let s = 0; s < callSites.length; s++) {
      const { callee, argList, callerFunc } = callSites[s]
      const func = ctx.func.map.get(callee)
      if (!func || func.exported || valueUsed.has(callee)) continue
      if (!callerCtx.get(callerFunc)) continue
      const callerParams = callerParamFactMap(paramReps, callerFunc, field)
      const callerElems = elemsCtxMap.get(callerFunc)
      for (let k = 0; k < func.sig.params.length; k++) {
        const r = ensureParamRep(paramReps, callee, k)
        if (k >= argList.length) { r[field] = null; continue }
        if (r[field] === null) continue
        mergeParamFact(r, field, inferFn(argList[k], callerElems, callerParams))
      }
    }
  }
  const runArrFixpoint = () => runArrElemFixpoint('arrayElemSchema', inferArgArrElemSchema, callerArrElemsCtx)
  const runArrValTypeFixpoint = () => runArrElemFixpoint('arrayElemValType', inferArgArrElemValType, callerArrElemValsCtx)
  runFixpoint()
  runFixpoint()

  // Apply i32 specialization: for non-value-used funcs with consistent i32 call
  // sites and no defaults/rest at that position, narrow sig.params[k].type.
  // Exports too — boundary wrapper handles the f64→i32 truncation at the JS edge.
  for (const func of ctx.func.list) {
    if (func.raw || valueUsed.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, r] of reps) {
      if (r.wasm !== 'i32' || k === restIdx) continue
      const pname = func.sig.params[k].name
      if (func.defaults?.[pname] != null) continue  // defaults need nullish-sentinel f64
      func.sig.params[k].type = 'i32'
    }
  }

  // intConst validation: a param marked with a unanimous integer literal at every call
  // site is only safe to substitute if the body never reassigns it. Clear intConst on any
  // param whose name appears on the LHS of an assignment / `++` / `--`. Skip exported
  // (callable from JS with arbitrary value), value-used (closure callees), raw, defaulted,
  // and rest params — same exclusions as the wasm-narrowing pass above.
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
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, r] of reps) {
      if (!PTR_ABI_KINDS.has(r.val)) continue
      if (k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue  // already narrowed by numeric pass
      if (func.defaults?.[p.name] != null) continue
      p.type = 'i32'
      p.ptrKind = r.val
    }
  }

  // E: Result-type monomorphization — narrow sig.results[0] to 'i32' when body only
  // produces i32 values. Fixpoint: a call to another narrowed func now contributes i32;
  // iterate until stable so chains of i32-only helpers all narrow together.
  // Safety: skip exported (JS boundary preserves number semantics), value-used (closure
  // trampolines assume f64 result), raw WAT, multi-value. `undefined` return = skip.
  // exprType already consults ctx.func.map for narrowed user-function results
  // (analyze.js exprType `()` branch), plus the Math.imul/Math.clz32/charCodeAt
  // stdlib subset and primitive-op rules. Earlier we had a local shim here that
  // shadowed exprType's stdlib rules with `return 'f64'` for any non-user call;
  // unifying through exprType lets a single rule (math.imul → i32) flow through
  // to mix-style helpers (`(h, x) => Math.imul(h ^ (x|0), C)`) and unblocks the
  // E-phase result narrowing on every call site that consumes them.
  const exprTypeWithCalls = exprType
  // Body-driven: safe for exports — the result type is determined by what the body
  // computes, not by what JS callers might pass. JS-visible f64 ABI is restored at
  // the boundary via a synthesized wrapper (see synthesizeBoundaryWrappers below).
  // Shared pool for E (numeric), E2 (valType) and E3 (ptr) narrowing — same predicate.
  const narrowableFuncs = ctx.func.list.filter(f =>
    !f.raw && !valueUsed.has(f.name) && f.sig.results.length === 1
  )
  let changed = true
  while (changed) {
    changed = false
    for (const func of narrowableFuncs) {
      if (func.sig.results[0] === 'i32') continue
      const body = func.body
      // Bare `return;` produces undef (f64) — narrowing to i32 would lose that.
      if (isBlockBody(body) && hasBareReturn(body)) continue
      const exprs = returnExprs(body)
      if (!exprs.length) continue
      // Skip narrowing when any return-tail is `>>>` (unsigned uint32). Narrowing to i32
      // loses the unsigned interpretation: the wrapper rebox via `f64.convert_i32_s` would
      // sign-flip values with bit 31 set, breaking the canonical `(x >>> 0)` uint32 idiom.
      // A future pass could track sig.unsignedResult and emit `f64.convert_i32_u` instead.
      if (exprs.some(e => Array.isArray(e) && e[0] === '>>>')) continue
      const savedCurrent = ctx.func.current
      ctx.func.current = func.sig
      const locals = isBlockBody(body) ? analyzeLocals(body) : new Map()
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
  // Body-driven valResult inference: same safety analysis as numeric narrowing
  // above — exports OK because boundary wrapper restores f64 ABI for JS callers.
  changed = true
  while (changed) {
    changed = false
    for (const func of narrowableFuncs) {
      if (func.valResult) continue
      const body = func.body
      const isBlock = isBlockBody(body)
      if (isBlock && hasBareReturn(body)) continue
      const exprs = returnExprs(body)
      if (!exprs.length) continue
      const localValTypes = isBlock ? analyzeBody(body).valTypes : new Map()
      // Params of this function contribute no known VAL type yet (paramReps may help later).
      const vt0 = valTypeOfWithCalls(exprs[0], localValTypes)
      if (!vt0) continue
      const allSame = exprs.every(e => valTypeOfWithCalls(e, localValTypes) === vt0)
      if (allSame) { func.valResult = vt0; changed = true }
    }
  }

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
  for (const func of ctx.func.list) {
    if (func.body && !func.raw) invalidateValTypesCache(func.body)
  }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const entry = callerCtx.get(func)
    if (entry) entry.callerValTypes = analyzeBody(func.body).valTypes
  }
  // Re-observe schema slot val-types now that E2 has set `valResult` on user
  // funcs. First pass runs in collectProgramFacts before valResult is known, so
  // a slot like `cs` in `{ ..., cs }` (where `cs = checksum(out)`) gets observed
  // as null. observeSlot's first-wins-then-clash rule lets a later precise
  // observation upgrade `undefined` → NUMBER without poisoning earlier
  // monomorphic observations.
  observeProgramSlots(ast)
  rebuildArrElems()
  rebuildArrElemVals()
  // Clear sticky-null on val/schemaId — first 2 passes ran with valResult unset, so
  // call args resolving via `f.valResult` returned null and got stuck. Re-running
  // with refreshed callerValTypes lets these flow.
  clearStickyNull(paramReps, 'val')
  clearStickyNull(paramReps, 'schemaId')
  runFixpoint()
  // Now that .val is refreshed, dedicated arr-elem-schema fixpoint.
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
  //     schema (literal `{a,b,c}`, schemaId-bound param, module-bound var, or call to
  //     another OBJECT-narrowed func). Caller picks aux up via callIR.ptrAux → readVar →
  //     repByLocal.schemaId, restoring property-slot dispatch through the call boundary.
  // Safety: ARRAY forwards on realloc (no narrowing). STRING dual-encoded SSO/heap.
  // CLOSURE/TYPED also carry meaningful aux — TYPED narrowing is a follow-up. Body must
  // be a guaranteed-return form — fallthrough fallback i32.const 0 would be a valid
  // offset 0 of the narrowed kind, not undefined.
  const PTR_RESULT_KINDS_NOAUX = new Set([VAL.SET, VAL.MAP, VAL.BUFFER])
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
    for (const func of narrowableFuncs) {
      if (!func.valResult) continue
      if (func.sig.results[0] !== 'f64') continue
      const isBlock = isBlockBody(func.body)
      if (isBlock && !alwaysReturns(func.body)) continue
      if (PTR_RESULT_KINDS_NOAUX.has(func.valResult)) {
        func.sig.results = ['i32']
        func.sig.ptrKind = func.valResult
        narrowChanged = true
        continue
      }
      const exprs = returnExprs(func.body)
      if (!exprs.length) continue
      if (func.valResult === VAL.OBJECT) {
        const paramSchemasMap = callerParamFactMap(paramReps, func, 'schemaId')
        const sid0 = schemaIdOfReturn(exprs[0], paramSchemasMap)
        if (sid0 == null) continue
        if (!exprs.every(e => schemaIdOfReturn(e, paramSchemasMap) === sid0)) continue
        func.sig.results = ['i32']
        func.sig.ptrKind = VAL.OBJECT
        func.sig.ptrAux = sid0
        narrowChanged = true
      } else if (func.valResult === VAL.TYPED) {
        const localMap = isBlock ? localElemAuxMap(func.body) : null
        const aux0 = typedAuxOfReturn(exprs[0], localMap)
        if (aux0 == null) continue
        if (!exprs.every(e => typedAuxOfReturn(e, localMap) === aux0)) continue
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
  // (Helpers `inferArgTypedCtor`/`ctorFromElemAux` live in analyze.js so the
  //  bimorphic-typed specialization pass below can reuse them.)
  // Per-caller typed-elem map, recomputed now that E3 has tagged helper sigs.
  // Cache invalidation: analyzeBody.typedElems reads `ctx.func.map.get(...).sig.ptrKind`
  // for `let x = mkInput(...)` decls; entries cached during the initial walk
  // (before E3 ran) are stale (mkInput's ptrKind was unset then).
  for (const func of ctx.func.list) {
    if (func.body && !func.raw) invalidateValTypesCache(func.body)
  }
  const callerTypedCtx = new Map()
  callerTypedCtx.set(null, ctx.scope.globalTypedElem || new Map())
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    callerTypedCtx.set(func, analyzeBody(func.body).typedElems)
  }
  // Two-pass fixpoint: lets a caller's params, once typed, propagate further to
  // its own callees (e.g. if `outer(buf)` calls `inner(buf)` and we learn `buf`
  // for outer, the second pass picks it up for inner). Reuses runArrElemFixpoint
  // (same shape — field/inferFn/elemsCtxMap parameterization).
  const runTypedFixpoint = () => runArrElemFixpoint('typedCtor', inferArgTypedCtor, callerTypedCtx)
  runTypedFixpoint()
  runTypedFixpoint()

  // G: TYPED pointer-ABI narrowing — once .typedCtor agrees on a single
  // ctor across all call sites, narrow the param from NaN-boxed f64 to raw
  // i32 offset (with ptrAux carrying the elem-type bits). Eliminates the
  // per-read `i32.wrap_i64 (i64.reinterpret_f64 (local.get $arr))` unbox dance
  // that today dominates hot loops dominated by typed-array indexing.
  // Call sites coerce via emitArgForParam → ptrOffsetIR(arg, VAL.TYPED).
  // Safety: same exclusions as the OBJECT/SET/MAP/BUFFER narrowing above —
  // exported, value-used, raw, defaults, rest position.
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

  // H: Post-F/G re-fixpoint — propagates VAL kinds through bimorphic call sites
  // where ptrKind narrowed but ptrAux disagreed (e.g. `sum(f64arr)` and `sum(i32arr)`
  // → both VAL.TYPED, different ctors). Without this, callerValTypes carries no entry
  // for caller's params, so inferArgType returns null and paramReps[callee][k].val is
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
  clearStickyNull(paramReps, 'val')
  runFixpoint()

  // I: Post-E re-narrow of numeric (i32) params. The first numeric narrowing pass
  // ran before E narrowed any result types, so callerLocals saw `let h = mix(...)`
  // as f64 (mix's result was f64 then). After E narrowed mix's result to i32,
  // exprType (which now consults func.sig.results for user calls) sees `h` as i32.
  // Refresh callerLocals + clear sticky-null wasm + re-run fixpoint + re-apply
  // numeric narrowing to propagate i32 through chains of i32-only helpers
  // (callback bench: mix is FNV — params and result all i32-shaped, but inferred
  // only after E phase narrowed mix's result).
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    invalidateLocalsCache(func.body)
    const fresh = analyzeLocals(func.body)
    for (const p of func.sig.params) if (!fresh.has(p.name)) fresh.set(p.name, p.type)
    callerCtx.get(func).callerLocals = fresh
  }
  // Reset wasm field unconditionally — first pass populated it from stale callerLocals
  // (where `let h = mix(...)` widened h to f64 because mix's result wasn't narrowed
  // yet). clearStickyNull only resets null; here we need to reset f64-observed too
  // so the refreshed exprType view propagates.
  for (const m of paramReps.values()) for (const r of m.values()) r.wasm = undefined
  runFixpoint()
  for (const func of ctx.func.list) {
    if (func.raw || valueUsed.has(func.name)) continue
    const reps = paramReps.get(func.name)
    if (!reps) continue
    const restIdx = func.rest ? func.sig.params.length - 1 : -1
    for (const [k, r] of reps) {
      if (r.wasm !== 'i32' || k === restIdx) continue
      if (k >= func.sig.params.length) continue
      const p = func.sig.params[k]
      if (p.type === 'i32') continue                  // already narrowed (incl. ptr-ABI)
      if (func.defaults?.[p.name] != null) continue
      // Don't steal typed-array params from specializeBimorphicTyped: F phase parks
      // bimorphic typed params at type='f64' with sticky-null typedCtor (two distinct
      // ctors at call sites). Their callers post-F pass them as i32 (pointer ABI),
      // so r.wasm flips to 'i32' here — but narrowing now breaks the clone path
      // that still needs to mint per-ctor sigs with ptrKind=TYPED, ptrAux=ctor-aux.
      if (r.val === VAL.TYPED) continue
      p.type = 'i32'
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

  // Per-caller typedElem map (literal `new TypedArray(N)` bindings inside body).
  const callerTypedCtx = new Map()
  callerTypedCtx.set(null, ctx.scope.globalTypedElem || new Map())
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    callerTypedCtx.set(func, analyzeBody(func.body).typedElems)
  }
  // Per-caller typed-param map: caller's own params that F/G already narrowed
  // (so transitive `sum(arr)` inside a func that took `arr` from above resolves).
  const callerTypedParamsCtx = new Map()
  for (const func of ctx.func.list) {
    const m = callerParamFactMap(paramReps, func, 'typedCtor') || null
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
      if (reps.get(k)?.typedCtor !== null) continue
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

      // Mirror per-param reps under the clone's name with mono ctors at bimorphic
      // positions. emitFunc's preseed reads typedCtor → seeds typedElem map →
      // `arr[i]` lowers to direct typed load.
      const cloneReps = new Map()
      for (const [k, r] of reps) cloneReps.set(k, { ...r })
      for (let i = 0; i < bimorphic.length; i++) {
        const k = bimorphic[i]
        const r = cloneReps.get(k) || {}
        r.typedCtor = combo[i]
        r.val = VAL.TYPED
        cloneReps.set(k, r)
      }
      paramReps.set(cloneName, cloneReps)

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
 * Phase: refine ctx.types.anyDynKey using post-narrowSignatures type info.
 */
const NON_DYN_VTS = new Set([VAL.TYPED, VAL.ARRAY, VAL.STRING, VAL.BUFFER])
const TYPED_ARRAY_CTOR = /^(Float|Int|Uint|BigInt|BigUint)(8|16|32|64)(Clamped)?Array$/

export function refineDynKeys(programFacts) {
  if (!ctx.types.anyDynKey) return
  const { paramReps, valueUsed } = programFacts
  const isLitStr = idx => Array.isArray(idx) && idx[0] === 'str' && typeof idx[1] === 'string'

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
      if (!isLitStr(idx)) {
        const obj = node[1]
        const vt = typeof obj === 'string' ? typeMap.get(obj) : null
        if (!NON_DYN_VTS.has(vt)) real = true
      }
    } else if (op === 'for-in') real = true
    if (op === '=>') return
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
  if (!real && ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) {
    if (real) break
    visit(topMap, mi)
  }

  if (!real) ctx.types.anyDynKey = false
}
