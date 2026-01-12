// WAT to WASM compilation and instantiation
import { compile as watrCompile } from 'watr'

// Compile WAT string to WASM binary
export function compileWat(wat) {
  try {
    return watrCompile(wat)
  } catch (error) {
    throw new Error(`WAT compilation failed: ${error.message}\nWAT:\n${wat}`)
  }
}

// Instantiate WASM binary
export async function instantiate(wasm, imports = {}) {
  try {
    const module = await WebAssembly.compile(wasm)
    const instance = await WebAssembly.instantiate(module, imports)
    return {
      run: (t = 0) => instance.exports.main?.(t),
      exports: instance.exports,
      ...instance.exports  // Spread exports for convenience
    }
  } catch (error) {
    throw new Error(`WASM instantiation failed: ${error.message}`)
  }
}
