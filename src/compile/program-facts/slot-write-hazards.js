/**
 * program-facts split — slot-write hazard census: every way a schema slot's
 * value can change OTHER than a `{}` literal or a resolvable `obj.prop =`
 * write (slot-kind-census.js and slot-int-census.js's own province), which
 * those two censuses must poison or a consumer bakes a stale fact into
 * codegen. `collectSlotWriteHazards` is called by BOTH — see
 * `../program-facts.js` for the full module map and build order.
 * @module program-facts/slot-write-hazards
 */
import { commaList, isLiteralStr, MUTATE_OPS, walkAst } from '../../ast.js'
import { ctx, getFactStore } from '../../ctx.js'
import { VAL, repOf } from '../../reps.js'
import { valTypeOf } from '../../kind.js'
import { objLiteralSchemaId } from '../../static.js'
import { analyzeBody } from '../analyze.js'
import { withValueOverlay } from '../flow-state.js'
import { collectBodyElemSids } from './shared.js'

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
  const patternTargets = (pat) => walkAst(pat, { enter: pat => {
    const op = pat[0]
    if (op === '.' || op === '?.') {
      if (typeof pat[2] === 'string') {
        const sid = sidOf(pat[1])
        if (sid != null) addPointsTo(sid)
        else hz.props.add(pat[2])
      }
      return false
    }
    if (op === '[]') { keyedWrite(pat[1], pat[2]); return false }
  } })
  const visit = (node) => walkAst(node, { enter: node => {
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
  } })
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
