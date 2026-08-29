import { OPTF } from './ctx.js'
import { ERR } from '../err-codes.js'
/**
 * Pure IR construction helpers for WAT-as-array output.
 *
 * # Stage contract
 *   IN:  bare primitives (strings, numbers, AST nodes), ctx reads for locals/globals/schema
 *   OUT: tagged IR nodes (arrays with `.type` property)
 *   NO-EMIT: nothing here calls `emit()` — these are leaf constructors. Helpers that
 *        recurse into AST nodes (toBool, materializeMulti, emitDecl, buildArrayWithSpreads,
 *        emitTypeofCmp) live in emit.js because they invoke the dispatch table.
 *
 * # Layers
 *   - Type tagging (`typed`, coercions)
 *   - Nullish sentinels + NaN-boxed pointer construction
 *   - Literal / purity classifiers
 *   - Constant pools (WASM_OPS, MEM_OPS, mutator sets)
 *   - Temp-local factories (mutate `ctx.func.locals`)
 *   - Variable storage abstraction (boxed/global/local dispatch)
 *   - Array-layout IR (slot/elem loads, allocPtr, arrayLoop)
 *
 * @module ir
 */

import { ctx, err, inc, PTR, LAYOUT } from './ctx.js'
import { declareLocal, freshEmitId } from './compile/active-function.js'
import { BIGINT_REP_BOXED, BIGINT_REP_CLOSED, REP_EDGE_BOX, REP_EDGE_UNBOX, representationActiveMaterializedRep } from './compile/representation-plan.js'
import { ptrBoxPrefixBigInt, ptrBits, i64Hex, atomNanHex, nanPrefixHex, OBJECT_SCHEMA_HI_MASK, objectSchemaGuardHex } from '../layout.js'
import { ERR_CLASS_NAMES } from '../err-codes.js'
import { I32_MIN, I32_MAX, isI32, isLiteralStr, isFuncRef, isLeaf, walkAst, some, REFS_THROUGH_ARROWS } from './ast.js'
import { VAL, lookupValType, repOf, repOfGlobal } from './reps.js'
import { valTypeOf, censusMaybeUndefined, censusMaybeUndefinedKind, censusShapedNode } from './kind.js'
import { T } from './ast.js'
import { objLiteralSchemaId } from './static.js'

export { I32_MIN, I32_MAX, isI32, isLiteralStr, isFuncRef }

import { typed } from './ir/tag.js'
export { typed }

import { freshId, temp, tempI32, tempI64, block64, blockTyped, withTemp } from './ir/locals.js'
export { freshId, temp, tempI32, tempI64, block64, blockTyped, withTemp }

import { mkPtrIR, ptrOffsetIR, valKindToPtr, ptrTypeIR, extractF64Bits, ptrTypeEq, dispatchByPtrType, boxPtrIR } from './ir/pointers.js'
export { mkPtrIR, ptrOffsetIR, valKindToPtr, ptrTypeIR, extractF64Bits, ptrTypeEq, dispatchByPtrType }

import { MAX_CLOSURE_ARITY, MEM_OPS, WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS, isLit, litVal, isNullLit, isUndefLit, isNullishLit, isPureIR, hasExpensiveOp, dataDependentFlag, isNumericIR, resolveValType, isPostfix, emitNum, PURE_F64_OPS } from './ir/classify.js'
export { MAX_CLOSURE_ARITY, MEM_OPS, WASM_OPS, SPREAD_MUTATORS, BOXED_MUTATORS, isLit, litVal, isNullLit, isUndefLit, isNullishLit, isPureIR, hasExpensiveOp, dataDependentFlag, isNumericIR, resolveValType, isPostfix, emitNum }

import { multiCount, loopTop, flat, findBodyStart, verifyFn, buildRefcount, nextLocalId, freshLoopPlanId, tcoTailRewrite, reconstructArgsWithSpreads } from './ir/control.js'
export { multiCount, loopTop, flat, findBodyStart, verifyFn, buildRefcount, nextLocalId, freshLoopPlanId, tcoTailRewrite, reconstructArgsWithSpreads }

import { asF64, asI32, asI32Sat, asPtrOffset, asParamType, maskBound, f64Range, toI32, asI64, fromI64, f64rem } from './ir/numeric.js'
export { asF64, asI32, asI32Sat, asPtrOffset, asParamType, maskBound, f64Range, toI32, asI64, fromI64, f64rem }

import { bigintStrict, bigintEraseErr, boxBigInt, unboxBigInt, applyBigintRepresentationAction, maybeUnboxBigInt, isSchemaSlotBigintPossible, isTernaryBoxedBigint, isPlanTaggedBigint, readI64 } from './ir/bigint.js'
export { bigintStrict, bigintEraseErr, boxBigInt, unboxBigInt, applyBigintRepresentationAction, maybeUnboxBigInt, isSchemaSlotBigintPossible, isTernaryBoxedBigint, isPlanTaggedBigint, readI64 }

import { usesDynProps, needsDynShadow, isBoundName, isGlobal, isConst, boxedAddr, dollar, dollarMap, setDollarMap, clearDollar, readVar, writeVar } from './ir/vars.js'
export { usesDynProps, needsDynShadow, isBoundName, isGlobal, isConst, boxedAddr, dollar, dollarMap, setDollarMap, clearDollar, readVar, writeVar }

/** Reserved atoms (PTR.ATOM tag, offset=0).
 *    aux=1 → null      (NULL_NAN)
 *    aux=2 → undefined (UNDEF_NAN)
 *    aux=4 → false     (FALSE_NAN)
 *    aux=5 → true      (TRUE_NAN)
 *  See module/symbol.js for the broader reserved-atom-id scheme.
 *  Distinct from 0, NaN, and all pointers. Triggers default params.
 *  At the JS boundary, null and undefined preserve their identity for interop. */
export const NULL_NAN = atomNanHex(1)
export const UNDEF_NAN = atomNanHex(2)
/** Zombie-entry key sentinel for the durable-slot heal (__durable_slot_heal,
 *  module/core.js): written over a healed durable dict entry's KEY so probes and
 *  enumeration skip it. Unforgeable: ATOM tag with a saturated aux+offset no
 *  boxing path ever produces (real atom ids are tiny). Every equality family is
 *  deref-free on it: i64.eq mismatches, __str_eq bails on the non-STRING tag,
 *  __same_value_zero's atom arm is bit-equality. */
export const TOMB_NAN = '0x7FF87FFFFFFFFFFF'
/** Boxed-boolean carrier. `false`/`true` are reserved atoms — materialized only
 *  where boolean identity is observed (typeof/String/JSON/host boundary); in
 *  branch/arithmetic position booleans stay raw i32/f64 0/1. The atomId encodes
 *  the truth value in its low bit (4=false, 5=true), so `aux & 1` recovers 0/1
 *  and `4 | bit` boxes it — see boolBoxIR / unboxBoolIR. */
export const BOOL_ATOM_BASE = 4
export const FALSE_NAN = atomNanHex(4)
export const TRUE_NAN = atomNanHex(5)
/** WAT-template-ready sentinel expressions for use in stdlib template strings.
 *  `f64.const nan:0xHEX` is 3 bytes shorter than `f64.reinterpret_i64 (i64.const ...)`. */
export const NULL_WAT = `(f64.const nan:${NULL_NAN})`
export const UNDEF_WAT = `(f64.const nan:${UNDEF_NAN})`
export const NULL_IR = ['f64.const', `nan:${NULL_NAN}`]
export const UNDEF_IR = ['f64.const', `nan:${UNDEF_NAN}`]
export const FALSE_IR = ['f64.const', `nan:${FALSE_NAN}`]
export const TRUE_IR = ['f64.const', `nan:${TRUE_NAN}`]
// .slice() before typed(): NULL_IR is a shared module-level template (like its
// UNDEF_IR/FALSE_IR/TRUE_IR siblings below, which already copy) — typed() tags
// `.type` onto the node it's given, so calling it on the shared array directly
// mutates ONE instance repeatedly. Natively harmless (same idempotent value each
// time, plain GC heap). In the self-hosted kernel `.type=` is a dynamic-key write
// that lazily allocates a per-object props sidecar the FIRST time it's called —
// which happens well after module-init (`__start`), so that sidecar lives ABOVE
// `__heap_reset` in the bump arena and dangles after `_clear` rewinds it: the
// NEXT `nullExpr()` call (next compile) reads NULL_IR's now-stale header propsPtr
// and corrupts memory. A missing `.slice()` this whole time — surfaced only by
// warm-instance reuse actually re-invoking it post-`_clear`.
export const nullExpr = () => typed(NULL_IR.slice(), 'f64')
export const undefExpr = () => typed(UNDEF_IR.slice(), 'f64')

