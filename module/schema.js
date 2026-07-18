/**
 * Schema subsystem — object property layout registration, lookup, boxing.
 *
 * Owns: register, find, isBoxed, emitInner on ctx.schema.
 * Used by: core.js (property dispatch), object.js (literals), prepare.js (tracking).
 *
 * @module schema
 */

import { typed, asF64 } from '../src/ir.js'
import { emit } from '../src/bridge.js'
import { valTypeOf } from '../src/kind.js'
import { VAL, lookupValType, repOf } from '../src/reps.js'
import { err, inc } from '../src/ctx.js'

/** Initialize schema helpers on ctx. Called once per compilation from core module. */
export function initSchema(ctx) {
  // key → schemaId for O(1) dedupe; prop → [{id, slot}] for O(matches) structural find.
  // \x01 delimiter avoids collision with any legal JS identifier character.
  const byKey = new Map()
  const byProp = new Map()
  ctx.schema._byKey = byKey
  ctx.schema._byProp = byProp

  ctx.schema.register = (props) => {
    // Length prefix disambiguates [] from [''] (both join to '') and any
    // shorter prop list from a longer one whose extra entries are empty.
    const key = props.length + '\x01' + props.join('\x01')
    const existing = byKey.get(key)
    if (existing != null) return existing
    const id = ctx.schema.list.push(props) - 1
    byKey.set(key, id)
    for (let i = 0; i < props.length; i++) {
      const p = props[i]
      let bucket = byProp.get(p)
      if (!bucket) byProp.set(p, bucket = [])
      bucket.push({ id, slot: i })
    }
    return id
  }

  /** schemaId for a variable name: ValueRep first, then module-level ctx.schema.vars.
   *  Both paths exist because vars covers names without a per-function ValueRep
   *  (prepare-phase rest/destructure tracking, module-level autoboxes).
   *  Poisoned names (shape-disagreeing assignments, see prepare's
   *  bindAssignSchema) resolve to NO schema regardless of store: a fixed-slot
   *  read against one literal's layout would misread the other sources. */
  ctx.schema.idOf = (name) => {
    // A branch-local runtime schema guard is stronger than durable flow facts:
    // inside its fast arm even a deliberately-poisoned union binding has one
    // exact layout. The guarded slow arm retains the ordinary dynamic path.
    const refined = ctx.func.refinements?.get(name)?.schemaId
    if (refined != null) return refined
    return ctx.schema.poisoned?.has(name) ? undefined
      : repOf(name)?.schemaId ?? ctx.schema.vars.get(name)
  }

  /** Resolve variable name to its schema props array, or null. */
  ctx.schema.resolve = (varName) => {
    const id = ctx.schema.idOf(varName)
    return id != null ? ctx.schema.list[id] : null
  }

  /** Check if variable has a boxed schema (slot 0 = __inner__). */
  ctx.schema.isBoxed = (varName) => {
    const id = ctx.schema.idOf(varName)
    return id != null && ctx.schema.list[id]?.[0] === '__inner__'
  }

  /** Emit code to load the inner value (slot 0) of a boxed variable. */
  ctx.schema.emitInner = (varName) => {
    inc('__ptr_offset')
    return typed(['f64.load', ['call', '$__ptr_offset', ['i64.reinterpret_f64', asF64(emit(varName))]]], 'f64')
  }

  /** Find property index by variable schema or structural subtyping.
   *  Returns -1 to signal "use dynamic lookup" in four cases:
   *    1. Variable has precise schema but schema lacks the property
   *    2. Receiver is a string variable, but its valType is unknown or not OBJECT
   *    3. Receiver is not a string variable (varName == null) — no type evidence
   *    4. Structural search finds the property at inconsistent offsets across schemas
   *  Case 4 is a real ambiguity — the caller must route to runtime dispatch.
   *
   *  Named `slotOf`, not `find`: under self-host the compiler calls this as
   *  `ctx.schema.find(...)` on the statically-untyped `ctx.schema` receiver, and
   *  `find` collides with `Array.prototype.find` — the method-call dispatcher
   *  hijacks it into a bogus array `find` (predicate scan), returning null. Every
   *  schema-slot property read then mis-resolved through jz.wasm (e.g. a boxed
   *  `Object.assign(arr, {p}); arr.p`). A non-builtin name dispatches correctly.
   *  Mirrors the abi string `concat`→`cat` rename for the same root cause. */
  ctx.schema.slotOf = (varName, prop) => {
    // A branch-local guarded schema UNION may not have one sid, but if every
    // member agrees on this field's slot the fixed offset is still exact.
    const refinedSlot = ctx.func.refinements?.get(varName)?.schemaSlots?.get(prop)
    if (refinedSlot != null) return refinedSlot
    // Precise: variable has known schema
    const id = ctx.schema.idOf(varName)
    if (id != null) return ctx.schema.list[id]?.indexOf(prop) ?? -1
    // CLOSED schema union (rep channel — `const o = rows[i]` over a proven
    // heterogeneous stream): when every member schema lays `prop` at ONE slot,
    // the fixed offset is exact with NO runtime guard — the union's closure is
    // the proof (the tag read `o.k` @ slot 0 across all variants). A member
    // lacking the prop, or slot disagreement, falls through to dynamic dispatch.
    if (typeof varName === 'string') {
      const set = repOf(varName)?.schemaIdSet
      if (set?.length) {
        let slot = null
        for (const sid of set) {
          const idx = ctx.schema.list[sid]?.indexOf(prop) ?? -1
          if (idx < 0 || (slot != null && slot !== idx)) { slot = null; break }
          slot = idx
        }
        if (slot != null) return slot
      }
    }
    // Structural subtyping requires positive evidence the receiver is OBJECT.
    // Without it (varName is null, or its valType is unknown / not OBJECT) we
    // can match HASH/ARRAY/etc. values as if they had OBJECT layout, producing
    // slot reads on unrelated memory. Funnel those through dynamic dispatch.
    if (typeof varName !== 'string') return -1
    // Poisoned names hold objects of KNOWN-disagreeing shapes; the structural
    // closed-world bet (receiver is one of the schemas containing the prop) is
    // exactly wrong for them — its other shapes may lack the prop while another
    // value occupies the would-be slot. Always dynamic.
    if (ctx.schema.poisoned?.has(varName)) return -1
    const vt = lookupValType(varName)
    if (vt !== VAL.OBJECT) return -1
    // Structural subtyping — sound only under the FULL closed-world condition:
    // the prop lives at the SAME slot in EVERY registered schema, so whatever
    // sid this OBJECT receiver carries, the slot is right. Checking only the
    // schemas that CONTAIN the prop (the old form) bet that no other schema's
    // instance could flow here — wrong the moment two shapes share a binding:
    // `p.x` on a {z,w,q} receiver read z (slot 0 of a foreign schema), and the
    // write sibling `p.x = v` CORRUPTED z. Receivers with a genuinely unique
    // prop still devirtualize via guardedSlotOf's runtime-guarded path.
    const bucket = byProp.get(prop)
    if (!bucket || bucket.length !== ctx.schema.list.length) return -1
    const slot = bucket[0].slot
    for (let i = 1; i < bucket.length; i++) if (bucket[i].slot !== slot) return -1
    if (typeof process !== 'undefined' && process.env?.JZ_DBG_SLOTOF)
      console.error('[slotof-structural]', varName, '.', prop, 'slot', slot, 'bucket', bucket.length, 'of', ctx.schema.list.length, 'schemas')
    return slot
  }

  /** Devirtualization guard for a receiver whose static type is fully unknown
   *  (valTypeOf gives up entirely — no OBJECT proof at all, unlike `slotOf`'s
   *  structural fallback which *requires* one). Returns `{sid, slot}` when
   *  `prop` names a field on exactly ONE registered schema anywhere in the
   *  program — the subscript dispatch-descriptor pattern (`d.op`/`d.l`/`d.word`)
   *  and jz's own emit-table/IR-node reads under self-host both flow through a
   *  parameter or array element the static analysis never pins to VAL.OBJECT,
   *  even though every value that ever reaches the read is, in practice, that
   *  one schema. Unlike `slotOf`, the caller MUST runtime-guard the read (a
   *  masked NaN-box compare proving tag==OBJECT && aux==sid at once — see
   *  module/core.js's emitSchemaSlotGuarded) rather than trusting it
   *  unconditionally: with no static OBJECT evidence, the receiver could
   *  legitimately be anything, and the guard is what makes that safe. Two or
   *  more distinct schemas sharing the name (bucket.length > 1) is left to
   *  dynamic dispatch — a multi-way guard chases diminishing returns the
   *  common case (a genuine program-wide-unique field name) doesn't need. */
  ctx.schema.guardedSlotOf = (prop) => {
    const bucket = byProp.get(prop)
    if (!bucket || bucket.length !== 1) return null
    return { sid: bucket[0].id, slot: bucket[0].slot }
  }

  /** Resolve the monomorphic slot value-type for `varName.prop`, or null.
   *  Precise path only: requires the variable to have a bound `schemaId`
   *  (ValueRep or `ctx.schema.vars`). Structural-subtyping is intentionally
   *  off — without per-call-site flow inference, structural agreement on a
   *  slot can lead `analyzeValTypes` to bind locals as VAL.NUMBER (or other
   *  kinds) when in fact the holder isn't an object of any registered
   *  schema. That mistyping then routes downstream property accesses
   *  through __hash_get instead of __dyn_get_any, growing the binary. */
  // Post-census belt for every slot-fact reader: a sid registered AFTER the
  // censuses ran (the JSON emitters, spread/assign merge — extern slot
  // writers) or hazarded by the write scan answers null/false even though the
  // census maps never saw it. Census-time poisoning covers plan-known sids;
  // this covers emit-time registrations at O(1) per read.
  // `kindSafeOk` (slotVT only): kind-safe sids' sample KINDS were observed
  // into slotTypes at the census, so the kind reader may trust the map —
  // unless the entry is a null-kinds emit-belt fallback. Value-level readers
  // (intCertain, elem-ctors) always fail closed on kind-safe sids: the JSON
  // parser writes arbitrary doubles/values within the sample's kinds.
  const slotHazarded = (id, prop, kindSafeOk = false) => {
    if (ctx.schema.externSlotSids?.has(id)) return true
    const hz = ctx.schema.slotWriteHazards
    if (!hz) return false
    if (hz.kindSafeSids?.has(id) && (!kindSafeOk || hz.kindSafeSids.get(id) == null)) return true
    return hz.all || hz.sids.has(id) || hz.props.has(prop) ||
      (hz.numeric && /^(0|[1-9][0-9]*)$/.test(String(prop)))
  }

  ctx.schema.slotVT = (varName, prop) => {
    const ids = ctx.func.refinements?.get(varName)?.schemaIds
    if (ids?.length) {
      let kind = null
      for (const id of ids) {
        if (slotHazarded(id, prop, true)) return null
        const idx = ctx.schema.list[id]?.indexOf(prop)
        const k = idx >= 0 ? ctx.schema.slotTypes.get(id)?.[idx] ?? null : null
        if (k == null || (kind != null && kind !== k)) return null
        kind = k
      }
      return kind
    }
    const id = ctx.schema.idOf(varName)
    if (id == null || slotHazarded(id, prop, true)) return null
    const idx = ctx.schema.list[id]?.indexOf(prop)
    return idx >= 0 ? (ctx.schema.slotTypes.get(id)?.[idx] ?? null) : null
  }

  /** Resolve the monomorphic typed-array ctor for `varName.prop`, or null.
   *  Same precise-path discipline as slotVT. Additionally gated on the prop
   *  never appearing as a WRITE target anywhere in the program
   *  (ctx.types.writtenProps): the ctor drives raw typed loads/stores, so a
   *  single `o.twRe = somethingElse` anywhere must keep the dynamic path —
   *  object-literal initial values are not writes and don't poison. */
  ctx.schema.slotTypedCtorAt = (varName, prop) =>
    ctx.schema.slotTypedCtorBySid(ctx.schema.idOf(varName), prop)

  /** Raw by-sid form for callers that resolve the receiver's schema themselves
   *  (narrow's per-caller localSids — live reps aren't trustworthy there). */
  ctx.schema.slotTypedCtorBySid = (id, prop) => {
    // fail CLOSED: without the program-wide write census the ctor can't be trusted
    if (!ctx.types.writtenProps || ctx.types.writtenProps.has(prop)) return null
    if (id == null || slotHazarded(id, prop)) return null
    const idx = ctx.schema.list[id]?.indexOf(prop)
    if (idx == null || idx < 0) return null
    return ctx.schema.slotTypedCtors.get(id)?.[idx] ?? null
  }

  /** Program-wide census ctor for a bare `.prop` read with NO receiver evidence
   *  — the SPECULATIVE sibling of slotTypedCtorBySid (guardedSlotOf's contract):
   *  every schema that declares `prop` must census the same typed ctor, and the
   *  consumer MUST runtime-guard the value (it could legitimately be anything).
   *  Feeds narrow's speculateTypedParams, never an unguarded load. */
  ctx.schema.slotTypedCtorByProp = (prop) => {
    if (!ctx.types.writtenProps || ctx.types.writtenProps.has(prop)) return null
    const bucket = byProp.get(prop)
    if (!bucket?.length) return null
    let ctor = null
    for (const b of bucket) {
      if (slotHazarded(b.id, prop)) return null
      const c = ctx.schema.slotTypedCtors.get(b.id)?.[b.slot] ?? null
      if (!c || (ctor && c !== ctor)) return null
      ctor = c
    }
    return ctor
  }

  /** Resolve per-slot intCertain: returns true iff every observed write to
   *  `varName.prop` is integer-shaped. Precise path only — requires `varName`
   *  to have a bound `schemaId`. Consumers (Math.floor elision, toNumF64 skip,
   *  intIndexIR) treat `false`/`null` identically (no narrowing). */
  ctx.schema.slotIntCertainAt = (varName, prop) => {
    const ids = ctx.func.refinements?.get(varName)?.schemaIds
    if (ids?.length) return ids.every(id => {
      if (slotHazarded(id, prop)) return false
      const idx = ctx.schema.list[id]?.indexOf(prop)
      return idx >= 0 && ctx.schema.slotIntCertain.get(id)?.[idx] === true
    })
    const id = ctx.schema.idOf(varName)
    if (id != null) {
      if (slotHazarded(id, prop)) return false
      const idx = ctx.schema.list[id]?.indexOf(prop)
      return idx >= 0 && ctx.schema.slotIntCertain.get(id)?.[idx] === true
    }
    // CLOSED schema union (rep channel — mirrors slotOf): the receiver provably
    // holds one of a closed schema set. The claim is per-VALUE, so no slot
    // agreement needed — but the prop must exist in EVERY member (a miss reads
    // undefined, whose ToNumber is NaN, not an int).
    const set = repOf(varName)?.schemaIdSet
    if (set?.length) return set.every(sid => {
      if (slotHazarded(sid, prop)) return false
      const idx = ctx.schema.list[sid]?.indexOf(prop) ?? -1
      return idx >= 0 && ctx.schema.slotIntCertain.get(sid)?.[idx] === true
    })
    return false
  }

  /** Strict-int32 sibling of slotIntCertainAt: every write is exactly-int32
   *  and never -0, so `i32.trunc_sat_f64_s(f64.load(slot))` is value-exact.
   *  Feeds raw i32 slot loads + i32 local typing — a wrong answer here is a
   *  wrong VALUE (saturation), so it shares every fail-closed belt. */
  ctx.schema.slotI32CertainAt = (varName, prop) => {
    const ids = ctx.func.refinements?.get(varName)?.schemaIds
    if (ids?.length) return ids.every(id => {
      if (slotHazarded(id, prop)) return false
      const idx = ctx.schema.list[id]?.indexOf(prop)
      return idx >= 0 && ctx.schema.slotI32Certain.get(id)?.[idx] === true
    })
    const id = ctx.schema.idOf(varName)
    if (id != null) {
      if (slotHazarded(id, prop)) return false
      const idx = ctx.schema.list[id]?.indexOf(prop)
      return idx >= 0 && ctx.schema.slotI32Certain.get(id)?.[idx] === true
    }
    // CLOSED schema union (rep channel — mirrors slotOf / slotIntCertainAt):
    // strict-int32 in every member ⇒ strict for the union value. Prop must
    // exist in every member (a miss's NaN would trunc_sat-saturate).
    const set = repOf(varName)?.schemaIdSet
    if (set?.length) return set.every(sid => {
      if (slotHazarded(sid, prop)) return false
      const idx = ctx.schema.list[sid]?.indexOf(prop) ?? -1
      return idx >= 0 && ctx.schema.slotI32Certain.get(sid)?.[idx] === true
    })
    return false
  }
  ctx.schema.slotI32CertainBySid = (id, prop) => {
    if (id == null || slotHazarded(id, prop)) return false
    const idx = ctx.schema.list[id]?.indexOf(prop)
    if (idx == null || idx < 0) return false
    return ctx.schema.slotI32Certain.get(id)?.[idx] === true
  }
}
