/**
 * Pointer module — NaN-boxing, bump allocator, property dispatch.
 *
 * Foundation for all heap types (arrays, objects, strings).
 * NaN-boxing: quiet NaN (0x7FF8) + 51-bit payload [type:4][aux:15][offset:32]
 *
 * Auto-included by array/object/string modules.
 *
 * @module ptr
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const NAN_PREFIX = 0x7FF8
const err = msg => { throw Error(msg) }

export default () => {
  ctx.memory = true

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

  ctx.globals.push('(global $__heap (mut i32) (i32.const 1024))')

  ctx.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (local.get $ptr))`

  ctx.stdlib['__reset'] = `(func $__reset
    (global.set $__heap (i32.const 1024)))`

  for (const name of ['__mkptr', '__ptr_offset', '__ptr_aux', '__ptr_type', '__alloc', '__reset'])
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
    // .length → aux bits (works for arrays, strings, any pointer with length in aux)
    if (prop === 'length')
      return typed(['f64.convert_i32_s', ['call', '$__ptr_aux', asF64(emit(obj))]], 'f64')

    // Object property → schema lookup
    if (typeof obj === 'string') {
      const idx = ctx.findPropIndex(obj, prop)
      if (idx >= 0) {
        const va = emit(obj)
        return typed(['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.const', idx * 8]]], 'f64')
      }
    }

    err(`Unknown property: .${prop}`)
  }

  // === Schema helpers (shared via ctx, used by object module + prepare) ===

  ctx.registerSchema = (props) => {
    const key = props.join(',')
    const existing = ctx.schemas.findIndex(s => s.join(',') === key)
    if (existing >= 0) return existing
    return ctx.schemas.push(props) - 1
  }

  ctx.findPropIndex = (varName, prop) => {
    // Check variable's known schema first
    const id = ctx.varSchemas.get(varName)
    if (id != null) { const idx = ctx.schemas[id].indexOf(prop); if (idx >= 0) return idx }
    // Duck typing: find any schema with this property (for function params)
    for (const s of ctx.schemas) { const idx = s.indexOf(prop); if (idx >= 0) return idx }
    return -1
  }

  // Low-level pointer helpers callable from jz code
  ctx.emit['__mkptr'] = (t, a, o) => typed(['call', '$__mkptr', asI32(emit(t)), asI32(emit(a)), asI32(emit(o))], 'f64')
  ctx.emit['__ptr_type'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_type', asF64(emit(p))]], 'f64')
  ctx.emit['__ptr_aux'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_aux', asF64(emit(p))]], 'f64')
  ctx.emit['__ptr_offset'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_offset', asF64(emit(p))]], 'f64')
}
