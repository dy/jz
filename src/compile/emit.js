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

import {
  commaList, T, isBlockBody, isReassigned, mutatesArrayLength, isConstLiteral, constLiteralHoistable,
  hasOwnContinue, hasLabeledContinueTo, hasOwnBreakOrContinue, extractParams, classifyParam, JZ_UNDEF, TYPEOF,
  ASSIGN_OPS, MUTATE_OPS, firstRefKind, isLeaf,
} from '../ast.js'
import { ctx, err, inc, warnDeopt, PTR, ssoBitI64Hex, LAYOUT, DBG_INVARIANTS, setLinkDemand, getFactStore } from '../ctx.js'
import {
  i64Hex, encodePtrHi, STR_HCACHE_BIT, typedElemAux, oobNanIR,
  OBJECT_SCHEMA_HI_MASK, objectSchemaGuardHex, TYPED_ELEM_NAMES, encodeTypedElemAux, TYPED_ELEM_VIEW_FLAG,
} from '../../layout.js'
import { ERR, ERR_CLASS_NAMES } from '../../err-codes.js'
import { bodyOnlyCharCodeAtCalls } from '../abi/string.js'
import { includeForStringOnly } from '../autoload.js'
import { nonNegIntLiteral, intLiteralValue, intExprRange, constIntExpr, staticPropertyKey, guardCounterName, forCounterRange } from '../static.js'
import { findFreeVars } from './analyze.js'
import { scanBindingUses, USE } from './analyze-scans.js'
import {
  containsNestedClosure, containsNestedLoop, nestedSmallLoopBudget,
  containsDeclOf, cloneWithSubst, containsKnownTypedArrayIndex,
  smallConstForTripCount, isTerminator, scanBoundedLoops, inBoundsCharCodeAt,
  exprType, MAX_SMALL_FOR_UNROLL, MAX_NESTED_FOR_UNROLL,
  inBoundsArrIdx, typedIdxProven, versionableTypedNest, idxKey, SLOT_OPS,
} from '../type.js'
import { valTypeOf, shapeOf, hasAmbiguousBoolMerge, censusMaybeUndefined, censusMaybeUndefinedKind, nullishArm } from '../kind.js'
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
  boolBoxIR, carrierF64, carrierF64Narrow, unboxBoolIR, boxBigInt, unboxBigInt, applyBigintRepresentationAction, maybeUnboxBigInt, needsBigintBox, isProvenBoxedBigint, isCurrentlyBoxedBigint, isTernaryBoxedBigint, isPlanTaggedBigint, readI64, bigintEraseErr, bigintStrict,
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
  REP_EDGE_BOX, REP_EDGE_REJECT, REP_EDGE_UNBOX,
  recordClosureCallRepresentations, representationBindingWriteAction, representationCallArgAction, representationJoinArmAction, representationReturnAction,
} from './representation-plan.js'

// Raw-by-construction BIGINT producers (see the '=' emitter's durable-rebox arm).
const RAW_BIGINT_OPS = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', 'u-', '~'])

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

// hoistNestedCalls (plan/inline.js hExpr) names its hoisted `const __h = call(...)`
// temps `${T}inl${uniq}_h` — a single-def, single-use compiler binding by construction
// (each nested-call occurrence gets its own fresh temp, substituted at exactly the one
// site it was found). Recognizing that exact shape lets stripCanon (below) carry
// `.canonOf` provenance through the temp without risking a binding some OTHER reader
// also depends on staying canonical.
const isHoistTemp = (name) => typeof name === 'string' && name.startsWith(T + 'inl') && name.endsWith('_h')

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
// builtin to .filter; the self-compile kernel must compile it).
const FIRST_CLASS_BUILTIN_BODY = {
  'Array.isArray': () =>
    `(if (result f64) (i32.and (f64.ne (local.get $__a0) (local.get $__a0)) ` +
    `(i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $__a0)) (i64.const ${LAYOUT.TAG_SHIFT}))) (i32.const ${LAYOUT.TAG_MASK})) (i32.const ${PTR.ARRAY}))) ` +
    `(then (f64.const 1)) (else (f64.const 0)))`,
}

// Every builtin name `builtinFunctionValue` can mint a closure-table entry for.
// prepare's pre-emit scans (post-prep `visit` below, and recordModuleInitFacts's
// visitFuncValue) must recognize a bare reference to one of these as "needs the
// closure table" exactly like a user function name — otherwise a program whose
// ONLY first-class-function usage is a bare builtin reference (no user closures
// anywhere to otherwise trigger `fn` module inclusion) reaches emit with
// ctx.closure.table unset and builtinFunctionValue's precondition check fails.
export const FIRST_CLASS_BUILTIN_NAMES = new Set([...Object.keys(FIRST_CLASS_UNARY_MATH), ...Object.keys(FIRST_CLASS_BUILTIN_BODY)])

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
  // ctx.closure.mint (not a bare table.push) — keeps ctx.closure.envMeta
  // aligned with ctx.closure.table by funcIdx; see module/function.js's
  // ctx.closure.mint doc (.work/research.md §Region arena, funcIdx skew).
  // A builtin-as-value closure is always zero-capture, so the default
  // {len:0, cellMask:0} meta is correct here.
  const idx = ctx.closure.mint(fn)
  const ir = mkPtrIR(PTR.CLOSURE, idx, 0)
  ir.closureFuncIdx = idx
  return ir
}

