// WAT module assembly
// Combines codegen output with types, imports, and stdlib into complete module

// Math import object for WASM instantiation
export const mathImports = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  exp: Math.exp, expm1: Math.expm1, log: Math.log, log2: Math.log2, log10: Math.log10, log1p: Math.log1p,
  pow: Math.pow, cbrt: Math.cbrt, hypot: Math.hypot, sign: Math.sign, round: Math.round, fround: Math.fround,
  random: Math.random,
  fract: x => x - Math.floor(x),
}

// Import signatures
const NULLARY = ['random']
const UNARY = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'sign', 'round', 'fract', 'fround']
const BINARY = ['pow', 'atan2', 'hypot']

// Generate complete WAT module
export function assembleModule(bodyWat, ctx, extraFunctions = []) {
  let wat = '(module\n'

  // GC types
  if (ctx.usedArrayType) wat += '  (type $f64array (array (mut f64)))\n'
  if (ctx.usedStringType) wat += '  (type $string (array (mut i8)))\n'

  // Struct types for objects
  for (const [, st] of ctx.structTypes) {
    const fields = st.fields.map(f => `(field $${f} (mut f64))`).join(' ')
    wat += `  (type $${st.typeName} (struct ${fields}))\n`
  }

  // Math imports
  for (const fn of ctx.usedImports) {
    if (NULLARY.includes(fn))
      wat += `  (import "math" "${fn}" (func $${fn} (result f64)))\n`
    else if (UNARY.includes(fn))
      wat += `  (import "math" "${fn}" (func $${fn} (param f64) (result f64)))\n`
    else if (BINARY.includes(fn))
      wat += `  (import "math" "${fn}" (func $${fn} (param f64 f64) (result f64)))\n`
  }

  // Module-level globals
  for (const [name, g] of ctx.globals) {
    wat += `  (global $${name} (mut f64) ${g.init})\n`
  }

  // Stdlib functions
  wat += `  (func $die (result f64) (unreachable))\n`
  wat += `  (func $f64.rem (param f64 f64) (result f64)
    (f64.sub (local.get 0) (f64.mul (f64.trunc (f64.div (local.get 0) (local.get 1))) (local.get 1))))\n`

  // User-defined functions (from arrow function definitions)
  for (const fn of extraFunctions) {
    wat += `  ${fn}\n`
  }

  // Main function (only if there's body code that isn't just function definitions)
  const hasMainBody = bodyWat && bodyWat.trim() && bodyWat.trim() !== '(f64.const 0)'
  if (hasMainBody || extraFunctions.length === 0) {
    const locals = ctx.localDecls.length ? `\n    ${ctx.localDecls.join(' ')}` : ''
    wat += `
  (func $main (export "main") (param $t f64) (result f64)${locals}
    ${bodyWat}
  )`
  }

  wat += '\n)'
  return wat
}
