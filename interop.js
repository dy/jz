/**
 * jz/interop — host-side boundary codec.
 *
 * Importable as `jz/interop` without pulling the compiler, parser, or watr —
 * use this to run prebuilt jz wasm from a host that doesn't need to compile.
 * Sole external dependency: `./wasi.js`.
 *
 * Marshals NaN-boxed `f64` values across the boundary: bump-allocated heap
 * blobs (strings, arrays, typed arrays, objects), schema transport for
 * fixed-shape objects, host-object externrefs.
 *
 * Exports:
 *   UNDEF_NAN, NULL_NAN, coerce          — null/undefined sentinels
 *   i64ToF64, f64ToI64                    — bit-cast across the i64 boundary
 *   ptr / offset / type / aux             — NaN-boxed pointer codec
 *   memory(src)                           — enhance a WebAssembly.Memory with read/write/String/Array/…
 *   wrap(memSrc, inst?)                   — adapt raw wasm exports to JS calling convention
 *   instantiate(wasm, opts?)              — instantiate prebuilt wasm bytes + wrap
 *
 * One boundary codec per binary: a jz wasm picks its host shape at compile
 * time (`opts.host`). There is no runtime "driver sniff" — the host loading
 * the binary knows which variant it asked for.
 *
 * @module jz/interop
 */

import { wasi, attachTimers } from './wasi.js'
import { HEAP, encodePtrHi, decodePtrType, decodePtrAux, ATOM, ATOM_HI, LAYOUT } from './layout.js'

// Stateless + reusable — one instance avoids a per-call allocation on the hot
// string read/write paths (mem.String / mem.read STRING).
const TEXT_ENC = new TextEncoder()
const TEXT_DEC = new TextDecoder()

// ── WASI linking ────────────────────────────────────────────────────────────

const linkWasi = (mod, opts) => {
  const needsWasi = WebAssembly.Module.imports(mod).some(i => i.module === 'wasi_snapshot_preview1')
  return { needsWasi, wasiImports: needsWasi ? wasi(opts) : null }
}

const envFuncNames = (mod) =>
  new Set(WebAssembly.Module.imports(mod)
    .filter(i => i.module === 'env' && i.kind === 'function').map(i => i.name))

// ── Allocator wiring ────────────────────────────────────────────────────────
// Heap pointer: the exported `$__heap` global when the module has one (non-shared
// memory), else memory[1020] (shared memory — globals are per-instance, so
// threads must share a pointer cell in linear memory). 8-byte aligned bump on
// the JS side; wasm `_alloc` takes over if exported.

const makeJsAllocator = (mem, heapGlobal) => {
  const dv = () => new DataView(mem.buffer)
  const getPtr = heapGlobal ? () => heapGlobal.value : () => dv().getInt32(HEAP.PTR_ADDR, true)
  const setPtr = heapGlobal ? v => { heapGlobal.value = v } : v => dv().setInt32(HEAP.PTR_ADDR, v, true)
  // Rewind target: the global's post-static-init value, else the fixed start.
  const base = heapGlobal ? heapGlobal.value : HEAP.START
  const alloc = (bytes) => {
    const aligned = (getPtr() + 7) & ~7
    const next = aligned + bytes
    if (next > mem.buffer.byteLength)
      mem.grow(Math.ceil((next - mem.buffer.byteLength) / 65536))
    setPtr(next)
    return aligned
  }
  const reset = () => setPtr(base)
  // The global is initialized by wasm at module load; only the memory cell needs
  // a JS-side nudge in case it underflows the heap start.
  const initHeapPtr = () => {
    if (heapGlobal) return
    const d = dv()
    if (d.getInt32(HEAP.PTR_ADDR, true) < HEAP.START) d.setInt32(HEAP.PTR_ADDR, HEAP.START, true)
  }
  return { alloc, reset, initHeapPtr }
}

// ── Custom-section reading ──────────────────────────────────────────────────

const customSection = (mod, name) => {
  const secs = WebAssembly.Module.customSections(mod, name)
  return secs.length ? new Uint8Array(secs[0]) : null
}

const sectionReader = (bytes) => {
  const td = new TextDecoder()
  let i = 0
  return {
    pos: () => i,
    seek: (p) => { i = p },
    eof: () => i >= bytes.length,
    u8: () => bytes[i++],
    varint: () => {
      let r = 0, s = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const x = bytes[i++]
        r |= (x & 0x7F) << s
        if (!(x & 0x80)) return r
        s += 7
      }
    },
    str: (n) => { const s = td.decode(bytes.subarray(i, i + n)); i += n; return s },
    bytes: (n) => { const r = bytes.subarray(i, i + n); i += n; return r },
  }
}

