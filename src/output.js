import { compile as watrCompile } from 'watr'
import { generateModuleWithStdLib, mathImports } from './stdlib.js'
import { compile as compileJs } from './compiler.js'

export function compile(code, options = {}) {
  // If the input already looks like a WAT expression (starts with WAT instruction),
  // keep backwards-compatibility with tests that use raw WAT snippets.
  // WAT expressions start with ( followed by instruction: i32, i64, f32, f64, local, global, call, etc.
  const isWatExpr = typeof code === 'string' && /^\s*\((i32|i64|f32|f64|local|global|call|block|loop|if|br|return|unreachable|nop|drop|select|memory|table|ref|struct|array)\b/.test(code)
  const compiled = isWatExpr ? { exprWat: code } : compileJs(code, options)
  const wat = generateModuleWithStdLib(compiled.exprWat, options)
  try {
    return watrCompile(wat)
  } catch (error) {
    throw new Error(`Compilation failed: ${error.message}\nWAT:\n${wat}`)
  }
}

export async function compileAndInstantiate(code, imports = {}, options = {}) {
  const wasm = compile(code, options)
  return compileAndInstantiateFromBinary(wasm, imports)
}

export async function compileAndInstantiateFromBinary(wasm, imports = {}) {
  try {
    const module = await WebAssembly.compile(wasm)
    // Merge math imports with user imports
    const fullImports = { math: mathImports, ...imports }
    return await WebAssembly.instantiate(module, fullImports)
  } catch (error) {
    throw new Error(`Instantiation failed: ${error.message}`)
  }
}

export function compileToWat(code, options = {}) {
  const isWatExpr = typeof code === 'string' && /^\s*\(/.test(code)
  const compiled = isWatExpr ? { exprWat: code } : compileJs(code, options)
  return generateModuleWithStdLib(compiled.exprWat, options)
}

export function createInterface(instance) {
  return {
    run: (t = 0) => instance.exports.main(t),
    memory: instance.exports.memory,
    exports: instance.exports
  }
}
