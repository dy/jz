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
 * Pointer types for NaN-boxing mode
 *
 * NaN box: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
 * Payload: [type:4][id:16][offset:31]
 * - type: pointer type (1-15)
 * - id: type-specific (len for immutable, instanceId for mutable, schemaId for objects)
 * - offset: memory byte offset (2GB addressable)
 *
 * TypedArray uses different layout: [type:4][elemType:3][len:22][offset:22]
 *
 * Memory at offset: [data...] - pure data, no header
 *
 * Instance table (for mutable types): InstanceTable[id] = { len: u16, schemaId: u16 }
 * Schema registry: schemas[id] = ['prop1', 'prop2', ...] (compile-time)
 *
 * @enum {number}
 */
export const PTR_TYPE = {
  ARRAY: 1,        // Immutable f64 array, len in pointer
  ARRAY_MUT: 2,    // Mutable array (schemaId=0) or array+props (schemaId>0)
  STRING: 3,       // UTF-16 string, len in pointer, immutable
  OBJECT: 4,       // Object (or boxed string if schema[0]==='__string__')
  TYPED_ARRAY: 5,  // TypedArray: [type:4][elemType:3][len:22][offset:22]
  // Note: BOXED_STRING merged into OBJECT (schema[0]==='__string__')
  // Note: ARRAY_PROPS merged into ARRAY_MUT (schemaId > 0)
  CLOSURE: 7       // Closure, funcIdx + env offset
}

/**
 * Element types for TypedArrays
 * Stride: [1, 1, 2, 2, 4, 4, 4, 8][elemType]
 * @enum {number}
 */
export const ELEM_TYPE = {
  I8: 0,   // Int8Array,    stride 1
  U8: 1,   // Uint8Array,   stride 1
  I16: 2,  // Int16Array,   stride 2
  U16: 3,  // Uint16Array,  stride 2
  I32: 4,  // Int32Array,   stride 4
  U32: 5,  // Uint32Array,  stride 4
  F32: 6,  // Float32Array, stride 4
  F64: 7   // Float64Array, stride 8
}

/** Stride in bytes for each ELEM_TYPE */
export const ELEM_STRIDE = [1, 1, 2, 2, 4, 4, 4, 8]

/** TypedArray constructor name → ELEM_TYPE */
export const TYPED_ARRAY_CTORS = {
  Int8Array: ELEM_TYPE.I8,
  Uint8Array: ELEM_TYPE.U8,
  Int16Array: ELEM_TYPE.I16,
  Uint16Array: ELEM_TYPE.U16,
  Int32Array: ELEM_TYPE.I32,
  Uint32Array: ELEM_TYPE.U32,
  Float32Array: ELEM_TYPE.F32,
  Float64Array: ELEM_TYPE.F64
}

/** Check if value is a TypedArray pointer */
export const isTypedArray = (v) => v?.type === 'typedarray'

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
  // boxed types and array_props are also f64 pointers
  if (t === 'f64' || t === 'array' || t === 'string' || t === 'closure' || t === 'object' ||
      t === 'boxed_string' || t === 'boxed_number' || t === 'boxed_boolean' || t === 'array_props') return op
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
/** @param {String & {type: string}} v - Boxed string (OBJECT + schema[0]==='__string__') */
export const isBoxedString = v => v.type === 'boxed_string'
/** @param {String & {type: string}} v - Boxed number (OBJECT + schema[0]==='__number__') */
export const isBoxedNumber = v => v.type === 'boxed_number'
/** @param {String & {type: string}} v - Boxed boolean (OBJECT + schema[0]==='__boolean__') */
export const isBoxedBoolean = v => v.type === 'boxed_boolean'
/** @param {String & {type: string}} v - Array with named properties (ARRAY_MUT + schemaId > 0) */
export const isArrayProps = v => v.type === 'array_props'

// === Compound predicates ===
/** @param {String & {type: string}} a @param {String & {type: string}} b */
export const bothI32 = (a, b) => a.type === 'i32' && b.type === 'i32'
/** @param {String & {type: string}} v */
export const isHeapRef = v => v.type === 'array' || v.type === 'object' || v.type === 'refarray' || v.type === 'ref'
/** @param {String & {type: string, schema?: *}} v */
export const hasSchema = v => v.schema !== undefined
