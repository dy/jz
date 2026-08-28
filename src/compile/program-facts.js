/**
 * Whole-program fact collection — dyn keys, call sites, schema slots.
 * @module program-facts
 */
import { commaList, isFuncRef, isLiteralStr, ASSIGN_OPS, MUTATE_OPS } from '../ast.js'
import { ctx, err, getFactStore, DBG_INVARIANTS } from '../ctx.js'
import { VAL, lookupValType, repOf, updateGlobalRep, KIND_UNIVERSE } from '../reps.js'
import { valTypeOf, nullishArm } from '../kind.js'
import { extractParams, classifyParam, PARAM_KIND, collectAllBoundNames } from '../ast.js'
import { staticObjectProps, objLiteralSchemaId } from '../static.js'
import { intLevelChecker } from '../type.js'
import { typedStorageCtorFromContext } from '../typed-context.js'
import { analyzeBody } from './analyze.js'
import { withValueOverlay } from './flow-state.js'
import { safeReads } from './analyze-scans.js'


import { ARR_RESIZE_METHODS, collectBodyElemSids, effectiveWriteValue } from './program-facts/shared.js'
import { invalidateProgramFactsCache, resetProgramFactsCache } from './program-facts/cache.js'
import { applySlotWriteHazards, collectSlotWriteHazards } from './program-facts/slot-write-hazards.js'
import { observeProgramSlots } from './program-facts/slot-kind-census.js'

// MUTATE_OPS (ast.js) is the property-write op set: any write op whose first
// arg is a `.`/`?.` member node feeds `writtenProps` (any prop name ever
// written through ANY receiver, incl. expression receivers like `m.get(k).n++`).


// Per-op arg slots where a bare string is a NAME BINDING or receiver — not a value
// read. Everything else marks nameEscapes (see below). `true` = skip all slots.
// Missing a binding-shaped op here only over-marks (a lost fold), never unsound.
const isObjectLiteral = (node) => Array.isArray(node) && node[0] === '{}'
// Meet over all value definitions: true only while every observed def is a
// direct object literal; one false source is absorbing and can never rebind.
const recordObjectLiteralDef = (facts, name, direct) => {
  if (!facts.objectLiteralDefs) return
  if (!direct || !facts.objectLiteralDefs.has(name)) facts.objectLiteralDefs.set(name, direct)
}

const ESCAPE_SKIP = {
  '.': true, '?.': true,          // receiver never escapes via the read itself; slot2 is a prop NAME
  'str': true,                    // payload
  '[]': new Set([0]),             // receiver safe; a bare INDEX name still marks (keys coerce so it's over-marking, but harmless)
  'in': new Set([1]),             // RHS receiver is queried, not exposed; the key (slot 0) remains a value read
  '=>': new Set([0]),             // params are bindings; a bare-name BODY is a returned value → marks
  'let': true, 'const': true, 'var': true,  // decl heads; initializers are '='-nodes pre-registered below
  'import': true, 'export': true, // module wiring: exported arrays are host/importer-reachable — see explicit mark below
}

