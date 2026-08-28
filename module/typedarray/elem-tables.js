/**
 * Per-element-kind constant tables — stride (bytes), shift (log2 stride),
 * and the load/store WAT opcode for each of the 8 TypedArray element kinds
 * (index order: i8,u8,i16,u16,i32,u32,f32,f64 — see layout.js's
 * TYPED_ELEM_CODE, the canonical index assignment).
 *
 * Pure move out of module/typedarray.js (stdlib-generators minimality
 * pass): a dependency-free leaf so both typedarray.js and
 * typedarray/simd-map.js can import these tables without typedarray.js's
 * own resolveModuleGraph (self-compile) seeing a circular import — simd-map.js
 * imports analyzeSimd/genSimdMap INTO typedarray.js, so these tables can't
 * flow the other way through typedarray.js itself.
 *
 * @module typedarray/elem-tables
 */

export const STRIDE = [1, 1, 2, 2, 4, 4, 4, 8]
export const SHIFT = [0, 0, 1, 1, 2, 2, 2, 3]
export const LOAD = [
  'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u',
  'i32.load', 'i32.load', 'f32.load', 'f64.load',
]
export const STORE = [
  'i32.store8', 'i32.store8', 'i32.store16', 'i32.store16',
  'i32.store', 'i32.store', 'f32.store', 'f64.store',
]
