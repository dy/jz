/**
 * jz - JS subset → WASM compiler.
 *
 * Pipeline: parse(subscript) → prepare(AST) → compile(AST) → watr → binary
 * State: shared ctx object (src/ctx.js), reset per call
 * Extension: modules register emitters on ctx.emit (see module/)
 *
 * @module jz
 */

import { parse } from 'subscript/jessie'
import { compile as watrCompile, print as watrPrint } from 'watr'
import { ctx } from './src/ctx.js'
import prepare, { GLOBALS } from './src/prepare.js'
import compile, { emitter } from './src/compile.js'

/**
 * Compile JS code to WASM binary (or WAT text).
 * @param {string} code - JavaScript source code
 * @param {object} [opts]
 * @param {boolean} [opts.wat] - Return WAT text instead of binary
 * @returns {Uint8Array|string} WASM binary or WAT text if opts.wat
 * @example
 * const wasm = jz('export let add = (a, b) => a + b')
 * const { add } = (await WebAssembly.instantiate(wasm)).instance.exports
 */
// NaN-boxing: encode/decode pointer bits
const _buf = new ArrayBuffer(8), _u32 = new Uint32Array(_buf), _f64 = new Float64Array(_buf)
jz.ptr = (type, aux, offset) => {
  _u32[1] = (0x7FF80000 | ((type & 0xF) << 15) | (aux & 0x7FFF)) >>> 0
  _u32[0] = offset >>> 0; return _f64[0]
}
jz.offset = (ptr) => { _f64[0] = ptr; return _u32[0] }
jz.type = (ptr) => { _f64[0] = ptr; return (_u32[1] >>> 15) & 0xF }
jz.aux = (ptr) => { _f64[0] = ptr; return _u32[1] & 0x7FFF }

// Typed element metadata: [elemId, byteStride, DataView getter, DataView setter]
const ELEMS = {
  Int8Array: [0, 1, 'getInt8', 'setInt8'],
  Uint8Array: [1, 1, 'getUint8', 'setUint8'],
  Int16Array: [2, 2, 'getInt16', 'setInt16'],
  Uint16Array: [3, 2, 'getUint16', 'setUint16'],
  Int32Array: [4, 4, 'getInt32', 'setInt32'],
  Uint32Array: [5, 4, 'getUint32', 'setUint32'],
  Float32Array: [6, 4, 'getFloat32', 'setFloat32'],
  Float64Array: [7, 8, 'getFloat64', 'setFloat64'],
}

/**
 * Bind to WASM instance. Accepts WebAssembly.instantiate() result or plain exports.
 * @param {{module, instance}|WebAssembly.Instance|object} src
 */
