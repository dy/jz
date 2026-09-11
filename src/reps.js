/**
 * ValueRep storage + VAL lattice lookups (ctx-backed, cycle-free).
 *
 * Thin accessors shared by ir, emit, stdlib, and analyze. Keeps heavy AST
 * walkers in analyze.js without pulling them into ir.js.
 *
 * ## Lookup priority (lookupValType / lookupNotString)
 *
 * A single binding can carry several pieces of type knowledge, set at different
 * lifecycle phases. Accessors resolve them in this fixed order — first hit wins:
 *
 *   1. `ctx.func.refinements`           flow-sensitive (typeof/instanceof guard)
 *   2. `ctx.func.localValTypesOverlay`  call-site / loop-iter overlay (transient)
 *   3. `ctx.func.localReps`             per-function plan/analyze fact (durable)
 *   4. `ctx.scope.globalValTypes`       module-level binding (durable)
 *   5. settled summary, except HASH     semantic fallback (read-only)
 *
 * A summary HASH is not physical allocation provenance: a prepared IIFE or
 * spread can have that flow kind while carrying an OBJECT. Dictionary lowering
 * is owned by the local/global plans above, so HASH deliberately falls through.
 * Writes go through `updateRep` (#3 mutator) / `updateGlobalRep` (#4 mutator).
 * Refinements (#1) are managed by `withRefinements` in emit; overlay (#2) is
 * scoped by call/loop-emit code and torn down when the scope exits.
 *
 * Mutation sites by phase:
 *   plan.js          — initial reps from prepare-pass typing
 *   analyze.js       — boxing decisions, schema bindings, sched facts
 *   compile/index.js — closure-arg upgrades, propagation across calls
 *   emit.js          — withRefinements / overlay, transient narrowing only
 *
 * @module reps
 */

import { DBG_INVARIANTS } from './debug.js'
import { ctx } from './ctx.js'

/** Value kinds — method dispatch, schema, carrier selection. */
export const VAL = {
  NUMBER: 'number', ARRAY: 'array', STRING: 'string',
  OBJECT: 'object', HASH: 'hash', SET: 'set', MAP: 'map',
  CLOSURE: 'closure', TYPED: 'typed', REGEX: 'regex',
  BIGINT: 'bigint', BUFFER: 'buffer', DATE: 'date',
  BOOL: 'boolean',
}

