import { JZOutput } from './src/output.js'

const output = new JZOutput()

export function compile(code, options = {}) {
  const { format = 'binary' } = options
  return format === 'wat' ? output.compileToWat(code, options) : output.compile(code, options)
}

export function compileToWat(code, options = {}) {
  return output.compileToWat(code, options)
}

export async function instantiate(wasm, imports = {}) {
  const instance = await output.compileAndInstantiateFromBinary(wasm, imports)
  return output.createInterface(instance)
}

export async function evaluate(code) {
  const wasm = compile(code)
  const instance = await instantiate(wasm)
  return instance.run()
}

export default { compile, compileToWat, instantiate, evaluate }
