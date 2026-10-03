/**
 * The Tarjan-verified 15-member SCC (emit/emitDecl/liftOptionalChain/toBool/emitIdentitySafe/emitIdentitySafeArms/storedValueNarrow/argIR/emitCallArgs/emitBoolStr/tryConcatChain/tryConcatBufferDecl/tryI32Index + the 2-member emitVoid⇄emitBlockBody SCC) plus every small helper whose only caller lives inside that SCC. emit() dispatches via ctx.core.emit[op], never a direct call into any family module - this is why every other family module can import from here without a back-edge.
 *
 * @module compile/emit/dispatch
 */

import { HOST_GLOBALS } from '../../autoload.js'
import { DBG_INVARIANTS } from '../../debug.js'
import print from 'watr/print'
import { STR_HCACHE_BIT, HEAP } from '../../../layout.js'
import { ASSIGN_OPS, MUTATE_OPS, T, commaList, firstRefKind, isBlockBody, isReassigned, walkAst } from '../../ast.js'
import { PTR, ctx, err, inc, emitArity, setLinkDemand } from '../../ctx.js'
import {
  keyIndex, int32Bits, callWithArgs, bindingCarrierIR, FALSE_NAN, MAX_CLOSURE_ARITY, TRUE_NAN, WASM_OPS, applyBigintRepresentationAction, asF64, asI32, asI64, asParamType, asPtrOffset, block64, boolBoxIR, boxBigInt, carrierF64, numberCarrierIR, carrierF64Narrow, emitNum, extractF64Bits, flat, fromI64, isBoundName, isGlobal, boxedAddr, boxedPtrTypeEq, isLit, isNullish, isNullishLit, litVal, materializeDeferredBigint, mayYieldUndefOf, maybeUnboxBigInt, mkPtrIR, nullExpr, nullableBoolBoxIR, ptrOffsetIR, readVar, resolveValType, temp, tempI32, tempI64, toI32, toNumF64, toStrI64, truthyIR, typed, unboxBoolIR, undefExpr, valKindToPtr,
} from '../../ir.js'
import { BIGINT_JOINT_BINARY_OPS, isPresentNumber, hasAmbiguousBoolMerge, nullishArm, valTypeOf, boolTagged, mixedBoolKind } from '../../kind.js'
import { VAL, lookupValType, repOf, repOfGlobal, numericStorage, mayBeUndefined } from '../../reps.js'
import { constIntExpr, staticPropertyKey, staticArrayElems, staticObjectProps, intExprRange } from '../../static.js'
import { functionLength } from '../../function.js'
import { exprType, wholeKey, wholeOrMissKey, isTerminator } from '../../type.js'
import {
  BINDING_USE_COMPUTED, BINDING_USE_DECLS, BINDING_USE_KEY, BINDING_USE_KIND, BINDING_USE_OPTIONAL, BINDING_USE_USES, USE, scanBindingUses,
} from '../analyze-scans.js'
import { arrayView, emitArrayViewDef, materializeArrayView } from '../array-view.js'
import { extractRefinements, withRefinements } from '../flow-types.js'
import {
  JOIN_OPS, REP_EDGE_BOX, REP_EDGE_REJECT, REP_EDGE_UNBOX, representationBindingWriteAction, representationCallArgAction,
} from '../representation-plan.js'
import { CARRIER } from '../../summary/contract.js'
import { DERIVED_PROP_MODULES } from '../../prop-modules.generated.js'
import { SITE, allocatesNothing } from '../analyze/frame-effects.js'
import { reachOn } from '../../../module/core/reach.js'
import { GLOBAL_TYPEOF, builtinGlobalOf } from '../../prepare/state.js'
import { CMP_SET, boolEagerBody, copyReceiverFacts, eagerSelectOK, isCanonicalBoolExpr, isCmp, selectOK } from './shared.js'
import { K, NUMBER, hasTag, orAbsent, valOf, core as summaryCore, tagOf as summaryTagOf, tagsOf as summaryTagsOf, bitOf as summaryBitOf, NULL_BITS as SUMMARY_NULL_BITS } from '../../summary/kind.js'


// Ops whose own table handler needs its OUTER node (`self`) to ask the plan
// "should my own value be boxed" — JOIN_OPS (C5b precedent) plus, funded-
// deletion item 4, the unary '-'/'~' and joint-binary census-shaped ops
// (kind.js's canonical BIGINT_JOINT_BINARY_OPS + the two unary op names).
// Threaded through the generic dispatch below exactly like JOIN_OPS
// already was — an opt-in Set, not a blanket `handler(...args, node)` for
// every op, because SOME handlers (variadic ones) take a REST-shaped `args`
// where an appended trailing element would corrupt the operand list.
// `[]` hands its node to the element read: an access node carries its own
// occurrence's bounds proof (type/interval-proof.js).
const SELF_AWARE_OPS = new Set(['u-', '~', '[]', 'postfix', ...BIGINT_JOINT_BINARY_OPS, ...JOIN_OPS])

// Host globals auto-imported as `(import "env" "name" (global … i64))` when
// referenced as a value. Drained from ctx.core.hostGlobals at assembly.

// hoistNestedCalls (plan/inline.js hExpr) names its hoisted `const __h = call(...)`
// temps `${T}inl${uniq}_h` — a single-def, single-use compiler binding by construction
// (each nested-call occurrence gets its own fresh temp, substituted at exactly the one
// site it was found). Recognizing that exact shape lets stripCanon (below) carry
// `.canonOf` provenance through the temp without risking a binding some OTHER reader
// also depends on staying canonical.
const isHoistTemp = (name) => typeof name === 'string' && name.startsWith(T + 'inl') && name.endsWith('_h')

/** Stringify a boolean through the shared conversion, preserving a checked
 *  read's missing value. Present booleans select the two interned literals. */
export const emitBoolStr = (node) =>
  typed(['f64.reinterpret_i64', toStrI64(node, emit(node))], 'f64')

/** Compute a checked index with word operations. Every intermediate must
 * remain an exactly represented integer before the final bounds proof. */
const I32_INDEX_OP = { '+': 'i32.add', '-': 'i32.sub', '*': 'i32.mul' }
const indexWordRange = name => exprType(name, ctx.func.locals) === 'i32' && lookupValType(name) === VAL.NUMBER
  ? repOf(name)?.unsigned ? [0, 4294967295] : [-2147483648, 2147483647] : null
function tryI32Index(e) {
  // Integer literal first — a prepare-wrapped literal `[null, k]` (and a const-int
  // name) is itself an Array, so the operator dispatch below would reject it and
  // bail the WHOLE index to the f64 round-trip. The classic victim is the `+ 1` /
  // `(j + 1)` of a bilinear/stencil gather (`a[(j+1)*W + i + 1]`): one literal leaf
  // forced `convert_i32 … f64.mul/add … trunc_sat_f64_s` across every term.
  const lit = constIntExpr(e)
  if (lit != null) return typed(['i32.const', lit], 'i32')
  // A choice of keys (`hf[x > 0 ? i - 1 : i]`, a clamped neighbour): each arm a word,
  // its hull one an unsigned length test reads exactly; the test runs first, as written.
  if (Array.isArray(e) && e[0] === '?:' && e.length === 4) {
    for (const arm of [e[2], e[3]]) if (Array.isArray(arm) && I32_INDEX_OP[arm[0]]) {
      const r = intExprRange(arm, indexWordRange)
      if (!r || r[0] < -2147483648 || r[1] >= 4294967296) return null
    }
    const a = tryI32Index(e[2]); if (a == null) return null
    const b = tryI32Index(e[3]); if (b == null) return null
    return typed(['if', ['result', 'i32'], toBool(e[1]), ['then', a], ['else', b]], 'i32')
  }
  if (Array.isArray(e)) {
    const inner = I32_INDEX_OP[e[0]]
    if (inner && e[2] != null) {
      // Every intermediate must agree with JS integer arithmetic: a large
      // rounded product can cancel into a small final hull.
      const range = intExprRange(e, indexWordRange)
      if (!range || range[0] < -9007199254740991 || range[1] > 9007199254740991) return null
      const a = tryI32Index(e[1]); if (a == null) return null
      const b = tryI32Index(e[2]); if (b == null) return null
      return typed([inner, a, b], 'i32')
    }
    return null
  }
  return exprType(e, ctx.func.locals) === 'i32' && lookupValType(e) === VAL.NUMBER ? asI32(emit(e)) : null
}
/** A word a guard proved exact (every intermediate an integer, the result
 * within the word: emit/control-flow.js proveGuardedWords), as the word
 * arithmetic of its operands: modulo 2^32, which the exact value lies in.
 * An operand held as a Number (a product of a counter and a dimension the
 * guard snapshotted) is an exact integer too: its ToInt32 is its word. */
function provedWord(e) {
  const lit = constIntExpr(e)
  if (lit != null) return lit === (lit | 0) ? typed(['i32.const', lit], 'i32') : null
  const word = x => typeof x === 'string' && indexWordRange(x) || constIntExpr(x) != null
  if (Array.isArray(e) && (e[0] === '+' || e[0] === '-' || e[0] === '*' && word(e[1]) && word(e[2])) && e.length === 3)
    return typed([I32_INDEX_OP[e[0]], provedWord(e[1]), provedWord(e[2])], 'i32')
  return typeof e === 'string' && indexWordRange(e) ? asI32(emit(e)) : toI32(asF64(emit(e)))
}

/** A key of words by sums and differences with one product among them
 * (`y * w + x`, `(j + 1) * w - i`): its exact integer in i64, or null. Below
 * 2^53 the Number is that integer. Past it the product rounds, but the rest
 * stays under 2^52, so either key lies past 2^52 from zero: no element of a
 * typed array, whose length is a word. */
const WIDE_INDEX_OP = { '+': 'i64.add', '-': 'i64.sub', '*': 'i64.mul' }
function tryWideIndex(e) {
  const unwrap = e => Array.isArray(e) && e[0] === '()' && e.length === 2 ? unwrap(e[1]) : e
  // the magnitude bound of a term and of the terms beside the product, or null: checked before any IR
  let products = 0, rest = 0
  const bound = (e, inProduct) => {
    e = unwrap(e)
    const lit = constIntExpr(e)
    if (lit != null) return Math.abs(lit) <= 2 ** 31 ? Math.abs(lit) : null
    if (typeof e === 'string') { const r = indexWordRange(e); return r ? Math.max(-r[0], r[1]) : null }
    if (!Array.isArray(e) || !WIDE_INDEX_OP[e[0]] || e.length !== 3) return null
    if (e[0] === '*' && (inProduct || ++products > 1)) return null
    const inner = inProduct || e[0] === '*'
    const a = bound(e[1], inner), b = a == null ? null : bound(e[2], inner)
    if (b == null) return null
    if (!inner) for (const t of [e[1], e[2]]) { const u = unwrap(t); if (!(Array.isArray(u) && WIDE_INDEX_OP[u[0]])) rest += t === e[1] ? a : b }
    return e[0] === '*' ? a * b : a + b
  }
  if (!Array.isArray(unwrap(e)) || !WIDE_INDEX_OP[unwrap(e)[0]]) return null
  const total = bound(e, false)
  if (total == null || products !== 1 || total >= 2 ** 63 || rest > 2 ** 52) return null
  const form = e => {
    e = unwrap(e)
    const lit = constIntExpr(e)
    if (lit != null) return ['i64.const', lit]
    if (typeof e === 'string') return [indexWordRange(e)[0] < 0 ? 'i64.extend_i32_s' : 'i64.extend_i32_u', asI32(emit(e))]
    return [WIDE_INDEX_OP[e[0]], form(e[1]), form(e[2])]
  }
  return typed(form(e), 'i64')
}

// `whole` proves a present integer, not its magnitude. `wide` retains a safe
// full integer for a following bounds check. `bounded` supplies the stronger
// proof for this typed access: its key lies in [0, receiver.length). It may
// discard upper bits only together with `whole`, never from range alone.
export const emitIndex = (index, whole = false, wide = false, bounded = false) => {
  // An unsigned bounds test rejects negative words and positive values past
  // 2^31 alike. A hull within [-2^31, 2^32) therefore keeps its low word;
  // beyond it, e.g. 65536 * 65536 would wrap into element zero.
  const range = Array.isArray(index) && I32_INDEX_OP[index[0]] ? intExprRange(index, indexWordRange) : null
  const exact = whole || !Array.isArray(index) || !I32_INDEX_OP[index[0]] ||
    range && range[0] >= -2147483648 && range[1] < 4294967296
  const direct = exact && tryI32Index(index)
  if (direct) return direct
  // A typed access (its consumer tests the full key, or proved it in range):
  // the low word of the exact key
  const wideKey = (wide || bounded) && tryWideIndex(index)
  if (wideKey) {
    if (bounded) return typed(['i32.wrap_i64', wideKey], 'i32')
    const w = tempI64('ixw'), low = typed(['i32.wrap_i64', ['local.tee', `$${w}`, wideKey]], 'i32')
    low.indexWide = ['local.get', `$${w}`]
    return low
  }
  const proven = whole
  whole ||= wholeKey(index)
  // Integral where its typed reads hit: a miss is NaN, which the whole path tests.
  const missable = !whole && wholeOrMissKey(index)
  // `x ± k` with k an i32 and x a name: the key is an integer exactly when x
  // is (a boxed x makes both NaN), so the test reads x alone, where a loop
  // over k leaves it invariant (`a[o + i]`, o read from an offsets table).
  // An x past the i32 range names no element either: with |k| < 2^31 the sum
  // could come back only for an array of 2^31 elements.
  if (!whole && !missable && Array.isArray(index) && (index[0] === '+' || index[0] === '-') && index.length === 3) {
    const [, l, r] = index, i32 = e => exprType(e, ctx.func.locals) === 'i32' || Array.isArray(e) && e[0] == null && (e[1] | 0) === e[1]
    const x = i32(r) ? l : i32(l) && index[0] === '+' ? r : null
    if (typeof x === 'string') {
      const t = temp('ix'), ok = tempI32('ixv'), xs = asF64(emit(x)), get = ['local.get', `$${t}`]
      const out = typed(['block', ['result', 'i32'],
        ['local.set', `$${ok}`, ['f64.eq', ['f64.convert_i32_s', int32Bits(xs)], xs]],
        ['local.set', `$${t}`, asF64(emit(index))],
        ['select', ['i32.trunc_sat_f64_s', get], ['i32.const', -1], ['local.get', `$${ok}`]]], 'i32')
      out.indexValid = ['local.get', `$${ok}`]
      return out
    }
  }
  const nested = Array.isArray(index) && index[0] === '[]'
  if (nested) ctx.types.indexConsumer = (ctx.types.indexConsumer || 0) + 1
  let value
  try { value = emit(index) } finally { if (nested) ctx.types.indexConsumer-- }
  if (value?.type === 'i32' && !value.indexValid) return value
  // The caller proves this exact typed access in bounds. Together with the
  // whole-key proof, its index lies in [0, 2^32): keep that address's low word.
  // Individual arithmetic intermediates still retain their Number semantics.
  // (marked: integer narrowing may take the word by an exact form the interval cannot prove)
  if (bounded && proven) { const w = typed(['i32.wrap_i64', ['i64.trunc_sat_f64_s', asF64(value)]], 'i32'); w.provenWord = true; return w }
  // A checked typed-array access can compare an integer key with the full
  // unsigned length before using its low word as an address. Keep that value
  // once: saturating to i32 first needs two clamps around every wide scale.
  // The existing integer pass lowers exact arithmetic inside this conversion;
  // rounded arithmetic keeps its f64 evaluation. NaN still names no element.
  if (wide && whole && range && Number.isSafeInteger(range[0]) && Number.isSafeInteger(range[1])) {
    const t = temp('ix'), w = tempI64('ixw'), get = ['local.get', `$${t}`]
    const out = typed(['block', ['result', 'i32'],
      ['local.set', `$${t}`, asF64(value)],
      ['local.set', `$${w}`, ['i64.trunc_sat_f64_s', get]],
      ['i32.wrap_i64', ['local.get', `$${w}`]]], 'i32')
    out.indexWide = ['local.get', `$${w}`]
    out.indexValid = ['f64.eq', get, get]
    return out
  }
  // `whole`: a proof already holds the key to a present integer (the interval
  // walk models integer values only).
  // A constant folds exactly in keyIndex; a runtime value saturates (asI32's
  // ToInt32 would wrap 2^32 + 1 to 1).
  if ((whole || missable) && !(Array.isArray(value) && value[0] === 'f64.const')) {
    if (proven) return typed(['i32.trunc_sat_f64_s', asF64(value)], 'i32')
    // An integer-certain name may hold NaN (`Math.floor` of one, `Infinity -
    // Infinity`, a missed typed read), which names no element, where the
    // truncation reads index 0.
    const t = temp('ix'), get = ['local.get', `$${t}`]
    const out = typed(['block', ['result', 'i32'], ['local.set', `$${t}`, asF64(value)],
      ['select', ['i32.trunc_sat_f64_s', get], ['i32.const', -1], ['f64.eq', get, get]]], 'i32')
    out.indexValid = ['f64.eq', get, get]
    return out
  }
  return keyIndex(value)
}


// Scoped FlowState combinators live in ./flow-state.js.

