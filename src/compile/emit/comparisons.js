/**
 * emitTypeofCmp (public); char/substring comparison fusion;
 * loose/strict equality and ordered comparison emission.
 *
 * @module compile/emit/comparisons
 */

import { i64Hex, nanPrefixHex } from '../../../layout.js'
import { T, TYPEOF } from '../../ast.js'
import { LAYOUT, PTR, ctx, inc, ssoBitI64Hex } from '../../ctx.js'
import {
  asF64, asI32, asI32Sat, asI64, carrierF64, emitNum, freshId, isBoolAtom, isLit, isLiteralStr, isNull, isNullish, isNullishLit, isPlanRawBigint, isPlanTaggedBigint, isUndef, litVal, nullableBoolBoxIR, numberNanIR, ptrTypeEq, readI64, resolveValType, temp, tempI32, tempI64, toNumF64, truthyIR, typed, unboxBigInt,
} from '../../ir.js'
import { censusMaybeUndefined, hasAmbiguousBoolMerge, valTypeOf } from '../../kind.js'
import { VAL, lookupValType, repOf, repOfGlobal } from '../../reps.js'
import { foldIntCompare } from '../../ir/numeric.js'
import { nonNegIntLiteral } from '../../static.js'
import { typedIdxProven } from '../../type.js'
import { numLiteralNode } from './bigint.js'
import { emit, emitIdentitySafe, emitIdentitySafeArms } from './dispatch.js'
import { emitInstanceof } from './instanceof.js'
import { REF_EQ_KINDS, foldOperandPure, stringOps } from './shared.js'


