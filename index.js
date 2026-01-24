// jz - JS subset to WAT compiler
import 'subscript/jessie'
import { parse } from 'subscript/jessie'
import normalize, { getWarnings } from './src/normalize.js'
import { compile as compileAst, assemble } from './src/compile.js'

// NaN-boxing pointer encoding
// Format: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
// Payload: [type:4][aux:16][offset:31]
// Types: ARRAY=1, RING=2, TYPED=3, STRING=4, OBJECT=5, HASH=6, SET=7, MAP=8, CLOSURE=9, REGEX=10
// Canonical NaN (0x7FF8000000000000) is NOT a pointer - payload must be non-zero

const NAN_BOX_MASK = 0x7FF8000000000000n
const CANONICAL_NAN = 0x7FF8000000000000n
const buf = new ArrayBuffer(8)
const f64View = new Float64Array(buf)
const u64View = new BigUint64Array(buf)

// Check if f64 is a NaN-boxed pointer (not canonical NaN)
const isPtr = (v) => {
  if (typeof v !== 'number') return false
  f64View[0] = v
  const bits = u64View[0]
  // Must match NaN box pattern AND have non-zero payload
  return (bits & NAN_BOX_MASK) === NAN_BOX_MASK && bits !== CANONICAL_NAN
}

// Decode NaN-boxed pointer to { type, id, offset }
const decodePtr = (ptr) => {
  f64View[0] = ptr
  const bits = u64View[0]
  return {
    type: Number((bits >> 47n) & 0xFn),
    id: Number((bits >> 31n) & 0xFFFFn),
    offset: Number(bits & 0x7FFFFFFFn)
  }
}

// Encode { type, id, offset } to NaN-boxed pointer
const encodePtr = (type, id, offset) => {
  u64View[0] = NAN_BOX_MASK |
    (BigInt(type) << 47n) |
    (BigInt(id) << 31n) |
    BigInt(offset >>> 0)
  return f64View[0]
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
  const { type, id, offset } = decodePtr(ptr)

  // Type 4 = STRING: read UTF-16 data (id = length)
  if (type === 4) {
    const view = new Uint16Array(memory.buffer, offset, id)
    return String.fromCharCode(...view)
  }

  // Type 5 = OBJECT: id = schemaId (for legacy, still needed for some cases)
  if (type === 5 && schemas && schemas[id]) {
    const keys = schemas[id]
    const view = new Float64Array(memory.buffer, offset, keys.length)
    const obj = {}
    for (let i = 0; i < keys.length; i++) {
      obj[keys[i]] = ptrToValue(memory, view[i], schemas)
    }
    return obj
  }

  // Type 1 = ARRAY: unified array with length at offset-8
  if (type === 1) {
    // Read length from memory at offset-8
    const lenView = new Float64Array(memory.buffer, offset - 8, 1)
    const len = Math.floor(lenView[0])
    const view = new Float64Array(memory.buffer, offset, len)
    // Don't use Array.from - it canonicalizes NaN values, losing NaN-boxed pointers
    const result = []
    for (let i = 0; i < len; i++) {
      result.push(ptrToValue(memory, view[i], schemas))
    }
    return result
  }

  // Type 7 = SET: hash table with capacity/size at offset-16/-8
  if (type === 7) {
    const capView = new Float64Array(memory.buffer, offset - 16, 1)
    const cap = Math.floor(capView[0])
    const set = new Set()
    // Entry stride = 16 bytes (hash:f64, key:f64)
    for (let i = 0; i < cap; i++) {
      const entryOff = offset + i * 16
      const entry = new Float64Array(memory.buffer, entryOff, 2)
      const hash = entry[0]
      if (hash !== 0 && hash !== 1) { // occupied (0=empty, 1=tombstone)
        set.add(ptrToValue(memory, entry[1], schemas))
      }
    }
    return set
  }

  // Type 8 = MAP: hash table with capacity/size at offset-16/-8
  if (type === 8) {
    const capView = new Float64Array(memory.buffer, offset - 16, 1)
    const cap = Math.floor(capView[0])
    const obj = {}
    // Entry stride = 24 bytes (hash:f64, key:f64, value:f64)
    for (let i = 0; i < cap; i++) {
      const entryOff = offset + i * 24
      const entry = new Float64Array(memory.buffer, entryOff, 3)
      const hash = entry[0]
      if (hash !== 0 && hash !== 1) { // occupied (0=empty, 1=tombstone)
        const key = ptrToValue(memory, entry[1], schemas)
        const value = ptrToValue(memory, entry[2], schemas)
        obj[key] = value
      }
    }
    return obj
  }

  // Unknown type, try to read as f64 array with id as length
  const view = new Float64Array(memory.buffer, offset, id)
  // Don't use Array.from - it canonicalizes NaN values
  const result = []
  for (let i = 0; i < id; i++) {
    result.push(ptrToValue(memory, view[i], schemas))
  }
  return result
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
    const ptr = exports._alloc(5, arr.length) // type 5 = OBJECT
    const { offset } = decodePtr(ptr)
    const view = new Float64Array(exports._memory.buffer, offset, arr.length)
    view.set(arr)
    // Re-encode with schemaId
    if (schemaId > 0) {
      return encodePtr(5, schemaId, offset)
    }
    return ptr
  }

  // Handle arrays
  if (!Array.isArray(val)) return val // not an array/object, pass through
  const ptr = exports._alloc(1, val.length) // type 1 = ARRAY
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
  const { arrayParams = [] } = sig || {}

  return function (...args) {
    // Convert array/object args to pointers
    const convertedArgs = args.map((arg, i) => {
      if (arrayParams.includes(i)) {
        return valueToPtr(exports, arg, schemas)
      }
      return arg
    })

    const result = rawFn.apply(null, convertedArgs)

    // Convert pointer result to JS value (array, object, or string)
    if (isPtr(result)) {
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
        // Always wrap functions to handle pointer returns
        wrapped[name] = wrapExport(rawExports, name, {}, schemas)
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

// Compile JS to WAT
export function compile(code) {
  const ast = normalize(parse(code))
  // Emit normalize warnings
  for (const w of getWarnings()) {
    console.warn(`jz: [${w.code}] ${w.msg}`)
  }
  return compileAst(ast)
}

export { parse, normalize, compileAst, assemble }
