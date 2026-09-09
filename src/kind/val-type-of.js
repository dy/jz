/**
 * The VT dispatch table + `valTypeOf` — the kind
 * lattice's join rules (`?:`/`&&`/`||`/`??`, `hasAmbiguousBoolMerge`) and
 * per-op value-KIND resolution, including call-node resolution for both
 * bare-name callees (`kind-traits.js`'s `calleeValType`) and same-module
 * `.`-member callees via frozen ProgramIndex IDs
 * (`ctx.plans.programIndex.resolveMemberSourceId`, see VT['()'], phase-c-unification
 * shape #7-#9: this resolution must stay exactly as landed there) plus
 * method-kind dispatch (`kind-traits.js`'s `methodValType`).
 *
 * `shapeOfObjectLiteralAst` lives here rather than in `kind/shape.js` —
 * relocated during the split, not textually adjacent originally — because
 * it is the one JSON-shape-family function whose scalar-literal-property-leaf
 * branch calls the general `valTypeOf` (.work/archive/kind-split.md §4).
 *
 * Split out of kind.js (pipeline-minimality slice, .work/archive/kind-split.md).
 *
 * @module kind/val-type-of
 */

import { ctx, registerResetHook } from '../ctx.js'
import { VAL, lookupValType, repOf } from '../reps.js'
import { intLiteralValue, staticIndexKey, typedCtorRawOf } from '../static.js'
import {
  BOOL_OPS, NUMERIC_BINARY_OPS, NUMERIC_UNARY_OPS, COMPOUND_NUMERIC_OPS,
  calleeValType, methodValType, propValType, typedCtorElemValType,
} from '../kind-traits.js'
import { summaryTypedCtor, typedStorageCtorFromContext } from '../typed-context.js'
import { literalTruthiness, nullishArm } from './lattice.js'
import { censusMaybeUndefinedKind } from './dict-census.js'
import { valOf as summaryVal, contractVal } from '../summary/index.js'
import { isPostfixRecovery } from '../summary/kind.js'
import { shapeOf, jsonConstString, spreadMergeResolves } from './shape.js'

/**
 * Per-op val-type rules — the dispatch table behind `valTypeOf`. Each entry
 * takes the op's args and returns a VAL kind or undefined (→ null). Set-driven
 * families (BOOL_OPS, NUMERIC_*) enroll at module init, so adding an operator
 * is a kind-traits table entry, not a new branch here.
 */
const VT = Object.create(null)

// valTypeOf is recursively dispatched and sits on nearly every analysis walk.
// Keep one tail-argument array per active recursion depth instead of allocating
// `expr.slice(1)` on every query. Reset swaps the pool without touching a
// prior wasm arena after `_clear`.
let VT_ARGS = []
let vtArgsDepth = 0
registerResetHook(() => { VT_ARGS = []; vtArgsDepth = 0 })
const takeVtArgs = (expr) => {
  let args = VT_ARGS[vtArgsDepth]
  if (!args) VT_ARGS[vtArgsDepth] = args = []
  vtArgsDepth++
  args.length = expr.length - 1
  for (let i = 1; i < expr.length; i++) args[i - 1] = expr[i]
  return args
}
const releaseVtArgs = (args) => {
  args.length = 0
  vtArgsDepth--
}

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
  // ballooning 1 → ~19 funcs; see test/wat-invariants.js, .work/archive/todo.md).
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

// Value-preserving logical: `&&`/`||` return one of their operands.
// A boolean can share the numeric carrier, but cannot prove a pointer kind:
// `false && array` is false, and must remain falsy when stored and read back.
// `a && b` / `a || b` / `a ?? b` all yield one of the two operands, so the result
// type is their common type (else unknown). Giving `??` a type — not just ||/&& —
// lets `numA ?? numB` read NaN-safe (value-typed NUMBER → f64.eq) instead of routing
// through the bit-comparing __is_truthy, which mis-reads a non-canonical NaN.
VT['&&'] = VT['||'] = VT['??'] = (args) => {
  const ta = valTypeOf(args[0]), tb = valTypeOf(args[1])
  if (ta && ta === tb) return ta
  if (ta === VAL.BOOL && tb === VAL.NUMBER || tb === VAL.BOOL && ta === VAL.NUMBER) return VAL.NUMBER
  return null
}

