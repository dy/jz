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
// Cross-typed-array view for i64↔f64 reinterpretation. Used at every wasm↔JS
// boundary that carries a NaN-boxed pointer as i64 bits — V8 may canonicalize
// f64 NaN payloads at the boundary, so the carrier is BigInt and reinterpret
// runs once on each side. Separate buffer so it never aliases _u32/_f64.
const _bi64 = (() => {
  const ab = new ArrayBuffer(8), bi = new BigInt64Array(ab), fv = new Float64Array(ab)
  return {
    i64ToF64: (big) => { bi[0] = big; return fv[0] },
    f64ToI64: (f) => { fv[0] = f; return bi[0] },
  }
})()
export const i64ToF64 = _bi64.i64ToF64
export const f64ToI64 = _bi64.f64ToI64
// Reserved atoms (type=0, offset=0): aux=1 → null, aux=2 → undefined.
// Distinct from 0, JS NaN (payload=0), and all pointers.
_u32[1] = 0x7FF80001; _u32[0] = 0; export const NULL_NAN = _f64[0]
_u32[1] = 0x7FF80002; _u32[0] = 0; export const UNDEF_NAN = _f64[0]

// Coerce JS null/undefined → NaN-boxed sentinels for WASM boundary
export const coerce = v => v === null ? NULL_NAN : v === undefined ? UNDEF_NAN : v

