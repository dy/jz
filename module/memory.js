/**
 * Memory module — NaN-boxed pointers, bump allocator, array operations.
 *
 * NaN-boxing: quiet NaN (0x7FF8) + 51-bit payload [type:4][aux:15][offset:32]
 * Arrays: type=1 (inline len in aux), type=2 (heap len at offset-8)
 *
 * Auto-included when code uses array literals or indexing.
 *
 * @module memory
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

// NaN-boxing constants
const ARRAY = 1, ARRAY_HEAP = 2
const NAN_PREFIX = 0x7FF8  // quiet NaN upper 16 bits

export default () => {
  ctx.memory = true

  // === Pointer helpers (always included with memory) ===

  ctx.stdlib['__mkptr'] = `(func $__mkptr (param $type i32) (param $aux i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64
      (i64.or
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

  // Bump allocator
  ctx.globals.push('(global $__heap (mut i32) (i32.const 1024))')  // start after 1KB reserved

  ctx.stdlib['__alloc'] = `(func $__alloc (param $bytes i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (local.get $ptr))`

  ctx.stdlib['__reset'] = `(func $__reset
    (global.set $__heap (i32.const 1024)))`

  // Always include pointer helpers + allocator when memory is active
  for (const name of ['__mkptr', '__ptr_offset', '__ptr_aux', '__ptr_type', '__alloc', '__reset'])
    ctx.includes.add(name)

  // Export allocator for JS-side use
  ctx.exports['_alloc'] = true
  ctx.exports['_reset'] = true
  // Add allocator as exported funcs
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

  // === Array emitters ===

  // Array literal: [a, b, c] → allocate, fill, return NaN-boxed pointer
  // Emits a (block) that does setup and leaves pointer on stack
  ctx.emit['['] = (...elems) => {
    const len = elems.length
    const t = `__arr${ctx.uid++}`
    ctx.locals.set(t, 'i32')

    const body = [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', len * 8]]],
    ]
    for (let i = 0; i < len; i++) {
      body.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], asF64(emit(elems[i]))])
    }
    // Last expression = block result: NaN-boxed pointer
    body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', len], ['local.get', `$${t}`]])

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // Array index read: arr[i] → extract offset, f64.load
  ctx.emit['[]'] = (arr, idx) => {
    const va = emit(arr), vi = asI32(emit(idx))
    return typed(
      ['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.shl', vi, ['i32.const', 3]]]],
      'f64'
    )
  }

  // Low-level pointer helpers (callable from jz code for interop/testing)
  ctx.emit['__mkptr'] = (t, a, o) => typed(['call', '$__mkptr', asI32(emit(t)), asI32(emit(a)), asI32(emit(o))], 'f64')
  ctx.emit['__ptr_type'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_type', asF64(emit(p))]], 'f64')
  ctx.emit['__ptr_aux'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_aux', asF64(emit(p))]], 'f64')
  ctx.emit['__ptr_offset'] = (p) => typed(['f64.convert_i32_s', ['call', '$__ptr_offset', asF64(emit(p))]], 'f64')
}
