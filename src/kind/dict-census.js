/**
 * Dict/Map value-kind census — whole-program tracking of "every VAL kind
 * ever written through `name[dynKey]=v` / `map.set(dynKey,v)`", consulted
 * ONLY through the gated projections below (`dictValueKindOf`/
 * `mapValueKindOf`/`censusMaybeUndefinedKind`/…), never wired into the VT
 * dispatch table's general `[]`/`.`/`()` resolution — see kind/val-type-of.js's
 * `VT['[]']`/`VT['.']`/`VT['()']` own "INVARIANT: NO dict-mode receiver fold
 * here" comments for the soundness argument this family exists behind.
 * Three prior attempts to promote this census into the general dispatch were
 * reverted as unsound (censusKindsOf's own doc, below) — this logic is moved
 * verbatim from kind.js, unedited (.work/archive/kind-split.md §3).
 *
 * Split out of kind.js (pipeline-minimality slice, .work/archive/kind-split.md).
 *
 * @module kind/dict-census
 */

import { ctx, getFactStore } from '../ctx.js'
import { VAL, lookupValType, repOf, mayBeUndefined } from '../reps.js'
import { commaList, isBlockBody, returnExprs, alwaysReturns, walkAst } from '../ast.js'

// Dict-value-type census consumer — an INTERNAL HELPER ONLY
// (.work/archive/todo.md §deletion-sweep Slice 1).
// `name[key]`/`name.prop` on a HASH dict-mode receiver: the VAL.* kind of
// every value ever WRITTEN through `name[anyKey] = v`
// (.work/archive/todo.md §deletion-sweep §2, nameEscapes alias gate per
// .work/archive/todo.md §deletion-sweep §2 Slice 3). INVARIANT: this stays OUT of
// VT['[]']/VT['.']'s own dict-mode fold — promoting a census read to an
// exact VT globally would make every OTHER consumer of that VT — composed
// expressions, container storage, kind-specific dispatch, string `+`,
// BigInt joint ops — silently bypass the mayBeUndefined protection unless it
// separately remembers to call censusMaybeUndefined too; opt-out instead of
// opt-in, unsound by construction. .work/archive/todo.md §deletion-sweep §14 is the
// re-enablement path: an opt-in `presentVal` fact consumers must explicitly
// ask for, not a global VT promotion. Called ONLY from
// censusMaybeUndefinedKind below, which asks a narrower question ("is THIS
// node maybeUndefined-shaped, and what kind does the census claim for it")
// that bypasses VT/valTypeOf entirely — restoring this helper for that
// caller alone reopens no soundness hole: nothing outside
// censusMaybeUndefinedKind's own mayBeUndefined-gated chokepoints ever sees
// this claim.
//
// SOUNDNESS: an unwritten key reads back NaN-boxed undefined at runtime, so
// this fact is trustworthy ONLY where NUMBER arithmetic/relational semantics
// coincide with ToNumber(undefined) — the same precedent as the unproven
// TYPED-index read (kind.js:257-263 above). Identity (`===`/`==` against
// null/undefined) and typeof MUST NOT const-fold on it: that carve-out lives
// in emit.js's `nullableOperand`, which calls censusMaybeUndefined directly.
// nameEscapes ALIAS GATE (.work/archive/todo.md §deletion-sweep §2, Slice 3): the
// census keys observations by SYNTACTIC receiver name (analyze.js's
// dictValueTypeOf same-body scan, program-facts.js's observeDictValue global
// half) — a write through an ALIAS (`const a = d; a[k] = v`) is invisible to
// a census keyed on `d`, leaving a stale kind live after the alias write
// changes it. `ctx.types.nameEscapes` (program-facts.js, installed
// plan/index.js) is a whole-program, name-keyed set of every binding read in
// a VALUE position — exactly the set of names that COULD have been aliased.
// dictValueKindSet(name) — the raw union Set behind dictValueKindOf's
// exact-or-null projection (product-lattice Slice 7). Same alias/receiver
// gating as dictValueKindOf; returns undefined where dictValueKindOf would
// return null (gated out or unobserved) so callers can distinguish "no
// evidence" (∅, not even queried) from a genuine empty answer if that
// distinction is ever needed — today's two callers (dictValueKindOf,
// censusKindsOf) both treat a falsy return as "nothing."
function dictValueKindSet(name) {
  if (ctx.types?.nameEscapes?.has(name)) return undefined
  const local = ctx.func.localReps?.get(name)?.dictValueValType
  if (local) return local
  if (!ctx.func.localReps?.has(name) && ctx.types?.dynWriteVars?.has(name))
    return ctx.scope.globalReps?.get(name)?.dictValueValType
  return undefined
}
export function dictValueKindOf(name) {
  const s = dictValueKindSet(name)
  return s && s.size === 1 ? [...s][0] : null
}

