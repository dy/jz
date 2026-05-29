/**
 * AST → WASM IR emission.
 *
 * # Stage contract
 *   IN:  prepared AST node + ctx state (func.locals, func.localReps, types.typedElem, etc.)
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

import {
  commaList, T, isBlockBody, isReassigned, hasOwnContinue, hasOwnBreakOrContinue,
  extractParams, classifyParam,
} from '../ast.js'
import { ctx, err, inc, PTR } from '../ctx.js'
import { nonNegIntLiteral, staticPropertyKey } from '../static.js'
import { findFreeVars } from './analyze.js'
import {
  containsNestedClosure, containsNestedLoop, nestedSmallLoopBudget,
  containsDeclOf, cloneWithSubst, containsKnownTypedArrayIndex,
  smallConstForTripCount, isTerminator, scanBoundedLoops, inBoundsCharCodeAt,
  exprType, MAX_SMALL_FOR_UNROLL, MAX_NESTED_FOR_UNROLL,
} from '../type.js'
import { valTypeOf } from '../kind.js'
import { VAL, lookupValType, repOf, updateRep, repOfGlobal } from '../reps.js'
import {
  typed, asF64, asI32, asI64, asPtrOffset, asParamType, toI32, fromI64,
  NULL_IR, nullExpr, undefExpr, MAX_CLOSURE_ARITY,
  WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS,
  mkPtrIR, ptrOffsetIR, ptrTypeIR, ptrTypeEq, dispatchByPtrType, sidecarOverride,
  isLit, litVal, isNullishLit, isPureIR, emitNum, f64rem, toNumF64, toStrI64,
  truthyIR, toBoolFromEmitted, isPostfix,
  isGlobal, isConst, usesDynProps, needsDynShadow,
  temp, tempI32, tempI64, allocPtr,
  block64, withTemp,
  boxedAddr, readVar, writeVar, isNullish, isNull, isUndef, isBoolAtom,
  isLiteralStr, resolveValType, isFuncRef,
  multiCount, loopTop, flat,
  reconstructArgsWithSpreads, tcoTailRewrite,
} from '../ir.js'
import { extractRefinements, withRefinements } from './flow-types.js'
import { JZ_UNDEF } from '../prepare/index.js'

const stringOps = (node) => {
  const rep = typeof node === 'string' ? repOf(node) : null
  return ctx.abi.resolve('string', rep)?.ops ?? ctx.abi.string.ops
}

// === Emitter state & operand classification ===

// Current emission "expect" mode ('void' or null); set by emit(), read by compound-assignment emitters
// to decide whether to emit a value-returning or side-effect-only form.
let _expect = null

// A genuine i32 *number* — safe for the i32 fast path in arithmetic/bitwise
// operators. An unboxed pointer (object/array/string/closure local kept as a
// raw i32 handle) is *also* i32-typed but carries `.ptrKind`; treating it as a
// number would compute on raw pointer bits. A ptrKind-carrying operand must
// instead route through ToNumber (`toNumF64`), which performs ToPrimitive.
const isI32Num = (v) => v.type === 'i32' && v.ptrKind == null

// Host globals auto-imported as `(import "env" "name" (global … i64))` when
// referenced as a value. Drained from ctx.core.hostGlobals at assembly.
const HOST_GLOBALS = new Set(['WebAssembly', 'globalThis', 'self', 'window', 'global', 'process'])

// An operand whose uint32 value can be *observed as a JS number* — a `>>>`
// result, an `unsignedResult` call, or an unsigned i32.const. Its magnitude can
// exceed signed-i32 range, so wrapping i32 arithmetic would corrupt it; widen to
// f64 instead. A `.wrapSafe` operand is also unsigned but is a `narrowUint32`
// accumulator read proven to be re-truncated by a `>>>` (ToUint32) sink at every
// use — wrapping is exactly its intended semantics, so it stays on the i32 path.
const widensUnsigned = (v) => v.unsigned && !v.wrapSafe

const FIRST_CLASS_UNARY_MATH = {
  'math.abs': 'f64.abs',
  'math.sqrt': 'f64.sqrt',
  'math.ceil': 'f64.ceil',
  'math.floor': 'f64.floor',
  'math.trunc': 'f64.trunc',
}

function builtinFunctionValue(name) {
  const op = FIRST_CLASS_UNARY_MATH[name]
  if (!op) err(`Builtin function '${name}' cannot be used as a first-class value`)
  if (!ctx.closure.table) err(`Builtin function '${name}' used as value requires closure support`)
  const fn = `${T}builtin_${name.replace(/\W/g, '_')}`
  if (!ctx.core.stdlib[fn]) {
    const width = ctx.closure.width ?? MAX_CLOSURE_ARITY
    const params = ['(param $__env f64)', '(param $__argc i32)']
    for (let i = 0; i < width; i++) params.push(`(param $__a${i} f64)`)
    ctx.core.stdlib[fn] = `(func $${fn} ${params.join(' ')} (result f64) (${op} (local.get $__a0)))`
    inc(fn)
  }
  let idx = ctx.closure.table.indexOf(fn)
  if (idx < 0) { idx = ctx.closure.table.length; ctx.closure.table.push(fn) }
  const ir = mkPtrIR(PTR.CLOSURE, idx, 0)
  ir.closureFuncIdx = idx
  return ir
}

/** Emit unary negation: constant-fold, or i32 sub from 0 / f64.neg. */
const emitNeg = (a) => {
  if (valTypeOf(a) === VAL.BIGINT) return fromI64(['i64.sub', ['i64.const', 0], asI64(emit(a))])
  const v = emit(a)
  if (isLit(v)) return emitNum(-litVal(v))
  if (isI32Num(v)) return typed(['i32.sub', typed(['i32.const', 0], 'i32'), v], 'i32')
  // f64.neg flips the sign bit, so negating a NaN yields 0xFFF8.. — a non-canonical
  // number-NaN that overlaps the NaN-boxed value space (jz reserves 0x7FF8.. as THE
  // number-NaN). `__is_truthy`/`__eq` compare against that exact pattern, so a sign-
  // flipped NaN reads as a tagged value (truthy / not-NaN). Fold any NaN result back
  // to canonical — the same invariant math.sqrt/min/max keep via `canon` (module/math.js).
  const t = temp('ng')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, ['f64.neg', toNumF64(a, v)]],
    ['select', ['f64.const', 'nan'], ['local.get', `$${t}`],
      ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]]], 'f64')
}

/** Try constant-folding binary arith: returns emitNum(result) or null. */
// `.unsigned` literals carry a uint32 value whose i32 `litVal` is its *signed* bit
// pattern (e.g. `-1` for 4294967295), so folding them through `fn` numerically would
// be wrong. Bail to the runtime path — the arithmetic handlers widen unsigned operands
// to f64 (convert_i32_u), reproducing the JS-spec result.
const foldConst = (va, vb, fn, guard) =>
  isLit(va) && isLit(vb) && !va.unsigned && !vb.unsigned && (!guard || guard(litVal(vb)))
    ? emitNum(fn(litVal(va), litVal(vb))) : null

// JS `*` is an f64 multiply; `i32.mul` yields only the exact product mod 2^32.
// Those agree under a ToInt32/ToUint32 sink (and as plain numbers) while the
// exact product stays f64-exact, i.e. |product| <= 2^53. Two i32 operands can
// reach 2^62, so `i32.mul` is sound only when one side is a literal small
// enough that, against the full i32 range (2^31) of the other, the product
// holds within 2^53 — i.e. |literal| <= 2^22. Keeps index arithmetic (`i*4`,
// `row*16`) on `i32.mul` while routing hash-mix-scale products to `f64.mul`.
const mulFitsI32 = (va, vb) =>
  (isLit(va) && Math.abs(litVal(va)) <= 0x400000) ||
  (isLit(vb) && Math.abs(litVal(vb)) <= 0x400000)

/** Emit typeof comparison: typeof x == typeCode → type-aware check. */
export function emitTypeofCmp(a, b, cmpOp) {
  let typeofExpr, code
  if (Array.isArray(a) && a[0] === 'typeof' && typeof b === 'number') { typeofExpr = a[1]; code = b }
  else if (Array.isArray(a) && a[0] === 'typeof' && Array.isArray(b) && b[0] == null) { typeofExpr = a[1]; code = b[1] }
  else return null
  if (typeof code !== 'number') return null

  const t = temp()
  const va = asF64(emit(typeofExpr))
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
  const staticFold = (target) => {
    const vt = resolveValType(typeofExpr, valTypeOf, lookupValType)
    if (vt) return typed(['i32.const', (vt === target) === eq ? 1 : 0], 'i32')
    return null
  }

  if (code === -1) {
    // typeof "number": v===v rejects NaN-box pointers; BOOL carrier is 0/1 → still typeof "boolean".
    if (resolveValType(typeofExpr, valTypeOf, lookupValType) === VAL.BOOL) return typed(['i32.const', eq ? 0 : 1], 'i32')
    return typed([eq ? 'f64.eq' : 'f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]], 'i32')
  }
  if (code === -2) return isPtrKind(PTR.STRING)
  if (code === -3) return wrap(isNullish(va))
  if (code === -4) return staticFold(VAL.BOOL) ?? wrap(isBoolAtom(['local.tee', `$${t}`, va]))
  if (code === -5) {
    // object: isPtr AND not(STRING|CLOSURE) AND not nullish — typeof never matches null/undef.
    inc('__ptr_type')
    const tt = `${T}${ctx.func.uniq++}`; ctx.func.locals.set(tt, 'i32')
    const isPtr = ['f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]]
    const notStrFn = ['i32.and',
      ['i32.ne', ['local.tee', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]], ['i32.const', PTR.STRING]],
      ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.CLOSURE]]]
    const notNullish = ['i32.eqz', isNullish(['local.get', `$${t}`])]
    return wrap(['i32.and', ['i32.and', isPtr, notStrFn], notNullish])
  }
  if (code === -6) return isPtrKind(PTR.CLOSURE)
  if (code === -7) {
    const fold = staticFold(VAL.BIGINT); if (fold) return fold
    // bigint heuristic: finite, nonzero, sub-normal abs (boxed BigInt carrier).
    const n = ['local.tee', `$${t}`, va]
    return wrap(['i32.and',
      ['f64.eq', n, ['local.get', `$${t}`]],
      ['i32.and',
        ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]],
        ['f64.lt', ['f64.abs', ['local.get', `$${t}`]], ['f64.const', 2.2250738585072014e-308]]]])
  }
  if (code >= 0) return isPtrKind(code)
  return null
}

/** Stringify a VAL.BOOL operand to "true"/"false" (f64 string pointer). The
 *  boolean rides the cheap 0/1 carrier, so we runtime-select between the two
 *  interned literals; a constant operand folds to a single literal downstream. */
export const emitBoolStr = (node) =>
  typed(['select', asF64(emit(['str', 'true'])), asF64(emit(['str', 'false'])), truthyIR(emit(node))], 'f64')

const CMP_SET = new Set(['>', '<', '>=', '<=', '==', '!=', '!'])
const isCmp = n => Array.isArray(n) && CMP_SET.has(n[0])

// Map/Set methods whose generic (`.${method}`) emitter assumes a collection
// receiver and dereferences a key/value argument. Every one needs ≥1 argument
// (`.get(k)` / `.has(v)` / `.add(v)` / `.delete(v)` / `.set(k[,v])`), so a
// zero-arg call on a not-proven-collection receiver cannot be the collection
// op — it is a user/closure method and must not reach the collection emitter.
const COLLECTION_METHODS = new Set(['get', 'set', 'has', 'add', 'delete'])

// String char-index methods bound generically (no `.string:` qualifier — no array
// name collision). `String.prototype.{charCodeAt,charAt}` each take at most one
// argument (the index), so a call supplying ≥2 args on a not-proven-string receiver
// cannot be the string built-in — it is a user method that happens to share the
// name (e.g. the self-host abi's `ctx.abi.string.ops.charCodeAt(sF64,iI32,ctx,oobNan)`).
// It must fall through to dynamic dispatch, mirroring COLLECTION_METHODS' arity guard.
const STR_INDEX_METHODS = new Set(['charCodeAt', 'charAt'])

// Pointer kinds for which JS `==` / `!=` is pure reference equality — i.e. i64 bit
// compare of the NaN-box is equivalent to __eq. Excludes STRING (content compare for
// heap strings) and BIGINT (content compare).
const REF_EQ_KINDS = new Set([
  VAL.ARRAY, VAL.OBJECT, VAL.SET, VAL.MAP,
  VAL.BUFFER, VAL.TYPED, VAL.CLOSURE, VAL.REGEX, VAL.DATE,
])

