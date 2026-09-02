/**
 * program-facts split — the whole-program AST walk (dyn keys, call sites,
 * escapes): `observeNodeFacts` (single-node observer, also called directly
 * by prepare/index.js) and `collectProgramFacts` (the orchestrator —
 * sweeps `ast` + every function body + module inits, then conditionally
 * triggers slot-kind-census.js / slot-int-census.js). See
 * `../program-facts.js` for the full module map and build order.
 * @module program-facts/walk-facts
 */
import { commaList, isFuncRef, isLiteralStr, MUTATE_OPS, extractParams, classifyParam, PARAM_KIND, PARAM_NAME, walkAst } from '../../ast.js'
import { ctx, err, getFactStore } from '../../ctx.js'
import { VAL } from '../../reps.js'
import { nullishArm } from '../../kind.js'
import { staticObjectProps } from '../../static.js'
import { observeProgramSlots } from './slot-kind-census.js'
import { analyzeSchemaSlotIntCertain } from './slot-int-census.js'
import { ARR_RESIZE_METHODS } from './shared.js'

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

// Reused because observeNodeFacts is a non-recursive walkAst observer. Rest
// destructuring allocated one children array for every AST node in every
// whole-program census; no caller retains this scratch view.
const OBSERVE_ARGS = []
export function observeNodeFacts(node, f) {
  if (!Array.isArray(node)) return
  const op = node[0]
  OBSERVE_ARGS.length = node.length - 1
  for (let i = 1; i < node.length; i++) OBSERVE_ARGS[i - 1] = node[i]
  const args = OBSERVE_ARGS
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
      // `__keys_ro(src)` is prepare's OWN `for…in` lowering (src/prepare/
      // index.js, "for-in's read-only key list") — never written by a user
      // program directly, and by the time this walk ever sees a call to it,
      // that's the ONLY shape it can be in: strict mode ERRORS on `for…in`
      // before this walk runs at all, and every other program has already
      // had it rewritten into exactly this call. Its one argument is read
      // ONLY for its enumerable key STRINGS (Object.keys semantics, "sound
      // only because for-in reads ks[i]/ks.length and never mutates") — the
      // identical "queried, not exposed" shape `'in'`'s RHS is already
      // exempted for above, one call-argument position instead of an
      // operator's own fixed slot (a per-OP `ESCAPE_SKIP['for-in']` entry
      // would never fire — the `'for-in'` op itself never reaches here).
      const keysRoArg = op === '()' && args[0] === '__keys_ro'
      // A bare-name operand of an equality/inequality comparison against a
      // STATICALLY nullish literal (`x === null`, `x != undefined`) is a
      // nullish TEST, not a value-escaping read — comparing a reference to
      // null/undefined never aliases or exposes it, the same "queried, not
      // exposed" shape as `__keys_ro`'s argument and `in`'s RHS above. This
      // is exactly the shape prepare's OWN `for…in` lowering introduces (the
      // `src == null` runtime guard ahead of `__keys_ro`, src/prepare/
      // index.js "for-in over null/undefined is a no-op") — without this, a
      // receiver used ONLY as a `[]`/for-in-lowered `__keys_ro` argument
      // still marks via THIS comparison alone.
      const nullishEqOperand = (op === '==' || op === '===' || op === '!=' || op === '!==')
        ? (nullishArm(args[1]) ? 0 : nullishArm(args[0]) ? 1 : -1) : -1
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] !== 'string') continue
        if (skip instanceof Set && skip.has(i)) continue
        if (declEq && i === 0) continue
        if (keysRoArg && i === 1) continue
        if (i === nullishEqOperand) continue
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
    // Map-value census pre-scan gate (design .work/archive/todo.md §deletion-sweep
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
    propMap: new Map(), addressTakenNames: new Set(), callSites: [], computedCallSites: [], memberCallSites: [],
    memberDispatchSites: [],
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
  for (const v of from.addressTakenNames) into.addressTakenNames.add(v)
  into.callSites.push(...from.callSites)
  into.computedCallSites.push(...from.computedCallSites)
  into.memberCallSites.push(...from.memberCallSites)
  into.memberDispatchSites.push(...from.memberDispatchSites)
}

