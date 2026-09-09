/** Fixed scalar intrinsic signatures. Available in both compiler hosts without
 *  reflecting on JavaScript handler functions. Variadic intrinsics need their
 *  own argument lowering and are not described by a fixed parameter count. */
export const INTRINSIC_ARITY = {
  'Array.isArray': 1,
  'Number.isFinite': 1, 'Number.isNaN': 1, 'Number.isInteger': 1, 'Number.isSafeInteger': 1,
  'math.abs': 1, 'math.acos': 1, 'math.acosh': 1, 'math.asin': 1, 'math.asinh': 1,
  'math.atan': 1, 'math.atanh': 1, 'math.cbrt': 1, 'math.ceil': 1, 'math.clz32': 1,
  'math.cos': 1, 'math.cosh': 1, 'math.exp': 1, 'math.expm1': 1, 'math.f16round': 1,
  'math.floor': 1, 'math.fround': 1, 'math.log': 1, 'math.log10': 1, 'math.log1p': 1,
  'math.log2': 1, 'math.round': 1, 'math.sign': 1, 'math.sin': 1, 'math.sinh': 1,
  'math.sqrt': 1, 'math.tan': 1, 'math.tanh': 1, 'math.trunc': 1,
  'math.atan2': 2, 'math.imul': 2, 'math.pow': 2,
}
