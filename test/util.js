// Test utilities
import { compile as jzCompile, instantiate } from '../index.js'
import { compile as watrCompile } from 'watr'
import { assemble } from '../src/assemble.js'

// Evaluate JS expression
export async function evaluate(code, options = {}) {
  const wat = jzCompile(code)
  const wasm = watrCompile(wat)
  const instance = await instantiate(wasm)
  return instance.run()
}

// Compile and return exported functions
export async function compile(code) {
  const wat = jzCompile(code)
  const wasm = watrCompile(wat)
  return await instantiate(wasm)
}

// Evaluate raw WAT expression
export async function evaluateWat(code) {
  const wat = assemble(code)
  const wasm = watrCompile(wat)
  const instance = await instantiate(wasm)
  return instance.run()
}
