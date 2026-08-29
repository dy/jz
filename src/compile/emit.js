import { OPTF } from '../ctx.js'
/**
 * AST → WASM IR emission.
 *
 * # Stage contract
 *   IN:  prepared AST node + ctx state (func.locals/localReps/typedElem, etc.)
 *   OUT: IR node (array) with `.type` ('i32' | 'f64' | 'void'). For statements, a flat
 *        list of WASM instructions (no type tag).
 *   NO-MUTATE: emit does not rewrite the AST. Side effects go to ctx.runtime.*,
 *        ctx.core.includes (via inc()), ctx.func.uniq (local naming), and ctx.features.*.
 *
 * # Dispatch
 *   `emit(node, expect?)` handles literals inline and routes arrays to ctx.core.emit[op].
 *   `emitVoid(node)` emits + drops any value (statement context; routes block bodies to emitBlockBody).
 *   `emitBlockBody(node)` unwraps a `{}` block and concatenates flat statement IR.
 *
 * The emitter table (`emitter` export) is copied into ctx.core.emit by reset();
 * language modules add/override entries to extend dispatch.
 *
 * Low-level IR construction helpers live in `ir.js` and are imported below.
 *
 * @module emit
 */

// --- extracted family modules (src/compile/emit/) ---
import {
  CMP_SET, REF_EQ_KINDS, boolEagerBody, eagerSelectOK, foldOperandPure, isCanonicalBoolExpr, isCmp, isI32Num, isLit1, isNumArm, selectCondOK, stringOps,
} from './emit/shared.js'
import {
  addBoundedFaithful, addFitsI32, addLiteralFitsI32, addRangeFitsI32, i32Mag, loopGuardHi, mulBoundedFaithful, mulFitsI32, mulRangeFitsI32, subLiteralFitsI32, subRangeFitsI32,
} from './emit/i32-bounds.js'
import {
  FIRST_CLASS_BUILTIN_BODY, FIRST_CLASS_BUILTIN_NAMES, FIRST_CLASS_UNARY_MATH, builtinFunctionValue,
} from './emit/first-class.js'
export { FIRST_CLASS_BUILTIN_NAMES }
import {
  TYPED_HI_MASK, argIR, coerceArg, emit, emitBlockBody, emitBoolStr, emitCallArgs, emitDecl, emitIdentitySafe, emitIdentitySafeArms, emitIndex, emitVoid, rejectAmbiguousBoolIdentity, resolveClosureTableParamLattice, toBool, tryConcatChain,
} from './emit/dispatch.js'
export { emit, emitBlockBody, emitBoolStr, emitDecl, emitIdentitySafe, emitIndex, emitVoid, resolveClosureTableParamLattice, toBool }
import {
  I64_ARITH_OP, bigIntDomainsCanMix, bigIntJointDispatch, bigIntOperand, bigIntShiftIR, bigIntUnary, bigintMemberAssignTarget, bigintMixReject, computedBoxOf, numLiteralNode,
} from './emit/bigint.js'
import {
  attachSigMeta, buildArrayWithSpreads, emitMethodCallSpread, materializeMulti, parseCallArgs,
} from './emit/call-args.js'
export { buildArrayWithSpreads, materializeMulti }
import { emitMethodCall, storedValue } from './emit/method-dispatch.js'
import { callOps, tagFnArrayDispatch } from './emit/call.js'
import { emitInstanceof } from './emit/instanceof.js'
// --- end extracted family modules ---

import {
  commaList, T, isBlockBody, isReassigned, mutatesArrayLength, isConstLiteral, constLiteralHoistable,
  hasOwnContinue, hasLabeledContinueTo, hasOwnBreakOrContinue, extractParams, classifyParam,
  PARAM_KIND, PARAM_NAME, PARAM_DEFAULT, PARAM_PATTERN, JZ_UNDEF, TYPEOF,
  ASSIGN_OPS, MUTATE_OPS, firstRefKind, isLeaf, walkAst, some,
} from '../ast.js'
import { ctx, err, inc, warnDeopt, PTR, ssoBitI64Hex, LAYOUT, DBG_INVARIANTS, emitArity, setLinkDemand, getFactStore } from '../ctx.js'
import {
  i64Hex, encodePtrHi, STR_HCACHE_BIT, typedElemAux, oobNanIR,
  OBJECT_SCHEMA_HI_MASK, objectSchemaGuardHex, TYPED_ELEM_NAMES, encodeTypedElemAux, TYPED_ELEM_VIEW_FLAG,
} from '../../layout.js'
import { ERR, ERR_CLASS_NAMES } from '../../err-codes.js'
import { bodyOnlyCharCodeAtCalls } from '../abi/string.js'
import { includeForStringOnly, includeForArrayLiteral, includeForRuntimeKeyIteration } from '../autoload.js'
import { nonNegIntLiteral, intLiteralValue, intExprRange, constIntExpr, staticPropertyKey, guardCounterName, forCounterRange } from '../static.js'
import { findFreeVars } from './analyze.js'
import {
  BINDING_USE_DECLS, BINDING_USE_USES, BINDING_USE_KIND, BINDING_USE_KEY,
  BINDING_USE_OPTIONAL, BINDING_USE_COMPUTED, BINDING_USE_OP, scanBindingUses, USE,
} from './analyze-scans.js'
import {
  containsNestedClosure, containsNestedLoop, nestedSmallLoopBudget,
  containsDeclOf, cloneWithSubst, containsKnownTypedArrayIndex,
  smallConstForTripCount, isTerminator, scanBoundedLoops, inBoundsCharCodeAt,
  exprType, MAX_SMALL_FOR_UNROLL, MAX_NESTED_FOR_UNROLL,
  inBoundsArrIdx, typedIdxProven, versionableTypedNest, idxKey, SLOT_OPS,
} from '../type.js'
import { BIGINT_JOINT_BINARY_OPS, valTypeOf, shapeOf, hasAmbiguousBoolMerge, censusMaybeUndefined, censusMaybeUndefinedKind, nullishArm } from '../kind.js'
import { VAL, lookupValType, repOf, updateRep, repOfGlobal } from '../reps.js'
import {
  typed, asF64, asI32, asI32Sat, asI64, asPtrOffset, asParamType, toI32, fromI64,
  NULL_IR, nullExpr, undefExpr, MAX_CLOSURE_ARITY, TRUE_NAN, FALSE_NAN, NULL_NAN,
  WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS,
  mkPtrIR, ptrOffsetIR, ptrTypeIR, ptrTypeEq, dispatchByPtrType, sidecarOverride, valKindToPtr,
  isLit, litVal, isNullishLit, isPureIR, hasExpensiveOp, dataDependentFlag, emitNum, f64rem, toNumF64, toStrI64, maskBound,
  truthyIR, toBoolFromEmitted, isPostfix,
  isGlobal, isConst, usesDynProps, needsDynShadow,
  temp, tempI32, tempI64, allocPtr,
  block64, withTemp,
  boxedAddr, readVar, writeVar, isNullish, isNull, isUndef, isBoolAtom, throwTypeErrorIR,
  boolBoxIR, carrierF64, carrierF64Narrow, unboxBoolIR, boxBigInt, applyBigintRepresentationAction, maybeUnboxBigInt, isPlanTaggedBigint, readI64, bigintEraseErr, bigintStrict,
  isLiteralStr, resolveValType, isFuncRef,
  multiCount, loopTop, flat,
  reconstructArgsWithSpreads, tcoTailRewrite,
  extractF64Bits,
} from '../ir.js'
import { isBoundName, freshId } from '../ir.js'
import { extractRefinements, inferSchemaBranch, mergeRefinement, withRefinements } from './flow-types.js'
import { withArrayLiteralEscape, withControlFrame, withExpectedValue, withFinallyStack, withFunctionFields, withPendingLabel, withSchemaSpeculation, withTryState } from './flow-state.js'
import { emitElementAssign, emitPropertyAssign, persistBindingPtr } from './emit-assign.js'
import {
  JOIN_OPS, REP_EDGE_BOX, REP_EDGE_REJECT, REP_EDGE_UNBOX,
  recordClosureCallRepresentations, representationBindingWriteAction, representationCallArgAction, representationJoinArmAction, representationResultTagRequired, representationReturnAction,
  representationComputedExprAction, representationCompoundAssignAction, representationUnaryUpdateAction, representationStorageWriteAction, representationProgramHasBigint,
} from './representation-plan.js'
import { plannedTypedStorageCtor, plannedTypedStorageInfo } from './typed-storage-plan.js'

// Peel an emitted operand back to its raw i32 value when it carries one: a value already
// typed i32 (integer literals included — they emit as i32.const), or an integer read wrapped
// in f64.convert_i32_s/u (typed-array / i32-global reads default to the f64 rep). Else null.
const peelI32 = (v) =>
  isI32Num(v) ? v
    : (Array.isArray(v) && (v[0] === 'f64.convert_i32_s' || v[0] === 'f64.convert_i32_u'))
      ? (Array.isArray(v[1]) ? typed(v[1], 'i32') : v[1])
      : null

// Native wrapping i32 arithmetic for `+`/`-`/`*` whose result is consumed as i32. Peels the
// f64.convert_i32_s/u that integer reads (`DX[i]`, a global Int32Array) wrap their load in, so
// `ax = ax + DX[i]` (ax and DX[i] both i32) lowers to one i32.add instead of the
// convert → f64.add → trunc_sat round-trip that doubled hot integer loops (ulam's spiral walk,
// ring-buffer indexing). Bit-identical for an i32 result: ToInt32(exact) ≡ two's-complement wrap.
// Gated on exprType(whole expr)==='i32' so an f64-consumed sum — or an unsigned-wide (uint32)
// operand, which exprType already reports as f64 — still widens. Returns null when inapplicable.
// Widening contract: this is the DECIDE side of the numeric widening invariant —
// the mirror (exprType's i32/f64 prediction) and the full rule set live in
// src/type.js's header. Edit either side only with the other open.
const tryI32Arith = (wasmOp, astOp, a, b, va, vb) => {
  const pa = peelI32(va); if (pa == null) return null
  const pb = peelI32(vb); if (pb == null) return null
  if (exprType([astOp, a, b], ctx.func.locals, undefined, true) !== 'i32') return null
  return typed([wasmOp, pa, pb], 'i32')
}

// f64 arithmetic that can MINT a sign-nondeterministic NaN (0/0, ∞−∞, 0·∞, x%0): on x86
// these are 0xFFF8…, on arm 0x7FF8…. sqrt/min/max/neg are NOT here — they canon at their
// own emit (math.js / unary `-`), so they reach canonNum already canonical.
const NAN_MINTING = new Set(['f64.div', 'f64.add', 'f64.sub', 'f64.mul'])

// Sign+exponent mask isolating "negative NaN or -Infinity" — used only after an
// f64.eq(v,v) self-check has already failed (so -Infinity is excluded, leaving
// only negative NaN). Pointers/atoms are always emitted sign-clear (nanPrefixMaskHex,
// layout.js), so a sign-bit-set NaN can only be a genuine float NaN. Mirrors
// $__typeof's dynamic dispatch (module/core.js) bit-for-bit.
const NEG_NAN_MASK = 0xFFF0000000000000n

const canonNum = (node) => {
  // Fold a possibly-non-canonical NaN to the canonical number-NaN before it reaches a
  // bit-comparing consumer (__is_truthy / untyped === / typeof), which match the canonical
  // NaN by bits and so misread x86's 0xFFF8 as truthy. ONLY an un-canon'd NaN-minting
  // arithmetic op can carry such a value — literals, i32-conversions, opaque locals/calls
  // (canonical by the canon-at-source invariant) and already-canon'd shapes don't — so
  // skipping everything else keeps the size win. (The broken middle ground was
  // `02873d0`'s `isNumericIR` skip, which dropped canon for f64.div too → x86 miscompile.)
  const arith = Array.isArray(node) &&
    (NAN_MINTING.has(node[0]) || (node[0] === 'call' && node[1] === '$__rem'))
  if (!arith) return node
  const t = temp('cn')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, node],
    ['select',
      ['f64.const', 'nan'],
      ['local.get', `$${t}`],
      ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]]], 'f64')
}

// One arm of a two-arm f64 merge (?:, ??, ||, &&) whose result may be bit-tested while
// untyped. Canon (canonNum, a no-op unless the arm is NaN-minting arithmetic) ONLY a
// LONE numeric arm: when both arms are numeric the merge is value-typed NUMBER and read
// NaN-by-value (no canon); when the other arm is opaque the result is untyped, so a
// non-canonical NaN here would be misread by __is_truthy — fold it. A pointer arm
// (isNum=false) is never touched (canon would destroy its NaN-box).
const canonArm = (f, isNum, otherNum) => isNum && !otherNum ? canonNum(f) : f

// An operand whose uint32 value can be *observed as a JS number* — a `>>>`
// result, an `unsignedResult` call, or an unsigned i32.const. Its magnitude can
// exceed signed-i32 range, so wrapping i32 arithmetic would corrupt it; widen to
// f64 instead. A `.wrapSafe` operand is also unsigned but is a `narrowUint32`
// accumulator read proven to be re-truncated by a `>>>` (ToUint32) sink at every
// use — wrapping is exactly its intended semantics, so it stays on the i32 path.
const widensUnsigned = (v) => v.unsigned && !v.wrapSafe

// Strip a redundant NaN-canon wrapper (math.js `canon`) from an operand that
// feeds a NaN-propagating f64 op. `f64.sqrt`/`min`/`max` mint a sign-nondeterministic
// NaN that math.js canon-izes so it can't be bit-confused with a NaN-boxed pointer in
// `===`/`typeof`. But when the result flows straight into `f64.add`/`sub`/`mul`/`div`,
// the consumer propagates that NaN identically and is itself canon-ized if IT escapes —
// so the inner per-op canon (local.set + select + f64.ne, ~3 ops) is dead on the
// critical path. This is THE gap that put sqrt-heavy kernels ~23% behind V8
// (julia/raymarcher/boids); stripping it makes them match native JS.
const stripCanon = (v) => {
  if (!v) return v
  if (v.canonOf != null) return typed(v.canonOf, 'f64')
  // A NaN-canon nested in the VALUE arm of a `select` / `(if result f64)` is equally
  // dead: the consumer that called stripCanon (f64.add/sub/mul/div, or a math call)
  // propagates the NaN identically and the outermost escape re-canon-izes. Recurse into
  // the arms so `(cond ? x : -x) + v` (the Perlin-gradient sign-select, and every other
  // conditional negation) drops the per-neg select+f64.ne, same as a bare `x + -y`.
  if (Array.isArray(v)) {
    if (v[0] === 'select' && v.length === 4) {
      const a = stripCanon(v[1]), b = stripCanon(v[2])
      if (a !== v[1] || b !== v[2]) return typed(['select', a, b, v[3]], 'f64')
    } else if (v[0] === 'if' && Array.isArray(v[1]) && v[1][0] === 'result' && v[1][1] === 'f64'
               && Array.isArray(v[3]) && v[3][0] === 'then' && v[3].length === 2
               && Array.isArray(v[4]) && v[4][0] === 'else' && v[4].length === 2) {
      const t = stripCanon(v[3][1]), e = stripCanon(v[4][1])
      if (t !== v[3][1] || e !== v[4][1]) return typed(['if', v[1], v[2], ['then', t], ['else', e]], 'f64')
    } else if (v[0] === 'local.get' && typeof v[1] === 'string') {
      // hoistNestedCalls' temp (see isHoistTemp above) severs the structural link a
      // direct inline expression would keep: `const __tmp = sinTau(ph)` stores the
      // FULL (possibly canon-guarded) return value, and the use site sees only a
      // fresh `local.get $__tmp` with no `.canonOf` of its own. Since the temp is
      // single-def/single-use by construction, its ONE reader gets to decide whether
      // the guard is dead — recurse into the recorded def and, if anything strips,
      // mutate that def NODE IN PLACE (same array object the earlier `local.set`
      // already references) so the guard is gone at its one definition, not recomputed
      // here. The read itself stays a bare `local.get` either way.
      const def = ctx.func.hoistTempDefs?.get(v[1].slice(1))
      if (def) {
        const stripped = stripCanon(def)
        if (stripped !== def) {
          for (let i = 0; i < stripped.length; i++) def[i] = stripped[i]
          def.length = stripped.length
          def.type = stripped.type
        }
      }
    }
  }
  return v
}

/** Emit unary negation: constant-fold, or i32 sub from 0 / f64.neg. */
const emitNeg = (a, self) => {
  // BigInt operands (literal or otherwise) always carry VAL.BIGINT statically —
  // a bigint LITERAL is the self-describing `['bigint', decimalStr]` node
  // (kind.js VT.bigint), never a raw `[null, number]` node (audit P0-2: the
  // parser tags bigint literals structurally, off the source `n` suffix, so
  // there's no longer a bit-pattern to conflate with a genuine subnormal
  // NUMBER literal here — see parse.js). No magnitude heuristic needed for
  // literals; the runtime magnitude heuristic (emit.js TYPEOF.bigint) remains
  // for genuinely dynamic/unknown-kind values, a separate, real carrier limit.
  // `|| censusMaybeUndefinedKind(a) === VAL.BIGINT` (.work/todo.md
  // §deletion-sweep §6/§12 Slice 5): a census-shaped operand's exact-kind claim reaches
  // `valTypeOf` here only via VT['[]']/['.']/['()']'s own Slice-4 exact-kind
  // promotion (kind.js) — a SEPARATE mechanism from the census helpers
  // (dictValueKindOf/mapValueKindOf) themselves, which this OR-arm consults
  // DIRECTLY (censusMaybeUndefinedKind, unchanged since Slice 1/79082fb2). Keeps
  // this activation gate reachable for a dynamic dict/Map-read operand
  // independent of whether that promotion stays wired.
  if (valTypeOf(a) === VAL.BIGINT || censusMaybeUndefinedKind(a) === VAL.BIGINT)
    return bigIntUnary(a, i64v => ['i64.sub', ['i64.const', 0], i64v], ['f64.const', 'nan'], computedBoxOf(self))
  const v = emit(a)
  // `.unsigned` carries its uint32 value as a signed i32 bit pattern (litVal/i32.sub
  // both read that raw pattern), so negating either fast path directly negates the
  // WRONG number for any magnitude ≥ 2^31 (e.g. `-h` on a `(…) >>> 0` accumulator
  // holding 3000000000 gave 1294967296, not -3000000000). A literal still folds —
  // just via its true unsigned value; a runtime i32 widens through the f64 path
  // below, whose `toNumF64` → `asF64` already convert_i32_u's an `.unsigned` operand.
  if (isLit(v)) return emitNum(-(v.unsigned ? litVal(v) >>> 0 : litVal(v)))
  if (isI32Num(v) && !v.unsigned) return typed(['i32.sub', typed(['i32.const', 0], 'i32'), v], 'i32')
  // f64.neg flips the sign bit, so negating a NaN yields 0xFFF8.. — a non-canonical
  // number-NaN that overlaps the NaN-boxed value space (jz reserves 0x7FF8.. as THE
  // number-NaN). `__is_truthy`/`__eq` compare against that exact pattern, so a sign-
  // flipped NaN reads as a tagged value (truthy / not-NaN). Fold any NaN result back
  // to canonical — the same invariant math.sqrt/min/max keep via `canon` (module/math.js).
  const t = temp('ng')
  const raw = ['f64.neg', toNumF64(a, v)]
  const ir = typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, raw],
    ['select', ['f64.const', 'nan'], ['local.get', `$${t}`],
      ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]]], 'f64')
  // Tag the un-canon'd `f64.neg` so a NaN-propagating consumer (f64.add/sub/mul/div, which
  // canon-ize on their OWN escape) strips this redundant inner canon — same contract as the
  // sqrt/min/max canons in math.js. A bare `x * -y` / `a - -b` then drops the per-neg
  // select + f64.ne instead of carrying it into the multiply/add.
  ir.canonOf = raw
  return ir
}

/** Try constant-folding binary arith: returns emitNum(result) or null. */
// `.unsigned` literals carry a uint32 value whose i32 `litVal` is its *signed* bit
// pattern (e.g. `-1` for 4294967295), so folding them through `fn` numerically would
// be wrong. Bail to the runtime path — the arithmetic handlers widen unsigned operands
// to f64 (convert_i32_u), reproducing the JS-spec result.
const foldConst = (va, vb, fn, guard) =>
  isLit(va) && isLit(vb) && !va.unsigned && !vb.unsigned && (!guard || guard(litVal(vb)))
    ? emitNum(fn(litVal(va), litVal(vb))) : null

/** Emit typeof comparison: typeof x == typeCode → type-aware check. */
export function emitTypeofCmp(a, b, cmpOp) {
  let typeofExpr, code
  if (Array.isArray(a) && a[0] === 'typeof' && typeof b === 'number') { typeofExpr = a[1]; code = b }
  else if (Array.isArray(a) && a[0] === 'typeof' && Array.isArray(b) && b[0] == null) { typeofExpr = a[1]; code = b[1] }
  else return null
  if (typeof code !== 'number') return null

  const t = temp()
  // Ambiguous BOOL-merge operand (.work/todo.md §deletion-sweep): the
  // collapsed NUMBER kind is unsound for typeof, which must tell a genuine
  // number apart from a coerced-to-0/1 boolean — emitIdentitySafe re-emits
  // the merge with its own BOOL arm boxed to its atom, so the dynamic bit
  // checks below (and the general typeof dispatch, module/core.js $__typeof)
  // read the correct per-branch representation instead of a raw collapsed bit.
  const ambiguous = hasAmbiguousBoolMerge(typeofExpr)
  const planTaggedBigint = isPlanTaggedBigint(typeofExpr)
  const va = asF64(ambiguous ? emitIdentitySafe(typeofExpr) : emit(typeofExpr))
  const eq = cmpOp === 'eq'
  // Trailing eqz-wrapper for atomic checks: `check` if eq, `!check` if ne.
  const wrap = check => typed(eq ? check : ['i32.eqz', check], 'i32')
  // De-Morgan'd `(X && Y)` vs `(!X || !Y)` — kept explicit so WAT output is
  // byte-identical to the previous inlined form (watopt may shape it differently).
  const both = (X, Y) => typed(eq ? ['i32.and', X, Y] : ['i32.or', ['i32.eqz', X], ['i32.eqz', Y]], 'i32')
  // "isPtr AND ptr_type == kind" — shared by typeof "string" / "function" /
  // user-supplied positive PTR codes. The tee in isPtr caches v in `t` for reuse.
  const isPtrKind = kind => {
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const isKind = ptrTypeEq(['local.get', `$${t}`], kind)
    return both(isPtr, isKind)
  }
  // Static fold for known-VAL operands of "boolean"/"bigint" — saves a runtime branch.
  // Never trusted for an ambiguous merge: its collapsed NUMBER kind is exactly
  // the unsound fact this whole design routes around.
  // Effect-preserving constant fold (re-audit P0, twin of effectFoldSeq below):
  // JS evaluates the typeof operand before comparing, so a statically-decided
  // fold must still run that evaluation once. `va` is ALREADY emitted above —
  // re-emitting via emit(typeofExpr)/effectFoldSeq would run it a SECOND time —
  // so an impure operand sequences the existing `va` instead of re-emitting.
  const foldConst = (k) => foldOperandPure(typeofExpr)
    ? typed(['i32.const', k], 'i32')
    : typed(['block', ['result', 'i32'], ['drop', va], ['i32.const', k]], 'i32')
  const staticFold = (target) => {
    if (ambiguous || planTaggedBigint) return null
    const vt = resolveValType(typeofExpr, valTypeOf, lookupValType)
    if (vt) return foldConst((vt === target) === eq ? 1 : 0)
    return null
  }

  if (code === TYPEOF.number) {
    // typeof "number": v===v rejects NaN-box pointers; BOOL carrier is 0/1 → still typeof "boolean".
    if (!planTaggedBigint && resolveValType(typeofExpr, valTypeOf, lookupValType) === VAL.BOOL) return foldConst(eq ? 0 : 1)
    // v===v alone is WRONG for the one payload that legitimately means "the number
    // NaN": the canonical box prefix (tag=ATOM aux=0) that $__typeof (module/core.js)
    // also carves out, plus any sign-bit-set NaN (pointers are always emitted
    // sign-clear, so a negative NaN — e.g. x86's uncanonicalized 0/0 — can only be a
    // real float NaN). Must mirror $__typeof's dynamic dispatch exactly, or
    // `typeof NaN === 'number'` folds to false here while the general path says true.
    const again = ['local.get', `$${t}`]
    const notNan = ['f64.eq', ['local.tee', `$${t}`, va], again]
    const bits = ['i64.reinterpret_f64', again]
    const numberNan = ['i32.or',
      ['i64.eq', bits, ['i64.const', i64Hex(LAYOUT.NAN_PREFIX_BITS)]],
      ['i64.eq', ['i64.and', bits, ['i64.const', i64Hex(NEG_NAN_MASK)]], ['i64.const', i64Hex(NEG_NAN_MASK)]]]
    return wrap(['i32.or', notNan, numberNan])
  }
  if (code === TYPEOF.string) return isPtrKind(PTR.STRING)
  if (code === TYPEOF.undefined) return wrap(isNullish(va))
  if (code === TYPEOF.boolean) return staticFold(VAL.BOOL) ?? wrap(isBoolAtom(['local.tee', `$${t}`, va]))
  if (code === TYPEOF.object) {
    // object: a NaN-box whose ptr_type is a heap kind — NOT STRING (typeof "string"),
    // NOT CLOSURE (typeof "function"), and NOT ATOM. The ATOM tag covers null AND undef
    // AND the boolean atoms true/false: excluding it in one ptr_type check is both the
    // null/undef guard and the (previously missing) boolean guard — without it
    // `typeof aBool === "object"` wrongly returned true whenever the operand's static
    // type was unknown (e.g. a value off JSON.parse), since a bool atom is a NaN-box
    // that isn't STRING/CLOSURE/nullish. Numbers (incl. NaN) and bigint aren't NaN-box
    // pointers, so isPtr already rejects them.
    inc('__ptr_type')
    const tt = `${T}${freshId(ctx)}`; ctx.func.locals.set(tt, 'i32')
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const heapKind = ['i32.and',
      ['i32.and',
        ['i32.ne', ['local.tee', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]], ['i32.const', PTR.STRING]],
        ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.CLOSURE]]],
      ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.ATOM]]]
    return wrap(['i32.and', isPtr, heapKind])
  }
  if (code === TYPEOF.function) return isPtrKind(PTR.CLOSURE)
  if (code === TYPEOF.bigint) {
    const fold = staticFold(VAL.BIGINT); if (fold) return fold
    if (planTaggedBigint) return isPtrKind(PTR.BIGINT)
    // bigint heuristic: finite, nonzero, sub-normal abs (RAW bigint carrier
    // bits reinterpreted as f64) OR a real PTR.BIGINT box (CARRIER PROGRAM
    // Slice 3, .work/carrier-representation-design.md §7 — the registry's
    // 'typeof' finding, layout-kinds.js). Landed ALONGSIDE, not replacing,
    // the magnitude fallback: round-3's own "verify every R-recovery arm
    // independently before deleting the heuristic" discipline — Slice 5
    // retires the magnitude half once every arm here is confirmed sound.
    const n = ['local.tee', `$${t}`, va]
    const magCond = ['i32.and',
      ['f64.eq', n, ['local.get', `$${t}`]],
      ['i32.and',
        ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]],
        ['f64.lt', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', 2.2250738585072014e-308]]]]
    // Gated on ctx.features.bigint (matches the $__is_truthy/$__to_num
    // precedent this session's own gating fix applies): no program lacking
    // any bigint syntax can ever construct a PTR.BIGINT box, so ptrTypeEq's
    // $__ptr_type call is unreachable dead weight there — including it
    // unconditionally would pull memory into a program whose ONLY typeof
    // comparison is `typeof x === 'bigint'` (found live, same regression
    // class as $__is_truthy's).
    if (!ctx.features.bigint) return wrap(magCond)
    const isPtr = ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]
    const isBigintTag = ptrTypeEq(['local.get', `$${t}`], PTR.BIGINT)
    return wrap(['i32.or', magCond, ['i32.and', isPtr, isBigintTag]])
  }
  if (code >= 0) return isPtrKind(code)
  return null
}

// C5b hardening: the `[null, string]` fallback arm is deleted. That shape is
// the RAW parser's own literal-node encoding (subscript yields `[null, "x"]`
// for every quoted/template-segment string), but prepare/index.js's generic
// op==null handler (~:1356) converts every one to the canonical `['str', x]`
// tag before analyze/compile ever runs — no producer past that point emits
// `[null, string]` (audited: the one that did, inline.js's hoisted-temp
// wrapper, was C5's own fix — 7068ae8e/accb21d0 — the wrapper now returns the
// bare name). A `[null, string]` node reaching here would mean a NEW producer
// reintroduced the ambiguity this class of bug keeps coming from (a name and
// a string literal are indistinguishable through this shape); returning null
// (no match) is the fail-closed answer, not a silent reinterpretation.
function stringLiteral(node) {
  return Array.isArray(node) && node[0] === 'str' && typeof node[1] === 'string' ? node[1] : null
}

// Index expressions where peepholing `s[k] === 'X'` to char-byte compare is
// semantics-preserving: must produce a non-negative *integer* at run time so
// `__str_byteLen u> k` bounds-checks the same range JS would. Out-of-range
// (negative or ≥ len) falls into the `else 0` arm — matches `undefined === 'X'`.
function intIndexIR(key) {
  const lit = nonNegIntLiteral(key)
  if (lit != null) return ['i32.const', lit]
  // intCertain name: forward-prop says every defining RHS is integer-shaped.
  // Captures loop variables (`for(let i=0;;i++)`), `let k = j + 1`, etc.
  if (typeof key === 'string' && repOf(key)?.intCertain) return asI32(emit(key))
  // intCertain schema slot read `o.x`: every observed write is integer-shaped,
  // so the loaded f64 represents an int — fold into the byte-compare fast path.
  if (Array.isArray(key) && key[0] === '.' && typeof key[1] === 'string' && typeof key[2] === 'string' &&
      ctx.schema.slotIntCertainAt?.(key[1], key[2]) === true) return asI32(emit(key))
  return null
}

