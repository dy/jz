/**
 * Core module — NaN-boxing, bump allocator, property dispatch.
 *
 * Foundation for all heap types. Every module depends on this.
 * NaN-boxing: quiet NaN (0x7FF8) + 51-bit payload [type:4][aux:15][offset:32]
 *
 * Auto-included by array/object/string modules.
 *
 * @module core
 */

import { emit, typed, asF64, asI32, valTypeOf, lookupValType, VAL, T, NULL_NAN, UNDEF_NAN, temp, usesDynProps, ptrOffsetIR, isNullish, repOf, updateRep } from '../src/compile.js'
import { err, inc, PTR } from '../src/ctx.js'
import { initSchema } from './schema.js'

const NAN_PREFIX = 0x7FF8

export default (ctx) => {
  Object.assign(ctx.core.stdlibDeps, {
    __eq: ['__str_eq', '__ptr_type'],
    __typeof: ['__ptr_type', '__is_nullish'],
    __len: ['__typed_shift'],
    __cap: ['__typed_shift', '__ptr_type', '__ptr_offset', '__ptr_aux'],
    __typed_data: ['__ptr_offset', '__ptr_aux'],
    __ptr_offset: [],
    __is_str_key: ['__ptr_type'],
    __str_len: ['__ptr_type', '__ptr_offset'],
    __set_len: [],
    __length: () => {
      const d = ['__ptr_type', '__ptr_offset', '__str_len', '__len']
      if (ctx.features.sso) d.push('__ptr_aux')
      return d
    },
    __typeof: ['__ptr_type', '__is_nullish'],
    __alloc_hdr: ['__alloc'],
  })

  ctx.core.stdlib['__is_nullish'] = `(func $__is_nullish (param $v f64) (result i32)
    (i32.or
      (i64.eq (i64.reinterpret_f64 (local.get $v)) (i64.const ${NULL_NAN}))
      (i64.eq (i64.reinterpret_f64 (local.get $v)) (i64.const ${UNDEF_NAN}))))`

  ctx.core.stdlib['__eq'] = `(func $__eq (param $a f64) (param $b f64) (result i32)
    (local $ra i64) (local $rb i64) (local $ta i32) (local $tb i32)
    ;; Fast path: bit equality covers identical pointers AND interned/SSO strings (same content
    ;; → same bits). Failing universal-NaN test catches NaN===NaN→false. Saves the NaN-check
    ;; pair (4 f64.eq) on the hottest case in watr (op === 'literal-string').
    (local.set $ra (i64.reinterpret_f64 (local.get $a)))
    (local.set $rb (i64.reinterpret_f64 (local.get $b)))
    (if (result i32) (i64.eq (local.get $ra) (local.get $rb))
      (then (i64.ne (local.get $ra) (i64.const 0x7FF8000000000000)))
      (else
        ;; Bits differ. Numeric path covers -0/+0 and any normal numeric inequality.
        (if (result i32)
          (i32.and
            (f64.eq (local.get $a) (local.get $a))
            (f64.eq (local.get $b) (local.get $b)))
          (then (f64.eq (local.get $a) (local.get $b)))
          (else
            ;; ≥1 is a NaN-box. Heap-allocated STRING with same content can have different
            ;; offsets — fall through to byte-wise __str_eq.
            (local.set $ta (i32.wrap_i64 (i64.and (i64.shr_u (local.get $ra) (i64.const 47)) (i64.const 0xF))))
            (local.set $tb (i32.wrap_i64 (i64.and (i64.shr_u (local.get $rb) (i64.const 47)) (i64.const 0xF))))
            (if (result i32)
              (i32.and
                (i32.or
                  (i32.eq (local.get $ta) (i32.const ${PTR.STRING}))
                  (i32.eq (local.get $ta) (i32.const ${PTR.SSO})))
                (i32.or
                  (i32.eq (local.get $tb) (i32.const ${PTR.STRING}))
                  (i32.eq (local.get $tb) (i32.const ${PTR.SSO}))))
              (then (call $__str_eq (local.get $a) (local.get $b)))
              (else (i32.const 0))))))))`

  ctx.core.stdlib['__is_null'] = `(func $__is_null (param $v f64) (result i32)
    (i64.eq (i64.reinterpret_f64 (local.get $v)) (i64.const ${NULL_NAN})))`

  // Truthy check: handles regular numbers AND NaN-boxed pointers
  // Falsy: 0, -0, NaN, null, undefined, "" (empty SSO)
  ctx.core.stdlib['__is_truthy'] = `(func $__is_truthy (param $v f64) (result i32)
    (local $bits i64)
    (if (result i32) (f64.eq (local.get $v) (local.get $v))
      (then (f64.ne (local.get $v) (f64.const 0)))
      (else
        (local.set $bits (i64.reinterpret_f64 (local.get $v)))
        (i32.and
          (i32.and
            (i64.ne (local.get $bits) (i64.const 0x7FF8000000000000))
            (i64.ne (local.get $bits) (i64.const ${NULL_NAN})))
          (i32.and
            (i64.ne (local.get $bits) (i64.const ${UNDEF_NAN}))
            (i64.ne (local.get $bits) (i64.const 0x7FFA800000000000)))))))`

  ctx.core.stdlib['__is_str_key'] = `(func $__is_str_key (param $v f64) (result i32)
    (local $t i32)
    (if (result i32) (f64.eq (local.get $v) (local.get $v))
      (then (i32.const 0))
      (else
        (local.set $t (call $__ptr_type (local.get $v)))
        (i32.or
          (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
          (i32.eq (local.get $t) (i32.const ${PTR.SSO}))))))`


  // Default dynamic-property helpers are harmless stubs. The collection module
  // overrides them with the real sidecar-property implementation.
  ctx.core.stdlib['__dyn_get'] = `(func $__dyn_get (param $obj f64) (param $key f64) (result f64)
    (f64.const nan:${UNDEF_NAN}))`
  ctx.core.stdlib['__dyn_get_or'] = `(func $__dyn_get_or (param $obj f64) (param $key f64) (param $fallback f64) (result f64)
    (local.get $fallback))`
  ctx.core.stdlib['__dyn_set'] = `(func $__dyn_set (param $obj f64) (param $key f64) (param $val f64) (result f64)
    (local.get $val))`
  ctx.core.stdlib['__dyn_move'] = `(func $__dyn_move (param $oldOff i32) (param $newOff i32))`

  // Memory section auto-enabled: compile.js checks ctx.module.modules.ptr

  // === NaN-boxing: encode/decode ===

  ctx.core.stdlib['__mkptr'] = `(func $__mkptr (param $type i32) (param $aux i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64 (i64.or
      (i64.shl (i64.const ${NAN_PREFIX}) (i64.const 48))
      (i64.or
        (i64.shl (i64.and (i64.extend_i32_u (local.get $type)) (i64.const 0xF)) (i64.const 47))
        (i64.or
          (i64.shl (i64.and (i64.extend_i32_u (local.get $aux)) (i64.const 0x7FFF)) (i64.const 32))
          (i64.and (i64.extend_i32_u (local.get $offset)) (i64.const 0xFFFFFFFF)))))))`

  ctx.core.stdlib['__ptr_offset'] = `(func $__ptr_offset (param $ptr f64) (result i32)
    (local $bits i64) (local $off i32)
    (local.set $bits (i64.reinterpret_f64 (local.get $ptr)))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))))
    ;; Arrays can be reallocated during growth; follow forwarding pointer (cap=-1 sentinel).
    ;; Bounds are checked inside the loop so non-array ptrs skip them entirely, and well-formed
    ;; ARRAY ptrs without forwarding still pay only one bounds check before the cap load.
    (if (i32.eq
          (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 47)) (i64.const 0xF)))
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

  ctx.core.stdlib['__ptr_aux'] = `(func $__ptr_aux (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 32)) (i64.const 0x7FFF))))`

  ctx.core.stdlib['__ptr_type'] = `(func $__ptr_type (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 47)) (i64.const 0xF))))`

  // === Bump allocator ===

  if (ctx.memory.shared) {
    // Shared memory: heap offset stored at memory[1020] (i32), just before heap start at 1024
    ctx.core.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32)
      (local.set $ptr (i32.load (i32.const 1020)))
      (i32.store (i32.const 1020) (i32.and (i32.add (i32.add (local.get $ptr) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
      (local.get $ptr))`
    ctx.core.stdlib['__reset'] = `(func $__reset
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
    ctx.core.stdlib['__reset'] = `(func $__reset
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
  ctx.core.stdlib['__typed_data'] = `(func $__typed_data (param $ptr f64) (result i32)
    (local $off i32)
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result i32) (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 8))
      (then (i32.load (i32.add (local.get $off) (i32.const 4))))
      (else (local.get $off))))`

  // Hot (~85M calls in watr self-host). Type/offset extraction inlined; forwarding
  // loop only entered for ARRAY. ARRAY fast path dominates (nodes?.length, out.length …).
  ctx.core.stdlib['__len'] = `(func $__len (param $ptr f64) (result i32)
    (local $bits i64) (local $t i32) (local $off i32) (local $aux i32)
    (local.set $bits (i64.reinterpret_f64 (local.get $ptr)))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 47)) (i64.const 0xF))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))))
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
                (local.set $aux (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 32)) (i64.const 0x7FFF))))
                (if (result i32) (i32.and (local.get $aux) (i32.const 8))
                  (then (i32.shr_u (i32.load (local.get $off))
                                   (call $__typed_shift (i32.and (local.get $aux) (i32.const 7)))))
                  (else (i32.shr_u (i32.load (i32.sub (local.get $off) (i32.const 8)))
                                   (call $__typed_shift (local.get $aux))))))
              (else (i32.load (i32.sub (local.get $off) (i32.const 8))))))
          (else (i32.const 0))))))`

  ctx.core.stdlib['__cap'] = `(func $__cap (param $ptr f64) (result i32)
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

  // String (heap): [-4:len(i32)][chars...]
  ctx.core.stdlib['__str_len'] = `(func $__str_len (param $ptr f64) (result i32)
    (local $off i32)
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result i32)
      (i32.and
        (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.STRING}))
        (i32.ge_u (local.get $off) (i32.const 4)))
      (then (i32.load (i32.sub (local.get $off) (i32.const 4))))
      (else (i32.const 0))))`

  // Set len in memory (for push/pop). Hot (~42M calls in watr self-host).
  // Type/offset extraction inlined; forwarding loop only entered for ARRAY.
  ctx.core.stdlib['__set_len'] = `(func $__set_len (param $ptr f64) (param $len i32)
    (local $bits i64) (local $t i32) (local $off i32)
    (local.set $bits (i64.reinterpret_f64 (local.get $ptr)))
    (local.set $t (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.const 47)) (i64.const 0xF))))
    (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const 0xFFFFFFFF))))
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

  // Alloc header(8) + data(cap*stride), store len+cap, return data offset (past header)
  ctx.core.stdlib['__alloc_hdr'] = `(func $__alloc_hdr (param $len i32) (param $cap i32) (param $stride i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.add (i32.const 8) (i32.mul (local.get $cap) (local.get $stride)))))
    (i32.store (local.get $ptr) (local.get $len))
    (i32.store (i32.add (local.get $ptr) (i32.const 4)) (local.get $cap))
    (i32.add (local.get $ptr) (i32.const 8)))`

  // Allocator + exports are deferred: only included when memory is actually needed.
  // Any module using allocPtr/inc('__alloc') pulls these in via ctx.core.stdlibDeps.
  // compile.js emits _alloc/_reset exports + memory section only when __alloc is in includes.
  ctx.core._allocRawFuncs = [
    '(func (export "_alloc") (param $bytes i32) (result i32) (call $__alloc (local.get $bytes)))',
    '(func (export "_reset") (call $__reset))',
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
      return typed(['f64.convert_i32_s', ['call', '$__len', va]], 'f64')
    // Known string → byteLen (handles SSO + heap)
    if (vt === VAL.STRING) {
      inc('__str_byteLen')
      return typed(['f64.convert_i32_s', ['call', '$__str_byteLen', va]], 'f64')
    }
    // Unknown → runtime dispatch via stdlib. Set/Map dispatch arms are pulled
    // only when user code actually constructs Set/Map (collection.js sets the
    // feature flags at the construction site); otherwise dispatch falls through
    // to ARRAY/STRING/TYPED. typedarray stays on because typed arrays are
    // commonly passed from JS via jz.memory.* without an in-program constructor.
    inc('__length')
    ctx.features.typedarray = true
    return typed(['call', '$__length', va], 'f64')
  }

  // Known-schema fields live in the object payload. Dynamic sidecars are only
  // for ad-hoc props on pointer-backed values, so schema reads should bypass it.
  // Slot val-types reach the emit-time consumer via valTypeOf → ctx.schema.slotVT
  // (read on the AST `.prop` node), not via tagging this IR node.
  function emitSchemaSlotRead(baseExpr, idx) {
    const base = baseExpr?.type === 'f64' ? baseExpr : typed(baseExpr, 'f64')
    return typed(['f64.load', ['i32.add', ptrOffsetIR(base, VAL.OBJECT), ['i32.const', idx * 8]]], 'f64')
  }

  /** Emit .prop access for a WASM f64 node using schema or HASH fallback. */
  function emitPropAccess(va, obj, prop) {
    const schemaIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : ctx.schema.find(null, prop)
    const key = asF64(emit(['str', prop]))
    if (schemaIdx >= 0) return emitSchemaSlotRead(asF64(va), schemaIdx)
    if (typeof obj === 'string') {
      const vt = lookupValType(obj)
      if (usesDynProps(vt)) {
        inc('__dyn_get_expr')
        return typed(['call', '$__dyn_get_expr', asF64(va), key], 'f64')
      }
      if (vt === VAL.HASH) {
        inc('__hash_get_local')
        return typed(['call', '$__hash_get_local', asF64(va), key], 'f64')
      }
      if (vt == null) {
        inc('__dyn_get_any')
        ctx.features.external = true
        return typed(['call', '$__dyn_get_any', asF64(va), key], 'f64')
      }
      inc('__hash_get', '__str_hash', '__str_eq')
      return typed(['call', '$__hash_get', asF64(va), key], 'f64')
    }
    // Non-string receiver: route through HASH fast path when valTypeOf can
    // resolve the chain to a known HASH (e.g. `o.meta.bias` where `o.meta` is
    // a HASH per the parsed JSON shape). Falls back to dynamic dispatch
    // otherwise.
    if (valTypeOf(obj) === VAL.HASH) {
      inc('__hash_get_local')
      return typed(['call', '$__hash_get_local', asF64(va), key], 'f64')
    }
    inc('__dyn_get_expr')
    return typed(['call', '$__dyn_get_expr', asF64(va), key], 'f64')
  }

  // Runtime .length dispatch — factory elides branches for types that can't exist in
  // this program (features.* + hash-stdlib presence). ARRAY is always live; STRING and
  // number are always dispatched. SSO branch elided when features.sso is off. The __len
  // disjunction collapses to whichever of ARRAY/TYPED/HASH/SET/MAP are reachable.
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
            (then
              (if (result f64) (i32.ge_u (local.get $off) (i32.const 4))
                (then (f64.convert_i32_s (call $__str_len (local.get $v))))
                (else (f64.const nan:${UNDEF_NAN}))))
            (else ${lenArm}))`
    const afterNumber = ctx.features.sso
      ? `(if (result f64) (i32.eq (local.get $t) (i32.const ${PTR.SSO}))
          (then (f64.convert_i32_s (call $__ptr_aux (local.get $v))))
          (else ${stringArm}))`
      : stringArm
    return `(func $__length (param $v f64) (result f64)
    (local $t i32) (local $off i32)
    (if (result f64) (f64.eq (local.get $v) (local.get $v))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (local.set $t (call $__ptr_type (local.get $v)))
        (local.set $off (call $__ptr_offset (local.get $v)))
        ${afterNumber})))`
  }

  // === Property dispatch (.length, .prop) ===

  ctx.core.emit['.'] = (obj, prop) => {
    // Boxed object: delegate .length and .prop to inner value or schema
    if (typeof obj === 'string' && ctx.schema.isBoxed(obj)) {
      if (prop === 'length') {
        const inner = ctx.schema.emitInner(obj)
        return typed(['f64.convert_i32_s', ['call', '$__len', inner]], 'f64')
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
            inc('__dyn_get_expr')
            access = ['call', '$__dyn_get_expr', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
          } else if (objType === VAL.HASH) {
            inc('__hash_get_local')
            access = ['call', '$__hash_get_local', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
          } else if (objType == null) {
            inc('__dyn_get_any')
            ctx.features.external = true
            access = ['call', '$__dyn_get_any', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
          } else {
            inc('__hash_get', '__str_hash', '__str_eq')
            access = ['call', '$__hash_get', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
          }
        } else {
          if (valTypeOf(obj) === VAL.HASH) {
            inc('__hash_get_local')
            access = ['call', '$__hash_get_local', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
          } else {
            inc('__dyn_get_expr')
            access = ['call', '$__dyn_get_expr', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
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
    return typed(['call', '$__typeof', asF64(emit(a))], 'f64')
  }

  ctx.core.stdlib['__typeof'] = () => {
    const stringTest = ctx.features.sso
      ? `(i32.or (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.eq (local.get $t) (i32.const ${PTR.SSO})))`
      : `(i32.eq (local.get $t) (i32.const ${PTR.STRING}))`
    const closureArm = ctx.features.closure
      ? `(if (i32.eq (local.get $t) (i32.const ${PTR.CLOSURE}))
      (then (return (global.get $__tof_function))))`
      : ''
    return `(func $__typeof (param $v f64) (result f64)
    (local $t i32)
    (if (f64.eq (local.get $v) (local.get $v))
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
  ctx.core.emit['__ptr_type'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_type', asF64(emit(p))]], 'f64')
  ctx.core.emit['__ptr_aux'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_aux', asF64(emit(p))]], 'f64')
  ctx.core.emit['__ptr_offset'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_offset', asF64(emit(p))]], 'f64')

  // Error(msg) — passthrough (throw handles any value)
  ctx.core.emit['Error'] = (msg) => asF64(emit(msg))
}
