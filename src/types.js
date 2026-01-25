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
 * Pointer types for NaN-boxing (3-bit encoding)
 *
 * NaN box format: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
 * Payload layout: [type:3][aux:16][offset:32]
 *   - type: pointer type (0-7)
 *   - aux: type-specific metadata
 *   - offset: memory byte offset (4GB addressable)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * POINTER LAYOUTS
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ATOM (type=0) - Value types with no memory allocation
 *   Pointer: [0:3][kind:16][id:32]
 *   kind=0: null, kind=1: undefined, kind≥2: Symbol(id)
 *   No memory access needed
 *
 * ARRAY (type=1) - Mutable f64 array
 *   Pointer: [1:3][ring:1][_:15][offset:32]
 *   Memory (flat):  offset-8 → [len:f64], offset → [elem0, elem1, ...]
 *   Memory (ring):  offset-16 → [head:f64], offset-8 → [len:f64], offset → [slots...]
 *   ring=0: O(1) push/pop, O(n) shift/unshift
 *   ring=1: O(1) all ops, arr[i] → slots[(head + i) & mask]
 *
 * TYPED (type=2) - TypedArray view
 *   Pointer: [2:3][elemType:3][_:13][offset:32]
 *   Memory:  offset-8 → [len:i32, dataPtr:i32]
 *            dataPtr → [bytes...]
 *   View model enables zero-copy subarrays
 *
 * STRING (type=3) - UTF-16 or SSO string
 *   Pointer (heap): [3:3][0:1][_:15][offset:32]
 *   Pointer (SSO):  [3:3][1:1][data:42][_:5]
 *   Memory (heap):  offset-8 → [len:i32], offset → [char0:u16, char1:u16, ...]
 *   SSO: 6 ASCII chars (7-bit each) packed in 42 bits, no allocation
 *
 * OBJECT (type=4) - Objects with subtypes
 *   Pointer: [4:3][kind:2][schema:14][offset:32]
 *   kind=0 (SCHEMA): offset-8 → [inner:f64], offset → [prop0, prop1, ...]
 *     inner=0: static object, inner≠0: boxed primitive (inner=value)
 *   kind=1 (HASH):   offset-16 → [cap:f64], offset-8 → [size:f64], offset → entries
 *   kind=2 (SET):    same layout as HASH, 16B entries [hash, key]
 *   kind=3 (MAP):    same layout as HASH, 24B entries [hash, key, val]
 *
 * CLOSURE (type=5) - Function with captured environment
 *   Pointer: [5:3][funcIdx:16][offset:32]
 *   Memory:  offset-8 → [len:f64], offset → [env0, env1, ...]
 *   funcIdx in pointer for call_indirect, env in memory
 *
 * REGEX (type=6) - Compiled regex pattern
 *   Pointer: [6:3][flags:6][funcIdx:10][offset:32]
 *   Memory (if g flag): offset-8 → [lastIndex:f64]
 *   flags: g=1, i=2, m=4, s=8, u=16, y=32
 *   Static /pattern/ → funcIdx = compiled matcher
 *
 * (type=7) - Reserved
 *
 * @enum {number}
 */
export const PTR_TYPE = {
  ATOM: 0,     // [0:3][kind:16][id:32] - null/undefined/Symbol
  ARRAY: 1,    // [1:3][ring:1][_:15][off:32] → [-8:len][elems...] or [-16:head][-8:len][slots...]
  TYPED: 2,    // [2:3][elem:3][_:13][off:32] → [-8:len,dataPtr][data...]
  STRING: 3,   // [3:3][sso:1][data:42|_:15][off:32] → [-8:len][chars...]
  OBJECT: 4,   // [4:3][kind:2][schema:14][off:32] → varies by kind
  CLOSURE: 5,  // [5:3][funcIdx:16][off:32] → [-8:len][env...]
  REGEX: 6,    // [6:3][flags:6][funcIdx:10][off:32] → [-8:lastIdx] if g flag
}

/**
 * ATOM subtypes (kind field for type=0)
 * @enum {number}
 */
export const ATOM_KIND = {
  NULL: 0,      // null value
  UNDEF: 1,     // undefined value
  SYMBOL: 2,    // Symbol (id in offset field)
}

/**
 * OBJECT subtypes (kind field for type=4)
 * @enum {number}
 */
