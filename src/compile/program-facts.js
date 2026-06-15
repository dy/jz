/**
 * Whole-program fact collection — dyn keys, call sites, schema slots.
 * @module program-facts
 */
import { commaList, isFuncRef, isLiteralStr } from '../ast.js'
import { ctx, err } from '../ctx.js'
import { VAL, lookupValType, repOf } from '../reps.js'
import { valTypeOf } from '../kind.js'
import { extractParams, classifyParam } from '../ast.js'
import { staticObjectProps } from '../static.js'
import { intExprChecker } from '../type.js'
import { analyzeBody } from './analyze.js'

// Assignment-shaped ops whose first arg, when a `.`/`?.` member node, is a
// PROPERTY WRITE — feeds `writtenProps` (any prop name ever written through
// ANY receiver, including expression receivers like `m.get(k).n++`).
const PROP_WRITE_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=',
  '&=', '|=', '^=', '<<=', '>>=', '>>>=', '&&=', '||=', '??=', '++', '--'])

export function observeNodeFacts(node, f) {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  if (PROP_WRITE_OPS.has(op) && Array.isArray(args[0]) &&
      (args[0][0] === '.' || args[0][0] === '?.') && typeof args[0][2] === 'string')
    f.writtenProps.add(args[0][2])
  // Computed-key WRITES (`o[k]=v`, `o[k]+=v`, `o[k]++`) are the ONLY operations
  // that add ENUMERABLE keys beyond the static schema — computed reads and dot-adds
  // (`o.b=2`) do not enumerate in jz. Tracked separately from `dynVars` (which also
  // counts reads) so for-in / Object.keys key pooling can trust the static schema
  // for a receiver that is only computed-READ. (`isLiteralStr` excludes literal
  // string keys, which place in fixed schema slots.)
  if (PROP_WRITE_OPS.has(op) && Array.isArray(args[0]) && args[0][0] === '[]') {
    const [, wobj, widx] = args[0]
    if (!isLiteralStr(widx) && typeof wobj === 'string') f.dynWriteVars?.add(wobj)
  }
  if (op === '[]') {
    const [obj, idx] = args
    if (!isLiteralStr(idx)) { f.anyDyn = true; if (typeof obj === 'string') f.dynVars.add(obj) }
  } else if (op === '=' && Array.isArray(args[0]) && args[0][0] === '[]') {
    const [, obj, idx] = args[0]
    if (!isLiteralStr(idx)) { f.anyDyn = true; if (typeof obj === 'string') f.dynVars.add(obj) }
  } else if (op === 'for-in') {
    f.anyDyn = true
    if (typeof args[1] === 'string') f.dynVars.add(args[1])
  } else if (op === '{}') {
    f.hasSchemaLiterals = true
  } else if (op === '=>') {
    let fixedN = 0
    for (const r of extractParams(args[0])) {
      if (classifyParam(r).kind === 'rest') f.hasRest = true
      else fixedN++
    }
    if (fixedN > f.maxDef) f.maxDef = fixedN
  } else if (op === '()') {
    const cargs = commaList(args[1])
    if (cargs.some(x => Array.isArray(x) && x[0] === '...')) f.hasSpread = true
    if (cargs.length > f.maxCall) f.maxCall = cargs.length
  }
}

const _programFactsCache = new WeakMap()
const _moduleInitSlotCache = new WeakMap()
const _bodyIntCertainCache = new WeakMap()
let _programFactsGen = 0

/** Drop all cached program-fact walks (called at compile entry). */
export function resetProgramFactsCache() { _programFactsGen++ }

/** Drop cached walks for specific AST roots (in-place module rewrites). */
export function invalidateProgramFactsCache(...roots) {
  for (const r of roots) {
    if (r == null || typeof r !== 'object') continue
    _programFactsCache.delete(r)
    _moduleInitSlotCache.delete(r)
    _bodyIntCertainCache.delete(r)
  }
}

