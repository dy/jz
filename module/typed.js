/**
 * TypedArray module — Float64Array, Float32Array, Int32Array, etc.
 *
 * Type=3 (TYPED): aux=elemType (3 bits), length in memory header [-8:len][-4:cap].
 *
 * @module typed
 */

import { emit, typed, asI32 } from '../src/compile.js'
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

  // .length handled by ptr.js's __len (reads from memory header [-8:len])
  // TypedArray-aware indexing: TODO type-aware load/store dispatch
}
