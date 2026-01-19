/**
 * Type system and coercions for jz compiler
 *
 * Typed values: [type, wat, schema?]
 * - type: 'f64' | 'i32' | 'ref' | 'array' | 'string' | 'object' | 'closure' | 'refarray'
 * - wat: WAT expression string
 * - schema: optional metadata (object property names, array element types)
 *
 * gc:false uses NaN-boxing for pointers (arrays, strings, objects, closures)
 * NaN-boxing encodes pointer metadata in the mantissa of a quiet NaN
 *
 * @module types
 */

/**
 * Pointer types for gc:false NaN-boxing mode
 * Layout: f64 quiet NaN with mantissa [type:4][length:28][offset:20]
 * Types 1-7 are pointers, 8-15 reserved for canonical NaN
 * @enum {number}
 */
export const PTR_TYPE = {
  F64_ARRAY: 1,   // Float64 array (8 bytes/element)
  I32_ARRAY: 2,   // Int32 array (4 bytes/element)
  STRING: 3,      // UTF-16 string (2 bytes/char)
  I8_ARRAY: 4,    // Int8 array (1 byte/element)
  OBJECT: 5,      // Object (f64 array + schema)
  REF_ARRAY: 6,   // Mixed-type array (f64 + type info)
  CLOSURE: 7      // Closure environment
}

/** Element sizes in bytes per pointer type */
export const PTR_ELEM_SIZE = { 1: 8, 2: 4, 3: 2, 4: 1, 5: 8, 6: 8, 7: 8 }

/**
 * Typed value constructor
 * @param {string} t - Type name
 * @param {string} wat - WAT expression
 * @param {*} [schema] - Optional schema metadata
 * @returns {[string, string, *]} Typed value tuple
 */
export const tv = (t, wat, schema) => [t, wat, schema]

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
 * Coerce typed value to f64
 * @param {[string, string]} tv - Typed value
 * @returns {[string, string]} f64 typed value
 */
export const asF64 = ([t, w]) =>
  t === 'f64' || t === 'array' || t === 'string' ? [t, w] :
  t === 'ref' || t === 'object' ? ['f64', '(f64.const 0)'] :
  t === 'closure' ? [t, w] :
  ['f64', `(f64.convert_i32_s ${w})`]

/**
 * Coerce typed value to i32
 * @param {[string, string]} tv - Typed value
 * @returns {[string, string]} i32 typed value
 */
export const asI32 = ([t, w]) =>
  t === 'i32' ? [t, w] :
  t === 'ref' || t === 'object' || t === 'closure' ? ['i32', '(i32.const 0)'] :
  ['i32', `(i32.trunc_f64_s ${w})`]

/**
 * Convert typed value to boolean (i32 0 or 1)
 * @param {[string, string]} tv - Typed value
 * @returns {[string, string]} i32 boolean typed value
 */
export const truthy = ([t, w]) =>
  t === 'ref' ? ['i32', `(i32.eqz (ref.is_null ${w}))`] :
  t === 'i32' ? ['i32', `(i32.ne ${w} (i32.const 0))`] :
  ['i32', `(f64.ne ${w} (f64.const 0))`]

/**
 * Make two values same type for comparison
 * @param {[string, string]} a - First typed value
 * @param {[string, string]} b - Second typed value
 * @returns {[[string, string], [string, string]]} Both as i32 or both as f64
 */
export const conciliate = (a, b) =>
  a[0] === 'i32' && b[0] === 'i32' ? [a, b] : [asF64(a), asF64(b)]

// === Type accessors ===
/** @param {[string, string, *]} v */
export const typeOf = v => v[0]
/** @param {[string, string, *]} v */
export const watOf = v => v[1]
/** @param {[string, string, *]} v */
export const schemaOf = v => v[2]

// === Type predicates ===
/** @param {[string, string]} v @param {string} t */
export const isType = (v, t) => v[0] === t
/** @param {[string, string]} v */
export const isF64 = v => v[0] === 'f64'
/** @param {[string, string]} v */
export const isI32 = v => v[0] === 'i32'
/** @param {[string, string]} v */
export const isString = v => v[0] === 'string'
/** @param {[string, string]} v */
export const isArray = v => v[0] === 'array'
/** @param {[string, string]} v */
export const isObject = v => v[0] === 'object'
/** @param {[string, string]} v */
export const isClosure = v => v[0] === 'closure'
/** @param {[string, string]} v */
export const isRef = v => v[0] === 'ref'
/** @param {[string, string]} v */
export const isRefArray = v => v[0] === 'refarray'

// === Compound predicates ===
/** @param {[string, string]} v */
export const isNumeric = v => v[0] === 'f64' || v[0] === 'i32'
/** @param {[string, string]} a @param {[string, string]} b */
export const bothI32 = (a, b) => a[0] === 'i32' && b[0] === 'i32'
/** @param {[string, string]} v */
export const isHeapRef = v => v[0] === 'array' || v[0] === 'object' || v[0] === 'refarray' || v[0] === 'ref'
/** @param {[string, string]} v */
export const isArrayLike = v => v[0] === 'array' || v[0] === 'refarray'
/** @param {[string, string, *]} v */
export const hasSchema = v => v[2] !== undefined