// RECEIVER-KIND GUARD (.work/archive/todo.md §deletion-sweep Slice 1; test/simd.js
// pins the regression this guards against): the dict census's GLOBAL half
// (program-facts.js) records a dictValueValType fact for ANY
// `name[dynKey] = v`, receiver-kind-BLIND — a Float64Array named `a` written
// via `a[i] = …` gets one too. In VT['[]']/VT['.']'s real dispatch this is
// harmless (the TYPED/STRING/tracked-Array<VAL> branches resolve the
// receiver FIRST and dictValueKindOf's fallback is never reached), but
// censusMaybeUndefinedKind below calls dictValueKindOf DIRECTLY, bypassing
// that elimination order — replicate the same three name-keyed,
// key-independent receiver-kind facts VT's real dispatch checks first.
const dictCensusReceiverIsLive = (name) => {
  if (lookupValType(name) === VAL.TYPED || lookupValType(name) === VAL.STRING) return false
  if (ctx.func.localReps?.get(name)?.arrayElemValType) return false
  if (!ctx.func.localReps?.has(name) && ctx.scope.globalReps?.get(name)?.arrayElemValType
      && !ctx.types?.dynWriteVars?.has(name)) return false
  return true
}

// Map-value-type census Tier 1 consumer — an INTERNAL HELPER ONLY, same
// status as dictValueKindOf above. INVARIANT: this stays OUT of
// VT['()']'s `.get` short-circuit — see dictValueKindOf's own doc comment
// above for the soundness argument; re-enablement path is §14's opt-in
// presentVal model, not this global promotion. Called ONLY from censusMaybeUndefinedKind below.
// `mapValueValType` is "every value ever WRITTEN through recv.set(anyKey,
// v)", unsound to promote to an EXACT VAL.* kind at a `.get()` read site the
// same two ways dictValueKindOf is: an ABSENT key reads real JS `undefined`
// regardless of the observed kind (closed by censusMaybeUndefined's Map arm
// routing through the mayBeUndefined join), and a write through an ALIAS is
// invisible to a census keyed on the original receiver name (closed by the
// SAME nameEscapes gate, carried from its first line here). Receiver gate is
// a HARD classification (`new Map()` → CALLEE_VAL + recordGlobalRep,
// kind-traits.js) — `lookupValType(name) === VAL.MAP` alone proves the
// receiver, no dynWriteVars-analog proxy needed on the global side. (Split
// commit note: this reads `lookupValType` directly rather than the general
// `valTypeOf` — provably identical for a value already proven a string by
// the guard just below, since `valTypeOf`'s own string branch is exactly
// `return lookupValType(expr)` with no other logic in between. The
// substitution breaks what would otherwise be a real kind.js ↔
// kind/val-type-of.js import cycle — jz's own self-host module graph
// rejects cycles outright, see .work/archive/kind-split.md §4 — without touching
// the census/promotion soundness logic this file's other comments guard.)
// mapValueKindSet(name) — mapValueKindOf's raw-Set sibling, same shape as
// dictValueKindSet above (product-lattice Slice 7).
function mapValueKindSet(name) {
  if (typeof name !== 'string' || lookupValType(name) !== VAL.MAP) return undefined
  if (ctx.types?.nameEscapes?.has(name)) return undefined
  const local = ctx.func.localReps?.get(name)?.mapValueValType
  if (local) return local
  if (!ctx.func.localReps?.has(name)) return ctx.scope.globalReps?.get(name)?.mapValueValType
  return undefined
}
export function mapValueKindOf(name) {
  const s = mapValueKindSet(name)
  return s && s.size === 1 ? [...s][0] : null
}

// censusKindsOf(name) — OPT-IN, set-valued sibling of dictValueKindOf/
// mapValueKindOf (COORDINATOR RULING on OQ1, .work/archive/lattice-design.md: a
// census-derived kind union must surface ONLY through its own opt-in
// projection, never the general Fact.possibleKinds field a future slice
// exposes for every OTHER kind question — mirrors the presentVal precedent:
// a real, individually-gated consumer list built one caller at a time, never
// a blanket promotion; three prior attempts to promote this exact axis
// globally were reverted as unsound). ZERO consumers as of product-lattice Slice 1
// (.work/archive/lattice-design.md §5) — the structural landing only. Folds through
// the SAME `joinKinds` union primitive (param-reps.js) every later
// Fact-shaped field will use, so this is the primitive's first real caller,
// not a bespoke Set construction.
//
// PRECISION (product-lattice Slice 7): the underlying producers
// (analyze.js's dictValueTypeOf/mapValueTypeOf, program-facts.js's
// observeDictValue/poisonDictValue) now UNION disagreeing writes instead of
// collapsing to null (retiring the universal/poison algebra FINDING-7 names
// as wrong for this existential question) — this projection reads the raw
// Set those producers build (dictValueKindSet/mapValueKindSet, the same
// gated, alias-safe lookup dictValueKindOf/mapValueKindOf themselves use,
// just without their exact-or-null collapse), so a genuinely heterogeneous
// dict/map now answers {NUMBER, STRING}-shaped, not null. A defensive copy
// (`new Set(s)`) is returned — the underlying Set is a published rep field,
// never mutated by a caller.
// INVARIANT: a projection must stay PURE — never touch solver state. Routing
// through joinKinds would trip its latticeMeet.changed side channel on every
// non-empty QUERY, a read preventing a fixpoint from settling. Projections
// construct their answer locally; only PRODUCERS join.
export function censusKindsOf(name) {
  const s = dictValueKindSet(name) ?? mapValueKindSet(name)
  return s ? new Set(s) : new Set()
}

