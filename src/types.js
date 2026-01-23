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
 * NaN box format: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
 * Default payload: [type:4][id:16][offset:31]
 *
 * Schema registry: schemas[id] = ['prop1', 'prop2', ...] (compile-time)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * POINTER LAYOUTS
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ARRAY (type=1) - Mutable f64 array with C-style header
 *   Pointer: [type:4=0001][schemaId:16][offset:31]
 *   Memory:  offset-8 → [length:f64]
 *            offset   → [elem0:f64, elem1:f64, ...]
 *   schemaId: 0=pure array, >0=array with named props at schema offsets
 *   O(1) push/pop via length in memory, O(n) shift/unshift
 *
 * (type=2) - Reserved for future use
 *
 * STRING (type=3) - Immutable UTF-16 string
 *   Pointer: [type:4=0011][len:16][offset:31]
 *   Memory:  offset → [char0:u16, char1:u16, ...]
 *
 * OBJECT (type=4) - Static object (compile-time known shape)
 *   Pointer: [type:4=0100][schemaId:16][offset:31]
 *   Memory:  offset → [prop0:f64, prop1:f64, ...]
 *   Schema:  schemas[schemaId] = ['propName0', 'propName1', ...]
 *
 * TYPED_ARRAY (type=5) - TypedArray (different bit layout!)
 *   Pointer: [type:4=0101][elemType:3][len:22][offset:22]
 *   Memory:  offset → raw bytes (stride depends on elemType)
 *   elemType: 0=i8, 1=u8, 2=i16, 3=u16, 4=i32, 5=u32, 6=f32, 7=f64
 *
 * REGEX (type=6) - Compiled regex pattern
 *   Pointer: [type:4=0110][regexId:16][flags:31]
 *   Memory:  compiled regex in regexFunctions array
 *   flags: i=1, g=2, m=4, etc.
 *
 * CLOSURE (type=7) - Function closure with captured environment
 *   Pointer: [type:4=0111][funcIdx:16][offset:31]
 *   Memory:  offset → [captured0:f64, captured1:f64, ...]
 *
 * SET (type=8) - Hash set (open addressing)
 *   Pointer: [type:4=1000][schemaId:16][offset:31]
 *   Memory:  offset-16 → [capacity:f64][size:f64]
 *            offset   → [hash0:f64, key0:f64, hash1:f64, key1:f64, ...]
 *   Entry: 16 bytes (hash + key), hash=0 empty, hash=1 deleted
 *   schemaId: 0=pure Set, >0=hybrid with static props at schema offsets
 *
 * MAP (type=9) - Hash map (open addressing)
 *   Pointer: [type:4=1001][schemaId:16][offset:31]
 *   Memory:  offset-16 → [capacity:f64][size:f64]
 *            offset   → [hash0:f64, key0:f64, val0:f64, ...]
 *   Entry: 24 bytes (hash + key + val), hash=0 empty, hash=1 deleted
 *   schemaId: 0=pure Map, >0=hybrid with static props at schema offsets
 *
 * DYN_OBJECT (type=10) - Dynamic object (runtime property names)
 *   Pointer: [type:4=1010][schemaId:16][offset:31]
 *   Memory:  same as MAP (hash table for string keys → values)
 *   schemaId: 0=pure dynamic, >0=hybrid (static base + dynamic overflow)
 *   Syntax: obj.prop and obj[key] both use hash lookup
 *
 * @enum {number}
 */
export const PTR_TYPE = {
  ARRAY: 1,        // [type:4][schemaId:16][offset:31] → [-8:len][elem0, elem1, ...]
  // 2 reserved for future use
  STRING: 3,       // [type:4][len:16][offset:31] → [char0:u16, char1:u16, ...]
  OBJECT: 4,       // [type:4][schemaId:16][offset:31] → [prop0, prop1, ...]
  TYPED_ARRAY: 5,  // [type:4][elemType:3][len:22][offset:22] → raw bytes
  REGEX: 6,        // [type:4][regexId:16][flags:31] → compiled in regexFunctions
  CLOSURE: 7,      // [type:4][funcIdx:16][offset:31] → [captured0, captured1, ...]
  SET: 8,          // [type:4][schemaId:16][offset:31] → [-16:cap][-8:size][entries...]
  MAP: 9,          // [type:4][schemaId:16][offset:31] → [-16:cap][-8:size][entries...]
  DYN_OBJECT: 10,  // [type:4][schemaId:16][offset:31] → same as MAP, .prop syntax
}

// === Memory layout constants ===
/** Heap start offset (no more instance table) */
export const HEAP_START = 0
/** String interning stride: max string length * 2 (UTF-16) */
export const STRING_STRIDE = 256
/** F64 element size in bytes */
export const F64_SIZE = 8

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
 * WAT template tag - clean multiline WAT with interpolation
 * Strips leading indent, trims lines, joins arrays with space.
 *
 * @example
 * wt`(func $name (param $x f64)
 *      ${locals.map(l => `(local $${l} f64)`)}
 *      ${body})`
 *
 * @param {TemplateStringsArray} strings - Template literal strings
 * @param {...*} values - Interpolated values (strings, numbers, or arrays)
 * @returns {string} Clean WAT string
 */
export function wt(strings, ...values) {
  // Join template parts with interpolated values
  let result = strings[0]
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    result += Array.isArray(v) ? v.join(' ') : String(v ?? '')
    result += strings[i + 1]
  }
  // Strip leading/trailing whitespace per line, collapse blank lines
  return result.split('\n').map(l => l.trim()).filter(l => l).join('\n')
}

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
  // boxed types, array_props, typedarray, set, map, dyn_object are also f64 pointers
  if (t === 'f64' || t === 'array' || t === 'string' || t === 'closure' || t === 'object' ||
      t === 'boxed_string' || t === 'boxed_number' || t === 'boxed_boolean' || t === 'array_props' ||
      t === 'typedarray' || t === 'set' || t === 'map' || t === 'dyn_object') return op
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
/** @param {String & {type: string}} v - Regex pattern */
export const isRegex = v => v.type === 'regex'
/** @param {String & {type: string}} v - Set collection */
export const isSet = v => v.type === 'set'
/** @param {String & {type: string}} v - Map collection */
export const isMap = v => v.type === 'map'
/** @param {String & {type: string}} v - Dynamic object (hash table, runtime props) */
export const isDynObject = v => v.type === 'dyn_object'

// === Compound predicates ===
/** @param {String & {type: string}} a @param {String & {type: string}} b */
export const bothI32 = (a, b) => a.type === 'i32' && b.type === 'i32'
/** @param {String & {type: string}} v */
export const isHeapRef = v => v.type === 'array' || v.type === 'object' || v.type === 'refarray' || v.type === 'ref'
/** @param {String & {type: string, schema?: *}} v */
export const hasSchema = v => v.schema !== undefined
