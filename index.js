// jz - JS subset to WASM compiler
import 'subscript/jessie'
import { parse } from 'subscript/jessie'
import { compile as watrCompile } from 'watr'
import normalize from './src/normalize.js'
import { compile as compileAst, assembleRaw } from './src/compile.js'

// Options:
// - gc: true (default) - WASM GC (Chrome 119+, Firefox 120+)
// - gc: false - linear memory (works everywhere)
// - text: true - output WAT text instead of WASM binary

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

// Compile JS to WASM
export function compile(code, options = {}) {
  const { gc = true, text = false } = options
  const ast = normalize(parse(code))
  const wat = compileAst(ast, { gc })
  return text ? wat : compileWat(wat)
}

export { parse, normalize, compileAst, assembleRaw }