function stringLiteral(node) {
  if (Array.isArray(node) && node[0] === 'str' && typeof node[1] === 'string') return node[1]
  if (Array.isArray(node) && node[0] == null && typeof node[1] === 'string') return node[1]
  return null
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

/**
 * Emit an array-index expression in i32 arithmetic. A subscript is truncated to
 * i32 at the memory boundary regardless, so `+`/`-`/`*` over i32-typed leaves are
 * computed with wrapping i32 ops instead of the f64 round-trip
 * (`convert_i32 … f64.mul/add … trunc_sat_f64_s`) that `*` of two non-literal
 * i32s would otherwise force (see analyze.js exprType `*`).
 *
 * Correctness: i32 +/-/* preserve the residue mod 2^32, so the result equals the
 * expression's true integer value mod 2^32 — even if an intermediate product
 * overflows. Any valid index is in [0, 2^30) ⊂ [-2^31, 2^31), where two's
 * complement reproduces the true value exactly; out-of-range indices are OOB
 * (already UB — jz truncates the index to i32 at the boundary either way). Bails
 * to the f64 path for any non-i32 leaf (an f64 leaf may be fractional, where
 * trunc-then-add ≠ add-then-trunc) or non-{+,-,*} operator.
 */
const I32_INDEX_OP = { '+': 'i32.add', '-': 'i32.sub', '*': 'i32.mul' }
function tryI32Index(e) {
  if (Array.isArray(e)) {
    const inner = I32_INDEX_OP[e[0]]
    if (inner && e[2] != null) {
      const a = tryI32Index(e[1]); if (a == null) return null
      const b = tryI32Index(e[2]); if (b == null) return null
      return typed([inner, a, b], 'i32')
    }
    return null
  }
  const lit = nonNegIntLiteral(e)
  if (lit != null) return ['i32.const', lit]
  return exprType(e, ctx.func.locals) === 'i32' ? asI32(emit(e)) : null
}
export const emitIndex = (idx) => tryI32Index(idx) ?? asI32(emit(idx))

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
  if (vt === VAL.STRING && lit.length > 1) return emitNum(negate ? 1 : 0)

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
  const TO_END = ['i32.const', 0x7FFFFFFF]
  let startIR, endIR
  if (method === 'substr' && args[1] != null) {
    // substr's 2nd arg is a length: end = start + length, so start reads twice.
    const s = tempI32('subS')
    startIR = ['local.tee', `$${s}`, args[0] == null ? ['i32.const', 0] : asI32(emit(args[0]))]
    endIR = ['i32.add', ['local.get', `$${s}`], asI32(emit(args[1]))]
  } else {
    startIR = args[0] == null ? ['i32.const', 0] : asI32(emit(args[0]))
    endIR = args[1] == null ? TO_END : asI32(emit(args[1]))
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

// Flow-sensitive type refinement moved to ./flow-types.js (extractRefinements,
// predicateRefinement, mergeRefinement, withRefinements). emit.js imports them
// from there — see the import block at the top of this file.

function unrollSmallConstFor(init, cond, step, body) {
  const end = smallConstForTripCount(init, cond, step)
  if (end == null) return null
  const name = init[1][1]
  if (containsNestedLoop(body)) {
    const nestedMode = ctx.transform.optimize?.nestedSmallConstForUnroll
    if (nestedMode !== true && (nestedMode !== 'auto' || !containsKnownTypedArrayIndex(body))) return null
    if (end * nestedSmallLoopBudget(body) > MAX_NESTED_FOR_UNROLL) return null
  }
  if (hasOwnBreakOrContinue(body) || containsNestedClosure(body) || containsDeclOf(body, name)) return null
  if (isReassigned(body, name)) return null

  const out = []
  for (let i = 0; i < end; i++) out.push(...emitVoid(cloneWithSubst(body, name, i)))
  return out
}

function canThrow(body, seen = new Set()) {
  if (!Array.isArray(body)) return false
  const op = body[0]
  if (op === 'throw') return true
  if (op === '=>') return false
  if (op === '()') {
    const callee = body[1]
    // A call can throw unless we can see the whole callee and prove it can't:
    // only direct calls into a resolvable, non-raw function body are traceable.
    // Indirect/method/builtin calls (callee not a plain name, or a name we can't
    // resolve) are conservatively throwing — a user `try` must wrap them.
    if (typeof callee !== 'string') return true
    const bodyName = ctx.func.directClosures?.get(callee)
    const f = ctx.func.map?.get(bodyName || callee)
    if (!f?.body || f.raw) return true
    if (!seen.has(f.name)) {
      seen.add(f.name)
      if (canThrow(f.body, seen)) return true
    }
  }
  for (let i = 1; i < body.length; i++) if (canThrow(body[i], seen)) return true
  return false
}

const isBoundName = name =>
  ctx.func.locals?.has(name) || ctx.func.current?.params?.some(p => p.name === name)

// Loop-bound hoisting (see the 'for' emitter): comparison ops whose invariant side
// is worth lifting, and the test for an immutable, loop-stable `arr.length`. Typed
// arrays have a fixed length, so `arr.length` is loop-invariant when `arr` is a
// typed-array var that the body never reassigns — safe to compute once.
const HOIST_CMP = new Set(['<', '<=', '>', '>='])
const immutableLenBound = (node, body) => {
  // Unwrap the `| 0` i32 coercion jz wraps a loop bound in (`i < arr.length`
  // emits `i < (arr.length | 0)`).
  if (Array.isArray(node) && node[0] === '|' && Array.isArray(node[2]) && node[2][0] == null && node[2][1] === 0)
    node = node[1]
  return Array.isArray(node) && node[0] === '.' && node[2] === 'length'
    && typeof node[1] === 'string' && lookupValType(node[1]) === VAL.TYPED
    && !isReassigned(body, node[1])
}

// A source-defined function (carries a body) — as opposed to an imported name,
// which `ctx.func.names` also holds but which has no body and may legitimately
// share a name with a built-in emitter (e.g. an imported `parseInt`).
const isUserFunc = name => !!ctx.func.map.get(name)?.body

/** Emit pending `finally` cleanups for an abrupt control-flow exit.
 *  Inner cleanups run before outer cleanups. While emitting each cleanup, remove
 *  it from the active stack so `return` inside `finally` does not re-enter it. */
function emitFinalizers() {
  const stack = ctx.func.finallyStack || []
  if (stack.length === 0) return []
  const saved = stack.slice()
  const out = []
  for (let i = saved.length - 1; i >= 0; i--) {
    ctx.func.finallyStack = saved.slice(0, i)
    out.push(...emitVoid(saved[i]))
  }
  ctx.func.finallyStack = saved
  return out
}

function withFinallyStack(stack, fn) {
  const prev = ctx.func.finallyStack || []
  ctx.func.finallyStack = stack
  try { return fn() }
  finally { ctx.func.finallyStack = prev }
}

// withRefinements moved to ./flow-types.js

/** Coerce an AST node to an i32 boolean, folding && / || at the boolean boundary. */
export function toBool(node) {
  const op = Array.isArray(node) ? node[0] : null
  if (CMP_SET.has(op)) return emit(node)
  if (op === '&&') {
    const la = toBool(node[1]), lb = toBool(node[2])
    if (isCmp(node[1]) && isCmp(node[2])) return typed(['i32.and', la, lb], 'i32')
    return typed(['if', ['result', 'i32'], la, ['then', lb], ['else', ['i32.const', 0]]], 'i32')
  }
  if (op === '||') {
    const la = toBool(node[1]), lb = toBool(node[2])
    if (isCmp(node[1]) && isCmp(node[2])) return typed(['i32.or', la, lb], 'i32')
    return typed(['if', ['result', 'i32'], la, ['then', ['i32.const', 1]], ['else', lb]], 'i32')
  }
  return toBoolFromEmitted(emit(node))
}

/** Coerce an emitted arg IR to match a callee param. Param may carry ptrKind (pointer-ABI
 *  i32 offset), else falls back to numeric WASM type coercion. */
function coerceArg(ir, param) {
  if (param?.ptrKind != null) return ptrOffsetIR(ir, param.ptrKind)
  return asParamType(ir, param?.type)
}

/** Pad an emitted-args array up to a signature's arity with type-appropriate
 *  defaults (`i32.const 0` for i32 params, `undefExpr()` for f64). Mutates and
 *  returns `args` for chaining. */
function padArgs(args, params) {
  while (args.length < params.length)
    args.push(params[args.length].type === 'i32' ? typed(['i32.const', 0], 'i32') : undefExpr())
  return args
}

/** Emit a node list as call arguments for the given param list: per-param
 *  coercion then arity padding. Used at every direct-call site. */
function emitCallArgs(argNodes, params) {
  return padArgs(argNodes.map((a, k) => coerceArg(emit(a), params[k])), params)
}

/** Stamp a `call` IR with the pointer-ABI / sign metadata its signature carries.
 *  Returns `callIR` for chaining. Centralizes the three-property copy every
 *  direct-call emission did inline. */
function attachSigMeta(callIR, sig) {
  if (sig?.ptrKind != null) callIR.ptrKind = sig.ptrKind
  if (sig?.ptrAux != null) callIR.ptrAux = sig.ptrAux
  if (sig?.unsignedResult) callIR.unsigned = true
  return callIR
}

/**
 * Materialize a multi-value function call as a heap array.
 * Call → store each result in temp → copy to allocated array → return pointer.
 */
export function materializeMulti(callNode) {
  const name = callNode[1]
  const func = ctx.func.map.get(name)
  const n = func.sig.results.length
  const argList = commaList(callNode[2])
  const emittedArgs = emitCallArgs(argList, func.sig.params)
  const temps = Array.from({ length: n }, () => temp())
  const out = allocPtr({ type: 1, len: n, tag: 'marr' })
  const ir = [out.init, ['call', `$${name}`, ...emittedArgs]]
  for (let k = n - 1; k >= 0; k--) ir.push(['local.set', `$${temps[k]}`])
  for (let k = 0; k < n; k++)
    ir.push(['f64.store', ['i32.add', ['local.get', `$${out.local}`], ['i32.const', k * 8]], ['local.get', `$${temps[k]}`]])
  ir.push(out.ptr)
  return block64(...ir)
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

/** Emit let/const initializations as typed local.set instructions. */
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
      const undef = undefExpr()
      if (ctx.func.boxed.has(i)) {
        const cell = ctx.func.boxed.get(i)
        ctx.func.locals.set(cell, 'i32')
        if (inLoop ? !loopPrebox(i) : !ctx.func.preboxed?.has(i))
          result.push(['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]])
        result.push(['f64.store', ['local.get', `$${cell}`], undef])
        continue
      }
      if (isGlobal(i)) {
        if (!ctx.scope.globalTypes.has(i)) result.push(['global.set', `$${i}`, undef])
        continue
      }
      result.push(['local.set', `$${i}`, undef])
      continue
    }
    if (!Array.isArray(i) || i[0] !== '=') continue
    const [, name, init] = i
    if (typeof name !== 'string' || init == null) continue

    // SRoA flat object: `let o = {a:1, b:2}` — dissolve fields into `o#i`
    // locals, no heap alloc. Each field local ← asF64(value). Reads/writes are
    // rewritten by the `.`/`[]` flat hooks. See scanFlatObjects (analyze.js).
    // Monotonic-extension fields (`o.newProp = …`) carry no literal value —
    // they init to undefined so a read before the write matches JS.
    const flatDecl = ctx.func.flatObjects?.get(name)
    if (flatDecl && Array.isArray(init) && init[0] === '{}') {
      for (let j = 0; j < flatDecl.names.length; j++)
        result.push(['local.set', `$${name}#${j}`,
          flatDecl.values[j] === undefined ? undefExpr() : asF64(emit(flatDecl.values[j]))])
      continue
    }

    // Multi-value ephemeral destructuring — skip heap alloc when temp is
    // assigned from a multi-value call then immediately destructured element-by-element.
    if (name.startsWith(T) && Array.isArray(init) && init[0] === '()' && typeof init[1] === 'string'
      && ctx.func.names?.has(init[1])) {
      const func = ctx.func.map.get(init[1])
      const n = func?.sig.results.length
      if (n > 1) {
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
        if (match && targets.length === n) {
          const argList = commaList(init[2])
          const emittedArgs = emitCallArgs(argList, func.sig.params)
          result.push(['call', `$${init[1]}`, ...emittedArgs])
          for (let k = n - 1; k >= 0; k--)
            result.push(['local.set', `$${targets[k]}`])
          ii += n
          continue
        }
      }
    }
    // No-copy slice view: `let t = s.slice(...)` whose result scanSliceViews
    // proved never escapes — lower the initializer to a SLICE_BIT view instead
    // of a copying slice. Everything downstream treats `t` as an ordinary
    // string. Gated here (not in the analysis) on a statically-known STRING
    // receiver — param types are settled only by emit time — and on plain-local
    // carriers (boxed/global escape); any miss falls back to the copying slice.
    let viewInit = null
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
    const val = viewInit || emit(init)
    if (isObjLit) ctx.schema.targetStack.pop()
    // Direct-call dispatch for const-bound, non-escaping local closures: skip call_indirect.
    // Gate: not boxed (no mutable cross-fn capture), not global, not reassigned in this body.
    // isReassigned is conservative across nested arrow shadows — we miss the optimization
    // rather than emit a wrong direct call.
    if (Array.isArray(init) && init[0] === '=>' && val?.closureBodyName && !ctx.func.boxed.has(name) && !isGlobal(name)
        && ctx.func.body && !isReassigned(ctx.func.body, name)) {
      if (!ctx.func.directClosures) ctx.func.directClosures = new Map()
      ctx.func.directClosures.set(name, val.closureBodyName)
    }
    if (ctx.func.boxed.has(name)) {
      const cell = ctx.func.boxed.get(name)
      ctx.func.locals.set(cell, 'i32')
      if (inLoop ? !loopPrebox(name) : !ctx.func.preboxed?.has(name))
        result.push(['local.set', `$${cell}`, ['call', '$__alloc', ['i32.const', 8]]])
      result.push(['f64.store', ['local.get', `$${cell}`], asF64(val)])
      continue
    }
    if (isGlobal(name)) {
      // Unboxed pointer const globals carry the raw i32 offset; init coerces via asPtrOffset.
      const grep = repOfGlobal(name)
      if (grep?.ptrKind != null) {
        result.push(['global.set', `$${name}`, asPtrOffset(val, grep.ptrKind)])
        continue
      }
      // Pre-folded numeric const globals have their init baked into the decl — skip.
      // A mutable global narrowed to i32 by integer-global inference keeps the
      // declareGlobal-default `(i32.const 0)` init, so its real initializer must
      // still run (coerced to the global's type).
      if (ctx.scope.globalTypes.has(name)) {
        if (ctx.scope.consts?.has(name)) continue
        const gt = ctx.scope.globalTypes.get(name)
        result.push(['global.set', `$${name}`, gt === 'i32' ? asI32(val) : asF64(val)])
        continue
      }
      result.push(['global.set', `$${name}`, asF64(val)])
      continue
    }
    const localType = ctx.func.locals.get(name) || 'f64'
    let ptrKind = repOf(name)?.ptrKind
    // Emit-time rep mutation (lifecycle: analysis → emit transition).
    // Inherit ptrKind from a pointer-ABI RHS: destructure temps (`__d0 = v`) and other
    // fresh let-bindings whose init is already an unboxed pointer. Without this, readVar
    // returns an untyped i32 local.get and later `asF64` emits a numeric convert instead
    // of a ptr-rebox. Safe because emitDecl runs once per let/const binding — no prior
    // emit-time read could have observed the unset rep.
    if (ptrKind == null && val.ptrKind != null && localType === 'i32' && !ctx.func.boxed?.has(name)) {
      updateRep(name, { ptrKind: val.ptrKind })
      ptrKind = val.ptrKind
      if (val.ptrAux != null) {
        updateRep(name, { ptrAux: val.ptrAux })
        // OBJECT-only: aux *is* the schemaId; mirror to ctx.schema.vars + rep.schemaId so
        // .prop slot resolution sees a precise binding. TYPED/CLOSURE aux carries other
        // semantics (elem code / funcIdx) and must not leak into schema lookups.
        if (val.ptrKind === VAL.OBJECT && !ctx.schema.vars?.has(name)) {
          ctx.schema.vars.set(name, val.ptrAux)
          updateRep(name, { schemaId: val.ptrAux })
        }
      }
    }
    let coerced
    if (ptrKind != null) {
      // Unboxed pointer local — extract i32 offset from NaN-boxed f64 via reinterpret, not numeric trunc.
      // CLOSURE init carries funcIdx in val.closureFuncIdx; persist it on the rep so a later
      // asF64 (escape: store, return, indirect-call rebox) reconstructs the correct table slot.
      // Emit-time mutation — analyzeValTypes never sees closureFuncIdx.
      if (ptrKind === VAL.CLOSURE && val.closureFuncIdx != null && repOf(name)?.ptrAux == null)
        updateRep(name, { ptrAux: val.closureFuncIdx })
      coerced = val.ptrKind === ptrKind ? val
        : typed(['i32.wrap_i64', ['i64.reinterpret_f64', asF64(val)]], 'i32')
    } else {
      coerced = localType === 'f64' ? asF64(val) : val.type === 'i32' ? val : toI32(val)
    }
    if (!(isLit(coerced) && coerced[1] === 0 && !Object.is(coerced[1], -0) && !ctx.func.stack.length))
      result.push(['local.set', `$${name}`, coerced])

    const schemaId = ctx.schema.idOf?.(name)
    if (ctx.func.localProps?.has(name) && schemaId != null) {
      const schema = ctx.schema.resolve(name)
      if (schema?.[0] === '__inner__') {
        inc('__alloc_hdr', '__mkptr')
        const bt = `${T}bx${ctx.func.uniq++}`
        ctx.func.locals.set(bt, 'i32')
        const innerName = `${name}${T}inner`
        ctx.func.locals.set(innerName, 'f64')
        result.push(
          ['local.set', `$${innerName}`, ['local.get', `$${name}`]],
          ['local.set', `$${bt}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', Math.max(1, schema.length)]]],
          ['f64.store', ['local.get', `$${bt}`], ['local.get', `$${name}`]],
          ...schema.slice(1).map((_, j) =>
            ['f64.store', ['i32.add', ['local.get', `$${bt}`], ['i32.const', (j + 1) * 8]], ['f64.const', 0]]),
          ['local.set', `$${name}`, mkPtrIR(PTR.OBJECT, schemaId, ['local.get', `$${bt}`])])
      }
    }
  }
  return result.length === 0 ? null : result.length === 1 ? result[0] : result
}

/**
 * Copy a spread source's elements into a destination array.
 *
 * `dest` is the destination data-base i32 local; `posLocal` the element index to
 * start writing at — advanced by the source length on exit. An ARRAY source is a
 * contiguous block of f64 NaN-boxes, so it copies with a single `memory.copy`; a
 * string/typed source needs a per-element decode. The source's *type* is
 * loop-invariant — it cannot change while the spread runs — so when it is not
 * statically known it is resolved exactly once (one `__ptr_type`) and branched,
 * never re-checked per element. Returns a list of IR instructions.
 */
function emitSpreadCopy(dest, posLocal, srcLocal, srcLenLocal, staticVT) {
  const srcI64 = () => ['i64.reinterpret_f64', ['local.get', `$${srcLocal}`]]
  const destAddr = idx => ['i32.add', ['local.get', `$${dest}`], ['i32.shl', idx, ['i32.const', 3]]]
  const arrCopy = () => (inc('__ptr_offset'),
    ['memory.copy', destAddr(['local.get', `$${posLocal}`]),
      ['call', '$__ptr_offset', srcI64()],
      ['i32.shl', ['local.get', `$${srcLenLocal}`], ['i32.const', 3]]])
  const scalarLoop = () => {
    const sidx = `${T}sidx${ctx.func.uniq++}`
    ctx.func.locals.set(sidx, 'i32')
    const loopId = ctx.func.uniq++
    const elem = ctx.module.modules['string']
      ? ['if', ['result', 'f64'],
          ['i32.eq', ['call', '$__ptr_type', srcI64()], ['i32.const', PTR.STRING]],
          ['then', (inc('__str_idx'), ['call', '$__str_idx', srcI64(), ['local.get', `$${sidx}`]])],
          ['else', (inc('__typed_idx'), ['call', '$__typed_idx', srcI64(), ['local.get', `$${sidx}`]])]]
      : (inc('__typed_idx'), ['call', '$__typed_idx', srcI64(), ['local.get', `$${sidx}`]])
    // Reset the counter on each entry — WASM zeroes locals once at function
    // entry, but this loop re-executes when the spread sits inside a JS loop;
    // a stale `sidx` (= prior srcLen) would skip the copy entirely.
    return ['block', `$break${loopId}`,
      ['local.set', `$${sidx}`, ['i32.const', 0]],
      ['loop', `$loop${loopId}`,
        ['br_if', `$break${loopId}`, ['i32.ge_s', ['local.get', `$${sidx}`], ['local.get', `$${srcLenLocal}`]]],
        ['f64.store', destAddr(['i32.add', ['local.get', `$${posLocal}`], ['local.get', `$${sidx}`]]), elem],
        ['local.set', `$${sidx}`, ['i32.add', ['local.get', `$${sidx}`], ['i32.const', 1]]],
        ['br', `$loop${loopId}`]]]
  }
  const advance = ['local.set', `$${posLocal}`,
    ['i32.add', ['local.get', `$${posLocal}`], ['local.get', `$${srcLenLocal}`]]]
  if (staticVT === VAL.ARRAY) return [arrCopy(), advance]
  if (staticVT === VAL.STRING || staticVT === VAL.TYPED) return [scalarLoop(), advance]
  inc('__ptr_type')
  const tt = tempI32(`${T}spt`)
  return [
    ['local.set', `$${tt}`, ['call', '$__ptr_type', srcI64()]],
    dispatchByPtrType(tt, [[PTR.ARRAY, arrCopy()]], scalarLoop(), null),
    advance,
  ]
}

/**
 * Build an array from items, handling ['__spread', expr] markers.
 * Split into sections (normal arrays and spreads), then copy all into result.
 */
export function buildArrayWithSpreads(items) {
  const spreads = []
  for (let i = 0; i < items.length; i++) {
    if (Array.isArray(items[i]) && items[i][0] === '__spread') {
      spreads.push({ pos: i, expr: items[i][1] })
    }
  }

  if (spreads.length === 0) {
    return emit(['[', ...items])
  }

  const sections = []
  let currentArray = []

  for (let i = 0; i < items.length; i++) {
    if (Array.isArray(items[i]) && items[i][0] === '__spread') {
      if (currentArray.length > 0) {
        sections.push({ type: 'array', items: currentArray })
        currentArray = []
      }
      sections.push({ type: 'spread', expr: items[i][1] })
    } else {
      currentArray.push(items[i])
    }
  }
  if (currentArray.length > 0) {
    sections.push({ type: 'array', items: currentArray })
  }

  // A single all-normal section is a plain literal — defer to the `[` emitter.
  // A single *spread* section is NOT shortcut to `emit(sec.expr)`: that would
  // alias the source, but `[...x]` must yield a fresh array. It falls through
  // to the alloc + emitSpreadCopy path below, which copies.
  if (sections.length === 1 && sections[0].type === 'array') {
    return emit(['[', ...sections[0].items])
  }

  const len = tempI32('len')
  const pos = tempI32('pos')
  const out = allocPtr({ type: 1, len: ['local.get', `$${len}`], tag: 'arr' })
  const result = out.local

  const ir = []
  inc('__len')

  // Pass 1 — evaluate every section IN SOURCE ORDER into temps. JS spread keeps
  // strict left-to-right order: a later spread whose source mutates an earlier
  // element's input must still observe the pre-mutation value. Array items
  // become per-item f64 temps; spreads become a ptr temp + a cached __len.
  for (const sec of sections) {
    if (sec.type === 'array') {
      sec.itemLocals = []
      for (let i = 0; i < sec.items.length; i++) {
        const it = `${T}ai${ctx.func.uniq++}`
        ctx.func.locals.set(it, 'f64')
        sec.itemLocals.push(it)
        ir.push(['local.set', `$${it}`, asF64(emit(sec.items[i]))])
      }
    } else {
      sec.local = `${T}sp${ctx.func.uniq++}`
      ctx.func.locals.set(sec.local, 'f64')
      sec.lenLocal = `${T}spl${ctx.func.uniq++}`
      ctx.func.locals.set(sec.lenLocal, 'i32')
      const n = multiCount(sec.expr)
      // Normalize a (non-multi) spread source to an index-iterable: Set→keys /
      // Map→[k,v] arrays, others pass through. Only when `collection` is loaded —
      // otherwise no Set/Map can exist and the source is already index-iterable.
      const srcExpr = !n && ctx.module.modules.collection ? ['()', '__iter_arr', sec.expr] : sec.expr
      // A materialized multi-value is not a statically-typed pointer — let
      // emitSpreadCopy resolve its kind at runtime via its one-time __ptr_type branch.
      sec.val = n ? undefined : valTypeOf(srcExpr)
      ir.push(['local.set', `$${sec.local}`, n ? materializeMulti(sec.expr) : asF64(emit(srcExpr))])
      // Cache __len once per spread; reused below for total-len sum and the copy.
      ir.push(['local.set', `$${sec.lenLocal}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${sec.local}`]]]])
    }
  }

  // Pass 2 — total length (array sections statically sized, spreads cached above).
  ir.push(['local.set', `$${len}`, ['i32.const', 0]])
  for (const sec of sections) {
    if (sec.type === 'array') {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', sec.items.length]]])
    } else {
      ir.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['local.get', `$${sec.lenLocal}`]]])
    }
  }

  // Pass 3 — allocate exact, then store the pre-evaluated temps.
  ir.push(out.init, ['local.set', `$${pos}`, ['i32.const', 0]])
  for (const sec of sections) {
    if (sec.type === 'array') {
      for (const it of sec.itemLocals) {
        ir.push(
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
            ['local.get', `$${it}`]],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]]
        )
      }
    } else {
      ir.push(...emitSpreadCopy(result, pos, sec.local, sec.lenLocal, sec.val))
    }
  }

  ir.push(out.ptr)
  return block64(...ir)
}

/** Emit node in void context: emit + drop any value. Block bodies route through emitBlockBody. */
export function emitVoid(node) {
  if (isBlockBody(node)) return emitBlockBody(node)
  const ir = emit(node, 'void')
  const items = flat(ir)
  if (ir?.type && ir.type !== 'void') items.push('drop')
  return items
}

/** Emit block body as flat list of WASM instructions. Unwraps {} and delegates to emitVoid per statement.
 *  Also drives early-return refinement: `if (!guard) return/throw` narrows `guard` for the
 *  rest of the enclosing block. Refinements added here are rolled back on block exit. */
export function emitBlockBody(node) {
  const inner = node[1]
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  const out = []
  const accumulated = []
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]
    if (s == null || typeof s === 'number') continue
    out.push(...emitVoid(s))
    // After an `if (cond) terminator` (no else), narrow types from !cond for subsequent statements.
    // Skip names that are reassigned later — refinement would be unsound past the assignment.
    if (Array.isArray(s) && s[0] === 'if' && s[3] == null && isTerminator(s[2])) {
      const refs = extractRefinements(s[1], new Map(), false)
      for (const [name, fact] of refs) {
        let reassigned = false
        for (let j = i + 1; j < stmts.length; j++)
          if (isReassigned(stmts[j], name)) { reassigned = true; break }
        if (reassigned) continue
        const cur = ctx.func.refinements.get(name)
        accumulated.push([name, cur])
        // Merge so sibling early-returns layering on the same name compose
        // (e.g. `if (typeof x === 'string') return; if (Array.isArray(x)) return;`
        // leaves both `notString: true` and would-be array exclusion stacked).
        ctx.func.refinements.set(name, cur ? { ...cur, ...fact } : fact)
      }
    }
  }
  // Restore prior refinements on block exit.
  for (let i = accumulated.length - 1; i >= 0; i--) {
    const [name, prev] = accumulated[i]
    if (prev === undefined) ctx.func.refinements.delete(name); else ctx.func.refinements.set(name, prev)
  }
  return out
}

// A VAL.BOOL value rides the cheap 0/1 numeric carrier, and `ToNumber(bool)` is
// exactly that carrier — so for relational / loose-equality coercion a boolean
// behaves identically to a number. Normalize it before the type-directed compare
// dispatch (the BOOL fact still drives typeof / String / boundary boxing; only
// these arithmetic-shaped operators read it as numeric).
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
function emitLooseEq(a, b, negate) {
  const eqOp = negate ? 'ne' : 'eq'
  const sentinel = emitNum(negate ? 1 : 0)
  const charCmp = emitSingleCharIndexCmp(a, b, negate); if (charCmp) return charCmp
  const subCmp = emitSubstringEqCmp(a, b, negate); if (subCmp) return subCmp
  // JS loose nullish equality: x == null / x == undefined.
  // If the non-literal side has a known non-null VAL type, fold to the sentinel.
  const nullishOf = (other) => {
    if (valTypeOf(other)) return sentinel
    const chk = isNullish(asF64(emit(other)))
    return negate ? typed(['i32.eqz', chk], 'i32') : chk
  }
  if (isNullishLit(a)) return nullishOf(b)
  if (isNullishLit(b)) return nullishOf(a)
  // typeof x == 'string' → compile-time type check (prepare rewrites string to type code)
  const tc = emitTypeofCmp(a, b, eqOp); if (tc) return tc
  const va = emit(a), vb = emit(b)
  if (va.type === 'i32' && vb.type === 'i32') return typed([`i32.${eqOp}`, va, vb], 'i32')
  // Either side known-pure NUMBER (literal or typed) → f64.eq/ne is correct regardless
  // of the other side: jz's `==` is strict (prepare.js:868), and every NaN-boxed pointer
  // reinterprets to a quiet NaN (0x7FF8… prefix) so f64.eq with any normal float is false.
  // Catches `closureVar === 34` in jzified hot loops where the unknown side has no VAL.
  const vta = numericVal(resolveValType(a, valTypeOf, lookupValType))
  const vtb = numericVal(resolveValType(b, valTypeOf, lookupValType))
  if (vta === VAL.NUMBER && needsToNumberCoercion(b, vtb)) return looseNumberEq(va, b, vb, negate)
  if (vtb === VAL.NUMBER && needsToNumberCoercion(a, vta)) return looseNumberEq(vb, a, va, negate)
  if (vta === VAL.NUMBER || vtb === VAL.NUMBER) return typed([`f64.${eqOp}`, asF64(va), asF64(vb)], 'i32')
  // Reference-equal pointer kinds (same kind, non-STRING, non-BIGINT): i64 bit equality.
  // JS `==` on objects/arrays/sets/maps/etc. is pure reference equality — no content path.
  // STRING needs __eq (heap strings can be equal by content but different pointers).
  // BIGINT needs __eq (heap-allocated, content compare).
  if (vta && vta === vtb && REF_EQ_KINDS.has(vta)) {
    return typed([`i64.${eqOp}`, ['i64.reinterpret_f64', asF64(va)], ['i64.reinterpret_f64', asF64(vb)]], 'i32')
  }
  inc('__eq')
  const call = typed(['call', '$__eq', asI64(va), asI64(vb)], 'i32')
  return negate ? typed(['i32.eqz', call], 'i32') : call
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
    if (valTypeOf(other)) return emitNum(negate ? 1 : 0)
    const chk = (undef ? isUndef : isNull)(asF64(emit(other)))
    return negate ? typed(['i32.eqz', chk], 'i32') : chk
  }
  const sa = sentinelOf(a), sb = sentinelOf(b)
  if (sb) return strictSentinel(a, sb === 'undef')
  if (sa) return strictSentinel(b, sa === 'undef')
  // Known, differing primitive classes can never be strictly equal.
  const rawA = resolveValType(a, valTypeOf, lookupValType)
  const rawB = resolveValType(b, valTypeOf, lookupValType)
  if (rawA && rawB && rawA !== rawB && (STRICT_PRIM.has(rawA) || STRICT_PRIM.has(rawB)))
    return emitNum(negate ? 1 : 0)
  // Same type (or dynamic-unknown): identical bits to loose `==`/`!=`.
  return emitter[negate ? '!=' : '=='](a, b)
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
    const op = bigintUnsignedBound(a) || bigintUnsignedBound(b) ? i32op.replace('_s', '_u') : i32op
    return typed([`i64.${op}`, asI64(va), asI64(vb)], 'i32')
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

function arrayIndexKey(key) {
  const n = Number(key)
  const u = n >>> 0
  return String(u) === key && u !== 0xffffffff ? u : null
}

// === Assignment IR helpers ===

/** Write a (possibly relocated) f64 pointer back to its binding, honoring the
 *  same cell-vs-global-vs-local discipline as writeVar. Returns the store IR
 *  for the given f64 `ptr` expression; used as a callback by helpers that may
 *  relocate the array header (`__arr_set_idx_ptr`, `__arr_set_length`,
 *  `__arr_grow`, `__hash_set`). */
function persistBindingPtr(name, ptr) {
  if (ctx.func.boxed?.has(name)) return ['f64.store', boxedAddr(name), ptr]
  if (isGlobal(name)) return ['global.set', `$${name}`, ptr]
  return ['local.set', `$${name}`, ptr]
}
/** Curried form for call sites that pass a persist callback. */
const persistBinding = name => ptr => persistBindingPtr(name, ptr)

/** Emit an ARRAY element write via `__arr_set_idx_ptr`. The helper may relocate
 *  the array header (capacity grow); `persist` writes the new pointer back to
 *  the receiver binding. Returns the stored value as the block result. */
function storeArrayPayload(arrExpr, idxNode, valueExpr, persist) {
  const arrTmp = `${T}asi${ctx.func.uniq++}`
  const idxTmp = `${T}asj${ctx.func.uniq++}`
  const valTmp = `${T}asv${ctx.func.uniq++}`
  ctx.func.locals.set(arrTmp, 'f64')
  ctx.func.locals.set(idxTmp, 'i32')
  ctx.func.locals.set(valTmp, 'f64')
  inc('__arr_set_idx_ptr')
  const body = [
    ['local.set', `$${arrTmp}`, arrExpr],
    ['local.set', `$${idxTmp}`, asI32(typed(idxNode, 'f64'))],
    ['local.set', `$${valTmp}`, valueExpr],
    ['local.set', `$${arrTmp}`, ['call', '$__arr_set_idx_ptr', ['i64.reinterpret_f64', ['local.get', `$${arrTmp}`]], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]],
  ]
  if (persist) body.push(persist(['local.get', `$${arrTmp}`]))
  body.push(['local.get', `$${valTmp}`])
  return block64(...body)
}

/** Strict-mode guard for dynamic property writes — emitted in branches that
 *  fall through to `__dyn_set` or its key-kind dispatch. */
function ensureDynSetAllowed(arr) {
  if (!ctx.transform.strict) return
  const arrLabel = typeof arr === 'string' ? arr : '<expr>'
  err(`strict mode: dynamic property assignment \`${arrLabel}[<expr>] = ...\` falls back to __dyn_set. Use a literal key or known array/typed-array numeric index, or pass { strict: false }.`)
}

/** Last-resort dynamic property write through `__dyn_set`. */
function dynSetCall(arr, keyExpr, valueExpr) {
  ensureDynSetAllowed(arr)
  inc('__dyn_set')
  return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(arr)), asI64(keyExpr), asI64(valueExpr)]], 'f64')
}

/** Runtime fork by key kind: string keys go to `__dyn_set`, numeric keys go through
 *  `numericIR(keyExpr)`. Used when key type is unknown at compile time. */
function dispatchByKeyKind(arr, keyExpr, valueExpr, numericIR) {
  ensureDynSetAllowed(arr)
  const keyTmp = temp()
  return block64(
    ['local.set', `$${keyTmp}`, keyExpr],
    ['if', ['result', 'f64'], ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]]],
      ['then', ['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(arr)), ['i64.reinterpret_f64', ['local.get', `$${keyTmp}`]], asI64(valueExpr)]]],
      ['else', numericIR(['local.get', `$${keyTmp}`])]])
}

/** Build a `__ptr_type`-fork IR for `arr[idx] = val` when receiver is opaque
 *  (non-string expr, or string-named binding of unknown VAL). Forks on
 *  ARRAY → `__arr_set_idx_ptr` (+ optional persist), TYPED → `__typed_set_idx`,
 *  else → raw f64.store at the OBJECT/HASH payload offset. */
function emitPolymorphicElementStore(arrExpr, idxI32, valueExpr, arrVT, persist) {
  const objTmp = temp('asu')
  const idxTmp = tempI32('asi')
  const ptrTmp = temp('asp')
  const valTmp = temp()
  const hasTypedSet = !!ctx.core.stdlib['__typed_set_idx']
  inc('__ptr_type', '__arr_set_idx_ptr')
  if (hasTypedSet) inc('__typed_set_idx')
  const arrSetCall = ['call', '$__arr_set_idx_ptr', ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]
  const arrayBranch = ['block', ['result', 'f64'],
    ['local.set', `$${ptrTmp}`, arrSetCall],
    ...(persist ? [persist(['local.get', `$${ptrTmp}`])] : []),
    ['local.get', `$${valTmp}`]]
  const fallbackStore = ['block', ['result', 'f64'],
    ['f64.store', ['i32.add', ptrOffsetIR(['local.get', `$${objTmp}`], arrVT), ['i32.shl', ['local.get', `$${idxTmp}`], ['i32.const', 3]]], ['local.get', `$${valTmp}`]],
    ['local.get', `$${valTmp}`]]
  const elseBranch = hasTypedSet
    ? ['if', ['result', 'f64'],
        ptrTypeEq(['local.get', `$${objTmp}`], PTR.TYPED),
        ['then', ['call', '$__typed_set_idx', ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]],
        ['else', fallbackStore]]
    : fallbackStore
  return block64(
    ['local.set', `$${objTmp}`, asF64(arrExpr)],
    ['local.set', `$${idxTmp}`, idxI32],
    ['local.set', `$${valTmp}`, valueExpr],
    ['if', ['result', 'f64'],
      ptrTypeEq(['local.get', `$${objTmp}`], PTR.ARRAY),
      ['then', arrayBranch],
      ['else', elseBranch]])
}

/** Element assignment: `arr[idx] = val`. Linear strategy chain — first match wins.
 *  Order matters: literal-key fast paths shadow generic stores; SRoA shadow before
 *  schema; typed-array element write before generic f64.store. */
function emitElementAssign(arr, idx, val) {
  // _expect is clobbered by every sub-emit() — capture statement-position hint
  // up front so the typed-array element-write path can elide the value materialize.
  const void_ = _expect === 'void'
  const keyType = valTypeOf(idx)
  // A provably-numeric index name — an int-certain loop counter or a NUMBER-typed
  // local — can never be a string key, so the runtime `__is_str_key` → `__dyn_set`
  // dispatch is dead. Mirrors the index *read* path (`intIndexIR`), closing the
  // read/write asymmetry on `arr[i] = …` inside refined-array loops.
  const idxNumericName = typeof idx === 'string' &&
    (repOf(idx)?.intCertain === true || repOf(idx)?.val === VAL.NUMBER)
  const useRuntimeKeyDispatch = !idxNumericName &&
    (keyType == null || (typeof idx === 'string' && keyType !== VAL.STRING))
  const keyExpr = asF64(emit(idx))
  const valueExpr = asF64(emit(val))
  // Literal string key, or schema-known object receiver with a static key expression.
  const litKey = isLiteralStr(idx) ? idx[1]
    : typeof arr === 'string' && lookupValType(arr) === VAL.OBJECT ? staticPropertyKey(idx)
    : null

  // 1. SRoA flat object: `o['k'] = x` → `local.set $o#i` (no heap store).
  if (litKey != null && typeof arr === 'string' && ctx.func.flatObjects?.has(arr)) {
    const fo = ctx.func.flatObjects.get(arr)
    const fi = fo.names.indexOf(litKey)
    if (fi >= 0) return withTemp(valueExpr, t => [
      ['local.set', `$${arr}#${fi}`, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]])
  }
  // 2. Schema field literal key → direct payload-slot write.
  if (litKey != null && typeof arr === 'string' && ctx.schema.find) {
    const slot = ctx.schema.find(arr, litKey)
    if (slot >= 0) return withTemp(valueExpr, t => [
      ctx.abi.object.ops.store(ptrOffsetIR(asF64(emit(arr)), lookupValType(arr) || VAL.OBJECT), slot, ['local.get', `$${t}`]),
      ['local.get', `$${t}`]])
  }
  // 3. Known-ARRAY receiver + literal numeric key → __arr_set_idx_ptr.
  const arrIndex = litKey != null ? arrayIndexKey(litKey) : null
  if (arrIndex != null && typeof arr === 'string' && valTypeOf(arr) === VAL.ARRAY)
    return storeArrayPayload(asF64(emit(arr)), typed(['f64.const', arrIndex], 'f64'), valueExpr, persistBinding(arr))

  // 4. Known-STRING key → __dyn_set (after schema/SRoA literal-key paths).
  if (keyType === VAL.STRING) return dynSetCall(arr, keyExpr, valueExpr)

  // 5. Typed-array receiver → __typed_set_idx (or per-ctor element write).
  if (typeof arr === 'string' && ctx.core.emit['.typed:[]='] &&
      lookupValType(arr) === 'typed') {
    const r = ctx.core.emit['.typed:[]=']?.(arr, idx, val, void_)
    if (r) return r
    // Element ctor unknown — runtime aux-byte dispatch. __typed_set_idx
    // returns the stored value as f64, used directly as the expr result.
    inc('__typed_set_idx')
    return typed(['call', '$__typed_set_idx',
      asI64(emit(arr)), asI32(emit(idx)), valueExpr], 'f64')
  }

  // 6. Boxed schema array — payload pointer is stored at the receiver's payload offset.
  if (typeof arr === 'string' && ctx.schema.isBoxed?.(arr)) {
    const inner = ctx.schema.emitInner(arr)
    const arrVT = lookupValType(arr) || VAL.OBJECT
    const storeNumeric = keyNode => storeArrayPayload(inner, keyNode, valueExpr, ptr =>
      ['f64.store', ptrOffsetIR(asF64(emit(arr)), arrVT), ptr])
    if (useRuntimeKeyDispatch) {
      inc('__dyn_set', '__is_str_key')
      return dispatchByKeyKind(arr, keyExpr, valueExpr, storeNumeric)
    }
    return typed(storeNumeric(keyExpr), 'f64')
  }

  // 7. Known-ARRAY receiver, generic key.
  if (typeof arr === 'string' && valTypeOf(arr) === VAL.ARRAY) {
    const persist = persistBinding(arr)
    const arrExpr = asF64(emit(arr))
    if (useRuntimeKeyDispatch) {
      inc('__dyn_set', '__is_str_key')
      return dispatchByKeyKind(arr, keyExpr, valueExpr, keyNode => storeArrayPayload(arrExpr, keyNode, valueExpr, persist))
    }
    return storeArrayPayload(arrExpr, keyExpr, valueExpr, persist)
  }

  const knownArrVT = typeof arr === 'string' ? lookupValType(arr) : null
  const arrVT = knownArrVT || VAL.OBJECT

  // 8. Polymorphic + runtime key dispatch — key kind unknown AND receiver shape
  //    possibly TypedArray (or fully opaque). Numeric branch forks on __ptr_type.
  //    Deliberately a 2-fork (TYPED vs else) rather than reusing
  //    emitPolymorphicElementStore's 3-fork: dynamic-key dispatch only fires when
  //    receiver isn't statically ARRAY (Step 7 already caught that), so the
  //    ARRAY branch would be dead code that bloats every unknown-key write.
  if (useRuntimeKeyDispatch) {
    inc('__dyn_set', '__is_str_key')
    const hasTypedSet = !!ctx.core.stdlib['__typed_set_idx']
    if (knownArrVT == null && hasTypedSet) {
      const objTmp = temp('asu')
      const idxTmp = tempI32('asi')
      const valTmp = temp()
      inc('__ptr_type', '__typed_set_idx')
      // When arr type is unknown (could be TypedArray) and __typed_set_idx is
      // available, dispatch the numeric branch through __ptr_type so TypedArray
      // writes go by element type. Without this, ternary-typed arrays (e.g.
      // `num === 4 ? new Uint32Array(4) : new Uint8Array(16)`) would silently
      // f64.store boxed bytes regardless of element width.
      return dispatchByKeyKind(arr, keyExpr, valueExpr, keyNode => ['block', ['result', 'f64'],
        ['local.set', `$${objTmp}`, asF64(emit(arr))],
        ['local.set', `$${idxTmp}`, asI32(typed(keyNode, 'f64'))],
        ['local.set', `$${valTmp}`, valueExpr],
        ['if', ['result', 'f64'],
          ptrTypeEq(['local.get', `$${objTmp}`], PTR.TYPED),
          ['then', ['call', '$__typed_set_idx', ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]], ['local.get', `$${idxTmp}`], ['local.get', `$${valTmp}`]]],
          ['else', ['block', ['result', 'f64'],
            ['f64.store', ['i32.add', ptrOffsetIR(['local.get', `$${objTmp}`], arrVT), ['i32.shl', ['local.get', `$${idxTmp}`], ['i32.const', 3]]], ['local.get', `$${valTmp}`]],
            ['local.get', `$${valTmp}`]]]]])
    }
    const valTmp = temp()
    return dispatchByKeyKind(arr, keyExpr, valueExpr, keyNode => ['block', ['result', 'f64'],
      ['local.set', `$${valTmp}`, valueExpr],
      ['f64.store', ['i32.add', ptrOffsetIR(asF64(emit(arr)), arrVT), ['i32.shl', asI32(typed(keyNode, 'f64')), ['i32.const', 3]]], ['local.get', `$${valTmp}`]],
      ['local.get', `$${valTmp}`]])
  }

  // 9. Opaque receiver (non-string expr) or string-named with unknown VT — pure
  //    __ptr_type dispatch (no key-kind fork: key is provably numeric here).
  if (typeof arr !== 'string')
    return emitPolymorphicElementStore(emit(arr), asI32(emit(idx)), valueExpr, arrVT, null)
  if (knownArrVT == null)
    return emitPolymorphicElementStore(emit(arr), asI32(emit(idx)), valueExpr, arrVT, persistBinding(arr))

  // Default: known-VT receiver that isn't ARRAY/TYPED/OBJECT special — raw f64.store.
  return withTemp(valueExpr, t => [
    ['f64.store', ['i32.add', ptrOffsetIR(asF64(emit(arr)), arrVT), ['i32.shl', asI32(emit(idx)), ['i32.const', 3]]], ['local.get', `$${t}`]],
    ['local.get', `$${t}`]])
}