// maybeUndefined value-join (.work/archive/todo.md §deletion-sweep §4/§8). Two
// arms: a `name[key]`/`name.prop` dict-census READ node (arm 1) or a
// `recv.get(key)` Map-census CALL node (arm 2) whose claimed kind comes
// SOLELY from dictValueKindOf/mapValueKindOf's soundness carve-out. PLUS a
// third arm (§2/§3 decl inference, §4 "REP fallback for a bare name"): a
// bare NAME whose rep carries BOTH `mayBeUndefined` and a `presentVal`
// answers identically — INVARIANT: this is required for a maybeUndefined
// read to survive being bound to a local (`let x = m.get(missing); x + 1`)
// instead of evaporating at the decl boundary; an AST-shape-only join (arms
// 1/2 alone) misses this case. Consulted directly (not via valTypeOf) at every existing
// censusMaybeUndefined chokepoint — ir.js toNumF64/toStrI64, emit.js
// nullableOperand/bigIntOperand/bigIntUnary/bigintMixReject/`+`-concat.
//
// INVARIANT: arm 3 must consult `presentVal` FIRST, `val` second. For a
// DECL/REASSIGN local, `val` never carries a census claim (the census never
// feeds `val` for that shape) — `presentVal` (reps.js) is the only source,
// propagated at decl/reassign time (analyze.js analyzeValTypes'
// `setPresentVal` tracker, mirroring `setVal`'s poison-on-disagreement
// discipline exactly, NOT `mayBeUndefined`'s spread-merge boolean OR). For a
// PARAM, though, `val` stays load-bearing: `mayBeUndefined = true` can
// coexist with a `val` set by narrow.js's ENTIRELY SEPARATE call-site-
// argument fixpoint (`hardParamVal`/`inferValAtSite`, no census involvement
// at all) — Slice 2's own deliberate over-approximation (`censusShapedNode`
// flags ANY `[]`/`.` 2-arg read, not just a dict/Map one, so a plain
// array/typed-array OOB-possible index read on a call-site argument flags
// the receiving param too). Dropping the `val` fallback regresses
// test/dyn-keys.js's "sibling carrier-domain producers: out-of-bounds array
// read" pin from `NaN` back to `undefined`. Whether a GIVEN chokepoint above
// ever actually SEES a non-null claim from any arm still depends on that
// chokepoint's OWN outer gate: several (ir.js toNumF64/toStrI64, emit.js
// nullableOperand/bigIntOperand/bigIntUnary) compute `vt = valTypeOf(node)`
// FIRST and only consult this function when `vt` already proves a matching
// kind — true for the param case above (`val` IS `vt`'s own source there)
// but never true for a census-shaped node itself — no optimistic default.
// Widening those chokepoints' own outer gates to fall back to this function
// when `valTypeOf` is null is separate, larger future work — see
// .work/archive/todo.md §deletion-sweep §15 for which consumers are live vs still
// gated out.
//
// censusShapedNode (Slice 2, .work/archive/todo.md §deletion-sweep §3)
// factors OUT arms 1/2's pure AST-SHAPE test — no ctx lookup — so a whole-
// program plan-time consumer can recognize the same two node shapes without
// touching ctx.func.localReps/ctx.types.nameEscapes: narrow.js's param/
// return-kind fixpoint and flow-types.js's closure return-kind pre-pass all
// run BEFORE the queried function's own ctx state is installed (identical
// caveat narrow.js's bodyNameNullable already documents for mayBeNullish —
// "at plan time no caller ctx.func is installed, so rep lookups would
// misread"). A pure shape test is a conservative OVER-approximation of the
// real census (skips dictCensusReceiverIsLive/nameEscapes/dynWriteVars) —
// sound because every caller below only ever uses it to decide
// `mayBeUndefined = true`, never to claim an exact kind (the design's own
// fail-closed direction: absence of proof of presence keeps this fact TRUE,
// never removes it).
export const censusShapedNode = (node) =>
  (Array.isArray(node) && (node[0] === '[]' || node[0] === '.') && node.length === 3 && typeof node[1] === 'string') ||
  (Array.isArray(node) && node[0] === '()' && node.length === 3 &&
    Array.isArray(node[1]) && node[1][0] === '.' && node[1][2] === 'get' && typeof node[1][1] === 'string')

