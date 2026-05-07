/**
 * Core module — NaN-boxing, bump allocator, property dispatch.
 *
 * Foundation for all heap types. Every module depends on this.
 * NaN-boxing: see LAYOUT in src/ctx.js for the canonical bit layout.
 *
 * Auto-included by array/object/string modules.
 *
 * @module core
 */

import { typed, asF64, asI32, asI64, NULL_NAN, UNDEF_NAN, temp, usesDynProps, ptrOffsetIR, isNullish } from '../src/ir.js'
import { emit } from '../src/emit.js'
import { valTypeOf, lookupValType, VAL, T, repOf, updateRep, shapeOf } from '../src/analyze.js'
import { err, inc, PTR, LAYOUT } from '../src/ctx.js'
import { initSchema } from './schema.js'
import { strHashLiteral } from './collection.js'

// Pre-shifted NaN prefix as a full i64 mask, for `(i64.const ${NAN_BITS})` use.
const NAN_BITS = '0x' + LAYOUT.NAN_PREFIX_BITS.toString(16).toUpperCase().padStart(16, '0')

const PTR_BY_VAL = {
  [VAL.ARRAY]: PTR.ARRAY,
  [VAL.OBJECT]: PTR.OBJECT,
  [VAL.TYPED]: PTR.TYPED,
  [VAL.SET]: PTR.SET,
  [VAL.MAP]: PTR.MAP,
  [VAL.CLOSURE]: PTR.CLOSURE,
}