/** Property assignment: `obj.prop = val`. Strategies (first match wins):
 *    - `arr.length = N` resize (ARRAY or unknown receiver)
 *    - SRoA flat-object property
 *    - Schema-known field (with dyn shadow if needed)
 *    - OBJECT / dyn-props receiver → __dyn_set
 *    - Hoisted-but-not-declared binding (treat as dyn)
 *    - Non-string receiver expr → __dyn_set
 *    Default: __hash_set on a string-named receiver. */
function emitPropertyAssign(obj, prop, val) {
  // arr.length = N — array resize. Intercept before the schema/object paths
  // (`length` is never a schema field). Only ARRAY (or unknown — the runtime
  // helper guards non-arrays) receivers resize; known OBJECT/Map/etc. keep
  // `.length =` as a plain property write below. The expression value is N.
  if (prop === 'length') {
    const recvVt = valTypeOf(obj)
    if (recvVt === VAL.ARRAY || recvVt == null) {
      inc('__arr_set_length')
      const arrTmp = `${T}aln${ctx.func.uniq++}`
      const nTmp = `${T}alv${ctx.func.uniq++}`
      ctx.func.locals.set(arrTmp, 'f64')
      ctx.func.locals.set(nTmp, 'i32')
      // Write the relocated pointer back to a simple var receiver so later
      // reads skip the forwarding hop; complex receivers stay correct via it.
      const persist = recvVt === VAL.ARRAY && typeof obj === 'string'
        ? persistBindingPtr(obj, ['local.get', `$${arrTmp}`])
        : null
      const body = [
        ['local.set', `$${arrTmp}`, asF64(emit(obj))],
        ['local.set', `$${nTmp}`, asI32(emit(val))],
        ['local.set', `$${arrTmp}`, ['call', '$__arr_set_length', ['i64.reinterpret_f64', ['local.get', `$${arrTmp}`]], ['local.get', `$${nTmp}`]]],
      ]
      if (persist) body.push(persist)
      body.push(['f64.convert_i32_s', ['local.get', `$${nTmp}`]])
      return block64(...body)
    }
  }
  // SRoA flat object: `o.prop = x` → `local.set $o#i` (no heap store).
  const flatW = typeof obj === 'string' ? ctx.func.flatObjects?.get(obj) : null
  if (flatW) {
    const fi = flatW.names.indexOf(prop)
    if (fi >= 0) return withTemp(asF64(emit(val)), t => [
      ['local.set', `$${obj}#${fi}`, ['local.get', `$${t}`]],
      ['local.get', `$${t}`]])
  }
  // Schema-based object → f64.store at fixed offset.
  if (typeof obj === 'string' && ctx.schema.find) {
    const idx = ctx.schema.find(obj, prop)
    if (idx >= 0) {
      const va = emit(obj), vv = asF64(emit(val)), t = temp()
      const shadow = needsDynShadow(obj)
      if (shadow) inc('__dyn_set')
      const stmts = [
        ['local.set', `$${t}`, vv],
        ctx.abi.object.ops.store(ptrOffsetIR(asF64(va), lookupValType(obj) || VAL.OBJECT), idx, ['local.get', `$${t}`]),
      ]
      if (shadow)
        stmts.push(['drop', ['call', '$__dyn_set', asI64(va), asI64(emit(['str', prop])), ['i64.reinterpret_f64', ['local.get', `$${t}`]]]])
      stmts.push(['local.get', `$${t}`])
      return block64(...stmts)
    }
  }
  if (typeof obj === 'string') {
    const objType = valTypeOf(obj)
    // OBJECT receivers (incl. JSON.parse-derived bindings) with off-schema
    // properties go through __dyn_set, which writes to the per-OBJECT
    // propsPtr at off-16 — same path as object-literal dyn shadow writes
    // (module/object.js). __hash_set assumes HASH bucket layout and would
    // corrupt OBJECT memory.
    if (usesDynProps(objType) || objType === VAL.OBJECT) {
      inc('__dyn_set')
      return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(obj)), asI64(emit(['str', prop])), asI64(emit(val))]], 'f64')
    }
    if (ctx.func.names.has(obj) && !isBoundName(obj)) {
      inc('__dyn_set')
      return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(obj)), asI64(emit(['str', prop])), asI64(emit(val))]], 'f64')
    }
    if (objType == null && ctx.transform.host !== 'wasi') {
      ctx.features.external = true
    }
    inc('__hash_set')
    const setCall = typed(['f64.reinterpret_i64', ['call', '$__hash_set', asI64(emit(obj)), asI64(emit(['str', prop])), asI64(emit(val))]], 'f64')
    if (isGlobal(obj)) return block64(
      ['global.set', `$${obj}`, setCall], ['global.get', `$${obj}`])
    // Closure-captured (boxed) locals store the value at the cell address — local.tee
    // would write to the i32 cell pointer, not the f64 value. Route through writeVar.
    if (ctx.func.boxed?.has(obj)) return writeVar(obj, setCall, false)
    return typed(['local.tee', `$${obj}`, setCall], 'f64')
  }
  if (ctx.transform.host !== 'wasi') ctx.features.external = true
  inc('__dyn_set')
  return typed(['f64.reinterpret_i64', ['call', '$__dyn_set', asI64(emit(obj)), asI64(emit(['str', prop])), asI64(emit(val))]], 'f64')
}