// The summary's kind of `node` picks a truthiness cheaper than the generic
// chain (a number test, the BigInt arm, five sentinel compares): a Boolean,
// nullish included, is the TRUE atom exactly; a value that is never a
// number, string, BigInt or Boolean is truthy iff present. `ir` is the
// node's emitted f64, evaluated once here (a `local.get` reads in place).
function kindTruthyIR(node, ir) {
  const view = ctx.summary?.at(ctx.func.current)
  if (!view) return null
  const NEVER_BY_VALUE = summaryBitOf(K.NUMBER) | summaryBitOf(K.STRING) | summaryBitOf(K.BIGINT) | summaryBitOf(K.BOOL)
  const k = view.kindOfExpr(node)
  if (k == null || k === 0 || summaryTagOf(k) === K.ANY) return null
  const tags = summaryTagsOf(k) & ~SUMMARY_NULL_BITS
  if (tags === 0) return null
  const once = Array.isArray(ir) && ir[0] === 'local.get' ? null : temp('kt')
  const get = () => typed(once ? ['local.get', `$${once}`] : ir, 'f64')
  // A Boolean rides either carrier: the raw 0/1 (a number by value) or the
  // atom box; a nullish value is a box that is not TRUE.
  // A number, present or not (an element read that may miss), is truthy where it
  // is a number other than zero: a box, the undefined one included, is a NaN.
  const test = tags === summaryBitOf(K.BOOL)
    ? ['i32.or', ['i32.and', ['f64.eq', get(), get()], ['f64.ne', get(), ['f64.const', 0]]], ['i64.eq', ['i64.reinterpret_f64', get()], ['i64.const', TRUE_NAN]]]
    : tags === summaryBitOf(K.NUMBER) ? ['i32.and', ['f64.eq', get(), get()], ['f64.ne', get(), ['f64.const', 0]]]
    : (tags & NEVER_BY_VALUE) === 0 ? ['i32.eqz', isNullish(get())]
    : null
  if (!test) return null
  return typed(once ? ['block', ['result', 'i32'], ['local.set', `$${once}`, asF64(ir)], test] : test, 'i32')
}

/** Coerce an AST node to an i32 boolean, folding && / || at the boolean boundary. */
// In a condition, an inherited builtin method is truthy without constructing a
// first-class function. Use the method registry's concrete receiver families;
// registration for some other family does not make a plain object's field exist.
const METHOD_RECEIVERS = [[VAL.MAP, PTR.MAP], [VAL.SET, PTR.SET], [VAL.ARRAY, PTR.ARRAY],
  [VAL.TYPED, PTR.TYPED], [VAL.STRING, PTR.STRING]]
function builtinMethodCondition(node) {
  if (!Array.isArray(node)) return null
  const op = node[0], indexed = op === '[]' || op === '?.[]'
  if (!indexed && op !== '.' && op !== '?.') return null
  const prop = indexed ? staticPropertyKey(node[2]) : node[2]
  if (typeof prop !== 'string') return null
  const families = METHOD_RECEIVERS.filter(([kind]) => {
    const key = kind === VAL.ARRAY && !ctx.core.emit[`.${kind}:${prop}`] && DERIVED_PROP_MODULES[prop]?.includes('array')
      ? `.${prop}` : `.${kind}:${prop}`
    return ctx.core.emit[key] && !ctx.core.getters.has(key)
  })
  if (!families.length) return null
  const recv = temp('method'), tag = tempI32('methodTag')
  const value = asF64(emit(node[1]))
  copyReceiverFacts(node[1], recv)
  const fallback = truthyIR(emit([op, recv, node[2]]))
  let condition = ['i32.const', 0]
  for (const [, ptr] of families)
    condition = ['i32.or', condition, ['i32.eq', ['local.get', `$${tag}`], ['i32.const', ptr]]]
  const own = families.some(([kind]) => !ctx.summary || ctx.summary.memberMayBeOwnOn(prop, kind))
  if (own) {
    ctx.module.include('collection')
    inc('__dyn_has')
    condition = ['if', ['result', 'i32'], condition,
      ['then', ['i32.eqz', ['call', '$__dyn_has',
        ['i64.reinterpret_f64', ['local.get', `$${recv}`]], asI64(emit(['str', prop]))]]],
      ['else', ['i32.const', 0]]]
  }
  inc('__ptr_type')
  return typed(['block', ['result', 'i32'],
    ['local.set', `$${recv}`, value],
    ['local.set', `$${tag}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${recv}`]]]],
    ['if', ['result', 'i32'], condition, ['then', ['i32.const', 1]], ['else', fallback]]], 'i32')
}

export function toBool(node) {
  const op = Array.isArray(node) ? node[0] : null
  if (op === '(') return toBool(node[1])
  if (op === '.' || op === '[]' || op === '()' || op === '?.' || op === '?.[]') {
    const lifted = liftOptionalChain(node, true)
    if (lifted) return lifted
  }
  const method = builtinMethodCondition(node)
  if (method) return method
  if (CMP_SET.has(op)) return emit(node)
  // Canonical boolean chains already have value-preserving range fusion in
  // their emitters. Keep that shared lowering at a condition boundary too.
  if ((op === '&&' || op === '||') && isCanonicalBoolExpr(node)) return emit(node)
  // A negation asks the operand's boolean and flips it: no value is built.
  if (op === '!' && node.length === 2) return typed(['i32.eqz', toBool(node[1])], 'i32')
  if (op === '__eager&&' || op === '__eager||') {
    const la = toBool(node[1]), lb = toBool(node[2])
    if (isCanonicalBoolExpr(node[1]) && isCanonicalBoolExpr(node[2]) && eagerSelectOK(la, lb))
      return typed([op === '__eager&&' ? 'i32.and' : 'i32.or', la, lb], 'i32')
    return op === '__eager&&'
      ? typed(['if', ['result', 'i32'], la, ['then', lb], ['else', ['i32.const', 0]]], 'i32')
      : typed(['if', ['result', 'i32'], la, ['then', ['i32.const', 1]], ['else', lb]], 'i32')
  }
  if (op === '&&') {
    // The right operand runs where the left held: its reads see what the
    // left proved (a guard's conjunct `x < W && a[x]` indexes in bounds).
    const la = toBool(node[1]), lb = withRefinements(extractRefinements(node[1], new Map(), true), node[2], () => toBool(node[2]))
    // `if (a && b)` reaches toBool directly (not the value-producing `&&`
    // emitter below), so apply the same call-free canonical-boolean rule here.
    // Requiring BOTH emitted trees pure makes a nested comparison chain fold
    // recursively to i32.and while checked/raw memory reads and any effect keep
    // short-circuit control. This closes the codec predicate shape where the
    // old immediate-isCmp check handled only the first pair, then rebuilt an
    // if ladder for every remaining comparison.
    if (eagerSelectOK(la, lb) && ((isCmp(node[1]) && isCmp(node[2])) ||
        (boolEagerBody() && isCanonicalBoolExpr(node[1]) && isCanonicalBoolExpr(node[2]))))
      return typed(['i32.and', la, lb], 'i32')
    return typed(['if', ['result', 'i32'], la, ['then', lb], ['else', ['i32.const', 0]]], 'i32')
  }
  if (op === '||') {
    const la = toBool(node[1]), lb = withRefinements(extractRefinements(node[1], new Map(), false), node[2], () => toBool(node[2]))
    if (eagerSelectOK(la, lb) && ((isCmp(node[1]) && isCmp(node[2])) ||
        (boolEagerBody() && isCanonicalBoolExpr(node[1]) && isCanonicalBoolExpr(node[2]))))
      return typed(['i32.or', la, lb], 'i32')
    return typed(['if', ['result', 'i32'], la, ['then', ['i32.const', 1]], ['else', lb]], 'i32')
  }
  const emitted = emit(node)
  const generic = truthyIR(emitted)
  if (Array.isArray(generic) && generic[0] === 'call' && generic[1] === '$__is_truthy') return kindTruthyIR(node, emitted) ?? generic
  return generic
}

/** Emit a call argument ONCE, choosing emit vs emitIdentitySafe up front — the
 *  same single-emission discipline as bridge.js's storedValue chokepoint
 *  (research.md §Carrier invariant), inlined here because emit.js IS emit/
 *  emitIdentitySafe's home module (no bridge indirection needed, but no
 *  after-the-fact carrierF64 rescue is possible either: calling coerceArg
 *  with a plain `emit(node)` result and branching on hasAmbiguousBoolMerge
 *  AFTER the fact would emit `node` a SECOND time via emitIdentitySafe for
 *  the ambiguous case — a real side-effecting double-eval for an arg like
 *  `f() > 0 && 1`). Callers pass this instead of a bare `emit(a)`. */
export const argIR = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : emit(node)
// Narrow-admission twin — see carrierF64Narrow's own doc comment (ir.js) for
// why the SRoA flat-object/array field locals below need THIS, not the plain
// storedValue above: a flat field's reads/writes are all rewritten to plain
// local access, with no registry-aware dynamic reader ever downstream of it.
const storedValueNarrow = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : carrierF64Narrow(node, emit(node))

// A plan BOX/UNBOX must preserve the nullish member of a genuine
// BigInt/nullish ternary. Use AST provenance, never a runtime bit-pattern
// guess: a pure raw BigInt can legitimately equal a reserved atom's bits.
const nodeIsNullishBigintMerge = (node) => Array.isArray(node) && node[0] === '?:' &&
  ((valTypeOf(node[2]) === VAL.BIGINT && nullishArm(node[3])) || (valTypeOf(node[3]) === VAL.BIGINT && nullishArm(node[2])))

/** Coerce an emitted arg IR to match a callee param. Param may carry ptrKind (pointer-ABI
 *  i32 offset), else falls back to numeric WASM type coercion.
 *  `node` (the arg's AST, when the caller has it): a statically-BOOL arg headed
 *  into an UNTYPED f64 param crosses as its TRUE/FALSE atom box — the callee
 *  treats that slot as an opaque value, so identity (typeof/String/strict-eq)
 *  must survive. A val-known param (narrow stamped `p.val`) keeps the raw 0/1
 *  ABI its body assumes. Number arguments normalize only for generic or
 *  nullable parameters, including an active default's incoming undefined lane.
 *  i32/pointer params retain their representation. `ir` must
 *  already be argIR(node)'s result (or ptrKind-appropriate) — this function
 *  itself never emits, only coerces, so it cannot re-decide emit vs
 *  emitIdentitySafe after the fact (see argIR's comment). */
export function coerceArg(ir, param, node, repAction = REP_EDGE_REJECT, func = null) {
  if (param?.ptrKind != null) {
    // PTR.OBJECT never forwards (FORWARDING_MASK — only ARRAY/HASH/SET/MAP
    // headers relocate on growth), so the offset extracts inline instead of
    // the forwarding-aware __ptr_offset call. The union-cursor clone's cell
    // address rides this; watr's box∘unbox folds then erase the round-trip.
    if (param.ptrKind === VAL.OBJECT) return asPtrOffset(ir, param.ptrKind)
    return ptrOffsetIR(ir, param.ptrKind)
  }
  // ProgramIndex boundary facts plus the active RepresentationPlan body action
  // are the sole call-edge carrier authority. A nullable
  // BigInt merge can still carry its nullish sentinel, so normalization must
  // preserve that member instead of treating it as a box or raw i64 payload.
  // Carrier facts describe the BigInt member, not the whole value. A raw
  // schema slot can also contain a Number: BOX needs the shared semantic
  // proof before reinterpreting that Number's bits as a BigInt payload.
  if (node !== undefined && (valTypeOf(node) === VAL.BIGINT || repAction === REP_EDGE_UNBOX || repAction === REP_EDGE_BOX)) {
    if (repAction === REP_EDGE_UNBOX) {
      // maybeUnboxBigInt, not unboxBigInt (range-boundary BOX/UNBOX OOB fix,
      // 2026-08 — see applyBigintRepresentationAction's identical fix, ir.js,
      // for the full mechanism): repAction here is the SAME materializedNames/
      // hostBoxParams fixpoint verdict edgeMaterializable produces, subject
      // to the identical order-sensitivity — a mis-proven raw arg's own low
      // 32 bits (0xFFFFFFFF for the 0x7fffffffffffffffn / 2^64-1-wrapped
      // family) make unboxBigInt's unconditional $__ptr_offset deref trap.
      const t = temp('argbx')
      const tGet = typed(['local.get', `$${t}`], 'f64')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, ir],
        ['if', ['result', 'f64'], isNullish(tGet),
          ['then', tGet],
          ['else', fromI64(maybeUnboxBigInt(tGet))]]], 'f64')
    }
    if (repAction === REP_EDGE_BOX) {
      if (!nodeIsNullishBigintMerge(node)) return applyBigintRepresentationAction(ir, node, repAction)
      const t = temp('argbx')
      const tGet = typed(['local.get', `$${t}`], 'f64')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, ir],
        ['if', ['result', 'f64'], isNullish(tGet),
          ['then', tGet],
          ['else', boxBigInt(asI64(tGet))]]], 'f64')
    }
  }
  const view = func && ir.type !== 'i32' && ctx.summary?.at(func.sig)
  const generic = view && (view.kindOfExpr(param?.name) !== NUMBER ||
    func.defaults && Object.hasOwn(func.defaults, param?.name) && view.defaultMayRun(param.name))
  // A value carrier: an f64 slot, or a host import's i64 box bits. i32 and
  // v128 parameters are numeric positions and keep their representation.
  const carrier = param == null || param.type == null || param.type === 'f64' || param.type === 'i64'
  if (node !== undefined && carrier) {
    if (param == null || param.val == null) return asParamType(carrierF64(node, ir), param?.type)
    if (generic) return asParamType(numberCarrierIR(node, ir), param.type)
  }
  return asParamType(ir, param?.type)
}

/** Pad an emitted-args array up to a signature's arity with type-appropriate
 *  defaults (`i32.const 0` for i32 params, `undefExpr()` for f64). Mutates and
 *  returns `args` for chaining. */
// A missing argument is `undefined` in the parameter's carrier: an i64 host
// import takes the box bits, an i32 slot its zero.
function padArgs(args, params) {
  while (args.length < params.length) {
    const t = params[args.length].type
    args.push(t === 'i32' ? typed(['i32.const', 0], 'i32') : t === 'i64' ? asI64(undefExpr()) : undefExpr())
  }
  return args
}

/** Emit a node list as call arguments for the given param list: per-param
 *  coercion then arity padding. Used at every direct-call site. */
export function emitCallArgs(argNodes, params, func) {
  return padArgs(argNodes.map((a, k) =>
    coerceArg(argIR(a), params[k], a, representationCallArgAction(ctx, a, func, k), func)), params)
}

/** Fuse `a + b` when it tops a string-concat chain of ≥3 leaves: evaluate
 *  each leaf ONCE to an i64 string box (left-to-right — JS ToString order),
 *  measure each with __str_length, allocate the [hash=0][len][bytes]
 *  HCACHE header once, and __str_copy each leaf at its cumulative offset.
 *  Replaces the pairwise lowering's per-`+` alloc + triangular prefix
 *  re-copy. Self-accumulation (`line = line + …`) keeps the head pairwise:
 *  the TAIL fuses to one fresh string and the head takes the existing
 *  bump-extend concatRaw. A total ≤ 6 yields a short HEAP string where
 *  pairwise gave SSO — value-equal (SSO is representation, not semantics).
 *
 *  `bufTarget` (a local name, from tryConcatBufferDecl below): the caller has
 *  proven the chain's result never needs a String identity — every use in this
 *  function is `.length` / `.charCodeAt(i)`, nothing that compares, hashes,
 *  slices, returns, or captures it. The [hash][len] header and the
 *  __mkptr/__sso_norm canonicalization exist ONLY to make the result a
 *  representation-stable String value; skip both and hand back the bare
 *  byte region + its statically-known length as two i32 locals instead of an
 *  f64 box. Disabled under self-accumulation (`headAccum`): a bump-extend
 *  accumulator is read back by ITS OWN next `+`, so it still needs to be a
 *  real String. */
