/**
 * Interop runtime — JS ↔ WASM value marshaling.
 *
 * NaN-boxing encoder/decoder, bump allocation, schema transport, host-object
 * handling. This is the *package* runtime that runs after compilation — it is
 * kept separate from the *compiler core* (index.js jz.compile) so the minimal
 * "pure scalar" story remains clean.
 *
 * Exports:
 *   UNDEF_NAN, NULL_NAN, coerce          — null/undefined sentinels
 *   ptr / offset / type / aux             — NaN-boxed pointer codec
 *   memory(src)                           — enhance a WebAssembly.Memory
 *   wrap(memSrc, inst?)                   — adapt WASM exports to JS calling convention
 *   instantiate(compile, code, opts?)     — compile + instantiate + wrap
 *
 * @module runtime
 */

import { wasi } from '../wasi.js'

// NaN-boxing encode/decode — shared 8-byte scratch buffer
const _buf = new ArrayBuffer(8), _u32 = new Uint32Array(_buf), _f64 = new Float64Array(_buf)
// Sentinel NaN for "undefined/missing arg" (payload=1, distinct from JS NaN payload=0)
_u32[1] = 0x7FF80000; _u32[0] = 1; export const UNDEF_NAN = _f64[0]
// Null NaN: type=0 (ATOM), aux=1, offset=0 — distinct from 0, NaN, and UNDEF_NAN
_u32[1] = 0x7FF80001; _u32[0] = 0; export const NULL_NAN = _f64[0]

// Coerce JS null/undefined → NaN-boxed sentinels for WASM boundary
export const coerce = v => v === null ? NULL_NAN : v === undefined ? UNDEF_NAN : v

// Decode f64 return value: null/undefined sentinels → JS values, numbers pass through
const decode = v => {
  if (v === v) return v  // fast path: non-NaN
  _f64[0] = v
  if (_u32[1] === 0x7FF80001 && _u32[0] === 0) return null
  if (_u32[1] === 0x7FF80000 && _u32[0] === 1) return undefined
  return v
}

export const ptr = (type, aux, offset) => {
  _u32[1] = (0x7FF80000 | ((type & 0xF) << 15) | (aux & 0x7FFF)) >>> 0
  _u32[0] = offset >>> 0; return _f64[0]
}
export const offset = (p) => { _f64[0] = p; return _u32[0] }
export const type = (p) => { _f64[0] = p; return (_u32[1] >>> 15) & 0xF }
export const aux = (p) => { _f64[0] = p; return _u32[1] & 0x7FFF }

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

const _enhanced = new WeakSet()

/**
 * Enhance WebAssembly.Memory with jz read/write methods (monkey-patch).
 * - memory() → create new Memory, patch, return
 * - memory({ initial: N }) → create with options, patch, return
 * - memory(wasmMemory) → patch existing, return same object
 * - memory(instanceResult) → bind to instance (patch its memory, bind alloc/schemas/extMap)
 */