/** Materialize the boxed-boolean carrier from a 0/1-valued expression. The atom
 *  is `BOOL_ATOM_BASE | bit`, so boxing is one `i32.or` then an ATOM mkptr; when
 *  the input folds to a constant 0/1 we emit the `f64.const nan:` literal directly.
 *  Used only at observation/escape sites — never in branch or arithmetic position. */
export function boolBoxIR(e) {
  const i = truthyIR(e)
  if (Array.isArray(i) && i[0] === 'i32.const') return typed((i[1] ? TRUE_IR : FALSE_IR).slice(), 'f64')
  return mkPtrIR(['i32.const', PTR.ATOM], ['i32.or', ['i32.const', BOOL_ATOM_BASE], i], ['i32.const', 0])
}

/** Value-preserving f64 carrier for a value entering an untyped slot — container
 *  stores, collection keys/values, dyn-prop writes, generic call args. A boolean
 *  keeps its identity as the TRUE/FALSE atom box (typeof/String/strict-eq survive
 *  the round-trip); everything else takes the plain asF64 box. Never use in branch
 *  or arithmetic position — truthyIR/toNumF64 own those (raw 0/1 there by design).
 *  Callers emit(node) ONCE and pass both (emitting per-arm inside a ternary wrapped
 *  by different coercions is the self-host-fragile shape — see emit.js 'return'). */
export function carrierF64(node, emitted, kind = 'collection') {
  if (valTypeOf(node) === VAL.BOOL) return boolBoxIR(emitted)
  // BigInt normalization is owned by RepresentationPlan at the caller's
  // concrete edge. Strict mode remains a diagnostic for an unresolved
  // generic slot; it does not choose the default representation.
  if (bigintStrict() && valTypeOf(node) === VAL.BIGINT &&
      !(Array.isArray(node) && node[0] === '?:'))
    bigintEraseErr(kind, typeof node === 'string' ? node : 'this expression')
  return asF64(emitted)
}

/** BOOL-preserving carrier for statically narrow slots. BigInt edges are
 *  normalized by RepresentationPlan before reaching this helper. */
export function carrierF64Narrow(node, emitted, kind = 'collection') {
  if (valTypeOf(node) === VAL.BOOL) return boolBoxIR(emitted)
  return asF64(emitted)
}

/** Recover the 0/1 i32 value of a known boxed-boolean f64 expression: `aux & 1`. */
export function unboxBoolIR(f64expr) {
  if (Array.isArray(f64expr) && f64expr[0] === 'f64.const') {
    const bits = typeof f64expr[1] === 'string' ? f64expr[1].replace(/^nan:/, '') : null
    if (bits === TRUE_NAN) return typed(['i32.const', 1], 'i32')
    if (bits === FALSE_NAN) return typed(['i32.const', 0], 'i32')
  }
  return typed(['i32.and', ['i32.wrap_i64', ['i64.shr_u', ['i64.reinterpret_f64', f64expr], ['i64.const', String(LAYOUT.AUX_SHIFT)]]], ['i32.const', 1]], 'i32')
}

// === Constants ===

/** ToPrimitive sidecar probe (ES2024 7.1.1): an own `valueOf`/`toString` data
 *  property shadows the builtin. Reads the dynamic-prop sidecar slot keyed by
 *  `nameIR` (an emitted i64 string key) off receiver `objIR`; if it holds a
 *  closure, yields `onOverride($p)`, else `onFallback($o)` (both f64). Shared by
 *  the member-READ path (module/core.js — onOverride returns the closure value,
 *  onFallback calls the arity-≤1 builtin) and the method-CALL path (emit.js —
 *  onOverride invokes the closure, onFallback calls the builtin method). */
export function sidecarOverride(objIR, nameIR, onOverride, onFallback) {
  const o = temp('vo'), p = temp('vp')
  inc('__dyn_get_expr', '__ptr_type')
  // Primitive receivers can never carry an own property that shadows a
  // builtin (numbers: no props at all; strings: property writes drop —
  // module/collection.js STRING arms), so the override probe is statically
  // futile for them. One inline number test + tag test skips the 3-frame
  // __dyn_get_expr chain — parser loops calling s.charCodeAt through an
  // unproven receiver were paying it per character (jessie: 1.19M/run at
  // one site). The or's second operand reads garbage tag bits when the
  // first is true (real number) — harmless, the or is already decided.
  return block64(
    ['local.set', `$${o}`, asF64(objIR)],
    ['local.set', `$${p}`, ['if', ['result', 'f64'],
      ['i32.and',
        ['f64.ne', ['local.get', `$${o}`], ['local.get', `$${o}`]],
        ['i64.ne',
          ['i64.and', ['i64.reinterpret_f64', ['local.get', `$${o}`]], ['i64.const', i64Hex(BigInt(LAYOUT.TAG_MASK) << BigInt(LAYOUT.TAG_SHIFT))]],
          ['i64.const', i64Hex(BigInt(PTR.STRING) << BigInt(LAYOUT.TAG_SHIFT))]]],
      ['then', ['f64.reinterpret_i64',
        ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ['local.get', `$${o}`]], nameIR]]],
      ['else', undefExpr()]]],
    ['if', ['result', 'f64'],
      ptrTypeEq(['local.get', `$${p}`], PTR.CLOSURE),
      ['then', onOverride(p, o)],
      ['else', onFallback(o)]])
}

/** Resolve the slot index of a ToPrimitive method (`valueOf`/`toString`) on an
 *  OBJECT operand — from a schema-bound variable or an inline object literal.
 *  Returns -1 when the method is absent. */
function primMethodIdx(node, name) {
  if (typeof node === 'string') return ctx.schema.slotOf(node, name)
  const sid = objLiteralSchemaId(node)
  const props = sid != null ? ctx.schema.list[sid] : null
  return props ? props.indexOf(name) : -1
}

/** Emit the ES `OrdinaryToPrimitive` method-fallback chain for an OBJECT operand,
 *  returning an i64 IR node holding the resulting primitive — or null when the
 *  object exposes none of the hinted methods. `order` is the method-try order
 *  (number hint → [valueOf,toString]; string hint → [toString,valueOf]). Each
 *  present method is called in turn: a primitive result short-circuits out, a
 *  non-primitive (object) result falls through to the next method, and if every
 *  method yields a non-primitive a TypeError is thrown — the spec algorithm.
 *  `present` (from primMethodIdx) only proves the property NAME exists in the
 *  object's schema — a schema slot's stored VALUE can be anything (`{toString:
 *  void 0}` is a completely ordinary object literal), so each slot is guarded
 *  by a PTR.CLOSURE check before being called: GetMethod (ES 7.3.11), which
 *  OrdinaryToPrimitive calls for each method name, treats a non-callable
 *  value the SAME as an absent one (skip to the next method in the chain) —
 *  it does not invoke it. Without this guard a `toString`/`valueOf` slot
 *  holding `undefined` (or any other non-closure value) was loaded and handed
 *  straight to ctx.closure.call as if it were a real closure pointer —
 *  confirmed live as a WebAssembly "table index is out of bounds" trap
 *  (String({valueOf:()=>'42', toString: void 0}), which per spec must skip
 *  the non-callable toString and fall through to valueOf). */
function toPrimitiveChain(node, v, order) {
  const present = order.map(name => primMethodIdx(node, name)).filter(i => i >= 0)
  if (!present.length) return null
  ctx.runtime.throws = true
  inc('__is_object')
  const blk = `$tp${freshId(ctx)}`
  const prim = tempI64('prim')
  const optr = tempI32('op')
  const mslot = temp('tpm')
  // Resolve the object's data pointer once — `v` may carry side effects and is
  // referenced once per method slot below.
  const body = [['result', 'i64'],
    ['local.set', `$${optr}`, ptrOffsetIR(v, VAL.OBJECT)]]
  for (const idx of present) {
    const method = typed(ctx.abi.object.ops.load(['local.get', `$${optr}`], idx), 'f64')
    // NOT `br_if`: br_if's block-result operand stays on the stack when its
    // condition is false (WASM's `[t i32] -> [t]` typing — that's how a
    // fallthrough sees the value at all), so nesting one inside a void `if`
    // (this method's callability guard) only balances on the taken path —
    // the not-taken path leaves a stray i64 the void `if` can't account for
    // ("expected 0 elements on the stack for fallthru, found 1"). An
    // unconditional `br` has no not-taken path to leave anything on, so it
    // nests cleanly inside either void `if` (not callable / non-primitive
    // result) — both just fall through empty, exactly like the pre-existing
    // "this method isn't present at all" case already did.
    body.push(
      ['local.set', `$${mslot}`, method],
      ['if', ptrTypeEq(['local.get', `$${mslot}`], PTR.CLOSURE),
        ['then',
          ['local.set', `$${prim}`, asI64(ctx.closure.call(typed(['local.get', `$${mslot}`], 'f64'), []))],
          ['if', ['i32.eqz', ['call', '$__is_object', ['local.get', `$${prim}`]]],
            ['then', ['br', blk, ['local.get', `$${prim}`]]]]]])
  }
  // Every method was absent, non-callable, or returned a non-primitive —
  // `Cannot convert object to primitive`.
  body.push(['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', ERR.TO_PRIMITIVE]]], ['throw', '$__jz_err', ['f64.const', ERR.TO_PRIMITIVE]])
  return typed(['block', blk, ...body], 'i64')
}