export function tryConcatChain(a, b, selfAccum, bufTarget) {
  // A `+` NODE is a string concat iff a side is statically STRING — the exact
  // gate the pairwise lowering uses. (BOOL/OBJECT must NOT qualify a node:
  // `(x===y) + (u===v)` is NUMERIC bool addition; they only stringify as
  // LEAVES once the node qualifies through a genuine STRING side.)
  const isStr = (n) => valTypeOf(n) === VAL.STRING
  if (!(isStr(a) || isStr(b))) return null
  const leaves = []
  const walk = (n) => {
    if (Array.isArray(n) && n[0] === '+' && n.length === 3 && (isStr(n[1]) || isStr(n[2]))) {
      walk(n[1]); walk(n[2])
    } else leaves.push(n)
  }
  walk(a); walk(b)
  // Self-accumulating head: fuse only the tail, join with bump-extend after.
  const headAccum = selfAccum && leaves[0] === a && typeof a === 'string' ? leaves.shift() : null
  if (leaves.length < 3) return null
  // Every leaf must stringify deterministically at this site: known kinds
  // (STRING/OBJECT/BOOL/NUMBER) or unknown-through-__to_str. BIGINT joins
  // numerically elsewhere — bail so the existing lowering keeps its path.
  for (const l of leaves) if (valTypeOf(l) === VAL.BIGINT) return null
  // Flattening turns each leaf into ToString. An object may instead produce a
  // number through ToPrimitive(default), or mutate a later operand during it.
  // Preserve the pairwise evaluation when either conversion method can run.
  if (ctx.funcs.runtimeRoots.has('__jz_tp_num') && leaves.some(l => {
    const vt = valTypeOf(l)
    return vt == null || vt === VAL.OBJECT
  })) return null
  const asBuf = bufTarget != null && headAccum == null
  if (asBuf) inc('__alloc')
  else inc('__alloc', '__mkptr', '__sso_norm')
  // LITERAL ASCII leaves (the serializer separators — ',', '\n', 'k=' …) carry
  // their bytes and length at compile time: no box/len temps, no __str_length,
  // no __str_copy — the length const-folds into the total and the bytes store
  // directly at the cursor (grouped 4/2/1-wide; watr folds the const totals).
  // Profiled on strbuild: copy+len calls on 1-6 byte parts were 38.7% of a row.
  const litOf = (n) => {
    if (!Array.isArray(n) || n[0] !== 'str' || typeof n[1] !== 'string' || n[1].length === 0) return null
    for (let i = 0; i < n[1].length; i++) if (n[1].charCodeAt(i) > 0x7f) return null
    return n[1]
  }
  const lits = leaves.map(litOf)
  const bT = [], nT = [], lT = leaves.map((_, k) => lits[k] != null ? null : tempI32('cl'))
  const offT = tempI32('co'), curT = tempI32('cu')
  const seq = []
  let litTotal = 0
  leaves.forEach((n, k) => {
    if (lits[k] != null) { litTotal += lits[k].length; return }
    const vt = valTypeOf(n)
    // BOOL renders through emitBoolStr(node); every other leaf emits its value once here.
    const v = vt === VAL.BOOL ? null : emit(n)
    // i32-PROVEN leaf (exactly toStrI64's __i32_to_str class): keep the raw value,
    // not a temp string — __ilen joins the total and __itoa_s renders the digits
    // directly at the cursor. Drops the per-number __i32_to_str (alloc+itoa+mkstr),
    // __str_length and __str_copy — the whole temp-string round trip.
    if ((vt === VAL.NUMBER || vt == null) && v.type === 'i32' && v.ptrKind == null) {
      inc('__ilen', '__itoa_s')
      nT[k] = tempI32('cn')
      seq.push(['local.set', `$${nT[k]}`, v])
      seq.push(['local.set', `$${lT[k]}`, ['call', '$__ilen', ['local.get', `$${nT[k]}`]]])
      return
    }
    inc('__str_length', '__str_copy')
    bT[k] = tempI64('cc')
    seq.push(['local.set', `$${bT[k]}`,
      vt === VAL.BOOL ? ['i64.reinterpret_f64', emitBoolStr(n)] :
      toStrI64(n, v)])   // OBJECT (compile-time ToPrimitive), NUMBER, unknown
    seq.push(['local.set', `$${lT[k]}`, ['call', '$__str_length', ['local.get', `$${bT[k]}`]]])
  })
  const totalIR = () => {
    let t = ['i32.const', litTotal]
    for (let k = 0; k < leaves.length; k++) if (lT[k] != null) t = ['i32.add', t, ['local.get', `$${lT[k]}`]]
    return t
  }
  // asBuf: allocate EXACTLY the bytes (no [hash][len] header — nothing ever
  // reads it back through the header-decoding accessors) and keep the total
  // in its own local rather than the header word, so `.length` reads a plain
  // `local.get` instead of a header re-decode.
  let lenT = null
  if (asBuf) {
    lenT = tempI32('cbl')
    seq.push(['local.set', `$${offT}`, ['call', '$__alloc', ['i32.shl', totalIR(), ['i32.const', 1]]]])
    seq.push(['local.set', `$${lenT}`, totalIR()])
    seq.push(['local.set', `$${curT}`, ['local.get', `$${offT}`]])
  } else {
    seq.push(['local.set', `$${offT}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', totalIR(), ['i32.const', 1]]]]])
    seq.push(['i32.store', ['local.get', `$${offT}`], ['i32.const', 0]])                       // lazy hash cell
    seq.push(['i32.store', 'offset=4', ['local.get', `$${offT}`], totalIR()])                  // len
    seq.push(['local.set', `$${offT}`, ['i32.add', ['local.get', `$${offT}`], ['i32.const', 8]]])
    seq.push(['local.set', `$${curT}`, ['local.get', `$${offT}`]])
  }
  leaves.forEach((n, k) => {
    if (lits[k] != null) {
      const s = lits[k]
      let j = 0
      const at = (o) => o ? [`offset=${o * 2}`, ['local.get', `$${curT}`]] : [['local.get', `$${curT}`]]
      for (; j + 2 <= s.length; j += 2)
        seq.push(['i32.store', ...at(j), ['i32.const', (s.charCodeAt(j) | (s.charCodeAt(j + 1) << 16)) | 0]])
      if (j < s.length) seq.push(['i32.store16', ...at(j), ['i32.const', s.charCodeAt(j)]])
      if (k < leaves.length - 1)
        seq.push(['local.set', `$${curT}`, ['i32.add', ['local.get', `$${curT}`], ['i32.const', s.length * 2]]])
      return
    }
    if (nT[k] != null) {
      // digits render at the cursor; the returned byte count (== $lT) advances it
      seq.push(k < leaves.length - 1
        ? ['local.set', `$${curT}`, ['i32.add',
            ['i32.shl', ['call', '$__itoa_s', ['local.get', `$${nT[k]}`], ['local.get', `$${curT}`]], ['i32.const', 1]], ['local.get', `$${curT}`]]]
        : ['drop', ['call', '$__itoa_s', ['local.get', `$${nT[k]}`], ['local.get', `$${curT}`]]])
      return
    }
    seq.push(['call', '$__str_copy', ['local.get', `$${bT[k]}`], ['local.get', `$${curT}`], ['local.get', `$${lT[k]}`]])
    if (k < leaves.length - 1)
      seq.push(['local.set', `$${curT}`, ['i32.add', ['local.get', `$${curT}`], ['i32.shl', ['local.get', `$${lT[k]}`], ['i32.const', 1]]]])
  })
  // asBuf: return the raw (buf, len) locals directly — no value to box, the
  // statements above already did everything the caller needs.
  if (asBuf) return { statements: seq, buf: offT, len: lenT }
  // __sso_norm epilogue: every producer that hand-writes heap bytes must
  // re-canonicalize — a ≤6-ASCII result MUST be SSO or its hash diverges
  // from a literal/SSO-built equal string (representation-keyed fast paths:
  // the SSO arithmetic mix vs the byte-FNV walk) and keyed lookups miss.
  const fresh = typed(['block', ['result', 'f64'],
    ...seq,
    ['call', '$__sso_norm', mkPtrIR(PTR.STRING, STR_HCACHE_BIT, ['local.get', `$${offT}`])]], 'f64')
  if (headAccum != null)
    return typed(ctx.abi.string.ops.concatRaw(asF64(emit(headAccum)), fresh, ctx, true), 'f64')
  return fresh
}

/** True iff every mention of `name` in the current function is `.length` or a
 *  `.charCodeAt(i)` CALL — the string-buffer-SRoA eligibility gate (see
 *  tryConcatBufferDecl). `scanBindingUses` classifies a `.charCodeAt` member
 *  access uniformly whether or not it's actually invoked (`const f =
 *  line.charCodeAt` reads the same as `line.charCodeAt(0)`), so a second,
 *  structural pass separately confirms every such access sits in a plain
 *  1-arg call position — a bare reference would need a real closure value,
 *  which a dissolved buffer doesn't have. Conservative: any doubt → false. */
function concatBufEligible(name) {
  const body = ctx.func.body
  if (!body) return false
  const uses = scanBindingUses(body).get(name)
  if (!uses || uses[BINDING_USE_DECLS] !== 1) return false
  for (const u of uses[BINDING_USE_USES]) {
    if ((u[BINDING_USE_KIND] === USE.MEMBER_R || u[BINDING_USE_KIND] === USE.MEMBER_CALL) && !u[BINDING_USE_OPTIONAL] &&
        !u[BINDING_USE_COMPUTED] && (u[BINDING_USE_KEY] === 'length' || u[BINDING_USE_KEY] === 'charCodeAt')) continue
    return false
  }
  const consumed = new WeakSet()
  ;(function markCalls(n) {
    if (!Array.isArray(n)) return
    if (n[0] === '()') {
      const callee = n[1], arg = n[2]
      const oneArg = arg != null && !(Array.isArray(arg) && (arg[0] === ',' || arg[0] === '...'))
      if (oneArg && Array.isArray(callee) && callee[0] === '.' && callee[1] === name && callee[2] === 'charCodeAt')
        consumed.add(callee)
    }
    for (let i = 1; i < n.length; i++) markCalls(n[i])
  })(body)
  let bare = false
  ;(function findBare(n) {
    if (!Array.isArray(n) || bare) return
    if (n[0] === '.' && n[1] === name && n[2] === 'charCodeAt' && !consumed.has(n)) { bare = true; return }
    for (let i = 1; i < n.length; i++) findBare(n[i])
  })(body)
  return !bare
}

/** `const line = <concat chain>` whose result is proven (concatBufEligible)
 *  to never need a String identity — dissolve it into raw `(buf, len)` i32
 *  locals via tryConcatChain's bufTarget mode instead of materializing a real
 *  boxed String. Registers `ctx.func.concatBufs` so the `.length` prop-read
 *  hook (module/core.js) and the `.charCodeAt` call strategy
 *  (tryConcatBufCharCodeAt below) route to the raw locals. Returns init
 *  statements to splice, or null when ineligible — emitDecl's normal `const`
 *  path then runs unchanged (purely additive, sound either way). */
function tryConcatBufferDecl(name, init) {
  if (!Array.isArray(init) || init[0] !== '+' || init.length !== 3) return null
  if (!concatBufEligible(name)) return null
  const chain = tryConcatChain(init[1], init[2], false, name)
  if (!chain) return null
  if (!ctx.func.concatBufs) ctx.func.concatBufs = new Map()
  ctx.func.concatBufs.set(name, { buf: chain.buf, len: chain.len })
  return chain.statements
}

/** Guarded dispatch to a speculative typed clone (narrow's speculateTypedParams).
 *  Args evaluate once, in order, into temps; a single masked NaN-box compare per
 *  speculated position proves tag==TYPED && aux==elem-kind (owned — a view or any
 *  other value falls to the original call unchanged, bit-exact). TYPED headers
 *  never relocate (FORWARDING_MASK), so the proven offset is a bare mask — the
 *  same inlining emitSchemaSlotGuarded does for OBJECT. */
export const TYPED_HI_MASK = '0xFFFFFFFF00000000'

/** The value a store into `name` lands. A binding that holds a Boolean beside
 *  another kind (`let v; if (k) v = true; else v = 1`, `let x = c && 1`)
 *  carries its Booleans as atoms where a read may observe which (kind.js
 *  boolTagged): every store boxes a Boolean, a merge keeps its Boolean arm
 *  boxed (emitIdentitySafe), the storage is the tagged f64
 *  (analyze/body-facts.js Pass E), a Boolean store records no flow fact
 *  (setFlowVal), and the reads take the forms a mixed kind takes, a numeric
 *  one converting the atoms (ir/coerce.js toNumF64). A binding every read of
 *  which converts keeps the raw carrier and holds numbers: a value that may
 *  carry an atom (a field, an element, a result) lands as its ToNumber. */
export function boolCarrier(name, node, ir) {
  if (typeof name !== 'string') return ir
  if (!boolTagged(name)) {
    const view = ctx.summary?.at(ctx.func.current)
    return view && ir.type === 'f64' && mixedBoolKind(view.bindingKindOf(name)) && view.numericDemand(name) && valTypeOf(node) !== VAL.NUMBER
      ? toNumF64(node, ir) : ir
  }
  if (valTypeOf(node) !== VAL.BOOL) return ir
  const k = ctx.summary.at(ctx.func.current).kindOfExpr(node)
  return k & SUMMARY_NULL_BITS ? nullableBoolBoxIR(ir) : boolBoxIR(ir)
}
/** `node` emitted as the value a store into the binding `name` lands (boolCarrier). */
export const bindingStore = (name, node) => boolCarrier(name, node, boolTagged(name) && hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : emit(node))

/** Emit let/const initializations as typed local.set instructions. */
// A typed element the emitter loaded bare (its index proven inside the array),
// widened to f64 where the element is narrower. A checked read carries its own tag.
const presentElement = v => Array.isArray(v) && !v.checkedNumRead && (
  v[0] === 'f64.load' ||
  ((v[0] === 'f64.promote_f32' || v[0] === 'f64.convert_i32_s' || v[0] === 'f64.convert_i32_u') &&
    Array.isArray(v[1]) && typeof v[1][0] === 'string' && /^(?:f32|i32)\.load/.test(v[1][0])))

export function emitDecl(...inits) {
  const result = []
  // A `let`/`const` declared inside a loop creates a *fresh* binding each
  // iteration (ECMAScript per-iteration environment). Boxed (closure-captured)
  // locals therefore need a fresh heap cell per iteration — but the cell is
  // allocated at loop-body entry by `emitLoopFreshBoxed` (so a closure declared
  // before the binding captures the right cell), recorded in `frame.loopFresh`.
  // Here we only re-allocate when the loop body did NOT pre-allocate it; a
  // function-level declaration keeps its preboxed cell (forward/mutual-recursion
  // capture relies on it pre-existing).
  const inLoop = ctx.func.stack.some(f => f.loop)
  const loopPrebox = (name) => ctx.func.stack.some(f => f.loopFresh?.has(name))
  for (let ii = 0; ii < inits.length; ii++) {
    const i = inits[ii]
    if (typeof i === 'string') {
      // Numeric-only storage normalizes the missing value on initialization,
      // just as emitDecl does for explicit assignments below.
      const undef = numericStorage(i) ? typed(['f64.const', 'nan'], 'f64') : undefExpr()
      // An uninitialized `let x` holds `undefined` until its first assignment —
      // a read may see the sentinel, so arithmetic on it must coerce (same flag
      // as explicit nullish inits below) UNLESS the first reference in
      // evaluation order is an UNCONDITIONAL write (`let ixSq; while ((ixSq =
      // …) …)` — the fractal-kernel shape): definitely-assigned-before-read
      // needs no coercion, and the per-read canon would break the SIMD
      // recognizers' body shapes. So does a binding the summary finds assigned
      // on every path to each read (summary/definite.js: `let r; if (c) r = a;
      // else r = b`, the result of a spliced body that returns from an arm),
      // whose kind then holds no absence. i32-narrowed locals are exempt either
      // way: the narrowing proof is assigned-before-read, and they zero-init.
      if (ctx.func.locals.get(i) !== 'i32' && firstRefKind(ctx.func.body, i) !== 'write' && repOf(i)?.presence !== 'present')
        (ctx.func.maybeNullish ??= new Set()).add(i)
      if (ctx.func.boxed.has(i)) {
        const cell = ctx.func.boxed.get(i)
        ctx.func.locals.set(cell, 'i32')
        if (inLoop ? !loopPrebox(i) : !ctx.func.preboxed?.has(i))
          result.push(['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]])
        result.push(['f64.store', ['local.get', `$${cell}`], undef])
        continue
      }
      if (isGlobal(i)) {
        // A recorded f64 storage type still carries undefined. Only a narrowed
        // raw carrier may omit this initialization under assigned-before-read.
        if ((ctx.scope.globalTypes.get(i) ?? 'f64') === 'f64') result.push(['global.set', `$${i}`, undef])
        continue
      }
      // An i32-typed local (a narrowed integer index feeder) can't hold the f64
      // NaN-box undef sentinel — and wasm zero-inits locals anyway, so a 0 init is
      // equivalent for the assigned-before-read pattern that earns i32.
      result.push(['local.set', `$${i}`, ctx.func.locals.get(i) === 'i32' ? ['i32.const', 0] : undef])
      const shadow = ctx.func.numShadow?.get(i)
      if (shadow) result.push(['local.set', `$${shadow}`, ['f64.const', 'nan']])
      continue
    }
    if (!Array.isArray(i) || i[0] !== '=') continue
    const [, name, init] = i
    if (typeof name !== 'string' || init == null) continue
    // Flag bindings initialized to a nullish literal so arithmetic on them coerces (null→0,
    // undefined→NaN) rather than propagating the raw sentinel. See toNumF64 / maybeNullish.
    if (isNullishLit(init)) (ctx.func.maybeNullish ??= new Set()).add(name)

    // A rest slot view's `for…of` alias (`let a = __iter_arr(rest)`) reads the
    // same argument slots: nothing materializes (compile/rest-view.js).
    if (ctx.func.restView?.has(name)) { setFlowVal(name, valTypeOf(init), init); continue }

    // An array slice view keeps its array and a range (compile/array-view.js).
    if (ctx.func.arrayViews?.has(name)) {
      const def = emitArrayViewDef(name, init, { emit, toBool })
      if (def) { result.push(...def); continue }
    }

    // SRoA flat object: `let o = {a:1, b:2}` — dissolve fields into `o#i`
    // locals, no heap alloc. Each field local ← asF64(value). Reads/writes are
    // rewritten by the `.`/`[]` flat hooks. See flatObjectCandidate (analyze-scans.js).
    // Monotonic-extension fields (`o.newProp = …`) carry no literal value —
    // they init to undefined so a read before the write matches JS.
    const flatDecl = ctx.func.flatObjects?.get(name)
    if (flatDecl && Array.isArray(init) && (init[0] === '{}' || init[0] === '[' || init[0] === '[]')) {
      // The values are this declaration's own: an unrolled copy of a loop
      // body declares the literal with its counter replaced (`{ a: i }` is
      // `{ a: 1 }` in the second copy), not as the census read it.
      const own = init[0] === '{}' ? staticObjectProps(init.slice(1)) : { names: flatDecl.names, values: staticArrayElems(init) }
      const valueOf = own?.values ? new Map(own.names.map((k, j) => [k, own.values[j]])) : null
      for (let j = 0; j < flatDecl.names.length; j++) {
        const v = valueOf ? valueOf.get(flatDecl.names[j]) : flatDecl.values[j]
        // research.md §Carrier invariant: a flat/SRoA field local is the same
        // untyped boxed-value slot a heap object's schema store is (module/
        // object.js's storedValue, now bridge.js's chokepoint) — the previous
        // bare `asF64(emit(v))` never boxed a proven-BOOL value at all (asF64
        // is pure WASM-type coercion, weaker than carrierF64), and never
        // re-emitted an ambiguous BOOL∪NUMBER merge through emitIdentitySafe
        // either — a distinct, previously-undiscovered site of the same gap.
        // storedValueNarrow, NOT the plain storedValue: see carrierF64Narrow's
        // own doc comment (ir.js) for why an unconditional inline-BIGINT box
        // is wrong here specifically — a flat field's reads/writes are ALL
        // rewritten to plain local access (the `.`/`[]` flat hooks just
        // above, no dynamic $__dyn_get fallback), so there is no registry-
        // aware reader to justify boxing a bare literal/expression on write.
        // BOOL keeps the exact same unconditional atom-box either way.
        result.push(['local.set', `$${name}#${j}`, v === undefined ? undefExpr() : storedValueNarrow(v)])
      }
      continue
    }

    // String-buffer SRoA: `const line = <concat chain>` that never needs a
    // String identity (only `.length`/`.charCodeAt(i)` downstream) dissolves
    // into raw (buf, len) i32 locals — no header, no __mkptr/__sso_norm. See
    // tryConcatBufferDecl.
    if (!ctx.func.boxed.has(name) && !isGlobal(name)) {
      const bufStmts = tryConcatBufferDecl(name, init)
      if (bufStmts) { result.push(...bufStmts); continue }
    }

    // Multi-value ephemeral destructuring — skip heap alloc when temp is
    // assigned from a multi-value call then immediately destructured element-by-element.
    if (name.startsWith(T) && Array.isArray(init) && init[0] === '()' && typeof init[1] === 'string'
      && ctx.funcs.names?.has(init[1])) {
      const func = ctx.funcs.map.get(init[1])
      const n = func?.sig.results.length
      if (n > 1 && !func.rest) {
        const targets = []
        let match = true
        for (let k = 0; k < n && match; k++) {
          const next = inits[ii + 1 + k]
          if (!Array.isArray(next) || next[0] !== '=' || typeof next[1] !== 'string') { match = false; break }
          const rhs = next[2]
          if (!Array.isArray(rhs) || rhs[0] !== '[]' || rhs[1] !== name) { match = false; break }
          const idx = rhs[2]
          if (!Array.isArray(idx) || idx[0] != null || idx[1] !== k) { match = false; break }
          if (ctx.func.boxed.has(next[1]) || isGlobal(next[1])) { match = false; break }
          targets.push(next[1])
        }
        const argList = commaList(init[2])
        if (match && targets.length === n && !argList.some(a => Array.isArray(a) && a[0] === '...')) {
          const emittedArgs = emitCallArgs(argList, func.sig.params, func)
          result.push(callWithArgs(init[1], emittedArgs, func.sig))
          for (let k = n - 1; k >= 0; k--)
            result.push(['local.set', `$${targets[k]}`])
          ii += n
          continue
        }
      }
    }
    // No-copy slice view: `let t = s.slice(...)` whose result sliceViewCandidate
    // proved never escapes — lower the initializer to a SLICE_BIT view instead
    // of a copying slice. Everything downstream treats `t` as an ordinary
    // string. Gated here (not in the analysis) on a statically-known STRING
    // receiver — param types are settled only by emit time — and on plain-local
    // carriers (boxed/global escape); any miss falls back to the copying slice.
    let viewInit = null
    const scratch = ctx.memory.fixed && ctx.memory.scratch.get(ctx.func.current)?.get(init)
    if (scratch) viewInit = ctx.core.emit['#fixedTyped'](init[1].slice(4), scratch)
    if (ctx.func.sliceViews?.has(name) && !ctx.func.boxed.has(name) && !isGlobal(name)
        && Array.isArray(init) && init[0] === '()'
        && Array.isArray(init[1]) && init[1][0] === '.' && init[1][2] === 'slice') {
      const recv = init[1][1]
      const recvVt = valTypeOf(recv)
      if (recvVt === VAL.STRING) {
        const raw = init[2]
        const sa = raw == null ? [] : Array.isArray(raw) && raw[0] === ',' ? raw.slice(1) : [raw]
        viewInit = ctx.core.emit['.string:slice#view'](recv, sa[0], sa[1])
      }
    }

    const isObjLit = Array.isArray(init) && init[0] === '{}'
    if (isObjLit) ctx.schema.targetStack.push({ name, active: true })
    // Emit the initializer in its raw lane, then convert to the local's
    // storage below. A generic argument carrier would box booleans before
    // numeric storage and change the ABI of captured values. Pointer metadata
    // describes the IR node's own storage; a boxed f64 is never an i32 offset.
    // isTaggedLocal (ir.js): a decl initialized directly from a
    // ternary-nullish BIGINT merge (`let r = cond ? BigInt(x) : null`).
    // MUST replicate the '?:' handler's own (narrower) box condition below
    // in this file — bigintArm != null, i.e. exactly ONE arm BIGINT and the
    // OTHER a nullish literal — not the broader `valTypeOf(init) ===
    // VAL.BIGINT` kind.js VT['?:'] carries for ANY two-same-kind arms
    // (VT['?:'] line "if (ta && ta === tb) return ta" — BOTH arms BIGINT,
    // NEITHER nullish, e.g. `neg ? -BigInt(mag) : BigInt(mag)`, ALSO types
    // BIGINT there, but the '?:' handler leaves that shape raw, no box).
    // Using the broad test here previously registered the decl'd name as
    // ternary-boxed even when nothing was ever boxed — readI64 (ir.js) then
    // unboxed a genuinely-raw asF64-merged value as if it were a real
    // PTR.BIGINT pointer, `i64.load`-ing garbage at a bit-derived offset.
    // Found live: jz compiling watr/src/optimize.js's own `_i64Canon`
    // (`neg ? -BigInt(mag) : BigInt(mag)` inlined as `_i64Hex16`'s argument)
    // under JZ_CARRIER_BOX=1 at O3 — `fold()` returned 5.826595490514274e+252
    // instead of 2.000000000000001 (.work/archive/carrier-representation-design.md
    // §13/§14). See isTaggedLocal's own doc comment (ir.js) for the
    // full "why the local's own storage isn't raw here" reasoning and the
    // earlier live incident (`.bigint:toString` on a genuinely ternary-boxed
    // local misread the pointer's bits raw). ctx.func.taggedLocals
    // (compile/index.js enterFunc), NOT updateRep — this is the emission
    // tier, which passes.js's own exit grep asserts never writes durable
    // analysis state; a per-function transient Set is the established
    // pattern here (maybeNullish/closureAux, same file, same shape).
    if (!viewInit && typeof name === 'string' && Array.isArray(init) && init[0] === '?:' &&
        ((valTypeOf(init[2]) === VAL.BIGINT && nullishArm(init[3])) || (valTypeOf(init[3]) === VAL.BIGINT && nullishArm(init[2]))))
      (ctx.func.taggedLocals ??= new Set()).add(name)
    // A tagged Boolean binding (boolTagged): a merge keeps its Boolean arm
    // boxed (emitIdentitySafe), a Boolean initializer boxes below. A closure
    // capturing it copies the atom; an untagged one every read of which
    // converts holds the numeric image, in the closure as well.
    const tagged = boolTagged(name)
    let val = viewInit
    if (!val) {
      if (ctx.func.localReps?.get(name)?.arrayCap != null && Array.isArray(init) && init[0] === '[')
        val = ctx.core.emit['[capacity'](name, init.slice(1))
      else val = tagged && hasAmbiguousBoolMerge(init) ? emitIdentitySafe(init) : emit(init)
    }
    val = applyBigintRepresentationAction(val, init, representationBindingWriteAction(ctx, name, init))
    if (!viewInit) val = boolCarrier(name, init, val)
    val = bindingCarrierIR(name, val, init)
    if (isObjLit) ctx.schema.targetStack.pop()
    // Record the declared name's valTypeOf(init) into the flow overlay right after
    // emitting init — not just for sibling `let`s in the same block (emitBlockBody used
    // to do this itself, one statement late), but for decls that live INSIDE a `for`
    // node's init clause, which emitBlockBody's per-statement loop never sees directly
    // (e.g. src/prepare/index.js's for-of/for-in desugar: `let arrVar = __iter_arr(node),
    // idx = 0, len = arrVar.length`). valTypeOf consults ctx.func.refinements first, so
    // an early-return `Array.isArray` guard on `node` now correctly flows into `arrVar`
    // (and therefore into `len`'s own init two decls later in the same `let`) — every
    // downstream `arrVar[i]`/`.length` in the loop then takes the ARRAY-known fast path
    // instead of falling to the generic __typed_idx/__length dispatch.
    setFlowVal(name, valTypeOf(init), init, val)
    // Direct-call dispatch for const-bound, non-escaping local closures: skip call_indirect.
    // Gate: not boxed (no mutable cross-fn capture), not global, not reassigned in this body.
    // isReassigned is conservative across nested arrow shadows — we miss the optimization
    // rather than emit a wrong direct call.
    if (Array.isArray(init) && init[0] === '=>' && val?.closureBodyName && !ctx.func.boxed.has(name) && !isGlobal(name)
        && ctx.func.body && !isReassigned(ctx.func.body, name)) {
      if (!ctx.func.directClosures) ctx.func.directClosures = new Map()
      ctx.func.directClosures.set(name, val.closureBodyName)
    }
    // Copy propagation of a direct closure: `let g = add`, where `add` is a non-escaping
    // directly-callable closure, makes `g` directly callable too — `g` holds the same
    // closure value, so `g(…)` calls add's body with g's value as env. This is what
    // devirtualizes `let arr = [add]; arr[0](…)`: array scalarization rewrites it to
    // `let g = add; g(…)` before emit (D3), and also covers the explicit `let g = arr[0]`.
    // Same soundness gate as the direct-closure case: stable binding (not reassigned),
    // not boxed, not global.
    if (typeof init === 'string' && ctx.func.directClosures?.has(init) && !ctx.func.boxed.has(name)
        && !isGlobal(name) && ctx.func.body && !isReassigned(ctx.func.body, name)) {
      ctx.func.directClosures.set(name, ctx.func.directClosures.get(init))
    }
    if (ctx.func.boxed.has(name)) {
      const cell = ctx.func.boxed.get(name)
      ctx.func.locals.set(cell, 'i32')
      if (inLoop ? !loopPrebox(name) : !ctx.func.preboxed?.has(name))
        result.push(['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]])
      // i32-narrowed cell stores the raw i32 (see readVar/writeVar). The undef
      // pre-store stays f64: its NaN atom's low word is 0, which is exactly the
      // plain-local default an i32 read of an uninitialized cell must see.
      result.push(ctx.func.cellTypes?.has(name)
        ? ['i32.store', ['local.get', `$${cell}`], asI32(val)]
        : ['f64.store', ['local.get', `$${cell}`], asF64(val)])
      continue
    }
    if (isGlobal(name)) {
      // Module-const array of capture-free closures: record the candidate set for
      // indexed-call devirt (tryConstFnArrayDispatch). Const-only — a reassignable
      // binding could point at a different array whose elements we never saw.
      // A prior dispatch-site arg lattice (argc/numeric row merged into the element
      // bodies' paramTypes/minArgc) was built and reverted at this exact spot: it
      // trusted `constFnArrays`/devirt's safety notion (any bare element READ is
      // harmless — devirt only needs funcIdx IDENTITY), which is too weak here — a
      // bare read `let p = ops[1]` reaches the SAME compiled body through an
      // untracked call path, so a body trusted numeric from the table's call sites
      // alone would skip that path's coercion. This time the resolution below is
      // gated on the STRICTER, dedicated closureTableLatticeCandidates scan
      // (dyn-closure-tables.js), which disqualifies any occurrence of `name` that
      // isn't itself the immediate callee of `name[idx](...)` — a bare element read
      // anywhere in the program fails that scan and the array is left out of the
      // candidate set entirely (test/closures.js's alias/arity pin covers exactly
      // this shape and must keep passing unnarrowed).
      if (val.fnElements && ctx.scope.consts?.has(name))
        (ctx.scope.constFnArrays ||= new Map()).set(name, val.fnElements)
      if (val.fnElements && ctx.scope.closureTableLatticeCandidates?.has(name))
        resolveClosureTableParamLattice(name, val.fnElements)
      // Const binding of a STATIC array literal: record base/len (+ the box bits as
      // identity) for optimize's foldStaticConstArrayReads. Same const-only logic.
      if (val.staticOff != null && ctx.scope.consts?.has(name))
        (ctx.scope.staticArrs ||= new Map()).set(name,
          { off: val.staticOff, len: val.staticLen, bits: extractF64Bits(val) })
      // Unboxed pointer const globals carry the raw i32 offset; init coerces via asPtrOffset.
      // Only an i32-STORED global is a raw pointer carrier — an f64 global holds a
      // NaN-boxed value, so coercing its init to an i32 offset (asPtrOffset → i32.wrap)
      // would store i32 into an f64 global (invalid wasm). Mirror readVar's storage gate.
      const grep = repOfGlobal(name)
      if ((ctx.scope.globalTypes.get(name) || 'f64') === 'i32' && grep?.ptrKind != null) {
        result.push(['global.set', `$${name}`, asPtrOffset(val, grep.ptrKind)])
        continue
      }
      // Pre-folded numeric const globals have their init baked into an *immutable* decl
      // (`(global $x i32 (i32.const V))`) — skip the runtime init (global.set on an
      // immutable global is invalid anyway). But a const typed only by integer-global
      // inference (or a mutable global narrowed to i32) keeps the declareGlobal-default
      // `(mut … (i32.const 0))` decl, so its real — possibly non-foldable — initializer
      // must still run (e.g. `const V = NULLISH + 1` where NULLISH is a cross-module /
      // dynamic const: V is i32-typed but unfolded, and without this it stays 0).
      if (ctx.scope.globalTypes.has(name)) {
        if (ctx.scope.consts?.has(name) && !ctx.scope.globals.get(name)?.mut) continue
        const gt = ctx.scope.globalTypes.get(name)
        result.push(['global.set', `$${name}`, gt === 'i32' ? asI32(val) : asF64(val)])
        continue
      }
      result.push(['global.set', `$${name}`, asF64(val)])
      continue
    }
    const localType = ctx.func.locals.get(name) || 'f64'
    const ptrKind = repOf(name)?.ptrKind
    // A binding the summary lets be absent, initialized from an element the
    // emitter loaded without a check, one that threw for a missing element
    // (`throwAbsent`) or a proved pointer: this definition is present. One whose
    // elements may be null or undefined themselves (`[undefined]` beside
    // `[{ b0 }]`) holds whatever the element holds.
    if (localType === 'f64' && !ctx.func.boxed?.has(name) &&
        (presentElement(val) || val.presentRead === true || val.ptrKind != null || val.srcPtrKind != null) && mayBeUndefined(name) &&
        !hasTag(ctx.summary?.at(ctx.func.current)?.kindOfExpr(name) ?? 0, K.NULLISH)) (ctx.func.presentInits ??= []).push(name)
    // ptrKind inheritance for alias-init decls is predicted at PLAN time
    // (inheritPtrAliases — slice-4 P1); emit only asserts parity here.
    // Miss (val carries a ptrKind the plan didn't predict) means the predictor
    // lost an init form; drift (plan predicted, emit's val disagrees) means a
    // rep changed between plan and emit. Both are predictor bugs — fail loud.
    // `val`'s own pointer kind: a plain unboxed pass-through carries `.ptrKind`
    // directly (i32-typed); a value that took the storedValue chokepoint may
    // have been boxed to f64 along the way (carrierF64→asF64→boxPtrIR),
    // whose result carries the ORIGIN kind under `.srcPtrKind` instead — a
    // DELIBERATELY different name from `.ptrKind` (ir.js boxPtrIR) so this
    // read-only parity check can't be confused with the i32-storage dispatch
    // tag `.ptrKind` itself means everywhere else. The two are mutually
    // exclusive (one lives on i32 nodes, the other only on boxPtrIR's f64
    // output), so `??` is an unambiguous merge, not a priority guess.
    const valPtrKind = val.ptrKind ?? val.srcPtrKind
    if (DBG_INVARIANTS) {
      if (ptrKind == null && valPtrKind != null && localType === 'i32' && !ctx.func.boxed?.has(name))
        throw new Error(`P1 predictor miss: ${ctx.func.current?.name || '(top)'}/${name} init carries ptrKind=${valPtrKind} unpredicted`)
      if (ptrKind != null && ctx.func.p1Predicted?.has(name) && valPtrKind !== ptrKind)
        throw new Error(`P1 predictor drift: ${ctx.func.current?.name || '(top)'}/${name} predicted ${ptrKind}, emit sees ${valPtrKind}`)
    }
    let coerced
    if (ptrKind != null) {
      // Unboxed pointer local — extract i32 offset from NaN-boxed f64 via reinterpret, not numeric trunc.
      // CLOSURE init carries funcIdx in val.closureFuncIdx — a table index MINTED at
      // emission, i.e. emission state, not an analysis fact. Carry it in the per-function
      // closureAux channel (slice-4 P2) so a later asF64 (escape: store, return,
      // indirect-call rebox) reconstructs the correct table slot; readVar consults it.
      // First write wins (parity with the retired rep write's aux==null guard).
      if (ptrKind === VAL.CLOSURE && val.closureFuncIdx != null && repOf(name)?.ptrAux == null &&
          !ctx.func.closureAux?.has(name))
        (ctx.func.closureAux ??= new Map()).set(name, val.closureFuncIdx)
      coerced = val.ptrKind === ptrKind ? val
        : typed(['i32.wrap_i64', ['i64.reinterpret_f64', asF64(val)]], 'i32')
    } else {
      // val.type !== 'i32' here means val is f64-typed. That's either a genuine
      // NUMBER (emit(init) on an arithmetic/mixed expr — real ToInt32 applies) or,
      // when init is statically BOOL-typed, a storedValue/carrierF64-boxed TRUE/FALSE
      // NaN atom (boolBoxIR) — the ONLY way a BOOL-typed init ever emits as f64 (plain
      // emit() of a BOOL always yields i32 0/1, taking the val.type==='i32' branch
      // above). toI32 is ECMAScript ToInt32: NaN → 0. Both TRUE_NAN and FALSE_NAN are
      // NaN bit patterns, so toI32(val) collapses BOTH atoms to i32 0, permanently
      // erasing the boolean — a category error (bit-pattern unboxing needs unboxBoolIR's
      // shift+mask, not numeric truncation). This was latent (never exercised) as long
      // as no decl-init call site fed a BOOL local through storedValue; named + fixed
      // here so the decl-init WALL's storedValue substitution stops corrupting BOOL
      // locals narrowed to i32 storage (research.md §Carrier invariant, MECHANISM C).
      // Reuse the checked-index arithmetic proof for a word destination:
      // every intermediate stays exact before its final ToInt32. If any
      // product can round, keep the already-emitted Number calculation.
      coerced = localType === 'v128' ? val : localType === 'f64' ? asF64(val)
        : val.type === 'i32' ? val
        : valTypeOf(init) === VAL.BOOL ? unboxBoolIR(val)
        : Array.isArray(init) && I32_INDEX_OP[init[0]] ? (repOf(name)?.provedWord ? provedWord(init) : tryI32Index(init) ?? toI32(val)) : toI32(val)
    }
    // `let x = 0` at function scope is normally elided — WASM zero-inits locals. But loop
    // unrolling flattens iteration bodies into one scope, so the 2nd+ `let x = 0` are
    // genuine RE-inits between iterations (e.g. a nested reduce's accumulator). Elide only
    // the FIRST per name; emit the rest as resets. (Names are preserved — no renaming.)
    if (localType === 'f64' && numericStorage(name)) {
      coerced = toNumF64(init, val)
      // The binding stores the normalized Number, not the initializer's absence.
      ctx.func.localValTypesOverlay?.set(name, NUMBER)
    }
    const zeroInit = isLit(coerced) && coerced[1] === 0 && !Object.is(coerced[1], -0) && !ctx.func.stack.length
    if (!zeroInit || ctx.func.zeroInitSeen?.has(name)) {
      result.push(['local.set', `$${name}`, coerced])
      const shadow = ctx.func.numShadow?.get(name)
      if (shadow) result.push(['local.set', `$${shadow}`, toNumF64(init, typed(['local.get', `$${name}`], 'f64'))])
      // Record the def node (by reference, not a copy) so stripCanon's single-use
      // hoist-temp lookup (see isHoistTemp above) can mutate it in place later.
      if (localType === 'f64' && isHoistTemp(name)) (ctx.func.hoistTempDefs ??= new Map()).set(name, coerced)
    } else (ctx.func.zeroInitSeen ??= new Set()).add(name)
  }
  return result.length === 0 ? null : result.length === 1 ? result[0] : result
}

/** Emit node in void context: emit + drop any value. Block bodies route through emitBlockBody. */
export function emitVoid(node) {
  if (isBlockBody(node)) return emitBlockBody(node)
  const ir = emit(node, 'void')
  const items = flat(ir)
  if (ir?.type && ir.type !== 'void') items.push('drop')
  return items
}

// Record a name's valTypeOf(rhs) fact into the live localValTypesOverlay layer (tier #2
// in reps.js's lookup priority — see lookupValType). `let`/`const` decls record this
// themselves at their emit site (emitDecl, right after each `emit(init)`); this helper
// covers the remaining case emitBlockBody drives directly: a bare `name = rhs`
// reassignment statement.
function setFlowVal(name, vt, expr, value) {
  if (!ctx.func.localValTypesOverlay || !isBoundName(name)) return
  // A captured cell can change in user code between operands of one
  // expression. Its joined kind remains valid; one store's kind does not.
  if (ctx.func.boxed?.has(name)) { ctx.func.localValTypesOverlay.delete(name); return }
  // A name reassigned somewhere inside a LOOP body (while/do/for/for-in/for-of,
  // at any nesting depth within it) carries NO overlay fact anywhere in this
  // block, ever: a loop's body is emitted once but RUNS repeatedly, so a fact
  // recorded before the loop (or earlier in the very same body, on a prior
  // iteration) cannot be trusted the next time the same physical code runs —
  // `let x = [7,8]; while (c) { use(x); x = 5 }` must not let `use(x)` trust
  // the pre-loop ARRAY fact, because on iteration 2 x is really 5 (OOB through
  // the ARRAY fast path). See collectLoopBlocked below for the reachability
  // rule (only a write that crosses a loop boundary counts). A write reachable
  // only through if/try/catch/finally does NOT block here — see
  // nestedWritesOf's doc comment for why those invalidate position-sensitively
  // instead, in emitBlockBody's own per-statement loop.
  if (ctx.func.flowValBlocked?.has(name)) return
  // A tagged Boolean binding (boolTagged) holds a Boolean as its atom: a flow
  // fact that the value is a Boolean, or a number where a Boolean merge's
  // arm may be its atom, would read the atom as a raw number. A store of
  // another kind (an array, a number) is that kind until the next.
  if (boolTagged(name) && (vt === VAL.BOOL || hasAmbiguousBoolMerge(expr))) { ctx.func.localValTypesOverlay?.delete(name); return }
  const k = value?.checkedNumRead || vt === VAL.NUMBER && mayYieldUndefOf(expr, value) ? orAbsent(NUMBER)
    : value?.presentNumRead || vt === VAL.NUMBER && isPresentNumber(ctx, expr) ? NUMBER : ctx.summary?.at(ctx.func.current).kindOfExpr(expr)
  // A nullable BigInt operation also produces Number on its absent arm.
  // Its payload-oriented VT must not turn the stored union into raw BigInt.
  if (vt === VAL.BIGINT && k != null && hasTag(k, K.NUMBER)) {
    ctx.func.localValTypesOverlay.set(name, k)
    return
  }
  if (vt) ctx.func.localValTypesOverlay.set(name, k != null && ctx.summary.valOfKind(vt === VAL.NUMBER ? summaryCore(k) : k) === vt ? k : vt)
  else ctx.func.localValTypesOverlay.delete(name)
}

const FLOW_LOOP_OPS = new Set(['while', 'for'])

// Names assigned at a NESTED position within `node` (anything except a
// top-level `name = rhs` statement head or top-level decl head, both
// re-recorded by the emit drivers that pass them directly to setFlowVal) —
// split by whether the write is reachable WITHOUT crossing a loop boundary.
// Walks into closures too — a closure assigning an outer name can run between
// the recording and any later read. ++/-- count as assignments (conservative:
// their result is numeric, but invalidating keeps the rule uniform).
//
// The split matters because the two cases need different treatment:
//   - loopWrites (any FLOW_LOOP_OPS ancestor between the write and `node`):
//     the write's containing loop body is static-once/dynamic-many, so NO
//     fact for this name is safe ANYWHERE in the current block, including
//     before the loop starts (setFlowVal's whole-block flowValBlocked gate,
//     unchanged from before this split existed).
//   - flatWrites (no loop ancestor — reachable only through if/try/catch/
//     finally, which run their body at most once per pass through the
//     enclosing block): a fact recorded by a statement BEFORE this one is
//     still exactly as trustworthy as it always was; only statements AFTER
//     this one must stop trusting it. The caller (emitBlockBody) deletes
//     these names from the live overlay right after emitting `node`, instead
//     of never letting them be recorded at all — the whole-block veto was
//     needlessly retroactive for this case (audit: `var`-hoisted `object =
//     {…}` reassigned a second time inside an unrelated try/catch elsewhere
//     in the function blinded even the FIRST, textually-dominating read).
function nestedWritesOf(node, loopWrites) {
  const flatWrites = new Set()
  const walk = (n, inLoop) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    // A decl's `['=', name, init]` pairs are DECLARATIONS, not reassignments
    // (same as isReassigned's let/const handling) — a nested `for (let x = …)`
    // init must not count as a write; only a true write in cond/step/body does.
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=' && d[2] != null) walk(d[2], inLoop)
      }
      return
    }
    if (FLOW_LOOP_OPS.has(op)) inLoop = true
    if ((ASSIGN_OPS.has(op) || op === '++' || op === '--') && typeof n[1] === 'string')
      (inLoop ? loopWrites : flatWrites).add(n[1])
    for (let i = 1; i < n.length; i++) walk(n[i], inLoop)
  }
  if (!Array.isArray(node)) return flatWrites
  const op = node[0]
  if (op === '=' && typeof node[1] === 'string') { walk(node[2], false); return flatWrites }   // top-level target re-records
  if (op === 'let' || op === 'const') {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (Array.isArray(d) && d[0] === '=' && d[2] != null) walk(d[2], false)   // decl head re-records; walk init
    }
    return flatWrites
  }
  walk(node, false)
  return flatWrites
}

/** Emit block body as flat list of WASM instructions. Unwraps {} and delegates to emitVoid per statement.
 *  Also drives early-return refinement: `if (!guard) return/throw` narrows `guard` for the
 *  rest of the enclosing block. Refinements added here are rolled back on block exit. */
// The names a statement reads an element or a field of, or stores an element
// into, on every path through it, the stored ones marked: the operands an operator
// always evaluates, never an arm, a right side that may not run, a loop body
// or a closure. A statement that leaves hands nothing to what follows it.
const elementUses = (n, out) => {
  if (!Array.isArray(n)) return out
  const op = n[0]
  if (op == null || op === 'str' || op === '=>' || op === 'return' || op === 'throw' || op === 'break' || op === 'continue') return out
  if (op === 'if' || op === '?:' || op === '?' || op === '&&' || op === '||' || op === '??' || op === '?.' || op === '?.()' || op === '?.[]' || op === 'while') return elementUses(n[1], out)
  if (op === 'for') { elementUses(n[1], out); return elementUses(n[2], out) }
  if (op === 'catch' || op === 'finally' || op === 'label') return out
  if ((op === '[]' && n.length === 3 || op === '.' && typeof n[2] === 'string') && typeof n[1] === 'string' && !out.has(n[1])) out.set(n[1], false)
  if (MUTATE_OPS.has(op) && Array.isArray(n[1]) && n[1][0] === '[]' && n[1].length === 3 && typeof n[1][1] === 'string') out.set(n[1][1], true)
  for (let i = 1; i < n.length; i++) elementUses(n[i], out)
  return out
}

/** The names statement `s` proves present, among `checked` (the receivers the
 *  emitter checked, throwing for a missing one, while it emitted `s`): read or
 *  stored through on every path, bindings nothing assigns. */
export const provedPresent = (s, checked) => {
  const out = []
  if (!checked?.length || !ctx.func.body) return out
  for (const [name] of elementUses(s, new Map())) {
    if (!checked.includes(name) || ctx.func.refinements?.get(name)?.notNullish) continue
    if (isGlobal(name) ? ctx.scope.consts?.has(name) : !ctx.func.boxed?.has(name) && !isReassigned(ctx.func.body, name)) out.push(name)
  }
  return out
}

// The operation a statement runs first: the leftmost one its operands reach
// through reads and operators (a name or a literal runs nothing), or the
// statement itself where it calls, stores or branches.
const IN_ORDER = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '<', '<=', '>', '>=',
  '==', '!=', '===', '!==', 'u-', 'u+', '!', '~', '.', '[]'])
const runsNothing = (e) => !Array.isArray(e) || e[0] == null || e[0] === 'str'
const firstOp = (e) => {
  if (runsNothing(e)) return null
  const op = e[0]
  if (op === 'let' || op === 'const') return Array.isArray(e[1]) && e[1][0] === '=' ? firstOp(e[1][2]) : null
  if (op === '=' && typeof e[1] === 'string') return firstOp(e[2])
  if (!IN_ORDER.has(op)) return e
  for (let i = 1; i < e.length; i++) { const r = firstOp(e[i]); if (r) return r }
  return e
}
// `const p = a[i]` followed by a statement that first reads a field of `p`:
// the element read, whose only missing value is absence.
const projectedNext = (s, next) => {
  if (!Array.isArray(s) || (s[0] !== 'const' && s[0] !== 'let') || s.length !== 2) return null
  const d = s[1], init = Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' ? d[2] : null
  if (!Array.isArray(init) || init[0] !== '[]' || init.length !== 3) return null
  const first = firstOp(next)
  if (!Array.isArray(first) || first[0] !== '.' || first[1] !== d[1] || typeof first[2] !== 'string') return null
  const k = ctx.summary?.at(ctx.func.current)?.kindOfExpr(init)
  return k == null || hasTag(k, K.NULLISH) ? null : init
}

export function emitBlockBody(node) {
  const inner = node[1]
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  const out = []
  const accumulated = []
  const frame = ctx.func
  const prevValOverlay = frame.localValTypesOverlay
  frame.localValTypesOverlay = new Map(prevValOverlay || [])
  // Loop-reachable-write blocklist for this block (setFlowVal's whole-block
  // gate — see its doc comment). Per-block own-scan is sufficient: an outer
  // name blocked in the outer block never entered the outer overlay (which
  // this block's overlay copies), and a name reassigned at THIS block's top
  // level re-records right after the assignment (dominating the rest of this
  // block). `flatWrites[i]` (position-sensitive; see nestedWritesOf) holds the
  // non-loop nested writes for stmts[i] alone — the loop below deletes those
  // names from the live overlay right after passing stmts[i], instead of
  // vetoing them for the whole block up front.
  const prevFlowBlocked = frame.flowValBlocked
  const loopBlocked = new Set()
  const flatWrites = stmts.map(s => nestedWritesOf(s, loopBlocked))
  frame.flowValBlocked = loopBlocked
  // A name this block proves present reads so to the summary's consumers too
  // (the query layer's `present` mark, as flow-types.js withRefinements sets it).
  const view = ctx.summary?.at(frame.current), presented = []
  const markPresent = (name) => { if (view?.present && !view.isPresent(name)) { view.present(name); presented.push(name) } }
  try {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i]
      if (s == null || typeof s === 'number') continue
      // Each cell is allocated at its first dominating use (placePreboxedLocalInits).
      const cellInits = frame.preboxInits?.get(s)
      if (cellInits) out.push(...cellInits)
      const presentFrom = frame.presentInits?.length ?? 0
      const savedFrom = frame.savedStores?.length ?? 0, checkedFrom = frame.checkedRecv?.length ?? 0
      // `const p = a[i]` whose next statement first reads a field of `p`: the
      // read throws for a missing element itself (module/array.js
      // `throwAbsent`), as the field read would before anything else runs.
      const prevThrow = frame.throwAbsent, absent = projectedNext(s, stmts[i + 1])
      if (absent) frame.throwAbsent = absent
      try { out.push(...emitVoid(s)) } finally { frame.throwAbsent = prevThrow }
      // A receiver the statement read an element of or stored one into on
      // every path, and checked (the emitter threw for a missing one), holds
      // an object for the rest of this block: a binding of the function
      // nothing assigns. One the fixed store (emit-assign.js) saved for the
      // reset stays saved.
      const saved = frame.savedStores ? frame.savedStores.splice(savedFrom) : null
      const checked = frame.checkedRecv ? frame.checkedRecv.splice(checkedFrom) : null
      if (frame.body) for (const [name, stored] of elementUses(s, new Map())) {
        const cur = ctx.func.refinements?.get(name)
        const keep = stored && saved?.includes(name) && !cur?.saved
        if (!keep && (cur?.notNullish || !checked?.includes(name))) continue
        const bound = isGlobal(name) ? ctx.scope.consts?.has(name) : !frame.boxed?.has(name) && !isReassigned(frame.body, name)
        if (!bound) continue
        accumulated.push([name, cur])
        ;(ctx.func.refinements ??= new Map()).set(name, { ...cur, notNullish: true, ...(keep ? { saved: true } : null) })
        markPresent(name)
      }
      // A declaration initialized from a present element or pointer (emitDecl)
      // holds a present value in this block while nothing below assigns it.
      if (frame.presentInits && frame.presentInits.length > presentFrom) {
        const declared = Array.isArray(s) && (s[0] === 'let' || s[0] === 'const')
        for (const name of frame.presentInits.splice(presentFrom)) {
          if (!declared) continue
          let reassigned = false
          for (let j = i + 1; j < stmts.length; j++) if (isReassigned(stmts[j], name)) { reassigned = true; break }
          if (reassigned) continue
          const refinements = ctx.func.refinements ??= new Map()
          const cur = refinements.get(name)
          accumulated.push([name, cur])
          refinements.set(name, cur ? { ...cur, notNullish: true } : { notNullish: true })
        }
      }
      // Constant branch folding may expose a return or throw that the source
      // statement's shape did not prove. Neither form can reach the next
      // statement, whose reads and type checks must remain unevaluated.
      if (isTerminator(s) || isTerminator(out[out.length - 1])) break
      // Position-sensitive invalidation FIRST, re-record SECOND: stmts[i]'s
      // own top-level target (if any) is the authoritative post-statement
      // state and must win over a same-statement nested self-write (e.g. a
      // closure IIFE'd into its own RHS that also happens to assign the
      // target name) — an edge case, but cheap to order correctly.
      for (const name of flatWrites[i]) frame.localValTypesOverlay.delete(name)
      // `let`/`const` decls self-record via emitDecl; only a bare reassignment needs it here.
      if (Array.isArray(s) && s[0] === '=' && typeof s[1] === 'string') setFlowVal(s[1], valTypeOf(s[2]), s[2])
      // After an `if (cond) terminator` — including a terminator else-if LADDER
      // (`if (c0) return … else if (c1) return …`) — narrow types from the
      // negated conditions for subsequent statements. Control reaching the next
      // statement implies ¬cN for every level whose then-arm terminates, up to
      // the first non-terminator arm (control can fall out of that one, but any
      // such path still passed the falsy tests above it, so facts collected
      // BEFORE it stay sound). Negative discriminant facts stack level by level
      // (excludeIntegerDiscriminant reads the accumulating map first), so a
      // closed-union receiver narrows to the trailing singleton — the canonical
      // tag-dispatch-with-trailing-fallback shape.
      // Skip names that are reassigned later — refinement would be unsound past
      // the assignment — or inside the fall-through tail arm.
      if (Array.isArray(s) && s[0] === 'if' && isTerminator(s[2])) {
        const refs = new Map()
        let tail = s
        while (Array.isArray(tail) && tail[0] === 'if' && isTerminator(tail[2])) {
          extractRefinements(tail[1], refs, false)
          tail = tail[3]
        }
        for (const [name, fact] of refs) {
          if (tail != null && isReassigned(tail, name)) continue
          let reassigned = false
          for (let j = i + 1; j < stmts.length; j++)
            if (isReassigned(stmts[j], name)) { reassigned = true; break }
          if (reassigned) continue
          const refinements = ctx.func.refinements ??= new Map()
          const cur = refinements.get(name)
          accumulated.push([name, cur])
          // Merge so sibling early-returns layering on the same name compose
          // (e.g. `if (typeof x === 'string') return; if (Array.isArray(x)) return;`
          // leaves both `notString: true` and would-be array exclusion stacked).
          refinements.set(name, cur ? { ...cur, ...fact } : fact)
        }
      }
    }
  } finally {
    frame.localValTypesOverlay = prevValOverlay
    frame.flowValBlocked = prevFlowBlocked
    for (const name of presented) view.unpresent(name)
    // Restore prior refinements on block exit.
    for (let i = accumulated.length - 1; i >= 0; i--) {
      const [name, prev] = accumulated[i]
      if (prev === undefined) ctx.func.refinements.delete(name); else ctx.func.refinements.set(name, prev)
    }
  }
  return out
}

