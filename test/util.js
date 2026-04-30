// Test utilities
import jz, { compile } from '../index.js'

/** Evaluate a JS expression via jz → WASM. */
export async function evaluate(code) {
  return jz(`export let main = () => ${code}`).exports.main()
}

/** Compile, instantiate, and wrap exports. Single source of truth via jz(). */
export const run = (code) => jz(code).exports