function emptyWalkFacts() {
  return {
    dynVars: new Set(), dynWriteVars: new Set(), anyDyn: false, hasSchemaLiterals: false,
    maxDef: 0, maxCall: 0, hasRest: false, hasSpread: false,
    propMap: new Map(), valueUsed: new Set(), callSites: [],
    writtenProps: new Set(),
  }
}

function mergeWalkFacts(into, from) {
  if (from.anyDyn) into.anyDyn = true
  for (const v of from.dynVars) into.dynVars.add(v)
  for (const v of from.dynWriteVars) into.dynWriteVars.add(v)
  if (from.hasSchemaLiterals) into.hasSchemaLiterals = true
  if (from.maxDef > into.maxDef) into.maxDef = from.maxDef
  if (from.maxCall > into.maxCall) into.maxCall = from.maxCall
  if (from.hasRest) into.hasRest = true
  if (from.hasSpread) into.hasSpread = true
  for (const p of from.writtenProps) into.writtenProps.add(p)
  for (const [obj, props] of from.propMap) {
    if (!into.propMap.has(obj)) into.propMap.set(obj, new Set())
    for (const p of props) into.propMap.get(obj).add(p)
  }
  for (const v of from.valueUsed) into.valueUsed.add(v)
  into.callSites.push(...from.callSites)
}

/** Walk one AST root and accumulate program facts. Function bodies are WeakMap-cached
 *  so plan-phase rescans skip unchanged bodies after inlining/scalarization passes.
 *  Module AST is never cached — plan may mutate it in place (flattenFuncNamespaces). */
function walkFactsRoot(root, full, callerFunc, doSchema, cache = true) {
  if (cache && full && root != null && typeof root === 'object') {
    const hit = _programFactsCache.get(root)
    if (hit?.gen === _programFactsGen) return hit.facts
  }
  const acc = emptyWalkFacts()
  const walkFacts = (node, fullWalk, inArrow, caller) => {
    if (!Array.isArray(node)) return
    const [op, ...args] = node
    observeNodeFacts(node, acc)
    if (op === 'for-in' && ctx.transform.strict) err(`strict mode: \`for (... in ...)\` is not allowed (dynamic enumeration). Pass { strict: false } to enable.`)
    if (op === '{}' && doSchema) {
      const parsed = staticObjectProps(args)
      if (parsed) ctx.schema.register(parsed.names)
    }
    if (op === '=>') {
      for (const a of args) walkFacts(a, fullWalk, true, caller)
      return
    }
    if (fullWalk) {
      if (doSchema && op === '=' && Array.isArray(args[0]) && args[0][0] === '.') {
        const [, obj, prop] = args[0]
        // `.length =` is the structural resize op (emit-assign handles ARRAY/
        // TYPED/unknown receivers) — NOT a schema property. Recording it here
        // auto-boxed the binding (['__inner__','length']): reads then deref'd
        // the box while the resize path persisted the raw array ptr into the
        // global — a read/write protocol split that corrupted cross-module
        // arrays (importer `arr.length = 0` between owner pushes). Only a
        // PROVEN object/hash receiver keeps `length` as a real property.
        const lenVt = prop === 'length' ? ctx.scope.globalValTypes?.get(obj) : null
        const lengthIsResize = prop === 'length' && lenVt !== VAL.OBJECT && lenVt !== VAL.HASH
        if (!lengthIsResize && typeof obj === 'string' && (ctx.scope.globals.has(obj) || ctx.func.names.has(obj))) {
          if (!acc.propMap.has(obj)) acc.propMap.set(obj, new Set())
          acc.propMap.get(obj).add(prop)
        }
      }
      if (op === '()' && isFuncRef(args[0], ctx.func.names)) {
        // Record the call site even inside an arrow body. The param-inference
        // lattice (narrow.js) must see EVERY arg a callee receives — including
        // calls made from a closure (`mfb(() => ci(2))`) — or it over-specializes:
        // seeing only the direct `ci(0)` site, intConst folds the param to 0 and
        // the closure's `ci(2)` silently loses its argument. Args evaluated in the
        // arrow's scope that the enclosing caller can't type infer as untyped →
        // poison → conservative (no specialization), which is sound.
        {
          const a = args[1]
          const argList = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
          acc.callSites.push({ callee: args[0], argList, callerFunc: caller, node })
        }
        for (let i = 1; i < args.length; i++) {
          const a = args[i]
          if (isFuncRef(a, ctx.func.names)) acc.valueUsed.add(a)
          else walkFacts(a, true, inArrow, caller)
        }
        return
      }
      if ((op === '.' || op === '?.') && isFuncRef(args[0], ctx.func.names)) return
      if (op === 'let' || op === 'const') {
        for (const decl of args) {
          if (Array.isArray(decl) && decl[0] === '=' && decl.length >= 3) {
            const name = decl[1]
            if (typeof name === 'string' && ctx.func.names.has(name)) {
              const isFuncLit = Array.isArray(decl[2]) && decl[2][0] === '=>'
              if (isFuncLit || caller?.name !== name) acc.valueUsed.add(name)
            }
            walkFacts(decl[2], true, inArrow, caller)
          } else walkFacts(decl, true, inArrow, caller)
        }
        return
      }
      if (op === '=' && args.length >= 2) {
        // RHS may be a bare function reference (`store[0] = pick3`) — record it as a
        // value use so resolveClosureWidth sizes the closure ABI to its arity. Matches
        // the func-ref handling in the call/let/general cases below.
        if (isFuncRef(args[1], ctx.func.names)) acc.valueUsed.add(args[1])
        else walkFacts(args[1], true, inArrow, caller)
        return
      }
      for (const a of args) {
        if (isFuncRef(a, ctx.func.names)) acc.valueUsed.add(a)
        else walkFacts(a, true, inArrow, caller)
      }
    } else {
      for (const a of args) walkFacts(a, false, inArrow, caller)
    }
  }
  walkFacts(root, full, false, callerFunc)
  if (cache && full && root != null && typeof root === 'object')
    _programFactsCache.set(root, { gen: _programFactsGen, facts: acc })
  return acc
}

