/**
 * WRAP_TRUNCATING_TYPED_CTORS/wrapTruncatingTypedElemName plus the ++/--/+1/-1 emitter properties. (wrapTruncatingTypedElemName sits textually beside the instanceof cluster in the original but is IncDec-private, per the dependency scan.)
 *
 * @module compile/emit/incdec
 */

import { ctx, err } from '../../ctx.js'
import {
  asF64, asI32, boxBigInt, fromI64, isConst, maybeUnboxBigInt, readI64, readVar, typed, writeVar,
} from '../../ir.js'
import { valTypeOf } from '../../kind.js'
import { VAL } from '../../reps.js'
import { typedIdxProven } from '../../type.js'
import { REP_EDGE_BOX, REP_EDGE_REJECT, representationUnaryUpdateAction } from '../representation-plan.js'
import { plannedTypedStorageInfo } from '../typed-storage-plan.js'
import { emit } from './dispatch.js'


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
  // === Increment/Decrement ===
  // Postfix resolved in prepare: i++ → (++i) - 1

  ...Object.fromEntries([['++', 'add'], ['--', 'sub']].map(([op, fn]) => [op, name => {
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
      const rawBits = [`i64.${fn}`, current, ['i64.const', 1]]
      return writeVar(name, repAction === REP_EDGE_BOX ? boxBigInt(rawBits) : fromI64(rawBits), void_)
    }
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

}
