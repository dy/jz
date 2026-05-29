/**
 * Shared runtime layout: heap, NaN-box carrier, pointer tags.
 *
 * Compiler-free — safe for `jz/interop` and tests without pulling the compiler.
 *
 * @module layout
 */

/** Bump-allocator cells in linear memory / globals. */
export const HEAP = { PTR_ADDR: 1020, START: 1024 }

/** NaN-box bit layout (i64 carrier). */
export const LAYOUT = {
  TAG_SHIFT: 47,
  TAG_MASK: 0xF,
  AUX_SHIFT: 32,
  AUX_MASK: 0x7FFF,
  OFFSET_MASK: 0xFFFFFFFF,
  NAN_PREFIX: 0x7FF8,
  NAN_PREFIX_BITS: 0x7FF8000000000000n,
  SSO_BIT: 0x4000,
  SLICE_BIT: 0x2000,
  SLICE_LEN_MASK: 0x1FFF,
}

/** 4-bit tagged-pointer type codes. */
export const PTR = {
  ATOM: 0,
  ARRAY: 1,
  BUFFER: 2,
  TYPED: 3,
  STRING: 4,
  OBJECT: 6,
  HASH: 7,
  SET: 8,
  MAP: 9,
  CLOSURE: 10,
  EXTERNAL: 11,
}

/** Reserved atom aux ids (PTR.ATOM). */
export const ATOM = { NULL: 1, UNDEF: 2, FALSE: 4, TRUE: 5 }

// =============================================================================
// PTR.TYPED element-type aux codec — which typed-array flavor lives in the aux
// field of a PTR.TYPED box. Pure (no compiler state) → lives with the NaN-box
// layout it encodes, shared by the compiler (type/analyze/narrow/infer) and the
// `module/typedarray` stdlib.
// =============================================================================

/** Base element-type codes for PTR.TYPED aux (0–7). BigInt ctors share 7 + TYPED_ELEM_BIGINT_FLAG. */
export const TYPED_ELEM_CODE = {
  Int8Array: 0, Uint8Array: 1, Int16Array: 2, Uint16Array: 3,
  Int32Array: 4, Uint32Array: 5, Float32Array: 6, Float64Array: 7,
  BigInt64Array: 7, BigUint64Array: 7,
}
export const TYPED_ELEM_VIEW_FLAG = 8
export const TYPED_ELEM_BIGINT_FLAG = 16

export const TYPED_ELEM_NAMES = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']

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

/** Host-side high u32 word for NaN-boxed f64 pointer encoding (interop). */
export const encodePtrHi = (type, aux) =>
  (0x7FF80000 | ((type & 0xF) << 15) | (aux & 0x7FFF)) >>> 0

export const decodePtrType = hi => (hi >>> 15) & 0xF
export const decodePtrAux = hi => hi & 0x7FFF

/** i64 NaN-prefix OR-mask for WAT `(i64.const …)` templates. */
export const nanPrefixHex = () =>
  '0x' + LAYOUT.NAN_PREFIX_BITS.toString(16).toUpperCase().padStart(16, '0')

/** Atom sentinel as i64 hex (compiler WAT templates). */
export const atomNanHex = atomId =>
  '0x' + (LAYOUT.NAN_PREFIX_BITS | (BigInt(atomId) << BigInt(LAYOUT.AUX_SHIFT))).toString(16).toUpperCase().padStart(16, '0')

/** Pre-shifted STRING SSO aux bit as i64 hex. */
export const ssoBitI64Hex = () =>
  '0x' + (BigInt(LAYOUT.SSO_BIT) << BigInt(LAYOUT.AUX_SHIFT)).toString(16).toUpperCase().padStart(16, '0')

/** Pre-shifted STRING slice/view aux bit as i64 hex. */
export const sliceBitI64Hex = () =>
  '0x' + (BigInt(LAYOUT.SLICE_BIT) << BigInt(LAYOUT.AUX_SHIFT)).toString(16).toUpperCase().padStart(16, '0')

/** Full i64 NaN-box hex for `(i64.const …)` — ptr type + aux, offset OR'd separately. */
export const ptrNanHex = (ptrType, aux = 0) =>
  '0x' + ptrBoxPrefixBigInt(ptrType, aux).toString(16).toUpperCase().padStart(16, '0')

/** Compile-time i64 prefix for mkPtrIR (before offset OR). */
export const ptrBoxPrefixBigInt = (ptrType, aux = 0) =>
  (0x7FF8n << 48n)
  | ((BigInt(ptrType) & 0xFn) << 47n)
  | ((BigInt(aux) & 0x7FFFn) << 32n)

/** Host-side atom sentinel high-u32 values (interop f64 decode). */
export const ATOM_HI = {
  [ATOM.NULL]: encodePtrHi(PTR.ATOM, ATOM.NULL),
  [ATOM.UNDEF]: encodePtrHi(PTR.ATOM, ATOM.UNDEF),
  [ATOM.FALSE]: encodePtrHi(PTR.ATOM, ATOM.FALSE),
  [ATOM.TRUE]: encodePtrHi(PTR.ATOM, ATOM.TRUE),
}

/** OOB / canonical quiet-NaN f64 literal for WAT and IR (`nan:0x7FF8…`). */
export const oobNanLiteral = () => `nan:${nanPrefixHex()}`
export const oobNanIR = () => ['f64.const', oobNanLiteral()]

/** Heap forwarding-pointer follow loop (WAT fragment).
 *  ARRAY/HASH/SET/MAP relocate on growth, leaving the old cell as a forwarding
 *  header: cap=-1 sentinel at off-4, relocated offset at off-8. This chases the
 *  chain to the live store. `off` is the i32 local (token incl. `$`) holding the
 *  current offset — mutated in place. `lowGuard` adds the `off < 8` bailout
 *  inside the loop; omit it when the caller already proved off≥8 before entry.
 *  Emits a `(block $done (loop $follow …))` — the host func must not reuse those
 *  labels. Single source for the 6 inline copies across core/array stdlib. */
export const followForwardingWat = (off = '$off', { lowGuard = true } = {}) =>
  `(block $done (loop $follow${lowGuard ? `
      (br_if $done (i32.lt_u (local.get ${off}) (i32.const 8)))` : ''}
      (br_if $done (i32.gt_u (local.get ${off}) (i32.shl (memory.size) (i32.const 16))))
      (br_if $done (i32.ne (i32.load (i32.sub (local.get ${off}) (i32.const 4))) (i32.const -1)))
      (local.set ${off} (i32.load (i32.sub (local.get ${off}) (i32.const 8))))
      (br $follow)))`