export function collectProgramFacts(ast) {
  const paramReps = new Map()
  const doSchema = ast && ctx.schema.register
  const doArity = !!ctx.closure.make
  const f = emptyWalkFacts()
  mergeWalkFacts(f, walkFactsRoot(ast, true, null, doSchema, false))
  for (const func of ctx.func.list) {
    if (func.body && !func.raw) mergeWalkFacts(f, walkFactsRoot(func.body, true, func, doSchema, true))
  }
  const { propMap, valueUsed, callSites } = f
  const initFacts = ctx.module.initFacts
  if (initFacts) {
    if (initFacts.anyDyn) {
      f.anyDyn = true
      for (const v of initFacts.dynVars) f.dynVars.add(v)
    }
    if (initFacts.writtenProps) for (const p of initFacts.writtenProps) f.writtenProps.add(p)
    if (doArity) {
      if (initFacts.maxDef > f.maxDef) f.maxDef = initFacts.maxDef
      if (initFacts.maxCall > f.maxCall) f.maxCall = initFacts.maxCall
      if (initFacts.hasRest) f.hasRest = true
      if (initFacts.hasSpread) f.hasSpread = true
    }
    if (doSchema && initFacts.hasSchemaLiterals) f.hasSchemaLiterals = true
  }

  // Slot-type observation pass: walk every `{}` literal with the right scope's
  // valTypes installed as `ctx.func.localValTypesOverlay` so shorthand `{x}`
  // (expanded by prepare to `[':', x, x]`) and chained typed-array reads resolve
  // through valTypeOf → lookupValType. Skips into closures — they're observed via
  // their own func.list entry. The overlay is the per-function analyzeBody.valTypes
  // map (already populated with the same overlay-aware walk).
  if (doSchema && f.hasSchemaLiterals) {
    observeProgramSlots(ast)
    // Per-slot intCertain mirror of the per-binding lattice. Runs after slot
    // type observation (which it does not depend on) — same trigger gate so
    // programs without schema literals skip both. Re-runnable: subsequent
    // collectProgramFacts invocations (E2 phase) overwrite the same map; the
    // analysis is monotone-down so re-running can only widen poisoning, never
    // un-poison — safe.
    analyzeSchemaSlotIntCertain(ast)
  }

  // Emit-time consumers (the static object-literal fast path) read this off
  // ctx — a mutated prop name anywhere disqualifies sharing a static instance.
  ctx.module.writtenProps = f.writtenProps
  return {
    dynVars: f.dynVars, dynWriteVars: f.dynWriteVars, anyDyn: f.anyDyn, propMap, valueUsed, callSites,
    maxDef: f.maxDef, maxCall: f.maxCall, hasRest: f.hasRest, hasSpread: f.hasSpread,
    paramReps, hasSchemaLiterals: f.hasSchemaLiterals, writtenProps: f.writtenProps,
  }
}

