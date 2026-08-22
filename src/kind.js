/**
 * Expression value KIND inference (STRING, ARRAY, …) + JSON shape propagation.
 *
 * Cycle-free w.r.t. analyze.js body walkers — reads ctx + reps only.
 *
 * @module kind
 */

import { ctx, getFactStore } from './ctx.js'
import { VAL, lookupValType, repOf, mayBeUndefined } from './reps.js'
import { intLiteralValue, staticIndexKey } from './static.js'
import {
  BOOL_OPS, NUMERIC_BINARY_OPS, NUMERIC_UNARY_OPS, COMPOUND_NUMERIC_OPS,
  calleeValType, methodValType, propValType, typedCtorElemValType,
} from './kind-traits.js'
import { ERR_CLASS_NAMES, ERR_SCHEMA_PROPS } from '../err-codes.js'
import { BIGINT_SENTINEL_KIND } from '../layout.js'
import { isBlockBody, returnExprs, alwaysReturns } from './ast.js'

export { typedCtorElemValType } from './kind-traits.js'

function literalTruthiness(expr) {
  if (typeof expr === 'number') return expr !== 0 && expr === expr
  if (typeof expr === 'boolean') return expr
  if (typeof expr === 'bigint') return expr !== 0n
  if (typeof expr === 'string') {
    const value = intLiteralValue(expr)
    if (value != null) return value !== 0
  }
  if (Array.isArray(expr)) {
    const [op, ...args] = expr
    if (op == null) {
      if (args.length === 0 || args[0] == null) return false
      return literalTruthiness(args[0])
    }
    if (op === 'bool') return literalTruthiness(args[0])
    if (op === 'nan') return false
    if (op === 'str' && typeof args[0] === 'string') return args[0].length !== 0
    if (op === '()' && expr.length === 2) return literalTruthiness(args[0])
    if (BOOL_OPS.has(op)) {
      const result = literalBool(expr)
      if (result != null) return result
    }
    if (op === '?:' || op === '?') {
      const truthy = literalTruthiness(args[0])
      if (truthy != null) return literalTruthiness(truthy ? args[1] : args[2])
      const thenTruthy = literalTruthiness(args[1])
      const elseTruthy = literalTruthiness(args[2])
      if (thenTruthy != null && thenTruthy === elseTruthy) return thenTruthy
    }
    if (op === '()' && Array.isArray(args[0]) && args[0][0] === '?') {
      const truthy = literalTruthiness(args[0][1])
      if (truthy != null) return literalTruthiness(truthy ? args[0][2] : args[0][3])
      const thenTruthy = literalTruthiness(args[0][2])
      const elseTruthy = literalTruthiness(args[0][3])
      if (thenTruthy != null && thenTruthy === elseTruthy) return thenTruthy
    }
  }
  return null
}

function literalValue(expr) {
  if (expr == null || typeof expr === 'number' || typeof expr === 'boolean' || typeof expr === 'bigint') return expr
  if (!Array.isArray(expr)) return undefined
  const [op, ...args] = expr
  if (op == null) return args.length ? args[0] : undefined
  if (op === 'nan') return NaN
  if (op === 'str') return args[0]
  if (op === 'bool') {
    const truthy = literalTruthiness(args[0])
    return truthy == null ? undefined : truthy
  }
  if (op === '()' && expr.length === 2) return literalValue(args[0])
  return undefined
}

function literalBool(expr) {
  if (!Array.isArray(expr)) return null
  const [op, left, right] = expr
  if (op === '!') {
    const truthy = literalTruthiness(left)
    return truthy == null ? null : !truthy
  }
  if (!['<', '<=', '>', '>=', '==', '!=', '===', '!=='].includes(op)) return null
  const a = literalValue(left), b = literalValue(right)
  if (a === undefined || b === undefined) return null
  switch (op) {
    case '<': return a < b
    case '<=': return a <= b
    case '>': return a > b
    case '>=': return a >= b
    case '==': return a == b
    case '!=': return a != b
    case '===': return a === b
    case '!==': return a !== b
  }
  return null
}

/**
 * Per-op val-type rules — the dispatch table behind `valTypeOf`. Each entry
 * takes the op's args and returns a VAL kind or undefined (→ null). Set-driven
 * families (BOOL_OPS, NUMERIC_*) enroll at module init, so adding an operator
 * is a kind-traits table entry, not a new branch here.
 */
const VT = Object.create(null)

// Self-describing boolean literal (`['bool', 1|0]`, tagged at parse time —
// see parse.js's `true`/`false` token overrides) — the self-host kernel's
// `true`/`false` degrade to the plain number 1/0 otherwise, losing VAL.BOOL.
VT.bool = () => VAL.BOOL
// Boolean-result operators: relational/equality compares and logical-not always
// yield a boolean. (`&&`/`||` are value-preserving, not boolean — excluded.)
for (const op of BOOL_OPS) VT[op] = VT.bool
// Self-describing bigint literal (`['bigint', decimalStr]`, tagged at parse
// time — see parse.js's digit-lookup override, audit P0-2) — same VAL as a
// raw `255n`, but immune to the self-host carrier's subnormal-magnitude
// collapse (a bigint literal's OWN AST node op is now unambiguous, never a
// bit pattern to misread).
VT.bigint = () => VAL.BIGINT
VT['['] = () => VAL.ARRAY
VT.str = VT.strcat = () => VAL.STRING
VT['=>'] = () => VAL.CLOSURE
VT['//'] = () => VAL.REGEX

VT['{}'] = (args) => {
  const hasSpread = args.some(p => Array.isArray(p) && p[0] === '...')
  if (!hasSpread) return args[0]?.[0] === ':' ? VAL.OBJECT : null
  // Spread literal — mirror emitObjectSpread (module/object.js). When every
  // spread source has a compile-time schema, emit builds a fixed-shape OBJECT
  // and the existing schema-by-name read path resolves props with no val-type
  // tag, so leave it untyped (tagging OBJECT here regresses it — the merged
  // schema isn't bound to this name). When any source's schema is unknown (or
  // a conditional-spread group's key collides with another prop/source —
  // spreadMergeResolves, same bail emitObjectSpread's mergeSpreadNames takes),
  // emit builds a dynamic HASH (emitDynamicSpread); that result carries no
  // schema, so the binding MUST be HASH-typed or computed/static reads
  // silently misdispatch (fixed-slot / array index) and return undefined —
  // the bug this fixes.
  if (!spreadMergeResolves(args)) {
    // `{ ...src }` with a single unresolvable spread aliases src — carry its type.
    return args.length === 1 && Array.isArray(args[0]) && args[0][0] === '...' ? valTypeOf(args[0][1]) : VAL.HASH
  }
  return null
}

VT['?:'] = (args) => {
  const truthy = literalTruthiness(args[0])
  if (truthy != null) return valTypeOf(truthy ? args[1] : args[2])
  const ta = valTypeOf(args[1]), tb = valTypeOf(args[2])
  if (ta && ta === tb) return ta
  // A boolean branch coerces to 0/1 in NUMERIC context: when the other branch is a
  // known NUMBER, the conditional carries NUMBER — the raw 0/1 bool carrier IS its
  // ToNumber image, so the claim is benign and keeps `num + (cond ? num : num>k)`
  // off the polymorphic string-concat dispatch (which pins the whole number→string
  // formatter — __str_concat → __to_str → __static_str, a pure-int program
  // ballooning 1 → ~19 funcs; see test/wat-invariants.js, .work/todo.md).
  // Any OTHER mix is null: both ternary arms are "the value", so claiming the
  // non-bool arm's kind would let strict-eq's differing-class fold constant-fold
  // `x === true` on a value that IS sometimes a boolean (watr's `i ? true :
  // [from,len]` rec marker); the bool arm materializes as its atom at emit
  // (emit.js '?:') and stays observable. (&&/||/?? below keep the full carry —
  // there the bool side is a GUARD whose value surfaces only when falsy, and the
  // carry is what types `cond && typedArr` guarded-use idioms.)
  if (ta === VAL.BOOL && tb && tb !== VAL.BOOL) return tb === VAL.NUMBER ? VAL.NUMBER : null
  if (tb === VAL.BOOL && ta && ta !== VAL.BOOL) return ta === VAL.NUMBER ? VAL.NUMBER : null
  // BIGINT arm + nullish-LITERAL arm carries BIGINT. BIGINT is the one kind
  // with NO runtime tag — raw i64 bits ride the f64 slot, indistinguishable
  // from a number — so a dispatcher that loses the static kind has no runtime
  // fork to fall back on: tryRuntimeStringFork's non-NaN arm claimed
  // `(c ? BigInt(x) : null).toString(16)` as NUMBER and formatted the bits as
  // a denormal ("0.000…"), watr's `cb ? BigInt(cb.value) : null` folder shape.
  // Sound where the bool-arm carry above is not: a nullish receiver is
  // TypeError-class in JS (no method table to mis-pick), the nullish arm
  // materializes as its ATOM whose bits the sentinel compare still matches at
  // runtime, and the decl-site mayBeNullish flag (analyze.js) plus
  // nullableOperand (emit.js) keep `x == null` folds honest — narrow.js
  // re-derives that nullability across call boundaries for BIGINT params.
  // Tagged kinds stay null here on purpose: their runtime fork handles the
  // mix soundly and their eq-folds stay maximally live.
  if (ta === VAL.BIGINT && nullishArm(args[2])) return VAL.BIGINT
  if (tb === VAL.BIGINT && nullishArm(args[1])) return VAL.BIGINT
  return null
}