jz.mem = (src) => {
  const exports = src?.instance?.exports || src?.exports || src
  const dv = () => new DataView(exports.memory.buffer)
  const alloc = exports._alloc

  // Read schemas from jz:schema custom section
  let schemas = []
  if (src?.module) {
    const secs = WebAssembly.Module.customSections(src.module, 'jz:schema')
    if (secs.length) schemas = JSON.parse(new TextDecoder().decode(secs[0]))
  }

  // Write header (len + cap), return data offset
  const hdr = (len, cap, bytes) => {
    const raw = alloc(8 + bytes)
    const m = dv()
    m.setInt32(raw, len, true)
    m.setInt32(raw + 4, cap, true)
    return raw + 8
  }

  const mem = {
    // Array: [-8:len][-4:cap][f64 elems...]
    Array(data) {
      const n = data.length, off = hdr(n, n, n * 8), m = dv()
      for (let i = 0; i < n; i++) m.setFloat64(off + i * 8, data[i], true)
      return jz.ptr(1, 0, off)
    },

    // String: [-4:len][u8 chars...] or SSO (≤4 ASCII)
    String(str) {
      if (str.length <= 4 && /^[\x00-\x7f]*$/.test(str)) {
        let packed = 0
        for (let i = 0; i < str.length; i++) packed |= str.charCodeAt(i) << (i * 8)
        return jz.ptr(5, str.length, packed)  // SSO
      }
      const enc = new TextEncoder().encode(str)
      const n = enc.length, raw = alloc(4 + n), m = dv()
      m.setInt32(raw, n, true)
      const off = raw + 4
      enc.forEach((b, i) => m.setUint8(off + i, b))
      return jz.ptr(4, 0, off)
    },

    // Object: [prop0:f64, prop1:f64, ...] — schema looked up by key set
    Object(obj) {
      const objKeys = Object.keys(obj)
      const sid = schemas.findIndex(s => s.length === objKeys.length && objKeys.every(k => s.includes(k)))
      if (sid === -1) throw Error(`No schema for {${objKeys.join(',')}}`)
      const schema = schemas[sid], n = schema.length, raw = alloc(n * 8), m = dv()
      for (let i = 0; i < n; i++) m.setFloat64(raw + i * 8, obj[schema[i]] ?? 0, true)
      return jz.ptr(6, sid, raw)
    },

    // Read: auto-dispatch by pointer type → JS value
    read(ptr) {
      if (ptr === ptr) return ptr  // regular number passthrough (NaN fails ===)
      const type = jz.type(ptr), off = jz.offset(ptr)
      if (type === 1) {  // ARRAY
        const m = dv(), len = m.getInt32(off - 8, true), out = new Array(len)
        for (let i = 0; i < len; i++) out[i] = this.read(m.getFloat64(off + i * 8, true))
        return out
      }
      if (type === 3) {  // TYPED
        const m = dv(), elem = jz.aux(ptr), len = m.getInt32(off - 8, true)
        const [, stride, getter] = Object.values(ELEMS)[elem]
        const out = new Array(len)
        for (let i = 0; i < len; i++) out[i] = m[getter](off + i * stride, true)
        return out
      }
      if (type === 4) {  // STRING (heap)
        const len = dv().getInt32(off - 4, true)
        return new TextDecoder().decode(new Uint8Array(exports.memory.buffer, off, len))
      }
      if (type === 5) {  // STRING_SSO
        const len = jz.aux(ptr); let s = ''
        for (let i = 0; i < len; i++) s += String.fromCharCode((off >>> (i * 8)) & 0xFF)
        return s
      }
      if (type === 6) {  // OBJECT
        const m = dv(), sid = jz.aux(ptr), keys = schemas[sid]
        if (!keys) return ptr
        const obj = {}
        for (let i = 0; i < keys.length; i++) obj[keys[i]] = this.read(m.getFloat64(off + i * 8, true))
        return obj
      }
      if (type === 8) {  // SET
        const m = dv(), size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true)
        const set = new Set()
        for (let i = 0; i < cap && set.size < size; i++) {
          const hash = m.getFloat64(off + i * 16, true)
          if (hash !== 0) set.add(this.read(m.getFloat64(off + i * 16 + 8, true)))
        }
        return set
      }
      if (type === 9) {  // MAP
        const m = dv(), size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true)
        const map = new Map()
        for (let i = 0; i < cap && map.size < size; i++) {
          const hash = m.getFloat64(off + i * 24, true)
          if (hash !== 0) map.set(this.read(m.getFloat64(off + i * 24 + 8, true)), this.read(m.getFloat64(off + i * 24 + 16, true)))
        }
        return map
      }
      if (type === 10) return ptr  // CLOSURE — opaque handle, pass back to WASM
      return ptr
    },

    // Write: update data into existing pointer (no alloc)
    write(ptr, data) {
      const type = jz.type(ptr), off = jz.offset(ptr), m = dv()
      if (type === 1) {
        const cap = m.getInt32(off - 4, true)
        if (data.length > cap) throw Error(`write: ${data.length} exceeds capacity ${cap}`)
        m.setInt32(off - 8, data.length, true)
        for (let i = 0; i < data.length; i++) m.setFloat64(off + i * 8, data[i], true)
      } else if (type === 3) {
        const elem = jz.aux(ptr), cap = m.getInt32(off - 4, true)
        const [, stride, , setter] = Object.values(ELEMS)[elem]
        if (data.length > cap) throw Error(`write: ${data.length} exceeds capacity ${cap}`)
        m.setInt32(off - 8, data.length, true)
        for (let i = 0; i < data.length; i++) m[setter](off + i * stride, data[i], true)
      } else if (type === 6) {
        const schema = schemas[jz.aux(ptr)]
        if (!schema) throw Error(`write: unknown schema`)
        for (const key of Object.keys(data)) {
          const i = schema.indexOf(key)
          if (i >= 0) m.setFloat64(off + i * 8, data[key] ?? 0, true)
        }
      } else {
        throw Error(`write: unsupported type ${type}`)
      }
    },

    schemas,
    alloc: exports._alloc,
    reset: exports._reset,
  }

  // TypedArray constructors: m.Float64Array(data), m.Int32Array(data), etc.
  for (const [name, [elemId, stride, , setter]] of Object.entries(ELEMS)) {
    mem[name] = (data) => {
      const n = data.length, off = hdr(n, n, n * stride), m = dv()
      for (let i = 0; i < n; i++) m[setter](off + i * stride, data[i], true)
      return jz.ptr(3, elemId, off)
    }
  }

  return mem
}

export default function jz(code, opts = {}) {
  ctx.emit = Object.create(emitter)
  ctx.stdlib = {}
  ctx.includes = new Set()
  ctx.imports = []
  ctx.scope = Object.create(GLOBALS)
  ctx.modules = {}
  ctx.exports = {}
  ctx.funcs = []
  ctx.globals = []
  ctx.schema = { list: [], vars: new Map(), register: null, find: null }
  ctx.fn = { types: null, table: null, bodies: null, make: null, call: null }

  const ast = prepare(parse(code))
  const module = compile(ast)

  return opts.wat ? watrPrint(module) : watrCompile(module)
}