// .work/archive/todo.md §deletion-sweep — identity-safe re-emission of an
// ambiguous BOOL-merge node (hasAmbiguousBoolMerge, src/kind.js). Generalizes
// the '?:'/'&&'/'||'/'??' handlers' own per-arm box-then-select shape below
// (the "materialize it per-arm here, BEFORE the raw-bit collapses below erase
// it" comment on '?:') with their NUMBER exclusion LIFTED: those handlers
// deliberately keep a BOOL∪NUMBER arm pair RAW (the benign arithmetic-context
// coercion this whole design works around), so a BOOL arm's atom identity is
// lost the moment `emit(node)` runs. This function is the escape hatch, used
// ONLY at identity-observing consumer sites (guarded by hasAmbiguousBoolMerge)
// — everywhere else keeps calling plain `emit(node)`, so non-ambiguous nodes
// (the overwhelming majority — kernel-parity's byte-identity gate depends on
// it) never pay for this at all.
//
// Recurses into arm positions via emitIdentitySafe (not emit): a nested
// ambiguous merge inside an arm that itself resolves via the ordinary
// same-kind branch (hasAmbiguousBoolMerge's own "recursive through nested
// merges" case) gets its OWN box decision applied at its own level, exactly
// mirroring how the predicate itself recurses. Any node that isn't itself an
// ambiguous merge — including every non-merge leaf recursion bottoms out on —
// degrades to plain `emit(node)`, byte-identical to the general path.
//
// NO unboxing anywhere: nothing at the guarded consumer sites currently
// expects a raw atom, only a correctly-identity-carrying f64 value.
//
// Gate split from body (emitIdentitySafeArms): hasAmbiguousBoolMerge only
// recognizes a join whose OTHER arm resolved to NUMBER (the specific benign-
// coercion collapse its own doc describes) — it says nothing about a join
// whose other arm's kind never resolved AT ALL (`true || undeclaredIdent`:
// the RHS's valType is null, not NUMBER, so the merge reads as "not
// ambiguous" even though the taken BOOL arm still needs its atom). Audit-#12
// BOOL_CARRIER family, logical-or/-and short-circuit-vs-strict-eq shape
// (S11.11.1_A2.1_T4/S11.11.2_A2.1_T4/A4_T4): `(true || x) === true` compiled
// `(true||x)` through the plain asF64(emit()) fallback (strictA unresolved,
// not proven BOOL) while `true` on the other side boxed to its atom via
// carrierF64 — mismatched carriers, bit-compare false. emitStrictEq calls
// emitIdentitySafeArms directly (bypassing this gate) exactly there, once its
// OWN structural check (mayCarryRawBool) proves a BOOL arm is structurally
// reachable — every other caller keeps going through the gated wrapper below,
// unchanged.
export function emitIdentitySafe(node) {
  if (!Array.isArray(node) || !hasAmbiguousBoolMerge(node)) return emit(node)
  return emitIdentitySafeArms(node)
}
export function emitIdentitySafeArms(node) {
  const [op] = node
  if (op === '(') return emitIdentitySafe(node[1])
  if (op === ',') return block64(...node.slice(1, -1).flatMap(emitVoid),
    asF64(emitIdentitySafe(node[node.length - 1])))
  if (op === '?:') {
    const [, a, b, c] = node
    const ca = toBool(a)
    if (isLit(ca)) { const v = litVal(ca), truthy = v !== 0 && v === v; markDropped(truthy ? c : b); return truthy ? emitIdentitySafe(b) : emitIdentitySafe(c) }
    const cond = ca
    const thenRefs = extractRefinements(a, new Map(), true)
    const elseRefs = extractRefinements(a, new Map(), false)
    const vb = withRefinements(thenRefs, b, () => emitIdentitySafe(b))
    const vc = withRefinements(elseRefs, c, () => emitIdentitySafe(c))
    const vtbM = resolveValType(b, valTypeOf, lookupValType)
    const vtcM = resolveValType(c, valTypeOf, lookupValType)
    const fb = vtbM === VAL.BOOL ? boolBoxIR(vb) : asF64(numberCarrierIR(b, vb))
    const fc = vtcM === VAL.BOOL ? boolBoxIR(vc) : asF64(numberCarrierIR(c, vc))
    const ib = ['i64.reinterpret_f64', fb], ic = ['i64.reinterpret_f64', fc]
    const bits = selectOK(cond, fb, fc)
      ? ['select', ib, ic, cond]
      : ['if', ['result', 'i64'], cond, ['then', ib], ['else', ic]]
    return typed(['f64.reinterpret_i64', bits], 'f64')
  }
  if (op === '&&' || op === '||') {
    const [, a, b] = node
    const va = emitIdentitySafe(a)
    const refs = extractRefinements(a, new Map(), op === '&&')
    const vtA = resolveValType(a, valTypeOf, lookupValType)
    const vtB = resolveValType(b, valTypeOf, lookupValType)
    const fb0 = withRefinements(refs, b, () => emitIdentitySafe(b))
    const fb = vtB === VAL.BOOL ? boolBoxIR(fb0) : asF64(numberCarrierIR(b, fb0))
    if (vtA === VAL.BOOL) {
      // A Boolean left operand is its own condition: one raw i32 test, the
      // atom materialized only for the arm that yields the operand itself
      // (the tee of its box read back through the generic truthiness paid a
      // helper call per `isArray(x) && …`).
      const c = tempI32('lb')
      const raw = truthyIR(va)
      let cond
      if (Array.isArray(raw) && raw[0] === 'call' && raw[1] === '$__is_truthy') {
        // An f64 Boolean carrier of either form: the raw 0/1 (a number by
        // value) or the atom box; evaluated once.
        const t = temp('lbv'), get = () => typed(['local.get', `$${t}`], 'f64')
        cond = typed(['block', ['result', 'i32'], ['local.set', `$${t}`, asF64(va)],
          ['local.tee', `$${c}`, ['i32.or', ['i32.and', ['f64.eq', get(), get()], ['f64.ne', get(), ['f64.const', 0]]], ['i64.eq', ['i64.reinterpret_f64', get()], ['i64.const', TRUE_NAN]]]]], 'i32')
      } else cond = typed(['local.tee', `$${c}`, raw], 'i32')
      const own = boolBoxIR(typed(['local.get', `$${c}`], 'i32'))
      return op === '&&'
        ? typed(['if', ['result', 'f64'], cond, ['then', fb], ['else', own]], 'f64')
        : typed(['if', ['result', 'f64'], cond, ['then', own], ['else', fb]], 'f64')
    }
    const t = temp()
    const fa = asF64(numberCarrierIR(a, va))
    const generic = truthyIR(typed(['local.tee', `$${t}`, fa], 'f64'))
    const teedCond = Array.isArray(generic) && generic[0] === 'call' && generic[1] === '$__is_truthy'
      ? typed(['block', ['result', 'i32'], ['local.set', `$${t}`, fa], kindTruthyIR(a, typed(['local.get', `$${t}`], 'f64')) ?? typed(['call', '$__is_truthy', ['i64.reinterpret_f64', ['local.get', `$${t}`]]], 'i32')], 'i32')
      : generic
    return op === '&&'
      ? typed(['if', ['result', 'f64'], teedCond, ['then', fb], ['else', ['local.get', `$${t}`]]], 'f64')
      : typed(['if', ['result', 'f64'], teedCond, ['then', ['local.get', `$${t}`]], ['else', fb]], 'f64')
  }
  if (op === '??') {
    const [, a, b] = node
    const va = emitIdentitySafe(a)
    const vtA = resolveValType(a, valTypeOf, lookupValType)
    const vtB = resolveValType(b, valTypeOf, lookupValType)
    const t = temp()
    const fa = vtA === VAL.BOOL ? boolBoxIR(va) : asF64(numberCarrierIR(a, va))
    const fb0 = emitIdentitySafe(b)
    const fb = vtB === VAL.BOOL ? boolBoxIR(fb0) : asF64(numberCarrierIR(b, fb0))
    return typed(['if', ['result', 'f64'],
      ['i32.eqz', isNullish(['local.tee', `$${t}`, fa])],
      ['then', ['local.get', `$${t}`]],
      ['else', fb]], 'f64')
  }
  return emit(node)
}