/** Bare-name leaves of a `?:` chain over function references, the shape
 *  prepare lowers a namespace-computed access (`ns[k]`) to. Null when any
 *  arm is neither a name, a nested chain, nor the `undefined` fallback. */
const dispatchLeaves = (node, out = []) => {
  if (typeof node === 'string') { out.push(node); return out }
  if (node == null || (Array.isArray(node) && node[0] == null)) return out
  if (!Array.isArray(node) || node[0] !== '?:' || node.length !== 4) return null
  return dispatchLeaves(node[2], out) && dispatchLeaves(node[3], out)
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
    const op = node[0]
    // `f?.(x)` on a named function is the same call site as `f(x)`: the
    // callee is never nullish, so every census below treats both ops alike.
    const isCallOp = op === '()' || op === '?.()'
    observeNodeFacts(node, acc)
    if (op === 'for-in' && ctx.transform.strict) err(`strict mode: \`for (... in ...)\` is not allowed (dynamic enumeration). Pass { strict: false } to enable.`)
    if (op === '{}' && doSchema) {
      const parsed = staticObjectProps(node.slice(1))
      if (parsed) ctx.schema.register(parsed.names)
    }
    if (op === '=>') {
      for (let i = 1; i < node.length; i++) walkFacts(node[i], fullWalk, true, caller)
      return
    }
    if (fullWalk) {
      if (doSchema && op === '=' && Array.isArray(node[1]) && node[1][0] === '.') {
        const [, obj, prop] = node[1]
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
      if (isCallOp && isFuncRef(node[1], ctx.funcs.names)) {
        // Record the call site even inside an arrow body. The param-inference
        // lattice (narrow.js) must see EVERY arg a callee receives — including
        // calls made from a closure (`mfb(() => ci(2))`) — or it over-specializes:
        // seeing only the direct `ci(0)` site, intConst folds the param to 0 and
        // the closure's `ci(2)` silently loses its argument. Args evaluated in the
        // arrow's scope that the enclosing caller can't type infer as untyped →
        // poison → conservative (no specialization), which is sound.
        {
          const a = node[2]
          const argList = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
          acc.callSites.push({ callee: node[1], argList, callerFunc: caller, node })
        }
        for (let i = 2; i < node.length; i++) {
          const a = node[i]
          if (isFuncRef(a, ctx.funcs.names)) acc.addressTakenNames.add(a)
          else walkFacts(a, true, inArrow, caller)
        }
        return
      }
      // Computed-member call `TABLE[key](args)`, a candidate for
      // program-index.js's `resolveComputedSourceIds`. Stashed here and resolved
      // later by plan/index.js after buildProgramIndex runs. This walk happens
      // before the index exists, so it can only record the candidate.
      // No `return`: every existing fact this call's own subtree would
      // otherwise contribute (nameEscapes on `key`, whatever the args
      // walk marks) still runs exactly as before this branch existed —
      // purely additive, changes no other observation.
      if (isCallOp && Array.isArray(node[1]) && node[1][0] === '[]' &&
          node[1].length === 3 && typeof node[1][1] === 'string') {
        const a = node[2]
        const argList = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
        acc.computedCallSites.push({ objName: node[1][1], argList, callerFunc: caller, node })
      }
      // `.`-member call `ns.prop(args)` on a bare-name receiver: a direct-call
      // graph edge once ProgramIndex resolves the member target (the ledger's
      // Shape 8, `i32.parse(n)` to `i32$parse`). Nested receivers are left
      // out: a named function stored in a nested literal is address-taken and
      // therefore already a root. Recorded only; the index resolves it at
      // build and retires the census. Additive like the computed-member
      // branch above: no other observation changes.
      if (isCallOp && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.') &&
          typeof node[1][1] === 'string' && typeof node[1][2] === 'string')
        acc.memberCallSites.push({ objName: node[1][1], prop: node[1][2], callerFunc: caller })
      // Member call on a `?:` chain over function references, `ns[k].prop(args)`
      // after prepare lowers the namespace access. Emission devirtualizes it
      // per arm, so each arm's member target is a real direct call: the index
      // synthesizes one call site per resolved arm (synthesizeMemberDispatch-
      // CallSites), feeding both the graph and the parameter lattice.
      if (isCallOp && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.') &&
          Array.isArray(node[1][1]) && node[1][1][0] === '?:' && typeof node[1][2] === 'string') {
        const leaves = dispatchLeaves(node[1][1])
        if (leaves && leaves.length) {
          const a = node[2]
          const argList = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
          acc.memberDispatchSites.push({ leaves, prop: node[1][2], argList, callerFunc: caller, node })
        }
      }
      if ((op === '.' || op === '?.') && isFuncRef(node[1], ctx.funcs.names)) return
      if (op === 'let' || op === 'const') {
        for (let i = 1; i < node.length; i++) {
          const decl = node[i]
          if (Array.isArray(decl) && decl[0] === '=' && decl.length >= 3) {
            // nameEscapes: this branch hand-walks the decl's parts (addressTakenNames +
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
              if (isFuncLit || caller?.name !== name) acc.addressTakenNames.add(name)
            }
            // A bare func-ref RHS (`let c = taylor` — the fn-attached-memo idiom)
            // is a VALUE use: resolveClosureWidth must size the uniform ABI to the
            // referenced function's full arity, or its boundary trampoline forwards
            // $__a{k} slots it never declared. Mirrors the '=' handler below.
            if (isFuncRef(decl[2], ctx.funcs.names)) acc.addressTakenNames.add(decl[2])
            else walkFacts(decl[2], true, inArrow, caller)
          } else walkFacts(decl, true, inArrow, caller)
        }
        return
      }
      if (op === '=' && node.length >= 3) {
        // RHS may be a bare function reference (`store[0] = pick3`) — record it as a
        // value use so resolveClosureWidth sizes the closure ABI to its arity. Matches
        // the func-ref handling in the call/let/general cases below.
        if (isFuncRef(node[2], ctx.funcs.names)) acc.addressTakenNames.add(node[2])
        else walkFacts(node[2], true, inArrow, caller)
        return
      }
      for (let i = 1; i < node.length; i++) {
        const child = node[i]
        if (isFuncRef(child, ctx.funcs.names)) acc.addressTakenNames.add(child)
        else walkFacts(child, true, inArrow, caller)
      }
    } else {
      for (let i = 1; i < node.length; i++) walkFacts(node[i], false, inArrow, caller)
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
    // Default-parameter expressions evaluate inside the function on every call
    // that omits the argument, so their calls, escapes, and literals are the
    // function's own facts. They live outside `body` (prepare keeps them in
    // `defaults`), so the body walk above never reaches them: subscript's
    // `dispatch = (ops, tail, fn = (a, …) => { … loc(r, from) … }) => …`
    // kept `loc` reachable only through this default.
    if (func.defaults && !func.raw)
      for (const expr of Object.values(func.defaults)) mergeWalkFacts(f, walkFactsRoot(expr, true, func, doSchema, false))
  }
  const { propMap, addressTakenNames, callSites } = f
  // Bundled sub-module inits live OUTSIDE `ast` (ctx.module.moduleInits — the
  // main walk never sees them) and prepare's recordModuleInitFacts collects a
  // REDUCED set with no call sites. But init code is a first-class CALLER:
  // const tables of arrows (watr's FOLD/FOLD2) call helpers with args visible
  // only here, and without these sites the param lattice settles callees
  // blind — _i64Arith.r never proved BIGINT, _i64Hex16's radix-toString
  // misformatted raw i64 bits (the speed-tier lab throw), and
  // the later reachability filter culled both as dead code. Collect ONLY '()' sites
  // (callerFunc = null — module scope; narrow's callerCtx already carries a
  // null entry and ProgramIndex keeps null-caller sites and marks
  // their callees live). Everything else stays on the reduced initFacts
  // path: a full walkFactsRoot here would re-register schemas and promote
  // init-stored func REFS into addressTakenNames, a program-wide dispatch behavior
  // change this census repair must not smuggle in.
  const initCallSites = (node) => walkAst(node, { enter: node => {
    const isCallOp = node[0] === '()' || node[0] === '?.()'
    if (isCallOp && isFuncRef(node[1], ctx.funcs.names)) {
      const a = node[2]
      const argList = a == null ? [] : (Array.isArray(a) && a[0] === ',') ? a.slice(1) : [a]
      f.callSites.push({ callee: node[1], argList, callerFunc: null, node })
    }
    if (isCallOp && Array.isArray(node[1]) && (node[1][0] === '.' || node[1][0] === '?.') &&
        typeof node[1][1] === 'string' && typeof node[1][2] === 'string')
      f.memberCallSites.push({ objName: node[1][1], prop: node[1][2], callerFunc: null })
    // A function reference stored by a module-init write (`const asi = parse.asi
    // = fn`, `loc = fn`) is live through that binding, so the target is a
    // reachability root. This is a root only: the reduced init census keeps
    // such refs out of addressTakenNames on purpose (see above), and this
    // must not change dispatch or coverage.
    if (node[0] === '=' && isFuncRef(node[2], ctx.funcs.names))
      f.memberCallSites.push({ callee: node[2], callerFunc: null })
  } })
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
  // (design .work/archive/todo.md §deletion-sweep §1) rides the SAME
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
    dynVars: f.dynVars, dynWriteVars: f.dynWriteVars, anyDyn: f.anyDyn, propMap, addressTakenNames, callSites,
    computedCallSites: f.computedCallSites,
    memberCallSites: f.memberCallSites,
    memberDispatchSites: f.memberDispatchSites,
    maxDef: f.maxDef, maxCall: f.maxCall, hasRest: f.hasRest, hasSpread: f.hasSpread,
    paramReps, hasSchemaLiterals: f.hasSchemaLiterals, hasMapSet: f.hasMapSet,
    hasBigint: f.hasBigint, writtenProps: f.writtenProps,
    literalWriteKeys: f.literalWriteKeys,
    arrResized: f.arrResized, nameEscapes: f.nameEscapes, literalObjectVars,
  }
}