/** Structural clone of an already-emitted IR node. Two DIFFERENT positions in the
 *  final tree must never share one node object: a later pass (CSE, peephole, local
 *  renumbering) that walks the tree and mutates/tags a node in place only sees ONE
 *  of the two logical occurrences and silently mutates both — the exact "IR-aliasing"
 *  hazard multiple emit sites must avoid when a value is READ into more than one
 *  branch of an if/else or more than one argument position. Caller's responsibility:
 *  the node must be side-effect-free to duplicate (a local/cell read, not a call) —
 *  see coerceNullishToNum below for the established idiom. Does not preserve `.type`/
 *  `.ptrKind` (a plain array map): every consumer of a cloned node already re-derives
 *  those from context (`node?.type ? node : typed(node, 'f64')`), so this only needs
 *  to reproduce the value-computing shape, not its cached metadata. */
export const cloneIR = (n) => Array.isArray(n) ? n.map(cloneIR) : n

/** ToNumber for a runtime value that may carry a nullish sentinel: null→+0, undefined→NaN,
 *  anything else → itself. `valIR` must be side-effect-free (a local read) — it is duplicated,
 *  so each occurrence gets a fresh clone. Used for bindings flagged in ctx.func.maybeNullish;
 *  a real number isn't either sentinel, so it falls through the `else` unchanged. */
export const coerceNullishToNum = (valIR) => typed(
  ['if', ['result', 'f64'],
    ['i64.eq', ['i64.reinterpret_f64', cloneIR(valIR)], ['i64.const', NULL_NAN]],
    ['then', ['f64.const', 0]],
    ['else', ['if', ['result', 'f64'],
      ['i64.eq', ['i64.reinterpret_f64', cloneIR(valIR)], ['i64.const', UNDEF_NAN]],
      ['then', ['f64.const', 'nan']],
      ['else', cloneIR(valIR)]]]],
  'f64')

/** ToString for an i64 string carrier that may hold the UNDEF_NAN sentinel:
 *  undefined→"undefined", anything else → itself. The STRING-domain mirror of
 *  coerceNullishToNum just above — same "`valIR` must be side-effect-free, it
 *  is duplicated" contract — but only ONE sentinel arm (never NULL_NAN: this
 *  design's whole census/maybeUndefined machinery is specifically about a
 *  dict/Map absent-key read, which is real JS `undefined`, never `null` —
 *  matching toNumF64's own NUMBER-census widening, which is likewise gated
 *  to NUMBER only, never both nullish kinds). "undefined" reuses the fixed
 *  static-string table module/number.js already builds for every OTHER
 *  nullish/NaN-to-string site in the codebase (`__static_str(6)` — see its
 *  own doc comment for the full index table) rather than a new string-
 *  constant mechanism: MAX_SSO=6 can't hold 9-char "undefined" inline
 *  (ssoStrI64 below is not an option), and this file's NO-EMIT contract
 *  (module/string.js imports FROM here, so the reverse import would cycle —
 *  see ssoStrI64's own doc) blocks reaching `emit(['str', …])` for a fresh
 *  data-segment literal. `inc('__static_str')` is the established, ALREADY-
 *  used-from-outside-its-owning-module precedent (module/atomics.js's
 *  `Atomics.wait`, which pulls the SAME helper the same way for its
 *  'ok'/'not-equal'/'timed-out' results) — safe here because every call site
 *  of toStrI64's widening below is itself a STRING-coercion context
 *  (String()/template-literal/`+`-concat), which autoload.js's own MOD_DEPS
 *  already makes depend on 'number' before 'string' loads, so `__static_str`
 *  is always registered by the time this runs. */
export const coerceNullishToStr = (valIR) => {
  inc('__static_str')
  return typed(
    ['if', ['result', 'i64'],
      ['i64.eq', cloneIR(valIR), ['i64.const', UNDEF_NAN]],
      ['then', typed(['i64.reinterpret_f64', ['call', '$__static_str', ['i32.const', 6]]], 'i64')],
      ['else', cloneIR(valIR)]],
    'i64')
}

/** Coerce an emitted IR value to a plain f64 Number per JS `ToNumber`.
 *  Skips coercion when static type proves the value is already numeric
 *  (i32 node, compile-time literal, known VAL.NUMBER/VAL.BIGINT). When the full
 *  string-parsing `__to_num` isn't loaded (no string module → no strings can
 *  exist) nullish *literals* still fold statically (null→+0, undefined→NaN);
 *  non-literal values pass through uncoerced — except bindings flagged
 *  maybeNullish, which get a runtime nullish coerce (null-flow correctness). */