/** Hoist `headExpr` into a temp, evaluate it once, and yield `body(t)` when the
 *  temp is non-nullish, else `otherwise` (undefined by default). Shared by every `?.`-shaped optional
 *  emitter (chain-lift, `?.`, `?.[]`, `?.()` via `evalOnce` + this helper) so
 *  the nullish-guard scaffold stays in one place. */
function withNullGuard(headExpr, body, tag = 'ng', otherwise = undefExpr(), present = false) {
  const t = temp(tag)
  if (present) return block64(['local.set', `$${t}`, headExpr], asF64(body(t)))
  // asF64 on the taken arm: the continuation may come back i32-narrowed (an
  // int-certain slot read at O0 kept its raw i32), and the f64-typed if would
  // fail validation ("type error in fallthru: expected f64, got i32").
  return block64(
    ['local.set', `$${t}`, headExpr],
    ['if', ['result', 'f64'],
      ['i32.eqz', isNullish(['local.get', `$${t}`])],
      ['then', asF64(body(t))],
      ['else', otherwise]])
}

/** Closure-TABLE call-site PARAM lattice — resolution side. Called once, when
 *  the `const NAME = [...arrows]` decl itself emits (isGlobal path above) —
 *  `elements` is module/array.js's `fnElements` (`{idx, name: bodyName}` per
 *  element, in literal order). Merges the evidence recordClosureTableCallSite
 *  accumulated (keyed by array name, since elements had no bodyName yet at
 *  each call site's own emit time) into EVERY element's OWN
 *  ctx.closure.paramTypes/paramTypedCtors/minArgc row — the same lattice
 *  emitClosureBody (compile/index.js) already reads for a directly-bound
 *  closure (tryDirectClosureCall). Runs strictly before these bodies compile:
 *  buildStartFn emits the whole top-level program (this decl included) before
 *  its own compilePendingClosures() call compiles anything registered here. */