function emitSingleCharIndexCmp(a, b, negate = false) {
  const leftLit = stringLiteral(a)
  const rightLit = stringLiteral(b)
  const aIdx = Array.isArray(a) && a[0] === '[]'
  const bIdx = Array.isArray(b) && b[0] === '[]'
  let indexed, lit
  if (bIdx && leftLit != null) { indexed = b; lit = leftLit }
  else if (aIdx && rightLit != null) { indexed = a; lit = rightLit }
  else return null

  if (lit.length === 0) return null
  if ([...lit].some(c => c.charCodeAt(0) > 0x7F)) return null

  const [, obj, key] = indexed
  const idxIR = intIndexIR(key)
  if (idxIR == null) return null

  const vt = typeof obj === 'string' ? lookupValType(obj) : valTypeOf(obj)
  if (vt && vt !== VAL.STRING) return null

  const finish = expr => negate ? ['i32.eqz', expr] : expr

  // Known STRING: s[i] always returns 1-char SSO. Multi-char literal → always false.
  // `obj` hasn't been emitted yet at this point — sequence it (effectFoldSeq) so a
  // receiver with runtime effects (`getStr()[i] === 'ab'`) still runs once (re-audit
  // P0, sweep of emitTypeofCmp's static-kind-fold class — see effectFoldSeq's doc).
  if (vt === VAL.STRING && lit.length > 1) return effectFoldSeq([obj], emitNum(negate ? 1 : 0))

  // Single-char literal: compare byte directly, skipping __str_idx allocation.
  if (lit.length !== 1 || !ctx.core.stdlib['__char_at'] || !ctx.core.stdlib['__str_byteLen']) return null

  // Stash the index in a local when it isn't a constant — bounds + load both reference it.
  const isConstIdx = Array.isArray(idxIR) && idxIR[0] === 'i32.const'
  let idxRefIR = idxIR, idxBindIR = null
  if (!isConstIdx) {
    const idxTmp = tempI32('si')
    idxBindIR = ['local.set', `$${idxTmp}`, idxIR]
    idxRefIR = ['local.get', `$${idxTmp}`]
  }

  const ptr = temp('sc')
  inc('__str_byteLen', '__char_at')
  const charEq = ['if', ['result', 'i32'],
    ['i32.gt_u', ['call', '$__str_byteLen', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]]], idxRefIR],
    ['then', ['i32.eq', ['call', '$__char_at', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]], idxRefIR], ['i32.const', lit.charCodeAt(0)]]],
    ['else', ['i32.const', 0]]]

  const prelude = idxBindIR ? [['local.set', `$${ptr}`, asF64(emit(obj))], idxBindIR] : [['local.set', `$${ptr}`, asF64(emit(obj))]]

  if (vt === VAL.STRING) {
    return typed(['block', ['result', 'i32'], ...prelude, finish(charEq)], 'i32')
  }

  inc('__ptr_type', '__typed_idx', '__eq')
  const genericEq = ['call', '$__eq',
    ['i64.reinterpret_f64', ['call', '$__typed_idx', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]], idxRefIR]],
    asI64(emit(['str', lit]))]
  const cmp = ['if', ['result', 'i32'],
    ptrTypeEq(['local.get', `$${ptr}`], PTR.STRING),
    ['then', charEq],
    ['else', genericEq]]
  return typed(['block', ['result', 'i32'], ...prelude, finish(cmp)], 'i32')
}

// `<str>.{substr,substring,slice}(...) === <other>` whose substring is consumed
// only by the equality: materialising it (an __alloc + byte copy) is pure waste.
// Fuse to __str_{substring,slice}_eq, which clamp the range like the method then
// byte-compare it against `other` in place. Sibling to emitSingleCharIndexCmp,
// tried at the same `==`/`!=` sites. Motivating hot path: the parser keyword
// scan, `cur.substr(i,l) === keyword`.
function emitSubstringEqCmp(a, b, negate = false) {
  // Post-prepare a multi-arg call keeps its args as one comma list; a single
  // arg sits bare. Normalise either (and a flat tail, defensively) to a list.
  const callInfo = node => {
    if (!Array.isArray(node) || node[0] !== '()') return null
    const callee = node[1]
    if (!Array.isArray(callee) || callee[0] !== '.') return null
    const method = callee[2]
    if (method !== 'substr' && method !== 'substring' && method !== 'slice') return null
    let args = node.slice(2)
    if (args.length === 1 && Array.isArray(args[0]) && args[0][0] === ',') args = args[0].slice(1)
    while (args.length && args[args.length - 1] == null) args = args.slice(0, -1)
    return { recv: callee[1], method, args }
  }

  let info = callInfo(a), other = b, callIsLeft = true
  if (!info) { info = callInfo(b); other = a; callIsLeft = false }
  if (!info) return null
  const { recv, method, args } = info
  if (args.length > 2) return null
  if (!ctx.core.stdlib['__char_at'] || !ctx.core.stdlib['__str_byteLen']) return null

  // The receiver must be a string. `substr`/`substring` name string-only methods,
  // so an unknown receiver is safe — the normal `.substr`/`.substring` emitter
  // assumes a string too. `slice` is also Array.prototype.slice — require a
  // statically-known STRING there. A known non-string receiver bails always.
  const vt = resolveValType(recv, valTypeOf, lookupValType)
  if (vt && vt !== VAL.STRING) return null
  if (method === 'slice' && vt !== VAL.STRING) return null

  const helper = method === 'slice' ? '__str_slice_eq' : '__str_substring_eq'
  inc(helper)

  // Absent end → byteLen: pass i32 max — every clamp arm floors it to the length.
  // ToIntegerOrInfinity position args — asI32Sat, not asI32 (see asI32Sat's doc, src/
  // ir.js, and sliceEmitter's matching comment in module/string.js): __str_slice_eq/
  // __str_substring_eq clamp through __clamp_idx exactly like the materializing
  // .slice/.substring/.substr emitters this fuses, so this fused `===`/`!==` path needs
  // the identical fix or it silently disagrees with its own non-fused twin (confirmed
  // live: this was the actual reason `new String(x).slice(NaN, Infinity) !== "…"`
  // still mis-evaluated after fixing sliceEmitter alone — a `.slice(...) !== other`
  // comparison compiles through fusion here, never reaching sliceEmitter at all).
  const TO_END = ['i32.const', 0x7FFFFFFF]
  let startIR, endIR
  if (method === 'substr' && args[1] != null) {
    // substr's 2nd arg is a length: end = start + length, so start reads twice.
    const s = tempI32('subS')
    startIR = ['local.tee', `$${s}`, args[0] == null ? ['i32.const', 0] : asI32Sat(emit(args[0]))]
    endIR = ['i32.add', ['local.get', `$${s}`], asI32Sat(emit(args[1]))]
  } else {
    startIR = args[0] == null ? ['i32.const', 0] : asI32Sat(emit(args[0]))
    endIR = args[1] == null ? TO_END : asI32Sat(emit(args[1]))
  }

  const finish = expr => negate ? ['i32.eqz', expr] : expr

  if (callIsLeft)
    return typed(finish(['call', `$${helper}`, asI64(emit(recv)), startIR, endIR, asI64(emit(other))]), 'i32')

  // `other` is the source-left operand — evaluate it first to preserve order.
  const o = temp('subO')
  return typed(['block', ['result', 'i32'],
    ['local.set', `$${o}`, asF64(emit(other))],
    finish(['call', `$${helper}`, asI64(emit(recv)), startIR, endIR,
      ['i64.reinterpret_f64', ['local.get', `$${o}`]]])], 'i32')
}

// One half of a two-sided range test against a compile-time constant, normalized to
// an inclusive bound on a *local* `x`: `{ x, lo }` (x ≥ lo) or `{ x, hi }` (x ≤ hi).
// `>`/`<` fold to the inclusive neighbor; a const on either side is accepted. Returns
// null for anything else (so the caller leaves the expression untouched).
function rangeBound(n) {
  if (!Array.isArray(n) || n.length !== 3) return null
  const lc = intLiteralValue(n[1]), rc = intLiteralValue(n[2])
  if (rc != null && typeof n[1] === 'string') {        // x  op  CONST
    if (n[0] === '>=') return { x: n[1], lo: rc }
    if (n[0] === '>') return { x: n[1], lo: rc + 1 }
    if (n[0] === '<=') return { x: n[1], hi: rc }
    if (n[0] === '<') return { x: n[1], hi: rc - 1 }
  }
  if (lc != null && typeof n[2] === 'string') {        // CONST  op  x
    if (n[0] === '<=') return { x: n[2], lo: lc }
    if (n[0] === '<') return { x: n[2], lo: lc + 1 }
    if (n[0] === '>=') return { x: n[2], hi: lc }
    if (n[0] === '>') return { x: n[2], hi: lc - 1 }
  }
  return null
}

// `x >= LO && x <= HI` (x a pure i32 local, LO ≤ HI constants) → `(x - LO) <=u (HI - LO)`.
// One subtract + one unsigned compare replaces two signed compares, an AND, and the
// short-circuit branch — the classic range-check trick (valid for any integers via
// wrapping subtraction). Returns the fused IR, or null to leave `&&` lowering unchanged.
//
// `&&` parses left-deep, so a 4-conjunct chain `x>=0 && x<W && y>=0 && y<H` is
// `((x>=0 && x<W) && y>=0) && y<H` — the y-pair straddles an intervening `&&` node
// (`y>=0` is that node's right child, `y<H` is `b`), not immediate siblings. When the
// direct match fails and `a` is itself a left-deep `&&`, `b` can still only ever pair
// with the conjunct immediately to its left in evaluation order — `a`'s own right
// child — so retry there. On success, the chain's remaining head (`a[1]`, itself
// possibly hiding another fusable pair) still needs emitting and ANDing onto the
// fused result: `combineFusedAnd` does that, mirroring the '&&' emitter's own
// combine tail below so the eager-AND / short-circuit-if choice stays identical.
// Sound because every fused operand is a side-effect-free comparison (`rangeBound`
// requires a bare identifier against a compile-time constant, never an arbitrary
// expression) and `&&` is associative over pure booleans; `a[1]` still evaluates and
// gates first, so evaluation order and short-circuiting are unchanged — a non-range
// conjunct anywhere in `a[1]` (e.g. `foo() && x>=0 && x<W`) is simply emitted and
// ANDed in, never reordered or dropped.
function fuseRangeCheck(a, b) {
  const ba = rangeBound(a), bb = rangeBound(b)
  if (!ba || !bb || ba.x !== bb.x || (ba.lo != null) === (bb.lo != null)) {
    if (Array.isArray(a) && a[0] === '&&') {
      const fusedTail = fuseRangeCheck(a[2], b)
      if (fusedTail) return combineFusedAnd(a[1], fusedTail)
    }
    return null
  }
  const lo = ba.lo ?? bb.lo, hi = ba.hi ?? bb.hi
  if (lo > hi) return null
  const xv = emit(ba.x)
  if (xv.type !== 'i32') return null                   // f64 (fractional) would mis-fuse
  return typed(['i32.le_u', ['i32.sub', xv, ['i32.const', lo]], ['i32.const', hi - lo]], 'i32')
}

// The complement: `x < LO || x > HI` (the two outside half-checks — one upper-bounded,
// one lower-bounded, with a gap between) → `(x - LO) >u (HI - LO)`, where [LO, HI] is the
// inside range. Same trick, negated; returns null to leave `||` lowering unchanged.
// Same left-deep-chain recursion as `fuseRangeCheck` above, across `||` nodes instead
// of `&&`, combined via `combineFusedOr`.
function fuseRangeCheckOr(a, b) {
  const ba = rangeBound(a), bb = rangeBound(b)
  if (!ba || !bb || ba.x !== bb.x || (ba.lo != null) === (bb.lo != null)) {
    if (Array.isArray(a) && a[0] === '||') {
      const fusedTail = fuseRangeCheckOr(a[2], b)
      if (fusedTail) return combineFusedOr(a[1], fusedTail)
    }
    return null
  }
  const insideLo = (ba.hi ?? bb.hi) + 1, insideHi = (ba.lo ?? bb.lo) - 1
  if (insideLo > insideHi) return null
  const xv = emit(ba.x)
  if (xv.type !== 'i32') return null
  return typed(['i32.gt_u', ['i32.sub', xv, ['i32.const', insideLo]], ['i32.const', insideHi - insideLo]], 'i32')
}

// Combine a chain-recursion "gate" AST node (the left remainder of a `&&`/`||` chain,
// `a[1]` above) with an already-emitted fused-range IR (always i32, canonical 0/1,
// side-effect-free and cheap by construction — see `fuseRangeCheck`/`fuseRangeCheckOr`).
// Mirrors the combine tail of the `'&&'`/`'||'` emitters (below) exactly, just fed a
// pre-built right-hand IR instead of deriving one from a raw `b` AST node via
// `emit(b)`/`isCanonicalBoolExpr(b)` — the fused IR always qualifies as both (i32-typed,
// canonical, `isI32Num` true), so those checks are inlined as always-true rather than
// recomputed. Kept in exact structural lockstep with the emitters so a future edit to
// one is a visible diff away from the other.
function combineFusedAnd(gateNode, fusedIR) {
  const vg = emit(gateNode)
  if (vg.type === 'i32') {
    if (boolEagerBody() && isCanonicalBoolExpr(gateNode) && eagerSelectOK(fusedIR))
      return typed(['i32.and', vg, fusedIR], 'i32')
    const t = tempI32()
    return typed(['if', ['result', 'i32'],
      ['local.tee', `$${t}`, vg],
      ['then', fusedIR],
      ['else', ['local.get', `$${t}`]]], 'i32')
  }
  const t = temp()
  const numA = isNumArm(vg, gateNode)
  const teed = typed(['local.tee', `$${t}`, canonArm(asF64(vg), numA, true)], 'f64')
  if (numA) teed.valKind = VAL.NUMBER
  return typed(['if', ['result', 'f64'], toBoolFromEmitted(teed),
    ['then', canonArm(asF64(fusedIR), true, numA)],
    ['else', ['local.get', `$${t}`]]], 'f64')
}

function combineFusedOr(gateNode, fusedIR) {
  const vg = emit(gateNode)
  if (vg.type === 'i32') {
    if (boolEagerBody() && isCanonicalBoolExpr(gateNode) && eagerSelectOK(fusedIR))
      return typed(['i32.or', vg, fusedIR], 'i32')
    const t = tempI32()
    return typed(['if', ['result', 'i32'],
      ['local.tee', `$${t}`, vg],
      ['then', ['local.get', `$${t}`]],
      ['else', fusedIR]], 'i32')
  }
  const t = temp()
  const numA = isNumArm(vg, gateNode)
  const teed = typed(['local.tee', `$${t}`, asF64(vg)], 'f64')
  if (numA) teed.valKind = VAL.NUMBER
  return typed(['if', ['result', 'f64'], toBoolFromEmitted(teed),
    ['then', ['local.get', `$${t}`]],
    ['else', canonArm(asF64(fusedIR), true, numA)]], 'f64')
}

// Flow-sensitive type refinement moved to ./flow-types.js (extractRefinements,
// predicateRefinement, mergeRefinement, withRefinements). emit.js imports them
// from there — see the import block at the top of this file.

// Preserve the per-iteration SSA shape of block-scoped scalar scratch when a
// small loop is expanded. Reusing one wasm local for every unrolled `const x`
// makes it multi-def; LICM must then conservatively leave expressions such as
// `x*x + y*y` in an enclosing hot loop. Native optimizers retain one SSA value
// per source iteration and hoist each expression. Since closures are rejected
// by unrollSmallConstFor, a loop-body let/const binding has no observable
// identity across iterations and each emitted copy may use a fresh wasm local.
//
// Rename the already-emitted IR rather than the AST: analysis and all typed/
// schema proofs still run under the original binding, while the final scalar
// IR exposes independent defs to LICM. Pointer-shaped locals are excluded —
// their name can key side metadata (flat slots/schema/typed ctor); this pass is
// specifically for numeric/boolean scratch.
function freshenUnrolledScalarBindings(body, ir) {
  if (ctx.transform.optimize?.splitScratch !== true) return ir
  const names = new Set()
  const collect = n => {
    if (!Array.isArray(n) || n[0] === '=>') return
    if (n[0] === 'let' || n[0] === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        const name = Array.isArray(d) && d[0] === '=' ? d[1] : d
        if (typeof name === 'string') names.add(name)
      }
    }
    for (let i = 1; i < n.length; i++) collect(n[i])
  }
  collect(body)
  if (!names.size) return ir

  const rename = new Map()
  for (const name of names) {
    const type = ctx.func.locals.get(name)
    if (type !== 'i32' && type !== 'f64' && type !== 'i64' && type !== 'f32') continue
    if (ctx.func.boxed?.has(name) || ctx.func.flatObjects?.has(name) ||
        ctx.func.typedElem?.has(name)) continue
    const rep = ctx.func.localReps?.get(name)
    if (rep?.val != null && rep.val !== VAL.NUMBER && rep.val !== VAL.BOOL) continue
    const fresh = `${T}us${freshId(ctx)}_${name}`
    ctx.func.locals.set(fresh, type)
    rename.set(`$${name}`, `$${fresh}`)
  }
  if (!rename.size) return ir

  // HIR provenance link upkeep (.work/research.md §BodyModel slice 4 — found via its own
  // shadow-assert, vectorize.js's assertLoopPlanAgrees): this rename mutates local names IN
  // PLACE on the ALREADY-linked block node the nested loop's own 'for' emission minted a
  // LoopPlan for — the block's IDENTITY survives (same array), so loopPlanLink still resolves
  // it, but its `lowering.ivName`/`lowering.guardName` (captured pre-rename) would go STALE if a
  // renamed name was the loop's own induction/guard variable — exactly the small-const-unrolled-
  // outer-loop-with-nested-loop shape (`splitScratch`'s only use case). Keep the fact accurate
  // rather than evict it: a `block` descendant with a link gets its `lowering` name fields
  // carried through the SAME rename map — `plan` (the frozen HIR-side facts) is NEVER touched
  // (a rename is backend metadata, not a fact HIR proved). Metadata-only —
  // never touches `ir`'s own content, so this cannot affect emitted bytes.
  const rewrite = n => {
    if (!Array.isArray(n)) return
    if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && rename.has(n[1]))
      n[1] = rename.get(n[1])
    else if (n[0] === 'block') {
      const link = ctx.plans.loweringLinks.get(n)
      if (link) {
        const { lowering } = link
        const ivKey = lowering.ivName != null ? `$${lowering.ivName}` : null
        if (ivKey && rename.has(ivKey)) lowering.ivName = rename.get(ivKey).slice(1)
        const gKey = lowering.guardName != null ? `$${lowering.guardName}` : null
        if (gKey && rename.has(gKey)) lowering.guardName = rename.get(gKey).slice(1)
      }
    }
    for (let i = 1; i < n.length; i++) rewrite(n[i])
  }
  for (const n of ir) rewrite(n)
  return ir
}

function unrollSmallConstFor(init, cond, step, body) {
  // Keep the overwhelmingly-common `for(i=0;i<N;i++)` path allocation-free;
  // only strided/nonzero-start control loops pay for an explicit value list.
  const simpleEnd = smallConstForTripCount(init, cond, step)
  let name, values = null, tripCount
  if (simpleEnd != null) {
    name = init[1][1]
    tripCount = simpleEnd
  } else {
    if (!Array.isArray(init) || init[0] !== 'let' || init.length !== 2 ||
        !Array.isArray(init[1]) || init[1][0] !== '=' || typeof init[1][1] !== 'string') return null
    name = init[1][1]
    const start = constIntExpr(init[1][2])
    if (start == null || !Array.isArray(cond) || cond[0] !== '<' || cond[1] !== name) return null
    const end = constIntExpr(cond[2])
    let delta = null
    if (Array.isArray(step) && step[0] === '++' && step[1] === name) delta = 1
    else if (Array.isArray(step) && step[0] === '+=' && step[1] === name) delta = constIntExpr(step[2])
    if (end == null || delta == null || delta <= 0 || start < 0 || start >= end) return null
    values = []
    for (let v = start; v < end && values.length <= MAX_SMALL_FOR_UNROLL; v += delta) values.push(v)
    if (!values.length || values.length > MAX_SMALL_FOR_UNROLL) return null
    tripCount = values.length
  }
  if (containsNestedLoop(body)) {
    const nestedMode = ctx.transform.optimize?.nestedSmallConstForUnroll
    if (nestedMode !== true && (nestedMode !== 'auto' || !containsKnownTypedArrayIndex(body))) return null
    const budget = tripCount * nestedSmallLoopBudget(body)
    if (budget > MAX_NESTED_FOR_UNROLL) {
      // A tiny outer CONTROL loop can still profitably specialize a large
      // inner kernel when its induction value selects machine operations
      // (radix shifts, lane selectors). The inner loops remain loops; code
      // growth is bounded directly instead of multiplying their trip counts.
      const controlsOp = some(body, n => (n[0] === '>>>' || n[0] === '>>' || n[0] === '<<') && n[2] === name)
      if (!controlsOp || tripCount > 4 || tripCount * forInBodyCost(body) > 600) return null
    }
  }
  if (hasOwnBreakOrContinue(body) || containsNestedClosure(body) || containsDeclOf(body, name)) return null
  if (isReassigned(body, name)) return null

  const out = []
  const emitCopy = value => {
    const copy = cloneWithSubst(body, name, value)
    out.push(...freshenUnrolledScalarBindings(copy, emitVoid(copy)))
  }
  if (values) for (const value of values) emitCopy(value)
  else for (let i = 0; i < simpleEnd; i++) emitCopy(i)
  return out
}

// Max distinct keys a for-in unrolls over (bounds code size; larger key sets keep
// the pooled-keys loop, which is already allocation-free via __keys_ro).
const FORIN_UNROLL_MAX = 16
// Total-expansion ceiling: unroll emits one body copy per key, so the size cost is
// keys × body, not keys alone. A large body over many keys (e.g. watr's 15-key
// schema loop) blows up code size for no deopt win — the pooled fallback is already
// allocation-free. Cap keys × nodeSize(body); past it, keep the loop. (Tuned above
// every unroll the corpus actually wants — the 16-key cap test lands at 80.)
const FORIN_UNROLL_BUDGET = 128
const forInBodyCost = (node) => {
  if (!Array.isArray(node)) return 1
  let n = 1
  for (let i = 1; i < node.length; i++) n += forInBodyCost(node[i])
  return n
}

// Pull the for-in source out of prepare's keys expression: either a bare
// `__keys_ro(src)` call or the nullish-guarded `cond ? [] : __keys_ro(src)`.
function keysRoSrc(node) {
  if (!Array.isArray(node)) return null
  if (node[0] === '()' && node[1] === '__keys_ro') return node[2]
  if (node[0] === '?:' || node[0] === '?') {
    const last = node[node.length - 1]
    if (Array.isArray(last) && last[0] === '()' && last[1] === '__keys_ro') return last[2]
  }
  return null
}

// Unroll `for (k in o)` over a static schema. Prepare lowers for-in to a plain
// for-loop whose key array comes from the for-in-exclusive `__keys_ro` intrinsic,
// so a loop carrying it IS a for-in. When `o` is a bare OBJECT var with a complete
// static schema (no computed-key writes — same gate as __keys_ro pooling), replace
// the loop with one substituted copy of the body per key: the loop variable becomes
// a string literal, so `o[k]` folds to a static schema slot — no keys array, no
// per-element dynamic get. Falls back (returns null) to the pooled loop otherwise.
function unrollForIn(init, cond, step, body) {
  if (!Array.isArray(init) || init[0] !== 'let' || !Array.isArray(init[1]) || init[1][0] !== '=') return null
  const ksVar = init[1][1]
  const src = keysRoSrc(init[1][2])
  if (typeof src !== 'string') return null
  if (!Array.isArray(cond) || cond[0] !== '<') return null
  const ixVar = cond[1]
  if (!Array.isArray(step) || step[0] !== '++' || step[1] !== ixVar) return null
  // body = [';', ['let', ['=', target, ['[]', ksVar, ixVar]]], ...realBody]
  if (!Array.isArray(body) || body[0] !== ';') return null
  const bind = body[1]
  if (!Array.isArray(bind) || bind[0] !== 'let' || !Array.isArray(bind[1]) || bind[1][0] !== '=') return null
  const target = bind[1][1]
  const acc = bind[1][2]
  if (!Array.isArray(acc) || acc[0] !== '[]' || acc[1] !== ksVar || acc[2] !== ixVar) return null

  // Unroll only with PROOF the schema is complete: a computed-key write adds
  // enumerable keys, so bail if `src` takes one — or if the fact is unavailable
  // (no proof ⇒ no unroll; unrolling drops the dynamic path, so erring safe matters).
  if (!ctx.types.dynWriteVars || ctx.types.dynWriteVars.has(src)) return null
  if (lookupValType(src) !== VAL.OBJECT) return null
  const keys = ctx.schema.resolve(src)
  if (!keys || !keys.length || keys.length > FORIN_UNROLL_MAX) return null
  // A literal-key write OUTSIDE the schema also adds an enumerable key (it
  // lands in the dyn sidecar) — same proof obligation as computed writes.
  const lw = ctx.types.literalWriteKeys?.get(src)
  if (lw) for (const k of lw) if (!keys.includes(k)) return null

  const rest = body.slice(2)
  const realBody = rest.length === 1 ? rest[0] : [';', ...rest]
  // Keep the pooled loop when unrolling would multiply a heavy body across many keys.
  if (keys.length * forInBodyCost(realBody) > FORIN_UNROLL_BUDGET) return null
  // Substitution safety, mirroring unrollSmallConstFor: no reassignment/redeclare
  // of the loop var, no nested closure capturing it (cloneWithSubst skips `=>`),
  // and no break/continue targeting this loop.
  if (hasOwnBreakOrContinue(realBody) || containsNestedClosure(realBody) || containsDeclOf(realBody, target)) return null
  if (isReassigned(realBody, target)) return null

  const out = []
  for (const key of keys) out.push(...emitVoid(cloneWithSubst(realBody, new Map([[target, ['str', key]]]))))
  return out.length ? out : ['nop']
}

function canThrow(body, seen = new Set()) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'throw') return true
  // Unresolved ordinary `.length` now performs a real property Get, including
  // the nullish TypeError. Keep a surrounding source try/catch live even when
  // there is no explicit `throw` node in the AST. Optional chaining does not
  // throw and stays excluded.
  if (op === '.' && body[2] === 'length' && valTypeOf(body[1]) == null) return true
  if (op === '[]' && staticPropertyKey(body[2]) === 'length' && valTypeOf(body[1]) == null) return true
  if (op === '=>') return false
  if (op === '()') {
    const callee = body[1]
    // A call can throw unless we can see the whole callee and prove it can't:
    // only direct calls into a resolvable, non-raw function body are traceable.
    // Indirect/method/builtin calls (callee not a plain name, or a name we can't
    // resolve) are conservatively throwing — a user `try` must wrap them.
    if (typeof callee !== 'string') return true
    const bodyName = ctx.func.directClosures?.get(callee)
    const f = ctx.funcs.map?.get(bodyName || callee)
    if (!f?.body || f.raw) return true
    if (!seen.has(f.name)) {
      seen.add(f.name)
      if (canThrow(f.body, seen)) return true
    }
  }
  for (let i = 1; i < body.length; i++) if (canThrow(body[i], seen)) return true
  return false
}

// Loop-bound hoisting (see the 'for' emitter): comparison ops whose invariant side
// is worth lifting, and the test for an immutable, loop-stable `arr.length`. A typed
// array's length is fixed, so it is loop-invariant whenever `arr` is not reassigned.
// A plain array's length CAN change (push/pop/index-grow/length=), so it is hoistable
// only when the loop body provably never mutates it — `mutatesArrayLength` decides that.
const HOIST_CMP = new Set(['<', '<=', '>', '>='])
const immutableLenBound = (node, body) => {
  // Unwrap the `| 0` i32 coercion jz wraps a loop bound in (`i < arr.length`
  // emits `i < (arr.length | 0)`).
  if (Array.isArray(node) && node[0] === '|' && Array.isArray(node[2]) && node[2][0] == null && node[2][1] === 0)
    node = node[1]
  if (!(Array.isArray(node) && node[0] === '.' && node[2] === 'length' && typeof node[1] === 'string')) return false
  const vt = lookupValType(node[1])
  if (vt === VAL.TYPED) return !isReassigned(body, node[1])
  if (vt === VAL.ARRAY) return !mutatesArrayLength(body, node[1])
  return false
}

// Pull `const x = <array/object literal>` decls out of a loop body when the literal is
// deeply constant and `x` is provably read-only + non-escaping in the loop (so a single
// shared allocation is sound) — otherwise the constant table is re-allocated every
// iteration. Returns { hoisted: [decl…], body: strippedBody } or null. Only top-level
// statements of the loop body are considered.
const extractHoistableLiterals = (body) => {
  let stmts, rebuild
  if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';') {
    stmts = body[1].slice(1); rebuild = kept => ['{}', [';', ...kept]]
  } else if (Array.isArray(body) && body[0] === ';') {
    stmts = body.slice(1); rebuild = kept => kept.length === 1 ? kept[0] : [';', ...kept]
  } else return null
  const hoisted = [], kept = []
  for (const s of stmts) {
    const lit = Array.isArray(s) && (s[0] === 'const' || s[0] === 'let') && s.length === 2
      && Array.isArray(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string' ? s[1][2] : null
    if (lit && Array.isArray(lit) && lit[0] === '[' && isConstLiteral(lit) && constLiteralHoistable(body, s[1][1]))
      hoisted.push(s)
    else kept.push(s)
  }
  return hoisted.length ? { hoisted, body: rebuild(kept) } : null
}

/** Emit pending `finally` cleanups for an abrupt control-flow exit.
 *  Inner cleanups run before outer cleanups. While emitting each cleanup, remove
 *  it from the active stack so `return` inside `finally` does not re-enter it.
 *  `minDepth` scopes the exit: only trys ENTERED at control-frame depth >= minDepth
 *  are being exited by this branch. A `continue`/`break` targeting a loop that
 *  CONTAINS the try runs its finally (the branch leaves the try body); a try that
 *  contains the whole loop stays live (control never leaves it) and must not run —
 *  each entry records ctx.func.stack.length at try entry, so a frame at index i
 *  scopes to entries with depth > i. `return` exits every frame (minDepth 0). */
function emitFinalizers(minDepth = 0) {
  const stack = ctx.func.finallyStack || []
  if (stack.length === 0) return []
  const saved = stack.slice()
  const out = []
  for (let i = saved.length - 1; i >= 0 && saved[i].depth >= minDepth; i--)
    out.push(...withFinallyStack(saved.slice(0, i), () => emitVoid(saved[i].cleanup)))
  return out
}

