// jz - JS subset to WAT compiler
import 'subscript/jessie'
import { parse } from 'subscript/jessie'
import normalize, { getWarnings } from './src/normalize.js'
import { compile as compileAst, assemble } from './src/compile.js'

// NaN-boxing pointer encoding
// Format: 0x7FF8_xxxx_xxxx_xxxx (quiet NaN + 51-bit payload)
// Payload: [type:3][aux:16][offset:32]
// Types: ATOM=0, ARRAY=1, TYPED=2, STRING=3, OBJECT=4, CLOSURE=5, REGEX=6
// Subtypes in aux: OBJECT kind (SCHEMA=0, HASH=1, SET=2, MAP=3), ARRAY ring=0x8000
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

// Decode NaN-boxed pointer to { type, aux, offset }
// New format: [type:3][aux:16][offset:32]
const decodePtr = (ptr) => {
  f64View[0] = ptr
  const bits = u64View[0]
  return {
    type: Number((bits >> 48n) & 0x7n),
    aux: Number((bits >> 32n) & 0xFFFFn),
    offset: Number(bits & 0xFFFFFFFFn),
    // Legacy aliases for backward compat
    get id() { return this.aux }
  }
}

// Encode { type, aux, offset } to NaN-boxed pointer
// New format: [type:3][aux:16][offset:32]
const encodePtr = (type, aux, offset) => {
  u64View[0] = NAN_BOX_MASK |
    (BigInt(type) << 48n) |
    (BigInt(aux) << 32n) |
    BigInt(offset >>> 0)
  return f64View[0]
}

/**
 * Create zero-copy Float64Array view into WASM memory from a pointer.
 * For ARRAY type (1): reads len from memory header at offset-8
 * For other types: uses id field as length
 * @param {WebAssembly.Memory} memory - WASM memory instance
 * @param {number} ptr - NaN-boxed pointer
 * @returns {Float64Array} view into memory, or null if not a pointer
 */
