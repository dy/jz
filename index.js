// jz - JS subset to WASM compiler
import 'subscript/jessie'
import { parse } from 'subscript/jessie'
import { compile as watrCompile } from 'watr'
import normalize from './src/normalize.js'
import { compile as compileAst, assembleRaw } from './src/compile.js'

// Supported formats:
// - 'wasm'     Modern WASM with GC (default) - Chrome 119+, Firefox 120+
// - 'wasm-mvp' WASM MVP without GC - works everywhere
// - 'wat'      WAT text format with GC
// - 'wat-mvp'  WAT text format without GC
// Future: 'c', 'glsl'

// Compile WAT string to WASM binary
export function compileWat(wat) {
  try {
    return watrCompile(wat)
  } catch (error) {
    throw new Error(`WAT compilation failed: ${error.message}\nWAT:\n${wat}`)
  }
}

// Instantiate WASM binary
export async function instantiate(wasm, imports = {}) {
  try {
    const module = await WebAssembly.compile(wasm)
    const instance = await WebAssembly.instantiate(module, imports)
    return {
      run: (t = 0) => instance.exports.main?.(t),
      exports: instance.exports,
      ...instance.exports
    }
  } catch (error) {
    throw new Error(`WASM instantiation failed: ${error.message}`)
  }
}

// Compile JS to target format
export function compile(code, options = {}) {
  // Support both new format API and legacy gc option
  let { format = 'wasm', gc } = options
  
  // Legacy gc option support
  if (gc !== undefined) {
    format = gc ? 'wasm' : 'wasm-mvp'
  }
  
  // Parse format
  const useGC = !format.includes('mvp')
  const outputText = format.startsWith('wat')
  
  const ast = normalize(parse(code))
  const wat = compileAst(ast, { gc: useGC })
  return outputText ? wat : compileWat(wat)
}

export { parse, normalize, compileAst, assembleRaw }
