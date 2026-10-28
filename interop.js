/**
 * Host runtime: instantiates prebuilt jz wasm and marshals values across its
 * boundary. `jz/interop` (instantiate.js) exposes `instantiate`, index.js
 * `memory` as `jz.memory`; the rest serves the tests. No compiler, parser or
 * watr: only host linking, layout, error metadata and UTF-8 decoding.
 *
 * Values cross NaN-boxed, carried as i64 bits: heap blobs (strings, arrays,
 * typed arrays, objects), fixed-shape objects by schema, host objects by
 * reference. A module picks its host shape at compile time (`opts.host`).
 *
 * @module interop
 */

import { wasi, attachTimers } from './wasi.js'
import { HEAP, PTR, FIELD, encodePtrHi, decodePtrType, decodePtrAux, ATOM, ATOM_HI, LAYOUT, SYMBOL_MIN, TOMB_NAN, DATA_VIEW_FLAG, DATA_VIEW_AUX, TYPED_ELEM_VIEW_FLAG, TYPED_ELEM_NAMES, encodeTypedElemAux, ctorFromElemAux, HIDDEN_PROPERTY_SEQ, ARRAY_RAW, RESIZABLE_MARK } from './layout.js'
import { ERROR_CODE_HI, ERR_INFO, ERR_CLASS_NAMES } from './err-codes.js'
import { decodeUtf8 } from './utf8.js'

// ── Allocator ───────────────────────────────────────────────────────────────
// The heap top: the exported `$__heap` global, or for a shared memory the cell
// at 1020 (globals are per instance, threads share the cell). An 8-byte aligned
// bump; the module's `_alloc` takes over where it exports one. An i32 address
// crosses into JS signed: `>>> 0` reads it unsigned past 2 GiB.
const makeJsAllocator = (mem, heapGlobal) => {
  const dv = () => new DataView(mem.buffer)
  const getPtr = heapGlobal ? () => heapGlobal.value >>> 0 : () => dv().getUint32(HEAP.PTR_ADDR, true)
  const setPtr = heapGlobal ? v => { heapGlobal.value = v } : v => dv().setInt32(HEAP.PTR_ADDR, v, true)
  // Rewind target: the global's post-static-init value, else the fixed start.
  let base = heapGlobal ? (heapGlobal.value >>> 0) : HEAP.START
  // A block of 4 KiB or more starts at the next quarter-page colour mod 4096,
  // as the module's own __alloc places them (module/core.js): arrays the host
  // hands a kernel do not share their low address bits (4K aliasing).
  let color = 0
  const alloc = (bytes) => {
    // aligned by arithmetic: `& ~7` would read the address signed again
    const ptr = getPtr()
    let aligned = Math.ceil(ptr / 8) * 8
    if (bytes >= 4096) { aligned += (color - aligned % 4096 + 4096) % 4096; color = (color + 1024) % 4096 }
    const next = aligned + bytes
    if (!Number.isSafeInteger(bytes) || bytes < 0 || next >= 2 ** 32)
      throw new RangeError('allocation exceeds the wasm32 heap or has an invalid size')
    if (next > mem.buffer.byteLength)
      mem.grow(Math.ceil((next - mem.buffer.byteLength) / 65536))
    setPtr(next)
    return aligned
  }
  const reset = () => setPtr(base)
  // the module sets its global; a memory's cell may still read below the heap start
  const initHeapPtr = () => {
    if (heapGlobal) return
    const d = dv()
    if (d.getUint32(HEAP.PTR_ADDR, true) < HEAP.START) d.setInt32(HEAP.PTR_ADDR, HEAP.START, true)
  }
  // The heap top and the post-init base: `memory.used` is their distance, and a
  // call that may release its argument copies rewinds the top to a mark.
  return { alloc, reset, initHeapPtr, top: getPtr, setTop: setPtr,
    used: () => getPtr() - base, base: () => base,
    // Owned modules may initialize after the host adapter is ready. Cell-backed
    // memories keep their fixed reset target (HEAP.START).
    markBase: () => { if (heapGlobal) base = getPtr() },
  }
}

// ── Custom-section reading ──────────────────────────────────────────────────

const customSection = (mod, name) => {
  const secs = WebAssembly.Module.customSections(mod, name)
  return secs.length ? new Uint8Array(secs[0]) : null
}
// A JSON section's value, or null where the module has none or it does not parse.
const jsonSection = (mod, name) => {
  const bytes = customSection(mod, name)
  try { return bytes && JSON.parse(decodeUtf8(bytes)) } catch { return null }
}

// A binary section: bytes, LEB128 counts, length-prefixed UTF-8 strings.
const sectionReader = (bytes) => {
  let i = 0
  const varint = () => {
    let r = 0, s = 0, x
    do { x = bytes[i++]; r |= (x & 0x7F) << s; s += 7 } while (x & 0x80)
    return r
  }
  return { u8: () => bytes[i++], varint, str: () => { const n = varint(), t = decodeUtf8(bytes.subarray(i, i + n)); i += n; return t } }
}

// ── NaN-box codec ───────────────────────────────────────────────────────────

// A box never becomes a JS number: JSC canonicalizes a NaN payload the moment
// it materializes as f64, so a box is a BigInt (its i64 bits) decoded with
// integer ops, and only genuine numbers touch f64. The bits cross through one
// 8-byte cell: shifting a BigInt allocates at every step.
const MASK32 = 0xffffffffn
const _buf = new ArrayBuffer(8), _u32 = new Uint32Array(_buf), _f64 = new Float64Array(_buf), _u64 = new BigUint64Array(_buf)
export const f64ToI64 = (n) => { _f64[0] = n; return _u64[0] }
export const i64ToF64 = (b) => { _u64[0] = b; return _f64[0] }

const hi32 = (b) => { _u64[0] = b; return _u32[1] }
const lo32 = (b) => { _u64[0] = b; return _u32[0] }
// A box is a sign-0 quiet NaN: its high word carries the 0x7FF8 prefix. The
// mask takes the sign bit too, so a negative host BigInt (whose sign extension
// fills the prefix bits) is no box, as module/core.js $__typeof reads it.
const BOX_HI = LAYOUT.NAN_PREFIX << 16, BOX_HI_MASK = BOX_HI | 0x80000000
const isBox = (b) => (hi32(b) & BOX_HI_MASK) === BOX_HI
// A marshalled value's i64 bits: a box as it is, a number by its f64 bits.
const bits = (v) => typeof v === 'bigint' ? v : f64ToI64(v)

// The reserved atoms (type ATOM, offset 0): aux 1/2/4/5 null/undefined/false/true.
export const NULL_NAN = BigInt(ATOM_HI[ATOM.NULL]) << 32n
export const UNDEF_NAN = BigInt(ATOM_HI[ATOM.UNDEF]) << 32n
export const FALSE_NAN = BigInt(ATOM_HI[ATOM.FALSE]) << 32n
export const TRUE_NAN = BigInt(ATOM_HI[ATOM.TRUE]) << 32n
// Absent array cells have no own index; present undefined keeps UNDEF_NAN.
const TOMB_BITS = BigInt(TOMB_NAN)

// A scalar into the tagged lane: a NaN canonical, so its payload reads as no atom or pointer.
export const coerce = v => v === null ? NULL_NAN : v === undefined ? UNDEF_NAN : v !== v ? NaN : v

// A string of up to six ASCII characters lives in its box (module/string.js):
// char i at payload bit i*7, the length at bits 42-44. No heap needed.
const ssoFits = (s) => s.length <= LAYOUT.MAX_SSO && /^[\x00-\x7f]*$/.test(s)
const encodeSSO = (s) => {
  let p = 0n
  for (let i = 0; i < s.length; i++) p |= BigInt(s.charCodeAt(i)) << BigInt(i * 7)
  p |= BigInt(s.length) << 42n
  return ptr(4, Number(p >> 32n) | LAYOUT.SSO_BIT, Number(p & 0xFFFFFFFFn))
}

// The i64 carrier, or a legacy f64 NaN-box (intact on V8).
const asBits = (p) => typeof p === 'bigint' ? p : f64ToI64(p)
export const ptr = (type, aux, offset) => { _u32[1] = encodePtrHi(type, aux); _u32[0] = offset; return _u64[0] }
export const offset = (p) => lo32(asBits(p))
export const type = (p) => decodePtrType(hi32(asBits(p)))
export const aux = (p) => decodePtrAux(hi32(asBits(p)))

const decodeSSO = (b) => {
  const a = decodePtrAux(hi32(b)), len = (a >>> 10) & 7
  const payload = (BigInt(a) << 32n) | BigInt(Number(b & MASK32))
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(Number((payload >> BigInt(i * 7)) & 0x7fn))
  return s
}

// A Symbol belongs to one compiled instance. Host inputs and compiled factories
// draw from the same counter; interned ids resolve through the host registry.
// Keep this table across arena resets: Symbols have identity but no heap storage.
const symbolCodecs = new WeakMap()
const symbolsOf = (owner, mod, raw) => {
  let codec = symbolCodecs.get(owner)
  if (codec) return codec
  const values = new Map(), ids = new Map(), counter = raw?.__symbol_id
  let next = ptr(PTR.ATOM, SYMBOL_MIN, 0)
  const remember = (id, value) => { values.set(id, value); ids.set(value, id); return value }
  for (const [key, id] of (mod && jsonSection(mod, 'jz:symbols')) || [])
    remember(ptr(PTR.ATOM, id, 0), Symbol.for(key))
  codec = {
    read(id) { return values.has(id) ? values.get(id) : remember(id, Symbol()) },
    write(value) {
      if (ids.has(value)) return ids.get(value)
      let id = (counter ? counter.value : next) + 1n
      if (!(id & MASK32)) id++
      if (id >= TOMB_BITS) throw new RangeError('Symbol identity space exhausted')
      if (counter) counter.value = id
      else next = id
      remember(id, value)
      return id
    },
  }
  symbolCodecs.set(owner, codec)
  return codec
}

// A value read from its bits alone: the forms a module without memory carries
// (numbers, atoms, SSO strings, Symbols, closures through wrap's `fnOf`).
// A module with memory reads through `mem.read`.
const decode = (v, fnOf = null, symbols = null) => {
  if (Array.isArray(v)) return v.map(x => decode(x, fnOf, symbols))   // a tuple of results
  if (typeof v === 'number') { if (v === v) return v; v = f64ToI64(v) }
  else if (typeof v !== 'bigint') return v     // already a JS value
  if (!isBox(v)) return i64ToF64(v)
  if (type(v) === 4 && (aux(v) & LAYOUT.SSO_BIT)) return decodeSSO(v)
  if (type(v) === 10 && fnOf) return fnOf(v)
  if (symbols && type(v) === PTR.ATOM && aux(v) >= SYMBOL_MIN && v !== TOMB_BITS) return symbols.read(v)
  if (offset(v) === 0) {
    if (v === NULL_NAN) return null
    if (v === UNDEF_NAN) return undefined
    if (v === FALSE_NAN) return false
    if (v === TRUE_NAN) return true
  }
  return i64ToF64(v)                            // the canonical NaN
}

// A Number argument whose NaN payload spells the undefined or null box (of
// either sign, quiet or not) enters as the canonical NaN; any other as it is.
// A result crossing as a Number is one (src/compile/boundary-wrap.js sends any
// other value as i64 bits): a NaN of any payload reads as NaN.
const numberArg = (x) => {
  if (x === x || typeof x !== 'number') return x
  const b = f64ToI64(x) & 0x7FFFFFFFFFFFFFFFn | 0x0008000000000000n
  return b === UNDEF_NAN || b === NULL_NAN ? NaN : x
}
const numberRet = (v) => v === v ? v : NaN

// The typed element kinds by constructor name and by the aux code of an owned
// array (layout.js encodeTypedElemAux: element code | 16 BigInt | 32 f16 | 64
// clamped): code, byte stride, DataView setter. BigInt64Array and
// BigUint64Array share one code, which reads back as signed.
const KINDS = {}, KIND_OF = []
for (const name of [...TYPED_ELEM_NAMES, 'BigInt64Array', 'BigUint64Array', 'Float16Array', 'Uint8ClampedArray']) {
  const code = encodeTypedElemAux(name)
  KINDS[name] = { name, code, stride: [1, 1, 2, 2, 4, 4, 4, 8][code & 7], set: 'set' + (code & 64 ? 'Uint8' : name.slice(0, -5)) }
  KIND_OF[code] ??= KINDS[name]
}
// A typed pointer's kind, the view flag aside; its constructor where the host has one
const kindOfAux = (a) => KIND_OF[a & ~(TYPED_ELEM_VIEW_FLAG | DATA_VIEW_FLAG)]
const ctorOf = (kind) => kind && globalThis[kind.name]

const _enhanced = new WeakSet()

// A block that grew forwards to its new one (its capacity -1, the new offset before it)
const forward = (m, off) => { while (m.getInt32(off - 4, true) === -1) off = m.getUint32(off - 8, true); return off }

// A host value's box: its index in the table of host references a memory's modules share
const external = (map, value) => {
  let id = map.indexOf(value)
  if (id === -1) { id = map.length; map.push(value) }
  return ptr(PTR.EXTERNAL, 0, id)
}
// A host import's argument as the host takes it; before the module's memory is
// wired (its start function), decoded from the bits alone
const readHost = (state, v) => state.mem ? state.mem.read(v, state.fnOf) : decode(v, state.fnOf)