/** Emit unary negation: constant-fold, or i32 sub from 0 / f64.neg. */
const emitNeg = (a) => {
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
    return bigIntUnary(a, i64v => ['i64.sub', ['i64.const', 0], i64v], ['f64.const', 'nan'])
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
// Those agree under a ToInt32/ToUint32 sink — but as a PLAIN NUMBER (no further
// truncating consumer), `i32.mul` is faithful only when the exact product itself
// providably fits signed i32 (±(2^31−1)); a wrapped-but-f64-exact product (the OLD
// rule this replaced: one operand ≤ 2^22, the OTHER left fully unbounded) is
// NOT the same thing — `i32.mul` truncates mod 2^32 regardless of how small the
// exact product would stay in f64, so an unguarded operand can carry the true
// product past ±2^31 and the wrap corrupts any consumer that widens the i32
// result straight to f64 (P0-2 ledger: `4194304 * (x|0)` returned bare, or
// `(x|0) * (y&63)` returned bare — both wrap to a wrong NUMBER at HEAD).
// BOTH operands need a real magnitude bound — a literal's own |value|, or a
// masked/narrowed expression's `maskBound` (ir.js; already used for the masked-
// scale case) — and it's the PRODUCT of those bounds, not either alone, that
// must clear the i32 ceiling. `maskBound` defaults to the full i32 magnitude
// (2**31) for anything it can't prove tighter, so an unguarded operand costs
// the full range in the product check, exactly as it should.
const opBound = (v) => isLit(v) ? Math.abs(litVal(v)) : maskBound(v)
const mulFitsI32 = (va, vb) => opBound(va) * opBound(vb) <= 0x7fffffff

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
// AST-level range twin (intExprRange resolves const names + ranged decl reps):
// the EXACT product interval must fit signed i32 — then i32.mul is faithful in
// every consumer context, same contract as mulBoundedFaithful. Keeps exprType's
// range-proven i32 verdict (type.js `*`) in lock-step at the emit site.
const mulRangeFitsI32 = (aAst, bAst) => {
  const ra = intExprRange(aAst), rb = intExprRange(bAst)
  if (!ra || !rb) return false
  const p = [ra[0] * rb[0], ra[0] * rb[1], ra[1] * rb[0], ra[1] * rb[1]]
  return Math.min(...p) >= -0x80000000 && Math.max(...p) <= 0x7fffffff
}
const addFitsI32 = (va, vb) => opBound(va) + opBound(vb) <= 0x7fffffff
const addBoundedFaithful = (va, vb) => i32Mag(va) + i32Mag(vb) <= 0x7fffffff
const addRangeFitsI32 = (aAst, bAst) => {
  const ra = intExprRange(aAst), rb = intExprRange(bAst)
  return !!ra && !!rb && ra[0] + rb[0] >= -0x80000000 && ra[1] + rb[1] <= 0x7fffffff
}
const subRangeFitsI32 = (aAst, bAst) => {
  const ra = intExprRange(aAst), rb = intExprRange(bAst)
  return !!ra && !!rb && ra[0] - rb[1] >= -0x80000000 && ra[1] - rb[0] <= 0x7fffffff
}

// Loop-guard hull channel (sibling to the loop-analysis hull channel's
// forCounterRange): `while (name < bound)` / `for (…; name < bound; …)` proves
// an upper bound for `name` for the DURATION the guard has just passed and
// `name` hasn't been written since — unlike forCounterRange's whole-body
// induction hull (sound only for a monotone counter with a known init/step),
// this needs NEITHER: it's a per-EMISSION-POSITION fact, torn down the moment
// (in emission order — which matches evaluation order for straight-line code
// and both arms of a branch) a write to `name` is emitted (see writeVar's
// invalidation, ir.js). A comparison textually inside the loop body BEFORE
// any write to `name` (heapify's `if (child + 1 < n && …) child++` — the
// guard's own condition, read before its consequent's `child++` runs) sees
// the fact; anything after the first write does not. Keyed by NAME (not AST
// position) — nesting is handled by ordinary save/restore, same discipline as
// withRefinements, just on a dedicated map so it never interacts with the
// scope-lifetime `ctx.func.refinements` channel (whose own reassignment
// refusal this deliberately bypasses, being sound for a different reason).
const loopGuardHi = () => (ctx.types.loopGuardHi ??= new Map())

/** Bare-name (or AST) upper bound ONLY — tolerates an unknown/unbounded lower
 *  side, unlike intExprRange's two-sided contract. Sound to use standalone
 *  (not as an intExprRange replacement) exactly where the caller only needs
 *  the upper side — see addLiteralFitsI32's doc for why that's enough for a
 *  known-sign literal addend. */
function boundedHi(n) {
  if (typeof n !== 'string') { const r = intExprRange(n); return r ? r[1] : null }
  const rf = ctx.func?.refinements?.get(n)
  const rep = repOf(n)?.range
  let hi = rep ? rep[1] : Infinity
  if (rf?.rhi != null && rf.rhi < hi) hi = rf.rhi
  const gh = ctx.types.loopGuardHi?.get(n)
  if (gh != null && gh < hi) hi = gh
  return Number.isFinite(hi) ? hi : null
}
/** Symmetric lower-bound-only resolver (subtraction's mirror of boundedHi) — no
 *  loop-guard-hull consumer today (sort's surgery site is `+`), kept parallel
 *  for the `x - k` shape a `while(name > bound)`-style guard would feed. */
function boundedLo(n) {
  if (typeof n !== 'string') { const r = intExprRange(n); return r ? r[0] : null }
  const rf = ctx.func?.refinements?.get(n)
  const rep = repOf(n)?.range
  let lo = rep ? rep[0] : -Infinity
  if (rf?.rlo != null && rf.rlo > lo) lo = rf.rlo
  const gl = ctx.types.loopGuardLo?.get(n)
  if (gl != null && gl > lo) lo = gl
  return Number.isFinite(lo) ? lo : null
}
// `X + k` (k a compile-time integer constant) can ONLY overflow i32 at the
// extreme the addend pushes TOWARD: a positive k risks the TOP edge
// (I32_MAX), a negative k risks the BOTTOM edge (I32_MIN) — the OTHER edge
// moves AWAY from, so it needs no bound at all. This is why a ONE-SIDED
// resolver (boundedHi/boundedLo) suffices here where addRangeFitsI32 needs a
// full closed hull on BOTH operands: X's un-provable far side is provably
// irrelevant for THIS specific shape, not assumed away.
const addLiteralFitsI32 = (aAst, bAst) => {
  const k = constIntExpr(bAst)
  if (k == null || !Number.isInteger(k)) return false
  if (k >= 0) { const hi = boundedHi(aAst); return hi != null && hi + k <= 0x7fffffff }
  const lo = boundedLo(aAst); return lo != null && lo + k >= -0x80000000
}
const subLiteralFitsI32 = (aAst, bAst) => {
  const k = constIntExpr(bAst)
  if (k == null || !Number.isInteger(k)) return false
  if (k >= 0) { const lo = boundedLo(aAst); return lo != null && lo - k >= -0x80000000 }
  const hi = boundedHi(aAst); return hi != null && hi - k <= 0x7fffffff
}

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
  const staticFold = (target) => {
    if (ambiguous || planTaggedBigint) return null
    const vt = resolveValType(typeofExpr, valTypeOf, lookupValType)
    if (vt) return typed(['i32.const', (vt === target) === eq ? 1 : 0], 'i32')
    return null
  }

  if (code === TYPEOF.number) {
    // typeof "number": v===v rejects NaN-box pointers; BOOL carrier is 0/1 → still typeof "boolean".
    if (!planTaggedBigint && resolveValType(typeofExpr, valTypeOf, lookupValType) === VAL.BOOL) return typed(['i32.const', eq ? 0 : 1], 'i32')
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

/** Stringify a VAL.BOOL operand to "true"/"false" (f64 string pointer). The
 *  boolean rides the cheap 0/1 carrier, so we runtime-select between the two
 *  interned literals; a constant operand folds to a single literal downstream. */
export const emitBoolStr = (node) =>
  typed(['select', asF64(emit(['str', 'true'])), asF64(emit(['str', 'false'])), truthyIR(emit(node))], 'f64')

const CMP_SET = new Set(['>', '<', '>=', '<=', '==', '!=', '!'])
const isCmp = n => Array.isArray(n) && CMP_SET.has(n[0])
const BOOL_EXPR_OPS = new Set(['>', '<', '>=', '<=', '==', '!=', '===', '!==', '!'])
const isCanonicalBoolExpr = n => Array.isArray(n) &&
  (BOOL_EXPR_OPS.has(n[0]) ||
    ((n[0] === '&&' || n[0] === '||' || n[0] === '__eager&&' || n[0] === '__eager||') &&
      isCanonicalBoolExpr(n[1]) && isCanonicalBoolExpr(n[2])))
// Eager-select gate: pure (no trap/effect) AND cheap. isPureIR alone admits f64.div/
// f64.sqrt — correct for `select` (no trap), but eagerly computing a division/sqrt-
// bearing arm that a branch would have skipped can cost more than a mispredict. Every
// select-gate call site (below, and the post-watr if→select fold in optimize/index.js)
// uses this instead of a bare isPureIR check.
const eagerSelectOK = (...ns) => ns.every(n => isPureIR(n) && !hasExpensiveOp(n))
// Separate cost axis from eagerSelectOK: that gate gauges the select's ARMS
// (vb/vc — the values chosen between); this gauges the select's CONDITION. A cond
// that lowers to a nested value-`if` over a memory load (dataDependentFlag, ir.js —
// the short-circuit `&&`/`||` shape) pays load latency unconditionally when fed
// eagerly into `select`, where the lazy if/else it came from would only pay it when
// the fast clause passed. Every `?:` select site below composes this with
// eagerSelectOK(arms) before choosing `select` over `if`.
const selectCondOK = (cond) => !dataDependentFlag(cond)
// Eager boolean chains win in leaf numeric kernels but regress orchestration/
// compiler code whose first guard usually rejects before a costly RHS. Keep
// the latency trade in call-free bodies; nested closures are separate bodies.
// Memoised per body (AdHocMemo retirement — ctxfunc-survey.md §2/§5: WeakMap
// on body identity, getFactStore().boolEager, same idiom as type.js's
// inBoundsCharCodeAt). The cached value is a boolean, so the lookup uses
// `.has()`, not truthiness — `false` is a valid cached result. A non-array
// body can't be a WeakMap key; `walk` itself no-ops on one (never sets
// `calls`), so the vacuous answer is `true`, returned uncached.
const boolEagerBody = () => {
  const body = ctx.func.body
  if (!Array.isArray(body)) return true
  const cache = getFactStore().boolEager
  if (cache.has(body)) return cache.get(body)
  let calls = false
  const walk = (n, root = false) => {
    if (calls || !Array.isArray(n)) return
    if (!root && n[0] === '=>') return
    if (n[0] === '()' || n[0] === 'new') { calls = true; return }
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(body, true)
  const result = !calls
  cache.set(body, result)
  return result
}

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
// name (e.g. the self-compile abi's `ctx.abi.string.ops.charCodeAt(sF64,iI32,ctx,oobNan)`).
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
export const emitIndex = (index) => {
  const direct = tryI32Index(index)
  if (direct) return direct
  // A checked typed read used as another computed index must carry its miss
  // bit outward: ToInt32(undefined) is 0, but JS's property key remains
  // `undefined` and must not access element zero. Demand-drive the metadata
  // context only for the direct nested-read shape; arithmetic around the read
  // has its own JS coercion semantics (`undefined|0` really does become zero).
  if (!Array.isArray(index) || index[0] !== '[]') return asI32(emit(index))
  ctx.types.indexConsumer = (ctx.types.indexConsumer || 0) + 1
  let value
  try { value = emit(index) } finally { ctx.types.indexConsumer-- }
  const out = asI32(value)
  if (value?.indexValid) out.indexValid = value.indexValid
  return out
}

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
      let controlsOp = false
      const scan = n => {
        if (controlsOp || !Array.isArray(n) || n[0] === '=>') return
        if ((n[0] === '>>>' || n[0] === '>>' || n[0] === '<<') && n[2] === name) { controlsOp = true; return }
        for (let i = 1; i < n.length; i++) scan(n[i])
      }
      scan(body)
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

// A source-defined function (carries a body) — as opposed to an imported name,
// which `ctx.funcs.names` also holds but which has no body and may legitimately
// share a name with a built-in emitter (e.g. an imported `parseInt`).
const isUserFunc = name => !!ctx.funcs.map.get(name)?.body

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

// Scoped FlowState combinators live in ./flow-state.js.

/** Coerce an AST node to an i32 boolean, folding && / || at the boolean boundary. */
export function toBool(node) {
  const op = Array.isArray(node) ? node[0] : null
  if (CMP_SET.has(op)) return emit(node)
  if (op === '__eager&&' || op === '__eager||') {
    const la = toBool(node[1]), lb = toBool(node[2])
    if (isCanonicalBoolExpr(node[1]) && isCanonicalBoolExpr(node[2]) && eagerSelectOK(la, lb))
      return typed([op === '__eager&&' ? 'i32.and' : 'i32.or', la, lb], 'i32')
    return op === '__eager&&'
      ? typed(['if', ['result', 'i32'], la, ['then', lb], ['else', ['i32.const', 0]]], 'i32')
      : typed(['if', ['result', 'i32'], la, ['then', ['i32.const', 1]], ['else', lb]], 'i32')
  }
  if (op === '&&') {
    const la = toBool(node[1]), lb = toBool(node[2])
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
    const la = toBool(node[1]), lb = toBool(node[2])
    if (eagerSelectOK(la, lb) && ((isCmp(node[1]) && isCmp(node[2])) ||
        (boolEagerBody() && isCanonicalBoolExpr(node[1]) && isCanonicalBoolExpr(node[2]))))
      return typed(['i32.or', la, lb], 'i32')
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

/** Emit a call argument ONCE, choosing emit vs emitIdentitySafe up front — the
 *  same single-emission discipline as bridge.js's storedValue chokepoint
 *  (research.md §Carrier invariant), inlined here because emit.js IS emit/
 *  emitIdentitySafe's home module (no bridge indirection needed, but no
 *  after-the-fact carrierF64 rescue is possible either: calling coerceArg
 *  with a plain `emit(node)` result and branching on hasAmbiguousBoolMerge
 *  AFTER the fact would emit `node` a SECOND time via emitIdentitySafe for
 *  the ambiguous case — a real side-effecting double-eval for an arg like
 *  `f() > 0 && 1`). Callers pass this instead of a bare `emit(a)`. */
const argIR = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : emit(node)

// THE represented-carrier chokepoint (research.md §Carrier invariant), same
// definition as bridge.js's exported storedValue — duplicated here (not
// imported) because emit.js already owns `emit`/`emitIdentitySafe` directly;
// going through bridge.js would round-trip via ctx.bridge for no reason.
// Boxed-value slots emit.js constructs directly need the FULL carrierF64
// treatment `argIR` deliberately skips (coerceArg applies its own
// valTypeOf===BOOL carrierF64 wrap on top of argIR's result — layering
// carrierF64 here too would be a second, redundant application; harmless
// since carrierF64 is idempotent on an already-boxed atom, but this file
// keeps the two helpers distinct so each call site's contract stays legible).
const storedValue = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : carrierF64(node, emit(node))
// Narrow-admission twin — see carrierF64Narrow's own doc comment (ir.js) for
// why the SRoA flat-object/array field locals below need THIS, not the plain
// storedValue above: a flat field's reads/writes are all rewritten to plain
// local access, with no registry-aware dynamic reader ever downstream of it.
const storedValueNarrow = (node) => hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : carrierF64Narrow(node, emit(node))

// carrier-representation-design.md §29: `coerceArg`'s box-direction branch
// below used `isNullish(tGet)` — a RUNTIME BIT-PATTERN test — as its "is this
// argument genuinely nullable" guard, deciding whether to skip `boxBigInt`
// and pass the value through raw. That test can't distinguish "this node's
// STATIC TYPE is really a BIGINT∪nullish union" (the ternary-merge shape
// kind.js's own VT['?:'] nullishArm rule types VAL.BIGINT for, matching the
// check just below — the ONLY place in the type system a node types BIGINT
// while its runtime value can genuinely BE the NULL_NAN/UNDEF_NAN sentinel)
// from "this node's VALUE happens to bit-collide with one of those two
// reserved constants" — a plain, never-null BIGINT expression whose result
// is occasionally, by construction, IDENTICAL to a reserved atom's own bit
// pattern (found live: `layout.js` atomNanHex's own `LAYOUT.NAN_PREFIX_BITS
// | (BigInt(atomId) << AUX_SHIFT)` — never nullable, but for atomId 1/2 its
// VALUE is bit-for-bit NULL_NAN/UNDEF_NAN). The false-positive skipped
// `boxBigInt` for that pure-BIGINT argument and passed it raw into `i64Hex`
// — whose OWN `bits` param the whole-program `bigintBoxed` solver proved
// "always arrives boxed" and unboxes with ZERO runtime tag check
// (unboxBigInt, ir.js) — so `i64Hex` treated the raw sentinel's low 32 bits
// (0 for both NULL_NAN and UNDEF_NAN — their id lives at bit 32+) as a heap
// address and `i64.load`'d address 0, reading the formatter's own static
// string table's opening bytes. Restricting the runtime nullish-guarded
// passthrough to the ONE shape that can genuinely BE null (a `?:` node with
// a nullish arm, mirroring the ternaryBoxedNames gate a few hundred lines
// below verbatim) restores boxBigInt's unconditional call for every other
// BIGINT-typed argument — exactly the invariant i64Hex's own bigintBoxed
// proof already assumes.
const nodeIsNullishBigintMerge = (node) => Array.isArray(node) && node[0] === '?:' &&
  ((valTypeOf(node[2]) === VAL.BIGINT && nullishArm(node[3])) || (valTypeOf(node[3]) === VAL.BIGINT && nullishArm(node[2])))

/** Coerce an emitted arg IR to match a callee param. Param may carry ptrKind (pointer-ABI
 *  i32 offset), else falls back to numeric WASM type coercion.
 *  `node` (the arg's AST, when the caller has it): a statically-BOOL arg headed
 *  into an UNTYPED f64 param crosses as its TRUE/FALSE atom box — the callee
 *  treats that slot as an opaque value, so identity (typeof/String/strict-eq)
 *  must survive. A val-known param (narrow stamped `p.val`) keeps the raw 0/1
 *  ABI its body assumes; i32/pointer params are numeric positions. `ir` must
 *  already be argIR(node)'s result (or ptrKind-appropriate) — this function
 *  itself never emits, only coerces, so it cannot re-decide emit vs
 *  emitIdentitySafe after the fact (see argIR's comment). */
function coerceArg(ir, param, node, repAction = REP_EDGE_REJECT) {
  if (param?.ptrKind != null) {
    // PTR.OBJECT never forwards (FORWARDING_MASK — only ARRAY/HASH/SET/MAP
    // headers relocate on growth), so the offset extracts inline instead of
    // the forwarding-aware __ptr_offset call. The union-cursor clone's cell
    // address rides this; watr's box∘unbox folds then erase the round-trip.
    if (param.ptrKind === VAL.OBJECT) return asPtrOffset(ir, param.ptrKind)
    return ptrOffsetIR(ir, param.ptrKind)
  }
  // Slice 2 (CARRIER PROGRAM, .work/carrier-representation-design.md §7)
  // call-arg def-side wiring — OFF by default (CARRIER_BOX). `param.bigintBoxed`
  // (narrow.js bigintBoxedVerdict, stamped onto sig.params) is the CALL-SITE
  // half of the invariant: this param can't be trusted to receive BIGINT
  // uniformly across every live call site, so a caller passing an actual
  // BigInt value here must box it before the call — the callee then carries
  // an opaque, self-describing pointer through its generic/untyped param path
  // instead of ambiguous raw bits. Only fires when THIS call's argument is
  // itself BIGINT-kinded; a non-bigint argument at the same position needs no
  // change (param.bigintBoxed says nothing about what THIS site passes).
  if (node !== undefined && valTypeOf(node) === VAL.BIGINT) {
    // Is `node` a bare name whose CURRENT storage already IS a real box?
    // Two durable sources, both for the WHOLE current function per their own
    // doc comments (ir.js): isCurrentlyBoxedBigint (the current function's
    // OWN bigintBoxed param, boxed by ITS caller's coerceArg on entry) and
    // isTernaryBoxedBigint (a ternary-nullish BIGINT decl, whose OWN storage
    // IS the box, never a fresh-copy-at-use-site like every other
    // bigintBoxed sink — and, being nullish-typed by construction, may ALSO
    // genuinely hold the null/undefined sentinel at runtime, never a box:
    // both branches below guard on that at runtime, never assume-box or
    // assume-raw statically for a nullable name).
    // Main-stabilization interim flip (ir.js's bigintStrict() doc comment):
    // both directions insert a runtime-conditional box/unbox (nullish-
    // guarded when the argument node could genuinely BE null/undefined at
    // runtime, e.g. a `?:` nullish-BIGINT merge — nodeIsNullishBigintMerge)
    // — the pre-Slice-1 default, restored here — UNLESS bigintStrict() is
    // live, in which case this whole shape (a call-arg whose static kind
    // can't be trusted uniform at the callee, in EITHER crossing direction)
    // is exactly the design's "call-arg" flow class and refuses to compile
    // instead.
    const alreadyBoxed = typeof node === 'string' && (isCurrentlyBoxedBigint(node) || isTernaryBoxedBigint(node))
    const who = typeof node === 'string' ? node : 'this argument'
    const legacyUnbox = alreadyBoxed && !param?.bigintBoxed
    const legacyBox = !alreadyBoxed && param?.bigintBoxed
    // KEEP emits no transform, so retain the legacy no-op/identity decision
    // until producer edges are migrated. Only an explicit BOX/UNBOX action
    // replaces legacy code in this direct-edge slice.
    const legacyEdge = repAction !== REP_EDGE_BOX && repAction !== REP_EDGE_UNBOX
    if (repAction === REP_EDGE_UNBOX || (legacyEdge && legacyUnbox)) {
      if (bigintStrict() && legacyUnbox) bigintEraseErr('call-arg', who)
      // Callee's OWN param settled "receives BIGINT consistently, stays raw
      // at the boundary" (bigintBoxedVerdict, narrow.js) — a verdict computed
      // from EVERY call site's argument STATIC KIND alone, with no idea one
      // of those uniformly-BIGINT-typed arguments is secretly a durable box.
      // Unbox before crossing — the callee's body (readI64-covered arithmetic,
      // OR a boundary re-export) assumes raw i64-as-f64 bits, and hands them
      // straight through unmodified otherwise. Found live: `chain(5)` →
      // `arith(r)` (`r` ternary-boxed, coerceArg correctly passes it through
      // unboxed already — see below) → `hex(r)` (`hex`'s param0 settled
      // "stays raw", `r` is `arith`'s own ALREADY-boxed param) — hex's
      // `v.toString(16)` read the pointer's own bits raw.
      // `typed(['local.get', ...], 'f64')`, NOT a bare array: asI64/asF64
      // (ir.js) dispatch on `.type` to decide the coercion shape, defaulting
      // an UNTAGGED node to "i32, needs f64.convert_i32_s" — found live as a
      // self-compile build failure (WebAssembly.Module() validation: "f64.
      // convert_i32_s[0] expected type i32, found local.get of type f64") —
      // `$t` is a genuine f64 local (temp() mints one), the untagged
      // local.get read of it defaulted straight into that wrong i32 path.
      const t = temp('argbx')
      const tGet = typed(['local.get', `$${t}`], 'f64')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, ir],
        ['if', ['result', 'f64'], isNullish(tGet),
          ['then', tGet],
          ['else', fromI64(unboxBigInt(tGet))]]], 'f64')
    }
    if (repAction === REP_EDGE_BOX || (legacyEdge && legacyBox)) {
      if (bigintStrict() && legacyBox) bigintEraseErr('call-arg', who)
      // The mirror direction (Slice 2's original wiring): callee's param
      // can't be trusted uniformly, box a genuinely-raw argument before the
      // call. `alreadyBoxed` being false also covers the box-of-a-box guard
      // isProvenBoxedBigint's own param exclusion established (Slice 2's
      // "param double-box" bug) — this `if` simply never re-boxes an
      // already-boxed bare name (the case just above already handled it,
      // taking `ir` through unchanged when both callee and caller agree the
      // value crosses as a box). Nullish-guarded for the same reason as the
      // unbox direction above — a nullable-BIGINT argument (proven or
      // unproven-boxed alike) may genuinely be the sentinel at runtime.
      // `tGet` typed 'f64' — see the unbox branch's own comment just above.
      // Nullish-GUARDED only for a node that can genuinely BE null/undefined
      // at runtime (a `?:` nullish-BIGINT merge, nodeIsNullishBigintMerge
      // above) — every other BIGINT-typed argument boxes unconditionally, so
      // a value that merely happens to bit-collide with a reserved sentinel
      // (atomNanHex's own NULL_NAN/UNDEF_NAN construction) still gets boxed,
      // matching what the callee's own bigintBoxed proof assumes (§29).
      if (!nodeIsNullishBigintMerge(node)) return boxBigInt(asI64(ir))
      const t = temp('argbx')
      const tGet = typed(['local.get', `$${t}`], 'f64')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, ir],
        ['if', ['result', 'f64'], isNullish(tGet),
          ['then', tGet],
          ['else', boxBigInt(asI64(tGet))]]], 'f64')
    }
  }
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
  return padArgs(argNodes.map((a, k) =>
    coerceArg(argIR(a), params[k], a, representationCallArgAction(ctx, a, params, k))), params)
}