// AST nullish literal — mirrors ir.js isNullishLit ([null,null] = null literal,
// [] = undefined) plus the bare `undefined` name form recordGlobalRep accepts;
// local copy because ir.js already imports valTypeOf from here (cycle).
export const nullishArm = (n) => n === 'undefined' ||
  (Array.isArray(n) && ((n.length === 2 && n[0] == null && n[1] == null) || n.length === 0))

// Value-preserving logical: `&&`/`||` return one of their operands.
// When both sides share a type, return it. When one side is boolean
// (a condition/guard) and the other has a known non-boolean type,
// return the non-boolean type — common in `condition && numericValue`
// guard patterns where the falsey boolean is coerced to 0 in numeric context.
// `a && b` / `a || b` / `a ?? b` all yield one of the two operands, so the result
// type is their common type (else unknown). Giving `??` a type — not just ||/&& —
// lets `numA ?? numB` read NaN-safe (value-typed NUMBER → f64.eq) instead of routing
// through the bit-comparing __is_truthy, which mis-reads a non-canonical NaN.
VT['&&'] = VT['||'] = VT['??'] = (args) => {
  const ta = valTypeOf(args[0]), tb = valTypeOf(args[1])
  if (ta && ta === tb) return ta
  if (ta === VAL.BOOL && tb && tb !== VAL.BOOL) return tb
  if (tb === VAL.BOOL && ta && ta !== VAL.BOOL) return ta
  return null
}

// .work/todo.md §deletion-sweep — pure structural predicate: true exactly
// where a `?:`/`&&`/`||`/`??` node's own VT rule above takes the BOOL-vs-NUMBER
// benign coercion branch (142-179's `?:` "the raw 0/1 bool carrier IS its
// ToNumber image" lie, mirrored by `&&`/`||`/`??` above) — sound for arithmetic,
// unsound at an identity-observing consumer (===, typeof), which sees the
// collapsed NUMBER kind and cannot tell a genuine 0/1 from a coerced false/true.
// NO timing dependency — every input is a literal AST shape or an already-
// established valTypeOf, categorically unlike the reverted "kind not yet proven
// non-BOOL" trigger that boxed uniform-NUMBER self-host helpers on a fixpoint
// race (see design doc "Why the reverted broad fix broke 190+ kernel rows").
// BIGINT+nullish-literal (162-177) is a DIFFERENT VT branch — a BIGINT arm never
// satisfies `ta === VAL.BOOL`/`tb === VAL.BOOL` here, so it's excluded for free,
// not by special-casing.
//
// Recursive through nested merges: when this node's own arms collapse via the
// ordinary same-kind branch (`ta === tb`, e.g. both resolve NUMBER) rather than
// the coercion branch itself, the join is STILL ambiguous if either arm is
// itself an ambiguous merge — the outer NUMBER kind may carry a nested coerced
// bool's bits. A statically-resolved `?:` condition (VT['?:'] line 143-144)
// only ever evaluates its own live arm, so this mirrors that: recurse into the
// live arm instead of returning early.
// `vt` (optional): the valType resolver to consult — defaults to the plain
// GLOBAL valTypeOf, same locals-blind/locals-aware split as valTypeOf vs
// valTypeOfWithLocals above (round-6 prereq (a)'s precedent). narrow.js's
// Phase E (narrowI32Results) runs BEFORE ctx.func.localReps is populated for
// the function under analysis — it carries its own per-body `locals`/
// `valTypes` overlay instead (mirrors exprType's own BigInt gate, line ~2265:
// `valTypeOfWithLocals(expr, name => valTypes?.get(name) ?? lookupValType(name))`)
// — so a bare `valTypeOf('x')` there would miss a LOCAL fact and silently
// under-report the merge as unambiguous. Passing that same resolver through
// closes it.
export function hasAmbiguousBoolMerge(node, vt = valTypeOf) {
  // Direct indexing throughout — NO rest-destructure. This predicate runs at
  // 50+ emission sites on every stored/compared/returned node; the previous
  // `const [op, ...args] = node` allocated a fresh array per call, which the
  // self-hosted kernel pays as a real __alloc in its hottest loops while V8
  // escape-analyzes it away (the OPTF-bitmask asymmetry class: +33% alloc,
  // the gate's dominant regression).
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === '?:') {
    const cond = node[1], a = node[2], b = node[3]
    const truthy = literalTruthiness(cond)
    if (truthy != null) return hasAmbiguousBoolMerge(truthy ? a : b, vt)
    const ta = vt(a), tb = vt(b)
    if (ta === VAL.BOOL && tb === VAL.NUMBER) return true
    if (tb === VAL.BOOL && ta === VAL.NUMBER) return true
    if (ta && ta === tb) return hasAmbiguousBoolMerge(a, vt) || hasAmbiguousBoolMerge(b, vt)
    return false
  }
  if (op === '&&' || op === '||' || op === '??') {
    const a = node[1], b = node[2]
    const ta = vt(a), tb = vt(b)
    if (ta === VAL.BOOL && tb === VAL.NUMBER) return true
    if (tb === VAL.BOOL && ta === VAL.NUMBER) return true
    if (ta && ta === tb) return hasAmbiguousBoolMerge(a, vt) || hasAmbiguousBoolMerge(b, vt)
    return false
  }
  // Parenthesized grouping `(expr)` (node.length === 2 non-call — see
  // VT['()'] above for the call-vs-grouping shape invariant): the merge, if
  // any, lives one level down. Checked AFTER the merge ops (rarer shape).
  if (op === '()' && node.length === 2) return hasAmbiguousBoolMerge(node[1], vt)
  return false
}

// Dict-value-type census consumer — an INTERNAL HELPER ONLY
// (.work/todo.md §deletion-sweep Slice 1).
// `name[key]`/`name.prop` on a HASH dict-mode receiver: the VAL.* kind of
// every value ever WRITTEN through `name[anyKey] = v`
// (.work/todo.md §deletion-sweep §2, nameEscapes alias gate per
// .work/todo.md §deletion-sweep §2 Slice 3). INVARIANT: this stays OUT of
// VT['[]']/VT['.']'s own dict-mode fold — promoting a census read to an
// exact VT globally would make every OTHER consumer of that VT — composed
// expressions, container storage, kind-specific dispatch, string `+`,
// BigInt joint ops — silently bypass the mayBeUndefined protection unless it
// separately remembers to call censusMaybeUndefined too; opt-out instead of
// opt-in, unsound by construction. .work/todo.md §deletion-sweep §14 is the
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
// nameEscapes ALIAS GATE (.work/todo.md §deletion-sweep §2, Slice 3): the
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

