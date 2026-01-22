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
  // First 64KB reserved for instance table (16K instances * 4 bytes)
  // Static data starts at 65536, heap after static data
  // 2 pages minimum (128KB) to fit instance table + static data

  wat += '  (memory (export "_memory") 2)\n'
  const instanceTableEnd = 65536  // 64KB reserved for instance table
  // Calculate where strings end: each string gets 256 bytes
  const stringCount = Object.keys(ctx.strings).length
  const stringsEnd = instanceTableEnd + stringCount * 256
  // Heap starts after strings and static arrays
  const heapStart = Math.max(stringsEnd, ctx.staticOffset || instanceTableEnd, instanceTableEnd)
  wat += `  (global $__heap (mut i32) (i32.const ${heapStart}))\n`

  // === Data segments ===

  // String data (placed after instance table)
  for (const str in ctx.strings) {
    const info = ctx.strings[str]
    const startByte = info.offset * 2
    const endByte = startByte + info.length * 2
    const hex = ctx.stringData.slice(startByte, endByte)
      .map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    const memOffset = instanceTableEnd + info.id * 256
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

  // TypedArray arena initialization (after heap)
  if (ctx.usedTypedArrays) {
    // TypedArray arena starts 1MB after heap start (leaving room for regular heap)
    const typedArenaStart = heapStart + 1048576  // 1MB after heap
    wat += `  ;; TypedArray arena initialization\n`
    wat += `  (func $__init_typed_arena\n`
    wat += `    (global.set $__typed_arena_start (i32.const ${typedArenaStart}))\n`
    wat += `    (global.set $__typed_bump (i32.const ${typedArenaStart})))\n`
    wat += `  (start $__init_typed_arena)\n`
    wat += '  (export "_resetTypedArrays" (func $__reset_typed_arrays))\n'
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

  // === Regex functions ===
  if (ctx.regexFunctions?.length) {
    for (const fn of ctx.regexFunctions) wat += `  ${fn}\n`
  }

  // === User functions ===

  for (const fn of extraFunctions) {
    wat += `  ${fn}\n`
  }

  // === Main function ===
  // Skip main wrapper if 'main' was already generated as a function (e.g., export arrow with closure)
  const mainDef = ctx.functions?.['main']
  const mainAlreadyGenerated = mainDef !== undefined
  const hasMainBody = bodyWat?.trim() && bodyWat.trim() !== '(f64.const 0)'

  if (mainAlreadyGenerated && mainDef.closure) {
    // Main is a closure - generate wrapper that passes stored env
    // The bodyWat should have stored env in __main_env global
    const mainParams = mainDef.params || []
    const paramDecls = mainParams.map(p => `(param $${p} f64)`).join(' ')
    const paramPasses = mainParams.map(p => `(local.get $${p})`).join(' ')
    wat += `\n  (func $main_export (export "main") ${paramDecls} (result f64)\n    (call $main (global.get $__main_env) ${paramPasses})\n  )`
  } else if (!mainAlreadyGenerated && (hasMainBody || extraFunctions.length === 0)) {
    const locals = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
    wat += `\n  (func $main (export "main") (result f64)${locals}\n    ${bodyWat}\n  )`
  }

  // Emit custom section with signatures and schemas for JS interop
  const sigData = { ...ctx.exportSignatures }
  // Add object schemas (Strategy B)
  if (ctx.objectSchemas && Object.keys(ctx.objectSchemas).length > 0) {
    sigData.schemas = ctx.objectSchemas
  }
  if (Object.keys(sigData).length > 0) {
    const sigJson = JSON.stringify(sigData)
    const escaped = sigJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    wat += `\n  (@custom "jz:sig" "${escaped}")`
  }

  return wat + '\n)'
}

/**
 * Emit NaN-boxed pointer helper functions
 *
 * NaN boxing format:
 * - Quiet NaN: 0x7FF8_xxxx_xxxx_xxxx (exponent=0x7FF, bit 51=1, bits 0-50 = payload)
 * - Payload: [type:4][id:16][offset:31] = 51 bits
 *
 * Type meanings:
 * - ARRAY (1): immutable f64 array, id=length
 * - ARRAY_MUT (2): mutable f64 array, id=instanceId (length in instance table)
 * - STRING (3): UTF-16 string, id=length
 * - OBJECT (4): object, id=schemaId
 * - CLOSURE (7): closure, id=funcIdx
 *
 * Benefits:
 * - Full f64 range preserved (any non-NaN value is a number)
 * - 64K schemas, 64K instances, 2GB memory
 *
 * NOTE: All helpers emitted together. DCE (watr) removes unused functions.
 */
function emitMemoryHelpers() {
  return `
  ;; NaN-boxing pointer encoding (v5)
  ;; Format: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
  ;; Payload: [type:4][id:16][offset:31]
  ;; - type: pointer type (1-15)
  ;; - id: len (immutable), instanceId (mutable), schemaId (object), funcIdx (closure)
  ;; - offset: memory byte offset (2GB addressable)

  ;; Instance table for mutable arrays: 4 bytes per entry at fixed offset
  ;; Layout: [len:u16][schemaId:u16]
  ;; Reserved: first 64KB of memory (16K instances * 4 bytes)
  (global $__instance_table_start i32 (i32.const 0))
  (global $__next_instance (mut i32) (i32.const 1))  ;; instance 0 reserved

  ;; Compute capacity tier for given length: nextPow2(max(len, 4))
  (func $__cap_for_len (param $len i32) (result i32)
    (local $cap i32)
    (local.set $cap (select (local.get $len) (i32.const 4) (i32.gt_u (local.get $len) (i32.const 4))))
    (local.set $cap (i32.sub (local.get $cap) (i32.const 1)))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 1))))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 2))))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 4))))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 8))))
    (local.set $cap (i32.or (local.get $cap) (i32.shr_u (local.get $cap) (i32.const 16))))
    (i32.add (local.get $cap) (i32.const 1)))

  ;; Allocate immutable array (type=1, len in pointer)
  (func $__alloc (param $type i32) (param $len i32) (result f64)
    (local $offset i32) (local $size i32) (local $cap i32)
    (local.set $cap (call $__cap_for_len (local.get $len)))
    ;; Size based on type: 8 bytes for f64/object/closure, 2 for string
    (local.set $size
      (i32.shl (local.get $cap)
        (select (i32.const 3)  ;; 8 bytes
          (i32.const 1)  ;; 2 bytes for strings
          (i32.ne (local.get $type) (i32.const 3)))))
    (local.set $size (i32.and (i32.add (local.get $size) (i32.const 7)) (i32.const -8)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $size)))
    (call $__mkptr (local.get $type) (local.get $len) (local.get $offset)))

  ;; Allocate mutable array (type=2, instanceId in pointer, len in table)
  (func $__alloc_mut (param $len i32) (result f64)
    (local $offset i32) (local $size i32) (local $cap i32) (local $id i32)
    (local.set $cap (call $__cap_for_len (local.get $len)))
    (local.set $size (i32.shl (local.get $cap) (i32.const 3)))
    (local.set $size (i32.and (i32.add (local.get $size) (i32.const 7)) (i32.const -8)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $size)))
    ;; Create instance entry
    (local.set $id (global.get $__next_instance))
    (global.set $__next_instance (i32.add (local.get $id) (i32.const 1)))
    ;; Store length in instance table (4 bytes per instance)
    (i32.store16 (i32.shl (local.get $id) (i32.const 2)) (local.get $len))
    (call $__mkptr (i32.const 2) (local.get $id) (local.get $offset)))

  ;; Allocate array with properties (uses ARRAY_MUT type=2 with schemaId > 0)
  ;; Instance table entry: [len:u16, schemaId:u16]
  (func $__alloc_array_props (param $elemLen i32) (param $propCount i32) (param $schemaId i32) (result f64)
    (local $offset i32) (local $size i32) (local $cap i32) (local $id i32) (local $totalLen i32)
    (local.set $totalLen (i32.add (local.get $elemLen) (local.get $propCount)))
    (local.set $cap (call $__cap_for_len (local.get $totalLen)))
    (local.set $size (i32.shl (local.get $cap) (i32.const 3)))
    (local.set $size (i32.and (i32.add (local.get $size) (i32.const 7)) (i32.const -8)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $size)))
    ;; Create instance entry: len in lower 16 bits, schemaId in upper 16 bits
    (local.set $id (global.get $__next_instance))
    (global.set $__next_instance (i32.add (local.get $id) (i32.const 1)))
    (i32.store16 (i32.shl (local.get $id) (i32.const 2)) (local.get $elemLen))
    (i32.store16 (i32.add (i32.shl (local.get $id) (i32.const 2)) (i32.const 2)) (local.get $schemaId))
    (call $__mkptr (i32.const 2) (local.get $id) (local.get $offset)))

  ;; NaN box base: 0x7FF8_0000_0000_0000 (quiet NaN)
  ;; Create NaN-boxed pointer: type * 2^47 + id * 2^31 + offset
  (func $__mkptr (param $type i32) (param $id i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64
      (i64.or (i64.const 0x7FF8000000000000)
        (i64.or
          (i64.shl (i64.extend_i32_u (local.get $type)) (i64.const 47))
          (i64.or
            (i64.shl (i64.extend_i32_u (local.get $id)) (i64.const 31))
            (i64.extend_i32_u (local.get $offset)))))))

  ;; Check if value is a NaN-boxed pointer
  ;; Check if value is a pointer (quiet NaN with non-zero payload)
  ;; Canonical NaN (0x7FF8000000000000) has payload=0, NOT a pointer
  (func $__is_pointer (param $val f64) (result i32)
    (local $bits i64)
    (local.set $bits (i64.reinterpret_f64 (local.get $val)))
    (i32.and
      ;; Has quiet NaN prefix?
      (i64.eq
        (i64.and (local.get $bits) (i64.const 0x7FF8000000000000))
        (i64.const 0x7FF8000000000000))
      ;; Has non-zero payload? (bits 0-50)
      (i64.ne
        (i64.and (local.get $bits) (i64.const 0x0007FFFFFFFFFFFF))
        (i64.const 0))))

  ;; Compare two pointers by bit pattern (NaN === NaN fails with f64.eq)
  (func $__ptr_eq (param $a f64) (param $b f64) (result i32)
    (i64.eq (i64.reinterpret_f64 (local.get $a)) (i64.reinterpret_f64 (local.get $b))))

  ;; Smart f64 comparison: handles both numbers and NaN-boxed pointers
  ;; - If f64.eq returns 1 → equal numbers
  ;; - If both are pointers (quiet NaN with non-zero payload) and bits match → equal
  ;; - Otherwise → not equal (includes NaN == NaN → false per IEEE 754)
  (func $__f64_eq (param $a f64) (param $b f64) (result i32)
    (if (result i32) (f64.eq (local.get $a) (local.get $b))
      (then (i32.const 1))
      (else
        ;; Only compare bits if both are pointers (not canonical NaN)
        (if (result i32) (i32.and (call $__is_pointer (local.get $a)) (call $__is_pointer (local.get $b)))
          (then (i64.eq (i64.reinterpret_f64 (local.get $a)) (i64.reinterpret_f64 (local.get $b))))
          (else (i32.const 0))))))

  ;; Smart f64 inequality: inverse of __f64_eq
  (func $__f64_ne (param $a f64) (param $b f64) (result i32)
    (i32.eqz (call $__f64_eq (local.get $a) (local.get $b))))

  ;; Extract type from pointer (bits 47-50)
  (func $__ptr_type (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 47)))
      (i32.const 0xF)))

  ;; Extract id from pointer (bits 31-46)
  (func $__ptr_id (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 31)))
      (i32.const 0xFFFF)))

  ;; Extract offset from pointer (bits 0-30)
  (func $__ptr_offset (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.reinterpret_f64 (local.get $ptr)))
      (i32.const 0x7FFFFFFF)))

  ;; Get length (type-aware): for immutable types, id IS length; for mutable, lookup table
  (func $__ptr_len (param $ptr f64) (result i32)
    (if (result i32)
      (i32.or
        (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const 1))   ;; ARRAY (immutable)
        (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const 3)))  ;; STRING (immutable)
      (then (call $__ptr_id (local.get $ptr)))  ;; len in pointer
      (else  ;; ARRAY_MUT: len in instance table
        (i32.load16_u (i32.shl (call $__ptr_id (local.get $ptr)) (i32.const 2))))))

  ;; Set length in instance table (for mutable arrays only)
  (func $__ptr_set_len (param $ptr f64) (param $len i32)
    (i32.store16 (i32.shl (call $__ptr_id (local.get $ptr)) (i32.const 2)) (local.get $len)))

  ;; Create new pointer with updated id (for creating new ptr with different len)
  (func $__ptr_with_id (param $ptr f64) (param $id i32) (result f64)
    (call $__mkptr (call $__ptr_type (local.get $ptr)) (local.get $id) (call $__ptr_offset (local.get $ptr))))

  ;; Legacy alias for compatibility
  (func $__ptr_with_len (param $ptr f64) (param $len i32) (result f64)
    (call $__ptr_with_id (local.get $ptr) (local.get $len)))

  ;; Alias for schema (objects use id as schemaId)
  (func $__ptr_schema (param $ptr f64) (result i32)
    (call $__ptr_id (local.get $ptr)))

  ;; Reallocate array to new capacity tier, copy data, return new pointer
  (func $__realloc (param $ptr f64) (param $newLen i32) (result f64)
    (local $oldLen i32) (local $newPtr f64) (local $i i32) (local $oldOff i32) (local $newOff i32) (local $ptrType i32)
    (local.set $oldLen (call $__ptr_len (local.get $ptr)))
    (local.set $ptrType (call $__ptr_type (local.get $ptr)))
    ;; Allocate based on type
    (if (i32.eq (local.get $ptrType) (i32.const 2))
      (then (local.set $newPtr (call $__alloc_mut (local.get $newLen))))
      (else (local.set $newPtr (call $__alloc (local.get $ptrType) (local.get $newLen)))))
    (local.set $oldOff (call $__ptr_offset (local.get $ptr)))
    (local.set $newOff (call $__ptr_offset (local.get $newPtr)))
    ;; Copy old data (f64 array)
    (local.set $i (i32.const 0))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $oldLen)))
      (f64.store
        (i32.add (local.get $newOff) (i32.shl (local.get $i) (i32.const 3)))
        (f64.load (i32.add (local.get $oldOff) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (local.get $newPtr))

  ;; === TypedArray support ===
  ;; Different pointer layout: [type:4][elemType:3][len:22][offset:22]
  ;; Bump allocator in separate region (grows from end of heap area)

  ;; Stride lookup table: [1, 1, 2, 2, 4, 4, 4, 8] for elem types 0-7
  (global $__typed_bump (mut i32) (i32.const 0))  ;; initialized to heap end later

  ;; Allocate TypedArray: bump allocator, returns NaN-boxed pointer
  (func $__alloc_typed (param $elemType i32) (param $len i32) (result f64)
    (local $stride i32) (local $size i32) (local $offset i32)
    ;; stride = [1,1,2,2,4,4,4,8][elemType]
    (local.set $stride
      (i32.load8_u offset=0
        (i32.add (i32.const 0) (local.get $elemType))))  ;; stride table at offset 0
    ;; Fallback if table not initialized: compute stride
    (if (i32.eqz (local.get $stride))
      (then
        (local.set $stride
          (select (i32.const 8)
            (select (i32.const 4)
              (select (i32.const 2)
                (i32.const 1)
                (i32.ge_u (local.get $elemType) (i32.const 2)))
              (i32.ge_u (local.get $elemType) (i32.const 4)))
            (i32.eq (local.get $elemType) (i32.const 7))))))
    (local.set $size (i32.mul (local.get $len) (local.get $stride)))
    ;; Align to 8 bytes
    (local.set $size (i32.and (i32.add (local.get $size) (i32.const 7)) (i32.const -8)))
    ;; Bump allocate
    (local.set $offset (global.get $__typed_bump))
    (global.set $__typed_bump (i32.add (local.get $offset) (local.get $size)))
    ;; Create pointer: type=5, pack elemType/len/offset
    (call $__mkptr_typed (local.get $elemType) (local.get $len) (local.get $offset)))

  ;; Create TypedArray pointer: [type:4][elemType:3][len:22][offset:22]
  ;; Total 51 bits in NaN payload
  (func $__mkptr_typed (param $elemType i32) (param $len i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64
      (i64.or (i64.const 0x7FF8000000000000)
        (i64.or
          (i64.shl (i64.const 5) (i64.const 47))  ;; type = TYPED_ARRAY = 5
          (i64.or
            (i64.shl (i64.extend_i32_u (local.get $elemType)) (i64.const 44))
            (i64.or
              (i64.shl (i64.extend_i32_u (local.get $len)) (i64.const 22))
              (i64.extend_i32_u (local.get $offset))))))))

  ;; Extract elemType (bits 44-46)
  (func $__typed_elemtype (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 44)))
      (i32.const 0x7)))

  ;; Extract len (bits 22-43)
  (func $__typed_len (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 22)))
      (i32.const 0x3FFFFF)))

  ;; Extract offset (bits 0-21)
  (func $__typed_offset (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.reinterpret_f64 (local.get $ptr)))
      (i32.const 0x3FFFFF)))

  ;; Create TypedArray pointer without allocation (for subarray/filter views)
  (func $__mk_typed_ptr (param $elemType i32) (param $len i32) (param $offset i32) (result f64)
    (call $__mkptr_typed (local.get $elemType) (local.get $len) (local.get $offset)))

  ;; Reset typed array arena (call between frames/batches)
  (func $__reset_typed_arrays
    (global.set $__typed_bump (global.get $__typed_arena_start)))
  (global $__typed_arena_start (mut i32) (i32.const 0))
`
}

/**
 * Emit GC conversion helpers for export wrappers
* Uses $v temp local to work around watr bug (can't have f64.load directly in array.set)
 * NOTE: Kept for potential future use, but currently JS wrapper handles conversion.
 */
// function emitGcConversionHelpers() { ... } - removed, JS wrapper handles this
// function emitExportWrappers(ctx) { ... } - removed, JS wrapper handles this