export function resolveClosureTableParamLattice(arrName, elements) {
  const evid = ctx.scope.closureTableArgEvidence?.get(arrName)
  if (!evid) return
  const pt = (ctx.closure.paramTypes ||= new Map())
  const tc = (ctx.closure.paramTypedCtors ||= new Map())
  const mn = (ctx.closure.minArgc ||= new Map())
  for (const { name: bodyName } of elements) {
    let row = pt.get(bodyName); if (!row) pt.set(bodyName, row = [])
    let tcRow = tc.get(bodyName); if (!tcRow) tc.set(bodyName, tcRow = [])
    for (let i = 0; i < evid.numRow.length; i++) {
      row[i] = row[i] === undefined ? evid.numRow[i] : (row[i] && evid.numRow[i])
      tcRow[i] = tcRow[i] === undefined ? evid.tcRow[i] : (tcRow[i] !== evid.tcRow[i] ? null : tcRow[i])
    }
    const prevMn = mn.get(bodyName)
    mn.set(bodyName, prevMn === undefined ? evid.minArgc : Math.min(prevMn, evid.minArgc))
  }
}

// === Emit dispatch ===

// Optional-chain continuation: `a?.b.c` → if `a` nullish then undefined, else `a.b.c`.
// Per ECMAScript, an optional access short-circuits the entire continuation, not just
// its own access. Without this, `a?.b.c` parses as `(a?.b).c` and `.c` runs on the
// nullish result of `a?.b`, returning a wrong value (or trapping in typed lowerings).
//
// At the outermost `.` / `[]` / `()` whose leftmost descent contains an optional, hoist
// the deepest such optional's head into a temp, nullish-guard, and rebuild the chain
// with that optional replaced by a regular access. The single guard short-circuits the
// whole continuation. Nested optionals further inside the chain are left intact and
// handle their own short-circuiting on recursion.
function liftOptionalChain(node, condition = false, receiver = null, missing = null) {
  const path = []
  let cur = node
  while (Array.isArray(cur) && (cur[0] === '.' || cur[0] === '[]' || cur[0] === '()' ||
                                 cur[0] === '?.' || cur[0] === '?.[]' || cur[0] === '?.()')) {
    if (cur[0] === '(') break
    path.push(cur)
    cur = cur[1]
  }
  // Find the deepest optional with continuation outside it. optIdx === 0 means the
  // chain root itself is optional with no continuation — handled by the regular
  // `?.` / `?.[]` / `?.()` emitters.
  let optIdx = -1
  for (let i = path.length - 1; i >= 1; i--) {
    if (path[i][0] === '?.' || path[i][0] === '?.[]' || path[i][0] === '?.()') {
      optIdx = i
      break
    }
  }
  if (optIdx <= 0) return null
  const opt = path[optIdx]
  // TypedArray.reduce's result is raw in the BigInt domain when the summary
  // proves the call BigInt (its callback's result, not the receiver's element
  // kind: `a?.reduce(() => 42, 0)` on a BigInt64Array is a Number), and
  // optional chaining adds an undefined arm: box inside the successful branch
  // before the carriers join.
  const boxedTypedReduce = opt[0] === '?.' && opt[2] === 'reduce' && optIdx >= 1 && path[optIdx - 1][0] === '()' &&
    summaryTagOf(summaryCore(ctx.summary?.at(ctx.func.current)?.kindOfExpr(path[optIdx - 1]) ?? 0)) === K.BIGINT &&
    ctx.summary.at(ctx.func.current).typedPayloadCtorOfExpr(opt[1]) != null
  let head = opt[1], callReceiver = null
  while (Array.isArray(head) && head[0] === '(') head = head[1]
  if ((ctx.closure.receiver || ctx.transform.targetProfile.envImports && valTypeOf(head) !== VAL.CLOSURE) && opt[0] === '?.()' && Array.isArray(head) && ['.', '?.', '[]', '?.[]'].includes(head[0]))
    callReceiver = temp('ocrecv')
  const headIR = callReceiver ? emitReference(head, callReceiver) : emit(opt[1])
  const guarded = withNullGuard(asF64(headIR), t => {
    // The temp holds the head's present value: the continuation resolves a
    // Map's method or an object's slot through the head's own kind.
    // Only a head of one concrete value kind seeds the temp (an object with
    // its shape known): a union or an unknown shape keeps the generic reads.
    // A BigInt keeps its representation plan: the temp holds a boxed carrier
    // no plan describes, so it stays untyped there.
    const view = ctx.summary?.at(ctx.func.current)
    const headKind = view?.kindOfExpr(opt[1])
    const headVt = view && headKind && !hasTag(headKind, K.BIGINT) ? valOf(summaryCore(headKind)) : null
    const seed = headVt && (headVt !== VAL.OBJECT || view.objectSidOfExpr(opt[1]) != null)
    if (seed) { view.alias(t, opt[1]); ctx.func.localValTypesOverlay.set(t, headVt) }
    let rebuilt = opt[0] === '?.'   ? ['.',  t, opt[2]]
                : opt[0] === '?.[]' ? ['[]', t, opt[2]]
                                    : ['()', t, opt.length < 3 ? null : opt.length === 3 ? opt[2] : [',', ...opt.slice(2)], callReceiver]
    for (let i = optIdx - 1; i >= 0; i--) rebuilt = [path[i][0], rebuilt, ...path[i].slice(2)]
    // The arm joins the undefined atom, so the continuation crosses tagged:
    // a BOOL (a Set's `has`, a class method's result) as its atom, a raw
    // BigInt payload (a class function's, a typed reduce's) boxed; its type
    // resolves while the alias holds.
    try {
      if (condition) return asF64(toBool(rebuilt))
      const result = receiver ? emitReference(rebuilt, receiver)
        : (missing && liftOptionalChain(rebuilt, false, null, missing)) || emit(rebuilt)
      return boxedTypedReduce || result.bigintRaw === true ? asF64(boxBigInt(asI64(result)))
        : numberCarrierIR(rebuilt, carrierF64Narrow(rebuilt, materializeDeferredBigint(result)))
    } finally { if (seed) view.unalias(t) }
  }, 'oc', missing ? asF64(emit(missing)) : undefExpr(), ctx.summary?.at(ctx.func.current).kindOfExpr(opt[1]) === NUMBER)
  return condition ? truthyIR(guarded) : guarded
}

