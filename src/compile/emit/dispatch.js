/**
 * The Tarjan-verified 15-member SCC (emit/emitDecl/liftOptionalChain/toBool/emitIdentitySafe/emitIdentitySafeArms/storedValueNarrow/argIR/emitCallArgs/emitBoolStr/tryConcatChain/tryConcatBufferDecl/tryI32Index + the 2-member emitVoid⇄emitBlockBody SCC) plus every small helper whose only caller lives inside that SCC. emit() dispatches via ctx.core.emit[op], never a direct call into any family module - this is why every other family module can import from here without a back-edge.
 *
 * @module compile/emit/dispatch
 */

import { STR_HCACHE_BIT } from '../../../layout.js'
import { ASSIGN_OPS, JZ_UNDEF, T, commaList, firstRefKind, isBlockBody, isReassigned } from '../../ast.js'
import { DBG_INVARIANTS, PTR, ctx, err, inc, setLinkDemand } from '../../ctx.js'
import {
  FALSE_NAN, MAX_CLOSURE_ARITY, TRUE_NAN, WASM_OPS, applyBigintRepresentationAction, asF64, asI32, asI64, asParamType, asPtrOffset, block64, boolBoxIR, boxBigInt, carrierF64, carrierF64Narrow, emitNum, extractF64Bits, flat, freshId, fromI64, isBoolAtom, isBoundName, isGlobal, isLit, isNullish, isNullishLit, litVal, maybeUnboxBigInt, mkPtrIR, nullExpr, ptrOffsetIR, readVar, resolveValType, temp, tempI32, tempI64, toBoolFromEmitted, toI32, toStrI64, truthyIR, typed, unboxBoolIR, undefExpr, valKindToPtr,
} from '../../ir.js'
import { BIGINT_JOINT_BINARY_OPS, hasAmbiguousBoolMerge, nullishArm, valTypeOf } from '../../kind.js'
import { VAL, lookupValType, repOf, repOfGlobal } from '../../reps.js'
import { nonNegIntLiteral } from '../../static.js'
import { exprType, isTerminator } from '../../type.js'
import {
  BINDING_USE_COMPUTED, BINDING_USE_DECLS, BINDING_USE_KEY, BINDING_USE_KIND, BINDING_USE_OP, BINDING_USE_OPTIONAL, BINDING_USE_USES, USE, scanBindingUses,
} from '../analyze-scans.js'
import { withArrayLiteralEscape } from '../flow-state.js'
import { extractRefinements, withRefinements } from '../flow-types.js'
import {
  JOIN_OPS, REP_EDGE_BOX, REP_EDGE_REJECT, REP_EDGE_UNBOX, representationBindingWriteAction, representationCallArgAction,
} from '../representation-plan.js'
import { FIRST_CLASS_BUILTIN_BODY, FIRST_CLASS_UNARY_MATH, builtinFunctionValue } from './first-class.js'
import { CMP_SET, boolEagerBody, eagerSelectOK, isCanonicalBoolExpr, isCmp, selectCondOK } from './shared.js'


// Ops whose own table handler needs its OUTER node (`self`) to ask the plan
// "should my own value be boxed" — JOIN_OPS (C5b precedent) plus, funded-
// deletion item 4, the unary '-'/'~' and joint-binary census-shaped ops
// (kind.js's canonical BIGINT_JOINT_BINARY_OPS + the two unary op names).
// Threaded through the generic dispatch below exactly like JOIN_OPS
// already was — an opt-in Set, not a blanket `handler(...args, node)` for
// every op, because SOME handlers (variadic ones) take a REST-shaped `args`
// where an appended trailing element would corrupt the operand list.
const SELF_AWARE_OPS = new Set(['u-', '~', ...BIGINT_JOINT_BINARY_OPS, ...JOIN_OPS])

// Host globals auto-imported as `(import "env" "name" (global … i64))` when
// referenced as a value. Drained from ctx.core.hostGlobals at assembly.
const HOST_GLOBALS = new Set(['WebAssembly', 'globalThis', 'self', 'window', 'global', 'process'])

