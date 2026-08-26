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

// MUTATE_OPS (ast.js) is the property-write op set: any write op whose first
// arg is a `.`/`?.` member node feeds `writtenProps` (any prop name ever
// written through ANY receiver, incl. expression receivers like `m.get(k).n++`).

// Array methods that can change length or relocate the payload (grow copies to a
// new arena block and forwards the header). sort/reverse/fill/copyWithin mutate
// elements IN PLACE — base and len stay put — so they are deliberately absent.
const ARR_RESIZE_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice'])

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

/** Drop all cached program-fact walks (called at compile entry — normally
 *  implicit via beginSession's fresh factStore; exposed for any caller that
 *  needs to force a mid-session drop). Natively the gen bump alone is enough
 *  (stale entries just go unreachable on a real GC heap). In the self-compile
 *  kernel these WeakMaps' own backing storage is itself an arena allocation
 *  that `_clear` rewinds between compiles in a warm-instance loop — a
 *  post-`_clear` alloc can overwrite the WeakMap's internal bytes, so we also
 *  swap in fresh WeakMap instances (cheap: O(1), no traversal). */
export function resetProgramFactsCache() {
  const pf = getFactStore().programFacts
  pf.gen++
  pf.walkCache = new WeakMap()
  pf.moduleInitSlot = new WeakMap()
  pf.bodyIntCertain = new WeakMap()
}

