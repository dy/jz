/**
 * Memory abstraction layer for jz compiler
 *
 * All operations use linear memory with integer-packed pointers.
 * Pointer format: type * 2^48 + len * 2^32 + offset
 */

import { PTR_TYPE, wat, f64, isHeapRef, isString, isObject } from './types.js'

// === Null/undefined ===

/** Create null reference (f64 0) */
export const nullRef = () => wat('(f64.const 0)', 'f64')

// === Strings ===

/** Create string from interned data. Strings are stored at id*256 in memory. */
export function mkString(ctx, str) {
  ctx.usedStringType = true
  ctx.usedMemory = true
  const { id, length } = ctx.internString(str)
  const offset = id * 256  // Each string slot is 256 bytes apart
  return wat(`(call $__mkptr (i32.const ${PTR_TYPE.STRING}) (i32.const 0) (i32.const ${length}) (i32.const ${offset}))`, 'string')
}

/** Get string length */
export const strLen = (w) => `(call $__ptr_len ${w})`

/** Get char at index */
export const strCharAt = (w, idx) =>
  `(i32.load16_u (i32.add (call $__ptr_offset ${w}) (i32.shl ${idx} (i32.const 1))))`

/** Set char at index */
export const strSetChar = (w, idx, val) =>
  `(i32.store16 (i32.add (call $__ptr_offset ${w}) (i32.shl ${idx} (i32.const 1))) ${val})`

/** Allocate dynamic-sized string */
export const strNew = (lenWat) =>
  `(call $__alloc (i32.const ${PTR_TYPE.STRING}) ${lenWat})`

// === Arrays ===

/** Get array length from pointer */
export const arrLen = (w) => `(call $__ptr_len ${w})`

/** Get array capacity tier for current length */
export const arrCapacity = (w) =>
  `(call $__cap_for_len (call $__ptr_len ${w}))`

/** Get array element (f64) */
export const arrGet = (w, idx) =>
  `(f64.load (i32.add (call $__ptr_offset ${w}) (i32.shl ${idx} (i32.const 3))))`

/** Set array element (f64) */
export const arrSet = (w, idx, val) =>
  `(f64.store (i32.add (call $__ptr_offset ${w}) (i32.shl ${idx} (i32.const 3))) ${val})`

/** Allocate dynamic-sized f64 array */
export const arrNew = (lenWat) =>
  `(call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) ${lenWat})`

/** Create pointer with modified length - for push/pop */
export const ptrWithLen = (ptrWat, newLenWat) =>
  `(call $__ptr_with_len ${ptrWat} ${newLenWat})`

/** Copy array elements using memory.copy (count is element count, not bytes) */
export const arrCopy = (dstPtr, dstIdx, srcPtr, srcIdx, count) =>
  `(memory.copy (i32.add (call $__ptr_offset ${dstPtr}) (i32.shl ${dstIdx} (i32.const 3))) (i32.add (call $__ptr_offset ${srcPtr}) (i32.shl ${srcIdx} (i32.const 3))) (i32.shl ${count} (i32.const 3)))`

/** Get array element with typed value return - auto-sets ctx flags */
export function arrGetTyped(ctx, arrWat, idxWat) {
  ctx.usedMemory = true
  return wat(`(f64.load (i32.add (call $__ptr_offset ${arrWat}) (i32.shl ${idxWat} (i32.const 3))))`, 'f64')
}

/**
 * Create array literal from generated values
 */