/** Re-collect program facts after a mutating plan pass. Unchanged function bodies
 *  reuse WeakMap-cached walks from the prior collectProgramFacts call. */
export const refreshProgramFacts = (ast, _prev) => collectProgramFacts(ast)

/** Walk `ast` + every user function body + module inits, observing slot types
 *  on each `{}` literal. Per-function bodies have their analyzeBody.valTypes
 *  installed as overlay so shorthand `{x}` resolves through local consts.
 *
 *  Re-runnable: compile.js calls this once during collectProgramFacts (before
 *  E2 valResult inference), then again after E2 — on the second pass, valTypeOf
 *  on user-function calls resolves via `f.valResult`, lifting slots whose value
 *  is `const x = userFn(...)` from `undefined` to `NUMBER`/etc.
 *  observeSlot's first-wins-then-clash rule means later precise observations
 *  upgrade undefined slots without re-poisoning already-monomorphic ones. */
export function observeProgramSlots(ast) {
  if (!ctx.schema?.register) return
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
  const visit = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === '{}') {
      const parsed = staticObjectProps(node.slice(1))
      if (parsed) {
        const sid = ctx.schema.register(parsed.names)
        for (let i = 0; i < parsed.values.length; i++) {
          observeSlot(sid, i, valTypeOf(parsed.values[i]))
        }
      }
    }
    for (let i = 1; i < node.length; i++) visit(node[i])
  }
  const prevOverlay = ctx.func.localValTypesOverlay
  if (ast) { ctx.func.localValTypesOverlay = null; visit(ast) }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    ctx.func.localValTypesOverlay = analyzeBody(func.body).valTypes
    visit(func.body)
  }
  if (ctx.module.initFacts?.hasSchemaLiterals && ctx.module.moduleInits) {
    ctx.func.localValTypesOverlay = null
    for (const mi of ctx.module.moduleInits) {
      const hit = _moduleInitSlotCache.get(mi)
      if (hit?.gen === _programFactsGen) {
        for (const [sid, idx, vt] of hit.obs) observeSlot(sid, idx, vt)
        continue
      }
      const obs = []
      const record = (sid, idx, vt) => { if (vt) obs.push([sid, idx, vt]); observeSlot(sid, idx, vt) }
      const visitInit = (node) => {
        if (!Array.isArray(node)) return
        const op = node[0]
        if (op === '=>') return
        if (op === '{}') {
          const parsed = staticObjectProps(node.slice(1))
          if (parsed) {
            const sid = ctx.schema.register(parsed.names)
            for (let i = 0; i < parsed.values.length; i++) record(sid, i, valTypeOf(parsed.values[i]))
          }
        }
        for (let i = 1; i < node.length; i++) visitInit(node[i])
      }
      visitInit(mi)
      if (mi != null && typeof mi === 'object') _moduleInitSlotCache.set(mi, { gen: _programFactsGen, obs })
    }
  }
  ctx.func.localValTypesOverlay = prevOverlay
}

