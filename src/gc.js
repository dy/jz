/**
 * GC-mode abstraction layer for jz compiler
 *
 * Provides unified API for operations that differ between:
 * - gc:true (WASM GC with structs/arrays)
 * - gc:false (linear memory with NaN-boxing)
 *
 * All functions take gc flag and return appropriate WAT code.
 */

import { PTR_TYPE, tv, asF64, typeOf, isHeapRef, isString, isObject } from './types.js'

// === Null/undefined ===

/** Create null reference */
export const nullRef = (gc) => gc
  ? tv('ref', '(ref.null none)')
  : tv('f64', '(f64.const 0)')

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

/** Get array element with typed value return - auto-sets ctx flags */
export function arrGetTv(ctx, gc, arrWat, idxWat) {
  if (gc) {
    ctx.usedArrayType = true
    return tv('f64', `(array.get $f64array ${arrWat} ${idxWat})`)
  } else {
    ctx.usedMemory = true
    return tv('f64', `(f64.load (i32.add (call $__ptr_offset ${arrWat}) (i32.shl ${idxWat} (i32.const 3))))`)
  }
}

/**
 * Create array literal from generated values - handles all array literal cases
 * @param {Object} ctx - compilation context
 * @param {boolean} gc - gc mode flag
 * @param {Array} gens - array of typed values [type, wat, schema?]
 * @param {Function} isConstant - check if AST node is constant
 * @param {Function} evalConstant - evaluate constant AST node
 * @param {Array} elements - original AST elements (for static array optimization)
 */
