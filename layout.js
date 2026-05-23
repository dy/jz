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
