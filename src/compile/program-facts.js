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
import { intLevelChecker, typedElemCtor } from '../type.js'
import { ctorFromElemAux } from '../../layout.js'
import { analyzeBody } from './analyze.js'
import { safeReads } from './analyze-scans.js'

// Assignment-shaped ops whose first arg, when a `.`/`?.` member node, is a
// PROPERTY WRITE — feeds `writtenProps` (any prop name ever written through
// ANY receiver, including expression receivers like `m.get(k).n++`).
const PROP_WRITE_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=',
  '&=', '|=', '^=', '<<=', '>>=', '>>>=', '&&=', '||=', '??=', '++', '--'])

// Array methods that can change length or relocate the payload (grow copies to a
// new arena block and forwards the header). sort/reverse/fill/copyWithin mutate
// elements IN PLACE — base and len stay put — so they are deliberately absent.
const ARR_RESIZE_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice'])

// Per-op arg slots where a bare string is a NAME BINDING or receiver — not a value
// read. Everything else marks nameEscapes (see below). `true` = skip all slots.
// Missing a binding-shaped op here only over-marks (a lost fold), never unsound.
const ESCAPE_SKIP = {
  '.': true, '?.': true,          // receiver never escapes via the read itself; slot2 is a prop NAME
  'str': true,                    // payload
  '[]': new Set([0]),             // receiver safe; a bare INDEX name still marks (keys coerce so it's over-marking, but harmless)
  '=>': new Set([0]),             // params are bindings; a bare-name BODY is a returned value → marks
  'let': true, 'const': true, 'var': true,  // decl heads; initializers are '='-nodes pre-registered below
  'import': true, 'export': true, // module wiring: exported arrays are host/importer-reachable — see explicit mark below
}

