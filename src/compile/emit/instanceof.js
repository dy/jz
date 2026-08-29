/**
 * The whole instanceof family: foldInstanceof, INSTANCEOF_TAG, emitTagInstanceof, typedCtorNameOf, emitTypedInstanceof, emitErrorInstanceof, emitInstanceof. Single consumer: comparisons.js's 'instanceof' property.
 *
 * @module compile/emit/instanceof
 */

import { ERR_CLASS_NAMES } from '../../../err-codes.js'
import {
  OBJECT_SCHEMA_HI_MASK, TYPED_ELEM_NAMES, TYPED_ELEM_VIEW_FLAG, encodeTypedElemAux, objectSchemaGuardHex,
} from '../../../layout.js'
import { PTR, ctx, inc } from '../../ctx.js'
import { asF64, emitNum, isPureIR, ptrTypeEq, temp, tempI32, typed } from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL, repOf } from '../../reps.js'
import { plannedTypedStorageInfo } from '../typed-storage-plan.js'
import { emit } from './dispatch.js'


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
  return plannedTypedStorageInfo(ctx, a)?.name ?? null
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

export function emitInstanceof(a, rhs) {
  if (rhs in INSTANCEOF_TAG) return emitTagInstanceof(a, rhs)
  if (TYPED_ELEM_NAMES.includes(rhs)) return emitTypedInstanceof(a, rhs)
  return emitErrorInstanceof(a, rhs)
}
