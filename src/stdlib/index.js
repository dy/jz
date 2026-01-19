// JZ Standard Library - Method Implementations
// Re-exports all stdlib modules

export { arrayMethods, PTR_TYPE as ARRAY_PTR_TYPE } from './array.js'
export { stringMethods, PTR_TYPE as STRING_PTR_TYPE } from './string.js'

// Shared PTR_TYPE constants
export const PTR_TYPE = { F64_ARRAY: 1, STRING: 2, I32_ARRAY: 3, I8_ARRAY: 4, REF_ARRAY: 5, OBJECT: 6 }
