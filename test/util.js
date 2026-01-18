// Test utilities
import { compile, instantiate } from '../index.js'
import { compileWat } from '../src/wasm.js'
import { assembleRaw } from '../src/compile.js'

// Evaluate JS expression at sample time t
export async function evaluate(code, t = 0, options = {}) {
  const wasm = compile(code, options)
  const instance = await instantiate(wasm)
  return instance.run(t)
}

// Evaluate raw WAT expression
export async function evaluateWat(code, t = 0) {
  const wat = assembleRaw(code)
  const wasm = compileWat(wat)
  const instance = await instantiate(wasm)
  return instance.run(t)
}
