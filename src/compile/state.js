// Shared compilation state - accessible by all compiler modules
// Pattern: module-level globals set once per compile() call

// Pointer types for gc:false mode
export const PTR_TYPE = { F64_ARRAY: 0, I32_ARRAY: 1, STRING: 2, I8_ARRAY: 3, OBJECT: 4, REF_ARRAY: 5 }
export const PTR_ELEM_SIZE = { 0: 8, 1: 4, 2: 2, 3: 1, 4: 8, 5: 8 }

// Current compilation context - set by compile()
export let ctx = null
export let opts = { gc: true }

// Typed value constructor
export const tv = (t, wat, schema) => [t, wat, schema]

// Number formatting for WAT
export const fmtNum = n =>
  Object.is(n, -0) ? '-0' :
  Number.isNaN(n) ? 'nan' :
  n === Infinity ? 'inf' :
  n === -Infinity ? '-inf' :
  String(n)

// Type coercions
export const asF64 = ([t, w]) =>
  t === 'f64' || t === 'array' || t === 'string' ? [t, w] :
  t === 'ref' || t === 'object' ? ['f64', '(f64.const 0)'] :
  ['f64', `(f64.convert_i32_s ${w})`]

export const asI32 = ([t, w]) =>
  t === 'i32' ? [t, w] :
  t === 'ref' || t === 'object' ? ['i32', '(i32.const 0)'] :
  ['i32', `(i32.trunc_f64_s ${w})`]

export const truthy = ([t, w]) =>
  t === 'ref' ? ['i32', `(i32.eqz (ref.is_null ${w}))`] :
  t === 'i32' ? ['i32', `(i32.ne ${w} (i32.const 0))`] :
  ['i32', `(f64.ne ${w} (f64.const 0))`]

export const conciliate = (a, b) =>
  a[0] === 'i32' && b[0] === 'i32' ? [a, b] : [asF64(a), asF64(b)]

// AST generator - set by compile() after gen is defined
export let gen = null

// Initialize state for a new compilation
export function initState(context, options, generator) {
  ctx = context
  opts = options
  gen = generator
}

// Set context only (for nested function generation)
export function setCtx(context) {
  const prev = ctx
  ctx = context
  return prev
}

// Helper to extract params from arrow function AST
export function extractParams(params) {
  if (!params) return []
  if (typeof params === 'string') return [params]
  if (Array.isArray(params)) {
    if (params[0] === '()' && params.length === 2) return extractParams(params[1])
    if (params[0] === ',') return params.slice(1).flatMap(extractParams)
    return params.flatMap(extractParams)
  }
  return []
}