/** For each stashed computed-member call candidate (`TABLE[key](args)`,
 *  `programFacts.computedCallSites`, collected above during the same walk
 *  as `callSites`), resolve `TABLE` through ProgramIndex and, when it proves
 *  closed, synthesize call-site observations into `programFacts.callSites`.
 *  Param narrowing then sees the same arguments a bare-name call would.
 *  This runs while ProgramIndex is still local to plan(), before its direct
 *  call graph is finalized and before narrowSignatures reads call sites.
 *
 *  Two resolved-member shapes, per program-index.js's `foldWrite`:
 *   - a same-module named function (`resolveMemberSourceId`'s own shape, e.g. an
 *     `ns.parse = parseNum`-style property): synthesized DIRECTLY, one call
 *     site per outer site, reusing that site's own `argList` verbatim — the
 *     member function receives exactly what a bare-name call to it would.
 *   - an inline arrow literal (watr's actual `HANDLER` shape — every
 *     property an arrow, none a reference to a pre-existing declared
 *     function): the arrow itself has no paramReps identity to feed
 *     (prepare.js never lifts an object-literal property's arrow into a
 *     named function — verified empirically, see the notes above), so this
 *     reaches one hop further: walks the arrow's OWN direct body (never
 *     descending into a nested `=>` for DISCOVERING calls, the same scope
 *     boundary every other closure-aware walk in this file and
 *     program-index.js already draws) for calls to real, named functions,
 *     substitutes the arrow's OWN formal parameters with the outer site's
 *     actual argument expressions wherever they textually occur (plain,
 *     referentially-transparent AST rewriting — no evaluation, so it's
 *     sound regardless of side effects), and synthesizes ONE call site per
 *     such inner call — ALWAYS, per POSITION, never declining the whole
 *     call over one unresolvable sibling argument. An argument the arrow
 *     itself computes (a body-local from a destructuring/`.shift()`
 *     extraction, e.g. HANDLER.stringidx's `idx`) has no substitution
 *     entry and is left as its own arrow-local name verbatim — sound, not
 *     just "forfeit precision," because of a whole-pipeline invariant:
 *     prepare/index.js's `mintLocal` (its own doc: "BindingId totality:
 *     every function-local binding renames to the module-wide-unique
 *     `name<T>f<fnId>_<serial>`") guarantees this leftover name can never
 *     collide with any OTHER binding anywhere in the module, so every
 *     name-keyed lookup this call site's `callerFunc` (a real, unrelated
 *     function — e.g. `instr`, not the arrow) is later checked against
 *     (narrow.js's `inferValAtSite`'s `callerValTypes`/`callerParamFacts`
 *     lookups, inplace-store.js's `callSiteElemInfo`) misses cleanly and
 *     falls back to its own conservative "unproven" default — the same
 *     outcome a normal, non-synthesized unresolvable argument already
 *     produces everywhere else in this codebase, never a fabricated claim.
 *     A SIBLING argument at the same call that substitutes cleanly (e.g.
 *     the forwarded `out`/`buffer` position) is completely unaffected by
 *     an unresolvable neighbor: narrow.js's `applySiteRules` folds each
 *     parameter POSITION independently (one `rule.apply` per `k`), so this
 *     is strictly more precise than an all-or-nothing decline without
 *     being any less sound.
 *
 *  Every synthesized site is tagged `synthetic: true` and may reuse an AST
 *  node another synthesized site (same inner call reached from a different
 *  outer caller, or the SAME outer computed-dispatch node for two different
 *  resolved members) already points at — `.node` here exists only so the
 *  census's own read-only consumers (evidenceOfArg, containment checks) can
 *  use it exactly like a real site's; nothing may ever WRITE through it.
 *  variant.js's `materializeVariant` (the one place a call edge gets
 *  retargeted — `site.node[1] = cloneName`) and plan/inline.js's
 *  `specializeFixedRestCalls` (the one place `setCallArgs` rewrites a call
 *  node's own arguments) both skip `synthetic` sites for exactly this
 *  reason — see their own comments at the skip. */