/** Emit typeof comparison: typeof x == typeCode → type-aware check. */
function emitTypeofCmp(a, b, cmpOp) {
  let typeofExpr, code
  if (Array.isArray(a) && a[0] === 'typeof' && typeof b === 'number') { typeofExpr = a[1]; code = b }
  else if (Array.isArray(a) && a[0] === 'typeof' && Array.isArray(b) && b[0] == null) { typeofExpr = a[1]; code = b[1] }
  else return null
  if (typeof code !== 'number') return null

  const t = temp()
  // Ambiguous BOOL-merge operand (.work/archive/todo.md §deletion-sweep): the
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
  const vt = ambiguous || planTaggedBigint ? null : resolveValType(typeofExpr, valTypeOf, lookupValType)
  // Raw Boolean/BigInt carriers can look like Numbers or any pointer tag.
  // Their proven semantic kind decides ALL typeof comparisons, not just the
  // matching one. Keep the already-emitted operand's effects in every fold.
  if (vt === VAL.BOOL || vt === VAL.BIGINT) {
    const typeCode = vt === VAL.BOOL ? TYPEOF.boolean : TYPEOF.bigint
    return foldConst((code === typeCode) === eq ? 1 : 0)
  }
  const staticFold = target => vt ? foldConst((vt === target) === eq ? 1 : 0) : null

  if (code === TYPEOF.number) {
    // v===v alone is WRONG for the one payload that legitimately means "the number
    // NaN": the canonical box prefix (tag=ATOM aux=0) that $__typeof (module/core.js)
    // also carves out, plus any sign-bit-set NaN (pointers are always emitted
    // sign-clear, so a negative NaN — e.g. x86's uncanonicalized 0/0 — can only be a
    // real float NaN). Must mirror $__typeof's dynamic dispatch exactly, or
    // `typeof NaN === 'number'` folds to false here while the general path says true.
    const again = ['local.get', `$${t}`]
    return wrap(['i32.or', ['f64.eq', ['local.tee', `$${t}`, va], again], numberNanIR(again)])
  }
  if (code === TYPEOF.string) return isPtrKind(PTR.STRING)
  if (code === TYPEOF.undefined) return wrap(isUndef(va))
  if (code === TYPEOF.boolean) return staticFold(VAL.BOOL) ?? wrap(isBoolAtom(['local.tee', `$${t}`, va]))
  if (code === TYPEOF.object) {
    // typeof null is "object". Other atoms, strings, closures and boxed
    // BigInts are not objects, even though all share the NaN-box carrier.
    // Test null explicitly rather than admitting the whole ATOM family.
    inc('__ptr_type')
    const tt = `${T}${freshId(ctx)}`; ctx.func.locals.set(tt, 'i32')
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const heapKind = ['i32.and',
      ['i32.and',
        ['i32.ne', ['local.tee', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]], ['i32.const', PTR.STRING]],
        ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.CLOSURE]]],
      ['i32.and',
        ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.ATOM]],
        ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.BIGINT]]]]
    return wrap(['i32.and', isPtr, ['i32.or', isNull(['local.get', `$${t}`]), heapKind]])
  }
  if (code === TYPEOF.function) return isPtrKind(PTR.CLOSURE)
  if (code === TYPEOF.bigint) {
    const fold = staticFold(VAL.BIGINT); if (fold) return fold
    // A BigInt that reaches an operand the plan could not resolve is a
    // PTR.BIGINT box (the plan tags every dynamic edge; a raw i64 carrier
    // lives on statically proven paths alone, which fold above), so the tag
    // decides, as $__typeof and $__to_num decide. The former magnitude
    // heuristic (finite, nonzero, subnormal) read a genuine subnormal Number
    // as a BigInt: the kernel spelled the literal 5e-324 by its bits.
    // Without BigInt literals, this guard can still admit a host BigInt
    // (jz:hostabi's tag slot). Inline tag extraction preserves the memoryless
    // path. Both branches test the same tag, including boxes
    // originating from typed storage without a BigInt literal.
    if (!ctx.features.bigint) {
      const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
      const tag = ['i64.and', ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', LAYOUT.TAG_SHIFT]], ['i64.const', LAYOUT.TAG_MASK]]
      return both(isPtr, ['i64.eq', tag, ['i64.const', PTR.BIGINT]])
    }
    return isPtrKind(PTR.BIGINT)
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
// `__str_length u> k` bounds-checks the same range JS would. Out-of-range
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
  if (lit.length !== 1 || !ctx.core.stdlib['__char_at'] || !ctx.core.stdlib['__str_length']) return null

  // Stash the index in a local when it isn't a constant — bounds + load both reference it.
  const isConstIdx = Array.isArray(idxIR) && idxIR[0] === 'i32.const'
  let idxRefIR = idxIR, idxBindIR = null
  if (!isConstIdx) {
    const idxTmp = tempI32('si')
    idxBindIR = ['local.set', `$${idxTmp}`, idxIR]
    idxRefIR = ['local.get', `$${idxTmp}`]
  }

  const ptr = temp('sc')
  inc('__str_length', '__char_at')
  const charEq = ['if', ['result', 'i32'],
    ['i32.gt_u', ['call', '$__str_length', ['i64.reinterpret_f64', ['local.get', `$${ptr}`]]], idxRefIR],
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
  if (!ctx.core.stdlib['__char_at'] || !ctx.core.stdlib['__str_length']) return null

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

// A VAL.BOOL value can ride either the cheap 0/1 numeric carrier or, after it has
// escaped into an object slot, a boxed boolean atom. `ToNumber(bool)` normalizes
// both to 0/1, so for relational / loose-equality coercion a boolean behaves
// identically to a number. Normalize it before the type-directed compare dispatch
// (the BOOL fact still drives typeof / String / boundary boxing).
export const numericVal = vt => vt === VAL.BOOL ? VAL.NUMBER : vt

// Primitive value-type classes for strict-equality type-mismatch folding. Two
// operands of different known classes — when at least one is a primitive — can
// never be `===` (number/boolean/string/bigint don't cross-coerce under `===`).
// Two *reference* kinds (array vs object, …) fall through to the shared ref-eq
// path instead, which already resolves distinct pointers to `false`.
const STRICT_PRIM = new Set([VAL.NUMBER, VAL.BOOL, VAL.STRING, VAL.BIGINT])

// Presence is independent of payload kind. Bounds, array holes and census
// nullish facts keep sentinel equality live even when present values are numeric.
const nullableOperand = (n) => {
  if (typeof n === 'string' && (repOf(n)?.nullable || repOfGlobal(n)?.nullable)) return true
  // A construct-then-fill numeric array (`new Array(n)`, `a[i] = expr`): an unwritten
  // slot is a hole that reads undefined, whatever the element claim.
  if (Array.isArray(n) && n[0] === '[]' && typeof n[1] === 'string' && repOf(n[1])?.arrayHoles) return true
  if (Array.isArray(n) && n[0] === '[]' && n.length === 3
      && typeof n[1] === 'string' && lookupValType(n[1]) === VAL.TYPED) {
    // A statically in-range OUTER access can still miss when its direct index
    // is itself a checked typed read (`out[count[d]]`, d OOB). Keep identity
    // tests live so the propagated miss bit can produce `undefined`.
    if (Array.isArray(n[2]) && n[2][0] === '[]' && typeof n[2][1] === 'string' &&
        lookupValType(n[2][1]) === VAL.TYPED && !typedIdxProven(n[2][1], n[2][2], n[2])) return true
    return !typedIdxProven(n[1], n[2], n)
  }
  if (censusMaybeUndefined(n)) return true
  // The summary carries presence beside the kind: an element or slot read
  // whose producers include a nullish (`xs.map(v => bits(v))`, bits
  // returning null or a string) is nullable whatever its present kind.
  return ctx.summary?.at(ctx.func.current)?.mayBeNullishExpr(n) === true
}

// A boolean that may be nullish is not statically boolean: its nullish member
// equals no boolean and no number, so the exact-kind arms must not claim it.
// Its carrier (the atom or the sentinel) keeps the identity for `===`; loose
// `==` converts the present boolean and rejects the nullish (looseNumberEq).
const boolOrNullish = (n) => resolveValType(n, valTypeOf, lookupValType) === VAL.BOOL && nullableOperand(n)

// A BigInt carrier: its kind, or the plan's closed raw carrier of a binding
// the body cannot kind; readI64 reads either (a box, a raw i64) as its
// payload. A nullable one (a Map read that may miss) reads its sentinel's
// bits, which equal no payload.
const bigintCarrier = (n, vt) => vt === VAL.BIGINT || isPlanRawBigint(n)

// `$t` (an f64 local) holds a PTR.BIGINT box: a NaN-box with the tag. The
// NaN test comes first; a Number's bits spell any tag.
const boxTest = (get) => typed(['i32.and', ['f64.ne', get, get], ptrTypeEq(get, PTR.BIGINT)], 'i32')

// Equality with a BigInt carrier on at least one side. Two carriers compare
// their payloads. One beside a partner of another kind (IsLooselyEqual
// steps 8-14): a Number or a boolean mathematically, a string through
// StringToBigInt, an unkinded carrier through __bigint_eq's own dispatch.
// Strictly, only a box of the same payload; a Number's raw bits are never
// evidence of a BigInt. Both operands evaluate once, in source order. Null
// when neither side is a BigInt carrier.
function emitBigintEq(a, b, va, vb, vta, vtb, negate, strict) {
  const bigA = bigintCarrier(a, vta), bigB = bigintCarrier(b, vtb)
  if (!bigA && !bigB) return null
  const fin = r => negate ? typed(['i32.eqz', r], 'i32') : r
  if (bigA && bigB) return fin(typed(['i64.eq', readI64(a, va), readI64(b, vb)], 'i32'))
  const big = bigA ? a : b, bigV = bigA ? va : vb
  const other = bigA ? b : a, otherV = bigA ? vb : va, otherVt = bigA ? vtb : vta
  const payload = tempI64('beq'), partner = temp('beq')
  const setPayload = ['local.set', `$${payload}`, readI64(big, bigV)]
  const setPartner = ['local.set', `$${partner}`, asF64(otherV)]
  const p = ['local.get', `$${payload}`], o = typed(['local.get', `$${partner}`], 'f64')
  const known = otherVt != null && !nullableOperand(other)
  let cmp
  if (strict) cmp = ['if', ['result', 'i32'], boxTest(o),
    ['then', ['i64.eq', p, unboxBigInt(o)]],
    ['else', ['i32.const', 0]]]
  else if (known && (otherVt === VAL.NUMBER || otherVt === VAL.BOOL)) { inc('__bigint_eq_num'); cmp = ['call', '$__bigint_eq_num', p, toNumF64(other, o)] }
  else if (known && otherVt === VAL.STRING) { inc('__bigint_eq_str'); cmp = ['call', '$__bigint_eq_str', p, ['i64.reinterpret_f64', o]] }
  else {
    ctx.module.include('string')
    inc('__bigint_eq')
    cmp = ['call', '$__bigint_eq', p, ['i64.reinterpret_f64', o]]
  }
  return fin(typed(['block', ['result', 'i32'], ...(bigA ? [setPayload, setPartner] : [setPartner, setPayload]), cmp], 'i32'))
}

function effectFoldSeq(operands, constIR) {
  const stmts = []
  for (const o of operands) if (o != null && !foldOperandPure(o)) stmts.push(['drop', emit(o)])
  if (!stmts.length) return constIR
  return typed(['block', ['result', 'i32'], ...stmts, constIR], 'i32')
}

const HEAP_EQ_KINDS = new Set([VAL.ARRAY, VAL.OBJECT, VAL.TYPED, VAL.MAP, VAL.SET, VAL.HASH, VAL.DATE, VAL.CLOSURE, VAL.BUFFER])
const PRIM_EQ_KINDS = new Set([VAL.NUMBER, VAL.STRING, VAL.BOOL])
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
  // Strict equality observes identity: a join whose boolean arm would collapse
  // to a raw 0/1 (mayCarryRawBool) is emitted with that arm boxed to its atom,
  // so `(c ? true : n) === 1` and the dynamic `__eq_strict` both see a boolean;
  // a boolean that may be nullish (its raw 0/1 beside a sentinel) enters the
  // dynamic compare as its atom too (nullableBoolBoxIR), as it would enter any
  // untyped carrier: `la.has(a) !== lb.has(b)` with one receiver unkinded
  // compared a raw 1 with the TRUE atom.
  const identity = (n) => !strict ? emit(n) : mayCarryRawBool(n) ? emitIdentitySafeArms(n) : boolOrNullish(n) ? nullableBoolBoxIR(emit(n)) : emit(n)
  const va = identity(a), vb = identity(b)
  const intCmp = foldIntCompare(eqOp, va, vb)
  if (intCmp) return intCmp
  // Keep semantic kinds separate from numeric Boolean coercion.
  const rawA = boolOrNullish(a) ? null : resolveValType(a, valTypeOf, lookupValType)
  const rawB = boolOrNullish(b) ? null : resolveValType(b, valTypeOf, lookupValType)
  const vta = numericVal(rawA)
  const vtb = numericVal(rawB)
  const numA = () => rawA === VAL.BOOL ? toNumF64(a, va) : asF64(va)
  const numB = () => rawB === VAL.BOOL ? toNumF64(b, vb) : asF64(vb)
  // A nullable numeric read may carry undefined. Only a present Number
  // permits direct numeric equality against an otherwise untyped carrier.
  const bigCmp = emitBigintEq(a, b, va, vb, rawA, rawB, negate, strict)
  if (bigCmp) return bigCmp
  const aSafe = vta === VAL.NUMBER && !nullableOperand(a)
  const bSafe = vtb === VAL.NUMBER && !nullableOperand(b)
  // Loose `==` of a certain number against a partner of no static kind (a
  // boolean atom, a boxed BigInt, a string: each converts) or a static
  // string: looseNumberEq. Every other known kind is a raw f64 compare: a
  // nullable number's sentinel and a heap kind's NaN-box equal no number.
  // Strict `===` converts nothing: every one of those is a NaN-box on the
  // unknown side, so `f64.eq` against the carrier as it is answers (`b[1]
  // === 0` with `b[1]` holding '0' is false).
  // A heap kind beside a primitive kind converts the object (IsLooselyEqual
  // steps 10-11): the dynamic compare, whose ToPrimitive arm needs the
  // string module.
  if (!strict && (HEAP_EQ_KINDS.has(rawA) && PRIM_EQ_KINDS.has(rawB) || HEAP_EQ_KINDS.has(rawB) && PRIM_EQ_KINDS.has(rawA))) {
    ctx.module.include('string')
    inc('__eq')
    const call = typed(['call', '$__eq', asI64(numA()), asI64(numB())], 'i32')
    return negate ? typed(['i32.eqz', call], 'i32') : call
  }
  if (!strict) {
    if (aSafe && (rawB == null || rawB === VAL.STRING)) return looseNumberEq(numA(), b, vb, rawB, negate, true)
    if (bSafe && (rawA == null || rawA === VAL.STRING)) return looseNumberEq(numB(), a, va, rawA, negate, false)
  }
  if (aSafe || bSafe) return typed([`f64.${eqOp}`, numA(), numB()], 'i32')
  // Both sides proven VAL.NUMBER but NEITHER individually "safe" above (both
  // nullable — the maybeUndefined gap this function's own Slice-5 fix closed
  // generically by falling all the way to the fully-dynamic __eq below). A
  // NUMBER-typed slot's only two possible runtime shapes are "a real number"
  // or a nullish sentinel (UNDEF_NAN from an unproven OOB/absent-key read,
  // rarely NULL_NAN from a nullish-literal producer) — never a string/
  // object/bigint — so it needs none of __eq's string-content/pointer-kind
  // dispatch (what pulls __str_eq/__is_str_key/__char_at/__str_length into
  // a module with no string at all, e.g. a pure Uint8Array match loop:
  // `src[j+len] === src[ip+len]` — bisected live to this exact gap,
  // .work/archive/todo.md "lz/glyfparse __eq bloat"). f64.eq alone is unsound only
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
  // String content compares by bits first, then by content for heap strings.
  // Loose unknown partners take the shared conversion path before these
  // shortcuts; strict comparisons need only a string tag and content check.
  const strEqResult = (r) => negate ? typed(['i32.eqz', r], 'i32') : r
  const aStr = rawA === VAL.STRING, bStr = rawB === VAL.STRING
  // A loose unknown partner may be a Number, Boolean, BigInt or object.
  // The shared comparison owns their conversions; string-only shortcuts
  // require strict equality or proof that both operands are strings.
  if (!strict && (aStr && rawB == null || bStr && rawA == null)) {
    ctx.module.include('string')
    inc('__eq')
    return strEqResult(typed(['call', '$__eq', asI64(va), asI64(vb)], 'i32'))
  }
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
    // Source order: the unknown side is stored first only when it is the left operand.
    const sets = bStr
      ? [['local.set', `$${u}`, asI64(uVal)], ['local.set', `$${l}`, asI64(lVal)]]
      : [['local.set', `$${l}`, asI64(lVal)], ['local.set', `$${u}`, asI64(uVal)]]
    return strEqResult(typed(['block', ['result', 'i32'], ...sets,
      ['if', ['result', 'i32'], ['i64.eq', uG, lG],
        ['then', ['i32.const', 1]],
        ['else', tail]]], 'i32'))
  }
  // Fully dynamic operands retain their tagged kinds. Only loose equality
  // converts primitives and treats null and undefined as equal.
  inc(strict ? '__eq_strict' : '__eq')
  if (!strict) {
    const call = typed(['call', '$__eq', asI64(va), asI64(vb)], 'i32')
    return negate ? typed(['i32.eqz', call], 'i32') : call
  }
  // Strict equality inline for the two answers a bit test settles: equal
  // bits are equal values (a NaN's own bits excepted), and two packed strings
  // with different bits are different strings (an AST walker compares its
  // operator names this way); everything else is the helper's chain.
  const ia = tempI64('seq'), ib = tempI64('seq'), aG = ['local.get', `$${ia}`], bG = ['local.get', `$${ib}`]
  const ssoMask = i64Hex(LAYOUT.NAN_PREFIX_BITS | (BigInt(LAYOUT.TAG_MASK) << BigInt(LAYOUT.TAG_SHIFT)) | (BigInt(LAYOUT.SSO_BIT) << BigInt(LAYOUT.AUX_SHIFT)))
  const ssoString = i64Hex(LAYOUT.NAN_PREFIX_BITS | (BigInt(PTR.STRING) << BigInt(LAYOUT.TAG_SHIFT)) | (BigInt(LAYOUT.SSO_BIT) << BigInt(LAYOUT.AUX_SHIFT)))
  const isSso = g => ['i64.eq', ['i64.and', g, ['i64.const', ssoMask]], ['i64.const', ssoString]]
  const eq = typed(['block', ['result', 'i32'],
    ['local.set', `$${ia}`, asI64(va)], ['local.set', `$${ib}`, asI64(vb)],
    ['if', ['result', 'i32'], ['i64.eq', aG, bG],
      ['then', ['i64.ne', aG, ['i64.const', nanPrefixHex()]]],
      ['else', ['if', ['result', 'i32'], ['i32.and', isSso(aG), isSso(bG)],
        ['then', ['i32.const', 0]],
        ['else', ['call', '$__eq_strict', aG, bG]]]]]], 'i32')
  return negate ? typed(['i32.eqz', eq], 'i32') : eq
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
  // Ambiguous BOOL-merge operand(s) (.work/archive/todo.md §deletion-sweep):
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
  const strictA = boolOrNullish(a) ? null : resolveValType(a, valTypeOf, lookupValType)
  const strictB = boolOrNullish(b) ? null : resolveValType(b, valTypeOf, lookupValType)
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
    // mayCarryRawBool's own doc comment (audit-#12 BOOL_CARRIER family); a
    // boolean that may be nullish carries its raw 0/1 beside a sentinel and
    // needs its atom the same way (nullableBoolBoxIR).
    const identityOf = (n, vt) => vt === VAL.BOOL ? carrierF64(n, emit(n))
      : mayCarryRawBool(n) ? emitIdentitySafeArms(n) : boolOrNullish(n) ? nullableBoolBoxIR(emit(n)) : asF64(emit(n))
    const va = identityOf(a, strictA), vb = identityOf(b, strictB)
    const cmp = typed(['i64.eq', ['i64.reinterpret_f64', va], ['i64.reinterpret_f64', vb]], 'i32')
    return negate ? typed(['i32.eqz', cmp], 'i32') : cmp
  }
  // Same type (or dynamic-unknown): identical to loose `==`/`!=` EXCEPT the
  // conversions loose alone performs (null == undefined, a boolean beside a
  // number, a BigInt beside a number or string): emitLooseEq's `strict` flag
  // keeps a proven BigInt beside an unkinded partner on the box-identity
  // form (emitBigintEq) and routes the fully-dynamic fallback through
  // $__eq_strict instead of $__eq; every other fast path inside it already
  // agrees bit-for-bit with strict semantics.
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
  // A numeric partner rules out lexicographic comparison. Coercion belongs
  // to the value contract, regardless of whether it came from a parameter,
  // call, or property read. toNumF64 already elides proven numeric carriers.
  const numA = vta === VAL.NUMBER || (vta == null && va.type === 'i32' && va.ptrKind == null)
  const numB = vtb === VAL.NUMBER || (vtb == null && vb.type === 'i32' && vb.ptrKind == null)
  if ((numB && !numA) || (numA && !numB)) {
    const ta = temp('cmp'), tb = temp('cmp')
    return typed(['block', ['result', 'i32'],
      ['local.set', `$${ta}`, asF64(va)], ['local.set', `$${tb}`, asF64(vb)],
      [`f64.${f64op}`, toNumF64(a, typed(['local.get', `$${ta}`], 'f64')),
        toNumF64(b, typed(['local.get', `$${tb}`], 'f64'))]], 'i32')
  }
  if (numA && numB) {
    const intCmp = foldIntCompare(f64op, va, vb)
    if (intCmp) return intCmp
  }
  // Every remaining non-numeric pair may compare as strings after
  // ToPrimitive. Keep the common two-number check inline; share coercion,
  // string dispatch and unordered handling across all four operators.
  if (!numA && !numB) {
    ctx.module.include('string')
    ctx.module.include('number')
    const ta = temp('cmp'), tb = temp('cmp')
    inc('__cmp')
    const getA = ['local.get', `$${ta}`], getB = ['local.get', `$${tb}`]
    const slow = [`f64.${f64op}`, ['call', '$__cmp',
      ['i64.reinterpret_f64', getA], ['i64.reinterpret_f64', getB]], ['f64.const', 0]]
    const result = vta == null && vtb == null
      ? ['if', ['result', 'i32'], ['i32.and', ['f64.eq', getA, getA], ['f64.eq', getB, getB]],
        ['then', [`f64.${f64op}`, getA, getB]], ['else', slow]] : slow
    return typed(['block', ['result', 'i32'],
      ['local.set', `$${ta}`, asF64(va)],
      ['local.set', `$${tb}`, asF64(vb)], result], 'i32')
  }
  return typed([`f64.${f64op}`, asF64(va), asF64(vb)], 'i32')
}