/** Fuse `a + b` when it tops a string-concat chain of ≥3 leaves: evaluate
 *  each leaf ONCE to an i64 string box (left-to-right — JS ToString order),
 *  measure each with __str_byteLen, allocate the [hash=0][len][bytes]
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
function tryConcatChain(a, b, selfAccum, bufTarget) {
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
  const asBuf = bufTarget != null && headAccum == null
  if (asBuf) inc('__alloc')
  else inc('__alloc', '__mkptr', '__sso_norm')
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
  // asBuf: allocate EXACTLY the bytes (no [hash][len] header — nothing ever
  // reads it back through the header-decoding accessors) and keep the total
  // in its own local rather than the header word, so `.length` reads a plain
  // `local.get` instead of a header re-decode.
  let lenT = null
  if (asBuf) {
    lenT = tempI32('cbl')
    seq.push(['local.set', `$${offT}`, ['call', '$__alloc', totalIR()]])
    seq.push(['local.set', `$${lenT}`, totalIR()])
    seq.push(['local.set', `$${curT}`, ['local.get', `$${offT}`]])
  } else {
    seq.push(['local.set', `$${offT}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], totalIR()]]])
    seq.push(['i32.store', ['local.get', `$${offT}`], ['i32.const', 0]])                       // lazy hash cell
    seq.push(['i32.store', 'offset=4', ['local.get', `$${offT}`], totalIR()])                  // len
    seq.push(['local.set', `$${offT}`, ['i32.add', ['local.get', `$${offT}`], ['i32.const', 8]]])
    seq.push(['local.set', `$${curT}`, ['local.get', `$${offT}`]])
  }
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
  if (!uses || uses.decls !== 1) return false
  for (const u of uses.uses) {
    if (u.kind === USE.MEMBER_R && !u.optional && !u.computed && (u.key === 'length' || u.key === 'charCodeAt')) continue
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
const TYPED_HI_MASK = '0xFFFFFFFF00000000'
function emitSpeculativeCall(callee, spec, argNodes, func) {
  const params = func.sig.params
  const specAt = new Map(spec.guards.map(g => [g.k, g.aux]))
  const rt = func.sig.results[0] || 'f64'
  const seq = [], slots = []
  for (let k = 0; k < params.length; k++) {
    if (k < argNodes.length) {
      const ir = coerceArg(argIR(argNodes[k]), params[k], argNodes[k],
        representationCallArgAction(ctx, argNodes[k], params, k))
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
  const func = ctx.funcs.map.get(name)
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
      // An uninitialized `let x` holds `undefined` until its first assignment —
      // a read may see the sentinel, so arithmetic on it must coerce (same flag
      // as explicit nullish inits below) UNLESS the first reference in
      // evaluation order is an UNCONDITIONAL write (`let ixSq; while ((ixSq =
      // …) …)` — the fractal-kernel shape): definitely-assigned-before-read
      // needs no coercion, and the per-read canon would break the SIMD
      // recognizers' body shapes. i32-narrowed locals are exempt either way:
      // the narrowing proof is assigned-before-read, and they zero-init.
      if (ctx.func.locals.get(i) !== 'i32' && firstRefKind(ctx.func.body, i) !== 'write')
        ctx.func.maybeNullish?.add(i)
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
      for (let j = 0; j < flatDecl.names.length; j++) {
        const v = flatDecl.values[j]
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
    // INVARIANT: this site must NOT switch to storedValue/argIR — the
    // decl-init carrier-width interaction breaks dict rows at O2/O3 (full
    // hunt record: .work/research.md §Carrier invariant, DECL-INIT WALL).
    // Related past fix kept for context (ir.js boxPtrIR/asF64): a
    // ptrKind-tagged i32 pointer reboxing via
    // carrierF64→asF64→boxPtrIR rebuilt its result through `typed()`,
    // which sets ONLY `.type`; the source's `.ptrKind`/`.ptrAux` never
    // propagated to the boxed node. Bits stayed correct, but emitDecl's
    // own P1 plan/emit-parity assert below (inheritPtrAliases,
    // analyze.js) reads those tags off `val` and found them gone: "P1
    // predictor drift: predicted object, emit sees undefined" —
    // deterministic, reproduced in a plain NATIVE build with
    // JZ_DEBUG_INVARIANTS=1 (no wasm target needed; the assert had simply
    // never been armed during a real build before this hunt). That part
    // is fixed: boxPtrIR now carries the source's ptrKind/ptrAux forward
    // under NEW names (`.srcPtrKind`/`.srcPtrAux`, not `.ptrKind`/
    // `.ptrAux` themselves — the ledger's proposed "copy the tags
    // forward" was tried verbatim first and CRASHES: `.ptrKind`/
    // `.ptrAux` are a live DISPATCH convention read by asF64 itself plus
    // truthyIR/writeVar/the matchF64Bits family, all of which treat
    // `.ptrKind != null` as "this node's OWN storage is an unboxed i32
    // offset" with no `.type` re-check — stamping it onto boxPtrIR's
    // f64-typed result made a later asF64 pass over an already-boxed
    // value re-enter boxPtrIR and emit `i64.extend_i32_u` on an f64
    // operand, failing wasm validation). Verified with a fresh forced-
    // invariants native build: zero P1 fires, with or without the decl
    // patch below applied.
    //
    // INVARIANT (export-loss mechanism): the "total export loss" symptom is
    // NOT a native self-compile miscompile — it is this file's OWN
    // local-storage coercion ladder a few lines down (`localType === 'v128'
    // ? val : localType === 'f64' ? asF64(val) : val.type === 'i32' ? val :
    // toI32(val)`, now fixed, see the unboxBoolIR branch inserted there).
    // MECHANISM: for a BOOL-typed init, plain `emit(init)` ALWAYS returns an
    // i32 0/1 (never f64) — the ladder's `val.type === 'i32'` arm always
    // caught it, `toI32` never ran on a BOOL. `storedValue(init)` instead
    // routes a BOOL-typed init through carrierF64→boolBoxIR, producing an
    // F64-TYPED NaN-boxed TRUE/FALSE carrier ATOM (an escape-safe box, not a
    // number). Landing on the SAME ladder with `localType==='i32'` (the
    // local's native WASM storage, chosen independently for a provably-
    // non-escaping BOOL local), `val.type` is now 'f64', so the ladder fell
    // to `toI32(val)` — ECMAScript ToInt32, where NaN → 0. TRUE_NAN and
    // FALSE_NAN are BOTH NaN bit patterns, so toI32 collapsed EVERY boxed
    // boolean to i32 0 — a category error (numeric truncation applied to an
    // opaque bit-pattern atom that needed unboxBoolIR's shift+mask instead).
    // PROOF: native-WAT-diffed self.js compiled with the storedValue patch
    // vs without (scripts/self.js's own `prepare/index.js` defFunc — `const
    // exported = !!ctx.funcs.exports[name] && ctx.module.moduleStack.length
    // === 0`, a BOOL const later read back into the `funcInfo` object
    // literal) showed EXACTLY this: the good build compiles `exported` as a
    // plain `f64.gt`/`i32.eqz` i32 result; the patched build wraps the same
    // comparison in `__mkptr_0_d_` (carrierF64 boxing) then immediately
    // `select(i32.wrap_i64(i64.trunc_sat_f64_s(...)), 0, ...)` — toI32 on the
    // just-built atom. Every function `defFunc` promotes gets `exported`
    // silently pinned to 0 (false) this way, so NO function the resulting
    // kernel ever compiles gets a wasm export clause — confirmed by kernel
    // WAT dumps of a trivial `export let f = (x) => x + 1`: body correct at
    // every optimize level, `(export "f")` missing at O0/O1, and at O2/O3
    // the (correctly, from the optimizer's own perspective) unreferenced
    // unexported function gets DCE'd entirely, `(module)` with zero exports
    // and zero funcs. FIX (landed, this file): the ladder now checks
    // `valTypeOf(init) === VAL.BOOL` before falling to `toI32` and takes
    // ir.js's existing (previously unused) `unboxBoolIR` — bit-extraction,
    // not numeric truncation. NO-OP at HEAD (kernel-parity 33/33 byte-
    // identical, kernel-oracle 451/451): `emit(init)` never produces an f64-
    // typed BOOL, so the new branch is dead code today — it only activates
    // the moment a decl-init call site starts passing a boxed BOOL atom in.
    // PROVEN with the substitution itself: `val = viewInit ||
    // storedValue(init)` PLUS this ladder fix compiles a fresh dist/jz.wasm
    // whose exports are correct at every optimize level (verified live,
    // trivial-program + WAT diff, not assumed).
    //
    // WALL STAYS CLOSED ANYWAY: turning storedValue on here also, separately,
    // surfaces a DIFFERENT divergence unrelated to this mechanism —
    // test/kernel-parity.js's 'dict' corpus entry (`d[c] = (d[c] || 0) + 1`)
    // diverges from native at O2/O3 only (kernel ~3% larger WAT; O0
    // byte-identical) — no BOOL-atom coercion involved, a separate
    // MECHANISM A site (research.md §Carrier invariant's 16 hand-reimplemented
    // `carrierF64(node, emit(node))` sites, or one of the 13 PENDING-FIX
    // oracle rows the design doc already gates production changes behind)
    // getting exercised for the first time with storedValue live at every
    // decl. NOT chased further this session (separate root, separate hunt).
    //
    // STILL BANKED (see .work/research.md §Carrier invariant for the hunt).
    // The dict-O2/O3 divergence ABOVE was in fact
    // named and DISSOLVED: it is `storedValue`'s carrier WIDTH, not the
    // decl-init site itself — `storedValue(init)` boxes EVERY VAL.BOOL-typed
    // init (its non-ambiguous branch is `carrierF64`, which boxes any BOOL,
    // not just an ambiguous BOOL∪NUMBER merge — src/ir.js carrierF64:
    // `valTypeOf(node) === VAL.BOOL ? boolBoxIR(emitted) : asF64(emitted)`),
    // so EVERY plain `let ok = a > b` in self.js's own source got reboxed,
    // reshaping the self-compiled kernel binary pervasively enough to shift
    // watr's inliner decisions for unrelated programs (confirmed via WAT
    // diff: kernel `count$exp` for the dict corpus carried extra inliner
    // boilerplate locals, no changed VALUE computation — a real but
    // avoidable "different compiler, same semantics" artifact). This file's
    // own `argIR` (line ~1195) is EXACTLY the narrower half needed —
    // `hasAmbiguousBoolMerge(node) ? emitIdentitySafe(node) : emit(node)`,
    // whose non-ambiguous branch is the bare `emit(node)` this line already
    // calls — so swapping to `val = viewInit || argIR(init)` should have
    // been byte-identical for every non-ambiguous decl. It WAS: kernel-
    // parity's byte-identity corpus (33/33, dict included) stayed perfectly
    // byte-identical with this substitution live.
    // BUT a SECOND, DIFFERENT self-compile miscompile surfaced that the parity
    // corpus's 11 programs don't exercise: test/kernel-oracle.js's 'closure'
    // AGREE row (`let total = 0; const add = (x) => { total += x; … }`, a
    // captured-and-MUTATED outer binding — jz's `ctx.func.boxed` heap-cell
    // path) — the resulting self-compiled kernel throws
    // `WebAssembly.Module(): ... local.set[0] expected type f64, found
    // local.get of type i32` compiling THIS target program, i.e. produces
    // genuinely INVALID WASM, not just a size/shape difference. Isolated
    // with a 3-way worktree A/B (native diff of scripts/self.js compiled
    // with vs without ONLY this substitution, `wat:true`, no self-compiling
    // needed to reproduce the divergence): the compiled locals inside
    // `src/prepare/index.js`'s `resolveCallee` (an unrelated PREPARE-phase
    // function, calls no boxed-closure logic itself) shift by exactly one
    // synthetic temp name and everything downstream renumbers — consistent
    // with `argIR`'s call-site TEXT change in emitDecl.js shifting the
    // GLOBAL `temp()` counter while compiling THE COMPILER'S OWN source
    // (self.js), which is otherwise harmless UNLESS it happens to collide
    // with a latent watr inliner/local-coalescing sensitivity — exactly the
    // outline-hunt self-compile-miscompile CLASS this ledger has hit and
    // resolved before (export-loss MECHANISM C, above), but a NEW, not yet
    // root-caused instance, confirmed genuinely caused by this substitution
    // via a clean A/B (Parts 1+3 of the same session, which also edit
    // compiler source, build and self-compile CLEANLY — isolates the cause to
    // this exact line, not "any edit to emit.js is unsafe"). Root-causing
    // this precisely (which exact resolveCallee-adjacent decl reacts, and
    // why the renumbering trips watr's optimizer) is a multi-session-class
    // hunt on its own precedent (see the export-loss entry above, itself a
    // dedicated hunt) — NOT closed this session. REVERTED: this line stays
    // `emit(init)`; test/kernel-oracle.js's 'captured-then-read' row stays
    // PENDING-FIX. NEXT: start from `resolveCallee`'s compiled-WAT local
    // shift (native `compile(selfSrc, {wat:true, optimize:false})`, diffed
    // with vs without ONLY the argIR substitution — no self-compile build
    // needed to see the shift) and trace which of its callees'
    // (`isDeclared`/`resolveScope`/`hasFunc`/`includeForCallableValue`)
    // compiled locals actually get inlined into it and why the shift isn't
    // pure renaming.
    // ctx.func._arrayLiteralNeverEscapes (module/array.js's array-literal
    // emitter reads it): a compiler-synthesized decl-destructure array-
    // literal temp (prepare/index.js prepDecl, ctx.schema.arrayVars — see
    // that map's own doc comment there and carrierF64Narrow's, ir.js). A
    // transient CONTEXT FLAG, not a change to the `emit(init)` call itself —
    // this decl-init site is the documented WALL just above (repeated hunts,
    // still banked): swapping this call to storedValue/argIR reshapes the
    // self-compiled kernel's own compiled locals enough to trip a DIFFERENT,
    // unrelated self-compile miscompile. A flag only module/array.js's array-
    // literal emitter consults carries none of that risk — it changes
    // nothing about what `emit(init)` calls or how many temps it mints.
    const neverEscapes = !viewInit && typeof name === 'string' && Array.isArray(init) &&
      init[0] === '[' && ctx.schema.arrayVars?.has(name)
      ? true : ctx.func._arrayLiteralNeverEscapes
    // isTernaryBoxedBigint (ir.js): a decl initialized directly from a
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
    // instead of 2.000000000000001 (.work/carrier-representation-design.md
    // §13/§14). See isTernaryBoxedBigint's own doc comment (ir.js) for the
    // full "why the local's own storage isn't raw here" reasoning and the
    // earlier live incident (`.bigint:toString` on a genuinely ternary-boxed
    // local misread the pointer's bits raw). ctx.func.ternaryBoxedNames
    // (compile/index.js enterFunc), NOT updateRep — this is the emission
    // tier, which passes.js's own exit grep asserts never writes durable
    // analysis state; a per-function transient Set is the established
    // pattern here (maybeNullish/closureAux, same file, same shape).
    if (!viewInit && typeof name === 'string' && Array.isArray(init) && init[0] === '?:' &&
        ((valTypeOf(init[2]) === VAL.BIGINT && nullishArm(init[3])) || (valTypeOf(init[3]) === VAL.BIGINT && nullishArm(init[2]))))
      ctx.func.ternaryBoxedNames?.add(name)
    // Closure-capture identity shadow (kind.js hasAmbiguousBoolMerge; extends
    // 756ae10f's formatter box-at-consumer pattern to the closure-capture
    // consumer — test/kernel-oracle.js's PENDING-FIX 'captured-then-read'
    // row). A captured `let v = cond && 1`-shaped local's OWN value collapses
    // to a raw NUMBER the instant it's stored (valTypeOf(init) already reads
    // NUMBER post-merge, per hasAmbiguousBoolMerge's own doc) — by the time
    // module/function.js's env-slot-store loop reads `v` (a bare name, no
    // expression shape left to inspect), the boolean identity is
    // unrecoverable from the bits alone (0 is bit-identical whether it came
    // from coerced-false or a genuine number arm — emitIdentitySafe's doc
    // explains why only re-deriving via the ORIGINAL control flow is sound).
    // So the box has to happen HERE, at the one point `init` is safely
    // evaluated once — gated on capturedNames (analyze-scans.js's
    // boxedCaptures pre-scan: captured-anywhere, broader than the mutation-
    // gated ctx.func.boxed) so the branch below is DEAD for every decl that
    // isn't both captured AND ambiguous — provably byte-identical to today's
    // plain `emit(init)` for everything else, including (verified live, not
    // assumed — see the self-build gate) every decl in scripts/self.js's own
    // source, keeping this clear of the decl-init WALL a few lines up
    // (storedValue/argIR swapped in HERE, unconditionally, reshaped the
    // self-compiled kernel's own codegen enough to miscompile — research.md
    // §Carrier invariant). identityShadowName, once set, publishes to
    // ctx.func.identityShadow for module/function.js's ctx.closure.make to
    // read back at the env-slot store — see that file's own comment there.
    const identityCapture = typeof name === 'string' && ctx.func.capturedNames?.has(name) && hasAmbiguousBoolMerge(init)
    let identityShadowName = null
    let val = viewInit || withArrayLiteralEscape(neverEscapes, () => {
      if (!identityCapture) return emit(init)
      identityShadowName = `${T}idbox_${name}`
      ctx.func.locals.set(identityShadowName, 'f64')
      // Single evaluation: emitIdentitySafe(init) runs exactly once, teed
      // into the shadow local. Every further use below is a cheap,
      // repeatable local.get — no re-emission of `init`, so a side effect in
      // `init` (a call, say) fires once, matching plain emit(init)'s own
      // contract.
      const setShadow = ['local.set', `$${identityShadowName}`, asF64(emitIdentitySafe(init))]
      const shadowRef = typed(['local.get', `$${identityShadowName}`], 'f64')
      // Derive the plain-number form this decl's OWN local (and every other
      // consumer of `val` below) needs, from that SAME single evaluation:
      // isBoolAtom/unboxBoolIR recognize the boxed TRUE/FALSE atom and
      // extract its bit; anything else is already the correct number
      // (emitIdentitySafe's own invariant — see its doc comment).
      const unboxed = typed(['select',
        ['f64.convert_i32_s', unboxBoolIR(shadowRef)],
        shadowRef,
        isBoolAtom(shadowRef)], 'f64')
      return typed(['block', ['result', 'f64'], setShadow, unboxed], 'f64')
    })
    if (identityShadowName) ctx.func.identityShadow.set(name, identityShadowName)
    val = applyBigintRepresentationAction(val, init, representationBindingWriteAction(ctx, name, init))
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
    } else if (localType === 'i32' && val.type !== 'i32' && isI32ArithTree(init)) {
      // Integer index feeder (`let idx = py*W + qx`) bound to an i32 local: compute
      // it in native wrapping i32 instead of the f64 round-trip + trunc_sat. Bit-
      // identical for an i32 destination (ToInt32 ≡ two's-complement wrap), and the
      // i32.mul is hoistable when loop-invariant. Falls back to toI32 defensively.
      coerced = tryI32Index(init) ?? toI32(val)
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
      coerced = localType === 'v128' ? val : localType === 'f64' ? asF64(val)
        : val.type === 'i32' ? val
        : valTypeOf(init) === VAL.BOOL ? unboxBoolIR(val)
        : toI32(val)
    }
    // `let x = 0` at function scope is normally elided — WASM zero-inits locals. But loop
    // unrolling flattens iteration bodies into one scope, so the 2nd+ `let x = 0` are
    // genuine RE-inits between iterations (e.g. a nested reduce's accumulator). Elide only
    // the FIRST per name; emit the rest as resets. (Names are preserved — no renaming.)
    const zeroInit = isLit(coerced) && coerced[1] === 0 && !Object.is(coerced[1], -0) && !ctx.func.stack.length
    if (!zeroInit || ctx.func.zeroInitSeen?.has(name)) {
      result.push(['local.set', `$${name}`, coerced])
      // Record the def node (by reference, not a copy) so stripCanon's single-use
      // hoist-temp lookup (see isHoistTemp above) can mutate it in place later.
      if (localType === 'f64' && isHoistTemp(name)) (ctx.func.hoistTempDefs ??= new Map()).set(name, coerced)
    } else (ctx.func.zeroInitSeen ??= new Set()).add(name)

    const schemaId = ctx.schema.idOf?.(name)
    if (ctx.func.localProps?.has(name) && schemaId != null) {
      const schema = ctx.schema.resolve(name)
      if (schema?.[0] === '__inner__') {
        inc('__alloc_hdr', '__mkptr')
        const bt = `${T}bx${freshId(ctx)}`
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
    const sidx = `${T}sidx${freshId(ctx)}`
    ctx.func.locals.set(sidx, 'i32')
    const loopId = freshId(ctx)
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
        const it = `${T}ai${freshId(ctx)}`
        ctx.func.locals.set(it, 'f64')
        sec.itemLocals.push(it)
        ir.push(['local.set', `$${it}`, asF64(emit(sec.items[i]))])
      }
    } else {
      sec.local = `${T}sp${freshId(ctx)}`
      ctx.func.locals.set(sec.local, 'f64')
      sec.lenLocal = `${T}spl${freshId(ctx)}`
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
  const frame = ctx.func
  const prevValOverlay = frame.localValTypesOverlay
  frame.localValTypesOverlay = new Map(prevValOverlay || [])
  // Nested-assignment blocklist for this block. Per-block own-scan is sufficient:
  // an outer name whose fact was blocked in the outer block never entered the
  // outer overlay (which this block's overlay copies), and a name reassigned at
  // THIS block's top level re-records right after the assignment (dominating the
  // rest of this block) — the scan blocks exactly the recordings that don't
  // dominate their possible staleness point.
  const prevFlowBlocked = frame.flowValBlocked
  frame.flowValBlocked = collectNestedAssigns(stmts)
  try {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i]
      if (s == null || typeof s === 'number') continue
      out.push(...emitVoid(s))
      // `let`/`const` decls self-record via emitDecl; only a bare reassignment needs it here.
      if (Array.isArray(s) && s[0] === '=' && typeof s[1] === 'string') setFlowVal(s[1], valTypeOf(s[2]))
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
    frame.localValTypesOverlay = prevValOverlay
    frame.flowValBlocked = prevFlowBlocked
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

// .work/todo.md §deletion-sweep — identity-safe re-emission of an
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
export function emitIdentitySafe(node) {
  if (!Array.isArray(node) || !hasAmbiguousBoolMerge(node)) return emit(node)
  const [op] = node
  if (op === '?:') {
    const [, a, b, c] = node
    const ca = emit(a)
    if (isLit(ca)) { const v = litVal(ca); return (v !== 0 && v === v) ? emitIdentitySafe(b) : emitIdentitySafe(c) }
    const cond = toBoolFromEmitted(ca)
    const thenRefs = extractRefinements(a, new Map(), true)
    const elseRefs = extractRefinements(a, new Map(), false)
    const vb = withRefinements(thenRefs, b, () => emitIdentitySafe(b))
    const vc = withRefinements(elseRefs, c, () => emitIdentitySafe(c))
    const vtbM = resolveValType(b, valTypeOf, lookupValType)
    const vtcM = resolveValType(c, valTypeOf, lookupValType)
    const fb = vtbM === VAL.BOOL ? boolBoxIR(vb) : asF64(vb)
    const fc = vtcM === VAL.BOOL ? boolBoxIR(vc) : asF64(vc)
    const ib = ['i64.reinterpret_f64', fb], ic = ['i64.reinterpret_f64', fc]
    const bits = eagerSelectOK(fb, fc) && selectCondOK(cond)
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
    const t = temp()
    const fa = vtA === VAL.BOOL ? boolBoxIR(va) : asF64(va)
    const fb0 = withRefinements(refs, b, () => emitIdentitySafe(b))
    const fb = vtB === VAL.BOOL ? boolBoxIR(fb0) : asF64(fb0)
    const teedCond = toBoolFromEmitted(typed(['local.tee', `$${t}`, fa], 'f64'))
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
    const fa = vtA === VAL.BOOL ? boolBoxIR(va) : asF64(va)
    const fb0 = emitIdentitySafe(b)
    const fb = vtB === VAL.BOOL ? boolBoxIR(fb0) : asF64(fb0)
    return typed(['if', ['result', 'f64'],
      ['i32.eqz', isNullish(['local.tee', `$${t}`, fa])],
      ['then', ['local.get', `$${t}`]],
      ['else', fb]], 'f64')
  }
  return emit(node)
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

function emitLooseEq(a, b, negate, strict) {
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
  const o = `${T}po${freshId(ctx)}`,
        sa = `${T}psa${freshId(ctx)}`,
        sl = `${T}psl${freshId(ctx)}`,
        ol = `${T}pol${freshId(ctx)}`,
        si = `${T}psi${freshId(ctx)}`,
        base = `${T}pb${freshId(ctx)}`
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
  const arr = `${T}sp${freshId(ctx)}`
  const len = `${T}splen${freshId(ctx)}`
  const idx = `${T}spidx${freshId(ctx)}`
  ctx.func.locals.set(arr, 'f64'); ctx.func.locals.set(len, 'i32'); ctx.func.locals.set(idx, 'i32')
  // Emission-minted temp seed → transient overlay (slice 3c-a class): the fresh
  // spread-staging local's VT rides the overlay for the loop-body IR generation.
  // Without it, the body's `[]` read on `arr` falls back to polymorphic dispatch —
  // VAL.* elides the STRING gate for ARRAY/TYPED spreads. Durable reps stay clean.
  const spreadVT = valTypeOf(spreadExpr)
  if (spreadVT) ctx.func.localValTypesOverlay.set(arr, spreadVT)
  inc('__len')
  const n = multiCount(spreadExpr)
  const loopId = freshId(ctx)
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
  return withExpectedValue(null, fn)
}

function emitSingleSpreadMethodCall(objArg, parsed, method, methodEmitter) {
  const inPlace = SPREAD_MUTATORS.has(method)
  // unshift prepends each arg to the front — forward iteration reverses intent.
  const reverse = method === 'unshift'
  const acc = `${T}acc${freshId(ctx)}`
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
      const t = `${T}usv${freshId(ctx)}`
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
  const acc = inPlace ? null : `${T}acc${freshId(ctx)}`
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
        const t = `${T}ussp${freshId(ctx)}`
        ctx.func.locals.set(t, 'f64')
        ir.push(['local.set', `$${t}`, asF64(emitAsValue(() => emit(item[1])))])
        segs.push(['spread', t])
      } else {
        const t = `${T}usv${freshId(ctx)}`
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

// 2. String-buffer SRoA: `line.charCodeAt(j)` where `line` was dissolved into
// raw (buf, len) locals by tryConcatBufferDecl (emit.js, above) — a bare byte
// load, never the SSO-vs-heap dispatch (we KNOW it's a plain heap region we
// just wrote: no __mkptr/__sso_norm ever ran on it, so there is no SSO
// representation to test for). MUST run before tryCharCodeAtFast below: a
// dissolved `line` has no `$line` local — falling into the param/generic
// paths would emit `local.get $line` for a binding that no longer exists.
// Still bounds-checks unless inBoundsCharCodeAt separately proves the index
// safe — concatBufEligible only proves every USE is length/charCodeAt, not
// that every index is in range.
function tryConcatBufCharCodeAt(callee, obj, method, parsed) {
  if (method !== 'charCodeAt' || parsed.hasSpread || parsed.normal.length !== 1 || typeof obj !== 'string') return
  const bufR = ctx.func.concatBufs?.get(obj)
  if (!bufR) return
  const rawLoad = (i) => ['f64.convert_i32_u', ['i32.load8_u', ['i32.add', ['local.get', `$${bufR.buf}`], i]]]
  if (inBoundsCharCodeAt(ctx).has(callee))
    return typed(rawLoad(asI32(emit(parsed.normal[0]))), 'f64')
  const idxIR = asI32(emit(parsed.normal[0]))
  if (isLeaf(idxIR))
    return typed(['if', ['result', 'f64'],
      ['i32.ge_u', idxIR, ['local.get', `$${bufR.len}`]],
      ['then', oobNanIR()],
      ['else', rawLoad(idxIR)]], 'f64')
  const t = tempI32('cbi')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, idxIR],
    ['if', ['result', 'f64'],
      ['i32.ge_u', ['local.get', `$${t}`], ['local.get', `$${bufR.len}`]],
      ['then', oobNanIR()],
      ['else', rawLoad(['local.get', `$${t}`])]]], 'f64')
}

// 2b. charCodeAt with a statically in-bounds index — emit the i32 (OOB-impossible)
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
  if (typeof obj === 'string' && ctx.funcs.names.has(obj) && !ctx.funcs.multiProp.has(`${obj}.${method}`)) {
    const fname = `${obj}$${method}`
    if (ctx.funcs.names.has(fname)) {
      const func = ctx.funcs.map.get(fname)
      const emittedArgs = emitCallArgs(parsed.normal, func.sig.params)
      // Drop extras like the plain-call path (emit.js regular-call arm): the dyn
      // closure ABI absorbed over-arity (`parse.enter?.(p, end)` on a 0-param
      // hook), but a devirtualized direct call pushes exactly sig arity — extras
      // would be stack leftovers (asi.js's parse.enter broke the self-compile here).
      if (emittedArgs.length > func.sig.params.length) emittedArgs.length = func.sig.params.length
      return attachSigMeta(typed(['call', `$${fname}`, ...emittedArgs], func.sig.results[0]), func.sig)
    }
  }
}

const LEADING_STRATEGIES = [tryFlatObjectMethod, tryConcatBufCharCodeAt, tryCharCodeAtFast, trySpliceInsert, tryFnPropCall]

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
    const t = `${T}rt${freshId(ctx)}`, tt = `${T}rtt${freshId(ctx)}`
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
    // Only a genuinely mayBeUndefined receiver pays for the
    // nullish-receiver guard below — `censusMaybeUndefined` (kind.js), the
    // SAME narrow, load-bearing predicate module/core.js's emitLengthAccess
    // uses (see its own comment for why "vt is unknown" alone is far too
    // broad — a real, measured SIZE-geomean regression across the size-
    // sweep corpus, caught before landing). A plain kind-unresolved-but-
    // never-null receiver takes the unchanged, unguarded generic arm.
    const mayBeUndef = censusMaybeUndefined(obj)
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
            // Not STRING either: a real (non-nullish) pointer falls to the generic
            // (array-shaped) emitter, unchanged. A genuinely nullish receiver here
            // (e.g. `m.get('missing').slice()`, a STRING-census absent
            // read — no proven vt, so it reached this fork at all) used to feed the
            // nullish sentinel's bit pattern to the ARRAY-shaped emitter as if it
            // were a real pointer — an OOB heap read (`RuntimeError: memory access
            // out of bounds`). Real JS throws TypeError for a method call on
            // null/undefined; the check is cheap and lands only on this already-
            // dynamic fork, and only when the receiver is provably mayBeUndefined.
            ['else', mayBeUndef ? typed(['if', ['result', 'f64'],
              isNullish(typed(['local.get', `$${t}`], 'f64')),
              ['then', throwTypeErrorIR()],
              ['else', callMethod(t, genEmitter)]], 'f64') : callMethod(t, genEmitter)]])]])
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
  const t = `${T}rn${freshId(ctx)}`
  ctx.func.locals.set(t, 'f64')
  // Only a genuinely mayBeUndefined receiver pays for the nullish
  // guard — same `censusMaybeUndefined` predicate as every other check in
  // this design (see tryRuntimeStringFork's comment for the measured SIZE
  // cost of gating on "vt unknown" alone instead).
  const mayBeUndef = censusMaybeUndefined(obj)
  return block64(
    ['local.set', `$${t}`, asF64(emit(obj))],
    ['if', ['result', 'f64'],
      ['f64.eq', ['local.get', `$${t}`], ['local.get', `$${t}`]],
      ['then', asF64(callMethod(t, numEmitter))],
      // A genuinely nullish receiver here (e.g. `m.get('missing').toFixed(2)`,
      // a NUMBER-census absent read — no proven vt, so this fork engaged at all) has no
      // sidecar override to find; real JS throws TypeError on the PROPERTY READ itself
      // (`x.toFixed` on null/undefined), before any call happens. A real (non-nullish)
      // pointer without an override still reads `undefined` (own-property-not-found is
      // out of this fix's scope — the pre-existing, unchanged behavior).
      ['else', sidecarOverride(typed(['local.get', `$${t}`], 'f64'), asI64(emit(['str', method])),
        (p) => ctx.closure.call(typed(['local.get', `$${p}`], 'f64'), parsed.normal),
        (o) => mayBeUndef ? typed(['if', ['result', 'f64'],
          isNullish(typed(['local.get', `$${o}`], 'f64')),
          ['then', throwTypeErrorIR()],
          ['else', undefExpr()]], 'f64') : undefExpr())]])
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
  // above: it is what lets self-compile user methods whose names collide with
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
    const closureOnly = usesDynProps(vt) || !ctx.transform.targetProfile.envImports
    inc('__dyn_get_expr', '__ptr_type')
    if (!closureOnly) { inc('__ext_call'); setLinkDemand('external') }
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
  // RequireObjectCoercible (ES 13.3 — the nullish-receiver
  // check) must run BEFORE the target-capability branch below chooses
  // host `__ext_call` dispatch vs the wasi no-op stub — a member-access
  // semantic, not a dispatch-strategy detail. The nullish check
  // originally lived AFTER the `!envImports` early return a few lines down:
  // under host:'wasi' (envImports always false) that return fired first on
  // EVERY call reaching this TOTAL fallback, so the check below it was dead
  // code — a genuinely nullish receiver (e.g. `m.get('missing').toFixed(2)`
  // with no closures anywhere else in the program, so strategy 8b never
  // engaged) silently read `undefined` instead of throwing, while the
  // identical js-host build (envImports=true) reached the same check and
  // threw correctly. `censusMaybeUndefined` is the same narrow, load-bearing
  // gate every other site in this design uses (see tryRuntimeStringFork's
  // comment for the measured SIZE cost of gating on "vt unknown" alone
  // instead) — a receiver that is provably never nullish takes the ORIGINAL,
  // byte-identical path below, unaffected by this fix.
  const mayBeUndef = censusMaybeUndefined(obj)
  const dispatch = (recv) => {
    // Under wasi there is no host `__ext_call` — the call lowers to a
    // no-op returning `undefined`. This is by-design so polymorphic code
    // can target js and wasi from one source; users who want fail-fast
    // pass `strict: true` (handled above).
    if (!ctx.transform.targetProfile.envImports) return undefExpr()
    warnDeopt('deopt-method', `method call \`${typeof obj === 'string' ? obj : '<expr>'}.${method}(…)\` on a value whose type couldn't be resolved dispatches through the JS host (\`__ext_call\`) — a wasm→JS round-trip per call, orders of magnitude slower than a direct call. Restructure so the receiver's type is provable, or keep it off the hot path.`)
    inc('__ext_call')
    setLinkDemand('external')
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const arrayIR = buildArrayWithSpreads(combined)
    return typed(['f64.reinterpret_i64', ['call', '$__ext_call',
      ['i64.reinterpret_f64', recv],
      ['i64.reinterpret_f64', asF64(emit(['str', method]))],
      ['i64.reinterpret_f64', arrayIR]]], 'f64')
  }
  if (!mayBeUndef) return dispatch(asF64(emit(obj)))
  // Evaluate the receiver once, guard first, THEN pick the host/no-op
  // dispatch strategy for the non-null arm — the method name/args are only
  // evaluated on that arm (matches real JS: GetV(obj,'method') on a
  // nullish base throws before Arguments is ever evaluated).
  const rt = temp('mrecv')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${rt}`, asF64(emit(obj))],
    ['if', ['result', 'f64'],
      isNullish(typed(['local.get', `$${rt}`], 'f64')),
      ['then', throwTypeErrorIR()],
      ['else', dispatch(typed(['local.get', `$${rt}`], 'f64'))]]], 'f64')
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
  const func = ctx.funcs.map.get(callee)

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
                    : parsed.normal.map(a => coerceArg(argIR(a), undefined, a))
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
    const ctor = typeof arg === 'string' && valTypeOf(arg) === VAL.TYPED ? (ctx.func.typedElem?.get(arg) ?? null) : null
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
  // the body never assumes raw numerics for these slots). An ambiguous BOOL-merge
  // arg (.work/todo.md §deletion-sweep) needs emitIdentitySafe in place of
  // carrierF64 — same post-hoc-powerless reasoning as the return tail/store sites.
  recordClosureCallRepresentations(ctx, bodyName, parsed.normal)
  const slots = parsed.normal.map(a => hasAmbiguousBoolMerge(a) ? emitIdentitySafe(a) : carrierF64(a, emit(a)))
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

/** Closure-TABLE call-site PARAM lattice — evidence side. `arrName` is a
 *  proven-safe table (ctx.scope.closureTableLatticeCandidates, dyn-closure-
 *  tables.js): every call `arrName[idx](args)` accumulates into a per-array-
 *  name row, exactly the reduction tryDirectClosureCall runs per bodyName
 *  (numeric AND-join, typed-ctor agreement, min arg count) — just keyed by
 *  the ARRAY name since the literal (and therefore its elements' bodyNames)
 *  hasn't emitted yet at this call site's own emit time. A dynamic index
 *  means ANY element could be the one invoked, so every call site's evidence
 *  is conservatively applied to every element alike when the array literal
 *  resolves it (isGlobal decl path, below). Also fires for the IMPERATIVE-
 *  construction class (ctx.scope.imperativeClosureTableLatticeCandidates,
 *  dyn-closure-tables.js) — same accumulator, resolved by compile/index.js's
 *  early-merge step instead of the const-literal decl's own emit time. */
