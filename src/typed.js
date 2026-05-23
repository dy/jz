/**
 * Typed-array constructor encoding for PTR.TYPED aux bits.
 * @module typed
 */

/** Extract typed-array ctor name ('new.Float32Array', 'new.Int8Array.view', etc) from RHS,
 *  or null if RHS isn't a typed-array/ArrayBuffer/DataView constructor. */
export function typedElemCtor(rhs) {
  if (!Array.isArray(rhs) || rhs[0] !== '()' || typeof rhs[1] !== 'string' || !rhs[1].startsWith('new.')) return null
  const args = rhs[2]
  const isView = rhs[1].endsWith('Array') && rhs[1] !== 'new.ArrayBuffer'
    && Array.isArray(args) && args[0] === ',' && args.length >= 4
  return isView ? rhs[1] + '.view' : rhs[1]
}

/** Base element-type codes for PTR.TYPED aux (0–7). BigInt ctors share 7 + TYPED_ELEM_BIGINT_FLAG. */
export const TYPED_ELEM_CODE = {
  Int8Array: 0, Uint8Array: 1, Int16Array: 2, Uint16Array: 3,
  Int32Array: 4, Uint32Array: 5, Float32Array: 6, Float64Array: 7,
  BigInt64Array: 7, BigUint64Array: 7,
}
export const TYPED_ELEM_VIEW_FLAG = 8
export const TYPED_ELEM_BIGINT_FLAG = 16

/** Encode element-type name (+ optional view/bigint flags) to PTR.TYPED aux bits. */
export function encodeTypedElemAux(name, isView = false) {
  const et = TYPED_ELEM_CODE[name]
  if (et == null) return null
  return et | (isView ? TYPED_ELEM_VIEW_FLAG : 0) |
    (name === 'BigInt64Array' || name === 'BigUint64Array' ? TYPED_ELEM_BIGINT_FLAG : 0)
}

/** Encode a `typedElemCtor` string ('new.Int32Array' | 'new.Int32Array.view') to the 4-bit
 *  aux value used in PTR.TYPED NaN-boxing. Returns null for unknown ctors (ArrayBuffer/DataView). */
export function typedElemAux(ctor) {
  if (!ctor || !ctor.startsWith('new.')) return null
  const isView = ctor.endsWith('.view')
  const name = isView ? ctor.slice(4, -5) : ctor.slice(4)
  return encodeTypedElemAux(name, isView)
}
const TYPED_ELEM_NAMES = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']
export { TYPED_ELEM_NAMES }
/** Reverse of typedElemAux: pick a canonical ctor string for a 4-bit elem aux. Used
 *  to round-trip TYPED-narrowed call results through ctx.types.typedElem so the
 *  unboxed local's rep picks up the same aux. aux=7 is shared with BigInt typed
 *  arrays — Float64Array is canonical (read-side compares aux only). */
export function ctorFromElemAux(aux) {
  if (aux == null) return null
  const isView = (aux & 8) !== 0
  const name = (aux & 16) !== 0 ? 'BigInt64Array' : TYPED_ELEM_NAMES[aux & 7]
  if (!name) return null
  return isView ? `new.${name}.view` : `new.${name}`
}

/** Sentinel returned by `ternaryCtorOfRhs` when ternary branches resolve to
 *  different typed-array ctors — caller should drop any cached entry rather
 *  than leave a stale ctor (which would lock the wrong store width). */
export const MIXED_CTORS = Symbol('MIXED_CTORS')


/** A `?:`/`&&`/`||` expression — value depends on a condition, so its ctor
 *  must be derived by walking branches (handled by `ternaryCtorOfRhs`). */
export const isCondExpr = e => Array.isArray(e) && (e[0] === '?:' || e[0] === '&&' || e[0] === '||')

/** Walk a `?:`/`&&`/`||` expression and return:
 *  - a single ctor string when every branch resolves to the same ctor,
 *  - MIXED_CTORS when branches resolve to different ctors,
 *  - null when no branch resolves (caller's behavior unchanged). */
export function ternaryCtorOfRhs(rhs) {
  if (!Array.isArray(rhs)) return null
  const op = rhs[0]
  const lo = op === '?:' ? 2 : (op === '&&' || op === '||') ? 1 : 0
  if (!lo) return null
  const a = ternaryCtorOfRhs(rhs[lo]) ?? typedElemCtor(rhs[lo])
  const b = ternaryCtorOfRhs(rhs[lo + 1]) ?? typedElemCtor(rhs[lo + 1])
  return a && b ? (a === b ? a : MIXED_CTORS) : (a || b || null)
}