export function synthesizeComputedDispatchCallSites(programFacts, programIndex) {
  const resolveComputedSourceIds = programIndex?.resolveComputedSourceIds
  if (!resolveComputedSourceIds || !programFacts.computedCallSites.length) return

  // Does `node` contain a bare-string reference to any name in `names`,
  // anywhere — INCLUDING inside a further-nested `=>` (a captured reference
  // inside a callback ARGUMENT is still a live use at the moment this call
  // executes). Runs only over one already-small inner-call argument
  // subtree, never a whole function body.
  const mentionsAny = (node, names) => {
    if (typeof node === 'string') return names.has(node)
    if (!Array.isArray(node)) return false
    for (let i = 1; i < node.length; i++) if (mentionsAny(node[i], names)) return true
    return false
  }
  // Substitute every bare-string occurrence of a mapped param name with its
  // outer-site argument expression, recursing everywhere (including nested
  // `=>` bodies, for the same reason mentionsAny does). Pure — returns a
  // NEW node when anything changed, never mutates `node` itself: the
  // original AST is still the live tree emission compiles from.
  const substitute = (node, subst) => {
    if (typeof node === 'string') return subst.has(node) ? subst.get(node) : node
    if (!Array.isArray(node)) return node
    let changed = false
    const out = new Array(node.length)
    out[0] = node[0]
    for (let i = 1; i < node.length; i++) {
      const c = substitute(node[i], subst)
      if (c !== node[i]) changed = true
      out[i] = c
    }
    return changed ? out : node
  }

  // Does calling `calleeName` with only `argc` arguments leave one of ITS
  // OWN trailing params both unsupplied AND undefault-able? `narrow.js`'s
  // `missing()` rule (mergeRule) treats that shape as a DEFINITIVE fact —
  // "this exact call always hands the callee `undefined` here" — and
  // poisons `val` for it UNCONDITIONALLY, in EVERY fixpoint pass including
  // the soft ones (unlike an ordinary unresolvable-VALUE observation, which
  // the soft pass safely no-ops on and a later re-visit can still heal).
  // That poison is real and correct when this shape is the program's own
  // TRUE, permanent behavior (an ordinary same-arity-shortfall call site
  // elsewhere in the program pays the identical price) — but synthesizing
  // ONE MORE such site here would only ever GUARANTEE that permanent
  // poison, with no possible upside for the position it poisons, so
  // there's nothing to gain by including it: any OTHER position the same
  // inner call would have proven is still provable from its next-cleanest
  // source (a real member forwarding the same callee's SAME position with
  // a full argument list), while this position was never going to resolve
  // to anything but null regardless — declining the WHOLE call is strictly
  // no worse than synthesizing it, every time this shape is detected.
  const calleeArityShortfalls = (calleeName, argc) => {
    const fn = ctx.funcs.map.get(calleeName)
    const params = fn?.sig?.params
    if (!params || argc >= params.length) return false
    // A REST param left unsupplied is a real default too — an empty array,
    // never `undefined` — so it never triggers narrow.js's own `missing()`
    // poison in the first place; only checked here to keep this function's
    // own verdict consistent with that (a redundant-safe skip either way).
    const restIdx = fn.rest ? params.length - 1 : -1
    for (let i = argc; i < params.length; i++)
      if (i !== restIdx && fn.defaults?.[params[i].name] == null) return true
    return false
  }

  // A resolved arrow member's body was ALREADY reached once before, by the
  // ordinary call-site walker (collectProgramFacts's own walkFacts, which
  // descends into every object-literal property value including an inline
  // arrow because ProgramIndex does not exist during that first walk
  // to tell it this arrow is a table member). Any `NAMED_FUNC(...)` call
  // inside that arrow body it found is ALREADY sitting in
  // `programFacts.callSites`, but attributed `callerFunc: null` (module
  // scope — the arrow itself has no identity) with its RAW, unsubstituted
  // arg names — e.g. the arrow's own `out`, which is not a module global
  // and not resolvable under a null caller. That raw entry can never
  // contribute anything but an unresolvable (null) observation — under the
  // SOFT mid-fixpoint rule it's a harmless skip, but the FINAL hard-settle
  // sweep (narrow.js "Settle val HARD") re-visits it and POISONS on the
  // first null it sees, on this exact call, EVERY TIME — permanently
  // undoing whatever this synthesis just proved with the properly-
  // substituted version below, regardless of how sound that version is.
  // Every inner-call node this pass visits is tracked here so the raw twin
  // can be dropped afterward — never leave both a correct and a
  // permanently-poisoning observation of the SAME call site's OWN node
  // standing side by side.
  const claimedNodes = new Set()

  for (const site of programFacts.computedCallSites) {
    const members = resolveComputedSourceIds(site.objName)
    if (!members) continue
    for (const member of members) {
      if (!Array.isArray(member)) {
        const memberFunc = programIndex.sourceFunctionById(member)
        if (!memberFunc) continue
        // Named-function member: has its own real paramReps identity —
        // synthesize directly, the outer site's argList unchanged, exactly
        // like an ordinary bare-name call would. Nothing to claim: the
        // OUTER computed-dispatch call itself was never registered by the
        // ordinary walker (isFuncRef declines a computed callee), so there
        // is no raw twin of THIS site to remove.
        programFacts.callSites.push({
          callee: memberFunc.name, argList: site.argList, callerFunc: site.callerFunc, node: site.node, synthetic: true,
        })
        continue
      }
      // Inline-arrow member: no identity of its own — reach one hop
      // further, into calls the arrow's OWN body makes to real functions.
      const arrowParams = extractParams(member[1])
      const subst = new Map()
      // Params THIS outer site simply doesn't supply (site.argList shorter
      // than the arrow's own arity — e.g. watr's `for (const k in HANDLER)
      // SIZE_HANDLER[k] = (n,c,op) => HANDLER[k](n,c,op).length` idiom,
      // calling every member with only 3 args) are genuinely, provably
      // `undefined` at THIS call — not "unknown," which is a different,
      // weaker fact. Forwarding the bare param name onward would misrepresent
      // "definitely absent here" as "an opaque unresolvable expression,"
      // and since narrow.js's `possibleKinds` join treats every `v==null`
      // observation as "join the full universe" REGARDLESS of which of the
      // two it actually was, the practical effect is identical either way —
      // so there is nothing to gain from modeling it more precisely, only a
      // real cost: a genuinely-supplied SIBLING call (the same member
      // reached via an outer site that DOES pass every argument, e.g.
      // `instr`'s own `HANDLER[imm](nodes, ctx, op, out)`) would have its
      // OWN clean observation permanently swamped by this unrelated site's
      // forced full-universe join, the moment both feed the same callee's
      // same parameter position. Declining ONLY the inner calls that
      // mention one of these specifically-unsuppliable names (never the
      // whole outer site, never a call that only touches an in-range
      // param) keeps every other position — including a body-local the
      // arrow computes at runtime (`let t = n.shift()`), which unlike an
      // out-of-range param really is supplied, just not statically known,
      // and safely resolves to the same conservative "unknown" outcome via
      // ordinary lookup-miss, no special-casing needed (see the doc above).
      const unsuppliable = new Set()
      for (let i = 0; i < arrowParams.length; i++) {
        const p = arrowParams[i]
        const name = typeof p === 'string' ? p : classifyParam(p)[PARAM_NAME]
        if (typeof name !== 'string') continue
        if (i < site.argList.length) subst.set(name, site.argList[i])
        else unsuppliable.add(name)
      }
      // One inner call resolved to `callee`: always a call-graph edge (the
      // call is real whatever its arity), and a lattice site only under the
      // same unsuppliable-param and arity gates as before.
      const innerSite = (n, callee) => {
        programFacts.memberCallSites.push({ callee, callerFunc: site.callerFunc })
        const innerArgList = commaList(n[2]).map(a => substitute(a, subst))
        const ok = (!unsuppliable.size || innerArgList.every(a => !mentionsAny(a, unsuppliable))) &&
          !calleeArityShortfalls(callee, innerArgList.length)
        if (ok)
          programFacts.callSites.push({
            callee, argList: innerArgList, callerFunc: site.callerFunc, node: n, synthetic: true,
          })
      }
      const walkInner = (n) => {
        if (!Array.isArray(n)) return
        if (n[0] === '=>') return   // never descend into a deeper closure for DISCOVERY — same boundary as everywhere else
        const isCallOp = n[0] === '()' || n[0] === '?.()'
        if (isCallOp && isFuncRef(n[1], ctx.funcs.names)) {
          claimedNodes.add(n)
          innerSite(n, n[1])
        } else if (isCallOp && Array.isArray(n[1])) {
          // A namespace-computed access prepare lowered to a `?:` chain over
          // function references (`encode[t](...)`), or a member call on such a
          // chain (`encode[t].parse(...)`): emission devirtualizes per arm,
          // so each arm is a direct inner call of its own. The ordinary
          // walker registers neither form, so nothing is claimed.
          const callee = n[1]
          const leaves = callee[0] === '?:' ? dispatchLeaves(callee)
            : (callee[0] === '.' || callee[0] === '?.') && Array.isArray(callee[1]) && callee[1][0] === '?:' &&
              typeof callee[2] === 'string' ? dispatchLeaves(callee[1]) : null
          if (leaves) for (const leaf of leaves) {
            if (callee[0] === '?:') { if (ctx.funcs.names.has(leaf)) innerSite(n, leaf); continue }
            const targetId = programIndex.resolveMemberSourceId(leaf, callee[2])
            const target = targetId >= 0 ? programIndex.sourceFunctionById(targetId) : null
            if (target) innerSite(n, target.name)
          }
        }
        for (let i = 1; i < n.length; i++) walkInner(n[i])
      }
      walkInner(member[2])
    }
  }

  if (claimedNodes.size)
    programFacts.callSites = programFacts.callSites.filter(cs => cs.synthetic || !claimedNodes.has(cs.node))
}

/** Member calls on a `?:` chain over function references (`ns[k].prop(args)`
 *  after prepare lowers the namespace access): one synthetic direct call
 *  site per arm whose member target resolves, exactly the calls emission
 *  devirtualizes to. The census is consumed here once and its key retired. */
export function synthesizeMemberDispatchCallSites(programFacts, programIndex) {
  const resolveMemberSourceId = programIndex?.resolveMemberSourceId
  if (resolveMemberSourceId) for (const site of programFacts.memberDispatchSites || []) {
    for (const leaf of site.leaves) {
      const targetId = resolveMemberSourceId(leaf, site.prop)
      if (targetId < 0) continue
      const target = programIndex.sourceFunctionById(targetId)
      if (!target) continue
      programFacts.callSites.push({
        callee: target.name, argList: site.argList, callerFunc: site.callerFunc, node: site.node, synthetic: true,
      })
    }
  }
  const retiredMemberDispatchKey = 'memberDispatchSites'
  delete programFacts[retiredMemberDispatchKey]
}