// Call-RESULT mayBeUndefined arm: a call to a user function/direct closure
// whose whole-program return-kind fixpoint (narrow.js narrowValResults,
// flow-types.js closureBodyReturnMayBeUndefined — §3 "Return kinds") settled
// BOTH a definite `valResult` kind AND `valResultMayBeUndefined` is itself a
// census fact one call-hop removed: `const g = (k) => { ...; return
// m.get(k) }; g(k) === undefined` must not const-fold identically to a
// direct `m.get(k) === undefined`. INVARIANT: without this arm,
// kind-traits.js's `calleeValType` returns `f.valResult` unconditionally
// with no accompanying signal, so a two-statement (non-inlined) callee's
// `g(k) === undefined` const-folds to the SAME wrong boolean for both a
// present and an absent key. This arm's own precondition
// (`f.valResultMayBeUndefined` true AND `f.valResult` non-null) requires
// narrowValResults' return-kind unify to have already settled a non-null
// `valResult` for a census-shaped return tail — which itself requires
// `valTypeOf` on that tail to be non-null, i.e. requires the
// VT['[]']/['.']/['()'] promotion that stays dormant (see the dict-value-
// census consumer's doc comment above). So with VT dormant this arm is
// reachable but returns null on every real input — sound-but-inert, same
// status as arms 1-3 above, not a separate risk. Left in place (not
// stubbed) so a future VT re-enablement does not have to re-derive this
// wiring. Mirrors calleeValType's own two lookup paths (direct closure via
// `ctx.func.directClosures` + `ctx.closure.valResult`, plain named function
// via `ctx.funcs.map`) so a call-result claim and its mayBeUndefined
// companion always travel together.
function callResultMayBeUndefinedKind(node) {
  if (!Array.isArray(node) || node[0] !== '()' || typeof node[1] !== 'string') return null
  const callee = node[1]
  const closBody = ctx.func.directClosures?.get(callee)
  if (closBody) return ctx.closure?.valResultMayBeUndefined?.get(closBody) ? (ctx.closure?.valResult?.get(closBody) ?? null) : null
  const f = ctx.funcs.map?.get(callee)
  return f?.valResultMayBeUndefined ? (f.valResult ?? null) : null
}

export function censusMaybeUndefinedKind(node) {
  if (censusShapedNode(node)) {
    if (node[0] === '[]' || node[0] === '.') return dictCensusReceiverIsLive(node[1]) ? dictValueKindOf(node[1]) : null
    return mapValueKindOf(node[1][1])
  }
  if (typeof node === 'string') {
    const r = repOf(node)
    // presence check re-expressed via reps.js's mayBeUndefined(name) projection
    // (.work/archive/lattice-design.md §5 Slice 3 precedent, the Fact.presence component
    // formalized) — same underlying REP field, same computation.
    if (mayBeUndefined(node)) {
      // INVARIANT: check `presentVal` FIRST — the precise, poison-disciplined
      // census kind, live for a decl-hop local (never available via `val`,
      // which never carries a census claim for that shape). Fall back to
      // `val`: a PARAM's `val` is set by narrow.js's ORDINARY call-site-
      // argument fixpoint, entirely independent of census provenance, while
      // its `mayBeUndefined` can ALSO be true via a deliberate
      // over-approximation (censusShapedNode flags ANY `[]`/`.` 2-arg read,
      // including a plain array/typed-array OOB-possible index — not just
      // dict/Map — sound because every mayBeUndefined consumer only ever
      // asks a boolean question with it, reps.js's own doc comment). When
      // both land on the SAME param, `val`'s NUMBER claim really can be
      // undefined at runtime (an OOB read), and this arm answering it is
      // what keeps toNumF64's coerceNullishToNum safety net reachable for a
      // single-call-site `(v) => v + 1` over an out-of-bounds array read —
      // dropping this fallback regresses test/dyn-keys.js's "sibling
      // carrier-domain producers" pin from NaN back to `undefined`.
      if (r.presentVal) return r.presentVal
      if (r.val) return r.val
    }
  }
  return callResultMayBeUndefinedKind(node)
}