// ── NaN-box codec ───────────────────────────────────────────────────────────

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
_u32[1] = ATOM_HI[ATOM.NULL]; _u32[0] = 0; export const NULL_NAN = _f64[0]
_u32[1] = ATOM_HI[ATOM.UNDEF]; _u32[0] = 0; export const UNDEF_NAN = _f64[0]
_u32[1] = ATOM_HI[ATOM.FALSE]; _u32[0] = 0; export const FALSE_NAN = _f64[0]
_u32[1] = ATOM_HI[ATOM.TRUE]; _u32[0] = 0; export const TRUE_NAN = _f64[0]

// Coerce JS null/undefined → NaN-boxed sentinels for WASM boundary
export const coerce = v => v === null ? NULL_NAN : v === undefined ? UNDEF_NAN : v

// Decode f64 return value: null/undefined sentinels → JS values, numbers pass through
const decode = v => {
  if (v === v) return v  // fast path: non-NaN
  _f64[0] = v
  if (_u32[0] !== 0) return v
  if (_u32[1] === ATOM_HI[ATOM.NULL]) return null
  if (_u32[1] === ATOM_HI[ATOM.UNDEF]) return undefined
  if (_u32[1] === ATOM_HI[ATOM.FALSE]) return false
  if (_u32[1] === ATOM_HI[ATOM.TRUE]) return true
  return v
}

