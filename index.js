// jz - JS subset to WASM compiler
import { parse } from './src/parse.js'
import normalize from './src/normalize.js'
import { compile as compileAst, assembleRaw } from './src/compile.js'
import { compileWat, instantiate } from './src/wasm.js'

// Compile JS to WASM binary or WAT string
export function compile(code, options = {}) {
  const { format = 'binary', gc = true } = options
  const ast = normalize(parse(code))
  const wat = compileAst(ast, { gc })
  return format === 'wat' ? wat : compileWat(wat)
}

export { parse, normalize, compileAst, assembleRaw, compileWat, instantiate }
