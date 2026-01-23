/**
 * Memory abstraction layer for jz compiler
 *
 * All operations use linear memory with NaN-boxed pointers.
 * Pointer format: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
 * Payload: [type:4][id:16][offset:31]
 */

import { PTR_TYPE, ELEM_TYPE, ELEM_STRIDE, INSTANCE_TABLE_END, STRING_STRIDE, F64_SIZE, wat, f64, isHeapRef, isString, isObject } from './types.js'

// === Null/undefined ===

/** Create null reference (f64 0) */
export const nullRef = () => wat('(f64.const 0)', 'f64')

// === Strings ===

/** Create string from interned data. Strings are stored at instanceTableEnd + id*STRING_STRIDE */
export function mkString(ctx, str) {
  ctx.usedStringType = true
  ctx.usedMemory = true
  const { id, length } = ctx.internString(str)
  const offset = INSTANCE_TABLE_END + id * STRING_STRIDE  // After instance table
  // NaN boxing: mkptr(type, id, offset) - for string, id = length
  return wat(`(call $__mkptr (i32.const ${PTR_TYPE.STRING}) (i32.const ${length}) (i32.const ${offset}))`, 'string')
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

/** Copy substring: copies len chars from src[srcIdx] to dst[dstIdx] */
export const strCopy = (dstPtr, dstIdx, srcPtr, srcIdx, len) =>
  `(memory.copy (i32.add (call $__ptr_offset ${dstPtr}) (i32.shl ${dstIdx} (i32.const 1))) (i32.add (call $__ptr_offset ${srcPtr}) (i32.shl ${srcIdx} (i32.const 1))) (i32.shl ${len} (i32.const 1)))`

/**
 * Generate prefix/suffix match check - used by startsWith/endsWith
 * @param {Object} ctx - Compilation context
 * @param {string} strWat - String pointer expression
 * @param {string} searchWat - Search string pointer expression
 * @param {number} offset - 0 for prefix (startsWith), -1 for suffix (endsWith)
 * @returns {string} WAT code returning i32 (1 if match, 0 if not)
 */
export function genPrefixMatch(ctx, strWat, searchWat, offset = 0) {
  const id = ctx.loopCounter++
  const str = `$_pfx_str_${id}`, search = `$_pfx_srch_${id}`
  const idx = `$_pfx_i_${id}`, len = `$_pfx_len_${id}`, searchLen = `$_pfx_slen_${id}`, off = `$_pfx_off_${id}`
  ctx.addLocal(str, 'string')
  ctx.addLocal(search, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(searchLen, 'i32')
  if (offset !== 0) ctx.addLocal(off, 'i32')
  
  const strIdx = offset === 0 ? `(local.get ${idx})` : `(i32.add (local.get ${off}) (local.get ${idx}))`
  const offsetInit = offset === 0 ? '' : `(local.set ${off} (i32.sub (local.get ${len}) (local.get ${searchLen})))\n      `
  
  return `(local.set ${str} ${strWat})
    (local.set ${search} ${searchWat})
    (local.set ${len} ${strLen(`(local.get ${str})`)})
    (local.set ${searchLen} ${strLen(`(local.get ${search})`)})
    (if (result i32) (i32.gt_s (local.get ${searchLen}) (local.get ${len}))
      (then (i32.const 0))
      (else (block (result i32)
        ${offsetInit}(local.set ${idx} (i32.const 0))
        (block $fail_${id} (result i32)
          (block $done_${id}
            (loop $loop_${id}
              (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${searchLen})))
              (if (i32.ne ${strCharAt(`(local.get ${str})`, strIdx)} ${strCharAt(`(local.get ${search})`, `(local.get ${idx})`)})
                (then (br $fail_${id} (i32.const 0))))
              (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
              (br $loop_${id})))
          (i32.const 1)))))`
}

/**
 * Generate substring search loop - used by indexOf, includes, lastIndexOf
 * @param {Object} ctx - Compilation context
 * @param {string} strWat - String pointer expression  
 * @param {string} searchWat - Search string pointer expression
 * @param {string} resultFound - Expression for when found (e.g. '{idx}' or '(i32.const 1)')
 * @param {string} resultNotFound - Expression for not found (e.g. '(i32.const -1)' or '(i32.const 0)')
 * @returns {string} WAT code for substring search
 */
export function genSubstringSearch(ctx, strWat, searchWat, resultFound, resultNotFound) {
  const id = ctx.loopCounter++
  const str = `$_ssrch_str_${id}`, search = `$_ssrch_srch_${id}`
  const idx = `$_ssrch_i_${id}`, len = `$_ssrch_len_${id}`, searchLen = `$_ssrch_slen_${id}`
  const j = `$_ssrch_j_${id}`, match = `$_ssrch_match_${id}`
  ctx.addLocal(str, 'string')
  ctx.addLocal(search, 'string')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(searchLen, 'i32')
  ctx.addLocal(j, 'i32')
  ctx.addLocal(match, 'i32')
  
  const resolvedFound = resultFound.replace(/\{idx\}/g, `(local.get ${idx})`)
  
  return `(local.set ${str} ${strWat})
    (local.set ${search} ${searchWat})
    (local.set ${len} ${strLen(`(local.get ${str})`)})
    (local.set ${searchLen} ${strLen(`(local.get ${search})`)})
    (if (result i32) (i32.eqz (local.get ${searchLen}))
      (then ${resultFound.includes('{idx}') ? '(i32.const 0)' : resultFound.replace(/\{idx\}/g, '(i32.const 0)')})
      (else (if (result i32) (i32.gt_s (local.get ${searchLen}) (local.get ${len}))
        (then ${resultNotFound})
        (else (block (result i32)
          (local.set ${idx} (i32.const 0))
          (block $found_${id} (result i32)
            (block $done_${id}
              (loop $loop_${id}
                (br_if $done_${id} (i32.gt_s (local.get ${idx}) (i32.sub (local.get ${len}) (local.get ${searchLen}))))
                (local.set ${match} (i32.const 1))
                (local.set ${j} (i32.const 0))
                (block $inner_done_${id} (loop $inner_${id}
                  (br_if $inner_done_${id} (i32.ge_s (local.get ${j}) (local.get ${searchLen})))
                  (if (i32.ne ${strCharAt(`(local.get ${str})`, `(i32.add (local.get ${idx}) (local.get ${j}))`)} ${strCharAt(`(local.get ${search})`, `(local.get ${j})`)})
                    (then (local.set ${match} (i32.const 0)) (br $inner_done_${id})))
                  (local.set ${j} (i32.add (local.get ${j}) (i32.const 1)))
                  (br $inner_${id})))
                (if (local.get ${match}) (then (br $found_${id} ${resolvedFound})))
                (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
                (br $loop_${id})))
            ${resultNotFound}))))))`
}

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
  `(call $__alloc (i32.const ${PTR_TYPE.ARRAY}) ${lenWat})`

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

// === TypedArrays ===
// Pointer format: [type:4][elemType:3][len:22][offset:22]
// Uses bump allocator in dedicated region at end of heap

/** WASM load/store ops per element type */
const TYPED_LOAD = ['i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u', 'i32.load', 'i32.load', 'f32.load', 'f64.load']
const TYPED_STORE = ['i32.store8', 'i32.store8', 'i32.store16', 'i32.store16', 'i32.store', 'i32.store', 'f32.store', 'f64.store']
/** Shift amounts for offset calculation: log2(stride) */
const TYPED_SHIFT = [0, 0, 1, 1, 2, 2, 2, 3]

/** Allocate TypedArray: returns pointer with embedded elemType/len/offset */
export const typedArrNew = (elemType, lenWat) =>
  `(call $__alloc_typed (i32.const ${elemType}) ${lenWat})`

/** Get TypedArray length from pointer (bits 22-43) */
export const typedArrLen = (w) => `(call $__typed_len ${w})`

/** Get TypedArray offset from pointer (bits 0-21) */
export const typedArrOffset = (w) => `(call $__typed_offset ${w})`

/** Get TypedArray elemType from pointer (bits 44-46) */
export const typedArrElemType = (w) => `(call $__typed_elemtype ${w})`

/** Get element from TypedArray (compile-time known elemType) */
export function typedArrGet(elemType, ptrWat, idxWat) {
  const shift = TYPED_SHIFT[elemType]
  const load = TYPED_LOAD[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (call $__typed_offset ${ptrWat}) ${idxWat})`
    : `(i32.add (call $__typed_offset ${ptrWat}) (i32.shl ${idxWat} (i32.const ${shift})))`
  // Convert to f64 for uniform return type
  if (elemType === ELEM_TYPE.F64) return `(${load} ${offsetCalc})`
  if (elemType === ELEM_TYPE.F32) return `(f64.promote_f32 (${load} ${offsetCalc}))`
  return `(f64.convert_i32_s (${load} ${offsetCalc}))`
}

/** Set element in TypedArray (compile-time known elemType) */
export function typedArrSet(elemType, ptrWat, idxWat, valWat) {
  const shift = TYPED_SHIFT[elemType]
  const store = TYPED_STORE[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (call $__typed_offset ${ptrWat}) ${idxWat})`
    : `(i32.add (call $__typed_offset ${ptrWat}) (i32.shl ${idxWat} (i32.const ${shift})))`
  // Convert from f64 to target type
  if (elemType === ELEM_TYPE.F64) return `(${store} ${offsetCalc} ${valWat})`
  if (elemType === ELEM_TYPE.F32) return `(${store} ${offsetCalc} (f32.demote_f64 ${valWat}))`
  return `(${store} ${offsetCalc} (i32.trunc_f64_s ${valWat}))`
}

/**
 * Create array literal from generated values
 */
export function mkArrayLiteral(ctx, gens, isConstant, evalConstant, elements) {
  const hasRefTypes = gens.some(g => isHeapRef(g) || isString(g))
  ctx.usedMemory = true

  const isStatic = elements.every(isConstant)
  if (isStatic && !hasRefTypes) {
    // Static f64 array - store in data segment (after instance table)
    const arrayId = Object.keys(ctx.staticArrays).length
    const values = elements.map(evalConstant)
    const offset = INSTANCE_TABLE_END + 4096 + (arrayId * 64)
    ctx.staticArrays[arrayId] = { offset, values }
    // NaN boxing: mkptr(type, id, offset) - for array, id = length
    return wat(`(call $__mkptr (i32.const ${PTR_TYPE.ARRAY}) (i32.const ${values.length}) (i32.const ${offset}))`, 'array', values.map(() => ({ type: 'f64' })))
  } else if (hasRefTypes) {
    // Mixed-type array: still use ARRAY type but track schema for element types
    const id = ctx.uniqueId++
    const tmp = `$_arr_${id}`
    ctx.addLocal(tmp, 'f64')
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
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.ARRAY}) (i32.const ${gens.length})))
      ${stores}(local.get ${tmp}))`, 'array', elementSchema)
  } else {
    // Dynamic homogeneous f64 array
    const id = ctx.uniqueId++
    const tmp = `$_arr_${id}`
    ctx.addLocal(tmp, 'f64')
    let stores = ''
    for (let i = 0; i < gens.length; i++) {
      stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${f64(gens[i])})\n      `
    }
    return wat(`(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.ARRAY}) (i32.const ${gens.length})))
      ${stores}(local.get ${tmp}))`, 'array', gens.map(() => ({ type: 'f64' })))
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

  const id = ctx.uniqueId++
  const tmpClosure = `$_clos_${id}`
  const tmpI64 = `$_closi64_${id}`
  ctx.addLocal(tmpClosure, 'f64')
  ctx.localDecls.push(`(local ${tmpI64} i64)`)

  // Extract from NaN-boxed closure (new v5 format):
  // Payload: [type:4][id:16][offset:31]
  // For closure: id = envLen (stored in compile.js), but we need funcIdx separately
  // Actually, closure is stored as: NaN-box with [0x7FF0][tableIdx:16][envLen:16][envOffset:20]
  // This encoding is done in genClosureValue() - let's match that
  // bits 32-47: tableIdx, bits 48-63: envLen (within 0x7FF0), bits 0-31: envOffset
  const argSection = argWats ? `\n        ${argWats}` : ''
  return `(block (result f64)
      (local.set ${tmpClosure} ${closureWat})
      (local.set ${tmpI64} (i64.reinterpret_f64 (local.get ${tmpClosure})))
      (call_indirect (type $fntype${numArgs})
        (call $__mkptr (i32.const ${PTR_TYPE.CLOSURE})
          (i32.and (i32.wrap_i64 (i64.shr_u (local.get ${tmpI64}) (i64.const 48))) (i32.const 0xFFFF))
          (i32.wrap_i64 (local.get ${tmpI64})))${argSection}
        (i32.and (i32.wrap_i64 (i64.shr_u (local.get ${tmpI64}) (i64.const 32))) (i32.const 0xFFFF))))`
}