// Present-key BigInt through the census — export-boundary sentinel kind
// (.work/archive/todo.md §deletion-sweep §6/§12 Slice 5, the `presentKindUnboxed`
// family). A bare census-BIGINT node (dict/Map read, mayBeUndefined bare name, or
// call-result — censusMaybeUndefinedKind's own three arms) crosses the JS boundary
// as either its raw i64 bits (present key) or the UNDEF_NAN atom (absent key,
// decodes to `undefined`) — sentinel kind 1. `-`/`~` unary-wrapping such a node
// (emit.js emitNeg / the '~' table entry, both via bigIntUnary) computes a
// DIFFERENT absent-case value internally — ToNumeric(undefined) applied to the
// specific operator, a genuine NUMBER, never `undefined` itself (ES2024 13.5.6/
// 13.5.9): NaN for unary '-' (sentinel kind 2), NUMBER -1 for unary '~' (sentinel
// kind 3). Both still cross as the SAME raw i64-reinterpret-f64 carrier as the
// bare case (bigIntUnary's own doc comment) — only the absent-case BIT PATTERN
// interop must recognize differs per operator, hence the distinct kind. Returns 0
// when `node` isn't any of these shapes (not this export lane at all).
// Binary sibling of kinds 1-3 (.work/archive/todo.md §deletion-sweep §14/§15):
// emit.js's `bigIntJointDispatch` reaches its i64 arithmetic — for ANY of
// the 9 binary arithmetic/bitwise ops, not just `+` — when BOTH operands'
// census independently claim BIGINT (the SAME AND,
// never OR — see `bigIntDomainsCanMix`'s own comment for why an OR would be
// unsound). Unlike kinds 1-3, this shape has NO absent-case bit pattern to
// special-case: `bigIntJointDispatch`'s own runtime domain check throws
// BIGINT_UNDEF_MIX before a genuinely-mismatched operand pair could ever
// reach a return here, so every value this export lane ever sees IS a
// genuine i64 arithmetic result — category 4, for every op in
// BIGINT_JOINT_BINARY_OPS.
const BIGINT_RESULT_SHAPE = { BARE: 1, UNARY_NEG: 2, UNARY_NOT: 3, JOINT_BINARY: 4 }
export const BIGINT_JOINT_BINARY_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'])
export function censusBigintResultShape(node) {
  if (censusMaybeUndefinedKind(node) === VAL.BIGINT) return BIGINT_RESULT_SHAPE.BARE
  if (Array.isArray(node) && node.length === 2 && (node[0] === 'u-' || node[0] === '~')
      && censusMaybeUndefinedKind(node[1]) === VAL.BIGINT)
    return node[0] === 'u-' ? BIGINT_RESULT_SHAPE.UNARY_NEG : BIGINT_RESULT_SHAPE.UNARY_NOT
  if (Array.isArray(node) && node.length === 3 && BIGINT_JOINT_BINARY_OPS.has(node[0])
      && censusMaybeUndefinedKind(node[1]) === VAL.BIGINT && censusMaybeUndefinedKind(node[2]) === VAL.BIGINT)
    return BIGINT_RESULT_SHAPE.JOINT_BINARY
  // Kind 5 ("presentVal param producers"): a call whose CALLEE is a
  // plain single-param function/const-arrow (ctx.funcs.map) entirely made of
  // `-`/`~` applied to its OWN param (`const g = (v) => -v`, or an equivalent
  // single-return block `{ return -v }`) — the call-boundary sibling of kinds
  // 2/3 above, covering the param-hop shape `const f = (v) => -v; return
  // f(m.get('x'))` (present-key BIGINT). Deliberately NOT built on
  // `func.valResult`/`valResultMayBeUndefined` (narrowValResults' own
  // return-kind join, .work/archive/todo.md §deletion-sweep §3 "Return kinds"):
  // INVARIANT: that fixpoint runs BEFORE narrow.js's presentVal param
  // propagation (hardParamPresentVal) ever populates paramReps, so it can
  // never observe a param-sourced BIGINT claim through a unary wrapper —
  // the same ordering gap makes narrowValResults' own join empirically
  // unreachable for mayBeUndefined's return-kind join too. Reading the callee's raw AST directly
  // (ctx.funcs.map, populated by prepare — before any narrowing runs) and the
  // ARGUMENT's own presentVal-fed census claim (censusMaybeUndefinedKind,
  // computed HERE, at whatever time THIS caller is itself analyzed — after
  // narrowing has settled) sidesteps that ordering entirely, at the cost of
  // only recognizing this ONE explicit shape (not any callee whose return
  // proves the sentinel kind through a longer, indirect chain — a narrower,
  // honest boundary, not a general fix for every possible callee shape).
  // `alwaysReturns` (ast.js) guards a block body: a callee that can fall off
  // the end without an explicit return can genuinely yield `undefined` on
  // some path even when every EXPLICIT return matches the sentinel shape, so
  // that case must NOT claim kind 5.
  if (Array.isArray(node) && node[0] === '()' && typeof node[1] === 'string' && node.length === 3) {
    const callee = ctx.funcs.map?.get(node[1])
    const params = callee?.sig?.params
    if (params?.length === 1 && (!isBlockBody(callee.body) || alwaysReturns(callee.body))) {
      const pname = params[0].name
      const sites = returnExprs(callee.body)
      const kindOf = (e) => Array.isArray(e) && e.length === 2 && (e[0] === 'u-' || e[0] === '~') && e[1] === pname
        ? (e[0] === 'u-' ? BIGINT_RESULT_SHAPE.UNARY_NEG : BIGINT_RESULT_SHAPE.UNARY_NOT) : 0
      const k0 = sites.length ? kindOf(sites[0]) : 0
      if (k0 > 0 && sites.every(e => kindOf(e) === k0) && censusMaybeUndefinedKind(node[2]) === VAL.BIGINT)
        return k0
    }
  }
  return 0
}

