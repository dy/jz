/**
 * WAT module assembly for jz compiler
 *
 * Generates complete WAT module text from compiled code,
 * including types, memory, data segments, and functions.
 */

import { CONSTANTS, FUNCTIONS, DEPS } from './stdlib.js'

/**
 * Assemble a complete WAT module
 *
 * @param {string} bodyWat - Main function body WAT code
 * @param {Object} ctx - Compilation context
 * @param {string[]} extraFunctions - Additional function definitions
 * @returns {string} - Complete WAT module text
 */
export function assemble(bodyWat, ctx = {
  usedArrayType: false, usedStringType: false, usedMemory: false, usedStdlib: [],
  localDecls: [], functions: {}, globals: {}, strings: {}, stringData: [],
  staticArrays: {}, arrayDataOffset: 0
}, extraFunctions = []) {
  let wat = '(module\n'

  // === Type definitions ===

  // Function types for closure calls (memory-based closures)
  if (ctx.usedFuncTypes?.size > 0) {
    for (const arity of ctx.usedFuncTypes) {
      const params = '(param f64)' + ' (param f64)'.repeat(arity)  // env + params
      wat += `  (type $fntype${arity} (func ${params} (result f64)))\n`
    }
  }

  // Function table for closure calls
  if (ctx.usedFuncTable && ctx.funcTableEntries.length > 0) {
    const tableSize = ctx.funcTableEntries.length
    wat += `  (table $fntable ${tableSize} funcref)\n`
    const elems = ctx.funcTableEntries.map(name => `$${name}`).join(' ')
    wat += `  (elem (i32.const 0) func ${elems})\n`
  }

  // === Memory ===

  wat += '  (memory (export "_memory") 1)\n'
  const heapStart = ctx.staticOffset || 1024
  wat += `  (global $__heap (mut i32) (i32.const ${heapStart}))\n`

  // === Data segments ===

  // String data
  for (const str in ctx.strings) {
    const info = ctx.strings[str]
    const startByte = info.offset * 2
    const endByte = startByte + info.length * 2
    const hex = ctx.stringData.slice(startByte, endByte)
      .map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    const memOffset = info.id * 256
    wat += `  (data (i32.const ${memOffset}) "${hex}")\n`
  }

  // Static array data - pure data, no header
  for (const key in ctx.staticArrays) {
    const { offset, values } = ctx.staticArrays[key]
    let hex = ''
    for (const val of values) {
      const f64bytes = new Float64Array([val])
      const bytes = new Uint8Array(f64bytes.buffer)
      hex += Array.from(bytes).map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    }
    if (hex) wat += `  (data (i32.const ${offset}) "${hex}")\n`
  }

  // === Memory helper functions ===

  if (ctx.usedMemory) {
    wat += emitMemoryHelpers()
    wat += '  (export "_alloc" (func $__alloc))\n'
  }

  // === Stdlib functions ===

  const included = {}
  function include(name) {
    if (name in included) return
    included[name] = true
    for (const dep of DEPS[name] || []) include(dep)
    if (FUNCTIONS[name]) wat += `  ${FUNCTIONS[name]}\n`
  }
  if (ctx.usedStdlib.length > 0) {
    wat += CONSTANTS
    for (const name of ctx.usedStdlib) include(name)
  }

  // === Globals ===

  for (const name in ctx.globals) {
    wat += `  (global $${name} (mut f64) ${ctx.globals[name].init})\n`
  }

  // === Built-in functions ===

  wat += `  (func $die (result f64) (unreachable))\n`
  wat += `  (func $f64.rem (param f64 f64) (result f64)\n`
  wat += `    (f64.sub (local.get 0) (f64.mul (f64.trunc (f64.div (local.get 0) (local.get 1))) (local.get 1))))\n`

  // === User functions ===

  for (const fn of extraFunctions) {
    wat += `  ${fn}\n`
  }

  // === Main function ===

  const hasMainBody = bodyWat?.trim() && bodyWat.trim() !== '(f64.const 0)'
  if (hasMainBody || extraFunctions.length === 0) {
    const locals = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
    wat += `\n  (func $main (export "main") (result f64)${locals}\n    ${bodyWat}\n  )`
  }

  // Emit custom section with export signatures for JS interop
  if (ctx.exportSignatures && Object.keys(ctx.exportSignatures).length > 0) {
    const sigJson = JSON.stringify(ctx.exportSignatures)
    const escaped = sigJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    wat += `\n  (@custom "jz:sig" "${escaped}")`
  }

  return wat + '\n)'
}

/**
 * Emit integer-packed pointer helper functions for gc:false mode
 *
 * Headerless array layout:
 * - Pointer: type * 2^48 + len * 2^32 + offset (pure integer, no NaN)
 * - Memory: pure data at offset, no header
 * - Capacity: implicit from length tier (nextPow2)
 * - Threshold: values >= 2^48 are pointers, below are regular numbers
 *
 * NOTE: All helpers emitted together. DCE (watr) removes unused functions.
 */
