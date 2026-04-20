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

import { emit, typed, asF64, asI32, valTypeOf, VAL, T, NULL_NAN, UNDEF_NAN, temp, usesDynProps } from '../src/compile.js'
import { ctx, err, inc, PTR } from '../src/ctx.js'
import { initSchema } from './schema.js'

const NAN_PREFIX = 0x7FF8

export default () => {
  ctx.core.stdlib['__is_nullish'] = `(func $__is_nullish (param $v f64) (result i32)
    (i32.or
      (i64.eq (i64.reinterpret_f64 (local.get $v)) (i64.const ${NULL_NAN}))
      (i64.eq (i64.reinterpret_f64 (local.get $v)) (i64.const ${UNDEF_NAN}))))`

  ctx.core.stdlib['__eq'] = `(func $__eq (param $a f64) (param $b f64) (result i32)
    (local $ra i64) (local $rb i64) (local $ta i32) (local $tb i32)
    (if (result i32)
      (i32.and
        (f64.eq (local.get $a) (local.get $a))
        (f64.eq (local.get $b) (local.get $b)))
      (then (f64.eq (local.get $a) (local.get $b)))
      (else
        (local.set $ra (i64.reinterpret_f64 (local.get $a)))
        (local.set $rb (i64.reinterpret_f64 (local.get $b)))
        (if (result i32)
          (i64.eq (local.get $ra) (local.get $rb))
          (then
            (if (result i32)
              (i64.eq (local.get $ra) (i64.const 0x7FF8000000000000))
              (then (i32.const 0))
              (else (i32.const 1))))
          (else
            (local.set $ta (call $__ptr_type (local.get $a)))
            (local.set $tb (call $__ptr_type (local.get $b)))
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
    (if (result i32) (f64.eq (local.get $v) (local.get $v))
      (then (f64.ne (local.get $v) (f64.const 0)))
      (else (i32.and
        (i32.and
          (i64.ne (i64.reinterpret_f64 (local.get $v)) (i64.const 0x7FF8000000000000))
          (i64.ne (i64.reinterpret_f64 (local.get $v)) (i64.const ${NULL_NAN})))
        (i32.and
          (i64.ne (i64.reinterpret_f64 (local.get $v)) (i64.const ${UNDEF_NAN}))
          (i64.ne (i64.reinterpret_f64 (local.get $v)) (i64.const 0x7FFA800000000000)))))))`

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
    (local $raw i32) (local $off i32)
    (local.set $raw (i32.wrap_i64 (i64.and (i64.reinterpret_f64 (local.get $ptr)) (i64.const 0xFFFFFFFF))))
    (local.set $off (local.get $raw))
    ;; Arrays can be reallocated during growth. Preserve alias semantics by
    ;; following forwarding headers until we reach the current backing store.
    (if
      (i32.and
        (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const ${PTR.ARRAY}))
        (i32.and
          (i32.ge_u (local.get $off) (i32.const 8))
          (i32.le_u (local.get $off)
            (i32.sub (i32.mul (memory.size) (i32.const 65536)) (i32.const 8)))))
      (then
        (block $done
          (loop $follow
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

  ctx.core.stdlib['__len'] = `(func $__len (param $ptr f64) (result i32)
    (local $t i32) (local $off i32) (local $aux i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if (result i32)
      (i32.and
        (i32.ge_u (local.get $off) (i32.const 8))
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
              (then (i32.shr_u (i32.load (local.get $off))
                               (call $__typed_shift (i32.and (local.get $aux) (i32.const 7)))))
              (else (i32.shr_u (i32.load (i32.sub (local.get $off) (i32.const 8)))
                               (call $__typed_shift (local.get $aux))))))
          (else (i32.load (i32.sub (local.get $off) (i32.const 8))))))
      (else (i32.const 0))))`

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

  // Set len in memory (for push/pop)
  ctx.core.stdlib['__set_len'] = `(func $__set_len (param $ptr f64) (param $len i32)
    (local $t i32) (local $off i32)
    (local.set $t (call $__ptr_type (local.get $ptr)))
    (local.set $off (call $__ptr_offset (local.get $ptr)))
    (if
      (i32.and
        (i32.ge_u (local.get $off) (i32.const 8))
        (i32.or
          (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 3)))
          (i32.or (i32.eq (local.get $t) (i32.const 7))
            (i32.or (i32.eq (local.get $t) (i32.const 8)) (i32.eq (local.get $t) (i32.const 9))))))
      (then (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $len)))))`

  // Alloc header(8) + data(cap*stride), store len+cap, return data offset (past header)
  ctx.core.stdlib['__alloc_hdr'] = `(func $__alloc_hdr (param $len i32) (param $cap i32) (param $stride i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.add (i32.const 8) (i32.mul (local.get $cap) (local.get $stride)))))
    (i32.store (local.get $ptr) (local.get $len))
    (i32.store (i32.add (local.get $ptr) (i32.const 4)) (local.get $cap))
    (i32.add (local.get $ptr) (i32.const 8)))`

  // Allocator + exports are deferred: only included when memory is actually needed.
  // Any module using allocPtr/inc('__alloc') pulls these in via STDLIB_DEPS.
  // compile.js emits _alloc/_reset exports + memory section only when __alloc is in includes.
  ctx.core._allocRawFuncs = [
    '(func (export "_alloc") (param $bytes i32) (result i32) (call $__alloc (local.get $bytes)))',
    '(func (export "_reset") (call $__reset))',
  ]

  // Not-nullish check: f64 WAT node is neither NULL_NAN nor UNDEF_NAN
  const notNullish = v => {
    inc('__is_nullish')
    return ['i32.eqz', ['call', '$__is_nullish', v]]
  }

  // === Shared dispatch helpers ===

  /** Emit .length access for a WASM f64 node. Monomorphize by vt, or runtime dispatch. */
  function emitLengthAccess(va, vt) {
    // Known array/typed/set/map → direct header read
    if (vt === VAL.ARRAY || vt === VAL.TYPED || vt === VAL.SET || vt === VAL.MAP)
      return typed(['f64.convert_i32_s', ['call', '$__len', va]], 'f64')
    // Known string → byteLen (handles SSO + heap)
    if (vt === VAL.STRING)
      return typed(['f64.convert_i32_s', ['call', '$__str_byteLen', va]], 'f64')
    // Unknown → runtime dispatch via stdlib (avoids block nesting issues in statement context)
    inc('__length')
    return typed(['call', '$__length', va], 'f64')
  }

  // Known-schema fields live in the object payload. Dynamic sidecars are only
  // for ad-hoc props on pointer-backed values, so schema reads should bypass it.
  function emitSchemaSlotRead(baseExpr, idx) {
    const base = baseExpr?.type === 'f64' ? baseExpr : typed(baseExpr, 'f64')
    return typed(['f64.load', ['i32.add', ['call', '$__ptr_offset', base], ['i32.const', idx * 8]]], 'f64')
  }

  /** Emit .prop access for a WASM f64 node using schema or HASH fallback. */
  function emitPropAccess(va, obj, prop) {
    const schemaIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : ctx.schema.find(null, prop)
    const key = asF64(emit(['str', prop]))
    if (schemaIdx >= 0) return emitSchemaSlotRead(asF64(va), schemaIdx)
    if (typeof obj === 'string') {
      const vt = ctx.func.valTypes?.get(obj) || ctx.scope.globalValTypes?.get(obj)
      if (usesDynProps(vt)) {
        inc('__dyn_get_expr')
        return typed(['call', '$__dyn_get_expr', asF64(va), key], 'f64')
      }
      if (vt == null) {
        inc('__dyn_get_expr', '__hash_get', '__str_hash', '__str_eq')
        return typed(['if', ['result', 'f64'],
          ['i32.eq', ['call', '$__ptr_type', asF64(va)], ['i32.const', PTR.EXTERNAL]],
          ['then', ['call', '$__hash_get', asF64(va), key]],
          ['else', ['call', '$__dyn_get_expr', asF64(va), key]]], 'f64')
      }
      inc('__hash_get', '__str_hash', '__str_eq')
      return typed(['call', '$__hash_get', asF64(va), key], 'f64')
    }
    inc('__dyn_get_expr')
    return typed(['call', '$__dyn_get_expr', asF64(va), key], 'f64')
  }

  // Runtime .length dispatch as a stdlib function (avoids block nesting issues)
  ctx.core.stdlib['__length'] = `(func $__length (param $v f64) (result f64)
    (local $t i32) (local $off i32)
    ;; Plain numbers are not NaN-box pointers; .length should be undefined.
    (if (result f64) (f64.eq (local.get $v) (local.get $v))
      (then (f64.const nan:${UNDEF_NAN}))
      (else
        (local.set $t (call $__ptr_type (local.get $v)))
        (local.set $off (call $__ptr_offset (local.get $v)))
        (if (result f64) (i32.eq (local.get $t) (i32.const 5))
          (then (f64.convert_i32_s (call $__ptr_aux (local.get $v))))
          (else (if (result f64) (i32.eq (local.get $t) (i32.const 4))
            (then
              (if (result f64) (i32.ge_u (local.get $off) (i32.const 4))
                (then (f64.convert_i32_s (call $__str_len (local.get $v))))
                (else (f64.const nan:${UNDEF_NAN}))))
            (else (if (result f64)
              (i32.or
                (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 3)))
                (i32.or (i32.eq (local.get $t) (i32.const 7))
                  (i32.or (i32.eq (local.get $t) (i32.const 8)) (i32.eq (local.get $t) (i32.const 9)))))
              (then
                (if (result f64) (i32.ge_u (local.get $off) (i32.const 8))
                  (then (f64.convert_i32_s (call $__len (local.get $v))))
                  (else (f64.const nan:${UNDEF_NAN}))))
              (else (f64.const nan:${UNDEF_NAN}))))))))))`

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
      const vt = typeof obj === 'string' ? ctx.func.valTypes?.get(obj) : valTypeOf(obj)
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
    const vt = typeof obj === 'string' ? ctx.func.valTypes?.get(obj) : valTypeOf(obj)
    let access
    if (prop === 'length') {
      access = emitLengthAccess(['local.get', `$${t}`], vt)
    } else {
      const propIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : -1
      if (propIdx >= 0) {
        access = emitSchemaSlotRead(['local.get', `$${t}`], propIdx)
      }
      else {
        if (typeof obj === 'string') {
          const objType = ctx.func.valTypes?.get(obj) || ctx.scope.globalValTypes?.get(obj)
          if (usesDynProps(objType)) {
            inc('__dyn_get_expr')
            access = ['call', '$__dyn_get_expr', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
          } else if (objType == null) {
            inc('__dyn_get_expr', '__hash_get', '__str_hash', '__str_eq')
            access = ['if', ['result', 'f64'],
              ['i32.eq', ['call', '$__ptr_type', ['local.get', `$${t}`]], ['i32.const', PTR.EXTERNAL]],
              ['then', ['call', '$__hash_get', ['local.get', `$${t}`], asF64(emit(['str', prop]))]],
              ['else', ['call', '$__dyn_get_expr', ['local.get', `$${t}`], asF64(emit(['str', prop]))]]]
          } else {
            inc('__hash_get', '__str_hash', '__str_eq')
            access = ['call', '$__hash_get', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
          }
        } else {
          inc('__dyn_get_expr')
          access = ['call', '$__dyn_get_expr', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
        }
      }
    }
    return typed(['if', ['result', 'f64'],
      notNullish(['local.tee', `$${t}`, va]),
      ['then', access],
      ['else', ['f64.const', `nan:${NULL_NAN}`]]], 'f64')
  }

  // Optional index: arr?.[i] → null if arr is null, else arr[i]
  // Cache base in temp, propagate valType so []'s type dispatch works
  ctx.core.emit['?.[]'] = (arr, idx) => {
    const t = temp()
    const va = asF64(emit(arr))
    // Propagate source type to temp so [] dispatch (string, typed, etc.) works
    const srcType = typeof arr === 'string' ? ctx.func.valTypes?.get(arr) : null
    if (srcType) ctx.func.valTypes.set(t, srcType)
    if (typeof arr === 'string' && ctx.types.typedElem?.has(arr)) {
      if (!ctx.types.typedElem) ctx.types.typedElem = new Map()
      ctx.types.typedElem.set(t, ctx.types.typedElem.get(arr))
    }
    // Emit: tee base into temp, null-check, then use normal [] on temp
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, va],
      ['if', ['result', 'f64'],
        notNullish(['local.get', `$${t}`]),
        ['then', asF64(ctx.core.emit['[]'](t, idx))],
        ['else', ['f64.const', `nan:${NULL_NAN}`]]]], 'f64')
  }

  // Optional call: fn?.(...args) → null if fn is null, else call fn
  ctx.core.emit['?.()'] = (callee, ...args) => {
    const t = temp()
    const va = asF64(emit(callee))
    // If nullish → return NULL_NAN, else call via fn.call
    if (!ctx.closure.call) err('Optional call requires fn module')
    const callResult = ctx.closure.call(typed(['local.get', `$${t}`], 'f64'), args)
    return typed(['if', ['result', 'f64'],
      notNullish(['local.tee', `$${t}`, va]),
      ['then', asF64(callResult)],
      ['else', ['f64.const', `nan:${NULL_NAN}`]]], 'f64')
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
    return typed(['call', '$__typeof', asF64(emit(a))], 'f64')
  }

  ctx.core.stdlib['__typeof'] = `(func $__typeof (param $v f64) (result f64)
    (local $t i32)
    ;; Plain number: x === x (NaN-boxed pointers are quiet NaNs, fail self-equality)
    (if (f64.eq (local.get $v) (local.get $v))
      (then (return (global.get $__tof_number))))
    ;; Nullish (both null and undefined NAN values) → 'undefined'
    (if (call $__is_nullish (local.get $v))
      (then (return (global.get $__tof_undefined))))
    (local.set $t (call $__ptr_type (local.get $v)))
    ;; String (heap) or SSO → 'string'
    (if (i32.or
          (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
          (i32.eq (local.get $t) (i32.const ${PTR.SSO})))
      (then (return (global.get $__tof_string))))
    ;; Closure → 'function'
    (if (i32.eq (local.get $t) (i32.const ${PTR.CLOSURE}))
      (then (return (global.get $__tof_function))))
    ;; ATOM (non-nullish) → 'symbol'
    (if (i32.eqz (local.get $t))
      (then (return (global.get $__tof_symbol))))
    ;; Everything else (array, object, hash, set, map, typed, buffer, external) → 'object'
    (global.get $__tof_object))`

  // === Schema helpers (centralized in module/schema.js) ===
  initSchema()

  // Low-level pointer helpers callable from jz code
  ctx.core.emit['__mkptr'] = (t, a, o) => typed(['call', '$__mkptr', asI32(emit(t)), asI32(emit(a)), asI32(emit(o))], 'f64')
  ctx.core.emit['__ptr_type'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_type', asF64(emit(p))]], 'f64')
  ctx.core.emit['__ptr_aux'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_aux', asF64(emit(p))]], 'f64')
  ctx.core.emit['__ptr_offset'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_offset', asF64(emit(p))]], 'f64')

  // Error(msg) — passthrough (throw handles any value)
  ctx.core.emit['Error'] = (msg) => asF64(emit(msg))
}