export function mkArrayLiteralTv(ctx, gc, gens, isConstant, evalConstant, elements) {
  const hasRefTypes = gens.some(g => isHeapRef(g) || isString(g))

  if (gc) {
    if (hasRefTypes) {
      // gc:true with nested refs: use $anyarray (array of anyref)
      ctx.usedArrayType = true
      ctx.usedRefArrayType = true
      const vals = gens.map(g => {
        if (isHeapRef(g) || isString(g)) return g[1]
        // Wrap scalar in single-element f64 array
        ctx.usedArrayType = true
        return `(array.new_fixed $f64array 1 ${asF64(g)[1]})`
      })
      const elementSchemas = gens.map(g => ({ type: typeOf(g), schema: g[2] }))
      return tv('refarray', `(array.new_fixed $anyarray ${vals.length} ${vals.join(' ')})`, elementSchemas)
    } else {
      // gc:true: homogeneous f64 array
      ctx.usedArrayType = true
      const vals = gens.map(g => asF64(g)[1])
      return tv('array', `(array.new_fixed $f64array ${vals.length} ${vals.join(' ')})`)
    }
  } else {
    // gc:false: all values are f64 (either normal floats or NaN-encoded pointers)
    const isStatic = elements.every(isConstant)
    if (isStatic && !hasRefTypes) {
      // Static f64 array - store in data segment
      ctx.usedMemory = true
      const arrayId = Object.keys(ctx.staticArrays).length
      const values = elements.map(evalConstant)
      const offset = 4096 + (arrayId * 64)
      ctx.staticArrays[arrayId] = { offset, values }
      return tv('f64', `(call $__mkptr (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const ${values.length}) (i32.const ${offset}))`, values.map(() => ({ type: 'f64' })))
    } else if (hasRefTypes) {
      // Mixed-type array: REF_ARRAY stores 8-byte slots
      ctx.usedMemory = true
      const id = ctx.loopCounter++
      const tmp = `$_arr_${id}`
      ctx.addLocal(tmp.slice(1), 'f64')
      let stores = ''
      const elementSchema = []
      for (let i = 0; i < gens.length; i++) {
        const [type, w, schemaId] = gens[i]
        const val = (type === 'array' || type === 'object' || type === 'string') ? w : asF64(gens[i])[1]
        stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${val})\n      `
        if (isObject(gens[i]) && schemaId !== undefined) elementSchema.push({ type: 'object', id: schemaId })
        else elementSchema.push({ type })
      }
      return tv('f64', `(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.REF_ARRAY}) (i32.const ${gens.length})))
      ${stores}(local.get ${tmp}))`, elementSchema)
    } else {
      // Dynamic homogeneous f64 array
      ctx.usedMemory = true
      const id = ctx.loopCounter++
      const tmp = `$_arr_${id}`
      ctx.addLocal(tmp.slice(1), 'f64')
      let stores = ''
      for (let i = 0; i < gens.length; i++) {
        stores += `(f64.store (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${i * 8})) ${asF64(gens[i])[1]})\n      `
      }
      return tv('f64', `(block (result f64)
      (local.set ${tmp} (call $__alloc (i32.const ${PTR_TYPE.F64_ARRAY}) (i32.const ${gens.length})))
      ${stores}(local.get ${tmp}))`, gens.map(() => ({ type: 'f64' })))
    }
  }
}

// === Objects ===

/** Get object property by index */
export const objGet = (gc, wat, idx) => gc
  ? `(array.get $f64array ${wat} (i32.const ${idx}))`
  : `(f64.load (i32.add (call $__ptr_offset ${wat}) (i32.const ${idx * 8})))`

// === Environment (closures) ===

/** Check if type is a reference type that needs anyref storage */
export const isRefType = (type) =>
  type === 'array' || type === 'object' || type === 'string' || type === 'refarray' || type === 'closure'

/** Get WASM type for casting anyref to specific type */
const refCastType = (type) =>
  type === 'array' ? '(ref null $f64array)'
  : type === 'object' ? '(ref null $f64array)'  // objects use f64array
  : type === 'string' ? '(ref null $string)'
  : type === 'refarray' ? '(ref null $anyarray)'
  : type === 'closure' ? '(ref null $closure)'
  : null

/** Read from environment struct/memory at field index
 * @param {boolean} gc - gc mode
 * @param {string} envType - env struct type name
 * @param {string} envVar - local variable name for env
 * @param {number} fieldIdx - field index
 * @param {string} [fieldType] - type of field (for gc:true anyref handling)
 */
export const envGet = (gc, envType, envVar, fieldIdx, fieldType = 'f64') => {
  if (!gc) return `(f64.load (i32.add (call $__ptr_offset (local.get ${envVar})) (i32.const ${fieldIdx * 8})))`
  const get = `(struct.get ${envType} ${fieldIdx} (local.get ${envVar}))`
  // For reference types, cast from anyref to the specific type
  const castType = refCastType(fieldType)
  return castType ? `(ref.cast ${castType} ${get})` : get
}

/** Write to environment struct/memory at field index */
export const envSet = (gc, envType, envVar, fieldIdx, val) => gc
  ? `(struct.set ${envType} ${fieldIdx} (local.get ${envVar}) ${val})`
  : `(f64.store (i32.add (call $__ptr_offset (local.get ${envVar})) (i32.const ${fieldIdx * 8})) ${val})`

// === Closures ===

/**
 * Generate complete closure call with setup
 * @param {Object} ctx - compilation context
 * @param {boolean} gc - gc mode
 * @param {string} closureWat - WAT expression for closure value
 * @param {string} argWats - space-separated argument WATs
 * @param {number} numArgs - number of arguments
 * @param {boolean} [isNullable=true] - whether closure might be null (gc:true only)
 * @param {boolean} [returnsClosure=false] - whether call returns a closure (for currying)
 * @returns {string} complete WAT block expression
 */
export function callClosure(ctx, gc, closureWat, argWats, numArgs, isNullable = true, returnsClosure = false) {
  const funcTypeName = returnsClosure ? `$clfntype${numArgs}` : `$fntype${numArgs}`
  if (!ctx.usedFuncTypes) ctx.usedFuncTypes = new Set()
  ctx.usedFuncTypes.add(numArgs)
  if (returnsClosure) {
    if (!ctx.usedClFuncTypes) ctx.usedClFuncTypes = new Set()
    ctx.usedClFuncTypes.add(numArgs)
  }

  const id = ctx.loopCounter++

  if (gc) {
    ctx.usedClosureType = true
    const tmpClosure = `$_clos_${id}`
    ctx.addLocal(tmpClosure.slice(1), 'closure')
    const closureRef = isNullable
      ? `(ref.as_non_null (local.get ${tmpClosure}))`
      : `(local.get ${tmpClosure})`
    const resultType = returnsClosure ? '(ref null $closure)' : 'f64'
    const callExpr = `(call_ref ${funcTypeName}
        (struct.get $closure $env ${closureRef})
        ${argWats}
        (ref.cast (ref ${funcTypeName}) (struct.get $closure $fn ${closureRef})))`
    return returnsClosure
      ? `(block (result ${resultType})
      (local.set ${tmpClosure} ${closureWat})
      (ref.cast (ref null $closure) ${callExpr}))`
      : `(block (result f64)
      (local.set ${tmpClosure} ${closureWat})
      ${callExpr})`
  } else {
    ctx.usedFuncTable = true
    ctx.usedMemory = true
    const tmpClosure = `$_clos_${id}`
    const tmpI64 = `$_closi64_${id}`
    ctx.addLocal(tmpClosure.slice(1), 'f64')
    ctx.localDecls.push(`(local ${tmpI64} i64)`)
    // gc:false always returns f64 (closure is NaN-boxed f64)
    return `(block (result f64)
      (local.set ${tmpClosure} ${closureWat})
      (local.set ${tmpI64} (i64.reinterpret_f64 (local.get ${tmpClosure})))
      (call_indirect (type $fntype${numArgs})
        (call $__mkptr (i32.const ${PTR_TYPE.CLOSURE})
          (i32.wrap_i64 (i64.shr_u (local.get ${tmpI64}) (i64.const 48)))
          (i32.wrap_i64 (local.get ${tmpI64})))
        ${argWats}
        (i32.wrap_i64 (i64.and (i64.shr_u (local.get ${tmpI64}) (i64.const 32)) (i64.const 0xFFFF)))))`
  }
}