/**
 * The tables a module declares for the memory it links to (compile/index.js
 * writes them): by schema id the Error class, the class brand and the RegExp,
 * the field contracts and the property lists. A property is 0 null (a computed
 * or missing key), 1 a nested [null, name], 3 a JSON-escaped name, 2 text.
 */
const NO_TABLES = { errorClasses: new Map(), brands: new Map(), regexes: new Map(), fields: [], schemas: [], views: new Set() }
const moduleTables = (mod) => {
  // A section's count of entries, each read by `entry` from its reader
  const list = (name, entry) => {
    const bytes = customSection(mod, name), out = []
    if (bytes) { const r = sectionReader(bytes); for (let j = 0, n = r.varint(); j < n; j++) out.push(entry(r)) }
    return out
  }
  const bySid = (name, value) => new Map(list(name, r => [r.varint(), value(r)]))
  // the schemas with an object literal's accessor: read through the module's data copy (`__view_data`)
  const views = new Set(list('jz:views', r => r.varint()))
  const errorClasses = bySid('jz:errcls', r => r.str()), brands = bySid('jz:brand', r => r.str())
  const regexes = bySid('jz:regexp', r => [JSON.parse(r.str()), r.str()])
  const fields = list('jz:fields', r => Array.from({ length: r.varint() }, () => {
    const header = r.varint()
    return [header >>> 3, header & 1 ? r.varint() : -1, header & 2 ? r.varint() : 0, header & 4 ? Number(r.str()) : null]
  }))
  const prop = (r) => {
    const t = r.u8()
    return t === 0 ? null : t === 1 ? [null, prop(r)] : t === 3 ? JSON.parse('"' + r.str() + '"') : r.str()
  }
  const schemas = list('jz:schema', r => Array.from({ length: r.varint() }, () => prop(r)))
  return { errorClasses, brands, regexes, fields, schemas, views }
}

/**
 * A module's tables merged into a memory's, on copies, so a rejected module
 * leaves no trace; `instantiate` merges before the module's start function can
 * write into the memory it shares. A pointer carries the schema id its module
 * compiled with, so each schema must bind at that id: modules sharing a memory
 * agree on their ids (one compilation, the same module again) or are refused.
 * The key mirrors module/schema.js: the property list as JSON, salted with the
 * class (the seven Error classes share one list). `_schemaKeyToId` keeps the
 * salted keys across merges; `schemas` stays the plain lists `read` indexes.
 */
const mergeTables = (mem, t) => {
  const errorSidToClass = new Map(mem.errorSidToClass), brandOfSid = new Map(mem.brandOfSid), regexOfSid = new Map(mem.regexOfSid)
  const schemas = [...(mem.schemas || [])], _schemaKeyToId = new Map(mem._schemaKeyToId), fieldContracts = [...(mem.fieldContracts || [])]
  const views = new Set([...(mem.views || []), ...t.views])
  for (const [sid, name] of t.errorClasses) if (!errorSidToClass.has(sid)) errorSidToClass.set(sid, name)
  const keys = t.schemas.map((s, j) => { const salt = t.errorClasses.get(j) ?? t.brands.get(j) ?? (t.regexes.has(j) ? 'RegExp:' + JSON.stringify(t.regexes.get(j)) : null); return JSON.stringify(s) + (salt ? '\x02' + salt : '') })
  keys.forEach((key, j) => {
    let sid = _schemaKeyToId.get(key)
    if (sid === undefined) { _schemaKeyToId.set(key, sid = schemas.length); schemas.push(t.schemas[j]) }
    if (sid !== j) throw new TypeError(`jz: schema ${j} {${t.schemas[j].join(', ')}} of this module binds as schema ${sid} in the memory it shares; modules sharing a memory must bind their schemas at the same ids (compile them together, or give each its own memory)`)
    if (t.brands.has(j)) brandOfSid.set(j, t.brands.get(j))
    if (t.regexes.has(j)) regexOfSid.set(j, t.regexes.get(j))
    const row = t.fields[j]
    if (!row?.length) return
    if (fieldContracts[j] && JSON.stringify(fieldContracts[j]) !== JSON.stringify(row))
      throw new TypeError('jz: incompatible field contracts for a schema already bound to this memory')
    fieldContracts[j] = row
  })
  return { schemas, _schemaKeyToId, errorSidToClass, brandOfSid, regexOfSid, fieldContracts, views }
}

/**
 * A memory with the jz codec on it (`jz.memory`): created from nothing or a
 * descriptor, an existing WebAssembly.Memory enhanced in place, or an instance
 * result's memory bound to its module (allocator, schemas, host references).
 * A module without memory gets a reader of the values its bits carry.
 */