export function toNumF64(node, v) {
  // An i32 node carrying `.ptrKind` is an *unboxed pointer* (object/array local),
  // not a number — skipping coercion would reinterpret pointer bits as an f64.
  // Only a plain i32 (loop counter, `x|0`) is genuinely already-numeric.
  if ((v.type === 'i32' && v.ptrKind == null) || isLit(v)) return asF64(v)
  // A DIRECT sentinel const (a statically-proven-OOB read folds straight to
  // UNDEF, no if-form) coerces per ToNumber before the vt fast-outs below —
  // valTypeOf claims NUMBER from the receiver's element type, blind to the
  // OOB path, and the raw payload would ride f64 arithmetic out as `undefined`.
  if (Array.isArray(v) && v[0] === 'f64.const' && typeof v[1] === 'string') {
    if (v[1] === `nan:${UNDEF_NAN}`) return typed(['f64.const', 'nan'], 'f64')
    if (v[1] === `nan:${NULL_NAN}`) return typed(['f64.const', 0], 'f64')
  }
  // Checked typed-array read (`.typed:[]` tags checkedNumRead): number|undefined
  // with the undefined confined to a CONSTANT miss arm. ToNumber of that arm
  // folds statically (undefined → canonical NaN) — the hit arm is already a
  // plain-number load. Without the fold the UNDEF sentinel enters f64 arithmetic
  // as a "number" (valTypeOf claims NUMBER from the ELEMENT type, blind to the
  // OOB path — checked BEFORE the vt fast-outs below for exactly that reason),
  // and hardware NaN propagation carries its PAYLOAD to the escape, where the
  // boundary decodes it back as `undefined` (JS: NaN).
  if (v.checkedNumRead && Array.isArray(v)) {
    const foldArm = (n) => Array.isArray(n) && n[0] === 'f64.const' && n[1] === `nan:${UNDEF_NAN}`
      ? ['f64.const', 'nan'] : n
    if (v[0] === 'if')   // (if (result f64) cond (then load) (else UNDEF))
      return typed(v.map(c => Array.isArray(c) && c[0] === 'else' && c.length === 2
        ? ['else', foldArm(c[1])] : c), 'f64')
    if (v[0] === 'block') {   // (block (result f64) …sets (select load UNDEF in))
      const tail = v[v.length - 1]
      if (Array.isArray(tail) && tail[0] === 'select')
        return typed([...v.slice(0, -1), ['select', tail[1], foldArm(tail[2]), tail[3]]], 'f64')
    }
  }
  // A binding assigned a nullish literal may hold null/undefined here — coerce per ToNumber
  // (null→+0, undefined→NaN); a real number falls through unchanged. Only flagged bindings pay
  // this, so the numeric kernels jz optimizes for (which never assign null) stay untouched.
  if (typeof node === 'string' && ctx.func.maybeNullish?.has(node)) return coerceNullishToNum(asF64(v))
  const vt = valTypeOf(node)
  if (vt === VAL.BOOL) return typed(['f64.convert_i32_s', truthyIR(v)], 'f64')
  // Slice 7 widening (.work/todo.md §deletion-sweep §14/§15's own
  // honest-boundary gap): `vt` stays permanently null for a decl/param/capture-
  // hopped census-NUMBER claim (§14 point 3 — `val` never carries a census
  // claim, by construction) even though `presentVal` (Slice 6, kind.js
  // `censusMaybeUndefinedKind`) already proves the exact same "every value
  // ever WRITTEN was NUMBER" fact the branch below already trusts once
  // `valTypeOf` itself happens to prove it (currently only the param case,
  // where `val` IS `vt`'s own source — see that function's own doc comment).
  // Consult it directly instead of waiting on `vt`, strictly for NUMBER —
  // never BIGINT, for the exact reason the comment just below stays unchanged
  // (ToNumber(bigint) throws in real JS; this whole family stays as
  // permissively unsound for BIGINT as it always was, not newly closed here).
  const censusNum = vt == null && censusMaybeUndefinedKind(node) === VAL.NUMBER
  if (vt === VAL.NUMBER || vt === VAL.BIGINT || censusNum) {
    // maybeUndefined join (.work/todo.md §deletion-sweep §1a): a dict-census
    // NUMBER claim is a "every value ever WRITTEN" fact, not a "this key
    // exists" proof — an absent key reads real `undefined` at runtime. Gated
    // on VAL.NUMBER only (never BIGINT: real JS THROWS mixing BigInt and
    // undefined in arithmetic, coerceNullishToNum's undefined→NaN answer
    // would be wrong there — left exactly as unsound as today, not newly
    // broken, not closed by this fix). censusMaybeUndefined short-circuits on
    // node[0] before touching ctx.func.localReps, so every proven-NUMBER
    // site that isn't a dict-mode `[]`/`.` read (loop counters, schema slots,
    // the overwhelming hot-path case) pays zero new cost — same node object,
    // same asF64(v) call, no new branch taken.
    if ((vt === VAL.NUMBER || censusNum) && censusMaybeUndefined(node)) {
      // coerceNullishToNum's OWN contract (its doc comment above): `valIR`
      // "must be side-effect-free... it is duplicated". True for the dict/
      // Map direct-read shape (censusShapedNode) and a bare name (a local
      // read) — both pure. NOT true for kind.js's call-result arm
      // (censusMaybeUndefinedKind's `callResultMayBeUndefinedKind` fallback,
      // .work/todo.md §deletion-sweep §5 criterion 3): an arbitrary
      // function call can have real side effects, and cloneIR's triplication
      // would fire them 3x — a captured-mutation counter would increment 3x
      // instead of once when its value flows through a non-inlined callee's
      // return before reaching `+`. INVARIANT: hoist into a temp
      // FIRST so cloneIR only triplicates a cheap `local.get` — one
      // evaluation, sound for every node shape, byte-identical to before for
      // the two ORIGINAL (pure) arms since this branch is skipped for them.
      // Kept even though currently unreachable: `vt === VAL.NUMBER` for a
      // call node requires `func.valResult` to have already settled NUMBER
      // for a census-shaped return tail, which itself requires the
      // VT['[]']/['.']/['()'] promotion that stays dormant (see kind.js's
      // dict-value-census consumer) — so this whole branch is
      // sound-but-inert today, same status as kind.js's
      // callResultMayBeUndefinedKind it protects.
      if (typeof node !== 'string' && !censusShapedNode(node)) {
        const t = temp('cnn')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, asF64(v)],
          coerceNullishToNum(typed(['local.get', `$${t}`], 'f64'))], 'f64')
      }
      return coerceNullishToNum(asF64(v))
    }
    return asF64(v)
  }
  if (vt === VAL.DATE) {
    const ptr = v.ptrKind === VAL.DATE
      ? v
      : ['i32.wrap_i64', ['i64.reinterpret_f64', asF64(v)]]
    return typed(['f64.load', ptr], 'f64')
  }
  // ToPrimitive (number hint): an OBJECT operand coerces through the
  // `OrdinaryToPrimitive` method chain [valueOf, toString] — `valueOf` is tried
  // first, and when it yields a non-primitive `toString` is tried; if both
  // yield non-primitives a TypeError is thrown. The chosen primitive still
  // flows through `__to_num` so a string return ("−7") is parsed. An abrupt
  // completion (throwing method) propagates through the closure call.
  if (vt === VAL.OBJECT && ctx.closure.call && ctx.schema.slotOf) {
    const prim = toPrimitiveChain(node, v, ['valueOf', 'toString'])
    if (prim) {
      // No `__to_num` helper → the program provably has no strings, so the
      // primitive is a non-string value already usable as an f64.
      if (!ctx.core.stdlib['__to_num']) return asF64(prim)
      inc('__to_num')
      return typed(['call', '$__to_num', prim], 'f64')
    }
  }
  // intCertain locals: every reachable def is integer-valued, so the binding
  // never carries a NaN-boxed pointer — skip the __to_num wrapper.
  if (typeof node === 'string' && repOf(node)?.intCertain === true) return asF64(v)
  // intCertain schema slot reads `o.x`: every observed write is integer-shaped,
  // so the loaded f64 is a plain number — same justification as the local case.
  if (Array.isArray(node) && node[0] === '.' && typeof node[1] === 'string' && typeof node[2] === 'string') {
    if (ctx.schema.slotIntCertainAt?.(node[1], node[2]) === true) return asF64(v)
  }
  // Guarded schema-slot read whose ONE schema censuses the slot NUMBER
  // (emitSchemaSlotGuarded's stamp): SINK the coercion into the arms — the
  // guard-HIT raw load is already a plain number; only the dyn-miss arm pays
  // __to_num. The shapes-dispatch pattern (`measure(o)` over 8 schemas) drops
  // a per-field ToNumber call from every hot read this way.
  if (v.guardedNumSlot && Array.isArray(v) && v[0] === 'if') {
    const out = v.map((c, i) => {
      if (Array.isArray(c) && c[0] === 'else' && c.length === 2) {
        if (!ctx.core.stdlib['__to_num']) return c
        inc('__to_num')
        return ['else', typed(['call', '$__to_num', asI64(typed(c[1], 'f64'))], 'f64')]
      }
      return c
    })
    return typed(out, 'f64')
  }
  // IR-level shapes that produce real f64 numbers (never NaN-boxed pointers):
  // i32→f64 conversions, stdlib clock helper, length/ptr helpers.
  // Skip the __to_num call wrapper for these — they always return plain f64.
  if (Array.isArray(v)) {
    if (v[0] === 'f64.convert_i32_s' || v[0] === 'f64.convert_i32_u') return v
    if (v[0] === 'call' && v[1] === '$__time_ms') return v
    // __len/__str_len return numeric lengths. Raw __length.value is ordinary
    // property Get and may return any JS value; select the sibling numeric
    // helper so only its ordinary-property arm pays ToNumber.
    if (v[0] === 'call' && (v[1] === '$__len' || v[1] === '$__str_len')) return v
    if (v[0] === 'call' && v[1] === '$__length.value') {
      inc('__length')
      return typed(['call', '$__length', v[2]], 'f64')
    }
    // __ptr_type returns i32 tag, __ptr_offset returns i32 offset — both numeric.
    if (v[0] === 'call' && (v[1] === '$__ptr_type' || v[1] === '$__ptr_offset')) return v
  }
  // f64 arithmetic ops and math intrinsics never produce NaN-boxed pointers — the
  // result is always a plain f64 number. Skip __to_num for these, eliminating the
  // call overhead that dominates tight numeric kernels (floatbeats, matrix loops).
  // A `block`/`if` qualifies only when its value-producing tail is provably numeric
  // (`isNumericIR`): `cond ? n*2 : n*3` skips, but `o.a?.b` (block yielding a
  // property value / undef sentinel) does NOT — else `o.a?.b > 6` would compare the
  // boxed string's NaN bits (NaN > 6 → false). User function calls are excluded too
  // (may return dynamic-property strings); only $math.* is provably numeric.
  if (v.type === 'f64' && Array.isArray(v) && (
    PURE_F64_OPS.has(v[0]) ||
    (v[0] === 'call' && typeof v[1] === 'string' && v[1].startsWith('$math.')) ||
    ((v[0] === 'block' || v[0] === 'if') && isNumericIR(v))
  )) return v
  if (!ctx.core.stdlib['__to_num']) {
    // No full ToNumber helper loaded — the program provably has no strings.
    // A nullish *literal* still coerces (null→+0, undefined→NaN) — fold it
    // statically so `Math.log10(null)` & friends are correct at zero cost.
    // Non-literal values fall through to `asF64`: an untyped runtime value
    // *could* be a nullish sentinel, but blanket per-use coercion taxes every
    // numeric kernel (fib, math loops) — nullable-param coercion belongs once
    // at the function boundary (null-flow inference), not at each use site.
    const f = asF64(v)
    if (Array.isArray(f) && f[0] === 'f64.const' && typeof f[1] === 'string') {
      const lit = f[1]
      if (lit.startsWith('nan:'))                           // NaN-boxed sentinel/pointer
        return typed(['f64.const', lit.slice(4) === NULL_NAN ? 0 : 'nan'], 'f64')
    }
    return f
  }
  inc('__to_num')
  // Inline number fast path (the engines' move): every non-NaN f64 IS its own
  // ToNumber — only NaN bit patterns (all NaN-boxed pointers + sentinels, plus
  // genuine NaN) take the call. One self-compare against a call per site; the
  // dictionary-count idiom (`o[k] | 0` on a number-or-undefined slot) drops a
  // per-token call this way. Optimize-gated: the O0 tier keeps the compact call.
  // RepresentationPlan boxes BigInt before any dynamically-kinded ToNumber
  // edge, so every non-NaN raw f64 is a Number. Tagged values take __to_num.
  if ((ctx.transform.optFlags & OPTF.inlineToNum)) {
    const t = temp('tnum')
    const get = () => ['local.get', `$${t}`]
    const notNan = ['f64.eq', get(), get()]
    const cond = notNan
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, asF64(v)],
      ['if', ['result', 'f64'],
        cond,
        ['then', get()],
        ['else', ['call', '$__to_num', ['i64.reinterpret_f64', get()]]]]], 'f64')
  }
  return typed(['call', '$__to_num', asI64(v)], 'f64')
}

