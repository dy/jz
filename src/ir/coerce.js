/**
 * ToNumber/ToString/ToPrimitive coercion: toNumF64/toStrI64 (the two big
 * dispatch chains), the OrdinaryToPrimitive method-fallback machinery
 * (objectToPrimitive/sidecarOverride), the nullish-sentinel
 * coercion pair (coerceNullishToNum/Str), the Error-schema toString special
 * case (coerceRest/errToStringIR/ssoStrI64), and cloneIR (the IR-aliasing-safe
 * duplication these all lean on).
 *
 * @module ir/coerce
 */

import { ctx, inc, PTR, LAYOUT, OPTF } from '../ctx.js'
import { ERR_CLASS_NAMES, ERR, errorCodeLiteral } from '../../err-codes.js'
import { ptrBits, i64Hex, OBJECT_SCHEMA_HI_MASK, objectSchemaGuardHex } from '../../layout.js'
import { VAL, repOf, numericStorage, mayBeUndefined } from '../reps.js'
import { valTypeOf, censusMaybeUndefined, censusMaybeUndefinedKind, numericDenied } from '../kind.js'
import { intExprRange } from '../static.js'
import { K, bitOf, hasTag, NULL_BITS, TAGS } from '../summary/kind.js'
import { typed } from './tag.js'
import { temp, tempI32, tempI64, block64 } from './locals.js'
import { ptrTypeEq } from './pointers.js'
import { asF64, asI64 } from './numeric.js'
import { isPlanTaggedBigint, isPlanRawBigint, materializeDeferredBigint, readI64 } from './bigint.js'
import { NULL_NAN, UNDEF_NAN, TRUE_NAN, FALSE_NAN, undefExpr, truthyIR } from './sentinels.js'
import { PURE_F64_OPS, isLit, isNumericIR } from './classify.js'

const TAG_MASK_HEX = i64Hex(BigInt(LAYOUT.TAG_MASK) << BigInt(LAYOUT.TAG_SHIFT))
const STRING_TAG_HEX = i64Hex(BigInt(PTR.STRING) << BigInt(LAYOUT.TAG_SHIFT))

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
          ['i64.and', ['i64.reinterpret_f64', ['local.get', `$${o}`]], ['i64.const', TAG_MASK_HEX]],
          ['i64.const', STRING_TAG_HEX]]],
      ['then', ['f64.reinterpret_i64',
        ['call', '$__dyn_get_expr', ['i64.reinterpret_f64', ['local.get', `$${o}`]], nameIR]]],
      ['else', undefExpr()]]],
    ['if', ['result', 'f64'],
      ptrTypeEq(['local.get', `$${p}`], PTR.CLOSURE),
      ['then', onOverride(p, o)],
      ['else', onFallback(o)]])
}

/** Object coercion uses the same prepared OrdinaryToPrimitive functions as
 * runtime kernels. A program without user methods needs only the inherited tag. */
const inheritedObjectTag = () => { ctx.module.include('string'); return asI64(ctx.core.emit['str']('[object Object]')) }
function inheritedObjectString(value) {
  return typed(['block', ['result', 'i64'], ['drop', asF64(value)], inheritedObjectTag()], 'i64')
}

/** The prepared OrdinaryToPrimitive functions (compile/emit/to-primitive.js), by hint:
 *  runtime roots only in a program that defines toString or valueOf. */
export const TO_PRIMITIVE = { string: '__jz_tp_str', number: '__jz_tp_num' }

