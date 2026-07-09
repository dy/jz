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
  ctx.schema.idOf = (name) => ctx.schema.poisoned?.has(name) ? undefined
    : repOf(name)?.schemaId ?? ctx.schema.vars.get(name)

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
    // Precise: variable has known schema
    const id = ctx.schema.idOf(varName)
    if (id != null) return ctx.schema.list[id]?.indexOf(prop) ?? -1
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
    // Structural subtyping: walk only schemas that contain this prop.
    // Consistent slot across all → return slot; any mismatch → -1 (dynamic lookup).
    const bucket = byProp.get(prop)
    if (!bucket) return -1
    const slot = bucket[0].slot
    for (let i = 1; i < bucket.length; i++) if (bucket[i].slot !== slot) return -1
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
  ctx.schema.slotVT = (varName, prop) => {
    const id = ctx.schema.idOf(varName)
    if (id == null) return null
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
    if (id == null) return null
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
    const id = ctx.schema.idOf(varName)
    if (id == null) return false
    const idx = ctx.schema.list[id]?.indexOf(prop)
    if (idx < 0) return false
    return ctx.schema.slotIntCertain.get(id)?.[idx] === true
  }
}
