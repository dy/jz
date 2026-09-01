/**
 * The 12-strategy obj.method(args) dispatch chain: LEADING_STRATEGIES (context-free strategies 1-4) then TYPED_STRATEGIES (receiver-typed strategies 5-12), and emitMethodCall, the dispatcher itself.
 *
 * @module compile/emit/method-dispatch
 */

import { i64Hex, oobNanIR } from '../../../layout.js'
import { bodyOnlyCharCodeAtCalls } from '../../abi/string.js'
import { T, isLeaf, isReassigned } from '../../ast.js'
import { includeForRuntimeKeyIteration } from '../../autoload.js'
import { LAYOUT, PTR, ctx, emitArity, err, inc, setLinkDemand, warnDeopt } from '../../ctx.js'
import {
  BOXED_MUTATORS, applyBigintRepresentationAction, asF64, asI32, asI64, bigintEraseErr, bigintStrict, block64, boxBigInt, carrierF64, dispatchByPtrType, freshId, isGlobal, isNullish, ptrOffsetIR, ptrTypeEq, reconstructArgsWithSpreads, sidecarOverride, temp, tempI32, throwTypeErrorIR, typed, undefExpr, usesDynProps,
} from '../../ir.js'
import { censusMaybeUndefined, hasAmbiguousBoolMerge, valTypeOf } from '../../kind.js'
import { VAL, lookupValType, repOf } from '../../reps.js'
import { inBoundsCharCodeAt } from '../../type.js'
import { REP_EDGE_BOX, REP_EDGE_REJECT, representationResultTagRequired, representationStorageWriteAction } from '../representation-plan.js'
import { attachSigMeta, buildArrayWithSpreads, emitMethodCallSpread } from './call-args.js'
import { emit, emitCallArgs, emitIdentitySafe } from './dispatch.js'
import { stringOps } from './shared.js'


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
export const storedValue = (node) => {
  if (hasAmbiguousBoolMerge(node)) return emitIdentitySafe(node)
  const emitted = emit(node)
  if (valTypeOf(node) === VAL.BOOL) return carrierF64(node, emitted)
  const action = representationStorageWriteAction(ctx, node)
  if (bigintStrict() && action === REP_EDGE_BOX)
    bigintEraseErr('collection', typeof node === 'string' ? node : 'this expression')
  return action === REP_EDGE_REJECT
    ? carrierF64(node, emitted)
    : asF64(applyBigintRepresentationAction(emitted, node, action))
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

// Date discrimination for flat-key fallbacks. ToPrimitive, runtime-type and
// generic Date-only paths all need the same aux test when the static kind is
// unresolved: Date shares PTR.OBJECT's coarse tag with ordinary objects.
//
// emitNewDate's OWN `aux` field (module/date.js emitNewDate: `{type:
// PTR.OBJECT, aux: ctx.schema.dateSid, …}`) is always `ctx.schema.dateSid` —
// a schema registered under the property name `'\x00time'` (module/date.js
// init), a NUL-prefixed key no real object-literal source can ever spell —
// so it can never alias any other (content-addressed) schema id. Testing
// `ptrType===PTR.OBJECT && aux===dateSid` is therefore a SOUND, cheap
// runtime discriminator: aux lives in the NaN-box's own high bits
// (`$__ptr_aux`, the same accessor `emitTypedInstanceof` above uses for its
// own aux compare), no extra heap load.
//
// `recv` is the local holding the receiver's raw f64 bits. The helper is
// gated on a `.date:` handler, so unrelated methods return their fallback
// unchanged and pay no emitted check. `ptrTypeLocal` lets a caller that
// already computed `$__ptr_type` into a local (tryRuntimePtrTypeFork does,
// for its own STRING/TYPED cases) reuse it instead of a second call.
function dateAuxFallback(recv, method, callMethod, fallback, ptrTypeLocal) {
  const dateEmitter = ctx.core.emit[`.date:${method}`]
  if (!dateEmitter) return fallback
  const dateSid = ctx.schema.ensureDateSid?.()
  if (dateSid == null) err('internal: Date schema registration is unavailable')
  inc('__ptr_aux')
  const isObjectTag = ptrTypeLocal
    ? ['i32.eq', ['local.get', `$${ptrTypeLocal}`], ['i32.const', PTR.OBJECT]]
    : ptrTypeEq(['local.get', `$${recv}`], PTR.OBJECT)
  return typed(['if', ['result', 'f64'],
    ['i32.and', isObjectTag,
      ['i32.eq', ['call', '$__ptr_aux', ['i64.reinterpret_f64', ['local.get', `$${recv}`]]], ['i32.const', dateSid]]],
    ['then', callMethod(recv, dateEmitter)],
    ['else', fallback]], 'f64')
}

// Runtime discriminator for an unresolved/non-Date receiver of a Date-only
// flat emitter. Receiver and arguments evaluate once, in JS order. Argument
// temps let the Date emitter retain omitted-vs-explicit-undefined semantics;
// a host external receives the same values as an args array; other values
// throw after argument evaluation. Dynamic spreads are rejected because their
// runtime arity cannot preserve Date setters' optional-argument defaults.
function unresolvedDateMethod(obj, method, parsed) {
  const dateEmitter = ctx.core.emit[`.date:${method}`]
  if (!dateEmitter || method === 'valueOf') return null
  const noArgs = emitArity(dateEmitter) <= 1
  if (parsed.hasSpread && !noArgs)
    err(`Spread arguments on Date method .${method}() with a non-Date or unresolved receiver are unsupported — spread's runtime-determined argument count can't preserve .${method}()'s optional-argument defaults; call with explicit positional arguments, or narrow the receiver to a provably-Date value first`)
  const recv = temp('dateRecv'), argv = temp('dateArgs'), pt = tempI32('datePt')
  const argTemps = parsed.hasSpread ? [] : parsed.normal.map(() => temp('dateArg'))
  inc('__ptr_type')
  let nonDate = throwTypeErrorIR('call')
  if (ctx.transform.targetProfile.envImports) {
    includeForRuntimeKeyIteration()
    inc('__ext_call')
    setLinkDemand('external')
    nonDate = typed(['if', ['result', 'f64'],
      ['i32.eq', ['local.get', `$${pt}`], ['i32.const', PTR.EXTERNAL]],
      ['then', ['f64.reinterpret_i64', ['call', '$__ext_call',
        ['i64.reinterpret_f64', ['local.get', `$${recv}`]],
        ['i64.reinterpret_f64', asF64(emit(['str', method]))],
        ['i64.reinterpret_f64', ['local.get', `$${argv}`]]]]],
      ['else', nonDate]], 'f64')
  }
  const argNames = argTemps.map(name => name)
  const arrayArgs = parsed.hasSpread
    ? reconstructArgsWithSpreads(parsed.normal, parsed.spreads)
    : argNames
  const dispatch = block64(
    ...argTemps.map((name, i) => ['local.set', `$${name}`, asF64(storedValue(parsed.normal[i]))]),
    ['local.set', `$${argv}`, asF64(buildArrayWithSpreads(arrayArgs))],
    ['local.set', `$${pt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${recv}`]]]],
    dateAuxFallback(recv, method,
      (r, emitter) => emitArity(emitter) <= 1 ? emitter(r) : emitter(r, ...argNames), nonDate, pt))
  return block64(
    ['local.set', `$${recv}`, asF64(emit(obj))],
    ['if', ['result', 'f64'], isNullish(['local.get', `$${recv}`]),
      ['then', throwTypeErrorIR()],
      ['else', dispatch]])
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
      includeForRuntimeKeyIteration()
      // Date carve-out, unresolved receivers only (.work/archive/printer-trio.md
      // residual): a PROVEN vt reaching this arm is ARRAY/TYPED/OBJECT,
      // never DATE — strategy 7's tryStaticDispatch already owns any
      // proven-Date receiver before this fork ever runs — so dateAuxFallback
      // (see its own doc) only ever engages on the `!vt` arm, same carve-out
      // as tryRuntimePtrTypeFork below.
      const onFallback = (o) => asF64(vt ? callMethod(o, builtin) : dateAuxFallback(o, method, callMethod, callMethod(o, builtin)))
      return sidecarOverride(emit(obj), asI64(emit(['str', method])),
        (p) => ctx.closure.call(typed(['local.get', `$${p}`], 'f64'), []),  // CALL the override
        onFallback)                                                          // else the builtin method
    }
  }
}

