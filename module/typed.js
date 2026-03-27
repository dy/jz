/**
 * TypedArray module — Float64Array, Float32Array, Int32Array, etc.
 *
 * Type=3 (TYPED): elem type in lower 3 bits of aux, length in upper 12 bits.
 * aux = (len << 3) | elemType. Max length: 4095 elements.
 *
 * @module typed
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const TYPED = 3

// Element types and their byte sizes
const ELEM = {
  Int8Array: 0, Uint8Array: 1,
  Int16Array: 2, Uint16Array: 3,
  Int32Array: 4, Uint32Array: 5,
  Float32Array: 6, Float64Array: 7,
}
const STRIDE = [1, 1, 2, 2, 4, 4, 4, 8]
const LOAD = [
  'i32.load8_s', 'i32.load8_u',
  'i32.load16_s', 'i32.load16_u',
  'i32.load', 'i32.load',
  'f32.load', 'f64.load',
]
const STORE = [
  'i32.store8', 'i32.store8',
  'i32.store16', 'i32.store16',
  'i32.store', 'i32.store',
  'f32.store', 'f64.store',
]

// Shift amounts for index → byte offset
const SHIFT = [0, 0, 1, 1, 2, 2, 2, 3]

export default () => {
  // Constructor: new Float64Array(len)
  for (const [name, elemType] of Object.entries(ELEM)) {
    const stride = STRIDE[elemType]
    ctx.emit[`new.${name}`] = (lenExpr) => {
      const len = asI32(emit(lenExpr))
      const t = `__ta${ctx.uid++}`
      ctx.locals.set(t, 'i32')
      // Header: [-8:len(i32)][-4:cap(i32)][data...]. aux=elemType only.
      return typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.mul', len, ['i32.const', stride]]]]],
        ['i32.store', ['local.get', `$${t}`], len],  // len
        ['i32.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]], len],  // cap
        ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 8]]],  // skip header
        ['call', '$__mkptr', ['i32.const', TYPED], ['i32.const', elemType], ['local.get', `$${t}`]]], 'f64')
    }
  }

  // TypedArray-aware indexing is handled by array module's [] emitter
  // (which uses f64.load — works for Float64Array but not for other types)
  // TODO: type-aware load/store dispatch based on ptr_type + elem type

  // .length for typed arrays: extract from aux (len = aux >> 3)
  // Already handled by ptr module's .length emitter (ptr_aux), but we pack len<<3|elem
  // So we need a typed-array-specific length: aux >> 3

  // Register typed-array .length override
  ctx.stdlib['__typed_len'] = `(func $__typed_len (param $ptr f64) (result i32)
    (i32.shr_u (call $__ptr_aux (local.get $ptr)) (i32.const 3)))`
  ctx.includes.add('__typed_len')
}
