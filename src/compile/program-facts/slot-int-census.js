/** Whole-program integer range proofs for schema slots. */
import { DBG_INVARIANTS } from '../../debug.js'
import { MUTATE_OPS, walkAst, isTdzValue, someDeep } from '../../ast.js'

const isStringKeyIndex = (t) => t[0] === '[]' && Array.isArray(t[2]) && (t[2][0] == null || t[2][0] === 'str') && typeof t[2][1] === 'string'
import { ctx, err, getFactStore } from '../../ctx.js'
import { ANY, K, hasTag, tagOf } from '../../summary/kind.js'
import { staticObjectProps } from '../../static.js'
import { scanIntervalIdx, paramEntry, WORD_VALUE, WHOLE_VALUE } from '../../type/interval-proof.js'
import { nrWord } from '../../summary/num-range.js'
import { enterActiveFunction, restoreActiveFunction } from '../active-function.js'
import { collectSlotWriteHazards, applySlotWriteHazards } from './slot-write-hazards.js'
import { collectBodyElemSids } from './shared.js'
import { frameNode } from '../../function.js'
import { mixedBoolKind } from '../../kind.js'

/** Whole-program slot intCertain observation.
 *
 *  A schema slot `(sid, idx)` holds a word (2) where every write to it across
 *  the program is one, an integer wherever finite (1) where each is one of
 *  those, nothing (0) else. Each write's number is the interval proof's in the
 *  flow it runs in (a function, a closure, the module's statements), a field
 *  read answered by the census's current levels: a greatest fixpoint, the
 *  self-referential update (`ps[i] = { x: hit ? p.x : nx }`) reading its own
 *  slot as integral until a write proves otherwise.
 *
 *  Global poison semantics: any non-int write to a slot — in any body —
 *  permanently flips it false. Slots never observed stay `undefined`.
 *  Writes the census can't SEE (unresolvable receivers, computed keys, extern
 *  constructors) are poisoned via collectSlotWriteHazards at every (re)build.
 *
 *  A slot written from a call's return value holds what the call's carrier
 *  holds (a word result), nothing else: conservative, only false negatives. */
/** @param opts.paramReps  LATE-mode (plan's post-narrowSignatures block): re-derive
 *  the census FRESH with BODY-LOCAL receiver resolution — `const p = ps[i]`
 *  binds p's sid from the array's element schema (analyzeBody.arrElemSchemas
 *  for locals, paramReps.arrayElemSchema for params), which only exists after
 *  narrowing. Sound to REBUILD (not merely widen): every census consumer
 *  (toNumF64 / floor elision / intIndexIR) reads at EMIT time, after this. */
