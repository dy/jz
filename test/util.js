// Test utilities
import { compile, instantiate, compileWat } from '../index.js'
import { assembleRaw } from '../src/compile.js'

// Format from environment: GC=false -> wasm-mvp, otherwise wasm
export const format = process.env.GC === 'false' ? 'wasm-mvp' : 'wasm'
export const isGcTrue = format === 'wasm'
export const isGcFalse = format === 'wasm-mvp'
// Legacy export for compatibility
export const gc = isGcTrue

// Evaluate JS expression at sample time t
export async function evaluate(code, t = 0, options = {}) {
  // Support both legacy gc option and new format option
  let fmt = format
  if ('gc' in options) fmt = options.gc ? 'wasm' : 'wasm-mvp'
  if ('format' in options) fmt = options.format
  
  const wasm = compile(code, { format: fmt })
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
