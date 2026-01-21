// Test utilities
import { compile as jzCompile, instantiate, compileWat } from '../index.js'
import { assemble } from '../src/compile.js'

// Evaluate JS expression
export async function evaluate(code, options = {}) {
  const wasm = jzCompile(code)
  const instance = await instantiate(wasm)
  return instance.run()
}

// Compile and return exported functions
export async function compile(code) {
  const wasm = jzCompile(code)
  return await instantiate(wasm)
}

// Evaluate raw WAT expression
export async function evaluateWat(code) {
  const wat = assemble(code)
  const wasm = compileWat(wat)
  const instance = await instantiate(wasm)
  return instance.run()
}