// mayBeUndefined structural TRACE (Slice 2, §3 "Param lattice"/"Return
// kinds"): does `name`, written somewhere in `bodyRoot` via a plain
// `let`/`const`/`=`, resolve — transitively, cycle-guarded — to a
// censusShapedNode RHS? Ctx-independent by construction (censusShapedNode
// above), so it's safe to run against a CALLER's or CALLEE's raw body at
// plan/pre-compile time, before that function's own reps exist. Shared by
// every whole-program-fixpoint consumer that needs this fact early:
// narrow.js's inter-procedural param join and return-kind join, flow-types.js's
// closureBodyReturnKind sibling.
//
// Ownership: session-owned, stored at getFactStore().mayBeUndefinedTrace,
// NOT a private module-level WeakMap — see the DEPS table in session.js,
// and the bindingUses precedent this mirrors.
// Cache-correctness is body-identity-keyed and needs NO surgical
// invalidation — same argument as bindingUses (analyze-scans.js): every pass
// that restructures a function's AST does so through compile/analyze.js's
// setFuncBody, which always assigns a NEW func.body reference, so a caller
// tracing a REWRITTEN body is, by construction, keying off a node this cache
// has never seen; a fresh top-level parse is likewise a fresh array
// identity. So within one compile, and across compiles that never share a
// bodyRoot object, a hit can never be stale.
//
// Session ownership still matters despite that: jz has no GC in its OWN
// compiled output, so `new WeakMap()` in code jz self-hosts folds to a
// plain (strong-referencing) `Map` (src/prepare/index.js's `new` handler —
// "no GC → weakness is unobservable"). kind.js IS part of the self-hosted
// compiler surface (compile/index.js → kind.js, bundled into dist/jz.wasm),
// so a bare module-global here would, under the kernel, accumulate one
// entry per distinct bodyRoot for the LIFETIME OF THE WASM INSTANCE —
// unbounded growth across every compile a warm kernel instance services
// (exactly the class of resource issue the factStore session-reset
// discipline exists to prevent). Moving it into factStore means `ctx.facts`
// (built fresh by reset() every beginSession) swaps in a fresh Map/WeakMap
// each compile, same as bindingUses — the fold's memory-growth exposure is
// bounded to one compile's worth of bodies, not the whole kernel session.
export function nameMayBeUndefinedInBody(bodyRoot, name, seen = new Set()) {
  // Expression-bodied arrow whose body IS a bare name/literal (`() => x`) —
  // a WeakMap key must be an object, and a non-array bodyRoot can't contain
  // a `let`/`const`/`=` write to walk anyway, so there's nothing to trace.
  if (!Array.isArray(bodyRoot)) return false
  const mayBeUndefinedTraceCache = getFactStore().mayBeUndefinedTrace
  let m = mayBeUndefinedTraceCache.get(bodyRoot)
  if (!m) { m = new Map(); mayBeUndefinedTraceCache.set(bodyRoot, m) }
  if (m.has(name)) return m.get(name)
  if (seen.has(name)) return false
  seen.add(name)
  let flagged = false
  walkAst(bodyRoot, { enter: node => {
    if (flagged) return false
    const op = node[0]
    if ((op === 'let' || op === 'const') && node.length >= 2) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && d[1] === name &&
          (censusShapedNode(d[2]) || (typeof d[2] === 'string' && nameMayBeUndefinedInBody(bodyRoot, d[2], seen))))
          flagged = true
      }
    } else if (op === '=' && node[1] === name &&
      (censusShapedNode(node[2]) || (typeof node[2] === 'string' && nameMayBeUndefinedInBody(bodyRoot, node[2], seen))))
      flagged = true
  } })
  m.set(name, flagged)
  return flagged
}

/** censusShapedNode(expr) OR a bare-name expr that traces to one through
 *  bodyRoot's own writes (nameMayBeUndefinedInBody) — the one-call shape
 *  every Slice 2 join site consults. */
export const exprMayBeUndefinedIn = (expr, bodyRoot) =>
  censusShapedNode(expr) || (typeof expr === 'string' && nameMayBeUndefinedInBody(bodyRoot, expr))

// Narrower sibling of censusShapedNode's OWN arm 2 only (a `.get()` call —
// unambiguously Map, never an array/typed-array index the way arm 1's bare
// `[]`/`.` shape is) — type.js's bitwise-ops i32-
// narrowing guard needs it because a LOCAL Map receiver (`const m = new
// Map()` inside the SAME function body) is invisible to `mapValueKindOf`
// at narrow.js's whole-program `narrowI32Results` pre-pass (that function's
// own first check, `valTypeOf(name) === VAL.MAP`, can't resolve a purely
// LOCAL receiver without `ctx.func.localReps`, uninstalled there — the SAME
// "local-receiver visibility at a plan-time fixpoint" gap test/dyn-keys.js
// pins). INVARIANT: without this predicate, `exprPresentValIn`'s KIND-precise
// trace resolves null for this shape, silently permitting an i32 narrowing
// that desyncs from emit.js's own later, correctly-census-aware
// `bigIntJointDispatch` — a genuine WASM validation crash, not just a wrong
// value. Deliberately NOT the full `censusShapedNode`
// (which also matches a plain array/typed-array 2-arg index — `arr[i] &
// mask` is common in hot bitwise code and must keep narrowing; broadening to
// that shape regresses exactly that class) — a boolean-only "might be
// a Map .get() read" signal is enough here: this consumer only ever asks
// "may I narrow to i32", never "what kind", so it doesn't need presence
// resolved either, unlike exprPresentValIn.
const mapGetShapedNode = (node) =>
  Array.isArray(node) && node[0] === '()' && node.length === 3 &&
  Array.isArray(node[1]) && node[1][0] === '.' && node[1][2] === 'get' && typeof node[1][1] === 'string'
