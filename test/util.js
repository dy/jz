// Test utilities
import { compile, instantiate, compileWat } from '../index.js'
import { assembleRaw } from '../src/compile.js'

// Get GC mode from environment variable
// GC=true or GC=false (defaults to true)
const gcMode = process.env.GC === 'false' ? false : true

// Export GC mode for tests that need mode-specific behavior
export const isGcTrue = gcMode === true
export const isGcFalse = gcMode === false

// Evaluate JS expression at sample time t
export async function evaluate(code, t = 0, options = {}) {
  // Merge env GC setting with any explicit options
  const finalOptions = { gc: gcMode, ...options }
  const wasm = compile(code, finalOptions)
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