/** Drop cached walks for specific AST roots (in-place module rewrites). */
export function invalidateProgramFactsCache(...roots) {
  const pf = getFactStore().programFacts
  for (const r of roots) {
    if (r == null || typeof r !== 'object') continue
    pf.walkCache.delete(r)
    pf.moduleInitSlot.delete(r)
    pf.bodyIntCertain.delete(r)
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

// ─────────────────────── writeVT: dict-write RHS kind resolver ───────────────────────
// Strict write-kind resolver for the schema-slot (`.prop=`) and dict-value
// (`name[key]=`) censuses: valTypeOf EXCEPT (a) `.prop` reads answer null —
// consulting the live slotTypes state mid-census would make observations
// order-dependent (a source slot poisoned LATER would leave a stale kind
// standing), and (b) `+`/`+=` never guess — VT['+']'s NUMBER-for-unknowns
// optimism is fine for expression typing (the emitter still dispatches at
// runtime) but would durably misclassify a slot a string flows into.
// Non-plus arithmetic stays trustworthy through plain valTypeOf: ToNumber
// semantics make `* - / % << >> & | ^` NUMBER whatever the operands.
//
// `wctx` (optional) = { root, paramVts }:
//   - root: the dict name a `name[key]=RHS` write targets (dict-value census
//     only — omitted for the `.prop=` schema-slot census). Enables self-read
//     neutrality below.
//   - paramVts: Map<paramName, VAL.*> of the enclosing function's PARAMETER
//     kinds (narrowSignatures' call-site census, paramReps — threaded in only
//     by the late {fresh:true} refineSlotKindCensus call, plan/index.js;
//     absent on the early pass, same fail-open as everything else here).
//     lookupValType's overlay tier already resolves function-body LOCALS
//     (analyzeBody.valTypes, installed as ctx.func.localValTypesOverlay below)
//     — this is the missing PARAM-kind tier writeVT never had.
//
// Self-read neutrality (.work/todo.md §deletion-sweep): a read
// `d[...]`/`d.prop`/`d?.prop` (any nesting through further `[]`) whose root
// is `wctx.root` contributes the JOIN IDENTITY, not a poison — subscript's
// `prec[op] = !lookup[c] && prec[op] || p` shape's `prec[op]` self-read is
// exactly this. Soundness: by fixed-point over the whole-program census,
// every value ever read back from d was placed there by SOME write to d —
// either a DIFFERENT `d[k2]=...` site, whose own writeVT call independently
// observes into (or poisons) the SAME first-wins-then-clash dictValueTypes
// entry, so any kind that write contributes is already counted there with or
// without THIS write re-deriving it through a self-read — or the NaN-boxed
// undefined of a key nobody has written yet (the carve-out dictValueKindOf's
// consumers already guard, mirroring kind.js's typedReadMaybeOob precedent).
// Folding the self-read's own kind into THIS write's contribution therefore
// adds no information the census doesn't already have an independent chance
// to see, so treating it as the identity element can't hide a real
// mixed-kind write.
const SELF_READ = Symbol('writeVT self-read')

const isSelfDictRead = (n, root) => {
  if (root == null || !Array.isArray(n)) return false
  const op = n[0]
  if (op !== '[]' && op !== '.' && op !== '?.') return false
  let r = n[1]
  while (Array.isArray(r) && r[0] === '[]') r = r[1]
  return r === root
}

// Schema-slot self-referential compound writes (`o.n = o.n + 1n`, `o.n += 1n`,
// prepare's `o.n++`/`--` desugar) are handled by ABSTAINING at the call site
// (observeProgramSlots' `.prop=` branch below), not here — see
// isSelfPreservingPropWrite (below) and its call site for why:
// writeVT's own SELF_READ join (used by the dict-value census, where a
// self-read truly contributes no NEW information) is the wrong shape for a
// schema slot, whose self-read has an ALREADY-KNOWN kind from the literal —
// collapsing it into the sibling operand's kind (as '+' does below) can
// silently launder a genuine BigInt/Number mix into a false NUMBER
// observation that then POISONS the slot instead of leaving it for
// bigintMixReject to catch downstream.

// ── truthy/falsy/nonNullish value-set semantics for &&/||/?? (and only
// there — see .work/todo.md §deletion-sweep) ──────────────────────────
// A value-set is an array of `{ kind, bool }` elements: `kind` is a VAL.*
// string or the pseudo-kind 'atom' (a provably undefined/null literal —
// always falsy, never a real VAL); `bool` narrows a VAL.BOOL element's
// truthiness ('true'/'false'/'both'). BOOL is the one kind whose 2-element
// domain lets a truthy/falsy filter fully RESOLVE a value (not just "still
// possibly this kind") — that's what lets a `!x` BOOL get ELIMINATED by a
// later filter instead of merely persisting (`!x && Y || Z`: `!x`'s BOOL can
// only escape the `&&` as `false`, which `||`'s truthy filter then drops
// entirely). Every other kind is opaque to the filters — conservative, we
// don't track e.g. `0`/`''` falsy literals. `[]` (empty array) is the union
// identity — self-reads and provably-eliminated branches both reduce to it.
// `null` (from vsOf or the top-level reduce) means unclassifiable → poisons
// the whole enclosing expression, same fail-open discipline as the rest of
// writeVT.
const ATOM = 'atom'
const truthyVS = vs => vs.flatMap(e =>
  e.kind === ATOM ? [] :
  e.kind === VAL.BOOL ? (e.bool === 'false' ? [] : [{ kind: VAL.BOOL, bool: 'true' }]) :
  [e])
const falsyVS = vs => vs.flatMap(e =>
  e.kind === ATOM ? [e] :
  e.kind === VAL.BOOL ? (e.bool === 'true' ? [] : [{ kind: VAL.BOOL, bool: 'false' }]) :
  [e])
const nonNullishVS = vs => vs.filter(e => e.kind !== ATOM)
// Reduce a value-set to writeVT's single-kind-or-null contract: every real
// (non-atom) element must agree on one kind, else poison; an all-atom (or
// empty) set has nothing provable → null, same as any other unresolved leaf.
const reduceVS = vs => {
  let kind = null
  for (const e of vs) {
    if (e.kind === ATOM) continue
    if (kind === null) kind = e.kind
    else if (kind !== e.kind) return null
  }
  return kind
}

// Compositional value-set of an expression, for &&/||/??'s RHS operand.
// Recurses through nested &&/||/??/?: (a small evaluator — no shape-specific
// casing); anything else resolves through writeVT and lifts to a singleton
// (or `[]` for a self-read, `null` to poison).
const vsOf = (n, wctx) => {
  if (isSelfDictRead(n, wctx?.root)) return []
  if (nullishArm(n)) return [{ kind: ATOM }]
  if (Array.isArray(n)) {
    const op = n[0]
    if (op === '&&' || op === '||' || op === '??') {
      const a = vsOf(n[1], wctx)
      if (a == null) return null
      const b = vsOf(n[2], wctx)
      if (b == null) return null
      const filtered = op === '&&' ? falsyVS(a) : op === '||' ? truthyVS(a) : nonNullishVS(a)
      return [...filtered, ...b]
    }
    if (op === '?:') {
      const a = vsOf(n[2], wctx), b = vsOf(n[3], wctx)
      return a == null || b == null ? null : [...a, ...b]
    }
  }
  const vt = writeVT(n, wctx)
  if (vt === SELF_READ) return []
  return vt == null ? null : [{ kind: vt, bool: vt === VAL.BOOL ? 'both' : undefined }]
}

const writeVT = (n, wctx) => {
  if (isSelfDictRead(n, wctx?.root)) return SELF_READ
  if (Array.isArray(n)) {
    const op = n[0]
    if (op === '.' || op === '?.') return null
    if (op === '+' || op === '+=') {
      let ta = writeVT(n[1], wctx), tb = writeVT(n[2], wctx)
      if (ta === SELF_READ && tb === SELF_READ) return null
      if (ta === SELF_READ) ta = tb
      else if (tb === SELF_READ) tb = ta
      if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
      if (ta == null || tb == null) return null
      if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
      return VAL.NUMBER
    }
    // prepare's dedicated member ++/-- unary (index.js '++'/'--', member
    // targets only) — `d[k]++`/`d[k]--` reach the dict-value census as
    // `['+1', d[k]]`/`['-1', d[k]]` (effectiveWriteValue) rather than the
    // spelled-out `d[k] + 1`. Same shape as the '+'/'+=' case just above with
    // an IMPLICIT NUMBER-literal second operand (the "1" baked into the op) —
    // a self-read collapses to NUMBER exactly like `d[k] = d[k] + 1` already
    // did.
    if (op === '+1' || op === '-1') {
      const ta = writeVT(n[1], wctx)
      if (ta === SELF_READ) return VAL.NUMBER
      if (ta == null) return null
      return ta === VAL.BIGINT ? VAL.BIGINT : VAL.NUMBER
    }
    if (op === '?:') {
      const a = writeVT(n[2], wctx), b = writeVT(n[3], wctx)
      if (a === SELF_READ && b === SELF_READ) return null
      if (a === SELF_READ) return b
      if (b === SELF_READ) return a
      return a === b ? a : null
    }
    if (op === '&&' || op === '||' || op === '??') {
      const vs = vsOf(n, wctx)
      return vs == null ? null : reduceVS(vs)
    }
  }
  if (typeof n === 'string') return valTypeOf(n) ?? (wctx?.paramVts?.get(n) ?? null)
  return valTypeOf(n)
}

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
  const pf = getFactStore().programFacts
  const slotFacts = ctx.schema.slotFacts
  const slotConstInts = ctx.schema.slotConstInts
  const dictValueTypes = ctx.schema.dictValueTypes
  const mapValueTypes = ctx.schema.mapValueTypes
  // Grow-and-return the SlotFact object at (sid, idx) — the ONE shared
  // storage primitive every writer below mutates (product-lattice design
  // Slice 6a, ctx.js's slotFacts doc). Replaces the 4 separately-grown
  // arrays (slotTypes/slotObjSids/slotTypedCtors/slotBigintObserved) each
  // used to maintain via its own copy of this exact grow-loop.
  const slotFact = (sid, idx) => {
    let arr = slotFacts.get(sid)
    if (!arr) { arr = []; slotFacts.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    if (arr[idx] === undefined) arr[idx] = {}
    return arr[idx]
  }
  // Unlike type facts, discriminant constants are rebuilt from the complete
  // program on every facts pass. This avoids emitter/function-order coupling:
  // codegen only consumes a settled whole-program census.
  slotConstInts.clear()
  // CARRIER PROGRAM §15/§16: pure OR-join, the BIGINT twin of observeSlot's
  // clash-poisoned lattice just below — see slotBigintObserved's own doc
  // comment (ctx.js) for why this needs its OWN, never-poisoned channel.
  // Hooked into observeSlot itself (not a separate call at each site) so
  // every current and future observeSlot caller (the `{}` literal branch,
  // the `.prop=` branch, the moduleInit record()/cached-replay paths) joins
  // automatically — one write census, two projections.
  const observeBigintJoin = (sid, idx, vt) => {
    if (vt !== VAL.BIGINT) return
    slotFact(sid, idx).bigintObserved = true
  }
  const observeSlot = (sid, idx, vt) => {
    observeBigintJoin(sid, idx, vt)
    if (!vt) return
    const f = slotFact(sid, idx)
    if (f.kind === null) return
    if (f.kind === undefined) f.kind = vt
    else if (f.kind !== vt) f.kind = null
  }
  // Hard kind-poison (observeSlot's `!vt` arm is a SKIP, not a poison): a write
  // whose kind can't be independently proven forces the slot polymorphic.
  const poisonSlot = (sid, idx) => { slotFact(sid, idx).kind = null }
  const poisonCtor = (sid, idx) => { slotFact(sid, idx).typedCtor = null }
  // Nested-sid census (§19/§20 PROPERTY-KIND TRACING): observeSlot/poisonSlot's
  // own first-wins-then-clash lattice, one level up — tracks WHICH `{}`-literal
  // schema a `r.p = {...}` write's RHS is, not just its VAL kind. Fed ONLY by
  // the `.prop=`/`=`-write branch below (never the `{}`-literal decl-site
  // branch just above — see slotFacts' `.objSid` doc comment (ctx.js) for why).
  const observeObjSid = (sid, idx, childSid) => {
    const f = slotFact(sid, idx)
    if (f.objSid === null) return
    if (f.objSid === undefined) f.objSid = childSid
    else if (f.objSid !== childSid) f.objSid = null
  }
  const poisonObjSid = (sid, idx) => { slotFact(sid, idx).objSid = null }
  // Dict-value-type census (global half, product-lattice Slice 7): union-join
  // (existential fact — "which kinds was this dict ever written with"), keyed
  // by bare name instead of (sid, idx) — same whole-program name-keyed
  // convention as dynWriteVars/nameEscapes above. Disagreeing writes UNION
  // instead of the old first-wins-then-clash null-poison; an unresolved write
  // unions in the full KIND_UNIVERSE (TOP) — absorbing, same effect on the
  // exact-or-null projection (dictValueKindOf: size!==1 → null) as the old
  // sentinel, but now `censusKindsOf` can see which kinds, plural.
  const dictValueKindSet = (name) => {
    let s = dictValueTypes.get(name)
    if (!s) { s = new Set(); dictValueTypes.set(name, s) }
    return s
  }
  const observeDictValue = (name, vt) => {
    if (!vt) return
    const s = dictValueKindSet(name)
    if (s.size < KIND_UNIVERSE.length) s.add(vt)
  }
  const poisonDictValue = (name) => {
    const s = dictValueKindSet(name)
    for (const k of KIND_UNIVERSE) s.add(k)
  }
  // Map-value-type census (Tier 1, product-lattice Slice 7): observeDictValue's
  // own union lattice, applied to `recv.set(k, v)` RHS values instead of
  // `[]=` writes — Map has no bracket-write form. Same whole-program
  // name-keyed convention.
  const mapValueKindSet = (name) => {
    let s = mapValueTypes.get(name)
    if (!s) { s = new Set(); mapValueTypes.set(name, s) }
    return s
  }
  const observeMapValue = (name, vt) => {
    if (!vt) return
    const s = mapValueKindSet(name)
    if (s.size < KIND_UNIVERSE.length) s.add(vt)
  }
  const poisonMapValue = (name) => {
    const s = mapValueKindSet(name)
    for (const k of KIND_UNIVERSE) s.add(k)
  }
  const paramReps = opts?.paramReps ?? null
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
  if (opts?.fresh) { slotFacts.clear(); dictValueTypes.clear(); mapValueTypes.clear() }
  const hazards = collectSlotWriteHazards(ast, opts?.fresh
    ? { paramReps: opts.paramReps, callSites: opts.callSites, valueUsed: opts.valueUsed } : undefined)
  // Hazard fail-OPEN belt (slotBigintObserved's own doc, ctx.js): a slot the
  // kind census can't resolve precisely (Object.assign/spread merges,
  // computed-key writes, extern constructors) marks BIGINT-possible instead
  // of poisoning to false — the opposite direction from poisonSlot/poisonCtor
  // just below, because under-boxing a slot that really carries a BigInt is
  // unsound while over-boxing one that never does is a rare, harmless cost.
  applySlotWriteHazards(hazards,
    (sid, idx) => { poisonSlot(sid, idx); poisonCtor(sid, idx); observeBigintJoin(sid, idx, VAL.BIGINT) },
    { observe: (sid, idx, vt) => { vt ? observeSlot(sid, idx, vt) : poisonSlot(sid, idx); poisonCtor(sid, idx) } })
  // Elem-ctor sibling of observeSlot — same first-wins-then-clash lattice. A
  // slot whose every observed value is one typed-array kind keeps that kind for
  // `plan.tw[i]`-style reads (consumption additionally gates on the prop never
  // being written program-wide — see schema.slotTypedCtorAt).
  const observeCtor = (sid, idx, ctor) => {
    if (!ctor) return
    ctx.schema.hasTypedSlots = true
    const f = slotFact(sid, idx)
    if (f.typedCtor === null) return
    if (f.typedCtor === undefined) f.typedCtor = ctor
    else if (f.typedCtor !== ctor) f.typedCtor = null
  }
  const observeConstInt = (sid, idx, value) => {
    let arr = slotConstInts.get(sid)
    if (!arr) { arr = []; slotConstInts.set(sid, arr) }
    while (arr.length <= idx) arr.push(undefined)
    if (arr[idx] === null) return
    if (value == null || !Number.isInteger(value)) arr[idx] = null
    else if (arr[idx] === undefined) arr[idx] = value
    else if (arr[idx] !== value) arr[idx] = null
  }
  const intLiteral = n => typeof n === 'number' && Number.isInteger(n) ? n
    : Array.isArray(n) && n[0] == null && Number.isInteger(n[1]) ? n[1]
    : null
  const condNameValue = (cond) => {
    if (!Array.isArray(cond) || cond[0] !== '===') return null
    const a = cond[1], b = cond[2], av = intLiteral(a), bv = intLiteral(b)
    if (typeof a === 'string' && bv != null) return [a, bv]
    if (typeof b === 'string' && av != null) return [b, av]
    return null
  }
  const thenIntRefs = (cond, refs) => {
    const out = new Map(refs || [])
    const nv = condNameValue(cond)
    if (nv) out.set(nv[0], nv[1])
    return out
  }
  // Else-arm refinement by EXCLUSION: a mask-picked tag (`const k = s & (N-1)`,
  // range [0, N-1]) whose if-chain compares every value but the last leaves the
  // trailing else with EXACTLY one possible value — the canonical tagged-union
  // builder shape (`else rows.push({k, …})` carries k = N-1 as surely as a
  // guarded arm). Refs values: number = exact; Set = excluded ints so far.
  const elseIntRefs = (cond, refs) => {
    const out = new Map(refs || [])
    const nv = condNameValue(cond)
    if (!nv) return out
    const [name, v] = nv
    const max = maskMax?.get(name)
    const prev = out.get(name)
    const excl = new Set(prev instanceof Set ? prev : [])
    excl.add(v)
    if (max != null && excl.size === max) {
      // all but one of [0, max] excluded → the remaining value is exact
      for (let cand = 0; cand <= max; cand++) if (!excl.has(cand)) { out.set(name, cand); return out }
    }
    if (typeof prev !== 'number') out.set(name, excl)
    return out
  }
  // Per-body mask ranges: name → max for single-write `name = X & LIT`
  // (either operand order; module consts resolve through constInts).
  let maskMax = null
  const collectMaskMax = (body) => {
    const out = new Map()
    // Const-expression folding: the canonical mask spells `s & (NSHAPES - 1)`
    // with NSHAPES a module const — fold int arithmetic over resolvable parts.
    const litOf = (n) => {
      const v = intLiteral(n) ?? (typeof n === 'string' ? ctx.scope.constInts?.get(n) ?? null : null)
      if (v != null) return v
      if (Array.isArray(n) && n.length === 3) {
        const a = litOf(n[1]), b = litOf(n[2])
        if (a == null || b == null) return null
        switch (n[0]) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b
          case '&': return a & b; case '|': return a | b; case '^': return a ^ b
          case '<<': return a << b; case '>>': return a >> b
        }
      }
      return null
    }
    const note = (name, rhs) => {
      if (typeof name !== 'string') return
      let max = null
      if (Array.isArray(rhs) && rhs[0] === '&') {
        const l = litOf(rhs[1]), r = litOf(rhs[2])
        const m = l != null && l >= 0 ? l : r != null && r >= 0 ? r : null
        if (m != null && m <= 0xFFFF) max = m
      }
      out.set(name, out.has(name) && out.get(name) !== max ? null : max)
    }
    const walk = (n) => {
      if (!Array.isArray(n)) return
      if (n[0] === '=>') return
      if ((n[0] === 'let' || n[0] === 'const')) {
        for (let i = 1; i < n.length; i++)
          if (Array.isArray(n[i]) && n[i][0] === '=') note(n[i][1], n[i][2])
      } else if (n[0] === '=' && typeof n[1] === 'string') note(n[1], n[2])
      else if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') out.set(n[1], null)
      for (let i = 1; i < n.length; i++) walk(n[i])
    }
    walk(body)
    return out
  }
  let teOverlay = null
  const ctorOfValue = expr => typedStorageCtorFromContext(ctx, expr, {
    resolveName: name => teOverlay?.get(name) ?? ctx.scope.globalTypedElem?.get(name) ?? null,
  })
  // Census continues INTO a nested closure for the dict-`[]=` / Map-`.set()`
  // write shapes ONLY — a write inside a closure body (e.g.
  // `[0].forEach(() => m.set('y','oops'))`) is otherwise invisible to the
  // census, unsoundly missing a real write. This is the global-half twin of
  // analyze.js's dictValueTypeOf/mapValueTypeOf local-half census; see that
  // file's doc comment for the full soundness argument. Schema-slot
  // (`{}`/`.prop=`) census reach stays scoped to the current function —
  // `visit` below still stops at `=>` for those. `collectAllBoundNames`
  // (ast.js) is position-insensitive: ANY name it returns for this arrow's
  // whole subtree is treated as shadowed everywhere in it, which only ever
  // forfeits a fact, never misattributes a local write to an outer receiver.
  const observeNestedDictMapWrites = (arrowNode, paramVts) => {
    const bound = collectAllBoundNames(arrowNode, new Set())
    const walk = (node) => {
      if (!Array.isArray(node)) return
      const op = node[0]
      if (MUTATE_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '[]') {
        const [, wobj, widx] = node[1]
        if (!isLiteralStr(widx)) {
          let root = wobj
          while (Array.isArray(root) && root[0] === '[]') root = root[1]
          if (typeof root === 'string' && !bound.has(root)) {
            const vt = writeVT(effectiveWriteValue(op, node[1], node[2]), { root, paramVts })
            if (vt) observeDictValue(root, vt); else poisonDictValue(root)
          }
        }
      } else if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' &&
          typeof node[1][1] === 'string' && node[1][2] === 'set') {
        const recvName = node[1][1]
        if (!bound.has(recvName) && valTypeOf(recvName) === VAL.MAP) {
          const cargs = commaList(node[2])
          if (cargs.length === 2) {
            const vt = writeVT(cargs[1], { paramVts })
            if (vt) observeMapValue(recvName, vt); else poisonMapValue(recvName)
          }
        }
      }
      for (let i = 1; i < node.length; i++) walk(node[i])
    }
    walk(arrowNode[2])
  }
  const visit = (node, intRefs = null, paramVts = null) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') { observeNestedDictMapWrites(node, paramVts); return }
    // Preserve exact branch-local constants while censusing literals such as
    // `if (kind === 3) rows.push({kind, ...})`. Else arms accumulate the
    // excluded values; with a known mask range the trailing else resolves to
    // the one remaining value (see elseIntRefs).
    if (op === 'if' || op === '?:') {
      visit(node[1], intRefs, paramVts)
      visit(node[2], thenIntRefs(node[1], intRefs), paramVts)
      if (node[3] != null) visit(node[3], elseIntRefs(node[1], intRefs), paramVts)
      return
    }
    if (op === '{}') {
      const parsed = staticObjectProps(node.slice(1))
      if (parsed) {
        const sid = ctx.schema.register(parsed.names)
        for (let i = 0; i < parsed.values.length; i++) {
          const value = parsed.values[i]
          observeSlot(sid, i, valTypeOf(value))
          observeCtor(sid, i, ctorOfValue(value))
          observeConstInt(sid, i, intLiteral(value) ?? (typeof value === 'string' && typeof intRefs?.get(value) === 'number' ? intRefs.get(value) : null))
        }
      }
    } else if (MUTATE_OPS.has(op) && Array.isArray(node[1]) &&
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
        const effVal = effectiveWriteValue(op, node[1], node[2])
        // Self-preserving compound write (`o.n = o.n + 1n`, `o.n += 1n`,
        // `o.n++`/`--`) — abstain (see isSelfPreservingPropWrite above), not
        // observe/poison.
        if (!isSelfPreservingPropWrite(node[1][1], node[1][2], effVal)) {
          const vt = writeVT(effVal, { paramVts })
          if (vt) observeSlot(sid, idx, vt)
          // Unresolvable VALUE kind on a resolvable receiver isn't covered by
          // collectSlotWriteHazards (that hazard set tracks unresolvable
          // RECEIVERS) — fail-open the bigint join here too (see
          // slotBigintObserved's doc, ctx.js): the write could be a BigInt
          // this census just couldn't independently prove.
          else { poisonSlot(sid, idx); observeBigintJoin(sid, idx, VAL.BIGINT) }
          // Nested-sid census (§19/§20): a `.`-node/bare-name receiver's `.prop`
          // resolves to a whole-program-unique schema id only when EVERY write
          // is provably the SAME `{}`-literal shape — any non-literal RHS
          // (including one that resolves through further indirection) poisons,
          // exactly like a kind clash, never silently skips.
          const childSid = objLiteralSchemaId(effVal)
          if (childSid != null) observeObjSid(sid, idx, childSid)
          else poisonObjSid(sid, idx)
        }
      }
    } else if (MUTATE_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '[]') {
      // Dict-value-type census (global half, design §1b): `name[key] = rhs` for
      // any non-literal key, rooted through nested `[]` chains at a bare name.
      // NOT gated on dynWriteVars here (the early call runs before it exists) —
      // unconditional census, gate lives at CONSUME time (kind.js).
      const [, wobj, widx] = node[1]
      if (!isLiteralStr(widx)) {
        let root = wobj
        while (Array.isArray(root) && root[0] === '[]') root = root[1]
        if (typeof root === 'string') {
          const vt = writeVT(effectiveWriteValue(op, node[1], node[2]), { root, paramVts })
          if (vt) observeDictValue(root, vt); else poisonDictValue(root)
        }
      }
    } else if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' &&
        typeof node[1][1] === 'string' && node[1][2] === 'set') {
      // Map-value-type census (Tier 1, global half, design .work/todo.md
      // §deletion-sweep §1): `recv.set(k, v)` — Map's only write form (no
      // `[]=` shape exists), so this branch is a CALL-shape sibling of the
      // dict `[]=` branch above, not a MUTATE_OPS variant. Receiver gate is a
      // HARD classification (new Map() → CALLEE_VAL + recordGlobalRep) —
      // checked HERE at observe time (unlike the dict branch's fail-open
      // unconditional census whose HASH-ness is settled at CONSUME time),
      // since valTypeOf is already a cheap proven fact for a Map receiver.
      const recvName = node[1][1]
      if (valTypeOf(recvName) === VAL.MAP) {
        const cargs = commaList(node[2])
        if (cargs.length === 2) {
          const vt = writeVT(cargs[1], { paramVts })
          if (vt) observeMapValue(recvName, vt); else poisonMapValue(recvName)
        }
      }
    }
    for (let i = 1; i < node.length; i++) visit(node[i], intRefs, paramVts)
  }
  withValueOverlay(null, () => {
  if (ast) { teOverlay = null; maskMax = collectMaskMax(ast); visit(ast) }
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    const facts = analyzeBody(func.body)
    withValueOverlay(facts.valTypes, () => {
      teOverlay = facts.typedElems
      maskMax = collectMaskMax(func.body)
      // Parameter-kind channel (design §"Parameter-kind channel"): only proven
      // post-narrowing (opts.paramReps, the late {fresh:true} call) — mirrors
      // collectSlotWriteHazards' identical curParamVts construction above.
      const reps = paramReps?.get(func.name)
      const paramVts = reps
        ? new Map((func.sig?.params || []).map((p, k) => [p.name, reps.get(k)?.val]).filter(([, v]) => v != null))
        : null
      visit(func.body, null, paramVts)
    })
  }
  teOverlay = null
  // hasMapSet joins hasSchemaLiterals as the moduleInit-walk trigger (design
  // .work/todo.md §deletion-sweep §1): a bundled sub-module whose init
  // code is PURELY `const M = new Map(); M.set(...)` has no `{}` anywhere to
  // trip hasSchemaLiterals on its own — see hasMapSet's own doc comment
  // (observeNodeFacts, above) for the matching pre-scan.
  if ((ctx.module.initFacts?.hasSchemaLiterals || ctx.module.initFacts?.hasMapSet) && ctx.module.moduleInits) {
    for (const mi of ctx.module.moduleInits) {
      const hit = pf.moduleInitSlot.get(mi)
      if (hit?.gen === pf.gen) {
        for (const [sid, idx, vt, ctor, ci] of hit.obs) {
          observeSlot(sid, idx, vt); observeCtor(sid, idx, ctor); observeConstInt(sid, idx, ci)
        }
        for (const [name, vt] of hit.dictObs) {
          if (vt) observeDictValue(name, vt); else poisonDictValue(name)
        }
        for (const [name, vt] of hit.mapObs) {
          if (vt) observeMapValue(name, vt); else poisonMapValue(name)
        }
        continue
      }
      const obs = []
      const record = (sid, idx, vt, ctor, ci) => {
        obs.push([sid, idx, vt, ctor, ci])
        observeSlot(sid, idx, vt)
        observeCtor(sid, idx, ctor)
        observeConstInt(sid, idx, ci)
      }
      const dictObs = []
      const recordDict = (name, vt) => {
        dictObs.push([name, vt])
        if (vt) observeDictValue(name, vt); else poisonDictValue(name)
      }
      const mapObs = []
      const recordMap = (name, vt) => {
        mapObs.push([name, vt])
        if (vt) observeMapValue(name, vt); else poisonMapValue(name)
      }
      const visitInit = (node, intRefs = null) => {
        if (!Array.isArray(node)) return
        const op = node[0]
        if (op === '=>') return
        if (op === 'if' || op === '?:') {
          visitInit(node[1], intRefs)
          visitInit(node[2], thenIntRefs(node[1], intRefs))
          if (node[3] != null) visitInit(node[3], intRefs)
          return
        }
        if (op === '{}') {
          const parsed = staticObjectProps(node.slice(1))
          if (parsed) {
            const sid = ctx.schema.register(parsed.names)
            for (let i = 0; i < parsed.values.length; i++) {
              const value = parsed.values[i]
              record(sid, i, valTypeOf(value), ctorOfValue(value),
                intLiteral(value) ?? (typeof value === 'string' ? intRefs?.get(value) : null))
            }
          }
        } else if (MUTATE_OPS.has(op) && Array.isArray(node[1]) && node[1][0] === '[]') {
          // Dict-value-type census, moduleInit half (Fix B) — mirrors visit()'s
          // branch above. Module inits carry no params, so wctx is root-only.
          const [, wobj, widx] = node[1]
          if (!isLiteralStr(widx)) {
            let root = wobj
            while (Array.isArray(root) && root[0] === '[]') root = root[1]
            if (typeof root === 'string') {
              const vt = writeVT(effectiveWriteValue(op, node[1], node[2]), { root })
              recordDict(root, vt)
            }
          }
        } else if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' &&
            typeof node[1][1] === 'string' && node[1][2] === 'set') {
          // Map-value-type census, moduleInit half — mirrors visit()'s branch
          // above. Module inits carry no params, so wctx is root-only (no
          // paramVts, same as the dict branch just above).
          const recvName = node[1][1]
          if (valTypeOf(recvName) === VAL.MAP) {
            const cargs = commaList(node[2])
            if (cargs.length === 2) recordMap(recvName, writeVT(cargs[1], {}))
          }
        }
        for (let i = 1; i < node.length; i++) visitInit(node[i], intRefs)
      }
      teOverlay = null
      visitInit(mi)
      if (mi != null && typeof mi === 'object') pf.moduleInitSlot.set(mi, { gen: pf.gen, obs, dictObs, mapObs })
    }
  }
  })
  // Publish the dict-value-type census onto globalReps — kind.js's
  // dictValueKindOf projects the exact-or-null answer from this Set
  // (size===1 → the kind, else null); censusKindsOf (opt-in, product-lattice
  // Slice 7) reads the raw union. Runs every observeProgramSlots call (both
  // the early hasSchemaLiterals-gated pass and the late {fresh:true}
  // rebuild), so a poisoned-then-cleared entry on rebuild correctly
  // overwrites the earlier value via updateGlobalRep's merge. Published as a
  // COPY (`new Set(s)`), never the live working Set, so a later observation
  // in the SAME pass (before the next {fresh:true} clear) can't silently
  // mutate an already-published rep field by aliasing.
  for (const [name, s] of dictValueTypes) if (s.size) updateGlobalRep(name, { dictValueValType: new Set(s) })
  // Map-value-type census (Tier 1) — same publish discipline as the
  // dict-value census just above. Both dictValueKindOf and mapValueKindOf
  // are live consumers (product-lattice Slice 1's censusMaybeUndefinedKind
  // dispatch; Slice 7's keyedWrite consumer reads the raw Set via
  // censusKindsOf).
  for (const [name, s] of mapValueTypes) if (s.size) updateGlobalRep(name, { mapValueValType: new Set(s) })
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