/**
 * A binding's inferred representation. Every field optional; absence = "unknown".
 * Written only through updateRep / updateGlobalRep, plus a few direct r.wasm /
 * r.typedCtor mutations in narrow.js's signature fixpoint. This is the *closed*
 * shape: REP_FIELDS is the single source of truth — it gates updateRep in debug
 * mode and drives repView, so a typo'd key surfaces loudly instead of silently
 * vanishing into the open `{...prev, ...fields}` spread.
 *
 * @typedef {Object} ValueRep
 * @property {string}  [val]              VAL.* kind (number/array/string/…).
 * @property {number}  [ptrKind]          PTR.* pointer class for NaN-box rebox.
 * @property {number}  [ptrAux]           aux bits in the NaN-box (schema id / elem type).
 * @property {number}  [schemaId]         object-shape id (OBJECT kind).
 * @property {number}  [intConst]         proven constant integer value.
 * @property {boolean} [intCertain]       integer-valued on every path.
 * @property {boolean} [notString]        proven not a string (skips string-path guards).
 * @property {number}  [arrayElemSchema]  element object-schema id for arrays.
 * @property {number[]} [arrayElemSchemaSet] CLOSED element-schema union for arrays whose
 *   every element provably carries one of these sids (heterogeneous record streams —
 *   the tagged-union shape). Poison rules identical to arrayElemSchema except that
 *   mere sid disagreement accumulates instead of poisoning; any unknown-schema
 *   source still kills the fact. Sorted, deduped, length ≥ 2.
 * @property {number[]} [schemaIdSet] closed schema union for an OBJECT binding drawn
 *   from a set-carrying array element (`const o = rows[i]`). Enables union-agreeing
 *   slot reads and discriminant refinement without a runtime guard.
 * @property {string}  [arrayElemValType] element VAL.* kind for arrays.
 * @property {boolean} [arrayHoles] a construct-then-fill array (`new Array(n)`): an unwritten slot is a hole
 *   reading undefined, so an identity compare of an element stays a runtime check.
 * @property {number[]} [arrayElemRange] closed integer hull for a typed array's observable elements.
 * @property {number[]} [range] closed integer hull of THIS binding's value — stamped by analyze
 *   for never-reassigned decls whose init has a finite intExprRange (masks, ternary hulls,
 *   bounded products). Feeds i32-provability (exprType `*`, div→shift strength reduction).
 * @property {number}   [arrayCap] maximum builder length reserved at its literal initialization.
 * @property {number}   [arrayLen] fixed length of a whole-program internal plain array.
 * @property {string}  [arrayElemElemValType] nested element VAL.* kind (`X[i][j]`) for arrays of arrays.
 * @property {string}  [arrayElemTypedCtor] element TypedArray ctor (`new.Float32Array`) for an
 *   array whose elements are all typed arrays of one ctor (`Array.from(n,()=>new Float32Array())`),
 *   so `arr[i]` is a known typed array and `arr[i][j]` inlines instead of runtime aux-dispatch.
 * @property {string}  [carrier]          abi carrier id override (e.g. 'jsstring').
 * @property {boolean} [unsigned]         i32 carries an unsigned value (`>>>` result).
 * @property {*}       [jsonShape]        inferred shape for the JSON.stringify fast path.
 * @property {string}  [typedCtor]        TypedArray ctor name (TYPED kind); null = bimorphic.
 * @property {string}  [wasm]             wasm storage type 'i32'|'f64' (narrow.js fixpoint).
 * @property {boolean} [nullable]         summary includes null or a missing value.
 * @property {boolean} [mayBeUndefined]   presence projected from the summary.
 * @property {string}  [presentVal]       payload kind when a nullable binding is present.
 * @property {string}  [presence]         'present' or 'maybe-undef'.
 * @property {boolean} [recvArrTyped]     receiver-kind CLASS proof, the
 *   follow-up to the numeric-key unknown-receiver soundness fix:
 *   true iff every live call site's argument at this position proves VAL.ARRAY OR
 *   VAL.TYPED — never both the SAME site (that's ordinary `val` consensus, exact-
 *   kind), but POSSIBLY a different one of the two at different sites (`f(anArray)`
 *   at one call, `f(aFloat64Array)` at another) — a mix `val`'s exact-equality meet
 *   would poison to TOP even though both kinds are STATICALLY interchangeable for
 *   any consumer that only needs "heap-indexable, never OBJECT/HASH/STRING/etc":
 *   `$__typed_idx` (module/core.js) already dispatches ARRAY vs TYPED itself at
 *   runtime, so a receiver proven to be always one-or-the-other can skip the
 *   ptrTypeEq tag TEST module/array.js's numeric-key unproven-receiver guard
 *   emits, straight to the bare `__typed_idx` call — sound because OBJECT/HASH
 *   (the case the guard exists to catch) is EXCLUDED by the proof, not because
 *   the exact kind is known. A narrower, class-level sibling of `val` — set
 *   by the summary's tag set (narrow/index.js seedParamKinds: every argument an
 *   array or a typed array), stored alongside it rather than replacing it so
 *   every OTHER `val`-exact consumer (`.push`, method dispatch, dot-property…)
 *   is untouched. Purely an optimization fact: false/absent is always safe (the
 *   guard just stays); never gates soundness.
 */
export const REP_FIELDS = new Set([
  'val', 'ptrKind', 'ptrAux', 'schemaId', 'intConst', 'intCertain', 'notString',
  'arrayElemSchema', 'arrayElemSchemaSet', 'schemaIdSet', 'arrayElemValType', 'arrayHoles', 'arrayElemRange', 'arrayLen', 'arrayCap', 'arrayElemElemValType', 'arrayElemTypedCtor', 'carrier', 'unsigned', 'jsonShape', 'range',
  'typedCtor', 'wasm', 'nullable', 'neverGrown', 'ownCurrent', 'recvArrTyped',
  'mayBeUndefined', 'presentVal', 'presence',
])

const assertRepFields = (name, fields) => {
  for (const k in fields)
    if (!REP_FIELDS.has(k))
      throw new Error(`updateRep('${name}', {${k}}): unknown ValueRep field — typo, or add it to REP_FIELDS in reps.js`)
}

/** @returns {ValueRep|undefined} */
export const repOf = name => ctx.func.localReps?.get(name)