export function analyzeSchemaSlotIntCertain(ast, opts) {
  if (!ctx.schema?.register) return
  // Working state is the LEVEL map (0 | 1 integral wherever finite | 2 a
  // word); the boolean projections slotIntCertain (≥1) and slotI32Certain
  // (≥2) are published for consumers after the rounds settle.
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

  // Receiver → sid, as the census's own frame resolves it (the walks below run
  // in frames of their own). `curSids` is the CURRENT body's local
  // element-alias map (late mode only): `const p = ps[i]` resolves p through
  // ps's element schema. Precise-path rep/vars resolution is the fallback.
  let curSids = null
  const reps = ctx.func.localReps
  const sidOfName = (obj) => {
    if (ctx.schema.poisoned?.has(obj)) return undefined
    return curSids?.get(obj) ?? reps?.get(obj)?.schemaId ?? ctx.schema.vars.get(obj)
  }
  // OPTIMISTIC slot-read resolver: the self-referential immutable-update
  // idiom (`ps[i] = { x: hitX ? p.x : nx, … }`) rebuilds a slot FROM a read
  // of the same slot, so a single pessimistic pass poisons every such field.
  // Greatest fixpoint instead: a censused slot read holds its level until some
  // write proves otherwise; each round re-derives every observation and any
  // drop triggers another round (monotone-down, so it terminates in ≤ 2·slots+1
  // rounds). A censused 0 answers definitively.
  // (each walk notes the levels it read: a walk whose reads all stand answers as it did)
  const levelOf = (sid, idx) => slotIntLevels.get(sid)?.[idx] ?? 2   // unobserved = optimistic top
  let reads = null
  const slotNumbers = (e) => {
    const sid = typeof e[1] === 'string' ? sidOfName(e[1]) : null
    const idx = sid == null ? -1 : ctx.schema.list[sid]?.indexOf(e[2]) ?? -1
    if (idx < 0) return null
    const level = levelOf(sid, idx)
    reads.push(sid, idx, level)
    return level === 2 ? WORD_VALUE : level === 1 ? WHOLE_VALUE : null
  }
  const standing = (r) => { for (let i = 0; i < r.length; i += 3) if (levelOf(r[i], r[i + 1]) !== r[i + 2]) return false; return true }
  const level = (v) => !v ? 0 : nrWord(v) ? 2 : v.whole ? 1 : 0

  // LATE mode: body-local element-alias sids (collectBodyElemSids — shared
  // with the hazard scan so receiver resolution stays in lockstep).
  const paramReps = opts?.paramReps

  // The flows the slot writes run in: the module's statements, each
  // function's frame (a parameter default runs in the frame) and each closure
  // (a store in a callback a factory returns writes the slot the factory's
  // literal made; its parameters are its own), each with its `{}` literals
  // and its `o.k = v` / `o['k'] = v` writes (a literal or folded constant key
  // writes the slot `o.k` does; a compound assign or a step stores its
  // effective value, `o.n++` → `o.n + 1`).
  const flows = []
  const gather = (root, sig, own, sids) => {
    const nodes = []
    walkAst(root, { enter: n => {
      if (n[0] === '=>') {
        const params = []
        someDeep(n[1], x => { if (typeof x === 'string') params.push(x); return false })
        if (n[2] != null) gather(n[2], sig, params, sids)
        return false
      }
      if (n[0] === '{}' ? !!staticObjectProps(n.slice(1)) : MUTATE_OPS.has(n[0]) && Array.isArray(n[1]) && (n[1][0] === '.' || isStringKeyIndex(n[1])) && typeof n[1][1] === 'string') nodes.push(n)
    } })
    if (nodes.length) flows.push({ root, sig, own, sids, nodes })
  }
  if (ast) gather(ast, null, null, null)
  for (const func of ctx.funcs.list) if (func.body && !func.raw) gather(frameNode(func), func.sig, null, collectBodyElemSids(func, paramReps))
  if (ctx.module.initFacts?.hasSchemaLiterals && ctx.module.moduleInits) for (const mi of ctx.module.moduleInits) gather(mi, null, null, null)
  // The typed reads a body's summary proves hit (an index a fixed length holds:
  // `sum0: SHIFT16[10]`, a view of 37 elements).
  const present = (n) => { const k = ctx.summary?.at(ctx.func.current)?.kindOfExpr(n); return k != null && tagOf(k) === K.NUMBER && !hasTag(k, K.ABSENT) && !hasTag(k, K.NULLISH) }
  // A walk's values, by its root, while every level it read stands: a later
  // census of the program reads them again (early mode: the late one walks
  // with the element aliases narrowing found).
  const memo = paramReps ? null : getFactStore().programFacts.slotWalks
  const walkFlow = (flow) => {
    let values = null
    const hit = memo?.get(flow.root)
    if (hit && standing(hit.reads)) ({ values, reads: flow.reads } = hit)
    else {
      values = new Map()
      for (const n of flow.nodes) values.set(n, undefined)
      curSids = flow.sids
      reads = []
      const prev = enterActiveFunction(ctx, { sig: flow.sig, body: flow.root })
      try { scanIntervalIdx(flow.root, () => null, { values, own: flow.own, entry: flow.own ? new Map() : paramEntry(), slot: slotNumbers, present }) }
      finally { restoreActiveFunction(ctx, prev) }
      flow.reads = reads
      memo?.set(flow.root, { values, reads })
    }
    for (const n of flow.nodes) {
      const v = values.get(n)
      if (n[0] === '{}') {
        const parsed = staticObjectProps(n.slice(1))
        // a class instance's literal is its class's schema (the brand salts the id): its
        // `undefined` inits are writes of the slots the constructor's stores reach
        const sid = ctx.schema.register(parsed.names, parsed.brand)
        // (a frame field's TDZ value is no write: its binding's steps are)
        for (let i = 0; i < parsed.values.length; i++) if (!isTdzValue(parsed.values[i])) observeSlot(sid, i, level(v?.[i]))
        continue
      }
      // Same precise-path resolution as ctx.schema.slotVT, no structural
      // fallback (slot index could differ across schemas with the same prop).
      // Poisoned names carry no schema (shape-disagreeing assignments);
      // unresolvable receivers are hazard-poisoned (collectSlotWriteHazards).
      const sid = sidOfName(n[1][1]), prop = n[1][0] === '.' ? n[1][2] : n[1][2][1]
      const idx = sid == null ? -1 : ctx.schema.list[sid]?.indexOf(prop) ?? -1
      if (idx >= 0) observeSlot(sid, idx, level(v))
    }
    curSids = null
  }

  // A slot holding a Boolean beside a number holds the Boolean's atom (a store
  // boxes it, ir/sentinels.js carrierF64): its bits are no integer, whatever
  // the integer a Boolean converts to.
  const boolSlots = []
  if (ctx.summary) for (let sid = 0; sid < ctx.schema.list.length; sid++) {
    const props = ctx.schema.list[sid]
    for (let i = 0; i < props.length; i++) if (mixedBoolKind(ctx.summary.fieldKind(sid, props[i]))) boolSlots.push(sid, i)
  }
  const sweep = (first) => {
    // Hazard poison FIRST: the optimistic resolver must never count a
    // hazarded slot int mid-fixpoint (it would infect other slots' certainty).
    applySlotWriteHazards(hazards, poisonSlot)
    for (let j = 0; j < boolSlots.length; j += 2) poisonSlot(boolSlots[j], boolSlots[j + 1])
    flipped = false
    // (a flow whose reads all stand stores what it stored: its observations hold)
    for (const flow of flows) if (first || !standing(flow.reads)) walkFlow(flow)
  }
  sweep(true)
  let rounds = 0
  while (flipped && ++rounds <= 64) sweep(false)
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
  // Invariant tripwire (design .work/archive/carrier-representation-design.md §15/
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
      for (let i = 0; i < arr.length; i++) {
        const kind = ctx.summary?.fieldKind(sid, ctx.schema.list[sid][i]) ?? 0
        // An open summary admits every tag; it does not prove a BigInt write.
        if (arr[i] === true && kind !== ANY && hasTag(kind, K.BIGINT))
          throw new Error(`P-carrier invariant: schema ${sid} slot ${i} is BOTH i32Certain and slotBigintObserved — a BIGINT write can never be strict-int32`)
      }
    }
  }
}