// A grouped optional member still calls a present method through normal dispatch.
// When its chain short-circuits, the outer call evaluates arguments and throws.
export function emitGroupedCall(callee, args) {
  while (Array.isArray(callee) && callee[0] === '(') callee = callee[1]
  if (!Array.isArray(callee) || !['.', '[]', '?.', '?.[]'].includes(callee[0])) return null
  return liftOptionalChain(['()', callee, args], false, null, ['()', [null, undefined], args])
}

// A method reference carries its receiver through grouping and optional chains.
// Capture the final member's base once; a short-circuited chain leaves the
// function undefined, so arguments still run before the call throws.
export function emitReference(node, receiver) {
  if (!Array.isArray(node)) return emit(node)
  if (node[0] === '(') return emitReference(node[1], receiver)
  const lifted = liftOptionalChain(node, false, receiver)
  if (lifted) return lifted
  if (!['.', '[]', '?.', '?.[]'].includes(node[0])) return emit(node)
  const external = ctx.transform.targetProfile.envImports && valTypeOf(node[1]) == null
  const value = asF64(emit(node[1])), view = ctx.summary?.at(ctx.func.current)
  view?.alias(receiver, node[1], false)
  try {
    let read = emit([node[0], receiver, node[2]])
    if (external) {
      ctx.module.include('collection'); inc('__ext_method'); setLinkDemand('external')
      const key = node[0] === '.' || node[0] === '?.' ? ['str', node[2]] : ['()', T + 'key', node[2]]
      read = ['if', ['result', 'f64'], boxedPtrTypeEq(['local.get', `$${receiver}`], PTR.EXTERNAL),
        ['then', ['f64.reinterpret_i64', ['call', '$__ext_method',
          ['i64.reinterpret_f64', ['local.get', `$${receiver}`]], asI64(emit(key))]]], ['else', asF64(read)]]
    }
    return block64(['local.set', `$${receiver}`, value], read)
  }
  finally { view?.unalias(receiver) }
}

/**
 * Emit single AST node to typed WASM IR.
 * Every returned node has .type = 'i32' | 'f64'.
 * A node is the current one while it emits (ctx.js), its position the current
 * position when it has one; the enclosing ones are current again after.
 * @param {import('../../prepare/module-resolve.js').ASTNode} node
 * @returns {Array} typed WASM S-expression
 */
// Escape sites (compile/analyze/frame-effects.js): where one runs, the escape
// flag goes down to the address it writes into, so a frame older than that
// address keeps the heap at its return (optimize/arena-rewind.js): before the
// node where it stores a value that may hold a heap pointer, after it where it
// escapes only by making its receiver grow, and then only if it allocated. A
// logical assignment lowers the flag in the arm that assigns
// (emit/assignment.js), so an initialization made once flags once. A store
// the emitter made in place (emit-assign.js `inPlace`) lowers nothing.
const LOGICAL_ASSIGN = new Set(['??=', '||=', '&&='])
export function emit(node, expect) {
  if (!Array.isArray(node)) return emitNode(node, expect)
  const at = ctx.error, outerNode = at.node, outerLoc = at.loc
  at.node = node
  if (node.loc != null) at.loc = node.loc
  const ir = emitSite(node, expect)
  at.node = outerNode
  at.loc = outerLoc
  if (!ctx.transform.sourceMap || node.sourceLoc == null || !Array.isArray(ir)) return ir
  return Object.assign(ir.slice(), ir, { sourceLoc: node.sourceLoc })
}
function emitSite(node, expect) {
  if (remarking > 0 && Array.isArray(node)) { const mark = REMARKS.get(node); if (mark !== undefined) return remarked(node, expect, mark) }
  if (!ctx.plans.escapeFlag || !Array.isArray(node) || !ctx.plans.escapeSites?.has(node) || LOGICAL_ASSIGN.has(node[0])) return emitNode(node, expect)
  markInstrumented(node)
  const origin = ctx.plans.siteOrigin?.get(node) ?? node
  const heap = ctx.memory.shared || ctx.scope.globals.has('__heap')
  if (reachOn() && moduleBinding(node)) return rooted(emitNode(node, expect), node[1], node)
  if (ctx.plans.siteGrown?.has(origin) && heap) return whereGrown(node, origin, expect)
  // an assignment yields what it stored: the flag goes down only for a value a
  // running call made, or where the store allocated
  if (ctx.plans.siteAsked?.has(origin) && heap && (ASSIGN_OPS.has(node[0]) || node[0] === '++' || node[0] === '--')) {
    const held = { pre: [] }, flag = siteFlag(node, undefined, held)
    if (flag === null) return emitNode(node, expect)
    const mark = ctx.plans.siteGrows?.has(origin) ? escLocal('i32', ESC_MARK) : null
    if (mark !== null) held.pre.push(['local.set', mark, heapTop()])
    const ir = mark === null ? emitNode(node, null) : pastOperands(node, mark, () => emitNode(node, null)), t = Array.isArray(ir) ? ir.type : undefined
    if (ir?.inPlace) return expect === 'void' && t !== 'void' ? typed(['drop', ir], 'void') : ir
    if (t === 'f64' || t === 'i32') {
      const out = whereNew(ir, flag, held.pre, mark)
      return expect === 'void' ? typed(['drop', out], 'void') : out
    }
    return withEscapeFlag(ir, ['block', ...held.pre, flag])
  }
  // the address is read before the node runs
  const flag = siteFlag(node), ir = emitNode(node, expect)
  return ir?.inPlace ? ir : withEscapeFlag(ir, flag)
}
/** A value about to be stored, with the flag lowered by `flag` after it is
 *  made when a running call may have allocated it (`__esc_new`), or when the
 *  heap moved since `mark` kept its top; `pre`: what `flag` reads, taken
 *  before the value is made. */
export function whereNew(ir, flag, pre = [], mark = null) {
  if (flag === null) return ir
  if (flag === ROOT) return rooted(ir)
  // a number is no pointer: only the store's own allocation is left to ask
  const number = ir.valKind === VAL.NUMBER || (ir.type === 'i32' && ir.ptrKind == null)
  if (number && mark === null) return ir
  if (!number) inc('__esc_new')
  const kept = escLocal('f64', ESC_VALUE)
  const made = ['call', '$__esc_new', ['local.get', kept]], moved = mark === null ? null : ['i32.ne', heapTop(), ['local.get', mark]]
  const out = typed(['block', ['result', 'f64'], ...pre, ['local.set', kept, asF64(ir)],
    ['if', number ? moved : moved === null ? made : ['i32.or', moved, made], ['then', flag]], ['local.get', kept]], 'f64')
  if (ir.type === 'f64') for (const k of REP_FACTS) if (ir[k] !== undefined) out[k] = ir[k]
  return out
}
// JZ_DEBUG_ESC=1: every site that lowers the flag tells the host which one it
// was (`env.__esc_note(id)`, the ids listed on stderr as they are emitted), to
// find what keeps a call's memory. A tool for this file's work, off in use.
const DBG_ESC = typeof process !== 'undefined' && process.env?.JZ_DEBUG_ESC === '1'
let escNotes = 0
const spelled = (n) => Array.isArray(n) ? '[' + n.map(spelled).join(' ') + ']' : String(n)
const noted = (flag, node) => {
  if (!DBG_ESC || flag === null) return flag
  const id = ++escNotes
  if (!ctx.module.imports.some(i => i[2] === '"__esc_note"')) { ctx.module.imports.push(['import', '"env"', '"__esc_note"', ['func', '$__esc_note', ['param', 'i32']]]); ctx.module.keepsNothing.add('$__esc_note') }
  console.error(`esc-note ${id}: ${ctx.func.current?.name ?? ctx.func.name ?? '?'}: ${ctx.plans.siteWhys?.get(ctx.plans.siteOrigin?.get(node) ?? node) ?? 'site'}: ${spelled(node).slice(0, 160)}`)
  return ['block', flag, ['call', '$__esc_note', ['i32.const', id]]]
}
/** The site (or the site a clone of it copies) is flagged where it is emitted. */
export const markInstrumented = (node) => ctx.plans.instrumented.add(ctx.plans.siteOrigin?.get(node) ?? node)
/** What the emitter drops (an arm a literal decides against) never runs: a
 *  site in it is no escape, and counts as flagged (compile/index.js reads a
 *  site the emitter never flagged as an escape at no instruction). */
export const markDropped = (node) => {
  const sites = ctx.plans.escapeSites
  if (sites) walkAst(node, { enter: (n) => { if (sites.has(n)) markInstrumented(n) } })
}
const flagToZero = () => ['global.set', '$__esc', ['i32.const', 0]]
// A module binding assigned a value: no memory is written, and the value is
// itself the way into what the call made. Its site runs after the value is
// made and hands it to the log (`__esc_root`, module/core/reach.js), which
// lowers the flag for one a running call made. `ROOT` stands for that
// lowering where a caller holds the value, not the node.
const ROOT = ['call', '$__esc_root']
const moduleBinding = (node) => (ASSIGN_OPS.has(node[0]) || node[0] === '++' || node[0] === '--') &&
  typeof node[1] === 'string' && !ctx.func.boxed?.has(node[1]) && isGlobal(node[1])
/** `ir` with the value it yields handed to the log, or, given the binding's
 *  `name`, the value the binding holds once `ir` ran (an assignment that
 *  computes yields what it stored, a postfix step what stood before). */
function rooted(ir, name = null, node = null) {
  inc('__esc_root')
  if (name === null) {
    if (ir.valKind === VAL.NUMBER || (ir.type === 'i32' && ir.ptrKind == null)) return ir
    const kept = escLocal('f64', ESC_VALUE)
    const out = typed(['block', ['result', 'f64'], ['local.set', kept, asF64(ir)], ['call', '$__esc_root', ['local.get', kept]], ['local.get', kept]], 'f64')
    if (ir.type === 'f64') for (const k of REP_FACTS) if (ir[k] !== undefined) out[k] = ir[k]
    return out
  }
  const lower = noted(['call', '$__esc_root', asF64(emit(name))], node)
  if (ir == null) return typed(lower, 'void')
  const t = Array.isArray(ir) ? ir.type : undefined
  if (!t || t === 'void') return typed(['block', ...flat(ir), lower], 'void')
  const value = t === 'i32' ? asF64(ir) : ir, vt = t === 'i32' ? 'f64' : t
  const kept = escLocal(vt, ESC_VALUE)
  const out = typed(['block', ['result', vt], ['local.set', kept, value], lower, ['local.get', kept]], vt)
  if (t !== 'i32') for (const k of REP_FACTS) if (ir[k] !== undefined) out[k] = ir[k]
  return out
}
// The tag of the locals a growth site keeps in: link drops their writes with
// the check no frame reads (optimize/arena-rewind.js, same tag). Numbered
// apart from the frame's other names: a site changes no label and no temp
// of the code around it.
const ESC_MARK = 'esch', ESC_VALUE = 'escv'
const escLocal = (type, tag) => {
  let name, n = 0
  do { name = `${T}${tag}${n++}` } while (ctx.func.locals.has(name))
  ctx.func.locals.set(name, type)
  return '$' + name
}
/** The flag lowered to the storage of `target` (a binding's name, a path
 *  below one), by the site's kind (frame-effects.js SITE): the container the
 *  target holds (`__esc_val`; `__esc_elem` for a store a typed array turns
 *  into numbers), the cell a binding lives in, zero for a module binding.
 *  Null for a binding of this frame's own: no memory is written. `held`: the
 *  target's value is read now into a local and the flag lowered by it later
 *  (`held.pre` takes the read): a store that grows its receiver rebinds it
 *  to the new storage, and it is the old one that was written. */
function holderFlag(target, kind, held = null) {
  if (kind === SITE.CELL) {
    if (typeof target !== 'string') return flagToZero()
    if (ctx.func.boxed?.has(target)) { const lower = reachOn() ? '__esc_cell' : '__esc_at'; inc(lower); return ['call', '$' + lower, boxedAddr(target)] }
    return !isGlobal(target) ? null : reachOn() ? ROOT : flagToZero()
  }
  if (target == null || kind === SITE.ZERO) return flagToZero()
  const fn = kind === SITE.ELEM ? '__esc_elem' : '__esc_val'
  inc(fn)
  const value = asF64(emit(target))
  if (held === null) return ['call', '$' + fn, value]
  const was = escLocal('f64', ESC_MARK)
  held.pre.push(['local.set', was, value])
  return ['call', '$' + fn, ['local.get', was]]
}
/** The flag lowered for the site `node`: what it writes into is read off the
 *  node as it is emitted (a clone of the site the census saw carries its own
 *  names): its receiver, its first argument, the binding it assigns
 *  (`target`, where the caller names it). */
export function siteFlag(node, target = undefined, held = null) {
  const kind = ctx.plans.siteKinds?.get(ctx.plans.siteOrigin?.get(node) ?? node) ?? SITE.ZERO
  const name = target ?? node[1]
  if (reachOn() && typeof name === 'string' && moduleBinding([node[0], name])) return ROOT
  if (kind === SITE.CELL) return noted(holderFlag(name, kind), node)
  if (kind === SITE.ARG) { const a = node[2]; target = a == null ? null : Array.isArray(a) && a[0] === ',' ? a[1] : a }
  else if (kind !== SITE.ZERO) {
    let t = node[1]
    while (Array.isArray(t) && t[0] === '(') t = t[1]
    target = Array.isArray(t) && (t[0] === '.' || t[0] === '?.' || t[0] === '[]') ? t[1] : null
  }
  return noted(holderFlag(target, kind, held), node)
}
const heapTop = () => typed(ctx.memory.shared ? ['i32.load', ['i32.const', HEAP.PTR_ADDR]] : ['global.get', '$__heap'], 'i32')
/** The node of a site that escapes only where it allocates, with the flag
 *  lowered after it when the heap moved while it ran: to what the node
 *  writes into, or, for a loop, to each receiver its stores may grow
 *  (`siteNames`), as each stood before the node ran. */
function whereGrown(node, origin, expect) {
  const names = ctx.plans.siteNames?.get(origin), held = { pre: [] }
  const flags = (names ? [...names].map(([name, kind]) => noted(holderFlag(name, kind, held), node)) : [siteFlag(node, undefined, held)]).filter(f => f !== null)
  if (!flags.length) return emitNode(node, expect)
  const mark = escLocal('i32', ESC_MARK)
  const save = [...held.pre, ['local.set', mark, heapTop()]]
  const check = ['if', ['i32.ne', heapTop(), ['local.get', mark]], ['then', ...flags]]
  const ir = names ? emitNode(node, expect) : pastOperands(node, mark, () => emitNode(node, expect))
  if (ir?.inPlace) return ir
  if (ir == null) return typed(['block', ...save, check], 'void')
  const t = Array.isArray(ir) ? ir.type : undefined
  if (!t || t === 'void') return typed(['block', ...save, ...flat(ir), check], 'void')
  const value = t === 'i32' ? asF64(ir) : ir, vt = t === 'i32' ? 'f64' : t
  const kept = escLocal(vt, ESC_VALUE)
  const out = typed(['block', ['result', vt], ...save, ['local.set', kept, value], check, ['local.get', kept]], vt)
  if (t !== 'i32') for (const k of REP_FACTS) if (ir[k] !== undefined) out[k] = ir[k]
  return out
}
// The mark of a site that waits for an allocation stands past its operands:
// what a store's value or a call's argument allocates as it is evaluated (a
// literal, a host's copy, a temporary string) is no growth of the receiver.
// An operand that may allocate (frame-effects.js allocatesNothing) moves the
// mark to the heap's top as it ends, unless the heap had moved before it
// began: whatever allocated there, a key made a string or the store itself
// where a kernel makes room first, stays counted (the mark goes to all ones,
// which the heap's top never is). So the order the node is emitted in
// decides nothing.
const REMARKS = new WeakMap()
let remarking = 0
const NO_MARK = ['i32.const', -1]
const operandsOf = (node) => ASSIGN_OPS.has(node[0]) ? [node[2]] : node[0] === '()' ? commaList(node[2]) : []
function pastOperands(node, mark, run) {
  const view = ctx.summary?.at(ctx.func.current)
  const list = operandsOf(node).filter(e => Array.isArray(e) && !allocatesNothing(view, e))
  if (!list.length) return run()
  for (const e of list) REMARKS.set(e, mark)
  remarking++
  try { return run() } finally { remarking--; for (const e of list) REMARKS.delete(e) }
}
function remarked(node, expect, mark) {
  REMARKS.delete(node)
  let ir
  try { ir = emit(node, expect) } finally { REMARKS.set(node, mark) }
  const began = ['if', ['i32.ne', heapTop(), ['local.get', mark]], ['then', ['local.set', mark, NO_MARK]]]
  const ended = ['if', ['i32.ne', ['local.get', mark], NO_MARK], ['then', ['local.set', mark, heapTop()]]]
  if (ir == null) return typed(['block', began, ended], 'void')
  const t = Array.isArray(ir) ? ir.type : undefined
  if (!t || t === 'void') return typed(['block', began, ...flat(ir), ended], 'void')
  const value = t === 'i32' ? asF64(ir) : ir, vt = t === 'i32' ? 'f64' : t
  const kept = escLocal(vt, ESC_VALUE)
  const out = typed(['block', ['result', vt], began, ['local.set', kept, value], ended, ['local.get', kept]], vt)
  if (t !== 'i32') for (const k of REP_FACTS) if (ir[k] !== undefined) out[k] = ir[k]
  return out
}
/** `ir` with the escape flag lowered before it by `flag` (siteFlag; to zero
 *  when none is given), `ir` alone where there is nothing to lower. A value
 *  keeps its value: an i32 is boxed first by its own facts (a pointer's
 *  offset, an unsigned word); an f64 or i64 keeps the facts that say what its
 *  bits are (REP_FACTS). Named, not enumerated: the self-hosted compiler
 *  lists no named property of an array. */
