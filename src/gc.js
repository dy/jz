/**
 * GC-mode abstraction layer for jz compiler
 *
 * Provides unified API for operations that differ between:
 * - gc:true (WASM GC with structs/arrays)
 * - gc:false (linear memory with NaN-boxing)
 *
 * All functions take gc flag and return appropriate WAT code.
 */

import { PTR_TYPE, tv } from './types.js'

// === Null/undefined ===

/** Create null reference */
export const nullRef = (gc) => gc
  ? tv('ref', '(ref.null none)')
  : tv('f64', '(f64.const 0)')

/** Check if value is null (returns i32 condition) */
export const isNull = (gc, wat) => gc
  ? `(ref.is_null ${wat})`
  : `(f64.eq ${wat} (f64.const 0))`

// === Strings ===

/** Create string from interned data */
export function mkString(gc, ctx, str) {
  ctx.usedStringType = true
  const { id, length } = ctx.internString(str)
  if (gc) {
    ctx.internedStringGlobals[id] = { length }
    return tv('string', `(ref.as_non_null (global.get $__str${id}))`)
  } else {
    ctx.usedMemory = true
    return tv('string', `(call $__mkptr (i32.const ${PTR_TYPE.STRING}) (i32.const ${length}) (i32.const ${id}))`)
  }
}

/** Get string length */
export const strLen = (gc, wat) => gc
  ? `(array.len ${wat})`
  : `(call $__ptr_len ${wat})`

/** Get char at index */
export const strCharAt = (gc, wat, idx) => gc
  ? `(array.get_u $string ${wat} ${idx})`
  : `(i32.load16_u (i32.add (call $__ptr_offset ${wat}) (i32.shl ${idx} (i32.const 1))))`

/** Set char at index */
export const strSetChar = (gc, wat, idx, val) => gc
  ? `(array.set $string ${wat} ${idx} ${val})`
  : `(i32.store16 (i32.add (call $__ptr_offset ${wat}) (i32.shl ${idx} (i32.const 1))) ${val})`

/** Allocate dynamic-sized string (length from expression) */
export const strNew = (gc, lenWat) => gc
  ? `(array.new $string (i32.const 0) ${lenWat})`
  : `(call $__alloc (i32.const ${PTR_TYPE.STRING}) ${lenWat})`

// === Arrays ===

/** Get array length */
export const arrLen = (gc, wat, type = 'array') => gc
  ? `(array.len ${wat})`
  : `(call $__ptr_len ${wat})`

/** Get array element (f64) */
export const arrGet = (gc, wat, idx) => gc
  ? `(array.get $f64array ${wat} ${idx})`
  : `(f64.load (i32.add (call $__ptr_offset ${wat}) (i32.shl ${idx} (i32.const 3))))`

/** Set array element (f64) */
export const arrSet = (gc, wat, idx, val) => gc
  ? `(array.set $f64array ${wat} ${idx} ${val})`
  : `(f64.store (i32.add (call $__ptr_offset ${wat}) (i32.shl ${idx} (i32.const 3))) ${val})`

/** Allocate dynamic-sized f64 array (length from expression) */
export const arrNew = (gc, lenWat) => gc
  ? `(array.new $f64array (f64.const 0) ${lenWat})`
  : `(call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) ${lenWat})`

