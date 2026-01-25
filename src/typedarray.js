// TypedArray method implementations
// All methods use compile-time known elemType for direct WASM instructions
// SIMD: Float64Array.map uses f64x2 vectorization for simple arithmetic callbacks

import { ctx, gen } from './compile.js'
import { ELEM_TYPE, ELEM_STRIDE, wat, f64, i32 } from './types.js'
import { extractParams } from './analyze.js'
import {
  typedArrNew, typedArrLen, typedArrOffset, typedArrGet, typedArrSet
} from './memory.js'

// WASM ops per element type
const TYPED_LOAD = ['i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u', 'i32.load', 'i32.load', 'f32.load', 'f64.load']
const TYPED_STORE = ['i32.store8', 'i32.store8', 'i32.store16', 'i32.store16', 'i32.store', 'i32.store', 'f32.store', 'f64.store']
const TYPED_SHIFT = [0, 0, 1, 1, 2, 2, 2, 3]

// ═══════════════════════════════════════════════════════════════════════════════
// SIMD Pattern Detection - analyze callback for vectorization
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyze callback body to extract SIMD-vectorizable pattern
 * Returns { op, const } for patterns like x*2, x+1, -x, Math.abs(x)
 * Returns null if not vectorizable
 *
 * Vectorizable patterns (param is the callback parameter name):
 * - x * c, c * x → { op: 'mul', const: c }
 * - x + c, c + x → { op: 'add', const: c }
 * - x - c        → { op: 'sub', const: c }
 * - x / c        → { op: 'div', const: c }
 * - -x           → { op: 'neg' }
 * - Math.abs(x)  → { op: 'abs' }
 * - Math.sqrt(x) → { op: 'sqrt' }
 * - Math.ceil(x) → { op: 'ceil' }
 * - Math.floor(x)→ { op: 'floor' }
 * Integer-only:
 * - x & c        → { op: 'and', const: c }
 * - x | c        → { op: 'or', const: c }
 * - x ^ c        → { op: 'xor', const: c }
 * - x << c       → { op: 'shl', const: c }
 * - x >> c       → { op: 'shr', const: c }
 * - x >>> c      → { op: 'shru', const: c }
 */