// `(a / b) | 0` (the JS integer-division idiom) → i32.div_s. jz otherwise lowers `/`
// to f64.div + ToInt32, paying two i32→f64 converts and the trunc; i32.div_s is
// direct and lets the wasm backend magic-multiply a constant divisor. Bit-exact for
// all i32 a,b: |a|<2³³≪2⁵³ so the f64 quotient never rounds across the truncation
// boundary — EXCEPT b=0 (`(a/0)|0` is ToInt32(±Inf)=0, but i32.div_s traps) and
// INT_MIN/-1 (ToInt32 wraps to INT_MIN, i32.div_s traps); both guarded. A constant
// divisor folds the guards away. `exprType==='i32'` excludes unsigned operands
// (those return 'f64'), where div_s would misread the sign. Returns IR or null.
const INT_MIN_I32 = -2147483648
function tryIntDivTrunc(aNode, bNode) {
  const o = ctx.transform.optimize
  if (!o || o.intDivLower === false) return null
  const L = ctx.func.locals
  if (exprType(aNode, L) !== 'i32' || exprType(bNode, L) !== 'i32') return null
  const dv = intLiteralValue(bNode)
  if (dv != null) {                         // constant divisor — no runtime guard
    const va = asI32(emit(aNode))
    if (dv === 0) return typed(['block', ['result', 'i32'], ['drop', va], ['i32.const', 0]], 'i32')
    if (dv === -1) return typed(['i32.sub', ['i32.const', 0], va], 'i32')  // -a, wraps at INT_MIN
    // Power-of-two divisor with a PROVEN-non-negative dividend truncates the
    // same as a logical shift (`(dq/65536)|0` ≡ `dq >>> 16` for dq ≥ 0 — the
    // q16 fixed-point split). intExprRange supplies the proof through masked/
    // ternary/bounded-product decl chains; sdiv is ~13 cycles, shr is 1.
    if (dv > 0 && (dv & (dv - 1)) === 0) {
      const r = intExprRange(aNode)
      if (r && r[0] >= 0) return typed(['i32.shr_u', va, ['i32.const', 31 - Math.clz32(dv)]], 'i32')
    }
    return typed(['i32.div_s', va, ['i32.const', dv | 0]], 'i32')
  }
  // Runtime divisor needs a,b repeated across the guard; only intercept when both are
  // simple re-emittable operands (var / literal) so re-emit is pure and side-effect-free.
  const simple = (n) => typeof n === 'string' || intLiteralValue(n) != null
  if (!simple(aNode) || !simple(bNode)) return null
  const A = () => asI32(emit(aNode)), B = () => asI32(emit(bNode))
  return typed(['if', ['result', 'i32'], ['i32.eqz', B()],
    ['then', ['i32.const', 0]],
    ['else', ['if', ['result', 'i32'],
      ['i32.and', ['i32.eq', A(), ['i32.const', INT_MIN_I32]], ['i32.eq', B(), ['i32.const', -1]]],
      ['then', A()],
      ['else', ['i32.div_s', A(), B()]]]]], 'i32')
}

/**
 * Fresh per-iteration heap cells for boxed (closure-captured) locals declared
 * in a loop body. ECMAScript establishes the per-iteration environment at the
 * START of each iteration, so the cell must exist before ANY body statement —
 * including a closure declared *before* the binding (mutual recursion, or a
 * `function` decl jzify hoists above its captures). Allocating at the decl point
 * instead would let an earlier closure capture the previous iteration's (stale)
 * cell while the binding reads/writes the freshly-allocated one. `emitDecl` then
 * stores the initializer into this cell rather than re-allocating (see
 * `frame.loopFresh`). Returns the alloc IR to splice at loop-body entry.
 */
export function emitLoopFreshBoxed(body, frame) {
  if (!ctx.func.boxed?.size) return []
  const names = new Set()
  ;(function scan(node) {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>' || op === 'for' || op === 'for-of' || op === 'for-in' || op === 'while' || op === 'do') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        const nm = Array.isArray(d) && d[0] === '=' ? d[1] : d
        if (typeof nm === 'string' && ctx.func.boxed.has(nm)) names.add(nm)
      }
    }
    for (let i = 1; i < node.length; i++) scan(node[i])
  })(body)
  if (!names.size) return []
  frame.loopFresh = names
  const inits = []
  for (const name of names) {
    const cell = ctx.func.boxed.get(name)
    ctx.func.locals.set(cell, 'i32')
    inits.push(
      ['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]],
      ['f64.store', ['local.get', `$${cell}`], undefExpr()])
  }
  return inits
}

// A VAL.BOOL value can ride either the cheap 0/1 numeric carrier or, after it has
// escaped into an object slot, a boxed boolean atom. `ToNumber(bool)` normalizes
// both to 0/1, so for relational / loose-equality coercion a boolean behaves
// identically to a number. Normalize it before the type-directed compare dispatch
// (the BOOL fact still drives typeof / String / boundary boxing).
const numericVal = vt => vt === VAL.BOOL ? VAL.NUMBER : vt

// Primitive value-type classes for strict-equality type-mismatch folding. Two
// operands of different known classes — when at least one is a primitive — can
// never be `===` (number/boolean/string/bigint don't cross-coerce under `===`).
// Two *reference* kinds (array vs object, …) fall through to the shared ref-eq
// path instead, which already resolves distinct pointers to `false`.
const STRICT_PRIM = new Set([VAL.NUMBER, VAL.BOOL, VAL.STRING, VAL.BIGINT])

/**
 * Strict `===`/`!==`. Unlike loose `==`, no coercion: a statically-known type
 * mismatch folds to a constant (`true === 1` → false, `"1" === 1` → false). When
 * the types match — or one side is statically unknown — the result is bit-for-bit
 * identical to loose `==` on same-type operands, so we delegate to it.
 *
 * `null` and `undefined` are distinct NaN-boxed sentinels, so `===` tells them
 * apart (`null === undefined` is false) even though loose `==` treats both nullish.
 *
 * One carrier-level limitation remains (documented gap, not a regression): booleans
 * and numbers share the 0/1 carrier, so `1 === trueDynamic` can only be told apart
 * when the boolean's type is statically known.
 */
// A binding the analyzer marked `nullable` (its init or some assignment was a
// nullish literal) can hold null/undefined at runtime, so `x === null` / `x == null`
// must NOT fold to a constant even when `val` is a definite non-null kind. Only bare
// variable reads carry the flag; literals/fresh allocations are inherently non-null.
// An UNPROVEN typed-index read joins the set: `ta[i]` reads `undefined` past the end
// (the checked .typed:[] form), while its VT stays NUMBER for numeric dispatch — the
// undef box IS a NaN through arithmetic; only these identity folds must stay live.
// `ta[i] === undefined` is the idiomatic bounds probe, so folding it kills real code.
// A dict-mode `[]`/`.` read or `recv.get(k)` Map read whose VT comes SOLELY
// from dictValueKindOf/mapValueKindOf's soundness carve-out joins the set for
// the identical reason: an unwritten key reads back the same undefined —
// `prec[op] === undefined` (does this key exist?) is that dict's own bounds
// probe. The predicate is `censusMaybeUndefined` (kind.js,
// .work/todo.md §deletion-sweep) — REACHABLE but not yet
// LOAD-BEARING here: Slice 4's VT['[]']/VT['.']/VT['()'] exact-kind wiring
// was reverted (audit #10, §14 is the re-enablement path), so `valTypeOf`
// for a dict/Map read stays null and this function's callers never reach a
// state where the difference matters — YET. Kept correct anyway (not
// reverted to the old early-return) because the composition bug it fixes is
// real independent of VT: a bare name must fall through to the bottom `if
// (censusMaybeUndefined(n))` check — NOT early-return on `.nullable` alone
// (a materially DIFFERENT REP field, seeded by nullish-literal producers,
// that says nothing about a census-copied `mayBeUndefined` binding) — so a
// decl-hop identity compare (`let x = m.get(missing); x === undefined`)
// stays sound the moment §14's opt-in presentVal model makes `x`'s claim
// live again, with no re-audit of this call site required.
const nullableOperand = (n) => {
  if (typeof n === 'string' && (repOf(n)?.nullable || repOfGlobal(n)?.nullable)) return true
  if (Array.isArray(n) && n[0] === '[]' && n.length === 3
      && typeof n[1] === 'string' && lookupValType(n[1]) === VAL.TYPED) {
    // A statically in-range OUTER access can still miss when its direct index
    // is itself a checked typed read (`out[count[d]]`, d OOB). Keep identity
    // tests live so the propagated miss bit can produce `undefined`.
    if (Array.isArray(n[2]) && n[2][0] === '[]' && typeof n[2][1] === 'string' &&
        lookupValType(n[2][1]) === VAL.TYPED && !typedIdxProven(n[2][1], n[2][2])) return true
    return !typedIdxProven(n[1], n[2])
  }
  if (censusMaybeUndefined(n)) return true
  return false
}

// An emitted value whose bit pattern is an i32, paired with how it widens to f64: a
// `f64.convert_i32_s/u(x)` peels to its i32 source `x`; a bare i32 widens signed. Used to compare
// two integer-backed operands directly in i32 instead of widening both to f64.
const peelIntCmp = (v) => {
  if (Array.isArray(v) && (v[0] === 'f64.convert_i32_s' || v[0] === 'f64.convert_i32_u'))
    return { src: Array.isArray(v[1]) ? typed(v[1], 'i32') : v[1], sign: v[0] === 'f64.convert_i32_u' ? 'u' : 's' }
  if (v && v.type === 'i32') return { src: v, sign: 's' }
  return null
}
// The value's top bit is provably 0 (so its signed and unsigned readings agree): a u8/u16 load,
// `>>>` (always clears the sign bit), `& m` with m a non-negative small const, or a small const.
const i32TopBitClear = (n) => {
  if (typeof n === 'number') return n >= 0 && n < 0x80000000
  if (!Array.isArray(n)) return false
  if (n[0] == null) return typeof n[1] === 'number' && n[1] >= 0 && n[1] < 0x80000000
  if (n[0] === 'i32.load8_u' || n[0] === 'i32.load16_u') return true
  if (n[0] === 'i32.const') return typeof n[1] === 'number' ? (n[1] >= 0 && n[1] < 0x80000000) : false
  if (n[0] === 'i32.shr_u' || n[0] === '>>>') return true
  if (n[0] === 'i32.and' || n[0] === '&') return i32TopBitClear(n[1]) || i32TopBitClear(n[2])
  return false
}
// i32.eq/ne over the peeled sources equals the f64-widened compare when the signs match, or — for
// a mixed signed/unsigned pair — when the unsigned-read source is top-bit-clear (then both readings
// of equal bits agree, and unequal bits stay unequal under both).
const i32EqSound = (pa, pb) => pa.sign === pb.sign ||
  i32TopBitClear((pa.sign === 'u' ? pa : pb).src)

// A memory-free, trap-free, side-effect-free expression — safe to evaluate UNCONDITIONALLY (as a
// `select` arm does) and cheap enough that doing so never loses to a branch. Locals/consts and
// arithmetic/bitwise/compare/logical over them. Excludes loads (`[]`, may read OOB when the guard
// was protecting the access), calls, `.`/`?.` (dispatch), `/` `%` (int trap on 0), assignments.
const CHEAP_PURE_OPS = new Set(['+', '-', '*', 'u-', 'u+', '&', '|', '^', '<<', '>>', '>>>', '~',
  '<', '<=', '>', '>=', '==', '!=', '===', '!==', '&&', '||', '!', '?:'])
const isCheapPureVal = (n) => {
  if (typeof n === 'string' || typeof n === 'number') return true
  if (!Array.isArray(n)) return false
  if (n[0] == null) return true                              // boxed literal [, v]
  if (n[0] === 'local.get') return true
  if (CHEAP_PURE_OPS.has(n[0])) { for (let i = 1; i < n.length; i++) if (!isCheapPureVal(n[i])) return false; return true }
  return false
}

// Side-effect-free: no writes (assignment / ++ / --), no calls, no closures, no throw. UNLIKE
// `isCheapPureVal` this ALLOWS loads, member reads, and `/` `%` — a side-effect-free expr may read
// memory or trap. It is the right gate for an `if` CONDITION promoted to a `select` condition: the
// condition is evaluated exactly once whether the lowering branches or selects (any trap fires the
// same in both, the read order vs the pure value arm is immaterial), so it need only avoid MUTATING
// state the value arm could read — i.e. be side-effect-free, not unconditionally-evaluable.
const SIDE_EFFECT_OPS = new Set([...MUTATE_OPS, '()', '=>', 'throw', 'new', 'await', 'yield'])
const isSideEffectFree = (n) => {
  if (!Array.isArray(n)) return true
  if (typeof n[0] === 'string' && SIDE_EFFECT_OPS.has(n[0])) return false
  for (let i = 1; i < n.length; i++) if (!isSideEffectFree(n[i])) return false
  return true
}
// A void statement whose whole effect is `x = <cheap pure value>` for a simple local `x` — the
// shape if→select can lower to `x = cond ? value : x`. Recognizes the plain assignment plus the
// increment forms `++x`/`--x` and their postfix lowerings `(++x) - 1` / `(--x) + 1` (prepare turns
// `x++` in statement position into the latter; the discarded ∓1 is dead in void context, so the
// net effect is the increment). Returns `{ lhs, val }` or null.
function matchVoidLocalStore(s) {
  if (!Array.isArray(s)) return null
  if (s[0] === '=' && typeof s[1] === 'string' && isCheapPureVal(s[2])) return { lhs: s[1], val: s[2] }
  if ((s[0] === '++' || s[0] === '--') && typeof s[1] === 'string')
    return { lhs: s[1], val: [s[0] === '++' ? '+' : '-', s[1], [, 1]] }
  // postfix: `x++` → `(++x) - 1`, `x--` → `(--x) + 1`
  if ((s[0] === '-' || s[0] === '+') && isLit1(s[2]) && Array.isArray(s[1])
      && (s[1][0] === '++' || s[1][0] === '--') && typeof s[1][1] === 'string') {
    const inc = s[1][0] === '++'
    if ((inc && s[0] === '-') || (!inc && s[0] === '+')) return { lhs: s[1][1], val: [inc ? '+' : '-', s[1][1], [, 1]] }
  }
  return null
}
function effectFoldSeq(operands, constIR) {
  const stmts = []
  for (const o of operands) if (o != null && !foldOperandPure(o)) stmts.push(['drop', emit(o)])
  if (!stmts.length) return constIR
  return typed(['block', ['result', 'i32'], ...stmts, constIR], 'i32')
}

function emitLooseEq(a, b, negate, strict) {
  const eqOp = negate ? 'ne' : 'eq'
  const sentinel = emitNum(negate ? 1 : 0)
  const charCmp = emitSingleCharIndexCmp(a, b, negate); if (charCmp) return charCmp
  const subCmp = emitSubstringEqCmp(a, b, negate); if (subCmp) return subCmp
  // JS loose nullish equality: x == null / x == undefined.
  // If the non-literal side has a known non-null VAL type, fold to the sentinel.
  const nullishOf = (other) => {
    if (valTypeOf(other) && !nullableOperand(other)) return effectFoldSeq([other], sentinel)
    const chk = isNullish(asF64(emit(other)))
    return negate ? typed(['i32.eqz', chk], 'i32') : chk
  }
  if (isNullishLit(a)) return nullishOf(b)
  if (isNullishLit(b)) return nullishOf(a)
  // typeof x == 'string' → compile-time type check (prepare rewrites string to type code)
  const tc = emitTypeofCmp(a, b, eqOp); if (tc) return tc
  const va = emit(a), vb = emit(b)
  if (va.type === 'i32' && vb.type === 'i32') return typed([`i32.${eqOp}`, va, vb], 'i32')
  // Both operands integer-backed (e.g. an i32 local vs a `b[j]` u8 read materialized as f64):
  // compare the i32 sources directly, skipping the per-op widen to f64. Recovers `intElem ===
  // intElem` in hot loops (levenshtein's DP cell, where `a[i-1] === b[j-1]` was an f64.eq + 2
  // converts every iteration). Sound only when the widen can't change the answer (see i32EqSound).
  const pa = peelIntCmp(va), pb = peelIntCmp(vb)
  if (pa && pb && i32EqSound(pa, pb)) return typed([`i32.${eqOp}`, pa.src, pb.src], 'i32')
  // Either side known-pure NUMBER (literal or typed) → f64.eq/ne is correct regardless
  // of the other side: jz's `==` is strict (prepare.js:868), and every NaN-boxed pointer
  // reinterprets to a quiet NaN (0x7FF8… prefix) so f64.eq with any normal float is false.
  // Catches `closureVar === 34` in jzified hot loops where the unknown side has no VAL.
  const rawA = resolveValType(a, valTypeOf, lookupValType)
  const rawB = resolveValType(b, valTypeOf, lookupValType)
  const vta = numericVal(rawA)
  const vtb = numericVal(rawB)
  const numA = () => rawA === VAL.BOOL ? toNumF64(a, va) : asF64(va)
  const numB = () => rawB === VAL.BOOL ? toNumF64(b, vb) : asF64(vb)
  // maybeUndefined join (.work/todo.md §deletion-sweep §1/Slice 5): "either
  // side known-pure NUMBER" above is only TRUE when that side's exact-kind
  // claim can't be falsified at runtime. `nullableOperand` (this file, above)
  // already unifies the two ways a NUMBER claim can lie — an unproven typed-
  // index OOB read and a dict-census exact-kind claim (censusMaybeUndefined)
  // — both yield a real `undefined` at runtime, a NaN-boxed sentinel that
  // f64.eq/ne can NEVER correctly equate to another NaN-boxed `undefined`
  // (IEEE-754 f64.eq is false for any NaN operand, by construction, even
  // against a bit-identical NaN) — unlike the relational family (cmpOp,
  // `<`/`>`/`<=`/`>=`), which stays correct unguarded: JS ToNumber(undefined)
  // = NaN and "compared to NaN" is always false, exactly what a raw f64
  // relational op already returns for ANY NaN-boxed operand, real or
  // masquerading — no fix needed there, confirmed by direct repro. Equality
  // has no such coincidence: `undefined === undefined` is TRUE in JS. A
  // genuinely CERTAIN real number on the OTHER side still makes f64.eq safe
  // regardless of nullability here (a real number can never equal a nullish/
  // pointer value, and f64.eq(realFloat, anyNaN) is unconditionally false,
  // matching) — so only a claim that is BOTH "===VAL.NUMBER" AND non-nullable
  // counts as "safe" below; a nullable claim degrades exactly as if that side
  // had no VAL.NUMBER proof at all, falling through to the fully-dynamic
  // `__eq`/`__eq_strict` fallback (below) or the coercion helper as
  // appropriate. Found live via `d[rk] === u` (u a genuinely-undefined local)
  // and `d[rk] == otherDict[missingKey]` (both operands independently
  // nullable) both wrongly reading false — JS true — pre-fix.
  const aSafe = vta === VAL.NUMBER && !nullableOperand(a)
  const bSafe = vtb === VAL.NUMBER && !nullableOperand(b)
  if (aSafe && needsToNumberCoercion(b, vtb)) return looseNumberEq(numA(), b, vb, negate)
  if (bSafe && needsToNumberCoercion(a, vta)) return looseNumberEq(numB(), a, va, negate)
  if (aSafe || bSafe) return typed([`f64.${eqOp}`, numA(), numB()], 'i32')
  // Both sides proven VAL.NUMBER but NEITHER individually "safe" above (both
  // nullable — the maybeUndefined gap this function's own Slice-5 fix closed
  // generically by falling all the way to the fully-dynamic __eq below). A
  // NUMBER-typed slot's only two possible runtime shapes are "a real number"
  // or a nullish sentinel (UNDEF_NAN from an unproven OOB/absent-key read,
  // rarely NULL_NAN from a nullish-literal producer) — never a string/
  // object/bigint — so it needs none of __eq's string-content/pointer-kind
  // dispatch (what pulls __str_eq/__is_str_key/__char_at/__str_byteLen into
  // a module with no string at all, e.g. a pure Uint8Array match loop:
  // `src[j+len] === src[ip+len]` — bisected live to this exact gap,
  // .work/todo.md "lz/glyfparse __eq bloat"). f64.eq alone is unsound only
  // when BOTH sides are nullish (IEEE-754: f64.eq is false for any NaN
  // operand, even a bit-identical one) — NOT a blind i64 bit-eq (a genuine
  // NaN payload, e.g. a literal `NaN` stored through the same slot, can
  // collide bit-for-bit with itself and would wrongly read equal — caught
  // live by a differential probe against real Float64Array NaN storage
  // before landing). isUndef/isNull/isNullish (ir.js) test the EXACT
  // reserved sentinel bit patterns, not "any matching NaN" — loose folds
  // null/undefined together (`null == undefined` is JS-true); strict needs
  // the same exact atom on both sides (`null === undefined` is JS-false).
  if (vta === VAL.NUMBER && vtb === VAL.NUMBER) {
    const fa = temp('numeq'), fb = temp('numeq')
    const faG = ['local.get', `$${fa}`], fbG = ['local.get', `$${fb}`]
    const numEq = typed(['f64.eq', faG, fbG], 'i32')
    const sentinelEq = strict
      ? typed(['i32.or',
          typed(['i32.and', isUndef(faG), isUndef(fbG)], 'i32'),
          typed(['i32.and', isNull(faG), isNull(fbG)], 'i32')], 'i32')
      : typed(['i32.and', isNullish(faG), isNullish(fbG)], 'i32')
    const eqExpr = typed(['i32.or', numEq, sentinelEq], 'i32')
    return typed(['block', ['result', 'i32'],
      ['local.set', `$${fa}`, asF64(va)],
      ['local.set', `$${fb}`, asF64(vb)],
      negate ? typed(['i32.eqz', eqExpr], 'i32') : eqExpr], 'i32')
  }
  // Reference-equal pointer kinds (same kind, non-STRING, non-BIGINT): i64 bit equality.
  // JS `==` on objects/arrays/sets/maps/etc. is pure reference equality — no content path.
  // STRING needs __eq (heap strings can be equal by content but different pointers).
  // BIGINT needs __eq (heap-allocated, content compare).
  if (vta && vta === vtb && REF_EQ_KINDS.has(vta)) {
    return typed([`i64.${eqOp}`, ['i64.reinterpret_f64', asF64(va)], ['i64.reinterpret_f64', asF64(vb)]], 'i32')
  }
  // String-equality specialization — the hot `node[0] === 'literal'` AST-tag dispatch,
  // the compiler's single most-emitted comparison (5579 of its 6487 __eq sites). When one
  // side is statically a STRING, skip the generic __eq NaN-box dispatch (the #1 self-compile
  // hot helper). jz's ==/=== never coerce (number-vs-string is false in __eq), so this is
  // sound for both. Two shapes by what the OTHER side is known to be:
  //   both STRING        → __str_eq directly (no number/NaN/tag test needed at all).
  //   STRING vs unknown  → i64.eq fast ? equal : (__is_str_key(u) ? __str_eq : not-equal).
  // Soundness of the fast path: the known string is a non-NaN STRING NaN-box, so a bit
  // match can ONLY be that same string (a normal f64 can't alias those bits). On bit
  // MISMATCH the unknown can still content-match — a heap string from `'i'+'f'` shares
  // content but not bits — so the fallback __str_eq stays (pure i64.eq is unsound here).
  // __is_str_key rejects the number-whose-bits-alias-the-STRING-tag case that a bare
  // __ptr_type would misroute into a wild __str_eq deref (see __eq's own guard).
  // INLINED (not a helper call): a single $__str_eq_lit helper measured 2.4% slower on
  // the corpus — V8 keeps the call at the hot miss path; inlining lets the optimizer fold
  // __is_str_key/__str_eq's prefix in, which is where the tag dispatch spends its time.
  // Behaviorally identical to __eq when one side is a string — proven by a 4584-case
  // spec-on/spec-off differential (zero divergence at optimize 0 and 2).
  const strEqResult = (r) => negate ? typed(['i32.eqz', r], 'i32') : r
  const aStr = rawA === VAL.STRING, bStr = rawB === VAL.STRING
  // SSO literal (≤6 ASCII — its NaN-box IS its content, see module/string.js codec):
  // under the ≤6-ASCII⇒SSO producer invariant, content equality ⟺ bit equality
  // against ANY operand — an equal string must be the same SSO pattern, a heap
  // string can't hold ≤6-ASCII content, and a non-string never equals a string
  // (bit-aliasing NaNs behave identically to the pre-existing bit-eq fast path).
  // So the whole compare collapses to ONE i64.eq/ne — no call, no fallback.
  const ssoLit = (n) => ctx.features.sso && isLiteralStr(n) && n[1].length <= 6 && /^[\x00-\x7f]*$/.test(n[1])
  if ((aStr || bStr) && (rawA == null || aStr) && (rawB == null || bStr) && (ssoLit(a) || ssoLit(b))) {
    return typed([`i64.${negate ? 'ne' : 'eq'}`, asI64(va), asI64(vb)], 'i32')
  }
  if (aStr && bStr) {
    inc('__str_eq')
    return strEqResult(typed(['call', '$__str_eq', asI64(va), asI64(vb)], 'i32'))
  }
  if ((bStr && rawA == null) || (aStr && rawB == null)) {
    const uVal = bStr ? va : vb, lVal = bStr ? vb : va   // u: unknown side, l: known string
    inc('__is_str_key', '__str_eq')
    const u = tempI64('seq'), l = tempI64('seq'), uG = ['local.get', `$${u}`], lG = ['local.get', `$${l}`]
    // On bit-mismatch, an SSO operand can't content-match anything (invariant
    // above) — one inline bit test skips the __is_str_key/__str_eq tail. Sound
    // for a non-string u too: the test only ever short-circuits to "not equal",
    // and a non-string never equals a string.
    const tail = ctx.features.sso
      ? ['if', ['result', 'i32'],
          ['i64.ne', ['i64.and', ['i64.or', uG, lG], ['i64.const', ssoBitI64Hex()]], ['i64.const', 0]],
          ['then', ['i32.const', 0]],
          ['else', ['if', ['result', 'i32'], ['call', '$__is_str_key', uG],
            ['then', ['call', '$__str_eq', uG, lG]],
            ['else', ['i32.const', 0]]]]]
      : ['if', ['result', 'i32'], ['call', '$__is_str_key', uG],
          ['then', ['call', '$__str_eq', uG, lG]],
          ['else', ['i32.const', 0]]]
    return strEqResult(typed(['block', ['result', 'i32'],
      ['local.set', `$${u}`, asI64(uVal)],
      ['local.set', `$${l}`, asI64(lVal)],
      ['if', ['result', 'i32'], ['i64.eq', uG, lG],
        ['then', ['i32.const', 1]],
        ['else', tail]]], 'i32'))
  }
  // Every fast path above (i32/peeled-int/known-NUMBER/REF_EQ/STRING) agrees bit-
  // for-bit between == and === — coercion never enters them. Only THIS final,
  // fully-dynamic fallback can hit the one case where they diverge: both operands
  // nullish at runtime but different atoms (null vs undefined) — loose treats
  // that equal, strict does not. `strict` (set only by emitStrictEq's delegation
  // below) picks the non-coercing helper.
  inc(strict ? '__eq_strict' : '__eq')
  const call = typed(['call', strict ? '$__eq_strict' : '$__eq', asI64(va), asI64(vb)], 'i32')
  return negate ? typed(['i32.eqz', call], 'i32') : call
}

// True when `node` is a `?:`/`&&`/`||`/`??` join with a structurally-reachable
// BOOL arm — even one whose OVERALL static kind never resolved (VT['||'] etc.
// return null, not NUMBER, when the OTHER arm's kind is itself unprovable,
// e.g. a dead short-circuit branch referencing an unresolved name). Narrower
// than hasAmbiguousBoolMerge's own definition would need to become to catch
// this (that predicate specifically requires the OTHER arm to resolve
// NUMBER — see emitIdentitySafe's doc comment above) — kept as its own
// local, single-purpose check rather than widening the shared kind.js
// predicate every other emission site also gates on.
function mayCarryRawBool(node) {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === '?:') return valTypeOf(node[2]) === VAL.BOOL || valTypeOf(node[3]) === VAL.BOOL ||
    mayCarryRawBool(node[2]) || mayCarryRawBool(node[3])
  if (op === '&&' || op === '||' || op === '??') return valTypeOf(node[1]) === VAL.BOOL || valTypeOf(node[2]) === VAL.BOOL ||
    mayCarryRawBool(node[1]) || mayCarryRawBool(node[2])
  return false
}