export function observeNodeFacts(node, f) {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  // ---- const-array stability lattice (module/array.js static base/len fold) ----
  // arrResized: names whose array may change length or relocate — any indexed write
  // (an out-of-range write grows), `.length =`, or a resizing method call.
  // nameEscapes: bare names read in a VALUE position — the reference may alias, so
  // mutations through the alias are invisible to per-name facts. Sound direction:
  // over-marking loses a fold; the SAFE (unmarked) positions are only the receiver
  // slots of '[]'/'.'/'?.' and binding slots.
  if (op === '()' && Array.isArray(args[0]) && (args[0][0] === '.' || args[0][0] === '?.') &&
      typeof args[0][1] === 'string' && ARR_RESIZE_METHODS.has(args[0][2]))
    f.arrResized.add(args[0][1])
  if (op === 'let' || op === 'const' || op === 'var') {
    // Pre-register decl '=' children: their slot-0 is a BINDING, not a reassignment,
    // so the '=' marking below must not flag the declared name as escaped.
    for (const d of args) if (Array.isArray(d) && d[0] === '=') (f._declEq ??= new WeakSet()).add(d)
  }
  if (op === 'export') {
    // An exported binding is reachable by importers and the host — writes through
    // that path are outside this walk, so exported names count as escaped.
    for (const d of args) {
      if (typeof d === 'string') f.nameEscapes.add(d)
      else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') f.nameEscapes.add(d[1])
      else if (Array.isArray(d) && (d[0] === 'let' || d[0] === 'const' || d[0] === 'var'))
        for (const dd of d.slice(1)) { if (Array.isArray(dd) && dd[0] === '=' && typeof dd[1] === 'string') f.nameEscapes.add(dd[1]) }
    }
  }
  {
    const skip = ESCAPE_SKIP[op]
    if (skip !== true && op != null) {
      const declEq = op === '=' && f._declEq?.has(node)
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] !== 'string') continue
        if (skip instanceof Set && skip.has(i)) continue
        if (declEq && i === 0) continue
        f.nameEscapes.add(args[i])
      }
    }
  }
  if (PROP_WRITE_OPS.has(op) && Array.isArray(args[0])) {
    if (args[0][0] === '[]') {
      let root = args[0][1]
      while (Array.isArray(root) && root[0] === '[]') root = root[1]
      if (typeof root === 'string') f.arrResized.add(root)
    } else if ((args[0][0] === '.' || args[0][0] === '?.') && args[0][2] === 'length' && typeof args[0][1] === 'string')
      f.arrResized.add(args[0][1])
  }
  if (PROP_WRITE_OPS.has(op) && Array.isArray(args[0]) &&
      (args[0][0] === '.' || args[0][0] === '?.') && typeof args[0][2] === 'string') {
    f.writtenProps.add(args[0][2])
    // Per-receiver literal-key writes: a key OUTSIDE the receiver's schema lands
    // in the dyn-props sidecar (locals get no propMap/autoBox schema merge), so
    // static enumeration (for-in pool/unroll, Object.keys/values/entries schema
    // fold) must deopt to the runtime merge for such receivers or the added key
    // is invisible. Bare-var receivers only — expression receivers already take
    // the runtime path (aliasing keeps dynWriteVars' per-name precision).
    if (typeof args[0][1] === 'string') {
      let s = f.literalWriteKeys.get(args[0][1])
      if (!s) f.literalWriteKeys.set(args[0][1], s = new Set())
      s.add(args[0][2])
    }
  }
  // Bracket form of the same: `o['zz'] = v` (isLiteralStr keeps it out of
  // dynWriteVars, so it must be recorded here or it's invisible to every gate).
  if (PROP_WRITE_OPS.has(op) && Array.isArray(args[0]) && args[0][0] === '[]' &&
      isLiteralStr(args[0][2]) && typeof args[0][1] === 'string') {
    let s = f.literalWriteKeys.get(args[0][1])
    if (!s) f.literalWriteKeys.set(args[0][1], s = new Set())
    s.add(args[0][2][1])
  }
  // Computed-key WRITES (`o[k]=v`, `o[k]+=v`, `o[k]++`) are the ONLY operations
  // that add ENUMERABLE keys beyond the static schema — computed reads and dot-adds
  // (`o.b=2`) do not enumerate in jz. Tracked separately from `dynVars` (which also
  // counts reads) so for-in / Object.keys key pooling can trust the static schema
  // for a receiver that is only computed-READ. (`isLiteralStr` excludes literal
  // string keys, which place in fixed schema slots.)
  if (PROP_WRITE_OPS.has(op) && Array.isArray(args[0]) && args[0][0] === '[]') {
    const [, wobj, widx] = args[0]
    // Flag the ROOT array var. `o[k]=v` → o; a NESTED write `o[i][j]=v` mutates an
    // element of o, so walk the receiver chain to its root identifier and flag that
    // too — else o's recorded (nested) element types would be wrongly trusted at a
    // later `o[i][j]` read. Strictly more conservative for every dynWriteVars consumer.
    if (!isLiteralStr(widx)) {
      let root = wobj
      while (Array.isArray(root) && root[0] === '[]') root = root[1]
      if (typeof root === 'string') f.dynWriteVars?.add(root)
    }
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

let _programFactsCache = new WeakMap()
let _moduleInitSlotCache = new WeakMap()
let _bodyIntCertainCache = new WeakMap()
let _programFactsGen = 0

/** Drop all cached program-fact walks (called at compile entry).
 *  Natively the gen bump alone is enough (stale entries just go unreachable on a
 *  real GC heap). In the self-host kernel these WeakMaps' own backing storage is
 *  itself an arena allocation that `_clear` rewinds between compiles in a warm-
 *  instance loop — a post-`_clear` alloc can overwrite the WeakMap's internal
 *  bytes, so we also swap in fresh WeakMap instances (cheap: O(1), no traversal). */
export function resetProgramFactsCache() {
  _programFactsGen++
  _programFactsCache = new WeakMap()
  _moduleInitSlotCache = new WeakMap()
  _bodyIntCertainCache = new WeakMap()
}

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
    writtenProps: new Set(), literalWriteKeys: new Map(),
    arrResized: new Set(), nameEscapes: new Set(),
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
  for (const v of from.arrResized) into.arrResized.add(v)
  for (const v of from.nameEscapes) into.nameEscapes.add(v)
  for (const [obj, keys] of from.literalWriteKeys) {
    if (!into.literalWriteKeys.has(obj)) into.literalWriteKeys.set(obj, new Set())
    for (const k of keys) into.literalWriteKeys.get(obj).add(k)
  }
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
            // A bare func-ref RHS (`let c = taylor` — the fn-attached-memo idiom)
            // is a VALUE use: resolveClosureWidth must size the uniform ABI to the
            // referenced function's full arity, or its boundary trampoline forwards
            // $__a{k} slots it never declared. Mirrors the '=' handler below.
            if (isFuncRef(decl[2], ctx.func.names)) acc.valueUsed.add(decl[2])
            else walkFacts(decl[2], true, inArrow, caller)
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
    if (initFacts.arrResized) for (const v of initFacts.arrResized) f.arrResized.add(v)
    if (initFacts.nameEscapes) for (const v of initFacts.nameEscapes) f.nameEscapes.add(v)
    if (initFacts.literalWriteKeys) for (const [obj, keys] of initFacts.literalWriteKeys) {
      if (!f.literalWriteKeys.has(obj)) f.literalWriteKeys.set(obj, new Set())
      for (const k of keys) f.literalWriteKeys.get(obj).add(k)
    }
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
    literalWriteKeys: f.literalWriteKeys,
    arrResized: f.arrResized, nameEscapes: f.nameEscapes,
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
export function observeProgramSlots(ast, opts) {
  if (!ctx.schema?.register) return
  const slotTypes = ctx.schema.slotTypes
  const slotCtors = ctx.schema.slotTypedCtors
  const observeSlot = (sid, idx, vt) => {
    if (!vt) return
    let arr = slotTypes.get(sid)
    if (!arr) { arr = []; slotTypes.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    if (arr[idx] === null) return
    if (arr[idx] === undefined) arr[idx] = vt
    else if (arr[idx] !== vt) arr[idx] = null
  }
  // Hard kind-poison (observeSlot's `!vt` arm is a SKIP, not a poison): a write
  // whose kind can't be independently proven forces the slot polymorphic.
  const poisonSlot = (sid, idx) => {
    let arr = slotTypes.get(sid)
    if (!arr) { arr = []; slotTypes.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    arr[idx] = null
  }
  const poisonCtor = (sid, idx) => {
    let arr = slotCtors.get(sid)
    if (!arr) { arr = []; slotCtors.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    arr[idx] = null
  }
  // Strict write-kind resolver: valTypeOf EXCEPT (a) `.prop` reads answer null —
  // consulting the live slotTypes state mid-census would make observations
  // order-dependent (a source slot poisoned LATER would leave a stale kind
  // standing), and (b) `+`/`+=` never guess — VT['+']'s NUMBER-for-unknowns
  // optimism is fine for expression typing (the emitter still dispatches at
  // runtime) but would durably misclassify a slot a string flows into.
  // Non-plus arithmetic stays trustworthy through plain valTypeOf: ToNumber
  // semantics make `* - / % << >> & | ^` NUMBER whatever the operands.
  const writeVT = (n) => {
    if (Array.isArray(n)) {
      const op = n[0]
      if (op === '.' || op === '?.') return null
      if (op === '+' || op === '+=') {
        const ta = writeVT(n[1]), tb = writeVT(n[2])
        if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
        if (ta == null || tb == null) return null
        if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
        return VAL.NUMBER
      }
      if (op === '?:') { const a = writeVT(n[2]), b = writeVT(n[3]); return a === b ? a : null }
      if (op === '&&' || op === '||' || op === '??') { const a = writeVT(n[1]), b = writeVT(n[2]); return a === b ? a : null }
    }
    return valTypeOf(n)
  }
  // Poison every hazarded slot's kind AND elem-ctor up front (unresolvable
  // receivers, computed-key writes, extern constructors — see
  // collectSlotWriteHazards). Sticky: observeSlot never upgrades null.
  // Kind-safe sids (JSON shaped/const parsers) OBSERVE their sample kinds
  // instead — clash with a same-sid literal still nulls, exactly right; their
  // elem-ctors poison regardless (JSON never carries typed arrays).
  // opts.fresh (plan's post-narrowing refine): REBUILD from scratch — the late
  // hazard recompute resolves receivers the early pass poisoned wholesale
  // (fftplan's `re[j] = tr` on a then-unnarrowed param poisoned the world).
  // Sound to rebuild: every kind consumer left reads at emit, after this.
  if (opts?.fresh) { slotTypes.clear(); slotCtors.clear() }
  const hazards = collectSlotWriteHazards(ast, opts?.fresh ? { paramReps: opts.paramReps } : undefined)
  applySlotWriteHazards(hazards,
    (sid, idx) => { poisonSlot(sid, idx); poisonCtor(sid, idx) },
    { observe: (sid, idx, vt) => { vt ? observeSlot(sid, idx, vt) : poisonSlot(sid, idx); poisonCtor(sid, idx) } })
  // Elem-ctor sibling of observeSlot — same first-wins-then-clash lattice. A
  // slot whose every observed value is one typed-array kind keeps that kind for
  // `plan.tw[i]`-style reads (consumption additionally gates on the prop never
  // being written program-wide — see schema.slotTypedCtorAt).
  const observeCtor = (sid, idx, ctor) => {
    if (!ctor) return
    let arr = slotCtors.get(sid)
    if (!arr) { arr = []; slotCtors.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    if (arr[idx] === null) return
    if (arr[idx] === undefined) arr[idx] = ctor
    else if (arr[idx] !== ctor) arr[idx] = null
  }
  let teOverlay = null
  const ctorOfValue = (expr) => {
    if (typeof expr === 'string')
      return teOverlay?.get(expr) ?? ctx.scope.globalTypedElem?.get(expr) ?? null
    const c = typedElemCtor(expr)
    if (c) return c
    if (Array.isArray(expr) && expr[0] === '()' && typeof expr[1] === 'string') {
      const f = ctx.func.map?.get(expr[1])
      if (f?.sig?.ptrKind === VAL.TYPED && f.sig.ptrAux != null) return ctorFromElemAux(f.sig.ptrAux)
    }
    return null
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
          observeCtor(sid, i, ctorOfValue(parsed.values[i]))
        }
      }
    } else if (PROP_WRITE_OPS.has(op) && Array.isArray(node[1]) &&
        (node[1][0] === '.' || node[1][0] === '?.') && typeof node[1][1] === 'string' && typeof node[1][2] === 'string') {
      // Resolvable `.prop` writes: observe the written kind when it's
      // independently provable (writeVT), hard-poison otherwise — a slot's
      // censused kind must reflect EVERY write, not just literal init values
      // (`o.x = 'oops'` on a NUMBER-observed slot was a live miscompile).
      // Unresolvable receivers are hazard-poisoned; elem-ctor consumers are
      // already fail-closed on writtenProps, so no ctor action here.
      const sid = repOf(node[1][1])?.schemaId ?? ctx.schema.vars.get(node[1][1])
      const idx = sid != null ? (ctx.schema.list[sid]?.indexOf(node[1][2]) ?? -1) : -1
      if (idx >= 0) {
        const vt = writeVT(effectiveWriteValue(op, node[1], node[2]))
        if (vt) observeSlot(sid, idx, vt)
        else poisonSlot(sid, idx)
      }
    }
    for (let i = 1; i < node.length; i++) visit(node[i])
  }
  const prevOverlay = ctx.func.localValTypesOverlay
  if (ast) { ctx.func.localValTypesOverlay = null; teOverlay = null; visit(ast) }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeBody(func.body)
    ctx.func.localValTypesOverlay = facts.valTypes
    teOverlay = facts.typedElems
    visit(func.body)
  }
  teOverlay = null
  if (ctx.module.initFacts?.hasSchemaLiterals && ctx.module.moduleInits) {
    ctx.func.localValTypesOverlay = null
    for (const mi of ctx.module.moduleInits) {
      const hit = _moduleInitSlotCache.get(mi)
      if (hit?.gen === _programFactsGen) {
        for (const [sid, idx, vt, ctor] of hit.obs) { observeSlot(sid, idx, vt); observeCtor(sid, idx, ctor) }
        continue
      }
      const obs = []
      const record = (sid, idx, vt, ctor) => {
        if (vt || ctor) obs.push([sid, idx, vt, ctor])
        observeSlot(sid, idx, vt)
        observeCtor(sid, idx, ctor)
      }
      const visitInit = (node) => {
        if (!Array.isArray(node)) return
        const op = node[0]
        if (op === '=>') return
        if (op === '{}') {
          const parsed = staticObjectProps(node.slice(1))
          if (parsed) {
            const sid = ctx.schema.register(parsed.names)
            for (let i = 0; i < parsed.values.length; i++)
              record(sid, i, valTypeOf(parsed.values[i]), ctorOfValue(parsed.values[i]))
          }
        }
        for (let i = 1; i < node.length; i++) visitInit(node[i])
      }
      teOverlay = null
      visitInit(mi)
      if (mi != null && typeof mi === 'object') _moduleInitSlotCache.set(mi, { gen: _programFactsGen, obs })
    }
  }
  ctx.func.localValTypesOverlay = prevOverlay
}

// ————————————————————————————— slot-write hazards —————————————————————————————
// The slot censuses (slotIntCertain here, slotTypes/slotTypedCtors in
// observeProgramSlots) observe `{}` literals and resolvable `obj.prop =`
// writes — every OTHER way a schema slot's value can change is a HAZARD the
// censuses must poison, or a consumer bakes a stale fact into codegen
// (Math.floor elision on a 1.5, raw arithmetic on a string box — live
// miscompiles, each probed):
//   - `.prop` writes through an UNRESOLVABLE receiver (expression receivers,
//     params no caller agreement pins) → by-prop poison across all schemas.
//   - computed-key writes `o[k] = v` / `delete o[k]` — a resolvable OBJECT
//     receiver poisons its whole sid; HASH/ARRAY/TYPED/MAP/SET/STRING
//     receivers never hit schema slots (dict/element/sidecar homes); an
//     unknown receiver with a provably-NUMERIC key can only hit slots with
//     canonical-integer names; anything else poisons everything.
//   - destructuring assignment into member targets (value shapes unknown).
//   - extern slot writers — the JSON const emitter / shaped parser and
//     spread / Object.assign slot copies (ctx.schema.externSlotSids +
//     Object.assign / spread / JSON.parse discovery here).
// Fail-closed: under-resolution only loses precision, never soundness.
const _numericName = (s) => /^(0|[1-9][0-9]*)$/.test(String(s))

/** Body-local element-alias sids: single-`=` bindings whose init is a whole
 *  element read of an array with a known element schema (local decl facts or a
 *  narrowed param's arrayElemSchema — the latter exists only post-narrowing).
 *  Shared by the late slot-int census and the hazard scan so both resolve
 *  receivers equally (a hazard scan weaker than the census would poison the
 *  very slots the census just proved). */
function collectBodyElemSids(func, paramReps) {
  if (!paramReps || !func?.body || func.raw) return null
  const facts = analyzeBody(func.body)
  const reps = paramReps.get(func.name)
  const paramIdx = new Map((func.sig?.params || []).map((p, k) => [p.name, k]))
  const elemSidOf = (arr) => facts.arrElemSchemas?.get(arr)
    ?? (paramIdx.has(arr) ? reps?.get(paramIdx.get(arr))?.arrayElemSchema : null)
  const sids = new Map(), writes = new Map()
  const scan = (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === '=' && typeof n[1] === 'string') {
      writes.set(n[1], (writes.get(n[1]) || 0) + 1)
      const rhs = n[2]
      if (Array.isArray(rhs) && rhs[0] === '[]' && rhs.length === 3 && typeof rhs[1] === 'string') {
        const sid = elemSidOf(rhs[1])
        if (sid != null) sids.set(n[1], sid)
      }
    }
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  scan(func.body)
  for (const [name, c] of writes) if (c > 1) sids.delete(name)
  return sids.size ? sids : null
}

/** The value a compound assignment / inc-dec effectively stores — synthesized
 *  so census value-analyses (isIntExpr, kind checks) see the real shape:
 *  `o.n++` → `['+', o.n, 1]` (self-referential, resolved by the censuses' own
 *  optimistic fixpoint), `o.f ||= x` → either arm. */
export function effectiveWriteValue(op, lhs, rhs) {
  if (op === '=') return rhs
  if (op === '++' || op === '--') return [op === '++' ? '+' : '-', lhs, [null, 1]]
  if (op === '&&=' || op === '||=' || op === '??=') return ['?:', lhs, lhs, rhs]
  return [op.slice(0, -1), lhs, rhs]
}

const KEYED_EXEMPT_VALS = new Set([VAL.ARRAY, VAL.TYPED, VAL.HASH, VAL.MAP, VAL.SET, VAL.STRING])
let _hazardCache = null

/** Program-wide slot-write hazard scan → `{ all, sids, props, numeric,
 *  kindSafeSids }`, stashed on `ctx.schema.slotWriteHazards` for the census
 *  readers' belt checks. Recomputed per program-facts generation, and again
 *  post-narrowing (plan's refine step, opts.paramReps) — narrowed param reps
 *  resolve receivers the early pass can't (`re[j] = tr` on a TYPED param is an
 *  element write, not a world-poison). `kindSafeSids` maps a sid to its
 *  guarded-constructor slot KINDS (the JSON shaped/const parsers — any runtime
 *  shape divergence falls back to the generic parser's disjoint runtime sids,
 *  so the sample's kinds hold for every object carrying the sid): slotTypes
 *  OBSERVES those kinds, slotIntCertain still poisons (a JSON number is any
 *  double). */
export function collectSlotWriteHazards(ast, opts) {
  const late = !!opts?.paramReps
  if (_hazardCache && _hazardCache.gen === _programFactsGen && _hazardCache.late === late)
    return (ctx.schema.slotWriteHazards = _hazardCache.hz)
  const hz = { all: false, sids: new Set(), props: new Set(), numeric: false, kindSafeSids: new Map() }
  let curSids = null, curParamVts = null
  const sidOf = (obj) => {
    if (typeof obj !== 'string' || ctx.schema.poisoned?.has(obj)) return null
    return curSids?.get(obj) ?? repOf(obj)?.schemaId ?? ctx.schema.vars.get(obj) ?? null
  }
  const kindOf = (obj) => typeof obj === 'string'
    ? (curParamVts?.get(obj) ?? repOf(obj)?.val ?? valTypeOf(obj))
    : valTypeOf(obj)
  const propWrite = (obj, prop) => {
    // Resolvable string receivers are the censuses' own precise territory.
    if (sidOf(obj) == null) hz.props.add(prop)
  }
  const keyedWrite = (obj, key) => {
    if (isLiteralStr(key)) return propWrite(obj, key[1])
    const sid = sidOf(obj)
    if (sid != null) { hz.sids.add(sid); return }
    const vt = kindOf(obj)
    if (vt != null && vt !== VAL.OBJECT && KEYED_EXEMPT_VALS.has(vt)) return
    if (valTypeOf(key) === VAL.NUMBER || (typeof key === 'string' && repOf(key)?.intCertain === true)) hz.numeric = true
    else hz.all = true
  }
  // Member targets buried in a destructuring pattern — written with values the
  // censuses can't see; hazard them like opaque writes.
  const patternTargets = (pat) => {
    if (!Array.isArray(pat)) return
    const op = pat[0]
    if (op === '.' || op === '?.') {
      if (typeof pat[2] === 'string') {
        const sid = sidOf(pat[1])
        if (sid != null) hz.sids.add(sid)
        else hz.props.add(pat[2])
      }
      return
    }
    if (op === '[]') return keyedWrite(pat[1], pat[2])
    for (let i = 1; i < pat.length; i++) patternTargets(pat[i])
  }
  const visit = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (PROP_WRITE_OPS.has(op) && Array.isArray(node[1])) {
      const lhs = node[1]
      if ((lhs[0] === '.' || lhs[0] === '?.') && typeof lhs[2] === 'string') propWrite(lhs[1], lhs[2])
      else if (lhs[0] === '[]') keyedWrite(lhs[1], lhs[2])
      else if (op === '=' && (lhs[0] === '{}' || lhs[0] === '[')) patternTargets(lhs)
    } else if (op === 'delete') {
      // prepare only lets computed-key deletes through (['delete', obj, key]);
      // __dyn_del's schema arm writes UNDEF into a matching slot.
      keyedWrite(node[1], node[2])
    } else if (op === '{}') {
      // Spread literal: the emitter slot-copies source schemas into the merged
      // sid — writes outside the census's view. Resolve the merged name-set the
      // same way (explicit `: names` + spread source schemas); an unresolvable
      // source builds a HASH / __obj_clone result instead (no censused sid).
      // The `{}` emitter's own extern belt covers any resolution divergence.
      const entries = node.length === 2 && Array.isArray(node[1]) && node[1][0] === ','
        ? node[1].slice(1) : node.slice(1)
      if (entries.some(p => Array.isArray(p) && p[0] === '...')) {
        const names = []
        let known = true
        for (const p of entries) {
          if (!Array.isArray(p)) continue
          if (p[0] === '...') {
            const sid = sidOf(p[1])
            const src = sid != null ? ctx.schema.list[sid] : null
            if (src) { for (const n of src) if (!names.includes(n)) names.push(n) }
            else known = false
          } else if (p[0] === ':' && (typeof p[1] === 'string' || typeof p[1] === 'number')) {
            if (!names.includes(String(p[1]))) names.push(String(p[1]))
          }
        }
        if (known && names.length) hz.sids.add(ctx.schema.register(names))
      }
    } else if (op === '()' && node[1] === 'Object.assign') {
      const target = node[2]
      const sid = sidOf(target)
      if (sid != null) hz.sids.add(sid)
      else {
        const vt = kindOf(target)
        if (vt == null || vt === VAL.OBJECT) hz.all = true
      }
    } else if (op === '()' && (node[1] === 'JSON.parse' ||
        (Array.isArray(node[1]) && node[1][0] === '.' && node[1][1] === 'JSON' && node[1][2] === 'parse'))) {
      // Plan-time mirror of the JSON.parse dispatch (module/json.js hook): every
      // key-set the const emitter / shaped parser will register gets its sid
      // KIND-SAFE-marked here with the sample's slot kinds, before any census
      // consumer reads it (a null kind entry poisons that slot's kind too).
      const keysets = ctx.schema.jsonParseKeysets?.(node[2])
      if (keysets) for (const { keys, kinds } of keysets)
        hz.kindSafeSids.set(ctx.schema.register(keys), kinds)
    }
    for (let i = 1; i < node.length; i++) visit(node[i])
  }
  // Per-body valTypes overlays (mirrors observeProgramSlots): receiver/key
  // resolution must see local kinds — `ps[i] = {…}` with ps a local ARRAY and
  // i an int counter is an ELEMENT write, not a slot hazard; without the
  // overlay both fall to unknown and the scan poisons the world.
  const prevOverlay = ctx.func.localValTypesOverlay
  if (ast) { ctx.func.localValTypesOverlay = null; curSids = null; visit(ast) }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    ctx.func.localValTypesOverlay = analyzeBody(func.body).valTypes
    curSids = late ? collectBodyElemSids(func, opts.paramReps) : null
    // Late mode: narrowed param reps type this body's params (the early pass
    // can't — `re[j] = tr` on a TYPED param must classify as an element write).
    if (late) {
      const reps = opts.paramReps.get(func.name)
      curParamVts = reps
        ? new Map((func.sig?.params || []).map((p, k) => [p.name, reps.get(k)?.val]).filter(([, v]) => v != null))
        : null
    }
    visit(func.body)
    curSids = curParamVts = null
  }
  ctx.func.localValTypesOverlay = null
  if (ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) visit(mi)
  ctx.func.localValTypesOverlay = prevOverlay
  _hazardCache = { gen: _programFactsGen, late, hz }
  return (ctx.schema.slotWriteHazards = hz)
}