// === Call IR helpers ===

/** Split a flat argList into normal positional args + spread positions. */
function parseCallArgs(args) {
  const normal = []
  const spreads = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (Array.isArray(arg) && arg[0] === '...') {
      spreads.push({ pos: normal.length, expr: arg[1] })
    } else {
      normal.push(arg)
    }
  }
  return { normal, spreads, hasSpread: spreads.length > 0 }
}

/** Bulk `obj.push(...src)` fast path — single trailing spread, no normal args, named
 *  receiver. Amortizes the per-element grow + set_len of the generic loop into one
 *  __arr_grow / __set_len pair, then bulk-copies the source via emitSpreadCopy.
 *  Hot path in watr's `out.push(...HANDLER[op](...))` (~24M bytes/iter on raycast). */
function emitBulkPushSpread(objArg, parsed) {
  const spreadExpr = parsed.spreads[0].expr
  inc('__len'); inc('__arr_grow'); inc('__set_len'); inc('__ptr_offset')
  const o = `${T}po${ctx.func.uniq++}`,
        sa = `${T}psa${ctx.func.uniq++}`,
        sl = `${T}psl${ctx.func.uniq++}`,
        ol = `${T}pol${ctx.func.uniq++}`,
        si = `${T}psi${ctx.func.uniq++}`,
        base = `${T}pb${ctx.func.uniq++}`
  ctx.func.locals.set(o, 'f64'); ctx.func.locals.set(sa, 'f64')
  ctx.func.locals.set(sl, 'i32'); ctx.func.locals.set(ol, 'i32')
  ctx.func.locals.set(si, 'i32'); ctx.func.locals.set(base, 'i32')

  const objIsArr = lookupValType(objArg) === VAL.ARRAY
  const n = multiCount(spreadExpr)
  // Normalize a (non-multi) spread source to an index-iterable: Set→keys /
  // Map→[k,v] arrays, others pass through. Only when `collection` is loaded.
  const srcExpr = !n && ctx.module.modules.collection ? ['()', '__iter_arr', spreadExpr] : spreadExpr
  // A materialized multi-value is not a statically-typed pointer — let
  // emitSpreadCopy resolve its kind once at runtime.
  const srcVT = n ? undefined : valTypeOf(srcExpr)
  const ir = []
  ir.push(['local.set', `$${o}`, asF64(emit(objArg))])
  ir.push(['local.set', `$${sa}`, n ? materializeMulti(spreadExpr) : asF64(emit(srcExpr))])
  ir.push(['local.set', `$${sl}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${sa}`]]]])
  // Old length: inline as `i32.load (off-8)` if obj is known ARRAY (matches .push handler).
  if (objIsArr) {
    ir.push(['local.set', `$${ol}`,
      ['i32.load', ['i32.sub', ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${o}`]]], ['i32.const', 8]]]])
  } else {
    ir.push(['local.set', `$${ol}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${o}`]]]])
  }
  // Single grow for the full spread (vs per-element grow check in the generic loop).
  ir.push(['local.set', `$${o}`, ['call', '$__arr_grow', ['i64.reinterpret_f64', ['local.get', `$${o}`]],
    ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${sl}`]]]])
  // base captured AFTER grow (grow may relocate the array).
  ir.push(['local.set', `$${base}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${o}`]]]])
  // Bulk-copy the spread: an ARRAY source is a contiguous f64 block → memory.copy.
  ir.push(['local.set', `$${si}`, ['local.get', `$${ol}`]])
  ir.push(...emitSpreadCopy(base, si, sa, sl, srcVT))
  // Single set_len for the full spread.
  ir.push(['call', '$__set_len', ['i64.reinterpret_f64', ['local.get', `$${o}`]],
    ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${sl}`]]])
  // Update source variable: grow may have moved the pointer.
  ir.push(persistBindingPtr(objArg, ['local.get', `$${o}`]))
  ir.push(['f64.convert_i32_s', ['i32.add', ['local.get', `$${ol}`], ['local.get', `$${sl}`]]])
  return block64(...ir)
}

/** Single trailing spread, with optional preceding normal args. Calls methodEmitter
 *  once for the normal args (if any), then loops methodEmitter over each spread
 *  element. `unshift` walks the spread end-to-start so prepend order matches JS. */
/** Emit a per-element loop over `spreadExpr`: allocate arr/len/idx locals, seed
 *  the arr rep when the spread VT is known, run `bodyFn(arr, idx, len)` once per
 *  element. When `reverse` is set, walks the spread from end to start (used by
 *  `unshift` to preserve argument order under successive prepends). Returns the
 *  IR instruction list (caller embeds it into its own block64). */
function emitSpreadElementLoop(spreadExpr, bodyFn, { reverse = false } = {}) {
  const arr = `${T}sp${ctx.func.uniq++}`
  const len = `${T}splen${ctx.func.uniq++}`
  const idx = `${T}spidx${ctx.func.uniq++}`
  ctx.func.locals.set(arr, 'f64'); ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(idx, 'i32')
  // Emit-time rep seeding for a fresh spread-staging local (no prior reader).
  // Without this, the loop body's `[]` read on `arr` falls back to polymorphic
  // dispatch — VAL.* on the rep elides STRING gate for ARRAY/TYPED spreads.
  const spreadVT = valTypeOf(spreadExpr)
  if (spreadVT) updateRep(arr, { val: spreadVT })
  inc('__len')
  const n = multiCount(spreadExpr)
  const loopId = ctx.func.uniq++
  const exhausted = reverse
    ? ['i32.lt_s', ['local.get', `$${idx}`], ['i32.const', 0]]
    : ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]
  return [
    ['local.set', `$${arr}`, n ? materializeMulti(spreadExpr) : asF64(emit(spreadExpr))],
    ['local.set', `$${len}`, ['call', '$__len', ['i64.reinterpret_f64', ['local.get', `$${arr}`]]]],
    ['local.set', `$${idx}`, reverse ? ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]] : ['i32.const', 0]],
    ['block', `$break${loopId}`,
      ['loop', `$continue${loopId}`,
        ['br_if', `$break${loopId}`, exhausted],
        ...bodyFn(arr, idx, len),
        ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['i32.const', reverse ? -1 : 1]]],
        ['br', `$continue${loopId}`]]],
  ]
}

function emitSingleSpreadMethodCall(objArg, parsed, method, methodEmitter) {
  const inPlace = SPREAD_MUTATORS.has(method)
  // unshift prepends each arg to the front — forward iteration reverses intent.
  const reverse = method === 'unshift'
  const acc = `${T}acc${ctx.func.uniq++}`
  ctx.func.locals.set(acc, 'f64')
  const ir = [['local.set', `$${acc}`, asF64(emit(objArg))]]
  if (parsed.normal.length > 0) {
    const r = asF64(methodEmitter(objArg, ...parsed.normal))
    ir.push(inPlace ? ['drop', r] : ['local.set', `$${acc}`, r])
  }
  ir.push(...emitSpreadElementLoop(parsed.spreads[0].expr, (arr, idx) => {
    const body = asF64(methodEmitter(inPlace ? objArg : acc, ['[]', arr, idx]))
    return [inPlace ? ['drop', body] : ['local.set', `$${acc}`, body]]
  }, { reverse }))
  ir.push(inPlace ? asF64(emit(objArg)) : ['local.get', `$${acc}`])
  return block64(...ir)
}

/** General spread mix: iterate combined args in original order, batch contiguous
 *  normal args into a single methodEmitter call, emit a per-element loop for each
 *  spread. For in-place methods chains via `objArg` (source variable); otherwise
 *  threads through an accumulator local. */
function emitMultiSpreadMethodCall(objArg, parsed, method, methodEmitter) {
  const inPlace = SPREAD_MUTATORS.has(method)
  const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
  // Accumulator (only used when not in-place); recv passed to methodEmitter is the live target.
  const acc = inPlace ? null : `${T}acc${ctx.func.uniq++}`
  if (acc) ctx.func.locals.set(acc, 'f64')
  const recv = inPlace ? objArg : acc
  const ir = inPlace ? [] : [['local.set', `$${acc}`, asF64(emit(objArg))]]
  let batch = []
  const flushBatch = () => {
    if (!batch.length) return
    const r = asF64(methodEmitter(recv, ...batch))
    ir.push(inPlace ? ['drop', r] : ['local.set', `$${acc}`, r])
    batch = []
  }
  for (const item of combined) {
    if (Array.isArray(item) && item[0] === '__spread') {
      flushBatch()
      ir.push(...emitSpreadElementLoop(item[1], (arr, idx) => {
        const body = asF64(methodEmitter(recv, ['[]', arr, idx]))
        return [inPlace ? ['drop', body] : ['local.set', `$${acc}`, body]]
      }))
    } else {
      batch.push(item)
    }
  }
  flushBatch()
  ir.push(inPlace ? asF64(emit(objArg)) : ['local.get', `$${acc}`])
  return block64(...ir)
}

/** Method-emitter call: directly, or via one of the spread fast paths. */
function emitMethodCallSpread(objArg, methodEmitter, parsed, method) {
  if (!parsed.hasSpread) return methodEmitter(objArg, ...parsed.normal)
  if (method === 'push' && parsed.normal.length === 0 &&
      parsed.spreads.length === 1 && typeof objArg === 'string')
    return emitBulkPushSpread(objArg, parsed)
  if (parsed.spreads.length === 1 && parsed.spreads[0].pos === parsed.normal.length)
    return emitSingleSpreadMethodCall(objArg, parsed, method, methodEmitter)
  return emitMultiSpreadMethodCall(objArg, parsed, method, methodEmitter)
}

/** Hoist `headExpr` into a temp, evaluate it once, and yield `body(t)` when the
 *  temp is non-nullish, else `undefined`. Shared by every `?.`-shaped optional
 *  emitter (chain-lift, `?.`, `?.[]`, `?.()` via `evalOnce` + this helper) so
 *  the nullish-guard scaffold stays in one place. */
function withNullGuard(headExpr, body, tag = 'ng') {
  const t = temp(tag)
  return block64(
    ['local.set', `$${t}`, headExpr],
    ['if', ['result', 'f64'],
      ['i32.eqz', isNullish(['local.get', `$${t}`])],
      ['then', body(t)],
      ['else', undefExpr()]])
}

// Leading method-call strategies (chain positions 1–4). Each is *context-free* —
// it depends only on the parsed call, not on the receiver-type analysis (`vt` /
// `callMethod`) that emitMethodCall computes below — so they factor out into an
// ordered, first-match-wins table. A strategy returns its IR, or `undefined` to
// fall through to the next. (Positions 5–12 thread shared mid-function state and
// stay inline.) New context-free strategies just push onto LEADING_STRATEGIES.

// 1. SRoA flat object: `o.method(args)` — scanFlatObjects dissolved `o` into
// `o#i` field locals and deleted `$o`, so the method closure lives in the field
// local, not a heap slot. Read it directly and dispatch. Without this, every
// path below loads from `local.get $o`, which no longer exists (watr then reports
// "Unknown local $o"). Mirrors the flat `.`/`[]` hooks.
function tryFlatObjectMethod(callee, obj, method, parsed) {
  if (typeof obj === 'string' && ctx.closure.call) {
    const flat = ctx.func.flatObjects?.get(obj)
    const fi = flat ? flat.names.indexOf(method) : -1
    if (fi >= 0) {
      const propRead = typed(['local.get', `$${obj}#${fi}`], 'f64')
      if (parsed.hasSpread)
        return ctx.closure.call(propRead, [buildArrayWithSpreads(reconstructArgsWithSpreads(parsed.normal, parsed.spreads))], true)
      return ctx.closure.call(propRead, parsed.normal)
    }
  }
}

// 2. charCodeAt with a statically in-bounds index — emit the i32 (OOB-impossible)
// contract directly; the generic path keeps the f64/NaN JS-spec result. See
// analyze.js inBoundsCharCodeAt.
function tryCharCodeAtFast(callee, obj, method, parsed) {
  if (method === 'charCodeAt' && !parsed.hasSpread && parsed.normal.length === 1
      && stringOps(obj)?.charCodeAt && inBoundsCharCodeAt(ctx).has(callee)) {
    const recv = emit(obj)
    // jsstring carrier: receiver is an externref boundary param. Route to
    // `wasm:js-string.charCodeAt` directly — the in-bounds proof rules out the
    // OOB trap the builtin would otherwise raise.
    if (recv?.type === 'externref') {
      ctx.core.jsstring.add('charCodeAt')
      return typed(['call', '$__jss_charCodeAt', recv, asI32(emit(parsed.normal[0]))], 'i32')
    }
    return typed(stringOps(obj).charCodeAt(
      asF64(recv), asI32(emit(parsed.normal[0])), ctx, false), 'i32')
  }
}

// 3. splice(start, deleteCount, ...items): the one array method that both deletes
// and inserts. callMethod's spread machinery models per-element mutators
// (push/concat), not a single delete+insert, so a spread of inserts would be
// misapplied. Handle the full arg list here: delete-only (no inserts) falls
// through to the inline `.splice` emitter; any insert items route through
// __arr_splice, which grows/shifts in place (the caller's pointer stays valid via
// array forwarding) and returns the removed elements. Guard against a spread in
// the start/deleteCount slots (`splice(...x)`) — that form has no static arity.
function trySpliceInsert(callee, obj, method, parsed) {
  if (method === 'splice' && ctx.core.emit['.splice']) {
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const inserts = combined.slice(2)
    const headSpread = combined[0]?.[0] === '__spread' || combined[1]?.[0] === '__spread'
    if (inserts.length && !headSpread) {
      inc('__arr_splice')
      return typed(['call', '$__arr_splice',
        asI64(emit(obj)),
        asI32(emit(combined[0])),
        asI32(emit(combined[1])),
        asI64(buildArrayWithSpreads(inserts))], 'f64')
    }
  }
}

// 4. Function property call: fn.prop(args) → direct call to fn$prop. Skipped when
// the property was reassigned (wrapper composition) — then it is a mutable slot
// and must be read dynamically before the call.
function tryFnPropCall(callee, obj, method, parsed) {
  if (typeof obj === 'string' && ctx.func.names.has(obj) && !ctx.func.multiProp.has(`${obj}.${method}`)) {
    const fname = `${obj}$${method}`
    if (ctx.func.names.has(fname)) {
      const func = ctx.func.map.get(fname)
      const emittedArgs = emitCallArgs(parsed.normal, func.sig.params)
      return attachSigMeta(typed(['call', `$${fname}`, ...emittedArgs], func.sig.results[0]), func.sig)
    }
  }
}

const LEADING_STRATEGIES = [tryFlatObjectMethod, tryCharCodeAtFast, trySpliceInsert, tryFnPropCall]

/** Method-call dispatch: `obj.method(args)`. Linear strategy chain. Strategies
 *  (first match wins):
 *    1. SRoA flat-object method (read closure from `o#i` local)
 *    2. charCodeAt with statically-proven in-bounds index → i32 fast path
 *    3. splice with insert items → __arr_splice (the one method that delete+insert)
 *    4. fn.prop direct call to fn$prop (skipped for reassigned wrapper-composition)
 *    5. Boxed-schema receiver → delegate to inner value at slot 0 (+ writeback)
 *    6. valueOf / toString — sidecar own-property shadow check
 *    7. Known-type static dispatch via .${vt}:${method}
 *    8. Unknown / guessed-ARRAY runtime ptr-type fork over string vs generic
 *    9. Schema property closure call
 *    10. Generic emitter (with collection/strIndex arity guards + object shadow)
 *    11. Dynamic property closure call (with PTR.EXTERNAL fallback if non-wasi)
 *    12. External method fallback via __ext_call (or undefined under wasi)
 */
function emitMethodCall(callee, parsed, callArgs) {
  const [, obj, method] = callee

  // Strategies 1–4 (context-free, order-sensitive, first match wins).
  for (const strategy of LEADING_STRATEGIES) {
    const r = strategy(callee, obj, method, parsed)
    if (r !== undefined) return r
  }

  let vt = valTypeOf(obj)
  // A reassigned slice/concat receiver may carry a stale `vt` — a reassignment
  // inside a nested closure escapes analyzeValTypes' poisoning (its walk stops
  // at `=>`). Drop to runtime dispatch, but only for guessy types: STRING/ARRAY
  // dispatch correctly either way, and BUFFER/TYPED are construction proofs
  // (`new ArrayBuffer`/`new XxxArray`) — the runtime String/Array fallback has
  // no branch for them, so nulling `vt` would miscompile `ab.slice()` into an
  // f64-array copy. jzify also splits every `var x = init` into `let x; x = init`,
  // marking single-assignment vars "reassigned"; keeping definite BUFFER/TYPED
  // is what keeps `var`-declared buffers correct.
  if (typeof obj === 'string' && isReassigned(ctx.func.body, obj)
    && (method === 'slice' || method === 'concat')
    && vt !== VAL.STRING && vt !== VAL.ARRAY
    && vt !== VAL.BUFFER && vt !== VAL.TYPED) vt = null

  // Method-emitter shim — threads parsed/method through the shared dispatcher so
  // call sites (boxed-object delegation, sidecar valueOf/toString, etc.) keep the
  // simple `callMethod(receiver, emitter)` shape.
  const callMethod = (objArg, methodEmitter) => emitMethodCallSpread(objArg, methodEmitter, parsed, method)

  // Boxed object: delegate method to inner value (slot 0)
  if (typeof obj === 'string' && ctx.schema.isBoxed?.(obj)) {
    const innerVt = repOf(obj)?.val
    const innerEmitter = ctx.core.emit[`.${innerVt}:${method}`] || ctx.core.emit[`.${method}`]
    if (innerEmitter) {
      const innerName = `${obj}${T}inner`
      if (!ctx.func.locals.has(innerName)) ctx.func.locals.set(innerName, 'f64')
      const boxBase = tempI32('bb')
      // Load current inner value from boxed object's slot 0 (may have been updated by prior mutations)
      // Boxed handle is OBJECT-kind, never ARRAY — skip forwarding.
      const loadInner = [
        ['local.set', `$${boxBase}`, ptrOffsetIR(asF64(emit(obj)), lookupValType(obj) || VAL.OBJECT)],
        ['local.set', `$${innerName}`, ctx.abi.object.ops.load(['local.get', `$${boxBase}`], 0)]]
      const result = callMethod(innerName, innerEmitter)
      // Mutating methods may reallocate; writeback inner value to boxed slot
      if (BOXED_MUTATORS.has(method)) {
        const wb = ctx.abi.object.ops.store(['local.get', `$${boxBase}`], 0, ['local.get', `$${innerName}`])
        return block64(...loadInner, asF64(result), wb)
      }
      // Non-mutating: just load inner and call
      return block64(...loadInner, asF64(result))
    }
  }

  // valueOf/toString are ToPrimitive hooks (ES2024 7.1.1) that an own data
  // property shadows. An assigned `obj.valueOf`/`obj.toString` must win over
  // the builtin emitter for any receiver that can carry a dynamic-prop
  // sidecar — a sidecar-bearing static type (array/typed/object) OR a
  // statically-unknown receiver (e.g. an array-element read `arr[0]`, whose
  // type is only known at runtime). Probe the sidecar and call it when it
  // holds a closure, else fall back to the builtin (generic when untyped:
  // `.valueOf` returns the receiver, `.toString` runs type-aware __to_str).
  // Parallels the member-READ check in module/core.js emitPropAccess (which
  // stays scoped to known sidecar types). (watr's `str()` attaches
  // `bytes.valueOf = () => s`, recovered via `.valueOf()`.)
  if ((method === 'valueOf' || method === 'toString') && ctx.closure.call
      && !parsed.hasSpread && parsed.normal.length === 0
      && (vt === VAL.ARRAY || vt === VAL.TYPED || vt === VAL.OBJECT || !vt)) {
    const builtin = (vt && ctx.core.emit[`.${vt}:${method}`]) || ctx.core.emit[`.${method}`]
    if (builtin) {
      return sidecarOverride(emit(obj), asI64(emit(['str', method])),
        (p) => ctx.closure.call(typed(['local.get', `$${p}`], 'f64'), []),  // CALL the override
        (o) => asF64(callMethod(o, builtin)))                                // else the builtin method
    }
  }

  // Known type → static dispatch
  if (vt && ctx.core.emit[`.${vt}:${method}`]) {
    return callMethod(obj, ctx.core.emit[`.${vt}:${method}`])
  }

  // Unknown / guessed-array type, both string + generic exist → runtime dispatch by ptr type.
  // analyze.js defaults untyped `.slice()` results to VAL.ARRAY, which is a guess, not a proof;
  // runtime dispatch resolves whether the operand is actually a string or an array.
  // Concretely-typed non-string values (BUFFER, TYPED, MAP, …) fall through to the generic
  // emitter which already knows how to handle them.
  const strKey = `.string:${method}`, genKey = `.${method}`
  if ((!vt || vt === VAL.ARRAY) && ctx.core.emit[strKey] && ctx.core.emit[genKey]) {
    const t = `${T}rt${ctx.func.uniq++}`, tt = `${T}rtt${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(tt, 'i32')
    const strEmitter = ctx.core.emit[strKey]
    const genEmitter = ctx.core.emit[genKey]
    return block64(
      ['local.set', `$${t}`, asF64(emit(obj))],
      ['local.set', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
      ['if', ['result', 'f64'],
        ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.STRING]],
        ['then', callMethod(t, strEmitter)],
        ['else', callMethod(t, genEmitter)]])
  }

  // Schema property closure call: `x.prop(args)` where prop is a closure slot in
  // x's schema. Boxed schemas don't currently support spread callers (each box
  // hands the inner value through), so spread is restricted to the non-boxed path.
  if (typeof obj === 'string' && ctx.schema.find && ctx.closure.call) {
    const idx = ctx.schema.find(obj, method)
    if (idx >= 0) {
      const propRead = typed(ctx.abi.object.ops.load(ptrOffsetIR(asF64(emit(obj)), lookupValType(obj) || VAL.OBJECT), idx), 'f64')
      if (parsed.hasSpread && !ctx.schema.isBoxed?.(obj)) {
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        return ctx.closure.call(propRead, [buildArrayWithSpreads(combined)], true)
      }
      return ctx.closure.call(propRead, parsed.normal)
    }
  }

  // Generic only — but a collection emitter (`.get`/`.set`/`.has`/`.add`/
  // `.delete`) assumes a Map/Set receiver: a proven collection already
  // dispatched via `.${vt}:${method}` above, so reaching here means the
  // receiver is not a proven collection. A zero-arg call then cannot be the
  // collection op (each needs ≥1 key/value arg) — it is a user/closure
  // method (e.g. `new C().get()`). Skip the collection emitter so it falls
  // through to closure/dynamic dispatch instead of crashing on `emit(key)`.
  const collectionMisfit = COLLECTION_METHODS.has(method) &&
    !parsed.hasSpread && parsed.normal.length === 0
  const strIndexMisfit = STR_INDEX_METHODS.has(method) &&
    !parsed.hasSpread && parsed.normal.length > 1
  // A proven plain-object/dict receiver never inherits the Array/collection
  // builtins these generic emitters serve — an own property of the same name
  // shadows them (ES prototype semantics). Skip the builtin so the dynamic
  // property-call dispatch below reads the actual slot/sidecar closure. This
  // is the type-based generalization of the collection/strIndex arity guards
  // above: it is what lets self-host user methods whose names collide with
  // builtins — `ctx.schema.find(o,p)`, `node.map(...)`, `s.get(k)` — dispatch
  // correctly instead of being hijacked by `Array.prototype.{find,map,…}`.
  const objectShadow = vt === VAL.OBJECT || vt === VAL.HASH
  if (ctx.core.emit[genKey] && !collectionMisfit && !strIndexMisfit && !objectShadow) {
    return callMethod(obj, ctx.core.emit[genKey])
  }

  // Dynamic property function call on non-external values. Two emission shapes:
  // (1) closure-only fork — receiver carries no PTR.EXTERNAL (sidecar-bearing static
  //     types OR wasi target, where __ext_call doesn't exist); and (2) full fork
  //     adding a PTR.EXTERNAL → __ext_call leg for opaque js receivers.
  if (ctx.closure.call) {
    if (ctx.transform.strict)
      err(`strict mode: method call \`${typeof obj === 'string' ? obj : '<expr>'}.${method}(...)\` on a value of unknown type pulls dynamic dispatch stdlib. Annotate the receiver type or pass { strict: false }.`)
    const objTmp = temp('mobj')
    const propTmp = temp('mprop')
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const arrayIR = buildArrayWithSpreads(combined)
    const propRead = typed(['f64.reinterpret_i64', ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]], asI64(emit(['str', method]))]], 'f64')
    const closureOnly = usesDynProps(vt) || ctx.transform.host === 'wasi'
    inc('__dyn_get_expr', '__ptr_type')
    if (!closureOnly) { inc('__ext_call'); ctx.features.external = true }
    const extFallback = closureOnly ? undefExpr()
      : ['if', ['result', 'f64'],
          ptrTypeEq(['local.get', `$${objTmp}`], PTR.EXTERNAL),
          ['then', ['f64.reinterpret_i64', ['call', '$__ext_call',
            ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]],
            ['i64.reinterpret_f64', asF64(emit(['str', method]))],
            ['i64.reinterpret_f64', arrayIR]]]],
          ['else', undefExpr()]]
    return block64(
      ['local.set', `$${objTmp}`, asF64(emit(obj))],
      ['local.set', `$${propTmp}`, propRead],
      ['if', ['result', 'f64'],
        ptrTypeEq(['local.get', `$${propTmp}`], PTR.CLOSURE),
        ['then', ctx.closure.call(typed(['local.get', `$${propTmp}`], 'f64'), [arrayIR], true)],
        ['else', extFallback]])
  }

  // Unknown callee — assume external method.
  if (ctx.transform.strict)
    err(`strict mode: method call \`${typeof obj === 'string' ? obj : '<expr>'}.${method}(...)\` on a value of unknown type falls through to host \`__ext_call\`. Annotate the receiver type or pass { strict: false }.`)
  // Under wasi there is no host `__ext_call` — the call lowers to a
  // no-op returning `undefined`. This is by-design so polymorphic code
  // can target js and wasi from one source; users who want fail-fast
  // pass `strict: true` (handled above).
  if (ctx.transform.host === 'wasi') return undefExpr()
  inc('__ext_call')
  ctx.features.external = true
  const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
  const arrayIR = buildArrayWithSpreads(combined)
  return typed(['f64.reinterpret_i64', ['call', '$__ext_call',
    ['i64.reinterpret_f64', asF64(emit(obj))],
    ['i64.reinterpret_f64', asF64(emit(['str', method]))],
    ['i64.reinterpret_f64', arrayIR]]], 'f64')
}