function analyzeSimdPattern(body, paramName) {
  if (!Array.isArray(body)) return null

  const [op, ...args] = body

  // Binary ops: x * c, x + c, etc.
  if ((op === '*' || op === '+' || op === '-' || op === '/') && args.length === 2) {
    const [a, b] = args
    const isParamA = a === paramName
    const isParamB = b === paramName
    const constA = !isParamA && isConstNum(a)
    const constB = !isParamB && isConstNum(b)

    // x * c or c * x
    if (op === '*' && ((isParamA && constB !== false) || (isParamB && constA !== false))) {
      return { op: 'mul', const: isParamA ? constB : constA }
    }
    // x + c or c + x
    if (op === '+' && ((isParamA && constB !== false) || (isParamB && constA !== false))) {
      return { op: 'add', const: isParamA ? constB : constA }
    }
    // x - c (not c - x, that's not simple)
    if (op === '-' && isParamA && constB !== false) {
      return { op: 'sub', const: constB }
    }
    // x / c (not c / x)
    if (op === '/' && isParamA && constB !== false) {
      return { op: 'div', const: constB }
    }
  }

  // Bitwise ops (integer SIMD): x & c, x | c, x ^ c, x << c, x >> c, x >>> c
  if ((op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>' || op === '>>>') && args.length === 2) {
    const [a, b] = args
    const isParamA = a === paramName
    const constB = !isParamA && isConstNum(b)

    if (isParamA && constB !== false) {
      if (op === '&') return { op: 'and', const: constB }
      if (op === '|') return { op: 'or', const: constB }
      if (op === '^') return { op: 'xor', const: constB }
      if (op === '<<') return { op: 'shl', const: constB }
      if (op === '>>') return { op: 'shr', const: constB }
      if (op === '>>>') return { op: 'shru', const: constB }
    }
  }

  // Unary minus: ['-', [null], x] or similar patterns from parser
  if (op === '-' && args.length === 2 && args[0] === null && args[1] === paramName) {
    return { op: 'neg' }
  }

  // Math.abs(x), Math.sqrt(x), etc.
  if (op === '(' && args.length === 2) {
    const [fn, fnArgs] = args
    if (Array.isArray(fn) && fn[0] === '.' && fn[1] === 'Math') {
      const method = fn[2]
      if (Array.isArray(fnArgs) && fnArgs.length === 1 && fnArgs[0] === paramName) {
        if (method === 'abs') return { op: 'abs' }
        if (method === 'sqrt') return { op: 'sqrt' }
        if (method === 'ceil') return { op: 'ceil' }
        if (method === 'floor') return { op: 'floor' }
      }
    }
  }

  return null
}

/** Check if AST node is a constant number, return value or false */
function isConstNum(node) {
  if (typeof node === 'number') return node
  // Handle string numbers from parser
  if (typeof node === 'string' && !isNaN(Number(node))) return Number(node)
  // Handle [null/undefined, number] wrapper from parser
  // Parser uses sparse arrays so node[0] may be undefined (empty item)
  if (Array.isArray(node) && node.length === 2 && (node[0] === null || node[0] === undefined) && typeof node[1] === 'number') {
    return node[1]
  }
  return false
}

/**
 * Generate SIMD f64x2 WAT for the operation
 * @param {string} vecReg - v128 local name
 * @param {object} pattern - { op, const? }
 * @returns {string} WAT code to transform vecReg in place
 */
function genSimdOpF64(vecReg, pattern) {
  const { op } = pattern
  const c = pattern.const

  switch (op) {
    case 'mul': return `(local.set ${vecReg} (f64x2.mul (local.get ${vecReg}) (f64x2.splat (f64.const ${c}))))`
    case 'add': return `(local.set ${vecReg} (f64x2.add (local.get ${vecReg}) (f64x2.splat (f64.const ${c}))))`
    case 'sub': return `(local.set ${vecReg} (f64x2.sub (local.get ${vecReg}) (f64x2.splat (f64.const ${c}))))`
    case 'div': return `(local.set ${vecReg} (f64x2.div (local.get ${vecReg}) (f64x2.splat (f64.const ${c}))))`
    case 'neg': return `(local.set ${vecReg} (f64x2.neg (local.get ${vecReg})))`
    case 'abs': return `(local.set ${vecReg} (f64x2.abs (local.get ${vecReg})))`
    case 'sqrt': return `(local.set ${vecReg} (f64x2.sqrt (local.get ${vecReg})))`
    case 'ceil': return `(local.set ${vecReg} (f64x2.ceil (local.get ${vecReg})))`
    case 'floor': return `(local.set ${vecReg} (f64x2.floor (local.get ${vecReg})))`
    default: throw new Error(`Unknown SIMD op: ${op}`)
  }
}

/**
 * Generate SIMD f32x4 WAT for the operation (4 elements per vector)
 * @param {string} vecReg - v128 local name
 * @param {object} pattern - { op, const? }
 * @returns {string} WAT code to transform vecReg in place
 */
function genSimdOpF32(vecReg, pattern) {
  const { op } = pattern
  const c = pattern.const

  switch (op) {
    case 'mul': return `(local.set ${vecReg} (f32x4.mul (local.get ${vecReg}) (f32x4.splat (f32.const ${c}))))`
    case 'add': return `(local.set ${vecReg} (f32x4.add (local.get ${vecReg}) (f32x4.splat (f32.const ${c}))))`
    case 'sub': return `(local.set ${vecReg} (f32x4.sub (local.get ${vecReg}) (f32x4.splat (f32.const ${c}))))`
    case 'div': return `(local.set ${vecReg} (f32x4.div (local.get ${vecReg}) (f32x4.splat (f32.const ${c}))))`
    case 'neg': return `(local.set ${vecReg} (f32x4.neg (local.get ${vecReg})))`
    case 'abs': return `(local.set ${vecReg} (f32x4.abs (local.get ${vecReg})))`
    case 'sqrt': return `(local.set ${vecReg} (f32x4.sqrt (local.get ${vecReg})))`
    case 'ceil': return `(local.set ${vecReg} (f32x4.ceil (local.get ${vecReg})))`
    case 'floor': return `(local.set ${vecReg} (f32x4.floor (local.get ${vecReg})))`
    default: throw new Error(`Unknown SIMD op: ${op}`)
  }
}

/**
 * Generate SIMD i32x4 WAT for the operation (4 elements per vector)
 * @param {string} vecReg - v128 local name
 * @param {object} pattern - { op, const? }
 * @returns {string} WAT code to transform vecReg in place
 */
function genSimdOpI32(vecReg, pattern) {
  const { op } = pattern
  const c = pattern.const

  switch (op) {
    case 'mul': return `(local.set ${vecReg} (i32x4.mul (local.get ${vecReg}) (i32x4.splat (i32.const ${c}))))`
    case 'add': return `(local.set ${vecReg} (i32x4.add (local.get ${vecReg}) (i32x4.splat (i32.const ${c}))))`
    case 'sub': return `(local.set ${vecReg} (i32x4.sub (local.get ${vecReg}) (i32x4.splat (i32.const ${c}))))`
    // No i32x4.div in WASM SIMD - falls back to scalar
    case 'neg': return `(local.set ${vecReg} (i32x4.neg (local.get ${vecReg})))`
    case 'abs': return `(local.set ${vecReg} (i32x4.abs (local.get ${vecReg})))`
    // Bitwise ops
    case 'and': return `(local.set ${vecReg} (v128.and (local.get ${vecReg}) (i32x4.splat (i32.const ${c}))))`
    case 'or': return `(local.set ${vecReg} (v128.or (local.get ${vecReg}) (i32x4.splat (i32.const ${c}))))`
    case 'xor': return `(local.set ${vecReg} (v128.xor (local.get ${vecReg}) (i32x4.splat (i32.const ${c}))))`
    case 'shl': return `(local.set ${vecReg} (i32x4.shl (local.get ${vecReg}) (i32.const ${c})))`
    case 'shr': return `(local.set ${vecReg} (i32x4.shr_s (local.get ${vecReg}) (i32.const ${c})))`
    case 'shru': return `(local.set ${vecReg} (i32x4.shr_u (local.get ${vecReg}) (i32.const ${c})))`
    default: throw new Error(`Unknown SIMD i32 op: ${op}`)
  }
}

/**
 * Generate scalar f64 WAT for the operation (for remainder)
 * @param {string} valLocal - f64 local name  
 * @param {object} pattern - { op, const? }
 * @returns {string} WAT expression producing f64 result
 */
function genScalarOpF64(valLocal, pattern) {
  const { op } = pattern
  const c = pattern.const

  switch (op) {
    case 'mul': return `(f64.mul (local.get ${valLocal}) (f64.const ${c}))`
    case 'add': return `(f64.add (local.get ${valLocal}) (f64.const ${c}))`
    case 'sub': return `(f64.sub (local.get ${valLocal}) (f64.const ${c}))`
    case 'div': return `(f64.div (local.get ${valLocal}) (f64.const ${c}))`
    case 'neg': return `(f64.neg (local.get ${valLocal}))`
    case 'abs': return `(f64.abs (local.get ${valLocal}))`
    case 'sqrt': return `(f64.sqrt (local.get ${valLocal}))`
    case 'ceil': return `(f64.ceil (local.get ${valLocal}))`
    case 'floor': return `(f64.floor (local.get ${valLocal}))`
    default: throw new Error(`Unknown scalar op: ${op}`)
  }
}

/**
 * Generate scalar f32 WAT for the operation (for remainder)
 * @param {string} valLocal - f32 local name  
 * @param {object} pattern - { op, const? }
 * @returns {string} WAT expression producing f32 result
 */
function genScalarOpF32(valLocal, pattern) {
  const { op } = pattern
  const c = pattern.const

  switch (op) {
    case 'mul': return `(f32.mul (local.get ${valLocal}) (f32.const ${c}))`
    case 'add': return `(f32.add (local.get ${valLocal}) (f32.const ${c}))`
    case 'sub': return `(f32.sub (local.get ${valLocal}) (f32.const ${c}))`
    case 'div': return `(f32.div (local.get ${valLocal}) (f32.const ${c}))`
    case 'neg': return `(f32.neg (local.get ${valLocal}))`
    case 'abs': return `(f32.abs (local.get ${valLocal}))`
    case 'sqrt': return `(f32.sqrt (local.get ${valLocal}))`
    case 'ceil': return `(f32.ceil (local.get ${valLocal}))`
    case 'floor': return `(f32.floor (local.get ${valLocal}))`
    default: throw new Error(`Unknown scalar op: ${op}`)
  }
}

/**
 * Generate scalar i32 WAT for the operation (for remainder)
 * @param {string} valLocal - i32 local name  
 * @param {object} pattern - { op, const? }
 * @returns {string} WAT expression producing i32 result
 */
function genScalarOpI32(valLocal, pattern) {
  const { op } = pattern
  const c = pattern.const

  switch (op) {
    case 'mul': return `(i32.mul (local.get ${valLocal}) (i32.const ${c}))`
    case 'add': return `(i32.add (local.get ${valLocal}) (i32.const ${c}))`
    case 'sub': return `(i32.sub (local.get ${valLocal}) (i32.const ${c}))`
    case 'neg': return `(i32.sub (i32.const 0) (local.get ${valLocal}))`
    case 'abs': return `(select (i32.sub (i32.const 0) (local.get ${valLocal})) (local.get ${valLocal}) (i32.lt_s (local.get ${valLocal}) (i32.const 0)))`
    case 'and': return `(i32.and (local.get ${valLocal}) (i32.const ${c}))`
    case 'or': return `(i32.or (local.get ${valLocal}) (i32.const ${c}))`
    case 'xor': return `(i32.xor (local.get ${valLocal}) (i32.const ${c}))`
    case 'shl': return `(i32.shl (local.get ${valLocal}) (i32.const ${c}))`
    case 'shr': return `(i32.shr_s (local.get ${valLocal}) (i32.const ${c}))`
    case 'shru': return `(i32.shr_u (local.get ${valLocal}) (i32.const ${c}))`
    default: throw new Error(`Unknown scalar i32 op: ${op}`)
  }
}

// Convert f64 to element type for store
const toElemType = (elemType, valWat) =>
  elemType === ELEM_TYPE.F64 ? valWat :
  elemType === ELEM_TYPE.F32 ? `(f32.demote_f64 ${valWat})` :
  `(i32.trunc_f64_s ${valWat})`

// Convert from element type to f64 for load
const fromElemType = (elemType, loadExpr) =>
  elemType === ELEM_TYPE.F64 ? loadExpr :
  elemType === ELEM_TYPE.F32 ? `(f64.promote_f32 ${loadExpr})` :
  `(f64.convert_i32_s ${loadExpr})`

// Calculate byte offset: base + idx * stride
const byteOffset = (elemType, baseWat, idxWat) => {
  const shift = TYPED_SHIFT[elemType]
  return shift === 0
    ? `(i32.add ${baseWat} ${idxWat})`
    : `(i32.add ${baseWat} (i32.shl ${idxWat} (i32.const ${shift})))`
}

/**
 * fill(value, start?, end?) - fill with value, returns this
 */
export const fill = (elemType, ptrWat, args) => {
  const valArg = args[0], startArg = args[1], endArg = args[2]
  const id = ctx.loopCounter++
  const arr = `$_fill_arr_${id}`, base = `$_fill_base_${id}`
  const idx = `$_fill_i_${id}`, end = `$_fill_end_${id}`, val = `$_fill_val_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(end, 'i32')
  ctx.addLocal(val, elemType === ELEM_TYPE.F64 ? 'f64' : elemType === ELEM_TYPE.F32 ? 'f32' : 'i32')

  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]
  const startInit = startArg ? i32(gen(startArg)) : '(i32.const 0)'
  const endInit = endArg ? i32(gen(endArg)) : `(call $__typed_len (local.get ${arr}))`
  const valInit = toElemType(elemType, f64(gen(valArg)))

  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${idx} ${startInit})
    (local.set ${end} ${endInit})
    (local.set ${val} ${valInit})
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${end})))
      (${store} ${offsetCalc} (local.get ${val}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${arr})`, 'typedarray', elemType)
}