// Decode f64 return value: null/undefined sentinels → JS values, numbers pass through
const decode = v => {
  if (v === v) return v  // fast path: non-NaN
  _f64[0] = v
  if (_u32[0] !== 0) return v
  if (_u32[1] === 0x7FF80001) return null
  if (_u32[1] === 0x7FF80002) return undefined
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
    let d = dv(), p = d.getInt32(1020, true)
    const aligned = (p + 7) & ~7  // 8-byte align
    const next = aligned + bytes
    if (next > mem.buffer.byteLength) {
      mem.grow(Math.ceil((next - mem.buffer.byteLength) / 65536))
      d = dv()  // buffer was detached by grow
    }
    d.setInt32(1020, next, true)
    return aligned
  }

  // Use WASM allocator if available, else JS-side bump
  let alloc = wasmExports?._alloc || jsAlloc
  // JS-side reset: rewind the bump pointer at byte 1020. Only used when no WASM
  // _clear is present (otherwise the WASM global / shared slot is authoritative).
  const jsReset = () => dv().setInt32(1020, 1024, true)

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
    if (wasmExports?._clear) mem.reset = wasmExports._clear
    else if (!mem.reset) mem.reset = jsReset
    if (extMap) mem._extMap = extMap
    return mem
  }

  // Patch methods onto the Memory instance
  mem.schemas = schemas
  mem._extMap = extMap

  mem.Array = (data) => {
    const n = data.length, off = hdr(n, n, n * 8)
    // Stage as i64 bits, not as JS Numbers: V8 may transition a JS Array holding
    // NaN-payload doubles to HOLEY_DOUBLE_ELEMENTS, which canonicalizes the NaN
    // payload to 0x7FF8000000000000 — destroying the type/offset bits.
    const wrapped = new BigInt64Array(n)
    for (let i = 0; i < n; i++) wrapped[i] = f64ToI64(mem.wrapVal(data[i]))
    const dst = new BigInt64Array(mem.buffer, off, n)
    for (let i = 0; i < n; i++) dst[i] = wrapped[i]
    return ptr(1, 0, off)
  }

  mem.String = (str) => {
    if (str.length <= 4 && /^[\x00-\x7f]*$/.test(str)) {
      let packed = 0
      for (let i = 0; i < str.length; i++) packed |= str.charCodeAt(i) << (i * 8)
      return ptr(4, 0x4000 | str.length, packed)  // STRING + SSO_BIT
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
    // BigInt as a data value crosses the boundary as a decimal-string. wasm-side
    // numeric parsers accept string form. Direct i64 function args go through this
    // path too; the call wrappers below detect BigInt before adaptArgs reinterprets.
    if (typeof v === 'bigint') return this.String(v.toString())
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
    const schema = schemas[sid], n = schema.length, raw = alloc(n * 8)
    // Stage as i64 bits so V8 can't canonicalize NaN-payload pointers across
    // recursive allocations. See mem.Array for the same pattern.
    const wrapped = new BigInt64Array(n)
    for (let i = 0; i < n; i++) {
      let v = obj[schema[i]]
      if (v === null || v === undefined) v = coerce(v)
      else if (typeof v === 'string') v = this.String(v)
      else if (Array.isArray(v)) v = this.Array(v)
      wrapped[i] = f64ToI64(v)
    }
    const dst = new BigInt64Array(mem.buffer, raw, n)
    for (let i = 0; i < n; i++) dst[i] = wrapped[i]
    return ptr(6, sid, raw)
  }

  mem.read = function(p) {
    if (Array.isArray(p)) return p.map(v => this.read(v))  // multi-value tuple
    if (p === p) return p  // regular number passthrough (NaN fails ===)
    const t = type(p), a = aux(p), off = offset(p)
    if (t === 0 && off === 0) {
      if (a === 1) return null
      if (a === 2) return undefined
    }
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
    if (t === 4) {  // STRING (aux bit 0x4000 = SSO inline, else heap)
      const a2 = aux(p)
      if (a2 & 0x4000) {
        const len = a2 & 0x7; let s = ''
        for (let i = 0; i < len; i++) s += String.fromCharCode((off >>> (i * 8)) & 0xFF)
        return s
      }
      const len = dv().getInt32(off - 4, true)
      return new TextDecoder().decode(new Uint8Array(mem.buffer, off, len))
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
  mem.reset = wasmExports?._clear || jsReset

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
  // i64-ABI exports: boundary-wrapped funcs whose NaN-boxed pointer params/
  // result ride i64 to dodge V8's NaN canonicalization. Map: name → { p, r }
  // with p = bit mask of i64 params, r = 1 iff result is i64. JS side
  // reinterprets f64↔BigInt only at those positions (see
  // synthesizeBoundaryWrappers).
  const i64Exp = new Map(), EMPTY_SET = new Set()
  const i64Secs = WebAssembly.Module.customSections(mod, 'jz:i64exp')
  if (i64Secs.length) {
    try { for (const e of JSON.parse(new TextDecoder().decode(i64Secs[0]))) i64Exp.set(e.name, { p: new Set(e.p), r: e.r }) }
    catch { /* ignore */ }
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
  // Per-position carrier swap: f64 stays Number, i64 positions reinterpret to
  // BigInt before the call and back to Number after. p is a Set of i64 param
  // indices; r = result is i64. Numeric (f64) positions pass through unchanged.
  const adaptArgs = (a, p) => p.size === 0 ? a : a.map((x, i) => p.has(i) ? f64ToI64(x) : x)
  const adaptRet = (ret, r) => r ? i64ToF64(ret) : ret

  // Arity-specialized wrapper: rest-spread + .map() + .apply() costs ~85ns/call
  // on hot loops (mandelbrot benchmark: 51ms wrapped vs 35ms direct over 200K
  // calls). Generating positional `function(a0, a1, ...)` via Function lets V8
  // fully inline the WASM call. Falls back to the spread-form wrapper if the
  // Function constructor is unavailable (CSP) or arity is unusually large.
  const makeFastWrapper = (fn, len, p, r, decode_, wrap_) => {
    const params = [], wrapped = []
    for (let i = 0; i < len; i++) {
      const a = `a${i}`
      params.push(a)
      const w = wrap_ ? `wrap_(${a})` : `coerce(${a})`
      wrapped.push(p.has(i) ? `f64ToI64(${w})` : w)
    }
    const callExpr = `fn(${wrapped.join(',')})`
    const retExpr = r ? `i64ToF64(${callExpr})` : callExpr
    const body = `return function(${params.join(',')}) {\n` +
      `  try { return decode_(${retExpr}) } catch (e) { decodeThrown(e) }\n` +
      `}`
    return new Function('fn', 'wrap_', 'coerce', 'decode_', 'f64ToI64', 'i64ToF64', 'decodeThrown', body)(
      fn, wrap_, coerce, decode_, f64ToI64, i64ToF64, decodeThrown)
  }

  // Pure scalar module (no memory): pass f64 values directly, no marshaling
  if (!mem) {
    for (const [name, fn] of Object.entries(realInst.exports)) {
      if (typeof fn !== 'function') { exports[name] = fn; continue }
      const sig = i64Exp.get(name)
      const p = sig?.p || EMPTY_SET, r = sig?.r || 0
      const len = fn.length
      try {
        exports[name] = makeFastWrapper(fn, len, p, r, decode, null)
        continue
      } catch { /* CSP fallback */ }
      exports[name] = (...args) => {
        while (args.length < len) args.push(undefined)
        try {
          const wasmArgs = adaptArgs(args.map(coerce), p)
          return decode(adaptRet(fn(...wasmArgs), r))
        } catch (e) { decodeThrown(e) }
      }
    }
    return exports
  }
  const memWrapVal = mem.wrapVal.bind(mem)
  const memRead = mem.read.bind(mem)
  for (const [name, fn] of Object.entries(realInst.exports)) {
    if (restFuncs.has(name) && typeof fn === 'function') {
      const fixed = restFuncs.get(name)
      const sig = i64Exp.get(name)
      const p = sig?.p || EMPTY_SET, r = sig?.r || 0
      exports[name] = (...args) => {
        const a = args.slice(0, fixed).map(x => mem.wrapVal(x))
        while (a.length < fixed) a.push(UNDEF_NAN)
        a.push(mem.Array(args.slice(fixed)))
        try {
          const ret = fn.apply(null, adaptArgs(a, p))
          return mem.read(adaptRet(ret, r))
        } catch (error) {
          decodeThrown(error)
        }
      }
    } else if (typeof fn === 'function') {
      const sig = i64Exp.get(name)
      const p = sig?.p || EMPTY_SET, r = sig?.r || 0
      const len = fn.length
      try {
        exports[name] = makeFastWrapper(fn, len, p, r, memRead, memWrapVal)
        continue
      } catch { /* CSP fallback */ }
      exports[name] = (...args) => {
        while (args.length < len) args.push(undefined)
        try {
          const boxed = args.map(x => mem.wrapVal(x))
          const ret = fn.apply(null, adaptArgs(boxed, p))
          return mem.read(adaptRet(ret, r))
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

const prepareInterop = (opts) => {
  const state = { extMap: [null], mem: null }
  opts._interp = opts._interp || {}
  // __ext_* receive NaN-boxed pointers across the env boundary as i64 (BigInt
  // in JS) — see module/collection.js header for rationale. f64 returns are
  // wrapped back to BigInt so the wasm side reinterprets a non-canonicalized
  // bit pattern.
  opts._interp.__ext_prop = (objBig, propBig) => {
    const objPtr = i64ToF64(objBig), propPtr = i64ToF64(propBig)
    const obj = state.extMap[offset(objPtr)]
    const prop = state.mem.read(propPtr)
    return f64ToI64(state.mem.wrapVal(typeof obj[prop] === 'function' ? obj[prop].bind(obj) : obj[prop]))
  }
  opts._interp.__ext_has = (objBig, propBig) => {
    return (state.mem.read(i64ToF64(propBig)) in state.extMap[offset(i64ToF64(objBig))]) ? 1 : 0
  }
  opts._interp.__ext_set = (objBig, propBig, valBig) => {
    state.extMap[offset(i64ToF64(objBig))][state.mem.read(i64ToF64(propBig))] = state.mem.read(i64ToF64(valBig))
    return 1
  }
  opts._interp.__ext_call = (objBig, propBig, argsBig) => {
    const obj = state.extMap[offset(i64ToF64(objBig))]
    const prop = state.mem.read(i64ToF64(propBig))
    const args = state.mem.read(i64ToF64(argsBig))
    return f64ToI64(state.mem.wrapVal(obj[prop].apply(obj, args)))
  }
  return state
}

// Default JS-host wiring for env.print + env.now — auto-installed when the wasm
// imports them (host: 'js' mode lowering in module/console.js). Caller-provided
// opts.imports.env entries take precedence.
const installDefaultEnvImports = (mod, imports, state) => {
  const envFns = new Set(WebAssembly.Module.imports(mod)
    .filter(i => i.module === 'env' && i.kind === 'function').map(i => i.name))
  if (!envFns.size) return
  if (!imports.env) imports.env = {}
  if (envFns.has('print') && !imports.env.print) {
    const buf = ['', '', '']  // fd 0/1/2 line buffers
    const pending = []
    const flush = (fd) => {
      const out = fd === 2 ? console.error : console.log
      out(buf[fd])
      buf[fd] = ''
    }
    // env.print's val param is i64 to dodge V8's f64 NaN canonicalization
    // across the wasm→JS boundary (see module/console.js header). Reinterpret
    // the BigInt's bits as f64 here so mem.read sees the original NaN-box.
    const write = (valBig, fd, sep) => {
      const v = state.mem.read(i64ToF64(valBig))
      buf[fd] += String(v)
      if (sep === 32) buf[fd] += ' '
      else if (sep === 10) flush(fd)
    }
    imports.env.print = (val, fd, sep) => {
      if (!state.mem) pending.push([val, fd, sep])
      else write(val, fd, sep)
    }
    state.flushPrint = () => {
      for (const args of pending) write(...args)
      pending.length = 0
    }
  }
  if (envFns.has('now') && !imports.env.now) {
    imports.env.now = (clock) =>
      clock === 1 ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : Date.now()
  }
  if (envFns.has('parseFloat') && !imports.env.parseFloat) {
    imports.env.parseFloat = (valBig) => {
      const s = state.mem.read(i64ToF64(valBig))
      return parseFloat(s)
    }
  }
  // host: 'js' timer wiring. Wasm calls env.setTimeout/clearTimeout; we drive
  // callbacks back via the exported __invoke_closure trampoline (state.invoke).
  // Each id maps to a cancel thunk so set/clear share state without tagging.
  // env.setTimeout receives cbPtr as i64 bits (BigInt) — see module/timer.js;
  // __invoke_closure also takes i64 now, so the BigInt feeds it directly.
  if (envFns.has('setTimeout') || envFns.has('clearTimeout')) {
    const cancel = new Map()
    let nextId = 1
    if (envFns.has('setTimeout') && !imports.env.setTimeout) imports.env.setTimeout = (cbBig, delayMs, repeat) => {
      const id = nextId++
      const fire = () => state.invoke?.(cbBig)
      if (repeat) {
        const h = setInterval(fire, delayMs)
        cancel.set(id, () => clearInterval(h))
      } else {
        const h = setTimeout(() => { cancel.delete(id); fire() }, delayMs)
        cancel.set(id, () => clearTimeout(h))
      }
      return id
    }
    if (envFns.has('clearTimeout') && !imports.env.clearTimeout) imports.env.clearTimeout = (id) => {
      const c = cancel.get(id)
      if (c) { c(); cancel.delete(id) }
      return 0
    }
  }
}

const buildImports = (mod, opts, state) => {
  const needsWasi = WebAssembly.Module.imports(mod).some(i => i.module === 'wasi_snapshot_preview1')
  const imports = needsWasi ? wasi(opts) : {}
  if (opts._interp) imports.env = { ...imports.env, ...opts._interp }

  // Host imports: decode NaN-boxed args for JS and wrap JS returns back into jz
  // values. Args/return ride i64 across the boundary (Step 2c) so V8 cannot
  // canonicalize the NaN payload — convert BigInt↔f64 via reinterpret bits.
  if (opts.imports) for (const [modName, fns] of Object.entries(opts.imports)) {
    if (!imports[modName]) imports[modName] = {}
    for (const name of Object.getOwnPropertyNames(fns)) {
      const spec = fns[name]
      const fn = typeof spec === 'function' ? spec : (spec && typeof spec === 'object' ? spec.fn : null)
      if (typeof fn === 'function')
        imports[modName][name] = (...args) => {
          // i64 carrier: reinterpret BigInt bits → f64 NaN-box. Pure-scalar modules
          // have no memory so skip mem.read; the f64 IS the JS number for numerics.
          const decoded = args.map(a => {
            const f = typeof a === 'bigint' ? i64ToF64(a) : a
            return state.mem ? state.mem.read(f) : decode(f)
          })
          const ret = fn.call(fns, ...decoded)
          return f64ToI64(state.mem ? state.mem.wrapVal(ret) : coerce(ret))
        }
    }
  }

  installDefaultEnvImports(mod, imports, state)
  // Shared memory: normalize (auto-wrap raw Memory), pass as import.
  // Numeric opts.memory is a compile-time page count shorthand, not an import.
  if (opts.memory instanceof WebAssembly.Memory) {
    // Auto-wrap raw WebAssembly.Memory → enhanced jz.memory
    if (!_enhanced.has(opts.memory)) opts.memory = memory(opts.memory)
    if (!imports.env) imports.env = {}
    imports.env.memory = opts.memory
  }
  // Auto-imported host globals: provide as WebAssembly.Global wrapping NaN-boxed
  // external refs. Carrier is i64 so the NaN payload survives V8's boundary
  // canonicalization — wasm side reinterprets to f64 (see asF64 in src/ir.js).
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind === 'global' && imp.module === 'env') {
      const host = globalThis[imp.name]
      if (host !== undefined) {
        if (!imports.env) imports.env = {}
        let id = state.extMap.indexOf(host); if (id === -1) { id = state.extMap.length; state.extMap.push(host) }
        imports.env[imp.name] = new WebAssembly.Global({ value: 'i64', mutable: false }, f64ToI64(ptr(11, 0, id)))
      }
    }
  }
  return { imports, needsWasi }
}

const finishInstantiation = (mod, inst, imports, needsWasi, opts, state) => {
  if (needsWasi) imports._setMemory(inst.exports.memory)

  // Trampoline used by env.setTimeout/clearTimeout to fire scheduled closures.
  state.invoke = inst.exports.__invoke_closure || null

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

  // For shared memory, resolve memory from import; for own memory, from export.
  const rawMemory = opts.memory instanceof WebAssembly.Memory ? opts.memory : inst.exports.memory
  const memSrc = { module: mod, instance: inst, exports: { ...inst.exports, memory: rawMemory }, extMap: state.extMap }
  const enhanced = memory(memSrc)
  state.mem = enhanced
  state.flushPrint?.()
  return { exports: wrap(memSrc), memory: enhanced, instance: inst, module: mod }
}

/**
 * Compile, instantiate, and wrap exports (with WASI + rest-param support).
 * `compile` is the jz.compile function (injected to avoid importing the compiler core).
 */
export const instantiate = (compile, code, opts = {}) => {
  const state = prepareInterop(opts)
  const wasm = compile(code, opts)
  opts.extMap = state.extMap
  const mod = new WebAssembly.Module(wasm)
  const { imports, needsWasi } = buildImports(mod, opts, state)
  const hasImports = Object.keys(imports).some(k => k !== '_setMemory')
  const inst = new WebAssembly.Instance(mod, hasImports ? imports : undefined)
  return finishInstantiation(mod, inst, imports, needsWasi, opts, state)
}
