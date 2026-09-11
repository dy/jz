/** Project settled value and presence facts; derive physical storage constraints. */
import { DBG_INVARIANTS } from '../../debug.js'
import { OPTF, ctx } from '../../ctx.js'
import { ASSIGN_OPS, MUTATE_OPS } from '../../ast.js'
import { VAL, repOf, updateRep } from '../../reps.js'
import { valTypeOf, shapeOf } from '../../kind.js'
import { intExprRange, objLiteralSchemaId } from '../../static.js'
import { isCondExpr, intCertainMap } from '../../type.js'
import { makeTypedTracker } from './trackers.js'
import { analyzeBody } from './body-facts.js'
import { K, tagOf, hasTag, valOf, core, ANY } from '../../summary/kind.js'

/** True iff `name` appears in `body` ONLY as the receiver of an indexed read
 *  `name[k]` (the lean-dict idiom) — a bare reference, a `.`-target, or any
 *  other position disqualifies. ITERATIVE (explicit worklist) by necessity:
 *  the original nested self-recursive closure (`verify` capturing `name` +
 *  `body`) MISCOMPILED under the self-compiled kernel into non-termination —
 *  the `h[dk]=v` dict idiom sent the dist kernel leg red (bisected to
 *  83d6add5's analyze.js additions; a depth cap and a `seen` identity-guard
 *  both failed, so the divergence is in the kernel's closure-call ABI, below
 *  JS control flow — a worklist sidesteps the fragile construct entirely).
 *  The kernel two-level-capture-recursion miscompile is ledgered for its own
 *  dissection. Module-scope so no capture, no recursion. */
function dictWalkLean(body, name) {
  const stack = [body]
  let plainRead = false
  while (stack.length) {
    const n = stack.pop()
    if (typeof n === 'string') { if (n === name) return false; continue }
    if (!Array.isArray(n)) continue
    const op = n[0]
    if (op === '=>' || op === 'str') continue
    // WRITE/RMW target `name[k] (op)= v`: the ephemeral-slot upsert serves it.
    // Inside the RHS, the RMW's OWN read (structurally equal to the target —
    // emit-assign's _rmwStructEq fuses exactly that) is part of the same slot
    // op; any OTHER same-name `[]` in the RHS is a plain read → reject below.
    if (ASSIGN_OPS.has(op) && Array.isArray(n[1]) && n[1][0] === '[]' && n[1][1] === name) {
      const tgt = JSON.stringify(n[1])
      if (n[1][2] != null) stack.push(n[1][2])
      const pushSkippingFused = (m) => {
        if (!Array.isArray(m)) { stack.push(m); return }
        if (m[0] === '[]' && m[1] === name && JSON.stringify(m) === tgt) { if (m[2] != null) stack.push(m[2]); return }
        if (m[0] === '[]' && m[1] === name) { stack.push(m); return }   // plain read — rejected by the arm below
        for (let i = 1; i < m.length; i++) pushSkippingFused(m[i])
      }
      for (let i = 2; i < n.length; i++) pushSkippingFused(n[i])
      continue
    }
    // PLAIN READ of the dict: the lean/ephemeral write layout is only sound to
    // read back when the read tolerates a fresh/zero slot — i.e. when EVERY
    // read is immediately bitwise-coerced (the i32-dict rule: missing → 0 is
    // the documented ToInt32 semantics). An uncoerced read (`d[k] === undefined`,
    // `d[k] <= 5`) against eph-written memory got garbage in-bounds or walked
    // OOB (the loop-built-dict trap class). Flag it; the final verdict defers
    // to dictWalkI32, which validates the every-read-coerced property.
    if (op === '[]' && n[1] === name) { plainRead = true; if (n[2] != null) stack.push(n[2]); continue }
    if ((op === ':' || op === '.' || op === '?.') && n.length >= 3) { stack.push(n[op === ':' ? 2 : 1]); continue }
    // let/const: the decl values; every other op: all children.
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (op === 'let' || op === 'const') {
        if (Array.isArray(c) && c[0] === '=') { if (c[2] != null) stack.push(c[2]) }
        else stack.push(c)
      } else stack.push(c)
    }
  }
  return !plainRead || dictWalkI32(body, name)
}