export function observeNodeFacts(node, f) {
  if (!Array.isArray(node)) return
  const [op, ...args] = node
  // RepresentationPlan v2 reach bit: folded into this existing universal
  // walk so proving a program BigInt-free costs no second AST traversal.
  // Module-init callers use the same observer, making the fact graph-complete.
  if (op === 'bigint' || op === 'typeof' || (op === '()' && (
      (typeof args[0] === 'string' && (args[0] === 'BigInt' || args[0].startsWith('BigInt.') ||
        args[0].startsWith('new.BigInt64Array') || args[0].startsWith('new.BigUint64Array'))) ||
      (Array.isArray(args[0]) && typeof args[0][2] === 'string' &&
        (args[0][2] === 'getBigInt64' || args[0][2] === 'getBigUint64'))
    ))) f.hasBigint = true
  // ---- const-array stability lattice (module/array.js static base/len fold) ----
  // arrResized: names whose array may change length or relocate — any indexed write
  // (an out-of-range write grows), `.length =`, or a resizing method call.
  // nameEscapes: bare names read in a VALUE position — the reference may alias, so
  // mutations through the alias are invisible to per-name facts. Sound direction:
  // over-marking loses a fold; the SAFE (unmarked) positions are only the receiver
  // slots of '[]'/'.'/'?.', the RHS receiver of `in`, and binding slots.
  if (op === '()' && Array.isArray(args[0]) && (args[0][0] === '.' || args[0][0] === '?.') &&
      typeof args[0][1] === 'string' && ARR_RESIZE_METHODS.has(args[0][2]))
    f.arrResized.add(args[0][1])
  if (op === 'let' || op === 'const' || op === 'var') {
    // Pre-register decl '=' children: their slot-0 is a BINDING, not a reassignment,
    // so the '=' marking below must not flag the declared name as escaped.
    for (const d of args) {
      if (Array.isArray(d) && d[0] === '=') (f._declEq ??= new WeakSet()).add(d)
      else if (typeof d === 'string') recordObjectLiteralDef(f, d, false)
    }
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
  // A schema says which slots a value has, not whether this binding owns a
  // fresh object. Track names whose EVERY value definition is a plain object
  // literal; inferred call/param/container aliases must not use per-name write
  // facts to claim the shared object is closed.
  if (MUTATE_OPS.has(op) && typeof args[0] === 'string')
    recordObjectLiteralDef(f, args[0], op === '=' && isObjectLiteral(args[1]))
  if (MUTATE_OPS.has(op) && Array.isArray(args[0])) {
    if (args[0][0] === '[]') {
      let root = args[0][1]
      while (Array.isArray(root) && root[0] === '[]') root = root[1]
      if (typeof root === 'string') f.arrResized.add(root)
    } else if ((args[0][0] === '.' || args[0][0] === '?.') && args[0][2] === 'length' && typeof args[0][1] === 'string')
      f.arrResized.add(args[0][1])
  }
  if (MUTATE_OPS.has(op) && Array.isArray(args[0]) &&
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
  if (MUTATE_OPS.has(op) && Array.isArray(args[0]) && args[0][0] === '[]' &&
      isLiteralStr(args[0][2]) && typeof args[0][1] === 'string') {
    let s = f.literalWriteKeys.get(args[0][1])
    if (!s) f.literalWriteKeys.set(args[0][1], s = new Set())
    s.add(args[0][2][1])
  }
  // Object.assign may copy runtime-enumerated keys outside a target's static
  // schema. Mark a named target like a computed write so later enumeration
  // uses schema+sidecar rather than a stale static key pool.
  if (op === '()' && args[0] === 'Object.assign') {
    const target = commaList(args[1])[0]
    if (typeof target === 'string') f.dynWriteVars?.add(target)
  }
  // Computed-key WRITES (`o[k]=v`, `o[k]+=v`, `o[k]++`) are the ONLY other operations
  // that add ENUMERABLE keys beyond the static schema — computed reads and dot-adds
  // (`o.b=2`) do not enumerate in jz. Tracked separately from `dynVars` (which also
  // counts reads) so for-in / Object.keys key pooling can trust the static schema
  // for a receiver that is only computed-READ. (`isLiteralStr` excludes literal
  // string keys, which place in fixed schema slots.)
  if (MUTATE_OPS.has(op) && Array.isArray(args[0]) && args[0][0] === '[]') {
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
      if (classifyParam(r)[PARAM_KIND] === 'rest') f.hasRest = true
      else fixedN++
    }
    if (fixedN > f.maxDef) f.maxDef = fixedN
  } else if (op === '()') {
    const cargs = commaList(args[1])
    if (cargs.some(x => Array.isArray(x) && x[0] === '...')) f.hasSpread = true
    if (cargs.length > f.maxCall) f.maxCall = cargs.length
    // Map-value census pre-scan gate (design .work/todo.md §deletion-sweep
    // §1): cheap SYNTACTIC over-approximation — any 2-arg `.set(k,v)` call
    // shape, no VAL.MAP proof (that's the census's own job at OBSERVE time,
    // visit()/visitInit() below) — mirrors hasSchemaLiterals' own `{}`-on-
    // sight trigger just above. Purely a "is it worth entering
    // observeProgramSlots at all" gate for a Map-only program/moduleInit
    // that carries no `{}` literal to trip hasSchemaLiterals on its own.
    if (Array.isArray(args[0]) && args[0][0] === '.' && args[0][2] === 'set' && cargs.length === 2)
      f.hasMapSet = true
  }
}

function emptyWalkFacts() {
  return {
    dynVars: new Set(), dynWriteVars: new Set(), anyDyn: false, hasSchemaLiterals: false,
    hasMapSet: false, hasBigint: false,
    maxDef: 0, maxCall: 0, hasRest: false, hasSpread: false,
    propMap: new Map(), valueUsed: new Set(), callSites: [],
    writtenProps: new Set(), literalWriteKeys: new Map(),
    arrResized: new Set(), nameEscapes: new Set(),
    objectLiteralDefs: new Map(),
  }
}

function mergeWalkFacts(into, from) {
  if (from.anyDyn) into.anyDyn = true
  for (const v of from.dynVars) into.dynVars.add(v)
  for (const v of from.dynWriteVars) into.dynWriteVars.add(v)
  if (from.hasSchemaLiterals) into.hasSchemaLiterals = true
  if (from.hasMapSet) into.hasMapSet = true
  if (from.hasBigint) into.hasBigint = true
  if (from.maxDef > into.maxDef) into.maxDef = from.maxDef
  if (from.maxCall > into.maxCall) into.maxCall = from.maxCall
  if (from.hasRest) into.hasRest = true
  if (from.hasSpread) into.hasSpread = true
  for (const p of from.writtenProps) into.writtenProps.add(p)
  for (const v of from.arrResized) into.arrResized.add(v)
  for (const v of from.nameEscapes) into.nameEscapes.add(v)
  for (const [name, direct] of from.objectLiteralDefs)
    recordObjectLiteralDef(into, name, direct)
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
  const pf = getFactStore().programFacts
  if (cache && full && root != null && typeof root === 'object') {
    const hit = pf.walkCache.get(root)
    if (hit?.gen === pf.gen) return hit.facts
  }
  const acc = emptyWalkFacts()
  // A concise arrow whose whole body is one bare identifier has no enclosing
  // array node for observeNodeFacts to visit. The value is returned, hence the
  // referenced object escapes just like `return name` in a block body.
  if (typeof root === 'string') acc.nameEscapes.add(root)
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
        if (!lengthIsResize && typeof obj === 'string' && (ctx.scope.globals.has(obj) || ctx.funcs.names.has(obj))) {
          if (!acc.propMap.has(obj)) acc.propMap.set(obj, new Set())
          acc.propMap.get(obj).add(prop)
        }
      }
      if (op === '()' && isFuncRef(args[0], ctx.funcs.names)) {
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
          if (isFuncRef(a, ctx.funcs.names)) acc.valueUsed.add(a)
          else walkFacts(a, true, inArrow, caller)
        }
        return
      }
      if ((op === '.' || op === '?.') && isFuncRef(args[0], ctx.funcs.names)) return
      if (op === 'let' || op === 'const') {
        for (const decl of args) {
          if (Array.isArray(decl) && decl[0] === '=' && decl.length >= 3) {
            // nameEscapes: this branch hand-walks the decl's parts (valueUsed +
            // targeted RHS recursion below) instead of recursing into `decl` as
            // a whole node via walkFacts — so `decl` itself never reaches
            // observeNodeFacts's generic per-arg escape-marking loop the way a
            // plain (non-decl) '=' node does (that one IS observeNodeFacts'd
            // directly, since walkFacts calls it unconditionally at entry
            // before any op-specific branch). For a BARE-NAME initializer
            // (`const alias = d`) this silently dropped the RHS name from
            // nameEscapes entirely: decl[2]='d' is a plain string, so the
            // `walkFacts(decl[2], …)` call below returns immediately (the
            // `!Array.isArray(node)` guard) without ever visiting the '='
            // node that would have marked it. Confirmed live: `let alias;
            // alias = d` (non-decl form) marked 'd' in nameEscapes; `const
            // alias = d` (this form) did not — same RHS shape, only the decl
            // wrapper differed. Fix: explicitly run the marking pass `decl`
            // itself would have gotten from a real walkFacts visit — declEq
            // (pre-registered above, op==='let'/'const' branch) still exempts
            // the LHS binding slot, so this only ever ADDS the RHS-when-bare-
            // name case, never re-marks the LHS.
            observeNodeFacts(decl, acc)
            const name = decl[1]
            if (typeof name === 'string' && ctx.funcs.names.has(name)) {
              const isFuncLit = Array.isArray(decl[2]) && decl[2][0] === '=>'
              if (isFuncLit || caller?.name !== name) acc.valueUsed.add(name)
            }
            // A bare func-ref RHS (`let c = taylor` — the fn-attached-memo idiom)
            // is a VALUE use: resolveClosureWidth must size the uniform ABI to the
            // referenced function's full arity, or its boundary trampoline forwards
            // $__a{k} slots it never declared. Mirrors the '=' handler below.
            if (isFuncRef(decl[2], ctx.funcs.names)) acc.valueUsed.add(decl[2])
            else walkFacts(decl[2], true, inArrow, caller)
          } else walkFacts(decl, true, inArrow, caller)
        }
        return
      }
      if (op === '=' && args.length >= 2) {
        // RHS may be a bare function reference (`store[0] = pick3`) — record it as a
        // value use so resolveClosureWidth sizes the closure ABI to its arity. Matches
        // the func-ref handling in the call/let/general cases below.
        if (isFuncRef(args[1], ctx.funcs.names)) acc.valueUsed.add(args[1])
        else walkFacts(args[1], true, inArrow, caller)
        return
      }
      for (const a of args) {
        if (isFuncRef(a, ctx.funcs.names)) acc.valueUsed.add(a)
        else walkFacts(a, true, inArrow, caller)
      }
    } else {
      for (const a of args) walkFacts(a, false, inArrow, caller)
    }
  }
  walkFacts(root, full, false, callerFunc)
  if (cache && full && root != null && typeof root === 'object')
    pf.walkCache.set(root, { gen: pf.gen, facts: acc })
  return acc
}

