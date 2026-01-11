// WAT module assembly
// Combines codegen output with types and pure WASM stdlib
import { mathStdLib } from '../lib/math.wat.js'

// No JS imports needed - all math is pure WASM
export const mathImports = {}

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

  // Pure WASM math stdlib - no imports
  wat += mathStdLib()

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