export const memory = (src) => {
  if (src instanceof WebAssembly.Memory && _enhanced.has(src)) return src
  if (!src || (typeof src === 'object' && !(src instanceof WebAssembly.Memory) && !src.instance && !src.exports && !src.memory)) {
    const mem = new WebAssembly.Memory({ initial: src?.initial || 1, ...(src?.maximum ? { maximum: src.maximum } : {}), ...(src?.shared ? { shared: src.shared } : {}) })
    return memory(mem)
  }

  let mem, wasmExports = null, extMap = null, mod = null, symbols
  if (src instanceof WebAssembly.Memory) {
    mem = src
    symbols = symbolsOf(mem, null, null)
  } else {
    // an instance result: { module, instance, exports, extMap }
    const raw = src?.instance?.exports || src?.exports || src
    mem = src?.exports?.memory || raw.memory
    symbols = symbolsOf(src.instance || src, src.module, raw)
    if (!mem) return {
      read: (v, fnOf) => decode(v, fnOf, symbols),
      wrapVal: v => typeof v === 'symbol' ? symbols.write(v) : coerce(v),
      scalar: true,
    }
    wasmExports = { ...raw, memory: mem }
    extMap = src.extMap || null
    mod = src.module || null
  }

  const dv = () => new DataView(mem.buffer)

  const { alloc: jsAlloc, reset: jsReset, initHeapPtr, top, setTop, used, base, markBase } = makeJsAllocator(mem, wasmExports?.__heap)
  const wasmAlloc = wasmExports?._alloc && (bytes => wasmExports._alloc(bytes) >>> 0)
  // No call of the module runs while the host allocates for itself (`_busy`,
  // kept by the call wrappers below): that storage a compaction never moves,
  // its address being the host's to hold, so the pin keeps the floor above it.
  const pinned = (allocate) => (bytes) => { const p = allocate(bytes); if (!mem._busy) { mem._pin = top(); mem._pinSet?.(mem._pin) } return p }
  let alloc = pinned(wasmAlloc || jsAlloc)
  const reset = wasmExports?._clear || jsReset
  initHeapPtr()

  // A block with the module's 16-byte header (`__alloc_hdr`: properties, length,
  // capacity), at its data's offset
  const hdr = (len, cap, bytes) => {
    const raw = alloc(16 + bytes)
    const m = dv()
    m.setBigInt64(raw, 0n, true)
    m.setInt32(raw + 8, len, true)
    m.setInt32(raw + 12, cap, true)
    return raw + 16
  }

  // The module's tables joined to the memory's (rejected before anything
  // changes when the module compiled with other ids), committed as a whole
  Object.assign(mem, mergeTables(mem, mod ? moduleTables(mod) : NO_TABLES))
  if (wasmExports?.__view_data) mem.viewData = wasmExports.__view_data
  if (wasmExports?.__obj_props) mem.objProps = wasmExports.__obj_props
  if (wasmExports?.__obj_deleted) mem.objDeleted = wasmExports.__obj_deleted

  mem._symbols = symbols
  // The compiled reset owns the post-init mark and durable state; a memory of
  // no module rewinds. What the host held by address (views it was handed,
  // class instances) names storage a reset frees.
  const resetAll = () => { mem._views = new WeakMap(); mem._handles = new WeakMap(); mem._instances = new Map(); mem._pin = 0; mem._live = 0; reset(); mem._pinReset?.() }

  // another module in a memory already enhanced: its allocator and reset
  if (_enhanced.has(mem)) {
    if (wasmAlloc) { alloc = pinned(wasmAlloc); mem.alloc = alloc }
    mem.reset = resetAll
    if (extMap) mem._extMap = extMap
    return mem
  }

  mem._extMap = extMap
  // Bytes the heap holds above the mark `memory.reset()` returns to: what calls
  // allocated and kept, and what the host allocated. A host that sees it climb
  // call after call has a leak to fix; a reset returns it to 0.
  Object.defineProperty(mem, 'used', { get: used, configurable: true })
  mem._markBase = markBase
  // What a decoded value names above this address holds the memory of the call that returned it (mem.read).
  mem._above = Infinity
  mem._held = false
  mem._top = top
  mem._setTop = setTop
  mem._base = base
  // Compaction (module/core/compact.js): the floor nothing below moves, raised
  // over what the host made or was handed, and the bytes the last compaction
  // kept, which the next waits to see doubled.
  mem._pin = 0
  mem._live = 0
  mem._calls = 0
  mem._busy = false
  mem._pinAt = 0     // the end of the highest block a decode handed the host as a view or a closure
  mem._fns = 0       // closures decoded, so an object read with its methods is known to carry some

  // Elements staged as i64 bits, never as JS Numbers (an array of NaN-payload
  // doubles may canonicalize them), and committed once all marshal: marshalling
  // can grow the memory, and a failure leaves the destination as it was.
  const staged = (data, wrap) => {
    const n = data.length, source = Object(data), out = new BigInt64Array(n)
    for (let i = 0; i < n; i++) out[i] = i in source ? bits(wrap(source[i], i)) : TOMB_BITS
    return out
  }
  mem.Array = (data) => {
    const n = data.length, off = hdr(n, n, n * 8), cells = staged(data, mem.wrapVal)
    new BigInt64Array(mem.buffer, off, n).set(cells)
    return ptr(1, 0, off)
  }

  mem.String = (str) => {
    if (ssoFits(str)) return encodeSSO(str)
    const n = str.length, raw = alloc(4 + n * 2), m = dv()
    m.setInt32(raw, n, true)
    const off = raw + 4
    for (let i = 0; i < n; i++) m.setUint16(off + i * 2, str.charCodeAt(i), true)
    return ptr(4, 0, off)
  }

  mem.BigInt = (value) => {
    const off = alloc(8)
    dv().setBigInt64(off, BigInt.asIntN(64, value), true)
    return ptr(5, 0, off)
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
    // A view the module left on a host object (`__ext_set`) is the module's own
    // storage, read back as itself.
    if (typeof v === 'object') { const own = mem._views?.get(v) ?? mem._handles?.get(v); if (own !== undefined) return own }
    if (typeof v === 'number') return coerce(v)
    if (typeof v === 'boolean') return v ? TRUE_NAN : FALSE_NAN
    if (typeof v === 'string') return mem.String(v)
    if (typeof v === 'symbol') return mem._symbols.write(v)
    // A BigInt that is a box (memory.String, memory.BigInt) is itself. A plain
    // one has no BigInt evidence here (an export's slots consult jz:hostabi):
    // refused, where a decimal string would read as a wrong number.
    if (typeof v === 'bigint') {
      if (isBox(v)) return v
      throw new TypeError(`jz: plain BigInt ${v}n passed to memory marshaling (memory.Array/memory.Object/memory.Hash/a host-import return/…) with no BigInt evidence — box it explicitly: mem.BigInt(${v}n)`)
    }
    if (Array.isArray(v)) return mem.Array(v)
    if (v instanceof ArrayBuffer) return mem.Buffer(v)
    if (v instanceof DataView) {
      const parent = offset(mem.Buffer(v.buffer)), off = alloc(16), m = dv()
      m.setInt32(off, v.byteLength, true)
      m.setInt32(off + 4, parent + v.byteOffset, true)
      m.setInt32(off + 8, parent, true)
      return ptr(3, DATA_VIEW_AUX, off)
    }
    const typedName = v?.constructor?.name
    // A BigInt, f16 or clamped array has no proof here that the module reads
    // that element kind (a program that makes one inside keeps it)
    if (typedName === 'BigInt64Array' || typedName === 'BigUint64Array' ||
        typedName === 'Float16Array' || typedName === 'Uint8ClampedArray')
      throw new TypeError(`jz: host ${typedName} at an untyped boundary is not supported — construct it inside the compiled source so its element storage policy is provable`)
    if (KINDS[typedName]) return mem[typedName](v)
    if (typeof v === 'object' || typeof v === 'function') return mem.External(v)
    return UNDEF_NAN
  }

  mem.External = function(obj) {
    if (obj === null || obj === undefined) return coerce(obj)
    return mem._extMap ? external(mem._extMap, obj) : UNDEF_NAN
  }

  // A plain object no compiled schema fits, as the module's own dictionary
  // (module/collection.js: [seq<<32|hash][key][value] × cap, linear probe, then
  // the hash lane), so every dynamic operation runs natively on it. The hashes
  // are __str_hash's, or a probe starts at the wrong slot.
  const clampHash = (h) => ((h >>> 0) <= 1 ? (h + 2) | 0 : h)
  const jzStrHash = (box) => {
    const b = bits(box)
    if (type(b) === PTR.ATOM) return (Math.imul(aux(b) ^ offset(b), 0x9E3779B9) | 2) >>> 0
    if ((b >> 32n) & BigInt(LAYOUT.SSO_BIT)) {   // SSO: fixed-cost mix over payload
      const lo = Number(b & 0xFFFFFFFFn) | 0
      const hi = Number((b >> 32n) & 0x1FFFn) | 0
      let h = Math.imul(hi ^ 0x9E3779B9, 0x85EBCA6B)
      h = Math.imul(lo ^ h, 0xC2B2AE35)
      h = (h ^ (h >>> 15)) | 0
      return clampHash(h) >>> 0
    }
    const off = Number(b & 0xFFFFFFFFn), m = dv()
    const len = m.getInt32(off - 4, true)
    let h = 0x811c9dc5 | 0
    for (let i = 0; i < len; i++) h = Math.imul(h ^ m.getUint16(off + i * 2, true), 0x01000193) | 0
    return clampHash(h) >>> 0
  }
  mem.Hash = function(obj) {
    if (obj == null) throw new TypeError('Cannot convert undefined or null to object')
    const entries = [], source = Object(obj)
    for (const key of Reflect.ownKeys(source))
      if (Object.prototype.propertyIsEnumerable.call(source, key)) entries.push([key, source[key]])
    let cap = 8
    while (entries.length * 4 >= cap * 3) cap <<= 1   // stay under the 75% grow trigger
    const off = hdr(entries.length, cap, cap * 28)
    const slots = new BigInt64Array(cap * 3), lane = new Int32Array(cap)   // as i64 bits, an empty slot 0
    entries.forEach(([k, v], seq) => {
      const keyBox = typeof k === 'symbol' ? mem._symbols.write(k) : mem.String(k)
      const h = jzStrHash(keyBox)
      let idx = h & (cap - 1)
      while (slots[idx * 3] !== 0n) idx = (idx + 1) & (cap - 1)
      slots[idx * 3] = (BigInt(seq) << 32n) | BigInt(h >>> 0)
      slots[idx * 3 + 1] = bits(keyBox)
      slots[idx * 3 + 2] = bits(mem.wrapVal(v))
      lane[idx] = h | 0
    })
    new BigInt64Array(mem.buffer, off, cap * 3).set(slots)
    new Int32Array(mem.buffer, off + cap * 24, cap).set(lane)
    return ptr(7, 0, off)
  }

  // Plain compiler-emitted data governs every structured ingress and update.
  // Check the marshalled representation too: same JS constructor is not enough
  // when a view descriptor or a different nested schema changes the layout.
  const wrapField = (sid, i, value) => {
    const rule = mem.fieldContracts[sid]?.[i]
    if (rule?.[2] === 8) throw new TypeError('jz: field ' + mem.schemas[sid][i] + ' has ambiguous raw BigInt storage; use distinct object shapes')
    let wrapped = rule && (rule[0] & (1 << PTR.OBJECT)) && value?.constructor === Object
      ? mem.Object(value)
      : rule && (rule[0] & (1 << PTR.TYPED)) && ArrayBuffer.isView(value) && KINDS[value.constructor.name]
        ? mem[value.constructor.name](value) : mem.wrapVal(value)
    if (!rule) return wrapped
    const [mask, detail, integer, constant] = rule
    if (detail >= 0 && (mask & (1 << PTR.TYPED)) && typeof wrapped === 'bigint' && type(wrapped) === PTR.TYPED &&
        (aux(wrapped) & ~TYPED_ELEM_VIEW_FLAG) === (detail & ~TYPED_ELEM_VIEW_FLAG) && aux(wrapped) !== detail) {
      if (detail & TYPED_ELEM_VIEW_FLAG) {
        const data = offset(wrapped), length = dv().getUint32(data - 8, true), descriptor = alloc(16), view = dv()
        view.setUint32(descriptor, length, true)
        view.setUint32(descriptor + 4, data, true)
        view.setUint32(descriptor + 8, data, true)
        wrapped = ptr(PTR.TYPED, detail, descriptor)
      } else wrapped = mem.wrapVal(mem.read(wrapped))
    }
    let family = typeof value === 'boolean' ? FIELD.BOOL : FIELD.NUMBER
    if (typeof wrapped === 'bigint' && isBox(wrapped)) {
      const t = type(wrapped), a = aux(wrapped)
      family = t === PTR.ATOM ? (a === ATOM.NULL || a === ATOM.UNDEF ? FIELD.NULLISH : a === ATOM.FALSE || a === ATOM.TRUE ? FIELD.BOOL : a >= SYMBOL_MIN ? 1 << PTR.ATOM : FIELD.NUMBER) : 1 << t
    }
    const nested = family === (1 << PTR.OBJECT), typed = family === (1 << PTR.TYPED)
    const badDetail = (nested || typed) && detail >= 0 && aux(wrapped) !== detail
    const badNumber = family === FIELD.NUMBER && ((integer && (!Number.isInteger(value) || Object.is(value, -0))) ||
      (integer === 2 && (value < -2147483648 || value > 2147483647)) || (constant !== null && !Object.is(value, constant)))
    if (!(mask & family) || badDetail || badNumber)
      throw new TypeError(`jz: field ${mem.schemas[sid][i]} violates its compiled representation contract${constant !== null ? ': expected discriminant ' + constant : (mask & (1 << PTR.TYPED)) && detail >= 0 ? ': expected ' + (ctorFromElemAux(detail) || 'DataView') : integer === 2 ? ': expected an int32 without negative zero' : ''}`)
    return integer === 4 ? dv().getBigInt64(offset(wrapped), true) : wrapped
  }

  mem.Object = function(obj) {
    const objKeys = Object.keys(obj)
    const key = objKeys.join(',')
    const schemas = mem.schemas
    // The shapes with these keys in this order, else in any order; among
    // several, a plain object is the plain shape's, not a class's (two
    // classes of one field list are told apart by brand, which a plain
    // object does not carry).
    const pick = (matches) => {
      if (matches.length <= 1) return matches[0] ?? -1
      const plain = matches.filter(i => !mem.brandOfSid.has(i))
      return plain.length === 1 ? plain[0] : -2
    }
    let matches = schemas.reduce((a, s, i) => (!mem.regexOfSid.has(i) && s.join(',') === key ? a.concat(i) : a), [])
    if (!matches.length) matches = schemas.reduce((a, s, i) =>
      (!mem.regexOfSid.has(i) && s.length === objKeys.length && objKeys.every(k => s.includes(k)) ? a.concat(i) : a), [])
    const sid = pick(matches)
    if (sid === -2) throw Error(`Ambiguous schema for {${key}} — ${matches.length} compiled shapes match this key set; pass keys in one of these orders: ${matches.map(i => schemas[i].join(',')).join(' | ')}`)
    if (sid === -1) return mem.Hash(obj)   // no compiled schema: first-class hash (External loses nested-mutation identity)
    const schema = schemas[sid], raw = alloc(schema.length * 8), slots = schema.map((k, i) => bits(wrapField(sid, i, obj[k])))
    new BigInt64Array(mem.buffer, raw, slots.length).set(slots)
    return ptr(6, sid, raw)
  }

  // The live entries of a HASH (7), SET (8) or MAP (9) at `off` in insertion
  // order, as __coll_order walks them: a durable-heap tombstone is no key.
  // A pair: its key and value read.
  const liveSlots = (off, t) => {
    const m = dv(), cap = m.getInt32(off - 4, true), stride = t === 8 ? 16 : 24, slots = []
    for (let i = 0; i < cap; i++) {
      const slot = off + i * stride, hash = m.getBigUint64(slot, true)
      if (hash && (t !== 7 || Number(hash >> 32n) !== HIDDEN_PROPERTY_SEQ) && m.getBigUint64(slot + 8, true) !== 0x7FF87FFFFFFFFFFFn)
        slots.push([Number(hash >> 32n), slot])
    }
    return slots.sort((a, b) => a[0] - b[0]).map(([, slot]) => slot)
  }
  const pairs = (off, t, fnOf) => { const m = dv(); return liveSlots(off, t).map(slot => [mem.read(m.getBigInt64(slot + 8, true), fnOf), mem.read(m.getBigInt64(slot + 16, true), fnOf)]) }

  // The heap below the end of what the host was handed by address never moves (`settle`)
  const pinAt = (end) => { mem._pinAt = Math.max(mem._pinAt, end); mem._pinSet?.(mem._pinAt) }
  const blockEnd = (m, off) => off + 8 * m.getInt32(off - 4, true)

  // The value an object's slot `i` holds, by its field's compiled contract.
  const slotValue = (sid, off, i, fnOf) => {
    const rule = mem.fieldContracts[sid]?.[i], raw = dv().getBigInt64(off + i * 8, true)
    if (rule?.[2] === 8) throw new TypeError('jz: field ' + mem.schemas[sid][i] + ' has ambiguous raw BigInt storage; use distinct object shapes')
    const value = rule?.[2] === 4 ? raw : mem.read(raw, fnOf)
    return value != null && rule && (rule[0] & ~FIELD.NULLISH) === FIELD.BOOL ? !!value : value
  }

  // A class instance the host holds (an exported class's, wrap's `jz:class`):
  // one host object per instance, of the class's prototype, whose fields read
  // and write the instance's slots as they stand. Handed back to the module it
  // is the instance (`wrapVal`). The host holds it by address, so the heap below
  // it never moves, and a call that made it keeps what it allocated. A private
  // field (`#x`) stays inside.
  mem.handle = (p, proto, fnOf) => {
    const off = offset(p), sid = aux(p)
    const known = mem._instances.get(off)?.deref()
    if (known !== undefined && mem._handles.get(known) === p) return known
    const end = blockEnd(dv(), off)
    if (off >= mem._above) mem._held = true
    else mem._pin = Math.max(mem._pin, end)
    pinAt(end)
    const obj = Object.create(proto), keys = mem.schemas[sid]
    for (let i = 0; i < keys.length; i++) {
      if (typeof keys[i] !== 'string' || keys[i][0] === '#') continue
      Object.defineProperty(obj, keys[i], { enumerable: true, configurable: true,
        get: () => slotValue(sid, off, i, fnOf),
        set: (v) => { const b = bits(wrapField(sid, i, v)); dv().setBigInt64(off + i * 8, b, true) } })
    }
    mem._handles.set(obj, p)
    mem._instances.set(off, new WeakRef(obj))
    return obj
  }

  // A value from its bits. `fnOf` (wrap's, per instance) reads a closure as a
  // function calling it. What the host is handed by address marks the call
  // that returned it as holding its memory (`_held`, above the call's mark).
  mem.read = function(p, fnOf = null) {
    if (Array.isArray(p)) return p.map(v => mem.read(v, fnOf))  // a tuple of results
    if (typeof p === 'number') {
      if (p === p) return p
      p = f64ToI64(p)                    // a legacy f64 box
    } else if (typeof p !== 'bigint') return p   // already a JS value
    if (!isBox(p)) return i64ToF64(p)
    const m = dv(), t = type(p), a = aux(p)
    let off = offset(p)
    if (t === PTR.ATOM && a >= SYMBOL_MIN && p !== TOMB_BITS) return mem._symbols.read(p)
    // Arrays and collections retain their identity when storage grows.
    if (t === 1 || t >= 7 && t <= 9) off = forward(m, off)
    if (t === 0 && off === 0) {
      if (a === 0) return NaN
      if (a === 1) return null
      if (a === 2) return undefined
      if (a === 4) return false
      if (a === 5) return true
    }
    if (t === 11 && mem._extMap) return mem._extMap[off]
    if (t === 10 && typeof fnOf === 'function') {
      if (off >= mem._above) { mem._held = true; mem._fns++; if (off >= 16) pinAt(blockEnd(m, off)) }
      return fnOf(p)
    }
    if (t === 1) {  // ARRAY
      const len = m.getInt32(off - 8, true), out = new Array(len)
      // an array of raw Numbers (aux ARRAY_RAW): every element a number, none a box or a hole
      if (a & ARRAY_RAW) { for (let i = 0; i < len; i++) out[i] = m.getFloat64(off + i * 8, true); return out }
      for (let i = 0; i < len; i++) {
        const value = m.getBigInt64(off + i * 8, true)
        if (value !== TOMB_BITS) out[i] = mem.read(value, fnOf)
      }
      return out
    }
    if (t === 3) {  // TYPED: a view of the module's memory, its bytes held
      const held = (at, bytes) => { mem._viewSet?.(); if (at >= mem._above) { mem._held = true; pinAt(at + bytes) } return at }
      // a view's bytes: its descriptor's length, or what a resizable buffer now bounds ($__view_bytes)
      const viewBytes = () => {
        const n = m.getInt32(off, true), root = m.getInt32(off + 8, true)
        if (root < 16 || m.getBigInt64(root - 16, true) !== BigInt(RESIZABLE_MARK)) return n
        const len = m.getInt32(root - 8, true), at = m.getInt32(off + 4, true) - root
        return m.getInt32(off + 12, true) ? (at <= len ? len - at : 0) : (at + n <= len ? n : 0)
      }
      if (a & DATA_VIEW_FLAG) { const n = viewBytes(); return new DataView(mem.buffer, held(m.getInt32(off + 4, true), n), n) }
      const kind = kindOfAux(a), { stride } = kind, Ctor = ctorOf(kind)
      if (!Ctor) throw new Error('decoding a Float16Array result needs a host with Float16Array (Node ≥ 24 / modern browsers)')
      if (a & TYPED_ELEM_VIEW_FLAG) {
        const byteLen = viewBytes(), dataOff = m.getInt32(off + 4, true)
        return new Ctor(mem.buffer, held(dataOff, byteLen), Math.floor(byteLen / stride))
      }
      const byteLen = m.getInt32(off - 8, true)
      return new Ctor(mem.buffer, held(off, byteLen), byteLen / stride)
    }
    if (t === 2) {  // BUFFER
      // a copy, resizable to the same maximum where the module's is (layout.js RESIZABLE_MARK)
      const byteLen = m.getInt32(off - 8, true)
      const out = off >= 16 && m.getBigInt64(off - 16, true) === BigInt(RESIZABLE_MARK)
        ? new ArrayBuffer(byteLen, { maxByteLength: m.getInt32(off - 4, true) }) : new ArrayBuffer(byteLen)
      new Uint8Array(out).set(new Uint8Array(mem.buffer, off, byteLen))
      return out
    }
    if (t === 4) {  // STRING (aux SSO_BIT = inline, else heap)
      if (a & LAYOUT.SSO_BIT) return decodeSSO(p)
      const len = a & LAYOUT.SLICE_BIT ? a & LAYOUT.SLICE_LEN_MASK : m.getUint32(off - 4, true)
      const chunks = []
      for (let i = 0; i < len; i += 4096) {
        const n = Math.min(4096, len - i), units = new Array(n)
        for (let j = 0; j < n; j++) units[j] = m.getUint16(off + (i + j) * 2, true)
        chunks.push(String.fromCharCode(...units))
      }
      return chunks.join('')
    }
    if (t === 5) return m.getBigInt64(off, true)  // BIGINT
    if (t === 6) {  // OBJECT
      const keys = mem.schemas[a], fns = mem._fns
      // an instance of a class the module exports: the host's handle on it,
      // even where its layout hides a slot (a private name's) from the copy below
      const proto = keys && fnOf?.classes?.get(a)
      if (proto) return mem.handle(p, proto, fnOf)
      // an object literal with an accessor reads through it: the module copies its data
      if (mem.views?.has(a) && mem.viewData && !mem.errorSidToClass?.has(a) && !mem.regexOfSid?.has(a)) return mem.read(mem.viewData(p), fnOf)
      if (!keys) { if (off >= mem._above) mem._held = true; return p }
      const re = mem.regexOfSid?.get(a), obj = re ? new RegExp(re[0], re[1]) : {}
      // a deleted slot's bit (layout.js deletedSlotWat; from 31 on one bit for the undefined ones)
      const mask = mem.objDeleted ? mem.objDeleted(p) : 0
      for (let i = 0; i < keys.length; i++) {
        if (mask && (i < 31 ? (mask >>> i) & 1 : (mask >>> 31) & 1 && m.getBigInt64(off + i * 8, true) === UNDEF_NAN)) continue
        obj[keys[i]] = slotValue(a, off, i, fnOf)
      }
      // properties stored outside the layout: its header's dictionary, then the
      // durable one by its offset (__obj_props), a later value replacing in place
      if (mem.objProps) for (const which of [0, 1]) {
        const d = mem.objProps(p, which)
        if (d) for (const [key, value] of pairs(forward(dv(), offset(d)), 7, fnOf)) obj[key] = value
      }
      fnOf?.owners.set(obj, p)
      if (fnOf && mem._fns !== fns && off >= mem._above) pinAt(blockEnd(m, off))
      return obj
    }
    if (t >= 7 && t <= 9) {  // HASH / SET / MAP share the insertion sequence.
      if (t === 8) return new Set(liveSlots(off, t).map(slot => mem.read(m.getBigInt64(slot + 8, true), fnOf)))
      const entries = pairs(off, t, fnOf)
      if (t !== 7) return new Map(entries)
      const out = Object.fromEntries(entries)
      fnOf?.owners.set(out, p)
      return out
    }
    // a handle on the module's memory is held as a view is
    if (t !== 0 && off >= mem._above) mem._held = true
    return i64ToF64(p)  // the canonical NaN, a closure without a reader
  }

  mem.write = function(p, data) {
    const t = type(p)
    let off = offset(p), m = dv()
    if (t === 1) {
      off = forward(m, off)
      const cap = m.getInt32(off - 4, true), length = data.length
      if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('mem.write: invalid array length')
      if (length > cap) throw Error(`mem.write: ${data.length} elements exceeds this array's capacity of ${cap} — allocate it with a larger capacity, or write ${cap} or fewer elements`)
      const cells = staged(data, mem.wrapVal)   // before the view: marshalling may grow the memory
      new BigInt64Array(mem.buffer, off, length).set(cells)
      dv().setInt32(off - 8, length, true)
    } else if (t === 3) {
      const a2 = aux(p), { stride, set: setter } = kindOfAux(a2)
      const byteLen = data.length * stride
      if (a2 & TYPED_ELEM_VIEW_FLAG) {
        const viewByteLen = m.getInt32(off, true)
        if (byteLen > viewByteLen) throw Error(`mem.write: ${byteLen} bytes exceeds this typed array view's size of ${viewByteLen} bytes — allocate a larger view, or write fewer elements`)
        off = m.getInt32(off + 4, true)
      } else {
        const byteCap = m.getInt32(off - 4, true)
        if (byteLen > byteCap) throw Error(`mem.write: ${byteLen} bytes exceeds this typed array's capacity of ${byteCap} bytes — allocate it with a larger capacity, or write fewer elements`)
        m.setInt32(off - 8, byteLen, true)
      }
      for (let i = 0; i < data.length; i++) m[setter](off + i * stride, data[i], true)
    } else if (t === 6) {
      const schema = mem.schemas[aux(p)]
      if (!schema) throw Error(`mem.write: this pointer's schema id (${aux(p)}) has no compiled OBJECT schema — write to a pointer returned by mem.Object() for a schema this program compiled`)
      const slots = []
      for (const k of Object.keys(data)) {
        const i = schema.indexOf(k)
        if (i >= 0) slots.push([i, bits(wrapField(aux(p), i, data[k]))])
      }
      m = dv()
      for (const [i, value] of slots) m.setBigInt64(off + i * 8, value, true)
    } else {
      throw Error(`mem.write only supports ARRAY, TYPED array, and OBJECT pointers — this pointer is a different kind (type tag ${t})`)
    }
  }

  mem.alloc = alloc
  // the views the module left on host objects (`__ext_set`); the class instances
  // the host holds (`mem.handle`) by their host object, and those by address
  mem._views = new WeakMap()
  mem._handles = new WeakMap()
  mem._instances = new Map()
  mem.reset = resetAll

  // memory.Float64Array(data) and its kin: the elements converted to the kind
  // first (a view of this growable memory snapshotted), then copied in one
  // `set`. BigInt kinds and a host without Float16Array write element by element.
  for (const kind of Object.values(KINDS)) {
    const { name, code, stride, set } = kind, C = code & 16 ? null : ctorOf(kind)
    mem[name] = (data) => {
      if (C && (!(data instanceof C) || data.buffer === mem.buffer)) data = new C(data)
      const n = data.length, bytes = n * stride, off = hdr(bytes, bytes, bytes)
      if (C) new C(mem.buffer, off, n).set(data)
      else { const m = dv(); for (let i = 0; i < n; i++) m[set](off + i * stride, data[i], true) }
      return ptr(3, code, off)
    }
  }

  // A typed array of n elements in the module's memory: the `view` the host fills
  // and the `box` an export reads in place. A grow detaches the view (re-read it
  // from the box), a reset frees it; a shared memory keeps it across grows.
  mem.allocTyped = (Ctor, n) => {
    const kind = KINDS[Ctor?.name]
    if (!kind) throw Error(`mem.allocTyped: ${Ctor?.name ?? Ctor} is not a supported typed array constructor — pass one of ${Object.keys(KINDS).join(', ')}`)
    const bytes = n * kind.stride, off = hdr(bytes, bytes, bytes)
    mem._viewSet?.()
    return { view: new Ctor(mem.buffer, off, n), box: ptr(3, kind.code, off) }
  }

  _enhanced.add(mem)
  return mem
}

