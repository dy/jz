/**
 * program-facts split — whole-program schema-slot INT-CERTAIN census
 * (`analyzeSchemaSlotIntCertain`): a greatest-fixpoint sibling of
 * slot-kind-census.js's kind census, over the SAME write shapes, publishing
 * `ctx.schema.slotIntCertain`/`slotI32Certain`. Depends on
 * slot-write-hazards.js (same poison discipline) — see `../program-facts.js`
 * for the full module map and build order.
 * @module program-facts/slot-int-census
 */
import { MUTATE_OPS } from '../../ast.js'
import { ctx, err, getFactStore, DBG_INVARIANTS } from '../../ctx.js'
import { repOf } from '../../reps.js'
import { staticObjectProps } from '../../static.js'
import { intLevelChecker } from '../../type.js'
import { collectSlotWriteHazards, applySlotWriteHazards } from './slot-write-hazards.js'
import { collectBodyElemSids, effectiveWriteValue } from './shared.js'

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
