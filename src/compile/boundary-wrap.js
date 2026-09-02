import { ctx, inc } from '../ctx.js'
import { VAL } from '../reps.js'
import { typed, mkPtrIR, valKindToPtr, boolBoxIR } from '../ir.js'
import {
  representationHostBoxesParam, representationResultTagRequired, representationResultRawBigint,
} from './representation-plan.js'
import { isExported } from './func-exports.js'

/**
 * Boundary-wrap predicate: exports whose body-driven result OR any param narrowed
 * away from the JS-visible f64 ABI need a wrapper that re-/un-boxes at the JS↔WASM
 * edge so the inner func can keep its raw type while exports preserve Number /
 * pointer semantics for JS callers.
 *
 * Numeric param narrowing on exports IS enabled when all internal call sites pass
 * i32 — the wrapper does `i32.trunc_sat_f64_s` at the boundary (matches JS i32
 * coercion `n | 0` semantics for integer-shaped values; a JS caller passing a
 * fractional Number gets the same truncation it would get from `arr[n]`).
 */
export const isBoundaryWrapped = (func) => {
  if (!isExported(func) || func.raw) return false
  // Multi-value return: every lane is an f64 NaN-box carrier (the `return [a,b,…]` emit forces
  // asF64 per lane; result narrowing only touches single-result funcs), so any lane may hold a
  // box whose NaN payload JSC/V8 erases at the boundary — wrap to i64-carry every lane.
  if (func.sig.results.length !== 1) return true
  if (func.sig.results[0] !== 'f64' || func.sig.ptrKind != null) return true
  // Any result that isn't a proven plain number can be a NaN-box — a heap pointer,
  // a null/undef/bool atom, a bigint carrier, or a dynamic value — so it crosses as
  // i64 and JSC (Safari) can't canonicalize the payload away. A proven-number result
  // stays f64: free, and a number is never a NaN-box. `_resultNumeric` is set in
  // analyzeFuncForEmit (covers value-bound arrows narrowValResults skips).
  if (!func._resultNumeric) return true
  // Number result, but a param may still carry a box — a pointer-ABI param, or a
  // dynamic f64 param flagged `boundaryI64` during analyze — so wrap for i64 params.
  return func.sig.params.some(p => p.type !== 'f64' || p.ptrKind != null || p.boundaryI64)
}

/**
 * Phase: synthesize JS-boundary wrappers for narrowed exports.
 *
 * For each `isBoundaryWrapped(func)`, emit a sibling `$${name}$exp` that:
 *   - holds the (export "name") attribute (JS sees the wrapper)
 *   - takes i64 params always — JS-side carrier is BigInt that reinterprets to
 *     f64 NaN-box bits. i64 dodges V8's spec-permitted NaN canonicalization at
 *     the wasm↔JS boundary (see ToJSValue / ToWebAssemblyValue). Host wrap()
 *     in interop.js pairs by converting BigInt↔f64 via reinterpret bits.
 *   - converts each narrowed param at the call: f64 → i32 (truncate-sat) for
 *     numeric narrowed, f64 → i32-offset (`i32.wrap_i64 + i64.reinterpret_f64`)
 *     for pointer narrowed. The reinterpret happens once at param decode and
 *     once at result encode; numeric exports without narrowing skip wrapping
 *     entirely (no NaN-class values).
 *   - forwards args to the inner $${name}
 *   - reboxes the narrowed result and reinterprets to i64 for the boundary
 *
 * Param decode (i64 → f64): each param gets `f64.reinterpret_i64` before the
 * existing narrowing convert. f64 inner params just need the reinterpret.
 *
 * Result rebox cases (then reinterpret to i64 at the boundary):
 *   - sig.ptrKind != null  → mkPtrIR(ptrKind, ptrAux ?? 0, callIR)
 *   - sig.results[0] = i32 → f64.convert_i32_s(callIR), or `_u` when
 *                            sig.unsignedResult (preserves `(x >>> 0)` ∈ [0, 2³²))
 *   - sig.results[0] = f64 → callIR (some params narrowed but result stayed f64)
 */