/** Apply hazards (+ the extern-sid belt set) to a census map: `poison(sid, idx)`
 *  for every hazarded slot. Idempotent; each census calls it at (re)build entry.
 *  `opts.kindSafe` (slotTypes only): kind-safe sids' sample kinds are OBSERVED
 *  via the callback instead of poisoned — `observe(sid, idx, vtOrNull)`; the
 *  int census omits it, so kind-safe sids fully poison there (JSON numbers are
 *  arbitrary doubles). */
export function applySlotWriteHazards(hz, poison, opts) {
  const list = ctx.schema.list || []
  const externs = ctx.schema.externSlotSids
  for (let sid = 0; sid < list.length; sid++) {
    const names = list[sid]
    if (!names) continue
    const kindSafe = opts?.observe ? hz.kindSafeSids?.get(sid) : undefined
    const whole = hz.all || hz.sids.has(sid) || externs?.has(sid) ||
      (hz.kindSafeSids?.has(sid) && kindSafe == null)
    for (let i = 0; i < names.length; i++) {
      if (whole || hz.props.has(String(names[i])) || (hz.numeric && _numericName(names[i]))) { poison(sid, i); continue }
      if (kindSafe) opts.observe(sid, i, kindSafe[i] ?? null)
    }
  }
}

// ————————————————————————— param neverGrown (cross-function) —————————————————————————
// scanNeverGrown proves never-relocation for fresh-literal LOCALS only; a
// read-only array PARAM (the word-frequency kernel's `words`) re-resolves its
// base through `__ptr_offset` on every element read because the param-holding
// function can't see its callers. The cross-function proof: during any
// activation of f, the array a param holds can only relocate if some code
// RUNNING WITHIN that activation grows an array it can reach — so a param is
// never-grown iff (a) the body only ever purely READS it (safeReads: index /
// .length, no aliasing, no passing on), and (b) f's body and every transitive
// callee are ARRAY-GROWTH-FREE: no resize-method call / .length write /
// non-literal-key indexed write on a possibly-ARRAY receiver, and no call
// whose callee we can't resolve (computed callees, closure params, unknown
// methods — any of which could reach user code that grows an alias).
// Name-keyed caller facts (arrResized/nameEscapes) can't express this — the
// builder's `words.push` (its own local) would collide with the kernel's
// read-only param of the same name; the activation-scoped argument doesn't.
// MEMORY-SAFETY CRITICAL (same class as scanNeverGrown): default-deny —
// nested arrows are walked as part of the enclosing body (builtin-invoked
// callbacks run within the activation), unknown callees poison.
const _NG_SAFE_CALLEES = new Set([
  'JSON.parse', 'JSON.stringify', 'String.fromCharCode', 'performance.now',
  'Object.keys', 'Object.values', 'Object.entries', 'Number.isInteger',
  'Number.isFinite', 'Number.isNaN', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
])
// Builtin methods that never RELOCATE their receiver nor call user code
// (beyond function-valued args, which are handled separately): pure reads,
// fresh-allocating transforms, and the in-place non-relocating mutators.
const _NG_SAFE_METHODS = new Set([
  'length', 'charCodeAt', 'charAt', 'codePointAt', 'indexOf', 'lastIndexOf',
  'includes', 'slice', 'substring', 'concat', 'join', 'split', 'toString',
  'toLowerCase', 'toUpperCase', 'trim', 'startsWith', 'endsWith', 'repeat',
  'padStart', 'padEnd', 'get', 'set', 'has', 'add', 'delete', 'keys', 'values',
  'entries', 'sort', 'reverse', 'fill', 'copyWithin', 'subarray', 'at',
  'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'some', 'every',
  'find', 'findIndex', 'flat', 'flatMap', 'now',
])
/** Compute per-function array-growth-freedom (poison fixpoint over the direct
 *  call graph) and stamp `paramReps[f][k].neverGrown` for safe-read params.
 *  Consumed at emit via localReps (module/array.js's raw-base fast path). */
