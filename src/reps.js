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
 *   PTR.BIGINT heap box (round-3/4 boundary boxing, .work/carrier-representation-design.md) —
 *   false (the default/absent case) means raw i64-as-f64 forever. true iff some
 *   reachable use is a kind-erasing W-sink: an intra-body sink (analyze.js walk —
 *   dyn-prop/array-elem store, Set/Map, ternary-nullish merge, closure capture,
 *   DataView.setBig/getBig64) OR an inter-function one (narrow.js fixpoint — a call
 *   site/return position not proven uniformly BIGINT, or a destructured param,
 *   fail-closed). Boxed at the point of write; every later read of the name unboxes
 *   explicitly before raw i64 ops (ir.js boxBigInt/unboxBigInt).
 * @property {boolean} [mayBeUndefined]   binding's value can be real JS `undefined`
 *   at runtime despite a definite `val` kind claim — the container-read
 *   generalization of `nullable` (.work/todo.md §deletion-sweep
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
 *   `presentVal` answers exactly like the read node itself would at every
 *   existing censusMaybeUndefined chokepoint (ir.js toNumF64/toStrI64,
 *   emit.js nullableOperand/bigIntOperand/bigIntUnary/bigintMixReject/`+`-
 *   concat). INVARIANT: the arm must read `presentVal` here, not `val` —
 *   `val` never settles non-null for a census-shaped RHS at ANY hop (a
 *   census-shaped call-site ARGUMENT still contributes null to
 *   hardParamVal's own fold, poisoning specialization rather than claiming a
 *   kind), so `val` stays permanently unproven for this shape. `presentVal`
 *   (this file, its own entry below) is a SEPARATE, poison-disciplined kind
 *   claim that never touches `val`. Whether any given chokepoint above also
 *   needs its own outer `valTypeOf(node) === VAL.SOMETHING` gate widened to
 *   consult `presentVal` as a fallback (not just this REP-fallback arm
 *   reaching a non-null claim) is open — see .work/todo.md §deletion-sweep
 *   for scope. func.valResultMayBeUndefined / ctx.closure.
 *   valResultMayBeUndefined (Map<closureBodyName, true>) carry the return-
 *   kind join's result alongside func.valResult / ctx.closure.valResult —
 *   parallel facts, not merged into those (their return shapes have live
 *   consumers, kind-traits.js calleeValType, this design must not disturb).
 * @property {'present'|'maybe-undef'} [presence]  Tri-state sibling of
 *   `mayBeUndefined`: the boolean alone stays positive-evidence-only, so
 *   `presence` exists to distinguish "never observed maybe-undef" from
 *   "positively proven present" — a full 4-point lattice or coverage bit is
 *   future scope (.work/todo.md). Absent = UNKNOWN (not-yet-analyzed — the SAME
 *   silence `mayBeUndefined`'s `false`/absent already conflates with
 *   "proven present", which is exactly the gap this field closes: `!mayBeUndefined(name)`
 *   remains NOT a definitelyPresent proof (the standing ruling — the boolean
 *   alone still can't distinguish "never observed maybe-undef" from
 *   "positively proven present"), but `presence === 'present'` IS a real
 *   proof. `'maybe-undef'` is set at every site that sets `mayBeUndefined:
 *   true` today (decl/reassign census-shaped RHS — analyze.js; param
 *   propagation and closure-capture seed — compile/index.js; the paramReps
 *   Fact-level destructured-param-body and call-site-union writes —
 *   narrow.js) — same monotone-OR-safe algebra, never un-set. `'present'`
 *   is a SEPARATE, much narrower producer (analyze.js's decl site only, one
 *   arm): a decl whose init is provably non-nullish (`!mayBeNullish(rhs)` —
 *   the SAME conservative, fail-closed-on-any-call/member-read predicate
 *   `nullable`'s own producer already uses) AND never reassigned anywhere in
 *   the body (`writeCount(body, name, 0) === 0` — the SAME never-reassigned
 *   check `range`'s own decl producer already uses, just above). Mutually
 *   exclusive with the `'maybe-undef'` arm at that site by construction (one
 *   `if`/`else if`, not two independent `if`s) — a census-shaped RHS is
 *   already `mayBeNullish`-true (a call/bracket read fails `mayBeNullish`
 *   closed), so the two arms never both fire for the same write. INVARIANT:
 *   stay conservative — few `'present'` marks are fine, a missed one just
 *   stays UNKNOWN, never wrong. `mayBeUndefined` itself is UNCHANGED (still
 *   written at every site, still the sole field every existing consumer
 *   reads) — `presence` is purely additive; a `mayBeUndefined(name)`
 *   projection could derive as `presence(name) === 'maybe-undef'` but no
 *   consumer does yet — safe to wire up later, same as `kindsCoverage`.
 * @property {string}  [presentVal]       VAL.* kind the census claims for a
 *   binding's value WHEN PRESENT — the opt-in KIND-carrying sibling of
 *   `mayBeUndefined` (.work/todo.md §deletion-sweep §14's opt-in
 *   re-enablement gate, superseding an earlier global-VT-promotion path).
 *   NEVER a substitute
 *   for `val` and NEVER consulted by `valTypeOf`/`lookupValType` — `val` stays
 *   exact-only permanently, this is a SEPARATE fact only an explicit opt-in
 *   consumer may ask for (kind.js `censusMaybeUndefinedKind`'s bare-name arm,
 *   below). Producer: analyze.js `analyzeValTypes`' decl/reassign call sites
 *   (the same two `setVal` sites), via a dedicated `makeValTracker` instance
 *   (own poison set, NOT a spread-merge like `mayBeUndefined`'s boolean OR) —
 *   fed `censusMaybeUndefinedKind(rhs)` unconditionally on every write. This
 *   is deliberate and required, not incidental: unlike `mayBeUndefined`
 *   (a monotonic-safe boolean — staying true after a later non-census write
 *   only costs an unneeded defensive check), `presentVal` is an exact KIND
 *   claim — a later write that DISAGREES (a different kind, or no census
 *   claim at all) must POISON it exactly the way `val` itself poisons on
 *   disagreement (makeValTracker's existing discipline, reused verbatim),
 *   else a chokepoint could trust a stale kind for a runtime value the
 *   census claim no longer describes. Because every non-census write
 *   contributes `null` to this tracker (poisoning), and every census-shaped
 *   write contributes `null` to `val`'s own tracker (censusMaybeUndefinedKind
 *   never feeds `val`), `val` and `presentVal` are mutually exclusive by
 *   construction for a DECL/REASSIGN local — never both non-null for the
 *   same such binding. NOT true for a PARAM: `val` there is set by narrow.js's
 *   entirely separate call-site-argument fixpoint (`hardParamVal`), which
 *   proves a kind from the argument's OWN valTypeOf, independent of whether
 *   the argument expression happens to be census-shaped — so a param CAN
 *   carry both a real `val` AND `mayBeUndefined = true` (Slice 2's
 *   `censusShapedNode` deliberately over-approximates to any `[]`/`.`
 *   2-arg read, including a plain array/typed-array OOB-possible index, not
 *   just dict/Map). INVARIANT: kind.js's REP-fallback arm must check
 *   `presentVal` first, `val` second — checking `presentVal` alone regresses
 *   the param-hop shape test/dyn-keys.js pins, since both fields stay live
 *   for their own distinct binding shapes. Same flow-INsensitive whole-body-unification
 *   scope as `val`'s own documented cost ("a later write that unconditionally
 *   overwrites the initializer still poisons" — accepted, not fixed, matching
 *   `val`'s own precedent). `censusMaybeUndefinedKind(rhs)` already composes
 *   direct census-shaped nodes, one-hop bare-name copy-through (this field),
 *   and call-results in one function, so the producer call needs no separate
 *   helper — DRY, one predicate, matching §4's "not one [check] per site"
 *   discipline.
 *
 *   PARAM propagation extends the decl/reassign-only scope above to params,
 *   the same size-of-surface split `mayBeUndefined` itself went through:
 *   narrow.js's `hardParamPresentVal`, modeled on `hardParamVal` (the SAME
 *   poison-on-disagreement fold this field's decl producer already uses, NOT
 *   `mayBeUndefined`'s monotonic OR) — every live call site's argument must
 *   independently resolve the SAME presentVal kind (kind.js
 *   `exprPresentValIn`/`namePresentValInBody`, the ctx-independent-at-plan-
 *   time KIND analogue of `exprMayBeUndefinedIn`/`nameMayBeUndefinedInBody`),
 *   or the param declines (no claim, never a wrong one). Seeded onto the
 *   param's entry-time rep in compile/index.js exactly where `r.val` is,
 *   with the SAME `!reassigned` guard (this field shares `val`'s exact-claim
 *   discipline, not `mayBeUndefined`'s unconditional-safe one). INVARIANT:
 *   a param-hop BigInt-unary site (`const f = (v) => -v; f(m.get('x'))`)
 *   needs exactly this seeded fact and nothing else — the consumer side
 *   (emitNeg's OR-arm, other `censusMaybeUndefinedKind`-consulting
 *   chokepoints) already asks unconditionally, so seeding the fact onto the
 *   param is the entire fix.
 * @property {Set<string>} [dictValueValType] Set<VAL.*> — every kind ever
 *   observed for a value written through `name[key] = v` (any key, HASH
 *   dict-mode local or global). Product-lattice Slice 7: UNION lattice, not
 *   first-wins-then-clash (this is an existential fact, per
 *   .work/lattice-design.md §thesis — disagreeing writes widen the Set, an
 *   unresolved write unions in the full KIND_UNIVERSE/TOP instead of a null
 *   sentinel). `dictValueKindOf` (kind.js) projects the EXACT-OR-NULL answer
 *   consumers historically got (`size===1` → that kind, else `null`) —
 *   byte-identical to the old poison-to-null field. `censusKindsOf` (kind.js,
 *   opt-in only, per the COORDINATOR RULING on OQ1) exposes the raw union.
 *   Additive-only fact (dict-value-census design, .work/todo.md §deletion-sweep):
 *   NEVER a substitute for `val`, never mutated alongside it. Two producers
 *   remain live — analyze.js's same-body scan (local half, updateRep) and
 *   observeProgramSlots' dictValueTypes census (global half, updateGlobalRep)
 *   — the fact itself stays additive-only, never a `val` substitute. Two
 *   consumers, two different re-enablement states (.work/todo.md
 *   §deletion-sweep, Slice 1 of §8): `dictValueKindOf` (kind.js) — the
 *   helper VT['[]']/VT['.']'s dict-mode fold used to call to promote a dict
 *   read to an EXACT `val` — stays DORMANT, called from nowhere; re-enabling
 *   THAT is Slice 4, gated on §5's full criteria. `censusMaybeUndefinedKind`'s
 *   dict arm (kind.js) — a DIFFERENT consumer, asking "is this specific node
 *   maybeUndefined-shaped", never "what val should VT[...] claim" — calls the
 *   SAME `dictValueKindOf` helper directly (bypassing VT/valTypeOf entirely)
 *   and is RE-ENABLED (Slice 1), now also answering a bare NAME whose rep
 *   carries `mayBeUndefined` (reps.js, this file). See
 *   .work/todo.md §deletion-sweep for the `mayBeUndefined` REP
 *   field this needs and full re-enablement criteria for the VT-side
 *   consumer. Do not wire dictValueKindOf back into VT['[]']/VT['.'] without
 *   first meeting §5.
 * @property {Set<string>} [mapValueValType] Set<VAL.*> — every kind ever
 *   observed for a value written through a proven-VAL.MAP receiver's
 *   `recv.set(k, v)` (any key) — dictValueValType's Map-census Tier 1
 *   sibling (.work/todo.md §deletion-sweep), same union lattice (product-
 *   lattice Slice 7), additive-only, NEVER a substitute for `val`. Two producers remain live — analyze.js's same-body
 *   scan (local half, updateRep) and observeProgramSlots' mapValueTypes
 *   census (global half, updateGlobalRep). Same two-consumer split as
 *   dictValueValType above: `mapValueKindOf` (kind.js) — VT['()']'s `.get`
 *   short-circuit — stays DORMANT (re-enabling it is Slice 4,
 *   .work/todo.md §deletion-sweep §5); `censusMaybeUndefinedKind`'s
 *   Map arm (kind.js), calling the SAME helper directly, is RE-ENABLED
 *   (Slice 1) alongside a bare-name REP fallback consulting the new
 *   `mayBeUndefined` field (this file). Do not wire mapValueKindOf back into
 *   VT['()'] without first meeting §5.
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
  'mapValueValType', 'mayBeUndefined', 'presentVal', 'presence',
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

/** Full domain of VAL.* kinds — the powerset universe `possibleKinds`/
 * `isDisjointFrom` range over (`.work/lattice-design.md` §1.1, §1.6).
 * INVARIANT: this stays a FROZEN ARRAY, not a Set — an exported mutable Set
 * would let any consumer shrink/grow the universe globally and Object.freeze cannot
 * freeze Set contents. Consumers build their own local sets from it
 * (spread/filter) or iterate it for a universe join — membership tests go
 * through `isKind` below. */
export const KIND_UNIVERSE = Object.freeze(Object.values(VAL))
const KIND_UNIVERSE_SET = new Set(KIND_UNIVERSE)
export const isKind = k => KIND_UNIVERSE_SET.has(k)

/**
 * `isDisjointFrom(name, kindSet)` — sound iff `name`'s possible-kind set is
 * PROVABLY disjoint from `kindSet` (`.work/lattice-design.md` §3's
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
 * `mayBeUndefined(name)` — Fact.`presence` projection (`.work/lattice-
 * design.md` §1.2, §3's catalog row): true iff `name`'s binding has ever
 * been observed to possibly be real JS `undefined` (monotone OR — "false =
 * PRESENT, true = MAYBE_UNDEF" per the Fact JSDoc in param-reps.js). Slice
 * 3's precedent: re-homes the EXISTING `mayBeUndefined` REP field (this
 * file's own doc above — "already sound today under existential semantics
 * ... not migrated conceptually, only re-homed") through the named
 * projection idiom Slice 2 established — NO computation change.
 */
export const mayBeUndefined = name => ctx.func.localReps?.get(name)?.mayBeUndefined === true