const REP_FACTS = ['ptrKind', 'ptrAux', 'srcPtrKind', 'schemaSid', 'valKind', 'bigintRaw', 'bigintBox']
export const withEscapeFlag = (ir, flag = flagToZero()) => {
  if (flag === null) return ir
  if (flag === ROOT) return rooted(ir)
  if (ir == null) return typed(flag, 'void')
  const t = Array.isArray(ir) ? ir.type : undefined
  if (!t || t === 'void') return typed(['block', flag, ...flat(ir)], 'void')
  if (t === 'i32') return typed(['block', ['result', 'f64'], flag, asF64(ir)], 'f64')
  const out = typed(['block', ['result', t], flag, ir], t)
  for (const k of REP_FACTS) if (ir[k] !== undefined) out[k] = ir[k]
  return out
}

function emitNode(node, expect) {
  ctx.func._expect = expect || null
  if (node == null) return null
  // Boolean literals carry VAL.BOOL for type observation (valTypeOf reads the
  // AST), but their working representation is the plain number 0/1 — identical
  // codegen to the pre-carrier `[, 1]`/`[, 0]` folding, so no perf is paid.
  if (node === true) return emitNum(1)
  if (node === false) return emitNum(0)
  if (typeof node === 'bigint') {
    // Truncate to 64 bits — `BigInt.asUintN(64, …)` semantics, same as the
    // explicit mask `node & 0xFFFFFFFFFFFFFFFFn`. Decimal form (vs. the prior
    // unsigned-hex dance) is enough now that watr's optimize.js getConst
    // handles signed strings correctly (4.6.8 W5 fix).
    return typed(['f64.reinterpret_i64', ['i64.const', BigInt.asUintN(64, node).toString()]], 'f64')
  }
  if (typeof node === 'number') return emitNum(node)
  if (typeof node === 'string') {
    // An array slice view read outside a range consumer: its range as an array (compile/array-view.js).
    if (arrayView(node)) return materializeArrayView(node)
    // Variable read: boxed / local / param / global (check before emitter table to avoid name collisions)
    if (ctx.func.boxed?.has(node) || isBoundName(node) || isGlobal(node) || repOf(node)?.intConst != null)
      return readVar(node)
    // Top-level function used as value → wrap as closure pointer for call_indirect
    if (ctx.funcs.names.has(node) && !isBoundName(node) && ctx.closure.table) {
      // Trampoline signature: uniform closure ABI (env f64, argc i32, a0..a{MAX-1} f64) → f64.
      // Forwards the first N inline slots to $func where N = func's fixed param count.
      const func = ctx.funcs.map.get(node)
      const sigParams = func?.sig.params || []
      if (sigParams.length > MAX_CLOSURE_ARITY) err(`Function ${node} used as closure value has ${sigParams.length} params, exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY} — bundle the extra parameters into one array/object argument`)
      const trampolineName = `${T}tramp_${node}`
      if (!ctx.core.stdlib[trampolineName]) {
        const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
        const paramDecls = ['(param $__env f64)', '(param $__argc i32)']
        for (let i = 0; i < W; i++) paramDecls.push(`(param $__a${i} f64)`)
        if (ctx.closure.receiver) paramDecls.push('(param $__this f64)')
        // A rest param (always last) must be packed into a fresh array from the
        // overflow inline slots — the direct-call path does this via
        // buildArrayWithSpreads, and `=>` closures via emitClosureBody. Without
        // it here an indirect caller's single array arg arrives AS the rest array
        // (spread one level) instead of `[arg]`. len = clamp(argc-restIdx, 0, restSlots).
        const restIdx = func?.rest ? sigParams.length - 1 : -1
        let restLocals = '', restPrelude = ''
        if (restIdx >= 0) {
          const restSlots = W - restIdx
          const stores = []
          for (let i = 0; i < restSlots; i++)
            stores.push(`(if (i32.gt_s (local.get $__rlen) (i32.const ${i})) (then (f64.store (i32.add (local.get $__roff) (i32.const ${i * 8})) (local.get $__a${restIdx + i}))))`)
          restLocals = '(local $__rlen i32) (local $__roff i32) '
          restPrelude =
            `(local.set $__rlen (select (i32.sub (local.get $__argc) (i32.const ${restIdx})) (i32.const 0) (i32.gt_s (local.get $__argc) (i32.const ${restIdx})))) ` +
            `(if (i32.gt_s (local.get $__rlen) (i32.const ${restSlots})) (then (local.set $__rlen (i32.const ${restSlots})))) ` +
            `(local.set $__roff (call $__alloc_hdr (local.get $__rlen) (local.get $__rlen))) ` +
            stores.join(' ') + ' '
        }
        // The closure ABI carries boxed values. Use the direct-call coercion:
        // an i32 parameter can be a pointer offset, not just an integer.
        const fwd = sigParams.map((p, i) =>
          i === restIdx
            ? `(call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $__roff))`
            : print(coerceArg(typed(['local.get', `$__a${i}`], 'f64'), p))).join(' ')
        if ((func?.sig.results.length || 1) > 1) {
          const n = func.sig.results.length
          const arr = `${T}retarr`
          const temps = Array.from({ length: n }, (_, i) => `${T}ret${i}`)
          const tempLocals = temps.map(name => `(local $${name} f64)`).join(' ')
          const stores = temps.map((name, i) =>
            `(f64.store (i32.add (local.get $${arr}) (i32.const ${i * 8})) (local.get $${name}))`
          ).join(' ')
          const capture = temps.slice().reverse().map(name => `(local.set $${name})`).join(' ')
          // Canonical 16-byte header (__alloc_hdr: propsPtr@-16, len@-8,
          // cap@-4), NOT a hand-rolled (n*8+8) alloc — __dyn_get_t_h's
          // ARRAY branch always reads the propsPtr word at off-16 (FOURTH
          // mechanism, .work/evidence.md §Region arena: a short header
          // aliases whatever memory preceded the allocation).
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} ${paramDecls.join(' ')} (result f64) (local $${arr} i32) ${tempLocals} ${restLocals}${restPrelude}(call $${node} ${fwd}) ${capture} (local.set $${arr} (call $__alloc_hdr (i32.const ${n}) (i32.const ${n}))) ${stores} (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $${arr})))`
          inc(trampolineName, '__alloc_hdr', '__mkptr')
        } else {
          // Rebox the inner result into the uniform closure ABI (always f64).
          const resType = func?.sig.results[0]
          const callExpr = `(call $${node} ${fwd})`
          // A pointer-returning func carries its result as the raw i32 offset
          // (sig.ptrKind names the heap kind). Rebox it as a NaN-boxed pointer
          // with its tag — same as the boundary wrapper (synthesizeBoundaryWrappers).
          // Numeric `f64.convert_i32_s` here would turn the offset into a plain
          // number, silently losing the pointer (a Map came back as e.g. 480360.0,
          // so a caller's `for…of`/`.size` saw a number and read nothing).
          const ptrResult = func?.sig.ptrKind != null
          // An i32 BOOL result carries 0/1; f64 can already hold a boolean atom
          // (for example a dispatched `.some()` result). Normalize both with
          // the boundary wrapper's rule before boxing for the closure ABI:
          // f64.ne(boxedFalse, 0) would incorrectly turn false into true.
          const boolResult = !ptrResult && func?.valResult === VAL.BOOL && !func?.valResultMayBeUndefined
          // A raw-i64 result (a direct-only BigInt function's contract) is
          // boxed here, once, at the producer: the closure ABI's slot is an
          // any slot, where a BigInt is a PTR.BIGINT cell (a boxed contract's
          // result is already one, its return edges convert every tail).
          const rawBigintResult = !ptrResult && !boolResult && resType === 'f64' &&
            (ctx.plans.programIndex?.resultContract(func) ?? ctx.summary?.resultContract(node))?.carrier === CARRIER.RAW_I64
          const wrapped = ptrResult
            ? `(call $__mkptr (i32.const ${valKindToPtr(func.sig.ptrKind)}) (i32.const ${func.sig.ptrAux ?? 0}) ${callExpr})`
            : boolResult
              ? `(select (f64.const nan:${TRUE_NAN}) (f64.const nan:${FALSE_NAN}) ${resType === 'i32' ? `(i32.ne ${callExpr} (i32.const 0))` : `(call $__is_truthy (i64.reinterpret_f64 ${callExpr}))`})`
              : rawBigintResult
                ? `(call $__box_bigint ${callExpr})`
              : resType === 'i32'
                ? (func.sig.unsignedResult ? `(f64.convert_i32_u ${callExpr})` : `(f64.convert_i32_s ${callExpr})`)
                : resType === 'i64'
                  ? `(f64.reinterpret_i64 ${callExpr})`
                  : callExpr
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} ${paramDecls.join(' ')} (result f64) ${restLocals}${restPrelude}${wrapped})`
          inc(trampolineName, ...(ptrResult ? ['__mkptr'] : []), ...(boolResult && resType !== 'i32' ? ['__is_truthy'] : []), ...(rawBigintResult ? ['__box_bigint'] : []), ...(restIdx >= 0 ? ['__alloc_hdr', '__mkptr'] : []))
        }
      }
      // ctx.closure.mint (not a bare table.push) — same funcIdx-alignment
      // reason as other function values. A top-level function used as
      // a bare value has no captures (its real params are forwarded inline
      // by the trampoline body, not carried via an env block), so the
      // default {len:0, cellMask:0} meta is correct here too.
      const idx = ctx.closure.mint(trampolineName, functionLength(func.sig.params, func.defaults, func.rest))
      const ir = mkPtrIR(PTR.CLOSURE, idx, 0)
      ir.closureFuncIdx = idx
      return ir
    }
    // Emitter table: only namespace-resolved names (contain '.', e.g. 'math.PI') — safe from user variable collision.
    // Callable values were normalized to ordinary functions during prepare.
    // Niladic value emitters (Math.PI and other constants) remain bare names.
    if (node.includes('.') && ctx.core.emit[node]) {
      const handler = ctx.core.emit[node]
      if (emitArity(handler, node) > 0)
        err(`Builtin function '${node}' cannot be used as a first-class value here — wrap the call in an arrow`)
      return handler()
    }
    // Auto-import known host globals (WebAssembly, globalThis, etc.). Emit only
    // records the usage; the `(import "env" … (global … i64))` node is drained
    // into ctx.module.imports at assembly (compile/index.js), the same way
    // ctx.core.jsstring is — emit does not own ctx.scope / ctx.module sections.
    // Carrier is i64 (not f64) so V8 can't canonicalize the NaN-boxed external-ref
    // payload across the wasm↔JS global boundary (same hazard as env.print —
    // see module/console.js header). asF64() reinterprets to f64 at each read.
    if (HOST_GLOBALS.has(node) && !isBoundName(node) && !isGlobal(node)) {
      if (!ctx.transform.targetProfile.envImports) err(`host:'wasi': reference to host global \`${node}\` requires an env import. Remove the reference or use host:'js'.`)
      setLinkDemand('external')
      ctx.core.hostGlobals.add(node)
      return typed(['global.get', `$${node}`], 'i64')
    }
    // Every legitimate resolution channel above (boxed/local/param/global/
    // intConst, top-level function value, namespace/emit-table member, host
    // global) has already failed — `node` is a genuinely undeclared
    // identifier. The old fallback here guessed `local.get $node` (default
    // type 'f64') as if it were a real local; that guess is never valid
    // (isBoundName, checked above, covers every case ctx.func.locals?.get
    // could hit), so it only ever "succeeds" by accident: when the read's
    // value goes unused, dead-code elimination drops the bogus local.get
    // before watr's assembler gets a chance to reject it as an unknown
    // local — a SILENT wrong value (`x, 1` and bare `x;` both ran clean,
    // dropping `x`'s ReferenceError) instead of the reject a *used* stray
    // reference already gets. jz has no runtime binding resolution (no
    // dynamic scope object to throw a catchable ReferenceError from), so
    // the sound fix is to reject here unconditionally — same message shape
    // as the watr-surfaced "not in scope" (index.js), so this reads as one
    // consistent error family and the test262 runner's existing
    // 'is not in scope' skip-message allowlist keeps classifying it as a
    // clean structural reject, not a miscompile.
    // A builtin global jz resolves at compile time holds no value to pass.
    const builtin = builtinGlobalOf(node)
    if (builtin) err(GLOBAL_TYPEOF[builtin] === 'object'
      ? `'${builtin}' as a value is not supported: jz resolves a builtin namespace at compile time and holds no object for it; call or read its members in place`
      : `'${builtin}' as a value is not supported: jz resolves a builtin function or constructor where it is called and holds no function object for it; wrap the call in an arrow`)
    err(`'${node}' is not in scope — jz has no runtime identifier resolution, so an undeclared reference must be rejected at compile time (JS would throw ReferenceError here); declare '${node}', fix the spelling, or import it`)
  }
  if (!Array.isArray(node)) return typed(['f64.const', 0], 'f64')

  const op = node[0]
  if (op === '__eager&&' || op === '__eager||') return toBool(node)
  // WASM IR passthrough: internally-generated IR nodes (from statement flattening) pass through
  if (typeof op === 'string' && !ctx.core.emit[op] && (op.includes('.') || WASM_OPS.has(op))) return node

  // Self-describing bigint literal, tagged at parse time (parse.js's digit-lookup
  // override, audit P0-2) off the source `n` suffix — a purely structural signal,
  // sound whether this code runs natively or self-compiled in-kernel. args[0] is
  // the unsigned-64 decimal (BigInt.asUintN(64,·) semantics, computed via
  // bignum.js's limb arithmetic at parse time — no host BigInt, no ambiguity),
  // passed straight to i64.const — no in-kernel re-parse needed.
  if (op === 'bigint') return typed(['f64.reinterpret_i64', ['i64.const', node[1]]], 'f64')

  // Self-describing NaN literal — same reason bigints are self-describing: a raw NaN
  // number is NaN-boxing-ambiguous and degrades to 0 across the self-compile kernel's
  // value/marshalling boundary. The `NaN` global resolves to this (prepare) instead
  // of a `[, NaN]` literal; watr emits the canonical quiet NaN. (Infinity is a normal
  // f64 and survives, so it stays a plain literal.)
  if (op === 'nan') return typed(['f64.const', 'nan'], 'f64')

  // Self-describing boolean literal, tagged at parse time (parse.js's `true`/
  // `false` token overrides) — same collapse class as bigint above: a raw
  // `true`/`false` degrades to the plain number 1/0 across the self-compile
  // kernel's marshalling boundary, losing VAL.BOOL. args[0] is 1/0 (prepare
  // may wrap it as a `[, 1]` literal node) — emit it as that working rep; the
  // BOOL boxing happens at the boundary via valTypeOf('bool')=VAL.BOOL.
  if (op === 'bool') return emit(node[1])

  // Literal node [, value] — handle null/undefined values
  if (op == null && node.length === 2) {
    const v = node[1]
    return v === undefined ? undefExpr() : v === null ? nullExpr() : emit(v)
  }

  // A retained parenthesis ends the inner optional chain before its consumer.
  if (op === '(') return emit(node[1])

  // Optional-chain continuation: `a?.b.c` → if `a` nullish then undefined else `a.b.c`.
  // Lift before dispatch so the regular `.` / `[]` / `()` handler sees the rebuilt chain
  // with the optional already replaced by a non-optional access on a guarded temp.
  if (op === '.' || op === '[]' || op === '()') {
    const lifted = liftOptionalChain(node)
    if (lifted) return lifted
  }

  // `let`/`const` dispatch directly to the imported emitDecl rather than through the
  // ctx.core.emit table reference: under self-compile the table reference is a closure value,
  // and a runtime spread of >8 args into a closure call silently drops arguments — so a
  // `let` with >8 expression-init declarators (e.g. an SROA prologue loading 16 typed-array
  // slots) lost everything past the 8th. A direct call to the module-local binding compiles
  // as a real direct call, which marshals all args.
  if (op === 'let' || op === 'const') return emitDecl(...node.slice(1))
  const handler = ctx.core.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  const selfAware = SELF_AWARE_OPS.has(op)
  let ir
  switch (node.length) {
    case 1: ir = selfAware ? handler(node) : handler(); break
    case 2: ir = selfAware ? handler(node[1], node) : handler(node[1]); break
    case 3: ir = selfAware ? handler(node[1], node[2], node) : handler(node[1], node[2]); break
    case 4: ir = selfAware ? handler(node[1], node[2], node[3], node) : handler(node[1], node[2], node[3]); break
    case 5: ir = selfAware ? handler(node[1], node[2], node[3], node[4], node) : handler(node[1], node[2], node[3], node[4]); break
    default: {
      const args = node.slice(1)
      if (selfAware) args.push(node)
      ir = handler(...args)
    }
  }
  if (ir && ir.type === 'f64' && valTypeOf(node) === VAL.NUMBER) ir.valKind = VAL.NUMBER
  return ir
}
