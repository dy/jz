// Test utilities
import { compile, instantiate, compileWat } from '../index.js'
import { assembleRaw } from '../src/compile.js'

// GC mode from environment
export const gc = process.env.GC !== 'false'
export const isGcTrue = gc
export const isGcFalse = !gc

// Evaluate JS expression
export async function evaluate(code, options = {}) {
  const useGc = 'gc' in options ? options.gc : gc
  const wasm = compile(code, { gc: useGc })
  const instance = await instantiate(wasm)
  return instance.run()
}

// Evaluate raw WAT expression
export async function evaluateWat(code) {
  const wat = assembleRaw(code)
  const wasm = compileWat(wat)
  const instance = await instantiate(wasm)
  return instance.run()
}
