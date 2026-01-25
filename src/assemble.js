/**
 * WAT module assembly for jz compiler
 *
 * Generates complete WAT module text from compiled code,
 * including types, memory, data segments, and functions.
 */

import { CONSTANTS, FUNCTIONS, DEPS } from './stdlib.js'
import { HEAP_START, STRING_STRIDE } from './types.js'

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

  // Exception tag for try/catch/throw
  if (ctx.usedException) {
    wat += `  (tag $__error (param f64))\n`
  }

  // Function table for closure calls
  if (ctx.usedFuncTable && ctx.funcTableEntries.length > 0) {
    const tableSize = ctx.funcTableEntries.length
    wat += `  (table $fntable ${tableSize} funcref)\n`
    const elems = ctx.funcTableEntries.map(name => `$${name}`).join(' ')
    wat += `  (elem (i32.const 0) func ${elems})\n`
  }

  // === Memory ===
  // Static data starts at HEAP_START (0), heap after static data
  // Use more memory when TypedArrays are used (arena at 1MB)
  const memPages = ctx.usedTypedArrays ? 32 : 2  // 2MB or 128KB
  wat += `  (memory (export "_memory") ${memPages})\n`
  // Calculate where strings end: each string gets STRING_STRIDE bytes
  const stringCount = Object.keys(ctx.strings).length
  const stringsEnd = HEAP_START + stringCount * STRING_STRIDE
  // Heap starts after strings and static arrays
  const heapStart = Math.max(stringsEnd, ctx.staticOffset || HEAP_START, HEAP_START)
  wat += `  (global $__heap (mut i32) (i32.const ${heapStart}))\n`
  wat += `  (global $__heap_start (i32) (i32.const ${heapStart}))\n`

  // === Data segments ===

  // String data - with length header [length:i32][chars:u16...]
  // Memory layout: offset-8 = len (for __ptr_len), offset = char data
  for (const str in ctx.strings) {
    const info = ctx.strings[str]
    const startByte = info.offset * 2
    const endByte = startByte + info.length * 2
    const charHex = ctx.stringData.slice(startByte, endByte)
      .map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    const memOffset = HEAP_START + info.id * STRING_STRIDE
    // Write length header as i32 (4 bytes, padded to 8 for alignment)
    const lenBytes = new Uint32Array([info.length])
    const lenHex = Array.from(new Uint8Array(lenBytes.buffer))
      .map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    // Data segment: [len:i32 + 4 bytes padding][chars:u16...]
    // Store at memOffset, data starts at memOffset+8
    wat += `  (data (i32.const ${memOffset}) "${lenHex}\\00\\00\\00\\00${charHex}")\n`
    // Update info.dataOffset for use in mkString
    info.dataOffset = memOffset + 8
  }

  // Static array data - with C-style header [length:f64][elements...]
  for (const key in ctx.staticArrays) {
    const { offset, values, headerSize } = ctx.staticArrays[key]
    let hex = ''
    // First write length as f64 (header)
    if (headerSize) {
      const lenBytes = new Float64Array([values.length])
      const bytes = new Uint8Array(lenBytes.buffer)
      hex += Array.from(bytes).map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    }
    // Then write element data
    for (const val of values) {
      const f64bytes = new Float64Array([val])
      const bytes = new Uint8Array(f64bytes.buffer)
      hex += Array.from(bytes).map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    }
    if (hex) wat += `  (data (i32.const ${offset}) "${hex}")\n`
  }

  // Static object data - same format as arrays (f64 values)
  for (const key in ctx.staticObjects) {
    const { offset, values } = ctx.staticObjects[key]
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
    // Reset heap to initial state (call between independent computations)
    wat += '  (func $__reset_heap (global.set $__heap (global.get $__heap_start)))\n'
    wat += '  (export "_resetHeap" (func $__reset_heap))\n'
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

  const included = Object.create(null)  // No prototype - avoids toString/valueOf collision
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

  // === numToString static strings ===
  // Add globals and data for special number string representations
  const needsNumStrGlobals = ctx.usedStdlib.includes('numToString') ||
                              ctx.usedStdlib.includes('toFixed') ||
                              ctx.usedStdlib.includes('toString') ||
                              ctx.usedStdlib.includes('toExponential') ||
                              ctx.usedStdlib.includes('toPrecision')
  if (needsNumStrGlobals) {
    // These are placed at fixed offsets after heap start for simplicity
    // NaN: 4 chars, Infinity: 8 chars, -Infinity: 9 chars
    const nanOffset = heapStart
    const infOffset = heapStart + 16  // 4*2 bytes + padding
    const negInfOffset = heapStart + 40  // 8*2 bytes + padding
    // UTF-16 encoded strings
    wat += `  (data (i32.const ${nanOffset}) "N\\00a\\00N\\00\\00\\00")\n`  // "NaN"
    wat += `  (data (i32.const ${infOffset}) "I\\00n\\00f\\00i\\00n\\00i\\00t\\00y\\00")\n`  // "Infinity"
    wat += `  (data (i32.const ${negInfOffset}) "-\\00I\\00n\\00f\\00i\\00n\\00i\\00t\\00y\\00")\n`  // "-Infinity"
    wat += `  (global $__strNaN i32 (i32.const ${nanOffset}))\n`
    wat += `  (global $__strInf i32 (i32.const ${infOffset}))\n`
    wat += `  (global $__strNegInf i32 (i32.const ${negInfOffset}))\n`
  }

  // === JSON.parse globals ===
  if (ctx.usedStdlib.includes('__json_parse')) {
    wat += `  (global $__json_str (mut i32) (i32.const 0))\n`
    wat += `  (global $__json_len (mut i32) (i32.const 0))\n`
    wat += `  (global $__json_pos (mut i32) (i32.const 0))\n`
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
 * - Payload: [type:3][aux:16][offset:32] = 51 bits
 *
 * Type enum: ATOM=0, ARRAY=1, TYPED=2, STRING=3, OBJECT=4, CLOSURE=5, REGEX=6
 *
 * NOTE: All helpers emitted together. DCE (watr) removes unused functions.
 */
function emitMemoryHelpers() {
  return `
  ;; NaN-boxing pointer encoding
  ;; Format: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
  ;; Payload: [type:3][aux:16][offset:32]
  ;; Types: ATOM=0, ARRAY=1, TYPED=2, STRING=3, OBJECT=4, CLOSURE=5, REGEX=6

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

  ;; Allocate array with C-style header (type=1, length at offset-8)
  ;; Returns pointer with offset pointing to element storage (after header)
  (func $__alloc (param $type i32) (param $len i32) (result f64)
    (local $offset i32) (local $size i32) (local $cap i32) (local $dataOffset i32)
    (local.set $cap (call $__cap_for_len (local.get $len)))
    ;; Size based on type: 8 bytes for f64/object/closure, 2 for string
    (local.set $size
      (i32.shl (local.get $cap)
        (select (i32.const 3)  ;; 8 bytes
          (i32.const 1)  ;; 2 bytes for strings
          (i32.ne (local.get $type) (i32.const 3)))))  ;; STRING=3
    (local.set $size (i32.and (i32.add (local.get $size) (i32.const 7)) (i32.const -8)))
    (local.set $offset (global.get $__heap))
    ;; For arrays (type=1), add 8 bytes for length header
    (if (i32.eq (local.get $type) (i32.const 1))
      (then
        ;; Layout: [length:f64][elem0, elem1, ...]
        (local.set $dataOffset (i32.add (local.get $offset) (i32.const 8)))
        (global.set $__heap (i32.add (local.get $offset) (i32.add (local.get $size) (i32.const 8))))
        ;; Store length at offset (before data)
        (f64.store (local.get $offset) (f64.convert_i32_s (local.get $len)))
        (return (call $__mkptr (local.get $type) (i32.const 0) (local.get $dataOffset)))))
    ;; For strings (type=3), add 8 bytes for length header
    (if (i32.eq (local.get $type) (i32.const 3))
      (then
        ;; Layout: [length:i32][char0:u16, char1:u16, ...]
        (local.set $dataOffset (i32.add (local.get $offset) (i32.const 8)))
        (global.set $__heap (i32.add (local.get $offset) (i32.add (local.get $size) (i32.const 8))))
        (i32.store (local.get $offset) (local.get $len))
        (return (call $__mkptr (local.get $type) (i32.const 0) (local.get $dataOffset)))))
    ;; For other types (object, etc), no header
    (global.set $__heap (i32.add (global.get $__heap) (local.get $size)))
    (call $__mkptr (local.get $type) (local.get $len) (local.get $offset)))

  ;; NaN box base: 0x7FF8_0000_0000_0000 (quiet NaN)
  ;; Create NaN-boxed pointer: [type:3][aux:16][offset:32]
  ;; type at bits 48-50, aux at bits 32-47, offset at bits 0-31
  (func $__mkptr (param $type i32) (param $aux i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64
      (i64.or (i64.const 0x7FF8000000000000)
        (i64.or
          (i64.shl (i64.extend_i32_u (local.get $type)) (i64.const 48))
          (i64.or
            (i64.shl (i64.extend_i32_u (local.get $aux)) (i64.const 32))
            (i64.extend_i32_u (local.get $offset)))))))

  ;; === Symbol support (ATOM type) ===
  ;; Symbol: type=0 (ATOM), aux=2 (SYMBOL kind), offset=unique id
  ;; Each call creates a new symbol with incrementing id
  (global $__symbol_id (mut i32) (i32.const 0))
  (func $__mk_symbol (result f64)
    (local $id i32)
    (local.set $id (global.get $__symbol_id))
    (global.set $__symbol_id (i32.add (local.get $id) (i32.const 1)))
    ;; ATOM type=0, kind=2 (SYMBOL), offset=id
    (call $__mkptr (i32.const 0) (i32.const 2) (local.get $id)))

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

  ;; Get typeof code for any f64 value at runtime
  ;; Returns: 0=undefined, 1=number, 2=string, 3=boolean, 4=object, 5=function, 6=symbol
  ;; Handles: regular numbers (1), NaN-boxed pointers (check type bits)
  ;; - ATOM type=0 with aux=2 → symbol (6)
  ;; - STRING type=3 → string (2)
  ;; - Other pointers → object (4)
  (func $__typeof_code (param $val f64) (result i32)
    (local $ptrType i32) (local $ptrAux i32)
    (if (result i32) (call $__is_pointer (local.get $val))
      (then
        (local.set $ptrType (call $__ptr_type (local.get $val)))
        (local.set $ptrAux (call $__ptr_aux (local.get $val)))
        ;; ATOM type=0 with aux=2 (SYMBOL) → symbol (6)
        (if (result i32) (i32.and
              (i32.eq (local.get $ptrType) (i32.const 0))
              (i32.eq (local.get $ptrAux) (i32.const 2)))
          (then (i32.const 6))
          (else
            ;; STRING type=3 → string (2)
            (if (result i32) (i32.eq (local.get $ptrType) (i32.const 3))
              (then (i32.const 2))
              ;; CLOSURE type=5 → function (5)
              (else (if (result i32) (i32.eq (local.get $ptrType) (i32.const 5))
                (then (i32.const 5))
                ;; All other pointers → object (4)
                (else (i32.const 4))))))))
      ;; Not a pointer → number (1)
      (else (i32.const 1))))

  ;; Extract type from pointer (bits 48-50, 3 bits)
  (func $__ptr_type (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 48)))
      (i32.const 0x7)))

  ;; Extract aux from pointer (bits 32-47, 16 bits)
  (func $__ptr_aux (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 32)))
      (i32.const 0xFFFF)))

  ;; Extract offset from pointer (bits 0-31, 32 bits)
  (func $__ptr_offset (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.reinterpret_f64 (local.get $ptr))))

  ;; Legacy alias: id → aux (for backward compat during transition)
  (func $__ptr_id (param $ptr f64) (result i32)
    (call $__ptr_aux (local.get $ptr)))

  ;; Get length (type-aware): both arrays and strings store len as i32 at offset-8
  ;; STRING=3 uses i32 header, ARRAY=1 uses f64 header (but only low 32 bits matter)
  (func $__ptr_len (param $ptr f64) (result i32)
    (if (result i32) (i32.eq (call $__ptr_type (local.get $ptr)) (i32.const 3))  ;; STRING=3
      (then (i32.load (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 8))))
      (else (i32.trunc_f64_s (f64.load (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 8)))))))

  ;; === SSO (Short String Optimization) helpers ===
  ;; SSO strings pack ≤6 ASCII chars in pointer (no memory)
  ;; Format: aux[15]=sso flag, data = ((aux & 0x7FFF) << 32) | offset
  ;; Data layout: [len:3][char0:7][char1:7][char2:7][char3:7][char4:7][char5:7]
  ;; Total: 3 + 42 = 45 bits, fits in 47 available bits

  ;; Check if string is SSO (aux & 0x8000)
  (func $__is_sso (param $ptr f64) (result i32)
    (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 0x8000)))

  ;; Get string length - handles both SSO and heap
  (func $__str_len (param $ptr f64) (result i32)
    (if (result i32) (call $__is_sso (local.get $ptr))
      (then
        ;; SSO: length in bits 0-2 of packed data (offset bits 0-2)
        (i32.and (call $__ptr_offset (local.get $ptr)) (i32.const 7)))
      (else
        ;; Heap: length at offset-8 as i32
        (i32.load (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 8))))))

  ;; Get char at index - handles both SSO and heap
  (func $__str_char_at (param $ptr f64) (param $idx i32) (result i32)
    (local $data i64) (local $shift i32)
    (if (result i32) (call $__is_sso (local.get $ptr))
      (then
        ;; SSO: extract char from packed data
        ;; data = ((aux & 0x7FFF) << 32) | offset
        (local.set $data
          (i64.or
            (i64.shl (i64.extend_i32_u (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 0x7FFF))) (i64.const 32))
            (i64.extend_i32_u (call $__ptr_offset (local.get $ptr)))))
        ;; char at idx: (data >> (3 + idx*7)) & 0x7F
        (local.set $shift (i32.add (i32.const 3) (i32.mul (local.get $idx) (i32.const 7))))
        (i32.and (i32.wrap_i64 (i64.shr_u (local.get $data) (i64.extend_i32_u (local.get $shift)))) (i32.const 0x7F)))
      (else
        ;; Heap: UTF-16 char at offset + idx*2
        (i32.load16_u (i32.add (call $__ptr_offset (local.get $ptr)) (i32.shl (local.get $idx) (i32.const 1)))))))

  ;; Copy len chars from src[srcIdx] to dst[dstIdx] - handles SSO source
  (func $__str_copy (param $dst f64) (param $dstIdx i32) (param $src f64) (param $srcIdx i32) (param $len i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (i32.store16
          (i32.add (call $__ptr_offset (local.get $dst)) (i32.shl (i32.add (local.get $dstIdx) (local.get $i)) (i32.const 1)))
          (call $__str_char_at (local.get $src) (i32.add (local.get $srcIdx) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop))))

  ;; Convert SSO string to heap string (for operations requiring memory access)
  ;; Returns heap string if SSO, original pointer if already heap
  (func $__sso_to_heap (param $ptr f64) (result f64)
    (local $len i32) (local $heap f64)
    (if (result f64) (call $__is_sso (local.get $ptr))
      (then
        ;; SSO: allocate heap string and copy
        (local.set $len (call $__str_len (local.get $ptr)))
        (local.set $heap (call $__alloc (i32.const 3) (local.get $len)))
        (call $__str_copy (local.get $heap) (i32.const 0) (local.get $ptr) (i32.const 0) (local.get $len))
        (local.get $heap))
      (else
        ;; Already heap
        (local.get $ptr))))

  ;; String value equality - compares actual content, not pointers
  ;; Handles SSO vs SSO, heap vs heap, and SSO vs heap
  (func $__str_eq (param $a f64) (param $b f64) (result i32)
    (local $lenA i32) (local $lenB i32) (local $i i32)
    ;; Fast path: identical pointers (same interned string)
    (if (i64.eq (i64.reinterpret_f64 (local.get $a)) (i64.reinterpret_f64 (local.get $b)))
      (then (return (i32.const 1))))
    ;; Compare lengths first
    (local.set $lenA (call $__str_len (local.get $a)))
    (local.set $lenB (call $__str_len (local.get $b)))
    (if (i32.ne (local.get $lenA) (local.get $lenB))
      (then (return (i32.const 0))))
    ;; Compare chars
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $lenA)))
        (if (i32.ne
              (call $__str_char_at (local.get $a) (local.get $i))
              (call $__str_char_at (local.get $b) (local.get $i)))
          (then (return (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 1))

  ;; Set length in memory (for mutable arrays)
  (func $__ptr_set_len (param $ptr f64) (param $len i32)
    (f64.store
      (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 8))
      (f64.convert_i32_s (local.get $len))))

  ;; Create new pointer with updated aux field
  (func $__ptr_with_aux (param $ptr f64) (param $aux i32) (result f64)
    (call $__mkptr (call $__ptr_type (local.get $ptr)) (local.get $aux) (call $__ptr_offset (local.get $ptr))))

  ;; Legacy aliases for backward compat
  (func $__ptr_with_id (param $ptr f64) (param $id i32) (result f64)
    (call $__ptr_with_aux (local.get $ptr) (local.get $id)))

  (func $__ptr_with_len (param $ptr f64) (param $len i32) (result f64)
    (call $__ptr_with_aux (local.get $ptr) (local.get $len)))

  ;; Alias for schema (objects use aux as schemaId, but shifted - kind:2 bits + schema:14 bits)
  (func $__ptr_schema (param $ptr f64) (result i32)
    (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 0x3FFF)))

  ;; === RING buffer (ARRAY type=1 with ring bit set in aux) ===
  ;; Pointer: [1:3][1:1][_:15][offset:32] - aux = 0x8000 (ring bit)
  ;; Memory layout: [-16:head][-8:len][slots...]
  ;; O(1) push/pop/shift/unshift via circular indexing: slots[(head + i) & mask]
  ;; capacity = nextPow2(len), mask = cap - 1

  ;; Allocate ring buffer (ARRAY with ring=1)
  (func $__alloc_ring (param $len i32) (result f64)
    (local $offset i32) (local $cap i32) (local $size i32) (local $dataOffset i32)
    (local.set $cap (call $__cap_for_len (local.get $len)))
    (local.set $size (i32.shl (local.get $cap) (i32.const 3)))
    (local.set $offset (global.get $__heap))
    (local.set $dataOffset (i32.add (local.get $offset) (i32.const 16)))
    (global.set $__heap (i32.add (local.get $offset) (i32.add (local.get $size) (i32.const 16))))
    (f64.store (local.get $offset) (f64.const 0))
    (f64.store (i32.add (local.get $offset) (i32.const 8)) (f64.convert_i32_s (local.get $len)))
    (call $__mkptr (i32.const 1) (i32.const 0x8000) (local.get $dataOffset)))

  ;; Get ring head
  (func $__ring_head (param $ptr f64) (result i32)
    (i32.trunc_f64_s (f64.load (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 16)))))

  ;; Get ring length
  (func $__ring_len (param $ptr f64) (result i32)
    (i32.trunc_f64_s (f64.load (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 8)))))

  ;; Get ring capacity (power of 2)
  (func $__ring_cap (param $ptr f64) (result i32)
    (call $__cap_for_len (call $__ring_len (local.get $ptr))))

  ;; Get ring mask (cap - 1)
  (func $__ring_mask (param $ptr f64) (result i32)
    (i32.sub (call $__ring_cap (local.get $ptr)) (i32.const 1)))

  ;; Set ring head
  (func $__ring_set_head (param $ptr f64) (param $head i32)
    (f64.store
      (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 16))
      (f64.convert_i32_s (local.get $head))))

  ;; Set ring length
  (func $__ring_set_len (param $ptr f64) (param $len i32)
    (f64.store
      (i32.sub (call $__ptr_offset (local.get $ptr)) (i32.const 8))
      (f64.convert_i32_s (local.get $len))))

  ;; Get element: slots[(head + i) & mask]
  (func $__ring_get (param $ptr f64) (param $i i32) (result f64)
    (f64.load
      (i32.add
        (call $__ptr_offset (local.get $ptr))
        (i32.shl
          (i32.and
            (i32.add (call $__ring_head (local.get $ptr)) (local.get $i))
            (call $__ring_mask (local.get $ptr)))
          (i32.const 3)))))

  ;; Set element: slots[(head + i) & mask] = val
  (func $__ring_set (param $ptr f64) (param $i i32) (param $val f64)
    (f64.store
      (i32.add
        (call $__ptr_offset (local.get $ptr))
        (i32.shl
          (i32.and
            (i32.add (call $__ring_head (local.get $ptr)) (local.get $i))
            (call $__ring_mask (local.get $ptr)))
          (i32.const 3)))
      (local.get $val)))

  ;; Push to end (O(1), may resize)
  (func $__ring_push (param $ptr f64) (param $val f64) (result f64)
    (local $len i32) (local $cap i32) (local $newPtr f64)
    (local.set $len (call $__ring_len (local.get $ptr)))
    (local.set $cap (call $__ring_cap (local.get $ptr)))
    (if (i32.ge_s (local.get $len) (local.get $cap))
      (then
        (local.set $newPtr (call $__ring_resize (local.get $ptr) (i32.add (local.get $len) (i32.const 1))))
        (call $__ring_set (local.get $newPtr) (local.get $len) (local.get $val))
        (return (local.get $newPtr))))
    (call $__ring_set (local.get $ptr) (local.get $len) (local.get $val))
    (call $__ring_set_len (local.get $ptr) (i32.add (local.get $len) (i32.const 1)))
    (local.get $ptr))

  ;; Pop from end (O(1))
  (func $__ring_pop (param $ptr f64) (result f64)
    (local $len i32)
    (local.set $len (call $__ring_len (local.get $ptr)))
    (if (result f64) (i32.le_s (local.get $len) (i32.const 0))
      (then (f64.const nan))
      (else
        (call $__ring_set_len (local.get $ptr) (i32.sub (local.get $len) (i32.const 1)))
        (call $__ring_get (local.get $ptr) (i32.sub (local.get $len) (i32.const 1))))))

  ;; Shift from start (O(1))
  (func $__ring_shift (param $ptr f64) (result f64)
    (local $len i32) (local $head i32) (local $cap i32) (local $val f64)
    (local.set $len (call $__ring_len (local.get $ptr)))
    (if (result f64) (i32.le_s (local.get $len) (i32.const 0))
      (then (f64.const nan))
      (else
        (local.set $val (call $__ring_get (local.get $ptr) (i32.const 0)))
        (local.set $head (call $__ring_head (local.get $ptr)))
        (local.set $cap (call $__ring_cap (local.get $ptr)))
        (call $__ring_set_head (local.get $ptr)
          (i32.and (i32.add (local.get $head) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
        (call $__ring_set_len (local.get $ptr) (i32.sub (local.get $len) (i32.const 1)))
        (local.get $val))))

  ;; Unshift to start (O(1), may resize)
  (func $__ring_unshift (param $ptr f64) (param $val f64) (result f64)
    (local $len i32) (local $cap i32) (local $head i32) (local $newHead i32) (local $newPtr f64)
    (local.set $len (call $__ring_len (local.get $ptr)))
    (local.set $cap (call $__ring_cap (local.get $ptr)))
    (if (i32.ge_s (local.get $len) (local.get $cap))
      (then
        (local.set $newPtr (call $__ring_resize (local.get $ptr) (i32.add (local.get $len) (i32.const 1))))
        (call $__ring_set_head (local.get $newPtr) (i32.sub (call $__ring_cap (local.get $newPtr)) (i32.const 1)))
        (call $__ring_set (local.get $newPtr) (i32.const 0) (local.get $val))
        (call $__ring_set_len (local.get $newPtr) (i32.add (local.get $len) (i32.const 1)))
        (return (local.get $newPtr))))
    (local.set $head (call $__ring_head (local.get $ptr)))
    (local.set $newHead (i32.and (i32.sub (local.get $head) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
    (call $__ring_set_head (local.get $ptr) (local.get $newHead))
    (call $__ring_set_len (local.get $ptr) (i32.add (local.get $len) (i32.const 1)))
    (call $__ring_set (local.get $ptr) (i32.const 0) (local.get $val))
    (local.get $ptr))

  ;; Resize ring: allocate new, copy linearized
  (func $__ring_resize (param $ptr f64) (param $newLen i32) (result f64)
    (local $oldLen i32) (local $newPtr f64) (local $i i32)
    (local.set $oldLen (call $__ring_len (local.get $ptr)))
    (local.set $newPtr (call $__alloc_ring (local.get $newLen)))
    (local.set $i (i32.const 0))
    (block $done (loop $copy
      (br_if $done (i32.ge_s (local.get $i) (local.get $oldLen)))
      (call $__ring_set (local.get $newPtr) (local.get $i) (call $__ring_get (local.get $ptr) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (local.get $newPtr))

  ;; Check if array is ring type (aux & 0x8000)
  (func $__is_ring (param $ptr f64) (result i32)
    (i32.and (call $__ptr_aux (local.get $ptr)) (i32.const 0x8000)))

  ;; Smart array get - handles both flat and ring arrays
  (func $__arr_get (param $ptr f64) (param $i i32) (result f64)
    (if (result f64) (call $__is_ring (local.get $ptr))
      (then (call $__ring_get (local.get $ptr) (local.get $i)))
      (else (f64.load (i32.add (call $__ptr_offset (local.get $ptr)) (i32.shl (local.get $i) (i32.const 3)))))))

  ;; Smart array set - handles both flat and ring arrays
  (func $__arr_set (param $ptr f64) (param $i i32) (param $val f64)
    (if (call $__is_ring (local.get $ptr))
      (then (call $__ring_set (local.get $ptr) (local.get $i) (local.get $val)))
      (else (f64.store (i32.add (call $__ptr_offset (local.get $ptr)) (i32.shl (local.get $i) (i32.const 3))) (local.get $val)))))

  ;; Convert flat array to ring array (for shift/unshift support)
  (func $__to_ring (param $ptr f64) (result f64)
    (local $len i32) (local $ring f64) (local $i i32) (local $off i32)
    (if (result f64) (call $__is_ring (local.get $ptr))
      (then (local.get $ptr))
      (else
        (local.set $len (call $__ptr_len (local.get $ptr)))
        (local.set $ring (call $__alloc_ring (local.get $len)))
        (local.set $off (call $__ptr_offset (local.get $ptr)))
        (local.set $i (i32.const 0))
        (block $done (loop $copy
          (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
          (call $__ring_set (local.get $ring) (local.get $i)
            (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy)))
        (local.get $ring))))

  ;; Smart shift: convert to ring if needed, then shift (mutating)
  (func $__arr_shift (param $ptr f64) (result f64)
    (local $ring f64)
    ;; Empty array check
    (if (result f64) (i32.le_s (call $__ptr_len (local.get $ptr)) (i32.const 0))
      (then (f64.const nan))
      (else
        ;; Convert to ring if not already
        (local.set $ring (call $__to_ring (local.get $ptr)))
        ;; Now do ring shift
        (call $__ring_shift (local.get $ring)))))

  ;; Smart unshift: convert to ring if needed, prepend value (mutating)
  (func $__arr_unshift (param $ptr f64) (param $val f64) (result f64)
    (local $ring f64)
    ;; Convert to ring if not already
    (local.set $ring (call $__to_ring (local.get $ptr)))
    ;; Now do ring unshift
    (call $__ring_unshift (local.get $ring) (local.get $val)))

  ;; Concatenate two strings (handles SSO inputs)
  (func $__strcat (param $a f64) (param $b f64) (result f64)
    (local $lenA i32) (local $lenB i32) (local $result f64)
    (local.set $lenA (call $__str_len (local.get $a)))
    (local.set $lenB (call $__str_len (local.get $b)))
    (local.set $result (call $__alloc (i32.const 3) (i32.add (local.get $lenA) (local.get $lenB))))  ;; STRING=3
    ;; Copy first string
    (call $__str_copy (local.get $result) (i32.const 0) (local.get $a) (i32.const 0) (local.get $lenA))
    ;; Copy second string
    (call $__str_copy (local.get $result) (local.get $lenA) (local.get $b) (i32.const 0) (local.get $lenB))
    (local.get $result))

  ;; Concatenate three strings (handles SSO inputs)
  (func $__strcat3 (param $a f64) (param $b f64) (param $c f64) (result f64)
    (local $lenA i32) (local $lenB i32) (local $lenC i32) (local $result f64)
    (local.set $lenA (call $__str_len (local.get $a)))
    (local.set $lenB (call $__str_len (local.get $b)))
    (local.set $lenC (call $__str_len (local.get $c)))
    (local.set $result (call $__alloc (i32.const 3) (i32.add (i32.add (local.get $lenA) (local.get $lenB)) (local.get $lenC))))  ;; STRING=3
    ;; Copy first string
    (call $__str_copy (local.get $result) (i32.const 0) (local.get $a) (i32.const 0) (local.get $lenA))
    ;; Copy second string
    (call $__str_copy (local.get $result) (local.get $lenA) (local.get $b) (i32.const 0) (local.get $lenB))
    ;; Copy third string
    (call $__str_copy (local.get $result) (i32.add (local.get $lenA) (local.get $lenB)) (local.get $c) (i32.const 0) (local.get $lenC))
    (local.get $result))

  ;; Reallocate array to new capacity tier, copy data, return new pointer
  (func $__realloc (param $ptr f64) (param $newLen i32) (result f64)
    (local $oldLen i32) (local $newPtr f64) (local $i i32) (local $oldOff i32) (local $newOff i32) (local $ptrType i32)
    (local.set $oldLen (call $__ptr_len (local.get $ptr)))
    (local.set $ptrType (call $__ptr_type (local.get $ptr)))
    ;; Allocate new array (all arrays now use $__alloc)
    (local.set $newPtr (call $__alloc (local.get $ptrType) (local.get $newLen)))
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

  ;; === TypedArray support (view model) ===
  ;; Pointer: [type:3][elem:3][_:13][viewOffset:32] - full 32-bit addressing
  ;; Memory: viewOffset → [len:i32][dataPtr:i32], dataPtr → actual element data
  ;; Zero-copy subarray: new 8-byte header, same dataPtr
  ;; Unlimited length (was 4M), unlimited addressing (was 4MB)

  (global $__typed_bump (mut i32) (i32.const 0))  ;; bump allocator pointer
  (global $__typed_arena_start (mut i32) (i32.const 0))  ;; arena start for reset

  ;; Allocate TypedArray: bump allocate view header + data
  (func $__alloc_typed (param $elemType i32) (param $len i32) (result f64)
    (local $stride i32) (local $dataSize i32) (local $viewOffset i32) (local $dataPtr i32)
    ;; Compute stride from elemType
    (local.set $stride
      (select (i32.const 8)
        (select (i32.const 4)
          (select (i32.const 2)
            (i32.const 1)
            (i32.ge_u (local.get $elemType) (i32.const 2)))
          (i32.ge_u (local.get $elemType) (i32.const 4)))
        (i32.eq (local.get $elemType) (i32.const 7))))
    ;; Data size aligned to 8 bytes
    (local.set $dataSize
      (i32.and
        (i32.add (i32.mul (local.get $len) (local.get $stride)) (i32.const 7))
        (i32.const -8)))
    ;; Allocate: 8-byte header + data
    (local.set $viewOffset (global.get $__typed_bump))
    (local.set $dataPtr (i32.add (local.get $viewOffset) (i32.const 8)))
    (global.set $__typed_bump (i32.add (local.get $dataPtr) (local.get $dataSize)))
    ;; Write header: [len:i32][dataPtr:i32]
    (i32.store (local.get $viewOffset) (local.get $len))
    (i32.store offset=4 (local.get $viewOffset) (local.get $dataPtr))
    ;; Return pointer: [type:3=TYPED][elem:3][_:13][viewOffset:32]
    (call $__mkptr_typed (local.get $elemType) (local.get $viewOffset)))

  ;; Create TypedArray pointer: [type:3][elem:3][_:13][viewOffset:32]
  (func $__mkptr_typed (param $elemType i32) (param $viewOffset i32) (result f64)
    (f64.reinterpret_i64
      (i64.or (i64.const 0x7FF8000000000000)
        (i64.or
          (i64.shl (i64.const 2) (i64.const 48))  ;; type = TYPED = 2
          (i64.or
            (i64.shl (i64.extend_i32_u (local.get $elemType)) (i64.const 45))
            (i64.extend_i32_u (local.get $viewOffset)))))))

  ;; Extract elemType (bits 45-47)
  (func $__typed_elemtype (param $ptr f64) (result i32)
    (i32.and
      (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 45)))
      (i32.const 0x7)))

  ;; Get view offset from pointer (bits 0-31)
  (func $__typed_view (param $ptr f64) (result i32)
    (i32.wrap_i64 (i64.reinterpret_f64 (local.get $ptr))))

  ;; Get length from view header
  (func $__typed_len (param $ptr f64) (result i32)
    (i32.load (call $__typed_view (local.get $ptr))))

  ;; Get dataPtr from view header (actual data offset)
  (func $__typed_offset (param $ptr f64) (result i32)
    (i32.load offset=4 (call $__typed_view (local.get $ptr))))

  ;; Create subarray view: allocate 8-byte header, share dataPtr with offset adjustment
  ;; Returns new pointer to view with [len:newLen][dataPtr:srcDataPtr + begin*stride]
  (func $__mk_typed_view (param $elemType i32) (param $len i32) (param $dataPtr i32) (result f64)
    (local $viewOffset i32)
    ;; Allocate 8-byte header only (data shared)
    (local.set $viewOffset (global.get $__typed_bump))
    (global.set $__typed_bump (i32.add (local.get $viewOffset) (i32.const 8)))
    ;; Write header: [len:i32][dataPtr:i32]
    (i32.store (local.get $viewOffset) (local.get $len))
    (i32.store offset=4 (local.get $viewOffset) (local.get $dataPtr))
    ;; Return pointer
    (call $__mkptr_typed (local.get $elemType) (local.get $viewOffset)))

  ;; Create subarray: zero-copy view sharing original data
  ;; srcPtr = original typed array, begin/end = slice indices, stride = element size
  (func $__mk_typed_subarray (param $srcPtr f64) (param $elemType i32) (param $begin i32) (param $end i32) (param $stride i32) (result f64)
    (call $__mk_typed_view
      (local.get $elemType)
      (i32.sub (local.get $end) (local.get $begin))  ;; newLen = end - begin
      (i32.add  ;; newDataPtr = srcDataPtr + begin * stride
        (call $__typed_offset (local.get $srcPtr))
        (i32.mul (local.get $begin) (local.get $stride)))))

  ;; Legacy compatibility: create pointer with given offset (for filter results)
  (func $__mk_typed_ptr (param $elemType i32) (param $len i32) (param $dataOffset i32) (result f64)
    (call $__mk_typed_view (local.get $elemType) (local.get $len) (local.get $dataOffset)))

  ;; Reset typed array arena (call between frames/batches)
  (func $__reset_typed_arrays
    (global.set $__typed_bump (global.get $__typed_arena_start)))
`
}

/**
 * Emit GC conversion helpers for export wrappers
* Uses $v temp local to work around watr bug (can't have f64.load directly in array.set)
 * NOTE: Kept for potential future use, but currently JS wrapper handles conversion.
 */
// function emitGcConversionHelpers() { ... } - removed, JS wrapper handles this
// function emitExportWrappers(ctx) { ... } - removed, JS wrapper handles this