// Ownership: session-owned, stored at getFactStore().mapGetShapedTrace,
// NOT a private module-level WeakMap — same argument as mayBeUndefinedTrace
// above; see the DEPS table in session.js.
// Body-identity-keyed, no surgical invalidation needed (setFuncBody always
// assigns a fresh func.body reference on rewrite — same no-stale-hit
// argument as mayBeUndefinedTrace/bindingUses). Session ownership still
// matters: `new WeakMap()` folds to a strong `Map` when jz self-hosts (no
// GC → weakness unobservable, src/prepare/index.js's `new` handler), and
// kind.js is on the self-hosted compiler surface, so a bare module-global
// would accumulate one entry per bodyRoot for the WHOLE kernel-instance
// lifetime instead of one compile's worth.
function nameMapGetShapedInBody(bodyRoot, name, seen = new Set()) {
  if (!Array.isArray(bodyRoot)) return false
  const mapGetShapedTraceCache = getFactStore().mapGetShapedTrace
  let m = mapGetShapedTraceCache.get(bodyRoot)
  if (!m) { m = new Map(); mapGetShapedTraceCache.set(bodyRoot, m) }
  if (m.has(name)) return m.get(name)
  if (seen.has(name)) return false
  seen.add(name)
  let flagged = false
  walkAst(bodyRoot, { enter: node => {
    if (flagged) return false
    const op = node[0]
    if ((op === 'let' || op === 'const') && node.length >= 2) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && d[1] === name &&
          (mapGetShapedNode(d[2]) || (typeof d[2] === 'string' && nameMapGetShapedInBody(bodyRoot, d[2], seen))))
          flagged = true
      }
    } else if (op === '=' && node[1] === name &&
      (mapGetShapedNode(node[2]) || (typeof node[2] === 'string' && nameMapGetShapedInBody(bodyRoot, node[2], seen))))
      flagged = true
  } })
  m.set(name, flagged)
  return flagged
}
export const exprMapGetShapedIn = (expr, bodyRoot) =>
  mapGetShapedNode(expr) || (typeof expr === 'string' && nameMapGetShapedInBody(bodyRoot, expr))

export const censusMaybeUndefined = (node) => !!censusMaybeUndefinedKind(node)

// presentVal structural TRACE (§16→§18 "presentVal param producers" — the
// KIND-precise sibling of nameMayBeUndefinedInBody just above, needed for
// narrow.js's inter-procedural presentVal join). Unlike that function's
// monotonic boolean OR (any matching write flips it true, forever), this one
// mirrors analyze.js's OWN `setPresentVal` poison discipline (makeValTracker:
// an unresolvable observation poisons exactly like a conflicting definite one
// — reps.js `presentVal` doc, §15 Slice 6): every write to `name` in
// `bodyRoot` must independently resolve to the SAME censusShapedNode kind, or
// the trace poisons to null. A name with NO writes at all (an unwritten
// forwarded param/capture) resolves null too — "no evidence" and "poisoned"
// collapse to the same null result here (unlike the boolean trace, there's no
// third "false" state to fall back to for an exact-kind fact). Direct
// censusShapedNode reads (arms 1/2, dictValueKindOf/mapValueKindOf) are
// resolved via censusMaybeUndefinedKind itself — safe to call from a
// STRUCTURAL trace like this because those two arms never touch
// ctx.func.localReps (only the RECEIVER's dict/Map census, which lives on
// ctx.scope.globalReps / is nameEscapes-gated, both whole-program facts, not
// per-function state — see dictValueKindOf/mapValueKindOf's own doc
// comments); only arm 3 (bare-name REP fallback) is ctx.func-dependent, and
// this trace never reaches it (a bare name inside the walk recurses back into
// THIS function, never into censusMaybeUndefinedKind's own repOf lookup).
// WeakMap-cached per bodyRoot, mirroring nameMayBeUndefinedInBody exactly —
// including its ownership: session-owned, stored at
// getFactStore().presentValTrace, NOT a private module-level WeakMap, for
// the SAME self-hosted-WeakMap-folds-to-strong-Map reason documented on
// nameMayBeUndefinedInBody above (kind.js is on the self-hosted compiler
// surface; a bare module-global here would leak one entry per bodyRoot for
// the lifetime of a warm kernel instance instead of one compile's worth).
export function namePresentValInBody(bodyRoot, name, seen = new Set()) {
  if (!Array.isArray(bodyRoot)) return null
  const presentValTraceCache = getFactStore().presentValTrace
  let m = presentValTraceCache.get(bodyRoot)
  if (!m) { m = new Map(); presentValTraceCache.set(bodyRoot, m) }
  if (m.has(name)) return m.get(name)
  if (seen.has(name)) return null
  seen.add(name)
  let claim, poisoned = false
  const observe = (vt) => {
    if (poisoned) return
    if (!vt) { poisoned = true; return }
    if (claim === undefined) claim = vt
    else if (claim !== vt) poisoned = true
  }
  const rhsKind = (rhs) => censusShapedNode(rhs) ? censusMaybeUndefinedKind(rhs)
    : typeof rhs === 'string' ? namePresentValInBody(bodyRoot, rhs, seen) : null
  walkAst(bodyRoot, { enter: node => {
    if (poisoned) return false
    const op = node[0]
    if ((op === 'let' || op === 'const') && node.length >= 2) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && d[1] === name) observe(rhsKind(d[2]))
      }
    } else if (op === '=' && node[1] === name) observe(rhsKind(node[2]))
  } })
  const result = poisoned ? null : (claim ?? null)
  m.set(name, result)
  return result
}