function emitStrictEq(a, b, negate) {
  // `typeof x === 'type'` (prepare rewrote the literal to a numeric code) — typeof
  // always yields a string, so strict and loose agree; reuse the loose lowering.
  const tc = emitTypeofCmp(a, b, negate ? 'ne' : 'eq'); if (tc) return tc
  // Strict equality against a `null` or `undefined` literal must match ONLY that
  // exact sentinel — `undefined === null` is false, unlike loose `==`. prepare
  // normalizes both to the value-wrapper form `[, v]` (op==null) where the *strict*
  // value of node[1] is the discriminator (=== null vs === undefined); the loose
  // isNullLit/isUndefLit predicates use `== null` and can't tell them apart, so key
  // off node[1] here — exactly as emit()'s literal value path does. A statically
  // non-nullish operand (known VAL) is neither sentinel, so fold to a constant.
  const sentinelOf = (n) => {
    if (!Array.isArray(n) || n[0] != null) return null
    if (n.length < 2 || n[1] === undefined) return 'undef'
    if (n[1] === null) return 'null'
    return null  // numeric / string literal value — not a nullish sentinel
  }
  const strictSentinel = (other, undef) => {
    if (valTypeOf(other) && !nullableOperand(other)) return effectFoldSeq([other], emitNum(negate ? 1 : 0))
    const chk = (undef ? isUndef : isNull)(asF64(emit(other)))
    return negate ? typed(['i32.eqz', chk], 'i32') : chk
  }
  const sa = sentinelOf(a), sb = sentinelOf(b)
  if (sb) return strictSentinel(a, sb === 'undef')
  if (sa) return strictSentinel(b, sa === 'undef')
  // Ambiguous BOOL-merge operand(s) (.work/todo.md §deletion-sweep):
  // kind.js's collapsed static kind for a `?:`/`&&`/`||`/`??` merge with one
  // BOOL arm and one NUMBER arm is NUMBER (the deliberate benign arithmetic-
  // context coercion) — trusting it here, either for the differing-class fold
  // below (`x===false` folding to compile-time FALSE) or the BOOL-vs-unknown
  // box decision, is exactly the live miscompile this predicate guards: the
  // collapsed kind can't tell a genuine 0/1 from a coerced false/true. Route
  // through emitIdentitySafe (which re-emits the merge with its OWN BOOL arm
  // boxed to its atom, before the raw-bit collapse erases it) and bit-compare
  // directly — sound for EVERY other-side shape (a proven differing STRING/
  // OBJECT/etc. other side can still never equal either of the merge's two
  // possible runtime kinds, so this never loses a real fold, only skips one
  // that was unsound to take).
  if (hasAmbiguousBoolMerge(a) || hasAmbiguousBoolMerge(b)) {
    const va = hasAmbiguousBoolMerge(a) ? emitIdentitySafe(a) : carrierF64(a, emit(a))
    const vb = hasAmbiguousBoolMerge(b) ? emitIdentitySafe(b) : carrierF64(b, emit(b))
    const cmp = typed(['i64.eq', ['i64.reinterpret_f64', va], ['i64.reinterpret_f64', vb]], 'i32')
    return negate ? typed(['i32.eqz', cmp], 'i32') : cmp
  }
  // Known, differing primitive classes can never be strictly equal — but the
  // operands still evaluate, in order (effectFoldSeq).
  const strictA = resolveValType(a, valTypeOf, lookupValType)
  const strictB = resolveValType(b, valTypeOf, lookupValType)
  if (strictA && strictB && strictA !== strictB && (STRICT_PRIM.has(strictA) || STRICT_PRIM.has(strictB)))
    return effectFoldSeq([a, b], emitNum(negate ? 1 : 0))
  // Both sides statically BOOL: compare TRUTH VALUES, not raw bits — a boolean's
  // carrier varies by source (raw 0/1 from locals/comparisons, TRUE/FALSE atom out
  // of slots/hashes/JSON) and truthyIR normalizes both representations.
  if (strictA === VAL.BOOL && strictB === VAL.BOOL) {
    const cmp = typed(['i32.eq', truthyIR(emit(a)), truthyIR(emit(b))], 'i32')
    return negate ? typed(['i32.eqz', cmp], 'i32') : cmp
  }
  // One side statically BOOL, other side dynamic-unknown: strict equality is
  // IDENTITY. An unknown operand carries booleans as their TRUE/FALSE atom
  // (carrierF64 ingress) while numbers are raw — so `1 === true` must be false
  // even though the loose lowering's ToNumber would equate them. Compare bits:
  // the BOOL side boxes to its atom, the unknown side is compared verbatim.
  if ((strictA === VAL.BOOL) !== (strictB === VAL.BOOL) && (strictA == null || strictB == null)) {
    // An "unknown" (null) side isn't always genuinely opaque: `true || x`
    // with `x` unresolved (e.g. dead short-circuit branch on an undeclared
    // name) resolves neither BOOL nor NUMBER, but the arm actually reached at
    // runtime (`true`) is still a raw BOOL that needs its atom — see
    // mayCarryRawBool's own doc comment (audit-#12 BOOL_CARRIER family).
    const va = strictA === VAL.BOOL ? carrierF64(a, emit(a))
      : strictA == null && mayCarryRawBool(a) ? emitIdentitySafeArms(a) : asF64(emit(a))
    const vb = strictB === VAL.BOOL ? carrierF64(b, emit(b))
      : strictB == null && mayCarryRawBool(b) ? emitIdentitySafeArms(b) : asF64(emit(b))
    const cmp = typed(['i64.eq', ['i64.reinterpret_f64', va], ['i64.reinterpret_f64', vb]], 'i32')
    return negate ? typed(['i32.eqz', cmp], 'i32') : cmp
  }
  // Phase-c C3: a plan-TAGGED BigInt union strictly compared against a
  // statically-RAW BigInt operand. The tagged side may hold a PTR.BIGINT box
  // (compare its PAYLOAD) or a non-BigInt member — which can never strictly
  // equal a BigInt, and must NOT be bit-reinterpreted (a subnormal number
  // colliding with the literal's raw i64 pattern would read equal; a box
  // POINTER's bits never match either way, which is how this compare read
  // false pre-fix). Tag-dispatch with a short-circuit: only a real box is
  // ever dereferenced. Both-tagged and every other shape keep the dynamic
  // $__eq_strict fallthrough below.
  {
    // PROVEN-tagged only (three-state discipline, re-audit P0): the plan
    // materialized the operand — every BigInt member of its runtime domain
    // is a real PTR.BIGINT box — or it is a direct call whose callee's
    // return is PROVEN tagged (strict recursion, no open-current fallback).
    // For such an operand a non-box member can NEVER strictly equal a
    // BigInt, so the else-arm is FALSE — comparing its bits against the raw
    // payload equated tagged Number 0 with 0n and MIN_VALUE with 1n (the
    // carrier-collision the tag exists to prevent). OPEN operands (raw
    // BigInt possible, bits ARE the payload) must never take this arm —
    // they keep the dynamic $__eq_strict fallthrough below, whose bits
    // semantics are the documented raw-carrier contract.
    const provenTagged = (n) => isPlanTaggedBigint(n) ||
      (Array.isArray(n) && n[0] === '()' && typeof n[1] === 'string' &&
       ctx.funcs.map?.get(n[1]) != null && representationResultTagRequired(ctx, ctx.funcs.map.get(n[1]), new WeakSet(), true))
    const planA = provenTagged(a), planB = provenTagged(b)
    if (planA !== planB) {
      const rawSide = planA ? b : a
      const rawVt = resolveValType(rawSide, valTypeOf, lookupValType)
      if (rawVt === VAL.BIGINT) {
        // BOTH operands evaluate exactly once, in SOURCE order, before the
        // tag dispatch (re-audit P0: the else-arm must not skip the raw
        // side's effects, and a right-hand tagged operand must not reverse
        // evaluation order).
        const ta = temp('teqa'), tb = temp('teqb')
        inc('__ptr_type')
        const tagT = planA ? ta : tb, rawT = planA ? tb : ta
        const tagGet = typed(['local.get', `$${tagT}`], 'f64')
        const rawGet = typed(['local.get', `$${rawT}`], 'f64')
        const eq = typed(['block', ['result', 'i32'],
          ['local.set', `$${ta}`, asF64(emit(a))],
          ['local.set', `$${tb}`, asF64(emit(b))],
          ['if', ['result', 'i32'],
            ['i32.eq', ['call', '$__ptr_type', ['i64.reinterpret_f64', tagGet]], ['i32.const', PTR.BIGINT]],
            ['then', ['i64.eq', ['i64.load', ptrOffsetIR(tagGet, VAL.BIGINT)], ['i64.reinterpret_f64', rawGet]]],
            ['else', ['i32.const', 0]]]], 'i32')
        return negate ? typed(['i32.eqz', eq], 'i32') : eq
      }
    }
  }
  // Same type (or dynamic-unknown): identical to loose `==`/`!=` EXCEPT the one
  // case loose treats specially (null == undefined) — strict must still tell
  // apart which nullish atom each side is, so this does NOT reuse the `==`/`!=`
  // operator-table entry (that would inherit the loose exception); it calls
  // emitLooseEq directly with strict=true, which routes the fully-dynamic
  // fallback through $__eq_strict instead of $__eq (every other fast path
  // inside emitLooseEq already agrees bit-for-bit with strict semantics).
  return emitLooseEq(a, b, negate, true)
}

