// jz - JS expression to WASM compiler
import { parse, normalize } from './src/parser.js'
import { generate, generateExpression, getContext } from './src/codegen.js'
import { assembleModule, mathImports } from './src/module.js'
import { compileWat, instantiate } from './src/wasm.js'

// Preprocess JS literals subscript doesn't handle
function preprocess(code) {
  if (typeof code !== 'string') return code
  return code
    .replace(/\b0[bB]([01]+)\b/g, (_, b) => String(parseInt(b, 2)))
    .replace(/\b0[oO]([0-7]+)\b/g, (_, o) => String(parseInt(o, 8)))
    .replace(/\b0[xX]([0-9a-fA-F]+)\b/g, (_, h) => String(parseInt(h, 16)))
}

// Compile JS expression to WASM binary or WAT string
export function compile(code, options = {}) {
  const { format = 'binary' } = options

  // Support raw WAT expressions for testing
  const isWat = typeof code === 'string' &&
    /^\s*\((i32|i64|f32|f64|local|global|call|block|loop|if|br|return|unreachable|nop|drop|select|memory|table|ref|struct|array)\b/.test(code)

  let wat
  if (isWat) {
    wat = assembleModule(code, {
      usedArrayType: false, usedStringType: false,
      usedImports: new Set(), structTypes: new Map(), localDecls: []
    })
  } else {
    const ast = normalize(parse(preprocess(code)))
    const bodyWat = generateExpression(ast)
    wat = assembleModule(bodyWat, getContext())
  }

  return format === 'wat' ? wat : compileWat(wat)
}

// Compile to WAT string
export function compileToWat(code, options = {}) {
  return compile(code, { ...options, format: 'wat' })
}

// Evaluate JS expression at sample time t
export async function evaluate(code, t = 0) {
  const wasm = compile(code)
  const instance = await instantiate(wasm)
  return instance.run(t)
}

export { instantiate, mathImports }
export default { compile, compileToWat, evaluate, instantiate }