/** censusMaybeUndefinedKind(expr) when it's directly census-shaped, else a
 *  bare-name expr's poison-disciplined trace through bodyRoot's own writes
 *  (namePresentValInBody) — the presentVal analogue of exprMayBeUndefinedIn,
 *  for narrow.js's inter-procedural call-site fold. */
const staticKey = node => {
  if (Array.isArray(node) && node[0] === 'str') return `s:${node[1]}`
  if (Array.isArray(node) && node[0] == null && node.length === 2) return `${typeof node[1]}:${String(node[1])}`
  if (typeof node === 'number' || typeof node === 'string') return `${typeof node}:${String(node)}`
  return null
}
const staticWrittenKind = node => {
  if (typeof node === 'number') return VAL.NUMBER
  if (!Array.isArray(node)) return null
  if (node[0] === 'bigint' || node[0] === '()' && node[1] === 'BigInt') return VAL.BIGINT
  if (node[0] === 'str') return VAL.STRING
  if (node[0] === 'bool') return VAL.BOOL
  if (node[0] == null && typeof node[1] === 'number') return VAL.NUMBER
  return null
}
const blockStatements = body => {
  if (!Array.isArray(body)) return []
  const inner = body[0] === '{}' ? body[1] : body
  return Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
}
const containsNode = (root, target) => {
  let found = false
  walkAst(root, { enter: node => { if (node === target) { found = true; return false } } })
  return found
}
const referencesName = (root, name) => {
  let found = false
  walkAst(root, { enter: node => {
    for (let i = 1; i < node.length; i++) if (node[i] === name) { found = true; return false }
  } })
  return found
}

/** Resolve a present literal-key read from a caller-local Map when its complete
 * reaching history is a straight-line `new Map(); map.set(key, value)` prefix.
 * Plan-time lacks the caller's installed localReps, so this narrow structural
 * proof supplies the same exact-kind fact without guessing across control flow,
 * aliases, dynamic keys, deletes, or receiver escapes. */
export function localMapGetMayCarryBigint(expr, bodyRoot) {
  if (!mapGetShapedNode(expr) || !Array.isArray(bodyRoot)) return false
  const recv = expr[1][1]
  let found = false
  walkAst(bodyRoot, { enter: node => {
    if (node[0] !== '()' || !Array.isArray(node[1]) || node[1][0] !== '.' ||
        node[1][1] !== recv || node[1][2] !== 'set') return
    const args = commaList(node[2])
    if (staticWrittenKind(args[1]) === VAL.BIGINT) { found = true; return false }
  } })
  return found
}

function localMapPresentKind(expr, bodyRoot) {
  if (!mapGetShapedNode(expr) || !Array.isArray(bodyRoot)) return null
  const recv = expr[1][1], wanted = staticKey(commaList(expr[2])[0])
  if (wanted == null) return null
  let declared = false, claim = null, reached = false
  for (const stmt of blockStatements(bodyRoot)) {
    if (!Array.isArray(stmt)) continue
    if (containsNode(stmt, expr)) { reached = true; break }
    let recognized = false
    if (stmt[0] === 'let' || stmt[0] === 'const') {
      for (let i = 1; i < stmt.length; i++) {
        const d = stmt[i]
        if (Array.isArray(d) && d[0] === '=' && d[1] === recv && Array.isArray(d[2]) &&
            d[2][0] === '()' && d[2][1] === 'new.Map') { declared = true; recognized = true }
      }
    }
    if (stmt[0] === '()' && Array.isArray(stmt[1]) && stmt[1][0] === '.' &&
        stmt[1][1] === recv && stmt[1][2] === 'set') {
      const args = commaList(stmt[2]), key = staticKey(args[0]), kind = staticWrittenKind(args[1])
      if (!declared || key !== wanted || kind == null || claim != null && claim !== kind) return null
      claim = kind; recognized = true
    }
    if (!recognized && referencesName(stmt, recv)) return null
  }
  return reached && declared ? claim : null
}

export const exprPresentValIn = (expr, bodyRoot) =>
  localMapPresentKind(expr, bodyRoot) ??
  (censusShapedNode(expr) ? censusMaybeUndefinedKind(expr)
    : typeof expr === 'string' ? namePresentValInBody(bodyRoot, expr) : null)

