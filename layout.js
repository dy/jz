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

/** Tags whose heap block can relocate on growth (ARRAY/HASH/SET/MAP) — leaving a
 *  forwarding header that `__ptr_offset` must follow. `(1 << tag) & FORWARDING_MASK`
 *  tests membership in one shl+and, replacing a 4-way tag-equality OR. */
export const FORWARDING_MASK = (1 << PTR.ARRAY) | (1 << PTR.HASH) | (1 << PTR.SET) | (1 << PTR.MAP)

// BigInt views of the NaN-box fields — the carrier is 64-bit, JS bit-ops are 32-bit.
const TAG_SHIFT = BigInt(LAYOUT.TAG_SHIFT), TAG_MASK = BigInt(LAYOUT.TAG_MASK)
const AUX_SHIFT = BigInt(LAYOUT.AUX_SHIFT), AUX_MASK = BigInt(LAYOUT.AUX_MASK)
const OFFSET_MASK = BigInt(LAYOUT.OFFSET_MASK)

/** Format an i64 BigInt as a zero-padded `0x…` hex literal for WAT/IR templates. */
// Formatted via 32-bit halves with an explicit logical shift, NOT
// bits.toString(16): under self-host, BigInts are raw SIGNED i64 bits
// (kind-erased — see ir.js's SELF-HOST CONTRACT), so toString(16) of a
// bit-63-set value renders a signed "-8000…" fragment and the emitted
// `(i64.const 0x00-8000…)` kills the kernel's watr parse ("Bad int") — the
// nanPrefixMaskHex regression that silently broke every durable-log helper
// the kernel compiled. `>> 32n` sign-extends on raw bits; the & masks the
// extension off, so both host and kernel produce the same unsigned halves.
const _hx8 = (n) => n.toString(16).toUpperCase().padStart(8, '0')
export const i64Hex = bits => '0x' + _hx8(Number((bits >> 32n) & 0xFFFFFFFFn)) + _hx8(Number(bits & 0xFFFFFFFFn))

/** Pack (type, aux, offset) into the i64 NaN-box carrier — the single source of
 *  truth for pointer bit layout. Compiler IR (`packPtrBits`/`mkPtrIR`), the
 *  `$__mkptr` inline specializer, and the interop high-word encoder all derive
 *  from this. `offset` defaults to 0 to yield the box prefix (offset OR'd later). */
export const ptrBits = (type, aux = 0, offset = 0) =>
  LAYOUT.NAN_PREFIX_BITS
  | ((BigInt(type) & TAG_MASK) << TAG_SHIFT)
  | ((BigInt(aux) & AUX_MASK) << AUX_SHIFT)
  | (BigInt(offset >>> 0) & OFFSET_MASK)

// =============================================================================
// PTR.TYPED element-type aux codec — which typed-array flavor lives in the aux
// field of a PTR.TYPED box. Pure (no compiler state) → lives with the NaN-box
// layout it encodes, shared by the compiler (type/analyze/narrow/infer) and the
// `module/typedarray` stdlib.
// =============================================================================

/** Base element-type codes for PTR.TYPED aux (0–7). Flag-sharing kinds ride a
 *  base code (which fixes stride/shift) plus a discriminator bit: BigInt ctors
 *  share 7 + BIGINT_FLAG, Float16Array shares 3 (u16 storage) + F16_FLAG,
 *  Uint8ClampedArray shares 1 (u8 storage) + CLAMPED_FLAG. */
export const TYPED_ELEM_CODE = {
  Int8Array: 0, Uint8Array: 1, Int16Array: 2, Uint16Array: 3,
  Int32Array: 4, Uint32Array: 5, Float32Array: 6, Float64Array: 7,
  BigInt64Array: 7, BigUint64Array: 7,
  Float16Array: 3, Uint8ClampedArray: 1,
}
export const TYPED_ELEM_VIEW_FLAG = 8
export const TYPED_ELEM_BIGINT_FLAG = 16
export const TYPED_ELEM_F16_FLAG = 32
export const TYPED_ELEM_CLAMPED_FLAG = 64

export const TYPED_ELEM_NAMES = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']