function objectToPrimitive(v, hint) {
  const name = hint === 'string' ? TO_PRIMITIVE.string : TO_PRIMITIVE.number
  if (!ctx.funcs.runtimeRoots.has(name)) return inheritedObjectString(v)
  const recv = temp('tpr')
  return typed(['block', ['result', 'i64'], ['local.set', `$${recv}`, asF64(v)],
    asI64(ctx.bridge.emit(['()', name, recv]))], 'i64')
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

/** ToNumber for a runtime value that is a Number or an atom (a closure's
 *  result in a program without `__to_num`): true→1, false/null→0, any other
 *  NaN-box→NaN, a real number itself. `valIR` is duplicated (a local read). */
export const coerceAtomsToNum = (valIR) => {
  const bits = () => ['i64.reinterpret_f64', cloneIR(valIR)]
  return typed(['if', ['result', 'f64'],
    ['f64.eq', cloneIR(valIR), cloneIR(valIR)],
    ['then', cloneIR(valIR)],
    ['else', ['select',
      ['f64.const', 1],
      ['select', ['f64.const', 0], ['f64.const', 'nan'],
        ['i32.or', ['i64.eq', bits(), ['i64.const', FALSE_NAN]], ['i64.eq', bits(), ['i64.const', NULL_NAN]]]],
      ['i64.eq', bits(), ['i64.const', TRUE_NAN]]]]], 'f64')
}

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
const coerceNullishToStr = (valIR) => {
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
 *  (i32 node, compile-time literal, known VAL.NUMBER). BigInt is rejected.
 *  When the full
 *  string-parsing `__to_num` isn't loaded (no string module → no strings can
 *  exist) nullish *literals* still fold statically (null→+0, undefined→NaN);
 *  non-literal values pass through uncoerced — except bindings flagged
 *  maybeNullish, which get a runtime nullish coerce (null-flow correctness). */
export function toNumF64(node, v) {
  if (numericStorage(node)) return asF64(v)
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
  // A construct-then-fill array's element (`arrayHoles`): the NUMBER claim
  // covers every written slot; an unwritten one is a hole reading undefined,
  // whose sentinel would ride f64 arithmetic out as `undefined`. One compare
  // and select canonicalize it to NaN, no ToNumber call.
  if (Array.isArray(node) && node[0] === '[]' && typeof node[1] === 'string' && repOf(node[1])?.arrayHoles) {
    const t = temp('hole')
    return typed(['block', ['result', 'f64'], ['local.set', `$${t}`, asF64(v)],
      ['select', ['f64.const', 'nan'], ['local.get', `$${t}`],
        ['i64.eq', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', UNDEF_NAN]]]], 'f64')
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
      if (tail?.checkedNumRead)
        return typed([...v.slice(0, -1), toNumF64(node, tail)], 'f64')
      if (Array.isArray(tail) && tail[0] === 'select')
        return typed([...v.slice(0, -1), ['select', tail[1], foldArm(tail[2]), tail[3]]], 'f64')
    }
  }
  const vt = valTypeOf(node)
  if (vt === VAL.BIGINT || vt == null && isPlanRawBigint(node)) {
    if (!v.bigintRaw && (censusMaybeUndefined(node) || ctx.summary?.at(ctx.func.current)?.mayBeNullishExpr(node) === true)) {
      ctx.module.include('number')
      inc('__to_num')
      return typed(['call', '$__to_num', asI64(materializeDeferredBigint(v))], 'f64')
    }
    ctx.runtime.throws = true
    const code = errorCodeLiteral(ERR.BIGINT_TO_NUMBER)
    return typed(['block', ['result', 'f64'], ['drop', asF64(v)],
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', code]]],
      ['throw', '$__jz_err', ['f64.const', code]]], 'f64')
  }
  if (vt === VAL.BOOL) return typeof node === 'string' && ctx.func.maybeNullish?.has(node)
    ? coerceAtomsToNum(asF64(v)) : typed(['f64.convert_i32_s', truthyIR(v)], 'f64')
  // Slice 7 widening (.work/archive/todo.md §deletion-sweep §14/§15's own
  // honest-boundary gap): `vt` stays permanently null for a decl/param/capture-
  // hopped census-NUMBER claim (§14 point 3 — `val` never carries a census
  // claim, by construction) even though `presentVal` (Slice 6, kind.js
  // `censusMaybeUndefinedKind`) already proves the exact same "every value
  // ever WRITTEN was NUMBER" fact the branch below already trusts once
  // `valTypeOf` itself happens to prove it (currently only the param case,
  // where `val` IS `vt`'s own source — see that function's own doc comment).
  // Consult it directly instead of waiting on `vt`, strictly for NUMBER.
  const censusNum = vt == null && censusMaybeUndefinedKind(node) === VAL.NUMBER
  if (vt === VAL.NUMBER || censusNum) {
    // maybeUndefined join (.work/archive/todo.md §deletion-sweep §1a): a dict-census
    // NUMBER claim is a "every value ever WRITTEN" fact, not a "this key
    // exists" proof — an absent key reads real `undefined` at runtime. Gated
    // on VAL.NUMBER only. censusMaybeUndefined short-circuits on
    // node[0] before touching ctx.func.localReps, so every proven-NUMBER
    // site that isn't a dict-mode `[]`/`.` read (loop counters, schema slots,
    // the overwhelming hot-path case) pays zero new cost — same node object,
    // same asF64(v) call, no new branch taken.
    if ((vt === VAL.NUMBER || censusNum) &&
        (typeof node === 'string' && (ctx.func.maybeNullish?.has(node) || mayBeUndefined(node)) || censusMaybeUndefined(node))) {
      // A computed read can invoke a key's conversion hook; even a pure
      // Map/dictionary probe is costly to repeat. Evaluate every expression
      // once, then duplicate only its local read in the sentinel branches.
      if (typeof node !== 'string') {
        const t = temp('cnn')
        return typed(['block', ['result', 'f64'],
          ['local.set', `$${t}`, asF64(v)],
          coerceNullishToNum(typed(['local.get', `$${t}`], 'f64'))], 'f64')
      }
      const flow = ctx.func.localValTypesOverlay?.get(node)
      if (typeof flow === 'number' && !hasTag(flow, K.NULLISH))
        return typed(['select', ['f64.const', 'nan'], asF64(v),
          ['i64.eq', ['i64.reinterpret_f64', asF64(v)], ['i64.const', UNDEF_NAN]]], 'f64')
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
  if (vt === VAL.OBJECT) {
    const prim = objectToPrimitive(v, 'number')
    if (prim) {
      // A user conversion can return any primitive, including BigInt or an
      // undefined/boolean atom. Module presence is not a numeric proof.
      ctx.module.include('number')
      inc('__to_num')
      return typed(['call', '$__to_num', prim], 'f64')
    }
  }
  // Integer-valued definitions may include booleans. Identity-observed locals
  // retain their atoms and still need ToNumber at a numeric use.
  if (typeof node === 'string' && repOf(node)?.intCertain === true && !numericDenied(node)) return asF64(v)
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
    // The inline array-length arm over the ordinary helper (module/core.js
    // emitLengthAccess): the same arms over the numeric helper.
    if (typeof v.numericLength === 'function') {
      inc('__length')
      return v.numericLength()
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
  // A bare name the numeric demand pass denied a number (a read of it
  // neither converts nor is compatible) keeps JS semantics for every kind
  // the host may pass through an `any` parameter (a string, a boolean,
  // null): the summary's kind decides between the full ToNumber, the number
  // module included, and an inline fold of the nullish and boolean atoms.
  if (!ctx.core.stdlib['__to_num'] && ctx.summary && numericDenied(node)) {
    const k = ctx.summary.at(ctx.func.current).kindOfExpr(node)
    const nonNumeric = k & ~(bitOf(K.NUMBER) | bitOf(K.BOOL) | NULL_BITS) & TAGS
    if (nonNumeric !== 0) ctx.module.include('number')
    else if ((k & (bitOf(K.BOOL) | NULL_BITS)) !== 0) {
      const t = temp('atom')
      return typed(['block', ['result', 'f64'], ['local.set', `$${t}`, asF64(v)], coerceAtomsToNum(typed(['local.get', `$${t}`], 'f64'))], 'f64')
    }
  }
  if (!ctx.core.stdlib['__to_num']) {
    // No full ToNumber helper loaded — the program provably has no strings.
    // A nullish *literal* still coerces (null→+0, undefined→NaN) — fold it
    // statically so `Math.log10(null)` & friends are correct at zero cost.
    // Non-literal values fall through to `asF64`: an untyped runtime value
    // *could* be a nullish sentinel, but blanket per-use coercion taxes every
    // numeric kernel (fib, math loops) — nullable-param coercion belongs once
    // at the function boundary (null-flow inference), not at each use site.
    const f = asF64(v)
    if (typeof node === 'string' && ctx.func.maybeNullish?.has(node)) return coerceAtomsToNum(f)
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

/** Normalize a NUMBER|ABSENT value for a local whose reads all coerce it. */
export function numberStorageValue(v) {
  if (v.type === 'i32' || isNumericIR(v)) return asF64(v)
  const t = temp('num')
  return typed(['block', ['result', 'f64'], ['local.set', `$${t}`, asF64(v)],
    ['select', ['f64.const', 'nan'], ['local.get', `$${t}`],
      ['f64.ne', ['local.get', `$${t}`], ['local.get', `$${t}`]]]], 'f64')
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
  const summaryNullable = ctx.summary?.at(ctx.func.current)?.mayBeNullishExpr(node) === true
  // STRING-census widening (.work/archive/todo.md §deletion-sweep):
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
    // As above, key conversion and lookup run once before sentinel tests.
    if (typeof node !== 'string') {
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
  // maybeUndefined join (.work/archive/todo.md §deletion-sweep §1/Slice 5): a
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
  // A statically-proven BigInt may deliberately use the raw i64 carrier.
  // Generic __to_str cannot infer that carrier from its f64 interpretation
  // (7n looks like the finite subnormal 3.5e-323), so format the mathematical
  // payload directly. A nullable census stays on the dynamic path so its
  // undefined arm still renders "undefined".
  if (vt === VAL.BIGINT && !censusMaybeUndefined(node) && !summaryNullable) {
    inc('__radix_str')
    return typed(['i64.reinterpret_f64',
      ['call', '$__radix_str', readI64(node, v), ['i32.const', 10]]], 'i64')
  }
  // A mixed Number/BigInt value uses RepresentationPlan's tagged carrier:
  // keep the tag. $__to_str formats a box's payload (its BIGINT arm, module/
  // string.js) and keeps its normal semantics for every other tag and a raw
  // Number; a checked read's deferred box materializes here.
  if (isPlanTaggedBigint(node) || vt === VAL.BIGINT ||
      censusMaybeUndefinedKind(node) === VAL.BIGINT || typeof v?.bigintBox === 'function') {
    inc('__to_str')
    return typed(['call', '$__to_str', asI64(materializeDeferredBigint(v))], 'i64')
  }
  // Error-schema special case (.work/archive/todo.md §deletion-sweep §Consequence): `${e}`/
  // String(e) on a real Error object must format via spec's Error.prototype.toString
  // (name if message empty / message if name empty / name+': '+message otherwise /
  // 'Error' if both empty — ECMA-262 20.5.3.4), not the generic OBJECT
  // objectToPrimitive below (which knows nothing about Error, and Error exposes no
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
  // An empty closed object literal may use the dictionary carrier because it
  // has no schema slots, but its JS ToString is still the inherited ordinary-
  // object tag, never the dictionary's JSON-like debug rendering.
  if (Array.isArray(node) && node[0] === '{}' && node.length === 1)
    return inheritedObjectString(v)
  // A regex value is a compile-time id; its ToString is the literal's text.
  if (vt === VAL.REGEX) {
    const ast = Array.isArray(node) && node[0] === '//' ? node : typeof node === 'string' ? ctx.runtime.regex?.vars?.get(node) : null
    if (ast) { ctx.module.include('string'); return asI64(ctx.core.emit['str'](`/${ast[1] || '(?:)'}/${ast[2] || ''}`)) }
  }
  if (vt === VAL.OBJECT) {
    const prim = objectToPrimitive(v, 'string')
    if (prim) {
      inc('__to_str')
      return typed(['call', '$__to_str', prim], 'i64')
    }
  }
  // Provably-integer operand → render with the i32-only formatter, bypassing __to_str's
  // float machinery (__ftoa/__ftoa_shortest, ~2 KB). A raw i32 value (`n|0`, a bitwise
  // result, a loop counter) carries no NaN-box, so its ToString is just digits + sign.
  // ptrKind != null means it's an unboxed pointer (i32 offset), NOT a number — exclude.
  if (v.type === 'i32' && v.ptrKind == null) {
    const range = intExprRange(node)
    // A proven decimal digit uses the existing inline-string encoding and
    // needs neither a formatter nor an allocation. Evaluate the value once.
    if (range && range[0] >= 0 && range[1] <= 9)
      return typed(['i64.add', ssoStrI64('0'), ['i64.extend_i32_u', v]], 'i64')
    inc('__i32_to_str')
    return typed(['i64.reinterpret_f64', ['call', '$__i32_to_str', v]], 'i64')
  }
  ctx.module.include('string')
  inc('__to_str')
  // The carrier goes through as it is: $__to_str's own tag dispatch formats a
  // boxed BigInt's payload (a tagged local, an array element, a closure
  // result). Unboxing here would hand it the raw i64 as a subnormal Number.
  // A proven BigInt never reaches this point: toStrI64's own arms above
  // format it.
  return typed(['call', '$__to_str', asI64(v)], 'i64')
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
  inc('__str_length', '__str_concat_fresh')
  const tm = tempI64('emsg'), tn = tempI64('ename')
  const ml = tempI32('emlen'), nl = tempI32('enlen')
  return typed(['block', ['result', 'i64'],
    ['local.set', `$${tm}`, ctx.abi.object.ops.loadBits(cloneIR(off), 0)],
    ['local.set', `$${tn}`, ctx.abi.object.ops.loadBits(cloneIR(off), 1)],
    ['local.set', `$${ml}`, ['call', '$__str_length', ['local.get', `$${tm}`]]],
    ['local.set', `$${nl}`, ['call', '$__str_length', ['local.get', `$${tn}`]]],
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
