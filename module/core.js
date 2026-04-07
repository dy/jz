/**
 * Core module — NaN-boxing, bump allocator, property dispatch.
 *
 * Foundation for all heap types. Every module depends on this.
 * NaN-boxing: quiet NaN (0x7FF8) + 51-bit payload [type:4][aux:15][offset:32]
 *
 * Auto-included by array/object/string modules.
 *
 * @module ptr
 */

import { emit, typed, asF64, asI32, valTypeOf, VAL, T } from '../src/compile.js'
import { ctx, err } from '../src/ctx.js'

const NAN_PREFIX = 0x7FF8
const temp = () => { const n = `${T}t${ctx.uniq++}`; ctx.locals.set(n, 'f64'); return n }

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
    // Own memory: heap offset in a global
    ctx.globals.set('__heap', '(global $__heap (mut i32) (i32.const 1024))')
    ctx.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
      (local $ptr i32)
      (local.set $ptr (global.get $__heap))
      ;; Align next allocation to 8 bytes
      (global.set $__heap (i32.and (i32.add (i32.add (global.get $__heap) (local.get $bytes)) (i32.const 7)) (i32.const -8)))
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

  for (const name of ['__mkptr', '__ptr_offset', '__ptr_aux', '__ptr_type', '__alloc', '__reset', '__len', '__cap', '__str_len', '__set_len'])
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

  // === Property dispatch (.length, .prop) ===

  ctx.emit['.'] = (obj, prop) => {
    // Boxed object: delegate .length and .prop to inner value or schema
    if (typeof obj === 'string' && ctx.schema.isBoxed(obj)) {
      if (prop === 'length') {
        // .length → delegate to inner value (slot 0)
        const inner = ctx.schema.emitInner(obj)
        return typed(['f64.convert_i32_s', ['call', '$__len', inner]], 'f64')
      }
      // Named property → schema lookup (already handles __inner__ offset)
      const idx = ctx.schema.find(obj, prop)
      if (idx >= 0)
        return typed(['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(emit(obj))], ['i32.const', idx * 8]]], 'f64')
    }

    // .length → monomorphize when type is known, else runtime dispatch
    if (prop === 'length') {
      const vt = typeof obj === 'string' ? ctx.valTypes?.get(obj) : valTypeOf(obj)
      const va = asF64(emit(obj))
      // Known array/typed/set/map → direct header read
      if (vt === VAL.ARRAY || vt === VAL.TYPED || vt === VAL.SET || vt === VAL.MAP)
        return typed(['f64.convert_i32_s', ['call', '$__len', va]], 'f64')
      // Known string → byteLen (handles SSO + heap)
      if (vt === VAL.STRING)
        return typed(['f64.convert_i32_s', ['call', '$__str_byteLen', va]], 'f64')
      // Unknown → runtime dispatch
      const t = `${T}lt${ctx.uniq++}`
      ctx.locals.set(t, 'i32')
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, ['call', '$__ptr_type', va]],
        ['if', ['result', 'f64'], ['i32.eq', ['local.get', `$${t}`], ['i32.const', 5]],
          ['then', ['f64.convert_i32_s', ['call', '$__ptr_aux', va]]],
          ['else', ['if', ['result', 'f64'], ['i32.eq', ['local.get', `$${t}`], ['i32.const', 4]],
            ['then', ['f64.convert_i32_s', ['call', '$__str_len', va]]],
            ['else', ['f64.convert_i32_s', ['call', '$__len', va]]]]]]], 'f64')
    }

    // Module-registered property emitter (.size, etc.)
    const propKey = `.${prop}`
    if (ctx.emit[propKey]) return ctx.emit[propKey](obj)

    // Object property → schema lookup
    if (typeof obj === 'string') {
      const idx = ctx.schema.find(obj, prop)
      if (idx >= 0) {
        const va = emit(obj)
        return typed(['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.const', idx * 8]]], 'f64')
      }
    }

    // HASH (dynamic object) → runtime string-key lookup
    // Only emit if type is unknown; known non-object types should error at compile time
    if (typeof obj === 'string') {
      const vt = ctx.valTypes?.get(obj)
      if (vt && vt !== 'object') err(`Unknown property: .${prop} on ${vt}`)
    }
    ctx.includes.add('__hash_get'); ctx.includes.add('__str_hash'); ctx.includes.add('__str_eq')
    return typed(['call', '$__hash_get', asF64(emit(obj)), asF64(emit(['str', prop]))], 'f64')
  }

  // Optional chaining: obj?.prop → 0 if obj is 0/null, else obj.prop
  ctx.emit['?.'] = (obj, prop) => {
    const t = temp()
    const va = asF64(emit(obj))
    let access
    if (prop === 'length') {
      // Type-aware dispatch matching `.length`
      const vt = typeof obj === 'string' ? ctx.valTypes?.get(obj) : valTypeOf(obj)
      if (vt === VAL.ARRAY || vt === VAL.TYPED || vt === VAL.SET || vt === VAL.MAP)
        access = ['f64.convert_i32_s', ['call', '$__len', ['local.get', `$${t}`]]]
      else if (vt === VAL.STRING)
        access = ['f64.convert_i32_s', ['call', '$__str_byteLen', ['local.get', `$${t}`]]]
      else {
        // Unknown → runtime dispatch (SSO=5 → aux, heap string=4 → str_len, else → len)
        const tt = `${T}lt${ctx.uniq++}`
        ctx.locals.set(tt, 'i32')
        access = ['block', ['result', 'f64'],
          ['local.set', `$${tt}`, ['call', '$__ptr_type', ['local.get', `$${t}`]]],
          ['if', ['result', 'f64'], ['i32.eq', ['local.get', `$${tt}`], ['i32.const', 5]],
            ['then', ['f64.convert_i32_s', ['call', '$__ptr_aux', ['local.get', `$${t}`]]]],
            ['else', ['if', ['result', 'f64'], ['i32.eq', ['local.get', `$${tt}`], ['i32.const', 4]],
              ['then', ['f64.convert_i32_s', ['call', '$__str_len', ['local.get', `$${t}`]]]],
              ['else', ['f64.convert_i32_s', ['call', '$__len', ['local.get', `$${t}`]]]]]]]]
      }
    } else {
      const propIdx = typeof obj === 'string' ? ctx.schema.find(obj, prop) : -1
      if (propIdx >= 0)
        access = ['f64.load', ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.const', propIdx * 8]]]
      else {
        // HASH fallback for dynamic objects (same as `.` handler)
        ctx.includes.add('__hash_get'); ctx.includes.add('__str_hash'); ctx.includes.add('__str_eq')
        access = ['call', '$__hash_get', ['local.get', `$${t}`], asF64(emit(['str', prop]))]
      }
    }
    return typed(['if', ['result', 'f64'],
      ['f64.ne', ['local.tee', `$${t}`, va], ['f64.const', 0]],
      ['then', access],
      ['else', ['f64.const', 0]]], 'f64')
  }

  // Optional index: arr?.[i] → 0 if arr is 0 (null), else arr[i]
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
        ['f64.ne', ['local.get', `$${t}`], ['f64.const', 0]],
        ['then', asF64(ctx.emit['[]'](t, idx))],
        ['else', ['f64.const', 0]]]], 'f64')
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

  // === Schema helpers (shared via ctx, used by object module + prepare) ===

  ctx.schema.register = (props) => {
    const key = props.join(',')
    const existing = ctx.schema.list.findIndex(s => s.join(',') === key)
    if (existing >= 0) return existing
    return ctx.schema.list.push(props) - 1
  }

  /** Check if variable has a boxed schema (slot 0 = __inner__). */
  ctx.schema.isBoxed = (varName) => {
    const id = ctx.schema.vars.get(varName)
    return id != null && ctx.schema.list[id]?.[0] === '__inner__'
  }

  /** Emit code to load the inner value (slot 0) of a boxed variable. */
  ctx.schema.emitInner = (varName) => {
    return typed(['f64.load', ['call', '$__ptr_offset', asF64(emit(varName))]], 'f64')
  }

  ctx.schema.find = (varName, prop) => {
    // Precise: variable has known schema
    const id = ctx.schema.vars.get(varName)
    if (id != null) return ctx.schema.list[id]?.indexOf(prop) ?? -1
    // Structural subtyping: scan all schemas, require consistent offset.
    // This is the mechanism for schema objects passed through function parameters.
    // Falls through to HASH when no schema has the property.
    let result = -1
    for (const s of ctx.schema.list) {
      const idx = s.indexOf(prop)
      if (idx < 0) continue
      if (result >= 0 && result !== idx) err(`Ambiguous property .${prop}: different offset across schemas`)
      result = idx
    }
    return result
  }

  // Low-level pointer helpers callable from jz code
  ctx.emit['__mkptr'] = (t, a, o) => typed(['call', '$__mkptr', asI32(emit(t)), asI32(emit(a)), asI32(emit(o))], 'f64')
  ctx.emit['__ptr_type'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_type', asF64(emit(p))]], 'f64')
  ctx.emit['__ptr_aux'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_aux', asF64(emit(p))]], 'f64')
  ctx.emit['__ptr_offset'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_offset', asF64(emit(p))]], 'f64')
}