/** Coerce an emitted IR value to a jz string per JS `ToString`, returning an
 *  i64 string value. The mirror of `toNumF64` for the string hint: an OBJECT
 *  operand coerces through `OrdinaryToPrimitive(string)` — method chain
 *  [toString, valueOf], `toString` first with fallback to `valueOf`, TypeError
 *  if both yield non-primitives. The chosen primitive still flows through
 *  `__to_str` so a numeric return is rendered. A throwing method propagates as
 *  an abrupt completion through the closure call. */
export function toStrI64(node, v) {
  const vt = valTypeOf(node)
  // STRING-census widening (.work/todo.md §deletion-sweep):
  // mirrors toNumF64's NUMBER-census widening for the
  // STRING case. Two shapes both currently fall all the way through to the
  // fully generic `__to_str` dynamic dispatch at the bottom of this function
  // whenever `censusMaybeUndefined(node)` is true: a decl/param-hopped
  // STRING-census claim (`vt` stays permanently null — `val`
  // never carries a census claim for that shape; `censusMaybeUndefinedKind`
  // proves it instead, via `presentVal`/`val` fallback) and a param whose
  // ordinary `val` fold happens to land STRING (the one shape where `vt`
  // itself already proves it, mirroring toNumF64's own "the param case,
  // where `val` IS `vt`'s own source"). The generic `__to_str` stdlib
  // helper's own UNDEF_NAN branch already renders "undefined", so this is a
  // pure codegen improvement, value-neutral — route both through a cheap
  // 2-branch sentinel dispatch (coerceNullishToStr, above) instead of the
  // full dynamic dispatch call.
  const censusStr = vt == null && censusMaybeUndefinedKind(node) === VAL.STRING
  if ((vt === VAL.STRING || censusStr) && censusMaybeUndefined(node)) {
    // Same triplication-safety concern toNumF64's own widening documents: a
    // direct census-shaped read or a bare-name copy-through is pure
    // (cloneIR-safe to duplicate inside coerceNullishToStr's if/else), but
    // the call-result arm (censusMaybeUndefinedKind's `callResultMayBeUndefinedKind`
    // fallback) can carry real side effects — hoist into a temp first so
    // only a cheap `local.get` gets duplicated.
    if (typeof node !== 'string' && !censusShapedNode(node)) {
      const t = tempI64('cns')
      return typed(['block', ['result', 'i64'],
        ['local.set', `$${t}`, asI64(v)],
        coerceNullishToStr(typed(['local.get', `$${t}`], 'i64'))], 'i64')
    }
    return coerceNullishToStr(asI64(v))
  }
  // ToString(string) is the identity — no coercion needed, no __to_str call.
  // Without this, a proven-string operand (a template-literal interpolation
  // `${s}`, module/string.js strcat's partStrI64) still paid for the fully
  // generic __to_str dispatch, dragging its NUMBER arm's Ryu float formatter
  // (__ftoa/__ftoa_shortest/__ryu_*) into any module with a dynamic template
  // literal — even one that never stringifies a number.
  // maybeUndefined join (.work/todo.md §deletion-sweep §1/Slice 5): a
  // dict-census STRING claim (every value ever WRITTEN through `name[k]=v`
  // was a string) is, same as the NUMBER claim toNumF64 already guards,
  // "every value ever written" — NOT "this key exists". An absent key reads
  // real `undefined` at runtime regardless of the census's claimed kind, so
  // `vt === VAL.STRING` here can be TRUE while `v`'s actual bits are
  // UNDEF_NAN. Module/string.js's `bind('String', …)` calls THIS function
  // believing it already routes maybeUndefined-flagged reads through the
  // general __to_str path (its own comment: "falls through to the LAST
  // branch... already correct") — true for a NUMBER-kind census (that
  // belief is what motivated skipping the __ftoa arm), but INVARIANT: this
  // STRING-kind identity fast-return must be GUARDED, not an unconditional
  // early return ABOVE that same LAST branch — an unguarded version lets a
  // STRING-census absent key hit IT first: `asI64(v)` reinterprets
  // the raw UNDEF_NAN bits as if they were a valid string i64, which decodes
  // back out as the bare `undefined` VALUE, not the string `"undefined"`
  // (breaks both String() and template-literal interpolation). Guarded at
  // THIS chokepoint (not the caller) so every caller (String(), strcat's
  // per-part loop) inherits it.
  if (vt === VAL.STRING && !censusMaybeUndefined(node)) return asI64(v)
  // Error-schema special case (.work/todo.md §deletion-sweep §Consequence): `${e}`/
  // String(e) on a real Error object must format via spec's Error.prototype.toString
  // (name if message empty / message if name empty / name+': '+message otherwise /
  // 'Error' if both empty — ECMA-262 20.5.3.4), not the generic OBJECT
  // toPrimitiveChain below (which knows nothing about Error, and Error exposes no
  // toString/valueOf slot for it to find) nor __to_str's fallback (raw pointer bits
  // reinterpreted as a string — wrong for every OBJECT kind __to_str
  // doesn't special-case, e.g. `${anyDynamicObject}` → "").
  // Gated on ctx.features.error (prepare's whole-program "is an Error class ever
  // constructed" scan, order-independent for the same reason ctx.features.bigint
  // is a prescan, not a during-emit flag — see toNumF64 above): a program that never
  // constructs an Error takes NONE of this, zero added bytes. Narrowed further to
  // vt == null (unknown/dynamic) || vt === VAL.OBJECT: a provably-non-OBJECT operand
  // (NUMBER/ARRAY/MAP/…) can never be our Error schema, so even an Error-using
  // program's non-Error toStrI64 call sites pay nothing extra.
  if (ctx.features.error && (vt == null || vt === VAL.OBJECT)) {
    const used = ctx.features.errorClasses
    const t = temp('everr')
    const get = () => typed(['local.get', `$${t}`], 'f64')
    // Brand model: each Error class carries its OWN sid, so
    // recognizing "this is SOME Error object" (any of the 7) needs one masked-
    // i64 guard per class the program actually constructs, OR'd together —
    // ERR_CLASS_NAMES' fixed order (not Set insertion order) so the emitted
    // chain depends only on WHICH classes exist, never incidental AST-walk
    // order. Same masked-i64-compare shape as module/core.js's
    // emitSchemaSlotGuarded / objectSchemaGuardHex (shared via layout.js) per
    // arm: proves "is an OBJECT" AND "is exactly this class's schema" in one
    // compare each.
    const guard = ERR_CLASS_NAMES.filter(c => used.has(c))
      .map(c => ['i64.eq',
        ['i64.and', asI64(get()), ['i64.const', OBJECT_SCHEMA_HI_MASK]],
        ['i64.const', objectSchemaGuardHex(ctx.schema.errorSid(c))]])
      .reduce((x, y) => ['i32.or', x, y])
    const off = ['i32.wrap_i64', ['i64.and', asI64(get()), ['i64.const', LAYOUT.OFFSET_MASK]]]
    return typed(['block', ['result', 'i64'],
      ['local.set', `$${t}`, asF64(v?.type ? v : typed(v, 'f64'))],
      ['if', ['result', 'i64'],
        guard,
        ['then', errToStringIR(off)],
        ['else', coerceRest(node, get(), vt)]]], 'i64')
  }
  return coerceRest(node, v, vt)
}

