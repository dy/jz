/**
 * Binary module - TypedArray utilities
 *
 * Handles Float32Array, Float64Array, Int8Array, Int16Array, Int32Array,
 * Uint8Array, Uint16Array, Uint8ClampedArray operations.
 *
 * TypedArrays are stored as NaN-boxed pointers with type info:
 * - Float64Array: 8 bytes per element
 * - Float32Array: 4 bytes per element
 * - Int32Array/Uint32Array: 4 bytes per element
 * - Int16Array/Uint16Array: 2 bytes per element
 * - Int8Array/Uint8Array/Uint8ClampedArray: 1 byte per element
 *
 * @module binary
 */

import { emit } from '../src/compile.js'

// TypedArray element sizes in bytes
const ELEMENT_SIZES = {
  Float64Array: 8,
  Float32Array: 4,
  Int32Array: 4,
  Uint32Array: 4,
  Int16Array: 2,
  Uint16Array: 2,
  Int8Array: 1,
  Uint8Array: 1,
  Uint8ClampedArray: 1
}

// TypedArray type IDs (used in NaN-boxing)
const TYPE_IDS = {
  Float64Array: 0,
  Float32Array: 1,
  Int32Array: 2,
  Uint32Array: 3,
  Int16Array: 4,
  Uint16Array: 5,
  Int8Array: 6,
  Uint8Array: 7,
  Uint8ClampedArray: 8
}

