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
 * @param {boolean} gc - Whether GC mode is enabled
 * @returns {string} - Complete WAT module text
 */
export function assemble(bodyWat, ctx, extraFunctions = [], gc = true) {
  let wat = '(module\n'

  // === Type definitions ===

  // Function types for closure calls
  if (ctx.usedFuncTypes?.size > 0) {
    for (const arity of ctx.usedFuncTypes) {
      const envParam = gc ? 'anyref' : 'f64'
      const params = `(param ${envParam})` + ' (param f64)'.repeat(arity)
      wat += `  (type $fntype${arity} (func ${params} (result f64)))\n`
    }
  }

  // Function types for closures returning closures
  if (ctx.usedClFuncTypes?.size > 0) {
    for (const arity of ctx.usedClFuncTypes) {
      const envParam = gc ? 'anyref' : 'f64'
      const params = `(param ${envParam})` + ' (param f64)'.repeat(arity)
      wat += `  (type $clfntype${arity} (func ${params} (result anyref)))\n`
    }
  }

  // GC types (gc:true mode only)
  if (gc) {
    if (ctx.usedArrayType) wat += '  (type $f64array (array (mut f64)))\n'
    if (ctx.usedStringType) wat += '  (type $string (array (mut i16)))\n'
    if (ctx.usedRefArrayType) wat += '  (type $anyarray (array (mut anyref)))\n'
    if (ctx.usedClosureType) {
      wat += '  (type $closure (struct (field $fn funcref) (field $env anyref)))\n'
    }
    // Closure environment struct types
    for (const env of ctx.closureEnvTypes) {
      const fields = env.fields.map(f => `(field $${f} (mut f64))`).join(' ')
      wat += `  (type $env${env.id} (struct ${fields}))\n`
    }
    // Declare functions referenced via ref.func
    if (ctx.refFuncs.size > 0) {
      const funcs = Array.from(ctx.refFuncs).map(n => `$${n}`).join(' ')
      wat += `  (elem declare func ${funcs})\n`
    }
  }

  // Function table for gc:false closure calls
  if (ctx.usedFuncTable && ctx.funcTableEntries.length > 0) {
    const tableSize = ctx.funcTableEntries.length
    wat += `  (table $fntable ${tableSize} funcref)\n`
    const elems = ctx.funcTableEntries.map(name => `$${name}`).join(' ')
    wat += `  (elem (i32.const 0) func ${elems})\n`
  }

  // === Memory ===

  if (ctx.usedMemory || !gc) {
    wat += '  (memory (export "memory") 1)\n'
    const heapStart = ctx.staticOffset || 1024
    wat += `  (global $__heap (mut i32) (i32.const ${heapStart}))\n`
  }

  // === Data segments ===

  // String data
  for (const str in ctx.strings) {
    const info = ctx.strings[str]
    const startByte = info.offset * 2
    const endByte = startByte + info.length * 2
    const hex = ctx.stringData.slice(startByte, endByte)
      .map(b => '\\' + b.toString(16).padStart(2, '0')).join('')
    if (gc) {
      wat += `  (data $str${info.id} "${hex}")\n`
    } else {
      const memOffset = info.id * 256
      wat += `  (data (i32.const ${memOffset}) "${hex}")\n`
    }
  }

  // Static array data (gc:false)
  if (!gc) {
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
  }

  // === Memory helper functions (gc:false) ===

  if (ctx.usedMemory && !gc) {
    wat += emitMemoryHelpers()
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

  // Interned string globals (gc:true)
  if (gc) {
    for (const id in ctx.internedStringGlobals) {
      wat += `  (global $__str${id} (mut (ref null $string)) (ref.null $string))\n`
    }
  }

  // User globals
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

    // Initialize interned strings (gc:true)
    let strInit = ''
    if (gc) {
      for (const id in ctx.internedStringGlobals) {
        const { length } = ctx.internedStringGlobals[id]
        strInit += `(if (ref.is_null (global.get $__str${id})) (then `
        strInit += `(global.set $__str${id} (array.new_data $string $str${id} (i32.const 0) (i32.const ${length})))))\n    `
      }
    }

    wat += `\n  (func $main (export "main") (result f64)${locals}\n    ${strInit}${bodyWat}\n  )`
  }

  return wat + '\n)'
}

/**
 * Emit NaN-boxing memory helper functions for gc:false mode
 */
function emitMemoryHelpers() {
  return `
  ;; NaN-boxing pointer encoding for gc:false mode
  ;; IEEE 754 f64: [sign:1][exponent:11][mantissa:52]
  ;; Pointer NaN: exponent=0x7FF, mantissa=[type:4][length:28][offset:20]
  ;; Types 1-7 are pointers, types 8-15 reserved for canonical quiet NaN

  (func $__alloc (param $type i32) (param $len i32) (result f64)
    (local $offset i32) (local $size i32)
    (local.set $size
      (i32.shl (local.get $len)
        (select (i32.const 3)
          (select (i32.const 2)
            (select (i32.const 1) (i32.const 0) (i32.eq (local.get $type) (i32.const 3)))
            (i32.eq (local.get $type) (i32.const 2)))
          (i32.or (i32.eq (local.get $type) (i32.const 1)) (i32.ge_u (local.get $type) (i32.const 5))))))
    (local.set $size (i32.and (i32.add (local.get $size) (i32.const 7)) (i32.const -8)))
    (local.set $offset (global.get $__heap))
    (global.set $__heap (i32.add (global.get $__heap) (local.get $size)))
    (call $__mkptr (local.get $type) (local.get $len) (local.get $offset)))

  (func $__mkptr (param $type i32) (param $len i32) (param $offset i32) (result f64)
    (f64.reinterpret_i64
      (i64.or (i64.const 0x7FF0000000000000)
        (i64.or
          (i64.or
            (i64.shl (i64.extend_i32_u (i32.and (local.get $type) (i32.const 0x0F))) (i64.const 48))
            (i64.shl (i64.extend_i32_u (i32.and (local.get $len) (i32.const 0x0FFFFFFF))) (i64.const 20)))
          (i64.extend_i32_u (i32.and (local.get $offset) (i32.const 0x0FFFFF)))))))

  (func $__is_pointer (param $val f64) (result i32)
    (i32.and
      (i32.eq
        (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $val)) (i64.const 52))) (i32.const 0x7FF))
        (i32.const 0x7FF))
      (i32.lt_u (call $__ptr_type (local.get $val)) (i32.const 8))))

  (func $__ptr_offset (param $ptr f64) (result i32)
    (i32.and (i32.wrap_i64 (i64.reinterpret_f64 (local.get $ptr))) (i32.const 0x0FFFFF)))

  (func $__ptr_len (param $ptr f64) (result i32)
    (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 20))) (i32.const 0x0FFFFFFF)))

  (func $__ptr_type (param $ptr f64) (result i32)
    (i32.and (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get $ptr)) (i64.const 48))) (i32.const 0x0F)))
`
}
