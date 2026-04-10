/**
 * jz - JS subset → WASM compiler.
 *
 * Pipeline: parse(subscript) → prepare(AST) → compile(AST) → watr → binary
 * State: shared ctx object (src/ctx.js), reset per call
 * Extension: modules register emitters on ctx.core.emit (see module/)
 *
 * @module jz
 */

import { parse } from 'subscript/jessie'
import { compile as watrCompile, print as watrPrint } from 'watr'
import { ctx, reset } from './src/ctx.js'
import prepare, { GLOBALS } from './src/prepare.js'
import compile, { emitter } from './src/compile.js'
import { wasi } from './wasi.js'
import jzify from './src/jzify.js'

/**
 * jz — JS subset → WASM compiler.
 *
 * jz('code') or jz`code` → { exports, mem, instance, module }
 * jz.compile('code') → Uint8Array (raw WASM binary)
 * jz.compile('code', { wat: true }) → string (WAT text)
 * jz.wrap(mod, inst) → wrapped exports (defaults, rest params)
 * jz.mem(inst) → memory bridge (read/write JS↔WASM values)
 *
 * @example
 * const { exports: { add } } = jz('export let add = (a, b) => a + b')
 * add(2, 3)  // 5
 */
// NaN-boxing: encode/decode pointer bits
const _buf = new ArrayBuffer(8), _u32 = new Uint32Array(_buf), _f64 = new Float64Array(_buf)
// Sentinel NaN for "undefined/missing arg" (payload=1, distinct from JS NaN payload=0)
_u32[1] = 0x7FF80000; _u32[0] = 1; const UNDEF_NAN = _f64[0]
// Null NaN: type=0 (ATOM), aux=1, offset=0 — distinct from 0, NaN, and UNDEF_NAN
_u32[1] = 0x7FF80001; _u32[0] = 0; const NULL_NAN = _f64[0]
// Coerce JS null/undefined → NaN-boxed sentinels for WASM boundary
const coerce = v => v === null ? NULL_NAN : v === undefined ? UNDEF_NAN : v
jz.UNDEF_NAN = UNDEF_NAN
jz.NULL_NAN = NULL_NAN
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
// Pre-built lookup by element ID (avoids Object.values on each access)
const ELEM_BY_ID = Object.values(ELEMS)

/**
 * Bind to WASM instance. Accepts WebAssembly.instantiate() result or plain exports.
 * @param {{module, instance}|WebAssembly.Instance|object} src
 */
