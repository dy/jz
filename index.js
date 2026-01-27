/**
 * jz - JS subset to WASM compiler
 *
 * @example
 * import { compile } from 'jz'
 * const wasm = compile('export let f = x => x * 2')
 * const { f } = await WebAssembly.instantiate(wasm).then(m => m.instance.exports)
 * f(21) // 42
 */

export { compile, registerModule } from './src/compile.js'

// Re-export core API for module authors
export { type, emit, op, optimize, func, extern, needsMemory } from './module/_core.js'
