/**
 * WAT binary operations and Math builtins for jz compiler
 *
 * Provides typed WAT generators for arithmetic, comparison,
 * bitwise, and Math operations.
 */

import { wat, f64, i32 } from './types.js'

// Binary operation generator factory
const binOp = (resType, argType, op) => (a, b) => {
  const wa = argType === 'f64' ? f64(a) : i32(a)
  const wb = argType === 'f64' ? f64(b) : i32(b)
  return wat(`(${op} ${wa} ${wb})`, resType)
}

// f64 operations
export const f64ops = {
  add: binOp('f64', 'f64', 'f64.add'),
  sub: binOp('f64', 'f64', 'f64.sub'),
  mul: binOp('f64', 'f64', 'f64.mul'),
  div: binOp('f64', 'f64', 'f64.div'),
  eq: binOp('i32', 'f64', 'f64.eq'),
  ne: binOp('i32', 'f64', 'f64.ne'),
  lt: binOp('i32', 'f64', 'f64.lt'),
  le: binOp('i32', 'f64', 'f64.le'),
  gt: binOp('i32', 'f64', 'f64.gt'),
  ge: binOp('i32', 'f64', 'f64.ge'),
}

// i32 operations
export const i32ops = {
  add: binOp('i32', 'i32', 'i32.add'),
  sub: binOp('i32', 'i32', 'i32.sub'),
  mul: binOp('i32', 'i32', 'i32.mul'),
  and: binOp('i32', 'i32', 'i32.and'),
  or: binOp('i32', 'i32', 'i32.or'),
  xor: binOp('i32', 'i32', 'i32.xor'),
  eq: binOp('i32', 'i32', 'i32.eq'),
  ne: binOp('i32', 'i32', 'i32.ne'),
  lt_s: binOp('i32', 'i32', 'i32.lt_s'),
  le_s: binOp('i32', 'i32', 'i32.le_s'),
  gt_s: binOp('i32', 'i32', 'i32.gt_s'),
  ge_s: binOp('i32', 'i32', 'i32.ge_s'),
  // Shifts mask to 5 bits (0-31)
  shl: (a, b) => wat(`(i32.shl ${i32(a)} (i32.and ${i32(b)} (i32.const 31)))`, 'i32'),
  shr_s: (a, b) => wat(`(i32.shr_s ${i32(a)} (i32.and ${i32(b)} (i32.const 31)))`, 'i32'),
  shr_u: (a, b) => wat(`(i32.shr_u ${i32(a)} (i32.and ${i32(b)} (i32.const 31)))`, 'i32'),
}

// Native WASM instructions for Math functions
export const MATH_OPS = {
  // f64 unary: Math.sqrt, Math.abs, etc.
  f64_unary: {
    sqrt: 'f64.sqrt',
    abs: 'f64.abs',
    floor: 'f64.floor',
    ceil: 'f64.ceil',
    trunc: 'f64.trunc',
    round: 'f64.nearest'
  },
  // i32 unary: Math.clz32
  i32_unary: {
    clz32: 'i32.clz'
  },
  // f64 binary: Math.min, Math.max
  f64_binary: {
    min: 'f64.min',
    max: 'f64.max'
  },
  // Functions needing stdlib implementation
  stdlib_unary: [
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
    'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
    'exp', 'expm1', 'log', 'log2', 'log10', 'log1p',
    'cbrt', 'sign', 'fround', 'f16round'
  ],
  stdlib_binary: ['pow', 'atan2', 'hypot', 'imul'],
  // Math constants
  constants: {
    PI: Math.PI,
    E: Math.E,
    SQRT2: Math.SQRT2,
    SQRT1_2: Math.SQRT1_2,
    LN2: Math.LN2,
    LN10: Math.LN10,
    LOG2E: Math.LOG2E,
    LOG10E: Math.LOG10E
  }
}
