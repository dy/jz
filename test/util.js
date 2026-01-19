// Test utilities
import { compile, instantiate, compileWat } from '../index.js'
import { assembleRaw } from '../src/compile.js'

// GC mode from environment
export const gc = process.env.GC !== 'false'
export const isGcTrue = gc
export const isGcFalse = !gc

// Evaluate JS expression at sample time t
export async function evaluate(code, t = 0, options = {}) {
  const useGc = 'gc' in options ? options.gc : gc
  const wasm = compile(code, { gc: useGc })
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