/**
 * Adapt raw exports to the JS calling convention: arguments marshalled in by
 * their compiled lanes, results decoded, throws decoded, the call's heap
 * released. `src` is an instance result ({ module, instance, exports }).
 */
export const wrap = (src, state) => {
  const mod = src.module || src, realInst = src.instance || src
  // A JSON section's entries by export name
  const byName = (name, entry) => new Map((jsonSection(mod, name) || []).map(e => [e.name, entry(e)]))
  const set = (xs) => new Set(xs || [])
  // jz:rest: the exports with a rest parameter, by their count of fixed ones
  const restFuncs = new Map((jsonSection(mod, 'jz:rest') || []).map(e => typeof e === 'string' ? [e, 0] : [e.name, e.fixed]))
  // jz:extparam: the slots that take an externref (a js-string), passed as they
  // are, with the default a missing one takes (`def`, by slot)
  const extExp = byName('jz:extparam', e => Object.assign(new Set(e.p), e.d && { def: new Map(Object.entries(e.d).map(([k, v]) => [Number(k), v])) }))
  // jz:i64exp: the slots that ride the i64 lane (`p`), a result decoded as a
  // tagged value (`r`), typed slots (`t`) and those the body stores into and
  // reads back (`k`), the variants of other kinds (`v`)
  const i64Exp = byName('jz:i64exp', e => ({ p: set(e.p), r: !!e.r, t: e.t || null, k: set(e.k), v: e.v || null }))
  // jz:hostabi, the BigInt policy of each slot (src/compile/index.js): `raw` an
  // always-BigInt slot passed unboxed, `tag` a maybe-BigInt slot a BigInt is
  // boxed at (`val`: whatever its bits, the parameter read only as a value),
  // `rest` the rest elements' evidence. A BigInt at a slot of neither has no
  // evidence and is refused. `skip`: slots the body never reads, which cross
  // unconverted, keeping undefined for a default.
  const hostAbiExp = byName('jz:hostabi', e => ({ raw: set(e.raw), tag: set(e.tag), val: set(e.val), skip: set(e.skip), rest: !!e.rest }))
  // jz:release (optimize/arena-rewind.js): the exports whose calls keep nothing
  // they allocate or are handed, rewound to the mark before their arguments;
  // `flag` those released only when no escape ran, `host` those whose frame
  // releases nothing by itself, `ask` those whose heap result is released once
  // copied, `number` those released when the result is a Number.
  const release = jsonSection(mod, 'jz:release') || {}, number = set(release.number)
  const releases = set([...release.release ?? [], ...number]), flagged = set(release.flag)
  const hostReleased = set([...release.host ?? [], ...release.ask ?? [], ...number]), numberResult = number
  // jz:values: the exports of value bindings (`export const K = 'abc'`,
  // `export let n`), each a function returning the binding's current value,
  // read as an accessor: a live binding the host cannot write, as an ES module's
  const values = jsonSection(mod, 'jz:values')
  const liveValues = (exports) => {
    if (values) for (const name of values)
      if (typeof exports[name] === 'function') Object.defineProperty(exports, name, { get: exports[name], enumerable: true, configurable: false })
    return exports
  }
  const esc = realInst.exports.__esc, setBase = realInst.exports.__base, survive = realInst.exports.__survive
  const compact = realInst.exports.__compact, pinGlobal = realInst.exports.__pin, cost = realInst.exports.__g_cost, viewed = realInst.exports.__viewed
  const mem = memory(src)
  // The module's pin (module/core/compact.js `__pin`): the heap below the
  // highest block the host holds by address never moves, in a compaction the
  // host asks for or one a loop runs inside a call. Raised as values decode.
  if (pinGlobal && mem) { mem._pinSet = (at) => { if (at > (pinGlobal.value >>> 0)) pinGlobal.value = at | 0 }; mem._pinReset = () => { pinGlobal.value = 0; if (viewed) viewed.value = 0 } }
  // A view the host holds detaches as the memory grows: once one is handed
  // out, a compaction finds its scratch in the memory as it stands or
  // declines (`__viewed`, module/core/stub-log.js), as the program's own
  // allocations alone grow it. The buffer the view shows marks how long:
  // once the program's allocation grew the memory past it (`settle`).
  if (viewed && mem) mem._viewSet = () => { viewed.value = 1; mem._viewBuf = mem.buffer }
  // An async program exports __mt_drain, __p_state and __p_value (`jz:async`):
  // each export call ends a turn (the microtasks drain) and a promise result
  // becomes a host Promise, a pending one settled by the after-tick sweep.
  const mtDrain = realInst.exports.__mt_drain
  const pState = realInst.exports.__p_state
  const pValue = realInst.exports.__p_value
  const asyncMod = !!(mtDrain && pState && pValue)
  const pending = []
  // a promise reader called on its own lanes (jz:i64exp)
  const pcall = (fn, name, raw) => {
    const lane = i64Exp.get(name)
    return fn(typeof raw === 'bigint' ? (lane?.p?.has(0) ? raw : i64ToF64(raw)) : (lane?.p?.has(0) ? bits(raw) : raw))
  }
  const pStateOf = (raw) => {
    const r = pcall(pState, '__p_state', raw)
    return typeof r === 'bigint' ? i64ToF64(r) : r
  }
  const readSettled = (raw) => {
    const v = pcall(pValue, '__p_value', raw)
    return mem ? readRet(v) : decode(v)
  }
  const sweep = () => {
    mtDrain()
    for (let i = pending.length - 1; i >= 0; i--) {
      const e = pending[i]
      const st = pStateOf(e.raw)
      if (st < 1) continue
      pending.splice(i, 1)
      st === 1 ? e.resolve(readSettled(e.raw)) : e.reject(readSettled(e.raw))
    }
  }
  const adopt = (raw, read) => {
    mtDrain()
    const st = pStateOf(raw)
    if (st < 0) return read(raw)                    // not a promise — plain value
    if (st === 1) return Promise.resolve(readSettled(raw))
    if (st === 2) return Promise.reject(readSettled(raw))
    return new Promise((resolve, reject) => pending.push({ raw, resolve, reject }))
  }
  if (asyncMod && state) {
    state.afterTick = sweep
    // a thenable a host import returns becomes the module's promise
    const mk = realInst.exports.__p_make, fin = realInst.exports.__p_finish
    if (mk && fin) {
      const lanes = i64Exp.get('__p_finish')
      state.pmake = () => mk()
      state.pfinish = (praw, st, vbits) => fin(
        lanes?.p?.has(0) ? (typeof praw === 'bigint' ? praw : bits(praw)) : (typeof praw === 'bigint' ? i64ToF64(praw) : praw),
        lanes?.p?.has(1) ? f64ToI64(st) : st,
        lanes?.p?.has(2) ? vbits : i64ToF64(vbits))
    }
  }
  const finishRet = (raw, read) => asyncMod ? adopt(raw, read) : read(raw)
  // A result that is one of the written arguments is that argument: an
  // in-place kernel's `return out` hands the caller its own array.
  const hostOf = (writeBack, raw) => {
    if (typeof raw === 'bigint') for (const [back, b] of writeBack) if (b === raw && back.to) return back.to
  }
  // The Error class an object's schema id names (jz:errcls), for a result or
  // a throw: an object pointer's sid, which no source write can forge. A
  // returned Error, or each of a tuple's, is the host's Error of that class.
  const errorSidClassOf = (raw) => {
    const b = typeof raw === 'bigint' ? raw : typeof raw === 'number' && raw !== raw ? f64ToI64(raw) : null
    return b != null && isBox(b) && type(b) === 6 ? (mem.errorSidToClass?.get(aux(b)) ?? null) : null
  }
  const readRet = (r) => {
    if (Array.isArray(r)) return r.map(readRet)
    const decoded = mem.read(r, fnOf)
    const errClassName = errorSidClassOf(r)
    return errClassName != null ? new (globalThis[errClassName] ?? Error)(decoded.message) : decoded
  }
  // an export's result: one crossing as a Number is a Number (numberRet), a closure's is any value
  const exportRet = (r) => typeof r === 'number' ? numberRet(r) : readRet(r)
  // The thrown value's bits (`__jz_last_err_bits`), consumed at each decode so a
  // later foreign trap cannot read a stale one. The optimizer makes the global
  // immutable where nothing writes it, and a write to it then throws: probed once.
  const lastErrBits = realInst.exports.__jz_last_err_bits
  let lastErrBitsWritable = false
  if (lastErrBits) { try { lastErrBits.value = lastErrBits.value; lastErrBitsWritable = true } catch {} }
  const decodeThrown = error => {
    // A module without exception handling traps where it throws, having marked
    // the value: a trap with no mark is a foreign one (bounds, stack), as it is.
    const isException = error instanceof WebAssembly.Exception
    if (!lastErrBits || !isException && !(error instanceof WebAssembly.RuntimeError && lastErrBits.value !== 0n)) throw error
    const errBits = lastErrBits.value
    if (lastErrBitsWritable) lastErrBits.value = 0n
    // An internal error crosses as its code (err-codes.js), which only the
    // private transport tag marks: a user's number stays a thrown number.
    const code = Number(errBits >> 32n) === ERROR_CODE_HI ? Number(errBits & 0xffffffffn) : null
    const info = code == null ? undefined : ERR_INFO[code]
    const value = code == null ? (mem ? mem.read(errBits) : decode(errBits)) : code
    if (value instanceof Error) throw value
    // A jz Error object decodes as {message, name}: its class is its sid.
    const errClassName = mem && value != null ? errorSidClassOf(errBits) : null
    const wrapped = errClassName != null ? new (globalThis[errClassName] ?? Error)(value.message)
      : info ? new (globalThis[info.name] ?? Error)(info.message)
      : new Error(typeof value === 'string' ? value : String(value))
    wrapped.cause = error
    wrapped.thrown = value
    if (state?.inHost) (state.caught ??= new WeakMap()).set(wrapped, errBits)
    throw wrapped
  }
  // A closure the host holds reads as a function calling it through the
  // module's trampoline as an export call runs; called as a method of an object
  // read from the module it takes that object as `this`. Arguments past the
  // inline lanes spill into an array.
  const callClosure = mem ? realInst.exports.__call_closure : null
  const classes = mem && !mem.scalar ? jsonSection(mod, 'jz:class') : null
  const lanes = callClosure ? callClosure.length - 4 : 0
  const closureArg = (v) => typeof v === 'bigint' && !isBox(v) && mem.BigInt ? mem.BigInt(v) : numberArg(v)
  // It releases nothing, as an export without `jz:release`.
  const fnOf = callClosure ? Object.assign((clos) => function (...args) {
    const mark = mem.scalar ? null : enter(false)
    let returned = false
    try {
      const n = args.length, a = new Array(lanes)
      for (let i = 0; i < lanes; i++) a[i] = i < n ? bits(mem.wrapVal(closureArg(args[i]))) : UNDEF_NAN
      const spill = n > lanes && mem.Array ? offset(mem.Array(args.map((v, i) => i < lanes ? undefined : closureArg(v)))) : 0
      if (lastErrBitsWritable) lastErrBits.value = 0n
      const ret = callClosure(clos, n, spill, fnOf.owners.get(this) ?? UNDEF_NAN, ...a)
      returned = true
      return finishRet(ret, readRet)
    } catch (error) {
      decodeThrown(error)
    } finally { if (mark) leave(mark, false, false, returned) }
  }, { owners: new WeakMap(), classes: null }) : classes ? { owners: new WeakMap(), classes: null } : null
  if (state) state.fnOf = fnOf
  const exports = {}
  // A call that crosses as it is: every slot a number, so the engine's ToNumber
  // is all the marshalling. A BigInt argument takes the general path, a result
  // that is no number its decoding (`settle`). Written out by arity so the call
  // allocates nothing; `begin` answers whether it may cross so (not inside
  // another call), `end` runs after it, a throw included.
  const plainLanes = (ie, ext, hostAbi) => !ext && !(hostAbi && (hostAbi.raw.size || hostAbi.tag.size || hostAbi.rest)) && !(ie && (ie.p.size || ie.t || ie.v))
  const crossing = (fn, general, settle, begin, end, skip) => {
    const big = (x) => typeof x === 'bigint'
    const out = (r) => (typeof r === 'number' && r === r) || r === undefined ? r : settle(r)
    const skip0 = skip?.has(0), skip1 = skip?.has(1), skip2 = skip?.has(2)
    switch (fn.length) {
      case 0: return () => {
        if (!begin()) return general()
        let threw = false
        try { return out(fn()) } catch (e) { threw = true; decodeThrown(e) } finally { end(threw) }
      }
      case 1: return (a) => {
        if (skip0 && a !== undefined) a = 0
        a = numberArg(a)
        if (big(a) || !begin()) return general(a)
        let threw = false
        try { return out(fn(a)) } catch (e) { threw = true; decodeThrown(e) } finally { end(threw) }
      }
      case 2: return (a, b) => {
        if (skip0 && a !== undefined) a = 0
        if (skip1 && b !== undefined) b = 0
        a = numberArg(a); b = numberArg(b)
        if (big(a) || big(b) || !begin()) return general(a, b)
        let threw = false
        try { return out(fn(a, b)) } catch (e) { threw = true; decodeThrown(e) } finally { end(threw) }
      }
      case 3: return (a, b, c) => {
        if (skip0 && a !== undefined) a = 0
        if (skip1 && b !== undefined) b = 0
        if (skip2 && c !== undefined) c = 0
        a = numberArg(a); b = numberArg(b); c = numberArg(c)
        if (big(a) || big(b) || big(c) || !begin()) return general(a, b, c)
        let threw = false
        try { return out(fn(a, b, c)) } catch (e) { threw = true; decodeThrown(e) } finally { end(threw) }
      }
      default: return general
    }
  }
  const always = () => true, idle = () => {}
  // One argument by its slot's lane: an externref slot as it is (its default
  // where missing), an f64 slot as the engine converts it, an i64 slot as its
  // box's bits (`coerce` without memory, `mem.wrapVal` with), typed slots
  // converted to their kind and, where the body writes them, copied back.
  const noEvidence = (i, name) => { throw new TypeError(`jz: BigInt argument at param ${i} of ${name}() has no BigInt evidence in the compiled program — give the parameter a provable BigInt path (it then takes the tagged ingress), or pass a decimal string to a typeof-guarded normalizing parameter`) }
  const i64Arg = (ie, ext, box, hostAbi, name, writeBack, shared = writeBack && new Map()) => (x, i) => {
    // An unused slot still distinguishes missing/undefined for its default.
    // No read means no ToNumber, boxing, getter or backing-store copy is due.
    if (hostAbi?.skip.has(i)) return ie?.p.has(i) ? x === undefined ? UNDEF_NAN : 0n : x === undefined ? undefined : 0
    if (ext?.has(i)) return x === undefined && ext.def?.has(i) ? ext.def.get(i) : x
    x = numberArg(x)
    // A BigInt is a value at a `val` slot whatever its bits; elsewhere the box
    // prefix marks a handle the module minted, passed back.
    const plainBigint = typeof x === 'bigint' && (hostAbi?.val?.has(i) || !isBox(x))
    // An f64 slot is proven numeric: the engine's ToNumber is JS's own (a
    // handle reads as its bits; a BigInt is refused with the remedies).
    if (!(ie && ie.p.has(i))) {
      if (plainBigint) noEvidence(i, name)
      return typeof x === 'bigint' ? i64ToF64(x) : x
    }
    // A typed slot (`t`) takes its kind, converted element by element; a `+`
    // marks one the body writes, copied back after the call; `Array+` a plain
    // array the body may store into, which crosses as itself.
    const typedSlot = ie?.t?.[i]
    // Where the call's copy of an array argument goes back after the call
    // (copyBack below), or null: nothing comes back.
    let back = null
    // One host array at two slots of one kind is one copy, as it is one object in JS.
    const orig = x, key = typedSlot ? typedSlot.replace('+', '') : ''
    const prior = shared && orig != null && typeof orig === 'object' ? shared.get(orig) : undefined
    if (prior?.key === key) {
      // A slot that writes where the first one only read: the copy comes back.
      if (typedSlot?.endsWith('+') && !prior.back) { writeBack.push([hostBack(orig), prior.b]); prior.back = true }
      return prior.b
    }
    const jzBuffer = typeof x === 'bigint' && isBox(x)
    if (typedSlot === 'Array+') {
      // A plain array the body may store into crosses as itself: an array or a
      // typed array takes its elements back; a DataView has none.
      if (!jzBuffer && (Array.isArray(x) || (ArrayBuffer.isView(x) && !(x instanceof DataView)))) back = hostBack(x)
    } else if (typedSlot) {
      const writes = typedSlot.endsWith('+')
      const Ctor = globalThis[key]
      // A jz buffer of the slot's kind is the storage itself; a subarray of one
      // or another kind converts through its view, written back into it.
      if (jzBuffer) {
        if (argKind(x) !== key || (aux(x) & TYPED_ELEM_VIEW_FLAG)) { if (writes) back = { box: x }; x = Ctor.from(mem.read(x)) }
      } else {
        if (writes && x != null && typeof x === 'object') back = hostBack(x)
        x = x instanceof Ctor ? x : Ctor.from(x)
      }
    }
    // A BigInt: unboxed at a `raw` slot, boxed at a `tag` one, else refused
    const w = !plainBigint ? box(x) : hostAbi?.raw?.has(i) ? x : hostAbi?.tag?.has(i) ? mem.BigInt(x) : noEvidence(i, name)
    // a boolean crosses as its atom (boxing would read it as the number 1 or 0)
    if (typeof x === 'boolean') return x ? TRUE_NAN : FALSE_NAN
    // without memory a string lives only in its box
    if (typeof w === 'string') {
      if (!ssoFits(w)) throw new Error('jz: string arg too long or non-ASCII for memoryless module — compile with a string operation to enable heap marshaling')
      return encodeSSO(w)
    }
    const b = bits(w)
    // A host array's nested arrays (a worklet's channel buffers) are copies
    // too: which element copies it made, to copy back those still in place.
    if (back?.to && Array.isArray(orig) && type(b) === PTR.ARRAY) back.cells = cellsOf(b, 0)
    if (back && writeBack) writeBack.push([back, b])
    if (shared && orig != null && typeof orig === 'object') shared.set(orig, { key, b, back: !!back })
    return b
  }
  // The copy-back target of a host array: the array itself, or, for a view of
  // this memory, the region it spans (the call may grow the memory, detaching
  // the view, and the elements stay where they were).
  const hostBack = (x) => ArrayBuffer.isView(x) && x.buffer === mem.buffer
    ? { region: [x.constructor, x.byteOffset, x.length] } : { to: x }
  // After the call, each array argument's copy goes back where it came from,
  // both read after anything the call grew: a typed target takes the elements
  // (converted to its kind) up to its length, a plain array its numbers.
  const setPrefix = (dst, src) => dst.set(src.length > dst.length ? src.subarray(0, dst.length) : src)
  const copyBack = (writeBack) => {
    for (const [back, b] of writeBack) {
      if (back.box !== undefined && type(back.box) === PTR.ARRAY) {
        // A jz array converted for a typed slot takes the numbers into its own cells.
        const src = mem.read(b), { m, off, n } = arrayCells(back.box)
        for (let i = 0; i < n && i < src.length; i++) m.setFloat64(off + i * 8, src[i], true)
        continue
      }
      const dst = back.box !== undefined ? mem.read(back.box)
        : back.region ? new back.region[0](mem.buffer, back.region[1], back.region[2]) : back.to
      if (type(b) === PTR.TYPED) {
        const src = mem.read(b)
        if (ArrayBuffer.isView(dst)) setPrefix(dst, src)
        else for (let i = 0; i < dst.length && i < src.length; i++) dst[i] = src[i]
      } else if (type(b) === PTR.ARRAY) backArray(dst, b, back.cells)
    }
  }
  // A plain host array takes back its numbers at the length the module left it,
  // and the writes into each nested array the copy still holds where it was made
  // (one the module replaced stays in the module, as a changed element does).
  const backArray = (dst, b, cells) => {
    const { m, off, n } = arrayCells(b)
    if (Array.isArray(dst) && dst.length !== n) dst.length = n
    for (let i = 0; i < n && i < dst.length; i++) {
      const e = m.getBigInt64(off + i * 8, true)
      if (e === TOMB_BITS) {
        if (Array.isArray(dst)) delete dst[i]
        else dst[i] = undefined
        continue
      }
      if (e === UNDEF_NAN) { dst[i] = undefined; continue }
      if (!isBox(e)) { dst[i] = i64ToF64(e); continue }
      if (type(e) === 0 && aux(e) === 0 && offset(e) === 0) { dst[i] = NaN; continue }
      const c = cells?.[i], d = dst[i]
      if (!c || c.e !== e || d == null || typeof d !== 'object') continue
      if (type(e) === PTR.TYPED) { if (ArrayBuffer.isView(d)) setPrefix(d, mem.read(e)) }
      else if (Array.isArray(d)) backArray(d, e, c.kids)
    }
  }
  // The element cells of a jz array right after it was made from a host array:
  // the copies of its nested arrays, down a few levels.
  const cellsOf = (b, depth) => {
    const { m, off, n } = arrayCells(b), out = new Array(n)
    for (let i = 0; i < n; i++) {
      const e = m.getBigInt64(off + i * 8, true)
      if (!isBox(e)) continue
      if (type(e) === PTR.TYPED) out[i] = { e, kids: null }
      else if (type(e) === PTR.ARRAY && depth < 4) out[i] = { e, kids: cellsOf(e, depth + 1) }
    }
    return out
  }
  // A jz array's element cells, past any forwarding its growth left.
  const arrayCells = (box) => {
    const m = new DataView(mem.buffer), off = forward(m, offset(box))
    return { m, off, n: m.getInt32(off - 8, true) }
  }

  // A call's heap: `enter` marks where it stood before the arguments were
  // copied in; `leave` rewinds to the mark when the export keeps nothing
  // (`jz:release`) and no call inside it (a host import calling back) kept
  // anything (`mem._kept`, per nesting). An export whose frame runs escapes
  // (`flag`) releases only where none wrote below the mark (the escape flag,
  // saved and cleared around the call, optimize/arena-rewind.js); a call that
  // threw releases nothing. `__base` sets the outermost frame's mark and
  // answers the mark of a frame running around this call, or all ones.
  // JZ_DEBUG_POISON=1: a release overwrites what it frees, as a rewound frame does.
  const POISON = typeof process !== 'undefined' && process.env?.JZ_DEBUG_POISON === '1'
  const NO_MARK = -1 >>> 0
  let depth = 0
  // As the outermost call returns, every sixteenth, the module keeps what its
  // roots reach (`__compact`, module/core/compact.js) once the memory above the
  // floor holds twice what the last walk reached (`__g_cost`) and a page, or,
  // near the end of the address space, an eighth of that. The floor stands above
  // what the host allocated and what it was handed by address (`_pinAt`).
  const COMPACT_MIN = 65536, CAP = 2 ** 32, MARGIN = 64 << 20
  const settle = (returned, held) => {
    if (!compact || mem.scalar) return
    if (held) { mem._pin = Math.max(mem._pin, mem._pinAt); mem._pinAt = 0; mem._pinSet?.(mem._pin) }
    if (!returned || asyncMod || (mem._calls = (mem._calls + 1) & 15) !== 0) return
    const floor = Math.max(mem._base(), mem._pin), at = mem._top()
    const since = at - floor, need = 2 * mem._live + COMPACT_MIN
    if (since <= need && !(CAP - at < at / 8 + MARGIN + need - since && since > mem._live / 8 + COMPACT_MIN)) return
    // views handed out before the program's own allocation grew the memory are
    // detached: the walk's scratch may grow it again
    if (viewed && viewed.value && mem._viewBuf !== mem.buffer) viewed.value = 0
    const to = compact(floor | 0) >>> 0
    mem._live = Math.max(to - floor, cost ? cost.value >>> 0 : 0)
  }
  // the outermost call over: what it handed the host settles the floor
  const done = (returned, handed) => { mem._busy = false; mem._above = Infinity; mem._held = false; settle(returned, handed) }
  const running = () => depth === 0 && (depth = 1) === 1 && (mem._busy = true) && ((mem._above = 0), (mem._held = false), true)
  const ran = (threw) => { depth = 0; if (threw && setBase) setBase(-1); done(!threw, mem._held) }
  const enter = (flag) => {
    // no frame of the module runs around the first call: a mark a call that threw left behind goes
    if (setBase && depth === 0) setBase(-1)
    if (depth === 0) { mem._above = 0; mem._held = false }   // any view or closure decoded during the call counts
    depth++
    mem._busy = true
    const mark = { top: mem._top(), kept: mem._kept, esc: flag && esc ? esc.value >>> 0 : 0, base: null }
    mem._kept = false
    if (flag && esc) esc.value = -1
    // the outermost frame's mark is this call's where none runs around it; an older one stays
    if (flag && setBase) {
      mark.base = setBase(mark.top | 0) >>> 0
      if (mark.base < mark.top) setBase(mark.base | 0)
    }
    return mark
  }
  // The result as the host takes it: a copy, or a value naming the module's
  // memory (a view, a closure, a promise read as it settles), which above the
  // call's mark holds what the call allocated (`mark.held`).
  const settled = (mark, ret) => {
    const above = mem._above, held = mem._held
    mem._above = mark.top; mem._held = false
    try {
      const out = finishRet(ret, exportRet)
      mark.held = mem._held || (asyncMod && out instanceof Promise)
      return out
    } finally { mem._above = above; mem._held = held }
  }
  const leave = (mark, release, flag, returned) => {
    const escaped = flag && (!esc || (esc.value >>> 0) < mark.top || !returned), held = mark.held === true
    if (release && !mem._kept && !escaped && !held) {
      if (POISON && mem._top() > mark.top) new Uint8Array(mem.buffer, mark.top, mem._top() - mark.top).fill(255)
      mem._setTop(mark.top)
    }
    // a call that ran an escape keeps what the escape reaches: the module walks from what it wrote into
    else if (release && !mem._kept && !held && returned && survive && mark.base === NO_MARK) mem._setTop(survive(mark.top) >>> 0)
    mem._kept = mark.kept || !release || escaped || held || mem._kept
    if (flag && esc && mark.esc < (esc.value >>> 0)) esc.value = mark.esc | 0
    if (setBase && mark.base !== null) setBase(mark.base | 0)
    // a call that threw left the frames of the module without their epilogues: no mark stays past the outermost
    if (--depth === 0 && !returned && setBase) setBase(-1)
    if (depth === 0) done(returned, held || mem._held)
  }

  // A module without memory: values cross by their bits, no heap to release
  if (!mem || mem.scalar) {
    for (const [name, fn] of Object.entries(realInst.exports)) {
      if (typeof fn !== 'function') { exports[name] = fn; continue }
      const ext = extExp.get(name)
      const ie = i64Exp.get(name)
      const hostAbi = hostAbiExp.get(name)
      const len = fn.length, arg = i64Arg(ie, ext, mem.wrapVal, hostAbi, name)
      // A proven raw-BigInt result stays raw; a tagged one (`r`) is decoded
      const result = (ret) => typeof ret === 'bigint' && !(ie && ie.r) ? ret : typeof ret === 'number' ? numberRet(ret) : mem.read(ret, fnOf)
      const general = (...args) => {
        const a = new Array(len)
        for (let i = 0; i < len; i++) a[i] = arg(args[i], i)
        if (lastErrBitsWritable) lastErrBits.value = 0n   // a fresh call starts with no stale mark
        try { return result(fn(...a)) } catch (e) { decodeThrown(e) }
      }
      exports[name] = plainLanes(ie, ext, hostAbi) && !asyncMod ? crossing(fn, general, result, always, idle, hostAbi?.skip) : general
    }
    return liveValues(exports)
  }
  const memWrapVal = mem.wrapVal.bind(mem)
  // A rest element: a handle as it is, a BigInt boxed where the export's
  // `rest` evidence allows, else refused.
  const restElemArg = (hostAbi, name) => (x) => {
    if (typeof x !== 'bigint' || isBox(x)) return x
    if (hostAbi?.rest) return mem.BigInt(x)
    throw new TypeError(`jz: BigInt argument in the rest arguments of ${name}() has no BigInt evidence in the compiled program — give the rest parameter a provable BigInt path (it then takes the tagged ingress), or pass a decimal string`)
  }
  for (const [name, fn] of Object.entries(realInst.exports)) {
    if (fn === setBase || fn === survive || name === '__root_reset') continue   // the host's own handles on the module, no exports of the program
    if (typeof fn !== 'function') { exports[name] = fn; continue }
    const ext = extExp.get(name), ie = i64Exp.get(name), hostAbi = hostAbiExp.get(name)
    const release = releases.has(name), flag = flagged.has(name), numeric = numberResult.has(name)
    const rest = restFuncs.has(name), fixed = rest ? restFuncs.get(name) : fn.length
    // The arguments by their lanes: a missing fixed one undefined, the rest an array
    const lanesOf = (args, writeBack) => {
      const arg = i64Arg(ie, ext, memWrapVal, hostAbi, name, writeBack)
      if (!rest) { const a = new Array(fixed); for (let i = 0; i < fixed; i++) a[i] = arg(args[i], i); return a }
      const a = args.slice(0, fixed).map(arg)
      while (a.length < fixed) a.push(ie && ie.p.has(a.length) ? UNDEF_NAN : undefined)
      const restArr = hostAbi?.skip.has(fixed) ? 0n : mem.Array(args.slice(fixed).map(restElemArg(hostAbi, name)))
      a.push(ie && ie.p.has(fixed) ? restArr : i64ToF64(restArr))
      return a
    }
    const general = (...args) => {
      const writeBack = [], mark = enter(flag)
      let returned = false, scalar = !numeric
      try {
        const a = lanesOf(args, writeBack)
        if (lastErrBitsWritable) lastErrBits.value = 0n
        const ret = fn.apply(null, a)
        if (numeric) { const n = typeof ret === 'bigint' ? i64ToF64(ret) : ret; scalar = typeof n === 'number' && n === n }
        returned = true
        if (writeBack.length) copyBack(writeBack)
        const host = hostOf(writeBack, ret)
        if (host) return host
        if (typeof ret === 'bigint' && !(ie && ie.r)) return ret
        return settled(mark, ret)
      } catch (error) {
        decodeThrown(error)
      } finally { leave(mark, release && scalar, flag, returned) }
    }
    // Numbers only, and nothing for the host to release (the frame releases or
    // keeps by itself): the call crosses as it is, counted as one that runs.
    exports[name] = !rest && plainLanes(ie, ext, hostAbi) && !asyncMod && !(release && hostReleased.has(name))
      ? crossing(fn, general, (ret) => typeof ret === 'bigint' && !(ie && ie.r) ? ret : exportRet(ret), running, ran, hostAbi?.skip) : general
  }
  // An export whose typed slots take other kinds in variants (`v`, hidden
  // exports of the same body) calls the one the arguments fit.
  for (const [name, ie] of i64Exp) {
    if (!ie.v || !exports[name]) continue
    const cands = [name, ...ie.v].filter(n => exports[n])
    exports[name] = kindDispatch(name, cands.map(n => [exports[n], slotsOf(i64Exp.get(n))]))
    for (const n of ie.v) delete exports[n]
  }
  if (classes) hostClasses(classes, exports, fnOf, mem)
  return liveValues(exports)
}