/**
 * at(index) - get with negative indexing
 */
export const at = (elemType, ptrWat, args) => {
  const idxArg = args[0]
  const id = ctx.loopCounter++
  const arr = `$_at_arr_${id}`, idx = `$_at_idx_${id}`, len = `$_at_len_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (call $__typed_offset (local.get ${arr})) (local.get ${idx}))`
    : `(i32.add (call $__typed_offset (local.get ${arr})) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${idx} ${i32(gen(idxArg))})
    (if (i32.lt_s (local.get ${idx}) (i32.const 0))
      (then (local.set ${idx} (i32.add (local.get ${len}) (local.get ${idx})))))
    ${loadExpr}`, 'f64')
}

/**
 * indexOf(value, fromIndex?) - find first index of value
 */
export const indexOf = (elemType, ptrWat, args) => {
  const valArg = args[0], fromArg = args[1]
  const id = ctx.loopCounter++
  const arr = `$_idx_arr_${id}`, base = `$_idx_base_${id}`
  const idx = `$_idx_i_${id}`, len = `$_idx_len_${id}`, val = `$_idx_val_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(val, 'f64')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)
  const fromInit = fromArg ? i32(gen(fromArg)) : '(i32.const 0)'

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${idx} ${fromInit})
    (local.set ${val} ${f64(gen(valArg))})
    (block $found_${id} (result i32)
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          (if (f64.eq ${loadExpr} (local.get ${val}))
            (then (br $found_${id} (local.get ${idx}))))
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $loop_${id})))
      (i32.const -1))`, 'i32')
}

/**
 * lastIndexOf(value, fromIndex?) - find last index of value
 */
export const lastIndexOf = (elemType, ptrWat, args) => {
  const valArg = args[0], fromArg = args[1]
  const id = ctx.loopCounter++
  const arr = `$_lidx_arr_${id}`, base = `$_lidx_base_${id}`
  const idx = `$_lidx_i_${id}`, val = `$_lidx_val_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(val, 'f64')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)
  const fromInit = fromArg
    ? i32(gen(fromArg))
    : `(i32.sub (call $__typed_len (local.get ${arr})) (i32.const 1))`

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${idx} ${fromInit})
    (local.set ${val} ${f64(gen(valArg))})
    (block $found_${id} (result i32)
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.lt_s (local.get ${idx}) (i32.const 0)))
          (if (f64.eq ${loadExpr} (local.get ${val}))
            (then (br $found_${id} (local.get ${idx}))))
          (local.set ${idx} (i32.sub (local.get ${idx}) (i32.const 1)))
          (br $loop_${id})))
      (i32.const -1))`, 'i32')
}

/**
 * includes(value, fromIndex?) - check if contains value
 */
export const includes = (elemType, ptrWat, args) => {
  const valArg = args[0], fromArg = args[1]
  const id = ctx.loopCounter++
  const arr = `$_inc_arr_${id}`, base = `$_inc_base_${id}`
  const idx = `$_inc_i_${id}`, len = `$_inc_len_${id}`, val = `$_inc_val_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(val, 'f64')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)
  const fromInit = fromArg ? i32(gen(fromArg)) : '(i32.const 0)'

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${idx} ${fromInit})
    (local.set ${val} ${f64(gen(valArg))})
    (block $found_${id} (result i32)
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          (if (f64.eq ${loadExpr} (local.get ${val}))
            (then (br $found_${id} (i32.const 1))))
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $loop_${id})))
      (i32.const 0))`, 'i32')
}

/**
 * slice(begin?, end?) - create copy of portion
 */
export const slice = (elemType, ptrWat, args) => {
  const beginArg = args[0], endArg = args[1]
  const id = ctx.loopCounter++
  const src = `$_sl_src_${id}`, dst = `$_sl_dst_${id}`
  const srcBase = `$_sl_srcb_${id}`, dstBase = `$_sl_dstb_${id}`
  const idx = `$_sl_i_${id}`, begin = `$_sl_begin_${id}`, end = `$_sl_end_${id}`, len = `$_sl_len_${id}`

  ctx.addLocal(src, 'f64')
  ctx.addLocal(dst, 'f64')
  ctx.addLocal(srcBase, 'i32')
  ctx.addLocal(dstBase, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(begin, 'i32')
  ctx.addLocal(end, 'i32')
  ctx.addLocal(len, 'i32')

  const load = TYPED_LOAD[elemType]
  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]
  const srcOffset = shift === 0
    ? `(i32.add (local.get ${srcBase}) (i32.add (local.get ${begin}) (local.get ${idx})))`
    : `(i32.add (local.get ${srcBase}) (i32.shl (i32.add (local.get ${begin}) (local.get ${idx})) (i32.const ${shift})))`
  const dstOffset = shift === 0
    ? `(i32.add (local.get ${dstBase}) (local.get ${idx}))`
    : `(i32.add (local.get ${dstBase}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`

  const beginInit = beginArg ? i32(gen(beginArg)) : '(i32.const 0)'
  const endInit = endArg ? i32(gen(endArg)) : `(call $__typed_len (local.get ${src}))`

  // Wrap in block to make single expression (fixes local.tee/br issues)
  return wat(`(block (result f64) (local.set ${src} ${ptrWat})
    (local.set ${begin} ${beginInit})
    (local.set ${end} ${endInit})
    (if (i32.lt_s (local.get ${begin}) (i32.const 0))
      (then (local.set ${begin} (i32.add (call $__typed_len (local.get ${src})) (local.get ${begin})))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0))
      (then (local.set ${end} (i32.add (call $__typed_len (local.get ${src})) (local.get ${end})))))
    (local.set ${len} (i32.sub (local.get ${end}) (local.get ${begin})))
    (if (i32.lt_s (local.get ${len}) (i32.const 0))
      (then (local.set ${len} (i32.const 0))))
    (local.set ${dst} (call $__alloc_typed (i32.const ${elemType}) (local.get ${len})))
    (local.set ${srcBase} (call $__typed_offset (local.get ${src})))
    (local.set ${dstBase} (call $__typed_offset (local.get ${dst})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (${store} ${dstOffset} (${load} ${srcOffset}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${dst}))`, 'typedarray', elemType)
}

/**
 * subarray(begin?, end?) - create view (shares memory, new pointer with different offset/len)
 */
