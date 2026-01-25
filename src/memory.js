/**
 * Memory abstraction layer for jz compiler
 *
 * All operations use linear memory with NaN-boxed pointers.
 * Pointer format: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
 * Payload: [type:3][aux:16][offset:32]
 */

import { PTR_TYPE, ATOM_KIND, ELEM_TYPE, ELEM_STRIDE, HEAP_START, STRING_STRIDE, F64_SIZE, wat, f64, isHeapRef, isString, isObject } from './types.js'

// === Null/undefined ===
// Both map to f64(0) at runtime - they are indistinguishable
// This is a documented limitation for zero-overhead semantics
// ATOM type (0) is reserved for future use (e.g., Symbol)

/** Create null reference - f64 zero (indistinguishable from undefined) */
export const nullRef = () => wat('(f64.const 0)', 'f64')

/** Create undefined reference - f64 zero (indistinguishable from null) */
export const undefRef = () => wat('(f64.const 0)', 'f64')

// === Strings ===

/**
 * Check if string can use SSO (Short String Optimization)
 * Requires: length ≤6, all chars are 7-bit ASCII (0-127)
 */
function canSSO(str) {
  if (str.length > 6) return false
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) return false
  }
  return true
}

/**
 * Pack string into SSO pointer bits
 * Format: [sso:1][len:3][char5:7][char4:7][char3:7][char2:7][char1:7][char0:7] = 1+3+42 = 46 bits
 * We use aux (16 bits) + offset (32 bits) = 48 bits total
 * Layout: aux = [sso:1][len:3][char5_hi:4][char4:7][char3_lo:1], offset = [char3_hi:6][char2:7][char1:7][char0:7][pad:5]
 *
 * Simpler approach: pack into 47 bits as one big integer
 * aux = 0x8000 | ((data >> 32) & 0x7FFF)  [sso flag + 15 bits of data]
 * offset = data & 0xFFFFFFFF              [32 bits of data]
 */
function packSSO(str) {
  // Pack: len (3 bits) + chars (7 bits each), LSB first
  let data = BigInt(str.length)  // 3 bits for length (0-6)
  for (let i = 0; i < str.length; i++) {
    data |= BigInt(str.charCodeAt(i)) << BigInt(3 + i * 7)
  }
  // data is now max 3 + 6*7 = 45 bits
  const aux = 0x8000 | Number((data >> 32n) & 0x7FFFn)
  const offset = Number(data & 0xFFFFFFFFn)
  return { aux, offset }
}

/**
 * Create string from interned data or SSO
 * SSO: strings ≤6 ASCII chars packed in pointer (no memory allocation)
 * Heap: longer strings stored at HEAP_START + id*STRING_STRIDE
 */
export function mkString(ctx, str) {
  // Try SSO for short ASCII strings
  if (canSSO(str)) {
    const { aux, offset } = packSSO(str)
    // SSO needs $__mkptr but not memory allocation
    ctx.usedMemory = true  // $__mkptr is in memory helpers
    return wat(`(call $__mkptr (i32.const ${PTR_TYPE.STRING}) (i32.const ${aux}) (i32.const ${offset}))`, 'string')
  }

  // Heap string: intern and store in memory
  ctx.usedStringType = true
  ctx.usedMemory = true
  const { id } = ctx.internString(str)
  // Memory layout: [len:i32 + 4 pad][chars...] at HEAP_START + id*STRING_STRIDE
  // Pointer offset points to char data (after 8-byte header)
  const offset = HEAP_START + id * STRING_STRIDE + 8
  // NaN boxing: mkptr(type, aux=0, offset) - aux=0 means heap string (sso bit not set)
  return wat(`(call $__mkptr (i32.const ${PTR_TYPE.STRING}) (i32.const 0) (i32.const ${offset}))`, 'string')
}

/** Get string length - handles both SSO and heap strings */
export const strLen = (w) => `(call $__str_len ${w})`

/** Get char at index - handles both SSO and heap strings */
export const strCharAt = (w, idx) => `(call $__str_char_at ${w} ${idx})`