// A class the module exports (`jz:class`, compile/emit/class-dispatch.js) is a
// constructor of handles on the module's instances (`mem.handle`): called with
// `new`, it runs the class's factory. A class deriving from one it exports is a
// prototype for the instances of it the host is handed. A member a class
// defines anew is an export of the module that takes the instance first, put
// on the prototype, one it inherits its base's; a static, an export put on the
// constructor. The module dispatches a method on the instance, so one reached
// through a base's prototype on an instance whose class overrides it
// (`Base.prototype.m.call(derived)`) is a TypeError. The member exports leave
// the namespace.
const INSPECT = Symbol.for('nodejs.util.inspect.custom'), MARK = '\uE003'
const hostClasses = (table, exports, fnOf, mem) => {
  const protos = [], ctors = []
  const take = (name) => { const f = exports[name]; delete exports[name]; return f }
  for (const c of table) {
    const factory = c.name == null ? null : exports[c.name]
    const C = typeof factory === 'function' ? { [c.cls]: function (...args) {
      if (new.target === undefined) throw new TypeError(`Class constructor ${c.cls} cannot be invoked without 'new'`)
      return factory(...args)
    } }[c.cls] : null
    const proto = C ? C.prototype : {}
    const self = (o, key) => { if (!mem._handles.has(o)) throw new TypeError(`${c.cls}.prototype.${key} called on an object that is not an instance of ${c.cls}`); return o }
    for (const [key, kind] of c.members) {
      const f = take(MARK + c.tag + MARK + kind + key), had = Object.getOwnPropertyDescriptor(proto, key)
      if (kind === 'm') {
        const method = { [key](...args) {
          if (self(this, key)[key] !== method) throw new TypeError(`${c.cls}.prototype.${key} called on an instance whose class overrides it`)
          return f(this, ...args)
        } }[key]
        Object.defineProperty(proto, key, { value: method, writable: true, configurable: true })
      } else Object.defineProperty(proto, key, { configurable: true,
        get: kind === 'g' ? function () { return f(self(this, key)) } : had?.get,
        set: kind === 's' ? function (v) { f(self(this, key), v) } : had?.set })
    }
    // node prints an instance's fields as they stand, not as accessors: a
    // snapshot of the class (its prototype below one that hides this printer)
    const snapshot = Object.create(proto, { [INSPECT]: { value: undefined } })
    Object.defineProperty(proto, INSPECT, { configurable: true, value(depth, options, inspect) {
      const o = Object.create(snapshot)
      for (const k of Object.keys(this)) o[k] = this[k]
      return inspect ? inspect(o, options) : o
    } })
    if (C) for (const [key, kind] of c.statics) {
      const f = take(MARK + c.tag + MARK + kind + key)
      if (key === 'prototype') continue
      if (kind === 'M') Object.defineProperty(C, key, { value: { [key](...args) { return f(...args) } }[key], writable: true, configurable: true })
      else Object.defineProperty(C, key, { get: () => f(), enumerable: true, configurable: true })
    }
    if (c.sid != null) (fnOf.classes ??= new Map()).set(c.sid, proto)
    if (C) exports[c.name] = C
    protos.push(proto); ctors.push(C)
  }
  table.forEach((c, i) => {
    if (c.base == null) return
    Object.setPrototypeOf(protos[i], protos[c.base])
    if (ctors[i] && ctors[c.base]) Object.setPrototypeOf(ctors[i], ctors[c.base])
  })
}

