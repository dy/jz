// Test utilities
import jz from '../index.js'

/** Evaluate a JS expression via jz → WASM. */
export async function evaluate(code) {
  const wasm = jz(`export let main = () => ${code}`)
  const { instance } = await WebAssembly.instantiate(wasm)
  return instance.exports.main()
}