/** Encode element-type name (+ optional view/bigint flags) to PTR.TYPED aux bits. */
export function encodeTypedElemAux(name, isView = false) {
  const et = TYPED_ELEM_CODE[name]
  if (et == null) return null
  return et | (isView ? TYPED_ELEM_VIEW_FLAG : 0) |
    (name === 'BigInt64Array' || name === 'BigUint64Array' ? TYPED_ELEM_BIGINT_FLAG : 0) |
    (name === 'Float16Array' ? TYPED_ELEM_F16_FLAG : 0) |
    (name === 'Uint8ClampedArray' ? TYPED_ELEM_CLAMPED_FLAG : 0)
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
  const name = (aux & TYPED_ELEM_F16_FLAG) !== 0 ? 'Float16Array'
    : (aux & TYPED_ELEM_CLAMPED_FLAG) !== 0 ? 'Uint8ClampedArray'
    : (aux & 16) !== 0 ? 'BigInt64Array' : TYPED_ELEM_NAMES[aux & 7]
  if (!name) return null
  return isView ? `new.${name}.view` : `new.${name}`
}

/** Host-side high u32 word for NaN-boxed f64 pointer encoding (interop) — the
 *  top 32 bits of `ptrBits(type, aux)` (offset lives in the low word). */
export const encodePtrHi = (type, aux) =>
  ((LAYOUT.NAN_PREFIX << 16) | ((type & LAYOUT.TAG_MASK) << (LAYOUT.TAG_SHIFT - 32)) | (aux & LAYOUT.AUX_MASK)) >>> 0

export const decodePtrType = hi => (hi >>> (LAYOUT.TAG_SHIFT - 32)) & LAYOUT.TAG_MASK
export const decodePtrAux = hi => hi & LAYOUT.AUX_MASK

/** i64 NaN-prefix OR-mask for WAT `(i64.const …)` templates. */
export const nanPrefixHex = () => i64Hex(LAYOUT.NAN_PREFIX_BITS)

/** AND-mask isolating the boxed-carrier prefix (sign + exponent + quiet bit):
 *  `(v & nanPrefixMask) == nanPrefix` ⇔ v is a NaN-boxed carrier (any tag/aux/
 *  payload). The mask is the prefix with the SIGN bit forced on — boxes are
 *  emitted sign-clear, so a set sign bit must fail the carrier test. */
export const nanPrefixMaskHex = () => i64Hex(LAYOUT.NAN_PREFIX_BITS | (1n << 63n))

/** Atom sentinel as i64 hex (compiler WAT templates). */
export const atomNanHex = atomId => i64Hex(LAYOUT.NAN_PREFIX_BITS | (BigInt(atomId) << AUX_SHIFT))

/** STRING aux bit 0 on a PLAIN-HEAP string (SSO and SLICE clear): this is a
 *  CANONICAL interned string — the static-pool copy (or an intern-table hit
 *  resolving to it). Two canonicals are bit-equal iff content-equal, so
 *  __str_eq answers unequal canonicals without touching bytes, and interned
 *  statics carry a cached FNV hash at offset-8 ([hash u32][len u32][bytes])
 *  that __str_hash loads instead of re-hashing. Inert elsewhere: slice-length
 *  bits are only read under SLICE_BIT, SSO length under SSO_BIT, and plain-
 *  heap consumers read the len header at -4 regardless of aux. */
export const STR_INTERN_BIT = 0x1

/** STRING aux bit 1 on a PLAIN-HEAP string (SSO and SLICE clear): the string was
 *  allocated with an [hash u32][len u32][bytes] header where the hash cell is a
 *  LAZY cache — seeded 0 (byte-FNV clamps to ≥2, so 0 is unambiguous "uncomputed"),
 *  filled by __str_hash on first hash. Sound because heap strings never relocate
 *  and die with their arena; the two in-place mutators (concat/append bump-extend
 *  of a heap-top accumulator) zero the cell when they change the bytes. Unlike
 *  STR_INTERN_BIT it carries NO canonicality claim — two hcache strings with equal
 *  content are ordinary bit-unequal pointers. Inert for slices (their aux[12:0]
 *  is a length, only read under SLICE_BIT) and every len/byte reader (-4 header
 *  unchanged). Producers opt in one by one; an unmarked string just re-hashes. */
export const STR_HCACHE_BIT = 0x2

/** Pre-shifted STRING SSO aux bit as i64 hex. */
export const ssoBitI64Hex = () => i64Hex(BigInt(LAYOUT.SSO_BIT) << AUX_SHIFT)