export const memory = (src) => {
  // Already enhanced — return as-is (idempotent)
  if (src instanceof WebAssembly.Memory && _enhanced.has(src)) return src

  // Create new Memory from nothing or options
  if (!src || (typeof src === 'object' && !(src instanceof WebAssembly.Memory) && !src.instance && !src.exports && !src.memory)) {
    const mem = new WebAssembly.Memory({ initial: src?.initial || 1, ...(src?.maximum ? { maximum: src.maximum } : {}), ...(src?.shared ? { shared: src.shared } : {}) })
    return memory(mem)
  }

  // Resolve the WebAssembly.Memory object
  let mem, wasmExports, extMap, mod
  if (src instanceof WebAssembly.Memory) {
    mem = src
    wasmExports = null
    extMap = null
    mod = null
  } else {
    // Instance result: { module, instance, exports, extMap }
    const raw = src?.instance?.exports || src?.exports || src
    mem = src?.exports?.memory || raw.memory
    if (!mem) return null  // pure scalar module — no memory
    wasmExports = { ...raw, memory: mem }
    extMap = src.extMap || null
    mod = src.module || null
  }

  const dv = () => new DataView(mem.buffer)

  // JS-side bump allocator (heap ptr at byte 1020, same convention as WASM)
  const jsAlloc = (bytes) => {
    const d = dv(), p = d.getInt32(1020, true)
    const aligned = (p + 7) & ~7  // 8-byte align
    const next = aligned + bytes
    if (next > mem.buffer.byteLength) mem.grow(Math.ceil((next - mem.buffer.byteLength) / 65536))
    d.setInt32(1020, next, true)
    return aligned
  }

  // Use WASM allocator if available, else JS-side bump
  let alloc = wasmExports?._alloc || jsAlloc

  // Initialize heap pointer if not yet set
  const initDv = dv()
  if (initDv.getInt32(1020, true) < 1024) initDv.setInt32(1020, 1024, true)

  // Write header (len + cap), return data offset
  const hdr = (len, cap, bytes) => {
    const raw = alloc(8 + bytes)
    const m = dv()
    m.setInt32(raw, len, true)
    m.setInt32(raw + 4, cap, true)
    return raw + 8
  }

  // Read schemas from module custom section, merge into memory.schemas
  let schemas = mem.schemas || []
  if (mod) {
    const secs = WebAssembly.Module.customSections(mod, 'jz:schema')
    if (secs.length) {
      const b = new Uint8Array(secs[0]), td = new TextDecoder()
      let i = 0
      const varint = () => { let r = 0, s = 0; while (1) { const x = b[i++]; r |= (x & 0x7F) << s; if (!(x & 0x80)) return r; s += 7 } }
      const dec = () => {
        const t = b[i++]
        if (t === 0) return null
        if (t === 1) return [null, dec()]
        const n = varint(), s = td.decode(b.subarray(i, i + n)); i += n; return s
      }
      const nS = varint(), newSchemas = []
      for (let j = 0; j < nS; j++) { const k = varint(), props = []; for (let p = 0; p < k; p++) props.push(dec()); newSchemas.push(props) }
      for (const s of newSchemas) {
        const key = s.join(',')
        if (!schemas.some(existing => existing.join(',') === key)) schemas.push(s)
      }
    }
  }

  // If already enhanced, just update bindings (new module compiled into same memory)
  if (_enhanced.has(mem)) {
    mem.schemas = schemas
    if (wasmExports?._alloc) { alloc = wasmExports._alloc; mem.alloc = alloc }
    if (wasmExports?._reset) mem.reset = wasmExports._reset
    if (extMap) mem._extMap = extMap
    return mem
  }

  // Patch methods onto the Memory instance
  mem.schemas = schemas
  mem._extMap = extMap

  mem.Array = (data) => {
    const n = data.length, off = hdr(n, n, n * 8), m = dv()
    for (let i = 0; i < n; i++) m.setFloat64(off + i * 8, mem.wrapVal(data[i]), true)
    return ptr(1, 0, off)
  }

  mem.String = (str) => {
    if (str.length <= 4 && /^[\x00-\x7f]*$/.test(str)) {
      let packed = 0
      for (let i = 0; i < str.length; i++) packed |= str.charCodeAt(i) << (i * 8)
      return ptr(5, str.length, packed)  // SSO
    }
    const enc = new TextEncoder().encode(str)
    const n = enc.length, raw = alloc(4 + n), m = dv()
    m.setInt32(raw, n, true)
    const off = raw + 4
    enc.forEach((b, i) => m.setUint8(off + i, b))
    return ptr(4, 0, off)
  }

  mem.Buffer = (data) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
    const n = bytes.length, off = hdr(n, n, n), m = new Uint8Array(mem.buffer)
    m.set(bytes, off)
    return ptr(2, 0, off)
  }

  mem.wrapVal = function(v) {
    if (v === null || v === undefined) return coerce(v)
    if (typeof v === 'number' || typeof v === 'boolean') return Number(v)
    if (typeof v === 'string') return this.String(v)
    if (Array.isArray(v)) return this.Array(v)
    if (v instanceof ArrayBuffer) return this.Buffer(v)
    if (v instanceof DataView) return this.Buffer(v.buffer)
    const typedName = v?.constructor?.name
    if (typedName && ELEMS[typedName]) return this[typedName](v)
    if (typeof v === 'object' || typeof v === 'function') return this.External(v)
    return UNDEF_NAN
  }

  mem.External = function(obj) {
    if (obj === null || obj === undefined) return coerce(obj)
    const map = this._extMap
    if (!map) return UNDEF_NAN
    let id = map.indexOf(obj)
    if (id === -1) { id = map.length; map.push(obj) }
    return ptr(11, 0, id)
  }

  mem.Object = function(obj) {
    const objKeys = Object.keys(obj)
    const key = objKeys.join(',')
    const schemas = this.schemas
    let sid = schemas.findIndex(s => s.join(',') === key)
    if (sid === -1) {
      const matches = schemas.reduce((a, s, i) =>
        (s.length === objKeys.length && objKeys.every(k => s.includes(k)) ? a.concat(i) : a), [])
      if (matches.length === 1) sid = matches[0]
      else if (matches.length > 1) throw Error(`Ambiguous schema for {${key}} — pass keys in schema order`)
      else if (this._extMap) return this.External(obj)
      else throw Error(`No schema for {${key}}`)
    }
    const schema = schemas[sid], n = schema.length, raw = alloc(n * 8), m = dv()
    for (let i = 0; i < n; i++) {
      let v = obj[schema[i]]
      if (v === null || v === undefined) v = coerce(v)
      else if (typeof v === 'string') v = this.String(v)
      else if (Array.isArray(v)) v = this.Array(v)
      m.setFloat64(raw + i * 8, v, true)
    }
    return ptr(6, sid, raw)
  }

  mem.read = function(p) {
    if (Array.isArray(p)) return p.map(v => this.read(v))  // multi-value tuple
    if (p === p) return p  // regular number passthrough (NaN fails ===)
    const t = type(p), a = aux(p), off = offset(p)
    if (t === 0 && a === 1 && off === 0) return null
    if (t === 0 && a === 0 && off === 1) return undefined
    if (t === 11 && this._extMap) return this._extMap[off]
    if (t === 1) {  // ARRAY
      let m = dv(), aOff = off
      // Follow forwarding pointers (cap === -1 means array was reallocated)
      while (m.getInt32(aOff - 4, true) === -1) aOff = m.getInt32(aOff - 8, true)
      const len = m.getInt32(aOff - 8, true), out = new Array(len)
      for (let i = 0; i < len; i++) out[i] = this.read(m.getFloat64(aOff + i * 8, true))
      return out
    }
    if (t === 3) {  // TYPED
      const a2 = aux(p), elem = a2 & 7
      const [, stride] = ELEM_BY_ID[elem]
      const Ctor = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array][elem]
      const m = dv()
      if (a2 & 8) {
        const byteLen = m.getInt32(off, true), dataOff = m.getInt32(off + 4, true)
        return new Ctor(mem.buffer, dataOff, byteLen / stride)
      }
      const byteLen = m.getInt32(off - 8, true)
      return new Ctor(mem.buffer, off, byteLen / stride)
    }
    if (t === 2) {  // BUFFER
      const byteLen = dv().getInt32(off - 8, true)
      const out = new ArrayBuffer(byteLen)
      new Uint8Array(out).set(new Uint8Array(mem.buffer, off, byteLen))
      return out
    }
    if (t === 4) {  // STRING (heap)
      const len = dv().getInt32(off - 4, true)
      return new TextDecoder().decode(new Uint8Array(mem.buffer, off, len))
    }
    if (t === 5) {  // STRING_SSO
      const len = aux(p); let s = ''
      for (let i = 0; i < len; i++) s += String.fromCharCode((off >>> (i * 8)) & 0xFF)
      return s
    }
    if (t === 6) {  // OBJECT
      const m = dv(), sid = aux(p), keys = this.schemas[sid]
      if (!keys) return p
      const obj = {}
      for (let i = 0; i < keys.length; i++) obj[keys[i]] = this.read(m.getFloat64(off + i * 8, true))
      return obj
    }
    if (t === 7) {  // HASH
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
    if (t === 8) {  // SET
      const m = dv(), size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true)
      const set = new Set()
      for (let i = 0; i < cap && set.size < size; i++) {
        const hash = m.getFloat64(off + i * 16, true)
        if (hash !== 0) set.add(this.read(m.getFloat64(off + i * 16 + 8, true)))
      }
      return set
    }
    if (t === 9) {  // MAP
      const m = dv(), size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true)
      const map = new Map()
      for (let i = 0; i < cap && map.size < size; i++) {
        const hash = m.getFloat64(off + i * 24, true)
        if (hash !== 0) map.set(this.read(m.getFloat64(off + i * 24 + 8, true)), this.read(m.getFloat64(off + i * 24 + 16, true)))
      }
      return map
    }
    if (t === 10) return p  // CLOSURE
    return p
  }

  mem.write = function(p, data) {
    const t = type(p), off = offset(p), m = dv()
    if (t === 1) {
      const cap = m.getInt32(off - 4, true)
      if (data.length > cap) throw Error(`write: ${data.length} exceeds capacity ${cap}`)
      m.setInt32(off - 8, data.length, true)
      for (let i = 0; i < data.length; i++) m.setFloat64(off + i * 8, coerce(data[i]), true)
    } else if (t === 3) {
      const a2 = aux(p), elem = a2 & 7
      const [, stride, , setter] = ELEM_BY_ID[elem]
      const byteLen = data.length * stride
      if (a2 & 8) {
        const viewByteLen = m.getInt32(off, true), dataOff = m.getInt32(off + 4, true)
        if (byteLen > viewByteLen) throw Error(`write: ${byteLen} bytes exceeds view size ${viewByteLen}`)
        for (let i = 0; i < data.length; i++) m[setter](dataOff + i * stride, data[i], true)
      } else {
        const byteCap = m.getInt32(off - 4, true)
        if (byteLen > byteCap) throw Error(`write: ${byteLen} bytes exceeds capacity ${byteCap}`)
        m.setInt32(off - 8, byteLen, true)
        for (let i = 0; i < data.length; i++) m[setter](off + i * stride, data[i], true)
      }
    } else if (t === 6) {
      const schema = this.schemas[aux(p)]
      if (!schema) throw Error(`write: unknown schema`)
      for (const k of Object.keys(data)) {
        const i = schema.indexOf(k)
        if (i >= 0) m.setFloat64(off + i * 8, coerce(data[k]), true)
      }
    } else {
      throw Error(`write: unsupported type ${t}`)
    }
  }

  mem.alloc = alloc
  mem.reset = wasmExports?._reset || null

  // TypedArray constructors: memory.Float64Array(data), etc.
  for (const [name, [elemId, stride, , setter]] of Object.entries(ELEMS)) {
    mem[name] = (data) => {
      const n = data.length, bytes = n * stride, off = hdr(bytes, bytes, bytes), m = dv()
      for (let i = 0; i < n; i++) m[setter](off + i * stride, data[i], true)
      return ptr(3, elemId, off)
    }
  }

  _enhanced.add(mem)
  return mem
}