// hoistNestedCalls (plan/inline.js hExpr) names its hoisted `const __h = call(...)`
// temps `${T}inl${uniq}_h` — a single-def, single-use compiler binding by construction
// (each nested-call occurrence gets its own fresh temp, substituted at exactly the one
// site it was found). Recognizing that exact shape lets stripCanon (below) carry
// `.canonOf` provenance through the temp without risking a binding some OTHER reader
// also depends on staying canonical.
const isHoistTemp = (name) => typeof name === 'string' && name.startsWith(T + 'inl') && name.endsWith('_h')

/** Stringify a VAL.BOOL operand to "true"/"false" (f64 string pointer). The
 *  boolean rides the cheap 0/1 carrier, so we runtime-select between the two
 *  interned literals; a constant operand folds to a single literal downstream. */
export const emitBoolStr = (node) =>
  typed(['select', asF64(emit(['str', 'true'])), asF64(emit(['str', 'false'])), truthyIR(emit(node))], 'f64')

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
 *  ABI its body assumes; i32/pointer params are numeric positions. `ir` must
 *  already be argIR(node)'s result (or ptrKind-appropriate) — this function
 *  itself never emits, only coerces, so it cannot re-decide emit vs
 *  emitIdentitySafe after the fact (see argIR's comment). */
export function coerceArg(ir, param, node, repAction = REP_EDGE_REJECT) {
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
  // Shape #6: valTypeOf(node) is NOT the gate for whether repAction applies —
  // it's DELIBERATELY incomplete for a storage-read call-member node
  // (`arr.at(i)`/`.get`/`.pop`/`.shift`; see VT['()']'s own "NO `.get`
  // short-circuit" doc comment above — an absent-key/out-of-bounds read can
  // legitimately be `undefined`, so valTypeOf soundly declines to commit to
  // an exact kind there). representationCallArgAction only ever returns
  // UNBOX/BOX when its OWN edgeAction proof already found BOTH the source
  // and target CLOSED bigint representations (materializedNames/
  // hostBoxParams-gated) — a strictly stronger, presence-aware proof than
  // valTypeOf's conservative default, so trusting repAction directly here
  // (instead of requiring valTypeOf's agreement first) is exactly the "sole
  // authority" contract this comment already claims, now honored for this
  // shape too.
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
export function emitCallArgs(argNodes, params, func) {
  return padArgs(argNodes.map((a, k) =>
    coerceArg(argIR(a), params[k], a, representationCallArgAction(ctx, a, func, k))), params)
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
  if (!uses || uses[BINDING_USE_DECLS] !== 1) return false
  for (const u of uses[BINDING_USE_USES]) {
    if (u[BINDING_USE_KIND] === USE.MEMBER_R && !u[BINDING_USE_OPTIONAL] &&
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

// Loud identity-escape REJECT for a BOOL∪NUMBER-ambiguous merge landing in a
// plain (non-boxed) local — STABILITY.md "Known limitations at v1": "Ambiguous
// boolean∪number locals whose stored identity would escape reject at compile
// time (truthiness-only uses compile fine); full support needs a tagged
// Boolean carrier plan." `expr`'s own VT rule (kind.js hasAmbiguousBoolMerge)
// took the BOOL-vs-NUMBER benign-coercion branch — sound for arithmetic
// (`cond && 1` used as a number), unsound the moment `name`'s STORED value is
// later read back for its own identity (typeof, strict-eq): the raw 0/1
// carrier can't be told apart from a genuine coerced-false/true. Scans EVERY
// use of `name` in the enclosing function body, not just the ones downstream
// of this one assignment — the ambiguity lives in the BINDING's storage, so a
// later `typeof name` sees exactly the same collapsed bits regardless of
// which assignment produced them. A plain truthiness test (`if(name)`,
// `!name`, `name ? : `) stays exempt — only typeof and other identity-
// observing uses are unsupported; a captured (closure) use is handled by its
// own identity-shadow box, not this reject. Shared by emitDecl (the original
// call site, decl-with-init) and the plain-assignment '=' handler below (the
// audit's BOOL_CARRIER family — `let x; x = false ?? 1`/`x = b && 1` skipped
// this REJECT entirely, silently keeping the wrong raw NUMBER carrier).
//
// USE.REASSIGN is ALSO exempt, same as CAPTURE — a WRITE to `name` (this
// very assignment included: scanBindingUses records every `x = …` target as
// a REASSIGN "use" of x) is never itself an identity-OBSERVING read. Without
// this exemption the plain-assignment call site below always saw its own
// assignment statement as a disqualifying "use" and rejected UNCONDITIONALLY
// — even `let x; x = false ?? 1; return x ? 1 : 0` (pure truthiness
// downstream, which the decl-path's `let x = false ?? 1; return x ? 1 : 0`
// correctly accepts) — a real over-rejection caught by this fix's own test
// suite (test/errors.js "does NOT reject … truthiness"), not by the audit.
export function rejectAmbiguousBoolIdentity(name, expr) {
  if (typeof name !== 'string' || !hasAmbiguousBoolMerge(expr)) return
  const summary = scanBindingUses(ctx.func.body).get(name)
  const uses = summary ? summary[BINDING_USE_USES] : []
  const unsupported = uses.some(use =>
    use[BINDING_USE_KIND] !== USE.CAPTURE && use[BINDING_USE_KIND] !== USE.REASSIGN &&
    !(use[BINDING_USE_KIND] === USE.BOOL_TEST && use[BINDING_USE_OP] !== 'typeof'))
  if (unsupported)
    err(`Binding '${name}' can be both Boolean and Number, but its stored carrier erases that identity — use the merge expression directly or normalize with Boolean()/Number()`)
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
          const emittedArgs = emitCallArgs(argList, func.sig.params, func)
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
    // hunt record: .work/evidence.md §Carrier invariant, DECL-INIT WALL).
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
    // STILL BANKED (see .work/evidence.md §Carrier invariant for the hunt).
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
    // instead of 2.000000000000001 (.work/archive/carrier-representation-design.md
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
    const ambiguousIdentity = typeof name === 'string' && hasAmbiguousBoolMerge(init)
    if (ambiguousIdentity && !neverEscapes) rejectAmbiguousBoolIdentity(name, init)
    const identityCapture = ambiguousIdentity && ctx.func.capturedNames?.has(name)
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
  if (vt) ctx.func.localValTypesOverlay.set(name, vt)
  else ctx.func.localValTypesOverlay.delete(name)
}

const FLOW_LOOP_OPS = new Set(['while', 'do', 'for', 'for-in', 'for-of'])

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
  try {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i]
      if (s == null || typeof s === 'number') continue
      out.push(...emitVoid(s))
      // Sibling statements after an unconditional return/throw/break/continue
      // (or a nested `{}`/`;`-block whose OWN last statement is one) are
      // UNREACHABLE — real JS never evaluates them, so a reference inside
      // one never actually ReferenceErrors either (the read never happens).
      // Stop walking the rest of THIS statement list rather than emit (and
      // wrongly reject, per src/compile/emit.js's bare-identifier-fallback
      // reject — see that fallback's own comment) code that can never run.
      // isTerminator (src/type.js) is the same "always exits via return/
      // throw/break/continue" predicate this function already trusts for
      // post-terminator type-refinement, just below — reused, not
      // reinvented. Narrower than full reachability (an `if/else` where
      // BOTH arms terminate isn't recognized as unconditional here, matching
      // isTerminator's own existing scope) but sound as far as it goes: a
      // false negative here just re-walks code that's actually fine to skip
      // (the wall-protocol default — reject only fires for something truly
      // unresolved), never a false positive that skips reachable code.
      if (isTerminator(s)) break
      // Position-sensitive invalidation FIRST, re-record SECOND: stmts[i]'s
      // own top-level target (if any) is the authoritative post-statement
      // state and must win over a same-statement nested self-write (e.g. a
      // closure IIFE'd into its own RHS that also happens to assign the
      // target name) — an edge case, but cheap to order correctly.
      for (const name of flatWrites[i]) frame.localValTypesOverlay.delete(name)
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
      if (sigParams.length > MAX_CLOSURE_ARITY) err(`Function ${node} used as closure value has ${sigParams.length} params, exceeds MAX_CLOSURE_ARITY=${MAX_CLOSURE_ARITY} — bundle the extra parameters into one array/object argument`)
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