export const subarray = (elemType, ptrWat, args) => {
  const beginArg = args[0], endArg = args[1]
  const id = ctx.loopCounter++
  const src = `$_sub_src_${id}`
  const begin = `$_sub_begin_${id}`, end = `$_sub_end_${id}`, len = `$_sub_len_${id}`, srcLen = `$_sub_srclen_${id}`

  ctx.addLocal(src, 'f64')
  ctx.addLocal(begin, 'i32')
  ctx.addLocal(end, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(srcLen, 'i32')

  const stride = ELEM_STRIDE[elemType]
  const beginInit = beginArg ? i32(gen(beginArg)) : '(i32.const 0)'
  const endInit = endArg ? i32(gen(endArg)) : `(local.get ${srcLen})`

  // Create new pointer with adjusted offset and length
  // subarray shares memory, so we just compute new offset = srcOffset + begin * stride
  return wat(`(local.set ${src} ${ptrWat})
    (local.set ${srcLen} (call $__typed_len (local.get ${src})))
    (local.set ${begin} ${beginInit})
    (local.set ${end} ${endInit})
    (if (i32.lt_s (local.get ${begin}) (i32.const 0))
      (then (local.set ${begin} (i32.add (local.get ${srcLen}) (local.get ${begin})))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0))
      (then (local.set ${end} (i32.add (local.get ${srcLen}) (local.get ${end})))))
    (if (i32.gt_s (local.get ${begin}) (local.get ${srcLen}))
      (then (local.set ${begin} (local.get ${srcLen}))))
    (if (i32.gt_s (local.get ${end}) (local.get ${srcLen}))
      (then (local.set ${end} (local.get ${srcLen}))))
    (local.set ${len} (i32.sub (local.get ${end}) (local.get ${begin})))
    (if (i32.lt_s (local.get ${len}) (i32.const 0))
      (then (local.set ${len} (i32.const 0))))
    (call $__mk_typed_ptr (i32.const ${elemType}) (local.get ${len})
      (i32.add (call $__typed_offset (local.get ${src})) (i32.mul (local.get ${begin}) (i32.const ${stride}))))`, 'typedarray', elemType)
}

/**
 * reverse() - reverse in place, returns this
 */
export const reverse = (elemType, ptrWat, args) => {
  const id = ctx.loopCounter++
  const arr = `$_rev_arr_${id}`, base = `$_rev_base_${id}`
  const left = `$_rev_l_${id}`, right = `$_rev_r_${id}`
  const tmp = `$_rev_tmp_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(left, 'i32')
  ctx.addLocal(right, 'i32')
  const tmpType = elemType === ELEM_TYPE.F64 ? 'f64' : elemType === ELEM_TYPE.F32 ? 'f32' : 'i32'
  ctx.addLocal(tmp, tmpType)

  const load = TYPED_LOAD[elemType]
  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]
  const leftOffset = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${left}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${left}) (i32.const ${shift})))`
  const rightOffset = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${right}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${right}) (i32.const ${shift})))`

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${left} (i32.const 0))
    (local.set ${right} (i32.sub (call $__typed_len (local.get ${arr})) (i32.const 1)))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${left}) (local.get ${right})))
      (local.set ${tmp} (${load} ${leftOffset}))
      (${store} ${leftOffset} (${load} ${rightOffset}))
      (${store} ${rightOffset} (local.get ${tmp}))
      (local.set ${left} (i32.add (local.get ${left}) (i32.const 1)))
      (local.set ${right} (i32.sub (local.get ${right}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${arr})`, 'typedarray', elemType)
}

/**
 * copyWithin(target, start, end?) - copy within array
 */
export const copyWithin = (elemType, ptrWat, args) => {
  const targetArg = args[0], startArg = args[1], endArg = args[2]
  const id = ctx.loopCounter++
  const arr = `$_cw_arr_${id}`, base = `$_cw_base_${id}`
  const target = `$_cw_tgt_${id}`, start = `$_cw_start_${id}`, end = `$_cw_end_${id}`
  const len = `$_cw_len_${id}`, count = `$_cw_count_${id}`, idx = `$_cw_i_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(target, 'i32')
  ctx.addLocal(start, 'i32')
  ctx.addLocal(end, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(count, 'i32')
  ctx.addLocal(idx, 'i32')

  const load = TYPED_LOAD[elemType]
  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]
  const srcOffset = shift === 0
    ? `(i32.add (local.get ${base}) (i32.add (local.get ${start}) (local.get ${idx})))`
    : `(i32.add (local.get ${base}) (i32.shl (i32.add (local.get ${start}) (local.get ${idx})) (i32.const ${shift})))`
  const dstOffset = shift === 0
    ? `(i32.add (local.get ${base}) (i32.add (local.get ${target}) (local.get ${idx})))`
    : `(i32.add (local.get ${base}) (i32.shl (i32.add (local.get ${target}) (local.get ${idx})) (i32.const ${shift})))`

  const endInit = endArg ? i32(gen(endArg)) : `(local.get ${len})`

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${target} ${i32(gen(targetArg))})
    (local.set ${start} ${i32(gen(startArg))})
    (local.set ${end} ${endInit})
    (if (i32.lt_s (local.get ${target}) (i32.const 0))
      (then (local.set ${target} (i32.add (local.get ${len}) (local.get ${target})))))
    (if (i32.lt_s (local.get ${start}) (i32.const 0))
      (then (local.set ${start} (i32.add (local.get ${len}) (local.get ${start})))))
    (if (i32.lt_s (local.get ${end}) (i32.const 0))
      (then (local.set ${end} (i32.add (local.get ${len}) (local.get ${end})))))
    (local.set ${count} (i32.sub (local.get ${end}) (local.get ${start})))
    (if (i32.gt_s (i32.add (local.get ${target}) (local.get ${count})) (local.get ${len}))
      (then (local.set ${count} (i32.sub (local.get ${len}) (local.get ${target})))))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${count})))
      (${store} ${dstOffset} (${load} ${srcOffset}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${arr})`, 'typedarray', elemType)
}

/**
 * set(array, offset?) - copy from source array
 */
export const set = (elemType, ptrWat, args) => {
  const srcArg = args[0], offsetArg = args[1]
  const id = ctx.loopCounter++
  const dst = `$_set_dst_${id}`, src = `$_set_src_${id}`
  const dstBase = `$_set_dstb_${id}`, srcBase = `$_set_srcb_${id}`
  const offset = `$_set_off_${id}`, srcLen = `$_set_srclen_${id}`, idx = `$_set_i_${id}`

  ctx.addLocal(dst, 'f64')
  ctx.addLocal(src, 'f64')
  ctx.addLocal(dstBase, 'i32')
  ctx.addLocal(srcBase, 'i32')
  ctx.addLocal(offset, 'i32')
  ctx.addLocal(srcLen, 'i32')
  ctx.addLocal(idx, 'i32')

  const srcVal = gen(srcArg)
  const srcIsTypedArray = srcVal.type === 'typedarray'
  const srcElemType = srcVal.schema

  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]
  const dstOffset = shift === 0
    ? `(i32.add (local.get ${dstBase}) (i32.add (local.get ${offset}) (local.get ${idx})))`
    : `(i32.add (local.get ${dstBase}) (i32.shl (i32.add (local.get ${offset}) (local.get ${idx})) (i32.const ${shift})))`

  // Load from source - handle both regular array (f64) and TypedArray
  let srcLoadExpr
  let srcOffsetFn, srcLenFn
  if (srcIsTypedArray) {
    const srcShift = TYPED_SHIFT[srcElemType]
    const srcLoad = TYPED_LOAD[srcElemType]
    const srcOffset = srcShift === 0
      ? `(i32.add (local.get ${srcBase}) (local.get ${idx}))`
      : `(i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const ${srcShift})))`
    srcLoadExpr = fromElemType(srcElemType, `(${srcLoad} ${srcOffset})`)
    srcOffsetFn = '$__typed_offset'
    srcLenFn = '$__typed_len'
  } else {
    // Regular f64 array
    srcLoadExpr = `(f64.load (i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const 3))))`
    srcOffsetFn = '$__ptr_offset'
    srcLenFn = '$__ptr_len'
  }
  const storeVal = toElemType(elemType, srcLoadExpr)

  const offsetInit = offsetArg ? i32(gen(offsetArg)) : '(i32.const 0)'

  return wat(`(local.set ${dst} ${ptrWat})
    (local.set ${src} ${srcVal})
    (local.set ${dstBase} (call $__typed_offset (local.get ${dst})))
    (local.set ${srcBase} (call ${srcOffsetFn} (local.get ${src})))
    (local.set ${srcLen} (call ${srcLenFn} (local.get ${src})))
    (local.set ${offset} ${offsetInit})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${srcLen})))
      (${store} ${dstOffset} ${storeVal})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (f64.const 0)`, 'f64')  // set() returns undefined
}

