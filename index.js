// jz - JS expression to WASM compiler
import parse from './src/parser.js'
import normalize from './src/normalize.js'
import { compile as compileAst } from './src/wat.js'
import { compileWat, instantiate } from './src/wasm.js'

// Compile JS expression to WASM binary or WAT string
export function compile(code, options = {}) {
  const { format = 'binary' } = options
  const ast = normalize(parse(code))
  const wat = compileAst(ast)
  return format === 'wat' ? wat : compileWat(wat)
}

export { instantiate }
