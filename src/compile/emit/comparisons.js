/**
 * NEG_NAN_MASK, emitTypeofCmp (public); the char/substring index-compare fusion (stringLiteral/intIndexIR/emitSingleCharIndexCmp/emitSubstringEqCmp); the loose/strict-eq machinery (numericVal/peelIntCmp/emitLooseEq/emitStrictEq/cmpOp/looseNumberEq/...); plus the ==/!=/instanceof/===/!==/</>/<=/>= emitter properties.
 *
 * @module compile/emit/comparisons
 */

import { i64Hex } from '../../../layout.js'
import { MUTATE_OPS, T, TYPEOF } from '../../ast.js'
import { LAYOUT, PTR, ctx, inc, ssoBitI64Hex } from '../../ctx.js'
import {
  asF64, asI32, asI32Sat, asI64, carrierF64, emitNum, freshId, isBoolAtom, isLit, isLiteralStr, isNull, isNullish, isNullishLit, isPlanTaggedBigint, isUndef, litVal, ptrOffsetIR, ptrTypeEq, readI64, resolveValType, temp, tempI32, tempI64, toNumF64, truthyIR, typed,
} from '../../ir.js'
import { censusMaybeUndefined, hasAmbiguousBoolMerge, valTypeOf } from '../../kind.js'
import { VAL, lookupValType, repOf, repOfGlobal } from '../../reps.js'
import { nonNegIntLiteral } from '../../static.js'
import { typedIdxProven } from '../../type.js'
import { representationResultTagRequired } from '../representation-plan.js'
import { numLiteralNode } from './bigint.js'
import { emit, emitIdentitySafe, emitIdentitySafeArms } from './dispatch.js'
import { emitInstanceof } from './instanceof.js'
import { REF_EQ_KINDS, foldOperandPure, isLit1, stringOps } from './shared.js'


// Sign+exponent mask isolating "negative NaN or -Infinity" — used only after an
// f64.eq(v,v) self-check has already failed (so -Infinity is excluded, leaving
// only negative NaN). Pointers/atoms are always emitted sign-clear (nanPrefixMaskHex,
// layout.js), so a sign-bit-set NaN can only be a genuine float NaN. Mirrors
// $__typeof's dynamic dispatch (module/core.js) bit-for-bit.
const NEG_NAN_MASK = 0xFFF0000000000000n

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
export const isSideEffectFree = (n) => {
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
export function matchVoidLocalStore(s) {
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