export function collectProgramFacts(ast) {
  const paramReps = new Map()
  const doSchema = ast && ctx.schema.register
  const doArity = !!ctx.closure.make
  const f = emptyWalkFacts()
  mergeWalkFacts(f, walkFactsRoot(ast, true, null, doSchema, false))
  for (const func of ctx.funcs.list) {
    if (func.body && !func.raw) mergeWalkFacts(f, walkFactsRoot(func.body, true, func, doSchema, true))
  }
  const { propMap, valueUsed, callSites } = f
  // Bundled sub-module inits live OUTSIDE `ast` (ctx.module.moduleInits — the
  // main walk never sees them) and prepare's recordModuleInitFacts collects a
  // REDUCED set with no call sites. But init code is a first-class CALLER:
  // const tables of arrows (watr's FOLD/FOLD2) call helpers with args visible
  // only here, and without these sites the param lattice settles callees
  // blind — _i64Arith.r never proved BIGINT, _i64Hex16's radix-toString
  // misformatted raw i64 bits (the speed-tier lab throw), and
  // filterLiveCallSites culled both as dead code. Collect ONLY '()' sites
  // (callerFunc = null — module scope; narrow's callerCtx already carries a
  // null entry and filterLiveCallSites keeps null-caller sites and marks
  // their callees live). Everything else stays on the reduced initFacts
  // path: a full walkFactsRoot here would re-register schemas and promote
  // init-stored func REFS into valueUsed — a program-wide dispatch behavior
  // change this census repair must not smuggle in.
  const initCallSites = (node) => {
    if (!Array.isArray(node)) return
    if (node[0] === '()' && isFuncRef(node[1], ctx.funcs.names)) {
      const a = node[2]
      const argList = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
      f.callSites.push({ callee: node[1], argList, callerFunc: null, node })
    }
    for (let i = 1; i < node.length; i++) initCallSites(node[i])
  }
  if (ctx.module.moduleInits) for (const init of ctx.module.moduleInits) initCallSites(init)
  const initFacts = ctx.module.initFacts
  if (initFacts) {
    if (initFacts.anyDyn) {
      f.anyDyn = true
      for (const v of initFacts.dynVars) f.dynVars.add(v)
    }
    if (initFacts.dynWriteVars) for (const v of initFacts.dynWriteVars) f.dynWriteVars.add(v)
    if (initFacts.writtenProps) for (const p of initFacts.writtenProps) f.writtenProps.add(p)
    if (initFacts.arrResized) for (const v of initFacts.arrResized) f.arrResized.add(v)
    if (initFacts.nameEscapes) for (const v of initFacts.nameEscapes) f.nameEscapes.add(v)
    if (initFacts.objectLiteralDefs) for (const [name, direct] of initFacts.objectLiteralDefs)
      recordObjectLiteralDef(f, name, direct)
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
    if (doSchema && initFacts.hasMapSet) f.hasMapSet = true
    if (initFacts.hasBigint) f.hasBigint = true
  }

  // Slot-type observation pass: walk every `{}` literal with the right scope's
  // valTypes installed as `ctx.func.localValTypesOverlay` so shorthand `{x}`
  // (expanded by prepare to `[':', x, x]`) and chained typed-array reads resolve
  // through valTypeOf → lookupValType. Skips into closures — they're observed via
  // their own func.list entry. The overlay is the per-function analyzeBody.valTypes
  // map (already populated with the same overlay-aware walk).
  //
  // Also entered on hasMapSet ALONE (no `{}` anywhere): the map-value census
  // (design .work/todo.md §deletion-sweep §1) rides the SAME
  // observeProgramSlots walk (visit()'s `.set(...)` branch) — a Map-only
  // program/moduleInit has no `{}` to trip hasSchemaLiterals on its own.
  // analyzeSchemaSlotIntCertain stays gated on hasSchemaLiterals strictly —
  // it is `{}`-slot-only work, wasted (though harmless) on a hasMapSet-only
  // program.
  if (doSchema && (f.hasSchemaLiterals || f.hasMapSet)) {
    observeProgramSlots(ast)
    // Per-slot intCertain mirror of the per-binding lattice. Runs after slot
    // type observation (which it does not depend on) — same trigger gate so
    // programs without schema literals skip both. Re-runnable: subsequent
    // collectProgramFacts invocations (E2 phase) overwrite the same map; the
    // analysis is monotone-down so re-running can only widen poisoning, never
    // un-poison — safe.
    if (f.hasSchemaLiterals) analyzeSchemaSlotIntCertain(ast)
  }

  // Emit-time consumers (the static object-literal fast path) read this off
  // ctx — a mutated prop name anywhere disqualifies sharing a static instance.
  // Params can carry caller-owned aliases even when signature inference gives
  // them one exact schema. No parameter definition appears as a normal body
  // assignment, so disqualify them explicitly from direct-literal ownership.
  for (const func of ctx.funcs.list) if (func.sig?.params)
    for (const p of func.sig.params) recordObjectLiteralDef(f, p.name, false)
  const literalObjectVars = new Set()
  for (const [name, direct] of f.objectLiteralDefs)
    if (direct) literalObjectVars.add(name)

  ctx.module.writtenProps = f.writtenProps
  return {
    dynVars: f.dynVars, dynWriteVars: f.dynWriteVars, anyDyn: f.anyDyn, propMap, valueUsed, callSites,
    maxDef: f.maxDef, maxCall: f.maxCall, hasRest: f.hasRest, hasSpread: f.hasSpread,
    paramReps, hasSchemaLiterals: f.hasSchemaLiterals, hasMapSet: f.hasMapSet,
    hasBigint: f.hasBigint, writtenProps: f.writtenProps,
    literalWriteKeys: f.literalWriteKeys,
    arrResized: f.arrResized, nameEscapes: f.nameEscapes, literalObjectVars,
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
  if (!ctx.funcs.list.length) return
  const poisoned = new Set(), edges = new Map()
  withValueOverlay(null, () => {
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeBody(func.body)
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
        for (const a of args) if (typeof a === 'string' && ctx.funcs.map?.has(a)) { dirty = true; return }
        if (typeof c === 'string') {
          if (ctx.funcs.map?.has(c)) out.add(c)
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
      } else if (MUTATE_OPS.has(op) && Array.isArray(n[1])) {
        const lhs = n[1]
        if ((lhs[0] === '.' || lhs[0] === '?.') && lhs[2] === 'length') { dirty = true; return }
        if (lhs[0] === '[]' && !isLiteralStr(lhs[2]) && maybeArray(lhs[1])) { dirty = true; return }
      }
      for (let i = 1; i < n.length; i++) scan(n[i])
    }
    withValueOverlay(facts.valTypes, () => scan(func.body))
    if (dirty) poisoned.add(func.name)
    else edges.set(func.name, out)
  }
  })
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
  for (const func of ctx.funcs.list) {
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
  const pf = getFactStore().programFacts
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
      const hit = pf.bodyIntCertain.get(body)
      if (hit?.gen === pf.gen) return hit.isInt
    }
    const isInt = intLevelChecker(body, slotLevelOf)
    if (body != null && typeof body === 'object')
      pf.bodyIntCertain.set(body, { gen: pf.gen, isInt })
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
    } else if (MUTATE_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '.') {
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
    for (const func of ctx.funcs.list) {
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
    pf.bodyIntCertain = new WeakMap()
    flipped = false
    sweep(true)
  }
  // Cap exhaustion (never expected — each slot descends ≤2 levels, so `rounds`
  // is bounded by slot count, not this constant) is ALWAYS a compiler bug —
  // never silently fail closed (that's still a silent precision loss for
  // every OTHER slot in the program, just a safe-looking one).
  if (flipped) err(`internal: analyzeSchemaSlotIntCertain slot-int census failed to converge — still dirty after ${rounds} rounds of its 64-round guard (this is a jz bug — a slot descended more than its 2-level bound allows; please report with a minimal repro)`)
  // Publish the consumer projections: intCertain = integral (≥1) for the
  // ToNumber-skip / floor-elision family, i32Certain = strict (=2) for raw
  // i32 slot loads and i32 local typing.
  const slotIntCertain = ctx.schema.slotIntCertain, slotI32Certain = ctx.schema.slotI32Certain
  slotIntCertain.clear(); slotI32Certain.clear()
  for (const [sid, arr] of slotIntLevels) {
    slotIntCertain.set(sid, arr.map(l => l === undefined ? undefined : l >= 1))
    slotI32Certain.set(sid, arr.map(l => l === 2))
  }
  // Invariant tripwire (design .work/carrier-representation-design.md §15/
  // §16): a BIGINT-observed slot must never ALSO be i32Certain — i32Certain
  // requires every write to be a strict-int32 NUMBER (isIntExpr), which is
  // disjoint from a BIGINT write by construction (writeVT/isIntExpr never
  // classify a bigint expression as int-level 2). packedI32/inlineCellI32
  // (module/core.js, abi/index.js) trust i32Certain to raw-i32-load a slot —
  // if that were ever true for a slot the BIGINT census also marked, the
  // packed path would corrupt a boxed pointer as a truncated int32.
  // Assert-only; a real hit is a jz bug, not a value to silently trust
  // either census over.
  if (DBG_INVARIANTS) {
    for (const [sid, arr] of ctx.schema.slotI32Certain) {
      const facts = ctx.schema.slotFacts.get(sid)
      if (!facts) continue
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === true && facts[i]?.bigintObserved === true)
          throw new Error(`P-carrier invariant: schema ${sid} slot ${i} is BOTH i32Certain and slotBigintObserved — a BIGINT write can never be strict-int32`)
      }
    }
  }
}


export { effectiveWriteValue, resetProgramFactsCache, invalidateProgramFactsCache, collectSlotWriteHazards, applySlotWriteHazards, observeProgramSlots }