// ── Typed slots: which of an export's variants an argument list fits ────────
// A typed slot's kind, and whether the body stores into it and reads back
// (`k`): there only an argument of the slot's own kind is exact.
// The slots a variant is chosen by: the typed ones. `Array+` marks a slot that may
// be a plain array the body stores into; it takes whatever arrives, as itself.
const slotsOf = (ie) => Object.entries(ie?.t ?? {}).filter(([, t]) => t !== 'Array+').map(([i, t]) => [+i, t.replace('+', ''), ie.k.has(+i)])
// The element kind an argument brings: a typed array's own (a host one, or a
// jz buffer by its box), 'Array' for any other object (Array.from reads it as
// an array-like), null for anything else.
const argKind = (x) => {
  if (typeof x === 'bigint' && isBox(x)) {
    const t = type(x), a = aux(x)
    if (t === PTR.ARRAY) return 'Array'
    return t !== PTR.TYPED || (a & DATA_VIEW_FLAG) ? null : kindOfAux(a).name
  }
  if (x == null || typeof x !== 'object') return null
  if (ArrayBuffer.isView(x)) return x instanceof DataView ? null : x.constructor.name
  return 'Array'
}
// How an argument of `kind` fits a slot of `ctor`: 0 as itself, 1 through a
// conversion to Float64Array that is exact (numbers, and every numeric
// element kind but where the body reads back what it stores: there an element
// rounds by its kind), -1 not at all.
const EXACT_IN_F64 = new Set(['Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array'])
const fitOf = (kind, ctor, inPlace) => kind === ctor ? 0
  : ctor !== 'Float64Array' || !EXACT_IN_F64.has(kind) ? -1
  : inPlace && kind !== 'Array' ? -1 : 1