// Loose `==` of a certain number `num` against `other`. A static string is
// its ToNumber. A partner of no static kind is compared inline when it is a
// genuine number; the NaN-boxed remainder (a boolean atom, a boxed BigInt, a
// string, a sentinel, a heap kind) goes to $__eq_num. Both operands evaluate
// once, in source order (`numLeft`).
function looseNumberEq(num, other, otherIR, otherVt, negate, numLeft) {
  const fin = cmp => negate ? typed(['i32.eqz', cmp], 'i32') : cmp
  if (otherVt === VAL.STRING && !nullableOperand(other)) {
    const n = asF64(num), o = toNumF64(other, asF64(otherIR))
    return fin(typed(['f64.eq', ...(numLeft ? [n, o] : [o, n])], 'i32'))
  }
  inc('__eq_num')
  const lit = isLit(num)
  const n = lit ? null : temp('eqn'), o = temp('eqo')
  const nG = () => lit ? asF64(num) : ['local.get', `$${n}`], oG = ['local.get', `$${o}`]
  const setN = lit ? [] : [['local.set', `$${n}`, asF64(num)]]
  const setO = [['local.set', `$${o}`, asF64(otherIR)]]
  const cmp = typed(['if', ['result', 'i32'], ['f64.eq', oG, oG],
    ['then', ['f64.eq', nG(), oG]],
    ['else', ['call', '$__eq_num', nG(), ['i64.reinterpret_f64', oG]]]], 'i32')
  return typed(['block', ['result', 'i32'], ...(numLeft ? [...setN, ...setO] : [...setO, ...setN]), fin(cmp)], 'i32')
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
export const comparisonOps = {
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

}