// 7. Known type → static dispatch
function tryStaticDispatch({ obj, method, vt, callMethod }) {
  if (vt && ctx.core.emit[`.${vt}:${method}`]) {
    return callMethod(obj, ctx.core.emit[`.${vt}:${method}`])
  }
}

// 8. Unknown / guessed-array type, (string and/or typed) + generic exist → runtime
// dispatch by ptr type. analyze.js defaults untyped `.slice()` results to VAL.ARRAY,
// which is a guess, not a proof; runtime dispatch resolves whether the operand is
// actually a string, a typed array, or a plain array. Concretely-typed values whose
// kind IS proven (BUFFER, MAP, a proven STRING/TYPED/ARRAY, …) never reach here —
// `vt` is set and strategy 7 (tryStaticDispatch) already dispatched them statically.
//
// TYPED joined this fork (previously string-only): a typed array read through a
// fully-erased receiver — a dyn-prop field (`s.a = new Float64Array(4)` on an empty
// object, then `s.a.set(b)`), or any other path where the compiler never pins a
// ctor — used to reach ONLY the STRING-vs-generic choice below. `.set` has no
// `.string:` form, so it fell straight to the generic (Map.prototype.set) emitter,
// silently mistaking the source array for a Map key; `.forEach`/`.fill` on the same
// shape misfired too — the generic Array emitter reads a typed array's BYTE-length
// header as a raw element count. Adding the `.typed:${method}` case to the SAME
// dispatch (rather than a second, competing fork ahead of or behind this one) keeps
// the five method names TYPED shares with STRING (at/includes/indexOf/lastIndexOf/
// slice) resolving through one ordered decision, STRING still checked first — a
// separate fork would have to re-decide that priority itself and could invert it
// for some method, silently misrouting a real string through the typed/generic arm.
function tryRuntimePtrTypeFork({ obj, method, parsed, vt, callMethod }) {
  const strKey = `.string:${method}`, genKey = `.${method}`, typedKey = `.typed:${method}`
  // VAL.ARRAY is structurally incompatible with PTR.STRING — no fork needed.
  // Only fork when vt is truly unknown (!vt), not for proven types.
  const strEmitter = ctx.core.emit[strKey]
  const typedEmitter = ctx.core.emit[typedKey]
  const genEmitter = ctx.core.emit[genKey]
  if (!vt && (strEmitter || typedEmitter)) {
    const t = `${T}rt${freshId(ctx)}`, tt = `${T}rtt${freshId(ctx)}`
    ctx.func.locals.set(t, 'f64'); ctx.func.locals.set(tt, 'i32')
    // A string/typed/array method is only valid on a NaN-boxed pointer. `f64.eq(t,t)`
    // is true only for a non-NaN value, so guard the dispatch with it. A plain-number
    // receiver dispatches the `.number:` emitter when the method has one (`x.toString(16)`
    // on an untyped x — the kernel-L2 ratchet's data-segment corruption root: this used
    // to yield `undefined`, and `'\\' + undefined.padStart(2,'0')` collapsed every escaped
    // byte to \\00); methods numbers don't have keep yielding `undefined` (spec:
    // `(5).indexOf` is undefined) instead of feeding number bits to `__ptr_type` → OOB.
    // Every NaN-boxed receiver still reaches the ptr-type fork unchanged.
    const numEmitter = ctx.core.emit[`.number:${method}`]
    // Only a genuinely mayBeUndefined receiver pays for the
    // nullish-receiver guard below — `censusMaybeUndefined` (kind.js), the
    // SAME narrow, load-bearing predicate module/core.js's emitLengthAccess
    // uses (see its own comment for why "vt is unknown" alone is far too
    // broad — a real, measured SIZE-geomean regression across the size-
    // sweep corpus, caught before landing). A plain kind-unresolved-but-
    // never-null receiver takes the unchanged, unguarded generic arm.
    const mayBeUndef = censusMaybeUndefined(obj)
    // Not string (nor, now, typed) either: a real (non-nullish) pointer falls to the
    // generic (array-shaped) emitter, unchanged. A genuinely nullish receiver here
    // (e.g. `m.get('missing').slice()`, a STRING-census absent read — no proven vt,
    // so it reached this fork at all) used to feed the nullish sentinel's bit pattern
    // to the ARRAY-shaped emitter as if it were a real pointer — an OOB heap read
    // (`RuntimeError: memory access out of bounds`). Real JS throws TypeError for a
    // method call on null/undefined; the check is cheap and lands only on this
    // already-dynamic fork, and only when the receiver is provably mayBeUndefined.
    // Own-property shadow check (audit finding, agent/typed-decline-b): TYPED
    // joining this fork widened its firing condition from "strEmitter exists"
    // (5 method names: at/includes/indexOf/lastIndexOf/slice) to "strEmitter OR
    // typedEmitter exists" (~20 more — map/filter/fill/forEach/…), so a plain
    // OBJECT/ARRAY receiver with an OWN property of one of those names now
    // reaches this fork's generic arm too, where it used to skip straight to
    // strategy 10 (tryGenericEmitter)'s own shadow check. That check never ran
    // here (this fork calls genEmitter directly) — confirmed regressed test/
    // parser-bugs.js's "own prop shadows array builtin on unknown receiver
    // (d.map)": `d.map(1)` on a `{ map: fn }`-shaped unknown-vt receiver called
    // the Array builtin instead of `d`'s own `map`. Mirrors tryGenericEmitter's
    // own probe exactly (same preconditions, same sidecarOverride shape) — a
    // real (non-string, non-typed) receiver's own property still wins before
    // the builtin runs. Not needed for the STRING arm (sidecarOverride's own
    // doc: string property writes drop, so a string can never carry a shadowing
    // own prop) or the TYPED arm (a PROVEN-typed receiver never shadow-checks
    // either, via tryStaticDispatch above — same established rule this fork's
    // TYPED case should stay consistent with, not invent a new one for).
    // No generic (bare, non-kind-prefixed) emitter exists for this method —
    // true for any TYPED/STRING-exclusive method with no generic-Array analog
    // (e.g. `.subarray`: TypedArray-only by spec — kind-traits.js's own
    // methodValType comment notes "no plain-array analog"). Requiring
    // genEmitter used to gate this WHOLE runtime ptr-type fork off for such
    // methods, so a receiver with an unproven `vt` that TURNS OUT to be a
    // real typed/string value at runtime never reached `.typed:${method}` /
    // `.string:${method}` at all — it fell through every remaining strategy
    // to tryDynamicPropCall, which treats the method name as an arbitrary
    // DYNAMIC OWN-PROPERTY key. That's sound for a genuinely user-defined
    // closure property, but always wrong for a built-in prototype intrinsic
    // no runtime value ever stores as an own hash-keyed property (silently
    // yields `undefined` / an invalid call target instead of the real
    // result — see .work/archive/literal-method-typed-index-notes.md). Falling back
    // to the SAME dynamic-property-call / external-call strategies the chain
    // would try next — rather than requiring a generic emitter to exist —
    // keeps this fork's STRING/TYPED cases correct while the "genuinely
    // neither" case degrades exactly like it would have if this fork had
    // declined outright. Reuses `t` (already holds the once-evaluated
    // receiver) as the receiver for both, so a non-pure `obj` expression is
    // never re-evaluated.
    const canShadowProbe = genEmitter && ctx.closure.call && !parsed.hasSpread && ctx.core.emit.str
    const genericCall = genEmitter
      ? (canShadowProbe
          ? sidecarOverride(typed(['local.get', `$${t}`], 'f64'), asI64(emit(['str', method])),
              (p) => ctx.closure.call(typed(['local.get', `$${p}`], 'f64'), parsed.normal),
              () => asF64(callMethod(t, genEmitter)))
          : callMethod(t, genEmitter))
      : (tryDynamicPropCall({ obj: t, method, parsed, vt: null })
          ?? externalMethodFallback({ obj: t, method, parsed }))
    const generic = mayBeUndef ? typed(['if', ['result', 'f64'],
      isNullish(typed(['local.get', `$${t}`], 'f64')),
      ['then', throwTypeErrorIR()],
      ['else', genericCall]], 'f64') : genericCall
    const cases = []
    if (strEmitter) cases.push([PTR.STRING, callMethod(t, strEmitter)])
    if (typedEmitter) cases.push([PTR.TYPED, callMethod(t, typedEmitter)])
    // Date carve-out — see dateAuxFallback's doc for the discrimination
    // rationale (.work/archive/printer-trio.md residual). `tt` is already computed
    // below (the ptr-type local this fork uses for its own STRING/TYPED
    // dispatch), so pass it through instead of paying for a second
    // `$__ptr_type` call.
    const fallback = dateAuxFallback(t, method, callMethod, generic, tt)
    return block64(
      ['local.set', `$${t}`, asF64(emit(obj))],
      ['if', ['result', 'f64'],
        ['f64.eq', ['local.get', `$${t}`], ['local.get', `$${t}`]],
        ['then', numEmitter ? asF64(callMethod(t, numEmitter)) : undefExpr()],
        ['else', block64(
          ['local.set', `$${tt}`, ['call', '$__ptr_type', ['i64.reinterpret_f64', ['local.get', `$${t}`]]]],
          dispatchByPtrType(tt, cases, fallback))]])
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
  // this design (see tryRuntimePtrTypeFork's comment for the measured SIZE
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
      const prebuilt = parsed.hasSpread && !ctx.schema.isBoxed?.(obj)
      const callArgs = prebuilt
        ? [buildArrayWithSpreads(reconstructArgsWithSpreads(parsed.normal, parsed.spreads))]
        : parsed.normal
      // Same runtime-verified box-tag strategy 11 (tryDynamicPropCall) already
      // applies for its own dynamic dispatch: this property read is resolved
      // to a real closure/function value at COMPILE time (a known schema
      // slot), but WHICH function it holds is a runtime fact here — a proven
      // same-module BigInt-returning candidate (Shape #8, program-index.js;
      // still name-guess-only for the object-literal-method-shorthand shape
      // bigintMethodTargets already covered) means the raw i64 payload needs
      // boxing when the runtime dispatch actually lands on it. Unresolved
      // (targets.size === 0) is byte-identical to the pre-existing code path —
      // tagDynamicMethodResult's own total-passthrough contract.
      const targets = bigintMethodTargets(obj, method)
      if (!targets.size) return ctx.closure.call(propRead, callArgs, prebuilt)
      const propTmp = temp('schemaProp')
      const nativeCall = ctx.closure.call(typed(['local.get', `$${propTmp}`], 'f64'), callArgs, prebuilt)
      return block64(
        ['local.set', `$${propTmp}`, propRead],
        tagDynamicMethodResult(propTmp, nativeCall, targets))
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
    const dateEmitter = method !== 'valueOf' ? ctx.core.emit[`.date:${method}`] : null
    const callFlat = receiver => dateEmitter
      ? unresolvedDateMethod(receiver, method, parsed)
      : callMethod(receiver, ctx.core.emit[`.${method}`])
    // Statically-UNKNOWN receiver: an OWN property named like the builtin shadows it
    // (ES prototype semantics) — the runtime analogue of `objectShadow` above. Without
    // this fork, subscript's `d.map(a)` descriptor mapper (or any user method colliding
    // with Array.prototype names) is hijacked by the builtin and reads array layout off
    // an object. Probe the dyn-prop sidecar: own closure wins, else the builtin runs —
    // emitted ONCE (the builtin bodies are large inline emitters; a dual-arm emission
    // doubled closure-heavy golden sizes). __dyn_get_expr guards real-number receivers
    // itself, so no f===f pre-fork is needed. Gated on ctx.module.demanded (NOT
    // ctx.core.emit.str/.closure.call truthiness — those only prove the STRING/
    // FN modules are LOADED, which the region-arena/opts._eagerStdlib eager
    // preload makes true for every compile regardless of source content; a
    // string-and-closure-less program genuinely has no user string-keyed
    // closure props to shadow, and demanded is the one signal that still says
    // so under eager preload — see src/ctx.js's ctx.module.demanded doc):
    // a program that never demanded 'string' has no string literal to probe
    // with, and one that never demanded 'fn' has no closure value that could
    // ever occupy the shadowing property.
    //
    // Was additionally widened here (fix/param-mutation-propagation) to also
    // fire for `vt === VAL.ARRAY && ARRAY_INDUCERS.has(method)` on a bare
    // parameter — defense-in-depth against infer.js's methodEvidence source,
    // which back then still guessed VAL.ARRAY from `<param>.push(...)` usage
    // alone. fix/string-method-guess retired methodEvidence's positive
    // induce entirely (both the ARRAY half and the STRING half — see that
    // module's header): a parameter's `vt` can no longer reach a pointer
    // kind from body-usage syntax, only from real proof (paramReps' sound
    // cross-function call-site census, or a genuine local-construction
    // proof). With the guess itself gone, `vt == null` is once again the
    // COMPLETE unproven-receiver test — the widening had no other purpose
    // and cost a real, measured size/speed regression on proven-array
    // parameters reached only through a recursive or forwarding call chain
    // (every such site now re-triggered the probe on a receiver that was
    // actually soundly ARRAY). Removed; confirmed the makeByteBuf-idiom
    // repro (test/data.js) still passes on `vt == null` alone, same as the
    // STRING twin — nothing downstream can hand this branch a wrongly-proven
    // ARRAY/STRING `vt` anymore.
    if (vt == null && ctx.closure.call && !parsed.hasSpread && ctx.core.emit.str
      && ctx.module.demanded.has('string') && ctx.module.demanded.has('fn')) {
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
          ['else', asF64(callFlat(obj))]], 'f64')
      }
      // Fallback arm: a bare-name receiver re-references the ORIGINAL binding
      // (variable reads are pure) instead of the probe's spilled temp — so a
      // module-global string receiver reaches the ABI op as `global.get` and
      // the charCodeAt shape-1b entry decomposition can fire (the layered-
      // parser `cur.charCodeAt(idx)` hot shape; a local temp would hide it).
      return sidecarOverride(emit(obj), asI64(emit(['str', method])),
        (p) => ctx.closure.call(typed(['local.get', `$${p}`], 'f64'), parsed.normal),
        (o) => asF64(callFlat(typeof obj === 'string' ? obj : o)))
    }
    return callFlat(obj)
  }
}