/** Comparison op factory with constant folding. */
const cmpOp = (i32op, f64op, fn) => (a, b) => {
  const va = emit(a), vb = emit(b)
  // Skip the const-fold for `.unsigned` operands: `litVal` is the signed bit pattern
  // (-1, not 4294967295), so folding the order would be wrong. Fall through to the
  // f64 widen path below, which converts each operand by its own signedness.
  if (isLit(va) && isLit(vb) && !va.unsigned && !vb.unsigned) return emitNum(fn(litVal(va), litVal(vb)) ? 1 : 0)
  // String compare: NaN-boxed string pointers compare as NaN under f64.lt/gt
  // (always false), so without this the spec-correct `"a" < "b"` returns 0.
  // Route both-STRING operands through __str_cmp's three-way result, then apply
  // the same i32 sign op as numeric (lt_s/gt_s/le_s/ge_s vs 0).
  const vta = numericVal(resolveValType(a, valTypeOf, lookupValType))
  const vtb = numericVal(resolveValType(b, valTypeOf, lookupValType))
  if (vta === VAL.BIGINT || vtb === VAL.BIGINT) {
    // Literal-mixed compare is MATHEMATICAL per spec (BigInt vs Number) — 5n > 3
    // must not compare raw NaN-box bits. Coerce through f64 (exact for literal
    // magnitudes); an unknown counterpart keeps the same-rep i64 contract
    // (kernel carriers' NUMBER is a kind-default, not a proof).
    if ((vta === VAL.BIGINT) !== (vtb === VAL.BIGINT) && numLiteralNode(vta === VAL.BIGINT ? b : a)) {
      const conv = (node, v, isBig) => isBig
        ? typed([bigintUnsignedBound(node) ? 'f64.convert_i64_u' : 'f64.convert_i64_s', readI64(node, v)], 'f64')
        : toNumF64(node, asF64(v))
      return typed([`f64.${f64op}`, conv(a, va, vta === VAL.BIGINT), conv(b, vb, vtb === VAL.BIGINT)], 'i32')
    }
    const op = bigintUnsignedBound(a) || bigintUnsignedBound(b) ? i32op.replace('_s', '_u') : i32op
    return typed([`i64.${op}`, readI64(a, va), readI64(b, vb)], 'i32')
  }
  if (vta === VAL.STRING && vtb === VAL.STRING) {
    return typed([`i32.${i32op}`, stringOps(a).cmp(asF64(va), asF64(vb), ctx), ['i32.const', 0]], 'i32')
  }
  // Exactly one operand is a known string; the other has no static type, so it
  // may hold a string pointer at runtime (e.g. `c >= '0'` where `c` came from
  // `s[i]` on an untyped receiver). JS relational compare is lexicographic only
  // when *both* sides are strings, else it ToNumbers both. The f64 path below
  // would compare the unknown side's NaN-boxed string bits as a float (NaN ⇒
  // always false), so dispatch at runtime on the unknown side: string → __str_cmp
  // three-way; else ToNumber both. Mirrors `+`'s __is_str_key string dispatch.
  // Gated on a *known-string* counterpart, so numeric loops (`i < n`) never pay
  // the check — comparing against a string literal signals string intent.
  if (((vta === VAL.STRING && vtb == null) || (vtb === VAL.STRING && vta == null)) && stringOps(a)?.cmp) {
    const unkIsA = vta == null
    const ta = temp('cmp'), tb = temp('cmp')
    inc('__is_str_key')
    const getA = typed(['local.get', `$${ta}`], 'f64'), getB = typed(['local.get', `$${tb}`], 'f64')
    const check = ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.get', `$${unkIsA ? ta : tb}`]]]
    const strCmp = [`i32.${i32op}`, stringOps(a).cmp(getA, getB, ctx), ['i32.const', 0]]
    const numCmp = [`f64.${f64op}`, toNumF64(a, getA), toNumF64(b, getB)]
    return typed(['block', ['result', 'i32'],
      ['local.set', `$${ta}`, asF64(va)],
      ['local.set', `$${tb}`, asF64(vb)],
      ['if', ['result', 'i32'], check, ['then', strCmp], ['else', numCmp]]], 'i32')
  }
  if (vta === VAL.DATE || vtb === VAL.DATE) {
    const dateNum = (node, v, vt) => {
      if (vt !== VAL.DATE) return toNumF64(node, v)
      const ptr = v.ptrKind === VAL.DATE
        ? v
        : ['i32.wrap_i64', ['i64.reinterpret_f64', asF64(v)]]
      return typed(['f64.load', ptr], 'f64')
    }
    return typed([`f64.${f64op}`, dateNum(a, va, vta), dateNum(b, vb, vtb)], 'i32')
  }
  if (vtb === VAL.NUMBER && needsToNumberCoercion(a, vta))
    return typed([`f64.${f64op}`, toNumF64(a, va), asF64(vb)], 'i32')
  if (vta === VAL.NUMBER && needsToNumberCoercion(b, vtb))
    return typed([`f64.${f64op}`, asF64(va), toNumF64(b, vb)], 'i32')
  // An `.unsigned` i32 operand ([0, 2^32)) can't share a signed i32 compare with a
  // possibly-signed one: mixed sign inverts the order (3 < 0xFFFFFFFF unsigned, but
  // 3 > -1 signed). Widen to f64, where asF64 converts each operand by its own
  // signedness (convert_i32_u for unsigned, _s otherwise) to its true numeric value.
  if (!va.unsigned && !vb.unsigned) {
    const ai = intConstValue(a), bi = intConstValue(b)
    if (va.type === 'i32' && bi != null) return typed([`i32.${i32op}`, va, ['i32.const', bi]], 'i32')
    if (vb.type === 'i32' && ai != null) return typed([`i32.${i32op}`, ['i32.const', ai], vb], 'i32')
    if (va.type === 'i32' && vb.type === 'i32') return typed([`i32.${i32op}`, va, vb], 'i32')
  }
  // BOTH operands runtime-unknown boxed carriers: two strings must compare
  // lexicographically (the raw f64 compare below reads their NaN-boxed
  // pointers as NaN — always false; this silently broke watr-in-kernel's
  // hex-string i64 comparisons, folding `i64.lt_s(-1, 0)` to 0 and with it
  // the -1n<0n row and the shaped-parser family). Same runtime dispatch as
  // the one-known-string branch above, gated to non-i32 boxed operands so
  // narrowed numeric compares never pay it: both strings → __str_cmp
  // three-way; anything else → ToNumber compare (ES 7.2.13).
  if (vta == null && vtb == null && va.type !== 'i32' && vb.type !== 'i32' && ctx.module.modules.string && stringOps(a)?.cmp) {
    const ta = temp('cmp'), tb = temp('cmp')
    inc('__is_str_key')
    const getA = typed(['local.get', `$${ta}`], 'f64'), getB = typed(['local.get', `$${tb}`], 'f64')
    // FAST PATH first — two inline non-NaN tests, no calls: every NaN-boxed
    // carrier (strings included) is a NaN, so both-non-NaN ⇒ genuine numbers ⇒
    // plain f64 compare. Only NaN-ish operands (boxed values, real NaN) pay
    // the is_str_key calls; the kernel's own hot compares are overwhelmingly
    // numbers, and the call-based form alone cost ~4% warm self-compile.
    const bothNum = ['i32.and',
      ['f64.eq', ['local.get', `$${ta}`], ['local.get', `$${ta}`]],
      ['f64.eq', ['local.get', `$${tb}`], ['local.get', `$${tb}`]]]
    const bothStr = ['i32.and',
      ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.get', `$${ta}`]]],
      ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.get', `$${tb}`]]]]
    const strCmp = [`i32.${i32op}`, stringOps(a).cmp(getA, getB, ctx), ['i32.const', 0]]
    const numCmp = [`f64.${f64op}`, toNumF64(a, getA), toNumF64(b, getB)]
    return typed(['block', ['result', 'i32'],
      ['local.set', `$${ta}`, asF64(va)],
      ['local.set', `$${tb}`, asF64(vb)],
      ['if', ['result', 'i32'], bothNum,
        ['then', [`f64.${f64op}`, ['local.get', `$${ta}`], ['local.get', `$${tb}`]]],
        ['else', ['if', ['result', 'i32'], bothStr, ['then', strCmp], ['else', numCmp]]]]], 'i32')
  }
  return typed([`f64.${f64op}`, asF64(va), asF64(vb)], 'i32')
}

/** Both relational (`<` `>=` …) and loose `==`/`!=` need ToNumber on the
 *  unknown side iff it's known-string or might dereference a boxed value. */
function needsToNumberCoercion(expr, vt) {
  if (vt === VAL.STRING) return true
  if (vt != null) return false
  return mayReadBoxedValue(expr)
}

function looseNumberEq(numIR, otherNode, otherIR, negate = false) {
  const t = temp('eq')
  const other = typed(['local.get', `$${t}`], 'f64')
  const cmp = ['f64.eq', asF64(numIR), toNumF64(otherNode, other)]
  return typed(['block', ['result', 'i32'],
    ['local.set', `$${t}`, asF64(otherIR)],
    ['if', ['result', 'i32'], isNullish(other),
      ['then', ['i32.const', negate ? 1 : 0]],
      ['else', negate ? ['i32.eqz', cmp] : cmp]]], 'i32')
}

function mayReadBoxedValue(expr) {
  return Array.isArray(expr) && (expr[0] === '.' || expr[0] === '[]' || expr[0] === '?.' || expr[0] === '?.[]')
}

function intConstValue(expr) {
  if (typeof expr === 'number' && Number.isInteger(expr)) return expr
  if (Array.isArray(expr) && expr[0] == null && typeof expr[1] === 'number' && Number.isInteger(expr[1])) return expr[1]
  if (typeof expr === 'string') {
    const v = repOf(expr)?.intConst
    if (v != null) return v
  }
  return null
}

function bigintUnsignedBound(expr) {
  // Self-describing literal carries the unsigned-64 decimal (`BigInt.asUintN(64,…)`,
  // so 1–20 digits, always ≤ 2^64-1). Detect the high-unsigned range (> 2^63-1) by
  // decimal magnitude — the kernel can't parse large decimals back to BigInt.
  if (Array.isArray(expr) && expr[0] === 'bigint') {
    const s = expr[1]
    return s.length > 19 || (s.length === 19 && s > '9223372036854775807')
  }
  const n = bigintConstValue(expr)
  return n != null && n > 0x7fffffffffffffffn && n <= 0xffffffffffffffffn
}

function bigintConstValue(expr) {
  if (typeof expr === 'bigint') return expr
  if (!Array.isArray(expr)) return null
  if (expr[0] == null && typeof expr[1] === 'bigint') return expr[1]
  if (expr[0] === 'u-') {
    const n = bigintConstValue(expr[1])
    return n == null ? null : -n
  }
  return null
}

/** Compound assignment: read → op → write back (via readVar/writeVar).
 *  `arithOp` (one of '+' '-' '*' '/' '%') is the base symbol for BigInt routing;
 *  omit it for ops that only exist elsewhere for BigInt (this fn is never called
 *  for '&='/etc — those have their own i64 gate right below in the dispatch table). */
function compoundAssign(name, val, f64op, i32op, arithOp) {
  if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
  const void_ = ctx.func._expect === 'void'
  // BigInt target/operand: route through the SAME i64 arithmetic the spelled-out
  // binary form uses (asI64 both sides, i64.<op>, fromI64) — see e.g. binary '+'
  // below (asI64(emit(a)), i64.add, fromI64). The f64 path further down silently
  // rounds away magnitude ≥ 2^53 for a proven-BIGINT accumulator: `n += 1n` on a
  // large n was a no-op (f64.add(n, 1) == n once n exceeds f64's integer precision).
  // bigintMixReject keeps the same TypeError-on-provable-mix contract the binary
  // op enforces (`n += 1` on a BigInt n throws in JS, not silently masks to 0).
  if (arithOp && (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT)) {
    bigintMixReject(`${arithOp}=`, name, val)
    // `name` is always a bare identifier here — censusMaybeUndefined never fires
    // true for it (that predicate only matches `.`/`[]`/`.get()` AST shapes), so
    // readVar(name) stays the plain raw path; only `val` (the RHS, which CAN be a
    // dict/Map maybeUndefined read) needs bigIntOperand's runtime guard.
    const rawBits = [`i64.${I64_ARITH_OP[arithOp]}`, readI64(name, readVar(name)), bigIntOperand(val)]
    // Shape #6 emission companion: this op always computes a FRESH raw i64
    // result (readI64 unboxed the input, i64.<op> ran) — when `name` is
    // plan-materialized BOXED, that raw result must be boxed before it lands
    // back in name's storage slot, or the next plan-aware read (readI64's
    // own isPlanTaggedBigint arm) misreads its raw i64 bits as a box
    // pointer. representationBindingWriteAction can't be reused here: it
    // keys off the AST node collectDefs recorded as this def's rhs (the
    // whole compound node), which this handler never receives — only
    // `name`/`val`. representationCompoundAssignAction is the name-keyed
    // twin (source is always RAW_BIGINT here, by construction — so the
    // action is only ever KEEP/BOX/REJECT, never UNBOX; applied directly
    // rather than through applyBigintRepresentationAction's valTypeOf(node)
    // gate, which would wrongly veto on a proven-bigint LITERAL operand
    // paired with a not-yet-proven `name`, per bigintMixReject's own
    // asymmetric OR guard just above).
    return writeVar(name,
      representationCompoundAssignAction(ctx, name) === REP_EDGE_BOX ? boxBigInt(rawBits) : fromI64(rawBits),
      void_)
  }
  const va = readVar(name), vb = emit(val)
  // Peel f64.convert_i32_s/u when va is i32 — typed-array integer reads wrap their
  // i32.load in convert_i32_* by default, but the i32 arithmetic path can use the
  // raw i32 directly (eliminates per-iter widen + saturating-trunc roundtrip on
  // hot accumulator loops like `let s = 0; for (...) s += i32arr[i]`).
  let vbi = vb
  if (i32op && va.type === 'i32' && vb.type !== 'i32' &&
      Array.isArray(vb) && (vb[0] === 'f64.convert_i32_s' || vb[0] === 'f64.convert_i32_u')) {
    const inner = vb[1]
    vbi = Array.isArray(inner) ? typed(inner, 'i32') : inner
  }
  // INVARIANT: this admission needs the magnitude gate —
  // worse than the old (already-unsound) mulFitsI32, which needed at least one
  // bound. `name op= val` desugars to the exact binary-op arithmetic below, so
  // it must pass the SAME bilateral-bound proof the binary `+`/`-`/`*` operators
  // now require (addFitsI32/mulFitsI32 + their typed-magnitude/AST-range twins,
  // reused verbatim — no second bound tracker). Matters when this compound-
  // assign's OWN result crosses to a DIFFERENT (non-i32) consumer as a VALUE
  // (`y = (x *= huge)` with y f64-typed) — an unfaithfully-wrapped i32 result
  // would be trusted at THAT boundary the same way a bare `return` trusts one
  // (fixed alongside this at narrowI32Results, narrow.js). Value-neutral for
  // the common "write straight back into x's own i32 storage" case either way
  // (ir.js `writeVar` now coerces via `toI32`, which recovers the identical
  // wrapped result through narrowI32 when this gate falls to the f64 arm).
  // `%`/bitwise compounds reach here with no arithOp or an inherently-sound
  // op, so they stay ungated.
  const compoundFitsI32 = arithOp === '*' ? (mulFitsI32(va, vbi) || mulBoundedFaithful(va, vbi) || mulRangeFitsI32(name, val))
    : arithOp === '+' ? (addFitsI32(va, vbi) || addBoundedFaithful(va, vbi) || addRangeFitsI32(name, val))
    : arithOp === '-' ? (addFitsI32(va, vbi) || addBoundedFaithful(va, vbi) || subRangeFitsI32(name, val))
    : true
  if (i32op && va.type === 'i32' && vbi.type === 'i32' && compoundFitsI32)
    return writeVar(name, i32op(va, vbi), void_)
  // Both operands coerce like '+' operands: toNumF64 folds a checked read's
  // UNDEF miss arm to canonical NaN and ToNumber-coerces non-numeric carriers,
  // while proven-NUMBER values pass through unchanged (asF64 identity — hot
  // accumulators pay nothing). A bare asF64 carries a sentinel payload through
  // f64 arithmetic to the boundary (decoded back as `undefined`; JS: NaN) —
  // `s += a[i]` and `let u; s += u` are accumulator shapes the binary '+'
  // emitter never sees.
  return writeVar(name, f64op(asF64(toNumF64(name, va)), asF64(toNumF64(val, vb))), void_)
}

// Element ctors whose spec [[Set]] numeric conversion is a MODULAR reduction
// (ECMA-262 IntegerIndexedElementSet's element-type conversion table: ToInt8/
// ToUint8/ToInt16/ToUint16/ToInt32/ToUint32 — every one is `mod 2^n`, matching
// wasm's iN.store8/16/32 truncation bit-for-bit). Uint8ClampedArray is
// deliberately excluded: ToUint8Clamp SATURATES (300 → 255), it does not wrap
// (300 mod 256 = 44) — the truncation-equals-wraparound argument this set
// exists for does not hold for it. Float32Array/Float64Array store ToNumber
// verbatim (no integer conversion at all) and BigInt64Array/BigUint64Array
// route through the i64 arm above this set's only call site — neither belongs
// here either.
const WRAP_TRUNCATING_TYPED_CTORS = new Set([
  'Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
])

// Bare-name typed-array ctor resolution — the SAME multi-source chain
// resolveElem (module/typedarray.js) and this file's own '.length'/typed-
// dispatch sites (e.g. line ~3992) already read for a receiver NAME: a
// per-function narrowing overlay first, then the whole-function map, then
// the module-global map (a param/alias only ever resolves through the
// latter two — `repOf(name)?.typedCtor`, used by the `instanceof` fold
// above, is a narrower fact that misses params/aliases entirely). Returns
// true iff the receiver is PROVEN a wrap-truncating (non-float, non-
// clamped, non-BigInt) typed-array element kind.
function wrapTruncatingTypedElemName(name) {
  const info = plannedTypedStorageInfo(ctx, name)
  return info != null && WRAP_TRUNCATING_TYPED_CTORS.has(info.name)
}

// === Core emitter dispatch table ===
// ctx.core.emit is seeded with a flat copy of this object on reset;
// language modules add or override ops on ctx.core.emit directly.

/**
 * Core emitter table. Maps AST ops to WASM IR generators.
 * @type {Record<string, (...args: any[]) => Array>}
 */
export const emitter = {
  // === Spread operator ===
  // Note: spread is handled specially in call contexts; this catches stray uses
  '...': () => err('Spread (...) can only be used in function/method calls or array literals'),

  // === Statements ===

  ';': (...args) => {
    const out = []
    for (const a of args) {
      out.push(...emitVoid(a))
      // Same dead-tail truncation as emitBlockBody's own statement loop (see
      // that function's comment for the full rationale) — needed HERE too,
      // separately: a `;`-list can arrive at emit already NESTED one level
      // inside a `{}`-block's own list (e.g. jzify's `do…while` desugaring —
      // transform.js `'do'` — wraps the loop body as `[';', flagReset,
      // userBody]`, so a user body of `break; FOR1;` lands as ONE list item,
      // `[';', ['break'], 'FOR1']`, from emitBlockBody's OUTER loop — that
      // loop's own isTerminator check sees only the LAST inner statement
      // (FOR1, not a terminator) and never looks inside). Without this, a
      // bare `break`/`continue`/`return`/`throw` mid-list here left its
      // FOLLOWING dead siblings walked anyway, wrongly hitting the bare-
      // identifier-fallback reject (src/compile/emit.js) for code real JS
      // never evaluates (confirmed live via test262 statements/break+continue/
      // line-terminators.js's ASI-split shape, a do…while body).
      if (isTerminator(a)) break
    }
    return out
  },
  '{': (...args) => args.map(emit).filter(x => x != null),
  ',': (...args) => {
    const results = args.map(emit).filter(x => x != null)
    if (results.length === 0) return null
    if (results.length === 1) return results[0]
    const last = results[results.length - 1]
    // Flatten: multi-instruction arrays (from ';') need spreading, typed nodes need drop
    const spread = r => Array.isArray(r) && Array.isArray(r[0]) ? r : [r]
    const dropSpread = r => r.type ? [['drop', r]] : spread(r)
    // If last expression is void (store, etc.), add explicit return value
    if (!last.type) {
      return block64(
        ...results.flatMap(dropSpread),
        ['f64.const', 0])
    }
    const seq = typed(['block', ['result', last.type],
      ...results.slice(0, -1).flatMap(dropSpread), last], last.type)
    // The sequence's VALUE is `last` — carry its value metadata, or downstream
    // coercions misread the carrier: an i32 OBJECT/CLOSURE pointer without its
    // ptrKind gets f64.convert_i32_s'd (`return (fn.a = 1, fn)` returned the raw
    // heap offset as a number). Same bug-class as the ternary's tagPtr (below).
    if (last.ptrKind != null) { seq.ptrKind = last.ptrKind; if (last.ptrAux != null) seq.ptrAux = last.ptrAux }
    if (last.unsigned) seq.unsigned = last.unsigned
    return seq
  },
  'let': emitDecl,
  'const': emitDecl,
  'export': () => null,
  // 'block' can appear from jzify transforming labeled blocks or as WASM block IR
  'block': (...args) => {
    // WASM block IR: first arg is ['result', type] → pass through, preserve type
    if (Array.isArray(args[0]) && args[0][0] === 'result')
      return typed(['block', ...args], args[0][1])
    const inner = args.length === 1 ? args[0] : [';', ...args]
    return emitVoid(['{}', inner])
  },

  'throw': expr => {
    ctx.runtime.throws = ctx.runtime.userThrows = true
    const thrown = temp()
    // The exception payload is an untyped ANY slot — exactly the boxed-value
    // contract storedValue exists for (container stores, collection keys/
    // values, generic call args; see its own doc comment above). A plain
    // `asF64(emit(expr))` was the 18th unnamed site of the MECHANISM A gap
    // bridge.js's storedValue doc comment describes: a bare Boolean thrown
    // value (`throw true`) emits as a raw i32 0/1 then f64-converts to a
    // plain 0.0/1.0 float — bit-identical to a genuinely thrown 0/1 number —
    // so `catch (e) { e === true }` reads false and `typeof e` reads
    // 'number', both wrong per ES 12.13 (audit-#12, BOOL_CARRIER family).
    // storedValue also correctly boxes an AMBIGUOUS BOOL∪NUMBER throw
    // (`throw cond && 1`) via emitIdentitySafe, and leaves every other kind
    // (number/string/object/BigInt) byte-identical to the old asF64(emit()).
    return typed(['block',
      ['local.set', `$${thrown}`, storedValue(expr)],
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${thrown}`]]],
      ['throw', '$__jz_err', ['local.get', `$${thrown}`]]], 'void')
  },

  'catch': (body, errName, handler) => {
    if (!canThrow(body)) return emitVoid(body)

    ctx.runtime.throws = ctx.runtime.userThrows = true
    const id = freshId(ctx)
    ctx.func.locals.set(errName, 'f64')
    const bodyIR = withTryState(true, () => emitVoid(body))
    const handlerIR = emitVoid(handler)
    return typed(['block', `$outer${id}`, ['result', 'f64'],
      ['block', `$catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$catch${id}`],
          ...bodyIR],
        ['f64.const', 0],
        ['br', `$outer${id}`]],
      ['local.set', `$${errName}`],
      // This catch fully HANDLES the error — nothing downstream
      // rethrows it — so $__jz_last_err_bits must not keep pointing at it. Left
      // set, a LATER genuine trap (OOB, stack overflow, …) unrelated to this
      // catch would read this stale marker at the host boundary and misdecode
      // as the already-handled error instead of a RuntimeError (interop.js's
      // decodeThrown only resets the marker on a decode that reaches the host —
      // an error fully handled in-wasm never does). Zeroed here, BEFORE the
      // handler runs, mirroring decodeThrown's own "consume on every decode"
      // reset — a `throw` inside the handler (rethrow or a new error) sets the
      // marker again via the 'throw' emitter above, so escaping-throw decode is
      // unaffected.
      ['global.set', '$__jz_last_err_bits', ['i64.const', 0]],
      ...handlerIR,
      ['f64.const', 0]], 'f64')
  },

  'finally': (body, cleanup) => {
    if (!canThrow(body)) {
      const parentStack = ctx.func.finallyStack || []
      const activeStack = parentStack.concat([{ cleanup, depth: ctx.func.stack.length }])
      const bodyIR = withFinallyStack(activeStack, () => emitVoid(body))
      const cleanupIR = isTerminator(body) ? [] : withFinallyStack(parentStack, () => emitVoid(cleanup))
      return [...bodyIR, ...cleanupIR]
    }

    ctx.runtime.throws = ctx.runtime.userThrows = true
    const id = freshId(ctx)
    const errLocal = temp('err')
    const parentStack = ctx.func.finallyStack || []
    const activeStack = parentStack.concat([{ cleanup, depth: ctx.func.stack.length }])

    const bodyIR = withTryState(true, () => withFinallyStack(activeStack, () => emitVoid(body)))
    const normalCleanup = withFinallyStack(parentStack, () => emitVoid(cleanup))
    const throwCleanup = withFinallyStack(parentStack, () => emitVoid(cleanup))

    return ['block', `$fin_done${id}`,
      ['block', `$fin_catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$fin_catch${id}`],
          ...bodyIR],
        ...normalCleanup,
        ['br', `$fin_done${id}`]],
      ['local.set', `$${errLocal}`],
      // Mirrors 'catch' above: zero BEFORE throwCleanup runs, not
      // after. Two outcomes, both correct: (1) throwCleanup falls through
      // normally → the rethrow below unconditionally re-sets the marker to
      // errLocal's real bits before throwing, so escaping-throw decode is
      // unaffected. (2) throwCleanup itself terminates early (a `return`/`break`
      // in the `finally` block, which per spec SWALLOWS the pending exception —
      // the rethrow below is then dead code, never reached) → the marker stays
      // zeroed instead of dangling at the now-suppressed error's stale value,
      // so a later genuine trap in this instance decodes as RuntimeError, not
      // the swallowed error.
      ['global.set', '$__jz_last_err_bits', ['i64.const', 0]],
      ...throwCleanup,
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${errLocal}`]]],
      ['throw', '$__jz_err', ['local.get', `$${errLocal}`]]]
  },

  'return': expr => {
    const finalizers = emitFinalizers()
    const finalizerBlock = () => [['block', ...finalizers]]
    if (ctx.func.current?.results.length > 1 && Array.isArray(expr) && expr[0] === '[') {
      const vals = expr.slice(1).map(e => asF64(emit(e)))
      if (finalizers.length === 0) return typed(['return', ...vals], 'void')
      const names = vals.map(() => temp('ret'))
      return [
        ...vals.map((v, i) => ['local.set', `$${names[i]}`, v]),
        ...finalizerBlock(),
        typed(['return', ...names.map(n => ['local.get', `$${n}`])], 'void'),
      ]
    }
    // A value-less `return;` yields `undefined` per spec (not null). The function
    // result is never i32-narrowed when a bare return is present (see hasBareReturn
    // guard in narrowI32Results), so the f64 UNDEF carrier is type-compatible.
    if (expr == null) return [...finalizers, typed(['return', undefExpr()], 'void')]
    const rt = ctx.func.current?.results[0] || 'f64'
    const pk = ctx.func.current?.ptrKind
    // Emit ONCE, before branching on pk — self-compile miscompile: the equivalent inline
    // form `pk != null ? asPtrOffset(emit(expr), pk) : asParamType(emit(expr), rt)`
    // (emit(expr) repeated once per ternary arm, only one ever executing) is behaviorally
    // identical in JS but the self-compiled kernel drops the f64.convert_i32_s/u rebox on
    // the taken arm's result — an i32-typed return tail comes back bare (unconverted) in
    // a non-narrowed (f64-result) function, so the wasm validator sees "expected f64, got
    // i32" at every return site shaped like `return (expr)|0` inside a function whose
    // result the narrower left at f64 (e.g. blocked by an unrelated same-name shadow
    // elsewhere — narrowI32Results itself is unaffected either way). compile/index.js's
    // sibling call site (`const ir = emit(body); … ptrKind != null ? asPtrOffset(ir, …) :
    // asParamType(ir, …)`) already used this materialize-then-branch shape and was never
    // affected — mirroring it here is both the fix and the more idiomatic form (DRY: one
    // emit call instead of a copy per arm). Root cause not fully localized beyond "the
    // self-compiled kernel, at every optimize level 0-2, treats a value produced by a call
    // repeated textually across both arms of a ternary differently from one materialized
    // to a local first" — pinned in test/parser-bugs.js rather than chased further into
    // the kernel's own call/branch codegen. See .work/todo.md (groundtruth archive).
    // Closure-convention bodies return into a boxed-value position (the ftN f64
    // slot): a BOOL value must cross as its true/false atom — the result-side
    // mirror of closure.call's carrierF64 args. Raw funcs keep the plain 0/1
    // ONLY when the function's return kind is proven uniformly BOOL, OR when
    // there's just one return statement at all (see ctx.func.mixedAtomReturn,
    // set in index.js emitFunc — its comment has the full "why >=2 returns"
    // rationale, including the Set/Map single-return regression a coarser
    // `valResult !== VAL.BOOL` gate caused; also documents the ADDITIVE
    // single-return admission when the lone return is an ambiguous BOOL-merge).
    // A genuinely mixed func (>= 2 return statements, not provably uniform
    // BOOL, or a single ambiguous-merge return) must box a statically-BOOL
    // return tail here: an unproven-kind call result is exactly the
    // "dynamic/unknown" operand the rest of the compiler already assumes
    // carries booleans as their atom (emitStrictEq's BOOL-vs-unknown branch,
    // '+'​'s atom-aware numSide, __to_num) — leaving it raw silently crossed
    // `return false` as the plain float 0, indistinguishable from a real 0 at
    // the call site (audit #5 item 2, ledger "KERNEL LEG ZERO FAILS" —
    // boolconst). carrierF64 is a no-op (byte-identical to asParamType/asF64)
    // whenever this return's own static valType isn't BOOL, so uniform-NUMBER
    // (or any non-bool-mixed) funcs are untouched.
    //
    // An ambiguous BOOL-merge return (`s => cond ? 1 : false`,
    // .work/todo.md §deletion-sweep) needs the SAME box but carrierF64
    // is post-hoc powerless for it: `expr`'s own valTypeOf collapses to NUMBER
    // (the merge's benign coercion), so carrierF64 never recognizes it as
    // BOOL-carrying — by the time `emitted` exists, the coerced false and a
    // genuine 0 are already the same bits. emitIdentitySafe re-emits the merge
    // with its own BOOL arm boxed to its atom BEFORE that collapse, so it must
    // replace `emit(expr)` itself here (not wrap its result) — single emission
    // preserved (still exactly one of emit/emitIdentitySafe runs).
    const boxes = pk == null && rt === 'f64' && (ctx.func.boxedResult || ctx.func.mixedAtomReturn)
    const resultBool = pk == null && rt === 'i32' && ctx.func.valResult === VAL.BOOL
    const ambiguous = boxes && hasAmbiguousBoolMerge(expr)
    // A proven boolean i32 result needs truthiness conversion. ToInt32 on an
    // opaque f64 boolean carrier turns every NaN-boxed true/false atom into 0.
    // Select the boolean emitter up front so expr is still evaluated once.
    let emitted = resultBool ? toBool(expr) : ambiguous ? emitIdentitySafe(expr) : emit(expr)
    if (!resultBool)
      emitted = applyBigintRepresentationAction(emitted, expr, representationReturnAction(ctx, expr))
    // Slice 2 (CARRIER PROGRAM, .work/carrier-representation-design.md §7)
    // return def-side wiring — carrierF64Narrow (ir.js), NOT the plain
    // carrierF64 `boxes` used pre-Slice-2: see its own doc comment for why an
    // unconditional inline-BIGINT box is wrong at ANY return position (a
    // uniform function OR a closure/mixed-atom-return one) — it only fires
    // for a bare name independently proven boxed by some OTHER sink in this
    // same body (a dict store earlier, a closure capture, …), the one case
    // where re-using the decision here introduces no NEW ambiguity a caller
    // wasn't already going to see. `ctx.func.boxedResult`/`mixedAtomReturn`
    // (`boxes`) keep their PRE-Slice-2 BOOL-atom-boxing behavior verbatim —
    // carrierF64Narrow's BOOL branch is carrierF64's, untouched.
    //
    // `!ctx.func.exported` gates only the plain (non-`boxes`) path: even the
    // bare-name-proven case must skip a proven-BIGINT export's own
    // unambiguous i64 ABI (Bug 1, synthesizeBoundaryWrappers — see below).
    // Not needed on the `boxes` path: `ctx.func.boxedResult` never applies to
    // a top-level export (closures aren't exports), and `mixedAtomReturn` on
    // an exported function means the export's OWN return type isn't a proven
    // uniform BIGINT (mixedAtomReturn's condition is `valResult !== VAL.BOOL`
    // regardless of what it IS, but a proven-uniform-BIGINT export would take
    // the OTHER, `needsBox`-shaped ABI instead) — so its wrapper already takes
    // the dynamic/tagged result ABI a box is correct for.
    const ir = resultBool ? emitted
      : pk != null ? asPtrOffset(emitted, pk)
      : boxes ? (ambiguous ? emitted : carrierF64Narrow(expr, emitted, 'return'))
      : asParamType(emitted, rt)
    const ty = pk != null ? 'i32' : rt
    const tcoed = tcoTailRewrite(ir, ty)
    if (Array.isArray(tcoed) && tcoed[0] === 'return_call' && finalizers.length === 0) {
      return typed(tcoed, 'void')
    }
    if (finalizers.length > 0) {
      const name = ty === 'i32' ? tempI32('ret') : ty === 'i64' ? tempI64('ret') : temp('ret')
      return [
        ['local.set', `$${name}`, tcoed],
        ...finalizerBlock(),
        typed(['return', ['local.get', `$${name}`]], 'void'),
      ]
    }
    return typed(['return', tcoed], 'void')
  },

  // === Assignment ===

  '=': (name, val) => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
    if (Array.isArray(name) && name[0] === '[]') return emitElementAssign(name[1], name[2], val)
    if (Array.isArray(name) && name[0] === '.')  return emitPropertyAssign(name[1], name[2], val)
    if (typeof name !== 'string') err(`Assignment to non-variable: ${JSON.stringify(name)} — jz assigns to a plain variable, obj.prop, or arr[i] only`)
    // Plain reassignment (`x = …`, `name` already bound) reaches a DIFFERENT
    // emitter than a decl-with-init (emitDecl above) — the ambiguous-identity
    // REJECT lived only on the decl path, so `let x; x = false ?? 1` (and any
    // later `typeof x`/`x === false`) skipped it entirely and silently kept
    // the collapsed raw-NUMBER carrier (audit-#12 BOOL_CARRIER family). Same
    // helper, same contract: rejects only when SOME use of `name` actually
    // observes its identity — a truthiness-only reassignment still compiles.
    rejectAmbiguousBoolIdentity(name, val)
    if (isNullishLit(val)) ctx.func.maybeNullish?.add(name)   // null-flow: later arithmetic on this var coerces
    const void_ = ctx.func._expect === 'void'
    if (Array.isArray(val) && val[0] === 'u+' && val[1] === name) {
      inc('__to_num')
      return writeVar(name, typed(['call', '$__to_num', asI64(emit(name))], 'f64'), void_)
    }
    // Self-accumulation `x = x + …` (incl. desugared `x += …`): the new value REPLACES x, so x's
    // old buffer is dead — the one context where a string concat may bump-EXTEND it in place. The
    // `+` handler reads this flag for its immediate concat; nested operands clear it (not the target).
    const selfAccum = Array.isArray(val) && val[0] === '+' && val[1] === name
    // Compiler-synthesized decl-destructure array-literal temp (prepare/index.js
    // prepDecl, ctx.schema.arrayVars — kind.js's own doc comment on that map:
    // "tmp is a compiler-synthesized, single-write, non-escaping carrier that
    // only this destructure's own generated reads ever touch"). `tmp = […]`'s
    // own elements never cross the host boundary and are never read via a
    // registry-aware dynamic dispatch — module/array.js's array-literal
    // emitter reads this flag to admit storedValueNarrow unconditionally
    // (dropping its default per-element-uniformity gate, which a mixed-type
    // destructure source like `let [a, b] = [1, BigInt(v)]` fails even though
    // no reader here is ever dynamic). See carrierF64Narrow's own doc comment
    // (ir.js) for the established pattern this mirrors.
    const neverEscapes = Array.isArray(val) && val[0] === '[' && ctx.schema.arrayVars?.has(name)
      ? true : ctx.func._arrayLiteralNeverEscapes
    let ev = withFunctionFields({
      _selfAccumConcat: selfAccum ? name : null,
      _arrayLiteralNeverEscapes: neverEscapes,
    }, () => emit(val))
    const repAction = representationBindingWriteAction(ctx, name, val)
    ev = applyBigintRepresentationAction(ev, val, repAction)
    return writeVar(name, ev, void_)
  },

  // Compound assignments: read-modify-write with type coercion
  '+=': (name, val) => {
    // Complex LHS (obj.prop, arr[i]) → desugar to side-effect-safe `name = name + val`
    if (typeof name !== 'string') return emit(['=', name, ['+', name, val]])
    // String concatenation: desugar to name = name + val (+ handler knows about strings).
    // Also desugar when either side has unknown type — the `+` operator picks runtime
    // string/numeric dispatch (`__is_str_key`); compoundAssign would force f64.add and
    // silently corrupt string concatenations through unknown-typed values.
    const vt = typeof name === 'string' ? valTypeOf(name) : null
    const vtB = valTypeOf(val)
    if (vt === VAL.STRING || vtB === VAL.STRING) return emit(['=', name, ['+', name, val]])
    if ((vt == null || vtB == null) && ctx.core.stdlib['__str_concat']) return emit(['=', name, ['+', name, val]])
    return compoundAssign(name, val, (a, b) => typed(['f64.add', a, b], 'f64'), (a, b) => typed(['i32.add', a, b], 'i32'), '+')
  },
  ...Object.fromEntries([
    ['-=', 'sub'], ['*=', 'mul'], ['/=', 'div'],
  ].map(([op, fn]) => [op, (name, val) => {
    const sym = op.slice(0, -1)
    if (typeof name !== 'string') return emit(['=', name, [sym, name, val]])
    return compoundAssign(name, val,
      (a, b) => typed([`f64.${fn}`, a, b], 'f64'),
      fn === 'div' ? null : (a, b) => typed([`i32.${fn}`, a, b], 'i32'),
      sym
    )
  }])),
  '%=': (name, val) => {
    if (typeof name !== 'string') return emit(['=', name, ['%', name, val]])
    return compoundAssign(name, val, f64rem, (a, b) => typed(['i32.rem_s', a, b], 'i32'), '%')
  },
  // `**` is always f64 (and has its own const-exponent lowering) — full desugar.
  '**=': (name, val) => emit(['=', name, ['**', name, val]]),

  // Bitwise compound assignments: i32 normally, i64 when either operand is BigInt
  ...Object.fromEntries([
    ['&=', 'and'], ['|=', 'or'], ['^=', 'xor'],
    ['>>=', 'shr_s'], ['<<=', 'shl'], ['>>>=', 'shr_u'],
  ].map(([op, fn]) => [op, (name, val) => {
    const sym = op.slice(0, -1)
    if (typeof name !== 'string') return emit(['=', name, [sym, name, val]])
    if (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT) {
      // `>>>=` has no BigInt arm at all (see the binary '>>>' handler above) —
      // unlike the other bitwise compounds, which fall to i64.<op>, this one
      // must throw unconditionally rather than take fn='shr_u' on i64 bits.
      if (fn === 'shr_u') err('BigInt has no unsigned right shift (>>>) — TypeError in JS; convert with Number(x) first if you need an unsigned shift')
      bigintMixReject(sym, name, val)
      const void_ = ctx.func._expect === 'void'
      // See compoundAssign's identical comment: `name` is always a bare identifier,
      // so only `val` can be a maybeUndefined dict/Map read. `<<=`/`>>=` share the
      // binary `<<`/`>>` handler's sign-aware direction flip — see bigIntShiftIR.
      const rawBits = (sym === '<<' || sym === '>>')
        ? bigIntShiftIR(sym, readI64(name, readVar(name)), bigIntOperand(val))
        : [`i64.${fn}`, readI64(name, readVar(name)), bigIntOperand(val)]
      // Shape #6 emission companion — see compoundAssign's identical comment
      // just above (this dispatch's bigint arm has the exact same
      // fresh-raw-i64-result / box-before-write-back gap).
      return writeVar(name,
        representationCompoundAssignAction(ctx, name) === REP_EDGE_BOX ? boxBigInt(rawBits) : fromI64(rawBits),
        void_)
    }
    return compoundAssign(name, val,
      (a, b) => asF64(typed([`i32.${fn}`, toI32(a), toI32(b)], 'i32')),
      (a, b) => typed([`i32.${fn}`, a, b], 'i32')
    )
  }])),

  // Logical compound assignments: a ||= b → a = a || b, a &&= b → a = a && b
  // Logical/nullish compound assignments: read → check → conditionally write
  // For complex LHS (obj.prop, arr[i]): emit as check(read(lhs)) ? write(lhs, val) : read(lhs)
  ...Object.fromEntries(['||=', '&&=', '??='].map(op => [op, (name, val) => {
    // Complex LHS → desugar (side-effect-safe since obj/arr/idx are locals)
    if (typeof name !== 'string') {
      const baseOp = op.slice(0, -1) // '||', '&&', '??'
      return emit([baseOp, name, ['=', name, val]])
    }
    if (isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
    const void_ = ctx.func._expect === 'void'
    const t = temp()
    const va = readVar(name)
    // Condition: ||= → truthy check, &&= → truthy check, ??= → nullish check
    const lhs = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    const cond = op === '??=' ? isNullish(lhs) : truthyIR(lhs)
    // &&= and ??= assign when cond is true (truthy / nullish); ||= assigns when cond is false
    const repAction = representationBindingWriteAction(ctx, name, val)
    const assigned = asF64(applyBigintRepresentationAction(emit(val), val, repAction))
    const [thenExpr, elseExpr] = op === '||='
      ? [['local.get', `$${t}`], assigned]
      : [assigned, ['local.get', `$${t}`]]
    const result = typed(['if', ['result', 'f64'], cond, ['then', thenExpr], ['else', elseExpr]], 'f64')
    // Write back — writeVar owns the cell/global/local discipline INCLUDING the
    // i32-narrowed-cell width (a direct f64.store here desynced narrowed cells).
    return writeVar(name, result, void_)
  }])),

  // === Increment/Decrement ===
  // Postfix resolved in prepare: i++ → (++i) - 1

  ...Object.fromEntries([['++', 'add'], ['--', 'sub']].map(([op, fn]) => [op, name => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
    const void_ = ctx.func._expect === 'void'
    const v = readVar(name)
    // BigInt local: readVar's carrier type is 'f64' (a bigint local's f64.reinterpret_i64
    // storage — see readVar), NOT i64, so the generic `${v.type}.${fn}` below would emit
    // f64.add/f64.sub on the raw i64 bit pattern — the same silent-rounding bug as
    // compoundAssign's f64 path (`n++` on a large-magnitude bigint was a no-op / garbage).
    // Same shape as the binary '+'/'-' BIGINT arm: asI64, i64.add/sub by the i64 constant
    // 1, fromI64. `name` is always a bare identifier here (prepare only routes '.'/'[]'
    // targets through '=' + '+'/'-', never through this table entry).
    // A covered reassigned param may have no local valType even though its
    // frozen RepresentationPlan proved every incoming value BigInt and
    // materialized the binding. The compound-action query is that proof; a
    // non-REJECT action puts ++/-- on the same i64 path as +=/>>= instead of
    // silently f64-adding the box pointer bits.
    const repAction = representationUnaryUpdateAction(ctx, name)
    if (valTypeOf(name) === VAL.BIGINT || repAction !== REP_EDGE_REJECT) {
      const current = repAction !== REP_EDGE_REJECT ? maybeUnboxBigInt(asF64(v)) : readI64(name, v)
      const rawBits = [`i64.${fn}`, current, ['i64.const', 1]]
      return writeVar(name, repAction === REP_EDGE_BOX ? boxBigInt(rawBits) : fromI64(rawBits), void_)
    }
    const one = v.type === 'i32' ? ['i32.const', 1] : ['f64.const', 1]
    return writeVar(name, typed([`${v.type}.${fn}`, v, one], v.type), void_)
  }])),

  // Member `.`/`[]` increment/decrement's WRITE half — prepare's dedicated
  // unary op (index.js '++'/'--'): "n, incremented/decremented by one, in
  // whatever kind it already is" (`n` is always a `.`/`[]` node here — bare
  // names use the readVar/writeVar table entry just above). A proven-BIGINT
  // member takes the exact i64.const-1 arithmetic that entry uses. Anything
  // else reconstructs and re-emits the spelled-out `n + 1`/`n - 1` shape —
  // byte-identical to what this op replaced (ToNumber coercion, string-
  // dispatch fallback, etc. all still live in the binary '+'/'-' handlers,
  // just reached one level of indirection later): this op only ever changes
  // codegen on the BIGINT-gated path.
  ...Object.fromEntries([['+1', '+', 'add'], ['-1', '-', 'sub']].map(([op, sym, fn]) => [op, n => {
    if (valTypeOf(n) === VAL.BIGINT)
      return fromI64([`i64.${fn}`, readI64(n, emit(n)), ['i64.const', 1]])
    // Self-referential typed-int-element increment (`count[d]++` — the
    // histogram/bucket-fill idiom): `n` is ALWAYS the exact same '[]' member
    // node this op's result is written straight back into (prepare's own
    // `['=', n, ['+1'/'-1', n]]` desugar contract, see the doc comment above
    // this table) — so unlike the general `n + 1` shape below (whose result
    // may escape as an unbounded f64 and therefore needs addFitsI32/
    // addRangeFitsI32's magnitude proof), THIS result's only consumer is a
    // write back into the same wrap-truncating typed-array slot it came from.
    // A proven-in-bounds Int8/Uint8/Int16/Uint16/Int32/Uint32Array element's
    // own store-time conversion (ECMA-262 IntegerIndexedElementSet — ToInt8/
    // ToUint8/ToInt16/ToUint16/ToInt32/ToUint32, all `mod 2^n`) is bit-
    // identical to wasm's iN.store8/16/32 truncation, so raw i32 arithmetic
    // is unconditionally sound here — no overflow proof needed at all.
    // `typedIdxProven` keeps this to statically in-bounds reads (the read
    // side of a NOT-provably-in-bounds member emits a guarded/select form
    // instead of a bare `i32.load`, so an unproven index just falls through
    // to the general path below, unchanged).
    if (Array.isArray(n) && n[0] === '[]' && typeof n[1] === 'string' &&
        wrapTruncatingTypedElemName(n[1]) && typedIdxProven(n[1], n[2]))
      return typed([`i32.${fn}`, asI32(emit(n)), ['i32.const', 1]], 'i32')
    return emit([sym, n, [, 1]])
  }])),

  // === Arithmetic (type-preserving) ===

  // Postfix in void: (++i)-1 / (--i)+1 → just ++i / --i
  '+': (a, b, self) => {
    if (ctx.func._expect === 'void' && isPostfix(a, '--', b)) return emit(a, 'void')
    // Postfix `n--` value-position recovery `(--n) + 1`: prepare wraps the '--'
    // in an outer `+ 1` to hand back the OLD value. The literal `1` here is a
    // compiler-synthesized correction constant, not a user-facing operand — it
    // must never trip bigintMixReject's TypeError (that guard exists for genuine
    // source-level BigInt/Number mixing). When n is proven BIGINT, '--' has
    // already produced the correctly-typed i64 result (see the '++'/'--' table
    // entry above); recover the old value with the same i64.add-by-constant
    // shape instead of falling into the generic BIGINT-mix check below.
    if (isPostfix(a, '--', b) && valTypeOf(a) === VAL.BIGINT)
      return fromI64(['i64.add', readI64(a, emit(a)), ['i64.const', 1]])
    // Member BIGINT `obj.p++`'s postfix OLD-value recovery — see
    // bigintMemberAssignTarget above.
    if (isLit1(b) && bigintMemberAssignTarget(a))
      return fromI64(['i64.add', readI64(a, emit(a)), ['i64.const', 1]])
    // A self-accumulation `a = a + …` lets the concat bump-EXTEND `a` in place (a is dead-after).
    // Read it for THIS concat, then clear so nested operands (not the accumulation target) stay fresh.
    const selfAccum = typeof a === 'string' && a === ctx.func._selfAccumConcat
    ctx.func._selfAccumConcat = null
    // String concat-CHAIN fusion: `i + ',' + name + ',' + v + '\n'` is
    // left-associated pairwise `+`, and pairwise lowering re-copies the whole
    // growing prefix at every step (triangular bytes moved, one fresh heap
    // buffer per `+`). Flatten the chain and emit ONE measure→alloc→copy pass
    // instead. Fusion crosses a nested `+` only when a side is statically
    // string-ish (so a numeric `1 + 2 + s` keeps its numeric ADD as a single
    // leaf); ToString order stays left-to-right (leaves evaluate in order).
    // A self-accumulating head (`line = line + a + b`) keeps leaf 0 pairwise
    // so the O(1) bump-extend accumulator survives — only the tail fuses.
    {
      const fused = tryConcatChain(a, b, selfAccum)
      if (fused) return fused
    }
    // String concatenation: pure string operands skip generic ToString coercion.
    const vtA = valTypeOf(a)
    const vtB = valTypeOf(b)
    // mayBeUndefined join (Slice 3, .work/todo.md §deletion-sweep
    // §4 — the "NEWLY added" `+` STRING-concat gap): a STRING claim whose only
    // proof is a maybeUndefined-flagged dict/Map census read (or a bare name
    // that copies one through) is "every value ever WRITTEN was a string", not
    // "this key exists" — the actual runtime value can be real `undefined`,
    // whose ToString is `"undefined"`, not raw string bits. concatRaw below
    // reinterprets its operands' bits AS string pointers with zero coercion —
    // sound only when both sides are GENUINELY strings. Gated out of both the
    // raw-concat fast path (no censusMaybeUndefined guard at all before this
    // fix) and coercionFree's STRING arm just below (which otherwise treated
    // the same unproven claim as "already a string, skip ToString") so a
    // flagged operand always falls through to the explicit `strI64`/toStrI64
    // coercion — that function's OWN existing censusMaybeUndefined guard
    // already stringifies the sentinel correctly ("undefined", not garbage).
    const stringSafe = (vt, n) => vt === VAL.STRING && !censusMaybeUndefined(n)
    if (stringSafe(vtA, a) && stringSafe(vtB, b)) {
      // Fused append-byte: `buf += s[i]` skips 1-char SSO construction + generic concat dispatch
      // when rhs is a string-index. The byte flows straight from __char_at into memory and bump-
      // EXTENDS the heap-top lhs — so only when proven self-accumulating (else it mutates a live s).
      if (selfAccum && Array.isArray(b) && b[0] === '[]' && ctx.core.stdlib['__str_append_byte'] && ctx.core.stdlib['__char_at']) {
        if (valTypeOf(b[1]) === VAL.STRING) {
          inc('__str_append_byte', '__char_at')
          return typed(['call', '$__str_append_byte',
            asI64(emit(a)),
            ctx.abi.string.ops.charCodeAt(asF64(emit(b[1])), asI32(emit(b[2])), ctx),
          ], 'f64')
        }
      }
      return typed(ctx.abi.string.ops.concatRaw(asF64(emit(a)), asF64(emit(b)), ctx, selfAccum), 'f64')
    }
    if (vtA === VAL.STRING || vtB === VAL.STRING) {
      // An OBJECT operand coerces via ToPrimitive(string) at compile time —
      // __str_concat's runtime __to_str cannot invoke a user-defined toString.
      // A BOOL operand renders "true"/"false" rather than its 0/1 carrier.
      const strOperand = (vt, n) => vt === VAL.OBJECT ? typed(['f64.reinterpret_i64', toStrI64(n, emit(n))], 'f64')
        : vt === VAL.BOOL ? emitBoolStr(n) : asF64(emit(n))
      // Coercion-free sides are already strings: a known STRING is raw; OBJECT/BOOL
      // were stringified by `strOperand`. An unknown side still needs ToString, but
      // we can apply it *once* (explicit `__to_str` via `strI64`) and join with
      // concatRaw — equivalent to `__str_concat`'s internal `__to_str` on that side,
      // while NOT re-coercing the already-string side. This drops the redundant
      // per-append `__to_str` on the accumulator in `s += part` (s proven STRING):
      //   - both coercion-free  → concatRaw(ea, eb)
      //   - one unknown         → concatRaw(known, __to_str(unknown))
      //   - both unknown        → cat (unchanged; its runtime __to_str covers both)
      // STRING arm reuses stringSafe (defined above) — a mayBeUndefined-flagged
      // STRING claim is NOT coercion-free (see that comment); OBJECT/BOOL are
      // unaffected (strOperand already applies real coercion for those, never
      // a raw-bits passthrough, so no census claim to falsify there).
      const coercionFree = (vt, n) => stringSafe(vt, n) || vt === VAL.OBJECT || vt === VAL.BOOL
      const cfA = coercionFree(vtA, a), cfB = coercionFree(vtB, b)
      const strI64 = (n) => typed(['f64.reinterpret_i64', toStrI64(n, emit(n))], 'f64')
      if (cfA && cfB) return typed(ctx.abi.string.ops.concatRaw(strOperand(vtA, a), strOperand(vtB, b), ctx, selfAccum), 'f64')
      if (cfA) return typed(ctx.abi.string.ops.concatRaw(strOperand(vtA, a), strI64(b), ctx, selfAccum), 'f64')
      if (cfB) return typed(ctx.abi.string.ops.concatRaw(strI64(a), strOperand(vtB, b), ctx, selfAccum), 'f64')
      return typed(ctx.abi.string.ops.cat(strOperand(vtA, a), strOperand(vtB, b), ctx, selfAccum), 'f64')
    }
    // §14 point 4: joint runtime-domain dispatch (see its own doc comment
    // above bigIntDomain) — `allowUnresolved=false`: a fully unresolved
    // operand here could ALSO be a runtime STRING, which must still reach
    // the STRING-coercion dispatch below, not this BigInt-only check.
    if (bigIntDomainsCanMix(a, b, false)) {
      bigintMixReject('+', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.add', ia, ib],
        (fa, fb) => typed(['f64.add', fa, fb], 'f64'), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('+', a, b)
      return fromI64(['i64.add', bigIntOperand(a), bigIntOperand(b)])
    }
    // Runtime string dispatch when at least one side could be a string. When one side has
    // a known non-STRING vtype, skip its `__is_str_key` (statically false). Common in
    // chained additions `s + a*b + c.d` — left grows as `+` (=NUMBER), only the new right
    // operand needs the runtime check.
    if ((vtA == null || vtB == null) && ctx.core.stdlib['__str_concat']) {
      const tA = temp('add'), tB = temp('add')
      // Fully-untyped `+`: the string arm is a runtime-guarded cold path that the engine reaches
      // only if BOTH operands are strings at runtime, so it keeps the bump-extend `__str_concat`
      // (its body stays out-of-line — folding it to the smaller _fresh twin would inline this
      // never-numeric branch into every hot integer loop). The demonstrated `t = s + "lit"` mutation
      // is a TYPED concat (handled by concatRaw above); a both-untyped self-mutation stays the
      // documented rare-aliasing tradeoff. Self-accumulation is still safe to extend.
      inc('__str_concat', '__is_str_key')
      const eA = vtA == null ? asF64(emit(a)) : null
      const eB = vtB == null ? asF64(emit(b)) : null
      const checkA = eA ? ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.tee', `$${tA}`, eA]]] : null
      const checkB = eB ? ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.tee', `$${tB}`, eB]]] : null
      const concat = ['call', '$__str_concat', ['i64.reinterpret_f64', ['local.get', `$${tA}`]], ['i64.reinterpret_f64', ['local.get', `$${tB}`]]]
      // Numeric arm: an UNKNOWN operand may still be a non-string NaN-box (bool
      // atom, null) whose ToNumber is not its raw bits — `true + 1` is 2,
      // `null + 1` is 1. Guard with the self-compare (every non-NaN f64 IS its
      // own ToNumber; two inline ops on the hot path); the cold arm is the
      // inline ATOM ladder, not __to_num — strings can't reach here (the
      // __is_str_key fork above took them) and objects stay jz-permissive NaN
      // either way, so the full ToNumber (and the number↔string formatter tree
      // it pins — the dyn-object golden) buys nothing. Skipped when the side is
      // known-vt (raw carrier by design) or IR-shape numeric (isNumArm — keeps
      // floatbeat kernels at their box-free ratchet counts).
      const numSide = (t, e, node) => {
        if (!e || isNumArm(e, node)) return ['local.get', `$${t}`]
        const bits = ['i64.reinterpret_f64', ['local.get', `$${t}`]]
        return ['if', ['result', 'f64'],
          ['f64.eq', ['local.get', `$${t}`], ['local.get', `$${t}`]],
          ['then', ['local.get', `$${t}`]],
          ['else', ['select',
            ['f64.const', 1],
            ['select',
              ['f64.const', 0],
              ['f64.const', 'nan'],
              ['i32.or', ['i64.eq', bits, ['i64.const', FALSE_NAN]], ['i64.eq', bits, ['i64.const', NULL_NAN]]]],
            ['i64.eq', bits, ['i64.const', TRUE_NAN]]]]]
      }
      const add    = ['f64.add', numSide(tA, eA, a), numSide(tB, eB, b)]
      if (checkA && checkB) {
        return typed(['if', ['result', 'f64'], ['i32.or', checkA, checkB], ['then', concat], ['else', add]], 'f64')
      }
      // Exactly one side is checked. Pre-eval the known side first, then the if branches on the unknown.
      const preEval = vtA == null ? ['local.set', `$${tB}`, asF64(emit(b))] : ['local.set', `$${tA}`, asF64(emit(a))]
      return block64(
        preEval,
        ['if', ['result', 'f64'], checkA ?? checkB, ['then', concat], ['else', add]])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a + b)
    if (_f) return _f
    // Neither side is a string here (string paths handled above), but either may
    // still be null/undefined/pointer — numeric `+` performs ToNumber like `-`/`*`.
    if (isLit(vb) && litVal(vb) === 0) return toNumF64(a, va)
    if (isLit(va) && litVal(va) === 0) return toNumF64(b, vb)
    // An `.unsigned` operand is a uint32 (range [0, 2^32)); JS `+` is a float
    // op whose result can exceed i32, so `i32.add` would wrap (4294967295+1→0).
    // Widen to f64 — never wrap — matching spec. Only `>>>0`/`|0`/imul wrap.
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)
        && (addFitsI32(va, vb) || addBoundedFaithful(va, vb) || addRangeFitsI32(a, b) || addLiteralFitsI32(a, b)))
      return typed(['i32.add', va, vb], 'i32')
    const i32add = tryI32Arith('i32.add', '+', a, b, va, vb); if (i32add) return i32add
    return typed(['f64.add', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  '-': (a, b, self) => {
    if (ctx.func._expect === 'void' && isPostfix(a, '++', b)) return emit(a, 'void')
    // Postfix `n++` value-position recovery `(++n) - 1` — mirror of the '+'
    // handler's `(--n) + 1` case just above; see its comment for why this
    // bypasses bigintMixReject (compiler-synthesized constant, not a source mix).
    if (isPostfix(a, '++', b) && valTypeOf(a) === VAL.BIGINT)
      return fromI64(['i64.sub', readI64(a, emit(a)), ['i64.const', 1]])
    // Member BIGINT `obj.p--`'s postfix OLD-value recovery — see
    // bigintMemberAssignTarget above ('+').
    if (isLit1(b) && bigintMemberAssignTarget(a))
      return fromI64(['i64.sub', readI64(a, emit(a)), ['i64.const', 1]])
    // §14 point 4: joint runtime-domain dispatch (see bigIntDomain's own doc
    // comment) — binary form only; `b === undefined` here is unary minus
    // (reached through this same table entry, see the plain OR-gate below),
    // a single-operand op with no second domain to mix against.
    // `f1c1256b`'s own pinned KNOWN-FAIL (`let x = BigInt(v); return x - w`,
    // `w` a zero-evidence dynamic param) closes here: `valTypeOfWithLocals`
    // (kind.js) already proves `x` BIGINT for the export-lane decode, but the
    // WASM computation below still took `x`'s proof as license to treat `w`'s
    // raw bits as an i64 carrier unconditionally, with no runtime check that
    // `w` genuinely IS one — `bigIntDomainsCanMix`/`bigIntJointDispatch`
    // (allowUnresolved=true — no STRING ambiguity for `-`, unlike `+`) close
    // that gap the same way as the census-vs-census/census-vs-proven shapes.
    if (b !== undefined && bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('-', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.sub', ia, ib],
        (fa, fb) => typed(['f64.sub', fa, fb], 'f64'), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('-', a, b)
      // b===undefined here is UNARY minus (0n - a) reached through this same table
      // entry — a single-operand op, so a maybeUndefined `a` decays to NaN in real
      // JS, never a TypeError (see bigIntOperand's doc comment). Leave its asI64
      // untouched; only the genuinely two-operand form below gets the runtime guard.
      return b === undefined
        ? fromI64(['i64.sub', ['i64.const', 0], readI64(a, emit(a))])
        : fromI64(['i64.sub', bigIntOperand(a), bigIntOperand(b)])
    }
    if (b === undefined) return emitNeg(a, self)
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a - b)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 0) return toNumF64(a, va)
    // Unsigned uint32 operand: JS `-` is float (can go negative / exceed i32),
    // so avoid the wrapping i32.sub fast-path. See `+` above.
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)
        && (addFitsI32(va, vb) || addBoundedFaithful(va, vb) || subRangeFitsI32(a, b) || subLiteralFitsI32(a, b)))
      return typed(['i32.sub', va, vb], 'i32')
    const i32sub = tryI32Arith('i32.sub', '-', a, b, va, vb); if (i32sub) return i32sub
    return typed(['f64.sub', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  'u+': a => {
    if (valTypeOf(a) === VAL.BIGINT)
      return err('unary `+` on a BigInt is a TypeError in JS — use Number(x)')
    const v = emit(a)
    if (v.type === 'i32') return asF64(v)
    // Deliberately NOT routed through toNumF64 for every non-NUMBER operand
    // (fix/wrong-values-2 tried exactly that, to fix `+{valueOf:()=>2}`'s
    // ToPrimitive gap — no test262 entry actually needed it in the end, since
    // Iterator take/drop's own `+n` runs on an untyped parameter that never
    // reaches toNumF64's VAL.OBJECT gate either way). Reverted: it broke
    // test/watr.js's "simd load/store" bug-pin (37/37 -> 36/37) by changing
    // codegen for a STRING operand read inside a discarded short-circuit
    // expression whose LEFT side is itself an assignment (watr's own
    // compile.js memarg(): `if (align) ((align = Math.log2(align)) % 1) &&
    // err(...)` — align starts '1'-derived-via-unary-plus, discarded-value
    // context) — the nested `align = Math.log2(align)` reassignment stopped
    // taking effect, a genuine toNumF64/discarded-value codegen bug exposed
    // by, not created by, routing a STRING operand through it. Out of scope
    // to chase further here; flagged, not fixed.
    if (valTypeOf(a) === VAL.NUMBER) return toNumF64(a, v)
    inc('__to_num')
    return typed(['call', '$__to_num', asI64(v)], 'f64')
  },
  'u-': (a, self) => emitNeg(a, self),
  '*': (a, b, self) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment above.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('*', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.mul', ia, ib],
        (fa, fb) => typed(['f64.mul', fa, fb], 'f64'), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('*', a, b)
      return fromI64(['i64.mul', bigIntOperand(a), bigIntOperand(b)])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a * b)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 1) return toNumF64(a, va)
    if (isLit(va) && litVal(va) === 1) return toNumF64(b, vb)
    // `x * 0` → 0 only when the other factor is provably finite (i32, or a finite
    // literal): JS `NaN*0` / `±Inf*0` are NaN, so a non-finite f64 must fall
    // through to `f64.mul` (which yields NaN). For finite x the dropped product is
    // ±0 — and -0 === +0, so consumers are unaffected. The block evaluates x for
    // its side effects before dropping.
    const finiteFactor = (v) => isI32Num(v) || (isLit(v) && Number.isFinite(litVal(v)))
    if (isLit(vb) && litVal(vb) === 0 && finiteFactor(va)) return isLit(va) ? vb : typed(['block', ['result', vb.type], va, 'drop', vb], vb.type)
    if (isLit(va) && litVal(va) === 0 && finiteFactor(vb)) return isLit(vb) ? va : typed(['block', ['result', va.type], vb, 'drop', va], va.type)
    // `.unsigned` operand is a uint32 ([0, 2^32)); its product can exceed i32, so
    // `i32.mul` would wrap ((2^32-1)*2 → -2). Widen to f64 — see `+` above.
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)
        && (mulFitsI32(va, vb) || mulBoundedFaithful(va, vb) || mulRangeFitsI32(a, b))) return typed(['i32.mul', va, vb], 'i32')
    // Typed-element reads arrive PRE-converted (`.typed:[]` returns
    // f64.convert_i32_{s,u}(loadN)), so the faithful-product gate above never
    // sees them. Peel the convert to expose the bounded integer source: when
    // |a|·|b| ≤ 2^31−1 the exact product fits signed i32, so
    // f64.mul(convert(x), convert(y)) == convert_s(i32.mul(x, y)) in every
    // consumer context — one int op instead of two converts + f64.mul, and the
    // i32 product chain is lane-vectorizable. Unsigned converts are safe here
    // for the same reason: a magnitude-bounded (< 2^31) uint reads the same
    // signed or unsigned, and the bounded product needs the signed convert.
    const peeled = (v) => Array.isArray(v) && (v[0] === 'f64.convert_i32_s' || v[0] === 'f64.convert_i32_u') && v.length === 2 ? v[1]
      : isI32Num(v) && !widensUnsigned(v) ? v : null
    const pa = peeled(va), pb = peeled(vb)
    if (pa && pb && i32Mag(pa) * i32Mag(pb) <= 0x7fffffff) return typed(['i32.mul', pa, pb], 'i32')
    const i32mul = tryI32Arith('i32.mul', '*', a, b, va, vb); if (i32mul) return i32mul
    return typed(['f64.mul', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  '/': (a, b, self) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment above.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('/', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.div_s', ia, ib],
        (fa, fb) => typed(['f64.div', fa, fb], 'f64'), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('/', a, b)
      return fromI64(['i64.div_s', bigIntOperand(a), bigIntOperand(b)])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a / b, b => b !== 0)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 1) return toNumF64(a, va)
    // Division by an exact power of two is a BIT-EXACT multiply by its
    // reciprocal (2^-k is representable; per-element scaling is exact for every
    // finite/NaN/±0 input — IEEE 754 multiplication by a power of two only
    // adjusts the exponent). f64.mul is ~4× cheaper than f64.div on every
    // relevant core (the q16 fraction split `(dq - dInt*65536)/65536.0`).
    if (isLit(vb)) {
      const d = litVal(vb)
      const k = Math.log2(Math.abs(d))
      if (Number.isInteger(k) && Number.isFinite(d) && d !== 0 && Math.abs(k) <= 1000)
        return typed(['f64.mul', stripCanon(toNumF64(a, va)), ['f64.const', 1 / d]], 'f64')
    }
    return typed(['f64.div', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  '%': (a, b, self) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment
    // above. Number-domain branch reuses `f64rem` (the SAME `$__rem` call the
    // fully generic '%' path below already uses — exact NaN/±Inf/0 edges).
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('%', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.rem_s', ia, ib],
        (fa, fb) => f64rem(fa, fb), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('%', a, b)
      return fromI64(['i64.rem_s', bigIntOperand(a), bigIntOperand(b)])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a % b, b => b !== 0)
    if (_f) return _f
    // ES remainder by zero is NaN; only the f64 path yields that (a - trunc(a/0)*0).
    // The i32.rem_s fast path traps on a zero divisor, so divert a literal-zero divisor.
    // `va` is ALREADY emitted (above) — an impure dividend (`bump() % 0`) must still run
    // once, in source order, before the NaN fold (re-audit P0, sweep of emitTypeofCmp's
    // static-kind-fold class: this branch used to discard `va` unconditionally).
    if (isLit(vb) && litVal(vb) === 0) {
      const nan = emitNum(NaN)
      return foldOperandPure(a) ? nan : typed(['block', ['result', 'f64'], ['drop', va], nan], 'f64')
    }
    // i32.rem_s is exact for integer operands AND fast, but it TRAPS on a zero
    // divisor where JS yields NaN. Only take it when the divisor is a literal
    // integer (necessarily nonzero — literal 0 is handled above); a runtime i32
    // divisor could be 0, so route it to f64rem (exact for in-range integers,
    // NaN for 0). The dividend may be a bare i32 or a FAITHFUL signed-convert
    // wrapper (f64.convert_i32_s X — the i32 view equals the JS value): peel it.
    // `.unsigned` operand: `i32.rem_s` reads the uint32 as a negative signed value
    // ((2^32-1)%7 → rem_s(-1,7) = -1, not 3). Widen to f64 — see `+` above.
    if (isLit(vb) && Number.isInteger(litVal(vb)) && Math.abs(litVal(vb)) < 2 ** 31 && !vb.unsigned) {
      const pa = isI32Num(va) && !va.unsigned ? va
        : Array.isArray(va) && va[0] === 'f64.convert_i32_s' && !va.unsigned
          ? (Array.isArray(va[1]) ? typed(va[1], 'i32') : va[1]) : null
      if (pa) return typed(['i32.rem_s', pa, ['i32.const', litVal(vb) | 0]], 'i32')
    }
    // Fast path: positive literal divisor → inline a - trunc(a/b) * b.
    // Exact when |a| < 2^53 × |b| (all practical audio/control-range values).
    // The full __rem handles NaN/±Inf/0 edges exactly; this avoids the call overhead.
    if (isLit(vb) && litVal(vb) > 0) {
      const fa = toNumF64(a, va), fb = toNumF64(b, vb)
      const rem = ta => typed(['f64.sub', ta, ['f64.mul', ['f64.trunc', ['f64.div', ta, fb]], fb]], 'f64')
      if (isPureIR(fa)) return rem(fa)
      return withTemp(fa, t => rem(['local.get', `$${t}`]), 'rem')
    }
    return f64rem(toNumF64(a, va), toNumF64(b, vb))
  },
  // === Comparisons (always i32 result) ===

  '==': (a, b) => emitLooseEq(a, b, false),
  '!=': (a, b) => emitLooseEq(a, b, true),
  'instanceof': (a, rhs) => emitInstanceof(a, rhs),
  '===': (a, b) => emitStrictEq(a, b, false),
  '!==': (a, b) => emitStrictEq(a, b, true),
  '<':  cmpOp('lt_s', 'lt', (a, b) => a < b),
  '>':  cmpOp('gt_s', 'gt', (a, b) => a > b),
  '<=': cmpOp('le_s', 'le', (a, b) => a <= b),
  '>=': cmpOp('ge_s', 'ge', (a, b) => a >= b),

  // === Logical ===

  '!': a => {
    const v = emit(a)
    if (v.type === 'i32') return typed(['i32.eqz', v], 'i32')
    // Unboxed pointer offsets: falsy iff zero offset.
    if (v.ptrKind != null) return typed(['i32.eqz', v], 'i32')
    // Known pointer-kinded operand: `!x` is just `x is nullish` (null/undefined).
    // Excludes STRING — empty string '' is a valid (non-null) pointer but is falsy.
    // VAL.BOOL rides the 0/1 numeric carrier (not a pointer), so normalize it to
    // NUMBER and let it fall to the truthy path — `!false` must be `true`.
    const vt = numericVal(resolveValType(a, valTypeOf, lookupValType))
    if (vt && vt !== VAL.NUMBER && vt !== VAL.BIGINT && vt !== VAL.STRING) {
      return isNullish(asF64(v))
    }
    // Route through truthyIR (not a bare __is_truthy) so a NUMBER operand uses the
    // NaN-safe f64 test — `!(0/0)` must be `true` on every platform (x86's sign-set
    // NaN would read as a truthy box through the bit-based __is_truthy).
    return typed(['i32.eqz', truthyIR(v)], 'i32')
  },

  '?:': (a, b, c, self) => {
    // Constant condition → emit only the live branch, but preserve the
    // materialized join's selected edge normalization.
    const ca = emit(a)
    if (isLit(ca)) {
      const v = litVal(ca), arm = (v !== 0 && v === v) ? b : c
      const action = ctx.func._arrayLiteralNeverEscapes ? REP_EDGE_REJECT
        : representationJoinArmAction(ctx, self, arm)
      return applyBigintRepresentationAction(emit(arm), arm, action)
    }
    const cond = toBoolFromEmitted(ca)
    // Flow-sensitive refinement: each arm sees narrowing consistent with `a` being truthy / falsy.
    const thenRefs = extractRefinements(a, new Map(), true)
    const elseRefs = extractRefinements(a, new Map(), false)
    const vb = withRefinements(thenRefs, b, () => emit(b))
    const vc = withRefinements(elseRefs, c, () => emit(c))
    const repB = representationJoinArmAction(ctx, self, b)
    const repC = representationJoinArmAction(ctx, self, c)
    if (!ctx.func._arrayLiteralNeverEscapes && repB !== REP_EDGE_REJECT && repC !== REP_EDGE_REJECT) {
      if (bigintStrict() && (repB === REP_EDGE_BOX || repC === REP_EDGE_BOX))
        bigintEraseErr('ternary-nullish', 'this ternary\'s BigInt arm')
      const fb = asF64(applyBigintRepresentationAction(vb, b, repB))
      const fc = asF64(applyBigintRepresentationAction(vc, c, repC))
      return typed(['f64.reinterpret_i64',
        ['if', ['result', 'i64'], cond,
          ['then', ['i64.reinterpret_f64', fb]],
          ['else', ['i64.reinterpret_f64', fc]]]], 'f64')
    }
    // A BOOL arm beside a non-BOOL, non-NUMBER arm: the merge kills the static
    // type, so the boolean's identity is observable only through its atom box —
    // materialize it per-arm here, BEFORE the raw-bit collapses below erase it
    // (`i ? true : [from, len]` — watr's rec-type marker — must yield TRUE_NAN,
    // not 1.0). BOOL∪NUMBER stays raw: VT['?:'] carries NUMBER there (the raw
    // 0/1 IS the bool's ToNumber image — the benign numeric-context lie), and
    // both-BOOL arms keep vt BOOL and stay raw 0/1 by design.
    {
      const vtbM = resolveValType(b, valTypeOf, lookupValType)
      const vtcM = resolveValType(c, valTypeOf, lookupValType)
      if ((vtbM === VAL.BOOL) !== (vtcM === VAL.BOOL) &&
          (vtbM === VAL.BOOL ? vtcM : vtbM) !== VAL.NUMBER) {
        const fb = vtbM === VAL.BOOL ? boolBoxIR(vb) : asF64(vb)
        const fc = vtcM === VAL.BOOL ? boolBoxIR(vc) : asF64(vc)
        const ib = ['i64.reinterpret_f64', fb], ic = ['i64.reinterpret_f64', fc]
        const bits = eagerSelectOK(fb, fc) && selectCondOK(cond)
          ? ['select', ib, ic, cond]
          : ['if', ['result', 'i64'], cond, ['then', ib], ['else', ic]]
        return typed(['f64.reinterpret_i64', bits], 'f64')
      }
    }
    // `cond ? 1 : 0` is the condition bit itself; `cond ? 0 : 1` its negation. `cond`
    // (truthyIR) is already canonical 0/1, so the select + two const arms collapse to
    // the bit. (Both arms are literals here, so dropping their emitted IR is side-effect
    // free.) Mirrors what `+(x > 0)` already produces.
    if (isLit(vb) && isLit(vc)) {
      const lb = litVal(vb), lc = litVal(vc)
      if (lb === 1 && lc === 0) return typed(cond, 'i32')
      if (lb === 0 && lc === 1) return typed(['i32.eqz', cond], 'i32')
    }
    // L: Use WASM select for pure ternaries — branchless, smaller bytecode
    if (vb.type === 'i32' && vc.type === 'i32') {
      // A single i32 select is only sound when BOTH arms' i32 carriers mean the same
      // thing to the downstream asF64 — otherwise the result is interpreted one way and
      // the other arm's value is corrupted. Two compatible shapes:
      //   • both non-pointer i32 (numbers/bools) → asF64 numeric-converts, correct; or
      //   • both the SAME pointer kind+aux → result carries that ptrKind so asF64 takes
      //     the NaN-rebox path (and boxPtrIR's single aux slot is the shared one).
      // Anything else — a pointer arm beside a number/bool arm, two different pointer
      // kinds, or the same kind with diverging aux (polymorphic OBJECT schemaIds, TYPED
      // element types) — must fall through to the f64 path, where each arm is asF64'd
      // independently and reboxed with its own kind/aux in the NaN-box. The pre-4.x bug:
      // a pointer arm vs a `true`/number arm took the i32 select, dropped the ptrKind,
      // and `f64.convert_i32_s` numeric-converted the pointer bits — so `cond ? obj : 1`
      // lost its object-ness (typeof → "number").
      const bothPlain = vb.ptrKind == null && vc.ptrKind == null
      const samePtr = vb.ptrKind != null && vb.ptrKind === vc.ptrKind
        && (vb.ptrAux ?? null) === (vc.ptrAux ?? null)
      // A plain arm can ALSO carry `.unsigned` (a proven-uint32 magnitude, cf. ir.js
      // asF64: `n.unsigned ? convert_i32_u : convert_i32_s`) — the same single-widen-
      // after-select hazard the ptrKind check above guards against applies to sign:
      // asF64 widens the JOINED select's result ONCE, with ONE signedness, so a single
      // i32 select is sound only when both plain arms AGREE (pointer arms don't carry
      // `.unsigned`, so samePtr is always "agreement"). Disagreement falls through to
      // the general per-arm asF64 path below (the SAME one a ptrKind mismatch already
      // falls through to) — it widens each arm independently, so it's correct by
      // construction for exactly this reason, no separate branch needed here.
      const signOK = !bothPlain || !!vb.unsigned === !!vc.unsigned
      if ((bothPlain || samePtr) && signOK) {
        const tagPtr = (n) => {
          if (vb.ptrKind != null && vb.ptrKind === vc.ptrKind) {
            n.ptrKind = vb.ptrKind
            if (vb.ptrAux != null && vb.ptrAux === vc.ptrAux) n.ptrAux = vb.ptrAux
          }
          // Agreement propagated onto the joined node so the caller's OWN asF64
          // (this select's result is itself just another i32-typed IR node) converts
          // with the right sign instead of defaulting to signed.
          if (bothPlain && vb.unsigned && vc.unsigned) n.unsigned = true
          return n
        }
        if (eagerSelectOK(vb, vc) && selectCondOK(cond))
          return tagPtr(typed(['select', vb, vc, cond], 'i32'))
        return tagPtr(typed(['if', ['result', 'i32'], cond, ['then', vb], ['else', vc]], 'i32'))
      }
    }
    const fb = asF64(vb), fc = asF64(vc)
    const vtb = resolveValType(b, valTypeOf, lookupValType)
    const vtc = resolveValType(c, valTypeOf, lookupValType)
    const isNaNBoxLit = n => Array.isArray(n) && n[0] === 'f64.const' && typeof n[1] === 'string' && n[1].startsWith('nan:')
    const refPayload = (vtb && vtb === vtc && REF_EQ_KINDS.has(vtb))
      || vb.closureFuncIdx != null || vc.closureFuncIdx != null
      || isNaNBoxLit(fb) || isNaNBoxLit(fc)
    const numericB = isNumArm(vb, b, vtb)
    const numericC = isNumArm(vc, c, vtc)
    // Peephole: `cond ? 1 : 0` (or `cond ? 0 : 1`) is just `f64.convert_i32_s(cond)` —
    // the select collapses because cond is already 0/1. Saves 5 instructions.
    const isOneZero = (one, zero) => {
      const o = one, z = zero
      return o.type === 'i32' && Array.isArray(o) && o[0] === 'i32.const' && o[1] === 1 &&
             z.type === 'i32' && Array.isArray(z) && z[0] === 'i32.const' && z[1] === 0
    }
    if ((isOneZero(vb, vc) || isOneZero(vc, vb)) && !numericB && !numericC) {
      const condBool = truthyIR(emit(a))
      const n = isOneZero(vb, vc)
        ? typed(['f64.convert_i32_s', condBool], 'f64')
        : typed(['f64.convert_i32_s', ['i32.eqz', condBool]], 'f64')
      n.valKind = VAL.NUMBER
      return n
    }
    const branchB = canonArm(fb, numericB, numericC), branchC = canonArm(fc, numericC, numericB)
    const markNumeric = (n) => {
      if (numericB && numericC) n.valKind = VAL.NUMBER
      return n
    }
    if (refPayload) {
      const ib = ['i64.reinterpret_f64', branchB]
      const ic = ['i64.reinterpret_f64', branchC]
      const bits = eagerSelectOK(branchB, branchC) && selectCondOK(cond)
        ? ['select', ib, ic, cond]
        : ['if', ['result', 'i64'], cond, ['then', ib], ['else', ic]]
      return typed(['f64.reinterpret_i64', bits], 'f64')
    }
    if (!refPayload && eagerSelectOK(branchB, branchC) && selectCondOK(cond))
      return markNumeric(typed(['select', branchB, branchC, cond], 'f64'))
    return markNumeric(typed(['if', ['result', 'f64'], cond, ['then', branchB], ['else', branchC]], 'f64'))
  },

  '&&': (a, b, self) => {
    // Plan-materialized BigInt∪other join (C5b, mirrors '?:'s materialized
    // fast path above): both arms proven box-or-keep-able into this join's
    // BOXED_BIGINT target. `a` is BOTH the condition and (when falsy) a
    // surfacing arm, so it's tee'd: truthiness is tested on its RAW value
    // (boxing first would corrupt a falsy BigInt 0n's own truthiness), and
    // only the arm that actually surfaces gets its representation action
    // applied. When the join isn't materialized both actions are
    // REP_EDGE_REJECT (a cheap WeakSet miss) and every branch below runs
    // exactly as before — this check never changes non-bigint codegen.
    const repA0 = representationJoinArmAction(ctx, self, a)
    const repB0 = representationJoinArmAction(ctx, self, b)
    if (!ctx.func._arrayLiteralNeverEscapes && repA0 !== REP_EDGE_REJECT && repB0 !== REP_EDGE_REJECT) {
      const va0 = emit(a)
      const t0 = temp()
      const teed0 = typed(['local.tee', `$${t0}`, asF64(va0)], 'f64')
      const rightRefs0 = extractRefinements(a, new Map(), true)
      const vb0 = withRefinements(rightRefs0, b, () => emit(b))
      const faBoxed = applyBigintRepresentationAction(typed(['local.get', `$${t0}`], 'f64'), a, repA0)
      const fb0 = asF64(applyBigintRepresentationAction(vb0, b, repB0))
      return typed(['f64.reinterpret_i64',
        ['if', ['result', 'i64'], toBoolFromEmitted(teed0),
          ['then', ['i64.reinterpret_f64', fb0]],
          ['else', ['i64.reinterpret_f64', faBoxed]]]], 'f64')
    }
    // Range-check fusion: `x >= LO && x <= HI` (x a pure i32 local, LO ≤ HI compile-time
    // constants) collapses to one unsigned compare `(x - LO) <=u (HI - LO)` — a subtract
    // plus a branch instead of two compares, an AND, and a short-circuit branch. This is
    // the per-char cost in scanners/parsers (digit/alpha classification) and in any
    // two-sided bounds check. Restricted to a local `x` so evaluating it once (the fused
    // form) matches the original's twice-read, side-effect-free semantics.
    const fused = fuseRangeCheck(a, b)
    if (fused) return fused
    const va = emit(a)
    // Constant-folded literal: pre-bind under truthy refinements (b runs only when a was truthy).
    if (isLit(va)) {
      const v = litVal(va)
      if (v !== 0 && v === v) {
        const refs = extractRefinements(a, new Map(), true)
        return withRefinements(refs, b, () => emit(b))
      }
      return va
    }
    // a is truthy in the right-arm — narrow b accordingly. Matches `?:`'s then-arm threading
    // (`Array.isArray(x) && x[0]` → x[0] sees x as ARRAY, eliding union-rep fallbacks).
    const rightRefs = extractRefinements(a, new Map(), true)
    // Guarded indexed-closure dispatch: `(name = V[idx]) && name(args)` —
    // subscript's parse.step idiom for "look up a handler, call it if present."
    // `a`'s assignment (emitted normally, above) already set `name` from
    // `V[idx]`; `b`'s callee, though syntactically a bare identifier, is
    // PROVABLY that same read — tag the resulting call_indirect the same way
    // a direct `V[idx](args)` gets tagged (emitGenericClosureCall below), so
    // devirtConstFnArrayCalls can rewrite it once dyn-closure-tables.js proves
    // V monomorphic. An unresolved/untagged V just leaves the tag inert.
    const dvArrName = (ctx.transform.optFlags & OPTF.devirtClosureTables) && Array.isArray(a) && a[0] === '=' &&
      typeof a[1] === 'string' && Array.isArray(a[2]) && a[2][0] === '[]' &&
      typeof a[2][1] === 'string' && ctx.scope.dynFnTableCandidates?.has(a[2][1]) &&
      Array.isArray(b) && b[0] === '()' && b[1] === a[1] ? a[2][1] : null
    const emitRight = () => {
      const vr = withRefinements(rightRefs, b, () => emit(b))
      return dvArrName ? tagFnArrayDispatch(vr, dvArrName) : vr
    }
    // Mixed BOOL/non-NUMBER sides: the merge kills the static type (VT['&&']
    // returns null), so a surfacing bool must carry its atom box — same rule as
    // the `?:` arm materialization above. Both-BOOL and BOOL∪NUMBER stay raw.
    {
      const vtA = resolveValType(a, valTypeOf, lookupValType)
      const vtB = resolveValType(b, valTypeOf, lookupValType)
      if ((vtA === VAL.BOOL) !== (vtB === VAL.BOOL) && (vtA === VAL.BOOL ? vtB : vtA) !== VAL.NUMBER) {
        const t = temp()
        const fa = vtA === VAL.BOOL ? boolBoxIR(va) : asF64(va)
        const fb0 = emitRight()
        const fb = vtB === VAL.BOOL ? boolBoxIR(fb0) : asF64(fb0)
        return typed(['if', ['result', 'f64'],
          toBoolFromEmitted(typed(['local.tee', `$${t}`, fa], 'f64')),
          ['then', fb],
          ['else', ['local.get', `$${t}`]]], 'f64')
      }
    }
    // i32 fast path: use i32 tee as cond directly (nonzero=truthy in wasm `if`),
    // skip f64 round-trip and __is_truthy call entirely.
    if (va.type === 'i32') {
      const vb = emitRight()
      // Boolean-only short circuit with a pure RHS is safe to evaluate
      // eagerly. Comparisons are canonical 0/1, so bitwise AND preserves the
      // value while removing the nested if/tee ladder in scalar predicates.
      if (vb.type === 'i32' && boolEagerBody() && isCanonicalBoolExpr(a) && isCanonicalBoolExpr(b) && eagerSelectOK(vb))
        return typed(['i32.and', va, vb], 'i32')
      const t = tempI32()
      if (vb.type === 'i32') {
        // This if-join's else-arm (a falsy) is PROVABLY `local.get $t` === 0: the
        // wasm `if` cond IS va's own bits tested nonzero, so the only bit pattern
        // that ever reaches the else-arm is all-zero — and 0 means the same thing
        // signed or unsigned. So va's OWN `.unsigned` can never affect this join's
        // value; only vb (returned verbatim when a is truthy) can surface a real
        // magnitude. Unlike '?:' (9c313e58) and '||' below, there is no second arm
        // for vb to disagree WITH — the joined node just inherits vb's sign outright,
        // no agreement gate needed.
        const node = typed(['if', ['result', 'i32'],
          ['local.tee', `$${t}`, va],
          ['then', vb],
          ['else', ['local.get', `$${t}`]]], 'i32')
        if (vb.unsigned) node.unsigned = true
        return node
      }
      return typed(['if', ['result', 'f64'],
        ['local.tee', `$${t}`, va],
        ['then', asF64(vb)],
        ['else', typed(['f64.convert_i32_s', ['local.get', `$${t}`]], 'f64')]], 'f64')
    }
    const t = temp()
    const numA = isNumArm(va, a)
    const vb = emitRight(), numB = isNumArm(vb, b)
    // `a` is the else-arm result (returned when falsy — incl NaN), so canon a lone-numeric
    // `a` before the tee: `$t` then feeds both the result and the cond canonically.
    const teed = typed(['local.tee', `$${t}`, canonArm(asF64(va), numA, numB)], 'f64')
    // A numeric left arm tests truthiness NaN-by-value (not __is_truthy, which mis-reads
    // x86's sign-set NaN as truthy) — tag it so truthyIR takes that path.
    if (numA) teed.valKind = VAL.NUMBER
    return typed(['if', ['result', 'f64'], toBoolFromEmitted(teed),
      ['then', canonArm(asF64(vb), numB, numA)],
      ['else', ['local.get', `$${t}`]]], 'f64')
  },

  '||': (a, b, self) => {
    // Plan-materialized BigInt∪other join (C5b) — mirror of '&&' above with
    // the then/else arms swapped: `a` surfaces (tee'd, RAW truthiness test)
    // when truthy, `b` only when `a` was falsy. See '&&'s comment for why
    // truthiness is tested before any boxing and why a REJECTed action
    // (the common case) leaves every branch below byte-for-byte unchanged.
    const repA0 = representationJoinArmAction(ctx, self, a)
    const repB0 = representationJoinArmAction(ctx, self, b)
    if (!ctx.func._arrayLiteralNeverEscapes && repA0 !== REP_EDGE_REJECT && repB0 !== REP_EDGE_REJECT) {
      const va0 = emit(a)
      const t0 = temp()
      const teed0 = typed(['local.tee', `$${t0}`, asF64(va0)], 'f64')
      const rightRefs0 = extractRefinements(a, new Map(), false)
      const vb0 = withRefinements(rightRefs0, b, () => emit(b))
      const faBoxed = applyBigintRepresentationAction(typed(['local.get', `$${t0}`], 'f64'), a, repA0)
      const fb0 = asF64(applyBigintRepresentationAction(vb0, b, repB0))
      return typed(['f64.reinterpret_i64',
        ['if', ['result', 'i64'], toBoolFromEmitted(teed0),
          ['then', ['i64.reinterpret_f64', faBoxed]],
          ['else', ['i64.reinterpret_f64', fb0]]]], 'f64')
    }
    // Outside-range fusion (the complement of `&&`): `x < LO || x > HI` → one unsigned
    // compare `(x - LO) >u (HI - LO)`. Common in validation (`if (c < 'a' || c > 'z') …`).
    const fusedOr = fuseRangeCheckOr(a, b)
    if (fusedOr) return fusedOr
    const va = emit(a)
    // Constant-folded literal: pre-bind under falsy refinements (b runs only when a was falsy).
    if (isLit(va)) {
      const v = litVal(va)
      if (v !== 0 && v === v) return va
      const refs = extractRefinements(a, new Map(), false)
      return withRefinements(refs, b, () => emit(b))
    }
    // a is falsy in the right-arm — `x == null || ...` proves x is null/undefined in b;
    // De Morgan'd via the sense=false branch of extractRefinements (mirrors the ?: else-arm).
    const rightRefs = extractRefinements(a, new Map(), false)
    const emitRight = () => withRefinements(rightRefs, b, () => emit(b))
    // Mixed BOOL/non-NUMBER sides — see `&&`: a surfacing bool carries its atom box.
    {
      const vtA = resolveValType(a, valTypeOf, lookupValType)
      const vtB = resolveValType(b, valTypeOf, lookupValType)
      if ((vtA === VAL.BOOL) !== (vtB === VAL.BOOL) && (vtA === VAL.BOOL ? vtB : vtA) !== VAL.NUMBER) {
        const t = temp()
        const fa = vtA === VAL.BOOL ? boolBoxIR(va) : asF64(va)
        const fb0 = emitRight()
        const fb = vtB === VAL.BOOL ? boolBoxIR(fb0) : asF64(fb0)
        return typed(['if', ['result', 'f64'],
          toBoolFromEmitted(typed(['local.tee', `$${t}`, fa], 'f64')),
          ['then', ['local.get', `$${t}`]],
          ['else', fb]], 'f64')
      }
    }
    if (va.type === 'i32') {
      const vb = emitRight()
      // Boolean twin of && above: eager pure RHS + canonical 0/1 values make
      // bitwise OR exactly equivalent to short-circuit OR.
      if (vb.type === 'i32' && boolEagerBody() && isCanonicalBoolExpr(a) && isCanonicalBoolExpr(b) && eagerSelectOK(vb))
        return typed(['i32.or', va, vb], 'i32')
      const t = tempI32()
      // Unlike `&&` above, this if-join's THEN-arm (a truthy) returns va's own
      // value verbatim — so, like '?:' (9c313e58), BOTH arms can surface an
      // independent real magnitude here (the else-arm returns vb whenever a was
      // falsy, unconstrained). A single downstream asF64 can only apply ONE sign
      // to whichever branch fires at runtime, so the single-i32-if fast path is
      // sound only when the two arms AGREE; disagreement (or a non-i32 vb) widens
      // each arm with its OWN sign inside the if instead (still one branch, no
      // extra control flow) — asF64(vb) already respects vb.unsigned, the va side
      // just needs the same sign-aware conversion instead of a hardcoded signed one.
      const signOK = vb.type === 'i32' && !!va.unsigned === !!vb.unsigned
      if (signOK) {
        const node = typed(['if', ['result', 'i32'],
          ['local.tee', `$${t}`, va],
          ['then', ['local.get', `$${t}`]],
          ['else', vb]], 'i32')
        if (va.unsigned && vb.unsigned) node.unsigned = true
        return node
      }
      return typed(['if', ['result', 'f64'],
        ['local.tee', `$${t}`, va],
        ['then', typed([va.unsigned ? 'f64.convert_i32_u' : 'f64.convert_i32_s', ['local.get', `$${t}`]], 'f64')],
        ['else', asF64(vb)]], 'f64')
    }
    const t = temp()
    const numA = isNumArm(va, a)
    const vb = emitRight(), numB = isNumArm(vb, b)
    // `a` (then-arm) is returned only when truthy — hence never NaN — so it needs no canon;
    // the cond's NaN-safety comes from the valKind tag. Only the else (b) arm can surface
    // as a numeric NaN.
    const teed = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    if (numA) teed.valKind = VAL.NUMBER   // numeric left arm: NaN-safe truthiness (see `&&`)
    return typed(['if', ['result', 'f64'], toBoolFromEmitted(teed),
      ['then', ['local.get', `$${t}`]],
      ['else', canonArm(asF64(vb), numB, numA)]], 'f64')
  },

  // a ?? b: returns b only if a is nullish
  '??': (a, b, self) => {
    // Plan-materialized BigInt∪other join (C5b) — see '&&'s comment. `??`'s
    // condition is nullishness, not truthiness, but the same tee-before-box
    // discipline applies: test on `a`'s raw value, box only the arm that
    // actually surfaces.
    const repA0 = representationJoinArmAction(ctx, self, a)
    const repB0 = representationJoinArmAction(ctx, self, b)
    if (!ctx.func._arrayLiteralNeverEscapes && repA0 !== REP_EDGE_REJECT && repB0 !== REP_EDGE_REJECT) {
      const va0 = emit(a), vb0 = emit(b)
      const t0 = temp()
      const teed0 = typed(['local.tee', `$${t0}`, asF64(va0)], 'f64')
      const faBoxed = applyBigintRepresentationAction(typed(['local.get', `$${t0}`], 'f64'), a, repA0)
      const fb0 = asF64(applyBigintRepresentationAction(vb0, b, repB0))
      return typed(['f64.reinterpret_i64',
        ['if', ['result', 'i64'], ['i32.eqz', isNullish(teed0)],
          ['then', ['i64.reinterpret_f64', faBoxed]],
          ['else', ['i64.reinterpret_f64', fb0]]]], 'f64')
    }
    const va = emit(a), vb = emit(b)
    const t = temp()
    // Mixed BOOL/non-NUMBER sides — see `&&`: a surfacing bool carries its atom box.
    {
      const vtA = resolveValType(a, valTypeOf, lookupValType)
      const vtB = resolveValType(b, valTypeOf, lookupValType)
      if ((vtA === VAL.BOOL) !== (vtB === VAL.BOOL) && (vtA === VAL.BOOL ? vtB : vtA) !== VAL.NUMBER) {
        const fa = vtA === VAL.BOOL ? boolBoxIR(va) : asF64(va)
        const fb = vtB === VAL.BOOL ? boolBoxIR(vb) : asF64(vb)
        return typed(['if', ['result', 'f64'],
          ['i32.eqz', isNullish(['local.tee', `$${t}`, fa])],
          ['then', ['local.get', `$${t}`]],
          ['else', fb]], 'f64')
      }
    }
    const numA = isNumArm(va, a), numB = isNumArm(vb, b)
    // Both arms can surface as the (untyped) result — `a` when non-nullish (a NaN is not
    // nullish, so it IS returned), `b` otherwise. Canon a lone-numeric arm; `a` before the
    // tee so `local.get $t` is canonical. The cond is isNullish, robust to non-canon NaN.
    return typed(['if', ['result', 'f64'],
      ['i32.eqz', isNullish(['local.tee', `$${t}`, canonArm(asF64(va), numA, numB)])],
      ['then', ['local.get', `$${t}`]],
      ['else', canonArm(asF64(vb), numB, numA)]], 'f64')
  },

  'void': a => {
    const v = emit(a)
    const dropAndUndef = (instr) => block64(instr, 'drop', undefExpr())
    if (v == null) return undefExpr()
    const op = Array.isArray(v) ? v[0] : null
    const wasmVoid = op === 'local.set' || (typeof op === 'string' && op.endsWith('.store'))
      || op === 'memory.copy' || op === 'global.set'
    if (wasmVoid)
      return block64(v, undefExpr())
    if (v.type && v.type !== 'void')
      return dropAndUndef(v)
    return block64(...flat(v), undefExpr())
  },

  '(': a => emit(a),

  // === Bitwise (i32 for numbers, i64 for BigInt) ===

  // Per ECMAScript ToInt32, bitwise ops first ToNumber-coerce non-numeric operands.
  // i32 / lit values are already numeric — the toNumF64 wrap is skipped to keep
  // the numeric fast path at one wasm instruction. Non-numeric (NaN-boxed string,
  // unknown type) routes through __to_num so "2026" | 0 === 2026.
  // `~~x` is the idiomatic int32 truncation: the two xor-with-(-1) cancel, leaving
  // a single toI32 (whose NaN/Infinity guard runs once, unchanged). Fold it here so
  // DSP/bytebeat `~~` doesn't emit a dead double-xor watr won't remove.
  '~':   (a, self) => {
    if (Array.isArray(a) && a[0] === '~') {
      const inner = a[1]
      // ~~x === x for BigInt; the int32-truncation fold below is number-only.
      if (valTypeOf(inner) === VAL.BIGINT) return emit(inner)
      const iv = emit(inner)
      return isLit(iv) ? emitNum(~~litVal(iv)) : typed(toI32(isI32Num(iv) ? iv : toNumF64(inner, iv)), 'i32')
    }
    // BigInt complement is the i64 `x ^ -1` (all bits flipped), like emitNeg's i64.sub.
    // bigIntUnary: a maybeUndefined-BIGINT operand's real
    // JS value is ToInt32(NaN)'s complement, NUMBER -1 — not `x ^ -1` on the raw
    // UNDEF_NAN sentinel bits (see emitNeg's identical substitution above).
    // `|| censusMaybeUndefinedKind(a) === VAL.BIGINT` — see emitNeg's identical
    // OR-arm comment (§6/§12 Slice 5): keeps this gate VT-Slice-4-independent.
    if (valTypeOf(a) === VAL.BIGINT || censusMaybeUndefinedKind(a) === VAL.BIGINT)
      return bigIntUnary(a, i64v => ['i64.xor', i64v, ['i64.const', -1]], ['f64.const', -1], computedBoxOf(self))
    const v = emit(a); return isLit(v) ? emitNum(~litVal(v)) : typed(['i32.xor', toI32(isI32Num(v) ? v : toNumF64(a, v)), typed(['i32.const', -1], 'i32')], 'i32')
  },
  ...Object.fromEntries([
    ['&', 'and'], ['|', 'or'], ['^', 'xor'], ['<<', 'shl'], ['>>', 'shr_s'],
  ].map(([op, fn]) => [op, (a, b, self) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment
    // above. Number-domain branch mirrors the generic i32 fast path below
    // (`toI32`/`i32.${fn}`) exactly, widened back to f64 via `asF64`.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject(op, a, b)
      return bigIntJointDispatch(a, b,
        op === '<<' || op === '>>' ? (ia, ib) => bigIntShiftIR(op, ia, ib) : (ia, ib) => [`i64.${fn}`, ia, ib],
        (fa, fb) => asF64(typed([`i32.${fn}`, toI32(fa), toI32(fb)], 'i32')), computedBoxOf(self))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject(op, a, b)
      // `<<`/`>>` need the sign-aware direction flip (bigIntShiftIR) — see its
      // own doc comment. `&`/`|`/`^` have no such hazard (bitwise ops are
      // direction-symmetric; only a shift COUNT's sign is meaningful).
      if (op === '<<' || op === '>>') return fromI64(bigIntShiftIR(op, bigIntOperand(a), bigIntOperand(b)))
      return fromI64([`i64.${fn}`, bigIntOperand(a), bigIntOperand(b)])
    }
    if (op === '|') {  // `(x / y) | 0` integer-division idiom → i32.div_s
      const divN = intLiteralValue(b) === 0 ? a : intLiteralValue(a) === 0 ? b : null
      if (Array.isArray(divN) && divN[0] === '/') { const r = tryIntDivTrunc(divN[1], divN[2]); if (r) return r }
    }
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) {
      const la = litVal(va), lb = litVal(vb)
      if (op === '&') return emitNum(la & lb); if (op === '|') return emitNum(la | lb)
      if (op === '^') return emitNum(la ^ lb); if (op === '<<') return emitNum(la << lb)
      if (op === '>>') return emitNum(la >> lb)
    }
    const ca = isI32Num(va) || isLit(va) ? va : toNumF64(a, va)
    const cb = isI32Num(vb) || isLit(vb) ? vb : toNumF64(b, vb)
    return typed([`i32.${fn}`, toI32(ca), toI32(cb)], 'i32')
  }])),
  '>>>': (a, b) => {
    // BigInt has no unsigned right shift — ES2020 §6.1.6.2.11 defines no
    // BigInt::unsignedRightShift; `>>>`'s abstract operation for a BigInt
    // operand throws TypeError unconditionally (unlike the signed bitwise
    // ops above, which fall to i64.shr_s/etc — `>>>` has no i64 arm at all
    // to fall to). Checked before either side emits, so no side effect runs
    // ahead of the throw.
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      err('BigInt has no unsigned right shift (>>>) — TypeError in JS; convert with Number(x) first if you need an unsigned shift')
    const va = emit(a), vb = emit(b)
    if (isLit(va) && isLit(vb)) {
      const r = litVal(va) >>> litVal(vb) // JS uint32 result ∈ [0, 2^32)
      // ≥ 2^31 doesn't fit signed i32: materialize the wrapped bits as an i32 const
      // tagged `.unsigned` so `asF64` lifts via `convert_i32_u`. Emitting `f64.const r`
      // here (the old foldConst path) would `trunc_sat_f64_s`-saturate to INT32_MAX
      // when the enclosing function narrows to an i32 result. Values < 2^31 fold to a
      // plain i32 const (signed == unsigned, stays foldable downstream).
      if (r >= 0x80000000) { const node = typed(['i32.const', r | 0], 'i32'); node.unsigned = true; return node }
      return emitNum(r)
    }
    // F: Mark unsigned so `asF64` lifts via `f64.convert_i32_u` (preserving the
    // [0, 2^32) value range). Without this, `(s >>> 0) / 4294967296` would convert
    // signed for negative-high-bit s values, flipping sign and breaking the
    // canonical "uint32 → f64" idiom used in PRNGs and bit-manipulation code.
    const ca = isI32Num(va) || isLit(va) ? va : toNumF64(a, va)
    const cb = isI32Num(vb) || isLit(vb) ? vb : toNumF64(b, vb)
    const node = typed(['i32.shr_u', toI32(ca), toI32(cb)], 'i32')
    node.unsigned = true
    return node
  },

  // === Control flow ===

  'if': (cond, then, els) => {
    // Dead branch elimination: constant condition → emit only the live branch
    const ce = emit(cond)
    if (isLit(ce)) {
      const v = litVal(ce), truthy = v !== 0 && v === v
      if (truthy) return emitVoid(then)
      if (els != null) return emitVoid(els)
      return null
    }
    // If-conversion (speed tier): `if (cond) x = <cheap pure value>` (no else) → `x = cond ? value
    // : x`, which lowers to a branchless `select`. Removes the data-dependent branch (and its
    // misprediction) from min/max/clamp reductions — e.g. levenshtein's `if (ins < m) m = ins`,
    // ~27% faster — and from heapsort's child pick `if (a[c] < a[c+1]) c++`, the canonical
    // unpredictable compare that costs jz on x86 (Cranelift/V8-x64 keep the branch; Binaryen, which
    // AS uses, selects it). The condition is evaluated exactly once whether we branch or select, so
    // it need only be SIDE-EFFECT-FREE (loads allowed — sort's `a[c] < a[c+1]`); only the assigned
    // VALUE is evaluated unconditionally, hence must be a cheap, trap-free pure expr. `x++`/`x--`
    // are admitted as `x = x ± 1`. The already-emitted condition `ce` is reused (`__emitted`), so a
    // load-bearing condition is not emitted twice.
    if (els == null && ctx.transform.optimize?.boolConvertToSelect && isSideEffectFree(cond)) {
      const asg = Array.isArray(then) && then[0] === ';' && then.length === 2 ? then[1] : then
      const sel = matchVoidLocalStore(asg)
      if (sel) return emitVoid(['=', sel.lhs, ['?:', ['__emitted', ce], sel.val, sel.lhs]])
    }
    const c = ce.type === 'i32' ? ce : toBoolFromEmitted(ce)
    // Flow-sensitive type refinement: narrow types within each branch based on the guard.
    const thenRefs = extractRefinements(cond, new Map(), true)
    const elseRefs = extractRefinements(cond, new Map(), false)

    // Tagged-union branch versioning: several fields read from one unresolved
    // receiver can identify a single compile-time schema. Guard that schema ONCE
    // and emit fixed-slot accesses in the hot arm; every other value executes the
    // original dynamic body. This is the AOT analogue of a polymorphic inline
    // cache and removes one schema dispatch per field from record visitors.
    const emitBranch = (branch, refs) => {
      // An `else if` node is a dispatcher, not one variant body. Speculating
      // the whole remaining chain clones every suffix at every nesting level
      // (quadratic/exponential code growth and tiering pressure). Let its own
      // emitter recurse and speculate only the eventual leaf bodies.
      let spec = ctx.transform.optimize?.speculateSchemaBranches !== false &&
        !(Array.isArray(branch) && branch[0] === 'if')
        ? inferSchemaBranch(branch) : null
      // A sanctioned union CURSOR (analyzeUnionInline) already reads through
      // the packed carrier under discriminant-refinement PROOFS — the union's
      // closure is the guard. Speculating here clones the body into two
      // identical packed arms behind a redundant runtime tag check.
      if (spec && ctx.schema.inlineUnionCursors?.get(ctx.func.current)?.has(spec.name)) spec = null
      if (!spec) return withRefinements(refs, branch, () => emitVoid(branch))
      // A constant tag census predicts one schema, but cannot prove that host
      // or dynamically-constructed objects never carry the same tag. Narrow
      // the version guard to that sid while retaining the dynamic miss arm.
      const hint = refs.get(spec.name)?.schemaHint
      if (hint != null) {
        const schema = ctx.schema.list[hint]
        const slots = new Map()
        let valid = !!schema
        for (const prop of spec.schemaSlots.keys()) {
          const slot = schema?.indexOf(prop) ?? -1
          if (slot < 0) { valid = false; break }
          slots.set(prop, slot)
        }
        if (valid) spec = { ...spec, schemaIds: [hint], schemaId: hint, schemaSlots: slots }
      }

      const fastRefs = new Map(refs)
      mergeRefinement(fastRefs, spec.name, {
        val: VAL.OBJECT, schemaId: spec.schemaId,
        schemaIds: spec.schemaIds, schemaSlots: spec.schemaSlots,
      })
      const fast = withRefinements(fastRefs, branch, () => emitVoid(branch))

      // The fallback is already dominated by `sid !== spec.schemaId`; do not
      // rebuild per-read schema guards/devirt tables inside this cold arm.
      const slow = withSchemaSpeculation(true,
        () => withRefinements(refs, branch, () => emitVoid(branch)))

      const raw = readVar(spec.name)
      // An unresolved schema-bearing value uses the boxed f64 carrier. A raw
      // pointer would already carry ptrAux/schemaId and never reach this pass.
      if (raw.type !== 'f64') return slow
      let schemaGuard = null
      for (const sid of spec.schemaIds) {
        const eq = ['i64.eq',
          ['i64.and', ['i64.reinterpret_f64', readVar(spec.name)], ['i64.const', '0xFFFFFFFF00000000']],
          ['i64.const', i64Hex(BigInt(encodePtrHi(PTR.OBJECT, sid)) << 32n)]]
        schemaGuard = schemaGuard == null ? eq : ['i32.or', schemaGuard, eq]
      }
      return [['if', schemaGuard, ['then', ...fast], ['else', ...slow]]]
    }

    const thenBody = emitBranch(then, thenRefs)
    if (els != null) {
      const elseBody = emitBranch(els, elseRefs)
      return ['if', c, ['then', ...thenBody], ['else', ...elseBody]]
    }
    return ['if', c, ['then', ...thenBody]]
  },

  'for': (init, cond, step, body) => {
    if (body === undefined) return err('for-in/for-of not supported')
    // An enclosing labeled statement (`outer: for …`) hands its label down so `continue outer`
    // can target this loop's continue point. The immediately-enclosed loop consumes it.
    const myLabel = ctx.func.pendingLabel; ctx.func.pendingLabel = null
    const bodyNode0 = body   // identity for assumption owners — survives the hoist rebind below
    const labeledContinue = myLabel != null && hasLabeledContinueTo(body, myLabel)
    // Don't unroll a loop that is the target of a `continue <label>` — unrolling would lose the
    // continue edge. (Plain loops with no labeled-continue still unroll.)
    if (!labeledContinue && (!ctx.transform.optimize || ctx.transform.optimize.smallConstForUnroll !== false)) {
      const unrolled = unrollSmallConstFor(init, cond, step, body)
      if (unrolled) return unrolled
    }
    // for-in over a static schema → unroll with key-literal substitution (folds
    // o[k] to schema slots). Recognized via the for-in-exclusive __keys_ro intrinsic.
    if (!labeledContinue && (!ctx.transform.optimize || ctx.transform.optimize.forInUnroll !== false)) {
      const fu = unrollForIn(init, cond, step, body)
      if (fu) return fu
    }
    // Typed-bounds loop VERSIONING (Root F): a countable loop whose body indexes typed
    // receivers with iv-affine indices no static class proves gets a ONCE-per-entry
    // runtime extent guard. The fast arm re-emits with those (recv, idx) pairs assumed
    // in-bounds — bare loads/stores, i.e. the vectorizer's shapes — while the else arm
    // keeps the checked forms verbatim (also the correct semantics for a failing guard:
    // OOB reads yield undefined, OOB writes are ignored). Guard arithmetic runs in i64:
    // a*(B-1)+b overflows i32 near the edge, and a wrapped guard that passes is heap
    // corruption. `_tbVersioned` brakes the arms' re-entry into this same intercept —
    // keyed by ctx.func identity so a REUSED AST (same source compiled twice, the
    // self-compile warm path) versions afresh in the next compile instead of silently
    // skipping.
    if (!labeledContinue && body._tbVersioned !== ctx.func
        && (!ctx.transform.optimize || ctx.transform.optimize.versionTypedBounds !== false)) {
      const levels = versionableTypedNest(init, cond, step, body, ctx.func.locals)
      if (levels) {
        body._tbVersioned = ctx.func
        // every LIFTED level is proven by THIS guard — brake their own intercepts
        // (re-versioning per level compounds 2^depth checked twins)
        for (const vs of levels) if (vs.bodyNode && !vs.partial) vs.bodyNode._tbVersioned = ctx.func
        // Loop-counter RANGE-PROOF lever (c8700daa), rescued from this guard's OWN
        // re-emission: both arms below re-emit the loop via `emitter['for'](null,
        // cond, step, body)` — init nulled because the REAL init already ran once,
        // just above — and forCounterRange(null, …) can prove nothing from a null
        // init, so the counter's own body-internal arithmetic (e.g. a comma-step
        // dual-IV header's dropped post-increment value) falls to the f64
        // round-trip in BOTH arms. The fact is provable exactly once, from the
        // REAL init still in scope here — unlike the bound-name magnitude lever
        // below (sound only conditional on the guard passing), the counter's own
        // [lo, hi] hull holds unconditionally for either arm: same init/cond/step,
        // only the body's access forms differ.
        const topCounterName = guardCounterName(cond)
        const topCounterRange = topCounterName ? forCounterRange(init, cond, step, topCounterName) : null
        const topCounterRefs = topCounterRange
          ? new Map([[topCounterName, { rlo: topCounterRange[0], rhi: topCounterRange[1] }]]) : null
        const result = []
        if (init != null) result.push(...emitVoid(init))
        const i64c = (n) => ['i64.const', n]
        const ext = (ir) => ['i64.extend_i32_s', ir]
        const conjs = []
        // one evaluation per symbolic-offset slot (a stable name or an invariant pure
        // expr like `y*w`); an 'f64' slot adds `v integral ∧ |v| ≤ 2^31` conjuncts —
        // the int model of `a*iv + v` is exact only for integral v (trunc does NOT
        // distribute over f64 sums)
        const slotKey = (s) => typeof s === 'string' ? s : JSON.stringify(s)
        const slots = new Map()
        const slotI64 = (slot, kind) => {
          const key = slotKey(slot)
          let s = slots.get(key)
          if (s) return s
          if (kind === 'i32') {
            const nT = tempI64('tvm')
            result.push(['local.set', `$${nT}`, ext(asI32(emit(slot)))])
            s = ['local.get', `$${nT}`]
          } else {
            const nF = temp('tvn')
            result.push(['local.set', `$${nF}`, asF64(emit(slot))])
            conjs.push(['f64.eq', ['local.get', `$${nF}`], ['f64.floor', ['local.get', `$${nF}`]]])
            conjs.push(['f64.le', ['f64.abs', ['local.get', `$${nF}`]], ['f64.const', 2147483648]])
            const nT = tempI64('tvm')
            result.push(['local.set', `$${nT}`, ['i64.trunc_sat_f64_s', ['local.get', `$${nF}`]]])
            s = ['local.get', `$${nT}`]
          }
          slots.set(key, s)
          return s
        }
        const slotSum = (base, list, lo = false) => {
          let r = base
          for (const t of list) {
            // a WRAP atom (toroidal iv ternary ∈ [0, B-1]) is one-sided: B-1 into
            // the hi extent, nothing into the lo
            if (t.wrap) {
              if (!lo) r = ['i64.add', r,
                ['i64.mul', i64c(t.k), ['i64.sub', slotI64(t.e, t.kind), i64c(1)]]]
              continue
            }
            const s = slotI64(t.e, t.kind)
            r = ['i64.add', r, t.k === 1 ? s : ['i64.mul', i64c(t.k), s]]
          }
          return r
        }
        // len as ONE inline header load for a RESOLVED elem type (owned byteLen at
        // base-8, view at descriptor[0]; elemCount = byteLen >> shift) — a call in
        // the guard costs per LOOP ENTRY on re-entered inner nests (fft measured
        // 1.35x with calls, parity without); unresolved receivers keep $__len.
        const len64Of = (recv) => {
          const aux = plannedTypedStorageInfo(ctx, recv)?.aux
          if (aux == null) {
            inc('__len')
            return ['i64.extend_i32_u', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(recv))]]]
          }
          const et = aux & 7, isView = (aux & 8) !== 0
          const shift = (aux & 16) ? 3 : et <= 1 ? 0 : et <= 3 ? 1 : et <= 6 ? 2 : 3
          // A ptr-NARROWED receiver (typed param/local carried as a raw i32
          // offset) IS the base — asF64 on it would coerce the offset
          // NUMERICALLY (f64.convert_i32_s) and the box-decode below would
          // extract garbage bits from a plain number (module-global typed
          // array passed as param → versioning guard read a wild length →
          // OOB on a perfectly bounded loop).
          const recvIR = emit(recv)
          // Narrowed signal: an i32-typed emission of a TYPED binding IS the raw
          // data offset (reps carry val=TYPED; ptrKind rides sig narrowing).
          const rr = typeof recv === 'string' ? repOf(recv) : null
          const narrowed = recvIR.type === 'i32' && (rr?.ptrKind === VAL.TYPED || rr?.val === VAL.TYPED)
          const base = narrowed
            ? recvIR
            : ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', asF64(recvIR)], ['i64.const', LAYOUT.OFFSET_MASK]]]
          return ['i64.extend_i32_u', ['i32.shr_u',
            ['i32.load', isView ? base : ['i32.sub', base, ['i32.const', 8]]], ['i32.const', shift]]]
        }
        // one guard covers the whole NEST — each level contributes its own max-iv
        // and extent conjuncts (nested recognizers need the BARE nest in the fast
        // arm, and one guard per nest beats one per row)
        const levelInfo = new Map()
        // Bound-name MAGNITUDE lever: a level's
        // `f64`-kind bound is commonly an invariant EXPRESSION over a free name this
        // guard never separately proves (`w - 1` — the 1px-border stencil interior;
        // `w`/`h` trace to a resize(w,h) runtime param, genuinely unbounded
        // statically — versionableTypedFor's own doc, type.js). The existing
        // `|bound value| ≤ 2^31` conjunct below bounds the COMPOSED expression, not
        // the free name alone, so it can't license i32 arithmetic on `w` itself
        // (subRangeFitsI32/addRangeFitsI32, emit.js, read intExprRange(name) — null
        // today). A dedicated per-name conjunct — same idiom as the SLOT
        // integrality check just below (`f64.eq(v, f64.floor(v))` + a magnitude
        // cap) — proves a REAL, closed hull for the name, fed through
        // withRefinements (flow-types.js) for exactly the fast arm's own
        // re-emission: the SAME channel forCounterRange (this file's loop-counter
        // lever) uses for a proven counter range. `tryStencil`'s `boundPureInv`
        // (src/optimize/vectorize.js) wants a raw i32.sub bound chain — this is
        // what supplies it. ±2^30 (not the full i32 range) leaves headroom for a
        // small-literal adjustment on EITHER side (`w-1` and `w+1` alike) while
        // still being a genuine runtime-checked magnitude, not an assumption.
        const BOUND_NAME_MAG = 1 << 30
        const freeRefs = new Map()
        // Mirrors invariantIdxExpr's OWN grammar (type.js) exactly — the grammar
        // that already gated `bKind` onto this bound in the first place — rather
        // than a generic "every string leaf" walk: `vs.bound` is a SOURCE AST
        // node, and a naive walk would misread a property-key string (`.length`'s
        // `'length'`, a `typed receiver .length` bound already routes to bKind
        // 'i32' via a DIFFERENT branch and needs no help here) as a free
        // variable name — `emit('length')` then throws "not in scope" (FFT kernel
        // regression, caught by test/simd.js's dedupe-lane-locals case). Only a
        // SLOT_OPS binary/unary node recurses; a bare string is a name; literals
        // and anything else (member access, calls) contribute no names — safe by
        // construction, matching invariantIdxExpr's own accepted shapes 1:1.
        const boundFreeNames = (e, out) => {
          if (typeof e === 'string') { out.add(e); return out }
          if (Array.isArray(e) && SLOT_OPS.has(e[0]) && e.length <= 3)
            for (let i = 1; i < e.length; i++) boundFreeNames(e[i], out)
          return out
        }
        for (const vs of levels) {
          // max iv as i64. An 'f64' bound (untyped param, unknown box) converts via
          // ceil (`<`: the max int iv under B) / floor (`<=`) + trunc_sat — never
          // traps — with a `|B| ≤ 2^31` conjunct making the conversion exact: NaN and
          // box bit patterns fail the abs-compare and fall to the checked arm;
          // saturated garbage past the limit is conjunct-dead. i64 extents then never
          // overflow (|terms| ≤ 2^31, a is an i32 literal → |hi| < 2^63).
          // a RANGE-ONLY level guards hull conjuncts alone — no iv, no max-iv
          if (vs.rangeOnly) {
            for (const c of vs.cands) {
              if (c.range.hiName != null) {
                const cS = slotI64(c.range.hiName, exprType(c.range.hiName, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
                conjs.push(['i64.ge_s', cS, i64c(c.range.entryHi + 1)])
                conjs.push(['i64.lt_s', ['i64.add', cS, i64c(c.range.hiBias)], len64Of(c.recv)])
              } else conjs.push(['i64.lt_s', i64c(c.range[1]), len64Of(c.recv)])
            }
            continue
          }
          // maxIv = the TRUE max iv value at PRE-increment access sites:
          // bound−1 (strict) / bound (inclusive). A body-advanced iv (bump>0)
          // exceeds this only AFTER its write — those accesses carry cand.post
          // and their group widens by a·bump in the extent constants below.
          // (The old unconditional widening made `maxIv < len` fail exactly
          // when len == bound — every symmetric half-spectrum loop.)
          const maxIv = tempI64('tvq')
          if (vs.bKind === 'f64') {
            const bF = temp('tvf')
            result.push(['local.set', `$${bF}`, asF64(emit(vs.bound))])
            conjs.push(['f64.le', ['f64.abs', ['local.get', `$${bF}`]], ['f64.const', 2147483648]])
            result.push(['local.set', `$${maxIv}`,
              ['i64.trunc_sat_f64_s', [vs.incl ? 'f64.floor' : 'f64.ceil', ['local.get', `$${bF}`]]]])
            if (!vs.incl) result.push(['local.set', `$${maxIv}`,
              ['i64.add', ['local.get', `$${maxIv}`], i64c(-1)]])
          } else {
            const adj = vs.incl ? 0 : -1
            result.push(['local.set', `$${maxIv}`,
              adj ? ['i64.add', ext(asI32(emit(vs.bound))), i64c(adj)] : ext(asI32(emit(vs.bound)))])
          }
          // Bound-name magnitude lever (see doc above levelInfo): every free NAME
          // this bound reads that lacks a magnitude proof ALREADY gets its own
          // integral+magnitude conjunct and a durable [lo,hi] refinement — for
          // EITHER bKind: exprType's own (type.js) magnitude check can already
          // classify a bound like `w-1` as 'i32' (bKind, driving the i64-extend
          // branch above) while the CODEGEN path for that same expression
          // (emit.js's `-` operator, `subRangeFitsI32`) independently declines —
          // exprType and the runtime arithmetic fits-gate are two different
          // consumers of intExprRange, and only the SECOND is what the fast arm's
          // own re-emission of `cond`/`body` (below) actually calls. Gated on
          // intExprRange (not exprType/storage type): `w`/`h` here are typically
          // ALREADY i32-STORED via the separate, deliberately-scoped
          // "comparison-governed, sound for n≤2^31" storage-typing tolerance
          // (collectBareEscapes/widenLocalTypes) — real for bit-storage (the cell
          // re-truncates every write) but NOT a magnitude proof (c8700daa's own
          // explicit rejection of reusing it as one) — so intExprRange(name) is
          // still null regardless of bKind, and the fits-gate still declines
          // `w-1` without this. A BARE-NAME bound (`vs.bound` itself a string —
          // `i < N`) needs none of this: a comparison between two i32-typed
          // operands is unconditionally safe (no addFitsI32-style overflow to
          // prove), so the conjunct would be pure overhead — skip it (confirmed
          // by test/perf.js's own "no per-iteration i32→f64 widening" pin, which
          // an unconditional walk broke by adding an unused guard-setup convert).
          if (typeof vs.bound !== 'string') for (const nm of boundFreeNames(vs.bound, new Set())) {
            if (freeRefs.has(nm) || intExprRange(nm) != null) continue
            const nF = temp('tvw')
            result.push(['local.set', `$${nF}`, asF64(emit(nm))])
            conjs.push(['f64.eq', ['local.get', `$${nF}`], ['f64.floor', ['local.get', `$${nF}`]]])
            conjs.push(['f64.le', ['f64.abs', ['local.get', `$${nF}`]], ['f64.const', BOUND_NAME_MAG]])
            freeRefs.set(nm, { rlo: -BOUND_NAME_MAG, rhi: BOUND_NAME_MAG })
          }
          levelInfo.set(vs, { maxIv, entryIR: () => vs.startC != null ? i64c(vs.startC) : slotI64(vs.iv, vs.ivKind) })
          // non-unit monotone stride: positivity is the soundness condition
          if (vs.stepBy?.name != null)
            conjs.push(['i64.ge_s', slotI64(vs.stepBy.name, vs.stepBy.kind), i64c(1)])
          // one extent conjunct pair per (recv, a, slots) group: hi = a*maxIv+Σkᵢ·slotᵢ
          // +maxC < len, plus lo = a*entry+Σkᵢ·slotᵢ+minC ≥ 0 — folded when the static
          // start proves it, read from the live iv local otherwise (top level only)
          const groups = new Map(), indGroups = new Map()
          for (const c of vs.cands) {
            if (c.range != null) {
              // interval-hulled idx against a dynamic length (the affine fallback).
              // Numeric hull: one `hi < len` conjunct. Symbolic hull (wrap cursor vs
              // a MUTABLE bound C): cursor ∈ [0, C-1] relative to C's runtime value —
              // `C ≥ entryHi+1` (the entry fits) ∧ `C+bias < len` close it.
              if (c.range.hiName != null) {
                const cS = slotI64(c.range.hiName, exprType(c.range.hiName, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
                conjs.push(['i64.ge_s', cS, i64c(c.range.entryHi + 1)])
                conjs.push(['i64.lt_s', ['i64.add', cS, i64c(c.range.hiBias)], len64Of(c.recv)])
              } else conjs.push(['i64.lt_s', i64c(c.range[1]), len64Of(c.recv)])
              continue
            }
            if (c.ind != null) {
              const gk = c.recv + '\x00' + c.ind
              if (!indGroups.has(gk)) indGroups.set(gk, c)
              continue
            }
            if (c.cursor != null) {
              // MONOTONE CURSOR (glyfparse's `stream[r]`/`stream[r++]`): entryR (read
              // once, at loop entry — same spot every other entry slot is read) plus
              // K·trips plus the access's own K0 offset must clear len. trips reuses
              // the level's own maxIv/entry (type.js's cursorIvOk admits only a
              // unit-per-iteration iv, so trips is exactly the iteration count — no
              // separate trips≥0 conjunct needed: a negative trips means the loop
              // itself never runs, so no access happens regardless of the guard).
              const eT = slotI64(c.cursor, 'i32')
              conjs.push(['i64.ge_s', eT, i64c(0)])
              const info = levelInfo.get(vs)
              const trips = ['i64.add', ['i64.sub', ['local.get', `$${info.maxIv}`], info.entryIR()], i64c(1)]
              let hi = ['i64.add', eT, ['i64.mul', i64c(c.K), trips]]
              if (c.cConst) hi = ['i64.add', hi, i64c(c.cConst)]
              conjs.push(['i64.lt_s', hi, len64Of(c.recv)])
              continue
            }
            const gk = c.recv + '\x00' + c.a + '\x00' + c.slots.map(t => t.k + '*' + slotKey(t.e)).join('+')
            const g = groups.get(gk)
            if (!g) groups.set(gk, { recv: c.recv, a: c.a, slots: c.slots, maxC: c.bConst, minC: c.bConst, anyPost: !!c.post })
            else { g.maxC = Math.max(g.maxC, c.bConst); g.minC = Math.min(g.minC, c.bConst); if (c.post) g.anyPost = true }
          }
          for (const g of groups.values()) {
            // extremes follow the SIGN of a: a·iv is maximal at maxIv for a ≥ 0
            // but at ENTRY for a < 0 (mirror index `N−k` of symmetric fills),
            // and minimal at the other end. post-increment groups see iv up to
            // maxIv+bump — widen through the extent CONSTANT (a·bump).
            const postW = g.anyPost ? g.a * vs.bump : 0
            const hiC = g.maxC + (g.a >= 0 ? postW : 0)
            const loC = g.minC + (g.a < 0 ? postW : 0)
            const entryIR = () => vs.startC != null ? i64c(vs.startC) : slotI64(vs.iv, vs.ivKind)
            let hi = slotSum(['i64.mul', i64c(g.a), g.a >= 0 ? ['local.get', `$${maxIv}`] : entryIR()], g.slots)
            if (hiC) hi = ['i64.add', hi, i64c(hiC)]
            conjs.push(['i64.lt_s', hi, len64Of(g.recv)])
            // a ≥ 0 with a STATIC start: lo = a·startC+minC was validated
            // non-negative at candidate time (slotless), nothing to emit.
            if (g.a >= 0 && vs.startC != null && !g.slots.length) continue
            let lo = slotSum(g.a >= 0 && vs.startC != null ? i64c(g.a * vs.startC)
              : ['i64.mul', i64c(g.a), g.a >= 0 ? slotI64(vs.iv, vs.ivKind) : ['local.get', `$${maxIv}`]], g.slots, true)
            if (loC) lo = ['i64.add', lo, i64c(loC)]
            conjs.push(['i64.ge_s', lo, i64c(0)])
          }
          // induction cursors (`k += step` in a comma step): value at iteration t is
          // entry + slope*t, t ∈ [0, maxIv - ivEntry] — monotone either direction, so
          // BOTH endpoints guard in [0, len) and every intermediate value is covered
          for (const c of indGroups.values()) {
            const kE = c.entryC != null ? i64c(c.entryC)
              : slotI64(c.ind, exprType(c.ind, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
            const slopeLit = intLiteralValue(c.slope)
            const slope64 = slopeLit != null ? i64c(slopeLit)
              : slotI64(c.slope, exprType(c.slope, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
            const ivE = vs.startC != null ? i64c(vs.startC) : slotI64(vs.iv, vs.ivKind)
            const endT = tempI64('tvi')
            result.push(['local.set', `$${endT}`, ['i64.add', kE,
              ['i64.mul', slope64, ['i64.sub', ['local.get', `$${maxIv}`], ivE]]]])
            const len64 = len64Of(c.recv)
            conjs.push(['i64.ge_s', kE, i64c(0)])
            conjs.push(['i64.lt_s', kE, len64])
            conjs.push(['i64.ge_s', ['local.get', `$${endT}`], i64c(0)])
            conjs.push(['i64.lt_s', ['local.get', `$${endT}`], len64Of(c.recv)])
          }
        }
        // FLAT-CURSOR endpoint guards: `j++` once per pixel across the nest —
        // value spans [j0, j0 + slope·(Π trips − (pre ? 1 : 0))]; the steps cap
        // keeps the slope product overflow-free, a negative trip (empty level)
        // fails its conjunct into the checked arm
        for (const cur of levels.cursors ?? []) {
          const j0 = slotI64(cur.name, cur.kind)
          let steps = null
          for (const L of cur.chain) {
            const info = levelInfo.get(L)
            if (!info) { steps = null; break }
            const trip = tempI64('tvt')
            result.push(['local.set', `$${trip}`,
              ['i64.add', ['i64.sub', ['local.get', `$${info.maxIv}`], info.entryIR()], i64c(1)]])
            conjs.push(['i64.ge_s', ['local.get', `$${trip}`], i64c(0)])
            steps = steps ? ['i64.mul', steps, ['local.get', `$${trip}`]] : ['local.get', `$${trip}`]
          }
          if (!steps) { cur.dead = true; continue }
          const stepsT = tempI64('tvs')
          result.push(['local.set', `$${stepsT}`, steps])
          conjs.push(['i64.le_s', ['local.get', `$${stepsT}`], i64c(2147483648)])
          const seen = new Set()
          for (const c of cur.cands) {
            const gk = c.recv + '\x00' + c.post
            if (seen.has(gk)) continue
            seen.add(gk)
            const endT = tempI64('tvz')
            result.push(['local.set', `$${endT}`, ['i64.add', j0,
              ['i64.mul', i64c(cur.slope), c.post ? ['local.get', `$${stepsT}`]
                : ['i64.sub', ['local.get', `$${stepsT}`], i64c(1)]]]])
            conjs.push(['i64.ge_s', j0, i64c(0)])
            conjs.push(['i64.lt_s', ['local.get', `$${endT}`], len64Of(c.recv)])
          }
        }
        let guard = conjs[0]
        for (let k = 1; k < conjs.length; k++) guard = ['i32.and', guard, conjs[k]]
        // arm-scoped assumption MAP key → OWNING loop body: an assumption is honored
        // only while its loop's frame is on the emission stack (typedIdxProven checks
        // frame.bodyNode) — a textual twin of an inner access OUTSIDE that loop (the
        // cursor past its bound) must NOT inherit the proof. Snapshot/RESTORE (not
        // add/delete): unrolls inside the fast arm stamp clone keys that must not
        // survive into the checked arm, which runs exactly when the guard failed.
        const saved = ctx.types.assumedBounds
        const savedHull = ctx.types.assumedConstHull
        ctx.types.assumedBounds = new Map(saved ?? [])
        // Per-receiver guarded CONST hull (typedIdxProven class 4b): every a=0
        // pure-const candidate's extent is guard-checked against recv.length, so
        // the fast arm may assume ANY const index ≤ the receiver's max guarded
        // extent — value-keyed, immune to the clone/rename layers that break the
        // per-node assumption keys (plan unroll + per-arm emit unroll re-mint
        // ids every emission; the biquad cascade lost all 40 coefficient/state
        // assumptions that way and re-emitted the checked forms inside the
        // guarded arm).
        ctx.types.assumedConstHull = new Map(savedHull ?? [])
        for (const vs of levels)
          for (const c of vs.cands) {
            if (c.range == null && c.ind == null && c.a === 0 && (!c.slots || !c.slots.length) && c.bConst >= 0) {
              const h = ctx.types.assumedConstHull.get(c.recv)
              if (!h || c.bConst > h.max) ctx.types.assumedConstHull.set(c.recv, { max: c.bConst, owner: body })
            }
            // TOP-owned, every kind: each kept level is LIFTED — its extents are
            // proven by the top guard reading the inner bound at top entry — so
            // the proof holds anywhere inside the top body. Level-owned scoping
            // (the old form for affine cands) broke exactly when the inner loop
            // UNROLLED in the fast arm: an unrolled loop pushes no frame, so its
            // level-owned assumptions could never validate and the guarded arm
            // re-emitted every checked form (biquad's 40 coefficient reads at
            // 5.6% vs zig-wasm; 1.7% after this fix). Index names are the
            // level's own body-lets/iv (unreachable outside it) or invariant
            // slots — a textual twin outside the level cannot exist with the
            // same key, so top-ownership loses no safety.
            ctx.types.assumedBounds.set(idxKey(c.recv, c.idx), body)
          }
        // cursor claims hold across the WHOLE nest (entry → end) — owned by the top
        for (const cur of levels.cursors ?? [])
          if (!cur.dead) for (const c of cur.cands) ctx.types.assumedBounds.set(idxKey(c.recv, c.idx), body)
        // Bound-name refinements apply ONLY to the fast arm's own re-emission — the
        // checked arm runs exactly when the guard's conjuncts (including the new
        // per-name integral+magnitude ones) DIDN'T all hold, so it must stay
        // unrefined. withRefinements (flow-types.js) itself re-checks isReassigned
        // against `body` as a second, independent safety net.
        const emitArm = () => emitter['for'](null, cond, step, body)
        // topCounterRefs (the counter's own [lo, hi], unconditional) wraps BOTH
        // arms; freeRefs (bound-name magnitude, sound only once the guard has
        // passed) wraps the fast arm alone — see comments above each.
        const fast = withRefinements(topCounterRefs, body,
          () => freeRefs.size ? withRefinements(freeRefs, body, emitArm) : emitArm())
        ctx.types.assumedBounds = saved
        ctx.types.assumedConstHull = savedHull
        const checked = withRefinements(topCounterRefs, body, emitArm)
        const stmts = (r) => Array.isArray(r[0]) ? r : [r]
        result.push(['if', typed(guard, 'i32'),
          ['then', ...stmts(fast)],
          ['else', ...stmts(checked)]])
        return result
      }
    }
    // Lift constant array/object literals out of the loop (allocate once, not per
    // iteration) when they are read-only + non-escaping inside it. Strip them from the
    // body up front so freshBoxed / continue analysis see the reduced body.
    let preLoopLits = []
    if (!ctx.transform.optimize || ctx.transform.optimize.hoistConstLit !== false) {
      const ex = extractHoistableLiterals(body)
      if (ex) { preLoopLits = ex.hoisted; body = ex.body }
    }
    const id = freshId(ctx)
    const brk = `$brk${id}`, loop = `$loop${id}`
    // The cont wrapper is only needed if the body has a `continue` AND there is a step
    // expression — `continue` must jump to before the step. Without a step, `continue`
    // can target the loop label directly, saving a redundant `block`.
    const needsCont = step && (hasOwnContinue(body) || labeledContinue)
    const cont = needsCont ? `$cont${id}` : loop
    const control = { brk, loop: cont, bodyNode: bodyNode0 }
    return withControlFrame(control, frame => {
    if (myLabel != null) frame.contLabel = myLabel   // so `continue <myLabel>` targets this loop's step/test
    // Per-iteration fresh cells for boxed locals declared in the body — allocated
    // at body entry so a closure declared before its binding captures the right
    // cell (sets frame.loopFresh; emitDecl then stores rather than re-allocates).
    const freshBoxed = emitLoopFreshBoxed(body, frame)
    const result = []
    if (init != null) result.push(...emitVoid(init))
    for (const lit of preLoopLits) result.push(...emitVoid(lit))   // allocate hoisted literals once
    // Hoist a loop-invariant immutable-length bound out of the condition. A typed
    // array's `.length` is fixed, so `i < arr.length` otherwise reloads the header
    // (`i32.load (base-8) >> 2`) every iteration for nothing (V8's JIT hoists it).
    // Compute it once into a temp when `arr` is a typed-array var not reassigned in
    // the body. Only the simple top-level comparison forms — anything fancier just
    // keeps the per-iteration eval (correct, only misses the speedup).
    let condForLoop = cond
    if (cond && Array.isArray(cond) && HOIST_CMP.has(cond[0])) {
      const side = immutableLenBound(cond[2], body) ? 2 : immutableLenBound(cond[1], body) ? 1 : 0
      if (side) {
        const lt = tempI32('len')
        result.push(['local.set', `$${lt}`, asI32(emit(cond[side]))])
        condForLoop = cond.slice(); condForLoop[side] = lt
      }
    }
    // Loop-counter RANGE-PROOF lever: `for (let i = C; i < B; i++)` proves a real
    // [lo, hi] hull for `i` — see forCounterRange's own doc. Scoped to exactly
    // this body via withRefinements (flow-types.js), same machinery an `if
    // (x >= 0 && x < W)` branch guard already uses for its own int-range
    // refinement — so intExprRange(i) (and every addFitsI32/mulFitsI32 caller
    // that routes through it) sees the fact for the duration of this emit only.
    const counterName = guardCounterName(cond)
    const counterRange = counterName ? forCounterRange(init, cond, step, counterName) : null
    const counterRefs = counterRange ? new Map([[counterName, { rlo: counterRange[0], rhi: counterRange[1] }]]) : null
    // Loop-guard hull channel (addLiteralFitsI32's doc, above near
    // addRangeFitsI32): `while(name < bound)` / `for(…; name < bound; …)`
    // proves an upper bound for `name` — sound WITHOUT forCounterRange's
    // monotone-step induction (works for a reassigned, non-counter guard
    // variable like heapify's `child`), because it's an emission-position
    // fact torn down at the FIRST write to `name` (writeVar, ir.js), not a
    // whole-body induction hull. `bound`'s own intExprRange needs BOTH sides
    // (gap-(a)'s typed-`.length` fact supplies that for a typed receiver);
    // only the resulting UPPER half is installed here.
    const guardName = Array.isArray(cond) && (cond[0] === '<' || cond[0] === '<=') && typeof cond[1] === 'string' ? cond[1] : null
    const guardBoundRange = guardName ? intExprRange(cond[2]) : null
    // HIR provenance link fact (.work/research.md §BodyModel slice 4): the guard's RHS is a
    // provable COMPILE-TIME CONSTANT exactly when its proven range collapses to a single point —
    // the WAT-level bound the vectorizer later sees must be that SAME i32.const when so (see
    // ir.js's loopPlanLink doc + vectorize.js's assertLoopPlanAgrees). No new semantics:
    // reuses guardBoundRange, above.
    const boundConst = guardBoundRange && guardBoundRange[0] === guardBoundRange[1] ? guardBoundRange[0] : null
    let guardHadPrev = false, guardPrev
    if (guardBoundRange) {
      const map = loopGuardHi()
      guardHadPrev = map.has(guardName)
      guardPrev = map.get(guardName)
      const hi = cond[0] === '<' ? guardBoundRange[1] - 1 : guardBoundRange[1]
      map.set(guardName, guardHadPrev ? Math.min(guardPrev, hi) : hi)
    }
    const emitLoopBody = () => withRefinements(counterRefs, body, () => emitVoid(body))
    const loopBody = []
    if (condForLoop) loopBody.push(['br_if', brk, ['i32.eqz', toBool(condForLoop)]])
    loopBody.push(...freshBoxed)
    if (needsCont) loopBody.push(['block', cont, ...emitLoopBody()])
    else loopBody.push(...emitLoopBody())
    if (guardBoundRange) {
      const map = loopGuardHi()
      if (guardHadPrev) map.set(guardName, guardPrev); else map.delete(guardName)
    }
    if (step) loopBody.push(...emitVoid(step))
    loopBody.push(['br', loop])
    const loopBlockNode = ['block', brk, ['loop', loop, ...loopBody]]
    // HIR provenance link (.work/research.md §BodyModel slice 4; pre-
    // emission move): stamp this WAT loop's originating HIR facts so the vectorizer's
    // dispatch can shadow-assert against them — see ir.js's loopPlanLink doc for the
    // {plan, lowering} split and the identity/fail-open contract. `plan` (id/hull/
    // boundConst) is no longer built HERE — it's minted pre-emission, once per AST
    // loop, by loop-model.js's mintLoopPlans (called from analyzeFuncForEmit /
    // emitClosureBody, before any function's body is emitted), keyed by `bodyNode0`
    // (this loop's OWN body identity — survives both the hoist rebind above and the
    // typed-bounds guard's fast/checked-arm double-emission of this same AST loop,
    // see mintLoopPlans' own doc). A miss (pre-trio spec 2: fail-open) means no HIR
    // facts were minted for this loop — skip the link entirely rather than fabricate
    // one; `lowering` (the WAT-side name map) stays mutable, kept in sync by
    // freshenUnrolledScalarBindings.
    const plan = ctx.plans.loops.get(bodyNode0)
    if (plan) ctx.plans.loweringLinks.set(loopBlockNode, { plan, lowering: { ivName: counterName, guardName } })
    result.push(loopBlockNode)
    return result.length === 1 ? result[0] : result
    })
  },

  'switch': (discriminant, ...cases) => {
    const disc = `${T}disc${freshId(ctx)}`
    ctx.func.locals.set(disc, 'f64')

    const result = [['local.set', `$${disc}`, asF64(emit(discriminant))]]

    for (const c of cases) {
      if (c[0] === 'case') {
        const [, test, body] = c
        const skip = `$skip${freshId(ctx)}`
        // Block: skip if discriminant != test, otherwise execute body
        result.push(['block', skip,
          ['br_if', skip, typed(['f64.ne', typed(['local.get', `$${disc}`], 'f64'), asF64(emit(test))], 'i32')],
          ...emitVoid(body)])
      } else if (c[0] === 'default') {
        result.push(...emitVoid(c[1]))
      }
    }

    return result
  },

  'while': (cond, body) => emitter['for'](null, cond, null, body),
  'label': (name, body) => {
    const brk = `$label${freshId(ctx)}`
    return withControlFrame({ label: name, brk }, () =>
      // Hand the label to the immediately-enclosed loop. A loop consumes the
      // value; the field scope clears it on every exit when no loop does.
      withPendingLabel(name, () => ['block', brk, ...emitVoid(body)]))
  },
  'break': (label) => {
    const idx = label == null
      ? ctx.func.stack.length - 1
      : ctx.func.stack.findLastIndex(frame => frame.label === label)
    if (label != null && idx < 0) err(`break label '${label}' is not in scope — check the spelling, or add a matching \`${label}:\` around an enclosing loop/block`)
    const target = (idx >= 0 ? ctx.func.stack[idx] : loopTop()).brk
    if (!target) err(`break label '${label}' is not in scope`)
    return [...emitFinalizers(idx + 1), ['br', target]]
  },
  'continue': (label) => {
    if (label == null) return [...emitFinalizers(ctx.func.stack.length), ['br', loopTop().loop]]
    // Labeled continue: target the continue point of the loop that adopted this label.
    const idx = ctx.func.stack.findLastIndex(f => f.contLabel === label)
    if (idx < 0) err(`continue label '${label}' is not in scope — check the spelling, or add a matching \`${label}:\` around an enclosing loop`)
    return [...emitFinalizers(idx + 1), ['br', ctx.func.stack[idx].loop]]
  },

  ...callOps,
}