/** Builtin / module-emitter call: `Math.max(...)`, `JSON.parse(...)`, etc. The
 *  emitter accepts the same `...args` flat shape as the AST (with `['...', x]`
 *  spread markers re-inserted in original position). */
function emitBuiltinCall(callee, parsed) {
  if (parsed.hasSpread) {
    const allArgs = []
    let ni = 0
    for (const s of parsed.spreads) {
      while (ni < s.pos) allArgs.push(parsed.normal[ni++])
      allArgs.push(['...', s.expr])
    }
    while (ni < parsed.normal.length) allArgs.push(parsed.normal[ni++])
    return ctx.core.emit[callee](...allArgs)
  }
  return ctx.core.emit[callee](...parsed.normal)
}

/** Direct call to a known top-level user function — emits `(call $callee args)`.
 *  Handles rest params (collect into trailing array), in-spread fixed params
 *  (runtime split), default-param padding, multi-value return materialization. */
function emitDirectFunctionCall(callee, parsed, callArgs) {
  const func = ctx.func.map.get(callee)

  // Rest param case: collect all args (including expanded spreads) into array
  if (func?.rest) {
    const fixedParamCount = func.sig.params.length - 1
    // A spread positioned within the fixed-param range supplies fixed params from
    // inside the spread — they can't be sliced out statically. Build the full args
    // array A and split it at runtime: fixed[k] = A[k], rest = A.slice(fixedParamCount).
    // (Otherwise the static slice below is exact and skips the extra alloc + copy.)
    if (fixedParamCount > 0 && parsed.spreads.some(s => s.pos < fixedParamCount)) {
      const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
      const aVal = temp('ra'), aOff = tempI32('rao'), aLen = tempI32('ral'), rLen = tempI32('rln')
      const rest = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${rLen}`], tag: 'rr' })
      const fixedLoads = []
      for (let k = 0; k < fixedParamCount; k++) {
        const load = typed(['if', ['result', 'f64'],
          ['i32.gt_s', ['local.get', `$${aLen}`], ['i32.const', k]],
          ['then', ['f64.load', ['i32.add', ['local.get', `$${aOff}`], ['i32.const', k * 8]]]],
          ['else', undefExpr()]], 'f64')
        fixedLoads.push(coerceArg(load, func.sig.params[k]))
      }
      const callIR = typed(['block', ['result', func.sig.results[0]],
        ['local.set', `$${aVal}`, asF64(buildArrayWithSpreads(combined))],
        ['local.set', `$${aOff}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${aVal}`]]]],
        ['local.set', `$${aLen}`, ['i32.load', ['i32.sub', ['local.get', `$${aOff}`], ['i32.const', 8]]]],
        ['local.set', `$${rLen}`, ['select',
          ['i32.sub', ['local.get', `$${aLen}`], ['i32.const', fixedParamCount]],
          ['i32.const', 0],
          ['i32.gt_s', ['local.get', `$${aLen}`], ['i32.const', fixedParamCount]]]],
        rest.init,
        ['memory.copy', ['local.get', `$${rest.local}`],
          ['i32.add', ['local.get', `$${aOff}`], ['i32.const', fixedParamCount * 8]],
          ['i32.shl', ['local.get', `$${rLen}`], ['i32.const', 3]]],
        ['call', `$${callee}`, ...fixedLoads, rest.ptr]], func.sig.results[0])
      return attachSigMeta(callIR, func.sig)
    }
    // Pad missing fixed args with `undefined` so default-param init triggers per spec.
    const fixedParams = func.sig.params.slice(0, fixedParamCount)
    const emittedFixed = emitCallArgs(parsed.normal.slice(0, fixedParamCount), fixedParams)

    // Reconstruct with spreads, then take rest args
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const restArgsFinal = combined.slice(fixedParamCount)

    // Build array: emit code for normal args + code to expand spreads
    const arrayIR = buildArrayWithSpreads(restArgsFinal)
    return attachSigMeta(typed(['call', `$${callee}`, ...emittedFixed, arrayIR], func.sig.results[0]), func.sig)
  }

  // Regular function call without rest params
  if (parsed.hasSpread) err(`Spread not supported in calls to non-variadic function ${callee}`)
  // Pad missing args with `undefined` so default-param init triggers per spec
  // (only undefined, not null, should trigger defaults). Drop extras to match
  // JS calling convention — emitting them anyway produces an invalid call
  // when the callee is a fixed-arity import (e.g. `_interp`-registered host
  // stubs) since wasm validates arg count. Use ?? rather than || so a
  // legitimate 0-arity callee isn't bypassed.
  const params = func?.sig.params ?? []
  const args = func ? emitCallArgs(parsed.normal, params)
                    : parsed.normal.map(a => coerceArg(emit(a), undefined))
  if (func && args.length > params.length) args.length = params.length
  // Multi-value return: materialize as heap array (caller expects single pointer).
  // Reuse the canonical comma-wrapped arg slot — materializeMulti re-reads args
  // via commaList(node[2]); a spread-form `[…, ...parsed.normal]` would drop every
  // argument past the first.
  if (func?.sig.results.length > 1) return materializeMulti(['()', callee, callArgs])
  // attachSigMeta also handles the unsigned-uint32 flag (every tail was `>>>`),
  // so consumer's asF64 uses `f64.convert_i32_u` instead of `_s` ([0, 2^32) range).
  const callIR = attachSigMeta(typed(['call', `$${callee}`, ...args], func?.sig.results[0] || 'f64'), func?.sig)
  return callIR
}

/** Const-bound, non-escaping closure — direct call to its body, skipping
 *  call_indirect. emitDecl registered name→bodyName when it saw the closure.make
 *  IR. Returns null if arity exceeds the closure-table slot width (caller falls
 *  through to the generic closure path). */
function tryDirectClosureCall(callee, parsed) {
  const bodyName = ctx.func.directClosures.get(callee)
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const n = parsed.normal.length
  if (n > W) return null
  // Body signature is uniform $ftN: (env f64, argc i32, a0..a{W-1} f64) → f64.
  // We pass the closure NaN-box itself as env (body extracts captures via __ptr_offset(__env)).
  const slots = parsed.normal.map(a => asF64(emit(a)))
  while (slots.length < W) slots.push(undefExpr())
  return typed(['call', `$${bodyName}`,
    asF64(emit(callee)),
    typed(['i32.const', n], 'i32'),
    ...slots], 'f64')
}

/** Generic closure call: callee is a value holding a NaN-boxed closure pointer.
 *  Uniform convention: fn.call packs all args into an array and trampolines. */
function emitGenericClosureCall(callee, parsed) {
  if (parsed.hasSpread) {
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const arrayIR = buildArrayWithSpreads(combined)
    // Pass pre-built array as single already-emitted arg
    return ctx.closure.call(emit(callee), [arrayIR], true)
  }
  return ctx.closure.call(emit(callee), parsed.normal)
}

/** Last-resort fallback: assume `(call $callee args)` against an import / unknown
 *  identifier. Matches arg count to the env-import signature when known — wasm
 *  validates arity strictly, so JS-style "pad missing / drop extra" needs to be
 *  done here rather than by the host. */
function emitUnknownCalleeCall(callee, argList) {
  let calleeArity = null
  if (typeof callee === 'string') {
    const imp = ctx.module.imports?.find(i =>
      Array.isArray(i) && i[0] === 'import' && i[3]?.[0] === 'func' && i[3]?.[1] === `$${callee}`)
    if (imp) {
      let n = 0
      for (let k = 2; k < imp[3].length; k++) if (Array.isArray(imp[3][k]) && imp[3][k][0] === 'param') n++
      calleeArity = n
    }
  }
  const emittedArgs = argList.map(a => asF64(emit(a)))
  if (calleeArity != null) {
    while (emittedArgs.length < calleeArity) emittedArgs.push(undefExpr())
    if (emittedArgs.length > calleeArity) emittedArgs.length = calleeArity
  }
  return typed(['call', `$${callee}`, ...emittedArgs], 'f64')
}

/** Compound assignment: read → op → write back (via readVar/writeVar). */
function compoundAssign(name, val, f64op, i32op) {
  if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
  const void_ = _expect === 'void'
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
  if (i32op && va.type === 'i32' && vbi.type === 'i32')
    return writeVar(name, i32op(va, vbi), void_)
  return writeVar(name, f64op(asF64(va), asF64(vb)), void_)
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
    return typed(['block', ['result', last.type],
      ...results.slice(0, -1).flatMap(dropSpread), last], last.type)
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
    return typed(['block',
      ['local.set', `$${thrown}`, asF64(emit(expr))],
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${thrown}`]]],
      ['throw', '$__jz_err', ['local.get', `$${thrown}`]]], 'void')
  },

  'catch': (body, errName, handler) => {
    if (!canThrow(body)) return emitVoid(body)

    ctx.runtime.throws = ctx.runtime.userThrows = true
    const id = ctx.func.uniq++
    ctx.func.locals.set(errName, 'f64')
    const prev = ctx.func.inTry; ctx.func.inTry = true
    let bodyIR; try { bodyIR = emitVoid(body) } finally { ctx.func.inTry = prev }
    const handlerIR = emitVoid(handler)
    return typed(['block', `$outer${id}`, ['result', 'f64'],
      ['block', `$catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$catch${id}`],
          ...bodyIR],
        ['f64.const', 0],
        ['br', `$outer${id}`]],
      ['local.set', `$${errName}`],
      ...handlerIR,
      ['f64.const', 0]], 'f64')
  },

  'finally': (body, cleanup) => {
    if (!canThrow(body)) {
      const parentStack = ctx.func.finallyStack || []
      const activeStack = parentStack.concat([cleanup])
      const bodyIR = withFinallyStack(activeStack, () => emitVoid(body))
      const cleanupIR = isTerminator(body) ? [] : withFinallyStack(parentStack, () => emitVoid(cleanup))
      return [...bodyIR, ...cleanupIR]
    }

    ctx.runtime.throws = ctx.runtime.userThrows = true
    const id = ctx.func.uniq++
    const errLocal = temp('err')
    const parentStack = ctx.func.finallyStack || []
    const activeStack = parentStack.concat([cleanup])

    const prevTry = ctx.func.inTry
    ctx.func.inTry = true
    const bodyIR = withFinallyStack(activeStack, () => {
      try { return emitVoid(body) }
      finally { ctx.func.inTry = prevTry }
    })
    const normalCleanup = withFinallyStack(parentStack, () => emitVoid(cleanup))
    const throwCleanup = withFinallyStack(parentStack, () => emitVoid(cleanup))

    return ['block', `$fin_done${id}`,
      ['block', `$fin_catch${id}`, ['result', 'f64'],
        ['try_table', ['catch', '$__jz_err', `$fin_catch${id}`],
          ...bodyIR],
        ...normalCleanup,
        ['br', `$fin_done${id}`]],
      ['local.set', `$${errLocal}`],
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
    const ir = pk != null ? asPtrOffset(emit(expr), pk) : asParamType(emit(expr), rt)
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
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
    if (Array.isArray(name) && name[0] === '[]') return emitElementAssign(name[1], name[2], val)
    if (Array.isArray(name) && name[0] === '.')  return emitPropertyAssign(name[1], name[2], val)
    if (typeof name !== 'string') err(`Assignment to non-variable: ${JSON.stringify(name)}`)
    const void_ = _expect === 'void'
    if (Array.isArray(val) && val[0] === 'u+' && val[1] === name) {
      inc('__to_num')
      return writeVar(name, typed(['call', '$__to_num', asI64(emit(name))], 'f64'), void_)
    }
    return writeVar(name, emit(val), void_)
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
    return compoundAssign(name, val, (a, b) => typed(['f64.add', a, b], 'f64'), (a, b) => typed(['i32.add', a, b], 'i32'))
  },
  ...Object.fromEntries([
    ['-=', 'sub'], ['*=', 'mul'], ['/=', 'div'],
  ].map(([op, fn]) => [op, (name, val) => {
    if (typeof name !== 'string') return emit(['=', name, [op.slice(0, -1), name, val]])
    return compoundAssign(name, val,
      (a, b) => typed([`f64.${fn}`, a, b], 'f64'),
      fn === 'div' ? null : (a, b) => typed([`i32.${fn}`, a, b], 'i32')
    )
  }])),
  '%=': (name, val) => {
    if (typeof name !== 'string') return emit(['=', name, ['%', name, val]])
    return compoundAssign(name, val, f64rem, (a, b) => typed(['i32.rem_s', a, b], 'i32'))
  },

  // Bitwise compound assignments: i32 normally, i64 when either operand is BigInt
  ...Object.fromEntries([
    ['&=', 'and'], ['|=', 'or'], ['^=', 'xor'],
    ['>>=', 'shr_s'], ['<<=', 'shl'], ['>>>=', 'shr_u'],
  ].map(([op, fn]) => [op, (name, val) => {
    if (typeof name !== 'string') return emit(['=', name, [op.slice(0, -1), name, val]])
    if (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT) {
      const void_ = _expect === 'void'
      const result = fromI64([`i64.${fn}`, asI64(readVar(name)), asI64(emit(val))])
      return writeVar(name, result, void_)
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
    if (isConst(name)) err(`Assignment to const '${name}'`)
    const void_ = _expect === 'void'
    const t = temp()
    const va = readVar(name)
    // Condition: ||= → truthy check, &&= → truthy check, ??= → nullish check
    const lhs = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    const cond = op === '??=' ? isNullish(lhs) : truthyIR(lhs)
    // &&= and ??= assign when cond is true (truthy / nullish); ||= assigns when cond is false
    const [thenExpr, elseExpr] = op === '||='
      ? [['local.get', `$${t}`], asF64(emit(val))]
      : [asF64(emit(val)), ['local.get', `$${t}`]]
    const result = typed(['if', ['result', 'f64'], cond, ['then', thenExpr], ['else', elseExpr]], 'f64')
    // Write back (handles boxed/global/local)
    if (ctx.func.boxed?.has(name)) return withTemp(result, bt => [
      ['f64.store', boxedAddr(name), ['local.get', `$${bt}`]],
      ['local.get', `$${bt}`]])
    return writeVar(name, result, void_)
  }])),

  // === Increment/Decrement ===
  // Postfix resolved in prepare: i++ → (++i) - 1

  ...Object.fromEntries([['++', 'add'], ['--', 'sub']].map(([op, fn]) => [op, name => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
    const void_ = _expect === 'void'
    const v = readVar(name)
    const one = v.type === 'i32' ? ['i32.const', 1] : ['f64.const', 1]
    return writeVar(name, typed([`${v.type}.${fn}`, v, one], v.type), void_)
  }])),

  // === Arithmetic (type-preserving) ===

  // Postfix in void: (++i)-1 / (--i)+1 → just ++i / --i
  '+': (a, b) => {
    if (_expect === 'void' && isPostfix(a, '--', b)) return emit(a, 'void')
    // String concatenation: pure string operands skip generic ToString coercion.
    const vtA = valTypeOf(a)
    const vtB = valTypeOf(b)
    if (vtA === VAL.STRING && vtB === VAL.STRING) {
      // Fused append-byte: `buf += s[i]` skips 1-char SSO construction +
      // generic concat dispatch when rhs is a string-index. The byte flows
      // straight from __char_at into memory, and the bump-extend path elides
      // the alloc+copy when lhs is the heap-top STRING.
      if (Array.isArray(b) && b[0] === '[]' && ctx.core.stdlib['__str_append_byte'] && ctx.core.stdlib['__char_at']) {
        if (valTypeOf(b[1]) === VAL.STRING) {
          inc('__str_append_byte', '__char_at')
          return typed(['call', '$__str_append_byte',
            asI64(emit(a)),
            ctx.abi.string.ops.charCodeAt(asF64(emit(b[1])), asI32(emit(b[2])), ctx),
          ], 'f64')
        }
      }
      return typed(ctx.abi.string.ops.concatRaw(asF64(emit(a)), asF64(emit(b)), ctx), 'f64')
    }
    if (vtA === VAL.STRING || vtB === VAL.STRING) {
      // An OBJECT operand coerces via ToPrimitive(string) at compile time —
      // __str_concat's runtime __to_str cannot invoke a user-defined toString.
      // A BOOL operand renders "true"/"false" rather than its 0/1 carrier.
      const strOperand = (vt, n) => vt === VAL.OBJECT ? typed(['f64.reinterpret_i64', toStrI64(n, emit(n))], 'f64')
        : vt === VAL.BOOL ? emitBoolStr(n) : asF64(emit(n))
      const ea = strOperand(vtA, a)
      const eb = strOperand(vtB, b)
      return typed(ctx.abi.string.ops.concat(ea, eb, ctx), 'f64')
    }
    if (vtA === VAL.BIGINT || vtB === VAL.BIGINT)
      return fromI64(['i64.add', asI64(emit(a)), asI64(emit(b))])
    // Runtime string dispatch when at least one side could be a string. When one side has
    // a known non-STRING vtype, skip its `__is_str_key` (statically false). Common in
    // chained additions `s + a*b + c.d` — left grows as `+` (=NUMBER), only the new right
    // operand needs the runtime check.
    if ((vtA == null || vtB == null) && ctx.core.stdlib['__str_concat']) {
      const tA = temp('add'), tB = temp('add')
      inc('__str_concat', '__is_str_key')
      const checkA = vtA == null ? ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.tee', `$${tA}`, asF64(emit(a))]]] : null
      const checkB = vtB == null ? ['call', '$__is_str_key', ['i64.reinterpret_f64', ['local.tee', `$${tB}`, asF64(emit(b))]]] : null
      const concat = ['call', '$__str_concat', ['i64.reinterpret_f64', ['local.get', `$${tA}`]], ['i64.reinterpret_f64', ['local.get', `$${tB}`]]]
      const add    = ['f64.add', ['local.get', `$${tA}`], ['local.get', `$${tB}`]]
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
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)) return typed(['i32.add', va, vb], 'i32')
    return typed(['f64.add', toNumF64(a, va), toNumF64(b, vb)], 'f64')
  },
  '-': (a, b) => {
    if (_expect === 'void' && isPostfix(a, '++', b)) return emit(a, 'void')
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return b === undefined
        ? fromI64(['i64.sub', ['i64.const', 0], asI64(emit(a))])
        : fromI64(['i64.sub', asI64(emit(a)), asI64(emit(b))])
    if (b === undefined) return emitNeg(a)
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a - b)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 0) return toNumF64(a, va)
    // Unsigned uint32 operand: JS `-` is float (can go negative / exceed i32),
    // so avoid the wrapping i32.sub fast-path. See `+` above.
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)) return typed(['i32.sub', va, vb], 'i32')
    return typed(['f64.sub', toNumF64(a, va), toNumF64(b, vb)], 'f64')
  },
  'u+': a => {
    if (valTypeOf(a) === VAL.BIGINT)
      return typed(['f64.convert_i64_s', asI64(emit(a))], 'f64')
    const v = emit(a)
    if (v.type === 'i32') return asF64(v)
    if (valTypeOf(a) === VAL.NUMBER) return toNumF64(a, v)
    inc('__to_num')
    return typed(['call', '$__to_num', asI64(v)], 'f64')
  },
  'u-': a => emitNeg(a),
  '*': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64(['i64.mul', asI64(emit(a)), asI64(emit(b))])
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
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb) && mulFitsI32(va, vb)) return typed(['i32.mul', va, vb], 'i32')
    return typed(['f64.mul', toNumF64(a, va), toNumF64(b, vb)], 'f64')
  },
  '/': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64(['i64.div_s', asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a / b, b => b !== 0)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 1) return toNumF64(a, va)
    return typed(['f64.div', toNumF64(a, va), toNumF64(b, vb)], 'f64')
  },
  '%': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64(['i64.rem_s', asI64(emit(a)), asI64(emit(b))])
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a % b, b => b !== 0)
    if (_f) return _f
    // ES remainder by zero is NaN; only the f64 path yields that (a - trunc(a/0)*0).
    // The i32.rem_s fast path traps on a zero divisor, so divert a literal-zero divisor.
    if (isLit(vb) && litVal(vb) === 0) return emitNum(NaN)
    // i32.rem_s is exact for integer operands AND fast, but it TRAPS on a zero
    // divisor where JS yields NaN. Only take it when the divisor is a literal
    // (necessarily nonzero — literal 0 is handled above); a runtime i32 divisor
    // could be 0, so route it to f64rem (exact for in-range integers, NaN for 0).
    // `.unsigned` operand: `i32.rem_s` reads the uint32 as a negative signed value
    // ((2^32-1)%7 → rem_s(-1,7) = -1, not 3). Widen to f64 — see `+` above.
    if (isLit(vb) && isI32Num(va) && isI32Num(vb) && !va.unsigned && !vb.unsigned) return typed(['i32.rem_s', va, vb], 'i32')
    return f64rem(toNumF64(a, va), toNumF64(b, vb))
  },
  // === Comparisons (always i32 result) ===

  '==': (a, b) => emitLooseEq(a, b, false),
  '!=': (a, b) => emitLooseEq(a, b, true),
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
    inc('__is_truthy')
    return typed(['i32.eqz', ['call', '$__is_truthy', asI64(v)]], 'i32')
  },

  '?:': (a, b, c) => {
    // Constant condition → emit only the live branch
    const ca = emit(a)
    if (isLit(ca)) { const v = litVal(ca); return (v !== 0 && v === v) ? emit(b) : emit(c) }
    const cond = toBoolFromEmitted(ca)
    // Flow-sensitive refinement: each arm sees narrowing consistent with `a` being truthy / falsy.
    const thenRefs = extractRefinements(a, new Map(), true)
    const elseRefs = extractRefinements(a, new Map(), false)
    const vb = withRefinements(thenRefs, b, () => emit(b))
    const vc = withRefinements(elseRefs, c, () => emit(c))
    // L: Use WASM select for pure ternaries — branchless, smaller bytecode
    if (vb.type === 'i32' && vc.type === 'i32') {
      // Propagate matching ptrKind/ptrAux so a downstream asF64 takes the NaN-rebox
      // path instead of `f64.convert_i32_s`. Mismatched kinds drop both — caller's
      // asF64 will treat the i32 as numeric, which is correct for non-pointer i32s.
      // ptrKind matches but ptrAux differs (e.g. polymorphic OBJECT with two
      // distinct schemaIds, or TYPED with two element types) — fall through to
      // the f64 path. There each arm reboxes independently, preserving its own
      // aux in the NaN-box. The single-i32 path can only carry one aux on the
      // result, so `boxPtrIR` would default to 0 and lose the runtime schema /
      // elemType bits needed by downstream lookups (e.g. __dyn_get's OBJECT-
      // schema fallback uses receiver aux to resolve `.prop`).
      const auxMismatch = vb.ptrKind != null && vb.ptrKind === vc.ptrKind
        && (vb.ptrAux ?? null) !== (vc.ptrAux ?? null)
      if (!auxMismatch) {
        const tagPtr = (n) => {
          if (vb.ptrKind != null && vb.ptrKind === vc.ptrKind) {
            n.ptrKind = vb.ptrKind
            if (vb.ptrAux != null && vb.ptrAux === vc.ptrAux) n.ptrAux = vb.ptrAux
          }
          return n
        }
        if (isPureIR(vb) && isPureIR(vc))
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
    if (refPayload) {
      const ib = ['i64.reinterpret_f64', fb]
      const ic = ['i64.reinterpret_f64', fc]
      const bits = isPureIR(fb) && isPureIR(fc)
        ? ['select', ib, ic, cond]
        : ['if', ['result', 'i64'], cond, ['then', ib], ['else', ic]]
      return typed(['f64.reinterpret_i64', bits], 'f64')
    }
    if (!refPayload && isPureIR(fb) && isPureIR(fc))
      return typed(['select', fb, fc, cond], 'f64')
    return typed(['if', ['result', 'f64'], cond, ['then', fb], ['else', fc]], 'f64')
  },

  '&&': (a, b) => {
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
    const emitRight = () => withRefinements(rightRefs, b, () => emit(b))
    // i32 fast path: use i32 tee as cond directly (nonzero=truthy in wasm `if`),
    // skip f64 round-trip and __is_truthy call entirely.
    if (va.type === 'i32') {
      const vb = emitRight()
      const t = tempI32()
      if (vb.type === 'i32') {
        return typed(['if', ['result', 'i32'],
          ['local.tee', `$${t}`, va],
          ['then', vb],
          ['else', ['local.get', `$${t}`]]], 'i32')
      }
      return typed(['if', ['result', 'f64'],
        ['local.tee', `$${t}`, va],
        ['then', asF64(vb)],
        ['else', typed(['f64.convert_i32_s', ['local.get', `$${t}`]], 'f64')]], 'f64')
    }
    const t = temp()
    const teed = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    return typed(['if', ['result', 'f64'],
      toBoolFromEmitted(teed),
      ['then', asF64(emitRight())],
      ['else', ['local.get', `$${t}`]]], 'f64')
  },

  '||': (a, b) => {
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
    if (va.type === 'i32') {
      const vb = emitRight()
      const t = tempI32()
      if (vb.type === 'i32') {
        return typed(['if', ['result', 'i32'],
          ['local.tee', `$${t}`, va],
          ['then', ['local.get', `$${t}`]],
          ['else', vb]], 'i32')
      }
      return typed(['if', ['result', 'f64'],
        ['local.tee', `$${t}`, va],
        ['then', typed(['f64.convert_i32_s', ['local.get', `$${t}`]], 'f64')],
        ['else', asF64(vb)]], 'f64')
    }
    const t = temp()
    const teed = typed(['local.tee', `$${t}`, asF64(va)], 'f64')
    return typed(['if', ['result', 'f64'],
      toBoolFromEmitted(teed),
      ['then', ['local.get', `$${t}`]],
      ['else', asF64(emitRight())]], 'f64')
  },

  // a ?? b: returns b only if a is nullish
  '??': (a, b) => {
    const va = emit(a)
    const t = temp()
    return typed(['if', ['result', 'f64'],
      // Check: is a NOT nullish?
      ['i32.eqz', isNullish(['local.tee', `$${t}`, asF64(va)])],
      ['then', ['local.get', `$${t}`]],
      ['else', asF64(emit(b))]], 'f64')
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
  '~':   a => {
    if (Array.isArray(a) && a[0] === '~') {
      const inner = a[1]
      // ~~x === x for BigInt; the int32-truncation fold below is number-only.
      if (valTypeOf(inner) === VAL.BIGINT) return emit(inner)
      const iv = emit(inner)
      return isLit(iv) ? emitNum(~~litVal(iv)) : typed(toI32(isI32Num(iv) ? iv : toNumF64(inner, iv)), 'i32')
    }
    // BigInt complement is the i64 `x ^ -1` (all bits flipped), like emitNeg's i64.sub.
    if (valTypeOf(a) === VAL.BIGINT) return fromI64(['i64.xor', asI64(emit(a)), ['i64.const', -1]])
    const v = emit(a); return isLit(v) ? emitNum(~litVal(v)) : typed(['i32.xor', toI32(isI32Num(v) ? v : toNumF64(a, v)), typed(['i32.const', -1], 'i32')], 'i32')
  },
  ...Object.fromEntries([
    ['&', 'and'], ['|', 'or'], ['^', 'xor'], ['<<', 'shl'], ['>>', 'shr_s'],
  ].map(([op, fn]) => [op, (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT)
      return fromI64([`i64.${fn}`, asI64(emit(a)), asI64(emit(b))])
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
    const c = ce.type === 'i32' ? ce : toBoolFromEmitted(ce)
    // Flow-sensitive type refinement: narrow types within each branch based on the guard.
    const thenRefs = extractRefinements(cond, new Map(), true)
    const elseRefs = extractRefinements(cond, new Map(), false)
    const thenBody = withRefinements(thenRefs, then, () => emitVoid(then))
    if (els != null) {
      const elseBody = withRefinements(elseRefs, els, () => emitVoid(els))
      return ['if', c, ['then', ...thenBody], ['else', ...elseBody]]
    }
    return ['if', c, ['then', ...thenBody]]
  },

  'for': (init, cond, step, body) => {
    if (body === undefined) return err('for-in/for-of not supported')
    if (!ctx.transform.optimize || ctx.transform.optimize.smallConstForUnroll !== false) {
      const unrolled = unrollSmallConstFor(init, cond, step, body)
      if (unrolled) return unrolled
    }
    const id = ctx.func.uniq++
    const brk = `$brk${id}`, loop = `$loop${id}`
    // The cont wrapper is only needed if the body has a `continue` AND there is a step
    // expression — `continue` must jump to before the step. Without a step, `continue`
    // can target the loop label directly, saving a redundant `block`.
    const needsCont = step && hasOwnContinue(body)
    const cont = needsCont ? `$cont${id}` : loop
    ctx.func.stack.push({ brk, loop: cont })
    const frame = ctx.func.stack[ctx.func.stack.length - 1]
    // Per-iteration fresh cells for boxed locals declared in the body — allocated
    // at body entry so a closure declared before its binding captures the right
    // cell (sets frame.loopFresh; emitDecl then stores rather than re-allocates).
    const freshBoxed = emitLoopFreshBoxed(body, frame)
    const result = []
    if (init != null) result.push(...emitVoid(init))
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
    const loopBody = []
    if (condForLoop) loopBody.push(['br_if', brk, ['i32.eqz', toBool(condForLoop)]])
    loopBody.push(...freshBoxed)
    if (needsCont) loopBody.push(['block', cont, ...emitVoid(body)])
    else loopBody.push(...emitVoid(body))
    if (step) loopBody.push(...emitVoid(step))
    loopBody.push(['br', loop])
    result.push(['block', brk, ['loop', loop, ...loopBody]])
    ctx.func.stack.pop()
    return result.length === 1 ? result[0] : result
  },

  'switch': (discriminant, ...cases) => {
    const disc = `${T}disc${ctx.func.uniq++}`
    ctx.func.locals.set(disc, 'f64')

    const result = [['local.set', `$${disc}`, asF64(emit(discriminant))]]

    for (const c of cases) {
      if (c[0] === 'case') {
        const [, test, body] = c
        const skip = `$skip${ctx.func.uniq++}`
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
    const brk = `$label${ctx.func.uniq++}`
    ctx.func.stack.push({ label: name, brk })
    const result = ['block', brk, ...emitVoid(body)]
    ctx.func.stack.pop()
    return result
  },
  'break': (label) => {
    const target = label == null
      ? loopTop().brk
      : ctx.func.stack.findLast(frame => frame.label === label)?.brk
    if (!target) err(`break label '${label}' is not in scope`)
    return [...emitFinalizers(), ['br', target]]
  },
  'continue': (label) => {
    if (label != null) err(`continue label '${label}' is not supported`)
    return [...emitFinalizers(), ['br', loopTop().loop]]
  },

  // === Call ===

  // Arrow as value → closure
  '=>': (rawParams, body) => {
    if (!ctx.closure.make) err('Closures require fn module (auto-included)')

    const raw = extractParams(rawParams)
    const params = [], defaults = {}
    let restParam = null, bodyPrefix = []
    for (const r of raw) {
      const c = classifyParam(r)
      if (c.kind === 'rest') { restParam = c.name; params.push(c.name) }
      else if (c.kind === 'plain') params.push(c.name)
      else if (c.kind === 'default') { params.push(c.name); defaults[c.name] = c.defValue }
      else {
        const tmp = `${T}p${ctx.func.uniq++}`
        params.push(tmp)
        if (c.kind === 'destruct-default') defaults[tmp] = c.defValue
        bodyPrefix.push(['let', ['=', c.pattern, tmp]])
      }
    }

    // Prepend destructuring to body (if any destructured params)
    if (bodyPrefix.length) {
      if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';')
        body = ['{}', [';', ...bodyPrefix, ...body[1].slice(1)]]
      else if (Array.isArray(body) && body[0] === '{}')
        body = ['{}', [';', ...bodyPrefix, body[1]]]
      else body = ['{}', [';', ...bodyPrefix, ['return', body]]]
    }

    // Find free variables in body that aren't params → captures
    const paramSet = new Set(params)
    const captures = []
    findFreeVars(body, paramSet, captures)
    for (const def of Object.values(defaults)) findFreeVars(def, paramSet, captures)

    // Pass closure info including rest param and defaults
    const closureInfo = { params, body, captures, restParam }
    if (Object.keys(defaults).length) closureInfo.defaults = defaults
    return ctx.closure.make(closureInfo)
  },

  // Linear callee-kind dispatcher. Each strategy below is its own named function
  // (extracted to module scope above); this body is just the routing table.
  '()': (callee, callArgs) => {
    const argList = commaList(callArgs)
    const parsed = parseCallArgs(argList)

    // Closure devirtualization: a module-global callee proven (by plan.js) to hold
    // one statically-known function rewrites to that function, so the
    // known-top-level-function branch emits a direct `call`, dropping the
    // indirect/trampoline path.
    if (typeof callee === 'string' && ctx.func.globalDevirt?.has(callee))
      callee = ctx.func.globalDevirt.get(callee)

    if (Array.isArray(callee) && callee[0] === '.')  return emitMethodCall(callee, parsed, callArgs)

    if (typeof callee === 'string' && ctx.core.emit[callee] && !isBoundName(callee) && !isUserFunc(callee))
      return emitBuiltinCall(callee, parsed)

    if (typeof callee === 'string' && ctx.func.names.has(callee) && !isBoundName(callee))
      return emitDirectFunctionCall(callee, parsed, callArgs)

    if (typeof callee === 'string' && !parsed.hasSpread && ctx.func.directClosures?.has(callee)) {
      const direct = tryDirectClosureCall(callee, parsed)
      if (direct) return direct
    }

    if (ctx.closure.call) return emitGenericClosureCall(callee, parsed)

    return emitUnknownCalleeCall(callee, argList)
  },
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
function liftOptionalChain(node) {
  const path = []
  let cur = node
  while (Array.isArray(cur) && (cur[0] === '.' || cur[0] === '[]' || cur[0] === '()' ||
                                 cur[0] === '?.' || cur[0] === '?.[]' || cur[0] === '?.()')) {
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
  return withNullGuard(asF64(emit(opt[1])), t => {
    let rebuilt = opt[0] === '?.'   ? ['.',  t, opt[2]]
                : opt[0] === '?.[]' ? ['[]', t, opt[2]]
                                    : ['()', t, ...opt.slice(2)]
    for (let i = optIdx - 1; i >= 0; i--) rebuilt = [path[i][0], rebuilt, ...path[i].slice(2)]
    return asF64(emit(rebuilt))
  }, 'oc')
}

/**
 * Emit single AST node to typed WASM IR.
 * Every returned node has .type = 'i32' | 'f64'.
 * @param {import('./prepare.js').ASTNode} node
 * @returns {Array} typed WASM S-expression
 */
export function emit(node, expect) {
  _expect = expect || null
  if (Array.isArray(node)) {
    ctx.error.node = node
    if (node.loc != null) ctx.error.loc = node.loc
  }
  if (node == null) return null
  // Boolean literals carry VAL.BOOL for type observation (valTypeOf reads the
  // AST), but their working representation is the plain number 0/1 — identical
  // codegen to the pre-carrier `[, 1]`/`[, 0]` folding, so no perf is paid.
  if (node === true) return emitNum(1)
  if (node === false) return emitNum(0)
  if (typeof node === 'symbol') // JZ_NULL / JZ_UNDEF sentinels → null / undefined NaN
    return node === JZ_UNDEF ? undefExpr() : nullExpr()
  if (typeof node === 'bigint') {
    // Truncate to 64 bits — `BigInt.asUintN(64, …)` semantics, same as the
    // explicit mask `node & 0xFFFFFFFFFFFFFFFFn`. Decimal form (vs. the prior
    // unsigned-hex dance) is enough now that watr's optimize.js getConst
    // handles signed strings correctly (4.6.8 W5 fix).
    return typed(['f64.reinterpret_i64', ['i64.const', BigInt.asUintN(64, node).toString()]], 'f64')
  }
  if (typeof node === 'number') return emitNum(node)
  if (typeof node === 'string') {
    // Variable read: boxed / local / param / global (check before emitter table to avoid name collisions)
    if (ctx.func.boxed?.has(node) || isBoundName(node) || isGlobal(node) || repOf(node)?.intConst != null)
      return readVar(node)
    // Top-level function used as value → wrap as closure pointer for call_indirect
    if (ctx.func.names.has(node) && !isBoundName(node) && ctx.closure.table) {
      // Trampoline signature: uniform closure ABI (env f64, argc i32, a0..a{MAX-1} f64) → f64.
      // Forwards the first N inline slots to $func where N = func's fixed param count.
      const func = ctx.func.map.get(node)
      const sigParams = func?.sig.params || []
      if (sigParams.length > MAX_CLOSURE_ARITY) err(`Function ${node} used as closure value has ${sigParams.length} params, exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY}`)
      const trampolineName = `${T}tramp_${node}`
      if (!ctx.core.stdlib[trampolineName]) {
        const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
        const paramDecls = ['(param $__env f64)', '(param $__argc i32)']
        for (let i = 0; i < W; i++) paramDecls.push(`(param $__a${i} f64)`)
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
        // Forward fixed slots (i32 via trunc_sat); the rest slot → packed array ptr.
        const fwd = sigParams.map((p, i) =>
          i === restIdx
            ? `(call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $__roff))`
            : p.type === 'i32'
              ? `(i32.trunc_sat_f64_s (local.get $__a${i}))`
              : `(local.get $__a${i})`).join(' ')
        if ((func?.sig.results.length || 1) > 1) {
          const n = func.sig.results.length
          const arr = `${T}retarr`
          const temps = Array.from({ length: n }, (_, i) => `${T}ret${i}`)
          const tempLocals = temps.map(name => `(local $${name} f64)`).join(' ')
          const stores = temps.map((name, i) =>
            `(f64.store (i32.add (local.get $${arr}) (i32.const ${i * 8})) (local.get $${name}))`
          ).join(' ')
          const capture = temps.slice().reverse().map(name => `(local.set $${name})`).join(' ')
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} ${paramDecls.join(' ')} (result f64) (local $${arr} i32) ${tempLocals} ${restLocals}${restPrelude}(call $${node} ${fwd}) ${capture} (local.set $${arr} (call $__alloc (i32.const ${n * 8 + 8}))) (i32.store (local.get $${arr}) (i32.const ${n})) (i32.store (i32.add (local.get $${arr}) (i32.const 4)) (i32.const ${n})) (local.set $${arr} (i32.add (local.get $${arr}) (i32.const 8))) ${stores} (call $__mkptr (i32.const 1) (i32.const 0) (local.get $${arr})))`
          inc(trampolineName, '__alloc', '__mkptr', ...(restIdx >= 0 ? ['__alloc_hdr'] : []))
        } else {
          // Convert i32/i64 results back to f64 — uniform closure ABI returns f64.
          const resType = func?.sig.results[0]
          const callExpr = `(call $${node} ${fwd})`
          const wrapped = resType === 'i32'
            ? (func.sig.unsignedResult ? `(f64.convert_i32_u ${callExpr})` : `(f64.convert_i32_s ${callExpr})`)
            : resType === 'i64'
              ? `(f64.reinterpret_i64 ${callExpr})`
              : callExpr
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} ${paramDecls.join(' ')} (result f64) ${restLocals}${restPrelude}${wrapped})`
          inc(trampolineName, ...(restIdx >= 0 ? ['__alloc_hdr', '__mkptr'] : []))
        }
      }
      let idx = ctx.closure.table.indexOf(trampolineName)
      if (idx < 0) { idx = ctx.closure.table.length; ctx.closure.table.push(trampolineName) }
      const ir = mkPtrIR(PTR.CLOSURE, idx, 0)
      ir.closureFuncIdx = idx
      return ir
    }
    // Emitter table: only namespace-resolved names (contain '.', e.g. 'math.PI') — safe from user variable collision.
    // `handler.length` distinguishes the two flavors of entry: arity-0 handlers
    // are constants (e.g. `math.PI` → emits `f64.const PI`) and can be invoked
    // directly here. Arity-≥1 handlers expect the surrounding call node, so
    // bare-name use of them is a first-class-value reference — wrap as a closure.
    if (node.includes('.') && ctx.core.emit[node]) {
      const handler = ctx.core.emit[node]
      const isCallable = handler.length > 0
      return isCallable ? builtinFunctionValue(node) : handler()
    }
    // Auto-import known host globals (WebAssembly, globalThis, etc.). Emit only
    // records the usage; the `(import "env" … (global … i64))` node is drained
    // into ctx.module.imports at assembly (compile/index.js), the same way
    // ctx.core.jsstring is — emit does not own ctx.scope / ctx.module sections.
    // Carrier is i64 (not f64) so V8 can't canonicalize the NaN-boxed external-ref
    // payload across the wasm↔JS global boundary (same hazard as env.print —
    // see module/console.js header). asF64() reinterprets to f64 at each read.
    if (HOST_GLOBALS.has(node) && !isBoundName(node) && !isGlobal(node)) {
      if (ctx.transform.host === 'wasi') err(`host:'wasi': reference to host global \`${node}\` requires an env import. Remove the reference or use host:'js'.`)
      ctx.features.external = true
      ctx.core.hostGlobals.add(node)
      return typed(['global.get', `$${node}`], 'i64')
    }
    const t = ctx.func.locals?.get(node) || ctx.func.current?.params.find(p => p.name === node)?.type || 'f64'
    return typed(['local.get', `$${node}`], t)
  }
  if (!Array.isArray(node)) return typed(['f64.const', 0], 'f64')

  const [op, ...args] = node
  // WASM IR passthrough: internally-generated IR nodes (from statement flattening) pass through
  if (typeof op === 'string' && !ctx.core.emit[op] && (op.includes('.') || WASM_OPS.has(op))) return node

  // Self-describing bigint literal (`normalizeBigints`, used at the host→kernel AST
  // boundary). args[0] is the unsigned-64 decimal computed host-side, passed straight
  // to i64.const — no in-kernel parse, byte-identical to the raw-primitive path above.
  if (op === 'bigint') return typed(['f64.reinterpret_i64', ['i64.const', args[0]]], 'f64')

  // Literal node [, value] — handle null/undefined values
  if (op == null && args.length === 1) {
    const v = args[0]
    return v === undefined ? undefExpr() : v === null ? nullExpr() : emit(v)
  }

  // Optional-chain continuation: `a?.b.c` → if `a` nullish then undefined else `a.b.c`.
  // Lift before dispatch so the regular `.` / `[]` / `()` handler sees the rebuilt chain
  // with the optional already replaced by a non-optional access on a guarded temp.
  if (op === '.' || op === '[]' || op === '()') {
    const lifted = liftOptionalChain(node)
    if (lifted) return lifted
  }

  const handler = ctx.core.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  return handler(...args)
}