export const OBJ_KIND = {
  SCHEMA: 0,    // Static object with compile-time schema
  HASH: 1,      // Dynamic object (JSON.parse results)
  SET: 2,       // Set collection
  MAP: 3,       // Map collection
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
 * Dedent multiline string - strips leading indent, trims lines, collapses blank lines
 * @param {string} code - Multiline string to clean
 * @returns {string} Cleaned string
 */
const dedent = code => code.split('\n').map(l => l.trim()).filter(l => l).join('\n')

/**
 * WAT value constructor - creates boxed string with type metadata
 * Automatically dedents multiline code.
 * @param {string} code - WAT expression string
 * @param {string} [type='f64'] - Type name
 * @param {*} [schema] - Optional schema metadata
 * @returns {String & {type: string, schema?: *}} Boxed WAT string
 */
export const wat = (code, type = 'f64', schema) =>
  Object.assign(new String(dedent(String(code))), { type, schema })

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

// Types that are f64 pointers (NaN-boxed) - pass through f64() unchanged
const F64_TYPES = new Set([
  'f64',
  // PTR_TYPE.ARRAY
  'array', 'flat_array', 'ring_array',
  // PTR_TYPE.STRING
  'string',
  // PTR_TYPE.OBJECT (all kinds: SCHEMA, SET, MAP, and boxed variants)
  'object', 'set', 'map',
  // PTR_TYPE.CLOSURE
  'closure',
  // PTR_TYPE.TYPED
  'typedarray',
  // PTR_TYPE.ATOM (symbol, regex)
  'symbol', 'regex',
])

/**
 * Coerce WAT value to f64
 * @param {String & {type: string}} op - Boxed WAT string
 * @returns {String & {type: string}} f64 WAT value
 */
export const f64 = op => {
  const t = op.type
  if (F64_TYPES.has(t)) return op
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
 * For i32: already usable as boolean (0=false, non-zero=true)
 * For f64: 0 and NaN are falsy (numeric falsiness)
 * For ref: check if null
 * @param {String & {type: string}} op - Boxed WAT string
 * @returns {String & {type: string}} i32 boolean WAT value
 */
export const bool = op => {
  const t = op.type
  if (t === 'ref') return wat(`(i32.eqz (ref.is_null ${op}))`, 'i32')
  // i32 values already work as booleans in WASM (0=false, non-zero=true)
  // Comparisons already return 0/1, other i32 values are truthy if non-zero
  if (t === 'i32') return op
  // f64: truthy if not zero AND not NaN (both 0 and NaN are falsy)
  // (x != 0) && (x == x) - second part is false for NaN
  return wat(`(i32.and (f64.ne ${op} (f64.const 0)) (f64.eq ${op} ${op}))`, 'i32')
}

/**
 * Convert WAT value to falsy check (for loop exit conditions)
 * Returns i32 that is truthy when the original value is falsy
 * @param {String & {type: string}} op - Boxed WAT string
 * @returns {String & {type: string}} i32 value (truthy = original was falsy)
 */
export const falsy = op => {
  const t = op.type
  if (t === 'ref') return wat(`(ref.is_null ${op})`, 'i32')
  if (t === 'i32') return wat(`(i32.eqz ${op})`, 'i32')
  // f64: falsy if zero OR NaN
  // (x == 0) || (x != x) - second part is true for NaN
  return wat(`(i32.or (f64.eq ${op} (f64.const 0)) (f64.ne ${op} ${op}))`, 'i32')
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
/** @param {String & {type: string}} v - any array type (array/flat_array/ring_array) */
export const isArray = v => v.type === 'array' || v.type === 'flat_array' || v.type === 'ring_array'
/** @param {String & {type: string}} v - known flat array (O(1) push/pop without ring check) */
export const isFlatArray = v => v.type === 'flat_array'
/** @param {String & {type: string}} v - known ring buffer (O(1) all ops via head pointer) */
export const isRingArray = v => v.type === 'ring_array'
/** @param {String & {type: string}} v */
export const isObject = v => v.type === 'object'
/** @param {String & {type: string}} v */
export const isClosure = v => v.type === 'closure'
/** @param {String & {type: string}} v */
export const isRef = v => v.type === 'ref'
/** @param {String & {type: string}} v */
export const isRefArray = v => v.type === 'refarray'
/** @param {String & {type: string}} v - Boxed string (object with schema[0]==='__string__') */
export const isBoxedString = v => v.type === 'object' && Array.isArray(v.schema) && v.schema[0] === '__string__'
/** @param {String & {type: string}} v - Boxed number (object with schema[0]==='__number__') */
export const isBoxedNumber = v => v.type === 'object' && Array.isArray(v.schema) && v.schema[0] === '__number__'
/** @param {String & {type: string}} v - Boxed boolean (object with schema[0]==='__boolean__') */
export const isBoxedBoolean = v => v.type === 'object' && Array.isArray(v.schema) && v.schema[0] === '__boolean__'
/** @param {String & {type: string}} v - Boxed array (object with schema[0]==='__array__') */
export const isBoxedArray = v => v.type === 'object' && Array.isArray(v.schema) && v.schema[0] === '__array__'
/** @param {String & {type: string}} v - Any boxed primitive (schema[0] starts with '__') */
export const isBoxed = v => v.type === 'object' && Array.isArray(v.schema) && v.schema[0]?.startsWith('__')
/** @param {String & {type: string}} v - Regex pattern */
export const isRegex = v => v.type === 'regex'
/** @param {String & {type: string}} v - Set collection */
export const isSet = v => v.type === 'set'
/** @param {String & {type: string}} v - Map collection */
export const isMap = v => v.type === 'map'
/** @param {String & {type: string}} v - Symbol (ATOM type with id) */
export const isSymbol = v => v.type === 'symbol'

// === Compound predicates ===
/** @param {String & {type: string}} a @param {String & {type: string}} b */
export const bothI32 = (a, b) => a.type === 'i32' && b.type === 'i32'
/** @param {String & {type: string}} v */
export const isHeapRef = v => v.type === 'array' || v.type === 'flat_array' || v.type === 'ring_array' || v.type === 'object' || v.type === 'refarray' || v.type === 'ref'
/** @param {String & {type: string, schema?: *}} v */
export const hasSchema = v => v.schema !== undefined