// .work/archive/todo.md §deletion-sweep — pure structural predicate: true exactly
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
// Narrowing supplies its scoped summary resolver before local representations exist.
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

// The concrete typed constructor of an element receiver, a name or an
// expression, through the one provenance grammar (typed-provenance.js): a
// name through the transient overlay (a staged reference's temp, an in-
// progress body walk), the settled per-function and module maps, then a
// parameter rep; a call, a field, an index or a method chain through their
// own sources; finally the program summary's kind of the expression.
const typedReceiverCtor = recv =>
  typedStorageCtorFromContext(ctx, recv, {
    resolveName: name => typedCtorRawOf(name) ?? repOf(name)?.typedCtor ?? null,
  }) ?? summaryTypedCtor(ctx, recv)

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
  // element kind. A proven OBJECT uses the same named-property facts as dot
  // access. Typing by elem let `a['@@iterator'] != null` fold TRUE on
  // a known array — the drain/GetIterator guards then called undefined (table
  // OOB). Canonical numeric strings ('0','1',…) DO address elements
  // (ToPropertyKey) and keep the elem typing below.
  {
    const k = args[1]
    const lit = Array.isArray(k) && k.length === 2 && k[0] == null ? k[1]
      : Array.isArray(k) && k[0] === 'str' ? k[1] : undefined
    if (typeof lit === 'string' && !/^(0|[1-9][0-9]*)$/.test(lit))
      return valTypeOf(args[0]) === VAL.OBJECT ? VT['.']([args[0], lit]) : null
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
  const settled = ctx.summary?.at(ctx.func.current).valOfExpr(['[]', args[0], args[1]])
  if (settled != null) return settled
  // Indexed read on a known typed-array receiver, a name or an expression,
  // follows its concrete ctor. If the ctor itself is open (runtime-polymorphic
  // Number vs BigInt storage), retain an unknown kind and let the tagged
  // runtime reader decide.
  // An UNPROVEN index can read past the end (= undefined per spec), but the undef
  // box is a NaN bit-pattern, so it COINCIDES with ToNumber(undefined) through
  // every numeric path — the NUMBER claim stays sound for dispatch (numeric arms,
  // the vectorizer). Only identity observations diverge; those folds consult
  // typedReadMaybeOob below and keep the runtime compare.
  const recvVt = valTypeOf(args[0])
  if (recvVt === VAL.TYPED) {
    const elem = typedCtorElemValType(typedReceiverCtor(args[0]))
    // With no BigInt syntax in the whole program, every accepted host typed
    // ingress is numeric (interop rejects evidence-free BigInt typed arrays),
    // so an open ctor still has a closed NUMBER element domain. Preserve the
    // numeric hot-path proof; BigInt-capable programs keep the kind open and
    // use the tagged runtime reader.
    return elem || (!ctx.features.bigint ? VAL.NUMBER : null)
  }
  // Indexed read on a STRING returns a 1-char string (SSO at runtime).
  if (recvVt === VAL.STRING) return VAL.STRING
  // Indexed read on a known Array<VAL> receiver: bind by rep.arrayElemValType,
  // the program summary's element cell (every store in the program joined),
  // stamped by analyzeValTypes on a local, emitFunc's preseed on a parameter,
  // moduleGlobalKinds on a module array (a numeric/uniform table).
  if (typeof args[0] === 'string') {
    const elemVt = ctx.func.localReps?.get(args[0])?.arrayElemValType
    if (elemVt) return elemVt
    if (!ctx.func.localReps?.has(args[0])) {
      const gElem = ctx.scope.globalReps?.get(args[0])?.arrayElemValType
      if (gElem) return gElem
    }
  }
  // INVARIANT: NO dict-mode receiver fold here: dictValueKindOf
  // (kind/dict-census.js) is an internal helper for censusMaybeUndefinedKind
  // only — VT['[]'] must NOT promote dictValueValType to an exact VT at a
  // `[]` read site (see dictValueKindOf's own doc comment there for the
  // soundness argument). Re-enabling that is the opt-in presentVal model, not a repeat of this
  // global promotion.
  // Direct double-index on a module-level nested numeric table — `C[i][j]` where
  // `C = [[…number…], …]`. The receiver is itself a single-index read of a global
  // array whose rows' element cell the summary joined (a `C[i][j] = 'y'` anywhere is in it).
  if (Array.isArray(args[0]) && args[0][0] === '[]' && args[0].length === 3 && typeof args[0][1] === 'string') {
    const base = args[0][1]
    if (!ctx.func.localReps?.has(base)) {
      const gNested = ctx.scope.globalReps?.get(base)?.arrayElemElemValType
      if (gNested) return gNested
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
  // The program summary (src/summary): the slot's kind under every construction
  // and store, with a declared-then-assigned field's `undefined` excluded.
  if (ctx.summary) { const sv = ctx.summary.at(ctx.func.current).valOfExpr(['.', args[0], args[1]]); if (sv) return sv }
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
  // dictValueKindOf's own doc comment (kind/dict-census.js) for the soundness argument.
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
// The binary sibling of censusBigintUnaryVT below (.work/archive/todo.md
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
// Nullable container reads retain their BigInt payload for unary dispatch
// and strict comparisons; the runtime handles the absent-key arm.
const censusBigintUnaryVT = (base) => (args) =>
  args[1] == null && censusMaybeUndefinedKind(args[0]) === VAL.BIGINT ? VAL.BIGINT : base(args)
VT['u-'] = censusBigintUnaryVT(numericBinaryVT)
VT['~'] = censusBigintUnaryVT(numericUnaryVT)
VT['>>>'] = VT['u+'] = () => VAL.NUMBER
VT.nan = () => VAL.NUMBER   // parse.js's self-describing `NaN` marker

VT['+'] = (args) => {
  const ta = valTypeOf(args[0]), tb = valTypeOf(args[1])
  if (ta === VAL.STRING || tb === VAL.STRING) return VAL.STRING
  if (ta === VAL.BIGINT || tb === VAL.BIGINT) return VAL.BIGINT
  // A BigInt payload on both operands selects the joint runtime dispatch.
  // One unknown operand alone does not prove that both domains agree.
  if (censusMaybeUndefinedKind(args[0]) === VAL.BIGINT && censusMaybeUndefinedKind(args[1]) === VAL.BIGINT)
    return VAL.BIGINT
  // An unknown side: the program summary's kind over the whole program when
  // it proves one; else a bare name the numeric demand pass denied (a read of
  // it neither converts nor is compatible: a container store, a return)
  // keeps JS semantics for every kind the host may pass through an `any`
  // parameter (`null + 3` and `'a' + 3` through such a local were added as
  // raw f64, the box's bits coming back as the result). Any other unknown
  // side takes the guarded ABI's numeric contract, the optimistic NUMBER:
  // load-bearing for local numeric inference (demoting it doubled the
  // slice/nest loop-body op counts).
  if (ctx.summary && (ta == null || tb == null)) {
    const view = ctx.summary.at(ctx.func.current)
    const v = view.valOfExpr(['+', args[0], args[1]])
    if (v != null) return v
    if (numericDenied(args[0], view) || numericDenied(args[1], view)) return null
  }
  return VAL.NUMBER
}
/** A bare name the numeric demand pass denied a number. */
export const numericDenied = (node, view = ctx.summary?.at(ctx.func.current)) =>
  typeof node === 'string' && view != null && view.numericDenied(node)

// A sequence forwards its final value, including presence. The settled
// summary declines nullable/mixed kinds; do not fall back from that answer
// to a receiver-oriented BIGINT claim that also admits nullish values.
VT[','] = (args) => {
  const value = args[args.length - 1]
  return ctx.summary ? ctx.summary.at(ctx.func.current).valOfExpr(value)
    : null
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
  // Closure-table dispatch `NAME[idx](args)` on a table the lattice scans
  // proved indexed-call-only (dyn-closure-tables.js): the summary's contract of
  // the closure set the table holds, the join of its members' results.
  if (Array.isArray(callee) && callee[0] === '[]' && typeof callee[1] === 'string' && ctx.summary &&
      (ctx.scope.closureTableLatticeCandidates?.has(callee[1]) || ctx.scope.imperativeClosureTableLatticeCandidates?.has(callee[1]))) {
    const c = ctx.summary.at(ctx.func.current).calleeContract(['()', ...args])
    const vt = c && contractVal(c)
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
    // Same-module `.`-member callee, proven (or not) by the frozen
    // ProgramIndex member-target IDs (program-index.js, built once in plan/index.js
    // before any consumer; an earlier query sees `programIndex` still
    // undefined and falls through below): the contract published for that
    // function, the answer calleeValType's bare-name tail gives `f(x)`.
    // Checked BEFORE methodValType's builtin-method-name dispatch below: a
    // resolved same-module function is a structural proof, a method name a
    // guess (`push` matches on the name alone). resolveMemberSourceId itself
    // refuses anything shadowed, reassigned, dynamically written, or escaping
    // the module, so an ordinary Array/Map/String/TypedArray `.method()` call
    // never resolves here.
    const programIndex = ctx.plans.programIndex
    const sourceId = programIndex?.resolveMemberSourceId(obj, method) ?? -1
    const resolved = programIndex?.sourceFunctionById(sourceId)
    const contract = resolved && programIndex.resultContract(resolved)
    const resolvedVt = contract && contractVal(contract)
    if (resolvedVt) return resolvedVt
    // The program summary's kind of the call: a class method resolved on the
    // receiver's class (src/compile/emit/class-dispatch.js), a builtin whose
    // result follows its arguments (`reduce`: its callback's result, not the
    // receiver's element kind), the join of a closure set's returns.
    if (ctx.summary) { const vt = summaryVal(ctx.summary.at(ctx.func.current).kindOfExpr(['()', ...args])); if (vt != null) return vt }
    // INVARIANT: NO `.get` short-circuit here: mapValueKindOf
    // (kind/dict-census.js) is a censusMaybeUndefinedKind-only helper —
    // VT['()'] must NOT promote a `.get()` read to an exact VT (see
    // mapValueKindOf's own doc comment there for the soundness argument;
    // re-enablement is the opt-in presentVal model).
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

  const op = expr[0]
  if (isPostfixRecovery(op, expr[1], expr[2])) return valTypeOf(expr[1])
  if (op == null) {
    // Literal forms: [] = undefined, [null, null] = null, [null, n] = number, [, bool] = boolean.
    // Bigint literals are NEVER this shape — the parser tags them structurally
    // as ['bigint', decimalStr] (see parse.js, VT.bigint below; audit P0-2),
    // so a `typeof` probe here would be both unnecessary AND unsound: under
    // self-host, `typeof` on an untagged subnormal-magnitude NUMBER literal
    // reads 'bigint' too (the carrier is bit-identical — the very collapse
    // this tag exists to avoid), which used to misclassify e.g. `5e-324`'s
    // OWN literal node as VAL.BIGINT and corrupt its export boundary.
    if (expr.length === 1) return null              // undefined literal
    if (expr[1] == null) return null                 // null literal
    if (typeof expr[1] === 'boolean') return VAL.BOOL
    if (typeof expr[1] === 'symbol') return null    // prepared null sentinel
    // C5b hardening: a string payload here is never a real string LITERAL.
    if (typeof expr[1] === 'string') return null
    return VAL.NUMBER
  }
  const handler = VT[op]
  if (!handler) return null
  const args = takeVtArgs(expr)
  try { return handler(args) ?? null }
  finally { releaseVtArgs(args) }
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
 *  Scalar-literal property leaf (.work/archive/bigint-
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
 *  cross-call-site `val` consensus and leaving RepresentationPlan without
 *  a raw BigInt provenance proof. General fix, not
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
