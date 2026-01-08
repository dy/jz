import { parse as subscriptParse, compile as subscriptCompile } from 'subscript'
import { parse } from './parser.js'
import { generate } from './codegen.js'

export function compile(code, options = {}) {
  try {
    const ast = parse(code)
    return generate(ast)
  } catch (error) {
    throw new Error(`Compilation failed: ${error.message}`)
  }
}

export async function instantiate(code, imports = {}) {
  const wasm = compile(code)
  const module = await WebAssembly.compile(wasm)
  return await WebAssembly.instantiate(module, imports)
}

export function evaluate(code) {
  try {
    const instance = instantiate(code, {
      js: {
        memory: new WebAssembly.Memory({ initial: 1 }),
        table: new WebAssembly.Table({ initial: 1, element: 'anyfunc' }),
        Math: {}
      }
    })
    return instance.exports.main()
  } catch (error) {
    console.warn('WebAssembly evaluation failed, using subscript fallback:', error.message)
    const fn = subscriptCompile(subscriptParse(code))
    return fn({})
  }
}