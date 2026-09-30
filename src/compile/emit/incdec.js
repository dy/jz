/**
 * WRAP_TRUNCATING_TYPED_CTORS/wrapTruncatingTypedElemName plus the ++/--/+1/-1 emitter properties. (wrapTruncatingTypedElemName sits textually beside the instanceof cluster in the original but is IncDec-private, per the dependency scan.)
 *
 * @module compile/emit/incdec
 */

import { ctx, err } from '../../ctx.js'
import {
  asF64, asI32, asI64, boxBigInt, deferBigintBox, fromI64, rawBigInt, isConst, maybeUnboxBigInt, readI64, readVar, temp, tempI32, toNumF64, typed, writeVar,
} from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { typedIdxProven } from '../../type.js'
import { REP_EDGE_BOX, REP_EDGE_REJECT, representationProgramHasBigint, representationUnaryUpdateAction } from '../representation-plan.js'
import { plannedTypedStorageInfo } from '../typed-storage-plan.js'
import { emit } from './dispatch.js'
import { numericStep, hasBigintDomain, bigintResult } from './bigint.js'
import { throughReference, putReference } from './assignment.js'
import { K, hasTag } from '../../summary/kind.js'
import { unbounded } from '../../summary/contract.js'


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
  const info = plannedTypedStorageInfo(ctx, name)
  return info != null && WRAP_TRUNCATING_TYPED_CTORS.has(info.name)
}
export const incdecOps = {
  // Preserve ToNumeric's old value before the store. Recovering it with an
  // inverse operation loses information when the new float rounds or wraps.
  postfix: (update, self) => {
    if (ctx.func._expect === 'void') return emit(update, 'void')
    if ((update[0] === '++' || update[0] === '--') && typeof update[1] === 'string' && valTypeOf(update[1]) === VAL.NUMBER) {
      const value = readVar(update[1])
      if (value.type === 'i32' && value.ptrKind == null) {
        const old = tempI32('post')
        const result = typed(['block', ['result', 'i32'], ['local.set', `$${old}`, value],
          emit(update, 'void'), ['local.get', `$${old}`]], 'i32')
        if (value.unsigned) result.unsigned = true
        return result
      }
    }
    const old = temp('post')
    const step = ref => {
      const value = [update[2][0], ref, old]
      ctx.plans.compoundOf.set(value, ref)
      return value
    }
    const next = update[0] === '='
      ? typeof update[1] === 'string'
        ? emit(['=', update[1], step(update[1])])
        : throughReference(update[1], update[2], ref => putReference(ref, step(ref)))
      : emit([update[0], update[1], old])
    const result = typed(['block', ['result', 'f64'], ['drop', asF64(next)], ['local.get', `$${old}`]], 'f64')
    if (valTypeOf(update) === VAL.BIGINT) return bigintResult(asI64(result), self)
    return representationProgramHasBigint(ctx) ? deferBigintBox(result, () => result) : result
  },
  // === Increment/Decrement ===
  // The optional old-value local belongs to the postfix wrapper above.

  ...Object.fromEntries([['++', 'add'], ['--', 'sub']].map(([op, fn]) => [op, (name, old) => {
    if (typeof name === 'string' && isConst(name)) err(`Assignment to const '${name}' — const bindings can't be reassigned after initialization; declare it with let instead`)
    const void_ = ctx.func._expect === 'void'
    const v = readVar(name)
    // BigInt local: readVar's carrier type is 'f64' (a bigint local's f64.reinterpret_i64
    // storage — see readVar), NOT i64, so the generic `${v.type}.${fn}` below would emit
    // f64.add/f64.sub on the raw i64 bit pattern — the same silent-rounding bug as
    // compoundAssign's f64 path (`n++` on a large-magnitude bigint was a no-op / garbage).
    // Same shape as the binary '+'/'-' BIGINT arm: asI64, i64.add/sub by the i64 constant
    // 1, fromI64. `name` is always a bare identifier here (prepare only routes '.'/'[]'
    // targets through '=' + '+'/'-', never through this table entry).
    // A covered reassigned param may have no local valType even though its
    // frozen RepresentationPlan proved every incoming value BigInt and
    // materialized the binding. The compound-action query is that proof; a
    // non-REJECT action puts ++/-- on the same i64 path as +=/>>= instead of
    // silently f64-adding the box pointer bits.
    const repAction = representationUnaryUpdateAction(ctx, name)
    if (valTypeOf(name) === VAL.BIGINT || repAction !== REP_EDGE_REJECT) {
      const current = repAction !== REP_EDGE_REJECT ? maybeUnboxBigInt(asF64(v)) : readI64(name, v)
      const rawBits = [`i64.${fn}`, saveBigint(current, old), ['i64.const', 1]]
      return writeVar(name, repAction === REP_EDGE_BOX ? boxBigInt(rawBits) : fromI64(rawBits), void_)
    }
    const k = ctx.summary?.at(ctx.func.current).kindOfExpr(name)
    if (hasBigintDomain(name) || k != null && hasTag(k, K.BIGINT) && !unbounded(k))
      return writeVar(name, numericStep(name, fn, old), void_)
    // The step takes the binding's number: one that may hold a missing value
    // steps from NaN, not from the payload of its undefined.
    if (old || v.type !== 'i32') return writeVar(name, typed([`f64.${fn}`, saveNumber(toNumF64(name, v), old), ['f64.const', 1]], 'f64'), void_)
    return writeVar(name, typed([`i32.${fn}`, v, ['i32.const', 1]], 'i32'), void_)
  }])),

  // A member update applies ToNumeric before stepping. Its primitive kind
  // may change (Boolean/String → Number), while BigInt stays exact.
  ...Object.fromEntries([['+1', 'add'], ['-1', 'sub']].map(([op, fn]) => [op, (n, old) => {
    if (valTypeOf(n) === VAL.BIGINT)
      return rawBigInt(fromI64([`i64.${fn}`, saveBigint(readI64(n, emit(n)), old), ['i64.const', 1]]))
    if (representationProgramHasBigint(ctx) && (valTypeOf(n) == null || valTypeOf(n) === VAL.OBJECT)) return numericStep(n, fn, old)
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
    if (!old && Array.isArray(n) && n[0] === '[]' && typeof n[1] === 'string' &&
        wrapTruncatingTypedElemName(n[1]) && typedIdxProven(n[1], n[2], n))
      return typed([`i32.${fn}`, asI32(emit(n)), ['i32.const', 1]], 'i32')
    return typed([`f64.${fn}`, saveNumber(toNumF64(n, emit(n)), old), ['f64.const', 1]], 'f64')
  }])),

}

const saveNumber = (value, old) => old ? ['local.tee', `$${old}`, asF64(value)] : value
const saveBigint = (value, old) => old ? ['i64.reinterpret_f64', saveNumber(fromI64(value), old)] : value