export default (ctx) => {
  // ============================================
  // TypedArray constructors
  // ============================================

  // Float64Array - 8 bytes per element
  ctx.emit['binary.Float64Array.new'] = (len) => (
    ctx.includes.add('binary.Float64Array.new'),
    ['call', '$binary.Float64Array.new', emit(len)]
  )

  ctx.emit['binary.Float64Array.get'] = (arr, idx) => (
    ctx.includes.add('binary.Float64Array.get'),
    ['call', '$binary.Float64Array.get', emit(arr), emit(idx)]
  )

  ctx.emit['binary.Float64Array.set'] = (arr, idx, val) => (
    ctx.includes.add('binary.Float64Array.set'),
    ['call', '$binary.Float64Array.set', emit(arr), emit(idx), emit(val)]
  )

  // Float32Array - 4 bytes per element
  ctx.emit['binary.Float32Array.new'] = (len) => (
    ctx.includes.add('binary.Float32Array.new'),
    ['call', '$binary.Float32Array.new', emit(len)]
  )

  ctx.emit['binary.Float32Array.get'] = (arr, idx) => (
    ctx.includes.add('binary.Float32Array.get'),
    ['call', '$binary.Float32Array.get', emit(arr), emit(idx)]
  )

  ctx.emit['binary.Float32Array.set'] = (arr, idx, val) => (
    ctx.includes.add('binary.Float32Array.set'),
    ['call', '$binary.Float32Array.set', emit(arr), emit(idx), emit(val)]
  )

  // Int32Array - 4 bytes per element, signed
  ctx.emit['binary.Int32Array.new'] = (len) => (
    ctx.includes.add('binary.Int32Array.new'),
    ['call', '$binary.Int32Array.new', emit(len)]
  )

  ctx.emit['binary.Int32Array.get'] = (arr, idx) => (
    ctx.includes.add('binary.Int32Array.get'),
    ['call', '$binary.Int32Array.get', emit(arr), emit(idx)]
  )

  ctx.emit['binary.Int32Array.set'] = (arr, idx, val) => (
    ctx.includes.add('binary.Int32Array.set'),
    ['call', '$binary.Int32Array.set', emit(arr), emit(idx), emit(val)]
  )

  // Uint32Array - 4 bytes per element, unsigned
  ctx.emit['binary.Uint32Array.new'] = (len) => (
    ctx.includes.add('binary.Uint32Array.new'),
    ['call', '$binary.Uint32Array.new', emit(len)]
  )

  ctx.emit['binary.Uint32Array.get'] = (arr, idx) => (
    ctx.includes.add('binary.Uint32Array.get'),
    ['call', '$binary.Uint32Array.get', emit(arr), emit(idx)]
  )

  ctx.emit['binary.Uint32Array.set'] = (arr, idx, val) => (
    ctx.includes.add('binary.Uint32Array.set'),
    ['call', '$binary.Uint32Array.set', emit(arr), emit(idx), emit(val)]
  )

  // Int16Array - 2 bytes per element, signed
  ctx.emit['binary.Int16Array.new'] = (len) => (
    ctx.includes.add('binary.Int16Array.new'),
    ['call', '$binary.Int16Array.new', emit(len)]
  )

  ctx.emit['binary.Int16Array.get'] = (arr, idx) => (
    ctx.includes.add('binary.Int16Array.get'),
    ['call', '$binary.Int16Array.get', emit(arr), emit(idx)]
  )

  ctx.emit['binary.Int16Array.set'] = (arr, idx, val) => (
    ctx.includes.add('binary.Int16Array.set'),
    ['call', '$binary.Int16Array.set', emit(arr), emit(idx), emit(val)]
  )

  // Uint16Array - 2 bytes per element, unsigned
  ctx.emit['binary.Uint16Array.new'] = (len) => (
    ctx.includes.add('binary.Uint16Array.new'),
    ['call', '$binary.Uint16Array.new', emit(len)]
  )

  ctx.emit['binary.Uint16Array.get'] = (arr, idx) => (
    ctx.includes.add('binary.Uint16Array.get'),
    ['call', '$binary.Uint16Array.get', emit(arr), emit(idx)]
  )

  ctx.emit['binary.Uint16Array.set'] = (arr, idx, val) => (
    ctx.includes.add('binary.Uint16Array.set'),
    ['call', '$binary.Uint16Array.set', emit(arr), emit(idx), emit(val)]
  )

  // Int8Array - 1 byte per element, signed
  ctx.emit['binary.Int8Array.new'] = (len) => (
    ctx.includes.add('binary.Int8Array.new'),
    ['call', '$binary.Int8Array.new', emit(len)]
  )

  ctx.emit['binary.Int8Array.get'] = (arr, idx) => (
    ctx.includes.add('binary.Int8Array.get'),
    ['call', '$binary.Int8Array.get', emit(arr), emit(idx)]
  )

  ctx.emit['binary.Int8Array.set'] = (arr, idx, val) => (
    ctx.includes.add('binary.Int8Array.set'),
    ['call', '$binary.Int8Array.set', emit(arr), emit(idx), emit(val)]
  )

  // Uint8Array - 1 byte per element, unsigned
  ctx.emit['binary.Uint8Array.new'] = (len) => (
    ctx.includes.add('binary.Uint8Array.new'),
    ['call', '$binary.Uint8Array.new', emit(len)]
  )

  ctx.emit['binary.Uint8Array.get'] = (arr, idx) => (
    ctx.includes.add('binary.Uint8Array.get'),
    ['call', '$binary.Uint8Array.get', emit(arr), emit(idx)]
  )

  ctx.emit['binary.Uint8Array.set'] = (arr, idx, val) => (
    ctx.includes.add('binary.Uint8Array.set'),
    ['call', '$binary.Uint8Array.set', emit(arr), emit(idx), emit(val)]
  )

  // Uint8ClampedArray - 1 byte per element, clamped to 0-255
  ctx.emit['binary.Uint8ClampedArray.new'] = (len) => (
    ctx.includes.add('binary.Uint8ClampedArray.new'),
    ['call', '$binary.Uint8ClampedArray.new', emit(len)]
  )

  ctx.emit['binary.Uint8ClampedArray.get'] = (arr, idx) => (
    ctx.includes.add('binary.Uint8ClampedArray.get'),
    ['call', '$binary.Uint8ClampedArray.get', emit(arr), emit(idx)]
  )

  ctx.emit['binary.Uint8ClampedArray.set'] = (arr, idx, val) => (
    ctx.includes.add('binary.Uint8ClampedArray.set'),
    ['call', '$binary.Uint8ClampedArray.set', emit(arr), emit(idx), emit(val)]
  )

  // ============================================
  // Common utilities
  // ============================================

  ctx.emit['binary.byteLength'] = (arr) => (
    ctx.includes.add('binary.byteLength'),
    ['call', '$binary.byteLength', emit(arr)]
  )

  ctx.emit['binary.length'] = (arr) => (
    ctx.includes.add('binary.length'),
    ['call', '$binary.length', emit(arr)]
  )

  // ============================================
  // WAT stdlib implementations
  // ============================================

  // Float64Array - 8 bytes per element
  ctx.stdlib['binary.Float64Array.new'] = `(func $binary.Float64Array.new (param $len i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (local.set $bytes (i32.shl (local.get $len) (i32.const 3)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (local.get $offset) (i32.const 0) (local.get $bytes))
    (call $__mkptr (i32.const 5) (local.get $len) (local.get $offset)))`

  ctx.stdlib['binary.Float64Array.get'] = `(func $binary.Float64Array.get (param $arr f64) (param $idx i32) (result f64)
    (f64.load (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 3)))))`

  ctx.stdlib['binary.Float64Array.set'] = `(func $binary.Float64Array.set (param $arr f64) (param $idx i32) (param $val f64) (result f64)
    (f64.store (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 3))) (local.get $val))
    (local.get $val))`

  // Float32Array - 4 bytes per element
  ctx.stdlib['binary.Float32Array.new'] = `(func $binary.Float32Array.new (param $len i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (local.set $bytes (i32.shl (local.get $len) (i32.const 2)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (local.get $offset) (i32.const 0) (local.get $bytes))
    (call $__mkptr (i32.const 6) (local.get $len) (local.get $offset)))`

  ctx.stdlib['binary.Float32Array.get'] = `(func $binary.Float32Array.get (param $arr f64) (param $idx i32) (result f64)
    (f64.promote_f32 (f32.load (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 2))))))`

  ctx.stdlib['binary.Float32Array.set'] = `(func $binary.Float32Array.set (param $arr f64) (param $idx i32) (param $val f64) (result f64)
    (f32.store (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 2))) (f32.demote_f64 (local.get $val)))
    (local.get $val))`

  // Int32Array - 4 bytes per element, signed
  ctx.stdlib['binary.Int32Array.new'] = `(func $binary.Int32Array.new (param $len i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (local.set $bytes (i32.shl (local.get $len) (i32.const 2)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (local.get $offset) (i32.const 0) (local.get $bytes))
    (call $__mkptr (i32.const 7) (local.get $len) (local.get $offset)))`

  ctx.stdlib['binary.Int32Array.get'] = `(func $binary.Int32Array.get (param $arr f64) (param $idx i32) (result f64)
    (f64.convert_i32_s (i32.load (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 2))))))`

  ctx.stdlib['binary.Int32Array.set'] = `(func $binary.Int32Array.set (param $arr f64) (param $idx i32) (param $val f64) (result f64)
    (i32.store (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 2))) (i32.trunc_f64_s (local.get $val)))
    (local.get $val))`

  // Uint32Array - 4 bytes per element, unsigned
  ctx.stdlib['binary.Uint32Array.new'] = `(func $binary.Uint32Array.new (param $len i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (local.set $bytes (i32.shl (local.get $len) (i32.const 2)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (local.get $offset) (i32.const 0) (local.get $bytes))
    (call $__mkptr (i32.const 8) (local.get $len) (local.get $offset)))`

  ctx.stdlib['binary.Uint32Array.get'] = `(func $binary.Uint32Array.get (param $arr f64) (param $idx i32) (result f64)
    (f64.convert_i32_u (i32.load (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 2))))))`

  ctx.stdlib['binary.Uint32Array.set'] = `(func $binary.Uint32Array.set (param $arr f64) (param $idx i32) (param $val f64) (result f64)
    (i32.store (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 2))) (i32.trunc_f64_u (local.get $val)))
    (local.get $val))`

  // Int16Array - 2 bytes per element, signed
  ctx.stdlib['binary.Int16Array.new'] = `(func $binary.Int16Array.new (param $len i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (local.set $bytes (i32.shl (local.get $len) (i32.const 1)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (local.get $offset) (i32.const 0) (local.get $bytes))
    (call $__mkptr (i32.const 9) (local.get $len) (local.get $offset)))`

  ctx.stdlib['binary.Int16Array.get'] = `(func $binary.Int16Array.get (param $arr f64) (param $idx i32) (result f64)
    (f64.convert_i32_s (i32.extend16_s (i32.load16_u (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 1)))))))`

  ctx.stdlib['binary.Int16Array.set'] = `(func $binary.Int16Array.set (param $arr f64) (param $idx i32) (param $val f64) (result f64)
    (i32.store16 (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 1))) (i32.trunc_f64_s (local.get $val)))
    (local.get $val))`

  // Uint16Array - 2 bytes per element, unsigned
  ctx.stdlib['binary.Uint16Array.new'] = `(func $binary.Uint16Array.new (param $len i32) (result f64)
    (local $offset i32) (local $bytes i32)
    (local.set $bytes (i32.shl (local.get $len) (i32.const 1)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $bytes)))
    (memory.fill (local.get $offset) (i32.const 0) (local.get $bytes))
    (call $__mkptr (i32.const 10) (local.get $len) (local.get $offset)))`

  ctx.stdlib['binary.Uint16Array.get'] = `(func $binary.Uint16Array.get (param $arr f64) (param $idx i32) (result f64)
    (f64.convert_i32_u (i32.load16_u (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 1))))))`

  ctx.stdlib['binary.Uint16Array.set'] = `(func $binary.Uint16Array.set (param $arr f64) (param $idx i32) (param $val f64) (result f64)
    (i32.store16 (i32.add (call $__ptr_offset (local.get $arr)) (i32.shl (local.get $idx) (i32.const 1))) (i32.trunc_f64_u (local.get $val)))
    (local.get $val))`

  // Int8Array - 1 byte per element, signed
  ctx.stdlib['binary.Int8Array.new'] = `(func $binary.Int8Array.new (param $len i32) (result f64)
    (local $offset i32)
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $len)))
    (memory.fill (local.get $offset) (i32.const 0) (local.get $len))
    (call $__mkptr (i32.const 11) (local.get $len) (local.get $offset)))`

  ctx.stdlib['binary.Int8Array.get'] = `(func $binary.Int8Array.get (param $arr f64) (param $idx i32) (result f64)
    (f64.convert_i32_s (i32.extend8_s (i32.load8_u (i32.add (call $__ptr_offset (local.get $arr)) (local.get $idx))))))`

  ctx.stdlib['binary.Int8Array.set'] = `(func $binary.Int8Array.set (param $arr f64) (param $idx i32) (param $val f64) (result f64)
    (i32.store8 (i32.add (call $__ptr_offset (local.get $arr)) (local.get $idx)) (i32.trunc_f64_s (local.get $val)))
    (local.get $val))`

  // Uint8Array - 1 byte per element, unsigned
  ctx.stdlib['binary.Uint8Array.new'] = `(func $binary.Uint8Array.new (param $len i32) (result f64)
    (local $offset i32)
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $len)))
    (memory.fill (local.get $offset) (i32.const 0) (local.get $len))
    (call $__mkptr (i32.const 12) (local.get $len) (local.get $offset)))`

  ctx.stdlib['binary.Uint8Array.get'] = `(func $binary.Uint8Array.get (param $arr f64) (param $idx i32) (result f64)
    (f64.convert_i32_u (i32.load8_u (i32.add (call $__ptr_offset (local.get $arr)) (local.get $idx)))))`

  ctx.stdlib['binary.Uint8Array.set'] = `(func $binary.Uint8Array.set (param $arr f64) (param $idx i32) (param $val f64) (result f64)
    (i32.store8 (i32.add (call $__ptr_offset (local.get $arr)) (local.get $idx)) (i32.trunc_f64_u (local.get $val)))
    (local.get $val))`

  // Uint8ClampedArray - 1 byte per element, clamped 0-255
  ctx.stdlib['binary.Uint8ClampedArray.new'] = `(func $binary.Uint8ClampedArray.new (param $len i32) (result f64)
    (local $offset i32)
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $len)))
    (memory.fill (local.get $offset) (i32.const 0) (local.get $len))
    (call $__mkptr (i32.const 13) (local.get $len) (local.get $offset)))`

  ctx.stdlib['binary.Uint8ClampedArray.get'] = `(func $binary.Uint8ClampedArray.get (param $arr f64) (param $idx i32) (result f64)
    (f64.convert_i32_u (i32.load8_u (i32.add (call $__ptr_offset (local.get $arr)) (local.get $idx)))))`

  ctx.stdlib['binary.Uint8ClampedArray.set'] = `(func $binary.Uint8ClampedArray.set (param $arr f64) (param $idx i32) (param $val f64) (result f64)
    (local $clamped i32)
    (local.set $clamped (i32.trunc_f64_s (local.get $val)))
    (if (i32.lt_s (local.get $clamped) (i32.const 0))
      (then (local.set $clamped (i32.const 0))))
    (if (i32.gt_s (local.get $clamped) (i32.const 255))
      (then (local.set $clamped (i32.const 255))))
    (i32.store8 (i32.add (call $__ptr_offset (local.get $arr)) (local.get $idx)) (local.get $clamped))
    (local.get $val))`

  // Common utilities
  ctx.stdlib['binary.length'] = `(func $binary.length (param $arr f64) (result i32)
    (call $__ptr_len (local.get $arr)))`

  ctx.stdlib['binary.byteLength'] = `(func $binary.byteLength (param $arr f64) (result i32)
    ;; TODO: Multiply length by element size based on type
    ;; For now, just return length (works for byte arrays)
    (call $__ptr_len (local.get $arr)))`
}
