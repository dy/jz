import type { CompileOptions, CompiledWasm } from './index.js'

/** Compile canonical JavaScript: let/const, arrows and structured control flow.
 * Reject dynamic fallback operations. Instantiate with jz/interop. */
export function compile(source: string, options: CompileOptions & { wat: true }): string
export function compile(source: string, options?: CompileOptions & { wat?: false }): CompiledWasm
export function compile(source: string, options?: CompileOptions): CompiledWasm | string
export default compile
