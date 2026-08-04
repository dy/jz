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
 *
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
 * @property {number[]} [arrayElemRange] closed integer hull for a typed array's observable elements.
 * @property {number[]} [range] closed integer hull of THIS binding's value — stamped by analyze
 *   for never-reassigned decls whose init has a finite intExprRange (masks, ternary hulls,
 *   bounded products). Feeds i32-provability (exprType `*`, div→shift strength reduction).
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
 * @property {boolean} [nullable]         binding can hold null/undefined on some path
 *   (init or an assignment was a nullish literal) — suppresses the `=== null` /
 *   `=== undefined` constant-fold even when `val` is a definite non-null kind.
 * @property {boolean} [bigintBoxed]      VAL.BIGINT binding must materialize as a real
 *   PTR.BIGINT heap box (round-3/4 boundary boxing, .work/bigint-round3-design.md) —
 *   false (the default/absent case) means raw i64-as-f64 forever. true iff some
 *   reachable use is a kind-erasing W-sink: an intra-body sink (analyze.js walk —
 *   dyn-prop/array-elem store, Set/Map, ternary-nullish merge, closure capture,
 *   DataView.setBig/getBig64) OR an inter-function one (narrow.js fixpoint — a call
 *   site/return position not proven uniformly BIGINT, or a destructured param,
 *   fail-closed). Boxed at the point of write; every later read of the name unboxes
 *   explicitly before raw i64 ops (ir.js boxBigInt/unboxBigInt).
 * @property {boolean} [mayBeUndefined]   binding's value can be real JS `undefined`
 *   at runtime despite a definite `val` kind claim — the container-read
 *   generalization of `nullable` (.work/represented-maybe-undefined-design.md
 *   §2). Slice 1 (decl-time producer, analyze.js analyzeValTypes' `let`/
 *   `const`/`=` sites): true when the RHS is itself a dict/Map maybeUndefined-
 *   shaped read (censusMaybeUndefinedKind(rhs) != null) or a bare name that
 *   already carries the flag (copy-through). Slice 2 (§3 remaining — narrow.js
 *   param/return join, flow-types.js closure return-kind join, module/
 *   function.js closure-capture seed): the SAME whole-program call-site
 *   fixpoint/return-tail unification `nullable`/`bigintBoxed` already run
 *   through, joined via kind.js's ctx-independent `censusShapedNode`/
 *   `exprMayBeUndefinedIn` (real, ctx-aware census lookups would misread at
 *   plan time — same caveat narrow.js's BIGINT-nullable block documents for
 *   mayBeNullish). Fail-closed on a destructured param body (no per-call-site
 *   proof mechanism for what a destructured element holds); OR-joined across
 *   every live call site otherwise; an unwritten/untraced bare-name arg
 *   contributes no evidence (false) — narrower than nullable's blanket
 *   "unwritten → fail closed", matching this fact's own provenance-only
 *   scope. Consumer (both slices): censusMaybeUndefinedKind's REP-fallback
 *   arm (kind.js) — a bare name whose rep carries BOTH `mayBeUndefined` and a
 *   `val` answers exactly like the read node itself would at every existing
 *   censusMaybeUndefined chokepoint (ir.js toNumF64/toStrI64, emit.js
 *   nullableOperand/bigIntOperand/bigIntUnary, module/string.js/number.js/
 *   console.js). NOTE: still behaviorally INERT after Slice 2, for the same
 *   underlying reason as Slice 1 (not a slice-specific gap) — `val` never
 *   settles non-null for a name/argument/return that traces to a census-
 *   shaped read, at ANY hop, as long as VT['[]']/VT['.']/VT['()']
 *   (dictValueKindOf/mapValueKindOf) stay dormant (§5's re-enablement gate):
 *   a census-shaped call-site ARGUMENT contributes null to hardParamVal's own
 *   fold (poisoning specialization, never claiming a kind), so the param
 *   `val` this fact would ride alongside stays unproven right along with it.
 *   Slice 4 (re-enabling those VT folds) is what makes both slices' work
 *   load-bearing at once. func.valResultMayBeUndefined / ctx.closure.
 *   valResultMayBeUndefined (Map<closureBodyName, true>) carry the return-
 *   kind join's result alongside func.valResult / ctx.closure.valResult —
 *   parallel facts, not merged into those (their return shapes have live
 *   consumers, kind-traits.js calleeValType, this design must not disturb).
 * @property {string}  [dictValueValType] VAL.* kind of every value ever written
 *   through `name[key] = v` (any key, HASH dict-mode local or global) —
 *   first-wins-then-clash lattice, absent/null = unproven or mixed. Additive-
 *   only fact (dict-value-census design, .work/dict-value-census-design.md):
 *   NEVER a substitute for `val`, never mutated alongside it. Two producers
 *   remain live — analyze.js's same-body scan (local half, updateRep) and
 *   observeProgramSlots' dictValueTypes census (global half, updateGlobalRep)
 *   — the fact itself stays additive-only, never a `val` substitute. Two
 *   consumers, two different re-enablement states (represented-maybe-
 *   undefined-design.md, Slice 1 of §8): `dictValueKindOf` (kind.js) — the
 *   helper VT['[]']/VT['.']'s dict-mode fold used to call to promote a dict
 *   read to an EXACT `val` — stays DORMANT, called from nowhere; re-enabling
 *   THAT is Slice 4, gated on §5's full criteria. `censusMaybeUndefinedKind`'s
 *   dict arm (kind.js) — a DIFFERENT consumer, asking "is this specific node
 *   maybeUndefined-shaped", never "what val should VT[...] claim" — calls the
 *   SAME `dictValueKindOf` helper directly (bypassing VT/valTypeOf entirely)
 *   and is RE-ENABLED (Slice 1), now also answering a bare NAME whose rep
 *   carries `mayBeUndefined` (reps.js, this file). See
 *   .work/represented-maybe-undefined-design.md for the `mayBeUndefined` REP
 *   field this needs and full re-enablement criteria for the VT-side
 *   consumer. Do not wire dictValueKindOf back into VT['[]']/VT['.'] without
 *   first meeting §5.
 * @property {string}  [mapValueValType] VAL.* kind of every value ever written
 *   through a proven-VAL.MAP receiver's `recv.set(k, v)` (any key) —
 *   dictValueValType's Map-census Tier 1 sibling (.work/map-value-census-
 *   design.md), same first-wins-then-clash lattice, additive-only, NEVER a
 *   substitute for `val`. Two producers remain live — analyze.js's same-body
 *   scan (local half, updateRep) and observeProgramSlots' mapValueTypes
 *   census (global half, updateGlobalRep). Same two-consumer split as
 *   dictValueValType above: `mapValueKindOf` (kind.js) — VT['()']'s `.get`
 *   short-circuit — stays DORMANT (re-enabling it is Slice 4, .work/
 *   represented-maybe-undefined-design.md §5); `censusMaybeUndefinedKind`'s
 *   Map arm (kind.js), calling the SAME helper directly, is RE-ENABLED
 *   (Slice 1) alongside a bare-name REP fallback consulting the new
 *   `mayBeUndefined` field (this file). Do not wire mapValueKindOf back into
 *   VT['()'] without first meeting §5.
 * @property {boolean} [recvArrTyped]     receiver-kind CLASS proof (2026-07-31,
 *   named follow-up to the numeric-key unknown-receiver soundness fix, 9f46d517):
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
 *   the exact kind is known. A narrower, class-level sibling of `val` — same
 *   monotone-meet discipline (src/compile/narrow.js hardParamRecvArrTyped mirrors
 *   hardParamVal's site fold), stored alongside it rather than replacing it so
 *   every OTHER `val`-exact consumer (`.push`, method dispatch, dot-property…)
 *   is untouched. Purely an optimization fact: false/absent is always safe (the
 *   guard just stays); never gates soundness.
 */
export const REP_FIELDS = new Set([
  'val', 'ptrKind', 'ptrAux', 'schemaId', 'intConst', 'intCertain', 'notString',
  'arrayElemSchema', 'arrayElemSchemaSet', 'schemaIdSet', 'arrayElemValType', 'arrayElemRange', 'arrayLen', 'arrayElemElemValType', 'arrayElemTypedCtor', 'carrier', 'unsigned', 'jsonShape', 'range',
  'typedCtor', 'wasm', 'nullable', 'neverGrown', 'bigintBoxed', 'recvArrTyped', 'dictValueValType',
  'mapValueValType', 'mayBeUndefined',
])

const DBG_REPS = typeof process !== 'undefined' && process.env?.JZ_DEBUG_INVARIANTS === '1'
const assertRepFields = (name, fields) => {
  for (const k in fields)
    if (!REP_FIELDS.has(k))
      throw new Error(`updateRep('${name}', {${k}}): unknown ValueRep field — typo, or add it to REP_FIELDS in reps.js`)
}

/** @returns {ValueRep|undefined} */
export const repOf = name => ctx.func.localReps?.get(name)

export const updateRep = (name, fields) => {
  if (DBG_REPS) {
    assertRepFields(name, fields)
    // FunctionPlan freeze (Stage 2 exit): once a function's body emission
    // begins, its durable reps are read-only. Discovery belongs in plan
    // passes; emission products ride transient channels (localValTypesOverlay,
    // closureAux). A throw here means a new discovery write crept into emit.
    if (ctx.func.repsFrozen)
      throw new Error(`updateRep('${name}', {${Object.keys(fields)}}) during emission — FunctionPlan is frozen`)
  }
  const m = ctx.func.localReps ||= new Map()
  const prev = m.get(name) || {}
  const next = { ...prev, ...fields }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  if (Object.keys(next).length === 0) m.delete(name)
  else m.set(name, next)
}

export const repOfGlobal = name => ctx.scope.globalReps?.get(name)

export const updateGlobalRep = (name, fields) => {
  if (DBG_REPS) assertRepFields(name, fields)
  const m = ctx.scope.globalReps ||= new Map()
  const prev = m.get(name)
  m.set(name, prev ? { ...prev, ...fields } : { ...fields })
}

export const lookupValType = name => {
  const r = ctx.func.refinements
  if (r?.size) { const v = r.get(name)?.val; if (v) return v }
  const ov = ctx.func.localValTypesOverlay
  if (ov?.size) { const v = ov.get(name); if (v) return v }
  return ctx.func.localReps?.get(name)?.val || ctx.scope.globalValTypes?.get(name) || null
}

export const lookupNotString = name => {
  const r = ctx.func.refinements
  if (r?.size && r.get(name)?.notString) return true
  return ctx.func.localReps?.get(name)?.notString === true
}