// Self-referential compound `.prop=` writes (`o.n = o.n + 1n`, `o.n += 1n`,
// prepare's `o.n++`/`--` desugar) can only ever PRESERVE the slot's existing
// censused kind, never establish a new one — writeVT can't determine one
// either way without circularly re-deriving the slot's own kind, and its
// generic `.`-read-answers-null rule would otherwise hard-POISON the slot on
// every such write (a live regression: `o.n += 1n` on a `{n: 8n}` literal lost
// the BIGINT observation entirely). The correct census contribution is to
// ABSTAIN — skip both observe and poison, leaving whatever the literal (or an
// earlier write) already established. A genuine mismatch (`o.n += 1` on a
// real BigInt slot) still surfaces: valTypeOf(o.n) resolves BIGINT from the
// untouched census, and bigintMixReject (emit.js) throws on it at emit time —
// this check only decides what the CENSUS records, not whether the write is
// legal. Structural, not kind-aware (mirrors analyze-scans.js's flat-object
// sibling, selfPreservingWrittenKeys/preserves — same problem, same shape,
// different storage; kept as a small local duplicate rather than a shared
// export to avoid coupling two call sites with different target shapes).
const SELF_PRESERVING_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>'])
function isSelfPreservingPropWrite(obj, prop, rhs) {
  const isSelf = (n) => Array.isArray(n) && (n[0] === '.' || n[0] === '?.') && n[1] === obj && n[2] === prop
  const preserves = (n) => {
    if (isSelf(n)) return true
    if (!Array.isArray(n)) return false
    const [op, a, b] = n
    // prepare's dedicated member ++/-- unary (index.js): "a, ±1, same kind" —
    // trivially self-preserving, no second operand to check.
    if (b === undefined && (op === '+1' || op === '-1')) return isSelf(a)
    if (b === undefined || !SELF_PRESERVING_OPS.has(op)) return false
    const aSelf = isSelf(a), bSelf = isSelf(b)
    if (!aSelf && !bSelf) return false
    const other = aSelf ? b : a
    if (isSelf(other)) return true
    if (Array.isArray(other) && other[0] == null && typeof other[1] === 'number') return true  // number literal
    if (Array.isArray(other) && other[0] === 'bigint') return true                             // bigint literal
    return preserves(other)
  }
  return preserves(rhs)
}

