import { compile as outputCompile, compileToWat, compileAndInstantiateFromBinary, createInterface } from './src/output.js'

export function compile(code, options = {}) {
  const { format = 'binary' } = options
  return format === 'wat' ? compileToWat(code, options) : outputCompile(code, options)
}

export async function instantiate(wasm, imports = {}) {
  const instance = await compileAndInstantiateFromBinary(wasm, imports)
  return createInterface(instance)
}

export async function evaluate(code, t = 0) {
  const wasm = compile(code)
  const instance = await instantiate(wasm)
  return instance.run(t)
}

export default { compile, compileToWat, instantiate, evaluate }