const kindDispatch = (name, cands) => (...args) => {
  let best = null, cost = Infinity
  for (const [fn, slots] of cands) {
    let c = 0
    for (const [i, ctor, inPlace] of slots) {
      const f = fitOf(argKind(args[i]), ctor, inPlace)
      if (f < 0) { c = Infinity; break }
      c += f
    }
    if (c < cost) { best = fn; cost = c; if (!c) break }
  }
  if (best) return best(...args)
  // Name the argument no variant takes, by the origin's slots.
  for (const [i, , inPlace] of cands[0][1]) {
    const kind = argKind(args[i])
    if (kind == null || !(EXACT_IN_F64.has(kind) || kind === 'Float64Array'))
      throw new TypeError(`jz: argument ${i} of ${name}() must be an array of numbers (got ${kind ?? (args[i] === null ? 'null' : typeof args[i])})`)
    if (inPlace && kind !== 'Float64Array' && kind !== 'Float32Array' && kind !== 'Array')
      throw new TypeError(`jz: ${name}() stores into argument ${i} and reads it back, so it takes a Float64Array, a Float32Array or an Array (got ${kind})`)
  }
  throw new TypeError(`jz: ${name}() stores into arguments and reads them back; pass them as one kind, all Float32Array or all Float64Array or Array`)
}

// Host-call return marshalling shared by opts.imports wrappers, __ext_call and
// the auto-wired web globals: a thenable becomes a jz promise (awaitable in
// the module — settled via the async runtime's exports, then drain + sweep);
// everything else boxes through wrapVal. `bigintEvidence` is reserved for a
// host operation whose receiver proves a BigInt result domain.
const hostRet = (state, ret, bigintEvidence = false) => {
  const wrap = v => state.mem
    ? (bigintEvidence && typeof v === 'bigint' ? state.mem.BigInt(v) : state.mem.wrapVal(v))
    : coerce(v)
  if (ret != null && typeof ret.then === 'function' && state.pmake) {
    const praw = state.pmake()
    const box = (v) => bits(wrap(v))
    ret.then(
      (v) => { state.pfinish(praw, 1, box(v)); state.afterTick?.() },
      (e) => { state.pfinish(praw, 2, box(e instanceof Error ? e.message : e)); state.afterTick?.() })
    return typeof praw === 'bigint' ? praw : bits(praw)
  }
  return bits(wrap(ret))
}

// Callable web globals auto-wired from globalThis when the module imports them
// (module/web.js lowers bare `fetch(...)` etc. to env imports under host:'js').
const WEB_GLOBALS = new Set(['fetch'])

// Exception values and captured call references cross by identity. Unlike a
// generic host return, these edges also admit an arbitrary BigInt value.
const hostValue = (state, value) => typeof value === 'number' ? (value === value ? value : NaN)
  : typeof value === 'bigint' ? state.mem.BigInt(value)
  : value !== null && (typeof value === 'object' || typeof value === 'function') ? state.mem.External(value)
  : state.mem.wrapVal(value)

// Every synchronous host import shares the source exception boundary. A callback
// reentering this instance may already have decoded a source throw for JS: during
// this host call only, retain its original bits so a rethrow preserves identity.
const catchingImport = (state, fn) => function (...args) {
  const previous = state.caught
  state.caught = null
  state.inHost = (state.inHost || 0) + 1
  try { return Reflect.apply(fn, this, args) }
  catch (value) {
    // A raw export can reenter this instance without the JS decoding wrapper.
    // Its own exception already carries the source value in the right tag.
    if (value instanceof WebAssembly.Exception && state.errTag && WebAssembly.Exception.prototype.is.call(value, state.errTag)) throw value
    const prior = value != null && (typeof value === 'object' || typeof value === 'function')
      ? state.caught?.get(value) : undefined
    const boxed = prior !== undefined ? prior : hostValue(state, value)
    state.raise(bits(boxed))
  } finally { state.inHost--; state.caught = previous }
}

// The module spells a well-known symbol key `@@name` (`obj[Symbol.iterator]`
// reads '@@iterator'): a host object's key is the host's symbol.
const WELL_KNOWN = { '@@iterator': Symbol.iterator, '@@asyncIterator': Symbol.asyncIterator,
  '@@toPrimitive': Symbol.toPrimitive, '@@hasInstance': Symbol.hasInstance, '@@toStringTag': Symbol.toStringTag }
const hostKey = (prop) => typeof prop === 'string' && prop.startsWith('@@') && WELL_KNOWN[prop] || prop

const prepareInterop = (opts) => {
  // the host references of a memory are one table for every module sharing
  // it: an index one module hands out resolves through another's import
  const state = { extMap: opts.memory instanceof WebAssembly.Memory && opts.memory._extMap ? opts.memory._extMap : [null], mem: null }
  // The host's side of the module's dynamic operations (module/collection.js,
  // module/web.js), values crossing as i64 bits. A receiver that is no host
  // object (extMap[0] is null: an unsupported builtin method, an untyped
  // receiver) is named, not left to fail as "Cannot read properties of null".
  const extRecv = (objBig, prop, what) => {
    const obj = state.extMap[offset(objBig)]
    if (obj == null) throw new Error(`'${String(prop)}' — jz dispatched this ${what} to the host, but the receiver is not a host object (an unsupported builtin method, or a receiver type jz couldn't resolve)`)
    return obj
  }
  // a value the module hands the host, closures read as functions; a property key
  const read = (v) => state.mem.read(v, state.fnOf), keyOf = (propBig) => hostKey(state.mem.read(propBig))
  // a BigInt a host BigInt64Array or BigUint64Array holds is a value (boxed); any other has no evidence
  const bigTyped = (obj, value) => typeof value === 'bigint' && (obj instanceof BigInt64Array || obj instanceof BigUint64Array)
  // A property Get, the getter run once. `raw` (a method reference) and a
  // function by `__ext_get` cross by identity; `legacy` (`__ext_prop`, of
  // older binaries) binds a method to its receiver.
  const readProperty = (objBig, propBig, legacy = false, raw = false) => {
    const prop = keyOf(propBig), obj = extRecv(objBig, prop, 'property read'), value = obj[prop]
    // (a method reference the receiver lacks: the invoke that follows names it)
    if (raw && typeof value !== 'function') state.methodMiss = { obj, prop }
    if (raw || !legacy && typeof value === 'function') return bits(hostValue(state, value))
    return bits(bigTyped(obj, value) ? state.mem.BigInt(value) : state.mem.wrapVal(legacy && typeof value === 'function' ? value.bind(obj) : value))
  }
  // A typed array of the module's memory handed to a host call arrives as a
  // copy the host may keep past the call (a view detaches as the memory grows);
  // what the host writes into it during the call is copied back.
  const ownArgs = (args) => {
    let back = null
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (!ArrayBuffer.isView(a) || a.buffer !== state.mem.buffer) continue
      const copy = a instanceof DataView ? new DataView(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)) : a.slice()
      ;(back ??= []).push(a.byteOffset, a.byteLength, copy)
      args[i] = copy
    }
    return back
  }
  const copyBack = (back) => {
    for (let i = 0; i < back.length; i += 3) new Uint8Array(state.mem.buffer, back[i], back[i + 1]).set(new Uint8Array(back[i + 2].buffer, back[i + 2].byteOffset, back[i + 1]))
  }
  // `as`: a call the module types as its builtin's result (`o.charCodeAt(i)` a
  // Number) takes the host method's value as that type: 1 a Number, 2 a
  // Boolean, 3 a string (kind-traits.js hostResultAs); 0 or absent, as it is.
  const invoke = (fn, obj, args, as) => {
    if (typeof fn !== 'function') {
      const miss = state.methodMiss
      throw new TypeError(miss && miss.obj === obj ? `${String(miss.prop)} is not a function on the host receiver` : 'Host value is not callable')
    }
    const back = ownArgs(args), value = Reflect.apply(fn, obj, args)
    if (back) copyBack(back)
    return hostRet(state, as === 1 ? Number(value) : as === 2 ? !!value : as === 3 ? String(value) : value, !as && bigTyped(obj, value))
  }
  const invokeAs = (fnBig, recvBig, argsBig, as) => invoke(read(fnBig), read(recvBig), read(argsBig), as)
  Object.assign(opts._interp ||= {}, {
    __ext_prop: (objBig, propBig) => readProperty(objBig, propBig, true),
    __ext_get: (objBig, propBig) => readProperty(objBig, propBig),
    // a raw Get, for reads, copies and method references: a function unbound
    __ext_method: (objBig, propBig) => readProperty(objBig, propBig, false, true),
    // for-of over a host iterable (`__iter_arr`) reads a length, then the
    // element at its counter, each step: the view pulls the next value at a
    // length read where none waits, the element read takes it. A spread
    // (`all`) takes every value at once, as an array of the module.
    __ext_iter: (vBig, all) => {
      const v = extRecv(vBig, Symbol.iterator, 'for-of')
      if (typeof v[Symbol.iterator] !== 'function') throw new TypeError('value is not iterable')
      if (all) return bits(state.mem.wrapVal(Array.from(v)))
      const it = v[Symbol.iterator]()
      let count = 0, waiting = false, value, done = false
      return bits(hostValue(state, new Proxy({}, { get: (_, key) => {
        if (key === 'length') {
          if (!waiting && !done) { const r = it.next(); if (r.done) done = true; else { value = r.value; waiting = true } }
          return count + (waiting ? 1 : 0)
        }
        if (waiting && key === String(count)) { waiting = false; count++; return value }
        return undefined
      } })))
    },
    __ext_has_iterator: (objBig) => extRecv(objBig, Symbol.iterator, 'iterator-method test')[Symbol.iterator] == null ? 0 : 1,
    __ext_is_error: (objBig, kind) => state.extMap[offset(objBig)] instanceof globalThis[ERR_CLASS_NAMES[kind]] ? 1 : 0,
    // JSON.stringify's walker met a host object: the host's text, each line
    // indented to the walker's depth, or undefined where the host writes none.
    __ext_json: (objBig, gapPtr, gapLen, depth) => {
      const obj = extRecv(objBig, 'toJSON', 'serialization')
      const gap = String.fromCharCode(...new Uint16Array(state.mem.buffer, gapPtr, gapLen))
      const text = JSON.stringify(obj, null, gap)
      return text === undefined ? bits(UNDEF_NAN) : bits(state.mem.wrapVal(gap ? text.replace(/\n/g, '\n' + gap.repeat(depth)) : text))
    },
    __ext_json_omits: (objBig) => { const t = typeof state.extMap[offset(objBig)]; return t === 'function' || t === 'symbol' ? 1 : 0 },
    __ext_enum: (objBig, mode) => {
      const obj = extRecv(objBig, 'keys', 'enumeration')
      return bits(state.mem.wrapVal(mode === 3 ? Reflect.ownKeys(obj) : mode === 0 ? Object.keys(obj) : mode === 1 ? Object.values(obj) : Object.entries(obj)))
    },
    __ext_copy_has: (objBig, propBig) => { const prop = keyOf(propBig); return Object.getOwnPropertyDescriptor(extRecv(objBig, prop, 'property copy'), prop)?.enumerable ? 1 : 0 },
    __ext_has: (objBig, propBig) => { const prop = keyOf(propBig); return prop in extRecv(objBig, prop, 'membership test') ? 1 : 0 },
    __ext_delete: (objBig, propBig) => { const prop = keyOf(propBig); return Reflect.deleteProperty(extRecv(objBig, prop, 'property deletion'), prop) ? 1 : 0 },
    // A typed array the module stores on a host object is a live view of its
    // storage, which a read back into the module is again (`_views`), so state
    // kept on a host object carries from call to call. The store keeps a
    // pointer into the heap: the call around it releases nothing (`_kept`).
    __ext_set: (objBig, propBig, valBig) => {
      const v = read(valBig)
      if (ArrayBuffer.isView(v)) { state.mem._views?.set(v, valBig); state.mem._kept = true }
      const prop = keyOf(propBig)
      extRecv(objBig, prop, 'property write')[prop] = v
      return 1
    },
    __ext_invoke: invokeAs,
    __ext_invoke_as: invokeAs,
    // up to four arguments inline, their count first: the module builds no array
    __ext_invoke_inline: (fnBig, recvBig, n, as, ...inline) => invoke(read(fnBig), read(recvBig), inline.slice(0, n).map(read), as),
    // `new C(...args)` of a host constructor (module/web.js `__host_new`)
    __ext_construct: (fnBig, argsBig) => {
      const fn = read(fnBig), args = read(argsBig)
      const back = ownArgs(args), value = Reflect.construct(fn, args)
      if (back) copyBack(back)
      return hostRet(state, value)
    },
    // `v instanceof C` of a host class: a value of the module is no instance of
    // it, though a C the host cannot test still throws (module/web.js).
    __ext_instanceof: (vBig, ctorBig) => {
      const C = read(ctorBig)
      return (type(vBig) === PTR.EXTERNAL ? state.extMap[offset(vBig)] : undefined) instanceof C ? 1 : 0
    },
    __ext_callable: (vBig) => typeof state.extMap[offset(vBig)] === 'function' ? 1 : 0,
    // older binaries pass receiver, key and arguments
    __ext_call: (objBig, propBig, argsBig) => {
      const prop = keyOf(propBig), obj = extRecv(objBig, prop, 'method call'), args = read(argsBig)
      return invoke(prop === undefined ? obj : obj[prop], prop === undefined ? undefined : obj, args)
    },
  })
  return state
}