const KEYED_EXEMPT_VALS = new Set([VAL.ARRAY, VAL.TYPED, VAL.HASH, VAL.MAP, VAL.SET, VAL.STRING])

/** Program-wide slot-write hazard scan → `{ pointsTo, dynPointsTo, props,
 *  numeric, kindSafeSids }`, stashed on `ctx.schema.slotWriteHazards` for the
 *  census readers' belt checks. `pointsTo` (product-lattice design .work/
 *  lattice-design.md §1.3/§5) is one field replacing what used to be a
 *  separate `hz.all: boolean`/`hz.sids: Set` pair: `Set<SchemaId>` for every
 *  narrowed write, or the literal string `'ALL'` — an ABSTRACT top sentinel
 *  (never a materialized snapshot of every sid known so far — new sids can mint mid-scan,
 *  ctx.schema.register calls at lines below and inside this very function;
 *  OQ4 verified no register call's argument path reads pointsTo/hz, so this
 *  stays sound). `hz.props`/`hz.numeric` stay their OWN cross-cutting predicates,
 *  deliberately NOT folded into `pointsTo` (§1.3: a property NAME or a
 *  numeric-key CLASS poisoned program-wide is orthogonal to any per-sid
 *  points-to set). Recomputed per program-facts generation, and again
 *  post-narrowing (plan's refine step, opts.paramReps) — narrowed param reps
 *  resolve receivers the early pass can't (`re[j] = tr` on a TYPED param is an
 *  element write, not a world-poison). `kindSafeSids` maps a sid to its
 *  guarded-constructor slot KINDS (the JSON shaped/const parsers — any runtime
 *  shape divergence falls back to the generic parser's disjoint runtime sids,
 *  so the sample's kinds hold for every object carrying the sid): slotTypes
 *  OBSERVES those kinds, slotIntCertain still poisons (a JSON number is any
 *  double).
 *
 *  `dynPointsTo` (dyn-reach slice) is `pointsTo`'s READ-side sibling, same
 *  `Set<SchemaId> | 'ALL'` shape, fed from this SAME visit() walk by ALSO
 *  observing `[]` READS and `for-in` (mirroring observeNodeFacts:154-162 —
 *  that walk's `anyDyn`/`dynVars` fold every dyn-key touch, read OR write,
 *  into one whole-program bit; `pointsTo` above already gives WRITES sid
 *  precision, so this channel exists to give READS the same precision,
 *  through the identical sidOf/addPointsTo-shape/markPointsToAll-shape/
 *  KEYED_EXEMPT_VALS machinery). Consumed by module/schema.js's
 *  schemaDynReach, in turn by src/ir.js's needsDynShadow: a schema's
 *  construction-time props-sidecar mirror is only needed for sids this set
 *  names (or when the set is 'ALL') — the mirror exists SPECIFICALLY so a
 *  dyn-key READ elsewhere finds the field, so a schema no READ can ever
 *  reach needs no mirror. `for-in` is a REAL (not merely conservative) READ
 *  dependency here, not just a stand-in for "some read exists": its own
 *  codegen (module/collection.js `for-in`) walks ONLY the off-16 props
 *  sidecar — a zero/absent sidecar iterates ZERO times, no schema-table
 *  fallback — so under-marking a for-in receiver's sid silently drops every
 *  field of every instance from enumeration, not merely slower dispatch. */
