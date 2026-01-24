/**
 * Type system and coercions for jz compiler
 *
 * WAT values are boxed strings: String objects with .type and optional .schema
 * This allows natural template literal interpolation: `(f64.add ${a} ${b})`
 *
 * Types: 'f64' | 'i32' | 'ref' | 'array' | 'string' | 'object' | 'closure' | 'refarray'
 *
 * NaN-boxing encodes pointer metadata in the mantissa of a quiet NaN
 *
 * @module types
 */

/**
 * Pointer types for NaN-boxing
 *
 * NaN box format: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
 * Unified payload: [type:4][aux:16][offset:31]
 *   - type: pointer type (1-15)
 *   - aux: type-specific (0, funcIdx, elemType, regexId)
 *   - offset: memory byte offset (2GB addressable, clean i32)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * POINTER LAYOUTS
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ARRAY (type=1) - Mutable f64 array with C-style header
 *   Pointer: [type:4][0:16][offset:31]
 *   Memory:  offset-8 → [len:f64]
 *            offset   → [elem0:f64, elem1:f64, ...]
 *   Capacity = nextPow2(len), no cap storage needed
 *   O(1) push/pop via length in memory, O(n) shift/unshift
 *
 * RING (type=2) - Ring buffer array (O(1) shift/unshift)
 *   Pointer: [type:4][0:16][offset:31]
 *   Memory:  offset-16 → [head:f64]
 *            offset-8  → [len:f64]
 *            offset    → [slots...]
 *   arr[i] → slots[(head + i) & mask]
 *
 * TYPED (type=3) - TypedArray (Int8Array, Float64Array, etc.)
 *   Pointer: [type:4][elemType:3][0:13][offset:31]
 *   Memory:  offset-8 → [len:f64]
 *            offset   → raw bytes
 *   elemType in pointer (needed for stride), len in memory
 *
 * STRING (type=4) - UTF-16 string
 *   Pointer: [type:4][len:16][offset:31]
 *   Memory:  offset → [char0:u16, char1:u16, ...]
 *   len in pointer (max 65535 chars)
 *
 * OBJECT (type=5) - Static object (compile-time schema)
 *   Pointer: [type:4][0:16][offset:31]
 *   Memory:  offset → [prop0:f64, prop1:f64, ...]
 *   Schema resolved at compile-time via monomorphization
 *
 * HASH (type=6) - Hash table (dynamic object)
 *   Pointer: [type:4][0:16][offset:31]
 *   Memory:  offset-16 → [cap:f64]
 *            offset-8  → [size:f64]
 *            offset    → [entries...]
 *
 * SET (type=7) - Hash set
 *   Pointer: [type:4][0:16][offset:31]
 *   Memory:  offset-16 → [cap:f64]
 *            offset-8  → [size:f64]
 *            offset    → [hash:f64, key:f64, ...] (16B entries)
 *
 * MAP (type=8) - Hash map
 *   Pointer: [type:4][0:16][offset:31]
 *   Memory:  offset-16 → [cap:f64]
 *            offset-8  → [size:f64]
 *            offset    → [hash:f64, key:f64, val:f64, ...] (24B entries)
 *
 * CLOSURE (type=9) - Function closure
 *   Pointer: [type:4][funcIdx:16][offset:31]
 *   Memory:  offset → [env0:f64, env1:f64, ...]
 *   funcIdx in pointer (needed for call_indirect)
 *
 * REGEX (type=10) - Compiled regex pattern
 *   Pointer: [type:4][regexId:16][flags:31]
 *   No memory (pattern compiled to matcher function)
 *
 * @enum {number}
 */
export const PTR_TYPE = {
  ARRAY: 1,   // [type:4][0:16][offset:31] → [-8:len][elem0, elem1, ...]
  RING: 2,    // [type:4][0:16][offset:31] → [-16:head][-8:len][slots...]
  TYPED: 3,   // [type:4][elemType:3][0:13][offset:31] → [-8:len][bytes...]
  STRING: 4,  // [type:4][len:16][offset:31] → [char0:u16, char1:u16, ...]
  OBJECT: 5,  // [type:4][0:16][offset:31] → [prop0, prop1, ...]
  HASH: 6,    // [type:4][0:16][offset:31] → [-16:cap][-8:size][entries...]
  SET: 7,     // [type:4][0:16][offset:31] → [-16:cap][-8:size][hash, key, ...]
  MAP: 8,     // [type:4][0:16][offset:31] → [-16:cap][-8:size][hash, key, val, ...]
  CLOSURE: 9, // [type:4][funcIdx:16][offset:31] → [env0, env1, ...]
  REGEX: 10,  // [type:4][regexId:16][flags:31] → (compiled in function table)
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
