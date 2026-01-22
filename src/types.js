/**
 * Type system and coercions for jz compiler
 *
 * WAT values are boxed strings: String objects with .type and optional .schema
 * This allows natural template literal interpolation: `(f64.add ${a} ${b})`
 *
 * Types: 'f64' | 'i32' | 'ref' | 'array' | 'string' | 'object' | 'closure' | 'refarray'
 *
 * gc:false uses NaN-boxing for pointers (arrays, strings, objects, closures)
 * NaN-boxing encodes pointer metadata in the mantissa of a quiet NaN
 *
 * @module types
 */

/**
 * Pointer types for integer-packed mode
 * Layout: [type:8][schemaId:8][len:16][offset:32] = 64 bits
 * - type: pointer type (1-7)
 * - schemaId: object schema (0 = plain array, 1-255 = named schemas)
 * - len: current length (65535 max elements)
 * - offset: memory offset to data (full 32-bit range)
 *
 * Memory at offset: [data...] - pure data, no header
 * Capacity is implicit from length tier: nextPow2(max(len, 4))
 *
 * Objects are F64_ARRAY with schemaId > 0 (Strategy B).
 * Schema registry maps schemaId → property names.
 *
 * COW-like semantics: assignment copies pointer, mutations to
 * elements are shared, but length changes (push/pop) diverge.
 *
 * @enum {number}
 */
export const PTR_TYPE = {
  F64_ARRAY: 1,   // Float64 array (8 bytes/element), or object with schema
  I32_ARRAY: 2,   // Int32 array (4 bytes/element), pure data
  STRING: 3,      // UTF-16 string (2 bytes/char), immutable
  I8_ARRAY: 4,    // Int8 array (1 byte/element), pure data
  // 5 removed: objects are F64_ARRAY with schemaId > 0
  REF_ARRAY: 6,   // Mixed-type array (f64 + type info), pure data
  CLOSURE: 7      // Closure environment, pure data
}

/**
 * WAT value constructor - creates boxed string with type metadata
 * @param {string} code - WAT expression string
 * @param {string} [type='f64'] - Type name
 * @param {*} [schema] - Optional schema metadata
 * @returns {String & {type: string, schema?: *}} Boxed WAT string
 */
export const wat = (code, type = 'f64', schema) =>
  Object.assign(new String(code), { type, schema })

/**
 * Format number for WAT output (handles special values)
 * @param {number} n - Number to format
 * @returns {string} WAT-compatible number string
 */
export const fmtNum = n =>
  Object.is(n, -0) ? '-0' :
  Number.isNaN(n) ? 'nan' :
  n === Infinity ? 'inf' :
  n === -Infinity ? '-inf' :
  String(n)

/**
 * Coerce WAT value to f64
 * @param {String & {type: string}} op - Boxed WAT string
 * @returns {String & {type: string}} f64 WAT value
 */
export const f64 = op => {
  const t = op.type
  // Object is f64 pointer (Strategy B), not GC ref
  if (t === 'f64' || t === 'array' || t === 'string' || t === 'closure' || t === 'object') return op
  if (t === 'ref') return wat('(f64.const 0)', 'f64')
  return wat(`(f64.convert_i32_s ${op})`, 'f64')
}

/**
 * Coerce WAT value to i32
 * @param {String & {type: string}} op - Boxed WAT string
 * @returns {String & {type: string}} i32 WAT value
 */
export const i32 = op => {
  const t = op.type
  if (t === 'i32') return op
  if (t === 'ref' || t === 'object' || t === 'closure') return wat('(i32.const 0)', 'i32')
  return wat(`(i32.trunc_f64_s ${op})`, 'i32')
}

/**
 * Convert WAT value to boolean (i32 0 or 1)
 * @param {String & {type: string}} op - Boxed WAT string
 * @returns {String & {type: string}} i32 boolean WAT value
 */
export const bool = op => {
  const t = op.type
  if (t === 'ref') return wat(`(i32.eqz (ref.is_null ${op}))`, 'i32')
  if (t === 'i32') return wat(`(i32.ne ${op} (i32.const 0))`, 'i32')
  return wat(`(f64.ne ${op} (f64.const 0))`, 'i32')
}

/**
 * Make two values same type for comparison
 * @param {String & {type: string}} a - First WAT value
 * @param {String & {type: string}} b - Second WAT value
 * @returns {[String, String]} Both as i32 or both as f64
 */
export const conciliate = (a, b) =>
  a.type === 'i32' && b.type === 'i32' ? [a, b] : [f64(a), f64(b)]

// === Type predicates (work with boxed strings) ===
/** @param {String & {type: string}} v */
export const isF64 = v => v.type === 'f64'
/** @param {String & {type: string}} v */
export const isI32 = v => v.type === 'i32'
/** @param {String & {type: string}} v */
export const isString = v => v.type === 'string'
/** @param {String & {type: string}} v */
export const isArray = v => v.type === 'array'
/** @param {String & {type: string}} v */
export const isObject = v => v.type === 'object'
/** @param {String & {type: string}} v */
export const isClosure = v => v.type === 'closure'
/** @param {String & {type: string}} v */
export const isRef = v => v.type === 'ref'
/** @param {String & {type: string}} v */
export const isRefArray = v => v.type === 'refarray'

// === Compound predicates ===
/** @param {String & {type: string}} a @param {String & {type: string}} b */
export const bothI32 = (a, b) => a.type === 'i32' && b.type === 'i32'
/** @param {String & {type: string}} v */
export const isHeapRef = v => v.type === 'array' || v.type === 'object' || v.type === 'refarray' || v.type === 'ref'
/** @param {String & {type: string, schema?: *}} v */
export const hasSchema = v => v.schema !== undefined