export default (ctx) => {
  Object.assign(ctx.core.stdlibDeps, {
    __eq: ['__str_eq', '__ptr_type'],
    __typeof: ['__ptr_type', '__is_nullish'],
    __len: ['__typed_shift'],
    __cap: ['__typed_shift', '__ptr_type', '__ptr_offset', '__ptr_aux'],
    __typed_data: ['__ptr_offset', '__ptr_aux'],
    __ptr_offset: [],
    __is_str_key: ['__ptr_type'],
    __str_len: ['__ptr_type', '__ptr_offset', '__ptr_aux'],
    __set_len: [],
    __length: ['__ptr_type', '__ptr_offset', '__str_len', '__len'],
    __typeof: ['__ptr_type', '__is_nullish'],
    __alloc_hdr: ['__alloc'],
  })

  ctx.core.stdlib['__is_nullish'] = `(func $__is_nullish (param $v i64) (result i32)
    (i32.or
      (i64.eq (local.get $v) (i64.const ${NULL_NAN}))
      (i64.eq (local.get $v) (i64.const ${UNDEF_NAN}))))`

  ctx.core.stdlib['__eq'] = `(func $__eq (param $a i64) (param $b i64) (result i32)
    (local $fa f64) (local $fb f64) (local $ta i32) (local $tb i32)
    ;; Fast path: bit equality covers identical pointers AND interned/SSO strings (same content
    ;; → same bits). Failing universal-NaN test catches NaN===NaN→false. Saves the NaN-check
    ;; pair (4 f64.eq) on the hottest case in watr (op === 'literal-string').
    (if (result i32) (i64.eq (local.get $a) (local.get $b))
      (then (i64.ne (local.get $a) (i64.const ${NAN_BITS})))
      (else
        ;; Bits differ. Numeric path covers -0/+0 and any normal numeric inequality.
        (local.set $fa (f64.reinterpret_i64 (local.get $a)))
        (local.set $fb (f64.reinterpret_i64 (local.get $b)))
        (if (result i32)
          (i32.and
            (f64.eq (local.get $fa) (local.get $fa))
            (f64.eq (local.get $fb) (local.get $fb)))
          (then (f64.eq (local.get $fa) (local.get $fb)))
          (else
            ;; At least one operand is a NaN-box. Both STRING (heap or SSO) → __str_eq
            ;; handles content compare and SSO fast-fail internally.
            (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $a) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
            (local.set $tb (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
            (if (result i32)
              (i32.and
                (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
                (i32.eq (local.get $tb) (i32.const ${PTR.STRING})))
              (then (call $__str_eq (local.get $a) (local.get $b)))
              (else (i32.const 0))))))))`

  ctx.core.stdlib['__is_null'] = `(func $__is_null (param $v i64) (result i32)
    (i64.eq (local.get $v) (i64.const ${NULL_NAN})))`

  // Truthy check: handles regular numbers AND NaN-boxed pointers
  // Falsy: 0, -0, NaN, null, undefined, "" (empty SSO)
  ctx.core.stdlib['__is_truthy'] = `(func $__is_truthy (param $v i64) (result i32)
    (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (result i32) (f64.eq (local.get $f) (local.get $f))
      (then (f64.ne (local.get $f) (f64.const 0)))
      (else
        (i32.and
          (i32.and
            (i64.ne (local.get $v) (i64.const ${NAN_BITS}))
            (i64.ne (local.get $v) (i64.const ${NULL_NAN})))
          (i32.and
            (i64.ne (local.get $v) (i64.const ${UNDEF_NAN}))
            (i64.ne (local.get $v) (i64.const 0x7FFA400000000000)))))))`

  ctx.core.stdlib['__is_str_key'] = `(func $__is_str_key (param $v i64) (result i32)
    (local $f f64)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (result i32) (f64.eq (local.get $f) (local.get $f))
      (then (i32.const 0))
      (else
        (i32.eq (call $__ptr_type (i64.reinterpret_f64 (local.get $f))) (i32.const ${PTR.STRING})))))`


  // Default dynamic-property helpers are harmless stubs. The collection module
  // overrides them with the real sidecar-property implementation.
  ctx.core.stdlib['__dyn_get'] = `(func $__dyn_get (param $obj i64) (param $key i64) (result i64)
    (i64.const ${UNDEF_NAN}))`
  ctx.core.stdlib['__dyn_get_or'] = `(func $__dyn_get_or (param $obj i64) (param $key i64) (param $fallback i64) (result i64)
    (local.get $fallback))`
  ctx.core.stdlib['__dyn_set'] = `(func $__dyn_set (param $obj i64) (param $key i64) (param $val i64) (result i64)
    (local.get $val))`
  ctx.core.stdlib['__dyn_move'] = `(func $__dyn_move (param $oldOff i32) (param $newOff i32))`

  // Memory section auto-enabled: compile.js checks ctx.module.modules.ptr

  // === NaN-boxing: encode/decode ===

  ctx.core.stdlib['__mkptr'] = `(func $__mkptr (param $type i32) (param $aux i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64 (i64.or
      (i64.const ${NAN_BITS})
      (i64.or
        (i64.shl (i64.and (i64.extend_i32_u (local.get $type)) (i64.const ${LAYOUT.TAG_MASK})) (i64.const ${LAYOUT.TAG_SHIFT}))
        (i64.or
          (i64.shl (i64.and (i64.extend_i32_u (local.get $aux)) (i64.const ${LAYOUT.AUX_MASK})) (i64.const ${LAYOUT.AUX_SHIFT}))
          (i64.and (i64.extend_i32_u (local.get $offset)) (i64.const ${LAYOUT.OFFSET_MASK})))))))`

  ctx.core.stdlib['__ptr_offset'] = `(func $__ptr_offset (param $ptr i64) (result i32)
    (local $bits i64) (local $off i32)
    (local.set $bits (local.get $ptr))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; Arrays can be reallocated during growth; follow forwarding pointer (cap=-1 sentinel).
    ;; Bounds are checked inside the loop so non-array ptrs skip them entirely, and well-formed
    ;; ARRAY ptrs without forwarding still pay only one bounds check before the cap load.
    (if (i32.eq
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
          (i32.const ${PTR.ARRAY}))
      (then
        (block $done
          (loop $follow
            (br_if $done (i32.lt_u (local.get $off) (i32.const 8)))
            (br_if $done (i32.gt_u (local.get $off) (i32.shl (memory.size) (i32.const 16))))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))))
    (local.get $off))`

  ctx.core.stdlib['__ptr_aux'] = `(func $__ptr_aux (param $ptr i64) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))`

  ctx.core.stdlib['__ptr_type'] = `(func $__ptr_type (param $ptr i64) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ptr) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))`

  // === Bump allocator ===

  // Heap-base watermark: gates header-backed propsPtr fast paths so static-data
  // OBJECT slots (offsets < heap base) don't misread arbitrary memory at off-16.
  // Updated by optimizeModule() when data segment exceeds 1024 bytes.
  ctx.scope.globals.set('__heap_start', '(global $__heap_start (mut i32) (i32.const 1024))')

  if (ctx.memory.shared) {
    // Shared memory: heap offset stored at memory[1020] (i32), just before heap start at 1024
    ctx.core.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32)
      (local.set $ptr (i32.load (i32.const 1020)))
      (i32.store (i32.const 1020) (i32.and (i32.add (i32.add (local.get $ptr) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
      (local.get $ptr))`
    ctx.core.stdlib['__clear'] = `(func $__clear
      (i32.store (i32.const 1020) (i32.const 1024)))`
  } else {
    // Own memory: heap offset in a global, auto-grow when needed
    ctx.scope.globals.set('__heap', '(global $__heap (mut i32) (i32.const 1024))')
    ctx.core.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32) (local $next i32)
      (local.set $ptr (global.get $__heap))
      ;; Align next allocation to 8 bytes
      (local.set $next (i32.and (i32.add (i32.add (local.get $ptr) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
      ;; Grow memory if needed (each page = 65536 bytes)
      (if (i32.gt_u (local.get $next) (i32.mul (memory.size) (i32.const 65536)))
        (then (if (i32.eq (memory.grow
          (i32.shr_u (i32.add (i32.sub (local.get $next) (i32.mul (memory.size) (i32.const 65536))) (i32.const 65535)) (i32.const 16)))
          (i32.const -1)) (then (unreachable)))))
      (global.set $__heap (local.get $next))
      (local.get $ptr))`
    ctx.core.stdlib['__clear'] = `(func $__clear
      (global.set $__heap (i32.const 1024)))`
  }

  // === Memory-based length/cap helpers (C-style headers) ===

  // Array/TypedArray/Buffer: [-8:len(i32)][-4:cap(i32)][data...]
  // For ARRAY/HASH/SET/MAP: len is element count.
  // For BUFFER: len is byte count. For owned TYPED: header stores byte count; len
  // is derived as byteLen >> log2(stride) so reinterpret views share their parent
  // BUFFER's header (zero-copy aliasing).
  // For TYPED subviews (aux bit 3 set): offset points to a 16-byte descriptor
  //   [0:byteLen(i32)][4:dataOff(i32)][8:parentOff(i32)][12:pad]
  // elemType = aux & 7, isView = aux & 8.
  ctx.core.stdlib['__typed_shift'] = `(func $__typed_shift (param $et i32) (result i32)
    (if (result i32) (i32.eq (local.get $et) (i32.const 7))
      (then (i32.const 3))
      (else (if (result i32) (i32.ge_u (local.get $et) (i32.const 4))
        (then (i32.const 2))
        (else (i32.shr_u (local.get $et) (i32.const 1)))))))`

  // Real data address for any TYPED ptr: owned → offset, view → [offset+4].
  ctx.core.stdlib['__typed_data'] = `(func $__typed_data (param $ptr i64) (result i32)
    (local $off i32)
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result i32) (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 8))
      (then (i32.load (i32.add (local.get $off) (i32.const 4))))
      (else (local.get $off))))`

  // Hot (~85M calls in watr self-host). Type/offset extraction inlined; forwarding
  // loop only entered for ARRAY. ARRAY fast path dominates (nodes?.length, out.length …).
  ctx.core.stdlib['__len'] = `(func $__len (param $ptr i64) (result i32)
    (local $bits i64) (local $t i32) (local $off i32) (local $aux i32)
    (local.set $bits (local.get $ptr))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; ARRAY fast path: follow forwarding inline, then load len at off-8.
    (if (result i32)
      (i32.and (i32.eq (local.get $t) (i32.const 1)) (i32.ge_u (local.get $off) (i32.const 8)))
      (then
        (block $done
          (loop $follow
            (br_if $done (i32.gt_u (local.get $off) (i32.shl (memory.size) (i32.const 16))))
            (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
            (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
            (br $follow)))
        (i32.load (i32.sub (local.get $off) (i32.const 8))))
      (else
        (if (result i32)
          (i32.and
            (i32.ge_u (local.get $off) (i32.const 8))
            (i32.or
              (i32.eq (local.get $t) (i32.const 3))
              (i32.or (i32.eq (local.get $t) (i32.const ${PTR.BUFFER}))
                (i32.or (i32.eq (local.get $t) (i32.const 7))
                  (i32.or (i32.eq (local.get $t) (i32.const 8)) (i32.eq (local.get $t) (i32.const 9)))))))
          (then
            (if (result i32) (i32.eq (local.get $t) (i32.const 3))
              (then
                (local.set $aux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK}))))
                (if (result i32) (i32.and (local.get $aux) (i32.const 8))
                  (then (i32.shr_u (i32.load (local.get $off))
                                   (call $__typed_shift (i32.and (local.get $aux) (i32.const 7)))))
                  (else (i32.shr_u (i32.load (i32.sub (local.get $off) (i32.const 8)))
                                   (call $__typed_shift (local.get $aux))))))
              (else (i32.load (i32.sub (local.get $off) (i32.const 8))))))
          (else (i32.const 0))))))`

  ctx.core.stdlib['__cap'] = `(func $__cap (param $ptr i64) (result i32)
    (local $t i32) (local $off i32) (local $aux i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result i32)
      (i32.and
        (i32.ge_u (local.get $off) (i32.const 4))
        (i32.or
          (i32.or
            (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 3)))
            (i32.eq (local.get $t) (i32.const ${PTR.BUFFER})))
          (i32.or (i32.eq (local.get $t) (i32.const 7))
            (i32.or (i32.eq (local.get $t) (i32.const 8)) (i32.eq (local.get $t) (i32.const 9))))))
      (then
        (if (result i32) (i32.eq (local.get $t) (i32.const 3))
          (then
            (local.set $aux (call $__ptr_aux (local.get $ptr)))
            (if (result i32) (i32.and (local.get $aux) (i32.const 8))
              ;; views are non-growable: cap = len (byteLen at [off])
              (then (i32.shr_u (i32.load (local.get $off))
                               (call $__typed_shift (i32.and (local.get $aux) (i32.const 7)))))
              (else (i32.shr_u (i32.load (i32.sub (local.get $off) (i32.const 4)))
                               (call $__typed_shift (local.get $aux))))))
          (else (i32.load (i32.sub (local.get $off) (i32.const 4))))))
      (else (i32.const 0))))`

  // String length (UTF-8 byte count). Heap: [-4:len(i32)][chars...]; SSO: aux & 7.
  ctx.core.stdlib['__str_len'] = `(func $__str_len (param $ptr i64) (result i32)
    (local $off i32) (local $aux i32)
    (if (i32.ne (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.STRING}))
      (then (return (i32.const 0))))
    (local.set $aux (call $__ptr_aux (local.get $ptr)))
    (if (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT}))
      (then (return (i32.and (local.get $aux) (i32.const 7)))))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result i32) (i32.ge_u (local.get $off) (i32.const 4))
      (then (i32.load (i32.sub (local.get $off) (i32.const 4))))
      (else (i32.const 0))))`

  // Set len in memory (for push/pop). Hot (~42M calls in watr self-host).
  // Type/offset extraction inlined; forwarding loop only entered for ARRAY.
  ctx.core.stdlib['__set_len'] = `(func $__set_len (param $ptr i64) (param $len i32)
    (local $bits i64) (local $t i32) (local $off i32)
    (local.set $bits (local.get $ptr))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const ${LAYOUT.OFFSET_MASK}))))
    ;; Only ARRAY (1), TYPED (3), HASH (7), SET (8), MAP (9) carry an 8-byte header.
    ;; Of those, only ARRAY can be forwarded — follow the chain inline.
    (if
      (i32.and
        (i32.ge_u (local.get $off) (i32.const 8))
        (i32.or
          (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 3)))
          (i32.or (i32.eq (local.get $t) (i32.const 7))
            (i32.or (i32.eq (local.get $t) (i32.const 8)) (i32.eq (local.get $t) (i32.const 9))))))
      (then
        (if (i32.eq (local.get $t) (i32.const 1))
          (then
            (block $done
              (loop $follow
                (br_if $done (i32.lt_u (local.get $off) (i32.const 8)))
                (br_if $done (i32.gt_u (local.get $off) (i32.shl (memory.size) (i32.const 16))))
                (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
                (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
                (br $follow)))))
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $len)))))`

  // Alloc header(16) + data(cap*stride). Layout: [propsPtr@-16(f64=0), len@-8, cap@-4],
  // data starts at returned offset. propsPtr at -16 holds a per-object dynamic-property hash
  // (NaN-boxed PTR.HASH) for ARRAY/HASH/MAP/SET; 0 means "no dyn props yet". This lets
  // __dyn_get_t / __dyn_set sidestep the global __dyn_props lookup on the hot path.
  // Read offsets relative to the returned data ptr stay unchanged (-8 len, -4 cap).
  ctx.core.stdlib['__alloc_hdr'] = `(func $__alloc_hdr (param $len i32) (param $cap i32) (param $stride i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.add (i32.const 16) (i32.mul (local.get $cap) (local.get $stride)))))
    (i64.store (local.get $ptr) (i64.const 0))
    (i32.store (i32.add (local.get $ptr) (i32.const 8)) (local.get $len))
    (i32.store (i32.add (local.get $ptr) (i32.const 12)) (local.get $cap))
    (i32.add (local.get $ptr) (i32.const 16)))`

  // Allocator + exports are deferred: only included when memory is actually needed.
  // Any module using allocPtr/inc('__alloc') pulls these in via ctx.core.stdlibDeps.
  // compile.js emits _alloc/_clear exports + memory section only when __alloc is in includes.
  ctx.core._allocRawFuncs = [
    '(func (export "_alloc") (param $bytes i32) (result i32) (call $__alloc (local.get $bytes)))',
    '(func (export "_clear") (call $__clear))',
  ]

  // Not-nullish check: f64 WAT node is neither NULL_NAN nor UNDEF_NAN.
  // Routes through isNullish() so peepholes (ptrKind, NaN-boxed literal, local.get inline)
  // apply — otherwise this would always emit a __is_nullish call even for provable cases.
  const notNullish = v => ['i32.eqz', isNullish(v)]

  // Optional-chain wrapper: eval guard, if non-nullish emit access, else NULL_NAN.
  const emitNullishGuarded = (guard, access) => typed(['if', ['result', 'f64'],
    notNullish(guard),
    ['then', access],
    ['else', ['f64.const', `nan:${NULL_NAN}`]]], 'f64')

  // === Shared dispatch helpers ===

  /** Emit .length access for a WASM f64 node. Monomorphize by vt, or runtime dispatch.
   *  ARRAY/SET/MAP share a single layout: length is i32 at offset-8. We inline that load
   *  directly instead of calling __len which re-dispatches on type. ptrOffsetIR handles
   *  ARRAY forwarding (non-ARRAY skips the forwarding loop). TYPED has a variable-width
   *  layout depending on the aux typed-element shift, so it still routes through __len. */
  function emitLengthAccess(va, vt) {
    if (vt === VAL.ARRAY || vt === VAL.SET || vt === VAL.MAP) {
      const off = ptrOffsetIR(va, vt)
      return typed(['f64.convert_i32_s', ['i32.load', ['i32.sub', off, ['i32.const', 8]]]], 'f64')
    }
    if (vt === VAL.TYPED)
      return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', va]]], 'f64')
    // Known string → byteLen (handles SSO + heap)
    if (vt === VAL.STRING) {
      inc('__str_byteLen')
      return typed(['f64.convert_i32_s', ['call', '$__str_byteLen', ['i64.reinterpret_f64', va]]], 'f64')
    }
    // Unknown → runtime dispatch via stdlib. Set/Map dispatch arms are pulled
    // only when user code actually constructs Set/Map (collection.js sets the
    // feature flags at the construction site); otherwise dispatch falls through
    // to ARRAY/STRING/TYPED. typedarray stays on because typed arrays are
    // commonly passed from JS via jz.memory.* without an in-program constructor.
    inc('__length')
    ctx.features.typedarray = true
    return typed(['call', '$__length', ['i64.reinterpret_f64', va]], 'f64')
  }

  // Known-schema fields live in the object payload. Dynamic sidecars are only
  // for ad-hoc props on pointer-backed values, so schema reads should bypass it.
  // Slot val-types reach the emit-time consumer via valTypeOf → ctx.schema.slotVT
  // (read on the AST `.prop` node), not via tagging this IR node.
  function emitSchemaSlotRead(baseExpr, idx) {
    const base = baseExpr?.type === 'f64' ? baseExpr : typed(baseExpr, 'f64')
    return typed(['f64.load', ['i32.add', ptrOffsetIR(base, VAL.OBJECT), ['i32.const', idx * 8]]], 'f64')
  }

  function emitHashGetLocalConst(base, key, prop) {
    inc('__hash_get_local_h')
    const receiver = asI64(base?.type ? base : typed(base, 'f64'))
    return typed(['f64.reinterpret_i64', ['call', '$__hash_get_local_h', receiver, key, ['i32.const', strHashLiteral(prop)]]], 'f64')
  }

  function emitTypeTag(receiver, vt) {
    const p = PTR_BY_VAL[vt]
    if (p != null) return ['i32.const', p]
    inc('__ptr_type')
    return ['call', '$__ptr_type', receiver]
  }

  function emitDynGetExprTyped(base, key, vt) {
    inc('__dyn_get_expr_t')
    const receiver = asI64(base?.type ? base : typed(base, 'f64'))
    return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_expr_t', receiver, key, emitTypeTag(receiver, vt)]], 'f64')
  }

  function emitDynGetAnyTyped(base, key, vt) {
    inc('__dyn_get_any_t')
    const receiver = asI64(base?.type ? base : typed(base, 'f64'))
    return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_any_t', receiver, key, emitTypeTag(receiver, vt)]], 'f64')
  }

  // Walk an AST expression that may resolve to an OBJECT literal at compile
  // time. Returns the literal `['{}', ...]` node, or null. Handles direct
  // literals and `.prop` chains over them. Spread props are unsupported —
  // they shift slot positions and would need their own resolution.
  function literalAst(obj) {
    if (Array.isArray(obj) && obj[0] === '{}') {
      // Bail on spreads — they change effective slot ordering.
      const props = obj.slice(1)
      const flat = props.length === 1 && Array.isArray(props[0]) && props[0][0] === ','
        ? props[0].slice(1) : props
      for (const p of flat) if (Array.isArray(p) && p[0] === '...') return null
      return obj
    }
    if (Array.isArray(obj) && obj[0] === '.' && typeof obj[2] === 'string') {
      const inner = literalAst(obj[1])
      if (!inner) return null
      const innerProps = inner.slice(1)
      const innerFlat = innerProps.length === 1 && Array.isArray(innerProps[0]) && innerProps[0][0] === ','
        ? innerProps[0].slice(1) : innerProps
      for (const p of innerFlat) {
        if (Array.isArray(p) && p[0] === ':' && p[1] === obj[2]) return literalAst(p[2])
      }
    }
    return null
  }

  // Slot index of `prop` within a literal-resolved expression, or -1.
  function literalSlot(obj, prop) {
    const lit = literalAst(obj)
    if (!lit) return -1
    const props = lit.slice(1)
    const flat = props.length === 1 && Array.isArray(props[0]) && props[0][0] === ','
      ? props[0].slice(1) : props
    for (let i = 0; i < flat.length; i++) {
      const p = flat[i]
      if (Array.isArray(p) && p[0] === ':' && p[1] === prop) return i
    }
    return -1
  }

  /** Emit .prop access for a WASM f64 node using schema or HASH fallback. */
  function emitPropAccess(va, obj, prop) {
    // Anonymous-literal fast path: when `obj` resolves at compile time to an
    // object literal `{...}` (either directly, or through a `.prop` chain
    // walked back to one), use the literal's slot index instead of falling
    // through to `__dyn_get_expr`. Fresh OBJECT literals carry no off-16
    // propsPtr so the dispatcher reads NULL_NAN. The varName-bound path
    // (`let o = {a:1}; o.a`) already works via `ctx.schema.idOf(varName)`;
    // this extends the same shape resolution to `({a:1}).a` and chains like
    // `({a:{b:1}}).a.b` where the receiver is anonymous. Spread sources
    // (`{...x}`) shift slot ordering and would need their own resolution.
    const slot = literalSlot(obj, prop)
    if (slot >= 0) return emitSchemaSlotRead(asF64(va), slot)
    let schemaIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : ctx.schema.find(null, prop)
    // Chain receiver (e.g. `o.meta.bias`): when the chain resolves to a known
    // OBJECT shape via JSON-shape propagation, the parent shape's `names`
    // gives the slot directly. Avoids the structural ambiguity of
    // ctx.schema.find(null, prop) when multiple registered schemas share a key.
    if (schemaIdx < 0 && typeof obj !== 'string') {
      const sh = shapeOf(obj)
      if ((sh?.vt === VAL.OBJECT || sh?.vt === VAL.HASH) && sh.names) {
        const i = sh.names.indexOf(prop)
        if (i >= 0) schemaIdx = i
      }
    }
    const key = asI64(emit(['str', prop]))
    if (schemaIdx >= 0) return emitSchemaSlotRead(asF64(va), schemaIdx)
    if (typeof obj === 'string') {
      const vt = lookupValType(obj)
      if (usesDynProps(vt)) {
        return emitDynGetExprTyped(va, key, vt)
      }
      if (vt === VAL.HASH) {
        return emitHashGetLocalConst(va, key, prop)
      }
      // OBJECT off-schema prop: __dyn_get_expr_t reads the per-OBJECT propsPtr
      // at off-16 (set by __dyn_set). __hash_get assumes HASH bucket layout
      // and would mis-read OBJECT memory.
      if (vt === VAL.OBJECT) {
        return emitDynGetExprTyped(va, key, vt)
      }
      if (vt == null) {
        ctx.features.external = true
        return emitDynGetAnyTyped(va, key, vt)
      }
      inc('__hash_get', '__str_hash', '__str_eq')
      return typed(['f64.reinterpret_i64', ['call', '$__hash_get', asI64(va), key]], 'f64')
    }
    // Non-string receiver: route through HASH fast path when valTypeOf can
    // resolve the chain to a known HASH (e.g. `o.meta.bias` where `o.meta` is
    // a HASH per the parsed JSON shape). Falls back to dynamic dispatch
    // otherwise.
    if (valTypeOf(obj) === VAL.HASH) {
      return emitHashGetLocalConst(va, key, prop)
    }
    inc('__dyn_get_expr')
    return typed(['f64.reinterpret_i64', ['call', '$__dyn_get_expr', asI64(va), key]], 'f64')
  }

  // Runtime .length dispatch — factory elides branches for types that can't exist in
  // this program (features.* + hash-stdlib presence). ARRAY is always live; STRING and
  // number are always dispatched. The __len disjunction collapses to whichever of
  // ARRAY/TYPED/HASH/SET/MAP are reachable. STRING covers both heap and SSO via __str_len.
  ctx.core.stdlib['__length'] = () => {
    const types = [PTR.ARRAY]
    if (ctx.features.typedarray) types.push(PTR.TYPED)
    if (ctx.core.includes.has('__hash_new') || ctx.core.includes.has('__dyn_set') || ctx.core.includes.has('__hash_set'))
      types.push(PTR.HASH)
    if (ctx.features.set) types.push(PTR.SET)
    if (ctx.features.map) types.push(PTR.MAP)
    const eqT = (n) => `(i32.eq (local.get $t) (i32.const ${n}))`
    let disj = eqT(types[0])
    for (let i = 1; i < types.length; i++) disj = `(i32.or ${disj} ${eqT(types[i])})`
    const lenArm = `(if (result f64) ${disj}
              (then
                (if (result f64) (i32.ge_u (local.get $off) (i32.const 8))
                  (then (f64.convert_i32_s (call $__len (local.get $v))))
                  (else (f64.const nan:${UNDEF_NAN}))))
              (else (f64.const nan:${UNDEF_NAN})))`
    const stringArm = `(if (result f64) (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
            (then (f64.convert_i32_s (call $__str_len (local.get $v))))
            (else ${lenArm}))`
    return `(func $__length (param $v i64) (result f64)
    (local $f f64) (local $t i32) (local $off i32)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (result f64) (f64.eq (local.get $f) (local.get $f))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (local.set $t (call $__ptr_type (local.get $v)))
        (local.set $off (call $__ptr_offset (local.get $v)))
        ${stringArm})))`
  }

  // === Property dispatch (.length, .prop) ===

  ctx.core.emit['.'] = (obj, prop) => {
    // Boxed object: delegate .length and .prop to inner value or schema
    if (typeof obj === 'string' && ctx.schema.isBoxed(obj)) {
      if (prop === 'length') {
        const inner = ctx.schema.emitInner(obj)
        return typed(['f64.convert_i32_s', ['call', '$__len', ['i64.reinterpret_f64', inner]]], 'f64')
      }
      const idx = ctx.schema.find(obj, prop)
      if (idx >= 0) return emitSchemaSlotRead(asF64(emit(obj)), idx)
    }

    if (prop === 'length') {
      // Fast path: typed-narrowed local (ptrKind=TYPED with known ptrAux) — bypass
      // the f64 NaN-rebox + __len ptr-type/aux re-extraction round-trip.
      // Owned typed (aux & 8 == 0): byteLen at off-8, shifted by element shift.
      // View typed (aux & 8): byteLen stored at off+0 (descriptor head), shifted.
      if (typeof obj === 'string') {
        const r = repOf(obj)
        if (r?.ptrKind === VAL.TYPED && r.ptrAux != null) {
          const aux = r.ptrAux, isView = (aux & 8) !== 0
          const et = aux & 7
          const shift = et === 7 ? 3 : et >= 4 ? 2 : et >> 1
          const off = ['local.get', `$${obj}`]
          const byteLen = isView
            ? ['i32.load', off]
            : ['i32.load', ['i32.sub', off, ['i32.const', 8]]]
          const lenI32 = shift === 0
            ? typed(byteLen, 'i32')
            : typed(['i32.shr_u', byteLen, ['i32.const', shift]], 'i32')
          return typed(['f64.convert_i32_s', lenI32], 'f64')
        }
      }
      // String literal: fold to its UTF-8 byte length. jz strings are stored as
      // UTF-8 and __str_byteLen returns byte count, so this matches the runtime
      // semantics. Skips the call + NaN-unbox round-trip entirely.
      if (Array.isArray(obj) && (obj[0] === 'str' || obj[0] == null) && typeof obj[1] === 'string') {
        return typed(['f64.const', Buffer.byteLength(obj[1], 'utf8')], 'f64')
      }
      const vt = typeof obj === 'string' ? repOf(obj)?.val : valTypeOf(obj)
      return emitLengthAccess(asF64(emit(obj)), vt)
    }

    // Module-registered property emitter (.size, etc.)
    const propKey = `.${prop}`
    if (ctx.core.emit[propKey]) return ctx.core.emit[propKey](obj)

    return emitPropAccess(emit(obj), obj, prop)
  }

  // Optional chaining: obj?.prop → null if obj is null, else obj.prop
  ctx.core.emit['?.'] = (obj, prop) => {
    const t = temp()
    const va = asF64(emit(obj))
    const vt = typeof obj === 'string' ? repOf(obj)?.val : valTypeOf(obj)
    let access
    if (prop === 'length') {
      access = emitLengthAccess(['local.get', `$${t}`], vt)
    } else {
      const propIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : -1
      if (propIdx >= 0) access = emitSchemaSlotRead(['local.get', `$${t}`], propIdx)
      else {
        if (typeof obj === 'string') {
          const objType = lookupValType(obj)
          if (usesDynProps(objType)) {
            access = emitDynGetExprTyped(['local.get', `$${t}`], asI64(emit(['str', prop])), objType)
          } else if (objType === VAL.HASH) {
            access = emitHashGetLocalConst(['local.get', `$${t}`], asI64(emit(['str', prop])), prop)
          } else if (objType == null) {
            ctx.features.external = true
            access = emitDynGetAnyTyped(['local.get', `$${t}`], asI64(emit(['str', prop])), objType)
          } else {
            inc('__hash_get', '__str_hash', '__str_eq')
            access = ['f64.reinterpret_i64', ['call', '$__hash_get', ['i64.reinterpret_f64', ['local.get', `$${t}`]], asI64(emit(['str', prop]))]]
          }
        } else {
          if (valTypeOf(obj) === VAL.HASH) {
            access = emitHashGetLocalConst(['local.get', `$${t}`], asI64(emit(['str', prop])), prop)
          } else {
            access = emitDynGetExprTyped(['local.get', `$${t}`], asI64(emit(['str', prop])), valTypeOf(obj))
          }
        }
      }
    }
    return emitNullishGuarded(['local.tee', `$${t}`, va], access)
  }

  // Optional index: arr?.[i] → null if arr is null, else arr[i]
  // Cache base in temp, propagate valType so []'s type dispatch works
  ctx.core.emit['?.[]'] = (arr, idx) => {
    const t = temp()
    const va = asF64(emit(arr))
    // Propagate source type to temp so [] dispatch (string, typed, etc.) works
    const srcType = typeof arr === 'string' ? repOf(arr)?.val : null
    if (srcType) updateRep(t, { val: srcType })
    if (typeof arr === 'string' && ctx.types.typedElem?.has(arr)) {
      if (!ctx.types.typedElem) ctx.types.typedElem = new Map()
      ctx.types.typedElem.set(t, ctx.types.typedElem.get(arr))
    }
    return emitNullishGuarded(['local.tee', `$${t}`, va], asF64(ctx.core.emit['[]'](t, idx)))
  }

  // Optional call: fn?.(...args) → null if fn is null, else call fn
  ctx.core.emit['?.()'] = (callee, ...args) => {
    const t = temp()
    const va = asF64(emit(callee))
    // If nullish → return NULL_NAN, else call via fn.call
    if (!ctx.closure.call) err('Optional call requires fn module')
    const callResult = ctx.closure.call(typed(['local.get', `$${t}`], 'f64'), args)
    return emitNullishGuarded(['local.tee', `$${t}`, va], asF64(callResult))
  }

  // typeof: returns JS-style string. Reachable results are number/undefined/string/function/symbol/object
  // (booleans are f64 and hit the number branch; no bigints). Strings are preallocated into globals and
  // initialized in __start (see compile.js). Comparison patterns (typeof x === 'string') are optimized
  // in prepare.js (resolveTypeof) and emitted as direct type checks via emitTypeofCmp, bypassing this path.
  ctx.core.emit['typeof'] = (a) => {
    if (!ctx.runtime.typeofStrs) {
      ctx.runtime.typeofStrs = ['number', 'undefined', 'string', 'function', 'symbol', 'object']
      for (const s of ctx.runtime.typeofStrs)
        ctx.scope.globals.set(`__tof_${s}`, `(global $__tof_${s} (mut f64) (f64.const 0))`)
    }
    inc('__typeof')
    // Receiver type unknown; enable branches that wouldn't otherwise be reachable.
    ctx.features.closure = true
    return typed(['call', '$__typeof', asI64(emit(a))], 'f64')
  }

  ctx.core.stdlib['__typeof'] = () => {
    const stringTest = `(i32.eq (local.get $t) (i32.const ${PTR.STRING}))`
    const closureArm = ctx.features.closure
      ? `(if (i32.eq (local.get $t) (i32.const ${PTR.CLOSURE}))
      (then (return (global.get $__tof_function))))`
      : ''
    return `(func $__typeof (param $v i64) (result f64)
    (local $f f64) (local $t i32)
    (local.set $f (f64.reinterpret_i64 (local.get $v)))
    (if (f64.eq (local.get $f) (local.get $f))
      (then (return (global.get $__tof_number))))
    (if (call $__is_nullish (local.get $v))
      (then (return (global.get $__tof_undefined))))
    (local.set $t (call $__ptr_type (local.get $v)))
    (if ${stringTest}
      (then (return (global.get $__tof_string))))
    ${closureArm}
    (if (i32.eqz (local.get $t))
      (then (return (global.get $__tof_symbol))))
    (global.get $__tof_object))`
  }

  // === Schema helpers (centralized in module/schema.js) ===
  initSchema(ctx)

  // Low-level pointer helpers callable from jz code
  ctx.core.emit['__mkptr'] = (t, a, o) => typed(['call', '$__mkptr', asI32(emit(t)), asI32(emit(a)), asI32(emit(o))], 'f64')
  ctx.core.emit['__ptr_type'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_type', asI64(emit(p))]], 'f64')
  ctx.core.emit['__ptr_aux'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_aux', asI64(emit(p))]], 'f64')
  ctx.core.emit['__ptr_offset'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_offset', asI64(emit(p))]], 'f64')

  // Error(msg) — passthrough (throw handles any value)
  ctx.core.emit['Error'] = (msg) => asF64(emit(msg))
}
