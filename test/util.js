// Test utilities
import jz from '../index.js'
import compile from '../index.js'

/** Evaluate a JS expression via jz → WASM. */
export async function evaluate(code) {
  const wasm = jz(`export let main = () => ${code}`)
  const { instance } = await WebAssembly.instantiate(wasm)
  return instance.exports.main()
}

/**
 * Compile and instantiate, with automatic rest-param wrapping
 * @param {string} code - jz code
 * @returns {WebAssembly.Instance.exports} Wrapped exports
 */
export function run(code) {
  const wasm = compile(code)
  const mod = new WebAssembly.Module(wasm)
  const inst = new WebAssembly.Instance(mod)

  // Read jz:rest custom section to know which functions have rest params
  const restFuncs = new Set()
  const customSections = WebAssembly.Module.customSections(mod, 'jz:rest')
  if (customSections.length) {
    const text = new TextDecoder().decode(customSections[0])
    try {
      const funcs = JSON.parse(text)
      funcs.forEach(name => restFuncs.add(name))
    } catch (e) {
      // ignore parse errors
    }
  }

  // Wrap rest-param functions with a proxy
  const wrappedExports = {}
  for (const [name, fn] of Object.entries(inst.exports)) {
    if (restFuncs.has(name) && typeof fn === 'function') {
      wrappedExports[name] = function(...args) {
        // Create array from arguments and pass as single parameter
        const jzMem = jz.mem(inst)
        const arrayPtr = jzMem.Array(args)
        return fn(arrayPtr)
      }
    } else {
      wrappedExports[name] = fn
    }
  }

  return wrappedExports
}
