// jz - JS subset to WASM compiler
import 'subscript/jessie'
import { parse } from 'subscript/jessie'
import * as watr from 'watr'
import normalize from './src/normalize.js'
import { compile as compileAst, assemble } from './src/compile.js'

// Pointer encoding (Strategy B - Integer-Packed)
// Format: type * 2^52 + schemaId * 2^48 + len * 2^32 + offset
// Layout: [type:4][schemaId:4][len:16][offset:32] = 56 bits, fits in f64 precision
// Type codes: 1=F64_ARRAY, 2=I32_ARRAY, 3=STRING, 6=REF_ARRAY, 7=CLOSURE
// SchemaId: 0 = plain array, 1-15 = object schema (16 schemas max)
const PTR_THRESHOLD = 2 ** 48

// Check if f64 is a pointer (>= threshold)
const isPtr = (v) => typeof v === 'number' && v >= PTR_THRESHOLD && v < Infinity

// Decode f64 pointer to { type, schemaId, len, offset }
const decodePtr = (ptr) => ({
  type: Math.floor(ptr / 2 ** 52) & 0xF,
  schemaId: Math.floor(ptr / 2 ** 48) & 0xF,
  len: Math.floor(ptr / 2 ** 32) & 0xFFFF,
  offset: ptr % (2 ** 32) | 0
})

// Encode { type, schemaId, len, offset } to f64 pointer
const encodePtr = (type, schemaId, len, offset) =>
  type * 2 ** 52 + schemaId * 2 ** 48 + len * 2 ** 32 + (offset >>> 0)

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

// Create JS value from memory pointer (handles arrays, objects, and strings)
function ptrToValue(memory, ptr, schemas) {
  if (!isPtr(ptr)) return ptr // not a pointer, return as-is
  const { type, schemaId, len, offset } = decodePtr(ptr)

  // Type 3 = STRING: read UTF-16 data
  if (type === 3) {
    const view = new Uint16Array(memory.buffer, offset, len)
    return String.fromCharCode(...view)
  }

  // Type 1,6 = arrays or objects: read f64 data
  const view = new Float64Array(memory.buffer, offset, len)
  const arr = Array.from(view).map(v => ptrToValue(memory, v, schemas))

  // If schemaId > 0, convert to object using schema
  if (schemaId > 0 && schemas && schemas[schemaId]) {
    const keys = schemas[schemaId]
    const obj = {}
    for (let i = 0; i < keys.length; i++) {
      obj[keys[i]] = arr[i]
    }
    return obj
  }
  return arr
}

// Create memory pointer from JS value (array or object)
function valueToPtr(exports, val, schemas) {
  if (val == null) return 0

  // Handle objects with schema lookup
  if (typeof val === 'object' && !Array.isArray(val)) {
    const keys = Object.keys(val)
    // Find matching schema
    let schemaId = 0
    if (schemas) {
      for (const [id, schemaKeys] of Object.entries(schemas)) {
        if (schemaKeys.length === keys.length && schemaKeys.every((k, i) => k === keys[i])) {
          schemaId = Number(id)
          break
        }
      }
    }
    // Convert object to array
    const arr = keys.map(k => val[k])
    const ptr = exports._alloc(1, arr.length) // type 1 = F64_ARRAY
    const { offset } = decodePtr(ptr)
    const view = new Float64Array(exports._memory.buffer, offset, arr.length)
    view.set(arr)
    // Re-encode with schemaId if found
    if (schemaId > 0) {
      return encodePtr(1, schemaId, arr.length, offset)
    }
    return ptr
  }

  // Handle arrays
  if (!Array.isArray(val)) return val // not an array/object, pass through
  const ptr = exports._alloc(1, val.length) // type 1 = F64_ARRAY
  const { offset } = decodePtr(ptr)
  const view = new Float64Array(exports._memory.buffer, offset, val.length)
  view.set(val)
  return ptr
}

// Wrap export function with array/object marshaling
function wrapExport(exports, name, sig, schemas) {
  const rawFn = exports[name]
  if (typeof rawFn !== 'function') return rawFn

  // sig format: { arrayParams: [0, 2], returnsArray: true }
  const { arrayParams = [], returnsArray = false } = sig
  if (arrayParams.length === 0 && !returnsArray) return rawFn

  return function (...args) {
    // Convert array/object args to pointers
    const convertedArgs = args.map((arg, i) => {
      if (arrayParams.includes(i)) {
        return valueToPtr(exports, arg, schemas)
      }
      return arg
    })

    const result = rawFn.apply(null, convertedArgs)

    // Convert pointer result to array/object
    if (returnsArray && isPtr(result)) {
      return ptrToValue(exports._memory, result, schemas)
    }
    return result
  }
}

// Instantiate WASM binary with auto-wrapped exports
export async function instantiate(wasm, imports = {}) {
  try {
    const module = await WebAssembly.compile(wasm)

    // Read signatures and schemas from custom section
    const sigJson = readCustomSection(module, 'jz:sig')
    const sigData = sigJson ? JSON.parse(sigJson) : {}
    const schemas = sigData.schemas || {}
    // Remove schemas from sigData to get pure function signatures
    const signatures = { ...sigData }
    delete signatures.schemas

    const instance = await WebAssembly.instantiate(module, imports)
    const rawExports = instance.exports

    // Build wrapped exports object
    const wrapped = {
      run: () => ptrToValue(rawExports._memory, rawExports.main?.(), schemas),
      wasm: rawExports  // raw WASM exports namespace
    }

    // Add wrapped exports for functions with signatures
    for (const [name, value] of Object.entries(rawExports)) {
      if (name in signatures) {
        wrapped[name] = wrapExport(rawExports, name, signatures[name], schemas)
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