const indexedMemberFunction = (receiver, method) => {
  const index = ctx.plans.programIndex
  const targetId = index?.resolveMemberId(receiver, method) ?? -1
  return index?.functionById(targetId) ?? null
}

function bigintMethodTargets(obj, method) {
  const out = new Set()
  const addRawTarget = func => {
    if (func?.valResult === VAL.BIGINT && !representationResultTagRequired(ctx, func, new WeakSet(), true))
      out.add(func.name)
  }
  const scan = expr => {
    if (Array.isArray(expr)) {
      const resolved = indexedMemberFunction(expr, method)
      if (resolved) { addRawTarget(resolved); return }
    }
    if (typeof expr === 'string') {
      for (const name of [`${expr}$${method}`, `${expr}${T}${method}`])
        addRawTarget(ctx.funcs.map.get(name))
      // Shape #8 (program-index.js): a same-module named function
      // reached through a schema property, proven by frozen ProgramIndex IDs
      // index rather than guessed from a naming convention — complements
      // the two name-guesses above rather than replacing them (they serve a
      // different, unrelated shape: an object-literal-method-shorthand
      // property, synthesized as a standalone function at those exact
      // names, never recorded as a write this index's own write-census
      // would see).
      const resolved = indexedMemberFunction(expr, method)
      addRawTarget(resolved)
      return
    }
    if (!Array.isArray(expr)) return
    for (let i = 1; i < expr.length; i++) scan(expr[i])
  }
  scan(obj)
  return out
}

