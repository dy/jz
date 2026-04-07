// Test utilities
import jz, { compile } from '../index.js'
import { wasi } from '../wasi.js'

/** Evaluate a JS expression via jz → WASM. */
export async function evaluate(code) {
  const wasm = compile(`export let main = () => ${code}`)
  const { instance } = await WebAssembly.instantiate(wasm)
  return instance.exports.main()
}

/**
 * Compile and instantiate, with automatic export wrapping.
 * Uses jz.wrap() — single source of truth for JS calling convention.
 * @param {string} code - jz code
 * @returns {object} Wrapped exports
 */
export function run(code) {
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  const needsWasi = WebAssembly.Module.imports(mod).some(i => i.module === 'wasi_snapshot_preview1')
  const imports = needsWasi ? wasi() : undefined
  const inst = new WebAssembly.Instance(mod, imports)
  if (needsWasi) imports._setMemory(inst.exports.memory)

  return jz.wrap(mod, inst)
}