// RECEIVER-KIND GUARD (.work/todo.md §deletion-sweep Slice 1; test/simd.js
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
// kind-traits.js) — `valTypeOf(name) === VAL.MAP` alone proves the receiver,
// no dynWriteVars-analog proxy needed on the global side.
// mapValueKindSet(name) — mapValueKindOf's raw-Set sibling, same shape as
// dictValueKindSet above (product-lattice Slice 7).
function mapValueKindSet(name) {
  if (typeof name !== 'string' || valTypeOf(name) !== VAL.MAP) return undefined
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
// mapValueKindOf (COORDINATOR RULING on OQ1, .work/lattice-design.md: a
// census-derived kind union must surface ONLY through its own opt-in
// projection, never the general Fact.possibleKinds field a future slice
// exposes for every OTHER kind question — mirrors the presentVal precedent:
// a real, individually-gated consumer list built one caller at a time, never
// a blanket promotion; three prior attempts to promote this exact axis
// globally were reverted as unsound). ZERO consumers as of product-lattice Slice 1
// (.work/lattice-design.md §5) — the structural landing only. Folds through
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

// maybeUndefined value-join (.work/todo.md §deletion-sweep §4/§8). Two
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
// .work/todo.md §deletion-sweep §15 for which consumers are live vs still
// gated out.
//
// censusShapedNode (Slice 2, .work/todo.md §deletion-sweep §3)
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
    // (lattice-design.md §5 Slice 3 precedent, the Fact.presence component
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
// (.work/todo.md §deletion-sweep §6/§12 Slice 5, the `presentKindUnboxed`
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
// Binary sibling of kinds 1-3 (.work/todo.md §deletion-sweep §14/§15):
// emit.js's `bigIntJointDispatch` reaches its i64 arithmetic — for ANY of
// the 9 binary arithmetic/bitwise ops, not just `+` — when BOTH operands'
// census independently claim BIGINT (the SAME AND,
// never OR — see `bigIntDomainsCanMix`'s own comment for why an OR would be
// unsound). Unlike kinds 1-3, this shape has NO absent-case bit pattern to
// special-case: `bigIntJointDispatch`'s own runtime domain check throws
// BIGINT_UNDEF_MIX before a genuinely-mismatched operand pair could ever
// reach a return here, so every value this export lane ever sees IS a
// genuine i64 arithmetic result — kind 4, for every op in
// BIGINT_JOINT_BINARY_OPS. interop.js
// needs no new table entry for kind 4: `decodeBigintSentinel`'s
// `BIGINT_SENTINEL_BITS[4]` is simply absent, so its `ret === undefined`
// comparison is always false for a real BigInt `ret` and the raw value passes
// through unchanged — already correct.
const BIGINT_JOINT_BINARY_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'])
export function censusBigintSentinelKind(node) {
  if (censusMaybeUndefinedKind(node) === VAL.BIGINT) return BIGINT_SENTINEL_KIND.BARE
  if (Array.isArray(node) && node.length === 2 && (node[0] === 'u-' || node[0] === '~')
      && censusMaybeUndefinedKind(node[1]) === VAL.BIGINT)
    return node[0] === 'u-' ? BIGINT_SENTINEL_KIND.UNARY_NEG : BIGINT_SENTINEL_KIND.UNARY_NOT
  if (Array.isArray(node) && node.length === 3 && BIGINT_JOINT_BINARY_OPS.has(node[0])
      && censusMaybeUndefinedKind(node[1]) === VAL.BIGINT && censusMaybeUndefinedKind(node[2]) === VAL.BIGINT)
    return BIGINT_SENTINEL_KIND.JOINT_BINARY
  // Kind 5 ("presentVal param producers"): a call whose CALLEE is a
  // plain single-param function/const-arrow (ctx.funcs.map) entirely made of
  // `-`/`~` applied to its OWN param (`const g = (v) => -v`, or an equivalent
  // single-return block `{ return -v }`) — the call-boundary sibling of kinds
  // 2/3 above, covering the param-hop shape `const f = (v) => -v; return
  // f(m.get('x'))` (present-key BIGINT). Deliberately NOT built on
  // `func.valResult`/`valResultMayBeUndefined` (narrowValResults' own
  // return-kind join, .work/todo.md §deletion-sweep §3 "Return kinds"):
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
        ? (e[0] === 'u-' ? BIGINT_SENTINEL_KIND.UNARY_NEG : BIGINT_SENTINEL_KIND.UNARY_NOT) : 0
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
  const walk = (node) => {
    if (flagged || !Array.isArray(node)) return
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
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(bodyRoot)
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
  const walk = (node) => {
    if (flagged || !Array.isArray(node)) return
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
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(bodyRoot)
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
  const walk = (node) => {
    if (poisoned || !Array.isArray(node)) return
    const op = node[0]
    if ((op === 'let' || op === 'const') && node.length >= 2) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && d[1] === name) observe(rhsKind(d[2]))
      }
    } else if (op === '=' && node[1] === name) observe(rhsKind(node[2]))
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(bodyRoot)
  const result = poisoned ? null : (claim ?? null)
  m.set(name, result)
  return result
}

/** censusMaybeUndefinedKind(expr) when it's directly census-shaped, else a
 *  bare-name expr's poison-disciplined trace through bodyRoot's own writes
 *  (namePresentValInBody) — the presentVal analogue of exprMayBeUndefinedIn,
 *  for narrow.js's inter-procedural call-site fold. */
export const exprPresentValIn = (expr, bodyRoot) =>
  censusShapedNode(expr) ? censusMaybeUndefinedKind(expr)
    : typeof expr === 'string' ? namePresentValInBody(bodyRoot, expr) : null

// `[]` op covers both array literals (1 arg) and index access (2 args).
// Array literal: `[]` → ['[]', null]; `[1,2]` → ['[]', [',', ...]]; `[x]` → ['[]', x].
// Index access:  `arr[i]` → ['[]', arr, i].
VT['[]'] = (args) => {
  if (args.length < 2) return VAL.ARRAY
  // A literal NEGATIVE index is always out of range → reads undefined, not the
  // element type. Returning a numeric elem type here would let `a[-1] === undefined`
  // fold to false (a NUMBER can't be undefined), silently dropping the guard.
  { const li = intLiteralValue(args[1]); if (li != null && li < 0) return null }
  // A non-numeric STRING-literal key is a PROPERTY read, not an element read:
  // on arrays/typed arrays it yields undefined (or a builtin method), never the
  // element kind. Typing it by elem let `a['@@iterator'] != null` fold TRUE on
  // a known array — the drain/GetIterator guards then called undefined (table
  // OOB). Canonical numeric strings ('0','1',…) DO address elements
  // (ToPropertyKey) and keep the elem typing below.
  {
    const k = args[1]
    const lit = Array.isArray(k) && k.length === 2 && k[0] == null ? k[1]
      : Array.isArray(k) && k[0] === 'str' ? k[1] : undefined
    if (typeof lit === 'string' && !/^(0|[1-9][0-9]*)$/.test(lit)) return null
  }
  // SRoA flat-array slot read: `a[k]` (static index) where `a` dissolved into
  // scalar `a#i` locals (scanFlatObjects). A write-once slot's value-type is its
  // element literal's — same numeric-binding as the `VT['.']` object case, so
  // `a[0] * 2` stays a plain f64 op instead of the polymorphic ToNumber battery.
  // A written slot stays answerable too when every write is self-preserving
  // (`a[k]++`/`a[k] += x` etc.) — see VT['.']'s identical comment above.
  if (typeof args[0] === 'string') {
    const flat = ctx.func.flatObjects?.get(args[0])
    if (flat) {
      const k = staticIndexKey(args[1])
      if (k != null && (!flat.written?.has(k) || flat.selfPreserving?.has(k))) {
        const i = flat.names.indexOf(k)
        if (i >= 0 && flat.values[i] !== undefined) return valTypeOf(flat.values[i])
      }
    }
  }
  // Destructure-temp array-literal slot read: `t[k]` where `t` is a compiler-
  // synthesized decl-destructure carrier bound directly to an array literal
  // (prepare/index.js prepDecl registers it — ctx.schema.arrayVars). Unlike the
  // flatObjects branch above, this covers ANY element expression, not just
  // compile-time constants (`let [a, b] = [1, BigInt(v)]`'s `BigInt(v)` isn't
  // SRoA-flattenable, but `t` never escapes and is never reassigned, so its
  // literal's per-index kind IS the slot's kind — the array sibling of `.`'s
  // ctx.schema.slotVT fact for the object-destructure temp).
  if (typeof args[0] === 'string') {
    const elems = ctx.schema.arrayVars?.get(args[0])
    if (elems) {
      const k = staticIndexKey(args[1])
      if (k != null) {
        const i = Number(k)
        if (Number.isInteger(i) && i >= 0 && i < elems.length && elems[i] !== undefined) return valTypeOf(elems[i])
      }
    }
  }
  // Indexed read on a known typed-array receiver yields Number except for
  // BigInt64Array/BigUint64Array, whose i64 carriers must stay BigInt-typed.
  // An UNPROVEN index can read past the end (= undefined per spec), but the undef
  // box is a NaN bit-pattern, so it COINCIDES with ToNumber(undefined) through
  // every numeric path — the NUMBER claim stays sound for dispatch (numeric arms,
  // the vectorizer). Only identity observations diverge; those folds consult
  // typedReadMaybeOob below and keep the runtime compare.
  if (typeof args[0] === 'string' && lookupValType(args[0]) === VAL.TYPED)
    return typedCtorElemValType(ctx.func.typedElem?.get(args[0])) || VAL.NUMBER
  // Indexed read on a STRING returns a 1-char string (SSO at runtime).
  if (typeof args[0] === 'string' && lookupValType(args[0]) === VAL.STRING) return VAL.STRING
  if (Array.isArray(args[0]) && valTypeOf(args[0]) === VAL.STRING) return VAL.STRING
  // Indexed read on a known Array<VAL> receiver: bind by rep.arrayElemValType.
  // Set by analyzeValTypes from body observations + emitFunc preseed for params.
  if (typeof args[0] === 'string') {
    const elemVt = ctx.func.localReps?.get(args[0])?.arrayElemValType
    if (elemVt) return elemVt
    // Module-level const array (a numeric/uniform table): its element val-type was
    // recorded on the global rep at decl time. Trust it only when no function element-
    // writes the array — dynWriteVars holds every var written via a non-named-property
    // index, so a `X[i]=str` anywhere disables this and falls back to the untyped read.
    if (!ctx.func.localReps?.has(args[0])) {
      const gElem = ctx.scope.globalReps?.get(args[0])?.arrayElemValType
      if (gElem && !ctx.types?.dynWriteVars?.has(args[0])) return gElem
    }
  }
  // INVARIANT: NO dict-mode receiver fold here: dictValueKindOf (above) is
  // an internal helper for censusMaybeUndefinedKind only — VT['[]'] must NOT
  // promote dictValueValType to an exact VT at a `[]` read site (see
  // dictValueKindOf's own doc comment above for the soundness argument).
  // Re-enabling that is the opt-in presentVal model, not a repeat of this
  // global promotion.
  // Direct double-index on a module-level nested numeric table — `C[i][j]` where
  // `C = [[…number…], …]`. The receiver is itself a single-index read of a global
  // array whose nested element kind was recorded at decl time. Same dynWriteVars
  // guard (now root-aware, so a `C[i][j]=…` write anywhere disables it).
  if (Array.isArray(args[0]) && args[0][0] === '[]' && args[0].length === 3 && typeof args[0][1] === 'string') {
    const base = args[0][1]
    if (!ctx.func.localReps?.has(base)) {
      const gNested = ctx.scope.globalReps?.get(base)?.arrayElemElemValType
      if (gNested && !ctx.types?.dynWriteVars?.has(base)) return gNested
    }
  }
  // Indexed read on an inline all-numeric array literal — `[2,4,2,9][i]` (floatbeat
  // chord/pattern tables; literal op is `[`, elements inline). Every element is a
  // Number, so the load is a Number; this lets toNumF64 skip __to_num on the result
  // and propagates numericness outward (e.g. a closure arg that then marks its param
  // numeric, or the surrounding `-arr[i]` that feeds a numeric accumulator).
  if (Array.isArray(args[0]) && args[0][0] === '[' && args[0].length > 1
      && args[0].slice(1).every(e => valTypeOf(e) === VAL.NUMBER)) return VAL.NUMBER
  return null
}

VT['.'] = (args) => {
  if (typeof args[1] !== 'string') return null
  // SRoA flat-object slot read: `p.x` where `p` dissolved into scalar `p#i`
  // locals (scanFlatObjects). A write-once slot's value-type IS its literal
  // initializer's, so bind by it — exactly as a plain `let slot = value` local
  // would. Without this `p.x * 2` looks like "could be anything" and pulls the
  // ToNumber + string-format battery, though it can only be numeric. Computed
  // on-demand (not cached at analyze time) because param val-types — `{x:n}`'s
  // `n` is numeric-by-divergence — are only seeded at emit. A reassigned slot
  // (`p.x = …`) stays untyped UNLESS every write is provably self-preserving
  // (`p.x = p.x + 1`, `p.x += 1`, prepare's `p.x++`/`--` desugar — see
  // analyze-scans.js selfPreservingWrittenKeys, the flat-SRoA sibling of the
  // schema-slot census's self-read neutrality): such a write can only ever
  // keep the literal's own kind, never change it.
  if (typeof args[0] === 'string') {
    const flat = ctx.func.flatObjects?.get(args[0])
    if (flat && (!flat.written?.has(args[1]) || flat.selfPreserving?.has(args[1]))) {
      const i = flat.names.indexOf(args[1])
      if (i >= 0 && flat.values[i] !== undefined) return valTypeOf(flat.values[i])
    }
  }
  // Schema slot read: when `varName` has a bound schemaId and `.prop` resolves
  // to a slot whose VAL kind is monomorphic across program-wide observations,
  // return that kind. Lets `+`, `===`, method dispatch skip runtime str-key
  // checks on numeric properties of known shapes. Precise-only — see
  // ctx.schema.slotVT for why structural subtyping is intentionally off.
  if (ctx.schema?.slotVT) {
    const slotVT = ctx.schema.slotVT(args[0], args[1])
    if (slotVT) return slotVT
  }
  // OBJECT `.prop` propagation: when the receiver chain roots at a binding
  // sourced from `JSON.parse(stringConst)`, walk the shape tree to recover the
  // child's val-type. Generic for any compile-time-known JSON literal.
  // The shape's per-prop kind is a DECL-SITE fact — writes can invalidate it:
  //   - a sid-bound receiver whose schema declares the prop: the slot census
  //     above (slotVT) is authoritative — it saw every resolvable write and
  //     answered null on clash/poison, so the stale decl kind must not revive
  //     (`o.x = 'oops'; o.x + 1` skipped concat dispatch — live miscompile);
  //   - otherwise, the write-hazard sets cover unresolvable-receiver writes
  //     that could reach this object through an alias.
  const sh = shapeOf(args[0])
  if (sh?.val === VAL.OBJECT || sh?.val === VAL.HASH) {
    const child = sh.props[args[1]]
    if (child) {
      const sid = typeof args[0] === 'string'
        ? (repOf(args[0])?.schemaId ?? ctx.schema?.vars?.get(args[0])) : null
      // Literal-decl scalar whose prop name is NEVER a named write target
      // anywhere in the program keeps its fold even when sid-bound: the veto
      // exists for slots the census saw written (`o.x = 'oops'`), but under
      // the whole-program hazard blanket (slotWriteHazards.pointsTo === 'ALL',
      // raised by UNRELATED unresolvable writes) slotVT above answers null for
      // every slot, and the veto then silently erases exactly the const-table
      // reads the literal skip below exists for — `LAYOUT.NAN_PREFIX_BITS`
      // stayed unprovable at all 100 self-graph sites, poisoning i64Hex's
      // cross-site val consensus into a residual boxed param. `writtenProps`
      // is the same never-written discipline slotTypedCtorAt already trusts
      // for raw typed loads; a named write to the prop on ANY receiver keeps
      // the veto (fail-closed).
      const litNeverWritten = child.literal && !ctx.types?.writtenProps?.has(args[1])
      if (sid != null && !litNeverWritten && ctx.schema?.list?.[sid]?.indexOf(args[1]) >= 0) return null
      // `child.literal` (shapeOfObjectLiteralAst's scalar-leaf fallback):
      // a compile-time constant drawn straight
      // from the object literal's own source text has no runtime slot to
      // write through — the write-hazard census below exists to catch an
      // ALIASED heap write this analysis can't trace, which cannot apply to
      // a value that was never a property STORE in the first place. Skip it
      // ONLY for that flagged case; every other `child` (JSON.parse'd,
      // propagated through a chain, a nested object) still goes through the
      // census exactly as before. INVARIANT: this skip is load-bearing — the
      // unconditional gate below reads `hz.pointsTo === 'ALL'` in the
      // self-hosted kernel (a whole-program "too many
      // unresolvable writes to track individually" fallback state), which
      // would otherwise silently veto `layout.js`'s `LAYOUT.NAN_PREFIX_BITS`
      // — a `const`, never-written module table — right after the
      // scalar-leaf handling above already proved its kind.
      if (!child.literal) {
        const hz = ctx.schema?.slotWriteHazards
        if (hz && (hz.pointsTo === 'ALL' || hz.props.has(args[1]) ||
          (hz.numeric && /^(0|[1-9][0-9]*)$/.test(args[1])))) return null
      }
      return child.val
    }
  }
  // INVARIANT: NO dict-mode receiver fold here, same as VT['[]'] above
  // (dictValueKindOf is a censusMaybeUndefinedKind-only helper — not wired
  // into VT): `prec['in']` → `['.','prec','in']` rewrite
  // (module/array.js:762-763) resolves the same way as `prec[k]` — see
  // dictValueKindOf's own doc comment above for the soundness argument.
  // Built-in property on a known sized kind — `.length` on STRING/ARRAY/TYPED,
  // `.size` on SET/MAP, `.byteLength`/`.byteOffset` on TYPED/BUFFER. These are
  // language invariants (the property is always a number on that kind), so typing
  // them NUMBER lets `+` skip the string-concat dispatch. Object schema slots
  // resolved above override this, keeping user-defined same-name slots sound.
  const objType = typeof args[0] === 'string' ? lookupValType(args[0]) : valTypeOf(args[0])
  const pvt = propValType(args[1], objType)
  if (pvt) return pvt
  return null
}

// Arithmetic expressions: BigInt if either operand is BigInt, else number.
const numericBinaryVT = (args) =>
  valTypeOf(args[0]) === VAL.BIGINT || valTypeOf(args[1]) === VAL.BIGINT ? VAL.BIGINT : VAL.NUMBER
for (const op of NUMERIC_BINARY_OPS) VT[op] = numericBinaryVT
// The binary sibling of censusBigintUnaryVT below (.work/todo.md
// §deletion-sweep §14) — generalizes VT['+']'s own both-census-BIGINT branch
// (kept there, unchanged) to the other 8 arithmetic/bitwise ops: emit.js's
// `bigIntJointDispatch` (see its own doc comment) makes their WASM
// computation correct for this shape too. Same AND (never OR)
// requirement as VT['+']/`bigIntDomainsCanMix`: a single census-BigInt
// operand paired with an unproven/proven-NUMBER other side must NOT
// upgrade — that combination resolves via `bigIntJointDispatch`'s own
// runtime branch (may genuinely throw or yield a real Number), never a
// static BIGINT claim. Excludes `u-` (unary — censusBigintUnaryVT below
// already covers it).
const censusBigintBinaryVT = (base) => (args) =>
  censusMaybeUndefinedKind(args[0]) === VAL.BIGINT && censusMaybeUndefinedKind(args[1]) === VAL.BIGINT
    ? VAL.BIGINT : base(args)
for (const op of NUMERIC_BINARY_OPS) if (op !== 'u-') VT[op] = censusBigintBinaryVT(numericBinaryVT)
// `'+1'`/`'-1'` — prepare's dedicated member ++/-- unary (index.js '++'/'--'):
// "the operand, incremented/decremented by one" — kind-preserving, exactly
// like the bare-name '++'/'--' unary rule below, just spelled as its own op
// so it's unambiguous at emit time (see prepare/index.js's comment on why).
VT['+1'] = VT['-1'] = (args) => valTypeOf(args[0])
// `~`, `++`, `--`, `**` preserve/propagate BigInt…
const numericUnaryVT = (args) =>
  valTypeOf(args[0]) === VAL.BIGINT || (args[1] != null && valTypeOf(args[1]) === VAL.BIGINT) ? VAL.BIGINT : VAL.NUMBER
for (const op of NUMERIC_UNARY_OPS) VT[op] = numericUnaryVT
// …while `>>>` and unary-plus throw on bigint operands so they always yield Number.
// `u-`/`~` census-BIGINT hardening (.work/todo.md §deletion-sweep §14):
// numericBinaryVT/numericUnaryVT's shared "unknown operand → optimistic
// NUMBER default" (same class as VT['+']'s own accepted imprecision, see
// valTypeOfWithLocals's SOUND-`+`/SOUND-unary doc comments) is wrong for a
// census-BIGINT dict/Map operand: with VT['[]']/['.']/['()'] NOT proving
// BIGINT directly (see the dict-mode fold invariant above), `-m.get(k)`/
// `~d[k]` on a BIGINT-census container would otherwise silently fall back
// to the optimistic NUMBER default — regressing `_resultNumeric`'s
// boundary-wrap decision (compile/index.js) AND emitStrictEq's
// REF_EQ_KINDS raw-i64-compare dispatch (`vta === vtb === VAL.BIGINT`,
// emit.js), which needs THIS static claim to route `-m.get(k) === -5n`
// correctly. INVARIANT: override applies for EXACTLY the two ops
// censusBigintSentinelKind recognizes (`u-`, `~`) — not the general
// numericBinaryVT/numericUnaryVT default, and not `++`/`--`/`**`/`>>>`/`u+`
// (no export-lane sentinel exists for those shapes) — mirroring emitNeg/`~`'s
// own OR-arm activation-gate hardening so the STATIC kind claim and the
// RUNTIME dispatch it feeds stay in lockstep. Sound for
// the SAME reason emitNeg's OR-arm is sound: this claim is per-CONTAINER (the census
// proves every value ever written through this receiver is BIGINT), not per-key — an
// absent-key read still resolves through bigIntUnary's own runtime select/isUndef
// branch and the sentinel export lane, both of which decide the ACTUAL present-vs-
// absent value independent of this static claim (an absent-key strict-eq
// against a BigInt literal stays correctly `false`, REF_EQ_KINDS' i64 bit-compare
// naturally differs).
const censusBigintUnaryVT = (base) => (args) =>
  args[1] == null && censusMaybeUndefinedKind(args[0]) === VAL.BIGINT ? VAL.BIGINT : base(args)
VT['u-'] = censusBigintUnaryVT(numericBinaryVT)
VT['~'] = censusBigintUnaryVT(numericUnaryVT)
VT['>>>'] = VT['u+'] = () => VAL.NUMBER

VT['+'] = (args) => {
  const ta = valTypeOf(args[0]), tb = valTypeOf(args[1])
  if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
  if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
  // Honest boundary (.work/todo.md §deletion-sweep §14/§15): BOTH operands'
  // census independently claiming BIGINT upgrades
  // this static claim too — the binary sibling of censusBigintUnaryVT above,
  // same AND (never OR) requirement as emit.js's bigIntDomainsCanMix (a
  // single census-BigInt operand paired with an unproven/proven-NUMBER other
  // side must NOT upgrade: that combination resolves via `bigIntJointDispatch`'s
  // own runtime branch, not a static claim here). INVARIANT: this branch is
  // load-bearing, not decorative — without it, `let x = m.get(a);
  // let y = m.get(b); return x + y` (both present-key BIGINT census, emit.js's
  // own widened gate computes the CORRECT i64 sum) decodes wrong at
  // the export boundary — compile/index.js's `_resultNumeric`/
  // `_resultBigintSentinel` boundary-wrap decision reads THIS function's
  // return value, and the optimistic-NUMBER default below would send it down
  // the NUMBER decode lane instead of the BigInt sentinel lane (the raw
  // i64-sum bits misread as a NUMBER — `4e-323` instead of `8n`).
  if (censusMaybeUndefinedKind(args[0]) === VAL.BIGINT && censusMaybeUndefinedKind(args[1]) === VAL.BIGINT)
    return VAL.BIGINT
  // OPTIMISTIC NUMBER for unknown sides — load-bearing for local numeric
  // inference (demoting it doubled the slice/nest loop-body op counts).
  // The one consumer where this optimism is UNSOUND across a boundary is
  // function-RESULT stamping: narrowValResults uses its own sound `+` rule
  // (unknown side → no claim), so a string-building helper like watr's
  // `hex + hex` _sb no longer gets a NUMBER valResult that sends call-site
  // compares down the raw-f64 path.
  return VAL.NUMBER
}

// Assignment & compound-assign expressions return the rhs value. Without this,
// `(a = x*x) + (b = y*y)` falls through to null and `+` emits the polymorphic
// string-concat dispatch on two pure-numeric subexpressions.
VT['='] = (args) => valTypeOf(args[1])
VT['+='] = (args) => {
  const ta = typeof args[0] === 'string' ? lookupValType(args[0]) : null
  const tb = valTypeOf(args[1])
  if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
  if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
  return VAL.NUMBER
}
const compoundNumericVT = (args) => {
  const ta = typeof args[0] === 'string' ? lookupValType(args[0]) : null
  return ta === VAL.BIGINT || valTypeOf(args[1]) === VAL.BIGINT ? VAL.BIGINT : VAL.NUMBER
}
for (const op of COMPOUND_NUMERIC_OPS) VT[op] = compoundNumericVT

VT['()'] = (args) => {
  const callee = args[0]
  // __iter_arr normalizes an iterable to an index-iterable Array: Set→keys,
  // Map→[k,v], while Array/String/TypedArray pass through unchanged. The result
  // type drives the downstream arr[i]/.length dispatch, so a Set/Map source
  // becomes ARRAY and everything else keeps the source's own type.
  if (callee === '__iter_arr') {
    const t = valTypeOf(args[1])
    return t === VAL.SET || t === VAL.MAP ? VAL.ARRAY : t
  }
  // for-in's read-only key list (src/prepare) — always an Array of key strings.
  if (callee === '__keys_ro') return VAL.ARRAY
  // Ternary is parsed as call to '?' operator: ['()', ['?', cond, a, b]]
  if (Array.isArray(callee) && callee[0] === '?') {
    const truthy = literalTruthiness(callee[1])
    if (truthy != null) return valTypeOf(truthy ? callee[2] : callee[3])
    const ta = valTypeOf(callee[2]), tb = valTypeOf(callee[3])
    return ta && ta === tb ? ta : null
  }
  // Closure-TABLE dispatch `NAME[idx](args)`: the table-dispatch analog of the
  // named-closure valResult lookup below — dyn-closure-tables.js's
  // scanClosureTableLatticeCandidates derives this from every element's raw
  // AST (closureBodyReturnKind) BEFORE the elements are created, so it's
  // available here even though the elements' own closure.make hasn't run yet
  // (a table's array literal, and therefore its elements, only emit at module
  // end — after every caller, including a loop-carried `x = ops[code[i]](x,k)`).
  if (Array.isArray(callee) && callee[0] === '[]' && typeof callee[1] === 'string') {
    const vt = ctx.scope?.closureTableValResult?.get(callee[1])
    if (vt) return vt
  }
  // Constructor results + user function return-type inference
  if (typeof callee === 'string') {
    if (callee === 'JSON.parse') {
      const src = jsonConstString(args[1])
      if (src != null) {
        const c = src.trimStart()[0]
        if (c === '{') return VAL.OBJECT
        if (c === '[') return VAL.ARRAY
        if (c === '"') return VAL.STRING
        // 't'/'f' → boolean: the parser mints the TRUE/FALSE atom (module/json.js
        // litCase), NOT a raw 0/1 — claiming NUMBER here would let numeric fast
        // paths raw-add the atom bits.
        if (c === 't' || c === 'f') return VAL.BOOL
        if (c === '-' || (c >= '0' && c <= '9')) return VAL.NUMBER
      }
    } else {
      const vt = calleeValType(callee, args, ctx)
      if (vt != null) return vt
    }
  }
  if (Array.isArray(callee) && callee[0] === '.') {
    const [, obj, method] = callee
    // INVARIANT: NO `.get` short-circuit here: mapValueKindOf (above)
    // is a censusMaybeUndefinedKind-only helper — VT['()'] must NOT promote
    // a `.get()` read to an exact VT (see mapValueKindOf's own doc comment
    // above for the soundness argument; re-enablement is the opt-in
    // presentVal model).
    const vt = methodValType(method, obj, valTypeOf(obj), ctx)
    if (vt != null) return vt
  }
  // Parenthesized NON-call grouping `(expr)` — a real call's tail is always
  // [callee, rawArgsNode] (length 2, even for a zero-arg call: prep's '()'
  // handler always keeps the args slot, ast.js callArgs/setCallArgs's
  // canonical shape), so args.length === 1 here can ONLY be a grouping node
  // `['()', expr]`, never a call. Falls through to here when `expr`'s own
  // head didn't match one of the callee-shaped special cases above (ternary/
  // '[]'/'.'/string dispatch) — a plain comparison/logical/literal grouping
  // like `(x>0)`. research.md §Carrier invariant MECHANISM B: this fallthrough
  // used to return null (the detector blind spot — `((x>0)&&1)` collapsed to
  // an unrecognized NUMBER/null merge instead of the true BOOL∪NUMBER kind).
  // Pure structural unwrap: the grouping's type IS its inner expression's type.
  if (args.length === 1) return valTypeOf(callee)
  return null
}

export function valTypeOf(expr) {
  if (expr == null) return null
  if (typeof expr === 'number') return VAL.NUMBER
  if (typeof expr === 'boolean') return VAL.BOOL
  if (typeof expr === 'bigint') return VAL.BIGINT
  if (typeof expr === 'string') return lookupValType(expr)
  if (!Array.isArray(expr)) return null

  const [op, ...args] = expr
  if (op == null) {
    // Literal forms: [] = undefined, [null, null] = null, [null, n] = number, [, bool] = boolean.
    // Bigint literals are NEVER this shape — the parser tags them structurally
    // as ['bigint', decimalStr] (see parse.js, VT.bigint below; audit P0-2),
    // so a `typeof` probe here would be both unnecessary AND unsound: under
    // self-host, `typeof` on an untagged subnormal-magnitude NUMBER literal
    // reads 'bigint' too (the carrier is bit-identical — the very collapse
    // this tag exists to avoid), which used to misclassify e.g. `5e-324`'s
    // OWN literal node as VAL.BIGINT and corrupt its export boundary.
    if (args.length === 0) return null              // undefined literal
    if (args[0] == null) return null                // null literal
    if (typeof args[0] === 'boolean') return VAL.BOOL
    if (typeof args[0] === 'symbol') return null    // prepared null sentinel
    // C5b hardening: a string payload here is never a real string LITERAL
    // (prepare/index.js converts every one to ['str', x] before this runs —
    // this shape is the parser's own pre-conversion encoding, and the one
    // OTHER known producer, inline.js's hoisted-temp wrapper, was C5's own
    // fix). It would mean some NEW producer reintroduced the ambiguity a
    // name and a string share through this shape — fail to null rather than
    // fall through to the NUMBER default below and misclassify it.
    if (typeof args[0] === 'string') return null
    return VAL.NUMBER
  }
  return VT[op]?.(args) ?? null
}

/**
 * Kind-generic, LOCAL-aware sibling of valTypeOf — round-6 prereq (a)/(sibling
 * of the compound-assign fix). A bare identifier inside valTypeOf's own VT[op]
 * recursion (numericBinaryVT/numericUnaryVT calling plain `valTypeOf(args[0])`)
 * always resolves through the GLOBAL lookupValType, which has nothing to say
 * about a name whose kind is only known LOCALLY at the call site — a plain
 * function-body local before narrow.js's per-function reps are live
 * (narrowValResults' analyzeBody(body).valTypes), or a closure param/capture
 * refined by an enclosing `typeof` guard (module/function.js's return-kind
 * pre-scan). `return ++n` on a proven-BIGINT local fell through exactly this
 * gap: valTypeOf(['++','n']) → numericUnaryVT → valTypeOf('n') →
 * lookupValType('n') → null, even though the caller already knows n is BIGINT.
 *
 * `resolveLocal(name)` handles bare identifiers; everything else re-derives
 * the same handful of ops valTypeOf's callers already special-case locally
 * (ternary/logical-both-arms-agree, '+'’s STRING-vs-arith fork, and — NEW —
 * the unary BigInt-preserving family u- ~ ++ --, mirroring numericUnaryVT/
 * numericBinaryVT's own "bigint operand → bigint result" rule). Every other
 * op falls through to plain valTypeOf(expr), which is locals-blind but was
 * already the accepted fallback everywhere this is used — unchanged behavior.
 * Not resolving a name (resolveLocal returns null/undefined) simply propagates
 * null upward: the fail-open boundary for a kind that isn't LOCALLY settled.
 */
export function valTypeOfWithLocals(expr, resolveLocal) {
  if (expr == null) return null
  if (typeof expr === 'string') return resolveLocal(expr) ?? null
  if (!Array.isArray(expr)) return valTypeOf(expr)
  const [op, ...args] = expr
  const rec = (e) => valTypeOfWithLocals(e, resolveLocal)
  if (op === '?:') {
    const a = rec(args[1]), b = rec(args[2])
    return a && a === b ? a : null
  }
  if (op === '&&' || op === '||') {
    const a = rec(args[0]), b = rec(args[1])
    return a && a === b ? a : null
  }
  // SOUND `+` — see narrowValResults' identical comment (src/compile/narrow.js):
  // unknown side → no claim (VT['+']'s own optimistic NUMBER guess is fine for
  // local numeric inference but unsound to hand back as a firm kind claim).
  // Settled directly from `a`/`b` (NOT `valTypeOf(expr)`, round-7 fix — see the
  // SOUND-arithmetic/bitwise family just below for why): `rec` already proved
  // both operands' kind through resolveLocal, which sees LOCALLY-scoped facts
  // (analyzeBody's per-function valTypes map, e.g. `let x = BigInt(v)`) that the
  // GLOBAL-only plain `valTypeOf` re-derivation below cannot see at all — a bare
  // name is invisible to `lookupValType` unless it's also a MODULE-level global.
  // INVARIANT: falling through to `valTypeOf(expr)` after `rec` already
  // proved BOTH sides BIGINT would silently discard that proof and
  // re-resolve through the blind, globally-optimistic default, landing back
  // on VAL.NUMBER — exactly the general miscompile this whole function
  // exists to prevent, e.g. `(v,w) => { let x = BigInt(v); let y =
  // BigInt(w); return x + y }` misdecoding at the export boundary, the
  // identical class as the sibling arithmetic ops below (`+` is not immune
  // to this despite the "SOUND +" framing elsewhere in this file).
  if (op === '+') {
    const a = rec(args[0]), b = rec(args[1])
    if (a === VAL.STRING || b === VAL.STRING) return VAL.STRING
    if (a == null || b == null) return null
    return a === VAL.BIGINT || b === VAL.BIGINT ? VAL.BIGINT : VAL.NUMBER
  }
  // Arithmetic/bitwise siblings (- * / % & | ^ << >>, the binary half of
  // NUMERIC_BINARY_OPS minus its unary member `u-`, handled by the unary
  // family just below): INVARIANT: these must NOT fall all the way through
  // to the file-ending `return valTypeOf(expr)`, which re-derives via
  // numericBinaryVT's OWN global-only `valTypeOf(args[0])`/`valTypeOf(args[1])`,
  // blind to whatever `rec` (this function's own local resolver) just
  // proved. A genuinely BigInt-valued local (`let x = BigInt(v)`) flowing
  // through `x - y` would otherwise claim `func.valResult`/`_resultNumeric`
  // = NUMBER — wrong, sending a real i64 BigInt result down the plain-f64
  // (or generic-dynamic) export lane instead of the i64exp BigInt lane.
  //
  // UNLIKE `+` just above: no "unknown side → no claim" veto here. `+` needs
  // that veto because an unproven operand could ALSO be a STRING (silently
  // wrong to claim NUMBER when the true kind might be STRING — the narrowed-
  // result compare-corruption class that rule was written to prevent). None
  // of these nine ops have a STRING arm at all — `-`/`*`/etc. ALWAYS ToNumeric
  // both operands, so the only question is NUMBER-vs-BIGINT, and
  // numericBinaryVT's own "unknown → NUMBER" optimistic default for that
  // question is the LONG-established, deliberately accepted imprecision this
  // whole file already relies on everywhere else (its own doc comment: "load-
  // bearing for local numeric inference"). Mirroring that formula exactly —
  // just sourced from `rec` instead of the blind global `valTypeOf` — ADDS
  // the missing local-BigInt proof without changing behavior for the "rec
  // can't resolve either side" case at all. INVARIANT: a `null`-propagating
  // veto here would break the closure-table call-site param lattice's own
  // bootstrapping — dyn-closure-tables.js's `closureBodyReturnKind` unifies
  // over `(x,k)=>(x+k)|0`-shaped elements BEFORE `x`/`k` have any local
  // evidence at all, relying on exactly this "unknown → NUMBER" default to
  // settle the table's call-expression result kind; vetoing it to null
  // breaks that fixpoint and regresses the `f64.add`-with-no-`__str_concat`
  // codegen pin in test/closures.js.
  if (op === '-' || op === '*' || op === '/' || op === '%' ||
      op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>') {
    const a = rec(args[0]), b = rec(args[1])
    return a === VAL.BIGINT || b === VAL.BIGINT ? VAL.BIGINT : VAL.NUMBER
  }
  // Unary BigInt-preserving family (u- ~ ++ --): kind follows the single
  // operand exactly like numericUnaryVT's own rule, just sourced from
  // resolveLocal instead of the global lookupValType. `!` and the other
  // BOOL_OPS are UNAFFECTED on purpose — VT.bool ignores its operand's kind
  // entirely (always VAL.BOOL), so the locals-blind valTypeOf(expr) fallback
  // is already exact for them; no case needed here.
  // SOUND unary (§6/§12 Slice 5, present-key BigInt export lane): same "unknown
  // side → no claim" discipline as SOUND `+` just above — an operand whose kind
  // the LOCAL resolver can't settle (`rec` returns null — e.g. a dict/Map
  // `.get()` read whose census kind isn't available yet at this whole-program
  // pass, narrow.js narrowValResults' own ordering gap) must NOT fall through
  // to numericUnaryVT's global, unconditionally-resolving optimistic-NUMBER
  // default: that default is what made `export let f = () => -m.get('x')`
  // claim `func.valResult = VAL.NUMBER` even though the operand can genuinely
  // be BIGINT, skipping the i64 boundary wrap entirely (a real, live
  // miscompile fixed here, not just a missed optimization — `_resultNumeric`,
  // computed later while per-function reps ARE live, correctly re-derives an
  // ordinary numeric unary's NUMBER result independently, so this costs no
  // real specialization for the common case).
  if (op === 'u-' || op === '~' || op === '++' || op === '--') {
    const a = rec(args[0])
    if (a === VAL.BIGINT) return VAL.BIGINT
    if (a == null) return null
    return valTypeOf(expr)
  }
  // Method call `obj.method(...)` (parsed as `['()', ['.', obj, method], argsNode]`):
  // plain valTypeOf's own VT['()'] already special-cases this shape (methodValType(
  // method, obj, valTypeOf(obj), ctx)), but valTypeOf(obj) for a bare-identifier
  // receiver resolves through the GLOBAL lookupValType only — blind to a kind this
  // pass's own `resolveLocal` already proved body-locally (analyzeBody's valTypes,
  // not yet installed into ctx.func.localReps at plan time). A handful of methods
  // GATE their claim on a proven receiver kind (`.has`/`.delete` on Map/Set,
  // `.add`/`.set`, the Set-algebra family — kind-traits.js methodValType) rather
  // than claiming unconditionally, so an unproven-but-locally-known receiver (e.g.
  // `let m = new Map(); return m.has(k)`) silently lost its VAL.BOOL claim here,
  // leaving func.valResult unset and the boundary wrapper crossing a raw 0/1
  // number instead of the canonical TRUE_NAN/FALSE_NAN atom. Resolve the receiver
  // through `rec` (this function's own local-aware recursion) first; methodValType
  // itself is representation-agnostic (works the same whether objType came from
  // here or the global path), so this is purely additive — a method whose claim
  // doesn't depend on objType (most STRING/NUMBER/ARRAY methods) was never blocked
  // by this gap in the first place.
  if (op === '()' && Array.isArray(args[0]) && args[0][0] === '.') {
    const [, obj, method] = args[0]
    const objType = rec(obj)
    const vt = methodValType(method, obj, objType, ctx)
    if (vt != null) return vt
  }
  return valTypeOf(expr)
}

export function jsonConstString(expr) {
  if (Array.isArray(expr) && expr[0] === 'str' && typeof expr[1] === 'string') return expr[1]
  // C5b hardening: see stringLiteral's (emit.js) identical arm removal —
  // `[null, string]` has no producer past prepare/index.js's normalization.
  if (typeof expr === 'string') {
    return ctx.scope.shapeStrs?.get(expr) ?? ctx.scope.constStrs?.get(expr) ?? null
  }
  return null
}

function jsonShapeStrings(expr) {
  const single = jsonConstString(expr)
  if (single != null) return [single]
  if (Array.isArray(expr) && expr[0] === '[]' && typeof expr[1] === 'string') return ctx.scope.shapeStrArrays?.get(expr[1]) ?? null
  return null
}

/** Build a structural shape tree from a parsed JSON value. Each node is
 *  `{ val, props?, elem? }` — `val` is the inferred VAL kind (matches
 *  rep.val in localReps entries). Lets `valTypeOf` propagate VAL kinds
 *  through `.prop` chains and `[i]` reads on bindings sourced from
 *  `JSON.parse` of a compile-time-known string. Polymorphic arrays drop
 *  their `elem`. */
function shapeOfJsonValue(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return { val: VAL.NUMBER }
  if (typeof v === 'string') return { val: VAL.STRING }
  if (typeof v === 'boolean') return { val: VAL.NUMBER }
  if (Array.isArray(v)) {
    let elem = null
    for (const x of v) {
      const s = shapeOfJsonValue(x)
      if (!s) { elem = null; break }
      if (!elem) elem = s
      else if (!shapeUnifies(elem, s)) { elem = null; break }
    }
    return { val: VAL.ARRAY, elem }
  }
  if (typeof v === 'object') {
    const props = Object.create(null)
    const names = Object.keys(v)
    for (const k of names) {
      const s = shapeOfJsonValue(v[k])
      if (s) props[k] = s
    }
    return { val: VAL.OBJECT, props, names }
  }
  return null
}

function shapeUnifies(a, b) {
  if (!a || !b || a.val !== b.val) return false
  if (a.val === VAL.OBJECT || a.val === VAL.HASH) {
    const ak = Object.keys(a.props), bk = Object.keys(b.props)
    if (ak.length !== bk.length) return false
    for (const k of ak) {
      if (!b.props[k] || !shapeUnifies(a.props[k], b.props[k])) return false
    }
  }
  if (a.val === VAL.ARRAY) {
    if ((a.elem == null) !== (b.elem == null)) return false
    if (a.elem && !shapeUnifies(a.elem, b.elem)) return false
  }
  return true
}

function shapeLayoutUnifies(a, b) {
  if (!shapeUnifies(a, b)) return false
  if (a.val === VAL.OBJECT || a.val === VAL.HASH) {
    if (a.names?.length !== b.names?.length) return false
    for (let i = 0; i < a.names.length; i++) if (a.names[i] !== b.names[i]) return false
  }
  if (a.val === VAL.ARRAY && a.elem) return shapeLayoutUnifies(a.elem, b.elem)
  return true
}

function parseJsonShape(src) {
  if (typeof src !== 'string') return null
  let parsed
  try { parsed = JSON.parse(src) } catch { return null }
  return shapeOfJsonValue(parsed)
}

function parseUnifiedJsonShape(srcs) {
  if (!srcs?.length) return null
  let out = null
  for (const src of srcs) {
    const sh = parseJsonShape(src)
    if (!sh) return null
    if (!out) out = sh
    else if (!shapeLayoutUnifies(out, sh)) return null
  }
  return out
}

/** Resolve the json shape for an expression by walking name → rep.jsonShape and
 *  `.prop` / `[i]` indirection. Returns null when shape is unknown at this site. */
export function shapeOf(expr) {
  if (typeof expr === 'string')
    return ctx.func.localReps?.get(expr)?.jsonShape
        ?? ctx.scope.globalReps?.get(expr)?.jsonShape
        ?? null
  if (!Array.isArray(expr)) return null
  const [op, ...args] = expr
  if (op === '()' && args[0] === 'JSON.parse') {
    const srcs = jsonShapeStrings(args[1])
    if (srcs) return parseUnifiedJsonShape(srcs)
  }
  if (op === '.' && typeof args[1] === 'string') {
    const parent = shapeOf(args[0])
    if (parent?.val === VAL.OBJECT || parent?.val === VAL.HASH) return parent.props[args[1]] || null
  }
  if (op === '[]' && args.length === 2) {
    const parent = shapeOf(args[0])
    if (parent?.val === VAL.ARRAY) {
      // non-numeric string-literal key = PROPERTY read, not an element (see VT['[]'])
      const k = args[1]
      const lit = Array.isArray(k) && k.length === 2 && k[0] == null ? k[1]
        : Array.isArray(k) && k[0] === 'str' ? k[1] : undefined
      if (typeof lit === 'string' && !/^(0|[1-9][0-9]*)$/.test(lit)) return null
      return parent.elem || null
    }
  }
  return null
}

// Recognizes `cond && {k: v, …}` — kind.js's cycle-free mirror of module/
// object.js's identical-named function (this file must not import the
// object stdlib module — see spreadSchema's own doc just below). Duplicated,
// not shared; keep the two in lockstep by hand, same discipline spreadSchema
// itself already documents for resolveSchema. Returns the inner literal's
// key list (order preserved) or null.
function conditionalSpreadGroup(node) {
  if (!Array.isArray(node) || node[0] !== '&&' || node.length !== 3) return null
  let inner = node[2]
  while (Array.isArray(inner) && inner[0] === '&&' && inner.length === 3) inner = inner[2]
  if (!Array.isArray(inner) || inner[0] !== '{}') return null
  const props = inner.length === 2 && Array.isArray(inner[1]) && inner[1][0] === ','
    ? inner[1].slice(1) : inner.slice(1)
  if (!props.length || !props.every(p => Array.isArray(p) && p[0] === ':')) return null
  return props.map(p => p[1])
}

/** Spread source's static schema (key list) or null if unknown at compile time.
 *  Mirrors module/object.js `resolveSchema` so kind inference predicts the same
 *  OBJECT-vs-HASH decision emitObjectSpread makes (kept here to keep kind.js
 *  cycle-free — it must not import the object stdlib module). */
function spreadSchema(obj) {
  // A parameter's compile-time schema is an inferred/union guess (and is unbound
  // during this body's analysis but bound by emit) — see resolveSchema in
  // module/object.js. Treat params as unknown so the spread result is HASH-typed
  // consistently across analyze and emit; otherwise reads misdispatch.
  if (typeof obj === 'string') {
    if (ctx.func.current?.params?.some(p => p.name === obj)) return null
    return ctx.schema?.resolve?.(obj)
  }
  // Literal `new X(...)`/`X(...)` Error-constructor call — mirrors module/
  // object.js `resolveSchema`'s identical branch (.work/todo.md §deletion-sweep
  // finding-1/3). INVARIANT: this closes an analyze/emit disagreement — a
  // BOUND Error name already agreed via ctx.schema.resolve above,
  // but this literal shape fell through to `shapeOf` below, which doesn't
  // know Error calls, so it resolved null/HASH here while emit's own
  // resolveSchema resolved the physical schema. Same physical layout for
  // every one of the 7 classes, so no class-name branching needed).
  if (Array.isArray(obj) && obj[0] === '()' && typeof obj[1] === 'string' && ERR_CLASS_NAMES.includes(obj[1]))
    return ERR_SCHEMA_PROPS
  // Conditional-spread group (module/object.js conditionalSpreadGroup /
  // mergeSpreadNames) — checked BEFORE the plain '{}' branch below, whose
  // no-nested-spread-recursion contract stays exactly as it was for every
  // other shape (an existing spreadSchema/resolveSchema asymmetry this
  // doesn't touch).
  const condKeys = conditionalSpreadGroup(obj)
  if (condKeys) return condKeys
  if (Array.isArray(obj) && obj[0] === '{}')
    return obj.slice(1).filter(p => Array.isArray(p) && p[0] === ':').map(p => p[1])
  const sh = shapeOf(obj)
  return (sh?.val === VAL.OBJECT && sh.names) ? sh.names : null
}

// Kind.js's cycle-free mirror of module/object.js `mergeSpreadNames` — VT['{}']
// below only needs the resolves/doesn't-resolve verdict (no consumer here
// needs a schema id or the merged name list itself), so this returns a bool.
// Same collision discipline: a conditional group's key touched by more than
// one prop/source bails the WHOLE merge (→ false, HASH-typed) — MUST match
// emitObjectSpread's own bail exactly, or analysis predicts OBJECT while
// emit builds a HASH and reads misdispatch (the exact class of bug this
// mirror exists to prevent — see spreadSchema's own doc above).
function spreadMergeResolves(props) {
  const seen = new Set(), condSeen = new Set()
  for (const p of props) {
    if (Array.isArray(p) && p[0] === '...') {
      const group = conditionalSpreadGroup(p[1])
      if (group) {
        for (const n of group) {
          if (seen.has(n)) return false
          seen.add(n); condSeen.add(n)
        }
        continue
      }
      const s = spreadSchema(p[1])
      if (!s) return false
      // An ORDINARY spread source whose OWN schema already carries
      // conditional slots — module/object.js mergeSpreadNames' identical
      // bail (re-spreading an already-conditional binding propagates no
      // further; see conditionalSpreadGroup's own doc). Precise-sid only,
      // same documented boundary as the collection.js `in` operator guard.
      if (typeof p[1] === 'string' && ctx.schema?.hasCondAbsent?.(ctx.schema.idOf(p[1]))) return false
      for (const n of s) {
        if (condSeen.has(n)) return false
        seen.add(n)
      }
    } else if (Array.isArray(p) && p[0] === ':') {
      if (condSeen.has(p[1])) return false
      seen.add(p[1])
    }
  }
  return true
}

/** Build a structural shape from a `{}` AST node — recursive for nested
 *  object/array literals + propagating shapes through identifier references
 *  (so `let G = {…}; let H = {x: G}` carries G's shape under H.x). Returns
 *  null when any property breaks the static-shape contract (computed key,
 *  spread, non-shape value). Only called from `recordGlobalRep` — local
 *  bindings keep relying on `shapeOf` whose narrower contract (JSON.parse /
 *  traversal only) lets `Object.assign(a, …)` extend `a`'s schema without
 *  locking a static jsonShape onto it.
 *
 *  Scalar-literal property leaf (.work/bigint-
 *  retirement-design.md §5 residual-site rule 1): a property whose VALUE is
 *  itself a compile-time-decidable scalar expression (`NAN_PREFIX_BITS:
 *  0x7FF8000000000000n`, or any other literal/arithmetic form `valTypeOf`
 *  already classifies — NUMBER/STRING/BOOL/BIGINT/…). INVARIANT: this must
 *  be recorded here — the recursive call above only ever returns non-null
 *  for a NESTED `{}`/name-reference child, so without this branch a scalar
 *  leaf's `child` stays null and the property silently drops from `props`,
 *  leaving `VT['.']` nothing to answer a `.prop` read with and forcing every
 *  reader back to the untyped/dynamic path — concretely, `layout.js`'s
 *  `LAYOUT.NAN_PREFIX_BITS` (a plain module-object BigInt-literal property)
 *  would be unprovable at its own read sites, poisoning `i64Hex`'s
 *  cross-call-site `val` consensus (narrow.js `hardParamVal`/
 *  `bigintBoxedVerdict`) into a residual boxed PARAM. General fix, not
 *  layout.js-specific: ANY module-level object literal with a
 *  literal/statically-decidable scalar property now gets that property's
 *  kind recorded, the same way `shapeOfJsonValue` already does for a
 *  JSON.parse'd scalar. */
export function shapeOfObjectLiteralAst(expr) {
  if (typeof expr === 'string') return shapeOf(expr)
  if (!Array.isArray(expr) || expr[0] !== '{}') return shapeOf(expr)
  const raw = expr.length === 2 && Array.isArray(expr[1]) && expr[1][0] === ','
    ? expr[1].slice(1)
    : expr.slice(1)
  const props = Object.create(null)
  const names = []
  for (const p of raw) {
    if (!Array.isArray(p) || p[0] !== ':' || typeof p[1] !== 'string') return null
    names.push(p[1])
    const child = shapeOfObjectLiteralAst(p[2])
    if (child) props[p[1]] = child
    else {
      // Scoped to genuine SCALARS only — OBJECT/HASH is deliberately excluded:
      // VT['.'] dereferences a structured shape's `.props` unguarded
      // (`sh.props[args[1]]`), so a bare `{val: VAL.OBJECT}` with no `props`
      // map (the only way a nested `{}`/spread could reach this fallback
      // instead of the recursive branch above) would throw on the next `.`
      // step of a chain, not just decline to answer. ARRAY is left out too —
      // its own `.elem` is read as `parent.elem || null` (safe either way)
      // but a bare `{val: VAL.ARRAY}` carries no useful element fact, so
      // there is nothing this fallback would add for it.
      const vt = valTypeOf(p[2])
      // `literal: true` marks this as a compile-time CONSTANT scalar, not a
      // heap reference — VT['.']'s write-hazard gate exists to catch a
      // property that could be mutated through an ALIAS this analysis can't
      // trace (a schema-tracked object instance shared/written elsewhere);
      // that concern is a category error for a scalar drawn directly from
      // the object literal's OWN source text, which is never itself the
      // target of a `recv.prop = x`/`recv[k] = x` write (there is no `recv`
      // to write through — the value comes from parsing this exact literal,
      // not from a runtime slot). See VT['.']'s own consumption of this flag.
      if (vt === VAL.NUMBER || vt === VAL.STRING || vt === VAL.BOOL || vt === VAL.BIGINT)
        props[p[1]] = { val: vt, literal: true }
    }
  }
  return names.length ? { val: VAL.OBJECT, props, names } : null
}