function tagDynamicMethodResult(propLocal, result, targets) {
  if (!targets.size) return result
  const indices = []
  for (const name of targets) {
    // Mint the ordinary function-value trampoline now if the property-init
    // path has not reached it yet; the ignored IR has no runtime effect.
    const errorNode = ctx.error.node, errorLoc = ctx.error.loc
    emit(name)
    ctx.error.node = errorNode; ctx.error.loc = errorLoc
    const idx = ctx.closure.table.indexOf(`${T}tramp_${name}`)
    if (idx >= 0) indices.push(idx)
  }
  if (!indices.length) return result
  const r = temp('mresult')
  const aux = () => ['i32.wrap_i64', ['i64.and',
    ['i64.shr_u', ['i64.reinterpret_f64', ['local.get', `$${propLocal}`]], ['i64.const', LAYOUT.AUX_SHIFT]],
    ['i64.const', LAYOUT.AUX_MASK]]]
  let isBig = null
  for (const idx of indices) {
    const eq = ['i32.eq', aux(), ['i32.const', idx]]
    isBig = isBig ? ['i32.or', isBig, eq] : eq
  }
  return typed(['block', ['result', 'f64'],
    ['local.set', `$${r}`, asF64(result)],
    ['if', ['result', 'f64'], isBig,
      ['then', boxBigInt(['i64.reinterpret_f64', ['local.get', `$${r}`]])],
      ['else', ['local.get', `$${r}`]]]], 'f64')
}