export function synthesizeBoundaryWrappers() {
  const wrappers = []
  // Wrapper output order follows the frozen concrete function order.
  for (const func of ctx.plans.programIndex.concreteFunctionOrder()) {
    if (!isBoundaryWrapped(func)) continue
    const { name, sig } = func
    // i64 boundary carrier (Safari-safe). A genuine number is never a NaN-box, so it crosses
    // as plain f64 (zero cost). Everything that can be a NaN-box — heap pointer, null/undef/
    // bool atom, bigint carrier, or a dynamic value — crosses as i64: JSC (Safari) canonicalizes
    // f64 NaN payloads at the JS↔wasm boundary, erasing the box. The wasm signature is
    // self-describing; interop.js wrap() reinterprets BigInt↔f64 by bits, driven by the
    // `jz:i64exp` section emitted below. Non-JS hosts (WASI) read the same signature — i64 is
    // just int64 there, no BigInt.
    const resultPtr = sig.ptrKind != null
    // Plan-tagged UNION result (phase-c C2): valResult can settle VAL.BIGINT
    // for a result the plan carries as a tagged union (BigInt member BOXED,
    // number raw, pointers self-tagged) — the raw-bigint passthrough lane
    // would hand the host the union's BITS as one BigInt (a box pointer's
    // own bits for the boxed member). Route it to resultDynamic's generic
    // tag decode instead; interop's PTR.BIGINT arm derefs the box.
    const resultTaggedUnion = !resultPtr && representationResultTagRequired(ctx, func)
    const resultRawBigint = !resultPtr && !resultTaggedUnion && representationResultRawBigint(ctx, func)
    const resultBool = func.valResult === VAL.BOOL && !resultPtr
    const resultBigint = (func.valResult === VAL.BIGINT || resultRawBigint) && !resultPtr && !resultTaggedUnion
    // Dynamic f64 result: not pointer/bool/raw-bigint and not a proven number.
    // It may be a NaN box, so cross i64 and let interop's generic decoder own it.
    const resultDynamic = !resultPtr && !resultBool && !resultBigint &&
      sig.results[0] === 'f64' && !func._resultNumeric
    const resultI64 = resultPtr || resultBool || resultBigint || resultDynamic
    // jz:i64exp `r` marks results interop must reinterpret then `mem.read`.
    // A proven raw BigInt result is already the value, so it stays unmarked.
    const resultReinterpret = resultPtr || resultBool || resultDynamic
    // i64 carrier per param: pointer-ABI (offset) or a dynamic f64 param (boundaryI64).
    const paramIsI64 = (p) => !p.jsstring && (p.ptrKind != null || p.boundaryI64)
    // Inline `(export ...)` attribute only when the func decl carried the
    // inline-export keyword (`export function foo`). For re-exports
    // (`function foo; export { foo as bar }`) the `name` is the *internal*
    // symbol; sec.customs holds the JS-visible export pointing at this
    // wrapper. Emitting an inline attribute here under the internal name
    // would leak the symbol publicly and collide with the customs entry.
    const wrapNode = func.exported
      ? ['func', `$${name}$exp`, ['export', `"${name}"`]]
      : ['func', `$${name}$exp`]
    // jsstring params flow as externref end-to-end; boxed params ride i64; numbers f64.
    const i64Params = [], bigintBoxParams = []
    // Slots the wrapper normalizes to a typed array before boxing (`t`).
    let typedSlots = null
    sig.params.forEach((p, i) => {
      wrapNode.push(['param', `$${p.name}`, p.jsstring ? 'externref' : paramIsI64(p) ? 'i64' : 'f64'])
      if (paramIsI64(p)) i64Params.push(i)
      if (p.boundaryTyped) (typedSlots ??= {})[String(i)] = p.boundaryTyped
      if (representationHostBoxesParam(ctx, func, i)) {
        if (!paramIsI64(p)) throw new Error(`RepresentationPlan host-box param lacks i64 boundary: ${name}[${i}]`)
        bigintBoxParams.push(i)
      }
    })
    if (bigintBoxParams.length) inc('__alloc', '__mkptr')
    // Track externref param positions so interop.js can pass JS values raw (skipping
    // `mem.wrapVal`) at those slots — today only `jsstring` params; future externref carriers
    // wire here too. `extParams` is per-slot: false | { def: '...' } for a JS-side default.
    const extParams = sig.params.map(p => !p.jsstring ? false : p.jsstringDefault != null ? { def: p.jsstringDefault } : true)
    if (extParams.some(Boolean)) func._exportExtParams = extParams
    // Inner→wrapper argument list, shared by both single- and multi-value result shapes.
    const args = sig.params.map((p) => {
      const get = ['local.get', `$${p.name}`]
      if (p.jsstring) return get                              // externref flows through unchanged
      if (p.ptrKind != null) return ['i32.wrap_i64', get]     // ptr param: inner takes the i32 offset
      if (p.boundaryI64) return ['f64.reinterpret_i64', get]  // dynamic boxed param → f64 NaN-box carrier
      if (p.type === 'f64') return get
      return ['i32.trunc_sat_f64_s', get]                     // numeric narrowing f64 → i32
    })
    const callIR = ['call', `$${name}`, ...args]
    // Multi-value return: each lane is an f64 NaN-box carrier (every `return [a,b,…]` lane is
    // asF64; narrowing only touches single-result funcs). A boxed lane's NaN payload is erased
    // at the JS boundary, so cross EVERY lane as i64 — capture the inner call's N lanes into f64
    // locals (last result on top of the stack ⇒ pop in reverse) and re-push each reinterpreted.
    // interop reads the lane tuple via mem.read / decode (both map over an array result).
    if (sig.results.length > 1) {
      sig.results.forEach(() => wrapNode.push(['result', 'i64']))
      // Lane temporaries — guaranteed distinct from the wrapper's params (jz doesn't reserve
      // `__`, so a user param could be `__mlane0`): bump the prefix until no lane name collides.
      const pnames = new Set(sig.params.map((p) => p.name))
      let pfx = '__mlane'
      while (sig.results.some((_, i) => pnames.has(`${pfx}${i}`))) pfx = `_${pfx}`
      const lanes = sig.results.map((_, i) => `$${pfx}${i}`)
      lanes.forEach((n) => wrapNode.push(['local', n, 'f64']))
      const stmts = [callIR]
      for (let i = lanes.length - 1; i >= 0; i--) stmts.push(['local.set', lanes[i]])
      for (const n of lanes) stmts.push(['i64.reinterpret_f64', ['local.get', n]])
      wrapNode.push(...stmts)
      // `m` (lane count) marks a multi-value result so interop / the test adapter decode each
      // lane (vs `r`'s single reinterpret). Always recorded — even with no i64 params — so the
      // numeric-only `(a,b)=>[a+1,b+2]` tuple still gets its lanes turned back into numbers.
      func._exportI64 = { p: i64Params, m: sig.results.length, t: typedSlots }
      wrappers.push(wrapNode)
      continue
    }
    wrapNode.push(['result', resultI64 ? 'i64' : 'f64'])
    const toI64 = (n) => ['i64.reinterpret_f64', n]
    let body
    if (resultPtr) {
      const ptrType = valKindToPtr(sig.ptrKind)
      body = toI64(mkPtrIR(ptrType, sig.ptrAux ?? 0, callIR))
    } else if (resultBool) {
      // The i32 carrier is a clean 0/1 — truthyIR's identity path boxes it
      // straight into the TRUE_NAN/FALSE_NAN atom. The f64 carrier is NOT
      // provably raw: a BOOL-valued result may already be the atom box
      // (JSON.parse("false") returns FALSE_NAN — a bare f64.ne(v,0) reads any
      // atom as truthy). __is_truthy normalizes both representations; this is
      // the cold host boundary, the call costs nothing that matters.
      let carrier
      if (sig.results[0] === 'i32') carrier = typed(callIR, 'i32')
      else {
        inc('__is_truthy')
        carrier = typed(['call', '$__is_truthy', toI64(callIR)], 'i32')
      }
      body = toI64(boolBoxIR(carrier))
    } else if (resultBigint || resultDynamic) {
      // Proven raw BigInt and generic tagged results both cross losslessly as
      // i64. Only the latter sets `r`, so interop dereferences PTR.BIGINT boxes.
      body = toI64(callIR)
    } else if (sig.results[0] === 'i32') {
      body = [sig.unsignedResult ? 'f64.convert_i32_u' : 'f64.convert_i32_s', callIR]
    } else {
      body = callIR
    }
    wrapNode.push(body)
    // Record the i64 carrier map for interop.js (jz:i64exp). A pure-numeric
    // export records nothing.
    if (i64Params.length || resultReinterpret)
      func._exportI64 = { p: i64Params, r: resultReinterpret ? 1 : 0, t: typedSlots }
    wrappers.push(wrapNode)
  }
  return wrappers
}