/**
 * Wrap raw WASM exports with JS calling convention adaptation.
 * Handles: undefined → sentinel NaN for defaults, rest-param array packing.
 */
export const wrap = (memSrc, inst) => {
  const restFuncs = new Map()
  const mod = inst ? memSrc : memSrc.module || memSrc
  const realInst = inst || memSrc.instance || memSrc
  const restSecs = WebAssembly.Module.customSections(mod, 'jz:rest')
  if (restSecs.length) {
    try {
      for (const entry of JSON.parse(new TextDecoder().decode(restSecs[0])))
        restFuncs.set(typeof entry === 'string' ? entry : entry.name, typeof entry === 'string' ? 0 : entry.fixed)
    } catch (e) { /* ignore */ }
  }

  const mem = memory(memSrc)
  const lastErrBits = realInst.exports.__jz_last_err_bits
  const decodeThrown = error => {
    if (!(error instanceof WebAssembly.Exception) || !lastErrBits) throw error
    const bits = lastErrBits.value
    _u32[0] = Number(bits & 0xffffffffn)
    _u32[1] = Number((bits >> 32n) & 0xffffffffn)
    const value = mem ? mem.read(_f64[0]) : _f64[0]
    if (value instanceof Error) throw value
    const wrapped = new Error(typeof value === 'string' ? value : String(value))
    wrapped.cause = error
    wrapped.thrown = value
    throw wrapped
  }
  const exports = {}
  // Pure scalar module (no memory): pass f64 values directly, no marshaling
  if (!mem) {
    for (const [name, fn] of Object.entries(realInst.exports))
      exports[name] = typeof fn === 'function'
        ? (...args) => { while (args.length < fn.length) args.push(undefined); try { return decode(fn(...args.map(coerce))) } catch (e) { decodeThrown(e) } }
        : fn
    return exports
  }
  for (const [name, fn] of Object.entries(realInst.exports)) {
    if (restFuncs.has(name) && typeof fn === 'function') {
      const fixed = restFuncs.get(name)
      exports[name] = (...args) => {
        const a = args.slice(0, fixed).map(x => mem.wrapVal(x))
        while (a.length < fixed) a.push(UNDEF_NAN)
        a.push(mem.Array(args.slice(fixed)))
        try {
          return mem.read(fn.apply(null, a))
        } catch (error) {
          decodeThrown(error)
        }
      }
    } else if (typeof fn === 'function') {
      exports[name] = (...args) => {
        while (args.length < fn.length) args.push(undefined)
        try {
          return mem.read(fn.apply(null, args.map(x => mem.wrapVal(x))))
        } catch (error) {
          decodeThrown(error)
        }
      }
    } else {
      exports[name] = fn
    }
  }
  return exports
}