// 11. Dynamic property function call on non-external values. Two emission shapes:
// (1) closure-only fork — receiver carries no PTR.EXTERNAL (sidecar-bearing static
//     types OR wasi target, where __ext_call doesn't exist); and (2) full fork
//     adding a PTR.EXTERNAL → __ext_call leg for opaque js receivers.
// Gated on ctx.module.demanded.has('fn'), not bare ctx.closure.call truthiness:
// the latter only proves the `fn` module is LOADED, which eager preload
// (region-arena / opts._eagerStdlib) makes true for every compile regardless
// of source content. A program that never demanded 'fn' cannot have created a
// closure value anywhere, so no receiver of unknown type could ever hold one
// as an own property — this whole dynamic-dispatch strategy is moot and MUST
// decline (falling through to strategy 12's externalMethodFallback, which is
// the actual reject for e.g. `[3,1,2].frobnicate()` — see src/ctx.js's
// ctx.module.demanded doc). `ctx.closure.call` itself stays the join's second
// half: eager preload means it's callable even when demanded is empty, so the
// IR-building code below is unaffected once this gate lets a real case through.
function tryDynamicPropCall({ obj, method, parsed, vt }) {
  if (ctx.closure.call && ctx.module.demanded.has('fn')) {
    includeForRuntimeKeyIteration()
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
    const nativeCall = ctx.closure.call(typed(['local.get', `$${propTmp}`], 'f64'), [arrayIR], true)
    const taggedCall = tagDynamicMethodResult(propTmp, nativeCall, bigintMethodTargets(obj, method))
    return block64(
      ['local.set', `$${objTmp}`, asF64(emit(obj))],
      ['local.set', `$${propTmp}`, propRead],
      ['if', ['result', 'f64'],
        ptrTypeEq(['local.get', `$${propTmp}`], PTR.CLOSURE),
        ['then', taggedCall],
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
  // gate every other site in this design uses (see tryRuntimePtrTypeFork's
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
    includeForRuntimeKeyIteration()
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
  tryBoxedDelegate, trySidecarToPrimitive, tryStaticDispatch, tryRuntimePtrTypeFork,
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
 *    8. Unknown / guessed-ARRAY runtime ptr-type fork over string/typed vs generic
 *    9. Schema property closure call
 *    10. Generic emitter (with collection/strIndex arity guards + object shadow)
 *    11. Dynamic property closure call (with PTR.EXTERNAL fallback if non-wasi)
 *    12. External method fallback via __ext_call (or undefined under wasi)
 */
export function emitMethodCall(callee, parsed, callArgs) {
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