/**
 * every(fn) - test if all elements pass predicate
 */
export const every = (elemType, ptrWat, args) => {
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.every requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'

  const id = ctx.loopCounter++
  const arr = `$_ev_arr_${id}`, base = `$_ev_base_${id}`
  const idx = `$_ev_i_${id}`, len = `$_ev_len_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(paramName, 'f64')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $false_${id} (result i32)
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          (local.set $${paramName} ${loadExpr})
          (if (f64.eq ${f64(gen(body))} (f64.const 0))
            (then (br $false_${id} (i32.const 0))))
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $loop_${id})))
      (i32.const 1))`, 'i32')
}

/**
 * some(fn) - test if any element passes predicate
 */
export const some = (elemType, ptrWat, args) => {
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.some requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'

  const id = ctx.loopCounter++
  const arr = `$_sm_arr_${id}`, base = `$_sm_base_${id}`
  const idx = `$_sm_i_${id}`, len = `$_sm_len_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(paramName, 'f64')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $true_${id} (result i32)
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          (local.set $${paramName} ${loadExpr})
          (if (f64.ne ${f64(gen(body))} (f64.const 0))
            (then (br $true_${id} (i32.const 1))))
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $loop_${id})))
      (i32.const 0))`, 'i32')
}

/**
 * find(fn) - find first element passing predicate
 */
export const find = (elemType, ptrWat, args) => {
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.find requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'

  const id = ctx.loopCounter++
  const arr = `$_fd_arr_${id}`, base = `$_fd_base_${id}`
  const idx = `$_fd_i_${id}`, len = `$_fd_len_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(paramName, 'f64')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $found_${id} (result f64)
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          (local.set $${paramName} ${loadExpr})
          (if (f64.ne ${f64(gen(body))} (f64.const 0))
            (then (br $found_${id} (local.get $${paramName}))))
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $loop_${id})))
      (f64.const nan))`, 'f64')  // undefined → NaN
}

/**
 * findIndex(fn) - find first index passing predicate
 */
export const findIndex = (elemType, ptrWat, args) => {
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.findIndex requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'

  const id = ctx.loopCounter++
  const arr = `$_fi_arr_${id}`, base = `$_fi_base_${id}`
  const idx = `$_fi_i_${id}`, len = `$_fi_len_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(paramName, 'f64')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $found_${id} (result i32)
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
          (local.set $${paramName} ${loadExpr})
          (if (f64.ne ${f64(gen(body))} (f64.const 0))
            (then (br $found_${id} (local.get ${idx}))))
          (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
          (br $loop_${id})))
      (i32.const -1))`, 'i32')
}

/**
 * forEach(fn) - iterate elements (no return)
 */
export const forEach = (elemType, ptrWat, args) => {
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.forEach requires arrow function')
  const [, params, body] = callback
  const paramNames = extractParams(params)
  const paramName = paramNames[0] || '_v'
  const idxName = paramNames[1]

  const id = ctx.loopCounter++
  const arr = `$_fe_arr_${id}`, base = `$_fe_base_${id}`
  const idx = `$_fe_i_${id}`, len = `$_fe_len_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(paramName, 'f64')
  if (idxName) ctx.addLocal(idxName, 'i32')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)
  const idxSet = idxName ? `(local.set $${idxName} (local.get ${idx}))` : ''

  // Gen body - drop doesn't require specific type, just use the raw WAT
  const bodyWat = String(gen(body))

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${loadExpr})
      ${idxSet}
      (drop ${bodyWat})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (f64.const 0)`, 'f64')  // undefined
}

/**
 * map(fn) - create new TypedArray with transformed values
 * SIMD optimized for Float64Array (f64x2) and Float32Array (f32x4)
 */
export const map = (elemType, ptrWat, args) => {
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.map requires arrow function')
  const [, params, body] = callback
  const paramNames = extractParams(params)
  const paramName = paramNames[0] || '_v'
  const idxName = paramNames[1]

  // Try SIMD optimization for arrays without index param
  if (!idxName) {
    const simdPattern = analyzeSimdPattern(body, paramName)
    if (simdPattern) {
      // Check pattern compatibility: div/sqrt/ceil/floor not supported for i32
      const intOnly = ['and', 'or', 'xor', 'shl', 'shr', 'shru']
      const floatOnly = ['div', 'sqrt', 'ceil', 'floor']
      const isIntPattern = intOnly.includes(simdPattern.op)
      const isFloatPattern = floatOnly.includes(simdPattern.op)

      // Float SIMD
      if (!isIntPattern) {
        if (elemType === ELEM_TYPE.F64) { ctx.usedSimd = true; return mapSimdF64(ptrWat, simdPattern) }
        if (elemType === ELEM_TYPE.F32) { ctx.usedSimd = true; return mapSimdF32(ptrWat, simdPattern) }
      }
      // Integer SIMD (signed/unsigned 32-bit)
      if (!isFloatPattern && (elemType === ELEM_TYPE.I32 || elemType === ELEM_TYPE.U32)) {
        ctx.usedSimd = true
        return mapSimdI32(ptrWat, simdPattern, elemType)
      }
    }
  }

  // Fallback to scalar loop
  return mapScalar(elemType, ptrWat, paramName, idxName, body)
}