export const ptr = (type, aux, offset) => {
  _u32[1] = encodePtrHi(type, aux)
  _u32[0] = offset >>> 0; return _f64[0]
}
export const offset = (p) => { _f64[0] = p; return _u32[0] }
export const type = (p) => { _f64[0] = p; return decodePtrType(_u32[1]) }
export const aux = (p) => { _f64[0] = p; return decodePtrAux(_u32[1]) }

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

  // Allocator scaffold: bumps the exported `$__heap` global (or memory[1020] for
  // shared memory). Wasm `_alloc` takes over when exported; `_clear`/jsReset rewinds.
  const { alloc: jsAlloc, reset: jsReset, initHeapPtr } = makeJsAllocator(mem, wasmExports?.__heap)
  let alloc = wasmExports?._alloc || jsAlloc
  initHeapPtr()

  // Write 16-byte header matching WASM `__alloc_hdr`:
  // [propsPtr@+0(i64=0), len@+8, cap@+12], return data offset (raw+16).
  // Read paths (ARRAY at off-8/-4, BUFFER at off-8) and the propsPtr slot at
  // off-16 then work uniformly on JS- and WASM-allocated values.
  const hdr = (len, cap, bytes) => {
    const raw = alloc(16 + bytes)
    const m = dv()
    m.setBigInt64(raw, 0n, true)
    m.setInt32(raw + 8, len, true)
    m.setInt32(raw + 12, cap, true)
    return raw + 16
  }

  // Read schemas from module custom section, merge into memory.schemas. Schema
  // entries are { type, payload } where type=0 means null (computed/missing
  // key), type=1 means nested [null, name] (synthetic shape), else a UTF-8
  // length-prefixed property name. Section format is varint-prefixed list.
  let schemas = mem.schemas || []
  const schemaBytes = mod && customSection(mod, 'jz:schema')
  if (schemaBytes) {
    const r = sectionReader(schemaBytes)
    const dec = () => {
      const t = r.u8()
      if (t === 0) return null
      if (t === 1) return [null, dec()]
      return r.str(r.varint())
    }
    const nS = r.varint(), newSchemas = []
    for (let j = 0; j < nS; j++) { const k = r.varint(), props = []; for (let p = 0; p < k; p++) props.push(dec()); newSchemas.push(props) }
    for (const s of newSchemas) {
      const key = s.join(',')
      if (!schemas.some(existing => existing.join(',') === key)) schemas.push(s)
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
      return ptr(4, LAYOUT.SSO_BIT | str.length, packed)  // STRING + SSO_BIT
    }
    const enc = TEXT_ENC.encode(str)
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
    if (typeof v === 'string') return mem.String(v)
    // BigInt as a data value crosses the boundary as a decimal-string; wasm-side
    // numeric parsers accept string form.
    if (typeof v === 'bigint') return mem.String(v.toString())
    if (Array.isArray(v)) return mem.Array(v)
    if (v instanceof ArrayBuffer) return mem.Buffer(v)
    if (v instanceof DataView) return mem.Buffer(v.buffer)
    const typedName = v?.constructor?.name
    if (typedName && ELEMS[typedName]) return mem[typedName](v)
    if (typeof v === 'object' || typeof v === 'function') return mem.External(v)
    return UNDEF_NAN
  }

  mem.External = function(obj) {
    if (obj === null || obj === undefined) return coerce(obj)
    const map = mem._extMap
    if (!map) return UNDEF_NAN
    let id = map.indexOf(obj)
    if (id === -1) { id = map.length; map.push(obj) }
    return ptr(11, 0, id)
  }

  mem.Object = function(obj) {
    const objKeys = Object.keys(obj)
    const key = objKeys.join(',')
    const schemas = mem.schemas
    let sid = schemas.findIndex(s => s.join(',') === key)
    if (sid === -1) {
      const matches = schemas.reduce((a, s, i) =>
        (s.length === objKeys.length && objKeys.every(k => s.includes(k)) ? a.concat(i) : a), [])
      if (matches.length === 1) sid = matches[0]
      else if (matches.length > 1) throw Error(`Ambiguous schema for {${key}} — pass keys in schema order`)
      else if (mem._extMap) return mem.External(obj)
      else throw Error(`No schema for {${key}}`)
    }
    const schema = schemas[sid], n = schema.length, raw = alloc(n * 8)
    // Stage as i64 bits so V8 can't canonicalize NaN-payload pointers across
    // recursive allocations. See mem.Array for the same pattern.
    const wrapped = new BigInt64Array(n)
    for (let i = 0; i < n; i++) {
      let v = obj[schema[i]]
      if (v === null || v === undefined) v = coerce(v)
      else if (typeof v === 'string') v = mem.String(v)
      else if (Array.isArray(v)) v = mem.Array(v)
      wrapped[i] = f64ToI64(v)
    }
    const dst = new BigInt64Array(mem.buffer, raw, n)
    for (let i = 0; i < n; i++) dst[i] = wrapped[i]
    return ptr(6, sid, raw)
  }

  mem.read = function(p) {
    if (Array.isArray(p)) return p.map(v => mem.read(v))  // multi-value tuple
    if (p === p) return p  // regular number passthrough (NaN fails ===)
    const t = type(p), a = aux(p), off = offset(p)
    if (t === 0 && off === 0) {
      if (a === 1) return null
      if (a === 2) return undefined
      if (a === 4) return false
      if (a === 5) return true
    }
    if (t === 11 && mem._extMap) return mem._extMap[off]
    if (t === 1) {  // ARRAY
      let m = dv(), aOff = off
      // Follow forwarding pointers (cap === -1 means array was reallocated)
      while (m.getInt32(aOff - 4, true) === -1) aOff = m.getInt32(aOff - 8, true)
      const len = m.getInt32(aOff - 8, true), out = new Array(len)
      for (let i = 0; i < len; i++) out[i] = mem.read(m.getFloat64(aOff + i * 8, true))
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
    if (t === 4) {  // STRING (aux SSO_BIT = inline, else heap)
      const a2 = aux(p)
      if (a2 & LAYOUT.SSO_BIT) {
        const len = a2 & 0x7; let s = ''
        for (let i = 0; i < len; i++) s += String.fromCharCode((off >>> (i * 8)) & 0xFF)
        return s
      }
      const len = dv().getInt32(off - 4, true)
      return TEXT_DEC.decode(new Uint8Array(mem.buffer, off, len))
    }
    if (t === 6) {  // OBJECT
      const m = dv(), sid = aux(p), keys = mem.schemas[sid]
      if (!keys) return p
      const obj = {}
      for (let i = 0; i < keys.length; i++) obj[keys[i]] = mem.read(m.getFloat64(off + i * 8, true))
      return obj
    }
    if (t === 7) {  // HASH
      const m = dv(), size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true)
      const obj = {}
      for (let i = 0, found = 0; i < cap && found < size; i++) {
        const hash = m.getFloat64(off + i * 24, true)
        if (hash !== 0) {
          const key = mem.read(m.getFloat64(off + i * 24 + 8, true))
          obj[key] = mem.read(m.getFloat64(off + i * 24 + 16, true))
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
        if (hash !== 0) set.add(mem.read(m.getFloat64(off + i * 16 + 8, true)))
      }
      return set
    }
    if (t === 9) {  // MAP
      const m = dv(), size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true)
      const map = new Map()
      for (let i = 0; i < cap && map.size < size; i++) {
        const hash = m.getFloat64(off + i * 24, true)
        if (hash !== 0) map.set(mem.read(m.getFloat64(off + i * 24 + 8, true)), mem.read(m.getFloat64(off + i * 24 + 16, true)))
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
      const schema = mem.schemas[aux(p)]
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
  const td = new TextDecoder()
  const restBytes = customSection(mod, 'jz:rest')
  if (restBytes) {
    try {
      for (const entry of JSON.parse(td.decode(restBytes)))
        restFuncs.set(typeof entry === 'string' ? entry : entry.name, typeof entry === 'string' ? 0 : entry.fixed)
    } catch (e) { /* ignore */ }
  }
  // externref-param exports: positions where the wasm side takes an externref
  // (jsstring carrier — js-host only). JS values at these positions pass through
  // unchanged — no `mem.wrapVal` (would NaN-box into f64, defeating the point).
  // `def` (optional) maps idx → default-string for jsstring params whose
  // default substitution happens JS-side (the wasm side never sees null).
  const extExp = new Map()
  const extBytes = customSection(mod, 'jz:extparam')
  if (extBytes) {
    try {
      for (const e of JSON.parse(td.decode(extBytes))) {
        const idx = new Set(e.p)
        // Hang the defaults off the Set as a property so call-sites that only
        // check membership stay unchanged; the slow path reads `extInfo.def`.
        if (e.d) idx.def = new Map(Object.entries(e.d).map(([k, v]) => [Number(k), v]))
        extExp.set(e.name, idx)
      }
    } catch { /* ignore */ }
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
  // Wrap one positional arg. Externref slots (jsstring carrier) pass the JS
  // value straight through — `mem.wrapVal` would NaN-box it — substituting a
  // jsstring literal default for a missing arg. Every other slot marshals via
  // `box`: `coerce` for pure-scalar modules, `mem.wrapVal` for heap modules.
  // Quiet-NaN ABI: every export value is f64, so there is no per-position i64
  // carrier — args flow straight to the wasm call, results straight to decode/read.
  const wrapArgAt = (ext, i, x, box) =>
    ext?.has(i) ? (x === undefined && ext.def?.has(i) ? ext.def.get(i) : x) : box(x)

  // Pure scalar module (no memory): pass f64 values directly, no marshaling
  if (!mem) {
    for (const [name, fn] of Object.entries(realInst.exports)) {
      if (typeof fn !== 'function') { exports[name] = fn; continue }
      const ext = extExp.get(name)
      const len = fn.length
      exports[name] = (...args) => {
        while (args.length < len) args.push(undefined)
        try {
          return decode(fn(...args.map((x, i) => wrapArgAt(ext, i, x, coerce))))
        } catch (e) { decodeThrown(e) }
      }
    }
    return exports
  }
  const memWrapVal = mem.wrapVal.bind(mem)
  for (const [name, fn] of Object.entries(realInst.exports)) {
    if (restFuncs.has(name) && typeof fn === 'function') {
      const fixed = restFuncs.get(name)
      const ext = extExp.get(name)
      exports[name] = (...args) => {
        const a = args.slice(0, fixed).map((x, i) => wrapArgAt(ext, i, x, memWrapVal))
        while (a.length < fixed) a.push(UNDEF_NAN)
        a.push(mem.Array(args.slice(fixed)))
        try {
          return mem.read(fn.apply(null, a))
        } catch (error) {
          decodeThrown(error)
        }
      }
    } else if (typeof fn === 'function') {
      const ext = extExp.get(name)
      const len = fn.length
      exports[name] = (...args) => {
        while (args.length < len) args.push(undefined)
        try {
          return mem.read(fn.apply(null, args.map((x, i) => wrapArgAt(ext, i, x, memWrapVal))))
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
  const envFns = envFuncNames(mod)
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
  // One i32 of entropy to seed Math.random — only present when compiled with
  // { randomSeed: true }. Prefers crypto; falls back to Math.random.
  if (envFns.has('rngSeed') && !imports.env.rngSeed) {
    imports.env.rngSeed = () => {
      const a = new Uint32Array(1)
      if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a)
      else a[0] = (Math.random() * 0x100000000) >>> 0
      return a[0] | 0
    }
  }
  if (envFns.has('parseFloat') && !imports.env.parseFloat) {
    imports.env.parseFloat = (valBig) => {
      const s = state.mem.read(i64ToF64(valBig))
      return parseFloat(s)
    }
  }
  if (envFns.has('parseInt') && !imports.env.parseInt) {
    imports.env.parseInt = (valBig, radix) => {
      const s = state.mem.read(i64ToF64(valBig))
      return parseInt(s, radix || undefined)
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

// JS-side polyfills for `wasm:js-string` builtins. Used when the engine does
// NOT honor `new WebAssembly.Module(buf, { builtins: ['js-string'] })` — older
// V8, Hermes, JSC pre-18.4, etc. With native builtins the engine inlines
// these calls to direct string accesses; with the polyfill each call is a
// wasm→JS hop (still correct, just no boundary win).
const JSS_POLYFILL = {
  length:     (s) => s.length,
  charCodeAt: (s, i) => s.charCodeAt(i),
}

// Probe once: does this engine honor the `{ builtins: ['js-string'] }` option
// on WebAssembly.Module? Compiles a tiny module that imports a wasm:js-string
// fn; if instantiation succeeds with no imports object, native is available.
let jssNativeProbed = false
let jssNativeSupported = false
const jssProbeNative = () => {
  if (jssNativeProbed) return jssNativeSupported
  jssNativeProbed = true
  try {
    // Minimal module: (module (import "wasm:js-string" "length" (func (param externref) (result i32))))
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,        // header
      0x01, 0x06, 0x01, 0x60, 0x01, 0x6f, 0x01, 0x7f,        // type: (externref)→i32
      0x02, 0x18, 0x01,                                       // import section
      0x0f, ...TEXT_ENC.encode('wasm:js-string'),             // mod name
      0x06, ...TEXT_ENC.encode('length'),                     // name
      0x00, 0x00,                                             // kind=func, type=0
    ])
    const mod = new WebAssembly.Module(bytes, { builtins: ['js-string'] })
    new WebAssembly.Instance(mod, {})
    jssNativeSupported = true
  } catch {
    jssNativeSupported = false
  }
  return jssNativeSupported
}

const buildImports = (mod, opts, state) => {
  const { needsWasi, wasiImports } = linkWasi(mod, opts)
  const imports = wasiImports || {}
  if (opts._interp) imports.env = { ...imports.env, ...opts._interp }

  // `wasm:js-string` polyfills — only attach when native builtins aren't honored
  // by this engine. With `{ builtins: ['js-string'] }` the import slots are
  // already filled by the engine; supplying a JS function would error or just
  // be ignored. Without native support, polyfill the names this module imports.
  if (!jssProbeNative()) {
    for (const imp of WebAssembly.Module.imports(mod)) {
      if (imp.module === 'wasm:js-string' && JSS_POLYFILL[imp.name]) {
        if (!imports['wasm:js-string']) imports['wasm:js-string'] = {}
        imports['wasm:js-string'][imp.name] = JSS_POLYFILL[imp.name]
      }
    }
  }

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

  // Drive WASM timer queue via JS scheduling (non-blocking, no-op if absent).
  attachTimers(inst)

  // For shared memory, resolve memory from import; for own memory, from export.
  const rawMemory = opts.memory instanceof WebAssembly.Memory ? opts.memory : inst.exports.memory
  const memSrc = { module: mod, instance: inst, exports: { ...inst.exports, memory: rawMemory }, extMap: state.extMap }
  const enhanced = memory(memSrc)
  state.mem = enhanced
  state.flushPrint?.()
  return { exports: wrap(memSrc), memory: enhanced, instance: inst, module: mod }
}

/**
 * Instantiate prebuilt jz wasm and wrap exports (WASI imports, rest-params,
 * host-object externrefs, default env.print/now wiring, optional shared memory).
 *
 * Compile-and-instantiate is the caller's job — pass already-compiled bytes:
 *   import { instantiate } from 'jz/interop'
 *   const { exports, memory } = instantiate(wasmBytes)
 *
 * @param {Uint8Array|ArrayBuffer|WebAssembly.Module} wasm  prebuilt wasm
 * @param {object} [opts]  host options: imports, memory, _interp, host-shape flags
 * @returns {{ exports, memory, instance, module }}
 */
export const instantiate = (wasm, opts = {}) => {
  const state = prepareInterop(opts)
  // Prefer native `wasm:js-string` builtins when the engine honors the option.
  // The option is silently accepted by V8 17+/Safari 18.4+; older engines that
  // don't recognize it either throw or ignore it — try-fallback handles both.
  let mod
  if (wasm instanceof WebAssembly.Module) {
    mod = wasm
  } else if (jssProbeNative()) {
    try {
      mod = new WebAssembly.Module(wasm, { builtins: ['js-string'] })
    } catch {
      mod = new WebAssembly.Module(wasm)
    }
  } else {
    mod = new WebAssembly.Module(wasm)
  }
  const { imports, needsWasi } = buildImports(mod, opts, state)
  const hasImports = Object.keys(imports).some(k => k !== '_setMemory')
  const inst = new WebAssembly.Instance(mod, hasImports ? imports : undefined)
  return finishInstantiation(mod, inst, imports, needsWasi, opts, state)
}