/** Convert SSO string to heap (for operations requiring memory access) */
export const ssoToHeap = (w) => `(call $__sso_to_heap ${w})`

/** Set char at index - only works for heap strings (SSO is immutable) */
export const strSetChar = (w, idx, val) =>
  `(i32.store16 (i32.add (call $__ptr_offset ${w}) (i32.shl ${idx} (i32.const 1))) ${val})`

/** Allocate dynamic-sized string (always heap, not SSO) */
export const strNew = (lenWat) =>
  `(call $__alloc (i32.const ${PTR_TYPE.STRING}) ${lenWat})`

/** Copy substring: copies len chars from src[srcIdx] to dst[dstIdx] - handles SSO source */
export const strCopy = (dstPtr, dstIdx, srcPtr, srcIdx, len) =>
  `(call $__str_copy ${dstPtr} ${dstIdx} ${srcPtr} ${srcIdx} ${len})`

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

/** Get array length from pointer (generic, dispatches on type) */
export const arrLen = (w) => `(call $__ptr_len ${w})`

/** Get array length directly (for when we KNOW it's an array, skip type check) */
export const directArrLen = (w) => `(i32.trunc_f64_s (f64.load (i32.sub (call $__ptr_offset ${w}) (i32.const 8))))`

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

/** Update array length in memory header - for filter/splice where actual < allocated */
export const ptrSetLen = (ptrWat, newLenWat) =>
  `(call $__ptr_set_len ${ptrWat} ${newLenWat})`

/** Create pointer with modified length - DEPRECATED, use ptrSetLen for arrays */
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

// === Ring Buffers (type=2) ===
// Pointer: [type:4][0:16][offset:31]
// Memory: [-16:head][-8:len][slots...]
// O(1) push/pop/shift/unshift via circular indexing

/** Allocate ring buffer */
export const ringNew = (lenWat) =>
  `(call $__alloc_ring ${lenWat})`

/** Get ring buffer length */
export const ringLen = (w) => `(call $__ring_len ${w})`

/** Get ring buffer element: slots[(head + i) & mask] */
export const ringGet = (w, idx) => `(call $__ring_get ${w} ${idx})`

/** Set ring buffer element */
export const ringSet = (w, idx, val) => `(call $__ring_set ${w} ${idx} ${val})`

/** Push to ring buffer end (O(1)), returns updated pointer */
export const ringPush = (w, val) => `(call $__ring_push ${w} ${val})`

/** Pop from ring buffer end (O(1)), returns element */
export const ringPop = (w) => `(call $__ring_pop ${w})`

/** Shift from ring buffer start (O(1)), returns element */
export const ringShift = (w) => `(call $__ring_shift ${w})`

/** Unshift to ring buffer start (O(1)), returns updated pointer */
export const ringUnshift = (w, val) => `(call $__ring_unshift ${w} ${val})`

// === TypedArrays ===
// Pointer format: [type:4][elemType:3][len:22][offset:22]
// Compact encoding: 4M elements, 4MB addressable (sufficient for typed arrays)
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
    // Static f64 array - store in data segment with C-style header
    const arrayId = Object.keys(ctx.staticArrays).length
    const values = elements.map(evalConstant)
    // Layout: [length:f64][elem0, elem1, ...], pointer points to elem0
    const headerOffset = HEAP_START + 4096 + (arrayId * 72)  // 8 byte header + 64 bytes data
    const dataOffset = headerOffset + 8
    ctx.staticArrays[arrayId] = { offset: headerOffset, values, headerSize: 8 }
    // NaN boxing: mkptr(type, schemaId=0, offset to data)
    return wat(`(call $__mkptr (i32.const ${PTR_TYPE.ARRAY}) (i32.const 0) (i32.const ${dataOffset}))`, 'array', values.map(() => ({ type: 'f64' })))
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

// === Environment (closures - read only, capture by value) ===

/** Read from environment memory at field index */
export const envGet = (envVar, fieldIdx) =>
  `(f64.load (i32.add (call $__ptr_offset (local.get ${envVar})) (i32.const ${fieldIdx * 8})))`

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
