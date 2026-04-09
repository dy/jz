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

import { emit, typed, asF64, asI32, valTypeOf, VAL, T, NULL_NAN, temp } from '../src/compile.js'
import { ctx, err } from '../src/ctx.js'
import { initSchema } from './schema.js'

const NAN_PREFIX = 0x7FF8

export default () => {
  // Memory section auto-enabled: compile.js checks ctx.modules.ptr

  // === NaN-boxing: encode/decode ===

  ctx.stdlib['__mkptr'] = `(func $__mkptr (param $type i32) (param $aux i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64 (i64.or
      (i64.shl (i64.const ${NAN_PREFIX}) (i64.const 48))
      (i64.or
        (i64.shl (i64.and (i64.extend_i32_u (local.get $type)) (i64.const 0xF)) (i64.const 47))
        (i64.or
          (i64.shl (i64.and (i64.extend_i32_u (local.get $aux)) (i64.const 0x7FFF)) (i64.const 32))
          (i64.and (i64.extend_i32_u (local.get $offset)) (i64.const 0xFFFFFFFF)))))))`

  ctx.stdlib['__ptr_offset'] = `(func $__ptr_offset (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.and (i64.reinterpret_f64 (local.get $ptr)) (i64.const 0xFFFFFFFF))))`

  ctx.stdlib['__ptr_aux'] = `(func $__ptr_aux (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 32)) (i64.const 0x7FFF))))`

  ctx.stdlib['__ptr_type'] = `(func $__ptr_type (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 47)) (i64.const 0xF))))`

  // === Bump allocator ===

  if (ctx.sharedMemory) {
    // Shared memory: heap offset stored at memory[1020] (i32), just before heap start at 1024
    ctx.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32)
      (local.set $ptr (i32.load (i32.const 1020)))
      (i32.store (i32.const 1020) (i32.and (i32.add (i32.add (local.get $ptr) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
      (local.get $ptr))`
    ctx.stdlib['__reset'] = `(func $__reset
      (i32.store (i32.const 1020) (i32.const 1024)))`
  } else {
    // Own memory: heap offset in a global, auto-grow when needed
    ctx.globals.set('__heap', '(global $__heap (mut i32) (i32.const 1024))')
    ctx.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
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
    ctx.stdlib['__reset'] = `(func $__reset
      (global.set $__heap (i32.const 1024)))`
  }

  // === Memory-based length/cap helpers (C-style headers) ===

  // Array/TypedArray: [-8:len(i32)][-4:cap(i32)][data...]
  ctx.stdlib['__len'] = `(func $__len (param $ptr f64) (result i32)
    (i32.load (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 8))))`

  ctx.stdlib['__cap'] = `(func $__cap (param $ptr f64) (result i32)
    (i32.load (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 4))))`

  // String (heap): [-4:len(i32)][chars...]
  ctx.stdlib['__str_len'] = `(func $__str_len (param $ptr f64) (result i32)
    (i32.load (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 4))))`

  // Set len in memory (for push/pop)
  ctx.stdlib['__set_len'] = `(func $__set_len (param $ptr f64) (param $len i32)
    (i32.store (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 8)) (local.get $len)))`

  // Alloc header(8) + data(cap*stride), store len+cap, return data offset (past header)
  ctx.stdlib['__alloc_hdr'] = `(func $__alloc_hdr (param $len i32) (param $cap i32) (param $stride i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (call $__alloc (i32.add (i32.const 8) (i32.mul (local.get $cap) (local.get $stride)))))
    (i32.store (local.get $ptr) (local.get $len))
    (i32.store (i32.add (local.get $ptr) (i32.const 4)) (local.get $cap))
    (i32.add (local.get $ptr) (i32.const 8)))`

  for (const name of ['__mkptr', '__ptr_offset', '__ptr_aux', '__ptr_type', '__alloc', '__reset', '__len', '__cap', '__str_len', '__set_len', '__alloc_hdr'])
    ctx.includes.add(name)

  // Export allocator
  ctx.funcs.push({
    name: '_alloc', body: null, exported: true,
    sig: { params: [{ name: 'bytes', type: 'i32' }], results: ['i32'] },
    raw: '(func (export "_alloc") (param $bytes i32) (result i32) (call $__alloc (local.get $bytes)))'
  })
  ctx.funcs.push({
    name: '_reset', body: null, exported: true,
    sig: { params: [], results: [] },
    raw: '(func (export "_reset") (call $__reset))'
  })

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
    ctx.includes.add('__length')
    return typed(['call', '$__length', va], 'f64')
  }

  /** Emit .prop access for a WASM f64 node using schema or HASH fallback. */
  function emitPropAccess(va, obj, prop) {
    const schemaIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : ctx.schema.find(null, prop)
    if (schemaIdx >= 0)
      return typed(['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.const', schemaIdx * 8]]], 'f64')
    // HASH (dynamic object) → runtime string-key lookup (fallback for any unresolved property)
    ctx.includes.add('__hash_get'); ctx.includes.add('__str_hash'); ctx.includes.add('__str_eq')
    return typed(['call', '$__hash_get', asF64(va), asF64(emit(['str', prop]))], 'f64')
  }

  // Runtime .length dispatch as a stdlib function (avoids block nesting issues)
  ctx.stdlib['__length'] = `(func $__length (param $v f64) (result f64)
    (local $t i32)
    (local.set $t (call $__ptr_type (local.get $v)))
    (if (result f64) (i32.eq (local.get $t) (i32.const 5))
      (then (f64.convert_i32_s (call $__ptr_aux (local.get $v))))
      (else (if (result f64) (i32.eq (local.get $t) (i32.const 4))
        (then (f64.convert_i32_s (call $__str_len (local.get $v))))
        (else (f64.convert_i32_s (call $__len (local.get $v))))))))`

  // === Property dispatch (.length, .prop) ===

  ctx.emit['.'] = (obj, prop) => {
    // Boxed object: delegate .length and .prop to inner value or schema
    if (typeof obj === 'string' && ctx.schema.isBoxed(obj)) {
      if (prop === 'length') {
        const inner = ctx.schema.emitInner(obj)
        return typed(['f64.convert_i32_s', ['call', '$__len', inner]], 'f64')
      }
      const idx = ctx.schema.find(obj, prop)
      if (idx >= 0)
        return typed(['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(emit(obj))], ['i32.const', idx * 8]]], 'f64')
    }

    if (prop === 'length') {
      const vt = typeof obj === 'string' ? ctx.valTypes?.get(obj) : valTypeOf(obj)
      return emitLengthAccess(asF64(emit(obj)), vt)
    }

    // Module-registered property emitter (.size, etc.)
    const propKey = `.${prop}`
    if (ctx.emit[propKey]) return ctx.emit[propKey](obj)

    return emitPropAccess(emit(obj), obj, prop)
  }

  // Optional chaining: obj?.prop → null if obj is null, else obj.prop
  ctx.emit['?.'] = (obj, prop) => {
    const t = temp()
    const va = asF64(emit(obj))
    const vt = typeof obj === 'string' ? ctx.valTypes?.get(obj) : valTypeOf(obj)
    let access
    if (prop === 'length') {
      access = emitLengthAccess(['local.get', `$${t}`], vt)
    } else {
      const propIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : -1
      if (propIdx >= 0)
        access = ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.const', propIdx * 8]]]
      else {
        ctx.includes.add('__hash_get'); ctx.includes.add('__str_hash'); ctx.includes.add('__str_eq')
        access = ['call', '$__hash_get', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
      }
    }
    return typed(['if', ['result', 'f64'],
      ['i64.ne', ['i64.reinterpret_f64', ['local.tee', `$${t}`, va]], ['i64.const', NULL_NAN]],
      ['then', access],
      ['else', ['f64.reinterpret_i64', ['i64.const', NULL_NAN]]]], 'f64')
  }

  // Optional index: arr?.[i] → null if arr is null, else arr[i]
  // Cache base in temp, propagate valType so []'s type dispatch works
  ctx.emit['?.[]'] = (arr, idx) => {
    const t = temp()
    const va = asF64(emit(arr))
    // Propagate source type to temp so [] dispatch (string, typed, etc.) works
    const srcType = typeof arr === 'string' ? ctx.valTypes?.get(arr) : null
    if (srcType) ctx.valTypes.set(t, srcType)
    if (typeof arr === 'string' && ctx.typedElem?.has(arr)) {
      if (!ctx.typedElem) ctx.typedElem = new Map()
      ctx.typedElem.set(t, ctx.typedElem.get(arr))
    }
    // Emit: tee base into temp, null-check, then use normal [] on temp
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, va],
      ['if', ['result', 'f64'],
        ['i64.ne', ['i64.reinterpret_f64', ['local.get', `$${t}`]], ['i64.const', NULL_NAN]],
        ['then', asF64(ctx.emit['[]'](t, idx))],
        ['else', ['f64.reinterpret_i64', ['i64.const', NULL_NAN]]]]], 'f64')
  }

  // Optional call: fn?.(...args) → null if fn is null, else call fn
  ctx.emit['?.()'] = (callee, ...args) => {
    const t = temp()
    const va = asF64(emit(callee))
    // If nullish → return NULL_NAN, else call via fn.call
    if (!ctx.fn.call) err('Optional call requires fn module')
    const callResult = ctx.fn.call(typed(['local.get', `$${t}`], 'f64'), args)
    return typed(['if', ['result', 'f64'],
      ['i64.ne', ['i64.reinterpret_f64', ['local.tee', `$${t}`, va]], ['i64.const', NULL_NAN]],
      ['then', asF64(callResult)],
      ['else', ['f64.reinterpret_i64', ['i64.const', NULL_NAN]]]], 'f64')
  }

  // typeof: returns ptr type code (0=atom, 1=array, 4=string, 6=object), or -1 for plain number
  ctx.emit['typeof'] = (a) => {
    const t = temp()
    return typed(['if', ['result', 'f64'],
      // NaN check: val != val means it's a NaN-boxed pointer
      ['f64.ne', ['local.tee', `$${t}`, asF64(emit(a))], ['local.get', `$${t}`]],
      ['then', ['f64.convert_i32_s', ['call', '$__ptr_type', ['local.get', `$${t}`]]]],
      ['else', ['f64.const', -1]]], 'f64') // -1 = plain number
  }

  // === Schema helpers (centralized in module/schema.js) ===
  initSchema()

  // Low-level pointer helpers callable from jz code
  ctx.emit['__mkptr'] = (t, a, o) => typed(['call', '$__mkptr', asI32(emit(t)), asI32(emit(a)), asI32(emit(o))], 'f64')
  ctx.emit['__ptr_type'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_type', asF64(emit(p))]], 'f64')
  ctx.emit['__ptr_aux'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_aux', asF64(emit(p))]], 'f64')
  ctx.emit['__ptr_offset'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_offset', asF64(emit(p))]], 'f64')

  // Error(msg) — passthrough (throw handles any value)
  ctx.emit['Error'] = (msg) => asF64(emit(msg))
}