/** Everything toStrI64 did before the Error-schema special case existed — split
 *  out so that arm's runtime-guard "else" branch (a non-Error OBJECT, or any
 *  other kind, once the guard has already proven it isn't our Error schema)
 *  falls to EXACTLY this, unchanged. When ctx.features.error is false (no Error
 *  ever constructed) toStrI64 calls this directly with no wrapping at all — the
 *  zero-cost path for every Error-free program. */
function coerceRest(node, v, vt) {
  if (vt === VAL.OBJECT && ctx.closure.call && ctx.schema.slotOf) {
    const prim = toPrimitiveChain(node, v, ['toString', 'valueOf'])
    if (prim) {
      inc('__to_str')
      return typed(['call', '$__to_str', prim], 'i64')
    }
  }
  // Provably-integer operand → render with the i32-only formatter, bypassing __to_str's
  // float machinery (__ftoa/__toExp/__pow10, ~2 KB). A raw i32 value (`n|0`, a bitwise
  // result, a loop counter) carries no NaN-box, so its ToString is just digits + sign.
  // ptrKind != null means it's an unboxed pointer (i32 offset), NOT a number — exclude.
  if (v.type === 'i32' && v.ptrKind == null) {
    inc('__i32_to_str')
    return typed(['i64.reinterpret_f64', ['call', '$__i32_to_str', v]], 'i64')
  }
  inc('__to_str')
  // readI64 (CARRIER PROGRAM Slice 3): a proven-BIGINT node whose bare name
  // is a currently-boxed param must be unboxed before $__to_str sees it —
  // for every other shape this is byte-identical to the old asI64(v) call
  // (dynamic/unproven operands still pass their raw bits through unchanged,
  // for $__to_str's own tag dispatch to interpret).
  return typed(['call', '$__to_str', readI64(node, v)], 'i64')
}

/** Spec's Error.prototype.toString (20.5.3.4) for a proven Error-schema object,
 *  given `off` — an i32 IR expr for its payload byte offset (cloned per use: the
 *  emitted tree references it three times, and IR-aliasing corrupts a later
 *  local-lifetime pass — see cloneIR's doc). Loads message (slot 0) / name (slot
 *  1) once each, then: both empty → "Error"; message empty → name; name empty →
 *  message; else → name + ": " + message, via the same $__str_concat_fresh the
 *  ordinary `+` string-concat operator itself calls (not a new primitive). Every
 *  built-in class's `name` is a non-empty static literal (module/core.js's
 *  buildErrorObject) — the nameEmpty arm only fires if a caught Error's `.name`
 *  was reassigned to `''` after construction. */
function errToStringIR(off) {
  inc('__str_byteLen', '__str_concat_fresh')
  const tm = tempI64('emsg'), tn = tempI64('ename')
  const ml = tempI32('emlen'), nl = tempI32('enlen')
  return typed(['block', ['result', 'i64'],
    ['local.set', `$${tm}`, ctx.abi.object.ops.loadBits(cloneIR(off), 0)],
    ['local.set', `$${tn}`, ctx.abi.object.ops.loadBits(cloneIR(off), 1)],
    ['local.set', `$${ml}`, ['call', '$__str_byteLen', ['local.get', `$${tm}`]]],
    ['local.set', `$${nl}`, ['call', '$__str_byteLen', ['local.get', `$${tn}`]]],
    ['if', ['result', 'i64'],
      ['i32.eqz', ['local.get', `$${ml}`]],
      ['then', ['if', ['result', 'i64'],
        ['i32.eqz', ['local.get', `$${nl}`]],
        ['then', ssoStrI64('Error')],
        ['else', ['local.get', `$${tn}`]]]],
      ['else', ['if', ['result', 'i64'],
        ['i32.eqz', ['local.get', `$${nl}`]],
        ['then', ['local.get', `$${tm}`]],
        ['else', ['i64.reinterpret_f64', ['call', '$__str_concat_fresh',
          ['i64.reinterpret_f64', ['call', '$__str_concat_fresh', ['local.get', `$${tn}`], ssoStrI64(': ')]],
          ['local.get', `$${tm}`]]]]]]]], 'i64')
}

/** Pack a ≤6-char ALL-ASCII compile-time-known literal directly into an SSO
 *  NaN-boxed string i64 constant — no heap, no runtime call. This file has a
 *  NO-EMIT contract (see module header): module/string.js's `emit(['str', …])`
 *  path isn't reachable here (module/string.js imports FROM this file — the
 *  reverse import would cycle), so this duplicates the packing arithmetic of
 *  module/string.js's `ssoEncode` (the single runtime source of truth for
 *  user string literals) for the two FIXED literals errToStringIR needs
 *  ("Error", ": ") rather than import it. Both fit MAX_SSO=6 with room to
 *  spare; not a general-purpose literal builder. */
function ssoStrI64(str) {
  let offset = 0, auxChars = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i), bit = i * 7
    if (bit <= 24) offset |= c << bit
    else if (bit < 32) { offset |= (c & 0xF) << 28; auxChars |= c >> 4 }
    else auxChars |= c << (bit - 32)
  }
  const aux = LAYOUT.SSO_BIT | (str.length << 10) | auxChars
  return typed(['i64.const', i64Hex(ptrBits(PTR.STRING, aux, offset >>> 0))], 'i64')
}

/** Convert already-emitted WASM node to i32 boolean. NaN is falsy (like JS).
 *  Peepholes: i32 → as-is; `f64.convert_i32_*(x)` → x (i32 conversion never NaN);
 *  nested `__is_truthy(x)` → x (already 0/1); literal f64 const folds to 0/1. */
// f64 ops whose result is always a plain NUMBER (never a NaN-boxed carrier) and can
// be NaN — their truthiness must test NaN by value, not by bit pattern (see truthyIR).
const NUM_F64_TRUTHY_OPS = new Set([
  'f64.add', 'f64.sub', 'f64.mul', 'f64.div', 'f64.neg', 'f64.abs', 'f64.sqrt',
  'f64.min', 'f64.max', 'f64.ceil', 'f64.floor', 'f64.trunc', 'f64.nearest', 'f64.copysign',
])

const numericTruthy = e => {
  const t = temp('tb')
  const g = () => typed(['local.get', `$${t}`], 'f64')
  return typed(['block', ['result', 'i32'],
    ['local.set', `$${t}`, e],
    ['i32.and', ['f64.ne', g(), ['f64.const', 0]], ['f64.eq', g(), g()]]], 'i32')
}

// i32 ops whose result is already a 0/1 boolean (comparisons + eqz) — safe to use
// directly as a truthiness without a redundant `!= 0`.
// Ops whose result is already a canonical i32 boolean (0 or 1) — a condition built
// from one needs no `i32.ne(_, 0)` normalization. Every wasm comparison returns 0/1,
// so the f64/f32/i64 relations belong here too (they were missing — a `a > b ? …`
// f64 compare was wrapped in a dead `i32.ne(f64.gt …, 0)` in every branch/select).
const I32_BOOL_OPS = new Set(['i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u',
  'i32.le_s', 'i32.le_u', 'i32.ge_s', 'i32.ge_u', 'i32.eqz',
  'f64.eq', 'f64.ne', 'f64.lt', 'f64.gt', 'f64.le', 'f64.ge',
  'f32.eq', 'f32.ne', 'f32.lt', 'f32.gt', 'f32.le', 'f32.ge',
  'i64.eq', 'i64.ne', 'i64.lt_s', 'i64.lt_u', 'i64.gt_s', 'i64.gt_u',
  'i64.le_s', 'i64.le_u', 'i64.ge_s', 'i64.ge_u', 'i64.eqz'])