const I32_DICT_BITWISE = new Set(['&', '|', '^', '<<', '>>', '>>>'])
/** Count/histogram dict test: `name` used only as `name[k]`, every READ
 *  immediately bitwise-coerced and every WRITE a discarded statement (so the
 *  slot may keep only ToInt32 bits). ITERATIVE for the same reason as
 *  dictWalkLean — the original nested self-recursive `walk` (four captured
 *  params + mutated outer state) is the exact shape the self-compiled kernel
 *  miscompiled into non-termination (bisected culprit of the 83d6add5
 *  kernel-leg red). Module-scope, worklist of (node,parent,pos,grand). */
function dictWalkI32(body, name) {
  let reads = 0, writes = 0
  const stack = [[body, null, -1, null]]
  while (stack.length) {
    const [n, parent, pos, grand] = stack.pop()
    if (!Array.isArray(n) || n[0] === '=>') continue
    if (n[0] === '[]' && n[1] === name) {
      if (parent && ASSIGN_OPS.has(parent[0]) && pos === 1) {
        writes++
        // Only an expression statement discards the value; in a
        // condition/update replacing the boxed result with ToInt32 is observable.
        if (!(grand && (grand[0] === ';' || grand[0] === '{}'))) return false
      } else {
        reads++
        if (!(parent && I32_DICT_BITWISE.has(parent[0]))) return false
      }
      if (n[2] != null) stack.push([n[2], n, 2, parent])
      continue
    }
    for (let i = 1; i < n.length; i++) stack.push([n[i], n, i, parent])
  }
  return reads > 0 && writes > 0
}

/** Preallocation-hint domain for a computed-key dict `name`: the single array
 *  `dom` such that every `name[k] = …` uses a key `k = dom[i]` (a missed/wrong
 *  alias only costs a resize, never semantics). ITERATIVE for the same reason
 *  as dictWalkLean/dictWalkI32 — the original TWO nested self-recursive
 *  closures (`collect`, `scan`, both capturing outer state) are the kernel-
 *  fragile shape (83d6add5 leg red). Module-scope, two worklist passes. */
function dictDomainOf(body, name) {
  // Pass 1: single-def `let/const x = value` map (clashing names dropped).
  const defs = new Map(), clashes = new Set()
  let stack = [body]
  while (stack.length) {
    const n = stack.pop()
    if (!Array.isArray(n) || n[0] === '=>') continue
    if (n[0] === 'let' || n[0] === 'const') for (let i = 1; i < n.length; i++) {
      const d = n[i]
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
        if (defs.has(d[1])) clashes.add(d[1]); else defs.set(d[1], d[2])
      }
    }
    for (let i = 1; i < n.length; i++) stack.push(n[i])
  }
  for (const n of clashes) defs.delete(n)
  const sourceOf = (idx) => {
    const e = typeof idx === 'string' ? defs.get(idx) : idx
    return Array.isArray(e) && e[0] === '[]' && typeof e[1] === 'string' ? e[1] : null
  }
  // Pass 2: every `name[k] = …` must draw k from one shared domain array.
  let domain = null, bad = false, writes = 0
  stack = [body]
  while (stack.length) {
    const n = stack.pop()
    if (!Array.isArray(n) || n[0] === '=>') continue
    if (ASSIGN_OPS.has(n[0]) && Array.isArray(n[1]) && n[1][0] === '[]' && n[1][1] === name) {
      writes++
      const dom = sourceOf(n[1][2])
      if (!dom || (domain && domain !== dom)) bad = true
      else domain = dom
    }
    for (let i = 1; i < n.length; i++) stack.push(n[i])
  }
  return writes && !bad ? domain : null
}

/**
 * Analyze all local value types from declarations and assignments.
 * Writes the per-name `val` field of `ctx.func.localReps` for method dispatch
 * and schema resolution.
 */
