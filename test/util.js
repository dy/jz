// Test utilities
import jzCompile from '../index.js'
import math from '../module/math.js'


/**
 * Instantiate WASM binary and return instance with run() helper
 * @param {Uint8Array} wasm - WASM binary
 * @returns {Promise<{run: Function, exports: WebAssembly.Exports}>}
 */
export async function instantiate(wasm) {
  const { instance } = await WebAssembly.instantiate(wasm)
  return {
    exports: instance.exports,
    run: () => instance.exports['']?.() ?? instance.exports.main?.()
  }
}


// Evaluate JS expression
export async function evaluate(code, options = {}) {
  // Wrap expression in an exported function
  const wrapped = `export let main = () => ${code}`
  // jzCompile returns WASM binary directly
  const wasm = jzCompile(wrapped)
  const instance = await instantiate(wasm)
  return instance.run()
}

// Compile and return exported functions
export async function compile(code) {
  const wat = jzCompile(code)
  const wasm = watrCompile(wat)
  return await instantiate(wasm)
}