export function truthyIR(e) {
  // An i32 *constant* is a concrete number, not a known 0/1 boolean — fold it to its
  // truthiness (nonzero → 1).
  if (Array.isArray(e) && e[0] === 'i32.const') return typed(['i32.const', e[1] ? 1 : 0], 'i32')
  if (e.type === 'i32') {
    // A comparison/eqz result is already 0/1 → use directly. Any *other* i32 may be a
    // concrete narrowed integer (e.g. `Boolean(n)` where n is an i32 number), which is
    // NOT a 0/1 boolean — normalize via `!= 0` so its truthiness is correct.
    if (Array.isArray(e) && I32_BOOL_OPS.has(e[0])) return e
    return typed(['i32.ne', e, ['i32.const', 0]], 'i32')
  }
  // Unboxed pointer offsets: truthy iff non-zero offset.
  if (e.ptrKind != null) return typed(['i32.ne', e, ['i32.const', 0]], 'i32')
  if (Array.isArray(e)) {
    if (e[0] === 'f64.convert_i32_s' || e[0] === 'f64.convert_i32_u')
      return typed(['i32.ne', e[1], ['i32.const', 0]], 'i32')
    if (e[0] === 'call' && e[1] === '$__is_truthy') return typed(e, 'i32')
    // Fold literal f64 constants: zero/NaN → 0, any other number → 1.
    if (e[0] === 'f64.const' && typeof e[1] === 'number') {
      return typed(['i32.const', (e[1] !== 0 && !Number.isNaN(e[1])) ? 1 : 0], 'i32')
    }
    // Fold NaN-boxed sentinel literals in `f64.const nan:0x...` form (boolean
    // atoms, null/undefined): TRUE → 1, everything else nullish/false → 0.
    if (e[0] === 'f64.const' && typeof e[1] === 'string' && e[1].startsWith('nan:')) {
      const bits = e[1].slice(4)
      if (bits === TRUE_NAN) return typed(['i32.const', 1], 'i32')
      if (bits === FALSE_NAN || bits === UNDEF_NAN || bits === NULL_NAN) return typed(['i32.const', 0], 'i32')
    }
    // Fold NaN-boxed pointer literals: UNDEF/NULL/canonical-NaN sentinels are falsy;
    // all other NaN-boxed pointers (SSO strings, heap ptrs, etc.) are truthy.
    if (e[0] === 'f64.reinterpret_i64' && Array.isArray(e[1]) && e[1][0] === 'i64.const') {
      const bits = String(e[1][1])
      const FALSY = new Set([UNDEF_NAN, NULL_NAN, FALSE_NAN, nanPrefixHex(), '0x7FFA400000000000'])
      return typed(['i32.const', FALSY.has(bits) ? 0 : 1], 'i32')
    }
    // Fresh pointer constructors never produce nullish. Treat as always truthy.
    if (e[0] === 'call' && typeof e[1] === 'string' &&
        (e[1].startsWith('$__mkptr') || e[1] === '$__alloc' ||
         e[1] === '$__alloc_hdr' || e[1].startsWith('$__alloc_hdr_'))) {
      return typed(['i32.const', 1], 'i32')
    }
    // Pointer-typed local reads: value is never a plain number — truthy iff not nullish.
    // (local.get $x) where $x's valType is a non-STRING pointer kind.
    if (e[0] === 'local.get' && typeof e[1] === 'string') {
      const name = e[1][0] === '$' ? e[1].slice(1) : e[1]
      const vt = lookupValType(name)
      if (vt === VAL.ARRAY || vt === VAL.OBJECT || vt === VAL.SET || vt === VAL.MAP ||
          vt === VAL.CLOSURE || vt === VAL.TYPED || vt === VAL.BUFFER || vt === VAL.REGEX || vt === VAL.DATE) {
        return typed(['i32.eqz', isNullish(e)], 'i32')
      }
      // A plain NUMBER is truthy iff non-zero AND not NaN. `f64.eq x x` tests NaN by
      // VALUE (false for ANY NaN bits), so this is correct on every platform — unlike
      // __is_truthy, which bit-compares the canonical number-NaN and so mis-reads
      // x86's sign-set 0xFFF8.. NaN (from f64.div(0,0) / %) as a truthy box. (local.get
      // is pure → duplicated, not teed.) Bigint carriers are reinterpret/i64 shapes
      // and never reach here as VAL.NUMBER.
      if (vt === VAL.NUMBER) {
        const g = () => typed(['local.get', e[1]], 'f64')
        return typed(['i32.and', ['f64.ne', g(), ['f64.const', 0]], ['f64.eq', g(), g()]], 'i32')
      }
    }
    // Direct number-producing f64 expression (arithmetic, or the `%` / __rem helper):
    // same NaN-safe test, single-evaluated through a temp (the value may be a call).
    if (NUM_F64_TRUTHY_OPS.has(e[0]) || (e[0] === 'call' && e[1] === '$__rem')) return numericTruthy(e)
  }
  // Composite IR tagged by emit as a definite NUMBER. Use value-based NaN
  // truthiness; opaque f64 carriers (strings/objects/bigints/nullish/booleans)
  // remain on __is_truthy so NaN-boxed payloads stay truthy/falsy by tag.
  if (e.valKind === VAL.NUMBER) return numericTruthy(e)
  inc('__is_truthy')
  return typed(['call', '$__is_truthy', asI64(e)], 'i32')
}
export const toBoolFromEmitted = truthyIR

// === Value-type classification ===

// Shared peephole for the NaN-box sentinel checks. When the operand's bits are
// statically known — an unboxed pointer (never an atom → 0), a numeric `f64.const`
// (never an atom → 0), or a boxed `(f64.const nan:…)` / `(f64.reinterpret_i64
// (i64.const …))` literal — resolve `onBits(bitsHex)` / 0 at compile time; else
// hand the expr to `fallback` for the runtime test. One place owns the literal set.
const constI32 = (b) => typed(['i32.const', b ? 1 : 0], 'i32')
const matchF64Bits = (f64expr, onBits, fallback) => {
  if (f64expr.ptrKind != null) return constI32(0)
  if (Array.isArray(f64expr)) {
    if (f64expr[0] === 'f64.const') {
      const lit = String(f64expr[1])
      return lit.startsWith('nan:') ? onBits(lit.slice(4)) : constI32(0)
    }
    if (f64expr[0] === 'f64.reinterpret_i64' && Array.isArray(f64expr[1]) && f64expr[1][0] === 'i64.const')
      return onBits(String(f64expr[1][1]))
  }
  return fallback(f64expr)
}

export const isNullish = (f64expr) => matchF64Bits(f64expr,
  bits => constI32(bits === NULL_NAN || bits === UNDEF_NAN),
  (e) => {
    // (local.get $x): inline the test, reinterpreting twice (V8 CSEs it). Other
    // exprs call $__is_nullish — keeps binary size stable and evaluates once.
    if (Array.isArray(e) && e[0] === 'local.get') {
      const bits = ['i64.reinterpret_f64', e]
      return typed(['i32.or',
        ['i64.eq', bits, ['i64.const', NULL_NAN]],
        ['i64.eq', ['i64.reinterpret_f64', e], ['i64.const', UNDEF_NAN]]], 'i32')
    }
    inc('__is_nullish')
    return typed(['call', '$__is_nullish', ['i64.reinterpret_f64', e]], 'i32')
  })

/** Check if f64 expr is exactly `undefined` (UNDEF_NAN). Returns i32.
 *  Used by default-param semantics — only `undefined` (or missing arg) triggers
 *  the default; `null` should pass through. */
export const isUndef = (f64expr) => matchF64Bits(f64expr,
  bits => constI32(bits === UNDEF_NAN),
  (e) => typed(['i64.eq', ['i64.reinterpret_f64', e], ['i64.const', UNDEF_NAN]], 'i32'))

/** Check if f64 expr is exactly `null` (NULL_NAN). Returns i32.
 *  Strict `=== null` must match only null — not undefined (use isUndef for that). */
export const isNull = (f64expr) => matchF64Bits(f64expr,
  bits => constI32(bits === NULL_NAN),
  (e) => typed(['i64.eq', ['i64.reinterpret_f64', e], ['i64.const', NULL_NAN]], 'i32'))