export const updateRep = (name, fields) => {
  if (DBG_INVARIANTS) {
    assertRepFields(name, fields)
    // FunctionPlan freeze (Stage 2 exit): once a function's body emission
    // begins, its durable reps are read-only. Discovery belongs in plan
    // passes; emission products ride transient channels (localValTypesOverlay,
    // closureAux). A throw here means a new discovery write crept into emit.
    if (ctx.func.repsFrozen)
      throw new Error(`updateRep('${name}', {${Object.keys(fields)}}) during emission — FunctionPlan is frozen`)
  }
  const m = ctx.func.localReps ||= new Map()
  const prev = m.get(name)
  const next = prev ? { ...prev, ...fields } : { ...fields }
  // A field set to undefined clears it. Only `fields` can carry one: every
  // stored rep was cleaned here. Counted without a key array (a hot path:
  // a fact per binding per pass).
  let size = 0, cleared = false
  for (const k in next) { if (next[k] === undefined) cleared = true; else size++ }
  if (cleared) for (const k in fields) if (fields[k] === undefined) delete next[k]
  if (size === 0) m.delete(name)
  else m.set(name, next)
}

export const repOfGlobal = name => ctx.scope.globalReps?.get(name)

export const updateGlobalRep = (name, fields) => {
  if (DBG_INVARIANTS) assertRepFields(name, fields)
  const m = ctx.scope.globalReps ||= new Map()
  const prev = m.get(name)
  m.set(name, prev ? { ...prev, ...fields } : { ...fields })
}

export const lookupValType = name => {
  const r = ctx.func.refinements
  if (r?.size) { const v = r.get(name)?.val; if (v) return v }
  const ov = ctx.func.localValTypesOverlay
  const hasOverlayValues = ov?.size || (ov?.mapOverlay === true && (ov.own?.size || ov.base?.size))
  if (hasOverlayValues) { const v = ov.get(name); if (v) return typeof v === 'number' ? ctx.summary.valOfKind(v) : v }
  // The program summary (src/summary): the binding's kind in the current function's scope.
  const planned = ctx.func.localReps?.get(name)?.val || ctx.scope.globalValTypes?.get(name)
  if (planned) return planned
  const summarized = ctx.summary?.at(ctx.func.current)?.valOf(name)
  return summarized === VAL.HASH ? null : summarized || null
}

export const lookupNotString = name => {
  const r = ctx.func.refinements
  if (r?.size && r.get(name)?.notString) return true
  return ctx.func.localReps?.get(name)?.notString === true
}

/** Full domain of VAL.* kinds — the powerset universe `possibleKinds`/
 * `isDisjointFrom` range over (`.work/archive/lattice-design.md` §1.1, §1.6).
 * INVARIANT: this stays a FROZEN ARRAY, not a Set — an exported mutable Set
 * would let any consumer shrink/grow the universe globally and Object.freeze cannot
 * freeze Set contents. Consumers build their own local sets from it
 * (spread/filter) or iterate it for a universe join. */
export const KIND_UNIVERSE = Object.freeze(Object.values(VAL))

/**
 * `isDisjointFrom(name, kindSet)` — sound iff `name`'s possible-kind set is
 * PROVABLY disjoint from `kindSet` (`.work/archive/lattice-design.md` §3's
 * projection catalog: true only if `kindsOf(name) ∩ kindSet = ∅`). Slice 2's
 * first-consumer precedent: re-expresses the EXISTING `recvArrTyped` class
 * proof (this file's doc above — "every live call site proves ARRAY or
 * TYPED", never poisoned by disagreement) through the projection idiom
 * later slices reuse — NO computation change, `recvArrTyped` stays the only
 * class-level fact this projection draws on until a general `possibleKinds`
 * Set lands (design doc §5, Slice 6/7).
 */
export const isDisjointFrom = (name, kindSet) => {
  const r = ctx.func.localReps?.get(name)
  return r?.recvArrTyped === true && !kindSet.has(VAL.ARRAY) && !kindSet.has(VAL.TYPED)
}

/**
 * `mayBeUndefined(name)` — Fact.`presence` projection (`.work/archive/lattice-
 * design.md` §1.2, §3's catalog row): true iff `name`'s binding has ever
 * been observed to possibly be real JS `undefined` (monotone OR — "false =
 * PRESENT, true = MAYBE_UNDEF" per the Fact JSDoc in param-reps.js). Slice
 * 3's precedent: re-homes the EXISTING `mayBeUndefined` REP field (this
 * file's own doc above — "already sound today under existential semantics
 * ... not migrated conceptually, only re-homed") through the named
 * projection idiom Slice 2 established — NO computation change.
 */
export const mayBeUndefined = name => ctx.func.localReps?.get(name)?.mayBeUndefined === true

// A local read only by numeric coercions can normalize missing values on write.
// Parameters and captured cells keep their boundary representation.
export const numericStorage = name => typeof name === 'string' && ctx.func.locals?.has(name) &&
  !ctx.func.boxed?.has(name) && !ctx.func.current?.params?.some(p => p.name === name) &&
  ctx.summary?.at(ctx.func.current)?.numericStorage(name) === true