/** Create fixed-size f64 array from values */
export function mkF64Array(gc, ctx, values) {
  ctx.usedArrayType = true
  if (gc) {
    return tv('array', `(array.new_fixed $f64array ${values.length} ${values.join(' ')})`)
  } else {
    ctx.usedMemory = true
    const id = ctx.loopCounter++
    const tmp = `$_arr_${id}`
    ctx.addLocal(tmp.slice(1), 'f64')
    let stores = ''
    for (let i = 0; i < values.length; i++) {
      stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${values[i]})\n      `
    }
    return tv('array', `(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const ${values.length})))
      ${stores}(local.get ${tmp}))`)
  }
}

// === Objects ===

/** Get object property by index */
export const objGet = (gc, wat, idx) => gc
  ? `(array.get $f64array ${wat} (i32.const ${idx}))`
  : `(f64.load (i32.add (call $__ptr_offset ${wat}) (i32.const ${idx * 8})))`

/** Set object property by index */
export const objSet = (gc, wat, idx, val) => gc
  ? `(array.set $f64array ${wat} (i32.const ${idx}) ${val})`
  : `(f64.store (i32.add (call $__ptr_offset ${wat}) (i32.const ${idx * 8})) ${val})`

// === Environment (closures) ===

/** Read from environment struct/memory at field index */
export const envGet = (gc, envType, envVar, fieldIdx) => gc
  ? `(struct.get ${envType} ${fieldIdx} (local.get ${envVar}))`
  : `(f64.load (i32.add (call $__ptr_offset (local.get ${envVar})) (i32.const ${fieldIdx * 8})))`

/** Write to environment struct/memory at field index */
export const envSet = (gc, envType, envVar, fieldIdx, val) => gc
  ? `(struct.set ${envType} ${fieldIdx} (local.get ${envVar}) ${val})`
  : `(f64.store (i32.add (call $__ptr_offset (local.get ${envVar})) (i32.const ${fieldIdx * 8})) ${val})`

/** Create environment allocation */
export function mkEnv(gc, ctx, envType, numFields) {
  if (gc) {
    const zeros = Array(numFields).fill('(f64.const 0)').join(' ')
    return `(struct.new ${envType} ${zeros})`
  } else {
    ctx.usedMemory = true
    return `(call $__alloc (i32.const ${PTR_TYPE.CLOSURE}) (i32.const ${numFields}))`
  }
}

// === Closures ===

/** Create closure struct from funcref and env */
export function mkClosure(gc, ctx, funcName, envWat, arity) {
  if (gc) {
    ctx.usedClosureType = true
    ctx.refFuncs.add(funcName)
    return tv('closure', `(struct.new $closure (ref.func $${funcName}) ${envWat})`)
  } else {
    ctx.usedFuncTable = true
    ctx.usedMemory = true
    // Add to function table if not already there
    let tableIdx = ctx.funcTableEntries.indexOf(funcName)
    if (tableIdx < 0) {
      tableIdx = ctx.funcTableEntries.length
      ctx.funcTableEntries.push(funcName)
    }
    // Encode: [env bits in upper 32] [table idx in bits 32-47]
    const id = ctx.loopCounter++
    const tmpEnv = `$_closenv_${id}`
    ctx.addLocal(tmpEnv.slice(1), 'f64')
    return tv('closure', `(block (result f64)
      (local.set ${tmpEnv} ${envWat})
      (f64.reinterpret_i64
        (i64.or
          (i64.reinterpret_f64 (local.get ${tmpEnv}))
          (i64.shl (i64.extend_i32_u (i32.const ${tableIdx})) (i64.const 32)))))`)
  }
}

/** Call a closure */
export function callClosure(gc, ctx, closureWat, argWats, numArgs, closureType = 'closure') {
  const funcTypeName = `$fntype${numArgs}`
  if (!ctx.usedFuncTypes) ctx.usedFuncTypes = new Set()
  ctx.usedFuncTypes.add(numArgs)

  const id = ctx.loopCounter++
  const tmpClosure = `$_clos_${id}`
  ctx.addLocal(tmpClosure.slice(1), closureType)

  if (gc) {
    ctx.usedClosureType = true
    const closureRef = `(ref.as_non_null (local.get ${tmpClosure}))`
    return `(block (result f64)
      (local.set ${tmpClosure} ${closureWat})
      (call_ref ${funcTypeName}
        (struct.get $closure $env ${closureRef})
        ${argWats}
        (ref.cast (ref ${funcTypeName}) (struct.get $closure $fn ${closureRef}))))`
  } else {
    ctx.usedFuncTable = true
    ctx.usedMemory = true
    const tmpI64 = `$_closi64_${id}`
    ctx.localDecls.push(`(local ${tmpI64} i64)`)
    return `(block (result f64)
      (local.set ${tmpClosure} ${closureWat})
      (local.set ${tmpI64} (i64.reinterpret_f64 (local.get ${tmpClosure})))
      (call_indirect (type ${funcTypeName})
        (call $__mkptr (i32.const ${PTR_TYPE.CLOSURE})
          (i32.wrap_i64 (i64.shr_u (local.get ${tmpI64}) (i64.const 48)))
          (i32.wrap_i64 (local.get ${tmpI64})))
        ${argWats}
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get ${tmpI64}) (i64.const 32)) (i64.const 0xFFFF)))))`
  }
}