export function analyzeValTypes(body) {
  const summary = ctx.summary?.at(body)
  const setVal = name => {
    const k = summary?.kindOf(name) || ANY
    const nullable = hasTag(k, K.ABSENT) || hasTag(k, K.NULLISH)
    updateRep(name, {
      val: valOf(k) ?? (!hasTag(k, K.NULLISH) && tagOf(core(k)) !== K.BIGINT ? valOf(core(k)) : undefined),
      presentVal: nullable ? valOf(core(k)) ?? undefined : undefined,
      nullable, mayBeUndefined: nullable,
      presence: nullable ? 'maybe-undef' : 'present',
    })
  }
  const getVal = name => ctx.func.localReps?.get(name)?.val
  // Pre-walk: observe Array<schema> facts so `const p = arr[i]` can bind a schemaId
  // on `p`, unlocking schema slot reads + skipping str_key dispatch on `.prop` access.
  // The element kind, holes and typed constructor are the program summary's
  // cell, read by analyzeBody at each array's declaration: rep.arrayElemValType
  // lets valTypeOf's `arr[i]` rule elide __to_num and route method dispatch on
  // `arr[i].method()`; an unwritten slot of `Array(n)` is a hole reading
  // undefined, a NaN through every numeric path (`arrayHoles`: toNumF64
  // canonicalizes it, an identity compare stays live); an array of typed
  // arrays names their ctor so `arr[i][j]` / `let o = arr[i]; o[j]` inline.
  const facts = analyzeBody(body)
  const arrElems = facts.arrElemSchemas
  for (const [name, vt] of facts.arrElemValTypes) {
    if (vt != null) updateRep(name, { arrayElemValType: vt })
  }
  for (const name of facts.arrayHoles) updateRep(name, { arrayHoles: true })
  for (const [name, ctor] of facts.arrElemTypedCtors) {
    if (ctor != null) updateRep(name, { arrayElemTypedCtor: ctor })
  }
  // Propagate body-observed array-elem schemas to localReps so unboxablePtrs's
  // `let p = arr[i]` rule (which only consults rep) sees the schema and can unbox `p`
  // to an i32 offset. Without this, `arr.push({x,y,z})` followed by `arr[i].x` reads
  // pay an i64.reinterpret/i32.wrap on every slot access (no aliasing → CSE can't fold).
  for (const [name, sid] of arrElems) {
    if (sid != null) updateRep(name, { arrayElemSchema: sid })
  }
  // Closed heterogeneous unions (≥2 sids, no unknown source) ride to reps the
  // same way — size-1 sets are exactly the singular fact and stay off the rep.
  for (const [name, set] of facts.arrElemSchemaSets || []) {
    if (set != null && set.size >= 2) updateRep(name, { arrayElemSchemaSet: [...set].sort((a, b) => a - b) })
  }
  // Resolve a name's array-elem-schema, preferring rep.arrayElemSchema (set from
  // paramReps[k].arrayElemSchema at emit start) over local body observations.
  const arrElemSchemaOf = (name) => {
    if (typeof name !== 'string') return null
    const repSid = ctx.func.localReps?.get(name)?.arrayElemSchema
    if (repSid != null) return repSid
    const localSid = arrElems.get(name)
    return localSid != null ? localSid : null
  }
  // Set sibling of arrElemSchemaOf — rep channel first (param-carried unions).
  const arrElemSchemaSetOf = (name) => {
    if (typeof name !== 'string') return null
    const repSet = ctx.func.localReps?.get(name)?.arrayElemSchemaSet
    if (repSet != null) return repSet
    const s = facts.arrElemSchemaSets?.get(name)
    return s != null && s.size >= 2 ? [...s].sort((a, b) => a - b) : null
  }
  function trackRegex(name, rhs) {
    if (ctx.runtime.regex && Array.isArray(rhs) && rhs[0] === '//') ctx.runtime.regex.vars.set(name, rhs)
  }
  // ctx.func.typedElem slice (lazily created on first write, as before — readers
  // tolerate null). Disagreeing decls poison the name (jz hoists `let` to function
  // scope, so sibling-scope decls share a name and must not lock in a wrong width).
  const trackTyped = makeTypedTracker(
    (n) => ctx.func.typedElem?.get(n),
    (n, c) => (ctx.func.typedElem ??= new Map()).set(n, c),
    (n) => ctx.func.typedElem?.delete(n),
    (n) => ctx.func.typedLen?.get(n),
    (n, l) => (ctx.func.typedLen ??= new Map()).set(n, l),
    (n) => ctx.func.typedLen?.delete(n),
  )
  // Total write count for `name` across the whole body, recursing into nested
  // closures so a closure that reassigns the var is also counted. Capped at 2 —
  // callers only need the "exactly one write" verdict.
  function writeCount(node, name, n) {
    if (n > 1 || !Array.isArray(node)) return n
    const o = node[0]
    if (MUTATE_OPS.has(o) && node[1] === name) n++
    if (o === 'let' || o === 'const') {
      for (let i = 1; i < node.length && n <= 1; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && d[2] != null) n = writeCount(d[2], name, n)
      }
      return n
    }
    for (let i = 1; i < node.length && n <= 1; i++) n = writeCount(node[i], name, n)
    return n
  }
  // Bind an object-literal's schemaId onto its holding local's rep so that
  // `o.prop` / `o.method()` dispatch is precise instead of falling back to
  // structural subtyping (which mis-resolves when another in-scope object
  // shares a member at a different slot). `shapeOf` already covers plain-data
  // literals on a direct `let o = {…}` decl, but not literals with
  // function-valued props — and `var o = {…}` is rewritten by jzify into
  // `let o; o = {…}`, so the schemaId never reaches `o` either way.
  // `expectWrites` is the reassignment count that marks `o` single-assignment:
  // 1 for the jzify `=` form (the synthesized assignment IS the only write),
  // 0 for a direct `let`/`const` decl (the initializer is not counted as a
  // write). A polymorphically reassigned holder keeps dynamic dispatch.
  // A name already in `ctx.schema.vars` carries a prepare-phase schema
  // (Object.assign merge via `inferAssignSchema`, destructure tracking) that
  // supersedes the bare-literal one — binding here would shadow the merged
  // schema (rep schemaId wins over `ctx.schema.vars` in `idOf`).
  function bindObjSchema(name, rhs, expectWrites = 1) {
    if (ctx.func.current?.params?.some(p => p.name === name)) return
    if (ctx.schema.vars?.has(name)) return
    const sid = objLiteralSchemaId(rhs)
    if (sid != null && writeCount(body, name, 0) === expectWrites) updateRep(name, { schemaId: sid })
  }
  // Non-escaping computed-key dictionary: every use of `name` is exactly the
  // receiver of `name[key]` (read or write), apart from its declaration. Such
  // a fresh HASH never deletes/enumerates/escapes, so its upsert may use the
  // lean no-tombstone/no-order/no-durable-log probe.
  const leanDictUse = (name) => dictWalkLean(body, name)
  // Count/histogram dictionaries: if every read is immediately bitwise-
  // coerced and every write is a statement, the slot may retain only the
  // observable ToInt32 bits. Missing `undefined|0` and a zero slot are equal.
  const i32DictUse = (name) => dictWalkI32(body, name)
  // Upper bound on distinct keys: `const k = domain[index]; dict[k] = …`
  // cannot insert more unique keys than domain.length. Capacity planning uses
  // this only as a preallocation hint (the table still grows), so a missed
  // alias costs speed while an over/underestimate cannot affect semantics.
  const dictDomain = (name) => dictDomainOf(body, name)
  function walk(node, cond) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return  // don't leak inner-closure val types
    // Collect Object.assign(name, …) sites for the post-walk boxed-schema
    // predictor (slice-4 P3) — decided AFTER the walk so the target's FINAL
    // val kind matches what emit reads.
    if (op === '()' && node[1] === 'Object.assign') {
      let aa = node.slice(2)
      if (aa.length === 1 && Array.isArray(aa[0]) && aa[0][0] === ',') aa = aa[0].slice(1)
      if (typeof aa[0] === 'string' && aa.length > 1)
        objAssignSites.push({ target: aa[0], sources: aa.slice(1) })
    }
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const a = node[i]
        if (!Array.isArray(a) || a[0] !== '=' || typeof a[1] !== 'string') continue
        // A direct empty-object initializer with property writes but no
        // materialized schema is represented as HASH by object.js. Stamp the
        // same kind before emission so allocation, reads, and writes agree.
        const merged = ctx.schema.resolve?.(a[1])
        const emptyLit = Array.isArray(a[2]) && a[2][0] === '{}' && a[2].length === 1
        const hasPropertyWrites = ctx.types.dynWriteVars?.has(a[1]) || ctx.types.literalWriteKeys?.get(a[1])?.size
        const dict = emptyLit && hasPropertyWrites && !merged?.length
        // INVARIANT: a truly EMPTY `{}` still binds a real (0-prop) schema
        // decl — prepare/index.js's own decl-schema tracking (the props.length
        // guard right next to the non-empty-literal case this mirrors) only
        // ever bound a NON-empty literal's schema; module/core.js's
        // isClosedObjNoStringMethod (`new Error(o).message` for a bound
        // object) needs a resolvable schema to prove a truly-empty `o`
        // closed, same as it already can for `{x:1}`. Bound HERE, not in
        // prepare, and ONLY for the non-dict arm: `dict` (computed above from
        // the whole-program dynamic and literal write censuses, which this
        // single-pass walk cannot derive) is the fact that must gate whether
        // this schema is minted AT ALL — not just whether it's bound to this
        // name. Minting an unused schema for a dict-mode binding (one that
        // NEVER reads it — HASH mode bypasses schema dispatch entirely, and
        // errorMessageIR's own separate VAL.HASH arm covers ITS Error-message
        // case) still changes `ctx.schema.list`'s size, which is enough to
        // flip a shared codegen branch in module/collection.js's
        // $__dyn_get_t_h — reopening the exact PRE-EXISTING, host-dependent
        // watr-fold divergence test/kernel-parity.js's "dict|2 + dict|3" note
        // already documents (confirmed live: binding unconditionally, even
        // via prepare, reproduced it; skipping the dict arm here does not).
        // `merged == null` (not just "no schema yet"): if prepare's own
        // assignment-schema tracking already bound (or poisoned) this name
        // from a LATER reassignment (`o = {x:1}`), that fact was decided with
        // MORE information than a bare `{}` decl carries — never overwrite it.
        if (!dict && emptyLit && merged == null && ctx.schema.register && !ctx.schema.poisoned?.has(a[1]))
          updateRep(a[1], { schemaId: ctx.schema.register([]) })
        const vt = dict ? VAL.HASH : valTypeOf(a[2])
        const leanDict = dict && (ctx.transform.optFlags & OPTF.hashRmwFusion) && leanDictUse(a[1])
        if (leanDict) {
          (ctx.func.leanHashLocals ??= new Set()).add(a[1])
          if (i32DictUse(a[1])) (ctx.func.i32HashLocals ??= new Set()).add(a[1])
          const domain = dictDomain(a[1])
          if (domain) (ctx.func.leanHashDomains ??= new Map()).set(a[1], domain)
        }
        setVal(a[1])
        // Closed integer hull for never-reassigned decls whose init the range
        // evaluator can bound (masks, ternary hulls, bounded products) — chains
        // through earlier ranged decls via intExprRange's repOf hook. Feeds the
        // i32-provability of products and div-by-2^k strength reduction (the
        // delayline q16 chain: raw = lfo & 0x1ffff → tri → dq stays i32).
        //
        // This is the SAME predicate analyzeBody's own processDecl stamps
        // EARLY, during its (possibly cache-skipped) body walk. DBG_INVARIANTS asserts the redundancy claim that justifies
        // leaving that early stamp as-is rather than threading ranges through
        // an explicit BodyFacts slice: whenever processDecl already stamped a
        // range for this name (cache miss ran it, ctx.func.localReps wasn't
        // reset since), THIS unconditional re-derivation must land the exact
        // same bound — same rhs, same walk order, same repOf-chained bounds
        // for earlier decls (ctx.func.localReps is never touched between the
        // two stamps within one function's own compile turn). See session.js's
        // DEPS table / analyzeBody's cache doc for why a genuine STALE hit
        // (skipping the early stamp) is harmless: this line still fires
        // unconditionally and fills the gap.
        const declRange = intExprRange(a[2])
        if (declRange && Number.isFinite(declRange[0]) && Number.isFinite(declRange[1]) && writeCount(body, a[1], 0) === 0) {
          if (DBG_INVARIANTS) {
            const prior = repOf(a[1])?.range
            if (prior && (prior[0] !== declRange[0] || prior[1] !== declRange[1]))
              throw new Error(`analyzeValTypes: declRange restamp for '${a[1]}' diverges from analyzeBody's early stamp — prior=[${prior}] new=[${declRange}] (idempotence probe)`)
          }
          updateRep(a[1], { range: declRange })
        }
        if (vt === VAL.REGEX) trackRegex(a[1], a[2])
        // VAL gate covers definite-typed RHS; `?:`/`&&`/`||` slip through valTypeOf
        // returning null but may still need ctor unification (or poisoning when
        // branches disagree, since jz hoists `let` to function scope).
        if (vt === VAL.TYPED || vt === VAL.BUFFER || isCondExpr(a[2])) trackTyped(a[1], a[2])
        // JSON-shape propagation. When the RHS resolves to a known JSON shape
        // (root: `JSON.parse(literal)`; nested: `o.meta`, `items[j]` from a known
        // root), record it on the binding so subsequent `.prop`/`[i]` accesses
        // skip dynamic dispatch and propagate VAL kinds. Generic for any
        // compile-time JSON literal.
        const sh = shapeOf(a[2])
        if (sh) {
          updateRep(a[1], { jsonShape: sh })
          // Array of fixed-shape OBJECTs: register elem schema so `it = items[j]`
          // → `it.prop` lowers to slot read via the existing arr-elem-schema path.
          // The element kind itself is the summary's (a store of another kind
          // poisons the schema slice: analyzeBody readElemFacts).
          if (sh.val === VAL.ARRAY && sh.elem?.val === VAL.OBJECT && sh.elem.names && ctx.schema.register && arrElems.get(a[1]) !== null) {
            const elemSid = ctx.schema.register(sh.elem.names)
            updateRep(a[1], { arrayElemSchema: elemSid })
          }
          if (sh.val === VAL.OBJECT && sh.names && ctx.schema.register) {
            const sid = ctx.schema.register(sh.names)
            updateRep(a[1], { schemaId: sid })
          }
        }
        // `shapeOf` misses object literals with function-valued props; bind
        // their schemaId here so number-hint ToPrimitive (valueOf/toString slot
        // dispatch) resolves. expectWrites=0: a decl initializer is not a write.
        if (vt === VAL.OBJECT) bindObjSchema(a[1], a[2], 0)
        // Propagate schemaId from a narrowed call result so subsequent valTypeOf
        // calls in this function body see the precise schema. emitDecl rebinds
        // this at emission time too — analyze-time binding is what unlocks the
        // slotVT lookup chain in `analyzeValTypes`'s own walk + per-func emit
        // dispatch reading localReps.
        if (vt === VAL.OBJECT && Array.isArray(a[2]) && a[2][0] === '()' && typeof a[2][1] === 'string') {
          const f = ctx.funcs.map?.get(a[2][1])
          if (f?.sig?.ptrAux != null) updateRep(a[1], { schemaId: f.sig.ptrAux })
        }
        // `const p = arr[i]` — when arr's element schema is known (from .push observations
        // or from paramReps arrayElemSchema binding), p inherits the schema. Unlocks slotVT-driven
        // numeric typing on `.prop` reads + slot-direct loads.
        if (Array.isArray(a[2]) && a[2][0] === '[]' && typeof a[2][1] === 'string') {
          const elemSid = arrElemSchemaOf(a[2][1])
          if (elemSid != null) {
            updateRep(a[1], { schemaId: elemSid })
            // Also set the val so structural call dispatch + valTypeOf see VAL.OBJECT.
            setVal(a[1])
          } else {
            // Closed heterogeneous union: `const o = rows[i]` over a
            // set-carrying array — o is provably ONE of the union's schemas.
            // Discriminant refinement (flow-types) narrows per-branch; the
            // union-agreeing slot path (schema.slotOf) serves unbranched reads
            // like the tag itself.
            // Decl-only binding (no reassignment anywhere, incl. closures) — a
            // second write could carry a foreign schema the set doesn't cover.
            const elemSet = arrElemSchemaSetOf(a[2][1])
            if (elemSet != null && writeCount(body, a[1], 0) === 0) {
              updateRep(a[1], { schemaIdSet: elemSet })
              setVal(a[1])
            }
          }
        }
      }
    }
    if (op === '=' && typeof node[1] === 'string') {
      walk(node[2], cond)
      const merged = ctx.schema.resolve?.(node[1])
      const hasPropertyWrites = ctx.types.dynWriteVars?.has(node[1]) || ctx.types.literalWriteKeys?.get(node[1])?.size
      const dict = Array.isArray(node[2]) && node[2][0] === '{}' && node[2].length === 1 &&
        hasPropertyWrites && !merged?.length
      const vt = dict ? VAL.HASH : valTypeOf(node[2])
      // Dict-value-type census, local half (design §1a) — reassignment site
      // sibling of the decl-site stamp above.
      // Map-value-type census, local half — reassignment site sibling of the
      // decl-site stamp above.
      if (dict && (ctx.transform.optFlags & OPTF.hashRmwFusion) && leanDictUse(node[1])) {
        (ctx.func.leanHashLocals ??= new Set()).add(node[1])
        if (i32DictUse(node[1])) (ctx.func.i32HashLocals ??= new Set()).add(node[1])
        const domain = dictDomain(node[1])
        if (domain) (ctx.func.leanHashDomains ??= new Map()).set(node[1], domain)
      }
      setVal(node[1])
      if (vt === VAL.REGEX) trackRegex(node[1], node[2])
      if (vt === VAL.TYPED || vt === VAL.BUFFER || isCondExpr(node[2])) trackTyped(node[1], node[2])
      if (vt === VAL.OBJECT) bindObjSchema(node[1], node[2])
      return
    }
    // Track property assignments for auto-boxing: x.prop = val
    if (op === '=' && Array.isArray(node[1]) && node[1][0] === '.' && typeof node[1][1] === 'string') {
      const [, obj, prop] = node[1]
      const vt = getVal(obj)
      if ((vt === VAL.NUMBER || vt === VAL.BIGINT) && ctx.func.locals?.has(obj) && ctx.schema.register) {
        if (!ctx.func.localProps) ctx.func.localProps = new Map()
        if (!ctx.func.localProps.has(obj)) ctx.func.localProps.set(obj, new Set())
        ctx.func.localProps.get(obj).add(prop)
      }
    }
    // Conditional-position threading (the param-write rule above): arms whose
    // execution depends on a runtime test descend with cond=true — 'if'/'?:'
    // arms (their tests stay at the current position), '&&'/'||'/'??' right
    // sides, and every part of a loop (a body that may run zero times).
    // Everything else inherits the caller's position.
    if (op === 'if' || op === '?:') { walk(node[1], cond); for (let i = 2; i < node.length; i++) walk(node[i], true); return }
    if (op === '&&' || op === '||' || op === '??') { walk(node[1], cond); walk(node[2], true); return }
    // Loops and try: every part may run zero times (loop body / catch arm) or
    // stop mid-way (a throw skips the try body's tail) — all conditional.
    if (op === 'while' || op === 'do' || op === 'for' || op === 'for-in' || op === 'for-of' || op === 'try') {
      for (let i = 1; i < node.length; i++) walk(node[i], true)
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i], cond)
  }
  const objAssignSites = []
  walk(body, false)

  // Slice-4 P3 predictor: `Object.assign(x, …)` onto a non-OBJECT binding
  // (boxed primitive / array carrier) allocates an `__inner__` record at emit;
  // the schema BINDING is plan state — register + bind here, mirroring
  // module/object.js's emit site (which now asserts instead of writing).
  // Post-walk so the target's FINAL val kind matches what emit reads; the
  // shared ctx.schema.resolveExpr keeps source resolution identical to emit's.
  for (const { target, sources } of objAssignSites) {
    const vt = repOf(target)?.val
    if (!vt || vt === VAL.OBJECT || !ctx.schema.resolveExpr) continue
    const allProps = []
    let known = true
    for (const src of sources) {
      const s = ctx.schema.resolveExpr(src)
      if (!s) { known = false; break }
      for (const p of s) if (!allProps.includes(p)) allProps.push(p)
    }
    if (!known) continue   // emit errs on unknown-source schemas — nothing to bind
    const sid = ctx.schema.register(['__inner__', ...allProps])
    // Extern-write belt: source slot values copied in at emit, unseen by censuses.
    ctx.schema.externSlotSids?.add(sid)
    updateRep(target, { schemaId: sid })
  }

  // Register boxed schemas for local variables with property assignments
  if (ctx.func.localProps) {
    for (const [name, props] of ctx.func.localProps) {
      if (ctx.schema.idOf(name) != null) continue
      const schema = ['__inner__', ...props]
      const sid = ctx.schema.register(schema)
      updateRep(name, { schemaId: sid })
    }
  }
}

/** Forward-propagate `intCertain` on local bindings. Fixpoint lives in type.js.
 *  Threads the settled slot census as the `.prop`-read resolver — without it a
 *  binding built from an int-certain slot (`const x = hitX ? p.x : nx`) stayed
 *  uncertain and every consumer re-paid the ToNumber guard. */
export function analyzeIntCertain(body) {
  const slotIntOf = ctx.schema?.slotIntCertainAt
    ? (obj, prop) => {
      const id = ctx.schema.idOf?.(obj)
      if (id == null) return null
      const idx = ctx.schema.list[id]?.indexOf(prop)
      if (idx == null || idx < 0) return null
      return ctx.schema.slotIntCertainAt(obj, prop)
    }
    : undefined
  for (const [name, intC] of intCertainMap(body, undefined, slotIntOf)) {
    if (intC) updateRep(name, { intCertain: true })
  }
}
