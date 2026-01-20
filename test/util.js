// Test utilities
import { compile, instantiate, compileWat } from '../index.js'
import { assemble } from '../src/compile.js'

// Evaluate JS expression
export async function evaluate(code, options = {}) {
  const wasm = compile(code)
  const instance = await instantiate(wasm)
  return instance.run()
}

// Evaluate raw WAT expression
export async function evaluateWat(code) {
  const wat = assemble(code)
  const wasm = compileWat(wat)
  const instance = await instantiate(wasm)
  return instance.run()
}