function recordClosureTableCallSite(arrName, argNodes) {
  const W = ctx.closure.width ?? MAX_CLOSURE_ARITY
  const n = Math.min(argNodes.length, W)
  const evid = (ctx.scope.closureTableArgEvidence ||= new Map())
  let e = evid.get(arrName)
  if (!e) evid.set(arrName, e = { numRow: [], tcRow: [], minArgc: undefined })
  for (let i = 0; i < n; i++) {
    const arg = argNodes[i]
    const numeric = valTypeOf(arg) === VAL.NUMBER
    e.numRow[i] = e.numRow[i] === undefined ? numeric : (e.numRow[i] && numeric)
    const ctor = typeof arg === 'string' && valTypeOf(arg) === VAL.TYPED ? (ctx.func.typedElem?.get(arg) ?? null) : null
    e.tcRow[i] = e.tcRow[i] === undefined ? ctor : (e.tcRow[i] !== ctor ? null : e.tcRow[i])
  }
  e.minArgc = e.minArgc === undefined ? n : Math.min(e.minArgc, n)
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

/** Generic closure call: callee is a value holding a NaN-boxed closure pointer.
 *  Uniform convention: fn.call packs all args into an array and trampolines. */
function emitGenericClosureCall(callee, parsed) {
  const arrName = !parsed.hasSpread && Array.isArray(callee) && callee[0] === '[]' && typeof callee[1] === 'string'
    ? callee[1] : null
  const dvName = (ctx.transform.optFlags & OPTF.devirtClosureTables) && arrName ? arrName : null
  if (arrName && (ctx.scope.closureTableLatticeCandidates?.has(arrName) ||
      ctx.scope.imperativeClosureTableLatticeCandidates?.has(arrName)))
    recordClosureTableCallSite(arrName, parsed.normal)
  // `callee` is a genuinely dynamic expression here — every
  // statically-resolved shape (known top-level function, direct non-escaping
  // closure, method call) was already sifted off by the '()' dispatcher above
  // this function, so its kind is unproven and it may be nullish at runtime
  // (e.g. `m.get('missing')()`, a census-shaped dict/Map absent-key read).
  // ctx.closure.call's call_indirect reads the nullish sentinel's aux bits as
  // a function-table index unconditionally — an out-of-bounds wasm trap,
  // uncatchable in-source ("table index out of bounds"). Real JS throws
  // TypeError.
  //
  // A BARE-NAME callee (`typeof callee === 'string'`, e.g. `f(x)`) is emitted
  // TWICE instead of hoisted through a shared temp — found live, not assumed
  // safe: an intermediate `local.set $ct = (select const1 const2 cond); ...
  // call_indirect(local.get $ct, ...)` hides the "closure value is a select
  // of ≤2 known constants" shape from watr's own post-optimizer devirt pass
  // (perf(wat) "devirt — call_indirect with known closure constants → guarded
  // direct calls", commit 4c49c2ec) — that pass pattern-matches the select
  // directly feeding the call_indirect operand's `local.set`, one level of
  // indirection it does not trace through. `readVar` (ir.js) is pure for a
  // bare name (`local.get`/`global.get`, no side effect, no shared node
  // object between the two emissions — each `emit(callee)` call returns a
  // fresh IR node), so evaluating it twice is exactly as safe as the
  // single-eval case and costs nothing extra once optimized (V8/watr CSE the
  // repeated load). A COMPOUND callee (`m.get(k)()`, `arr[i]()`) may carry a
  // real side effect (the `.get` call itself) — hoisted through a temp,
  // exactly as before; this shape was never the ternary-select-of-constants
  // pattern the devirt pass targets, so hoisting it costs nothing there.
  // Only a genuinely mayBeUndefined callee pays for the guard —
  // same `censusMaybeUndefined` predicate as every other check in this
  // design (tryRuntimeStringFork's comment has the measured SIZE cost of
  // gating on "unresolved kind" alone instead). A callee that is unresolved
  // only because it's a PLAIN closure-holding parameter/local (never
  // touched by census/dict machinery — e.g. `const pass = (g, x) => g(x)`)
  // is unaffected, byte-for-byte, from before this task.
  const mayBeUndef = censusMaybeUndefined(callee)
  const pureCallee = typeof callee === 'string'
  const guarded = (whenOk) => {
    if (!mayBeUndef) return asF64(whenOk(asF64(emit(callee))))
    if (pureCallee) return typed(['if', ['result', 'f64'],
      isNullish(asF64(emit(callee))),
      ['then', throwTypeErrorIR('call')],
      ['else', asF64(whenOk(asF64(emit(callee))))]], 'f64')
    const ct = temp('gcallee')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${ct}`, asF64(emit(callee))],
      ['if', ['result', 'f64'],
        isNullish(typed(['local.get', `$${ct}`], 'f64')),
        ['then', throwTypeErrorIR('call')],
        ['else', asF64(whenOk(typed(['local.get', `$${ct}`], 'f64')))]]], 'f64')
  }
  if (parsed.hasSpread) {
    const combined = reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    const arrayIR = buildArrayWithSpreads(combined)
    // Pass pre-built array as single already-emitted arg
    return guarded(recv => ctx.closure.call(recv, [arrayIR], true))
  }
  const ir = guarded(recv => ctx.closure.call(recv, parsed.normal))
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

// Compound-assign arithmetic op → i64 op suffix. Mirrors the binary '+'/'-'/'*'/
// '/'/'%' BIGINT arms' own wasm ops exactly — no shared table exists for these
// elsewhere; the i64 suffixes differ from the f64/i32 ones only in '/' and '%'
// needing the signed variant (div_s/rem_s).
const I64_ARITH_OP = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div_s', '%': 'rem_s' }

/** Compound assignment: read → op → write back (via readVar/writeVar).
 *  `arithOp` (one of '+' '-' '*' '/' '%') is the base symbol for BigInt routing;
 *  omit it for ops that only exist elsewhere for BigInt (this fn is never called
 *  for '&='/etc — those have their own i64 gate right below in the dispatch table). */
function compoundAssign(name, val, f64op, i32op, arithOp) {
  if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}'`)
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
    return writeVar(name, fromI64([`i64.${I64_ARITH_OP[arithOp]}`, readI64(name, readVar(name)), bigIntOperand(val)]), void_)
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

// Ring 0.3 (re-landed after the dispatch rework dropped the uncommitted original):
// JS makes BigInt⊕Number arithmetic a TypeError. Enforce it exactly where the mix
// is PROVABLE from source — one side proven BIGINT, the other a NUMERIC LITERAL —
// and stay permissive otherwise: kernel carriers read NUMBER as a kind-DEFAULT
// (not a proof), so rejecting proven-BIGINT × default-NUMBER breaks sound kernels.
// A ZERO literal is exempt from the proof: `0n`'s i64 carrier is bit-identical
// to the number 0.0, so under self-compile `[, 0n]` degrades to `[, 0]` and typeof
// cannot tell them apart — treating literal 0 as proven-number falsely rejects
// `0n | 5n` in-kernel. Cost: a literal-0 mix (`0 | 5n`) is accepted (permissive,
// per the policy above) instead of throwing.
const numLiteralNode = (n) =>
  (typeof n === 'number' && n !== 0) ||
  (Array.isArray(n) && n[0] == null && typeof n[1] === 'number' && n[1] !== 0)
function bigintMixReject(op, a, b) {
  if (b === undefined) return
  // mayBeUndefined join (Slice 3, .work/todo.md §deletion-sweep
  // §4 — the "NEWLY added to that list" gap): a BIGINT claim whose only proof
  // is a maybeUndefined-flagged dict/Map census read (arm 1/2, censusMaybeUndefined's
  // direct node shapes) or a bare name that copies one through (arm 3, the REP
  // fallback) is NOT a provable BIGINT for THIS compile-time TypeError check —
  // the operand could be real `undefined` at runtime, and ToNumeric(undefined)
  // is the Number NaN, not a BigInt, so real JS does NOT throw when the other
  // side is a genuine number (only bigIntOperand's runtime UNDEF_NAN guard,
  // needs to actually decide the throw at the point the real
  // type resolves). Treating this operand as unproven here — same direction
  // as every other censusMaybeUndefined consumer in this file — falls through
  // to the permissive default instead of wrongly rejecting a mix that's sound
  // in real JS whenever the operand turns out to be undefined.
  const aBig = valTypeOf(a) === VAL.BIGINT && !censusMaybeUndefined(a)
  const bBig = valTypeOf(b) === VAL.BIGINT && !censusMaybeUndefined(b)
  if (aBig === bBig) return
  if (numLiteralNode(aBig ? b : a))
    err(`Cannot mix BigInt and other types in \`${op}\` (TypeError in JS) — convert explicitly with BigInt() or Number()`)
}

// §14 point 4 (audit #10, .work/todo.md §deletion-sweep §14):
// JOINT runtime-domain dispatch for binary arithmetic/bitwise ops, superseding
// the old per-op OR-gate (`valTypeOf(a)===BIGINT||valTypeOf(b)===BIGINT`, live
// at every op below through 38dd0dca/f1c1256b) and Slice 7's `+`-only AND-gate
// (`bothBigIntOperands`, removed here). Both were OPERAND-LOCAL guards — each
// decided ONE operand's fate from a static claim alone, so neither could
// distinguish "both operands genuinely absent" (JS: NaN, no throw —
// ToNumeric(undefined) is a Number on both sides) from "one operand absent,
// the other a real BigInt" (JS: TypeError) from "a proven BigInt paired with
// a real, non-BigInt dynamic value" (JS: TypeError, f1c1256b's own pinned
// KNOWN-FAIL) — three DIFFERENT runtime outcomes that collapse to the
// identical static shape (bigintMixReject's own "operand-local guards are
// architecturally insufficient" citation). Fixed: evaluate each operand
// EXACTLY ONCE (ES2024 13.15.3 steps 1-4 — GetValue happens before
// ToNumeric), classify EACH operand's REAL runtime domain, then dispatch on
// the JOINT result: both Number → the plain numeric op; both BigInt → the
// existing i64 op; mixed → TypeError (13.15.3 step 6 / 13.2.* "Type(lnum) is
// not Type(rnum)").
//
// bigIntDomain(node) — the STATIC evidence available for one operand:
//   'bigint' — valTypeOf(node) === VAL.BIGINT: a PROVEN claim, never
//              maybeUndefined (censusMaybeUndefinedKind never feeds `val` —
//              the permanent invariant §14's Slice-4 revert restored).
//              Always a real BigInt at runtime — no runtime check needed.
//   'number' — a plain numeric LITERAL (bigintMixReject's own numLiteralNode)
//              ONLY — always a real Number, no runtime check needed.
//              Deliberately NOT `valTypeOf(node) === VAL.NUMBER` in general:
//              that claim can be a kind-DEFAULT, not a proof (bigintMixReject's
//              own doc comment — "kernel carriers read NUMBER as a kind-
//              DEFAULT" — the SAME reason it only ever rejects a LITERAL
//              mismatch, never a general NUMBER-claimed expression). Confirmed
//              live, not assumed: layout.js's `i64Hex` (part of the self-compile
//              graph) and a self-compiled-build-only inlined-local shape both
//              mix a `valTypeOf===NUMBER`-optimistic-default operand with a
//              real BigInt LITERAL/expression on purpose — treating that
//              NUMBER claim as throw-worthy broke the self-compiled kernel
//              build outright (caught by the gate, not assumed safe).
//   'census' — censusMaybeUndefinedKind(node) === VAL.BIGINT: the container
//              proves its value is BIGINT whenever present, but PRESENCE
//              itself is runtime-only — needs isUndef: present → BigInt,
//              absent → Number (ToNumeric(undefined) is the Number NaN,
//              never a BigInt — ES2024 13.5.6/7.1.3).
//   null     — no static evidence either way, but ELIGIBLE for the runtime
//              magnitude heuristic (below) — a NEVER-REASSIGNED parameter of
//              the CURRENT function, AND that function is itself a WASM
//              EXPORT — crossing the JS↔wasm boundary directly from the host
//              caller (f1c1256b's own named shape, `export let f = (v, w) =>
//              { let x = BigInt(v); return x - w }`).
//   'skip'   — no static evidence AND not safe to runtime-probe — every other
//              unresolved shape (a reassigned local, a non-param expression,
//              or a param of a NON-exported internal function). See the
//              heuristic's own scoping note below for why both restrictions
//              (never-reassigned AND exported-function-only) are required.
function bigIntDomain(node) {
  const vt = valTypeOf(node)
  if (vt === VAL.BIGINT) return 'bigint'
  if (numLiteralNode(node)) return 'number'
  if (censusMaybeUndefinedKind(node) === VAL.BIGINT) return 'census'
  // The runtime magnitude heuristic (`typeof x === 'bigint'`'s own subnormal-
  // abs check, reused as isBigIntCarrierBits below) is ONLY reliable for a
  // SMALL-magnitude value — a genuinely LARGE or negative BigInt's raw bits
  // do NOT read as subnormal, so applying it to an arbitrary internally-
  // computed value produces FALSE positives (a real large bigint misread as
  // "not bigint", wrongly throwing a TypeError on otherwise-correct code).
  // Confirmed live, not assumed — TWO separate self-compile regressions, both
  // caught by the gate, neither a hypothetical:
  //  (1) watr's own self-compiled i64 LEB128 encoder (node_modules/watr/src/
  //      encode.js `i64()` — `n` REASSIGNED across a conditional diamond via
  //      `BigInt(n)`/`i64.parse(n)`, later `n & 0x7Fn`, where `n` can
  //      genuinely be any 64-bit magnitude) — closed by the never-reassigned
  //      restriction below.
  //  (2) layout.js's `i64Hex` (`bits => ... (bits >> 32n) & 0xFFFFFFFFn ...`)
  //      — `bits` is a NEVER-reassigned param, but `i64Hex` is an ordinary,
  //      NON-EXPORTED internal helper: its argument is computed entirely
  //      WITHIN the compiled program (arbitrary magnitude, no host-boundary
  //      assurance at all) — unlike a genuine WASM EXPORT's own param, whose
  //      representation interop.js's marshalling actually constrains. Closed
  //      by requiring the CURRENT function itself be a WASM export.
  // Every other unresolved shape stays 'skip' — `bigIntDomainsCanMix` treats
  // it as NO evidence at all, falling through to whatever the PRE-EXISTING
  // (pre-§14-point-4) code path already did — unaffected.
  if (ctx.func.exported && typeof node === 'string' && ctx.func.current?.params?.some(p => p.name === node) &&
      !(ctx.func.body && isReassigned(ctx.func.body, node))) return null
  return 'skip'
}

// Runtime "is this f64 bit pattern a BigInt carrier" heuristic — mirrors
// TYPEOF.bigint's own arm verbatim (finite, nonzero, subnormal magnitude),
// the SAME documented, permanent divergence that arm already accepts (a
// genuinely tiny subnormal-magnitude real Number misclassifies as bigint) —
// not a new heuristic, reused at a second call site (not factored into a
// shared helper: TYPEOF.bigint's own local.tee shape is a live, pinned WAT
// structural site — duplicating these 3 lines carries zero regression risk
// there; sharing would). `get` must already be a side-effect-free
// `local.get` — the caller has already materialized the operand into a temp.
const isBigIntCarrierBits = (get) => ['i32.and',
  ['f64.eq', get, get],
  ['i32.and',
    ['f64.ne', get, ['f64.const', 0]],
    ['f64.lt', ['f64.abs', get], ['f64.const', 2.2250738585072014e-308]]]]

// Does this binary node need the joint runtime dispatch, or can it keep its
// existing fast path / stay on the fully generic numeric path untouched
// (both required structural pins — proven-single-domain sites, byte-
// identical)? `allowUnresolved` is false for `+`: a fully unresolved operand
// there could ALSO be a runtime STRING, which `+` must keep routing through
// its own STRING-coercion dispatch (above this check in the '+' table entry)
// — not this BigInt-only one. Every other op ToNumeric()s unconditionally
// (no STRING branch exists for them), so a `null` domain is a safe
// runtime-heuristic target.
function bigIntDomainsCanMix(a, b, allowUnresolved) {
  const domA = bigIntDomain(a), domB = bigIntDomain(b)
  // 'skip' (bigIntDomain's own doc comment): never eligible for the runtime
  // heuristic — falls through to whatever the pre-existing code path already
  // did for this operand, unaffected by this whole mechanism.
  if (domA === 'skip' || domB === 'skip') return false
  if (!allowUnresolved && (domA == null || domB == null)) return false
  if (domA !== 'bigint' && domA !== 'census' && domB !== 'bigint' && domB !== 'census') return false
  return !(domA === 'bigint' && domB === 'bigint')   // both proven-same → existing fast path, byte-identical
}

// The joint dispatch itself. `i64Compute(i64A, i64B)` builds the untyped i64
// IR for the BigInt-domain result (mirrors each op's existing bigIntOperand-
// fed expression); `numCompute(f64A, f64B)` builds the f64-typed IR for the
// Number-domain result (mirrors each op's existing generic-numeric
// expression). Both receive the operand ALREADY evaluated into a temp local
// (`local.get`) — `emit(a)`/`emit(b)` run exactly once each, here.
function bigIntJointDispatch(a, b, i64Compute, numCompute) {
  const domA = bigIntDomain(a), domB = bigIntDomain(b)
  const ta = temp('bigJ'), tb = temp('bigJ')
  const getA = ['local.get', `$${ta}`], getB = ['local.get', `$${tb}`]
  const flagIR = (dom, get) => dom === 'bigint' ? ['i32.const', 1]
    : dom === 'number' ? ['i32.const', 0]
    : dom === 'census' ? ['i32.eqz', isUndef(get)]
    : isBigIntCarrierBits(get)
  const needFlag = (dom) => dom !== 'bigint' && dom !== 'number'
  const fta = needFlag(domA) ? tempI32('bigJf') : null
  const ftb = needFlag(domB) ? tempI32('bigJf') : null
  const flagA = fta ? ['local.get', `$${fta}`] : flagIR(domA, getA)
  const flagB = ftb ? ['local.get', `$${ftb}`] : flagIR(domB, getB)
  ctx.runtime.throws = true
  const throwIR = typed(['block', ['result', 'f64'],
    ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', ERR.BIGINT_UNDEF_MIX]]],
    ['throw', '$__jz_err', ['f64.const', ERR.BIGINT_UNDEF_MIX]]], 'f64')
  // Per-operand CARRIER_BOX unbox, scoped to EXACTLY the 'census' domain
  // (a dict/Map value census-classified BIGINT — the container's own live
  // carrier for a real BigInt is a boxed PTR.BIGINT pointer under
  // CARRIER_BOX, coerceArg's own §29 box-on-write guarantee). The 'bigint'
  // domain (a statically PROVEN BigInt expression) and the null-domain
  // magnitude heuristic (a raw exported-param carrier) are never container-
  // sourced — `asI64` stays correct, unchanged, for both. Reached only when
  // flagA===flagB picked the BigInt arm, so a 'census' operand here is
  // provably present (not the UNDEF_NAN sentinel) — safe to dereference.
  const i64Operand = (dom, get) => dom === 'census' ? maybeUnboxBigInt(get) : asI64(typed(get, 'f64'))
  const bigResult = fromI64(i64Compute(i64Operand(domA, getA), i64Operand(domB, getB)))
  // Number-domain operand normalization: a `census` operand only ever reaches
  // numCompute when its OWN flag proved it undef (the flagA===flagB join
  // above), so its TRUE ToNumeric value is the Number NaN (ES2024 13.5.6/
  // 7.1.3) — never its raw UNDEF_NAN carrier bits passed through unexamined.
  // WASM does NOT guarantee arithmetic ops canonicalize a NaN operand's
  // payload (confirmed live: `f64.add` of two identical UNDEF_NAN bit
  // patterns returned that SAME tagged payload verbatim, not a generic NaN —
  // decoding wrong downstream, since the tagged bits collide with the actual
  // UNDEF_NAN sentinel other consumers compare against). Explicit select
  // substitutes literal NaN before the op runs, matching `coerceNullishToNum`'s
  // own ES semantics (reused conceptually, not the function itself — this
  // already has the value in a temp and the undef flag computed, no second
  // node-level census re-check needed).
  const numOperand = (dom, get) => dom === 'census' ? typed(['select', ['f64.const', 'nan'], get, isUndef(get)], 'f64') : typed(get, 'f64')
  const numResult = numCompute(numOperand(domA, getA), numOperand(domB, getB))
  // A DEFINITE side (no runtime flag) needn't be re-checked once flagA===flagB
  // holds — the equal flag already tells us which domain BOTH sides share.
  const definite = domA === 'bigint' || domA === 'number' ? domA : domB === 'bigint' || domB === 'number' ? domB : null
  const bothBranch = definite ? (definite === 'bigint' ? bigResult : numResult)
    : typed(['if', ['result', 'f64'], flagA, ['then', bigResult], ['else', numResult]], 'f64')
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${ta}`, asF64(emit(a))],
    ['local.set', `$${tb}`, asF64(emit(b))],
    ...(fta ? [['local.set', `$${fta}`, flagIR(domA, getA)]] : []),
    ...(ftb ? [['local.set', `$${ftb}`, flagIR(domB, getB)]] : []),
    typed(['if', ['result', 'f64'], ['i32.eq', flagA, flagB], ['then', bothBranch], ['else', throwIR]], 'f64')], 'f64')
}

// The runtime twin of bigintMixReject's compile-time literal proof.
// A BIGINT-census `node` whose exact kind comes SOLELY from censusMaybeUndefined's
// soundness carve-out (a dict/Map absent-key read, e.g. `m.get('missing')`) may hold
// the UNDEF_NAN sentinel at runtime, not a real bigint payload — plain `asI64(v)`
// reinterprets those bits as an i64 and fabricates a garbage bigint (`m.get('missing')
// + 1n` returned 9221120245631025153n instead of throwing). Real JS (ES2024 13.15.3
// ApplyStringOrNumericBinaryOperator): ToNumeric(undefined) is the NUMBER NaN, not a
// BigInt, so step 6 ("Type(lnum) is not Type(rnum)") throws whenever the OTHER
// genuinely-two-operand side is a real BigInt — the exact TypeError bigintMixReject's
// own literal check proves at compile time for a LITERAL operand; this is the runtime
// check for a maybeUndefined operand, whose type only resolves at runtime. Called for
// EVERY operand at a bigintMixReject call site (the "one decision" chokepoint, same
// altitude as toNumF64's Slice-1 join) — a non-maybeUndefined node degrades to a bare
// `asI64(v)`, byte-identical to before (present-key/local BIGINT structural pin).
// KNOWN NARROWER GAP (documented, not closed here): true ES semantics only throws when
// the two operands' RUNTIME types actually differ — two maybeUndefined BIGINT operands
// that are BOTH genuinely absent at once (`m.get('a') + m.get('b')`, both keys missing)
// are Number NaN + Number NaN = NaN, no throw. This independently guards each operand,
// so that double-absent case throws instead of yielding NaN — strictly better than the
// prior silent-garbage-bigint answer (moves an unsound VALUE to a sound-but-wider
// THROW, never a wrong number), and matches this fix's explicit brief ("the runtime
// semantics for the absent case must be the thrown TypeError"). Not applied to unary
// negation/'~': those single-operand ops ToNumeric their one value and never
// compare against a second operand's type, so an absent key there really does decay
// to NaN (no throw) — a different, narrower semantics, closed separately below by
// bigIntUnary. Postfix/prefix increment/decrement need no
// analogous fix: `n++`/`n--` on a member target lowers to the '+1'/'-1' op below,
// gated on `valTypeOf(a[1]) === VAL.BIGINT` — for the bracket-string-literal-key
// shape (`d['missing']++`) that's the SAME VT['[]'] null-return disambiguation
// bigIntOperand's own comment above documents, so it never takes the raw-i64
// member-op path at all (falls to the generic `n + 1`/`n - 1` spelled-out form,
// already sound); for a dynamic-key member (`d[k]++`) — verified live, not
// assumed — the same is true, confirmed byte-for-byte against the JS oracle.
function bigIntOperand(node) {
  const v = emit(node)
  // censusMaybeUndefinedKind, not valTypeOf(node) === VAL.BIGINT: for a bracket
  // read with a non-canonical-numeric string-literal key (`d['missing']`),
  // VT['[]'] itself resolves to `null` (its own array-vs-property disambiguation,
  // kind.js ~443-448) before ever reaching the dict-value census fallback — so
  // valTypeOf(node) is NOT a reliable "is this dict/Map read's census kind
  // bigint" proxy the way it is for a plain local. censusMaybeUndefinedKind
  // queries the census directly (see its own doc comment in kind.js).
  if (censusMaybeUndefinedKind(node) !== VAL.BIGINT) return readI64(node, v)
  ctx.runtime.throws = true
  const t = temp('bigU')
  // Past the throw check, `$t` is provably PRESENT (the UNDEF_NAN branch
  // above always throws) — a real dict/Map census BigInt. Under CARRIER_BOX
  // the container's own live carrier for a BigInt value is a boxed
  // PTR.BIGINT pointer (coerceArg boxes every BigInt argument crossing into
  // `.set()`/`[]=` unconditionally, §29), so a naive `i64.reinterpret_f64`
  // exposes the box's own tag/offset bits instead of the payload — the same
  // class synthesizeBoundaryWrappers' resultBigintSentinel lane hit.
  // `maybeUnboxBigInt` (CONSERVATIVE PAIRING, §16/§24/§29) dereferences a
  // genuine box and passes anything else through unchanged; off-flag this
  // is byte-identical to the prior plain reinterpret.
  const bits = maybeUnboxBigInt(['local.get', `$${t}`])
  return typed(['block', ['result', 'i64'],
    ['local.set', `$${t}`, asF64(v)],
    ['if', isUndef(['local.get', `$${t}`]),
      ['then',
        ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', ERR.BIGINT_UNDEF_MIX]]],
        ['throw', '$__jz_err', ['f64.const', ERR.BIGINT_UNDEF_MIX]]]],
    bits], 'i64')
}

// Unary twin of bigIntOperand above — same runtime
// censusMaybeUndefinedKind + UNDEF_NAN guard on a maybeUndefined-BIGINT
// operand, but RESOLVES TO A VALUE instead of throwing. ES2024 13.5.6
// UnaryMinus / 13.5.9 BitwiseNOT: both ToNumeric a SINGLE operand — undefined's
// ToNumeric is the Number NaN (step: ToPrimitive(undefined)=undefined, not
// BigInt → ToNumber(undefined)=NaN) — with no second operand to type-mismatch
// against, so there is no step 6 "Type(lnum) is not Type(rnum)" comparison to
// throw on; the real value is just NaN (unary '-') or ToInt32(NaN)'s bitwise
// complement, -1 (unary '~') — a genuine NUMBER, never a BigInt. Both call
// sites (emitNeg, '~') already carry every emitted BIGINT value in an f64-
// typed carrier via `fromI64` (BigInt has no NaN-boxed self-description of
// its own — see fromI64/asI64 — so the caller's static VAL.BIGINT belief is
// what selects this whole branch to begin with), so substituting a genuine
// f64 NUMBER NaN/-1.0 bit pattern into that SAME f64 slot is representation-
// compatible with every existing consumer — no dual-type ABI problem, unlike
// a hypothetical fix at the bigintMixReject binary sites (that KNOWN NARROWER
// GAP stays out of scope, this is a different, simpler case). `mkI64` builds
// the genuine-BIGINT i64 IR from the operand's already-read bits (an IR
// array, not a full node — reused verbatim in both branches so the two paths
// can only ever differ in the runtime i32 select, never in what i64 op they
// compute); `undefF64` is the literal f64 IR substituted when the operand IS
// the sentinel. Non-maybeUndefined operand (present-key/local BIGINT, the
// overwhelming common case) takes `mkI64` directly through the untouched
// `fromI64` path — byte-identical to before (same structural pin as
// bigIntOperand's own non-maybeUndefined fast path).
function bigIntUnary(node, mkI64, undefF64) {
  if (censusMaybeUndefinedKind(node) !== VAL.BIGINT) return fromI64(mkI64(readI64(node, emit(node))))
  const t = temp('unaryBigU')
  // Same CARRIER_BOX gap as bigIntOperand's own throw-check branch above,
  // narrower consequence (a wrong VALUE, not a wrong-address dereference —
  // this arm is discarded via `select` whenever `$t` really is UNDEF_NAN, so
  // running `maybeUnboxBigInt` unconditionally here is sound: UNDEF_NAN's own
  // ATOM tag never matches PTR.BIGINT, so it falls to the same plain
  // reinterpret this select arm always ran, and its result is discarded
  // regardless). Off-flag: byte-identical to the prior plain reinterpret.
  const bits = maybeUnboxBigInt(['local.get', `$${t}`])
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${t}`, asF64(emit(node))],
    ['select', undefF64, ['f64.reinterpret_i64', mkI64(bits)],
      isUndef(['local.get', `$${t}`])]], 'f64')
}

// BigInt `<<`/`>>` — ES2024 13.2.9/13.2.10 BigInt::leftShift/rightShift: a
// NEGATIVE shift amount flips DIRECTION (`x << -3n` === `x >> 3n`, exactly —
// not "shift by a huge wrapped count"). Found live sweeping the general
// valTypeOfWithLocals fix (38dd0dca follow-up): WASM's `i64.shl`/`i64.shr_s`
// both take the shift count mod 64 unconditionally (two's-complement -3 → 61),
// with no such sign awareness — `av << -3n` computed a 61-bit wrong-direction
// shift instead of `av >> 3n`. Pre-existing (the same raw `i64.${fn}` dispatch
// this fixes was already there before this session), just unreachable through
// any correctly-DECODED export until the general fix above made `<<`/`>>` on
// proven-BigInt locals/params cross the boundary as a real BigInt at all —
// confirmed via direct JS-oracle diff, not assumed. `bv` is captured into a
// temp FIRST (not inlined twice) — it may be `bigIntOperand`'s own maybeUndefined
// block form, which must evaluate exactly once. `av` is embedded once, same
// single-evaluation discipline every other binary BigInt op here already has.
function bigIntShiftIR(op, av, bv) {
  const t = tempI64('bshiftN')
  const sameOp = op === '<<' ? 'shl' : 'shr_s'
  const flipOp = op === '<<' ? 'shr_s' : 'shl'
  return ['block', ['result', 'i64'],
    ['local.set', `$${t}`, bv],
    ['if', ['result', 'i64'], ['i64.lt_s', ['local.get', `$${t}`], ['i64.const', 0]],
      ['then', [`i64.${flipOp}`, av, ['i64.sub', ['i64.const', 0], ['local.get', `$${t}`]]]],
      ['else', [`i64.${sameOp}`, av, ['local.get', `$${t}`]]]]]
}

// Member `.`/`[]` increment/decrement's postfix OLD-value recovery. Prepare
// (index.js '++'/'--') has no dedicated increment NODE for a member target
// the way bare names do (the '++'/'--' table entries below are name-based,
// via readVar/writeVar) — the write itself is the DEDICATED '+1'/'-1' unary
// op handled by its own table entry further down (unambiguous: no parser or
// other pass ever produces that op, so it needs no mix-check bypass at all).
// Postfix wraps that write with the SAME plain-literal ∓1 recovery the
// bare-name path uses (`['-', ['=', n, ['+1', n]], [,1]]` etc.) — matched here
// exactly like the bare-name isPostfix bypass just above: only prepare's own
// transform nests an assignment in this exact position, so treating it as the
// compiler's own correction constant (not a user-facing mix) is sound by the
// same permissive-by-construction argument as the bare-name case.
function bigintMemberAssignTarget(a) {
  return Array.isArray(a) && a[0] === '=' && Array.isArray(a[1]) &&
    (a[1][0] === '.' || a[1][0] === '[]') && valTypeOf(a[1]) === VAL.BIGINT ? a : null
}

// === instanceof (.work/todo.md §deletion-sweep §4) ===
// Reached only from raw `instanceof` AST nodes surviving to emit — i.e. strict-mode
// source (prepare's 'instanceof' handler is the sole producer; jzify's default-mode
// lowering rewrites every `instanceof` shape to something else before compile ever
// runs, so this dispatch never fires there — see that handler's own comment).
// RHS is always a validated member of prepare's INSTANCEOF_ALLOW by this point.

/** Fold `a instanceof X` to a compile-time-known boolean while still evaluating `a`
 *  for any side effects (dropping a *value* the language spec still requires to be
 *  computed is unsound — `[sideEffect()] instanceof Array` must run sideEffect()).
 *  Same idiom as tryIntDivTrunc's constant-divisor-zero fold above: '(drop va)' then
 *  the constant, wrapped in a result-block; skipped entirely when `va` is already
 *  proven pure (a bare literal array/collection/typed-array construction has no
 *  effect to preserve, so the fold costs zero extra bytes — the acceptance bar this
 *  slice's "no runtime dispatch emitted" pin checks). */
const foldInstanceof = (va, bool) =>
  isPureIR(va) ? emitNum(bool ? 1 : 0)
    : typed(['block', ['result', 'i32'], ['drop', va], ['i32.const', bool ? 1 : 0]], 'i32')

// Array/Map/Set/ArrayBuffer: single-tag predicates. valTypeOf already resolves every
// literal/constructor shape that proves these kinds (VT['[']=ARRAY, CALLEE_VAL['new.Set']
// =SET, etc, kind.js/kind-traits.js) — reusing it here is "matching every OTHER
// valTypeOf-driven instanceof fold", not a new inference.
const INSTANCEOF_TAG = { Array: [VAL.ARRAY, PTR.ARRAY], Map: [VAL.MAP, PTR.MAP], Set: [VAL.SET, PTR.SET], ArrayBuffer: [VAL.BUFFER, PTR.BUFFER] }

function emitTagInstanceof(a, rhs) {
  const [wantVal, wantPtr] = INSTANCEOF_TAG[rhs]
  const vt = valTypeOf(a)
  if (vt != null) return foldInstanceof(emit(a), vt === wantVal)
  return ptrTypeEq(asF64(emit(a)), wantPtr)
}

/** TypedArray ctors (the 8 TYPED_ELEM_NAMES — see prepare's INSTANCEOF_ALLOW comment
 *  for why BigInt64Array/BigUint64Array/Float16Array/Uint8ClampedArray/DataView are
 *  excluded from RHS entirely, not just this arm). Static ctor name comes from either
 *  a literal `new X(...)` call node (prepare's runtime-ctor path always emits
 *  `['()', 'new.X', args]`) or a bound name's narrowed `typedCtor` rep field — both
 *  carry the SAME 'new.X' / 'new.X.view' string shape (layout.js's typedElemAux
 *  convention), so one extractor covers both. */
function typedCtorNameOf(a) {
  const ctor = Array.isArray(a) && a[0] === '()' && typeof a[1] === 'string' && a[1].startsWith('new.') ? a[1]
    : typeof a === 'string' ? (repOf(a)?.typedCtor ?? null) : null
  if (ctor == null) return null
  return ctor.endsWith('.view') ? ctor.slice(4, -5) : ctor.slice(4)
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
  const raw = ctx.func.localTypedElemsOverlay?.get(name) ?? ctx.func.typedElem?.get(name) ?? ctx.scope.globalTypedElem?.get(name) ?? null
  if (raw == null) return false
  const stripped = raw.endsWith('.view') ? raw.slice(4, -5) : raw.slice(4)
  return WRAP_TRUNCATING_TYPED_CTORS.has(stripped)
}

function emitTypedInstanceof(a, rhs) {
  const provenName = typedCtorNameOf(a)
  if (provenName != null) return foldInstanceof(emit(a), provenName === rhs)
  const vt = valTypeOf(a)
  if (vt != null && vt !== VAL.TYPED) return foldInstanceof(emit(a), false)
  // Runtime: PTR.TYPED tag AND element-code match. Mask off TYPED_ELEM_VIEW_FLAG before
  // comparing — a VIEW typed array (`new Int32Array(buffer)`) and an OWNED one
  // (`new Int32Array(4)`) are both really `instanceof Int32Array` in JS; only the
  // element-type bits (which the 8-name allowlist keeps collision-free — see prepare's
  // comment) are load-bearing for identity.
  inc('__ptr_type', '__ptr_aux')
  const elemCode = encodeTypedElemAux(rhs, false)
  // Compute `a` exactly ONCE into a local — the bits are read twice below (tag,
  // then aux), and re-embedding the same emitted subtree twice would both
  // duplicate any side effects AND re-run the underlying WAT computation at
  // runtime (not just alias IR node identity — see emitSchemaSlotGuarded's
  // cloneIR comment for the identity half of this caution).
  const tv = temp('einstv'), tt = tempI32('einstt')
  const bits = () => ['i64.reinterpret_f64', ['local.get', `$${tv}`]]
  return typed(['block', ['result', 'i32'],
    ['local.set', `$${tv}`, asF64(emit(a))],
    ['local.set', `$${tt}`, ['call', '$__ptr_type', bits()]],
    ['if', ['result', 'i32'],
      ['i32.eq', ['local.get', `$${tt}`], ['i32.const', PTR.TYPED]],
      ['then', ['i32.eq',
        ['i32.and', ['call', '$__ptr_aux', bits()], ['i32.const', ~TYPED_ELEM_VIEW_FLAG]],
        ['i32.const', elemCode]]],
      ['else', ['i32.const', 0]]]], 'i32')
}

/** Error family (7 classes, .work/todo.md §deletion-sweep §4's error-family arm). `Error`
 *  itself is the base every one of the 7 extends (jz's flat one-level hierarchy — no
 *  deeper chain to walk), so it matches ANY Error-schema object regardless of which
 *  concrete class built it; a specific subclass (TypeError, …) must match exactly
 *  (siblings never satisfy each other's instanceof — ES 13.10.2 OrdinaryHasInstance
 *  over jz's non-overlapping prototype set). */
function emitErrorInstanceof(a, rhs) {
  // Fold, tier 1: LHS is a literal `new X(...)`/`X(...)` call node — prepare's generic
  // "unknown ctor → plain call" path (.work/todo.md §deletion-sweep §2) keeps the literal
  // class name as the callee string, so no schema/rep lookup is even needed.
  const litClass = Array.isArray(a) && a[0] === '()' && typeof a[1] === 'string' && ERR_CLASS_NAMES.includes(a[1]) ? a[1] : null
  if (litClass) return foldInstanceof(emit(a), rhs === 'Error' || litClass === rhs)
  // Fold, tier 2: a bound name whose ValueRep already proves its EXACT schema id.
  // Brand model: each class has its OWN sid (module/schema.js's
  // errorSid), so a settled schemaId settles the WHOLE question — which class, not
  // merely "some Error" (the old shared-sid design could only fold the base
  // `rhs === 'Error'` case; a specific-subclass check still needed the runtime arm).
  if (typeof a === 'string') {
    const sid = repOf(a)?.schemaId
    if (sid != null) {
      if (!ctx.schema.isErrorSid(sid)) return foldInstanceof(emit(a), false)
      return foldInstanceof(emit(a), rhs === 'Error' || ctx.schema.errorClassOf(sid) === rhs)
    }
  }
  // A provably non-OBJECT LHS can never be our Error schema. This INCLUDES NUMBER:
  // INVARIANT: no numeric-range arm may live here — one was deleted
  // below — an internally-thrown coded value (JSON.parse failure, OOB Array#with,
  // …) is caught as a raw NUMBER (.work/todo.md §deletion-sweep §3(b)), bit-identical to
  // a user's own `throw <sameNumber>`. Comparing that NUMBER against err-codes.js's
  // ERR_CODE_RANGES and calling a match "instanceof SyntaxError" meant ANY
  // caller-supplied number landing in a class's internal range answered `true`
  // (`export let f = x => x instanceof SyntaxError; f(300)` → `true`, since 300
  // sits in the derived range — a real repro, not a hypothetical). No numeric
  // range can distinguish "the compiler threw this code" from "the user threw
  // this number"; recovering `instanceof` for a caught internal code needs a
  // materialized Error object at the catch site instead (.work/todo.md §deletion-sweep
  // §7 Slice C, deliberately deferred — not landed here). Until then, internal-
  // code catches are honestly `instanceof`-false for every Error class, same as
  // any other non-Error value (§3(c)).
  const vt = valTypeOf(a)
  if (vt != null && vt !== VAL.OBJECT) return foldInstanceof(emit(a), false)

  // Runtime: real Error object only — tag+sid compare (rhs === 'Error') or an
  // OR-chain over every class the program actually constructs (base 'Error'), or
  // a single tag+sid compare for one specific class. `used` (ctx.features.errorClasses,
  // src/prepare/index.js's whole-program scan) is null whenever no Error class is
  // EVER constructed — dead code, fold to false rather than emit an always-false
  // compare (mirrors ir.js toStrI64's ctx.features.error gate). A SPECIFIC class
  // that is never constructed anywhere is equally sound to fold false: no runtime
  // pointer could ever carry a sid that was never minted — one level more precise
  // than the old shared-sid design's blanket `ctx.features.error` gate.
  const used = ctx.features.errorClasses
  if (!used || (rhs !== 'Error' && !used.has(rhs))) return foldInstanceof(emit(a), false)
  const t = temp('einst')
  const bits = () => ['i64.reinterpret_f64', typed(['local.get', `$${t}`], 'f64')]
  const tagEq = (sid) => typed(['i64.eq', ['i64.and', bits(), ['i64.const', OBJECT_SCHEMA_HI_MASK]], ['i64.const', objectSchemaGuardHex(sid)]], 'i32')
  const body = rhs === 'Error'
    // ERR_CLASS_NAMES' fixed order (not Set insertion order — see the ctx.features.errorClasses
    // ctx.js comment): the emitted OR-chain must depend only on WHICH classes the
    // program constructs, not the incidental order the AST walk first saw them in.
    ? ERR_CLASS_NAMES.filter(c => used.has(c)).map(c => tagEq(ctx.schema.errorSid(c))).reduce((x, y) => typed(['i32.or', x, y], 'i32'))
    : tagEq(ctx.schema.errorSid(rhs))
  return typed(['block', ['result', 'i32'],
    ['local.set', `$${t}`, asF64(emit(a))],
    body], 'i32')
}

function emitInstanceof(a, rhs) {
  if (rhs in INSTANCEOF_TAG) return emitTagInstanceof(a, rhs)
  if (TYPED_ELEM_NAMES.includes(rhs)) return emitTypedInstanceof(a, rhs)
  return emitErrorInstanceof(a, rhs)
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
    const ambiguous = boxes && hasAmbiguousBoolMerge(expr)
    const repAction = representationReturnAction(ctx, expr)
    let emitted = ambiguous ? emitIdentitySafe(expr) : emit(expr)
    emitted = applyBigintRepresentationAction(emitted, expr, repAction)
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
    const ir = pk != null ? asPtrOffset(emitted, pk)
      : boxes ? (ambiguous ? emitted : carrierF64Narrow(expr, emitted, 'return'))
      : (repAction !== REP_EDGE_BOX && repAction !== REP_EDGE_UNBOX &&
         !ctx.func.exported && rt === 'f64' && typeof expr === 'string' && isProvenBoxedBigint(expr))
        ? (bigintStrict() ? bigintEraseErr('return', expr) : boxBigInt(asI64(emitted)))
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
    ev = applyBigintRepresentationAction(ev, val, representationBindingWriteAction(ctx, name, val))
    // Durable-boxed param reassignment must MAINTAIN the boxed-slot invariant
    // (three-store unification, ledger 2026-08-19): reads deref this param's
    // slot for the whole function extent, so a raw-producing BIGINT RHS must
    // rebox before the store — the assignment-side mirror of the 'return'
    // path's isProvenBoxedBigint arm. Scoped to arithmetic/shift/bitwise RHS
    // (raw i64 carrier by construction — no double-box risk); bare names,
    // calls and '?:' keep their established wiring.
    if (typeof name === 'string' && isCurrentlyBoxedBigint(name) &&
        Array.isArray(val) && RAW_BIGINT_OPS.has(val[0]) && valTypeOf(val) === VAL.BIGINT)
      ev = boxBigInt(asI64(ev))
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
      if (fn === 'shr_u') err('BigInt has no unsigned right shift (>>>) — TypeError in JS')
      bigintMixReject(sym, name, val)
      const void_ = ctx.func._expect === 'void'
      // See compoundAssign's identical comment: `name` is always a bare identifier,
      // so only `val` can be a maybeUndefined dict/Map read. `<<=`/`>>=` share the
      // binary `<<`/`>>` handler's sign-aware direction flip — see bigIntShiftIR.
      const result = fromI64((sym === '<<' || sym === '>>')
        ? bigIntShiftIR(sym, readI64(name, readVar(name)), bigIntOperand(val))
        : [`i64.${fn}`, readI64(name, readVar(name)), bigIntOperand(val)])
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
    // BigInt local: readVar's carrier type is 'f64' (a bigint local's f64.reinterpret_i64
    // storage — see readVar), NOT i64, so the generic `${v.type}.${fn}` below would emit
    // f64.add/f64.sub on the raw i64 bit pattern — the same silent-rounding bug as
    // compoundAssign's f64 path (`n++` on a large-magnitude bigint was a no-op / garbage).
    // Same shape as the binary '+'/'-' BIGINT arm: asI64, i64.add/sub by the i64 constant
    // 1, fromI64. `name` is always a bare identifier here (prepare only routes '.'/'[]'
    // targets through '=' + '+'/'-', never through this table entry).
    if (valTypeOf(name) === VAL.BIGINT)
      return writeVar(name, fromI64([`i64.${fn}`, readI64(name, v), ['i64.const', 1]]), void_)
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
  '+': (a, b) => {
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
        (fa, fb) => typed(['f64.add', fa, fb], 'f64'))
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
  '-': (a, b) => {
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
        (fa, fb) => typed(['f64.sub', fa, fb], 'f64'))
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
    if (b === undefined) return emitNeg(a)
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
    if (valTypeOf(a) === VAL.NUMBER) return toNumF64(a, v)
    inc('__to_num')
    return typed(['call', '$__to_num', asI64(v)], 'f64')
  },
  'u-': a => emitNeg(a),
  '*': (a, b) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment above.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('*', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.mul', ia, ib],
        (fa, fb) => typed(['f64.mul', fa, fb], 'f64'))
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
  '/': (a, b) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment above.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('/', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.div_s', ia, ib],
        (fa, fb) => typed(['f64.div', fa, fb], 'f64'))
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
  '%': (a, b) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment
    // above. Number-domain branch reuses `f64rem` (the SAME `$__rem` call the
    // fully generic '%' path below already uses — exact NaN/±Inf/0 edges).
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject('%', a, b)
      return bigIntJointDispatch(a, b,
        (ia, ib) => ['i64.rem_s', ia, ib],
        (fa, fb) => f64rem(fa, fb))
    }
    if (valTypeOf(a) === VAL.BIGINT || valTypeOf(b) === VAL.BIGINT) {
      bigintMixReject('%', a, b)
      return fromI64(['i64.rem_s', bigIntOperand(a), bigIntOperand(b)])
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
      const legacyBigintArm = valTypeOf(b) === VAL.BIGINT && nullishArm(c) ? b
        : valTypeOf(c) === VAL.BIGINT && nullishArm(b) ? c : null
      if (bigintStrict() && legacyBigintArm != null && needsBigintBox(legacyBigintArm))
        bigintEraseErr('ternary-nullish', typeof legacyBigintArm === 'string' ? legacyBigintArm : 'this ternary\'s BigInt arm')
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
    // Slice 2 (CARRIER PROGRAM, .work/carrier-representation-design.md §7)
    // ternary-nullish def-side wiring — OFF by default (CARRIER_BOX). Mirrors
    // kind.js VT['?:']'s own BIGINT+nullish-literal rule exactly (same ta/tb,
    // same nullishArm test) and analyze.js's markBigintSink call for the same
    // op==='?:' shape: BigInt is "the one kind with no runtime tag" — a
    // `cond ? bigVal : null` merge must box bigVal before crossing into the
    // merged f64 slot, or a proven-raw BigInt elsewhere becomes bit-
    // indistinguishable from this merge's own result once null/undefined mix
    // in. Always the `if`/`else` control-flow form, never `select` — `select`
    // eagerly evaluates BOTH arms, which would allocate the box on the branch
    // NOT taken (wasteful, and a real double-eval hazard if the arm has its
    // own side effects) — round-2's own "ternary-beside-nullish wrongly
    // boxed" bug (.work/todo.md) is exactly this class of mistake.
    // ctx.func._arrayLiteralNeverEscapes: skip the box for a compiler-
    // synthesized decl-destructure array-literal element (see
    // carrierF64Narrow's own doc comment, ir.js, and ctx.schema.arrayVars',
    // kind.js). The box above exists to keep a raw bigint payload from
    // coincidentally colliding with the NULL_NAN/UNDEF_NAN sentinel bit
    // pattern for a consumer that inspects THIS merge's own bits to tell
    // "was it the bigint arm or the nullish one" apart — but a destructure
    // temp's element is read exactly once, by the synthesized extraction
    // `expandDestruct` itself generates, and every downstream consumer
    // (`c ? b * 2n : -1n`, the destructure's OWN nullability tracking) already
    // disambiguates via the SAME condition the ternary itself branched on,
    // never by inspecting the extracted binding's raw bits — so there is no
    // sentinel-collision-observing reader here either, the same "no reader"
    // guarantee the flag already established for module/array.js's element
    // storage. Found live: `let [a, b] = [1, c ? BigInt(v) : null]; return c ?
    // b * 2n : -1n` boxed the bigint arm unconditionally, then `b * 2n`'s own
    // raw bigIntOperand arithmetic read the pointer's bits raw.
    if (!ctx.func._arrayLiteralNeverEscapes) {
      const taM = valTypeOf(b), tbM = valTypeOf(c)
      const bigintArm = (taM === VAL.BIGINT && nullishArm(c)) ? 'b'
        : (tbM === VAL.BIGINT && nullishArm(b)) ? 'c' : null
      // BigInt retirement Slice 1 (.work/bigint-retirement-design.md §4/§9):
      // this IS the design's "ternary-nullish" flow class — a `cond ? bigVal
      // : null`-shaped merge is "the one kind with no runtime tag", so its
      // kind can never be proven uniform past this point. Boxes the BigInt
      // arm before merging with the null/undefined sentinel (pre-Slice-1
      // default, restored here) UNLESS bigintStrict() is live, in which
      // case it refuses to compile instead — same needsBigintBox proof.
      if (bigintArm != null && needsBigintBox(bigintArm === 'b' ? b : c)) {
        const armNode = bigintArm === 'b' ? b : c
        if (bigintStrict()) bigintEraseErr('ternary-nullish', typeof armNode === 'string' ? armNode : 'this ternary\'s BigInt arm')
        const armEmitted = bigintArm === 'b' ? vb : vc
        const otherEmitted = bigintArm === 'b' ? vc : vb
        const boxedIR = boxBigInt(asI64(armEmitted))
        const otherIR = asF64(otherEmitted)
        const ib = ['i64.reinterpret_f64', boxedIR], ic = ['i64.reinterpret_f64', otherIR]
        const [thenI, elseI] = bigintArm === 'b' ? [ib, ic] : [ic, ib]
        const bits = ['if', ['result', 'i64'], cond, ['then', thenI], ['else', elseI]]
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
      // Boolean twin of && above: eager pure RHS + canonical 0/1 values make
      // bitwise OR exactly equivalent to short-circuit OR.
      if (vb.type === 'i32' && boolEagerBody() && isCanonicalBoolExpr(a) && isCanonicalBoolExpr(b) && eagerSelectOK(vb))
        return typed(['i32.or', va, vb], 'i32')
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
    // bigIntUnary: a maybeUndefined-BIGINT operand's real
    // JS value is ToInt32(NaN)'s complement, NUMBER -1 — not `x ^ -1` on the raw
    // UNDEF_NAN sentinel bits (see emitNeg's identical substitution above).
    // `|| censusMaybeUndefinedKind(a) === VAL.BIGINT` — see emitNeg's identical
    // OR-arm comment (§6/§12 Slice 5): keeps this gate VT-Slice-4-independent.
    if (valTypeOf(a) === VAL.BIGINT || censusMaybeUndefinedKind(a) === VAL.BIGINT)
      return bigIntUnary(a, i64v => ['i64.xor', i64v, ['i64.const', -1]], ['f64.const', -1])
    const v = emit(a); return isLit(v) ? emitNum(~litVal(v)) : typed(['i32.xor', toI32(isI32Num(v) ? v : toNumF64(a, v)), typed(['i32.const', -1], 'i32')], 'i32')
  },
  ...Object.fromEntries([
    ['&', 'and'], ['|', 'or'], ['^', 'xor'], ['<<', 'shl'], ['>>', 'shr_s'],
  ].map(([op, fn]) => [op, (a, b) => {
    // §14 point 4: joint runtime-domain dispatch — see '-'s identical comment
    // above. Number-domain branch mirrors the generic i32 fast path below
    // (`toI32`/`i32.${fn}`) exactly, widened back to f64 via `asF64`.
    if (bigIntDomainsCanMix(a, b, true)) {
      bigintMixReject(op, a, b)
      return bigIntJointDispatch(a, b,
        op === '<<' || op === '>>' ? (ia, ib) => bigIntShiftIR(op, ia, ib) : (ia, ib) => [`i64.${fn}`, ia, ib],
        (fa, fb) => asF64(typed([`i32.${fn}`, toI32(fa), toI32(fb)], 'i32')))
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
      err('BigInt has no unsigned right shift (>>>) — TypeError in JS')
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
          const aux = typedElemAux(ctx.func.typedElem?.get(recv))
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
    if (label != null && idx < 0) err(`break label '${label}' is not in scope`)
    const target = (idx >= 0 ? ctx.func.stack[idx] : loopTop()).brk
    if (!target) err(`break label '${label}' is not in scope`)
    return [...emitFinalizers(idx + 1), ['br', target]]
  },
  'continue': (label) => {
    if (label == null) return [...emitFinalizers(ctx.func.stack.length), ['br', loopTop().loop]]
    // Labeled continue: target the continue point of the loop that adopted this label.
    const idx = ctx.func.stack.findLastIndex(f => f.contLabel === label)
    if (idx < 0) err(`continue label '${label}' is not in scope`)
    return [...emitFinalizers(idx + 1), ['br', ctx.func.stack[idx].loop]]
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
        const tmp = `${T}p${freshId(ctx)}`
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

    // Pass closure info including rest param and defaults. rawParams is the
    // ClosureEnvPlan fallback lookup key for a destructured-param closure
    // (src/compile/closure-plan.js's mintClosureEnvPlans doc) — `body` above
    // was just reassigned to a FRESH array when bodyPrefix is non-empty, so
    // the plan (minted pre-emission, before this reassignment ever happened)
    // cannot be keyed on it; rawParams is untouched by this rewrite and is
    // the same reference the mint saw.
    const closureInfo = { params, body, captures, restParam, rawParams }
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
    if (typeof callee === 'string' && ctx.funcs.globalDevirt?.has(callee))
      callee = ctx.funcs.globalDevirt.get(callee)

    if (Array.isArray(callee) && callee[0] === '.')  return emitMethodCall(callee, parsed, callArgs)

    if (typeof callee === 'string' && ctx.core.emit[callee] && !isBoundName(callee) && !isUserFunc(callee))
      return emitBuiltinCall(callee, parsed)

    if (typeof callee === 'string' && ctx.funcs.names.has(callee) && !isBoundName(callee))
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
    if (ctx.funcs.names.has(node) && !isBoundName(node) && ctx.closure.table) {
      // Trampoline signature: uniform closure ABI (env f64, argc i32, a0..a{MAX-1} f64) → f64.
      // Forwards the first N inline slots to $func where N = func's fixed param count.
      const func = ctx.funcs.map.get(node)
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
          // Canonical 16-byte header (__alloc_hdr: propsPtr@-16, len@-8,
          // cap@-4), NOT a hand-rolled (n*8+8) alloc — __dyn_get_t_h's
          // ARRAY branch always reads the propsPtr word at off-16 (FOURTH
          // mechanism, .work/research.md §Region arena: a short header
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
          // A BOOL-result func carries 0/1 in its raw ABI; the closure ABI is a
          // boxed-value position, so rebox to the true/false ATOM — the exact
          // mirror of the boundary wrapper (index.js resultBool). Without it a
          // field-held function's `=== true` / typeof observed a plain number.
          const boolResult = !ptrResult && func?.valResult === VAL.BOOL
          const wrapped = ptrResult
            ? `(call $__mkptr (i32.const ${valKindToPtr(func.sig.ptrKind)}) (i32.const ${func.sig.ptrAux ?? 0}) ${callExpr})`
            : boolResult
              ? `(select (f64.const nan:${TRUE_NAN}) (f64.const nan:${FALSE_NAN}) ${resType === 'i32' ? `(i32.ne ${callExpr} (i32.const 0))` : `(f64.ne ${callExpr} (f64.const 0))`})`
              : resType === 'i32'
                ? (func.sig.unsignedResult ? `(f64.convert_i32_u ${callExpr})` : `(f64.convert_i32_s ${callExpr})`)
                : resType === 'i64'
                  ? `(f64.reinterpret_i64 ${callExpr})`
                  : callExpr
          ctx.core.stdlib[trampolineName] = `(func $${trampolineName} ${paramDecls.join(' ')} (result f64) ${restLocals}${restPrelude}${wrapped})`
          inc(trampolineName, ...(ptrResult ? ['__mkptr'] : []), ...(restIdx >= 0 ? ['__alloc_hdr', '__mkptr'] : []))
        }
      }
      // ctx.closure.mint (not a bare table.push) — same funcIdx-alignment
      // reason as builtinFunctionValue above. A top-level function used as
      // a bare value has no captures (its real params are forwarded inline
      // by the trampoline body, not carried via an env block), so the
      // default {len:0, cellMask:0} meta is correct here too.
      const idx = ctx.closure.mint(trampolineName)
      const ir = mkPtrIR(PTR.CLOSURE, idx, 0)
      ir.closureFuncIdx = idx
      return ir
    }
    // Emitter table: only namespace-resolved names (contain '.', e.g. 'math.PI') — safe from user variable collision.
    // Two flavors of entry: arity-0 handlers are constants (e.g. `math.PI` →
    // emits `f64.const PI`) and can be invoked directly here; arity-≥1 handlers
    // expect the surrounding call node, so bare-name use of them is a
    // first-class-value reference — wrap as a closure. The flavor test is
    // STRUCTURAL membership in the first-class tables, NOT `handler.length`:
    // function arity reads are unsupported in jz output semantics, so when the
    // compiler itself runs self-compiled, `.length` is undefined and an
    // arity-based test routed every first-class builtin into the niladic
    // handler() — an empty-IR internal error (`({sqrt} = Math)` in-kernel).
    // `handler.length` remains only as the fallback that preserves the
    // friendly "cannot be used as first-class value" error natively for
    // callable builtins NOT in the tables.
    if (node.includes('.') && ctx.core.emit[node]) {
      const handler = ctx.core.emit[node]
      const isCallable = FIRST_CLASS_UNARY_MATH[node] != null || FIRST_CLASS_BUILTIN_BODY[node] != null || handler.length > 0
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
      if (!ctx.transform.targetProfile.envImports) err(`host:'wasi': reference to host global \`${node}\` requires an env import. Remove the reference or use host:'js'.`)
      setLinkDemand('external')
      ctx.core.hostGlobals.add(node)
      return typed(['global.get', `$${node}`], 'i64')
    }
    const t = ctx.func.locals?.get(node) || ctx.func.current?.params.find(p => p.name === node)?.type || 'f64'
    return typed(['local.get', `$${node}`], t)
  }
  if (!Array.isArray(node)) return typed(['f64.const', 0], 'f64')

  const [op, ...args] = node
  if (op === '__eager&&' || op === '__eager||') return toBool(node)
  // WASM IR passthrough: internally-generated IR nodes (from statement flattening) pass through
  if (typeof op === 'string' && !ctx.core.emit[op] && (op.includes('.') || WASM_OPS.has(op))) return node

  // Self-describing bigint literal, tagged at parse time (parse.js's digit-lookup
  // override, audit P0-2) off the source `n` suffix — a purely structural signal,
  // sound whether this code runs natively or self-compiled in-kernel. args[0] is
  // the unsigned-64 decimal (BigInt.asUintN(64,·) semantics, computed via
  // bignum.js's limb arithmetic at parse time — no host BigInt, no ambiguity),
  // passed straight to i64.const — no in-kernel re-parse needed.
  if (op === 'bigint') return typed(['f64.reinterpret_i64', ['i64.const', args[0]]], 'f64')

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
  // ctx.core.emit table reference: under self-compile the table reference is a closure value,
  // and a runtime spread of >8 args into a closure call silently drops arguments — so a
  // `let` with >8 expression-init declarators (e.g. an SROA prologue loading 16 typed-array
  // slots) lost everything past the 8th. A direct call to the module-local binding compiles
  // as a real direct call, which marshals all args.
  if (op === 'let' || op === 'const') return emitDecl(...args)
  const handler = ctx.core.emit[op]
  if (!handler) err(`Unknown op: ${op}`)
  const ir = op === '?:' ? handler(...args, node) : handler(...args)
  if (ir && ir.type === 'f64' && valTypeOf(node) === VAL.NUMBER) ir.valKind = VAL.NUMBER
  return ir
}
