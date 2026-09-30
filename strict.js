/** Compile the canonical JavaScript subset without the JavaScript lowering layer. */
import { compileSource } from './src/compiler.js'

export function compile(source, options = {}) {
  return compileSource(source, { ...options, strict: true })
}

export default compile