export function collectSlotWriteHazards(ast, opts) {
  const pf = getFactStore().programFacts
  const late = !!opts?.paramReps
  if (pf.hazard && pf.hazard.gen === pf.gen && pf.hazard.late === late)
    return (ctx.schema.slotWriteHazards = pf.hazard.hz)
  const hz = { pointsTo: new Set(), dynPointsTo: new Set(), props: new Set(), numeric: false, kindSafeSids: new Map() }
  // pointsTo mutators: 'ALL' absorbs (once TOP, stays TOP — a later addSid is
  // a no-op, matching the old hz.all sticky-poison shape); every setter below
  // goes through these two instead of touching pointsTo directly.
  const addPointsTo = (sid) => { if (hz.pointsTo !== 'ALL') hz.pointsTo.add(sid) }
  const markPointsToAll = () => { hz.pointsTo = 'ALL' }
  // dynPointsTo twin of the two mutators above — same sticky-TOP shape, own field.
  const addDynPointsTo = (sid) => { if (hz.dynPointsTo !== 'ALL') hz.dynPointsTo.add(sid) }
  const markDynPointsToAll = () => { hz.dynPointsTo = 'ALL' }

  // ——— union points-to (dyn-reach slice 2, parameter shape): a bare-name
  // dyn-key receiver that's a function PARAMETER — sidOf's own fallbacks
  // (curSids/repOf/ctx.schema.vars below) never bind a param name, so this
  // was an automatic markDynPointsToAll before — resolves to the UNION of
  // schemas its call sites actually pass, instead of the whole-program 'ALL'
  // sentinel. Late-only (needs opts.callSites, mirroring opts.paramReps's own
  // late-only threading): the early pre-narrowing hazard pass stays exactly
  // as conservative as before, and only the LAST hazard computation before
  // emit (plan/index.js's refineSlotKindCensus) ever reaches codegen, so
  // precision here is free to start late.
  //
  // Resolution per call-site argument (.work/dyn-reach-slice.md's own 3-way
  // split): a `{}` literal with static keys resolves via the SAME
  // objLiteralSchemaId/register path collectProgramFacts already registers it
  // through (idempotent re-resolution — never mints a new schema); a bare
  // name that is ITSELF a parameter of the calling function recurses into
  // THAT param's own union (memoized + a DFS seen-set for cycle safety);
  // anything else (a `.`-chain, a local variable, a call, a primitive
  // literal, a missing/defaulted arg) is unresolvable — that whole PARAM
  // unions to 'ALL', exactly today's markDynPointsToAll fallback, just scoped
  // to the one param instead of the one dyn-key site.
  //
  // Exported/value-used/raw callees, and the rest-param slot, are excluded up
  // front: `callSites` (built by isFuncRef-gated direct `f(...)` sites,
  // this module's own walk above) is NOT a complete enumeration of every way
  // such a function/slot can be invoked/filled — an external host caller, an
  // indirect call through a stored reference, or the packed tail of a rest
  // param could supply a value no site here ever sees, so the union would be
  // unsound. A function with zero statically-visible call sites (dead code,
  // or reached only indirectly) can't be proven anything either — 'ALL'.
  const callSites = opts?.callSites
  const csValueUsed = opts?.valueUsed
  let sitesByCallee = null
  if (late && callSites) {
    sitesByCallee = new Map()
    for (const cs of callSites) {
      const list = sitesByCallee.get(cs.callee)
      if (list) list.push(cs); else sitesByCallee.set(cs.callee, [cs])
    }
  }
  const paramUnionMemo = new Map()
  const paramUnionSeen = new Set()
  // One call-site argument → a resolved sid Set, or 'ALL' (unresolvable,
  // forces the whole param). A bare-name arg that is itself the CALLER's own
  // parameter recurses into resolveParamUnion below.
  function resolveArgSids(arg, callerFunc) {
    if (Array.isArray(arg) && arg[0] === '{}') {
      const sid = objLiteralSchemaId(arg)
      return sid != null ? new Set([sid]) : 'ALL'
    }
    if (typeof arg === 'string' && callerFunc?.sig?.params) {
      const params = callerFunc.sig.params
      for (let i = 0; i < params.length; i++)
        if (params[i].name === arg) return resolveParamUnion(callerFunc.name, i)
    }
    return 'ALL'
  }
  // Per-(function,paramIdx) union, memoized + cycle-guarded. DFS seen-set:
  // `add` on entry, `delete` on exit — every exit path (the loop's normal
  // completion AND its early `break`) falls through to the same delete, so a
  // param depending on itself (directly or through a forwarding chain) reads
  // back 'ALL' for the in-progress entry rather than recursing forever; the
  // memo then caches that same conservative answer so a later, unrelated
  // query for the same key doesn't re-walk the cycle. A true self-identity
  // edge — `f(…, p, …)` calling itself with its OWN param p at the SAME
  // position — contributes NOTHING rather than tripping the cycle guard
  // (mirrors narrow.js's narrowSignatures applySiteRules identical
  // "constrains nothing" skip for the same shape): the equation `U = U ∪
  // rest` reduces to `U = rest`, so folding that edge in is exact, not merely
  // conservative.
  function resolveParamUnion(funcName, paramIdx) {
    const key = funcName + '#' + paramIdx
    if (paramUnionMemo.has(key)) return paramUnionMemo.get(key)
    if (paramUnionSeen.has(key)) return 'ALL'
    const func = ctx.funcs.map?.get(funcName)
    const params = func?.sig?.params
    const restIdx = func?.rest && params ? params.length - 1 : -1
    if (!func || func.raw || func.exported || csValueUsed?.has(funcName) || !params?.length || paramIdx === restIdx) {
      paramUnionMemo.set(key, 'ALL')
      return 'ALL'
    }
    const sites = sitesByCallee.get(funcName)
    if (!sites || !sites.length) { paramUnionMemo.set(key, 'ALL'); return 'ALL' }
    const pname = params[paramIdx].name
    paramUnionSeen.add(key)
    const acc = new Set()
    let all = false
    for (const cs of sites) {
      if (paramIdx >= cs.argList.length) { all = true; break }
      const arg = cs.argList[paramIdx]
      if (funcName === cs.callerFunc?.name && arg === pname) continue
      const r = resolveArgSids(arg, cs.callerFunc)
      if (r === 'ALL') { all = true; break }
      for (const sid of r) acc.add(sid)
    }
    paramUnionSeen.delete(key)
    const result = all ? 'ALL' : acc
    paramUnionMemo.set(key, result)
    return result
  }
  // dynKeyedRead/dynKeyedEnum's shared last-resort fallback: obj is a bare
  // name, unresolved by sidOf, not provably non-OBJECT by kindOf — before
  // giving up to the whole-program 'ALL' sentinel, check whether it's a
  // PARAMETER of the function currently being walked (curParamIdx below) and,
  // if so, mark its resolved call-site union instead. Returns true iff it
  // handled the union (possibly empty — a param proven to receive object args
  // from zero call sites needs no mark either), leaving markDynPointsToAll as
  // the caller's own fallback when this returns false.
  const tryParamUnion = (obj) => {
    if (!sitesByCallee || typeof obj !== 'string' || !curParamIdx) return false
    const k = curParamIdx.get(obj)
    if (k == null) return false
    const result = resolveParamUnion(curFuncName, k)
    if (result === 'ALL') return false
    for (const sid of result) addDynPointsTo(sid)
    return true
  }
  let curSids = null, curParamVts = null, curParamIntCertain = null, curParamIdx = null, curFuncName = null
  const sidOf = (obj) => {
    // PROPERTY-KIND TRACING (§19/§20): a `.`-node receiver chain-resolves
    // through slotObjSids (module/schema.js's chainSid — shared walker, see
    // its doc comment) instead of requiring a bare string.
    if (typeof obj !== 'string') return ctx.schema.chainSid(obj, sidOf)
    if (ctx.schema.poisoned?.has(obj)) return null
    return curSids?.get(obj) ?? repOf(obj)?.schemaId ?? ctx.schema.vars.get(obj) ?? null
  }
  const kindOf = (obj) => typeof obj === 'string'
    ? (curParamVts?.get(obj) ?? repOf(obj)?.val ?? valTypeOf(obj))
    : valTypeOf(obj)
  const propWrite = (obj, prop) => {
    // Resolvable string receivers are the censuses' own precise territory.
    if (sidOf(obj) == null) hz.props.add(prop)
  }
  // Object.assign target-schema resolution for the two shapes module/object.js's
  // OWN `resolveSchema` recognizes structurally (mirrored here, not imported — an
  // emitter module importing INTO this analysis layer would invert the dependency;
  // duplicated with a documented reason, same convention the `{}` spread-literal
  // branch below already uses): a literal `{...}` with no spread resolves to its
  // own name-set, and `Object.create(null|undefined)` is emitter-lowered straight
  // to the equivalent empty `{}` (module/object.js's `isNullishLiteral(proto) →
  // ctx.core.emit['{}']()`), so its target schema is the EMPTY schema. Either way
  // the write can only ever touch THAT one schema's slots — pointsTo scopes to it
  // instead of the 'ALL' whole-program blanket. Returns null (defer to kindOf) for
  // anything else, INCLUDING a spread literal or a non-nullish Object.create(proto)
  // — those still need the real schema/kind proof, not this shortcut.
  const staticAssignTargetNames = (t) => {
    if (!Array.isArray(t)) return null
    if (t[0] === '()' && t[1] === 'Object.create') {
      const proto = commaList(t[2])[0]
      const nullish = proto === undefined
        || (Array.isArray(proto) && proto.length === 2 && proto[0] == null && proto[1] == null)
      return nullish ? [] : null
    }
    if (t[0] === '{}') {
      const props = t.length === 2 && Array.isArray(t[1]) && t[1][0] === ',' ? t[1].slice(1) : t.slice(1)
      if (props.some(p => Array.isArray(p) && p[0] === '...')) return null
      return props.filter(p => Array.isArray(p) && p[0] === ':').map(p => String(p[1]))
    }
    return null
  }
  const keyedWrite = (obj, key) => {
    if (isLiteralStr(key)) return propWrite(obj, key[1])
    const sid = sidOf(obj)
    if (sid != null) { addPointsTo(sid); return }
    const vt = kindOf(obj)
    if (vt != null && vt !== VAL.OBJECT && KEYED_EXEMPT_VALS.has(vt)) return
    if (valTypeOf(key) === VAL.NUMBER ||
        (typeof key === 'string' && (repOf(key)?.intCertain === true || curParamIntCertain?.has(key)))) hz.numeric = true
    else markPointsToAll()
  }
  // dynPointsTo twin of keyedWrite, for a `[]` READ (`obj[key]` in value
  // position) instead of a write target. Same shape, deliberately: a literal
  // string key resolves to a fixed schema slot at compile time (no dyn-props
  // probe ever reached, see litKey/staticPropertyKey in emit-assign.js) so it
  // is exempt exactly like keyedWrite's own propWrite fast-out; a resolved
  // receiver sid marks precisely; an exempt non-OBJECT kind (KEYED_EXEMPT_VALS)
  // can never BE a schema instance so it can't reach any sid; anything else
  // (unresolvable AND possibly OBJECT) fails closed to the 'ALL' top sentinel.
  const dynKeyedRead = (obj, key) => {
    if (isLiteralStr(key)) return
    const sid = sidOf(obj)
    if (sid != null) { addDynPointsTo(sid); return }
    const vt = kindOf(obj)
    if (vt != null && vt !== VAL.OBJECT && KEYED_EXEMPT_VALS.has(vt)) return
    if (tryParamUnion(obj)) return
    markDynPointsToAll()
  }
  // dynPointsTo feed for `for-in obj` — a REAL read dependency (see this
  // function's own doc comment above), not merely conservative: no literal-key
  // exemption applies (for-in has no key expression to fold away).
  const dynKeyedEnum = (obj) => {
    const sid = sidOf(obj)
    if (sid != null) { addDynPointsTo(sid); return }
    const vt = kindOf(obj)
    if (vt != null && vt !== VAL.OBJECT && KEYED_EXEMPT_VALS.has(vt)) return
    if (tryParamUnion(obj)) return
    markDynPointsToAll()
  }
  // Member targets buried in a destructuring pattern — written with values the
  // censuses can't see; hazard them like opaque writes.
  const patternTargets = (pat) => {
    if (!Array.isArray(pat)) return
    const op = pat[0]
    if (op === '.' || op === '?.') {
      if (typeof pat[2] === 'string') {
        const sid = sidOf(pat[1])
        if (sid != null) addPointsTo(sid)
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
    if (MUTATE_OPS.has(op) && Array.isArray(node[1])) {
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
        if (known && names.length) addPointsTo(ctx.schema.register(names))
      }
    } else if (op === '()' && node[1] === 'Object.assign') {
      // node[2] is the RAW args slot — for the common 2+-arg call (a target plus
      // at least one source) it's a `,`-node, not the target itself; commaList
      // unwraps it the same way callArgs/setCallArgs (ast.js) do everywhere else
      // a call's args are read. Passing the un-unwrapped comma-node to sidOf/
      // kindOf below never resolves (neither is a bare string nor a typeable
      // expr), so every real (target, ...sources) call fell straight to the
      // 'ALL' blanket (markPointsToAll) — this fixes that dead resolution, it
      // doesn't newly attempt one.
      const target = commaList(node[2])[0]
      const sid = sidOf(target)
      if (sid != null) addPointsTo(sid)
      else {
        const names = staticAssignTargetNames(target)
        if (names) addPointsTo(ctx.schema.register(names))
        else {
          const vt = kindOf(target)
          if (vt == null || vt === VAL.OBJECT) markPointsToAll()
        }
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
    } else if (op === '[]') {
      // READ-position `[]` (mirrors observeNodeFacts:154-156's anyDyn/dynVars
      // shape). A MUTATE_OPS write target's own `[]` lhs node is ALSO visited
      // here via the generic recursion below (it isn't excluded) — harmless,
      // over-marks a write-only receiver's sid into dynPointsTo too, the same
      // safe direction as keyedWrite's own hz.pointsTo (a strict superset of
      // "genuinely read somewhere" is still sound, only more conservative).
      dynKeyedRead(node[1], node[2])
    } else if (op === 'for-in') {
      dynKeyedEnum(node[2])
    }
    for (let i = 1; i < node.length; i++) visit(node[i])
  }
  // Per-body valTypes overlays (mirrors observeProgramSlots): receiver/key
  // resolution must see local kinds — `ps[i] = {…}` with ps a local ARRAY and
  // i an int counter is an ELEMENT write, not a slot hazard; without the
  // overlay both fall to unknown and the scan poisons the world.
  withValueOverlay(null, () => {
  if (ast) { curSids = null; visit(ast) }
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw) continue
    withValueOverlay(analyzeBody(func.body).valTypes, () => {
      curSids = late ? collectBodyElemSids(func, opts.paramReps) : null
      // Late mode: narrowed param reps type this body's params (the early pass
      // can't — `re[j] = tr` on a TYPED param must classify as an element write).
      if (late) {
        const reps = opts.paramReps.get(func.name)
        const params = func.sig?.params || []
        curParamVts = reps
          ? new Map(params.map((p, k) => [p.name, reps.get(k)?.val]).filter(([, v]) => v != null))
          : null
        // keyedWrite's numeric-key exemption (§21's lever 2): a param proven both
        // wasm i32 AND VAL.NUMBER is genuinely integer-valued — `r.wasm === 'i32'`
        // alone also covers VAL.BOOL params, so the val check is required.
        curParamIntCertain = reps
          ? new Set(params.filter((p, k) => p.type === 'i32' && reps.get(k)?.val === VAL.NUMBER).map(p => p.name))
          : null
      }
      // curParamIdx/curFuncName feed tryParamUnion's "is this bare name a
      // PARAMETER of the function currently being walked" check — only
      // needed (and only built) when sitesByCallee exists to resolve against.
      if (sitesByCallee) {
        curFuncName = func.name
        curParamIdx = new Map((func.sig?.params || []).map((p, k) => [p.name, k]))
      }
      try { visit(func.body) }
      finally { curSids = curParamVts = curParamIntCertain = null; curFuncName = curParamIdx = null }
    })
  }
  if (ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) visit(mi)
  })
  pf.hazard = { gen: pf.gen, late, hz }
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
    const whole = hz.pointsTo === 'ALL' || hz.pointsTo.has(sid) || externs?.has(sid) ||
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