function f64view(memory, ptr) {
  if (!isPtr(ptr)) return null
  const { type, id, offset } = decodePtr(ptr)
  if (type === 1) { // ARRAY: len at offset-8
    const lenView = new Float64Array(memory.buffer, offset - 8, 1)
    const len = Math.floor(lenView[0])
    return new Float64Array(memory.buffer, offset, len)
  }
  // Other types: id = length
  return new Float64Array(memory.buffer, offset, id)
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
  const { type, aux, offset } = decodePtr(ptr)

  // Type 0 = ATOM: null/undefined/Symbol (no memory)
  if (type === 0) {
    if (aux === 0) return null        // ATOM_KIND.NULL
    if (aux === 1) return undefined   // ATOM_KIND.UNDEF
    // aux === 2 = Symbol with id in offset
    if (aux === 2) return Symbol.for(`jz:${offset}`)  // Use Symbol.for for interop
    return null
  }

  // Type 3 = STRING
  if (type === 3) {
    // Check SSO bit (aux & 0x8000)
    if (aux & 0x8000) {
      // SSO: unpack from aux+offset
      // Pack format: data = [len:3][char0:7][char1:7]...[char5:7]
      // aux = 0x8000 | (data >> 32) & 0x7FFF, offset = data & 0xFFFFFFFF
      const ssoData = (BigInt(aux & 0x7FFF) << 32n) | BigInt(offset >>> 0)
      const len = Number(ssoData & 7n)  // bits 0-2
      let str = ''
      for (let i = 0; i < len; i++) {
        const charCode = Number((ssoData >> BigInt(3 + i * 7)) & 0x7Fn)
        str += String.fromCharCode(charCode)
      }
      return str
    }
    // Heap string: length at offset-8 as i32
    const lenView = new Int32Array(memory.buffer, offset - 8, 1)
    const len = lenView[0]
    const view = new Uint16Array(memory.buffer, offset, len)
    return String.fromCharCode(...view)
  }

  // Type 4 = OBJECT: aux contains kind:2 + schemaId:14
  // kind=0: schema object, kind=1: hash, kind=2: set, kind=3: map
  if (type === 4) {
    const kind = (aux >> 14) & 0x3
    const schemaId = aux & 0x3FFF

    // kind=0: Schema object
    if (kind === 0 && schemas && schemas[schemaId]) {
      const keys = schemas[schemaId]
      const view = new Float64Array(memory.buffer, offset, keys.length)
      const obj = {}
      for (let i = 0; i < keys.length; i++) {
        obj[keys[i]] = ptrToValue(memory, view[i], schemas)
      }
      return obj
    }

    // kind=2: Set
    if (kind === 2) {
      const capView = new Float64Array(memory.buffer, offset - 16, 1)
      const cap = Math.floor(capView[0])
      const set = new Set()
      for (let i = 0; i < cap; i++) {
        const entryOff = offset + i * 16
        const entry = new Float64Array(memory.buffer, entryOff, 2)
        const hash = entry[0]
        if (hash !== 0 && hash !== 1) {
          set.add(ptrToValue(memory, entry[1], schemas))
        }
      }
      return set
    }

    // kind=3: Map
    if (kind === 3) {
      const capView = new Float64Array(memory.buffer, offset - 16, 1)
      const cap = Math.floor(capView[0])
      const map = new Map()
      for (let i = 0; i < cap; i++) {
        const entryOff = offset + i * 24
        const entry = new Float64Array(memory.buffer, entryOff, 3)
        const hash = entry[0]
        if (hash !== 0 && hash !== 1) {
          const key = ptrToValue(memory, entry[1], schemas)
          map.set(key, ptrToValue(memory, entry[2], schemas))
        }
      }
      return map
    }

    // kind=1: Hash object (dynamic)
    if (kind === 1) {
      const capView = new Float64Array(memory.buffer, offset - 16, 1)
      const cap = Math.floor(capView[0])
      const obj = {}
      for (let i = 0; i < cap; i++) {
        const entryOff = offset + i * 24
        const entry = new Float64Array(memory.buffer, entryOff, 3)
        const hash = entry[0]
        if (hash !== 0 && hash !== 1) {
          const key = ptrToValue(memory, entry[1], schemas)
          obj[key] = ptrToValue(memory, entry[2], schemas)
        }
      }
      return obj
    }

    // Fallback for unknown object kind
    return {}
  }

  // Type 1 = ARRAY: length at offset-8 as f64
  if (type === 1) {
    const lenView = new Float64Array(memory.buffer, offset - 8, 1)
    const len = Math.floor(lenView[0])
    const view = new Float64Array(memory.buffer, offset, len)
    const result = []
    for (let i = 0; i < len; i++) {
      result.push(ptrToValue(memory, view[i], schemas))
    }
    return result
  }

  // Type 2 = TYPED: view model with header at offset [len:i32, dataPtr:i32]
  if (type === 2) {
    const elemType = (aux >> 13) & 0x7
    const header = new Int32Array(memory.buffer, offset, 2)
    const len = header[0]
    const dataPtr = header[1]
    // Return as appropriate typed array based on elemType
    const constructors = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]
    const ArrayType = constructors[elemType] || Float64Array
    return new ArrayType(memory.buffer, dataPtr, len)
  }

  // Unknown type, return as-is
  return ptr
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
    const ptr = exports._alloc(4, arr.length) // type 4 = OBJECT
    const { offset } = decodePtr(ptr)
    const view = new Float64Array(exports._memory.buffer, offset, arr.length)
    view.set(arr)
    // Re-encode with kind=0 (schema) and schemaId in aux (kind:2 + schema:14)
    if (schemaId > 0) {
      const aux = (0 << 14) | (schemaId & 0x3FFF)  // kind=0 (schema), schemaId in lower 14 bits
      return encodePtr(4, aux, offset)
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

export { parse, normalize, compileAst, assemble, f64view, isPtr, decodePtr, encodePtr }