/** Whole-program slot intCertain observation.
 *
 *  A schema slot `(sid, idx)` is `intCertain` iff every write to it across the
 *  program is integer-shaped (literal int, bitwise op, intCertain local read,
 *  …). Mirrors `analyzeIntCertain`'s `isIntExpr` rules but works at module
 *  scope: each body gets a local `intCertain` fixpoint over its own bindings,
 *  then schema writes within that body are reduced against the fixpoint.
 *
 *  Global poison semantics: any non-int write to a slot — in any body —
 *  permanently flips it false. Slots never observed stay `undefined`.
 *
 *  Cross-function flow (slot written from a call's return value) is **not**
 *  tracked — those writes count as non-int and poison the slot. Conservative:
 *  produces only false negatives, never false positives. */
export function analyzeSchemaSlotIntCertain(ast) {
  if (!ctx.schema?.register) return
  const slotIntCertain = ctx.schema.slotIntCertain
  const poisonSlot = (sid, idx) => {
    let arr = slotIntCertain.get(sid)
    if (!arr) { arr = []; slotIntCertain.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    arr[idx] = false
  }
  const observeSlot = (sid, idx, isInt) => {
    let arr = slotIntCertain.get(sid)
    if (!arr) { arr = []; slotIntCertain.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    if (arr[idx] === false) return
    if (!isInt) { arr[idx] = false; return }
    if (arr[idx] === undefined) arr[idx] = true
  }

  const bodyIntCertainOf = (body) => {
    if (body != null && typeof body === 'object') {
      const hit = _bodyIntCertainCache.get(body)
      if (hit?.gen === _programFactsGen) return hit.isInt
    }
    const isInt = intExprChecker(body)
    if (body != null && typeof body === 'object')
      _bodyIntCertainCache.set(body, { gen: _programFactsGen, isInt })
    return isInt
  }

  // Body walker: for each `{}` literal observe per-slot intCertain; for each
  // `obj.prop = expr` write, poison-or-confirm the slot resolved via the
  // schema attached to `obj` (ValueRep `schemaId` or `ctx.schema.vars`).
  const visit = (node, isInt) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === '{}') {
      const parsed = staticObjectProps(node.slice(1))
      if (parsed) {
        const sid = ctx.schema.register(parsed.names)
        for (let i = 0; i < parsed.values.length; i++) observeSlot(sid, i, isInt(parsed.values[i]))
      }
    } else if (op === '=' && Array.isArray(node[1]) && node[1][0] === '.') {
      const [, obj, prop] = node[1]
      if (typeof obj === 'string') {
        // Same precise-path resolution as ctx.schema.slotVT — no structural
        // fallback (slot index could differ across schemas with the same prop).
        // Poisoned names carry no schema (shape-disagreeing assignments).
        const sid = ctx.schema.poisoned?.has(obj) ? undefined
          : repOf(obj)?.schemaId ?? ctx.schema.vars.get(obj)
        if (sid != null) {
          const idx = ctx.schema.list[sid]?.indexOf(prop)
          if (idx >= 0) observeSlot(sid, idx, isInt(node[2]))
          else if (idx < 0) {/* off-schema write — irrelevant to existing slots */}
        }
      }
    }
    for (let i = 1; i < node.length; i++) visit(node[i], isInt)
  }

  if (ast) visit(ast, bodyIntCertainOf(ast))
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    visit(func.body, bodyIntCertainOf(func.body))
  }
  if (ctx.module.initFacts?.hasSchemaLiterals && ctx.module.moduleInits) {
    for (const mi of ctx.module.moduleInits) visit(mi, bodyIntCertainOf(mi))
  }
}

