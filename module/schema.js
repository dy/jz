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
import { err, inc, CARRIER_BOX } from '../src/ctx.js'
import { ERR_CLASS_NAMES, ERR_SCHEMA_PROPS } from '../err-codes.js'

/** Initialize schema helpers on ctx. Called once per compilation from core module. */
export function initSchema(ctx) {
  // key → schemaId for O(1) dedupe; prop → [{id, slot}] for O(matches) structural find.
  // \x01 delimiter avoids collision with any legal JS identifier character.
  const byKey = new Map()
  const byProp = new Map()
  ctx.schema._byKey = byKey
  ctx.schema._byProp = byProp

  // `salt` (optional): forces a schema id DISTINCT from every other registration
  // of the identical prop list, without adding a source-visible property to
  // that list. Used ONLY by the Error-class brand below — every other caller
  // omits it, so their dedupe-by-content key is byte-identical to before this
  // parameter existed. \x02 can't collide with a real prop name landing in the
  // \x01-joined content prefix: prop names are validated identifiers/string
  // keys, and even a pathological one contributes to the segment BEFORE any
  // \x02, never straddling it (the length-prefix discipline above already
  // established this class of non-collision for \x01).
  ctx.schema.register = (props, salt) => {
    // Length prefix disambiguates [] from [''] (both join to '') and any
    // shorter prop list from a longer one whose extra entries are empty.
    const key = props.length + '\x01' + props.join('\x01') + (salt ? '\x02' + salt : '')
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

  // === Error-class brand (audit-#9 P0-2, .work/todo.md §deletion-sweep redesign) ===
  //
  // Class identity lives in the SCHEMA ID itself — the NaN-box aux bits every
  // OBJECT pointer already carries — not in a source-visible/spellable slot.
  // Each of the 7 built-in Error classes gets its OWN sid via the `salt`
  // parameter above (all 7 share the identical PHYSICAL prop list
  // ['message','name'], so `.message`/`.name` dot-access, JSON.stringify, dyn
  // GET/SET/DELETE, and enumeration all see two perfectly ordinary schema
  // slots — no reserved name, nothing to filter, nothing to un-spell). Nothing
  // in source can forge or corrupt a pointer's own tag/aux bits (unlike a
  // memory slot, which a computed write can reach) — this is a REAL hidden
  // brand, not a property convention enforced by prepare-time rejection.
  // Idempotent per class name (register's own content+salt dedupe), so it
  // doesn't matter whether the constructor call site or an `instanceof`/
  // `toStrI64` check site runs first — whichever runs first mints the id, the
  // other reuses it.
  const errorSidByClass = new Map()   // className → sid
  const errorClassBySid = new Map()   // sid → className (reverse index)
  ctx.schema.errorSid = (className) => {
    let id = errorSidByClass.get(className)
    if (id == null) {
      id = ctx.schema.register(ERR_SCHEMA_PROPS, className)
      errorSidByClass.set(className, id)
      errorClassBySid.set(id, className)
    }
    return id
  }
  /** True iff `id` is one of the (lazily minted) 7 Error-class schema ids. */
  ctx.schema.isErrorSid = (id) => errorClassBySid.has(id)
  /** className for an Error-class sid, or null. */
  ctx.schema.errorClassOf = (id) => errorClassBySid.get(id) ?? null
  /** Every (sid, className) pair minted so far — src/compile/index.js's
   *  'jz:errcls' custom-section writer walks this to hand interop.js the
   *  host-side sid→class map it needs (a compiled module has no other way to
   *  recover compile-time schema-id semantics — see interop.js decodeThrown). */
  ctx.schema.errorSidEntries = () => errorClassBySid
  /** Every registered class name, in ERR_CLASS_NAMES' fixed order, restricted
   *  to classes actually minted so far — the deterministic iteration order
   *  `emitErrorInstanceof`'s base-'Error' OR-chain and ir.js's toStrI64 arm
   *  need (Map insertion order would instead follow first-use source order,
   *  which can legitimately differ between two semantically-identical
   *  programs and would make emitted bytes depend on incidental AST-walk
   *  order rather than program content). */
  ctx.schema.errorClassesUsed = () => ERR_CLASS_NAMES.filter(c => errorSidByClass.has(c))

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
    // BindingId totality: names are binding-unique module-wide, so the shared
    // store is a plain lookup (the old varsBarred belt guarded cross-function
    // bare-name collisions, now unrepresentable).
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

  // === CARRIER PROGRAM §15/§16: slotBigintBoxed / slotBigintProven ===
  //
  // slotI32Certain's write-side twin. §15 root-caused a carrier-built kernel
  // corrupting its own generated constants to a granularity mismatch: the
  // write side boxed a schema slot's BIGINT value per-LITERAL (`needsDynShadow`
  // of THIS construction alone), while the read side (emitSchemaSlotRead,
  // module/core.js) had no matching arm at all — a bare f64.load handed a
  // registry-only reader's box pointer to every consumer as if it were the
  // field's raw value. The fix pairs write and read at SCHEMA granularity
  // instead: a schemaId can be shared by a shadowed and a non-shadowed
  // constructor, so the two sides can only agree exactly when EVERY
  // constructor/assignment of a schema boxes a BIGINT slot the moment ANY ONE
  // of them needs to.

  // Memoized reverse index: dynKeyVars name → schemaId, rebuilt whenever
  // ctx.types.dynKeyVars is reassigned (plan/index.js publishes a fresh Set
  // each collectProgramFacts pass — reference-identity is the correct, cheap
  // invalidation key). Built lazily (not at slot-census time): dynKeyVars/
  // anyDynKey aren't published until AFTER observeProgramSlots' census runs
  // (see slotBigintObserved's own doc, ctx.js) — schemaShadowed only needs to
  // be correct by CODEGEN time, well after both are settled.
  let shadowedSidsCache = null, shadowedSidsKey = null
  const schemaShadowed = (sid) => {
    if (ctx.types.anyDynKey) return true
    const dyn = ctx.types.dynKeyVars
    if (!dyn || !dyn.size) return false
    if (shadowedSidsKey !== dyn) {
      shadowedSidsCache = new Set()
      for (const name of dyn) {
        const s = repOf(name)?.schemaId ?? ctx.schema.vars.get(name)
        if (s != null) shadowedSidsCache.add(s)
      }
      shadowedSidsKey = dyn
    }
    return shadowedSidsCache.has(sid)
  }

  /** WRITE-usable fact: true iff a BIGINT value stored at (sid, prop) must be
   *  boxed (a real PTR.BIGINT heap cell) rather than left as raw i64-as-f64
   *  bits. TRUE iff (a) slotBigintObserved (ctx.js) ever joined a BIGINT
   *  write at this slot ANYWHERE in the program — a pure OR, so a slot that
   *  also holds plain NUMBER writes elsewhere still boxes its BIGINT
   *  instances — AND (b) SOME constructor/assignment of this schema is
   *  dyn-shadowed (schemaShadowed above, the program-level mirror of
   *  needsDynShadow's own two conditions). Deliberately WIDER than the read-
   *  side twin below (slotBigintProvenBySid): it does NOT require the slot to
   *  be uniformly BIGINT, because carrierF64/carrierF64Narrow (src/ir.js)
   *  already gate boxing PER VALUE (`valTypeOf(value) === VAL.BIGINT`) — a
   *  NUMBER-typed write routed through the "boxed" choice is unaffected,
   *  falls to the same asF64 either way. Consumed directly by the write
   *  sites that used to branch on raw needsDynShadow (module/object.js
   *  literal/spread construction, src/compile/emit-assign.js field-assign)
   *  — CARRIER_BOX-gated so a flag-off build's choice of storedValue vs.
   *  storedValueNarrow is unaffected (byte-identical either way when the
   *  flag is off — both degrade to the same asF64/boolBoxIR fallback). */
  ctx.schema.slotBigintBoxedBySid = (sid, prop) => {
    if (!CARRIER_BOX || sid == null) return false
    const idx = ctx.schema.list[sid]?.indexOf(prop)
    if (idx == null || idx < 0) return false
    if (!ctx.schema.slotBigintObserved.get(sid)?.[idx]) return false
    return schemaShadowed(sid)
  }
  /** varName convenience form — resolves sid via idOf (precise path only,
   *  same discipline as slotVT/slotI32CertainAt: a poisoned/structural name
   *  answers false here, leaving the caller's own raw-shadow fallback in
   *  charge, exactly the pre-fix behavior for that narrow edge). */
  ctx.schema.slotBigintBoxedAt = (varName, prop) => {
    const id = ctx.schema.idOf(varName)
    return id != null && ctx.schema.slotBigintBoxedBySid(id, prop)
  }

  /** READ-usable fact: narrower than slotBigintBoxedBySid above by one
   *  clause — the slot's census must ALSO be uniformly BIGINT (slotTypes,
   *  the clash-poisoned lattice — not slotBigintObserved's OR-join). Only
   *  when EVERY write to (sid, prop) is proven BIGINT is a static read
   *  allowed to UNCONDITIONALLY unbox: a slot that also holds a real,
   *  unboxed NUMBER somewhere would have some instances misread as a box
   *  payload otherwise — the exact class of bug this design forbids (a
   *  runtime tag guard on possibly-raw bits is UNSOUND, since raw bigint
   *  bits can coincide with a PTR.BIGINT NaN-box pattern; the pairing must
   *  be static). False on any hazarded/unproven slot leaves the box flowing
   *  untouched — registry-aware consumers ($__dyn_get/$__typeof/$__to_num/
   *  $__eq) already handle PTR.BIGINT per Slice 3. Consumed by
   *  emitSchemaSlotRead's call sites (module/core.js). */
  ctx.schema.slotBigintProvenBySid = (sid, prop) => {
    if (!CARRIER_BOX || sid == null || slotHazarded(sid, prop, true)) return false
    const idx = ctx.schema.list[sid]?.indexOf(prop)
    if (idx == null || idx < 0) return false
    return ctx.schema.slotTypes.get(sid)?.[idx] === VAL.BIGINT && ctx.schema.slotBigintBoxedBySid(sid, prop)
  }
  ctx.schema.slotBigintProvenAt = (varName, prop) => {
    const ids = ctx.func.refinements?.get(varName)?.schemaIds
    if (ids?.length) return ids.every(id => ctx.schema.slotBigintProvenBySid(id, prop))
    return ctx.schema.slotBigintProvenBySid(ctx.schema.idOf(varName), prop)
  }
}