export function mkArrayLiteral(ctx, gens, isConstant, evalConstant, elements) {
  const hasRefTypes = gens.some(g => isHeapRef(g) || isString(g))
  ctx.usedMemory = true

  const isStatic = elements.every(isConstant)
  if (isStatic && !hasRefTypes) {
    // Static f64 array - store in data segment
    const arrayId = Object.keys(ctx.staticArrays).length
    const values = elements.map(evalConstant)
    const offset = 4096 + (arrayId * 64)
    ctx.staticArrays[arrayId] = { offset, values }
    return wat(`(call $__mkptr (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const 0) (i32.const ${values.length}) (i32.const ${offset}))`, 'f64', values.map(() => ({ type: 'f64' })))
  } else if (hasRefTypes) {
    // Mixed-type array: REF_ARRAY
    const id = ctx.loopCounter++
    const tmp = `$_arr_${id}`
    ctx.addLocal(tmp.slice(1), 'f64')
    let stores = ''
    const elementSchema = []
    for (let i = 0; i < gens.length; i++) {
      const g = gens[i]
      const val = (g.type === 'array' || g.type === 'object' || g.type === 'string') ? String(g) : String(f64(g))
      stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${val})\n      `
      if (isObject(g) && g.schema !== undefined) elementSchema.push({ type: 'object', id: g.schema })
      else elementSchema.push({ type: g.type })
    }
    return wat(`(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.REF_ARRAY}) (i32.const ${gens.length})))
      ${stores}(local.get ${tmp}))`, 'f64', elementSchema)
  } else {
    // Dynamic homogeneous f64 array
    const id = ctx.loopCounter++
    const tmp = `$_arr_${id}`
    ctx.addLocal(tmp.slice(1), 'f64')
    let stores = ''
    for (let i = 0; i < gens.length; i++) {
      stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${f64(gens[i])})\n      `
    }
    return wat(`(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const ${gens.length})))
      ${stores}(local.get ${tmp}))`, 'f64', gens.map(() => ({ type: 'f64' })))
  }
}

// === Objects ===

/** Get object property by index */
export const objGet = (w, idx) =>
  `(f64.load (i32.add (call $__ptr_offset ${w}) (i32.const ${idx * 8})))`

/** Set object property by index */
export const objSet = (w, idx, val) =>
  `(f64.store (i32.add (call $__ptr_offset ${w}) (i32.const ${idx * 8})) ${val})`

// === Environment (closures) ===

/** Read from environment memory at field index */
export const envGet = (envVar, fieldIdx) =>
  `(f64.load (i32.add (call $__ptr_offset (local.get ${envVar})) (i32.const ${fieldIdx * 8})))`

/** Write to environment memory at field index */
export const envSet = (envVar, fieldIdx, val) =>
  `(f64.store (i32.add (call $__ptr_offset (local.get ${envVar})) (i32.const ${fieldIdx * 8})) ${val})`

// === Closures ===

/**
 * Generate complete closure call with setup.
 * Closure encoding: NaN-box with [0x7FF][envLen:4][tableIdx:16][envOffset:32]
 * Extract envLen and offset to create env pointer for the call.
 */
export function callClosure(ctx, closureWat, argWats, numArgs) {
  if (!ctx.usedFuncTypes) ctx.usedFuncTypes = new Set()
  ctx.usedFuncTypes.add(numArgs)
  ctx.usedFuncTable = true
  ctx.usedMemory = true

  const id = ctx.loopCounter++
  const tmpClosure = `$_clos_${id}`
  const tmpI64 = `$_closi64_${id}`
  ctx.addLocal(tmpClosure.slice(1), 'f64')
  ctx.localDecls.push(`(local ${tmpI64} i64)`)

  // Extract from NaN-boxed closure:
  // - envLen: bits 48-51 (shifted by 48, masked to 0xF)
  // - tableIdx: bits 32-47 (shifted by 32, masked to 0xFFFF)
  // - envOffset: bits 0-31
  const argSection = argWats ? `\n        ${argWats}` : ''
  return `(block (result f64)
      (local.set ${tmpClosure} ${closureWat})
      (local.set ${tmpI64} (i64.reinterpret_f64 (local.get ${tmpClosure})))
      (call_indirect (type $fntype${numArgs})
        (call $__mkptr (i32.const ${PTR_TYPE.CLOSURE}) (i32.const 0)
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get ${tmpI64}) (i64.const 48))) (i32.const 0xF))
          (i32.wrap_i64 (local.get ${tmpI64})))${argSection}
        (i32.and (i32.wrap_i64 (i64.shr_u (local.get ${tmpI64}) (i64.const 32))) (i32.const 0xFFFF))))`
}