/** SIMD-optimized map for Float64Array (f64x2 - 2 elements per vector) */
function mapSimdF64(ptrWat, pattern) {
  const id = ctx.loopCounter++
  const src = `$_mp_src_${id}`, dst = `$_mp_dst_${id}`
  const srcBase = `$_mp_srcb_${id}`, dstBase = `$_mp_dstb_${id}`
  const idx = `$_mp_i_${id}`, len = `$_mp_len_${id}`
  const vec = `$_mp_vec_${id}`, val = `$_mp_val_${id}`

  ctx.addLocal(src, 'f64')
  ctx.addLocal(dst, 'f64')
  ctx.addLocal(srcBase, 'i32')
  ctx.addLocal(dstBase, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(vec, 'v128')
  ctx.addLocal(val, 'f64')

  const simdOp = genSimdOpF64(vec, pattern)
  const scalarOp = genScalarOpF64(val, pattern)

  // SIMD loop: process 2 f64 per iteration, then scalar remainder
  // Wrap in block to make single expression (fixes local.tee/br issues)
  return wat(`(block (result f64) (local.set ${src} ${ptrWat})
    (local.set ${len} (call $__typed_len (local.get ${src})))
    (local.set ${dst} (call $__alloc_typed (i32.const ${ELEM_TYPE.F64}) (local.get ${len})))
    (local.set ${srcBase} (call $__typed_offset (local.get ${src})))
    (local.set ${dstBase} (call $__typed_offset (local.get ${dst})))
    (local.set ${idx} (i32.const 0))
    ;; SIMD loop: 2 elements per iteration
    (block $simd_done_${id} (loop $simd_loop_${id}
      (br_if $simd_done_${id} (i32.gt_s (i32.add (local.get ${idx}) (i32.const 2)) (local.get ${len})))
      ;; Load 2 f64 (16 bytes)
      (local.set ${vec} (v128.load (i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const 3)))))
      ;; Apply SIMD operation
      ${simdOp}
      ;; Store 2 f64
      (v128.store (i32.add (local.get ${dstBase}) (i32.shl (local.get ${idx}) (i32.const 3))) (local.get ${vec}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 2)))
      (br $simd_loop_${id})))
    ;; Scalar remainder (0 or 1 element)
    (if (i32.lt_s (local.get ${idx}) (local.get ${len}))
      (then
        (local.set ${val} (f64.load (i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const 3)))))
        (f64.store (i32.add (local.get ${dstBase}) (i32.shl (local.get ${idx}) (i32.const 3))) ${scalarOp})))
    (local.get ${dst}))`, 'typedarray', ELEM_TYPE.F64)
}

/** SIMD-optimized map for Float32Array (f32x4 - 4 elements per vector) */
function mapSimdF32(ptrWat, pattern) {
  const id = ctx.loopCounter++
  const src = `$_mp_src_${id}`, dst = `$_mp_dst_${id}`
  const srcBase = `$_mp_srcb_${id}`, dstBase = `$_mp_dstb_${id}`
  const idx = `$_mp_i_${id}`, len = `$_mp_len_${id}`
  const vec = `$_mp_vec_${id}`, val = `$_mp_val_${id}`

  ctx.addLocal(src, 'f64')
  ctx.addLocal(dst, 'f64')
  ctx.addLocal(srcBase, 'i32')
  ctx.addLocal(dstBase, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(vec, 'v128')
  ctx.addLocal(val, 'f32')

  const simdOp = genSimdOpF32(vec, pattern)
  const scalarOp = genScalarOpF32(val, pattern)

  // SIMD loop: process 4 f32 per iteration, then scalar remainder
  // Wrap in block to make single expression (fixes local.tee/br issues)
  return wat(`(block (result f64) (local.set ${src} ${ptrWat})
    (local.set ${len} (call $__typed_len (local.get ${src})))
    (local.set ${dst} (call $__alloc_typed (i32.const ${ELEM_TYPE.F32}) (local.get ${len})))
    (local.set ${srcBase} (call $__typed_offset (local.get ${src})))
    (local.set ${dstBase} (call $__typed_offset (local.get ${dst})))
    (local.set ${idx} (i32.const 0))
    ;; SIMD loop: 4 elements per iteration (f32x4)
    (block $simd_done_${id} (loop $simd_loop_${id}
      (br_if $simd_done_${id} (i32.gt_s (i32.add (local.get ${idx}) (i32.const 4)) (local.get ${len})))
      ;; Load 4 f32 (16 bytes)
      (local.set ${vec} (v128.load (i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const 2)))))
      ;; Apply SIMD operation
      ${simdOp}
      ;; Store 4 f32
      (v128.store (i32.add (local.get ${dstBase}) (i32.shl (local.get ${idx}) (i32.const 2))) (local.get ${vec}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 4)))
      (br $simd_loop_${id})))
    ;; Scalar remainder (0-3 elements)
    (block $rem_done_${id} (loop $rem_loop_${id}
      (br_if $rem_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${val} (f32.load (i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const 2)))))
      (f32.store (i32.add (local.get ${dstBase}) (i32.shl (local.get ${idx}) (i32.const 2))) ${scalarOp})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $rem_loop_${id})))
    (local.get ${dst}))`, 'typedarray', ELEM_TYPE.F32)
}

/** SIMD-optimized map for Int32Array/Uint32Array (i32x4 - 4 elements per vector) */
function mapSimdI32(ptrWat, pattern, elemType) {
  const id = ctx.loopCounter++
  const src = `$_mp_src_${id}`, dst = `$_mp_dst_${id}`
  const srcBase = `$_mp_srcb_${id}`, dstBase = `$_mp_dstb_${id}`
  const idx = `$_mp_i_${id}`, len = `$_mp_len_${id}`
  const vec = `$_mp_vec_${id}`, val = `$_mp_val_${id}`

  ctx.addLocal(src, 'f64')
  ctx.addLocal(dst, 'f64')
  ctx.addLocal(srcBase, 'i32')
  ctx.addLocal(dstBase, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(vec, 'v128')
  ctx.addLocal(val, 'i32')

  const simdOp = genSimdOpI32(vec, pattern)
  const scalarOp = genScalarOpI32(val, pattern)

  // SIMD loop: process 4 i32 per iteration, then scalar remainder
  // Wrap in block to make single expression (fixes local.tee/br issues)
  return wat(`(block (result f64) (local.set ${src} ${ptrWat})
    (local.set ${len} (call $__typed_len (local.get ${src})))
    (local.set ${dst} (call $__alloc_typed (i32.const ${elemType}) (local.get ${len})))
    (local.set ${srcBase} (call $__typed_offset (local.get ${src})))
    (local.set ${dstBase} (call $__typed_offset (local.get ${dst})))
    (local.set ${idx} (i32.const 0))
    ;; SIMD loop: 4 elements per iteration (i32x4)
    (block $simd_done_${id} (loop $simd_loop_${id}
      (br_if $simd_done_${id} (i32.gt_s (i32.add (local.get ${idx}) (i32.const 4)) (local.get ${len})))
      ;; Load 4 i32 (16 bytes)
      (local.set ${vec} (v128.load (i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const 2)))))
      ;; Apply SIMD operation
      ${simdOp}
      ;; Store 4 i32
      (v128.store (i32.add (local.get ${dstBase}) (i32.shl (local.get ${idx}) (i32.const 2))) (local.get ${vec}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 4)))
      (br $simd_loop_${id})))
    ;; Scalar remainder (0-3 elements)
    (block $rem_done_${id} (loop $rem_loop_${id}
      (br_if $rem_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set ${val} (i32.load (i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const 2)))))
      (i32.store (i32.add (local.get ${dstBase}) (i32.shl (local.get ${idx}) (i32.const 2))) ${scalarOp})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $rem_loop_${id})))
    (local.get ${dst}))`, 'typedarray', elemType)
}

/** Scalar map implementation */
function mapScalar(elemType, ptrWat, paramName, idxName, body) {
  const id = ctx.loopCounter++
  const src = `$_mp_src_${id}`, dst = `$_mp_dst_${id}`
  const srcBase = `$_mp_srcb_${id}`, dstBase = `$_mp_dstb_${id}`
  const idx = `$_mp_i_${id}`, len = `$_mp_len_${id}`

  ctx.addLocal(src, 'f64')
  ctx.addLocal(dst, 'f64')
  ctx.addLocal(srcBase, 'i32')
  ctx.addLocal(dstBase, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(paramName, 'f64')
  if (idxName) ctx.addLocal(idxName, 'i32')

  const load = TYPED_LOAD[elemType]
  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]
  const srcOffset = shift === 0
    ? `(i32.add (local.get ${srcBase}) (local.get ${idx}))`
    : `(i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const dstOffset = shift === 0
    ? `(i32.add (local.get ${dstBase}) (local.get ${idx}))`
    : `(i32.add (local.get ${dstBase}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${srcOffset})`)
  const storeVal = toElemType(elemType, f64(gen(body)))
  const idxSet = idxName ? `(local.set $${idxName} (local.get ${idx}))` : ''

  // Wrap in block to make single expression (fixes local.tee/br issues)
  return wat(`(block (result f64) (local.set ${src} ${ptrWat})
    (local.set ${len} (call $__typed_len (local.get ${src})))
    (local.set ${dst} (call $__alloc_typed (i32.const ${elemType}) (local.get ${len})))
    (local.set ${srcBase} (call $__typed_offset (local.get ${src})))
    (local.set ${dstBase} (call $__typed_offset (local.get ${dst})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${loadExpr})
      ${idxSet}
      (${store} ${dstOffset} ${storeVal})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${dst}))`, 'typedarray', elemType)
}

/**
 * filter(fn) - create new TypedArray with filtered values
 */
export const filter = (elemType, ptrWat, args) => {
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.filter requires arrow function')
  const [, params, body] = callback
  const paramName = extractParams(params)[0] || '_v'

  const id = ctx.loopCounter++
  const src = `$_fl_src_${id}`, dst = `$_fl_dst_${id}`
  const srcBase = `$_fl_srcb_${id}`, dstBase = `$_fl_dstb_${id}`
  const idx = `$_fl_i_${id}`, len = `$_fl_len_${id}`, count = `$_fl_count_${id}`

  ctx.addLocal(src, 'f64')
  ctx.addLocal(dst, 'f64')
  ctx.addLocal(srcBase, 'i32')
  ctx.addLocal(dstBase, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(count, 'i32')
  ctx.addLocal(paramName, 'f64')

  const load = TYPED_LOAD[elemType]
  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]
  const srcOffset = shift === 0
    ? `(i32.add (local.get ${srcBase}) (local.get ${idx}))`
    : `(i32.add (local.get ${srcBase}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const dstOffset = shift === 0
    ? `(i32.add (local.get ${dstBase}) (local.get ${count}))`
    : `(i32.add (local.get ${dstBase}) (i32.shl (local.get ${count}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${srcOffset})`)

  // Note: We allocate max size then create view with actual count
  // Wrap in block to make single expression (fixes local.tee/br issues)
  return wat(`(block (result f64) (local.set ${src} ${ptrWat})
    (local.set ${len} (call $__typed_len (local.get ${src})))
    (local.set ${dst} (call $__alloc_typed (i32.const ${elemType}) (local.get ${len})))
    (local.set ${srcBase} (call $__typed_offset (local.get ${src})))
    (local.set ${dstBase} (call $__typed_offset (local.get ${dst})))
    (local.set ${idx} (i32.const 0))
    (local.set ${count} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${paramName} ${loadExpr})
      (if (f64.ne ${f64(gen(body))} (f64.const 0))
        (then
          (${store} ${dstOffset} (${load} ${srcOffset}))
          (local.set ${count} (i32.add (local.get ${count}) (i32.const 1)))))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (call $__mk_typed_ptr (i32.const ${elemType}) (local.get ${count})
      (call $__typed_offset (local.get ${dst}))))`, 'typedarray', elemType)
}

/**
 * reduce(fn, initial?) - reduce to single value
 */
export const reduce = (elemType, ptrWat, args) => {
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.reduce requires arrow function')
  const [, params, body] = callback
  const paramNames = extractParams(params)
  const accName = paramNames[0] || '_acc', curName = paramNames[1] || '_cur'

  const id = ctx.loopCounter++
  const arr = `$_rd_arr_${id}`, base = `$_rd_base_${id}`
  const acc = `$_rd_acc_${id}`, idx = `$_rd_i_${id}`, len = `$_rd_len_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(acc, 'f64')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(accName, 'f64')
  ctx.addLocal(curName, 'f64')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)
  const initVal = args.length >= 2 ? f64(gen(args[1])) : '(f64.const 0)'

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${acc} ${initVal})
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (local.set $${accName} (local.get ${acc}))
      (local.set $${curName} ${loadExpr})
      (local.set ${acc} ${f64(gen(body))})
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${acc})`, 'f64')
}

/**
 * reduceRight(fn, initial?) - reduce from right to single value
 */
export const reduceRight = (elemType, ptrWat, args) => {
  const callback = args[0]
  if (!Array.isArray(callback) || callback[0] !== '=>') throw new Error('.reduceRight requires arrow function')
  const [, params, body] = callback
  const paramNames = extractParams(params)
  const accName = paramNames[0] || '_acc', curName = paramNames[1] || '_cur'

  const id = ctx.loopCounter++
  const arr = `$_rr_arr_${id}`, base = `$_rr_base_${id}`
  const acc = `$_rr_acc_${id}`, idx = `$_rr_i_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(acc, 'f64')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(accName, 'f64')
  ctx.addLocal(curName, 'f64')

  const load = TYPED_LOAD[elemType]
  const shift = TYPED_SHIFT[elemType]
  const offsetCalc = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const loadExpr = fromElemType(elemType, `(${load} ${offsetCalc})`)
  const initVal = args.length >= 2 ? f64(gen(args[1])) : '(f64.const 0)'

  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${idx} (i32.sub (call $__typed_len (local.get ${arr})) (i32.const 1)))
    (local.set ${acc} ${initVal})
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.lt_s (local.get ${idx}) (i32.const 0)))
      (local.set $${accName} (local.get ${acc}))
      (local.set $${curName} ${loadExpr})
      (local.set ${acc} ${f64(gen(body))})
      (local.set ${idx} (i32.sub (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${acc})`, 'f64')
}

/**
 * sort(compareFn?) - sort in place (numeric ascending by default)
 * Uses insertion sort for simplicity (O(n²) but good for small arrays)
 */
export const sort = (elemType, ptrWat, args) => {
  const id = ctx.loopCounter++
  const arr = `$_sort_arr_${id}`, base = `$_sort_base_${id}`, len = `$_sort_len_${id}`
  const i = `$_sort_i_${id}`, j = `$_sort_j_${id}`
  const key = `$_sort_key_${id}`, curr = `$_sort_curr_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(i, 'i32')
  ctx.addLocal(j, 'i32')
  const valType = elemType === ELEM_TYPE.F64 ? 'f64' : elemType === ELEM_TYPE.F32 ? 'f32' : 'i32'
  ctx.addLocal(key, valType)
  ctx.addLocal(curr, valType)

  const load = TYPED_LOAD[elemType]
  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]
  const iOffset = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${i}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${i}) (i32.const ${shift})))`
  const jOffset = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${j}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${j}) (i32.const ${shift})))`
  const jPlusOneOffset = shift === 0
    ? `(i32.add (local.get ${base}) (i32.add (local.get ${j}) (i32.const 1)))`
    : `(i32.add (local.get ${base}) (i32.shl (i32.add (local.get ${j}) (i32.const 1)) (i32.const ${shift})))`

  // Comparison based on element type
  const cmpGt = elemType === ELEM_TYPE.F64 ? 'f64.gt' :
                elemType === ELEM_TYPE.F32 ? 'f32.gt' : 'i32.gt_s'

  // Insertion sort: simple, in-place, stable
  return wat(`(local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${i} (i32.const 1))
    (block $outer_done_${id} (loop $outer_${id}
      (br_if $outer_done_${id} (i32.ge_s (local.get ${i}) (local.get ${len})))
      (local.set ${key} (${load} ${iOffset}))
      (local.set ${j} (i32.sub (local.get ${i}) (i32.const 1)))
      (block $inner_done_${id} (loop $inner_${id}
        (br_if $inner_done_${id} (i32.lt_s (local.get ${j}) (i32.const 0)))
        (local.set ${curr} (${load} ${jOffset}))
        (br_if $inner_done_${id} (i32.eqz (${cmpGt} (local.get ${curr}) (local.get ${key}))))
        (${store} ${jPlusOneOffset} (local.get ${curr}))
        (local.set ${j} (i32.sub (local.get ${j}) (i32.const 1)))
        (br $inner_${id})))
      (${store} ${jPlusOneOffset} (local.get ${key}))
      (local.set ${i} (i32.add (local.get ${i}) (i32.const 1)))
      (br $outer_${id})))
    (local.get ${arr})`, 'typedarray', elemType)
}

/**
 * toReversed() - return new reversed copy (ES2023)
 */
export const toReversed = (elemType, ptrWat, args) => {
  const id = ctx.loopCounter++
  const arr = `$_trev_arr_${id}`, base = `$_trev_base_${id}`, len = `$_trev_len_${id}`
  const result = `$_trev_result_${id}`, resultBase = `$_trev_rbase_${id}`
  const idx = `$_trev_i_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'f64')
  ctx.addLocal(resultBase, 'i32')
  ctx.addLocal(idx, 'i32')

  ctx.usedTypedArrays = true
  const load = TYPED_LOAD[elemType]
  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]

  const srcOffset = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const dstOffset = shift === 0
    ? `(i32.add (local.get ${resultBase}) (i32.sub (i32.sub (local.get ${len}) (i32.const 1)) (local.get ${idx})))`
    : `(i32.add (local.get ${resultBase}) (i32.shl (i32.sub (i32.sub (local.get ${len}) (i32.const 1)) (local.get ${idx})) (i32.const ${shift})))`

  // Wrap in block to make single expression (fixes local.tee/br issues)
  return wat(`(block (result f64) (local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${result} (call $__alloc_typed (i32.const ${elemType}) (local.get ${len})))
    (local.set ${resultBase} (call $__typed_offset (local.get ${result})))
    (local.set ${idx} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (${store} ${dstOffset} (${load} ${srcOffset}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $loop_${id})))
    (local.get ${result}))`, 'typedarray', elemType)
}

