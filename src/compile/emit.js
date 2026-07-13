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
  commaList, T, isBlockBody, isReassigned, mutatesArrayLength, isConstLiteral, constLiteralHoistable,
  hasOwnContinue, hasLabeledContinueTo, hasOwnBreakOrContinue, extractParams, classifyParam, JZ_UNDEF, TYPEOF,
  ASSIGN_OPS,
} from '../ast.js'
import { ctx, err, inc, warnDeopt, PTR, ssoBitI64Hex, LAYOUT } from '../ctx.js'
import { i64Hex, encodePtrHi, STR_HCACHE_BIT } from '../../layout.js'
import { bodyOnlyCharCodeAtCalls } from '../abi/string.js'
import { includeForStringOnly } from '../autoload.js'
import { FITS_I32_MAX } from '../widen.js'
import { nonNegIntLiteral, intLiteralValue, staticPropertyKey } from '../static.js'
import { findFreeVars } from './analyze.js'
import {
  containsNestedClosure, containsNestedLoop, nestedSmallLoopBudget,
  containsDeclOf, cloneWithSubst, containsKnownTypedArrayIndex,
  smallConstForTripCount, isTerminator, scanBoundedLoops, inBoundsCharCodeAt,
  exprType, MAX_SMALL_FOR_UNROLL, MAX_NESTED_FOR_UNROLL,
  inBoundsArrIdx, typedIdxProven, versionableTypedFor, idxKey,
} from '../type.js'
import { valTypeOf, shapeOf } from '../kind.js'
import { VAL, lookupValType, repOf, updateRep, repOfGlobal } from '../reps.js'
import {
  typed, asF64, asI32, asI64, asPtrOffset, asParamType, toI32, fromI64,
  NULL_IR, nullExpr, undefExpr, MAX_CLOSURE_ARITY, TRUE_NAN, FALSE_NAN, NULL_NAN,
  WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS,
  mkPtrIR, ptrOffsetIR, ptrTypeIR, ptrTypeEq, dispatchByPtrType, sidecarOverride, valKindToPtr,
  isLit, litVal, isNullishLit, isPureIR, emitNum, f64rem, toNumF64, toStrI64, maskBound,
  truthyIR, toBoolFromEmitted, isPostfix,
  isGlobal, isConst, usesDynProps, needsDynShadow,
  temp, tempI32, tempI64, allocPtr,
  block64, withTemp,
  boxedAddr, readVar, writeVar, isNullish, isNull, isUndef, isBoolAtom,
  boolBoxIR, carrierF64,
  isLiteralStr, resolveValType, isFuncRef,
  multiCount, loopTop, flat,
  reconstructArgsWithSpreads, tcoTailRewrite,
  extractF64Bits,
} from '../ir.js'
import { isBoundName } from '../ir.js'
import { extractRefinements, withRefinements } from './flow-types.js'
import { emitElementAssign, emitPropertyAssign, persistBindingPtr } from './emit-assign.js'

const stringOps = (node) => {
  const rep = typeof node === 'string' ? repOf(node) : null
  return ctx.abi.resolve('string', rep)?.ops ?? ctx.abi.string.ops
}


// === Emitter state & operand classification ===

// Current emission "expect" mode ('void' or null); set by emit(), read by
// compound-assignment emitters (here and in emit-assign.js — shared via ctx so
// the module graph stays acyclic) to decide between value-returning and
// side-effect-only forms. Transient: meaningful only within one dispatch.

// A genuine i32 *number* — safe for the i32 fast path in arithmetic/bitwise
// operators. An unboxed pointer (object/array/string/closure local kept as a
// raw i32 handle) is *also* i32-typed but carries `.ptrKind`; treating it as a
// number would compute on raw pointer bits. A ptrKind-carrying operand must
// instead route through ToNumber (`toNumF64`), which performs ToPrimitive.
const isI32Num = (v) => v.type === 'i32' && v.ptrKind == null

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
const tryI32Arith = (wasmOp, astOp, a, b, va, vb) => {
  const pa = peelI32(va); if (pa == null) return null
  const pb = peelI32(vb); if (pb == null) return null
  if (exprType([astOp, a, b], ctx.func.locals) !== 'i32') return null
  return typed([wasmOp, pa, pb], 'i32')
}

// f64 arithmetic that can MINT a sign-nondeterministic NaN (0/0, ∞−∞, 0·∞, x%0): on x86
// these are 0xFFF8…, on arm 0x7FF8…. sqrt/min/max/neg are NOT here — they canon at their
// own emit (math.js / unary `-`), so they reach canonNum already canonical.
const NAN_MINTING = new Set(['f64.div', 'f64.add', 'f64.sub', 'f64.mul'])

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

// Is an emitted arm `v` (AST `node`) a plain NUMBER? The predicate the two-arm merges
// (?:, ??) share to decide canon: an i32 number, NUMBER-tagged IR, or a NUMBER
// value-type qualifies; a pointer/opaque arm does not. `vt` is the node's resolved
// value-type — pass it when already computed to avoid the re-resolve.
const isNumArm = (v, node, vt = resolveValType(node, valTypeOf, lookupValType)) =>
  isI32Num(v) || v.valKind === VAL.NUMBER || vt === VAL.NUMBER

// One arm of a two-arm f64 merge (?:, ??, ||, &&) whose result may be bit-tested while
// untyped. Canon (canonNum, a no-op unless the arm is NaN-minting arithmetic) ONLY a
// LONE numeric arm: when both arms are numeric the merge is value-typed NUMBER and read
// NaN-by-value (no canon); when the other arm is opaque the result is untyped, so a
// non-canonical NaN here would be misread by __is_truthy — fold it. A pointer arm
// (isNum=false) is never touched (canon would destroy its NaN-box).
const canonArm = (f, isNum, otherNum) => isNum && !otherNum ? canonNum(f) : f

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
    }
  }
  return v
}

const FIRST_CLASS_UNARY_MATH = {
  'math.abs': 'f64.abs',
  'math.sqrt': 'f64.sqrt',
  'math.ceil': 'f64.ceil',
  'math.floor': 'f64.floor',
  'math.trunc': 'f64.trunc',
}

// Builtins with a hand-written uniform-ABI body (beyond the single-op math set).
// Array.isArray: NaN-boxed AND tag==ARRAY → 1/0 — the same f64.convert_i32 form
// an arrow returning a comparison produces, so callback semantics match
// `xs.filter(x => Array.isArray(x))` exactly (watr's optimizer passes the bare
// builtin to .filter; the self-host kernel must compile it).
const FIRST_CLASS_BUILTIN_BODY = {
  'Array.isArray': () =>
    `(if (result f64) (i32.and (f64.ne (local.get $__a0) (local.get $__a0)) ` +
    `(i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $__a0)) (i64.const ${LAYOUT.TAG_SHIFT}))) (i32.const ${LAYOUT.TAG_MASK})) (i32.const ${PTR.ARRAY}))) ` +
    `(then (f64.const 1)) (else (f64.const 0)))`,
}

