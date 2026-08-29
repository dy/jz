/**
 * program-facts split — whole-program schema-slot KIND census
 * (`observeProgramSlots`): observes every `{}` literal and resolvable
 * `obj.prop =` / dict `[]=` / `Map.set()` write, publishing `ctx.schema`'s
 * per-slot kind/objSid/typedCtor/bigintObserved facts and the dict/map
 * value-kind unions. Depends on slot-write-hazards.js (unresolvable writes
 * poison instead of observing) — see `../program-facts.js` for the full
 * module map and build order.
 * @module program-facts/slot-kind-census
 */
import { commaList, isLiteralStr, MUTATE_OPS, collectAllBoundNames, walkAst } from '../../ast.js'
import { ctx, getFactStore } from '../../ctx.js'
import { VAL, repOf, updateGlobalRep, KIND_UNIVERSE } from '../../reps.js'
import { valTypeOf, nullishArm } from '../../kind.js'
import { staticObjectProps, objLiteralSchemaId } from '../../static.js'
import { typedStorageCtorFromContext } from '../../typed-context.js'
import { analyzeBody } from '../analyze.js'
import { withValueOverlay } from '../flow-state.js'
import { collectSlotWriteHazards, applySlotWriteHazards } from './slot-write-hazards.js'
import { effectiveWriteValue } from './shared.js'

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
// Self-read neutrality (.work/archive/todo.md §deletion-sweep): a read
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
// there — see .work/archive/todo.md §deletion-sweep) ──────────────────────────
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
    const walk = (n) => walkAst(n, { enter: n => {
      if (n[0] === '=>') return false
      if ((n[0] === 'let' || n[0] === 'const')) {
        for (let i = 1; i < n.length; i++)
          if (Array.isArray(n[i]) && n[i][0] === '=') note(n[i][1], n[i][2])
      } else if (n[0] === '=' && typeof n[1] === 'string') note(n[1], n[2])
      else if (MUTATE_OPS.has(n[0]) && typeof n[1] === 'string') out.set(n[1], null)
    } })
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
    const walk = (node) => walkAst(node, { enter: node => {
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
    } })
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
      // Map-value-type census (Tier 1, global half, design .work/archive/todo.md
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
  // .work/archive/todo.md §deletion-sweep §1): a bundled sub-module whose init
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