/**
 * Compile, instantiate, and wrap exports (with WASI + rest-param support).
 * `compile` is the jz.compile function (injected to avoid importing the compiler core).
 */
export const instantiate = (compile, code, opts = {}) => {
  const extMap = [null]
  let mem = null
  opts._interp = opts._interp || {}
  opts._interp.__ext_prop = (objPtr, propPtr) => {
    const obj = extMap[offset(objPtr)]
    const prop = mem.read(propPtr)
    return mem.wrapVal(typeof obj[prop] === 'function' ? obj[prop].bind(obj) : obj[prop])
  }
  opts._interp.__ext_has = (objPtr, propPtr) => {
    return (mem.read(propPtr) in extMap[offset(objPtr)]) ? 1 : 0
  }
  opts._interp.__ext_set = (objPtr, propPtr, valPtr) => {
    extMap[offset(objPtr)][mem.read(propPtr)] = mem.read(valPtr)
    return 1
  }
  opts._interp.__ext_call = (objPtr, propPtr, argsPtr) => {
    const obj = extMap[offset(objPtr)]
    const prop = mem.read(propPtr)
    const args = mem.read(argsPtr)
    return mem.wrapVal(obj[prop].apply(obj, args))
  }

  const wasm = compile(code, opts)
  opts.extMap = extMap
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
  // Shared memory: normalize (auto-wrap raw Memory), pass as import
  if (opts.memory) {
    // Auto-wrap raw WebAssembly.Memory → enhanced jz.memory
    if (opts.memory instanceof WebAssembly.Memory && !_enhanced.has(opts.memory)) opts.memory = memory(opts.memory)
    if (!imports.env) imports.env = {}
    imports.env.memory = opts.memory instanceof WebAssembly.Memory ? opts.memory : opts.memory
  }
  // Auto-imported host globals: provide as WebAssembly.Global wrapping NaN-boxed external refs
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind === 'global' && imp.module === 'env') {
      const host = globalThis[imp.name]
      if (host !== undefined) {
        if (!imports.env) imports.env = {}
        let id = extMap.indexOf(host); if (id === -1) { id = extMap.length; extMap.push(host) }
        imports.env[imp.name] = new WebAssembly.Global({ value: 'f64', mutable: true }, ptr(11, 0, id))
      }
    }
  }
  const hasImports = Object.keys(imports).some(k => k !== '_setMemory')
  const inst = new WebAssembly.Instance(mod, hasImports ? imports : undefined)
  if (needsWasi) imports._setMemory(inst.exports.memory)

  // Drive WASM timer queue via JS scheduling (non-blocking)
  if (inst.exports.__timer_tick) {
    const tick = inst.exports.__timer_tick
    let hadTimers = false
    const id = setInterval(() => {
      const remaining = tick()
      if (remaining > 0) hadTimers = true
      if (hadTimers && remaining <= 0) clearInterval(id)
    }, 1)
  }

  // For shared memory, resolve memory from import; for own memory, from export
  const rawMemory = opts.memory || inst.exports.memory
  const memSrc = { module: mod, instance: inst, exports: { ...inst.exports, memory: rawMemory }, extMap }
  const enhanced = memory(memSrc)
  mem = enhanced
  return { exports: wrap(memSrc), memory: enhanced, instance: inst, module: mod }
}