/**
 * toSorted(compareFn?) - return new sorted copy (ES2023)
 */
export const toSorted = (elemType, ptrWat, args) => {
  const id = ctx.loopCounter++
  const arr = `$_tsort_arr_${id}`, base = `$_tsort_base_${id}`, len = `$_tsort_len_${id}`
  const result = `$_tsort_result_${id}`, resultBase = `$_tsort_rbase_${id}`
  const idx = `$_tsort_idx_${id}`
  const i = `$_tsort_i_${id}`, j = `$_tsort_j_${id}`
  const key = `$_tsort_key_${id}`, curr = `$_tsort_curr_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'f64')
  ctx.addLocal(resultBase, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(i, 'i32')
  ctx.addLocal(j, 'i32')
  const valType = elemType === ELEM_TYPE.F64 ? 'f64' : elemType === ELEM_TYPE.F32 ? 'f32' : 'i32'
  ctx.addLocal(key, valType)
  ctx.addLocal(curr, valType)

  ctx.usedTypedArrays = true
  const load = TYPED_LOAD[elemType]
  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]

  const srcOffset = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const dstOffset = shift === 0
    ? `(i32.add (local.get ${resultBase}) (local.get ${idx}))`
    : `(i32.add (local.get ${resultBase}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const iOffset = shift === 0
    ? `(i32.add (local.get ${resultBase}) (local.get ${i}))`
    : `(i32.add (local.get ${resultBase}) (i32.shl (local.get ${i}) (i32.const ${shift})))`
  const jOffset = shift === 0
    ? `(i32.add (local.get ${resultBase}) (local.get ${j}))`
    : `(i32.add (local.get ${resultBase}) (i32.shl (local.get ${j}) (i32.const ${shift})))`
  const jPlusOneOffset = shift === 0
    ? `(i32.add (local.get ${resultBase}) (i32.add (local.get ${j}) (i32.const 1)))`
    : `(i32.add (local.get ${resultBase}) (i32.shl (i32.add (local.get ${j}) (i32.const 1)) (i32.const ${shift})))`

  const cmpGt = elemType === ELEM_TYPE.F64 ? 'f64.gt' :
                elemType === ELEM_TYPE.F32 ? 'f32.gt' : 'i32.gt_s'

  // Copy then insertion sort
  // Wrap in block to make single expression (fixes local.tee/br issues)
  return wat(`(block (result f64) (local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${result} (call $__alloc_typed (i32.const ${elemType}) (local.get ${len})))
    (local.set ${resultBase} (call $__typed_offset (local.get ${result})))
    ;; Copy source to result
    (local.set ${idx} (i32.const 0))
    (block $copy_done_${id} (loop $copy_${id}
      (br_if $copy_done_${id} (i32.ge_s (local.get ${idx}) (local.get ${len})))
      (${store} ${dstOffset} (${load} ${srcOffset}))
      (local.set ${idx} (i32.add (local.get ${idx}) (i32.const 1)))
      (br $copy_${id})))
    ;; Insertion sort on result
    (local.set ${i} (i32.const 1))
    (block $outer_done_${id} (loop $outer_${id}
      (br_if $outer_done_${id} (i32.ge_s (local.get ${i}) (local.get ${len})))
      (local.set ${key} (${load} ${iOffset}))
      (local.set ${j} (i32.sub (local.get ${i}) (i32.const 1)))
      (block $inner_done_${id} (loop $inner_${id}
        (br_if $inner_done_${id} (i32.lt_s (local.get ${j}) (i32.const 0)))
        (local.set ${curr} (${load} ${jOffset}))
        (br_if $inner_done_${id} (i32.eqz (${cmpGt} (local.get ${curr}) (local.get ${key}))))
        (${store} ${jPlusOneOffset} (local.get ${curr}))
        (local.set ${j} (i32.sub (local.get ${j}) (i32.const 1)))
        (br $inner_${id})))
      (${store} ${jPlusOneOffset} (local.get ${key}))
      (local.set ${i} (i32.add (local.get ${i}) (i32.const 1)))
      (br $outer_${id})))
    (local.get ${result}))`, 'typedarray', elemType)
}

/**
 * with(index, value) - return new copy with element replaced (ES2023)
 */
export const withAt = (elemType, ptrWat, args) => {
  if (args.length < 2) throw new Error('TypedArray.with requires index and value')
  const idxArg = args[0], valArg = args[1]
  const id = ctx.loopCounter++
  const arr = `$_with_arr_${id}`, base = `$_with_base_${id}`, len = `$_with_len_${id}`
  const result = `$_with_result_${id}`, resultBase = `$_with_rbase_${id}`
  const idx = `$_with_i_${id}`, targetIdx = `$_with_tgt_${id}`

  ctx.addLocal(arr, 'f64')
  ctx.addLocal(base, 'i32')
  ctx.addLocal(len, 'i32')
  ctx.addLocal(result, 'f64')
  ctx.addLocal(resultBase, 'i32')
  ctx.addLocal(idx, 'i32')
  ctx.addLocal(targetIdx, 'i32')

  ctx.usedTypedArrays = true
  const load = TYPED_LOAD[elemType]
  const store = TYPED_STORE[elemType]
  const shift = TYPED_SHIFT[elemType]
  const stride = ELEM_STRIDE[elemType]

  const srcOffset = shift === 0
    ? `(i32.add (local.get ${base}) (local.get ${idx}))`
    : `(i32.add (local.get ${base}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const dstOffset = shift === 0
    ? `(i32.add (local.get ${resultBase}) (local.get ${idx}))`
    : `(i32.add (local.get ${resultBase}) (i32.shl (local.get ${idx}) (i32.const ${shift})))`
  const targetOffset = shift === 0
    ? `(i32.add (local.get ${resultBase}) (local.get ${targetIdx}))`
    : `(i32.add (local.get ${resultBase}) (i32.shl (local.get ${targetIdx}) (i32.const ${shift})))`

  const valInit = toElemType(elemType, f64(gen(valArg)))

  // Handle negative index
  // Wrap in block to make single expression (fixes local.tee/br issues)
  return wat(`(block (result f64) (local.set ${arr} ${ptrWat})
    (local.set ${base} (call $__typed_offset (local.get ${arr})))
    (local.set ${len} (call $__typed_len (local.get ${arr})))
    (local.set ${targetIdx} ${i32(gen(idxArg))})
    ;; Handle negative index
    (if (i32.lt_s (local.get ${targetIdx}) (i32.const 0))
      (then (local.set ${targetIdx} (i32.add (local.get ${len}) (local.get ${targetIdx})))))
    ;; Allocate and copy
    (local.set ${result} (call $__alloc_typed (i32.const ${elemType}) (local.get ${len})))
    (local.set ${resultBase} (call $__typed_offset (local.get ${result})))
    (memory.copy (local.get ${resultBase}) (local.get ${base}) (i32.mul (local.get ${len}) (i32.const ${stride})))
    ;; Set the new value
    (${store} ${targetOffset} ${valInit})
    (local.get ${result}))`, 'typedarray', elemType)
}

/** Method dispatch table */
export const TYPED_ARRAY_METHODS = {
  fill, at, indexOf, lastIndexOf, includes,
  slice, subarray, reverse, copyWithin, set,
  every, some, find, findIndex, forEach,
  map, filter, reduce, reduceRight,
  sort, toReversed, toSorted, with: withAt
}
