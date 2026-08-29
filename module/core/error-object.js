/**
 * Error object construction — the `new Error(msg)`/`Error(msg)` family (Error,
 * TypeError, RangeError, …): a real `PTR.OBJECT` with schema `['message','name']`
 * plus ES 20.5.1.1 message coercion (ToString with jz's provable-closed-world
 * exceptions for BOOL/closed-object-literal/open-object receivers).
 *
 * Pure move out of module/core.js (pipeline-minimality core split) — a fully
 * self-contained leaf: every private helper here has exactly one call site,
 * and every one of those call sites is inside this same file. Zero coupling to
 * any other closure-scoped helper in core.js.
 *
 * @module core/error-object
 */
import { typed, asF64, temp, tempI32, isUndef, truthyIR, toStrI64, mkPtrIR } from '../../src/ir.js'
import { emit } from '../../src/bridge.js'
import { valTypeOf } from '../../src/kind.js'
import { VAL } from '../../src/reps.js'
import { ctx, err, inc, PTR } from '../../src/ctx.js'
import { ERR, ERR_CLASS_NAMES } from '../../err-codes.js'

export const registerErrorClasses = () => {
  // Object-literal AST shape with NO 'toString'/'valueOf' key: a DEFINITIVE
  // (not merely unproven) empty OrdinaryToPrimitive method chain — a spread
  // makes the key set open (an unknown source might carry either at runtime),
  // so a spread-bearing literal is conservatively NOT closed.
  const isClosedObjLiteralNoStringMethod = (node) => {
    if (!Array.isArray(node) || node[0] !== '{}') return false
    const items = node.length === 2 && Array.isArray(node[1]) && node[1][0] === ','
      ? node[1].slice(1) : node.slice(1)
    for (const p of items) {
      if (Array.isArray(p) && p[0] === '...') return false
      const key = Array.isArray(p) && p[0] === ':' ? p[1] : (typeof p === 'string' ? p : null)
      if (key === 'toString' || key === 'valueOf') return false
    }
    return true
  }

  // Same "closed OrdinaryToPrimitive chain" fact as above, generalized from
  // "AST is literally a `{}` node" to "a bound name whose OWN declaration
  // schema is closed" (.work/todo.md §deletion-sweep finding-2: `let o = {}; new
  // Error(o).message` fell through the literal-only check to toStrI64's
  // generic OBJECT path, which — unlike the Error-schema arm right above it
  // — has no case for a plain user OBJECT and mis-renders it, a pre-existing,
  // documented, out-of-scope bug (§Consequence: `${anyDynamicObject}` → "").
  // Fixed the SAME way Finding 1 fixed Object.assign's target-provenance gap:
  // extend the literal-AST fact to the schema-BINDING fact a `let`/`const`
  // already carries, instead of touching the shared toStrI64 primitive.
  // Closed-world requires the schema to be the COMPLETE key set — a HASH-kind
  // binding, one with a computed write (`ctx.types.dynKeyVars`), or an
  // out-of-schema literal write (`ctx.types.literalWriteKeys`) could carry a
  // 'toString'/'valueOf' key the static schema doesn't list — those fall
  // through to the generic (still broken, still out-of-scope) toStrI64
  // OBJECT path unchanged.
  //
  // Gate on the SCHEMA ID directly (`ctx.schema.idOf`), not `valTypeOf(node)
  // === VAL.OBJECT` (audit-#11): the two are usually redundant, but a truly
  // EMPTY `let o = {}` is the one binding shape where they can come apart —
  // `ctx.schema.vars`/`idOf` (bound by prepare for a non-empty literal;
  // by src/compile/analyze.js's dict-aware decl scan for an empty `{}` —
  // see that file for why prepare itself can't safely bind that case) is a
  // durable, single-writer fact, while `.val` for this exact shape is ALSO
  // written by a second, independent, non-schema-aware body-fact pass
  // (compile/index.js's `bodyFacts.valTypes` loop) that can race/disagree and
  // poison-clear the field — observed live: `.val` read back `null` for a
  // provably-empty, provably-closed `o` despite the schema resolving fine.
  // `idOf` alone is exactly the fact this function needs (a real, closed,
  // non-Error prop list) and carries none of that fragility. Excluding an
  // Error-class sid is still required: `new Error(new TypeError('x')).message`
  // must NOT take this shortcut — that value needs Error.prototype.toString's
  // real "name: message" format (toStrI64's own Error-schema arm), not the
  // literal string '[object Object]'.
  const isClosedObjNoStringMethod = (node) => {
    if (isClosedObjLiteralNoStringMethod(node)) return true
    if (typeof node !== 'string') return false
    const sid = ctx.schema.idOf?.(node)
    if (sid == null || ctx.schema.isErrorSid?.(sid)) return false
    const schema = ctx.schema.list[sid]
    if (!schema || schema.includes('toString') || schema.includes('valueOf')) return false
    if (ctx.types.dynKeyVars?.has(node)) return false
    const w = ctx.types.literalWriteKeys?.get(node)
    if (w) for (const k of w) if (!schema.includes(k)) return false
    return true
  }

  const hasKnownObjPrimitiveHook = (node) => {
    if (Array.isArray(node) && node[0] === '{}') {
      const items = node.length === 2 && Array.isArray(node[1]) && node[1][0] === ','
        ? node[1].slice(1) : node.slice(1)
      return items.some(p => {
        const key = Array.isArray(p) && p[0] === ':' ? p[1] : (typeof p === 'string' ? p : null)
        return key === 'toString' || key === 'valueOf'
      })
    }
    if (typeof node !== 'string' || ctx.types.dynKeyVars?.has(node)) return false
    const sid = ctx.schema.idOf?.(node), schema = sid == null ? null : ctx.schema.list[sid]
    if (!schema || (!schema.includes('toString') && !schema.includes('valueOf'))) return false
    const writes = ctx.types.literalWriteKeys?.get(node)
    if (writes) for (const key of writes) if (!schema.includes(key)) return false
    return true
  }

  const unsupportedErrorMessage = () => {
    ctx.module.include('collection')
    ctx.runtime.throws = true
    return ['block',
      ['global.set', '$__jz_last_err_bits', ['i64.reinterpret_f64', ['f64.const', ERR.ERROR_MESSAGE_OBJECT]]],
      ['throw', '$__jz_err', ['f64.const', ERR.ERROR_MESSAGE_OBJECT]]]
  }

  // Error constructor message coercion — ES 20.5.1.1: argument absent OR its
  // VALUE is `undefined` → '' ; otherwise ToString(message). Routes through
  // toStrI64 (the same chokepoint String()/template literals use) for every
  // kind it already proves correctly (STRING identity, NUMBER, our own
  // Error-schema arm, the generic __to_str dispatch for atoms it special-
  // cases — NULL_NAN/UNDEF_NAN/TRUE_NAN/FALSE_NAN all format correctly
  // PROVIDED the operand reaches it already boxed). Three gaps toStrI64 does
  // NOT close by itself, all handled here at the call site — matching every
  // other direct toStrI64 caller's own established convention (module/
  // string.js's per-leaf template formatter, src/compile/emit.js's `+`-concat
  // strOperand at ~4796-4797), not a toStrI64-internal change:
  //   (1) BOOL: jz keeps a statically-proven boolean in the cheap unboxed 0/1
  //       carrier for arithmetic. Handing that raw i32 straight to toStrI64
  //       hits its i32-provable-NUMBER fast path and stringifies the CARRIER
  //       ("0"/"1"), not the boolean (audit-#9 P1: `new Error(false).message`
  //       read "0"). Box through the same true/false select every other BOOL-
  //       aware caller already uses instead.
  //   (2) A message that's PROVABLY a plain object literal with no toString/
  //       valueOf (e.g. `new Error({})`) has a closed, empty method chain —
  //       toStrI64's generic OBJECT arm can't make that closed-world claim
  //       for an arbitrary (possibly dynamic) receiver, so it falls through
  //       to __to_str's raw-pointer-bits fallback (.work/todo.md §deletion-sweep's
  //       "Consequence" section, a PRE-EXISTING gap for any dynamic object,
  //       left as-is). The literal shape alone is enough to prove it here.
  //   (3) A genuinely dynamic dict (VAL.HASH — JSON.parse or a computed-key
  //       object) has no closed schema, so the compiler cannot prove whether
  //       runtime `valueOf`/`toString` hooks exist. Treating them as absent
  //       silently returned "[object Object]" for an accepted object whose own
  //       hook returned something else. Until dynamic callable-property
  //       invocation is represented here, reject this unprovable conversion;
  //       correct-or-reject outranks a plausible default string.
  const errorMessageIR = (msg) => {
    if (msg == null) return asF64(emit(['str', '']))
    const vt = valTypeOf(msg)
    if (vt === VAL.BOOL)
      return typed(['select', asF64(emit(['str', 'true'])), asF64(emit(['str', 'false'])), truthyIR(emit(msg))], 'f64')
    if (vt === VAL.HASH)
      err('Error message conversion from a dynamic-key object is not supported because valueOf/toString hooks cannot be proven; convert the message explicitly with String(...) before constructing the Error')
    if (isClosedObjNoStringMethod(msg)) return asF64(emit(['str', '[object Object]']))
    if (vt === VAL.OBJECT) {
      if (!hasKnownObjPrimitiveHook(msg))
        err('Error message conversion from an open object is not supported because valueOf/toString hooks cannot be proven; convert the message explicitly with String(...) before constructing the Error')
    }
    if (vt === VAL.TYPED || vt === VAL.BUFFER || vt === VAL.SET || vt === VAL.MAP ||
        vt === VAL.CLOSURE || vt === VAL.DATE)
      err('Error message conversion from this object kind is not supported; convert the message explicitly with String(...) before constructing the Error')

    const boxed = asF64(emit(msg))
    const probe = isUndef(boxed)
    if (vt != null && Array.isArray(probe) && probe[0] === 'i32.const')
      return probe[1] ? asF64(emit(['str', ''])) : typed(['f64.reinterpret_i64', toStrI64(msg, boxed)], 'f64')

    const mt = temp('emsgv'), tt = tempI32('emsgt')
    const mtGet = () => typed(['local.get', `$${mt}`], 'f64')
    // A fully dynamic value may still be a primitive or ARRAY (all supported
    // by __to_str), but every other pointer family requires object
    // ToPrimitive hooks this runtime path cannot invoke. Reject those tags at
    // runtime rather than returning the decoded object/pointer as `.message`.
    const objectish = vt == null
      ? ['block', ['result', 'i32'],
          ['local.set', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', mtGet()]]],
          ['i32.and', ['f64.ne', mtGet(), mtGet()],
            ['i32.and', ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.ATOM]],
              ['i32.and', ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.ARRAY]],
                ['i32.and', ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.STRING]],
                  ['i32.ne', ['local.get', `$${tt}`], ['i32.const', PTR.BIGINT]]]]]]]
      : ['i32.const', 0]
    if (vt == null) inc('__ptr_type')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${mt}`, boxed],
      ['if', objectish, ['then', unsupportedErrorMessage()]],
      ['if', ['result', 'f64'], isUndef(mtGet()),
        ['then', asF64(emit(['str', '']))],
        ['else', ['f64.reinterpret_i64', toStrI64(msg, mtGet())]]]], 'f64')
  }

  // Error(msg)/new Error(msg) — a real PTR.OBJECT, schema ['message','name']
  // (audit-#9 P0-2 brand redesign, .work/todo.md §deletion-sweep §1). Class identity
  // lives in the SCHEMA ID (module/schema.js's ctx.schema.errorSid — one
  // DISTINCT id per class, minted with the class name as an internal dedupe
  // salt that never becomes a property), not in any slot: no hidden marker to
  // filter out of enumeration/dyn-dispatch/JSON, nothing to un-spell — the two
  // slots this object carries are the two ordinary, fully public properties a
  // real Error has. Construction reuses the exact runtime object-literal path
  // (module/object.js: $__alloc_hdr + one store per slot + mkPtrIR) — no new
  // allocation primitive, no new heap pointer tag. Reachability-gated like
  // every stdlib emitter: minting the schema and emitting this block only
  // happens when a program actually calls one of these 7 ctors, so an
  // Error-free module pays nothing.
  const buildErrorObject = (className, msg) => {
    inc('__alloc_hdr')
    const sid = ctx.schema.errorSid(className)
    const t = tempI32('errp')
    const nameIR = asF64(emit(['str', className]))
    const msgIR = errorMessageIR(msg)
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, ['call', '$__alloc_hdr', ['i32.const', 0], ['i32.const', ctx.abi.object.ops.allocSlots(2)]]],
      ctx.abi.object.ops.store(['local.get', `$${t}`], 0, msgIR),
      ctx.abi.object.ops.store(['local.get', `$${t}`], 1, nameIR),
      mkPtrIR(PTR.OBJECT, sid, ['local.get', `$${t}`])], 'f64')
  }
  // `new Error(x)`/`Error(x)` (with or without `new`) both route here: Error is
  // absent from includeForRuntimeCtor (src/autoload.js), so prepare's `new`
  // handler falls to the generic "unknown ctor → plain call" path — the same
  // ctx.core.emit['Error'] key a bare call resolves to. Correct per spec:
  // `Error(x)` without `new` also constructs a fresh Error.
  for (const cls of ERR_CLASS_NAMES) ctx.core.emit[cls] = (msg) => buildErrorObject(cls, msg)
}