/** Pre-shifted STRING slice/view aux bit as i64 hex. */
export const sliceBitI64Hex = () => i64Hex(BigInt(LAYOUT.SLICE_BIT) << AUX_SHIFT)

/** Pre-shifted STRING hash-cache aux bit as i64 hex. */
export const hcacheBitI64Hex = () => i64Hex(BigInt(STR_HCACHE_BIT) << AUX_SHIFT)

/** Full i64 NaN-box hex for `(i64.const …)` — ptr type + aux, offset OR'd separately. */
export const ptrNanHex = (ptrType, aux = 0) => i64Hex(ptrBits(ptrType, aux))

/** Compile-time i64 prefix for mkPtrIR (before offset OR). */
export const ptrBoxPrefixBigInt = (ptrType, aux = 0) => ptrBits(ptrType, aux)

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

/** Heap forwarding-pointer follow (WAT fragment).
 *  ARRAY/HASH/SET/MAP relocate on growth, leaving the old cell as a forwarding
 *  header: cap=-1 sentinel at off-4, relocated offset at off-8. `off` is the
 *  i32 local (token incl. `$`) holding the current offset — mutated in place.
 *  `lowGuard` adds the `off < 8` bailout; omit it when the caller already
 *  proved off≥8.
 *
 *  Shape: a loop-free in-bounds + sentinel CHECK with a cold call into
 *  $__ptr_offset_fwd (the actual chase loop, module/core.js) only when the
 *  first hop is a real forward. Keeping every inline copy loop-free is what
 *  lets the engine inline the hot heap helpers (__ptr_offset, __len,
 *  __arr_idx_known, __typed_idx…) — a body containing a loop is excluded from
 *  V8's wasm inliner, and these helpers sit on ~25% of self-host compile time.
 *  Callers must list '__ptr_offset_fwd' in their deps()/wat() dependency set. */
// Upper bound is `off <= memory.size() * 65536` (total bytes currently backed) — read from
// $__heap_end64 (module/core.js, kept in sync by __memgrow on every grow), NOT recomputed
// as `i64.shl(i64.extend_i32_u(memory.size), 16)` inline: this check is on the hottest
// pointer-dereference path (~25% of self-host compile time, per the doc comment above), so
// a per-call recompute would cost 3 extra instructions at every inlined site instead of one
// global read. The i32 form `memory.size() << 16` (what a naive version — and $__heap_end
// itself — uses) overflows to exactly 0 at the wasm32 ceiling (memory.size()==65536 pages,
// i.e. the full 4 GiB: 65536*65536 == 2^32, unrepresentable in i32). Reading $__heap_end
// here instead of $__heap_end64 would make the bound "off <= 0", failing for every real off
// and silently disabling the forward-chase for the rest of execution: any pointer to an
// already-relocated ARRAY/SET/MAP/HASH stops following its forwarding header and reads the
// abandoned old block (cap=-1 sentinel misread as a real capacity) instead. That wraparound
// is benign for $__heap_end's own consumer (__alloc's fast-path check just slow-paths one
// extra time and __memgrow re-derives everything fresh in i64) but NOT here, where it gates
// whether forwarding runs at all — hence the separate i64 global instead of reusing $__heap_end.
export const followForwardingWat = (off = '$off', { lowGuard = true } = {}) =>
  `(if (i32.and
        ${lowGuard ? `(i32.ge_u (local.get ${off}) (i32.const 8))` : '(i32.const 1)'}
        (i64.le_u (i64.extend_i32_u (local.get ${off})) (global.get $__heap_end64)))
    (then (if (i32.eq (i32.load (i32.sub (local.get ${off}) (i32.const 4))) (i32.const -1))
      (then (local.set ${off} (call $__ptr_offset_fwd (local.get ${off})))))))`

/** The cold forwarding-chase loop behind followForwardingWat — the only body
 *  allowed to loop. Re-checks the sentinel each hop (first re-check is
 *  redundant with the caller's guard; the cold path doesn't care). */
export const ptrOffsetFwdWat = () =>
  `(func $__ptr_offset_fwd (param $off i32) (result i32)
    (block $done (loop $follow
      (br_if $done (i32.lt_u (local.get $off) (i32.const 8)))
      (br_if $done (i64.gt_u (i64.extend_i32_u (local.get $off)) (global.get $__heap_end64)))
      (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
      (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
      (br $follow)))
    (local.get $off))`