function builtinFunctionValue(name) {
  const op = FIRST_CLASS_UNARY_MATH[name]
  const bodyGen = FIRST_CLASS_BUILTIN_BODY[name]
  if (!op && !bodyGen) err(`Builtin function '${name}' cannot be used as a first-class value`)
  if (!ctx.closure.table) err(`Builtin function '${name}' used as value requires closure support`)
  const fn = `${T}builtin_${name.replace(/\W/g, '_')}`
  if (!ctx.core.stdlib[fn]) {
    const width = ctx.closure.width ?? MAX_CLOSURE_ARITY
    const params = ['(param $__env f64)', '(param $__argc i32)']
    for (let i = 0; i < width; i++) params.push(`(param $__a${i} f64)`)
    ctx.core.stdlib[fn] = `(func $${fn} ${params.join(' ')} (result f64) ${op ? `(${op} (local.get $__a0))` : bodyGen()})`
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

// JS `*` is an f64 multiply; `i32.mul` yields only the exact product mod 2^32.
// Those agree under a ToInt32/ToUint32 sink (and as plain numbers) while the
// exact product stays f64-exact. A literal qualifies directly; so does a masked
// operand (`x & 63`, `x >>> k`) whose value is provably bounded. Keeps index
// arithmetic (`i*4`) and bitwise-masked scales (bytebeat's `t*(m&63)`) on
// `i32.mul` while routing hash-mix-scale products to `f64.mul`. The FITS_I32_MAX
// threshold (and the soundness contract with type.js exprType) lives in widen.js.
const mulFitsI32 = (va, vb) =>
  (isLit(va) && Math.abs(litVal(va)) <= FITS_I32_MAX) ||
  (isLit(vb) && Math.abs(litVal(vb)) <= FITS_I32_MAX) ||
  (!isLit(va) && maskBound(va) <= FITS_I32_MAX) ||
  (!isLit(vb) && maskBound(vb) <= FITS_I32_MAX)

// Max |value| of an i32-typed operand from a narrowing typed-array load width — the
// element-read twin of maskBound's `x & 0xff` case (load8_u and `x & 0xff` carry the
// SAME [0,255] range). Infinity when the magnitude is unbounded. Signed loads reach
// −2^(w−1), so the magnitude bound is 2^(w−1).
const I32_LOAD_MAG = { 'i32.load8_s': 128, 'i32.load8_u': 255, 'i32.load16_s': 32768, 'i32.load16_u': 65535 }
const i32Mag = (v) =>
  !Array.isArray(v) ? Infinity :
  v[0] in I32_LOAD_MAG ? I32_LOAD_MAG[v[0]] :
  (v[0] === 'i32.const' && typeof v[1] === 'number') ? Math.abs(v[1]) :
  (v[0] === 'i32.and' || v[0] === 'i32.shr_u') ? maskBound(v) :
  Infinity
// `int8[i]*int8[j]` and friends: a product of two range-bounded integer typed-array
// elements whose magnitudes multiply to ≤ 2^31−1 is FAITHFUL as i32.mul — the exact
// product fits signed i32, so i32.mul == the true value in EVERY consumer context
// (i32 sink AND f64 value), independent of the widen pass. Covers i8/u8/i16 pairs and
// i16×u16 (32768·65535 < 2^31); correctly EXCLUDES u16×u16 (65535² > 2^31). JS `*` of
// two such reads — the int-conv / correlation / quantised-MAC kernel shape — then rides
// the i32 ABI (one op, no f64 round-trip) on V8 / JSC / wasmtime alike, and the i32
// product is lane-vectorizable where the f64 form was not.
const mulBoundedFaithful = (va, vb) => i32Mag(va) * i32Mag(vb) <= 0x7fffffff

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

  if (code === TYPEOF.number) {
    // typeof "number": v===v rejects NaN-box pointers; BOOL carrier is 0/1 → still typeof "boolean".
    if (resolveValType(typeofExpr, valTypeOf, lookupValType) === VAL.BOOL) return typed(['i32.const', eq ? 0 : 1], 'i32')
    return typed([eq ? 'f64.eq' : 'f64.ne', ['local.tee', `$${t}`, va], ['local.get', `$${t}`]], 'i32')
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
    const tt = `${T}${ctx.func.uniq++}`; ctx.func.locals.set(tt, 'i32')
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
  // Integer literal first — a prepare-wrapped literal `[null, k]` (and a const-int
  // name) is itself an Array, so the operator dispatch below would reject it and
  // bail the WHOLE index to the f64 round-trip. The classic victim is the `+ 1` /
  // `(j + 1)` of a bilinear/stencil gather (`a[(j+1)*W + i + 1]`): one literal leaf
  // forced `convert_i32 … f64.mul/add … trunc_sat_f64_s` across every term.
  const lit = nonNegIntLiteral(e)
  if (lit != null) return typed(['i32.const', lit], 'i32')
  if (Array.isArray(e)) {
    const inner = I32_INDEX_OP[e[0]]
    if (inner && e[2] != null) {
      const a = tryI32Index(e[1]); if (a == null) return null
      const b = tryI32Index(e[2]); if (b == null) return null
      return typed([inner, a, b], 'i32')
    }
    return null
  }
  return exprType(e, ctx.func.locals) === 'i32' ? asI32(emit(e)) : null
}
export const emitIndex = (idx) => tryI32Index(idx) ?? asI32(emit(idx))

/**
 * True when `e` is a pure integer `+`/`-`/`*` tree whose leaves are all i32-typed
 * names/globals or integer literals — no calls, member reads, or indexed reads, so
 * emitting it twice (or in a different rep) is side-effect-free. Used to recognise
 * an i32-local initializer that `tryI32Index` can lower to native wrapping i32
 * arithmetic instead of the f64 round-trip (`convert … f64.mul/add … trunc_sat`).
 * The same residue-mod-2^32 argument as `tryI32Index`: ToInt32 of the exact integer
 * value equals two's-complement wrapping i32, so for an i32 destination the two are
 * bit-identical — even when an intermediate product overflows.
 */
function isI32ArithTree(e) {
  if (typeof e === 'number') return Number.isInteger(e)
  if (typeof e === 'string') return exprType(e, ctx.func.locals) === 'i32'
  if (!Array.isArray(e)) return false
  const op = e[0]
  if (op == null) return isI32ArithTree(e[1])                 // literal wrapper [, v]
  if ((op === '+' || op === '-' || op === '*') && e[2] != null)
    return isI32ArithTree(e[1]) && isI32ArithTree(e[2])
  return false
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
function fuseRangeCheck(a, b) {
  const ba = rangeBound(a), bb = rangeBound(b)
  if (!ba || !bb || ba.x !== bb.x || (ba.lo != null) === (bb.lo != null)) return null
  const lo = ba.lo ?? bb.lo, hi = ba.hi ?? bb.hi
  if (lo > hi) return null
  const xv = emit(ba.x)
  if (xv.type !== 'i32') return null                   // f64 (fractional) would mis-fuse
  return typed(['i32.le_u', ['i32.sub', xv, ['i32.const', lo]], ['i32.const', hi - lo]], 'i32')
}

// The complement: `x < LO || x > HI` (the two outside half-checks — one upper-bounded,
// one lower-bounded, with a gap between) → `(x - LO) >u (HI - LO)`, where [LO, HI] is the
// inside range. Same trick, negated; returns null to leave `||` lowering unchanged.
function fuseRangeCheckOr(a, b) {
  const ba = rangeBound(a), bb = rangeBound(b)
  if (!ba || !bb || ba.x !== bb.x || (ba.lo != null) === (bb.lo != null)) return null
  const insideLo = (ba.hi ?? bb.hi) + 1, insideHi = (ba.lo ?? bb.lo) - 1
  if (insideLo > insideHi) return null
  const xv = emit(ba.x)
  if (xv.type !== 'i32') return null
  return typed(['i32.gt_u', ['i32.sub', xv, ['i32.const', insideLo]], ['i32.const', insideHi - insideLo]], 'i32')
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

/** Coerce an emitted arg IR to match a callee param. Param may carry ptrKind (pointer-ABI
 *  i32 offset), else falls back to numeric WASM type coercion.
 *  `node` (the arg's AST, when the caller has it): a statically-BOOL arg headed
 *  into an UNTYPED f64 param crosses as its TRUE/FALSE atom box — the callee
 *  treats that slot as an opaque value, so identity (typeof/String/strict-eq)
 *  must survive. A val-known param (narrow stamped `p.val`) keeps the raw 0/1
 *  ABI its body assumes; i32/pointer params are numeric positions. */
function coerceArg(ir, param, node) {
  if (param?.ptrKind != null) return ptrOffsetIR(ir, param.ptrKind)
  if (node !== undefined && (param == null || (param.type !== 'i32' && param.val == null)) &&
      valTypeOf(node) === VAL.BOOL)
    return carrierF64(node, ir)
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
  return padArgs(argNodes.map((a, k) => coerceArg(emit(a), params[k], a)), params)
}

/** Fuse `a + b` when it tops a string-concat chain of ≥3 leaves: evaluate
 *  each leaf ONCE to an i64 string box (left-to-right — JS ToString order),
 *  measure each with __str_byteLen, allocate the [hash=0][len][bytes]
 *  HCACHE header once, and __str_copy each leaf at its cumulative offset.
 *  Replaces the pairwise lowering's per-`+` alloc + triangular prefix
 *  re-copy. Self-accumulation (`line = line + …`) keeps the head pairwise:
 *  the TAIL fuses to one fresh string and the head takes the existing
 *  bump-extend concatRaw. A total ≤ 6 yields a short HEAP string where
 *  pairwise gave SSO — value-equal (SSO is representation, not semantics). */
function tryConcatChain(a, b, selfAccum) {
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
  inc('__alloc', '__mkptr', '__sso_norm')
  // LITERAL ASCII leaves (the serializer separators — ',', '\n', 'k=' …) carry
  // their bytes and length at compile time: no box/len temps, no __str_byteLen,
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
    // __str_byteLen and __str_copy — the whole temp-string round trip.
    if ((vt === VAL.NUMBER || vt == null) && v.type === 'i32' && v.ptrKind == null) {
      inc('__ilen', '__itoa_s')
      nT[k] = tempI32('cn')
      seq.push(['local.set', `$${nT[k]}`, v])
      seq.push(['local.set', `$${lT[k]}`, ['call', '$__ilen', ['local.get', `$${nT[k]}`]]])
      return
    }
    inc('__str_byteLen', '__str_copy')
    bT[k] = tempI64('cc')
    seq.push(['local.set', `$${bT[k]}`,
      vt === VAL.STRING ? ['i64.reinterpret_f64', asF64(v)] :
      vt === VAL.BOOL ? ['i64.reinterpret_f64', emitBoolStr(n)] :
      toStrI64(n, v)])   // OBJECT (compile-time ToPrimitive), NUMBER, unknown
    seq.push(['local.set', `$${lT[k]}`, ['call', '$__str_byteLen', ['local.get', `$${bT[k]}`]]])
  })
  const totalIR = () => {
    let t = ['i32.const', litTotal]
    for (let k = 0; k < leaves.length; k++) if (lT[k] != null) t = ['i32.add', t, ['local.get', `$${lT[k]}`]]
    return t
  }
  seq.push(['local.set', `$${offT}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], totalIR()]]])
  seq.push(['i32.store', ['local.get', `$${offT}`], ['i32.const', 0]])                       // lazy hash cell
  seq.push(['i32.store', 'offset=4', ['local.get', `$${offT}`], totalIR()])                  // len
  seq.push(['local.set', `$${offT}`, ['i32.add', ['local.get', `$${offT}`], ['i32.const', 8]]])
  seq.push(['local.set', `$${curT}`, ['local.get', `$${offT}`]])
  leaves.forEach((n, k) => {
    if (lits[k] != null) {
      const s = lits[k]
      let j = 0    // grouped little-endian stores: 4-byte words, 2-byte tail, then 1
      const at = (o) => o ? [`offset=${o}`, ['local.get', `$${curT}`]] : [['local.get', `$${curT}`]]
      for (; j + 4 <= s.length; j += 4)
        seq.push(['i32.store', ...at(j), ['i32.const',
          (s.charCodeAt(j) | (s.charCodeAt(j + 1) << 8) | (s.charCodeAt(j + 2) << 16) | (s.charCodeAt(j + 3) << 24)) | 0]])
      if (j + 2 <= s.length) {
        seq.push(['i32.store16', ...at(j), ['i32.const', s.charCodeAt(j) | (s.charCodeAt(j + 1) << 8)]])
        j += 2
      }
      if (j < s.length)
        seq.push(['i32.store8', ...at(j), ['i32.const', s.charCodeAt(j)]])
      if (k < leaves.length - 1)
        seq.push(['local.set', `$${curT}`, ['i32.add', ['local.get', `$${curT}`], ['i32.const', s.length]]])
      return
    }
    if (nT[k] != null) {
      // digits render at the cursor; the returned byte count (== $lT) advances it
      seq.push(k < leaves.length - 1
        ? ['local.set', `$${curT}`, ['i32.add',
            ['call', '$__itoa_s', ['local.get', `$${nT[k]}`], ['local.get', `$${curT}`]], ['local.get', `$${curT}`]]]
        : ['drop', ['call', '$__itoa_s', ['local.get', `$${nT[k]}`], ['local.get', `$${curT}`]]])
      return
    }
    seq.push(['call', '$__str_copy', ['local.get', `$${bT[k]}`], ['local.get', `$${curT}`], ['local.get', `$${lT[k]}`]])
    if (k < leaves.length - 1)
      seq.push(['local.set', `$${curT}`, ['i32.add', ['local.get', `$${curT}`], ['local.get', `$${lT[k]}`]]])
  })
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

/** Guarded dispatch to a speculative typed clone (narrow's speculateTypedParams).
 *  Args evaluate once, in order, into temps; a single masked NaN-box compare per
 *  speculated position proves tag==TYPED && aux==elem-kind (owned — a view or any
 *  other value falls to the original call unchanged, bit-exact). TYPED headers
 *  never relocate (FORWARDING_MASK), so the proven offset is a bare mask — the
 *  same inlining emitSchemaSlotGuarded does for OBJECT. */
const TYPED_HI_MASK = '0xFFFFFFFF00000000'
function emitSpeculativeCall(callee, spec, argNodes, func) {
  const params = func.sig.params
  const specAt = new Map(spec.guards.map(g => [g.k, g.aux]))
  const rt = func.sig.results[0] || 'f64'
  const seq = [], slots = []
  for (let k = 0; k < params.length; k++) {
    if (k < argNodes.length) {
      const ir = coerceArg(emit(argNodes[k]), params[k], argNodes[k])
      // Temp width follows the PARAM's ABI (coerceArg's contract), not the IR
      // tag — pointer-ABI coercions (`__ptr_offset`) come back untagged i32.
      const pt = params[k].ptrKind != null || params[k].type === 'i32' ? 'i32' : 'f64'
      const t = pt === 'i32' ? tempI32('sa') : temp('sa')
      seq.push(['local.set', `$${t}`, ir])
      slots.push({ local: t, type: pt })
    } else {
      slots.push(null)  // arity pad — fresh per use below
    }
  }
  const get = (k) => slots[k]
    ? typed(['local.get', `$${slots[k].local}`], slots[k].type)
    : params[k].type === 'i32' ? typed(['i32.const', 0], 'i32') : undefExpr()
  let cond = null
  for (const [k, aux] of specAt) {
    const c = ['i64.eq',
      ['i64.and', ['i64.reinterpret_f64', get(k)], ['i64.const', TYPED_HI_MASK]],
      ['i64.const', i64Hex(BigInt(encodePtrHi(PTR.TYPED, aux)) << 32n)]]
    cond = cond ? ['i32.and', cond, c] : c
  }
  const thenArgs = params.map((p, k) => specAt.has(k)
    ? ['i32.wrap_i64', ['i64.and', ['i64.reinterpret_f64', get(k)], ['i64.const', LAYOUT.OFFSET_MASK]]]
    : get(k))
  const elseArgs = params.map((p, k) => get(k))
  const ifIR = ['if', ['result', rt], cond,
    ['then', ['call', `$${spec.clone}`, ...thenArgs]],
    ['else', ['call', `$${callee}`, ...elseArgs]]]
  return attachSigMeta(typed(['block', ['result', rt], ...seq, ifIR], rt), func.sig)
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
      // An i32-typed local (a narrowed integer index feeder) can't hold the f64
      // NaN-box undef sentinel — and wasm zero-inits locals anyway, so a 0 init is
      // equivalent for the assigned-before-read pattern that earns i32.
      result.push(['local.set', `$${i}`, ctx.func.locals.get(i) === 'i32' ? ['i32.const', 0] : undef])
      continue
    }
    if (!Array.isArray(i) || i[0] !== '=') continue
    const [, name, init] = i
    if (typeof name !== 'string' || init == null) continue
    // Flag bindings initialized to a nullish literal so arithmetic on them coerces (null→0,
    // undefined→NaN) rather than propagating the raw sentinel. See toNumF64 / maybeNullish.
    if (isNullishLit(init)) ctx.func.maybeNullish?.add(name)

    // SRoA flat object: `let o = {a:1, b:2}` — dissolve fields into `o#i`
    // locals, no heap alloc. Each field local ← asF64(value). Reads/writes are
    // rewritten by the `.`/`[]` flat hooks. See scanFlatObjects (analyze.js).
    // Monotonic-extension fields (`o.newProp = …`) carry no literal value —
    // they init to undefined so a read before the write matches JS.
    const flatDecl = ctx.func.flatObjects?.get(name)
    if (flatDecl && Array.isArray(init) && (init[0] === '{}' || init[0] === '[' || init[0] === '[]')) {
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
    setFlowVal(name, valTypeOf(init))
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
      // NOTE: a dispatch-site arg lattice (argc/numeric row merged into the element
      // bodies' paramTypes/minArgc, killing their boxed-arg guards) was BUILT and
      // REVERTED here: prepare-time folds erase element reads (`let p = ops[1]`
      // pre-evals to the closure ref before program facts see the '[]' shape), so
      // no AST-level gate can prove the tagged sites are the only callers — the
      // trusted body then truncates raw box bits on a string arg through the alias
      // (see test/closures.js "element-as-value alias and arity variance stay
      // exact", which records the pre-existing string-coercion gap). Bodies keep
      // their guards; the arm-inline + watr trunc∘convert identities still
      // collapse the provably-int side.
      if (val.fnElements && ctx.scope.consts?.has(name))
        (ctx.scope.constFnArrays ||= new Map()).set(name, val.fnElements)
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
        // Poisoned names (shape-disagreeing assignments) must stay schema-free.
        if (val.ptrKind === VAL.OBJECT && !ctx.schema.vars?.has(name) && !ctx.schema.poisoned?.has(name)) {
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
    } else if (localType === 'i32' && val.type !== 'i32' && isI32ArithTree(init)) {
      // Integer index feeder (`let idx = py*W + qx`) bound to an i32 local: compute
      // it in native wrapping i32 instead of the f64 round-trip + trunc_sat. Bit-
      // identical for an i32 destination (ToInt32 ≡ two's-complement wrap), and the
      // i32.mul is hoistable when loop-invariant. Falls back to toI32 defensively.
      coerced = tryI32Index(init) ?? toI32(val)
    } else {
      coerced = localType === 'v128' ? val : localType === 'f64' ? asF64(val) : val.type === 'i32' ? val : toI32(val)
    }
    // `let x = 0` at function scope is normally elided — WASM zero-inits locals. But loop
    // unrolling flattens iteration bodies into one scope, so the 2nd+ `let x = 0` are
    // genuine RE-inits between iterations (e.g. a nested reduce's accumulator). Elide only
    // the FIRST per name; emit the rest as resets. (Names are preserved — no renaming.)
    const zeroInit = isLit(coerced) && coerced[1] === 0 && !Object.is(coerced[1], -0) && !ctx.func.stack.length
    if (!zeroInit || ctx.func.zeroInitSeen?.has(name))
      result.push(['local.set', `$${name}`, coerced])
    else (ctx.func.zeroInitSeen ??= new Set()).add(name)

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
    // When the source is statically known to be a typed array, __typed_idx suffices.
    // Otherwise (STRING, or unknown type whose runtime value may be a string) dispatch on
    // ptr_type: STRING→__str_idx, else→__typed_idx.
    // The old gate (ctx.module.modules['string']) was wrong: for `[...s]` with an untyped
    // param the string module is never loaded, so __typed_idx was used for strings —
    // __typed_idx calls __len which returns 0 for strings, making i>=len always true and
    // storing UNDEF into every element slot. Pull in the string module here so __str_idx
    // is registered before inc() adds it to the dependency set.
    const elem = staticVT === VAL.TYPED
      ? (inc('__typed_idx'), ['call', '$__typed_idx', srcI64(), ['local.get', `$${sidx}`]])
      : (includeForStringOnly(),
        ['if', ['result', 'f64'],
          ['i32.eq', ['call', '$__ptr_type', srcI64()], ['i32.const', PTR.STRING]],
          ['then', (inc('__str_idx'), ['call', '$__str_idx', srcI64(), ['local.get', `$${sidx}`]])],
          ['else', (inc('__typed_idx'), ['call', '$__typed_idx', srcI64(), ['local.get', `$${sidx}`]])]
        ])
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
      // Cache the source length once per spread (reused for the total-len sum and the
      // copy). `__len` is ARRAY/typed length — WRONG for a STRING (returns 0, so `[...str]`
      // spreads an empty array). Pick the length to MATCH emitSpreadCopy's element decode:
      // a known string counts chars (__str_len, paired with the __str_idx per-char copy); a
      // statically-unknown source — `[...x]` / `[...fnParam]`, the compiler's own
      // `[...key]` — dispatches once at runtime (STRING→__str_len, else→__len), mirroring
      // emitSpreadCopy's ARRAY-vs-scalar branch. (Not __length: its `off>=8` guard returns
      // undefined for host/static typed arrays.) Known array/typed/multi keep plain __len.
      const srcI64 = () => ['i64.reinterpret_f64', ['local.get', `$${sec.local}`]]
      const lenIR = sec.val === VAL.STRING
        ? (inc('__str_len'), ['call', '$__str_len', srcI64()])
        : (sec.val === VAL.ARRAY || sec.val === VAL.TYPED || n)
          ? (inc('__len'), ['call', '$__len', srcI64()])
          : (inc('__str_len', '__len', '__ptr_type'),
            ['if', ['result', 'i32'],
              ['i32.eq', ['call', '$__ptr_type', srcI64()], ['i32.const', PTR.STRING]],
              ['then', ['call', '$__str_len', srcI64()]],
              ['else', ['call', '$__len', srcI64()]]])
      ir.push(['local.set', `$${sec.lenLocal}`, lenIR])
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

// Record a name's valTypeOf(rhs) fact into the live localValTypesOverlay layer (tier #2
// in reps.js's lookup priority — see lookupValType). `let`/`const` decls record this
// themselves at their emit site (emitDecl, right after each `emit(init)`); this helper
// covers the remaining case emitBlockBody drives directly: a bare `name = rhs`
// reassignment statement.
function setFlowVal(name, vt) {
  if (!ctx.func.localValTypesOverlay || !isBoundName(name)) return
  // A name reassigned at any NESTED position of the current block (inside an
  // if/loop/closure body, a for's step, …) carries NO overlay fact: the recording
  // site doesn't dominate the reassignment, so the fact can go stale while the
  // binding is live — `let x = [7,8]; if (c) x = 5; x.length` read the number 5
  // through the ARRAY fast path (OOB): a latent pre-existing miscompile, widened
  // when decl recording moved into emitDecl and began covering for-init decls
  // (`for (let x = […]; x.length; x = 0)`). Top-level `=` statements stay
  // recordable — the block driver re-records at each, so the fact always
  // reflects the latest dominating write.
  if (ctx.func.flowValBlocked?.has(name)) return
  if (vt) ctx.func.localValTypesOverlay.set(name, vt)
  else ctx.func.localValTypesOverlay.delete(name)
}

// Names assigned at a NESTED position within this block's statements: anything
// except top-level `name = rhs` statement heads and top-level decl heads (both
// re-recorded by the emit drivers as they pass). Walks into closures too — a
// closure assigning an outer name can run between the recording and any later
// read. ++/-- count as assignments (conservative: their result is numeric, but
// blocking keeps the rule uniform).
function collectNestedAssigns(stmts) {
  const blocked = new Set()
  const walk = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    // A decl's `['=', name, init]` pairs are DECLARATIONS, not reassignments
    // (same as isReassigned's let/const handling) — a nested `for (let x = …)`
    // init must not block x; only a true write in cond/step/body does.
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=' && d[2] != null) walk(d[2])
      }
      return
    }
    if ((ASSIGN_OPS.has(op) || op === '++' || op === '--') && typeof n[1] === 'string') blocked.add(n[1])
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  for (const s of stmts) {
    if (!Array.isArray(s)) continue
    const op = s[0]
    if (op === '=' && typeof s[1] === 'string') { walk(s[2]); continue }   // top-level target re-records
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < s.length; i++) {
        const d = s[i]
        if (Array.isArray(d) && d[0] === '=' && d[2] != null) walk(d[2])   // decl head re-records; walk init
      }
      continue
    }
    walk(s)
  }
  return blocked
}

/** Emit block body as flat list of WASM instructions. Unwraps {} and delegates to emitVoid per statement.
 *  Also drives early-return refinement: `if (!guard) return/throw` narrows `guard` for the
 *  rest of the enclosing block. Refinements added here are rolled back on block exit. */
export function emitBlockBody(node) {
  const inner = node[1]
  const stmts = Array.isArray(inner) && inner[0] === ';' ? inner.slice(1) : [inner]
  const out = []
  const accumulated = []
  const prevValOverlay = ctx.func.localValTypesOverlay
  ctx.func.localValTypesOverlay = new Map(prevValOverlay || [])
  // Nested-assignment blocklist for this block. Per-block own-scan is sufficient:
  // an outer name whose fact was blocked in the outer block never entered the
  // outer overlay (which this block's overlay copies), and a name reassigned at
  // THIS block's top level re-records right after the assignment (dominating the
  // rest of this block) — the scan blocks exactly the recordings that don't
  // dominate their possible staleness point.
  const prevFlowBlocked = ctx.func.flowValBlocked
  ctx.func.flowValBlocked = collectNestedAssigns(stmts)
  try {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i]
      if (s == null || typeof s === 'number') continue
      out.push(...emitVoid(s))
      // `let`/`const` decls self-record via emitDecl; only a bare reassignment needs it here.
      if (Array.isArray(s) && s[0] === '=' && typeof s[1] === 'string') setFlowVal(s[1], valTypeOf(s[2]))
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
  } finally {
    ctx.func.localValTypesOverlay = prevValOverlay
    ctx.func.flowValBlocked = prevFlowBlocked
    // Restore prior refinements on block exit.
    for (let i = accumulated.length - 1; i >= 0; i--) {
      const [name, prev] = accumulated[i]
      if (prev === undefined) ctx.func.refinements.delete(name); else ctx.func.refinements.set(name, prev)
    }
  }
  return out
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
const nullableOperand = (n) => {
  if (typeof n === 'string') return !!(repOf(n)?.nullable || repOfGlobal(n)?.nullable)
  if (Array.isArray(n) && n[0] === '[]' && n.length === 3
      && typeof n[1] === 'string' && lookupValType(n[1]) === VAL.TYPED)
    return !typedIdxProven(n[1], n[2])
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
const SIDE_EFFECT_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '>>=', '<<=',
  '>>>=', '||=', '&&=', '??=', '++', '--', '()', '=>', 'throw', 'new', 'await', 'yield'])
const isSideEffectFree = (n) => {
  if (!Array.isArray(n)) return true
  if (typeof n[0] === 'string' && SIDE_EFFECT_OPS.has(n[0])) return false
  for (let i = 1; i < n.length; i++) if (!isSideEffectFree(n[i])) return false
  return true
}

const isLit1 = (n) => Array.isArray(n) && n[0] == null && n[1] === 1
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

function emitLooseEq(a, b, negate) {
  const eqOp = negate ? 'ne' : 'eq'
  const sentinel = emitNum(negate ? 1 : 0)
  const charCmp = emitSingleCharIndexCmp(a, b, negate); if (charCmp) return charCmp
  const subCmp = emitSubstringEqCmp(a, b, negate); if (subCmp) return subCmp
  // JS loose nullish equality: x == null / x == undefined.
  // If the non-literal side has a known non-null VAL type, fold to the sentinel.
  const nullishOf = (other) => {
    if (valTypeOf(other) && !nullableOperand(other)) return sentinel
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
  if (vta === VAL.NUMBER && needsToNumberCoercion(b, vtb)) return looseNumberEq(numA(), b, vb, negate)
  if (vtb === VAL.NUMBER && needsToNumberCoercion(a, vta)) return looseNumberEq(numB(), a, va, negate)
  if (vta === VAL.NUMBER || vtb === VAL.NUMBER) return typed([`f64.${eqOp}`, numA(), numB()], 'i32')
  // Reference-equal pointer kinds (same kind, non-STRING, non-BIGINT): i64 bit equality.
  // JS `==` on objects/arrays/sets/maps/etc. is pure reference equality — no content path.
  // STRING needs __eq (heap strings can be equal by content but different pointers).
  // BIGINT needs __eq (heap-allocated, content compare).
  if (vta && vta === vtb && REF_EQ_KINDS.has(vta)) {
    return typed([`i64.${eqOp}`, ['i64.reinterpret_f64', asF64(va)], ['i64.reinterpret_f64', asF64(vb)]], 'i32')
  }
  // String-equality specialization — the hot `node[0] === 'literal'` AST-tag dispatch,
  // the compiler's single most-emitted comparison (5579 of its 6487 __eq sites). When one
  // side is statically a STRING, skip the generic __eq NaN-box dispatch (the #1 self-host
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
    if (valTypeOf(other) && !nullableOperand(other)) return emitNum(negate ? 1 : 0)
    const chk = (undef ? isUndef : isNull)(asF64(emit(other)))
    return negate ? typed(['i32.eqz', chk], 'i32') : chk
  }
  const sa = sentinelOf(a), sb = sentinelOf(b)
  if (sb) return strictSentinel(a, sb === 'undef')
  if (sa) return strictSentinel(b, sa === 'undef')
  // Known, differing primitive classes can never be strictly equal.
  const strictA = resolveValType(a, valTypeOf, lookupValType)
  const strictB = resolveValType(b, valTypeOf, lookupValType)
  if (strictA && strictB && strictA !== strictB && (STRICT_PRIM.has(strictA) || STRICT_PRIM.has(strictB)))
    return emitNum(negate ? 1 : 0)
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
    const va = strictA === VAL.BOOL ? carrierF64(a, emit(a)) : asF64(emit(a))
    const vb = strictB === VAL.BOOL ? carrierF64(b, emit(b)) : asF64(emit(b))
    const cmp = typed(['i64.eq', ['i64.reinterpret_f64', va], ['i64.reinterpret_f64', vb]], 'i32')
    return negate ? typed(['i32.eqz', cmp], 'i32') : cmp
  }
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
    // Literal-mixed compare is MATHEMATICAL per spec (BigInt vs Number) — 5n > 3
    // must not compare raw NaN-box bits. Coerce through f64 (exact for literal
    // magnitudes); an unknown counterpart keeps the same-rep i64 contract
    // (kernel carriers' NUMBER is a kind-default, not a proof).
    if ((vta === VAL.BIGINT) !== (vtb === VAL.BIGINT) && numLiteralNode(vta === VAL.BIGINT ? b : a)) {
      const conv = (node, v, isBig) => isBig
        ? typed([bigintUnsignedBound(node) ? 'f64.convert_i64_u' : 'f64.convert_i64_s', asI64(v)], 'f64')
        : toNumF64(node, asF64(v))
      return typed([`f64.${f64op}`, conv(a, va, vta === VAL.BIGINT), conv(b, vb, vtb === VAL.BIGINT)], 'i32')
    }
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

function emitAsValue(fn) {
  const prev = ctx.func._expect
  ctx.func._expect = null
  try { return fn() }
  finally { ctx.func._expect = prev }
}

function emitSingleSpreadMethodCall(objArg, parsed, method, methodEmitter) {
  const inPlace = SPREAD_MUTATORS.has(method)
  // unshift prepends each arg to the front — forward iteration reverses intent.
  const reverse = method === 'unshift'
  const acc = `${T}acc${ctx.func.uniq++}`
  ctx.func.locals.set(acc, 'f64')
  const ir = [['local.set', `$${acc}`, asF64(emit(objArg))]]
  if (reverse) {
    // unshift(a, b, ...s): ES yields [a, b, ...s, ...existing]. Per-element
    // PREPENDS must run right-to-left over the WHOLE argument list — spread
    // elements first (end→start), the normal args last — or the spread lands
    // in front of the normals ([...s, a, b, ...] — the order bug that broke
    // the kernel's own `inject.unshift(setBase, ...stores)`). Argument
    // EVALUATION order stays left-to-right: normals spill to temps first.
    const temps = parsed.normal.map((a) => {
      const t = `${T}usv${ctx.func.uniq++}`
      ctx.func.locals.set(t, 'f64')
      ir.push(['local.set', `$${t}`, asF64(emitAsValue(() => emit(a)))])
      return t
    })
    ir.push(...emitSpreadElementLoop(parsed.spreads[0].expr, (arr, idx) => {
      const body = asF64(emitAsValue(() => methodEmitter(objArg, ['[]', arr, idx])))
      return [['drop', body]]
    }, { reverse: true }))
    if (temps.length) ir.push(['drop', asF64(emitAsValue(() => methodEmitter(objArg, ...temps)))])
    ir.push(asF64(emit(objArg)))
    return block64(...ir)
  }
  if (parsed.normal.length > 0) {
    const r = asF64(emitAsValue(() => methodEmitter(objArg, ...parsed.normal)))
    ir.push(inPlace ? ['drop', r] : ['local.set', `$${acc}`, r])
  }
  ir.push(...emitSpreadElementLoop(parsed.spreads[0].expr, (arr, idx) => {
    const body = asF64(emitAsValue(() => methodEmitter(inPlace ? objArg : acc, ['[]', arr, idx])))
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
  if (method === 'unshift') {
    // Prepends compose right-to-left (see emitSingleSpreadMethodCall's reverse
    // arm). Evaluation order stays left-to-right: spill every segment first —
    // normal args to value temps, each spread's source array to a temp — then
    // walk the segments END→START, spreads iterating end→start, each normal
    // batch prepended through the multi-arg emitter (which lands its own args
    // in argument order).
    const segs = []
    for (const item of combined) {
      if (Array.isArray(item) && item[0] === '__spread') {
        const t = `${T}ussp${ctx.func.uniq++}`
        ctx.func.locals.set(t, 'f64')
        ir.push(['local.set', `$${t}`, asF64(emitAsValue(() => emit(item[1])))])
        segs.push(['spread', t])
      } else {
        const t = `${T}usv${ctx.func.uniq++}`
        ctx.func.locals.set(t, 'f64')
        ir.push(['local.set', `$${t}`, asF64(emitAsValue(() => emit(item)))])
        if (segs.length && segs[segs.length - 1][0] === 'batch') segs[segs.length - 1].push(t)
        else segs.push(['batch', t])
      }
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const [kind, ...temps] = segs[i]
      if (kind === 'spread') {
        ir.push(...emitSpreadElementLoop(temps[0], (arr, idx) => {
          const body = asF64(emitAsValue(() => methodEmitter(objArg, ['[]', arr, idx])))
          return [['drop', body]]
        }, { reverse: true }))
      } else {
        ir.push(['drop', asF64(emitAsValue(() => methodEmitter(objArg, ...temps)))])
      }
    }
    ir.push(asF64(emit(objArg)))
    return block64(...ir)
  }
  let batch = []
  const flushBatch = () => {
    if (!batch.length) return
    const r = asF64(emitAsValue(() => methodEmitter(recv, ...batch)))
    ir.push(inPlace ? ['drop', r] : ['local.set', `$${acc}`, r])
    batch = []
  }
  for (const item of combined) {
    if (Array.isArray(item) && item[0] === '__spread') {
      flushBatch()
      ir.push(...emitSpreadElementLoop(item[1], (arr, idx) => {
        const body = asF64(emitAsValue(() => methodEmitter(recv, ['[]', arr, idx])))
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
  // asF64 on the taken arm: the continuation may come back i32-narrowed (an
  // int-certain slot read at O0 kept its raw i32), and the f64-typed if would
  // fail validation ("type error in fallthru: expected f64, got i32").
  return block64(
    ['local.set', `$${t}`, headExpr],
    ['if', ['result', 'f64'],
      ['i32.eqz', isNullish(['local.get', `$${t}`])],
      ['then', asF64(body(t))],
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
      asF64(recv), asI32(emit(parsed.normal[0])), ctx, false, true), 'i32')
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
      // Drop extras like the plain-call path (emit.js regular-call arm): the dyn
      // closure ABI absorbed over-arity (`parse.enter?.(p, end)` on a 0-param
      // hook), but a devirtualized direct call pushes exactly sig arity — extras
      // would be stack leftovers (asi.js's parse.enter broke the self-host here).
      if (emittedArgs.length > func.sig.params.length) emittedArgs.length = func.sig.params.length
      return attachSigMeta(typed(['call', `$${fname}`, ...emittedArgs], func.sig.results[0]), func.sig)
    }
  }
}

const LEADING_STRATEGIES = [tryFlatObjectMethod, tryCharCodeAtFast, trySpliceInsert, tryFnPropCall]

// Strategies 5–12 share the receiver's resolved value type and the
// `callMethod` shim — packaged once into a dispatch-context record `c` =
// `{ obj, method, parsed, vt, callMethod }` so each strategy is a named
// function in TYPED_STRATEGIES, same first-match-wins contract as
// LEADING_STRATEGIES. The last entry (external fallback) is total.

// 5. Boxed object: delegate method to inner value (slot 0)
function tryBoxedDelegate({ obj, method, callMethod }) {
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
}

// 6. valueOf/toString are ToPrimitive hooks (ES2024 7.1.1) that an own data
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
function trySidecarToPrimitive({ obj, method, parsed, vt, callMethod }) {
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
}

// 7. Known type → static dispatch
function tryStaticDispatch({ obj, method, vt, callMethod }) {
  if (vt && ctx.core.emit[`.${vt}:${method}`]) {
    return callMethod(obj, ctx.core.emit[`.${vt}:${method}`])
  }
}

// 8. Unknown / guessed-array type, both string + generic exist → runtime dispatch by ptr type.
// analyze.js defaults untyped `.slice()` results to VAL.ARRAY, which is a guess, not a proof;
// runtime dispatch resolves whether the operand is actually a string or an array.
// Concretely-typed non-string values (BUFFER, TYPED, MAP, …) fall through to the generic
// emitter which already knows how to handle them.
function tryRuntimeStringFork({ obj, method, vt, callMethod }) {
  const strKey = `.string:${method}`, genKey = `.${method}`
  // VAL.ARRAY is structurally incompatible with PTR.STRING — no fork needed.
  // Only fork when vt is truly unknown (!vt), not for proven types.
  if (!vt && ctx.core.emit[strKey] && ctx.core.emit[genKey]) {
    const t = `${T}rt${ctx.func.uniq++}`, tt = `${T}rtt${ctx.func.uniq++}`
    ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(tt, 'i32')
    const strEmitter = ctx.core.emit[strKey]
    const genEmitter = ctx.core.emit[genKey]
    // A string/array method is only valid on a NaN-boxed pointer (string/array/…).
    // `f64.eq(t,t)` is true only for a non-NaN value, so guard the dispatch with
    // it. A plain-number receiver dispatches the `.number:` emitter when the
    // method has one (`x.toString(16)` on an untyped x — the kernel-L2 ratchet's
    // data-segment corruption root: this used to yield `undefined`, and
    // `'\\' + undefined.padStart(2,'0')` collapsed every escaped byte to \\00);
    // methods numbers don't have keep yielding `undefined` (spec: `(5).indexOf`
    // is undefined) instead of feeding number bits to `__ptr_type` → OOB.
    // Every NaN-boxed receiver still reaches the string-vs-generic fork unchanged.
    const numEmitter = ctx.core.emit[`.number:${method}`]
    return block64(
      ['local.set', `$${t}`, asF64(emit(obj))],
      ['if', ['result', 'f64'],
        ['f64.eq', ['local.get', `$${t}`], ['local.get', `$${t}`]],
        ['then', numEmitter ? asF64(callMethod(t, numEmitter)) : undefExpr()],
        ['else', block64(
          ['local.set', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
          ['if', ['result', 'f64'],
            ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.STRING]],
            ['then', callMethod(t, strEmitter)],
            ['else', callMethod(t, genEmitter)]])]])
  }
}

// 8b. Number-only method (toFixed/toPrecision/toExponential/toString-with-radix
// when no string fork applies) on an untyped receiver: a runtime number check
// routes to the `.number:` emitter; a NaN-boxed receiver probes the dynamic-prop
// sidecar (a user's own `.toFixed` closure must win — ES own-property shadowing)
// and otherwise yields `undefined`, the same result the dynamic path produced.
function tryRuntimeNumberMethod({ obj, method, parsed, vt, callMethod }) {
  const numEmitter = ctx.core.emit[`.number:${method}`]
  if (vt || !numEmitter || parsed.hasSpread || !ctx.closure.call) return
  const t = `${T}rn${ctx.func.uniq++}`
  ctx.func.locals.set(t, 'f64')
  return block64(
    ['local.set', `$${t}`, asF64(emit(obj))],
    ['if', ['result', 'f64'],
      ['f64.eq', ['local.get', `$${t}`], ['local.get', `$${t}`]],
      ['then', asF64(callMethod(t, numEmitter))],
      ['else', sidecarOverride(typed(['local.get', `$${t}`], 'f64'), asI64(emit(['str', method])),
        (p) => ctx.closure.call(typed(['local.get', `$${p}`], 'f64'), parsed.normal),
        () => undefExpr())]])
}

// 9. Schema property closure call: `x.prop(args)` where prop is a closure slot in
// x's schema. Boxed schemas don't currently support spread callers (each box
// hands the inner value through), so spread is restricted to the non-boxed path.
function trySchemaClosureCall({ obj, method, parsed }) {
  if (typeof obj === 'string' && ctx.schema.slotOf && ctx.closure.call) {
    const idx = ctx.schema.slotOf(obj, method)
    if (idx >= 0) {
      const propRead = typed(ctx.abi.object.ops.load(ptrOffsetIR(asF64(emit(obj)), lookupValType(obj) || VAL.OBJECT), idx), 'f64')
      if (parsed.hasSpread && !ctx.schema.isBoxed?.(obj)) {
        const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
        return ctx.closure.call(propRead, [buildArrayWithSpreads(combined)], true)
      }
      return ctx.closure.call(propRead, parsed.normal)
    }
  }
}

// 10. Generic only — but a collection emitter (`.get`/`.set`/`.has`/`.add`/
// `.delete`) assumes a Map/Set receiver: a proven collection already
// dispatched via `.${vt}:${method}` above, so reaching here means the
// receiver is not a proven collection. A zero-arg call then cannot be the
// collection op (each needs ≥1 key/value arg) — it is a user/closure
// method (e.g. `new C().get()`). Skip the collection emitter so it falls
// through to closure/dynamic dispatch instead of crashing on `emit(key)`.
function tryGenericEmitter({ obj, method, parsed, vt, callMethod }) {
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
  // builtins — `ctx.schema.slotOf(o,p)`, `node.map(...)`, `s.get(k)` — dispatch
  // correctly instead of being hijacked by `Array.prototype.{find,map,…}`.
  const objectShadow = vt === VAL.OBJECT || vt === VAL.HASH
  if (ctx.core.emit[`.${method}`] && !collectionMisfit && !strIndexMisfit && !objectShadow) {
    // Statically-UNKNOWN receiver: an OWN property named like the builtin shadows it
    // (ES prototype semantics) — the runtime analogue of `objectShadow` above. Without
    // this fork, subscript's `d.map(a)` descriptor mapper (or any user method colliding
    // with Array.prototype names) is hijacked by the builtin and reads array layout off
    // an object. Probe the dyn-prop sidecar: own closure wins, else the builtin runs —
    // emitted ONCE (the builtin bodies are large inline emitters; a dual-arm emission
    // doubled closure-heavy golden sizes). __dyn_get_expr guards real-number receivers
    // itself, so no f===f pre-fork is needed. Gated on the string module (the probe key
    // is a string literal): a string-less program has no user string props to shadow.
    if (vt == null && ctx.closure.call && !parsed.hasSpread && ctx.core.emit.str) {
      // HOISTED override probe: for a stable module-global receiver (the same
      // proof as charCodeAt shape-1b — never assigned in this function, and the
      // body's only calls are .charCodeAt, so nothing that runs here can change
      // the receiver or its props), the probe's answer is loop-invariant.
      // Register a per-(receiver, method) entry-prologue probe (drained by
      // collectParamInits) and reduce the per-site cost to one predictable
      // branch on the cached i32 + the lean builtin arm. jessie's space paid
      // the full 3-frame probe per CHARACTER without this.
      if (typeof obj === 'string' && ctx.func.charDecompGlobals && isGlobal(obj)
          && ctx.func.body && !isReassigned(ctx.func.body, obj) && bodyOnlyCharCodeAtCalls(ctx.func.body)) {
        const key = `${obj}#${method}`
        let ph = (ctx.func.probeHoist ??= new Map()).get(key)
        if (!ph) {
          const ovr = `${obj}$ovr$${method}`, is = `${obj}$ovrIs$${method}`
          ctx.func.locals.set(ovr, 'f64')
          ctx.func.locals.set(is, 'i32')
          inc('__dyn_get_expr', '__ptr_type')
          ph = { ovr, is, recvIR: () => asF64(emit(obj)), keyIR: () => asI64(emit(['str', method])) }
          ctx.func.probeHoist.set(key, ph)
        }
        return typed(['if', ['result', 'f64'], ['local.get', `$${ph.is}`],
          ['then', ctx.closure.call(typed(['local.get', `$${ph.ovr}`], 'f64'), parsed.normal)],
          ['else', asF64(callMethod(obj, ctx.core.emit[`.${method}`]))]], 'f64')
      }
      // Fallback arm: a bare-name receiver re-references the ORIGINAL binding
      // (variable reads are pure) instead of the probe's spilled temp — so a
      // module-global string receiver reaches the ABI op as `global.get` and
      // the charCodeAt shape-1b entry decomposition can fire (the layered-
      // parser `cur.charCodeAt(idx)` hot shape; a local temp would hide it).
      return sidecarOverride(emit(obj), asI64(emit(['str', method])),
        (p) => ctx.closure.call(typed(['local.get', `$${p}`], 'f64'), parsed.normal),
        (o) => asF64(callMethod(typeof obj === 'string' ? obj : o, ctx.core.emit[`.${method}`])))
    }
    return callMethod(obj, ctx.core.emit[`.${method}`])
  }
}

// 11. Dynamic property function call on non-external values. Two emission shapes:
// (1) closure-only fork — receiver carries no PTR.EXTERNAL (sidecar-bearing static
//     types OR wasi target, where __ext_call doesn't exist); and (2) full fork
//     adding a PTR.EXTERNAL → __ext_call leg for opaque js receivers.
function tryDynamicPropCall({ obj, method, parsed, vt }) {
  if (ctx.closure.call) {
    if (ctx.transform.strict)
      err(`strict mode: method call \`${typeof obj === 'string' ? obj : '<expr>'}.${method}(...)\` on a value of unknown type pulls dynamic dispatch stdlib. Annotate the receiver type or pass { strict: false }.`)
    const objTmp = temp('mobj')
    const propTmp = temp('mprop')
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const arrayIR = buildArrayWithSpreads(combined)
    // Primitive receivers skip the override probe — see sidecarOverride (ir.js).
    const propRead = typed(['if', ['result', 'f64'],
      ['i32.and',
        ['f64.ne', ['local.get', `$${objTmp}`], ['local.get', `$${objTmp}`]],
        ['i64.ne',
          ['i64.and', ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]], ['i64.const', i64Hex(BigInt(LAYOUT.TAG_MASK) << BigInt(LAYOUT.TAG_SHIFT))]],
          ['i64.const', i64Hex(BigInt(PTR.STRING) << BigInt(LAYOUT.TAG_SHIFT))]]],
      ['then', ['f64.reinterpret_i64', ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ['local.get', `$${objTmp}`]], asI64(emit(['str', method]))]]],
      ['else', undefExpr()]], 'f64')
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
}

// 12. Unknown callee — assume external method. Total: always returns.
function externalMethodFallback({ obj, method, parsed }) {
  // A receiver with a KNOWN jz-native kind (linear-memory value) has no host
  // prototype behind it — every native strategy above declined, so the method
  // is simply missing and __ext_call could only marshal garbage / return
  // undefined at runtime. Fail at compile in every mode, like strict does.
  // OBJECT/HASH are exempt: their property sets are user data, not a closed
  // builtin table — `o.x()` may resolve to a closure slot at runtime (and when
  // it doesn't, the documented lowering is undefined, host's TypeError shape).
  // (Host values carry no static kind, so a null kind keeps the fallback.)
  const vt = typeof obj === 'string' ? (lookupValType(obj) ?? valTypeOf(obj)) : valTypeOf(obj)
  if (vt != null && vt !== VAL.OBJECT && vt !== VAL.HASH)
    err(`\`${typeof obj === 'string' ? obj : '<expr>'}.${method}(...)\` — '${method}' is not implemented for a ${vt} receiver, and jz-native values have no host fallthrough (the call could only yield undefined). Check the method name; if it's a real JS API, it's a missing jz builtin.`)
  if (ctx.transform.strict)
    err(`strict mode: method call \`${typeof obj === 'string' ? obj : '<expr>'}.${method}(...)\` on a value of unknown type falls through to host \`__ext_call\`. Annotate the receiver type or pass { strict: false }.`)
  // Under wasi there is no host `__ext_call` — the call lowers to a
  // no-op returning `undefined`. This is by-design so polymorphic code
  // can target js and wasi from one source; users who want fail-fast
  // pass `strict: true` (handled above).
  if (ctx.transform.host === 'wasi') return undefExpr()
  warnDeopt('deopt-method', `method call \`${typeof obj === 'string' ? obj : '<expr>'}.${method}(…)\` on a value whose type couldn't be resolved dispatches through the JS host (\`__ext_call\`) — a wasm→JS round-trip per call, orders of magnitude slower than a direct call. Restructure so the receiver's type is provable, or keep it off the hot path.`)
  inc('__ext_call')
  ctx.features.external = true
  const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
  const arrayIR = buildArrayWithSpreads(combined)
  return typed(['f64.reinterpret_i64', ['call', '$__ext_call',
    ['i64.reinterpret_f64', asF64(emit(obj))],
    ['i64.reinterpret_f64', asF64(emit(['str', method]))],
    ['i64.reinterpret_f64', arrayIR]]], 'f64')
}

const TYPED_STRATEGIES = [
  tryBoxedDelegate, trySidecarToPrimitive, tryStaticDispatch, tryRuntimeStringFork,
  tryRuntimeNumberMethod, trySchemaClosureCall, tryGenericEmitter, tryDynamicPropCall,
  externalMethodFallback,
]

/** Method-call dispatch: `obj.method(args)`. Linear strategy chain, first
 *  match wins. 1–4 are context-free (LEADING_STRATEGIES); 5–12 share the
 *  resolved receiver type + callMethod shim via the dispatch-context record
 *  (TYPED_STRATEGIES — the last entry is total):
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
  // strategies keep the simple `callMethod(receiver, emitter)` shape.
  const c = {
    obj, method, parsed, vt,
    callMethod: (objArg, methodEmitter) => emitMethodCallSpread(objArg, methodEmitter, parsed, method),
  }
  for (const strategy of TYPED_STRATEGIES) {
    const r = strategy(c)
    if (r !== undefined) return r
  }
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
  // Speculative typed dispatch (narrow's speculateTypedParams): route the call
  // through a per-arg tag guard to the typed clone; a miss takes the original
  // call unchanged. Guard positions must be covered by real args — a site
  // relying on arity-padding at a speculated position would guard `undefined`
  // every call, pure loss.
  const spec = func && ctx.types.specFns?.get(callee)
  if (spec && func.sig.results.length === 1 && spec.guards.every(g => g.k < parsed.normal.length))
    return emitSpeculativeCall(callee, spec, parsed.normal, func)
  // Pad missing args with `undefined` so default-param init triggers per spec
  // (only undefined, not null, should trigger defaults). Drop extras to match
  // JS calling convention — emitting them anyway produces an invalid call
  // when the callee is a fixed-arity import (e.g. `_interp`-registered host
  // stubs) since wasm validates arg count. Use ?? rather than || so a
  // legitimate 0-arity callee isn't bypassed.
  const params = func?.sig.params ?? []
  const args = func ? emitCallArgs(parsed.normal, params)
                    : parsed.normal.map(a => coerceArg(emit(a), undefined, a))
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
  // Per-param "every direct call site passed a number" lattice. Every call to a
  // direct (non-escaping) closure flows through here, so once the body is emitted
  // (module end, after all calls) a param only ever seen with numeric args is marked
  // VAL.NUMBER — its body uses then skip __to_num, the same boxing win the numeric
  // export-param path gives. An arg we can't prove numeric poisons the slot to false.
  const pt = (ctx.closure.paramTypes ||= new Map())
  let row = pt.get(bodyName); if (!row) pt.set(bodyName, row = [])
  // Parallel typed-array ctor lattice: a param passed the SAME typed-array ctor at
  // every direct call site is a TYPED param, so its body reads (`buf[i]`) take the
  // typed fast-path instead of the dynamic `__typed_idx`/`__len` route that drags in
  // the string runtime. `null` (sticky) once two sites disagree or an arg isn't a
  // known typed array — the same monotone meet as the numeric row. Mirrors the named-fn
  // applyTypedPointerParamAbi, restricted to non-escaping (directly-called) closures.
  const tc = (ctx.closure.paramTypedCtors ||= new Map())
  let tcRow = tc.get(bodyName); if (!tcRow) tc.set(bodyName, tcRow = [])
  for (let i = 0; i < n; i++) {
    const numeric = valTypeOf(parsed.normal[i]) === VAL.NUMBER
    row[i] = row[i] === undefined ? numeric : (row[i] && numeric)
    const arg = parsed.normal[i]
    const ctor = typeof arg === 'string' && valTypeOf(arg) === VAL.TYPED ? (ctx.types.typedElem?.get(arg) ?? null) : null
    if (tcRow[i] === undefined) tcRow[i] = ctor
    else if (tcRow[i] !== ctor) tcRow[i] = null
  }
  // Track the fewest args any call passed: a slot at index ≥ minArgc is omitted by some call
  // site (padded with UNDEF_NAN), so it may be undefined — emitClosureBody flags it nullable.
  const mn = (ctx.closure.minArgc ||= new Map())
  const prev = mn.get(bodyName)
  mn.set(bodyName, prev === undefined ? n : (n < prev ? n : prev))
  // Body signature is uniform $ftN: (env f64, argc i32, a0..a{W-1} f64) → f64.
  // We pass the closure NaN-box itself as env (body extracts captures via __ptr_offset(__env)).
  // Slots are untyped boxed-value positions: a BOOL arg crosses as its atom box
  // (the paramTypes numeric lattice above already poisons on non-NUMBER args, so
  // the body never assumes raw numerics for these slots).
  const slots = parsed.normal.map(a => carrierF64(a, emit(a)))
  while (slots.length < W) slots.push(undefExpr())
  return typed(['call', `$${bodyName}`,
    asF64(emit(callee)),
    typed(['i32.const', n], 'i32'),
    ...slots], 'f64')
}

/** Tag the generic call_indirect of `constFnArr[idx](args)` for the optimizer's
 *  devirtConstFnArrayCalls pass (optimize/index.js). The candidate set — a
 *  module-const array of capture-free arrows — is recorded when the DECL emits,
 *  which happens in buildStartFn AFTER function bodies emit; so emit only marks
 *  the site (receiver name), and the rewrite runs in optimizeFunc where the
 *  facts are complete. */
const tagFnArrayDispatch = (ir, arrName) => {
  const findCI = (n) => {
    if (!Array.isArray(n)) return null
    if (n[0] === 'call_indirect') return n
    for (let i = 1; i < n.length; i++) { const f = findCI(n[i]); if (f) return f }
    return null
  }
  const ci = findCI(ir)
  if (ci) ci.dvArr = arrName
  return ir
}

/** Generic closure call: callee is a value holding a NaN-boxed closure pointer.
 *  Uniform convention: fn.call packs all args into an array and trampolines. */
function emitGenericClosureCall(callee, parsed) {
  const dvName = ctx.transform.optimize && !parsed.hasSpread &&
    Array.isArray(callee) && callee[0] === '[]' && typeof callee[1] === 'string' ? callee[1] : null
  if (parsed.hasSpread) {
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const arrayIR = buildArrayWithSpreads(combined)
    // Pass pre-built array as single already-emitted arg
    return ctx.closure.call(emit(callee), [arrayIR], true)
  }
  const ir = ctx.closure.call(emit(callee), parsed.normal)
  return dvName ? tagFnArrayDispatch(ir, dvName) : ir
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
  const void_ = ctx.func._expect === 'void'
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

// Ring 0.3 (re-landed after the dispatch rework dropped the uncommitted original):
// JS makes BigInt⊕Number arithmetic a TypeError. Enforce it exactly where the mix
// is PROVABLE from source — one side proven BIGINT, the other a NUMERIC LITERAL —
// and stay permissive otherwise: kernel carriers read NUMBER as a kind-DEFAULT
// (not a proof), so rejecting proven-BIGINT × default-NUMBER breaks sound kernels.
const numLiteralNode = (n) =>
  typeof n === 'number' || (Array.isArray(n) && n[0] == null && typeof n[1] === 'number')
function bigintMixReject(op, a, b) {
  if (b === undefined) return
  const aBig = valTypeOf(a) === VAL.BIGINT, bBig = valTypeOf(b) === VAL.BIGINT
  if (aBig === bBig) return
  if (numLiteralNode(aBig ? b : a))
    err(`Cannot mix BigInt and other types in \`${op}\` (TypeError in JS) — convert explicitly with BigInt() or Number()`)
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
    // Emit ONCE, before branching on pk — self-host miscompile: the equivalent inline
    // form `pk != null ? asPtrOffset(emit(expr), pk) : asParamType(emit(expr), rt)`
    // (emit(expr) repeated once per ternary arm, only one ever executing) is behaviorally
    // identical in JS but the self-hosted kernel drops the f64.convert_i32_s/u rebox on
    // the taken arm's result — an i32-typed return tail comes back bare (unconverted) in
    // a non-narrowed (f64-result) function, so the wasm validator sees "expected f64, got
    // i32" at every return site shaped like `return (expr)|0` inside a function whose
    // result the narrower left at f64 (e.g. blocked by an unrelated same-name shadow
    // elsewhere — narrowI32Results itself is unaffected either way). compile/index.js's
    // sibling call site (`const ir = emit(body); … ptrKind != null ? asPtrOffset(ir, …) :
    // asParamType(ir, …)`) already used this materialize-then-branch shape and was never
    // affected — mirroring it here is both the fix and the more idiomatic form (DRY: one
    // emit call instead of a copy per arm). Root cause not fully localized beyond "the
    // self-hosted kernel, at every optimize level 0-2, treats a value produced by a call
    // repeated textually across both arms of a ternary differently from one materialized
    // to a local first" — pinned in test/parser-bugs.js rather than chased further into
    // the kernel's own call/branch codegen. See .work/todo.md (groundtruth archive).
    const emitted = emit(expr)
    const ir = pk != null ? asPtrOffset(emitted, pk) : asParamType(emitted, rt)
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
    const prevSA = ctx.func._selfAccumConcat
    ctx.func._selfAccumConcat = selfAccum ? name : null
    const ev = emit(val)
    ctx.func._selfAccumConcat = prevSA
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
  // `**` is always f64 (and has its own const-exponent lowering) — full desugar.
  '**=': (name, val) => emit(['=', name, ['**', name, val]]),

  // Bitwise compound assignments: i32 normally, i64 when either operand is BigInt
  ...Object.fromEntries([
    ['&=', 'and'], ['|=', 'or'], ['^=', 'xor'],
    ['>>=', 'shr_s'], ['<<=', 'shl'], ['>>>=', 'shr_u'],
  ].map(([op, fn]) => [op, (name, val) => {
    if (typeof name !== 'string') return emit(['=', name, [op.slice(0, -1), name, val]])
    if (valTypeOf(name) === VAL.BIGINT || valTypeOf(val) === VAL.BIGINT) {
      const void_ = ctx.func._expect === 'void'
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
    const void_ = ctx.func._expect === 'void'
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
    // Write back — writeVar owns the cell/global/local discipline INCLUDING the
    // i32-narrowed-cell width (a direct f64.store here desynced narrowed cells).
    return writeVar(name, result, void_)
  }])),

  // === Increment/Decrement ===
  // Postfix resolved in prepare: i++ → (++i) - 1

  ...Object.fromEntries([['++', 'add'], ['--', 'sub']].map(([op, fn]) => [op, name => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
    const void_ = ctx.func._expect === 'void'
    const v = readVar(name)
    const one = v.type === 'i32' ? ['i32.const', 1] : ['f64.const', 1]
    return writeVar(name, typed([`${v.type}.${fn}`, v, one], v.type), void_)
  }])),

  // === Arithmetic (type-preserving) ===

  // Postfix in void: (++i)-1 / (--i)+1 → just ++i / --i
  '+': (a, b) => {
    if (ctx.func._expect === 'void' && isPostfix(a, '--', b)) return emit(a, 'void')
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
    if (vtA === VAL.STRING && vtB === VAL.STRING) {
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
      const coercionFree = (vt) => vt === VAL.STRING || vt === VAL.OBJECT || vt === VAL.BOOL
      const cfA = coercionFree(vtA), cfB = coercionFree(vtB)
      const strI64 = (n) => typed(['f64.reinterpret_i64', toStrI64(n, emit(n))], 'f64')
      if (cfA && cfB) return typed(ctx.abi.string.ops.concatRaw(strOperand(vtA, a), strOperand(vtB, b), ctx, selfAccum), 'f64')
      if (cfA) return typed(ctx.abi.string.ops.concatRaw(strOperand(vtA, a), strI64(b), ctx, selfAccum), 'f64')
      if (cfB) return typed(ctx.abi.string.ops.concatRaw(strI64(a), strOperand(vtB, b), ctx, selfAccum), 'f64')
      return typed(ctx.abi.string.ops.cat(strOperand(vtA, a), strOperand(vtB, b), ctx, selfAccum), 'f64')
    }
    if (vtA === VAL.BIGINT || vtB === VAL.BIGINT) {
      bigintMixReject('+', a, b)
      return fromI64(['i64.add', asI64(emit(a)), asI64(emit(b))])
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
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)) return typed(['i32.add', va, vb], 'i32')
    const i32add = tryI32Arith('i32.add', '+', a, b, va, vb); if (i32add) return i32add
    return typed(['f64.add', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  '-': (a, b) => {
    if (ctx.func._expect === 'void' && isPostfix(a, '++', b)) return emit(a, 'void')
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('-', a, b)
      return b === undefined
        ? fromI64(['i64.sub', ['i64.const', 0], asI64(emit(a))])
        : fromI64(['i64.sub', asI64(emit(a)), asI64(emit(b))])
    }
    if (b === undefined) return emitNeg(a)
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a - b)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 0) return toNumF64(a, va)
    // Unsigned uint32 operand: JS `-` is float (can go negative / exceed i32),
    // so avoid the wrapping i32.sub fast-path. See `+` above.
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb)) return typed(['i32.sub', va, vb], 'i32')
    const i32sub = tryI32Arith('i32.sub', '-', a, b, va, vb); if (i32sub) return i32sub
    return typed(['f64.sub', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  'u+': a => {
    if (valTypeOf(a) === VAL.BIGINT)
      return err('unary `+` on a BigInt is a TypeError in JS — use Number(x)')
    const v = emit(a)
    if (v.type === 'i32') return asF64(v)
    if (valTypeOf(a) === VAL.NUMBER) return toNumF64(a, v)
    inc('__to_num')
    return typed(['call', '$__to_num', asI64(v)], 'f64')
  },
  'u-': a => emitNeg(a),
  '*': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('*', a, b)
      return fromI64(['i64.mul', asI64(emit(a)), asI64(emit(b))])
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
    if (isI32Num(va) && isI32Num(vb) && !widensUnsigned(va) && !widensUnsigned(vb) && (mulFitsI32(va, vb) || mulBoundedFaithful(va, vb))) return typed(['i32.mul', va, vb], 'i32')
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
  '/': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('/', a, b)
      return fromI64(['i64.div_s', asI64(emit(a)), asI64(emit(b))])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a / b, b => b !== 0)
    if (_f) return _f
    if (isLit(vb) && litVal(vb) === 1) return toNumF64(a, va)
    return typed(['f64.div', stripCanon(toNumF64(a, va)), stripCanon(toNumF64(b, vb))], 'f64')
  },
  '%': (a, b) => {
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('%', a, b)
      return fromI64(['i64.rem_s', asI64(emit(a)), asI64(emit(b))])
    }
    const va = emit(a), vb = emit(b), _f = foldConst(va, vb, (a, b) => a % b, b => b !== 0)
    if (_f) return _f
    // ES remainder by zero is NaN; only the f64 path yields that (a - trunc(a/0)*0).
    // The i32.rem_s fast path traps on a zero divisor, so divert a literal-zero divisor.
    if (isLit(vb) && litVal(vb) === 0) return emitNum(NaN)
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
        const bits = isPureIR(fb) && isPureIR(fc)
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
      if (bothPlain || samePtr) {
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
      const bits = isPureIR(branchB) && isPureIR(branchC)
        ? ['select', ib, ic, cond]
        : ['if', ['result', 'i64'], cond, ['then', ib], ['else', ic]]
      return typed(['f64.reinterpret_i64', bits], 'f64')
    }
    if (!refPayload && isPureIR(branchB) && isPureIR(branchC))
      return markNumeric(typed(['select', branchB, branchC, cond], 'f64'))
    return markNumeric(typed(['if', ['result', 'f64'], cond, ['then', branchB], ['else', branchC]], 'f64'))
  },

  '&&': (a, b) => {
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
    const emitRight = () => withRefinements(rightRefs, b, () => emit(b))
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

  '||': (a, b) => {
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
  '??': (a, b) => {
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
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject(op, a, b)
      return fromI64([`i64.${fn}`, asI64(emit(a)), asI64(emit(b))])
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
    const thenBody = withRefinements(thenRefs, then, () => emitVoid(then))
    if (els != null) {
      const elseBody = withRefinements(elseRefs, els, () => emitVoid(els))
      return ['if', c, ['then', ...thenBody], ['else', ...elseBody]]
    }
    return ['if', c, ['then', ...thenBody]]
  },

  'for': (init, cond, step, body) => {
    if (body === undefined) return err('for-in/for-of not supported')
    // An enclosing labeled statement (`outer: for …`) hands its label down so `continue outer`
    // can target this loop's continue point. The immediately-enclosed loop consumes it.
    const myLabel = ctx.func.pendingLabel; ctx.func.pendingLabel = null
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
    // corruption. `_tbVersioned` brakes the arms' re-entry into this same intercept.
    if (!labeledContinue && !body._tbVersioned
        && (!ctx.transform.optimize || ctx.transform.optimize.versionTypedBounds !== false)) {
      const vs = versionableTypedFor(init, cond, step, body, ctx.func.locals)
      if (vs) {
        body._tbVersioned = true
        inc('__len')
        const result = []
        if (init != null) result.push(...emitVoid(init))
        const i64c = (n) => ['i64.const', n]
        const ext = (ir) => ['i64.extend_i32_s', ir]
        const conjs = []
        // max iv as i64. An 'f64' bound (untyped param, unknown box) converts via
        // ceil (`<`: the max int iv under B) / floor (`<=`) + trunc_sat — never traps —
        // with a `|B| ≤ 2^31` conjunct making the conversion exact: NaN and box bit
        // patterns fail the abs-compare and fall to the checked arm; saturated garbage
        // past the limit is conjunct-dead. i64 extents then never overflow
        // (|terms| ≤ 2^31, a is an i32 literal → |hi| < 2^63).
        const maxIv = tempI64('tvq')
        if (vs.bKind === 'f64') {
          const bF = temp('tvf')
          result.push(['local.set', `$${bF}`, asF64(emit(vs.bound))])
          conjs.push(['f64.le', ['f64.abs', ['local.get', `$${bF}`]], ['f64.const', 2147483648]])
          result.push(['local.set', `$${maxIv}`,
            ['i64.trunc_sat_f64_s', [vs.incl ? 'f64.floor' : 'f64.ceil', ['local.get', `$${bF}`]]]])
          if (vs.bump - (vs.incl ? 0 : 1)) result.push(['local.set', `$${maxIv}`,
            ['i64.add', ['local.get', `$${maxIv}`], i64c(vs.bump - (vs.incl ? 0 : 1))]])
        } else {
          const adj = vs.bump - (vs.incl ? 0 : 1)
          result.push(['local.set', `$${maxIv}`,
            adj ? ['i64.add', ext(asI32(emit(vs.bound))), i64c(adj)] : ext(asI32(emit(vs.bound)))])
        }
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
        // one extent conjunct pair per (recv, a, slots) group: hi = a*maxIv+Σkᵢ·slotᵢ+maxC
        // < len, plus lo = a*entry+Σkᵢ·slotᵢ+minC ≥ 0 — folded away when a static start
        // proves it, read from the live iv local at guard time otherwise (while-shapes)
        const groups = new Map(), indGroups = new Map()
        for (const c of vs.cands) {
          if (c.ind != null) {
            const gk = c.recv + '\x00' + c.ind
            if (!indGroups.has(gk)) indGroups.set(gk, c)
            continue
          }
          const gk = c.recv + '\x00' + c.a + '\x00' + c.slots.map(t => t.k + '*' + slotKey(t.e)).join('+')
          const g = groups.get(gk)
          if (!g) groups.set(gk, { recv: c.recv, a: c.a, slots: c.slots, maxC: c.bConst, minC: c.bConst })
          else { g.maxC = Math.max(g.maxC, c.bConst); g.minC = Math.min(g.minC, c.bConst) }
        }
        const slotSum = (base, list) => {
          let r = base
          for (const t of list) {
            const s = slotI64(t.e, t.kind)
            r = ['i64.add', r, t.k === 1 ? s : ['i64.mul', i64c(t.k), s]]
          }
          return r
        }
        const len64Of = (recv) => ['i64.extend_i32_u', ['call', '$__len', ['i64.reinterpret_f64', asF64(emit(recv))]]]
        for (const g of groups.values()) {
          let hi = slotSum(['i64.mul', i64c(g.a), ['local.get', `$${maxIv}`]], g.slots)
          if (g.maxC) hi = ['i64.add', hi, i64c(g.maxC)]
          conjs.push(['i64.lt_s', hi, len64Of(g.recv)])
          // low extent: static start folds (candidates with a provably-negative static
          // lo were filtered), runtime entry reads iv through the slot machinery (an
          // f64 iv gets the integral∧range conjuncts — entry integrality carries
          // through integer advances)
          if (vs.startC != null && !g.slots.length) continue
          let lo = slotSum(vs.startC != null ? i64c(g.a * vs.startC)
            : ['i64.mul', i64c(g.a), slotI64(vs.iv, vs.ivKind)], g.slots)
          if (g.minC) lo = ['i64.add', lo, i64c(g.minC)]
          conjs.push(['i64.ge_s', lo, i64c(0)])
        }
        // induction cursors (`k += step` in a comma step): value at iteration t is
        // entry + slope*t, t ∈ [0, maxIv - ivEntry] — monotone either direction, so
        // BOTH endpoints guard in [0, len) and every intermediate value is covered
        for (const c of indGroups.values()) {
          const kE = slotI64(c.ind, exprType(c.ind, ctx.func.locals) === 'i32' ? 'i32' : 'f64')
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
        let guard = conjs[0]
        for (let k = 1; k < conjs.length; k++) guard = ['i32.and', guard, conjs[k]]
        // arm-scoped assumption set: snapshot/RESTORE (not add/delete) — unrolls
        // inside the fast arm stamp clone keys (cloneWithSubst proof carry-over)
        // that must NOT survive into the checked arm, which runs exactly when the
        // guard failed
        const saved = ctx.types.assumedBounds
        ctx.types.assumedBounds = new Set(saved ?? [])
        for (const c of vs.cands) ctx.types.assumedBounds.add(idxKey(c.recv, c.idx))
        const fast = emitter['for'](null, cond, step, body)
        ctx.types.assumedBounds = saved
        const checked = emitter['for'](null, cond, step, body)
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
    const id = ctx.func.uniq++
    const brk = `$brk${id}`, loop = `$loop${id}`
    // The cont wrapper is only needed if the body has a `continue` AND there is a step
    // expression — `continue` must jump to before the step. Without a step, `continue`
    // can target the loop label directly, saving a redundant `block`.
    const needsCont = step && (hasOwnContinue(body) || labeledContinue)
    const cont = needsCont ? `$cont${id}` : loop
    ctx.func.stack.push({ brk, loop: cont })
    const frame = ctx.func.stack[ctx.func.stack.length - 1]
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
    // Hand the label to the immediately-enclosed loop so `continue name` can target it.
    ctx.func.pendingLabel = name
    const result = ['block', brk, ...emitVoid(body)]
    ctx.func.pendingLabel = null   // clear if the body wasn't a loop (nothing consumed it)
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
    if (label == null) return [...emitFinalizers(), ['br', loopTop().loop]]
    // Labeled continue: target the continue point of the loop that adopted this label.
    const frame = ctx.func.stack.findLast(f => f.contLabel === label)
    if (!frame) err(`continue label '${label}' is not in scope`)
    return [...emitFinalizers(), ['br', frame.loop]]
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
      const origBody = body
      if (Array.isArray(body) && body[0] === '{}' && Array.isArray(body[1]) && body[1][0] === ';')
        body = ['{}', [';', ...bodyPrefix, ...body[1].slice(1)]]
      else if (Array.isArray(body) && body[0] === '{}')
        body = ['{}', [';', ...bodyPrefix, body[1]]]
      else body = ['{}', [';', ...bodyPrefix, ['return', body]]]
      if (origBody && origBody._nonEscaping) body._nonEscaping = origBody._nonEscaping
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
  ctx.func._expect = expect || null
  if (Array.isArray(node)) {
    ctx.error.node = node
    if (node.loc != null) ctx.error.loc = node.loc
  }
  if (node == null) return null
  // Pre-emitted IR passthrough: `['__emitted', ir]` returns `ir` untouched. Lets a caller that
  // already emitted a subtree (e.g. the `if` handler's condition) splice it into an AST-shaped
  // re-emit (a `?:` for if→select conversion) without emitting it a second time.
  if (Array.isArray(node) && node[0] === '__emitted') return node[1]
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
          const wrapped = ptrResult
            ? `(call $__mkptr (i32.const ${valKindToPtr(func.sig.ptrKind)}) (i32.const ${func.sig.ptrAux ?? 0}) ${callExpr})`
            : resType === 'i32'
              ? (func.sig.unsignedResult ? `(f64.convert_i32_u ${callExpr})` : `(f64.convert_i32_s ${callExpr})`)
              : resType === 'i64'
                ? `(f64.reinterpret_i64 ${callExpr})`
                : callExpr
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} ${paramDecls.join(' ')} (result f64) ${restLocals}${restPrelude}${wrapped})`
          inc(trampolineName, ...(ptrResult ? ['__mkptr'] : []), ...(restIdx >= 0 ? ['__alloc_hdr', '__mkptr'] : []))
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

  // Self-describing NaN literal — same reason bigints are self-describing: a raw NaN
  // number is NaN-boxing-ambiguous and degrades to 0 across the self-host kernel's
  // value/marshalling boundary. The `NaN` global resolves to this (prepare) instead
  // of a `[, NaN]` literal; watr emits the canonical quiet NaN. (Infinity is a normal
  // f64 and survives, so it stays a plain literal.)
  if (op === 'nan') return typed(['f64.const', 'nan'], 'f64')

  // Self-describing boolean literal (`normalizeBigints` at the host→kernel boundary).
  // A raw `true`/`false` in the marshalled AST coerces to the number 1/0 and loses its
  // VAL.BOOL kind, so the kernel returns a plain f64 instead of a NaN-boxed boolean.
  // args[0] is 1/0 (prepare may wrap it as a `[, 1]` literal node) — emit it as that
  // working rep; the BOOL boxing happens at the boundary via valTypeOf('bool')=VAL.BOOL.
  if (op === 'bool') return emit(args[0])

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

  // `let`/`const` dispatch directly to the imported emitDecl rather than through the
  // ctx.core.emit table reference: under self-host the table reference is a closure value,
  // and a runtime spread of >8 args into a closure call silently drops arguments — so a
  // `let` with >8 expression-init declarators (e.g. an SROA prologue loading 16 typed-array
  // slots) lost everything past the 8th. A direct call to the module-local binding compiles
  // as a real direct call, which marshals all args.
  if (op === 'let' || op === 'const') return emitDecl(...args)
  const handler = ctx.core.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  const ir = handler(...args)
  if (ir && ir.type === 'f64' && valTypeOf(node) === VAL.NUMBER) ir.valKind = VAL.NUMBER
  return ir
}