export function analyzeParamNeverGrown(paramReps) {
  if (!ctx.func?.list?.length) return
  const poisoned = new Set(), edges = new Map()
  const prevOverlay = ctx.func.localValTypesOverlay
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeBody(func.body)
    ctx.func.localValTypesOverlay = facts.valTypes
    // Receiver kinds the body facts miss: narrowed param kinds (post-
    // narrowSignatures paramReps) and `{}`-literal decl locals — the
    // dictionary idiom's `const counts = {}` carries no valTypes entry, but
    // ANY object-literal binding is a non-ARRAY receiver.
    const reps = paramReps?.get(func.name)
    const paramIdx = new Map((func.sig?.params || []).map((p, k) => [p.name, k]))
    const objLocals = new Set()
    const collectObjDecls = (n) => {
      if (!Array.isArray(n)) return
      if (n[0] === 'let' || n[0] === 'const' || n[0] === 'var') {
        for (let i = 1; i < n.length; i++) {
          const d = n[i]
          if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
              Array.isArray(d[2]) && d[2][0] === '{}') objLocals.add(d[1])
        }
      }
      for (let i = 1; i < n.length; i++) collectObjDecls(n[i])
    }
    collectObjDecls(func.body)
    const out = new Set()
    let dirty = false
    const kindOf = (x) => typeof x === 'string'
      ? (objLocals.has(x) ? VAL.OBJECT
        : paramIdx.has(x) ? (reps?.get(paramIdx.get(x))?.val ?? null)
        : repOf(x)?.val ?? valTypeOf(x))
      : valTypeOf(x)
    // Only ARRAY receivers relocate on growth; an unknown kind could be one.
    // (OBJECT/HASH keyed writes land in slots / dict tables — arena-bump
    // allocation never moves an existing array.)
    const maybeArray = (x) => { const v = kindOf(x); return v == null || v === VAL.ARRAY }
    const scan = (n) => {
      if (dirty || !Array.isArray(n)) return
      const op = n[0]
      if (op === '()') {
        const c = n[1]
        // function-valued ARGUMENT to any call: a builtin may invoke it with
        // receiver state we can't see; a bare func ref gives no edge to walk.
        // (Arrow LITERAL args are fine — their bodies are scanned right here.)
        const argRoot = n[2]
        const args = Array.isArray(argRoot) && argRoot[0] === ',' ? argRoot.slice(1) : argRoot === undefined ? [] : [argRoot]
        for (const a of args) if (typeof a === 'string' && ctx.func.map?.has(a)) { dirty = true; return }
        if (typeof c === 'string') {
          if (ctx.func.map?.has(c)) out.add(c)
          else if (!(c.startsWith('math.') || c.startsWith('new.') || _NG_SAFE_CALLEES.has(c))) { dirty = true; return }
        } else if (Array.isArray(c) && (c[0] === '.' || c[0] === '?.') && typeof c[2] === 'string') {
          // A method name WRITTEN anywhere program-wide could be a user
          // closure shadowing the builtin (the sidecar method fork) — its
          // body is invisible here, so it poisons like any unknown call.
          if (ctx.types.writtenProps?.has(c[2])) { dirty = true; return }
          if (ARR_RESIZE_METHODS.has(c[2])) {
            if (maybeArray(c[1])) { dirty = true; return }
          } else if (!_NG_SAFE_METHODS.has(c[2])) { dirty = true; return }
        } else { dirty = true; return }   // computed callee — could be any user closure
      } else if (PROP_WRITE_OPS.has(op) && Array.isArray(n[1])) {
        const lhs = n[1]
        if ((lhs[0] === '.' || lhs[0] === '?.') && lhs[2] === 'length') { dirty = true; return }
        if (lhs[0] === '[]' && !isLiteralStr(lhs[2]) && maybeArray(lhs[1])) { dirty = true; return }
      }
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    scan(func.body)
    ctx.func.localValTypesOverlay = null
    if (dirty) poisoned.add(func.name)
    else edges.set(func.name, out)
  }
  ctx.func.localValTypesOverlay = prevOverlay
  // Poison propagation: a caller of a poisoned/unknown callee is poisoned.
  let changed = true
  while (changed) {
    changed = false
    for (const [name, out] of edges) {
      if (poisoned.has(name)) continue
      for (const callee of out)
        if (poisoned.has(callee) || !edges.has(callee)) { poisoned.add(name); changed = true; break }
    }
  }
  for (const func of ctx.func.list) {
    if (!func.body || func.raw || poisoned.has(func.name) || !edges.has(func.name)) continue
    const params = func.sig?.params || []
    for (let k = 0; k < params.length; k++) {
      if (func.rest && k === params.length - 1) continue
      if (!safeReads(func.body, params[k].name)) continue
      let reps = paramReps.get(func.name)
      if (!reps) paramReps.set(func.name, reps = new Map())
      const r = reps.get(k)
      if (r) r.neverGrown = true
      else reps.set(k, { neverGrown: true })
    }
  }
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
 *  Writes the census can't SEE (unresolvable receivers, computed keys, extern
 *  constructors) are poisoned via collectSlotWriteHazards at every (re)build.
 *
 *  Cross-function flow (slot written from a call's return value) is **not**
 *  tracked — those writes count as non-int and poison the slot. Conservative:
 *  produces only false negatives, never false positives. */
/** @param opts.paramReps  LATE-mode (plan's post-narrowSignatures block): re-derive
 *  the census FRESH with BODY-LOCAL receiver resolution — `const p = ps[i]`
 *  binds p's sid from the array's element schema (analyzeBody.arrElemSchemas
 *  for locals, paramReps.arrayElemSchema for params), which only exists after
 *  narrowing. Sound to REBUILD (not merely widen): every census consumer
 *  (toNumF64 / floor elision / intIndexIR) reads at EMIT time, after this. */
export function analyzeSchemaSlotIntCertain(ast, opts) {
  if (!ctx.schema?.register) return
  // Working state is the LEVEL map (0 | 1 integral | 2 strict-int32 — see
  // type.js's lattice); the boolean projections slotIntCertain (≥1) and
  // slotI32Certain (≥2) are published for consumers after the rounds settle.
  const slotIntLevels = ctx.schema.slotIntLevels
  if (opts?.paramReps) slotIntLevels.clear()
  const hazards = collectSlotWriteHazards(ast, opts)
  let flipped = false
  const poisonSlot = (sid, idx) => {
    let arr = slotIntLevels.get(sid)
    if (!arr) { arr = []; slotIntLevels.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    if (arr[idx] !== 0) flipped = true
    arr[idx] = 0
  }
  const observeSlot = (sid, idx, level) => {
    let arr = slotIntLevels.get(sid)
    if (!arr) { arr = []; slotIntLevels.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    const cur = arr[idx]
    if (cur === 0) return
    const next = cur === undefined ? level : Math.min(cur, level)
    if (next !== cur) {
      arr[idx] = next
      // Any drop below the optimistic top contradicts reads already resolved
      // through it this round — re-derive (mirrors the old true→false flip).
      if (next < (cur ?? 2)) flipped = true
    }
  }

  // OPTIMISTIC slot-read resolver — the self-referential immutable-update
  // idiom (`ps[i] = { x: hitX ? p.x : nx, … }`) rebuilds a slot FROM a read
  // of the same slot, so a single pessimistic pass poisons every such field.
  // Greatest fixpoint instead: a censused slot read counts int until some
  // write proves otherwise; each round re-derives every observation and any
  // true→false flip triggers another round (monotone-down, so it terminates
  // in ≤ slots+1 rounds and re-runs can only widen poisoning, never unpoison
  // — the documented re-entrancy contract holds). Same precise-path receiver
  // resolution as the write side; a censused FALSE answers definitively.
  // Receiver → sid. `curSids` is the CURRENT body's local element-alias map
  // (late mode only): `const p = ps[i]` resolves p through ps's element
  // schema. Precise-path rep/vars resolution is the fallback either way.
  let curSids = null
  const sidOfName = (obj) => {
    if (ctx.schema.poisoned?.has(obj)) return undefined
    return curSids?.get(obj) ?? repOf(obj)?.schemaId ?? ctx.schema.vars.get(obj)
  }
  const slotLevelOf = (obj, prop) => {
    const sid = sidOfName(obj)
    if (sid == null) return null
    const idx = ctx.schema.list[sid]?.indexOf(prop)
    if (idx == null || idx < 0) return null
    return slotIntLevels.get(sid)?.[idx] ?? 2   // unobserved = optimistic top
  }

  // LATE mode: body-local element-alias sids (collectBodyElemSids — shared
  // with the hazard scan so receiver resolution stays in lockstep).
  const paramReps = opts?.paramReps
  const bodySidsOf = (func) => collectBodyElemSids(func, paramReps)

  // Round 1 may reuse gen-cached checkers (they close over the LIVE census, so
  // later poisoning flows through); after any flip the LOCAL binding fixpoints
  // baked into those checkers may be stale-optimistic, so rebuild fresh.
  const bodyIntCertainOf = (body, fresh) => {
    if (fresh) return intLevelChecker(body, slotLevelOf)
    if (body != null && typeof body === 'object') {
      const hit = _bodyIntCertainCache.get(body)
      if (hit?.gen === _programFactsGen) return hit.isInt
    }
    const isInt = intLevelChecker(body, slotLevelOf)
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
    } else if (PROP_WRITE_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '.') {
      const [, obj, prop] = node[1]
      if (typeof obj === 'string') {
        // Same precise-path resolution as ctx.schema.slotVT — no structural
        // fallback (slot index could differ across schemas with the same prop).
        // Poisoned names carry no schema (shape-disagreeing assignments).
        // Late mode adds the current body's element-alias sids (sidOfName).
        // Compound assigns / inc-dec observe their EFFECTIVE value (`o.n++` →
        // `o.n + 1` — self-referential, the optimistic fixpoint resolves it).
        const sid = sidOfName(obj)
        if (sid != null) {
          const idx = ctx.schema.list[sid]?.indexOf(prop)
          if (idx >= 0) observeSlot(sid, idx, isInt(effectiveWriteValue(op, node[1], node[2])))
          else if (idx < 0) {/* off-schema write — irrelevant to existing slots */}
        }
        // Unresolvable receivers are hazard-poisoned (collectSlotWriteHazards).
      }
    }
    for (let i = 1; i < node.length; i++) visit(node[i], isInt)
  }

  const sweep = (fresh) => {
    // Hazard poison FIRST: the optimistic slotIntOf resolver must never count a
    // hazarded slot int mid-fixpoint (it would infect other slots' certainty).
    applySlotWriteHazards(hazards, poisonSlot)
    flipped = false
    curSids = null
    if (ast) visit(ast, bodyIntCertainOf(ast, fresh))
    for (const func of ctx.func.list) {
      if (!func.body || func.raw) continue
      curSids = bodySidsOf(func)
      visit(func.body, bodyIntCertainOf(func.body, fresh))
      curSids = null
    }
    if (ctx.module.initFacts?.hasSchemaLiterals && ctx.module.moduleInits) {
      for (const mi of ctx.module.moduleInits) visit(mi, bodyIntCertainOf(mi, fresh))
    }
  }
  sweep(!!paramReps)
  // Any flip invalidates the LOCAL binding fixpoints baked into round-1
  // checkers (both the rounds below and any same-gen cache reuse later), so
  // drop the cache and re-derive until the census is stable.
  let rounds = 0
  while (flipped && ++rounds <= 64) {
    _bodyIntCertainCache = new WeakMap()
    flipped = false
    sweep(true)
  }
  // Cap exhaustion (never expected — each slot descends ≤2 levels): the state
  // may still carry stale optimism, so fail closed for the whole program.
  if (flipped) for (const arr of slotIntLevels.values()) arr.fill(0)
  // Publish the consumer projections: intCertain = integral (≥1) for the
  // ToNumber-skip / floor-elision family, i32Certain = strict (=2) for raw
  // i32 slot loads and i32 local typing.
  const slotIntCertain = ctx.schema.slotIntCertain, slotI32Certain = ctx.schema.slotI32Certain
  slotIntCertain.clear(); slotI32Certain.clear()
  for (const [sid, arr] of slotIntLevels) {
    slotIntCertain.set(sid, arr.map(l => l === undefined ? undefined : l >= 1))
    slotI32Certain.set(sid, arr.map(l => l === 2))
  }
}