jz.mem = (src) => {
  const raw = src?.instance?.exports || src?.exports || src
  const memory = src?.exports?.memory || raw.memory
  const exports = { ...raw, memory }
  const dv = () => new DataView(memory.buffer)
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

  // Coerce JS values for WASM memory: null → NULL_NAN, undefined → UNDEF_NAN
  const memCoerce = coerce

  const mem = {
    // Array: [-8:len][-4:cap][f64 elems...]
    Array(data) {
      const n = data.length, off = hdr(n, n, n * 8), m = dv()
      for (let i = 0; i < n; i++) m.setFloat64(off + i * 8, memCoerce(data[i]), true)
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

    // Object: [prop0:f64, prop1:f64, ...] — schema matched by key identity
    // Exact key-order match preferred; set-based fallback only if unambiguous
    Object(obj) {
      const objKeys = Object.keys(obj)
      const key = objKeys.join(',')
      let sid = schemas.findIndex(s => s.join(',') === key)
      if (sid === -1) {
        // Fallback: match by key set, require exactly one match
        const matches = schemas.reduce((a, s, i) =>
          (s.length === objKeys.length && objKeys.every(k => s.includes(k)) ? a.concat(i) : a), [])
        if (matches.length === 1) sid = matches[0]
        else if (matches.length > 1) throw Error(`Ambiguous schema for {${key}} — pass keys in schema order`)
        else throw Error(`No schema for {${key}}`)
      }
      const schema = schemas[sid], n = schema.length, raw = alloc(n * 8), m = dv()
      for (let i = 0; i < n; i++) {
        let v = obj[schema[i]]
        // Auto-wrap JS values to NaN-boxed pointers
        if (v === null || v === undefined) v = memCoerce(v)
        else if (typeof v === 'string') v = mem.String(v)
        else if (Array.isArray(v)) v = mem.Array(v)
        m.setFloat64(raw + i * 8, v, true)
      }
      return jz.ptr(6, sid, raw)
    },

    // Read: auto-dispatch by pointer type → JS value
    read(ptr) {
      if (ptr === ptr) return ptr  // regular number passthrough (NaN fails ===)
      const type = jz.type(ptr), aux = jz.aux(ptr), off = jz.offset(ptr)
      if (type === 0 && aux === 1 && off === 0) return null       // NULL_NAN → JS null
      if (type === 0 && aux === 0 && off === 1) return undefined  // UNDEF_NAN → JS undefined
      if (type === 1) {  // ARRAY
        const m = dv(), len = m.getInt32(off - 8, true), out = new Array(len)
        for (let i = 0; i < len; i++) out[i] = this.read(m.getFloat64(off + i * 8, true))
        return out
      }
      if (type === 3) {  // TYPED → return native JS typed array (zero-copy view)
        const elem = jz.aux(ptr), len = dv().getInt32(off - 8, true)
        const Ctor = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array][elem]
        return new Ctor(exports.memory.buffer, off, len)
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
      if (type === 7) {  // HASH (dynamic string-keyed object)
        const m = dv(), size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true)
        const obj = {}
        for (let i = 0, found = 0; i < cap && found < size; i++) {
          const hash = m.getFloat64(off + i * 24, true)
          if (hash !== 0) {
            const key = this.read(m.getFloat64(off + i * 24 + 8, true))
            obj[key] = this.read(m.getFloat64(off + i * 24 + 16, true))
            found++
          }
        }
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
        for (let i = 0; i < data.length; i++) m.setFloat64(off + i * 8, memCoerce(data[i]), true)
      } else if (type === 3) {
        const elem = jz.aux(ptr), cap = m.getInt32(off - 4, true)
        const [, stride, , setter] = ELEM_BY_ID[elem]
        if (data.length > cap) throw Error(`write: ${data.length} exceeds capacity ${cap}`)
        m.setInt32(off - 8, data.length, true)
        for (let i = 0; i < data.length; i++) m[setter](off + i * stride, data[i], true)
      } else if (type === 6) {
        const schema = schemas[jz.aux(ptr)]
        if (!schema) throw Error(`write: unknown schema`)
        for (const key of Object.keys(data)) {
          const i = schema.indexOf(key)
          if (i >= 0) m.setFloat64(off + i * 8, memCoerce(data[key]), true)
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

/**
 * Wrap raw WASM exports with JS calling convention adaptation.
 * Handles: undefined → sentinel NaN for defaults, rest-param array packing.
 * @param {WebAssembly.Module} mod
 * @param {WebAssembly.Instance} inst
 * @returns {object} Wrapped exports
 */
jz.wrap = (mod, inst) => {
  // Use shared coerce (null/undefined → NaN sentinels)
  const restFuncs = new Map()
  const restSecs = WebAssembly.Module.customSections(mod, 'jz:rest')
  if (restSecs.length) {
    try {
      for (const entry of JSON.parse(new TextDecoder().decode(restSecs[0])))
        restFuncs.set(typeof entry === 'string' ? entry : entry.name, typeof entry === 'string' ? 0 : entry.fixed)
    } catch (e) { /* ignore */ }
  }

  const mem = jz.mem({ module: mod, instance: inst })
  const exports = {}
  for (const [name, fn] of Object.entries(inst.exports)) {
    if (restFuncs.has(name) && typeof fn === 'function') {
      const fixed = restFuncs.get(name)
      exports[name] = (...args) => {
        const a = args.slice(0, fixed).map(coerce)
        while (a.length < fixed) a.push(UNDEF_NAN)
        a.push(mem.Array(args.slice(fixed)))
        return fn.apply(null, a)
      }
    } else if (typeof fn === 'function') {
      exports[name] = (...args) => {
        while (args.length < fn.length) args.push(undefined)
        return fn.apply(null, args.map(coerce))
      }
    } else {
      exports[name] = fn
    }
  }
  return exports
}

/**
 * Compile, instantiate, and wrap exports (with WASI + rest-param support).
 * @param {string} code - jz source
 * @param {object} [opts] - Options passed to wasi()
 * @returns {{exports, mem, instance, module}} Wrapped exports + memory helper
 */
jz.instantiate = (code, opts = {}) => {
  const wasm = jz.compile(code, opts)
  const mod = new WebAssembly.Module(wasm)
  const needsWasi = WebAssembly.Module.imports(mod).some(i => i.module === 'wasi_snapshot_preview1')
  const imports = needsWasi ? wasi(opts) : {}
  if (opts._interp) imports.env = { ...imports.env, ...opts._interp }
  // Host imports: provide actual functions at instantiation
  if (opts.imports) for (const [modName, fns] of Object.entries(opts.imports)) {
    if (!imports[modName]) imports[modName] = {}
    for (const [name, spec] of Object.entries(fns))
      if (typeof spec === 'function') imports[modName][name] = spec
  }
  // Shared memory: pass as import, initialize heap pointer if first module
  if (opts.memory) {
    if (!imports.env) imports.env = {}
    imports.env.memory = opts.memory
    // Initialize heap pointer at memory[1020] if not yet set
    const dv = new DataView(opts.memory.buffer)
    if (dv.getInt32(1020, true) < 1024) dv.setInt32(1020, 1024, true)
  }
  const hasImports = Object.keys(imports).some(k => k !== '_setMemory')
  const inst = new WebAssembly.Instance(mod, hasImports ? imports : undefined)
  if (needsWasi) imports._setMemory(inst.exports.memory)

  // For shared memory, resolve memory from import; for own memory, from export
  const memory = opts.memory || inst.exports.memory
  const memSrc = { module: mod, instance: inst, exports: { ...inst.exports, memory } }
  return { exports: jz.wrap(mod, inst), mem: jz.mem(memSrc), instance: inst, module: mod, memory }
}

/**
 * Compile jz source to WASM binary or WAT text. Low-level — no instantiation.
 * @param {string} code - jz source
 * @param {object} [opts]
 * @param {boolean} [opts.wat] - Return WAT text instead of binary
 * @returns {Uint8Array|string}
 */
jz.compile = (code, opts = {}) => {
  reset(emitter, GLOBALS)
  ctx.error.src = code

  if (opts.memory) ctx.memory.shared = true
  if (opts.memoryPages) ctx.memory.pages = opts.memoryPages
  if (opts.modules) ctx.module.importSources = opts.modules
  if (opts.imports) ctx.module.hostImports = opts.imports
  // pure: true → strict jz. pure: false → auto-jzify. unset → no transform (compat)
  const useJzify = opts.jzify || opts.pure === false
  if (useJzify) ctx.transform.jzify = jzify

  if (opts._interp) {
    for (const [name, fn] of Object.entries(opts._interp)) {
      const params = Array(fn.length).fill(['param', 'f64'])
      ctx.module.imports.push(['import', '"env"', `"${name}"`, ['func', `$${name}`, ...params, ['result', 'f64']]])
    }
  }

  // pure: true → strict jz (mandatory ;, no function/var/switch)
  // default → lenient (ASI: subscript handles `}` before keywords, jz handles `}\n[` ambiguity)
  if (!opts.pure) code = code.replace(/\}\s*\n(\s*)\[/g, '};\n$1[')
  const savedAsi = parse.asi
  if (opts.pure) parse.asi = null
  let parsed
  try { parsed = parse(code) } finally { parse.asi = savedAsi }
  if (useJzify) parsed = jzify(parsed)
  const ast = prepare(parsed)
  const module = compile(ast)

  return opts.wat ? watrPrint(module) : watrCompile(module)
}

/**
 * Compile, instantiate, and wrap. Works as both jz('code') and jz`code ${val}`.
 * @param {string|TemplateStringsArray} code
 * @param {...any} args - Interpolation values (template tag) or options (string call)
 * @returns {{exports, mem, instance, module}}
 */
export default function jz(code, ...args) {
  // Template tag: jz`code ${val}` — numbers, functions, strings, arrays, objects
  if (Array.isArray(code)) {
    const interp = {}, data = {}, hoisted = []
    let src = code[0]
    for (let i = 0; i < args.length; i++) {
      const v = args[i]
      if (typeof v === 'function') {
        const key = `$$${i}`; interp[key] = v; src += key
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        src += String(v)
      } else if (typeof v === 'string') {
        // String → imported getter (closure patched post-instantiation)
        const key = `$$${i}`, ref = { ptr: 0 }
        data[key] = { val: v, ref }; interp[key] = () => ref.ptr
        src += `${key}()`
      } else if (Array.isArray(v)) {
        // Array → imported getter
        const key = `$$${i}`, ref = { ptr: 0 }
        data[key] = { val: v, ref }; interp[key] = () => ref.ptr
        src += `${key}()`
      } else if (typeof v === 'object' && v !== null) {
        // Object → emit literal with property values as inline or getter imports
        const key = `$$${i}`
        let hasNonNumeric = false
        const props = Object.keys(v).map(k => {
          const val = v[k]
          if (typeof val === 'number') return `${k}: ${val}`
          if (typeof val === 'boolean') return `${k}: ${val ? 1 : 0}`
          hasNonNumeric = true
          const pk = `${key}_${k}`, ref = { ptr: 0 }
          data[pk] = { val, ref }; interp[pk] = () => ref.ptr
          return `${k}: ${pk}()`
        })
        const literal = `{${props.join(', ')}}`
        if (!hasNonNumeric) {
          // All numeric: hoist to module scope (safe at __start time)
          hoisted.push(`let ${key} = ${literal}`)
          src += key
        } else {
          // Has non-numeric: hoist dummy to register schema, use getter for real value
          const dummy = Object.keys(v).map(k => `${k}: 0`).join(', ')
          hoisted.push(`let ${key} = {${dummy}}`)
          const ref = { ptr: 0 }
          data[key] = { val: v, ref }; interp[key] = () => ref.ptr
          // Replace hoisted var with getter value at call time
          src += `${key}()`
        }
      } else {
        throw Error(`jz template: cannot interpolate ${typeof v}`)
      }
      src += code[i + 1]
    }
    if (hoisted.length) src = hoisted.join('; ') + '; ' + src
    const hasInterp = Object.keys(interp).length
    const result = jz.instantiate(src, { _interp: hasInterp ? interp : null })
    // Patch data getters: allocate values in WASM memory, update closure refs
    for (const [, { val, ref }] of Object.entries(data)) {
      if (typeof val === 'string') ref.ptr = result.mem.String(val)
      else if (Array.isArray(val)) ref.ptr = result.mem.Array(val)
      else ref.ptr = result.mem.Object(val)
    }
    return result
  }

  // String call: jz('code', opts?) — compile + instantiate + wrap
  return jz.instantiate(code, args[0] || {})
}

export { jz }
const jzCompile = jz.compile
export { jzCompile as compile }