// The env functions a JS-host module imports (console, clocks, entropy,
// timers, web globals), where the caller's `imports.env` does not give them.
const installDefaultEnvImports = (mod, imports, state) => {
  const envFns = new Set(WebAssembly.Module.imports(mod).filter(i => i.module === 'env' && i.kind === 'function').map(i => i.name))
  if (!envFns.size) return
  if (!imports.env) imports.env = {}
  const provide = (name, fn) => { if (envFns.has(name) && !imports.env[name]) imports.env[name] = fn }
  // web globals a bare call lowered to an import (module/web.js), from globalThis
  for (const name of envFns) {
    if (imports.env[name] || !WEB_GLOBALS.has(name)) continue
    const host = globalThis[name]
    if (typeof host !== 'function') continue
    imports.env[name] = (...args) => hostRet(state, host(...args.map(a => readHost(state, a))))
  }
  if (envFns.has('print') && !imports.env.print) {
    // A line per console method (module/console.js codes: log 1, error 2, warn
    // 3, info 4, debug 5): the values of one call, each formatted by the host's
    // console as it formats its own arguments; a part printed with no separator
    // after it (a template's) joins the next as a string.
    const METHODS = ['log', 'log', 'error', 'warn', 'info', 'debug']
    const line = METHODS.map(() => []), joined = METHODS.map(() => false)
    const pending = []
    const flush = (fd) => {
      const name = METHODS[fd] ?? 'log'
      ;(console[name] ?? console.log)(...line[fd])
      line[fd] = []
    }
    // printed before the memory is wired (the start function): held until then
    const write = (valBig, fd, sep) => {
      const v = readHost(state, valBig), args = line[fd]
      if (joined[fd]) args[args.length - 1] = String(args[args.length - 1]) + String(v)
      else args.push(v)
      joined[fd] = sep === 0
      if (sep === 10) flush(fd)
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
  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now()
  provide('now', (clock) => clock === 1 ? now() : Date.now())
  // entropy, from crypto where the host has it: a seed for Math.random, the
  // bytes of crypto.getRandomValues (a view made per call: the memory may grow)
  const entropy = (view) => {
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(view)
    else for (let i = 0; i < view.length; i++) view[i] = Math.random() * 2 ** (8 * view.BYTES_PER_ELEMENT)
    return view
  }
  provide('rngSeed', () => entropy(new Uint32Array(1))[0] | 0)
  provide('random', (off, len) => { entropy(new Uint8Array(state.mem.buffer, off, len)) })
  provide('hardwareConcurrency', () => globalThis.navigator?.hardwareConcurrency ?? 1)
  // the argument read without a closure reader: a string
  const text = (valBig) => state.mem ? state.mem.read(valBig) : decode(valBig)
  provide('parseFloat', (valBig) => parseFloat(text(valBig)))
  provide('parseInt', (valBig, radix) => parseInt(text(valBig), radix || undefined))
  // Each scheduled callback by its id, as the thunk that cancels it. A
  // callback runs as any closure the host holds (state.fnOf, read at the first
  // fire: a timer the module's init arms runs before wrap sets it), then the
  // microtasks drain and promises parked on async exports settle (afterTick).
  const schedule = () => {
    const cancel = new Map()
    let next = 1
    return { cancel, id: () => next++, clear: (id) => { cancel.get(id)?.(); cancel.delete(id); return 0 } }
  }
  const timers = schedule(), frames = schedule()
  provide('setTimeout', (cbBig, delayMs, repeat) => {
    const id = timers.id()
    let cb
    const fire = () => { (cb ??= state.fnOf?.(cbBig))?.(); state.afterTick?.() }
    if (repeat) { const h = setInterval(fire, delayMs); timers.cancel.set(id, () => clearInterval(h)) }
    else { const h = setTimeout(() => { timers.cancel.delete(id); fire() }, delayMs); timers.cancel.set(id, () => clearTimeout(h)) }
    return id
  })
  provide('clearTimeout', timers.clear)
  // the host's frames, or a 16 ms timer where it has none (Node): a timestamp either way
  provide('requestAnimationFrame', (cbBig) => {
    const id = frames.id(), raf = globalThis.requestAnimationFrame
    const fire = (t) => { frames.cancel.delete(id); state.fnOf?.(cbBig)(t); state.afterTick?.() }
    if (typeof raf === 'function') { const h = raf(fire); frames.cancel.set(id, () => globalThis.cancelAnimationFrame?.(h)) }
    else { const h = setTimeout(() => fire(now()), 16); frames.cancel.set(id, () => clearTimeout(h)) }
    return id
  })
  provide('cancelAnimationFrame', frames.clear)
}

// The `wasm:js-string` builtins a module imports, as host functions. (A probe
// for the engine's own builtins never succeeded: its module was malformed.)
const JSS_POLYFILL = {
  length:     (s) => s.length,
  charCodeAt: (s, i) => s.charCodeAt(i),
}

const buildImports = (mod, opts, state) => {
  const moduleImports = WebAssembly.Module.imports(mod)
  const needsWasi = moduleImports.some(i => i.module === 'wasi_snapshot_preview1')
  const imports = needsWasi ? wasi(opts) : {}
  if (opts._interp) imports.env = { ...imports.env, ...opts._interp }
  for (const imp of moduleImports)
    if (imp.module === 'wasm:js-string' && JSS_POLYFILL[imp.name]) (imports['wasm:js-string'] ??= {})[imp.name] = JSS_POLYFILL[imp.name]

  // The caller's host functions: arguments read as JS values, the result marshalled back
  if (opts.imports) for (const [modName, fns] of Object.entries(opts.imports)) {
    if (!imports[modName]) imports[modName] = {}
    for (const name of Object.getOwnPropertyNames(fns)) {
      const spec = fns[name]
      const fn = typeof spec === 'function' ? spec : (spec && typeof spec === 'object' ? spec.fn : null)
      if (typeof fn === 'function') imports[modName][name] = (...args) => hostRet(state, fn.call(fns, ...args.map(a => readHost(state, a))))
    }
  }

  installDefaultEnvImports(mod, imports, state)
  // A memory to share, enhanced; a module whose schemas would bind at other ids
  // is refused before its start function writes into it. (A page count is the
  // compiler's, not an import.)
  if (opts.memory instanceof WebAssembly.Memory) {
    if (!_enhanced.has(opts.memory)) opts.memory = memory(opts.memory)
    else mergeTables(opts.memory, moduleTables(mod))
    if (!imports.env) imports.env = {}
    imports.env.memory = opts.memory
  }
  // Host globals the module imports, boxed in i64 globals. One the program names
  // without declaring it (module/web.js): the host's value, or the absent
  // marker whose read throws a ReferenceError.
  for (const imp of moduleImports) {
    if (imp.kind === 'global' && imp.module === 'global') {
      if (!imports.global) imports.global = {}
      if (imports.global[imp.name]) continue
      let bits
      if (!(imp.name in globalThis)) bits = BigInt.asIntN(64, BigInt(TOMB_NAN))
      else {
        const host = globalThis[imp.name]
        bits = host === undefined ? UNDEF_NAN : typeof host === 'number' ? f64ToI64(host) : external(state.extMap, host)
      }
      imports.global[imp.name] = new WebAssembly.Global({ value: 'i64', mutable: false }, bits)
      continue
    }
    if (imp.kind === 'global' && imp.module === 'env') {
      const host = globalThis[imp.name]
      if (!imports.env) imports.env = {}
      // one this host lacks (`self` in Node) is undefined: a library tests for them
      imports.env[imp.name] = new WebAssembly.Global({ value: 'i64', mutable: false }, host === undefined ? UNDEF_NAN : external(state.extMap, host))
    }
  }
  // every host function throws into the module as a source throw does
  if (WebAssembly.Module.exports(mod).some(e => e.name === '__jz_throw_host')) {
    const wrapped = new Map()
    for (const imp of moduleImports) if (imp.kind === 'function') {
      const ns = imports[imp.module], fn = ns?.[imp.name]
      if (typeof fn !== 'function') continue
      let names = wrapped.get(ns)
      if (!names) wrapped.set(ns, names = new Set())
      if (names.has(imp.name)) continue
      names.add(imp.name)
      ns[imp.name] = catchingImport(state, fn)
    }
  }
  return { imports, needsWasi }
}

const finishInstantiation = (mod, inst, imports, needsWasi, opts, state) => {
  if (needsWasi) imports._setMemory(inst.exports.memory)
  attachTimers(inst)
  // A module whose init reaches the host (a WASI one, one reading host values)
  // exports it as `_initialize` (a start section would run before the memory
  // is readable): called once the exports are wrapped.
  const rawMemory = opts.memory instanceof WebAssembly.Memory ? opts.memory : inst.exports.memory
  const src = { module: mod, instance: inst, exports: { ...inst.exports, memory: rawMemory }, extMap: state.extMap }
  const enhanced = memory(src)
  state.mem = enhanced
  state.raise = inst.exports.__jz_throw_host
  state.errTag = inst.exports.__jz_err
  const exports = wrap(src, state)   // before init: an initializer may call a host function that calls back
  state.flushPrint?.()
  if (inst.exports._initialize) {
    exports._initialize()
    enhanced._markBase?.()
  }
  // A memoryless module's reader stays internal: the result's `.memory` is null.
  return { exports, memory: enhanced?.scalar ? null : enhanced, instance: inst, module: mod }
}

export const toModule = (wasm) => wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm)

/**
 * Instantiate prebuilt jz wasm: WASI and host imports linked, exports wrapped.
 * @param {Uint8Array|ArrayBuffer|WebAssembly.Module} wasm
 * @param {{ imports?, memory?, write?, read? }} [opts]
 * @returns {{ exports, memory, instance, module }}
 */
export const instantiate = (wasm, opts = {}) => {
  const state = prepareInterop(opts)
  const mod = toModule(wasm)
  const { imports, needsWasi } = buildImports(mod, opts, state)
  const hasImports = Object.keys(imports).some(k => k !== '_setMemory')
  const inst = new WebAssembly.Instance(mod, hasImports ? imports : undefined)
  return finishInstantiation(mod, inst, imports, needsWasi, opts, state)
}
