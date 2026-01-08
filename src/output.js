import { compile as watrCompile } from 'watr'
import { generateModuleWithStdLib } from './stdlib.js'

export class JZOutput {
  constructor() {
    this.modules = new Map()
  }

  compile(code, options = {}) {
    const wat = generateModuleWithStdLib(code, options)
    try {
      return watrCompile(wat)
    } catch (error) {
      throw new Error(`Compilation failed: ${error.message}`)
    }
  }

  async compileAndInstantiate(code, imports = {}, options = {}) {
    const wasm = this.compile(code, options)
    return this.compileAndInstantiateFromBinary(wasm, imports)
  }

  async compileAndInstantiateFromBinary(wasm, imports = {}) {
    try {
      const module = await WebAssembly.compile(wasm)
      return await WebAssembly.instantiate(module, imports)
    } catch (error) {
      throw new Error(`Instantiation failed: ${error.message}`)
    }
  }

  compileToWat(code, options = {}) {
    return generateModuleWithStdLib(code, options)
  }

  createInterface(instance) {
    return {
      run: () => instance.exports.main(),
      memory: instance.exports.memory,
      exports: instance.exports
    }
  }
}