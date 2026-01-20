// jz - JS subset to WASM compiler
import 'subscript/jessie'
import { parse } from 'subscript/jessie'
import * as watr from 'watr'
import normalize from './src/normalize.js'
import { compile as compileAst, assemble } from './src/compile.js'

// Pointer encoding constants
const PTR_THRESHOLD = 2 ** 48
const isPtr = (v) => typeof v === 'number' && v >= PTR_THRESHOLD

// Decode packed pointer to { type, len, offset }
const decodePtr = (ptr) => ({
  type: Math.floor(ptr / 2 ** 48),
  len: Math.floor(ptr / 2 ** 32) & 0xFFFF,
  offset: ptr % (2 ** 32) | 0
})

// Encode { type, len, offset } to packed pointer
const encodePtr = (type, len, offset) =>
  type * 2 ** 48 + len * 2 ** 32 + (offset >>> 0)

// Compile WAT string to WASM binary
export function compileWat(wat) {
  try {
    return watr.compile(wat)
  } catch (error) {
    throw new Error(`WAT compilation failed: ${error.message}\nWAT:\n${wat}`, { cause: error })
  }
}

// Read custom section from WASM module
function readCustomSection(module, name) {
  const sections = WebAssembly.Module.customSections(module, name)
  if (sections.length === 0) return null
  return new TextDecoder().decode(sections[0])
}

// Create JS array from memory pointer
function ptrToArray(memory, ptr) {
  if (!isPtr(ptr)) return ptr // not a pointer, return as-is
  const { len, offset } = decodePtr(ptr)
  const view = new Float64Array(memory.buffer, offset, len)
  return Array.from(view)
}

// Create memory pointer from JS array
function arrayToPtr(exports, arr) {
  if (!Array.isArray(arr)) return arr // not an array, pass through
  const ptr = exports._alloc(1, arr.length) // type 1 = F64_ARRAY
  const { offset } = decodePtr(ptr)
  const view = new Float64Array(exports._memory.buffer, offset, arr.length)
  view.set(arr)
  return ptr
}

// Wrap export function with array marshaling
function wrapExport(exports, name, sig) {
  const rawFn = exports[name]
  if (typeof rawFn !== 'function') return rawFn

  // sig format: { arrayParams: [0, 2], returnsArray: true }
  const { arrayParams = [], returnsArray = false } = sig
  if (arrayParams.length === 0 && !returnsArray) return rawFn

  return function (...args) {
    // Convert array args to pointers
    const convertedArgs = args.map((arg, i) => {
      if (arrayParams.includes(i)) {
        return arrayToPtr(exports, arg)
      }
      return arg
    })

    const result = rawFn.apply(null, convertedArgs)

    // Convert pointer result to array
    if (returnsArray && isPtr(result)) {
      return ptrToArray(exports._memory, result)
    }
    return result
  }
}

// Instantiate WASM binary with auto-wrapped exports
export async function instantiate(wasm, imports = {}) {
  try {
    const module = await WebAssembly.compile(wasm)

    // Read signatures from custom section
    const sigJson = readCustomSection(module, 'jz:sig')
    const signatures = sigJson ? JSON.parse(sigJson) : {}

    const instance = await WebAssembly.instantiate(module, imports)
    const rawExports = instance.exports

    // Build wrapped exports object
    const wrapped = {
      run: () => rawExports.main?.(),
      wasm: rawExports  // raw WASM exports namespace
    }

    // Add wrapped exports for functions with signatures
    for (const [name, value] of Object.entries(rawExports)) {
      if (name in signatures) {
        wrapped[name] = wrapExport(rawExports, name, signatures[name])
      } else if (typeof value === 'function') {
        wrapped[name] = value // no wrapping needed
      }
    }

    // Add non-function exports for backward compatibility (memory, tables, etc.)
    for (const [name, value] of Object.entries(rawExports)) {
      if (!(name in wrapped)) {
        wrapped[name] = value
      }
    }

    return wrapped
  } catch (error) {
    throw new Error(`WASM instantiation failed: ${error.message}`)
  }
}

// Compile JS to WASM
export function compile(code, options = {}) {
  const { text = false } = options
  const ast = normalize(parse(code))
  const wat = compileAst(ast)
  return text ? wat : compileWat(wat)
}

export { parse, normalize, compileAst, assemble }
