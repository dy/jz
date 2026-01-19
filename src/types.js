/**
 * Type system and coercions for jz compiler
 *
 * Typed values: [type, wat, schema?]
 * - type: 'f64' | 'i32' | 'ref' | 'array' | 'string' | 'object' | 'closure'
 * - wat: WAT expression string
 * - schema: optional object property schema for structs
 *
 * gc:false uses NaN-boxing for pointers (arrays, strings, objects, closures)
 */

// Pointer types for gc:false NaN-boxing mode
// Layout: f64 NaN pattern with mantissa [type:4][length:28][offset:20]
// Types 1-7 are pointers (quiet bit clear), types 8-15 reserved for canonical NaN
export const PTR_TYPE = {
  F64_ARRAY: 1,   // Float64Array
  I32_ARRAY: 2,   // Int32Array
  STRING: 3,      // UTF-16 string
  I8_ARRAY: 4,    // Int8Array
  OBJECT: 5,      // Object
  REF_ARRAY: 6,   // Mixed-type array
  CLOSURE: 7      // Closure environment
}

// Element sizes in bytes per pointer type
export const PTR_ELEM_SIZE = { 1: 8, 2: 4, 3: 2, 4: 1, 5: 8, 6: 8, 7: 8 }

// Typed value constructor: [type, wat, schema?]
export const tv = (t, wat, schema) => [t, wat, schema]

// Format number for WAT output
export const fmtNum = n =>
  Object.is(n, -0) ? '-0' :
  Number.isNaN(n) ? 'nan' :
  n === Infinity ? 'inf' :
  n === -Infinity ? '-inf' :
  String(n)

// Coerce typed value to f64
export const asF64 = ([t, w]) =>
  t === 'f64' || t === 'array' || t === 'string' ? [t, w] :
  t === 'ref' || t === 'object' ? ['f64', '(f64.const 0)'] :
  t === 'closure' ? [t, w] :
  ['f64', `(f64.convert_i32_s ${w})`]

// Coerce typed value to i32
export const asI32 = ([t, w]) =>
  t === 'i32' ? [t, w] :
  t === 'ref' || t === 'object' || t === 'closure' ? ['i32', '(i32.const 0)'] :
  ['i32', `(i32.trunc_f64_s ${w})`]

// Convert typed value to boolean (i32 0 or 1)
export const truthy = ([t, w]) =>
  t === 'ref' ? ['i32', `(i32.eqz (ref.is_null ${w}))`] :
  t === 'i32' ? ['i32', `(i32.ne ${w} (i32.const 0))`] :
  ['i32', `(f64.ne ${w} (f64.const 0))`]

// Make two values same type for comparison (both i32 or both f64)
export const conciliate = (a, b) =>
  a[0] === 'i32' && b[0] === 'i32' ? [a, b] : [asF64(a), asF64(b)]