/** Construct a real TypeError object and throw it through the ordinary
 *  `$__jz_err` channel. Kind-specific member-access/call nullish-
 *  receiver checks are the caller: a REAL schema-tagged Error object, not a
 *  bare numeric code, is what makes `catch (e) { e instanceof TypeError }`
 *  true in-wasm (the tag+schema arm of the Error model's truth table,
 *  .work/todo.md §deletion-sweep §4 — the numeric-code range arm is unsound
 *  and must not be reintroduced) and what lets interop.js's
 *  decodeThrown resolve an UNCAUGHT throw to a real host TypeError
 *  (errorSidClassOf) — no new decode machinery on either side, both paths
 *  are exactly what a user's own `new TypeError()` already exercises.
 *
 *  Builds the object INLINE — same shape as module/core.js's buildErrorObject
 *  (alloc_hdr + one store per ERR_SCHEMA_PROPS slot + mkPtrIR) — rather than
 *  calling `ctx.core.emit['TypeError']` through it: that path interns the
 *  class name via `emit(['str', 'TypeError'])`, which needs module/string.js
 *  loaded, same as this function now needs directly (below).
 *
 *  INVARIANT: `.name`/`.message` must both be set — a caught synthetic
 *  TypeError with either left `undefined` breaks `e.name === 'TypeError'`
 *  and breaks `String(e)` producing a real "TypeError: <msg>". `ctx.module.
 *  include('string')` (module/array.js's own established pattern for forcing
 *  a cross-module dependency from inside another module) makes
 *  `ctx.core.emit['str']` safe to call here even when this is the ONLY
 *  string-shaped thing the whole program does — a program that never reaches
 *  a nullish-receiver check still pays nothing (the include only fires when
 *  this function is actually called during emission).
 *  `kind` selects the message family per real JS's own split: a property/
 *  method READ on a nullish receiver ('read', the default — every call site
 *  but the callee-nullish one below) says "Cannot read properties of
 *  undefined"; calling a nullish value AS a function ('call') says "is not a
 *  function" — V8's own two-message split, minus the specific property/
 *  callee name (would need one distinct interned string per distinct name
 *  used anywhere in the program — real size cost for a message-text nicety,
 *  out of scope; the class + a non-empty, on-topic message is the contract).
 *  `instanceof` needs none of this: class identity lives in the schema id
 *  (aux bits), not in any slot value. */
export function throwTypeErrorIR(kind = 'read') {
  ctx.runtime.throws = true
  inc('__alloc_hdr')
  ctx.module.include('string')
  const sid = ctx.schema.errorSid('TypeError')
  const p = tempI32('nrerrp')
  const t = temp('nrerr')
  const nameIR = asF64(ctx.core.emit['str']('TypeError'))
  const msgIR = asF64(ctx.core.emit['str'](kind === 'call' ? 'is not a function' : 'Cannot read properties of undefined'))
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${p}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(2)]]],
    ctx.abi.object.ops.store(['local.get', `$${p}`], 0, msgIR),
    ctx.abi.object.ops.store(['local.get', `$${p}`], 1, nameIR),
    ['local.set', `$${t}`, mkPtrIR(PTR.OBJECT, sid, ['local.get', `$${p}`])],
    ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['local.get', `$${t}`]]],
    ['throw', '$__jz_err', ['local.get', `$${t}`]]], 'f64')
}

/** Mask that clears the boolean atom's truth bit, mapping TRUE_NAN→FALSE_NAN.
 *  `(bits & BOOL_ATOM_MASK) === FALSE_NAN` recognizes both in one i64.and+i64.eq.
 *  Built via i64Hex (32-bit-half formatting), NOT raw `.toString(16)` on the
 *  BigInt — this mask has bit 63 set, and under self-host BigInts are raw
 *  signed i64 bits (kind-erased), so `.toString(16)` on a bit-63-set value
 *  renders a signed "-…" fragment (the same nanPrefixMaskHex regression class
 *  i64Hex exists to avoid — see layout.js): the root cause of the
 *  in-kernel "Bad int 0x000000-100000001" watr parse failure when done wrong. */
const BOOL_ATOM_MASK = i64Hex(~(1n << BigInt(LAYOUT.AUX_SHIFT)))

/** Check if f64 expr is a boxed-boolean atom (TRUE_NAN or FALSE_NAN). Returns i32.
 *  Single-eval: masks the truth bit and compares to FALSE_NAN once. */
export const isBoolAtom = (f64expr) => matchF64Bits(f64expr,
  bits => constI32(bits === TRUE_NAN || bits === FALSE_NAN),
  (e) => typed(['i64.eq',
    ['i64.and', ['i64.reinterpret_f64', e], ['i64.const', BOOL_ATOM_MASK]],
    ['i64.const', FALSE_NAN]], 'i32'))

// === Array layout helpers — routed through the array carrier (abi/array.js) ===

/** Slot address: element `idx` off `baseLocal`. Constant idx folds the `*8`. */
export function slotAddr(baseLocal, idx) {
  return ctx.abi.array.ops.addr(['local.get', `$${baseLocal}`], idx)
}

/** Load f64 element from array data at ptr + i*8. ptr/i are local name strings. */
export function elemLoad(ptr, i) {
  return ctx.abi.array.ops.load(['local.get', `$${ptr}`], ['local.get', `$${i}`])
}

/** Store f64 val at array data ptr + i*8. ptr/i are local name strings. */
export function elemStore(ptr, i, val) {
  return ctx.abi.array.ops.store(['local.get', `$${ptr}`], ['local.get', `$${i}`], val)
}

/** Emit a loop iterating over array elements. Returns IR instruction list.
 *  bodyFn(ptr, len, i, item) should return an array of IR instructions.
 *  ARRAY-only — elemLoad assumes f64-stride data layout. After __ptr_offset
 *  resolves forwarding, len lives at ptr-8, so skip the second __len call
 *  (which would re-walk forwarding + dispatch on type).
 *
 *  Optional `lenLocal`: caller already has the array length in an i32 local
 *  (e.g. from sizing the output before the loop). Reuses it instead of
 *  re-loading from ptr-8.
 *  Optional `ptrLocal`: caller already has the resolved ARRAY data pointer in
 *  an i32 local. Reuses it instead of calling __ptr_offset again. */
export function arrayLoop(arrExpr, bodyFn, lenLocal, ptrLocal, reverse) {
  const arr = ptrLocal ? null : temp('aa'), ptr = ptrLocal ?? tempI32('ap'), i = tempI32('ai'), item = temp('av')
  const len = lenLocal ?? tempI32('al')
  const id = freshId(ctx)
  const setup = []
  if (!ptrLocal) {
    inc('__ptr_offset')
    setup.push(
      ['local.set', `$${arr}`, asF64(arrExpr)],
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${arr}`]]]],
    )
  }
  if (!lenLocal) setup.push(
    ['local.set', `$${len}`, ['i32.load', ['i32.sub', ['local.get', `$${ptr}`], ['i32.const', 8]]]])
  // Forward: i 0→len-1. Reverse (findLast*): i len-1→0, same elem indices.
  const start = reverse ? ['i32.sub', ['local.get', `$${len}`], ['i32.const', 1]] : ['i32.const', 0]
  const done = reverse ? ['i32.lt_s', ['local.get', `$${i}`], ['i32.const', 0]]
                       : ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]
  const step = ['i32.const', reverse ? -1 : 1]
  setup.push(
    ['local.set', `$${i}`, start],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, done],
      ['local.set', `$${item}`, elemLoad(ptr, i)],
      ...bodyFn(ptr, len, i, typed(['local.get', `$${item}`], 'f64')),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], step]],
      ['br', `$loop${id}`]]])
  return setup
}

/** Build a NaN-boxed pointer from a header allocation.
 *  type/aux/stride may be JS numbers; len/cap may be JS numbers or IR.
 *  Returns { local, init, ptr } where:
 *    local — i32 name pointing to data start (post-header)
 *    init  — IR statement that allocates and sets `local`
 *    ptr   — f64 IR expression: __mkptr(type, aux, local).
 *  Caller emits init, fills via local, then uses ptr (or local for further work). */
export function allocPtr({ type, aux = 0, len, cap, stride = 8, tag = 'ap' }) {
  // stride=8 (f64 slots — Array/HASH/OBJECT) hits the specialized __alloc_hdr which
  // hardcodes the multiply. Everything else (Set:16, Map probe:24, raw bytes:1) goes
  // through the generic __alloc_hdr_n(len, cap, stride).
  const local = tempI32(tag)
  const irOf = v => typeof v === 'number' ? ['i32.const', v] : v
  const args = [irOf(len), irOf(cap == null ? len : cap)]
  let helper
  if (stride === 8) helper = '__alloc_hdr'
  else { helper = '__alloc_hdr_n'; args.push(['i32.const', stride]) }
  inc(helper)
  const init = ['local.set', `$${local}`, ['call', '$' + helper, ...args]]
  const ptr = mkPtrIR(type, aux, ['local.get', `$${local}`])
  return { local, init, ptr }
}

// === Multi-value + control-flow reads ===