function emitMemoryHelpers() {
  return `
  ;; Integer-packed pointer encoding (headerless v3)
  ;; Format: ptr = type * 2^48 + len * 2^32 + offset
  ;; Layout: [type:16][len:16][offset:32] = 64 bits as f64 integer
  ;; Memory layout: [data...] - pure data, no header
  ;; Capacity is implicit: nextPow2(max(len, 4))
  ;; Threshold: 2^48 - values above are pointers, below are numbers

  ;; Compute capacity tier for given length: nextPow2(max(len, 4))
  (func $__cap_for_len (param $len i32) (result i32)
    (local $cap i32)
    (local.set $cap (select (local.get $len) (i32.const 4) (i32.gt_u (local.get $len) (i32.const 4))))
    ;; Round up to next power of 2
    (local.set $cap (i32.sub (local.get $cap) (i32.const 1)))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 1))))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 2))))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 4))))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 8))))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 16))))
    (i32.add (local.get $cap) (i32.const 1)))

  ;; Allocate memory for given length, using capacity tier
  (func $__alloc (param $type i32) (param $len i32) (result f64)
    (local $offset i32) (local $size i32) (local $cap i32)
    ;; Get capacity tier
    (local.set $cap (call $__cap_for_len (local.get $len)))
    ;; Calculate data size based on type and capacity
    (local.set $size
      (i32.shl (local.get $cap)
        (select (i32.const 3)  ;; 8 bytes for f64 arrays, objects, ref arrays, closures
          (select (i32.const 2)  ;; 4 bytes for i32 arrays, 2 for strings
            (i32.const 0)  ;; 1 byte for i8 arrays
            (i32.or (i32.eq (local.get $type) (i32.const 2)) (i32.eq (local.get $type) (i32.const 3))))
          (i32.or (i32.eq (local.get $type) (i32.const 1)) (i32.ge_u (local.get $type) (i32.const 5))))))
    ;; Align to 8 bytes
    (local.set $size (i32.and (i32.add (local.get $size) (i32.const 7)) (i32.const -8)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $size)))
    (call $__mkptr (local.get $type) (local.get $len) (local.get $offset)))

  ;; Create integer-packed pointer: type * 2^48 + len * 2^32 + offset
  (func $__mkptr (param $type i32) (param $len i32) (param $offset i32) (result f64)
    (f64.convert_i64_u
      (i64.or
        (i64.or
          (i64.shl (i64.extend_i32_u (local.get $type)) (i64.const 48))
          (i64.shl (i64.extend_i32_u (local.get $len)) (i64.const 32)))
        (i64.extend_i32_u (local.get $offset)))))

  ;; Check if value is a pointer (>= 2^48 threshold AND finite)
  ;; Must exclude Infinity/-Infinity which are >= threshold but not pointers
  (func $__is_pointer (param $val f64) (result i32)
    (i32.and
      (f64.ge (local.get $val) (f64.const 281474976710656))
      (f64.lt (local.get $val) (f64.const inf))))

  ;; Extract offset from pointer (lower 32 bits)
  (func $__ptr_offset (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.trunc_f64_u (local.get $ptr))))

  ;; Extract length from pointer (bits 32-47)
  (func $__ptr_len (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u (i64.trunc_f64_u (local.get $ptr)) (i64.const 32)))
      (i32.const 0xFFFF)))

  ;; Create new pointer with updated length (same type and offset)
  (func $__ptr_with_len (param $ptr f64) (param $len i32) (result f64)
    (call $__mkptr (call $__ptr_type (local.get $ptr)) (local.get $len) (call $__ptr_offset (local.get $ptr))))

  ;; Extract type from pointer (bits 48-63)
  (func $__ptr_type (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.shr_u (i64.trunc_f64_u (local.get $ptr)) (i64.const 48))))

  ;; Reallocate array to new capacity tier, copy data, return new pointer
  (func $__realloc (param $ptr f64) (param $newLen i32) (result f64)
    (local $oldLen i32) (local $newPtr f64) (local $i i32) (local $oldOff i32) (local $newOff i32)
    (local.set $oldLen (call $__ptr_len (local.get $ptr)))
    (local.set $newPtr (call $__alloc (call $__ptr_type (local.get $ptr)) (local.get $newLen)))
    (local.set $oldOff (call $__ptr_offset (local.get $ptr)))
    (local.set $newOff (call $__ptr_offset (local.get $newPtr)))
    ;; Copy old data (assuming f64 array for now)
    (local.set $i (i32.const 0))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $oldLen)))
      (f64.store
        (i32.add (local.get $newOff) (i32.shl (local.get $i) (i32.const 3)))
        (f64.load (i32.add (local.get $oldOff) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (local.get $newPtr))
`
}

/**
 * Emit GC conversion helpers for export wrappers
* Uses $v temp local to work around watr bug (can't have f64.load directly in array.set)
 * NOTE: Kept for potential future use, but currently JS wrapper handles conversion.
 */
// function emitGcConversionHelpers() { ... } - removed, JS wrapper handles this
// function emitExportWrappers(ctx) { ... } - removed, JS wrapper handles this
