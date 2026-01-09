// WAT module generation with full floatbeat support
import { generateImports, generateLocals, needsArrayType, generateStdLib as codegenStdLib } from './codegen.js'

export function generateModuleWithStdLib(mainCode, options = {}) {
  let wat = '(module\n'

  // GC array type for f64 arrays (if needed)
  if (needsArrayType()) {
    wat += '  (type $f64array (array (mut f64)))\n'
  }

  // Math imports
  const imports = generateImports()
  if (imports) wat += imports

  // Local variable declarations
  const locals = generateLocals()
  const localDecl = locals ? `\n    ${locals}` : ''

  // Stdlib functions (die, f64.rem)
  const stdLib = codegenStdLib()
  if (stdLib) wat += `  ;; stdlib${stdLib}\n`

  // Main function with t parameter
  wat += `
  (func $main (export "main") (param $t f64) (result f64)${localDecl}
    ${mainCode}
  )
)`
  return wat
}

// Math import object for WASM instantiation
export const mathImports = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  pow: Math.pow,
  cbrt: Math.cbrt,
  sign: Math.sign,
  round: Math.round,
  random: Math.random,
  fract: x => x - Math.floor(x),
}
